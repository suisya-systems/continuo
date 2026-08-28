/**
 * The static and dynamic walks of `src/measurement/`, shared by two belts.
 *
 * Interlock's `tests/measurement/test_known_holes.py` carries this machinery as
 * private helpers and `tests/measurement/test_query_catalogue.py` imports two of
 * them (`_module_sources`, `_statements_executed`) from it. Vitest collects per
 * FILE rather than per module, so one test file importing another registers the
 * imported file's cases a second time; the shared half therefore lives here,
 * in a module the runner does not collect. That is the same move
 * `test/measurement/report-reading.ts` made for the render and CLI belts.
 *
 * Two walks, and the difference between them is the source's:
 *
 * * {@link measurementModules} is `pkgutil.iter_modules` -- the package's
 *   modules, imported, with the package's `__init__` excluded. ESM cannot
 *   import a specifier computed at runtime, so this is `import.meta.glob`,
 *   which Vite expands at transform time from the same directory listing. It is
 *   a walk and not a list: a module added to the package is imported here
 *   without this file being edited, which is the property the source builds two
 *   of its tests on. The namespaces it yields are the SAME module instances a
 *   static import of `../../src/measurement/x.js` yields (measured), so a class
 *   reached through this walk still satisfies `instanceof` against one reached
 *   through an import.
 * * {@link moduleSources} is `PACKAGE_ROOT.glob("*.py")` -- every file in the
 *   package, parsed. `__init__.py` is in that set, so `index.ts` is in this one.
 *
 * **The file set is defined as "every file in the package", not as an
 * extension.** `docs/test-translation-conventions.md` section 10 records what
 * the other spelling cost: a `.ts`-only glob in the fencing belt silently
 * stopped covering the package's most security-relevant file on the day that
 * file shipped as `.mjs`, and stayed green over the rest. So
 * {@link packageFiles} lists the directory and refuses a file it cannot parse
 * as TypeScript rather than skipping it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

/**
 * `import.meta.glob` is Vite's, and it is replaced at transform time, so it has
 * to be written out in full at the call site (measured: aliasing it throws
 * "statically replaced during file transformation"). The repository's
 * `tsconfig.json` carries `types: ["node"]` and not `vite/client`; declaring the
 * one member used here is narrower than pulling in the whole client library,
 * and it names what the call actually relies on.
 */
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<Record<string, unknown>>>;
  }
}

/** The package under measurement, as a directory. */
export const PACKAGE_DIR = fileURLToPath(new URL("../../src/measurement/", import.meta.url));

/** The package's `__init__`: in the source glob, out of the module walk. */
const PACKAGE_INDEX = "index";

/**
 * Every file in the package, by name.
 *
 * Not filtered by extension -- see the note at the top of this file. A file this
 * scan cannot read as TypeScript is a failure here rather than a silent
 * omission, because an omission reads as coverage.
 */
export function packageFiles(): readonly string[] {
  const entries = readdirSync(PACKAGE_DIR)
    .filter((entry) => statSync(join(PACKAGE_DIR, entry)).isFile())
    .sort();
  if (entries.length === 0) {
    throw new Error(`the package walk found no files under ${PACKAGE_DIR}`);
  }
  const unreadable = entries.filter((entry) => !entry.endsWith(".ts"));
  if (unreadable.length > 0) {
    throw new Error(
      `${unreadable.join(", ")} are in the measurement package but are not TypeScript, so the ` +
        "static scans below would skip them; widen the scan rather than the filter",
    );
  }
  return entries;
}

/** `(module short name, parsed source)` for every file in the package. */
export function moduleSources(): readonly (readonly [string, ts.SourceFile])[] {
  return packageFiles().map((entry) => {
    const text = readFileSync(join(PACKAGE_DIR, entry), "utf8");
    return [entry.slice(0, -3), ts.createSourceFile(entry, text, ts.ScriptTarget.Latest, true)];
  });
}

/**
 * A module's leading doc comment: the port's `module.__doc__`.
 *
 * TypeScript has no runtime docstring, and the block comment a module opens
 * with is the artefact the source's assertions are about -- "the reason is
 * written down where the next person to want a backfill will read it".
 */
export function moduleDocComment(short: string): string {
  const text = readFileSync(join(PACKAGE_DIR, `${short}.ts`), "utf8");
  // The first column-zero `/**` block. In this package the module header sits
  // AFTER the imports -- NodeNext wants the import list first -- so "the comment
  // the file opens with" would find an import's own explanatory `//` note, or
  // nothing at all, on every module. Measured across all fifteen files: each has
  // exactly one such block and it is the module's prose header.
  const start = text.startsWith("/**") ? 0 : text.indexOf("\n/**");
  const end = start < 0 ? -1 : text.indexOf("*/", start);
  if (start < 0 || end < 0) {
    throw new Error(`${short}.ts carries no module doc comment for this scan to read`);
  }
  return text.slice(start, end + 2);
}

/**
 * Every module in the package, imported, keyed by short name.
 *
 * `index.ts` is excluded because `pkgutil.iter_modules` excludes `__init__`.
 * The two sets are deliberately different: this one is what a name lives in,
 * {@link moduleSources} is what a file says.
 */
export async function measurementModules(): Promise<ReadonlyMap<string, Record<string, unknown>>> {
  const loaders = import.meta.glob("../../src/measurement/*.ts");
  const found = new Map<string, Record<string, unknown>>();
  for (const [path, load] of Object.entries(loaders)) {
    const short = path.slice(path.lastIndexOf("/") + 1, -3);
    if (short === PACKAGE_INDEX) {
      continue;
    }
    found.set(short, await load());
  }
  if (found.size === 0) {
    throw new Error("the package walk found no modules, so every test here is vacuous");
  }
  // The two walks have to agree, or one of them is reporting a package that is
  // not the package on disk. Vite expands the glob at transform time; a run
  // against a stale expansion would import fewer modules than the directory
  // holds and every discovery below would be narrower than it reads.
  const onDisk = packageFiles()
    .map((entry) => entry.slice(0, -3))
    .filter((short) => short !== PACKAGE_INDEX);
  const missing = onDisk.filter((short) => !found.has(short));
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(", ")} are in ${PACKAGE_DIR} but were not imported by the module walk`,
    );
  }
  return found;
}

/**
 * A module-level binding, and where it came from.
 *
 * `vars(module)` is a Python module's namespace: everything bound at module
 * level, declarations and imports alike, public and private. ESM has no such
 * object -- a module namespace carries only its exports -- so the set is
 * recovered from the source. `importedFrom` is the specifier a name arrived
 * through, or `null` when the module declares it, which is the distinction the
 * source draws with `__module__`.
 *
 * Type-only declarations and `import type` bindings are absent on purpose: they
 * are erased, so they are not in any namespace at runtime, and Python has no
 * counterpart for them at all.
 */
export interface ModuleBinding {
  readonly name: string;
  readonly importedFrom: { readonly specifier: string; readonly exported: string } | null;
}

/** Every module-level binding in `short`, declarations and imports alike. */
export function moduleBindings(short: string): readonly ModuleBinding[] {
  const source = moduleSources().find(([name]) => name === short)?.[1];
  if (source === undefined) {
    throw new Error(`${short} is not a module of the measurement package`);
  }
  const bindings: ModuleBinding[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      bindings.push(...importedBindings(statement));
      continue;
    }
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name !== undefined) {
        bindings.push({ name: statement.name.text, importedFrom: null });
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          bindings.push({ name: declaration.name.text, importedFrom: null });
        }
      }
    }
  }
  return bindings;
}

function importedBindings(statement: ts.ImportDeclaration): ModuleBinding[] {
  const clause = statement.importClause;
  if (clause === undefined || clause.isTypeOnly) {
    return [];
  }
  if (!ts.isStringLiteral(statement.moduleSpecifier)) {
    return [];
  }
  const specifier = statement.moduleSpecifier.text;
  const found: ModuleBinding[] = [];
  if (clause.name !== undefined) {
    found.push({ name: clause.name.text, importedFrom: { specifier, exported: "default" } });
  }
  const bindings = clause.namedBindings;
  if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
    found.push({ name: bindings.name.text, importedFrom: { specifier, exported: "*" } });
  }
  if (bindings !== undefined && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      if (element.isTypeOnly) {
        continue;
      }
      found.push({
        name: element.name.text,
        importedFrom: { specifier, exported: (element.propertyName ?? element.name).text },
      });
    }
  }
  return found;
}

/**
 * The value behind an imported binding, so `__module__` can be asked about it.
 *
 * Vite expands this glob over the whole of `src/`, but the record it produces is
 * a map of loaders: only the one entry a caller asks for is invoked, so the cost
 * is paid per resolved name rather than per module in the repository. Bare
 * specifiers (`node:*`, `better-sqlite3`) are imported directly.
 */
export async function importedValue(
  short: string,
  from: { readonly specifier: string; readonly exported: string },
): Promise<unknown> {
  const namespace = await importedNamespace(short, from.specifier);
  if (from.exported === "*") {
    return namespace;
  }
  return namespace[from.exported];
}

async function importedNamespace(
  short: string,
  specifier: string,
): Promise<Record<string, unknown>> {
  if (!specifier.startsWith(".")) {
    return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  }
  // A relative specifier is written against the importing module and carries the
  // `.js` suffix NodeNext requires, so it is re-rooted at the package directory
  // and re-suffixed before it is matched against the source glob.
  const resolved = new URL(
    specifier,
    new URL(`../../src/measurement/${short}.ts`, import.meta.url),
  );
  const key = `../..${resolved.pathname.slice(resolved.pathname.indexOf("/src/"))}`.replace(
    /\.js$/,
    ".ts",
  );
  const loaders = import.meta.glob("../../src/**/*.ts");
  const load = loaders[key];
  if (load === undefined) {
    throw new Error(
      `${short} imports ${specifier}, which resolved to ${key}, and nothing is there`,
    );
  }
  return await load();
}

/**
 * The methods that take SQL text.
 *
 * The source's set is `execute` / `executemany` / `executescript`, which is
 * every `sqlite3` API that is handed a statement. better-sqlite3's equivalent
 * set is `prepare`, `exec` and `pragma`: everything else on the driver takes
 * bindings, not text, so a statement can only enter the process through one of
 * these three. Matched on the method name whatever the receiver is, exactly as
 * the source does -- which means a `RegExp.exec` in this package would be
 * reported as an unrecognised statement verb. That is the fail-loud direction
 * and it is the source's: a scan that quietly narrowed itself around a receiver
 * it did not recognise is how a write hides.
 */
const STATEMENT_METHODS = new Set(["prepare", "exec", "pragma"]);

/** `(module, enclosing function, verb, text)` for one execute call. */
export interface ExecutedStatement {
  readonly module: string;
  readonly functionName: string;
  readonly verb: string;
  readonly text: string | null;
  /**
   * Write verbs the text carries somewhere OTHER than its leading position.
   *
   * The source reads the leading verb and stops, and on its runtime that is
   * sufficient: `sqlite3.Connection.execute` refuses a second statement
   * outright ("You can only execute one statement at a time"), so a text whose
   * first verb is `SELECT` cannot also run an `INSERT`. **better-sqlite3's
   * `exec` runs every statement in the string**, which is the same widening
   * `docs/test-translation-conventions.md` rule 9 describes, reached through the
   * driver rather than through a type: `exec("SELECT 1; INSERT INTO
   * ai_invocation ...")` classifies as `SELECT` and writes.
   *
   * The same sweep closes a hole both runtimes have: SQLite accepts a CTE in
   * front of a write, so `WITH x AS (...) DELETE FROM run` leads with `WITH`,
   * which is in the source's READ_VERBS. That one is inherited and repaired here
   * under `D-0023`; the ledger records it. See `D-0115`.
   */
  readonly hiddenWriteVerbs: readonly string[];
}

/**
 * Every statement text a module could be handing the driver.
 *
 * Statements in this package arrive five ways -- a literal, a template, a
 * module-level constant, an entry in a query mapping, and a class field
 * (`RecordClass.sql`) -- and a scan that understood only the first would report
 * the other four as "not inspectable" until someone widened the exemptions
 * instead of the resolver. So each form is resolved to the text that is
 * actually executed; anything left unresolved is a failure, because an
 * uninspectable statement is where a write would sit unread.
 */
class Sources {
  private readonly names = new Map<string, ts.Expression>();
  private readonly mappings = new Map<string, Map<string, ts.Expression>>();
  private readonly fieldTexts: string[] = [];
  /**
   * Names declared more than once in the module.
   *
   * The source keys its bindings by name over a walk of the whole tree, so a
   * later declaration silently overwrites an earlier one and a name declared in
   * two functions resolves to whichever came last -- a `const statement =
   * "INSERT ..."` in one function read as the `"SELECT ..."` of another. Rather
   * than build a scope chain, a name with more than one declaration resolves to
   * NOTHING here, which reports the statement as uninspectable: fail-closed,
   * and the direction an ambiguity has to fail in a scan whose subject is a
   * hidden write. Measured: no name used as a statement argument in this
   * package is declared twice in its module, so nothing is lost today. Raised
   * by the review gate.
   */
  private readonly ambiguous = new Set<string>();

  constructor(source: ts.SourceFile) {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (this.names.has(node.name.text)) {
          this.ambiguous.add(node.name.text);
        }
        this.names.set(node.name.text, node.initializer);
        const entries = mappingEntries(node.initializer);
        if (entries !== null) {
          this.mappings.set(node.name.text, entries);
        }
      }
      // `sql:` on a record class construction: the text a `.sql` property access
      // will hand the driver. The source reads the `sql=` keyword of a call; the
      // port's spelling of that argument is a property of the options object.
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "sql") {
        const text = this.textOf(node.initializer, 0);
        if (text !== null) {
          this.fieldTexts.push(text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  textOf(node: ts.Node, depth: number): string | null {
    if (depth > 4) {
      return null;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    if (ts.isTemplateExpression(node)) {
      // The source's `JoinedStr` branch: the first non-blank literal part is the
      // one the verb is read from, because an interpolation cannot be the head
      // of a statement this package writes.
      if (node.head.text.trim() !== "") {
        return node.head.text;
      }
      for (const span of node.templateSpans) {
        if (span.literal.text.trim() !== "") {
          return span.literal.text;
        }
      }
      return null;
    }
    if (ts.isIdentifier(node)) {
      const bound = this.ambiguous.has(node.text) ? undefined : this.names.get(node.text);
      return bound === undefined ? null : this.textOf(bound, depth + 1);
    }
    if (ts.isElementAccessExpression(node)) {
      return this.mappingLookup(node.expression, node.argumentExpression, depth);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return this.textOf(node.left, depth + 1);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      // `QUERY.replace("{placeholders}", ...)` expands an IN list's
      // placeholders, which is what the source's `QUERY.format(...)` does; the
      // verb is the template's either way.
      if (method === "replace") {
        return this.textOf(node.expression.expression, depth + 1);
      }
      // A query mapping read through `Map.get`, the port's spelling of the
      // source's `QUERY_DEFINITIONS["name"]` subscript.
      if (method === "get" && node.arguments.length === 1) {
        return this.mappingLookup(node.expression.expression, node.arguments[0], depth);
      }
    }
    return null;
  }

  private mappingLookup(
    container: ts.Expression,
    key: ts.Expression | undefined,
    depth: number,
  ): string | null {
    if (key === undefined || !ts.isIdentifier(container) || !ts.isStringLiteralLike(key)) {
      return null;
    }
    const entry = this.mappings.get(container.text)?.get(key.text);
    return entry === undefined ? null : this.textOf(entry, depth + 1);
  }

  /**
   * The WHOLE text an expression evaluates to, interpolations included, or
   * `null` when any part of it cannot be read statically.
   *
   * `textOf` above is the source's resolver and returns the first non-blank
   * literal fragment of a template, which is enough to read a leading verb.
   * That is not enough to read a text for hidden statements: in
   * `exec(`SELECT 1; ${suffix}`)` the fragment is `SELECT 1; ` and the
   * suffix -- which is where an `INSERT` would be -- is never looked at. So the
   * classifier resolves the whole text where it can, and where it cannot the
   * fallback carries a precondition (see {@link textsForArgument}).
   */
  wholeTextOf(node: ts.Node, depth: number): string | null {
    if (depth > 4) {
      return null;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const interpolated = this.interpolationText(span.expression, depth);
        if (interpolated === null) {
          return null;
        }
        text += interpolated + span.literal.text;
      }
      return text;
    }
    if (ts.isIdentifier(node)) {
      const bound = this.ambiguous.has(node.text) ? undefined : this.names.get(node.text);
      return bound === undefined ? null : this.wholeTextOf(bound, depth + 1);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = this.wholeTextOf(node.left, depth + 1);
      const right = this.wholeTextOf(node.right, depth + 1);
      return left === null || right === null ? null : left + right;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      // `QUERY.replace("{placeholders}", ...)` substitutes a bind-parameter list
      // into a template. The template's own text is what is classified: the
      // substitution is a run of `?` separated by commas, which can hold neither
      // a statement separator nor a verb.
      if (node.expression.name.text === "replace") {
        return this.wholeTextOf(node.expression.expression, depth + 1);
      }
    }
    return null;
  }

  /**
   * What an interpolation contributes to the text, or `null` if unknown.
   *
   * A **number** is admitted without being computed. `${Number(userVersion)}`
   * cannot produce a semicolon, a keyword or a quote whatever the value is --
   * its string form is digits, a sign, a dot, `e`, `Infinity` or `NaN` -- so it
   * cannot smuggle a statement past the classifier, and a zero stands in for it.
   * That is not a convenience: it is the one interpolation `reader.ts` writes
   * into an `exec`, and refusing it would report the read-only probe itself as
   * uninspectable.
   */
  private interpolationText(node: ts.Expression, depth: number): string | null {
    if (ts.isNumericLiteral(node)) {
      return node.text;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Number"
    ) {
      return "0";
    }
    return this.wholeTextOf(node, depth + 1);
  }

  /**
   * Every text this argument can evaluate to, or `null` if unknown.
   *
   * `runsEveryStatement` is true for `exec`, which runs every statement in the
   * string, and false for `prepare` and `pragma`, which compile exactly one --
   * measured: `prepare("INSERT ...; INSERT ...")` throws "The supplied SQL
   * string contains more than one statement".
   *
   * The whole text is resolved first. Where it cannot be, the source's rule --
   * the first non-blank literal fragment names the verb -- is used, but only
   * when it is sound to do so: the call must compile a single statement, so an
   * interpolation cannot append one, AND the fragment's verb must not be `WITH`,
   * because a CTE puts its write AFTER the fragment a template's head holds.
   * Anything else is reported as uninspectable, which is the source's own
   * fail-closed branch.
   */
  textsForArgument(
    node: ts.Expression,
    options: { readonly runsEveryStatement: boolean },
  ): readonly string[] | null {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "sql") {
      // `recordClass.sql` over a declared set of record classes: each declared
      // sql is executed, so each is classified.
      return this.fieldTexts.length > 0 ? [...this.fieldTexts] : null;
    }
    const whole = this.wholeTextOf(node, 0);
    if (whole !== null) {
      return [whole];
    }
    if (options.runsEveryStatement) {
      return null;
    }
    const fragment = this.textOf(node, 0);
    if (fragment === null || leadingVerb(fragment) === "WITH") {
      return null;
    }
    return [fragment];
  }
}

/**
 * The entries of a mapping literal, whichever of the two spellings it uses.
 *
 * The source unwraps `MappingProxyType({...})` because a resolver that stopped
 * at the wrapper would report every lookup through it as uninspectable. This
 * package's read-only mappings are `readOnlyMap([[key, value], ...])`, so both
 * the wrapper and the entry-array form are unwrapped here.
 */
function mappingEntries(node: ts.Expression): Map<string, ts.Expression> | null {
  let literal = node;
  if (ts.isCallExpression(literal) && literal.arguments.length === 1) {
    literal = literal.arguments[0] as ts.Expression;
  }
  const entries = new Map<string, ts.Expression>();
  if (ts.isObjectLiteralExpression(literal)) {
    for (const property of literal.properties) {
      if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.name)) {
        entries.set(property.name.text, property.initializer);
      }
    }
    return entries;
  }
  if (ts.isArrayLiteralExpression(literal)) {
    for (const element of literal.elements) {
      if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) {
        continue;
      }
      const [key, value] = element.elements;
      if (key !== undefined && value !== undefined && ts.isStringLiteralLike(key)) {
        entries.set(key.text, value);
      }
    }
    return entries.size > 0 ? entries : null;
  }
  return null;
}

/**
 * The name of the function a node sits in, outermost first.
 *
 * `ast.walk` is breadth-first, so the source's `enclosing.setdefault` records
 * the OUTERMOST enclosing function rather than the nearest one -- a call inside
 * a closure is attributed to the named function that holds the closure. That is
 * what the read-only exemptions are written against, so the traversal here is
 * breadth-first too.
 */
function enclosingFunctions(source: ts.SourceFile): Map<ts.Node, string> {
  const enclosing = new Map<ts.Node, string>();
  const queue: ts.Node[] = [source];
  while (queue.length > 0) {
    const node = queue.shift() as ts.Node;
    const name = functionName(node);
    if (name !== null) {
      const descendants: ts.Node[] = [node];
      while (descendants.length > 0) {
        const child = descendants.pop() as ts.Node;
        if (!enclosing.has(child)) {
          enclosing.set(child, name);
        }
        ts.forEachChild(child, (grandchild) => {
          descendants.push(grandchild);
        });
      }
    }
    ts.forEachChild(node, (child) => {
      queue.push(child);
    });
  }
  return enclosing;
}

/**
 * The declared name of a function-like node, or `null`.
 *
 * `const f = () => {...}` is included because it is this port's spelling of
 * `def f`, and the exemptions are matched by function name. The source has no
 * counterpart -- a Python `lambda` is not a `FunctionDef` -- but leaving it out
 * would attribute a statement to `<module>` and so put it outside every
 * exemption, which fails in the safe direction and reads as a mystery.
 */
function functionName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : null;
  }
  if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : null;
  }
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (
    (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  return null;
}

/**
 * Every write verb the text carries beyond its leading position.
 *
 * String literals, quoted identifiers and comments are blanked first, so a
 * `WHERE status = 'DELETE'` is not a delete and a comment explaining what the
 * writers do is not one either -- the same reason the source parses rather than
 * greps. `replace(` is spared because it is SQLite's string function; the
 * statement verb is `REPLACE` followed by a space or the end of the text.
 */
function hiddenWriteVerbs(sql: string): readonly string[] {
  const scanned = blankLiteralsAndComments(sql);
  const leading = leadingVerb(sql);
  const found = new Set<string>();
  for (const match of scanned.matchAll(
    /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|VACUUM|ATTACH|DETACH|REINDEX)\b(?!\s*\()/gi,
  )) {
    found.add((match[1] as string).toUpperCase());
  }
  // A statement whose LEADING verb is the write is the source's own branch and
  // is reported there; dropping it here keeps the two reports disjoint rather
  // than naming one write twice.
  found.delete(leading);
  return [...found].sort();
}

/**
 * Blank out SQL string literals, quoted identifiers and comments, keeping
 * length so an index into the result still points at the same character.
 */
function blankLiteralsAndComments(sql: string): string {
  const out: string[] = [];
  let index = 0;
  const blank = (count: number): void => {
    out.push(" ".repeat(count));
    index += count;
  };
  while (index < sql.length) {
    const rest = sql.slice(index);
    const closer = { "'": "'", '"': '"', "`": "`", "[": "]" }[rest[0] as string];
    if (closer !== undefined) {
      // Doubling is SQLite's escape inside a quoted run; the scan does not need
      // to tell an escaped quote from a closing one, because either way what
      // lies between quotes is blanked.
      const end = sql.indexOf(closer, index + 1);
      blank(end < 0 ? rest.length : end - index + 1);
      continue;
    }
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", index);
      blank(end < 0 ? rest.length : end - index);
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", index + 2);
      blank(end < 0 ? rest.length : end - index + 2);
      continue;
    }
    out.push(rest[0] as string);
    index += 1;
  }
  return out.join("");
}

/** The leading verb of a statement, ignoring blank and comment-only lines. */
export function leadingVerb(sql: string): string {
  for (const line of sql.split("\n")) {
    const stripped = line.trim();
    if (stripped === "" || stripped.startsWith("--")) {
      continue;
    }
    const first = stripped.split(/\s+/, 1)[0] ?? "";
    return first
      .toUpperCase()
      .replace(/^[(;]+/, "")
      .replace(/[(;]+$/, "");
  }
  return "";
}

/** Every statement the package executes, classified. */
export function statementsExecuted(): readonly ExecutedStatement[] {
  const found: ExecutedStatement[] = [];
  for (const [short, source] of moduleSources()) {
    const sources = new Sources(source);
    const enclosing = enclosingFunctions(source);

    const visit = (node: ts.Node): void => {
      ts.forEachChild(node, visit);
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
        return;
      }
      const method = node.expression.name.text;
      if (!STATEMENT_METHODS.has(method) || node.arguments.length === 0) {
        return;
      }
      const argument = node.arguments[0] as ts.Expression;
      const functionOf = enclosing.get(node) ?? "<module>";
      const texts = sources.textsForArgument(argument, { runsEveryStatement: method === "exec" });
      if (texts === null) {
        found.push({
          module: short,
          functionName: functionOf,
          verb: "",
          text: null,
          hiddenWriteVerbs: [],
        });
        return;
      }
      for (const text of texts) {
        // `pragma()` takes the statement without its keyword. Restoring it is
        // what makes the classification below the source's: the source reads
        // `PRAGMA query_only = ON` off an `execute` call and asks whether the
        // text sets anything.
        const statement = method === "pragma" ? `PRAGMA ${text}` : text;
        found.push({
          module: short,
          functionName: functionOf,
          verb: leadingVerb(statement),
          text: statement,
          hiddenWriteVerbs: hiddenWriteVerbs(statement),
        });
      }
    };
    visit(source);
  }
  return found;
}

/**
 * The operators an `ast.Compare` node covers, in this language's spelling.
 *
 * Python's `Compare` carries `Eq`, `NotEq`, `Lt`, `LtE`, `Gt`, `GtE`, `Is`,
 * `IsNot`, `In` and `NotIn`. TypeScript writes the same relations as binary
 * operators, and there is no chained form to unfold. `instanceof` is included
 * as the port's `is`-family membership test; a negated `in` or `instanceof` is
 * a unary `!` over one of these, so the operand still reaches the scan.
 */
const COMPARISON_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.InstanceOfKeyword,
]);

/** One operand of one comparison, named the way the source names it. */
export interface ComparisonOperand {
  readonly module: string;
  readonly line: number;
  readonly name: string;
}

/**
 * Every named operand of every comparison in the package.
 *
 * A name is an identifier or the attribute of a property access, which is the
 * source's `ast.Name` / `ast.Attribute` pair; anything else is an expression
 * with no name to judge.
 */
export function comparisonOperands(): readonly ComparisonOperand[] {
  const found: ComparisonOperand[] = [];
  for (const [short, source] of moduleSources()) {
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && COMPARISON_OPERATORS.has(node.operatorToken.kind)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        for (const operand of [node.left, node.right]) {
          const name = ts.isIdentifier(operand)
            ? operand.text
            : ts.isPropertyAccessExpression(operand) && ts.isIdentifier(operand.name)
              ? operand.name.text
              : null;
          if (name !== null) {
            found.push({ module: short, line, name });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}
