import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { describe, expect, test } from "vitest";
import { parseSourceFile } from "../../scripts/lib/ts-ast.mjs";
import { importedModules } from "../testkit/ast.js";
import { caseRoot } from "../testkit/cases.js";
import { parametrize } from "../testkit/parametrize.js";

/**
 * interlock item 6's static assertion: no dependency edge from MessageBus to a
 * session backend.
 *
 * Ported from interlock `tests/messagebus/test_import_graph.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping and the deliberate
 * divergences are recorded in `parity/messagebus.import-graph.ledger.json`.
 *
 * interlock's `ACCEPTANCE.md` item 6, last clause: *statically assert the
 * MessageBus implementation has no dependency edge to the SessionProvider*,
 * enforced in CI so a later edge fails the build rather than being found at the
 * gate. This file is that assertion, and it runs in the ordinary suite -- which
 * `npm run verify` and the merge gate both run -- so its absence would itself be
 * visible.
 *
 * It follows the precedent of `test/canary/structural.test.ts` and
 * `test/secretary/structural.test.ts` in this repository, and of the source's
 * own `tests/control_plane/test_lease.py`: imports are read from the syntax
 * tree, never executed, so testing for the forbidden edge cannot create it.
 *
 * **This file asserts about the source tree, not about runtime behaviour**, so
 * it is the file in this belt most able to go green by losing its subject
 * (`docs/test-translation-conventions.md` section 10). Four defences, three of
 * them the source's own: the file set is a **directory listing** rather than a
 * hand-written list, a non-TypeScript file in either tree fails the walk rather
 * than being skipped, an empty walk throws, and the not-vacuous case below
 * demands that the package still contain its three modules and still reach the
 * control plane. The fourth is the target-only probe at the end, which asks
 * whether the scan sees the routes around itself.
 */

/** The messagebus package, as a directory. */
const PACKAGE_DIR = fileURLToPath(new URL("../../src/messagebus/", import.meta.url));

/** This suite, as a directory. */
const SUITE_DIR = fileURLToPath(new URL("./", import.meta.url));

/** The repository root, for reporting an import by a readable name. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The control plane, as the path an import of it resolves to. */
const CONTROL_PLANE_DIR = fileURLToPath(new URL("../../src/control_plane/", import.meta.url));

/**
 * The one suite file allowed to know the session vocabulary -- the stale readout
 * case must produce a genuinely stale readout to be about anything.
 */
const SESSION_AWARE_SUITE_FILES: readonly string[] = ["stale-readout.test.ts"];

/**
 * Files in either tree that are not TypeScript and are therefore not parsed.
 *
 * The source globs `*.py`, so a non-Python artifact is outside its scan for
 * free. Spelling the exception out -- rather than filtering the listing by
 * extension -- is what keeps a future `.mjs`, `.sql` or `.json` in these
 * directories from silently leaving the guard while it stays green
 * (`docs/test-translation-conventions.md` section 10, instance 3). Empty today,
 * on purpose: neither directory ships a data file.
 */
const NON_MODULE_FILES: readonly string[] = [];

/** Every file in `root`, recursively, as paths relative to it. */
function moduleFiles(root: string): readonly string[] {
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
  walk(root, "");
  if (found.length === 0) {
    throw new Error(`the walk found no files under ${root}`);
  }
  const unreadable = found.filter(
    (entry) => !entry.endsWith(".ts") && !NON_MODULE_FILES.includes(entry),
  );
  if (unreadable.length > 0) {
    throw new Error(
      `${unreadable.join(", ")} are under ${root} but are neither TypeScript nor declared ` +
        "non-module artifacts, so the guards below would skip them; widen the scan rather than " +
        "the filter",
    );
  }
  return found.filter((entry) => entry.endsWith(".ts"));
}

/** `(relative name, parsed source)` for one file. */
function parseFile(root: string, name: string): ts.SourceFile {
  const path = join(root, name);
  return parseSourceFile(name, readFileSync(path, "utf-8"));
}

/**
 * Every dynamic-import site in `source`, named by the primitive used.
 *
 * The port of the source's ban on `__import__` and `importlib`. Those two are
 * Python's ways of creating an edge no import statement records; TypeScript's
 * are `import(...)` and `require(...)`, and neither is resolvable by the static
 * scan above when its argument is computed. Rather than pretend to resolve a
 * dynamic string, this bans the primitives from the package outright -- a spike
 * delivery layer has no business importing anything it cannot name statically.
 */
function dynamicImportPrimitives(source: ts.SourceFile): readonly string[] {
  const offenders = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        offenders.add("import()");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        offenders.add("require()");
      }
    } else if (
      ts.isIdentifier(node) &&
      (node.text === "require" || node.text === "createRequire")
    ) {
      // The name alone, not only the call: `const r = require; r("x")` and
      // `createRequire(import.meta.url)` both build the same edge one step away
      // from a call this scan would recognise.
      offenders.add(node.text);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return [...offenders].sort();
}

/**
 * Whether an imported module names a session backend.
 *
 * The port of the source's `_names_a_session_backend`, name for name. The
 * segments of a resolved path play the role of a dotted module name's parts, so
 * a path is split on both separators as well as on `.` and `:` -- the latter two
 * so that `node:worker_threads` and a `foo.session.js` spelling are decomposed
 * the way `claude_org_runtime.session` is.
 */
function namesASessionBackend(imported: string): boolean {
  const parts = imported.split(/[/\\.:]/);
  return (
    parts.includes("session") ||
    parts.includes("provider") ||
    parts.includes("stub_provider") ||
    parts.includes("claude_cli_provider")
  );
}

/** An import, named relative to the repository root for the message. */
function readable(module: string): string {
  return module.startsWith(REPO_ROOT)
    ? module.slice(REPO_ROOT.length).split(sep).join("/")
    : module;
}

const PACKAGE_FILES = moduleFiles(PACKAGE_DIR);
const SUITE_FILES = moduleFiles(SUITE_DIR);

describe("item 6's static assertion: the delivery layer has no session edge", () => {
  parametrize(
    "no messagebus module reaches a session backend",
    PACKAGE_FILES.map((name) => [name, name] as const),
    (name) => {
      // The edge item 6 forbids, checked file by file.
      //
      // An implementation with no edge to the SessionProvider cannot be
      // invalidated by replacing it -- the reason interlock Issue #19 survives
      // C2 unchanged, asserted rather than argued.
      const source = parseFile(PACKAGE_DIR, name);
      const leaks = [...importedModules(source, join(PACKAGE_DIR, name))]
        .filter(namesASessionBackend)
        .map(readable)
        .sort();
      expect(
        leaks,
        `${name} imports ${JSON.stringify(leaks)}; the MessageBus must take no dependency edge ` +
          "to a session backend (interlock ACCEPTANCE.md item 6, interlock D-0009)",
      ).toEqual([]);
    },
  );

  test("the assertion is not vacuous", () => {
    // A guard that guards nothing would pass forever.
    //
    // The package must exist, contain the bus and its endpoint, and demonstrably
    // import the control plane -- so an empty directory, a renamed package, or a
    // scan rooted at the wrong path fails here instead of passing everything
    // above.
    const files = new Set(PACKAGE_FILES);
    for (const required of ["index.ts", "bus.ts", "endpoint.ts"]) {
      expect(files.has(required), `the messagebus package has no ${required}`).toBe(true);
    }
    const importsControlPlane = PACKAGE_FILES.some((name) =>
      [...importedModules(parseFile(PACKAGE_DIR, name), join(PACKAGE_DIR, name))].some((module) =>
        module.startsWith(CONTROL_PLANE_DIR),
      ),
    );
    expect(
      importsControlPlane,
      "the MessageBus package no longer imports the control plane; this import-graph test is " +
        "probably scanning the wrong tree",
    ).toBe(true);
  });

  parametrize(
    "session knowledge in this suite stays in the stale-readout case",
    SUITE_FILES.map((name) => [name, name] as const),
    (name) => {
      // The suite-side confinement, mirroring interlock item 11's.
      //
      // One file must know the session vocabulary to make a readout go stale;
      // every other file here must not, so that the suite as a whole stays
      // runnable -- and meaningful -- against a control plane with no session
      // backend installed at all.
      if (SESSION_AWARE_SUITE_FILES.includes(name)) {
        return;
      }
      const source = parseFile(SUITE_DIR, name);
      const leaks = [...importedModules(source, join(SUITE_DIR, name))]
        .filter(namesASessionBackend)
        .map(readable)
        .sort();
      expect(
        leaks,
        `${name} imports ${JSON.stringify(leaks)}; only ` +
          `${JSON.stringify([...SESSION_AWARE_SUITE_FILES].sort())} may know the session ` +
          "vocabulary in this suite",
      ).toEqual([]);
    },
  );

  parametrize(
    "no messagebus module imports dynamically",
    PACKAGE_FILES.map((name) => [name, name] as const),
    (name) => {
      // The evasion route the static scan cannot follow, closed separately.
      const offenders = dynamicImportPrimitives(parseFile(PACKAGE_DIR, name));
      expect(
        offenders,
        `${name} uses ${JSON.stringify(offenders)}; dynamic imports would evade the no-edge ` +
          "assertion above and are banned from this package",
      ).toEqual([]);
    },
  );

  test("the stale-readout case does not import the control plane", () => {
    // The other half of the split `_env.ts` documents.
    //
    // The session-aware file reaches the control plane only through the suite's
    // helpers, so no single file in this suite knows both vocabularies -- the
    // same property interlock's `tests/gate_item11` pins for the rest of the
    // tree.
    for (const name of SESSION_AWARE_SUITE_FILES) {
      const imported = importedModules(parseFile(SUITE_DIR, name), join(SUITE_DIR, name));
      const leaks = [...imported]
        .filter((module) => module.startsWith(CONTROL_PLANE_DIR))
        .map(readable)
        .sort();
      expect(leaks, `${name} imports ${JSON.stringify(leaks)}`).toEqual([]);
    }
  });

  test("target-only -- the scan sees the routes around it", () => {
    // A guard is only as good as what it would have caught. The source's own
    // import-graph file has no probe case, so this is target-only: it defends
    // the scanning machinery the port had to write, not a property of the
    // source.
    const probeDir = caseRoot("mb-graph");
    const probe = join(probeDir, "probe.ts");
    writeFileSync(
      probe,
      // Parsed, never loaded and never type-checked, which is what lets it name
      // paths that do not exist and climb out of a directory nothing else is in.
      'import type { Anything } from "../session/index.js";\n' +
        'import { LocalProcessSessionProvider } from "../../src/session/stub_provider.js";\n' +
        'export { MessageBus } from "../control_plane/outbox.js";\n' +
        "export function late(): void {\n" +
        '  require("../session/provider.js");\n' +
        "}\n" +
        "export async function later(): Promise<void> {\n" +
        '  await import("../session/claude_cli_provider.js");\n' +
        "}\n",
      "utf-8",
    );
    const parsed = parseSourceFile("probe.ts", readFileSync(probe, "utf-8"));

    const seen = importedModules(parsed, probe);
    expect(
      seen.has(resolve(probeDir, "../session/index.js")),
      "a type-only import is erased at emit and must still be seen",
    ).toBe(true);
    expect(
      seen.has(resolve(probeDir, "../control_plane/outbox.js")),
      "an `export ... from` is a dependency edge and must be seen",
    ).toBe(true);
    expect(
      seen.has(resolve(probeDir, "../session/provider.js")),
      "a require() inside a function body must be reached by the walk",
    ).toBe(true);
    expect(
      seen.has(resolve(probeDir, "../session/claude_cli_provider.js")),
      "a dynamic import() inside a function body must be reached by the walk",
    ).toBe(true);

    const flagged = [...seen].filter(namesASessionBackend).map(readable).sort();
    expect(
      flagged.length,
      "every one of the four session routes above must be judged a session edge",
    ).toBe(4);

    expect(
      dynamicImportPrimitives(parsed),
      "both dynamic-import primitives must be reported, by call site and by bare name",
    ).toEqual(["import()", "require", "require()"]);
  });
});
