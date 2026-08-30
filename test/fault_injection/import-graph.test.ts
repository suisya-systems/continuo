/**
 * The seam holds: only the adapter knows what the implementation is.
 *
 * Ported from interlock `tests/fault_injection/test_import_graph.py` at
 * `65f36c5`.
 *
 * Design section 6.1. interlock D-0026 makes the tests durable and the spike
 * implementation throwaway. A harness that imported outbox internals would be
 * destroyed with them -- or worse, would preserve them by making the spike
 * schema load-bearing for the gate record. So exactly two modules in this tree
 * may import `src/`, and it is asserted structurally rather than agreed
 * socially.
 *
 * The assertion is over the parsed syntax tree, following the precedent in
 * `test/canary/structural.test.ts`: the escapes that matter -- an import inside
 * a function, a type-only import that is erased at emit, a dynamic `import()` --
 * are exactly what a line-oriented pattern gets wrong.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript/unstable/ast";
import { describe, expect, test } from "vitest";
import { parseSourceFile } from "../../scripts/lib/ts-ast.mjs";
import { installSuiteBudget, manifest, profile } from "./policy.js";

const BUDGET_PROFILE = profile(manifest());

const HARNESS_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HARNESS_ROOT, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

// The suite budget (design 9). Installed per file rather than per package --
// see `installSuiteBudget` for why, and for what that narrowing does and does
// not catch.
installSuiteBudget(BUDGET_PROFILE);

/**
 * The modules allowed to reach the implementation of the day: one adapter per
 * component generation -- the spike driver over the control plane, and the
 * session driver over the orchestrator (D-0601).
 */
const ADAPTER_MODULES: ReadonlySet<string> = new Set(["spike_driver.ts", "session_driver.ts"]);

/**
 * Files in this directory that are not TypeScript modules, named explicitly.
 *
 * The source globs `*.py` and gets the exclusion of `manifest.json` for free
 * from the extension. Naming the exceptions instead is
 * `docs/test-translation-conventions.md` section 10 instance 3: an
 * extension-defined subject set silently stopped covering the fencing package's
 * most security-relevant file the day it shipped as `.mjs`. Any other non-`.ts`
 * artifact added here fails this file rather than quietly leaving the guard.
 */
const NON_MODULE_FILES: ReadonlySet<string> = new Set([
  "manifest.json",
  // The child process's `.js` -> `.ts` resolve hook and the shim that registers
  // it. They are `.mjs` because a resolver hook is loaded by Node before any
  // TypeScript is stripped, so it cannot itself be TypeScript.
  "driver-loader.mjs",
  "driver-register.mjs",
]);

/** Every module file in the harness directory, as a bare file name. */
function harnessModules(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(HARNESS_ROOT).sort()) {
    const path = join(HARNESS_ROOT, entry);
    if (statSync(path).isDirectory()) {
      throw new Error(
        `${entry} is a directory inside the harness; the import seam is asserted over a flat ` +
          "directory and a nested module would not be walked",
      );
    }
    if (entry.endsWith(".ts")) {
      found.push(entry);
      continue;
    }
    if (!NON_MODULE_FILES.has(entry)) {
      throw new Error(
        `${entry} is neither a TypeScript module nor a declared non-module file. Add it to ` +
          "NON_MODULE_FILES with a reason, or the import seam silently stops covering it",
      );
    }
  }
  return found;
}

/**
 * Every module specifier `file` imports, by every route.
 *
 * Static imports and re-exports, `import type` (erased at emit, and therefore
 * invisible to any scan of built JavaScript), dynamic `import()` and `require()`
 * from inside a function body. The last three are the TypeScript analogues of
 * the source's "an import in a function body, one behind `TYPE_CHECKING`".
 */
function importedSpecifiers(file: string): string[] {
  const path = join(HARNESS_ROOT, file);
  const source = parseSourceFile(path, readFileSync(path, "utf8"));
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const first = node.arguments[0];
      if ((isDynamicImport || isRequire) && first !== undefined && ts.isStringLiteral(first)) {
        specifiers.push(first.text);
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return specifiers;
}

/**
 * The specifiers of `file` that resolve inside `src/`.
 *
 * Python's `claude_org_runtime` root test becomes path containment: a relative
 * specifier is resolved against the importing file's directory and is foreign if
 * it lands under `src/`. A bare specifier (`node:fs`, `better-sqlite3`,
 * `typescript`, `vitest`) is stdlib or third-party and is always allowed, which
 * is the source's own allowance -- the package exports only `.` (interlock
 * D-0002), so no bare specifier can name a sibling continuo module.
 *
 * The containment compares against a path ending in a separator, so a sibling
 * directory whose name merely starts with `src` is not swept in.
 */
function foreignImports(file: string): string[] {
  const foreign = new Set<string>();
  for (const specifier of importedSpecifiers(file)) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      continue;
    }
    const resolved = resolve(HARNESS_ROOT, specifier);
    if (resolved.startsWith(`${SRC_ROOT}/`) || resolved.startsWith(`${SRC_ROOT}\\`)) {
      foreign.add(relative(REPO_ROOT, resolved).split("\\").join("/"));
    }
  }
  return [...foreign].sort();
}

describe("the import seam", () => {
  test("only the adapter imports the implementation under test", () => {
    const offenders: Record<string, string[]> = {};
    for (const file of harnessModules()) {
      if (ADAPTER_MODULES.has(file)) {
        continue;
      }
      const foreign = foreignImports(file);
      if (foreign.length > 0) {
        offenders[file] = foreign;
      }
    }
    expect(
      Object.keys(offenders).sort(),
      `${JSON.stringify(offenders)} import src/; the coupling to the spike internals lives in ` +
        "the adapter alone (design 6.1), so the durable half survives the spike discard",
    ).toEqual([]);
  });

  test("the adapter exists and does import it", () => {
    // The rule is a seam, not a ban: something has to bind to today's schema.
    for (const name of [...ADAPTER_MODULES].sort()) {
      expect(foreignImports(name).length, `${name} imports nothing from src/`).toBeGreaterThan(0);
    }
  });

  test("the contract and controller name no spike symbol", () => {
    // Not even in prose-as-code: no implementation identifiers leak in. A
    // durable module that mentioned `Outbox` by name in a type annotation or a
    // default would still have to be edited when the spike is discarded, which
    // is exactly the coupling the seam exists to prevent.
    //
    // The identifier set is built the way the source builds it -- every `Name`
    // and every attribute -- which in TypeScript is every identifier and every
    // property name, so a type annotation counts and a string does not.
    for (const name of ["contract.ts", "controller.ts", "manifest.ts"]) {
      const path = join(HARNESS_ROOT, name);
      const source = parseSourceFile(path, readFileSync(path, "utf8"));
      const identifiers = new Set<string>();
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          identifiers.add(node.text);
        }
        node.forEachChild(visit);
      };
      source.forEachChild(visit);
      for (const spike of ["Outbox", "KeyedDropbox", "ProtectedWrite", "FencedStatement"]) {
        expect(identifiers.has(spike), `${name} names ${spike}`).toBe(false);
      }
    }
  });
});
