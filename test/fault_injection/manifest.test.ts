/**
 * The matrix is an enumeration, and the enumeration is checked.
 *
 * Ported from interlock `tests/fault_injection/test_manifest.py` at `65f36c5`.
 *
 * Design section 4. The Issue's wording ("the same seed hits the same point")
 * reads as if the seed selected injection points; it does not, and these tests
 * are where that is nailed down. The seed's authority is payload and schedule
 * only.
 */

import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { expectRefusal } from "../testkit/errors.js";
import * as contract from "./contract.js";
import { ContractViolation, caseSeed, resolveSkewMs } from "./contract.js";
import { reproLine } from "./controller.js";
import {
  buildManifest,
  COLLAPSE_RULES,
  INCIDENT_FAULTS,
  loadManifest,
  MANIFEST_PATH,
  MANIFEST_VERSION,
  validateCase,
  validateManifest,
} from "./manifest.js";

type CaseEntry = Record<string, unknown>;

/** A deep copy, so a mutation made to provoke a refusal cannot leak. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function aCase(): CaseEntry {
  return copy((loadManifest()["cases"] as CaseEntry[])[0] as CaseEntry);
}

describe("the frozen matrix", () => {
  test("the generator reproduces the frozen matrix exactly", () => {
    // No generation at collection time (design 4.2). A helper may *produce*
    // candidate products, but the manifest is the frozen literal. Adding or
    // pruning a case is therefore always an explicit, reviewable diff and never
    // a side effect of an enumeration change -- which is what stops a reordering
    // from silently changing what every seed means.
    //
    // Compared as canonicalised JSON rather than with `toEqual`: the source
    // compares two dicts, and dict equality in Python is key-order independent,
    // which is the property being asserted. Sorting every object's keys on both
    // sides reproduces exactly that and nothing more.
    const frozen = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown;
    expect(canonical(buildManifest())).toEqual(canonical(frozen));
  });

  test("the frozen matrix validates", () => {
    validateManifest(loadManifest());
  });

  test("every case id is unique and parses back to its classification", () => {
    // `case_id` is the re-run key, the manifest key and the report key.
    const manifest = loadManifest();
    const ids = (manifest["cases"] as CaseEntry[]).map((entry) => entry["case_id"] as string);
    expect(ids.length).toBe(new Set(ids).size);
    for (const entry of manifest["cases"] as CaseEntry[]) {
      const segments = (entry["case_id"] as string).split("__");
      expect(segments[0]).toBe((entry["targets"] as string[]).join("+"));
      expect(segments[1]).toBe(entry["operation"]);
      expect(segments[2]).toBe(entry["checkpoint"]);
      expect(segments[3]).toBe(entry["fault"]);
      expect(segments.length > 4 ? segments[4] : null).toBe(entry["variant"]);
      // The seed is never part of the identity (design 4.1).
      expect(entry["case_id"] as string).not.toContain("seed");
    }
  });

  test("the seed set covers every fault kind checkpoint and lane", () => {
    // What the matrix ships: at least one case per fault kind, per checkpoint,
    // per lane.
    const manifest = loadManifest();
    const cases = manifest["cases"] as CaseEntry[];
    expect(sorted(new Set(cases.map((entry) => entry["fault"] as string)))).toEqual(
      sorted(new Set(contract.FAULT_KINDS)),
    );
    const checkpoints = new Set(cases.map((entry) => entry["checkpoint"] as string));
    for (const checkpoint of contract.CHECKPOINTS) {
      expect(checkpoints.has(checkpoint), `no case anchors at ${checkpoint}`).toBe(true);
    }
    expect(sorted(new Set(cases.map((entry) => entry["lane"] as string)))).toEqual(
      sorted(new Set(contract.LANES)),
    );
  });

  test("every role is killed at every mandated window", () => {
    // Gate item 4: each of the three components, separately, at each window.
    const manifest = loadManifest();
    const singles = new Set(
      (manifest["cases"] as CaseEntry[])
        .filter(
          (entry) => (entry["targets"] as string[]).length === 1 && entry["fault"] === "sigkill",
        )
        .map((entry) => `${(entry["targets"] as string[])[0]}|${entry["checkpoint"]}`),
    );
    for (const role of contract.ROLES) {
      for (const checkpoint of contract.CHECKPOINTS) {
        expect(singles.has(`${role}|${checkpoint}`), `${role} is not killed at ${checkpoint}`).toBe(
          true,
        );
      }
    }
  });

  test("every acceptance section 2 injection has a case", () => {
    // The matrix is the table, row by row (gate item 5). Gate item 5 passes only
    // if *every* case is automated and reproducible. The counting tests above
    // check that the seed set is well formed; this one checks the thing the gate
    // actually asks about -- that each injection the acceptance surface names by
    // phrase has a case behind it.
    const manifest = loadManifest();
    const present = new Set((manifest["cases"] as CaseEntry[]).map((entry) => entry["fault"]));
    for (const [row, injections] of Object.entries(SECTION_2_INJECTIONS)) {
      const missing = injections.filter((fault) => !present.has(fault));
      expect(
        missing,
        `ACCEPTANCE.md section 2 row ${JSON.stringify(row)} has no case for ` +
          `${JSON.stringify(missing)}`,
      ).toEqual([]);
    }
  });

  test("the incident row parameterises Q-0002 rather than answering it", () => {
    // Both halves of Q-0002, covered rather than chosen. The dedup row says the
    // Issue fixes the incident *fields* and not the semantics: whether a repeat
    // increments the retry count on the existing incident or opens a linked one
    // is unresolved, "as is the re-notification window in absolute time -- both
    // are Q-0002", and "tests must parameterise both rather than hard-code
    // either".
    //
    // So the matrix runs both rules and more than one window, and one case's
    // raises fall *outside* its declared window -- without that, the window
    // would be a parameter that never changes an outcome, which is
    // indistinguishable from a hard-coded one.
    const manifest = loadManifest();
    const incidentCases = (manifest["cases"] as CaseEntry[]).filter((entry) =>
      (INCIDENT_FAULTS as readonly string[]).includes(entry["fault"] as string),
    );
    expect(incidentCases.length).toBeGreaterThan(0);
    const parameters = (entry: CaseEntry): Record<string, unknown> =>
      entry["incident_params"] as Record<string, unknown>;
    expect(sorted(new Set(incidentCases.map((entry) => parameters(entry)["collapse"])))).toEqual(
      sorted(new Set(COLLAPSE_RULES)),
    );
    const windows = new Set(
      incidentCases.map((entry) => parameters(entry)["renotify_window_ms"] as number),
    );
    expect(windows.size).toBeGreaterThanOrEqual(2);
    expect(incidentCases.some((entry) => parameters(entry)["expect_collapse"] === false)).toBe(
      true,
    );
    // Q-0003 is a different question and no case settles it.
    expect(
      incidentCases.every((entry) => parameters(entry)["reconcile_interval_ms"] === null),
    ).toBe(true);
    // The dedup key is case data, and the cases do not all spell it one way --
    // Q-0002 asks what composes it, and a matrix whose keys were all one shape
    // would have answered that by inertia.
    const keys = new Set(incidentCases.map((entry) => parameters(entry)["dedup_key"] as string));
    const shapes = new Set([...keys].map((key) => key.split("/").length - 1));
    expect(shapes.size).toBeGreaterThan(1);
  });

  test("the observation row asserts one fact state per injection", () => {
    // interlock D-0006 is about a distinction, so a disjunction would not test
    // it. A read that *fails* and a read that *returns nothing* are different
    // facts about the world, and collapsing them is the defect D-0006 exists to
    // forbid. Each observation case therefore declares one mode, and each mode
    // names exactly one fact state.
    const manifest = loadManifest();
    const cases = (manifest["cases"] as CaseEntry[]).filter(
      (entry) => entry["fault"] === "observation-outage",
    );
    expect(cases.length, "the observation-outage row has no case").toBeGreaterThan(0);
    const observation = (entry: CaseEntry): Record<string, unknown> =>
      entry["observation"] as Record<string, unknown>;
    // Both injections the row names, not just the one that is easier to build.
    expect(sorted(new Set(cases.map((entry) => observation(entry)["mode"] as string)))).toEqual(
      sorted(new Set([contract.OBSERVATION_UNREADABLE, contract.OBSERVATION_SILENT])),
    );
    for (const entry of cases) {
      const mode = observation(entry)["mode"] as string;
      const factState = contract.OBSERVATION_FACT_STATES[mode] as string;
      expect(contract.FACT_STATES as readonly string[]).toContain(factState);
      // The case asks for the escalation it must not get. Without that, "no
      // recommendation was produced" would pass on a driver that has no
      // escalation path at all.
      expect(observation(entry)["escalate_on"]).toEqual([factState]);
      expect((entry["expected"] as { queries: string[] }).queries).toContain(
        contract.INVARIANT_NO_ANOMALY_ESCALATION,
      );
    }
  });

  test("every named invariant is reachable from some case", () => {
    // A name with no case behind it is vocabulary, not coverage. The controller
    // refuses an invariant name it has no assertion for, which catches the
    // opposite mistake. This catches this one.
    const manifest = loadManifest();
    const used = new Set<string>();
    for (const entry of manifest["cases"] as CaseEntry[]) {
      const expected = entry["expected"] as { queries: string[]; destination: string[] };
      for (const name of expected.queries) {
        used.add(name);
      }
      for (const name of expected.destination) {
        used.add(name);
      }
    }
    const unreachable = contract.INVARIANT_NAMES.filter(
      (name) => !used.has(name) && !NOT_YET_ASSERTED.has(name),
    ).sort();
    expect(unreachable, `no case asserts ${JSON.stringify(unreachable)}`).toEqual([]);
  });

  test("the fast profile still covers every fault kind", () => {
    // Design section 9 defines the smoke subset as "one per fault kind". Adding
    // kinds without adding fast cases would quietly redefine the PR lane into a
    // subset that no longer smoke-tests what the matrix injects.
    const manifest = loadManifest();
    const fast = new Set(
      (manifest["cases"] as CaseEntry[])
        .filter((entry) => (entry["profiles"] as string[]).includes("fast"))
        .map((entry) => entry["fault"] as string),
    );
    // Except the one kind design section 9 excludes by name: the smoke subset is
    // "singles only, no staggered", and the budget test below enforces that
    // exclusion from the other side.
    const wanted = contract.FAULT_KINDS.filter((kind) => kind !== "staggered-sigkill");
    const missing = wanted.filter((kind) => !fast.has(kind)).sort();
    expect(missing, `the fast profile smoke-tests no ${JSON.stringify(missing)} case`).toEqual([]);
  });

  test("the combination subsets are covered", () => {
    // "In combination" is enumerated, not implied (design 5).
    const manifest = loadManifest();
    const combinations = new Set(
      (manifest["cases"] as CaseEntry[])
        .filter((entry) => (entry["targets"] as string[]).length > 1)
        .map((entry) => (entry["targets"] as string[]).join("+")),
    );
    expect(combinations.has("sup+disp")).toBe(true);
    expect(combinations.has("disp+sec")).toBe(true);
    expect(combinations.has("sup+sec")).toBe(true);
    expect(combinations.has("sup+disp+sec")).toBe(true);
  });

  test("the pruning rule is recorded in the header", () => {
    // Scale is controlled by policy, not by product; what is pruned is listed.
    const manifest = loadManifest();
    expect((manifest["pruning_rule"] as string).trim()).not.toBe("");
    expect(manifest["pruning_rule"] as string).toContain("cross-product");
  });
});

// ---------------------------------------------------------------------------
// the seed -- design 4.3
// ---------------------------------------------------------------------------

describe("the seed", () => {
  test("the per case seed is order and platform independent", () => {
    // Adding a case does not shift any other case's stream. Derived by sha256
    // over `manifest_version || case_id || suite_seed`, so hash randomisation
    // and OS differences are irrelevant by construction -- there is no hash-table
    // hash anywhere in the derivation.
    const first = caseSeed({ manifestVersion: 1, caseId: "a__b__c__d", suiteSeed: 7 });
    const again = caseSeed({ manifestVersion: 1, caseId: "a__b__c__d", suiteSeed: 7 });
    expect(first).toBe(again);
    // Pinned: the derivation is part of the contract, so a change to it is a
    // contract-version bump and not a quiet re-shuffle of every case's stream.
    // A `bigint` because the value is 64-bit and a `number` would round it --
    // the pin would then hold against a constant that had itself been rounded.
    expect(first).toBe(0x574ff7bdd408ea49n);

    // A different case, a different manifest version and a different suite seed
    // each give a different stream, and none of them disturbs the others.
    expect(first).not.toBe(caseSeed({ manifestVersion: 1, caseId: "a__b__c__e", suiteSeed: 7 }));
    expect(first).not.toBe(caseSeed({ manifestVersion: 2, caseId: "a__b__c__d", suiteSeed: 7 }));
    expect(first).not.toBe(caseSeed({ manifestVersion: 1, caseId: "a__b__c__d", suiteSeed: 8 }));
  });

  test("the seed never appears in a case's identity", () => {
    // The seed selects payload and schedule; the manifest selects everything
    // else.
    const manifest = loadManifest();
    for (const entry of manifest["cases"] as CaseEntry[]) {
      expect(entry).not.toHaveProperty("suite_seed");
      expect(entry).not.toHaveProperty("seed");
    }
  });

  test("the reproduction line carries everything a re-run needs", () => {
    const line = reproLine({
      caseId: "disp__attempt__before_durable_write__sigkill",
      suiteSeed: 99,
      manifestVersion: MANIFEST_VERSION,
      resolvedSkewMs: 31_000,
    });
    expect(line.startsWith("S9-REPRO ")).toBe(true);
    for (const field of [
      "case_id=",
      "suite_seed=",
      "manifest_version=",
      "contract_version=",
      "resolved_skew_ms=",
    ]) {
      expect(line).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// validation refuses what the design says it must refuse
// ---------------------------------------------------------------------------

describe("validation refuses", () => {
  test("a barrier that cannot be reached is refused at collection", () => {
    // Never a timeout in CI (design 3.1). `enqueue` has no after-effect window
    // -- it has no effect -- so arming one is a manifest error, and it is caught
    // before any process is spawned.
    const entry = aCase();
    entry["arms"] = {
      [(entry["targets"] as string[])[0] as string]: ["enqueue@after_effect_before_record:1"],
    };
    expectRefusal(
      () => validateCase(entry),
      ContractViolation,
      "has no after_effect_before_record window",
    );
  });

  test("an effect window case must name a destination assertion", () => {
    // ACCEPTANCE.md section 2: our own rows are not enough there.
    const entry = aCase();
    entry["checkpoint"] = contract.CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD;
    (entry["expected"] as { destination: string[] }).destination = [];
    expectRefusal(() => validateCase(entry), ContractViolation, "name a destination assertion");
  });

  test("a restarting case must name its recovery owner", () => {
    // "Somebody recovered it" is not an assertion (design 5).
    const entry = aCase();
    entry["restart_after"] = true;
    (entry["expected"] as { recovery_owner: string | null }).recovery_owner = null;
    expectRefusal(() => validateCase(entry), ContractViolation, "names the role whose recovery");
  });

  test("a same-role skew observed in flight is invalid by construction", () => {
    // An in-flight call captured its `now_ms` at the call boundary (design 7).
    const entry = aCase();
    entry["skew"] = {
      role: (entry["targets"] as string[])[0],
      direction: "backward",
      observation: "in-flight",
    };
    expectRefusal(() => validateCase(entry), ContractViolation, "next operation");
  });

  test("a sigstop case off the linux lane is refused", () => {
    const entry = aCase();
    entry["fault"] = "sigstop-expire";
    entry["lane"] = contract.LANE_PORTABLE;
    expectRefusal(() => validateCase(entry), ContractViolation, "Linux-lane only");
  });

  test("a duplicate case id fails the run before any case executes", () => {
    const manifest = loadManifest();
    const cases = manifest["cases"] as CaseEntry[];
    manifest["cases"] = [...cases, copy(cases[0] as CaseEntry)];
    expectRefusal(() => validateManifest(manifest), ContractViolation, "duplicate case_id");
  });

  test("growth past a profile budget fails collection", () => {
    // CI creep has to become an explicit budget diff (design 9).
    const manifest = loadManifest();
    const profiles = manifest["profiles"] as Record<string, Record<string, unknown>>;
    profiles["full"] = { ...(profiles["full"] as Record<string, unknown>), max_cases: 1 };
    expectRefusal(() => validateManifest(manifest), ContractViolation, "over its 1-case budget");
  });

  test("a manifest targeting another contract version is refused", () => {
    const manifest = loadManifest();
    manifest["contract_version"] = contract.FAULT_RUNNER_CONTRACT_VERSION + 1;
    expectRefusal(() => validateManifest(manifest), ContractViolation, "fault-runner contract");
  });
});

// ---------------------------------------------------------------------------
// the budgets, as numbers (design 9)
// ---------------------------------------------------------------------------

describe("the budgets", () => {
  test("the profiles carry the budgets the watchdogs enforce", () => {
    // These are harness engineering parameters, not acceptance thresholds. They
    // are revisable by an ordinary reviewed diff and require no `D-` entry.
    // Reading one *as* gate evidence would be a ruling.
    const manifest = loadManifest();
    const profiles = manifest["profiles"] as Record<string, Record<string, unknown>>;
    const fast = profiles["fast"] as Record<string, unknown>;
    const full = profiles["full"] as Record<string, unknown>;
    expect(fast["max_cases"]).toBe(25);
    expect(fast["per_case_timeout_s"]).toBe(15);
    expect(fast["suite_timeout_s"]).toBe(240);
    expect(full["max_cases"]).toBe(200);
    expect(full["per_case_timeout_s"]).toBe(30);
    expect(full["combination_case_timeout_s"]).toBe(60);
    expect(full["suite_timeout_s"]).toBe(1500);

    const fastCases = (manifest["cases"] as CaseEntry[]).filter((entry) =>
      (entry["profiles"] as string[]).includes("fast"),
    );
    expect(
      fastCases.length,
      "the fast profile is the smoke subset, not an empty set",
    ).toBeGreaterThan(0);
    expect(fastCases.length).toBeLessThanOrEqual(fast["max_cases"] as number);
    // The fast profile is singles only and carries no staggered case: the PR
    // matrix never pays for the full matrix.
    expect(fastCases.every((entry) => (entry["targets"] as string[]).length === 1)).toBe(true);
    expect(fastCases.every((entry) => entry["fault"] !== "staggered-sigkill")).toBe(true);
  });

  test("the off-linux add-on stays inside its own budget", () => {
    const manifest = loadManifest();
    const portable = (manifest["cases"] as CaseEntry[]).filter(
      (entry) => entry["lane"] === contract.LANE_PORTABLE,
    );
    expect(portable.length).toBeLessThanOrEqual(20);
    // Nothing signal-shaped runs on the portable lane (design 8.1).
    expect(portable.every((entry) => entry["fault"] !== "sigstop-expire")).toBe(true);
  });

  test("the clock programme is symbolic and resolves against the lease geometry", () => {
    // Skew magnitudes are boundary-relative, not raw numbers (design 7).
    const manifest = loadManifest();
    const ttl = manifest["ttl_ms"] as number;
    const guard = manifest["clock_guard_ms"] as number;
    expect(resolveSkewMs("forward", { ttlMs: ttl, elapsedMs: 0 })).toBe(ttl + guard);
    expect(resolveSkewMs("backward", { ttlMs: ttl, elapsedMs: ttl })).toBe(-(ttl + guard));
    expectRefusal(
      () => resolveSkewMs("42ms", { ttlMs: ttl, elapsedMs: 0 }),
      ContractViolation,
      "never a raw millisecond count",
    );

    for (const entry of manifest["cases"] as CaseEntry[]) {
      for (const programme of [entry["skew"], entry["claimant"]] as (Record<
        string,
        unknown
      > | null)[]) {
        if (programme && "direction" in programme) {
          expect(["forward", "backward"]).toContain(programme["direction"]);
        }
      }
    }
  });
});

/**
 * Every injection ACCEPTANCE.md section 2's table names, mapped to the fault
 * kind that discharges it. This is the table read as a checklist: if a row of
 * the acceptance surface has no case, the matrix is incomplete and the build
 * says so by name rather than by a count.
 */
const SECTION_2_INJECTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  lease: [
    "sigkill-expire", // kill the lease holder without release
    "sigstop-expire", // expire a lease while its holder is paused, and return it
    "clock-fwd", // skew the clock forward across the expiry boundary
    "clock-back", // ... and backward
  ],
  "outbox-resend": [
    "drop-delivery", // drop the delivery
    "sigkill", // kill the sender around the write and the delivery
    "recipient-unavailable", // hold the recipient unavailable across several attempts
  ],
  ack: [
    "lost-ack", // lose the ack in flight
    "dup-ack", // duplicate the ack
    "late-ack", // deliver the ack after the sender has restarted
    "re-ack", // ack an already-acked message
  ],
  dedup: [
    "dup-delivery", // deliver the same message twice, restarting in between
    "incident-repeat", // raise the same incident condition repeatedly
    "incident-replay", // replay a persisted incident packet
  ],
  "single-writer": [
    "writer-race", // two writers race for the same state item
    "sigstop-expire", // a partitioned writer returns after its lease expired
    "resumed-writer-race", // a resumed process and its replacement
  ],
  "observation-outage": [
    "observation-outage", // the observation path fails or returns nothing
  ],
});

/**
 * Invariants whose cases are still to come. `incident-collapse` belongs to the
 * Q-0002 parameterisation, which is a ruling this harness deliberately does not
 * take on its own; its query, its parameters and its assertion are in place so
 * the cases are a manifest diff.
 */
const NOT_YET_ASSERTED: ReadonlySet<string> = new Set([contract.INVARIANT_INCIDENT_COLLAPSE]);

/** Sorted array from a set, so two sets compare by value regardless of order. */
function sorted(values: Iterable<unknown>): unknown[] {
  return [...values].sort();
}

/** Recursively sort object keys, so two structures compare key-order independently. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
