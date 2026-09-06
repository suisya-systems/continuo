import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  DELIVERY_LEASE_RESOURCE,
  deliveryResourceForRun,
} from "../../src/control_plane/delivery_resource.js";
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
  MIGRATIONS_DIR,
  migrateControlPlane,
  openProductionControlPlane,
  STEP_FILENAME,
} from "../../src/control_plane/migrator.js";
import { HandlerRejected } from "../../src/control_plane/outbox.js";
import {
  AnswerAlreadyRecorded,
  ackRelay,
  ackUnrelayed,
  answerGate,
  closeOpenGate,
  DeadlineNotPassed,
  deliverRelays,
  GATE_RELAY_RECIPIENT,
  gateDetail,
  openGates,
  presentGate,
  reconcile,
  relayMessageId,
} from "../../src/gate/operator.js";
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

/**
 * A control plane carrying a relay that was in flight when `0005` ran.
 *
 * Built the only way such a row can exist: a database migrated to `0004`,
 * where `outbox.delivery_resource` does not yet exist, a relay written into it,
 * and then the real migration. `0005`'s backfill is what stamps
 * `delivery_resource = 'outbox-delivery'` and the inherited marker, so this
 * fixture's provenance is the migration's own rather than a value a test chose.
 *
 * The gate keeps its `run_id`, which is the whole difficulty the legacy
 * exception exists for: the derivation from the gate produces the RUN resource
 * while the row genuinely carries the global one, so a strict equality would
 * strand exactly these gates.
 */
function inheritedRelayWorld(label: string): {
  readonly connection: SqliteDatabase;
  readonly messageId: string;
} {
  const root = caseRoot(label);
  const partial = join(root, "migrations-0004");
  mkdirSync(partial, { recursive: true });
  const steps = readdirSync(MIGRATIONS_DIR)
    .filter((name) => STEP_FILENAME.test(name))
    .sort();
  const upToFour = steps.filter((name) => Number(name.slice(0, 4)) <= 4);
  // Anti-vacuity on the fixture itself: if the ledger's shape ever changes so
  // that this stops stopping short of 0005, the case would silently start
  // testing a row the migration never touched.
  expect(upToFour.length, "no steps at or below 0004 were found").toBeGreaterThan(0);
  expect(upToFour.length).toBeLessThan(steps.length);
  for (const name of upToFour) {
    writeFileSync(join(partial, name), readFileSync(join(MIGRATIONS_DIR, name)));
  }

  // Created AT 0004, not created at head and then walked back: there are no
  // down migrations, and a database ahead of the ledger it is opened against is
  // refused rather than downgraded. `migrator.test.ts`'s own rebuild case sets
  // this precedent one step earlier.
  const dbPath = join(root, "production.sqlite3");
  const atFour = createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: partial });
  addRun(atFour, RUN_ID, "running");
  const seq = addOriginEvent(atFour);
  openGate(atFour, {
    gateId: GATE_ID,
    gateType: "worker_escalation",
    subjectKind: "run",
    subjectId: RUN_ID,
    rationale: "a relay in flight when the migration ran",
    originEventSeq: seq,
    createdAtMs: T0,
    actorKind: "worker",
    actorId: "worker-7",
    options: ["force-push", "abandon"],
    deadlineAtMs: null,
    runId: RUN_ID,
  });
  const messageId = relayMessageId(GATE_ID, "presented");
  // No `delivery_resource` column to bind: at 0004 the row simply has no
  // resource, which is exactly the state the backfill exists to answer for.
  atFour
    .prepare<[string, string, string, string, number, number]>(
      `
      INSERT INTO outbox (message_id, run_id, recipient, payload, dedup_key, status,
                          enqueued_at_ms, delivered_at_ms)
      VALUES (?, ?, ?, '{}', ?, 'delivered', ?, ?)
      `,
    )
    .run(messageId, RUN_ID, GATE_RELAY_RECIPIENT, `gate/${GATE_ID}/presented`, T0, T0);
  atFour
    .prepare<[string, string, number]>(
      "INSERT INTO gate_relay (gate_id, to_stage, message_id, enqueued_at_ms) VALUES (?, 'presented', ?, ?)",
    )
    .run(GATE_ID, messageId, T0);
  atFour.close();

  const connection = migrateControlPlane(dbPath, { nowMs: T0 + 1 });
  onTestFinished(() => {
    connection.close();
  });
  return { connection, messageId };
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

/**
 * The delivery pass for {@link aGate}'s relays.
 *
 * The run is threaded through because `enqueueRelay` copies `gate.run_id` onto
 * the row and derives the row's delivery resource from it (`D-1104`), so these
 * relays live on this run's resource and a pass that named no run would take
 * the global lease and correctly find nothing.
 */
function deliver(cp: SqliteDatabase, dir: string, nowMs: number, runId: string | null = RUN_ID) {
  return deliverRelays(cp, {
    holder: ACTOR,
    destinationDir: dir,
    runId,
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

/** The delivery resource a row was written under (`D-1104`). */
function resourceOf(cp: SqliteDatabase, messageId: string): string {
  const resource = cp
    .prepare<[string], string>("SELECT delivery_resource FROM outbox WHERE message_id = ?")
    .pluck()
    .get(messageId);
  if (resource === undefined) {
    throw new Error(`no outbox row ${messageId}`);
  }
  return resource;
}

/** A run, its escalation event, and a gate that names no run at all. */
function aRunlessGate(cp: SqliteDatabase): string {
  addRun(cp);
  const seq = addOriginEvent(cp);
  openGate(cp, {
    gateId: GATE_ID,
    gateType: "worker_escalation",
    subjectKind: "run",
    subjectId: RUN_ID,
    rationale: "who owns the release branch",
    originEventSeq: seq,
    createdAtMs: T0,
    actorKind: "worker",
    actorId: "worker-7",
    options: ["me", "you"],
    // Omitted, not null-by-accident: `gate.run_id` carries no NOT NULL and
    // `openGate` defaults it, so a runless gate is an ordinary input.
  });
  return GATE_ID;
}

/**
 * One delivered `presented` relay, written under the resource the caller names.
 *
 * Raw SQL because every shape it builds is unreachable through the product,
 * which is the point: `enqueueRelay` derives the resource from `gate.run_id`
 * on every insert, and `delivery_resource_inherited` is written by migration
 * `0005` and refused to every later writer by its own trigger. A fixture that
 * could reach these rows through the entry points would be evidence of a
 * producer able to corrupt them.
 */
/**
 * A delivered relay row written past `enqueueRelay`, under a named resource.
 *
 * It cannot mark the row as inherited, and that is `0005` enforcing its own
 * header rather than a gap in this helper:
 * `outbox_delivery_resource_inherited_is_not_written_by_a_producer` refuses any
 * INSERT that sets the marker, and its sibling refuses any UPDATE of it. So the
 * ONLY way to get an inherited row is to run the migration over a row that
 * predates it, which is what {@link inheritedRelayWorld} does -- and that is
 * better evidence than a fabricated marker would have been, because the row's
 * provenance is then the real backfill.
 */
function addRawRelay(cp: SqliteDatabase, options: { readonly deliveryResource: string }): string {
  const { deliveryResource } = options;
  const messageId = relayMessageId(GATE_ID, "presented");
  cp.prepare<[string, string, string, string, number, number, string]>(
    `
      INSERT INTO outbox (message_id, run_id, recipient, payload, dedup_key, status,
                          enqueued_at_ms, delivered_at_ms, delivery_resource)
      VALUES (?, ?, ?, '{}', ?, 'delivered', ?, ?, ?)
      `,
  ).run(
    messageId,
    RUN_ID,
    GATE_RELAY_RECIPIENT,
    `gate/${GATE_ID}/presented`,
    T0,
    T0,
    deliveryResource,
  );
  cp.prepare<[string, string, number]>(
    `
      INSERT INTO gate_relay (gate_id, to_stage, message_id, enqueued_at_ms)
      VALUES (?, 'presented', ?, ?)
      `,
  ).run(GATE_ID, messageId, T0);
  return messageId;
}

/** One delivered message no gate enqueued, under the resource the caller names. */
function addUnrelayedMessage(
  cp: SqliteDatabase,
  options: { readonly deliveryResource: string; readonly runId?: string | null } = {
    deliveryResource: DELIVERY_LEASE_RESOURCE,
  },
): string {
  const { deliveryResource, runId = null } = options;
  const messageId = "msg/fan-out/1";
  cp.prepare<[string, string | null, string, string, number, number, string]>(
    `
      INSERT INTO outbox (message_id, run_id, recipient, payload, dedup_key, status,
                          enqueued_at_ms, delivered_at_ms, delivery_resource)
      VALUES (?, ?, ?, '{}', ?, 'delivered', ?, ?, ?)
      `,
  ).run(messageId, runId, GATE_RELAY_RECIPIENT, "fanout/1", T0, T0, deliveryResource);
  return messageId;
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

  test("a Japanese rationale reaches the dropbox file unescaped (continuo#123)", () => {
    // The production path, not a hand-built payload: `presentGate` builds the
    // relay through `presentedPayload` (`pythonJsonObject`), `deliverRelays`
    // hands it to `NotifyDestinationHandler`, which hands it to `KeyedDropbox`
    // unmodified. Escaping any layer of that chain reproduces continuo#123 --
    // in particular, wrapping the record `ensureAscii: false` inside
    // `KeyedDropbox` alone is not enough if `presentedPayload` already
    // rendered the rationale as `\uXXXX` text before it got there.
    const cp = cpFixture("gate-dropbox-ja");
    const dir = destinationDir("gate-dropbox-ja");
    // "whether to use Japanese in the file name" -- a rationale, in Japanese.
    const rationale =
      "\u30d5\u30a1\u30a4\u30eb\u540d\u306b\u65e5\u672c\u8a9e\u3092\u4f7f\u3046\u304b\u3069\u3046\u304b";
    addRun(cp, RUN_ID, "running", T0);
    const seq = addOriginEvent(cp);
    openGate(cp, {
      gateId: GATE_ID,
      gateType: "worker_escalation",
      subjectKind: "run",
      subjectId: RUN_ID,
      rationale,
      originEventSeq: seq,
      createdAtMs: T0,
      actorKind: "worker",
      actorId: "worker-7",
      options: ["force-push", "abandon"],
      runId: RUN_ID,
    });

    presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    deliver(cp, dir, T0 + MINUTE);

    const dropbox = new KeyedDropbox(dir, "case");
    const dedupKey = `${GATE_RELAY_RECIPIENT}:notify:gate/${GATE_ID}/presented`;
    expect(dropbox.effectCount(dedupKey)).toBe(1);

    const payload = dropbox.payloadOf(dedupKey);
    expect(payload).not.toBeNull();
    expect(payload).toContain(rationale);
    expect(payload).not.toContain("\\u30d5");

    // And the record on disk carries it raw too -- `payloadOf` only proves
    // `JSON.parse` can recover it, which a `\uXXXX`-escaped file would also
    // satisfy.
    const stem = createHash("sha256").update(dedupKey, "utf-8").digest("hex");
    const raw = readFileSync(join(dir, `${stem}.effect.json`), "utf-8");
    expect(raw).toContain(rationale);
    expect(raw).not.toContain("\\u30d5");
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

  test("an ack from a recipient the message was not addressed to does not settle it", () => {
    // The carried invariant `MessageBus.ack` states, kept on the path that does
    // not go through the bus: an ack across the recipient boundary is a caller
    // bug rather than a settlement, and it must not advance a stage on the
    // strength of a confirmation from somebody the question was never put to.
    const cp = cpFixture("gate-wrong-recipient");
    const dir = destinationDir("gate-wrong-recipient");
    aGate(cp);
    const relay = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    deliver(cp, dir, T0 + MINUTE);
    expectRefusal(
      () =>
        ackRelay(cp, {
          messageId: relay.messageId,
          actorId: ACTOR,
          recipient: "somebody-else",
          nowMs: T0 + 2 * MINUTE,
        }),
      UnknownGateRefused,
    );
    expect(stageOf(cp)).toBe("received");
    expect(statusOf(cp, relay.messageId)).toBe("delivered");
  });

  test("a replayed ack of an earlier stage's relay changes nothing and does not fail", () => {
    // A delayed or repeated `gate ack` on the presented relay, arriving after
    // the gate has moved on. The ack itself is already a no-op; asking for the
    // advance again would be a rewind, which the transition table refuses -- so
    // a harmless replay used to come back as a refusal, against this verb's own
    // claim that every step is idempotent.
    const cp = cpFixture("gate-replayed-ack");
    const dir = destinationDir("gate-replayed-ack");
    aGate(cp);
    const presented = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    deliver(cp, dir, T0 + MINUTE);
    ackRelay(cp, { messageId: presented.messageId, actorId: ACTOR, nowMs: T0 + 2 * MINUTE });
    answerGate(cp, {
      gateId: GATE_ID,
      body: "force-push",
      actorId: ACTOR,
      nowMs: T0 + 3 * MINUTE,
    });
    expect(stageOf(cp)).toBe("answered");

    const replay = ackRelay(cp, {
      messageId: presented.messageId,
      actorId: ACTOR,
      nowMs: T0 + 4 * MINUTE,
    });

    expect(replay).toMatchObject({ acked: false, advanced: false, closed: false });
    expect(stageOf(cp)).toBe("answered");
  });

  test("an ack that arrives after the gate closed settles nothing and does not fail", () => {
    // The other replay: an acked relay survives a closure untouched, so this
    // one is not caught by the cancelled branch. Nobody is owed a second
    // closure of a gate that already has one.
    const cp = cpFixture("gate-ack-after-close");
    const dir = destinationDir("gate-ack-after-close");
    aGate(cp);
    const presented = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    deliver(cp, dir, T0 + MINUTE);
    ackRelay(cp, { messageId: presented.messageId, actorId: ACTOR, nowMs: T0 + 2 * MINUTE });
    closeOpenGate(cp, {
      gateId: GATE_ID,
      outcome: "unanswerable",
      actorId: ACTOR,
      nowMs: T0 + 3 * MINUTE,
    });

    const replay = ackRelay(cp, {
      messageId: presented.messageId,
      actorId: ACTOR,
      nowMs: T0 + 4 * MINUTE,
    });

    expect(replay).toMatchObject({ acked: false, advanced: false, closed: false });
    expect(outcomeOf(cp)).toBe("unanswerable");
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

  test("a retry forwards the answer the transition holds, and a different one is refused", () => {
    // The window between the two transactions inside `answerGate`: the advance
    // committed, the relay did not. A retry's own body is dropped by
    // `advanceOnAck` (the stage is already 'answered'), so building the payload
    // from it would forward an answer no transition records -- the recipient
    // acting on B while the durable history says A.
    const cp = cpFixture("gate-answer-retry");
    const dir = destinationDir("gate-answer-retry");
    aGate(cp);
    const relay = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    deliver(cp, dir, T0 + MINUTE);
    ackRelay(cp, { messageId: relay.messageId, actorId: ACTOR, nowMs: T0 + 2 * MINUTE });
    // The advance, without the enqueue that ordinarily follows it.
    advanceOnAck(cp, {
      gateId: GATE_ID,
      toStage: "answered",
      actorKind: "human",
      actorId: ACTOR,
      occurredAtMs: T0 + 3 * MINUTE,
      recordedAtMs: T0 + 3 * MINUTE,
      body: "force-push",
    });

    expectRefusal(
      () =>
        answerGate(cp, {
          gateId: GATE_ID,
          body: "abandon",
          actorId: ACTOR,
          nowMs: T0 + 4 * MINUTE,
        }),
      AnswerAlreadyRecorded,
    );
    expect(gateDetail(cp, GATE_ID).relays.map((r) => r.toStage)).toEqual(["presented"]);

    // The retry that repeats the recorded answer completes the enqueue, and the
    // payload carries what the transition holds.
    const finished = answerGate(cp, {
      gateId: GATE_ID,
      body: "force-push",
      actorId: ACTOR,
      nowMs: T0 + 5 * MINUTE,
    });
    expect(finished.advanced).toBe(false);
    expect(finished.enqueued).toBe(true);
    expect(
      cp
        .prepare<[string], string>("SELECT payload FROM outbox WHERE message_id = ?")
        .pluck()
        .get(finished.messageId),
    ).toContain("force-push");
  });

  test("a gate does not close as expired before its deadline, or without one", () => {
    // `expired` is a fact about a deadline. WHETHER a passed deadline expires
    // the gate is the operator's decision (D-0008 keeps that policy out of
    // code); whether it passed is the row's, and a `gate_expired` event for a
    // deadline that did not pass is a durable false statement.
    const withDeadline = cpFixture("gate-expiry-early");
    aGate(withDeadline, { deadlineAtMs: T0 + 2 * MINUTE });
    expectRefusal(
      () =>
        closeOpenGate(withDeadline, {
          gateId: GATE_ID,
          outcome: "expired",
          actorId: ACTOR,
          nowMs: T0 + MINUTE,
        }),
      DeadlineNotPassed,
    );
    expect(outcomeOf(withDeadline)).toBeNull();
    // `expired` is reachable from 'presented' and 'answered' only (section
    // 9.4), so the gate is carried there before the accepted close.
    const relay = presentGate(withDeadline, { gateId: GATE_ID, nowMs: T0 });
    deliver(withDeadline, destinationDir("gate-expiry-early-dropbox"), T0 + MINUTE);
    ackRelay(withDeadline, {
      messageId: relay.messageId,
      actorId: ACTOR,
      nowMs: T0 + MINUTE,
    });
    // The window is half-open, exactly as `gatesPastDeadline` reads it: the gate
    // is past its deadline AT the deadline.
    expect(
      closeOpenGate(withDeadline, {
        gateId: GATE_ID,
        outcome: "expired",
        actorId: ACTOR,
        nowMs: T0 + 2 * MINUTE,
      }),
    ).toBe(true);
    expect(outcomeOf(withDeadline)).toBe("expired");

    const noDeadline = cpFixture("gate-expiry-none");
    aGate(noDeadline);
    expectRefusal(
      () =>
        closeOpenGate(noDeadline, {
          gateId: GATE_ID,
          outcome: "expired",
          actorId: ACTOR,
          nowMs: T0 + MINUTE,
        }),
      DeadlineNotPassed,
    );
    expect(outcomeOf(noDeadline)).toBeNull();
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

  test("delivery is refused while somebody else holds THIS run's delivery lease", () => {
    // The serialisation D-0053 rule 4 asks for, narrowed to one resource by
    // D-1104: the lap of *this* run is that run's delivery authority for as
    // long as it runs, so this verb must refuse rather than become a second
    // writer of the same rows. What is no longer true is the old reading of
    // the same refusal -- "some lap somewhere is running" -- which the
    // companion case below fixes as the concurrency this change buys.
    const cp = cpFixture("gate-lease");
    const dir = destinationDir("gate-lease");
    aGate(cp);
    presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    acquire(cp, {
      resource: deliveryResourceForRun(RUN_ID),
      holder: "a-running-lap",
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    expectRefusal(() => deliver(cp, dir, T0 + MINUTE), LeaseHeld);
  });

  test("a holder of the global lease does not refuse a run's delivery pass", () => {
    // The inversion D-1104 is for, and the only case in this file that is a
    // statement about parallelism: before it, one holder of `outbox-delivery`
    // stopped every operator delivery in the database, whatever run the rows
    // belonged to. The global resource now governs the rows belonging to no
    // run, so a holder of it is not this run's authority and the pass must go
    // through -- and deliver, rather than come back empty and look serialised.
    const cp = cpFixture("gate-lease-global");
    const dir = destinationDir("gate-lease-global");
    aGate(cp);
    const relay = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    acquire(cp, {
      resource: DELIVERY_LEASE_RESOURCE,
      holder: "the-runless-drainer",
      nowMs: T0,
      ttlMs: TTL_MS,
    });

    expect(deliver(cp, dir, T0 + MINUTE).delivered.map((m) => m.messageId)).toEqual([
      relay.messageId,
    ]);
    expect(statusOf(cp, relay.messageId)).toBe("delivered");
    // And the other direction of the same fact: the global pass is refused
    // while that global holder is live, so nothing here weakened the fence.
    expectRefusal(() => deliver(cp, dir, T0 + 2 * MINUTE, null), LeaseHeld);
  });

  test("the relay recipient is not a per-call argument", () => {
    // The shape that made an unfixable gate possible: `enqueueRelay` writes the
    // recipient onto the row and `(gate_id, to_stage)` makes it final, so a
    // recipient chosen per call could be chosen wrong once -- after the
    // `answered` transition had already committed -- and never corrected. Both
    // enqueue sites read the constant, and this is what says so.
    const cp = cpFixture("gate-recipient-constant");
    aGate(cp);
    presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    expect(
      cp
        .prepare<[string], string>("SELECT recipient FROM outbox WHERE message_id = ?")
        .pluck()
        .get(relayMessageId(GATE_ID, "presented")),
    ).toBe(GATE_RELAY_RECIPIENT);
  });

  test("a recipient no handler serves is refused before the lease is taken", () => {
    // The endpoint refuses this at startup; the verb refuses it here, and
    // before claiming the delivery resource of the run it was asked for -- a
    // misconfiguration must not cost the operator a TTL of the lease that
    // run's lap needs. The resource the absence is asserted over is the run's
    // since D-1104: the pass derives it from `--run-id`, so a row under the
    // global name would prove nothing about what this call did not claim.
    const cp = cpFixture("gate-unserved");
    const dir = destinationDir("gate-unserved");
    aGate(cp);
    expect(() =>
      deliverRelays(cp, {
        holder: ACTOR,
        destinationDir: dir,
        recipient: "nobody-serves-this",
        runId: RUN_ID,
        nowMs: T0,
        ttlMs: TTL_MS,
      }),
    ).toThrow(HandlerRejected);
    expect(
      cp
        .prepare<[string], number>("SELECT COUNT(*) FROM lease WHERE resource = ?")
        .pluck()
        .get(deliveryResourceForRun(RUN_ID)),
    ).toBe(0);
  });

  test("an unknown gate is refused by the reader as well as by the writers", () => {
    const cp = cpFixture("gate-unknown");
    expectRefusal(() => gateDetail(cp, "gate-nope"), UnknownGateRefused);
  });
});

describe("the delivery resource a relay carries (D-1104)", () => {
  test("a relay is written under its own gate's run resource", () => {
    // The unfenced producer's rule, read off the row: `enqueueRelay` holds no
    // lease, so the resource cannot come from a live epoch and comes from the
    // gate's durable `run_id` instead. This is the fact `ackRelay`'s
    // cross-check re-derives, and the fact `gate deliver --run-id` selects on.
    const cp = cpFixture("relay-resource-run");
    aGate(cp);
    const relay = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    expect(resourceOf(cp, relay.messageId)).toBe(deliveryResourceForRun(RUN_ID));
    expect(resourceOf(cp, relay.messageId)).toBe("outbox-delivery:run:run-1");
  });

  test("a relay of a gate that belongs to no run takes the global resource", () => {
    // `deliveryResourceForRun` is total on null on purpose: a runless gate is
    // an ordinary input rather than a hypothetical, and its relay must be
    // reachable by some drainer. The one it is reachable by is this same verb
    // with no run -- the path legacy and fan-out rows take -- so the case
    // delivers it rather than only asserting the string.
    const cp = cpFixture("relay-resource-global");
    const dir = destinationDir("relay-resource-global");
    aRunlessGate(cp);
    const relay = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    expect(resourceOf(cp, relay.messageId)).toBe(DELIVERY_LEASE_RESOURCE);

    expect(deliver(cp, dir, T0 + MINUTE, null).delivered.map((m) => m.messageId)).toEqual([
      relay.messageId,
    ]);
    expect(statusOf(cp, relay.messageId)).toBe("delivered");
  });

  test("a relay whose resource disagrees with its gate's run is not settled", () => {
    // The cross-check between two independently stored facts: the row's
    // `delivery_resource` and the gate's `run_id` were derived from the same
    // value at the insert, so a disagreement is a corrupted relay rather than
    // a mistyped flag -- and a settlement is irreversible (`acked_at_ms` is
    // set once by the outbox's own trigger), so the refusal must land before
    // the ack rather than after it.
    const cp = cpFixture("relay-resource-corrupt");
    aGate(cp);
    const messageId = addRawRelay(cp, { deliveryResource: deliveryResourceForRun("run-9") });

    expectRefusal(
      () => ackRelay(cp, { messageId, actorId: ACTOR, nowMs: T0 + MINUTE }),
      UnknownGateRefused,
    );
    // Nothing was settled and no stage moved on the strength of it.
    expect(statusOf(cp, messageId)).toBe("delivered");
    expect(stageOf(cp)).toBe("received");
  });

  test("a global relay under a run's gate is settled only if 0005 inherited it", () => {
    // The one bounded exception, and its bound in the same case. A relay
    // in flight when the migration ran was backfilled to the resource it was
    // genuinely written under, while the derivation from the same gate's
    // still-present `run_id` produces the run resource -- so a strict equality
    // would leave exactly those gates permanently unable to advance. After
    // `0005` the same shape is unreachable by construction, so an unmarked row
    // is corruption; the marker, which nothing but the migration may write, is
    // the only thing that tells the two apart.
    const { connection: inherited, messageId: legacy } = inheritedRelayWorld(
      "relay-resource-inherited",
    );
    // The migration really did it: the resource it was written under, and the
    // marker no producer can write.
    expect(resourceOf(inherited, legacy)).toBe(DELIVERY_LEASE_RESOURCE);
    expect(
      inherited
        .prepare<[string], { delivery_resource_inherited: number | null }>(
          "SELECT delivery_resource_inherited FROM outbox WHERE message_id = ?",
        )
        .get(legacy)?.delivery_resource_inherited,
    ).toBe(1);

    const acked = ackRelay(inherited, { messageId: legacy, actorId: ACTOR, nowMs: T0 + MINUTE });
    expect(acked.acked).toBe(true);
    expect(acked.advanced).toBe(true);
    expect(stageOf(inherited)).toBe("presented");

    const unmarked = cpFixture("relay-resource-unmarked");
    aGate(unmarked);
    const corrupt = addRawRelay(unmarked, { deliveryResource: DELIVERY_LEASE_RESOURCE });
    expectRefusal(
      () => ackRelay(unmarked, { messageId: corrupt, actorId: ACTOR, nowMs: T0 + MINUTE }),
      UnknownGateRefused,
    );
    expect(statusOf(unmarked, corrupt)).toBe("delivered");
    expect(stageOf(unmarked)).toBe("received");
  });
});

describe("the ack for a message no gate enqueued (D-1104)", () => {
  test("a runless message is settled under the global resource", () => {
    // Option (b) of the design's section 6: the rows belonging to no run --
    // event fan-out and everything `0005` inherited -- have no lap to settle
    // them once the endpoint stopped being the only holder of the global
    // resource, so the operator's verb is their delivery authority. The lease
    // is taken around it even though `recordAck` is unfenced, which is what
    // makes the pass refuse rather than race a live global authority.
    const cp = cpFixture("unrelayed-ack");
    const messageId = addUnrelayedMessage(cp, { deliveryResource: DELIVERY_LEASE_RESOURCE });

    const settled = ackUnrelayed(cp, {
      messageId,
      actorId: ACTOR,
      holder: ACTOR,
      nowMs: T0 + MINUTE,
      ttlMs: TTL_MS,
    });
    expect(settled.acked).toBe(true);
    expect(settled.cancelled).toBe(false);
    expect(settled.recipient).toBe(GATE_RELAY_RECIPIENT);
    expect(settled.epoch).toBeGreaterThan(0);
    expect(statusOf(cp, messageId)).toBe("acked");

    // And it is idempotent, like every other ack on this path: a repeat is a
    // settlement that changed nothing rather than a refusal.
    const repeat = ackUnrelayed(cp, {
      messageId,
      actorId: ACTOR,
      holder: ACTOR,
      nowMs: T0 + 2 * MINUTE,
      ttlMs: TTL_MS,
    });
    expect(repeat.acked).toBe(false);
    expect(statusOf(cp, messageId)).toBe("acked");
  });

  test("a gate relay is refused rather than settled without its advance", () => {
    // The verbs are not interchangeable and the difference is not cosmetic:
    // `ackRelay` also takes the step the ack justifies, so settling a relay
    // here would record the ack and leave the gate at a stage no recovery pass
    // reports -- an answered gate open for ever.
    const cp = cpFixture("unrelayed-ack-relay");
    const dir = destinationDir("unrelayed-ack-relay");
    aGate(cp);
    const relay = presentGate(cp, { gateId: GATE_ID, nowMs: T0 });
    deliver(cp, dir, T0 + MINUTE);

    expectRefusal(
      () =>
        ackUnrelayed(cp, {
          messageId: relay.messageId,
          actorId: ACTOR,
          holder: ACTOR,
          nowMs: T0 + 2 * MINUTE,
          ttlMs: TTL_MS,
        }),
      UnknownGateRefused,
    );
    expect(statusOf(cp, relay.messageId)).toBe("delivered");
    expect(stageOf(cp)).toBe("received");
  });

  test("a run-bound message belongs to that run's authority, not to this verb", () => {
    // Strict here, unlike the relay path: the inherited exception exists for a
    // row a migration met under a gate that names a run, and there is no such
    // shape without a gate. A run-bound non-relay row has a worker -- that
    // run's endpoint -- and settling it from the global verb would be reaching
    // into a partition this caller is not the authority for.
    const cp = cpFixture("unrelayed-ack-run-bound");
    const messageId = addUnrelayedMessage(cp, {
      deliveryResource: deliveryResourceForRun(RUN_ID),
      runId: null,
    });

    expectRefusal(
      () =>
        ackUnrelayed(cp, {
          messageId,
          actorId: ACTOR,
          holder: ACTOR,
          nowMs: T0 + MINUTE,
          ttlMs: TTL_MS,
        }),
      UnknownGateRefused,
    );
    expect(statusOf(cp, messageId)).toBe("delivered");
  });

  test("the unrelayed ack refuses while the global delivery lease is held", () => {
    // The global resource's live authority is somebody else's for the length
    // of its TTL, and this verb refuses instead of racing it. A run's lease
    // being held is NOT this refusal (that is the whole of D-1104), and the
    // case below the refusal says so.
    const cp = cpFixture("unrelayed-ack-lease");
    const messageId = addUnrelayedMessage(cp, { deliveryResource: DELIVERY_LEASE_RESOURCE });
    acquire(cp, {
      resource: DELIVERY_LEASE_RESOURCE,
      holder: "the-other-drainer",
      nowMs: T0,
      ttlMs: TTL_MS,
    });

    expectRefusal(
      () =>
        ackUnrelayed(cp, {
          messageId,
          actorId: ACTOR,
          holder: ACTOR,
          nowMs: T0 + MINUTE,
          ttlMs: TTL_MS,
        }),
      LeaseHeld,
    );
    expect(statusOf(cp, messageId)).toBe("delivered");
  });

  test("a lap holding one run's lease does not block the runless ack", () => {
    // The other direction, which is the concurrency this change buys on the
    // ack side too: a lap is its run's delivery authority and nothing more, so
    // the rows belonging to no run stay settleable while it runs.
    const cp = cpFixture("unrelayed-ack-run-lease");
    const messageId = addUnrelayedMessage(cp, { deliveryResource: DELIVERY_LEASE_RESOURCE });
    acquire(cp, {
      resource: deliveryResourceForRun(RUN_ID),
      holder: "a-running-lap",
      nowMs: T0,
      ttlMs: TTL_MS,
    });

    expect(
      ackUnrelayed(cp, {
        messageId,
        actorId: ACTOR,
        holder: ACTOR,
        nowMs: T0 + MINUTE,
        ttlMs: TTL_MS,
      }).acked,
    ).toBe(true);
    expect(statusOf(cp, messageId)).toBe("acked");
  });
});

describe("a delivery pass names a run that exists (D-1104)", () => {
  test("a run id no control plane admitted is refused before the lease is taken", () => {
    // Measured during implementation rather than designed. Without this
    // refusal a mistyped `--run-id` takes a lease on a resource no producer
    // has ever written, delivers nothing, and reports success -- and
    // "delivered 0 message(s)" from a typo is byte-identical to
    // "delivered 0 message(s)" from a queue that really is empty, which is
    // the one report an operator draining a known gate's relays cannot act
    // on. The verb already spends a refusal here on an unserved recipient.
    const cp = cpFixture("unknown-run");
    const dir = destinationDir("unknown-run");
    aGate(cp);
    presentGate(cp, { gateId: GATE_ID, nowMs: T0 });

    expectRefusal(() => deliver(cp, dir, T0 + MINUTE, "run-typo"), UnknownGateRefused, /run-typo/);

    // Before the lease, which is the half that matters: a refusal that had
    // already claimed the resource would withhold it for a whole TTL from the
    // pass the operator retypes correctly.
    expect(
      cp
        .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM lease WHERE resource = ?")
        .get(deliveryResourceForRun("run-typo"))?.n,
    ).toBe(0);

    // Anti-vacuity, and the boundary this refusal must not cross: omitting the
    // run is NOT a typo. It names the global resource, where legacy and
    // runless rows live and where no `run` row is expected to exist at all.
    expect(deliver(cp, dir, T0 + MINUTE, null).delivered).toEqual([]);
    expect(
      cp
        .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM lease WHERE resource = ?")
        .get(DELIVERY_LEASE_RESOURCE)?.n,
    ).toBe(1);
  });
});
