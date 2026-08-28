/**
 * Section 6's query catalogue, kept complete by discovery rather than by prose.
 *
 * Ported from interlock `tests/measurement/test_query_catalogue.py` at
 * `65f36c5`. Every case here maps to one source node id; the mapping, the
 * systematic translations and the deliberate divergences are recorded in
 * `parity/measurement.query-catalogue.ledger.json`.
 *
 * The failure this file is written against is a provenance header that documents
 * a query nobody ran. `docs/measurement-harness.md` section 6 requires
 * `query_definitions` to carry "every query the report ran, as text, plus a
 * sha256 over the set ... so a reader can run them by hand" (interlock
 * `D-0040`), and there are exactly two ways to break that while everything still
 * looks right:
 *
 * * **a copy.** A statement written inline at its call site can only reach the
 *   header as a pasted second copy. The copy is correct on the day it is pasted
 *   and goes on being printed after the executed text changes, so the header
 *   attests to a query that never ran and the artefact shows no sign of it. The
 *   fix is the lift `ac9.ts` and `cohort.ts` have had -- the constant in the
 *   catalogue *is* the string handed to `prepare` -- and `every statement a
 *   catalogued module executes is in its catalogue` is what keeps it that way:
 *   it re-derives, from each module's own source, every statement that module
 *   executes, and fails on one the catalogue does not carry.
 * * **a module.** A catalogue that is complete today stops being complete the
 *   day the report calls into a module that was written afterwards -- and a note
 *   in a docstring saying "keep this list current" is precisely what does not
 *   survive that. So the trace case does not read a list of modules at all: it
 *   builds a real report through a connection that records every statement
 *   executed, and asserts each recorded statement is either in the header's
 *   catalogue or named, with a reason, in `render.UNATTESTED_STATEMENTS`. A new
 *   module reaching the report path fails it without this file having heard of
 *   the module.
 *
 * The static half reuses `module-scan.ts`'s `statementsExecuted` rather than
 * parsing the package a second time: that resolver already understands the
 * shapes a statement arrives in here (literal, module constant, catalogue entry,
 * record-class field), and a second resolver would agree with it until one of
 * them learned a fifth. The source shares it the same way, as private helpers of
 * `test_known_holes.py`; it lives in a module the runner does not collect for
 * the reason `module-scan.ts` records.
 *
 * The two halves are deliberately opposed. The static half can be satisfied by a
 * catalogue full of statements nothing runs; the trace half asserts the converse
 * -- every name in the header's catalogue was observed executing -- so a stale
 * entry fails too. Neither half is a copy of the report's field list.
 *
 * Nothing here writes: the report is built over a migrated production database
 * through the same read-only handle the harness uses, wrapped in a recorder that
 * forwards to it and adds nothing.
 *
 * **Two things this port has to say differently, and both are decisions.**
 * `where` is read off the stack rather than off a Python frame, and the source's
 * *object identity* check -- `text is constant` -- has no observable form for
 * JavaScript strings and is reached through the syntax instead. See `D-0116` and
 * `D-0117`.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import ts from "typescript";
import { describe, expect, test } from "vitest";

import {
  FINGERPRINT_CONTENT,
  FixtureSuiteRef,
  queryCatalogue,
  ReportHeader,
} from "../../src/measurement/provenance.js";
import { openForMeasurement } from "../../src/measurement/reader.js";
import {
  buildMeasurementReport,
  type MeasurementReport,
  REPORT_QUERY_SOURCES,
  renderJson,
  UNATTESTED_STATEMENTS,
  V1ShadowInput,
} from "../../src/measurement/render.js";
import { caseRoot } from "../testkit/cases.js";
import { parametrize } from "../testkit/parametrize.js";
import { measurementModules, moduleSources, statementsExecuted } from "./module-scan.js";
import { reportFixtureTemplate } from "./report-fixture.js";
import { REPORT_CLOCK } from "./report-reading.js";

const { GENERATED_AT, PERIOD_END, PERIOD_START } = REPORT_CLOCK;

/**
 * A v1 run id this database does not hold. `cohort.selectCohort` refuses a
 * shadow input naming a run it holds (interlock `D-0013`), and the shadow input
 * is here for a reason: without one, the chunked ownership-collision statement
 * never executes, and a trace that never ran it could not notice its absence
 * from the catalogue.
 */
const V1_SHADOW_RUN_ID = "v1-run-not-in-this-database";

/** The source's `db` fixture; see `report-fixture.ts` for why it lives there. */
function reportDb(): string {
  return reportFixtureTemplate.copyInto(caseRoot("query-catalogue"));
}

// --------------------------------------------------------------------------
// the recorder
// --------------------------------------------------------------------------

/** One statement, and the `module.function` that issued it. */
interface RecordedStatement {
  readonly where: string;
  readonly statement: string;
}

/**
 * The methods a statement's text can enter better-sqlite3 through.
 *
 * The source's set is `execute` / `executemany` / `executescript`, which is
 * every `sqlite3` API handed a statement; this is the same set for this driver,
 * and it is the same one `module-scan.ts` scans the sources for (`D-0115`). The
 * two halves of this file would otherwise disagree about what counts as running
 * a query, and the disagreement would read as coverage.
 */
const STATEMENT_METHODS = new Set(["prepare", "exec", "pragma"]);

/**
 * The caller of the recorder, as `<file stem>.<function name>`.
 *
 * The source reads it off `sys._getframe(1)`; V8 offers the same thing through
 * the structured stack trace API, which hands back call sites as objects rather
 * than as a rendered string -- so the file and the function name are read rather
 * than parsed out of a format that is not a contract (`D-0116`).
 *
 * The caller is read off the stack rather than passed in, because the point is
 * to name statements issued by code this file does not know about: a module
 * added to the report path names itself in the failure message.
 */
function callerOfTheRecorder(): string {
  const original = Error.prepareStackTrace;
  Error.prepareStackTrace = (_error, callSites) => callSites;
  try {
    const holder: { stack?: unknown } = {};
    Error.captureStackTrace(holder, callerOfTheRecorder);
    const callSites = holder.stack as readonly NodeJS.CallSite[] | undefined;
    // Frame 0 is the Proxy trap this function is called from; frame 1 is the
    // code that called the connection, which is the one the source names.
    const frame = callSites?.[1];
    if (frame === undefined) {
      return "<unknown>";
    }
    const file = frame.getFileName() ?? "";
    const stem = (file.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");
    // A statement issued from a module's top level, or from an arrow function
    // the compiler could not name, has no function name. `<module>` is what
    // `module-scan.ts` calls the same position, so the two halves agree.
    const name = frame.getFunctionName() ?? "<module>";
    // `Object.method` and `Class.method` both arrive here with the receiver
    // attached; the source names the code object, which is the last segment.
    return `${stem === "" ? "<unknown>" : stem}.${name.split(".").pop()}`;
  } finally {
    Error.prepareStackTrace = original;
  }
}

/**
 * The read-only handle, plus a note of every statement executed through it.
 *
 * A `Proxy` rather than the source's forwarding class: better-sqlite3's
 * `Database` carries its state on the native handle and its methods are not
 * bound, so a hand-written wrapper would have to enumerate the surface and would
 * silently stop forwarding whatever it had not heard of. Everything else is
 * forwarded untouched. This is a recorder, not a stub -- the report it produces
 * is the real report over the real database, so a statement that only runs on a
 * non-empty cohort is recorded too.
 */
function recordingConnection(connection: SqliteDatabase): {
  readonly handle: SqliteDatabase;
  readonly recorded: readonly RecordedStatement[];
} {
  const recorded: RecordedStatement[] = [];
  const handle = new Proxy(connection, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      const method = String(property);
      if (!STATEMENT_METHODS.has(method)) {
        // Bound to the real connection: better-sqlite3's methods reach the
        // native handle through `this`, and `this` would otherwise be the proxy.
        return value.bind(target);
      }
      return (...args: readonly unknown[]): unknown => {
        // `pragma()` takes the statement without its keyword. Restoring it is
        // what makes this trace comparable with the static scan, which restores
        // it for the same reason (`D-0115`).
        const text = String(args[0]);
        recorded.push({
          where: callerOfTheRecorder(),
          statement: method === "pragma" ? `PRAGMA ${text}` : text,
        });
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { handle, recorded };
}

/**
 * The report's header, narrowed, and everything the report executed.
 *
 * `MeasurementReport.header` is typed as the structural `ReportHeaderLike`, so
 * the catalogue this whole file is about is not reachable through it. The narrow
 * is an assertion rather than a cast: a header that stopped being a
 * `ReportHeader` would otherwise turn every case here into a check of `undefined
 * === undefined`.
 */
function reportWithTrace(path: string): {
  readonly report: MeasurementReport;
  readonly header: ReportHeader;
  readonly recorded: readonly RecordedStatement[];
} {
  const connection = openForMeasurement(path);
  const { handle, recorded } = recordingConnection(connection);
  try {
    const report = buildMeasurementReport(handle, {
      dbPath: path,
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      nowMs: GENERATED_AT,
      fixtureSuite: FixtureSuiteRef.absent("no corpus in this test"),
      v1Shadow: V1ShadowInput.observed("v1-export", [V1_SHADOW_RUN_ID]),
      fingerprintMode: FINGERPRINT_CONTENT,
    });
    expect(
      report.header,
      "the report's header is no longer a ReportHeader, so its query catalogue cannot be read",
    ).toBeInstanceOf(ReportHeader);
    return { report, header: report.header as ReportHeader, recorded };
  } finally {
    connection.close();
  }
}

// --------------------------------------------------------------------------
// naming the issuer, across two spellings of the same function
// --------------------------------------------------------------------------

/**
 * `module.function` with the spelling difference between the two languages
 * removed.
 *
 * `UNATTESTED_STATEMENTS` is keyed by the **source's** function names on purpose
 * -- `render.ts` records why: the report is what a parity comparison of the two
 * implementations is made from, and renaming the keys would make the two reports
 * differ on a field whose subject is identical. The trace, though, observes this
 * port's names. `reader._require_query_only` and `reader.requireQueryOnly` are
 * one function under two conventions, so both sides are folded to a form neither
 * convention can move: lower case, no underscores.
 *
 * A hand-written table mapping one to the other was the alternative and was
 * rejected -- it is exactly the "keep this list current" note the file's own
 * docstring says does not survive a new module (`D-0116`).
 */
function canonicalIssuer(where: string): string {
  return where.toLowerCase().replace(/_/g, "");
}

// --------------------------------------------------------------------------
// matching a statement against the catalogue
// --------------------------------------------------------------------------

/**
 * *statement* with its layout collapsed.
 *
 * Indentation is the one difference between the catalogued text and the executed
 * text that carries no meaning; every other difference does, and is left to
 * fail.
 */
function squashed(statement: string): string {
  return statement
    .split(/\s+/)
    .filter((piece) => piece !== "")
    .join(" ");
}

function countQuestionMarks(text: string): number {
  return text.split("?").length - 1;
}

/**
 * Is *executed* the statement *catalogued* documents?
 *
 * `{placeholders}` is the one substitution the catalogue cannot avoid: SQLite
 * has no parameter form for an `IN` list, so the placeholders are generated per
 * chunk while the values stay bound. The template is expanded to the arity
 * actually observed and then compared in full, rather than compared as a prefix
 * -- a prefix match would accept a statement whose tail had changed, which is
 * the drift the catalogue exists to catch.
 *
 * *executed* arrives expanded from the trace and unexpanded from the static
 * resolver, which reads the template off the call site's `.replace` and cannot
 * know the arity; both are the same statement, so equality is tried before
 * expansion.
 */
function catalogueMatches(catalogued: string, executed: string): boolean {
  if (squashed(catalogued) === squashed(executed)) {
    return true;
  }
  if (!catalogued.includes("{placeholders}")) {
    return false;
  }
  const generated = countQuestionMarks(squashed(executed)) - countQuestionMarks(catalogued);
  if (generated < 0) {
    return false;
  }
  // `split`/`join` rather than `String.replace`, which would expand only the
  // first occurrence and would read `$&` in the replacement as a back-reference.
  // Python's `str.format` does neither.
  const expanded = catalogued
    .split("{placeholders}")
    .join(Array.from({ length: generated }, () => "?").join(", "));
  return squashed(expanded) === squashed(executed);
}

function catalogueName(catalogue: ReadonlyMap<string, string>, executed: string): string | null {
  for (const [name, text] of catalogue) {
    if (catalogueMatches(text, executed)) {
      return name;
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// the static half -- a catalogued module carries every statement it executes
// --------------------------------------------------------------------------

const CATALOGUED_MODULES = [...REPORT_QUERY_SOURCES.keys()].sort();

function catalogueOf(moduleName: string): ReadonlyMap<string, string> {
  const catalogue = REPORT_QUERY_SOURCES.get(moduleName);
  if (catalogue === undefined) {
    throw new Error(`${moduleName} is not in REPORT_QUERY_SOURCES`);
  }
  return catalogue;
}

/** The module's parsed source, for the two syntax-level assertions below. */
function sourceOf(moduleName: string): ts.SourceFile {
  const source = moduleSources().find(([short]) => short === moduleName)?.[1];
  if (source === undefined) {
    throw new Error(`${moduleName} is not a file of the measurement package`);
  }
  return source;
}

/**
 * `(line, argument)` for every statement call in *moduleName*.
 *
 * `.replace("{placeholders}", ...)` is unwrapped to the template it was called
 * on -- the source unwraps `.format(...)` in the same position and for the same
 * reason: expanding an `IN` list's placeholders is arity, not text, and the
 * template is what the catalogue carries.
 */
function* statementArguments(moduleName: string): Generator<[number, ts.Expression]> {
  const source = sourceOf(moduleName);
  const nodes: ts.Node[] = [source];
  while (nodes.length > 0) {
    const node = nodes.pop() as ts.Node;
    ts.forEachChild(node, (child) => {
      nodes.push(child);
    });
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      continue;
    }
    if (!STATEMENT_METHODS.has(node.expression.name.text) || node.arguments.length === 0) {
      continue;
    }
    let argument = node.arguments[0] as ts.Expression;
    if (
      ts.isCallExpression(argument) &&
      ts.isPropertyAccessExpression(argument.expression) &&
      argument.expression.name.text === "replace"
    ) {
      argument = argument.expression.expression;
    }
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    yield [line, argument];
  }
}

/**
 * Every module-level string constant of *moduleName*, by value.
 *
 * This is the port's `vars(module)`, filtered to strings. A Python module's
 * namespace carries its private names as well as its public ones, and an ESM
 * namespace carries only its exports -- so the exported values are unioned with
 * the module-level `const NAME = <string literal>` declarations read off the
 * source. Without the second half this would be *stricter* than the source: a
 * module-private constant is in `vars(module)` and would be absent here, and
 * `docs/test-translation-conventions.md` rule 0 makes an assertion stronger than
 * its source wrong in the same way as one that is weaker.
 */
function moduleStringConstants(
  namespace: Record<string, unknown>,
  moduleName: string,
): ReadonlySet<string> {
  const constants = new Set<string>();
  for (const value of Object.values(namespace)) {
    if (typeof value === "string") {
      constants.add(value);
    }
  }
  for (const statement of sourceOf(moduleName).statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (initializer === undefined) {
        continue;
      }
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        constants.add(initializer.text);
      }
    }
  }
  return constants;
}

/**
 * The expression each `QUERY_DEFINITIONS` entry gives as its text, by name.
 *
 * This is what stands in for the source's `text is constant`: JavaScript string
 * equality is by value, so no runtime check can tell the constant apart from a
 * copy of it, and the property has to be read off the syntax instead
 * (`D-0117`). The entry's value expression is what the catalogue was *built*
 * from, so an identifier here means the catalogue holds the same string the call
 * site executes, and a literal here means it holds a copy.
 */
function catalogueEntryExpressions(moduleName: string): ReadonlyMap<string, ts.Expression> {
  const source = sourceOf(moduleName);
  const found = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "QUERY_DEFINITIONS" &&
      node.initializer !== undefined
    ) {
      for (const pair of arrayElementsOf(node.initializer)) {
        if (!ts.isArrayLiteralExpression(pair) || pair.elements.length !== 2) {
          continue;
        }
        const [key, value] = pair.elements as unknown as [ts.Expression, ts.Expression];
        if (ts.isStringLiteral(key)) {
          found.set(key.text, value);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The elements of the array literal *node* is, or was built around. */
function arrayElementsOf(node: ts.Expression): readonly ts.Expression[] {
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements;
  }
  // `readOnlyMap([...])`, which is how every catalogue in this package is built.
  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    return arrayElementsOf(node.arguments[0] as ts.Expression);
  }
  return [];
}

describe("section 6 -- the catalogue is what ran, not a copy of it", () => {
  /**
   * The lift, asserted from the source rather than from a doc comment.
   *
   * `statementsExecuted` resolves the argument of every statement call in the
   * package back to its text. For a module that publishes a catalogue, each
   * resolved text must be in that catalogue -- which is only possible when the
   * call site executes the constant, since a text this scan cannot resolve is
   * reported as a failure rather than skipped.
   */
  parametrize(
    "every statement a catalogued module executes is in its catalogue",
    CATALOGUED_MODULES.map((moduleName) => [moduleName, moduleName] as const),
    (moduleName) => {
      const catalogue = catalogueOf(moduleName);
      const discovered = statementsExecuted().filter(
        (statement) => statement.module === moduleName,
      );

      expect(
        discovered.length,
        `${moduleName}.ts publishes a query catalogue but no statement call was found in it; ` +
          "either the module stopped running queries (drop its catalogue) or this test stopped " +
          "finding them",
      ).toBeGreaterThan(0);

      for (const { functionName, text } of discovered) {
        expect(
          text,
          `${moduleName}.${functionName} hands the driver a statement that cannot be resolved ` +
            "to text, so the catalogue cannot carry the text that ran",
        ).not.toBeNull();
        expect(
          catalogueName(catalogue, text as string),
          `${moduleName}.${functionName} executes a statement that ` +
            `${moduleName}.QUERY_DEFINITIONS does not carry:\n${text}\n` +
            "Lift it to a module-level constant, execute the constant, and add it to the " +
            "catalogue (measurement-harness.md section 6)",
        ).not.toBeNull();
      }
    },
  );

  /**
   * Equality of text is not the property; sameness of string is.
   *
   * A statement inlined at its call site as a copy of the catalogued text passes
   * the case above on the day it is written, and stops passing it only after the
   * two have already disagreed -- which is one report too late, because the
   * disagreeing report is the artefact. So the call site is required to *name*
   * the constant (directly, through the catalogue, or through `.replace` for an
   * `IN` list's arity), and the catalogue is required to be built from that same
   * name: then there is one string and no copy to drift.
   */
  parametrize(
    "a catalogued module executes the constant and not a copy",
    CATALOGUED_MODULES.map((moduleName) => [moduleName, moduleName] as const),
    async (moduleName) => {
      const namespace = (await measurementModules()).get(moduleName);
      expect(namespace, `${moduleName} is not a module of the measurement package`).toBeDefined();
      const constants = moduleStringConstants(namespace as Record<string, unknown>, moduleName);
      const expressions = catalogueEntryExpressions(moduleName);

      for (const [name, text] of catalogueOf(moduleName)) {
        expect(
          constants.has(text),
          `${moduleName}.QUERY_DEFINITIONS[${JSON.stringify(name)}] carries a text no ` +
            "module-level constant of that module holds, so nothing there can be executing it",
        ).toBe(true);

        const expression = expressions.get(name);
        expect(
          expression,
          `${moduleName}.QUERY_DEFINITIONS has no entry named ${JSON.stringify(name)} in the ` +
            "source, so what the catalogue is built from cannot be read",
        ).toBeDefined();
        expect(
          ts.isIdentifier(expression as ts.Expression),
          `${moduleName}.QUERY_DEFINITIONS[${JSON.stringify(name)}] is a string of its own ` +
            "rather than the module-level constant the code executes; a catalogue holding its " +
            "own copy is the drift this test exists for",
        ).toBe(true);
      }

      for (const [line, argument] of statementArguments(moduleName)) {
        expect(
          ts.isStringLiteral(argument) ||
            ts.isNoSubstitutionTemplateLiteral(argument) ||
            ts.isTemplateExpression(argument),
          `${moduleName}.ts line ${line} hands the driver a literal; the catalogue can then ` +
            "only carry a copy of it. Execute the constant (measurement-harness.md section 6)",
        ).toBe(false);
        expect(
          ts.isIdentifier(argument) ||
            ts.isElementAccessExpression(argument) ||
            ts.isPropertyAccessExpression(argument),
          `${moduleName}.ts line ${line} hands the driver a composed statement, which no ` +
            "catalogue entry can be the text of",
        ).toBe(true);
      }
    },
  );
});

// --------------------------------------------------------------------------
// the trace half -- the report's catalogue against the report's own execution
// --------------------------------------------------------------------------

describe("section 6 -- the report's catalogue against the report's own execution", () => {
  /**
   * Section 6's requirement, checked against what the report actually did.
   *
   * This is the case that keeps the catalogue complete as modules are added: it
   * knows nothing about which modules the report calls, only that whatever it
   * called must be attested -- in the catalogue by its text, or by name and
   * reason in `UNATTESTED_STATEMENTS`.
   */
  test("the report catalogue carries every statement the report runs", () => {
    const { header, recorded } = reportWithTrace(reportDb());
    const catalogue = header.queries.definitions;
    const excused = new Set([...UNATTESTED_STATEMENTS.keys()].map(canonicalIssuer));

    expect(
      recorded.length,
      "the trace recorded almost nothing, so this assertion is vacuous; the recorder is no " +
        "longer seeing the report's statements",
    ).toBeGreaterThan(10);

    for (const { where, statement } of recorded) {
      if (catalogueName(catalogue, statement) !== null) {
        continue;
      }
      expect(
        excused.has(canonicalIssuer(where)),
        `${where} executes a statement the report's query_definitions does not carry and ` +
          `UNATTESTED_STATEMENTS does not name:\n${statement}\n` +
          "Section 6 requires every query the report ran, as text: lift it to a constant and " +
          "add its module to render.REPORT_QUERY_SOURCES, or -- if its text cannot exist " +
          "before it runs -- name it in render.UNATTESTED_STATEMENTS with the reason",
      ).toBe(true);
    }
  });

  /**
   * The converse, so completeness cannot be bought with stale entries.
   *
   * `query_definitions` is "every query the report ran" in both directions. A
   * name in the catalogue that nothing executed is a statement a reader would
   * run by hand believing it produced one of these numbers.
   */
  test("every catalogued query was one the report ran", () => {
    const { header, recorded } = reportWithTrace(reportDb());
    const catalogue = header.queries.definitions;

    const observed = new Set<string>();
    for (const { statement } of recorded) {
      const name = catalogueName(catalogue, statement);
      if (name !== null) {
        observed.add(name);
      }
    }
    expect(
      [...observed].sort(),
      "these catalogue entries name no statement this report executed: " +
        `${JSON.stringify([...catalogue.keys()].filter((name) => !observed.has(name)).sort())}`,
    ).toStrictEqual([...catalogue.keys()].sort());
  });

  /**
   * An exemption outlives the statement it excuses, and reads as a hole.
   *
   * The note the report prints is generated from `UNATTESTED_STATEMENTS`, so a
   * dead entry tells the reader the report ran something it did not.
   */
  test("no declared exemption is stale", () => {
    const { recorded } = reportWithTrace(reportDb());
    const issuers = new Set(recorded.map(({ where }) => canonicalIssuer(where)));

    const stale = [...UNATTESTED_STATEMENTS.keys()].filter(
      (key) => !issuers.has(canonicalIssuer(key)),
    );
    expect(
      stale,
      `render.UNATTESTED_STATEMENTS excuses statements this report never issued: ${JSON.stringify(stale.sort())}`,
    ).toStrictEqual([]);
  });

  /**
   * `provenance.test.ts` proves this over a caller's set; here over the real one.
   *
   * Not a second copy of that case: what is checked here is that the *enlarged*
   * catalogue -- the measurement modules' statements folded in -- is inside the
   * digest, so an edit to one of the lifted constants moves the sha256 the
   * header publishes. A catalogue carried beside the digest instead of inside it
   * would pass every other case in this file.
   */
  test("the digest still moves when a query text moves", () => {
    const { header } = reportWithTrace(reportDb());
    const definitions = new Map(header.queries.definitions);

    expect(queryCatalogue(definitions).digest).toBe(header.queries.digest);

    const lifted = [...definitions].filter(([name]) =>
      CATALOGUED_MODULES.some((moduleName) => catalogueOf(moduleName).has(name)),
    );
    expect(
      lifted.length,
      "the lifted measurement queries are not in the header's set",
    ).toBeGreaterThan(0);

    for (const [name, text] of lifted) {
      const edited = new Map(definitions);
      edited.set(name, text.replace("run_id", "run_id_2"));
      expect(
        queryCatalogue(edited).digest,
        `editing the text of ${name} did not move the query digest`,
      ).not.toBe(header.queries.digest);
    }
  });
});

describe("target-only -- the port's own machinery carries no warrant from the source", () => {
  /**
   * The fold between the two spellings of an issuer name stays one-to-one.
   *
   * {@link canonicalIssuer} exists because `UNATTESTED_STATEMENTS` is keyed by
   * the source's `snake_case` names while the trace observes this port's
   * `camelCase` ones, and it works by throwing away exactly the information the
   * two conventions disagree about. Throwing away too much is the way it fails:
   * two exemptions that folded together would let an entry written for one
   * function excuse a statement issued by another, and every case in this file
   * would stay green while the catalogue had a hole in it.
   *
   * Target-only because the source has no fold at all -- one language, one
   * spelling -- so nothing in interlock underwrites this (rule 11).
   */
  test("target-only -- the issuer fold does not collapse two exemptions into one", () => {
    const keys = [...UNATTESTED_STATEMENTS.keys()];
    const folded = keys.map(canonicalIssuer);
    expect(
      new Set(folded).size,
      `two entries of render.UNATTESTED_STATEMENTS fold to one issuer name, so one of them ` +
        `can excuse the other's statement: ${JSON.stringify(keys)}`,
    ).toBe(keys.length);
  });

  /**
   * The recorder forwards, and changes nothing the report says.
   *
   * The source wraps the connection in a forwarding class with one overridden
   * method; this port wraps it in a `Proxy`, which intercepts *every* property
   * access and hands back bound functions for the ones it does not record. That
   * is a much larger surface to get wrong, and getting it wrong is silent: a
   * report built over a subtly different connection would still render, and
   * every assertion in this file is about that report. So the traced report is
   * pinned against an untraced one over the same database, at the same clock.
   *
   * Target-only for the reason above: the machinery being checked is the port's.
   */
  test("target-only -- a report built through the recorder is the report built without it", () => {
    const path = reportDb();
    const { report: traced } = reportWithTrace(path);

    const connection = openForMeasurement(path);
    let untraced: MeasurementReport;
    try {
      untraced = buildMeasurementReport(connection, {
        dbPath: path,
        periodStartMs: PERIOD_START,
        periodEndMs: PERIOD_END,
        nowMs: GENERATED_AT,
        fixtureSuite: FixtureSuiteRef.absent("no corpus in this test"),
        v1Shadow: V1ShadowInput.observed("v1-export", [V1_SHADOW_RUN_ID]),
        fingerprintMode: FINGERPRINT_CONTENT,
      });
    } finally {
      connection.close();
    }

    expect(renderJson(traced)).toBe(renderJson(untraced));
  });
});
