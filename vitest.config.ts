import { defineConfig } from "vitest/config";

/**
 * Test runner configuration.
 *
 * Two properties here are load-bearing for CI and are deliberately NOT
 * expressible as CLI flags (D-0001, D-0005):
 *
 *  1. Random ordering is enabled *in this file*, so it cannot be silently
 *     dropped by an edit to a CI script or a local `vitest run` invocation.
 *     CI injects only the seed.
 *  2. The seed is required in CI. A run with an unrecorded seed is a run that
 *     cannot be replayed, which makes an order-dependent failure unactionable,
 *     so an unset seed under CI is a hard error rather than a silent default.
 */

/** Environment variable carrying the explicit RNG seed. */
const SEED_ENV = "CONTINUO_TEST_SEED";

/** Largest seed accepted. Keeps the value printable and shell-safe. */
const SEED_MAX = 2_147_483_647;

function resolveSeed(): number {
  const raw = process.env[SEED_ENV];
  const inCI = process.env["CI"] !== undefined && process.env["CI"] !== "";

  if (raw === undefined || raw === "") {
    if (inCI) {
      throw new Error(
        `${SEED_ENV} is not set. Continuo's CI runs the suite twice per matrix ` +
          `cell with two distinct explicit seeds (the double-green rule, ` +
          `DECISIONS.md D-0005); an implicit seed cannot be replayed. Set ` +
          `${SEED_ENV} to a non-negative integer.`,
      );
    }
    // Local default. Vitest's own default seed is also time-derived; the point
    // of computing it here is that the value is printed below, so a local
    // ordering failure is replayable from the terminal scrollback.
    return Date.now() % SEED_MAX;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${SEED_ENV} must be a non-negative integer, got ${JSON.stringify(raw)}.`);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed > SEED_MAX) {
    throw new Error(`${SEED_ENV} must be a non-negative integer <= ${SEED_MAX}, got ${raw}.`);
  }
  return seed;
}

const seed = resolveSeed();

// Printed on success as well as failure: the seed of a *green* run is what a
// later bisect needs in order to reproduce the order that was green.
// ASCII-only -- this line is emitted on the Windows cell too
// (docs/cli-output-policy.md).
process.stderr.write(`continuo: test order seed = ${seed} (${SEED_ENV})\n`);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",

    // Fail closed on an empty selection: a glob that stops matching must not
    // read as "everything passed".
    passWithNoTests: false,

    // No retries, ever. A test that passes on the second attempt under a
    // shuffled order is exactly the signal the double-green rule exists to
    // catch; retrying would erase it.
    retry: 0,

    // Explicit imports from "vitest" rather than injected globals.
    globals: false,

    // Vitest's default is 5s, and that is a statement about how fast the
    // machine is, not about whether the code is correct.
    //
    // This suite is I/O-bound: the control plane runs with
    // `synchronous = FULL` (D-0012), which fsyncs on every commit, and a single
    // ported case can create, migrate and re-verify a database several times
    // over. Measured on one CI run, for the same test on the same OS:
    //
    //   linux-latest              28ms
    //   windows-latest (healthy) 321ms
    //   windows-latest (slow)  13,556ms
    //
    // The two Windows numbers are the same commit, the same workflow, two
    // runners -- a 42x spread with no code between them. At the 5s default that
    // spread is the difference between green and a red merge gate.
    //
    // The budget is deliberately several times the worst figure observed. The
    // costs are asymmetric: a false red blocks a merge and spends a person's
    // attention on a machine's bad afternoon, while a genuinely hung test still
    // fails, just later. Correctness here is protected by `retry: 0` and the
    // double-green rule (D-0005), not by a stopwatch.
    //
    // -- RECALIBRATED, because the worst figure observed moved and the rule
    // above stopped being honoured. The 13,556ms measurement is from 2026-08-22
    // and 60s was ~4.4x it. Measured again on 2026-08-28, over two
    // `windows-latest, node 24` runs of the SAME suite (763 reported durations
    // each):
    //
    //                          main @ 33110511976   a PR branch @ 33136436240
    //   p50                              2,278ms                     1,606ms
    //   p90                              9,704ms                     7,949ms
    //   slowest PASSING test            57,364ms                    57,156ms
    //   tests killed at the 60s cap            1                           2
    //
    // A test that PASSES at 57.4s under a 60s cap is not a budget with headroom;
    // it is a coin flip, and both runs lost it. Note the left-hand column: that
    // is `main` failing its own gate, on a commit with none of the branch's code
    // -- so this is runner variance being read as a hang, which is the one thing
    // the paragraph above says this number must not do.
    //
    // 180s is the same "several times the worst observed" rule applied to the
    // current worst (3.1x 57.4s). It cannot turn a passing test red; it can only
    // stop killing tests that were going to finish. The job cap is 40 minutes
    // and these cells run 12-20, so even a genuinely hung test still reports
    // inside the job.
    //
    // What this is NOT is a fix for the pace itself. The cost is concentrated in
    // a few database-heavy files -- on the run above, `outbox.test.ts` 464s,
    // `spike-schema.test.ts` 360s, `lease.test.ts` 269s, `provenance.test.ts`
    // 163s -- and interlock#37 records the remedy for that as the testkit
    // template (`suiteTemplate` / `copyInto`, D-0025), which is per-lane work on
    // the ~225 sites that have not been converted. A timeout is the instrument
    // for "is this hung", not for "is this slow".
    testTimeout: 180_000,
    hookTimeout: 180_000,

    sequence: {
      // Both axes: file order and, within a file, test order.
      shuffle: { files: true, tests: true },
      // The isolation contract for the port (D-0005): order is shuffled, but
      // tests do not run concurrently *within* a file. Concurrency is a
      // separate property from ordering and is not being ported blind from a
      // suite that never had it.
      concurrent: false,
      seed,
    },

    // Each test file gets its own worker and therefore its own module registry.
    // Combined with per-test temp directories (test/helpers/tmp.ts), a test's
    // filesystem state never leaks into another test's, whatever the order.
    isolate: true,
  },
});
