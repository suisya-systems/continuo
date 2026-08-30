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
 *
 * `fileParallelism: false` (D-1003, applied everywhere, not only on the
 * Windows cell `suite-runs-unchanged.test.ts` itself skips): this nested run's
 * 14 files run one at a time instead of concurrently, so it does not also
 * multiply the thread count it competes with the *outer* suite's own parallel
 * files for. Cheap and risk-free -- it can only lengthen this nested run's own
 * wall time, never widen what it measures -- but D-1003 treats it as a
 * supplement to `suite-runs-unchanged.test.ts`'s own Windows skip, not a
 * substitute for it: nothing here was measured to be sufficient alone against
 * a Windows CI runner already saturated by the outer suite's own worker pool,
 * and CI is the only place that contention is reproducible at all.
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

    // The one thing this config does borrow from the main one. Its `include`
    // covers `run-lifecycle.test.ts`, whose static assertions parse every
    // module under `src/`, and a standalone config inherits no `setupFiles` --
    // so without this line the nested run is the one place in the tree that
    // opens the compiler and never closes it. It adds no test and changes no
    // outcome, so it does not touch what this run measures.
    setupFiles: ["test/helpers/parser-lifecycle.ts"],
    passWithNoTests: false,
    retry: 0,
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    sequence: {
      concurrent: false,
    },
    isolate: true,
    fileParallelism: false,
    globalSetup: ["test/gate_item11/support/provider-plugin.ts"],
    reporters: ["json"],
    outputFile: report,
  },
});
