/**
 * The session adapter: gate item 2's `session-start` cases.
 *
 * Ported in **shape** from interlock `tests/fault_injection/session_driver.py`
 * at `65f36c5`; its script is a declared follow-on. Read the next two paragraphs
 * before assuming either more or less than that.
 *
 * **What this file is.** It is a `CaseAdapter` (D-0601) -- the narrow seam a
 * manifest case's `adapter` field may name -- and it is the second of the two
 * modules in this tree permitted to import the implementation under test, which
 * `import-graph.test.ts` asserts in both directions: no other module may import
 * `src/`, and these two must.
 *
 * **What this file is not.** It is not a `FullFaultAdapter`, so the conformance
 * battery does not run against it, and it does not drive a role process. The
 * source's driver stands on a `SessionOrchestrator` and a C2 provider over a
 * fake CLI. Continuo has no `src/session/` at this revision -- the session belt
 * is a separate lane -- so the walk those four cases inject into does not exist
 * yet to be injected into.
 *
 * **What that costs, exactly.** Nothing in the ported node-id set. The four
 * `session-start` cases are `full`-profile only, and the source inventory this
 * belt is measured against (`parity/source-inventory/fault_injection.*.txt`, 98
 * ids) was collected under the default `fast` profile, so not one of them
 * appears in it. The 21 collected manifest cases are the fast-profile spike
 * cases and they are all present. The follow-on is therefore about the *full*
 * profile, and it is declared in the ledger rather than left to be discovered.
 *
 * **Why it refuses loudly rather than quietly passing.** A stub that bootstrapped
 * a store and let a case proceed would let the four cases run and report
 * something -- and whatever they reported would be about a walk that never
 * happened. Refusing at the first call names the missing dependency instead, so
 * a `full` run says what is absent rather than certifying a gate item on an
 * empty set.
 */

import { join } from "node:path";

import { createControlPlane } from "../../src/control_plane/schema.js";

import * as contract from "./contract.js";
import {
  type CaseAdapter,
  ContractViolation,
  type DestinationObserver,
  type FaultCase,
} from "./contract.js";

/** What is missing, named once so every refusal says the same thing. */
const PENDING =
  "the session adapter needs src/session/ (the orchestrator and the C2 provider the " +
  "commit-before-spawn walk runs through), which this revision of continuo does not have. " +
  "The four session-start cases are full-profile only and appear in none of the 98 node ids " +
  "this belt ports; they are declared in parity/fault-injection.cases.ledger.json as a " +
  "follow-on on the session belt landing. See DECISIONS.md D-0601.";

function refuse(what: string): never {
  throw new ContractViolation(`${what}: ${PENDING}`);
}

/**
 * `contract.CaseAdapter` for the session lane.
 *
 * Everything a case would need to *execute* refuses; everything the collection
 * path needs -- the name, so the manifest's `adapter` field resolves in the
 * registry -- answers normally. That split is the point: an unknown adapter must
 * fail at collection, and a known-but-unimplemented one must fail when it is
 * driven, not silently before.
 */
export class SessionAdapter implements CaseAdapter {
  readonly name = "session";
  readonly driverModule = "test/fault_injection/session_driver.ts";

  /**
   * The store constructor this adapter will bind through when the orchestrator
   * lands, held rather than called.
   *
   * It is what makes this module an *adapter* rather than a durable one:
   * `import-graph.test.ts` asserts that **both** adapter modules import the
   * implementation under test -- the rule is a seam, not a ban, and something
   * has to bind to today's schema. The session walk's first durable write is
   * the session<->run binding, which lives in the control plane, so this is the
   * right function to hold. Holding it (rather than exporting a bare alias)
   * keeps the seam test asserting something real and keeps the reference from
   * being dropped by a tidy-up.
   */
  readonly storeFactory = createControlPlane;

  /** The operation these cases inject into, named so a report can cite it. */
  readonly operation = contract.OPERATION_SESSION_START;

  driverCommand(): { executable: string; prefixArguments: readonly string[] } {
    return refuse("session_driver has no role process to spawn");
  }

  bootstrap(_dbPath: string, _options: { roles: readonly string[]; nowMs: number }): void {
    refuse("session_driver cannot bootstrap a session case");
  }

  roleArguments(_role: string, _options: { case: FaultCase; workdir: string }): readonly string[] {
    return refuse("session_driver has no role arguments");
  }

  observer(_workdir: string, _role: string): DestinationObserver {
    // The two destination invariants the session cases name --
    // `live-processes-per-session` and `transcript-single-writer` -- are read
    // off an observer with `liveProcessReport()` and `transcriptReport()`. There
    // is no provider process to count and no stream to read, so there is no
    // honest observer to return.
    return refuse("session_driver has no destination observer");
  }

  invariantQueries(): Readonly<Record<string, string>> {
    return refuse("session_driver binds no invariant SQL");
  }

  storePath(_name: string, options: { controlPlane: string; workdir: string }): string {
    return join(options.workdir, "control-plane.sqlite3");
  }

  queryParameters(_role: string, _options: { nowMs: number }): Readonly<Record<string, unknown>> {
    return refuse("session_driver binds no invariant parameters");
  }

  effectKeys(
    _role: string,
    _faultCase: FaultCase,
    _options: { holderSuffix?: string } = {},
  ): readonly string[] {
    return refuse("session_driver produces no destination keys");
  }

  holderOf(_role: string): string {
    return refuse("session_driver has no holder identity");
  }
}

export const SESSION_ADAPTER = new SessionAdapter();
