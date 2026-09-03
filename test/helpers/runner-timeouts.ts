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
 * A third joined them in D-0069: the deadline a test gives a **real child
 * process** to report at all ({@link childWaitTimeoutMs}), which was a 10s
 * literal in two test helpers and is now a share of the runner's budget for the
 * same reason the runner's budget is scaled -- the machine, not the code.
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

/**
 * How many of a case's real-child waits have to fit inside one runner budget.
 *
 * `waitUntilObserved` and its siblings poll a **real child process** until it
 * reports, and the case around them is already under Vitest's per-test budget.
 * Two budgets therefore race, and the order matters: the poll's own deadline
 * fails with the readout in the message (`child never reported: ...`), the
 * runner's fails with `Test timed out in Nms` and no attribution at all. The
 * poll must win, so its budget has to be strictly smaller than the runner's --
 * and smaller by enough that a case which waits for more than one child still
 * loses the race on the wait rather than on the sum.
 *
 * The divisor is the largest number of waits any one case in this suite makes
 * (`test/gate_item11/substitution-scenarios.test.ts`'s "a released binding
 * frees the run for the next session" waits twice), plus one, so a case's waits
 * cannot add up to the runner's budget on their own.
 */
export const CHILD_WAIT_BUDGET_DIVISOR = 3;

/**
 * How long a test may wait for a real child to report, in milliseconds (D-0069).
 *
 * A share of {@link runnerTimeoutMs} rather than a constant of its own: the
 * thing that makes a child slow to report -- a loaded machine -- is the same
 * thing D-0052 already scales the runner's budget for, and a second scaling
 * rule would be a second number to raise and forget. 20s on a fast runner, 60s
 * on a slow one.
 *
 * `platform` is a parameter for the same reason it is one on
 * {@link runnerTimeoutMs}: so the rule is testable off the platform the test
 * happens to be running on.
 */
export function childWaitTimeoutMs(platform: string = process.platform): number {
  return runnerTimeoutMs(platform) / CHILD_WAIT_BUDGET_DIVISOR;
}
