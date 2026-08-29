import { expect, test } from "vitest";

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
 * `substitution-scenarios.test.ts`: `[S3]` always runs, `[S2]` is skipped
 * wherever the real `claude` CLI is not on `PATH`.
 */

const S2 = PROVIDERS.S2 as ProviderEntry;
const S3 = PROVIDERS.S3 as ProviderEntry;

/** Generous headroom over the measured ~7s per subprocess run of `test/control_plane`. */
const CASE_TIMEOUT_MS = 900_000;

function outcomeIds(run: RunResult): string[] {
  return Object.keys(run.outcomes).sort();
}

function registerCases(entry: ProviderEntry): void {
  const unavailable = entry.unavailable();
  const t = skipIf(unavailable !== null, unavailable ?? "");

  t(
    `the suite passes with a provider bound [${entry.id}]`,
    async () => {
      const bound = await boundRun(entry.id);
      expect(failed(bound)).toEqual({});
      expect(bound.returncode, bound.stdout).toBe(0);
      const skipped = Object.entries(bound.outcomes)
        .filter(([, outcome]) => outcome.test === "skipped")
        .map(([id]) => id)
        .sort();
      expect(
        skipped,
        `${JSON.stringify(skipped)} was skipped under the bound provider; a test that cannot ` +
          "run against a provider is a leak to fix, not one to skip",
      ).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  t(
    `the bound run collects exactly the same tests [${entry.id}]`,
    async () => {
      const [unbound, bound] = await Promise.all([unboundRun(), boundRun(entry.id)]);
      expect(outcomeIds(bound)).toEqual(outcomeIds(unbound));
      expect(
        Object.keys(unbound.outcomes).length,
        "the unbound run collected nothing",
      ).toBeGreaterThan(0);
    },
    CASE_TIMEOUT_MS,
  );

  t(
    `every test reaches the same verdict either way [${entry.id}]`,
    async () => {
      const [unbound, bound] = await Promise.all([unboundRun(), boundRun(entry.id)]);
      expect(bound.outcomes).toEqual(unbound.outcomes);
    },
    CASE_TIMEOUT_MS,
  );

  t(
    `both runs read the same suite artifact [${entry.id}]`,
    async () => {
      const [unbound, bound] = await Promise.all([unboundRun(), boundRun(entry.id)]);
      expect(bound.artifact).toEqual(unbound.artifact);
      expect(
        Object.keys(bound.artifact).length,
        "no suite file was recorded, so nothing was compared",
      ).toBeGreaterThan(0);
    },
    CASE_TIMEOUT_MS,
  );

  t(
    `the bound run really had a provider live [${entry.id}]`,
    async () => {
      const bound = await boundRun(entry.id);
      expect(bound.stdout).toContain("gate item 11: control-plane suite bound to");
      expect(bound.stdout).toContain(entry.scaffold);
      expect(bound.stdout).toContain("live session");
    },
    CASE_TIMEOUT_MS,
  );

  t(
    `the bound provider drove the control plane before the suite ran [${entry.id}]`,
    async () => {
      const bound = await boundRun(entry.id);
      expect(bound.stdout).toContain("gate item 11: the provider drove the control plane");
      expect(bound.stdout).toContain("one effect delivered and acked");
    },
    CASE_TIMEOUT_MS,
  );
}

registerCases(S2);
registerCases(S3);

test(
  "the unbound run had no provider",
  async () => {
    const unbound = await unboundRun();
    expect(unbound.stdout).not.toContain("gate item 11: control-plane suite bound to");
  },
  CASE_TIMEOUT_MS,
);
