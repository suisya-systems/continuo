/**
 * The one claim the two renderings make: they say the same thing.
 *
 * Ported from interlock `tests/measurement/test_render.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping, the systematic
 * translations and the deliberate divergences are recorded in
 * `parity/measurement.render.ledger.json`.
 *
 * Section 6 requires the provenance header "in both the Markdown and the JSON
 * renderings", and the failure that requirement is written against is not a
 * missing header -- it is a header that is *almost* the same in both, one field
 * short, because the two renderings were written by two hands. A test that
 * asserted a hand-written list of fields against each rendering would inherit
 * the same defect: it checks the fields whoever wrote it remembered.
 *
 * So "the two renderings carry the same facts" compares the artefacts to each
 * other. It parses the Markdown back into a flat mapping with a parser written
 * here -- it knows the table syntax, not the field list -- and walks the JSON
 * with a traversal written here, and asserts the two mappings are **equal**.
 * Neither side is a copy of the report's field list, so a field that reaches one
 * rendering and not the other fails it no matter which field it is, including
 * one added after this file was written. "a fact dropped from the Markdown is
 * caught" is the mutation of that test kept as a test: it renders a report with
 * one row deleted and asserts the comparison fails, so the comparison cannot
 * pass by comparing nothing.
 *
 * The rest is adversarial around the edges the renderings actually have:
 *
 * * a **multi-line** value (the AC-9 narrative, a query's SQL) cannot live in a
 *   Markdown cell, so it is rendered as a fenced block -- and the equality test
 *   covers it, which is what stops the Markdown from quietly collapsing a
 *   narrative into one line while the JSON keeps it;
 * * a value carrying a `|` would shift every later column, so it is escaped, and
 *   a test puts a pipe in a fact and re-parses;
 * * the **aggregate** fingerprint mode has to be stamped as the weaker thing in
 *   both renderings, proved by rendering the same database both ways;
 * * **no verdict**: both renderings of a report are grepped, with word
 *   boundaries, for the vocabulary a verdict would be written in (`Q-0005` is
 *   open).
 *
 * **One number the port has to reconstruct.** `json.loads` gives Python back a
 * `float` for `1.0` and an `int` for `1`, and the source's JSON walker renders
 * the two apart -- `JSON.parse` gives JavaScript one `number` for both, so a
 * faithful walker here would compare `1` against the Markdown's `1.0` and the
 * headline equality test would fail on a difference that does not exist. The
 * walker therefore reads each number's **source text** through `JSON.parse`'s
 * reviver and wraps the ones spelled as floats in `PythonFloat`, which is the
 * same distinction `renderPythonJson` writes out. {@link parseReportJson}
 * asserts that the source text was actually available rather than silently
 * falling back, because the fallback's failure is an inequality that reads like
 * a rendering bug.
 */

import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import {
  completeInvocation,
  ProviderUsage,
  startInvocation,
} from "../../src/control_plane/ai_invocation.js";
import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import { effectiveRevisionId } from "../../src/control_plane/policy.js";
import { MeasuredBaseline, measureAc9, V1_MEASURED_BASELINE } from "../../src/measurement/ac9.js";
import { selectCohort } from "../../src/measurement/cohort.js";
import { isAscii, reportValue } from "../../src/measurement/format.js";
import {
  AGGREGATE_STATEMENT,
  CONTENT_STATEMENT,
  FINGERPRINT_AGGREGATE,
  FINGERPRINT_CONTENT,
  FingerprintModeRefused,
  FixtureSuiteRef,
  fingerprintDatabase,
  type ReportHeader,
} from "../../src/measurement/provenance.js";
import { openForMeasurement, ReadOnlyCapabilityRefused } from "../../src/measurement/reader.js";
import {
  buildMeasurementReport,
  DuplicateSectionRefused,
  EMPTY_BLOCK,
  FINGERPRINT_TABLES,
  JSON_RENDERING,
  MARKDOWN,
  MeasurementReport,
  NO_VERDICT_NOTE,
  QUERY_CATALOGUE_LIMITATION,
  type ReportHeaderLike,
  ReportSection,
  type ReportValue,
  render,
  renderJson,
  renderMarkdown,
  renderSeams,
  SectionNameRefused,
  SectionsRequired,
  sectionFromAc9,
  sectionFromWindowDeclaration,
  UNATTESTED_STATEMENTS,
  UnknownRendering,
  V1ShadowInput,
  V1ShadowInputRefused,
} from "../../src/measurement/render.js";
import { GRACE_DECLARED, WindowRefusal, windowsSeams } from "../../src/measurement/windows.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";
import { patchSeam } from "../testkit/seams.js";
import {
  parseMarkdown,
  parseReportJson,
  REPORT_CLOCK,
  VERDICT_WORDS,
  walkJson,
} from "./report-reading.js";

const { GENERATED_AT, PERIOD_END, PERIOD_START, T0 } = REPORT_CLOCK;

/**
 * Section 6's fields, as the document lists them, prefixed with the block the
 * report puts them in. Written from the document rather than read off the
 * implementation, so a field deleted from the header fails here.
 */
const SECTION_6_HEADER_FACTS: readonly string[] = [
  "header.period_start_ms",
  "header.period_end_ms",
  "header.generated_at_ms",
  "header.tool_version",
  "header.db_path",
  "header.application_id",
  "header.user_version",
  "header.schema_migration_head.version",
  "header.schema_migration_head.name",
  "header.db_fingerprint",
  "header.fingerprint_mode",
  "header.policy_revision_id",
  "header.detector_versions",
  "header.adapter_versions",
  "header.query_definitions_sha256",
  "header.fixture_suite_ref.commit",
  "header.fixture_suite_ref.positive",
  "header.fixture_suite_ref.negative",
  "header.imputation_rule.bounded",
  "header.imputation_rule.sensitivity",
  "header.imputation_rule.unbounded_missing",
  "header.coverage.covered",
  "header.coverage.total",
  "header.censored",
  "header.censored_left",
  "header.unmatched",
  "header.banner",
];

// --------------------------------------------------------------------------
// the fixture database, built through the real writers
// --------------------------------------------------------------------------

/**
 * The source's `db` fixture, built once per file and copied per case.
 *
 * Every case that takes `db` gets the same rows written by the same writers at
 * the same fixed clock, so there is nothing per-case for the build to depend on
 * -- which is exactly the shape `suiteTemplate` exists for (`D-0025`). The copy
 * is the case's own writable file; nothing is shared at runtime.
 */
const fixtureTemplate = suiteTemplate("production.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
  withWriter(path, (cp) => {
    addRun(cp, "run-1");
    addIncident(cp, { incidentId: "inc-1", runId: "run-1", detectorVersion: "detector/1" });
    addInvocation(cp, { invocationId: "inv-1", adapterVersion: "adapter/1", runId: "run-1" });
  });
});

/**
 * A migrated control plane with no rows, for the cases that need to write
 * something the shared fixture cannot hold -- a hostile detector version, a run
 * id carrying a newline. Copied under the fixture's own filename so a report
 * built over it looks the same to every assertion except the ones about the
 * values.
 */
const bareTemplate = suiteTemplate("bare.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

function productionDb(): string {
  return fixtureTemplate.copyInto(caseRoot("render"));
}

function bareDb(directory = caseRoot("render")): string {
  return bareTemplate.copyInto(directory, "production.sqlite3");
}

/**
 * An ordinary writable connection, deliberately separate from the harness's.
 *
 * The measurement handle cannot write, which is the point of it; every row these
 * tests need therefore arrives through a second connection that can.
 */
function withWriter<T>(path: string, body: (connection: SqliteDatabase) => T): T {
  const connection = new Database(path, { fileMustExist: true });
  try {
    return body(connection);
  } finally {
    connection.close();
  }
}

function addRun(cp: SqliteDatabase, runId: string): void {
  cp.pragma("foreign_keys = ON");
  cp.prepare(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'completed', ?, ?)",
  ).run(runId, PERIOD_START + 1_000, PERIOD_START + 2_000);
}

function addIncident(
  cp: SqliteDatabase,
  options: {
    readonly incidentId: string;
    readonly runId: string;
    readonly detectorVersion: string;
  },
): void {
  cp.prepare(
    `
        INSERT INTO incident (incident_id, run_id, session_id, fact_state,
                              detector_version, dedup_key, created_at_ms,
                              updated_at_ms)
        VALUES (?, ?, NULL, 'stalled', ?, ?, ?, ?)
        `,
  ).run(
    options.incidentId,
    options.runId,
    options.detectorVersion,
    `dedup/${options.incidentId}`,
    PERIOD_START + 1_500,
    PERIOD_START + 1_500,
  );
}

function addInvocation(
  cp: SqliteDatabase,
  options: {
    readonly invocationId: string;
    readonly adapterVersion: string;
    readonly runId: string;
  },
): void {
  startInvocation(cp, {
    invocationId: options.invocationId,
    provider: "anthropic",
    model: "a-model",
    adapterVersion: options.adapterVersion,
    startedAtMs: PERIOD_START + 1_600,
    incidentId: "inc-1",
    runId: options.runId,
    maxOutputTokens: 4_096,
  });
  completeInvocation(cp, {
    invocationId: options.invocationId,
    usage: ProviderUsage.reported({
      adapterVersion: options.adapterVersion,
      outputTokens: 512,
      inputTokens: 2_048,
      cacheReadTokens: 9_000,
    }),
    modelResponseCount: 3,
    finishedAtMs: PERIOD_START + 1_900,
  });
}

function reportOver(
  path: string,
  options: {
    readonly fingerprintMode?: string;
    readonly graceMs?: number;
    readonly v1Shadow?: V1ShadowInput;
    readonly baseline?: MeasuredBaseline;
  } = {},
): MeasurementReport {
  const connection = openForMeasurement(path);
  try {
    return buildMeasurementReport(connection, {
      dbPath: path,
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      nowMs: GENERATED_AT,
      fixtureSuite: FixtureSuiteRef.absent("no corpus in this test"),
      v1Shadow: options.v1Shadow ?? V1ShadowInput.absent("no shadow input in this test"),
      graceMs: options.graceMs,
      fingerprintMode: options.fingerprintMode ?? FINGERPRINT_CONTENT,
      baseline: options.baseline ?? V1_MEASURED_BASELINE,
    });
  } finally {
    connection.close();
  }
}

/**
 * A header substitute for the tests that are about the section machinery.
 *
 * It carries only what the renderer asks of a header, so a test about pipes in a
 * cell does not need a migrated database. The source hands
 * `MeasurementReport(header=...)` this same duck type despite its `ReportHeader`
 * annotation; the port's annotation is {@link ReportHeaderLike}, which is what
 * the renderer actually requires, so the stub type-checks rather than being cast
 * through `unknown`.
 */
function headerStub(
  banner: readonly string[] = ["period is HOMOGENEOUS: a stub"],
): ReportHeaderLike {
  return {
    banner: () => banner,
    asMapping: () => new Map<string, ReportValue>([["stub", true]]),
  };
}

/** A section built without the constructor's own ergonomics getting in the way. */
function section(
  name: string,
  title: string,
  facts: readonly (readonly [string, ReportValue])[],
  narrative: string | null = null,
): ReportSection {
  return new ReportSection({ name, title, facts: new Map(facts), narrative });
}

// --------------------------------------------------------------------------
// the headline claim
// --------------------------------------------------------------------------

describe("the headline claim -- one report, two renderings", () => {
  test("the two renderings carry the same facts", () => {
    const report = reportOver(productionDb());

    const fromMarkdown = parseMarkdown(renderMarkdown(report));
    const fromJson = walkJson(parseReportJson(renderJson(report)));

    expect(Object.fromEntries(fromMarkdown)).toEqual(Object.fromEntries(fromJson));
    // and the comparison is over a real report, not an empty one
    expect(fromJson.size).toBeGreaterThan(40);
  });

  test("a fact dropped from the Markdown is caught", () => {
    // The mutation of the test above, kept as a test. Without this, a comparison
    // that silently compared two empty mappings would pass and nobody would know
    // the header had stopped being rendered.
    const report = reportOver(productionDb());
    const markdown = renderMarkdown(report);
    const mutilated = markdown
      .split("\n")
      .filter((line) => !line.startsWith("| `header.db_fingerprint` |"))
      .join("\n");

    expect(Object.fromEntries(parseMarkdown(mutilated))).not.toEqual(
      Object.fromEntries(walkJson(parseReportJson(renderJson(report)))),
    );
  });

  parametrize(
    "every section 6 header field is in both renderings",
    SECTION_6_HEADER_FACTS.map((fact) => [fact, fact] as const),
    (fact) => {
      const report = reportOver(productionDb());

      expect(parseMarkdown(renderMarkdown(report)).has(fact)).toBe(true);
      expect(walkJson(parseReportJson(renderJson(report))).has(fact)).toBe(true);
    },
  );

  test("the narrative survives as a block rather than a collapsed cell", () => {
    // A multi-line value is the case a Markdown table cannot hold. The AC-9
    // narrative is many lines; a renderer that put it in a cell would collapse it
    // to one line and the Markdown reader would lose the four figures section 2.4
    // requires to be printed together.
    const report = reportOver(productionDb());
    const key = "sections.ac9.narrative";

    const rendered = parseMarkdown(renderMarkdown(report)).get(key) as string;
    expect(rendered).toContain("\n");
    expect(rendered).toBe(report.section("ac9").narrative);
    expect(rendered).toBe(walkJson(parseReportJson(renderJson(report))).get(key));
  });

  test("a pipe in a value does not shift the columns", () => {
    // A `|` inside a fact ends the cell unless it is escaped. The damage is not a
    // broken-looking table: every column after it moves one to the left, so
    // values get printed under other fields' names.
    const probe = section("probe", "a pipe in a value", [
      ["text", "left | right"],
      ["after", "unshifted"],
    ]);
    const markdown = renderMarkdown(
      new MeasurementReport({ header: headerStub(), sections: [probe] }),
    );

    const facts = parseMarkdown(markdown);
    expect(facts.get("sections.probe.facts.after")).toBe("unshifted");
    expect(facts.get("sections.probe.facts.text")).toBe("left \\| right");
  });
});

// --------------------------------------------------------------------------
// the fingerprint mode, stamped in both renderings
// --------------------------------------------------------------------------

describe("the fingerprint mode, stamped in both renderings", () => {
  test("aggregate mode is stamped as the weaker one in both renderings", () => {
    const path = productionDb();
    const strong = reportOver(path, { fingerprintMode: FINGERPRINT_CONTENT });
    const weak = reportOver(path, { fingerprintMode: FINGERPRINT_AGGREGATE });

    for (const rendering of [renderMarkdown, renderJson]) {
      const strongText = rendering(strong);
      const weakText = rendering(weak);
      expect(weakText).toContain(FINGERPRINT_AGGREGATE);
      expect(weakText.replaceAll("\n", " ")).toContain(AGGREGATE_STATEMENT.replaceAll("\n", " "));
      expect(weakText).toContain("does NOT establish identity of content");
      expect(strongText).not.toContain("does NOT establish identity of content");
      expect(strongText.replaceAll("\n", " ")).toContain(CONTENT_STATEMENT.replaceAll("\n", " "));
    }

    const weakFacts = walkJson(parseReportJson(renderJson(weak)));
    expect(weakFacts.get("header.fingerprint_mode")).toBe(FINGERPRINT_AGGREGATE);
    expect(weakFacts.get("header.fingerprint_establishes_content_identity")).toBe("false");
  });

  test("an unknown fingerprint mode is refused before the cohort scan", () => {
    // The source catches `Exception` and asserts only that the mode is named, so
    // this asserts the same and no more: pinning the refusal's class here would
    // be a stronger claim than the source makes (conventions rule 0).
    const path = productionDb();
    expectRefusal(() => reportOver(path, { fingerprintMode: "approximate" }), Error, /approximate/);
  });
});

// --------------------------------------------------------------------------
// no verdict
// --------------------------------------------------------------------------

describe("no verdict", () => {
  parametrize(
    "no verdict word appears in either rendering",
    [
      ["render_markdown", renderMarkdown],
      ["render_json", renderJson],
    ] as const,
    (rendering) => {
      const text = rendering(reportOver(productionDb()));

      const found = [...text.matchAll(VERDICT_WORDS)].map((match) => match[0]);
      expect(found, `verdict vocabulary in the rendering: ${[...new Set(found)].sort()}`).toEqual(
        [],
      );
      expect(text).toContain("Q-0005");
    },
  );

  parametrize(
    "both renderings encode to ascii and to cp932",
    [
      ["render_markdown", renderMarkdown],
      ["render_json", renderJson],
    ] as const,
    (rendering) => {
      // The source asserts ASCII by encoding to cp932 as well as to ascii.
      // JavaScript has no cp932 encoder and needs none: ASCII is a strict subset
      // of cp932, so `isAscii` implies both of the source's assertions.
      const text = rendering(reportOver(productionDb()));

      expect(isAscii(text)).toBe(true);
    },
  );
});

// --------------------------------------------------------------------------
// the declared inputs
// --------------------------------------------------------------------------

describe("the declared inputs", () => {
  test("grace from the revision is stamped as derived and a declared one is not", () => {
    // Grace is declared per report; where it is derived, the report says so. A
    // report that printed a derived grace as though it had been declared would
    // let a policy change move every observation window with nothing in the
    // artefact recording that the number came from the policy at all.
    const path = productionDb();
    const connection = openForMeasurement(path);
    let declaredByPolicy: number;
    try {
      const revision = effectiveRevisionId(connection, { nowMs: PERIOD_START });
      const row = connection
        .prepare(
          "SELECT DISTINCT reconcile_period_ms FROM policy_detection_latency WHERE revision_id = ?",
        )
        .get(revision) as { reconcile_period_ms: number };
      declaredByPolicy = Number(row.reconcile_period_ms);
    } finally {
      connection.close();
    }

    const derived = reportOver(path).section("observation_window").facts;
    expect(derived.get("grace_ms")).toBe(declaredByPolicy);
    expect(derived.get("grace_source")).toBe("revision_reconcile_period");

    const stated = reportOver(path, { graceMs: 1_234 }).section("observation_window").facts;
    expect(stated.get("grace_ms")).toBe(1_234);
    expect(stated.get("grace_source")).toBe("declared");
  });

  test("a negative declared grace is refused before the cohort scan", () => {
    // windows.episodeWindow rejects graceMs < 0 (it shortens the window below the
    // budget the detector is held to), so a report built with one attests, in its
    // section 6 provenance, to a configuration that could never have produced a
    // valid window -- and this branch classifies no episodes, so nothing
    // downstream would raise and the report would render clean. The library entry
    // point has to refuse it, with the window model's own type rather than a
    // second copy of the rule.
    const path = productionDb();
    expectRefusal(() => reportOver(path, { graceMs: -1 }), WindowRefusal);
  });

  test("the grace rule the report enforces is the window model's own", () => {
    // The two must not be able to drift about what a valid grace is. Bound to the
    // code: windows' own `requireGraceMs` is replaced -- through `windowsSeams`,
    // which is where this port puts Python's late binding (D-0014) -- and the
    // report is asserted to refuse what the replacement refuses. A second copy of
    // the rule inside render.ts passes the test above and fails this one.
    const path = productionDb();
    patchSeam(windowsSeams, "requireGraceMs", (graceMs: number): void => {
      if (graceMs % 7 !== 0) {
        throw new WindowRefusal("not a multiple of seven");
      }
    });

    expectRefusal(() => reportOver(path, { graceMs: 1_234 }), WindowRefusal);
    expect(
      reportOver(path, { graceMs: 14 }).section("observation_window").facts.get("grace_ms"),
    ).toBe(14);
  });

  test("a negative grace is refused by the section builder too", () => {
    // The section builder is a public entry point of its own. Validating only in
    // buildMeasurementReport would leave a caller who assembles a
    // MeasurementReport from sections -- which this module exports the pieces for
    // -- able to stamp the invalid grace anyway.
    expectRefusal(
      () =>
        sectionFromWindowDeclaration({
          graceMs: -1,
          graceSource: GRACE_DECLARED,
          episodesClassified: 0,
        }),
      WindowRefusal,
    );
  });

  test("the zero censoring counts say why they are zero", () => {
    // Zero censored episodes and zero episodes are different statements.
    const facts = walkJson(parseReportJson(renderJson(reportOver(productionDb()))));

    expect(facts.get("header.censored")).toBe("0");
    expect(facts.get("header.censored_left")).toBe("0");
    expect(facts.get("sections.observation_window.facts.episodes_classified")).toBe("0");
    expect(facts.get("sections.observation_window.facts.scope")).toContain("for want of episodes");
  });

  test("an absent shadow input is stated rather than shown as an empty bucket", () => {
    const facts = walkJson(parseReportJson(renderJson(reportOver(productionDb()))));

    expect(facts.get("sections.inputs.facts.v1_shadow.source")).toBe(EMPTY_BLOCK);
    expect(facts.get("sections.inputs.facts.v1_shadow.run_id_count")).toBe("0");
    expect(facts.get("sections.inputs.facts.v1_shadow.absent_reason")).toContain("no shadow input");
    expect(facts.get("header.coverage.excluded.v1_owned")).toBe("0");
  });

  test("a shadow input excludes its runs and names its source", () => {
    const report = reportOver(productionDb(), {
      v1Shadow: V1ShadowInput.observed("v1-export.json", ["run-9"]),
    });
    const facts = walkJson(parseReportJson(renderJson(report)));

    expect(facts.get("sections.inputs.facts.v1_shadow.source")).toBe("v1-export.json");
    expect(facts.get("sections.inputs.facts.v1_shadow.run_ids")).toBe("run-9");
    expect(facts.get("header.coverage.excluded.v1_owned")).toBe("1");
  });

  test("a shadow input with no source and no reason is refused", () => {
    expectRefusal(() => V1ShadowInput.observed("  ", ["run-1"]), V1ShadowInputRefused);
    expectRefusal(() => V1ShadowInput.absent(""), V1ShadowInputRefused);
  });

  test("the query catalogue limitation travels with the report", () => {
    // Section 6 asks for every query as text; this report cannot give them all.
    // The limitation is in the rendered artefact rather than only in a docstring,
    // because the reader who would be misled is the one holding the report -- and
    // so is the list of what is missing: a note saying "some statements are not
    // carried" without naming them leaves the reader unable to tell whether the
    // one they care about is among them.
    const facts = walkJson(parseReportJson(renderJson(reportOver(productionDb()))));

    expect(facts.get("sections.inputs.facts.query_catalogue_limitation")).toBe(
      QUERY_CATALOGUE_LIMITATION,
    );
    for (const [where, why] of UNATTESTED_STATEMENTS) {
      expect(facts.get(`sections.inputs.facts.query_catalogue_exemptions.${where}`)).toBe(why);
    }
  });
});

// --------------------------------------------------------------------------
// the report's own refusals
// --------------------------------------------------------------------------

describe("the report's own refusals", () => {
  test("a report with no section is refused", () => {
    expectRefusal(
      () => new MeasurementReport({ header: headerStub(), sections: [] }),
      SectionsRequired,
    );
  });

  test("two sections under one name are refused", () => {
    const first = section("ac9", "one", []);
    const twin = section("ac9", "two", []);
    expectRefusal(
      () => new MeasurementReport({ header: headerStub(), sections: [first, twin] }),
      DuplicateSectionRefused,
    );
  });

  parametrize(
    "a section name that collides with the key syntax is refused",
    [
      ["", ""],
      ["  ", "  "],
      ["a.b", "a.b"],
      ["a b", "a b"],
      ["a|b", "a|b"],
      ["a`b", "a`b"],
    ] as const,
    (name) => {
      expectRefusal(() => section(name, "t", []), SectionNameRefused);
    },
  );

  test("a section without a title is refused", () => {
    expectRefusal(() => section("ok", "   ", []), SectionNameRefused);
  });

  test("asking for a section the report does not carry is refused", () => {
    const report = reportOver(productionDb());
    expectRefusal(() => report.section("latency"), SectionNameRefused);
  });

  test("an unknown rendering is refused", () => {
    const report = reportOver(productionDb());
    expect(render(report, MARKDOWN)).toBe(renderMarkdown(report));
    expect(render(report, JSON_RENDERING)).toBe(renderJson(report));
    expectRefusal(() => render(report, "html"), UnknownRendering);
  });
});

// --------------------------------------------------------------------------
// the AC-9 section binds to the measurement, not to a second computation
// --------------------------------------------------------------------------

describe("the AC-9 section binds to the measurement", () => {
  test("the ac9 section reports the numbers the measurement made", () => {
    // Every figure is read off the report; nothing here is recomputed. The test
    // asserts against measureAc9's own output rather than against hand-written
    // numbers, so a section that silently recomputed a figure a different way
    // would disagree with it.
    const path = productionDb();
    const connection = openForMeasurement(path);
    let selected: ReturnType<typeof selectCohort>;
    let measured: ReturnType<typeof measureAc9>;
    try {
      selected = selectCohort(connection, {
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        nowMs: GENERATED_AT,
      });
      measured = measureAc9(connection, selected, { nowMs: GENERATED_AT });
    } finally {
      connection.close();
    }

    const facts = sectionFromAc9(measured, selected).facts;
    const cohort = facts.get("cohort") as ReadonlyMap<string, ReportValue>;
    const series = facts.get("series") as ReadonlyMap<string, ReportValue>;
    const coverage = facts.get("coverage") as ReadonlyMap<string, ReportValue>;
    const figures = facts.get("figures") as ReadonlyMap<string, ReportValue>;
    const baseline = facts.get("baseline") as ReadonlyMap<string, ReportValue>;

    expect(cohort.get("denominator")).toBe(selected.denominator);
    expect(series.get("model_response_total")).toBe(measured.modelResponseTotal);
    expect(series.get("invocation_count")).toBe(measured.invocationCount);
    expect(coverage.get("covered_count")).toBe(measured.coveredCount);
    expect(new Set(figures.keys())).toEqual(
      new Set(measured.figures().map((figure) => figure.label.replaceAll(" ", "_"))),
    );
    expect(baseline.get("source")).toBe(measured.baseline.source);
  });
});

// --------------------------------------------------------------------------
// section 6 -- the report is measured over one state of the database
// --------------------------------------------------------------------------

/** The content digest of `path` right now, through a separate open. */
function fingerprintNow(path: string, mode: string = FINGERPRINT_CONTENT): string {
  const connection = openForMeasurement(path);
  try {
    return fingerprintDatabase(connection, { tables: FINGERPRINT_TABLES, mode }).digest;
  } finally {
    connection.close();
  }
}

describe("the report is measured over one state of the database", () => {
  test("a writer committing mid-report cannot move the database under it", () => {
    // Section 6's claim, tested against a control plane that is being written to.
    //
    // `db_fingerprint` exists so that two reports over "the same" database are
    // provably over the same content. A fingerprint taken at the end of a report
    // whose rows moved during it certifies a state that never produced the
    // figures: the cohort would name one run and the header would attest a
    // database holding two. The report is built inside a read snapshot for
    // exactly this reason, so the writer is held off until it closes.
    const path = productionDb();
    const before = fingerprintNow(path);
    const outcome: { committed?: true; blocked?: string } = {};

    const real = renderSeams.measureAc9;
    // Patched over the point the report reaches after the cohort has been
    // selected and before the provenance header is built, so the commit lands
    // exactly in the window section 6's fingerprint claim depends on being
    // closed. `timeout: 0` so a blocked write answers immediately instead of
    // sitting on the busy handler.
    patchSeam(renderSeams, "measureAc9", (connection, selected, options) => {
      const writer = new Database(path, { fileMustExist: true, timeout: 0 });
      try {
        writer
          .prepare(
            "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms)" +
              " VALUES (?, 'completed', ?, ?)",
          )
          .run("run-mid-report", PERIOD_START + 3_000, PERIOD_START + 4_000);
        outcome.committed = true;
      } catch (error) {
        outcome.blocked = String(error);
      } finally {
        writer.close();
      }
      return real(connection, selected, options);
    });

    const report = reportOver(path);

    expect(
      outcome.committed,
      "a writer committed inside the report: the report's reads are not over " +
        "one state of the database",
    ).toBeUndefined();
    expect(outcome.blocked ?? "").toContain("locked");
    const facts = report.asMapping();
    const header = facts.get("header") as ReadonlyMap<string, ReportValue>;
    expect(
      header.get("db_fingerprint"),
      "the header fingerprints a state other than the one the figures were computed from",
    ).toBe(before);
    const sections = facts.get("sections") as ReadonlyMap<string, ReportValue>;
    const ac9 = sections.get("ac9") as ReadonlyMap<string, ReportValue>;
    const ac9Facts = ac9.get("facts") as ReadonlyMap<string, ReportValue>;
    const cohort = ac9Facts.get("cohort") as ReadonlyMap<string, ReportValue>;
    expect(cohort.get("run_ids")).toEqual(["run-1"]);
    // And the writer that was held off is only held off for the report: the cost
    // is bounded by the report's duration, not by the process's.
    expect(fingerprintNow(path)).toBe(before);
  });

  test("the report is built inside a held read transaction", () => {
    // The snapshot is the report's, not the caller's, so it cannot be forgotten.
    // Observed from inside the report rather than by reading the source: a caller
    // who wrapped the call themselves would satisfy a source test, and the point
    // is that buildMeasurementReport holds the snapshot whoever calls it.
    const path = productionDb();
    const seen: boolean[] = [];
    const real = renderSeams.measureAc9;
    patchSeam(renderSeams, "measureAc9", (connection, selected, options) => {
      seen.push(connection.inTransaction);
      return real(connection, selected, options);
    });

    reportOver(path);

    expect(seen).toEqual([true]);
  });
});

// --------------------------------------------------------------------------
// target-only -- the escaping the source's renderer does not do (D-0109),
// and the fence it cannot close (D-0111)
// --------------------------------------------------------------------------

/**
 * One hostile value, carrying every shape a report must survive at once.
 *
 * A newline **and** a character outside ASCII **and** a pipe, because a value
 * carrying only one of them hides from two of the three assertions -- which is
 * how the first pass of the `D-0109` measurement scored 22 of 31 with every
 * escape call already in place.
 *
 * Never used as a path: a newline is a legal filename character on POSIX and an
 * invalid one on Windows, so a fixture that builds a directory out of this
 * passes locally and fails on the Windows cells with an `ENOENT` from `mkdir`,
 * before any assertion runs.
 */
const HOSTILE = "a|b\n      forged: 0 caf\u00e9 \u2014";

/** A multi-line value as its Markdown block carries it. */
function asBlock(value: string): string {
  return value
    .split("\n")
    .map((line) => reportValue(line))
    .join("\n");
}

/** The same hazard for a value that becomes a path: no newline. */
const HOSTILE_PATH_SEGMENT = "caf\u00e9-\u2014";

describe("target-only -- a hostile value cannot forge a report", () => {
  test("every externally-supplied value in a full report is escaped", () => {
    // The structural case: hostile values in every field a caller or the database
    // can reach, driven through buildMeasurementReport rather than a stub, so the
    // escaping is measured on the report the CLI actually prints. The db path is
    // hostile too, minus the newline, for the reason HOSTILE's docstring gives.
    const path = bareDb(join(caseRoot("render"), HOSTILE_PATH_SEGMENT));
    withWriter(path, (cp) => {
      addRun(cp, `run-${HOSTILE}`);
      addIncident(cp, {
        incidentId: "inc-1",
        runId: `run-${HOSTILE}`,
        detectorVersion: `detector/${HOSTILE}`,
      });
      addInvocation(cp, {
        invocationId: "inv-1",
        adapterVersion: `adapter/${HOSTILE}`,
        runId: `run-${HOSTILE}`,
      });
    });

    const report = reportOver(path, {
      v1Shadow: V1ShadowInput.observed(`source/${HOSTILE}`, [`v1-${HOSTILE}`]),
      baseline: new MeasuredBaseline({
        completedRuns: 195,
        modelResponses: 3_531,
        outputTokens: 567_839,
        toolCalls: 4_960,
        cacheReadTokens: 1_399_565_488,
        source: `baseline/${HOSTILE}`,
      }),
    });

    const markdown = renderMarkdown(report);
    expect(isAscii(markdown)).toBe(true);
    expect(isAscii(renderJson(report))).toBe(true);

    // Not one of the hostile values reached the document as itself, so none of
    // them could have ended a row or opened a line of its own.
    expect(markdown).not.toContain(HOSTILE);
    // Both of these carry a newline, so both are blocks rather than cells: one
    // escaped line per line, the lines themselves kept, and no pipe escape --
    // a pipe inside a fence is a pipe, and escaping it there would be a
    // second spelling of a character that ends nothing.
    const facts = parseMarkdown(markdown);
    expect(facts.get("sections.ac9.facts.baseline.source")).toBe(asBlock(`baseline/${HOSTILE}`));
    expect(facts.get("sections.inputs.facts.v1_shadow.source")).toBe(asBlock(`source/${HOSTILE}`));
    // And the two renderings still agree, which is the property the escaping must
    // not buy its safety at the expense of.
    expect(Object.fromEntries(facts)).toEqual(
      Object.fromEntries(walkJson(parseReportJson(renderJson(report)))),
    );
  });

  test("a hostile banner cannot inject a line above the table", () => {
    // The banner is the FIRST thing the Markdown emits and it is built from
    // detector_version values read out of the database, so an unescaped newline
    // there writes a line above everything, where a reader is most likely to take
    // it for the report's own words.
    const report = new MeasurementReport({
      header: headerStub([`period is NON-HOMOGENEOUS: ${HOSTILE}`]),
      sections: [section("probe", "a hostile banner", [["ok", 1]])],
    });

    const markdown = renderMarkdown(report);
    expect(isAscii(markdown)).toBe(true);
    // Three lines before the table head: the title, a blank, the one banner line,
    // a blank. A forged line would make it four.
    expect(markdown.split("\n").indexOf("| Fact | Value |")).toBe(4);
  });

  test("a hostile fact key cannot forge a row or a block", () => {
    // A dotted key is built from map keys, and a fact key is whatever a caller
    // wrote. One carrying a pipe shifts every value after it one column left; one
    // carrying a newline ends the row and the next line is read as a fact nobody
    // wrote. The same escape covers the block heading, which is the same key in
    // the same backticks.
    const report = new MeasurementReport({
      header: headerStub(),
      sections: [
        section("probe", "a hostile key", [
          [HOSTILE, "single line"],
          [`${HOSTILE}-block`, "two\nlines"],
        ]),
      ],
    });

    const markdown = renderMarkdown(report);
    expect(isAscii(markdown)).toBe(true);
    const facts = parseMarkdown(markdown);
    const escaped = reportValue(HOSTILE).replaceAll("|", "\\|");
    expect(facts.get(`sections.probe.facts.${escaped}`)).toBe("single line");
    expect(facts.get(`sections.probe.facts.${escaped}-block`)).toBe("two\nlines");
  });

  test("a fenced value cannot close its own fence", () => {
    // D-0111. A block is closed by a line of backticks at least as long as the
    // one that opened it, so a value carrying a line of three backticks ends the
    // block early and everything after it is read as report structure. Escaping
    // cannot close this one: what reaches a block is another renderer's finished
    // output, and escaping it again would give one value two spellings in one
    // document. So the fence is widened instead.
    const value = "before\n```\nafter\n````\nlast";
    const report = new MeasurementReport({
      header: headerStub(),
      sections: [
        section("probe", "a fence in a value", [
          ["escape", value],
          ["after", "still a row"],
        ]),
      ],
    });

    const facts = parseMarkdown(renderMarkdown(report));
    expect(facts.get("sections.probe.facts.escape")).toBe(value);
    expect(facts.get("sections.probe.facts.after")).toBe("still a row");
  });

  test("an ordinary report's fences are exactly three backticks", () => {
    // The widening above must cost nothing on a report that needs none, or every
    // artefact this port renders diverges from interlock's for no reason.
    const markdown = renderMarkdown(reportOver(productionDb()));

    const fences = markdown.split("\n").filter((line) => /^`{3,}/.test(line));
    expect(fences.length).toBeGreaterThan(0);
    expect(new Set(fences)).toEqual(new Set(["```text", "```"]));
  });
});

// --------------------------------------------------------------------------
// target-only -- four properties the ported cases leave unguarded
//
// Found by a mutation sweep of `render.ts` (15 mutations, 10 caught), not by
// reading the file. Each one below is a mutation that survived the 60 ported
// cases, and every one of the four survives for the same structural reason:
// the headline equality test renders BOTH sides through this module's own
// `cell`, so a change to how a value is spelled moves the two sides together
// and the comparison stays equal. A test that compares a rendering to a
// rendering cannot see the rendering change.
// --------------------------------------------------------------------------

describe("target-only -- properties the ported cases leave unguarded", () => {
  test("a list renders as one comma-separated cell", () => {
    // Mutation: the join separator loses its space. Invisible to the equality
    // test for the reason above, and invisible to the JSON, which carries the
    // list structurally -- so only the Markdown changes, and only a reader
    // notices.
    const report = reportOver(productionDb());
    const parsed = parseReportJson(renderJson(report)) as {
      header: { fingerprint_tables: string[] };
    };

    expect(parseMarkdown(renderMarkdown(report)).get("header.fingerprint_tables")).toBe(
      parsed.header.fingerprint_tables.join(", "),
    );
    expect(parsed.header.fingerprint_tables.length).toBeGreaterThan(1);
  });

  test("the JSON keeps the mapping's order and carries the verdict note itself", () => {
    // Two mutations, one case. Sorting the JSON's keys buries the verdict note
    // under `header`, which is the reason `render_json` does not sort -- and
    // nothing pinned it, because both parsers here are order-insensitive.
    // Dropping the note entirely also survived: the ported no-verdict case
    // greps for `Q-0005`, and the AC-9 narrative says `Q-0005` too, so the
    // report's own field could go missing behind another module's prose.
    const report = reportOver(productionDb());
    const parsed = parseReportJson(renderJson(report)) as Record<string, unknown>;

    expect(Object.keys(parsed).slice(0, 3)).toEqual(["report_kind", "verdict", "header"]);
    expect(parsed["verdict"]).toBe(NO_VERDICT_NOTE);
  });

  test("a float is rendered as a float, and an int as an int", () => {
    // Mutation: the AC-9 coverage ratio is put in the mapping as a bare number.
    // Python has `1.0` there and prints it as `1.0` in both renderings;
    // JavaScript has one number type, so the port carries the distinction in
    // `PythonFloat` -- and losing it changes every rendered report while the
    // equality test, which renders both sides through `cell`, stays green.
    // interlock#74 AC3 compares these documents (`D-0104`).
    const report = reportOver(productionDb());
    const facts = parseMarkdown(renderMarkdown(report));
    const json = renderJson(report);

    expect(facts.get("sections.ac9.facts.coverage.ratio")).toBe("1.0");
    expect(facts.get("sections.ac9.facts.figures.coverage.value")).toBe("1.0");
    expect(facts.get("sections.ac9.facts.prompt_half.model_responses_per_100_runs")).toBe("300.0");
    expect(json).toContain('"ratio": 1.0');
    expect(json).toContain('"model_responses_per_100_runs": 300.0');
    // And a count beside them is still an int, so this is not a rule that
    // renders every number with a point.
    expect(facts.get("sections.ac9.facts.coverage.covered_count")).toBe("1");
    expect(json).toContain('"covered_count": 1,');
  });

  test("the grace and the fingerprint mode are refused before the snapshot opens", () => {
    // Two ported cases are named "refused before the cohort scan" and neither
    // asserts the ordering -- both pass on a build that checks only inside the
    // report, which is the check the source duplicates precisely to avoid. The
    // ordering is observable: `measurementSnapshot` refuses a connection without
    // the read-only capability, so an ORDINARY writable connection makes the
    // snapshot the next thing that would fail. A refusal about the argument
    // therefore proves the argument was checked first, and the third assertion
    // proves the connection really would have been refused.
    const path = productionDb();
    withWriter(path, (writable) => {
      const options = {
        dbPath: path,
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        nowMs: GENERATED_AT,
        fixtureSuite: FixtureSuiteRef.absent("no corpus in this test"),
        v1Shadow: V1ShadowInput.absent("no shadow input in this test"),
      };
      expectRefusal(
        () => buildMeasurementReport(writable, { ...options, graceMs: -1 }),
        WindowRefusal,
      );
      expectRefusal(
        () => buildMeasurementReport(writable, { ...options, fingerprintMode: "approximate" }),
        FingerprintModeRefused,
        /approximate/,
      );
      expectRefusal(() => buildMeasurementReport(writable, options), ReadOnlyCapabilityRefused);
    });
  });
});

describe("target-only -- the public constructor cannot walk around the invariant", () => {
  test("a shadow input that is neither observed nor absent is refused", () => {
    // D-0108, raised by the codex review gate. The source states the invariant
    // in its two factories and leaves the dataclass constructor public beside
    // them, so a caller who reaches for the constructor gets an input stating
    // neither its source nor its absence -- and buildMeasurementReport then
    // excludes those runs while the report shows an empty v1_owned bucket with
    // nothing beside it, which reads as "v1 owned no run in this period".
    expectRefusal(
      () => new V1ShadowInput({ source: null, runIds: ["run-9"], absentReason: null }),
      V1ShadowInputRefused,
      /states neither/,
    );
    expectRefusal(
      () => new V1ShadowInput({ source: "v1-export.json", runIds: [], absentReason: "and absent" }),
      V1ShadowInputRefused,
      /is both/,
    );
    expectRefusal(
      () => new V1ShadowInput({ source: null, runIds: ["run-9"], absentReason: "none to declare" }),
      V1ShadowInputRefused,
      /carries 1 run ids and a reason/,
    );
    // And the two shapes the factories build still construct directly, so the
    // check refuses the incoherent combinations and not the class.
    expect(
      new V1ShadowInput({
        source: "v1-export.json",
        runIds: ["run-9"],
        absentReason: null,
      }).runIds,
    ).toEqual(["run-9"]);
    expect(new V1ShadowInput({ source: null, runIds: [], absentReason: "none" }).source).toBeNull();
  });
});

// --------------------------------------------------------------------------
// target-only -- the header the report actually carries
// --------------------------------------------------------------------------

describe("target-only -- the header is the real one", () => {
  test("the report's header is a ReportHeader, not only something header-shaped", () => {
    // `ReportHeaderLike` is what the renderer requires, and it is what the stubs
    // above satisfy. That is a wider type than the source's annotation, so this
    // pins what buildMeasurementReport actually puts there: a report assembled
    // from a stub would otherwise be indistinguishable, in this file, from one
    // built over a database.
    const report = reportOver(productionDb());
    const header = report.header as ReportHeader;

    expect(header.constructor.name).toBe("ReportHeader");
    expect(header.banner().length).toBeGreaterThan(0);
  });
});
