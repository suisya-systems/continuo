/**
 * The routing ledger -- the item 10 rehearsal's own durable record.
 *
 * .. warning::
 *
 *    **This is a rehearsal artifact (D-0022).** {@link REHEARSAL_MARKING} is in
 *    `routing_ledger.sql` itself, and {@link loadLedgerSql} refuses to apply a
 *    DDL that has lost it. Nothing this module writes is evidence obtained
 *    against the live counterparty, and `Q-0005` remains open: no numeric
 *    go/no-go criterion is stated or used here.
 *
 * The ledger is a **separate SQLite file** on purpose -- separate from the S5
 * control-plane database and separate from the synthetic counterparty's store.
 * It is neither system's run state; it is the record of which system *owns*
 * each run, held by the layer that sits above both. The discipline is S5's,
 * inherited deliberately:
 *
 * - **Corrupt state is refused, never recovered as empty (R3).**
 *   {@link openRoutingLedger} never creates, never migrates and never repairs,
 *   and verification only *reads*, so a refused file is left byte-identical to
 *   how it was found.
 * - **Creation is explicit and separate from opening.** No code path that
 *   merely wanted to read the ledger can end up having made one.
 * - **Another revision is refused, not migrated (D-0026).**
 *
 * Two things about this opener are specific to the canary and are the reason it
 * is its own opener rather than the control plane's:
 *
 * - **It carries its own {@link LEDGER_APPLICATION_ID}**, so a ledger handed to
 *   the S5 opener -- or an S5 database handed to this one -- is refused as
 *   "some other database" rather than reported as one with missing tables.
 * - **It never sets `journal_mode`.** The ledger stays on SQLite's rollback
 *   journal and is never put into WAL: WAL is a header write and it leaves
 *   `-wal`/`-shm` sidecars, either of which would falsify "the refused open
 *   left the file exactly as it found it". `src/sqlite/open.ts`'s
 *   `openDatabase` sets WAL, so this module does not use it.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import Database, { type Database as SqliteDatabase } from "better-sqlite3";

import { isSqliteError } from "../sqlite/errors.js";
import { REHEARSAL_MARKING } from "./marking.js";

// --------------------------------------------------------------------------
// the closed owning-system vocabulary
// --------------------------------------------------------------------------

/** The live system. Matches the `CHECK (owning_system IN ...)` literal. */
export const INTERLOCK = "interlock";

/**
 * The stand-in counterparty.
 *
 * Named `synthetic_v1` rather than `v1` so that a ledger written by the
 * rehearsal can never be read later as evidence obtained against the live
 * counterparty.
 */
export const SYNTHETIC_V1 = "synthetic_v1";

/**
 * The vocabulary, ordered and closed: two values, because the canary shape
 * (D-0013) has exactly two systems.
 */
export const OWNING_SYSTEMS = [INTERLOCK, SYNTHETIC_V1] as const;

/**
 * The DDL, as a file rather than a string in this module.
 *
 * Same reasoning as `spike_schema.sql`: the marking has to be in the artifact
 * an operator actually reads, and a `.sql` file can be read, diffed and run by
 * `sqlite3` without importing anything.
 *
 * Resolved from `import.meta.url`, so the schema travels with the module
 * whatever directory a caller runs from -- and so a build that does not copy
 * the `.sql` into `dist/` beside `ledger.js` breaks every create *and* every
 * open. `scripts/copy-canary-schema.mjs` is that copy step.
 */
export const LEDGER_SCHEMA_PATH: string = fileURLToPath(
  new URL("./routing_ledger.sql", import.meta.url),
);

/**
 * `PRAGMA application_id` for ledger files: `0x494c4b43`, ASCII `"ILKC"` --
 * interlock, canary.
 *
 * Deliberately **not** the control plane's `0x494c4b35` ("ILK5"). The two
 * openers then refuse each other's files by identity rather than by shape,
 * which is a refusal an operator can act on ("this is the wrong file") instead
 * of one that reads like corruption ("this database is missing tables").
 */
export const LEDGER_APPLICATION_ID = 0x494c4b43;

/** `PRAGMA user_version`. A ledger at any other revision is refused (D-0026). */
export const LEDGER_REVISION = 1;

/**
 * The two relations, in the order the DDL declares them.
 *
 * Ordered rather than a set because the missing-table refusal joins what is
 * absent in *this* order, not in the order `sqlite_master` happened to return.
 */
export const LEDGER_TABLES = ["routing_decision", "run_owner"] as const;

// --------------------------------------------------------------------------
// the refusal family
// --------------------------------------------------------------------------

/**
 * A ledger database was refused. It was neither repaired nor recreated.
 *
 * `Object.setPrototypeOf` in every constructor: extending a built-in under a
 * downlevel emit target loses the prototype chain and `instanceof` then
 * silently reports false, which would turn the tests' type assertions into
 * message assertions without saying so.
 */
export class RoutingLedgerRefusal extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RoutingLedgerRefusal";
    Object.setPrototypeOf(this, RoutingLedgerRefusal.prototype);
  }
}

/** There is no file at the path. Opening never creates one. */
export class MissingLedgerRefused extends RoutingLedgerRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MissingLedgerRefused";
    Object.setPrototypeOf(this, MissingLedgerRefused.prototype);
  }
}

/** The file exists but could not be verified, so it was not opened. */
export class CorruptLedgerRefused extends RoutingLedgerRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CorruptLedgerRefused";
    Object.setPrototypeOf(this, CorruptLedgerRefused.prototype);
  }
}

// --------------------------------------------------------------------------
// the module's replaceable internals (D-0014)
// --------------------------------------------------------------------------

/**
 * The one seam this module needs.
 *
 * Python resolves `LEDGER_SCHEMA_PATH` through the module dictionary at **call**
 * time, which is why `monkeypatch.setattr(ledger_module, "LEDGER_SCHEMA_PATH",
 * stripped)` is visible to `load_ledger_sql` itself. ESM bindings are resolved
 * at link time and cannot be rebound from outside, so
 * `test_the_ddl_is_refused_if_the_marking_is_removed` -- which points the
 * loader at a doctored copy with the marking edited away -- has no direct
 * translation without a seam record (D-0014, and section 5 of
 * docs/test-translation-conventions.md).
 *
 * {@link loadLedgerSql} reads the path through this record and never through
 * the exported constant, so replacing the entry changes what production reads.
 * A target-only case pins that routing, because a seam production stopped going
 * through would leave the ported case green for the wrong reason.
 *
 * Not barrel surface: it is a seam for the tests that own this module.
 */
export const ledgerSeams = {
  /** @see LEDGER_SCHEMA_PATH */
  ledgerSchemaPath: LEDGER_SCHEMA_PATH,
};

// --------------------------------------------------------------------------
// the DDL and its marking
// --------------------------------------------------------------------------

/**
 * The DDL as one sentence per line-wrapped comment: strip the SQL comment
 * prefix at each line start, then fold every whitespace run to a single space.
 *
 * The marking spans four comment lines of `routing_ledger.sql`, so it is only
 * matchable *after* this collapse -- which is why the loader's own rule is
 * exported rather than restated in the test that asserts the file carries the
 * sentence. A test that reimplemented the regex would be comparing its own
 * construction against itself.
 *
 * Two details are the source's, exactly:
 *
 * - `replaceAll`, not `replace`. Python's `str.replace` replaces every
 *   occurrence; JS `String#replace` with a *string* pattern replaces only the
 *   first, which would leave every comment line after the first one prefixed.
 * - Comment-strip first, whitespace-collapse second, and only one `--` per line
 *   start (so `\n----` becomes `\n--`). The first line of the file has no
 *   preceding newline, so its `--` survives; the marking is not on line 1.
 *
 * Exported for the ported case that reaches into Python's private `_collapsed`.
 * Not barrel surface.
 */
export function collapsedLedgerSql(text: string): string {
  return text.replaceAll("\n--", "\n").replace(/\s+/gu, " ");
}

/**
 * Return the DDL, refusing it if the rehearsal marking is not in the file.
 *
 * Checked at load time rather than asserted in a test alone, because the
 * failure it guards against is the marking being edited away by someone who
 * found it noisy -- which is how a rehearsal artifact quietly becomes evidence.
 *
 * @throws RoutingLedgerRefusal -- the base class, never a subclass: nothing is
 * wrong with any database here.
 */
export function loadLedgerSql(): string {
  const path = ledgerSeams.ledgerSchemaPath;
  // Strictly decoded, like every other SQL artifact this package reads
  // (D-0015). Node's `readFileSync(path, "utf-8")` substitutes U+FFFD for
  // undecodable bytes, so a truncated or corrupted DDL would decode to
  // something plausible and then be applied; Python's
  // `read_text(encoding="utf-8")` raises instead.
  const sql = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  if (!collapsedLedgerSql(sql).includes(REHEARSAL_MARKING)) {
    throw new RoutingLedgerRefusal(
      // The bare filename, not the path -- Python interpolates
      // `LEDGER_SCHEMA_PATH.name`.
      `${basename(path)} no longer carries the rehearsal marking; ` +
        "refusing to apply it (D-0022, D-0026)",
    );
  }
  return sql;
}

// --------------------------------------------------------------------------
// creating and opening
// --------------------------------------------------------------------------

/**
 * Create the routing ledger at `path` and return an open connection.
 *
 * The order below is load-bearing at every step and is the source's exactly:
 * the marking check happens before any filesystem effect, the path is claimed
 * *atomically*, and any failure after the claim removes the file it made.
 *
 * @throws RoutingLedgerRefusal if anything already exists at `path` -- file,
 * directory or symlink. Every other `OSError`-equivalent (a missing parent
 * directory, a permission failure) propagates unwrapped, because it is not a
 * refusal this module is making.
 */
export function createRoutingLedger(path: string): SqliteDatabase {
  const target = path;
  const sql = loadLedgerSql();

  // Claim the path with O_EXCL rather than by asking whether it exists: two
  // processes racing to create the same ledger would both pass an exists()
  // check, and the loser -- whose DDL fails against the winner's database --
  // would then unlink a ledger that is already in use. With the claim atomic,
  // only the process that actually created the file can reach the cleanup
  // below.
  try {
    closeSync(openSync(target, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new RoutingLedgerRefusal(`${target} already exists; refusing to create over it`, {
        cause: error,
      });
    }
    throw error;
  }

  let connection: SqliteDatabase;
  try {
    connection = new Database(target, { fileMustExist: false });
  } catch (error) {
    // The claim above created the file, so a connect that never returns one
    // would otherwise leave an empty file that refuses both creation (it
    // exists) and opening (it is not a ledger).
    rmSync(target, { force: true });
    throw error;
  }

  try {
    // The DDL runs before `configureLedgerConnection`, so `foreign_keys` and
    // `recursive_triggers` are still at SQLite's defaults here. This is
    // DDL only, so neither matters -- and it is the source's order.
    connection.exec(sql);
    connection.pragma(`application_id = ${LEDGER_APPLICATION_ID}`);
    connection.pragma(`user_version = ${LEDGER_REVISION}`);
  } catch (error) {
    // A half-created ledger is exactly the corrupt state R3 refuses, so a
    // failed creation leaves nothing behind to be opened later.
    //
    // Not guarded, because Python's is not: a `close()` that itself raises
    // aborts the cleanup there, leaves the half-created file on disk and
    // surfaces the close error. Swallowing it here would make the port quietly
    // better than the source on a path no test reaches.
    connection.close();
    rmSync(target, { force: true });
    throw error;
  }

  configureLedgerConnection(connection);
  return connection;
}

/**
 * Open an existing routing ledger, or refuse.
 *
 * Never creates, never migrates, never repairs.
 *
 * **Verification runs on the connection that is returned.** Verifying one
 * handle and then opening a second would leave a window in which the verified
 * file is replaced -- or deleted, in which case a plain open would create the
 * empty database this function promises never to make. The source's docstring
 * forbids verify-then-reopen by name, and so does this port.
 *
 * @throws MissingLedgerRefused if nothing is at `path`.
 * @throws CorruptLedgerRefused if the file is there and did not verify.
 */
export function openRoutingLedger(path: string): SqliteDatabase {
  const target = path;
  if (!existsSync(target)) {
    throw new MissingLedgerRefused(
      `${target} does not exist; refusing to open ` +
        "(createRoutingLedger creates one explicitly)",
    );
  }
  // `statSync`, not `lstatSync`: Python's `is_file()` follows symlinks, so a
  // symlink to a valid ledger is accepted. A directory, FIFO, socket or device
  // is not.
  if (!statSync(target).isFile()) {
    throw new CorruptLedgerRefused(`${target} is not a regular file`);
  }

  let connection: SqliteDatabase;
  try {
    // `fileMustExist` is the real anti-creation guarantee -- Python gets the
    // same thing from the `?mode=rw` URI. The `existsSync` above is for message
    // quality; this is what makes a path deleted in between refuse rather than
    // become a new empty database.
    connection = new Database(target, { fileMustExist: true });
  } catch (error) {
    // Narrowed to driver errors, as Python's `except sqlite3.Error` is. A
    // failure that is not SQLite's is not evidence that the file is corrupt.
    if (!isSqliteError(error)) {
      throw error;
    }
    throw new CorruptLedgerRefused(`${target} could not be opened: ${describe(error)}`, {
      cause: error,
    });
  }

  try {
    verify(target, connection);
  } catch (error) {
    connection.close();
    // "file is not a database", a truncated header, a corrupted page read while
    // answering a pragma: all refusals, never an empty start (R3). Everything
    // else -- the `CorruptLedgerRefused` instances `verify` raises itself, and
    // the `RoutingLedgerRefusal` a de-marked DDL raises from inside
    // `expectedLedgerFingerprint` -- propagates unchanged in type and message.
    // The connection is closed either way.
    if (isSqliteError(error)) {
      throw new CorruptLedgerRefused(`${target} is not a readable database: ${describe(error)}`, {
        cause: error,
      });
    }
    throw error;
  }

  configureLedgerConnection(connection);
  return connection;
}

/**
 * The pragmas every connection this module hands out carries, in this order.
 *
 * `recursive_triggers = ON` is the store-enforcement crux and not a detail.
 * With it off -- SQLite's default, and better-sqlite3's -- `INSERT OR REPLACE`
 * resolves a primary-key conflict by deleting the standing row **without
 * firing the BEFORE DELETE trigger**, and the re-insert then passes every
 * remaining guard: a mid-flight owner change reachable in one statement. The
 * triggers are only as good as the connection's willingness to run them, and
 * the pragma is per-connection, which is why it lives here beside
 * `foreign_keys` and is applied on the create path *and* the open path.
 *
 * No `journal_mode` pragma: see this module's header. Run outside any
 * transaction -- `PRAGMA foreign_keys` is a silent no-op inside one.
 */
export function configureLedgerConnection(connection: SqliteDatabase): void {
  connection.pragma("foreign_keys = ON");
  connection.pragma("synchronous = FULL");
  connection.pragma("recursive_triggers = ON");
}

// --------------------------------------------------------------------------
// verification
// --------------------------------------------------------------------------

/**
 * The refusal ladder, in the source's order: `integrity_check`,
 * `application_id`, `user_version`, table presence, schema fingerprint,
 * `foreign_key_check`.
 *
 * The order decides which refusal a multiply-broken file produces, and the
 * ported cases pin specific fixtures to specific rungs -- an empty 0-byte file
 * passes `integrity_check` and must fail at `application_id`, not at the
 * missing-tables rung; a ledger that lost a table must say so rather than
 * report a fingerprint mismatch.
 *
 * Every check only reads, so a refused file is left exactly as it was found.
 */
function verify(target: string, connection: SqliteDatabase): void {
  const integrity = connection.pragma("integrity_check") as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new CorruptLedgerRefused(`${target} failed integrity_check: ${renderRows(integrity)}`);
  }

  const applicationId = connection.pragma("application_id", { simple: true }) as number;
  if (applicationId !== LEDGER_APPLICATION_ID) {
    throw new CorruptLedgerRefused(
      `${target} carries application_id ${hex(applicationId)}, not the routing ` +
        `ledger's ${hex(LEDGER_APPLICATION_ID)}; it is some other database`,
    );
  }

  const userVersion = connection.pragma("user_version", { simple: true }) as number;
  if (userVersion !== LEDGER_REVISION) {
    throw new CorruptLedgerRefused(
      `${target} is at ledger revision ${userVersion}, this build writes ` +
        `${LEDGER_REVISION}, and no migration path exists (D-0026)`,
    );
  }

  const present = new Set(
    (
      connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  // Iterated in LEDGER_TABLES order, never in discovery order: the message
  // names what is absent, and the order it names them in is the schema's.
  const missing = LEDGER_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new CorruptLedgerRefused(
      `${target} is missing ledger table(s) ${missing.join(", ")}; a database ` +
        "that lost a table is corrupt, not empty (R3)",
    );
  }

  // The triggers ARE the ledger's guarantees, and a database that has lost one
  // still passes `integrity_check` -- so the shape is compared outright, the
  // same way S5 compares its own. Dropping a trigger is detected only here.
  if (ledgerSchemaFingerprint(connection) !== expectedLedgerFingerprint()) {
    throw new CorruptLedgerRefused(
      `${target} does not carry this build's ledger schema: a table, trigger ` +
        "or CHECK differs, and losing a trigger here is losing the mid-flight " +
        "immutability itself; refusing rather than reading",
    );
  }

  // `foreign_keys` is per-connection, so a writer that had it off can leave a
  // run_owner row pointing at a decision that does not exist. This check is
  // unaffected by the pragma, and runs before `configureLedgerConnection` here
  // exactly as it does in the source.
  const violations = connection.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new CorruptLedgerRefused(
      `${target} has ${violations.length} dangling foreign key reference(s); ` +
        "refusing rather than reading partial state",
    );
  }
}

/**
 * The fingerprint of a ledger freshly built from the current DDL.
 *
 * **Derived, never pinned as a constant beside the file**, so the two cannot
 * drift: a DDL edit changes the expected fingerprint by construction, and every
 * database written by an earlier build is refused the moment the shape changes
 * -- which is what "no migration path" means in practice (D-0026).
 *
 * It also means a de-marked DDL makes every *open* fail, not just every create:
 * `loadLedgerSql` runs here, inside verification.
 */
export function expectedLedgerFingerprint(): string {
  const scratch = new Database(":memory:");
  try {
    scratch.exec(loadLedgerSql());
    return ledgerSchemaFingerprint(scratch);
  } finally {
    scratch.close();
  }
}

/**
 * A digest over every schema object's own DDL text.
 *
 * Same shape as `control_plane/schema.ts`'s `schemaFingerprint`, and
 * deliberately its own function rather than an import: the two hash different
 * databases for different reasons, and a shared helper would make a change made
 * for one of them apply silently to the other.
 *
 * `ORDER BY type, name` is SQLite's BINARY collation, done **inside the query**
 * -- a JS re-sort compares differently, and a locale-aware one differs even for
 * ASCII. `sqlite_master.sql` stores each CREATE statement verbatim, including
 * its internal whitespace and inline comments, so the digest covers the exact
 * DDL text; that is also why the build's copy of the `.sql` must be
 * byte-for-byte.
 */
function ledgerSchemaFingerprint(connection: SqliteDatabase): string {
  const rows = connection
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; sql: string | null }[];
  const payload = rows.map((row) => `${row.type}\t${row.name}\t${row.sql ?? ""}`).join("\n");
  return createHash("sha256").update(payload, "utf-8").digest("hex");
}

// --------------------------------------------------------------------------
// message rendering
// --------------------------------------------------------------------------

/**
 * Python's `{n:#x}`: lower-case hex with an `0x` prefix, and `-0x...` rather than
 * a two's-complement value for a negative id (D-0017 rule 3).
 *
 * The negative branch is reachable: the canonical id is well below 2^31, but a
 * hostile file can carry any 32-bit `application_id` and better-sqlite3 hands
 * it back as a signed JS number.
 */
function hex(value: number): string {
  return value < 0 ? `-0x${Math.abs(value).toString(16)}` : `0x${value.toString(16)}`;
}

/** An error's message, for interpolation into a refusal -- Python's `{error}`. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Render one pragma row the way Python renders a `sqlite3.Row` tuple.
 *
 * One renderer rather than an inline join at the call site (D-0017 rule 4).
 * `control_plane/schema.ts` has the same pair, unexported; this module keeps
 * its own rather than widening that module's surface for a message.
 */
function renderRow(row: unknown): string {
  if (row === null || typeof row !== "object") {
    return String(row);
  }
  const values = Object.values(row as Record<string, unknown>);
  const rendered = values.map((value) =>
    typeof value === "string" ? `'${value}'` : String(value),
  );
  // A Python 1-tuple renders as `('ok',)`, with the trailing comma that is what
  // makes it a tuple rather than a parenthesised expression. `integrity_check`
  // returns exactly one such row, and it is the row this renderer exists for.
  return rendered.length === 1 ? `(${rendered[0]},)` : `(${rendered.join(", ")})`;
}

function renderRows(rows: readonly unknown[]): string {
  return `[${rows.map(renderRow).join(", ")}]`;
}
