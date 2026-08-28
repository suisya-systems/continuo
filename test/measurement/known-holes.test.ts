/**
 * Section 7's five holes, bound to the suite so that filling one silently fails.
 *
 * Ported from interlock `tests/measurement/test_known_holes.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping, the systematic
 * translations and the deliberate divergences are recorded in
 * `parity/measurement.known-holes.ledger.json`.
 *
 * The failure this file is written against is not a bug in any module. It is the
 * way a *stated* hole stops being stated: someone adds a rate, wants to know
 * whether the rate is good, and writes the comparison -- and
 * `docs/measurement-harness.md` section 7's "`Q-0005` stays open" becomes an
 * answer nobody decided, arriving as a default. The same drift closes `Q-0009`
 * (a report that picks a detector version), `Q-0011` (a Secretary latency
 * threshold invented in the module that already has milliseconds in it) and the
 * harness's read-only property (one convenient backfill of an `ai_invocation`
 * row).
 *
 * Two properties here are **discovery-driven on purpose**, because a test that
 * reads a hand-written list of modules covers exactly the modules that existed
 * on the day it was written, and the module that fills a hole is by definition a
 * later one:
 *
 * * every public `render*` in the package is discovered by walking the package
 *   ({@link publicRenderers}), and a renderer with no entry in
 *   {@link REPORT_FACTORIES} **fails** rather than being skipped -- so a new
 *   report cannot reach a reader without its rendering being read for a verdict;
 * * every file under the package is parsed and every statement handed to the
 *   driver in it is classified (`statementsExecuted`), so a new module that
 *   writes is caught by a test that never heard of it.
 *
 * Both walks live in `test/measurement/module-scan.ts`, which also carries the
 * reasons the port's two walks are spelled the way they are. The static half is
 * shared with the query-catalogue belt, exactly as the source shares it.
 *
 * The verdict vocabulary is matched with word boundaries: the reports
 * legitimately contain `ongoing`, `category` and `coverage`, and a pattern that
 * fired on those would be turned off within a week.
 *
 * Nothing here writes: reports are built over an empty migrated production
 * database through the same {@link openForMeasurement} handle the harness uses,
 * so a factory that needed a write could not be written.
 *
 * **The port has one public renderer the source does not.** `render_header_json`
 * and `render_json` are `json.dumps` calls in Python; Node has no `json.dumps`,
 * so `provenance.renderPythonJson` is the port's own spelling of it and has to
 * be exported for `render.ts` to share it (`D-0017` rule 4). Discovery finds it,
 * because discovery is the point of this file -- so it is bound to a factory and
 * read for a verdict like the other ten, and its case is declared target-only in
 * the ledger. Naming it out of the walk was the alternative and was rejected: a
 * renderer that dodges the discovery by being spelled differently is precisely
 * what the source's design refuses to allow.
 */

import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import { effectiveRevisionId } from "../../src/control_plane/policy.js";
import { pythonRepr } from "../../src/control_plane/python_repr.js";
import { measureAc9 } from "../../src/measurement/ac9.js";
import {
  measureCanaryDivergence,
  V1OwnershipInput,
  V1WriterLedger,
} from "../../src/measurement/canary.js";
import { selectCohort } from "../../src/measurement/cohort.js";
import { measureFalseTermination } from "../../src/measurement/false-termination.js";
import { evaluate, loadCorpus, SyntheticClock } from "../../src/measurement/fixtures.js";
import { isAscii } from "../../src/measurement/format.js";
import { measureLatency, noShadowReference } from "../../src/measurement/latency.js";
import {
  BOUNDED_IMPUTATION_RULE,
  buildHeader,
  CoverageSummary,
  FixtureSuiteRef,
  ImputationRule,
  type ReportHeader,
  SENSITIVITY_IMPUTATION_RULE,
} from "../../src/measurement/provenance.js";
import { openForMeasurement } from "../../src/measurement/reader.js";
import { buildMeasurementReport, V1ShadowInput } from "../../src/measurement/render.js";
import {
  CorrelationKey,
  POSITIONAL_KEY_CAVEAT,
  POSITIONAL_SUBJECT_CLASSES,
  reconcile,
  ShadowEpisode,
  SUBJECT_WORKER_ESCALATION,
  UNMATCHED_KEY,
  V1Reference,
} from "../../src/measurement/shadow.js";
import { classifyEpisodes } from "../../src/measurement/windows.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { parametrize } from "../testkit/parametrize.js";
import {
  comparisonOperands,
  importedValue,
  measurementModules,
  moduleBindings,
  moduleDocComment,
  statementsExecuted,
} from "./module-scan.js";

const T0 = 1_700_000_000_000; // an arbitrary fixed epoch-milliseconds instant
const DAY_MS = 86_400_000;
const PERIOD_START = T0;
const PERIOD_END = T0 + DAY_MS;
const GENERATED_AT = PERIOD_END + 1_000;

const CORPUS_ROOT = join(import.meta.dirname, "..", "fixtures", "labelled");

/**
 * The go/no-go vocabulary section 7 keeps out of every rendering. `go` and the
 * pass/fail families only -- ground-truth words the documents *do* define
 * (`stuck`, `miss`, `false_positive`, `VIOLATED`) are findings about a subject,
 * not a judgement on the report, and are deliberately not here.
 */
const VERDICT_WORDS =
  /\b(pass|passes|passed|passing|fail|fails|failed|failing|go|no-go|nogo|accept|accepted|acceptable|reject|rejected|threshold|thresholds|exit criteri(?:on|a))\b/gi;

/**
 * Names that would answer `Q-0005` or `Q-0011` by existing. A constant called
 * `*_TARGET` is allowed (`ac9` prints AC-9's stated aims as aims); a constant
 * called `*_THRESHOLD` is not, because nothing prints a threshold -- a threshold
 * exists to be compared against.
 */
const FORBIDDEN_NAME =
  /(THRESHOLD|CUTOFF|EXIT_CRITERI|GO_NO_GO|MIN_SAMPLE|SAMPLE_SIZE|MINIMUM_(COHORT|SAMPLE|RUNS|EPISODES))/i;

/**
 * `windows.EpisodeWindow.thresholdKind` is not an invented number and must not
 * read as one: it carries *which rule the policy row declared* (`absolute_ms` /
 * `consecutive_count` / a multiple), read from `policy_detection_latency` at the
 * caller-resolved revision. A `*Kind` name is a discriminator over declared
 * policy data; the thing section 7 forbids is a magnitude this harness chose.
 *
 * The source spares the `_kind` suffix. This port's field names are camel case,
 * so the suffix it has to spare is `Kind` -- and that is the whole of the
 * adaptation: `MISS_RATE_THRESHOLD` is still caught, and so is `missRateKindly`,
 * because the match is anchored at the end.
 */
const DESCRIBES_A_DECLARED_RULE = /(_kind|Kind)$/;

/** Statement verbs that change the database. */
const WRITE_VERBS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "CREATE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "VACUUM",
  "ATTACH",
  "DETACH",
  "REINDEX",
]);
const TRANSACTION_VERBS = new Set(["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"]);
const READ_VERBS = new Set(["SELECT", "WITH", "EXPLAIN"]);

/**
 * The read-only proof, and nothing else, may set a pragma and open a
 * transaction: it exists to attempt a write that a read-only handle must refuse
 * (`reader.proveReadOnly`, `D-0040`). Named function by function rather than
 * module by module, so a second function added to `reader.ts` is still covered.
 * `reader.measurementSnapshot` and `reader.undoTheProbe` are here for a second
 * reason, and it is not a write either: a report has to hold one read
 * transaction across all of its reads or its fingerprint attests a state its
 * figures did not come from (`measurement-harness.md` section 6). BEGIN,
 * ROLLBACK and the probe's SAVEPOINT/RELEASE are transaction control over reads;
 * no statement inside them writes, which is what the rest of this scan proves.
 */
const WRITE_PROBE_EXEMPTIONS = new Set([
  "reader.armAndVerifyBothMechanisms",
  "reader.requireQueryOnly",
  "reader.proveReadOnly",
  "reader.undoTheProbe",
  "reader.measurementSnapshot",
]);

// --------------------------------------------------------------------------
// fixtures -- an empty production database, read through the harness's opener
// --------------------------------------------------------------------------

const productionTemplate = suiteTemplate("production.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

function db(): string {
  return productionTemplate.copyInto(caseRoot("known-holes"));
}

function revisionId(path: string): number {
  const connection = openForMeasurement(path);
  try {
    return effectiveRevisionId(connection, { nowMs: PERIOD_START });
  } finally {
    connection.close();
  }
}

function reading(path: string): SqliteDatabase {
  return openForMeasurement(path);
}

function withReading<T>(path: string, body: (connection: SqliteDatabase) => T): T {
  const connection = reading(path);
  try {
    return body(connection);
  } finally {
    connection.close();
  }
}

// --------------------------------------------------------------------------
// one factory per public renderer -- a renderer with no factory fails
// --------------------------------------------------------------------------

function ac9Report(path: string): unknown {
  return withReading(path, (connection) => {
    const selected = selectCohort(connection, {
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      nowMs: GENERATED_AT,
    });
    return measureAc9(connection, selected, { nowMs: GENERATED_AT });
  });
}

function latencyReport(path: string): unknown {
  const revision = revisionId(path);
  return withReading(path, (connection) =>
    measureLatency(connection, {
      windows: classifyEpisodes(connection, {
        revisionId: revision,
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        episodes: [],
      }),
      detections: new Map(),
      shadow: noShadowReference("this period lies outside the shadow window"),
      nowMs: GENERATED_AT,
    }),
  );
}

function falseTerminationReport(path: string): unknown {
  return withReading(path, (connection) =>
    measureFalseTermination(connection, {
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      nowMs: GENERATED_AT,
      fixtureLabels: new Map(),
      subsequentEvidence: new Map(),
      humanAdjudications: new Map(),
    }),
  );
}

function fixtureEvaluation(_path: string): unknown {
  const corpus = loadCorpus(CORPUS_ROOT);
  return evaluate(corpus, {
    clock: new SyntheticClock(T0),
    outcomes: new Map(corpus.cases.map((one) => [one.caseId, []])),
  });
}

function shadowReconciliation(_path: string): unknown {
  return reconcile({
    periodStartMs: PERIOD_START,
    periodEndMs: PERIOD_END,
    interlockEpisodes: [],
    v1Reference: V1Reference.attestsEmpty({ source: "v1-shadow-adapter@1" }),
    censoredIds: [],
    fixtureLabels: new Map(),
  });
}

function canaryReport(path: string): unknown {
  return withReading(path, (connection) =>
    measureCanaryDivergence(connection, {
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      interlockEpisodes: [],
      v1Reference: V1Reference.attestsEmpty({ source: "v1-shadow-adapter@1" }),
      censoredIds: new Set<string>(),
      fixtureLabels: new Map(),
      v1WriterLedger: V1WriterLedger.attestsEmpty({ source: "v1:.state" }),
      v1Ownership: V1OwnershipInput.attestsEmpty({ source: "v1-owner-export" }),
    }),
  );
}

function reportHeader(path: string): ReportHeader {
  const revision = revisionId(path);
  return withReading(path, (connection) =>
    buildHeader(connection, {
      dbPath: path,
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      generatedAtMs: GENERATED_AT,
      policyRevisionId: revision,
      fingerprintTables: ["run", "incident", "ai_invocation"],
      queryDefinitions: new Map([["caller_incidents", "SELECT count(*) FROM incident"]]),
      fixtureSuite: FixtureSuiteRef.absent("no fixture recall in this report"),
      imputation: new ImputationRule({
        bounded: BOUNDED_IMPUTATION_RULE,
        sensitivity: SENSITIVITY_IMPUTATION_RULE,
        unboundedMissing: 0,
        // Required by this port and not by the source: `D-0107` repaired the
        // header's acceptance predicate so that a header cannot be built
        // without stating both disqualifying populations.
        unconfirmedResponseCount: 0,
      }),
      coverage: new CoverageSummary({ covered: 0, total: 0, excluded: new Map() }),
      censored: 0,
      censoredLeft: 0,
      unmatched: new Map(),
    }),
  );
}

/** The header's mapping, which is what `renderPythonJson` is handed. */
function headerMapping(path: string): unknown {
  return reportHeader(path).asMapping();
}

function measurementReport(path: string): unknown {
  return withReading(path, (connection) =>
    buildMeasurementReport(connection, {
      dbPath: path,
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      nowMs: GENERATED_AT,
      fixtureSuite: FixtureSuiteRef.absent("no fixture recall in this report"),
      v1Shadow: V1ShadowInput.absent("this period lies outside the shadow window"),
    }),
  );
}

/**
 * Renderer qualified name -> how to build the thing it renders. Keys are
 * `module.function`, matched against discovery below; adding a renderer without
 * adding a key fails "every public renderer is bound here".
 */
const REPORT_FACTORIES = new Map<string, (path: string) => unknown>([
  ["ac9.renderAc9Report", ac9Report],
  ["latency.renderLatencyReport", latencyReport],
  ["false-termination.renderFalseTerminationReport", falseTerminationReport],
  ["fixtures.renderFixtureReport", fixtureEvaluation],
  ["shadow.renderShadowReconciliation", shadowReconciliation],
  ["canary.renderCanaryDivergenceReport", canaryReport],
  ["provenance.renderHeaderMarkdown", reportHeader],
  ["provenance.renderHeaderJson", reportHeader],
  ["provenance.renderPythonJson", headerMapping],
  ["render.renderMarkdown", measurementReport],
  ["render.renderJson", measurementReport],
]);

/**
 * The arguments a renderer takes beyond the thing it renders.
 *
 * Every renderer the source discovers is unary. `renderPythonJson` is the port's
 * `json.dumps` and takes the nesting depth as well, so the walk cannot call it
 * without one. Kept as a map rather than a special case in the loop so that a
 * key naming a renderer discovery does not find is a failure, not a comment
 * nobody reads.
 */
const EXTRA_ARGUMENTS = new Map<string, readonly unknown[]>([["provenance.renderPythonJson", [0]]]);

// --------------------------------------------------------------------------
// discovery
// --------------------------------------------------------------------------

/**
 * Every public renderer in the package, by qualified name.
 *
 * The source's predicate is `render_*` and not `_render*`, over the names a
 * module owns. This port's spelling of `render_` is `render` followed by a
 * capital, which excludes `render.render` -- the dispatcher, whose source
 * counterpart `render.render` is excluded by the underscore for the same reason
 * -- and excludes `renderSeams`, which is a seam record rather than a callable.
 *
 * Ownership is read from the module's own source rather than from `__module__`,
 * which ESM has no counterpart for: a name a module declares is its own, and a
 * name it imports belongs to the module that declared it.
 */
async function publicRenderers(): Promise<ReadonlyMap<string, (...args: never[]) => string>> {
  const renderers = new Map<string, (...args: never[]) => string>();
  for (const [short, namespace] of await measurementModules()) {
    const declared = new Set(
      moduleBindings(short)
        .filter((binding) => binding.importedFrom === null)
        .map((binding) => binding.name),
    );
    for (const [name, value] of Object.entries(namespace)) {
      if (!/^render[A-Z]/.test(name) || typeof value !== "function") {
        continue;
      }
      if (!declared.has(name)) {
        continue; // imported vocabulary belongs to the module that owns it
      }
      renderers.set(`${short}.${name}`, value as (...args: never[]) => string);
    }
  }
  return renderers;
}

function context(text: string, index: number, radius = 240): string {
  return text.slice(Math.max(0, index - radius), index + radius);
}

// --------------------------------------------------------------------------
// hole 1 and hole 3 -- no verdict, no threshold, anywhere
// --------------------------------------------------------------------------

describe("hole 1 and hole 3 -- no verdict, no threshold, anywhere", () => {
  test("every public renderer is bound here", async () => {
    // A renderer this file has never heard of is an unread rendering.
    //
    // Discovery, not a list: the point of the test is the module that does not
    // exist yet.
    const discovered = [...(await publicRenderers()).keys()].sort();
    const bound = [...REPORT_FACTORIES.keys()].sort();
    expect(
      discovered,
      "every public renderer under src/measurement/ must be built and read for a verdict by " +
        `this file; unbound: ${discovered.filter((name) => !REPORT_FACTORIES.has(name))}; ` +
        `stale: ${bound.filter((name) => !discovered.includes(name))}`,
    ).toEqual(bound);
  });

  parametrize(
    "no renderer emits verdict vocabulary",
    [...REPORT_FACTORIES.keys()].sort().map((name) => [name, name] as const),
    async (qualifiedName: string) => {
      // `Q-0005` stays open, and a rendering is where it would quietly close.
      //
      // Each report is built for real over an empty production database and
      // rendered, then read for go/no-go words. A module may say `Q-0005` is
      // open -- several do -- but the property under test is the rendering,
      // because that is what a reader sees.
      const renderer = (await publicRenderers()).get(qualifiedName);
      expect(renderer, `${qualifiedName} was not discovered`).toBeDefined();
      const factory = REPORT_FACTORIES.get(qualifiedName) as (path: string) => unknown;
      const extra = EXTRA_ARGUMENTS.get(qualifiedName) ?? [];
      const rendered = (renderer as (...args: unknown[]) => string)(factory(db()), ...extra);

      const offending: string[] = [];
      for (const match of rendered.matchAll(VERDICT_WORDS)) {
        // A statement that a threshold does NOT exist is the hole being stated,
        // which is the opposite of the failure: the words appear only inside the
        // sentence naming the open question.
        if (!context(rendered, match.index).includes("Q-0005")) {
          offending.push(match[0]);
        }
      }
      expect(
        offending,
        `${qualifiedName} emitted verdict vocabulary ${[...new Set(offending)].sort()}; ` +
          "section 7 keeps Q-0005 open, and a harness that prints a verdict answers it by inertia",
      ).toEqual([]);
      expect(isAscii(rendered), `${qualifiedName} broke the cp932 rule`).toBe(true);
    },
  );

  test("no module names a threshold or a sample size minimum", async () => {
    // A name is enough: `MIN_COHORT_SIZE` answers Q-0005 by existing.
    //
    // Walks the package, so a later module carrying one is caught without this
    // test being updated.
    const offending: string[] = [];
    for (const short of (await measurementModules()).keys()) {
      for (const binding of moduleBindings(short)) {
        if (DESCRIBES_A_DECLARED_RULE.test(binding.name)) {
          continue;
        }
        if (!FORBIDDEN_NAME.test(binding.name)) {
          continue;
        }
        // The source skips a name whose `__module__` is another module's, and
        // resolves it for every name. Only a name that would otherwise be
        // reported needs resolving, and resolving it costs an import, so the
        // order is inverted here; the reported set is the same one.
        if (binding.importedFrom !== null) {
          const value = await importedValue(short, binding.importedFrom);
          if (typeof value === "function") {
            continue; // imported vocabulary belongs to the module that owns it
          }
        }
        offending.push(`${short}.${binding.name}`);
      }
    }
    expect(
      offending,
      `${offending} name an exit criterion or a sample-size minimum; ` +
        "measurement-harness.md section 7 leaves Q-0005 and Q-0011 open",
    ).toEqual([]);
  });

  test("no target constant is ever compared", () => {
    // AC-9's targets print as targets. A comparison is a verdict with no name.
    //
    // `ac9` holds `PROMPT_REDUCTION_TARGET` and `OUTPUT_TOKEN_REDUCTION_TARGET`
    // so a reader sees what the aim was; the moment one of them appears in a
    // comparison, the harness has decided whether the aim was met, which is
    // exactly what `ACCEPTANCE.md` section 3 refuses to do.
    const offending = comparisonOperands()
      .filter(
        (operand) =>
          !DESCRIBES_A_DECLARED_RULE.test(operand.name) &&
          (operand.name.endsWith("_TARGET") || FORBIDDEN_NAME.test(operand.name)),
      )
      .map((operand) => `${operand.module}:${operand.line}:${operand.name}`);
    expect(
      offending,
      `${offending} compare a target against a measured figure, which turns AC-9's stated aim ` +
        "into a canary exit threshold (Q-0005)",
    ).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// hole 5 -- the harness never writes, and ai_invocation least of all
// --------------------------------------------------------------------------

describe("hole 5 -- the harness never writes, and ai_invocation least of all", () => {
  test("no module executes a write statement", () => {
    // Every statement the package executes is a read.
    //
    // Parsed rather than grepped, so an `INSERT` inside a doc comment (there are
    // several, explaining what the writers do) does not fire and an `INSERT`
    // built by a template does. The only exemptions are the functions of
    // `reader.ts`'s read-only proof, which attempt a write *in order to be
    // refused*, and its read snapshot, whose BEGIN/ROLLBACK are transaction
    // control over reads (see WRITE_PROBE_EXEMPTIONS); a statement whose text
    // cannot be read statically fails too, because an uninspectable statement is
    // where a write would hide.
    let seen = 0;
    const offending: string[] = [];
    for (const statement of statementsExecuted()) {
      seen += 1;
      const where = `${statement.module}.${statement.functionName}`;
      if (statement.text === null) {
        offending.push(`${where}: statement not statically inspectable`);
        continue;
      }
      const exempt = WRITE_PROBE_EXEMPTIONS.has(where);
      // Beyond the source, and deliberately: `sqlite3.Connection.execute`
      // refuses a second statement, so reading the leading verb is sufficient
      // there. better-sqlite3's `exec` runs every statement in the string, and
      // SQLite accepts a CTE in front of a write on both runtimes -- so
      // `SELECT 1; INSERT ...` and `WITH x AS (...) DELETE ...` both lead with a
      // read verb and both write. See D-0115 and the ledger's divergences.
      if (statement.hiddenWriteVerbs.length > 0 && !exempt) {
        offending.push(
          `${where}: ${statement.hiddenWriteVerbs.join(", ")} behind a leading ` +
            `${statement.verb}`,
        );
        continue;
      }
      if (READ_VERBS.has(statement.verb)) {
        continue;
      }
      if (statement.verb === "PRAGMA") {
        if (statement.text.includes("=") && !exempt) {
          offending.push(`${where}: sets a pragma (${pythonRepr(statement.text.trim())})`);
        }
        continue;
      }
      if (TRANSACTION_VERBS.has(statement.verb) && exempt) {
        continue;
      }
      if (WRITE_VERBS.has(statement.verb) || TRANSACTION_VERBS.has(statement.verb)) {
        offending.push(`${where}: ${statement.verb}`);
        continue;
      }
      offending.push(`${where}: unrecognised statement verb ${pythonRepr(statement.verb)}`);
    }

    expect(seen, `only ${seen} executed statements found; the scan is not working`).toBeGreaterThan(
      20,
    );
    expect(
      offending,
      `${offending}: the measurement harness is read-only (D-0040, measurement-harness.md ` +
        "section 1), and ai_invocation's single-writer property (D-0003, section 7) holds only " +
        "while nothing here writes",
    ).toEqual([]);
  });

  test("ac9 states that it never writes ai_invocation", () => {
    // Hole 5 is a property of the code plus a sentence saying why it matters.
    //
    // The property is tested above. This asserts the reason is written down
    // where the next person to want a backfill will read it.
    const docstring = moduleDocComment("ac9");
    expect(docstring).toContain("D-0003");
    expect(docstring).toContain("ai_invocation");
    expect(docstring).toContain("single writer");
  });
});

// --------------------------------------------------------------------------
// hole 2 -- Q-0009 exposed, not decided
// --------------------------------------------------------------------------

describe("hole 2 -- Q-0009 exposed, not decided", () => {
  test("the header exposes the detector version set and decides nothing", () => {
    // `Q-0009` stays open: the set is published, compatibility is not ruled on.
    const header = reportHeader(db());
    // The source asserts `isinstance(..., tuple)`. A tuple is an ordered
    // sequence that cannot be edited, and the port's spelling of that is a
    // frozen array -- asserting only `Array.isArray` would accept the mutable
    // half of what the source excludes.
    expect(Array.isArray(header.detectorVersions)).toBe(true);
    expect(Object.isFrozen(header.detectorVersions)).toBe(true);
    const mapping = header.asMapping();
    // `str(mapping)` of a dict. `asMapping` returns a read-only VIEW rather than
    // a `Map`, so it is copied into one first: `pythonRepr` renders a `Map` as a
    // dict and anything else through `String`, and the view's `String` form is a
    // listing of its own methods -- which contains neither the keys nor the
    // values, and would have made this assertion about nothing.
    expect(pythonRepr(new Map(mapping))).toContain("detector_versions");
    expect(moduleDocComment("provenance")).toContain("Q-0009");

    const fields = publicNames(header);
    const decided = [...fields].filter(
      (name) =>
        /compatib|homogene/i.test(name) &&
        !["nonHomogeneityReasons", "nonHomogeneous"].includes(name),
    );
    expect(
      decided.sort(),
      `${decided.sort()} would decide what cross-version compatibility means; Q-0009 leaves ` +
        "that open and the header only exposes the set and flags a non-homogeneous period",
    ).toEqual([]);
  });
});

/**
 * `dir(instance)`, minus the names Python's `_` filter removes.
 *
 * Own properties and the prototype chain, because a `get` accessor is on the
 * prototype and is exactly the shape this case is looking for -- `nonHomogeneous`
 * is one. `constructor` is dropped as the counterpart of the `__init__` and
 * `__class__` entries the source's underscore filter removes.
 */
function publicNames(instance: object): readonly string[] {
  const names = new Set<string>();
  for (
    let current: object | null = instance;
    current !== null && current !== Object.prototype;
    current = Object.getPrototypeOf(current) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (!name.startsWith("_") && name !== "constructor") {
        names.add(name);
      }
    }
  }
  return [...names];
}

// --------------------------------------------------------------------------
// hole 3 -- Q-0011 belongs to gate item 8
// --------------------------------------------------------------------------

describe("hole 3 -- Q-0011 belongs to gate item 8", () => {
  test("latency states that secretary window latency is not its measurement", async () => {
    // The module with the milliseconds in it is where a Q-0011 threshold would
    // land.
    const docstring = moduleDocComment("latency");
    expect(docstring).toContain("Q-0011");
    expect(docstring).toContain("gate item 8");

    const latency = (await measurementModules()).get("latency") ?? {};
    const names = Object.keys(latency).filter((name) => !name.startsWith("_"));
    expect(
      names.filter((name) => name.toLowerCase().includes("secretary")),
      "a Secretary series here would make this harness the owner of Q-0011's measurement, " +
        "which section 7 assigns to gate item 8",
    ).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// hole 4 -- the positional escalation key, and its failures kept visible
// --------------------------------------------------------------------------

describe("hole 4 -- the positional escalation key, and its failures kept visible", () => {
  test("the positional caveat reaches the reader of the reconciliation", async () => {
    // A weak join is only safe while the reader is told it is weak.
    //
    // The caveat must name the failure mode (unmatched, not mispaired) and the
    // consequence (replace the key before trusting the numbers), and must appear
    // in the rendering -- a constant nobody prints is documentation of a hole
    // that the report does not have.
    const caveat = POSITIONAL_KEY_CAVEAT;
    expect(caveat).toContain("positional");
    expect(caveat).toContain("unmatched");
    expect(caveat).toContain("replacing");

    // An escalation whose run_id is missing: it cannot be keyed, so it lands in
    // the bucket section 7 says to read as "the key needs replacing". The
    // rendering of THAT report is where the caveat has to appear.
    const unkeyable = new ShadowEpisode({
      episodeId: "escalation-with-no-run",
      subjectClass: SUBJECT_WORKER_ESCALATION,
      shape: "gate_refused",
      onsetMs: PERIOD_START + 1,
      keyGap: "the gate row carries no run_id, so there is nothing to order by",
    });
    const report = reconcile({
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      interlockEpisodes: [unkeyable],
      v1Reference: V1Reference.attestsEmpty({ source: "v1-shadow-adapter@1" }),
      censoredIds: [],
      fixtureLabels: new Map(),
    });
    expect(report.positionalCaveat).toBe(caveat);
    expect(report.unmatchedKey.map((episode) => episode.episodeId)).toContain(unkeyable.episodeId);

    const shadow = (await measurementModules()).get("shadow") ?? {};
    const renderShadowReconciliation = shadow["renderShadowReconciliation"] as (
      report: unknown,
    ) => string;
    const rendered = renderShadowReconciliation(report);
    expect(
      rendered,
      "the reconciliation renders without its own caveat, so a run of unmatched escalation " +
        "episodes would read as a detector problem",
    ).toContain(caveat.split(".")[0]);
    expect(
      [...report.counts().keys()],
      "the unmatched bucket must be reported even at zero -- it is the signal that the key " +
        "needs replacing",
    ).toContain(UNMATCHED_KEY);
  });

  test("a positional key is marked positional on the key itself", () => {
    // Discovery again: every subject class the module declares positional says
    // so.
    for (const subjectClass of POSITIONAL_SUBJECT_CLASSES) {
      const key = new CorrelationKey({ subjectClass, parts: ["a", "1"] });
      expect(key.positional, `${subjectClass} is positional and must say so`).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------
// target-only -- what this port added, and what its source could not see
// --------------------------------------------------------------------------

describe("target-only -- the port's own machinery carries no warrant from the source", () => {
  test("target-only -- the unmatched bucket is reported when it is empty", () => {
    // The ported case above asserts that `unmatched_key` is in `counts()`
    // "even at zero" -- and then hands `reconcile` an episode that lands in
    // that bucket, so the bucket is non-empty and the case cannot see the
    // property it names. Its source does the same, so this is inherited rather
    // than introduced (recorded in the ledger); measured, with the bucket made
    // conditional on being non-empty, the ported case stays GREEN and this one
    // goes red. Zero is the whole point of the assertion: a bucket that
    // disappears when it is empty is a signal that reads as "no problem" on
    // exactly the days there is none to read.
    const report = reconcile({
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      interlockEpisodes: [],
      v1Reference: V1Reference.attestsEmpty({ source: "v1-shadow-adapter@1" }),
      censoredIds: [],
      fixtureLabels: new Map(),
    });
    expect(report.unmatchedKey).toEqual([]);
    expect(
      [...report.counts().keys()],
      "the unmatched bucket must be reported even at zero -- it is the signal that the key " +
        "needs replacing",
    ).toContain(UNMATCHED_KEY);
  });

  test("target-only -- a verdict word is exempt only on the line that states the hole", async () => {
    // The ported case exempts a verdict word within 240 characters of `Q-0005`,
    // which is its source's rule and is kept there. 240 characters is a
    // NEIGHBOURHOOD, not a sentence: every rendering prints a standard Q-0005
    // note, so a line reading `Status: PASS` placed beside that note is inside
    // the radius and the guard stays green -- which is the one place a verdict
    // is most likely to be added, because that is where the subject is being
    // discussed. Raised by the review gate.
    //
    // The tighter rule is the LINE: a verdict word is exempt only where `Q-0005`
    // is on the same line it is. Measured over all eleven renderings, it holds
    // today without any of them being changed -- each note is a single line and
    // carries its own vocabulary (`thresholds`, `exit criteria`, `acceptance
    // threshold`) beside the question it states.
    //
    // Target-only rather than a tightening of the ported case: rule 0 makes an
    // assertion stronger than its source a divergence, and a divergence belongs
    // beside the faithful translation rather than in its slot.
    const renderers = await publicRenderers();
    const path = db();
    const offending: string[] = [];
    for (const [name, factory] of REPORT_FACTORIES) {
      const renderer = renderers.get(name) as (...args: unknown[]) => string;
      const rendered = renderer(factory(path), ...(EXTRA_ARGUMENTS.get(name) ?? []));
      for (const line of rendered.split("\n")) {
        if (line.includes("Q-0005")) {
          continue;
        }
        for (const match of line.matchAll(VERDICT_WORDS)) {
          offending.push(`${name}: ${match[0]} in ${JSON.stringify(line.trim().slice(0, 80))}`);
        }
      }
    }
    expect(
      offending,
      `${offending}: a verdict word away from the line that states Q-0005 is a verdict, ` +
        "however near the note it sits",
    ).toEqual([]);
  });

  test("target-only -- the extra-argument table names only renderers discovery finds", async () => {
    // `EXTRA_ARGUMENTS` is this port's, not the source's: every renderer the
    // source discovers is unary and it needs no such table. A key that no longer
    // names a discovered renderer would be a silently ignored entry -- and the
    // renderer it was written for would then be called with one argument, which
    // for `renderPythonJson` means a `depth` of `undefined` and a rendering that
    // is wrong rather than absent.
    const discovered = await publicRenderers();
    const stale = [...EXTRA_ARGUMENTS.keys()].filter((name) => !discovered.has(name));
    expect(stale, `${stale} carry extra arguments but are not public renderers`).toEqual([]);
  });
});
