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
    throw new Error(
      `${SEED_ENV} must be a non-negative integer, got ${JSON.stringify(raw)}.`,
    );
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed > SEED_MAX) {
    throw new Error(
      `${SEED_ENV} must be a non-negative integer <= ${SEED_MAX}, got ${raw}.`,
    );
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
