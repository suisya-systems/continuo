import type { Database as SqliteDatabase } from "better-sqlite3";

import { detectionLatency, resolveToleranceMs, subjectUnitMs } from "../control_plane/policy.js";
import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import { pythonRepr } from "./format.js";
import { frozenList, readOnlyMap } from "./immutable.js";

/**
 * G6 -- the observation window, and the two ways a report boundary invents a
 * miss.
 *
 * The failure this module is written against is a rate that moves when nothing
 * in the system moved. `docs/measurement-harness.md` section 3.5 names it: an
 * episode detected fifteen seconds after the report period ended is, to a
 * harness that judges every episode against the period it happens to fall in, a
 * **miss** -- and it is not one. The detector met its budget; the report simply
 * stopped watching first. Worse, the defect is not a constant offset: the
 * shorter the period, the larger the fraction of episodes whose budget outlives
 * it, so the manufactured miss rate **rises as the period shortens**. A weekly
 * report and a daily report over the same week would disagree, and the daily one
 * would look worse, with nothing anywhere saying why.
 *
 * The rule that removes it, verbatim from section 3.5:
 *
 * > Every episode gets a window `[onset, onset + L_class + grace)`, half-open,
 * > with `grace` a single declared value per report. **An episode whose window
 * > is not fully inside the report period is censored: excluded from the miss
 * > and latency numerators, counted in its own bucket, and reported.** The
 * > mirror case -- an episode whose onset precedes the period -- is excluded the
 * > same way and counted as `censored_left`.
 *
 * **Both ends exist, and they are different facts.** A right-censored episode
 * has a trustworthy onset and an unfinished budget, so the report cannot yet say
 * whether it was detected in time. A left-censored one is worse: its onset is
 * outside the window the report read, so the latency it would compute is
 * measured from an instant it did not observe. Collapsing the two into one
 * bucket would hide which end of the period is too tight, so {@link CENSORED}
 * and {@link CENSORED_LEFT} are counted separately and an episode that is both
 * is filed left (see {@link classify}).
 *
 * **The censored counts are required output, at zero as much as at a thousand.**
 * They are not diagnostics for whoever is debugging the harness -- they are the
 * one number that makes a *period too short for the budgets it is judging*
 * visible. A report whose censored episodes are a large fraction of its total is
 * judging an `L` of ten minutes over a window that barely holds one, and its
 * miss rate is an artefact of that. Printing the miss rate without the censored
 * count leaves the reader no way to tell that report from a good one, so
 * {@link WindowReport.counts} always emits all three keys and never omits a
 * bucket for being empty.
 *
 * **Grace is policy data, never a constant here.** It defaults to one reconcile
 * period, because an episode must not be judged a miss for losing a race with
 * the pass that would have caught it -- and that period is read from
 * `policy_detection_latency.reconcile_period_ms` for the caller-resolved
 * revision ({@link defaultGraceMs}), not written into this file. Interlock
 * `D-0031` puts every tolerance and interval in versioned data precisely so that
 * a past report can be recomputed under the numbers it was actually judged by; a
 * `120_000` typed here would be a policy decision that no `policy_revision`
 * records and no new revision can change.
 *
 * **`L` is resolved, never assumed.** `time-base-policy.md` section 3.2 makes
 * three of the ten classes relative: `watcher_silence`'s `T` scales with *that
 * scope's* poll interval, `lease_orphan`'s `T` **and** `L` with *that lease's*
 * own TTL, and `watcher_error_streak`'s `T` is a count with no duration in it at
 * all. So the window's length depends on the subject, the subject is an explicit
 * parameter, and an absent one is {@link SubjectRequired} rather than a fallback
 * -- the only fallback available is the bare multiple, which would give
 * `lease_orphan` a two-millisecond window and censor nothing while marking
 * everything a miss.
 *
 * **Nothing here writes, and nothing here reads a clock.** The connection is the
 * read-only handle from {@link openForMeasurement}; the period bounds and every
 * onset are the caller's. Windows and the period are half-open at both ends
 * (`time-base-policy.md` section 2, rule 4), which is what lets an episode
 * ending exactly at `periodEndMs` be inside the report and an episode onsetting
 * exactly at `periodEndMs` be outside it, with no instant belonging to two
 * periods.
 *
 * **Scope.** This module classifies. It does not decide whether an episode was
 * detected, and it raises no incident and applies no remedy: the fixture
 * evaluator, the shadow reconciliation and the latency report consume these
 * windows and own those questions.
 */

/**
 * The three places an episode can land.
 *
 * Emitted in this order, **always**, and empty buckets are emitted too: a zero
 * and a missing key are different statements, and only one of them is the truth
 * this harness has.
 */
export const IN_PERIOD = "in_period";
export const CENSORED = "censored";
export const CENSORED_LEFT = "censored_left";

export const WINDOW_CLASSIFICATIONS: readonly string[] = frozenList([
  IN_PERIOD,
  CENSORED,
  CENSORED_LEFT,
]);

/**
 * How the report's single grace value was arrived at.
 *
 * Recorded on the report because interlock `D-0040` makes every number a report
 * was computed with part of the report: a reader who cannot tell a declared
 * grace from the revision's own reconcile period cannot recompute the
 * classification.
 */
export const GRACE_DECLARED = "declared";
export const GRACE_REVISION_RECONCILE_PERIOD = "revision_reconcile_period";

/** A window that cannot be computed or classified, stated rather than guessed. */
export class WindowRefusal extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "WindowRefusal";
    Object.setPrototypeOf(this, WindowRefusal.prototype);
  }
}

/**
 * The report's single grace value is neither declared nor derivable.
 *
 * Section 3.5 makes grace *one* value per report, and its default is "one
 * reconcile period". A revision whose classes carry more than one
 * `reconcile_period_ms` (section 3.3 permits a coarse class) has no single such
 * period, and picking one would be a policy decision made by this file: the
 * smallest manufactures misses for the coarse class, the largest excuses real
 * ones for the tight classes. The caller declares the value, and the report
 * records which it was.
 */
export class GraceNotDeclared extends WindowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "GraceNotDeclared";
    Object.setPrototypeOf(this, GraceNotDeclared.prototype);
  }
}

/**
 * A relative class was asked for a window with no subject to scale it.
 *
 * `watcher_silence` is three of *that scope's* polls; `lease_orphan`'s budget is
 * twice *that lease's* TTL. Without the subject the only number available is the
 * bare multiple -- 3, or 2 -- and using it yields a window a few milliseconds
 * long, which censors nothing and calls every episode a miss.
 */
export class SubjectRequired extends WindowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "SubjectRequired";
    Object.setPrototypeOf(this, SubjectRequired.prototype);
  }
}

/**
 * One `episode_id` was handed to a report twice.
 *
 * Section 3.3's correlation keys are what an episode id is built from, and a
 * positional key (the nth escalation of a run) can collide when the two systems
 * disagree about ordering -- the very divergence the report exists to surface.
 * Counting the collision twice would report it as two episodes and move both
 * numerators; refusing shows it as what it is.
 */
export class DuplicateEpisodeRefused extends WindowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DuplicateEpisodeRefused";
    Object.setPrototypeOf(this, DuplicateEpisodeRefused.prototype);
  }
}

/**
 * An episode was handed to a report whose period it does not touch at all.
 *
 * Deliberately not filed as `censored`. The censored count is the signal that
 * *this period is too short for these budgets*, and padding it with episodes
 * that have nothing to do with the period destroys exactly that signal -- a
 * report over an unrelated week would show a high censored fraction and read as
 * a period problem. Nor is the episode dropped: a silent drop is how a selection
 * bug survives, so the caller's selection is refused instead.
 */
export class EpisodeOutsidePeriod extends WindowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "EpisodeOutsidePeriod";
    Object.setPrototypeOf(this, EpisodeOutsidePeriod.prototype);
  }
}

/**
 * The report period is empty or inverted.
 *
 * `[start, end)` with `end <= start` contains no instant, so every episode would
 * be censored and the censored fraction -- the one number that says the period
 * is too short -- would be 100% for a reason that is not about censoring at all.
 */
export class PeriodRefused extends WindowRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PeriodRefused";
    Object.setPrototypeOf(this, PeriodRefused.prototype);
  }
}

/**
 * One real-world condition, as the report was handed it.
 *
 * `subject` is the identity a relative class scales by: a
 * `watcher_scope.scope_id` for `scope_interval_multiple`, a `lease.resource` for
 * `lease_ttl_multiple`. It is an explicit field and not an inference from
 * `episodeId`, because a guessed subject resolves to some other subject's
 * interval and the window is then wrong by a factor nobody can see.
 *
 * A class rather than an interface so the source's positional construction
 * (`Episode("e", ABSOLUTE_CLASS, onset)`) translates as positional construction,
 * which keeps the ported cases readable against their originals.
 */
export class Episode {
  readonly episodeId: string;
  readonly incidentClass: string;
  readonly onsetMs: number;
  readonly subject: string | null;

  constructor(
    episodeId: string,
    incidentClass: string,
    onsetMs: number,
    subject: string | null = null,
  ) {
    this.episodeId = episodeId;
    this.incidentClass = incidentClass;
    this.onsetMs = onsetMs;
    this.subject = subject;
    Object.freeze(this);
  }
}

/**
 * `[onsetMs, endMs)` for one episode, and where the period puts it.
 *
 * `toleranceMs` is `T` where `T` is a duration and `null` where it is a count
 * (`watcher_error_streak`). It is carried because `time-base-policy.md` section
 * 3.4 asks a report to read an alarm's age against **both** `T` and `L` -- a
 * detection at `T + epsilon` is prompt, one past `L` is a regression -- and a
 * consumer that had only `L` could not make that distinction without resolving
 * policy a second time.
 */
export class EpisodeWindow {
  readonly episodeId: string;
  readonly incidentClass: string;
  readonly subject: string | null;
  readonly onsetMs: number;
  readonly thresholdKind: string;
  readonly toleranceMs: number | null;
  readonly budgetMs: number;
  readonly graceMs: number;
  readonly endMs: number;
  readonly classification: string;

  constructor(fields: {
    readonly episodeId: string;
    readonly incidentClass: string;
    readonly subject: string | null;
    readonly onsetMs: number;
    readonly thresholdKind: string;
    readonly toleranceMs: number | null;
    readonly budgetMs: number;
    readonly graceMs: number;
    readonly endMs: number;
    readonly classification: string;
  }) {
    this.episodeId = fields.episodeId;
    this.incidentClass = fields.incidentClass;
    this.subject = fields.subject;
    this.onsetMs = fields.onsetMs;
    this.thresholdKind = fields.thresholdKind;
    this.toleranceMs = fields.toleranceMs;
    this.budgetMs = fields.budgetMs;
    this.graceMs = fields.graceMs;
    this.endMs = fields.endMs;
    this.classification = fields.classification;
    Object.freeze(this);
  }

  /**
   * Is this episode excluded from both numerators?
   *
   * One predicate rather than two, because the two exclusions are the same
   * exclusion: section 3.5 removes a censored episode from the miss numerator
   * *and* the latency numerator, and a consumer that applied it to one only
   * would report a latency distribution over episodes it had already agreed it
   * could not judge.
   */
  get censored(): boolean {
    return this.classification !== IN_PERIOD;
  }
}

/**
 * Every episode classified, with the numbers the classification rests on.
 *
 * `graceMs` and `graceSource` are on the report and not left implicit: the same
 * episodes under a different grace classify differently, so a report that did
 * not state its grace could not be recomputed (interlock `D-0040`), and section
 * 3.5's "a single declared value per report" is only checkable if the value is
 * written down.
 */
export class WindowReport {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly revisionId: number;
  readonly graceMs: number;
  readonly graceSource: string;
  readonly windows: readonly EpisodeWindow[];

  constructor(fields: {
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly revisionId: number;
    readonly graceMs: number;
    readonly graceSource: string;
    readonly windows: readonly EpisodeWindow[];
  }) {
    this.periodStartMs = fields.periodStartMs;
    this.periodEndMs = fields.periodEndMs;
    this.revisionId = fields.revisionId;
    this.graceMs = fields.graceMs;
    this.graceSource = fields.graceSource;
    // The source's field is a `tuple`; `frozenList` is what carries that
    // immutability into a runtime where `readonly` does not exist (D-0105's
    // sibling reasoning, and the same helpers).
    this.windows = frozenList(fields.windows);
    Object.freeze(this);
  }

  /**
   * Per-bucket counts, all three keys present **even at zero**.
   *
   * Required output, not a convenience: see the module comment on why the
   * censored count is what makes a too-short period visible, and why an absent
   * key reads as "nothing to report" when it means "this report was produced by
   * code that did not look".
   */
  counts(): ReadonlyMap<string, number> {
    const tally = new Map<string, number>(
      WINDOW_CLASSIFICATIONS.map((name): [string, number] => [name, 0]),
    );
    for (const window of this.windows) {
      const seen = tally.get(window.classification);
      if (seen === undefined) {
        // The source indexes a pre-seeded dict here, so a window carrying a
        // classification this module does not have raises `KeyError` there. A
        // `?? 0` fallback would instead grow a fourth bucket and print it as
        // legitimate report output -- the one thing a fixed key set exists to
        // prevent.
        //
        // A `RangeError` rather than a `WindowRefusal`, deliberately: the source
        // raises `KeyError`, which is outside its refusal family, so `except
        // WindowRefusal` does not catch it. A caller catching the refusal family
        // must not swallow this either, because it means a window object was
        // built with a classification no classifier produces -- a bug, not an
        // input the report may decline.
        throw new RangeError(
          `episode ${pythonRepr(window.episodeId)} carries classification ` +
            `${pythonRepr(window.classification)}, which is not one of ` +
            `${WINDOW_CLASSIFICATIONS.join(", ")}; a window with a classification ` +
            `this module does not produce cannot be counted into a report`,
        );
      }
      tally.set(window.classification, seen + 1);
    }
    return readOnlyMap(tally);
  }

  /**
   * The episodes the miss and latency numerators may both draw from.
   *
   * The same list answers both questions on purpose (see
   * {@link EpisodeWindow.censored}).
   */
  numeratorIds(): readonly string[] {
    return frozenList(
      this.windows.filter((window) => !window.censored).map((window) => window.episodeId),
    );
  }

  /** The episode ids in one bucket, in the order they were classified. */
  idsFor(classification: string): readonly string[] {
    if (!WINDOW_CLASSIFICATIONS.includes(classification)) {
      throw new WindowRefusal(
        `${pythonRepr(classification)} is not one of ${WINDOW_CLASSIFICATIONS.join(", ")}`,
      );
    }
    return frozenList(
      this.windows
        .filter((window) => window.classification === classification)
        .map((window) => window.episodeId),
    );
  }
}

/**
 * One reconcile period, as *this revision* declares it.
 *
 * Section 3.5's default is "one reconcile period", and section 3.3 puts that
 * period in `policy_detection_latency.reconcile_period_ms` -- per class,
 * explicitly, so that the `T + P <= L` invariant can be a `CHECK` rather than a
 * convention. The seed sets every row to 120 s, which is why a single value
 * exists to return at all; a revision that moved one class to a coarser pass has
 * no single reconcile period, and this function refuses rather than choosing
 * ({@link GraceNotDeclared}).
 *
 * Reading it from the revision the caller resolved is the whole point: interlock
 * `D-0031` exists so that changing a number is a new `policy_revision` and a past
 * report recomputes under the numbers it was judged by. A constant here would be
 * a number no revision records.
 */
export function defaultGraceMs(
  connection: SqliteDatabase,
  options: { readonly revisionId: number },
): number {
  const periods = (
    connection
      .prepare(`
            SELECT DISTINCT reconcile_period_ms
              FROM policy_detection_latency
             WHERE revision_id = ?
             ORDER BY reconcile_period_ms ASC
            `)
      .all(options.revisionId) as { reconcile_period_ms: number }[]
  ).map((row) => Number(row.reconcile_period_ms));

  if (periods.length === 0) {
    throw new GraceNotDeclared(
      `revision ${options.revisionId} decides no detection latency rows, so it ` +
        `declares no reconcile period for grace to default to`,
    );
  }
  if (periods.length > 1) {
    throw new GraceNotDeclared(
      `revision ${options.revisionId} declares ${periods.length} reconcile periods ` +
        `(${periods.join(", ")} ms), so 'one reconcile period' names no single ` +
        `value; declare grace_ms explicitly for this report ` +
        `(measurement-harness.md section 3.5)`,
    );
  }
  return periods[0] as number;
}

/**
 * `L` for this class and subject, in milliseconds.
 *
 * `budget_kind` is why this is a function and not a column read.
 * `lease_orphan`'s `L` is *twice the lease's own TTL* (`0002_policy_seed.sql`:
 * `budget_ms` is the multiple `2`, not a duration), and reading that row as 2 ms
 * would give the class a window shorter than the clock tick that opens it.
 *
 * The subject's unit comes from {@link subjectUnitMs}, which owns the mapping
 * from a relative kind to the table its unit lives in. Calling it is deliberate:
 * a second copy of the `lease` / `watcher_scope` lookup here would agree with
 * policy exactly until the day one of those units changed, and then the
 * tolerance and the budget would be scaled by different numbers for the same
 * subject -- silently, since nothing compares the two scalings.
 */
export function resolveBudgetMs(
  connection: SqliteDatabase,
  options: {
    readonly revisionId: number;
    readonly incidentClass: string;
    readonly subject: string | null;
  },
): number {
  const { revisionId, incidentClass, subject } = options;
  const row = detectionLatency(connection, { revisionId, incidentClass });
  const budgetKind = row.budgetKind;
  const budgetValue = Number(row.budgetMs);
  if (budgetKind === "absolute_ms") {
    return budgetValue;
  }
  if (subject === null) {
    throw new SubjectRequired(
      `${pythonRepr(incidentClass)} has budget_kind=${pythonRepr(budgetKind)}, so L is a ` +
        `multiple (${budgetValue}) of the subject's own TTL or interval; an ` +
        `episode of this class must name its subject`,
    );
  }
  return budgetValue * subjectUnitMs(connection, { thresholdKind: budgetKind, subject });
}

/**
 * `T` in milliseconds, or `null` where `T` is a count.
 *
 * `watcher_error_streak`'s `T` is five consecutive failures, and
 * {@link resolveToleranceMs} refuses to call that a duration (`NotADuration`).
 * That refusal is right and is **not** escalated here: the window of such an
 * episode is still perfectly well defined -- `L` is an absolute 10 minutes -- so
 * refusing the whole window over an unavailable side quantity would make a class
 * unmeasurable for a reason that has nothing to do with measuring it. The count
 * is recorded as `thresholdKind` on the window instead, so a consumer knows the
 * `null` means "a count", not "policy said nothing".
 */
function resolveToleranceOrNull(
  connection: SqliteDatabase,
  options: {
    readonly revisionId: number;
    readonly incidentClass: string;
    readonly subject: string | null;
    readonly thresholdKind: string;
  },
): number | null {
  const { revisionId, incidentClass, subject, thresholdKind } = options;
  if (thresholdKind === "consecutive_count") {
    return null;
  }
  if (thresholdKind !== "absolute_ms" && subject === null) {
    // policy.resolveToleranceMs refuses this too, with PolicyUsageError. It is
    // checked here first so that both relative sides -- T and L -- refuse with
    // the same type for the same missing thing; a caller that had to catch two
    // exception types for one absent subject would eventually catch only the
    // one it had seen.
    throw new SubjectRequired(
      `${pythonRepr(incidentClass)} has threshold_kind=${pythonRepr(thresholdKind)}, so T ` +
        `is a multiple of the subject's own interval or TTL; an episode of this ` +
        `class must name its subject`,
    );
  }
  return resolveToleranceMs(connection, {
    revisionId,
    incidentClass,
    subject: subject ?? undefined,
  });
}

/**
 * Where `[onsetMs, endMs)` sits relative to `[periodStartMs, periodEndMs)`.
 *
 * Wholly inside is {@link IN_PERIOD}, and "wholly" is evaluated in half-open
 * terms at both ends: a window ending *exactly* at `periodEndMs` is inside (its
 * last instant is `periodEndMs - 1`), and an episode onsetting exactly at
 * `periodStartMs` is inside. Getting either boundary wrong moves one episode per
 * report between a bucket and the numerator, which is invisible in aggregate and
 * wrong in every individual case.
 *
 * An episode that is both -- onset before the period and window past its end, a
 * condition that outlived the whole report -- is filed {@link CENSORED_LEFT} so
 * that it lands in exactly one bucket. Left wins because it is the stronger
 * disqualification: a right-censored episode has a trustworthy onset and an
 * unfinished budget, whereas a left-censored one has an onset the report never
 * observed, and a latency measured from an unobserved instant is not a slow
 * measurement but an unfounded one.
 *
 * @throws {EpisodeOutsidePeriod} if the window does not overlap the period.
 * @throws {PeriodRefused} if the period is empty or inverted.
 */
export function classify(options: {
  readonly onsetMs: number;
  readonly endMs: number;
  readonly periodStartMs: number;
  readonly periodEndMs: number;
}): string {
  const { onsetMs, endMs, periodStartMs, periodEndMs } = options;

  if (periodEndMs <= periodStartMs) {
    throw new PeriodRefused(emptyPeriodMessage(periodStartMs, periodEndMs));
  }
  if (onsetMs >= periodEndMs || endMs <= periodStartMs) {
    throw new EpisodeOutsidePeriod(
      `the window [${onsetMs}, ${endMs}) does not overlap the report period ` +
        `[${periodStartMs}, ${periodEndMs}); it is neither in the period nor ` +
        `censored by it`,
    );
  }
  if (onsetMs < periodStartMs) {
    return CENSORED_LEFT;
  }
  if (endMs > periodEndMs) {
    return CENSORED;
  }
  return IN_PERIOD;
}

/**
 * Refuse a grace no window may be computed with.
 *
 * The rule lives here, in one place, because the report declares grace in its
 * section 6 provenance (interlock `D-0040`) while the window model is what the
 * value actually means: two copies of this check could drift, and the drift
 * would show up as a report attesting to a configuration {@link episodeWindow}
 * refuses -- and on a report that classified no episodes, nothing would ever
 * raise, so it would render clean.
 *
 * @throws {WindowRefusal} if `graceMs` is negative.
 */
export function requireGraceMs(graceMs: number): void {
  if (graceMs < 0) {
    throw new WindowRefusal(
      `grace_ms=${graceMs} is negative; grace exists so an episode is not judged ` +
        `a miss for losing a race with the pass that would have caught it, and a ` +
        `negative value shortens the window below the budget the detector is ` +
        `actually held to`,
    );
  }
}

/**
 * The module's replaceable internals (DECISIONS.md `D-0014`).
 *
 * One source case reaches into this module with `monkeypatch.setattr`:
 * `test_render.py::test_the_grace_rule_the_report_enforces_is_the_window_model_s_own`
 * replaces `require_grace_ms` **here** and asserts that the report refuses what
 * the replacement refuses. That is the whole point of the case -- it is bound to
 * the code, so a second copy of the rule inside the report module passes the
 * plain negative-grace case and fails this one -- and it only works because
 * Python resolves the name on this module at call time.
 *
 * ESM bindings cannot be rebound from outside, so the call sites go through this
 * record instead. Every internal call site below goes through it too, which is
 * what Python's late binding actually does: patching the name changes what
 * {@link episodeWindow} and {@link classifyEpisodes} enforce as well, not only
 * what a caller in another module does.
 *
 * Not re-exported from `src/index.ts`: it is a seam for the tests that own these
 * modules, not public API.
 */
export const windowsSeams = {
  /** @see requireGraceMs */
  requireGraceMs,
};

/**
 * One episode's window and classification, under one resolved revision.
 *
 * `revisionId` is the caller's, always: interlock `D-0031`'s corollary is that a
 * `policy_*` read without a revision predicate matches every tolerance ever
 * recorded, and this function resolves none of its own.
 */
export function episodeWindow(
  connection: SqliteDatabase,
  options: {
    readonly revisionId: number;
    readonly episode: Episode;
    readonly graceMs: number;
    readonly periodStartMs: number;
    readonly periodEndMs: number;
  },
): EpisodeWindow {
  const { revisionId, episode, graceMs, periodStartMs, periodEndMs } = options;

  windowsSeams.requireGraceMs(graceMs);

  const policyRow = detectionLatency(connection, {
    revisionId,
    incidentClass: episode.incidentClass,
  });
  const thresholdKind = String(policyRow.thresholdKind);
  const budgetMs = resolveBudgetMs(connection, {
    revisionId,
    incidentClass: episode.incidentClass,
    subject: episode.subject,
  });
  const toleranceMs = resolveToleranceOrNull(connection, {
    revisionId,
    incidentClass: episode.incidentClass,
    subject: episode.subject,
    thresholdKind,
  });

  const endMs = episode.onsetMs + budgetMs + graceMs;
  const classification = classify({
    onsetMs: episode.onsetMs,
    endMs,
    periodStartMs,
    periodEndMs,
  });
  return new EpisodeWindow({
    episodeId: episode.episodeId,
    incidentClass: episode.incidentClass,
    subject: episode.subject,
    onsetMs: episode.onsetMs,
    thresholdKind,
    toleranceMs,
    budgetMs,
    graceMs,
    endMs,
    classification,
  });
}

/**
 * Classify every episode of a report against one period and one grace.
 *
 * `graceMs` left `undefined` takes section 3.5's default -- one reconcile
 * period, read from this revision's own rows by {@link defaultGraceMs}. That is
 * not a silent default: the value used and the fact that it came from the
 * revision are both recorded on the returned {@link WindowReport}, so the
 * classification can be recomputed by a reader who has only the report.
 *
 * `connection` must be the read-only handle from {@link openForMeasurement};
 * every statement issued here is a `SELECT`.
 *
 * @throws {DuplicateEpisodeRefused} if two episodes share an id.
 * @throws {EpisodeOutsidePeriod} if an episode does not touch the period.
 */
export function classifyEpisodes(
  connection: SqliteDatabase,
  options: {
    readonly revisionId: number;
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly episodes: Iterable<Episode>;
    readonly graceMs?: number | undefined;
  },
): WindowReport {
  const { revisionId, periodStartMs, periodEndMs, episodes } = options;

  if (periodEndMs <= periodStartMs) {
    throw new PeriodRefused(emptyPeriodMessage(periodStartMs, periodEndMs));
  }

  let graceMs: number;
  let graceSource: string;
  if (options.graceMs === undefined) {
    graceMs = defaultGraceMs(connection, { revisionId });
    graceSource = GRACE_REVISION_RECONCILE_PERIOD;
  } else {
    graceMs = options.graceMs;
    graceSource = GRACE_DECLARED;
  }
  // D-0108. The check also runs inside episodeWindow, which is where interlock
  // leaves it -- and require_grace_ms's own docstring names the consequence:
  // "on a report that classified no episodes, nothing would ever raise, so it
  // would render clean". A report over zero episodes then carries grace_ms = -1
  // and states it, which is a report declaring a grace nobody could have
  // applied. Called here once, after the grace is resolved, so the declaration
  // is validated whether or not the period held anything; episodeWindow keeps
  // its own call for its own direct callers.
  windowsSeams.requireGraceMs(graceMs);

  const windows: EpisodeWindow[] = [];
  const seen = new Set<string>();
  for (const episode of episodes) {
    if (seen.has(episode.episodeId)) {
      // Two windows under one id are two votes in one numerator, and the
      // duplicate is invisible in the counts -- the totals simply come out one
      // too high. Refusing names the input defect where it happened.
      throw new DuplicateEpisodeRefused(
        `episode_id=${pythonRepr(episode.episodeId)} appears more than once in this ` +
          `report's input; one episode is one condition and would be counted twice`,
      );
    }
    seen.add(episode.episodeId);
    windows.push(
      episodeWindow(connection, {
        revisionId,
        episode,
        graceMs,
        periodStartMs,
        periodEndMs,
      }),
    );
  }

  return new WindowReport({
    periodStartMs,
    periodEndMs,
    revisionId,
    graceMs,
    graceSource,
    windows,
  });
}

// --------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------

/**
 * Said once, because `classify` and `classifyEpisodes` both refuse the same
 * period for the same reason and a reader who saw two wordings would look for
 * two causes.
 */
function emptyPeriodMessage(periodStartMs: number, periodEndMs: number): string {
  return (
    `the report period [${periodStartMs}, ${periodEndMs}) is empty or inverted; ` +
    `a half-open window must have an end strictly after its start ` +
    `(time-base-policy.md section 2, rule 4)`
  );
}
