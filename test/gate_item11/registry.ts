import { spawnSync } from "node:child_process";

import { ClaudeCliSessionProvider } from "../../src/session/claude_cli_provider.js";
import { SessionProvider, type SessionReadout } from "../../src/session/provider.js";
import { LocalProcessSessionProvider } from "../../src/session/stub_provider.js";

/**
 * The provider registry gate item 11's measurement is parameterised over.
 *
 * Ported from interlock `tests/gate_item11/registry.py` at `65f36c5`.
 *
 * Gate item 11 (`ACCEPTANCE.md` section 1, issue `#20`) claims that even if the
 * session backend does not hold, only the `SessionProvider` need be swapped.
 * This module is that fixture's whole variable half: one entry per shipped
 * `SessionProvider` implementation, discovered rather than listed so that a
 * provider shipping without an entry here fails a test (see
 * {@link shippedProviders}) instead of quietly narrowing the measurement.
 */

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<Record<string, unknown>>>;
  }
}

/** A provider constructor: `SessionProvider`'s own concrete subclasses. */
export type SessionProviderClass = abstract new (...args: never[]) => SessionProvider;

/** One provider the control-plane suite can be run against. */
export interface ProviderEntry {
  readonly id: string;
  readonly scaffold: string;
  readonly issue: string;
  readonly implementation: SessionProviderClass;
  /** Builds a ready-to-use provider rooted at a directory the caller owns. */
  readonly factory: (stateRoot: string) => SessionProvider;
  /** Why this environment cannot run this provider, or `null` when it can. */
  readonly unavailable: () => string | null;
  /** Why the bound session's readout proves the backend was not live, or `null`. */
  readonly disqualified: (readout: SessionReadout) => string | null;
}

function alwaysAvailable(): string | null {
  return null;
}

function neverDisqualified(): string | null {
  return null;
}

function stub(stateRoot: string): SessionProvider {
  return new LocalProcessSessionProvider(stateRoot);
}

function claudeCli(stateRoot: string): SessionProvider {
  // `["--model", "haiku"]`, exactly as the source pins the measurement's live
  // sessions to the cheapest model tier: provider-wide spawn configuration,
  // never a per-role setting.
  return new ClaudeCliSessionProvider(stateRoot, { baseCliArgs: ["--model", "haiku"] });
}

/**
 * `shutil.which(command)`: is `command` on `PATH`, resolvable and runnable.
 *
 * Node has no direct equivalent, so this asks the platform's own resolver
 * (`where` on Windows, `command -v` everywhere else) rather than re-deriving
 * `PATH` search and executable-bit semantics by hand.
 */
function which(command: string): boolean {
  const probe =
    process.platform === "win32"
      ? spawnSync("where", [command])
      : spawnSync("command", ["-v", command], { shell: "/bin/sh" });
  return probe.status === 0;
}

function claudeCliUnavailable(): string | null {
  if (!which("claude")) {
    return (
      "the claude CLI is not on PATH; the C2 provider (S2, issue #17) spawns real " +
      "`claude -p` children and cannot run here"
    );
  }
  return null;
}

/**
 * A child that died without ever producing structured output.
 *
 * `exited-<rc>` is S2's word for exactly that case: no init event, no result,
 * only an exit disposition -- which is what a present-but-broken install
 * produces, with the actual refusal on stderr. Such a backend must abort the
 * measurement (D-0010) rather than green a run whose header claims a live
 * backend.
 */
function claudeCliDisqualified(readout: SessionReadout): string | null {
  const state = readout.providerState ?? "";
  if (state.startsWith("exited-")) {
    const stderrTail = readout.providerDetail["stderr_tail"];
    return (
      `the bound session's child died without producing structured output ` +
      `(state ${JSON.stringify(state)}); its stderr: ${JSON.stringify(String(stderrTail ?? ""))}`
    );
  }
  return null;
}

/** Every provider the measurement runs against, keyed by its registry handle. */
export const PROVIDERS: Readonly<Record<string, ProviderEntry>> = Object.freeze({
  S2: Object.freeze({
    id: "S2",
    scaffold: "S2 -- the C2 provider over Interlock-supervised claude -p subprocesses",
    issue: "#17",
    implementation: ClaudeCliSessionProvider,
    factory: claudeCli,
    unavailable: claudeCliUnavailable,
    disqualified: claudeCliDisqualified,
  }),
  S3: Object.freeze({
    id: "S3",
    scaffold: "S3 -- the stub provider over local child processes",
    issue: "#11",
    implementation: LocalProcessSessionProvider,
    factory: stub,
    unavailable: alwaysAvailable,
    disqualified: neverDisqualified,
  }),
});

/** The provider bound when nothing names one: S3, which needs no live CLI. */
export const DEFAULT_PROVIDER = "S3";

/**
 * Every concrete `SessionProvider` in `src/session/`, discovered rather than
 * listed.
 *
 * `pkgutil.iter_modules` plus `inspect.getmembers` in the source; ESM cannot
 * import a specifier computed at runtime, so this is `import.meta.glob`
 * (D-0114's precedent, `test/measurement/module-scan.ts`), which Vite expands
 * at transform time from the same directory listing. `SessionProvider` itself
 * is excluded; nothing else under `src/session/` is abstract at runtime
 * (TypeScript's `abstract` is erased before anything runs), so no further
 * filter is needed here.
 */
export async function shippedProviders(): Promise<ReadonlyMap<string, SessionProviderClass>> {
  const loaders = import.meta.glob("../../src/session/*.ts");
  const found = new Map<string, SessionProviderClass>();
  for (const [path, load] of Object.entries(loaders)) {
    const namespace = await load();
    for (const [name, candidate] of Object.entries(namespace)) {
      if (
        typeof candidate === "function" &&
        candidate !== SessionProvider &&
        (candidate as { prototype?: unknown }).prototype instanceof SessionProvider
      ) {
        found.set(`${path}#${name}`, candidate as SessionProviderClass);
      }
    }
  }
  return found;
}
