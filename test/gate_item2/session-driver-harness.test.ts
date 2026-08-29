/**
 * The session driver's own battery: the checks its conformance absence owes.
 *
 * Ported from interlock `tests/gate_item2/test_session_driver_harness.py` at
 * `65f36c5`. Deferred at `D-0801` (28/34 landed, this file's 6 node ids held
 * back as a declared follow-on) and landed here once the fault-injection
 * belt's `SessionAdapter` (`test/fault_injection/session_driver.ts`) was
 * re-bound to `src/supervisor.ts` / `src/session/claude_cli_provider.ts`,
 * per that decision's own falsifier and D-0601's two-adapter split.
 *
 * The `#18` adapter is deliberately not in the fault harness's conformance
 * battery -- the battery presupposes a three-role delivery loop it does not
 * have -- so the properties that battery would have pinned are pinned here
 * instead:
 *
 * - every anchor the four cases arm is actually reachable and blocks;
 * - a real `SIGKILL` at each anchor, followed by a restart, ends in
 *   re-identification (the full `executeCase` + `assertInvariants` path,
 *   including the window-landing and destination checks);
 * - two runs of one case produce identical protocol traces (the determinism
 *   the re-run contract relies on).
 *
 * Linux-lane, like the source's file-level `pytestmark`: the cases need a
 * real `SIGKILL` and a `/proc` scan (`laneSkipReason` reads the manifest's
 * own `"lane": "linux"` on each of the four cases, which is the same
 * declaration `assertInvariants`'s window-landing gate already trusts).
 */

import { join } from "node:path";

import { describe, expect } from "vitest";

import type { FaultCase } from "../fault_injection/contract.js";
import { assertInvariants, Controller, executeCase } from "../fault_injection/controller.js";
import { loadManifest } from "../fault_injection/manifest.js";
import {
  barrierTimeoutS,
  caseTimeoutS,
  installSuiteBudget,
  laneSkipReason,
  manifest as loadPolicyManifest,
  profile as resolveProfile,
} from "../fault_injection/policy.js";
import { SESSION_ADAPTER } from "../fault_injection/session_driver.js";
import { caseRoot } from "../testkit/cases.js";
import { skipIf } from "../testkit/marks.js";

const PROFILE = resolveProfile(loadPolicyManifest());

// The suite budget (design 9), same as every other fault-injection file.
installSuiteBudget(PROFILE);

function sessionCases(): FaultCase[] {
  const loaded = loadManifest();
  return (loaded["cases"] as FaultCase[]).filter(
    (entry) => entry["adapter"] === SESSION_ADAPTER.name,
  );
}

const SESSION_CASES = sessionCases();

/** All four cases declare the same lane; one reason covers the whole file. */
const SKIP_REASON = laneSkipReason(SESSION_CASES[0] as FaultCase);

interface RunResult {
  readonly generations: ReadonlySet<number>;
  readonly killedAnnouncedAnAnchor: boolean;
  readonly traces: ReturnType<Controller["allTraces"]>;
}

/** The whole path, per case: bootstrap, spawn, barrier, kill, restart, assert. */
async function runCase(faultCase: FaultCase, workdir: string): Promise<RunResult> {
  const controller = new Controller({
    workdir,
    adapter: SESSION_ADAPTER,
    case: faultCase,
    suiteSeed: 1,
    barrierTimeoutS: barrierTimeoutS(PROFILE),
    caseTimeoutS: caseTimeoutS(faultCase, PROFILE),
    profile: "full",
  });
  try {
    const outcome = await executeCase(controller, faultCase);
    assertInvariants(controller, faultCase, {
      resolvedSkewMs: outcome.resolvedSkewMs,
      atKill: outcome.atKill,
      unresolvedAtKill: outcome.unresolvedAtKill,
    });
    const traces = controller.allTraces();
    const generations = new Set(traces.map((entry) => entry.generation));
    const killed = traces.filter((entry) => entry.generation === 0);
    const killedAnnouncedAnAnchor = killed.some((entry) =>
      entry.trace.some((event) => event.event === "checkpoint" || event.event === "sync"),
    );
    return { generations, killedAnnouncedAnAnchor, traces };
  } finally {
    // Unconditional, layered, and reaps last (design 8.2): pass, fail and
    // error alike -- the source gets this from the controller's context
    // manager, ported here as the `finally` wrapping the whole case.
    await controller.teardown();
  }
}

describe("the session driver harness", () => {
  skipIf(SKIP_REASON !== null, SKIP_REASON ?? "")(
    "the manifest carries all four injection points",
    () => {
      const anchors = SESSION_CASES.map((entry) => entry["checkpoint"] as string).sort();
      expect(anchors).toEqual(
        [
          "after_effect_before_record",
          "after_record_before_effect",
          "before_durable_write",
          "identity-readback-committed",
        ].sort(),
      );
    },
  );

  /**
   * The whole path, per anchor: reach, block, SIGKILL, restart, re-identify.
   *
   * `executeCase` asserts the kill's exit status; `assertInvariants` asserts
   * exactly-one confirmed binding, the window-landing spawn count, and the
   * destination reports -- so an anchor that stopped being reached, a kill
   * that stopped landing, or a recovery that stopped confirming all fail
   * here, in the default profile.
   */
  for (const faultCase of SESSION_CASES) {
    const caseId = faultCase["case_id"] as string;
    skipIf(SKIP_REASON !== null, SKIP_REASON ?? "")(
      `each anchor is reachable, killed and recovered[${caseId}]`,
      async () => {
        const { generations, killedAnnouncedAnAnchor } = await runCase(
          faultCase,
          join(caseRoot(`gi2-sdh-${caseId}`), "case"),
        );
        expect(generations).toEqual(new Set([0, 1]));
        expect(killedAnnouncedAnAnchor, "generation 0 never announced the armed anchor").toBe(true);
      },
    );
  }

  skipIf(SKIP_REASON !== null, SKIP_REASON ?? "")(
    "two runs of one case produce identical traces",
    async () => {
      const faultCase = SESSION_CASES[0] as FaultCase;
      const first = await runCase(faultCase, join(caseRoot("gi2-sdh-repeat-one"), "one"));
      const second = await runCase(faultCase, join(caseRoot("gi2-sdh-repeat-two"), "two"));
      expect(second.traces, "the driver's protocol trace is not deterministic").toEqual(
        first.traces,
      );
    },
  );
});
