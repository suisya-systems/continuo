import type { Database as SqliteDatabase } from "better-sqlite3";

import { prVerdict } from "../control_plane/ci_ingest.js";
import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import { comparePythonStrings, pythonRepr, pythonTupleRepr } from "./format.js";
import { frozenList, readOnlyMap } from "./immutable.js";
import {
  CENSORED as WINDOW_CENSORED,
  CENSORED_LEFT as WINDOW_CENSORED_LEFT,
  type WindowReport,
} from "./windows.js";

/**
 * G6 -- shadow reconciliation: four correlation keys, five buckets, no silent drop.
 *
 * The failure this module is written against is the one
 * `docs/measurement-harness.md` section 3.1 states outright: **Interlock's own
 * tables cannot contain a miss.** A missed condition produces no `incident`
 * row, so an aggregate over `incident` counts what was detected and is
 * structurally blind to what was not, and any harness reading only our rows
 * measures its own recall as 100%. AC-10 is a gate; a gate that reads its own
 * answer off the thing it is gating is not a gate.
 *
 * Section 3.3's answer is a second observer. During the shadow period v1 and
 * Interlock watch the same world, so v1's episodes are ground truth Interlock
 * did not produce. The comparison is **episode to episode, never row to row**
 * -- the two systems have different schemas and different vocabularies, and an
 * episode is *one real-world condition as seen by one system*. What joins them
 * is a correlation key computed, on each side, out of what that side already
 * stores.
 *
 * **The four keys, section 3.3's table, and where each one comes from here:**
 *
 * | Subject class | Interlock source |
 * | --- | --- |
 * | `ci_outcome` | `ci_observation` joined to `repository`, via the `ci_current_verdict` projection |
 * | `pr_merge` | `pull_request` joined to `repository` |
 * | `worker_escalation` | `gate` ordered by `created_at_ms` -- **positional** |
 * | `session_liveness` | `incident` joined to `session`, onset bucketed to 60 s |
 *
 * **The escalation key is positional and this module says so out loud, twice.**
 * Sections 3.3 and 7 both name it the weakest join in the reconciliation: v1's
 * register has its own entry id Interlock never sees, so "the nth escalation of
 * this run by ordered receipt time" is the only key both sides can compute. It
 * is sound *as long as both systems saw the same escalations in the same order*
 * -- which is exactly what a divergence violates. That is not a hole, it is the
 * safe direction: an ordering mismatch shifts every subsequent position on one
 * side, so the episodes stop pairing and surface as `interlock_only` / `v1_only`
 * noise rather than as a silently wrong pairing that would report one system's
 * escalation as the other's. The caveat rides on {@link POSITIONAL_KEY_CAVEAT},
 * on every {@link CorrelationKey} this class produces
 * ({@link CorrelationKey.positional}), and on the report, so a reader cannot see
 * a run of unmatched escalation episodes without also seeing why the key is the
 * first thing to doubt.
 *
 * **The five buckets are output, not bookkeeping.** v1's own reporter
 * established the policy -- its CI-to-run join is "a 3-stage fallback (never a
 * silent drop)" ending in an explicit `unmatched` bucket -- and section 3.3
 * carries it: {@link BOTH}, {@link INTERLOCK_ONLY}, {@link V1_ONLY},
 * {@link UNMATCHED_KEY}, {@link CENSORED}. Every episode handed in lands in
 * exactly one of them ({@link ShadowReconciliation.filedEpisodeIds} is the
 * partition, and it is asserted rather than assumed).
 *
 * **`v1_only` is a candidate miss, and the two ways to get it wrong are both
 * made unreachable.** v1 raising something Interlock did not can mean Interlock
 * missed it -- or that v1 false-positived, which is the whole reason AC-10 has
 * a false-positive series at all. So:
 *
 * * Converting `v1_only` into a miss count without adjudicating it is
 *   impossible: {@link ShadowReconciliation.confirmedMissCount} throws
 *   {@link AdjudicationPending} while any `v1_only` episode carries no
 *   classification. There is no other method that returns a miss number.
 * * Discarding it is impossible: an unclassified episode is still in
 *   {@link ShadowReconciliation.v1Only}, still counted by
 *   {@link ShadowReconciliation.counts}, and listed with its evidence by
 *   {@link ShadowReconciliation.awaitingAdjudication}, which the renderer
 *   prints. A fixture label settles the ones a fixture covers (section 3.2);
 *   the rest go in front of a human, named.
 *
 * **The v1 side is a separable adapter, and that is a requirement rather than
 * tidiness.** Outside the shadow period there is no v1 data at all, and the
 * harness still has to run. So this module never goes looking for v1's files:
 * it takes {@link V1Reference}, and a reference that is absent -- or that came
 * back empty, which is the same statement made by a reader that ran and found
 * nothing to say -- produces the **no-shadow-reference state**, not a
 * comparison. In that state {@link ShadowReconciliation.counts} *refuses*,
 * because five zeroes and "there was nothing to compare against" read
 * identically to a human and only one of them is true; an empty v1 list
 * silently reconciled would file every Interlock episode as `interlock_only`
 * and report a period of pure improvement.
 *
 * **`censored` is not computed here.** It comes from {@link ./windows.js}
 * (section 3.5), and {@link censoredEpisodeIds} is the one adaptor between the
 * two. Censoring wins over every other bucket, and a matched pair is censored
 * if *either* half is: judging half a pair against a period that only observed
 * half of it is the same manufactured miss section 3.5 exists to remove.
 *
 * **Nothing here writes, and nothing here reads a clock.** The connection is
 * the read-only handle from {@link ./reader.js}'s `openForMeasurement`; every
 * bound is the caller's; every statement issued is a `SELECT`.
 *
 * **Scope.** This module correlates and files. It does not raise an incident,
 * does not apply a remedy, and does not decide AC-10's verdict -- the reconcile
 * driver that would do any of that is out of scope for this branch and is not
 * implied by anything here.
 */

/**
 * The subject classes of section 3.3's correlation table. Closed, because a
 * fifth class arriving as free text would be reconciled against nothing on the
 * v1 side and would quietly file every one of its episodes as `interlock_only`
 * -- a candidate improvement invented by a typo.
 */
export const SUBJECT_CI_OUTCOME = "ci_outcome";
export const SUBJECT_PR_MERGE = "pr_merge";
export const SUBJECT_WORKER_ESCALATION = "worker_escalation";
export const SUBJECT_SESSION_LIVENESS = "session_liveness";

export const SUBJECT_CLASSES: readonly string[] = frozenList([
  SUBJECT_CI_OUTCOME,
  SUBJECT_PR_MERGE,
  SUBJECT_WORKER_ESCALATION,
  SUBJECT_SESSION_LIVENESS,
]);

/**
 * The classes whose key is positional rather than natural on either side.
 * Kept as data so the caveat attaches itself: a hand-built escalation episode
 * gets the same flag as one this module read, and no consumer has to remember
 * which class was the weak one.
 */
export const POSITIONAL_SUBJECT_CLASSES: ReadonlySet<string> = new Set([SUBJECT_WORKER_ESCALATION]);

/**
 * Carried into the report verbatim (sections 3.3 and 7). ASCII only: this
 * string reaches stdout through {@link renderShadowReconciliation}, and a cp932
 * console cannot encode an em-dash.
 */
export const POSITIONAL_KEY_CAVEAT =
  "worker_escalation is keyed positionally - the nth escalation of a run by " +
  "ordered receipt time - because v1's register id is not visible to " +
  "Interlock. It is sound only while both systems saw the same escalations " +
  "in the same order; an ordering divergence shifts every later position and " +
  "surfaces as unmatched episodes rather than as a wrong pairing, which is " +
  "the safe direction. Many unmatched escalation episodes mean the key needs " +
  "replacing before these numbers mean anything.";

/**
 * Section 3.3: the session-liveness key buckets the onset to 60 s. It is
 * document data, not policy data, which is why it is a constant here and not a
 * `policy_*` read: the two systems detect the same condition at different
 * latencies, and the bucket is what absorbs that difference without letting two
 * genuinely distinct conditions on one run collapse into one episode.
 */
export const ONSET_BUCKET_MS = 60_000;

/**
 * What an episode's `onsetMs` actually is. Section 3.2 says the onset is "when
 * the condition **began**"; a row that cannot state that still has to be placed
 * in a period, so it is placed on the instant it *can* state and says which one
 * that was. The distinction is a field rather than a branch because a reader
 * comparing two periods has to be able to see that an episode was selected on a
 * bound instead of on its onset -- and because a latency
 * ({@link MatchedPair.onsetDeltaMs}) computed against a bound is not a latency
 * at all.
 */
export const ONSET_OBSERVED = "onset";
export const ONSET_UPPER_BOUND = "created_at_upper_bound";

export const ONSET_BASES: readonly string[] = frozenList([ONSET_OBSERVED, ONSET_UPPER_BOUND]);

/**
 * Rides on any report whose `unmatched_key` bucket holds an episode selected on
 * a bound. Without it the bucket's period boundaries look exact.
 */
export const BOUNDED_ONSET_CAVEAT =
  "one or more unmatched_key episodes were selected into this period on an " +
  "upper bound of their onset (the instant the incident was raised), not on " +
  "the onset itself, because the row does not carry what the onset is derived " +
  "from; the true onset is at or before that instant and may belong to an " +
  "earlier period";

/** Section 3.3's five buckets, always emitted in this order. */
export const BOTH = "both";
export const INTERLOCK_ONLY = "interlock_only";
export const V1_ONLY = "v1_only";
export const UNMATCHED_KEY = "unmatched_key";
export const CENSORED = "censored";

export const RECONCILIATION_BUCKETS: readonly string[] = frozenList([
  BOTH,
  INTERLOCK_ONLY,
  V1_ONLY,
  UNMATCHED_KEY,
  CENSORED,
]);

/**
 * How a `v1_only` episode was settled. `undetermined` is a first-class answer,
 * not a failure to answer: `D-0006`'s "cannot determine is a legitimate
 * outcome" applied to the measurement instead of to the detection (section 3.4
 * says the same of false termination).
 */
export const MISS = "miss";
export const V1_FALSE_POSITIVE = "v1_false_positive";
export const UNDETERMINED = "undetermined";

export const ADJUDICATIONS: readonly string[] = frozenList([MISS, V1_FALSE_POSITIVE, UNDETERMINED]);

/**
 * Where the adjudication came from, recorded because `D-0040` makes the
 * provenance of a number part of the report: a miss settled by a fixture label
 * is reproducible, and one settled by a human is not, and a reader who cannot
 * tell them apart cannot recompute either.
 */
export const FROM_FIXTURE_LABEL = "fixture_label";
export const AWAITING_HUMAN = "awaiting_human_adjudication";

/** Whether this report had a second observer at all. */
export const SHADOW_PRESENT = "present";
export const SHADOW_ABSENT = "absent";

/**
 * The separator inside a key token. ASCII unit separator, chosen because no
 * component of any of the four keys can contain it: a repository slug, a
 * decimal PR number, a 40-hex SHA, a run id and a bucket ordinal are all
 * printable. A separator that *could* occur (`|`, `:`) would let two different
 * keys spell one token and pair two unrelated episodes.
 */
const KEY_SEPARATOR = "\u001f";

/** A reconciliation that cannot be computed honestly, stated rather than guessed. */
export class ShadowRefusal extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ShadowRefusal";
    Object.setPrototypeOf(this, ShadowRefusal.prototype);
  }
}

/**
 * An episode named a subject class outside {@link SUBJECT_CLASSES}.
 *
 * Refused rather than passed through: an unrecognised class has no counterpart
 * on the v1 side, so every episode carrying it would pair with nothing and be
 * filed `interlock_only` -- reported as a candidate improvement that is really
 * a spelling mistake.
 */
export class UnknownSubjectClass extends ShadowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnknownSubjectClass";
    Object.setPrototypeOf(this, UnknownSubjectClass.prototype);
  }
}

/**
 * An episode carries neither a key nor a reason for not having one, or both.
 *
 * The pair is exclusive by construction so that "the key could not be computed"
 * is a *statement in the data* rather than the absence of one. A `null` key
 * with no reason attached is how an episode gets dropped in silence: the
 * reconciliation has no bucket to file it under and no sentence to print about
 * it.
 */
export class EpisodeKeyRefused extends ShadowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "EpisodeKeyRefused";
    Object.setPrototypeOf(this, EpisodeKeyRefused.prototype);
  }
}

/**
 * One `episode_id` reached the report twice, or from both sides.
 *
 * Ids are the report's own handles -- the windows module classifies by them and
 * {@link censoredEpisodeIds} is looked up by them -- so a collision makes
 * censoring apply to the wrong episode, and a collision *across* sides makes an
 * Interlock episode inherit a v1 episode's censoring. Counting the same id
 * twice also moves a numerator with nothing visible in the counts: the totals
 * simply come out one too high.
 */
export class DuplicateEpisodeIdRefused extends ShadowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DuplicateEpisodeIdRefused";
    Object.setPrototypeOf(this, DuplicateEpisodeIdRefused.prototype);
  }
}

/**
 * Two episodes on one side computed the same correlation key.
 *
 * Matching is one-to-one; with two candidates for one key, whichever the
 * dictionary happened to keep would pair and the other would be filed
 * `interlock_only` / `v1_only` -- a fabricated improvement or a fabricated
 * miss, chosen by iteration order. For `worker_escalation` a collision is the
 * positional key failing exactly as section 3.3 warns (two escalations at the
 * same ordinal), and it is named here rather than absorbed.
 */
export class DuplicateCorrelationKey extends ShadowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DuplicateCorrelationKey";
    Object.setPrototypeOf(this, DuplicateCorrelationKey.prototype);
  }
}

/** A fixture label settled a `v1_only` episode with a word outside {@link ADJUDICATIONS}. */
export class UnknownAdjudication extends ShadowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnknownAdjudication";
    Object.setPrototypeOf(this, UnknownAdjudication.prototype);
  }
}

/**
 * A miss count was asked for while `v1_only` episodes remain unclassified.
 *
 * Section 3.3: "the report never silently converts `v1_only` into a miss
 * count". This is that sentence made structural -- the only method returning a
 * miss number refuses until every candidate has been settled by a fixture label
 * or a human. The refusal names the episodes, so the answer to it is to
 * adjudicate them, not to widen a filter.
 */
export class AdjudicationPending extends ShadowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "AdjudicationPending";
    Object.setPrototypeOf(this, AdjudicationPending.prototype);
  }
}

/**
 * A comparison number was asked for from a report that had no second observer.
 *
 * Not an error condition -- outside the shadow period this is the normal state
 * of the world, and the harness still runs. It is a refusal because the
 * alternative is worse than an exception: five zero buckets say "the two
 * systems agreed about nothing at all", which is what a reader takes from a
 * printed table, and the truth is "there was no other system to agree with".
 */
export class ShadowReferenceAbsent extends ShadowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ShadowReferenceAbsent";
    Object.setPrototypeOf(this, ShadowReferenceAbsent.prototype);
  }
}

/** A {@link V1Reference} was constructed without the provenance it must carry. */
export class ShadowReferenceRefused extends ShadowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ShadowReferenceRefused";
    Object.setPrototypeOf(this, ShadowReferenceRefused.prototype);
  }
}

function freezeEvidence(
  evidence: ReadonlyMap<string, string> | Iterable<readonly [string, string]> | undefined,
): ReadonlyMap<string, string> {
  return readOnlyMap(evidence === undefined ? [] : evidence);
}

/**
 * One episode's join key: its subject class and the key's components.
 *
 * Section 3.3 gives a different tuple per subject class, so the class is part
 * of the key rather than a label beside it. Without it, a `pr_merge` key
 * `(github, o/r, 7)` and a truncated `ci_outcome` key would be free to collide,
 * and the pairing would cross subject classes -- a merge episode reported as
 * agreeing with a CI outcome.
 */
export class CorrelationKey {
  readonly subjectClass: string;
  readonly parts: readonly string[];

  constructor(fields: { readonly subjectClass: string; readonly parts: readonly string[] }) {
    if (!SUBJECT_CLASSES.includes(fields.subjectClass)) {
      throw new UnknownSubjectClass(
        `subject_class ${pythonRepr(fields.subjectClass)} is outside section ` +
          `3.3's table (${SUBJECT_CLASSES.join(", ")})`,
      );
    }
    if (fields.parts.length === 0 || fields.parts.some((part) => part === "")) {
      // An empty component is a missing component wearing a value's type.
      // Section 3.3's whole unmatched_key bucket exists for the missing case,
      // and admitting '' here would route it past that bucket into a pairing on
      // a key that is partly blank.
      throw new EpisodeKeyRefused(
        `correlation key for ${pythonRepr(fields.subjectClass)} has an empty or absent ` +
          "component; an episode that cannot compute every component belongs " +
          `in the ${pythonRepr(UNMATCHED_KEY)} bucket`,
      );
    }
    this.subjectClass = fields.subjectClass;
    this.parts = frozenList(fields.parts);
    Object.freeze(this);
  }

  /** Is this the weak, order-dependent join? See {@link POSITIONAL_KEY_CAVEAT}. */
  get positional(): boolean {
    return POSITIONAL_SUBJECT_CLASSES.has(this.subjectClass);
  }

  /** The hashable spelling both sides must agree on, byte for byte. */
  token(): string {
    return [this.subjectClass, ...this.parts].join(KEY_SEPARATOR);
  }
}

/**
 * One real-world condition as one system saw it.
 *
 * `shape` is what a fixture can recognise the episode by -- the CI verdict, the
 * merge, the incident's `fact_state`. It is what section 3.3's "where a fixture
 * covers the same shape" is looked up on, and it is deliberately not the
 * episode id: an id is unique to one occurrence, and a label is about a *kind*
 * of occurrence.
 *
 * `key` and `keyGap` are exclusive and one of them is required. An episode that
 * could not compute its key carries the reason it could not, because that
 * reason is the `unmatched_key` bucket's entire content -- section 7 says a
 * canary producing many of them is telling us the key needs replacing, and a
 * bucket of bare ids says nothing about which component went missing.
 */
export class ShadowEpisode {
  readonly episodeId: string;
  readonly subjectClass: string;
  readonly shape: string;
  readonly onsetMs: number;
  readonly key: CorrelationKey | null;
  readonly keyGap: string | null;
  readonly onsetBasis: string;
  readonly evidence: ReadonlyMap<string, string>;

  constructor(fields: {
    readonly episodeId: string;
    readonly subjectClass: string;
    readonly shape: string;
    readonly onsetMs: number;
    readonly key?: CorrelationKey | null;
    readonly keyGap?: string | null;
    readonly onsetBasis?: string;
    readonly evidence?: ReadonlyMap<string, string> | Iterable<readonly [string, string]>;
  }) {
    const key = fields.key ?? null;
    const keyGap = fields.keyGap ?? null;
    const onsetBasis = fields.onsetBasis ?? ONSET_OBSERVED;

    if (!SUBJECT_CLASSES.includes(fields.subjectClass)) {
      throw new UnknownSubjectClass(
        `subject_class ${pythonRepr(fields.subjectClass)} is outside section 3.3's ` +
          `table (${SUBJECT_CLASSES.join(", ")})`,
      );
    }
    if (!fields.episodeId) {
      throw new EpisodeKeyRefused("an episode must carry a non-empty episode_id");
    }
    if ((key === null) === (keyGap === null)) {
      throw new EpisodeKeyRefused(
        `episode ${pythonRepr(fields.episodeId)} must carry exactly one of a correlation ` +
          "key or the reason it has none; carrying neither is how an episode " +
          "leaves a report without being counted, and carrying both leaves the " +
          "bucket ambiguous",
      );
    }
    if (key !== null && key.subjectClass !== fields.subjectClass) {
      throw new EpisodeKeyRefused(
        `episode ${pythonRepr(fields.episodeId)} is a ${pythonRepr(fields.subjectClass)} ` +
          `episode carrying a ${pythonRepr(key.subjectClass)} key`,
      );
    }
    if (!ONSET_BASES.includes(onsetBasis)) {
      throw new EpisodeKeyRefused(
        `episode ${pythonRepr(fields.episodeId)} declares onset_basis ${pythonRepr(onsetBasis)}, ` +
          `which is outside ${ONSET_BASES.join(", ")}`,
      );
    }
    if (key !== null && onsetBasis !== ONSET_OBSERVED) {
      // A keyed episode can be matched, and a matched pair reports
      // onsetDeltaMs as a detection latency (section 3.3's "latency and
      // outcome are compared"). Measuring that against an instant that is only
      // a bound would report a fabricated latency as a real one, so an episode
      // that cannot state its onset cannot carry a key either.
      throw new EpisodeKeyRefused(
        `episode ${pythonRepr(fields.episodeId)} carries a correlation key while its ` +
          `onset is only ${pythonRepr(onsetBasis)}; a pair matched on it would report a ` +
          "latency measured against an instant that is not the onset",
      );
    }

    this.episodeId = fields.episodeId;
    this.subjectClass = fields.subjectClass;
    this.shape = fields.shape;
    this.onsetMs = fields.onsetMs;
    this.key = key;
    this.keyGap = keyGap;
    this.onsetBasis = onsetBasis;
    this.evidence = freezeEvidence(fields.evidence);
    Object.freeze(this);
  }

  /** Does this episode rest on the weak positional join? */
  get positionalKey(): boolean {
    return POSITIONAL_SUBJECT_CLASSES.has(this.subjectClass);
  }
}

/**
 * One condition, seen by both systems.
 *
 * `onsetDeltaMs` and `shapeAgrees` are carried because section 3.3 says a
 * matched episode is where "latency and outcome are compared", and a bucket
 * that recorded only the fact of the match would make the comparison a second
 * pass over data the report had already thrown away.
 */
export class MatchedPair {
  readonly key: CorrelationKey;
  readonly interlock: ShadowEpisode;
  readonly v1: ShadowEpisode;

  constructor(fields: {
    readonly key: CorrelationKey;
    readonly interlock: ShadowEpisode;
    readonly v1: ShadowEpisode;
  }) {
    this.key = fields.key;
    this.interlock = fields.interlock;
    this.v1 = fields.v1;
    Object.freeze(this);
  }

  /** v1's onset minus Interlock's. Positive means Interlock saw it first. */
  get onsetDeltaMs(): number {
    return this.v1.onsetMs - this.interlock.onsetMs;
  }

  /**
   * Did the two systems call it the same thing?
   *
   * A pair that matched on key and disagrees on shape is a real finding -- both
   * systems saw the condition and named it differently -- and it is *not* a
   * miss. Folding it into `v1_only` would count one condition twice and call
   * the second copy a miss.
   */
  get shapeAgrees(): boolean {
    return this.interlock.shape === this.v1.shape;
  }
}

/**
 * A candidate miss, with the verdict on it or the fact that there is none.
 *
 * `adjudication` is `null` until something settles it. That `null` is
 * load-bearing: it is what makes {@link ShadowReconciliation.confirmedMissCount}
 * refuse, and it is why an unsettled candidate cannot be counted as a miss and
 * cannot be dropped.
 */
export class V1OnlyEpisode {
  readonly episode: ShadowEpisode;
  readonly adjudication: string | null;
  readonly adjudicationSource: string;

  constructor(fields: {
    readonly episode: ShadowEpisode;
    readonly adjudication: string | null;
    readonly adjudicationSource: string;
  }) {
    if (fields.adjudication !== null && !ADJUDICATIONS.includes(fields.adjudication)) {
      throw new UnknownAdjudication(
        `${pythonRepr(fields.adjudication)} is not one of ${ADJUDICATIONS.join(", ")}`,
      );
    }
    this.episode = fields.episode;
    this.adjudication = fields.adjudication;
    this.adjudicationSource = fields.adjudicationSource;
    Object.freeze(this);
  }

  get isMiss(): boolean {
    return this.adjudication === MISS;
  }
}

/**
 * The v1 side of the comparison, as a **separable adapter** hands it over.
 *
 * This type exists so that this module never opens one of v1's files. Outside
 * the shadow period there is no v1 data, during it the data lives in
 * `.state/pending_decisions.json`, an `events` table and notification records,
 * and by the time AC-10 is re-run those paths may not exist at all. A harness
 * that reached for them directly would stop running when they moved; one that
 * takes episodes as an input keeps running and says what it has.
 *
 * Construct through {@link V1Reference.absent}, {@link V1Reference.observed} or
 * {@link V1Reference.attestsEmpty}, never by hand: the constructors are where
 * "no reference" and "a reference that saw nothing" are forced apart.
 */
export class V1Reference {
  readonly source: string | null;
  readonly episodes: readonly ShadowEpisode[];
  readonly absentReason: string | null;

  private constructor(fields: {
    readonly source: string | null;
    readonly episodes: readonly ShadowEpisode[];
    readonly absentReason: string | null;
  }) {
    this.source = fields.source;
    this.episodes = frozenList(fields.episodes);
    this.absentReason = fields.absentReason;
    Object.freeze(this);
  }

  get available(): boolean {
    return this.source !== null;
  }

  /** There is no v1 reference for this period, and here is why. */
  static absent(options: { readonly reason: string }): V1Reference {
    if (!options.reason) {
      throw new ShadowReferenceRefused(
        "an absent shadow reference must say why it is absent; the report " +
          "prints the reason instead of a comparison",
      );
    }
    return new V1Reference({ source: null, episodes: [], absentReason: options.reason });
  }

  /**
   * v1 episodes read by `source`.
   *
   * **An empty `episodes` degrades to {@link V1Reference.absent}, deliberately.**
   * An adapter that returned nothing and an adapter that did not run are
   * indistinguishable from their output, and the two readings differ by the
   * entire report: treated as "v1 saw nothing", every Interlock episode is
   * filed `interlock_only` and the period reads as pure improvement with no
   * miss anywhere -- the flattering answer, produced by the absence of data
   * rather than by the presence of any. A canary period where v1 genuinely ran
   * and saw nothing is a real state and says so through
   * {@link V1Reference.attestsEmpty}, which is a claim someone has to make on
   * purpose.
   */
  static observed(options: {
    readonly source: string;
    readonly episodes: Iterable<ShadowEpisode>;
  }): V1Reference {
    if (!options.source) {
      throw new ShadowReferenceRefused(
        "an observed shadow reference must name its source (D-0040: a report " +
          "records where its numbers came from)",
      );
    }
    const materialised = [...options.episodes];
    if (materialised.length === 0) {
      return V1Reference.absent({
        reason:
          `the v1 adapter ${pythonRepr(options.source)} returned no episodes; an empty ` +
          "read is not evidence that v1 saw nothing (use " +
          "V1Reference.attestsEmpty to claim that on purpose)",
      });
    }
    return new V1Reference({
      source: options.source,
      episodes: materialised,
      absentReason: null,
    });
  }

  /** `source` ran over this period and asserts v1 raised no episode in it. */
  static attestsEmpty(options: { readonly source: string }): V1Reference {
    if (!options.source) {
      throw new ShadowReferenceRefused(
        "an attestation that v1 saw nothing must name who attests it",
      );
    }
    return new V1Reference({ source: options.source, episodes: [], absentReason: null });
  }
}

/**
 * Section 3.3's five buckets, and the provenance to recompute them.
 *
 * Every accessor that returns a comparison number refuses when
 * {@link ShadowReconciliation.shadowReference} is {@link SHADOW_ABSENT}; see
 * {@link ShadowReferenceAbsent} for why five zeroes are not an acceptable
 * stand-in for "there was nothing to compare against".
 */
export class ShadowReconciliation {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly shadowReference: string;
  readonly shadowSource: string | null;
  readonly shadowAbsentReason: string | null;
  readonly interlockEpisodeCount: number;
  readonly both: readonly MatchedPair[];
  readonly interlockOnly: readonly ShadowEpisode[];
  readonly v1Only: readonly V1OnlyEpisode[];
  readonly unmatchedKey: readonly ShadowEpisode[];
  readonly censored: readonly ShadowEpisode[];
  readonly positionalCaveat: string;

  constructor(fields: {
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly shadowReference: string;
    readonly shadowSource: string | null;
    readonly shadowAbsentReason: string | null;
    readonly interlockEpisodeCount: number;
    readonly both: readonly MatchedPair[];
    readonly interlockOnly: readonly ShadowEpisode[];
    readonly v1Only: readonly V1OnlyEpisode[];
    readonly unmatchedKey: readonly ShadowEpisode[];
    readonly censored: readonly ShadowEpisode[];
    readonly positionalCaveat?: string;
  }) {
    this.periodStartMs = fields.periodStartMs;
    this.periodEndMs = fields.periodEndMs;
    this.shadowReference = fields.shadowReference;
    this.shadowSource = fields.shadowSource;
    this.shadowAbsentReason = fields.shadowAbsentReason;
    this.interlockEpisodeCount = fields.interlockEpisodeCount;
    this.both = frozenList(fields.both);
    this.interlockOnly = frozenList(fields.interlockOnly);
    this.v1Only = frozenList(fields.v1Only);
    this.unmatchedKey = frozenList(fields.unmatchedKey);
    this.censored = frozenList(fields.censored);
    this.positionalCaveat = fields.positionalCaveat ?? POSITIONAL_KEY_CAVEAT;
    Object.freeze(this);
  }

  /** Was there a second observer for this period at all? */
  get available(): boolean {
    return this.shadowReference === SHADOW_PRESENT;
  }

  private requireReference(): void {
    if (!this.available) {
      throw new ShadowReferenceAbsent(
        "this report has no shadow reference for " +
          `[${this.periodStartMs}, ${this.periodEndMs}): ` +
          `${this.shadowAbsentReason}. ` +
          `${this.interlockEpisodeCount} Interlock episode(s) were read ` +
          "and none of them can be called an improvement or a miss " +
          "without a second observer",
      );
    }
  }

  /**
   * Per-bucket counts, all five keys present **even at zero**.
   *
   * A zero and a missing key are different statements to a reader diffing two
   * reports, and only one of them is the truth this harness has. A matched pair
   * counts once, as one condition -- it is one episode of the world seen twice,
   * not two episodes.
   */
  counts(): ReadonlyMap<string, number> {
    this.requireReference();
    return readOnlyMap([
      [BOTH, this.both.length],
      [INTERLOCK_ONLY, this.interlockOnly.length],
      [V1_ONLY, this.v1Only.length],
      [UNMATCHED_KEY, this.unmatchedKey.length],
      [CENSORED, this.censored.length],
    ]);
  }

  /**
   * Every episode id this report filed, once per episode, in bucket order.
   *
   * The partition, made checkable. Both sides of a matched pair appear, because
   * both were inputs; the test suite asserts this list is a permutation of the
   * inputs, which is what makes "no silent drop" a property of the code rather
   * than a claim in a docstring.
   */
  filedEpisodeIds(): readonly string[] {
    this.requireReference();
    const filed: string[] = [];
    for (const pair of this.both) {
      filed.push(pair.interlock.episodeId);
      filed.push(pair.v1.episodeId);
    }
    filed.push(...this.interlockOnly.map((episode) => episode.episodeId));
    filed.push(...this.v1Only.map((candidate) => candidate.episode.episodeId));
    filed.push(...this.unmatchedKey.map((episode) => episode.episodeId));
    filed.push(...this.censored.map((episode) => episode.episodeId));
    return frozenList(filed);
  }

  /**
   * The candidate misses nothing has settled yet, with their evidence.
   *
   * Section 3.3: those a fixture does not cover are "listed for human
   * adjudication with evidence attached". This is that list, and
   * {@link renderShadowReconciliation} prints it, so the report cannot show a
   * miss-related number without also showing what is still open.
   */
  awaitingAdjudication(): readonly V1OnlyEpisode[] {
    this.requireReference();
    return frozenList(this.v1Only.filter((candidate) => candidate.adjudication === null));
  }

  /** How the `v1_only` candidates were settled, `null` included. */
  adjudicationCounts(): ReadonlyMap<string, number> {
    this.requireReference();
    const tally = new Map<string, number>(ADJUDICATIONS.map((name) => [name, 0]));
    tally.set(AWAITING_HUMAN, 0);
    for (const candidate of this.v1Only) {
      const name = candidate.adjudication ?? AWAITING_HUMAN;
      tally.set(name, (tally.get(name) ?? 0) + 1);
    }
    return readOnlyMap(tally);
  }

  /**
   * AC-10's miss numerator -- and the only method that returns one.
   *
   * @throws {AdjudicationPending} while any `v1_only` candidate is
   *   unclassified. That is section 3.3's "never silently converts `v1_only`
   *   into a miss count" with the silence removed: there is no path from a
   *   candidate to a number that does not pass through here.
   * @throws {ShadowReferenceAbsent} if there was no second observer.
   */
  confirmedMissCount(): number {
    this.requireReference();
    const pending = this.awaitingAdjudication();
    if (pending.length > 0) {
      throw new AdjudicationPending(
        `${pending.length} v1_only episode(s) are unclassified ` +
          `(${pending.map((candidate) => candidate.episode.episodeId).join(", ")}); ` +
          "v1 raising an episode Interlock did not can also mean v1 false " +
          "positived, so a miss count cannot be taken until each is " +
          "settled by a fixture label or by human adjudication " +
          "(measurement-harness.md section 3.3)",
      );
    }
    return this.v1Only.filter((candidate) => candidate.isMiss).length;
  }
}

/**
 * The ids the windows module says cannot be judged in this period.
 *
 * Both censored buckets, folded into one set: section 3.5 excludes right- and
 * left-censored episodes from the *same* numerators, and the reconciliation has
 * one censored bucket to file them in. They stay distinguishable where that
 * matters -- on {@link WindowReport}, which keeps them apart so a reader can
 * tell which end of the period is too tight.
 *
 * This is the only place censoring enters the reconciliation. Recomputing it
 * here from onsets and budgets would be a second implementation of section 3.5
 * that agrees with the first until a grace value changes.
 */
export function censoredEpisodeIds(report: WindowReport): ReadonlySet<string> {
  return new Set([...report.idsFor(WINDOW_CENSORED), ...report.idsFor(WINDOW_CENSORED_LEFT)]);
}

// ---------------------------------------------------------------------------
// Interlock-side readers. Each one is section 3.3's row for its subject class.
// ---------------------------------------------------------------------------

/** The `ci_outcome` reader's statement, carried verbatim from the source. */
export const CI_OUTCOME_EPISODES_QUERY = `
        SELECT p.pr_number        AS pr_number,
               p.head_sha         AS head_sha,
               p.repo_id          AS repo_id,
               r.provider         AS provider,
               lower(r.owner) || '/' || lower(r.name) AS slug,
               MIN(v.occurred_at_ms) AS onset_ms
          FROM pull_request p
          JOIN repository r
            ON r.repo_id = p.repo_id
          JOIN ci_current_verdict v
            ON v.repo_id = p.repo_id
           AND v.pr_number = p.pr_number
           AND v.head_sha = p.head_sha
         GROUP BY p.repo_id, p.pr_number, p.head_sha
        HAVING MIN(v.occurred_at_ms) >= ?
           AND MIN(v.occurred_at_ms) < ?
         ORDER BY onset_ms ASC, p.repo_id ASC, p.pr_number ASC
        `;

/** The `pr_merge` reader's statement, carried verbatim from the source. */
export const PR_MERGE_EPISODES_QUERY = `
        SELECT p.pr_id       AS pr_id,
               p.repo_id     AS repo_id,
               p.pr_number   AS pr_number,
               p.merged_at_ms AS merged_at_ms,
               p.merge_commit_sha AS merge_commit_sha,
               r.provider    AS provider,
               lower(r.owner) || '/' || lower(r.name) AS slug
          FROM pull_request p
          JOIN repository r
            ON r.repo_id = p.repo_id
         WHERE p.state = 'merged'
           AND p.merged_at_ms >= ?
           AND p.merged_at_ms < ?
         ORDER BY p.merged_at_ms ASC, p.pr_id ASC
        `;

/** The `worker_escalation` reader's statement, carried verbatim from the source. */
export const WORKER_ESCALATION_EPISODES_QUERY = `
        SELECT gate_id, run_id, created_at_ms, stage, outcome, ordinal
          FROM (
            SELECT g.gate_id        AS gate_id,
                   g.run_id         AS run_id,
                   g.created_at_ms  AS created_at_ms,
                   g.stage          AS stage,
                   g.outcome        AS outcome,
                   CASE WHEN g.run_id IS NULL THEN NULL
                        ELSE ROW_NUMBER() OVER (
                            PARTITION BY g.run_id
                            ORDER BY g.created_at_ms ASC, g.gate_id ASC)
                   END AS ordinal
              FROM gate g
             WHERE g.gate_type = 'worker_escalation'
          )
         WHERE created_at_ms >= ? AND created_at_ms < ?
         ORDER BY created_at_ms ASC, gate_id ASC
        `;

/**
 * The `session_liveness` reader's statement, carried verbatim from the source.
 * `{placeholders}` stands in for the `IN` list, which is built per call.
 */
export const SESSION_LIVENESS_EPISODES_QUERY = `
        SELECT i.incident_id                    AS incident_id,
               COALESCE(i.run_id, s.run_id)     AS run_id,
               i.session_id                     AS session_id,
               i.fact_state                     AS fact_state,
               i.created_at_ms                  AS created_at_ms,
               i.elapsed_ms                     AS elapsed_ms
          FROM incident i
          LEFT JOIN session s
            ON s.session_id = i.session_id
         WHERE i.fact_state IN ({placeholders})
         ORDER BY i.created_at_ms ASC, i.incident_id ASC
        `;

/** Every query this module runs, for the report's provenance header. */
export const QUERY_DEFINITIONS: ReadonlyMap<string, string> = readOnlyMap([
  ["shadow_ci_outcome_episodes", CI_OUTCOME_EPISODES_QUERY],
  ["shadow_pr_merge_episodes", PR_MERGE_EPISODES_QUERY],
  ["shadow_worker_escalation_episodes", WORKER_ESCALATION_EPISODES_QUERY],
  ["shadow_session_liveness_episodes", SESSION_LIVENESS_EPISODES_QUERY],
]);

/**
 * CI outcome episodes: one per PR head, keyed `(provider, slug, pr, head)`.
 *
 * One episode per **head**, not per observation, because that is what the key's
 * granularity says the condition is: a head has one CI outcome, observed many
 * times across scopes and attempts. The outcome itself is
 * {@link prVerdict} -- section 6.3's projection, imported rather than folded
 * again here, because a second severity fold would agree with the first until
 * the day `indeterminate` stopped outranking `passed` and then report an
 * unobservable check as a green one in exactly one place.
 *
 * The onset is the earliest `occurred_at_ms` among the head's *currently
 * eligible* observations: the provider's instant at which this head's CI
 * outcome began to be observable. Ingest time is not used anywhere -- `D-0033`
 * says arrival order never decides a verdict, and it must not decide an onset
 * either, or a slow poll would move an episode across a period boundary that
 * the world never crossed.
 *
 * `onsetFromMs` / `onsetToMs` are a half-open **selection** window, not the
 * report period. A caller that wants left-censored episodes (section 3.5)
 * widens the lower bound past `periodStartMs` on purpose; the windows module,
 * not this reader, decides what is censored.
 */
export function readCiOutcomeEpisodes(
  connection: SqliteDatabase,
  options: { readonly onsetFromMs: number; readonly onsetToMs: number },
): readonly ShadowEpisode[] {
  const { onsetFromMs, onsetToMs } = options;
  requireSelectionWindow(onsetFromMs, onsetToMs);
  // lower(owner) || '/' || lower(name) is the SAME expression the
  // repository_by_slug UNIQUE INDEX is built on (0001_initial.sql: "Case is
  // preserved in the columns and folded in the index"). Spelling the fold
  // independently -- JavaScript's String.prototype.toLowerCase(), which is
  // Unicode-aware, against SQLite's lower(), which folds ASCII only -- would
  // make this module a second source of truth for one thing: the two agree on
  // every ASCII slug and disagree the moment an owner name carries a non-ASCII
  // letter, at which point the key names a repository the database's own index
  // never named, and the episode fails to pair for a reason invisible in both
  // systems' data. Folding in SQL keeps one implementation of "the same
  // repository".
  const rows = connection.prepare(CI_OUTCOME_EPISODES_QUERY).all(onsetFromMs, onsetToMs) as {
    pr_number: number;
    head_sha: string;
    repo_id: string;
    provider: string;
    slug: string;
    onset_ms: number;
  }[];

  const episodes: ShadowEpisode[] = [];
  for (const row of rows) {
    const prNumber = Number(row.pr_number);
    const repoId = String(row.repo_id);
    const verdict = prVerdict(connection, { repoId, prNumber });
    const key = new CorrelationKey({
      subjectClass: SUBJECT_CI_OUTCOME,
      parts: [String(row.provider), String(row.slug), String(prNumber), String(row.head_sha)],
    });
    episodes.push(
      new ShadowEpisode({
        episodeId: `ci:${repoId}:${prNumber}:${row.head_sha}`,
        subjectClass: SUBJECT_CI_OUTCOME,
        shape: verdict,
        onsetMs: Number(row.onset_ms),
        key,
        evidence: [
          ["repo_id", repoId],
          ["head_sha", String(row.head_sha)],
          ["verdict", verdict],
        ],
      }),
    );
  }
  return frozenList(episodes);
}

/**
 * PR merge episodes, keyed `(provider, slug, pr_number)`.
 *
 * The head SHA is deliberately **not** in this key even though `pull_request`
 * holds one: a merge is a fact about the pull request, and the two systems can
 * hold different heads for it (v1 recorded a `pr_url` and re-resolved the head
 * at read time). Including it would make every merge unmatched whenever a head
 * update raced the merge, which is the ordinary case, not the exceptional one.
 *
 * The onset is `merged_at_ms` -- the provider's own instant, which the
 * `pull_request` CHECKs tie to `state = 'merged'` so the two cannot disagree.
 */
export function readPrMergeEpisodes(
  connection: SqliteDatabase,
  options: { readonly onsetFromMs: number; readonly onsetToMs: number },
): readonly ShadowEpisode[] {
  const { onsetFromMs, onsetToMs } = options;
  requireSelectionWindow(onsetFromMs, onsetToMs);
  // The same slug fold as readCiOutcomeEpisodes, for the same reason.
  const rows = connection.prepare(PR_MERGE_EPISODES_QUERY).all(onsetFromMs, onsetToMs) as {
    pr_id: string;
    repo_id: string;
    pr_number: number;
    merged_at_ms: number;
    merge_commit_sha: string;
    provider: string;
    slug: string;
  }[];

  return frozenList(
    rows.map(
      (row) =>
        new ShadowEpisode({
          episodeId: `merge:${row.pr_id}`,
          subjectClass: SUBJECT_PR_MERGE,
          shape: "merged",
          onsetMs: Number(row.merged_at_ms),
          key: new CorrelationKey({
            subjectClass: SUBJECT_PR_MERGE,
            parts: [String(row.provider), String(row.slug), String(Number(row.pr_number))],
          }),
          evidence: [
            ["pr_id", String(row.pr_id)],
            ["repo_id", String(row.repo_id)],
            ["merge_commit_sha", String(row.merge_commit_sha)],
          ],
        }),
    ),
  );
}

/**
 * Worker escalation episodes, keyed `(run_id, nth escalation of that run)`.
 *
 * **This is the positional key, and it is the weakest join in the
 * reconciliation** (sections 3.3 and 7). v1's `.state/pending_decisions.json`
 * entries carry an id Interlock never sees, so the only key both sides can
 * compute is the ordinal of the escalation within its run, by receipt time. It
 * holds while both systems saw the same escalations in the same order -- and an
 * ordering divergence is precisely what the reconciliation exists to catch, so
 * its failure mode is unmatched episodes on both sides rather than a confident
 * wrong pairing. Every key this function produces reports
 * {@link CorrelationKey.positional}, and {@link POSITIONAL_KEY_CAVEAT} rides on
 * the report.
 *
 * Two more details the position depends on, stated because both are silent when
 * wrong:
 *
 * * The ordinal is computed over the run's **whole** escalation history and
 *   only then filtered to the selection window. Numbering within the window
 *   would renumber the same escalation differently in a weekly and a daily
 *   report, and the two reports would disagree about which episode is which.
 * * Receipt time is `created_at_ms` -- the `received` stage's instant, which
 *   `0001_initial.sql` requires `stage_entered_at_ms` to be at or after. Ties
 *   are broken by `gate_id` so the numbering is deterministic; a tie means two
 *   escalations arrived in the same millisecond and their relative order is
 *   genuinely unknown, which is one more way the positional key can mispair,
 *   and it surfaces the same safe way.
 *
 * A gate with no `run_id` (the column is nullable: a merge approval or a risk
 * approval need not belong to a run) can compute no key at all and is returned
 * with a `keyGap` -- section 3.3's `unmatched_key` bucket -- rather than
 * dropped.
 */
export function readWorkerEscalationEpisodes(
  connection: SqliteDatabase,
  options: { readonly onsetFromMs: number; readonly onsetToMs: number },
): readonly ShadowEpisode[] {
  const { onsetFromMs, onsetToMs } = options;
  requireSelectionWindow(onsetFromMs, onsetToMs);
  const rows = connection.prepare(WORKER_ESCALATION_EPISODES_QUERY).all(onsetFromMs, onsetToMs) as {
    gate_id: string;
    run_id: string | null;
    created_at_ms: number;
    stage: string;
    outcome: string | null;
    ordinal: number | null;
  }[];

  const episodes: ShadowEpisode[] = [];
  for (const row of rows) {
    const gateId = String(row.gate_id);
    const runId = row.run_id;
    const evidence: [string, string][] = [
      ["gate_id", gateId],
      ["stage", String(row.stage)],
      ["outcome", row.outcome === null ? "" : String(row.outcome)],
    ];
    if (runId === null) {
      episodes.push(
        new ShadowEpisode({
          episodeId: `escalation:${gateId}`,
          subjectClass: SUBJECT_WORKER_ESCALATION,
          shape: String(row.stage),
          onsetMs: Number(row.created_at_ms),
          keyGap:
            "gate.run_id is NULL, so the escalation has no run to be the nth " +
            "escalation of; section 3.3's key cannot be composed for it",
          evidence,
        }),
      );
      continue;
    }
    episodes.push(
      new ShadowEpisode({
        episodeId: `escalation:${gateId}`,
        subjectClass: SUBJECT_WORKER_ESCALATION,
        shape: String(row.stage),
        onsetMs: Number(row.created_at_ms),
        key: new CorrelationKey({
          subjectClass: SUBJECT_WORKER_ESCALATION,
          parts: [String(runId), String(Number(row.ordinal))],
        }),
        evidence: [...evidence, ["run_id", String(runId)]],
      }),
    );
  }
  return frozenList(episodes);
}

/**
 * Session liveness episodes, keyed `(run_id, 60 s onset bucket)`.
 *
 * `factStates` is required and has no default. `incident.fact_state` is
 * unconstrained text on purpose -- `0001_initial.sql` says the closed `D-0005`
 * set lives in `DECISIONS.md` because a `CHECK` would turn extending it into a
 * migration -- so the schema cannot tell this reader which states are the
 * liveness class. A default here would be this module quietly deciding what
 * AC-10's session-liveness denominator contains, which is the kind of
 * convenient default that makes a predicate go missing: widen it and the miss
 * rate falls, narrow it and it rises, and nothing in the report says which
 * happened.
 *
 * **The onset is not `created_at_ms`.** `created_at_ms` is when *we* raised the
 * incident, and the two systems detect the same condition at different
 * latencies -- which is the very quantity AC-10 measures, so keying on it would
 * guarantee the two sides bucket differently exactly when they disagree most.
 * The onset is `created_at_ms - elapsed_ms`: `elapsed_ms` is how long the
 * condition had been running when the packet was built (`D-0007`'s packet), so
 * the difference is the state entry -- section 3.2's "when the condition
 * **began**", not the tolerance crossing. An incident with no `elapsed_ms` (the
 * column is nullable) has no computable onset and comes back with a `keyGap`;
 * substituting `created_at_ms` would put the episode in a bucket up to a whole
 * detection latency away from v1's and report a match as a miss.
 *
 * `run_id` is taken from the incident, falling back to the incident's session
 * binding -- section 3.3's "`incident` joined to `session`". Both columns are
 * nullable, and an incident that names neither carries a `keyGap`.
 *
 * **Keyless rows are windowed too.** A row that cannot compute its key is still
 * selected only if the instant it *can* state falls in
 * `[onsetFromMs, onsetToMs)`. Without that, every historical malformed incident
 * would be filed `unmatched_key` in every report and counted again by each
 * adjacent period, and section 7 reads that bucket as the signal that the key
 * needs replacing -- a signal a permanent backlog of ancient rows would drown.
 * The instant differs by which column is missing, and the episode declares
 * which it used in {@link ShadowEpisode.onsetBasis} rather than hiding it in a
 * branch:
 *
 * * `run_id` missing but `elapsed_ms` present: the onset is still derivable, so
 *   it is windowed on the onset ({@link ONSET_OBSERVED}).
 * * `elapsed_ms` missing: no onset is derivable, and the row is windowed on
 *   `created_at_ms` ({@link ONSET_UPPER_BOUND}), which `0001_initial.sql` pins
 *   `NOT NULL` and whose `elapsed_ms >= 0` check makes an upper bound on the
 *   onset. The true onset may belong to an earlier period, so the report
 *   carries {@link BOUNDED_ONSET_CAVEAT}; that is a disclosed one-period
 *   uncertainty, where the alternatives were dropping the row silently (section
 *   3.3 forbids it) or admitting it to every period at once.
 */
export function readSessionLivenessEpisodes(
  connection: SqliteDatabase,
  options: {
    readonly onsetFromMs: number;
    readonly onsetToMs: number;
    readonly factStates: readonly string[];
  },
): readonly ShadowEpisode[] {
  const { onsetFromMs, onsetToMs, factStates } = options;
  requireSelectionWindow(onsetFromMs, onsetToMs);
  if (factStates.length === 0) {
    throw new ShadowRefusal(
      "readSessionLivenessEpisodes needs the fact_state values that make up " +
        "the session-liveness class; incident.fact_state is unconstrained text " +
        "(0001_initial.sql) and this reader will not guess which states belong " +
        "to the class",
    );
  }

  const placeholders = factStates.map(() => "?").join(", ");
  const rows = connection
    .prepare(SESSION_LIVENESS_EPISODES_QUERY.replace("{placeholders}", placeholders))
    .all(...factStates) as {
    incident_id: string;
    run_id: string | null;
    session_id: string | null;
    fact_state: string;
    created_at_ms: number;
    elapsed_ms: number | null;
  }[];

  const episodes: ShadowEpisode[] = [];
  for (const row of rows) {
    const incidentId = String(row.incident_id);
    const factState = String(row.fact_state);
    const createdAtMs = Number(row.created_at_ms);
    const elapsedMs = row.elapsed_ms;
    const runId = row.run_id;

    const gaps: string[] = [];
    if (runId === null) {
      gaps.push(
        "the incident names neither a run_id nor a session whose run_id could " + "stand in for it",
      );
    }
    if (elapsedMs === null) {
      gaps.push(
        "incident.elapsed_ms is NULL, so the condition's onset cannot be " +
          "derived from the instant we raised the incident",
      );
    }
    // The instant this episode is selected on, and what that instant is. With
    // elapsed_ms the onset is derivable even when run_id is missing; without it
    // the only instant the row carries is created_at_ms, which 0001_initial.sql
    // pins NOT NULL and (elapsed_ms >= 0) makes an upper bound on the onset --
    // so it is a bound, not the onset, and the episode says so rather than
    // passing it off as one.
    const instantMs = elapsedMs === null ? createdAtMs : createdAtMs - Number(elapsedMs);
    const onsetBasis = elapsedMs === null ? ONSET_UPPER_BOUND : ONSET_OBSERVED;

    // The window is applied to every row, keyless ones included. A key gap is
    // not a window exemption: a keyless row admitted here regardless of period
    // would land in unmatched_key in every report forever and be counted again
    // by every adjacent period, and section 7 reads that bucket as "the key
    // needs replacing" -- a reading a permanent backlog of ancient rows
    // destroys.
    if (!(onsetFromMs <= instantMs && instantMs < onsetToMs)) {
      continue;
    }

    if (gaps.length > 0) {
      episodes.push(
        new ShadowEpisode({
          episodeId: `liveness:${incidentId}`,
          subjectClass: SUBJECT_SESSION_LIVENESS,
          shape: factState,
          onsetMs: instantMs,
          onsetBasis,
          keyGap: gaps.join("; "),
          evidence: [
            ["incident_id", incidentId],
            ["fact_state", factState],
            ["created_at_ms", String(createdAtMs)],
            ["onset_basis", onsetBasis],
          ],
        }),
      );
      continue;
    }

    const onsetMs = instantMs;
    // Floor division, so a negative onset (a clock the caller handed us from
    // before the epoch of the selection window) buckets downward like every
    // other instant rather than toward zero, which would put two adjacent
    // onsets either side of 0 into the same bucket.
    const bucket = Math.floor(onsetMs / ONSET_BUCKET_MS);
    episodes.push(
      new ShadowEpisode({
        episodeId: `liveness:${incidentId}`,
        subjectClass: SUBJECT_SESSION_LIVENESS,
        shape: factState,
        onsetMs,
        key: new CorrelationKey({
          subjectClass: SUBJECT_SESSION_LIVENESS,
          parts: [String(runId), String(bucket)],
        }),
        evidence: [
          ["incident_id", incidentId],
          ["run_id", String(runId)],
          ["session_id", row.session_id === null ? "" : String(row.session_id)],
          ["fact_state", factState],
          ["elapsed_ms", String(Number(elapsedMs))],
        ],
      }),
    );
  }
  return frozenList(episodes);
}

/**
 * Every subject class of section 3.3's table, in table order.
 *
 * One call rather than four so that adding a fifth subject class cannot be
 * half-done: a class present in {@link SUBJECT_CLASSES} and absent here would
 * contribute episodes on the v1 side and none on ours, and every one of them
 * would be filed as a candidate miss.
 */
export function readInterlockEpisodes(
  connection: SqliteDatabase,
  options: {
    readonly onsetFromMs: number;
    readonly onsetToMs: number;
    readonly livenessFactStates: readonly string[];
  },
): readonly ShadowEpisode[] {
  const { onsetFromMs, onsetToMs, livenessFactStates } = options;
  return frozenList([
    ...readCiOutcomeEpisodes(connection, { onsetFromMs, onsetToMs }),
    ...readPrMergeEpisodes(connection, { onsetFromMs, onsetToMs }),
    ...readWorkerEscalationEpisodes(connection, { onsetFromMs, onsetToMs }),
    ...readSessionLivenessEpisodes(connection, {
      onsetFromMs,
      onsetToMs,
      factStates: livenessFactStates,
    }),
  ]);
}

function requireSelectionWindow(onsetFromMs: number, onsetToMs: number): void {
  if (onsetToMs <= onsetFromMs) {
    throw new ShadowRefusal(
      `the selection window [${onsetFromMs}, ${onsetToMs}) is empty or ` +
        "inverted; a half-open window must end strictly after it starts " +
        "(time-base-policy.md section 2, rule 4)",
    );
  }
}

// ---------------------------------------------------------------------------
// The reconciliation itself. Pure: no connection, no clock, no v1 file paths.
// ---------------------------------------------------------------------------

/**
 * File every episode from both systems into exactly one of the five buckets.
 *
 * `censoredIds` comes from {@link censoredEpisodeIds} over the windows module's
 * report (section 3.5). It is a required argument with no default: a caller who
 * has not classified windows must say so by passing an empty set, because the
 * alternative -- an implicit "nothing is censored" -- is the manufactured-miss
 * defect section 3.5 exists to remove, arriving through a keyword argument
 * nobody typed.
 *
 * `fixtureLabels` maps an episode {@link ShadowEpisode.shape} to one of
 * {@link ADJUDICATIONS}, and it too is required with no default. An empty map
 * is a legitimate value and means every `v1_only` episode goes to human
 * adjudication; leaving it out would let a report claim a settled miss count on
 * the strength of a corpus it never consulted.
 *
 * **Order of filing, and why censoring wins.** A censored episode's window
 * extends outside the period, so the report cannot say whether it was detected
 * in time -- and that is true whether or not its counterpart happens to be
 * present in the same period. So episodes are matched *first* and censoring is
 * applied *after*: a matched pair with either half censored is censored, and an
 * unmatched censored episode is censored rather than a candidate miss. Matching
 * first is what stops a censored Interlock episode from turning its
 * perfectly-present v1 counterpart into a fabricated miss.
 */
export function reconcile(options: {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly interlockEpisodes: Iterable<ShadowEpisode>;
  readonly v1Reference: V1Reference;
  readonly censoredIds: Iterable<string>;
  readonly fixtureLabels: ReadonlyMap<string, string>;
}): ShadowReconciliation {
  const { periodStartMs, periodEndMs, v1Reference, fixtureLabels } = options;

  if (periodEndMs <= periodStartMs) {
    throw new ShadowRefusal(
      `the report period [${periodStartMs}, ${periodEndMs}) is empty or ` +
        "inverted; a half-open window must end strictly after it starts " +
        "(time-base-policy.md section 2, rule 4)",
    );
  }
  for (const [shape, label] of fixtureLabels) {
    if (!ADJUDICATIONS.includes(label)) {
      throw new UnknownAdjudication(
        `fixture label for shape ${pythonRepr(shape)} is ${pythonRepr(label)}, which is not one ` +
          `of ${ADJUDICATIONS.join(", ")}`,
      );
    }
  }

  const interlock = [...options.interlockEpisodes];
  refuseDuplicateIds(interlock, v1Reference.episodes);

  if (!v1Reference.available) {
    return new ShadowReconciliation({
      periodStartMs,
      periodEndMs,
      shadowReference: SHADOW_ABSENT,
      shadowSource: null,
      shadowAbsentReason: v1Reference.absentReason,
      interlockEpisodeCount: interlock.length,
      both: [],
      interlockOnly: [],
      v1Only: [],
      unmatchedKey: [],
      censored: [],
    });
  }

  const censoredIds = new Set(options.censoredIds);

  const [interlockKeyed, interlockKeyless] = splitByKey(interlock, "interlock");
  const [v1Keyed, v1Keyless] = splitByKey(v1Reference.episodes, "v1");

  const both: MatchedPair[] = [];
  const interlockOnly: ShadowEpisode[] = [];
  const v1Only: V1OnlyEpisode[] = [];
  let unmatchedKey: ShadowEpisode[] = [...interlockKeyless, ...v1Keyless];
  const censored: ShadowEpisode[] = [];

  const matchedV1Tokens = new Set<string>();
  for (const [token, episode] of interlockKeyed) {
    const counterpart = v1Keyed.get(token);
    if (counterpart === undefined) {
      if (censoredIds.has(episode.episodeId)) {
        censored.push(episode);
      } else {
        interlockOnly.push(episode);
      }
      continue;
    }
    matchedV1Tokens.add(token);
    if (censoredIds.has(episode.episodeId) || censoredIds.has(counterpart.episodeId)) {
      censored.push(episode);
      censored.push(counterpart);
      continue;
    }
    // splitByKey only files an episode under a token it computed from a key, so
    // this key exists by construction; naming it in a local keeps that fact
    // where a reader can see it.
    const matchedKey = episode.key;
    if (matchedKey === null) {
      /* c8 ignore next 4 -- unreachable by construction */
      throw new EpisodeKeyRefused(
        `episode ${pythonRepr(episode.episodeId)} was matched by key and then found to ` +
          "have none",
      );
    }
    both.push(new MatchedPair({ key: matchedKey, interlock: episode, v1: counterpart }));
  }

  for (const [token, episode] of v1Keyed) {
    if (matchedV1Tokens.has(token)) {
      continue;
    }
    if (censoredIds.has(episode.episodeId)) {
      censored.push(episode);
      continue;
    }
    v1Only.push(adjudicate(episode, fixtureLabels));
  }

  // A keyless episode that is also censored is filed censored, for the same
  // reason a matched one is: the report cannot judge it either way, and
  // inflating the unmatched_key bucket with window problems would corrupt the
  // one signal section 7 reads out of it -- whether the KEY needs replacing.
  const [kept, keyCensored] = partitionCensored(unmatchedKey, censoredIds);
  unmatchedKey = kept;
  censored.push(...keyCensored);

  return new ShadowReconciliation({
    periodStartMs,
    periodEndMs,
    shadowReference: SHADOW_PRESENT,
    shadowSource: v1Reference.source,
    shadowAbsentReason: null,
    interlockEpisodeCount: interlock.length,
    both,
    interlockOnly,
    v1Only,
    unmatchedKey,
    censored,
  });
}

/**
 * Settle one candidate miss by fixture label, or hand it to a human.
 *
 * Section 3.2's corpus is the only automatic source: a fixture that covers the
 * same *shape* already carries the ground-truth verdict for it. Anything else
 * is listed, with its evidence, and nothing here invents a verdict from the
 * episode's own fields -- doing so would make the miss count a function of
 * Interlock's opinion about v1's data, which is the circularity section 3.1
 * rules out.
 */
function adjudicate(
  episode: ShadowEpisode,
  fixtureLabels: ReadonlyMap<string, string>,
): V1OnlyEpisode {
  const label = fixtureLabels.get(episode.shape);
  if (label === undefined) {
    return new V1OnlyEpisode({
      episode,
      adjudication: null,
      adjudicationSource: AWAITING_HUMAN,
    });
  }
  return new V1OnlyEpisode({
    episode,
    adjudication: label,
    adjudicationSource: FROM_FIXTURE_LABEL,
  });
}

function splitByKey(
  episodes: Iterable<ShadowEpisode>,
  side: string,
): [Map<string, ShadowEpisode>, ShadowEpisode[]] {
  const keyed = new Map<string, ShadowEpisode>();
  const keyless: ShadowEpisode[] = [];
  for (const episode of episodes) {
    if (episode.key === null) {
      keyless.push(episode);
      continue;
    }
    const token = episode.key.token();
    const existing = keyed.get(token);
    if (existing !== undefined) {
      throw new DuplicateCorrelationKey(
        `${side} episodes ${pythonRepr(existing.episodeId)} and ${pythonRepr(episode.episodeId)} ` +
          `compute the same ${pythonRepr(episode.key.subjectClass)} correlation key ` +
          `${pythonTupleRepr(episode.key.parts)}; matching is one-to-one and ` +
          "the loser would be filed as a fabricated improvement or a " +
          "fabricated miss" +
          (episode.key.positional ? `. ${POSITIONAL_KEY_CAVEAT}` : ""),
      );
    }
    keyed.set(token, episode);
  }
  return [keyed, keyless];
}

function partitionCensored(
  episodes: Iterable<ShadowEpisode>,
  censoredIds: ReadonlySet<string>,
): [ShadowEpisode[], ShadowEpisode[]] {
  const kept: ShadowEpisode[] = [];
  const censored: ShadowEpisode[] = [];
  for (const episode of episodes) {
    (censoredIds.has(episode.episodeId) ? censored : kept).push(episode);
  }
  return [kept, censored];
}

function refuseDuplicateIds(
  interlock: readonly ShadowEpisode[],
  v1: readonly ShadowEpisode[],
): void {
  const seen = new Map<string, string>();
  for (const [side, episodes] of [
    ["interlock", interlock],
    ["v1", v1],
  ] as const) {
    for (const episode of episodes) {
      const previous = seen.get(episode.episodeId);
      if (previous !== undefined) {
        throw new DuplicateEpisodeIdRefused(
          `episode_id ${pythonRepr(episode.episodeId)} appears on the ${previous} side ` +
            `and again on the ${side} side; ids are how censoring and the ` +
            "partition check address an episode, and a collision applies one " +
            "episode's window to another's",
        );
      }
      seen.set(episode.episodeId, side);
    }
  }
}

/**
 * The report as text. ASCII only -- this reaches a cp932 console.
 *
 * The unadjudicated candidates are printed unconditionally when there are any.
 * A rendering that showed the bucket counts and left the open list to a
 * separate command would let the reader take `v1_only: 3` for a miss count,
 * which is the exact conversion section 3.3 forbids.
 */
export function renderShadowReconciliation(report: ShadowReconciliation): string {
  const lines = [`Shadow reconciliation [${report.periodStartMs}, ${report.periodEndMs})`];
  if (!report.available) {
    lines.push("  shadow reference: ABSENT");
    lines.push(`  reason: ${report.shadowAbsentReason}`);
    lines.push(`  Interlock episodes read: ${report.interlockEpisodeCount}`);
    lines.push(
      "  No comparison is reported. Without a second observer none of " +
        "these episodes can be called an improvement or a miss.",
    );
    return lines.join("\n");
  }

  lines.push(`  shadow reference: ${report.shadowSource}`);
  for (const [bucket, count] of report.counts()) {
    lines.push(`  ${bucket}: ${count}`);
  }

  const adjudications = report.adjudicationCounts();
  lines.push(
    "  v1_only adjudication: " +
      ADJUDICATIONS.map((name) => `${name}=${adjudications.get(name)}`).join(", ") +
      `, ${AWAITING_HUMAN}=${adjudications.get(AWAITING_HUMAN)}`,
  );

  const pending = report.awaitingAdjudication();
  if (pending.length > 0) {
    lines.push("  awaiting human adjudication:");
    for (const candidate of pending) {
      const episode = candidate.episode;
      const evidence = [...episode.evidence.entries()]
        .sort(([left], [right]) => comparePythonStrings(left, right))
        .map(([name, value]) => `${name}=${value}`)
        .join(", ");
      lines.push(
        `    - ${episode.episodeId} (${episode.subjectClass}/${episode.shape}, ` +
          `onset ${episode.onsetMs}) ${evidence}`,
      );
    }
    lines.push("  No miss count is available until each of the above is settled.");
  } else {
    lines.push(`  confirmed misses: ${report.confirmedMissCount()}`);
  }

  if (report.unmatchedKey.some((episode) => episode.positionalKey)) {
    lines.push(`  NOTE: ${report.positionalCaveat}`);
  }
  if (report.unmatchedKey.some((episode) => episode.onsetBasis !== ONSET_OBSERVED)) {
    // Otherwise the bucket's period boundaries read as exact, and a reader
    // comparing two adjacent reports has no way to see that some of these
    // episodes were placed on a bound.
    lines.push(`  NOTE: ${BOUNDED_ONSET_CAVEAT}`);
  }
  return lines.join("\n");
}
