/**
 * The operator's side of a human gate: the composite operations the `gate`
 * verbs call, one entry point each.
 *
 * **Why this is a package of its own and not `control_plane/gate_cli.ts`.**
 * `src/control_plane/gates.ts` holds the primitives -- `openGate`,
 * `enqueueRelay`, `advanceOnAck`, `closeGate`, and the five idle detectors --
 * and it is right that it holds nothing else: every rule about what a
 * transition *is* belongs there and is stated once. What is missing between
 * those primitives and a command line is the ordering, and the ordering needs
 * the delivery side as well: `deliverRelays` builds a {@link MessageBus} over
 * the same outbox the endpoint drives. `src/messagebus/` imports the control
 * plane, so a module inside `src/control_plane/` that imported the messagebus
 * back would close a package cycle. This package is where both are reachable,
 * exactly as `src/lap/` is the one place the workspace, the session and the
 * control plane meet (`docs/design/composition-root-placement.md`).
 *
 * **Who acts, and why lap 1 answers it this way (`D-0076`).** Both relays are
 * addressed to `external-notify`, whose effect is a write into a
 * {@link KeyedDropbox} directory, and the operator reads that directory. The
 * endpoint refuses at startup a recipient no handler serves and the registry
 * supplies exactly two: `external-notify`, and a human-gated handler that by
 * design delivers nothing. A third handler would be a third name for the same
 * directory -- lap 1's reader is a person either way -- and the real transport
 * is deferred by section 3.1 of the design rather than owed here.
 *
 * **Why a verb delivers at all (`D-0080`).** The `poll`/`ack` endpoint is
 * worker-facing, pinned to one recipient, and launched by `lap perform` as the
 * worker's stdio child. The gate over a turn's escalation is opened *after*
 * that turn has ended (`ingestTerminalReport`, `D-0056`), so by the time a
 * relay exists there is no endpoint alive to poll it and no worker to ack it.
 * A relay enqueued and never polled is a question nobody is ever asked, which
 * is the failure a green suite hides best. {@link deliverRelays} is the
 * operator's delivery worker: it takes the one delivery lease
 * ({@link DELIVERY_LEASE_RESOURCE}, `D-0053` rule 4), polls once, and releases.
 * Holding the same single resource is what serialises it against a running lap
 * rather than letting two writers advance one outbox.
 *
 * **What this module does not decide.** No tolerance and no expiry policy.
 * {@link reconcile} advances what an ack already justified and closes what a
 * terminal run already settled; everything else it *reports*, because
 * `docs/time-base-policy.md` decides no expiry rule and inventing one here
 * would be deciding policy in code (`D-0008`, `D-0079`).
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { KeyedDropbox } from "../control_plane/destination.js";
import {
  AnswerBodyRequired,
  advanceOnAck,
  closeGate,
  enqueueRelay,
  type GateNeedingAdvance,
  type GatePastDeadline,
  GateRefusal,
  gatesNeedingAdvance,
  gatesPastDeadline,
  type RelayGap,
  relayGaps,
  type StalledRelay,
  stalledRelays,
  sweepSubjectGone,
  UnknownGateRefused,
} from "../control_plane/gates.js";
import { NOTIFY_RECIPIENT, spikeRegistry } from "../control_plane/handlers.js";
import { acquire, release } from "../control_plane/lease.js";
import { HandlerRegistry, Outbox } from "../control_plane/outbox.js";
import { pythonJsonObject } from "../control_plane/python_json.js";
import { DELIVERY_LEASE_RESOURCE } from "../messagebus/endpoint.js";
import { MessageBus } from "../messagebus/index.js";

/**
 * The recipient both relays address. See the module docstring and `D-0076`.
 *
 * Re-exported from the handler that serves it rather than spelled again: the
 * endpoint matches `outbox.recipient` against that constant as a literal, so a
 * second copy here would keep this package compiling on the day the handler's
 * name changed and leave every relay addressed to a queue nothing serves.
 */
export const GATE_RELAY_RECIPIENT = NOTIFY_RECIPIENT;

/**
 * **Why the enqueue sites take no recipient argument.** `enqueueRelay` writes
 * the recipient onto the `outbox` row and the `(gate_id, to_stage)` primary key
 * then makes that row final: a re-enqueue returns the id already in force
 * rather than re-addressing it. So a recipient chosen per call is a recipient
 * that can be chosen WRONG once and never corrected -- `answerGate` would
 * commit the `answered` transition, enqueue the forward relay to a queue no
 * handler serves, and leave a gate that is answered, cannot be delivered, and
 * cannot be re-addressed. Since `D-0076` gives lap 1 exactly one relay
 * recipient, the safe shape and the honest one are the same: the enqueue sites
 * read the constant. {@link ackRelay} and {@link deliverRelays} still take one,
 * because neither writes it -- the first compares it and the second polls with
 * it after checking the registry serves it.
 */

/** The actor kind a relay's ack advance is recorded under (section 9.3). */
const RELAY_ADVANCE_ACTOR_KIND = "secretary";

/**
 * The outcomes a `gate` verb may write, and the ones it may not.
 *
 * `answered_and_forwarded` is absent because it is not a decision: section 9.3
 * gives the close out of `forwarded` to actor `system` alone, as the
 * consequence of the forward relay's ack, and {@link ackRelay} is where that
 * ack is recorded. `subject_gone` and `superseded` are absent for the same
 * reason from the other end -- the first is {@link reconcile}'s sweep over
 * terminal runs, and the second is written by whichever gate supersedes this
 * one, never by a hand naming an outcome.
 */
export const OPERATOR_CLOSE_OUTCOMES: readonly string[] = Object.freeze([
  "withdrawn",
  "expired",
  "unanswerable",
]);

/**
 * A second answer, offered to a gate that already carries one.
 *
 * Its own class rather than a silent drop, and rather than
 * {@link InadmissibleTransitionRefused}: the two outcomes a caller must be able
 * to tell apart are "already done, identically" and "this may not happen", and
 * a repeat carrying a DIFFERENT body is the second. Correcting a recorded
 * answer is `recordCorrection`'s edge (section 9.3), which carries a
 * `supersedes_seq` so the history shows both answers; no verb writes it yet, so
 * offering a different body here is refused rather than absorbed.
 */
export class AnswerAlreadyRecorded extends GateRefusal {
  constructor(message: string) {
    super(message);
    this.name = "AnswerAlreadyRecorded";
    // The prototype is reset for the reason every refusal in `gates.ts` resets
    // its own: `GateRefusal`'s constructor pins `GateRefusal.prototype`, so
    // without this an `instanceof` for this class is false and every caller
    // that distinguishes refusals sees the base class instead.
    Object.setPrototypeOf(this, AnswerAlreadyRecorded.prototype);
  }
}

/**
 * A close as `expired` on a gate whose deadline has not passed.
 */
export class DeadlineNotPassed extends GateRefusal {
  constructor(message: string) {
    super(message);
    this.name = "DeadlineNotPassed";
    Object.setPrototypeOf(this, DeadlineNotPassed.prototype);
  }
}

/**
 * The message id a relay is enqueued under.
 *
 * Derived rather than generated, so that this module reads no clock and no
 * randomness and a re-run of a verb killed after its commit collides with the
 * row already in force instead of writing a second message. `enqueueRelay`'s
 * `(gate_id, to_stage)` primary key is what makes the enqueue idempotent; this
 * only makes the *id* the same on both sides of a crash, which is what lets an
 * operator name it in `gate ack` without looking it up first.
 */
export function relayMessageId(gateId: string, toStage: string): string {
  return `relay/${gateId}/${toStage}`;
}

/** One open gate, as `gate list` reports it. */
export interface OpenGateSummary {
  readonly gateId: string;
  readonly gateType: string;
  readonly runId: string | null;
  readonly stage: string;
  readonly stageEnteredAtMs: number;
  readonly deadlineAtMs: number | null;
  readonly rationale: string;
}

/** One relay of one gate, with the delivery state of its outbox row. */
export interface RelayView {
  readonly toStage: string;
  readonly messageId: string;
  readonly recipient: string;
  readonly status: string;
  readonly retryCount: number;
  readonly enqueuedAtMs: number;
  readonly deliveredAtMs: number | null;
  readonly ackedAtMs: number | null;
}

/** One row of the gate's immutable transition history. */
export interface TransitionView {
  readonly seq: number;
  readonly transitionKind: string;
  readonly fromStage: string | null;
  readonly toStage: string;
  readonly actorKind: string;
  readonly actorId: string;
  readonly recordedAtMs: number;
  readonly body: string | null;
}

/** Everything `gate show` prints about one gate. */
export interface GateDetail {
  readonly gateId: string;
  readonly gateType: string;
  readonly runId: string | null;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly rationale: string;
  /** The answer vocabulary, as the JSON array text the row carries. */
  readonly options: string;
  readonly stage: string;
  readonly stageEnteredAtMs: number;
  readonly deadlineAtMs: number | null;
  readonly outcome: string | null;
  readonly closedAtMs: number | null;
  readonly relays: readonly RelayView[];
  readonly transitions: readonly TransitionView[];
}

/** What {@link presentGate} and {@link answerGate} put on the queue. */
export interface RelayEnqueued {
  readonly messageId: string;
  readonly toStage: string;
  /** Whether this call wrote the row, as opposed to finding it already there. */
  readonly enqueued: boolean;
}

/** What {@link answerGate} did. */
export interface AnswerRecorded extends RelayEnqueued {
  /** Whether this call moved the stage to `answered`. */
  readonly advanced: boolean;
}

/** What {@link ackRelay} did, in the order it did it. */
export interface AckRecorded {
  readonly messageId: string;
  readonly toStage: string;
  readonly gateId: string;
  /** Whether this call recorded the ack (`false` is a repeat or a cancelled row). */
  readonly acked: boolean;
  /** Whether the row had been cancelled by a gate closure before the ack. */
  readonly cancelled: boolean;
  /** Whether this call moved the stage. */
  readonly advanced: boolean;
  /** Whether this call closed the gate as `answered_and_forwarded`. */
  readonly closed: boolean;
}

/** One delivery attempt's outcome, as `gate deliver` reports it. */
export interface DeliveredRelay {
  readonly messageId: string;
  readonly recipient: string;
  readonly dedupKey: string;
}

/** What {@link deliverRelays} did under the lease it took. */
export interface DeliveryReport {
  readonly recipient: string;
  readonly epoch: number;
  readonly delivered: readonly DeliveredRelay[];
}

/** What {@link reconcile} settled, and what it only found. */
export interface ReconcileReport {
  /** Gates closed `subject_gone` because their run reached a terminal status. */
  readonly subjectGone: readonly string[];
  /** Advances an ack had already justified and a kill had lost (section 9.5). */
  readonly advanced: readonly GateNeedingAdvance[];
  /** Gates closed `answered_and_forwarded` by the advances above. */
  readonly closed: readonly string[];
  /** Open gates aged past their stage's tolerance. Reported, never acted on. */
  readonly relayGaps: readonly RelayGap[];
  /**
   * Relays enqueued and never acked, or `null` when no tolerance was given.
   *
   * `null` rather than an empty list, because "nobody asked" and "nothing is
   * stalled" are different facts and a caller printing them the same way would
   * report a clean delivery queue it never looked at.
   */
  readonly stalledRelays: readonly StalledRelay[] | null;
  /** Open gates past their own deadline. Candidates; this pronounces no verdict. */
  readonly pastDeadline: readonly GatePastDeadline[];
}

// --------------------------------------------------------------------------
// reading
// --------------------------------------------------------------------------

/** Every open gate, oldest stage entry first. */
export function openGates(connection: SqliteDatabase): readonly OpenGateSummary[] {
  const rows = connection
    .prepare<
      [],
      {
        gate_id: string;
        gate_type: string;
        run_id: string | null;
        stage: string;
        stage_entered_at_ms: number;
        deadline_at_ms: number | null;
        rationale: string;
      }
    >(
      `
        SELECT gate_id, gate_type, run_id, stage, stage_entered_at_ms,
               deadline_at_ms, rationale
          FROM gate
         WHERE closed_at_ms IS NULL
         ORDER BY stage_entered_at_ms, gate_id
        `,
    )
    .all();
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        gateId: row.gate_id,
        gateType: row.gate_type,
        runId: row.run_id,
        stage: row.stage,
        stageEnteredAtMs: Number(row.stage_entered_at_ms),
        deadlineAtMs: row.deadline_at_ms === null ? null : Number(row.deadline_at_ms),
        rationale: row.rationale,
      }),
    ),
  );
}

/**
 * One gate, its relays and its whole transition history.
 *
 * @throws {UnknownGateRefused} if `gateId` names no gate. The same refusal
 *   `gates.ts` raises for the same situation, so a mistyped id reads the same
 *   way whichever verb the operator typed.
 */
export function gateDetail(connection: SqliteDatabase, gateId: string): GateDetail {
  const row = connection
    .prepare<
      [string],
      {
        gate_id: string;
        gate_type: string;
        run_id: string | null;
        subject_kind: string;
        subject_id: string;
        rationale: string;
        options: string;
        stage: string;
        stage_entered_at_ms: number;
        deadline_at_ms: number | null;
        outcome: string | null;
        closed_at_ms: number | null;
      }
    >(
      `
        SELECT gate_id, gate_type, run_id, subject_kind, subject_id, rationale,
               options, stage, stage_entered_at_ms, deadline_at_ms, outcome,
               closed_at_ms
          FROM gate
         WHERE gate_id = ?
        `,
    )
    .get(gateId);
  if (row === undefined) {
    throw new UnknownGateRefused(`gate ${gateId} does not exist`);
  }
  const relays = connection
    .prepare<
      [string],
      {
        to_stage: string;
        message_id: string;
        recipient: string;
        status: string;
        retry_count: number;
        enqueued_at_ms: number;
        delivered_at_ms: number | null;
        acked_at_ms: number | null;
      }
    >(
      `
        SELECT r.to_stage, r.message_id, o.recipient, o.status, o.retry_count,
               r.enqueued_at_ms, o.delivered_at_ms, o.acked_at_ms
          FROM gate_relay r
          JOIN outbox o ON o.message_id = r.message_id
         WHERE r.gate_id = ?
         ORDER BY r.enqueued_at_ms, r.to_stage
        `,
    )
    .all(gateId);
  const transitions = connection
    .prepare<
      [string],
      {
        seq: number;
        transition_kind: string;
        from_stage: string | null;
        to_stage: string;
        actor_kind: string;
        actor_id: string;
        recorded_at_ms: number;
        body: string | null;
      }
    >(
      `
        SELECT seq, transition_kind, from_stage, to_stage, actor_kind, actor_id,
               recorded_at_ms, body
          FROM gate_transition
         WHERE gate_id = ?
         ORDER BY seq
        `,
    )
    .all(gateId);
  return Object.freeze({
    gateId: row.gate_id,
    gateType: row.gate_type,
    runId: row.run_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    rationale: row.rationale,
    options: row.options,
    stage: row.stage,
    stageEnteredAtMs: Number(row.stage_entered_at_ms),
    deadlineAtMs: row.deadline_at_ms === null ? null : Number(row.deadline_at_ms),
    outcome: row.outcome,
    closedAtMs: row.closed_at_ms === null ? null : Number(row.closed_at_ms),
    relays: Object.freeze(
      relays.map((relay) =>
        Object.freeze({
          toStage: relay.to_stage,
          messageId: relay.message_id,
          recipient: relay.recipient,
          status: relay.status,
          retryCount: Number(relay.retry_count),
          enqueuedAtMs: Number(relay.enqueued_at_ms),
          deliveredAtMs: relay.delivered_at_ms === null ? null : Number(relay.delivered_at_ms),
          ackedAtMs: relay.acked_at_ms === null ? null : Number(relay.acked_at_ms),
        }),
      ),
    ),
    transitions: Object.freeze(
      transitions.map((transition) =>
        Object.freeze({
          seq: Number(transition.seq),
          transitionKind: transition.transition_kind,
          fromStage: transition.from_stage,
          toStage: transition.to_stage,
          actorKind: transition.actor_kind,
          actorId: transition.actor_id,
          recordedAtMs: Number(transition.recorded_at_ms),
          body: transition.body,
        }),
      ),
    ),
  });
}

// --------------------------------------------------------------------------
// the two relays
// --------------------------------------------------------------------------

/**
 * The question, as the payload the recipient receives.
 *
 * The gate's own columns and nothing else. In particular it carries no
 * provider detail and no transcript: what a human is asked to decide is the
 * rationale the ingress recorded and the options the gate was opened with
 * (`D-0056`), and a payload that reached for anything else would put words in
 * front of an approver that the gate never promised were the subject's.
 */
function presentedPayload(gate: GateDetail): string {
  return pythonJsonObject([
    ["gate_id", gate.gateId],
    ["gate_type", gate.gateType],
    ["options", gate.options],
    ["rationale", gate.rationale],
    ["run_id", gate.runId ?? ""],
    ["stage", "presented"],
    ["subject_id", gate.subjectId],
    ["subject_kind", gate.subjectKind],
  ]);
}

/** The answer, as the payload the forward relay carries onward. */
function forwardedPayload(gate: GateDetail, body: string): string {
  return pythonJsonObject([
    ["answer", body],
    ["gate_id", gate.gateId],
    ["gate_type", gate.gateType],
    ["run_id", gate.runId ?? ""],
    ["stage", "forwarded"],
    ["subject_id", gate.subjectId],
    ["subject_kind", gate.subjectKind],
  ]);
}

/**
 * The answer this gate carries, read off its `answered` advance.
 *
 * The transition rather than the caller's argument, because the transition is
 * where the answer is durable: `answered` is not a relayed stage, so the `body`
 * on that row is the whole of the evidence the question was answered.
 */
function recordedAnswer(connection: SqliteDatabase, gateId: string): string | null {
  const body = connection
    .prepare<[string], string | null>(
      `
        SELECT body
          FROM gate_transition
         WHERE gate_id = ? AND transition_kind = 'advance' AND to_stage = 'answered'
         ORDER BY seq DESC
         LIMIT 1
        `,
    )
    .pluck()
    .get(gateId);
  return body ?? null;
}

/** Whether this gate already has a relay for `toStage`. */
function relayExists(connection: SqliteDatabase, gateId: string, toStage: string): boolean {
  return (
    connection
      .prepare<[string, string], { one: number }>(
        "SELECT 1 AS one FROM gate_relay WHERE gate_id = ? AND to_stage = ?",
      )
      .get(gateId, toStage) !== undefined
  );
}

/**
 * Put the open question in front of its recipient: the `presented` relay.
 *
 * Enqueues only. Delivery is {@link deliverRelays}, and the stage moves on the
 * ack rather than on the send -- which is what keeps "the human has not
 * answered" distinguishable from "the message never got there" (section 9.6).
 *
 * @throws {UnknownGateRefused} if `gateId` names no gate.
 * @throws {GateClosedRefused} if the gate has closed.
 * @throws {InadmissibleTransitionRefused} if the gate is not at `received`;
 *   a relay enqueued before the gate reaches the stage it answers can be acked
 *   early, and `enqueueRelay` refuses it for that reason.
 */
export function presentGate(
  connection: SqliteDatabase,
  options: {
    readonly gateId: string;
    readonly nowMs: number;
  },
): RelayEnqueued {
  const { gateId, nowMs } = options;
  const recipient = GATE_RELAY_RECIPIENT;
  const gate = gateDetail(connection, gateId);
  const existed = relayExists(connection, gateId, "presented");
  const messageId = enqueueRelay(connection, {
    gateId,
    toStage: "presented",
    recipient,
    payload: presentedPayload(gate),
    messageId: relayMessageId(gateId, "presented"),
    enqueuedAtMs: nowMs,
  });
  return Object.freeze({ messageId, toStage: "presented", enqueued: !existed });
}

/**
 * Record the human's answer and put it on the queue: `answered`, then the
 * `forwarded` relay.
 *
 * Both in one call, and deliberately: the forward relay may only be enqueued
 * from `answered` (`enqueueRelay` reads the direct predecessor off the
 * transition table), so the two are one operator intent -- "this is my answer,
 * pass it on" -- and splitting them would leave a gate that can be answered
 * and never forwarded by an operator who typed one verb and stopped.
 *
 * The answer's durability is the `body` on the advance itself; `answered` is
 * not a relayed stage and no ack gates it. A repeat is idempotent in both
 * halves: the advance returns `false` on a gate already at `answered`, and the
 * enqueue collides on `(gate_id, to_stage)` and returns the id already in
 * force -- which is exactly the crash window between the two.
 *
 * **A repeat does not re-record the answer, and a repeat with a different one is
 * refused.** The stage is already `answered`, so the advance is the no-op above
 * and the body this call was given is dropped by `advanceOnAck`. The relay is
 * therefore built from the body the *transition* holds, not from the argument:
 * otherwise a retry after a kill between the two transactions would forward an
 * answer no transition records, and the recipient would act on B while the
 * durable history said A. A caller offering a different body gets
 * {@link AnswerAlreadyRecorded} rather than a silent drop -- correcting a
 * recorded answer is `recordCorrection`'s edge (section 9.3), which carries a
 * `supersedes_seq` so the history shows both, and no verb here writes it yet.
 *
 * @throws {AnswerBodyRequired} if `body` is empty. The refusal `gates.ts`
 *   raises for a null body, applied one step earlier so the empty string --
 *   which SQLite would store happily -- cannot become a recorded answer that
 *   says nothing.
 * @throws {InadmissibleTransitionRefused} if the gate is not at `presented`.
 */
export function answerGate(
  connection: SqliteDatabase,
  options: {
    readonly gateId: string;
    readonly body: string;
    readonly actorId: string;
    readonly nowMs: number;
  },
): AnswerRecorded {
  const { gateId, body, actorId, nowMs } = options;
  const recipient = GATE_RELAY_RECIPIENT;
  if (body === "") {
    // `advanceOnAck` refuses a null body and SQLite would store an empty
    // string happily, so the empty case is refused here -- one step earlier --
    // rather than becoming a recorded answer that says nothing. The stage is
    // not ack-gated: this text is the whole of the evidence that the question
    // was answered.
    throw new AnswerBodyRequired(
      `the advance of gate ${gateId} to 'answered' carries the verbatim ` +
        "answer; an empty one loses the thing the stage is for",
    );
  }
  const advanced = advanceOnAck(connection, {
    gateId,
    toStage: "answered",
    actorKind: "human",
    actorId,
    occurredAtMs: nowMs,
    recordedAtMs: nowMs,
    body,
  });
  const gate = gateDetail(connection, gateId);
  // The relay carries the answer the DATABASE holds, never the one this call
  // was given, and the difference is a real divergence rather than a nicety.
  // The advance and the enqueue are two transactions: a kill between them, or a
  // second operator answering concurrently, leaves the advance committed and
  // the relay unwritten. A retry then finds `advanced === false` -- its own body
  // was dropped on the floor by `advanceOnAck` -- and building the payload from
  // that body would forward an answer that no transition records, so the
  // recipient acts on B while the durable history says A.
  const recorded = recordedAnswer(connection, gateId);
  if (recorded === null) {
    // Only reachable if the advance above committed and the transition then
    // vanished, which the schema does not admit -- said plainly rather than
    // forwarded as an empty answer.
    throw new AnswerAlreadyRecorded(
      `gate ${gateId} is at '${gate.stage}' with no recorded answer to forward`,
    );
  }
  if (recorded !== body) {
    throw new AnswerAlreadyRecorded(
      `gate ${gateId} already carries a different answer; it is not replaced by ` +
        "this one, and correcting a recorded answer is not what this verb does",
    );
  }
  const existed = relayExists(connection, gateId, "forwarded");
  const messageId = enqueueRelay(connection, {
    gateId,
    toStage: "forwarded",
    recipient,
    payload: forwardedPayload(gate, recorded),
    messageId: relayMessageId(gateId, "forwarded"),
    enqueuedAtMs: nowMs,
  });
  return Object.freeze({ advanced, messageId, toStage: "forwarded", enqueued: !existed });
}

// --------------------------------------------------------------------------
// delivery, and the ack that is the whole point of step 10
// --------------------------------------------------------------------------

/**
 * Deliver every relay currently due for `recipient`, under the delivery lease.
 *
 * The operator's delivery worker, for the window in which no endpoint exists
 * (`D-0080`). It is the same {@link MessageBus.poll} the endpoint drives, over
 * the same registry and the same {@link KeyedDropbox}, so a relay delivered
 * here and a relay delivered by a running endpoint are the same effect under
 * the same idempotency key -- and a message delivered twice across the two
 * still applies once, because the destination is what deduplicates it.
 *
 * The lease is taken and released around the poll rather than held: this is a
 * one-shot pass, and `LeaseHeld` from a live endpoint or a running lap is the
 * right answer rather than a race to write the same rows. It is released in a
 * `finally` so a refused delivery does not leave the resource claimed for a
 * whole TTL, which would refuse the operator's own next attempt.
 *
 * @throws {LeaseHeld} if a lap or an endpoint is holding the delivery lease.
 * @throws {HandlerRejected} if no handler serves `recipient` -- the same
 *   refusal the endpoint makes at startup, made here before anything is
 *   attempted rather than as an empty queue that looks like nothing was due.
 */
export function deliverRelays(
  connection: SqliteDatabase,
  options: {
    readonly holder: string;
    readonly destinationDir: string;
    readonly recipient?: string;
    readonly nowMs: number;
    readonly ttlMs: number;
    readonly clock?: (() => number) | undefined;
  },
): DeliveryReport {
  const { holder, destinationDir, recipient = GATE_RELAY_RECIPIENT, nowMs, ttlMs, clock } = options;
  const registry = spikeRegistry(new KeyedDropbox(destinationDir, "gate-cli"));
  // Before the lease, so an unserved recipient costs no claim on the one
  // delivery resource -- and before the dropbox is read from, so the refusal
  // names the misconfiguration rather than whatever the directory contained.
  registry.forRecipient(recipient);
  const lease = acquire(connection, {
    resource: DELIVERY_LEASE_RESOURCE,
    holder,
    nowMs,
    ttlMs,
  });
  try {
    const bus = new MessageBus(connection, {
      resource: DELIVERY_LEASE_RESOURCE,
      holder,
      registry,
    });
    // `clock` is handed to the poll for the reason the endpoint hands it one:
    // a pass that outlives its lease must be fenced at the write it is actually
    // making, not at the instant it started. Without it every attempt in a pass
    // longer than the TTL is validated against the acquisition timestamp, so
    // the lease can expire in wall-clock time while this process keeps writing
    // rows and applying destination effects -- the single-writer fence saying
    // yes to a writer that no longer holds it.
    //
    // Optional rather than mandatory, and absent it the pass is fenced at
    // `nowMs` as before: a caller that froze the clock (`--now-ms`, and every
    // case in the suite) means the instant it gave, and re-reading a live clock
    // underneath it would make a deterministic verb read the wall clock anyway.
    const envelopes = bus.poll(
      recipient,
      clock === undefined ? { nowMs, epoch: lease.epoch } : { nowMs, epoch: lease.epoch, clock },
    );
    return Object.freeze({
      recipient,
      epoch: lease.epoch,
      delivered: Object.freeze(
        envelopes.map((envelope) =>
          Object.freeze({
            messageId: envelope.messageId,
            recipient: envelope.recipient,
            dedupKey: envelope.dedupKey,
          }),
        ),
      ),
    });
  } finally {
    release(connection, lease, { nowMs });
  }
}

/**
 * The relay this message belongs to, or `undefined` if it belongs to no gate.
 */
function relayOf(
  connection: SqliteDatabase,
  messageId: string,
): { readonly gateId: string; readonly toStage: string } | undefined {
  const row = connection
    .prepare<[string], { gate_id: string; to_stage: string }>(
      "SELECT gate_id, to_stage FROM gate_relay WHERE message_id = ?",
    )
    .get(messageId);
  return row === undefined ? undefined : { gateId: row.gate_id, toStage: row.to_stage };
}

/**
 * The `Outbox` the ack is recorded through.
 *
 * Built with an **empty** registry, and the emptiness is the statement:
 * `recordAck` applies no effect and consults no handler, and handing this one
 * a destination would imply the ack could deliver something. `D-0053` puts the
 * `delivered -> acked` edge on the recipient-bound path and says it is
 * deliberately unfenced -- an ack is idempotent, and a fence on it would turn a
 * settlement that changed nothing into a refusal -- so no lease is taken here
 * either. The resource and holder are still required arguments of the outbox
 * and are still true of this caller: they name whose write this would be if it
 * were a fenced one, and no fenced statement runs on this path.
 */
function ackOutbox(connection: SqliteDatabase, holder: string): Outbox {
  return new Outbox(connection, {
    resource: DELIVERY_LEASE_RESOURCE,
    holder,
    registry: new HandlerRegistry(),
  });
}

/**
 * Record the ack for one relay, then take the step that ack justifies.
 *
 * This is the verb section 4.10 of the design asks for: *a CLI verb records
 * the ack that lets the gate close as `answered_and_forwarded`*.
 *
 * Three writes, in one order, each idempotent on its own:
 *
 * 1. the ack (`delivered -> acked`, set once by the outbox's own trigger);
 * 2. the advance the ack gates -- `presented` or `forwarded`, actor
 *    `secretary`, refused by `advanceOnAck` unless the relay really is acked;
 * 3. for `forwarded` only, the close as `answered_and_forwarded`, actor
 *    `system`.
 *
 * **Why the close is here and not a fourth verb.** Section 9.3 gives the close
 * out of `forwarded` to actor `system` alone, because that close is the
 * consequence of the forward relay's ack and nobody *decides* it. A verb an
 * operator had to type would be a decision with no content, and forgetting to
 * type it would leave a gate that was answered and forwarded sitting open for
 * ever -- the permanently-alarming row section 9.4's taxonomy exists to
 * remove.
 *
 * **Why a kill between them is survivable.** Each step is a separate
 * transaction on purpose (the ack is the outbox's, the advance and the close
 * are `gates.ts`'s, and the close appends its own event). A kill after step 1
 * leaves exactly the state {@link gatesNeedingAdvance} is the detector for, and
 * {@link reconcile} finishes it -- which is why that detector's recovery is
 * this module's and not a comment about a caller that does not exist.
 */
export function ackRelay(
  connection: SqliteDatabase,
  options: {
    readonly messageId: string;
    readonly actorId: string;
    readonly recipient?: string;
    readonly nowMs: number;
  },
): AckRecorded {
  const { messageId, actorId, recipient = GATE_RELAY_RECIPIENT, nowMs } = options;
  const relay = relayOf(connection, messageId);
  if (relay === undefined) {
    throw new UnknownGateRefused(
      `${messageId} is not a gate relay; this verb settles the messages a gate enqueued`,
    );
  }
  const outbox = ackOutbox(connection, actorId);
  const message = outbox.load(messageId);
  if (message.recipient !== recipient) {
    // The carried invariant `MessageBus.ack` states: a confirm from anyone but
    // the recipient the message was addressed to is a caller bug, not a
    // settlement. Kept here because this path does not go through the bus --
    // see {@link ackOutbox} for why it does not.
    throw new UnknownGateRefused(
      `${messageId} is addressed to ${message.recipient}; an ack from ${recipient} does not settle it`,
    );
  }
  const outcome = outbox.recordAck(messageId, { nowMs });
  let advanced = false;
  let closed = false;
  if (!outcome.cancelled) {
    advanced = advanceOnAck(connection, {
      gateId: relay.gateId,
      toStage: relay.toStage,
      actorKind: RELAY_ADVANCE_ACTOR_KIND,
      actorId,
      occurredAtMs: nowMs,
      recordedAtMs: nowMs,
    });
    if (relay.toStage === "forwarded") {
      closed = closeGate(connection, {
        gateId: relay.gateId,
        outcome: "answered_and_forwarded",
        actorKind: "system",
        actorId,
        occurredAtMs: nowMs,
        recordedAtMs: nowMs,
      });
    }
  }
  return Object.freeze({
    messageId,
    toStage: relay.toStage,
    gateId: relay.gateId,
    acked: outcome.recorded,
    cancelled: outcome.cancelled,
    advanced,
    closed,
  });
}

// --------------------------------------------------------------------------
// closing, and the reconcile pass
// --------------------------------------------------------------------------

/**
 * Close an open gate with an outcome an operator decides.
 *
 * `withdrawn` (the question stopped mattering), `expired` (its deadline
 * passed and the operator says so) and `unanswerable` -- and nothing else;
 * see {@link OPERATOR_CLOSE_OUTCOMES} for why the other three are not a hand's
 * to write.
 *
 * The actor is `human` for all three. Section 9.4 gives `expired` to the
 * reconcile pass in the shape where a policy decides it, and no such policy is
 * decided (`docs/time-base-policy.md` names no expiry rule), so an operator
 * closing an overdue gate is making the decision rather than executing one --
 * and recording that as `system` would attribute a judgement to a pass that
 * refuses to make it (`D-0008`).
 */
export function closeOpenGate(
  connection: SqliteDatabase,
  options: {
    readonly gateId: string;
    readonly outcome: string;
    readonly actorId: string;
    readonly nowMs: number;
    readonly body?: string | null;
  },
): boolean {
  const { gateId, outcome, actorId, nowMs, body = null } = options;
  if (!OPERATOR_CLOSE_OUTCOMES.includes(outcome)) {
    throw new TypeError(
      `'${outcome}' is not an outcome a gate verb writes; ` +
        `the operator's outcomes are ${OPERATOR_CLOSE_OUTCOMES.join(", ")}`,
    );
  }
  if (outcome === "expired") {
    // `expired` is a fact about a deadline, and the deadline is on the row. The
    // operator decides WHETHER a passed deadline expires the gate -- that is
    // the policy `D-0008` keeps out of code -- but not whether it passed. A
    // close as `expired` on a gate with no deadline, or one still in the
    // future, writes a `gate_expired` event that `gatesPastDeadline` would
    // never have reported: a durable statement about a deadline that did not
    // happen. The window is half-open, exactly as that detector reads it
    // (`docs/time-base-policy.md` section 2), so `nowMs === deadlineAtMs` is
    // past.
    const gate = gateDetail(connection, gateId);
    if (gate.deadlineAtMs === null) {
      throw new DeadlineNotPassed(`gate ${gateId} has no deadline; it does not close as 'expired'`);
    }
    if (nowMs < gate.deadlineAtMs) {
      throw new DeadlineNotPassed(
        `gate ${gateId}'s deadline is at ${gate.deadlineAtMs} and it is ${nowMs}; ` +
          "it does not close as 'expired' before then",
      );
    }
  }
  return closeGate(connection, {
    gateId,
    outcome,
    actorKind: "human",
    actorId,
    occurredAtMs: nowMs,
    recordedAtMs: nowMs,
    body,
  });
}

/**
 * Open gates standing at `forwarded` whose forward relay is acked.
 *
 * The close section 9.3 owes them: out of `forwarded` the close is the ack's
 * consequence and its actor is `system`, so a gate in this state is not
 * waiting on a decision -- it is waiting on a write that a kill lost.
 */
function forwardedAndAcked(connection: SqliteDatabase): readonly string[] {
  return connection
    .prepare<[], string>(
      `
        SELECT g.gate_id
          FROM gate g
          JOIN gate_relay r ON r.gate_id = g.gate_id AND r.to_stage = 'forwarded'
          JOIN outbox o     ON o.message_id = r.message_id
         WHERE g.closed_at_ms IS NULL
           AND g.stage = 'forwarded'
           AND o.status = 'acked'
         ORDER BY g.gate_id
        `,
    )
    .pluck()
    .all();
}

/**
 * One reconcile pass: finish what is already justified, report what is not.
 *
 * The caller `src/control_plane/gates.ts` says its five detectors do not have
 * (`D-0079`). Its own verb rather than a step inside another one: running it
 * inside the endpoint would tie it to a process that dies with the lap and
 * speaks for one recipient, and running it inside every verb would make a read
 * such as `gate show` a writer -- so an operator could not look at a gate
 * without changing it.
 *
 * **What it settles, and in which order.** `gatesNeedingAdvance` completes the
 * advance a durable ack already justified -- the section 9.5 kill-point-4
 * recovery -- and the close that advance implies; only then does
 * `sweepSubjectGone` close gates whose subject run reached a terminal status.
 * Sweeping first would close an acked-and-forwarded gate as `subject_gone`
 * permanently; the body says why in full. A
 * `forwarded` advance completed here also closes the gate, for the reason
 * {@link ackRelay} closes it: the close out of `forwarded` is the ack's
 * consequence and nobody decides it, so a gate recovered by this pass must not
 * end up in a state the ordinary path would never leave it in.
 *
 * **What it only reports.** Relay gaps, stalled relays and passed deadlines.
 * All three name candidates and none of them is a verdict: section 9.6's
 * remedies differ per row and per owner, and the expiry rule is undecided
 * policy. Closing a gate here because its deadline passed would decide that
 * policy in code, which is the one thing `D-0008` puts out of reach.
 *
 * `stalledToleranceMs` is optional and has no default, because a default would
 * be an invented number for exactly the kind of tolerance `D-0031` requires to
 * be data. Omitted, the stalled query does not run and the report says so with
 * `null`.
 */
export function reconcile(
  connection: SqliteDatabase,
  options: {
    readonly nowMs: number;
    readonly actorId: string;
    readonly stalledToleranceMs?: number | undefined;
  },
): ReconcileReport {
  const { nowMs, actorId, stalledToleranceMs } = options;
  // The completions run BEFORE the sweep, and the order is the whole
  // correctness of this pass rather than a preference.
  //
  // `sweepSubjectGone` is stage-blind: section 9.4 makes `subject_gone`
  // reachable from every stage (`CLOSE_OUTCOME_STAGES`), so it closes an open
  // gate at `forwarded` as readily as one at `received`. Swept first, a gate
  // whose forward relay was acked in the window a kill interrupted -- exactly
  // the state the two loops below exist to finish -- is closed `subject_gone`
  // while the run happens to have ended, and that closure is permanent:
  // `gatesNeedingAdvance` and {@link forwardedAndAcked} both exclude closed
  // gates, and `closeGate` refuses to change an outcome already recorded. The
  // human's answer, delivered and acknowledged, would be filed for ever under
  // the outcome that means nobody answered.
  //
  // Completed first, the same gate closes `answered_and_forwarded` and the
  // sweep then finds nothing open to sweep. A gate the completions do NOT
  // finish -- one still waiting for an answer -- is swept exactly as before,
  // because a terminal run is still a fact about it.
  const pending = gatesNeedingAdvance(connection);
  const advanced: GateNeedingAdvance[] = [];
  const closed: string[] = [];
  for (const row of pending) {
    if (
      advanceOnAck(connection, {
        gateId: row.gateId,
        toStage: row.toStage,
        actorKind: RELAY_ADVANCE_ACTOR_KIND,
        actorId,
        occurredAtMs: nowMs,
        recordedAtMs: nowMs,
      })
    ) {
      advanced.push(row);
    }
  }
  // The close is driven off the STATE, not off the advances this pass made,
  // and the difference is a hole rather than a style: `gatesNeedingAdvance`
  // excludes a gate whose advance transition already exists, so a kill between
  // the advance and the close -- two transactions in both `ackRelay` and the
  // loop above -- leaves a gate forwarded, acked and open that no detector
  // would ever report again. Asking which open gates are AT `forwarded` with an
  // acked forward relay covers the pass's own advances and that window with one
  // query.
  for (const gateId of forwardedAndAcked(connection)) {
    if (
      closeGate(connection, {
        gateId,
        outcome: "answered_and_forwarded",
        actorKind: "system",
        actorId,
        occurredAtMs: nowMs,
        recordedAtMs: nowMs,
      })
    ) {
      closed.push(gateId);
    }
  }
  const subjectGone = sweepSubjectGone(connection, { nowMs, actorId });
  return Object.freeze({
    subjectGone,
    advanced: Object.freeze(advanced),
    closed: Object.freeze(closed),
    relayGaps: relayGaps(connection, { nowMs }),
    stalledRelays:
      stalledToleranceMs === undefined
        ? null
        : stalledRelays(connection, { nowMs, toleranceMs: stalledToleranceMs }),
    pastDeadline: gatesPastDeadline(connection, { nowMs }),
  });
}
