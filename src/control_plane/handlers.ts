import { AssertionError } from "node:assert";
import type { Destination } from "./destination.js";
import { type DeliveryReceipt, DestinationRefusal, isDestination } from "./destination.js";
import type { OutboxMessage } from "./outbox.js";
import { ActionHandler, HandlerRegistry } from "./outbox.js";
import { pythonRepr } from "./python_repr.js";

/**
 * S7 -- the one action handler, and the mechanism it names.
 *
 * **The database underneath is the production one; the counterparty is
 * still a stand-in.** This paragraph used to say, flatly, that the module was
 * spike scaffold (D-0026) because it "still sits on the throwaway S5 schema",
 * and half of that has stopped being true. `src/messagebus/endpoint.ts` opens
 * its control plane through `openProductionControlPlane` and builds its
 * {@link Outbox} on that connection before handing it the registry
 * {@link spikeRegistry} assembles (`src/messagebus/endpoint.ts:557-558`), so the
 * rows this handler set is dispatched against are production `outbox` rows
 * under migration 0003's four-status lattice -- `'cancelled'` included, a
 * word a gate closure writes and that no S5 database could hold. `Q-0001` is
 * likewise answered rather than open: D-0029 put the per-item single-writer
 * table in `docs/production-schema.md` section 4.2 and its DDL in
 * `control_plane/migrations/0001_initial.sql`.
 *
 * **What the repoint did not touch is the destination side, and that side is
 * still scaffold, throwaway by default (D-0026).** {@link spikeRegistry}'s one
 * delivering handler applies its effect to a {@link Destination} that is a
 * directory of files (`KeyedDropbox`, `src/control_plane/destination.ts`), and
 * a directory of files is not a transport. It models exactly one property of a
 * real destination -- that the *destination*, not the sender, refuses the
 * duplicate, decided by `O_EXCL` rather than by any row of ours -- and that
 * module's own docstring is explicit that nothing else about one is modelled.
 * Replacing it with a real keyed destination is the next thing on this path;
 * moving the database did not do it and must not be read as having done it.
 * The durable half of Issue `#14` is the suite.
 *
 * Issue `#14` asks for **one** handler, and is specific about what makes it
 * count:
 *
 * One action handler that **declares** its mechanism: either (1) a
 * destination-supported idempotency key, or (2) transactional commit of
 * effect and record together. Where neither is achievable for a given
 * action, the gap is explicit and the action requires a **human gate**
 * (D-0004) rather than automatic recovery. If the chosen handler turns out
 * to be such a case, say so and pick a different one -- **do not paper over
 * it**.
 *
 * So the choice of handler is itself part of the deliverable, and it is
 * recorded here rather than in a commit message.
 *
 * **What was chosen, and why.** {@link NotifyDestinationHandler} declares
 * `'destination_idempotency_key'`. Its counterparty is a
 * {@link Destination}, which deduplicates on the key and keeps its own
 * record of the effect. That is the only one of the three mechanisms whose
 * evidence satisfies `ACCEPTANCE.md` section 2 without argument: *a case
 * that asserts exactly-once for an external effect using only our own rows
 * does not pass*, and this handler's exactly-once claim is read back out of
 * a store this process does not write transactionally.
 *
 * **What was rejected, and why -- because the rejection is the interesting
 * half.**
 *
 * *Transactional commit of effect and record together* (mechanism 2) was the
 * obvious first candidate, and it is genuinely the stronger mechanism where
 * it applies: it collapses the ambiguous window instead of tolerating it. It
 * was not chosen because a handler demonstrating it truthfully would need an
 * effect that lives in the **same** transaction as its record -- that is, an
 * effect inside our own SQLite. An effect internal to the control plane is a
 * fine thing to have, but using it to discharge item 4 would be exactly the
 * reading of the criterion the gate rules out: the mid-flight kill it is
 * meant to survive is the one where the effect is external and its result
 * was not recorded, and an effect that commits with its own record cannot be
 * killed in that window by construction. It would pass by not being the case
 * under test.
 *
 * That reasoning is now enforced rather than merely written down:
 * {@link HandlerRegistry} **refuses** a handler declaring
 * `'transactional_with_record'` outright, because {@link Outbox} commits the
 * action row before calling the handler and hands it no transaction to
 * commit an effect inside. A handler could declare the mechanism and be
 * admitted while the execution path could not possibly provide it -- which
 * is the same undeclared-guarantee failure the registration check exists to
 * prevent, arriving through the one branch that looks declared. The
 * mechanism stays in the vocabulary, since it is `ACCEPTANCE.md`'s and the
 * DDL's rather than this module's; what is refused is claiming it here.
 *
 * *A human gate* (D-0004) was not chosen because for this action it would be
 * false. The gate is for actions where **neither** mechanism is achievable,
 * and the honesty the issue asks for cuts both ways: claiming a human gate
 * for an effect whose destination does support an idempotency key would
 * understate what is provable just as badly as claiming exactly-once for one
 * that does not. {@link HumanGatedHandler} therefore exists as a
 * **declaration**, not as a second delivery path -- see its own docstring.
 *
 * **The handler is deliberately thin.** Almost everything an outbox handler
 * might be tempted to do -- the retry count, the fence, the pending action
 * row, the delivered transition -- belongs to {@link Outbox}, which does it
 * in an order chosen so the kill windows are real. What is left here is the
 * effect and the key it is applied under, which is precisely the part that
 * differs between one handler and the next.
 */

/** The `outbox.recipient` value {@link NotifyDestinationHandler} serves.
 *
 * A recipient name, not a role name -- and it stays one even now that the
 * database beneath is the production schema. Which component sends to which
 * recipient was the per-item writer assignment `Q-0001` left open at spike
 * time (S5 kept every role out of the DDL for the same reason), and D-0029
 * has since answered it (`docs/production-schema.md` section 4.2). Nothing
 * here consults that answer: this constant is matched against
 * `outbox.recipient` as a literal string, and the endpoint pins one recipient
 * per process from `INTERLOCK_MESSAGEBUS_RECIPIENT` rather than deriving one
 * from a role. Reading the writer assignment instead of naming a queue is work
 * the real transport will do; it is not work the repoint did.
 */
export const NOTIFY_RECIPIENT = "external-notify";

/** The recipient {@link HumanGatedHandler} serves. See that class: it
 * delivers nothing, on purpose. */
export const HUMAN_GATED_RECIPIENT = "human-gated-effect";

/**
 * The spike's one real handler. Mechanism: a destination idempotency key.
 *
 * The effect is applied to a {@link Destination} under a key the destination
 * deduplicates. Everything the exactly-once claim rests on is therefore
 * *the destination's*: this handler makes no attempt to decide whether a
 * previous attempt landed, because deciding that is the thing
 * `ACCEPTANCE.md` section 2 says cannot be done from our side.
 *
 * Concretely, the property that matters is that {@link apply} is safe to
 * call an unbounded number of times with the same key. It is called again
 * after a lost ack, again after a kill between the effect and its record,
 * and again after a re-enqueue of the same dedup key -- and the
 * destination's effect count stays one across all of them.
 */
export class NotifyDestinationHandler extends ActionHandler {
  override readonly recipient: string = NOTIFY_RECIPIENT;
  override readonly actionKind: string = "notify";
  override readonly exactlyOnceMechanism: string = "destination_idempotency_key";

  private readonly _destination: Destination;

  constructor(destination: Destination) {
    super();
    if (!isDestination(destination)) {
      // Declaring 'destination_idempotency_key' without a counterparty that
      // deduplicates one is declaring a guarantee with nothing behind it, so
      // it is refused where the claim is made rather than where it would
      // first be relied on.
      throw new TypeError(
        "NotifyDestinationHandler declares 'destination_idempotency_key' and so " +
          "requires a Destination that deduplicates one",
      );
    }
    this._destination = destination;
  }

  get destination(): Destination {
    return this._destination;
  }

  override apply(
    message: OutboxMessage,
    idempotencyKey: string,
    fencingToken: number | null = null,
    fenceScope: string | null = null,
  ): DeliveryReceipt {
    // The token is handed to the destination rather than checked here.
    // Checking it on this side would prove nothing: the window it closes is
    // the one where *this process* was paused past its lease, and a paused
    // process cannot notice that it was paused. Only the counterparty is
    // still running (ACCEPTANCE.md section 2: *external destinations must
    // reject a stale token where they can enforce it*).
    const receipt = this._destination.apply(
      idempotencyKey,
      message.payload,
      fencingToken,
      fenceScope,
    );
    if (receipt.payloadConflict) {
      // The key is already bound to a different payload. The destination
      // applied nothing, which is right -- an idempotency key names an
      // effect, so the same key with new content is a dedup-key collision
      // rather than a new effect. Recording it as delivered would let the
      // collision pass as an exactly-once success, which is the failure mode
      // this whole module is built to make impossible.
      throw new DestinationRefusal(
        `${pythonRepr(idempotencyKey)} is already applied at ${pythonRepr(receipt.destination)} ` +
          `under a different payload; the dedup key of ${pythonRepr(message.messageId)} collides ` +
          "with an effect that is not this one",
      );
    }
    return receipt;
  }
}

/**
 * A declaration that neither mechanism is achievable (D-0004).
 *
 * This is **not** a second delivery path and it is not a fallback. It exists
 * so that the third branch of `ACCEPTANCE.md` section 2's clause is
 * expressible in code and provable by a test, instead of surviving only as a
 * sentence in a document that a future handler author will not read.
 *
 * {@link apply} raises. The gap is meant to be visible: an action whose
 * destination supports no idempotency key and whose effect cannot commit
 * with its record is one a human decides about, and {@link Outbox} refuses
 * to advance it -- it records the pending action and raises
 * {@link HumanGateRequired} before any effect is attempted. Automatic
 * recovery here would be the papering-over Issue `#14` names.
 */
export class HumanGatedHandler extends ActionHandler {
  override readonly recipient: string = HUMAN_GATED_RECIPIENT;
  override readonly actionKind: string = "human_gated";
  override readonly exactlyOnceMechanism: string = "human_gate";

  override apply(
    _message: OutboxMessage,
    _idempotencyKey: string,
    _fencingToken: number | null = null,
    _fenceScope: string | null = null,
  ): DeliveryReceipt {
    // Mirrors the source's `raise AssertionError(...)`: node:assert's own
    // AssertionError, not a bespoke class, so the name and shape an operator
    // sees match Python's built-in as closely as the runtimes allow.
    throw new AssertionError({
      message:
        "a human-gated action is never applied automatically (D-0004); Outbox.attempt raises " +
        "HumanGateRequired before reaching a handler",
    });
  }
}

/**
 * The spike's handler set: one that delivers, one that declares it cannot.
 *
 * Assembled in a function rather than at import time so that a test can
 * build an independent registry -- a module-level singleton would make "a
 * handler that fails registration is not registered" untestable, and that is
 * one of the acceptance criteria.
 */
export function spikeRegistry(destination: Destination): HandlerRegistry {
  const registry = new HandlerRegistry();
  registry.register(new NotifyDestinationHandler(destination));
  registry.register(new HumanGatedHandler());
  return registry;
}
