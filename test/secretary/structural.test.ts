/**
 * Item 8's structural half: the intake cannot block, shown on the syntax tree.
 *
 * Ported from interlock `tests/secretary/test_structural.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping, the systematic
 * translations and the deliberate divergences are recorded in
 * `parity/secretary.structural.ledger.json`.
 *
 * interlock `ACCEPTANCE.md` section 1 item 8 asks for the absence of blocking
 * dependencies to be shown *structurally* -- "no Secretary response path can be
 * blocked behind worker monitoring, long-running work, or an AI judgement".
 * Convention cannot show that; the syntax tree can, following the precedent of
 * `test/canary/structural.test.ts` in this repository and of the source's own
 * `tests/control_plane/test_lease.py`.
 *
 * The source makes three assertions, matching the three design rules in its
 * `intake.py`, and this port keeps all three -- but the third is the one place
 * where a word-for-word translation would have asserted nothing:
 *
 * 1. **Import allowlist.** The intake package imports nothing but what it
 *    names, and in particular no continuo sibling at all, so no dependency edge
 *    to a supervisor, a dispatcher or the control plane exists to block behind.
 *
 * 2. **No blocking primitive.** The names by which a caller waits -- a thread
 *    join, `Atomics.wait`, a synchronous child process, synchronous I/O -- do
 *    not occur as calls anywhere in the intake **package**.
 *
 * 3. **No suspension point exists at all.** The source's spelling is "no lock
 *    at all", because in Python a `with lock:` acquires implicitly and is
 *    therefore invisible to a ban on *called names*. Node has no lock to take,
 *    so porting the sentence literally would leave a case that passes on an
 *    empty file. What survives is the *subject*: the wait a call-name ban
 *    cannot see. In Node that is `await` -- a suspension point whose resumption
 *    is at the mercy of whatever else holds the loop -- so the package is held
 *    to having no `async` function, no `await`, and no Promise or
 *    cross-thread synchronisation object anywhere, and `submit()` is held to
 *    returning a receipt rather than a Promise. Recorded as `adapted` in the
 *    ledger and decided in D-0701.
 *
 * **This file asserts about the source tree, not about runtime behaviour**, so
 * it is the file in this belt most able to go green by losing its subject
 * (`docs/test-translation-conventions.md` section 10). The same three defences
 * `test/canary/structural.test.ts` uses are used here: the file set is a
 * **directory listing** rather than a hand-written list, a non-TypeScript file
 * in the package fails the walk rather than being skipped, the scan is a
 * **parse** rather than a regex, and the two scans are probed against their own
 * escape routes by a target-only case below.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";

import { caseRoot } from "../testkit/cases.js";

/**
 * The secretary package, as a directory.
 *
 * The source's `Path(secretary_pkg.__file__).resolve().parent` -- the package
 * the tests import, not a path spelled out by hand. Resolved from this file's
 * own URL rather than from `process.cwd()`, which is not the repository root
 * under every runner invocation.
 */
const PACKAGE_DIR = fileURLToPath(new URL("../../src/secretary/", import.meta.url));

/** The repository root, for reporting a foreign import by a readable name. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Everything the intake package may import, exhaustively.
 *
 * The port of the source's `ALLOWED_IMPORT_ROOTS`. It is shorter than the
 * source's five entries because four of those five have no Node counterpart to
 * import: `__future__` is a Python compiler directive, `dataclasses` is
 * `interface`/`class` syntax here, `collections` is the `Array` builtin, and
 * `itertools.count` is a `number` field. Only the clock is a module, and
 * `node:process` is where Node keeps the monotonic one.
 *
 * `node:worker_threads` is deliberately absent for the same reason `threading`
 * is absent from the source's list: the boundary must have nothing to wait on.
 */
const ALLOWED_IMPORTS: readonly string[] = ["node:process"];

/**
 * Names by which a caller waits. None of these may be *called* anywhere in the
 * intake package -- neither as `obj.name(...)` nor as a bare `name(...)`.
 *
 * The first block is the source's own list, kept name for name wherever the
 * name still names a wait in this runtime; the second is Node's spellings of
 * the same waits, which a literal port of a Python list would not have. Both
 * are conservative by construction: `join` bans `path.join` and `Array#join`
 * too, and `run` bans any method so named. That is the source's trade and it is
 * kept -- a package that has to reach for one of these names is a package whose
 * response path is worth re-reading, and the alternative (a scan that
 * understands what `join` is being called *on*) would need a type checker to be
 * anything but a guess.
 */
const BLOCKING_CALL_NAMES: ReadonlySet<string> = new Set([
  // the source's list
  "join",
  "wait",
  "wait_for",
  "get",
  "get_nowait",
  "sleep",
  "read",
  "readline",
  "readlines",
  "recv",
  "select",
  "poll",
  "communicate",
  "acquire",
  "result",
  "run",
  "check_output",
  "check_call",
  // Node's spellings of the same waits
  "waitAsync",
  "sleepSync",
  "execSync",
  "execFileSync",
  "spawnSync",
  "readFileSync",
  "readSync",
  "readdirSync",
  "readlinkSync",
  "writeFileSync",
  "writeSync",
  "appendFileSync",
  "openSync",
  "closeSync",
  "statSync",
  "realpathSync",
  "receiveMessageOnPort",
  "then",
]);

/**
 * Synchronisation and suspension objects whose *existence* in the package would
 * reintroduce an implicit wait.
 *
 * The port of the source's `LOCK_CONSTRUCTOR_NAMES`, widened to the objects
 * Node waits on. `Promise` heads the list: constructing one is how this
 * runtime creates something to be resumed later, and it is the nearest thing
 * here to the source's `with lock:` -- a wait that a ban on called names cannot
 * see. The Python-lineage names below it are kept even though the runtime has
 * no such builtins, so that a helper class added to this package under one of
 * those names is caught in either repository by the same list.
 */
const SUSPENSION_NAMES: ReadonlySet<string> = new Set([
  "Promise",
  "Atomics",
  "SharedArrayBuffer",
  "Worker",
  "MessageChannel",
  "MessagePort",
  "BroadcastChannel",
  "AsyncLocalStorage",
  "Lock",
  "RLock",
  "Condition",
  "Semaphore",
  "BoundedSemaphore",
  "Event",
  "Barrier",
]);

/**
 * Files in the package that are not TypeScript and are not scanned.
 *
 * The source globs `*.py`, so a non-Python artifact is outside its scan for
 * free. Spelling the exception out -- rather than filtering the listing by
 * extension -- is what keeps a future `.mjs`, `.sql` or `.json` in this package
 * from silently leaving the guard while it stays green over the rest
 * (`docs/test-translation-conventions.md` section 10, instance 3). Empty today,
 * on purpose: this package ships no data file.
 */
const NON_MODULE_FILES: readonly string[] = [];

/**
 * `(file name, parsed source)` for every module file in the package.
 *
 * Recursive, like the source's `PKG_ROOT.rglob("*.py")` and for the same stated
 * reason: a later `secretary/web/` subdirectory is reachable from the intake by
 * a relative import, so the package-wide guarantees hold only if its files are
 * scanned too.
 */
function secretaryModules(): readonly (readonly [string, ts.SourceFile])[] {
  const found: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path, `${prefix}${entry}/`);
      } else {
        found.push(`${prefix}${entry}`);
      }
    }
  };
  walk(PACKAGE_DIR, "");
  if (found.length === 0) {
    throw new Error(`the package walk found no files under ${PACKAGE_DIR}`);
  }
  const unreadable = found.filter(
    (entry) => !entry.endsWith(".ts") && !NON_MODULE_FILES.includes(entry),
  );
  if (unreadable.length > 0) {
    throw new Error(
      `${unreadable.join(", ")} are in the secretary package but are neither TypeScript nor ` +
        "declared non-module artifacts, so the guards below would skip them; widen the scan " +
        "rather than the filter",
    );
  }
  return found
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => {
      const text = readFileSync(join(PACKAGE_DIR, entry), "utf-8");
      return [entry, ts.createSourceFile(entry, text, ts.ScriptTarget.Latest, true)] as const;
    });
}

/**
 * Every module `source` imports, with relative specifiers resolved to a path.
 *
 * The port of the source's `_imported_roots`, and the same function
 * `test/canary/structural.test.ts` carries -- the whole tree is walked rather
 * than the top-level statements, so an import inside a function body is
 * reached; `import type` is TypeScript's `TYPE_CHECKING` block, erased at emit
 * and therefore invisible to any scan of the built JavaScript, which is exactly
 * why it has to be seen here; and dynamic `import()` and `require()` are how a
 * module reaches another at a point a static import list does not mention.
 *
 * A relative specifier is resolved against the importing file's directory, so
 * `../session/index.js` surfaces as a path outside the package rather than as a
 * bare tail a containment test would let through. That is the port of the
 * source's level-1 / level>=2 relative-import rule: the source exempts a
 * level-1 import (the package importing its own modules) and treats level>=2 as
 * an escape; resolving to an absolute path and testing containment in
 * `PACKAGE_DIR` asks the same question without a dotted namespace to lean on.
 */
function importedModules(source: ts.SourceFile, filePath: string): ReadonlySet<string> {
  const names = new Set<string>();
  const here = dirname(filePath);

  const add = (specifier: ts.Expression | undefined): void => {
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) {
      return;
    }
    const text = specifier.text;
    names.add(text.startsWith(".") ? resolve(here, text) : text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // `export ... from "x"` is an import as far as the dependency goes, and
      // it is how a barrel reaches every module it re-exports.
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference)) {
        add(reference.expression);
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return names;
}

/**
 * Names called in `source`, with import aliases resolved.
 *
 * The port of the source's `_called_names`, alias resolution included:
 * `import { execSync as go } from "node:child_process"` followed by `go(...)`
 * must register as a call to `execSync`, or the ban is a spelling check rather
 * than a property. Both the local spelling and the resolved original are
 * recorded, as in the source.
 */
function calledNames(source: ts.SourceFile): ReadonlySet<string> {
  const aliases = new Map<string, string>();
  const collectAliases = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && node.propertyName !== undefined) {
      aliases.set(node.name.text, node.propertyName.text);
    } else if (ts.isImportClause(node) && node.name !== undefined) {
      // A default or namespace import binds one local name to the module; the
      // source records the module's last dotted segment for `import x as y`.
      aliases.set(node.name.text, node.name.text);
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(source);

  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const fn = node.expression;
      if (ts.isPropertyAccessExpression(fn)) {
        names.add(fn.name.text);
      } else if (ts.isElementAccessExpression(fn)) {
        // `obj["readFileSync"](...)` is the same call written to dodge a scan
        // that only reads dotted names.
        if (ts.isStringLiteralLike(fn.argumentExpression)) {
          names.add(fn.argumentExpression.text);
        }
      } else if (ts.isIdentifier(fn)) {
        names.add(fn.text);
        names.add(aliases.get(fn.text) ?? fn.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Every identifier that appears anywhere in `source`, in any position. */
function referencedIdentifiers(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** The names a module re-exports, as the module's `__all__`. */
function exportedNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.exportClause !== undefined) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          names.add(element.name.text);
        }
      } else {
        names.add(`* as ${node.exportClause.name.text}`);
      }
    } else if (ts.isExportDeclaration(node) && node.exportClause === undefined) {
      // `export * from "./x.js"`: the surface is then whatever that module
      // happens to export, which is the thing the source's explicit `__all__`
      // exists to refuse.
      names.add("* (star re-export)");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** A foreign import, named relative to the repository root for the message. */
function readable(module: string): string {
  return module.startsWith(REPO_ROOT)
    ? module.slice(REPO_ROOT.length).split(sep).join("/")
    : module;
}

describe("structural assertions: the intake cannot block", () => {
  test("the intake package imports only its allowlist", () => {
    const offenders: Record<string, string[]> = {};
    for (const [name, source] of secretaryModules()) {
      const outside = [...importedModules(source, join(PACKAGE_DIR, name))]
        .filter((module) => !module.startsWith(PACKAGE_DIR))
        .filter((module) => !ALLOWED_IMPORTS.includes(module))
        .map(readable)
        .sort();
      if (outside.length > 0) {
        offenders[name] = outside;
      }
    }
    expect(
      offenders,
      `secretary intake imports outside its allowlist: ${JSON.stringify(offenders)}; the ` +
        "non-blocking claim rests on there being no edge to block behind",
    ).toEqual({});
  });

  test("the barrel re-exports only from its own package", () => {
    const barrel = secretaryModules().find(([name]) => name === "index.ts");
    expect(barrel, "the package has no index.ts to be its documented surface").toBeDefined();
    if (barrel === undefined) {
      return;
    }
    const outside = [...importedModules(barrel[1], join(PACKAGE_DIR, "index.ts"))]
      .filter((module) => !module.startsWith(PACKAGE_DIR))
      .filter((module) => !ALLOWED_IMPORTS.includes(module))
      .map(readable)
      .sort();
    expect(
      outside,
      `index.ts reaches ${JSON.stringify(outside)}; the package re-exports its own modules and ` +
        "nothing else",
    ).toEqual([]);
  });

  test("no blocking primitive is called anywhere in the package", () => {
    const offenders: Record<string, string[]> = {};
    for (const [name, source] of secretaryModules()) {
      const found = [...calledNames(source)].filter((called) => BLOCKING_CALL_NAMES.has(called));
      if (found.length > 0) {
        offenders[name] = found.sort();
      }
    }
    expect(
      offenders,
      `blocking primitive(s) called in ${JSON.stringify(offenders)}; the response path must ` +
        "stamp, offer, and answer without waiting on anything",
    ).toEqual({});
  });

  test("the package has no suspension point at all", () => {
    for (const [name, source] of secretaryModules()) {
      const suspensions: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isAwaitExpression(node)) {
          suspensions.push("await");
        } else if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
          suspensions.push("for await");
        } else if (
          ts.canHaveModifiers(node) &&
          ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true
        ) {
          suspensions.push("async");
        } else if (ts.isYieldExpression(node)) {
          suspensions.push("yield");
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(
        suspensions,
        `${name} contains ${JSON.stringify(suspensions)}; an await resumes at the mercy of ` +
          "whatever else holds the loop, which is the wait the call-name ban cannot see",
      ).toEqual([]);

      const objects = [...referencedIdentifiers(source)]
        .filter((identifier) => SUSPENSION_NAMES.has(identifier))
        .sort();
      expect(
        objects,
        `${name} names synchronisation object(s) ${JSON.stringify(objects)}; the boundary must ` +
          "have nothing to wait on",
      ).toEqual([]);
    }

    // The same rule at the one place a caller can observe it: `submit()` hands
    // back a receipt, so there is no point at which a request is parked.
    const intake = secretaryModules().find(([name]) => name === "intake.ts");
    expect(intake, "the package has no intake.ts").toBeDefined();
    if (intake === undefined) {
      return;
    }
    let submitReturn: string | undefined;
    const findSubmit = (node: ts.Node): void => {
      if (
        ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "submit"
      ) {
        submitReturn = node.type === undefined ? "(none)" : node.type.getText(intake[1]);
      }
      ts.forEachChild(node, findSubmit);
    };
    findSubmit(intake[1]);
    expect(
      submitReturn,
      "submit() must declare a synchronous return type; a Promise there would be the wait the " +
        "whole package exists not to have",
    ).toBe("IntakeReceipt");
  });

  test("the public surface is the documented boundary", () => {
    const barrel = secretaryModules().find(([name]) => name === "index.ts");
    expect(barrel).toBeDefined();
    if (barrel === undefined) {
      return;
    }
    expect(
      [...exportedNames(barrel[1])].sort(),
      "the boundary contract's names are intake, queue, receipt, refusal; a later real " +
        "Secretary replaces the implementation, not the vocabulary " +
        "(docs/secretary-intake-boundary.md)",
    ).toEqual(["IntakeQueue", "IntakeReceipt", "IntakeRefused", "SecretaryIntake"]);
  });

  test("target-only -- the two scans catch the ways around them", () => {
    // A guard is only as good as what it would have caught. The source's own
    // structural file has no probe case, so this is target-only: it defends the
    // scanning machinery the port had to write, not a property of the source.
    const probeDir = caseRoot("secy-str");
    const probe = join(probeDir, "probe.ts");
    writeFileSync(
      probe,
      // Parsed, never loaded and never type-checked, which is what lets it name
      // paths that do not exist and climb out of a directory nothing else is in.
      'import type { Anything } from "../session/index.js";\n' +
        'import { schema } from "../../src/control_plane/schema.js";\n' +
        'import { execSync as go } from "node:child_process";\n' +
        'import * as fs from "node:fs";\n' +
        "export function late(): void {\n" +
        '  require("../measurement/index.js");\n' +
        '  go("echo");\n' +
        '  fs["readFileSync"]("/dev/null");\n' +
        "}\n" +
        "export async function later(): Promise<void> {\n" +
        '  await import("../canary/index.js");\n' +
        "}\n",
      "utf-8",
    );
    const parsed = ts.createSourceFile(
      "probe.ts",
      readFileSync(probe, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    );

    const seen = importedModules(parsed, probe);
    expect(
      seen.has(resolve(probeDir, "../session/index.js")),
      "a type-only import is erased at emit and must still be seen",
    ).toBe(true);
    expect(
      seen.has(resolve(probeDir, "../../src/control_plane/schema.js")),
      "a relative specifier that climbs out of the package must resolve to the path it names",
    ).toBe(true);
    expect(
      seen.has(resolve(probeDir, "../measurement/index.js")),
      "a require() inside a function body must be reached by the walk",
    ).toBe(true);
    expect(
      seen.has(resolve(probeDir, "../canary/index.js")),
      "a dynamic import() inside a function body must be reached by the walk",
    ).toBe(true);

    const called = calledNames(parsed);
    expect(
      called.has("execSync"),
      "a blocking call reached through an import alias must resolve to the original name",
    ).toBe(true);
    expect(
      called.has("readFileSync"),
      'a blocking call written as obj["name"](...) must be read as a call to that name',
    ).toBe(true);
  });
});
