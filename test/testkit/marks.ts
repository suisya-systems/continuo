import { test } from "vitest";

/**
 * `pytest.mark.skipif` and `pytest.mark.xfail`, mapped without losing what they
 * mean.
 *
 * Nothing in the pilot's source file carries either mark -- interlock's
 * `control_plane` suite has no `skip` and no `xfail` anywhere, and the suite's
 * single `xfail` lives in `messagebus`. These wrappers exist now rather than
 * later because the testkit is frozen when this pilot merges, and a later belt
 * that meets its first `xfail` must not have to choose a mapping under deadline.
 * They are pinned by their own contract tests, which are **target-only**: they
 * translate no source case and are not counted in the parity ledger.
 */

/**
 * `@pytest.mark.skipif(condition, reason=...)`.
 *
 * Three properties of pytest's skip that a careless mapping drops:
 *
 * - The condition is evaluated **at collection time**, not inside the body, so
 *   a skipped test's body never runs at all. `test()` with an early `return`
 *   runs the body, which can still touch the filesystem or a database.
 * - The **reason** travels with the result. A reader of a CI log needs to know
 *   *why* a test did not run; a bare `test.skip` says only that it did not.
 * - It is **not** `test.todo`. `todo` means "not written yet"; `skip` means
 *   "written, and deliberately not run here". Collapsing the two turns a
 *   platform-conditional test into an unwritten one, and the ledger's
 *   unapproved-skip check cannot tell them apart afterwards.
 *
 * The condition is a value rather than a thunk, so it is computed where the
 * test is declared -- collection time, as pytest's is.
 */
export function skipIf(condition: boolean, reason: string): typeof test | typeof test.skip {
  if (!condition) {
    return test;
  }
  return ((name: string, fn: Parameters<typeof test>[1]) =>
    test.skip(`${name} [skipped: ${reason}]`, fn)) as unknown as typeof test.skip;
}

/**
 * `@pytest.mark.xfail`.
 *
 * pytest's default is **non-strict**: a test marked xfail that unexpectedly
 * *passes* reports XPASS and does **not** fail the run. Vitest's `test.fails`
 * is the opposite -- an unexpected pass is an error -- so `test.fails` is the
 * correct mapping for `xfail(strict=True)` and the **wrong** one for the
 * default.
 *
 * Translating a non-strict `xfail` to `test.fails` turns a green suite red the
 * day the underlying bug is fixed, which is precisely the outcome non-strict
 * xfail exists to avoid. So the two are mapped separately and the strictness is
 * required at the call site rather than defaulted: a translator has to have
 * read which one the source used.
 */
export function xfail(options: {
  readonly strict: boolean;
  readonly reason: string;
}): (name: string, fn: () => void | Promise<void>) => void {
  if (options.strict) {
    // Strict xfail and `test.fails` agree exactly: expected to fail, and an
    // unexpected pass is a failure.
    return (name, fn) => {
      test.fails(`${name} [xfail(strict): ${options.reason}]`, fn);
    };
  }
  // Non-strict: failure is expected and passing is tolerated. Both outcomes
  // leave the suite green, and the title carries the reason either way.
  return (name, fn) => {
    test(`${name} [xfail: ${options.reason}]`, async () => {
      try {
        await fn();
      } catch {
        // The expected outcome.
      }
    });
  };
}
