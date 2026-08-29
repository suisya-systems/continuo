/**
 * The cases: every manifest entry, executed and asserted by name.
 *
 * Ported from interlock `tests/fault_injection/test_cases.py` at `65f36c5`.
 *
 * This module is deliberately thin. A case's meaning lives in the manifest and
 * its assertions live in `controller.assertInvariants`, keyed by the contract's
 * invariant names -- so when the spike implementation is discarded (interlock
 * D-0026) the adapter is re-bound and nothing here is rewritten.
 */

import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { caseRoot } from "../testkit/cases.js";
import type { FaultCase } from "./contract.js";
import { assertInvariants, CaseFailure, Controller, executeCase, reproLine } from "./controller.js";
import {
  adapterFor,
  barrierTimeoutS,
  caseTimeoutS,
  installSuiteBudget,
  laneSkipReason,
  manifest as loadPolicyManifest,
  profileSelectedCases,
  profile as resolveProfile,
  suiteSeed,
} from "./policy.js";

/**
 * The cases this profile selects, on every lane.
 *
 * Read once at collection, exactly as the source's module-level `_CASES` is:
 * every profile case becomes a test item on every OS, and the ones this host
 * cannot run skip with their lane named (design 8.1).
 */
const CASES = profileSelectedCases();

const PROFILE = resolveProfile(loadPolicyManifest());

// The suite budget (design 9). Installed per file rather than per package --
// see `installSuiteBudget` for why, and for what that narrowing does and does
// not catch.
installSuiteBudget(PROFILE);

describe("the manifest cases", () => {
  /**
   * Run one manifest case and assert exactly what it declared.
   *
   * Every failure -- an invariant, a barrier that was never reached, a case that
   * outran its budget, a role that exited some way other than by the signal --
   * carries the `S9-REPRO` line and the `S9-RERUN` command that reproduces
   * exactly this case. The harness-fault paths need it most: they are the ones
   * that happen on a runner nobody has a shell on.
   */
  // Written as an explicit loop rather than through `testkit/parametrize`,
  // for one reason: the source skips a case **at run time**
  // (`pytest.skip(reason)` inside the body), and reproducing that needs the test
  // context, which `parametrize`'s body signature does not pass. The id shape is
  // `parametrize`'s exactly -- `name[id]`, with the id being the case id pytest
  // prints -- so the target ids the ledger maps onto are unchanged.
  //
  // The distinction is not cosmetic. A collection-time skip would remove the
  // item from `vitest list` on a host that cannot run its lane, and design
  // section 8.1 asks for the opposite: the item exists everywhere so "did not
  // run here" is readable off the report instead of looking like "passed".
  for (const [caseId, entry] of CASES.map(
    (item) => [item["case_id"] as string, item as FaultCase] as const,
  )) {
    test(`run one manifest case[${caseId}]`, async (context) => {
      const reason = laneSkipReason(entry);
      if (reason !== null) {
        // The source's in-test `pytest.skip(reason)`. A runtime skip, not a
        // collection-time one: the item exists on every OS so a gate reader can
        // tell "did not run here" from "passed" by reading the report alone.
        context.skip(reason);
        return;
      }

      const controller = new Controller({
        workdir: join(caseRoot(`fi-${entry["case_id"] as string}`), "case"),
        adapter: adapterFor(entry),
        case: entry,
        suiteSeed: suiteSeed(),
        barrierTimeoutS: barrierTimeoutS(PROFILE),
        caseTimeoutS: caseTimeoutS(entry, PROFILE),
        profile: String(PROFILE["name"]),
      });

      try {
        try {
          const outcome = await executeCase(controller, entry);
          assertInvariants(controller, entry, {
            resolvedSkewMs: outcome.resolvedSkewMs,
            atKill: outcome.atKill,
            unresolvedAtKill: outcome.unresolvedAtKill,
          });
        } catch (error) {
          // A *new* error chained from the original rather than the original's
          // type re-instantiated with a longer message: several errors the
          // harness can raise have structured constructors, so rebuilding them
          // from a string replaces the real failure with a failure about
          // reporting the failure. The cause is chained, so the original stack
          // is still what the reader sees first.
          const line = reproLine({
            caseId: entry["case_id"] as string,
            suiteSeed: suiteSeed(),
            manifestVersion: entry["manifest_version"] as number,
            profile: String(PROFILE["name"]),
          });
          const message = String((error as Error)?.message ?? error);
          if (message.includes(line.split("\n")[0] as string)) {
            throw error;
          }
          throw new CaseFailure(
            `${(error as Error)?.constructor?.name ?? "Error"}: ${message}\n${line}`,
            { cause: error },
          );
        }
      } finally {
        // Unconditional, layered, and reaps last (design 8.2): pass, fail and
        // error alike. The source gets this from the controller's context
        // manager; here it is the `finally` that wraps the whole case.
        await controller.teardown();
      }
    });
  }

  test("what this OS does not run is enumerable", () => {
    // What does not run on an OS is listed, never silent (design 8.1).
    //
    // Every profile case is collected as a test item on every OS. The ones this
    // host cannot run skip with the lane named in the reason, so a gate reader
    // can tell "did not run here" from "passed" by reading the report alone.
    // This test asserts the *rule*: nothing is ever excluded for a reason other
    // than a lane.
    for (const entry of CASES) {
      const reason = laneSkipReason(entry);
      if (reason === null) {
        continue;
      }
      expect(entry["lane"], `${entry["case_id"]} is skipped for a reason other than its lane`).toBe(
        "linux",
      );
      expect(reason).toContain(entry["lane"] as string);
      expect(reason).toContain("design 8.1");
    }
  });
});
