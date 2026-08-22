/**
 * The numerator is the applied effect, the preference order is proved by
 * disagreement.
 *
 * Ported from interlock `tests/measurement/test_false_termination.py` at
 * `65f36c5`. Every case here maps to one source node id; the mapping, and the
 * cases that are adapted rather than translated straight, are recorded in
 * `parity/measurement.ledger.json`.
 *
 * Every test here is built around a shape that a plausible wrong implementation
 * gets right on friendly data:
 *
 * * **A recommendation is not a termination.** The suite contains a declined
 *   recommendation labelled `not_stuck` -- the exact row a harness counting
 *   recommendations would charge to us as a false termination. It must appear in
 *   `recommendedTerminate` and in `declinedRefused`, and in neither the
 *   numerator nor the denominator. Nothing about that is visible in a fixture
 *   where every recommendation was applied.
 * * **The preference order only exists when the sources disagree.** So the order
 *   is proved by constructing a case where the fixture label says `stuck` and
 *   the subject's own subsequent evidence says `not_stuck`, and asserting the
 *   label wins -- and, separately, by asserting the winning source is
 *   `GROUND_TRUTH_PREFERENCE[0]` rather than the literal string, so the test
 *   binds to the module's declared order rather than restating it.
 * * **Undetermined is reachable.** An applied termination with no ground truth at
 *   all lands in its own bucket, moves neither rate bound on its own, and opens
 *   the gap between them. A harness that defaulted the unsettled case either way
 *   would pass a suite in which every case is settled.
 * * **The kind literal is load-bearing.** `action.kind` is unconstrained in the
 *   DDL, so a second applied action of a different kind is inserted and must not
 *   be counted.
 *
 * Fixtures are written through an ordinary connection; every read under test
 * goes through the harness's read-only handle.
 */

import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import {
  adjudicate,
  FalseTerminationRefusal,
  FalseTerminationReport,
  GROUND_TRUTH_PREFERENCE,
  measureFalseTermination,
  QUERY_DEFINITIONS,
  readTerminateActions,
  renderFalseTerminationReport,
  SOURCE_FIXTURE_LABEL,
  SOURCE_HUMAN_ADJUDICATION,
  SOURCE_NONE,
  SOURCE_SUBSEQUENT_EVIDENCE,
  STATUS_APPLIED,
  STATUS_PENDING,
  STATUS_REFUSED,
  subsequentActivityVerdicts,
  TERMINATE_SESSION_KIND,
  UnknownGroundTruthVerdict,
  VERDICT_NOT_STUCK,
  VERDICT_STUCK,
  VERDICT_UNDETERMINED,
} from "../../src/measurement/false-termination.js";
import { isAscii, reportValue } from "../../src/measurement/format.js";
import { openForMeasurement } from "../../src/measurement/reader.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const PERIOD_START = T0;
const PERIOD_END = T0 + DAY_MS;
const NOW_MS = T0 + DAY_MS + MINUTE_MS;

/**
 * The event types this suite declares productive. Declared per report, never
 * defaulted: see `subsequentActivityVerdicts`.
 */
const PRODUCTIVE = ["session_activity"] as const;

/**
 * The source's `db` fixture, as a per-test call.
 *
 * Function scope, as rule 8 of docs/test-translation-conventions.md prefers:
 * the source fixture is function-scoped and a shared one would be a coupling
 * the port's isolation contract exists to keep out.
 */
function productionDb(): string {
  const path = join(caseRoot("false-termination"), "production.sqlite3");
  createProductionControlPlane(path, { nowMs: T0 }).close();
  return path;
}

/**
 * An ordinary writable handle -- deliberately not the harness's.
 *
 * The source opens one per helper call and closes it in a `finally`; so does
 * this, because on Windows a handle left open keeps a lock on the file and the
 * temp-directory cleanup then fails with a message about the directory rather
 * than about the connection nobody closed.
 */
function withWritable<T>(path: string, body: (connection: SqliteDatabase) => T): T {
  const connection = new Database(path, { fileMustExist: true });
  try {
    return body(connection);
  } finally {
    connection.close();
  }
}

/** Read through the harness's read-only handle, and close it afterwards. */
function withMeasurement<T>(path: string, body: (connection: SqliteDatabase) => T): T {
  const connection = openForMeasurement(path);
  try {
    return body(connection);
  } finally {
    connection.close();
  }
}

function makeSubject(path: string, fields: { runId: string; sessionId: string }): void {
  withWritable(path, (connection) => {
    connection
      .prepare(
        "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'running', ?, ?)",
      )
      .run(fields.runId, T0, T0);
    connection
      .prepare(
        `INSERT INTO session (session_id, run_id, provider, binding_phase,
                              observation, provider_state, bound_at_ms)
         VALUES (?, ?, 'test', 'identity_confirmed', 'observed', 'running', ?)`,
      )
      .run(fields.sessionId, fields.runId, T0);
  });
}

function makeIncident(
  path: string,
  fields: { incidentId: string; runId: string; sessionId: string },
): void {
  withWritable(path, (connection) => {
    connection
      .prepare(
        `INSERT INTO incident (incident_id, run_id, session_id, fact_state,
                               detector_version, dedup_key, created_at_ms,
                               updated_at_ms)
         VALUES (?, ?, ?, 'NO_ACTIVITY_EVIDENCE', 'test-1', ?, ?, ?)`,
      )
      .run(fields.incidentId, fields.runId, fields.sessionId, `dedup/${fields.incidentId}`, T0, T0);
  });
}

function makeAction(
  path: string,
  fields: {
    actionId: string;
    status: string;
    createdAtMs: number;
    appliedAtMs?: number | null;
    runId?: string | null;
    incidentId?: string | null;
    kind?: string;
  },
): void {
  withWritable(path, (connection) => {
    connection
      .prepare(
        `INSERT INTO action (action_id, run_id, incident_id, kind,
                             idempotency_key, exactly_once_mechanism, status,
                             refusal_reason, created_at_ms, applied_at_ms)
         VALUES (?, ?, ?, ?, ?, 'human_gate', ?, ?, ?, ?)`,
      )
      .run(
        fields.actionId,
        fields.runId ?? null,
        fields.incidentId ?? null,
        fields.kind ?? TERMINATE_SESSION_KIND,
        `key/${fields.actionId}`,
        fields.status,
        fields.status === STATUS_REFUSED ? "declined at the human gate" : null,
        fields.createdAtMs,
        fields.appliedAtMs ?? null,
      );
  });
}

function appendActivity(
  path: string,
  fields: {
    eventId: string;
    subjectKind: string;
    subjectId: string;
    eventType: string;
    ingestedAtMs: number;
  },
): void {
  withWritable(path, (connection) => {
    connection
      .prepare(
        `INSERT INTO event (event_id, event_type, subject_kind, subject_id,
                            producer, dedup_key, occurred_at_ms, ingested_at_ms)
         VALUES (?, ?, ?, ?, 'test', ?, ?, ?)`,
      )
      .run(
        fields.eventId,
        fields.eventType,
        fields.subjectKind,
        fields.subjectId,
        `dedup/${fields.eventId}`,
        fields.ingestedAtMs,
        fields.ingestedAtMs,
      );
  });
}

/** The source's `measure` helper: open, measure, close. */
function measure(
  path: string,
  options: {
    fixtureLabels?: ReadonlyMap<string, string>;
    subsequentEvidence?: ReadonlyMap<string, string>;
    humanAdjudications?: ReadonlyMap<string, string>;
    periodStartMs?: number;
    periodEndMs?: number;
  } = {},
) {
  return withMeasurement(path, (connection) =>
    measureFalseTermination(connection, {
      periodStartMs: options.periodStartMs ?? PERIOD_START,
      periodEndMs: options.periodEndMs ?? PERIOD_END,
      nowMs: NOW_MS,
      fixtureLabels: options.fixtureLabels ?? new Map(),
      subsequentEvidence: options.subsequentEvidence ?? new Map(),
      humanAdjudications: options.humanAdjudications ?? new Map(),
    }),
  );
}

/** `read_terminate_actions` then `subsequent_activity_verdicts`, on one handle. */
function verdictsOver(
  path: string,
  options: { productiveEventTypes?: readonly string[]; periodEndMs?: number } = {},
): ReadonlyMap<string, string> {
  return withMeasurement(path, (connection) => {
    const actions = readTerminateActions(connection, {
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
    });
    return subsequentActivityVerdicts(connection, actions, {
      productiveEventTypes: options.productiveEventTypes ?? PRODUCTIVE,
      periodEndMs: options.periodEndMs ?? PERIOD_END,
    });
  });
}

// --------------------------------------------------------------------------
// the numerator: applied effects only
// --------------------------------------------------------------------------

describe("the numerator: applied effects only", () => {
  test("a recommendation that was not applied is not a false termination", () => {
    // The declined recommendation is in its own series and in neither rate
    // term. This is section 3.4's first error direction made concrete: the
    // declined row is labelled `not_stuck`, so a harness counting
    // recommendations would call it a false termination -- charging us for a
    // termination the human gate prevented, which is the gate's value showing
    // up as a defect.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    makeAction(db, {
      actionId: "a-declined",
      status: STATUS_REFUSED,
      createdAtMs: PERIOD_START + MINUTE_MS,
      runId: "r1",
    });
    makeAction(db, {
      actionId: "a-applied",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START + 2 * MINUTE_MS,
      appliedAtMs: PERIOD_START + 3 * MINUTE_MS,
      runId: "r1",
    });

    const report = measure(db, {
      fixtureLabels: new Map([
        ["a-declined", VERDICT_NOT_STUCK],
        ["a-applied", VERDICT_STUCK],
      ]),
    });

    expect(report.recommendedTerminate).toEqual(["a-applied", "a-declined"]);
    expect(report.declinedRefused).toEqual(["a-declined"]);
    expect(report.recommendedButNotApplied).toEqual(["a-declined"]);
    expect(report.appliedTerminate).toEqual(["a-applied"]);
    expect(report.falseTerminationIds).toEqual([]);
    expect(report.justifiedIds).toEqual(["a-applied"]);
    expect(
      report.adjudications.has("a-declined"),
      "a row outside the denominator is not adjudicated at all",
    ).toBe(false);
    expect(report.rateLower).toBe(0.0);

    const rendered = renderFalseTerminationReport(report);
    expect(rendered).toContain("INFORMATIVE, NOT alarming");
    expect(isAscii(rendered)).toBe(true);
  });

  test("a pending recommendation is reported separately from a declined one", () => {
    // "A human said no" and "nobody has looked yet" are different facts.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    makeAction(db, {
      actionId: "a-pending",
      status: STATUS_PENDING,
      createdAtMs: PERIOD_START + MINUTE_MS,
      runId: "r1",
    });
    makeAction(db, {
      actionId: "a-refused",
      status: STATUS_REFUSED,
      createdAtMs: PERIOD_START + MINUTE_MS,
      runId: "r1",
    });

    const report = measure(db);

    expect(report.stillPending).toEqual(["a-pending"]);
    expect(report.declinedRefused).toEqual(["a-refused"]);
    expect(new Set(report.recommendedButNotApplied)).toEqual(new Set(["a-pending", "a-refused"]));
    expect(report.appliedTerminate).toEqual([]);
    expect(
      report.rateLower,
      "a rate over an empty denominator is not zero; printing zero would " +
        "report 'we terminated nothing' as 'we never terminated wrongly'",
    ).toBeNull();
  });

  test("only the declared kind is counted", () => {
    // `action.kind` is unconstrained in the DDL, so the literal is a
    // declaration. An applied `restart_session` is an applied effect on the
    // same table with the same shape; counting it would put a remedy nobody
    // called a termination into the termination rate.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    makeAction(db, {
      actionId: "a-terminate",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START + MINUTE_MS,
      appliedAtMs: PERIOD_START + MINUTE_MS,
      runId: "r1",
    });
    makeAction(db, {
      actionId: "a-restart",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START + MINUTE_MS,
      appliedAtMs: PERIOD_START + MINUTE_MS,
      runId: "r1",
      kind: "restart_session",
    });

    const report = measure(db, { fixtureLabels: new Map([["a-terminate", VERDICT_STUCK]]) });

    expect(report.appliedTerminate).toEqual(["a-terminate"]);
    expect(QUERY_DEFINITIONS.get("terminate_session_kind")).toBe(TERMINATE_SESSION_KIND);
    expect(
      renderFalseTerminationReport(report),
      "the report says which literal it counted, because the schema does not",
    ).toContain(TERMINATE_SESSION_KIND);
  });

  test("the two cohorts are counted on their own instants", () => {
    // Recommended-in-period and applied-in-period are different sets, both
    // reported. A recommendation applied one millisecond after the period ends
    // is in this report's recommendation series and in the *next* report's
    // denominator; one carried over from the previous period is the mirror.
    // Both boundaries are driven to the instant, because a `<=` at either end
    // moves exactly one effect per report between a rate and a bucket.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    makeAction(db, {
      actionId: "a-later",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_END - MINUTE_MS,
      appliedAtMs: PERIOD_END,
      runId: "r1",
    });
    makeAction(db, {
      actionId: "a-earlier",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START - MINUTE_MS,
      appliedAtMs: PERIOD_START,
      runId: "r1",
    });

    const report = measure(db, { fixtureLabels: new Map([["a-earlier", VERDICT_STUCK]]) });

    expect(report.recommendedTerminate).toEqual(["a-later"]);
    expect(report.appliedAfterPeriodEnd).toEqual(["a-later"]);
    expect(report.appliedTerminate).toEqual(["a-earlier"]);
    expect(report.appliedFromEarlierRecommendation).toEqual(["a-earlier"]);
  });

  test("an action naming no incident still counts", () => {
    // The join onto `incident` is LEFT because `incident_id` is nullable. An
    // inner join would drop the row, shrinking the denominator and *raising*
    // the rate for a reason that has nothing to do with terminations being
    // wrong.
    const db = productionDb();
    makeAction(db, {
      actionId: "a-orphan",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START,
      appliedAtMs: PERIOD_START,
    });

    const report = measure(db);
    expect(report.appliedTerminate).toEqual(["a-orphan"]);

    const actions = withMeasurement(db, (connection) =>
      readTerminateActions(connection, {
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
      }),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]?.subjectKind).toBeNull();
    expect(actions[0]?.subjectId).toBeNull();
  });
});

// --------------------------------------------------------------------------
// the preference order
// --------------------------------------------------------------------------

describe("the preference order", () => {
  test("the fixture label wins when it disagrees with subsequent evidence", () => {
    // Constructed disagreement: label says stuck, the subject's behaviour says
    // not. Only a disagreement can distinguish a preference order from a
    // coincidence. The winner is asserted against `GROUND_TRUTH_PREFERENCE[0]`
    // rather than against the string, so the test binds to the module's
    // declared order instead of restating it, and the overruled source is
    // asserted to be *recorded* -- discarding it would hide a mislabelled
    // fixture or a detector writing evidence it should not.
    const verdict = adjudicate({
      actionId: "a",
      fixtureLabels: new Map([["a", VERDICT_STUCK]]),
      subsequentEvidence: new Map([["a", VERDICT_NOT_STUCK]]),
      humanAdjudications: new Map([["a", VERDICT_NOT_STUCK]]),
    });

    expect(verdict.verdict).toBe(VERDICT_STUCK);
    expect(verdict.source).toBe(GROUND_TRUTH_PREFERENCE[0]);
    expect(verdict.source).toBe(SOURCE_FIXTURE_LABEL);
    expect(verdict.overruled).toEqual([
      [SOURCE_SUBSEQUENT_EVIDENCE, VERDICT_NOT_STUCK],
      [SOURCE_HUMAN_ADJUDICATION, VERDICT_NOT_STUCK],
    ]);
  });

  test("the second source decides when the first is silent", () => {
    // A source with no opinion is absent from its map, and the next one
    // decides.
    const verdict = adjudicate({
      actionId: "a",
      fixtureLabels: new Map(),
      subsequentEvidence: new Map([["a", VERDICT_NOT_STUCK]]),
      humanAdjudications: new Map([["a", VERDICT_STUCK]]),
    });

    expect(verdict.source).toBe(GROUND_TRUTH_PREFERENCE[1]);
    expect(verdict.source).toBe(SOURCE_SUBSEQUENT_EVIDENCE);
    expect(verdict.verdict).toBe(VERDICT_NOT_STUCK);
    expect(verdict.overruled).toEqual([[SOURCE_HUMAN_ADJUDICATION, VERDICT_STUCK]]);
  });

  test("human adjudication is the last resort and still decides", () => {
    // It is third, not absent: without it the case would be undetermined.
    const verdict = adjudicate({
      actionId: "a",
      fixtureLabels: new Map(),
      subsequentEvidence: new Map(),
      humanAdjudications: new Map([["a", VERDICT_NOT_STUCK]]),
    });

    expect(verdict.source).toBe(GROUND_TRUTH_PREFERENCE[2]);
    expect(verdict.source).toBe(SOURCE_HUMAN_ADJUDICATION);
    expect(verdict.verdict).toBe(VERDICT_NOT_STUCK);
    expect(verdict.overruled).toEqual([]);
  });

  test("an agreeing lower source is not recorded as overruled", () => {
    // `overruled` holds disagreement, not every source that spoke.
    const verdict = adjudicate({
      actionId: "a",
      fixtureLabels: new Map([["a", VERDICT_NOT_STUCK]]),
      subsequentEvidence: new Map([["a", VERDICT_NOT_STUCK]]),
      humanAdjudications: new Map(),
    });

    expect(verdict.overruled).toEqual([]);
  });

  test("a verdict outside the closed set is refused", () => {
    // Including the word `undetermined`, which is an outcome and not an input.
    // Accepting it as an input would let a source that cannot decide *prevent*
    // a lower-preference source that could.
    expectRefusal(
      () =>
        adjudicate({
          actionId: "a",
          fixtureLabels: new Map([["a", "probably"]]),
          subsequentEvidence: new Map(),
          humanAdjudications: new Map(),
        }),
      UnknownGroundTruthVerdict,
    );
    expectRefusal(
      () =>
        adjudicate({
          actionId: "a",
          fixtureLabels: new Map([["a", VERDICT_UNDETERMINED]]),
          subsequentEvidence: new Map(),
          humanAdjudications: new Map([["a", VERDICT_NOT_STUCK]]),
        }),
      UnknownGroundTruthVerdict,
    );
  });
});

// --------------------------------------------------------------------------
// undetermined
// --------------------------------------------------------------------------

describe("undetermined", () => {
  test("undetermined is reachable, counted, and opens the rate gap", () => {
    // Two applied terminations, one settled false and one settled by nothing.
    // The undetermined row moves neither bound on its own: the lower rate
    // counts the confirmed false termination alone, the upper counts what the
    // undetermined row could turn out to be, and the gap between them is
    // exactly the ground truth this report does not have.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    makeAction(db, {
      actionId: "a-false",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START,
      appliedAtMs: PERIOD_START + MINUTE_MS,
      runId: "r1",
    });
    makeAction(db, {
      actionId: "a-unknown",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START,
      appliedAtMs: PERIOD_START + MINUTE_MS,
      runId: "r1",
    });

    const report = measure(db, {
      fixtureLabels: new Map([["a-false", VERDICT_NOT_STUCK]]),
    });

    expect(report.falseTerminationIds).toEqual(["a-false"]);
    expect(report.undeterminedIds).toEqual(["a-unknown"]);
    expect(report.justifiedIds).toEqual([]);
    expect(report.adjudications.get("a-unknown")?.source).toBe(SOURCE_NONE);
    expect(report.rateLower).toBe(0.5);
    expect(report.rateUpper).toBe(1.0);
    expect(report.rateIsSettled).toBe(false);

    const rendered = renderFalseTerminationReport(report);
    expect(rendered).toContain("undetermined");
    expect(rendered).toContain("1 undetermined termination(s)");
  });

  test("the bounds coincide when every applied row is settled", () => {
    // The gap exists only where ground truth is missing, and the report says
    // so.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    makeAction(db, {
      actionId: "a-false",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START,
      appliedAtMs: PERIOD_START,
      runId: "r1",
    });

    const report = measure(db, {
      fixtureLabels: new Map([["a-false", VERDICT_NOT_STUCK]]),
    });

    expect(report.rateLower).toBe(1.0);
    expect(report.rateUpper).toBe(1.0);
    expect(report.rateIsSettled).toBe(true);
    expect(renderFalseTerminationReport(report)).toContain("the two bounds coincide");
  });
});

// --------------------------------------------------------------------------
// the subsequent-evidence source
// --------------------------------------------------------------------------

describe("the subsequent-evidence source", () => {
  test("activity after the termination says the subject was not stuck", () => {
    // The evidence is looked for on the subject the *incident* names -- the
    // session -- and only after `appliedAtMs`: activity before the termination
    // is what every live session produces and says nothing about whether it was
    // stuck when the effect landed.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    makeIncident(db, { incidentId: "i1", runId: "r1", sessionId: "s1" });
    makeAction(db, {
      actionId: "a-resumed",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START,
      appliedAtMs: PERIOD_START + MINUTE_MS,
      runId: "r1",
      incidentId: "i1",
    });
    appendActivity(db, {
      eventId: "before",
      subjectKind: "session",
      subjectId: "s1",
      eventType: PRODUCTIVE[0],
      ingestedAtMs: PERIOD_START + MINUTE_MS - 1,
    });

    const before = verdictsOver(db);
    expect(Object.fromEntries(before), "activity BEFORE the termination settles nothing").toEqual(
      {},
    );

    appendActivity(db, {
      eventId: "after",
      subjectKind: "session",
      subjectId: "s1",
      eventType: PRODUCTIVE[0],
      ingestedAtMs: PERIOD_START + 2 * MINUTE_MS,
    });
    const after = verdictsOver(db);
    expect(Object.fromEntries(after)).toEqual({ "a-resumed": VERDICT_NOT_STUCK });

    const report = measure(db, { subsequentEvidence: after });
    expect(report.falseTerminationIds).toEqual(["a-resumed"]);
    expect(report.adjudications.get("a-resumed")?.source).toBe(SOURCE_SUBSEQUENT_EVIDENCE);
  });

  test("silence after a termination never says the subject was stuck", () => {
    // Absence of evidence is not evidence (interlock D-0006). A terminated
    // session produces nothing *because* it was terminated. If silence counted
    // as confirmation, every termination would justify itself and the rate
    // would be zero by construction -- so the source declines, and the row
    // reaches the undetermined bucket instead.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    makeIncident(db, { incidentId: "i1", runId: "r1", sessionId: "s1" });
    makeAction(db, {
      actionId: "a-silent",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START,
      appliedAtMs: PERIOD_START + MINUTE_MS,
      runId: "r1",
      incidentId: "i1",
    });

    const verdicts = verdictsOver(db);

    expect(Object.fromEntries(verdicts)).toEqual({});
    const report = measure(db, { subsequentEvidence: verdicts });
    expect(report.undeterminedIds).toEqual(["a-silent"]);
  });

  test("an undeclared event type is not productive activity", () => {
    // The declared set is the whole definition; an event outside it clears
    // nothing. Without the restriction the termination's own bookkeeping event
    // would clear the termination that produced it.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    makeIncident(db, { incidentId: "i1", runId: "r1", sessionId: "s1" });
    makeAction(db, {
      actionId: "a",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START,
      appliedAtMs: PERIOD_START + MINUTE_MS,
      runId: "r1",
      incidentId: "i1",
    });
    appendActivity(db, {
      eventId: "bookkeeping",
      subjectKind: "session",
      subjectId: "s1",
      eventType: "session_terminated",
      ingestedAtMs: PERIOD_START + 2 * MINUTE_MS,
    });

    expect(Object.fromEntries(verdictsOver(db))).toEqual({});
  });

  test("declaring no productive event type is refused", () => {
    // An empty set disables a ground-truth source without recording that it
    // did.
    const db = productionDb();
    withMeasurement(db, (connection) => {
      expectRefusal(
        () =>
          subsequentActivityVerdicts(connection, [], {
            productiveEventTypes: [],
            periodEndMs: PERIOD_END,
          }),
        FalseTerminationRefusal,
      );
    });
  });

  test("evidence arriving after the period belongs to the next report", () => {
    // The answer is a function of the period, so a printed figure stays true.
    // Activity ingested at exactly `periodEndMs` is outside this report
    // (half-open, time-base-policy.md section 2 rule 4) and must not change a
    // verdict this report already published.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    makeIncident(db, { incidentId: "i1", runId: "r1", sessionId: "s1" });
    makeAction(db, {
      actionId: "a",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START,
      appliedAtMs: PERIOD_START + MINUTE_MS,
      runId: "r1",
      incidentId: "i1",
    });
    appendActivity(db, {
      eventId: "just_after",
      subjectKind: "session",
      subjectId: "s1",
      eventType: PRODUCTIVE[0],
      ingestedAtMs: PERIOD_END,
    });

    const inside = verdictsOver(db);
    const later = verdictsOver(db, { periodEndMs: PERIOD_END + DAY_MS });

    expect(Object.fromEntries(inside)).toEqual({});
    expect(Object.fromEntries(later)).toEqual({ a: VERDICT_NOT_STUCK });
  });

  test("a pending recommendation has no subsequent evidence to read", () => {
    // Nothing was terminated, so there is no "after" for activity to follow.
    // Its subject is running for reasons that have nothing to do with a
    // termination that never happened, and reading its activity as `not_stuck`
    // would file a verdict about an effect the organisation declined to apply.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    makeIncident(db, { incidentId: "i1", runId: "r1", sessionId: "s1" });
    makeAction(db, {
      actionId: "a-pending",
      status: STATUS_PENDING,
      createdAtMs: PERIOD_START,
      runId: "r1",
      incidentId: "i1",
    });
    appendActivity(db, {
      eventId: "busy",
      subjectKind: "session",
      subjectId: "s1",
      eventType: PRODUCTIVE[0],
      ingestedAtMs: PERIOD_START + MINUTE_MS,
    });

    expect(Object.fromEntries(verdictsOver(db))).toEqual({});
  });
});

// --------------------------------------------------------------------------
// the report itself
// --------------------------------------------------------------------------

describe("the report itself", () => {
  test("an empty or inverted period is refused", () => {
    const db = productionDb();
    withMeasurement(db, (connection) => {
      expectRefusal(
        () =>
          measureFalseTermination(connection, {
            periodStartMs: PERIOD_END,
            periodEndMs: PERIOD_START,
            nowMs: NOW_MS,
            fixtureLabels: new Map(),
            subsequentEvidence: new Map(),
            humanAdjudications: new Map(),
          }),
        FalseTerminationRefusal,
      );
    });
  });

  test("the rendered rate goes through formatFixed, not toFixed (target-only)", () => {
    // Target-only: this translates no source case and is not counted as ported
    // coverage. It is a LIVENESS test for D-0104, added because a mutation
    // sweep found the property unguarded: swapping `formatFixed` for
    // `toFixed` in the `percent` helper left all twenty ported cases green.
    //
    // The fixed-format oracle (test/measurement/format.test.ts) proves
    // `formatFixed` is right. It cannot prove that *this module calls it* --
    // and a rendering that quietly used `toFixed` would print a different
    // report from interlock's on exactly the inputs nobody looks at.
    //
    // 1 false termination out of 32 applied is 3.125 percent, which is an
    // exact tie at two decimal places and therefore one of the inputs the two
    // formatters disagree on: CPython rounds half to even and prints "3.12",
    // `toFixed` rounds half away from zero and prints "3.13". 32 is the
    // smallest denominator that reaches a tie without a slow fixture.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    for (let index = 0; index < 32; index += 1) {
      makeAction(db, {
        actionId: `a-${String(index).padStart(2, "0")}`,
        status: STATUS_APPLIED,
        createdAtMs: PERIOD_START,
        appliedAtMs: PERIOD_START + MINUTE_MS,
        runId: "r1",
      });
    }

    const report = measure(db, {
      // One false, the other thirty-one justified, so both bounds are the same
      // tie and neither line can pass by being "not computable".
      fixtureLabels: new Map([
        ["a-00", VERDICT_NOT_STUCK],
        ...Array.from({ length: 31 }, (_, index): [string, string] => [
          `a-${String(index + 1).padStart(2, "0")}`,
          VERDICT_STUCK,
        ]),
      ]),
    });

    expect(report.appliedTerminate).toHaveLength(32);
    expect(report.rateLower).toBe(1 / 32);
    expect(report.rateUpper).toBe(1 / 32);

    const rendered = renderFalseTerminationReport(report);
    expect(rendered).toContain("3.12 percent");
    expect(rendered).not.toContain("3.13 percent");
    // Named explicitly so a failure says which formatter it got, rather than
    // only that a substring was missing.
    expect(((1 / 32) * 100).toFixed(2), "the tie toFixed gets wrong").toBe("3.13");
  });

  test("the report is immutable at runtime, as the source's is (target-only)", () => {
    // Target-only: translates no source case, because in Python there is
    // nothing to assert -- the fields ARE tuples and a MappingProxyType, and
    // mutating one raises. In TypeScript `readonly` is erased at runtime and
    // `Object.freeze(this)` is shallow, so the same property has to be built
    // and therefore has to be pinned.
    //
    // It matters beyond tidiness here: the five id lists are a PARTITION of the
    // denominator. Push one id into `appliedTerminate` and the rate no longer
    // describes the itemisation printed beside it, and nothing notices.
    const db = productionDb();
    makeSubject(db, { runId: "r1", sessionId: "s1" });
    makeAction(db, {
      actionId: "a-applied",
      status: STATUS_APPLIED,
      createdAtMs: PERIOD_START,
      appliedAtMs: PERIOD_START,
      runId: "r1",
    });
    const report = measure(db, {
      fixtureLabels: new Map([["a-applied", VERDICT_NOT_STUCK]]),
    });

    // The casts are what an untyped JavaScript consumer reaches with; the
    // `readonly` types already stop typed code.
    expect(() => (report.appliedTerminate as string[]).push("forged")).toThrow(TypeError);
    expect(() => (report.falseTerminationIds as string[]).push("forged")).toThrow(TypeError);
    expect(() => (report.recommendedTerminate as string[]).pop()).toThrow(TypeError);
    expect(report.appliedTerminate).toEqual(["a-applied"]);

    // The adjudications mapping is MappingProxyType's equivalent: the mutators
    // are absent, so reaching for one fails at the call rather than quietly
    // editing a published report.
    const adjudications = report.adjudications as unknown as {
      set?: unknown;
      delete?: unknown;
      clear?: unknown;
    };
    expect(adjudications.set).toBeUndefined();
    expect(adjudications.delete).toBeUndefined();
    expect(adjudications.clear).toBeUndefined();
    expect(report.adjudications.get("a-applied")?.verdict).toBe(VERDICT_NOT_STUCK);

    // ...and the nested Adjudication, whose `overruled` is a tuple in the
    // source.
    const decision = report.adjudications.get("a-applied");
    expect(decision).toBeDefined();
    const overruled = decision?.overruled as [string, string][] | undefined;
    expect(overruled).toBeDefined();
    expect(() => (overruled as [string, string][]).push(["forged", VERDICT_STUCK])).toThrow(
      TypeError,
    );

    // Copied, not merely frozen in place: mutating the array the caller passed
    // in must not reach inside the report either.
    const labels = ["a-applied"];
    const other = new FalseTerminationReport({
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      generatedAtMs: NOW_MS,
      recommendedTerminate: labels,
      declinedRefused: [],
      stillPending: [],
      appliedAfterPeriodEnd: [],
      appliedFromEarlierRecommendation: [],
      appliedTerminate: [],
      falseTerminationIds: [],
      justifiedIds: [],
      undeterminedIds: [],
      adjudications: new Map(),
    });
    labels.push("added afterwards");
    expect(other.recommendedTerminate).toEqual(["a-applied"]);

    // An Adjudication handed in as a plain object literal is normalised too:
    // `readOnlyMap` copies the map STRUCTURE, so without this a caller could
    // still rewrite the evidence a published report renders.
    const supplied = {
      actionId: "a-supplied",
      verdict: VERDICT_STUCK,
      source: SOURCE_FIXTURE_LABEL,
      overruled: [[SOURCE_HUMAN_ADJUDICATION, VERDICT_NOT_STUCK]] as [string, string][],
    };
    const third = new FalseTerminationReport({
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      generatedAtMs: NOW_MS,
      recommendedTerminate: [],
      declinedRefused: [],
      stillPending: [],
      appliedAfterPeriodEnd: [],
      appliedFromEarlierRecommendation: [],
      appliedTerminate: ["a-supplied"],
      falseTerminationIds: [],
      justifiedIds: ["a-supplied"],
      undeterminedIds: [],
      adjudications: new Map([["a-supplied", supplied]]),
    });
    const stored = third.adjudications.get("a-supplied");
    expect(stored).toBeDefined();
    expect(() => {
      (stored as { source: string }).source = "forged";
    }).toThrow(TypeError);
    const storedOverruled = stored === undefined ? undefined : stored.overruled;
    expect(storedOverruled).toBeDefined();
    expect(() => (storedOverruled as [string, string][]).push(["forged", VERDICT_STUCK])).toThrow(
      TypeError,
    );
    expect(third.adjudications.get("a-supplied")?.source).toBe(SOURCE_FIXTURE_LABEL);

    // The exported query catalogue is MappingProxyType upstream, and downstream
    // reports quote it to say what was measured.
    const catalogue = QUERY_DEFINITIONS as unknown as { set?: unknown };
    expect(catalogue.set).toBeUndefined();
  });

  test("the report states what it does not count", () => {
    // Both error directions of section 3.4 are named in the rendering itself.
    // A reader who never opens this module has to be able to see that AI
    // recommendations and watcher candidates are excluded on purpose, and why.
    const db = productionDb();
    const report = measure(db);
    const rendered = renderFalseTerminationReport(report);

    expect(rendered).toContain("D-0004");
    expect(rendered).toContain("AC-6");
    expect(rendered).toContain("watcher candidates");
    expect(rendered).toContain(GROUND_TRUTH_PREFERENCE.join(" > "));
    expect(
      isAscii(rendered),
      "the report reaches a cp932 console; a single em-dash would raise " +
        "UnicodeEncodeError there",
    ).toBe(true);
  });
});

describe("a deliberate divergence from interlock (target-only)", () => {
  test("an action id cannot forge a line of the itemisation", () => {
    // Target-only, and `D-0109`. `action.action_id` is unconstrained TEXT in
    // the DDL, and interlock interpolates it into the itemisation raw -- so an
    // id spelling a newline plus spaces produces a line a reader cannot tell
    // from one the harness wrote. Raised on the false-termination belt, ruled
    // "reproduce and disclose" on 2026-08-22 under `D-0022`, and repaired here
    // when that rule was withdrawn: interlock is frozen, so the defect would
    // otherwise be permanent.
    const forged = "a1\n      justified: 999";
    expect(reportValue(forged)).toBe("a1\\u000a      justified: 999");
    expect(reportValue(forged).includes("\n")).toBe(false);
    // Non-ASCII goes the same way, so the renderer's own ASCII claim now covers
    // the values it prints and not only the words it authors.
    expect(reportValue("\u65e5\u672c\u8a9e")).toBe("\\u65e5\\u672c\\u8a9e");
    expect(isAscii(reportValue("\u2014"))).toBe(true);
  });
});
