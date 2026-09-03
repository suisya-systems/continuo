import type { Database as SqliteDatabase } from "better-sqlite3";

import { appendEvent } from "./events.js";
import { LapRunIntent } from "./lap_run_intent.js";
import { pythonJsonObject } from "./python_json.js";
import { pythonRepr } from "./python_repr.js";
import { ControlPlaneRefusal } from "./refusals.js";
import { transaction } from "./txn.js";

/**
 * The single place a `run` row comes into existence (`D-0051`).
 *
 * `run_lifecycle.ts` is the single in-place writer of `run.status` and says, in
 * its own docstring, what it deliberately is not: it does not create runs,
 * because `docs/production-schema.md` section 4.2's writer table assigns run
 * *creation* no fence at all and `D-0046` rule 4 keeps it that way. A
 * `createRun` there would be a second writer to the `run` table wearing the
 * lifecycle module's name. So creation lives here instead, and this module is
 * the other half of that sentence: **lease-free, append-only, and the only
 * `INSERT INTO run` in the build.**
 *
 * Three properties are load-bearing, and each is here rather than in a
 * convention.
 *
 * - **The row and both of its admission events are one transaction.**
 *   `event.run_id` is a foreign key onto `run(run_id)` and the connection runs
 *   with `PRAGMA foreign_keys = ON` (`connection.ts`), so the order inside the
 *   block is forced: `INSERT INTO run` first, {@link appendEvent} after. What
 *   is *not* forced, and is the reason the boundary is taken here rather than
 *   left to `appendEvent`'s own, is the failure in between -- a crash after
 *   the row and before the event would leave a run nobody can point at an
 *   admission for, which is a run whose existence has no recorded cause.
 *   `txn.ts`'s {@link transaction} joins an inner call to an outer one rather
 *   than nesting it, so `appendEvent` runs inside this block without knowing
 *   it and without committing half of it.
 *
 *   `D-0055` puts the lap's execution intent inside that same boundary, and
 *   for the same argument one step further out. An admission that committed
 *   the run and its `run_created` and then failed to append
 *   `run_delegation_recorded` would leave a run that exists, has a recorded
 *   cause, and has no statement of what it was admitted **to do** -- a half of
 *   L1, and the half nothing downstream can reconstruct. So the intent is an
 *   argument of admission rather than a later `run delegate` verb: two verbs
 *   would make "admitted but never delegated" a state an operator has to
 *   recover from, and there is no recovery, because a second admission is
 *   refused.
 * - **A second admission of one run is refused, not absorbed.** Re-running the
 *   command is not an idempotent retry: `run admit` is the statement that a run
 *   *begins*, and a second statement of a beginning is either a mistaken repeat
 *   or two callers believing they own one identifier. Both are things an
 *   operator has to see. This is the one place the module deliberately differs
 *   from the spine underneath it, where a re-appended fact IS an idempotent
 *   no-op -- a re-polling producer restating one observed fact is ordinary, and
 *   a second admission is not.
 * - **It does not transition anything.** The row is inserted `created` and left
 *   there. `D-0046` rule 1 gives `run.status`'s in-place transitions to
 *   `advanceRunStatus` alone, and inserting a run already `running` would reach
 *   `running` without ever passing through that gate -- the single-writer rule
 *   evaded by starting past it rather than by writing around it. Admission ends
 *   at `created`; the consumer half of `D-0046` rule 2 calls `advanceRunStatus`
 *   from there.
 *
 * **Why the raw `INSERT` here is not the anomaly the run-table scan hunts.**
 * `test/control_plane/run-lifecycle.test.ts` asserts that no module under
 * `src/` writes the `run` table in raw SQL. That scan now permits exactly one
 * file -- this one -- and names it, so the property it checks is not "there are
 * no raw writes" but "creation has exactly one implementation site and it is
 * this module". A raw `UPDATE run` stays at zero everywhere, this module
 * included: `lease.ts`'s builders own that statement, and nothing here produces
 * one.
 *
 * **ASCII only** in every message, for the reason `docs/cli-output-policy.md`
 * gives: a refusal from here is printed by `run_cli.ts` on a console that may be
 * cp932, where a character it cannot encode is a crash rather than a smudge.
 */

// --------------------------------------------------------------------------
// the vocabulary admission writes
// --------------------------------------------------------------------------

/**
 * The status a run is admitted at.
 *
 * A constant rather than a literal at the `INSERT`, because it is the value two
 * other things are stated against: the `run` table's `CHECK` on the closed
 * status set, and `D-0046` rule 1's requirement that every step *after* this one
 * go through `advanceRunStatus`. Both are about this exact value being the
 * lowest rung, and a literal buried in a statement is not a thing either can be
 * checked against.
 */
export const ADMITTED_RUN_STATUS = "created";

/**
 * The event type `D-0051` adds: a `run` row now exists.
 *
 * Registered in `EVENT_TYPES` (`events.ts`), which is defined as the vocabulary
 * *this implementation produces* -- so it is listed there because this producer
 * exists, and future types arrive with their own producers rather than ahead of
 * them. The word is `subject_pastparticiple`, matching `pr_merged`,
 * `gate_expired` and `consumption_skipped`: it names an objective fact about the
 * database (a run row now exists), not an intention or a command that was typed.
 */
export const RUN_CREATED_EVENT_TYPE = "run_created";

/**
 * The event type `D-0055` adds: this run's execution intent, as admission fixed
 * it.
 *
 * A second type rather than more keys in {@link RUN_CREATED_EVENT_TYPE}'s
 * payload, because the two are different facts about different subjects even
 * though one transaction writes both. `run_created` is a fact about *this
 * database* -- a row is on the table -- and its payload is the status that row
 * was inserted at. `run_delegation_recorded` is a fact about *the work*: what
 * this lap was asked for. Folding the second into the first would grow an event
 * whose meaning is "a row exists" into the carrier of a work statement, and
 * every later reader of `run_created` would have to know which of the two it
 * was being handed.
 *
 * The word keeps the `subject_pastparticiple` form and says `recorded` rather
 * than `delegated` on purpose. Nothing is delegated at admission: no worker has
 * been spawned, no workspace exists, no lease has been taken. What has happened
 * is that the intent was written down, and that is the fact this names.
 */
export const RUN_DELEGATION_RECORDED_EVENT_TYPE = "run_delegation_recorded";

/**
 * The `producer` stamped on every event this module appends.
 *
 * Fixed rather than a caller's argument, and that is the point: the column
 * records which code path put the fact on the spine, and there is exactly one
 * that can put *this* fact there. A `producer` parameter would let two callers
 * write two different answers to a question that has one, and the spine's own
 * `dedup_key` rule -- one row per observed fact -- would not catch it, because
 * they would still be one row disagreeing with itself across time.
 */
export const RUN_ADMISSION_PRODUCER = "run_admission";

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/**
 * A malformed argument, refused before anything is opened or written.
 *
 * Outside the {@link ControlPlaneRefusal} family on purpose, and for the reason
 * `events.ts` keeps `EventSpineUsageError` outside it: a refusal in that family
 * is a *fact stated about the data* -- this database is behind, this run is
 * already admitted -- and is reported to the operator as one line. A `nowMs`
 * that is not an integer is a defect in the caller, and burying its stack under
 * `error: ...` would cost the frames that diagnose it.
 *
 * The intent's own fields are checked by {@link LapRunIntent}'s constructor and
 * raise `LapRunIntentUsageError`, which sits outside the family for the same
 * reason. Two classes rather than one because they have two subjects: this one
 * says the *call* is malformed, that one says the *record* is.
 */
export class RunAdmissionUsageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RunAdmissionUsageError";
    Object.setPrototypeOf(this, RunAdmissionUsageError.prototype);
  }
}

/**
 * This run identifier has already been admitted. Nothing was written.
 *
 * In the {@link ControlPlaneRefusal} family because it is the same kind of
 * answer `R3` gives for a database that cannot be verified: refuse, and leave
 * the state exactly as it stood. That membership is also what makes it reach
 * the operator as one line and exit 2 -- `run_cli.ts` catches the family, and
 * nothing narrower.
 */
export class RunAlreadyAdmitted extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RunAlreadyAdmitted";
    Object.setPrototypeOf(this, RunAlreadyAdmitted.prototype);
  }
}

// --------------------------------------------------------------------------
// admission
// --------------------------------------------------------------------------

/** What one admission wrote, as the admission itself saw it. */
export interface AdmittedRun {
  /** The run now on the table. */
  readonly runId: string;
  /** The status it was inserted at, always {@link ADMITTED_RUN_STATUS}. */
  readonly status: string;
  /** `created_at_ms` and `updated_at_ms`, which admission sets equal. */
  readonly createdAtMs: number;
  /** The `run_created` event's identity and sequence on the spine. */
  readonly eventId: string;
  readonly eventSeq: number;
  /**
   * The `run_delegation_recorded` event's identity and sequence.
   *
   * Its own pair rather than a list of events, because the two are not
   * interchangeable and a caller that wanted "the second one" would be reading
   * the append order back out of a container instead of naming the fact it
   * means. `run_cli.ts` reports both, so an operator can see that the run and
   * its work statement landed together and at which sequence numbers.
   */
  readonly delegationEventId: string;
  readonly delegationEventSeq: number;
}

/** The one identity an event of `type` about `runId` has. */
function factId(eventType: string, runId: string): string {
  return `${eventType}/${runId}`;
}

/**
 * Admit a run: insert its row at `created`, append the `run_created` event that
 * says why it exists, and append the `run_delegation_recorded` event that says
 * what it was admitted to do. One transaction.
 *
 * `intent` is the whole of what admission fixes about this lap, and it arrives
 * already validated: {@link LapRunIntent} has no other constructor, and it
 * carries a private field, so an object literal of the right shape does not
 * satisfy the parameter. That is why this function has no field checks of its
 * own beyond the one that says the argument is an intent at all -- there is no
 * second place a field rule could be written and drift from the first.
 *
 * `nowMs` is the caller's clock, taken once and written to `created_at_ms`,
 * `updated_at_ms` and all four of the events' timestamps. It is a parameter
 * rather than a `Date.now()` here for the reason every other writer in this
 * package takes one: the DDL requires `updated_at_ms >= created_at_ms`, and two
 * reads of a clock are two values, so the invariant would rest on the ordering
 * of two calls instead of on there being one. The events' `occurred_at_ms` and
 * `ingested_at_ms` are the same instant here and that is not a shortcut --
 * `time-base-policy.md` section 2 separates the source clock from ours, and for
 * an admission we *are* the source: the facts are the row this call is writing
 * and the intent it was handed, not something a provider reported.
 *
 * The existence check is a `SELECT` before the `INSERT` rather than a caught
 * `UNIQUE` violation, mirroring how `appendEvent` detects a duplicate fact. The
 * two are equivalent under the `BEGIN IMMEDIATE` this block opens -- the write
 * lock is held from the first statement, so no second admission can land between
 * the read and the write -- and the `SELECT` is what makes the refusal a typed
 * one carrying the run's own identifier, rather than a driver's constraint
 * message from three frames down.
 *
 * **The append order is `run_created` then `run_delegation_recorded`, and it is
 * a decision rather than an accident of the source.** Both are true at the same
 * instant and both carry the same `nowMs`, so `seq` is the only thing that
 * orders them, and `seq` is what a reader draining the spine sees. A run's
 * first event should be the one that says the run exists: a consumer that is
 * handed the intent before it has ever seen the run has been handed a statement
 * about a subject it has no record of.
 *
 * @throws {RunAdmissionUsageError} for a malformed argument, before any write.
 * @throws {LapRunIntentUsageError} from the intent's own constructor, before
 *   this function is ever called.
 * @throws {RunAlreadyAdmitted} if the run identifier is already on the table.
 *   Nothing is written: the whole block rolls back.
 */
export function admitRun(
  connection: SqliteDatabase,
  options: { readonly intent: LapRunIntent; readonly nowMs: number },
): AdmittedRun {
  const { intent, nowMs } = options;

  if (!(intent instanceof LapRunIntent)) {
    throw new RunAdmissionUsageError(
      `intent must be a LapRunIntent, got ${pythonRepr(intent)}; ` +
        "the record is validated by its own constructor and there is no other " +
        "way to obtain one",
    );
  }
  if (typeof nowMs !== "number" || !Number.isInteger(nowMs)) {
    throw new RunAdmissionUsageError(
      `now_ms must be an int of epoch milliseconds, got ${pythonRepr(nowMs)}`,
    );
  }

  const runId = intent.runId;

  return transaction(connection, (tx) => {
    const existing = tx
      .prepare<{ run_id: string }, { status: string }>(
        "SELECT status FROM run WHERE run_id = :run_id",
      )
      .get({ run_id: runId });
    if (existing !== undefined) {
      throw new RunAlreadyAdmitted(
        `run ${runId} was already admitted and is at status '${existing.status}'; ` +
          "admission states that a run begins, so a second one is refused rather " +
          "than absorbed -- a re-run under a fresh identifier is the way to start " +
          "a new run",
      );
    }

    tx.prepare<{
      run_id: string;
      status: string;
      created_at_ms: number;
      updated_at_ms: number;
    }>(
      `
        INSERT INTO run (run_id, status, created_at_ms, updated_at_ms)
        VALUES (:run_id, :status, :created_at_ms, :updated_at_ms)
        `,
    ).run({
      run_id: runId,
      status: ADMITTED_RUN_STATUS,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
    });

    const created = appendOrRefuse(tx, {
      eventType: RUN_CREATED_EVENT_TYPE,
      runId,
      nowMs,
      payload: pythonJsonObject([["status", ADMITTED_RUN_STATUS]]),
    });
    const delegation = appendOrRefuse(tx, {
      eventType: RUN_DELEGATION_RECORDED_EVENT_TYPE,
      runId,
      nowMs,
      payload: intent.payload,
    });

    return Object.freeze({
      runId,
      status: ADMITTED_RUN_STATUS,
      createdAtMs: nowMs,
      eventId: created.eventId,
      eventSeq: created.seq,
      delegationEventId: delegation.eventId,
      delegationEventSeq: delegation.seq,
    });
  });
}

/**
 * Append one of admission's events, refusing rather than absorbing a duplicate.
 *
 * The `seq === null` branch is unreachable in this build, and checked anyway --
 * this is the line that makes the module's own atomicity claim true rather than
 * incidental.
 *
 * `appendEvent` treats a `dedup_key` already on the spine as an idempotent
 * no-op: it raises internally, and because `transaction` JOINS an inner call
 * rather than nesting it, that raise unwinds only as far as `appendEvent`'s own
 * catch, which returns `duplicate: true`. The block this runs inside is NOT
 * rolled back by it. So an append returning quietly would commit a `run` row
 * with one of its two admission events missing from the spine -- exactly the
 * inconsistency the one-transaction rule exists to prevent, arriving through
 * the mechanism meant to prevent it. Refusing turns it back into a rollback.
 *
 * Nothing can reach it today: the only producer of either fact is this module,
 * both `dedup_key`s are derived from the run identifier, and the duplicate run
 * row is already refused above. It becomes reachable the moment a second
 * producer appends under either vocabulary, which is when a silent commit would
 * be hardest to trace back.
 *
 * Shared by both appends rather than written twice, because a check that exists
 * for one of two events and not the other is the shape of the bug it is here to
 * catch.
 */
function appendOrRefuse(
  tx: SqliteDatabase,
  options: {
    readonly eventType: string;
    readonly runId: string;
    readonly nowMs: number;
    readonly payload: string;
  },
): { readonly eventId: string; readonly seq: number } {
  const { eventType, runId, nowMs, payload } = options;
  const id = factId(eventType, runId);
  const appended = appendEvent(tx, {
    eventId: id,
    eventType,
    subjectKind: "run",
    subjectId: runId,
    dedupKey: id,
    producer: RUN_ADMISSION_PRODUCER,
    occurredAtMs: nowMs,
    ingestedAtMs: nowMs,
    runId,
    payload,
  });
  if (appended.seq === null) {
    throw new RunAlreadyAdmitted(
      `the spine already holds ${id} as event ${appended.eventId}, but ` +
        `run ${runId} was not on the run table; refusing to admit a run whose ` +
        "admission events cannot be appended alongside it",
    );
  }
  return { eventId: appended.eventId, seq: appended.seq };
}

/**
 * A run whose delegation record cannot be read back.
 *
 * In the {@link ControlPlaneRefusal} family, for the same reason
 * {@link RunAlreadyAdmitted} is: an operator naming a run that was never
 * admitted, or one admitted by a build whose payload this one cannot parse, is
 * the ordinary outcome of a command someone typed rather than a defect.
 */
export class RunNotAdmitted extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RunNotAdmitted";
    Object.setPrototypeOf(this, RunNotAdmitted.prototype);
  }
}

/**
 * Read back the {@link LapRunIntent} admission fixed for `runId`.
 *
 * **The other half of `D-0055`, and it had none until now.** Admission writes
 * the intent into the `run_delegation_recorded` payload precisely so that a
 * later process -- a different one, with a working directory of its own -- can
 * act on what the lap was admitted to do rather than on flags retyped at the
 * point of use. Nothing could read it, so the composition root (`D-0059`) is
 * this function's first caller and the reason it exists.
 *
 * **A `LapRunIntent` and not a plain object**, which is the whole point. The
 * class is nominal and its constructor is its validation, so a payload that has
 * decayed -- a build that wrote a field this one does not accept, a hand-edited
 * row -- is refused here rather than reaching the materialiser as a value that
 * merely looks right. The round trip is therefore also a check: what comes back
 * is held to the same rules as what went in.
 *
 * The lookup is by the deterministic `event_id` {@link factId} assigns rather
 * than by a `WHERE event_type = ... ORDER BY seq LIMIT 1` scan. Admission is the
 * only producer of this vocabulary and the id is unique
 * (`event_by_event_id`), so naming the row is exact where ordering would be a
 * convention -- and if a second producer ever appends under this event type,
 * the difference is that this reads admission's record rather than whichever
 * row sorted first.
 *
 * @throws {RunNotAdmitted} when no such run was admitted, or its payload cannot
 *   be read as an intent.
 */
export function readLapRunIntent(connection: SqliteDatabase, runId: string): LapRunIntent {
  if (typeof runId !== "string" || runId === "") {
    throw new RunAdmissionUsageError(`run_id must be a non-empty string, got ${pythonRepr(runId)}`);
  }
  // Quoted, not interpolated raw, and this is the one place in this module where
  // that distinction has teeth. Every other message here names a run that
  // reached the table through `LapRunIntent`, which holds the identifier to
  // printable ASCII (`D-0055`). This path is the opposite by construction: it
  // runs precisely when the identifier matched no row, so it is an operator's
  // `--run-id` that nothing has validated, on its way into a one-line refusal
  // that ends at a single newline. `pythonRepr` escapes a newline or a control
  // character rather than letting it forge a second line of output
  // (`docs/cli-output-policy.md`).
  const quoted = pythonRepr(runId);
  const row = connection
    .prepare<{ event_id: string }, { payload: string }>(
      "SELECT payload FROM event WHERE event_id = :event_id",
    )
    .get({ event_id: factId(RUN_DELEGATION_RECORDED_EVENT_TYPE, runId) });
  if (row === undefined) {
    throw new RunNotAdmitted(
      `run ${quoted} has no ${RUN_DELEGATION_RECORDED_EVENT_TYPE} event on the spine, ` +
        "so there is no record of what it was admitted to do; 'run admit' is what " +
        "writes one",
    );
  }

  let fields: unknown;
  try {
    fields = JSON.parse(row.payload);
  } catch (error) {
    throw new RunNotAdmitted(
      `run ${quoted}'s delegation payload is not readable JSON: ${String(error)}`,
      { cause: error },
    );
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new RunNotAdmitted(
      `run ${quoted}'s delegation payload is ${pythonRepr(fields)}, not a JSON object`,
    );
  }
  const payload = fields as Record<string, unknown>;

  try {
    // Every field is passed through unchecked and unconverted: the constructor
    // is the validation, and a check here would be a second statement of the
    // rules `lap_run_intent.ts` states once. `runId` comes from the caller
    // rather than the payload because the payload deliberately does not carry it
    // -- see `LapRunIntent.payload`.
    return new LapRunIntent({
      runId,
      leaseClaimantId: payload["lease_claimant_id"] as string,
      workspace: payload["workspace"] as string,
      role: payload["role"] as string,
      baseBranch: payload["base_branch"] as string,
      topicBranch: payload["topic_branch"] as string,
      prompt: payload["prompt"] as string,
      cliArgs: payload["cli_args"] as readonly string[],
    });
  } catch (error) {
    throw new RunNotAdmitted(
      `run ${quoted}'s delegation payload is not a valid execution intent: ${String(error)}`,
      { cause: error },
    );
  }
}
