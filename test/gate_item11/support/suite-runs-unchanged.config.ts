import { defineConfig } from "vitest/config";

/**
 * The double-run config `suite-runs-unchanged.test.ts` spawns as a subprocess.
 *
 * Deliberately a config of its own, not `vitest.config.ts` reused with extra
 * flags: this measurement's whole point is "the same suite artifact, differing
 * only in the provider fixture" (source `test_suite_runs_unchanged.py`,
 * D-1002), and the two runs it drives already differ by the one variable that
 * matters -- whether `support/provider-plugin.ts`'s `globalSetup` finds
 * `CONTINUO_ITEM11_PROVIDER` in its environment. Reusing the main config's
 * `resolveSeed()` would add a second variable (an unset `CONTINUO_TEST_SEED`
 * throws there under CI, D-0005) that has nothing to do with item 11, so this
 * file has no seed logic and runs in collection order instead -- this
 * measurement compares outcomes and artifact digests, not order-sensitivity,
 * which is the main config's own job.
 *
 * `CONTINUO_ITEM11_REPORT` names where the JSON reporter writes; required, so
 * a run invoked without it fails loud rather than overwriting a stray default
 * file two concurrent runs might share.
 */

const REPORT_ENV = "CONTINUO_ITEM11_REPORT";

const report = process.env[REPORT_ENV];
if (report === undefined || report === "") {
  throw new Error(`${REPORT_ENV} must be set to a report output path.`);
}

export default defineConfig({
  test: {
    include: ["test/control_plane/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    retry: 0,
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    sequence: {
      concurrent: false,
    },
    isolate: true,
    globalSetup: ["test/gate_item11/support/provider-plugin.ts"],
    reporters: ["json"],
    outputFile: report,
  },
});
