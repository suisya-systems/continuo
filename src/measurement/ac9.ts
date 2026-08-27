import type { Database as SqliteDatabase } from "better-sqlite3";

// Both imports are of writer-owned vocabulary, not of a write capability: the
// harness's read-only property lives on the connection (reader.ts) and this
// module never hands its connection anywhere. Importing beats copying for the
// same reason cohort.ts gives -- a second copy of a closed set agrees with the
// original right up until the day it matters.
import { USAGE_STATUSES } from "../control_plane/ai_invocation.js";
import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import type { RunCohort } from "./cohort.js";
import { comparePythonStrings, formatFixed, pythonRepr, reportValue } from "./format.js";
import { frozenList, readOnlyMap } from "./immutable.js";

/**
 * G6 -- AC-9's numerator, its companion series, coverage, and the four figures.
 *
 * The failure this module is written against is a *number that flatters the
 * thing it is judging*, and `docs/measurement-harness.md` sections 2.2 and 2.4
 * record three separate ways v1's measurement produced one. Every rule here is
 * one of those three closed off, and none of them is a preference.
 *
 * **1. The unit, which is wrong in both directions.** The v1 baseline records
 * **3,531 unique assistant/model responses** and **4,960 AI tool calls** as
 * *separate* figures (`ACCEPTANCE.md` section 5), and AC-9's target is a
 * reduction against the first.
 *
 * * Counting **tool calls** compares Interlock against 4,960 -- a different
 *   unit -- and reports a reduction that does not exist.
 * * Counting the **invocation** (one row per "the AI was called") compares a
 *   coarser Interlock unit against a finer v1 numerator and **overstates** the
 *   reduction by exactly the tool-use factor: one incident-triggered invocation
 *   that makes three tool round trips returned *four* model responses. It is
 *   the same error as the first with the sign flipped, and it is the one that
 *   shows up as arithmetic rather than as opinion -- an invocation's summed
 *   `output_tokens` would exceed a per-request `max_output_tokens`.
 *
 * So the numerator is `SUM(model_response_count)`, and both error directions
 * are written here rather than in a commit message because the column is
 * exactly the kind a later reader "simplifies" away. {@link Ac9Report.invocationCount}
 * is still computed and printed -- it is the **AC-1** quantity, "zero AI turns
 * absent incidents" being a statement about invocations and not about responses
 * -- and the two series are printed side by side under their own names. Neither
 * is ever presented as the other. `attempt_count` is the *transport* axis and
 * enters no numerator at all: a 429 plus a successful retry is two attempts and
 * **one** assistant turn, and folding it in would report a flaky network as AI
 * workload.
 *
 * **2. A missing figure treated as zero.** Treating an absent `output_tokens`
 * as `0` understates Interlock's token use and therefore *overstates* the
 * reduction -- a bias that always flatters the target, in the very criterion
 * the target is judged by. Nothing here ever does it. A non-`'reported'`
 * invocation is imputed or itemised, never summed as nothing:
 *
 * * imputed at `max_output_tokens * model_response_count` for the **bounded**
 *   figure, which is a genuine lower bound on the reduction because the
 *   provider cannot return more output than the caller allowed;
 * * itemised as {@link Ac9Report.unboundedMissing} where the row records no
 *   ceiling, because there is nothing to bound it with. **A report with a
 *   non-zero `unbounded_missing` count cannot support an AC-9 acceptance
 *   claim**, and {@link renderAc9Report} says so in its own words rather than
 *   leaving the reader to notice;
 * * itemised as {@link Ac9Report.unconfirmedResponseCount} where the row never
 *   finished. `startInvocation` writes `model_response_count = 1` as a
 *   **request-time placeholder** -- the turns are unknowable before the
 *   provider answers -- so imputing such a row at `cap * 1` would bound a
 *   four-turn invocation at a quarter of its real ceiling, which is the
 *   flattering direction again. `finished_at_ms IS NULL` is the discriminator
 *   that writer's docstring names.
 *
 * **3. A percentile mistaken for a bound.** Section 2.4 records that this was
 * got wrong on the first pass and states why at length, so the reasoning is
 * reproduced here rather than referenced: **a percentile of the observed sample
 * does not bound the unobserved values.** A missing invocation may exceed the
 * covered p95, and it is *more* likely to, because telemetry loss correlates
 * with exactly the large, truncated, aborted responses that run long and lose
 * their usage record. Calling a p95 imputation "conservative" and then judging
 * AC-9 by it can pass a target the real numbers fail. The p95 figure is printed
 * because the bounded one is too loose to say anything about the likely truth
 * -- but it is labelled {@link KIND_ASSUMPTION} everywhere it appears, and
 * **the bounded figure is the only one an acceptance judgement may use**.
 *
 * **Cache-read tokens are their own series and enter none of the arithmetic.**
 * `ACCEPTANCE.md` section 5 is explicit (1,399,565,488 in the baseline): "a
 * bandwidth indicator ... not new input tokens and not a billing figure".
 * Adding them to either token series would move AC-9 by three orders of
 * magnitude on a quantity that is not a token cost at all.
 *
 * **The four figures print together or not at all** (section 2.4: "a reduction
 * rate printed without them is not a valid report"). {@link Ac9Report.figures}
 * returns all four, each carrying what *kind* of number it is, and
 * {@link renderAc9Report} has no mode that emits a subset.
 *
 * **No verdict.** `Q-0005` -- canary duration, sample size, numeric exit
 * criteria -- is open, and `ACCEPTANCE.md` section 3 says in terms that AC-9's
 * targets "are not the same thing as canary go/no-go thresholds, and this
 * document does not convert one into the other". A harness that printed a
 * verdict would convert them, answering an open question by inertia. The
 * targets print as targets, the cohort size prints beside every rate, and the
 * reader judges.
 *
 * **`ai_invocation` is read here and written nowhere here.** It is new state,
 * named in `D-0029`'s entity list extension, and its writer is the component
 * that invokes the Dispatcher AI -- a single writer *by construction*, because
 * the AI is on-demand and incident-triggered (`D-0003`), so there is no second
 * process that could be appending rows concurrently. That property is what lets
 * this module read the table as a settled ledger instead of a racing one, and
 * the property survives only while nothing else writes it. This module
 * therefore issues `SELECT` and nothing else against it: no backfill of a
 * missing `output_tokens`, no repair of a row whose `usage_status` looks wrong,
 * no marking of a row as counted. Every such convenience would make the harness
 * a second writer to the table whose single-writer guarantee its own numbers
 * rest on, and would do it inside the report that is supposed to be evidence
 * (`measurement-harness.md` section 7, `D-0040`). A row that cannot be read
 * honestly is itemised -- {@link Ac9Report.unboundedMissing},
 * {@link Ac9Report.unconfirmedResponseCount} -- never corrected.
 *
 * **Read-only, no clock.** The connection is the one `openForMeasurement`
 * returns -- read-only by capability, not by this module's good behaviour --
 * and every instant is the caller's `nowMs`.
 */

/**
 * AC-9's targets, as **targets**. They are the Issue's stated aims
 * (`ACCEPTANCE.md` section 5), to be confirmed by measurement; they are not
 * canary exit criteria and nothing here compares a figure against them to
 * produce an outcome. See the module docstring's last point on `Q-0005`.
 */
export const PROMPT_REDUCTION_TARGET = 0.95;
export const OUTPUT_TOKEN_REDUCTION_TARGET = 0.9;

/**
 * What kind of number a figure is. Section 2.4's table has a "status of the
 * number" column for a reason: the four figures are not four estimates of the
 * same thing, and the difference between the last two is load-bearing.
 */
export const KIND_FACT = "fact";
export const KIND_LOWER_BOUND = "lower bound on the reduction";
export const KIND_ASSUMPTION = "assumption, NOT a bound";

/**
 * The statements this module executes, as the text that is **executed**.
 *
 * `measurement-harness.md` section 6 requires `query_definitions` to carry
 * "every query the report ran, as text ... so a reader can run them by hand",
 * and a statement written inline at its call site cannot honour that: the only
 * way to name it in the header would be a second copy, which agrees with the
 * executed text on the day it is pasted and goes on being printed after the
 * executed text changes. The header would then certify a query that never ran,
 * and nothing in the artefact would show it. So the statement is lifted here,
 * executed from here, and carried in {@link QUERY_DEFINITIONS} -- the same move
 * `control_plane/events.ts` makes for `ORPHANED_OUTBOX_SQL` and for the same
 * reason: a statement that exists only inline can be changed without any test
 * noticing.
 *
 * `{placeholders}` expands to one `?` per run id in the chunk. SQLite has no
 * parameter form for an `IN` list, so the placeholders are generated and the
 * run ids are still bound -- no run id ever reaches the statement as text. The
 * catalogue carries the template, which is the part a reader needs in order to
 * re-run it; the expansion is mechanical.
 */
export const COHORT_INVOCATIONS_QUERY = `
SELECT invocation_id, incident_id, usage_status, output_tokens, input_tokens,
       cache_read_tokens, max_output_tokens, model_response_count,
       attempt_count, finished_at_ms
  FROM ai_invocation
 WHERE run_id IN ({placeholders})
`;

/**
 * Half-open `[start, end)` on `started_at_ms` (`time-base-policy.md` section 2,
 * rule 4).
 */
export const UNATTRIBUTED_INVOCATIONS_QUERY = `
SELECT COUNT(*) FROM ai_invocation
 WHERE run_id IS NULL
   AND started_at_ms >= :period_start_ms
   AND started_at_ms < :period_end_ms
`;

export const QUERY_DEFINITIONS: ReadonlyMap<string, string> = readOnlyMap([
  ["cohort_invocations", COHORT_INVOCATIONS_QUERY],
  ["unattributed_invocations", UNATTRIBUTED_INVOCATIONS_QUERY],
]);

/** Base of this module's refusals; see {@link ./index.js}. */
export class Ac9MeasurementRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "Ac9MeasurementRefused";
    Object.setPrototypeOf(this, Ac9MeasurementRefused.prototype);
  }
}

/**
 * A row's `usage_status` is outside {@link USAGE_STATUSES}.
 *
 * Every branch of the coverage arithmetic is keyed on that column: a row is
 * covered (`'reported'`) or it is imputed. A status this build does not know
 * belongs to neither branch, and the two available silent answers are both
 * biased -- treating it as covered adds a row to the coverage numerator that
 * contributed no tokens, and treating it as missing imputes over a figure that
 * may already be there. Refusing is the only reading that does not invent one.
 */
export class UnknownUsageStatusInLedgerRefused extends Ac9MeasurementRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnknownUsageStatusInLedgerRefused";
    Object.setPrototypeOf(this, UnknownUsageStatusInLedgerRefused.prototype);
  }
}

/**
 * The v1 baseline a reduction is computed against is unusable.
 *
 * A reduction is a statement about two numbers, and a baseline with no runs or
 * no responses in it makes the statement vacuous rather than large. Refusing
 * keeps a division by zero from arriving downstream as an infinite reduction.
 */
export class BaselineRefused extends Ac9MeasurementRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "BaselineRefused";
    Object.setPrototypeOf(this, BaselineRefused.prototype);
  }
}

/**
 * The v1 figures AC-9's reduction is measured against.
 *
 * Verbatim from `ACCEPTANCE.md` section 5's measured baseline
 * (2026-07-18..2026-07-25 dogfood), and normalised per 100 runs *here* so that
 * the normalisation happens once and against the same run count the figures
 * were measured over.
 *
 * `toolCalls` is carried and **never used in any arithmetic**. It is the 4,960
 * of section 2.2's first error direction, kept visible so that a reader
 * comparing an Interlock figure against it can see, in the same object, that it
 * is the wrong unit.
 */
export class MeasuredBaseline {
  readonly completedRuns: number;
  readonly modelResponses: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly cacheReadTokens: number;
  readonly source: string;

  constructor(fields: {
    readonly completedRuns: number;
    readonly modelResponses: number;
    readonly outputTokens: number;
    readonly toolCalls: number;
    readonly cacheReadTokens: number;
    readonly source: string;
  }) {
    if (fields.completedRuns <= 0) {
      throw new BaselineRefused(
        `the baseline records ${fields.completedRuns} completed runs; a ` +
          "per-100-run normalisation needs a positive run count, and a " +
          "reduction against a baseline of nothing is not a small number, " +
          "it is no number",
      );
    }
    if (fields.modelResponses <= 0 || fields.outputTokens <= 0) {
      throw new BaselineRefused(
        `the baseline records ${fields.modelResponses} model responses ` +
          `and ${fields.outputTokens} output tokens; a reduction against a ` +
          "zero baseline would print as 100 percent no matter what " +
          "Interlock did",
      );
    }
    this.completedRuns = fields.completedRuns;
    this.modelResponses = fields.modelResponses;
    this.outputTokens = fields.outputTokens;
    this.toolCalls = fields.toolCalls;
    this.cacheReadTokens = fields.cacheReadTokens;
    this.source = fields.source;
    Object.freeze(this);
  }

  /** The prompt figure AC-9's prompt half is a reduction from. */
  get modelResponsesPer100Runs(): number {
    return (this.modelResponses * 100.0) / this.completedRuns;
  }

  /** The token figure AC-9's token half is a reduction from. */
  get outputTokensPer100Runs(): number {
    return (this.outputTokens * 100.0) / this.completedRuns;
  }
}

/**
 * The measured baseline of `ACCEPTANCE.md` section 5. The run count is 195
 * *completed* runs, which is why `cohort.ts`'s denominator is a completed-run
 * cohort: a started-run cohort would not be against this number.
 */
export const V1_MEASURED_BASELINE = new MeasuredBaseline({
  completedRuns: 195,
  modelResponses: 3531,
  outputTokens: 567_839,
  toolCalls: 4960,
  cacheReadTokens: 1_399_565_488,
  source:
    "ACCEPTANCE.md section 5, measured baseline 2026-07-18..2026-07-25 " +
    "dogfood; 195 completed runs",
});

/**
 * One of section 2.4's four numbers, carrying what kind of number it is.
 *
 * The `kind` is not decoration. Two of the four are facts, one is a bound and
 * one is an assumption, and the report is wrong -- in the way section 2.4
 * describes at length -- the moment a reader takes the fourth for the third.
 * `value` is `null` where the figure is not computable at all (an empty cohort,
 * or a p95 with no covered sample), which is a different statement from zero
 * and is rendered as one.
 */
export class Figure {
  readonly label: string;
  readonly kind: string;
  readonly value: number | null;
  readonly basis: string;

  constructor(fields: {
    readonly label: string;
    readonly kind: string;
    readonly value: number | null;
    readonly basis: string;
  }) {
    this.label = fields.label;
    this.kind = fields.kind;
    this.value = fields.value;
    this.basis = fields.basis;
    Object.freeze(this);
  }
}

/**
 * Everything AC-9 is measured from over one cohort, and nothing decided.
 *
 * The series are separate attributes on purpose: `modelResponseTotal` is the
 * numerator, `invocationCount` is the AC-1 quantity, `attemptTotal` is
 * transport, and `cacheReadTokensTotal` is a bandwidth indicator. Section 2.2
 * turns on their not being interchangeable.
 */
export class Ac9Report {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly generatedAtMs: number;
  readonly cohortSize: number;
  readonly baseline: MeasuredBaseline;

  /**
   * AC-9's numerator: assistant turns the provider returned. NOT invocations,
   * NOT tool calls, NOT attempts.
   */
  readonly modelResponseTotal: number;
  /** The AC-1 series: how often an incident needed the AI at all. */
  readonly invocationCount: number;
  /** The transport series. Printed, and in no numerator. */
  readonly attemptTotal: number;

  readonly coveredCount: number;
  readonly observedOutputTokens: number;
  readonly inputTokensTotal: number;
  /**
   * Its own series. ACCEPTANCE.md section 5: not input tokens, not a billing
   * figure. It appears in no reduction on this report.
   */
  readonly cacheReadTokensTotal: number;

  /**
   * observed + sum(max_output_tokens * model_response_count) over the missing
   * rows that carry a ceiling and finished.
   */
  readonly boundedOutputTokens: number;
  /**
   * observed + p95 * (number of missing rows). `null` when no covered row
   * exists to take a p95 of.
   */
  readonly sensitivityOutputTokens: number | null;
  readonly coveredP95OutputTokens: number | null;

  /**
   * Missing rows with `max_output_tokens IS NULL`: un-imputable, so a non-zero
   * count here cannot support an AC-9 acceptance claim.
   */
  readonly unboundedMissing: readonly string[];
  /**
   * Missing rows with `finished_at_ms IS NULL`: their response count is the
   * writer's request-time placeholder, so `cap * count` would understate.
   */
  readonly unconfirmedResponseCount: readonly string[];
  /**
   * Rows with no `incident_id`: AC-1 violations, itemised by id and never
   * folded into a count.
   */
  readonly ac1Violations: readonly string[];
  /**
   * Rows started in the period that name no run. Outside every run cohort, so
   * in no rate here -- reported so that they are not silently invisible.
   */
  readonly unattributedInvocations: number;

  constructor(fields: {
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly generatedAtMs: number;
    readonly cohortSize: number;
    readonly baseline: MeasuredBaseline;
    readonly modelResponseTotal: number;
    readonly invocationCount: number;
    readonly attemptTotal: number;
    readonly coveredCount: number;
    readonly observedOutputTokens: number;
    readonly inputTokensTotal: number;
    readonly cacheReadTokensTotal: number;
    readonly boundedOutputTokens: number;
    readonly sensitivityOutputTokens: number | null;
    readonly coveredP95OutputTokens: number | null;
    readonly unboundedMissing: readonly string[];
    readonly unconfirmedResponseCount: readonly string[];
    readonly ac1Violations: readonly string[];
    readonly unattributedInvocations: number;
  }) {
    this.periodStartMs = fields.periodStartMs;
    this.periodEndMs = fields.periodEndMs;
    this.generatedAtMs = fields.generatedAtMs;
    this.cohortSize = fields.cohortSize;
    this.baseline = fields.baseline;
    this.modelResponseTotal = fields.modelResponseTotal;
    this.invocationCount = fields.invocationCount;
    this.attemptTotal = fields.attemptTotal;
    this.coveredCount = fields.coveredCount;
    this.observedOutputTokens = fields.observedOutputTokens;
    this.inputTokensTotal = fields.inputTokensTotal;
    this.cacheReadTokensTotal = fields.cacheReadTokensTotal;
    this.boundedOutputTokens = fields.boundedOutputTokens;
    this.sensitivityOutputTokens = fields.sensitivityOutputTokens;
    this.coveredP95OutputTokens = fields.coveredP95OutputTokens;
    this.unboundedMissing = frozenList(fields.unboundedMissing);
    this.unconfirmedResponseCount = frozenList(fields.unconfirmedResponseCount);
    this.ac1Violations = frozenList(fields.ac1Violations);
    this.unattributedInvocations = fields.unattributedInvocations;
    Object.freeze(this);
  }

  // ----------------------------------------------------------------- facts

  /** Invocations whose usage record is not `'reported'`. */
  get missingCount(): number {
    return this.invocationCount - this.coveredCount;
  }

  /**
   * `count(usage_status='reported') / count(*)`, or `null` if no rows.
   *
   * `null` rather than 1.0 for an empty ledger: "every row we have is covered"
   * and "we have no rows" are different reports, and only the second one is
   * true of a period the harness saw nothing in.
   */
  get coverageRatio(): number | null {
    if (this.invocationCount === 0) {
      return null;
    }
    return this.coveredCount / this.invocationCount;
  }

  /** Is every invocation covered? Section 2.4's "all four coincide" case. */
  get coverageIsComplete(): boolean {
    return this.invocationCount > 0 && this.coveredCount === this.invocationCount;
  }

  /**
   * Can the bounded figure carry an AC-9 acceptance claim at all?
   *
   * `false` while any invocation is un-imputable, because the bounded figure is
   * then not a bound over the whole cohort -- it is a bound over the subset that
   * happened to be imputable, with the rest contributing zero, which is the
   * treat-missing-as-zero bias wearing the bound's name.
   *
   * Two populations make it false, and section 2.4 names only the first
   * explicitly:
   *
   * * {@link Ac9Report.unboundedMissing} -- no ceiling to impute at (section
   *   2.4: such a report "cannot support an AC-9 acceptance claim");
   * * {@link Ac9Report.unconfirmedResponseCount} -- a ceiling, but multiplied
   *   by the writer's request-time placeholder of 1 rather than by a counted
   *   number of turns (`startInvocation`'s docstring). Imputing those at
   *   `cap * 1` understates a crashed multi-turn invocation and flatters the
   *   target in the same direction, so they are itemised here instead of
   *   imputed, and they disqualify the claim on the same grounds.
   */
  get supportsAcceptanceClaim(): boolean {
    return this.unboundedMissing.length === 0 && this.unconfirmedResponseCount.length === 0;
  }

  // ------------------------------------------------------------ reductions

  /** AC-9's prompt figure for this cohort, or `null` if the cohort is empty. */
  get modelResponsesPer100Runs(): number | null {
    return this.per100(this.modelResponseTotal);
  }

  /**
   * Reduction in AI prompts against the baseline's model responses.
   *
   * The prompt half needs no imputation: `model_response_count` is `NOT NULL`
   * on every row, so coverage does not enter it. What *does* enter it is
   * {@link Ac9Report.unconfirmedResponseCount} -- those rows carry the
   * placeholder 1 rather than a counted figure, which can only understate the
   * numerator and therefore overstate this reduction. They are itemised beside
   * this figure for exactly that reason.
   */
  get promptReduction(): number | null {
    return reduction(this.modelResponsesPer100Runs, this.baseline.modelResponsesPer100Runs);
  }

  /**
   * Output-token reduction over the covered invocations only.
   *
   * A fact about the covered subset and nothing more, which is why
   * {@link Ac9Report.figures} labels it "over N of M invocations". Taken as a
   * figure about the cohort it is the treat-missing-as-zero bias exactly.
   */
  get observedReduction(): number | null {
    return reduction(this.per100(this.observedOutputTokens), this.baseline.outputTokensPer100Runs);
  }

  /**
   * The lower bound: missing imputed at `cap * model_response_count`.
   *
   * The provider cannot return more output than the caller allowed, so this
   * imputation cannot understate a missing invocation's tokens, so the
   * reduction computed from it cannot overstate the real reduction. It is loose
   * -- usually far above the true value -- and being loose in the safe
   * direction is the property being bought. **This is the only figure an
   * acceptance judgement may use**, and only when
   * {@link Ac9Report.supportsAcceptanceClaim} holds.
   */
  get boundedReduction(): number | null {
    return reduction(this.per100(this.boundedOutputTokens), this.baseline.outputTokensPer100Runs);
  }

  /**
   * Missing imputed at the covered p95. **An assumption, not a bound.**
   *
   * A percentile of the observed sample does not bound the unobserved values,
   * and telemetry loss correlates with exactly the large, truncated responses
   * that would exceed it -- so this figure can sit *above* the truth while the
   * bounded one, by construction, cannot. It is printed because the bounded
   * figure alone says little about the likely truth, and it is labelled
   * {@link KIND_ASSUMPTION} everywhere it appears.
   */
  get sensitivityReduction(): number | null {
    if (this.sensitivityOutputTokens === null) {
      return null;
    }
    return reduction(
      this.per100(this.sensitivityOutputTokens),
      this.baseline.outputTokensPer100Runs,
    );
  }

  /**
   * Section 2.4's four numbers, together, each labelled with its kind.
   *
   * There is no accessor for a subset. Section 2.4: "Coverage and the
   * excluded-reason breakdown are required output. A reduction rate printed
   * without them is not a valid report."
   */
  figures(): readonly Figure[] {
    const coverage = this.coverageRatio;
    return frozenList([
      new Figure({
        label: "coverage",
        kind: KIND_FACT,
        value: coverage,
        basis:
          `${this.coveredCount} of ${this.invocationCount} ` +
          "invocations reported a usage record",
      }),
      new Figure({
        label: "observed output-token reduction",
        kind: `${KIND_FACT}, about the covered subset only`,
        value: this.observedReduction,
        basis: `over ${this.coveredCount} of ${this.invocationCount} invocations`,
      }),
      new Figure({
        label: "bounded output-token reduction",
        kind: KIND_LOWER_BOUND,
        value: this.boundedReduction,
        basis:
          "missing invocations imputed at max_output_tokens * " +
          "model_response_count (the caller's own ceiling)",
      }),
      new Figure({
        label: "sensitivity output-token reduction",
        kind: KIND_ASSUMPTION,
        value: this.sensitivityReduction,
        basis:
          "missing invocations imputed at the covered p95" +
          (this.coveredP95OutputTokens !== null
            ? ` of ${this.coveredP95OutputTokens} tokens`
            : " (no covered sample, so no p95)"),
      }),
    ]);
  }

  private per100(total: number): number | null {
    if (this.cohortSize === 0) {
      return null;
    }
    return (total * 100.0) / this.cohortSize;
  }
}

/**
 * One `ai_invocation` row, as the cohort query projects it.
 *
 * Every integer arrives as a BigInt, because the statement runs with
 * `safeIntegers(true)`. Python's `int` is unbounded and sums these exactly;
 * better-sqlite3's default would hand back a JavaScript number and round
 * `9007199254740993` to `...992` on the way in, so the arithmetic below would be
 * over values the database does not hold. `D-0007` and
 * `docs/sqlite-value-contract.md` name that hazard, and a token total is the one
 * place in this module where a silently wrong number is the entire failure it
 * exists to prevent.
 */
interface InvocationRow {
  readonly invocation_id: string;
  readonly incident_id: string | null;
  readonly usage_status: string;
  readonly output_tokens: bigint | null;
  readonly input_tokens: bigint | null;
  readonly cache_read_tokens: bigint | null;
  readonly max_output_tokens: bigint | null;
  readonly model_response_count: bigint;
  readonly attempt_count: bigint;
  readonly finished_at_ms: bigint | null;
}

/**
 * A figure that cannot be carried on this report without being rounded.
 *
 * A **disclosed divergence** from interlock, in the refusing direction. Python's
 * `int` is unbounded, so a total past 2^53 is simply carried and printed;
 * JavaScript's number cannot hold it, and this module's whole subject is a
 * figure that quietly differs from the measurement. So the sums are exact
 * (BigInt) and the refusal is at the boundary where a total becomes a report
 * field. Nothing an actual ledger can hold reaches it: 2^53 output tokens is
 * nine quadrillion.
 */
export class FigureExceedsExactRangeRefused extends Ac9MeasurementRefused {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "FigureExceedsExactRangeRefused";
    Object.setPrototypeOf(this, FigureExceedsExactRangeRefused.prototype);
  }
}

/** A BigInt total as a report field, or a refusal if it cannot be one exactly. */
function exactly(label: string, total: bigint): number {
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FigureExceedsExactRangeRefused(
      `${label} is ${total}, which is outside the range a JavaScript number ` +
        "represents exactly; the report would print a rounded figure and call " +
        "it a measurement (D-0007, docs/sqlite-value-contract.md)",
    );
  }
  return Number(total);
}

/**
 * Measure AC-9 over `cohort`, deciding nothing.
 *
 * `connection` must be the read-only handle from `openForMeasurement`. This
 * function issues `SELECT` statements and nothing else, and reads no clock:
 * `nowMs` is stamped into the report as `generatedAtMs` for the provenance
 * header (section 6, `D-0040`).
 *
 * The cohort's invocations are the `ai_invocation` rows whose `run_id` is in
 * {@link RunCohort.runIds}. Rows naming **no** run cannot be attributed to any
 * run cohort and so enter no rate; they are counted in
 * {@link Ac9Report.unattributedInvocations} over the report period rather than
 * dropped, because a row the harness declined to attribute is still evidence
 * that the AI ran.
 *
 * @throws {UnknownUsageStatusInLedgerRefused} if a row carries a `usage_status`
 *   this build cannot place in the coverage arithmetic.
 */
export function measureAc9(
  connection: SqliteDatabase,
  cohort: RunCohort,
  options: { readonly nowMs: number; readonly baseline?: MeasuredBaseline },
): Ac9Report {
  const baseline = options.baseline ?? V1_MEASURED_BASELINE;
  const rows = readCohortInvocations(connection, cohort.runIds);

  let modelResponseTotal = 0n;
  let attemptTotal = 0n;
  let coveredCount = 0;
  let observedOutputTokens = 0n;
  let inputTokensTotal = 0n;
  let cacheReadTokensTotal = 0n;
  let imputedBoundedTokens = 0n;
  const coveredValues: bigint[] = [];
  const unboundedMissing: string[] = [];
  const unconfirmed: string[] = [];
  const ac1Violations: string[] = [];
  let missingCount = 0;

  for (const row of rows) {
    const invocationId = row.invocation_id;
    const usageStatus = row.usage_status;
    if (!USAGE_STATUSES.includes(usageStatus as (typeof USAGE_STATUSES)[number])) {
      throw new UnknownUsageStatusInLedgerRefused(
        `invocation ${pythonRepr(invocationId)} carries usage_status ` +
          `${pythonRepr(usageStatus)}, outside the closed set ` +
          `${USAGE_STATUSES.join(", ")} the ai_invocation CHECK enumerates; ` +
          "the coverage arithmetic has a covered branch and an imputed " +
          "branch and this row belongs to neither, so the harness will not " +
          "guess which bias to introduce",
      );
    }

    // The numerator, and the two series that are NOT it. attempt_count is
    // summed for its own line only: a 429 plus a successful retry is two
    // attempts and one assistant turn (section 2.2).
    modelResponseTotal += row.model_response_count;
    attemptTotal += row.attempt_count;

    // AC-1 is this measurement from the other side: the assertion is that every
    // row carries an incident_id. A row without one is ITEMISED, not counted --
    // a count of violations tells a reader that AC-1 failed and nothing about
    // where to look (section 2.2).
    if (row.incident_id === null) {
      ac1Violations.push(invocationId);
    }

    // Input and cache-read are carried as their own series. cache_read in
    // particular never touches the output arithmetic below: ACCEPTANCE.md
    // section 5 calls it a bandwidth indicator, "not new input tokens and not a
    // billing figure", and at 1.4e9 in the baseline it would swamp every AC-9
    // figure it were added to.
    inputTokensTotal += row.input_tokens ?? 0n;
    cacheReadTokensTotal += row.cache_read_tokens ?? 0n;

    if (usageStatus === "reported") {
      const outputTokens = row.output_tokens as bigint;
      coveredCount += 1;
      observedOutputTokens += outputTokens;
      coveredValues.push(outputTokens);
      continue;
    }

    // Everything below here is a MISSING invocation, and the one thing that
    // never happens to it is being added as zero (section 2.4).
    missingCount += 1;
    if (row.finished_at_ms === null) {
      // model_response_count on an unfinished row is startInvocation's
      // request-time placeholder of 1, not a counted number of turns, so
      // cap * count would bound a crashed four-turn invocation at a quarter of
      // its ceiling -- understating Interlock and overstating the reduction.
      // Itemised instead; it disqualifies the acceptance claim
      // (Ac9Report.supportsAcceptanceClaim).
      unconfirmed.push(invocationId);
    } else if (row.max_output_tokens === null) {
      // No ceiling was recorded at request time, and by hypothesis no usage
      // record ever arrived to read one from, so there is nothing this row can
      // honestly be bounded at (section 2.4).
      unboundedMissing.push(invocationId);
    } else {
      // The ceiling is PER REQUEST and the invocation made
      // model_response_count of them, so the invocation's ceiling is the
      // product -- the same product the ai_invocation CHECK enforces against a
      // reported figure.
      imputedBoundedTokens += row.max_output_tokens * row.model_response_count;
    }
  }

  const p95Value = p95(coveredValues);
  // The p95 imputation needs no ceiling, so it covers ALL missing rows,
  // including the two itemised populations the bounded figure cannot reach.
  // That the two figures are computed over different populations is not an
  // oversight: it is the difference between "what can be bounded" and "what can
  // be guessed at", and the report prints the itemisations beside both.
  const sensitivityOutputTokens =
    p95Value === null ? null : observedOutputTokens + p95Value * BigInt(missingCount);

  return new Ac9Report({
    periodStartMs: cohort.periodStartMs,
    periodEndMs: cohort.periodEndMs,
    generatedAtMs: options.nowMs,
    cohortSize: cohort.denominator,
    baseline,
    modelResponseTotal: exactly("the model response total", modelResponseTotal),
    invocationCount: rows.length,
    attemptTotal: exactly("the attempt total", attemptTotal),
    coveredCount,
    observedOutputTokens: exactly("the observed output-token total", observedOutputTokens),
    inputTokensTotal: exactly("the input-token total", inputTokensTotal),
    cacheReadTokensTotal: exactly("the cache-read-token total", cacheReadTokensTotal),
    boundedOutputTokens: exactly(
      "the bounded output-token total",
      observedOutputTokens + imputedBoundedTokens,
    ),
    sensitivityOutputTokens:
      sensitivityOutputTokens === null
        ? null
        : exactly("the sensitivity output-token total", sensitivityOutputTokens),
    coveredP95OutputTokens: p95Value === null ? null : exactly("the covered p95", p95Value),
    unboundedMissing,
    unconfirmedResponseCount: unconfirmed,
    ac1Violations,
    unattributedInvocations: countUnattributed(connection, {
      periodStartMs: cohort.periodStartMs,
      periodEndMs: cohort.periodEndMs,
    }),
  });
}

/**
 * Render `report` as plain ASCII text, with no verdict in it.
 *
 * ASCII only, `-` never an em-dash: this reaches a cp932 console, where a
 * single U+2014 turns a report into a `UnicodeEncodeError`.
 *
 * Every rate prints with the cohort size beside it, the four figures print
 * together, the targets print as targets, and there is no pass/fail string
 * anywhere -- `Q-0005` is open and a verdict here would answer it by inertia
 * (module docstring).
 */
export function renderAc9Report(report: Ac9Report): string {
  const lines: string[] = [];
  lines.push("AC-9 measurement -- AI prompts and output tokens");
  lines.push(
    `  period          [${report.periodStartMs}, ${report.periodEndMs}) ` + "(half-open, epoch ms)",
  );
  lines.push(`  generated at    ${report.generatedAtMs}`);
  lines.push(`  cohort size     ${report.cohortSize} runs`);
  // D-0109: MeasuredBaseline.source is the caller's own description of where
  // its figures came from, and the type is exported.
  lines.push(`  baseline        ${reportValue(report.baseline.source)}`);
  lines.push("");

  lines.push("Series (each counts a different thing; none substitutes for another)");
  lines.push(
    `  model responses (AC-9 numerator) ${report.modelResponseTotal}` +
      `    per 100 runs: ${rate(report.modelResponsesPer100Runs)}`,
  );
  lines.push(
    `  invocations (AC-1 quantity)      ${report.invocationCount}` +
      "    how often an incident needed the AI at all",
  );
  lines.push(
    `  attempts (transport only)        ${report.attemptTotal}` + "    retries; in no numerator",
  );
  lines.push(`  output tokens (covered rows)     ${report.observedOutputTokens}`);
  lines.push(`  input tokens (own series)        ${report.inputTokensTotal}`);
  lines.push(
    `  cache-read tokens (own series)   ${report.cacheReadTokensTotal}` +
      "    bandwidth indicator; in no AC-9 figure",
  );
  lines.push(
    `  invocations naming no run        ${report.unattributedInvocations}` +
      "    outside every run cohort; in no rate here",
  );
  lines.push("");

  lines.push("The four figures (section 2.4 requires all four together)");
  for (const figure of report.figures()) {
    const value = figure.value !== null ? percent(figure.value) : "not computable";
    lines.push(`  ${figure.label}: ${value}  [${figure.kind}]`);
    lines.push(`      ${figure.basis}`);
    lines.push(`      cohort size ${report.cohortSize} runs`);
  }
  lines.push("");

  lines.push("Prompt half");
  lines.push(`  reduction in AI prompts: ${percent(report.promptReduction)}  [${KIND_FACT}]`);
  lines.push(
    "      model_response_count is NOT NULL on every row, so coverage does " +
      "not enter this figure",
  );
  lines.push(`      cohort size ${report.cohortSize} runs`);
  lines.push("");

  lines.push("Targets (targets, not thresholds; Q-0005 is open)");
  lines.push(
    `  AI prompts    reduction target ${percent(PROMPT_REDUCTION_TARGET)} ` + "per 100 worker runs",
  );
  lines.push(
    "  output tokens reduction target " +
      `${percent(OUTPUT_TOKEN_REDUCTION_TARGET)} per 100 worker runs`,
  );
  lines.push(
    "  This harness reports the measurements the judgement will be made " +
      "from. It does not make the judgement.",
  );
  lines.push("");

  lines.push("Itemisations (never folded into a count)");
  lines.push(
    "  AC-1 violations - invocations with no incident_id " + `(${report.ac1Violations.length}):`,
  );
  lines.push(...itemise(report.ac1Violations, "none"));
  lines.push(
    "  unbounded_missing - no max_output_tokens, so nothing to bound them " +
      `at (${report.unboundedMissing.length}):`,
  );
  lines.push(...itemise(report.unboundedMissing, "none"));
  lines.push(
    "  unconfirmed response count - never finished, so their " +
      "model_response_count is the writer's request-time placeholder of 1 " +
      `(${report.unconfirmedResponseCount.length}):`,
  );
  lines.push(...itemise(report.unconfirmedResponseCount, "none"));
  lines.push("");

  lines.push("What this report can and cannot support");
  if (!report.supportsAcceptanceClaim) {
    // Said in the report's own words, not left to the reader to infer from a
    // non-zero count several lines above (section 2.4).
    lines.push(
      "  This report CANNOT support an AC-9 acceptance claim. " +
        `${report.unboundedMissing.length} invocation(s) recorded no output ` +
        `ceiling and ${report.unconfirmedResponseCount.length} never ` +
        "finished, so neither can be imputed at a bound. The bounded figure " +
        "above is a bound over the imputable subset only, and the remainder " +
        "contributes zero to it - which is the treat-missing-as-zero bias " +
        "the bound exists to remove.",
    );
  } else {
    lines.push(
      "  Every missing invocation was imputable at its own recorded " +
        "ceiling, so the bounded figure is a bound over the whole cohort. " +
        "It is the only figure here an acceptance judgement may use.",
    );
  }
  if (report.coverageIsComplete) {
    lines.push(
      "  Coverage is 100 percent: no invocation was imputed, so the " +
        "observed, bounded and sensitivity figures coincide, and all three " +
        "equal the measured reduction.",
    );
  }
  lines.push(
    "  The sensitivity figure is an ASSUMPTION and NOT a bound. A " +
      "percentile of the covered sample does not bound the invocations that " +
      "were never observed, and telemetry loss correlates with exactly the " +
      "large, truncated responses that would exceed it.",
  );
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------

/**
 * `1 - interlock/baseline`, or `null` when the cohort is empty.
 *
 * Not clamped. A negative reduction means Interlock used *more* than the
 * baseline, and that is a measurement the report is obliged to print rather
 * than floor at zero.
 */
function reduction(interlockPer100: number | null, baselinePer100: number): number | null {
  if (interlockPer100 === null) {
    return null;
  }
  return 1.0 - interlockPer100 / baselinePer100;
}

/**
 * Nearest-rank p95 of `values`, or `null` for an empty sample.
 *
 * Nearest rank (`ceil(0.95 * n)`) rather than an interpolating definition
 * because it returns an **observed** value: the sensitivity figure is already
 * an assumption, and interpolating would add a second one that no row in the
 * ledger ever exhibited. It is also reproducible byte for byte across builds,
 * which `D-0040` asks of every figure in a report.
 */
function p95(values: readonly bigint[]): bigint | null {
  if (values.length === 0) {
    return null;
  }
  const ordered = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const rank = Math.max(1, Math.ceil(0.95 * ordered.length));
  return ordered[rank - 1] as bigint;
}

/**
 * The cohort's `ai_invocation` rows, ordered by id.
 *
 * Chunked at 500 because SQLite's default host-parameter ceiling is 999 and a
 * cohort is however many runs a period held; a query that worked in testing and
 * failed on the first busy period would be a poor place to learn that.
 * Ordered by `invocation_id` at the end so the itemisations, and therefore the
 * rendered report, are byte-reproducible (`D-0040`).
 */
function readCohortInvocations(
  connection: SqliteDatabase,
  runIds: readonly string[],
): readonly InvocationRow[] {
  if (runIds.length === 0) {
    return [];
  }
  const rows: InvocationRow[] = [];
  for (let start = 0; start < runIds.length; start += 500) {
    const chunk = runIds.slice(start, start + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    rows.push(
      ...(connection
        .prepare(COHORT_INVOCATIONS_QUERY.replace("{placeholders}", placeholders))
        .safeIntegers(true)
        .all(...chunk) as InvocationRow[]),
    );
  }
  return frozenList(
    [...rows].sort((left, right) => comparePythonStrings(left.invocation_id, right.invocation_id)),
  );
}

/**
 * Invocations started in the period that name no run.
 *
 * Half-open `[start, end)` on `started_at_ms`, per `time-base-policy.md`
 * section 2 rule 4. These enter no rate -- there is no run to normalise them
 * over -- but the count is printed, because "the AI ran and we could not say
 * for which run" is evidence and not an absence.
 */
function countUnattributed(
  connection: SqliteDatabase,
  options: { readonly periodStartMs: number; readonly periodEndMs: number },
): number {
  const row = connection.prepare(UNATTRIBUTED_INVOCATIONS_QUERY).raw().get({
    period_start_ms: options.periodStartMs,
    period_end_ms: options.periodEndMs,
  }) as [number];
  return Number(row[0]);
}

/**
 * A rate as a percentage with two decimals.
 *
 * `formatFixed`, not `toFixed`: Python's formatter rounds half to even and
 * JavaScript's rounds half away from zero, so a figure landing on an exact tie
 * -- and `k / n * 100` produces them -- would print differently in the two
 * ports (`D-0104`).
 */
function percent(value: number | null): string {
  if (value === null) {
    return "not computable";
  }
  return `${formatFixed(value * 100, 2)} percent`;
}

function rate(value: number | null): string {
  if (value === null) {
    return "not computable (cohort is empty)";
  }
  return formatFixed(value, 2);
}

function itemise(ids: readonly string[], empty: string): string[] {
  if (ids.length === 0) {
    return [`      ${empty}`];
  }
  // D-0109: an id here is unconstrained text from the database, and one
  // carrying a newline would forge a line of this itemisation.
  return ids.map((identifier) => `      ${reportValue(identifier)}`);
}
