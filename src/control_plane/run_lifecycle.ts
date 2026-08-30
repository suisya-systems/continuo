import type { Database as SqliteDatabase } from "better-sqlite3";

import {
  acquire,
  and_,
  effectKind,
  eq,
  fencedUpdate,
  fenceEpoch,
  type Lease,
  ProtectedWrite,
  param,
  protectedWrite,
} from "./lease.js";
import { pythonList, pythonRepr } from "./python_repr.js";

/**
 * The single in-place writer of `run.status` (`D-0046`).
 *
 * `docs/production-schema.md` section 4.2 assigns `run.status` to exactly one
 * writer and fences it with the **run lease epoch**; section 7.1 records what
 * the collapse of that assignment cost in v1, when the observer of a merge
 * transitioned the run itself and a repo-resolution mistake wrote a foreign
 * PR's metadata onto a run row with nothing between the two. `D-0046` settles
 * the shape that closes it, and this module is step one of that shape:
 *
 * - **One code path performs the transition.** {@link advanceRunStatus} is it.
 *   A `run.status` write reaching the row from anywhere else is an *anomaly*,
 *   not an alternative route -- something to be surfaced as a fault, never a
 *   second supported call site.
 * - **Every transition is a fenced write.** The lease epoch is validated
 *   atomically as part of the statement (`ACCEPTANCE.md` section 2: expiry
 *   discovery alone is insufficient), and a stale writer's transition is
 *   refused and durably recorded rather than merged. There is no unfenced
 *   escape hatch here, and the builders in `./lease.js` are what make that
 *   structural rather than a matter of discipline: no SQL text crosses this
 *   module's boundary into a statement.
 * - **The write stamps `writer_epoch`** (`migrations/0004_run_writer_epoch.sql`),
 *   so which lease each transition landed under stays readable afterwards.
 *   Without the stamp the single-writer property is not false, it is
 *   *unprovable*, which is the failure `D-0046` rule 4 adds the column to
 *   avoid.
 *
 * `session_binding.ts` is the shape this follows -- staged writes, each one a
 * compare-and-set through the same gate -- and the differences from it are
 * both the schema's:
 *
 * - `run` **has** a `writer_epoch` column (`session` has none, its exclusion
 *   being an index instead), so these writes stamp it and the session's do not.
 * - `run.status`'s admissible steps are the database's own, in
 *   `run_status_is_forward_only` (`migrations/0001_initial.sql`). The lattice
 *   is mirrored below so a refused step is a typed refusal naming the rule
 *   rather than an integrity error from three frames down inside a statement
 *   the caller believed was a transition -- the same treatment
 *   `watcher.ts`'s `SCOPE_KINDS` gets. **The trigger stays the enforcement**;
 *   this mirror is the early word, and the suite asserts the two agree.
 *
 * What this module deliberately is not:
 *
 * - **It does not create runs.** Section 4.2's writer table assigns run
 *   *creation* no fence at all, and `D-0046` keeps it that way: what is
 *   single-writer is the in-place transition of `status`, not the append that
 *   brings the row into being. A `createRun` here would be a second writer to
 *   the run table wearing this module's name.
 * - **It is not the consumer.** For lap 1 the admission command plays the
 *   consumer's part (`D-0046` rule 2): whatever observes a fact appends the
 *   event, and the consumer of that event calls in here. Registering that
 *   consumer and driving it from `pr_merged` is a separate step; nothing in
 *   this file knows what an event is.
 * - **It is not an exclusion of its own, yet.** No DDL trigger requires a live
 *   lease for a status transition -- `D-0046` rule 4 leaves that question open
 *   and says why (it would fail every existing test that advances a run
 *   without holding one). So rule 1 is, at this step, a convention plus a gate
 *   this module opts into; nothing stops a writer that does not come through
 *   here. That is stated rather than glossed, so the guarantee is not read as
 *   stronger than it is -- and the `writer_epoch` stamp is what makes such a
 *   writer visible after the fact rather than invisible.
 */

// --------------------------------------------------------------------------
// the run lease
// --------------------------------------------------------------------------

/**
 * The prefix of a run lease's resource name.
 *
 * Exported because a reader of a `lease` row, or of an `action.kind` composed
 * by {@link effectKind}, needs to be able to tell a run lease from the other
 * resources sharing that table -- `watcher_scope:<scope_id>` (section 8.3) is
 * the other coined name, and `0001_initial.sql`'s lease comment says outright
 * that the resource vocabulary is open-ended prose rather than a `CHECK`.
 */
export const RUN_LEASE_PREFIX = "run:";

/**
 * The lease resource a writer must hold to advance `runId`'s status.
 *
 * **The granularity is the run** (`D-0046` rule 3): the name is a function of
 * the run identifier, so two runs never contend and one run has a single
 * claimant. Its falsifier is recorded with the decision -- an operation that
 * must advance two runs in one transaction would make this the wrong
 * granularity.
 *
 * The name is *derived*, never passed: {@link advanceRunStatus} composes this
 * same string from the run it is writing, so there is no argument a caller
 * could pass that would aim the fence at another run's lease. This helper is
 * for the *acquire* side and for reading rows back.
 */
export function runLeaseResource(runId: string): string {
  requireRunId(runId);
  return `${RUN_LEASE_PREFIX}${runId}`;
}

/**
 * Take the run lease for `runId`, or refuse.
 *
 * A thin, deliberate wrapper over {@link acquire}: it exists so the acquire
 * side cannot name the resource itself. Every refusal, every epoch bump and
 * every clock argument is `lease.ts`'s -- including that re-acquiring after
 * an expiry raises the epoch, which is what invalidates the writes the
 * previous claimant still had in flight.
 *
 * @throws {LeaseHeld} the run already has a live claimant at `nowMs`.
 */
export function acquireRunLease(
  connection: SqliteDatabase,
  options: {
    readonly runId: string;
    readonly holder: string;
    readonly nowMs: number;
    readonly ttlMs: number;
  },
): Lease {
  const { runId, holder, nowMs, ttlMs } = options;
  return acquire(connection, {
    resource: runLeaseResource(runId),
    holder,
    nowMs,
    ttlMs,
  });
}

// --------------------------------------------------------------------------
// the vocabulary and the lattice, mirrored from the DDL
// --------------------------------------------------------------------------

/**
 * The closed status vocabulary, mirrored from `run`'s own `CHECK`
 * (`migrations/0001_initial.sql`) and from `docs/production-schema.md`
 * section 4.3, which enumerates it as the set four other readers depend on.
 */
export const RUN_STATUSES = Object.freeze([
  "created",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled",
] as const);

/** One word of {@link RUN_STATUSES}. */
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The terminal set, in the strong sense section 4.3 gives it: a run does not
 * *leave* one of these, and `completed -> failed` is refused even though the
 * two rank equally. Which terminal status a run reached is a fact, and a
 * wrong fact is corrected by opening a new run.
 *
 * **Declared here a second time on purpose.** `gates.ts` already restates the
 * same G1 adjudication where its `subject_gone` sweep reads it, and this
 * module does not import that one: `gates.ts` is a *consumer* of run status
 * and this is its writer, so an import would point the dependency backwards
 * to borrow three words. That is the treatment `outbox.ts`'s second
 * declaration of `EXACTLY_ONCE_MECHANISMS` gets, and it comes with the same
 * obligation -- the suite asserts the two declarations are equal, so they
 * cannot drift. `src/index.ts` re-exports `gates.ts`'s copy under this name
 * and not this one, because one entry point cannot carry one name twice.
 */
export const TERMINAL_RUN_STATUSES = Object.freeze(["completed", "failed", "cancelled"] as const);

/**
 * The rank `run_status_is_forward_only` compares, restated.
 *
 * `running` and `suspended` collapse onto one level on purpose: a suspend is
 * a pause, not a step forward, so resuming must not read as a reversal. That
 * is also what `time-base-policy.md` section 3.4 needs -- a deliberately
 * paused run suspends its session-class predicates by moving to a status the
 * predicates exclude, which requires `suspended` to be leaveable.
 */
const STATUS_RANK: Readonly<Record<RunStatus, number>> = Object.freeze({
  created: 0,
  running: 1,
  suspended: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
});

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/** An argument this module refuses before any statement is built. */
export class RunLifecycleUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLifecycleUsageError";
    Object.setPrototypeOf(this, RunLifecycleUsageError.prototype);
  }
}

/**
 * The step is not one `run.status` may take.
 *
 * Raised *before* the write, so the caller gets the rule by name rather than
 * `run_status_is_forward_only`'s `RAISE(ABORT, ...)` text arriving as a
 * generic integrity error. The trigger is still what enforces the rule --
 * this refusal only means it never had to fire for a write that came through
 * this module.
 */
export class RunTransitionRefused extends Error {
  readonly from: string;
  readonly to: string;

  constructor(message: string, options: { readonly from: string; readonly to: string }) {
    super(message);
    this.name = "RunTransitionRefused";
    this.from = options.from;
    this.to = options.to;
    Object.setPrototypeOf(this, RunTransitionRefused.prototype);
  }
}

/**
 * There is no such run to transition.
 *
 * **Why this is a read before the write, when the fence deliberately is not.**
 * `ACCEPTANCE.md` section 2 rules out check-then-write for the *lease*,
 * because the lease can expire between the check and the write and the check
 * would then be a lie. Row existence is a different question, and leaving it
 * to the statement produces a worse answer than asking it:
 *
 * - With a live token, an absent run and a run that has merely moved on both
 *   collapse into {@link ProtectedWriteMissed} -- "the WHERE matched nothing"
 *   -- and an operator cannot tell "somebody else advanced this run" from
 *   "this run identifier is wrong".
 * - With a *stale* token it is worse than ambiguous. `protectedWrite` records
 *   the refusal as an `action` row, and `action.run_id` is a foreign key to
 *   `run`. For an absent run that insert fails with
 *   `SQLITE_CONSTRAINT_FOREIGNKEY`, which rolls the refusal back and raises a
 *   raw SQLite error in place of {@link StaleWriterRefused} -- so the one
 *   thing section 2 says must never happen to a rejection (being silently
 *   dropped) happens exactly when the writer was rejected.
 *
 * The residual race -- a run deleted between this read and the write -- is
 * not reachable in this build: nothing under `src/` deletes a run row, and
 * the suite asserts it structurally alongside the no-raw-writes check. If a
 * deletion path is ever added, this refusal is where it has to be reconsidered.
 */
export class UnknownRunRefused extends Error {
  readonly runId: string;

  constructor(message: string, options: { readonly runId: string }) {
    super(message);
    this.name = "UnknownRunRefused";
    this.runId = options.runId;
    Object.setPrototypeOf(this, UnknownRunRefused.prototype);
  }
}

// --------------------------------------------------------------------------
// reading a run back
// --------------------------------------------------------------------------

const SELECT_RUN =
  "SELECT run_id, status, writer_epoch, created_at_ms, updated_at_ms FROM run WHERE run_id = :run_id";

/** One `run` row, read back as recovery reads it (`D-0001`). */
export class RunRecord {
  readonly runId: string;
  readonly status: string;
  readonly writerEpoch: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;

  constructor(fields: {
    readonly runId: string;
    readonly status: string;
    readonly writerEpoch: number | null;
    readonly createdAtMs: number;
    readonly updatedAtMs: number;
  }) {
    this.runId = fields.runId;
    this.status = fields.status;
    this.writerEpoch = fields.writerEpoch;
    this.createdAtMs = fields.createdAtMs;
    this.updatedAtMs = fields.updatedAtMs;
    Object.freeze(this);
  }
}

/**
 * The run row, or `undefined`. A pure read (`D-0001`: state is reconstructed
 * by query, never carried in a caller's memory across a kill).
 *
 * This is also the read a caller makes *before* {@link advanceRunStatus}, to
 * learn the status it is transitioning from. That is not a check-then-write
 * race dressed up: the `from` status becomes part of the statement's own
 * `WHERE`, so a run that moved in between matches nothing and the attempt
 * surfaces as {@link ProtectedWriteMissed} rather than overwriting whatever
 * the other writer left.
 */
export function readRun(connection: SqliteDatabase, runId: string): RunRecord | undefined {
  requireRunId(runId);
  const row = connection.prepare(SELECT_RUN).get({ run_id: runId }) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) {
    return undefined;
  }
  return new RunRecord({
    runId: String(row.run_id),
    status: String(row.status),
    writerEpoch: row.writer_epoch === null ? null : Number(row.writer_epoch),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  });
}

// --------------------------------------------------------------------------
// the writer
// --------------------------------------------------------------------------

/** The effect name every run status transition is recorded under. */
export const ADVANCE_RUN_STATUS_EFFECT = "advance_run_status";

/**
 * Move `runId` from `from` to `to`, under `lease`. **The only writer of
 * `run.status`.**
 *
 * A compare-and-set, exactly as `session_binding.ts`'s phase marks are: the
 * status the caller believed the run to be in is part of the statement's own
 * `WHERE`, so a transition computed from a stale read changes no row rather
 * than landing on top of somebody else's. The fence is ANDed onto that
 * predicate by the builder, so the token decides whether the row changes and
 * is not merely present in the text.
 *
 * The kind is composed from the run's *own* lease resource, never from
 * `lease.resource`, so a token for another run (or for a watcher scope) is
 * refused by {@link protectedWrite}'s kind/resource agreement check before
 * any statement runs. That is what keeps one `action` history per run
 * readable: two resources' epochs are independent, and a kind accumulating
 * both would be two unrelated sequences with no way left to tell them apart.
 *
 * `writer_epoch` is stamped from `:fence_epoch` -- the builder's default and
 * not something this call opts into, since a run row that carried no epoch
 * would leave the single-writer property unprovable rather than false.
 *
 * `exactlyOnceMechanism` is `transactional_with_record`: the transition and
 * the record of a refused attempt are the same transaction on the same
 * database, which is the one case where that answer is the truthful one.
 *
 * @returns the number of rows changed -- always 1.
 * @throws {RunLifecycleUsageError} a status outside the vocabulary, or a
 *   malformed run id.
 * @throws {RunTransitionRefused} the step is not one `run.status` may take.
 * @throws {UnknownRunRefused} there is no such run -- see that class for why
 *   this one question is asked before the write rather than left to it.
 * @throws {StaleWriterRefused} the token was not live; the refusal is an
 *   `action` row in status `refused` before this is raised.
 * @throws {ProtectedWriteMissed} the token was live and the run had already
 *   moved off `from`.
 */
export function advanceRunStatus(
  connection: SqliteDatabase,
  lease: Lease,
  options: {
    readonly runId: string;
    readonly from: RunStatus;
    readonly to: RunStatus;
    readonly nowMs: number;
    readonly attemptId?: string | null;
  },
): number {
  const { runId, from, to, nowMs, attemptId = null } = options;
  requireRunId(runId);
  requireStatus("from", from);
  requireStatus("to", to);
  requireAdmissibleStep(from, to);
  requireRunExists(connection, runId);

  const statement = fencedUpdate("run", {
    set: {
      status: param("to_status"),
      updated_at_ms: param("now_ms"),
      writer_epoch: fenceEpoch,
    },
    where: and_(eq("run_id", param("run_id")), eq("status", param("from_status"))),
  });
  const write = new ProtectedWrite({
    kind: effectKind(runLeaseResource(runId), ADVANCE_RUN_STATUS_EFFECT),
    idempotencyKey: `${ADVANCE_RUN_STATUS_EFFECT}:${runId}:${from}->${to}`,
    statement,
    exactlyOnceMechanism: "transactional_with_record",
    params: { run_id: runId, from_status: from, to_status: to, now_ms: nowMs },
    runId,
  });
  return protectedWrite(connection, lease, write, { nowMs, attemptId });
}

// --------------------------------------------------------------------------
// argument checks
// --------------------------------------------------------------------------

function requireRunId(runId: unknown): void {
  if (typeof runId !== "string" || runId === "") {
    throw new RunLifecycleUsageError(`run_id must be a non-empty string, got ${pythonRepr(runId)}`);
  }
}

/**
 * The one existence question this module asks before writing. See
 * {@link UnknownRunRefused} for why it is asked here and not left to the
 * statement, and why that is not the check-then-write the fence rules out.
 */
function requireRunExists(connection: SqliteDatabase, runId: string): void {
  if (readRun(connection, runId) === undefined) {
    throw new UnknownRunRefused(
      `there is no run ${pythonRepr(runId)} to transition. A run is created before it is advanced, ` +
        "and creation is not this module's (production-schema.md section 4.2 assigns it no fence " +
        "at all); an identifier naming no run is a resolution mistake, which is the class of fault " +
        "section 7.1 records as having written a foreign PR's metadata onto a run row in v1",
      { runId },
    );
  }
}

function requireStatus(field: string, status: unknown): asserts status is RunStatus {
  if (typeof status !== "string" || !(RUN_STATUSES as readonly string[]).includes(status)) {
    throw new RunLifecycleUsageError(
      `${field} must be one of ${pythonList(RUN_STATUSES)}, got ${pythonRepr(status)}; the ` +
        "vocabulary is closed by run's own CHECK and by production-schema.md section 4.3, and " +
        "a word outside it is not a status this run could be in or reach",
    );
  }
}

/**
 * The three rules `run_status_is_forward_only` enforces, refused early.
 *
 * The trigger admits `NEW.status = OLD.status`; this module does not. A
 * "transition" that moves nothing still stamps a `writer_epoch` and bumps
 * `updated_at_ms`, which would put a step into the history that never
 * happened -- and a caller asking for it has computed the wrong step, which
 * is worth saying rather than absorbing.
 */
function requireAdmissibleStep(from: RunStatus, to: RunStatus): void {
  if (from === to) {
    throw new RunTransitionRefused(
      `a run does not transition from ${pythonRepr(from)} to itself; a write that moves nothing ` +
        "would still stamp a writer_epoch and an updated_at_ms, recording a step that never " +
        "happened",
      { from, to },
    );
  }
  if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(from)) {
    throw new RunTransitionRefused(
      `run.status ${pythonRepr(from)} is terminal and ${pythonRepr(to)} does not follow it: which ` +
        "terminal status a run reached is a fact, and a wrong fact is corrected by opening a new " +
        "run, not by an UPDATE that erases a completion a report may already have counted",
      { from, to },
    );
  }
  if (STATUS_RANK[to] < STATUS_RANK[from]) {
    throw new RunTransitionRefused(
      `run.status walks created -> running/suspended -> terminal, and ${pythonRepr(from)} -> ` +
        `${pythonRepr(to)} walks it back; running <-> suspended is the one reversal there is, ` +
        "because a suspend is a pause rather than a step forward",
      { from, to },
    );
  }
}
