/**
 * Both half-open ends, grace proved to be data, and the two censored buckets
 * kept apart.
 *
 * Ported from interlock `tests/measurement/test_windows.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping, and the cases that are
 * adapted rather than translated straight, are recorded in
 * `parity/measurement.windows.ledger.json`.
 *
 * The defect `windows.ts` exists to prevent is invisible to a suite whose
 * episodes sit comfortably inside the period: every classifier, right or wrong,
 * calls those `in_period`. So every boundary case here is driven **to the
 * instant** -- an episode whose window ends exactly at `PERIOD_END` and the same
 * episode one millisecond later, an onset exactly at `PERIOD_START` and one
 * millisecond before -- because a `<` written as a `<=` moves exactly one
 * episode per report and shows up nowhere else.
 *
 * Two properties get adversarial treatment beyond the boundaries:
 *
 * * **Grace is data.** A hardcoded 120 s would pass every classification test in
 *   this file. It is caught by changing the *revision*'s `reconcile_period_ms`
 *   and asserting the same episode, over the same period, changes bucket --
 *   which no constant can do.
 * * **A relative class resolves through its subject.** `lease_orphan`'s `L` is
 *   twice *that lease's* TTL, so the test builds two leases with different TTLs
 *   and asserts two different windows, and separately asserts that an episode
 *   with no subject is **refused**. A default there would produce a
 *   two-millisecond window, which is the failure that looks like a detector
 *   missing everything.
 *
 * Nothing here re-implements the classification to compare against. Where a test
 * needs to know how long a window is, it reads `L` out of the same
 * `policy_detection_latency` row the module reads and does arithmetic the module
 * does not: the expected bucket is then stated by hand.
 */

import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import {
  detectionLatency,
  resolveToleranceMs,
  subjectUnitMs,
} from "../../src/control_plane/policy.js";
import { openForMeasurement } from "../../src/measurement/reader.js";
import {
  CENSORED,
  CENSORED_LEFT,
  classifyEpisodes,
  DuplicateEpisodeRefused,
  defaultGraceMs,
  Episode,
  EpisodeOutsidePeriod,
  type EpisodeWindow,
  episodeWindow,
  GRACE_DECLARED,
  GRACE_REVISION_RECONCILE_PERIOD,
  GraceNotDeclared,
  IN_PERIOD,
  PeriodRefused,
  resolveBudgetMs,
  SubjectRequired,
  WINDOW_CLASSIFICATIONS,
  WindowRefusal,
  type WindowReport,
} from "../../src/measurement/windows.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const PERIOD_START = T0;
const PERIOD_END = T0 + DAY_MS;

/**
 * The note `0002_policy_seed.sql` writes. Looked up by note rather than assumed
 * to be revision 1, so these tests survive a later seed step.
 */
const SEED_NOTE =
  "initial time base: detection latency budgets, gate stage tolerances " +
  "and gate stage owners as first decided";

/**
 * An absolute-`L` class with room on both sides: T = 10 min, L = 15 min
 * (`time-base-policy.md` section 3.2). Used wherever the test is about the
 * window boundary rather than about resolution.
 */
const ABSOLUTE_CLASS = "session_no_evidence";

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/** The source's `db` fixture, as a per-test call (rule 8). */
function productionDb(): string {
  const path = join(caseRoot("windows"), "production.sqlite3");
  createProductionControlPlane(path, { nowMs: T0 }).close();
  return path;
}

/**
 * An ordinary writable handle -- deliberately not the harness's.
 *
 * The harness's own connection cannot write (`reader.ts`), which is the property
 * under test everywhere else in this package, so fixtures are built through a
 * second connection rather than by relaxing that one.
 */
function withWritable<T>(path: string, body: (connection: SqliteDatabase) => T): T {
  const connection = new Database(path, { fileMustExist: true });
  try {
    return body(connection);
  } finally {
    connection.close();
  }
}

/** Read through the harness's read-only handle, and close it afterwards. */
function withMeasurement<T>(path: string, body: (connection: SqliteDatabase) => T): T {
  const connection = openForMeasurement(path);
  try {
    return body(connection);
  } finally {
    connection.close();
  }
}

function seedRevisionId(path: string): number {
  return withWritable(path, (connection) => {
    const row = connection
      .prepare<[string], { revision_id: number }>(
        "SELECT revision_id FROM policy_revision WHERE note = ?",
      )
      .get(SEED_NOTE);
    // Narrowed with a throw rather than an `expect(...).toBeDefined()` plus a
    // cast: `expect` does not narrow, so the cast would survive an edit that
    // removed the assertion.
    if (row === undefined) {
      expect.fail("0002_policy_seed.sql must have applied");
    }
    return Number(row.revision_id);
  });
}

/**
 * `L` as the policy row states it, so onsets are positioned from data.
 *
 * Read through `detectionLatency` -- the same row the module reads -- rather
 * than typed in, so that a test asserting "this window ends exactly at the
 * period end" keeps meaning that if the seed's numbers change.
 */
function budgetMsOf(path: string, revisionId: number, incidentClass: string): number {
  const row = withMeasurement(path, (connection) =>
    detectionLatency(connection, { revisionId, incidentClass }),
  );
  expect(
    row.budgetKind,
    "budgetMsOf is for absolute-L classes; a relative L is not a duration until " +
      "a subject is named",
  ).toBe("absolute_ms");
  return Number(row.budgetMs);
}

function reportOver(
  path: string,
  revisionId: number,
  episodes: readonly Episode[],
  options: {
    graceMs?: number;
    periodStartMs?: number;
    periodEndMs?: number;
  } = {},
): WindowReport {
  return withMeasurement(path, (connection) =>
    classifyEpisodes(connection, {
      revisionId,
      periodStartMs: options.periodStartMs ?? PERIOD_START,
      periodEndMs: options.periodEndMs ?? PERIOD_END,
      episodes,
      graceMs: options.graceMs,
    }),
  );
}

function windowFor(
  path: string,
  revisionId: number,
  episode: Episode,
  graceMs: number,
): EpisodeWindow {
  return withMeasurement(path, (connection) =>
    episodeWindow(connection, {
      revisionId,
      episode,
      graceMs,
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
    }),
  );
}

function addRevision(path: string, options: { note: string; effectiveAtMs: number }): number {
  return withWritable(path, (connection) => {
    const info = connection
      .prepare(
        "INSERT INTO policy_revision (note, decided_by, effective_at_ms) VALUES (?, 'D-test', ?)",
      )
      .run(options.note, options.effectiveAtMs);
    return Number(info.lastInsertRowid);
  });
}

function addDetectionLatency(
  path: string,
  revisionId: number,
  incidentClass: string,
  options: {
    thresholdKind?: string;
    thresholdValue: number;
    reconcilePeriodMs: number;
    budgetMs: number;
    budgetKind?: string;
  },
): void {
  withWritable(path, (connection) => {
    connection
      .prepare(
        `INSERT INTO policy_detection_latency
             (revision_id, incident_class, threshold_kind, threshold_value,
              reconcile_period_ms, budget_ms, budget_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revisionId,
        incidentClass,
        options.thresholdKind ?? "absolute_ms",
        options.thresholdValue,
        options.reconcilePeriodMs,
        options.budgetMs,
        options.budgetKind ?? "absolute_ms",
      );
  });
}

function addLease(path: string, resource: string, options: { ttlMs: number }): string {
  withWritable(path, (connection) => {
    connection
      .prepare(
        "INSERT INTO lease (resource, holder, epoch, acquired_at_ms, expires_at_ms)" +
          " VALUES (?, 'watcher-a', 1, ?, ?)",
      )
      .run(resource, T0, T0 + options.ttlMs);
  });
  return resource;
}

function addScope(path: string, scopeId: string, options: { expectedIntervalMs: number }): string {
  withWritable(path, (connection) => {
    connection
      .prepare(
        `INSERT OR IGNORE INTO repository
             (repo_id, provider, provider_repo_id, owner, name,
              created_at_ms, updated_at_ms)
         VALUES ('repo-1', 'github', NULL, 'acme', 'widget', ?, ?)`,
      )
      .run(T0, T0);
    connection
      .prepare(
        `INSERT INTO watcher_scope
             (scope_id, scope_kind, repo_id, pr_id, expected_interval_ms,
              enabled, registered_at_ms, retired_at_ms)
         VALUES (?, 'ci_repository', 'repo-1', NULL, ?, 1, ?, NULL)`,
      )
      .run(scopeId, options.expectedIntervalMs, T0);
  });
  return scopeId;
}

/** `report.counts()` as a plain object, for whole-mapping assertions. */
function countsOf(report: WindowReport): Record<string, number> {
  return Object.fromEntries(report.counts());
}

// --------------------------------------------------------------------------
// half-openness, at both ends, to the millisecond
// --------------------------------------------------------------------------

describe("half-openness, at both ends", () => {
  test("window ending exactly at period end is in period", () => {
    // `endMs === PERIOD_END` is inside: the window's last instant is end - 1.
    // Both intervals are half-open (time-base-policy.md section 2, rule 4), so
    // a window that ends where the period ends was wholly observed. Judging it
    // censored would discard a complete observation -- the exact
    // over-correction that makes the censored bucket meaningless.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const graceMs = 0;
    const onset = PERIOD_END - budgetMsOf(db, revisionId, ABSOLUTE_CLASS) - graceMs;

    const window = windowFor(db, revisionId, new Episode("e", ABSOLUTE_CLASS, onset), graceMs);

    expect(window.endMs).toBe(PERIOD_END);
    expect(window.classification).toBe(IN_PERIOD);
  });

  test("window ending one ms past period end is censored", () => {
    // One millisecond later, the same episode is right-censored. Paired with
    // the test above on purpose: either assertion alone passes under a
    // classifier off by one in the direction the other catches.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const graceMs = 0;
    const onset = PERIOD_END - budgetMsOf(db, revisionId, ABSOLUTE_CLASS) - graceMs + 1;

    const window = windowFor(db, revisionId, new Episode("e", ABSOLUTE_CLASS, onset), graceMs);

    expect(window.endMs).toBe(PERIOD_END + 1);
    expect(window.classification).toBe(CENSORED);
    expect(window.censored).toBe(true);
  });

  test("onset exactly at period start is in period", () => {
    // The period's first instant is inside it, so an onset there is not
    // censored.
    const db = productionDb();
    const revisionId = seedRevisionId(db);

    const window = windowFor(db, revisionId, new Episode("e", ABSOLUTE_CLASS, PERIOD_START), 0);

    expect(window.classification).toBe(IN_PERIOD);
  });

  test("onset one ms before period start is censored left", () => {
    // The mirror boundary: an onset the report did not observe is
    // `censored_left`. Its window still lies inside the period, which is
    // precisely why this case needs its own bucket -- a classifier that only
    // checked the window's end would call it `in_period` and then compute a
    // latency from an onset it never saw.
    const db = productionDb();
    const revisionId = seedRevisionId(db);

    const window = windowFor(db, revisionId, new Episode("e", ABSOLUTE_CLASS, PERIOD_START - 1), 0);

    expect(window.endMs, "the window itself is inside the period").toBeLessThan(PERIOD_END);
    expect(window.classification).toBe(CENSORED_LEFT);
    expect(window.censored).toBe(true);
  });

  test("episode spanning the whole period is censored left", () => {
    // Censored at both ends lands in exactly one bucket, and it is the left
    // one. An episode can only be counted once. Left wins because a window with
    // an unobserved onset has no trustworthy latency at all, whereas a
    // right-censored one merely has an unfinished budget.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const longWindow = PERIOD_END - PERIOD_START + 10;

    const window = windowFor(
      db,
      revisionId,
      new Episode("e", ABSOLUTE_CLASS, PERIOD_START - 1),
      longWindow,
    );

    expect(window.endMs).toBeGreaterThan(PERIOD_END);
    expect(window.classification).toBe(CENSORED_LEFT);
  });
});

// --------------------------------------------------------------------------
// grace is read from the revision, and a constant cannot do this
// --------------------------------------------------------------------------

describe("grace is read from the revision", () => {
  test("grace defaults to the revision reconcile period", () => {
    const db = productionDb();
    const revisionId = seedRevisionId(db);

    const report = reportOver(db, revisionId, []);

    const expected = withMeasurement(db, (connection) =>
      defaultGraceMs(connection, { revisionId }),
    );
    expect(report.graceMs).toBe(expected);
    expect(report.graceSource).toBe(GRACE_REVISION_RECONCILE_PERIOD);
  });

  test("changing the revision's reconcile period changes the classification", () => {
    // The same episode, the same period, a different revision -- a different
    // bucket. This is the test a hardcoded 120 s cannot pass. The second
    // revision keeps `L` identical and moves only `reconcile_period_ms`, so the
    // *only* thing that can move the episode across the boundary is grace
    // having been read from policy data (interlock D-0031: the numbers live in
    // versioned rows so a past report recomputes under the numbers it was
    // judged by).
    const db = productionDb();
    const seeded = seedRevisionId(db);
    const { seededGrace, row } = withMeasurement(db, (connection) => ({
      seededGrace: defaultGraceMs(connection, { revisionId: seeded }),
      row: detectionLatency(connection, {
        revisionId: seeded,
        incidentClass: ABSOLUTE_CLASS,
      }),
    }));
    const budgetMs = Number(row.budgetMs);
    const widerGrace = seededGrace + 60_000;

    const coarser = addRevision(db, { note: "a coarser pass", effectiveAtMs: T0 + 1 });
    addDetectionLatency(db, coarser, ABSOLUTE_CLASS, {
      thresholdValue: Number(row.thresholdValue),
      reconcilePeriodMs: widerGrace,
      budgetMs,
    });

    // Positioned to end exactly at the period end under the seeded grace.
    const onset = PERIOD_END - budgetMs - seededGrace;
    const episodes = [new Episode("e", ABSOLUTE_CLASS, onset)];

    const underSeed = reportOver(db, seeded, episodes);
    const underCoarser = reportOver(db, coarser, episodes);

    expect(underSeed.graceMs).toBe(seededGrace);
    expect(underCoarser.graceMs).toBe(widerGrace);
    expect(countsOf(underSeed)).toEqual({
      [IN_PERIOD]: 1,
      [CENSORED]: 0,
      [CENSORED_LEFT]: 0,
    });
    expect(countsOf(underCoarser)).toEqual({
      [IN_PERIOD]: 0,
      [CENSORED]: 1,
      [CENSORED_LEFT]: 0,
    });
  });

  test("declared grace is used and recorded as declared", () => {
    // A caller-declared grace overrides the default and says so on the report.
    // Interlock D-0040 makes the value part of the report because the
    // classification cannot be recomputed without it.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const budgetMs = budgetMsOf(db, revisionId, ABSOLUTE_CLASS);

    const report = reportOver(db, revisionId, [new Episode("e", ABSOLUTE_CLASS, PERIOD_START)], {
      graceMs: 7,
    });

    expect(report.graceSource).toBe(GRACE_DECLARED);
    expect(report.graceMs).toBe(7);
    expect(report.windows[0]?.endMs).toBe(PERIOD_START + budgetMs + 7);
  });

  test("a revision with two reconcile periods refuses to default", () => {
    // "One reconcile period" names no single value when the revision has two.
    // Section 3.3 permits a class to run on a coarser pass, and section 3.5
    // wants one grace per report. Choosing between them here would be this file
    // deciding policy: the smaller manufactures misses for the coarse class,
    // the larger excuses real ones for the tight classes. The caller declares
    // instead -- and declaring still works, which the second half asserts so
    // the refusal is not a dead end.
    const db = productionDb();
    const revisionId = addRevision(db, { note: "two periods", effectiveAtMs: T0 + 1 });
    addDetectionLatency(db, revisionId, "relay_gap", {
      thresholdValue: 180_000,
      reconcilePeriodMs: 120_000,
      budgetMs: 300_000,
    });
    addDetectionLatency(db, revisionId, ABSOLUTE_CLASS, {
      thresholdValue: 600_000,
      reconcilePeriodMs: 300_000,
      budgetMs: 900_000,
    });

    expectRefusal(
      () => reportOver(db, revisionId, [new Episode("e", ABSOLUTE_CLASS, PERIOD_START)]),
      GraceNotDeclared,
    );

    const declared = reportOver(db, revisionId, [new Episode("e", ABSOLUTE_CLASS, PERIOD_START)], {
      graceMs: 120_000,
    });
    expect(declared.counts().get(IN_PERIOD)).toBe(1);
  });

  test("negative grace is refused", () => {
    // Grace shortens nothing: a negative value holds the detector past its own
    // budget.
    const db = productionDb();
    const revisionId = seedRevisionId(db);

    expectRefusal(
      () => windowFor(db, revisionId, new Episode("e", ABSOLUTE_CLASS, PERIOD_START), -1),
      WindowRefusal,
    );
  });
});

// --------------------------------------------------------------------------
// relative classes resolve through their subject, or refuse
// --------------------------------------------------------------------------

describe("relative classes resolve through their subject", () => {
  test("relative budget scales with that lease", () => {
    // `lease_orphan`'s L is twice *that lease's* TTL, so two leases give two
    // windows. A single-lease test would pass against a module that resolved
    // the wrong lease, or the first one it found. Two TTLs with a ratio the
    // multiple cannot produce by accident is what binds the window to its own
    // subject.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const short = addLease(db, "watcher/short", { ttlMs: 60_000 });
    const long = addLease(db, "watcher/long", { ttlMs: 300_000 });

    const shortWindow = windowFor(
      db,
      revisionId,
      new Episode("s", "lease_orphan", PERIOD_START, short),
      0,
    );
    const longWindow = windowFor(
      db,
      revisionId,
      new Episode("l", "lease_orphan", PERIOD_START, long),
      0,
    );

    // The seed's multiples: T = 1 x TTL, L = 2 x TTL (0002_policy_seed.sql).
    expect(shortWindow.budgetMs).toBe(2 * 60_000);
    expect(shortWindow.toleranceMs).toBe(60_000);
    expect(longWindow.budgetMs).toBe(2 * 300_000);
    expect(longWindow.toleranceMs).toBe(300_000);
    expect(longWindow.endMs - shortWindow.endMs).toBe(2 * (300_000 - 60_000));
  });

  test("tolerance and budget scale by the same subject unit", () => {
    // T and L of one `lease_orphan` subject come from ONE unit lookup.
    // `lease_orphan` is relative on both sides, so this is the only class where
    // the two resolvers can disagree: `resolveToleranceMs` scales T and
    // `resolveBudgetMs` scales L, and interlock D-0041 narrowed the DDL's
    // `T + P <= L` CHECK to absolute rows on the promise that the relative rows
    // are asserted per subject instead -- which is an inequality between two
    // numbers only while both were scaled by the same unit.
    //
    // The TTL here is deliberately not a round number: dividing each resolved
    // side by its own multiple recovers the unit each side actually used, so a
    // second copy of the lookup that drifted to a different lease, a different
    // column, or a stale TTL fails this rather than passing quietly in
    // whichever direction it drifted. The multiples are read from the policy
    // row, never typed in.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const ttlMs = 137_000;
    const resource = addLease(db, "watcher/shared-unit", { ttlMs });

    const { row, toleranceMs, budgetMs, unitThePublicLookupGives } = withMeasurement(
      db,
      (connection) => {
        const policyRow = detectionLatency(connection, {
          revisionId,
          incidentClass: "lease_orphan",
        });
        expect(policyRow.thresholdKind).toBe("lease_ttl_multiple");
        expect(
          policyRow.budgetKind,
          "this test is only meaningful while both sides are relative",
        ).toBe("lease_ttl_multiple");
        return {
          row: policyRow,
          toleranceMs: resolveToleranceMs(connection, {
            revisionId,
            incidentClass: "lease_orphan",
            subject: resource,
          }),
          budgetMs: resolveBudgetMs(connection, {
            revisionId,
            incidentClass: "lease_orphan",
            subject: resource,
          }),
          unitThePublicLookupGives: subjectUnitMs(connection, {
            thresholdKind: "lease_ttl_multiple",
            subject: resource,
          }),
        };
      },
    );

    const thresholdValue = Number(row.thresholdValue);
    const budgetMultiple = Number(row.budgetMs);
    const unitBehindT = Math.floor(toleranceMs / thresholdValue);
    const remainderT = toleranceMs % thresholdValue;
    const unitBehindL = Math.floor(budgetMs / budgetMultiple);
    const remainderL = budgetMs % budgetMultiple;

    expect([remainderT, remainderL]).toEqual([0, 0]);
    expect(
      unitBehindT,
      "T and L were scaled by different subject units; the per-subject " +
        "T + P <= L assertion interlock D-0041 relies on is then comparing two units",
    ).toBe(unitBehindL);
    expect(unitBehindT).toBe(unitThePublicLookupGives);
    expect(unitBehindT).toBe(ttlMs);
  });

  test("relative threshold scales with that scope", () => {
    // `watcher_silence`'s T is three of *that scope's* polls; its L is
    // absolute.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const fast = addScope(db, "scope/fast", { expectedIntervalMs: 30_000 });
    const slow = addScope(db, "scope/slow", { expectedIntervalMs: 60_000 });

    const fastWindow = windowFor(
      db,
      revisionId,
      new Episode("f", "watcher_silence", PERIOD_START, fast),
      0,
    );
    const slowWindow = windowFor(
      db,
      revisionId,
      new Episode("s", "watcher_silence", PERIOD_START, slow),
      0,
    );

    expect(fastWindow.toleranceMs).toBe(3 * 30_000);
    expect(slowWindow.toleranceMs).toBe(3 * 60_000);
    expect(fastWindow.budgetMs, "L here is absolute").toBe(slowWindow.budgetMs);
    expect(fastWindow.endMs).toBe(slowWindow.endMs);
  });

  parametrize(
    "a relative class refuses rather than defaults without a subject",
    [
      ["lease_orphan", "lease_orphan"],
      ["watcher_silence", "watcher_silence"],
    ],
    (incidentClass) => {
      // No subject, no window -- and no fallback to the bare multiple. The
      // fallback available is the multiple itself (2, or 3), which yields a
      // window a few milliseconds long. Every episode of the class would then
      // be right-censored or judged missed, uniformly, with no error anywhere.
      const db = productionDb();
      const revisionId = seedRevisionId(db);
      addLease(db, "watcher/some", { ttlMs: 60_000 });
      addScope(db, "scope/some", { expectedIntervalMs: 30_000 });

      expectRefusal(
        () => windowFor(db, revisionId, new Episode("e", incidentClass, PERIOD_START), 0),
        SubjectRequired,
      );
    },
  );

  test("resolveBudgetMs refuses the relative budget without a subject", () => {
    // The refusal is on the budget resolver itself, not only on the window.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    withMeasurement(db, (connection) => {
      expectRefusal(
        () =>
          resolveBudgetMs(connection, {
            revisionId,
            incidentClass: "lease_orphan",
            subject: null,
          }),
        SubjectRequired,
      );
    });
  });

  test("a count threshold yields no tolerance but still a window", () => {
    // `watcher_error_streak`'s T is a count, and its window is still well
    // defined. `toleranceMs` is `null` and `thresholdKind` says why, so a
    // consumer can tell "a count" from "policy said nothing". Refusing the
    // window over the unavailable side quantity would make the class
    // unmeasurable for a reason unrelated to measuring it -- its L is an
    // absolute 10 minutes.
    const db = productionDb();
    const revisionId = seedRevisionId(db);

    const window = windowFor(
      db,
      revisionId,
      new Episode("e", "watcher_error_streak", PERIOD_START),
      0,
    );

    expect(window.thresholdKind).toBe("consecutive_count");
    expect(window.toleranceMs).toBeNull();
    expect(window.budgetMs).toBe(600_000);
    expect(window.classification).toBe(IN_PERIOD);
  });
});

// --------------------------------------------------------------------------
// the buckets: distinguished, leaking into neither numerator, emitted at zero
// --------------------------------------------------------------------------

describe("the buckets", () => {
  test("censored buckets are distinguished and leak into neither numerator", () => {
    // One episode of each kind: three buckets, one numerator, no overlap. The
    // numerator assertion is the load-bearing one. Section 3.5 excludes a
    // censored episode from the miss numerator **and** the latency numerator,
    // and a module that applied the exclusion to one only would report a
    // latency distribution over episodes it had already agreed it could not
    // judge.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const budgetMs = budgetMsOf(db, revisionId, ABSOLUTE_CLASS);
    const graceMs = 0;

    const episodes = [
      new Episode("inside", ABSOLUTE_CLASS, PERIOD_START + 1_000),
      new Episode("right", ABSOLUTE_CLASS, PERIOD_END - budgetMs - graceMs + 1),
      new Episode("left", ABSOLUTE_CLASS, PERIOD_START - 1),
    ];

    const report = reportOver(db, revisionId, episodes, { graceMs });

    expect(countsOf(report)).toEqual({
      [IN_PERIOD]: 1,
      [CENSORED]: 1,
      [CENSORED_LEFT]: 1,
    });
    expect(report.idsFor(IN_PERIOD)).toEqual(["inside"]);
    expect(report.idsFor(CENSORED)).toEqual(["right"]);
    expect(report.idsFor(CENSORED_LEFT)).toEqual(["left"]);
    expect(report.numeratorIds()).toEqual(["inside"]);

    // Every episode lands in exactly one bucket: the partition is a property of
    // the whole classification, not of any one branch, and a fourth case
    // falling through the bottom of the loop is invisible to the per-branch
    // assertions.
    const filed = WINDOW_CLASSIFICATIONS.flatMap((classification) => report.idsFor(classification));
    expect([...filed].sort()).toEqual(episodes.map((episode) => episode.episodeId).sort());
  });

  test("counts are emitted even at zero", () => {
    // All three keys, always. An absent key reads as "nothing to report". It
    // would mean "this report was produced by code that did not look", and the
    // censored count is the number that makes a too-short period visible -- so
    // a reader diffing two reports must see the zero.
    const db = productionDb();
    const revisionId = seedRevisionId(db);

    const report = reportOver(db, revisionId, []);

    expect(countsOf(report)).toEqual({
      [IN_PERIOD]: 0,
      [CENSORED]: 0,
      [CENSORED_LEFT]: 0,
    });
    expect(new Set(report.counts().keys())).toEqual(new Set(WINDOW_CLASSIFICATIONS));
    expect(report.numeratorIds()).toEqual([]);
  });

  test("an episode outside the period is refused, not censored", () => {
    // Neither filed as censored nor dropped. Filing it censored would inflate
    // the one number that says "this period is too short for these budgets";
    // dropping it would let a selection bug live forever.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const budgetMs = budgetMsOf(db, revisionId, ABSOLUTE_CLASS);

    expectRefusal(
      () =>
        reportOver(db, revisionId, [new Episode("after", ABSOLUTE_CLASS, PERIOD_END)], {
          graceMs: 0,
        }),
      EpisodeOutsidePeriod,
    );

    expectRefusal(
      () =>
        reportOver(
          db,
          revisionId,
          [new Episode("before", ABSOLUTE_CLASS, PERIOD_START - budgetMs)],
          { graceMs: 0 },
        ),
      EpisodeOutsidePeriod,
    );
  });

  test("duplicate episode ids are refused", () => {
    // One condition is one episode; a repeated id is two votes in one
    // numerator.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const episode = new Episode("e", ABSOLUTE_CLASS, PERIOD_START);

    expectRefusal(
      () => reportOver(db, revisionId, [episode, episode], { graceMs: 0 }),
      DuplicateEpisodeRefused,
    );
  });

  test("idsFor refuses a classification this module does not have (target-only)", () => {
    // Target-only: translates no source case, and exists because a mutation
    // sweep found the guard unguarded on BOTH sides. Interlock calls
    // `ids_for` only with IN_PERIOD / CENSORED / CENSORED_LEFT, so its own
    // `WindowRefusal` for an unknown name is never reached by its suite either
    // -- deleting the check leaves all twenty-two ported cases green.
    //
    // The property is worth holding: `idsFor` filters, so without the guard an
    // unrecognised bucket name returns an empty list rather than an error. A
    // caller that misspelled a bucket, or that asked for one a later revision
    // of this module renamed, would read "no episodes in that bucket" and
    // print a zero -- which is exactly the reading `counts()` emits all three
    // keys to prevent.
    //
    // Production behaviour is unchanged and still matches interlock's; this
    // adds coverage, not behaviour.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const report = reportOver(db, revisionId, [new Episode("e", ABSOLUTE_CLASS, PERIOD_START)], {
      graceMs: 0,
    });

    expectRefusal(() => report.idsFor("in-period"), WindowRefusal, /is not one of/);
    expectRefusal(() => report.idsFor(""), WindowRefusal);
    // The valid names still work, so the guard is a filter on the argument and
    // not a refusal of the method.
    expect(report.idsFor(IN_PERIOD)).toEqual(["e"]);
  });

  test("an empty or inverted period is refused", () => {
    // Every episode would be censored, for a reason that is not censoring.
    const db = productionDb();
    const revisionId = seedRevisionId(db);

    expectRefusal(
      () =>
        reportOver(db, revisionId, [], {
          periodStartMs: PERIOD_END,
          periodEndMs: PERIOD_START,
        }),
      PeriodRefused,
    );
    expectRefusal(
      () =>
        reportOver(db, revisionId, [], {
          periodStartMs: PERIOD_START,
          periodEndMs: PERIOD_START,
        }),
      PeriodRefused,
    );
  });
});
