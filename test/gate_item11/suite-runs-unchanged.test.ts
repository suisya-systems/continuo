import { expect } from "vitest";

import { skipIf } from "../testkit/marks.js";
import { PROVIDERS, type ProviderEntry } from "./registry.js";
import { boundRun, failed, type RunResult, unboundRun } from "./support/run.js";

/**
 * Item 11, measured: the control-plane suite, run twice, differing only in
 * the provider fixture.
 *
 * Ported from interlock `tests/gate_item11/test_suite_runs_unchanged.py` at
 * `65f36c5` (D-1002, the belt's declared follow-on named in D-1001).
 *
 * `ACCEPTANCE.md` section 1 item 11 and issue `#20`:
 *
 * > Even if the provider does not hold, only the `SessionProvider` need be
 * > swapped -- demonstrated, not argued. Zero test modifications required.
 *
 * The demonstration is two subprocess runs of the *same* suite
 * (`test/control_plane`): one plain, one with `support/provider-plugin.ts`'s
 * `globalSetup` binding a live provider first. `support/run.ts` drives both
 * and turns vitest's own `--reporter=json` output into the comparison this
 * file makes: collected ids, per-test and per-file outcomes, and the SHA-256
 * of every file each run actually collected from. Anything that had to
 * change for the bound run to pass shows up as a difference in one of those.
 *
 * **Why subprocesses.** A provider bound inside this process would be bound
 * after `test/control_plane`'s suite had already run in the same worker, so
 * "the suite ran while a backend was live" would be a claim about ordering
 * rather than a fact about the run. Two processes make it a fact.
 *
 * **Why the binding is qualified first.** `provider-plugin.ts` drives a full
 * round trip -- readout to binding to fenced write to acked delivery --
 * before the suite starts, and aborts the run if it cannot (D-0010). The
 * suite is then compared under a provider already shown to work with the
 * control plane it is being run against.
 *
 * Parameterised over `registry.PROVIDERS`, the same as
 * `substitution-scenarios.test.ts`: each case is written out once per
 * provider with a literal title (`[S2]` runs behind `skipIf`, `[S3]` and the
 * unbound case run behind `skipIf(WINDOWS, ...)`, all effectively
 * unconditional off Windows) rather than built from an interpolated
 * template. `vitest list` *and* `scripts/parity-check.mjs`'s own
 * `declaresTitle` sweep both need the exact collected title to appear
 * verbatim in this file's source text -- the `conditionally_collected`
 * fallback (used on any host where a case is skipped and so never collected
 * at all) greps for the literal quoted string, and a template-interpolated
 * title would not contain it.
 *
 * **The Windows skip (D-1003).** Every case in this file is also gated on
 * `!WINDOWS`. This is a platform capability gate, the same shape as `[S2]`'s
 * `claude`-CLI-on-`PATH` gate, not a narrowing of what item 11 claims: the
 * property under test (no provider detail leaks into the control plane, the
 * control-plane suite runs unmodified against either provider) is a fact
 * about this repository's source and behaviour, not about the operating
 * system running it, and the double-run's absence from the Windows cell does
 * not weaken it there -- `no-provider-detail-leaks.test.ts`'s static AST scan
 * runs on every OS unmodified, and `test/control_plane`'s own 605 cases run
 * (and must pass) on Windows every time as part of the ordinary suite. What
 * the skip gives up is narrower than that: literal re-confirmation, via this
 * specific subprocess double-run, that swapping providers costs nothing
 * *on Windows specifically*. See D-1003 for the measurement that justifies
 * the gate, and its falsifier for when it should be revisited.
 */

const WINDOWS = process.platform === "win32";

/**
 * Why the Windows cell skips this file's cases, spelled out once and reused
 * by every `[S3]`/unbound case's `skipIf` (the `[S2]` cases fold this into
 * their own combined reason below). See D-1003 -- this is not a coverage gap
 * this belt is silently accepting, it is a platform capability gate recorded
 * there with a falsifier.
 */
const WINDOWS_SKIP_REASON =
  "D-1003: this file's subprocess double-run of the whole of test/control_plane " +
  "oversubscribes Windows CI runners' CPU under contention with the outer suite's own " +
  "parallel files; the property is OS-independent and is otherwise covered on Windows by " +
  "no-provider-detail-leaks.test.ts's static scan and by test/control_plane's own normal run";

const S2 = PROVIDERS.S2 as ProviderEntry;
const S3 = PROVIDERS.S3 as ProviderEntry;
const S2_UNAVAILABLE = S2.unavailable();
const S2_SKIP = WINDOWS || S2_UNAVAILABLE !== null;
const S2_SKIP_REASON = WINDOWS ? WINDOWS_SKIP_REASON : (S2_UNAVAILABLE ?? "");

/** Generous headroom over the measured ~7s per subprocess run of `test/control_plane`. */
const CASE_TIMEOUT_MS = 900_000;

function outcomeIds(run: RunResult): string[] {
  return Object.keys(run.outcomes).sort();
}

async function theSuitePassesWithAProviderBound(entry: ProviderEntry): Promise<void> {
  const bound = await boundRun(entry.id);
  expect(failed(bound)).toEqual({});
  expect(bound.returncode, bound.stdout).toBe(0);
  const skipped = Object.entries(bound.outcomes)
    .filter(([, outcome]) => outcome.test === "skipped")
    .map(([id]) => id)
    .sort();
  expect(
    skipped,
    `${JSON.stringify(skipped)} was skipped under the bound provider; a test that cannot run ` +
      "against a provider is a leak to fix, not one to skip",
  ).toEqual([]);
}

skipIf(S2_SKIP, S2_SKIP_REASON)(
  "the suite passes with a provider bound [S2]",
  async () => {
    await theSuitePassesWithAProviderBound(S2);
  },
  CASE_TIMEOUT_MS,
);
skipIf(WINDOWS, WINDOWS_SKIP_REASON)(
  "the suite passes with a provider bound [S3]",
  async () => {
    await theSuitePassesWithAProviderBound(S3);
  },
  CASE_TIMEOUT_MS,
);

async function theBoundRunCollectsExactlyTheSameTests(entry: ProviderEntry): Promise<void> {
  const [unbound, bound] = await Promise.all([unboundRun(), boundRun(entry.id)]);
  expect(outcomeIds(bound)).toEqual(outcomeIds(unbound));
  expect(Object.keys(unbound.outcomes).length, "the unbound run collected nothing").toBeGreaterThan(
    0,
  );
}

skipIf(S2_SKIP, S2_SKIP_REASON)(
  "the bound run collects exactly the same tests [S2]",
  async () => {
    await theBoundRunCollectsExactlyTheSameTests(S2);
  },
  CASE_TIMEOUT_MS,
);
skipIf(WINDOWS, WINDOWS_SKIP_REASON)(
  "the bound run collects exactly the same tests [S3]",
  async () => {
    await theBoundRunCollectsExactlyTheSameTests(S3);
  },
  CASE_TIMEOUT_MS,
);

async function everyTestReachesTheSameVerdictEitherWay(entry: ProviderEntry): Promise<void> {
  const [unbound, bound] = await Promise.all([unboundRun(), boundRun(entry.id)]);
  expect(bound.outcomes).toEqual(unbound.outcomes);
}

skipIf(S2_SKIP, S2_SKIP_REASON)(
  "every test reaches the same verdict either way [S2]",
  async () => {
    await everyTestReachesTheSameVerdictEitherWay(S2);
  },
  CASE_TIMEOUT_MS,
);
skipIf(WINDOWS, WINDOWS_SKIP_REASON)(
  "every test reaches the same verdict either way [S3]",
  async () => {
    await everyTestReachesTheSameVerdictEitherWay(S3);
  },
  CASE_TIMEOUT_MS,
);

async function bothRunsReadTheSameSuiteArtifact(entry: ProviderEntry): Promise<void> {
  const [unbound, bound] = await Promise.all([unboundRun(), boundRun(entry.id)]);
  expect(bound.artifact).toEqual(unbound.artifact);
  expect(
    Object.keys(bound.artifact).length,
    "no suite file was recorded, so nothing was compared",
  ).toBeGreaterThan(0);
}

skipIf(S2_SKIP, S2_SKIP_REASON)(
  "both runs read the same suite artifact [S2]",
  async () => {
    await bothRunsReadTheSameSuiteArtifact(S2);
  },
  CASE_TIMEOUT_MS,
);
skipIf(WINDOWS, WINDOWS_SKIP_REASON)(
  "both runs read the same suite artifact [S3]",
  async () => {
    await bothRunsReadTheSameSuiteArtifact(S3);
  },
  CASE_TIMEOUT_MS,
);

async function theBoundRunReallyHadAProviderLive(entry: ProviderEntry): Promise<void> {
  const bound = await boundRun(entry.id);
  expect(bound.stdout).toContain("gate item 11: control-plane suite bound to");
  expect(bound.stdout).toContain(entry.scaffold);
  expect(bound.stdout).toContain("live session");
}

skipIf(S2_SKIP, S2_SKIP_REASON)(
  "the bound run really had a provider live [S2]",
  async () => {
    await theBoundRunReallyHadAProviderLive(S2);
  },
  CASE_TIMEOUT_MS,
);
skipIf(WINDOWS, WINDOWS_SKIP_REASON)(
  "the bound run really had a provider live [S3]",
  async () => {
    await theBoundRunReallyHadAProviderLive(S3);
  },
  CASE_TIMEOUT_MS,
);

async function theBoundProviderDroveTheControlPlaneBeforeTheSuiteRan(
  entry: ProviderEntry,
): Promise<void> {
  const bound = await boundRun(entry.id);
  expect(bound.stdout).toContain("gate item 11: the provider drove the control plane");
  expect(bound.stdout).toContain("one effect delivered and acked");
}

skipIf(S2_SKIP, S2_SKIP_REASON)(
  "the bound provider drove the control plane before the suite ran [S2]",
  async () => {
    await theBoundProviderDroveTheControlPlaneBeforeTheSuiteRan(S2);
  },
  CASE_TIMEOUT_MS,
);
skipIf(WINDOWS, WINDOWS_SKIP_REASON)(
  "the bound provider drove the control plane before the suite ran [S3]",
  async () => {
    await theBoundProviderDroveTheControlPlaneBeforeTheSuiteRan(S3);
  },
  CASE_TIMEOUT_MS,
);

skipIf(WINDOWS, WINDOWS_SKIP_REASON)(
  "the unbound run had no provider",
  async () => {
    const unbound = await unboundRun();
    expect(unbound.stdout).not.toContain("gate item 11: control-plane suite bound to");
  },
  CASE_TIMEOUT_MS,
);
