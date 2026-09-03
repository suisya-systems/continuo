import { join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { KeyedDropbox } from "../../src/control_plane/destination.js";
import {
  AnswerBodyRequired,
  advanceOnAck,
  GateClosedRefused,
  InadmissibleTransitionRefused,
  openGate,
  UnknownGateRefused,
} from "../../src/control_plane/gates.js";
import { acquire, LeaseHeld } from "../../src/control_plane/lease.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { HandlerRejected } from "../../src/control_plane/outbox.js";
import {
  ackRelay,
  answerGate,
  closeOpenGate,
  deliverRelays,
  GATE_RELAY_RECIPIENT,
  gateDetail,
  openGates,
  presentGate,
  reconcile,
  relayMessageId,
} from "../../src/gate/operator.js";
import { DELIVERY_LEASE_RESOURCE } from "../../src/messagebus/endpoint.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

/**
 * Step 10's operator path: an open gate becomes an answered, forwarded and
 * closed one, driven only by the entry points the `gate` verbs call.
 *
 * New code, not a port -- `src/gate/` has no interlock counterpart, so there is
 * no parity ledger and no node ids to map. What the cases below stand on is the
 * design instead: section 4.10 of `docs/design/minimal-operating-loop.md`
 * assigns the operator the roles of publisher and acker, section 9.3's
 * transition table decides which of those moves is admissible, and section 9.5
 * says the stage moves on the ack rather than on the send.
 *
 * Three of these cases are the ones this module would be worthless without:
 *
 * * `the operator walk closes the gate as answered_and_forwarded` is the
 *   acceptance criterion of Issue #108, driven end to end through the entry
 *   points with no SQL of its own.
 * * `a kill between the ack and the advance is finished by reconcile` is why
 *   the reconcile pass exists at all (`D-0079`): every step of the ack verb is
 *   its own transaction, and the detector `gatesNeedingAdvance` is the recovery
 *   for the window between two of them.
 * * `a relay is delivered into the dropbox the operator reads` is `D-0076`
 *   made falsifiable: the effect lands in a directory, and a change of
 *   recipient that quietly stopped delivering would leave that directory empty
 *   while every row still read `pending`.
 *
 * Every timestamp is {@link T0} plus arithmetic and no case reads a clock, for
 * the reason `test/control_plane/gates.test.ts` gives: a suite whose
 * expectations move with the wall clock cannot assert a tolerance boundary.
 */

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const TTL_MS = 300_000;
const ACTOR = "operator-1";
const GATE_ID = "gate-1";
const RUN_ID = "run-1";

const productionTemplate = suiteTemplate("production.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/** A production control plane at head, one copy per case. */
function cpFixture(label: string): SqliteDatabase {
  const connection = openProductionControlPlane(productionTemplate.copyInto(caseRoot(label)));
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

function addRun(cp: SqliteDatabase, runId = RUN_ID, status = "running", at: number = T0): void {
  cp.prepare<[string, string, number, number]>(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
  ).run(runId, status, at, at);
}

/**
 * The escalation event a gate stands over, inserted directly.
 *
 * The precondition section 9.3 states is that the *row* is there; going through
 * the spine's append would make these cases depend on which consumers happen to
 * be registered, which is `test/control_plane/gates.test.ts`'s reason for the
 * same shortcut.
 */
function addOriginEvent(cp: SqliteDatabase, runId = RUN_ID, at: number = T0): number {
  const cursor = cp
    .prepare<[string, string, string, string, number, number]>(
      `
        INSERT INTO event (event_id, event_type, subject_kind, subject_id, run_id,
                           producer, dedup_key, occurred_at_ms, ingested_at_ms)
        VALUES (?, 'worker_escalation_raised', 'run', ?, ?, 'worker', ?, ?, ?)
        `,
    )
    .run(`evt/${runId}`, runId, runId, `dk/${runId}`, at, at);
  return Number(cursor.lastInsertRowid);
}

/** A run, its escalation event, and the gate step 9's ingress would have opened. */
function aGate(
  cp: SqliteDatabase,
  options: { readonly deadlineAtMs?: number | null; readonly runStatus?: string } = {},
): string {
  const { deadlineAtMs = null, runStatus = "running" } = options;
  addRun(cp, RUN_ID, runStatus);
  const seq = addOriginEvent(cp);
  openGate(cp, {
    gateId: GATE_ID,
    gateType: "worker_escalation",
    subjectKind: "run",
    subjectId: RUN_ID,
    rationale: "the worker cannot decide whether to force-push",
    originEventSeq: seq,
    createdAtMs: T0,
    actorKind: "worker",
    actorId: "worker-7",
    options: ["force-push", "abandon"],
    deadlineAtMs,
    runId: RUN_ID,
  });
  return GATE_ID;
}

/** The dropbox directory `gate deliver` writes into, per case. */
function destinationDir(label: string): string {
  return join(caseRoot(label), "destination");
}

/**
 * The destination's own count for one relay's effect.
 *
 * Read out of a {@link KeyedDropbox} over the same directory the delivery
 * wrote into, under the key the handler applies it as -- the destination's
 * ledger rather than a file count of ours, for the reason `ACCEPTANCE.md`
 * section 2 gives: an exactly-once claim read out of our own rows proves
 * nothing about the effect.
 */
function effectCount(dir: string, dedupKey: string): number {
  return new KeyedDropbox(dir, "case").effectCount(`${GATE_RELAY_RECIPIENT}:notify:${dedupKey}`);
}

function deliver(cp: SqliteDatabase, dir: string, nowMs: number) {
  return deliverRelays(cp, {
    holder: ACTOR,
    destinationDir: dir,
    nowMs,
    ttlMs: TTL_MS,
  });
}

function stageOf(cp: SqliteDatabase, gateId = GATE_ID): string {
  return gateDetail(cp, gateId).stage;
}

function outcomeOf(cp: SqliteDatabase, gateId = GATE_ID): string | null {
  return gateDetail(cp, gateId).outcome;
}

function statusOf(cp: SqliteDatabase, messageId: string): string {
  const status = cp
    .prepare<[string], string>("SELECT status FROM outbox WHERE message_id = ?")
    .pluck()
    .get(messageId);
  if (status === undefined) {
    throw new Error(`no outbox row ${messageId}`);
  }
  return status;
}

describe("the operator's gate walk", () => {
  test("the operator walk closes the gate as answered_and_forwarded", () => {
    // Issue #108's acceptance criterion, driven through the entry points the
    // verbs call and nothing else: no SQL here writes a stage, an ack or an
    // outcome, so a step that stopped working could not be papered over by the
    // fixture.
    const cp = cpFixture("gate-walk");
    const dir = destinationDir("gate-walk");
    aGate(cp);
    expect(openGates(cp).map((gate) => [gate.gateId, gate.stage])).toEqual([[GATE_ID, "received"]]);

    const presented = presentGate(cp, { gateId: GATE_ID, nowMs: T0 + MINUTE });
    expect(presented).toEqual({
      messageId: relayMessageId(GATE_ID, "presented"),
      toStage: "presented",
      enqueued: true,
    });
    // The stage does not move on the send. That is section 9.5's whole point:
    // a question nobody received and a question nobody answered must stay
    // distinguishable.
    expect(stageOf(cp)).toBe("received");

    expect(deliver(cp, dir, T0 + 2 * MINUTE).delivered.map((m) => m.messageId)).toEqual([
      presented.messageId,
    ]);
    expect(statusOf(cp, presented.messageId)).toBe("delivered");
    expect(stageOf(cp)).toBe("received");

    const ackedPresented = ackRelay(cp, {
      messageId: presented.messageId,
      actorId: ACTOR,
      nowMs: T0 + 3 * MINUTE,
    });
    expect(ackedPresented.acked).toBe(true);
    expect(ackedPresented.advanced).toBe(true);
    expect(ackedPresented.closed).toBe(false);
    expect(stageOf(cp)).toBe("presented");

    const answered = answerGate(cp, {
      gateId: GATE_ID,
      body: "force-push, and record why",
      actorId: ACTOR,
      nowMs: T0 + 4 * MINUTE,
    });
    expect(answered.advanced).toBe(true);
    expect(answered.messageId).toBe(relayMessageId(GATE_ID, "forwarded"));
    expect(stageOf(cp)).toBe("answered");

    deliver(cp, dir, T0 + 5 * MINUTE);
    const ackedForwarded = ackRelay(cp, {
      messageId: answered.messageId,
      actorId: ACTOR,
      nowMs: T0 + 6 * MINUTE,
    });
    expect(ackedForwarded.advanced).toBe(true);
    // The close is the ack's consequence and nobody types a verb for it
    // (section 9.3: out of `forwarded`, the close is actor `system` alone).
    expect(ackedForwarded.closed).toBe(true);
    expect(outcomeOf(cp)).toBe("answered_and_forwarded");
    expect(openGates(cp)).toEqual([]);

    // The answer survives on the transition, which is the only place it is
    // durable: `answered` is not a relayed stage.
    const detail = gateDetail(cp, GATE_ID);
    const answerRow = detail.transitions.find((t) => t.toStage === "answered");
    expect(answerRow?.body).toBe("force-push, and record why");
    expect(answerRow?.actorKind).toBe("human");
    expect(detail.relays.map((relay) => [relay.toStage, relay.status])).toEqual([
      ["presented", "acked"],
      ["forwarded", "acked"],
    ]);
  });

  test("a relay is delivered into the dropbox the operator reads", () => {
    // D-0076 made falsifiable. The recipient is the one the endpoint's registry
    // serves, and the effect of serving it is a file: a change that stopped
    // delivering would leave this directory empty while the row still read
    // `pending`, which no assertion about our own tables would catch.
    const cp = cpFixture("gate-dropbox");
    const dir = destinationDir("gate-dropbox");
    aGate(cp);
    const relay = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });

    const report = deliver(cp, dir, T0 + MINUTE);
    expect(report.recipient).toBe(GATE_RELAY_RECIPIENT);
    const dedupKey = `gate/${GATE_ID}/presented`;
    expect(effectCount(dir, dedupKey)).toBe(1);

    // A second pass re-presents the unacked message and the destination
    // deduplicates it: one effect, whatever the delivery count.
    deliver(cp, dir, T0 + 2 * MINUTE);
    expect(effectCount(dir, dedupKey)).toBe(1);
    expect(statusOf(cp, relay.messageId)).toBe("delivered");
  });

  test("a second present returns the message id already in force", () => {
    const cp = cpFixture("gate-idempotent");
    aGate(cp);
    const first = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    const second = presentGate(cp, { gateId: GATE_ID, nowMs: T0 + MINUTE });
    expect(second.messageId).toBe(first.messageId);
    expect(second.enqueued).toBe(false);
    expect(cp.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).toEqual({ n: 1 });
  });

  test("a kill between the ack and the advance is finished by reconcile", () => {
    // The window every step of `ackRelay` being its own transaction leaves
    // open, reproduced by acking the row without taking the step: this is
    // exactly the state `gatesNeedingAdvance` is the detector for, and the
    // reconcile pass is its only caller under src/.
    const cp = cpFixture("gate-recovery");
    const dir = destinationDir("gate-recovery");
    aGate(cp);
    const relay = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    deliver(cp, dir, T0 + MINUTE);
    cp.prepare<[number, string]>(
      "UPDATE outbox SET status = 'acked', acked_at_ms = ? WHERE message_id = ?",
    ).run(T0 + 2 * MINUTE, relay.messageId);
    expect(stageOf(cp)).toBe("received");

    const report = reconcile(cp, { nowMs: T0 + 3 * MINUTE, actorId: ACTOR });
    expect(report.advanced.map((row) => [row.gateId, row.toStage])).toEqual([
      [GATE_ID, "presented"],
    ]);
    expect(stageOf(cp)).toBe("presented");

    // And it is idempotent: a second pass finds nothing left to finish.
    expect(reconcile(cp, { nowMs: T0 + 4 * MINUTE, actorId: ACTOR }).advanced).toEqual([]);
  });

  test("a forwarded advance recovered by reconcile also closes the gate", () => {
    // The recovery must not leave a gate in a state the ordinary path would
    // never leave it in: out of `forwarded` the close is the ack's consequence,
    // so the pass that completes the advance completes the close too.
    const cp = cpFixture("gate-recovery-close");
    const dir = destinationDir("gate-recovery-close");
    aGate(cp);
    const presented = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    deliver(cp, dir, T0 + MINUTE);
    ackRelay(cp, { messageId: presented.messageId, actorId: ACTOR, nowMs: T0 + 2 * MINUTE });
    const answered = answerGate(cp, {
      gateId: GATE_ID,
      body: "abandon",
      actorId: ACTOR,
      nowMs: T0 + 3 * MINUTE,
    });
    deliver(cp, dir, T0 + 4 * MINUTE);
    cp.prepare<[number, string]>(
      "UPDATE outbox SET status = 'acked', acked_at_ms = ? WHERE message_id = ?",
    ).run(T0 + 5 * MINUTE, answered.messageId);

    const report = reconcile(cp, { nowMs: T0 + 6 * MINUTE, actorId: ACTOR });
    expect(report.closed).toEqual([GATE_ID]);
    expect(outcomeOf(cp)).toBe("answered_and_forwarded");
  });

  test("a kill between the advance and the close is finished by reconcile", () => {
    // The second window `ackRelay` leaves open, and the one a close driven off
    // this pass's own advances would miss for ever: once the advance
    // transition exists, `gatesNeedingAdvance` stops reporting the row, so a
    // gate left forwarded-acked-and-open is reachable by nothing but a query
    // over the state itself.
    const cp = cpFixture("gate-recovery-late-close");
    const dir = destinationDir("gate-recovery-late-close");
    aGate(cp);
    const presented = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    deliver(cp, dir, T0 + MINUTE);
    ackRelay(cp, { messageId: presented.messageId, actorId: ACTOR, nowMs: T0 + 2 * MINUTE });
    const answered = answerGate(cp, {
      gateId: GATE_ID,
      body: "abandon",
      actorId: ACTOR,
      nowMs: T0 + 3 * MINUTE,
    });
    deliver(cp, dir, T0 + 4 * MINUTE);
    // The ack and the advance landed; the close did not.
    cp.prepare<[number, string]>(
      "UPDATE outbox SET status = 'acked', acked_at_ms = ? WHERE message_id = ?",
    ).run(T0 + 5 * MINUTE, answered.messageId);
    advanceOnAck(cp, {
      gateId: GATE_ID,
      toStage: "forwarded",
      actorKind: "secretary",
      actorId: ACTOR,
      occurredAtMs: T0 + 5 * MINUTE,
      recordedAtMs: T0 + 5 * MINUTE,
    });
    expect(stageOf(cp)).toBe("forwarded");
    expect(outcomeOf(cp)).toBeNull();
    // The detector is silent about it, which is exactly why the close cannot be
    // driven off this pass's own advances.
    expect(reconcile(cp, { nowMs: T0 + 6 * MINUTE, actorId: ACTOR }).advanced).toEqual([]);
    expect(outcomeOf(cp)).toBe("answered_and_forwarded");
  });

  test("an answered gate whose run then ended still closes as answered_and_forwarded", () => {
    // The order inside the pass, made falsifiable. `subject_gone` is reachable
    // from every stage, so a sweep that ran before the completions would close
    // this gate -- answered, forwarded and acked -- as though nobody had
    // answered it, and permanently: a closed gate keeps its outcome.
    const cp = cpFixture("gate-sweep-vs-completion");
    const dir = destinationDir("gate-sweep-vs-completion");
    aGate(cp);
    const presented = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    deliver(cp, dir, T0 + MINUTE);
    ackRelay(cp, { messageId: presented.messageId, actorId: ACTOR, nowMs: T0 + 2 * MINUTE });
    const answered = answerGate(cp, {
      gateId: GATE_ID,
      body: "force-push",
      actorId: ACTOR,
      nowMs: T0 + 3 * MINUTE,
    });
    deliver(cp, dir, T0 + 4 * MINUTE);
    // The ack landed; the advance and the close did not -- the window inside
    // `ackRelay` that this pass is the recovery for.
    cp.prepare<[number, string]>(
      "UPDATE outbox SET status = 'acked', acked_at_ms = ? WHERE message_id = ?",
    ).run(T0 + 5 * MINUTE, answered.messageId);
    // And meanwhile the run ended, which is the ordinary next thing to happen.
    cp.prepare<[string]>("UPDATE run SET status = 'completed' WHERE run_id = ?").run(RUN_ID);

    const report = reconcile(cp, { nowMs: T0 + 6 * MINUTE, actorId: ACTOR });

    expect(report.closed).toEqual([GATE_ID]);
    expect(report.subjectGone).toEqual([]);
    expect(outcomeOf(cp)).toBe("answered_and_forwarded");
  });

  test("reconcile closes a gate whose run is gone and reports without closing the rest", () => {
    // The two halves of D-0079 in one case: `subject_gone` is settled because a
    // terminal run is a fact, and a passed deadline is only reported because no
    // expiry policy is decided (D-0008).
    const cp = cpFixture("gate-sweep");
    aGate(cp, { deadlineAtMs: T0 + MINUTE });
    const overdue = reconcile(cp, { nowMs: T0 + 2 * MINUTE, actorId: ACTOR });
    expect(overdue.pastDeadline.map((row) => row.gateId)).toEqual([GATE_ID]);
    expect(overdue.subjectGone).toEqual([]);
    expect(outcomeOf(cp)).toBeNull();

    cp.prepare<[string]>("UPDATE run SET status = 'failed' WHERE run_id = ?").run(RUN_ID);
    const swept = reconcile(cp, { nowMs: T0 + 3 * MINUTE, actorId: ACTOR });
    expect(swept.subjectGone).toEqual([GATE_ID]);
    expect(outcomeOf(cp)).toBe("subject_gone");
  });

  test("the stalled query does not run unless a tolerance was given", () => {
    // `null` rather than an empty list, because "nobody asked" and "nothing is
    // stalled" are different facts: a caller printing them the same way would
    // report a clean delivery queue it never looked at.
    const cp = cpFixture("gate-stalled");
    aGate(cp);
    presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    expect(reconcile(cp, { nowMs: T0 + MINUTE, actorId: ACTOR }).stalledRelays).toBeNull();
    expect(
      reconcile(cp, { nowMs: T0 + MINUTE, actorId: ACTOR, stalledToleranceMs: 30_000 })
        .stalledRelays,
    ).toEqual([{ gateId: GATE_ID, toStage: "presented", retryCount: 0, ageMs: MINUTE }]);
  });
});

describe("what the operator's verbs refuse", () => {
  test("an answer before the question was presented is inadmissible", () => {
    const cp = cpFixture("gate-early-answer");
    aGate(cp);
    expectRefusal(
      () => answerGate(cp, { gateId: GATE_ID, body: "yes", actorId: ACTOR, nowMs: T0 }),
      InadmissibleTransitionRefused,
    );
  });

  test("an empty answer is refused rather than recorded", () => {
    const cp = cpFixture("gate-empty-answer");
    const dir = destinationDir("gate-empty-answer");
    aGate(cp);
    const relay = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    deliver(cp, dir, T0 + MINUTE);
    ackRelay(cp, { messageId: relay.messageId, actorId: ACTOR, nowMs: T0 + 2 * MINUTE });
    expectRefusal(
      () => answerGate(cp, { gateId: GATE_ID, body: "", actorId: ACTOR, nowMs: T0 + 3 * MINUTE }),
      AnswerBodyRequired,
    );
    expect(stageOf(cp)).toBe("presented");
  });

  test("an ack for a message that is not a gate relay is refused", () => {
    const cp = cpFixture("gate-foreign-ack");
    aGate(cp);
    expectRefusal(
      () => ackRelay(cp, { messageId: "not-a-relay", actorId: ACTOR, nowMs: T0 }),
      UnknownGateRefused,
    );
  });

  test("the ack of a relay a closure cancelled advances nothing", () => {
    // A gate withdrawn while the question was in front of somebody: the row is
    // `cancelled`, the late ack changes nothing rather than failing, and no
    // stage moves behind a closed gate.
    const cp = cpFixture("gate-cancelled-ack");
    const dir = destinationDir("gate-cancelled-ack");
    aGate(cp);
    const relay = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    deliver(cp, dir, T0 + MINUTE);
    closeOpenGate(cp, {
      gateId: GATE_ID,
      outcome: "withdrawn",
      actorId: ACTOR,
      nowMs: T0 + 2 * MINUTE,
    });
    expect(statusOf(cp, relay.messageId)).toBe("cancelled");

    const outcome = ackRelay(cp, {
      messageId: relay.messageId,
      actorId: ACTOR,
      nowMs: T0 + 3 * MINUTE,
    });
    expect(outcome).toMatchObject({
      acked: false,
      cancelled: true,
      advanced: false,
      closed: false,
    });
    expect(outcomeOf(cp)).toBe("withdrawn");
  });

  test("a closed gate is not presented to anybody", () => {
    const cp = cpFixture("gate-closed-present");
    aGate(cp);
    closeOpenGate(cp, {
      gateId: GATE_ID,
      outcome: "withdrawn",
      actorId: ACTOR,
      nowMs: T0 + MINUTE,
    });
    expectRefusal(
      () => presentGate(cp, { gateId: GATE_ID, nowMs: T0 + 2 * MINUTE }),
      GateClosedRefused,
    );
  });

  test("the outcomes that are not a hand's to write are refused", () => {
    // The three the CLI's `choices` also refuses, checked here as well because
    // the domain entry point is what makes the rule true rather than the
    // parser: a second caller reaching this function must get the same answer.
    const cp = cpFixture("gate-outcomes");
    aGate(cp);
    for (const outcome of ["answered_and_forwarded", "subject_gone", "superseded"]) {
      expect(() =>
        closeOpenGate(cp, { gateId: GATE_ID, outcome, actorId: ACTOR, nowMs: T0 }),
      ).toThrow(TypeError);
    }
    expect(outcomeOf(cp)).toBeNull();
  });

  test("delivery is refused while somebody else holds the one delivery lease", () => {
    // The serialisation D-0053 rule 4 asks for, from the operator's side: a
    // running lap or a live endpoint holds `outbox-delivery`, and this verb
    // must refuse rather than become a second writer of the same rows.
    const cp = cpFixture("gate-lease");
    const dir = destinationDir("gate-lease");
    aGate(cp);
    presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    acquire(cp, {
      resource: DELIVERY_LEASE_RESOURCE,
      holder: "a-running-lap",
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    expectRefusal(() => deliver(cp, dir, T0 + MINUTE), LeaseHeld);
  });

  test("a recipient no handler serves is refused before the lease is taken", () => {
    // The endpoint refuses this at startup; the verb refuses it here, and
    // before claiming the one delivery resource -- a misconfiguration must not
    // cost the operator a TTL of the lease everything else needs.
    const cp = cpFixture("gate-unserved");
    const dir = destinationDir("gate-unserved");
    aGate(cp);
    expect(() =>
      deliverRelays(cp, {
        holder: ACTOR,
        destinationDir: dir,
        recipient: "nobody-serves-this",
        nowMs: T0,
        ttlMs: TTL_MS,
      }),
    ).toThrow(HandlerRejected);
    expect(
      cp
        .prepare<[string], number>("SELECT COUNT(*) FROM lease WHERE resource = ?")
        .pluck()
        .get(DELIVERY_LEASE_RESOURCE),
    ).toBe(0);
  });

  test("an unknown gate is refused by the reader as well as by the writers", () => {
    const cp = cpFixture("gate-unknown");
    expectRefusal(() => gateDetail(cp, "gate-nope"), UnknownGateRefused);
  });
});
