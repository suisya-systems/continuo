/**
 * The header's one hard claim: two reports with one digest saw one content.
 *
 * Ported from interlock `tests/measurement/test_provenance.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping, the one case
 * deferred, and the cases that are adapted rather than translated straight are
 * recorded in `parity/measurement.provenance.ledger.json`.
 *
 * Everything else in `provenance.ts` is transcription -- section 6's table into
 * a class -- and transcription is checked by asserting the fields are there.
 * One field is not transcription, and it is the one this file is built around.
 *
 * `db_fingerprint` asserts that two reads were over the same content. The cheap
 * implementation section 6 rejected (row counts plus `MAX(seq)`/`MAX(rowid)`)
 * passes every test that inserts rows and asserts the digest moved, because
 * inserting moves a count. It fails only on the case that actually happens in
 * this schema: an **in-place UPDATE** -- an `outbox` status, a `gate` outcome, a
 * `usage_status` backfilled by a late adapter. So the first case builds exactly
 * that edit, *asserts in the test body* that the count and the maximum did not
 * move, and then asserts the content digest did -- and its twin asserts the
 * aggregate digest did **not**, which is what makes the aggregate mode
 * demonstrably the weaker thing the header says it is rather than a synonym.
 *
 * The other adversarial edges here:
 *
 * * the digest is scoped to the tables it names, proved by writing into a table
 *   outside the list and asserting the digest is byte-identical -- a
 *   fingerprint that quietly covered everything would pass the update tests and
 *   mean something else;
 * * the banner cannot be rendered around, proved by asserting it in *both*
 *   renderings for both causes section 6 names (a second detector version, and
 *   a policy revision that changed mid-period);
 * * the section-6 field list is parametrised over a list written from the
 *   document and checked against both renderings, so a field dropped from one
 *   rendering fails even though the other still carries it.
 *
 * Nothing here recomputes a digest to compare against: the tests compare
 * digests this module produced under two states of the world, which is the
 * property the field claims, and no reimplementation of the hash can make that
 * assertion pass by agreeing with itself.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { TOOL_VERSION } from "../../src/about.js";
import {
  completeInvocation,
  ProviderUsage,
  startInvocation,
} from "../../src/control_plane/ai_invocation.js";
import {
  appliedMigrations,
  createProductionControlPlane,
  PRODUCTION_APPLICATION_ID,
} from "../../src/control_plane/migrator.js";
import { effectiveRevisionId } from "../../src/control_plane/policy.js";
import { loadCorpus } from "../../src/measurement/fixtures.js";
import { isAscii } from "../../src/measurement/format.js";
import {
  AGGREGATE_STATEMENT,
  BOUNDED_IMPUTATION_RULE,
  buildHeader,
  CONTENT_STATEMENT,
  CoverageSummary,
  FINGERPRINT_AGGREGATE,
  FINGERPRINT_CONTENT,
  FingerprintModeRefused,
  FixtureSuiteRef,
  fingerprintDatabase,
  fixtureSuiteRef,
  HEADER_QUERIES,
  ImputationRule,
  iso8601Ms,
  NotAProductionDatabase,
  PeriodRefused,
  ProvenanceRefusal,
  QueryCatalogue,
  QueryDefinitionsRefused,
  queryCatalogue,
  type ReportHeader,
  RevisionNotInPeriod,
  renderHeaderJson,
  renderHeaderMarkdown,
  SENSITIVITY_IMPUTATION_RULE,
  TableNotReadable,
} from "../../src/measurement/provenance.js";
import { openForMeasurement } from "../../src/measurement/reader.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";

const T0 = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const PERIOD_START = T0;
const PERIOD_END = T0 + DAY_MS;
const GENERATED_AT = PERIOD_END + 60_000;

/**
 * The tables a report of this shape reads. Named here so every test scopes its
 * fingerprint the same way and a test that widens the scope has to say so.
 */
const READ_TABLES: readonly string[] = ["incident", "ai_invocation", "run"];

/**
 * The query set a caller supplies. Deliberately not one of HEADER_QUERIES'
 * names, so the merge is exercised on every header built here.
 */
const CALLER_QUERIES: ReadonlyMap<string, string> = new Map([
  ["caller_incidents", "SELECT count(*) FROM incident"],
]);

/**
 * Section 6's table, field for field, as the document lists it -- written out
 * here rather than read off `asMapping()`, so that a field deleted from the
 * implementation fails these tests instead of quietly shrinking the list they
 * check.
 */
const SECTION_6_FIELDS: readonly string[] = [
  "period_start_ms",
  "period_start_iso",
  "period_end_ms",
  "period_end_iso",
  "generated_at_ms",
  "tool_version",
  "db_path",
  "application_id",
  "database_is_production",
  "user_version",
  "schema_migration_head.version",
  "schema_migration_head.name",
  "db_fingerprint",
  "fingerprint_mode",
  "policy_revision_id",
  "detector_versions",
  "adapter_versions",
  "query_definitions",
  "query_definitions_sha256",
  "fixture_suite_ref.commit",
  "fixture_suite_ref.positive",
  "fixture_suite_ref.negative",
  "imputation_rule.bounded",
  "imputation_rule.sensitivity",
  "imputation_rule.unbounded_missing",
  "coverage.covered",
  "coverage.total",
  "coverage.excluded",
  "censored",
  "censored_left",
  "unmatched",
];

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/** The source's `db` fixture, as a per-test call (rule 8). */
function productionDb(): string {
  const path = join(caseRoot("provenance"), "production.sqlite3");
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

function withMeasurement<T>(path: string, body: (connection: SqliteDatabase) => T): T {
  const connection = openForMeasurement(path);
  try {
    return body(connection);
  } finally {
    connection.close();
  }
}

function seedRevisionId(path: string): number {
  return withMeasurement(path, (connection) =>
    effectiveRevisionId(connection, { nowMs: PERIOD_START }),
  );
}

function addRun(cp: SqliteDatabase, runId: string): string {
  cp.prepare(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'completed', ?, ?)",
  ).run(runId, PERIOD_START + 1, PERIOD_START + 2);
  return runId;
}

function addIncident(
  cp: SqliteDatabase,
  incidentId: string,
  fields: {
    readonly runId?: string | null;
    readonly detectorVersion?: string;
    readonly createdAtMs?: number;
    readonly factState?: string;
  } = {},
): string {
  const createdAtMs = fields.createdAtMs ?? PERIOD_START + 10;
  cp.prepare(
    `
        INSERT INTO incident (incident_id, run_id, session_id, fact_state,
                              detector_version, dedup_key, created_at_ms,
                              updated_at_ms)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
        `,
  ).run(
    incidentId,
    fields.runId ?? null,
    fields.factState ?? "stalled",
    fields.detectorVersion ?? "detector/1",
    `dedup/${incidentId}`,
    createdAtMs,
    createdAtMs,
  );
  return incidentId;
}

function addInvocation(
  cp: SqliteDatabase,
  invocationId: string,
  fields: {
    readonly adapterVersion: string;
    readonly incidentId?: string | null;
    readonly runId?: string | null;
    readonly startedAtMs?: number;
  },
): string {
  startInvocation(cp, {
    invocationId,
    provider: "anthropic",
    model: "a-model",
    adapterVersion: fields.adapterVersion,
    startedAtMs: fields.startedAtMs ?? PERIOD_START + 20,
    incidentId: fields.incidentId ?? null,
    runId: fields.runId ?? null,
    maxOutputTokens: 4096,
  });
  return invocationId;
}

/** A second policy revision taking effect inside the period. */
function addRevision(cp: SqliteDatabase, effectiveAtMs: number): number {
  cp.prepare(
    "INSERT INTO policy_revision (note, decided_by, effective_at_ms) VALUES ('a later time base', 'D-0031', ?)",
  ).run(effectiveAtMs);
  return Number(
    (cp.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint }).id,
  );
}

function headerOver(
  path: string,
  options: {
    readonly revisionId: number;
    readonly fingerprintMode?: string;
    readonly queryDefinitions?: ReadonlyMap<string, string>;
    readonly fixtureSuite?: FixtureSuiteRef;
    readonly censored?: number;
    readonly censoredLeft?: number;
    readonly unmatched?: ReadonlyMap<string, number>;
    readonly periodStartMs?: number;
    readonly periodEndMs?: number;
    readonly generatedAtMs?: number;
    readonly fingerprintTables?: readonly string[];
  },
): ReportHeader {
  return withMeasurement(path, (connection) =>
    buildHeader(connection, {
      dbPath: path,
      periodStartMs: options.periodStartMs ?? PERIOD_START,
      periodEndMs: options.periodEndMs ?? PERIOD_END,
      generatedAtMs: options.generatedAtMs ?? GENERATED_AT,
      policyRevisionId: options.revisionId,
      fingerprintTables: options.fingerprintTables ?? READ_TABLES,
      queryDefinitions: options.queryDefinitions ?? CALLER_QUERIES,
      fixtureSuite:
        options.fixtureSuite ??
        new FixtureSuiteRef({
          commit: "c0ffee",
          positive: 4,
          negative: 2,
          contentDigest: "deadbeef",
        }),
      imputation: new ImputationRule({
        bounded: BOUNDED_IMPUTATION_RULE,
        sensitivity: SENSITIVITY_IMPUTATION_RULE,
        unboundedMissing: 0,
      }),
      coverage: new CoverageSummary({
        covered: 3,
        total: 4,
        excluded: new Map([
          ["v1_owned", 0],
          ["in_flight", 1],
        ]),
      }),
      censored: options.censored ?? 3,
      censoredLeft: options.censoredLeft ?? 1,
      unmatched: options.unmatched ?? new Map([["unmatched_key", 2]]),
      fingerprintMode: options.fingerprintMode ?? FINGERPRINT_CONTENT,
    }),
  );
}

function fingerprintOf(
  path: string,
  options: { readonly mode?: string; readonly tables?: readonly string[] } = {},
) {
  return withMeasurement(path, (connection) =>
    fingerprintDatabase(connection, {
      tables: options.tables ?? READ_TABLES,
      mode: options.mode ?? FINGERPRINT_CONTENT,
    }),
  );
}

/**
 * What the rejected aggregate fingerprint is made of, read independently.
 *
 * Used to *prove* the premise of the update tests -- that the cheap form has
 * nothing to notice -- rather than asserting it in prose.
 */
function countsAndMaxima(path: string): Record<string, [number, number | null]> {
  return withMeasurement(path, (connection) => {
    const result: Record<string, [number, number | null]> = {};
    for (const table of READ_TABLES) {
      const row = connection
        .prepare(`SELECT COUNT(*) AS n, MAX(rowid) AS m FROM ${table}`)
        .get() as { n: number; m: number | null };
      result[table] = [Number(row.n), row.m === null ? null : Number(row.m)];
    }
    return result;
  });
}

/** One run, one incident, one invocation: enough for every table read. */
function populate(path: string): void {
  withWritable(path, (cp) => {
    const runId = addRun(cp, "run-1");
    const incidentId = addIncident(cp, "inc-1", { runId });
    addInvocation(cp, "invocation-1", {
      adapterVersion: "adapter/1",
      incidentId,
      runId,
    });
  });
}

/**
 * The late adapter finally answers: an in-place fill-in, through the real writer.
 *
 * Section 6 names this edit by name -- "a `usage_status` backfilled by a late
 * adapter" -- and it is written here through `completeInvocation` rather than
 * by hand, so the test is over the update the system actually performs.
 */
function backfillUsage(path: string): void {
  withWritable(path, (cp) => {
    completeInvocation(cp, {
      invocationId: "invocation-1",
      usage: ProviderUsage.reported({ adapterVersion: "adapter/1", outputTokens: 1_200 }),
      modelResponseCount: 1,
      finishedAtMs: PERIOD_START + 25,
    });
    const row = cp
      .prepare("SELECT usage_status FROM ai_invocation WHERE invocation_id = 'invocation-1'")
      .get() as { usage_status: string };
    expect(row.usage_status, "the premise of the update tests: the row really did change").toBe(
      "reported",
    );
  });
}

/** The JSON rendering, parsed. */
function documentOf(header: ReportHeader): Record<string, unknown> {
  return JSON.parse(renderHeaderJson(header)) as Record<string, unknown>;
}

// --------------------------------------------------------------------------
// the fingerprint: the field the header's claim rests on
// --------------------------------------------------------------------------

describe("the fingerprint", () => {
  test("the content fingerprint moves on an in-place update that moves no count", () => {
    // The whole reason section 6 rejected counts plus maxima, as a test. The
    // edit is the one that actually happens: a late adapter backfills a
    // `usage_status`. It changes what every AC-9 figure in the report says, and
    // it changes no row count and no `MAX(rowid)` -- asserted here, not assumed.
    const path = productionDb();
    populate(path);
    const before = fingerprintOf(path);
    const aggregatesBefore = countsAndMaxima(path);

    backfillUsage(path);

    expect(
      countsAndMaxima(path),
      "the premise of this test: the edit moved no count and no maximum",
    ).toEqual(aggregatesBefore);
    const after = fingerprintOf(path);
    expect(after.digest).not.toBe(before.digest);
    expect(after.mode).toBe(FINGERPRINT_CONTENT);
    expect(after.establishesContentIdentity).toBe(true);
    expect(after.statement).toBe(CONTENT_STATEMENT);
  });

  test("the aggregate fingerprint is blind to the same edit", () => {
    // The rejected form, reproduced faithfully enough to be seen failing. If
    // this ever starts passing (that is, the aggregate digest starts moving),
    // the two modes have stopped being different and the header's weaker-mode
    // statement has become a lie in the other direction.
    const path = productionDb();
    populate(path);
    const before = fingerprintOf(path, { mode: FINGERPRINT_AGGREGATE });

    backfillUsage(path);

    const after = fingerprintOf(path, { mode: FINGERPRINT_AGGREGATE });
    expect(after.digest).toBe(before.digest);
    expect(after.establishesContentIdentity).toBe(false);
    expect(after.statement).toBe(AGGREGATE_STATEMENT);
  });

  test("an aggregate report says its fingerprint proves nothing about content", () => {
    // Both renderings carry the disclaimer, and the content one does not.
    const path = productionDb();
    populate(path);
    const revisionId = seedRevisionId(path);

    const weak = headerOver(path, { revisionId, fingerprintMode: FINGERPRINT_AGGREGATE });
    const weakMarkdown = renderHeaderMarkdown(weak);
    const weakJson = documentOf(weak);
    expect(weakJson.fingerprint_mode).toBe(FINGERPRINT_AGGREGATE);
    expect(weakJson.fingerprint_establishes_content_identity).toBe(false);
    expect(weakJson.fingerprint_statement).toBe(AGGREGATE_STATEMENT);
    expect(weakMarkdown).toContain("does NOT establish identity of content");

    const strong = headerOver(path, { revisionId });
    const strongJson = documentOf(strong);
    expect(strongJson.fingerprint_establishes_content_identity).toBe(true);
    expect(strongJson.fingerprint_statement).toBe(CONTENT_STATEMENT);
    expect(renderHeaderMarkdown(strong)).not.toContain("does NOT establish identity of content");
  });

  test("two reports over an unchanged database fingerprint identically", () => {
    // The other half of the claim: no digest churn without a content change. A
    // digest that moved between two reads of an untouched database would make
    // "these two reports are over the same content" unprovable in practice,
    // which is the same failure from the other side.
    const path = productionDb();
    populate(path);
    const revisionId = seedRevisionId(path);
    const first = headerOver(path, { revisionId });
    const second = headerOver(path, { revisionId, generatedAtMs: GENERATED_AT + 5_000 });
    expect(first.fingerprint.digest).toBe(second.fingerprint.digest);
    expect(first.generatedAtMs).not.toBe(second.generatedAtMs);
  });

  test("the fingerprint covers the tables it names and no others", () => {
    // Scope is a property of the digest, not an incidental of the whole file. A
    // row written into a table outside the list must not move it -- otherwise
    // the header's `fingerprint_tables` would be decoration and the digest
    // would be over "the database", which is a different and unstated claim.
    const path = productionDb();
    populate(path);
    const narrowBefore = fingerprintOf(path, { tables: ["run"] });
    const wideBefore = fingerprintOf(path, { tables: READ_TABLES });

    withWritable(path, (cp) => {
      addIncident(cp, "inc-2", { runId: "run-1" });
    });

    expect(fingerprintOf(path, { tables: ["run"] }).digest).toBe(narrowBefore.digest);
    expect(fingerprintOf(path, { tables: READ_TABLES }).digest).not.toBe(wideBefore.digest);
  });

  test("the fingerprint separates NULL from empty and keeps value boundaries", () => {
    // The type tag and the length prefix, each exercised on a real row. `NULL`
    // and `''` are different facts in this schema (an unrecorded pattern versus
    // a recorded empty one) and hash differently only because of the type tag.
    // The second pair is chosen so that the tags alone do **not** separate them:
    // two adjacent text columns holding `('as', 'b')` and `('a', 'sb')` produce
    // the identical byte stream once each value is written as its tag followed
    // by its bytes, so only the explicit length prefix keeps them apart -- and
    // without it two materially different rows would share one digest, which is
    // the aggregate mode's false-identity failure arriving by another route.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-1");
      // fact_state and detector_version are adjacent columns, which is what
      // makes the boundary between them the thing under test.
      addIncident(cp, "inc-1", { runId: "run-1", factState: "as" });
      cp.prepare("UPDATE incident SET detector_version = 'b' WHERE incident_id = 'inc-1'").run();
    });
    const nullPattern = fingerprintOf(path, { tables: ["incident"] });

    withWritable(path, (cp) => {
      cp.prepare("UPDATE incident SET known_pattern = '' WHERE incident_id = 'inc-1'").run();
    });
    const emptyPattern = fingerprintOf(path, { tables: ["incident"] });
    expect(emptyPattern.digest).not.toBe(nullPattern.digest);

    withWritable(path, (cp) => {
      cp.prepare(
        "UPDATE incident SET fact_state = 'a', detector_version = 'sb' WHERE incident_id = 'inc-1'",
      ).run();
    });
    const movedBoundary = fingerprintOf(path, { tables: ["incident"] });
    expect(movedBoundary.digest).not.toBe(emptyPattern.digest);
  });

  test("a table that is not there is refused, not skipped", () => {
    const path = productionDb();
    withMeasurement(path, (connection) => {
      const refusal = expectRefusal(
        () => fingerprintDatabase(connection, { tables: ["incidents"] }),
        TableNotReadable,
      );
      expect(refusal.message).toContain("incidents");
      expectRefusal(() => fingerprintDatabase(connection, { tables: [] }), TableNotReadable);
      expectRefusal(
        () => fingerprintDatabase(connection, { tables: ["run", "run"] }),
        TableNotReadable,
      );
      expectRefusal(
        () => fingerprintDatabase(connection, { tables: ["run"], mode: "cheap" }),
        FingerprintModeRefused,
      );
    });
  });
});

// --------------------------------------------------------------------------
// the version sets and the banner
// --------------------------------------------------------------------------

describe("the version sets and the banner", () => {
  test("detector_versions is a set over the period", () => {
    // Two incidents on one version give one member; a version outside the
    // period is not in the set at all (the bounds are half-open).
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-1");
      addIncident(cp, "inc-1", { runId: "run-1", detectorVersion: "detector/1" });
      addIncident(cp, "inc-2", {
        runId: "run-1",
        detectorVersion: "detector/1",
        createdAtMs: PERIOD_START + 500,
      });
      addIncident(cp, "inc-outside", {
        runId: "run-1",
        detectorVersion: "detector/9",
        createdAtMs: PERIOD_END,
      });
    });

    const header = headerOver(path, { revisionId: seedRevisionId(path) });
    expect(header.detectorVersions).toEqual(["detector/1"]);
    expect(header.nonHomogeneous).toBe(false);
  });

  test("a second detector version raises the banner in both renderings", () => {
    // Section 6's first non-homogeneity cause, and the banner is unmissable.
    // Asserted in both renderings because a banner that only reaches one of
    // them is absent for whichever reader has the other.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-1");
      addIncident(cp, "inc-1", { runId: "run-1", detectorVersion: "detector/1" });
      addIncident(cp, "inc-2", {
        runId: "run-1",
        detectorVersion: "detector/2",
        createdAtMs: PERIOD_START + 500,
      });
    });

    const header = headerOver(path, { revisionId: seedRevisionId(path) });
    expect(header.detectorVersions).toEqual(["detector/1", "detector/2"]);
    expect(header.nonHomogeneous).toBe(true);

    const markdown = renderHeaderMarkdown(header);
    const document = documentOf(header);
    expect(markdown.startsWith("!!")).toBe(true);
    expect(markdown).toContain("NON-HOMOGENEOUS PERIOD");
    expect(markdown).toContain("detector/1");
    expect(markdown).toContain("detector/2");
    expect(markdown, "the set is exposed, not resolved").toContain("Q-0009");
    expect(document.non_homogeneous).toBe(true);
    expect(
      (document.banner as string[]).some((line) => line.includes("NON-HOMOGENEOUS PERIOD")),
    ).toBe(true);
    expect(document.non_homogeneity_reasons).toHaveLength(1);
  });

  test("a policy revision change inside the period raises the banner", () => {
    // Section 6's second cause: the budgets moved under the latency figures.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-1");
      addIncident(cp, "inc-1", { runId: "run-1" });
      addRevision(cp, PERIOD_START + Math.floor(DAY_MS / 2));
    });

    const header = headerOver(path, { revisionId: seedRevisionId(path) });
    expect(header.policyRevisionIds).toHaveLength(2);
    expect(header.nonHomogeneous).toBe(true);
    const markdown = renderHeaderMarkdown(header);
    expect(markdown).toContain("policy_revision_id changed inside the period");
    expect(documentOf(header).non_homogeneous).toBe(true);
  });

  test("a revision superseded at its own instant never reaches the header", () => {
    // The tie case of the cause above: one change, named once, by its winner.
    // Two revisions may share an `effective_at_ms` (a correction filed in the
    // same pass as the row it corrects) and only the higher `revision_id` is
    // ever in force. The header must therefore name two revisions here -- the
    // seed and the winner -- not three, and must refuse the superseded one as a
    // subject: a report headed by a revision that governed zero milliseconds
    // states its latency figures were judged against numbers nobody ever
    // applied.
    const path = productionDb();
    const { superseded, superseding } = withWritable(path, (cp) => {
      addRun(cp, "run-1");
      addIncident(cp, "inc-1", { runId: "run-1" });
      return {
        superseded: addRevision(cp, PERIOD_START + Math.floor(DAY_MS / 2)),
        superseding: addRevision(cp, PERIOD_START + Math.floor(DAY_MS / 2)),
      };
    });

    const header = headerOver(path, { revisionId: seedRevisionId(path) });
    expect(header.policyRevisionIds).toEqual([seedRevisionId(path), superseding]);
    expect(header.policyRevisionIds).not.toContain(superseded);
    expect(header.nonHomogeneous, "the change itself is real; only its count was wrong").toBe(true);

    expectRefusal(() => headerOver(path, { revisionId: superseded }), RevisionNotInPeriod);
  });

  test("a homogeneous period says so rather than printing nothing", () => {
    const path = productionDb();
    populate(path);
    const header = headerOver(path, { revisionId: seedRevisionId(path) });
    const markdown = renderHeaderMarkdown(header);
    expect(header.nonHomogeneous).toBe(false);
    expect(markdown.startsWith("period is HOMOGENEOUS")).toBe(true);
    expect(documentOf(header).non_homogeneity_reasons).toEqual([]);
  });

  test("adapter_versions is a set over the period", () => {
    // The AC-9 token seam, same reasoning, same shape -- and a second adapter
    // version is exposed even though it does not itself raise the banner.
    const path = productionDb();
    withWritable(path, (cp) => {
      const runId = addRun(cp, "run-1");
      const incidentId = addIncident(cp, "inc-1", { runId });
      addInvocation(cp, "inv-1", { adapterVersion: "adapter/2", incidentId, runId });
      addInvocation(cp, "inv-2", {
        adapterVersion: "adapter/1",
        incidentId,
        runId,
        startedAtMs: PERIOD_START + 30,
      });
      addInvocation(cp, "inv-outside", {
        adapterVersion: "adapter/99",
        incidentId,
        runId,
        startedAtMs: PERIOD_END,
      });
    });

    const header = headerOver(path, { revisionId: seedRevisionId(path) });
    expect(header.adapterVersions).toEqual(["adapter/1", "adapter/2"]);
  });
});

// --------------------------------------------------------------------------
// the queries are data
// --------------------------------------------------------------------------

describe("the queries are data", () => {
  test("the query digest moves when a query text moves", () => {
    // A `>=` that became a `>` changes the report and nothing else in the
    // header; the digest over the query text is the only field that can see it.
    const path = productionDb();
    populate(path);
    const revisionId = seedRevisionId(path);
    const original = headerOver(path, {
      revisionId,
      queryDefinitions: new Map([["episodes", "SELECT 1 WHERE created_at_ms >= :from"]]),
    });
    const edited = headerOver(path, {
      revisionId,
      queryDefinitions: new Map([["episodes", "SELECT 1 WHERE created_at_ms > :from"]]),
    });
    expect(original.queries.digest).not.toBe(edited.queries.digest);
    expect(original.fingerprint.digest, "only the query text changed; the database did not").toBe(
      edited.fingerprint.digest,
    );
  });

  test("the query digest is over the set, not the writing order", () => {
    const first = queryCatalogue(
      new Map([
        ["a", "SELECT 1"],
        ["b", "SELECT 2"],
      ]),
    );
    const second = queryCatalogue(
      new Map([
        ["b", "SELECT 2"],
        ["a", "SELECT 1"],
      ]),
    );
    expect(first.digest).toBe(second.digest);
    expect(
      queryCatalogue(
        new Map([
          ["a", "SELECT 1"],
          ["b", "SELECT 3"],
        ]),
      ).digest,
    ).not.toBe(first.digest);
  });

  test("the header carries its own queries as text", () => {
    // The two queries this module runs are in the set a reader can run by hand,
    // alongside the caller's.
    const path = productionDb();
    populate(path);
    const header = headerOver(path, { revisionId: seedRevisionId(path) });
    for (const [name, text] of HEADER_QUERIES) {
      expect(header.queries.definitions.get(name)).toBe(text);
    }
    expect(header.queries.definitions.has("caller_incidents")).toBe(true);
    expect(header.queries.definitions.get("provenance_detector_versions")).toContain(
      "FROM incident",
    );
  });

  test("a name carrying two texts is refused", () => {
    const path = productionDb();
    populate(path);
    expectRefusal(
      () =>
        headerOver(path, {
          revisionId: seedRevisionId(path),
          queryDefinitions: new Map([["provenance_detector_versions", "SELECT 1"]]),
        }),
      QueryDefinitionsRefused,
    );
    expectRefusal(() => queryCatalogue(new Map()), QueryDefinitionsRefused);
    expectRefusal(() => queryCatalogue(new Map([["empty", "   "]])), QueryDefinitionsRefused);
  });
});

// --------------------------------------------------------------------------
// every section-6 field, in both renderings
// --------------------------------------------------------------------------

describe("every section-6 field, in both renderings", () => {
  parametrize(
    "every section 6 field is in both renderings",
    SECTION_6_FIELDS.map((field) => [field, field] as const),
    (field) => {
      const path = productionDb();
      populate(path);
      const header = headerOver(path, { revisionId: seedRevisionId(path) });
      const markdown = renderHeaderMarkdown(header);
      const document = documentOf(header);

      expect(markdown, `${field} is missing from the Markdown rendering`).toContain(`\`${field}`);

      let node: unknown = document;
      for (const part of field.split(".")) {
        expect(
          typeof node === "object" && node !== null && part in (node as object),
          `${field} is missing from the JSON rendering`,
        ).toBe(true);
        node = (node as Record<string, unknown>)[part];
      }
    },
  );
});

// --------------------------------------------------------------------------
// the header's own fields
// --------------------------------------------------------------------------

describe("the header's own fields", () => {
  test("the period bounds are printed as both epoch ms and ISO", () => {
    const path = productionDb();
    populate(path);
    const header = headerOver(path, { revisionId: seedRevisionId(path) });
    const document = documentOf(header);
    expect(document.period_start_ms).toBe(PERIOD_START);
    expect(document.period_end_ms).toBe(PERIOD_END);
    expect(document.period_start_iso).toBe(iso8601Ms(PERIOD_START));
    expect((document.period_end_iso as string).endsWith("Z")).toBe(true);
    expect(document.period_bounds).toBe("half-open [start, end)");
    expect(iso8601Ms(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(iso8601Ms(1)).toBe("1970-01-01T00:00:00.001Z");
    expectRefusal(() => iso8601Ms(-1), PeriodRefused);
  });

  test("the header names the database and that it is a production one", () => {
    // `application_id`, `user_version` and the migration head come off the
    // database, and the head is the newest applied step by version *and* name.
    const path = productionDb();
    populate(path);
    const header = headerOver(path, { revisionId: seedRevisionId(path) });

    const { applied, userVersion } = withMeasurement(path, (connection) => ({
      applied: appliedMigrations(connection),
      userVersion: Number(connection.pragma("user_version", { simple: true })),
    }));

    const newest = applied[applied.length - 1];
    expect(header.schemaMigrationHead.version).toBe(newest?.version);
    expect(header.schemaMigrationHead.name).toBe(newest?.name);
    expect(header.userVersion).toBe(userVersion);
    expect(header.databaseIsProduction).toBe(true);
    expect(header.dbPath).toBe(path);
    expect(header.toolVersion).toBe(TOOL_VERSION);
  });

  test("a non-production database cannot be given a production header", () => {
    // The header states the database was a production one, so it may not be
    // built over one that is not -- the field a later reader checks would be
    // the field that lied.
    const path = join(caseRoot("provenance"), "not-production.sqlite3");
    const writer = new Database(path);
    try {
      writer.pragma("application_id = 305419896");
      writer.prepare("CREATE TABLE run (run_id TEXT PRIMARY KEY)").run();
    } finally {
      writer.close();
    }

    const reading = new Database(path, { readonly: true });
    try {
      expectRefusal(
        () =>
          buildHeader(reading, {
            dbPath: path,
            periodStartMs: PERIOD_START,
            periodEndMs: PERIOD_END,
            generatedAtMs: GENERATED_AT,
            policyRevisionId: 1,
            fingerprintTables: ["run"],
            queryDefinitions: CALLER_QUERIES,
            fixtureSuite: FixtureSuiteRef.absent("no recall in this report"),
            imputation: new ImputationRule({
              bounded: BOUNDED_IMPUTATION_RULE,
              sensitivity: SENSITIVITY_IMPUTATION_RULE,
              unboundedMissing: 0,
            }),
            coverage: new CoverageSummary({ covered: 0, total: 0, excluded: new Map() }),
            censored: 0,
            censoredLeft: 0,
            unmatched: new Map(),
          }),
        NotAProductionDatabase,
      );
    } finally {
      reading.close();
    }
  });

  test("a revision not in force in the period is refused", () => {
    const path = productionDb();
    populate(path);
    expectRefusal(() => headerOver(path, { revisionId: 9_999 }), RevisionNotInPeriod);
  });

  test("a report cannot be generated before its period closed", () => {
    const path = productionDb();
    populate(path);
    const revisionId = seedRevisionId(path);
    expectRefusal(
      () => headerOver(path, { revisionId, generatedAtMs: PERIOD_END - 1 }),
      PeriodRefused,
    );
    expectRefusal(
      () =>
        headerOver(path, {
          revisionId,
          periodStartMs: PERIOD_END,
          periodEndMs: PERIOD_START,
        }),
      PeriodRefused,
    );
  });

  test("the censored counts are carried and must be counts", () => {
    // Section 3.5's numbers are header fields, and a negative one is refused
    // rather than printed -- a negative censored count is a bug upstream and
    // the header is the last place it can be caught before it is published.
    const path = productionDb();
    populate(path);
    const revisionId = seedRevisionId(path);
    const header = headerOver(path, { revisionId, censored: 7, censoredLeft: 2 });
    const document = documentOf(header);
    expect(document.censored).toBe(7);
    expect(document.censored_left).toBe(2);
    expectRefusal(() => headerOver(path, { revisionId, censored: -1 }), ProvenanceRefusal);
  });

  test("the unmatched counts are carried verbatim", () => {
    const path = productionDb();
    populate(path);
    const header = headerOver(path, {
      revisionId: seedRevisionId(path),
      unmatched: new Map([
        ["unmatched_key", 4],
        ["unmatched_key_escalation", 1],
      ]),
    });
    const markdown = renderHeaderMarkdown(header);
    expect(markdown).toContain("`unmatched.unmatched_key`");
    expect((documentOf(header).unmatched as Record<string, number>).unmatched_key).toBe(4);
  });
});

// --------------------------------------------------------------------------
// the adapters onto the sections that produce the figures
// --------------------------------------------------------------------------

describe("the adapters onto the sections that produce the figures", () => {
  test("the coverage ratio is null and not zero over an empty cohort", () => {
    expect(new CoverageSummary({ covered: 0, total: 0, excluded: new Map() }).ratio).toBeNull();
    expect(new CoverageSummary({ covered: 1, total: 4, excluded: new Map() }).ratio).toBe(0.25);
  });

  test("the fixture suite ref splits positive from negative", () => {
    // Built from the shipped corpus, so the counts are the corpus's own.
    const root = fileURLToPath(new URL("../fixtures/labelled", import.meta.url));
    const corpus = loadCorpus(root);
    const reference = fixtureSuiteRef(corpus, { commit: "0123abc" });
    const composition = corpus.composition();
    expect(reference.positive).toBe(composition.get("positive"));
    expect(reference.negative).toBe(composition.get("negative"));
    expect(reference.total).toBe(composition.get("total"));
    expect(reference.contentDigest).toBe(corpus.contentDigest);
    expect(reference.absentReason).toBeNull();
    expectRefusal(() => fixtureSuiteRef(corpus, { commit: "  " }), ProvenanceRefusal);
  });

  test("a report with no corpus states the absence", () => {
    // A missing `fixture_suite_ref` reads as a report that forgot to record
    // one; a stated absence is a different claim and is the honest one.
    const path = productionDb();
    populate(path);
    const header = headerOver(path, {
      revisionId: seedRevisionId(path),
      fixtureSuite: FixtureSuiteRef.absent("no recall measured in this period"),
    });
    const document = documentOf(header);
    const reference = document.fixture_suite_ref as Record<string, unknown>;
    expect(reference.absent_reason).toBe("no recall measured in this period");
    expect(reference.total).toBeNull();
    expect(renderHeaderMarkdown(header)).toContain("no recall measured in this period");
    expectRefusal(() => FixtureSuiteRef.absent("   "), ProvenanceRefusal);
  });
});

// --------------------------------------------------------------------------
// the renderings themselves
// --------------------------------------------------------------------------

describe("the renderings themselves", () => {
  test("both renderings are ASCII and encode on a cp932 console", () => {
    // The header is printed to a console that may be cp932; a character that
    // cannot encode there crashes the report rather than degrading it.
    const path = productionDb();
    populate(path);
    const header = headerOver(path, { revisionId: seedRevisionId(path) });
    for (const rendering of [renderHeaderMarkdown(header), renderHeaderJson(header)]) {
      expect(isAscii(rendering)).toBe(true);
    }
  });

  test("a pipe in a query cannot shift the Markdown columns", () => {
    const path = productionDb();
    populate(path);
    const header = headerOver(path, {
      revisionId: seedRevisionId(path),
      queryDefinitions: new Map([["piped", "SELECT 'a' | 'b'"]]),
    });
    const rows = renderHeaderMarkdown(header)
      .split("\n")
      .filter((line) => line.includes("query_definitions.piped"));
    expect(rows).toHaveLength(1);
    const row = rows[0] as string;
    expect(row, "the pipe inside the query text is escaped").toContain("\\|");
    // Three unescaped pipes: the leading one, the column separator, the
    // trailing one. A fourth would mean the query text opened a new column.
    const pipes = (row.match(/\|/g) ?? []).length;
    const escaped = (row.match(/\\\|/g) ?? []).length;
    expect(pipes - escaped).toBe(3);
  });
});

// --------------------------------------------------------------------------
// properties the ported cases leave unguarded (target-only)
// --------------------------------------------------------------------------

describe("properties the ported cases leave unguarded (target-only)", () => {
  test("TOOL_VERSION is the version package.json declares", () => {
    // Target-only, and the property `__about__.py` exists for: the header
    // states which build produced the report, so a build that reported a
    // version it is not would be wrong in the one field a later reader uses to
    // reproduce it. interlock keeps one literal and reads it; this port has two
    // places a version can live -- the module and package.json -- so the test
    // is what makes them one source of truth.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    expect(TOOL_VERSION).toBe(manifest.version);
  });

  test("an integral coverage ratio renders as Python spells a float", () => {
    // Target-only, and a PORT DIVERGENCE this port had to design around rather
    // than an inherited gap. Python's `json.dumps(1.0)` is `1.0`; JavaScript
    // has one number type and would render `1`. No ported case reaches it --
    // every header built above has coverage 3/4 -- so a header over a fully
    // covered cohort would have differed from interlock's in a field a reader
    // compares, and nothing would have failed.
    const path = productionDb();
    populate(path);
    const header = withMeasurement(path, (connection) =>
      buildHeader(connection, {
        dbPath: path,
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        generatedAtMs: GENERATED_AT,
        policyRevisionId: seedRevisionId(path),
        fingerprintTables: READ_TABLES,
        queryDefinitions: CALLER_QUERIES,
        fixtureSuite: FixtureSuiteRef.absent("no recall in this report"),
        imputation: new ImputationRule({
          bounded: BOUNDED_IMPUTATION_RULE,
          sensitivity: SENSITIVITY_IMPUTATION_RULE,
          unboundedMissing: 0,
        }),
        coverage: new CoverageSummary({ covered: 4, total: 4, excluded: new Map() }),
        censored: 0,
        censoredLeft: 0,
        unmatched: new Map(),
      }),
    );

    // The raw text, not the parsed document: JSON.parse would turn `1.0` back
    // into the same number `1` produces, which is exactly the difference this
    // case exists to see.
    expect(renderHeaderJson(header)).toContain('"ratio": 1.0');
    expect(renderHeaderMarkdown(header)).toContain("| `coverage.ratio` | 1.0 |");
  });

  test("the fingerprint separates an integer from the real that equals it", () => {
    // Target-only, and a PORT DIVERGENCE. Python's sqlite3 hands back an `int`
    // for an INTEGER column and a `float` for a REAL one, so `isinstance`
    // splits them and the type tag keeps `1` and `1.0` apart. better-sqlite3
    // returns a JavaScript number for both, so without `safeIntegers(true)` on
    // the row statement the two hash alike -- collapsing exactly the
    // distinction the tag exists to make, in the field whose whole claim is
    // that two reports with one digest saw one content.
    const path = productionDb();
    withWritable(path, (cp) => {
      cp.prepare("CREATE TABLE probe (value)").run();
      cp.prepare("INSERT INTO probe (value) VALUES (1)").run();
    });
    const asInteger = fingerprintOf(path, { tables: ["probe"] });

    withWritable(path, (cp) => {
      cp.prepare("DELETE FROM probe").run();
      cp.prepare("INSERT INTO probe (value) VALUES (1.0)").run();
    });
    // SQLite stores 1.0 in an untyped column as a REAL, and typeof() says so.
    expect(
      withMeasurement(
        path,
        (connection) =>
          (connection.prepare("SELECT typeof(value) AS t FROM probe").get() as { t: string }).t,
      ),
    ).toBe("real");

    expect(fingerprintOf(path, { tables: ["probe"] }).digest).not.toBe(asInteger.digest);
  });

  test("the fingerprint is exact past 2^53", () => {
    // Target-only, and the second half of the same divergence. A JavaScript
    // number cannot hold 2^53+1, so a digest taken over a rounded value would
    // certify two different rows as the same content (D-0007). safeIntegers
    // returns a BigInt, which is exact.
    const path = productionDb();
    withWritable(path, (cp) => {
      cp.prepare("CREATE TABLE probe (value INTEGER)").run();
      cp.prepare("INSERT INTO probe (value) VALUES (9007199254740993)").run();
    });
    const odd = fingerprintOf(path, { tables: ["probe"] });

    withWritable(path, (cp) => {
      cp.prepare("UPDATE probe SET value = 9007199254740992").run();
    });
    expect(fingerprintOf(path, { tables: ["probe"] }).digest).not.toBe(odd.digest);
  });
});

describe("the fingerprint's unexercised guarantees (target-only)", () => {
  // Eight properties a 37-mutation sweep found unguarded. Each was confirmed
  // INHERITED by applying the same mutation to interlock's own provenance.py at
  // 65f36c5 and watching its 61 cases stay green.

  test("the strong mode is what a caller who does not choose gets", () => {
    // Every ported case passes the mode explicitly -- on both sides -- so
    // flipping the default to the weaker form changes nothing they assert.
    // Section 6 makes the content hash the field and the aggregate form
    // something a caller must ASK for, precisely so a caller who did not know
    // there was a choice does not publish the weaker claim.
    const path = productionDb();
    populate(path);
    const chosen = withMeasurement(path, (connection) =>
      fingerprintDatabase(connection, { tables: READ_TABLES }),
    );
    expect(chosen.mode).toBe(FINGERPRINT_CONTENT);
    expect(chosen.establishesContentIdentity).toBe(true);
  });

  test("a table that is not there is refused for being absent, not for being empty", () => {
    // Deleting the absent-table check leaves the empty-columns backstop, which
    // refuses with the same type and also names the table -- so the ported case
    // passes either way. The two sentences tell an operator different things: a
    // typo in the table list, or a table that exists and is somehow shapeless.
    const path = productionDb();
    withMeasurement(path, (connection) => {
      const refusal = expectRefusal(
        () => fingerprintDatabase(connection, { tables: ["incidents"] }),
        TableNotReadable,
      );
      expect(refusal.message).toContain("is not a table in this database");
    });
  });

  test("a column added under a report's feet moves the digest", () => {
    // The source's reason for hashing the column names, unexercised on both
    // sides. Over an EMPTY table, so the only thing that changed is the shape:
    // with rows present the new NULL per row would move the digest anyway and
    // the case would prove nothing.
    const path = productionDb();
    withWritable(path, (cp) => {
      cp.prepare("CREATE TABLE probe (a TEXT)").run();
    });
    const before = fingerprintOf(path, { tables: ["probe"] });

    withWritable(path, (cp) => {
      cp.prepare("ALTER TABLE probe ADD COLUMN b TEXT").run();
    });
    expect(fingerprintOf(path, { tables: ["probe"] }).digest).not.toBe(before.digest);
  });

  test("the length prefix keeps two rows apart that the tag alone does not", () => {
    // The ported boundary case pins the SEPARATOR, not the length: with the
    // length dropped but the delimiter kept, `('as','b')` and `('a','sb')` still
    // hash apart, so the case passes on both sides against an encoding that is
    // only conditionally injective. This is a pair it cannot separate -- a value
    // that contains the delimiter sequence itself.
    const path = productionDb();
    withWritable(path, (cp) => {
      cp.prepare("CREATE TABLE probe (a TEXT, b TEXT)").run();
      cp.prepare("INSERT INTO probe (a, b) VALUES ('x', 'ys:z')").run();
    });
    const first = fingerprintOf(path, { tables: ["probe"] });

    withWritable(path, (cp) => {
      cp.prepare("UPDATE probe SET a = 'xs:y', b = 'z'").run();
    });
    // Under `tag + ":" + payload` both rows spell `s:xs:ys:z`; only the explicit
    // length keeps them apart.
    expect(fingerprintOf(path, { tables: ["probe"] }).digest).not.toBe(first.digest);
  });

  test("the digest is over content, so insertion order does not move it", () => {
    // Ordering by rowid instead of by the columns passes every ported case,
    // because none of them holds two rows whose rowid order differs from their
    // column order. The source's reason is a VACUUM: it renumbers rowids and
    // changes nothing a report can read, and a digest that moved for that would
    // cry wolf at the reader trying to establish that two reads agree.
    const path = productionDb();
    withWritable(path, (cp) => {
      cp.prepare("CREATE TABLE probe (a TEXT)").run();
      cp.prepare("INSERT INTO probe (a) VALUES ('b'), ('a')").run();
    });
    const inserted = fingerprintOf(path, { tables: ["probe"] });

    const other = productionDb();
    withWritable(other, (cp) => {
      cp.prepare("CREATE TABLE probe (a TEXT)").run();
      cp.prepare("INSERT INTO probe (a) VALUES ('a'), ('b')").run();
    });
    expect(fingerprintOf(other, { tables: ["probe"] }).digest).toBe(inserted.digest);
  });

  test("aggregate mode uses MAX(seq) where the table has one", () => {
    // The `seq` branch is unreachable from the three tables every ported case
    // fingerprints, on both sides. Where the two maxima differ -- an append-only
    // table whose seq is not its rowid -- the mode would be computing a
    // different aggregate from the one section 6 names.
    const path = productionDb();
    withWritable(path, (cp) => {
      cp.prepare("CREATE TABLE probe (seq INTEGER, value TEXT)").run();
      cp.prepare("INSERT INTO probe (seq, value) VALUES (100, 'a')").run();
    });
    const before = fingerprintOf(path, { tables: ["probe"], mode: FINGERPRINT_AGGREGATE });

    withWritable(path, (cp) => {
      // The row count and MAX(rowid) are unchanged; only seq moves.
      cp.prepare("UPDATE probe SET seq = 200").run();
    });
    expect(fingerprintOf(path, { tables: ["probe"], mode: FINGERPRINT_AGGREGATE }).digest).not.toBe(
      before.digest,
    );
  });

  test("a database with an empty migration ledger has no head to record", () => {
    // Unreachable through the real opener, so unexercised on both sides. A
    // report over an unmigrated database is over an unknown shape, and the head
    // is the field that would have said which.
    // Built by hand rather than by emptying a real ledger: the production
    // schema has a trigger saying "a migration record is the evidence the step
    // ran; it is never deleted", and defeating it would be testing against a
    // database the schema forbids. A file carrying the production
    // application_id and an empty ledger is the same state from the header's
    // point of view, and it is what a half-applied bootstrap would leave.
    const path = join(caseRoot("provenance"), "empty-ledger.sqlite3");
    const writer = new Database(path);
    try {
      writer.pragma(`application_id = ${PRODUCTION_APPLICATION_ID}`);
      writer
        .prepare(
          "CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL," +
            " checksum TEXT NOT NULL, applied_at_ms INTEGER NOT NULL)",
        )
        .run();
    } finally {
      writer.close();
    }

    const reading = new Database(path, { readonly: true });
    try {
      const refusal = expectRefusal(
        () =>
          buildHeader(reading, {
            dbPath: path,
            periodStartMs: PERIOD_START,
            periodEndMs: PERIOD_END,
            generatedAtMs: GENERATED_AT,
            policyRevisionId: 1,
            fingerprintTables: ["schema_migration"],
            queryDefinitions: CALLER_QUERIES,
            fixtureSuite: FixtureSuiteRef.absent("no recall in this report"),
            imputation: new ImputationRule({
              bounded: BOUNDED_IMPUTATION_RULE,
              sensitivity: SENSITIVITY_IMPUTATION_RULE,
              unboundedMissing: 0,
            }),
            coverage: new CoverageSummary({ covered: 0, total: 0, excluded: new Map() }),
            censored: 0,
            censoredLeft: 0,
            unmatched: new Map(),
          }),
        ProvenanceRefusal,
      );
      expect(refusal.message).toContain("schema_migration ledger is empty");
    } finally {
      reading.close();
    }
  });

  test("a published catalogue and header cannot be edited through the caller's map", () => {
    // Target-only, and a PORT DIVERGENCE the codex review gate caught. Python's
    // frozen dataclasses hold whatever mapping the caller passed, and the
    // source only ever constructs them through the factory, so nothing there
    // notices. Both types are exported here, and a caller who kept their Map
    // could change the rendered query text after the digest was computed --
    // leaving the catalogue claiming a digest for SQL it no longer carries,
    // which is the one thing it asserts. Both constructors copy now.
    const definitions = new Map([["episodes", "SELECT 1"]]);
    const catalogue = queryCatalogue(definitions);
    const direct = new QueryCatalogue({ definitions, digest: catalogue.digest });
    definitions.set("episodes", "SELECT 2");
    expect(catalogue.definitions.get("episodes")).toBe("SELECT 1");
    expect(direct.definitions.get("episodes")).toBe("SELECT 1");

    const path = productionDb();
    populate(path);
    const unmatched = new Map([["unmatched_key", 2]]);
    const header = headerOver(path, { revisionId: seedRevisionId(path), unmatched });
    unmatched.set("unmatched_key", 99);
    expect((documentOf(header).unmatched as Record<string, number>).unmatched_key).toBe(2);
  });

  test("a non-ASCII query text is escaped, not printed", () => {
    // Every ported case is ASCII, so `ensure_ascii` is unexercised on both
    // sides -- and the cp932 case that looks like it covers this is asserting
    // over ASCII inputs. A query name or text is caller-supplied, and this
    // organization writes prose in Japanese; a raw character here crashes the
    // report on the console section 6 says it is printed to.
    const path = productionDb();
    populate(path);
    const header = headerOver(path, {
      revisionId: seedRevisionId(path),
      queryDefinitions: new Map([["japanese", "SELECT 1 -- \u65e5\u672c\u8a9e"]]),
    });
    const json = renderHeaderJson(header);
    expect(isAscii(json)).toBe(true);
    expect(json).toContain("\\u65e5\\u672c\\u8a9e");
    // And it is still the same text once parsed, so the escaping is a rendering
    // choice rather than a change to what the report says it ran.
    const document = documentOf(header);
    expect((document.query_definitions as Record<string, string>).japanese).toBe(
      "SELECT 1 -- \u65e5\u672c\u8a9e",
    );
  });
});
