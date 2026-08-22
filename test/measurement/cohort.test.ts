/**
 * The denominator, taken apart: both half-open ends, the four buckets, and the
 * partition.
 *
 * Ported from interlock `tests/measurement/test_cohort.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping, and the cases that are
 * adapted rather than translated straight, are recorded in
 * `parity/measurement.cohort.ledger.json`.
 *
 * `docs/measurement-harness.md` section 2.1 is emphatic that "entire lifetime"
 * is not a restatement of "terminal in period", and a test suite that only built
 * runs comfortably inside the window would pass under either reading -- which is
 * the defect, not the fix. So the cases here are the ones that separate the two
 * readings: a run terminal *inside* the period but created *before* it, and runs
 * sitting exactly on each boundary instant.
 *
 * The partition test is the load-bearing one. "Excluded runs are not silently
 * dropped" is a property of the whole classification and not of any one branch,
 * so it is asserted as a property -- every touching run appears exactly once
 * across the cohort and the buckets -- over a population built to hit every
 * branch at once. A per-branch test can stay green while a fifth case falls
 * through the bottom of the loop.
 *
 * Nothing here re-implements the classification to check it against: the
 * vocabulary test reads the `CHECK` clause out of a real migrated database and
 * holds the module's own list against it, and every other test states expected
 * membership by hand.
 */

import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import {
  COHORT_RUNS_QUERY,
  EXCLUDED_REASONS,
  IN_FLIGHT_AT_PERIOD_END,
  KNOWN_RUN_STATUSES,
  OwnershipAssertionRefused,
  PeriodNotClosedRefused,
  type RunCohort,
  STARTED_BEFORE_PERIOD,
  selectCohort,
  TERMINAL_STATUS_UNKNOWN,
  terminalInstantMs,
  touchesPeriod,
  UnknownRunStatusRefused,
  V1_OWNED,
} from "../../src/measurement/cohort.js";
import { openForMeasurement } from "../../src/measurement/reader.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

/**
 * One day, so the boundary instants below are unmistakably distinct from the
 * durations in between.
 */
const DAY_MS = 86_400_000;
const PERIOD_START = T0;
const PERIOD_END = T0 + DAY_MS;
/**
 * The report is produced after the period closed; selectCohort refuses
 * otherwise, and every test that is not about that refusal uses this.
 */
const NOW = PERIOD_END + 1;

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/**
 * The migrated database every case starts from, built once for this file.
 *
 * Every case here wants the same thing -- a production control plane at head,
 * created at `T0` -- and creating one costs about 87.5ms against about 0.97ms
 * to copy an existing one. Building it once per file and handing each case its
 * own copy keeps the per-case fixture identical while removing the 25 migrations
 * this file used to run.
 */
const productionTemplate = suiteTemplate("production.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/**
 * The source's `db` fixture, as a per-test call (rule 8).
 *
 * Still a fresh, writable database in a fresh per-case directory -- the copy is
 * the case's own file, and nothing here is shared with another case at runtime.
 */
function productionDb(): string {
  return productionTemplate.copyInto(caseRoot("cohort"));
}

type RunRow = readonly [runId: string, status: string, createdAtMs: number, updatedAtMs: number];

/**
 * Insert `(run_id, status, created_at_ms, updated_at_ms)` rows.
 *
 * Through an ordinary writable connection, deliberately: the harness's own
 * handle cannot write, which is the point of it.
 */
function addRuns(path: string, ...rows: readonly RunRow[]): void {
  const connection = new Database(path, { fileMustExist: true });
  try {
    const insert = connection.prepare(
      "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
    );
    for (const [runId, status, createdAtMs, updatedAtMs] of rows) {
      insert.run(runId, status, createdAtMs, updatedAtMs);
    }
  } finally {
    connection.close();
  }
}

function cohortOf(
  path: string,
  options: {
    periodStartMs?: number;
    periodEndMs?: number;
    nowMs?: number;
    v1ShadowRunIds?: readonly string[];
  } = {},
): RunCohort {
  const connection = openForMeasurement(path);
  try {
    return selectCohort(connection, {
      periodStartMs: options.periodStartMs ?? PERIOD_START,
      periodEndMs: options.periodEndMs ?? PERIOD_END,
      nowMs: options.nowMs ?? NOW,
      ...(options.v1ShadowRunIds === undefined ? {} : { v1ShadowRunIds: options.v1ShadowRunIds }),
    });
  } finally {
    connection.close();
  }
}

/**
 * Remove the `status IN (...)` CHECK, to build a row this build cannot read.
 *
 * Interlock `D-0041` closed that set in DDL, so a status outside it is
 * unreachable through the schema -- which is exactly why
 * `terminal_status_unknown` should stay empty. Proving the bucket still *works*
 * therefore requires forging the condition it watches for: a database written by
 * a build with a wider vocabulary, or a CHECK dropped by hand.
 * `writable_schema` is how that is reproduced without shipping a second schema.
 *
 * `unsafeMode` is needed where the source needs nothing: better-sqlite3 enables
 * SQLITE_DBCONFIG_DEFENSIVE by default, which refuses a direct write to
 * `sqlite_master` even under `PRAGMA writable_schema = ON`, while Python's
 * `sqlite3` has no defensive mode. The testkit's `rawConnection` lowers it for
 * the same reason.
 */
function widenTheStatusCheck(path: string): void {
  const connection = new Database(path, { fileMustExist: true });
  connection.unsafeMode(true);
  try {
    const row = connection
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run'",
      )
      .get();
    if (row === undefined) {
      expect.fail("the run table must exist");
    }
    const widened = row.sql.replace(/,\s*CHECK \(status IN \([^)]*\)\)/, "");
    expect(widened, "the CHECK clause was not found to remove").not.toBe(row.sql);
    connection.pragma("writable_schema = ON");
    connection
      .prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'run'")
      .run(widened);
    connection.pragma("writable_schema = OFF");
  } finally {
    connection.close();
  }
}

/** `cohort.excluded.get(reason)`, narrowed. */
function excluded(cohort: RunCohort, reason: string): readonly string[] {
  return cohort.excluded.get(reason) ?? expect.fail(`no bucket ${reason}`);
}

/** `excludedCounts()` as a plain object, for whole-mapping assertions. */
function countsOf(cohort: RunCohort): Record<string, number> {
  return Object.fromEntries(cohort.excludedCounts());
}

/** Every reason at zero -- what an untouched period reports. */
function allZero(): Record<string, number> {
  return Object.fromEntries(EXCLUDED_REASONS.map((reason) => [reason, 0]));
}

// --------------------------------------------------------------------------
// the vocabulary is the schema's, not a copy that drifts
// --------------------------------------------------------------------------

describe("the vocabulary is the schema's", () => {
  test("the known statuses are exactly the run table's own check", () => {
    // The module keeps a list of status names, and the whole meaning of
    // `terminal_status_unknown` rests on that list being the schema's set. A
    // test asserting the list against a second hand-written list would agree
    // with itself forever, so this one reads the DDL that shipped.
    const db = productionDb();
    const connection = openForMeasurement(db);
    let sql: string;
    try {
      const row = connection
        .prepare<[], { sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run'",
        )
        .get();
      if (row === undefined) {
        expect.fail("the run table must exist");
      }
      sql = row.sql;
    } finally {
      connection.close();
    }
    const clause = /CHECK \(status IN \(([^)]*)\)\)/.exec(sql);
    expect(clause).not.toBeNull();
    const inDdl = [...(clause?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect(new Set(inDdl)).toEqual(new Set(KNOWN_RUN_STATUSES));
  });
});

// --------------------------------------------------------------------------
// the terminal instant, and the derivation it rests on
// --------------------------------------------------------------------------

describe("the terminal instant", () => {
  test("the terminal instant is updated_at for a terminal run", () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      expect(terminalInstantMs(status, T0 + 5)).toBe(T0 + 5);
    }
  });

  test("a run that has not terminated has no terminal instant", () => {
    for (const status of ["created", "running", "suspended"]) {
      expect(terminalInstantMs(status, T0 + 5)).toBeNull();
    }
  });

  test("an unknown status is refused rather than read as in flight", () => {
    // Neither answer is available, so neither is invented. Returning `null`
    // would be the convenient default and it is the dangerous one: it files the
    // run as in flight, and a database whose CHECK this build does not share
    // would report as an ordinary period with some long-running work in it.
    expectRefusal(() => terminalInstantMs("zombie", T0), UnknownRunStatusRefused);
  });
});

// --------------------------------------------------------------------------
// both ends of the half-open period
// --------------------------------------------------------------------------

describe("both ends of the half-open period", () => {
  test("a run created exactly at the period start is in the cohort", () => {
    // `[start, end)` includes its start instant (time-base-policy.md 2.4).
    const db = productionDb();
    addRuns(db, ["on-start", "completed", PERIOD_START, PERIOD_START + 10]);
    expect(cohortOf(db).runIds).toEqual(["on-start"]);
  });

  test("a run created one millisecond before the start is excluded", () => {
    // The neighbouring instant is on the other side, and the bucket says why.
    const db = productionDb();
    addRuns(db, ["just-before", "completed", PERIOD_START - 1, PERIOD_START + 10]);
    const result = cohortOf(db);
    expect(result.runIds).toEqual([]);
    expect(excluded(result, STARTED_BEFORE_PERIOD)).toEqual(["just-before"]);
  });

  test("a run terminal one millisecond before the end is in the cohort", () => {
    const db = productionDb();
    addRuns(db, ["just-inside", "completed", PERIOD_START + 1, PERIOD_END - 1]);
    expect(cohortOf(db).runIds).toEqual(["just-inside"]);
  });

  test("a run terminal exactly at the period end is excluded", () => {
    // `[start, end)` excludes its end instant, so this run is not yet done.
    // "Terminal *before* period_end_ms" is the wording of section 2.1, and a
    // closed upper end would put this run in two consecutive periods.
    const db = productionDb();
    addRuns(db, ["on-end", "completed", PERIOD_START + 1, PERIOD_END]);
    const result = cohortOf(db);
    expect(result.runIds).toEqual([]);
    expect(excluded(result, IN_FLIGHT_AT_PERIOD_END)).toEqual(["on-end"]);
  });

  test("a run created exactly at the period end belongs to the next period", () => {
    const db = productionDb();
    addRuns(db, ["next-period", "running", PERIOD_END, PERIOD_END]);
    const result = cohortOf(db);
    expect(result.runIds).toEqual([]);
    expect(countsOf(result)).toEqual(allZero());
  });
});

// --------------------------------------------------------------------------
// the distinction section 2.1 insists on
// --------------------------------------------------------------------------

describe("the distinction section 2.1 insists on", () => {
  test("terminal in the period but started before it is not the cohort", () => {
    // The case that separates "entire lifetime" from "terminal in period".
    // Under the rejected reading this run is in the denominator; under D-0038
    // it is an exclusion with a reason, because its prompts lie on both sides
    // of the boundary and counting it puts a whole run against a partial
    // numerator.
    const db = productionDb();
    addRuns(db, ["crosses-in", "completed", PERIOD_START - DAY_MS, PERIOD_START + 60]);
    const result = cohortOf(db);
    expect(result.runIds).toEqual([]);
    expect(result.denominator).toBe(0);
    expect(excluded(result, STARTED_BEFORE_PERIOD)).toEqual(["crosses-in"]);
    expect(excluded(result, IN_FLIGHT_AT_PERIOD_END)).toEqual([]);
  });

  test("a run still in flight is bucketed, not counted", () => {
    // Right-censoring: it has produced some of its prompts and not the rest.
    const db = productionDb();
    addRuns(
      db,
      ["still-running", "running", PERIOD_START + 5, PERIOD_END - 5],
      ["still-suspended", "suspended", PERIOD_START + 5, PERIOD_END - 5],
      ["never-started", "created", PERIOD_START + 5, PERIOD_START + 5],
    );
    const result = cohortOf(db);
    expect(result.runIds).toEqual([]);
    expect(excluded(result, IN_FLIGHT_AT_PERIOD_END)).toEqual([
      "never-started",
      "still-running",
      "still-suspended",
    ]);
  });

  test("a run spanning the whole period is in flight at its end", () => {
    // Two reasons apply; the stated order files it under the heavier one.
    const db = productionDb();
    addRuns(db, ["spans", "completed", PERIOD_START - 10, PERIOD_END + 10]);
    const result = cohortOf(db);
    expect(excluded(result, IN_FLIGHT_AT_PERIOD_END)).toEqual(["spans"]);
    expect(excluded(result, STARTED_BEFORE_PERIOD)).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// runs the report has nothing to say about
// --------------------------------------------------------------------------

describe("runs the report has nothing to say about", () => {
  test("a run wholly outside the period appears nowhere", () => {
    // Not in the cohort and not in a bucket: it never overlapped the window. A
    // bucket entry is the statement "the report considered this run and set it
    // aside", which would be a false statement here, and a bucket that filled
    // up with the entire history of the database would bury the exclusions that
    // do matter.
    const db = productionDb();
    addRuns(
      db,
      ["ancient", "completed", PERIOD_START - 10 * DAY_MS, PERIOD_START - DAY_MS],
      ["ended-on-the-start-boundary", "completed", PERIOD_START - DAY_MS, PERIOD_START - 1],
      ["future", "completed", PERIOD_END + DAY_MS, PERIOD_END + 2 * DAY_MS],
    );
    const result = cohortOf(db, { nowMs: PERIOD_END + 10 * DAY_MS });
    expect(result.runIds).toEqual([]);
    expect(countsOf(result)).toEqual(allZero());
  });
});

// --------------------------------------------------------------------------
// the partition property
// --------------------------------------------------------------------------

describe("the partition property", () => {
  test("every touching run lands in exactly one place", () => {
    // Cohort plus buckets account for every touching run, once each. Built to
    // hit every branch in one population, because the property under test is
    // about the classification as a whole: a run falling out of the bottom of
    // the loop, or counted twice by two overlapping predicates, is invisible to
    // any single-branch test.
    const db = productionDb();
    const rows: readonly RunRow[] = [
      ["a-inside", "completed", PERIOD_START, PERIOD_END - 1],
      ["b-inside-failed", "failed", PERIOD_START + 1, PERIOD_START + 2],
      ["c-inside-cancelled", "cancelled", PERIOD_START + 3, PERIOD_START + 4],
      ["d-crosses-in", "completed", PERIOD_START - 1, PERIOD_START + 4],
      ["e-crosses-out", "completed", PERIOD_START + 1, PERIOD_END],
      ["f-running", "running", PERIOD_START + 1, PERIOD_START + 9],
      ["g-spans", "completed", PERIOD_START - DAY_MS, PERIOD_END + DAY_MS],
      ["h-terminal-on-start", "completed", PERIOD_START - DAY_MS, PERIOD_START],
      ["x-before", "completed", PERIOD_START - DAY_MS, PERIOD_START - 1],
      ["y-after", "created", PERIOD_END, PERIOD_END],
    ];
    addRuns(db, ...rows);
    widenTheStatusCheck(db);
    const unknownRow: RunRow = ["i-unknown", "zombie", PERIOD_START + 1, PERIOD_START + 2];
    addRuns(db, unknownRow);

    const result = cohortOf(db, { nowMs: PERIOD_END + DAY_MS + 1 });

    const touching = new Set(
      [...rows, unknownRow]
        .filter(([, status, created, updated]) =>
          touchesPeriod(status, created, updated, {
            periodStartMs: PERIOD_START,
            periodEndMs: PERIOD_END,
          }),
        )
        .map(([runId]) => runId),
    );
    expect(touching).toEqual(
      new Set([
        "a-inside",
        "b-inside-failed",
        "c-inside-cancelled",
        "d-crosses-in",
        "e-crosses-out",
        "f-running",
        "g-spans",
        "h-terminal-on-start",
        "i-unknown",
      ]),
    );

    const placed = [...result.runIds];
    for (const reason of EXCLUDED_REASONS) {
      placed.push(...excluded(result, reason));
    }
    // No omission, and -- because a list is compared against a set of the same
    // length -- no double counting either.
    expect(placed).toHaveLength(touching.size);
    expect(new Set(placed)).toEqual(touching);

    expect(result.runIds).toEqual(["a-inside", "b-inside-failed", "c-inside-cancelled"]);
    expect(excluded(result, IN_FLIGHT_AT_PERIOD_END)).toEqual([
      "e-crosses-out",
      "f-running",
      "g-spans",
    ]);
    expect(excluded(result, STARTED_BEFORE_PERIOD)).toEqual([
      "d-crosses-in",
      "h-terminal-on-start",
    ]);
    expect(excluded(result, TERMINAL_STATUS_UNKNOWN)).toEqual(["i-unknown"]);
  });
});

// --------------------------------------------------------------------------
// the buckets are always emitted
// --------------------------------------------------------------------------

describe("the buckets are always emitted", () => {
  test("all four buckets are emitted over an empty database", () => {
    // A zero and a missing key are different statements to a reader. Only one
    // of them is true of a report that ran the check and found nothing.
    const db = productionDb();
    const result = cohortOf(db);
    expect([...result.excluded.keys()]).toEqual([...EXCLUDED_REASONS]);
    for (const reason of EXCLUDED_REASONS) {
      expect(excluded(result, reason)).toEqual([]);
    }
    expect(countsOf(result)).toEqual(allZero());
  });

  test("terminal_status_unknown is a schema-integrity signal", () => {
    // Non-zero only when a status escaped the CHECK D-0041 closed.
    const db = productionDb();
    addRuns(db, ["ok", "completed", PERIOD_START, PERIOD_START + 1]);
    widenTheStatusCheck(db);
    addRuns(db, ["weird", "half-done", PERIOD_START, PERIOD_START + 1]);
    const result = cohortOf(db);
    expect(result.runIds).toEqual(["ok"]);
    expect(excluded(result, TERMINAL_STATUS_UNKNOWN)).toEqual(["weird"]);
  });
});

// --------------------------------------------------------------------------
// ownership: asserted, never derived
// --------------------------------------------------------------------------

describe("ownership is asserted, never derived", () => {
  test("v1_owned is empty without a shadow input, however many runs exist", () => {
    // D-0013 leaves no v1-owned run in this database to find. An empty bucket
    // here is the honest answer for a report with no shadow input, and any
    // non-empty one would mean the harness invented the distinction the schema
    // deliberately does not carry.
    const db = productionDb();
    addRuns(
      db,
      ["one", "completed", PERIOD_START, PERIOD_START + 1],
      ["two", "running", PERIOD_START, PERIOD_START + 1],
    );
    expect(excluded(cohortOf(db), V1_OWNED)).toEqual([]);
  });

  test("v1_owned is populated only from the supplied shadow input", () => {
    const db = productionDb();
    addRuns(db, ["ours", "completed", PERIOD_START, PERIOD_START + 1]);
    const result = cohortOf(db, { v1ShadowRunIds: ["v1-b", "v1-a", "v1-a"] });
    expect(excluded(result, V1_OWNED)).toEqual(["v1-a", "v1-b"]);
    expect(result.runIds).toEqual(["ours"]);
  });

  test("a shadow id this database also holds is refused", () => {
    // One run claimed by two systems contradicts D-0013's run-boundary cutover.
    // Excluding the row quietly would shrink the denominator with nothing
    // anywhere saying why, which is the class of silent movement this module
    // exists to prevent.
    const db = productionDb();
    addRuns(db, ["disputed", "completed", PERIOD_START, PERIOD_START + 1]);
    const refusal = expectRefusal(
      () => cohortOf(db, { v1ShadowRunIds: ["disputed"] }),
      OwnershipAssertionRefused,
    );
    expect(refusal.message).toContain("disputed");
  });
});

// --------------------------------------------------------------------------
// the period bounds themselves
// --------------------------------------------------------------------------

describe("the period bounds themselves", () => {
  test("a period that has not ended is refused", () => {
    // The same report run again later would move runs into the denominator.
    const db = productionDb();
    expectRefusal(() => cohortOf(db, { nowMs: PERIOD_END - 1 }), PeriodNotClosedRefused);
  });

  test("the instant the period closes is already reportable", () => {
    // `nowMs === periodEndMs` is closed: the window is half-open at the end.
    const db = productionDb();
    expect(cohortOf(db, { nowMs: PERIOD_END }).runIds).toEqual([]);
  });

  test("an empty or inverted period is refused", () => {
    const db = productionDb();
    expectRefusal(() => cohortOf(db, { periodEndMs: PERIOD_START }), PeriodNotClosedRefused);
    expectRefusal(
      () => cohortOf(db, { periodStartMs: PERIOD_END, periodEndMs: PERIOD_START }),
      PeriodNotClosedRefused,
    );
  });
});

// --------------------------------------------------------------------------
// Target-only: three properties a mutation sweep found unguarded. All three are
// INHERITED -- interlock's own suite cannot tell the mutated module from the
// real one either. Production behaviour is unchanged; these add coverage.
// --------------------------------------------------------------------------

describe("properties the ported cases leave unguarded (target-only)", () => {
  test("the published query text carries the period-end bound", () => {
    // Target-only. Deleting the WHERE clause from COHORT_RUNS_QUERY changes no
    // verdict, because touchesPeriod independently refuses a run created at or
    // after the period end -- so the mutation is BEHAVIOURALLY equivalent and no
    // ported case can see it, on either side.
    //
    // It is not equivalent for the artefact that matters here. The query text is
    // exported and lands in the report's provenance header (section 6), where it
    // is what a reader re-runs by hand; the module's own comment states that
    // this bound "is the only bound SQL carries". A header quoting a query with
    // no window would hand that reader a different result set than the report
    // was computed from.
    expect(COHORT_RUNS_QUERY).toContain("created_at_ms < :period_end_ms");
    expect(COHORT_RUNS_QUERY).toContain("ORDER BY run_id");
  });

  test("a shadow input past SQLite's parameter ceiling is chunked, not refused", () => {
    // Target-only. The chunking exists because the shadow input is a list of
    // whatever length v1 hands over, and interlock's own tests -- like these
    // ported ones -- never pass more than a handful, so removing it changes
    // nothing they can see.
    //
    // The ceiling is real and measured on this build: a single IN list of 32,766
    // bound parameters succeeds and 32,767 fails with SQLITE_ERROR. (The
    // source's comment says 999, which was SQLite's older default; the guard is
    // right either way and the chunk size of 500 is well under both.) Without
    // chunking, this call throws instead of returning a cohort.
    const db = productionDb();
    addRuns(db, ["ours", "completed", PERIOD_START, PERIOD_START + 1]);
    const many = Array.from({ length: 33_000 }, (_, index) => `v1-${index}`);

    const result = cohortOf(db, { v1ShadowRunIds: many });
    expect(result.runIds).toEqual(["ours"]);
    expect(excluded(result, V1_OWNED)).toHaveLength(33_000);
    // ...and a collision anywhere in that input is still found, so the chunking
    // did not quietly stop checking the tail.
    const withCollision = [...many, "ours"];
    expectRefusal(() => cohortOf(db, { v1ShadowRunIds: withCollision }), OwnershipAssertionRefused);
  });

  test("the denominator counts the cohort and nothing else", () => {
    // Target-only. `denominator` is asserted once in the ported cases, in a
    // population where the in-flight bucket happens to be empty -- so inflating
    // it by that bucket's length changes no assertion. Interlock's case is the
    // same one.
    //
    // The denominator is AC-9's divisor, and inflating it with right-censored
    // runs is the precise defect section 2.1's cohort definition exists to
    // prevent, so it deserves a population where the two differ.
    const db = productionDb();
    addRuns(
      db,
      ["in-cohort", "completed", PERIOD_START, PERIOD_START + 1],
      ["in-flight", "running", PERIOD_START, PERIOD_START + 1],
      ["also-in-flight", "completed", PERIOD_START, PERIOD_END],
    );
    const result = cohortOf(db);

    expect(result.runIds).toEqual(["in-cohort"]);
    expect(excluded(result, IN_FLIGHT_AT_PERIOD_END)).toEqual(["also-in-flight", "in-flight"]);
    expect(result.denominator, "the excluded runs are not in the divisor").toBe(1);
  });
});

// --------------------------------------------------------------------------
// the instrument does not disturb what it measures
// --------------------------------------------------------------------------

describe("the instrument does not disturb what it measures", () => {
  test("selecting the cohort writes nothing", () => {
    // Read-only is the connection's capability; this proves the module uses it.
    // A write attempted through the harness handle would raise rather than
    // land, so a green run of the tests above is already evidence -- this
    // asserts the file's bytes directly so the evidence does not depend on that
    // inference.
    const db = productionDb();
    addRuns(db, ["one", "completed", PERIOD_START, PERIOD_START + 1]);
    const before = readFileSync(db);
    cohortOf(db, { v1ShadowRunIds: ["v1-a"] });
    expect(readFileSync(db).equals(before)).toBe(true);
  });
});
