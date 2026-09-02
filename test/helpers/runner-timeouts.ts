/**
 * How much longer a time budget runs on a slow runner, in one place (D-0052).
 *
 * Two layers of this repository hand out a time budget, and until D-0052 only
 * one of them knew that continuo's runners are not all the same speed:
 *
 * - the **harness** budgets in `test/fault_injection/policy.ts` -- the per-case
 *   watchdog, the per-barrier one and the suite one -- scaled by
 *   {@link PORT_BUDGET_SCALE} (D-0602, D-0604);
 * - **Vitest's own** `testTimeout` / `hookTimeout`, a flat 60s written into
 *   `vitest.config.ts` and copied into
 *   `test/gate_item11/support/suite-runs-unchanged.config.ts`.
 *
 * The scale therefore lives here rather than beside either consumer, so the
 * number cannot be raised in one layer and left behind in the other -- which is
 * exactly the shape of the defect D-0604 repaired one level down.
 *
 * ASCII-only: `vitest.config.ts` imports this module, and that file writes to a
 * cp932 console on the Windows cell (`docs/cli-output-policy.md`, D-0006).
 */

import process from "node:process";

/**
 * How much longer this port's time budgets run than the numbers they are
 * calibrated from (D-0602).
 *
 * interlock's budgets are calibrated on interlock's runners, and Vitest's
 * default 5s is calibrated on nobody's. Continuo's Windows cells are documented
 * -- in this repository's own measurements, from a single CI run -- as
 * pathologically slow for exactly the work this suite does: the same test took
 * 28ms on linux, 321ms on a healthy windows runner and **13,556ms on a slow
 * one**, same commit, same workflow, no code between them. The control plane
 * runs `synchronous = FULL` (interlock D-0012), so every commit fsyncs.
 *
 * The manifest's numbers are NOT changed by this: the scale is applied where a
 * budget is USED, and only by this port. See D-0602 for why.
 */
export const PORT_BUDGET_SCALE = 3;

/**
 * The runner's per-test and per-hook budget before the scale, in milliseconds.
 *
 * Vitest's default is 5s, and that is a statement about how fast the machine
 * is, not about whether the code is correct. This number is the fast-runner
 * budget; {@link runnerTimeoutMs} is what a config should actually install.
 *
 * It is also the ceiling every harness budget has to stay under -- see
 * `RUNNER_BUDGET_CEILING_S` in `test/fault_injection/policy.ts`, and the
 * assertion in `test/fault_injection/manifest.test.ts` that ties the two
 * together.
 */
export const RUNNER_TIMEOUT_BASE_MS = 60_000;

/**
 * Whether this platform is one of the slow ones (D-0052).
 *
 * The predicate is the OS, not `CI` and not an environment variable, on three
 * grounds:
 *
 * 1. **That is where the evidence is.** Over the repository's CI history a
 *    green job took a p50 of about 70s on `ubuntu-latest` and about 640s on
 *    `windows-latest` -- an order-of-magnitude gap that is a property of the
 *    platform (NTFS plus a scanner, against an fsync on every commit), not of
 *    the workload, which is byte-identical across cells.
 * 2. **A local Windows run reproduces a Windows CI failure.** Keying on `CI`
 *    would make the machine a developer debugs on behave differently from the
 *    machine that failed, which is the one time the budget matters most.
 * 3. **It needs nothing plumbed.** An environment variable has to be set by
 *    every workflow, every nested run and every local shell, and the failure
 *    mode of forgetting it is the silent one this entry exists to remove.
 *
 * The cost, stated plainly: on Windows a genuinely hung test is now reported
 * after 180s rather than 60s. That is paid only on the platform that earned it
 * -- linux and macOS keep the 60s backstop -- and the double-green rule
 * (D-0005) means every change also runs on ubuntu, where a real hang still
 * fails at the original latency. A late failure is the cheaper mistake than a
 * false red; correctness here is protected by `retry: 0` and double-green, not
 * by a stopwatch.
 */
export function isSlowRunner(platform: string = process.platform): boolean {
  return platform === "win32";
}

/**
 * The per-test / per-hook budget to install on this platform, in milliseconds.
 *
 * `platform` is a parameter so the rule is testable off the platform the test
 * happens to be running on.
 */
export function runnerTimeoutMs(platform: string = process.platform): number {
  return RUNNER_TIMEOUT_BASE_MS * (isSlowRunner(platform) ? PORT_BUDGET_SCALE : 1);
}
