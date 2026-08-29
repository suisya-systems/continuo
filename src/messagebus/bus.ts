import type { Database as SqliteDatabase } from "better-sqlite3";

import {
  type AckOutcome,
  type AttemptOutcome,
  type HandlerRegistry,
  Outbox,
  type OutboxMessage,
  OutboxUsageError,
  StaleWriterRefused,
} from "../control_plane/outbox.js";
import { pythonRepr } from "../control_plane/python_repr.js";

/**
 * S8 -- the `MessageBus` facade: send, poll, ack, over the S7 outbox.
 *
 * **Spike scaffold, throwaway by default (interlock D-0026).** The contract the
 * suite pins is durable; this implementation of it is not.
 *
 * Ported from interlock `src/claude_org_runtime/messagebus/bus.py` at
 * `65f36c5`. The suite that pins it is `test/messagebus/`, and the mapping from
 * each source case to its target is `parity/messagebus.*.ledger.json`.
 *
 * **What this class is, and what it deliberately is not.** The S7 outbox
 * already holds every delivery decision this bus makes: {@link Outbox.due}
 * answers what is unfinished, {@link Outbox.attempt} runs one fenced delivery
 * attempt with its kill windows in the right order, and
 * {@link Outbox.recordAck} settles a message idempotently. What S8 adds is the
 * **worker-outbound shape** around those verbs -- a sender-side
 * {@link MessageBus.send} and a recipient-side {@link MessageBus.poll} /
 * {@link MessageBus.ack} pair -- and nothing else. The existing outbox API is
 * used as found, not modified (interlock Issue `#19`'s scope note), so the
 * fault-injection evidence S7 accumulated keeps describing the delivery path
 * this bus actually takes. Concretely: there is no message table, no delivery
 * state machine, no retry loop and no ack record in this package. A second one
 * of any of those would be a second answer to a question `src/control_plane/
 * outbox.ts` already answers, and two answers to a delivery question is how a
 * message gets delivered twice or not at all.
 *
 * **Pull replaces claim-then-confirm.** In v1 a sidecar claimed rows over HTTP
 * and confirmed them under a generation fence. Here the worker *polls*: each
 * poll re-runs {@link Outbox.attempt} for every due message addressed to it,
 * which marks the row delivered and re-presents the payload. A poll response
 * lost on the wire changes nothing durable on the worker's side and leaves the
 * row delivered-but-unacked, so it stays due and the next poll re-presents it
 * -- resend is the default, not a recovery mode. The ack is the one
 * message-level settlement, and it is idempotent and deliberately unfenced
 * ({@link Outbox.recordAck}'s own rationale), so however many times a worker
 * repeats it, exactly one ack is recorded.
 *
 * **Delivery decisions are SQLite-only.** `poll` reads {@link Outbox.due} and
 * nothing else. There is no session readout, no liveness probe, and no way to
 * consult one: this module has no import edge to `src/session/`, and
 * `test/messagebus/import-graph.test.ts` keeps it that way. A provider readout
 * that is stale or wrong -- a session id whose child is gone, a `readState`
 * that answers "could not observe" -- cannot alter what this bus delivers,
 * because no code path exists from the one to the other (interlock gate item 6,
 * translated for C2 where there is no UI to detach).
 *
 * **Exceptions are the outbox's own.** `send` to a recipient no handler serves
 * throws {@link HandlerRejected} at the enqueue boundary -- the carried v1
 * invariant that a message could only be enqueued to a registered binding,
 * re-expressed against the handler registry, which is the only recipient roster
 * this layer has. `poll` propagates {@link StaleWriterRefused},
 * `HumanGateRequired` and destination refusals exactly as {@link Outbox.attempt}
 * throws them; wrapping them here would hide the fence. The one refusal this
 * layer raises itself is {@link MessageBusUsageError}, for an ack across the
 * recipient boundary -- see {@link MessageBus.ack}.
 */

/**
 * A caller bug at this facade's own boundary.
 *
 * The source raises a bare `ValueError` here and the outbox raises a bare
 * `ValueError` for its own usage errors, so in Python the two are one class.
 * They are not one class here, and deliberately: `docs/test-translation-
 * conventions.md` records that a refusal family whose members differ only by
 * message stays green while the taxonomy a caller acts on is wrong, which is
 * why `expectRefusal` asserts the class as well as the text. The outbox keeps
 * throwing {@link OutboxUsageError} through this facade unchanged (an ack for a
 * message never marked delivered is *its* judgement, not this layer's); this
 * class is only ever thrown by code in this package.
 */
export class MessageBusUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageBusUsageError";
  }
}

/** What {@link MessageBus.poll} needs to build one envelope. */
export interface DeliveredEnvelopeFields {
  readonly messageId: string;
  readonly recipient: string;
  readonly payload: string;
  readonly dedupKey: string;
  readonly retryCount: number;
  readonly deduplicated: boolean;
  readonly receiptRef: string | null;
}

/**
 * One message as presented to a polling worker.
 *
 * The envelope carries the attempt's outcome alongside the payload so the
 * worker can see, per presentation, whether the effect behind it was fresh or
 * deduplicated -- the at-least-once transport made visible, with the
 * exactly-once evidence attached.
 */
export class DeliveredEnvelope {
  /** The durable message identity; the argument {@link MessageBus.ack} takes. */
  readonly messageId: string;
  /** The recipient the message was addressed to (always the polling one). */
  readonly recipient: string;
  /** The payload as enqueued. */
  readonly payload: string;
  /**
   * The sender's dedup key, so the worker can deduplicate re-presentations of
   * the same intent even across a re-enqueue under a new message id.
   */
  readonly dedupKey: string;
  /** Attempts so far, this presentation included. */
  readonly retryCount: number;
  /**
   * `true` when the destination recognised the idempotency key and applied no
   * second effect -- i.e. this is a re-presentation, not a first delivery.
   */
  readonly deduplicated: boolean;
  /** The destination's own reference for the effect, when it issued one. */
  readonly receiptRef: string | null;

  constructor(fields: DeliveredEnvelopeFields) {
    this.messageId = fields.messageId;
    this.recipient = fields.recipient;
    this.payload = fields.payload;
    this.dedupKey = fields.dedupKey;
    this.retryCount = fields.retryCount;
    this.deduplicated = fields.deduplicated;
    this.receiptRef = fields.receiptRef;
    // The source's `@dataclass(frozen=True)`. Freezing is what makes the
    // envelope safe to hand to a caller that keeps it: a mutable presentation
    // record could be edited after the fact and then compared for equality
    // against the transcript, which is exactly what the stale-readout case does.
    Object.freeze(this);
  }
}

/** Constructor arguments for {@link MessageBus}. */
export interface MessageBusOptions {
  readonly resource: string;
  readonly holder: string;
  readonly registry: HandlerRegistry;
  /** The outbox's kill-window seam, passed straight through when given. */
  readonly checkpoint?: ((name: string) => void) | undefined;
}

/** Optional arguments for {@link MessageBus.poll}. */
export interface PollOptions {
  readonly nowMs: number;
  readonly epoch: number;
  /**
   * Read again for **every** attempt. See {@link MessageBus.poll}: a poll that
   * outlives its lease must be fenced at the write it is actually making.
   */
  readonly clock?: (() => number) | undefined;
}

/**
 * Worker-outbound send/poll/ack over one S7 {@link Outbox}.
 *
 * One bus serves one lease-fenced writer (*resource*, *holder*), exactly as the
 * outbox underneath it does; which component holds which resource is
 * interlock's `Q-0001`'s business and stays out of this layer.
 */
export class MessageBus {
  private readonly _registry: HandlerRegistry;
  private readonly _outbox: Outbox;

  constructor(connection: SqliteDatabase, options: MessageBusOptions) {
    const { resource, holder, registry, checkpoint } = options;
    this._registry = registry;
    // `**({"checkpoint": checkpoint} if checkpoint is not None else {})`: the
    // key is omitted rather than passed as undefined, so the outbox's own
    // default is what applies. Under `exactOptionalPropertyTypes` passing
    // `checkpoint: undefined` would not even type-check against an optional
    // property, which is the compiler saying the same thing.
    this._outbox =
      checkpoint === undefined
        ? new Outbox(connection, { resource, holder, registry })
        : new Outbox(connection, { resource, holder, registry, checkpoint });
  }

  /** The S7 outbox this bus fronts, exposed for inspection, not bypass. */
  get outbox(): Outbox {
    return this._outbox;
  }

  /**
   * Enqueue one message to a recipient a handler is registered for.
   *
   * The registry lookup runs *before* the durable write, so a send to an
   * unregistered recipient is refused (`HandlerRejected`) without leaving a row
   * nothing can ever deliver -- the carried "enqueue only to registered"
   * invariant, whose roster here is the handler registry rather than v1's pane
   * bind table.
   */
  send(options: {
    readonly messageId: string;
    readonly recipient: string;
    readonly payload: string;
    readonly dedupKey: string;
    readonly nowMs: number;
    readonly epoch: number;
    readonly runId?: string | null;
  }): OutboxMessage {
    const { messageId, recipient, payload, dedupKey, nowMs, epoch, runId = null } = options;
    this._registry.forRecipient(recipient);
    return this._outbox.enqueue({
      messageId,
      recipient,
      payload,
      dedupKey,
      nowMs,
      epoch,
      runId,
    });
  }

  /**
   * One pull: attempt every due message for *recipient*, oldest first.
   *
   * Each returned envelope corresponds to one completed {@link Outbox.attempt}
   * -- the row is marked delivered and the effect is applied or recognised as
   * already applied before the payload is presented. A response the worker never
   * receives therefore loses nothing: the rows stay due (delivered-but-unacked)
   * and the next poll presents them again. What is due is read from SQLite and
   * nowhere else.
   *
   * Presentation is at-least-once all the way to the wire: an ack that lands
   * concurrently with a poll already carrying the same message -- after its
   * attempt completed, or while the response is in flight -- can put one more
   * presentation of a just-settled message in front of the worker. That race has
   * no server-side fix (the response cannot be recalled), which is why every
   * envelope carries the sender's `dedupKey`: the recipient deduplicates,
   * exactly as it must for the resend path. Settlement stops *future* polls from
   * presenting the message; it cannot retract one already leaving.
   *
   * `clock`, when given, is read again for **every** attempt; `nowMs` then only
   * anchors the `due()` snapshot. A poll that outlives its lease must not keep
   * delivering on the timestamp it started with -- the fence evaluates expiry
   * against the instant of each write, so with a live clock a long poll dies
   * loudly ({@link StaleWriterRefused}, refusal recorded) at the first attempt
   * past the expiry instead of draining the whole batch under a dead lease.
   * Callers with a fixed `nowMs` and no clock get the deterministic
   * single-instant semantics the tests use.
   */
  poll(recipient: string, options: PollOptions): readonly DeliveredEnvelope[] {
    const { nowMs, epoch, clock } = options;
    const envelopes: DeliveredEnvelope[] = [];
    for (const message of this._outbox.due(nowMs)) {
      if (message.recipient !== recipient) {
        continue;
      }
      if (this._outbox.load(message.messageId).status === "acked") {
        // Settled since the due() snapshot -- the common shape of a late ack
        // (an endpoint restart overlapping its predecessor's unflushed ack).
        // Re-reading here keeps the ordinary race out of attempt() entirely, so
        // no refusal is durably recorded for what is simply a settled message.
        continue;
      }
      // One instant per attempt, by the outbox's own contract: Outbox.attempt
      // takes a single nowMs, and S7 already decided how the window inside one
      // attempt is handled -- the in-attempt lease re-read narrows it, and a
      // writer paused past its lease inside the attempt is refused by the
      // *destination's* fencing token (StaleTokenRefused), the only party still
      // running. Re-sampling the clock inside the attempt is the outbox's
      // business, not this facade's.
      const attemptNow = clock === undefined ? nowMs : clock();
      let outcome: AttemptOutcome;
      try {
        outcome = this._outbox.attempt(message.messageId, { nowMs: attemptNow, epoch });
      } catch (error) {
        // The residual window: an ack that lands after the re-read above but
        // inside attempt() itself. The outbox surfaces it as "already acked"
        // (OutboxUsageError, the source's ValueError) or as the fenced
        // attempt-count update finding no row to move. A settled message is a
        // poll's success case, not its error: skip it and keep presenting the
        // rest. Anything else re-throws -- a fence refusal on a genuinely
        // unsettled row must stay loud. Known cost, accepted: on the
        // StaleWriterRefused branch the outbox has already durably recorded a
        // refusal row before throwing; inside this residual window that row is
        // audit noise (an attempt refused because the message was settled),
        // never a delivery fault -- eliminating it would need the outbox itself
        // to classify why the fenced update moved no row, which interlock Issue
        // #19 keeps out of scope (the outbox API is used as found).
        const residual = error instanceof OutboxUsageError || error instanceof StaleWriterRefused;
        if (residual && this._outbox.load(message.messageId).status === "acked") {
          continue;
        }
        throw error;
      }
      envelopes.push(
        new DeliveredEnvelope({
          messageId: message.messageId,
          recipient: message.recipient,
          payload: message.payload,
          dedupKey: message.dedupKey,
          retryCount: outcome.retryCount,
          deduplicated: outcome.deduplicated,
          receiptRef: outcome.receiptRef,
        }),
      );
    }
    return Object.freeze(envelopes);
  }

  /**
   * Settle one delivered message. Idempotent; unfenced by design.
   *
   * `recipient` must be the recipient the message was addressed to -- the
   * carried v1 invariant that a confirm from anyone but the owner is refused,
   * re-expressed without the credential machinery: the endpoint serves one
   * recipient and states it, and an ack across that boundary is a caller bug,
   * not a settlement.
   *
   * Otherwise delegates to {@link Outbox.recordAck} unchanged: exactly one ack
   * is ever recorded per message, later acks are no-ops, and an ack for a
   * message never marked delivered is refused as evidence of a lost delivery
   * record.
   */
  ack(
    messageId: string,
    options: { readonly nowMs: number; readonly recipient: string },
  ): AckOutcome {
    const { nowMs, recipient } = options;
    const message = this._outbox.load(messageId);
    if (message.recipient !== recipient) {
      throw new MessageBusUsageError(
        `${pythonRepr(messageId)} is addressed to ${pythonRepr(message.recipient)}; an ack from ` +
          `${pythonRepr(recipient)} does not settle it`,
      );
    }
    return this._outbox.recordAck(messageId, { nowMs });
  }
}
