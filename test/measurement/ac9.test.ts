/**
 * AC-9's numerator taken apart: the unit, the imputations, and the four figures.
 *
 * Ported from interlock `tests/measurement/test_ac9.py` at `65f36c5`. Every case
 * here maps to one source node id; the mapping, and the case inherited from the
 * provenance belt's ledger, are recorded in
 * `parity/measurement.ac9.ledger.json`.
 *
 * `docs/measurement-harness.md` sections 2.2 and 2.4 describe a measurement
 * that can be wrong in several directions while looking entirely reasonable, so
 * the cases here are built to *separate* those directions rather than to
 * exercise the happy path. A cohort where invocations, model responses and
 * attempts all happen to be equal would pass under every wrong reading of the
 * numerator, which is the defect and not the fixture.
 *
 * Three of the tests are the load-bearing ones:
 *
 * * the numerator test builds a population where the three candidate units
 *   differ and asserts the exact value of each, so counting the wrong one
 *   cannot be green;
 * * the bound test constructs data whose *true* token total is known to the
 *   test and unknown to the harness, and asserts the ordering
 *   `bounded <= true < sensitivity` -- the p95 imputation sitting **below** the
 *   truth is precisely the failure section 2.4 says was made on the first pass,
 *   and a test that only checked "sensitivity is printed" would not see it. The
 *   true figure is obtained by measuring a second database through the same
 *   function rather than by arithmetic pasted into the test;
 * * the verdict test greps the module's own rendered output, so a pass/fail
 *   string added anywhere in it fails here rather than at a design review.
 *
 * Every invocation is written through `control_plane/ai_invocation`, never by
 * hand-written SQL: a test that inserts its own rows is testing a copy of the
 * writer's rules, and the placeholder `model_response_count` this suite cares
 * about is the writer's behaviour and not the DDL's.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import {
  completeInvocation,
  ProviderUsage,
  startInvocation,
} from "../../src/control_plane/ai_invocation.js";
import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import { effectiveRevisionId } from "../../src/control_plane/policy.js";
import {
  type Ac9Report,
  BaselineRefused,
  FigureExceedsExactRangeRefused,
  KIND_ASSUMPTION,
  KIND_LOWER_BOUND,
  MeasuredBaseline,
  measureAc9,
  OUTPUT_TOKEN_REDUCTION_TARGET,
  PROMPT_REDUCTION_TARGET,
  renderAc9Report,
  UnknownUsageStatusInLedgerRefused,
  V1_MEASURED_BASELINE,
} from "../../src/measurement/ac9.js";
import { selectCohort } from "../../src/measurement/cohort.js";
import { formatFixed, isAscii } from "../../src/measurement/format.js";
import {
  buildHeader,
  type CoverageSummary,
  coverageFromAc9,
  FixtureSuiteRef,
  type ImputationRule,
  imputationFromAc9,
  type ReportHeader,
  renderHeaderJson,
} from "../../src/measurement/provenance.js";
import { openForMeasurement } from "../../src/measurement/reader.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const PERIOD_START = T0;
const PERIOD_END = T0 + DAY_MS;
const NOW = PERIOD_END + 1;

const ADAPTER = "anthropic-adapter/3";
const PROVIDER = "anthropic";
const MODEL = "some-model";
const CAP = 1_024;

// --------------------------------------------------------------------------
// helpers -- the smallest legal surroundings an invocation needs
// --------------------------------------------------------------------------

/** The source's `db` fixture, as a per-test call (rule 8). */
function productionDb(name = "production.sqlite3"): string {
  const path = join(caseRoot("ac9"), name);
  createProductionControlPlane(path, { nowMs: T0 }).close();
  return path;
}

/**
 * An ordinary writable connection, deliberately separate from the harness's.
 *
 * The measurement handle cannot write, which is the point of it; every row
 * these tests need therefore arrives through a second connection that can.
 */
function withWriter<T>(path: string, body: (connection: SqliteDatabase) => T): T {
  const connection = new Database(path, { fileMustExist: true });
  try {
    return body(connection);
  } finally {
    connection.close();
  }
}

/** A run whose entire lifetime lies inside the period: cohort membership. */
function addCohortRun(cp: SqliteDatabase, runId: string): string {
  cp.prepare(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'completed', ?, ?)",
  ).run(runId, PERIOD_START + 1, PERIOD_START + 2);
  return runId;
}

function addIncident(cp: SqliteDatabase, incidentId: string, runId: string): string {
  cp.prepare(
    `
        INSERT INTO incident (incident_id, run_id, session_id, fact_state,
                              detector_version, dedup_key, created_at_ms,
                              updated_at_ms)
        VALUES (?, ?, NULL, 'stalled', 'd1', ?, ?, ?)
        `,
  ).run(incidentId, runId, `dedup/${incidentId}`, T0, T0);
  return incidentId;
}

/**
 * One invocation, written through the real writer.
 *
 * `finish: false` leaves the row as `startInvocation` wrote it --
 * `finished_at_ms IS NULL` and the request-time placeholder
 * `model_response_count = 1` -- which is the shape the report has to itemise
 * rather than impute.
 */
function invoke(
  cp: SqliteDatabase,
  invocationId: string,
  fields: {
    readonly runId: string | null;
    readonly incidentId: string | null;
    readonly usageStatus?: string;
    readonly outputTokens?: number;
    readonly inputTokens?: number | null;
    readonly cacheReadTokens?: number | null;
    readonly maxOutputTokens?: number | null;
    readonly modelResponseCount?: number;
    readonly attemptCount?: number;
    readonly finish?: boolean;
  },
): string {
  startInvocation(cp, {
    invocationId,
    provider: PROVIDER,
    model: MODEL,
    adapterVersion: ADAPTER,
    startedAtMs: PERIOD_START + 10,
    incidentId: fields.incidentId,
    runId: fields.runId,
    maxOutputTokens: fields.maxOutputTokens === undefined ? CAP : fields.maxOutputTokens,
  });
  if (fields.finish === false) {
    return invocationId;
  }
  const usageStatus = fields.usageStatus ?? "reported";
  let usage: ProviderUsage;
  if (usageStatus === "reported") {
    usage = ProviderUsage.reported({
      adapterVersion: ADAPTER,
      outputTokens: fields.outputTokens as number,
      inputTokens: fields.inputTokens ?? null,
      cacheReadTokens: fields.cacheReadTokens ?? null,
    });
  } else if (usageStatus === "partial") {
    usage = ProviderUsage.partial({
      adapterVersion: ADAPTER,
      inputTokens: fields.inputTokens ?? null,
      cacheReadTokens: fields.cacheReadTokens ?? null,
    });
  } else {
    usage = ProviderUsage.unavailable({ adapterVersion: ADAPTER });
  }
  completeInvocation(cp, {
    invocationId,
    usage,
    modelResponseCount: fields.modelResponseCount ?? 1,
    attemptCount: fields.attemptCount ?? 1,
    finishedAtMs: PERIOD_START + 20,
  });
  return invocationId;
}

/** Select the cohort and measure it, through the read-only handle. */
function measure(path: string, options: { readonly baseline?: MeasuredBaseline } = {}): Ac9Report {
  const connection = openForMeasurement(path);
  try {
    const cohort = selectCohort(connection, {
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      nowMs: NOW,
    });
    return measureAc9(connection, cohort, {
      nowMs: NOW,
      ...(options.baseline === undefined ? {} : { baseline: options.baseline }),
    });
  } finally {
    connection.close();
  }
}

// --------------------------------------------------------------------------
// section 2.2 -- the unit, wrong in both directions
// --------------------------------------------------------------------------

describe("section 2.2 -- the unit, wrong in both directions", () => {
  test("the numerator sums model responses, not invocations and not attempts", () => {
    // The three candidate units are made to differ on purpose. Counting the
    // invocation overstates the reduction by the tool-use factor; counting
    // attempts reports a flaky network as AI workload; only the response count
    // is on the same basis as the baseline's 3,531 model responses.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      // one plain turn, one three-tool-round-trip invocation, one 429 + retry
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 10 });
      invoke(cp, "inv-2", {
        runId: "run-1",
        incidentId: "inc-1",
        outputTokens: 40,
        modelResponseCount: 4,
      });
      invoke(cp, "inv-3", {
        runId: "run-1",
        incidentId: "inc-1",
        outputTokens: 10,
        attemptCount: 2,
      });
    });

    const report = measure(path);

    expect(report.modelResponseTotal).toBe(6); // 1 + 4 + 1
    expect(report.invocationCount).toBe(3); // the AC-1 series, not the numerator
    expect(report.attemptTotal).toBe(4); // 1 + 1 + 2, and in no numerator
    // The three are genuinely distinct here, so a wrong unit cannot coincide
    // with the right one and pass.
    expect(
      new Set([report.modelResponseTotal, report.invocationCount, report.attemptTotal]).size,
    ).toBe(3);
  });

  test("a retry adds an attempt and no assistant turn", () => {
    // Section 2.2: a 429 followed by a successful retry produced ONE assistant
    // turn. attempt_count is the transport axis and stops there.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", {
        runId: "run-1",
        incidentId: "inc-1",
        outputTokens: 10,
        attemptCount: 7,
      });
    });

    const report = measure(path);

    expect(report.attemptTotal).toBe(7);
    expect(report.modelResponseTotal).toBe(1);
    // And the prompt figure is normalised from the responses, not the attempts:
    // one response over one cohort run is 100 per 100 runs, not 700.
    expect(report.modelResponsesPer100Runs).toBe(100.0);
  });

  test("an invocation with no incident is itemised as an AC-1 violation", () => {
    // AC-1 is "zero AI turns absent incidents". A count would say the assertion
    // broke and nothing about where; the id is the evidence (section 2.2).
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-ok", { runId: "run-1", incidentId: "inc-1", outputTokens: 10 });
      invoke(cp, "inv-orphan", { runId: "run-1", incidentId: null, outputTokens: 10 });
    });

    const report = measure(path);

    expect(report.ac1Violations).toEqual(["inv-orphan"]);
    // Still counted: a violation is not excused from the numerator, or AC-9
    // would improve every time AC-1 broke.
    expect(report.modelResponseTotal).toBe(2);
    expect(renderAc9Report(report)).toContain("inv-orphan");
  });

  test("invocations of runs outside the cohort are not measured", () => {
    // The denominator and the numerator must count the same runs, which is the
    // whole argument of section 2.1.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-in");
      cp.prepare(
        "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES ('run-out', 'running', ?, ?)",
      ).run(PERIOD_START + 1, PERIOD_START + 2);
      addIncident(cp, "inc-1", "run-in");
      invoke(cp, "inv-in", { runId: "run-in", incidentId: "inc-1", outputTokens: 10 });
      invoke(cp, "inv-out", { runId: "run-out", incidentId: "inc-1", outputTokens: 999 });
    });

    const report = measure(path);

    expect(report.cohortSize).toBe(1);
    expect(report.invocationCount).toBe(1);
    expect(report.observedOutputTokens).toBe(10);
  });

  test("an invocation naming no run is counted apart and enters no rate", () => {
    // It cannot be attributed to a run cohort, so it is in no rate -- but "the
    // AI ran and we could not say for which run" is evidence, not an absence.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 10 });
      invoke(cp, "inv-loose", { runId: null, incidentId: "inc-1", outputTokens: 500 });
    });

    const report = measure(path);

    expect(report.unattributedInvocations).toBe(1);
    expect(report.invocationCount).toBe(1);
    expect(report.observedOutputTokens).toBe(10);
  });
});

// --------------------------------------------------------------------------
// section 2.4 -- coverage, and why a missing figure is never zero
// --------------------------------------------------------------------------

describe("section 2.4 -- coverage, and why a missing figure is never zero", () => {
  test("coverage is both counts and a percentage", () => {
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 10 });
      invoke(cp, "inv-2", { runId: "run-1", incidentId: "inc-1", outputTokens: 10 });
      invoke(cp, "inv-3", { runId: "run-1", incidentId: "inc-1", usageStatus: "unavailable" });
      invoke(cp, "inv-4", { runId: "run-1", incidentId: "inc-1", usageStatus: "partial" });
    });

    const report = measure(path);

    expect([report.coveredCount, report.invocationCount]).toEqual([2, 4]);
    expect(report.coverageRatio).toBe(0.5);
    const rendered = renderAc9Report(report);
    expect(rendered).toContain("2 of 4 invocations");
    expect(rendered).toContain("50.00 percent");
  });

  test("a missing usage record is never counted as zero tokens", () => {
    // Treating the missing row as 0 would leave bounded == observed. It is
    // imputed at the caller's own ceiling times the turns the invocation made.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
      invoke(cp, "inv-2", {
        runId: "run-1",
        incidentId: "inc-1",
        usageStatus: "unavailable",
        maxOutputTokens: 500,
        modelResponseCount: 2,
      });
    });

    const report = measure(path);

    expect(report.observedOutputTokens).toBe(100);
    expect(report.boundedOutputTokens).toBe(100 + 500 * 2);
    expect(report.boundedOutputTokens).not.toBe(report.observedOutputTokens);
    // A larger token total is a SMALLER reduction: the bound is on the safe side.
    expect(report.boundedReduction as number).toBeLessThan(report.observedReduction as number);
  });

  test("the ceiling is per request, so a multi-turn missing row is imputed at the product", () => {
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", {
        runId: "run-1",
        incidentId: "inc-1",
        usageStatus: "partial",
        maxOutputTokens: 300,
        modelResponseCount: 4,
      });
    });

    const report = measure(path);

    // Not 300: a four-turn invocation was allowed 300 output tokens per request.
    expect(report.boundedOutputTokens).toBe(1_200);
  });

  test("the bounded figure bounds the truth where the p95 does not", () => {
    // Section 2.4's first-pass error, made concrete. The covered sample is a
    // cluster of small responses; the invocation whose usage was lost is a
    // large one -- which is the correlation the section names, telemetry loss
    // going with exactly the long, truncated responses. The p95 of the covered
    // sample therefore lands BELOW the true value and the "conservative"
    // sensitivity figure reports a reduction better than the truth.
    const populate = (path: string, lost: boolean): void => {
      withWriter(path, (cp) => {
        addCohortRun(cp, "run-1");
        addIncident(cp, "inc-1", "run-1");
        for (let index = 0; index < 10; index += 1) {
          invoke(cp, `inv-small-${index}`, {
            runId: "run-1",
            incidentId: "inc-1",
            outputTokens: 100,
          });
        }
        if (lost) {
          invoke(cp, "inv-large", {
            runId: "run-1",
            incidentId: "inc-1",
            usageStatus: "unavailable",
            maxOutputTokens: 8_000,
          });
        } else {
          invoke(cp, "inv-large", {
            runId: "run-1",
            incidentId: "inc-1",
            outputTokens: 5_000,
            maxOutputTokens: 8_000,
          });
        }
      });
    };

    const path = productionDb();
    populate(path, true);
    const lost = measure(path);

    // The truth is measured by the same code over the same population with the
    // usage record present, rather than by arithmetic copied into the test.
    const truthPath = productionDb("truth.sqlite3");
    populate(truthPath, false);
    const truth = measure(truthPath);
    expect(truth.coverageIsComplete).toBe(true);

    expect(lost.coveredP95OutputTokens).toBe(100); // the small cluster
    expect(lost.sensitivityOutputTokens as number).toBeLessThan(truth.observedOutputTokens);
    expect(lost.boundedOutputTokens).toBeGreaterThan(truth.observedOutputTokens);

    // The ordering that matters: the bound never claims a better reduction than
    // the truth, and the sensitivity figure does.
    expect(lost.boundedReduction as number).toBeLessThanOrEqual(truth.observedReduction as number);
    expect(lost.sensitivityReduction as number).toBeGreaterThan(truth.observedReduction as number);
  });

  test("the p95 is the nearest-rank observed value", () => {
    // Nearest rank returns a value some invocation actually exhibited; an
    // interpolating definition would add a second assumption on top of the one
    // the sensitivity figure already is.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      for (let index = 0; index < 20; index += 1) {
        invoke(cp, `inv-${String(index).padStart(2, "0")}`, {
          runId: "run-1",
          incidentId: "inc-1",
          outputTokens: index + 1,
        });
      }
      invoke(cp, "inv-missing", {
        runId: "run-1",
        incidentId: "inc-1",
        usageStatus: "unavailable",
      });
    });

    const report = measure(path);

    // ceil(0.95 * 20) = 19, so the 19th of 1..20 ascending.
    expect(report.coveredP95OutputTokens).toBe(19);
  });

  test("an unbounded missing row disqualifies the acceptance claim", () => {
    // No ceiling was recorded at request time and no usage record arrived, so
    // there is nothing this row can honestly be bounded at.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
      invoke(cp, "inv-uncapped", {
        runId: "run-1",
        incidentId: "inc-1",
        usageStatus: "unavailable",
        maxOutputTokens: null,
      });
    });

    const report = measure(path);

    expect(report.unboundedMissing).toEqual(["inv-uncapped"]);
    expect(report.supportsAcceptanceClaim).toBe(false);
    // Nothing was invented for it: the bounded total is the covered total.
    expect(report.boundedOutputTokens).toBe(report.observedOutputTokens);
    const rendered = renderAc9Report(report);
    expect(rendered).toContain("CANNOT support an AC-9 acceptance claim");
    expect(rendered).toContain("inv-uncapped");
  });

  test("an unfinished row is itemised rather than imputed at the placeholder", () => {
    // startInvocation writes model_response_count = 1 as a REQUEST-TIME
    // placeholder. Imputing a killed four-turn invocation at cap * 1 would
    // bound it at a quarter of its ceiling -- understating Interlock's tokens
    // and overstating the reduction, which is the direction section 2.4
    // refuses.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
      invoke(cp, "inv-inflight", {
        runId: "run-1",
        incidentId: "inc-1",
        maxOutputTokens: 4_096,
        finish: false,
      });
    });

    const report = measure(path);

    expect(report.unconfirmedResponseCount).toEqual(["inv-inflight"]);
    expect(report.unboundedMissing).toEqual([]); // it HAS a ceiling; the count is the problem
    expect(report.boundedOutputTokens).toBe(100); // not 100 + 4096 * 1
    expect(report.supportsAcceptanceClaim).toBe(false);
    expect(renderAc9Report(report)).toContain("inv-inflight");
  });

  test("full coverage makes the four figures coincide, and the report says so", () => {
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
      invoke(cp, "inv-2", { runId: "run-1", incidentId: "inc-1", outputTokens: 200 });
    });

    const report = measure(path);

    expect(report.coverageRatio).toBe(1.0);
    expect(report.coverageIsComplete).toBe(true);
    expect(report.boundedOutputTokens).toBe(report.observedOutputTokens);
    expect(report.sensitivityOutputTokens).toBe(report.observedOutputTokens);
    expect(report.boundedReduction).toBe(report.observedReduction);
    expect(report.sensitivityReduction).toBe(report.observedReduction);
    expect(report.supportsAcceptanceClaim).toBe(true);
    expect(renderAc9Report(report)).toContain("coincide");
  });

  test("cache-read tokens move none of the AC-9 numbers", () => {
    // ACCEPTANCE.md section 5: a bandwidth indicator, "not new input tokens and
    // not a billing figure". At 1.4e9 in the baseline it would swamp every AC-9
    // figure it were added to.
    const populate = (path: string, cacheRead: number | null): void => {
      withWriter(path, (cp) => {
        addCohortRun(cp, "run-1");
        addIncident(cp, "inc-1", "run-1");
        invoke(cp, "inv-1", {
          runId: "run-1",
          incidentId: "inc-1",
          outputTokens: 100,
          inputTokens: 7,
          cacheReadTokens: cacheRead,
        });
      });
    };

    const path = productionDb();
    populate(path, null);
    const without = measure(path);

    const loudPath = productionDb("loud.sqlite3");
    populate(loudPath, 1_399_565_488);
    const withCache = measure(loudPath);

    expect(withCache.cacheReadTokensTotal).toBe(1_399_565_488);
    expect(without.cacheReadTokensTotal).toBe(0);
    // Every AC-9 figure is identical across the two.
    expect(withCache.observedOutputTokens).toBe(without.observedOutputTokens);
    expect(withCache.boundedOutputTokens).toBe(without.boundedOutputTokens);
    expect(withCache.sensitivityOutputTokens).toBe(without.sensitivityOutputTokens);
    expect(withCache.inputTokensTotal).toBe(7);
    expect(without.inputTokensTotal).toBe(7);
    expect(withCache.figures().map((figure) => figure.value)).toEqual(
      without.figures().map((figure) => figure.value),
    );
    expect(withCache.promptReduction).toBe(without.promptReduction);
  });
});

// --------------------------------------------------------------------------
// what the harness refuses to decide
// --------------------------------------------------------------------------

const VERDICT_WORDS: readonly string[] = [
  "pass",
  "passes",
  "passed",
  "passing",
  "fail",
  "fails",
  "failed",
  "failure",
  "go",
  "no-go",
  "nogo",
  "verdict",
  "accepted",
  "rejected",
  "green",
  "red",
];

describe("what the harness refuses to decide", () => {
  test("the rendered report carries no verdict word", () => {
    // Q-0005 (canary duration, sample size, numeric exit criteria) is open, and
    // ACCEPTANCE.md section 3 refuses to convert AC-9's targets into go/no-go
    // thresholds. A harness that printed a verdict would convert them by
    // inertia, so the prohibition is asserted against the rendered bytes rather
    // than against an intention.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
      invoke(cp, "inv-2", {
        runId: "run-1",
        incidentId: "inc-1",
        usageStatus: "unavailable",
        maxOutputTokens: null,
      });
      invoke(cp, "inv-3", { runId: "run-1", incidentId: null, finish: false });
    });

    const rendered = renderAc9Report(measure(path));

    const pattern = new RegExp(
      `\\b(${VERDICT_WORDS.map((word) => word.replace("-", "\\-")).join("|")})\\b`,
      "i",
    );
    expect(pattern.exec(rendered), String(rendered.match(new RegExp(pattern, "gi")))).toBeNull();
  });

  test("the rendered report is ASCII only", () => {
    // The cp932 console rule: one em-dash turns a report into a
    // UnicodeEncodeError on the terminal it is read from.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
    });

    const rendered = renderAc9Report(measure(path));

    expect(isAscii(rendered)).toBe(true);
  });

  test("the targets print as targets beside the cohort size", () => {
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addCohortRun(cp, "run-2");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
    });

    const rendered = renderAc9Report(measure(path));

    expect(rendered).toContain("Targets (targets, not thresholds; Q-0005 is open)");
    expect(rendered).toContain(`${formatFixed(PROMPT_REDUCTION_TARGET * 100, 2)} percent`);
    expect(rendered).toContain(`${formatFixed(OUTPUT_TOKEN_REDUCTION_TARGET * 100, 2)} percent`);
    // Every rate carries the cohort size: four figures plus the prompt half.
    expect(rendered.split("cohort size 2 runs").length - 1).toBe(5);
  });

  test("the four figures print together, each labelled with its kind", () => {
    // Section 2.4 makes the breakdown required output; there is deliberately no
    // accessor that returns a subset.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
      invoke(cp, "inv-2", { runId: "run-1", incidentId: "inc-1", usageStatus: "unavailable" });
    });

    const report = measure(path);
    const figures = report.figures();

    expect(figures.map((figure) => figure.label)).toEqual([
      "coverage",
      "observed output-token reduction",
      "bounded output-token reduction",
      "sensitivity output-token reduction",
    ]);
    expect(figures[2]?.kind).toBe(KIND_LOWER_BOUND);
    expect(figures[3]?.kind).toBe(KIND_ASSUMPTION);
    const rendered = renderAc9Report(report);
    for (const figure of figures) {
      expect(rendered).toContain(`${figure.label}:`);
      expect(rendered).toContain(figure.kind);
    }
    // The assumption is labelled where it appears AND restated in prose, since
    // section 2.4 requires it everywhere.
    expect(rendered).toContain("ASSUMPTION and NOT a bound");
  });

  test("an empty cohort computes no rate rather than a zero", () => {
    // No runs terminated inside the period. "Not computable" and "zero" are
    // different statements and only the first is true.
    const report = measure(productionDb());

    expect(report.cohortSize).toBe(0);
    expect(report.invocationCount).toBe(0);
    expect(report.coverageRatio).toBeNull();
    expect(report.coverageIsComplete).toBe(false);
    expect(report.figures().every((figure) => figure.value === null)).toBe(true);
    expect(renderAc9Report(report)).toContain("not computable");
  });
});

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

describe("refusals", () => {
  test("an unreadable usage status is refused rather than placed", () => {
    // The CHECK makes this unreachable through the schema, so the condition is
    // forged the same way the cohort belt forges an unknown run status: a
    // database written by a build with a wider vocabulary. Neither silent
    // answer is unbiased -- "covered" adds a row that contributed no tokens to
    // the coverage numerator, "missing" imputes over a figure that may be there.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
      cp.pragma("ignore_check_constraints = ON");
      cp.prepare("UPDATE ai_invocation SET usage_status = 'probably-fine'").run();
    });

    const refusal = expectRefusal(() => measure(path), UnknownUsageStatusInLedgerRefused);
    expect(refusal.message).toContain("probably-fine");
  });

  test("a baseline with no runs is refused", () => {
    // A reduction against a baseline of nothing is not a large number, it is no
    // number, and a division by zero downstream would print as infinity.
    expectRefusal(
      () =>
        new MeasuredBaseline({
          completedRuns: 0,
          modelResponses: 3531,
          outputTokens: 567_839,
          toolCalls: 4960,
          cacheReadTokens: 0,
          source: "a baseline over no runs",
        }),
      BaselineRefused,
    );
  });

  test("the shipped baseline is the measured one from ACCEPTANCE", () => {
    // If these drift from ACCEPTANCE.md section 5 the reduction is against a
    // number nobody measured.
    expect(V1_MEASURED_BASELINE.completedRuns).toBe(195);
    expect(V1_MEASURED_BASELINE.modelResponses).toBe(3531);
    expect(V1_MEASURED_BASELINE.outputTokens).toBe(567_839);
    // 4,960 tool calls is section 2.2's first error direction: carried, and
    // used in no arithmetic.
    expect(V1_MEASURED_BASELINE.toolCalls).toBe(4960);
  });

  test("measuring writes nothing", () => {
    // The read-only capability is the reader's, but a module that tried to
    // write would still be a defect, and the file's bytes are how that is
    // proved.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
    });

    const before = readFileSync(path);
    renderAc9Report(measure(path));
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// the case deferred from the provenance belt
// --------------------------------------------------------------------------

describe("the adapters onto the provenance header", () => {
  test("coverage and imputation come off the real AC-9 report", () => {
    // Carried here from tests/measurement/test_provenance.py, which is where
    // interlock keeps it: it is an INTEGRATION case, and the thing it
    // integrates with -- measureAc9 -- did not exist when the provenance belt
    // ran. parity/measurement.provenance.ledger.json records it as not-ported
    // with this file named as its destination.
    //
    // The two AC-9 blocks are copied from the report, never recounted. Built
    // through selectCohort and measureAc9 so that a change in what AC-9 calls
    // covered reaches this header without anyone editing it -- and so that
    // unbounded_missing on the header is the same number section 2.4 calls
    // disqualifying.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
      // A second invocation with no ceiling: un-imputable, so section 2.4's
      // unbounded_missing is non-zero and the header must say the report cannot
      // support an acceptance claim.
      startInvocation(cp, {
        invocationId: "inv-2",
        provider: PROVIDER,
        model: MODEL,
        adapterVersion: ADAPTER,
        startedAtMs: PERIOD_START + 40,
        incidentId: "inc-1",
        runId: "run-1",
      });
      cp.prepare("UPDATE ai_invocation SET finished_at_ms = ? WHERE invocation_id = 'inv-2'").run(
        PERIOD_START + 50,
      );
    });

    const connection = openForMeasurement(path);
    let header: ReportHeader;
    let coverage: CoverageSummary;
    let imputation: ImputationRule;
    try {
      const selected = selectCohort(connection, {
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        nowMs: NOW,
      });
      const report = measureAc9(connection, selected, { nowMs: NOW });

      coverage = coverageFromAc9(report, selected);
      imputation = imputationFromAc9(report);
      expect(coverage.covered).toBe(report.coveredCount);
      expect(coverage.total).toBe(report.invocationCount);
      expect(Object.fromEntries(coverage.excluded)).toEqual(
        Object.fromEntries(selected.excludedCounts()),
      );
      expect(imputation.unboundedMissing).toBe(report.unboundedMissing.length);
      expect(imputation.unboundedMissing).toBeGreaterThan(0);
      expect(imputation.supportsAcceptanceClaim).toBe(false);

      header = buildHeader(connection, {
        dbPath: path,
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        generatedAtMs: NOW,
        policyRevisionId: effectiveRevisionId(connection, { nowMs: PERIOD_START }),
        fingerprintTables: ["incident", "ai_invocation", "run"],
        queryDefinitions: new Map([["caller_incidents", "SELECT count(*) FROM incident"]]),
        fixtureSuite: FixtureSuiteRef.absent("no recall in this report"),
        imputation,
        coverage,
        censored: 0,
        censoredLeft: 0,
        unmatched: new Map(),
      });
    } finally {
      connection.close();
    }

    const document = JSON.parse(renderHeaderJson(header)) as {
      coverage: Record<string, unknown>;
    };
    expect(new Set(Object.keys(document.coverage))).toEqual(
      new Set(["covered", "total", "ratio", "excluded"]),
    );
  });
});

// --------------------------------------------------------------------------
// properties the ported cases leave unguarded (target-only)
// --------------------------------------------------------------------------

describe("properties the ported cases leave unguarded (target-only)", () => {
  // Eleven properties a 32-mutation sweep found unguarded. Each was confirmed
  // INHERITED by applying the same mutation to interlock's own ac9.py at
  // 65f36c5 and watching its 23 cases stay green.

  test("the p95 is nearest rank at a sample size where rounding disagrees", () => {
    // The ported case uses 20 covered values, where ceil(0.95*20) = 19 and
    // round(0.95*20) = 19 as well -- so an interpolating or rounding definition
    // passes it. At 11 values the two part company: ceil(10.45) = 11 and
    // round(10.45) = 10, and only the nearest-rank answer is a value some
    // invocation actually exhibited at that rank.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      for (let index = 1; index <= 11; index += 1) {
        invoke(cp, `inv-${String(index).padStart(2, "0")}`, {
          runId: "run-1",
          incidentId: "inc-1",
          outputTokens: index,
        });
      }
      invoke(cp, "inv-missing", {
        runId: "run-1",
        incidentId: "inc-1",
        usageStatus: "unavailable",
      });
    });

    expect(measure(path).coveredP95OutputTokens).toBe(11);
  });

  test("a cohort with no covered row has no p95 and no sensitivity figure", () => {
    // The ported empty-cohort case reaches the same `null` through a different
    // door -- with no runs, every per-100 figure is null anyway -- so a p95 that
    // returned 0 for an empty sample passes it. Here the cohort is real and the
    // ledger is entirely uncovered: "no covered sample, so no p95" is the true
    // statement, and 0 would make the sensitivity figure a measurement.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", {
        runId: "run-1",
        incidentId: "inc-1",
        usageStatus: "unavailable",
      });
    });

    const report = measure(path);
    expect(report.cohortSize).toBe(1);
    expect(report.coveredCount).toBe(0);
    expect(report.coveredP95OutputTokens).toBeNull();
    expect(report.sensitivityOutputTokens).toBeNull();
    expect(report.sensitivityReduction).toBeNull();
    expect(report.observedReduction).not.toBeNull();
    expect(renderAc9Report(report)).toContain("no covered sample, so no p95");
  });

  test("the sensitivity imputation covers every missing row", () => {
    // No ported case pins the sensitivity TOTAL: the bound test asserts only
    // inequalities, which hold just as well if the p95 term is dropped
    // entirely. The term is the whole figure -- observed alone is the
    // treat-missing-as-zero number the section forbids.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
      invoke(cp, "inv-2", { runId: "run-1", incidentId: "inc-1", outputTokens: 200 });
      invoke(cp, "inv-3", { runId: "run-1", incidentId: "inc-1", usageStatus: "unavailable" });
      invoke(cp, "inv-4", { runId: "run-1", incidentId: "inc-1", usageStatus: "partial" });
    });

    const report = measure(path);
    expect(report.coveredP95OutputTokens).toBe(200);
    // observed 300, plus the p95 for EACH of the two missing rows.
    expect(report.sensitivityOutputTokens).toBe(300 + 200 * 2);
  });

  test("a cohort that used more than the baseline prints a negative reduction", () => {
    // The source says the reduction is "not clamped. A negative reduction means
    // Interlock used MORE than the baseline, and that is a measurement the
    // report is obliged to print rather than floor at zero." No case on either
    // side ever produces one, so a clamp would be invisible -- and a clamp is
    // exactly the flattering direction: it would report parity where the
    // measurement says regression.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      // The baseline is 3531 responses / 195 runs = ~18.1 per 100 runs. One run
      // with 40 responses is 4000 per 100.
      invoke(cp, "inv-1", {
        runId: "run-1",
        incidentId: "inc-1",
        outputTokens: 10_000_000,
        // The writer refuses an output figure above cap x responses, which is
        // the invariant that makes the bounded figure a bound -- so the ceiling
        // is raised rather than the check evaded.
        maxOutputTokens: 1_000_000,
        modelResponseCount: 40,
      });
    });

    const report = measure(path);
    expect(report.promptReduction as number).toBeLessThan(0);
    expect(report.observedReduction as number).toBeLessThan(0);
    expect(renderAc9Report(report)).toContain("-");
  });

  test("the baseline is normalised per 100 runs, and the reduction is that arithmetic", () => {
    // Every ported assertion about a reduction is relative -- an ordering or an
    // equality between two figures -- so dropping the *100 from the baseline
    // normalisation changes every number and fails nothing. This pins one
    // figure against arithmetic done here.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
    });

    const report = measure(path);
    expect(V1_MEASURED_BASELINE.modelResponsesPer100Runs).toBe((3531 * 100) / 195);
    expect(V1_MEASURED_BASELINE.outputTokensPer100Runs).toBe((567_839 * 100) / 195);
    // One response over one cohort run is 100 per 100 runs.
    expect(report.modelResponsesPer100Runs).toBe(100);
    expect(report.promptReduction).toBe(1 - 100 / ((3531 * 100) / 195));
    expect(report.observedReduction).toBe(1 - (100 * 100) / ((567_839 * 100) / 195));
  });

  test("a baseline with no responses or no tokens is refused", () => {
    // The ported case covers only the zero-run branch, on both sides. The other
    // branch is the one that would print as a 100 percent reduction no matter
    // what Interlock did.
    for (const fields of [
      { modelResponses: 0, outputTokens: 567_839 },
      { modelResponses: 3531, outputTokens: 0 },
    ]) {
      expectRefusal(
        () =>
          new MeasuredBaseline({
            completedRuns: 195,
            toolCalls: 4960,
            cacheReadTokens: 0,
            source: "a baseline with a zero in it",
            ...fields,
          }),
        BaselineRefused,
      );
    }
  });

  test("an unattributed invocation exactly at the period end is outside it", () => {
    // The window is half-open on started_at_ms (time-base-policy.md section 2,
    // rule 4) and no case on either side puts a run-less invocation on the
    // boundary, so a `<=` would move one invocation per report and show up
    // nowhere else.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      startInvocation(cp, {
        invocationId: "inv-at-end",
        provider: PROVIDER,
        model: MODEL,
        adapterVersion: ADAPTER,
        startedAtMs: PERIOD_END,
        incidentId: "inc-1",
        runId: null,
        maxOutputTokens: CAP,
      });
      startInvocation(cp, {
        invocationId: "inv-just-inside",
        provider: PROVIDER,
        model: MODEL,
        adapterVersion: ADAPTER,
        startedAtMs: PERIOD_END - 1,
        incidentId: "inc-1",
        runId: null,
        maxOutputTokens: CAP,
      });
    });

    expect(measure(path).unattributedInvocations).toBe(1);
  });

  test("the itemisations are ordered by invocation id, whatever the insert order", () => {
    // `D-0040` asks a report to be reproducible byte for byte, and the
    // itemisation order is part of the bytes. Every ported case itemises at
    // most one id, so the ordering is unexercised on both sides.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      for (const id of ["inv-c", "inv-a", "inv-b"]) {
        invoke(cp, id, {
          runId: "run-1",
          incidentId: "inc-1",
          usageStatus: "unavailable",
          maxOutputTokens: null,
        });
      }
    });

    expect(measure(path).unboundedMissing).toEqual(["inv-a", "inv-b", "inv-c"]);
  });

  test("a cohort past SQLite's parameter ceiling is chunked, not refused", () => {
    // The ceiling is real -- 32,766 bound parameters succeed on this build and
    // 32,767 fails -- and no case on either side has a cohort of more than a
    // handful of runs. The invocation is attached to the LAST run, so a loop
    // that stopped after its first chunk would report an empty ledger rather
    // than crashing.
    const path = productionDb();
    withWriter(path, (cp) => {
      const insert = cp.prepare(
        "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'completed', ?, ?)",
      );
      const many = cp.transaction(() => {
        for (let index = 0; index < 33_000; index += 1) {
          insert.run(`run-${String(index).padStart(6, "0")}`, PERIOD_START + 1, PERIOD_START + 2);
        }
      });
      many();
      addIncident(cp, "inc-1", "run-032999");
      invoke(cp, "inv-last", {
        runId: "run-032999",
        incidentId: "inc-1",
        outputTokens: 10,
      });
    });

    const report = measure(path);
    expect(report.cohortSize).toBe(33_000);
    expect(report.invocationCount).toBe(1);
    expect(report.observedOutputTokens).toBe(10);
  });

  test("a percentage on an exact tie rounds Python's way", () => {
    // Every percentage in the ported cases is a round number, so `toFixed`
    // would pass all of them -- and `toFixed` rounds half away from zero while
    // Python's formatter rounds half to even (D-0104). One model response over
    // 800 cohort runs is 0.125 per 100 runs, which is exactly the tie.
    const path = productionDb();
    withWriter(path, (cp) => {
      const insert = cp.prepare(
        "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'completed', ?, ?)",
      );
      const many = cp.transaction(() => {
        for (let index = 0; index < 800; index += 1) {
          insert.run(`run-${String(index).padStart(4, "0")}`, PERIOD_START + 1, PERIOD_START + 2);
        }
      });
      many();
      addIncident(cp, "inc-1", "run-0000");
      invoke(cp, "inv-1", { runId: "run-0000", incidentId: "inc-1", outputTokens: 10 });
    });

    const report = measure(path);
    expect(report.modelResponsesPer100Runs).toBe(0.125);
    // Python: 0.12 (half to even). toFixed: 0.13.
    expect(renderAc9Report(report)).toContain("per 100 runs: 0.12");
    expect((0.125).toFixed(2)).toBe("0.13");
  });

  test("the coincide line is absent when coverage is not complete", () => {
    // The ported case asserts the sentence is PRESENT at full coverage; nothing
    // asserts it is absent otherwise. Printed unconditionally it would tell a
    // reader that the three figures agree at exactly the moment they do not,
    // which is the reading section 2.4's four-figure rule exists to prevent.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
      invoke(cp, "inv-2", { runId: "run-1", incidentId: "inc-1", usageStatus: "unavailable" });
    });

    const report = measure(path);
    expect(report.coverageIsComplete).toBe(false);
    expect(renderAc9Report(report)).not.toContain("coincide");
  });
});

describe("exact integer arithmetic (target-only)", () => {
  test("an output figure past 2^53 is summed exactly, not rounded", () => {
    // Target-only, and a PORT DIVERGENCE the codex review gate caught. Python's
    // int is unbounded, so ac9.py sums these exactly; better-sqlite3's default
    // would hand back a JavaScript number and round 9007199254740993 to ...992
    // on the way in, so every figure downstream would be over a value the
    // database does not hold (D-0007, docs/sqlite-value-contract.md). The
    // statement now runs with safeIntegers and the sums are BigInt.
    //
    // Two rows one apart at the top of the safe range: under rounding they read
    // as the same number and the totals coincide.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", {
        runId: "run-1",
        incidentId: "inc-1",
        outputTokens: Number.MAX_SAFE_INTEGER,
        maxOutputTokens: Number.MAX_SAFE_INTEGER,
      });
    });
    const atTheLimit = measure(path).observedOutputTokens;
    expect(atTheLimit).toBe(Number.MAX_SAFE_INTEGER);

    // And one past it is refused rather than printed as a rounded figure: a
    // report whose token total is off by one is the exact failure this module
    // exists to prevent, and interlock's unbounded int has no equivalent.
    const beyond = productionDb("beyond.sqlite3");
    withWriter(beyond, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", {
        runId: "run-1",
        incidentId: "inc-1",
        outputTokens: Number.MAX_SAFE_INTEGER,
        maxOutputTokens: Number.MAX_SAFE_INTEGER,
      });
      // A second row of the same size: the SUM is what leaves the safe range,
      // and each row on its own is representable.
      invoke(cp, "inv-2", {
        runId: "run-1",
        incidentId: "inc-1",
        outputTokens: Number.MAX_SAFE_INTEGER,
        maxOutputTokens: Number.MAX_SAFE_INTEGER,
      });
    });

    const refusal = expectRefusal(() => measure(beyond), FigureExceedsExactRangeRefused);
    expect(refusal.message).toContain("observed output-token total");
    expect(refusal.message).toContain("rounded figure");
  });
});

describe("a deliberate divergence from interlock (target-only)", () => {
  test("the header's acceptance predicate agrees with the report's", () => {
    // Target-only, and `D-0107`: a DELIBERATE, PERMANENT divergence from
    // interlock, decided by the operator on 2026-08-22 after the codex review
    // gate raised it as a P1.
    //
    // interlock disqualifies an acceptance claim on TWO populations in
    // Ac9Report -- nothing to bound at, and a response count that is still the
    // writer's request-time placeholder -- but carries only the first into the
    // provenance header, whose own predicate is `unbounded_missing == 0`. The
    // result is not two artefacts that disagree: `render.py` puts both answers
    // in ONE document, at `.header.imputation_rule.supports_acceptance_claim`
    // (true) and `.sections.ac9.facts.imputation.supports_acceptance_claim`
    // (false). Measured against interlock at 65f36c5, not inferred.
    //
    // continuo carries both counts and the predicate takes both, so a reader
    // gets one answer and can see which population made it false. The
    // divergence is permanent -- interlock is frozen -- and this case is the
    // evidence that it is intended rather than a translation slip.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
      invoke(cp, "inv-inflight", {
        runId: "run-1",
        incidentId: "inc-1",
        maxOutputTokens: 4_096,
        finish: false,
      });
    });

    const report = measure(path);
    const imputation = imputationFromAc9(report);

    expect(report.unconfirmedResponseCount).toEqual(["inv-inflight"]);
    expect(report.unboundedMissing).toEqual([]);
    expect(report.supportsAcceptanceClaim).toBe(false);
    expect(renderAc9Report(report)).toContain("CANNOT support an AC-9 acceptance claim");

    // The header now says the same thing, and says why: the count interlock's
    // header has no field for is carried here.
    expect(imputation.unboundedMissing).toBe(0);
    expect(imputation.unconfirmedResponseCount).toBe(1);
    expect(imputation.supportsAcceptanceClaim).toBe(false);
  });
});

describe("hostile values in the rendering (target-only)", () => {
  test("an invocation id cannot forge a line and cannot reach a cp932 console", () => {
    // Target-only, and `D-0109`. Found by reading the renderer rather than from
    // a ledger disclosure -- this module was not among the three the inventory
    // listed. Every itemisation here prints `      <invocation_id>`, and
    // ai_invocation.invocation_id is unconstrained TEXT.
    const path = productionDb();
    withWriter(path, (cp) => {
      addCohortRun(cp, "run-1");
      addIncident(cp, "inc-1", "run-1");
      invoke(cp, "inv-1", { runId: "run-1", incidentId: "inc-1", outputTokens: 100 });
      invoke(cp, "inv-hostile\n      inv-forged", {
        runId: "run-1",
        incidentId: "inc-1",
        usageStatus: "unavailable",
        maxOutputTokens: null,
      });
      invoke(cp, "inv-em\u2014dash", { runId: "run-1", incidentId: null, outputTokens: 10 });
    });

    const report = measure(path);
    const rendered = renderAc9Report(report);

    expect(isAscii(rendered)).toBe(true);
    expect(rendered).toContain("\\u000a");
    expect(rendered).toContain("\\u2014");
    // The unbounded_missing itemisation has one entry, not two.
    expect(report.unboundedMissing).toHaveLength(1);
    expect(
      rendered.split("\n").filter((line) => line.startsWith("      inv-hostile")),
    ).toHaveLength(1);
  });
});
