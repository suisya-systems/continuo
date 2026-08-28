/**
 * The conformance battery, run against every adapter this build ships.
 *
 * Ported from interlock `tests/fault_injection/test_conformance.py` at
 * `65f36c5`.
 *
 * Today that is one adapter (the spike driver). When a second `FullFaultAdapter`
 * lands, it is added to {@link FULL_FAULT_ADAPTERS} and everything below runs
 * against it unchanged -- which is the point: an adapter that has not passed the
 * battery cannot contribute matrix results (design 6.3).
 *
 * **One subject is a complete exam, not half a comparison (D-0601).** The
 * battery asserts the contract itself; a second subject adds coverage of that
 * adapter, not of the exam.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { caseRoot } from "../testkit/cases.js";
import { parametrize } from "../testkit/parametrize.js";
import * as conformance from "./conformance.js";
import type { FullFaultAdapter } from "./contract.js";
import * as contract from "./contract.js";
import { FULL_FAULT_ADAPTERS, installSuiteBudget, manifest, profile } from "./policy.js";

const BUDGET_PROFILE = profile(manifest());

const LINUX = process.platform === "linux";

// The suite budget (design 9). Installed per file rather than per package --
// see `installSuiteBudget` for why, and for what that narrowing does and does
// not catch.
installSuiteBudget(BUDGET_PROFILE);

/**
 * The adapter's id in a test name.
 *
 * The source takes the last dotted segment of the driver's module path
 * (`tests.fault_injection.spike_driver` -> `spike_driver`). The port's module
 * path is a file path, so the same id is its basename without the extension --
 * which produces the identical string, and therefore the identical node ids the
 * ledger maps onto.
 */
function adapterId(adapter: FullFaultAdapter): string {
  return basename(adapter.driverModule).replace(/\.ts$/, "");
}

const ADAPTERS: readonly (readonly [string, FullFaultAdapter])[] = FULL_FAULT_ADAPTERS.map(
  (adapter) => [adapterId(adapter), adapter] as const,
);

/**
 * The stacked-`parametrize` product, in pytest's printed order.
 *
 * Two rules, and they point in opposite directions, which is why the product is
 * built explicitly rather than by nesting a generic helper:
 *
 * - the **id** is built from the decorator closest to the function first, so a
 *   `checkpoint`/`role`/`adapter` stack reads `checkpoint-role-adapter`;
 * - the axis that **varies fastest** is the outermost decorator, so `role` moves
 *   fastest and `checkpoint` slowest.
 *
 * Measured against the source inventory rather than reasoned about: the first
 * four collected ids are `[before_durable_write-sup-...]`,
 * `[before_durable_write-disp-...]`, `[before_durable_write-sec-...]`,
 * `[after_record_before_effect-sup-...]`. The loops below reproduce that line
 * for line, which is what the ledger is reconciled against.
 */
function productOf<A, B>(
  slow: readonly (readonly [string, A])[],
  fast: readonly (readonly [string, B])[],
): (readonly [string, readonly [A, B]])[] {
  const rows: (readonly [string, readonly [A, B]])[] = [];
  for (const [slowId, slowValue] of slow) {
    for (const [fastId, fastValue] of fast) {
      rows.push([`${fastId}-${slowId}`, [slowValue, fastValue] as const] as const);
    }
  }
  return rows;
}

/** The three-axis stack, with the id and the iteration order stated separately. */
function tripleProduct<A, B, C>(
  adapters: readonly (readonly [string, A])[],
  slow: readonly (readonly [string, B])[],
  fast: readonly (readonly [string, C])[],
): (readonly [string, readonly [A, B, C]])[] {
  const rows: (readonly [string, readonly [A, B, C]])[] = [];
  for (const [adapterName, adapter] of adapters) {
    for (const [slowId, slowValue] of slow) {
      for (const [fastId, fastValue] of fast) {
        rows.push([
          `${slowId}-${fastId}-${adapterName}`,
          [adapter, slowValue, fastValue] as const,
        ] as const);
      }
    }
  }
  return rows;
}

const ROLES: readonly (readonly [string, string])[] = contract.ROLES.map(
  (role) => [role, role] as const,
);
const CHECKPOINTS: readonly (readonly [string, string])[] = contract.CHECKPOINTS.map(
  (checkpoint) => [checkpoint, checkpoint] as const,
);

describe("the conformance battery", () => {
  // All four windows, for all three roles.
  //
  // Gate item 4 requires all three ACCEPTANCE.md section 2 kill windows for each
  // of the three components, and the two mid-call windows exist only on a
  // record -> effect -> result path. That is why the Supervisor and Secretary
  // scripts each carry one externally-effecting action: without it, the matrix
  // could arm a required (role, window) pair and hit a manifest-validation dead
  // end.
  parametrize(
    "every checkpoint is reachable and blocks",
    tripleProduct(ADAPTERS, CHECKPOINTS, ROLES).map(
      ([id, [adapter, checkpoint, role]]) => [id, { adapter, checkpoint, role }] as const,
    ),
    async ({ adapter, checkpoint, role }) => {
      await conformance.checkCheckpointBlocks(adapter, caseRoot("fi-conf-blocks"), {
        role,
        operation: contract.OPERATION_ATTEMPT,
        checkpoint,
      });
    },
  );

  // A barrier the applicability matrix advertises can actually be reached.
  parametrize(
    "the non delivery operations expose their windows",
    productOf(
      ADAPTERS,
      [
        contract.OPERATION_LEASE_ACQUIRE,
        contract.OPERATION_LEASE_RENEW,
        contract.OPERATION_ENQUEUE,
        contract.OPERATION_ACK,
      ].map((operation) => [operation, operation] as const),
    ).map(([id, [adapter, operation]]) => [id, { adapter, operation }] as const),
    async ({ adapter, operation }) => {
      await conformance.checkCheckpointBlocks(adapter, caseRoot("fi-conf-nondelivery"), {
        role: contract.ROLE_DISPATCHER,
        operation,
        checkpoint: contract.CHECKPOINT_BEFORE_DURABLE_WRITE,
      });
    },
  );

  // The observation operation is armable like any other durable write.
  //
  // It is on the Supervisor's script only -- the Supervisor is the role that
  // binds a session, so it is the role that observes it -- and a window the
  // applicability matrix advertises has to be reachable or a case arming it
  // would time out in CI instead of failing at collection (design 3.1).
  parametrize("the observation step exposes its windows", ADAPTERS, async (adapter) => {
    await conformance.checkCheckpointBlocks(adapter, caseRoot("fi-conf-observe"), {
      role: contract.ROLE_SUPERVISOR,
      operation: contract.OPERATION_OBSERVE,
      checkpoint: contract.CHECKPOINT_BEFORE_DURABLE_WRITE,
    });
  });

  parametrize("no two refusals in one case share an attempt id", ADAPTERS, async (adapter) => {
    await conformance.checkRefusalIdsAreUnique(adapter, caseRoot("fi-conf-refusal-ids"));
  });

  // So that the matrix's "none were produced" is evidence and not a tautology.
  parametrize("the escalation path can record a recommendation", ADAPTERS, async (adapter) => {
    await conformance.checkEscalationPathCanRecord(adapter, caseRoot("fi-conf-escalation"));
  });

  parametrize("the barrier round trip releases the process", ADAPTERS, async (adapter) => {
    await conformance.checkBarrierRoundTrip(adapter, caseRoot("fi-conf-roundtrip"), {
      role: contract.ROLE_DISPATCHER,
    });
  });

  // The exit-status half of the assertion is lane-conditional (design 8.1).
  parametrize(
    "a kill at each window is a signal and leaves a readable database",
    productOf(ADAPTERS, CHECKPOINTS).map(
      ([id, [adapter, checkpoint]]) => [id, { adapter, checkpoint }] as const,
    ),
    async ({ adapter, checkpoint }) => {
      await conformance.checkSigkillExitStatus(adapter, caseRoot("fi-conf-kill"), {
        role: contract.ROLE_DISPATCHER,
        checkpoint,
        assertExitStatus: LINUX,
      });
    },
  );

  parametrize("the restart entrypoint recovers and is idempotent", ADAPTERS, async (adapter) => {
    await conformance.checkRestartIsIdempotent(adapter, caseRoot("fi-conf-restart"), {
      role: contract.ROLE_DISPATCHER,
    });
  });

  parametrize("the injected clock is honoured", ADAPTERS, async (adapter) => {
    await conformance.checkClockIsInjected(adapter, caseRoot("fi-conf-clock"), {
      role: contract.ROLE_SUPERVISOR,
    });
  });

  parametrize("the driver never reads the host clock", ADAPTERS, (adapter) => {
    conformance.checkNoHostClock(adapter);
  });

  parametrize("one case and one seed give identical traces", ADAPTERS, async (adapter) => {
    await conformance.checkIdenticalTraces(adapter, caseRoot("fi-conf-traces"), {
      role: contract.ROLE_SECRETARY,
    });
  });

  parametrize("the checkpoint vocabulary is the contract's", ADAPTERS, (adapter) => {
    conformance.checkVocabularyMatches(adapter);
  });

  test("target-only -- the spawn command passes an ESM specifier to --import, not a path", () => {
    // TARGET-ONLY, and it exists because CI found what six review rounds and
    // every local run did not: the belt was green on four ubuntu cells and
    // failed on BOTH Windows cells with
    // `ERR_UNSUPPORTED_ESM_URL_SCHEME: ... On Windows, absolute paths must be
    // valid file:// URLs. Received protocol 'd:'`.
    //
    // `--import` takes an ESM SPECIFIER. A POSIX absolute path happens to be an
    // acceptable one, so passing `fileURLToPath(...)` worked on every machine
    // this belt was developed on; a Windows absolute path parses as a URL whose
    // scheme is the DRIVE LETTER, and the loader refuses it. The source has no
    // counterpart -- it spawns `python -m <dotted module>` and never crosses a
    // path/URL boundary at all -- so this is a hazard the port invented and has
    // to pin itself.
    //
    // The assertion is platform-independent, which is the point: a raw POSIX
    // path makes `new URL` throw (no base), and a raw Windows path yields a
    // one-letter protocol. Either way this fails, on any host, without needing
    // a Windows runner to notice.
    for (const [, adapter] of ADAPTERS) {
      const { prefixArguments } = adapter.driverCommand();
      const importIndex = prefixArguments.indexOf("--import");
      expect(importIndex, "the spawn command no longer passes --import").toBeGreaterThanOrEqual(0);
      const specifier = prefixArguments[importIndex + 1];
      expect(specifier, "--import was given no value").toBeDefined();
      expect(
        () => new URL(specifier as string),
        `--import was given ${JSON.stringify(specifier)}, which is not a URL at all -- a bare ` +
          "POSIX path. Windows rejects the equivalent outright",
      ).not.toThrow();
      expect(
        new URL(specifier as string).protocol,
        `--import was given ${JSON.stringify(specifier)}, whose scheme is not file:. A Windows ` +
          "absolute path parses with the drive letter as its scheme, which is exactly the " +
          "ERR_UNSUPPORTED_ESM_URL_SCHEME this pins",
      ).toBe("file:");
      // The shim it names has to actually be there, or the child dies before
      // `main()` with a message about a missing file rather than a missing hook.
      expect(existsSync(fileURLToPath(specifier as string))).toBe(true);

      // The entry script is the other half and is deliberately NOT a URL: that
      // argument is argv rather than a specifier, Node resolves a filesystem
      // path there on every platform, and the driver's own entrypoint guard
      // compares it against `process.argv[1]`.
      const entry = prefixArguments[prefixArguments.length - 1] as string;
      expect(entry.startsWith("file:")).toBe(false);
      expect(existsSync(entry)).toBe(true);
    }
  });

  parametrize("the driver accepts the contract CLI", ADAPTERS, (adapter) => {
    conformance.checkDriverCli(adapter);
  });

  parametrize("the invariant queries bind the contract parameters", ADAPTERS, (adapter) => {
    conformance.checkInvariantQueriesBindTheContractParameters(adapter);
  });

  // The guard against the quietest harness failure there is.
  //
  // An invariant of the form "this result set is empty" is satisfied both by a
  // healthy system and by a query that matches nothing. The second is not a
  // weaker test, it is no test -- and it does not announce itself, because the
  // run stays green. So each query is also asserted in the positive direction.
  parametrize(
    "the invariant queries can see the rows they are asserted over",
    productOf(ADAPTERS, ROLES).map(([id, [adapter, role]]) => [id, { adapter, role }] as const),
    async ({ adapter, role }) => {
      await conformance.checkInvariantQueriesAreNotVacuous(adapter, caseRoot("fi-conf-vacuity"), {
        role,
      });
    },
  );
});
