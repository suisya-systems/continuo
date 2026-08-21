/**
 * The production migration ledger -- every rule of `production-schema.md`
 * section 3.2, ported from interlock's `control_plane/migrator.py`.
 *
 * This module is a **sibling** of the spike schema module, not a successor to
 * it. The spike opens `application_id` `ILK5`; this opens `ILKP`. The distinct
 * id is the whole mechanism that stops a tool opening a spike file as
 * production, finding the expected tables missing, and concluding it merely
 * needs migrating.
 *
 * Six rules, all of them executable properties rather than prose:
 *
 * 1. **Forward-only.** No down migration exists, is exported, or is inferred.
 *    A rollback is a restore of the database file.
 * 2. **One step, one transaction**, carrying its own ledger row, so a failed
 *    step leaves the previous version rather than half a schema.
 * 3. **Checksum verification on every open.** An applied step is never edited.
 * 4. **A database ahead of the code is refused**, never downgraded.
 * 5. **Opening never migrates.** {@link migrateControlPlane} is the only thing
 *    that writes DDL, so a read-only consumer can be read-only by capability.
 * 6. **Corrupt state is refused, never recovered as empty.**
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { isCompleteStatement, splitLinesKeepEnds } from "../sqlite/complete-statement.js";
import { isBusyError, isNotADatabaseError, isSqliteError } from "../sqlite/errors.js";
import { configureConnection, openControlPlaneConnection } from "./connection.js";
import {
  ControlPlaneRefusal,
  CorruptStateRefused,
  DatabaseAheadOfCodeRefused,
  MigrationChecksumRefused,
  MigrationStepsRefused,
  MissingStateRefused,
} from "./refusals.js";
import { SPIKE_APPLICATION_ID } from "./spike.js";

/**
 * Where the shipped step files live.
 *
 * Resolved from `import.meta.url` rather than from `process.cwd()`, so that the
 * ledger travels with the module whatever directory a caller runs from -- and
 * so that `test_rendering_leaves_no_database_behind`, which changes directory
 * before rendering, is testing the module and not the test's own cwd.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** ASCII `ILKP`. Stamped on every production database. */
export const PRODUCTION_APPLICATION_ID = 0x494c4b50;

/**
 * A step file's name: exactly four digits, an underscore, a lower-case name.
 *
 * Fully anchored. Anything in the ledger directory that is not a companion and
 * does not match is a **refusal**, never a skip -- see {@link LEDGER_COMPANIONS}.
 */
export const STEP_FILENAME = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;

/**
 * The only directory entries discovery passes over silently.
 *
 * An allowlist by exact basename, and deliberately not a suffix test. "Skip
 * anything not ending in `.sql`" would silently skip `0007_fix.sql.bak`,
 * `0007_fix.sql~` and `0007_fix.sql.rej` -- and a silently skipped step is a
 * schema change that happened on some databases and not others.
 *
 * The names are interlock's, carried verbatim including the Python ones: the
 * list is by provenance, and adding Node-specific names is a change to what the
 * ledger directory may contain, which is a step-file decision and not a
 * translation detail.
 */
export const LEDGER_COMPANIONS: ReadonlySet<string> = new Set([
  "__init__.py",
  "__pycache__",
  "README.md",
  ".gitignore",
  ".gitkeep",
]);

/**
 * The ledger table, owned by the migrator rather than by step 0001 -- a step
 * cannot record itself in a table that does not exist yet.
 *
 * `IF NOT EXISTS` throughout, because this runs before every migration
 * including the ones with nothing to do.
 */
const SCHEMA_MIGRATION_DDL = `
CREATE TABLE IF NOT EXISTS schema_migration (
    version        INTEGER PRIMARY KEY,
    name           TEXT    NOT NULL,
    checksum       TEXT    NOT NULL,   -- sha256 of the step file's bytes
    applied_at_ms  INTEGER NOT NULL,

    CHECK (typeof(version) = 'integer' AND version > 0),
    CHECK (length(name) > 0),
    CHECK (length(checksum) = 64),
    CHECK (typeof(applied_at_ms) = 'integer')
);

CREATE TRIGGER IF NOT EXISTS schema_migration_rows_are_never_deleted
BEFORE DELETE ON schema_migration
BEGIN
    SELECT RAISE(ABORT, 'a migration record is the evidence the step ran; it is never deleted');
END;

CREATE TRIGGER IF NOT EXISTS schema_migration_rows_are_immutable
BEFORE UPDATE ON schema_migration
BEGIN
    SELECT RAISE(ABORT, 'a migration record is written once');
END;
`;

/** One `NNNN_name.sql` file. */
export interface MigrationStep {
  readonly version: number;
  readonly name: string;
  readonly path: string;
  /** sha256 of the file's raw bytes, lower-case hex. */
  readonly checksum: string;
  /** Those bytes decoded as UTF-8, strictly. */
  readonly sql: string;
}

/** One `schema_migration` row. */
export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at_ms: number;
}

/**
 * The module's replaceable internals, and the mutable tunable.
 *
 * Python resolves a module-level name at **call** time through the module
 * dictionary, which is exactly why `monkeypatch.setattr(m, "_apply_step", ...)`
 * is visible to `_apply_pending` calling it. ESM bindings are resolved at link
 * time and cannot be rebound from outside, so a direct translation would leave
 * three ported cases unable to construct the state they refuse.
 *
 * This record reproduces Python's late binding rather than working around it:
 * every internal call site below goes *through* the record, so replacing an
 * entry changes what production code calls, which is the property the source
 * tests rely on. Injecting the dependency as a parameter instead would change
 * the production call graph, and the test would then prove something about a
 * test-only path.
 *
 * Not re-exported from `src/index.ts`: it is a seam for the tests that own this
 * module, not public API. See DECISIONS.md D-0014.
 */
export const migratorSeams = {
  /**
   * How long a migration waits for the write lock.
   *
   * Read through the record at call time -- the lock-contention case sets it to
   * 250 ms so the test does not spend five seconds proving the wait happened.
   */
  migrationBusyTimeoutMs: 5_000,

  /** @see verifyReadonlyImpl */
  verifyReadonly: verifyReadonlyImpl,

  /** @see applyStepImpl */
  applyStep: applyStepImpl,
};

// --------------------------------------------------------------------------
// discovery
// --------------------------------------------------------------------------

/**
 * Every step in `directory`, ascending by version, or a refusal.
 *
 * The checks run in a fixed order and the first one to fire wins; several
 * ported cases distinguish the refusals by message, so the order is part of the
 * contract rather than an implementation accident.
 */
export function discoverMigrationSteps(directory?: string): readonly MigrationStep[] {
  const root = directory ?? MIGRATIONS_DIR;

  let entries: string[];
  try {
    if (!statSync(root).isDirectory()) {
      throw new Error("not a directory");
    }
    entries = readdirSync(root);
  } catch {
    throw new MigrationStepsRefused(
      `${root} is not a directory; the production DDL ledger is missing from ` +
        `this build, which is not the same thing as a database with no ` +
        `migrations applied`,
    );
  }

  // Python iterates `sorted(root.iterdir())`, which within one directory is
  // code-point order of the basename. JavaScript's default sort is also
  // code-unit order, so the incumbent named in a duplicate-version refusal is
  // the same file in both languages.
  entries.sort();

  const byVersion = new Map<number, MigrationStep>();
  for (const entry of entries) {
    if (LEDGER_COMPANIONS.has(entry)) {
      continue;
    }
    const path = join(root, entry);
    const match = STEP_FILENAME.exec(entry);
    if (match === null) {
      throw new MigrationStepsRefused(
        `${path} is not a migration step name (expected NNNN_name.sql with a ` +
          `four-digit version and a lower-case name, or one of the packaging ` +
          `companions ${renderCompanions()}); refusing rather than skipping ` +
          `it, because a skipped step is a schema change that happened on ` +
          `some databases and not others`,
      );
    }
    const version = Number.parseInt(match[1] as string, 10);
    if (version < 1) {
      throw new MigrationStepsRefused(
        `${path} claims version ${version}; versions start at 1 ` +
          `(schema_migration CHECKs version > 0)`,
      );
    }
    const incumbent = byVersion.get(version);
    if (incumbent !== undefined) {
      throw new MigrationStepsRefused(
        `${path} and ${incumbent.path} both claim version ${version}; the ` +
          `ledger records one row per version and cannot say which of the two ran`,
      );
    }

    const bytes = readFileSync(path);
    let sql: string;
    try {
      // `Buffer.toString("utf8")` substitutes U+FFFD and never fails, so a
      // truncated or corrupted artifact would decode to something plausible
      // and then be applied. The strict decoder is the whole point of the case
      // this refusal serves.
      sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new MigrationStepsRefused(
        `${path} is not valid UTF-8 (${describe(error)}); a step file whose ` +
          `bytes cannot be decoded is a corrupted or truncated artifact in ` +
          `this build, and applying the part that happens to decode would put ` +
          `half a schema change on the database`,
        { cause: error },
      );
    }

    byVersion.set(version, {
      version,
      name: match[2] as string,
      path,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      sql,
    });
  }

  const steps = [...byVersion.values()].sort((a, b) => a.version - b.version);
  if (steps.length === 0) {
    throw new MigrationStepsRefused(
      `${root} contains no migration steps; a build that ships no DDL is ` +
        `broken, not a schema at version zero. Refusing here is what stops a ` +
        `'production' database being created with no control-plane tables and ` +
        `then reported as at head, which is corrupt state recovered as empty ` +
        `(docs/production-schema.md section 3.2 rule 6)`,
    );
  }
  for (const [index, step] of steps.entries()) {
    const offset = index + 1;
    if (step.version !== offset) {
      throw new MigrationStepsRefused(
        `the migration ledger jumps from ${offset - 1} to ${step.version} ` +
          `(${basename(step.path)}); a hole is usually a step that was never ` +
          `committed, and migrating across it produces a database no other ` +
          `build can reproduce`,
      );
    }
  }
  return steps;
}

/** The companion allowlist as the refusal message renders it. */
function renderCompanions(): string {
  const sorted = [...LEDGER_COMPANIONS].sort();
  return `[${sorted.map((name) => `'${name}'`).join(", ")}]`;
}

/** The highest version this build ships, or 0 for an explicitly empty list. */
export function headVersion(steps?: readonly MigrationStep[]): number {
  const known = steps ?? discoverMigrationSteps();
  const last = known[known.length - 1];
  return last === undefined ? 0 : last.version;
}

/** The ledger rows, oldest first. Read-only; safe on a read-only connection. */
export function appliedMigrations(connection: SqliteDatabase): readonly AppliedMigration[] {
  return connection
    .prepare("SELECT version, name, checksum, applied_at_ms FROM schema_migration ORDER BY version")
    .all() as AppliedMigration[];
}

// --------------------------------------------------------------------------
// the three entry points
// --------------------------------------------------------------------------

/** Create a new production database at `path`, migrated to head. */
export function createProductionControlPlane(
  path: string,
  options: { readonly nowMs: number; readonly migrationsDir?: string },
): SqliteDatabase {
  requireEpochMs(options.nowMs);
  const target = path;
  // A broken ledger refuses before anything is created, so a bad build cannot
  // leave a half-made database behind for the next run to refuse twice.
  const steps = discoverMigrationSteps(options.migrationsDir);

  claimPath(target);

  let connection: SqliteDatabase;
  try {
    connection = openControlPlaneConnection(target, { fileMustExist: false });
  } catch (error) {
    unlinkDatabase(target);
    throw error;
  }

  try {
    connection.pragma(`application_id = ${PRODUCTION_APPLICATION_ID}`);
    configureConnection(connection);
    bootstrapLedger(connection);
    applyPending(connection, steps, options.nowMs);
  } catch (error) {
    // Any failure after the claim unwinds completely: a half-created database
    // would be refused by creation (it exists) and by opening (it is not a
    // database), which is corrupt state left for a human to clear by hand.
    try {
      connection.close();
    } catch {
      // Best effort; the diagnosis the caller needs is the original error.
    }
    unlinkDatabase(target);
    throw error;
  }
  return connection;
}

/**
 * Claim `path` atomically, or refuse.
 *
 * `wx` rather than an existence check: two processes racing would both pass a
 * check, and the loser -- whose migration then fails against the winner's
 * database -- would unlink a database already in use.
 */
function claimPath(target: string): void {
  try {
    closeSync(openSync(target, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ControlPlaneRefusal(
        `${target} already exists; refusing to create over it ` +
          `(openProductionControlPlane opens an existing database, ` +
          `migrateControlPlane brings it forward)`,
        { cause: error },
      );
    }
    throw new ControlPlaneRefusal(
      `${target} could not be created (${describe(error)}); the directory it ` +
        `lives in must exist and be writable before a control plane is created in it`,
      { cause: error },
    );
  }
}

/**
 * Remove a claimed database and its journal sidecars.
 *
 * The sidecars matter as much as the file: several ported cases assert that a
 * refused operation left nothing beside the database, and a stray `-journal` is
 * exactly the evidence they look for.
 */
function unlinkDatabase(target: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${target}${suffix}`, { force: true });
  }
}

/**
 * Open an existing production database that is at head, or refuse.
 *
 * Never migrates. That separation is the contract and not an omission: the
 * measurement harness opens read-only by capability, and interlock's lineage
 * records a v1 report tool whose ordinary connect helper "would happily run
 * forward migrations" -- making a read-only report a writer of the database it
 * reported on.
 */
export function openProductionControlPlane(
  path: string,
  options: { readonly migrationsDir?: string } = {},
): SqliteDatabase {
  const target = path;
  const steps = discoverMigrationSteps(options.migrationsDir);

  requireRegularFile(
    target,
    `${target} does not exist; refusing to open ` +
      `(createProductionControlPlane creates one explicitly -- an absent ` +
      `database is not an empty one)`,
  );

  refuseUnlessAtHead(target, migratorSeams.verifyReadonly(target, steps, true), steps);

  const connection = openControlPlaneConnection(target);
  try {
    configureConnection(connection);
    // Verification ran on a read-only connection that is now closed, and a
    // rolling deployment is by definition two builds opening one database, so
    // a newer build can migrate the file inside that gap. The handle actually
    // returned is therefore verified again, on itself.
    refuseUnlessAtHead(
      target,
      verifyProductionDatabase(target, connection, steps, { requireLedger: true }),
      steps,
    );
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

/** The one function that writes DDL. */
export function migrateControlPlane(
  pathOrConnection: string | SqliteDatabase,
  options: { readonly nowMs: number; readonly migrationsDir?: string },
): SqliteDatabase {
  requireEpochMs(options.nowMs);
  const steps = discoverMigrationSteps(options.migrationsDir);

  if (typeof pathOrConnection !== "string") {
    const connection = pathOrConnection;
    if (connection.inTransaction) {
      throw new ControlPlaneRefusal(
        "the connection handed to migrateControlPlane has a transaction open; " +
          "commit or roll it back first, because the migration's own " +
          "transactions would otherwise commit that work implicitly -- and it " +
          "would stay committed even if the migration is then refused",
      );
    }
    configureConnection(connection);
    claimBlankDatabase(connection);
    // The synthetic name appears in any refusal raised from this branch: there
    // is no path to name, and inventing one would put a file that does not
    // exist into an operator-facing message.
    verifyProductionDatabase("<caller connection>", connection, steps, { requireLedger: false });
    bootstrapLedger(connection);
    applyPending(connection, steps, options.nowMs);
    return connection;
  }

  const target = pathOrConnection;
  requireRegularFile(
    target,
    `${target} does not exist; migrating never creates ` +
      `(createProductionControlPlane does, and stamps the application_id that ` +
      `says whose database it is)`,
  );

  // The ledger may legitimately be absent here: a database created and then
  // killed before its first step is *behind*, not corrupt. No behind-check
  // either -- migrating a database that is behind is the entire point.
  migratorSeams.verifyReadonly(target, steps, false);

  const connection = openControlPlaneConnection(target);
  try {
    configureConnection(connection);
    // The same verify-then-reopen gap as the opener, and the no-op case is
    // where it hides: with nothing pending there is no step to fail, so
    // without this an older build would silently receive a writable handle to
    // a database a newer one had moved past it.
    verifyProductionDatabase(target, connection, steps, { requireLedger: false });
    bootstrapLedger(connection);
    applyPending(connection, steps, options.nowMs);
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

/** Refuse an absent path or a non-file, with the caller's absence message. */
function requireRegularFile(target: string, absentMessage: string): void {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(target);
  } catch {
    throw new MissingStateRefused(absentMessage);
  }
  if (!stats.isFile()) {
    throw new CorruptStateRefused(`${target} is not a regular file`);
  }
}

// --------------------------------------------------------------------------
// verification
// --------------------------------------------------------------------------

/**
 * Verify `target` over a read-only connection, raising on the first fault.
 *
 * Read-only so that a database which fails verification is never written to --
 * not even a rollback journal.
 */
function verifyReadonlyImpl(
  target: string,
  steps: readonly MigrationStep[],
  requireLedger: boolean,
): readonly AppliedMigration[] {
  let connection: SqliteDatabase;
  try {
    connection = openControlPlaneConnection(resolve(target), { readonly: true });
  } catch (error) {
    throw new CorruptStateRefused(`${target} could not be opened: ${describe(error)}`, {
      cause: error,
    });
  }

  try {
    return verifyProductionDatabase(target, connection, steps, { requireLedger });
  } catch (error) {
    // "file is not a database", a truncated header, a corrupt page read while
    // answering a pragma. All refusals, never an empty start (rule 6).
    if (isNotADatabaseError(error)) {
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
 * Hold a database to the production standard. Writes nothing.
 *
 * Public on purpose: the measurement harness applies this same standard on its
 * own read-only-by-capability connection, and two implementations of one
 * standard eventually disagree about one database.
 *
 * `target` is used only for message text, so a caller with no path may pass a
 * placeholder.
 *
 * Deliberately does **not** check whether the database is *behind* this build:
 * that is {@link refuseUnlessAtHead}'s job, and migrating skips it.
 */
export function verifyProductionDatabase(
  target: string,
  connection: SqliteDatabase,
  steps: readonly MigrationStep[],
  options: { readonly requireLedger: boolean },
): readonly AppliedMigration[] {
  const integrity = connection.pragma("integrity_check") as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new CorruptStateRefused(`${target} failed integrity_check: ${renderRows(integrity)}`);
  }

  const applicationId = connection.pragma("application_id", { simple: true }) as number;
  if (applicationId === SPIKE_APPLICATION_ID) {
    throw new CorruptStateRefused(
      `${target} is a spike database (application_id ` +
        `0x${SPIKE_APPLICATION_ID.toString(16)}), not a production one. There ` +
        `is no migration from the spike schema and none will be written ` +
        `(D-0026, D-0013: the cutover is at the run boundary with no state conversion)`,
    );
  }
  if (applicationId !== PRODUCTION_APPLICATION_ID) {
    throw new CorruptStateRefused(
      `${target} carries application_id 0x${applicationId.toString(16)}, not ` +
        `the production 0x${PRODUCTION_APPLICATION_ID.toString(16)}; it is ` +
        `some other database`,
    );
  }

  const tables = new Set(
    (
      connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  if (!tables.has("schema_migration")) {
    if (options.requireLedger) {
      throw new CorruptStateRefused(
        `${target} has no schema_migration table; a production database ` +
          `without its ledger cannot say which steps it has had applied, and ` +
          `guessing from the tables that happen to be present is how two ` +
          `databases at different shapes both report the same version`,
      );
    }
  }

  const applied = tables.has("schema_migration") ? appliedMigrations(connection) : [];
  const known = new Map(steps.map((step) => [step.version, step]));
  const highest = headVersion(steps);

  for (const row of applied) {
    const step = known.get(row.version);
    if (step === undefined) {
      throw new DatabaseAheadOfCodeRefused(
        `${target} has migration ${row.version} (${row.name}) applied and this ` +
          `build knows steps only up to ${highest}; refusing rather than ` +
          `downgrading -- there are no down migrations, and a rollback is a ` +
          `restore of the database file (docs/production-schema.md section 3.2 rule 1)`,
      );
    }
    if (row.checksum !== step.checksum) {
      throw new MigrationChecksumRefused(
        `${target} recorded migration ${row.version} (${row.name}) with ` +
          `checksum ${row.checksum}, but ${basename(step.path)} now hashes to ` +
          `${step.checksum}. An applied step is never edited: two databases ` +
          `whose histories differ would both keep reporting version ` +
          `${row.version}, and the divergence would be invisible from the ` +
          `version alone`,
      );
    }
    if (row.name !== step.name) {
      throw new MigrationChecksumRefused(
        `${target} recorded migration ${row.version} as '${row.name}' and this ` +
          `build's step ${row.version} is named '${step.name}'; the file was ` +
          `renamed after it was applied, which breaks the only link between a ` +
          `ledger row and the bytes it attests to`,
      );
    }
  }

  const last = applied[applied.length - 1];
  const current = last === undefined ? 0 : last.version;
  if (applied.length !== current) {
    throw new CorruptStateRefused(
      `${target}'s ledger is not contiguous from 1 (recorded: ` +
        `${applied.map((row) => String(row.version)).join(", ")}); a database ` +
        `missing an intermediate step is not at any version this build can reason about`,
    );
  }

  const userVersion = connection.pragma("user_version", { simple: true }) as number;
  if (userVersion !== current) {
    throw new CorruptStateRefused(
      `${target} has PRAGMA user_version = ${userVersion} but its ` +
        `schema_migration head is ${current}. The table is the authority and ` +
        `the pragma is the cheap check (docs/production-schema.md section ` +
        `3.1); a disagreement means one of them was written by something that ` +
        `did not write the other, so neither can be trusted`,
    );
  }

  const violations = connection.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new CorruptStateRefused(
      `${target} has ${violations.length} dangling foreign key reference(s); ` +
        `refusing rather than reading partial state`,
    );
  }

  return applied;
}

/** Refuse a database that is *behind* this build's steps. */
function refuseUnlessAtHead(
  target: string,
  applied: readonly AppliedMigration[],
  steps: readonly MigrationStep[],
): void {
  const last = applied[applied.length - 1];
  const current = last === undefined ? 0 : last.version;
  const head = headVersion(steps);
  if (current !== head) {
    throw new ControlPlaneRefusal(
      `${target} is at version ${current} and this build knows steps up to ` +
        `${head}; opening never migrates as a side effect (D-0029), so call ` +
        `migrateControlPlane explicitly`,
    );
  }
}

// --------------------------------------------------------------------------
// applying steps
// --------------------------------------------------------------------------

/** Create `schema_migration` if it is not there yet. */
function bootstrapLedger(connection: SqliteDatabase): void {
  connection.exec(SCHEMA_MIGRATION_DDL);
}

/**
 * Stamp the production `application_id` onto a database with nothing in it.
 *
 * Deliberately unable to relabel anything: it fires only when the id is still 0
 * *and* the database holds no schema objects at all. A spike database, a
 * foreign one, or a production one mid-history each fail one of those and fall
 * through to verification, which refuses them by name.
 */
function claimBlankDatabase(connection: SqliteDatabase): void {
  if ((connection.pragma("application_id", { simple: true }) as number) !== 0) {
    return;
  }
  const objects = connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as {
    n: number;
  };
  if (objects.n !== 0) {
    return;
  }
  connection.pragma(`application_id = ${PRODUCTION_APPLICATION_ID}`);
}

/**
 * Apply every step past the database's current version, in order.
 *
 * Foreign keys are enforced by whole-database check rather than per statement
 * for the duration. SQLite cannot alter a `CHECK` constraint, so widening one
 * means the documented 12-step table rebuild whose first step is
 * `PRAGMA foreign_keys = OFF` -- and that pragma is a no-op inside a
 * transaction, while every step here runs inside one. So the only place it can
 * be issued is around the whole run.
 *
 * Enforcement is relocated and widened, not dropped: each step ends with a
 * `foreign_key_check` over the entire database inside its own transaction,
 * which also catches violations a step's DDL created rather than only its DML.
 * The pragma is restored before returning, so the connection the caller ends up
 * holding is the fully enforcing one.
 */
function applyPending(
  connection: SqliteDatabase,
  steps: readonly MigrationStep[],
  nowMs: number,
): void {
  connection.pragma(`busy_timeout = ${migratorSeams.migrationBusyTimeoutMs}`);
  const head = connection
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migration")
    .get() as { v: number };
  const pending = steps.filter((step) => step.version > head.v);
  if (pending.length === 0) {
    return;
  }
  connection.pragma("foreign_keys = OFF");
  try {
    for (const step of pending) {
      migratorSeams.applyStep(connection, step, nowMs);
    }
  } finally {
    connection.pragma("foreign_keys = ON");
  }
}

/**
 * Apply one step and record it, in one transaction.
 *
 * `db.exec()` is not used for the whole step file. Like Python's
 * `executescript()` it takes multiple statements at once, and feeding a step
 * through it makes the statement boundaries the driver's business rather than
 * this function's -- which is how a step that fails halfway leaves part of
 * itself behind. The file is split with SQLite's own completeness rule (which
 * knows that the semicolons inside a `CREATE TRIGGER ... BEGIN ... END` body
 * are not terminators) and executed one statement at a time.
 *
 * `BEGIN IMMEDIATE` rather than a deferred begin: the write lock is taken up
 * front, so two processes racing collide at the first statement instead of at
 * the `COMMIT`, after one of them has already done its work. That `BEGIN` is
 * inside the guarded region because it is the statement most likely to fail,
 * and a collision escaping as a raw SQLite error is exactly the untyped
 * refusal this module's contract forbids.
 */
function applyStepImpl(connection: SqliteDatabase, step: MigrationStep, nowMs: number): void {
  let began = false;
  try {
    connection.exec("BEGIN IMMEDIATE");
    began = true;
    // Everything checked before this line was checked without the lock.
    // Inside the transaction this is not a narrowed window but a guarantee: no
    // other writer can move the database between this read and the COMMIT.
    const head = (
      connection.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migration").get() as {
        v: number;
      }
    ).v;
    if (head !== step.version - 1) {
      throw new MigrationStepsRefused(
        `migration step ${basename(step.path)} expected the database at ` +
          `version ${step.version - 1} but found it at ${head}: another ` +
          `migrator moved it after this one verified it (a rolling deploy ` +
          `migrating the same database). Nothing was applied; re-run ` +
          `migrateControlPlane, which will verify the database as it now ` +
          `stands and refuse it if it is ahead of this build ` +
          `(docs/production-schema.md section 3.2 rule 1)`,
      );
    }
    for (const statement of statementsOf(step)) {
      connection.exec(statement);
    }
    const violations = connection.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new MigrationStepsRefused(
        `migration step ${basename(step.path)} leaves ${violations.length} ` +
          `foreign key violation(s) (first: ${renderRow(violations[0])}); ` +
          `nothing was applied and the database is still at version ${step.version - 1}`,
      );
    }
    connection
      .prepare(
        "INSERT INTO schema_migration (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(step.version, step.name, step.checksum, nowMs);
    // user_version lives in the database header and is therefore part of this
    // transaction, so the cheap check and the authoritative table cannot end up
    // disagreeing because of a crash between two commits.
    connection.pragma(`user_version = ${step.version}`);
    connection.exec("COMMIT");
  } catch (error) {
    if (connection.inTransaction) {
      connection.exec("ROLLBACK");
    }
    if (!began && isBusyError(error)) {
      throw new MigrationStepsRefused(
        `migration step ${basename(step.path)} could not take the write lock ` +
          `within ${migratorSeams.migrationBusyTimeoutMs} ms -- another writer ` +
          `holds the database, most likely a second migration of it. Nothing ` +
          `was applied; the database is still at version ${step.version - 1}: ` +
          `${describe(error)}`,
        { cause: error },
      );
    }
    if (isSqliteError(error)) {
      throw new MigrationStepsRefused(
        `migration step ${basename(step.path)} failed and was rolled back; the ` +
          `database is still at version ${step.version - 1}: ${describe(error)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Split a step file into individually executable statements.
 *
 * A generator, as in the source, and drained lazily by the caller: an eager
 * array would raise the incomplete-statement refusal before any statement ran,
 * so a step with a broken tail would never exercise the rollback path.
 */
function* statementsOf(step: MigrationStep): Generator<string> {
  let buffer = "";
  for (const line of splitLinesKeepEnds(step.sql)) {
    buffer += line;
    if (buffer.trim() !== "" && isCompleteStatement(buffer)) {
      yield buffer;
      buffer = "";
    }
  }
  if (hasSql(buffer)) {
    throw new MigrationStepsRefused(
      `${basename(step.path)} ends in an incomplete statement (a missing ` +
        `semicolon, or an unterminated string or trigger body); refusing to ` +
        `apply a step whose tail SQLite cannot parse`,
    );
  }
}

/** Whether `text` is anything other than blank lines and `--` comments. */
function hasSql(text: string): boolean {
  return splitLinesKeepEnds(text).some((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("--");
  });
}

// --------------------------------------------------------------------------
// rendering
// --------------------------------------------------------------------------

/**
 * Emit the whole current schema as sorted DDL, for `docs/schema-current.sql`.
 *
 * A schema whose present shape can only be learned by reading N steps in order
 * is a schema nobody reviews. With no connection the DDL is rendered from a
 * freshly migrated in-memory database, which is the definition: the schema is
 * whatever the steps produce from nothing.
 */
export function renderCurrentSchema(connection?: SqliteDatabase): string {
  let scratch: SqliteDatabase | undefined;
  let source: SqliteDatabase;
  if (connection === undefined) {
    scratch = openControlPlaneConnection(":memory:", { fileMustExist: false });
    source = migrateControlPlane(scratch, { nowMs: 0 });
  } else {
    source = connection;
  }

  let rows: { type: string; name: string; sql: string }[];
  let head: number;
  try {
    rows = source
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { type: string; name: string; sql: string }[];
    head = source.pragma("user_version", { simple: true }) as number;
  } finally {
    if (scratch !== undefined) {
      scratch.close();
    }
  }

  // Tables before the indices and triggers that reference them, so the file
  // reads top-down the way the steps do; within a kind, by name, so a diff
  // between two generated files shows only what actually changed.
  const order: Record<string, number> = { table: 0, view: 1, index: 2, trigger: 3 };
  const rank = (type: string): number => order[type] ?? 9;
  // A stable sort, matching Python's: ties keep sqlite_master order.
  rows.sort(
    (a, b) => rank(a.type) - rank(b.type) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  const header =
    "-- ==========================================================================\n" +
    "--  GENERATED FILE -- DO NOT EDIT, AND DO NOT APPLY.\n" +
    "--\n" +
    "--  Emitted by control_plane/migrator.ts renderCurrentSchema() from an empty\n" +
    "--  database migrated to head. It is a READING AID: the production schema is\n" +
    "--  the numbered, forward-only steps in\n" +
    "--  src/control_plane/migrations/, and they are the only\n" +
    "--  thing that is ever applied to a database (D-0029,\n" +
    "--  docs/production-schema.md section 3.1).\n" +
    "--\n" +
    "--  Editing this file changes no database. Running it produces a database\n" +
    "--  with no schema_migration ledger, which every opener here refuses.\n" +
    "--  A schema change is a new step file; this file is regenerated from it.\n" +
    `--\n--  schema_migration head: ${head}\n` +
    "-- ==========================================================================\n";
  const body = rows.map((row) => `${row.sql.trim()};`).join("\n");
  return `${header}\n${body}\n`;
}

// --------------------------------------------------------------------------
// small shared pieces
// --------------------------------------------------------------------------

/**
 * Reject a clock value that is not an integer count of milliseconds.
 *
 * `boolean` is rejected explicitly. Python excludes it because `bool` is an
 * `int` there and `applied_at_ms = True` would store 1 -- a timestamp in 1970
 * that the `typeof` CHECK cannot catch, since SQLite sees a perfectly good
 * integer. TypeScript's type system would reject a `boolean` at compile time,
 * but the check is kept because the guard exists for callers that reach this
 * function from untyped JavaScript, where the same value arrives the same way.
 */
function requireEpochMs(nowMs: number): void {
  if (typeof nowMs !== "number" || !Number.isInteger(nowMs)) {
    throw new TypeError(
      `nowMs must be an int of epoch milliseconds, got ${describeType(nowMs)}; ` +
        `the clock is the caller's and is never read from the database`,
    );
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** An error's message, for interpolation into a refusal. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Render one pragma row the way Python renders a `sqlite3.Row` tuple.
 *
 * The refusal messages interpolate raw rows, so the rendering is part of the
 * operator-facing text that ported cases match against. One renderer rather than
 * an inline join at each site, so the two messages that carry rows cannot drift
 * into rendering the same row two different ways.
 */
function renderRow(row: unknown): string {
  if (row === null || typeof row !== "object") {
    return String(row);
  }
  const values = Object.values(row as Record<string, unknown>);
  return `(${values.map((value) => (typeof value === "string" ? `'${value}'` : String(value))).join(", ")})`;
}

function renderRows(rows: readonly unknown[]): string {
  return `[${rows.map(renderRow).join(", ")}]`;
}
