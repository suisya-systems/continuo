import type { Database as SqliteDatabase } from "better-sqlite3";

import {
  type AckOutcome,
  type AttemptOutcome,
  CancellationRaced,
  type HandlerRegistry,
  isTerminalOutboxStatus,
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
      if (isTerminalOutboxStatus(this._outbox.load(message.messageId).status)) {
        // Finished since the due() snapshot -- skip it, whichever way it
        // finished. There are two ways, and until migration 0003 this test knew
        // only one of them:
        //
        // - `acked`: the common shape of a late ack (an endpoint restart
        //   overlapping its predecessor's unflushed ack).
        // - `cancelled`: gate closure wrote the row off between `Outbox.due`'s
        //   snapshot and this attempt. `due()` reads a list once and this loop
        //   then walks it one attempt at a time, so *every* row in the batch
        //   after the first is being attempted against a database that may have
        //   moved -- and the 0003 lattice makes `pending -> cancelled` and
        //   `delivered -> cancelled` legal edges that a *different* writer (the
        //   human gate, not this bus) takes without consulting us.
        //
        // A cancelled row is NORMALLY FINISHED, exactly like an acked one, and
        // is skipped rather than raised: nobody is owed a delivery of a message
        // whose gate has closed. Falling through instead would be materially
        // worse than a lost envelope, because Outbox.attempt runs the
        // *destination side effect first* and only then writes
        // `_MARK_DELIVERED`; on a cancelled row the forward-only trigger
        // (`outbox_status_is_forward_only`, no outgoing edge from `cancelled`)
        // aborts that write -- so the effect would have happened and the
        // database would deny it ever did.
        //
        // Terminality is asked of `isTerminalOutboxStatus` rather than compared
        // against a literal here, so a fifth status added to 0003's CHECK is
        // classified in one place (`src/control_plane/outbox.ts`) instead of
        // being missed in this package.
        //
        // Note this site is NOT one of the four predicates
        // `docs/design/minimal-operating-loop.md` section 5.1 enumerates; it is
        // one of the two the design's own list misses (the other is the
        // post-exception residual test below). Section 5.1 line 694 says to
        // treat those four "as the floor rather than the list", and these two
        // are what is above the floor: they live in `src/messagebus/`, not in
        // the outbox, so a search of the outbox's SQL does not find them.
        continue;
      }
      // One instant per attempt, by the outbox's own contract: Outbox.attempt
      // takes a single nowMs, and S7 already decided how the window inside one
      // attempt is handled -- the in-attempt lease re-read narrows it, and a
      // writer paused past its lease inside the attempt is refused by the
      // *destination's* fencing token (StaleTokenRefused), the only party still
      // running. Re-sampling the clock inside the attempt is the outbox's
      // business, not this facade's.
      //
      // The adoption below shares this instant rather than sampling a second
      // one. Two reads of a live clock straddling a lease expiry would let a
      // poll adopt a row under an epoch that its own attempt then finds dead,
      // which is a durable ownership write made on behalf of a writer that no
      // longer exists.
      const attemptNow = clock === undefined ? nowMs : clock();
      // Take ownership of this one row, if it has none, immediately before
      // attempting it.
      //
      // A relay enqueued by a gate (`enqueueRelay`, src/control_plane/
      // gates.ts) and an event fanned out to a delivery consumer
      // (src/control_plane/events.ts) are both written with `writer_epoch`
      // null: the producer holds no delivery lease, and requiring one would
      // mean a queue that stops accepting work whenever no delivery worker
      // happens to be alive. `Outbox.attempt`'s first fenced statement asks
      // that the row be OWNED by the attempting epoch -- not merely that the
      // epoch be live -- so without this line every such row is refused as
      // StaleWriterRefused, forever, and the message the human gate is waiting
      // on is never delivered. That was the gap; D-0054 records it.
      //
      // Three things about where this line is, all of them load-bearing:
      //
      // - It is INSIDE the loop, after the recipient test. A poll speaks for
      //   one recipient (the filter three lines up is that authority), so it
      //   may take ownership of that recipient's row and no other's. The
      //   available whole-table verb, `Outbox.recover`, adopts every unowned
      //   row for every recipient; calling it here would have this endpoint
      //   own rows it cannot deliver and would walk the entire backlog on
      //   every poll.
      // - It is AFTER the terminal re-read. A row cancelled since the due()
      //   snapshot is finished, and handing a finished row a live owner is the
      //   adopt-forever failure `Outbox.recover`'s own note describes.
      // - It is BEFORE `attempt`, and it is the only write this loop makes
      //   that `Outbox.attempt` does not. That is a real divergence from the
      //   source's poll, which writes nothing of its own, and it is recorded
      //   in `parity/messagebus.bus.ledger.json` rather than left to be
      //   noticed.
      //
      // What is due is still read from SQLite and nowhere else. Adoption is
      // not a source of due-ness: it discovers nothing, adds nothing to the
      // batch and reorders nothing -- _DUE_QUERY alone decides which rows this
      // loop sees and in what order. It changes only whether a row SQLite
      // already returned can now be advanced by this epoch.
      //
      // `false` is unremarkable and is not branched on: the row already had a
      // live owner (this epoch, on the second poll of the same message), or a
      // gate cancelled it in the last instant, or this poll's own lease is
      // dead. The first two make the attempt below proceed or skip on their
      // own merits, and the third must stay loud -- `attempt` refuses it with
      // a durable refusal row, which is the behaviour a stale poll had before
      // this line existed and still has.
      this._outbox.adoptIfUnowned(message.messageId, { nowMs: attemptNow, epoch });
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
        //
        // "Settled" here means *any* terminal status, not `acked` alone. Since
        // migration 0003 a row can also finish as `cancelled`, written by gate
        // closure while this attempt was in flight, and the outbox surfaces that
        // the same two ways: `Outbox.attempt` refuses a terminal row
        // (OutboxUsageError) and the fenced `_MARK_DELIVERED` finds no row to
        // move. Testing for `acked` alone made a gate-cancelled row re-throw
        // here, and the blast radius of that re-throw is the reason this is not
        // a cosmetic difference: the throw leaves `poll` entirely, so every
        // envelope already built in this batch is discarded (the array is
        // local and is never returned), and the failure reaches the worker as
        // an `isError` tool response (`src/messagebus/endpoint.ts:319-331`).
        // One relay whose human gate closed must not fail a poll that is
        // carrying other recipients' -- and this recipient's other -- work.
        //
        // Like the post-snapshot re-read above, this site is NOT among the four
        // predicates `docs/design/minimal-operating-loop.md` section 5.1
        // enumerates. Section 5.1 line 694 calls those four "the floor rather
        // than the list"; these two `src/messagebus/bus.ts` tests are the part
        // above the floor, invisible to a search of the outbox's SQL because
        // they are written in TypeScript against `load().status`.
        //
        // `CancellationRaced` is the *third* shape, and it is the one the
        // outbox raises deliberately rather than as a side effect of a
        // predicate missing its row. Its two members are the two sides of the
        // one act this loop cannot take back: `CancelledBeforeEffect`, raised
        // when `Outbox.attempt` re-reads the status immediately before
        // `handler.apply()` and finds the gate closed with the effect not yet
        // performed; and `CancelledAfterEffect`, raised when the cancellation
        // won the other race and `_MARK_DELIVERED` found no row to move, in
        // which case the effect DID land and a `'refused'` action row records
        // that it did. The base is what is tested here, not either member: this
        // site asks only whether the delivery ended, and a later third window
        // -- there have already been two -- must not need this line found and
        // widened again. It is admitted here for exactly the same
        // reason the other two are -- the row is terminal, so the delivery is
        // finished and nobody is owed it -- and omitting it would make the
        // guard that prevents the side effect cost the whole batch instead,
        // which is a worse outcome than the one it was added to prevent. The
        // re-read below is still what decides: the class says only *how* the
        // attempt stopped, never that the row is in fact settled.
        const residual =
          error instanceof OutboxUsageError ||
          error instanceof StaleWriterRefused ||
          error instanceof CancellationRaced;
        if (residual && isTerminalOutboxStatus(this._outbox.load(message.messageId).status)) {
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
   * record. Since migration 0003 there is one more no-op: an ack that arrives
   * after gate closure cancelled the row reports
   * `{ recorded: false, cancelled: true, ackedAtMs: null }` rather than
   * refusing, because a late ack changing nothing is this module's contract and
   * a cancelled row is a row that finished -- it is `Outbox.recordAck`'s
   * judgement to make, and this facade keeps passing it through unchanged.
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
