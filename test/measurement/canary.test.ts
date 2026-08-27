/**
 * Three assertions that must be able to be violated, and a report that must not judge.
 *
 * Ported from interlock `tests/measurement/test_canary.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping, and the cases that are
 * adapted rather than translated straight, are recorded in
 * `parity/measurement.canary.ledger.json`.
 *
 * `canary.ts` fails silently in four ways, and a cheerful suite would notice
 * none of them, so each gets its own adversarial treatment here:
 *
 * * **A finding that gets tidied away.** A dual write and a run claimed by both
 *   sides are the two things the report exists to catch, so both are
 *   constructed on purpose and asserted as *findings* -- and the ownership case
 *   additionally asserts the ledger still carries both claims, because deduping
 *   them would leave a correct finding count with no evidence under it.
 * * **A read-only assertion that reads a claim instead of the connection.** The
 *   decisive test hands the checker a connection opened read-**write** with
 *   `PRAGMA query_only = ON` set by hand: it satisfies every claim a report
 *   could print about itself and has no read-only capability at all. A checker
 *   that trusted the pragma passes it; one that asks the file does not.
 * * **A verdict arriving as prose.** The rendering of a report *with* findings
 *   in it is grepped for the verdict vocabulary with word boundaries, because
 *   the moment for a harness to slip a go/no-go in is the moment something is
 *   wrong.
 * * **A missing comparison rendering as a clean one.** The empty-v1 report is
 *   rendered and read for the words that distinguish "nothing was found" from
 *   "nothing was compared", in all three sections.
 *
 * Fixtures are built through the production schema and a second, writable
 * connection; the harness's own connection cannot write, and nothing here
 * relaxes that. Expected keys, counts and strings are written out by hand --
 * nothing in this file recomputes the module to compare against it.
 */

import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import { observePullRequest, upsertRepository } from "../../src/control_plane/repo_link.js";
import {
  auditWriters,
  buildOwnershipLedger,
  type CanaryDivergenceReport,
  CanaryRefusal,
  DUAL_WRITE,
  evidenceOfReadOnly,
  measureCanaryDivergence,
  OWNERSHIP_COLLISION,
  OwnedRun,
  OwnershipInputRefused,
  QUERY_DEFINITIONS,
  RECORD_CLASS_PULL_REQUEST,
  RECORD_CLASS_RUN,
  RECORD_CLASSES,
  RecordClass,
  readInterlockRecords,
  renderCanaryDivergenceReport,
  UndeclaredRecordClass,
  V1InputRefused,
  V1OwnershipInput,
  V1WriterLedger,
  WrittenRecord,
} from "../../src/measurement/canary.js";
import { isAscii } from "../../src/measurement/format.js";
import {
  openForMeasurement,
  ReadOnlyCapabilityRefused,
  readerSeams,
} from "../../src/measurement/reader.js";
import {
  CorrelationKey,
  ShadowEpisode,
  SUBJECT_PR_MERGE,
  V1Reference,
} from "../../src/measurement/shadow.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const PERIOD_START = T0;
const PERIOD_END = T0 + DAY_MS;

const V1_STORE = "v1:.state";
const V1_SOURCE = "v1-shadow-adapter@1";

/**
 * The verdict vocabulary section 5 forbids. Word boundaries, because the report
 * legitimately contains 'ongoing' and 'category' and this must not match those.
 */
const VERDICT_WORDS = /\b(pass|passes|passed|passing|fail|fails|failed|failing|go|no-go|nogo)\b/i;

// --------------------------------------------------------------------------
// helpers -- the world, built through a writable second connection
// --------------------------------------------------------------------------

/** The source's `db` fixture, as a per-test call (rule 8). */
function productionDb(): string {
  const path = join(caseRoot("canary"), "production.sqlite3");
  createProductionControlPlane(path, { nowMs: T0 }).close();
  return path;
}

/** An ordinary writable handle -- deliberately not the harness's. */
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

function addRun(
  cp: SqliteDatabase,
  runId: string,
  fields: { readonly created: number; readonly updated?: number },
): string {
  cp.prepare(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'running', ?, ?)",
  ).run(runId, fields.created, fields.updated ?? fields.created);
  return runId;
}

function addRepository(cp: SqliteDatabase, repoId: string, owner: string, name: string): string {
  return upsertRepository(cp, { repoId, owner, name, nowMs: T0 });
}

function addPullRequest(
  cp: SqliteDatabase,
  fields: {
    readonly repoId: string;
    readonly prNumber: number;
    readonly observedAtMs: number;
  },
): void {
  observePullRequest(cp, {
    repoId: fields.repoId,
    prNumber: fields.prNumber,
    headSha: "a".repeat(40),
    state: "open",
    observedAtMs: fields.observedAtMs,
    ingestedAtMs: fields.observedAtMs,
    eventId: `evt-pr-${fields.prNumber}`,
    producer: "pr_watcher",
  });
}

function mergeEpisode(
  episodeId: string,
  slug: string,
  numberPart: string,
  onsetMs: number,
): ShadowEpisode {
  return new ShadowEpisode({
    episodeId,
    subjectClass: SUBJECT_PR_MERGE,
    shape: "pr_merged",
    onsetMs,
    key: new CorrelationKey({
      subjectClass: SUBJECT_PR_MERGE,
      parts: ["github", slug, numberPart],
    }),
  });
}

function reportOver(
  dbPath: string,
  options: {
    readonly v1Reference: V1Reference;
    readonly v1WriterLedger: V1WriterLedger;
    readonly v1Ownership: V1OwnershipInput;
    readonly interlockEpisodes?: readonly ShadowEpisode[];
    readonly recordClasses?: readonly RecordClass[];
  },
): CanaryDivergenceReport {
  return withMeasurement(dbPath, (connection) =>
    measureCanaryDivergence(connection, {
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      interlockEpisodes: options.interlockEpisodes ?? [],
      v1Reference: options.v1Reference,
      censoredIds: new Set<string>(),
      fixtureLabels: new Map(),
      v1WriterLedger: options.v1WriterLedger,
      v1Ownership: options.v1Ownership,
      ...(options.recordClasses === undefined ? {} : { recordClasses: options.recordClasses }),
    }),
  );
}

function v1Owned(runId: string, at: number): OwnedRun {
  return new OwnedRun({ runId, owningSystem: "v1", decidedAtMs: at, store: V1_STORE });
}

function reportWithBothFindings(path: string): CanaryDivergenceReport {
  withWritable(path, (cp) => {
    addRun(cp, "shared", { created: PERIOD_START + 100 });
  });
  return reportOver(path, {
    interlockEpisodes: [mergeEpisode("ours-1", "aa-org/renga", "7", PERIOD_START)],
    v1Reference: V1Reference.observed({
      source: V1_SOURCE,
      episodes: [mergeEpisode("theirs-1", "aa-org/renga", "9", PERIOD_START)],
    }),
    v1WriterLedger: V1WriterLedger.observed({
      source: V1_SOURCE,
      records: [
        new WrittenRecord({
          recordClass: "run",
          recordKey: "shared",
          firstWrittenAtMs: PERIOD_START + 90,
          lastWrittenAtMs: PERIOD_START + 90,
          store: V1_STORE,
        }),
      ],
    }),
    v1Ownership: V1OwnershipInput.observed({
      source: V1_SOURCE,
      runs: [v1Owned("shared", PERIOD_START + 90)],
    }),
  });
}

// --------------------------------------------------------------------------
// condition 2 -- the writer audit
// --------------------------------------------------------------------------

describe("condition 2 -- the writer audit", () => {
  test("a record written by both stores is a dual write finding", () => {
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-a", { created: PERIOD_START + 10 });
      addRun(cp, "run-b", { created: PERIOD_START + 20 });
    });

    const ledger = V1WriterLedger.observed({
      source: V1_SOURCE,
      records: [
        new WrittenRecord({
          recordClass: "run",
          recordKey: "run-b",
          firstWrittenAtMs: PERIOD_START + 15,
          lastWrittenAtMs: PERIOD_START + 40,
          store: V1_STORE,
        }),
      ],
    });
    const audit = withMeasurement(path, (connection) =>
      auditWriters(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
        v1Ledger: ledger,
      }),
    );

    expect(audit.findingCount).toBe(1);
    const finding = audit.findings[0];
    expect([finding?.recordClass, finding?.recordKey]).toEqual(["run", "run-b"]);
    // Both records survive whole: the instants are what a person reads next.
    expect(finding?.interlock.firstWrittenAtMs).toBe(PERIOD_START + 20);
    expect(finding?.v1.lastWrittenAtMs).toBe(PERIOD_START + 40);
    expect(finding?.v1.store).toBe(V1_STORE);
    expect(audit.interlockRecordCount).toBe(2);
    expect(audit.v1RecordCount).toBe(1);
  });

  test("the pull_request key is folded in SQL so a cased slug still collides", () => {
    // v1 spells the slug lowercase; the row preserves case, as the schema
    // requires. An independently spelled fold -- or none -- leaves the two keys
    // unequal and reports a clean audit over a repository both systems wrote.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRepository(cp, "repo-1", "Aa-Org", "Renga");
      addPullRequest(cp, {
        repoId: "repo-1",
        prNumber: 302,
        observedAtMs: PERIOD_START + 30,
      });
    });

    const ledger = V1WriterLedger.observed({
      source: V1_SOURCE,
      records: [
        new WrittenRecord({
          recordClass: "pull_request",
          recordKey: "github/aa-org/renga#302",
          firstWrittenAtMs: PERIOD_START + 31,
          lastWrittenAtMs: PERIOD_START + 31,
          store: V1_STORE,
        }),
      ],
    });
    const audit = withMeasurement(path, (connection) =>
      auditWriters(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
        v1Ledger: ledger,
      }),
    );

    expect(audit.findings.map((finding) => finding.recordKey)).toEqual(["github/aa-org/renga#302"]);
  });

  test("a record written only by one store is not a finding", () => {
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-a", { created: PERIOD_START + 10 });
    });

    const audit = withMeasurement(path, (connection) =>
      auditWriters(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
        v1Ledger: V1WriterLedger.observed({
          source: V1_SOURCE,
          records: [
            new WrittenRecord({
              recordClass: "run",
              recordKey: "run-elsewhere",
              firstWrittenAtMs: PERIOD_START,
              lastWrittenAtMs: PERIOD_START,
              store: V1_STORE,
            }),
          ],
        }),
      }),
    );

    expect(audit.findingCount).toBe(0);
    expect(audit.available).toBe(true);
  });

  test("the window test is write-span overlap, not last write inside", () => {
    // A record created before the window and updated after it is still
    // compared. The schema keeps a first and a last write and nothing between,
    // so such a record may well have been written inside the window.
    // Over-inclusion costs a candidate finding a person dismisses; the tighter
    // test drops the finding.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "spanning", { created: PERIOD_START - 1_000, updated: PERIOD_END + 1_000 });
      addRun(cp, "after", { created: PERIOD_END, updated: PERIOD_END });
      addRun(cp, "before", { created: PERIOD_START - 20, updated: PERIOD_START - 1 });
    });

    const records = withMeasurement(path, (connection) =>
      readInterlockRecords(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
      }),
    );

    expect(records.map((record) => record.recordKey)).toEqual(["spanning"]);
  });

  test("a v1 record in an unqueried class is refused, not skipped", () => {
    const path = productionDb();
    const refusal = withMeasurement(path, (connection) =>
      expectRefusal(
        () =>
          auditWriters(connection, {
            windowFromMs: PERIOD_START,
            windowToMs: PERIOD_END,
            v1Ledger: V1WriterLedger.observed({
              source: V1_SOURCE,
              records: [
                new WrittenRecord({
                  recordClass: "pending_decision",
                  recordKey: "pd-1",
                  firstWrittenAtMs: PERIOD_START,
                  lastWrittenAtMs: PERIOD_START,
                  store: V1_STORE,
                }),
              ],
            }),
          }),
        UndeclaredRecordClass,
      ),
    );
    expect(refusal.message).toContain("pending_decision");
  });

  test("an empty v1 read is absent and an attestation is a comparison", () => {
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-a", { created: PERIOD_START + 1 });
    });

    const { degraded, attested } = withMeasurement(path, (connection) => ({
      degraded: auditWriters(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
        v1Ledger: V1WriterLedger.observed({ source: V1_SOURCE, records: [] }),
      }),
      attested: auditWriters(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
        v1Ledger: V1WriterLedger.attestsEmpty({ source: V1_SOURCE }),
      }),
    }));

    expect(degraded.available).toBe(false);
    expect(degraded.absentReason ?? "").toContain("attestsEmpty");
    // The Interlock side is still counted, so the reader can see the audit had
    // something to compare against and no second list to compare it with.
    expect(degraded.interlockRecordCount).toBe(1);
    expect(attested.available).toBe(true);
    expect(attested.findingCount).toBe(0);
  });

  test("an input without provenance is refused", () => {
    expectRefusal(() => V1WriterLedger.observed({ source: "", records: [] }), V1InputRefused);
    expectRefusal(() => V1WriterLedger.attestsEmpty({ source: "" }), V1InputRefused);
    expectRefusal(() => V1WriterLedger.absent({ reason: "" }), V1InputRefused);
    expectRefusal(() => V1OwnershipInput.observed({ source: "", runs: [] }), V1InputRefused);
  });
});

// --------------------------------------------------------------------------
// conditions 3, 4, 6 -- the ownership ledger
// --------------------------------------------------------------------------

describe("conditions 3, 4, 6 -- the ownership ledger", () => {
  test("a run claimed by both is a finding and is not deduped", () => {
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "shared", { created: PERIOD_START + 100 });
      addRun(cp, "ours-only", { created: PERIOD_START + 200 });
    });

    const ledger = withMeasurement(path, (connection) =>
      buildOwnershipLedger(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
        v1Ownership: V1OwnershipInput.observed({
          source: V1_SOURCE,
          runs: [v1Owned("shared", PERIOD_START + 90), v1Owned("theirs-only", PERIOD_START + 300)],
        }),
      }),
    );

    expect(ledger.collisionRunIds()).toEqual(["shared"]);
    const finding = ledger.findings[0];
    expect(finding?.claims.map((claim) => claim.owningSystem)).toEqual(["interlock", "v1"]);
    expect(finding?.claims.map((claim) => claim.decidedAtMs)).toEqual([
      PERIOD_START + 100,
      PERIOD_START + 90,
    ]);
    // Not deduped: two Interlock runs plus two v1 claims are four ledger
    // entries, and 'shared' appears twice.
    expect(ledger.entries).toHaveLength(4);
    expect(ledger.entries.filter((entry) => entry.runId === "shared")).toHaveLength(2);
  });

  test("the collision check is not bounded by the listing window", () => {
    // The mid-flight case: the run started before the canary window. Bounding
    // the collision check by the window would blind it to exactly the run that
    // changed owner -- a run started on one side before the canary and
    // appearing on the other inside it.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "in-flight", { created: PERIOD_START - 5_000 });
    });

    const ledger = withMeasurement(path, (connection) =>
      buildOwnershipLedger(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
        v1Ownership: V1OwnershipInput.observed({
          source: V1_SOURCE,
          runs: [v1Owned("in-flight", PERIOD_START - 6_000)],
        }),
      }),
    );

    expect(ledger.collisionRunIds()).toEqual(["in-flight"]);
    // The Interlock claim is read from the row, not from the listing -- the
    // listing does not contain it, since the run started before the window.
    expect(ledger.findings[0]?.claims[0]?.decidedAtMs).toBe(PERIOD_START - 5_000);
    expect(ledger.entries.map((entry) => entry.runId)).toEqual(["in-flight"]);
  });

  test("one side claiming a run twice is refused, not filed as divergence", () => {
    const refusal = expectRefusal(
      () =>
        V1OwnershipInput.observed({
          source: V1_SOURCE,
          runs: [v1Owned("dup", PERIOD_START), v1Owned("dup", PERIOD_START + 1)],
        }),
      OwnershipInputRefused,
    );
    expect(refusal.message).toContain("dup");
  });

  test("an absent v1 ownership input reports no collision and says why", () => {
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-a", { created: PERIOD_START + 1 });
    });

    const ledger = withMeasurement(path, (connection) =>
      buildOwnershipLedger(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
        v1Ownership: V1OwnershipInput.observed({ source: V1_SOURCE, runs: [] }),
      }),
    );

    expect(ledger.available).toBe(false);
    expect(ledger.findingCount).toBe(0);
    expect(ledger.entries).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// condition 5 -- the read-only assertion, off the live connection
// --------------------------------------------------------------------------

describe("condition 5 -- the read-only assertion", () => {
  test("the read-only evidence comes off the live connection", () => {
    const path = productionDb();
    const evidence = withMeasurement(path, (connection) => evidenceOfReadOnly(connection));

    expect(evidence.queryOnly).toBe(1);
    expect(evidence.queryOnlyAfterProbe).toBe(1);
    // The path is not an argument to the checker: it can only have come from
    // the connection itself.
    expect(realpathSync(evidence.databasePath)).toBe(realpathSync(path));
    expect(evidence.uri.endsWith("?mode=ro")).toBe(true);
    expect(evidence.uri).toContain(basename(path));
  });

  test("a writable connection is refused", () => {
    const path = productionDb();
    const refusal = withWritable(path, (connection) =>
      expectRefusal(() => evidenceOfReadOnly(connection), ReadOnlyCapabilityRefused),
    );
    expect(refusal.message).toContain("query_only");
  });

  test("a claim of read-only does not substitute for the capability", () => {
    // Read-write, with `query_only` raised by hand: convention, not capability.
    // This connection satisfies every claim a report could print about itself.
    // Only asking the file separates it from one opened `mode=ro`, which is the
    // distinction condition 5 is drawing.
    const path = productionDb();
    const refusal = withWritable(path, (connection) => {
      connection.pragma("query_only = ON");
      return expectRefusal(() => evidenceOfReadOnly(connection), ReadOnlyCapabilityRefused);
    });
    // ADAPTED. The source greps this refusal for `mode=ro`, which is how it
    // shows the check reached the FILE probe rather than stopping at the
    // pragma. continuo opens read-only by SQLITE_OPEN_READONLY rather than by a
    // `mode=ro` URI (D-0100), and reader.ts's refusal says so in those words,
    // so the marker that proves the same thing is the open-flag wording. The
    // reading under test is unchanged: a connection that satisfies every claim
    // is caught only by asking the file.
    expect(refusal.message).toContain("was not opened read-only");
    expect(refusal.message).toContain("did not carry the capability");
  });

  test("a connection with no file cannot evidence the capability", () => {
    const connection = new Database(":memory:");
    connection.pragma("query_only = ON");
    try {
      const refusal = expectRefusal(
        () => evidenceOfReadOnly(connection),
        ReadOnlyCapabilityRefused,
      );
      expect(refusal.message).toContain("no file");
    } finally {
      connection.close();
    }
  });

  test("the report refuses before it measures anything", () => {
    // A writable connection stops the report, however much data is behind it.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "shared", { created: PERIOD_START + 1 });
    });

    withWritable(path, (connection) => {
      expectRefusal(
        () =>
          measureCanaryDivergence(connection, {
            periodStartMs: PERIOD_START,
            periodEndMs: PERIOD_END,
            interlockEpisodes: [],
            v1Reference: V1Reference.attestsEmpty({ source: V1_SOURCE }),
            censoredIds: new Set<string>(),
            fixtureLabels: new Map(),
            v1WriterLedger: V1WriterLedger.attestsEmpty({ source: V1_SOURCE }),
            v1Ownership: V1OwnershipInput.observed({
              source: V1_SOURCE,
              runs: [v1Owned("shared", PERIOD_START)],
            }),
          }),
        ReadOnlyCapabilityRefused,
      );
    });
  });
});

// --------------------------------------------------------------------------
// the report: no verdict, and no missing comparison passed off as a clean one
// --------------------------------------------------------------------------

describe("the report: no verdict, and no missing comparison passed off as a clean one", () => {
  test("the report states both findings and still emits no verdict", () => {
    const report = reportWithBothFindings(productionDb());

    expect(Object.fromEntries(report.findingCounts())).toEqual({
      [DUAL_WRITE]: 1,
      [OWNERSHIP_COLLISION]: 1,
    });
    const rendered = renderCanaryDivergenceReport(report);

    // The moment a harness would slip a verdict in is the moment something is
    // wrong, so the grep runs over the rendering that has findings in it.
    expect(VERDICT_WORDS.exec(rendered), rendered).toBeNull();
    expect(rendered).toContain("Q-0005");
    expect(rendered).toContain("no verdict on the canary");
    expect(rendered).toContain("VIOLATED");
    expect(rendered).toContain("shared");
    expect(isAscii(rendered)).toBe(true);
  });

  test("a report with no findings also emits no verdict", () => {
    const report = reportOver(productionDb(), {
      v1Reference: V1Reference.attestsEmpty({ source: V1_SOURCE }),
      v1WriterLedger: V1WriterLedger.attestsEmpty({ source: V1_SOURCE }),
      v1Ownership: V1OwnershipInput.attestsEmpty({ source: V1_SOURCE }),
    });
    const rendered = renderCanaryDivergenceReport(report);

    expect(Object.fromEntries(report.findingCounts())).toEqual({
      [DUAL_WRITE]: 0,
      [OWNERSHIP_COLLISION]: 0,
    });
    expect(VERDICT_WORDS.exec(rendered), rendered).toBeNull();
    expect(rendered).not.toContain("VIOLATED");
  });

  test("an empty v1 input renders and says there is no shadow reference", () => {
    // Every section says a comparison did not happen, rather than showing zero.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-a", { created: PERIOD_START + 1 });
    });

    const report = reportOver(path, {
      interlockEpisodes: [mergeEpisode("ours-1", "aa-org/renga", "7", PERIOD_START)],
      v1Reference: V1Reference.observed({ source: V1_SOURCE, episodes: [] }),
      v1WriterLedger: V1WriterLedger.observed({ source: V1_SOURCE, records: [] }),
      v1Ownership: V1OwnershipInput.observed({ source: V1_SOURCE, runs: [] }),
    });
    const rendered = renderCanaryDivergenceReport(report);

    expect(report.reconciliation.available).toBe(false);
    expect(rendered).toContain("shadow reference: ABSENT");
    expect(rendered).toContain("v1 store: ABSENT");
    expect(rendered).toContain("v1 claims: ABSENT");
    expect(rendered).toContain("not evidence that none was");
    expect(rendered).toContain("only visible as a run both systems claim");
    // The instrument was still evidenced: an absent comparison is not an absent
    // read-only assertion.
    expect(rendered).toContain("PRAGMA query_only: 1");
    expect(rendered).toContain("?mode=ro");
    expect(VERDICT_WORDS.exec(rendered), rendered).toBeNull();
  });

  test("an empty period is refused", () => {
    const path = productionDb();
    withMeasurement(path, (connection) => {
      expectRefusal(
        () =>
          measureCanaryDivergence(connection, {
            periodStartMs: PERIOD_END,
            periodEndMs: PERIOD_END,
            interlockEpisodes: [],
            v1Reference: V1Reference.attestsEmpty({ source: V1_SOURCE }),
            censoredIds: new Set<string>(),
            fixtureLabels: new Map(),
            v1WriterLedger: V1WriterLedger.attestsEmpty({ source: V1_SOURCE }),
            v1Ownership: V1OwnershipInput.attestsEmpty({ source: V1_SOURCE }),
          }),
        CanaryRefusal,
      );
    });
  });

  test("the query definitions are the queries that run", () => {
    // Provenance that is the executed text, not a description of it.
    for (const recordClass of RECORD_CLASSES) {
      expect(QUERY_DEFINITIONS.get(`record_class:${recordClass.name}`)).toBe(recordClass.sql);
    }
    expect(new Set([RECORD_CLASS_RUN.name, RECORD_CLASS_PULL_REQUEST.name])).toEqual(
      new Set(["run", "pull_request"]),
    );
  });
});

// --------------------------------------------------------------------------
// properties the ported cases leave unguarded (target-only)
// --------------------------------------------------------------------------

describe("properties the ported cases leave unguarded (target-only)", () => {
  test("a read-only file with the connection guard down is still refused", () => {
    // Target-only, and INHERITED: deleting the first reading (`query_only` as
    // found) changes nothing on either side, because every connection the
    // ported cases hand over that fails the pragma also fails the file probe,
    // and the probe's own refusal happens to contain the word `query_only`.
    // The two readings are not the same reading. A handle opened against a
    // read-only FILE with the connection guard down passes the probe and is
    // exactly what reading 1 exists to catch: the report would then be measured
    // through a connection whose guard nothing had checked.
    const path = productionDb();
    const connection = new Database(path, { readonly: true });
    try {
      connection.pragma("query_only = OFF");
      const refusal = expectRefusal(
        () => evidenceOfReadOnly(connection),
        ReadOnlyCapabilityRefused,
      );
      expect(refusal.message).toContain("PRAGMA query_only reads back as 0");
    } finally {
      connection.close();
    }
  });

  test("a probe that leaves the guard lowered is refused", () => {
    // Target-only, and INHERITED: nothing on either side can reach the
    // post-probe re-read, because the only thing in the harness that lowers
    // `query_only` is the probe and the real probe restores it. The guard is
    // still load-bearing -- it is what stops the harness disarming itself while
    // checking that it was armed -- so it is exercised here by substituting the
    // probe through the seam record (D-0014), which is the same late binding
    // Python gets from module-level name resolution.
    const path = productionDb();
    // Patched AFTER the open: openForMeasurement proves the capability through
    // the same seam, so a probe substituted earlier would fail the open instead
    // of the guard this case is about.
    const refusal = withMeasurement(path, (connection) => {
      patchSeam(readerSeams, "proveReadOnly", (handle) => {
        handle.pragma("query_only = OFF");
      });
      return expectRefusal(() => evidenceOfReadOnly(connection), ReadOnlyCapabilityRefused);
    });
    expect(refusal.message).toContain("after the file-mode probe");
    expect(refusal.message).toContain("disarmed itself");
  });

  test("two record classes spelling the same key do not pair", () => {
    // Target-only, and INHERITED: no case on either side gives two record
    // classes the same key, so the class's presence in the identity is
    // unexercised. A run may legitimately be named anything, including the very
    // string the pull_request key shape produces, and pairing across classes
    // would report a dual write of a record neither store wrote.
    const path = productionDb();
    const collidingKey = "github/aa-org/renga#302";
    withWritable(path, (cp) => {
      addRun(cp, collidingKey, { created: PERIOD_START + 10 });
    });

    const audit = withMeasurement(path, (connection) =>
      auditWriters(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
        v1Ledger: V1WriterLedger.observed({
          source: V1_SOURCE,
          records: [
            new WrittenRecord({
              recordClass: "pull_request",
              recordKey: collidingKey,
              firstWrittenAtMs: PERIOD_START,
              lastWrittenAtMs: PERIOD_START,
              store: V1_STORE,
            }),
          ],
        }),
      }),
    );

    expect(audit.findingCount).toBe(0);
    expect(audit.interlockRecordCount).toBe(1);
  });

  test("a record key carrying the identity separator cannot forge a pairing", () => {
    // Target-only, and a PORT DIVERGENCE the codex review gate caught. Python
    // keys the identity by the tuple `(record_class, record_key)`, which cannot
    // be ambiguous; a JavaScript Map compares tuples by reference, so this port
    // has to spell the pair as one string. The first spelling joined the two
    // halves with a unit separator, and BOTH halves are caller-supplied here --
    // the class name through `recordClasses`, the key through the v1 adapter --
    // so nothing ruled the separator out and two different records could spell
    // one identity. The encoding is length-prefixed now; this case is the
    // ambiguity, built on purpose.
    const path = productionDb();
    const forged = new RecordClass({
      // Its records spell ("a<US>b", "c"), which a bare join renders exactly as
      // the v1 record ("a", "b<US>c") below.
      name: "a\u001fb",
      keyShape: "anything",
      sql: "SELECT 'c' AS record_key, 0 AS first_written_at_ms, 0 AS last_written_at_ms",
    });

    const audit = withMeasurement(path, (connection) =>
      auditWriters(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
        v1Ledger: V1WriterLedger.observed({
          source: V1_SOURCE,
          records: [
            // ("a", "b<US>c") against the database's ("a<US>b", "c"): one
            // string under a bare join, two records under any injective
            // encoding.
            new WrittenRecord({
              recordClass: "a",
              recordKey: "b\u001fc",
              firstWrittenAtMs: PERIOD_START,
              lastWrittenAtMs: PERIOD_START,
              store: V1_STORE,
            }),
          ],
        }),
        recordClasses: [forged, new RecordClass({ name: "a", keyShape: "k", sql: forged.sql })],
      }),
    );

    expect(audit.findingCount).toBe(0);
  });

  test("the writer audit prints its own VIOLATED line", () => {
    // Target-only, and INHERITED: the ported case asserts `VIOLATED` appears in
    // the rendering, and the ownership section prints its own VIOLATED line for
    // the same fixture -- so suppressing the writer audit's line leaves the
    // assertion passing while condition 2's violation goes unstated in the
    // section that found it.
    const rendered = renderCanaryDivergenceReport(reportWithBothFindings(productionDb()));
    expect(rendered).toContain("Condition 2 (no dual write) is VIOLATED for the records above.");
    expect(rendered).toContain("Conditions 3, 4 and 6");
  });

  test("an ownership input past SQLite's parameter ceiling is chunked, not refused", () => {
    // Target-only, and INHERITED: the ceiling is real -- this build accepts
    // 32,766 bound parameters and fails at 32,767 -- and no case on either side
    // passes more than a handful of run ids, so the chunking is unexercised.
    // The collision is planted at the very end so a loop that stopped after its
    // first chunk would report no finding rather than crash.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "the-last-one", { created: PERIOD_START + 1 });
    });

    const runs = Array.from({ length: 33_000 }, (_unused, index) =>
      v1Owned(`v1-run-${index}`, PERIOD_START),
    );
    runs.push(v1Owned("the-last-one", PERIOD_START));

    const ledger = withMeasurement(path, (connection) =>
      buildOwnershipLedger(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
        v1Ownership: V1OwnershipInput.observed({ source: V1_SOURCE, runs }),
      }),
    );

    expect(ledger.collisionRunIds()).toEqual(["the-last-one"]);
  });

  test("the whole report is read inside one snapshot", () => {
    // Target-only, and INHERITED: nothing on either side observes the
    // transaction, so removing the snapshot changes no assertion -- while the
    // defect it prevents is a report whose writer audit and ownership ledger
    // describe two different states of the database, reported as a divergence
    // that never existed. Observed here through a SQLite user function called
    // from a record class's own statement, so the reading is taken from inside
    // the measurement rather than around it.
    const path = productionDb();
    const observed: boolean[] = [];
    const report = withMeasurement(path, (connection) => {
      connection.function("observe_transaction", () => {
        observed.push(connection.inTransaction);
        return 0;
      });
      const probeClass = new RecordClass({
        name: "run",
        keyShape: "run_id",
        sql: "SELECT 'probe' AS record_key, observe_transaction() AS first_written_at_ms, 0 AS last_written_at_ms",
      });
      return measureCanaryDivergence(connection, {
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        interlockEpisodes: [],
        v1Reference: V1Reference.attestsEmpty({ source: V1_SOURCE }),
        censoredIds: new Set<string>(),
        fixtureLabels: new Map(),
        v1WriterLedger: V1WriterLedger.attestsEmpty({ source: V1_SOURCE }),
        v1Ownership: V1OwnershipInput.attestsEmpty({ source: V1_SOURCE }),
        recordClasses: [probeClass],
      });
    });

    expect(observed).toEqual([true]);
    expect(report.writerAudit.interlockRecordCount).toBe(1);
  });
});

describe("hostile values in the rendering (target-only)", () => {
  test("a v1 record key cannot forge a line and cannot reach a cp932 console", () => {
    // Target-only, and `D-0109`. Found by reading the renderer, not from a
    // ledger disclosure -- this module was not among the three the inventory
    // listed. A v1 adapter supplies the record class, the record key and its
    // own store name, and all three went into the finding line verbatim.
    const hostileKey = "shared\n    - forged: 0";
    const path = productionDb();
    withWritable(path, (cp) => {
      // run_id is unconstrained TEXT, so the dual write is real: the key the v1
      // adapter hands over is a run this database genuinely holds, and the
      // finding line prints it.
      addRun(cp, hostileKey, { created: PERIOD_START + 100 });
    });

    const report = reportOver(path, {
      v1Reference: V1Reference.attestsEmpty({ source: V1_SOURCE }),
      v1WriterLedger: V1WriterLedger.observed({
        source: "v1\u2014adapter",
        records: [
          new WrittenRecord({
            recordClass: "run",
            recordKey: hostileKey,
            firstWrittenAtMs: PERIOD_START + 90,
            lastWrittenAtMs: PERIOD_START + 90,
            store: V1_STORE,
          }),
        ],
      }),
      v1Ownership: V1OwnershipInput.attestsEmpty({ source: V1_SOURCE }),
    });
    const rendered = renderCanaryDivergenceReport(report);

    expect(isAscii(rendered)).toBe(true);
    expect(rendered).toContain("\\u2014");
    expect(report.writerAudit.findingCount).toBe(1);
    // Asserted on the FINDING line specifically. A first version of this case
    // asserted only that the rendering contained an escaped newline somewhere,
    // and passed with the record key unescaped -- the escape it was seeing came
    // from the run id in the ownership ledger, which is a different value
    // escaped by a different call.
    const findingLines = rendered
      .split("\n")
      .filter((line) => line.trimStart().startsWith("- run "));
    expect(findingLines).toHaveLength(1);
    expect(findingLines[0]).toContain("shared\\u000a    - forged: 0");
    // The forged line did not become a line: the finding is one row.
    expect(
      rendered.split("\n").filter((line) => line.trimStart().startsWith("- run ")),
    ).toHaveLength(1);
  });
});

describe("every externally-supplied field at once (target-only)", () => {
  /**
   * A value that is hostile in BOTH ways at once.
   *
   * Carrying only a newline hides from an ASCII assertion, and carrying only a
   * non-ASCII character hides from a line-count one. A first version of the
   * case below mixed the two and left eight of this renderer's fifteen escaping
   * sites unexercised -- measured by reverting each site in turn.
   */
  function hostile(label: string): string {
    return `${label}\u2014x\n    - forged: ${label}`;
  }

  test("a canary report whose every caller value is hostile still renders one report", () => {
    // Target-only, and the structural form of the D-0109 check. This report
    // embeds the shadow reconciliation as well as its own three sections, so it
    // is the widest surface in the harness.
    // The URI is built from the path the connection reports, so the hostile
    // value for it is the directory the database sits in.
    const path = join(caseRoot("canary\u2014dir"), "production.sqlite3");
    createProductionControlPlane(path, { nowMs: T0 }).close();
    const hostileRun = hostile("shared");
    withWritable(path, (cp) => {
      addRun(cp, hostileRun, { created: PERIOD_START + 100 });
    });

    const report = reportOver(path, {
      interlockEpisodes: [mergeEpisode(hostile("ours-1"), "aa-org/renga", "7", PERIOD_START)],
      v1Reference: V1Reference.observed({
        source: hostile("v1-shadow"),
        episodes: [mergeEpisode(hostile("theirs-1"), "aa-org/renga", "9", PERIOD_START)],
      }),
      v1WriterLedger: V1WriterLedger.observed({
        source: hostile("v1-writer"),
        records: [
          new WrittenRecord({
            recordClass: "run",
            recordKey: hostileRun,
            firstWrittenAtMs: PERIOD_START + 90,
            lastWrittenAtMs: PERIOD_START + 90,
            store: hostile("v1-store"),
          }),
        ],
      }),
      v1Ownership: V1OwnershipInput.observed({
        source: hostile("v1-owner"),
        runs: [
          new OwnedRun({
            runId: hostileRun,
            owningSystem: hostile("v1-system"),
            decidedAtMs: PERIOD_START + 90,
            store: hostile("v1-store"),
          }),
        ],
      }),
    });
    const rendered = renderCanaryDivergenceReport(report);

    expect(isAscii(rendered)).toBe(true);
    // One dual-write finding line and one collision line, whatever the values
    // tried to open.
    expect(
      rendered.split("\n").filter((line) => line.trimStart().startsWith("- run ")),
    ).toHaveLength(1);
    expect(rendered.split("\n").filter((line) => line.includes("claimed by"))).toHaveLength(1);
    expect(rendered.split("\n").filter((line) => line.trimStart().startsWith("- forged"))).toEqual(
      [],
    );
    // The URI cannot be driven hostile at all, and that is worth pinning rather
    // than asserting: pathToFileURL percent-encodes every non-ASCII byte and
    // every control character, so `evidence.uri` is always printable ASCII
    // however the database's directory is named. Its reportValue call is
    // therefore unreachable -- kept as defence in depth against a change to how
    // the line is built, and recorded as unreachable in the ledger.
    const uriLine = rendered.split("\n").find((line) => line.startsWith("  uri: "));
    expect(isAscii(uriLine as string)).toBe(true);
    // Pinned as a PROPERTY, not as a whole href. pathToFileURL resolves a
    // POSIX-rooted path against the current drive on Windows, so the same call
    // yields `file:///D:/tmp/...` on those cells and `file:///tmp/...` on the
    // others. The premise this case rests on is the percent-encoding, not the
    // root -- an earlier version compared the entire string and so failed only
    // on the Windows cells, for a reason that had nothing to do with escaping.
    for (const hostile of ["/tmp/a\u2014b/c.sqlite3", "/tmp/a\nb/c.sqlite3"]) {
      expect(isAscii(pathToFileURL(hostile).href)).toBe(true);
    }
    expect(pathToFileURL("/tmp/a\u2014b/c.sqlite3").href).toContain("a%E2%80%94b");
    expect(pathToFileURL("/tmp/a\nb/c.sqlite3").href).toContain("a%0Ab");
  });

  test("a caller-named record class is escaped where the audit prints it", () => {
    // recordClasses is an ARGUMENT, so the class name is the caller's too, and
    // it prints in the audited-classes summary and in every finding line. No
    // other case supplies one: they all take the two shipped classes.
    const path = productionDb();
    const className = hostile("run");
    withWritable(path, (cp) => {
      addRun(cp, "r1", { created: PERIOD_START + 10 });
    });

    const audit = withMeasurement(path, (connection) =>
      auditWriters(connection, {
        windowFromMs: PERIOD_START,
        windowToMs: PERIOD_END,
        recordClasses: [
          new RecordClass({ name: className, keyShape: "run_id", sql: RECORD_CLASS_RUN.sql }),
        ],
        v1Ledger: V1WriterLedger.observed({
          source: hostile("v1"),
          records: [
            new WrittenRecord({
              recordClass: className,
              recordKey: "r1",
              firstWrittenAtMs: PERIOD_START,
              lastWrittenAtMs: PERIOD_START,
              store: hostile("v1-store"),
            }),
          ],
        }),
      }),
    );

    expect(audit.findingCount).toBe(1);
    expect(audit.recordClasses).toEqual([className]);
    // The audit is rendered through the whole report, which is where the two
    // call sites for a class name are.
    const rendered = renderCanaryDivergenceReport(
      reportOver(path, {
        v1Reference: V1Reference.attestsEmpty({ source: V1_SOURCE }),
        v1WriterLedger: V1WriterLedger.observed({
          source: hostile("v1"),
          records: [
            new WrittenRecord({
              recordClass: className,
              recordKey: "r1",
              firstWrittenAtMs: PERIOD_START,
              lastWrittenAtMs: PERIOD_START,
              store: hostile("v1-store"),
            }),
          ],
        }),
        v1Ownership: V1OwnershipInput.attestsEmpty({ source: V1_SOURCE }),
        recordClasses: [
          new RecordClass({ name: className, keyShape: "run_id", sql: RECORD_CLASS_RUN.sql }),
        ],
      }),
    );

    expect(isAscii(rendered)).toBe(true);
    expect(
      rendered.split("\n").filter((line) => line.startsWith("  record classes audited:")),
    ).toHaveLength(1);
    expect(rendered.split("\n").filter((line) => line.trimStart().startsWith("- forged"))).toEqual(
      [],
    );
  });

  test("the same report with every v1 side absent is also fully escaped", () => {
    // The absence branches print their own reasons and are reached by no case
    // above: an absent writer ledger, an absent ownership input and an absent
    // shadow reference each render a `reason:` line the caller supplied.
    const path = productionDb();
    const report = reportOver(path, {
      v1Reference: V1Reference.absent({ reason: hostile("no shadow") }),
      v1WriterLedger: V1WriterLedger.absent({ reason: hostile("no writer ledger") }),
      v1Ownership: V1OwnershipInput.absent({ reason: hostile("no ownership") }),
    });
    const rendered = renderCanaryDivergenceReport(report);

    expect(isAscii(rendered)).toBe(true);
    // Three: the embedded reconciliation's, the writer audit's and the
    // ownership ledger's, each printing the reason its own caller supplied.
    expect(rendered.split("\n").filter((line) => line.startsWith("  reason: "))).toHaveLength(3);
    expect(rendered.split("\n").filter((line) => line.trimStart().startsWith("- forged"))).toEqual(
      [],
    );
  });
});
