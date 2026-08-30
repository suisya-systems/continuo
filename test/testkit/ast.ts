import { dirname, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";

/**
 * Every module `source` imports, with relative specifiers resolved to a path.
 *
 * The shared half of the `_imported_modules` port that `test/canary/structural.test.ts`,
 * `test/secretary/structural.test.ts` and `test/messagebus/import-graph.test.ts` each carried as
 * a near-identical private copy (D-0504). The whole tree is walked rather than the top-level
 * statements, so an import inside a function body is reached; `import type` is TypeScript's
 * `TYPE_CHECKING` block, erased at emit and therefore invisible to any scan of the built
 * JavaScript, which is exactly why it has to be seen here; and dynamic `import()` and `require()`
 * are how a module reaches another at a point a static import list does not mention.
 *
 * A relative specifier is resolved against the importing file's directory, so `../session/index.js`
 * surfaces as a path outside the package rather than as a bare tail a containment test would let
 * through -- the port of the source's level-1 / level>=2 relative-import rule. A bare specifier
 * (`node:fs`, `better-sqlite3`) is returned unchanged: those are the stdlib and third-party imports
 * the source's `startswith("claude_org_runtime")` filter allows.
 *
 * **What this does not carry.** `calledNames`, `referencedIdentifiers` and `exportedNames` (only
 * `test/secretary/structural.test.ts` needs them) and `namesASessionBackend` plus the dynamic-import
 * primitive ban (only `test/messagebus/import-graph.test.ts` needs them) stay local to their own
 * belts -- D-0504 found `importedModules` to be the only genuinely common piece, and extracting
 * further would merge three belts' different questions into one helper that answers none of them
 * cleanly.
 */
export function importedModules(source: ts.SourceFile, filePath: string): ReadonlySet<string> {
  const names = new Set<string>();
  const here = dirname(filePath);

  const add = (specifier: ts.Expression | undefined): void => {
    if (specifier === undefined || !ts.isStringLiteralLikeNode(specifier)) {
      return;
    }
    const text = specifier.text;
    names.add(text.startsWith(".") ? resolve(here, text) : text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // `export ... from "x"` is an import as far as the dependency goes, and it
      // is how a barrel reaches every module it re-exports.
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
    node.forEachChild(visit);
  };

  visit(source);
  return names;
}
