/**
 * A corpus that refuses rather than shrinks, and rates that can be checked by
 * hand.
 *
 * Ported from interlock `tests/measurement/test_fixtures.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping, and the cases that are
 * adapted rather than translated straight, are recorded in
 * `parity/measurement.fixtures.ledger.json`.
 *
 * Three properties get adversarial treatment here, because each of them fails in
 * a direction that looks like success:
 *
 * * **A malformed case is refused, not skipped.** Every malformed shape below is
 *   asserted to raise, and to name the case in the message. A loader that
 *   skipped them would leave a green suite behind a corpus that quietly got
 *   smaller, and the only number that would have shown it -- the composition --
 *   would have moved the flattering way.
 * * **A corpus with no negative case is refused at build time.** The reason is
 *   arithmetic, so the test is arithmetic: a detector that alarms on **every**
 *   case is run against a positive-only corpus and scores a perfect miss rate.
 * * **The latency is exact, by construction.** Every instant a "detector"
 *   produces here comes from the evaluation's own `SyntheticClock`, and an
 *   instant from anywhere else is asserted to be refused. The numbers are then
 *   checked by hand: a detection 45 s after a labelled onset is asserted to be
 *   45_000, not "close to".
 *
 * Nothing here re-implements the grading to compare against. Where a test needs
 * a deadline it states the arithmetic itself (onset + budget, both read from the
 * label the loader returned) and hands the detector an instant one millisecond
 * on each side of it; the expected verdict is written down by hand. The shipped
 * corpus's labels are checked against the **seeded policy rows** rather than
 * against a copy of themselves, so a label that drifts from the revision it
 * claims to be under fails here.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import { detectionLatency } from "../../src/control_plane/policy.js";
import {
  CaseIncomplete,
  ClassDirectoryMismatch,
  ClockNotSynthetic,
  DETECTED,
  EvaluationRefusal,
  evaluate,
  FACT_STATES,
  FALSE_POSITIVE,
  FixtureEvaluation,
  FixtureRefusal,
  IncidentBeforeOnset,
  LABEL_FIELDS,
  LabelMalformed,
  loadCase,
  loadCorpus,
  MISS,
  NegativeCasesRequired,
  NONE_CLASS,
  OutcomeMissing,
  PositiveCasesRequired,
  ProducedIncident,
  renderFixtureReport,
  StrayEntryRefused,
  SyntheticClock,
  TRUE_NEGATIVE,
  TraceMalformed,
  UnknownCaseInOutcomes,
  VERDICTS,
} from "../../src/measurement/fixtures.js";
import { isAscii } from "../../src/measurement/format.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

/**
 * The note `0002_policy_seed.sql` writes. Looked up by note rather than assumed
 * to be revision 1, so this survives a later seed step.
 */
const SEED_NOTE =
  "initial time base: detection latency budgets, gate stage tolerances " +
  "and gate stage owners as first decided";

/**
 * Where the corpus this belt ships lives.
 *
 * Resolved from this file so the test moves with the tree rather than depending
 * on the working directory, exactly as the source resolves its own.
 */
const SHIPPED_CORPUS = fileURLToPath(new URL("../fixtures/labelled", import.meta.url));

/** A well-formed positive label. Tests mutate exactly one field. */
function positiveLabel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    incident_class: "relay_gap",
    onset_offset_ms: 30_000,
    tolerance_ms: 180_000,
    budget_ms: 300_000,
    fact_state: "EXPLICIT_BLOCK",
    must_not_recommend: ["terminate_session"],
    provenance: "constructed_edge: a synthetic case for the loader tests",
    ...overrides,
  };
}

function negativeLabel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    incident_class: NONE_CLASS,
    onset_offset_ms: null,
    tolerance_ms: null,
    budget_ms: null,
    fact_state: "OBSERVATION_UNAVAILABLE",
    must_not_recommend: ["terminate_session"],
    provenance: "constructed_edge: a synthetic outage for the loader tests",
    ...overrides,
  };
}

const TRACE: readonly Record<string, unknown>[] = [
  { offset_ms: 0, kind: "run_started" },
  { offset_ms: 30_000, kind: "gate_received" },
  { offset_ms: 330_000, kind: "reconcile_pass" },
];

/** Write one `<class>/<case>/` directory. `label` / `trace` may be raw text. */
function writeCase(
  root: string,
  classDir: string,
  name: string,
  options: {
    label: Record<string, unknown> | string;
    trace?: readonly Record<string, unknown>[] | string;
  },
): string {
  const casePath = join(root, classDir, name);
  mkdirSync(casePath, { recursive: true });
  writeFileSync(
    join(casePath, "expected.json"),
    typeof options.label === "string" ? options.label : JSON.stringify(options.label),
    "utf8",
  );
  const trace = options.trace ?? TRACE;
  writeFileSync(
    join(casePath, "trace.jsonl"),
    typeof trace === "string" ? trace : trace.map((line) => `${JSON.stringify(line)}\n`).join(""),
    "utf8",
  );
  return casePath;
}

const RELAY_CASE = "relay_gap/stalled_relay";
const OUTAGE_CASE = "observation_unavailable/probe_down";

/**
 * The graded outcome for one case, looked up by id.
 *
 * By id and never by position: `loadCorpus` walks the tree in sorted order, so
 * `observation_unavailable` precedes `relay_gap` and an index-based test would
 * assert against whichever case happened to sort first.
 */
function outcomeFor(evaluation: FixtureEvaluation, caseId: string) {
  for (const outcome of evaluation.outcomes) {
    if (outcome.caseId === caseId) {
      return outcome;
    }
  }
  return expect.fail(`no outcome for ${caseId}`);
}

/** One positive and one negative case -- the smallest loadable corpus. */
function minimalCorpus(root: string): string {
  writeCase(root, "relay_gap", "stalled_relay", { label: positiveLabel() });
  writeCase(root, "observation_unavailable", "probe_down", { label: negativeLabel() });
  return root;
}

/** `outcomes` as the map `evaluate` takes. */
function outcomes(
  entries: Record<string, readonly ProducedIncident[]>,
): ReadonlyMap<string, readonly ProducedIncident[]> {
  return new Map(Object.entries(entries));
}

// ---------------------------------------------------------------------------
// The loader refuses every malformed shape, and names the case.
// ---------------------------------------------------------------------------

describe("the loader refuses every malformed shape", () => {
  parametrize(
    "half a case is refused",
    [
      ["trace.jsonl", "trace.jsonl"],
      ["expected.json", "expected.json"],
    ],
    (absent) => {
      // Half a case is not a smaller case; it has no correct outcome at all.
      const root = caseRoot("fixtures");
      const casePath = writeCase(root, "relay_gap", "stalled_relay", {
        label: positiveLabel(),
      });
      rmSync(join(casePath, absent));

      const refusal = expectRefusal(() => loadCase(casePath), CaseIncomplete);
      expect(refusal.message).toContain(absent);
      expect(refusal.message).toContain("stalled_relay");
    },
  );

  test("a third file in a case is refused", () => {
    // An input nothing loads means the case is graded against less than it
    // holds.
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "relay_gap", "stalled_relay", { label: positiveLabel() });
    writeFileSync(join(casePath, "notes.md"), "half the label lives here", "utf8");

    const refusal = expectRefusal(() => loadCase(casePath), StrayEntryRefused);
    expect(refusal.message).toContain("notes.md");
  });

  parametrize(
    "every missing label field is refused",
    LABEL_FIELDS.map((field): [string, string] => [field, field]),
    (field) => {
      // All seven of section 3.2's fields, each proved required on its own.
      // Parametrised over LABEL_FIELDS itself rather than over a list retyped
      // here: a field added to the table is then covered the moment it is
      // added, and a field silently dropped from the constant fails this test.
      const root = caseRoot("fixtures");
      const label = positiveLabel();
      delete label[field];
      const casePath = writeCase(root, "relay_gap", "stalled_relay", { label });

      const refusal = expectRefusal(() => loadCase(casePath), LabelMalformed);
      expect(refusal.message).toContain(field);
    },
  );

  test("an unknown label field is refused", () => {
    // A field nothing reads is a label the grader ignores.
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "relay_gap", "stalled_relay", {
      label: positiveLabel({ severity: "high" }),
    });
    const refusal = expectRefusal(() => loadCase(casePath), LabelMalformed);
    expect(refusal.message).toContain("severity");
  });

  test("an unknown fact state is refused", () => {
    // D-0005's set is closed; a mistyped state is a fixture nothing can
    // satisfy.
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "relay_gap", "stalled_relay", {
      label: positiveLabel({ fact_state: "EXPLICITLY_BLOCKED" }),
    });
    const refusal = expectRefusal(() => loadCase(casePath), LabelMalformed);
    expect(refusal.message).toContain("D-0005");
    for (const state of FACT_STATES) {
      expect(refusal.message).toContain(state);
    }
  });

  test("free text provenance is refused", () => {
    // The field answers "did this happen or did we imagine it", and must be
    // countable.
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "relay_gap", "stalled_relay", {
      label: positiveLabel({ provenance: "seemed like a good idea" }),
    });
    expectRefusal(() => loadCase(casePath), LabelMalformed);

    // The same field with a known kind and free detail after a colon loads.
    const ok = writeCase(root, "relay_gap", "from_an_accident", {
      label: positiveLabel({ provenance: "accident: incident of 2026-08-02" }),
    });
    expect(loadCase(ok).expected.provenance.startsWith("accident")).toBe(true);
  });

  test("must_not_recommend must be a list of strings", () => {
    // An empty list is allowed and says so; a bare string is not a list of one.
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "relay_gap", "stalled_relay", {
      label: positiveLabel({ must_not_recommend: "terminate_session" }),
    });
    expectRefusal(() => loadCase(casePath), LabelMalformed);

    const empty = writeCase(root, "relay_gap", "nothing_forbidden", {
      label: positiveLabel({ must_not_recommend: [] }),
    });
    expect(loadCase(empty).expected.mustNotRecommend).toEqual([]);
  });

  parametrize(
    "a negative case may not carry a window",
    [
      ["onset_offset_ms", "onset_offset_ms"],
      ["tolerance_ms", "tolerance_ms"],
      ["budget_ms", "budget_ms"],
    ],
    (field) => {
      // A `none` case has no condition, so no state entry and no budget. A
      // window on a negative case would suggest a false positive counts only
      // inside it; an alarm on a healthy worker is wrong at every offset.
      const root = caseRoot("fixtures");
      const casePath = writeCase(root, "observation_unavailable", "probe_down", {
        label: negativeLabel({ [field]: 60_000 }),
      });
      const refusal = expectRefusal(() => loadCase(casePath), LabelMalformed);
      expect(refusal.message).toContain(field);
    },
  );

  parametrize(
    "a positive case needs real numbers",
    [
      ["overrides0", { onset_offset_ms: null }],
      ["overrides1", { budget_ms: null }],
      ["overrides2", { onset_offset_ms: -1 }],
      ["overrides3", { budget_ms: 0 }],
      ["overrides4", { onset_offset_ms: "30000" }],
      ["overrides5", { onset_offset_ms: true }],
    ] as [string, Record<string, unknown>][],
    (overrides) => {
      // A positive case with no usable onset or budget can never be graded.
      const root = caseRoot("fixtures");
      const casePath = writeCase(root, "relay_gap", "stalled_relay", {
        label: positiveLabel(overrides),
      });
      expectRefusal(() => loadCase(casePath), LabelMalformed);
    },
  );

  test("tolerance may not exceed the budget", () => {
    // T is part of L, not a head start on it (time-base-policy.md section 3.1).
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "relay_gap", "stalled_relay", {
      label: positiveLabel({ tolerance_ms: 300_001, budget_ms: 300_000 }),
    });
    const refusal = expectRefusal(() => loadCase(casePath), LabelMalformed);
    expect(refusal.message).toContain("3.1");
  });

  parametrize(
    "every malformed trace is refused",
    [
      ["not_json", "not json at all\n"],
      ["no_offset", '{"kind": "gate_received"}\n'],
      ["offset_not_int", '{"offset_ms": "30000", "kind": "gate_received"}\n'],
      ["no_kind", '{"offset_ms": 30000}\n'],
      [
        "offsets_go_backwards",
        '{"offset_ms": 30000, "kind": "gate_received"}\n{"offset_ms": 10, "kind": "x"}\n',
      ],
      ["no_observations", "\n\n"],
    ],
    (trace) => {
      // Refused, never skipped: a skipped case is a corpus that silently shrank.
      const root = caseRoot("fixtures");
      const casePath = writeCase(root, "relay_gap", "stalled_relay", {
        label: positiveLabel(),
        trace,
      });
      const refusal = expectRefusal(() => loadCase(casePath), TraceMalformed);
      expect(refusal.message).toContain("stalled_relay");
    },
  );

  test("a malformed label json is refused", () => {
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "relay_gap", "stalled_relay", { label: "{oops" });
    expectRefusal(() => loadCase(casePath), LabelMalformed);
  });

  test("trace extras are carried unread", () => {
    // The observation vocabulary belongs to the detectors, not to the grader.
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "relay_gap", "stalled_relay", {
      label: positiveLabel(),
      trace: [{ offset_ms: 0, kind: "gate_received", gate_id: "g-1", n: 3 }],
    });
    const observation = loadCase(casePath).observations[0];
    expect(Object.fromEntries(observation?.fields ?? [])).toEqual({ gate_id: "g-1", n: 3 });
    expect(observation?.offsetMs).toBe(0);
  });

  test("a positive case filed under another class is refused", () => {
    // The composition table groups by directory, so a misfiled case lies in it.
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "consumer_backlog", "stalled_relay", {
      label: positiveLabel({ incident_class: "relay_gap" }),
    });
    const refusal = expectRefusal(() => loadCase(casePath), ClassDirectoryMismatch);
    expect(refusal.message).toContain("consumer_backlog");
    expect(refusal.message).toContain("relay_gap");
  });

  test("a negative case may sit under any class", () => {
    // The directory of a `none` case names the detector it is aimed at. "An
    // outage that must not raise relay_gap" is a real and necessary fixture, so
    // the class-directory rule is one-sided on purpose.
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "relay_gap", "outage_here", { label: negativeLabel() });
    expect(loadCase(casePath).caseId).toBe("relay_gap/outage_here");
  });
});

// ---------------------------------------------------------------------------
// The corpus as a whole.
// ---------------------------------------------------------------------------

describe("the corpus as a whole", () => {
  test("a corpus with no negative case is refused", () => {
    // The refusal is the only thing standing between AC-10 and a loud detector.
    const root = caseRoot("fixtures");
    writeCase(root, "relay_gap", "stalled_relay", { label: positiveLabel() });
    writeCase(root, "consumer_backlog", "backed_up", {
      label: positiveLabel({ incident_class: "consumer_backlog" }),
    });

    const refusal = expectRefusal(() => loadCorpus(root), NegativeCasesRequired);
    expect(refusal.message).toContain("D-0006");
  });

  test("the refused positive-only corpus would have scored perfectly", () => {
    // Why the refusal is a refusal: the arithmetic, run. A detector that raises
    // EVERY class on EVERY case is the thing a corpus is supposed to catch.
    // Graded over positives alone it has a miss rate of zero -- a perfect score
    // -- which is why the corpus that would let it happen must not be loadable
    // at all. The same detector, once one negative case exists, is a false
    // positive.
    const root = caseRoot("fixtures");
    writeCase(root, "relay_gap", "stalled_relay", { label: positiveLabel() });
    expectRefusal(() => loadCorpus(root), NegativeCasesRequired);

    writeCase(root, "observation_unavailable", "probe_down", { label: negativeLabel() });
    const corpus = loadCorpus(root);

    const clock = new SyntheticClock(T0);
    const alarmsOnEverything = new Map(
      corpus.cases.map((one): [string, readonly ProducedIncident[]] => [
        one.caseId,
        [
          new ProducedIncident({
            incidentClass: "relay_gap",
            factState: "EXPLICIT_BLOCK",
            createdAtMs: clock.at(60_000),
          }),
        ],
      ]),
    );
    const evaluation = evaluate(corpus, { clock, outcomes: alarmsOnEverything });

    expect(evaluation.missRate()).toBe(0.0); // perfect, and meaningless on its own
    expect(evaluation.falsePositiveRate()).toBe(1.0); // what the negative case says
  });

  test("a corpus with no positive case is refused", () => {
    // A corpus that cannot express a miss is not AC-10's ground truth either.
    const root = caseRoot("fixtures");
    writeCase(root, "observation_unavailable", "probe_down", { label: negativeLabel() });
    expectRefusal(() => loadCorpus(root), PositiveCasesRequired);
  });

  test("readmes are ignored and other strays are refused", () => {
    const root = caseRoot("fixtures");
    minimalCorpus(root);
    writeFileSync(join(root, "README.md"), "how to read this", "utf8");
    writeFileSync(join(root, "relay_gap", "README.md"), "notes", "utf8");
    expect(loadCorpus(root).composition().get("total")).toBe(2);

    writeFileSync(join(root, "relay_gap", "leftover.jsonl"), "{}", "utf8");
    const refusal = expectRefusal(() => loadCorpus(root), StrayEntryRefused);
    expect(refusal.message).toContain("leftover.jsonl");
  });

  test("the digest is over content, not counts", () => {
    // Editing one label changes every number a report prints and no count at
    // all.
    const root = caseRoot("fixtures");
    minimalCorpus(root);
    const before = loadCorpus(root);
    expect(loadCorpus(root).contentDigest).toBe(before.contentDigest);

    writeFileSync(
      join(root, "relay_gap", "stalled_relay", "expected.json"),
      JSON.stringify(positiveLabel({ budget_ms: 600_000 })),
      "utf8",
    );
    const after = loadCorpus(root);

    // The count did not move...
    expect(Object.fromEntries(after.composition())).toEqual(
      Object.fromEntries(before.composition()),
    );
    // ...the content did.
    expect(after.contentDigest).not.toBe(before.contentDigest);
  });

  test("an unknown case id is refused", () => {
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    expectRefusal(() => corpus.case("relay_gap/no_such_case"), FixtureRefusal);
  });
});

// ---------------------------------------------------------------------------
// The evaluator: a miss, a false positive and an exact latency, by hand.
// ---------------------------------------------------------------------------

describe("the evaluator", () => {
  test("a detection inside the budget has an exact latency", () => {
    // Onset at +30 s, alarm at +75 s: the latency is 45_000, not "about 45 s".
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const evaluation = evaluate(corpus, {
      clock,
      outcomes: outcomes({
        [RELAY_CASE]: [
          new ProducedIncident({
            incidentClass: "relay_gap",
            factState: "EXPLICIT_BLOCK",
            createdAtMs: clock.at(75_000),
          }),
        ],
        [OUTAGE_CASE]: [],
      }),
    });

    const detected = outcomeFor(evaluation, RELAY_CASE);
    expect(detected.verdict).toBe(DETECTED);
    expect(detected.latencyMs).toBe(45_000);
    expect(detected.deadlineMs).toBe(T0 + 30_000 + 300_000);
    expect(evaluation.latenciesMs()).toEqual([45_000]);
    expect(evaluation.missRate()).toBe(0.0);
  });

  test("an alarm at the onset instant is a zero-latency detection", () => {
    // The other end of the same boundary: exactly at onset is detected, latency
    // 0. A detector that alarms the instant the condition begins is the best
    // possible outcome, and the refusal for a NEGATIVE latency must not swallow
    // it -- the two are one millisecond apart and one is a defect in the ground
    // truth while the other is a perfect detection.
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const evaluation = evaluate(corpus, {
      clock,
      outcomes: outcomes({
        [RELAY_CASE]: [
          new ProducedIncident({
            incidentClass: "relay_gap",
            factState: "EXPLICIT_BLOCK",
            createdAtMs: clock.at(30_000), // the labelled onset itself
          }),
        ],
        [OUTAGE_CASE]: [],
      }),
    });
    expect(outcomeFor(evaluation, RELAY_CASE).verdict).toBe(DETECTED);
    expect(outcomeFor(evaluation, RELAY_CASE).latencyMs).toBe(0);
  });

  test("the deadline is the last instant that counts", () => {
    // Onset + budget exactly is detected; one millisecond later is a miss. The
    // two runs differ by a single millisecond, which is the only way to catch a
    // `<=` written as a `<`. The late run also proves a late alarm is recorded
    // as LATE rather than as silence: the two failures have nothing in common
    // and the report must not conflate them.
    const root = minimalCorpus(caseRoot("fixtures"));
    const corpus = loadCorpus(root);
    const label = corpus.case(RELAY_CASE).expected;
    const deadlineOffset = (label.onsetOffsetMs as number) + (label.budgetMs as number);
    expect(deadlineOffset, "stated by hand, not computed twice").toBe(330_000);

    const onTimeClock = new SyntheticClock(T0);
    const onTime = evaluate(corpus, {
      clock: onTimeClock,
      outcomes: outcomes({
        [RELAY_CASE]: [
          new ProducedIncident({
            incidentClass: "relay_gap",
            factState: "EXPLICIT_BLOCK",
            createdAtMs: onTimeClock.at(deadlineOffset),
          }),
        ],
        [OUTAGE_CASE]: [],
      }),
    });
    expect(outcomeFor(onTime, RELAY_CASE).verdict).toBe(DETECTED);
    expect(outcomeFor(onTime, RELAY_CASE).latencyMs).toBe(300_000);

    const lateClock = new SyntheticClock(T0);
    const late = evaluate(corpus, {
      clock: lateClock,
      outcomes: outcomes({
        [RELAY_CASE]: [
          new ProducedIncident({
            incidentClass: "relay_gap",
            factState: "EXPLICIT_BLOCK",
            createdAtMs: lateClock.at(deadlineOffset + 1),
          }),
        ],
        [OUTAGE_CASE]: [],
      }),
    });
    const missed = outcomeFor(late, RELAY_CASE);
    expect(missed.verdict).toBe(MISS);
    expect(missed.latencyMs).toBeNull();
    expect(missed.lateLatencyMs).toBe(300_001);
    expect(late.missRate()).toBe(1.0);
    expect(late.latenciesMs()).toEqual([]);
  });

  test("silence is a miss with no late alarm", () => {
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const evaluation = evaluate(corpus, {
      clock,
      outcomes: outcomes({ [RELAY_CASE]: [], [OUTAGE_CASE]: [] }),
    });
    expect(outcomeFor(evaluation, RELAY_CASE).verdict).toBe(MISS);
    expect(outcomeFor(evaluation, RELAY_CASE).lateLatencyMs).toBeNull();
    expect(Object.fromEntries(evaluation.counts())).toEqual({
      [DETECTED]: 0,
      [MISS]: 1,
      [FALSE_POSITIVE]: 0,
      [TRUE_NEGATIVE]: 1,
    });
    expect(new Set(evaluation.counts().keys())).toEqual(new Set(VERDICTS));
  });

  test("an alarm of the wrong class does not detect the case", () => {
    // A detector that raises the wrong alarm loudly has still missed.
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const evaluation = evaluate(corpus, {
      clock,
      outcomes: outcomes({
        [RELAY_CASE]: [
          new ProducedIncident({
            incidentClass: "consumer_backlog",
            factState: "EXPLICIT_BLOCK",
            createdAtMs: clock.at(60_000),
          }),
        ],
        [OUTAGE_CASE]: [],
      }),
    });
    const outcome = outcomeFor(evaluation, RELAY_CASE);
    expect(outcome.verdict).toBe(MISS);
    expect(outcome.otherClassIncidents).toEqual(["consumer_backlog"]);
  });

  test("the right class with the wrong fact is detected and recorded", () => {
    // Section 3.2 matches on class, so this is a detection -- and it is not
    // silent.
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const evaluation = evaluate(corpus, {
      clock,
      outcomes: outcomes({
        [RELAY_CASE]: [
          new ProducedIncident({
            incidentClass: "relay_gap",
            factState: "NO_ACTIVITY_EVIDENCE",
            createdAtMs: clock.at(60_000),
          }),
        ],
        [OUTAGE_CASE]: [],
      }),
    });
    const outcome = outcomeFor(evaluation, RELAY_CASE);
    expect(outcome.verdict).toBe(DETECTED);
    expect(outcome.factStateMismatches).toEqual(["NO_ACTIVITY_EVIDENCE"]);
  });

  test("the earliest matching alarm is the detection", () => {
    // A second incident for one condition is a re-notification, not the
    // latency.
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const evaluation = evaluate(corpus, {
      clock,
      outcomes: outcomes({
        [RELAY_CASE]: [
          new ProducedIncident({
            incidentClass: "relay_gap",
            factState: "EXPLICIT_BLOCK",
            createdAtMs: clock.at(200_000),
          }),
          new ProducedIncident({
            incidentClass: "relay_gap",
            factState: "EXPLICIT_BLOCK",
            createdAtMs: clock.at(90_000),
          }),
        ],
        [OUTAGE_CASE]: [],
      }),
    });
    expect(outcomeFor(evaluation, RELAY_CASE).latencyMs).toBe(60_000);
    expect(outcomeFor(evaluation, RELAY_CASE).matchingIncidents).toBe(2);
  });

  test("an alarm before its own onset is refused", () => {
    // A negative latency means the label or the attribution is wrong; both are
    // defects.
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const refusal = expectRefusal(
      () =>
        evaluate(corpus, {
          clock,
          outcomes: outcomes({
            [RELAY_CASE]: [
              new ProducedIncident({
                incidentClass: "relay_gap",
                factState: "EXPLICIT_BLOCK",
                createdAtMs: clock.at(29_999),
              }),
            ],
            [OUTAGE_CASE]: [],
          }),
        }),
      IncidentBeforeOnset,
    );
    expect(refusal.message).toContain(RELAY_CASE);
  });

  test("a stall alarm on an outage is the false positive", () => {
    // AC-3, in both directions, over the same negative case. An incident
    // carrying the labelled OBSERVATION_UNAVAILABLE fact is the REQUIRED output
    // and must not be graded as a false positive; the same trace read as a
    // stall is one. A grader that demanded a negative case produce no row at
    // all would fail a detector for obeying AC-3.
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));

    const conformingClock = new SyntheticClock(T0);
    const conforming = evaluate(corpus, {
      clock: conformingClock,
      outcomes: outcomes({
        [RELAY_CASE]: [],
        [OUTAGE_CASE]: [
          new ProducedIncident({
            incidentClass: "observation_unavailable",
            factState: "OBSERVATION_UNAVAILABLE",
            createdAtMs: conformingClock.at(190_000),
          }),
        ],
      }),
    });
    expect(conforming.idsFor(TRUE_NEGATIVE)).toEqual([OUTAGE_CASE]);
    expect(conforming.falsePositiveRate()).toBe(0.0);

    const wrongClock = new SyntheticClock(T0);
    const wrong = evaluate(corpus, {
      clock: wrongClock,
      outcomes: outcomes({
        [RELAY_CASE]: [],
        [OUTAGE_CASE]: [
          new ProducedIncident({
            incidentClass: "session_no_evidence",
            factState: "NO_ACTIVITY_EVIDENCE",
            createdAtMs: wrongClock.at(190_000),
          }),
        ],
      }),
    });
    expect(wrong.idsFor(FALSE_POSITIVE)).toEqual([OUTAGE_CASE]);
    expect(wrong.falsePositiveRate()).toBe(1.0);
    expect(outcomeFor(wrong, OUTAGE_CASE).factStateMismatches).toEqual(["NO_ACTIVITY_EVIDENCE"]);
  });

  test("a forbidden recommendation counts only when applied", () => {
    // Section 3.4: the count is at the applied effect, not at the
    // recommendation.
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const evaluation = evaluate(corpus, {
      clock,
      outcomes: outcomes({
        [RELAY_CASE]: [],
        [OUTAGE_CASE]: [
          new ProducedIncident({
            incidentClass: "observation_unavailable",
            factState: "OBSERVATION_UNAVAILABLE",
            createdAtMs: clock.at(190_000),
            appliedRecommendations: ["terminate_session"],
          }),
          new ProducedIncident({
            incidentClass: "observation_unavailable",
            factState: "OBSERVATION_UNAVAILABLE",
            createdAtMs: clock.at(200_000),
            appliedRecommendations: ["notify_secretary"],
          }),
        ],
      }),
    });
    expect(evaluation.forbiddenApplied()).toEqual([[OUTAGE_CASE, "terminate_session"]]);
    // The conforming fact keeps the verdict a true negative: the harm is the
    // applied action, and it is reported as its own series rather than folded
    // into the false-positive rate.
    expect(outcomeFor(evaluation, OUTAGE_CASE).verdict).toBe(TRUE_NEGATIVE);
  });

  test("an instant the clock did not mint is refused", () => {
    // The synthetic clock is structural: a wall-clock stamp cannot pass
    // quietly.
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const refusal = expectRefusal(
      () =>
        evaluate(corpus, {
          clock,
          outcomes: outcomes({
            [RELAY_CASE]: [
              new ProducedIncident({
                incidentClass: "relay_gap",
                factState: "EXPLICIT_BLOCK",
                createdAtMs: T0 + 75_123, // arithmetic, not the clock
              }),
            ],
            [OUTAGE_CASE]: [],
          }),
        }),
      ClockNotSynthetic,
    );
    expect(refusal.message).toContain("3.2");
  });

  test("one case's minting cannot vouch for another", () => {
    // Grading mints onsets and deadlines, so every instant is checked first.
    // The negative case's stamp here is the POSITIVE case's deadline instant.
    // If the check ran interleaved with grading, grading case one would mint
    // that instant and case two's foreign stamp would pass. All instants are
    // validated before any case is graded, so it does not.
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const refusal = expectRefusal(
      () =>
        evaluate(corpus, {
          clock,
          outcomes: outcomes({
            [RELAY_CASE]: [],
            [OUTAGE_CASE]: [
              new ProducedIncident({
                incidentClass: "session_no_evidence",
                factState: "NO_ACTIVITY_EVIDENCE",
                createdAtMs: T0 + 330_000,
              }),
            ],
          }),
        }),
      ClockNotSynthetic,
    );
    expect(refusal.message).toContain(OUTAGE_CASE);
  });

  test("a case with no outcome is refused", () => {
    // An absent entry must not read as "the detector produced nothing".
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const refusal = expectRefusal(
      () => evaluate(corpus, { clock, outcomes: outcomes({ [RELAY_CASE]: [] }) }),
      OutcomeMissing,
    );
    expect(refusal.message).toContain(OUTAGE_CASE);
  });

  test("an outcome for an unknown case is refused", () => {
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const refusal = expectRefusal(
      () =>
        evaluate(corpus, {
          clock,
          outcomes: outcomes({
            [RELAY_CASE]: [],
            [OUTAGE_CASE]: [],
            "relay_gap/renamed_yesterday": [],
          }),
        }),
      UnknownCaseInOutcomes,
    );
    expect(refusal.message).toContain("relay_gap/renamed_yesterday");
  });

  test("the synthetic clock refuses an offset before t0", () => {
    const clock = new SyntheticClock(T0);
    // The source asserts only `pytest.raises(Exception)`. The port names the
    // type the module actually raises, which is strictly stronger: a different
    // error would pass there and fails here.
    expectRefusal(() => clock.at(-1), EvaluationRefusal);
    expect(clock.minted(clock.at(0))).toBe(true);
    expect(clock.minted(T0 + 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Target-only: six properties a mutation sweep found unguarded.
//
// Five are INHERITED -- interlock's own suite cannot tell the mutated module
// from the real one either, verified against 65f36c5 in each case. One is a
// PORT artifact, and is marked as such. Production behaviour is unchanged
// throughout; these add coverage, not behaviour.
// ---------------------------------------------------------------------------

describe("properties the ported cases leave unguarded (target-only)", () => {
  test("the missing-field check is what refuses a missing field, not a downstream type check", () => {
    // A PORT artifact rather than an inherited gap, and worth naming as one.
    //
    // In Python, deleting parseLabel's "missing required field(s)" check makes
    // the next line raise KeyError -- a different type -- so the seven ported
    // `every missing label field is refused` cases fail. In TypeScript a
    // missing key reads as `undefined`, which flows into each field's own type
    // check and produces a LabelMalformed naming that same field. The seven
    // ported cases therefore pass either way, and the dedicated check is
    // invisible to them.
    //
    // The check still earns its place: it names ALL the missing fields at once
    // and cites section 3.2, where the downstream checks report only the first
    // and say nothing about why every default would be the flattering one. That
    // wording is what this pins.
    const root = caseRoot("fixtures");
    const label = positiveLabel();
    delete label["onset_offset_ms"];
    delete label["provenance"];
    const casePath = writeCase(root, "relay_gap", "stalled_relay", { label });

    const refusal = expectRefusal(() => loadCase(casePath), LabelMalformed);
    expect(refusal.message).toContain("missing required field(s)");
    // Both, in sorted order -- the downstream checks would report one.
    expect(refusal.message).toContain("onset_offset_ms, provenance");
    expect(refusal.message).toContain("section 3.2");
  });

  test("budget_ms of zero is refused BY THE BUDGET RULE, not by T > L", () => {
    // Inherited. The ported case drives budget_ms=0 and asserts only
    // LabelMalformed, so lowering the minimum from 1 to 0 still refuses -- via
    // `tolerance_ms=180000 > budget_ms=0` -- and the case cannot tell which rule
    // fired. Interlock's is identical.
    //
    // A zero budget is its own defect: it says the detector had no time at all,
    // which is not a tolerance problem. Driven here with T = 0 so the T > L rule
    // cannot fire and only the minimum can.
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "relay_gap", "zero_budget", {
      label: positiveLabel({ tolerance_ms: 0, budget_ms: 0 }),
    });
    const refusal = expectRefusal(() => loadCase(casePath), LabelMalformed);
    expect(refusal.message).toContain("budget_ms=0");
    expect(refusal.message).toContain(">= 1");
  });

  test("every clock instant is checked before ANY case is graded", () => {
    // Inherited, and the interesting one: the source has a case for this
    // (`one_cases_minting_cannot_vouch_for_another`) whose docstring states the
    // hazard exactly -- and the case cannot detect it. It puts the foreign stamp
    // on the NEGATIVE case, and `load_corpus` sorts by directory, so
    // `observation_unavailable` is graded FIRST and nothing has minted anything
    // by the time it is checked. Verified against interlock at 65f36c5: the same
    // corpus yields the same order there.
    //
    // The discriminator needs two POSITIVE cases: grading the first mints its
    // own onset and deadline, so a foreign stamp on the second equal to the
    // first's deadline passes under an interleaved check and fails under the
    // upfront one.
    const root = caseRoot("fixtures");
    const onset = 30_000;
    const budget = 300_000;
    writeCase(root, "aaa_gap", "graded_first", {
      label: positiveLabel({
        incident_class: "aaa_gap",
        onset_offset_ms: onset,
        budget_ms: budget,
      }),
    });
    writeCase(root, "zzz_gap", "graded_second", {
      label: positiveLabel({
        incident_class: "zzz_gap",
        onset_offset_ms: onset,
        budget_ms: budget,
      }),
    });
    writeCase(root, "mmm_outage", "probe_down", { label: negativeLabel() });
    const corpus = loadCorpus(root);
    expect(
      corpus.cases.map((one) => one.caseId),
      "the fixture only discriminates while a POSITIVE case is graded first",
    ).toEqual(["aaa_gap/graded_first", "mmm_outage/probe_down", "zzz_gap/graded_second"]);

    const clock = new SyntheticClock(T0);
    // Never handed to clock.at(): it is exactly the instant grading the FIRST
    // case will mint as that case's deadline.
    const firstCasesDeadline = T0 + onset + budget;
    const refusal = expectRefusal(
      () =>
        evaluate(corpus, {
          clock,
          outcomes: outcomes({
            "aaa_gap/graded_first": [],
            "mmm_outage/probe_down": [],
            "zzz_gap/graded_second": [
              new ProducedIncident({
                incidentClass: "zzz_gap",
                factState: "EXPLICIT_BLOCK",
                createdAtMs: firstCasesDeadline,
              }),
            ],
          }),
        }),
      ClockNotSynthetic,
    );
    expect(refusal.message).toContain("zzz_gap/graded_second");
  });

  test("a rate over an empty denominator is null, not zero", () => {
    // Inherited. Unreachable through loadCorpus -- it refuses a corpus with no
    // positives or no negatives, so neither denominator can be zero -- but
    // FixtureEvaluation is exported and a caller can build one, and interlock's
    // is equally reachable and equally untested.
    //
    // The distinction is the module's own stated design: printing 0.00 for a
    // rate over zero cases is the harness claiming a result it has no cases to
    // support.
    const evaluation = new FixtureEvaluation({
      corpusRoot: "/nowhere",
      contentDigest: "0".repeat(64),
      t0Ms: T0,
      composition: new Map([
        ["positive", 0],
        ["negative", 0],
        ["total", 0],
      ]),
      outcomes: [],
    });
    expect(evaluation.missRate()).toBeNull();
    expect(evaluation.falsePositiveRate()).toBeNull();
    expect(renderFixtureReport(evaluation)).toContain("no denominator");
  });

  test("the latency percentiles are nearest-rank, on a sample where interpolation would differ", () => {
    // Inherited. The shipped-corpus report case detects every positive at the
    // same 45 s, so a median over identical values is identical under either
    // rule. Interlock's sample is the same.
    //
    // Three distinct latencies separate them: nearest rank at 0.5 over n=3 is
    // ceil(1.5) = the 2nd smallest; an interpolating median would return the
    // midpoint, which here is the same value -- so the discriminating figure is
    // p90, where nearest rank gives the 3rd and interpolation gives a value
    // between the 2nd and the 3rd that no detection exhibited.
    const root = caseRoot("fixtures");
    for (const [index, klass] of ["aaa_gap", "bbb_gap", "ccc_gap"].entries()) {
      writeCase(root, klass, "one", {
        label: positiveLabel({ incident_class: klass, onset_offset_ms: 0, budget_ms: 600_000 }),
      });
      void index;
    }
    writeCase(root, "mmm_outage", "probe_down", { label: negativeLabel() });
    const corpus = loadCorpus(root);
    const clock = new SyntheticClock(T0);
    const produced = new Map<string, readonly ProducedIncident[]>();
    const latencies = [10_000, 20_000, 100_000];
    let next = 0;
    for (const one of corpus.cases) {
      if (one.isNegative) {
        produced.set(one.caseId, []);
        continue;
      }
      produced.set(one.caseId, [
        new ProducedIncident({
          incidentClass: one.expected.incidentClass,
          factState: one.expected.factState,
          createdAtMs: clock.at(latencies[next++] as number),
        }),
      ]);
    }
    const text = renderFixtureReport(evaluate(corpus, { clock, outcomes: produced }));

    // p90: ceil(0.9 * 3) = 3 -> the 3rd smallest, 100000. An interpolating p90
    // over [10000, 20000, 100000] is 84000, a latency nothing exhibited.
    expect(text).toContain("p90 100000 ms");
    expect(text).not.toContain("p90 84000 ms");
    expect(text).toContain("median 20000 ms");
  });

  test("the rendered rate goes through formatFixed, not toFixed", () => {
    // Inherited liveness gap, the same shape as the one closed in the
    // false-termination belt: D-0104's oracle proves formatFixed is correct but
    // not that this module calls it, and no ported case drives a rate to an
    // exact tie.
    //
    // One miss in eight positives is 0.125, which is one: CPython rounds half to
    // even and prints 0.12, toFixed rounds half away from zero and prints 0.13.
    const root = caseRoot("fixtures");
    const classes = Array.from({ length: 8 }, (_, index) => `c${index}_gap`);
    for (const klass of classes) {
      writeCase(root, klass, "one", {
        label: positiveLabel({ incident_class: klass, onset_offset_ms: 0, budget_ms: 600_000 }),
      });
    }
    writeCase(root, "zzz_outage", "probe_down", { label: negativeLabel() });
    const corpus = loadCorpus(root);
    const clock = new SyntheticClock(T0);
    const produced = new Map<string, readonly ProducedIncident[]>();
    let missed = false;
    for (const one of corpus.cases) {
      if (one.isNegative) {
        produced.set(one.caseId, []);
        continue;
      }
      if (!missed) {
        // Exactly one miss, so the rate is 1/8 = 0.125.
        missed = true;
        produced.set(one.caseId, []);
        continue;
      }
      produced.set(one.caseId, [
        new ProducedIncident({
          incidentClass: one.expected.incidentClass,
          factState: one.expected.factState,
          createdAtMs: clock.at(1_000),
        }),
      ]);
    }
    const evaluation = evaluate(corpus, { clock, outcomes: produced });
    expect(evaluation.missRate()).toBe(0.125);

    const text = renderFixtureReport(evaluation);
    expect(text).toContain("miss rate 0.12");
    expect(text).not.toContain("miss rate 0.13");
    // Named explicitly so a failure says which formatter it got.
    expect((0.125).toFixed(2), "the tie toFixed gets wrong").toBe("0.13");
  });
  test("a fixture file that is not valid UTF-8 is refused, not silently repaired", () => {
    // Target-only, and a PORT DIVERGENCE the review caught. Python's
    // `read_text(encoding="utf-8")` raises UnicodeDecodeError, so the source
    // refuses the file. Node's `readFileSync(path, "utf8")` is lenient: an
    // invalid byte becomes U+FFFD and the read succeeds.
    //
    // Silent repair is the worst outcome available here, because the content
    // digest is taken over the RAW BYTES: the corpus would load, grade, and
    // report under a digest that identifies bytes it did not evaluate. Fixed
    // with the same fatal TextDecoder D-0015 uses for migration step files.
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "relay_gap", "stalled_relay", { label: positiveLabel() });
    // 0xFF is not valid UTF-8 in any position.
    writeFileSync(join(casePath, "trace.jsonl"), Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));

    const refusal = expectRefusal(() => loadCase(casePath), FixtureRefusal);
    expect(refusal.message).toContain("not valid UTF-8");
    expect(refusal.message).toContain("content digest");
  });

  test("an integer beyond MAX_SAFE_INTEGER is refused rather than silently rounded", () => {
    // Target-only, and the second PORT DIVERGENCE from the same review.
    // Python's ints are arbitrary precision, so the source accepts
    // 9007199254740993 exactly. JSON.parse has already rounded it to ...992 by
    // the time any check runs, and `Number.isInteger` still says yes -- so the
    // fixture would be graded against a number that is not in its bytes, with
    // the onset, deadline and latency all wrong under a digest still claiming
    // to identify this corpus.
    //
    // Refusing rejects an input the source accepts. That is the better error,
    // and it is the posture D-0007 already records for this runtime beyond
    // 2^53. A millisecond offset past 2^53 is some 285,000 years.
    const root = caseRoot("fixtures");
    const casePath = writeCase(root, "relay_gap", "stalled_relay", {
      // Written as raw JSON text: passing the number through a JS literal would
      // round it before it ever reached the file.
      label:
        '{"incident_class":"relay_gap","onset_offset_ms":9007199254740993,' +
        '"tolerance_ms":180000,"budget_ms":300000,"fact_state":"EXPLICIT_BLOCK",' +
        '"must_not_recommend":[],"provenance":"accident: x"}',
    });
    const refusal = expectRefusal(() => loadCase(casePath), LabelMalformed);
    expect(refusal.message).toContain("MAX_SAFE_INTEGER");
    expect(refusal.message).toContain("D-0007");

    // The same rule on the trace's offsets and on the clock.
    const traceCase = writeCase(root, "relay_gap", "big_offset", {
      label: positiveLabel({ onset_offset_ms: 0 }),
      trace: '{"offset_ms": 9007199254740993, "kind": "x"}\n',
    });
    expectRefusal(() => loadCase(traceCase), TraceMalformed);
    // Built by arithmetic rather than written as a literal: a literal past 2^53
    // is itself precision-losing, which the linter rightly refuses. 2^53 is the
    // first integer Number.isSafeInteger rejects.
    const beyondSafe = Number.MAX_SAFE_INTEGER + 1;
    expect(Number.isInteger(beyondSafe), "still an integer, which is the trap").toBe(true);
    expect(Number.isSafeInteger(beyondSafe)).toBe(false);
    expectRefusal(() => new SyntheticClock(beyondSafe), EvaluationRefusal);
    expectRefusal(() => new SyntheticClock(T0).at(beyondSafe), EvaluationRefusal);
  });

  test("a float-valued label number is refused, as Python's isinstance(int) does", () => {
    // Target-only, and a PORT DIVERGENCE the review caught. Python's json.loads
    // gives `1.0` and `1e3` as FLOAT, and the source's _require_int does
    // isinstance(value, int), so both are refused. JavaScript has one number
    // type: JSON.parse collapses `300000.0`, `3e5` and `300000` to the same
    // value, and by the time any check runs the distinction the source refuses
    // on is gone.
    //
    // Preserved at parse time instead, from the reviver's source text. Written
    // as raw JSON because a JS literal cannot carry the distinction either.
    const root = caseRoot("fixtures");
    const withFloat = writeCase(root, "relay_gap", "float_budget", {
      label:
        '{"incident_class":"relay_gap","onset_offset_ms":30000,' +
        '"tolerance_ms":180000,"budget_ms":300000.0,' +
        '"fact_state":"EXPLICIT_BLOCK","must_not_recommend":[],' +
        '"provenance":"accident: x"}',
    });
    const refusal = expectRefusal(() => loadCase(withFloat), LabelMalformed);
    expect(refusal.message).toContain("budget_ms must be an integer");
    // The token as written in the file, so an operator knows what to edit.
    expect(refusal.message).toContain("300000.0");

    // Exponent notation is a float in Python too.
    const withExponent = writeCase(root, "relay_gap", "exponent_onset", {
      label:
        '{"incident_class":"relay_gap","onset_offset_ms":3e4,' +
        '"tolerance_ms":180000,"budget_ms":300000,' +
        '"fact_state":"EXPLICIT_BLOCK","must_not_recommend":[],' +
        '"provenance":"accident: x"}',
    });
    expectRefusal(() => loadCase(withExponent), LabelMalformed);

    // ...and the trace's offsets follow the same rule.
    const floatOffset = writeCase(root, "relay_gap", "float_offset", {
      label: positiveLabel({ onset_offset_ms: 0 }),
      trace: '{"offset_ms": 0.0, "kind": "x"}\n',
    });
    expectRefusal(() => loadCase(floatOffset), TraceMalformed);

    // A negative case's windowed fields must still be null, and a float there
    // is not null -- so the marker is refused by that rule too.
    const floatOnNegative = writeCase(root, "observation_unavailable", "probe_down", {
      label:
        '{"incident_class":"none","onset_offset_ms":1.5,"tolerance_ms":null,' +
        '"budget_ms":null,"fact_state":"OBSERVATION_UNAVAILABLE",' +
        '"must_not_recommend":[],"provenance":"accident: x"}',
    });
    const negativeRefusal = expectRefusal(() => loadCase(floatOnNegative), LabelMalformed);
    expect(negativeRefusal.message).toContain("onset_offset_ms");
  });

  test("the clock refuses a sum beyond MAX_SAFE_INTEGER, not only its operands", () => {
    // Target-only, completing the safe-integer fix. Both operands can be safe
    // while their sum is not, and that failure is worse than either: with t0
    // near 2^53, at(2) and at(3) round to the SAME instant, so two detections a
    // millisecond apart become one and the latency computed from them is simply
    // wrong. Python's ints add exactly, so the source has nothing to check.
    const nearTheCeiling = Number.MAX_SAFE_INTEGER - 1;
    const clock = new SyntheticClock(nearTheCeiling);
    // One past the ceiling is still exact.
    expect(clock.at(1)).toBe(Number.MAX_SAFE_INTEGER);
    // Two is not, and would collide with three.
    expect(nearTheCeiling + 2, "the collision this refuses").toBe(nearTheCeiling + 3);
    expectRefusal(() => clock.at(2), EvaluationRefusal);
    expectRefusal(() => clock.at(3), EvaluationRefusal);
  });

  test("the corpus walk orders case ids by code point, as Python does", () => {
    // Target-only, and it protects the claim this belt makes hardest: the
    // corpus content digest is taken over cases in SORTED order and is
    // documented as the corpus's identity across both runtimes. JavaScript's
    // default sort compares UTF-16 code units and Python compares code points,
    // and the two disagree for every supplementary character -- so a corpus with
    // one in a case name would digest differently here while both sides
    // believed they agreed.
    //
    // U+10000 encodes as the surrogate pair D800 DC00, so JavaScript's own sort
    // puts it FIRST; Python puts it after U+E000.
    const root = caseRoot("fixtures");
    const astral = `${String.fromCodePoint(0x10000)}_gap`;
    const bmp = `${String.fromCodePoint(0xe000)}_gap`;
    writeCase(root, astral, "one", { label: positiveLabel({ incident_class: astral }) });
    writeCase(root, bmp, "one", { label: positiveLabel({ incident_class: bmp }) });
    writeCase(root, "observation_unavailable", "probe_down", { label: negativeLabel() });

    const order = loadCorpus(root).cases.map((one) => one.classDir);
    // Python's order. The native sort would have put the astral name first.
    expect(order).toEqual(["observation_unavailable", bmp, astral]);
    expect([astral, bmp].sort(), "what the native sort would have done").toEqual([astral, bmp]);
  });

  test("the composition map is copied, not borrowed", () => {
    // Target-only. Every other collection on FixtureEvaluation goes through
    // frozenList; composition was assigned straight from the caller's argument,
    // and a Map is assignable to ReadonlyMap -- so a caller keeping its
    // reference could set a new denominator into a published evaluation and
    // silently change every rate rendered from it.
    const mutable = new Map([
      ["positive", 2],
      ["negative", 2],
      ["total", 4],
    ]);
    const evaluation = new FixtureEvaluation({
      corpusRoot: "/nowhere",
      contentDigest: "0".repeat(64),
      t0Ms: T0,
      composition: mutable,
      outcomes: [],
    });
    mutable.set("positive", 999);
    expect(evaluation.composition.get("positive")).toBe(2);
    expect((evaluation.composition as unknown as { set?: unknown }).set).toBeUndefined();
  });

  test("a case with very many matching incidents is graded, not crashed", () => {
    // Target-only. `Math.min(...array)` is the obvious spelling of "the
    // earliest alarm" and it is not safe: the spread becomes one argument per
    // element and V8 throws past roughly a hundred thousand of them. Python's
    // min() takes an iterable and has no such ceiling, so a detector noisy
    // enough to emit that many incidents for one case would crash this harness
    // and not interlock's -- turning a report about a bad detector into no
    // report at all.
    //
    // 200_000 is comfortably past the limit and still runs in well under a
    // second, because the incidents are constructed once and the clock mints
    // one instant.
    const corpus = loadCorpus(minimalCorpus(caseRoot("fixtures")));
    const clock = new SyntheticClock(T0);
    const at = clock.at(75_000);
    const noisy = Array.from(
      { length: 200_000 },
      () =>
        new ProducedIncident({
          incidentClass: "relay_gap",
          factState: "EXPLICIT_BLOCK",
          createdAtMs: at,
        }),
    );
    const evaluation = evaluate(corpus, {
      clock,
      outcomes: outcomes({ [RELAY_CASE]: noisy, [OUTAGE_CASE]: [] }),
    });
    const outcome = outcomeFor(evaluation, RELAY_CASE);
    expect(outcome.verdict).toBe(DETECTED);
    expect(outcome.latencyMs).toBe(45_000);
    expect(outcome.matchingIncidents).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// The corpus this belt ships.
// ---------------------------------------------------------------------------

describe("the shipped corpus", () => {
  test("the shipped corpus loads and reports its composition", () => {
    // It loads, it has negatives, and the composition is what the report
    // prints.
    const corpus = loadCorpus(SHIPPED_CORPUS);
    const composition = corpus.composition();

    expect(composition.get("total")).toBe(corpus.cases.length);
    expect(composition.get("positive") ?? 0).toBeGreaterThanOrEqual(1);
    // A stall negative and an outage negative.
    expect(composition.get("negative") ?? 0).toBeGreaterThanOrEqual(2);
    expect((composition.get("positive") ?? 0) + (composition.get("negative") ?? 0)).toBe(
      composition.get("total"),
    );
    expect(new Set(corpus.cases.map((one) => one.caseId))).toContain(
      "relay_gap/escalation_received_never_presented",
    );

    const negatives = new Set(corpus.negatives().map((one) => one.expected.factState));
    // D-0006's two non-anomalies, both present: an unobservable worker and a
    // quiet one. A corpus missing either lets the detector that alarms on it
    // through.
    expect(negatives).toContain("OBSERVATION_UNAVAILABLE");
    expect(negatives).toContain("NO_ACTIVITY_EVIDENCE");

    const terminateCases = corpus.cases.filter((one) =>
      one.expected.mustNotRecommend.some((recommendation) => recommendation.includes("terminate")),
    );
    expect(
      terminateCases.length,
      "at least one case must forbid terminating its subject",
    ).toBeGreaterThan(0);
  });

  test("every shipped onset is an observation in its own trace", () => {
    // The onset is the state entry, which means it is a moment the trace
    // contains. This is the check that catches the labelling error section 3.2
    // warns about: a label whose onset is the TOLERANCE CROSSING is a number
    // computed from T, and it would not in general coincide with any
    // observation.
    for (const one of loadCorpus(SHIPPED_CORPUS).positives()) {
      const offsets = new Set(one.observations.map((observation) => observation.offsetMs));
      expect(offsets, one.caseId).toContain(one.expected.onsetOffsetMs);
      // And it is not the crossing: onset + T is a different instant.
      expect(one.expected.toleranceMs ?? 0, one.caseId).toBeGreaterThan(0);
    }
  });

  test("shipped labels match the policy revision they claim", () => {
    // T and L in a label are the seeded revision's numbers, not invented ones.
    // The label carries copies on purpose (interlock D-0031: a past case is
    // recomputed under the numbers it was judged by), and a copy nobody checks
    // is a copy that drifts.
    const database = join(caseRoot("fixtures"), "control_plane.sqlite3");
    const connection: SqliteDatabase = createProductionControlPlane(database, { nowMs: T0 });
    try {
      const row = connection
        .prepare<[string], { revision_id: number }>(
          "SELECT revision_id FROM policy_revision WHERE note = ?",
        )
        .get(SEED_NOTE);
      if (row === undefined) {
        expect.fail("0002_policy_seed.sql must have applied");
      }
      const revisionId = Number(row.revision_id);
      let checked = 0;
      for (const one of loadCorpus(SHIPPED_CORPUS).positives()) {
        const policyRow = detectionLatency(connection, {
          revisionId,
          incidentClass: one.expected.incidentClass,
        });
        if (policyRow.budgetKind !== "absolute_ms") {
          continue; // relative classes need a subject; not a shipped case yet
        }
        expect(one.expected.budgetMs, one.caseId).toBe(policyRow.budgetMs);
        if (policyRow.thresholdKind === "absolute_ms") {
          expect(one.expected.toleranceMs, one.caseId).toBe(policyRow.thresholdValue);
        }
        checked += 1;
      }
      expect(checked).toBeGreaterThanOrEqual(1);
    } finally {
      connection.close();
    }
  });

  test("the carried corpus digests to interlock's own value (target-only)", () => {
    // Target-only: translates no source case, and it is the parity evidence for
    // a piece of DATA rather than of code.
    //
    // test/fixtures/labelled/ is carried byte-for-byte from interlock's
    // tests/fixtures/labelled/. The digest is a sha256 over the ordered bytes of
    // every case file, so it is the one assertion that proves BOTH halves at
    // once: that the files arrived unaltered, and that this port's digest
    // construction -- the id, NUL, filename, NUL, bytes, NUL layout, over cases
    // sorted by id -- agrees with the source's.
    //
    // The expected value was computed by running interlock's own load_corpus
    // against interlock's own tree at 65f36c5, not by running this code and
    // writing down what it said.
    //
    // Two ways this could silently rot, both of which it catches: a formatter
    // reflowing the JSON (biome.json excludes this tree for exactly that
    // reason), and a checkout materialising CRLF (.gitattributes pins eol=lf).
    const corpus = loadCorpus(SHIPPED_CORPUS);
    expect(corpus.contentDigest).toBe(
      "1b498122287a8443e6a259ecf9904fe8bc90c517dbfa588dfae176e595b18847",
    );
    expect(corpus.cases.length).toBe(3);
  });

  test("the report is ascii and prints composition beside both rates", () => {
    // One table, because that coupling is the measurement (section 3.2).
    //
    // The source asserts ASCII by encoding to cp932 as well as to ascii: a
    // single em-dash crashes --help on a Japanese console. JavaScript has no
    // cp932 encoder, and it needs none -- ASCII is a strict subset of cp932, so
    // `isAscii` implies both of the source's assertions and neither is lost.
    const corpus = loadCorpus(SHIPPED_CORPUS);
    const clock = new SyntheticClock(T0);
    const produced = new Map<string, readonly ProducedIncident[]>();
    for (const one of corpus.cases) {
      produced.set(
        one.caseId,
        one.isNegative
          ? []
          : [
              new ProducedIncident({
                incidentClass: one.expected.incidentClass,
                factState: one.expected.factState,
                createdAtMs: clock.at((one.expected.onsetOffsetMs as number) + 45_000),
              }),
            ],
      );
    }
    const text = renderFixtureReport(evaluate(corpus, { clock, outcomes: produced }));

    expect(isAscii(text)).toBe(true);
    expect(text).toContain("positive cases");
    expect(text).toContain("negative cases");
    expect(text).toContain("miss rate");
    expect(text).toContain("fp rate");
    expect(text).toContain("median 45000 ms");
    expect(text).toContain(corpus.contentDigest);
  });
});

describe("hostile values in the rendering (target-only)", () => {
  test("a case id cannot forge a line and cannot reach a cp932 console", () => {
    // Target-only, and `D-0109`. A case id is a directory name and the corpus
    // root is a filesystem path, both chosen by whoever laid out the corpus,
    // and both went into the report verbatim.
    // The corpus root is a filesystem path, so the hostile value is a
    // directory name: nothing stops an operator from putting the corpus under
    // one with a character cp932 cannot encode.
    const root = join(caseRoot("fixtures"), "corpus\u2014dir");
    mkdirSync(root, { recursive: true });
    writeCase(root, "relay_gap", "stalled\u2014one", { label: positiveLabel() });
    // A POSITIVE case with no outcome is a miss, and a miss carries a note --
    // which is what puts the id on a line of its own in the section below.
    writeCase(root, "relay_gap", "b\nCases needing a reader", { label: positiveLabel() });
    writeCase(root, "observation_unavailable", "quiet", { label: negativeLabel() });
    const corpus = loadCorpus(root);
    const clock = new SyntheticClock(T0);
    // Every case needs an outcome, empty or not: the evaluator refuses to score
    // a case the detector never ran (OutcomeMissing).
    const evaluation = evaluate(corpus, {
      clock,
      outcomes: new Map(corpus.cases.map((one) => [one.caseId, []])),
    });

    const rendered = renderFixtureReport(evaluation);

    expect(isAscii(rendered)).toBe(true);
    expect(rendered).toContain("\\u000a");
    // The root and the case id are separate call sites, so each is asserted
    // where it prints rather than through one "somewhere in the text" check.
    const rootLine = rendered.split("\n").find((line) => line.startsWith("  corpus root"));
    expect(rootLine).toContain("corpus\\u2014dir");
    expect(rendered).toContain("stalled\\u2014one");
    // "Cases needing a reader" is a heading this renderer writes. The forged id
    // must not produce a second one.
    expect(rendered.split("\n").filter((line) => line === "Cases needing a reader")).toHaveLength(
      1,
    );
  });
});
