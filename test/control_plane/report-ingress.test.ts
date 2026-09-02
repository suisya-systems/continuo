/**
 * The report ingress' writing half: one turn's terminal report becomes a
 * `worker_escalation_raised` event and the gate standing over it, in one
 * transaction (`D-0056`).
 *
 * No parity ledger claims this file. `src/control_plane/report_ingress.ts` has
 * no counterpart in interlock -- it closes a seam
 * `docs/design/minimal-operating-loop.md` section 4.7 describes as having no
 * mechanism at all on either side -- so every case here is target-only and each
 * one names, in its own comment, what would be silently wrong without it
 * (`docs/test-translation-conventions.md` rule 10).
 *
 * **This file imports nothing from `src/session/`, and that is load-bearing
 * rather than incidental.** `test/gate_item11/no-provider-detail-leaks.test.ts`
 * fails any file under `test/control_plane/` that names a session backend, and
 * the ingress is deliberately shaped so it does not have to: the terminal
 * report arrives as plain data. A case here that reached for the provider to
 * build its fixture would be the first move in undoing that.
 */

import { resolve } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { EVENT_TYPES } from "../../src/control_plane/events.js";
import { LapRunIntent } from "../../src/control_plane/lap_run_intent.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import {
  escalationDedupKey,
  ingestTerminalReport,
  REPORT_INGRESS_PRODUCER,
  ReportIngressUsageError,
  type TerminalReportFact,
  WORKER_ESCALATION_EVENT_TYPE,
  WORKER_ESCALATION_GATE_TYPE,
  WORKER_ESCALATION_SCHEMA_VERSION,
} from "../../src/control_plane/report_ingress.js";
import { admitRun } from "../../src/control_plane/run_admission.js";
import { transaction } from "../../src/control_plane/txn.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const RUN_ID = "run-1";
const SESSION_ID = "sess-1";
const REPORT = "I rebased onto main and the fence refuses the push. May I publish?";

/**
 * The execution intent `admitRun` takes since `D-0055`.
 *
 * A prerequisite here, not a subject: every field is a plausible default and
 * only `runId` ever varies, because the cases below are about the escalation
 * the run carries rather than about the run.
 */
function intent(runId: string): LapRunIntent {
  return new LapRunIntent({
    runId,
    leaseClaimantId: "secretary-1",
    workspace: resolve("wt", runId),
    role: "worker",
    baseBranch: "main",
    topicBranch: `feat/${runId}`,
    prompt: "port the thing",
  });
}

const productionTemplate = suiteTemplate("report-ingress.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/** A migrated production control plane at head, carrying one admitted run. */
function cpFixture(): { connection: SqliteDatabase; path: string } {
  const path = productionTemplate.copyInto(caseRoot("report-ingress"));
  const connection = openProductionControlPlane(path);
  onTestFinished(() => {
    connection.close();
  });
  // Both `event.run_id` and `gate.run_id` are foreign keys onto `run(run_id)`
  // and the connection runs with `PRAGMA foreign_keys = ON`, so the run has to
  // exist before anything below can be written at all.
  admitRun(connection, { intent: intent(RUN_ID), nowMs: T0 });
  bindSession(connection, { sessionId: SESSION_ID, runId: RUN_ID });
  return { connection, path };
}

/**
 * A session bound to a run and confirmed, written raw.
 *
 * `prepareBinding` / `markSpawned` / `confirmIdentity` are lease-fenced writers
 * and this is a prerequisite row rather than the subject under test, so it goes
 * in directly -- the same treatment `gates.test.ts` gives the `run` and origin
 * event rows its cases stand on.
 */
function bindSession(
  connection: SqliteDatabase,
  options: { readonly sessionId: string; readonly runId: string; readonly phase?: string },
): void {
  const phase = options.phase ?? "identity_confirmed";
  const confirmed = phase === "identity_confirmed";
  connection
    .prepare<[string, string, string, string, string, string | null, string | null, number]>(
      `INSERT INTO session (session_id, run_id, provider, binding_phase, observation,
                            provider_state, observation_reason, bound_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.sessionId,
      options.runId,
      "claude-cli",
      phase,
      confirmed ? "observed" : "unobserved",
      confirmed ? "completed" : null,
      confirmed ? null : "spawn requested; identity not yet read back",
      T0,
    );
}

/**
 * A second connection onto the same file.
 *
 * What this one can see is what committed, which is the only way to tell a
 * transaction that closed from a transaction that is merely still open on the
 * writer's own handle.
 */
function committedView(path: string): SqliteDatabase {
  const connection = new Database(path, { fileMustExist: true });
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

function escalationRows(connection: SqliteDatabase): Record<string, unknown>[] {
  return connection
    .prepare<[string], Record<string, unknown>>(
      "SELECT * FROM event WHERE event_type = ? ORDER BY seq",
    )
    .all(WORKER_ESCALATION_EVENT_TYPE) as Record<string, unknown>[];
}

function gateRows(connection: SqliteDatabase): Record<string, unknown>[] {
  return connection.prepare("SELECT * FROM gate ORDER BY gate_id").all() as Record<
    string,
    unknown
  >[];
}

function transitionRows(connection: SqliteDatabase): Record<string, unknown>[] {
  return connection.prepare("SELECT * FROM gate_transition ORDER BY seq").all() as Record<
    string,
    unknown
  >[];
}

/** A terminal report that is an escalation, with overrides for the cases that are not. */
function terminalReport(overrides: Partial<TerminalReportFact> = {}): TerminalReportFact {
  return {
    sessionId: SESSION_ID,
    generation: 0,
    report: REPORT,
    terminalReason: "completed",
    subtype: "success",
    isError: false,
    returncode: 0,
    ...overrides,
  };
}

function ingest(
  connection: SqliteDatabase,
  overrides: Partial<TerminalReportFact> = {},
): ReturnType<typeof ingestTerminalReport> {
  return ingestTerminalReport(connection, {
    runId: RUN_ID,
    report: terminalReport(overrides),
    nowMs: T0,
    actorId: "orchestrator-1",
  });
}

describe("the escalation the transcript produced", () => {
  test("the event and the gate are one committed fact", () => {
    // Without this, the ingress could append an event nobody is asking about,
    // or open a gate whose origin event is a sequence number that names nothing.
    const { connection, path } = cpFixture();

    const ingested = ingest(connection);

    const committed = committedView(path);
    const events = escalationRows(committed);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: ingested.eventSeq,
      event_id: escalationDedupKey(SESSION_ID, 0),
      event_type: WORKER_ESCALATION_EVENT_TYPE,
      subject_kind: "run",
      subject_id: RUN_ID,
      run_id: RUN_ID,
      dedup_key: escalationDedupKey(SESSION_ID, 0),
      producer: REPORT_INGRESS_PRODUCER,
      occurred_at_ms: T0,
      ingested_at_ms: T0,
    });

    const gates = gateRows(committed);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gate_id: ingested.gateId,
      gate_type: WORKER_ESCALATION_GATE_TYPE,
      run_id: RUN_ID,
      subject_kind: "run",
      subject_id: RUN_ID,
      origin_event_seq: ingested.eventSeq,
      stage: "received",
      outcome: null,
    });
    expect(ingested.duplicate).toBe(false);
    expect(ingested.gateOpened).toBe(true);

    // The gate's projection points at its own opening transition, which is the
    // third statement `openGate` makes and the one a hand-rolled copy would be
    // most likely to leave out.
    const transitions = transitionRows(committed);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      gate_id: ingested.gateId,
      transition_kind: "open",
      from_stage: null,
      to_stage: "received",
    });
    expect(gates[0]?.["stage_seq"]).toBe(transitions[0]?.["seq"]);
  });

  test("the gate's rationale is the report, verbatim and identical to the payload's", () => {
    // Section 4.7 puts the report in the origin event's payload and from there
    // into `rationale`. Without this, the two could drift -- a trimmed
    // rationale and an untrimmed payload -- and the human would be approving
    // text the record does not hold.
    const { connection, path } = cpFixture();
    const spaced = `  ${REPORT}\n`;

    const ingested = ingest(connection, { report: spaced });

    const committed = committedView(path);
    const gate = gateRows(committed)[0];
    expect(gate?.["rationale"]).toBe(spaced);

    const payload = JSON.parse(String(escalationRows(committed)[0]?.["payload"])) as Record<
      string,
      unknown
    >;
    expect(payload["report"]).toBe(spaced);
    expect(payload["report"]).toBe(gate?.["rationale"]);
    expect(ingested.gateOpened).toBe(true);
  });

  test("the payload carries the turn's identity and its terminal words", () => {
    // The payload is what a consumer of the spine reads instead of the
    // transcript; a field missing here is a fact that only exists in a file
    // outside both databases.
    const { connection, path } = cpFixture();

    ingest(connection, { generation: 3, terminalReason: "completed", subtype: "success" });

    const payload = JSON.parse(
      String(escalationRows(committedView(path))[0]?.["payload"]),
    ) as Record<string, unknown>;
    expect(payload).toEqual({
      schema_version: WORKER_ESCALATION_SCHEMA_VERSION,
      report: REPORT,
      session_id: SESSION_ID,
      generation: 3,
      terminal_reason: "completed",
      subtype: "success",
      is_error: false,
      returncode: 0,
    });
  });

  test("the event type is one the vocabulary already had", () => {
    // D-0056 decision 3: this task adds no event type. If `EVENT_TYPES` ever
    // stops carrying this name, the ingress is producing an event nothing
    // subscribes to and no reader can discover.
    expect(EVENT_TYPES.has(WORKER_ESCALATION_EVENT_TYPE)).toBe(true);
  });
});

describe("the dedup key is the turn, not the session", () => {
  test("a second turn of one session raises its own escalation", () => {
    // The failure this is the whole reason for: a key naming only the session
    // would read generation 1's report as a restatement of generation 0's, the
    // append would be absorbed as a duplicate fact, and the second turn's
    // escalation would never reach a human.
    const { connection, path } = cpFixture();

    const first = ingest(connection, { generation: 0, report: "turn one" });
    const second = ingest(connection, { generation: 1, report: "turn two" });

    expect(second.eventSeq).not.toBe(first.eventSeq);
    expect(second.gateId).not.toBe(first.gateId);
    expect(second.duplicate).toBe(false);
    expect(second.gateOpened).toBe(true);

    const committed = committedView(path);
    expect(escalationRows(committed)).toHaveLength(2);
    expect(gateRows(committed)).toHaveLength(2);
    expect(
      gateRows(committed)
        .map((row) => row["rationale"])
        .sort(),
    ).toEqual(["turn one", "turn two"]);
  });

  test("the key names the turn", () => {
    expect(escalationDedupKey(SESSION_ID, 2)).toBe(`worker_escalation/${SESSION_ID}/2`);
    expect(escalationDedupKey(SESSION_ID, 2)).not.toBe(escalationDedupKey(SESSION_ID, 3));
  });
});

describe("re-processing an already ingested transcript", () => {
  test("recovers the origin sequence and opens no second gate", () => {
    // The restart path. `appendEvent` answers a known dedup key with
    // `seq = null`, so an ingress that trusted that value would either crash or
    // -- worse -- open a second gate over the same escalation, and a human
    // would be asked one question twice.
    const { connection, path } = cpFixture();

    const first = ingest(connection);
    const again = ingest(connection);

    expect(again.duplicate).toBe(true);
    expect(again.gateOpened).toBe(false);
    expect(again.eventSeq).toBe(first.eventSeq);
    expect(again.gateId).toBe(first.gateId);
    expect(again.eventId).toBe(first.eventId);

    const committed = committedView(path);
    expect(escalationRows(committed)).toHaveLength(1);
    expect(gateRows(committed)).toHaveLength(1);
    expect(transitionRows(committed)).toHaveLength(1);
  });

  test("a gate already standing over the origin event is left alone", () => {
    // The check is on `origin_event_seq`, not on the gate id: a caller that
    // derived a different identifier for the same escalation must still not get
    // a second gate. Without this the idempotence would be an artifact of the
    // id happening to match.
    const { connection, path } = cpFixture();

    const first = ingest(connection);
    // A hand-rolled second gate over the same origin event, as a caller with
    // its own naming scheme would produce.
    connection
      .prepare<[number, number, number]>(
        `INSERT INTO gate (gate_id, gate_type, run_id, subject_kind, subject_id,
                           origin_event_seq, rationale, options, stage, stage_seq,
                           stage_entered_at_ms, created_at_ms)
         VALUES ('other-gate', 'worker_escalation', 'run-1', 'run', 'run-1',
                 ?, 'x', '[]', 'received', NULL, ?, ?)`,
      )
      .run(first.eventSeq, T0, T0);

    const again = ingest(connection);

    // It found a gate standing over the origin event and reported that one,
    // rather than opening a third.
    expect(again.gateOpened).toBe(false);
    expect(gateRows(committedView(path))).toHaveLength(2);
  });
});

describe("the transaction is one boundary", () => {
  test("an abandoned outer transaction leaves neither the event nor the gate", () => {
    // `openGate` opens a transaction of its own, and this ingress relies on
    // `txn.ts` JOINING that call to the outer one rather than nesting it. If
    // that ever changed -- to real nesting, or to savepoints -- the gate would
    // commit inside a block the caller went on to roll back, and the spine
    // would hold a gate whose origin event does not exist. This is the case
    // that would go red.
    const { connection, path } = cpFixture();

    expect(() =>
      transaction(connection, (tx) => {
        ingestTerminalReport(tx, {
          runId: RUN_ID,
          report: terminalReport(),
          nowMs: T0,
          actorId: "orchestrator-1",
        });
        throw new Error("abandoned");
      }),
    ).toThrow("abandoned");

    const committed = committedView(path);
    expect(escalationRows(committed)).toEqual([]);
    expect(gateRows(committed)).toEqual([]);
    expect(transitionRows(committed)).toEqual([]);
  });

  test("a refused gate takes its event down with it", () => {
    // The half-write the one-transaction rule exists to prevent, driven from
    // the gate's side: an actor that may not open a gate must not leave an
    // escalation event behind on its way out.
    const { connection, path } = cpFixture();

    expect(() =>
      ingestTerminalReport(connection, {
        runId: RUN_ID,
        report: terminalReport(),
        nowMs: T0,
        actorId: "operator-1",
        // Only 'worker' and 'system' may take the `open` edge.
        actorKind: "human",
      }),
    ).toThrow();

    const committed = committedView(path);
    expect(escalationRows(committed)).toEqual([]);
    expect(gateRows(committed)).toEqual([]);
  });
});

describe("what is not an escalation", () => {
  test("a blank report is refused, and the database would not have caught it", () => {
    // `CHECK (length(rationale) > 0)` accepts a rationale of three spaces, so
    // this rule exists only in the ingress. Without the case, a whitespace-only
    // report would open a gate asking a human to approve nothing.
    const { connection, path } = cpFixture();

    for (const blank of ["", "   ", "\n\t "]) {
      expectRefusal(
        () => ingest(connection, { report: blank }),
        ReportIngressUsageError,
        /non-blank/,
      );
    }

    const committed = committedView(path);
    expect(escalationRows(committed)).toEqual([]);
    expect(gateRows(committed)).toEqual([]);
  });

  test("a turn the CLI called an error is refused even when it wrote prose", () => {
    // D-0056 decision 2. An `is_error` turn that happens to have written
    // something is an execution failure, and absorbing it would put a crash
    // trace in front of a human as though the worker were asking a question.
    const { connection, path } = cpFixture();

    expectRefusal(
      () => ingest(connection, { isError: true, report: "Traceback: the tool crashed" }),
      ReportIngressUsageError,
      /is_error/,
    );

    const committed = committedView(path);
    expect(escalationRows(committed)).toEqual([]);
    expect(gateRows(committed)).toEqual([]);
  });

  test("a report is not ingested against a run its session does not belong to", () => {
    // The check the session table is the authority for. A stale or transposed
    // run identifier would otherwise turn one worker's publish-approval
    // question into a gate on a run that worker never touched, and nothing
    // downstream could tell: the payload's session id has no foreign key.
    const { connection, path } = cpFixture();
    admitRun(connection, { intent: intent("run-2"), nowMs: T0 });

    expectRefusal(
      () =>
        ingestTerminalReport(connection, {
          runId: "run-2",
          report: terminalReport(),
          nowMs: T0,
          actorId: "orchestrator-1",
        }),
      ReportIngressUsageError,
      /is bound to run/,
    );

    const committed = committedView(path);
    expect(escalationRows(committed)).toEqual([]);
    expect(gateRows(committed)).toEqual([]);
  });

  test("a session with no binding at all is refused", () => {
    const { connection } = cpFixture();

    expectRefusal(
      () => ingest(connection, { sessionId: "never-bound" }),
      ReportIngressUsageError,
      /has no binding/,
    );
  });

  test("a session whose identity was never read back is refused", () => {
    // The durable half of "identity-confirmed". A transcript can only prove it
    // belongs to its session; that the session belongs to this run, and that
    // its identity was actually reconciled and committed, is what the binding
    // phase records. Ingesting at 'spawned' would accept a report from a
    // session whose identity nobody ever confirmed.
    // Its own run: `session_one_active_binding_per_run` admits one active
    // binding per run, and this case needs a second session.
    const { connection, path } = cpFixture();
    admitRun(connection, { intent: intent("run-2"), nowMs: T0 });
    bindSession(connection, { sessionId: "unconfirmed", runId: "run-2", phase: "spawned" });

    expectRefusal(
      () =>
        ingestTerminalReport(connection, {
          runId: "run-2",
          report: terminalReport({ sessionId: "unconfirmed" }),
          nowMs: T0,
          actorId: "orchestrator-1",
        }),
      ReportIngressUsageError,
      /binding phase/,
    );

    expect(escalationRows(committedView(path))).toEqual([]);
  });

  test("blankness is decided the same way the provider decides it", () => {
    // The provider strips with CPython's whitespace set, so a report it hands
    // over as reportable must not be refused here as blank. U+FEFF is the case
    // that separates the two: blank to JavaScript's trim(), not to Python's
    // strip(). Deciding it with trim() here would lose exactly the escalations
    // the provider had just accepted.
    const { connection } = cpFixture();

    const ingested = ingest(connection, { report: "\uFEFF" });
    expect(ingested.gateOpened).toBe(true);

    // And the converse: a separator Python strips and JavaScript does not is
    // blank here too, so the two boundaries agree in both directions.
    expectRefusal(
      () => ingest(connection, { generation: 9, report: "\u001c" }),
      ReportIngressUsageError,
      /non-blank/,
    );
  });

  test("malformed arguments are refused before any write", () => {
    const { connection, path } = cpFixture();

    expectRefusal(
      () =>
        ingestTerminalReport(connection, {
          runId: "",
          report: terminalReport(),
          nowMs: T0,
          actorId: "orchestrator-1",
        }),
      ReportIngressUsageError,
      /run_id/,
    );
    expectRefusal(
      () => ingest(connection, { generation: -1 }),
      ReportIngressUsageError,
      /generation/,
    );
    expectRefusal(
      () => ingest(connection, { sessionId: "" }),
      ReportIngressUsageError,
      /session_id/,
    );

    const committed = committedView(path);
    expect(escalationRows(committed)).toEqual([]);
    expect(gateRows(committed)).toEqual([]);
  });
});
