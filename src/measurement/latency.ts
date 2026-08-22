import type { Database as SqliteDatabase } from "better-sqlite3";

import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import { comparePythonStrings, pythonRepr, reportValue } from "./format.js";
import { frozenList, readOnlyMap } from "./immutable.js";
// The bucket names are imported, never re-spelled: a second copy of a closed
// set agrees with the original right up until the day one of them is renamed,
// and the disagreement shows up here as a censored episode silently entering
// the latency numerator that section 3.5 excluded it from.
import { CENSORED, CENSORED_LEFT, type WindowReport } from "./windows.js";

/**
 * G6 -- the onset-to-incident distribution, its two references, and the lag
 * beside it.
 *
 * The failure this module is written against is a latency report that is *true
 * and useless*, and `docs/measurement-harness.md` section 4 names the two
 * shapes it takes.
 *
 * **1. One reference rendered as though it were both.** Section 4 requires every
 * class to be reported against two bounds -- the budget `L` from the policy
 * revision in force (the **acceptance** bound) and the v1 shadow distribution
 * over `both`-bucket episodes (the **non-regression** bound) -- and says in
 * terms that "neither substitutes for the other, and a report states both even
 * when one of them is unavailable". Outside the shadow period there is no v1
 * distribution at all, and the tempting rendering is to print the budget
 * comparison alone under a heading that implies both were considered. A reader
 * then takes "inside budget" for "no regression", which is the one thing the
 * budget cannot tell them: a class whose detection got four times slower and
 * still fits inside a generous `L` passes the acceptance bound and fails the
 * non-regression one.
 *
 * So the shadow side is **structural, not optional**. {@link ShadowSource}
 * cannot be constructed without either a distribution or a stated reason there
 * is none ({@link ShadowReferenceUnstated}), {@link measureLatency} takes it as
 * a required field with no default, and {@link ShadowSource.forClass} turns
 * "present overall but empty for this class" into an *absent* reference carrying
 * that as its reason rather than into a silent zero. There is no code path here
 * that emits a class's figures without also emitting what happened to its shadow
 * reference.
 *
 * **2. A provider's bad afternoon read as our regression.** Onset-to-incident
 * latency contains the time the fact spent getting to us, and that segment is
 * not ours. `time-base-policy.md` section 2 rule 3 is explicit: end-to-end
 * latency is reported with both clocks and the difference is kept, as its own
 * series -- the **ingestion lag**, `ingested_at_ms - occurred_at_ms` -- "so that
 * a latency regression caused by a slow provider is distinguishable from one
 * caused by us". Without it, a provider delivering webhooks ten minutes late for
 * one afternoon lands in the detection distribution and reads as a detector that
 * got slower, and the remedy chosen is a change to code that was never the
 * problem. {@link measureIngestionLag} therefore runs on every report, prints
 * beside the distribution, and is never added into it or subtracted out of it:
 * the two are separate series because separating them is the entire point.
 *
 * **Negative lag is printed, not clamped.** A provider clock ahead of ours
 * yields `ingested_at_ms < occurred_at_ms`. That is skew -- the thing rule 1 says
 * we cannot bound -- and a clamp to zero would hide the only evidence of it we
 * hold.
 *
 * **What this module does not do.** It does not decide whether a class passed.
 * It does not convert a shadow comparison into a verdict (interlock `Q-0005` is
 * open; `measurement-harness.md` section 5 says a harness that emitted one would
 * be answering it by inertia). It does not classify episodes: censoring is
 * `windows.ts`'s and arrives here already decided, so a censored episode is
 * excluded from the distribution by {@link WindowReport.numeratorIds} and counted
 * rather than re-judged. And it raises no incident and applies no remedy -- this
 * branch implements detectors and reporting only.
 *
 * **Interlock `Q-0011` stays open, and this module is not where it gets closed.**
 * Section 7 holds that Secretary window latency under load is **gate item 8's**
 * measurement, not this harness's, and that no threshold for it is invented
 * here. The distinction is easy to lose because both quantities are called
 * latency and both are milliseconds: what this module measures is *onset to
 * incident* -- how long a condition existed before a detector filed it -- and it
 * compares that against the policy budget `L` and the v1 shadow distribution,
 * neither of which says anything about how long a Secretary window takes to
 * answer while loaded. So there is no Secretary series here, no constant standing
 * in for one, and nothing in {@link measureLatency} that would let a caller pass
 * a Secretary figure in and have it judged against `L`.
 *
 * **Read-only, and the clock is the caller's.** The connection is the handle from
 * {@link openForMeasurement}; every statement issued here is a `SELECT`. `nowMs`
 * is a parameter (`time-base-policy.md` section 2 rule 2) so a report can be
 * driven to any instant by a test.
 */

/**
 * Whether a reference has a distribution behind it.
 *
 * Two named states rather than a nullable distribution, because the absent state
 * carries an obligation -- a reason -- that `null` cannot hold.
 */
export const SHADOW_PRESENT = "present";
export const SHADOW_ABSENT = "absent";

/** A latency figure that cannot be computed, stated rather than guessed. */
export class LatencyRefusal extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "LatencyRefusal";
    Object.setPrototypeOf(this, LatencyRefusal.prototype);
  }
}

/**
 * A shadow reference has neither a distribution nor a reason it has none.
 *
 * This is the refusal that makes section 4's "states both even when one is
 * unavailable" a property of the type instead of a habit of the caller. A
 * reference in {@link SHADOW_ABSENT} with no reason renders as an empty second
 * heading, which reads to a reviewer exactly like a reference that was
 * considered and found equal.
 */
export class ShadowReferenceUnstated extends LatencyRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ShadowReferenceUnstated";
    Object.setPrototypeOf(this, ShadowReferenceUnstated.prototype);
  }
}

/**
 * An incident was recorded before the onset it is supposed to have detected.
 *
 * Latency is `incident.created_at_ms - onset` (section 3.2), and a negative value
 * is not a fast detection: it is a correlation that paired an incident with the
 * wrong episode, or an onset taken from the source clock while the incident
 * carries ours (`time-base-policy.md` section 2 rule 1). Clamping it to zero
 * would leave the mispairing in the sample, pulling the median toward a speed
 * nothing achieved.
 */
export class DetectionBeforeOnset extends LatencyRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DetectionBeforeOnset";
    Object.setPrototypeOf(this, DetectionBeforeOnset.prototype);
  }
}

/**
 * A detection names an episode this report never classified.
 *
 * The detection map and the window report have to be over the same episode set:
 * an id in one and not the other means the caller assembled the two from
 * different selections, and whichever number came out would be over neither set.
 * Dropping the stray silently is how a selection bug survives a review.
 */
export class UnknownEpisodeDetection extends LatencyRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnknownEpisodeDetection";
    Object.setPrototypeOf(this, UnknownEpisodeDetection.prototype);
  }
}

/**
 * Section 4's four figures over one sample: count, median, p90, max.
 *
 * The three figures are `null` when `count` is zero, which is a different
 * statement from a zero millisecond latency and is rendered as one.
 *
 * **Percentiles are nearest-rank.** A nearest-rank percentile returns a value
 * some episode actually exhibited, and it is reproducible byte for byte across
 * builds and languages, which interlock `D-0040` asks of every figure a report is
 * recomputed from. An interpolating median would report a duration no detection
 * took -- harmless in a large sample, and a fabricated number in the small ones
 * this harness will mostly see.
 */
export class Distribution {
  readonly count: number;
  readonly medianMs: number | null;
  readonly p90Ms: number | null;
  readonly maxMs: number | null;

  constructor(fields: {
    readonly count: number;
    readonly medianMs: number | null;
    readonly p90Ms: number | null;
    readonly maxMs: number | null;
  }) {
    this.count = fields.count;
    this.medianMs = fields.medianMs;
    this.p90Ms = fields.p90Ms;
    this.maxMs = fields.maxMs;
    Object.freeze(this);
  }

  /** The distribution of `values`, empty-safe. */
  static of(values: readonly number[]): Distribution {
    if (values.length === 0) {
      return new Distribution({ count: 0, medianMs: null, p90Ms: null, maxMs: null });
    }
    const ordered = [...values].sort((left, right) => left - right);
    return new Distribution({
      count: ordered.length,
      medianMs: nearestRank(ordered, 0.5),
      p90Ms: nearestRank(ordered, 0.9),
      maxMs: ordered[ordered.length - 1] as number,
    });
  }
}

/**
 * One class's non-regression bound, or the stated reason it has none.
 *
 * Interlock builds this only through `present()` and `absent()` so the
 * exclusive-or below is the only shape that exists, and holds the invariant in
 * `__post_init__` for anything that builds one by hand. The constructor here
 * does the same job, and is public for the same reason: a ported case
 * constructs a malformed one directly and asserts the refusal.
 */
export class ShadowReference {
  readonly status: string;
  readonly distribution: Distribution | null;
  readonly bothBucketCount: number | null;
  readonly reason: string | null;

  constructor(fields: {
    readonly status: string;
    readonly distribution: Distribution | null;
    readonly bothBucketCount: number | null;
    readonly reason: string | null;
  }) {
    this.status = fields.status;
    this.distribution = fields.distribution;
    this.bothBucketCount = fields.bothBucketCount;
    this.reason = fields.reason;

    if (this.status === SHADOW_PRESENT) {
      if (this.distribution === null) {
        throw new ShadowReferenceUnstated(
          "a present shadow reference must carry the v1 distribution it is a reference to",
        );
      }
      // D-0108, and the same argument D-0107 makes about a defaulted count: the
      // renderer prints "over N both-bucket episode(s)" from this field, so a
      // present reference without one renders "over null both-bucket
      // episode(s)" -- a heading that states a comparison and names no
      // population. interlock's __post_init__ checks only the distribution, so
      // the state is constructible there and here; this type is exported, so
      // the door is public, and a caller with nothing to count says `0`.
      if (this.bothBucketCount === null) {
        throw new ShadowReferenceUnstated(
          "a present shadow reference must say how many both-bucket episodes " +
            "its distribution is over; the report prints that count beside the " +
            "comparison, and a comparison over an unstated population is not " +
            "one (measurement-harness.md section 4)",
        );
      }
      Object.freeze(this);
      return;
    }
    if (this.status !== SHADOW_ABSENT) {
      throw new ShadowReferenceUnstated(
        `shadow status ${pythonRepr(this.status)} is neither ` +
          `${pythonRepr(SHADOW_PRESENT)} nor ${pythonRepr(SHADOW_ABSENT)}`,
      );
    }
    if (this.reason === null || this.reason === "") {
      throw new ShadowReferenceUnstated(
        "an absent shadow reference must say WHY there is none; a blank second " +
          "heading reads as a reference that was checked and found equal " +
          "(measurement-harness.md section 4)",
      );
    }
    Object.freeze(this);
  }

  /** The v1 distribution over this class's `both`-bucket episodes. */
  static present(options: {
    readonly samples: readonly number[];
    readonly bothBucketCount: number;
  }): ShadowReference {
    return new ShadowReference({
      status: SHADOW_PRESENT,
      distribution: Distribution.of(options.samples),
      bothBucketCount: options.bothBucketCount,
      reason: null,
    });
  }

  /** No v1 distribution for this class in this period, and why. */
  static absent(reason: string): ShadowReference {
    return new ShadowReference({
      status: SHADOW_ABSENT,
      distribution: null,
      bothBucketCount: null,
      reason,
    });
  }

  get available(): boolean {
    return this.status === SHADOW_PRESENT;
  }
}

/**
 * The report's whole shadow input: per-class samples, or one stated absence.
 *
 * v1's numbers never come from this database. Interlock `D-0013` makes a `run`
 * row's existence the assertion that the run is Interlock-owned, and there is no
 * ownership column to read a v1 episode out of; the shadow distribution is a
 * **v1 shadow input** the caller supplies from the other store, which is also why
 * it is a parameter rather than a query.
 *
 * {@link forClass} is where the structural obligation is discharged: a class with
 * no `both`-bucket episode gets an *absent* reference naming that fact, never an
 * empty distribution that would render as "0 episodes, no regression".
 */
export class ShadowSource {
  readonly status: string;
  readonly samples: ReadonlyMap<string, readonly number[]> | null;
  readonly reason: string | null;

  constructor(fields: {
    readonly status: string;
    readonly samples: ReadonlyMap<string, readonly number[]> | null;
    readonly reason: string | null;
  }) {
    this.status = fields.status;
    this.samples = fields.samples;
    this.reason = fields.reason;

    if (this.status === SHADOW_PRESENT) {
      if (this.samples === null) {
        throw new ShadowReferenceUnstated("a present shadow source must carry per-class samples");
      }
      Object.freeze(this);
      return;
    }
    if (this.status !== SHADOW_ABSENT) {
      throw new ShadowReferenceUnstated(
        `shadow status ${pythonRepr(this.status)} is neither ` +
          `${pythonRepr(SHADOW_PRESENT)} nor ${pythonRepr(SHADOW_ABSENT)}`,
      );
    }
    if (this.reason === null || this.reason === "") {
      throw new ShadowReferenceUnstated(
        "a report outside the shadow period must say so in words; see ShadowReference.absent",
      );
    }
    Object.freeze(this);
  }

  /** This class's non-regression bound, always answering one way or the other. */
  forClass(incidentClass: string): ShadowReference {
    if (this.status === SHADOW_ABSENT) {
      // The report-level reason, carried down verbatim: every class says the
      // same true thing, which is the point -- a reader scanning one class must
      // not have to look elsewhere to learn there was no v1.
      return ShadowReference.absent(String(this.reason));
    }
    const samples = this.samples?.get(incidentClass);
    if (samples === undefined || samples.length === 0) {
      return ShadowReference.absent(
        `the shadow period covers this report, but no both-bucket episode of ` +
          `class ${pythonRepr(incidentClass)} was correlated in it, so there is ` +
          `no v1 distribution to compare against for this class`,
      );
    }
    return ShadowReference.present({
      samples: frozenList(samples),
      bothBucketCount: samples.length,
    });
  }
}

/**
 * A shadow source from v1's onset-to-detection samples, per incident class.
 *
 * `samples` holds only `both`-bucket episodes (section 3.3): an episode v1 raised
 * and Interlock did not is a candidate **miss**, not a slow detection, and
 * folding its v1 latency into this reference would let a miss improve the
 * non-regression comparison.
 */
export function shadowFromBothBucket(
  samples: ReadonlyMap<string, readonly number[]>,
): ShadowSource {
  return new ShadowSource({
    status: SHADOW_PRESENT,
    samples: readOnlyMap(
      [...samples].map(([name, values]): [string, readonly number[]] => [name, frozenList(values)]),
    ),
    reason: null,
  });
}

/**
 * No v1 distribution for this period, with the reason recorded.
 *
 * The reason is required. "This period lies outside the shadow window" and "the
 * v1 export failed" are different facts with different remedies, and a report
 * that said only "unavailable" would make them look alike.
 */
export function noShadowReference(reason: string): ShadowSource {
  return new ShadowSource({ status: SHADOW_ABSENT, samples: null, reason });
}

/**
 * `ingested_at_ms - occurred_at_ms` over the period's spine rows.
 *
 * Its own series, printed beside the detection distribution and added into
 * nothing (`time-base-policy.md` section 2 rule 3). `negativeCount` is the skew
 * indicator: a provider clock ahead of ours produces a negative lag, and the
 * count is kept because rule 1 says skew is not something we can bound and this
 * is the only place it becomes visible.
 */
export class IngestionLag {
  readonly distribution: Distribution;
  readonly negativeCount: number;
  readonly eventCount: number;

  constructor(fields: {
    readonly distribution: Distribution;
    readonly negativeCount: number;
    readonly eventCount: number;
  }) {
    this.distribution = fields.distribution;
    this.negativeCount = fields.negativeCount;
    this.eventCount = fields.eventCount;
    Object.freeze(this);
  }
}

/**
 * One incident class, its distribution, and BOTH of its references.
 *
 * `shadow` has no default and cannot be omitted: see the module comment on why a
 * class rendered against the budget alone is the failure this module exists to
 * prevent.
 *
 * `budgetsMs` is a list because `L` is per **episode**, not per class:
 * `lease_orphan`'s budget is twice *that lease's* TTL (`time-base-policy.md`
 * section 3.2), so one class in one period can be judged against several
 * ceilings. Collapsing them to one number would judge every lease by an
 * arbitrary one of them, so the budget comparison is done per episode
 * ({@link overBudgetIds}) and the distinct ceilings are printed.
 */
export class ClassLatency {
  readonly incidentClass: string;
  readonly distribution: Distribution;
  readonly budgetsMs: readonly number[];
  readonly overBudgetIds: readonly string[];
  readonly undetectedIds: readonly string[];
  readonly censoredIds: readonly string[];
  readonly censoredLeftIds: readonly string[];
  readonly shadow: ShadowReference;

  constructor(fields: {
    readonly incidentClass: string;
    readonly distribution: Distribution;
    readonly budgetsMs: readonly number[];
    readonly overBudgetIds: readonly string[];
    readonly undetectedIds: readonly string[];
    readonly censoredIds: readonly string[];
    readonly censoredLeftIds: readonly string[];
    readonly shadow: ShadowReference;
  }) {
    this.incidentClass = fields.incidentClass;
    this.distribution = fields.distribution;
    this.budgetsMs = frozenList(fields.budgetsMs);
    this.overBudgetIds = frozenList(fields.overBudgetIds);
    this.undetectedIds = frozenList(fields.undetectedIds);
    this.censoredIds = frozenList(fields.censoredIds);
    this.censoredLeftIds = frozenList(fields.censoredLeftIds);
    this.shadow = fields.shadow;
    Object.freeze(this);
  }
}

/**
 * Section 4's report: per-class distributions, both references, and the lag.
 *
 * `revisionId`, `graceMs` and `graceSource` are carried up from the
 * {@link WindowReport} rather than re-resolved, because a latency figure judged
 * against one revision's `L` and censored under another's grace is a figure over
 * no revision at all (interlock `D-0031`, `D-0040`).
 */
export class LatencyReport {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly generatedAtMs: number;
  readonly revisionId: number;
  readonly graceMs: number;
  readonly graceSource: string;
  readonly classes: readonly ClassLatency[];
  readonly shadow: ShadowSource;
  readonly ingestionLag: IngestionLag;

  constructor(fields: {
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly generatedAtMs: number;
    readonly revisionId: number;
    readonly graceMs: number;
    readonly graceSource: string;
    readonly classes: readonly ClassLatency[];
    readonly shadow: ShadowSource;
    readonly ingestionLag: IngestionLag;
  }) {
    this.periodStartMs = fields.periodStartMs;
    this.periodEndMs = fields.periodEndMs;
    this.generatedAtMs = fields.generatedAtMs;
    this.revisionId = fields.revisionId;
    this.graceMs = fields.graceMs;
    this.graceSource = fields.graceSource;
    this.classes = frozenList(fields.classes);
    this.shadow = fields.shadow;
    this.ingestionLag = fields.ingestionLag;
    Object.freeze(this);
  }

  get shadowAvailable(): boolean {
    return this.shadow.status === SHADOW_PRESENT;
  }
}

/** The statement the ingestion lag is measured with, as text. */
export const INGESTION_LAG_QUERY = `
SELECT ingested_at_ms - occurred_at_ms AS lag_ms
  FROM event
 WHERE ingested_at_ms >= :period_start_ms
   AND ingested_at_ms < :period_end_ms
 ORDER BY seq
`;

/**
 * The period's ingestion lag, over the event spine.
 *
 * Bounded on `ingested_at_ms` -- **our** clock -- because `time-base-policy.md`
 * section 2 rule 1 puts every period boundary and every aging predicate on our
 * clock. Selecting on `occurred_at_ms` instead would let a provider's skew move
 * rows between reports, which is precisely the effect this series exists to
 * expose rather than to suffer. Half-open `[start, end)` per rule 4.
 *
 * Only *this* module's read: the spine is the one table that carries both clocks
 * for every fact, so one query covers CI observations, PR events and everything
 * else a later producer appends.
 */
export function measureIngestionLag(
  connection: SqliteDatabase,
  options: { readonly periodStartMs: number; readonly periodEndMs: number },
): IngestionLag {
  const { periodStartMs, periodEndMs } = options;
  if (periodEndMs <= periodStartMs) {
    throw new LatencyRefusal(
      `the report period [${periodStartMs}, ${periodEndMs}) is empty or ` +
        `inverted (time-base-policy.md section 2, rule 4)`,
    );
  }
  const lags = (
    connection.prepare(INGESTION_LAG_QUERY).all({
      period_start_ms: periodStartMs,
      period_end_ms: periodEndMs,
    }) as { lag_ms: number }[]
  ).map((row) => Number(row.lag_ms));

  return new IngestionLag({
    distribution: Distribution.of(lags),
    negativeCount: lags.filter((lag) => lag < 0).length,
    eventCount: lags.length,
  });
}

/**
 * Section 4's latency report over one already-classified episode set.
 *
 * `windows` is the output of {@link classifyEpisodes}: censoring is decided
 * there, and this function excludes a censored episode from the distribution
 * rather than re-deciding it. That division is deliberate -- one classifier means
 * the miss numerator and the latency numerator are drawn from the same episodes,
 * which section 3.5 requires and two classifiers would eventually violate.
 *
 * `detections` maps `episodeId` to `incident.created_at_ms`. An in-period episode
 * absent from it is **not** a latency sample: it is a candidate miss, and it is
 * reported as {@link ClassLatency.undetectedIds} so it cannot be mistaken for
 * either a fast detection or a nonexistent episode.
 *
 * `shadow` is required and has no default. See the module comment.
 *
 * @throws {UnknownEpisodeDetection} if a detection names an unclassified episode.
 * @throws {DetectionBeforeOnset} if a detection precedes its episode's onset.
 */
export function measureLatency(
  connection: SqliteDatabase,
  options: {
    readonly windows: WindowReport;
    readonly detections: ReadonlyMap<string, number>;
    readonly shadow: ShadowSource;
    readonly nowMs: number;
  },
): LatencyReport {
  const { windows, detections, shadow, nowMs } = options;

  const known = new Map(windows.windows.map((window) => [window.episodeId, window]));
  for (const episodeId of [...detections.keys()].sort(comparePythonStrings)) {
    if (!known.has(episodeId)) {
      throw new UnknownEpisodeDetection(
        `detection for episode_id=${pythonRepr(episodeId)} was supplied, but the ` +
          `window report does not classify that episode; the detection map and ` +
          `the episode set are over different selections`,
      );
    }
  }

  // Grouped by class in first-seen order, so the rendered report is stable
  // across runs over the same input (interlock D-0040 asks a report to be
  // recomputable, which includes byte-for-byte).
  const classes: string[] = [];
  for (const window of windows.windows) {
    if (!classes.includes(window.incidentClass)) {
      classes.push(window.incidentClass);
    }
  }

  const measured: ClassLatency[] = [];
  for (const incidentClass of classes) {
    const members = windows.windows.filter((window) => window.incidentClass === incidentClass);
    const latencies: number[] = [];
    const overBudget: string[] = [];
    const undetected: string[] = [];
    const budgets: number[] = [];
    for (const window of members) {
      if (window.censored) {
        // windows.ts decided this, and it decided it for both numerators at
        // once (EpisodeWindow.censored). Re-deciding it here is how the miss
        // numerator and the latency numerator start disagreeing about which
        // episodes they are over.
        continue;
      }
      if (!budgets.includes(window.budgetMs)) {
        budgets.push(window.budgetMs);
      }
      const detectedAtMs = detections.get(window.episodeId);
      if (detectedAtMs === undefined) {
        undetected.push(window.episodeId);
        continue;
      }
      const latencyMs = detectedAtMs - window.onsetMs;
      if (latencyMs < 0) {
        throw new DetectionBeforeOnset(
          `episode_id=${pythonRepr(window.episodeId)} was detected at ` +
            `${detectedAtMs} and onset at ${window.onsetMs}, a latency of ` +
            `${latencyMs} ms; a negative detection latency is a mispaired ` +
            `incident or a mixed clock, not a fast detector`,
        );
      }
      latencies.push(latencyMs);
      // Strictly greater: a detection landing exactly on the ceiling met it.
      // The budget is the ceiling on onset-to-alarm, and a `>=` here would fail
      // the one detection that did exactly what the policy asked
      // (time-base-policy.md section 3.1).
      if (latencyMs > window.budgetMs) {
        overBudget.push(window.episodeId);
      }
    }
    measured.push(
      new ClassLatency({
        incidentClass,
        distribution: Distribution.of(latencies),
        budgetsMs: [...budgets].sort((left, right) => left - right),
        overBudgetIds: overBudget,
        undetectedIds: undetected,
        censoredIds: members
          .filter((window) => window.classification === CENSORED)
          .map((window) => window.episodeId),
        censoredLeftIds: members
          .filter((window) => window.classification === CENSORED_LEFT)
          .map((window) => window.episodeId),
        shadow: shadow.forClass(incidentClass),
      }),
    );
  }

  return new LatencyReport({
    periodStartMs: windows.periodStartMs,
    periodEndMs: windows.periodEndMs,
    generatedAtMs: nowMs,
    revisionId: windows.revisionId,
    graceMs: windows.graceMs,
    graceSource: windows.graceSource,
    classes: measured,
    shadow,
    ingestionLag: measureIngestionLag(connection, {
      periodStartMs: windows.periodStartMs,
      periodEndMs: windows.periodEndMs,
    }),
  });
}

/**
 * Render `report` as plain ASCII text, with both references on every class.
 *
 * ASCII only, `-` never an em-dash: this reaches a cp932 console, where a single
 * U+2014 turns a report into a `UnicodeEncodeError` (`D-0006`).
 *
 * The two reference blocks are emitted from one loop body, so there is no
 * arrangement of the data that prints the budget block and skips the shadow block
 * -- an absent shadow reference prints its reason under its own heading.
 */
export function renderLatencyReport(report: LatencyReport): string {
  const lines: string[] = [];
  lines.push("Detection latency -- onset to incident, per incident class");
  lines.push(
    `  period          [${report.periodStartMs}, ${report.periodEndMs}) (half-open, epoch ms)`,
  );
  lines.push(`  generated at    ${report.generatedAtMs}`);
  lines.push(`  policy revision ${report.revisionId}`);
  lines.push(`  grace           ${report.graceMs} ms (${report.graceSource})`);
  lines.push("");

  if (report.classes.length === 0) {
    lines.push("  No episode was classified for this period.");
    lines.push("");
  }

  for (const measured of report.classes) {
    // D-0109: incident_class is policy-table text, not a closed set here.
    lines.push(`Class ${reportValue(measured.incidentClass)}`);
    lines.push(`  distribution    ${distributionLine(measured.distribution)}`);
    lines.push(
      `  excluded        censored ${measured.censoredIds.length}, ` +
        `censored_left ${measured.censoredLeftIds.length} ` +
        `(section 3.5; in no numerator)`,
    );
    lines.push(
      `  undetected      ${measured.undetectedIds.length} in-period episode(s) ` +
        `with no incident - candidate misses, not fast detections`,
    );
    lines.push(...itemise(measured.undetectedIds, "none"));

    lines.push("  reference 1 of 2 - budget L (the acceptance bound)");
    if (measured.budgetsMs.length > 0) {
      lines.push(
        `      L in force: ${measured.budgetsMs.map((budget) => `${budget} ms`).join(", ")}` +
          `  (per episode; a relative L differs by subject)`,
      );
    } else {
      lines.push("      no in-period episode, so no L was resolved");
    }
    lines.push(`      over budget: ${measured.overBudgetIds.length} episode(s)`);
    lines.push(...itemise(measured.overBudgetIds, "none"));

    lines.push("  reference 2 of 2 - v1 shadow distribution (the non-regression bound)");
    const shadowDistribution = measured.shadow.distribution;
    if (measured.shadow.available && shadowDistribution !== null) {
      lines.push(`      v1: ${distributionLine(shadowDistribution)}`);
      lines.push(`      over ${measured.shadow.bothBucketCount} both-bucket episode(s)`);
    } else {
      lines.push("      NO SHADOW REFERENCE FOR THIS PERIOD");
      lines.push(`      reason: ${reportValue(String(measured.shadow.reason))}`);
      lines.push(
        "      the budget comparison above is an acceptance bound only; it " +
          "says nothing about regression against v1",
      );
    }
    lines.push("");
  }

  const lag = report.ingestionLag;
  lines.push(
    "Ingestion lag -- ingested_at_ms minus occurred_at_ms (own series, added into nothing)",
  );
  lines.push(`  distribution    ${distributionLine(lag.distribution)}`);
  lines.push(`  spine rows      ${lag.eventCount}`);
  lines.push(
    `  negative lag    ${lag.negativeCount}  (provider clock ahead of ours; ` +
      `skew, printed rather than clamped)`,
  );
  lines.push(
    "  A rise here and a rise in detection latency are different findings: " +
      "the first is the provider getting slower, the second is us.",
  );
  lines.push("");
  lines.push(
    "This harness reports the measurements a judgement will be made from. " +
      "It does not make the judgement.",
  );
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------

/**
 * The `ceil(q * n)`-th smallest of `ordered` (1-indexed).
 *
 * Nearest rank, never interpolating: see {@link Distribution}.
 */
function nearestRank(ordered: readonly number[], quantile: number): number {
  const rank = Math.max(1, Math.ceil(quantile * ordered.length));
  return ordered[rank - 1] as number;
}

function distributionLine(distribution: Distribution): string {
  if (distribution.count === 0) {
    return "count 0, median -, p90 -, max -  (no sample)";
  }
  return (
    `count ${distribution.count}, median ${distribution.medianMs} ms, ` +
    `p90 ${distribution.p90Ms} ms, max ${distribution.maxMs} ms`
  );
}

function itemise(ids: readonly string[], empty: string): string[] {
  if (ids.length === 0) {
    return [`      ${empty}`];
  }
  // D-0109: an id here is unconstrained text from the database, and one
  // carrying a newline would forge a line of this itemisation.
  return ids.map((identifier) => `      ${reportValue(identifier)}`);
}
