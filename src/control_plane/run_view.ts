/**
 * The read model behind `continuo run show`: one run, and the four kinds of
 * row a console renders beside it (`D-0096`).
 *
 * **Why this module exists at all.** cadenza's operating-surface design
 * (`docs/design/operating-surface.md`, row `S-10`) measured what a console has
 * to draw and found one pane with no read path: run and belt state,
 * `awaiting_user`, and the outbox. `run` had exactly `admit` and `close`, so
 * the only way to draw that pane was to open continuo's SQLite file from a
 * second process -- which is the answer `S-10` names as the wrong one, and
 * which rondo `D-0015` rule 1 already forbids by keeping continuo behind a CLI
 * process boundary. `D-0096` settles it the other way: the database is not a
 * public read surface, and this reader plus the verb over it is.
 *
 * **What "belt state" and "`awaiting_user`" are, since neither is a column.**
 * Both names come from v1's vocabulary and neither has a referent in this
 * schema, so the reader answers what they were asking about rather than
 * minting the names:
 *
 * - a **belt** is interlock's autonomous conveyor -- the thing that carries a
 *   delegation from triage to PR. Continuo has no such table. What is actually
 *   executing a run here is its **session binding** (`session`, `D-0024`'s
 *   staged phases) and the **run lease** (`lease` at `run:<run_id>`,
 *   `D-0046` rule 3), so those are the two things {@link runView} reads.
 * - **`awaiting_user`** is an attention *notify subkind* in the v1 file world
 *   (`src/attention/classifier.ts`), not an event type on this spine. What
 *   corresponds here is a gate of this run at stage `presented`, which
 *   cadenza's document says in as many words. So the reader returns the run's
 *   OPEN GATES with their stage, and a host reads the stage it already decodes
 *   from `gate list --json`.
 *
 * **The whole row, or the reason a reader would open the file anyway.** Every
 * column of `run`, `session`, `lease`, `event` and `outbox` that this reader
 * touches is carried through -- including `event.payload` and `outbox.payload`,
 * which are the two large ones. A column withheld from the read surface is
 * exactly the reason somebody opens the database instead, which is the
 * behaviour `D-0096` exists to remove. The one deliberate narrowing is the
 * gate, which is carried as the same six-field summary `gate list` prints:
 * `gate show --json` is the full gate read and already exists, and restating
 * its payload here would be a second answer to "what is this gate".
 *
 * **It reads no clock.** Whether a lease is live, whether a deadline has
 * passed and whether an outbox row is overdue are all questions against the
 * *caller's* clock, and the rows carry the millisecond fields to answer them
 * with. A boolean computed here would be continuo's clock answering at an
 * instant the host cannot see, which is the one shape a console cannot
 * reconcile with what it drew a moment earlier.
 *
 * **It writes nothing, and takes no transaction.** The five reads run on one
 * connection in autocommit. `txn.ts`'s {@link transaction} is `BEGIN
 * IMMEDIATE` -- a write lock -- and a read verb must not take the write lock
 * out from under a running lap, so it is not used here; a `BEGIN DEFERRED`
 * snapshot would need a second transaction helper, and `txn.ts` states that
 * the commit lives there once. The consequence is stated rather than glossed:
 * the document is five reads rather than one snapshot, so a run being written
 * while it is read can show a `run.status` from before a write and an `event`
 * from after it. The run row is read FIRST so that an unknown run is refused
 * before anything else is read, and the skew is bounded by the run's own
 * writers, which are serialised by the run lease this same document carries.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import { readLease } from "./lease.js";
import { type RunRecord, readRun, runLeaseResource, UnknownRunRefused } from "./run_lifecycle.js";

/** The run's lease row (`run:<run_id>`), as `lease.ts` reads it back. */
export interface RunLeaseView {
  readonly resource: string;
  readonly holder: string;
  readonly epoch: number;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
}

/**
 * One `session` row of this run, released or not.
 *
 * Released bindings are carried as well as the live one, because a console
 * rendering "what has run against this" needs the stop-then-resume history
 * that `session_one_active_binding_per_run` deliberately permits. A reader
 * that wanted only the live one filters on `releasedAtMs === null`, which is
 * the same predicate the partial unique index is built on.
 */
export interface RunSessionView {
  readonly sessionId: string;
  readonly provider: string;
  readonly bindingPhase: string;
  readonly observation: string;
  readonly providerState: string | null;
  readonly observationReason: string | null;
  readonly boundAtMs: number;
  readonly releasedAtMs: number | null;
}

/**
 * One open gate of this run, in `gate list`'s own summary shape.
 *
 * The fields are `openGates`' six minus `run_id`, which is the argument this
 * whole document was read under. `rationale` is not here for the same reason
 * the rest of the gate is not: `gate show --json` is the gate read.
 */
export interface RunGateView {
  readonly gateId: string;
  readonly gateType: string;
  readonly stage: string;
  readonly stageEnteredAtMs: number;
  readonly deadlineAtMs: number | null;
}

/** One `event` row on this run's spine, in `seq` order. */
export interface RunEventView {
  readonly seq: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly payload: string;
  readonly producer: string;
  readonly producerEpoch: number | null;
  readonly dedupKey: string;
  readonly occurredAtMs: number;
  readonly ingestedAtMs: number;
}

/** One `outbox` row enqueued for this run, oldest first. */
export interface RunOutboxView {
  readonly messageId: string;
  readonly recipient: string;
  readonly payload: string;
  readonly dedupKey: string;
  readonly status: string;
  readonly retryCount: number;
  readonly writerEpoch: number | null;
  readonly enqueuedAtMs: number;
  readonly deliveredAtMs: number | null;
  readonly ackedAtMs: number | null;
}

/**
 * One run and everything a console draws beside it.
 *
 * The four lists are always present and are empty when nothing matched; the
 * lease is `null` when the run has never been leased. An empty list is a
 * result -- a host that had to tell "no sessions" from "the key was not
 * emitted" would be reading an absence, which is the one thing a JSON reader
 * cannot do reliably.
 */
export interface RunView {
  readonly run: RunRecord;
  readonly lease: RunLeaseView | null;
  readonly sessions: readonly RunSessionView[];
  readonly gates: readonly RunGateView[];
  readonly events: readonly RunEventView[];
  readonly outbox: readonly RunOutboxView[];
}

/**
 * Sessions bound to this run, oldest binding first.
 *
 * `session_by_run` is the index this walks, and the ordering is
 * `(bound_at_ms, session_id)` for the reason every other listing reader in
 * this codebase carries a tiebreak: two rows written at one millisecond would
 * otherwise come back in whatever order SQLite chose that day, and a console
 * diffing two reads would render a reorder that never happened.
 */
const SELECT_SESSIONS = `
    SELECT session_id, provider, binding_phase, observation, provider_state,
           observation_reason, bound_at_ms, released_at_ms
      FROM session
     WHERE run_id = :run_id
     ORDER BY bound_at_ms, session_id
`;

/**
 * This run's open gates, oldest stage entry first.
 *
 * `closed_at_ms IS NULL` is not a second definition of "open" invented here:
 * it is the predicate `gate_by_run` is declared with in
 * `migrations/0001_initial.sql`, which is to say the schema ships this exact
 * query as an index. The ordering matches `openGates` so that a gate reads the
 * same way whichever verb surfaced it.
 */
const SELECT_GATES = `
    SELECT gate_id, gate_type, stage, stage_entered_at_ms, deadline_at_ms
      FROM gate
     WHERE run_id = :run_id AND closed_at_ms IS NULL
     ORDER BY stage_entered_at_ms, gate_id
`;

/**
 * This run's events, in spine order.
 *
 * `seq` is the spine's own AUTOINCREMENT order and is what `event_by_run`
 * indexes, so this is both the cheapest and the only honest ordering:
 * `occurred_at_ms` is the producer's clock and two producers may disagree
 * about it, while `seq` is the order this database accepted the facts in.
 */
const SELECT_EVENTS = `
    SELECT seq, event_id, event_type, subject_kind, subject_id, payload,
           producer, producer_epoch, dedup_key, occurred_at_ms, ingested_at_ms
      FROM event
     WHERE run_id = :run_id
     ORDER BY seq
`;

/**
 * This run's outbox rows, oldest enqueue first.
 *
 * Every row, not only the unfinished ones: `outbox_undelivered`'s
 * `status <> 'acked'` is the recovery question, and a console's outbox pane is
 * asking a different one -- what was sent, and what came of it. Rows are never
 * deleted (`outbox_rows_are_never_deleted`), so this is the whole delivery
 * history of the run and is what makes the pane an audit rather than a queue
 * depth.
 */
const SELECT_OUTBOX = `
    SELECT message_id, recipient, payload, dedup_key, status, retry_count,
           writer_epoch, enqueued_at_ms, delivered_at_ms, acked_at_ms
      FROM outbox
     WHERE run_id = :run_id
     ORDER BY enqueued_at_ms, message_id
`;

/** An INTEGER column that may be NULL, as a number that may be `null`. */
function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** A TEXT column that may be NULL, as a string that may be `null`. */
function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * One run, its lease, its sessions, its open gates, its events and its outbox.
 *
 * @throws {UnknownRunRefused} if `runId` names no run. Refusing is the whole
 *   point rather than a nicety: an empty document for a mistyped identifier is
 *   indistinguishable from a real run that has done nothing yet, and a console
 *   would render "this run is idle" for a run that does not exist. It is the
 *   same refusal class `run close` raises for the same situation, so a
 *   mistyped id reads the same way whichever run verb was typed.
 * @throws {RunLifecycleUsageError} if `runId` is not a non-empty string --
 *   raised by `readRun`'s own argument check, and a caller defect rather than
 *   an operator's answer (`D-0090` point 2).
 */
export function runView(connection: SqliteDatabase, runId: string): RunView {
  // First, so that an unknown run costs one statement and no reader below has
  // to be written to tolerate a run that is not there.
  const run = readRun(connection, runId);
  if (run === undefined) {
    throw new UnknownRunRefused(
      `there is no run '${runId}' to show. A run is created by 'run admit'; an identifier ` +
        "naming no run is a resolution mistake, and answering it with an empty document " +
        "would be indistinguishable from a run that has done nothing yet",
      { runId },
    );
  }

  const lease = readLease(connection, runLeaseResource(runId));
  const parameters = { run_id: runId };

  const sessions = (
    connection.prepare(SELECT_SESSIONS).all(parameters) as readonly Record<string, unknown>[]
  ).map((row) => ({
    sessionId: String(row.session_id),
    provider: String(row.provider),
    bindingPhase: String(row.binding_phase),
    observation: String(row.observation),
    providerState: optionalText(row.provider_state),
    observationReason: optionalText(row.observation_reason),
    boundAtMs: Number(row.bound_at_ms),
    releasedAtMs: optionalNumber(row.released_at_ms),
  }));

  const gates = (
    connection.prepare(SELECT_GATES).all(parameters) as readonly Record<string, unknown>[]
  ).map((row) => ({
    gateId: String(row.gate_id),
    gateType: String(row.gate_type),
    stage: String(row.stage),
    stageEnteredAtMs: Number(row.stage_entered_at_ms),
    deadlineAtMs: optionalNumber(row.deadline_at_ms),
  }));

  const events = (
    connection.prepare(SELECT_EVENTS).all(parameters) as readonly Record<string, unknown>[]
  ).map((row) => ({
    seq: Number(row.seq),
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    subjectKind: String(row.subject_kind),
    subjectId: String(row.subject_id),
    payload: String(row.payload),
    producer: String(row.producer),
    producerEpoch: optionalNumber(row.producer_epoch),
    dedupKey: String(row.dedup_key),
    occurredAtMs: Number(row.occurred_at_ms),
    ingestedAtMs: Number(row.ingested_at_ms),
  }));

  const outbox = (
    connection.prepare(SELECT_OUTBOX).all(parameters) as readonly Record<string, unknown>[]
  ).map((row) => ({
    messageId: String(row.message_id),
    recipient: String(row.recipient),
    payload: String(row.payload),
    dedupKey: String(row.dedup_key),
    status: String(row.status),
    retryCount: Number(row.retry_count),
    writerEpoch: optionalNumber(row.writer_epoch),
    enqueuedAtMs: Number(row.enqueued_at_ms),
    deliveredAtMs: optionalNumber(row.delivered_at_ms),
    ackedAtMs: optionalNumber(row.acked_at_ms),
  }));

  return Object.freeze({
    run,
    lease:
      lease === undefined
        ? null
        : Object.freeze({
            resource: lease.resource,
            holder: lease.holder,
            epoch: lease.epoch,
            acquiredAtMs: lease.acquiredAtMs,
            expiresAtMs: lease.expiresAtMs,
          }),
    sessions: Object.freeze(sessions),
    gates: Object.freeze(gates),
    events: Object.freeze(events),
    outbox: Object.freeze(outbox),
  });
}
