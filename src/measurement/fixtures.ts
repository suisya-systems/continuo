import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import { comparePythonStrings, formatFixed, pythonRepr, reportValue } from "./format.js";
import { frozenList, readOnlyMap } from "./immutable.js";

/**
 * G6 -- AC-10's ground truth: the labelled corpus, its loader, and its
 * evaluator.
 *
 * The failure this module is written against is a harness that grades itself.
 * `docs/measurement-harness.md` section 3.1 states it exactly: **Interlock's own
 * tables cannot contain a miss.** A missed condition produces no `incident` row,
 * so an aggregate over `incident` counts what was detected and is structurally
 * blind to what was not; and the latencies that survive are the fast ones by
 * definition, because a slow detection that never happened contributes no row to
 * slow the distribution down. A harness that reads only our rows therefore
 * measures its own recall as 100% and its own latency as excellent, and it does
 * so on a database with nothing wrong in it. No amount of care in the query
 * fixes that -- the number the query needs is not in the table.
 *
 * Interlock `D-0039` puts the ground truth **outside** the thing being measured,
 * and the source implemented here is source A, the labelled corpus: a set of
 * traces whose correct outcome was decided by a human before any detector ran,
 * so a condition that produces no incident is still on the record as a
 * condition. Source B (the shadow reconciliation against v1) is the other half
 * and is deliberately not here, because it only exists **during** the canary --
 * and AC-10 is a gate *on* the canary.
 *
 * **The layout is section 3.2's, verbatim.**
 *
 * ```text
 * <root>/<class>/<case>/
 *     trace.jsonl     -- the observations, each with an offset in ms from t0
 *     expected.json   -- the label
 * ```
 *
 * The corpus root is a parameter, not a constant. The corpus this belt ships
 * lives at `test/fixtures/labelled/`, carried byte-identically from interlock so
 * the two content digests agree.
 *
 * **`onset_offset_ms` is when the condition BEGAN, and that is not a detail.**
 * It is the state entry -- the instant the escalation was received, the instant
 * the probe started failing -- and **not** the tolerance crossing.
 * `time-base-policy.md` section 3.1 is why: `T` is part of `L`, not a head start
 * on it. Label the crossing instead and every fixture silently acquires an extra
 * `T` of slack, so an alarm that landed at `T + L` -- a detector one full
 * tolerance over its budget -- is graded as having landed inside it. For
 * `relay_gap` that is a three-minute error on a five-minute budget: the corpus
 * would pass the detector it exists to fail.
 *
 * **Negative cases are mandatory, and the build fails without them.** Interlock
 * `D-0006` requires observation-failure fixtures alongside stall fixtures, and
 * section 3.2 spells out the arithmetic: a corpus of only positive cases lets a
 * detector that alarms on *everything* score a perfect miss rate. So
 * {@link loadCorpus} **refuses** a corpus with no negative cases rather than
 * warning about it -- a warning is read once, by the person who already knows,
 * and never again.
 *
 * **The composition is reported for the same reason.** Miss rate and
 * false-positive rate print in one table over one corpus
 * ({@link renderFixtureReport}), so a recall improvement bought by widening
 * every predicate shows up in the same table as the false positives it bought.
 * That coupling *is* the measurement.
 *
 * **A malformed fixture is refused, never skipped.** A skipped fixture is a
 * silently shrunken corpus: the run stays green, the case count drops, and the
 * one number that would have shown it -- the composition -- moves in the
 * direction that looks like progress. Every refusal here names the case.
 *
 * **The clock is structural, not a convention.** Section 3.2 requires detection
 * latency to be exact rather than sampled, which means the detector under test
 * must read the injected clock and not a wall clock. So {@link SyntheticClock}
 * **mints** every instant it hands out and {@link evaluate} refuses an incident
 * stamped with an instant this clock never minted.
 *
 * **Scope.** This module loads and grades. It runs no detector, raises no
 * incident, applies no remedy and opens no control-plane database -- it reads
 * files the caller names and the outcomes the caller hands it. It writes
 * nothing, anywhere.
 */

export const TRACE_FILENAME = "trace.jsonl";
export const EXPECTED_FILENAME = "expected.json";

/**
 * The only two files a case directory may hold.
 *
 * Exactly two, because a third file is either an input nothing reads -- in which
 * case the case is graded against less than it contains -- or a leftover, and
 * neither is something a ground-truth corpus should carry silently.
 */
export const CASE_FILES: readonly string[] = frozenList([TRACE_FILENAME, EXPECTED_FILENAME]);

/**
 * The literal section 3.2 gives a negative case.
 *
 * Spelled out rather than encoded as `null` in the JSON: a reader of
 * `expected.json` sees the word and knows the case is deliberate, where a `null`
 * reads as a field somebody forgot to fill in -- and the difference between
 * "this must raise nothing" and "unlabelled" is the difference between a
 * false-positive test and a gap.
 */
export const NONE_CLASS = "none";

/**
 * The seven fields of section 3.2's table.
 *
 * **All seven are required on every case**, positive and negative alike; three
 * of them are `null` on a negative case but the key is still there. A missing
 * key is a refusal and never a default, because the default that would be chosen
 * -- an empty `must_not_recommend`, a zero onset -- is in every case the value
 * that makes the fixture easiest to pass.
 */
export const LABEL_FIELDS: readonly string[] = frozenList([
  "incident_class",
  "onset_offset_ms",
  "tolerance_ms",
  "budget_ms",
  "fact_state",
  "must_not_recommend",
  "provenance",
]);

/**
 * Interlock `D-0005`'s closed set.
 *
 * The `incident` table deliberately carries **no** `CHECK` for it: a `CHECK`
 * would turn a `D-` entry extending the set into a migration step. That
 * reasoning governs the persisted schema and does not govern a fixture label,
 * where the opposite risk dominates: a label with a mistyped fact state is a
 * fixture no detector can ever satisfy and no test can ever fail informatively.
 */
export const FACT_STATES: readonly string[] = frozenList([
  "ACTIVE_EVIDENCE",
  "KNOWN_WAIT",
  "EXPLICIT_BLOCK",
  "NO_ACTIVITY_EVIDENCE",
  "OBSERVATION_UNAVAILABLE",
  "TERMINAL",
]);

/**
 * Section 3.2: "where the case came from: an accident, a dogfood capture, or a
 * constructed edge".
 *
 * A closed set, because the field exists to answer "is this corpus made of
 * things that happened, or of things we imagined" -- and free text cannot be
 * counted. Detail may follow a colon.
 */
export const PROVENANCE_KINDS: readonly string[] = frozenList([
  "accident",
  "dogfood_capture",
  "constructed_edge",
]);

/**
 * What one case resolved to.
 *
 * Four names, not two: a negative case that produced nothing is a **result**,
 * not the absence of one, and it is the only evidence the corpus holds that the
 * detector is not simply alarming on everything.
 */
export const DETECTED = "detected";
export const MISS = "miss";
export const FALSE_POSITIVE = "false_positive";
export const TRUE_NEGATIVE = "true_negative";

export const VERDICTS: readonly string[] = frozenList([
  DETECTED,
  MISS,
  FALSE_POSITIVE,
  TRUE_NEGATIVE,
]);

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/** A fixture the corpus cannot stand behind, named rather than skipped. */
export class FixtureRefusal extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "FixtureRefusal";
    Object.setPrototypeOf(this, FixtureRefusal.prototype);
  }
}

/**
 * A case directory is missing `trace.jsonl` or `expected.json`.
 *
 * Half a case is not a smaller case: a trace with no label has no correct
 * outcome, and a label with no trace grades a detector against nothing.
 */
export class CaseIncomplete extends FixtureRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CaseIncomplete";
    Object.setPrototypeOf(this, CaseIncomplete.prototype);
  }
}

/**
 * The corpus tree holds something that is not a case and not a README.
 *
 * A stray file at class level, or a third file inside a case, is either an input
 * nothing loads or a leftover. Both are refused for the same reason a malformed
 * case is: the alternative is a corpus whose contents and whose reported
 * composition disagree.
 */
export class StrayEntryRefused extends FixtureRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "StrayEntryRefused";
    Object.setPrototypeOf(this, StrayEntryRefused.prototype);
  }
}

/** `expected.json` is missing a field, or a field has an unusable value. */
export class LabelMalformed extends FixtureRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "LabelMalformed";
    Object.setPrototypeOf(this, LabelMalformed.prototype);
  }
}

/** `trace.jsonl` is unparseable, empty, or not ordered by offset. */
export class TraceMalformed extends FixtureRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "TraceMalformed";
    Object.setPrototypeOf(this, TraceMalformed.prototype);
  }
}

/**
 * A positive case sits under a class directory that is not its class.
 *
 * The directory is what the composition table groups by, so a case filed under
 * `relay_gap` and labelled `consumer_backlog` makes the table report coverage of
 * a class that has none. A **negative** case may sit under any class directory
 * -- the directory then names the detector the case is aimed at, which is
 * exactly what "an outage that must not raise `relay_gap`" means -- so the rule
 * is one-sided on purpose.
 */
export class ClassDirectoryMismatch extends FixtureRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ClassDirectoryMismatch";
    Object.setPrototypeOf(this, ClassDirectoryMismatch.prototype);
  }
}

/** The corpus as a whole cannot support the claim AC-10 makes on it. */
export class CorpusCompositionRefused extends FixtureRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CorpusCompositionRefused";
    Object.setPrototypeOf(this, CorpusCompositionRefused.prototype);
  }
}

/**
 * The corpus has no negative case, so it cannot detect a loud detector.
 *
 * Interlock `D-0039` and section 3.2 both make negatives mandatory, and the
 * arithmetic is the argument: a detector that raises every class on every trace
 * scores a **perfect** miss rate on a positive-only corpus. The refusal is at
 * build time and is not a warning, because a warning leaves a green suite behind
 * it and green is what everyone reads.
 */
export class NegativeCasesRequired extends CorpusCompositionRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "NegativeCasesRequired";
    Object.setPrototypeOf(this, NegativeCasesRequired.prototype);
  }
}

/**
 * The corpus has no positive case, so it cannot detect a silent detector.
 *
 * The mirror of {@link NegativeCasesRequired}: a detector that raises nothing at
 * all scores a perfect false-positive rate over negatives alone. Section 3.2
 * names only the negative half because that is the half a corpus loses by
 * accident, but a corpus that cannot express a miss is not AC-10's ground truth
 * either.
 */
export class PositiveCasesRequired extends CorpusCompositionRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PositiveCasesRequired";
    Object.setPrototypeOf(this, PositiveCasesRequired.prototype);
  }
}

/** The evaluation cannot be carried out over the inputs it was handed. */
export class EvaluationRefusal extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "EvaluationRefusal";
    Object.setPrototypeOf(this, EvaluationRefusal.prototype);
  }
}

/**
 * A case in the corpus was handed no detector outcome.
 *
 * Treating an absent entry as "the detector produced nothing" is the one default
 * this module must not take: a harness that failed to run half the corpus would
 * then report those cases as misses (for positives) and as clean true negatives
 * (for negatives), and the second half of that is a wiring bug scoring points.
 */
export class OutcomeMissing extends EvaluationRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "OutcomeMissing";
    Object.setPrototypeOf(this, OutcomeMissing.prototype);
  }
}

/**
 * An outcome names a case this corpus does not contain.
 *
 * Ignoring it would hide the two ways it happens -- a renamed case, or an
 * evaluation run against a different corpus than the one loaded -- and both
 * produce a report about cases nobody graded.
 */
export class UnknownCaseInOutcomes extends EvaluationRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnknownCaseInOutcomes";
    Object.setPrototypeOf(this, UnknownCaseInOutcomes.prototype);
  }
}

/**
 * An incident is stamped with an instant the synthetic clock never minted.
 *
 * Section 3.2 requires latency to be exact rather than sampled, which is only
 * true if the detector read the injected clock. An instant from anywhere else --
 * a wall clock, a second clock, arithmetic on `t0` that bypassed the clock --
 * makes the reported latency a measurement of the test runner, and the resulting
 * drift is indistinguishable in the report from a detector that got slower.
 */
export class ClockNotSynthetic extends EvaluationRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ClockNotSynthetic";
    Object.setPrototypeOf(this, ClockNotSynthetic.prototype);
  }
}

/**
 * A matching incident predates the labelled onset of its own condition.
 *
 * The latency would be negative, and a negative latency has exactly two causes:
 * the label's onset is wrong, or the detector alarmed on something other than
 * this condition. Both are defects in the ground truth itself, and clamping to
 * zero or filing the case as detected would let the corpus certify a detector
 * using evidence the corpus knows is broken.
 */
export class IncidentBeforeOnset extends EvaluationRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "IncidentBeforeOnset";
    Object.setPrototypeOf(this, IncidentBeforeOnset.prototype);
  }
}

// --------------------------------------------------------------------------
// the loaded shapes
// --------------------------------------------------------------------------

/**
 * One line of `trace.jsonl`.
 *
 * `fields` carries every key other than `offset_ms` and `kind` unread and
 * unvalidated. The observation vocabulary belongs to the detectors, not to the
 * grader: a loader that validated it would have to be edited every time a
 * detector learned a new signal, and the edit would be made by whoever was
 * adding the signal.
 */
export class Observation {
  readonly offsetMs: number;
  readonly kind: string;
  readonly fields: ReadonlyMap<string, unknown>;

  constructor(fields: {
    readonly offsetMs: number;
    readonly kind: string;
    readonly fields: ReadonlyMap<string, unknown>;
  }) {
    this.offsetMs = fields.offsetMs;
    this.kind = fields.kind;
    this.fields = fields.fields;
    Object.freeze(this);
  }
}

/**
 * Section 3.2's seven fields, as loaded.
 *
 * `toleranceMs` and `budgetMs` are the `T` and `L` of the policy revision the
 * case was labelled under, copied into the label on purpose: section 3.2 asks
 * what the condition was *entitled* to, and a corpus that resolved them live
 * would silently re-grade every past case the day a revision changed a budget --
 * which is precisely what interlock `D-0031` versions policy to prevent.
 */
export class ExpectedLabel {
  readonly incidentClass: string;
  readonly onsetOffsetMs: number | null;
  readonly toleranceMs: number | null;
  readonly budgetMs: number | null;
  readonly factState: string;
  readonly mustNotRecommend: readonly string[];
  readonly provenance: string;

  constructor(fields: {
    readonly incidentClass: string;
    readonly onsetOffsetMs: number | null;
    readonly toleranceMs: number | null;
    readonly budgetMs: number | null;
    readonly factState: string;
    readonly mustNotRecommend: readonly string[];
    readonly provenance: string;
  }) {
    this.incidentClass = fields.incidentClass;
    this.onsetOffsetMs = fields.onsetOffsetMs;
    this.toleranceMs = fields.toleranceMs;
    this.budgetMs = fields.budgetMs;
    this.factState = fields.factState;
    this.mustNotRecommend = frozenList(fields.mustNotRecommend);
    this.provenance = fields.provenance;
    Object.freeze(this);
  }

  /** Is this a `none` case -- one that must raise no anomaly? */
  get isNegative(): boolean {
    return this.incidentClass === NONE_CLASS;
  }

  /**
   * `onsetOffsetMs + budgetMs`, the instant a miss becomes a miss.
   *
   * `null` on a negative case, which has no window: a false positive counts
   * wherever in the trace it lands.
   */
  get deadlineOffsetMs(): number | null {
    if (this.isNegative) {
      return null;
    }
    // Both are non-null on a positive case: the loader refuses one that is not.
    return (this.onsetOffsetMs as number) + (this.budgetMs as number);
  }
}

/** One labelled case: its trace, its label, and where it came from on disk. */
export class FixtureCase {
  readonly caseId: string;
  readonly classDir: string;
  readonly name: string;
  readonly path: string;
  readonly observations: readonly Observation[];
  readonly expected: ExpectedLabel;

  constructor(fields: {
    readonly caseId: string;
    readonly classDir: string;
    readonly name: string;
    readonly path: string;
    readonly observations: readonly Observation[];
    readonly expected: ExpectedLabel;
  }) {
    this.caseId = fields.caseId;
    this.classDir = fields.classDir;
    this.name = fields.name;
    this.path = fields.path;
    this.observations = frozenList(fields.observations);
    this.expected = fields.expected;
    Object.freeze(this);
  }

  get isNegative(): boolean {
    return this.expected.isNegative;
  }
}

/**
 * Every case under one root, with the digest that pins this exact content.
 *
 * `contentDigest` is a sha256 over the ordered bytes of every case file. It is
 * here because section 6 requires a report to carry a `fixture_suite_ref` -- and
 * a case count alone does not identify a corpus: editing one label changes every
 * number the report prints and moves no count at all. The same argument section
 * 6 makes for `db_fingerprint` being a content hash rather than a row count,
 * applied to the corpus.
 */
export class FixtureCorpus {
  readonly root: string;
  readonly cases: readonly FixtureCase[];
  readonly contentDigest: string;

  constructor(fields: {
    readonly root: string;
    readonly cases: readonly FixtureCase[];
    readonly contentDigest: string;
  }) {
    this.root = fields.root;
    this.cases = frozenList(fields.cases);
    this.contentDigest = fields.contentDigest;
    Object.freeze(this);
  }

  positives(): readonly FixtureCase[] {
    return frozenList(this.cases.filter((one) => !one.isNegative));
  }

  negatives(): readonly FixtureCase[] {
    return frozenList(this.cases.filter((one) => one.isNegative));
  }

  /**
   * Positive, negative and total counts -- section 3.2's reported figure.
   *
   * Reported beside the rates and never on its own: the miss rate over a corpus
   * is only as meaningful as the negatives that bound it, and the composition is
   * what lets a reader see a recall gain and the false-positive count it was
   * bought with in one place.
   */
  composition(): ReadonlyMap<string, number> {
    const positive = this.positives().length;
    const negative = this.negatives().length;
    return readOnlyMap([
      ["positive", positive],
      ["negative", negative],
      ["total", positive + negative],
    ]);
  }

  /** Case count per class directory, so a thin class is visible. */
  byClassDir(): ReadonlyMap<string, number> {
    const tally = new Map<string, number>();
    for (const one of this.cases) {
      tally.set(one.classDir, (tally.get(one.classDir) ?? 0) + 1);
    }
    return readOnlyMap([...tally].sort(([left], [right]) => comparePythonStrings(left, right)));
  }

  case(caseId: string): FixtureCase {
    for (const one of this.cases) {
      if (one.caseId === caseId) {
        return one;
      }
    }
    throw new FixtureRefusal(`no case ${pythonRepr(caseId)} in the corpus at ${this.root}`);
  }
}

/**
 * The evaluation's only source of instants, and the record of what it gave.
 *
 * Every offset a detector is run at goes through {@link at}, which mints
 * `t0Ms + offsetMs` and remembers it. {@link evaluate} then refuses any incident
 * stamped with an instant this clock did not mint, which is what makes "the
 * clock is synthetic" a property of the harness rather than a rule detectors are
 * asked to follow.
 *
 * Minting is deliberately *recording* rather than monotonic advancing: a
 * detector may be replayed over a trace in any order the harness likes, and
 * forcing a single moving hand would make the clock a schedule as well as a
 * clock. What matters here is only that no instant enters the report that did
 * not come from `t0` plus a declared offset.
 */
export class SyntheticClock {
  readonly #t0Ms: number;
  readonly #minted: Set<number>;

  constructor(t0Ms: number) {
    if (!Number.isSafeInteger(t0Ms)) {
      // Safe, not merely integral: past 2^53 the arithmetic this clock does --
      // t0 + offset -- stops being exact, so an instant it minted would not
      // compare equal to the one a detector was handed (D-0007).
      throw new EvaluationRefusal(
        `t0_ms must be an integer epoch-ms instant within ` +
          `Number.MAX_SAFE_INTEGER (D-0007), got ${describe(t0Ms)}`,
      );
    }
    this.#t0Ms = t0Ms;
    this.#minted = new Set([t0Ms]);
  }

  get t0Ms(): number {
    return this.#t0Ms;
  }

  /** The instant `offsetMs` after `t0`, minted and remembered. */
  at(offsetMs: number): number {
    if (!Number.isSafeInteger(offsetMs)) {
      throw new EvaluationRefusal(
        `offset_ms must be an integer within Number.MAX_SAFE_INTEGER (D-0007), got ${describe(offsetMs)}`,
      );
    }
    if (offsetMs < 0) {
      throw new EvaluationRefusal(
        `offset_ms=${offsetMs} precedes t0; a trace's offsets are measured ` +
          `forward from t0 (measurement-harness.md section 3.2)`,
      );
    }
    const instant = this.#t0Ms + offsetMs;
    if (!Number.isSafeInteger(instant)) {
      // Both operands can be safe while their sum is not, and the failure is
      // silent and worse than either: with t0 near 2^53, at(2) and at(3) round
      // to the SAME instant, so two detections a millisecond apart become one
      // and the latency computed from them is simply wrong. Python's ints add
      // exactly, so the source has nothing to check here (D-0007).
      throw new EvaluationRefusal(
        `t0_ms=${this.#t0Ms} plus offset_ms=${offsetMs} is beyond ` +
          `Number.MAX_SAFE_INTEGER, so the instant cannot be represented ` +
          `exactly and two distinct offsets could mint the same one (D-0007)`,
      );
    }
    this.#minted.add(instant);
    return instant;
  }

  /** The offset of `instantMs` from `t0`, for reporting. */
  offsetOf(instantMs: number): number {
    return instantMs - this.#t0Ms;
  }

  /** Did this clock hand out `instantMs`? */
  minted(instantMs: number): boolean {
    return this.#minted.has(instantMs);
  }
}

/**
 * One incident a detector raised while being replayed over a case.
 *
 * `incidentClass` is an explicit field and not something parsed out of a
 * `dedup_key`: the `incident` table carries no class column on purpose, the
 * class reaching the row as data, and a grader that recovered it by splitting a
 * key would be grading the key format. `factState` is required for the same
 * reason the column is `NOT NULL` -- interlock `D-0005`'s fact is what an
 * incident *is*, and a negative case is graded on it.
 *
 * `appliedRecommendations` holds only recommendations that were **applied**.
 * Section 3.4 is emphatic: interlock `D-0004` and AC-6 mean the AI cannot
 * terminate anything, so a false termination is an applied `action`, and
 * counting recommendations here would grade Interlock's suggestions against v1's
 * executions.
 */
export class ProducedIncident {
  readonly incidentClass: string;
  readonly factState: string;
  readonly createdAtMs: number;
  readonly appliedRecommendations: readonly string[];

  constructor(fields: {
    readonly incidentClass: string;
    readonly factState: string;
    readonly createdAtMs: number;
    readonly appliedRecommendations?: readonly string[];
  }) {
    this.incidentClass = fields.incidentClass;
    this.factState = fields.factState;
    this.createdAtMs = fields.createdAtMs;
    this.appliedRecommendations = frozenList(fields.appliedRecommendations ?? []);
    Object.freeze(this);
  }
}

/** How one case resolved, with every number the verdict rests on. */
export class CaseOutcome {
  readonly caseId: string;
  readonly verdict: string;
  readonly latencyMs: number | null;
  readonly deadlineMs: number | null;
  readonly matchingIncidents: number;
  readonly lateLatencyMs: number | null;
  readonly otherClassIncidents: readonly string[];
  readonly factStateMismatches: readonly string[];
  readonly forbiddenApplied: readonly string[];

  constructor(fields: {
    readonly caseId: string;
    readonly verdict: string;
    readonly latencyMs: number | null;
    readonly deadlineMs: number | null;
    readonly matchingIncidents: number;
    readonly lateLatencyMs: number | null;
    readonly otherClassIncidents: readonly string[];
    readonly factStateMismatches: readonly string[];
    readonly forbiddenApplied: readonly string[];
  }) {
    this.caseId = fields.caseId;
    this.verdict = fields.verdict;
    this.latencyMs = fields.latencyMs;
    this.deadlineMs = fields.deadlineMs;
    this.matchingIncidents = fields.matchingIncidents;
    this.lateLatencyMs = fields.lateLatencyMs;
    this.otherClassIncidents = frozenList(fields.otherClassIncidents);
    this.factStateMismatches = frozenList(fields.factStateMismatches);
    this.forbiddenApplied = frozenList(fields.forbiddenApplied);
    Object.freeze(this);
  }
}

/** The graded corpus: verdicts, rates, latencies and the composition. */
export class FixtureEvaluation {
  readonly corpusRoot: string;
  readonly contentDigest: string;
  readonly t0Ms: number;
  readonly composition: ReadonlyMap<string, number>;
  readonly outcomes: readonly CaseOutcome[];

  constructor(fields: {
    readonly corpusRoot: string;
    readonly contentDigest: string;
    readonly t0Ms: number;
    readonly composition: ReadonlyMap<string, number>;
    readonly outcomes: readonly CaseOutcome[];
  }) {
    this.corpusRoot = fields.corpusRoot;
    this.contentDigest = fields.contentDigest;
    this.t0Ms = fields.t0Ms;
    // Copied, not merely assigned: a `Map` is assignable to `ReadonlyMap`, so
    // a caller keeping its reference could `set` a new denominator into a
    // published evaluation and silently change every rate rendered from it.
    // Every other collection on this class already goes through frozenList.
    this.composition = readOnlyMap(fields.composition);
    this.outcomes = frozenList(fields.outcomes);
    Object.freeze(this);
  }

  /**
   * Per-verdict counts, all four keys present **even at zero**.
   *
   * An absent key reads as "nothing to report" when it means "this report was
   * produced by code that did not look" -- and the key most likely to be zero
   * here, `false_positive`, is the one whose zero is the claim.
   */
  counts(): ReadonlyMap<string, number> {
    const tally = new Map<string, number>(
      VERDICTS.map((verdict): [string, number] => [verdict, 0]),
    );
    for (const outcome of this.outcomes) {
      const seen = tally.get(outcome.verdict);
      if (seen === undefined) {
        // The source indexes a pre-seeded dict, so an unknown verdict raises
        // KeyError there. A RangeError rather than an EvaluationRefusal for the
        // reason windows.ts gives at the same shape: KeyError is outside the
        // refusal family, and a caller catching refusals must not swallow what
        // means a CaseOutcome was built with a verdict no grader produces.
        throw new RangeError(
          `case ${pythonRepr(outcome.caseId)} carries verdict ` +
            `${pythonRepr(outcome.verdict)}, which is not one of ` +
            `${VERDICTS.join(", ")}`,
        );
      }
      tally.set(outcome.verdict, seen + 1);
    }
    return readOnlyMap(tally);
  }

  idsFor(verdict: string): readonly string[] {
    if (!VERDICTS.includes(verdict)) {
      throw new EvaluationRefusal(`${pythonRepr(verdict)} is not one of ${VERDICTS.join(", ")}`);
    }
    return frozenList(
      this.outcomes.filter((one) => one.verdict === verdict).map((one) => one.caseId),
    );
  }

  /**
   * Misses over positive cases, or `null` with no positive cases.
   *
   * `null` rather than zero: a rate over an empty denominator is not a good
   * score, and printing `0.0` for it is the harness claiming a result it has no
   * cases to support.
   */
  missRate(): number | null {
    const positives = this.composition.get("positive") ?? 0;
    if (positives === 0) {
      return null;
    }
    return this.idsFor(MISS).length / positives;
  }

  /** False positives over negative cases, `null` with no negatives. */
  falsePositiveRate(): number | null {
    const negatives = this.composition.get("negative") ?? 0;
    if (negatives === 0) {
      return null;
    }
    return this.idsFor(FALSE_POSITIVE).length / negatives;
  }

  /**
   * Detection latencies, ascending, over detected cases only.
   *
   * Misses contribute nothing on purpose and that is *not* a silent drop: the
   * miss count is printed beside the distribution, because a latency
   * distribution that improved by turning slow detections into misses must not
   * read as an improvement.
   */
  latenciesMs(): readonly number[] {
    return frozenList(
      this.outcomes
        .map((one) => one.latencyMs)
        .filter((latency): latency is number => latency !== null)
        .sort((left, right) => left - right),
    );
  }

  /**
   * `[caseId, recommendation]` for every applied forbidden action.
   *
   * Section 3.4's shape: counted at the applied effect, not at the
   * recommendation.
   */
  forbiddenApplied(): readonly (readonly [string, string])[] {
    return frozenList(
      this.outcomes.flatMap((outcome) =>
        outcome.forbiddenApplied.map((recommendation) => [outcome.caseId, recommendation] as const),
      ),
    );
  }
}

// --------------------------------------------------------------------------
// loading
// --------------------------------------------------------------------------

function refuseLabel(casePath: string, message: string): LabelMalformed {
  return new LabelMalformed(`${casePath}/${EXPECTED_FILENAME}: ${message}`);
}

function requireInt(
  value: unknown,
  options: { readonly field: string; readonly casePath: string; readonly minimum?: number },
): number {
  const minimum = options.minimum ?? 0;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw refuseLabel(
      options.casePath,
      `${options.field} must be an integer, got ${describe(value)}`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    // Python's ints are arbitrary precision, so the source accepts this value
    // exactly. `JSON.parse` has already rounded it -- 9007199254740993 arrives
    // as ...992 and `Number.isInteger` still says yes -- so accepting it would
    // grade the fixture against a number that is not in its bytes, and the
    // onset, deadline and latency computed from it would all be wrong while the
    // content digest still claimed to identify this corpus.
    //
    // Refusing diverges from the source by rejecting an input it accepts, and
    // that is the better error: D-0007 already records that beyond 2^53 this
    // runtime is lossy and that a module handling such values must opt in
    // explicitly. A millisecond offset past 2^53 is some 285,000 years, so
    // nothing legitimate is being turned away.
    throw refuseLabel(
      options.casePath,
      `${options.field}=${value} is beyond Number.MAX_SAFE_INTEGER, so it ` +
        `cannot be represented exactly and JSON.parse has already rounded it ` +
        `(D-0007); a fixture graded against a number that is not in its bytes ` +
        `is worse than one that is refused`,
    );
  }
  if (value < minimum) {
    throw refuseLabel(options.casePath, `${options.field}=${value} must be >= ${minimum}`);
  }
  return value;
}

/**
 * Section 3.2's table, checked field by field.
 *
 * The one rule not stated in the table and derived here: on a **negative** case
 * `onset_offset_ms`, `tolerance_ms` and `budget_ms` must be `null`. A `none`
 * case has no condition, so it has no state entry to measure from and no budget
 * it was entitled to; a number in those fields would be a window, and a window
 * would suggest a false positive counts only inside it. It does not -- an alarm
 * on a healthy worker is wrong at every offset, so the whole trace is the test.
 */
function parseLabel(payload: unknown, casePath: string): ExpectedLabel {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw refuseLabel(casePath, "the label must be a JSON object");
  }
  const label = payload as Record<string, unknown>;

  const missing = LABEL_FIELDS.filter((field) => !Object.hasOwn(label, field));
  if (missing.length > 0) {
    throw refuseLabel(
      casePath,
      `missing required field(s) ${[...missing].sort(comparePythonStrings).join(", ")}; section 3.2 ` +
        `requires all seven, and every default that could be chosen for a ` +
        `missing one makes the fixture easier to pass`,
    );
  }
  const unknown = Object.keys(label).filter((field) => !LABEL_FIELDS.includes(field));
  if (unknown.length > 0) {
    throw refuseLabel(
      casePath,
      `unknown field(s) ${[...unknown].sort(comparePythonStrings).join(", ")}; a field nothing reads ` +
        `is a label the grader ignores`,
    );
  }

  const incidentClass = label["incident_class"];
  if (typeof incidentClass !== "string" || incidentClass === "") {
    throw refuseLabel(
      casePath,
      `incident_class must be a non-empty string or ${pythonRepr(NONE_CLASS)}, ` +
        `got ${describe(incidentClass)}`,
    );
  }

  const factState = label["fact_state"];
  if (typeof factState !== "string" || !FACT_STATES.includes(factState)) {
    throw refuseLabel(
      casePath,
      `fact_state=${describe(factState)} is not one of D-0005's closed set ` +
        `(${FACT_STATES.join(", ")}); a seventh state is a new D- entry, not a fixture`,
    );
  }

  const provenance = label["provenance"];
  if (typeof provenance !== "string" || provenance.trim() === "") {
    throw refuseLabel(
      casePath,
      `provenance must be a non-empty string, got ${describe(provenance)}`,
    );
  }
  const kind = (provenance.split(":", 1)[0] ?? "").trim();
  if (!PROVENANCE_KINDS.includes(kind)) {
    throw refuseLabel(
      casePath,
      `provenance kind ${pythonRepr(kind)} is not one of ${PROVENANCE_KINDS.join(", ")}; ` +
        `the field exists to answer whether this corpus is made of things that ` +
        `happened or things we imagined, and free text cannot be counted`,
    );
  }

  const recommendations = label["must_not_recommend"];
  if (
    !Array.isArray(recommendations) ||
    recommendations.some((item) => typeof item !== "string" || item === "")
  ) {
    throw refuseLabel(
      casePath,
      `must_not_recommend must be a list of non-empty strings, got ` +
        `${describe(recommendations)} (an empty list is allowed and says so)`,
    );
  }

  const windowed = ["onset_offset_ms", "tolerance_ms", "budget_ms"];
  let onset: number | null = null;
  let tolerance: number | null = null;
  let budget: number | null = null;
  if (incidentClass === NONE_CLASS) {
    const present = windowed.filter((field) => label[field] !== null);
    if (present.length > 0) {
      throw refuseLabel(
        casePath,
        `a negative case must leave ${present.join(", ")} null: it has no ` +
          `condition, so no state entry to measure from and no budget it was ` +
          `entitled to, and a false positive is wrong at every offset rather ` +
          `than inside a window`,
      );
    }
  } else {
    onset = requireInt(label["onset_offset_ms"], { field: "onset_offset_ms", casePath });
    tolerance = requireInt(label["tolerance_ms"], { field: "tolerance_ms", casePath });
    budget = requireInt(label["budget_ms"], { field: "budget_ms", casePath, minimum: 1 });
    if (tolerance > budget) {
      throw refuseLabel(
        casePath,
        `tolerance_ms=${tolerance} exceeds budget_ms=${budget}; T is part of L, ` +
          `not a head start on it (time-base-policy.md section 3.1), so a label ` +
          `with T > L describes a class whose detector is out of budget before ` +
          `it is allowed to look`,
      );
    }
  }

  return new ExpectedLabel({
    incidentClass,
    onsetOffsetMs: onset,
    toleranceMs: tolerance,
    budgetMs: budget,
    factState,
    mustNotRecommend: recommendations as string[],
    provenance,
  });
}

/**
 * The observations, in the order the detector will see them.
 *
 * Offsets must be non-decreasing. A trace that goes backwards would hand a
 * replayed detector an observation from before the one it already processed, and
 * a detector that behaved differently under that ordering would be graded on a
 * world no clock can produce.
 */
function parseTrace(text: string, casePath: string): readonly Observation[] {
  const observations: Observation[] = [];
  let previous = -1;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    if (line.trim() === "") {
      continue;
    }
    let payload: unknown;
    try {
      payload = parseFixtureJson(line);
    } catch (error) {
      throw new TraceMalformed(
        `${casePath}/${TRACE_FILENAME} line ${number}: not JSON (${String(error)})`,
        { cause: error },
      );
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new TraceMalformed(
        `${casePath}/${TRACE_FILENAME} line ${number}: each observation must be a JSON object`,
      );
    }
    const observation = payload as Record<string, unknown>;
    if (!Object.hasOwn(observation, "offset_ms")) {
      throw new TraceMalformed(
        `${casePath}/${TRACE_FILENAME} line ${number}: no offset_ms; section 3.2 ` +
          `makes every observation an offset in ms from t0, and an observation ` +
          `with no time cannot be replayed`,
      );
    }
    const offset = observation["offset_ms"];
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      throw new TraceMalformed(
        `${casePath}/${TRACE_FILENAME} line ${number}: offset_ms must be a ` +
          `non-negative integer, got ${describe(offset)}`,
      );
    }
    const kind = observation["kind"];
    if (typeof kind !== "string" || kind === "") {
      throw new TraceMalformed(
        `${casePath}/${TRACE_FILENAME} line ${number}: kind must be a non-empty ` +
          `string, got ${describe(kind)}`,
      );
    }
    if (offset < previous) {
      throw new TraceMalformed(
        `${casePath}/${TRACE_FILENAME} line ${number}: offset_ms=${offset} ` +
          `precedes the previous observation's ${previous}; a trace is replayed ` +
          `in file order and must not go backwards`,
      );
    }
    previous = offset;
    observations.push(
      new Observation({
        offsetMs: offset,
        kind,
        fields: readOnlyMap(
          Object.entries(observation).filter(([key]) => key !== "offset_ms" && key !== "kind"),
        ),
      }),
    );
  }
  if (observations.length === 0) {
    throw new TraceMalformed(
      `${casePath}/${TRACE_FILENAME} holds no observations; a case with an empty ` +
        `trace grades a detector against nothing and would score as a clean true negative`,
    );
  }
  return frozenList(observations);
}

/**
 * Load one `<class>/<case>/` directory, refusing anything malformed.
 *
 * `classDir` defaults to the parent directory's name, which is what
 * {@link loadCorpus} passes; it is a parameter so a caller loading a single case
 * out of tree still gets the class-directory check rather than skipping it.
 *
 * @throws {CaseIncomplete} a required file is absent.
 * @throws {StrayEntryRefused} the directory holds a third file.
 * @throws {LabelMalformed} `expected.json` fails section 3.2's table.
 * @throws {TraceMalformed} `trace.jsonl` is unparseable, empty or unordered.
 * @throws {ClassDirectoryMismatch} a positive case is filed under another class.
 */
export function loadCase(
  casePath: string,
  options: { readonly classDir?: string } = {},
): FixtureCase {
  if (!isDirectory(casePath)) {
    throw new CaseIncomplete(`${casePath} is not a directory`);
  }
  const classDir = options.classDir ?? basename(dirname(casePath));

  const present = new Set(readdirSync(casePath));
  const missing = CASE_FILES.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new CaseIncomplete(
      `${casePath} is missing ${missing.join(", ")}; half a case has no correct ` +
        `outcome to grade against`,
    );
  }
  const stray = [...present]
    .filter((name) => !CASE_FILES.includes(name))
    .sort(comparePythonStrings);
  if (stray.length > 0) {
    throw new StrayEntryRefused(
      `${casePath} holds ${stray.join(", ")} beside the two case files; an input ` +
        `nothing loads is a case graded against less than it contains`,
    );
  }

  let labelPayload: unknown;
  try {
    labelPayload = parseFixtureJson(readCaseFile(join(casePath, EXPECTED_FILENAME)));
  } catch (error) {
    if (error instanceof FixtureRefusal) {
      throw error;
    }
    throw refuseLabel(casePath, `not JSON (${String(error)})`);
  }
  const expected = parseLabel(labelPayload, casePath);
  const observations = parseTrace(readCaseFile(join(casePath, TRACE_FILENAME)), casePath);

  if (!expected.isNegative && expected.incidentClass !== classDir) {
    throw new ClassDirectoryMismatch(
      `${casePath} is filed under class directory ${pythonRepr(classDir)} but is ` +
        `labelled ${pythonRepr(expected.incidentClass)}; the composition table ` +
        `groups by directory, so this case would report coverage of a class it ` +
        `does not test`,
    );
  }

  return new FixtureCase({
    caseId: `${classDir}/${basename(casePath)}`,
    classDir,
    name: basename(casePath),
    path: casePath,
    observations,
    expected,
  });
}

/**
 * sha256 over the ordered bytes of every case file.
 *
 * Content, not counts, for section 6's reason: editing one label changes every
 * number a report prints and moves no count at all, so a suite reference built
 * from counts would certify two materially different corpora as the same one.
 *
 * The byte layout is interlock's exactly -- case id, NUL, filename, NUL, file
 * bytes, NUL, per file in `CASE_FILES` order, over cases sorted by id -- because
 * the digest is the corpus's identity across both runtimes. `test/fixtures/
 * labelled/` digests to the same value here as it does there, which is asserted.
 */
function digestOf(cases: readonly FixtureCase[]): string {
  const digest = createHash("sha256");
  const NUL = Buffer.from([0]);
  const ordered = [...cases].sort((left, right) => comparePythonStrings(left.caseId, right.caseId));
  for (const one of ordered) {
    for (const filename of CASE_FILES) {
      digest.update(Buffer.from(one.caseId, "utf8"));
      digest.update(NUL);
      digest.update(Buffer.from(filename, "utf8"));
      digest.update(NUL);
      digest.update(readFileSync(join(one.path, filename)));
      digest.update(NUL);
    }
  }
  return digest.digest("hex");
}

/**
 * Load every case under `root`, refusing a corpus AC-10 cannot rest on.
 *
 * Walks `<root>/<class>/<case>/` exactly as section 3.2 lays it out. A
 * `README.md` at either level is allowed and ignored; every other stray entry is
 * refused, because the corpus and its reported composition must not be able to
 * disagree.
 *
 * @throws {NegativeCasesRequired} the corpus has no `none` case.
 * @throws {PositiveCasesRequired} the corpus has no labelled condition.
 */
export function loadCorpus(root: string): FixtureCorpus {
  if (!isDirectory(root)) {
    throw new FixtureRefusal(`corpus root ${root} is not a directory`);
  }

  const cases: FixtureCase[] = [];
  for (const classEntry of readdirSync(root).sort(comparePythonStrings)) {
    if (classEntry === "README.md" || classEntry.startsWith(".")) {
      continue;
    }
    const classPath = join(root, classEntry);
    if (!isDirectory(classPath)) {
      throw new StrayEntryRefused(
        `${classPath} is not a class directory; section 3.2's layout is <root>/<class>/<case>/`,
      );
    }
    for (const caseEntry of readdirSync(classPath).sort(comparePythonStrings)) {
      if (caseEntry === "README.md" || caseEntry.startsWith(".")) {
        continue;
      }
      const casePath = join(classPath, caseEntry);
      if (!isDirectory(casePath)) {
        throw new StrayEntryRefused(
          `${casePath} is not a case directory; section 3.2's layout is <root>/<class>/<case>/`,
        );
      }
      // No duplicate check: `caseId` is `<class>/<case>`, which is the path, so
      // the filesystem already guarantees uniqueness. A defensive check here
      // would be code no input can reach, and unreachable code is the kind that
      // stops being true quietly.
      cases.push(loadCase(casePath, { classDir: classEntry }));
    }
  }

  const corpus = new FixtureCorpus({ root, cases, contentDigest: digestOf(cases) });
  const composition = corpus.composition();
  if ((composition.get("negative") ?? 0) === 0) {
    throw new NegativeCasesRequired(
      `the corpus at ${root} has ${composition.get("positive")} positive case(s) ` +
        `and no negative case; D-0006 requires observation-failure fixtures ` +
        `alongside stall fixtures, and a detector that alarms on everything ` +
        `scores a perfect miss rate over positives alone ` +
        `(measurement-harness.md section 3.2, D-0039)`,
    );
  }
  if ((composition.get("positive") ?? 0) === 0) {
    throw new PositiveCasesRequired(
      `the corpus at ${root} has ${composition.get("negative")} negative case(s) ` +
        `and no positive case, so it cannot express a miss at all; a detector ` +
        `that raises nothing scores a perfect false-positive rate over negatives alone`,
    );
  }
  return corpus;
}

// --------------------------------------------------------------------------
// grading
// --------------------------------------------------------------------------

/**
 * Detected or missed, by section 3.2's definition of a match.
 *
 * A match is an incident **of the labelled class** raised at or before
 * `t0 + onset_offset_ms + budget_ms`. Incidents of other classes are recorded
 * rather than counted: they are neither the detection this case asks for nor a
 * false positive this case can prove, and a grader that quietly accepted one
 * would let a detector pass by raising the wrong alarm loudly.
 */
function gradePositive(
  one: FixtureCase,
  incidents: readonly ProducedIncident[],
  clock: SyntheticClock,
): CaseOutcome {
  const expected = one.expected;
  const onsetMs = clock.at(expected.onsetOffsetMs as number);
  const deadlineMs = clock.at(expected.deadlineOffsetMs as number);

  const inBudget: number[] = [];
  const late: number[] = [];
  const otherClasses: string[] = [];
  const mismatchedStates: string[] = [];
  for (const incident of incidents) {
    if (incident.incidentClass !== expected.incidentClass) {
      otherClasses.push(incident.incidentClass);
      continue;
    }
    if (incident.factState !== expected.factState) {
      // Not a reason to withhold the detection -- section 3.2 defines a match by
      // class -- but never swallowed either: an alarm of the right class
      // carrying the wrong D-0005 fact is a detector that found the condition
      // and described it as something else, and that is what the Dispatcher AI
      // will read.
      mismatchedStates.push(incident.factState);
    }
    if (incident.createdAtMs < onsetMs) {
      throw new IncidentBeforeOnset(
        `${one.caseId}: an incident of class ${pythonRepr(incident.incidentClass)} ` +
          `is stamped ${onsetMs - incident.createdAtMs} ms before the labelled ` +
          `onset; the latency would be negative, which means either the label's ` +
          `onset or the detector's attribution is wrong`,
      );
    }
    if (incident.createdAtMs <= deadlineMs) {
      inBudget.push(incident.createdAtMs);
    } else {
      late.push(incident.createdAtMs);
    }
  }

  const forbidden = forbiddenAppliedFor(one, incidents);
  if (inBudget.length > 0) {
    // The earliest alarm is the detection: a second incident for one condition
    // is a re-notification, and grading on the last one would report the
    // detector's repeat interval as its latency.
    return new CaseOutcome({
      caseId: one.caseId,
      verdict: DETECTED,
      latencyMs: smallest(inBudget) - onsetMs,
      deadlineMs,
      matchingIncidents: inBudget.length,
      lateLatencyMs: null,
      otherClassIncidents: otherClasses,
      factStateMismatches: mismatchedStates,
      forbiddenApplied: forbidden,
    });
  }
  return new CaseOutcome({
    caseId: one.caseId,
    verdict: MISS,
    latencyMs: null,
    deadlineMs,
    matchingIncidents: 0,
    // A late alarm is still a miss (section 3.2 defines a miss by the budget)
    // but it is a different miss from silence, and the report says which: one is
    // a detector that is slow, the other a detector that is blind, and the fixes
    // have nothing in common.
    lateLatencyMs: late.length > 0 ? smallest(late) - onsetMs : null,
    otherClassIncidents: otherClasses,
    factStateMismatches: mismatchedStates,
    forbiddenApplied: forbidden,
  });
}

/**
 * False positive or true negative, judged on interlock `D-0005`'s fact.
 *
 * A negative case is not "the detector must emit nothing". AC-3 requires the
 * opposite for the case that matters most: an observation outage **must** be
 * classified `OBSERVATION_UNAVAILABLE`, and a row saying so is the required
 * output rather than an alarm. `D-0006` says the same for `NO_ACTIVITY_EVIDENCE`,
 * which is explicitly not an anomaly. So the label's `factState` is what the
 * detector is permitted to say, and a false positive is an incident carrying
 * **any other** fact -- the outage read as a stall, the quiet worker read as
 * dead. Grading a negative case as "produced no row at all" would fail a
 * detector for obeying AC-3.
 */
function gradeNegative(one: FixtureCase, incidents: readonly ProducedIncident[]): CaseOutcome {
  const offending = incidents
    .filter((incident) => incident.factState !== one.expected.factState)
    .map((incident) => incident.factState);
  const conforming = incidents.length - offending.length;
  return new CaseOutcome({
    caseId: one.caseId,
    verdict: offending.length > 0 ? FALSE_POSITIVE : TRUE_NEGATIVE,
    latencyMs: null,
    deadlineMs: null,
    matchingIncidents: conforming,
    lateLatencyMs: null,
    otherClassIncidents: incidents
      .filter((incident) => incident.factState !== one.expected.factState)
      .map((incident) => incident.incidentClass),
    factStateMismatches: offending,
    forbiddenApplied: forbiddenAppliedFor(one, incidents),
  });
}

/**
 * Recommendations in `must_not_recommend` that were actually applied.
 *
 * Section 3.4: the count is at the applied effect. A recommendation the
 * Secretary or a human declined is not a false termination -- it is the human
 * gate working -- and folding it in here would report the gate's value as a
 * defect.
 */
function forbiddenAppliedFor(
  one: FixtureCase,
  incidents: readonly ProducedIncident[],
): readonly string[] {
  const forbidden = new Set(one.expected.mustNotRecommend);
  return incidents.flatMap((incident) =>
    incident.appliedRecommendations.filter((recommendation) => forbidden.has(recommendation)),
  );
}

/**
 * Grade `corpus` against what a detector produced, on a synthetic clock.
 *
 * `outcomes` maps `caseId` to the incidents the detector raised while being
 * replayed over that case. **Every case must appear**, an empty sequence
 * included: see {@link OutcomeMissing} for why an absent entry cannot be read as
 * "produced nothing".
 *
 * Every `createdAtMs` must be an instant `clock` minted, which is what makes the
 * reported latency exact rather than sampled.
 *
 * @throws {UnknownCaseInOutcomes} an outcome names a case not in the corpus.
 * @throws {IncidentBeforeOnset} a matching incident predates its own onset.
 */
export function evaluate(
  corpus: FixtureCorpus,
  options: {
    readonly clock: SyntheticClock;
    readonly outcomes: ReadonlyMap<string, readonly ProducedIncident[]>;
  },
): FixtureEvaluation {
  const { clock, outcomes } = options;
  const caseIds = new Set(corpus.cases.map((one) => one.caseId));

  const unknown = [...outcomes.keys()].filter((id) => !caseIds.has(id)).sort(comparePythonStrings);
  if (unknown.length > 0) {
    throw new UnknownCaseInOutcomes(
      `outcomes name case(s) not in this corpus: ${unknown.join(", ")} ` +
        `(corpus root ${corpus.root}); the report would be about cases nobody graded`,
    );
  }
  const missing = [...caseIds].filter((id) => !outcomes.has(id)).sort(comparePythonStrings);
  if (missing.length > 0) {
    throw new OutcomeMissing(
      `no detector outcome for case(s): ${missing.join(", ")}; pass an empty ` +
        `sequence to state that the detector produced nothing, so that a harness ` +
        `that failed to run a case cannot score it as a clean result`,
    );
  }

  // Every instant is checked BEFORE any case is graded, and the order is not
  // incidental: grading mints a case's own onset and deadline, so a check
  // interleaved with grading would let one case's minting vouch for the next
  // case's wall-clock stamp. The whole point of the check is that no instant
  // from outside the clock enters the report.
  for (const one of corpus.cases) {
    for (const incident of outcomes.get(one.caseId) ?? []) {
      if (!clock.minted(incident.createdAtMs)) {
        throw new ClockNotSynthetic(
          `${one.caseId}: incident created_at_ms=${incident.createdAtMs} was not ` +
            `minted by this evaluation's clock (t0=${clock.t0Ms}); latency ` +
            `measured against it would be sampled, not exact ` +
            `(measurement-harness.md section 3.2)`,
        );
      }
    }
  }

  const graded: CaseOutcome[] = [];
  for (const one of corpus.cases) {
    const incidents = outcomes.get(one.caseId) ?? [];
    graded.push(
      one.isNegative ? gradeNegative(one, incidents) : gradePositive(one, incidents, clock),
    );
  }

  return new FixtureEvaluation({
    corpusRoot: corpus.root,
    contentDigest: corpus.contentDigest,
    t0Ms: clock.t0Ms,
    composition: corpus.composition(),
    outcomes: graded,
  });
}

// --------------------------------------------------------------------------
// rendering
// --------------------------------------------------------------------------

/**
 * Render `evaluation` as plain ASCII text, composition first.
 *
 * ASCII only, `-` never an em-dash: this reaches a cp932 console, where a single
 * U+2014 turns a report into a `UnicodeEncodeError` (`D-0006`).
 *
 * The composition and both rates print in **one** table, which is section 3.2's
 * point rather than a layout preference: recall bought by widening every
 * predicate arrives as a false-positive regression, and it can only be read as a
 * trade if the reader sees both numbers without turning a page. There is no
 * pass/fail line -- interlock `Q-0005` leaves AC-10's threshold open, and a
 * verdict here would answer it by inertia.
 */
export function renderFixtureReport(evaluation: FixtureEvaluation): string {
  const counts = evaluation.counts();
  const composition = evaluation.composition;
  const latencies = evaluation.latenciesMs();
  const lines: string[] = [];
  lines.push("AC-10 fixture corpus -- labelled ground truth (source A)");
  // D-0109: a filesystem path is whatever the operator named the directory.
  lines.push(`  corpus root     ${reportValue(evaluation.corpusRoot)}`);
  lines.push(`  content digest  ${evaluation.contentDigest}`);
  lines.push(`  synthetic t0    ${evaluation.t0Ms} (epoch ms)`);
  lines.push("");

  lines.push("Composition and rates (one table on purpose)");
  lines.push(
    `  positive cases  ${composition.get("positive")}` +
      `    misses ${counts.get(MISS)}    miss rate ${rate(evaluation.missRate())}`,
  );
  lines.push(
    `  negative cases  ${composition.get("negative")}` +
      `    false positives ${counts.get(FALSE_POSITIVE)}` +
      `    fp rate ${rate(evaluation.falsePositiveRate())}`,
  );
  lines.push(`  total cases     ${composition.get("total")}`);
  lines.push("  a recall gain bought by widening predicates lands in the false-positive row above");
  lines.push("");

  lines.push("Verdicts");
  for (const verdict of VERDICTS) {
    lines.push(`  ${verdict.padEnd(15)} ${counts.get(verdict)}`);
  }
  lines.push("");

  lines.push("Detection latency, onset to incident (detected cases only)");
  if (latencies.length > 0) {
    lines.push(
      `  count ${latencies.length}` +
        `    median ${percentile(latencies, 0.5)} ms` +
        `    p90 ${percentile(latencies, 0.9)} ms` +
        `    max ${latencies[latencies.length - 1]} ms`,
    );
  } else {
    lines.push("  no detected case; the distribution is not computable");
  }
  lines.push(
    `  misses excluded from the distribution: ${counts.get(MISS)}` +
      `    (a distribution improved by missing the slow ones is not an improvement)`,
  );
  lines.push("");

  lines.push("Cases needing a reader");
  let reported = false;
  for (const outcome of evaluation.outcomes) {
    const notes: string[] = [];
    if (outcome.verdict === MISS) {
      notes.push(
        outcome.lateLatencyMs !== null
          ? `alarmed late at ${outcome.lateLatencyMs} ms after onset`
          : "no alarm of the labelled class at all",
      );
    }
    if (outcome.factStateMismatches.length > 0) {
      notes.push(`fact_state ${uniqueSorted(outcome.factStateMismatches).join(", ")}`);
    }
    if (outcome.otherClassIncidents.length > 0) {
      notes.push(`other classes raised: ${uniqueSorted(outcome.otherClassIncidents).join(", ")}`);
    }
    if (outcome.forbiddenApplied.length > 0) {
      notes.push(
        `APPLIED a forbidden recommendation: ${uniqueSorted(outcome.forbiddenApplied).join(", ")}`,
      );
    }
    if (notes.length > 0) {
      reported = true;
      // D-0109: a case id is a directory name, and the notes below carry
      // fact_state values and recommendation names read out of the corpus.
      lines.push(`  ${reportValue(outcome.caseId)} [${outcome.verdict}]`);
      for (const note of notes) {
        lines.push(`      ${reportValue(note)}`);
      }
    }
  }
  if (!reported) {
    lines.push("  none");
  }

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------

/**
 * Nearest-rank percentile over an ascending sequence.
 *
 * Nearest-rank rather than an interpolated one: an interpolated p90 over four
 * detections reports a latency no detection had, and a corpus is small by
 * construction. Clamped to the sequence at both ends, as the source's
 * `max(1, min(len, ceil(len * fraction)))` is.
 */
function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const rank = Math.max(1, Math.min(values.length, Math.ceil(values.length * fraction)));
  return values[rank - 1] as number;
}

/**
 * A rate, or the reason there is not one.
 *
 * `null` prints as "no denominator" rather than as `0.00`: a rate over zero cases
 * is not a good score. `formatFixed`, not `toFixed`, because the two disagree on
 * exact ties and a rate is `count / count` (`D-0104`).
 */
function rate(value: number | null): string {
  if (value === null) {
    return "no denominator";
  }
  return formatFixed(value, 2);
}

/** `", ".join(sorted(set(values)))`, which is what the source renders. */
function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(comparePythonStrings);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Python's `!r` for an arbitrary value, which the refusal messages interpolate. */
function describe(value: unknown): string {
  if (typeof value === "string") {
    return pythonRepr(value);
  }
  if (value === null) {
    return "None";
  }
  if (value === undefined) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (value instanceof NonIntegerNumber) {
    // The token as it appears in the file. Python would print its own float
    // repr (`1e3` as `1000.0`); showing the source text instead says what is
    // actually written there, which is what an operator has to edit. No ported
    // case asserts this wording (D-0017).
    return value.source;
  }
  return JSON.stringify(value) ?? String(value);
}

/**
 * The smallest of a non-empty list, without spreading it into arguments.
 *
 * `Math.min(...values)` is the obvious spelling and it is not safe here: the
 * spread becomes one argument per element, and V8 throws `RangeError: Maximum
 * call stack size exceeded` past roughly a hundred thousand of them. Python's
 * `min()` takes an iterable and has no such ceiling, so a detector noisy enough
 * to emit that many incidents for one case would crash this harness and not
 * interlock's -- turning a report about a bad detector into no report at all.
 */
function smallest(values: readonly number[]): number {
  let least = values[0] as number;
  for (const value of values) {
    if (value < least) {
      least = value;
    }
  }
  return least;
}

/**
 * A case file's bytes, decoded as UTF-8 **strictly**.
 *
 * Node's `readFileSync(path, "utf8")` is lenient: an invalid byte becomes
 * U+FFFD and the read succeeds. Python's `read_text(encoding="utf-8")` raises
 * `UnicodeDecodeError`, so the source refuses the file and this must too --
 * otherwise a corpus loads whose evaluated data differs from the bytes its
 * digest identifies, which is the one correspondence the digest exists to
 * guarantee.
 *
 * The same reasoning, and the same `TextDecoder({ fatal: true })`, as `D-0015`
 * gives for migration step files.
 */
function readCaseFile(path: string): string {
  const bytes = readFileSync(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new FixtureRefusal(
      `${path} is not valid UTF-8 (${String(error)}); a fixture whose bytes ` +
        `cannot be decoded would be graded as something other than what its ` +
        `content digest identifies`,
      { cause: error },
    );
  }
}

/**
 * A JSON number whose token was not an integer literal.
 *
 * Python's `json.loads` gives `1.0` and `1e3` as `float`, and the source's
 * `_require_int` does `isinstance(value, int)`, so both are refused. JavaScript
 * has one number type: `JSON.parse` collapses `1.0`, `1e3` and `1000` to the
 * same value, and by the time any check runs the distinction the source refuses
 * on is gone.
 *
 * So the distinction is preserved at parse time instead. The reviver sees each
 * value's **source text** and replaces a non-integer numeric token with this
 * marker, which is not a `number` and is therefore refused by exactly the checks
 * that would have refused a Python `float` -- including the negative-case rule,
 * where a float in a windowed field is still "not null".
 */
class NonIntegerNumber {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
    Object.freeze(this);
  }
}

/**
 * `json.loads`, with the integer/float distinction Python keeps and JavaScript
 * does not.
 *
 * Uses the reviver's source-text context (Node 21+), which is the only place the
 * original token survives. A number whose token is not an integer literal
 * becomes a {@link NonIntegerNumber}; everything else parses normally.
 */
function parseFixtureJson(text: string): unknown {
  return JSON.parse(text, function reviveNumbers(_key: string, value: unknown, context?: unknown) {
    if (typeof value !== "number") {
      return value;
    }
    const source = (context as { source?: unknown } | undefined)?.source;
    if (typeof source === "string" && !/^-?\d+$/.test(source)) {
      return new NonIntegerNumber(source);
    }
    return value;
  } as (key: string, value: unknown) => unknown);
}
