/**
 * Collection-time policy for the harness: lanes, profiles, budgets, seeds.
 *
 * Ported from interlock `tests/fault_injection/conftest.py` at `65f36c5`. The
 * source is a `conftest.py`, which pytest loads by convention; Vitest has no
 * such file, so the same policy is an ordinary module the case files import.
 * Nothing about what it decides changes -- only how it is reached.
 *
 * Design sections 8.1 (lanes) and 9 (the CI budget). Two things happen here and
 * nowhere else:
 *
 * - **What runs where is enumerable, never silent.** A case declares its lane in
 *   the manifest; a lane that cannot run on this OS produces a *skip with the
 *   lane named*, so "what did not run" is readable off the report.
 * - **The budgets are mechanical.** The per-case and suite watchdogs carry the
 *   profile's numbers, and a manifest whose case count exceeds the profile bound
 *   fails collection -- so growth in the matrix forces an explicit budget diff
 *   instead of silent CI creep.
 */

import process from "node:process";

import type { CaseAdapter, FaultCase } from "./contract.js";
import { ContractViolation, LANE_LINUX, LANE_PORTABLE } from "./contract.js";
import { loadManifest } from "./manifest.js";
import { SESSION_ADAPTER } from "./session_driver.js";
import { SPIKE_ADAPTER } from "./spike_driver.js";

/**
 * The environment variable a re-run supplies the suite seed through
 * (design 4.4). One suite seed per run; from CI it is fixed and recorded in the
 * run header, and a local run may pass any value.
 */
export const SUITE_SEED_ENV = "S9_SUITE_SEED";
export const PROFILE_ENV = "S9_PROFILE";

/**
 * A fixed default rather than a random one: an unreproducible default seed would
 * make every red build a new investigation.
 */
export const DEFAULT_SUITE_SEED = 20_260_820;

export function suiteSeed(): number {
  const raw = process.env[SUITE_SEED_ENV];
  return raw ? Number.parseInt(raw, 10) : DEFAULT_SUITE_SEED;
}

export function profileName(): string {
  return process.env[PROFILE_ENV] ?? "fast";
}

/**
 * The portable lane runs everywhere; the conformance lane is Linux only.
 *
 * macOS *would* run the signal cases, and deliberately does not: keeping the
 * conformance claim single-lane means a macOS scheduler flake can never block
 * the gate (design 8.1).
 */
export function activeLanes(): readonly string[] {
  if (process.platform === "linux") {
    return [LANE_PORTABLE, LANE_LINUX];
  }
  return [LANE_PORTABLE];
}

/**
 * The adapter registry (D-0601).
 *
 * Routing is manifest data (the `adapter` key, validated at collection);
 * resolving it is policy, and it lives here so the durable half never imports an
 * implementation module (`import-graph.test.ts`).
 */
export const CASE_ADAPTERS: ReadonlyMap<string, CaseAdapter> = new Map<string, CaseAdapter>([
  [SPIKE_ADAPTER.name, SPIKE_ADAPTER],
  [SESSION_ADAPTER.name, SESSION_ADAPTER],
]);

/**
 * Every adapter the conformance battery runs against (D-0601).
 *
 * A `FullFaultAdapter` is a battery *subject*; a `CaseAdapter` is only something
 * a manifest case may route to. The session adapter is deliberately not here:
 * it cannot pass the battery until the orchestrator it stands on is ported, and
 * listing it would turn a known absence into a red build that says nothing new.
 */
export const FULL_FAULT_ADAPTERS = [SPIKE_ADAPTER] as const;

/**
 * Resolve the adapter a manifest case declares.
 *
 * Refuses rather than returning `undefined`: an unknown adapter must surface at
 * collection, never as a spawn failure in CI, which is the same rule the
 * manifest's own validation states for the *name*. This is the other half --
 * the name resolving in the registry.
 */
export function adapterFor(faultCase: FaultCase): CaseAdapter {
  const name = faultCase["adapter"] as string;
  const adapter = CASE_ADAPTERS.get(name);
  if (adapter === undefined) {
    throw new ContractViolation(
      `${JSON.stringify(name)} is not a registered adapter; the registry holds ` +
        `${JSON.stringify([...CASE_ADAPTERS.keys()].sort())}`,
    );
  }
  return adapter;
}

/** The manifest, loaded and validated once per test file. */
export function manifest(): Record<string, unknown> {
  return loadManifest();
}

export function profile(loaded: Record<string, unknown>): Record<string, unknown> {
  const name = profileName();
  const profiles = loaded["profiles"] as Record<string, Record<string, unknown>>;
  if (!(name in profiles)) {
    throw new ContractViolation(
      `${PROFILE_ENV}=${JSON.stringify(name)} is not a manifest profile; choose one of ` +
        `${JSON.stringify(Object.keys(profiles).sort())}`,
    );
  }
  return { ...profiles[name], name };
}

/**
 * Every case this profile declares, on every lane.
 *
 * Lane selection is deliberately **not** applied here. Design section 8.1 asks
 * for a skip elsewhere, "so what does not run on an OS is enumerable, never
 * silent" -- and a case filtered out before parametrisation produces no test id
 * at all, which reads in a report exactly like a case that passed. Every profile
 * case therefore becomes a test item; the ones this OS cannot run skip with
 * their lane named.
 */
export function profileSelectedCases(): Record<string, unknown>[] {
  const loaded = loadManifest();
  const name = profileName();
  return (loaded["cases"] as Record<string, unknown>[]).filter((entry) =>
    (entry["profiles"] as string[]).includes(name),
  );
}

/** Why this OS does not run `faultCase`, or `null` if it does. */
export function laneSkipReason(faultCase: FaultCase): string | null {
  const lanes = activeLanes();
  const lane = faultCase["lane"] as string;
  if (lanes.includes(lane)) {
    return null;
  }
  return (
    `case is on the ${lane} lane; this host (${process.platform}) runs ${lanes.join("/")}. ` +
    "macOS would run the signal cases and deliberately does not: a single-lane conformance " +
    "claim means a macOS scheduler flake can never block the gate (design 8.1)"
  );
}

/**
 * The per-case watchdog a case's shape earns (design 9).
 *
 * A combination case -- more than one target, or a staggered kill -- gets the
 * longer budget, because it spawns and synchronises more processes.
 */
export function caseTimeoutS(faultCase: FaultCase, activeProfile: Record<string, unknown>): number {
  const combination =
    (faultCase["targets"] as string[]).length > 1 || faultCase["fault"] === "staggered-sigkill";
  const key = combination ? "combination_case_timeout_s" : "per_case_timeout_s";
  return Number(activeProfile[key]);
}
