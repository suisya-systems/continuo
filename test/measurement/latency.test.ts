/**
 * Percentiles on a hand-checkable sample, both references always rendered, lag
 * kept apart.
 *
 * Ported from interlock `tests/measurement/test_latency.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping, and the cases that are
 * adapted rather than translated straight, are recorded in
 * `parity/measurement.latency.ledger.json`.
 *
 * Three properties get adversarial treatment here, because each of them is the
 * kind a plausible implementation satisfies by accident on a friendly input.
 *
 * * **Both references, always.** A report that never leaves the shadow period
 *   would pass every test of the budget comparison while being structurally
 *   unable to say "there is no v1 distribution for this period". So the
 *   no-shadow path is driven twice -- once with no shadow source at all, once
 *   with a shadow source that simply holds nothing for the class under test --
 *   and both are asserted to render their own reason under the second heading. A
 *   separate test walks *every* class block of a rendered report and asserts both
 *   headings are present, which is the structural claim `latency.ts` makes rather
 *   than a claim about one input.
 * * **The percentiles are checked by hand, not recomputed.** The sample is ten
 *   latencies of 1..10 minutes, chosen so nearest-rank median and p90 are the 5th
 *   and 9th values and can be written down. Re-deriving them here would be a copy
 *   of the code under test, and a copy agrees with a bug.
 * * **The lag is a different series.** Proved by moving one and asserting the
 *   other does not move: the same episodes are measured over a database whose
 *   spine has been given a nine-minute ingestion lag, and the detection
 *   distribution comes out identical. A harness that subtracted or folded lag
 *   into latency fails that comparison, and no assertion about a single report
 *   could catch it.
 */

import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import { detectionLatency } from "../../src/control_plane/policy.js";
import { isAscii } from "../../src/measurement/format.js";
import {
  ClassLatency,
  DetectionBeforeOnset,
  Distribution,
  IngestionLag,
  LatencyRefusal,
  LatencyReport,
  measureIngestionLag,
  measureLatency,
  noShadowReference,
  renderLatencyReport,
  SHADOW_ABSENT,
  SHADOW_PRESENT,
  ShadowReference,
  ShadowReferenceUnstated,
  ShadowSource,
  shadowFromBothBucket,
  UnknownEpisodeDetection,
} from "../../src/measurement/latency.js";
import { openForMeasurement } from "../../src/measurement/reader.js";
import { classifyEpisodes, Episode } from "../../src/measurement/windows.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const PERIOD_START = T0;
const PERIOD_END = T0 + DAY_MS;
const NOW_MS = T0 + DAY_MS + MINUTE_MS;

/**
 * The note `0002_policy_seed.sql` writes. Looked up by note rather than assumed
 * to be revision 1, so these tests survive a later seed step.
 */
const SEED_NOTE =
  "initial time base: detection latency budgets, gate stage tolerances " +
  "and gate stage owners as first decided";

/**
 * T = 10 min, L = 15 min (`time-base-policy.md` section 3.2). Absolute on both
 * sides, so a test about the distribution is not also a test about subject
 * resolution -- `windows.test.ts` owns that.
 */
const CLASS_A = "session_no_evidence";
/** T per stage, L = 5 min. A second class, so "per class" is exercised. */
const CLASS_B = "relay_gap";

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/** The source's `db` fixture, as a per-test call (rule 8). */
function productionDb(): string {
  const path = join(caseRoot("latency"), "production.sqlite3");
  createProductionControlPlane(path, { nowMs: T0 }).close();
  return path;
}

/**
 * An ordinary writable handle -- deliberately not the harness's.
 *
 * The harness's connection cannot write (`reader.ts`), which is the property
 * under test elsewhere in this package, so fixtures are built through a second
 * connection rather than by relaxing that one.
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
    if (row === undefined) {
      expect.fail("0002_policy_seed.sql must have applied");
    }
    return Number(row.revision_id);
  });
}

/** `L` as the policy row states it, read the way the module reads it. */
function budgetMsOf(path: string, revisionId: number, incidentClass: string): number {
  const row = withMeasurement(path, (connection) =>
    detectionLatency(connection, { revisionId, incidentClass }),
  );
  expect(row.budgetKind).toBe("absolute_ms");
  return Number(row.budgetMs);
}

function appendSpineEvent(
  path: string,
  fields: { eventId: string; occurredAtMs: number; ingestedAtMs: number },
): void {
  withWritable(path, (connection) => {
    connection
      .prepare(
        `INSERT INTO event (event_id, event_type, subject_kind, subject_id,
                            producer, dedup_key, occurred_at_ms, ingested_at_ms)
         VALUES (?, 'ci_outcome', 'pull_request', 'pr-1', 'test', ?, ?, ?)`,
      )
      .run(fields.eventId, `dedup/${fields.eventId}`, fields.occurredAtMs, fields.ingestedAtMs);
  });
}

function reportOver(
  path: string,
  revisionId: number,
  episodes: readonly Episode[],
  detections: ReadonlyMap<string, number>,
  shadow: ShadowSource,
  options: { periodStartMs?: number; periodEndMs?: number } = {},
): LatencyReport {
  return withMeasurement(path, (connection) => {
    const windows = classifyEpisodes(connection, {
      revisionId,
      periodStartMs: options.periodStartMs ?? PERIOD_START,
      periodEndMs: options.periodEndMs ?? PERIOD_END,
      episodes,
    });
    return measureLatency(connection, { windows, detections, shadow, nowMs: NOW_MS });
  });
}

/**
 * Ten in-period episodes detected 1..10 minutes after their own onsets.
 *
 * Onsets are spaced an hour apart and start well inside the period, so every
 * window (`L` + grace, both far under an hour) lies wholly inside it and the
 * censoring rules -- proved in `windows.test.ts` -- are not what this sample is
 * about.
 */
function tenMinuteSample(path: string, revisionId: number, shadow: ShadowSource): LatencyReport {
  const episodes: Episode[] = [];
  const detections = new Map<string, number>();
  for (let index = 1; index <= 10; index += 1) {
    const onset = PERIOD_START + index * 60 * MINUTE_MS;
    const episodeId = `e${String(index).padStart(2, "0")}`;
    episodes.push(new Episode(episodeId, CLASS_A, onset));
    detections.set(episodeId, onset + index * MINUTE_MS);
  }
  return reportOver(path, revisionId, episodes, detections, shadow);
}

/** The grace this revision defaults to, read the way `classifyEpisodes` reads it. */
function defaultGraceOf(path: string, revisionId: number): number {
  return withMeasurement(
    path,
    (connection) =>
      classifyEpisodes(connection, {
        revisionId,
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        episodes: [],
      }).graceMs,
  );
}

// --------------------------------------------------------------------------
// the distribution
// --------------------------------------------------------------------------

describe("the distribution", () => {
  test("percentiles are nearest-rank on a hand-checked sample", () => {
    // Latencies of 1..10 minutes: median is the 5th, p90 the 9th, max the 10th.
    // Nearest rank returns a value some episode actually exhibited, which an
    // interpolating median would not: the interpolating median of this sample
    // is 5.5 minutes, a duration no detection here took. The expected numbers
    // are written out rather than computed, so the test binds to the definition
    // and not to the implementation of it.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const report = tenMinuteSample(
      db,
      revisionId,
      noShadowReference("no shadow period for this test"),
    );

    expect(report.classes).toHaveLength(1);
    const measured = report.classes[0];
    expect(measured?.incidentClass).toBe(CLASS_A);
    expect(measured?.distribution).toEqual(
      new Distribution({
        count: 10,
        medianMs: 5 * MINUTE_MS,
        p90Ms: 9 * MINUTE_MS,
        maxMs: 10 * MINUTE_MS,
      }),
    );
  });

  test("an undetected in-period episode is not a latency sample", () => {
    // A missing detection is a candidate miss, and it is named, not dropped.
    // Including it at any value would be a fabrication; dropping it silently
    // would leave the report unable to distinguish "nine detections" from "ten
    // episodes, one never detected", which are the two readings AC-10 turns on.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const episodes = [
      new Episode("detected", CLASS_A, PERIOD_START),
      new Episode("never", CLASS_A, PERIOD_START + MINUTE_MS),
    ];
    const report = reportOver(
      db,
      revisionId,
      episodes,
      new Map([["detected", PERIOD_START + MINUTE_MS]]),
      noShadowReference("no shadow period for this test"),
    );

    expect(report.classes).toHaveLength(1);
    expect(report.classes[0]?.distribution.count).toBe(1);
    expect(report.classes[0]?.undetectedIds).toEqual(["never"]);
    expect(renderLatencyReport(report)).toContain("candidate misses");
  });

  test("a censored episode is excluded from the distribution and counted", () => {
    // Censoring is windows.ts's decision and this module honours it. The
    // right-censored episode's window ends one millisecond past the period, so
    // windows.ts files it `censored`; its detection is supplied anyway, and the
    // distribution must still be over the in-period episode alone.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const budgetMs = budgetMsOf(db, revisionId, CLASS_A);
    const graceMs = defaultGraceOf(db, revisionId);

    const insideOnset = PERIOD_START + MINUTE_MS;
    const overTheEdgeOnset = PERIOD_END - budgetMs - graceMs + 1;
    const episodes = [
      new Episode("inside", CLASS_A, insideOnset),
      new Episode("right", CLASS_A, overTheEdgeOnset),
      new Episode("left", CLASS_A, PERIOD_START - 1),
    ];
    const detections = new Map([
      ["inside", insideOnset + MINUTE_MS],
      ["right", overTheEdgeOnset + 2 * MINUTE_MS],
      ["left", PERIOD_START + 3 * MINUTE_MS],
    ]);
    const report = reportOver(
      db,
      revisionId,
      episodes,
      detections,
      noShadowReference("no shadow period for this test"),
    );

    expect(report.classes).toHaveLength(1);
    expect(report.classes[0]?.distribution).toEqual(
      new Distribution({
        count: 1,
        medianMs: MINUTE_MS,
        p90Ms: MINUTE_MS,
        maxMs: MINUTE_MS,
      }),
    );
    expect(report.classes[0]?.censoredIds).toEqual(["right"]);
    expect(report.classes[0]?.censoredLeftIds).toEqual(["left"]);
  });

  test("over budget is strictly greater than L", () => {
    // A detection landing exactly on the ceiling met it; one millisecond later
    // did not. `L` is the ceiling on onset-to-alarm (time-base-policy.md
    // section 3.1), so `>=` here would fail the one detection that did exactly
    // what the policy asked, and the failure would be invisible in any sample
    // not driven to the instant.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const budgetMs = budgetMsOf(db, revisionId, CLASS_A);
    const onTimeOnset = PERIOD_START + MINUTE_MS;
    const lateOnset = PERIOD_START + 2 * MINUTE_MS;
    const episodes = [
      new Episode("exactly", CLASS_A, onTimeOnset),
      new Episode("one_late", CLASS_A, lateOnset),
    ];
    const detections = new Map([
      ["exactly", onTimeOnset + budgetMs],
      ["one_late", lateOnset + budgetMs + 1],
    ]);
    const report = reportOver(
      db,
      revisionId,
      episodes,
      detections,
      noShadowReference("no shadow period for this test"),
    );

    expect(report.classes).toHaveLength(1);
    expect(report.classes[0]?.overBudgetIds).toEqual(["one_late"]);
    expect(report.classes[0]?.budgetsMs).toEqual([budgetMs]);
  });

  test("a detection before its onset is refused", () => {
    // A negative latency is a mispairing or a mixed clock, never a fast
    // detector.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const onset = PERIOD_START + 10 * MINUTE_MS;
    expectRefusal(
      () =>
        reportOver(
          db,
          revisionId,
          [new Episode("e", CLASS_A, onset)],
          new Map([["e", onset - 1]]),
          noShadowReference("no shadow period for this test"),
        ),
      DetectionBeforeOnset,
    );
  });

  test("a detection for an unclassified episode is refused", () => {
    // The detection map and the episode set must be over the same selection.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    expectRefusal(
      () =>
        reportOver(
          db,
          revisionId,
          [new Episode("known", CLASS_A, PERIOD_START + MINUTE_MS)],
          new Map([
            ["known", PERIOD_START + 2 * MINUTE_MS],
            ["stray", PERIOD_START],
          ]),
          noShadowReference("no shadow period for this test"),
        ),
      UnknownEpisodeDetection,
    );
  });
});

// --------------------------------------------------------------------------
// the two references
// --------------------------------------------------------------------------

describe("the two references", () => {
  test("no shadow reference renders and says so", () => {
    // Outside the shadow period the report states the absence, with its reason.
    // The budget block must still be there -- the acceptance bound is available
    // and is printed -- and the shadow block must say in words that there is no
    // non-regression reference, so a reader cannot take "inside budget" for "no
    // regression".
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const reason = "2026-08-21 lies outside the canary shadow window";
    const report = tenMinuteSample(db, revisionId, noShadowReference(reason));

    expect(report.classes).toHaveLength(1);
    const measured = report.classes[0];
    expect(measured?.shadow.status).toBe(SHADOW_ABSENT);
    expect(measured?.shadow.distribution).toBeNull();
    expect(measured?.shadow.reason).toBe(reason);
    expect(report.shadowAvailable).toBe(false);

    const rendered = renderLatencyReport(report);
    expect(rendered).toContain("NO SHADOW REFERENCE FOR THIS PERIOD");
    expect(rendered).toContain(reason);
    expect(rendered, "the acceptance bound is still printed").toContain("L in force");
  });

  test("a present shadow source with nothing for this class is absent for it", () => {
    // An empty per-class sample is an absence with a reason, never a zero. This
    // is the failure that would survive a test using only the report-level
    // absence: the shadow period covers the report, so a naive implementation
    // reports "v1: count 0" and a reader compares against nothing and sees no
    // regression.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const report = tenMinuteSample(
      db,
      revisionId,
      shadowFromBothBucket(new Map([[CLASS_B, [1_000, 2_000]]])),
    );

    expect(report.classes).toHaveLength(1);
    const measured = report.classes[0];
    expect(measured?.incidentClass).toBe(CLASS_A);
    expect(measured?.shadow.status).toBe(SHADOW_ABSENT);
    expect(measured?.shadow.reason).not.toBeNull();
    expect(measured?.shadow.reason).toContain(CLASS_A);
    expect(
      report.shadowAvailable,
      "the report-level source IS present; only this class has no both-bucket " +
        "episode, and the two facts are different",
    ).toBe(true);
  });

  test("a present shadow reference carries v1 percentiles", () => {
    // The non-regression bound is v1's own distribution, computed the same way.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const v1Samples = Array.from({ length: 10 }, (_, index) => (index + 1) * MINUTE_MS);
    const report = tenMinuteSample(
      db,
      revisionId,
      shadowFromBothBucket(new Map([[CLASS_A, v1Samples]])),
    );

    expect(report.classes).toHaveLength(1);
    const measured = report.classes[0];
    expect(measured?.shadow.status).toBe(SHADOW_PRESENT);
    expect(measured?.shadow.bothBucketCount).toBe(10);
    expect(measured?.shadow.distribution).toEqual(
      new Distribution({
        count: 10,
        medianMs: 5 * MINUTE_MS,
        p90Ms: 9 * MINUTE_MS,
        maxMs: 10 * MINUTE_MS,
      }),
    );
    expect(renderLatencyReport(report)).toContain("both-bucket");
  });

  test("every class block renders both reference headings", () => {
    // The structural claim: no class is rendered against one reference alone.
    // Asserted over a report holding one class with a shadow distribution and
    // one without, so a rendering that emitted the second heading only when it
    // had something to put under it would fail here.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const episodes = [
      new Episode("a", CLASS_A, PERIOD_START + 60 * MINUTE_MS),
      new Episode("b", CLASS_B, PERIOD_START + 120 * MINUTE_MS),
    ];
    const detections = new Map([
      ["a", PERIOD_START + 61 * MINUTE_MS],
      ["b", PERIOD_START + 121 * MINUTE_MS],
    ]);
    const report = reportOver(
      db,
      revisionId,
      episodes,
      detections,
      shadowFromBothBucket(new Map([[CLASS_A, [30_000]]])),
    );
    const rendered = renderLatencyReport(report);

    expect(report.classes).toHaveLength(2);
    expect(occurrences(rendered, "reference 1 of 2")).toBe(2);
    expect(occurrences(rendered, "reference 2 of 2")).toBe(2);
    expect(
      isAscii(rendered),
      "the report reaches a cp932 console; a single em-dash would raise " +
        "UnicodeEncodeError there",
    ).toBe(true);
  });

  test("a shadow reference without a distribution or a reason is refused", () => {
    // The exclusive-or is the type's, not the caller's discipline.
    expectRefusal(
      () =>
        new ShadowReference({
          status: SHADOW_ABSENT,
          distribution: null,
          bothBucketCount: null,
          reason: "",
        }),
      ShadowReferenceUnstated,
    );
    expectRefusal(
      () =>
        new ShadowReference({
          status: SHADOW_PRESENT,
          distribution: null,
          bothBucketCount: 0,
          reason: null,
        }),
      ShadowReferenceUnstated,
    );
    expectRefusal(
      () => new ShadowSource({ status: SHADOW_ABSENT, samples: null, reason: null }),
      ShadowReferenceUnstated,
    );
    expectRefusal(
      () => new ShadowSource({ status: "maybe", samples: null, reason: "a reason" }),
      ShadowReferenceUnstated,
    );
  });
});

// --------------------------------------------------------------------------
// the ingestion lag, beside the latency and never inside it
// --------------------------------------------------------------------------

describe("the ingestion lag", () => {
  test("ingestion lag is a separate series from detection latency", () => {
    // Give the spine a nine-minute lag; the detection distribution must not
    // move. This is the "provider having a bad afternoon" case of section 4. A
    // harness that folded lag into latency, or subtracted it out, would report a
    // different detection distribution over identical episodes, and the
    // difference would look exactly like a detector regression.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const before = tenMinuteSample(
      db,
      revisionId,
      noShadowReference("no shadow period for this test"),
    );

    for (let index = 0; index < 3; index += 1) {
      const occurred = PERIOD_START + (index + 1) * 30 * MINUTE_MS;
      appendSpineEvent(db, {
        eventId: `slow-${index}`,
        occurredAtMs: occurred,
        ingestedAtMs: occurred + 9 * MINUTE_MS,
      });
    }

    const after = tenMinuteSample(
      db,
      revisionId,
      noShadowReference("no shadow period for this test"),
    );

    expect(before.ingestionLag.eventCount).toBe(0);
    expect(before.ingestionLag.distribution.count).toBe(0);
    expect(after.ingestionLag.distribution).toEqual(
      new Distribution({
        count: 3,
        medianMs: 9 * MINUTE_MS,
        p90Ms: 9 * MINUTE_MS,
        maxMs: 9 * MINUTE_MS,
      }),
    );
    expect(
      after.classes[0]?.distribution,
      "a provider's slow afternoon must not move the detection distribution",
    ).toEqual(before.classes[0]?.distribution);

    const rendered = renderLatencyReport(after);
    expect(rendered).toContain("Ingestion lag");
    expect(rendered).toContain("the first is the provider getting slower, the second is us");
  });

  test("negative ingestion lag is counted rather than clamped", () => {
    // A provider clock ahead of ours is skew, and this is the only record of it.
    const db = productionDb();
    appendSpineEvent(db, {
      eventId: "ahead",
      occurredAtMs: PERIOD_START + 10 * MINUTE_MS,
      ingestedAtMs: PERIOD_START + 9 * MINUTE_MS,
    });
    const lag = withMeasurement(db, (connection) =>
      measureIngestionLag(connection, {
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
      }),
    );

    expect(lag.negativeCount).toBe(1);
    expect(lag.distribution.maxMs).toBe(-MINUTE_MS);
  });

  test("the lag window is half-open on our own clock", () => {
    // Bounded on `ingested_at_ms`, [start, end). Selecting on `occurred_at_ms`
    // would let a provider's skew move rows between reports -- the effect this
    // series exists to expose. The row whose *ingest* lands exactly at
    // periodEndMs belongs to the next period (rule 4), and the one at
    // periodStartMs belongs to this one.
    const db = productionDb();
    appendSpineEvent(db, {
      eventId: "at_start",
      occurredAtMs: PERIOD_START - 1,
      ingestedAtMs: PERIOD_START,
    });
    appendSpineEvent(db, {
      eventId: "at_end",
      occurredAtMs: PERIOD_END - 1,
      ingestedAtMs: PERIOD_END,
    });
    // Ingested inside the period, but occurring long before it: kept, because
    // our clock decides membership.
    appendSpineEvent(db, {
      eventId: "old_fact",
      occurredAtMs: PERIOD_START - 10 * MINUTE_MS,
      ingestedAtMs: PERIOD_START + MINUTE_MS,
    });
    const lag = withMeasurement(db, (connection) =>
      measureIngestionLag(connection, {
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
      }),
    );

    expect(lag.eventCount).toBe(2);
    expect(lag.distribution.maxMs).toBe(11 * MINUTE_MS);
  });

  test("an empty or inverted period is refused", () => {
    // Every row would be outside a period containing no instant.
    const db = productionDb();
    withMeasurement(db, (connection) => {
      expectRefusal(
        () =>
          measureIngestionLag(connection, {
            periodStartMs: PERIOD_END,
            periodEndMs: PERIOD_START,
          }),
        LatencyRefusal,
      );
      expectRefusal(
        () =>
          measureIngestionLag(connection, {
            periodStartMs: PERIOD_START,
            periodEndMs: PERIOD_START,
          }),
        LatencyRefusal,
      );
    });
  });
});

// --------------------------------------------------------------------------
// the report itself
// --------------------------------------------------------------------------

describe("the report itself", () => {
  test("the report carries the revision and grace it was computed under", () => {
    // A latency judged against one revision's L is a figure over that revision.
    // Carried up from the window report rather than re-resolved, so the two
    // halves of one report cannot end up over two revisions (interlock D-0031,
    // D-0040).
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const report = tenMinuteSample(
      db,
      revisionId,
      noShadowReference("no shadow period for this test"),
    );

    expect(report.revisionId).toBe(revisionId);
    expect(report.generatedAtMs).toBe(NOW_MS);
    expect(report.periodStartMs).toBe(PERIOD_START);
    expect(report.periodEndMs).toBe(PERIOD_END);
    const rendered = renderLatencyReport(report);
    expect(rendered).toContain(`policy revision ${revisionId}`);
    expect(rendered).toContain(report.graceSource);
  });

  test("percentiles are ceil-rank, on a sample where floor would differ (target-only)", () => {
    // Target-only: translates no source case. A mutation sweep found ceil ->
    // floor in nearestRank survived every ported case, and the reason is
    // inherited: interlock's samples are size 10 (where ceil and floor of both
    // 0.5*n and 0.9*n coincide exactly), size 1, and size 3 with three
    // IDENTICAL values. No sample it uses can tell the two rules apart.
    //
    // Three distinct values do. With n = 3: ceil(0.5*3) = 2 and floor = 1, so
    // the median is the 2nd smallest under the rule the module documents and
    // the 1st under the mutation; ceil(0.9*3) = 3 and floor = 2. Nearest rank
    // is a D-0040 claim -- the figure must be one some episode exhibited and
    // must be reproducible across builds and languages -- so which rank it is
    // deserves a case.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const episodes: Episode[] = [];
    const detections = new Map<string, number>();
    for (let index = 1; index <= 3; index += 1) {
      const onset = PERIOD_START + index * 60 * MINUTE_MS;
      episodes.push(new Episode(`t${index}`, CLASS_A, onset));
      detections.set(`t${index}`, onset + index * MINUTE_MS);
    }
    const report = reportOver(
      db,
      revisionId,
      episodes,
      detections,
      noShadowReference("no shadow period for this test"),
    );

    expect(report.classes[0]?.distribution).toEqual(
      new Distribution({
        count: 3,
        // ceil(0.5 * 3) = 2 -> the 2nd smallest, which is 2 minutes.
        medianMs: 2 * MINUTE_MS,
        // ceil(0.9 * 3) = 3 -> the 3rd smallest, which is 3 minutes.
        p90Ms: 3 * MINUTE_MS,
        maxMs: 3 * MINUTE_MS,
      }),
    );
  });

  test("a class present in the shadow source with an EMPTY sample is absent for it (target-only)", () => {
    // Target-only: translates no source case, and closes an inherited blind
    // spot a mutation sweep found. The ported case supplies a source holding a
    // DIFFERENT class, so the lookup misses and returns undefined; the branch
    // where the class IS present with an empty sample list is never taken.
    // Interlock has the same gap -- its `if not samples:` covers both, and its
    // one test only exercises the missing key.
    //
    // The distinction matters exactly as the module comment says: an empty
    // distribution would render as "v1: count 0" and a reader would compare
    // against nothing and see no regression.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const report = tenMinuteSample(db, revisionId, shadowFromBothBucket(new Map([[CLASS_A, []]])));

    const measured = report.classes[0];
    expect(measured?.incidentClass).toBe(CLASS_A);
    expect(measured?.shadow.status).toBe(SHADOW_ABSENT);
    expect(measured?.shadow.distribution).toBeNull();
    expect(measured?.shadow.reason).toContain(CLASS_A);
    // The source-level status is still present: only this class has nothing.
    expect(report.shadowAvailable).toBe(true);
    expect(renderLatencyReport(report)).toContain("NO SHADOW REFERENCE FOR THIS PERIOD");
  });

  test("classes are reported in first-seen order, not sorted (target-only)", () => {
    // Target-only: translates no source case. Sorting the class list
    // alphabetically survived every ported case, because the one two-class test
    // counts headings rather than reading the order. Interlock never asserts
    // the order either.
    //
    // It is a D-0040 claim: the rendered report must be reproducible byte for
    // byte over the same input, and first-seen order is what makes it so. The
    // fixture is built so the two differ -- "relay_gap" sorts BEFORE
    // "session_no_evidence", while the episodes present session_no_evidence
    // first -- so a sort is visible here and nowhere else.
    const db = productionDb();
    const revisionId = seedRevisionId(db);
    expect(CLASS_B < CLASS_A, "the fixture only discriminates while B sorts first").toBe(true);

    const episodes = [
      new Episode("first", CLASS_A, PERIOD_START + 60 * MINUTE_MS),
      new Episode("second", CLASS_B, PERIOD_START + 120 * MINUTE_MS),
    ];
    const detections = new Map([
      ["first", PERIOD_START + 61 * MINUTE_MS],
      ["second", PERIOD_START + 121 * MINUTE_MS],
    ]);
    const report = reportOver(
      db,
      revisionId,
      episodes,
      detections,
      noShadowReference("no shadow period for this test"),
    );

    expect(report.classes.map((measured) => measured.incidentClass)).toEqual([CLASS_A, CLASS_B]);
    // ...and the rendering follows the same order, which is the property a
    // reader diffing two reports depends on.
    const rendered = renderLatencyReport(report);
    expect(rendered.indexOf(`Class ${CLASS_A}`)).toBeLessThan(rendered.indexOf(`Class ${CLASS_B}`));
  });

  test("an empty distribution prints as no sample, not as zero", () => {
    // Zero milliseconds and no sample are different statements.
    const empty = Distribution.of([]);
    expect(empty).toEqual(new Distribution({ count: 0, medianMs: null, p90Ms: null, maxMs: null }));

    const db = productionDb();
    const revisionId = seedRevisionId(db);
    const report = reportOver(
      db,
      revisionId,
      [],
      new Map(),
      noShadowReference("no shadow period for this test"),
    );
    expect(report.classes).toEqual([]);
    expect(renderLatencyReport(report)).toContain("No episode was classified for this period.");
  });
});

/** `str.count(needle)`: non-overlapping occurrences, which is what the source counts. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("a deliberate divergence from interlock (target-only)", () => {
  test("a present shadow reference must state the population it is over", () => {
    // Target-only, and `D-0108`: a DELIBERATE, PERMANENT divergence, decided by
    // the operator on 2026-08-22 when `D-0022` (disclose inherited defects, do
    // not repair them) was withdrawn -- interlock is frozen, so there is no
    // upstream repair to follow and no reason to carry a defect that will never
    // be fixed anywhere else.
    //
    // interlock's __post_init__ checks only `distribution is None` for the
    // present state, so a reference with a distribution and no both-bucket
    // count is accepted and `render_latency_report` emits "over None
    // both-bucket episode(s)" -- a heading that announces a comparison and
    // names no population. Verified against interlock at 65f36c5.
    //
    // Same shape as D-0107's required count and the same argument: the type is
    // exported, so the construction path is public, and a caller with nothing
    // to count writes `0`.
    const refusal = expectRefusal(
      () =>
        new ShadowReference({
          status: SHADOW_PRESENT,
          distribution: Distribution.of([10, 20]),
          bothBucketCount: null,
          reason: null,
        }),
      ShadowReferenceUnstated,
    );
    expect(refusal.message).toContain("both-bucket episodes");

    // Zero is a statement and is accepted: the divergence is about an UNSTATED
    // population, not an empty one.
    const stated = new ShadowReference({
      status: SHADOW_PRESENT,
      distribution: Distribution.of([10, 20]),
      bothBucketCount: 0,
      reason: null,
    });
    expect(stated.bothBucketCount).toBe(0);
  });
});

describe("hostile values in the rendering (target-only)", () => {
  test("an incident class cannot forge a line and cannot reach a cp932 console", () => {
    // Target-only, and `D-0109`. Found by reading the renderer rather than from
    // a ledger disclosure -- this module was not among the three the inventory
    // listed. incident_class comes from the policy table and the shadow
    // reference's absence reason is caller text; both went into the report
    // verbatim.
    const rendered = renderLatencyReport(
      new LatencyReport({
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        generatedAtMs: PERIOD_END + 1,
        revisionId: 1,
        graceMs: 0,
        graceSource: "declared\u2014by hand\nforged grace line",
        classes: [
          new ClassLatency({
            incidentClass: "stalled\n  Class forged",
            distribution: Distribution.of([10]),
            budgetsMs: [1_000],
            overBudgetIds: [],
            undetectedIds: ["e1\u2014one"],
            censoredIds: [],
            censoredLeftIds: [],
            shadow: ShadowReference.absent("outside the shadow period\u2014really"),
          }),
        ],
        shadow: new ShadowSource({
          status: SHADOW_ABSENT,
          samples: null,
          reason: "no v1 in this period",
        }),
        ingestionLag: new IngestionLag({
          distribution: Distribution.of([]),
          negativeCount: 0,
          eventCount: 0,
        }),
      }),
    );

    expect(isAscii(rendered)).toBe(true);
    expect(rendered).toContain("\\u000a");
    expect(rendered).toContain("\\u2014");
    // One class heading, not two.
    expect(rendered.split("\n").filter((line) => line.startsWith("Class "))).toHaveLength(1);
  });
});
