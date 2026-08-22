import type { Database as SqliteDatabase } from "better-sqlite3";

import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import { formatFixed } from "./format.js";

/**
 * G6 -- false termination, counted at the applied effect and nowhere else.
 *
 * The failure this module is written against is a precision figure computed
 * over the wrong rows, and `docs/measurement-harness.md` section 3.4 records
 * the two ways of getting it wrong. Both are tempting, both produce a number,
 * and neither number means what its heading says.
 *
 * **1. Counting recommendations.** Interlock `D-0004` and AC-6 mean the
 * Dispatcher AI cannot terminate anything: it may *recommend*, and a human or
 * the Secretary applies. v1 had no such gate -- its terminations were
 * executions. So a false-termination rate computed over Interlock's
 * recommendations compares our **suggestions** against v1's **actions**, and
 * every suggestion a human correctly declined is charged to us as a false
 * termination that never happened to anyone. The gate that makes Interlock
 * safer would show up as evidence that it is worse.
 *
 * **2. Counting a capability we do not have.** The mirror error is to look for
 * Interlock's own executions of a terminate -- of which there are structurally
 * zero, because `time-base-policy.md` section 4's auto-stop row says Core may
 * name a stall *candidate* and may not conclude one, and the applied `action`
 * row is written by the third layer. A harness reading only rows the core wrote
 * would report 0/0 and present a definitional impossibility as a perfect score.
 *
 * So the definition is taken verbatim and not loosened:
 *
 * > A false termination is an `action` row with `kind='terminate_session'` and
 * > `status='applied'` whose subject was not, in fact, stuck.
 *
 * The applied effect is the unit because it is the only thing both systems did
 * the same kind of. A watcher candidate is not one; an AI recommendation is not
 * one.
 *
 * **"Not in fact stuck" has a preference order, and it is data.** Section 3.4
 * gives it: the fixture label, then the subject's own subsequent evidence, then
 * human adjudication. {@link GROUND_TRUTH_PREFERENCE} is that order as an array
 * and {@link adjudicate} **iterates it**, rather than expressing it as three
 * `if` statements whose order is a fact about the file's layout. The difference
 * matters when the sources disagree, which they will: a fixture label is a
 * statement about a constructed case and the strongest thing available;
 * subsequent evidence is an inference over rows a bug may have written; a human
 * adjudication is the last resort precisely because it does not scale and is
 * not reproducible. When a lower-preference source disagrees with the winner the
 * disagreement is **recorded** ({@link Adjudication.overruled}) rather than
 * discarded -- a fixture label contradicted by the subject's own behaviour is
 * either a mislabelled fixture or a detector writing evidence it should not, and
 * both are findings.
 *
 * **Undetermined is an outcome, not a gap.** Where none of the three settles it,
 * the episode is `undetermined` and gets its own bucket -- interlock `D-0006`'s
 * "cannot determine is a legitimate outcome", applied to the measurement rather
 * than to the detection. It is never folded into either the numerator (which
 * would invent false terminations) or the denominator's justified half (which
 * would hide them), and {@link FalseTerminationReport.rateUpper} exists so a
 * reader can see how much of the rate the undetermined rows could move.
 *
 * **Absence of activity is never evidence of a stall.** The subsequent-evidence
 * source can return "not stuck" and can return "no opinion". It can never
 * return "stuck": a session that produced nothing after being terminated
 * produced nothing *because it was terminated*, and reading that silence as
 * confirmation would make every termination self-justifying. See
 * {@link subsequentActivityVerdicts}.
 *
 * **Three supporting series, because the headline hides where precision lives.**
 * `recommended_terminate`, `recommended_but_not_applied` and
 * `applied_terminate` are all reported. A rising `recommended_but_not_applied`
 * is *informative rather than alarming* -- it is the visible value of the human
 * gate, and the report says so in those words so that nobody optimises it
 * downward.
 *
 * **Read-only, and the clock is the caller's.** The connection is the handle
 * from {@link openForMeasurement}; every statement issued here is a `SELECT`,
 * and they are declared as text in {@link QUERY_DEFINITIONS} for the report
 * provenance header (interlock `D-0040`). Nothing here raises an incident or
 * applies a remedy: this is a detector, and the reconcile driver that would act
 * on it is out of scope for this branch.
 */

/**
 * The `action.kind` a termination is recorded under.
 *
 * **`action.kind` is unconstrained in the DDL** -- `0001_initial.sql` checks
 * only `length(kind) > 0`, deliberately, so that a new effect does not need a
 * migration. The consequence for a *report* is that the literal is not
 * discoverable from the schema: nothing in the database says which spelling
 * means "terminate a session", so a harness that inlined the string would
 * silently measure zero the day a writer used another one. It is therefore
 * declared here, exported, and carried in {@link QUERY_DEFINITIONS} as part of
 * the report's own query definitions, which is where a reader checks what the
 * number was actually over.
 */
export const TERMINATE_SESSION_KIND = "terminate_session";

/**
 * `action.status`, as that table's own `CHECK` enumerates it. Named here so the
 * buckets, the queries and the tests cannot disagree about spelling.
 */
export const STATUS_PENDING = "pending";
export const STATUS_APPLIED = "applied";
export const STATUS_REFUSED = "refused";

/**
 * The ground-truth sources of section 3.4, **in the order of preference the
 * section states**. {@link adjudicate} iterates this array; reordering it
 * reorders the preference, which is the property that makes the order data
 * rather than an accident of where the `if` statements landed.
 */
export const SOURCE_FIXTURE_LABEL = "fixture_label";
export const SOURCE_SUBSEQUENT_EVIDENCE = "subsequent_evidence";
export const SOURCE_HUMAN_ADJUDICATION = "human_adjudication";

export const GROUND_TRUTH_PREFERENCE: readonly string[] = Object.freeze([
  SOURCE_FIXTURE_LABEL,
  SOURCE_SUBSEQUENT_EVIDENCE,
  SOURCE_HUMAN_ADJUDICATION,
]);

/** The source of an `undetermined` verdict: none of the three settled it. */
export const SOURCE_NONE = "none";

/**
 * What a source may say. {@link VERDICT_NOT_STUCK} is the false-termination
 * numerator; {@link VERDICT_STUCK} is a termination that did its job.
 */
export const VERDICT_STUCK = "stuck";
export const VERDICT_NOT_STUCK = "not_stuck";
/** Not a thing a source may say -- the outcome when none of them said anything. */
export const VERDICT_UNDETERMINED = "undetermined";

/**
 * The queries this report is over, as text, for the provenance header
 * (interlock `D-0040`: "every query the report ran, as text ... The queries are
 * data"). These constants are the text that is **executed**, not a
 * transcription of it: a second copy would be right on the day it was written
 * and would go on being printed after the executed query changed, which is a
 * provenance header that certifies the wrong thing.
 */
export const TERMINATE_ACTIONS_QUERY = `
SELECT a.action_id, a.run_id, a.incident_id, i.session_id, a.status,
       a.created_at_ms, a.applied_at_ms
  FROM action AS a
  LEFT JOIN incident AS i ON i.incident_id = a.incident_id
 WHERE a.kind = :terminate_session_kind
   AND ((a.created_at_ms >= :period_start_ms
         AND a.created_at_ms < :period_end_ms)
        OR (a.applied_at_ms IS NOT NULL
            AND a.applied_at_ms >= :period_start_ms
            AND a.applied_at_ms < :period_end_ms))
 ORDER BY a.action_id
`;

/**
 * `{event_types}` expands to one `?` per declared productive event type.
 *
 * SQLite has no parameter form for an `IN` list, so the placeholders are
 * generated and the values are still bound -- the event types never reach the
 * statement as text.
 */
export const SUBSEQUENT_ACTIVITY_QUERY = `
SELECT 1
  FROM event
 WHERE subject_kind = ?
   AND subject_id = ?
   AND event_type IN ({event_types})
   AND ingested_at_ms > ?
   AND ingested_at_ms < ?
 LIMIT 1
`;

export const QUERY_DEFINITIONS: ReadonlyMap<string, string> = new Map([
  ["terminate_actions", TERMINATE_ACTIONS_QUERY],
  ["subsequent_activity", SUBSEQUENT_ACTIVITY_QUERY],
  ["terminate_session_kind", TERMINATE_SESSION_KIND],
]);

/** Said once, so the refusal and the doc comment cannot drift apart. */
export const PRODUCTIVE_EVENT_TYPES_REQUIRED =
  "declare which event types count as productive activity; an empty set " +
  "disables the subsequent-evidence source without saying so, and every " +
  "termination it would have cleared becomes undetermined for a reason no " +
  "report records";

/** A false-termination figure that cannot be computed, stated not guessed. */
export class FalseTerminationRefusal extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "FalseTerminationRefusal";
    Object.setPrototypeOf(this, FalseTerminationRefusal.prototype);
  }
}

/**
 * A ground-truth source offered a verdict outside the closed set.
 *
 * The two legal answers decide opposite things, and an unrecognised third has
 * no safe reading: treating it as `stuck` hides a false termination and treating
 * it as `not_stuck` invents one. `undetermined` is not a legal *input* either --
 * a source that cannot decide says nothing, and saying nothing is how it reaches
 * the undetermined bucket. Accepting the word as an input would let a source
 * overrule a lower-preference source that *could* have settled it.
 */
export class UnknownGroundTruthVerdict extends FalseTerminationRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnknownGroundTruthVerdict";
    Object.setPrototypeOf(this, UnknownGroundTruthVerdict.prototype);
  }
}

/**
 * One `action` row of {@link TERMINATE_SESSION_KIND}, as read.
 *
 * `subjectId` is what the subsequent-evidence source looks for activity from:
 * the incident's session where the action names an incident that names one, and
 * otherwise the run. It can be `null` -- `action.run_id` and
 * `action.incident_id` are both nullable -- and a `null` subject means that
 * source cannot speak, which is different from it having spoken.
 *
 * A class rather than a plain object because the source is a frozen dataclass
 * with two derived `@property` members, and the ported cases read them as
 * properties. Getters keep that spelling and keep the derivation in one place.
 */
export class TerminateAction {
  readonly actionId: string;
  readonly runId: string | null;
  readonly incidentId: string | null;
  readonly sessionId: string | null;
  readonly status: string;
  readonly createdAtMs: number;
  readonly appliedAtMs: number | null;

  constructor(fields: {
    readonly actionId: string;
    readonly runId: string | null;
    readonly incidentId: string | null;
    readonly sessionId: string | null;
    readonly status: string;
    readonly createdAtMs: number;
    readonly appliedAtMs: number | null;
  }) {
    this.actionId = fields.actionId;
    this.runId = fields.runId;
    this.incidentId = fields.incidentId;
    this.sessionId = fields.sessionId;
    this.status = fields.status;
    this.createdAtMs = fields.createdAtMs;
    this.appliedAtMs = fields.appliedAtMs;
    Object.freeze(this);
  }

  get subjectKind(): string | null {
    if (this.sessionId !== null) {
      return "session";
    }
    if (this.runId !== null) {
      return "run";
    }
    return null;
  }

  get subjectId(): string | null {
    return this.sessionId !== null ? this.sessionId : this.runId;
  }
}

/**
 * One termination's verdict, which source settled it, and who disagreed.
 *
 * `overruled` holds every lower-preference source that offered a *different*
 * verdict than the winner. It is kept because a disagreement is a finding in its
 * own right and because a report that showed only the winner would make the
 * preference order unfalsifiable -- there would be no way to tell an order that
 * was applied from one that never had to be.
 */
export interface Adjudication {
  readonly actionId: string;
  readonly verdict: string;
  readonly source: string;
  readonly overruled: readonly (readonly [source: string, verdict: string])[];
}

/**
 * Section 3.4's headline and its three supporting series.
 *
 * The two cohorts are counted on **their own instants** and are deliberately not
 * nested. `recommendedTerminate` is every terminate action *created* in the
 * period; `appliedTerminate` is every one *applied* in it. A recommendation made
 * in this period and applied in the next is in the first and not the second
 * (`appliedAfterPeriodEnd`); one carried over from the previous period is in the
 * second and not the first (`appliedFromEarlierRecommendation`). Forcing them
 * into one cohort would mean either a denominator containing effects that had
 * not happened yet or a report that dropped effects which had.
 */
export class FalseTerminationReport {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly generatedAtMs: number;

  /** Supporting series 1: recommendations, applied or not (created in period). */
  readonly recommendedTerminate: readonly string[];
  /** Supporting series 2, split into its two very different halves. */
  readonly declinedRefused: readonly string[];
  readonly stillPending: readonly string[];
  /**
   * Recommended in this period, applied after it ended: this report's
   * denominator does not hold them, the next one's does.
   */
  readonly appliedAfterPeriodEnd: readonly string[];
  /** Recommended before this period and applied inside it. */
  readonly appliedFromEarlierRecommendation: readonly string[];

  /** Supporting series 3, and the denominator of the headline rate. */
  readonly appliedTerminate: readonly string[];

  /**
   * The headline numerator and the two buckets beside it. These three partition
   * {@link appliedTerminate}.
   */
  readonly falseTerminationIds: readonly string[];
  readonly justifiedIds: readonly string[];
  readonly undeterminedIds: readonly string[];

  readonly adjudications: ReadonlyMap<string, Adjudication>;

  constructor(fields: {
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly generatedAtMs: number;
    readonly recommendedTerminate: readonly string[];
    readonly declinedRefused: readonly string[];
    readonly stillPending: readonly string[];
    readonly appliedAfterPeriodEnd: readonly string[];
    readonly appliedFromEarlierRecommendation: readonly string[];
    readonly appliedTerminate: readonly string[];
    readonly falseTerminationIds: readonly string[];
    readonly justifiedIds: readonly string[];
    readonly undeterminedIds: readonly string[];
    readonly adjudications: ReadonlyMap<string, Adjudication>;
  }) {
    this.periodStartMs = fields.periodStartMs;
    this.periodEndMs = fields.periodEndMs;
    this.generatedAtMs = fields.generatedAtMs;
    this.recommendedTerminate = fields.recommendedTerminate;
    this.declinedRefused = fields.declinedRefused;
    this.stillPending = fields.stillPending;
    this.appliedAfterPeriodEnd = fields.appliedAfterPeriodEnd;
    this.appliedFromEarlierRecommendation = fields.appliedFromEarlierRecommendation;
    this.appliedTerminate = fields.appliedTerminate;
    this.falseTerminationIds = fields.falseTerminationIds;
    this.justifiedIds = fields.justifiedIds;
    this.undeterminedIds = fields.undeterminedIds;
    this.adjudications = fields.adjudications;
    Object.freeze(this);
  }

  /**
   * Section 3.4's second series: declined, plus not yet decided.
   *
   * Reported as one number because the section names one, and kept split in the
   * fields because "a human said no" and "nobody has looked yet" are different
   * facts about the gate.
   */
  get recommendedButNotApplied(): readonly string[] {
    return [...this.declinedRefused, ...this.stillPending];
  }

  /**
   * False terminations over applied terminations, counting only the settled.
   *
   * A lower bound on the rate: every undetermined row could turn out to be one.
   * `null` where nothing was applied -- a rate over an empty denominator is not
   * zero, and printing zero would report "we terminated nothing" as "we never
   * terminated wrongly".
   */
  get rateLower(): number | null {
    if (this.appliedTerminate.length === 0) {
      return null;
    }
    return this.falseTerminationIds.length / this.appliedTerminate.length;
  }

  /**
   * The same rate with every undetermined row counted against us.
   *
   * Not a prediction: the two bounds together are the honest statement, and
   * their gap is exactly how much ground truth the report is missing.
   */
  get rateUpper(): number | null {
    if (this.appliedTerminate.length === 0) {
      return null;
    }
    return (
      (this.falseTerminationIds.length + this.undeterminedIds.length) / this.appliedTerminate.length
    );
  }

  /** Do the two bounds coincide? Only when nothing is undetermined. */
  get rateIsSettled(): boolean {
    return this.undeterminedIds.length === 0;
  }
}

/**
 * Was this terminated subject stuck? Section 3.4's preference order, applied.
 *
 * The three maps are keyed by `actionId`; a key that is **absent** is a source
 * declining to speak, which is what lets the next source in
 * {@link GROUND_TRUTH_PREFERENCE} decide. All three are required with no
 * default: an empty map is a caller stating that a source has nothing to say,
 * and a defaulted one would be this file deciding that on the caller's behalf
 * and never recording it.
 *
 * `ReadonlyMap` rather than a plain object, because the keys are `action_id`
 * values that arrive from the database. A `Record` lookup for an id that happens
 * to spell `__proto__` or `constructor` finds something on `Object.prototype`
 * and reads it as a verdict; a `Map` has no such keys.
 *
 * @throws {UnknownGroundTruthVerdict} for any verdict outside
 *   `{stuck, not_stuck}`.
 */
export function adjudicate(options: {
  readonly actionId: string;
  readonly fixtureLabels: ReadonlyMap<string, string>;
  readonly subsequentEvidence: ReadonlyMap<string, string>;
  readonly humanAdjudications: ReadonlyMap<string, string>;
}): Adjudication {
  const { actionId } = options;
  const offered = new Map<string, string | undefined>([
    [SOURCE_FIXTURE_LABEL, options.fixtureLabels.get(actionId)],
    [SOURCE_SUBSEQUENT_EVIDENCE, options.subsequentEvidence.get(actionId)],
    [SOURCE_HUMAN_ADJUDICATION, options.humanAdjudications.get(actionId)],
  ]);

  for (const [source, verdict] of offered) {
    if (verdict === undefined) {
      continue;
    }
    if (verdict !== VERDICT_STUCK && verdict !== VERDICT_NOT_STUCK) {
      throw new UnknownGroundTruthVerdict(
        `ground-truth source ${quote(source)} answered ${quote(verdict)} for ` +
          `action_id=${quote(actionId)}; the only answers are ` +
          `${quote(VERDICT_STUCK)} and ${quote(VERDICT_NOT_STUCK)}, and a source ` +
          `with no opinion says nothing rather than saying ` +
          `${quote(VERDICT_UNDETERMINED)}`,
      );
    }
  }

  // The preference order is walked, not written out as branches: the array is
  // the specification, so a change to section 3.4's order is a change to one
  // line of data and not a re-reading of this function.
  for (const [rank, source] of GROUND_TRUTH_PREFERENCE.entries()) {
    const verdict = offered.get(source);
    if (verdict === undefined) {
      continue;
    }
    const overruled: (readonly [string, string])[] = [];
    for (const lower of GROUND_TRUTH_PREFERENCE.slice(rank + 1)) {
      const lowerVerdict = offered.get(lower);
      if (lowerVerdict !== undefined && lowerVerdict !== verdict) {
        overruled.push([lower, lowerVerdict] as const);
      }
    }
    return { actionId, verdict, source, overruled };
  }

  return {
    actionId,
    verdict: VERDICT_UNDETERMINED,
    source: SOURCE_NONE,
    overruled: [],
  };
}

/**
 * Section 3.4's second source: the subject's own subsequent evidence.
 *
 * "A session that resumed productive activity after the termination window was
 * not stuck." So this returns {@link VERDICT_NOT_STUCK} for a subject with a
 * productive event on the spine strictly after `appliedAtMs`, and returns
 * **nothing at all** for every other subject.
 *
 * The asymmetry is the whole design and is not an oversight. Silence after a
 * termination is what a termination *produces*; reading it as confirmation that
 * the subject was stuck would make every termination self-justifying and drive
 * the false-termination rate to zero by construction (interlock `D-0006`:
 * absence of evidence is not evidence, and "cannot determine" is a legitimate
 * outcome).
 *
 * `productiveEventTypes` has no default and may not be empty. Which event types
 * are "productive" is a statement about what the organisation's producers write,
 * and it belongs to the caller assembling the report; an "everything counts"
 * default would admit the termination's own bookkeeping events and clear every
 * termination it looked at.
 *
 * The window is bounded above by `periodEndMs` so the answer is a function of
 * the period the report is over: evidence that arrived after the report closed
 * belongs to the next report, not to a figure this one already printed
 * (`time-base-policy.md` section 2 rule 4). `ingested_at_ms` is the clock, per
 * rule 1.
 */
export function subsequentActivityVerdicts(
  connection: SqliteDatabase,
  actions: Iterable<TerminateAction>,
  options: {
    readonly productiveEventTypes: readonly string[];
    readonly periodEndMs: number;
  },
): ReadonlyMap<string, string> {
  const { productiveEventTypes, periodEndMs } = options;
  if (productiveEventTypes.length === 0) {
    throw new FalseTerminationRefusal(PRODUCTIVE_EVENT_TYPES_REQUIRED);
  }

  const verdicts = new Map<string, string>();
  const statement = SUBSEQUENT_ACTIVITY_QUERY.replace(
    "{event_types}",
    productiveEventTypes.map(() => "?").join(", "),
  );
  const prepared = connection.prepare(statement);

  for (const action of actions) {
    if (action.status !== STATUS_APPLIED || action.appliedAtMs === null) {
      // Only an applied termination has a "subsequent" at all. A pending
      // recommendation's subject is still running for reasons that have nothing
      // to do with a termination that never happened.
      continue;
    }
    const subjectKind = action.subjectKind;
    const subjectId = action.subjectId;
    if (subjectKind === null || subjectId === null) {
      // Nothing to look for activity from, so this source declines -- which is
      // not the same as finding no activity, and is recorded as an absent key
      // exactly like any other declining source.
      continue;
    }
    const row = prepared.get(
      subjectKind,
      subjectId,
      ...productiveEventTypes,
      action.appliedAtMs,
      periodEndMs,
    );
    if (row !== undefined) {
      verdicts.set(action.actionId, VERDICT_NOT_STUCK);
    }
  }
  return verdicts;
}

/**
 * Section 3.4's report over one period.
 *
 * The three ground-truth maps are required; see {@link adjudicate} on why none
 * of them defaults. `nowMs` is the caller's clock (`time-base-policy.md` section
 * 2 rule 2) and is recorded as the report's `generatedAtMs`.
 *
 * @throws {FalseTerminationRefusal} if the period is empty or inverted.
 * @throws {UnknownGroundTruthVerdict} for a verdict outside the closed set.
 */
export function measureFalseTermination(
  connection: SqliteDatabase,
  options: {
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly nowMs: number;
    readonly fixtureLabels: ReadonlyMap<string, string>;
    readonly subsequentEvidence: ReadonlyMap<string, string>;
    readonly humanAdjudications: ReadonlyMap<string, string>;
  },
): FalseTerminationReport {
  const { periodStartMs, periodEndMs, nowMs } = options;

  if (periodEndMs <= periodStartMs) {
    throw new FalseTerminationRefusal(
      `the report period [${periodStartMs}, ${periodEndMs}) is empty or ` +
        `inverted (time-base-policy.md section 2, rule 4)`,
    );
  }

  const actions = readTerminateActions(connection, { periodStartMs, periodEndMs });

  const recommended: string[] = [];
  const declined: string[] = [];
  const pending: string[] = [];
  const appliedAfter: string[] = [];
  const appliedEarlier: string[] = [];
  const applied: string[] = [];

  for (const action of actions) {
    const createdInPeriod = periodStartMs <= action.createdAtMs && action.createdAtMs < periodEndMs;
    const appliedInPeriod =
      action.appliedAtMs !== null &&
      periodStartMs <= action.appliedAtMs &&
      action.appliedAtMs < periodEndMs;
    if (createdInPeriod) {
      recommended.push(action.actionId);
      if (action.status === STATUS_REFUSED) {
        declined.push(action.actionId);
      } else if (action.status === STATUS_PENDING) {
        pending.push(action.actionId);
      } else if (action.status === STATUS_APPLIED && !appliedInPeriod) {
        appliedAfter.push(action.actionId);
      }
    }
    if (appliedInPeriod) {
      applied.push(action.actionId);
      if (!createdInPeriod) {
        appliedEarlier.push(action.actionId);
      }
    }
  }

  const adjudications = new Map<string, Adjudication>();
  const falseTerminations: string[] = [];
  const justified: string[] = [];
  const undetermined: string[] = [];
  for (const actionId of applied) {
    const verdict = adjudicate({
      actionId,
      fixtureLabels: options.fixtureLabels,
      subsequentEvidence: options.subsequentEvidence,
      humanAdjudications: options.humanAdjudications,
    });
    adjudications.set(actionId, verdict);
    if (verdict.verdict === VERDICT_NOT_STUCK) {
      falseTerminations.push(actionId);
    } else if (verdict.verdict === VERDICT_STUCK) {
      justified.push(actionId);
    } else {
      undetermined.push(actionId);
    }
  }

  return new FalseTerminationReport({
    periodStartMs,
    periodEndMs,
    generatedAtMs: nowMs,
    recommendedTerminate: recommended,
    declinedRefused: declined,
    stillPending: pending,
    appliedAfterPeriodEnd: appliedAfter,
    appliedFromEarlierRecommendation: appliedEarlier,
    appliedTerminate: applied,
    falseTerminationIds: falseTerminations,
    justifiedIds: justified,
    undeterminedIds: undetermined,
    adjudications,
  });
}

/**
 * Every terminate action this period recommended or applied, ordered by id.
 *
 * The `LEFT JOIN` onto `incident` is what supplies the session subject: a
 * termination names an incident, and the incident names the session the
 * subsequent-evidence source looks for activity from. It is a `LEFT` join
 * because `action.incident_id` is nullable in the DDL and an action without one
 * is still an applied effect that belongs in the denominator -- an inner join
 * would drop it, shrinking the denominator and *raising* the rate for a reason
 * that has nothing to do with terminations being wrong.
 *
 * `ORDER BY action_id` makes the itemisations, and therefore the rendered
 * report, byte-reproducible (interlock `D-0040`).
 */
export function readTerminateActions(
  connection: SqliteDatabase,
  options: { readonly periodStartMs: number; readonly periodEndMs: number },
): readonly TerminateAction[] {
  const rows = connection.prepare(TERMINATE_ACTIONS_QUERY).all({
    terminate_session_kind: TERMINATE_SESSION_KIND,
    period_start_ms: options.periodStartMs,
    period_end_ms: options.periodEndMs,
  }) as {
    action_id: unknown;
    run_id: unknown;
    incident_id: unknown;
    session_id: unknown;
    status: unknown;
    created_at_ms: unknown;
    applied_at_ms: unknown;
  }[];

  return rows.map(
    (row) =>
      new TerminateAction({
        actionId: String(row.action_id),
        runId: row.run_id === null ? null : String(row.run_id),
        incidentId: row.incident_id === null ? null : String(row.incident_id),
        sessionId: row.session_id === null ? null : String(row.session_id),
        status: String(row.status),
        createdAtMs: Number(row.created_at_ms),
        appliedAtMs: row.applied_at_ms === null ? null : Number(row.applied_at_ms),
      }),
  );
}

/**
 * Render `report` as plain ASCII text, with no verdict in it.
 *
 * ASCII only, `-` never an em-dash: this reaches a cp932 console, where a single
 * U+2014 turns a report into a `UnicodeEncodeError` (`D-0006`).
 *
 * The three supporting series print beside the headline, and the
 * declined-recommendation line carries section 3.4's reading of it in words --
 * "informative rather than alarming" -- because a number rising in a report with
 * no note attached gets optimised downward by whoever is asked to make it stop
 * rising, and here that means removing the human gate.
 */
export function renderFalseTerminationReport(report: FalseTerminationReport): string {
  const lines: string[] = [];
  lines.push("False termination -- counted at the applied effect (section 3.4)");
  lines.push(
    `  period          [${report.periodStartMs}, ${report.periodEndMs}) ` + `(half-open, epoch ms)`,
  );
  lines.push(`  generated at    ${report.generatedAtMs}`);
  lines.push(
    `  counted over    action rows with kind = ` +
      `'${TERMINATE_SESSION_KIND}' and status = '${STATUS_APPLIED}'`,
  );
  lines.push(
    "  NOT counted     AI recommendations (D-0004 / AC-6: the Dispatcher " +
      "AI cannot terminate) and watcher candidates",
  );
  lines.push("");

  lines.push("Headline");
  lines.push(
    `  false terminations ${report.falseTerminationIds.length} of ` +
      `${report.appliedTerminate.length} applied`,
  );
  lines.push(`    rate (settled only, a lower bound): ${percent(report.rateLower)}`);
  lines.push(
    `    rate (every undetermined counted against us, an upper bound): ` +
      `${percent(report.rateUpper)}`,
  );
  if (report.rateIsSettled) {
    lines.push(
      "    the two bounds coincide: every applied termination was settled " + "by ground truth",
    );
  } else {
    lines.push(
      `    the gap is ${report.undeterminedIds.length} undetermined ` +
        "termination(s) - ground truth this report does not have, not " +
        "terminations it judged",
    );
  }
  lines.push("");

  lines.push("Supporting series (the headline alone hides where precision lives)");
  lines.push(
    `  recommended_terminate        ${report.recommendedTerminate.length}` +
      "    recommendations created in the period, applied or not",
  );
  lines.push(
    `  recommended_but_not_applied  ` +
      `${report.recommendedButNotApplied.length}` +
      `    declined ${report.declinedRefused.length}, ` +
      `awaiting a decision ${report.stillPending.length}`,
  );
  lines.push(
    "      This is the visible value of the human gate. A rising number is " +
      "INFORMATIVE, NOT alarming: it is terminations that did not happen to a " +
      "subject that did not need one.",
  );
  lines.push(
    `  applied_terminate            ${report.appliedTerminate.length}` +
      "    the denominator above",
  );
  lines.push(
    `  applied after period end     ` +
      `${report.appliedAfterPeriodEnd.length}` +
      "    recommended here, applied later; in the next report's denominator",
  );
  lines.push(
    `  applied from earlier period  ` +
      `${report.appliedFromEarlierRecommendation.length}` +
      "    recommended before this period, applied inside it",
  );
  lines.push("");

  lines.push("Ground truth, in the order of preference of section 3.4");
  lines.push(`  ${GROUND_TRUTH_PREFERENCE.join(" > ")}`);
  lines.push(
    "  A source with no opinion is silent, and where all three are silent " +
      "the termination is undetermined (D-0006: cannot determine is a " +
      "legitimate outcome).",
  );
  const buckets: readonly (readonly [string, readonly string[]])[] = [
    ["false termination (subject was NOT stuck)", report.falseTerminationIds],
    ["justified (subject WAS stuck)", report.justifiedIds],
    ["undetermined", report.undeterminedIds],
  ];
  for (const [bucket, ids] of buckets) {
    lines.push(`  ${bucket} (${ids.length}):`);
    if (ids.length === 0) {
      lines.push("      none");
    }
    for (const actionId of ids) {
      const decision = report.adjudications.get(actionId);
      lines.push(`      ${actionId}  settled by: ${decision?.source ?? SOURCE_NONE}`);
      for (const [source, verdict] of decision?.overruled ?? []) {
        lines.push(
          `          overruled ${source} = ${verdict} ` +
            "(lower preference; recorded because a disagreement is a " +
            "finding)",
        );
      }
    }
  }
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

function percent(value: number | null): string {
  if (value === null) {
    return "not computable (nothing was applied in this period)";
  }
  // `formatFixed`, not `toFixed`: they disagree on exact ties and a rate is
  // `count / count * 100`, which reaches them (D-0104).
  return `${formatFixed(value * 100, 2)} percent`;
}

/**
 * Python's `!r` for a string, which is what the refusal messages interpolate.
 *
 * Single quotes, because that is what `repr` uses for a string with no single
 * quote in it -- and every value reaching here is a verdict word, a source name
 * or an `action_id`.
 */
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
