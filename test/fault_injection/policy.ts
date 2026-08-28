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

import { afterAll, beforeAll } from "vitest";

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

/**
 * Largest suite seed accepted. Keeps the value exactly representable.
 *
 * The same bound `vitest.config.ts` puts on `CONTINUO_TEST_SEED`, and for the
 * same reason.
 */
const SUITE_SEED_MAX = Number.MAX_SAFE_INTEGER;

/**
 * The run's suite seed, refused rather than repaired if it is not exactly what
 * was asked for.
 *
 * The source is `int(raw) if raw else DEFAULT`, and Python's `int` is both
 * strict (it raises on trailing characters) and arbitrary-precision (it never
 * rounds). `Number.parseInt` is neither: it returns 123 for `"123x"` and rounds
 * 9007199254740993 to ...992. Either behaviour SILENTLY CHANGES THE SEED, and
 * the seed is the whole of the reproducibility claim -- a re-run with the seed
 * printed in the `S9-REPRO` line would then derive different per-case streams
 * from the ones that failed, and two distinct requested seeds could collapse
 * onto one. Design 4.4 rests on exactly this not happening.
 *
 * So the whole value is validated and a value that cannot be represented
 * exactly is refused with the reason. This is marginally STRICTER than the
 * source on inputs Python's `int` would accept and this does not -- surrounding
 * whitespace, digit underscores, a value past 2**53 -- and that is the
 * deliberate trade: refusing loudly is a message the operator can act on, while
 * a quietly rounded seed is a re-run that cannot be compared and says nothing
 * about why. It also matches the bound this repository already puts on its own
 * runner seed (`vitest.config.ts`), so the two seeds a run carries are governed
 * by one rule rather than two. Raised by the review gate on this change.
 */
export function suiteSeed(): number {
  const raw = process.env[SUITE_SEED_ENV];
  if (raw === undefined || raw === "") {
    return DEFAULT_SUITE_SEED;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ContractViolation(
      `${SUITE_SEED_ENV} must be a non-negative integer, got ${JSON.stringify(raw)}; a seed that ` +
        "is silently repaired is a re-run that cannot be compared (design 4.4)",
    );
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed > SUITE_SEED_MAX) {
    throw new ContractViolation(
      `${SUITE_SEED_ENV} must be a non-negative integer <= ${SUITE_SEED_MAX}, got ${raw}; past ` +
        "that bound the value cannot be held exactly and the per-case digest would be derived " +
        "from a different number than the one that was asked for (design 4.4)",
    );
  }
  return seed;
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
 * The suite budget (design 9), installed by each of the belt's test files.
 *
 * The outermost of the three budgets, and it is a BUDGET CHECK rather than a
 * hang detector -- deliberately, and the source says why: a hang is caught by
 * the per-barrier and per-case deadlines inside the controller, which run on
 * host monotonic time and convert a wedged case into an attributable failure
 * with its trace attached. This one exists so that *growth* -- a matrix that
 * creeps past its runtime allowance without ever hanging -- becomes an explicit
 * budget diff instead of silent CI creep.
 *
 * **The port's watchdog is per FILE where the source's is per PACKAGE, and that
 * is a real narrowing.** The source hooks pytest's report stream and accumulates
 * the durations of every test whose node id starts with `tests/fault_injection`,
 * across the whole session, then fails once at session teardown. Vitest runs
 * each test file in its own worker (`isolate: true`, vitest.config.ts), so there
 * is no in-process place where the belt's five files can be summed; doing it
 * anyway would mean a side channel on disk keyed by something stable across
 * workers, and a racy or stale-prone budget checker inside a harness whose whole
 * point is determinism is a worse trade than a narrower one. Aggregating
 * properly needs a custom reporter in `vitest.config.ts`, which is shared by
 * every lane and is not one belt's to change.
 *
 * So: each file is charged its own wall time and fails if THAT exceeds the
 * profile's `suite_timeout_s`. What it catches is what the budget is for -- one
 * file's runtime growing without bound. What it misses is the belt's total
 * creeping past the budget while no single file does. Recorded in
 * `parity/fault-injection.cases.ledger.json`. Raised by the review gate on this
 * change, which found the budget was being read from the manifest and never
 * enforced at all.
 *
 * Wall time rather than summed per-test durations, which is the other small
 * divergence: it additionally charges the file's imports and hooks, so it is
 * marginally stricter than the source, never looser.
 */
export function installSuiteBudget(activeProfile: Record<string, unknown>): void {
  const budgetS = Number(activeProfile["suite_timeout_s"]);
  let startedAtMs = 0;
  beforeAll(() => {
    startedAtMs = performance.now();
  });
  afterAll(() => {
    const elapsedS = (performance.now() - startedAtMs) / 1000;
    if (elapsedS > budgetS) {
      throw new ContractViolation(
        `the ${String(activeProfile["name"])} profile spent ${elapsedS.toFixed(0)}s in this ` +
          `fault-injection file, over its ${budgetS.toFixed(0)}s suite budget (design 9): ` +
          "prune the matrix or raise the budget in an explicit diff",
      );
    }
  });
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
