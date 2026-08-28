/**
 * Item 8's behavioural half: the intake answers while every consumer stalls.
 *
 * Ported from interlock `tests/secretary/test_behaviour.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping, the systematic
 * translations and the one deliberate divergence are recorded in
 * `parity/secretary.behaviour.ledger.json`.
 *
 * Each of the first three cases stalls one of the three dependencies gate item
 * 8 names -- worker monitoring, long-running work, an AI judgement --
 * **verifiably**, and then drives the intake, asserting every request receives
 * its receipt while the stall is still in force.
 *
 * **The stall is proved by state order, never by a clock.** The source parks a
 * real thread on an `Event` or a pipe that the test controls and has not
 * released, then asks `t.is_alive()`. This port keeps the shape and drops the
 * thread where Node has none: a consumer takes its item, publishes the stage it
 * reached, and parks on a Promise this file holds the only resolver for. While
 * it is parked -- and "parked" is a fact about the resolver, not about elapsed
 * time -- every submit is made and every receipt collected, and the case then
 * asserts the stall was still unreleased and the consumer still incomplete. The
 * one case whose subject is a genuinely blocked *thread* keeps one: it parks a
 * `worker_threads` worker in `Atomics.wait` after a handshake, which is a real
 * OS thread that really is stopped, and releases it in the teardown.
 *
 * **No latency number is asserted anywhere**: interlock `Q-0011` is unresolved
 * and this suite does not invent a threshold. The assertions are ordering and
 * completeness -- receipts exist, are answered, and were produced while the
 * consumer demonstrably made no progress. The suite's timeouts are the runner's
 * own (`vitest.config.ts`), and they only bound how long a *failing* run hangs;
 * they are not acceptance numbers, exactly as the source says of its
 * `join(timeout=30)`.
 *
 * Durable tests (interlock D-0026) for the **rehearsal** of gate item 8
 * (interlock Issue #21, interlock D-0022). The discharge point is the real
 * Secretary under genuine worker load, before the canary starts.
 */

import { Worker } from "node:worker_threads";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  ACCEPTED,
  IntakeQueue,
  type IntakeReceipt,
  REFUSED_QUEUE_FULL,
  SecretaryIntake,
} from "../../src/secretary/intake.js";

/** The source's `_submit_all`. */
function submitAll(intake: SecretaryIntake, n: number): IntakeReceipt[] {
  const receipts: IntakeReceipt[] = [];
  for (let i = 0; i < n; i += 1) {
    receipts.push(intake.submit({ seq: i }));
  }
  return receipts;
}

/**
 * Yield to the event loop, macrotask included.
 *
 * `setImmediate` rather than `Promise.resolve()`: a microtask-only yield hands
 * control back to the same continuation queue, so a spin written on it can
 * starve everything else in the loop. This is test mechanics -- it is how one
 * asynchronous participant lets another run -- and never a wait for a duration.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * A stall this file holds the only key to.
 *
 * The port of the source's `threading.Event`: `promise` is what a consumer
 * parks on, `release()` is `set()`, and `released` is `is_set()`. The flag is
 * what the assertions read, so "the stall was still in force" is a fact about
 * this object and not about how long anything took.
 */
interface Stall {
  readonly promise: Promise<void>;
  release(): void;
  readonly released: boolean;
}

function stall(): Stall {
  let release: () => void = () => undefined;
  let released = false;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release(): void {
      released = true;
      release();
    },
    get released(): boolean {
      return released;
    },
  };
}

describe("the intake answers while every consumer stalls", () => {
  test("intake answers while an AI judgement is in flight", async () => {
    // An open incident awaiting Dispatcher AI judgement blocks nothing. The
    // consumer pulls a batch (the incident) and parks inside its "judgement" --
    // a stall this test never releases while submitting.
    const queue = new IntakeQueue(64);
    const intake = new SecretaryIntake(queue);
    const judgementStarted = stall();
    const judgementDone = stall();
    let consumerCompleted = false;

    const consumer = (async () => {
      while (queue.takeBatch(1).length === 0) {
        await tick(); // incident not enqueued yet
      }
      judgementStarted.release();
      await judgementDone.promise; // the AI judgement, in flight
      consumerCompleted = true;
    })();
    onTestFinished(async () => {
      judgementDone.release();
      await consumer;
    });

    intake.submit({ kind: "incident", awaiting: "dispatcher-ai" });
    await judgementStarted.promise;
    expect(judgementStarted.released, "consumer never picked up").toBe(true);

    const receipts = submitAll(intake, 32);

    expect(
      judgementDone.released || consumerCompleted,
      "the stall was released early; the test proved nothing",
    ).toBe(false);
    expect(receipts.map((receipt) => receipt.status)).toEqual(Array<string>(32).fill(ACCEPTED));
    expect(receipts.every((receipt) => receipt.answeredNs >= receipt.receivedNs)).toBe(true);
    expect(queue.depth(), "consumer progressed while parked").toBe(32);
  });

  test("intake answers while long-running work holds the consumer", async () => {
    // Identical boundary, different stall site: the consumer took its batch and
    // is stuck in the *work*, after `takeBatch` returned -- the contract that
    // processing happens outside the boundary is what this exercises. The stage
    // it publishes is `in-work`, not `in-judgement`, so the two cases cannot go
    // green on each other's evidence.
    const queue = new IntakeQueue(64);
    const intake = new SecretaryIntake(queue);
    const workStarted = stall();
    const workDone = stall();
    let stage = "not-started";
    let consumerCompleted = false;

    const consumer = (async () => {
      while (queue.takeBatch(8).length === 0) {
        await tick();
      }
      stage = "in-work";
      workStarted.release();
      await workDone.promise; // the long-running task, in flight
      stage = "work-finished";
      consumerCompleted = true;
    })();
    onTestFinished(async () => {
      workDone.release();
      await consumer;
    });

    intake.submit({ kind: "task", shape: "long-running" });
    await workStarted.promise;
    expect(stage, "consumer never picked up").toBe("in-work");

    const receipts = submitAll(intake, 32);

    expect(
      workDone.released || consumerCompleted,
      "the stall was released early; the test proved nothing",
    ).toBe(false);
    expect(receipts.map((receipt) => receipt.status)).toEqual(Array<string>(32).fill(ACCEPTED));
  });

  test("intake answers while worker monitoring blocks its thread", async () => {
    // The C2 analogue of U6 in miniature: the blocking hazard lives in
    // supervisor code (a per-child blocking read), and even when that code
    // *does* block, the intake path cannot inherit the stall, because no lock,
    // queue, or call edge connects them.
    //
    // This is the one case whose subject is a genuinely blocked thread, so it
    // keeps one. The source parks a Python thread in `os.read` on a pipe with
    // no writer; the port parks a `worker_threads` worker in `Atomics.wait` on
    // a shared flag this test is the only writer of. Both are a real OS thread
    // stopped by the kernel, and both are released by the test in teardown.
    // Node has no blocking pipe read that would leave the thread interruptible
    // the way the source needs, and `Atomics.wait` states the same fact --
    // "this thread is stopped until I say otherwise" -- without a file
    // descriptor to clean up.
    const queue = new IntakeQueue(64);
    const intake = new SecretaryIntake(queue);

    const shared = new SharedArrayBuffer(4);
    const flag = new Int32Array(shared);
    let monitorReleased = false;

    const worker = new Worker(
      // CommonJS on purpose: an `eval` worker is loaded as CommonJS, and
      // keeping the parked thread inline is what stops this case from
      // depending on a build step to have a thread to park.
      'const { workerData, parentPort } = require("node:worker_threads");\n' +
        "const flag = new Int32Array(workerData.shared);\n" +
        'parentPort.postMessage("monitoring");\n' +
        "Atomics.wait(flag, 0, 0);\n" +
        'parentPort.postMessage("released");\n',
      { eval: true, workerData: { shared } },
    );
    const monitoring = new Promise<void>((resolve) => {
      worker.on("message", (message: string) => {
        if (message === "monitoring") {
          resolve();
        } else if (message === "released") {
          monitorReleased = true;
        }
      });
    });
    onTestFinished(async () => {
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
      await worker.terminate();
    });

    await monitoring;

    const receipts = submitAll(intake, 32);

    expect(Atomics.load(flag, 0), "monitor unblocked early; the test proved nothing").toBe(0);
    expect(monitorReleased, "monitor unblocked early; the test proved nothing").toBe(false);
    expect(receipts.map((receipt) => receipt.status)).toEqual(Array<string>(32).fill(ACCEPTED));
  });

  test("a full queue is an immediate recorded refusal", () => {
    // Backpressure is a refusal, not a wait -- and the refusal is recorded.
    const queue = new IntakeQueue(2);
    const intake = new SecretaryIntake(queue);

    const [first, second, third] = [0, 1, 2].map((seq) => intake.submit({ seq }));
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("submit returned nothing");
    }

    expect(first.status).toBe(ACCEPTED);
    expect(second.status).toBe(ACCEPTED);
    expect(third.status).toBe(REFUSED_QUEUE_FULL);
    expect(third.answeredNs >= third.receivedNs).toBe(true);
    const refusals = intake.refusals();
    expect(refusals.map((refusal) => refusal.requestId)).toEqual([third.requestId]);
    expect(refusals[0]?.queueDepth).toBe(2);
    // The refusal consumed no capacity and lost no accepted item.
    const drained = queue.takeBatch(10);
    expect(drained.map((item) => item.requestId)).toEqual([first.requestId, second.requestId]);
  });

  test("the boundary is FIFO and pull-only", () => {
    // Consumers pull; an empty queue yields [] at once, order is preserved.
    const queue = new IntakeQueue(8);
    const intake = new SecretaryIntake(queue);

    expect(queue.takeBatch(4)).toEqual([]);
    const receipts = submitAll(intake, 5);
    const got = queue.takeBatch(3);
    expect(got.map((item) => item.requestId)).toEqual(
      receipts.slice(0, 3).map((receipt) => receipt.requestId),
    );
    expect(queue.depth()).toBe(2);
    const rest = queue.takeBatch(10);
    expect(rest.map((item) => item.requestId)).toEqual(
      receipts.slice(3).map((receipt) => receipt.requestId),
    );
  });

  test("concurrent producers never lose or duplicate a request", async () => {
    // Many windows' worth of producers against a queue that is never drained.
    // Every submit is answered exactly once; accepted + refused == submitted;
    // accepted items all cross the boundary with distinct identities.
    //
    // **Adapted (D-0701).** The source runs eight OS threads and tolerates the
    // one imprecision its lock-free design buys: with P concurrent producers
    // the check-then-append race may overshoot capacity by at most P - 1. That
    // race does not exist here -- `submit()` is synchronous and
    // run-to-completion, so no second producer can be part-way through one --
    // and asserting a tolerance for an overshoot that cannot happen would be a
    // ported case that passes on a broken implementation. So the acceptance
    // count is asserted **exactly**, and the concurrency the source got from
    // threads is spelled as interleaving on the event loop: each producer
    // yields between submits, so the eight are genuinely interleaved rather
    // than run one after another. That interleaving is witnessed below, because
    // a case named for concurrency that ran serially would prove nothing.
    const queue = new IntakeQueue(100);
    const intake = new SecretaryIntake(queue);
    const producerCount = 8;
    const perProducer = 50;

    const slots = await Promise.all(
      Array.from({ length: producerCount }, async (_unused, slot) => {
        const mine: IntakeReceipt[] = [];
        for (let i = 0; i < perProducer; i += 1) {
          await tick();
          mine.push(intake.submit({ slot, seq: i }));
        }
        return mine;
      }),
    );

    const flat = slots.flat();
    expect(flat).toHaveLength(producerCount * perProducer);
    expect(new Set(flat.map((receipt) => receipt.requestId)).size).toBe(flat.length);
    const accepted = flat.filter((receipt) => receipt.status === ACCEPTED);
    const refused = flat.filter((receipt) => receipt.status === REFUSED_QUEUE_FULL);
    expect(accepted.length + refused.length).toBe(flat.length);
    expect(
      accepted.length,
      "a run-to-completion submit cannot interleave, so the capacity bound is exact",
    ).toBe(100);
    const drained = queue.takeBatch(1000);
    expect(drained).toHaveLength(accepted.length); // nothing lost, nothing dropped
    expect(new Set(drained.map((item) => item.requestId)).size).toBe(accepted.length);
    expect(intake.refusals()).toHaveLength(refused.length);

    // The interleaving witness: a producer's request ids are contiguous only if
    // it ran without anyone else between its submits.
    const contiguous = slots.filter((mine) => {
      const first = mine[0];
      const last = mine[mine.length - 1];
      return (
        first !== undefined &&
        last !== undefined &&
        last.requestId - first.requestId === perProducer - 1
      );
    });
    expect(
      contiguous,
      "no producer interleaved with another; this case would prove nothing about concurrency",
    ).toEqual([]);
  });
});
