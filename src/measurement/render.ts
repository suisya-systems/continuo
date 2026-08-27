/**
 * G6 -- one computed report, two renderings, and the header both of them carry.
 *
 * The failure this module is written against is a report that says two different
 * things to two readers. `docs/measurement-harness.md` section 6 requires the
 * provenance header "in both the Markdown and the JSON renderings", and the
 * reason the document says *both* rather than *a* rendering is that the two are
 * produced by different code paths in every implementation that has ever had
 * them: the JSON is dumped from a structure, the Markdown is written by hand,
 * and the field added last -- `censored`, `unbounded_missing`, the fingerprint
 * mode -- reaches one of them. The reader with the other one then makes a
 * decision the report's own data contradicts, and nothing in either artefact
 * shows that this happened.
 *
 * So the two renderings are not two renderers here. There is exactly one shape,
 * {@link MeasurementReport.asMapping}, and both renderings are projections of
 * it: {@link renderJson} dumps it, {@link renderMarkdown} flattens it with
 * dotted keys into one table (plus a fenced block per multi-line value, so a
 * narrative or a query's SQL text survives instead of being collapsed into a
 * cell). A fact cannot exist in one rendering and not the other, because neither
 * rendering chooses which facts it carries.
 *
 * The banner is printed twice on purpose: once as plain lines at the top, where
 * a human reads it, and once as an ordinary `header.banner` row, where a diff of
 * two reports finds it. A banner that only exists as decoration is a banner that
 * a machine comparison of two reports cannot see.
 *
 * **No verdict.** `measurement-harness.md` section 7 records `Q-0005` as open:
 * no exit criterion, sample-size minimum or acceptance threshold has been
 * decided. A renderer that printed one would decide it by inertia, which is why
 * {@link NO_VERDICT_NOTE} is a field of the report rather than a docstring
 * promise and why `test/measurement/render.test.ts` greps both renderings for
 * the vocabulary a verdict would be written in.
 *
 * **ASCII only.** Every string this module authors reaches `--help` and stdout
 * on a cp932 console, where one em-dash is a `UnicodeEncodeError` rather than a
 * degraded character. Hyphens, never em-dashes. `D-0109` extends that claim from
 * the words this module authors to the values it prints, which arrive from a
 * caller or from the database and were going into the line verbatim; `D-0111`
 * extends it to the fence a multi-line value is printed inside.
 *
 * **Read-only, and the clock is the caller's.** {@link buildMeasurementReport}
 * takes the handle {@link ../measurement/reader.js openForMeasurement} returns
 * and issues `SELECT` statements through the modules it calls; `nowMs` is a
 * parameter (`time-base-policy.md` section 2 rule 2). Nothing here reads a
 * clock, and nothing here decides anything: it assembles measurements other
 * modules made and prints them.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { effectiveRevisionId } from "../control_plane/policy.js";
import {
  QUERY_DEFINITIONS as AC9_QUERY_DEFINITIONS,
  type Ac9Report,
  type MeasuredBaseline,
  measureAc9,
  renderAc9Report,
  V1_MEASURED_BASELINE,
} from "./ac9.js";
import {
  QUERY_DEFINITIONS as COHORT_QUERY_DEFINITIONS,
  type RunCohort,
  selectCohort,
} from "./cohort.js";
import { reportValue } from "./format.js";
import { frozenList, readOnlyMap } from "./immutable.js";
import {
  buildHeader,
  coverageFromAc9,
  FINGERPRINT_CONTENT,
  FINGERPRINT_MODES,
  FingerprintModeRefused,
  type FixtureSuiteRef,
  type HeaderValue,
  imputationFromAc9,
  PythonFloat,
  renderPythonJson,
} from "./provenance.js";
import { ControlPlaneRefusal, measurementSnapshot } from "./reader.js";
import {
  defaultGraceMs,
  GRACE_DECLARED,
  GRACE_REVISION_RECONCILE_PERIOD,
  windowsSeams,
} from "./windows.js";

export const REPORT_KIND = "interlock-measurement-report";

export const MARKDOWN = "markdown";

/**
 * The JSON rendering's name, as {@link render} accepts it.
 *
 * The source calls this constant `JSON`. That spelling is not available here:
 * importing it shadows the JavaScript global of the same name for the whole
 * importing module, and the first thing a consumer of a JSON rendering does is
 * call `JSON.parse` -- so the faithful name would break the code that reads it,
 * silently, at the point of use. The **value** is what `render` dispatches on
 * and what a `--format` flag carries, and that is unchanged.
 */
export const JSON_RENDERING = "json";

export const RENDERINGS: readonly string[] = frozenList([MARKDOWN, JSON_RENDERING]);

/**
 * Printed as a field of the report, in both renderings. Phrased without the
 * vocabulary a verdict would use, because the test that keeps verdicts out of
 * this module greps for that vocabulary and a note about verdicts written in it
 * would be indistinguishable from one.
 */
export const NO_VERDICT_NOTE =
  "Q-0005 is OPEN: no exit criterion, no sample-size minimum and no " +
  "acceptance threshold has been decided, so this report states measurements " +
  "and decides nothing about them (measurement-harness.md section 7)";

/**
 * The tables this report's own figures are read off, which is the scope section
 * 6's content fingerprint has to cover: a fingerprint over fewer tables than the
 * report read would certify as identical two reads that differed in a table the
 * report used.
 */
export const FINGERPRINT_TABLES: readonly string[] = frozenList([
  "run",
  "ai_invocation",
  "incident",
  "policy_revision",
  "policy_detection_latency",
]);

/**
 * The measurement modules whose statements this report executes, each mapping
 * its own names to the very constants it hands `execute`. Folded into the
 * header's `query_definitions` so section 6's catalogue carries the report's
 * measurement queries as text rather than a note saying it does not.
 *
 * This is a mapping of module name to catalogue, not a flat merge, because the
 * completeness test walks it: for each named module it re-derives, from the
 * module's own source, every statement that module executes and asserts each one
 * is in that module's catalogue. A module added to the report without being
 * added here fails the same test from the other side -- the report is built with
 * its statements traced, and a traced statement that is neither catalogued nor
 * listed in {@link UNATTESTED_STATEMENTS} is a hole in the catalogue.
 */
export const REPORT_QUERY_SOURCES: ReadonlyMap<string, ReadonlyMap<string, string>> = readOnlyMap([
  ["cohort", COHORT_QUERY_DEFINITIONS],
  ["ac9", AC9_QUERY_DEFINITIONS],
]);

/**
 * Every statement this report executes and this catalogue does **not** carry,
 * named by the function that issues it, with the reason. Section 6 asks for
 * every query as text; where a statement cannot be carried, the honest artefact
 * is a note that names exactly which one and why -- not silence, and not a
 * pasted copy that drifts from the text that ran.
 *
 * Two different reasons live here and the difference matters to a reader:
 * `provenance`'s fingerprint statements have **no fixed text at all** (each is
 * composed from the columns the table itself reports, at call time, so the text
 * depends on the database being measured), and what the digest covers is
 * attested instead by `header.db_fingerprint`'s own statement and by
 * `header.fingerprint_mode`. The rest are statements that are still inline in
 * modules outside this catalogue's reach; each is the same one-line lift
 * `ac9.ts` and `cohort.ts` have had, and until it is made, naming their text
 * here would be the pasted copy this note exists to avoid.
 *
 * The keys are the **source's** function names, not this port's. They name the
 * statement a reader would go looking for in interlock, and this report is what
 * a parity comparison of the two implementations is made from: renaming them to
 * `measurementSnapshot` and `appliedMigrations` would make the two reports
 * differ on a field whose subject is identical.
 */
export const UNATTESTED_STATEMENTS: ReadonlyMap<string, string> = readOnlyMap([
  [
    "reader.measurement_snapshot",
    "the report's read snapshot: BEGIN, one read of sqlite_master to " +
      "take the SHARED lock the deferred BEGIN does not, and ROLLBACK. " +
      "Transaction control over the report's reads rather than a query " +
      "any figure comes from -- catalogued here so that the report's own " +
      "trace stays complete, since section 6's catalogue is of the " +
      "queries a reader would re-run by hand and re-running these would " +
      "reproduce no number",
  ],
  [
    "reader._require_query_only",
    "PRAGMA query_only, read back before and inside the snapshot to " +
      "prove the read-only capability is still in force (D-0040, " +
      "ACCEPTANCE.md section 3 condition 5). It is the instrument's " +
      "self-check, not a measurement; its result is attested by the " +
      "report existing at all, since a guard not in force is a refusal",
  ],
  [
    "provenance._columns_of",
    "the table introspection behind the content fingerprint; composed " +
      "per table at call time, so it has no fixed text to carry",
  ],
  [
    "provenance._feed_rows",
    "the fingerprint's per-table projection, composed from that table's " +
      "own columns at call time; what the digest covers is attested by " +
      "header.db_fingerprint's statement and header.fingerprint_mode",
  ],
  [
    "provenance.build_header",
    "the schema-identity pragmas (application_id, user_version), which " +
      "the header carries as fields rather than as query text; this " +
      "module's two measurement queries ARE in the catalogue",
  ],
  [
    "migrator.applied_migrations",
    "the schema_migration ledger read behind " +
      "header.schema_migration_head, inline in control_plane/migrator.py",
  ],
  [
    "policy.effective_revision_id",
    "the revision in force at the period start, inline in " +
      "control_plane/policy.py; the revision it resolved is carried as " +
      "header.policy_revision_id",
  ],
  [
    "policy.revision_over_period",
    "the revision-change scan behind the header's banner, inline in " + "control_plane/policy.py",
  ],
  [
    "windows.default_grace_ms",
    "the reconcile-period default read from the resolved revision, " +
      "inline in windows.py; the value it returned is carried as " +
      "sections.observation_window.facts.grace_ms with its source",
  ],
]);

/**
 * Printed as a field of the report. Generated from {@link UNATTESTED_STATEMENTS}
 * rather than written beside it, because a hand-written note and the list it
 * describes drift in one direction only: the note goes on claiming a
 * completeness the list stopped having.
 */
export const QUERY_CATALOGUE_LIMITATION =
  "query_definitions carries every statement the measurement modules this " +
  "report runs execute -- " +
  [...REPORT_QUERY_SOURCES.keys()].map((module) => `${module}.py`).join(", ") +
  " -- plus the header's own, as the text that ran rather than a copy of " +
  `it. ${UNATTESTED_STATEMENTS.size} ` +
  "further statements the report issues are not in it: each is named, with " +
  "the reason it cannot be carried, under inputs.query_catalogue_exemptions";

/**
 * Every catalogued statement this report runs, as one `name -> text` set.
 *
 * The merge is a function rather than a module-level constant so that a name
 * used by two modules for two different texts is refused where a reader can see
 * which report asked for it: {@link buildHeader} merges this with the header's
 * own queries and refuses the same collision, and a constant built at import
 * time would raise during import instead.
 */
export function reportQueryDefinitions(): ReadonlyMap<string, string> {
  const merged = new Map<string, string>();
  for (const [module, definitions] of REPORT_QUERY_SOURCES) {
    for (const [name, text] of definitions) {
      const existing = merged.get(name);
      if (existing !== undefined && existing !== text) {
        throw new RenderRefusal(
          `query name '${name}' is used by ${module} for a text another ` +
            "measurement module already claims; the header's digest " +
            "would be over one of them and the report would have run " +
            "the other",
        );
      }
      merged.set(name, text);
    }
  }
  return readOnlyMap(merged);
}

/**
 * Why the header's censoring counts are zero on a report of this shape. A zero
 * that means "no episode was classified" and a zero that means "no episode was
 * censored" are different statements, and section 3.5 makes the second one load
 * bearing, so the first is said out loud rather than left to be misread.
 */
export const WINDOW_EPISODES_NOT_CLASSIFIED =
  "no episode was classified in this report: this branch implements detectors " +
  "and reporting, and the driver that produces episodes is not part of it, so " +
  "the censored and censored_left counts are zero for want of episodes rather " +
  "than because nothing was censored";

/**
 * The fence language of a multi-line value's block. `text` rather than the
 * value's real syntax: a block tagged `sql` that is not SQL is a lie a reader
 * acts on, and the report holds both kinds.
 */
export const BLOCK_LANGUAGE = "text";

/**
 * What an empty mapping renders as. An empty block is a fact -- "the report has
 * no unmatched episodes" -- and dropping its row would make it indistinguishable
 * from a field nobody computed.
 */
export const EMPTY_BLOCK = "(none)";

const TABLE_HEAD: readonly string[] = frozenList(["| Fact | Value |", "| --- | --- |"]);

/** The shortest Markdown fence, which is what an ordinary report uses. */
const MINIMUM_FENCE = 3;

/**
 * Anything the report mapping can hold.
 *
 * The source annotates `facts` as `Mapping[str, Any]`, which is the widest type
 * Python has. This is the header's own value type, and it is deliberately
 * narrower: it is exactly the set both renderings know how to print, so a value
 * neither of them can render is a compile error at the call site rather than a
 * `[object Object]` in one rendering and a serialisation failure in the other.
 * Conventions rule 9 is the reason to prefer the narrower one -- the port's
 * types are wider than the source's by default, and the widening is where the
 * defects live.
 */
export type ReportValue = HeaderValue;

/**
 * What a rendering asks of a header.
 *
 * The source annotates {@link MeasurementReport}'s header as `ReportHeader` and
 * then hands it a stub in four cases -- the renderer only ever calls `banner()`
 * and `as_mapping()`, and Python does not check the annotation. TypeScript does,
 * so the annotation is written as what the renderer actually requires. That is
 * not a weakening: the real header satisfies it, and the alternative is either
 * building a migrated database for a case about a pipe in a table cell or
 * casting a stub through `unknown`, which asserts the same thing with nothing
 * checking it.
 */
export interface ReportHeaderLike {
  banner(): readonly string[];
  asMapping(): ReadonlyMap<string, ReportValue>;
}

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/** Base for every refusal this module raises. */
export class RenderRefusal extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RenderRefusal";
    Object.setPrototypeOf(this, RenderRefusal.prototype);
  }
}

/** A section name that cannot be a stable key in both renderings. */
export class SectionNameRefused extends RenderRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "SectionNameRefused";
    Object.setPrototypeOf(this, SectionNameRefused.prototype);
  }
}

/** Two sections under one name: one of them would be invisible in the JSON. */
export class DuplicateSectionRefused extends RenderRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DuplicateSectionRefused";
    Object.setPrototypeOf(this, DuplicateSectionRefused.prototype);
  }
}

/** A header with no section is provenance for a measurement nobody made. */
export class SectionsRequired extends RenderRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "SectionsRequired";
    Object.setPrototypeOf(this, SectionsRequired.prototype);
  }
}

/** A rendering this module does not produce. */
export class UnknownRendering extends RenderRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnknownRendering";
    Object.setPrototypeOf(this, UnknownRendering.prototype);
  }
}

/** A shadow input that states neither its source nor its absence. */
export class V1ShadowInputRefused extends RenderRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "V1ShadowInputRefused";
    Object.setPrototypeOf(this, V1ShadowInputRefused.prototype);
  }
}

// --------------------------------------------------------------------------
// the v1 shadow input
// --------------------------------------------------------------------------

/**
 * The v1 run ids a report was given, or a stated absence of them.
 *
 * `D-0013` leaves no v1-owned run in this database to find, so the `v1_owned`
 * exclusion bucket can only come from outside ({@link selectCohort}'s
 * `v1ShadowRunIds`). Passing nothing yields an empty bucket, and an empty bucket
 * rendered without saying where it came from reads as "v1 owned no run in this
 * period" -- an assertion the report is in no position to make. So the input is
 * either observed from a named source or absent for a stated reason, and the
 * report prints which.
 */
export class V1ShadowInput {
  readonly source: string | null;
  readonly runIds: readonly string[];
  readonly absentReason: string | null;

  constructor(fields: {
    readonly source: string | null;
    readonly runIds: Iterable<string>;
    readonly absentReason: string | null;
  }) {
    this.source = fields.source;
    this.runIds = frozenList(fields.runIds);
    this.absentReason = fields.absentReason;
    Object.freeze(this);
  }

  static observed(source: string, runIds: Iterable<string>): V1ShadowInput {
    if (source.trim() === "") {
      throw new V1ShadowInputRefused(
        "name where the v1 shadow run ids came from; an unnamed source " +
          "cannot be checked by a reader recomputing this report",
      );
    }
    return new V1ShadowInput({ source, runIds, absentReason: null });
  }

  static absent(reason: string): V1ShadowInput {
    if (reason.trim() === "") {
      throw new V1ShadowInputRefused(
        "state why this report has no v1 shadow input; an unexplained " +
          "absence is indistinguishable from a report that forgot to pass " +
          "one, and the two produce the same empty v1_owned bucket",
      );
    }
    return new V1ShadowInput({ source: null, runIds: [], absentReason: reason });
  }

  asMapping(): ReadonlyMap<string, ReportValue> {
    return readOnlyMap<string, ReportValue>([
      ["source", this.source],
      ["absent_reason", this.absentReason],
      ["run_id_count", this.runIds.length],
      ["run_ids", [...this.runIds]],
    ]);
  }
}

// --------------------------------------------------------------------------
// sections
// --------------------------------------------------------------------------

/** The characters a section name may not carry; see {@link ReportSection}. */
const KEY_SYNTAX_CHARACTERS: readonly string[] = frozenList([".", " ", "|", "`"]);

/**
 * One measurement's facts, plus the module's own rendering of them.
 *
 * `facts` is the machine-comparable half and `narrative` the human half, and
 * both travel in **both** renderings: a JSON consumer that could not see the
 * narrative would be reading a different report from the operator, which is the
 * failure the module docstring names, one level down.
 */
export class ReportSection {
  readonly name: string;
  readonly title: string;
  readonly facts: ReadonlyMap<string, ReportValue>;
  readonly narrative: string | null;

  constructor(fields: {
    readonly name: string;
    readonly title: string;
    readonly facts: Iterable<readonly [string, ReportValue]>;
    readonly narrative?: string | null;
  }) {
    const { name, title } = fields;
    // The name becomes a dotted key in the Markdown and an object key in the
    // JSON. A name carrying a dot would produce a Markdown key that parses back
    // as two levels of nesting the JSON does not have, so two readers comparing
    // the renderings would disagree about the shape.
    if (name === "" || name.trim() === "") {
      throw new SectionNameRefused("a section needs a name to be keyed by");
    }
    if (KEY_SYNTAX_CHARACTERS.some((character) => name.includes(character))) {
      throw new SectionNameRefused(
        `section name '${name}' carries a dot, a space, a pipe or a ` +
          "backtick; those are the Markdown rendering's own syntax, and a " +
          "key that collides with it renders as a different key than the " +
          "JSON carries",
      );
    }
    if (title.trim() === "") {
      throw new SectionNameRefused(
        `section '${name}' needs a title; a section a reader cannot ` +
          "name is a table of numbers about nothing",
      );
    }
    this.name = name;
    this.title = title;
    this.facts = readOnlyMap(fields.facts);
    this.narrative = fields.narrative ?? null;
    Object.freeze(this);
  }

  asMapping(): ReadonlyMap<string, ReportValue> {
    return readOnlyMap<string, ReportValue>([
      ["title", this.title],
      ["narrative", this.narrative],
      ["facts", readOnlyMap(this.facts)],
    ]);
  }
}

/** A `float` field, or `null`, as Python spells it in both renderings. */
function pythonFloat(value: number | null): ReportValue {
  return value === null ? null : new PythonFloat(value);
}

/**
 * Section 2's measurement as facts, with {@link renderAc9Report} as narrative.
 *
 * The cohort travels with the AC-9 numbers because `D-0038` makes the
 * excluded-reason breakdown required output -- "a reduction rate printed without
 * them is not a valid report" -- and a JSON consumer reading only this section
 * must be as unable to print the rate without them as an operator reading the
 * text is.
 *
 * Every number here is read off `report` and `cohort`; nothing is recomputed. A
 * second computation of a figure the report already carries is a second figure,
 * and the day they disagree there is no way to tell which one the narrative
 * beside them came from.
 */
export function sectionFromAc9(report: Ac9Report, cohort: RunCohort): ReportSection {
  const figures = readOnlyMap<string, ReportValue>(
    report.figures().map((figure): [string, ReportValue] => [
      // `replaceAll`, not `replace`: Python's `str.replace` replaces every
      // occurrence, and "observed output-token reduction" has two spaces.
      figure.label.replaceAll(" ", "_"),
      readOnlyMap<string, ReportValue>([
        ["kind", figure.kind],
        ["value", pythonFloat(figure.value)],
        ["basis", figure.basis],
      ]),
    ]),
  );
  return new ReportSection({
    name: "ac9",
    title: "AC-9 - AI prompts and output tokens",
    narrative: renderAc9Report(report),
    facts: [
      [
        "cohort",
        readOnlyMap<string, ReportValue>([
          ["denominator", cohort.denominator],
          ["run_ids", [...cohort.runIds]],
          ["excluded", readOnlyMap<string, ReportValue>(cohort.excludedCounts())],
        ]),
      ],
      [
        "series",
        readOnlyMap<string, ReportValue>([
          ["model_response_total", report.modelResponseTotal],
          ["invocation_count", report.invocationCount],
          ["attempt_total", report.attemptTotal],
          ["observed_output_tokens", report.observedOutputTokens],
          ["input_tokens_total", report.inputTokensTotal],
          ["cache_read_tokens_total", report.cacheReadTokensTotal],
          ["unattributed_invocations", report.unattributedInvocations],
        ]),
      ],
      [
        "coverage",
        readOnlyMap<string, ReportValue>([
          ["covered_count", report.coveredCount],
          ["missing_count", report.missingCount],
          ["ratio", pythonFloat(report.coverageRatio)],
          ["is_complete", report.coverageIsComplete],
        ]),
      ],
      ["figures", figures],
      [
        "prompt_half",
        readOnlyMap<string, ReportValue>([
          ["model_responses_per_100_runs", pythonFloat(report.modelResponsesPer100Runs)],
          ["prompt_reduction", pythonFloat(report.promptReduction)],
        ]),
      ],
      [
        "imputation",
        readOnlyMap<string, ReportValue>([
          ["bounded_output_tokens", report.boundedOutputTokens],
          ["sensitivity_output_tokens", report.sensitivityOutputTokens],
          ["covered_p95_output_tokens", report.coveredP95OutputTokens],
          ["unbounded_missing", [...report.unboundedMissing]],
          ["unconfirmed_response_count", [...report.unconfirmedResponseCount]],
          ["supports_acceptance_claim", report.supportsAcceptanceClaim],
        ]),
      ],
      ["ac1_violations", [...report.ac1Violations]],
      [
        "baseline",
        readOnlyMap<string, ReportValue>([
          ["source", report.baseline.source],
          ["completed_runs", report.baseline.completedRuns],
          ["model_responses", report.baseline.modelResponses],
          ["output_tokens", report.baseline.outputTokens],
          ["tool_calls", report.baseline.toolCalls],
          ["cache_read_tokens", report.baseline.cacheReadTokens],
        ]),
      ],
    ],
  });
}

/**
 * The observation-window grace this report was computed under.
 *
 * Grace is declared **per report** (section 3.5), so it belongs in the report
 * even when the report classified no episode: a reader comparing two reports has
 * to be able to see that the window moved, and a grace that is only visible when
 * there are episodes is invisible on exactly the report whose emptiness it might
 * explain.
 */
export function sectionFromWindowDeclaration(options: {
  readonly graceMs: number;
  readonly graceSource: string;
  readonly episodesClassified: number;
}): ReportSection {
  // The window model's own rule, not a copy of it: a grace it refuses would
  // otherwise be stamped as this report's declared configuration, and this
  // branch classifies no episodes, so nothing downstream would ever raise it.
  // Called through `windowsSeams` for the reason that record exists -- the
  // source case that pins this replaces the rule ON the window module and
  // asserts the report follows it there.
  windowsSeams.requireGraceMs(options.graceMs);

  return new ReportSection({
    name: "observation_window",
    title: "Observation window - the grace this report was computed under",
    narrative: null,
    facts: [
      ["grace_ms", options.graceMs],
      ["grace_source", options.graceSource],
      ["episodes_classified", options.episodesClassified],
      ["scope", WINDOW_EPISODES_NOT_CLASSIFIED],
    ],
  });
}

// --------------------------------------------------------------------------
// the report
// --------------------------------------------------------------------------

/**
 * A provenance header and the sections measured under it.
 *
 * The header is not optional and is not a section: section 6 makes it the thing
 * that turns the numbers into evidence, and a section list a caller could
 * assemble without one would produce a report that is an opinion.
 */
export class MeasurementReport {
  readonly header: ReportHeaderLike;
  readonly sections: readonly ReportSection[];

  constructor(fields: {
    readonly header: ReportHeaderLike;
    readonly sections: Iterable<ReportSection>;
  }) {
    const sections = frozenList(fields.sections);
    if (sections.length === 0) {
      throw new SectionsRequired(
        "a report with no section is a provenance header for a " +
          "measurement nobody made; give it the sections it is provenance " +
          "for",
      );
    }
    const seen = new Set<string>();
    for (const section of sections) {
      if (seen.has(section.name)) {
        throw new DuplicateSectionRefused(
          `two sections are named '${section.name}'; the JSON ` +
            "rendering keys sections by name, so the second one would " +
            "replace the first and the Markdown would still show both",
        );
      }
      seen.add(section.name);
    }
    this.header = fields.header;
    this.sections = sections;
    Object.freeze(this);
  }

  /**
   * The one shape both renderings are projections of.
   *
   * Ordered so that a reader who stops after the first screen has stopped after
   * the verdict note and the header's homogeneity banner, not before them.
   */
  asMapping(): ReadonlyMap<string, ReportValue> {
    return readOnlyMap<string, ReportValue>([
      ["report_kind", REPORT_KIND],
      ["verdict", NO_VERDICT_NOTE],
      ["header", this.header.asMapping()],
      [
        "sections",
        readOnlyMap<string, ReportValue>(
          this.sections.map((section): [string, ReportValue] => [
            section.name,
            section.asMapping(),
          ]),
        ),
      ],
    ]);
  }

  section(name: string): ReportSection {
    for (const section of this.sections) {
      if (section.name === name) {
        return section;
      }
    }
    const carried = this.sections.map((section) => section.name).join(", ");
    throw new SectionNameRefused(
      `this report carries no section named '${name}'; it carries ` +
        `${carried === "" ? EMPTY_BLOCK : carried}`,
    );
  }
}

/**
 * The module's replaceable internals (DECISIONS.md `D-0014`).
 *
 * Two source cases reach into this module with `monkeypatch.setattr`, replacing
 * `measure_ac9` **as this module sees it** -- the point the report reaches after
 * the cohort has been selected and before the header is built, which is the
 * middle of the window section 6's fingerprint claim depends on being closed.
 * One commits a row from a second connection there and asserts it is held off;
 * the other observes `connection.in_transaction` from inside and asserts the
 * snapshot is the report's own. ESM bindings cannot be rebound from outside, so
 * the call site goes through this record.
 *
 * Not re-exported from `src/index.ts`: it is a seam for the tests that own this
 * module, not public API.
 */
export const renderSeams = {
  /** @see measureAc9 */
  measureAc9,
};

/**
 * Assemble the report a caller can render, deciding nothing.
 *
 * `connection` must be {@link ../measurement/reader.js openForMeasurement}'s
 * handle: every module called below issues `SELECT` statements through it and
 * this function opens nothing of its own, so there is no path here that could
 * acquire a writable one.
 *
 * `nowMs` is the caller's clock, read once at the process boundary and passed
 * down (`time-base-policy.md` section 2 rule 2). Nothing below this signature
 * reads a clock.
 *
 * `fixtureSuite` and `v1Shadow` are required with no default, for the reason
 * {@link buildHeader} gives about its own: a defaulted corpus reference or a
 * defaulted shadow input would go missing on exactly the report that needed it,
 * and both are declared per report rather than derived from the database.
 *
 * `graceMs` declares the observation-window grace, and is held to
 * {@link ../measurement/windows.js requireGraceMs} -- the same rule
 * `episodeWindow` applies -- so the section 6 provenance cannot attest to a
 * configuration no window could have been computed under. `undefined` resolves
 * it from the policy revision in force (`windows.defaultGraceMs`, one reconcile
 * period) and stamps the source as such, which is a derivation the report
 * records rather than a constant it hides.
 *
 * The censoring counts on the header are zero here and
 * {@link WINDOW_EPISODES_NOT_CLASSIFIED} says why: this branch implements
 * detectors and reporting, and the driver that produces episodes is not part of
 * it, so there is nothing to censor yet.
 *
 * **Every read below happens inside one snapshot**
 * ({@link ../measurement/reader.js measurementSnapshot}), the header's
 * fingerprint included. The scope is opened *here* rather than asked of the
 * caller because a caller who forgot it would get an autocommit report back --
 * the cohort selected on one state of the database, AC-9 aggregated on another
 * and the fingerprint taken over a third -- with nothing in the output to say
 * so, which is the section 6 claim quietly becoming false. The cost is stated in
 * that function and is not small: production databases here are not in WAL, so
 * the report holds a SHARED lock and **blocks every writer on the control plane
 * until it finishes**.
 */
export function buildMeasurementReport(
  connection: SqliteDatabase,
  options: {
    readonly dbPath: string;
    readonly periodStartMs: number;
    readonly periodEndMs: number;
    readonly nowMs: number;
    readonly fixtureSuite: FixtureSuiteRef;
    readonly v1Shadow: V1ShadowInput;
    readonly graceMs?: number | undefined;
    readonly fingerprintMode?: string;
    readonly baseline?: MeasuredBaseline;
  },
): MeasurementReport {
  const { dbPath, periodStartMs, periodEndMs, nowMs, fixtureSuite, v1Shadow } = options;
  const fingerprintMode = options.fingerprintMode ?? FINGERPRINT_CONTENT;
  const baseline = options.baseline ?? V1_MEASURED_BASELINE;

  if (options.graceMs !== undefined) {
    // Checked here as well as in sectionFromWindowDeclaration, for the reason
    // the fingerprint mode is checked twice below: a caller who declares a grace
    // the window model refuses learns it before the cohort scan holds a SHARED
    // lock on every writer, rather than after.
    windowsSeams.requireGraceMs(options.graceMs);
  }

  if (!FINGERPRINT_MODES.includes(fingerprintMode)) {
    // Refused here as well as inside fingerprintDatabase, so a caller that
    // mistypes the mode learns it before the cohort scan rather than after.
    throw new FingerprintModeRefused(
      `fingerprint mode '${fingerprintMode}' is not one of ${FINGERPRINT_MODES.join(", ")}`,
    );
  }

  // One snapshot for the whole report, the fingerprint included: see
  // reader.measurementSnapshot for why a report that reads outside one cannot
  // make section 6's claim, and for what holding it costs writers.
  return measurementSnapshot(connection, { target: dbPath }, (held) => {
    // Every policy read binds a caller-resolved revision (D-0031's corollary),
    // and the revision this report binds is the one in force at its period's
    // start -- the instant its earliest judgement would have been made under.
    const revisionId = effectiveRevisionId(held, { nowMs: periodStartMs });

    let resolvedGraceMs: number;
    let graceSource: string;
    if (options.graceMs === undefined) {
      resolvedGraceMs = defaultGraceMs(held, { revisionId });
      graceSource = GRACE_REVISION_RECONCILE_PERIOD;
    } else {
      resolvedGraceMs = options.graceMs;
      graceSource = GRACE_DECLARED;
    }

    const selected = selectCohort(held, {
      periodStartMs,
      periodEndMs,
      nowMs,
      v1ShadowRunIds: v1Shadow.runIds,
    });
    const measured = renderSeams.measureAc9(held, selected, { nowMs, baseline });

    const header = buildHeader(held, {
      dbPath,
      periodStartMs,
      periodEndMs,
      generatedAtMs: nowMs,
      policyRevisionId: revisionId,
      fingerprintTables: FINGERPRINT_TABLES,
      queryDefinitions: reportQueryDefinitions(),
      fixtureSuite,
      imputation: imputationFromAc9(measured),
      coverage: coverageFromAc9(measured, selected),
      censored: 0,
      censoredLeft: 0,
      unmatched: readOnlyMap<string, number>([]),
      fingerprintMode,
    });

    const inputs = new ReportSection({
      name: "inputs",
      title: "Inputs declared for this report",
      narrative: null,
      facts: [
        ["v1_shadow", v1Shadow.asMapping()],
        ["query_catalogue_limitation", QUERY_CATALOGUE_LIMITATION],
        ["query_catalogue_exemptions", readOnlyMap<string, ReportValue>(UNATTESTED_STATEMENTS)],
      ],
    });
    return new MeasurementReport({
      header,
      sections: [
        inputs,
        sectionFromWindowDeclaration({
          graceMs: resolvedGraceMs,
          graceSource,
          episodesClassified: 0,
        }),
        sectionFromAc9(measured, selected),
      ],
    });
  });
}

// --------------------------------------------------------------------------
// the two renderings
// --------------------------------------------------------------------------

/**
 * Render `report` in the named rendering.
 *
 * The dispatch is here so that a caller choosing a rendering from a flag cannot
 * reach one of them and miss the other's existence.
 */
export function render(report: MeasurementReport, rendering: string): string {
  if (rendering === MARKDOWN) {
    return renderMarkdown(report);
  }
  if (rendering === JSON_RENDERING) {
    return renderJson(report);
  }
  throw new UnknownRendering(`'${rendering}' is not one of ${RENDERINGS.join(", ")}`);
}

/**
 * The JSON rendering: {@link MeasurementReport.asMapping}, verbatim.
 *
 * Keys are deliberately not sorted, because the mapping's order is the reading
 * order -- the verdict note and the header's banner come first by construction
 * and sorting would bury them. Non-ASCII is escaped: this reaches a cp932
 * console, where a non-encodable character raises rather than degrades.
 */
export function renderJson(report: MeasurementReport): string {
  return renderPythonJson(report.asMapping(), 0);
}

/**
 * The Markdown rendering: the same mapping, flattened.
 *
 * Every leaf of the mapping reaches the output, single-line values as table rows
 * and multi-line ones as fenced blocks keyed by the same dotted name. The split
 * exists because a cell cannot hold a newline: collapsing a narrative or a
 * query's SQL into one line would leave the Markdown reader with a fact the JSON
 * reader can act on and they cannot.
 */
export function renderMarkdown(report: MeasurementReport): string {
  const lines: string[] = [`# ${REPORT_KIND}`, ""];
  // D-0109: the banner is built from detector_version and policy_revision_id
  // values read out of the database, and it is the FIRST thing this rendering
  // emits -- an unescaped newline there injects a line above everything.
  lines.push(...report.header.banner().map((line) => reportValue(line)));
  lines.push("");
  lines.push(...TABLE_HEAD);

  const blocks: [string, string][] = [];
  for (const [key, value] of flatten(report.asMapping())) {
    if (typeof value === "string" && value.includes("\n")) {
      blocks.push([key, value]);
      continue;
    }
    lines.push(`| \`${keyText(key)}\` | ${cell(value)} |`);
  }

  for (const [key, value] of blocks) {
    // D-0109, one delimiter along. A block exists so a multi-line value's LINES
    // survive; every other hazard the escape covers is a hazard here too, so the
    // value is escaped line by line. `reportValue` over the whole value would
    // turn the newlines themselves into escapes and collapse the block back into
    // the single line it exists to avoid, so it is applied to each line instead
    // -- which is the same function on text that, by construction, holds none.
    //
    // A block value is NOT exempt on the grounds that only this package's own
    // constants reach one. That was the first version of this comment, and it
    // was wrong: a fact carrying a newline becomes a block, and a fact is
    // whatever the database or the caller supplied -- a v1 shadow source, a run
    // id, a baseline's description. The structural case in the test file found
    // the leak with every other escape already in place, which is the whole
    // reason that case renders a report rather than asserting about one.
    const escaped = value.split("\n").map((line) => reportValue(line));
    const fence = "`".repeat(fenceWidth(escaped));
    lines.push("", `### fact \`${keyText(key)}\``, `${fence}${BLOCK_LANGUAGE}`);
    lines.push(...escaped);
    lines.push(fence);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * How many backticks this block's fence needs.
 *
 * `D-0111`. A fenced block is closed by a line of backticks at least as long as
 * the one that opened it, so a value carrying a line of three backticks ends the
 * block early and everything after it -- the rest of that value, and every later
 * block -- is read as report structure. That is the same injection `D-0109`
 * closed for table cells, one delimiter along, and escaping cannot close it here
 * for the reason the comment above gives.
 *
 * So the fence is widened past the longest run of backticks the value holds.
 * A value with no backticks, which is every value an ordinary report carries,
 * gets exactly the three the source emits, so this changes no report interlock
 * renders correctly.
 */
function fenceWidth(lines: readonly string[]): number {
  let longest = 0;
  for (const line of lines) {
    let run = 0;
    for (const character of line) {
      run = character === "`" ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
  }
  return Math.max(MINIMUM_FENCE, longest + 1);
}

/**
 * `mapping` as dotted key / leaf pairs, in the mapping's own order.
 *
 * Mappings recurse and everything else is a leaf, including lists: a list of
 * scalars is one fact ("these ids"), and exploding it into indexed keys would
 * make two reports with the same ids in a different order look different in the
 * Markdown while comparing equal in the JSON.
 */
export function flatten(
  mapping: ReadonlyMap<string, ReportValue>,
): readonly (readonly [string, ReportValue])[] {
  const pairs: [string, ReportValue][] = [];
  for (const [key, value] of mapping) {
    pairs.push(...flattenValue(String(key), value));
  }
  return frozenList(pairs);
}

function flattenValue(prefix: string, value: ReportValue): [string, ReportValue][] {
  if (isReportMap(value)) {
    const entries = [...value.entries()];
    if (entries.length === 0) {
      // An empty block is a fact and keeps its row. Dropping it would make
      // "nothing was unmatched" indistinguishable from "nobody computed
      // unmatched", which is the difference the header exists to state.
      return [[prefix, null]];
    }
    const flattened: [string, ReportValue][] = [];
    for (const [key, item] of entries) {
      flattened.push(...flattenValue(`${prefix}.${key}`, item));
    }
    return flattened;
  }
  return [[prefix, value]];
}

/**
 * Is this report value a nested mapping?
 *
 * Structural, for the reason `provenance.isHeaderMap` is: {@link readOnlyMap}
 * deliberately does not return something `instanceof Map` (D-0105), so the test
 * is for the interface both renderings need, with the two object-shaped leaves
 * excluded explicitly.
 */
function isReportMap(value: ReportValue): value is ReadonlyMap<string, ReportValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PythonFloat) &&
    typeof (value as ReadonlyMap<string, ReportValue>).entries === "function"
  );
}

/**
 * One dotted key, as the Markdown writes it inside backticks.
 *
 * D-0109: a dotted key is built from map KEYS -- a query name, an exclusion
 * reason, a fact name a caller chose -- and interlock interpolates it raw. A key
 * carrying a pipe shifts every value after it one column left; one carrying a
 * newline ends the row and the next line is read as a fact nobody wrote.
 *
 * Escaped WITHOUT `cell`'s trim, for the reason `provenance.renderHeaderMarkdown`
 * gives: a query name is only required to be non-empty, so " q" and "q" are two
 * names the catalogue and its digest keep apart, and trimming would render them
 * as one field.
 */
function keyText(key: string): string {
  return reportValue(key).replaceAll("|", "\\|");
}

/**
 * One Markdown table cell: ASCII-shaped, pipe-safe, single-line.
 *
 * A `|` inside a value ends the cell and shifts every later column one to the
 * left, which is a rendering that silently mislabels values rather than one that
 * looks broken -- so it is escaped rather than trusted not to appear. `null` is
 * {@link EMPTY_BLOCK} and not an empty cell, because an empty cell reads as a
 * field nobody filled in.
 *
 * D-0109: escaped for the console as well as for the table, so the Markdown
 * rendering honours the same ASCII claim the JSON one has honoured from the
 * start. The value is escaped FIRST and the table's own pipe escape added after:
 * the other order doubles it, since `reportValue` would escape the backslash the
 * pipe escape just introduced. A newline needs no separate fold -- `reportValue`
 * turns it into an escape, which says more than the source's space did.
 *
 * Rendering and escaping are two functions rather than one for the reason
 * `provenance.cell` splits them: folding them together escapes an array's items
 * once each and then again once joined.
 */
export function cell(value: ReportValue): string {
  return reportValue(renderCell(value).trim()).replaceAll("|", "\\|");
}

/** A cell's text, before any escaping. Recurses; never escapes. */
function renderCell(value: ReportValue): string {
  if (value === null) {
    return EMPTY_BLOCK;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return value.length > 0
      ? value.map((item) => renderCell(item as ReportValue)).join(", ")
      : EMPTY_BLOCK;
  }
  return String(value);
}
