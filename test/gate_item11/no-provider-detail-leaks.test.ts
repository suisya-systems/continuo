import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as ts from "typescript/unstable/ast";
import { expect, test } from "vitest";
import { parseSourceFile } from "../../scripts/lib/ts-ast.mjs";
import { SessionProvider } from "../../src/session/provider.js";
import { importedModules } from "../testkit/ast.js";
import { parametrize } from "../testkit/parametrize.js";
import { DEFAULT_PROVIDER, PROVIDERS, shippedProviders } from "./registry.js";

/**
 * Where provider knowledge is allowed to live, asserted structurally.
 *
 * Ported from interlock `tests/gate_item11/test_no_provider_detail_leaks.py`
 * at `65f36c5`.
 *
 * Item 11's residual in `docs/gate-record.md`: any test that has to be
 * modified to run against a second provider marks a leak of session-backend
 * detail into the control plane, and must be fixed before the item passes.
 * `substitution-scenarios.test.ts` measures the outcome across the two
 * providers this port ships; these tests pin the property that produces it,
 * so a leak introduced later fails the build on the day it is introduced.
 *
 * AST scanning is `test/testkit/ast.ts`'s `importedModules` (D-0504), shared
 * with `test/messagebus/import-graph.test.ts`, `test/canary/structural.test.ts`
 * and `test/secretary/structural.test.ts`. It resolves a relative specifier to
 * an absolute path rather than leaving it as written, so the two predicates
 * below compare paths, not dotted Python module names.
 *
 * **`src/index.ts` is an allowlisted exception to
 * `noShippedModuleKnowsBothAProviderAndTheControlPlane`.** It re-exports both
 * `./control_plane/*.js` and `./session/index.js` (which itself re-exports
 * both providers), because continuo ships one package entry point (D-0002).
 * See D-1001 for the falsifier that would end the exception: a subpath-exports
 * split that let a provider swap avoid touching this file's session half.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../../src/", import.meta.url));
const TEST_DIR = fileURLToPath(new URL("../", import.meta.url));
const CONTROL_PLANE_DIR = fileURLToPath(new URL("../../src/control_plane/", import.meta.url));
const CONTROL_PLANE_SUITE_DIR = fileURLToPath(new URL("../control_plane/", import.meta.url));
const SESSION_DIR = fileURLToPath(new URL("../../src/session/", import.meta.url));
const SESSION_CONTRACT = fileURLToPath(new URL("../../src/session/provider.js", import.meta.url));
const CONTROL_PLANE_PREFIX = resolve(SRC_DIR, "control_plane");

/** Non-`.ts` files under `src/control_plane/`, so the walk does not throw. */
const CONTROL_PLANE_NON_MODULE_FILES: readonly string[] = [
  "migrations/0001_initial.sql",
  "migrations/0002_policy_seed.sql",
  "migrations/0003_outbox_cancelled_status.sql",
  "migrations/0004_run_writer_epoch.sql",
  "spike_schema.sql",
];

/** Non-`.ts` files under `src/`, so the whole-package walk does not throw. */
const SRC_NON_MODULE_FILES: readonly string[] = [
  "canary/routing_ledger.sql",
  "control_plane/migrations/0001_initial.sql",
  "control_plane/migrations/0002_policy_seed.sql",
  "control_plane/migrations/0003_outbox_cancelled_status.sql",
  "control_plane/migrations/0004_run_writer_epoch.sql",
  "control_plane/spike_schema.sql",
  "fencing/cli_args_allow.json",
  "fencing/hook.mjs",
  "fencing/roles.json",
  "settings/role_configs_schema.json",
];

/** Non-`.ts` files under `test/`, so the whole-suite walk does not throw. */
const TEST_NON_MODULE_FILES: readonly string[] = [
  "fault_injection/driver-loader.mjs",
  "fault_injection/driver-register.mjs",
  "fault_injection/manifest.json",
  "fixtures/labelled/README.md",
  "fixtures/labelled/observation_unavailable/probe_outage_healthy_worker/expected.json",
  "fixtures/labelled/observation_unavailable/probe_outage_healthy_worker/trace.jsonl",
  "fixtures/labelled/relay_gap/escalation_received_never_presented/expected.json",
  "fixtures/labelled/relay_gap/escalation_received_never_presented/trace.jsonl",
  "fixtures/labelled/session_no_evidence/long_quiet_run_still_alive/expected.json",
  "fixtures/labelled/session_no_evidence/long_quiet_run_still_alive/trace.jsonl",
  "session/helpers/fake-claude.mjs",
];

/** `src/index.ts`'s allowlisted exception (D-1001). */
const ALLOWED_BARRELS: ReadonlySet<string> = new Set(["index.ts"]);

/** The two suite files item 11's own port keeps the join in (D-1001). */
const ALLOWED_BEYOND_FIXTURE: ReadonlySet<string> = new Set([
  "test/fault_injection/session_driver.ts",
  "test/gate_item2/mediated-real-provider.test.ts",
]);

/** Every file under `root`, recursively, as POSIX-style paths relative to it. */
function walk(root: string): readonly string[] {
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        visit(path, `${prefix}${entry}/`);
      } else {
        found.push(`${prefix}${entry}`);
      }
    }
  };
  visit(root, "");
  return found;
}

/**
 * Every `.ts` file under `root`, as a directory listing rather than a
 * hand-written list (the source's `rglob("*.py")`). A file that is neither
 * TypeScript nor declared in `nonModuleFiles` fails the walk rather than being
 * skipped, so an artifact this scan cannot read cannot also go unnoticed.
 */
function moduleFiles(root: string, nonModuleFiles: readonly string[]): readonly string[] {
  const all = walk(root);
  if (all.length === 0) {
    throw new Error(`the walk found no files under ${root}`);
  }
  const unreadable = all.filter(
    (entry) => !entry.endsWith(".ts") && !nonModuleFiles.includes(entry),
  );
  if (unreadable.length > 0) {
    throw new Error(
      `${unreadable.join(", ")} are under ${root} but are neither TypeScript nor declared ` +
        "non-module artifacts, so the guards below would skip them; widen the scan rather " +
        "than the filter",
    );
  }
  return all.filter((entry) => entry.endsWith(".ts")).sort();
}

function parseFile(root: string, name: string): ts.SourceFile {
  const path = join(root, name);
  return parseSourceFile(name, readFileSync(path, "utf8"));
}

/**
 * The port of the source's `_names_a_session_backend`, name for name. Used
 * where the source uses it: over the control-plane package and its suite,
 * with NO exception for the S1 contract module.
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

/**
 * The port of the source's `_knows_a_session_backend`: true when `imported`
 * reaches under `src/session/` at all, EXCLUDING the S1 contract module itself
 * (`session/provider.ts`) -- the join `src/supervisor.ts` is built on and
 * D-0009 accepts as a cost. Used only where the source uses it: over the
 * whole of `src/` and the whole of `test/`.
 */
function knowsASessionBackend(imported: ReadonlySet<string>): boolean {
  return [...imported].some((name) => name.startsWith(SESSION_DIR) && name !== SESSION_CONTRACT);
}

function knowsControlPlane(imported: ReadonlySet<string>): boolean {
  return [...imported].some(
    (name) => name === CONTROL_PLANE_PREFIX || name.startsWith(`${CONTROL_PLANE_PREFIX}/`),
  );
}

function readable(path: string): string {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length) : path;
}

const CONTROL_PLANE_MODULE_FILES = moduleFiles(CONTROL_PLANE_DIR, CONTROL_PLANE_NON_MODULE_FILES);
const CONTROL_PLANE_SUITE_FILES = moduleFiles(CONTROL_PLANE_SUITE_DIR, []);

parametrize(
  "no control plane module reaches a session backend",
  CONTROL_PLANE_MODULE_FILES.map((name) => [name, name] as const),
  (name) => {
    // The implementation half. Widened from `test/control_plane/lease.test.ts`
    // alone to the whole package (the source widens from S6 alone).
    const source = parseFile(CONTROL_PLANE_DIR, name);
    const leaks = [...importedModules(source, join(CONTROL_PLANE_DIR, name))]
      .filter(namesASessionBackend)
      .map(readable)
      .sort();
    expect(leaks, `${name} imports ${JSON.stringify(leaks)}`).toEqual([]);
  },
);

parametrize(
  "no control plane test reaches a session backend",
  CONTROL_PLANE_SUITE_FILES.map((name) => [name, name] as const),
  (name) => {
    // The suite half -- the one item 11 is actually about. A suite that
    // imports a provider is a suite that would need editing to run against
    // the next one, which is the modification the exit condition counts.
    const source = parseFile(CONTROL_PLANE_SUITE_DIR, name);
    const leaks = [...importedModules(source, join(CONTROL_PLANE_SUITE_DIR, name))]
      .filter(namesASessionBackend)
      .map(readable)
      .sort();
    expect(leaks, `${name} imports ${JSON.stringify(leaks)}`).toEqual([]);
  },
);

test("no shipped module knows both a provider and the control plane", () => {
  // What a provider swap costs, stated as a set of files. Nothing under
  // `src/` may import both a session backend and the control plane -- except
  // `src/index.ts`, allowlisted above (D-1001).
  const both: string[] = [];
  for (const name of moduleFiles(SRC_DIR, SRC_NON_MODULE_FILES)) {
    if (ALLOWED_BARRELS.has(name)) {
      continue;
    }
    const source = parseFile(SRC_DIR, name);
    const imported = importedModules(source, join(SRC_DIR, name));
    if (knowsASessionBackend(imported) && knowsControlPlane(imported)) {
      both.push(`src/${name}`);
    }
  }
  expect(both, `${JSON.stringify(both)} would have to be edited by a provider swap`).toEqual([]);
});

test("the translation is confined to this fixture package", () => {
  // And in the tests, the knowledge lives here (`test/gate_item11/`) and
  // nowhere else, except the two suite files the fault-injection and
  // mediated-real-provider proofs need (issue #18), allowlisted above.
  const outside: string[] = [];
  for (const name of moduleFiles(TEST_DIR, TEST_NON_MODULE_FILES)) {
    if (name.startsWith("gate_item11/")) {
      continue;
    }
    const source = parseFile(TEST_DIR, name);
    const imported = importedModules(source, join(TEST_DIR, name));
    if (knowsASessionBackend(imported) && knowsControlPlane(imported)) {
      const relative = `test/${name}`;
      if (!ALLOWED_BEYOND_FIXTURE.has(relative)) {
        outside.push(relative);
      }
    }
  }
  expect(
    outside,
    `${JSON.stringify(outside)} knows both vocabularies and is outside the fixture`,
  ).toEqual([]);
});

test("every shipped provider is registered", async () => {
  // The tripwire for the day a third provider lands: a provider that ships
  // without an entry silently narrows the measurement back to the ones
  // already known to pass.
  const registered = new Set(Object.values(PROVIDERS).map((entry) => entry.implementation));
  const shipped = await shippedProviders();
  const missing = [...shipped.entries()]
    .filter(([, cls]) => !registered.has(cls))
    .map(([name]) => name)
    .sort();
  expect(
    missing,
    `${JSON.stringify(missing)} implements SessionProvider but is not in ` +
      "test/gate_item11/registry.ts; add an entry so the control-plane suite is measured " +
      "against it too",
  ).toEqual([]);
});

test("the registry entries describe real implementations", () => {
  // A registry entry that names nothing is a measurement that ran on nothing.
  expect(Object.keys(PROVIDERS).length).toBeGreaterThan(0);
  expect(PROVIDERS[DEFAULT_PROVIDER]).toBeDefined();
  for (const [key, entry] of Object.entries(PROVIDERS)) {
    expect(key).toBe(entry.id);
    expect(
      (entry.implementation as { prototype?: unknown }).prototype instanceof SessionProvider,
    ).toBe(true);
    expect(entry.scaffold.trim()).not.toBe("");
    expect(entry.issue.startsWith("#")).toBe(true);
  }
});
