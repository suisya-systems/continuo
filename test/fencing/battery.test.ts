/**
 * The breach-probe battery, and the coverage claim it is allowed to make.
 *
 * Ported from interlock `tests/fencing/test_battery_coverage.py` at `65f36c5`.
 * Every case here maps to one source node id.
 *
 * Interlock's issue #9 second criterion: "Every rule in every role's fence has
 * a probe, and each probe is **denied**. Coverage is asserted mechanically
 * against the rendered fence -- a hand-maintained probe list that silently
 * drifts from the fence is a failure of this criterion."
 *
 * So the cases here do two different jobs, and the second is the one that
 * lasts:
 *
 * 1. assert coverage and denial for the fence as it stands today, and
 * 2. assert that coverage is *derived*, by adding a rule to a fence at runtime
 *    and requiring the battery to grow with it. A suite that only did (1) would
 *    pass forever against a probe list that had stopped tracking the fence.
 *
 * The second job is why nothing in this file names a probe. A translation that
 * enumerated today's probes would be green on the day a rule is added and
 * nobody probed it, which is the single failure this battery exists to make
 * impossible.
 */

import { describe, expect, test } from "vitest";

import { ProbeSynthesisError, probeFor, probesFor, runBattery } from "../../src/fencing/battery.js";
import { pyRepr } from "../../src/fencing/pyrepr.js";
import {
  type FenceContext,
  type RoleDocument,
  renderFence,
  roleNames,
} from "../../src/fencing/renderer.js";
import {
  Fence,
  FenceRule,
  KIND_PERMISSION_DENY,
  KIND_SANDBOX_DENY_WRITE,
  LAYER_PERMISSIONS,
  LAYER_SANDBOX,
  makeDecision,
  RuleSyntaxError,
} from "../../src/fencing/rules.js";
import { fenceContext, fenceDocument } from "./helpers/fence-cases.js";

/**
 * The source's module-level `_fence(ctx, document, role)`.
 *
 * The argument order is the source's, not `renderFence`'s, so a reader
 * comparing the two files line by line is not also reconciling a reordering.
 */
function fenceOf(ctx: FenceContext, document: RoleDocument, role: string): Fence {
  return renderFence(role, ctx, { document });
}

/**
 * The `ctx` and `document` fixtures, as one per-test call.
 *
 * Function scope in the source, and function scope here: `fenceContext`
 * acquires a per-test temporary directory and registers its own removal at
 * acquisition, so one call per test is also one cleanup per test.
 */
function fixtures(): { ctx: FenceContext; document: RoleDocument } {
  return { ctx: fenceContext(), document: fenceDocument() };
}

describe("coverage is mechanical", () => {
  test("every rule of every role has exactly one probe", () => {
    const { ctx, document } = fixtures();
    for (const role of roleNames(document)) {
      const fence = fenceOf(ctx, document, role);
      const probes = probesFor(fence);
      expect(new Set(probes.map((probe) => probe.ruleId))).toEqual(new Set(fence.ruleIds()));
      expect(probes.length, `${role}: probes are not 1:1 with rules`).toBe(fence.rules.length);
    }
  });

  test("every probe is denied by the rule it targets", () => {
    // Denied *by its own rule*, not merely denied.
    //
    // A probe that trips a neighbouring rule would let a broken rule hide
    // behind a working one, and the battery would still be green. So the
    // per-result assertion below is the load-bearing half: `allDenied` alone
    // is satisfied by a fence in which one rule denies everything.
    const { ctx, document } = fixtures();
    for (const role of roleNames(document)) {
      const report = runBattery(fenceOf(ctx, document, role));
      expect(report.allDenied, pyRepr(report.breaches.map((breach) => breach.probe.ruleId))).toBe(
        true,
      );
      for (const result of report.results) {
        expect(result.decision.ruleId).toBe(result.probe.ruleId);
      }
    }
  });

  test("coverage grows when a rule is added", () => {
    // The anti-drift assertion.
    //
    // This is the test that would fail if someone replaced the derived battery
    // with a hand-written list. The list would still cover today's fence; it
    // would not cover a rule invented here.
    const { ctx, document } = fixtures();
    const fence = fenceOf(ctx, document, "worker");
    const extra = new FenceRule(
      LAYER_PERMISSIONS,
      KIND_PERMISSION_DENY,
      "Bash",
      "shutdown --now *",
    );
    const grown = new Fence({
      role: fence.role,
      roleKind: fence.roleKind,
      permissionMode: fence.permissionMode,
      rules: [...fence.rules, extra],
      settings: fence.settings,
    });
    const before = runBattery(fence);
    const after = runBattery(grown);
    expect(before.coveredRuleIds.has(extra.ruleId)).toBe(false);
    expect(after.coveredRuleIds.has(extra.ruleId)).toBe(true);
    expect(after.allDenied).toBe(true);
    expect(after.results.length).toBe(before.results.length + 1);
  });

  test("a rule whose probe cannot be synthesized is an error not a gap", () => {
    // Fatal, not skipped.
    //
    // Skipping the rule would leave it unprobed while the battery still
    // reported full coverage -- the exact failure this battery exists to make
    // impossible.
    const broken = new FenceRule(LAYER_PERMISSIONS, "no-such-kind", "Bash", "x");

    // The source is `pytest.raises(Exception)` followed by
    // `isinstance(excinfo.value, (ProbeSynthesisError, ValueError))`: an
    // either/or, deliberately. `FenceRule.matches` refuses an unknown kind
    // before `probeFor` reaches its own refusal, so which of the two arrives
    // is a fact about the order of two guards rather than about the property
    // under test -- and pinning today's answer would turn a reordering that
    // keeps the rule fatal into a red test. `RuleSyntaxError` is this port's
    // `ValueError` subclass (`rules.ts`), so the pair is transcribed, not
    // narrowed. `expectRefusal` is not usable here for the same reason: it
    // takes one class.
    let thrown: unknown;
    let threw = false;
    try {
      probeFor(broken);
    } catch (error) {
      threw = true;
      thrown = error;
    }
    expect(threw, "expected probeFor to refuse an unknown rule kind").toBe(true);
    expect(
      thrown instanceof ProbeSynthesisError || thrown instanceof RuleSyntaxError,
      `expected ProbeSynthesisError or RuleSyntaxError, got ${String(thrown)}`,
    ).toBe(true);
  });

  test("the battery reports a breach rather than hiding it", () => {
    // A rule that does not deny its own probe must surface as a breach.
    //
    // Constructed by handing the battery a fence whose rule cannot match the
    // operand its own kind implies: the report must be red, not silently
    // short. The injected `evaluate` is the source's construction of that --
    // it is what makes "does not deny" reachable without a rule that is
    // broken in some other, incidental way.
    const { ctx, document } = fixtures();
    const fence = fenceOf(ctx, document, "worker");
    const blind = new Fence({
      role: fence.role,
      roleKind: fence.roleKind,
      permissionMode: fence.permissionMode,
      rules: fence.rules,
      settings: fence.settings,
    });
    const report = runBattery(blind, { evaluate: () => neverDenies() });
    expect(report.allDenied).toBe(false);
    expect(report.breaches.length).toBe(fence.rules.length);
  });
});

/** The source's module-level `_never_denies()`. */
function neverDenies() {
  return makeDecision({ denied: false });
}

describe("probes are forbidden operations", () => {
  test("a probe operand is inert", () => {
    // Probes are evaluated, never executed -- but they must still be safe to
    // read in a log or paste into a shell by accident.
    //
    // `pyRepr`, not `JSON.stringify`: the source asserts against
    // `repr(probe.tool_input)`, and the two renderings differ in quoting and
    // in escaping, so a substring test against the wrong one is a test of a
    // string interlock never produces.
    const { ctx, document } = fixtures();
    for (const role of roleNames(document)) {
      for (const probe of probesFor(fenceOf(ctx, document, role))) {
        const blob = pyRepr(probe.toolInput);
        expect(blob).not.toContain("rm -rf /");
        expect(blob).not.toContain(";");
        expect(blob).not.toContain("&&");
      }
    }
  });

  test("sandbox write probes target the denied path", () => {
    const { ctx, document } = fixtures();
    const fence = fenceOf(ctx, document, "worker");
    const writes = fence.rules.filter((rule) => rule.kind === KIND_SANDBOX_DENY_WRITE);
    expect(writes.length).toBeGreaterThan(0);
    for (const rule of writes) {
      const probe = probeFor(rule);
      expect(probe.toolName).toBe("Write");
      const filePath = probe.toolInput["file_path"];
      expect(typeof filePath).toBe("string");
      expect(String(filePath).startsWith(rule.spec)).toBe(true);
    }
  });

  test("a probe aimed at one role does not certify another", () => {
    // Per-role probing is what interlock's D-0023 rules out; this pins the
    // difference. The roles do not have the same fences, so their probe sets
    // must not be interchangeable.
    const { ctx, document } = fixtures();
    const worker = new Set(
      probesFor(fenceOf(ctx, document, "worker")).map((probe) => probe.ruleId),
    );
    const secretary = new Set(
      probesFor(fenceOf(ctx, document, "secretary")).map((probe) => probe.ruleId),
    );
    expect(worker).not.toEqual(secretary);
    // The second half, and not redundant: two sets can differ while the worker
    // set is a strict *subset*, in which case a secretary battery would in
    // fact certify every rule the worker has. The source asserts the
    // difference is non-empty, so the direction is pinned too.
    const difference = [...worker].filter((ruleId) => !secretary.has(ruleId));
    expect(difference.length).toBeGreaterThan(0);
  });
});

describe("layer ordering", () => {
  test("a sandbox deny is not overridable by the permission layer", () => {
    const { ctx, document } = fixtures();
    const fence = fenceOf(ctx, document, "worker");
    const sandboxRules = fence.rules.filter((rule) => rule.layer === LAYER_SANDBOX);
    expect(sandboxRules.length).toBeGreaterThan(0);
    for (const rule of sandboxRules) {
      const probe = probeFor(rule);
      const decision = fence.decide(probe.toolName, probe.toolInput);
      expect(decision.layer).toBe(LAYER_SANDBOX);
    }
  });
});
