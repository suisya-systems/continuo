import { statSync } from "node:fs";

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";

import {
  discoverMigrationSteps,
  headVersion,
  verifyProductionDatabase,
} from "../control_plane/migrator.js";
import {
  ControlPlaneRefusal,
  CorruptStateRefused,
  MissingStateRefused,
} from "../control_plane/refusals.js";
import { isSqliteError } from "../sqlite/errors.js";

/**
 * G6 -- the measurement harness's only door into the control plane: read-only
 * by capability.
 *
 * The failure this module is written against is on the record in interlock's
 * v1 `tools/org_metrics_report.py`. That tool's header says the ordinary
 * connect helper applies `journal_mode=WAL` and "would happily run forward
 * migrations", so the one program in the system that must never write -- the
 * report -- promoted the journal mode of the database it was reporting on and
 * could migrate it as a side effect of being pointed at it. Nothing in the tool
 * was wrong; it called the helper everything else called. Read-only was a
 * property of how the tool was *written*, and a property of how something is
 * written is lost the first time someone edits it.
 *
 * Interlock's `ACCEPTANCE.md` section 3 condition 5 therefore requires the
 * shadow path to be read-only **enforced by capability, not by convention**,
 * and `docs/measurement-harness.md` section 1 names the two enforcements. In
 * the Python lineage those are the SQLite `mode=ro` URI **and** `PRAGMA
 * query_only = ON`; better-sqlite3 does not accept URI filenames, so continuo's
 * first mechanism is the `readonly` open flag -- the same `SQLITE_OPEN_READONLY`
 * the URI asked for, reached through the driver's own argument. `D-0100`
 * records that substitution and the measurements behind it. Interlock `D-0040`
 * records the pair as decided. This module is the only place the harness opens
 * a database, and it makes three properties structural rather than documented:
 *
 * **Both mechanisms are verified in force before a row is read.** An unverified
 * claim of read-only is precisely the failure above -- an open flag silently
 * degrading to read-write because a call was built wrong, or a `PRAGMA` that
 * was issued and did not take, reads exactly like a harness that is behaving.
 * So `query_only` is read back, and the file's own access mode is proved
 * behaviourally -- by offering the file a write it must refuse, with
 * `query_only` momentarily off so that the connection-level guard cannot answer
 * in the file's place (see {@link proveReadOnly}, public so that a caller
 * holding a live connection evidences the capability off *that* connection
 * rather than off a second copy of this probe). Two independent mechanisms mean
 * neither one's failure is load-bearing, which is only true if each is
 * *checked*.
 *
 * **Identity, version and checksum verification is the migrator's, not a second
 * copy.** A spike database, a database behind this build, one ahead of it, and
 * one whose applied step bytes have changed are all refused here with the
 * migrator's own typed refusals, because the harness calls
 * {@link verifyProductionDatabase} rather than re-deriving the rules. A second
 * implementation of "is this our database" is a second thing to keep in step
 * with `docs/production-schema.md` section 3, and the one that drifts is always
 * the one nobody is looking at.
 *
 * **The harness cannot simply call `openProductionControlPlane`: that function
 * returns a WRITABLE connection.** It never migrates -- that separation is
 * exactly what makes this module possible -- but it hands back an ordinary
 * read-write handle, and a read-write handle in the instrument is the v1
 * posture again: safe only for as long as nobody writes through it. So the
 * verification is shared and the connection is not.
 *
 * **Nothing here migrates and nothing here takes a lease.** Structurally, not
 * by promise: this module imports no writer -- not `migrateControlPlane`, not
 * `createProductionControlPlane`, not `openProductionControlPlane` -- and the
 * connection it returns cannot execute one. The harness holds no lease and no
 * writer epoch, so there is no fenced write for a bug here to produce.
 * `test/measurement/reader.test.ts` asserts the absence of those imports as a
 * static property, because an import added later would restore the capability
 * without changing a line of this comment.
 *
 * **A report is measured over one state of the database, held open.**
 * `measurement-harness.md` section 6 gives `db_fingerprint` its job: two reports
 * over "the same" database are provably over the same content. An autocommit
 * connection cannot make that claim, because every statement of a report is its
 * own SQLite snapshot -- a writer committing between the cohort selection, the
 * AC-9 aggregation and the fingerprint leaves a header attesting a database
 * state that never produced the figures, and a numerator and a denominator that
 * came from two. {@link measurementSnapshot} is the mechanism: a read
 * transaction the whole report, fingerprint included, is built inside. Its cost
 * is stated there and is not free -- see that comment before pointing a report
 * at a live control plane.
 *
 * No clock is read here. The harness's periods are the caller's half-open
 * `[start, end)` bounds and this module has no timestamp of its own to supply
 * -- opening a database is not an event, and nothing about it is recorded.
 */

export {
  ControlPlaneRefusal,
  CorruptStateRefused,
  DatabaseAheadOfCodeRefused,
  MigrationChecksumRefused,
  MissingStateRefused,
} from "../control_plane/refusals.js";

/**
 * A connection meant to be incapable of writing turned out to be capable of it.
 *
 * Its own refusal class rather than {@link CorruptStateRefused} because the
 * fault is in **this process**, not in the file: the database may be perfectly
 * healthy and the harness still has no business reading it through a handle
 * that could write. The operator's next move is different too -- a corrupt
 * database is restored, a harness that lost its read-only capability is stopped
 * before it observes anything, because every figure it would go on to produce
 * came off a connection that could have changed the thing it was measuring.
 */
export class ReadOnlyCapabilityRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ReadOnlyCapabilityRefused";
    Object.setPrototypeOf(this, ReadOnlyCapabilityRefused.prototype);
  }
}

/**
 * A report snapshot was asked for on a connection that already holds one.
 *
 * Nesting cannot do the thing the caller means. SQLite has no nested
 * transaction, so the inner `BEGIN` fails outright, and an inner scope that
 * "succeeded" by doing nothing would end the *outer* snapshot at its own exit
 * -- releasing the read lock in the middle of the report that was relying on
 * it, with no signal at all. So the second request is a refusal with a message,
 * rather than a scope that reads as if it had worked.
 */
export class NestedSnapshotRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "NestedSnapshotRefused";
    Object.setPrototypeOf(this, NestedSnapshotRefused.prototype);
  }
}

/**
 * A report snapshot was handed a callback that had not finished when it
 * returned.
 *
 * This refusal has no counterpart in interlock, and it exists because of the
 * one shape the translation changed. Interlock's `measurement_snapshot` is a
 * `@contextmanager` used with `with`, and a `with` block cannot "return early
 * and carry on later" -- the scope ends when the body ends, full stop. The
 * TypeScript form is a callback, and a callback CAN: an `async` body returns a
 * pending Promise the moment it first awaits, at which point this function's
 * `finally` would roll the snapshot back and every read after the await would
 * run on its own separate state of the database. That is silently the exact
 * defect the snapshot exists to remove, arriving through the mechanism meant to
 * remove it, with no error anywhere.
 *
 * So a thenable result is refused rather than awaited. Awaiting it would make
 * the whole function async and hold a SHARED lock -- which blocks every writer
 * on the control plane -- across an arbitrary suspension, which is a worse
 * thing to do than refuse. Nothing in the harness is asynchronous: better-
 * sqlite3 is a synchronous driver and every read in a report is a synchronous
 * call, so this refuses a shape the harness has no reason to produce.
 *
 * The callback type also rejects a Promise-returning body at compile time; this
 * class is the runtime half, for callers who are not type-checked.
 */
export class AsynchronousReportRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "AsynchronousReportRefused";
    Object.setPrototypeOf(this, AsynchronousReportRefused.prototype);
  }
}

/**
 * The savepoint the read-only probe uses when it runs inside an open snapshot.
 *
 * A fixed, unmistakable name: it appears only in {@link proveReadOnly}, and a
 * generic one ("probe") could collide with a savepoint a caller had opened.
 */
const PROBE_SAVEPOINT = "measurement_read_only_probe";

/**
 * The module's replaceable internals (DECISIONS.md `D-0014`).
 *
 * Two source cases reach into this module with `monkeypatch.setattr`: one
 * replaces `sqlite3.connect` so the opener builds a connection *without* the
 * read-only capability, and one spies on `prove_read_only` to assert
 * `open_for_measurement` goes through the public probe rather than through a
 * private second copy of it. ESM bindings cannot be rebound from outside, so
 * both call sites go through this record and the tests replace entries on it.
 *
 * Not re-exported from `src/index.ts`: it is a seam for the tests that own this
 * module, not public API.
 */
export const readerSeams = {
  /** @see openReadOnlyImpl */
  openReadOnly: openReadOnlyImpl,
  /** @see proveReadOnly */
  proveReadOnly,
};

/**
 * Open `target` with the first read-only mechanism in force.
 *
 * The seam the degraded-capability cases replace. Interlock builds a
 * `file:...?mode=ro` URI from the **resolved** path, because a relative path in
 * a SQLite URI is resolved against the process's working directory and would
 * silently name a different file. better-sqlite3 does not enable
 * `SQLITE_OPEN_URI`, so there is no URI to build wrong here and no resolution
 * step to get wrong: the flag is passed as an argument and the path is handed
 * to the driver as given (`D-0100`).
 */
function openReadOnlyImpl(target: string): SqliteDatabase {
  return new Database(target, { readonly: true, fileMustExist: true });
}

/**
 * How a refusal from this module names the database it is about.
 *
 * `undefined` is a real case: a caller can hold a verified connection and no
 * longer have the path in hand, and a message reading "the connection to
 * undefined" would send an operator looking for a file called undefined.
 */
function names(target: string | undefined): string {
  return target !== undefined
    ? `the measurement connection to ${target}`
    : "the measurement connection";
}

/**
 * Read `PRAGMA query_only` back and refuse anything but `1`.
 *
 * Issuing a pragma is not the same as it taking effect: an unrecognised pragma
 * name is a silent no-op in SQLite, so a typo -- `query_ony`, `read_only` --
 * produces a connection that reports nothing wrong and writes happily. The
 * read-back is what converts that class of mistake from invisible into a
 * refusal at open time.
 *
 * Exported because a source case calls it directly, to show that "issued" and
 * "in force" are separated by this read-back and by nothing else. Interlock's
 * is module-private and reached as `reader._require_query_only`; TypeScript has
 * no equivalent reach, so the name is exported and marked here instead
 * (`D-0101`).
 *
 * @internal
 */
export function requireQueryOnly(
  target: string | undefined,
  connection: SqliteDatabase,
  when: string,
): void {
  const value = connection.pragma("query_only", { simple: true });
  if (value !== 1) {
    throw new ReadOnlyCapabilityRefused(
      `PRAGMA query_only reads back as ${JSON.stringify(value)} ${when} on ` +
        `${names(target)}; the harness is read-only by capability ` +
        `(ACCEPTANCE.md section 3 condition 5) and will not observe through a ` +
        `handle whose guard is not in force`,
    );
  }
}

/**
 * Hold `connection` on one state of the database for the whole of a report.
 *
 * Interlock's is a `@contextmanager` used with `with`. TypeScript has no such
 * statement, so the scope is expressed as a callback: `body` runs inside the
 * snapshot and the snapshot is released on the way out, including when `body`
 * throws. The property the source cases assert -- the lock is held for the
 * body, released after it, and released on failure -- is the same, and a
 * callback cannot be left un-exited the way a hand-written begin/end pair can.
 *
 * **What this is for.** {@link openForMeasurement} returns an autocommit
 * connection, and on an autocommit connection every statement is its own SQLite
 * snapshot. A report is many statements -- select the cohort, aggregate AC-9,
 * then fingerprint the tables read -- so on a live control plane a writer can
 * commit *between* them. The result is not a slightly stale report: it is a
 * report whose `db_fingerprint` attests a state that never produced its
 * figures, which is the exact claim `measurement-harness.md` section 6 creates
 * the field to make. A numerator and a denominator can likewise come off two
 * different states. Holding one read transaction across the whole report,
 * fingerprint included, is what makes the header's claim true.
 *
 * **What it costs, and who pays it.** The production databases here are **not
 * in WAL** -- `createProductionControlPlane` leaves the rollback journal in
 * place (`D-0012`) -- so this read transaction holds a SHARED lock, and a
 * SHARED lock **blocks every writer on the control plane for as long as the
 * report runs**: the watcher, the dispatcher and the CI ingest all get
 * `database is locked`. That is a real operational cost and it is stated here
 * rather than discovered in production. It is bounded by the report's duration
 * and released on the way out, including when the report raises. A report over
 * a large period on a busy control plane should be run against a copy or at a
 * quiet moment; the alternative -- an unlocked report -- is the incoherent one
 * this scope exists to remove, not a cheaper version of the same thing.
 *
 * **The lock is taken here, not at the first read.** SQLite's `BEGIN` is
 * `DEFERRED`: it acquires nothing until a statement actually reads, so a
 * `BEGIN` alone leaves exactly the moving database this guards against, up
 * until whatever the report happens to read first. The scope therefore issues a
 * read of its own to materialise the snapshot before calling `body`.
 *
 * **The connection stays incapable of writing inside the scope.** A transaction
 * is the shape a write arrives in, so `query_only` is read back before the
 * snapshot opens and again once it is held: a fix for the moving database
 * bought with the read-only capability would be no fix at all. The open flag is
 * unaffected -- it is a property of the open file handle -- and
 * {@link proveReadOnly} still evidences it from inside the scope.
 *
 * The transaction is ended with `ROLLBACK` rather than `COMMIT`. Nothing was
 * written, so the two are the same to the file; `ROLLBACK` is the one that
 * stays true if that ever stops being the case.
 *
 * `target` names the database in refusal messages only; it is not used to open
 * anything.
 *
 * @throws {NestedSnapshotRefused} if `connection` is already in a transaction.
 * @throws {ReadOnlyCapabilityRefused} if `PRAGMA query_only` is not in force on
 *   `connection`, before or inside the snapshot.
 */
export function measurementSnapshot<T>(
  connection: SqliteDatabase,
  options: { readonly target?: string },
  // `T extends PromiseLike<unknown> ? never : unknown` collapses the required
  // return type to `never` for an async body, so the call site is a compile
  // error rather than a report that silently spans two database states. See
  // {@link AsynchronousReportRefused} for why, and for the runtime half.
  body: (connection: SqliteDatabase) => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
  const target = options.target;

  if (connection.inTransaction) {
    throw new NestedSnapshotRefused(
      `${names(target)} is already inside a transaction; a report snapshot ` +
        `cannot nest (SQLite has no nested transaction, and an inner scope's ` +
        `exit would release the outer report's read lock mid-report). The ` +
        `report opens its own snapshot -- build it once, inside one scope`,
    );
  }
  requireQueryOnly(target, connection, "before the report snapshot opens");
  connection.exec("BEGIN");
  try {
    // Materialise the snapshot: BEGIN is DEFERRED and takes no SHARED lock
    // until something reads, so without this the database is still free to move
    // under everything up to the report's first query.
    connection.prepare("SELECT count(*) FROM sqlite_master").get();
    requireQueryOnly(target, connection, "inside the report snapshot");
    const result = body(connection);
    // Checked inside the try, so the `finally` below still releases the
    // snapshot: refusing must not also leak the lock it is refusing to hold.
    if (isThenable(result)) {
      throw new AsynchronousReportRefused(
        `${names(target)} was given an asynchronous report body. A report ` +
          `snapshot is one synchronous scope: an async body returns at its ` +
          `first await, the snapshot would be released there, and every read ` +
          `after it would run on a different state of the database -- which is ` +
          `the defect the snapshot exists to remove. Nothing in the harness is ` +
          `asynchronous (better-sqlite3 is a synchronous driver); build the ` +
          `report synchronously inside the scope`,
      );
    }
    return result;
  } finally {
    // In a finally because a snapshot left open by a failed report would go on
    // blocking every writer on the control plane for the life of the process.
    if (connection.inTransaction) {
      connection.exec("ROLLBACK");
    }
  }
}

/**
 * Open `path` for measurement: verified, read-only by capability, never
 * migrated.
 *
 * The returned connection is the only handle the G6 harness gets. It is opened
 * with the `readonly` flag and `PRAGMA query_only = ON`, and **both** are
 * proved in force before the first row is read -- `ACCEPTANCE.md` section 3
 * condition 5 asks for a capability, and an unverified capability is a
 * convention with a longer comment.
 *
 * The database is then held to exactly the standard
 * {@link openProductionControlPlane} holds it to, by calling the same verifier:
 * integrity, the production `application_id`, a contiguous ledger,
 * `user_version` agreeing with it, every applied step still hashing to its
 * recorded checksum, and no dangling foreign key. A database at any version
 * other than this build's head is refused rather than read -- the report's
 * provenance header names the `schema_migration` head, and a header naming a
 * version whose column meanings this build does not have is worse than no
 * header.
 *
 * `migrationsDir` exists so the discipline can be tested against a scratch
 * ledger, exactly as in the migrator; production never points it elsewhere.
 *
 * @throws {MissingStateRefused} if there is no file at `path`. An absent
 *   database is not an empty one, and a report over an empty one is a report of
 *   zero incidents.
 * @throws {CorruptStateRefused} for a file that is not SQLite, a failed
 *   `integrity_check`, a spike or foreign `application_id`, an absent or
 *   non-contiguous ledger, or a `user_version` disagreeing with it.
 * @throws {MigrationChecksumRefused} if an applied step's bytes have changed.
 * @throws {DatabaseAheadOfCodeRefused} if the database is ahead of this build.
 * @throws {ControlPlaneRefusal} if the database is *behind* this build. The
 *   harness never migrates, so it also never reads a stale database as though
 *   it were current.
 * @throws {ReadOnlyCapabilityRefused} if either read-only mechanism is not in
 *   force on the connection this function just opened, **or** if the probe that
 *   proves the open flag could not reach an answer -- most often because
 *   another writer held the database and the probe's write came back `database
 *   is locked`. An unproved capability is refused on the same terms as an
 *   absent one; the message distinguishes which happened.
 */
export function openForMeasurement(
  path: string,
  options: { readonly migrationsDir?: string } = {},
): SqliteDatabase {
  const target = path;
  const steps = discoverMigrationSteps(options.migrationsDir);

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(target);
  } catch {
    throw new MissingStateRefused(
      `${target} does not exist; the measurement harness refuses to open it ` +
        `(an absent database is not an empty one, and measuring an empty one ` +
        `reports zero of everything as though it were an observation)`,
    );
  }
  if (!stats.isFile()) {
    throw new CorruptStateRefused(`${target} is not a regular file`);
  }

  let connection: SqliteDatabase;
  try {
    connection = readerSeams.openReadOnly(target);
  } catch (error) {
    throw new CorruptStateRefused(`${target} could not be opened: ${String(error)}`, {
      cause: error,
    });
  }

  try {
    let applied: readonly { readonly version: number }[];
    // Both halves are wrapped for the reason the migrator wraps its own
    // verification: "file is not a database", a truncated header or a bad page
    // read while answering a pragma all arrive as errors carrying a SQLITE_
    // code, and every one of them is a refusal rather than an empty start. The
    // capability proof is inside the wrapper because it reads a pragma too, and
    // a corrupt file must be refused as corrupt rather than escape as a raw
    // driver error from the harness's first line.
    //
    // Only a driver error is translated. Interlock catches `sqlite3.DatabaseError`,
    // which the refusal family does not descend from, so a refusal raised
    // inside -- the migrator's own typed ones above all -- passes straight
    // through and keeps the diagnosis the operator needs.
    try {
      armAndVerifyBothMechanisms(target, connection);
      applied = verifyProductionDatabase(target, connection, steps, { requireLedger: true });
    } catch (error) {
      if (isSqliteError(error)) {
        throw new CorruptStateRefused(`${target} is not a readable database: ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }

    const current = applied.length > 0 ? Number(applied[applied.length - 1]?.version) : 0;
    const head = headVersion(steps);
    if (current !== head) {
      // Ahead is already refused inside the verifier, by name; reaching here
      // means behind. The harness has no migrate call to offer -- it holds a
      // connection that cannot write -- so the refusal points at the operator's
      // separate, deliberate step.
      throw new ControlPlaneRefusal(
        `${target} is at version ${current} and this build knows steps up to ` +
          `${head}; the measurement harness never migrates and never reads a ` +
          `database at a version whose columns it does not know. Migrate it ` +
          `deliberately with migrateControlPlane and point the harness at it again`,
      );
    }
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

// --------------------------------------------------------------------------
// proving the two mechanisms, rather than asserting them
// --------------------------------------------------------------------------

/**
 * Put both mechanisms in force and read both back, or refuse.
 *
 * Private because it *arms* the connection it is given, which is only ever
 * correct on a connection this module just opened; a caller holding someone
 * else's live connection wants {@link proveReadOnly}, which only asks.
 *
 * The order matters: `query_only` is established and confirmed *first*, so that
 * the file-mode probe below -- which has to lower `query_only` to ask its
 * question -- is the only moment in this connection's life when the
 * connection-level guard is down, and it is restored and re-read before the
 * function returns.
 */
function armAndVerifyBothMechanisms(target: string, connection: SqliteDatabase): void {
  connection.pragma("query_only = ON");
  requireQueryOnly(target, connection, "immediately after setting it");
  readerSeams.proveReadOnly(connection, target);
  // Re-read after the probe: the probe is the one thing in this module that
  // turns the guard off, so it is also the one thing that could leave it off.
  requireQueryOnly(target, connection, "after the file-mode probe");
}

/**
 * Evidence, off `connection` itself, that the file behind it refuses writes.
 *
 * Public and taking the connection first because this is the only correct
 * answer to "was **this** handle opened read-only?", and more than one caller
 * needs it. {@link openForMeasurement} proves the capability for the connection
 * it opens; `ACCEPTANCE.md` section 3 condition 5 asks for the evidence to come
 * off the **live** connection the figures are measured through, which for a
 * report already holding a connection is a different object. A second copy of
 * the probe would agree with this one until one of the three subtleties below
 * was fixed in one place only -- and the copy that drifts is the one certifying
 * a writable handle as read-only. So there is one implementation and this is
 * it.
 *
 * Returning normally is the evidence: the file refused a write **as
 * read-only**. Every other outcome throws {@link ReadOnlyCapabilityRefused}.
 *
 * There is no pragma that reports the access mode a database was opened with,
 * and better-sqlite3 exposes no `sqlite3_db_readonly()`, so the only honest
 * read-back is behavioural: attempt the thing the read-only open flag is
 * supposed to make impossible. `query_only` is lowered for the duration
 * precisely because leaving it up would answer the wrong question -- the
 * attempt would be refused by the connection-level guard and say nothing about
 * the file, which is how a harness that has silently lost one of its two
 * mechanisms goes on reporting that it has both.
 *
 * The probe is **`PRAGMA user_version` set to the value it already holds,
 * inside an explicit transaction that is always rolled back**, and all three of
 * those clauses are load-bearing:
 *
 * - a *pragma* rather than a statement against a table, because the probe runs
 *   before verification -- the file may be a spike database, a foreign one, or
 *   not a database at all, and a missing table would come back as an error too,
 *   which the probe would read as "read-only" and the harness would then trust
 *   a writable connection;
 * - *the value it already holds*, so that the only path where the write can
 *   land is a path where it changes nothing;
 * - *rolled back*, so that on a writable file -- the case this whole function
 *   exists to catch -- the page is restored and the file is left byte-identical
 *   with no journal surviving. `test/measurement/reader.test.ts` hashes the file
 *   across exactly that refusal.
 *
 * `BEGIN IMMEDIATE` alone is **not** a usable probe and was tried first in the
 * Python lineage: it succeeds against a read-only connection (the write lock is
 * not taken until a page is dirtied), so it reports every read-only database as
 * writable.
 *
 * A refused write is only proof when the refusal **names read-only**. The
 * earlier version of this probe accepted any operational error as "the file
 * refused it", and a writable connection whose write is blocked by another
 * writer's RESERVED lock fails with `SQLITE_BUSY` -- the ordinary state of a
 * control plane with a watcher or dispatcher mid-transaction. That reading
 * turned a live control plane into a way of certifying a read-write handle as
 * read-only, which is this module's own stated failure (a promise in place of a
 * mechanism) reappearing inside the mechanism. An inconclusive probe is not a
 * proof, so anything but a read-only error is a refusal now -- see
 * {@link theErrorSaysTheDatabaseIsReadOnly}.
 *
 * **An inconclusive probe is a refusal, not a pass**, and that distinction is
 * the whole defect this probe was rewritten to fix. "The capability could not
 * be proved" and "the capability was absent" are two different facts: the
 * refusal for contention says *inconclusive* and never says the database was
 * writable, because an operator sent after the wrong one goes and fixes an open
 * call that was never broken. Neither fact is a reason to go on measuring.
 *
 * The connection is left with `query_only = ON` however this returns -- the
 * probe lowers the guard for exactly one statement and restores it in a
 * `finally`, so a caller that hands over an armed connection gets it back
 * armed.
 *
 * @throws {ReadOnlyCapabilityRefused} if the write was accepted (the file is
 *   not read-only), or if it was refused by something other than SQLite's
 *   read-only error, which proves nothing either way.
 */
export function proveReadOnly(connection: SqliteDatabase, target: string | undefined): void {
  const userVersion = connection.pragma("user_version", { simple: true }) as number;
  // A report holds its snapshot open ({@link measurementSnapshot}) and this
  // probe is exactly the kind of thing a caller runs on that live connection,
  // so the probe has to work inside a transaction as well as outside one. A
  // second BEGIN there is "cannot start a transaction within a transaction" --
  // an error that does not name read-only, which this function would then
  // report as an *inconclusive* probe and stop the report over. SAVEPOINT is
  // the form that nests, so it is the form used when one is open.
  const insideSnapshot = connection.inTransaction;
  connection.pragma("query_only = OFF");
  try {
    if (insideSnapshot) {
      connection.exec(`SAVEPOINT ${PROBE_SAVEPOINT}`);
    } else {
      connection.exec("BEGIN");
    }
    let accepted = false;
    try {
      connection.exec(`PRAGMA user_version = ${Number(userVersion)}`);
      accepted = true;
    } catch (error) {
      if (theErrorSaysTheDatabaseIsReadOnly(error)) {
        // The file refused the write *as read-only*: the read-only open flag is
        // in force, which is the answer this function came for.
        return;
      }
      // Anything else -- "database is locked" above all -- leaves the question
      // unanswered, and the refusal must say so rather than report the database
      // as writable: "the capability could not be proved" and "the capability
      // was absent" are different facts, and an operator sent after the wrong
      // one fixes the wrong thing.
      throw new ReadOnlyCapabilityRefused(
        `the read-only probe on the measurement connection to ${target} was ` +
          `inconclusive: the write was refused with ${describeError(error)}, ` +
          `which does not identify a read-only database, so it does not prove ` +
          `the read-only open flag is in force (a writable connection blocked ` +
          `by another writer's lock fails the same way). This is not a report ` +
          `that the database was writable -- it is a report that the harness ` +
          `could not tell. Retry when no writer holds the database, and if the ` +
          `error persists it is not contention (D-0100, interlock D-0040, ` +
          `ACCEPTANCE.md section 3 condition 5)`,
        { cause: error },
      );
    } finally {
      undoTheProbe(connection, insideSnapshot);
    }
    if (accepted) {
      throw new ReadOnlyCapabilityRefused(
        `the measurement connection to ${target} accepted a write with ` +
          `query_only lowered, so it was not opened read-only -- the open call ` +
          `did not carry the capability it claims. The write was its own ` +
          `current user_version and was rolled back, so the file is unchanged; ` +
          `the harness stops here rather than reading, because a report is only ` +
          `evidence if the instrument could not have changed the thing it ` +
          `measured (D-0100, interlock D-0040)`,
      );
    }
  } finally {
    connection.pragma("query_only = ON");
  }
}

/**
 * Discard whatever the probe's write did, and nothing else.
 *
 * Inside a report snapshot the outer transaction must survive: rolling back to
 * the savepoint undoes the probe's page and leaves the report's read lock and
 * its state exactly where they were, whereas a bare `ROLLBACK` would end the
 * report's snapshot as a side effect of checking that it was read-only. The
 * savepoint is released after the rollback so the name does not accumulate on a
 * connection that probes more than once.
 */
function undoTheProbe(connection: SqliteDatabase, insideSnapshot: boolean): void {
  if (insideSnapshot) {
    connection.exec(`ROLLBACK TO ${PROBE_SAVEPOINT}`);
    connection.exec(`RELEASE ${PROBE_SAVEPOINT}`);
  } else if (connection.inTransaction) {
    connection.exec("ROLLBACK");
  }
}

/**
 * Is `error` SQLite saying "read-only database", as opposed to anything else?
 *
 * The mechanism is the result code, because it is what SQLite actually decided;
 * the message is a rendering of it that has changed wording across releases.
 * Interlock reaches the same verdict through a string match, because
 * `sqlite3.Error.sqlite3_errorcode` exists only on Python 3.11+ and interlock's
 * build runs 3.10 -- its code branch is the one it documents as taking over
 * silently when the interpreter is upgraded. better-sqlite3 puts the code on
 * every error it raises, so continuo lands on that branch always, and there is
 * no string fallback to keep in step (`D-0102`).
 *
 * `SQLITE_READONLY` is matched by prefix, because SQLite's extended codes
 * (`SQLITE_READONLY_DBMOVED` and friends) are the same primary result code and
 * the same answer to this question. Nothing else is matched: the whole defect
 * this replaces came from treating an unrecognised refusal as a proof, so an
 * unrecognised code must fall through as false and be refused by the caller.
 *
 * Exported because a source case drives it with errors SQLite actually raised
 * -- one read-only, one busy -- rather than with strings pasted into the test.
 * Interlock's is module-private and reached as
 * `reader._the_error_says_the_database_is_read_only` (`D-0101`).
 *
 * @internal
 */
export function theErrorSaysTheDatabaseIsReadOnly(error: unknown): boolean {
  return isSqliteError(error) && error.code.startsWith("SQLITE_READONLY");
}

/** An error rendered for a refusal message, the way Python's `repr` renders one. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = isSqliteError(error) ? `${error.code}: ` : "";
    return `${error.name}(${JSON.stringify(`${code}${error.message}`)})`;
  }
  return JSON.stringify(String(error));
}

/**
 * Is `value` a thenable?
 *
 * Structural rather than `instanceof Promise`: a body may return a Promise from
 * another realm or a userland thenable, and both suspend exactly the same way.
 */
function isThenable(value: unknown): boolean {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { then?: unknown }).then === "function"
    : false;
}
