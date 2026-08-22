/**
 * The one place a policy revision is resolved, and the only place `policy_*` is read.
 *
 * `D-0031`'s corollary is the reason this module exists at all, and it is worth
 * stating before anything else:
 *
 *     **A `policy_*` join without a `revision_id` predicate is a defect.**
 *
 * Policy rows are versioned and never updated in place (`production-schema.md`
 * section 10), so a join that omits the revision matches *every* tolerance ever
 * recorded for the subject. A detector written that way emits one incident per
 * revision in the table and some of those incidents alarm against a tolerance
 * that was retired months ago -- and the failure is invisible while there is
 * only one revision on record, which is exactly the state a fresh database is
 * in. It starts misbehaving on the day someone changes a number, which is the
 * day the tolerances matter most.
 *
 * Making that impossible to get wrong is a structural job rather than a review
 * convention: every reader in the control plane takes its numbers from here,
 * and every function below **requires** a `revision_id` the caller resolved
 * through {@link effectiveRevisionId} (a detector, judging now) or
 * {@link revisionOverPeriod} (a report, judging a past window). No function
 * resolves a revision implicitly as a convenience, because a convenience
 * default is how the predicate goes missing again.
 *
 * **Which revision, and the two callers who need different answers.** A
 * detector binds the revision effective *at* `nowMs`. A report binds the
 * revisions in force *across* its period -- plural, because a period that
 * straddles a policy change was judged under two sets of numbers and averaging
 * across them produces a figure that was never anyone's ceiling. `D-0040`
 * requires the report to say so at the top, so {@link revisionOverPeriod}
 * returns the set and lets a member count above one be the report's own
 * signal.
 *
 * **Windows are half-open, `[start, end)`** (`time-base-policy.md` section 2,
 * rule 4). A revision that takes effect exactly at a period's end belongs to
 * the next period and to exactly one; a closed interval would put it in both
 * and double-count the change.
 *
 * **A relative threshold is not a duration until a subject is named.** Three
 * of the classes in `time-base-policy.md` section 3.2 carry a `threshold_kind`
 * that is not `'absolute_ms'`: `watcher_silence` is a multiple of *that
 * scope's* `expected_interval_ms`, `lease_orphan` a multiple of *that lease's*
 * own TTL, and `watcher_error_streak` a count of consecutive failures with no
 * duration in it at all. {@link resolveToleranceMs} is where the multiple
 * meets its subject; `consecutive_count` is **refused** there rather than
 * coerced, because the only coercion available -- treating 5 as 5
 * milliseconds -- produces a tolerance that every subject crosses instantly.
 *
 * **The budget has the same problem on the other side**, which is why
 * `budget_kind` exists (the adjudication recorded on
 * `policy_detection_latency` in `0001_initial.sql`): `lease_orphan`'s `L` is
 * *twice the lease's own TTL*, which no absolute millisecond value can hold.
 * The DDL's `T + P <= L` `CHECK` therefore fires only when both sides are
 * absolute, and {@link budgetViolations} is the per-subject pass that asserts
 * the identical inequality for every case a `CHECK` cannot reach across tables
 * to see. A watcher scope registered with an `expected_interval_ms` so large
 * that three missed polls exceed the `watcher_silence` budget is a
 * misconfiguration; without this pass it presents as a detector quietly slower
 * than its own stated ceiling, for that one scope, with nothing anywhere
 * saying so.
 *
 * **Nothing here writes.** Every function is a `SELECT`, so no transaction
 * helper appears in this module: a policy change is a new revision inserted by
 * a migration step, never an `UPDATE` issued by a reader. Timestamps are
 * integer epoch milliseconds supplied by the caller -- no function consults a
 * clock, and no column consulted here has a `DEFAULT`.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

/**
 * The vocabulary of `policy_detection_latency.threshold_kind`, mirroring the
 * DDL's `CHECK`. Held here so a caller can branch on the kind exhaustively
 * without re-deriving the list from the schema; the schema remains the
 * authority and {@link detectionLatency} refuses anything outside it.
 *
 * A `ReadonlySet`, not a readonly tuple: every use in this module and in the
 * ported tests is a membership check (`THRESHOLD_KINDS.has(kind)`), which is
 * the natural operation on a Python `frozenset` and the one a `Set` states
 * directly rather than through `includes`.
 *
 * Immutability here is **type-level only**, and deliberately so: `Object.freeze`
 * on a `Set` blocks property writes but not `.add()`, which is the only mutation
 * that matters, so freezing would advertise a guarantee it does not deliver.
 * Python's `frozenset` is genuinely immutable; that difference is not reachable
 * from any ported case, and the honest note is cheaper than a wrapper class.
 */
export const THRESHOLD_KINDS: ReadonlySet<string> = new Set([
  "absolute_ms",
  "scope_interval_multiple",
  "lease_ttl_multiple",
  "consecutive_count",
]);

/**
 * The vocabulary of `policy_detection_latency.budget_kind`. Shorter than
 * {@link THRESHOLD_KINDS} because only one class has a relative budget, and
 * the DDL's `CHECK` says which two members are legal.
 */
export const BUDGET_KINDS: ReadonlySet<string> = new Set(["absolute_ms", "lease_ttl_multiple"]);

/**
 * The threshold kinds whose `T` is a duration only once a subject is named.
 * `consecutive_count` is deliberately absent: it is not a duration for *any*
 * subject.
 */
const RELATIVE_THRESHOLD_KINDS: ReadonlySet<string> = new Set([
  "scope_interval_multiple",
  "lease_ttl_multiple",
]);

/**
 * Which table a relative kind draws its subject from. The mapping is what
 * makes "live subject" a decidable question in {@link budgetViolations}.
 */
const SUBJECT_KIND_OF: Readonly<Record<string, string>> = Object.freeze({
  scope_interval_multiple: "watcher_scope",
  lease_ttl_multiple: "lease",
});

/**
 * The one place "which revision is effective at an instant" is written.
 *
 * `policy_revision` may hold two rows sharing an `effective_at_ms` (a
 * correction filed in the same pass as the row it corrects), and
 * `AUTOINCREMENT` makes the higher `revision_id` the later decision. So at any
 * given instant exactly one revision is in force: the highest `revision_id`
 * among the rows at that instant. This `SELECT` collapses the table to that
 * one row per instant, and both {@link effectiveRevisionId} and
 * {@link revisionOverPeriod} read *it* rather than each re-deriving the
 * tie-break in their own `ORDER BY`.
 *
 * What breaks if the two drift: they answered the same question two ways, and
 * they did drift -- `revision_over_period` ordered by `effective_at_ms,
 * revision_id` and returned *both* rows of a tie, while
 * {@link effectiveRevisionId} returned only the higher. The superseded row,
 * never in force at any instant, then appeared in the period set, which made a
 * report announce a NON-HOMOGENEOUS period (`measurement-harness.md` section
 * 6, `D-0040`) across a policy change that never happened, and let
 * `build_header` accept that superseded revision as having been in force. A
 * banner that fires on a non-event is a banner readers learn to ignore, and it
 * is the signal that the latency figures cannot be trusted.
 */
const EFFECTIVE_REVISION_AT_INSTANT = `
        SELECT effective_at_ms, MAX(revision_id) AS revision_id
          FROM policy_revision
         GROUP BY effective_at_ms
`;

/** A policy read that cannot be answered, stated rather than guessed at. */
export class PolicyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyRefusal";
    Object.setPrototypeOf(this, PolicyRefusal.prototype);
  }
}

/**
 * No `policy_revision` is effective at the instant asked about.
 *
 * Distinct from an empty result: a detector that silently skipped its pass
 * because policy had not been seeded would look exactly like a detector that
 * found nothing wrong.
 */
export class NoEffectiveRevision extends PolicyRefusal {
  constructor(message: string) {
    super(message);
    this.name = "NoEffectiveRevision";
    Object.setPrototypeOf(this, NoEffectiveRevision.prototype);
  }
}

/**
 * The revision exists but says nothing about this class, gate type or stage.
 *
 * An absent row is not the same fact as a `NULL` tolerance. `NULL` is the
 * seeded, deliberate "this stage is never a relay gap"; an absent row means
 * the revision was never asked to decide, and returning `null` for both would
 * let an unseeded gate type inherit the human stage's exemption.
 */
export class PolicyRowMissing extends PolicyRefusal {
  constructor(message: string) {
    super(message);
    this.name = "PolicyRowMissing";
    Object.setPrototypeOf(this, PolicyRowMissing.prototype);
  }
}

/**
 * `T` is a count, and no subject turns it into milliseconds.
 *
 * `watcher_error_streak`'s threshold is five *consecutive failures*. The one
 * coercion available -- reading 5 as 5 ms -- yields a tolerance every subject
 * crosses on its first poll, so the refusal is the only honest answer.
 */
export class NotADuration extends PolicyRefusal {
  constructor(message: string) {
    super(message);
    this.name = "NotADuration";
    Object.setPrototypeOf(this, NotADuration.prototype);
  }
}

/**
 * The caller asked in a way the policy row cannot be applied to.
 *
 * Deliberately **outside** the {@link PolicyRefusal} hierarchy, mirroring
 * Python's `PolicyUsageError(ValueError)`: it is a caller error, not a policy
 * fact stated about the data. Code that does `catch (e) { if (e instanceof
 * PolicyRefusal) ... }` to handle "the data says no" must not also catch "you
 * called this wrong".
 */
export class PolicyUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyUsageError";
    Object.setPrototypeOf(this, PolicyUsageError.prototype);
  }
}

/** One `policy_detection_latency` row, with its two kinds validated. */
export interface DetectionLatencyPolicy {
  readonly revisionId: number;
  readonly incidentClass: string;
  readonly thresholdKind: string;
  readonly thresholdValue: number;
  readonly reconcilePeriodMs: number;
  readonly budgetMs: number;
  readonly budgetKind: string;
}

/** Who holds the ball at a gate stage, and who answers for the gate type. */
export interface GateStageOwner {
  readonly revisionId: number;
  readonly gateType: string;
  readonly stage: string;
  readonly ballHolder: string;
  readonly standingOwner: string;
}

/** One live subject whose own numbers break `T + P <= L`. */
export interface BudgetViolation {
  readonly revisionId: number;
  readonly incidentClass: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly toleranceMs: number;
  readonly reconcilePeriodMs: number;
  readonly budgetMs: number;
  readonly excessMs: number;
}

/**
 * The revision in force at `nowMs` -- what a detector binds.
 *
 * Two revisions may legitimately share an instant (a correction inserted in
 * the same pass as the row it corrects), and the higher `revision_id` is the
 * later decision. Without that tie-break SQLite is free to return either, and
 * a detector would silently alternate between two sets of numbers across
 * restarts. The tie-break is not written here: it lives once in
 * {@link EFFECTIVE_REVISION_AT_INSTANT}, which this query selects from, so
 * that {@link revisionOverPeriod} cannot answer the same question a second
 * way.
 */
export function effectiveRevisionId(
  connection: SqliteDatabase,
  options: { readonly nowMs: number },
): number {
  const { nowMs } = options;
  const row = connection
    .prepare<[number], { revision_id: number }>(
      `
        SELECT revision_id FROM (${EFFECTIVE_REVISION_AT_INSTANT})
         WHERE effective_at_ms <= ?
         ORDER BY effective_at_ms DESC
         LIMIT 1
        `,
    )
    .get(nowMs);
  if (row === undefined) {
    throw new NoEffectiveRevision(
      `no policy_revision is effective at nowMs=${nowMs}; ` +
        "the time base has not been seeded for this instant",
    );
  }
  return Number(row.revision_id);
}

/**
 * Every revision in force across the half-open period, oldest first.
 *
 * Two disjoint sources, and both are needed. The revision already in force
 * when the period opened is found by the same "latest at or before" rule as
 * {@link effectiveRevisionId} -- it governs the period's first millisecond
 * even though it took effect long before. Every revision that took effect
 * *inside* `[start, end)` then joins it.
 *
 * Both halves select from {@link EFFECTIVE_REVISION_AT_INSTANT} rather than
 * from `policy_revision` directly, so a revision superseded at its own
 * instant is absent from *both* -- it was never in force for a millisecond,
 * and a member of this set is a revision that governed some part of the
 * period.
 *
 * A revision whose `effective_at_ms` equals `periodEndMs` is excluded: the
 * window is half-open, so that instant belongs to the next period, and to
 * exactly one (`time-base-policy.md` section 2, rule 4). A report that
 * included it would attribute latencies to numbers that were not yet in force
 * when they were measured.
 *
 * More than one member means the period is **non-homogeneous** (`D-0040`):
 * the report must say so at the top rather than averaging a figure across a
 * tolerance change. Returning the set rather than a single value is what
 * makes that statable at all.
 */
export function revisionOverPeriod(
  connection: SqliteDatabase,
  options: { readonly periodStartMs: number; readonly periodEndMs: number },
): readonly number[] {
  const { periodStartMs, periodEndMs } = options;
  if (periodEndMs < periodStartMs) {
    throw new PolicyUsageError(
      `periodEndMs (${periodEndMs}) precedes periodStartMs (${periodStartMs})`,
    );
  }

  const revisions: number[] = [];
  const opening = connection
    .prepare<[number], { revision_id: number }>(
      `
        SELECT revision_id FROM (${EFFECTIVE_REVISION_AT_INSTANT})
         WHERE effective_at_ms <= ?
         ORDER BY effective_at_ms DESC
         LIMIT 1
        `,
    )
    .get(periodStartMs);
  if (opening !== undefined) {
    revisions.push(Number(opening.revision_id));
  }

  const rows = connection
    .prepare<[number, number], { revision_id: number }>(
      `
        SELECT revision_id FROM (${EFFECTIVE_REVISION_AT_INSTANT})
         WHERE effective_at_ms > ? AND effective_at_ms < ?
         ORDER BY effective_at_ms ASC
        `,
    )
    .all(periodStartMs, periodEndMs);
  for (const row of rows) {
    revisions.push(Number(row.revision_id));
  }

  // Python returns a real `tuple`, so the caller cannot append to the reader's
  // result. `Object.freeze` is the equivalent that actually holds at runtime;
  // a `readonly T[]` type alone is erased at compile time and one cast defeats.
  return Object.freeze(revisions);
}

/**
 * The whole `T` / `P` / `L` row for one incident class under one revision.
 *
 * Returned as one object rather than three accessors because the three
 * numbers are only meaningful together: `thresholdValue` without
 * `thresholdKind` is an integer of unknown unit, and `budgetMs` without
 * `budgetKind` is the `lease_orphan` row read as 2 milliseconds.
 */
export function detectionLatency(
  connection: SqliteDatabase,
  options: { readonly revisionId: number; readonly incidentClass: string },
): DetectionLatencyPolicy {
  const { revisionId, incidentClass } = options;
  const row = connection
    .prepare<
      [number, string],
      {
        revision_id: number;
        incident_class: string;
        threshold_kind: string;
        threshold_value: number;
        reconcile_period_ms: number;
        budget_ms: number;
        budget_kind: string;
      }
    >(
      `
        SELECT revision_id, incident_class, threshold_kind, threshold_value,
               reconcile_period_ms, budget_ms, budget_kind
          FROM policy_detection_latency
         WHERE revision_id = ? AND incident_class = ?
        `,
    )
    .get(revisionId, incidentClass);
  if (row === undefined) {
    throw new PolicyRowMissing(
      `revision ${revisionId} decides no detection latency for ` +
        `incident_class='${incidentClass}'`,
    );
  }
  return detectionLatencyPolicyFromRow(row);
}

/**
 * This stage's relay-gap tolerance, or `null` for "never a gap".
 *
 * `null` is the seeded value of the `presented` stage and carries
 * `time-base-policy.md` section 4's claim that a slow human is not a gap. It
 * is data precisely so the detector query has no `stage = 'presented'`
 * special case, which is where a future gate type would be handed a human
 * exemption by accident.
 *
 * An absent row raises {@link PolicyRowMissing} instead, because the two
 * facts differ: `forwarded` has no row because it is terminal, and a gate
 * type this revision never decided has no row because nobody decided it.
 * Collapsing both into `null` would make an undecided gate type silently
 * unpoliced.
 */
export function gateStageTolerance(
  connection: SqliteDatabase,
  options: { readonly revisionId: number; readonly gateType: string; readonly stage: string },
): number | null {
  const { revisionId, gateType, stage } = options;
  const row = connection
    .prepare<[number, string, string], { tolerance_ms: number | null }>(
      `
        SELECT tolerance_ms FROM policy_gate_stage_tolerance
         WHERE revision_id = ? AND gate_type = ? AND stage = ?
        `,
    )
    .get(revisionId, gateType, stage);
  if (row === undefined) {
    throw new PolicyRowMissing(
      `revision ${revisionId} decides no stage tolerance for ` +
        `gate_type='${gateType}' stage='${stage}'`,
    );
  }
  return row.tolerance_ms === null ? null : Number(row.tolerance_ms);
}

/**
 * Who holds the ball at this stage, and who answers for the gate type.
 *
 * `D-0032` keeps both out of the `gate` row: one column cannot mean two
 * things, and an owner stored on the row *drifts* -- the gate advances, the
 * column does not, and the `relay_gap` incident then names a role that has
 * not held the ball for an hour. Deriving both from `(gate_type, stage)` in
 * versioned policy makes that drift unrepresentable and lets a report say who
 * the owner *was* by binding the revision that was effective then.
 */
export function gateStageOwner(
  connection: SqliteDatabase,
  options: { readonly revisionId: number; readonly gateType: string; readonly stage: string },
): GateStageOwner {
  const { revisionId, gateType, stage } = options;
  const row = connection
    .prepare<[number, string, string], { ball_holder: string; standing_owner: string }>(
      `
        SELECT ball_holder, standing_owner FROM policy_gate_stage_owner
         WHERE revision_id = ? AND gate_type = ? AND stage = ?
        `,
    )
    .get(revisionId, gateType, stage);
  if (row === undefined) {
    throw new PolicyRowMissing(
      `revision ${revisionId} decides no owner for gate_type='${gateType}' stage='${stage}'`,
    );
  }
  return Object.freeze({
    revisionId,
    gateType,
    stage,
    ballHolder: String(row.ball_holder),
    standingOwner: String(row.standing_owner),
  });
}

/**
 * `T` for this subject, in milliseconds.
 *
 * `subject` is the identity the multiple applies to, and which identity that
 * is follows from `thresholdKind`: a `watcher_scope.scope_id` for
 * `scope_interval_multiple`, a `lease.resource` for `lease_ttl_multiple`. It
 * is ignored for `absolute_ms`, where the row already *is* the answer and no
 * subject can change it -- a caller iterating classes uniformly may pass one
 * and get the same number back.
 *
 * `consecutive_count` raises {@link NotADuration}. It is the one kind no
 * subject rescues, and refusing it here is what keeps the coercion from
 * happening silently three call sites away.
 *
 * A relative kind with `subject === undefined` raises
 * {@link PolicyUsageError} rather than falling back to the bare multiple: the
 * bare multiple is a small integer of milliseconds, so the fallback would
 * produce a tolerance of three milliseconds for a scope whose real tolerance
 * is nine minutes.
 */
export function resolveToleranceMs(
  connection: SqliteDatabase,
  options: {
    readonly revisionId: number;
    readonly incidentClass: string;
    readonly subject: string | undefined;
  },
): number {
  const { revisionId, incidentClass, subject } = options;
  const row = detectionLatency(connection, { revisionId, incidentClass });
  const kind = row.thresholdKind;
  const value = row.thresholdValue;

  if (kind === "absolute_ms") {
    return value;
  }
  if (kind === "consecutive_count") {
    throw new NotADuration(
      `'${incidentClass}' has threshold_kind='consecutive_count' ` +
        `(T = ${value} consecutive failures); it is a count, not a duration`,
    );
  }
  if (subject === undefined) {
    throw new PolicyUsageError(
      `'${incidentClass}' has threshold_kind='${kind}', which is a multiple ` +
        "of the subject's own interval or TTL; a subject is required",
    );
  }
  return value * subjectUnitMs(connection, { thresholdKind: kind, subject });
}

/**
 * The duration one unit of a relative multiple stands for, for this subject.
 *
 * A *subject unit* is the number a relative policy value is multiplied by,
 * and which number that is follows from the kind:
 *
 * - `lease_ttl_multiple` -- **that lease's own TTL**, i.e.
 *   `expires_at_ms - acquired_at_ms` for the `lease` row named by `subject`
 *   (its `resource`). `lease_orphan`'s `T` and `L` are both multiples of it
 *   (`time-base-policy.md` section 3.2).
 * - `scope_interval_multiple` -- **that scope's** `expected_interval_ms`, for
 *   the `watcher_scope` row named by `subject` (its `scope_id`).
 *
 * **This is public, and it is one function, because both sides of the budget
 * inequality need it.** {@link resolveToleranceMs} scales `T` here, and the
 * measurement harness's own budget resolver scales `L` here. `D-0041`
 * narrowed the DDL's `T + P <= L` `CHECK` to the rows where both sides are
 * absolute, on the explicit promise that relative rows are asserted per
 * subject at reconcile time ({@link budgetViolations}) -- so the two sides
 * are compared to each other, and comparing them is only meaningful while
 * they were scaled by the *same* number.
 *
 * A second copy of these two queries on the `L` side would agree with this
 * one exactly until the day a unit changed -- a lease re-acquired with a
 * different TTL, a scope re-registered with a different interval, a column
 * renamed in a migration -- and from that day `T` and `L` would be scaled by
 * different numbers for the same subject. Nothing raises when that happens:
 * the pass still runs and still reports, but `T + P <= L` is then an
 * inequality between two different units. Which way it lies is whichever way
 * the drift went -- a budget silently too generous hides a detector that is
 * late, a budget silently too tight alarms on scopes that are fine -- so
 * there is one function, and callers outside this module call this name.
 */
export function subjectUnitMs(
  connection: SqliteDatabase,
  options: { readonly thresholdKind: string; readonly subject: string },
): number {
  const { thresholdKind, subject } = options;

  if (thresholdKind === "scope_interval_multiple") {
    const row = connection
      .prepare<[string], { expected_interval_ms: number }>(
        "SELECT expected_interval_ms FROM watcher_scope WHERE scope_id = ?",
      )
      .get(subject);
    if (row === undefined) {
      throw new PolicyUsageError(`no watcher_scope with scope_id='${subject}'`);
    }
    return Number(row.expected_interval_ms);
  }

  if (thresholdKind === "lease_ttl_multiple") {
    // Read POSITIONALLY, as the source does (`int(row[0])`). The column is an
    // expression with no `AS`, and SQLite documents the name of such a result
    // column as undefined -- it may differ between builds, and `PRAGMA
    // full_column_names` changes it outright. Addressing it by its stringified
    // SQL text would therefore be a name dependency the source does not have,
    // and the failure would be silent: a missed key reads as `undefined`,
    // `Number(undefined)` is `NaN`, and `NaN <= budget` is false, so every live
    // lease would be reported as a budget violation. The SQL itself stays
    // byte-identical to policy.py -- adding an alias would not.
    const ttlMs = connection
      .prepare<[string]>("SELECT expires_at_ms - acquired_at_ms FROM lease WHERE resource = ?")
      .pluck()
      .get(subject);
    if (ttlMs === undefined) {
      throw new PolicyUsageError(`no lease with resource='${subject}'`);
    }
    return Number(ttlMs);
  }

  throw new PolicyRefusal(`'${thresholdKind}' names no subject unit`);
}

/**
 * Every live subject whose own numbers break `T + P <= L`.
 *
 * Section 10's `policy_budget_violation` pass. The DDL asserts `T + P <= L`
 * for the rows where both sides are absolute; it cannot assert it for the
 * rest, because `T` or `L` is a multiple of something in *another table* and
 * a `CHECK` sees only its own row. This function is that missing half, run
 * per subject at reconcile time against the same inequality -- not a similar
 * one.
 *
 * The worked case from `time-base-policy.md` section 3.3: with
 * `watcher_silence`'s `L` at 10 min, `P` at 120 s and `T` at three of the
 * scope's own polls, a scope may poll no slower than
 * `(600000 - 120000) / 3 = 160000` ms. A scope registered slower than that is
 * served by a detector that cannot possibly meet its stated ceiling for it,
 * and the whole point of naming the misconfiguration is that the alternative
 * is a ceiling quietly violated for one scope while every report says the
 * ceiling holds.
 *
 * "Live" is per subject kind: an enabled, unretired `watcher_scope`, and a
 * `lease` that has not expired as of `nowMs`. A retired scope has no watcher
 * to be slow, and an expired lease has no orphan window left to size.
 *
 * `consecutive_count` rows are skipped, not refused: their `T` is not a
 * duration for any subject ({@link NotADuration}), so there is no inequality
 * to evaluate, and raising would stop a whole reconcile pass over a row that
 * is correctly configured.
 */
export function budgetViolations(
  connection: SqliteDatabase,
  options: { readonly revisionId: number; readonly nowMs: number },
): readonly BudgetViolation[] {
  const { revisionId, nowMs } = options;
  const violations: BudgetViolation[] = [];
  const rows = connection
    .prepare<
      [number],
      {
        revision_id: number;
        incident_class: string;
        threshold_kind: string;
        threshold_value: number;
        reconcile_period_ms: number;
        budget_ms: number;
        budget_kind: string;
      }
    >(
      `
        SELECT revision_id, incident_class, threshold_kind, threshold_value,
               reconcile_period_ms, budget_ms, budget_kind
          FROM policy_detection_latency
         WHERE revision_id = ?
           AND (threshold_kind <> 'absolute_ms' OR budget_kind <> 'absolute_ms')
         ORDER BY incident_class ASC
        `,
    )
    .all(revisionId);

  for (const row of rows) {
    const policy = detectionLatencyPolicyFromRow(row);
    if (policy.thresholdKind === "consecutive_count") {
      continue;
    }
    violations.push(...violationsForClass(connection, { policy, nowMs }));
  }
  return Object.freeze(violations);
}

// --------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------

/**
 * One `policy_detection_latency` row, with its two kinds validated.
 *
 * The kinds are re-checked against {@link THRESHOLD_KINDS} / {@link
 * BUDGET_KINDS} even though the DDL constrains them, because this module is
 * also read against databases migrated by an older head, and a kind this code
 * has no branch for would otherwise fall through to whichever `if` happened
 * to be last.
 */
function detectionLatencyPolicyFromRow(row: {
  readonly revision_id: number;
  readonly incident_class: string;
  readonly threshold_kind: string;
  readonly threshold_value: number;
  readonly reconcile_period_ms: number;
  readonly budget_ms: number;
  readonly budget_kind: string;
}): DetectionLatencyPolicy {
  const thresholdKind = String(row.threshold_kind);
  const budgetKind = String(row.budget_kind);
  if (!THRESHOLD_KINDS.has(thresholdKind)) {
    throw new PolicyRefusal(
      `unknown threshold_kind '${thresholdKind}' on incident_class='${row.incident_class}'`,
    );
  }
  if (!BUDGET_KINDS.has(budgetKind)) {
    throw new PolicyRefusal(
      `unknown budget_kind '${budgetKind}' on incident_class='${row.incident_class}'`,
    );
  }
  return Object.freeze({
    revisionId: Number(row.revision_id),
    incidentClass: String(row.incident_class),
    thresholdKind,
    thresholdValue: Number(row.threshold_value),
    reconcilePeriodMs: Number(row.reconcile_period_ms),
    budgetMs: Number(row.budget_ms),
    budgetKind,
  });
}

/** `T + P <= L` for every live subject of one relative class. */
function violationsForClass(
  connection: SqliteDatabase,
  options: { readonly policy: DetectionLatencyPolicy; readonly nowMs: number },
): readonly BudgetViolation[] {
  const { policy, nowMs } = options;
  const thresholdKind = policy.thresholdKind;
  const budgetKind = policy.budgetKind;

  const relativeSides = [thresholdKind, budgetKind].filter((kind) =>
    RELATIVE_THRESHOLD_KINDS.has(kind),
  );
  const uniqueRelativeSides = Array.from(new Set(relativeSides));
  if (uniqueRelativeSides.length !== 1) {
    // Both sides relative to different subjects has no evaluable meaning: T
    // would be scaled by a scope's poll interval and L by some lease's TTL,
    // with nothing tying the two subjects together. It is a defective policy
    // row rather than a violated budget, so it is refused rather than
    // reported as one subject's misconfiguration.
    throw new PolicyRefusal(
      `'${policy.incidentClass}' mixes threshold_kind='${thresholdKind}' ` +
        `with budget_kind='${budgetKind}'; the two name different subjects`,
    );
  }
  const [relativeKind] = uniqueRelativeSides as [string];
  // Python subscripts the mapping (`_SUBJECT_KIND_OF[relative_kind]`), so a
  // relative kind the mapping has no entry for is a hard `KeyError` at this
  // line. An `as string` cast here would hand `undefined` on to `liveSubjects`,
  // which reports it two frames later as a refusal about
  // `subjectKind='undefined'` -- a defective build presented as a policy fact.
  // Unreachable while the two constants agree, which is exactly why the miss
  // has to fail loudly rather than be asserted away.
  const subjectKind = SUBJECT_KIND_OF[relativeKind];
  if (subjectKind === undefined) {
    throw new PolicyRefusal(
      `'${relativeKind}' is a relative threshold kind with no subject kind mapped to it`,
    );
  }

  const periodMs = policy.reconcilePeriodMs;
  const violations: BudgetViolation[] = [];
  for (const [subject, unitMs] of liveSubjects(connection, { subjectKind, nowMs })) {
    const toleranceMs =
      thresholdKind === relativeKind ? policy.thresholdValue * unitMs : policy.thresholdValue;
    const budgetMs = budgetKind === relativeKind ? policy.budgetMs * unitMs : policy.budgetMs;
    if (toleranceMs + periodMs <= budgetMs) {
      continue;
    }
    violations.push(
      Object.freeze({
        revisionId: policy.revisionId,
        incidentClass: policy.incidentClass,
        subjectKind,
        subjectId: subject,
        toleranceMs,
        reconcilePeriodMs: periodMs,
        budgetMs,
        excessMs: toleranceMs + periodMs - budgetMs,
      }),
    );
  }
  return Object.freeze(violations);
}

/**
 * Each live subject of a kind, paired with the duration its multiple scales.
 *
 * Liveness is the subject's own notion and neither definition is a filter of
 * convenience. A retired or disabled `watcher_scope` has no watcher obliged to
 * poll it, so its interval cannot make a detector late. A lease whose
 * `expires_at_ms` has passed has no orphan window left to be sized against;
 * the next acquisition raises the epoch and brings its own TTL.
 */
function liveSubjects(
  connection: SqliteDatabase,
  options: { readonly subjectKind: string; readonly nowMs: number },
): readonly (readonly [string, number])[] {
  const { subjectKind, nowMs } = options;

  if (subjectKind === "watcher_scope") {
    const rows = connection
      .prepare<[], { scope_id: string; expected_interval_ms: number }>(
        `
            SELECT scope_id, expected_interval_ms FROM watcher_scope
             WHERE enabled = 1 AND retired_at_ms IS NULL
             ORDER BY scope_id ASC
            `,
      )
      .all();
    return rows.map((row) => [String(row.scope_id), Number(row.expected_interval_ms)] as const);
  }

  if (subjectKind === "lease") {
    // Positional, for the same reason as in `subjectUnitMs` above: the TTL is
    // an unaliased expression column, and the source reads it as `row[1]`.
    const rows = connection
      .prepare<[number]>(
        `
            SELECT resource, expires_at_ms - acquired_at_ms FROM lease
             WHERE expires_at_ms > ?
             ORDER BY resource ASC
            `,
      )
      .raw()
      .all(nowMs) as unknown[][];
    return rows.map((row) => [String(row[0]), Number(row[1])] as const);
  }

  throw new PolicyRefusal(`no live-subject query for subjectKind='${subjectKind}'`);
}
