import { describe, expect, test } from "vitest";

import { HUMAN_GATED_RECIPIENT } from "../../src/control_plane/handlers.js";
import { HandlerRejected } from "../../src/control_plane/outbox.js";
import { MessageBusUsageError } from "../../src/messagebus/index.js";
import { expectRefusal } from "../testkit/errors.js";
import { xfail } from "../testkit/marks.js";
import { type BusEnv, busEnv, EPOCH, RECIPIENT, RUN_ID, T0 } from "./_env.js";

/**
 * Carried v1 delivery invariants, landed against the new contract
 * (interlock Q-0023 -> interlock D-0028).
 *
 * Ported from interlock `tests/messagebus/test_carried_specifications.py` at
 * `65f36c5`. Every case here maps to one source node id; the mapping is
 * `parity/messagebus.carried-specifications.ledger.json`.
 *
 * interlock's quarantined `tests/broker/` suites pin invariants its porting
 * ledger classified `carry (invariant) / rewrite (mechanism)`, but the module
 * they drive -- `broker/server.py` -- is deleted, so none of them runs. Per that
 * repository's 2026-08-21 direction on `Q-0023`, a carried end-to-end assertion
 * is landed as a **specification against the new MessageBus contract**, not kept
 * driving the old module: this file is where those specifications live. Each
 * test names the quarantined assertion it carries.
 *
 * A carried specification the new contract does not satisfy yet is landed
 * **failing**, as a strict `xfail`: the suite stays green, the contract gap
 * stays visible, and the day an implementation satisfies it the unexpected pass
 * turns the mark into a loud reminder to remove it.
 */

function send(
  env: BusEnv,
  options: { messageId?: string; recipient?: string } = {},
): ReturnType<BusEnv["bus"]["send"]> {
  const { messageId = "task-1", recipient = RECIPIENT } = options;
  return env.bus.send({
    messageId,
    recipient,
    payload: '{"task":"t"}',
    dedupKey: `dk-${messageId}`,
    nowMs: T0,
    epoch: EPOCH,
    runId: RUN_ID,
  });
}

describe("carried v1 delivery invariants, against the new contract", () => {
  test("a message is sent only to a registered recipient", () => {
    // Carries tests/broker/test_store.py::test_enqueue_only_to_registered.
    //
    // The roster is the handler registry now, not the pane bind table, and the
    // refusal happens before the durable write so no undeliverable row exists.
    const env = busEnv();
    expectRefusal(() => send(env, { recipient: "never-registered" }), HandlerRejected);
    expect(env.outboxStatus("task-1")).toBeNull();
  });

  test("a settled message is never presented again", () => {
    // Carries tests/broker/test_store.py::test_drain_is_at_most_once and
    // tests/broker/test_delivery.py::test_check_messages_drains_unclaimed.
    //
    // v1's drain removed the row from the queue on read; the new contract keeps
    // the row and settles it with the ack instead -- at-most-once *presentation
    // after settlement* is the transport-neutral invariant underneath both.
    const env = busEnv();
    send(env);
    env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
    env.bus.ack("task-1", { nowMs: T0 + 2_000, recipient: RECIPIENT });
    for (const later of [3_000, 4_000]) {
      expect(env.bus.poll(RECIPIENT, { nowMs: T0 + later, epoch: EPOCH })).toEqual([]);
    }
  });

  test("pull then ack walks the claim-then-confirm states", () => {
    // Carries tests/broker/test_delivery.py::test_claim_then_confirm_lifecycle.
    //
    // The v1 state machine was pending -> CLAIMED -> confirmed, driven by a
    // sidecar; the successor is pending -> delivered -> acked, driven by the
    // recipient's own poll. Same shape, one honest difference: the middle state
    // no longer expires back -- a delivered-but-unacked row simply stays due,
    // which is the resend.
    const env = busEnv();
    send(env);
    expect(env.outboxStatus("task-1")).toBe("pending");
    env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
    expect(env.outboxStatus("task-1")).toBe("delivered");
    const outcome = env.bus.ack("task-1", { nowMs: T0 + 2_000, recipient: RECIPIENT });
    expect(outcome.recorded).toBe(true);
    expect(env.outboxStatus("task-1")).toBe("acked");
    // And the double confirm stays idempotent, as v1's lifecycle test pinned.
    expect(env.bus.ack("task-1", { nowMs: T0 + 3_000, recipient: RECIPIENT }).recorded).toBe(false);
  });

  test("a poll returns only the polling recipient's rows", () => {
    // Carries tests/broker/test_delivery.py::test_poll_claims_only_returns_owner_rows.
    const env = busEnv();
    send(env, { messageId: "task-mine" });
    send(env, { messageId: "task-gated", recipient: HUMAN_GATED_RECIPIENT });
    const envelopes = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
    expect(envelopes.map((e) => e.messageId)).toEqual(["task-mine"]);
    expect(env.outboxStatus("task-gated")).toBe("pending");
  });

  test("an ack from the wrong recipient is refused", () => {
    // Carries tests/broker/test_delivery.py::test_confirm_not_owner_rejected.
    //
    // Without the credential machinery, the boundary is the stated recipient: an
    // ack across it is a caller bug, refused before the settlement write.
    const env = busEnv();
    send(env);
    env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
    expectRefusal(
      () => env.bus.ack("task-1", { nowMs: T0 + 2_000, recipient: HUMAN_GATED_RECIPIENT }),
      MessageBusUsageError,
      /does not settle it/,
    );
    expect(env.outboxStatus("task-1")).toBe("delivered");
  });

  test("a non-ASCII payload survives delivery byte for byte", () => {
    // Carries tests/broker/test_notify.py::test_send_delivers_unicode_body.
    //
    // Payload fidelity is transport-neutral: whatever framing the endpoint uses
    // (its JSON is emitted ASCII-safe), the payload a poll presents is the one
    // the sender enqueued, escapes and all.
    const env = busEnv();
    // The source writes these characters literally; this file may not
    // (`docs/cli-output-policy.md`, pinned by
    // `test/contract/ascii-output-policy.test.ts`). Escapes rather than
    // literals: the runtime string is the source's, character for character --
    // five kana, an em dash, an e-acute and an astral emoji -- and the file
    // itself stays ASCII.
    const payload = '{"task":"\u3053\u3093\u306b\u3061\u306f \u2014 caf\u00e9 \u{1f680}"}';
    env.bus.send({
      messageId: "task-u",
      recipient: RECIPIENT,
      payload,
      dedupKey: "dk-task-u",
      nowMs: T0,
      epoch: EPOCH,
      runId: RUN_ID,
    });
    const envelopes = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
    expect(envelopes.map((e) => e.payload)).toEqual([payload]);
  });

  xfail({
    strict: true,
    reason:
      "failing specification (interlock Q-0023 -> interlock D-0028): recipient aliasing is not " +
      "part of the MessageBus contract yet; carried from " +
      "tests/broker/test_store.py::test_enqueue_matches_by_name",
  })("a send to a registered alias reaches the canonical recipient", () => {
    // v1 resolved a human-readable name to the bound agent id at enqueue.
    //
    // The carried invariant is that a sender may address a recipient by a
    // registered alias and the message reaches the canonical queue. The new
    // contract has exactly one name per recipient (the registry key), so this
    // specification fails until an aliasing surface exists -- landed failing
    // rather than driving the deleted `broker/server.py` to reach it.
    const env = busEnv();
    send(env, { messageId: "task-aliased", recipient: "notify" });
    const envelopes = env.bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
    expect(envelopes.map((e) => e.messageId)).toEqual(["task-aliased"]);
  });
});
