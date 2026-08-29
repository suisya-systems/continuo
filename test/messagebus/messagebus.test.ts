import { describe, expect, test } from "vitest";

import {
  CHECKPOINT_BEFORE_DURABLE_WRITE,
  HandlerRejected,
  OutboxUsageError,
  StaleWriterRefused,
} from "../../src/control_plane/outbox.js";
import { createTempDir } from "../helpers/tmp.js";
import { expectRefusal } from "../testkit/errors.js";
import {
  type BusEnv,
  busEnv,
  dropThenResendTranscript,
  EPOCH,
  expectedTranscript,
  makeBusEnv,
  RECIPIENT,
  RUN_ID,
  T0,
} from "./_env.js";

/**
 * S8 -- interlock gate item 6's acceptance core: drop, resend, exactly one ack.
 *
 * Ported from interlock `tests/messagebus/test_messagebus.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping, the systematic
 * translations and the deliberate divergences are recorded in
 * `parity/messagebus.bus.ledger.json`.
 *
 * **These tests are the durable half of interlock Issue `#19` (interlock
 * D-0026)** together with the import-graph assertion beside them. The bus they
 * drive is throwaway; the facts they pin -- a dropped first delivery resends to
 * exactly one ack, and every delivery decision derives from SQLite -- are the
 * contract whatever replaces `src/messagebus/` still has to satisfy.
 *
 * The headline sequence lives in `_env.ts`'s `dropThenResendTranscript` rather
 * than inline, because the stale-readout case (`stale-readout.test.ts`) must run
 * *the same* sequence and compare results for equality -- see that file for why
 * sameness is the assertion there.
 */

function send(
  env: BusEnv,
  options: { messageId?: string; dedupKey?: string; payload?: string } = {},
) {
  const { messageId = "task-1", dedupKey, payload = '{"task":"t"}' } = options;
  return env.bus.send({
    messageId,
    recipient: RECIPIENT,
    payload,
    dedupKey: dedupKey ?? `dk-${messageId}`,
    nowMs: T0,
    epoch: EPOCH,
    runId: RUN_ID,
  });
}

describe("the message bus: drop, resend, exactly one ack", () => {
  test("a dropped first delivery resends to exactly one ack", () => {
    // interlock's item 6 acceptance case, with no UI attached.
    //
    // There is no UI in this process, no session backend, no worker process
    // even -- only the bus and its database. That the case runs at all in this
    // emptiness is the F1 caveat made visible: the "no UI attached" condition is
    // trivially satisfied because nothing on the delivery path could attach one.
    expect(dropThenResendTranscript(busEnv())).toEqual(expectedTranscript());
  });

  test("a message stays due until the ack and not after", () => {
    // Resend is the default state, not a recovery mode. Delivered-but-unacked
    // rows keep being presented -- however many responses are lost -- and the
    // destination's own ledger holds one effect throughout. The ack, and nothing
    // else, is what stops the presentations.
    const env = busEnv();
    send(env, { messageId: "task-1" });
    for (const lostResponse of [1, 2, 3]) {
      const envelopes = env.bus.poll(RECIPIENT, {
        nowMs: T0 + lostResponse * 1_000,
        epoch: EPOCH,
      });
      expect(envelopes.map((e) => e.messageId)).toEqual(["task-1"]);
      expect(env.effectCount("dk-task-1")).toBe(1);
    }
    env.bus.ack("task-1", { nowMs: T0 + 5_000, recipient: RECIPIENT });
    expect(env.bus.poll(RECIPIENT, { nowMs: T0 + 6_000, epoch: EPOCH })).toEqual([]);
    expect(env.effectCount("dk-task-1")).toBe(1);
  });

  test("a send to an unregistered recipient is refused before the write", () => {
    const env = busEnv();
    expectRefusal(
      () =>
        env.bus.send({
          messageId: "task-x",
          recipient: "nobody-serves-this",
          payload: "{}",
          dedupKey: "dk-x",
          nowMs: T0,
          epoch: EPOCH,
          runId: RUN_ID,
        }),
      HandlerRejected,
    );
    const row = env.connection.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
    expect(Number(row.n), "a refused send must not leave an undeliverable row").toBe(0);
  });

  test("an ack for a never polled message is refused", () => {
    // An ack for an undelivered message is evidence of a lost delivery record.
    const env = busEnv();
    send(env, { messageId: "task-1" });
    expectRefusal(
      () => env.bus.ack("task-1", { nowMs: T0 + 1_000, recipient: RECIPIENT }),
      OutboxUsageError,
      /has not been delivered/,
    );
  });

  test("poll presents only the polling recipient's messages", () => {
    // The recipient boundary holds at the poll, not just at the send.
    const env = busEnv();
    send(env, { messageId: "task-1" });
    expect(env.bus.poll("someone-else", { nowMs: T0 + 1_000, epoch: EPOCH })).toEqual([]);
    const envelopes = env.bus.poll(RECIPIENT, { nowMs: T0 + 2_000, epoch: EPOCH });
    expect(envelopes.map((e) => e.messageId)).toEqual(["task-1"]);
  });

  test("a stale writer cannot poll a delivery out", () => {
    // The fence runs through the bus unchanged: a superseded epoch is refused.
    const env = busEnv();
    send(env, { messageId: "task-1" });
    expectRefusal(
      () => env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH + 1 }),
      StaleWriterRefused,
    );
  });

  test("a message acked between polls is skipped without audit noise", () => {
    // The common late-ack shape: settled between the snapshot and the attempt.
    // The poll re-reads the row before attempting it, so an ordinary concurrent
    // ack neither errors the poll nor leaves a durable stale-writer refusal
    // behind -- the audit trail records only real fence refusals.
    const env = busEnv();
    send(env, { messageId: "task-1" });
    send(env, { messageId: "task-2" });
    env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
    env.bus.ack("task-2", { nowMs: T0 + 1_500, recipient: RECIPIENT });
    const second = env.bus.poll(RECIPIENT, { nowMs: T0 + 2_000, epoch: EPOCH });
    expect(second.map((e) => e.messageId)).toEqual(["task-1"]);
    expect(env.refusedActionCount()).toBe(0);
  });

  test("a message settled mid poll is skipped, not an error", () => {
    // A late ack landing between the due() snapshot and the attempt.
    //
    // An earlier delivery's ack can settle a row after a poll has read its due
    // set but before it attempts that row. A settled message is the poll's
    // success case: it is skipped, and the rest of the batch is still presented
    // -- the race must not turn a whole poll into an error. Reproduced
    // deterministically by acking task-2 from inside task-1's first checkpoint.
    //
    // Fire inside task-2's own attempt (the second BEFORE_DURABLE_WRITE of the
    // armed poll): task-1's attempt runs first, then task-2 is re-read as still
    // unsettled, enters attempt(), and only then is acked -- the residual window
    // the pre-attempt re-read cannot close.
    const state = { armed: false, seen: 0 };
    const settleTask2MidPoll = (name: string): void => {
      if (state.armed && name === CHECKPOINT_BEFORE_DURABLE_WRITE) {
        state.seen += 1;
        if (state.seen === 2) {
          env.bus.ack("task-2", { nowMs: T0 + 1_500, recipient: RECIPIENT });
        }
      }
    };

    const env = makeBusEnv(createTempDir("mid-poll"), "mid-poll", {
      checkpoint: settleTask2MidPoll,
    });
    try {
      send(env, { messageId: "task-1" });
      send(env, { messageId: "task-2" });
      const first = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
      expect(first.map((e) => e.messageId)).toEqual(["task-1", "task-2"]);
      state.armed = true;
      const second = env.bus.poll(RECIPIENT, { nowMs: T0 + 2_000, epoch: EPOCH });
      expect(second.map((e) => e.messageId)).toEqual(["task-1"]);
      expect(env.ackedRowCount()).toBe(1);
      // The known cost of the residual window, pinned so it stays known: the
      // fenced attempt-count update had already recorded one refusal row before
      // the settle was recognised. Audit noise, not a delivery fault -- see
      // MessageBus.poll's own comment.
      expect(env.refusedActionCount()).toBe(1);
    } finally {
      env.close();
    }
  });

  test("a poll outliving its lease stops at the expiry", () => {
    // A long poll is fenced at each write, not at the instant it started.
    //
    // With a live clock, the attempt that lands past the lease expiry is refused
    // loudly instead of the batch draining to completion on the stale
    // start-of-poll timestamp -- the single-writer guarantee holds through the
    // poll, not just at its first row.
    const env = busEnv();
    send(env, { messageId: "task-1" });
    send(env, { messageId: "task-2" });
    // First attempt inside the lease, second one long past its expiry.
    const instants = [T0 + 1_000, T0 + 1_000_000];
    let read = 0;
    const clock = (): number => {
      const instant = instants[read];
      read += 1;
      if (instant === undefined) {
        // `next(instants)` raising StopIteration: the case is written for
        // exactly two attempts, and a third would mean the poll did something
        // this test does not describe.
        throw new Error("the poll asked for a third instant; the case expects two attempts");
      }
      return instant;
    };
    expectRefusal(
      () => env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH, clock }),
      StaleWriterRefused,
    );
    const statuses = Object.fromEntries(
      (
        env.connection.prepare("SELECT message_id, status FROM outbox").all() as {
          message_id: string;
          status: string;
        }[]
      ).map((row) => [row.message_id, row.status]),
    );
    expect(statuses).toEqual({ "task-1": "delivered", "task-2": "pending" });
  });

  test("two tasks settle independently", () => {
    const env = busEnv();
    send(env, { messageId: "task-1" });
    send(env, { messageId: "task-2" });
    const first = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
    expect(first.map((e) => e.messageId)).toEqual(["task-1", "task-2"]);
    env.bus.ack("task-1", { nowMs: T0 + 2_000, recipient: RECIPIENT });
    const second = env.bus.poll(RECIPIENT, { nowMs: T0 + 3_000, epoch: EPOCH });
    expect(second.map((e) => e.messageId)).toEqual(["task-2"]);
    env.bus.ack("task-2", { nowMs: T0 + 4_000, recipient: RECIPIENT });
    expect(env.bus.poll(RECIPIENT, { nowMs: T0 + 5_000, epoch: EPOCH })).toEqual([]);
    expect(env.ackedRowCount()).toBe(2);
  });
});
