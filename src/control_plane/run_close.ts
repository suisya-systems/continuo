import type { Database as SqliteDatabase } from "better-sqlite3";

import { type Lease, LeaseRefusal, release } from "./lease.js";
import { pythonList, pythonRepr } from "./python_repr.js";
import { ControlPlaneRefusal } from "./refusals.js";
import {
  acquireRunLease,
  advanceRunStatus,
  RUN_STATUSES,
  type RunRecord,
  type RunStatus,
  readRun,
  TERMINAL_RUN_STATUSES,
} from "./run_lifecycle.js";

/**
 * The operator's close of a run (`D-0084`), and the whole of step 11's control
 * plane.
 *
 * `docs/design/minimal-operating-loop.md` section 2 ends the lap at L8: the
 * merge is observed and the run reaches a terminal status. Section 6.2 says how
 * that is meant to be built -- a watcher appends `pr_merged` and a **consumer**
 * makes the transition, because collapsing the two once wrote a foreign PR's
 * metadata onto a run row (`docs/production-schema.md` section 7.1). Lap 1 has
 * neither half: there is no watcher, and `D-0077` defers the privileged
 * publisher to lap 2. So the gate closes `answered_and_forwarded` and the run
 * row stays at `created` forever, which is the defect `docs/operations/lap-1-dogfood.md`
 * records as F-7 and issue #125 states.
 *
 * This module is the answer `D-0084` takes, and what it deliberately is not is
 * as load-bearing as what it is.
 *
 * - **It records a close; it does not perform one.** Push, PR and merge stay the
 *   operator's manual leg. Nothing here talks to git or to GitHub, and nothing
 *   here checks that a merge happened: the operator observed it, and this verb
 *   is where they write that observation down.
 * - **It is the consumer half, standing in for a producer that does not exist
 *   yet.** For lap 1 the operator IS the observer, so the observe/transition
 *   split of section 6.2 is collapsed into one verb. That is a deliberate
 *   collapse to be undone (`D-0084`), not a disagreement with the split: when a
 *   real `pr_merged` producer arrives, its consumer transitions a run under the
 *   same rules this module states, and this verb stays what it is -- the
 *   operator's own close, for the runs no publisher observed.
 * - **It appends no event.** There is no provider fact to append: a `pr_merged`
 *   composed here would be an unverified claim about a repository nothing read,
 *   written onto the spine as an observation, which is exactly the class of
 *   fault section 7.1 records. And an event of its own could not be atomic with
 *   the transition anyway -- {@link advanceRunStatus} goes through
 *   `protectedWrite`, which owns its `BEGIN IMMEDIATE` and refuses to run inside
 *   another transaction, so a second write here would be a second commit. What
 *   records the close is the `run` row itself: `status`, `updated_at_ms`, and
 *   `writer_epoch` naming the lease this module took under the operator's own
 *   identity.
 * - **It does not read the gate.** Closing a run whose gate is still open is
 *   already adjudicated, one layer over: `sweepSubjectGone` (`gates.ts`) closes
 *   every open gate whose subject run reached a terminal status, which is what
 *   `gate reconcile` runs. A gate check here would be a second, weaker copy of
 *   that rule, and the two would eventually disagree about one database.
 *
 * **ASCII only** in every message, for the reason `docs/cli-output-policy.md`
 * gives: a refusal from here is printed by `run_cli.ts` on a console that may be
 * cp932, where a character it cannot encode is a crash rather than a smudge.
 */

// --------------------------------------------------------------------------
// the transition set
// --------------------------------------------------------------------------

/**
 * The statuses a run may be closed **from**: the vocabulary minus the terminal
 * set.
 *
 * Derived rather than written down, so it cannot drift from either of the two
 * sets it is a difference of. `created` is in it, and that is the case lap 1
 * actually has: no verb moves a run to `running`, so every run the dogfood
 * produced is closed straight out of `created`. The rank lattice
 * `run_status_is_forward_only` enforces admits that step already -- `created`
 * ranks below every terminal word -- so this is not a hole opened here, it is
 * the existing rule read out loud (`D-0084`).
 */
export const CLOSEABLE_RUN_STATUSES: readonly RunStatus[] = Object.freeze(
  RUN_STATUSES.filter(
    (status) => !(TERMINAL_RUN_STATUSES as readonly string[]).includes(status),
  ) as RunStatus[],
);

/**
 * The statuses a run may be closed **to**, which is the terminal set entire.
 *
 * All three, and none of them is a default: which terminal status a run reached
 * is a fact about the work, and a verb that guessed `completed` would write a
 * fact nobody stated. `run close` therefore requires the outcome, the same way
 * `gate close` requires one (`D-0079`'s reasoning about a tolerance being data
 * rather than a number invented in code applies to an outcome word too).
 *
 * An alias of {@link TERMINAL_RUN_STATUSES} rather than a fourth declaration of
 * those three words: the close's target set and the absorbing set are the same
 * set, and stating them separately would be two things to keep in step for no
 * gain.
 */
export const RUN_CLOSE_OUTCOMES = TERMINAL_RUN_STATUSES;

/**
 * The TTL the run lease is taken for.
 *
 * Sized like the delivery lease `gate deliver` takes (`DELIVERY_LEASE_TTL_MS`),
 * and for the same reason: it has to cover one command's own write on a slow
 * disk and nothing more. The lease is given back before this verb returns, so
 * the TTL is what an interrupted close costs the next attempt, not how long a
 * closed run stays claimed.
 */
export const RUN_CLOSE_LEASE_TTL_MS = 60_000;

/** What may be printed back into a one-line report. See {@link closeRun}. */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/** An argument this module refuses before anything is opened or written. */
export class RunCloseUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCloseUsageError";
    Object.setPrototypeOf(this, RunCloseUsageError.prototype);
  }
}

/**
 * This run cannot be closed, and nothing was written.
 *
 * In the {@link ControlPlaneRefusal} family because both of its cases are
 * ordinary answers to a command an operator typed -- there is no such run, this
 * run is already closed -- rather than defects. That membership is what makes
 * each of them one stderr line and exit 2 in `run_cli.ts`.
 *
 * The already-closed case is refused **here**, before the lease is taken, even
 * though {@link advanceRunStatus} would refuse it too. Two reasons, and the
 * second is the one that matters: the operator's answer should name the status
 * the run is already at rather than arrive as a lifecycle error about a step,
 * and taking a lease for a write that cannot land would bump the run's lease
 * epoch for nothing -- an epoch is the identity of a writer, and one allocated
 * to a writer that never wrote is a gap in the history the stamp exists to make
 * readable.
 */
export class RunCloseRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RunCloseRefused";
    Object.setPrototypeOf(this, RunCloseRefused.prototype);
  }
}

// --------------------------------------------------------------------------
// the close
// --------------------------------------------------------------------------

/** What one close moved, as the close itself saw it. */
export interface ClosedRun {
  /** The run now at a terminal status. */
  readonly runId: string;
  /** The status it was closed from, read back rather than supplied. */
  readonly from: RunStatus;
  /** The terminal status it reached: the operator's `--outcome`. */
  readonly to: RunStatus;
  /** Who closed it -- the identity the run lease was taken under. */
  readonly actorId: string;
  /**
   * The lease epoch the transition landed under, and the value now stamped on
   * `run.writer_epoch`. It is what ties the row to the `lease` row naming the
   * actor, which is the whole of this close's audit trail.
   */
  readonly writerEpoch: number;
}

/**
 * Close `runId` at `outcome`, under a run lease taken as `actorId`.
 *
 * The `from` status is **read back, never supplied**: an operator closing a run
 * states the outcome, not the status the run is currently in, and a `--from`
 * flag would let a typo aim a compare-and-set at a step the run never took. The
 * read is not a check-then-write race dressed up -- the status it read becomes
 * part of {@link advanceRunStatus}'s own `WHERE`, so a run that moved in between
 * matches nothing and the attempt surfaces as `ProtectedWriteMissed` rather than
 * landing on top of another writer.
 *
 * The lease is taken and given back around the one write. Taking it is not
 * ceremony: it is the only way to reach the single writer of `run.status`
 * (`D-0046`), and a live claimant refuses this verb, which is the serialisation
 * an operator wants -- a lap still driving this run holds the lease, and a close
 * landing under it would transition a run out from under a session that is still
 * writing. Giving it back is what makes a second attempt after a refusal
 * immediate rather than a wait for the TTL.
 *
 * @throws {RunCloseUsageError} a malformed argument, before anything is read.
 * @throws {RunCloseRefused} there is no such run, or it is already closed.
 *   Nothing is written and no lease is taken.
 * @throws {LeaseHeld} the run's lease has a live claimant: a lap is still
 *   driving it.
 * @throws {StaleWriterRefused} the lease was taken over between the acquire and
 *   the write; the refusal is an `action` row before this is raised.
 * @throws {ProtectedWriteMissed} another writer moved the run off the status
 *   this call read.
 *
 * **The residual, stated rather than glossed.** The checks above are refused
 * before the lease is taken, so a close this call can see is impossible costs
 * the database nothing. That is not a claim about two closes racing: the status
 * read and the acquire are separate transactions -- `acquire` and
 * `protectedWrite` each own a `BEGIN IMMEDIATE` and neither can be joined to
 * another -- so a second closer arriving after the first has committed and given
 * the lease back reads a status that is already stale, takes the lease (raising
 * the epoch, replacing the holder), and only then misses on the compare-and-set.
 * Its refusal is correct and the run is untouched, but the `lease` row no longer
 * names the writer the `run` row's `writer_epoch` was allocated by, so the
 * audit link is to an epoch that wrote nothing. Closing that would need the
 * status precondition and the acquire in one transaction, which is a change to
 * `lease.ts`'s transaction ownership rather than to this verb (`D-0084`).
 */
export function closeRun(
  connection: SqliteDatabase,
  options: {
    readonly runId: string;
    readonly outcome: RunStatus;
    readonly actorId: string;
    readonly nowMs: number;
    readonly ttlMs?: number;
  },
): ClosedRun {
  const { runId, outcome, actorId, nowMs, ttlMs = RUN_CLOSE_LEASE_TTL_MS } = options;

  requireText("run_id", runId);
  requirePrintableActor(actorId);
  requireInt("now_ms", nowMs);
  requireInt("ttl_ms", ttlMs);
  requireOutcome(outcome);

  const record = closeableRecordOf(connection, runId, outcome);
  requireForwardClock(runId, record, nowMs);
  const from = record.status as RunStatus;

  const lease = acquireRunLease(connection, { runId, holder: actorId, nowMs, ttlMs });
  try {
    advanceRunStatus(connection, lease, { runId, from, to: outcome, nowMs });
  } catch (error) {
    // The lease is given back on the way out, and a failure to give it back is
    // swallowed here and only here: the operator's answer is why the close was
    // refused, and replacing it with a lease error would cost the diagnosis to
    // report something that costs at most a wait for the TTL.
    releaseQuietly(connection, lease, nowMs);
    throw error;
  }
  // On the success path a failed release IS news -- the close landed under a
  // token the database no longer agrees this process held -- so it is not
  // swallowed.
  release(connection, lease, { nowMs });

  return Object.freeze({ runId, from, to: outcome, actorId, writerEpoch: lease.epoch });
}

// --------------------------------------------------------------------------
// the checks the close makes for itself
// --------------------------------------------------------------------------

/**
 * The `run` row for `runId`, refused unless a close may leave the status it is
 * at.
 *
 * The three refusals here are the transition set of `D-0084` stated once: no
 * such run, a run already at a terminal status, and a row whose status is not a
 * word this build knows. The row itself is handed back rather than just the
 * status, because the clock check below is about the same read: two reads would
 * be two answers about one row.
 */
function closeableRecordOf(
  connection: SqliteDatabase,
  runId: string,
  outcome: RunStatus,
): RunRecord {
  // `pythonRepr`, not raw interpolation: this identifier is an operator's
  // `--run-id` and nothing has validated it on the path where it matched no row,
  // so a newline in it would otherwise forge a second line of output
  // (`docs/cli-output-policy.md`), exactly as `readLapRunIntent` guards.
  const quoted = pythonRepr(runId);
  const record = readRun(connection, runId);
  if (record === undefined) {
    throw new RunCloseRefused(
      `there is no run ${quoted} to close; 'run admit' is what puts a run on the ` +
        "table, and an identifier naming no run is a resolution mistake rather " +
        "than a run that has nothing left to do",
    );
  }
  const status = record.status;
  if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(status)) {
    throw new RunCloseRefused(
      `run ${quoted} is already closed as '${status}' and does not become ` +
        `'${outcome}'; which terminal status a run reached is a fact, and a wrong ` +
        "fact is corrected by opening a new run rather than by re-closing this one",
    );
  }
  if (!(RUN_STATUSES as readonly string[]).includes(status)) {
    throw new RunCloseRefused(
      `run ${quoted} is at status ${pythonRepr(status)}, which is not one of ` +
        `${pythonList(RUN_STATUSES)}; this build cannot say what closing it would ` +
        "mean",
    );
  }
  return record;
}

/**
 * The close's clock, refused if it runs the run's own timestamps backwards.
 *
 * `run` carries `CHECK (updated_at_ms >= created_at_ms)` and this verb writes
 * `updated_at_ms` from `--now-ms`, so a clock behind the run's creation -- a
 * corrected system clock, a database written on a faster one, a hand-typed
 * `--now-ms` -- makes the transition fail *inside* the fenced statement. What
 * reaches the operator then is a raw `SQLITE_CONSTRAINT` from three frames down,
 * after a lease has already been taken and given back. Asked here it is a
 * refusal naming both instants, and it costs nothing: it is a comparison on the
 * row this call has already read.
 *
 * The bound is `updated_at_ms`, not the `CHECK`'s `created_at_ms`. The DDL is
 * the floor; the run's last movement is the honest one, because a close stamped
 * before the transition that preceded it would record a history that runs
 * backwards while satisfying the constraint.
 */
function requireForwardClock(runId: string, record: RunRecord, nowMs: number): void {
  if (nowMs >= record.updatedAtMs) {
    return;
  }
  throw new RunCloseRefused(
    `closing run ${pythonRepr(runId)} at now_ms=${nowMs} would stamp an ` +
      `updated_at_ms before the run's own ${record.updatedAtMs}; a close does not ` +
      "run a run's timestamps backwards, and the row's CHECK would refuse it from " +
      "inside the fenced statement rather than here",
  );
}

/**
 * The actor, held to printable ASCII.
 *
 * The same rule `LapRunIntent` holds a run id to, for the same reason and one
 * verb later: this string is printed back verbatim in the close's report, so a
 * value carrying a newline would put a second line on stdout that reads like a
 * second close. A usage error rather than a refusal, matching where `D-0051`
 * placed the equivalent check for `run admit`: a malformed identifier is a
 * defect in whoever composed it, and it never reaches the report at all.
 */
function requirePrintableActor(actorId: unknown): asserts actorId is string {
  requireText("actor_id", actorId);
  if (!PRINTABLE_ASCII.test(actorId)) {
    throw new RunCloseUsageError(
      `actor_id must be printable ASCII (U+0020..U+007E), got ${pythonRepr(actorId)}; ` +
        "it is printed back verbatim in this verb's report, so a character that " +
        "ends a line or moves a cursor is one the report cannot quote back as the " +
        "string the lease row holds",
    );
  }
}

function requireText(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value === "") {
    throw new RunCloseUsageError(`${field} must be a non-empty string, got ${pythonRepr(value)}`);
  }
}

function requireInt(field: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RunCloseUsageError(
      `${field} must be an int of epoch milliseconds, got ${pythonRepr(value)}`,
    );
  }
}

/**
 * The outcome, held to the terminal set.
 *
 * A {@link RunCloseUsageError} rather than a refusal, and unreachable from the
 * CLI: `run close --outcome` declares the same set as its `choices`, so the
 * parser has already refused anything else with argparse's own message. This is
 * for a caller of the library, where a word outside the set is a defect.
 */
function requireOutcome(outcome: unknown): asserts outcome is RunStatus {
  if (typeof outcome !== "string" || !(RUN_CLOSE_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new RunCloseUsageError(
      `outcome must be one of ${pythonList(RUN_CLOSE_OUTCOMES)}, got ${pythonRepr(outcome)}; a ` +
        "close names the terminal status the run reached, and the terminal set is " +
        "closed by run's own CHECK",
    );
  }
}

/** Give the lease back, or leave it to expire. See {@link closeRun}. */
function releaseQuietly(connection: SqliteDatabase, lease: Lease, nowMs: number): void {
  try {
    release(connection, lease, { nowMs });
  } catch (error) {
    if (error instanceof LeaseRefusal) {
      return;
    }
    throw error;
  }
}
