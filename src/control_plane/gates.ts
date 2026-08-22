import type { Database as SqliteDatabase } from "better-sqlite3";
import { appendEvent } from "./events.js";
import { pythonJsonList, pythonJsonObject } from "./python_json.js";
import { transaction } from "./txn.js";

/**
 * G4 -- the gate ledger: staged escalation, ack-gated relays, and a terminal taxonomy.
 *
 * A gate is a halt that requires a decision from outside the deterministic layer
 * (`docs/production-schema.md` section 9.1), made durable as an entity with a
 * rationale, options, a deadline and an outcome. `#65` gives it the escalation
 * form -- worker to Secretary to human and back to the worker -- and `#64` the
 * merge-approval form; both use this module.
 *
 * Four things here are load-bearing rather than stylistic.
 *
 * **The stage is a projection, and the history is the truth.** `gate.stage` /
 * `gate.stageSeq` name a row of `gate_transition`; the schema's
 * `gate_stage_matches_its_transition` trigger refuses any projection that names
 * a transition which does not exist, belongs to another gate, or landed on
 * another stage. So every function below writes the transition first and points
 * the projection at it second, inside one transaction. Nothing in this module
 * ever writes `gate.stage` without having just written the row it names.
 *
 * **The edges are data, not control flow.** {@link ADMISSIBLE} is section 9.3's
 * transition table transcribed as an array of {@link Edge}. The document says
 * the edges are enforced in application code inside the appending transaction
 * because a SQLite trigger can express their shape but not the ack
 * precondition, which is a join. Written as `if`/`else` the claim "every other
 * edge is inadmissible" would be checkable only by reading every branch;
 * written as a table it is checkable by reading one constant, and the suite
 * reads the same constant to enumerate what must be refused.
 *
 * **A relay stage advances on the ack, never on the send** (section 9.5). The
 * gap between a durable write and an external effect is the one
 * `ACCEPTANCE.md` section 2 says SQLite alone cannot close: advancing before
 * the send loses the relay to a kill and the gate looks presented when nobody
 * saw it; advancing after the send as its own write re-sends on recovery and
 * the human sees the question twice. So {@link enqueueRelay} writes an outbox
 * row and a `gate_relay` row in one transaction, the delivery worker delivers,
 * the ack is set once by the outbox's own trigger, and only then does
 * {@link advanceOnAck} move the stage. {@link gatesNeedingAdvance} is the
 * recovery for a kill in the last window -- an acked relay whose advance never
 * landed -- and it is a completion, not an incident.
 *
 * **There is no backwards edge.** A question that needs re-asking after being
 * answered is a *new* gate linked by `superseded_by`, not a rewind, because
 * `gate.stage_entered_at_ms` is the aging basis {@link relayGaps} reads and a
 * rewind would reset it -- turning an old unanswered question into a young one
 * at exactly the moment somebody noticed it was old.
 *
 * **Every `policy_*` read binds one revision** (`D-0031`). Policy rows are
 * versioned and never updated in place, so a join that omits `revision_id`
 * matches every historical tolerance and emits one incident per revision ever
 * recorded, some of them alarming on a tolerance retired months ago. Both
 * detectors below pick the effective revision once, in a scalar subquery, and
 * join only its rows.
 *
 * **This module supplies the detectors; the driver is not in this branch.**
 * Every reader below -- {@link relayGaps}, {@link stalledRelays},
 * {@link gatesNeedingAdvance}, {@link gatesPastDeadline} -- and the writer
 * {@link sweepSubjectGone} have zero callers in `src/`, because no
 * reconcile-pass module exists here yet (`policy.budgetViolations` and
 * `policy.gateStageOwner` are in the same position). That is a scope boundary
 * worth stating rather than leaving to be discovered, because `D-0032` says a
 * `relay_gap` incident *names the ball holder* and no row returned by
 * {@link relayGaps} carries one. The missing piece is not the owner lookup --
 * `policy.gateStageOwner` resolves `(revisionId, gateType, stage)` to
 * `ballHolder` today -- it is the pass that would join a detector row to it and
 * raise the incident. Deriving the owner inside the detector instead would put
 * the revision binding in two places and make the detector's shape depend on
 * what the incident wants to print, so it stays where `D-0032` puts it: the
 * detector returns the aged gate and its `(gateType, stage)`, and the caller
 * that raises the incident resolves the owner against the revision effective
 * at that instant.
 *
 * Time is the caller's everywhere: no function here reads a clock, and no
 * column this module writes has a SQL default. `occurredAtMs` is when the
 * actor acted (a human's own moment) and `recordedAtMs` is when we made it
 * durable; the stage's aging basis is `recordedAtMs`, because section 2 of
 * `docs/time-base-policy.md` evaluates every tolerance against our clock only.
 */

/** The stages of section 9.2, in the order the gate walks them. */
export const GATE_STAGES: readonly string[] = Object.freeze([
  "received",
  "presented",
  "answered",
  "forwarded",
]);

/**
 * Section 9.4's terminal taxonomy. `forwarded` alone was the draft's only
 * terminus, which leaves a cancelled run, a withdrawn question, an expired
 * deadline, an unanswerable question and a superseded question as permanently
 * open rows that either alarm forever or are silently ignored.
 */
export const GATE_OUTCOMES: readonly string[] = Object.freeze([
  "answered_and_forwarded",
  "withdrawn",
  "subject_gone",
  "expired",
  "unanswerable",
  "superseded",
]);

export const TRANSITION_KINDS: readonly string[] = Object.freeze([
  "open",
  "advance",
  "resend",
  "correction",
  "close",
]);

export const GATE_TYPES: readonly string[] = Object.freeze([
  "worker_escalation",
  "merge_approval",
  "plan_approval",
  "risk_approval",
]);

/**
 * The two stages reached through the outbox, and therefore the two whose
 * advance is ack-gated. `answered` is not one of them: a human answer arrives
 * from outside and its durability is the `body` on the advance itself.
 */
export const RELAYED_STAGES: readonly string[] = Object.freeze(["presented", "forwarded"]);

/**
 * The G1 adjudication, restated where the sweep reads it: which terminal
 * status a run reached is a fact, and `run_status_is_forward_only` refuses to
 * leave any of them.
 */
export const TERMINAL_RUN_STATUSES: readonly string[] = Object.freeze([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * The writer of every row below is Dispatcher Core even when the *actor* is a
 * human: admissibility is a deterministic check and `D-0008` puts
 * deterministic evaluation in Core's row. A human answering a question is an
 * actor, not a writer to SQLite -- which is why `gate_transition` carries
 * `actor_kind` and the event carries `producer`, and they differ on purpose.
 */
export const WRITER = "dispatcher_core";

/**
 * One row of the section 9.3 transition table.
 *
 * `precondition` is prose on purpose: the machine-checkable half of each
 * precondition is implemented by the function that writes the edge (the ack
 * join for a relayed advance, the non-null `body` for `answered`), and
 * duplicating it here as a predicate would create a second place for it to be
 * true. What this field carries is the sentence a reader needs to know which
 * function to look in.
 */
export interface Edge {
  readonly fromStage: string | null;
  readonly toStage: string;
  readonly kind: string;
  readonly actorKinds: ReadonlySet<string>;
  readonly precondition: string;
}

const _ANY_ACTOR: ReadonlySet<string> = new Set([
  "worker",
  "secretary",
  "human",
  "dispatcher_core",
  "system",
]);

/**
 * Section 9.3's table, verbatim. **Every edge not listed here is
 * inadmissible** -- notably every backwards edge, and every advance that
 * skips a stage.
 *
 * `resend` and `correction` are enumerated for all four stages rather than
 * written as a wildcard, because "any open stage" includes `forwarded`: a
 * gate that has been forwarded is still open until its `close`, and a
 * correction to the answer it carried must remain recordable in that window.
 *
 * `close` is **not** enumerated the same way, and the difference is the whole
 * point of transcribing the actor column instead of defaulting it. Section
 * 9.3 spends two rows on the close: `received`/`presented`/`answered` close
 * with actor "varies", because the section 9.4 taxonomy decides which outcome
 * and each outcome has its own actor (a `withdrawn` is the worker's, an
 * `expired` the reconcile pass's, an `unanswerable` the human's); but
 * `forwarded -> forwarded` closes with actor `system` alone, because that
 * close is the consequence of the forward relay's ack and nobody *decides*
 * it. Widening it to any actor would let a worker close its own gate as
 * `answered_and_forwarded` at the one stage where the ack is the only
 * evidence the forward happened -- which is a gate that reports the answer
 * delivered on the say-so of the party that was supposed to receive it.
 */
export const ADMISSIBLE: readonly Edge[] = Object.freeze([
  Object.freeze({
    fromStage: null,
    toStage: "received",
    kind: "open",
    actorKinds: new Set(["worker", "system"]),
    precondition: "an escalation event exists on the spine (gate.origin_event_seq)",
  }),
  Object.freeze({
    fromStage: "received",
    toStage: "presented",
    kind: "advance",
    actorKinds: new Set(["secretary"]),
    precondition: "the presented relay's outbox row is acked (section 9.5)",
  }),
  Object.freeze({
    fromStage: "presented",
    toStage: "answered",
    kind: "advance",
    actorKinds: new Set(["human"]),
    precondition: "a human answer is durable; body non-null",
  }),
  Object.freeze({
    fromStage: "answered",
    toStage: "forwarded",
    kind: "advance",
    actorKinds: new Set(["secretary"]),
    precondition: "the forwarded relay's outbox row is acked (section 9.5)",
  }),
  ...GATE_STAGES.map((stage) =>
    Object.freeze({
      fromStage: stage,
      toStage: stage,
      kind: "resend",
      actorKinds: _ANY_ACTOR,
      precondition: "a relay attempt was repeated",
    }),
  ),
  ...GATE_STAGES.map((stage) =>
    Object.freeze({
      fromStage: stage,
      toStage: stage,
      kind: "correction",
      actorKinds: _ANY_ACTOR,
      precondition: "supersedes_seq names an earlier transition of this gate",
    }),
  ),
  ...(["received", "presented", "answered"] as const).map((stage) =>
    Object.freeze({
      fromStage: stage as string,
      toStage: stage as string,
      kind: "close",
      actorKinds: _ANY_ACTOR,
      precondition: "see the section 9.4 taxonomy",
    }),
  ),
  Object.freeze({
    fromStage: "forwarded",
    toStage: "forwarded",
    kind: "close",
    actorKinds: new Set(["system"]),
    precondition: "the forward relay is acked; see the section 9.4 taxonomy",
  }),
]);

/**
 * Section 9.4's taxonomy, read the other way round: which stages each outcome
 * is reachable from. The `close` rows of {@link ADMISSIBLE} say a close may
 * happen at any stage; this says *which* close.
 *
 * `subject_gone` and `superseded` list `forwarded` because section 9.4 gives
 * them "any open stage" and a forwarded gate is open until it closes; the
 * section 9.3 row naming only `answered_and_forwarded` out of `forwarded` is
 * the *ordinary* path, not an exhaustive one. What that row *is* exhaustive
 * about is the actor: every close out of `forwarded`, whichever of the three
 * outcomes it carries, is `system`'s, so both of these are written by the
 * reconcile pass and never by a party to the gate.
 */
export const CLOSE_OUTCOME_STAGES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  answered_and_forwarded: new Set(["forwarded"]),
  withdrawn: new Set(["received", "presented", "answered"]),
  subject_gone: new Set(GATE_STAGES),
  expired: new Set(["presented", "answered"]),
  unanswerable: new Set(["presented"]),
  superseded: new Set(GATE_STAGES),
});

/**
 * A gate write that was refused, with the reason it was refused for.
 *
 * Every refusal below is typed rather than a false return, because the two
 * outcomes a caller must distinguish -- "this already happened, carry on" and
 * "this may not happen" -- are exactly the two a bare `boolean` collapses. The
 * idempotent no-op *is* a `false` return; everything else raises.
 *
 * Its own family, deliberately not folded into `ControlPlaneRefusal`
 * (`refusals.ts`): `gates.py` declares its own refusal hierarchy rather than
 * importing the control plane's, and this module keeps that separation.
 */
export class GateRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateRefusal";
    Object.setPrototypeOf(this, GateRefusal.prototype);
  }
}

/** The gate_id names no row. A missing gate is never created implicitly. */
export class UnknownGateRefused extends GateRefusal {
  constructor(message: string) {
    super(message);
    this.name = "UnknownGateRefused";
    Object.setPrototypeOf(this, UnknownGateRefused.prototype);
  }
}

/** The gate is closed, and a closed gate keeps its outcome (section 9.2). */
export class GateClosedRefused extends GateRefusal {
  constructor(message: string) {
    super(message);
    this.name = "GateClosedRefused";
    Object.setPrototypeOf(this, GateClosedRefused.prototype);
  }
}

/** The edge is not in {@link ADMISSIBLE}. Includes every rewind. */
export class InadmissibleTransitionRefused extends GateRefusal {
  constructor(message: string) {
    super(message);
    this.name = "InadmissibleTransitionRefused";
    Object.setPrototypeOf(this, InadmissibleTransitionRefused.prototype);
  }
}

/**
 * A relayed stage was advanced without its outbox row being acked.
 *
 * This is the refusal that makes section 9.5 a property rather than a
 * convention: with the advance permitted on the send, a kill in the crash
 * window either loses the relay or duplicates the question, and no ordering
 * of the two operations fixes it.
 */
export class RelayNotAckedRefused extends GateRefusal {
  constructor(message: string) {
    super(message);
    this.name = "RelayNotAckedRefused";
    Object.setPrototypeOf(this, RelayNotAckedRefused.prototype);
  }
}

/**
 * The advance to `answered` carried no body.
 *
 * The verbatim answer is the whole point of the stage -- section 9.3 records
 * it on the advance row precisely so it is never paraphrased and never
 * overwritten -- so an advance without one is refused rather than stored as a
 * stage change with the answer lost.
 */
export class AnswerBodyRequired extends GateRefusal {
  constructor(message: string) {
    super(message);
    this.name = "AnswerBodyRequired";
    Object.setPrototypeOf(this, AnswerBodyRequired.prototype);
  }
}

/** `supersedesSeq` does not name an earlier transition of this gate. */
export class CorrectionTargetRefused extends GateRefusal {
  constructor(message: string) {
    super(message);
    this.name = "CorrectionTargetRefused";
    Object.setPrototypeOf(this, CorrectionTargetRefused.prototype);
  }
}

/**
 * The module's replaceable internals.
 *
 * `closeGate` is the only call site of `appendEvent` in this module, and the
 * source's `test_a_losing_concurrent_close_is_refused_instead_of_told_its_
 * outcome_landed` and its mirror `monkeypatch.setattr(gates, "append_event",
 * ...)` to drive a winner-commits-inside-the-loser's-append race
 * deterministically -- the replacement runs *from inside* the append seam,
 * exactly the window between the loser's pre-check and its own append. ESM
 * cannot rebind an import from outside the module the way Python's
 * module-dictionary lookup can, so this record reproduces that late binding
 * instead (`D-0014`): the call site goes through `gatesSeams.appendEvent`,
 * so replacing the entry changes what `closeGate` actually calls at its next
 * invocation, including a *recursive* one made from inside the replacement.
 *
 * Not re-exported from `src/index.ts`: a testing seam, not public API.
 */
export const gatesSeams = {
  appendEvent,
};

/** One `gate` row, exactly as it was found, field names camelCased. */
interface GateRow {
  readonly gateId: string;
  readonly gateType: string;
  readonly runId: string | null;
  readonly stage: string;
  readonly stageSeq: number | null;
  readonly stageEnteredAtMs: number;
  readonly outcome: string | null;
  readonly closedAtMs: number | null;
  readonly deadlineAtMs: number | null;
  readonly createdAtMs: number;
}

// --------------------------------------------------------------------------
// writing
// --------------------------------------------------------------------------

/**
 * Open a gate at `received` and return the seq of its opening transition.
 *
 * One transaction over three statements, in this order because the schema
 * admits no other: the gate row is inserted with a **null** `stageSeq` and
 * no outcome (`gate_opens_without_a_projection` refuses anything else --
 * creation is the one moment the projection cannot be validated, because
 * `gate_transition` has a foreign key back to `gate`); the `open` transition
 * is inserted; and the projection is then pointed at it through the UPDATE
 * path, where `gate_stage_matches_its_transition` governs.
 *
 * `originEventSeq` is the escalation event already on the spine -- section
 * 9.3's precondition for the `open` edge. This function does **not** append
 * it: the party that observed the escalation appends the event, and opening a
 * gate for an event nobody appended would make the gate its own evidence.
 *
 * @throws {InadmissibleTransitionRefused} if `actorKind` may not open a gate.
 */
export function openGate(
  connection: SqliteDatabase,
  options: {
    readonly gateId: string;
    readonly gateType: string;
    readonly subjectKind: string;
    readonly subjectId: string;
    readonly rationale: string;
    readonly originEventSeq: number;
    readonly createdAtMs: number;
    readonly actorKind: string;
    readonly actorId: string;
    readonly options?: readonly string[];
    readonly deadlineAtMs?: number | null;
    readonly runId?: string | null;
  },
): number {
  const {
    gateId,
    gateType,
    subjectKind,
    subjectId,
    rationale,
    originEventSeq,
    createdAtMs,
    actorKind,
    actorId,
    options: gateOptions = [],
    deadlineAtMs = null,
    runId = null,
  } = options;

  _requireActor(null, "received", "open", actorKind);
  const payload = pythonJsonList(gateOptions);
  return transaction(connection, (tx) => {
    tx.prepare<
      [
        string,
        string,
        string | null,
        string,
        string,
        number,
        string,
        string,
        number | null,
        number,
        number,
      ]
    >(
      `
            INSERT INTO gate (gate_id, gate_type, run_id, subject_kind, subject_id,
                              origin_event_seq, rationale, options, deadline_at_ms,
                              stage, stage_seq, stage_entered_at_ms, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', NULL, ?, ?)
            `,
    ).run(
      gateId,
      gateType,
      runId,
      subjectKind,
      subjectId,
      originEventSeq,
      rationale,
      payload,
      deadlineAtMs,
      createdAtMs,
      createdAtMs,
    );
    const seq = _insertTransition(tx, {
      gateId,
      transitionKind: "open",
      fromStage: null,
      toStage: "received",
      actorKind,
      actorId,
      occurredAtMs: createdAtMs,
      recordedAtMs: createdAtMs,
    });
    tx.prepare<[number, string]>(
      "UPDATE gate SET stage = 'received', stage_seq = ? WHERE gate_id = ?",
    ).run(seq, gateId);
    return seq;
  });
}

/**
 * Enqueue the relay for `toStage`, idempotently, and return the message in force.
 *
 * One transaction over the `gate_relay` row and the `outbox` row at `pending`
 * with `dedup_key = 'gate/<gateId>/<toStage>'`.
 *
 * The `(gate_id, to_stage)` primary key is what makes the *enqueue* itself
 * idempotent, and it is why this returns a message id rather than `null`: a
 * Secretary that was killed after the commit and re-enqueues on recovery
 * collides here and gets back the id already in force, so its retries
 * accumulate on one outbox row (`retry_count`, durable and monotonic) instead
 * of producing a second message a human would see twice. Deliberately *not*
 * done by making `outbox.dedup_key` unique -- that column is non-unique on
 * purpose and gate relays get their own identity table rather than a shared
 * table's semantics changed under every other caller.
 *
 * The existing row is read, not inserted-and-caught: the transaction holds
 * the write lock from its first statement (`BEGIN IMMEDIATE`), so a read that
 * finds nothing cannot be overtaken between the read and the insert.
 *
 * @throws {UnknownGateRefused} if `gateId` names no gate.
 * @throws {GateClosedRefused} a closed gate is not relayed to; its outcome is
 *   already recorded and nothing is waiting on the message.
 * @throws {TypeError} if `toStage` is not a relayed stage.
 */
export function enqueueRelay(
  connection: SqliteDatabase,
  options: {
    readonly gateId: string;
    readonly toStage: string;
    readonly recipient: string;
    readonly payload: string;
    readonly messageId: string;
    readonly enqueuedAtMs: number;
  },
): string {
  const { gateId, toStage, recipient, payload, messageId, enqueuedAtMs } = options;

  if (!RELAYED_STAGES.includes(toStage)) {
    throw new TypeError(
      `only ${pyTuple(RELAYED_STAGES)} are relayed stages; '${toStage}' is not one`,
    );
  }
  return transaction(connection, (tx) => {
    const gate = _loadGate(tx, gateId);
    if (gate.closedAtMs !== null) {
      throw new GateClosedRefused(
        `gate ${gateId} closed as '${gate.outcome}'; it is not relayed to`,
      );
    }
    const existing = tx
      .prepare<[string, string], { message_id: string }>(
        "SELECT message_id FROM gate_relay WHERE gate_id = ? AND to_stage = ?",
      )
      .get(gateId, toStage);
    if (existing !== undefined) {
      return existing.message_id;
    }
    tx.prepare<[string, string | null, string, string, string, number]>(
      `
            INSERT INTO outbox (message_id, run_id, recipient, payload, dedup_key,
                                status, enqueued_at_ms)
            VALUES (?, ?, ?, ?, ?, 'pending', ?)
            `,
    ).run(messageId, gate.runId, recipient, payload, `gate/${gateId}/${toStage}`, enqueuedAtMs);
    tx.prepare<[string, string, string, number]>(
      `
            INSERT INTO gate_relay (gate_id, to_stage, message_id, enqueued_at_ms)
            VALUES (?, ?, ?, ?)
            `,
    ).run(gateId, toStage, messageId, enqueuedAtMs);
    return messageId;
  });
}

/**
 * Advance the gate to `toStage`; return whether this call was the one that moved it.
 *
 * Step 4 of section 9.5. For a relayed stage the advance is refused unless the
 * relay's outbox row is `acked` -- the ack is the durable evidence that the
 * external effect happened, and it is set once by the outbox's own trigger, so
 * a duplicate or late ack changes nothing here either.
 *
 * Idempotent by design and not by accident: the reconcile pass calls this as a
 * *recovery* for a kill between the ack and the advance
 * ({@link gatesNeedingAdvance}), so a second call on a gate already at
 * `toStage` returns `false` rather than raising. Everything else raises,
 * because "already done" and "not allowed" are the two things a caller must be
 * able to tell apart.
 *
 * `stageEnteredAtMs` is set from `recordedAtMs`, not `occurredAtMs`: it is the
 * aging basis {@link relayGaps} reads, and rule 1 of
 * `docs/time-base-policy.md` section 2 evaluates every tolerance against our
 * clock only. The actor's own moment survives on the transition row.
 *
 * @throws {UnknownGateRefused} if `gateId` names no gate.
 * @throws {GateClosedRefused} if the gate is closed.
 * @throws {InadmissibleTransitionRefused} for any edge outside
 *   {@link ADMISSIBLE}, which is every rewind and every skipped stage.
 * @throws {RelayNotAckedRefused} if the relay for `toStage` is missing or
 *   unacked.
 * @throws {AnswerBodyRequired} if `toStage` is `answered` and `body` is null.
 */
export function advanceOnAck(
  connection: SqliteDatabase,
  options: {
    readonly gateId: string;
    readonly toStage: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly occurredAtMs: number;
    readonly recordedAtMs: number;
    readonly writerEpoch?: number | null;
    readonly body?: string | null;
  },
): boolean {
  const {
    gateId,
    toStage,
    actorKind,
    actorId,
    occurredAtMs,
    recordedAtMs,
    writerEpoch = null,
    body = null,
  } = options;

  return transaction(connection, (tx) => {
    const gate = _loadGate(tx, gateId);
    if (gate.stage === toStage) {
      return false;
    }
    if (gate.closedAtMs !== null) {
      throw new GateClosedRefused(
        `gate ${gateId} closed as '${gate.outcome}'; open a new gate instead`,
      );
    }
    const fromStage = gate.stage;
    _requireActor(fromStage, toStage, "advance", actorKind);
    if (toStage === "answered" && body === null) {
      throw new AnswerBodyRequired(
        `the advance of gate ${gateId} to 'answered' carries the verbatim ` +
          "answer; an advance without one loses the thing the stage is for",
      );
    }
    let messageId: string | null = null;
    if (RELAYED_STAGES.includes(toStage)) {
      messageId = _ackedRelayMessage(tx, gateId, toStage);
    }
    const seq = _insertTransition(tx, {
      gateId,
      transitionKind: "advance",
      fromStage,
      toStage,
      actorKind,
      actorId,
      occurredAtMs,
      recordedAtMs,
      writerEpoch,
      messageId,
      body,
    });
    tx.prepare<[string, number, number, string]>(
      `
            UPDATE gate
               SET stage = ?, stage_seq = ?, stage_entered_at_ms = ?
             WHERE gate_id = ?
            `,
    ).run(toStage, seq, recordedAtMs, gateId);
    return true;
  });
}

/**
 * Record that the current stage's relay was attempted again; return the seq.
 *
 * A resend does **not** move the stage, and this function has no `toStage`
 * parameter for that reason: it reads the stage the gate is already at and
 * writes `fromStage = toStage`. The stage moves on the ack alone.
 *
 * It does not touch `outbox.retry_count` either. That counter belongs to the
 * delivery worker, which is the thing making delivery attempts; incrementing
 * it here as well would count one attempt twice and make the durable retry
 * count -- the number `ACCEPTANCE.md` section 2 asks a query to be able to
 * show -- disagree with the deliveries that actually happened.
 */
export function recordResend(
  connection: SqliteDatabase,
  options: {
    readonly gateId: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly occurredAtMs: number;
    readonly recordedAtMs: number;
    readonly messageId?: string | null;
    readonly writerEpoch?: number | null;
  },
): number {
  const {
    gateId,
    actorKind,
    actorId,
    occurredAtMs,
    recordedAtMs,
    messageId = null,
    writerEpoch = null,
  } = options;
  return transaction(connection, (tx) => {
    const gate = _loadGate(tx, gateId);
    if (gate.closedAtMs !== null) {
      throw new GateClosedRefused(`gate ${gateId} is closed; nothing is resent`);
    }
    const stage = gate.stage;
    _requireActor(stage, stage, "resend", actorKind);
    return _insertTransition(tx, {
      gateId,
      transitionKind: "resend",
      fromStage: stage,
      toStage: stage,
      actorKind,
      actorId,
      occurredAtMs,
      recordedAtMs,
      writerEpoch,
      messageId,
    });
  });
}

/**
 * Correct an earlier transition's body with a new row; return its seq.
 *
 * Both texts survive, and that is the point: `gate_transition` is immutable
 * by trigger, so a corrected answer is a *second* row naming the first in
 * `supersedesSeq` rather than an UPDATE that would leave no trace of what the
 * human first said. A reader that wants the current answer takes the latest
 * row of the chain; a reader auditing what was acted on at the time takes the
 * row that was current then. An overwrite serves only the first reader and
 * silently misleads the second.
 *
 * @throws {CorrectionTargetRefused} if `supersedesSeq` is not an earlier
 *   transition of this same gate. A correction pointing at another gate's
 *   history would attach one human's words to another's question.
 */
export function recordCorrection(
  connection: SqliteDatabase,
  options: {
    readonly gateId: string;
    readonly supersedesSeq: number;
    readonly body: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly occurredAtMs: number;
    readonly recordedAtMs: number;
    readonly writerEpoch?: number | null;
  },
): number {
  const {
    gateId,
    supersedesSeq,
    body,
    actorKind,
    actorId,
    occurredAtMs,
    recordedAtMs,
    writerEpoch = null,
  } = options;
  return transaction(connection, (tx) => {
    const gate = _loadGate(tx, gateId);
    if (gate.closedAtMs !== null) {
      throw new GateClosedRefused(`gate ${gateId} is closed; its history is settled`);
    }
    const stage = gate.stage;
    _requireActor(stage, stage, "correction", actorKind);
    const target = tx
      .prepare<[number], { gate_id: string }>("SELECT gate_id FROM gate_transition WHERE seq = ?")
      .get(supersedesSeq);
    if (target === undefined || target.gate_id !== gateId) {
      throw new CorrectionTargetRefused(
        `transition ${supersedesSeq} is not a transition of gate ${gateId}`,
      );
    }
    return _insertTransition(tx, {
      gateId,
      transitionKind: "correction",
      fromStage: stage,
      toStage: stage,
      actorKind,
      actorId,
      occurredAtMs,
      recordedAtMs,
      writerEpoch,
      body,
      supersedesSeq,
    });
  });
}

/**
 * Close the gate with one of the six section 9.4 outcomes.
 *
 * Returns `true` when this call closed it and `false` when it was already
 * closed with the same outcome -- the reconcile sweep re-runs, and a second
 * pass over a gate it closed last time is not an error.
 *
 * The close is written **inside an event append**, through
 * {@link appendEvent}'s `sideEffect`, so the closure and the event that
 * announces it commit together. Section 9.4 requires this for `expired` in so
 * many words -- "expiry is recorded as an event so the decision's absence is
 * itself visible" -- and the same argument covers every other outcome: a gate
 * that stops being open with nothing on the spine is a decision that
 * disappeared. `expired` gets the event type `gate_expired` because the
 * absence of a decision is a different fact from a decision being reached;
 * every other outcome is a `gate_closed`.
 *
 * The event's `dedupKey` is `'gate_closed/<gateId>'` for every outcome: a
 * gate closes once, so one identity per gate is the strongest statement of
 * that and makes a re-run of the sweep an idempotent no-op on the spine as
 * well as in the table. Because that identity is shared by every outcome, a
 * duplicate append is *not* on its own evidence that this outcome landed: the
 * gate is re-read on that path and a different committed outcome is refused,
 * which is what keeps `false` meaning "already done, identically" rather than
 * "already done, somehow".
 *
 * **Closure retires the relay nobody is waiting for any more, in this same
 * transaction.** Every `gate_relay` of this gate whose `outbox` row is still
 * `pending` or `delivered` is moved to `cancelled`
 * (`0003_outbox_cancelled_status.sql`) by the same `sideEffect` that writes
 * the closure, so the gate is never closed in one commit and its relay
 * retired in another -- a crash between the two would leave exactly the state
 * this is here to prevent. An **acked** relay is deliberately untouched: the
 * answer arrived, the stage advance in section 9.5 is justified by that ack,
 * and a gate that closed *because* it was answered must not have its answered
 * relay rewritten. Cancellation is terminal but it is not an erasure --
 * `delivered_at_ms` and `retry_count` survive it untouched, which is what
 * keeps the delivery evidence readable afterwards.
 *
 * A `delivered` relay is cancellable and not only a `pending` one, and that is
 * the point rather than an edge case: `delivered` means *sent*, not
 * *answered*. A question put in front of a human and not yet acked can become
 * moot -- the gate is withdrawn while they are reading it -- and section 9.5
 * makes the stage advance on the ACK, so an unacked `delivered` relay is
 * precisely a relay still waiting for something that will now never come.
 * Refusing to cancel it would leave the reporting half of the defect open for
 * every relay that happened to be delivered first, which is most of them.
 *
 * **A delivery worker must still re-check `gate.closedAtMs` at send time**,
 * and that contract is kept rather than replaced by the cancellation. The
 * cancellation is a fact in the database and the send is an act outside it: a
 * worker that read the outbox row before this transaction committed is
 * holding a `pending` row that is already stale, and nothing in the schema
 * can reach into that worker's memory. The status is the belt; the send-time
 * re-check is the braces. No component in this branch does that check,
 * because the delivery driver does not exist here yet.
 *
 * @throws {GateClosedRefused} if the gate is closed with a *different*
 *   outcome, whether that was already true on entry or became true while
 *   this close was in flight.
 * @throws {InadmissibleTransitionRefused} if `outcome` is not reachable from
 *   the stage the gate is at ({@link CLOSE_OUTCOME_STAGES}).
 * @throws {TypeError} if `supersededBy` does not accompany exactly the
 *   `superseded` outcome, which the schema also enforces.
 */
export function closeGate(
  connection: SqliteDatabase,
  options: {
    readonly gateId: string;
    readonly outcome: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly occurredAtMs: number;
    readonly recordedAtMs: number;
    readonly supersededBy?: string | null;
    readonly writerEpoch?: number | null;
    readonly body?: string | null;
  },
): boolean {
  const {
    gateId,
    outcome,
    actorKind,
    actorId,
    occurredAtMs,
    recordedAtMs,
    supersededBy = null,
    writerEpoch = null,
    body = null,
  } = options;

  if (!GATE_OUTCOMES.includes(outcome)) {
    throw new TypeError(`'${outcome}' is not one of the section 9.4 outcomes`);
  }
  if ((outcome === "superseded") !== (supersededBy !== null)) {
    throw new TypeError("outcome 'superseded' carries supersededBy and no other outcome does");
  }
  const gate = _loadGate(connection, gateId);
  if (gate.closedAtMs !== null) {
    if (gate.outcome === outcome) {
      return false;
    }
    throw new GateClosedRefused(
      `gate ${gateId} is already closed as '${gate.outcome}'; it does not become '${outcome}'`,
    );
  }

  const eventType = outcome === "expired" ? "gate_expired" : "gate_closed";
  const appended = gatesSeams.appendEvent(connection, {
    eventId: `gate_closed/${gateId}`,
    eventType,
    subjectKind: "gate",
    subjectId: gateId,
    dedupKey: `gate_closed/${gateId}`,
    producer: WRITER,
    occurredAtMs,
    ingestedAtMs: recordedAtMs,
    runId: gate.runId,
    payload: pythonJsonObject([
      ["gate_id", gateId],
      ["gate_type", gate.gateType],
      ["stage", gate.stage],
      ["outcome", outcome],
    ]),
    sideEffect: (tx) => {
      _closeInTransaction(tx, {
        gateId,
        outcome,
        actorKind,
        actorId,
        occurredAtMs,
        recordedAtMs,
        supersededBy,
        writerEpoch,
        body,
      });
    },
  });
  if (!appended.duplicate) {
    return true;
  }

  // The duplicate is only an idempotent no-op if the closure already on the
  // spine is *this* closure. The pre-check above reads the gate outside the
  // append's transaction, so a second caller can pass it while a first caller
  // with a different outcome is mid-commit; the loser then collides on
  // 'gate_closed/<gateId>' -- one dedup key per gate, whatever the outcome --
  // and would otherwise be told its close was already done. Section 9.4's
  // taxonomy exists so that *which* outcome a gate reached is a fact a reader
  // can rely on, and returning false here for an 'expired' close of a gate
  // that actually closed 'withdrawn' hands the caller the one false fact this
  // function exists to prevent. So re-read and refuse, exactly as the
  // pre-check would have if it had run a moment later.
  const settled = _loadGate(connection, gateId);
  if (settled.closedAtMs !== null && settled.outcome === outcome) {
    return false;
  }
  if (settled.closedAtMs === null) {
    // The dedup key is on the spine with no closure behind it, which this
    // module never produces (the closure is the append's sideEffect and
    // commits with it). Something else wrote that identity; say so plainly
    // rather than reporting an outcome nobody recorded.
    throw new GateClosedRefused(
      `the closure identity 'gate_closed/${gateId}' is already on the ` +
        `spine but gate ${gateId} is open; it does not become '${outcome}'`,
    );
  }
  throw new GateClosedRefused(
    `gate ${gateId} was closed as '${settled.outcome}' by a concurrent ` +
      `writer while this close was in flight; it does not become '${outcome}'`,
  );
}

/**
 * Close every open gate whose subject run reached a terminal status.
 *
 * Section 9.4 says `subject_gone` "needs a mechanism, not just a name": the
 * outcome exists so that a gate whose worker is gone stops being an open row
 * that alarms forever, and without this sweep it would be an enumeration
 * member nothing ever writes -- the permanent-open-row problem with extra
 * vocabulary. Each closure also retires that gate's not-yet-acked relay (see
 * {@link closeGate}), for the same reason and in the same commit: a gate
 * closed here with a live message still queued has moved the permanently
 * alarming row from `gate` to `outbox` rather than removed it, and the
 * message would still be sent to somebody who is gone.
 * Terminal is the G1 set {@link TERMINAL_RUN_STATUSES}, which
 * `run_status_is_forward_only` makes an absorbing state, so a gate closed
 * here can never be wrong later.
 *
 * A gate's subject run is `gate.run_id` or, for a gate whose subject *is* a
 * run, `subject_id` -- both are checked, because `run_id` is nullable and a
 * gate that names its run only as the subject is the same situation.
 *
 * Each gate is closed in its **own** transaction rather than the sweep being
 * one: {@link closeGate} appends an event per closure, one transaction each,
 * and a kill part way through leaves the gates already closed closed and the
 * rest for the next pass. Batching them would buy atomicity nobody needs and
 * lose the partial progress that makes the pass restartable.
 */
export function sweepSubjectGone(
  connection: SqliteDatabase,
  options: { readonly nowMs: number; readonly actorId?: string },
): readonly string[] {
  const { nowMs, actorId = "reconcile" } = options;
  const placeholders = TERMINAL_RUN_STATUSES.map(() => "?").join(", ");
  const rows = connection
    .prepare<unknown[], { gate_id: string }>(
      `
        SELECT g.gate_id
          FROM gate g
          JOIN run r
            ON r.run_id = g.run_id
            OR (g.subject_kind = 'run' AND r.run_id = g.subject_id)
         WHERE g.closed_at_ms IS NULL
           AND r.status IN (${placeholders})
         GROUP BY g.gate_id
         ORDER BY g.gate_id
        `,
    )
    .all(...TERMINAL_RUN_STATUSES);
  const closed: string[] = [];
  for (const row of rows) {
    const gateId = row.gate_id;
    if (
      closeGate(connection, {
        gateId,
        outcome: "subject_gone",
        actorKind: "system",
        actorId,
        occurredAtMs: nowMs,
        recordedAtMs: nowMs,
      })
    ) {
      closed.push(gateId);
    }
  }
  return Object.freeze(closed);
}

// --------------------------------------------------------------------------
// reading -- the reconcile pass's three gate queries (sections 5.6, 9.6)
// --------------------------------------------------------------------------

/** One acked relay whose advance never landed. */
export interface GateNeedingAdvance {
  readonly gateId: string;
  readonly toStage: string;
  readonly messageId: string;
  readonly ackedAtMs: number;
  readonly stage: string;
}

/**
 * Acked relays whose advance never landed -- the section 9.5 kill-point-4 recovery.
 *
 * This is a *completion*, not an incident: the ack is durable, the human has
 * seen the question or the worker has the answer, and only our own write is
 * missing. The caller feeds each row to {@link advanceOnAck}, which is
 * guarded by the same admissibility check as any other advance and returns
 * `false` if a concurrent pass got there first.
 */
export function gatesNeedingAdvance(connection: SqliteDatabase): readonly GateNeedingAdvance[] {
  const rows = connection
    .prepare<
      [],
      {
        gate_id: string;
        to_stage: string;
        message_id: string;
        acked_at_ms: number;
        stage: string;
      }
    >(
      `
        SELECT r.gate_id, r.to_stage, r.message_id, o.acked_at_ms, g.stage
          FROM gate_relay r
          JOIN outbox o ON o.message_id = r.message_id
          JOIN gate   g ON g.gate_id = r.gate_id
         WHERE o.status = 'acked'
           AND g.closed_at_ms IS NULL
           AND NOT EXISTS (SELECT 1 FROM gate_transition t
                            WHERE t.gate_id = r.gate_id
                              AND t.transition_kind = 'advance'
                              AND t.to_stage = r.to_stage)
         ORDER BY r.gate_id, r.to_stage
        `,
    )
    .all();
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        gateId: row.gate_id,
        toStage: row.to_stage,
        messageId: row.message_id,
        ackedAtMs: Number(row.acked_at_ms),
        stage: row.stage,
      }),
    ),
  );
}

/** One open gate aged past its stage's tolerance. */
export interface RelayGap {
  readonly gateId: string;
  readonly gateType: string;
  readonly stage: string;
  readonly stageEnteredAtMs: number;
  readonly ageMs: number;
}

/**
 * Open gates aged past their stage's tolerance -- section 9.6, verbatim.
 *
 * Two properties of the query are the design and not an implementation
 * detail. It binds **one** policy revision, chosen once in the `effective`
 * CTE: policy rows are versioned and never updated in place, so a join
 * without a `revision_id` predicate matches every historical tolerance and
 * emits one row per revision ever recorded (`D-0031`). And `presented` opts
 * out through `tolerance_ms IS NULL` in the data rather than through a branch
 * here -- "a slow human is not a gap" is a fact about the stage, so it lives
 * where the other facts about the stage live, and a stage that later acquires
 * a tolerance needs no code change to start being aged.
 *
 * **Known hole, stated rather than silently carried.** The inner join means a
 * gate whose `gate_type` has *no* tolerance rows at all is never aged, in any
 * stage, and no refusal marks that. `0002_policy_seed.sql` deliberately seeds
 * no rows for `plan_approval` or `risk_approval` -- `time-base-policy.md`
 * decides no numbers for them and seeding invented ones in a migration is
 * exactly what `D-0031` forbids -- so a gate of either type is unpoliced
 * today and reads, from this query, exactly like a gate that is not late.
 * This is the difference between the two shapes of "undecided":
 * `policy.gateStageTolerance` raises `PolicyRowMissing` rather than let an
 * undecided gate type be silently unpoliced, and the watcher side has
 * `watcher_scope_uncovered` as a named incident class for the same
 * situation; the detector here has neither, and there is no
 * `gate_type_unpoliced` counterpart to raise. It is a design-level hole and
 * not a transcription error: the section 9.6 query is written this way in
 * the design itself, an inner join with no coverage check, so closing it
 * means deciding a new incident class, not fixing this function.
 *
 * The row this returns names no owner; see the module docstring for why that
 * is the caller's join and which caller is missing.
 */
export function relayGaps(
  connection: SqliteDatabase,
  options: { readonly nowMs: number },
): readonly RelayGap[] {
  const { nowMs } = options;
  const rows = connection
    .prepare<
      { now_ms: number },
      {
        gate_id: string;
        gate_type: string;
        stage: string;
        stage_entered_at_ms: number;
        age_ms: number;
      }
    >(
      `
        WITH effective AS (
            SELECT revision_id FROM policy_revision
             WHERE effective_at_ms <= :now_ms
             ORDER BY effective_at_ms DESC, revision_id DESC
             LIMIT 1)
        SELECT g.gate_id, g.gate_type, g.stage, g.stage_entered_at_ms,
               :now_ms - g.stage_entered_at_ms AS age_ms
          FROM gate g
          JOIN policy_gate_stage_tolerance p
            ON p.gate_type = g.gate_type AND p.stage = g.stage
           AND p.revision_id = (SELECT revision_id FROM effective)
         WHERE g.closed_at_ms IS NULL
           AND p.tolerance_ms IS NOT NULL
           AND :now_ms - g.stage_entered_at_ms > p.tolerance_ms
         ORDER BY g.gate_id
        `,
    )
    .all({ now_ms: nowMs });
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        gateId: row.gate_id,
        gateType: row.gate_type,
        stage: row.stage,
        stageEnteredAtMs: Number(row.stage_entered_at_ms),
        ageMs: Number(row.age_ms),
      }),
    ),
  );
}

/** One relay enqueued and never acked. */
export interface StalledRelay {
  readonly gateId: string;
  readonly toStage: string;
  readonly retryCount: number;
  readonly ageMs: number;
}

/**
 * Relays enqueued and never acked -- a delivery stall, not a stage stall.
 *
 * Section 9.6 keeps this separate from {@link relayGaps} because the two have
 * different remedies and different owners: a stage stall means whoever holds
 * the ball has not acted, while this means the message never got there. They
 * are only distinguishable *because* the advance is ack-gated -- if the stage
 * moved on the send, an undelivered relay would look like a gate that had
 * progressed normally, and the fault would surface later as a human who never
 * answered a question they never received.
 *
 * **There is still no `closed_at_ms` predicate here, and there should not
 * be.** Section 9.6 writes the query without one and it is transcribed as
 * written; what used to make that a hole -- a relay on a closed gate reported
 * forever, because closing could not retire the outbox row -- is closed on
 * the `outbox` side instead: {@link closeGate} cancels every not-yet-acked
 * relay of the gate it closes, and `cancelled` is outside the predicate
 * below. Excluding closed *gates* here would have been half a fix, silencing
 * the report while a delivery worker went on sending the message; retiring
 * the message stops both. The status is the state and this query reads the
 * state.
 */
export function stalledRelays(
  connection: SqliteDatabase,
  options: { readonly nowMs: number; readonly toleranceMs: number },
): readonly StalledRelay[] {
  const { nowMs, toleranceMs } = options;
  const rows = connection
    .prepare<
      { now_ms: number; tolerance_ms: number },
      { gate_id: string; to_stage: string; retry_count: number; age_ms: number }
    >(
      `
        SELECT r.gate_id, r.to_stage, o.retry_count,
               :now_ms - r.enqueued_at_ms AS age_ms
          FROM gate_relay r
          JOIN outbox o ON o.message_id = r.message_id
         WHERE o.status IN ('pending', 'delivered')
           AND :now_ms - r.enqueued_at_ms > :tolerance_ms
         ORDER BY r.gate_id, r.to_stage
        `,
    )
    .all({ now_ms: nowMs, tolerance_ms: toleranceMs });
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        gateId: row.gate_id,
        toStage: row.to_stage,
        retryCount: Number(row.retry_count),
        ageMs: Number(row.age_ms),
      }),
    ),
  );
}

/** One open gate whose own deadline has passed. */
export interface GatePastDeadline {
  readonly gateId: string;
  readonly gateType: string;
  readonly stage: string;
  readonly deadlineAtMs: number;
  readonly overdueMs: number;
}

/**
 * Open gates whose own `deadline_at_ms` has passed -- candidates for `expired`.
 *
 * Section 9.2 separates the business deadline from a relay tolerance, and
 * this is the reader of the former: a deadline is owned by whoever set it and
 * its consequence is an outcome on the gate, while a tolerance is a property
 * of a stage and its consequence is a `relay_gap` incident. It is what
 * governs the `presented -> answered` leg, which has no tolerance at all.
 *
 * The window is half-open `[created_at_ms, deadline_at_ms)`
 * (`docs/time-base-policy.md` section 2), so a gate is past its deadline at
 * `nowMs == deadlineAtMs` and not a millisecond later.
 *
 * This **names candidates and pronounces no verdict** (`D-0008`): section 9.4
 * makes expiry conditional on "the gate's policy says expire", and no such
 * policy is decided in `time-base-policy.md`, so inventing one here would be
 * deciding policy in code. The caller closes.
 */
export function gatesPastDeadline(
  connection: SqliteDatabase,
  options: { readonly nowMs: number },
): readonly GatePastDeadline[] {
  const { nowMs } = options;
  const rows = connection
    .prepare<
      { now_ms: number },
      {
        gate_id: string;
        gate_type: string;
        stage: string;
        deadline_at_ms: number;
        overdue_ms: number;
      }
    >(
      `
        SELECT gate_id, gate_type, stage, deadline_at_ms,
               :now_ms - deadline_at_ms AS overdue_ms
          FROM gate
         WHERE closed_at_ms IS NULL
           AND deadline_at_ms IS NOT NULL
           AND deadline_at_ms <= :now_ms
         ORDER BY gate_id
        `,
    )
    .all({ now_ms: nowMs });
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        gateId: row.gate_id,
        gateType: row.gate_type,
        stage: row.stage,
        deadlineAtMs: Number(row.deadline_at_ms),
        overdueMs: Number(row.overdue_ms),
      }),
    ),
  );
}

// --------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------

/**
 * Refuse any (fromStage, toStage, kind) not in {@link ADMISSIBLE}, and any wrong actor.
 *
 * The two refusals are one function because they are one table row: an edge
 * whose actor does not match is as absent from section 9.3 as an edge that
 * was never written down, and reporting them differently would suggest the
 * caller could fix the second by retrying.
 */
function _requireActor(
  fromStage: string | null,
  toStage: string,
  kind: string,
  actorKind: string,
): void {
  for (const edge of ADMISSIBLE) {
    if (edge.fromStage === fromStage && edge.toStage === toStage && edge.kind === kind) {
      if (edge.actorKinds.has(actorKind)) {
        return;
      }
      throw new InadmissibleTransitionRefused(
        `${pyStr(fromStage)} -> ${toStage} (${kind}) is a ` +
          `${pyList(Array.from(edge.actorKinds).sort())} edge; '${actorKind}' may not take it`,
      );
    }
  }
  throw new InadmissibleTransitionRefused(
    `${pyStr(fromStage)} -> ${toStage} (${kind}) is not an admissible edge; ` +
      "there is no backwards edge -- re-ask as a new gate linked by superseded_by",
  );
}

function _loadGate(connection: SqliteDatabase, gateId: string): GateRow {
  const row = connection
    .prepare<
      [string],
      {
        gate_id: string;
        gate_type: string;
        run_id: string | null;
        stage: string;
        stage_seq: number | null;
        stage_entered_at_ms: number;
        outcome: string | null;
        closed_at_ms: number | null;
        deadline_at_ms: number | null;
        created_at_ms: number;
      }
    >(
      `
        SELECT gate_id, gate_type, run_id, stage, stage_seq, stage_entered_at_ms,
               outcome, closed_at_ms, deadline_at_ms, created_at_ms
          FROM gate WHERE gate_id = ?
        `,
    )
    .get(gateId);
  if (row === undefined) {
    throw new UnknownGateRefused(`no gate '${gateId}'`);
  }
  return Object.freeze({
    gateId: row.gate_id,
    gateType: row.gate_type,
    runId: row.run_id,
    stage: row.stage,
    stageSeq: row.stage_seq === null ? null : Number(row.stage_seq),
    stageEnteredAtMs: Number(row.stage_entered_at_ms),
    outcome: row.outcome,
    closedAtMs: row.closed_at_ms === null ? null : Number(row.closed_at_ms),
    deadlineAtMs: row.deadline_at_ms === null ? null : Number(row.deadline_at_ms),
    createdAtMs: Number(row.created_at_ms),
  });
}

function _ackedRelayMessage(connection: SqliteDatabase, gateId: string, toStage: string): string {
  const row = connection
    .prepare<[string, string], { message_id: string; status: string }>(
      `
        SELECT r.message_id, o.status
          FROM gate_relay r JOIN outbox o ON o.message_id = r.message_id
         WHERE r.gate_id = ? AND r.to_stage = ?
        `,
    )
    .get(gateId, toStage);
  if (row === undefined) {
    throw new RelayNotAckedRefused(
      `gate ${gateId} has no relay for '${toStage}'; the stage follows the ack`,
    );
  }
  if (row.status !== "acked") {
    throw new RelayNotAckedRefused(
      `the '${toStage}' relay of gate ${gateId} is '${row.status}', not 'acked'; ` +
        "advancing on the send is what loses a relay or duplicates a question",
    );
  }
  return row.message_id;
}

function _insertTransition(
  connection: SqliteDatabase,
  options: {
    readonly gateId: string;
    readonly transitionKind: string;
    readonly fromStage: string | null;
    readonly toStage: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly occurredAtMs: number;
    readonly recordedAtMs: number;
    readonly writerEpoch?: number | null;
    readonly messageId?: string | null;
    readonly body?: string | null;
    readonly supersedesSeq?: number | null;
  },
): number {
  const {
    gateId,
    transitionKind,
    fromStage,
    toStage,
    actorKind,
    actorId,
    occurredAtMs,
    recordedAtMs,
    writerEpoch = null,
    messageId = null,
    body = null,
    supersedesSeq = null,
  } = options;
  const cursor = connection
    .prepare<
      [
        string,
        string,
        string | null,
        string,
        string,
        string,
        number | null,
        string | null,
        string | null,
        number | null,
        number,
        number,
      ]
    >(
      `
        INSERT INTO gate_transition (gate_id, transition_kind, from_stage, to_stage,
                                     actor_kind, actor_id, writer_epoch, message_id,
                                     body, supersedes_seq, occurred_at_ms, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
    )
    .run(
      gateId,
      transitionKind,
      fromStage,
      toStage,
      actorKind,
      actorId,
      writerEpoch,
      messageId,
      body,
      supersedesSeq,
      occurredAtMs,
      recordedAtMs,
    );
  return Number(cursor.lastInsertRowid);
}

/**
 * The close itself, re-validated inside the append transaction.
 *
 * The caller's pre-check answered "is this already done?"; this answers "is
 * it still allowed?" against rows read under the write lock, so a gate closed
 * by somebody else between the two raises here and takes the event down with
 * it rather than committing an announcement of a closure that did not
 * happen.
 */
function _closeInTransaction(
  connection: SqliteDatabase,
  options: {
    readonly gateId: string;
    readonly outcome: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly occurredAtMs: number;
    readonly recordedAtMs: number;
    readonly supersededBy: string | null;
    readonly writerEpoch: number | null;
    readonly body: string | null;
  },
): void {
  const {
    gateId,
    outcome,
    actorKind,
    actorId,
    occurredAtMs,
    recordedAtMs,
    supersededBy,
    writerEpoch,
    body,
  } = options;

  const gate = _loadGate(connection, gateId);
  if (gate.closedAtMs !== null) {
    throw new GateClosedRefused(
      `gate ${gateId} was closed as '${gate.outcome}' while this close ran`,
    );
  }
  const stage = gate.stage;
  _requireActor(stage, stage, "close", actorKind);
  const reachableFrom = CLOSE_OUTCOME_STAGES[outcome];
  // Python subscripts the mapping (`CLOSE_OUTCOME_STAGES[outcome]`), so an
  // outcome the table has no entry for is a hard KeyError there. Rendering the
  // missing entry as an empty list instead would answer a build defect with a
  // refusal about the caller's stage -- "reached from [], not from 'answered'"
  // reads as a fact about this gate rather than as a table with a hole in it.
  // Unreachable while the outcome vocabulary is validated above, which is
  // exactly why the miss has to fail loudly rather than be papered over.
  if (reachableFrom === undefined) {
    throw new TypeError(`no CLOSE_OUTCOME_STAGES entry for outcome '${outcome}'`);
  }
  if (!reachableFrom.has(stage)) {
    throw new InadmissibleTransitionRefused(
      `outcome '${outcome}' is reached from ` +
        `${pyList(Array.from(reachableFrom).sort())}, not from '${stage}'`,
    );
  }
  _insertTransition(connection, {
    gateId,
    transitionKind: "close",
    fromStage: stage,
    toStage: stage,
    actorKind,
    actorId,
    occurredAtMs,
    recordedAtMs,
    writerEpoch,
    body,
  });
  // stage / stage_seq are deliberately untouched: a close is not a stage
  // change, and the stage a gate was closed at is part of what the taxonomy
  // means (an 'expired' at 'answered' is a different failure from one at
  // 'presented').
  connection
    .prepare<[string, number, string | null, string]>(
      `
        UPDATE gate SET outcome = ?, closed_at_ms = ?, superseded_by = ?
         WHERE gate_id = ?
        `,
    )
    .run(outcome, recordedAtMs, supersededBy, gateId);
  // And retire the relays nobody is waiting for any more, in this same
  // transaction as the closure (see closeGate for the argument). The
  // predicate names the two live statuses rather than excluding 'acked',
  // because the row must also not be moved out of 'cancelled' -- a second
  // close sweep over the same gate would otherwise hit
  // outbox_status_is_forward_only, which has no edge out of a terminal
  // status, and turn an idempotent re-run into an integrity error.
  connection
    .prepare<[string]>(
      `
        UPDATE outbox
           SET status = 'cancelled'
         WHERE status IN ('pending', 'delivered')
           AND message_id IN (SELECT message_id FROM gate_relay WHERE gate_id = ?)
        `,
    )
    .run(gateId);
}

/** `null` as Python would render it in an f-string; a string is itself. */
function pyStr(value: string | null): string {
  return value === null ? "None" : value;
}

/** `repr(sorted(...))`-shaped text: a Python list of single-quoted strings. */
function pyList(values: readonly string[]): string {
  return `[${values.map((v) => `'${v}'`).join(", ")}]`;
}

/** A Python tuple of single-quoted strings, for a tuple constant's repr. */
function pyTuple(values: readonly string[]): string {
  return `(${values.map((v) => `'${v}'`).join(", ")})`;
}
