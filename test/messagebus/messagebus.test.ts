import { describe, expect, test } from "vitest";

import { appendEvent, registerConsumer, subscribe } from "../../src/control_plane/events.js";
import { enqueueRelay, openGate } from "../../src/control_plane/gates.js";
import {
  CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
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

  // ------------------------------- target-only: the gate's `cancelled` status
  //
  // Everything below is **target-only**: interlock's
  // `tests/messagebus/test_messagebus.py` has no counterpart for any of it,
  // because the outbox it drove had three statuses and this one has four.
  // Migration `0003_outbox_cancelled_status.sql` added `cancelled`, and
  // `closeGate` (`src/control_plane/gates.ts`) writes it -- a **second writer**
  // moving rows this bus is mid-flight over, taking the `pending -> cancelled`
  // and `delivered -> cancelled` edges without consulting the bus and without
  // holding the bus's lease.
  //
  // These cases are what makes that writer's existence a tested fact here rather
  // than a fact only `test/control_plane/gates.test.ts` knows. They cancel
  // through `BusEnv.cancelRelay`, which reproduces closure's own UPDATE
  // statement (see `_env.ts`) rather than inventing a cancellation shape -- a
  // test written against a shape the product never writes would keep passing
  // after the product's guard was lost.
  //
  // Note that these run against a **production** fixture, which is the whole
  // reason `_env.ts` moved: `cancelled` is not in the spike schema's CHECK
  // constraint, so on the old fixture every one of these cases would have failed
  // at the cancellation rather than at the behaviour it is about.

  test("a message cancelled while pending is never delivered", () => {
    // The case that matters most, and the one with an external cost.
    //
    // Before the fix, a row cancelled between the send and the poll was NOT
    // skipped: `Outbox.attempt` had no terminal guard for `cancelled`, so the
    // row ran the entire delivery path -- retry_count incremented, action row
    // written, and **the handler called, performing the external side effect**
    // -- and only then reached `_MARK_DELIVERED`, whose write the forward-only
    // trigger aborts because `cancelled` has no outgoing edge. The worst
    // possible ordering: the effect happens at the destination, and the database
    // then denies it ever did. A relay whose human gate has closed is a question
    // nobody is waiting for, and asking it anyway is the failure this whole
    // change exists to prevent.
    //
    // So the assertion is not merely "poll did not return it". It is that the
    // destination's own ledger holds nothing for it -- the only evidence that
    // distinguishes "skipped" from "delivered and then disowned".
    const env = busEnv("cancel-pending");
    send(env, { messageId: "task-1" });
    send(env, { messageId: "task-2" });
    expect(env.cancelRelay("task-1"), "the cancellation must have moved a row").toBe(1);

    const envelopes = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
    expect(envelopes.map((e) => e.messageId)).toEqual(["task-2"]);
    expect(
      env.effectCount("dk-task-1"),
      "a cancelled relay must reach the destination zero times",
    ).toBe(0);
    expect(env.outboxStatus("task-1")).toBe("cancelled");
    // Cancellation is a normal ending, not a fault: nothing about it belongs in
    // the refusal audit trail, which exists to record fence violations.
    expect(env.refusedActionCount()).toBe(0);
    // And it stays gone. `due()` is the resend engine; a cancelled row that
    // stayed due would be re-presented on every poll forever.
    expect(env.bus.outbox.due(T0 + 10_000).map((m) => m.messageId)).toEqual(["task-2"]);
  });

  test("a late ack for a cancelled message is a no-op, not a refusal", () => {
    // The recipient answered; the gate closed while the answer was in flight.
    //
    // Nothing the recipient did was wrong and nothing it could have done would
    // have avoided the race, so the ack is reported as changing nothing rather
    // than thrown at whoever sent it -- the same contract a duplicate ack has
    // already had. `ackedAtMs` is `null` and that is a statement, not a gap:
    // 0003's `CHECK ((status = 'acked') = (acked_at_ms IS NOT NULL))` makes it
    // impossible for a cancelled row to carry an ack instant, so `null` here
    // means "no ack exists and none ever will", distinct from the late-duplicate
    // shape where `recorded: false` comes back with a real instant.
    //
    // Two failure modes are pinned at once. Without `recordAck`'s cancelled
    // branch the row would fall through to the *undelivered* check -- a row
    // cancelled while pending has a null `delivered_at_ms` -- and be refused as
    // "evidence of a lost delivery record", a wildly wrong account of a gate
    // closure. And without the UPDATE's narrowing to `status = 'delivered'`, the
    // statement would reach SQLite and be aborted by
    // `outbox_status_is_forward_only` as a constraint error out of a method
    // whose entire contract is that a late ack does not fail.
    const env = busEnv("cancel-after-delivery");
    send(env, { messageId: "task-1" });
    const delivered = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
    expect(delivered.map((e) => e.messageId)).toEqual(["task-1"]);
    expect(env.outboxStatus("task-1")).toBe("delivered");
    expect(env.cancelRelay("task-1"), "the cancellation must have moved a row").toBe(1);

    const outcome = env.bus.ack("task-1", { nowMs: T0 + 2_000, recipient: RECIPIENT });
    expect({
      recorded: outcome.recorded,
      cancelled: outcome.cancelled,
      ackedAtMs: outcome.ackedAtMs,
    }).toEqual({ recorded: false, cancelled: true, ackedAtMs: null });

    expect(env.outboxStatus("task-1"), "a late ack must not move a terminal row").toBe("cancelled");
    expect(env.ackedRowCount()).toBe(0);
    // The one effect is the delivery that really happened, before the gate
    // closed. The ack adds nothing, and neither does a second one.
    expect(env.effectCount("dk-task-1")).toBe(1);
    const again = env.bus.ack("task-1", { nowMs: T0 + 3_000, recipient: RECIPIENT });
    expect(again.recorded).toBe(false);
    expect(again.cancelled).toBe(true);
    expect(env.effectCount("dk-task-1")).toBe(1);
    expect(env.refusedActionCount()).toBe(0);
  });

  test("a cancellation after the due snapshot does not fail the whole poll", () => {
    // A gate closing inside a poll must cost one message, not the batch.
    //
    // `Outbox.due` reads its list once and `MessageBus.poll` then walks it one
    // attempt at a time, so every row after the first is attempted against a
    // database that may have moved. Before the fix the post-snapshot re-read
    // tested for `acked` alone, so a row cancelled in that window fell through
    // into `attempt()` -- which refuses a terminal row with an
    // `OutboxUsageError` that leaves `poll` entirely. `poll` builds its
    // envelopes in a local array and returns it only at the end, so the throw
    // discards every envelope already built, including messages that were
    // delivered successfully and whose effects had already happened. One
    // recipient's closed gate would have failed that recipient's other work.
    //
    // Reproduced deterministically rather than by timing: the cancellation is
    // fired from inside task-1's `before_durable_write` checkpoint, which is the
    // first thing `Outbox.attempt` does -- so it lands after `due()` took its
    // snapshot of both rows and before task-2 is re-read.
    //
    // The assertion is positive on the survivor. "Did not throw" would be
    // satisfied by a poll that skipped everything and returned an empty list,
    // which is the failure with a lost message in it.
    const state = { armed: false, fired: 0 };
    const cancelTask2MidPoll = (name: string): void => {
      if (state.armed && name === CHECKPOINT_BEFORE_DURABLE_WRITE && state.fired === 0) {
        state.fired = env.cancelRelay("task-2");
      }
    };

    const env = makeBusEnv(createTempDir("cancel-mid-poll"), "cancel-mid-poll", {
      checkpoint: cancelTask2MidPoll,
    });
    try {
      send(env, { messageId: "task-1" });
      send(env, { messageId: "task-2" });
      state.armed = true;
      const envelopes = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
      expect(state.fired, "the checkpoint must actually have cancelled a row").toBe(1);
      expect(
        envelopes.map((e) => e.messageId),
        "the surviving message must come back from the same poll the cancellation landed in",
      ).toEqual(["task-1"]);
      expect(env.outboxStatus("task-1")).toBe("delivered");
      expect(env.outboxStatus("task-2")).toBe("cancelled");
      expect(env.effectCount("dk-task-1")).toBe(1);
      expect(env.effectCount("dk-task-2"), "the cancelled row's effect never happened").toBe(0);
      // Skipped before `attempt()` was entered, so nothing was written on
      // task-2's behalf: no fenced attempt-count update, hence no refusal row.
      expect(env.refusedActionCount()).toBe(0);
      // The survivor settles normally afterwards -- the poll was not left in a
      // half-state by the cancellation it walked past.
      expect(env.bus.ack("task-1", { nowMs: T0 + 2_000, recipient: RECIPIENT }).recorded).toBe(
        true,
      );
    } finally {
      env.close();
    }
  });

  test("a cancellation inside the attempt itself is skipped, not raised", () => {
    // The residual window the pre-attempt re-read cannot close.
    //
    // The case above cancels between the snapshot and the attempt, where the
    // re-read catches it. This one cancels once the attempt has already begun,
    // which no amount of checking first can prevent: the gate is a separate
    // writer and a gap always exists. The attempt then fails on its own fenced
    // write, and `poll`'s post-exception residual test is what decides whether
    // that failure is a skip or an error escaping the whole batch. That test
    // used to ask only whether the row was `acked`, so a cancelled row re-threw
    // and took the batch with it.
    //
    // This is the second of the two sites `docs/design/minimal-operating-loop.md`
    // section 5.1 does not enumerate (it calls its four predicates "the floor
    // rather than the list"); both live in `src/messagebus/bus.ts`, invisible to
    // a search of the outbox's SQL. Being un-enumerated is exactly why it gets
    // its own case rather than being folded into the one above.
    //
    // Fired on the SECOND `before_durable_write` of the armed poll, which is
    // task-2's own: task-1 is attempted and delivered first, task-2 is then
    // re-read as still pending, enters `attempt()`, and is cancelled from
    // inside it.
    const state = { armed: false, seen: 0, fired: 0 };
    const cancelTask2InsideItsAttempt = (name: string): void => {
      if (state.armed && name === CHECKPOINT_BEFORE_DURABLE_WRITE) {
        state.seen += 1;
        if (state.seen === 2) {
          state.fired = env.cancelRelay("task-2");
        }
      }
    };

    const env = makeBusEnv(createTempDir("cancel-in-attempt"), "cancel-in-attempt", {
      checkpoint: cancelTask2InsideItsAttempt,
    });
    try {
      send(env, { messageId: "task-1" });
      send(env, { messageId: "task-2" });
      state.armed = true;
      const envelopes = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
      expect(state.fired, "the checkpoint must actually have cancelled a row").toBe(1);
      expect(
        envelopes.map((e) => e.messageId),
        "task-1 was delivered before the cancellation and must still be returned",
      ).toEqual(["task-1"]);
      expect(env.outboxStatus("task-2")).toBe("cancelled");
      // The point of the terminal guard inside `attempt()`: the fenced
      // attempt-count update excludes terminal rows, so the delivery path stops
      // there -- before the handler is called. The destination never hears about
      // a relay whose gate closed.
      expect(env.effectCount("dk-task-2")).toBe(0);
      // The known cost of the residual window, pinned so it stays known: the
      // fenced update that matched no row is recorded as a refusal before the
      // skip is recognised. Audit noise, not a delivery fault -- the same one
      // "a message settled mid poll is skipped, not an error" pins for a late
      // ack, and MessageBus.poll's own comment explains why eliminating it is
      // out of scope.
      expect(env.refusedActionCount()).toBe(1);
    } finally {
      env.close();
    }
  });

  test("a cancellation just before the effect costs one message, not the batch", () => {
    // The pre-effect guard and the residual test that catches it, pinned as one
    // path -- because they are only ever correct together.
    //
    // `Outbox.attempt` re-reads the row's status immediately before it calls
    // `handler.apply`, beside the fence re-read and for the same reason: the
    // top-of-method terminal check answered "was this message finished when I
    // picked it up", and since migration 0003 that is a different question from
    // "is it finished now", because `pending -> cancelled` is an edge gate
    // closure takes without consulting this bus. When that re-read finds a
    // terminal row it records a refusal and throws `CancelledBeforeEffect`
    // *with the effect not yet performed* (`src/control_plane/outbox.ts`,
    // around the `beforeEffect` load). `MessageBus.poll` then admits that class
    // alongside `OutboxUsageError` and `StaleWriterRefused` in its
    // post-exception residual test (`src/messagebus/bus.ts`), so the throw ends
    // one message instead of the poll.
    //
    // **This case is the reason neither of those two lines may be deleted, and
    // it is deliberately the only case that covers either.**
    //
    // Delete the widening in `bus.ts` -- drop `CancelledBeforeEffect` from the
    // `residual` disjunction -- and the throw is re-raised out of `poll`
    // entirely. `poll` accumulates envelopes in a local array and returns it
    // only at the end, so every envelope already built is discarded, including
    // task-2's, whose effect has really happened at the destination; the worker
    // sees the whole poll come back as an `isError` tool response
    // (`src/messagebus/endpoint.ts`). Assertion (a) is what goes red: one
    // closed gate would have failed this recipient's other work.
    //
    // Delete the pre-effect guard in `Outbox.attempt` instead, and nothing
    // throws at all: the attempt walks straight into `handler.apply` and the
    // external side effect fires for a message whose gate has already closed.
    // The database then refuses to record it -- `_MARK_DELIVERED` carries
    // `status = 'pending'`, which matches no cancelled row -- so the effect
    // happened and the control plane denies it ever did. Assertion (c) is what
    // goes red, and it is the loudest one here because that outcome is the
    // whole reason the guard exists: a relay whose human gate closed is a
    // question nobody is waiting for, and asking it anyway is worse than losing
    // an envelope.
    //
    // The distinction from "a cancellation inside the attempt itself is skipped,
    // not raised" above is which door the attempt leaves by. That case cancels
    // at `before_durable_write`, so the *fenced statement* misses its row and
    // the outbox surfaces the skip as a predicate that moved nothing; it reaches
    // the residual branch through `StaleWriterRefused` and never exercises the
    // pre-effect guard. This one cancels at `after_record_before_effect`, one
    // checkpoint later, where the fenced write has already committed and the
    // guard is the only thing standing between the closed gate and the
    // destination.
    //
    // Fired on the FIRST `after_record_before_effect` of the armed poll, which
    // is task-1's own: task-1 has incremented its retry count and written its
    // pending action row, and is cancelled at the last instant before its
    // effect. task-2 is attempted afterwards, in the same poll, against a
    // database that has moved underneath it.
    const state = { armed: false, seen: 0, fired: 0 };
    const cancelTask1BeforeItsEffect = (name: string): void => {
      if (state.armed && name === CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT) {
        state.seen += 1;
        if (state.seen === 1) {
          state.fired = env.cancelRelay("task-1");
        }
      }
    };

    const env = makeBusEnv(createTempDir("cancel-before-effect"), "cancel-before-effect", {
      checkpoint: cancelTask1BeforeItsEffect,
    });
    try {
      send(env, { messageId: "task-1" });
      send(env, { messageId: "task-2" });
      state.armed = true;
      const envelopes = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
      expect(state.fired, "the checkpoint must actually have cancelled a row").toBe(1);

      // (a) and (b) together: the batch survived, and it survived without the
      // message the gate closed. Spelled as one equality over the whole result
      // rather than two membership tests, so a poll that returned *both* fails
      // here as loudly as a poll that returned neither.
      expect(
        envelopes.map((e) => e.messageId),
        "the surviving message must come back from the same poll the cancellation landed in",
      ).toEqual(["task-2"]);

      // (c) The assertion the round-2 fix exists for. The destination's own
      // ledger is the only witness that distinguishes "refused before the
      // effect" from "effect performed and then disowned by the database" --
      // the outbox row looks identical in both worlds, which is precisely what
      // made the bug survivable without this line.
      expect(
        env.effectCount("dk-task-1"),
        "the effect must NOT have reached the destination: the guard refuses before handler.apply",
      ).toBe(0);
      // The survivor's effect really did happen, which is what makes the
      // discarded-batch failure above a loss of *delivered* work rather than of
      // an empty array.
      expect(env.effectCount("dk-task-2"), "the survivor was really delivered").toBe(1);

      // (d) The cancelled row is terminal and was never recorded as delivered.
      // `delivered_at_ms` is read straight from the row because it is the field
      // `_MARK_DELIVERED` writes: a NULL here says the delivery record was never
      // written, which is the database half of (c).
      expect(env.outboxStatus("task-1")).toBe("cancelled");
      const cancelledRow = env.connection
        .prepare("SELECT delivered_at_ms FROM outbox WHERE message_id = ?")
        .get("task-1") as { delivered_at_ms: number | null };
      expect(
        cancelledRow.delivered_at_ms,
        "a row refused before its effect must carry no delivery timestamp",
      ).toBeNull();
      expect(env.outboxStatus("task-2")).toBe("delivered");

      // (e) Exactly one refusal row, counted rather than bounded. The guard
      // records its reason durably before throwing -- the same discipline
      // `StaleWriterRefused` follows, kept because the obligation is the same:
      // a refusal nobody catches must still be readable out of the `action`
      // table afterwards. One is the whole audit trail this poll should leave;
      // `>= 1` would pass just as well if the survivor's attempt had also been
      // refused, which is the failure hiding inside a lost batch.
      expect(env.refusedActionCount(), "exactly one attempt was refused, and it is task-1's").toBe(
        1,
      );

      // The survivor settles normally afterwards: the poll was not left in a
      // half-state by the refusal it walked past.
      expect(env.bus.ack("task-2", { nowMs: T0 + 2_000, recipient: RECIPIENT }).recorded).toBe(
        true,
      );
      // And the cancelled row stays gone from the resend engine.
      expect(env.bus.outbox.due(T0 + 10_000).map((m) => m.messageId)).toEqual([]);
    } finally {
      env.close();
    }
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

/**
 * A row a producer appended is adopted at the attempt, and only that row.
 *
 * Every case here is target-only and runs on the production schema, because
 * the producers they exercise -- `enqueueRelay` and the event spine's delivery
 * fan-out -- have no spike-schema existence at all. interlock's own bus never
 * met either one: its outbox rows all arrive through `Outbox.enqueue`, which
 * stamps `writer_epoch` from the sender's own lease, so the source suite could
 * not have carried a case in which a due row has no owner. `D-0054` records the
 * divergence and `parity/messagebus.bus.ledger.json` names these ids.
 *
 * The property under test is one sentence: `writer_epoch` on `outbox` is the
 * current owner of the delivery-side mutations, not a record of who appended
 * the row, so a delivery worker takes ownership of the one row it is about to
 * attempt and of nothing else.
 */
describe("a producer's row is adopted at the attempt (target-only, production schema)", () => {
  /** The gate world `enqueueRelay` needs: a run, its escalation event, a gate. */
  function aRelay(env: BusEnv, options: { readonly at?: number } = {}): string {
    const { at = T0 } = options;
    const cursor = env.connection
      .prepare<[string, string, string, string, number, number]>(
        "INSERT INTO event (event_id, event_type, subject_kind, subject_id, run_id," +
          " producer, dedup_key, occurred_at_ms, ingested_at_ms)" +
          " VALUES (?, 'worker_escalation_raised', 'run', ?, ?, 'worker', ?, ?, ?)",
      )
      .run("evt/gate-1", RUN_ID, RUN_ID, "dk/evt/gate-1", at, at);
    openGate(env.connection, {
      gateId: "gate-1",
      gateType: "worker_escalation",
      subjectKind: "run",
      subjectId: RUN_ID,
      rationale: "the worker cannot decide whether to force-push",
      originEventSeq: Number(cursor.lastInsertRowid),
      createdAtMs: at,
      actorKind: "worker",
      actorId: "worker-7",
      options: ["force-push", "abandon"],
      runId: RUN_ID,
    });
    return enqueueRelay(env.connection, {
      gateId: "gate-1",
      toStage: "presented",
      recipient: RECIPIENT,
      payload: '{"question":"force-push?"}',
      messageId: "relay-1",
      enqueuedAtMs: at,
    });
  }

  /** One row's `writer_epoch`, which is the whole subject of this block. */
  function writerEpoch(env: BusEnv, messageId: string): number | null {
    const row = env.connection
      .prepare("SELECT writer_epoch FROM outbox WHERE message_id = ?")
      .get(messageId) as { writer_epoch: number | null } | undefined;
    if (row === undefined) {
      throw new Error(`no outbox row ${messageId}`);
    }
    return row.writer_epoch;
  }

  test("a gate's relay is delivered by an ordinary poll, with no hand-run recovery", () => {
    // The acceptance case for Issue #102, driven end to end on the schema the
    // lap runs on: a live delivery lease at epoch 1, a relay appended by the
    // gate under no lease at all, and one `poll` with nothing else in front of
    // it. Before the adoption line in `MessageBus.poll` this failed at
    // `_COUNT_ATTEMPT`, whose `writer_epoch = :fence_epoch` conjunct matches no
    // row when the row's epoch is null -- StaleWriterRefused, on a poll whose
    // lease was perfectly live, forever. `Outbox.recover` would have fixed it,
    // and nothing calls `Outbox.recover`.
    const env = busEnv();
    const messageId = aRelay(env);

    // The precondition, asserted rather than assumed: the producer really did
    // append an unowned row. Without this line the case would still pass on a
    // day `enqueueRelay` started stamping an epoch, and would then be pinning
    // nothing at all.
    expect(writerEpoch(env, messageId), "a gate holds no delivery lease to stamp").toBeNull();

    const envelopes = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });

    expect(envelopes.map((e) => e.messageId)).toEqual([messageId]);
    expect(envelopes[0]?.payload).toBe('{"question":"force-push?"}');
    expect(envelopes[0]?.retryCount).toBe(1);
    // The destination's own ledger, not the outbox's opinion of itself: the
    // effect is what the human on the other end of the gate actually receives.
    expect(env.effectCount(`gate/gate-1/presented`)).toBe(1);
    expect(env.outboxStatus(messageId)).toBe("delivered");
    expect(writerEpoch(env, messageId), "the delivery worker now owns the row").toBe(EPOCH);
    // Nothing was refused. A green delivery that also recorded a refusal would
    // mean the adoption raced its own attempt.
    expect(env.refusedActionCount()).toBe(0);
  });

  test("an event fanned out to a delivery consumer is delivered the same way", () => {
    // The second producer, and the reason the fix belongs in `poll` rather than
    // in `enqueueRelay`: the event spine's fan-out inserts its outbox rows
    // directly too, for the same reason (a CI watcher appending `pr_merged`
    // holds no delivery lease), so a fix that taught one producer to stamp an
    // epoch would have left this path exactly as broken.
    const env = busEnv();
    registerConsumer(env.connection, {
      consumerId: "notify-consumer",
      kind: "delivery",
      leaseResource: "notify-consumer-lease",
      registeredAtMs: T0,
      registeredFromSeq: 0,
    });
    subscribe(env.connection, {
      consumerId: "notify-consumer",
      eventType: "gate_closed",
      recipient: RECIPIENT,
      addedAtMs: T0,
    });
    appendEvent(env.connection, {
      eventId: "evt-closed",
      eventType: "gate_closed",
      subjectKind: "run",
      subjectId: RUN_ID,
      dedupKey: "dk/evt-closed",
      producer: "dispatcher-core",
      occurredAtMs: T0,
      ingestedAtMs: T0,
      runId: RUN_ID,
      payload: '{"outcome":"answered"}',
    });
    const messageId = "event/evt-closed/notify-consumer";
    expect(writerEpoch(env, messageId), "the fan-out holds no delivery lease either").toBeNull();

    const envelopes = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });

    expect(envelopes.map((e) => e.messageId)).toEqual([messageId]);
    expect(env.outboxStatus(messageId)).toBe("delivered");
    expect(writerEpoch(env, messageId)).toBe(EPOCH);
    expect(env.refusedActionCount()).toBe(0);
  });

  test("an unowned row and an owned one both go out in one poll", () => {
    // The blast radius, pinned. The adoption is one statement inside a loop
    // that walks a batch, so the two failures worth ruling out are that it
    // helps the row it adopts and breaks the batch around it, and that it
    // re-stamps a healthy row it has no business touching.
    //
    // The relay is oldest, so `_DUE_QUERY`'s `ORDER BY enqueued_at_ms` puts the
    // unowned row FIRST -- the position from which a throw would discard every
    // envelope built after it (the array in `poll` is local and never
    // returned). The assertion is one equality over the whole batch, so a poll
    // that delivered only the healthy row fails as loudly as one that delivered
    // neither.
    const env = busEnv();
    const relayId = aRelay(env);
    send(env, { messageId: "task-1" });

    const envelopes = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });

    expect(envelopes.map((e) => e.messageId)).toEqual([relayId, "task-1"]);
    expect(writerEpoch(env, relayId)).toBe(EPOCH);
    expect(writerEpoch(env, "task-1"), "a healthy row keeps the epoch it had").toBe(EPOCH);
    expect(env.refusedActionCount(), "no refusal survives a fully delivered batch").toBe(0);
  });

  test("a row addressed to another recipient is left unowned", () => {
    // The authority boundary, and the reason `poll` does not simply call
    // `Outbox.recover`. Recovery adopts every unowned row in the table; a poll
    // speaks for one recipient. The second row here is due, unowned and
    // untouched, and it must stay that way -- an endpoint that owned it could
    // not deliver it (no handler serves that recipient here) and would have
    // taken it out from under the endpoint that can.
    const env = busEnv();
    const relayId = aRelay(env);
    env.connection
      .prepare<[string, string, string, string, string, number]>(
        "INSERT INTO outbox (message_id, run_id, recipient, payload, dedup_key," +
          " status, retry_count, enqueued_at_ms)" +
          " VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)",
      )
      .run("relay-other", RUN_ID, "someone-else", "{}", "dk/relay-other", T0);

    env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });

    expect(writerEpoch(env, relayId)).toBe(EPOCH);
    expect(writerEpoch(env, "relay-other"), "a poll owns one recipient's rows").toBeNull();
    expect(env.outboxStatus("relay-other")).toBe("pending");
  });

  test("a poll under a dead epoch adopts nothing and delivers nothing", () => {
    // Anti-vacuity for the fence. Adoption goes through `_ADOPT`, whose lease
    // predicate is a clause of the UPDATE rather than a check in front of it,
    // so a poll whose epoch is not a live lease must change no row -- and the
    // refusal must still be the loud one `attempt` records, not a silent skip
    // dressed up as a successful adoption.
    const env = busEnv();
    const relayId = aRelay(env);

    expectRefusal(
      () => env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH + 1 }),
      StaleWriterRefused,
    );

    expect(writerEpoch(env, relayId), "a dead epoch takes ownership of nothing").toBeNull();
    expect(env.outboxStatus(relayId)).toBe("pending");
    expect(env.effectCount("gate/gate-1/presented"), "and causes no effect").toBe(0);
    expect(env.refusedActionCount(), "the refusal is durably recorded").toBe(1);
  });
});
