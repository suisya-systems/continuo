/**
 * Stub Secretary intake with an explicit queue boundary.
 *
 * Ported from interlock `src/claude_org_runtime/secretary/intake.py` at
 * `65f36c5`. Gate item 8 (interlock `ACCEPTANCE.md` section 1) requires that no
 * Secretary response is blocked *behind* worker monitoring, long-running work,
 * or an AI judgement -- structurally, by showing intake and the queue boundary
 * cannot wait on a consumer, and empirically, by a baseline-vs-load latency
 * comparison. This module is the structural half of the **rehearsal** (interlock
 * Issue #21, interlock D-0022): a deliberately minimal intake whose
 * non-blocking property is a property of the code, enforced by
 * `test/secretary/` rather than by convention.
 *
 * The design rule, stated once and asserted three ways:
 *
 * 1. **The intake path performs no blocking call.** `submit()` stamps a
 *    receipt, offers the request to the queue without waiting, and returns it.
 *    It never joins a thread, waits on an event, reads a pipe, sleeps, or calls
 *    into any consumer. `test/secretary/structural.test.ts` bans the blocking
 *    primitives from this package's syntax tree.
 *
 * 2. **There is no suspension point on the response path, so there is nothing
 *    to wait on even implicitly.** The source's spelling of this rule is "no
 *    lock at all": a Python `with lock:` is a blocking `acquire()` whenever the
 *    holder is descheduled, and a ban on *called names* cannot see it because a
 *    context manager acquires implicitly. Node has no lock to take -- but it
 *    has the same class of hazard under a different name. An `await` is a
 *    suspension point whose resumption is at the mercy of whatever else holds
 *    the loop, and it is likewise invisible to a ban on called names. So this
 *    package contains **no `async` function, no `await`, and constructs no
 *    Promise** -- asserted on the syntax tree -- and `submit()` is synchronous
 *    and run-to-completion (D-0701). The price the source pays for its
 *    lock-free deque -- a capacity check exact under one producer and
 *    approximate within the number of concurrent producers -- continuo does not
 *    pay: a run-to-completion `submit()` cannot interleave with another, so the
 *    capacity bound here is exact (D-0701).
 *
 * 3. **This module depends on no other continuo module.** In particular it has
 *    no dependency edge to `session` (the supervisor / provider side) or to any
 *    dispatcher. Worker monitoring and AI judgement cannot block a code path
 *    that cannot reach them. Asserted structurally, following the precedent of
 *    `test/canary/structural.test.ts`.
 *
 * **Backpressure is a refusal, not a wait.** When the bounded queue is full the
 * request is refused and the refusal is recorded on the receipt and in the
 * refusal log -- the intake still answers immediately. Whether a refusal, and
 * at what depth, is *acceptable* is a Secretary-design question outside this
 * rehearsal; what the rehearsal fixes is only that the alternative to
 * acceptance is an immediate recorded refusal, never a block.
 *
 * **Spike scaffold, throwaway by default (interlock D-0026).** State is
 * in-memory on purpose: durable intake (a SQLite-backed inbox) is the real
 * Secretary's concern and is not rehearsed here. No numeric latency threshold
 * appears anywhere in this package -- interlock `Q-0011` is unresolved and this
 * rehearsal does not invent one.
 */

import process from "node:process";

/** Closed vocabulary for receipt statuses: accepted. */
export const ACCEPTED = "accepted";

/** Closed vocabulary for receipt statuses: refused because the queue was full. */
export const REFUSED_QUEUE_FULL = "refused_queue_full";

/** The two members of the closed status vocabulary. */
export type IntakeStatus = typeof ACCEPTED | typeof REFUSED_QUEUE_FULL;

/**
 * What the requester gets back, immediately, in every case.
 *
 * `receivedNs` / `answeredNs` are `process.hrtime.bigint()` stamps taken at
 * entry to and exit from {@link SecretaryIntake.submit}; the empirical harness
 * derives request->response latency from them. They are the port of the
 * source's `time.monotonic_ns()`: the same clock class (monotonic, nanosecond)
 * and the same width, which is why they are `bigint` rather than `number` --
 * Python's `int` carries a nanosecond stamp exactly and a JavaScript double
 * does not (D-0007's rule, applied to a value that is not from SQLite).
 *
 * `queueDepth` is the depth the accept/refuse decision **observed** -- the
 * single read the decision was made on, so receipt and decision cannot
 * contradict each other.
 */
export class IntakeReceipt {
  readonly requestId: number;
  readonly status: IntakeStatus;
  readonly queueDepth: number;
  readonly receivedNs: bigint;
  readonly answeredNs: bigint;

  constructor(fields: {
    requestId: number;
    status: IntakeStatus;
    queueDepth: number;
    receivedNs: bigint;
    answeredNs: bigint;
  }) {
    this.requestId = fields.requestId;
    this.status = fields.status;
    this.queueDepth = fields.queueDepth;
    this.receivedNs = fields.receivedNs;
    this.answeredNs = fields.answeredNs;
    Object.freeze(this);
  }

  /** The source's `IntakeReceipt.accepted` property, kept as a property. */
  get accepted(): boolean {
    return this.status === ACCEPTED;
  }
}

/** A recorded refusal: the queue was observed full at `queueDepth`. */
export class IntakeRefused {
  readonly requestId: number;
  readonly queueDepth: number;
  readonly refusedNs: bigint;

  constructor(fields: { requestId: number; queueDepth: number; refusedNs: bigint }) {
    this.requestId = fields.requestId;
    this.queueDepth = fields.queueDepth;
    this.refusedNs = fields.refusedNs;
    Object.freeze(this);
  }
}

/** What crosses the boundary: the payload plus its intake identity. */
export interface IntakeItem {
  readonly requestId: number;
  readonly payload: unknown;
  readonly enqueuedNs: bigint;
}

/**
 * The explicit, bounded, one-way boundary.
 *
 * The producer side is {@link offer} -- non-blocking, refuses when full. The
 * consumer side is {@link takeBatch} -- pops what is there and returns at once;
 * the consumer processes items **after** the call returns. Consumers *pull*;
 * nothing on the consumer side is ever invoked, signalled, or waited for by the
 * producer side, and there is no lock, and no suspension point, through which a
 * stalled consumer could be waited on even implicitly.
 *
 * Shared state is a single array used as a FIFO. The source's `deque` is chosen
 * for the atomicity of `append` / `popleft` under CPython's GIL, which is what
 * lets it drop the lock; here both operations are ordinary synchronous
 * statements inside run-to-completion methods, so no other producer or consumer
 * can be part-way through one (D-0701). **The capacity bound is therefore
 * exact**, where the source documents it as exact under one producer and
 * approximate within the number of concurrent producers.
 */
export class IntakeQueue {
  readonly capacity: number;
  /**
   * The FIFO, oldest first.
   *
   * `Array.prototype.shift` is O(n) where the source's `deque.popleft` is O(1),
   * which is a cost, not a semantic difference: {@link takeBatch} drains from
   * the front and this queue is bounded by `capacity`. A ring buffer would be
   * the repair if the bound ever grew; it is not needed for a rehearsal whose
   * state is in-memory and throwaway.
   */
  #items: IntakeItem[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be >= 1");
    }
    this.capacity = capacity;
  }

  /**
   * Append without waiting.
   *
   * `observedDepth` is the single length read the decision was made on
   * (post-append for an acceptance), so the caller can record the depth its
   * outcome actually saw.
   */
  offer(item: IntakeItem): { accepted: boolean; observedDepth: number } {
    const n = this.#items.length;
    if (n >= this.capacity) {
      return { accepted: false, observedDepth: n };
    }
    this.#items.push(item);
    return { accepted: true, observedDepth: n + 1 };
  }

  /**
   * Consumer side: pop up to `limit` items and return at once.
   *
   * Never waits for items; an empty queue yields an empty array.
   */
  takeBatch(limit: number): IntakeItem[] {
    const out: IntakeItem[] = [];
    while (out.length < limit) {
      const item = this.#items.shift();
      if (item === undefined) {
        break;
      }
      out.push(item);
    }
    return out;
  }

  depth(): number {
    return this.#items.length;
  }
}

/**
 * The stub Secretary window: stamp, offer, answer. Nothing else.
 *
 * `submit()` is the entire response path. Its receipt is the response --
 * acceptance into the queue or a recorded refusal -- and producing it involves
 * no interaction with whatever consumes the queue. It is **synchronous**: it
 * returns an {@link IntakeReceipt}, never a Promise, so there is no point in it
 * at which the caller's request is parked behind anything (D-0701). The source
 * leans on CPython's GIL for the atomicity of `next(itertools.count())` and
 * `list.append`; run-to-completion gives the port the same property without
 * naming a mechanism.
 */
export class SecretaryIntake {
  readonly #queue: IntakeQueue;
  #nextId = 1;
  readonly #refusals: IntakeRefused[] = [];

  constructor(queue: IntakeQueue) {
    this.#queue = queue;
  }

  submit(payload: unknown): IntakeReceipt {
    const receivedNs = process.hrtime.bigint();
    const requestId = this.#nextId;
    this.#nextId += 1;
    const { accepted, observedDepth } = this.#queue.offer({
      requestId,
      payload,
      enqueuedNs: receivedNs,
    });
    if (!accepted) {
      this.#refusals.push(
        new IntakeRefused({
          requestId,
          queueDepth: observedDepth,
          refusedNs: process.hrtime.bigint(),
        }),
      );
    }
    return new IntakeReceipt({
      requestId,
      status: accepted ? ACCEPTED : REFUSED_QUEUE_FULL,
      queueDepth: observedDepth,
      receivedNs,
      answeredNs: process.hrtime.bigint(),
    });
  }

  /** The recorded refusals, oldest first (a snapshot copy). */
  refusals(): IntakeRefused[] {
    return [...this.#refusals];
  }
}
