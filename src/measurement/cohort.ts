import type { Database as SqliteDatabase } from "better-sqlite3";

// The terminal set is the schema's, not a copy of it. gates.ts owns the
// constant because section 9.4's subject_gone sweep reads the same fact out of
// the same column, and a second copy here would agree with it right up until
// the day the vocabulary changed -- the one day terminal_status_unknown exists
// to notice. Importing a writer module is not a write capability: the harness's
// read-only property lives on the connection (reader.ts), and this module never
// hands its connection to anything.
import { TERMINAL_RUN_STATUSES } from "../control_plane/gates.js";
import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import { comparePythonStrings, pythonRepr } from "./format.js";
import { frozenList, readOnlyMap } from "./immutable.js";

/**
 * G6 -- AC-9's denominator: the cohort, and the four reasons a run is not in it.
 *
 * The failure this module is written against is not a crash; it is a number that
 * was quietly never comparable to the thing it was compared against.
 * `docs/measurement-harness.md` section 2.1 records the shape of it. AC-9 is
 * stated "per 100 worker runs", which is a normalisation and not a cohort, and
 * the design review found three defensible readings of "100 runs" -- started,
 * completed, canary-owned -- each producing a different denominator from the
 * same database. A rate whose denominator is decided by whoever wrote the query
 * most recently moves when nothing about the system moved, and the v1 baseline
 * it is compared against (195 *completed* runs normalised to roughly 1,576
 * dispatcher ticks per 100 runs) is a completed-run figure, so a started-run
 * cohort would not be against that number at all.
 *
 * Interlock `D-0038` closed it, and this module is the closure in code:
 *
 * > **The cohort is the runs whose entire lifetime falls inside the report
 * > period -- created at or after `period_start_ms` and terminal before
 * > `period_end_ms` -- and that were Interlock-owned throughout.**
 *
 * **"Entire lifetime" is not a restatement of "terminal in period", and the
 * difference is the whole reason the clause is worded that way.** A run that
 * started before the window and finished inside it *is* terminal in the window,
 * and it is **excluded** -- it lands in {@link STARTED_BEFORE_PERIOD}. Its
 * prompts lie on both sides of the boundary, so counting it puts a full run in
 * the denominator against a partial numerator, and the alternative (attributing
 * prompts to the window they happened in and the run to the window it finished
 * in) makes numerator and denominator count different things, which is how a
 * rate silently stops meaning anything.
 *
 * **A started-run cohort is right-censored by construction**, which is why a run
 * still in flight at the period's end is excluded too: it has produced some of
 * its prompts and not others, so counting it deflates the per-run figure by
 * exactly the work it has not done yet. The bias is small and always in the
 * flattering direction, and a target must not carry a bias that flatters it.
 *
 * **Ownership is asserted, not assumed, and the assertion rests on interlock
 * `D-0013`.** Ownership is decided once, at run start, and the cutover happens
 * at the run boundary with no state conversion, so a run is Interlock-owned for
 * its whole life or for none of it. What that means here is concrete: **a row in
 * this database is itself the ownership assertion.** There is no ownership
 * column to read, because a v1-owned run never becomes a row here. The
 * consequence is that {@link V1_OWNED} can never be derived from the `run` table
 * -- deriving it would mean inventing a distinction the schema deliberately does
 * not carry -- so {@link selectCohort} takes the v1 shadow input as a parameter
 * and refuses ({@link OwnershipAssertionRefused}) if that input names a run this
 * database also holds. That refusal is the assertion being *checked*.
 *
 * **Excluded runs are not silently dropped.** Every run that touches the period
 * lands in exactly one place -- the cohort, or one of the four buckets in
 * {@link EXCLUDED_REASONS} -- and all four buckets are emitted every time, even
 * empty. A reader diffing two reports must see a zero rather than a missing key.
 *
 * **Nothing here writes and nothing here reads a clock.** The connection comes
 * from {@link openForMeasurement}, which is read-only by capability rather than
 * by this module's good behaviour, and every bound is the caller's
 * (`time-base-policy.md` section 2, rule 4: windows are half-open at both ends).
 */

/**
 * The statuses a run can hold, as the `run` table's own `CHECK` enumerates them.
 *
 * Interlock `D-0041` closed this set in DDL, which is what makes
 * {@link TERMINAL_STATUS_UNKNOWN} a schema-integrity signal rather than a
 * routine bucket. The terminal half is imported rather than repeated;
 * `cohort.test.ts` reads the `CHECK` clause out of a migrated database and
 * asserts this list equals it, so the copy cannot drift in silence.
 */
export const KNOWN_RUN_STATUSES: readonly string[] = frozenList([
  "created",
  "running",
  "suspended",
  ...TERMINAL_RUN_STATUSES,
]);

/**
 * The four excluded reasons of `measurement-harness.md` section 2.1, named once
 * so the report, the buckets and the tests cannot disagree about spelling.
 */
export const IN_FLIGHT_AT_PERIOD_END = "in_flight_at_period_end";
export const STARTED_BEFORE_PERIOD = "started_before_period";
export const V1_OWNED = "v1_owned";
export const TERMINAL_STATUS_UNKNOWN = "terminal_status_unknown";

/** Emitted in this order, **always**, empty or not. */
export const EXCLUDED_REASONS: readonly string[] = frozenList([
  IN_FLIGHT_AT_PERIOD_END,
  STARTED_BEFORE_PERIOD,
  V1_OWNED,
  TERMINAL_STATUS_UNKNOWN,
]);

/**
 * The buckets that partition the runs *this database holds* which touch the
 * period.
 *
 * {@link V1_OWNED} is deliberately absent: it is not derived from the `run`
 * table at all, so it is not part of that partition and a test asserting the
 * partition must not include it.
 */
export const COHORT_REASONS: readonly string[] = frozenList([
  IN_FLIGHT_AT_PERIOD_END,
  STARTED_BEFORE_PERIOD,
  TERMINAL_STATUS_UNKNOWN,
]);

/**
 * The statements this module executes, as the text that is **executed**.
 *
 * @public
 *
 * `measurement-harness.md` section 6 requires `query_definitions` to carry
 * "every query the report ran, as text ... so a reader can run them by hand". A
 * statement written inline at its call site cannot honour that -- the header
 * could only name a pasted copy, which is right on the day it is pasted and goes
 * on being printed after the executed text changes, certifying a query that
 * never ran.
 *
 * `created_at_ms < :period_end_ms` is the only bound SQL carries; the rest of
 * the walk goes through {@link terminalInstantMs} so the terminal-instant
 * derivation exists in exactly one place. `ORDER BY run_id` makes the report
 * byte-reproducible (interlock `D-0040`).
 */
export const COHORT_RUNS_QUERY = `
SELECT run_id, status, created_at_ms, updated_at_ms
  FROM run
 WHERE created_at_ms < :period_end_ms
 ORDER BY run_id
`;

/**
 * `{placeholders}` expands to one `?` per shadow run id in the chunk.
 *
 * SQLite has no parameter form for an `IN` list, so the placeholders are
 * generated and the ids are still bound -- no run id reaches the statement as
 * text. The catalogue carries the template, which is what a reader re-runs; the
 * expansion is mechanical.
 */
export const OWNERSHIP_COLLISION_QUERY = "SELECT run_id FROM run WHERE run_id IN ({placeholders})";

export const QUERY_DEFINITIONS: ReadonlyMap<string, string> = readOnlyMap([
  ["cohort_runs", COHORT_RUNS_QUERY],
  ["cohort_ownership_collision", OWNERSHIP_COLLISION_QUERY],
]);

/**
 * A `run.status` outside {@link KNOWN_RUN_STATUSES} reached a caller.
 *
 * Its own type because the honest answer to "is this run terminal?" for an
 * unrecognised status is neither yes nor no. Returning `null` -- "not terminal"
 * -- would file the run as in-flight and hide a database whose `CHECK` this
 * build does not share; returning a terminal instant would put a run of unknown
 * shape into the denominator. {@link selectCohort} catches this and files the
 * run under {@link TERMINAL_STATUS_UNKNOWN} instead, which is the one place in
 * the harness that is allowed to have an answer for it.
 */
export class UnknownRunStatusRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnknownRunStatusRefused";
    Object.setPrototypeOf(this, UnknownRunStatusRefused.prototype);
  }
}

/**
 * The report period has not ended yet at `nowMs`, or is empty/inverted.
 *
 * A cohort over a period whose end is in the future is not merely provisional,
 * it is wrong in a specific direction: every run still running would be filed
 * `in_flight_at_period_end` on the strength of a period end that has not
 * happened, and re-running the same report tomorrow would move runs out of that
 * bucket and into the denominator. The rate would change with no change in the
 * system, which is the defect this module exists to prevent, arriving through
 * the clock instead of through the query.
 */
export class PeriodNotClosedRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PeriodNotClosedRefused";
    Object.setPrototypeOf(this, PeriodNotClosedRefused.prototype);
  }
}

/**
 * The v1 shadow input named a run this database also holds.
 *
 * Interlock `D-0013` decides ownership once at run start and cuts over at the
 * run boundary, so a run is v1's or Interlock's and never both. A row here *is*
 * the claim that it is Interlock's (there is no ownership column), so a
 * collision is two systems claiming one run -- a contradiction in the input, the
 * schema, or the cutover, and the report cannot tell which. Excluding the row
 * quietly would shrink the denominator and leave nothing anywhere saying why, so
 * the harness stops instead.
 */
export class OwnershipAssertionRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "OwnershipAssertionRefused";
    Object.setPrototypeOf(this, OwnershipAssertionRefused.prototype);
  }
}

/**
 * AC-9's denominator, with the runs it left out and why.
 *
 * `runIds` is the cohort. `excluded` always carries all four keys of
 * {@link EXCLUDED_REASONS}; interlock `D-0038` makes the breakdown required
 * output -- "a reduction rate printed without them is not a valid report" -- so
 * it is not optional here either.
 */
export class RunCohort {
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly runIds: readonly string[];
  readonly excluded: ReadonlyMap<string, readonly string[]>;

  constructor(fields: {
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly runIds: readonly string[];
    readonly excluded: ReadonlyMap<string, readonly string[]>;
  }) {
    this.periodStartMs = fields.periodStartMs;
    this.periodEndMs = fields.periodEndMs;
    this.runIds = frozenList(fields.runIds);
    this.excluded = readOnlyMap(
      [...fields.excluded].map(([reason, ids]): [string, readonly string[]] => [
        reason,
        frozenList(ids),
      ]),
    );
    Object.freeze(this);
  }

  /** The number of runs AC-9's rate is normalised over. */
  get denominator(): number {
    return this.runIds.length;
  }

  /**
   * Per-reason counts, all four keys present even at zero.
   *
   * A zero and a missing key are different statements to a reader diffing two
   * reports, and only one of them is the truth this harness has.
   */
  excludedCounts(): ReadonlyMap<string, number> {
    return readOnlyMap(
      EXCLUDED_REASONS.map((reason): [string, number] => [
        reason,
        (this.excluded.get(reason) ?? []).length,
      ]),
    );
  }
}

/**
 * The instant `status`/`updatedAtMs` say the run terminated, or `null`.
 *
 * **This is a derivation, resting on writer discipline, not a fact the schema
 * enforces.** There is no terminal-timestamp column; the reasoning that lets
 * `updated_at_ms` stand in for one is:
 *
 * 1. `status` is the only mutable column on `run` -- `run_id` and
 *    `created_at_ms` are written once -- so every `UPDATE` that moves
 *    `updated_at_ms` is a status transition;
 * 2. the `run_status_is_forward_only` trigger (interlock `D-0041`) refuses to
 *    leave `completed`/`failed`/`cancelled`, so a terminal status is absorbing
 *    and no later transition can occur;
 * 3. therefore a terminal run's **last** mutation *is* its terminalisation, and
 *    `updated_at_ms` is the instant it happened.
 *
 * Step 1 is the assumption a schema change could invalidate without the trigger
 * noticing -- add one more mutable column to `run` and a bump of it after
 * termination would push this value forward, silently moving a run across a
 * period boundary. That is why the reasoning lives **here, once**: every part of
 * the harness that needs a terminal instant calls this function, so swapping to
 * a dedicated `terminated_at_ms` column later is a one-place change and not a
 * hunt through the report.
 *
 * @throws {UnknownRunStatusRefused} if `status` is outside
 *   {@link KNOWN_RUN_STATUSES}. No silent default: see that class.
 */
export function terminalInstantMs(status: string, updatedAtMs: number): number | null {
  if (!KNOWN_RUN_STATUSES.includes(status)) {
    throw new UnknownRunStatusRefused(
      `run.status ${pythonRepr(status)} is outside the closed set ` +
        `${KNOWN_RUN_STATUSES.join(", ")} that D-0041 put in the run table's ` +
        `CHECK; this build cannot say whether such a run is terminal, and will ` +
        `not guess in either direction`,
    );
  }
  if (!TERMINAL_RUN_STATUSES.includes(status)) {
    return null;
  }
  return updatedAtMs;
}

/**
 * Does any part of this run's lifetime fall inside `[start, end)`?
 *
 * The lifetime is `createdAtMs` up to the terminal instant, or up to "still
 * going" for a run that has not terminated. Touching is what makes a run the
 * report's business at all: a run that lies wholly outside the period appears in
 * neither the cohort nor any bucket, because a bucket entry is a statement that
 * the report considered the run and set it aside, and the report has nothing to
 * say about a run that never overlapped its window.
 *
 * Both ends are the half-open ends of `time-base-policy.md` section 2 rule 4: a
 * run created exactly at `periodEndMs` belongs to the next period, and a run
 * whose terminal instant is exactly `periodStartMs` did overlap this one (that
 * instant is inside it) and is therefore considered -- and then excluded as
 * {@link STARTED_BEFORE_PERIOD}.
 *
 * A run whose status this build does not know has no computable terminal
 * instant, so it is treated as unbounded above: it touches if it was created
 * before the period ended. Erring that way puts it in front of the reader as
 * {@link TERMINAL_STATUS_UNKNOWN} instead of dropping the evidence.
 */
export function touchesPeriod(
  status: string,
  createdAtMs: number,
  updatedAtMs: number,
  options: { readonly periodStartMs: number; readonly periodEndMs: number },
): boolean {
  if (createdAtMs >= options.periodEndMs) {
    return false;
  }
  let terminalMs: number | null;
  try {
    terminalMs = terminalInstantMs(status, updatedAtMs);
  } catch (error) {
    if (error instanceof UnknownRunStatusRefused) {
      return true;
    }
    throw error;
  }
  return terminalMs === null || terminalMs >= options.periodStartMs;
}

/**
 * AC-9's cohort over `[periodStartMs, periodEndMs)`, with its exclusions.
 *
 * `connection` must be the read-only handle from {@link openForMeasurement};
 * this function issues one `SELECT` and nothing else.
 *
 * `v1ShadowRunIds` is the v1 shadow input. It is a **parameter** because the
 * {@link V1_OWNED} bucket cannot be derived from this database at all --
 * interlock `D-0013` leaves no v1-owned run here to find. Passing nothing
 * therefore yields an empty `v1_owned` bucket, which is the honest answer for a
 * report with no shadow input, not an assertion that no v1 run existed.
 *
 * Each touching run this database holds is filed in **exactly one** place, in
 * this order, and the order is part of the contract because two reasons can
 * apply at once:
 *
 * 1. {@link TERMINAL_STATUS_UNKNOWN} -- nothing else can be decided about a run
 *    whose status this build cannot interpret;
 * 2. {@link IN_FLIGHT_AT_PERIOD_END} -- no terminal instant *before* the
 *    period's end. This is checked before `startedBeforePeriod` for a run that
 *    spans the whole window because right-censoring is the heavier
 *    disqualification: a partly-outside run has a known count that is wrong, an
 *    in-flight one has no final count at all;
 * 3. {@link STARTED_BEFORE_PERIOD} -- terminal in the window, created before it
 *    opened;
 * 4. otherwise: the cohort.
 *
 * @throws {PeriodNotClosedRefused} if the period is empty, inverted, or has not
 *   ended at `nowMs`.
 * @throws {OwnershipAssertionRefused} if the shadow input names a run held here.
 */
export function selectCohort(
  connection: SqliteDatabase,
  options: {
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly nowMs: number;
    readonly v1ShadowRunIds?: Iterable<string>;
  },
): RunCohort {
  const { periodStartMs, periodEndMs, nowMs } = options;

  if (periodEndMs <= periodStartMs) {
    throw new PeriodNotClosedRefused(
      `the report period [${periodStartMs}, ${periodEndMs}) is empty or ` +
        `inverted; a half-open window must have an end strictly after its start ` +
        `(time-base-policy.md section 2, rule 4)`,
    );
  }
  if (nowMs < periodEndMs) {
    throw new PeriodNotClosedRefused(
      `the report period [${periodStartMs}, ${periodEndMs}) has not ended at ` +
        `now_ms=${nowMs}; the cohort would count runs as in flight at an end ` +
        `that has not happened, and the same report run again later would move ` +
        `them into the denominator (D-0038)`,
    );
  }

  const shadow = frozenList([...new Set(options.v1ShadowRunIds ?? [])].sort(comparePythonStrings));
  assertNoRunIsClaimedByBoth(connection, shadow);

  const buckets = new Map<string, string[]>(
    EXCLUDED_REASONS.map((reason): [string, string[]] => [reason, []]),
  );
  (buckets.get(V1_OWNED) as string[]).push(...shadow);
  const cohort: string[] = [];

  // The statement is COHORT_RUNS_QUERY rather than a literal here so that the
  // provenance header names the text that ran (section 6).
  const rows = connection.prepare(COHORT_RUNS_QUERY).all({ period_end_ms: periodEndMs }) as {
    run_id: string;
    status: string;
    created_at_ms: number;
    updated_at_ms: number;
  }[];

  for (const row of rows) {
    const runId = String(row.run_id);
    const status = String(row.status);
    const createdAtMs = Number(row.created_at_ms);
    const updatedAtMs = Number(row.updated_at_ms);

    if (!touchesPeriod(status, createdAtMs, updatedAtMs, { periodStartMs, periodEndMs })) {
      continue;
    }
    let terminalMs: number | null;
    try {
      terminalMs = terminalInstantMs(status, updatedAtMs);
    } catch (error) {
      if (!(error instanceof UnknownRunStatusRefused)) {
        throw error;
      }
      // D-0041 closed the CHECK, so this bucket should stay empty and a
      // non-zero count here is a schema-integrity signal -- a database written
      // by a build with a wider vocabulary, or a CHECK dropped by hand --
      // rather than routine noise. It is still emitted at zero,
      // unconditionally, so that a reader diffing two reports sees the zero and
      // knows the check ran.
      (buckets.get(TERMINAL_STATUS_UNKNOWN) as string[]).push(runId);
      continue;
    }
    if (terminalMs === null || terminalMs >= periodEndMs) {
      (buckets.get(IN_FLIGHT_AT_PERIOD_END) as string[]).push(runId);
    } else if (createdAtMs < periodStartMs) {
      (buckets.get(STARTED_BEFORE_PERIOD) as string[]).push(runId);
    } else {
      cohort.push(runId);
    }
  }

  return new RunCohort({
    periodStartMs,
    periodEndMs,
    runIds: cohort,
    excluded: readOnlyMap(
      EXCLUDED_REASONS.map((reason): [string, readonly string[]] => [
        reason,
        buckets.get(reason) ?? [],
      ]),
    ),
  });
}

/**
 * Refuse if the shadow input names a run this database holds.
 *
 * This is the ownership assertion of interlock `D-0013` being checked rather
 * than recited ({@link OwnershipAssertionRefused}). The ids are chunked because
 * SQLite's default parameter ceiling is 999 and a shadow input is a list of
 * whatever length v1 hands over; a query that worked in testing and failed on
 * the first real period would be a poor place to discover that.
 */
function assertNoRunIsClaimedByBoth(connection: SqliteDatabase, shadow: readonly string[]): void {
  const collisions: string[] = [];
  for (let start = 0; start < shadow.length; start += 500) {
    const chunk = shadow.slice(start, start + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const found = connection
      .prepare(OWNERSHIP_COLLISION_QUERY.replace("{placeholders}", placeholders))
      .all(...chunk) as { run_id: string }[];
    collisions.push(...found.map((row) => String(row.run_id)));
  }
  if (collisions.length > 0) {
    throw new OwnershipAssertionRefused(
      `the v1 shadow input names ${[...collisions].sort(comparePythonStrings).join(", ")}, ` +
        `which this Interlock database also holds; a run row here is itself the ` +
        `assertion that the run is Interlock-owned (D-0013 decides ownership ` +
        `once at run start and cuts over at the run boundary), so one run ` +
        `claimed by both systems is a contradiction the report cannot resolve ` +
        `by picking a side`,
    );
  }
}
