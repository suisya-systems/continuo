/**
 * S5 -- opening, creating and querying the **spike** control-plane database.
 *
 * .. warning::
 *
 *    **The schema this module applies is a spike schema, and no migration path
 *    is promised from it (D-0026).** The marking lives in `spike_schema.sql`
 *    itself, where the acceptance criterion of Issue `#12` puts it -- not in a
 *    commit message and not in a plan document. This module is the enforcement
 *    arm of the same sentence: a database written at one {@link SCHEMA_REVISION}
 *    is **refused** by the next one rather than migrated ({@link
 *    openControlPlane}). Refusing is deliberate. A migration path would be the
 *    first half of a promotion nobody decided on. `Q-0001` -- the real DDL,
 *    keys, indices, per-item single-writer table and migration policy -- was
 *    open until D-0029 decided it on its own terms in the production schema
 *    (docs/production-schema.md section 4.2, `control_plane/migrations/0001_initial.sql`);
 *    this module still opens the spike schema that predates that decision.
 *
 * Two behaviours here are load-bearing rather than convenient:
 *
 * **Corrupt state is refused, never recovered as empty (R3).** R3 records the
 * v1 defect by name: "a broken state file recovers as empty" permits
 * already-applied effects to replay once dedup state is authoritative. So
 * {@link openControlPlane} never creates, never repairs, and never returns a
 * connection to a database it could not verify. Every refusal is a typed
 * {@link ControlPlaneRefusal} carrying what was wrong, and the file on disk is
 * left exactly as it was found -- verification runs over a **read-only**
 * connection, so the refusal path cannot even write a rollback journal.
 * Creating a database is a separate, explicit call ({@link
 * createControlPlane}), which in turn refuses to touch a path that already
 * exists.
 *
 * **State is reconstructed by query alone (D-0001).** {@link reconstruct}
 * answers "what was happening?" from the database and nothing else -- no
 * cached handle, no module-level registry, no state that a restarted process
 * would have to be told about. {@link RECONSTRUCTION_QUERIES} holds the SQL as
 * data so that the queries themselves can be read, reviewed and run by hand
 * against a database recovered from a crash.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { isSqliteError } from "../sqlite/errors.js";
import {
  type ControlPlaneOpenOptions,
  configureConnection,
  openControlPlaneConnection,
} from "./connection.js";
import { ControlPlaneRefusal, CorruptStateRefused, MissingStateRefused } from "./refusals.js";
import { SPIKE_APPLICATION_ID } from "./spike.js";

/**
 * The DDL. It is a separate `.sql` file and not a string in this module on
 * purpose: the acceptance criterion asks that *the schema file* carry the
 * spike marking, and a schema file that can be read, diffed and run by
 * `sqlite3` without importing anything is the one an operator will actually
 * read.
 *
 * Resolved from `import.meta.url`, not `process.cwd()`, so the schema travels
 * with the module whatever directory a caller runs from.
 */
export const SPIKE_SCHEMA_PATH: string = fileURLToPath(
  new URL("./spike_schema.sql", import.meta.url),
);

/**
 * The sentence {@link loadSchemaSql} refuses to load the DDL without. It is
 * checked at load time rather than asserted in a test alone, because the
 * failure it guards against is the marking being edited away by someone who
 * found it noisy -- which is exactly how a spike schema becomes *the* schema.
 */
export const SPIKE_MARKING = "THIS IS A SPIKE SCHEMA. NO MIGRATION PATH IS PROMISED FROM IT.";

/** `PRAGMA user_version`. Bumped whenever `spike_schema.sql` changes shape. */
export const SCHEMA_REVISION = 2;

/**
 * The six tables of the slice, in the order Issue `#12` names them. Every one
 * of them must be present for a database to be usable; a database missing one
 * is corrupt, not empty.
 */
export const STATE_TABLES = ["run", "session", "lease", "outbox", "incident", "action"] as const;

/**
 * The recovery reads, as data. Each answers one question a process asks after
 * a mid-flight kill, and each is answerable from SQLite alone (D-0001).
 *
 * Keys are the source's dict keys, carried verbatim rather than recased to
 * match {@link ControlPlaneState}'s camelCase fields: this map indexes SQL
 * text by the same name a reader of interlock's `schema.py` would search for.
 */
export const RECONSTRUCTION_QUERIES: {
  readonly runs: string;
  readonly active_sessions: string;
  readonly held_leases: string;
  readonly unfinished_outbox: string;
  readonly unresolved_incidents: string;
  readonly pending_actions: string;
} = {
  // D-0001 names `run` as source-of-truth state, and a run may exist before any
  // session, outbox row or incident does -- so a reconstruction that reached
  // runs only through their children would lose exactly the run that was
  // killed at its riskiest moment. Every run is returned, unfiltered: which
  // statuses count as finished was part of the vocabulary Q-0001 left open on
  // this spike schema (D-0029 has since answered it in the production schema,
  // section 4.3), and a WHERE clause here would pick one.
  runs: `
        SELECT run_id, status, created_at_ms, updated_at_ms
          FROM run
         ORDER BY created_at_ms, run_id
    `,
  // Item 2: exactly one live session per run, re-identified after the crash
  // window. The uniqueness is the database's (see
  // `session_one_active_binding_per_run`); this query is how a recovering
  // supervisor reads it back.
  active_sessions: `
        SELECT session_id, run_id, provider, binding_phase, observation,
               provider_state, observation_reason, bound_at_ms
          FROM session
         WHERE released_at_ms IS NULL
         ORDER BY bound_at_ms, session_id
    `,
  // Item 5: which resources are held, and under which fencing token, at the
  // instant recovery runs. The caller supplies :now_ms -- the clock is not the
  // database's (ACCEPTANCE.md section 2 skews it on purpose).
  held_leases: `
        SELECT resource, holder, epoch, acquired_at_ms, expires_at_ms
          FROM lease
         WHERE expires_at_ms > :now_ms
         ORDER BY resource
    `,
  // Item 5/6: everything enqueued and not yet acked, oldest first. "No outbox
  // row remains in a state with no owner after recovery" is checked against
  // this.
  unfinished_outbox: `
        SELECT message_id, run_id, recipient, dedup_key, status, retry_count,
               writer_epoch, enqueued_at_ms, delivered_at_ms
          FROM outbox
         WHERE status <> 'acked'
         ORDER BY enqueued_at_ms, message_id
    `,
  // Item 4: "work resumes from unresolved incidents" (D-0001), and the row is
  // the whole packet the on-demand AI is restarted from (D-0007).
  unresolved_incidents: `
        SELECT incident_id, run_id, session_id, fact_state, detector_version,
               dedup_key, retry_count, known_pattern, elapsed_ms, evidence_refs,
               recent_transitions, previous_assessment, previous_action_id,
               related_incident_id, created_at_ms, updated_at_ms
          FROM incident
         WHERE resolved_at_ms IS NULL
         ORDER BY created_at_ms, incident_id
    `,
  // Item 4: side effects that were recorded but not applied. Each names the
  // mechanism by which re-applying it is safe -- SQLite cannot tell an effect
  // that completed from one that never started, so the mechanism is the
  // answer and the query is not.
  pending_actions: `
        SELECT action_id, run_id, incident_id, kind, idempotency_key,
               exactly_once_mechanism, writer_epoch, created_at_ms
          FROM action
         WHERE status = 'pending'
         ORDER BY created_at_ms, action_id
    `,
};

/**
 * What {@link reconstruct} read back.
 *
 * Rows, not domain objects: this is the spike schema's shape, and D-0026
 * keeps it from becoming a domain model by inertia. Field names are camelCase
 * per this port's convention, but every row object inside keeps the SQL
 * column names verbatim -- `run_id`, `created_at_ms` and so on -- because
 * those names are queried out of `RECONSTRUCTION_QUERIES` at read time, not
 * declared by this interface.
 */
export interface ControlPlaneState {
  readonly runs: readonly Record<string, unknown>[];
  readonly activeSessions: readonly Record<string, unknown>[];
  readonly heldLeases: readonly Record<string, unknown>[];
  readonly unfinishedOutbox: readonly Record<string, unknown>[];
  readonly unresolvedIncidents: readonly Record<string, unknown>[];
  readonly pendingActions: readonly Record<string, unknown>[];
}

/**
 * The module's replaceable internals (D-0014).
 *
 * Python resolves `SPIKE_SCHEMA_PATH` and `sqlite3.connect` at **call** time
 * through the module dictionary, which is exactly why
 * `monkeypatch.setattr(s5, "SPIKE_SCHEMA_PATH", stripped)` and
 * `monkeypatch.setattr(s5.sqlite3, "connect", unavailable)` are visible to
 * every function in `schema.py` that reads either name. ESM bindings are
 * resolved at link time and cannot be rebound from outside, so a direct
 * translation would leave three ported cases unable to construct the state
 * they refuse:
 *
 * - `test_the_ddl_is_refused_if_the_marking_is_removed` points
 *   `SPIKE_SCHEMA_PATH` at a doctored copy with the marking stripped.
 * - `test_a_creation_that_cannot_connect_leaves_no_file_behind` and
 *   `test_a_creation_that_loses_a_race_does_not_delete_the_winners_database`
 *   replace `connect` to simulate a connection that never returns and a
 *   database opened by a process that lost a creation race.
 *
 * Every internal call site below goes *through* this record rather than
 * reading the exported constants or calling `openControlPlaneConnection`
 * directly, so replacing an entry changes what production code calls -- the
 * property the source tests rely on.
 *
 * Not re-exported from `src/index.ts`: it is a seam for the tests that own
 * this module, not public API. See DECISIONS.md D-0014.
 */
export const schemaSeams = {
  /** @see SPIKE_SCHEMA_PATH */
  spikeSchemaPath: SPIKE_SCHEMA_PATH,

  /** Opens a control-plane connection. Read through at every connect site. */
  connect: connectImpl,
};

function connectImpl(path: string, options?: ControlPlaneOpenOptions): SqliteDatabase {
  return openControlPlaneConnection(path, options);
}

/**
 * Return the DDL, refusing it if the spike marking is not in the file.
 *
 * @throws ControlPlaneRefusal if {@link SPIKE_MARKING} is absent. The marking
 * *is* the D-0026 mitigation; a schema that has lost it is one edit away from
 * being applied as though something had promoted it.
 */
export function loadSchemaSql(): string {
  const path = schemaSeams.spikeSchemaPath;
  // Strictly decoded, like every other SQL artifact this package reads
  // (D-0015). Node's `readFileSync(path, "utf-8")` substitutes U+FFFD for
  // undecodable bytes, so a truncated or corrupted DDL would decode to
  // something plausible and be applied; Python's `read_text(encoding="utf-8")`
  // raises instead, and that refusal is the behaviour being ported.
  const sql = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  if (!sql.includes(SPIKE_MARKING)) {
    throw new ControlPlaneRefusal(
      `${basename(path)} no longer carries the spike marking ('${SPIKE_MARKING}'); ` +
        "refusing to apply it (D-0026)",
    );
  }
  return sql;
}

/**
 * Create the spike database at `path` and return an open connection.
 *
 * Creation is explicit and separate from opening, which is what keeps
 * "recover as empty" from being reachable by accident (R3): no code path that
 * merely wanted to *read* state can end up having made a new one.
 *
 * @throws ControlPlaneRefusal if anything already exists at `path`. An
 * existing database is never clobbered, and an existing non-database is never
 * overwritten either.
 */
export function createControlPlane(path: string): SqliteDatabase {
  const target = path;
  const sql = loadSchemaSql();

  // Claim the path with O_EXCL rather than by asking whether it exists: two
  // processes racing to create the same database would both pass an exists()
  // check, and the loser -- whose CREATE TABLE fails against the winner's
  // database -- would then unlink a database that was already in use. With
  // the claim atomic, only the process that actually created the file can
  // reach the cleanup below.
  try {
    closeSync(openSync(target, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ControlPlaneRefusal(
        `${target} already exists; refusing to create over it ` +
          "(openControlPlane opens an existing database)",
        { cause: error },
      );
    }
    throw error;
  }

  let connection: SqliteDatabase;
  try {
    connection = schemaSeams.connect(target, { fileMustExist: false });
  } catch (error) {
    // The claim above created the file, so a connect that never returns one
    // would otherwise leave an empty file that refuses both creation (it
    // exists) and opening (it is not a database).
    rmSync(target, { force: true });
    throw error;
  }

  try {
    connection.exec(sql);
    connection.pragma(`application_id = ${SPIKE_APPLICATION_ID}`);
    connection.pragma(`user_version = ${SCHEMA_REVISION}`);
  } catch (error) {
    // A half-created database is precisely the corrupt state R3 is about, so a
    // failed creation leaves nothing behind to be opened later.
    // Not guarded, because Python's is not: a `close()` that itself raises
    // aborts the cleanup there, leaves the half-created file on disk and
    // surfaces the close error. Swallowing it here would make the port quietly
    // better than the source on a path no test reaches, which is the kind of
    // silent divergence a parity port exists to avoid.
    connection.close();
    rmSync(target, { force: true });
    throw error;
  }
  configureConnection(connection);
  return connection;
}

/**
 * Open an existing spike database, or refuse.
 *
 * Never creates, never migrates, never repairs. Verification runs over a
 * read-only connection first, so a database that fails it is not written to
 * at all -- not even a rollback journal.
 *
 * @throws MissingStateRefused if there is no file at `path`.
 * @throws CorruptStateRefused if the file is not a database this revision
 * wrote and can verify.
 */
export function openControlPlane(path: string): SqliteDatabase {
  const target = path;
  if (!existsSync(target)) {
    throw new MissingStateRefused(
      `${target} does not exist; refusing to open (createControlPlane creates ` +
        "one explicitly -- an absent database is not an empty one)",
    );
  }
  if (!statSync(target).isFile()) {
    throw new CorruptStateRefused(`${target} is not a regular file`);
  }

  verifyReadonly(target);

  const connection = schemaSeams.connect(target);
  configureConnection(connection);
  return connection;
}

/**
 * Rebuild the in-flight picture from the database alone (D-0001).
 *
 * `nowMs` is the caller's clock, not the database's: lease liveness is the
 * one reconstruction answer that depends on time, and ACCEPTANCE.md section 2
 * skews the clock across the expiry boundary on purpose.
 */
export function reconstruct(connection: SqliteDatabase, nowMs: number): ControlPlaneState {
  const rows = (
    query: string,
    params?: Record<string, unknown>,
  ): readonly Record<string, unknown>[] => {
    const statement = connection.prepare(query);
    return (params === undefined ? statement.all() : statement.all(params)) as Record<
      string,
      unknown
    >[];
  };

  return {
    runs: rows(RECONSTRUCTION_QUERIES.runs),
    activeSessions: rows(RECONSTRUCTION_QUERIES.active_sessions),
    heldLeases: rows(RECONSTRUCTION_QUERIES.held_leases, { now_ms: nowMs }),
    unfinishedOutbox: rows(RECONSTRUCTION_QUERIES.unfinished_outbox),
    unresolvedIncidents: rows(RECONSTRUCTION_QUERIES.unresolved_incidents),
    pendingActions: rows(RECONSTRUCTION_QUERIES.pending_actions),
  };
}

// --------------------------------------------------------------------------
// verification and connection setup
// --------------------------------------------------------------------------

/** Check `target` over a read-only connection, raising on the first fault. */
function verifyReadonly(target: string): void {
  let connection: SqliteDatabase;
  try {
    connection = schemaSeams.connect(target, { readonly: true });
  } catch (error) {
    // Narrowed to driver errors, as Python's `except sqlite3.Error` is. A
    // failure that is not SQLite's -- a seam replaced by a test, a programming
    // error in this module -- is not evidence that the database is corrupt,
    // and reporting it as CorruptStateRefused would tell an operator to
    // restore a file that is fine.
    if (!isSqliteError(error)) {
      throw error;
    }
    throw new CorruptStateRefused(`${target} could not be opened: ${describe(error)}`, {
      cause: error,
    });
  }

  try {
    verify(target, connection);
  } catch (error) {
    // "file is not a database", a truncated header, a corrupted page read
    // while answering a pragma. All of them are refusals, never an empty
    // start (R3).
    if (isSqliteError(error)) {
      throw new CorruptStateRefused(`${target} is not a readable database: ${describe(error)}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    connection.close();
  }
}

/**
 * Verification order is exactly Python's: integrity_check, application_id,
 * user_version, missing STATE_TABLES, schema fingerprint, foreign_key_check.
 * The order is asserted by tests.
 */
function verify(target: string, connection: SqliteDatabase): void {
  const integrity = connection.pragma("integrity_check") as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new CorruptStateRefused(`${target} failed integrity_check: ${renderRows(integrity)}`);
  }

  const applicationId = connection.pragma("application_id", { simple: true }) as number;
  if (applicationId !== SPIKE_APPLICATION_ID) {
    throw new CorruptStateRefused(
      `${target} carries application_id 0x${applicationId.toString(16)}, not this ` +
        `schema's 0x${SPIKE_APPLICATION_ID.toString(16)}; it is some other database`,
    );
  }

  const userVersion = connection.pragma("user_version", { simple: true }) as number;
  if (userVersion !== SCHEMA_REVISION) {
    throw new CorruptStateRefused(
      `${target} is at schema revision ${userVersion}, this build writes ` +
        `${SCHEMA_REVISION}, and D-0026 promises no migration path from a spike ` +
        "schema; refusing rather than upgrading or starting empty",
    );
  }

  const present = new Set(
    (
      connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  const missing = STATE_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new CorruptStateRefused(
      `${target} is missing state table(s) ${missing.join(", ")}; a database that ` +
        "lost a table is corrupt, not empty (R3)",
    );
  }

  const fingerprint = schemaFingerprint(connection);
  if (fingerprint !== expectedSchemaFingerprint()) {
    throw new CorruptStateRefused(
      `${target} does not carry this build's schema: a table, column, index, ` +
        "trigger or CHECK differs. integrity_check passes on a database that has " +
        "lost a constraint, so the shape is compared outright -- and D-0026 " +
        "promises no migration path, so the answer is refusal rather than repair",
    );
  }

  const violations = connection.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new CorruptStateRefused(
      `${target} has ${violations.length} dangling foreign key reference(s); ` +
        "refusing rather than reading partial state",
    );
  }
}

/**
 * The fingerprint of a database freshly built from the current DDL.
 *
 * Derived by building the schema in memory rather than by keeping a constant
 * beside the file, so the two cannot drift: a schema edit changes the
 * expected fingerprint by construction, and every existing database is
 * refused the moment the DDL changes shape -- which is what "no migration
 * path" means in practice (D-0026).
 */
export function expectedSchemaFingerprint(): string {
  const scratch = schemaSeams.connect(":memory:", { fileMustExist: false });
  try {
    scratch.exec(loadSchemaSql());
    return schemaFingerprint(scratch);
  } finally {
    scratch.close();
  }
}

/**
 * A digest over every schema object's own DDL text.
 *
 * `PRAGMA integrity_check` answers "are the pages readable?", not "is this
 * the schema you wrote?" -- a database that has lost an index, a trigger or a
 * CHECK passes it and then quietly permits what the lost constraint forbade.
 * Names alone are not enough for the same reason, so the comparison is over
 * the stored DDL of every object.
 *
 * Exported for the ported case that asserts the two fingerprints are derived
 * the same way (`test_the_expected_fingerprint_is_derived_from_the_ddl_not_pinned_beside_it`,
 * which reads Python's module-private `_schema_fingerprint`). A test that
 * recomputed the digest itself would compare the test's construction with
 * itself and pin nothing.
 */
export function schemaFingerprint(connection: SqliteDatabase): string {
  const rows = connection
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; sql: string | null }[];
  const payload = rows.map((row) => `${row.type}\t${row.name}\t${row.sql ?? ""}`).join("\n");
  return createHash("sha256").update(payload, "utf-8").digest("hex");
}

/** An error's message, for interpolation into a refusal. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Render one pragma row the way Python renders a `sqlite3.Row` tuple.
 *
 * One renderer rather than an inline join, matching `migrator.ts`'s
 * `renderRow` / `renderRows` (D-0017 rule 4) so the two modules cannot drift
 * into rendering the same row two different ways.
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
