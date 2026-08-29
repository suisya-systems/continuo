/**
 * Structural assertions: independence and labelling, held rather than described.
 *
 * Ported from interlock `tests/canary/test_structural.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping, the systematic
 * translations and the one deliberate divergence are recorded in the parity
 * ledger.
 *
 * Two claims about the rehearsal are structural and therefore assertable
 * against the artifact itself. First, the routing point has **no provider
 * dependency** -- it survives C2, or any later switch, untouched -- which here
 * is the stronger statement that the `canary` package imports no other module
 * of this package at all: not `session`, not `dispatcher`, and not even
 * `control_plane` (the audit takes open connections and never reaches into
 * either system). Second, the D-0022 labelling is *on the artifacts*: the DDL,
 * the package barrel, the written record and every report all carry the one
 * marking sentence, and a labelling that had drifted apart would fail here
 * rather than be noticed at the canary.
 *
 * **This file asserts about the source tree, not about runtime behaviour**, so
 * it is the file in this belt most able to go green by losing its subject
 * (convention rule 10). Three things are done about that, all of them the
 * source's own moves carried over:
 *
 * * The file set is the **directory listing**, never a hand-written list of
 *   modules: a canary module added tomorrow is scanned without this file being
 *   edited, which is the property the source's `PACKAGE_DIR.glob("*.py")`
 *   carries. A non-TypeScript file in the package fails {@link canaryModules}
 *   rather than being skipped, because a skip reads as coverage
 *   (`docs/test-translation-conventions.md` section 10, instance 3).
 * * The scan is a **parse**, not a regex, for the same reason the source uses
 *   `ast` rather than a regex: the escapes that matter -- an import in a
 *   function body, a type-only import, a dynamic `import()` -- are exactly what
 *   a line-oriented pattern gets wrong.
 * * The guard is probed against its own escape routes by the case below it,
 *   which is what makes the first case worth anything.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";

import { REHEARSAL_MARKING } from "../../src/canary/marking.js";
import { importedModules } from "../testkit/ast.js";
import { caseRoot } from "../testkit/cases.js";

/**
 * The canary package, as a directory.
 *
 * The source's `Path(canary_package.__file__).parent` -- the package the tests
 * import, not a path spelled out by hand. Resolved from this file's own URL
 * rather than from `process.cwd()`, which is not the repository root under
 * every runner invocation.
 */
const PACKAGE_DIR = fileURLToPath(new URL("../../src/canary/", import.meta.url));

/** The repository root: the source's `Path(__file__).resolve().parents[2]`. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The written record the labelling and `Q-0005` cases read. */
const CONTRACT = join(REPO_ROOT, "docs", "canary-routing-rehearsal.md");

/**
 * The one module outside `src/canary/` the port's canary is allowed to import.
 *
 * **This is a real divergence from the source, allowed deliberately and no
 * wider than it has to be.** Python's `sqlite3` exception classes are built in,
 * so interlock's canary classifies a store failure (`sqlite3.IntegrityError`,
 * and the result code behind it) with no import at all. better-sqlite3 reports
 * the same result codes through `error.code`, and reading them is done in one
 * shared module -- `src/sqlite/errors.ts` -- because classifying a SQLite
 * failure by its *message text* is forbidden (D-0016, D-0402). `ledger.ts` and
 * `routing.ts` therefore import `isSqliteError` / `sqliteCodeOf` from it.
 *
 * The allowance is one file, named here, not a pattern: `src/sqlite/open.ts` is
 * not on it (the ledger deliberately does not use the WAL-setting opener), and
 * neither is anything under `src/control_plane/`. Widening this to "the sqlite
 * package" or "anything the port needs" would give up the claim the case is
 * named for.
 */
const ALLOWED_FOREIGN_MODULES: readonly string[] = [
  resolve(REPO_ROOT, "src", "sqlite", "errors.js"),
];

/**
 * Files in the package that are not TypeScript and are not scanned.
 *
 * The source globs `*.py`, so `routing_ledger.sql` is outside its scan for
 * free. Spelling the exception out -- rather than filtering the listing by
 * extension -- is what keeps a future `.mjs` or `.json` in this package from
 * silently leaving the guard while it stays green over the rest.
 */
const NON_MODULE_FILES: readonly string[] = ["routing_ledger.sql"];

/** `(file name, parsed source)` for every module file in the canary package. */
function canaryModules(): readonly (readonly [string, ts.SourceFile])[] {
  const entries = readdirSync(PACKAGE_DIR)
    .filter((entry) => statSync(join(PACKAGE_DIR, entry)).isFile())
    .sort();
  if (entries.length === 0) {
    throw new Error(`the package walk found no files under ${PACKAGE_DIR}`);
  }
  const unreadable = entries.filter(
    (entry) => !entry.endsWith(".ts") && !NON_MODULE_FILES.includes(entry),
  );
  if (unreadable.length > 0) {
    throw new Error(
      `${unreadable.join(", ")} are in the canary package but are neither TypeScript nor ` +
        "declared non-module artifacts, so the import guard below would skip them; widen the " +
        "scan rather than the filter",
    );
  }
  return entries
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => {
      const text = readFileSync(join(PACKAGE_DIR, entry), "utf-8");
      return [entry, ts.createSourceFile(entry, text, ts.ScriptTarget.Latest, true)] as const;
    });
}

/**
 * The source's `_collapsed`, regex for regex.
 *
 * One or more leading `--`, `>` or `#` tokens per line, plus at most one
 * following space, then every whitespace run folded to a single space. That set
 * of three prefixes is why a wrapped SQL comment, a wrapped Markdown blockquote
 * and a wrapped Python comment all collapse to the same sentence. It does *not*
 * strip `*`, so the barrel carries the marking on one physical line; the reason
 * is written down at `src/canary/index.ts`'s own header rather than repaired
 * here, because loosening this reader would loosen it for every artifact.
 */
function collapsed(text: string): string {
  return text.replace(/^(?:--|>|#)+ ?/gmu, "").replace(/\s+/gu, " ");
}

describe("structural assertions: independence and labelling", () => {
  test("the routing layer imports no other continuo module", () => {
    for (const [name, source] of canaryModules()) {
      const foreign = [...importedModules(source, join(PACKAGE_DIR, name))]
        .filter((module) => module.startsWith(REPO_ROOT) && !module.startsWith(PACKAGE_DIR))
        .filter((module) => !ALLOWED_FOREIGN_MODULES.includes(module))
        .map((module) => module.slice(REPO_ROOT.length).split(sep).join("/"))
        .sort();

      expect(
        foreign,
        `${name} imports ${JSON.stringify(foreign)}; the routing layer sits above both systems ` +
          "and the provider, and depends on none of them",
      ).toEqual([]);
    }
  });

  test("the import guard itself catches the ways around it", () => {
    // A guard is only as good as what it would have caught, so the escape
    // routes are probed against the guard directly. The source probes three: a
    // relative import of a sibling package, an import inside a function, and one
    // behind TYPE_CHECKING. TypeScript splits the last of those in two -- a
    // type-only import is erased at emit, a dynamic import() is deferred to run
    // time -- and both are routes out of the package that a scan of the built
    // JavaScript, or of the top-level statements, would miss. So four.
    const probeDir = caseRoot("cnry-str");
    const probe = join(probeDir, "probe.ts");
    writeFileSync(
      probe,
      // Parsed, never loaded and never type-checked -- exactly as the source's
      // probe.py is never imported. That is what lets it name paths that do not
      // exist and climb out of a directory nothing else is in.
      'import type { Anything } from "../dispatcher/index.js";\n' +
        'import { schema } from "../../src/control_plane/schema.js";\n' +
        "export function late(): void {\n" +
        '  require("../session/index.js");\n' +
        "}\n" +
        "export async function later(): Promise<void> {\n" +
        '  await import("../measurement/index.js");\n' +
        "}\n",
      "utf-8",
    );

    const seen = importedModules(
      ts.createSourceFile("probe.ts", readFileSync(probe, "utf-8"), ts.ScriptTarget.Latest, true),
      probe,
    );

    expect(
      seen.has(resolve(probeDir, "../dispatcher/index.js")),
      "a type-only import is erased at emit and must still be seen",
    ).toBe(true);
    expect(
      seen.has(resolve(probeDir, "../../src/control_plane/schema.js")),
      "a relative specifier that climbs out of the package must resolve to the path it names",
    ).toBe(true);
    expect(
      seen.has(resolve(probeDir, "../session/index.js")),
      "a require() inside a function body must be reached by the walk",
    ).toBe(true);
    expect(
      seen.has(resolve(probeDir, "../measurement/index.js")),
      "a dynamic import() inside a function body must be reached by the walk",
    ).toBe(true);
  });

  test("every artifact carries the one marking sentence", () => {
    const artifacts = [
      join(PACKAGE_DIR, "routing_ledger.sql"),
      join(PACKAGE_DIR, "index.ts"),
      CONTRACT,
    ];
    for (const artifact of artifacts) {
      expect(
        collapsed(readFileSync(artifact, "utf-8")),
        `${artifact} does not carry the rehearsal marking verbatim`,
      ).toContain(REHEARSAL_MARKING);
    }
  });

  test("the marking makes all four claims", () => {
    // The four claims the design review requires on the evidence and the gate
    // record alike: synthetic counterparty, not a discharge, discharged at
    // the canary, Q-0005 open. Written out here rather than imported, or the
    // case would be a tautology a rewritten marking still satisfies.
    for (const claim of [
      "SYNTHETIC COUNTERPARTY",
      "NOT A DISCHARGE",
      "AT THE CANARY ITSELF",
      "Q-0005 REMAINS OPEN",
    ]) {
      expect(REHEARSAL_MARKING).toContain(claim);
    }
  });

  test("the written record leaves Q-0005 open", () => {
    const text = readFileSync(CONTRACT, "utf-8");
    expect(text).toContain("Q-0005");
    // The one number Q-0005 is about must not appear as a criterion; the
    // record must say the criteria are open rather than quietly supplying
    // any. (A textual assertion cannot prove absence of an invented number,
    // but it can hold the record to stating the openness explicitly.)
    expect(collapsed(text).toLowerCase()).toContain("remains open");
  });
});
