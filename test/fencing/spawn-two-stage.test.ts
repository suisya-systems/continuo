/**
 * `D-0205` restated over two stages: `prepare` admits, `execute` starts.
 *
 * **Target-only.** These cases have no interlock original for the same reason
 * `D-0205`'s own do: in Python the obligation was carried by review and by the
 * module's docstring, and `FencedSpawner` there has no `prepare` / `execute`
 * pair to state it over. They live in their own file rather than in
 * `spawn-precondition.test.ts` so the ported suite there stays a translation --
 * `docs/test-translation-conventions.md`'s reason for keeping a target-only
 * case beside a faithful one rather than inside it -- and so no parity ledger's
 * totals move.
 *
 * `D-0205`'s falsifier names exactly this change:
 *
 * > The production spawn path gaining a **second entry point that does not
 * > route through the precondition** -- at that moment the module-graph
 * > dependency stops being equivalent to the obligation, and the assertion has
 * > to be restated over both entry points (or the second one removed).
 *
 * Step 7 of the minimal operating loop materialises the fence without spawning,
 * so `prepare` is now a production entry point and the assertion is restated
 * here over both. The two halves:
 *
 * * **`prepare` carries the precondition.** Every brokenness class refuses
 *   there, publishes nothing, and yields no plan -- so there is nothing for
 *   `execute` to be handed. This is the same negative shape the ported canary
 *   asserts through `spawn`, driven through the new entry point.
 * * **`execute` cannot be reached around it.** `SpawnPlan`'s constructor is
 *   public (interlock's cases construct one), so "a plan" is not evidence of
 *   admission. `execute` therefore checks provenance: a hand-built plan, and a
 *   plan admitted by a *different* spawner, are both refused. Without this the
 *   split would be exactly the second entry point the falsifier describes.
 *
 * The anti-vacuity half is present throughout: each refusal case is paired with
 * the accepted input, so a `FencedSpawner` that refused everything -- or an
 * `execute` that threw unconditionally -- could not pass this file.
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { renderFence } from "../../src/fencing/renderer.js";
import { FencedSpawner, SpawnOutcome, SpawnPlan } from "../../src/fencing/spawn.js";
import { writeFence } from "../../src/fencing/state.js";
import {
  fenceCaseRoot,
  fenceContext,
  fenceDocument,
  fenceLedger,
  recordingSpawner,
  replaceFenceContext,
} from "./helpers/fence-cases.js";

/** A spawner over the shipped document, with its own ledger inside `root`. */
function spawnerFor(root: string, filename = "ledger.jsonl"): FencedSpawner {
  return new FencedSpawner({ ledger: fenceLedger(root, filename), document: fenceDocument() });
}

describe("prepare carries the precondition", () => {
  test("a good configuration admits, publishes both files, and yields a plan", () => {
    // The anti-vacuity half of every refusal below.
    const root = fenceCaseRoot();
    const ctx = fenceContext(root);
    const outcome = spawnerFor(root).prepare("worker", ctx);

    expect(outcome.admitted).toBe(true);
    expect(outcome.plan).not.toBeNull();
    expect(existsSync(ctx.fencePath)).toBe(true);
    expect(existsSync(join(dirname(ctx.fencePath), "settings.local.json"))).toBe(true);
  });

  test("a broken hook path refuses, publishes nothing, and yields no plan", () => {
    // `hook-unresolvable`, one of the brokenness classes `spawn.ts` enumerates.
    // Asserted through `prepare` rather than `spawn`, which is the whole point
    // of this file: step 7 calls only `prepare`, so a precondition that lived
    // in `spawn`'s wrapper would be bypassed by the lap's own code.
    const root = fenceCaseRoot();
    const ctx = replaceFenceContext(fenceContext(root), {
      hookScript: join(root, "no-such-hook.mjs"),
    });

    const outcome = spawnerFor(root).prepare("worker", ctx);
    expect(outcome.admitted).toBe(false);
    expect(outcome.plan).toBeNull();
    expect(existsSync(ctx.fencePath)).toBe(false);
  });

  test("an absent role refuses and yields no plan", () => {
    const root = fenceCaseRoot();
    const ctx = fenceContext(root);

    const outcome = spawnerFor(root).prepare("no-such-role", ctx);
    expect(outcome.admitted).toBe(false);
    expect(outcome.plan).toBeNull();
    expect(outcome.codes).toContain("role-absent");
    expect(existsSync(ctx.fencePath)).toBe(false);
  });

  test("spawn is prepare then execute, and the outcome is unchanged", () => {
    // The compatibility half. `spawn` is still the composition of the two, so
    // the ported suite's expectations about it are expectations about the same
    // code path the lap uses -- not a parallel one kept in step by hand.
    const root = fenceCaseRoot();
    const ctx = fenceContext(root);
    const spawner = spawnerFor(root);
    const recorder = recordingSpawner();

    const outcome = spawner.spawn("worker", ctx, recorder);
    expect(outcome.admitted).toBe(true);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toBe(outcome.plan);
    expect(outcome.result).toEqual({ pid: 4242 });
  });
});

describe("execute cannot be reached around prepare", () => {
  test("a plan prepare issued is executed, and the spawner is called once", () => {
    // The anti-vacuity half: an `execute` that threw on everything would pass
    // both refusal cases below and fail this one.
    const root = fenceCaseRoot();
    const spawner = spawnerFor(root);
    const admission = spawner.prepare("worker", fenceContext(root));
    const recorder = recordingSpawner();

    const outcome = spawner.execute(admission, recorder);
    expect(recorder.calls).toEqual([admission.plan]);
    expect(outcome.result).toEqual({ pid: 4242 });
    // The fence and battery survive the split rather than being rebuilt.
    expect(outcome.fence).toBe(admission.fence);
    expect(outcome.battery).toBe(admission.battery);
  });

  test("a hand-built plan is refused, and the spawner is never invoked", () => {
    // `SpawnPlan`'s constructor is public and stays public -- interlock's cases
    // construct one -- so the type is not evidence of admission. This is the
    // case that says so: a structurally perfect plan, built from a fence that
    // was really rendered, is still refused because no spawner admitted it.
    const root = fenceCaseRoot();
    const spawner = spawnerFor(root);
    const admission = spawner.prepare("worker", fenceContext(root));
    const admitted = admission.plan;
    expect(admitted).not.toBeNull();
    if (admitted === null) {
      return;
    }

    const forged = new SpawnPlan({
      role: admitted.role,
      fence: admitted.fence,
      settingsPath: admitted.settingsPath,
      fencePath: admitted.fencePath,
      context: admitted.context,
    });
    const recorder = recordingSpawner();

    const forgedOutcome = new SpawnOutcome({
      admitted: true,
      role: admitted.role,
      fence: admitted.fence,
      plan: forged,
      battery: admission.battery,
    });

    expect(() => spawner.execute(forgedOutcome, recorder)).toThrow(/did not admit/);
    expect(recorder.calls).toEqual([]);
  });

  test("a plan another spawner admitted is refused, and the spawner is never invoked", () => {
    // The cross-instance case, which the forged-plan case above does not cover:
    // this plan WAS admitted, by a real `prepare`, against a real fence -- just
    // not by the spawner being asked to execute it. Provenance is per-object
    // because the fence a plan describes can have been replaced on disk since,
    // and the second spawner has no record that it was not.
    const root = fenceCaseRoot();
    const first = spawnerFor(root, "first.jsonl");
    const second = spawnerFor(root, "second.jsonl");
    const admission = first.prepare("worker", fenceContext(root));
    const recorder = recordingSpawner();

    expect(() => second.execute(admission, recorder)).toThrow(/did not admit/);
    expect(recorder.calls).toEqual([]);
  });

  test("one admission starts one child: a second execute is refused", () => {
    // The ledger records one `spawn-admitted` per admission. Two children under
    // one record would make the durable count an undercount of what actually
    // started -- the direction this module never goes -- and a retry loop or a
    // duplicated composition root reaches it without doing anything exotic.
    const root = fenceCaseRoot();
    const spawner = spawnerFor(root);
    const admission = spawner.prepare("worker", fenceContext(root));
    const recorder = recordingSpawner();

    spawner.execute(admission, recorder);
    expect(recorder.calls).toHaveLength(1);

    expect(() => spawner.execute(admission, recorder)).toThrow(/did not admit/);
    expect(recorder.calls).toHaveLength(1);
  });

  test("a spawner that throws still consumes its admission", () => {
    // Consumed BEFORE the callable, deliberately: a failed start is still a
    // start attempted under this admission, and the fence on disk may have been
    // read by then. The retry is a fresh `prepare`, which re-renders, re-proves
    // and re-publishes -- and that is how a caller finds out the fence was
    // replaced underneath it.
    const root = fenceCaseRoot();
    const spawner = spawnerFor(root);
    const admission = spawner.prepare("worker", fenceContext(root));

    expect(() =>
      spawner.execute(admission, () => {
        throw new Error("the child would not start");
      }),
    ).toThrow(/the child would not start/);

    const recorder = recordingSpawner();
    expect(() => spawner.execute(admission, recorder)).toThrow(/did not admit/);
    expect(recorder.calls).toEqual([]);

    // And a fresh admission works, so the consumption is not a one-way door for
    // the spawner itself.
    const again = spawner.prepare("worker", fenceContext(root));
    spawner.execute(again, recorder);
    expect(recorder.calls).toHaveLength(1);
  });

  test("a later admission publishing a DIFFERENT fence invalidates the earlier plan", () => {
    // The stale-plan hole, stated as what it actually is. Two admissions at one
    // fence path write to the same file, so the second's bytes are what a child
    // would run under -- and if they differ from the first plan's, executing
    // that plan starts a child under a fence nobody checked it against.
    //
    // Driven with two roles rather than two identical renders, because identical
    // renders are not the failure: see the next case.
    const root = fenceCaseRoot();
    const ctx = fenceContext(root);
    const spawner = spawnerFor(root);

    const worker = spawner.prepare("worker", ctx);
    const secretary = spawner.prepare("secretary", ctx);
    expect(secretary.admitted).toBe(true);

    const recorder = recordingSpawner();
    expect(() => spawner.execute(worker, recorder)).toThrow(/no longer the one this plan/);
    expect(recorder.calls).toEqual([]);

    // The live one still works, so the check replaces rather than poisons.
    spawner.execute(secretary, recorder);
    expect(recorder.calls).toEqual([secretary.plan]);
  });

  test("an identical re-admission leaves the earlier plan executable, deliberately", () => {
    // Under the old bookkeeping this was refused, and refusing it was wrong.
    // Two `prepare` calls for one role and one context render the SAME fence and
    // publish the SAME bytes, so "which admission do these files belong to" is a
    // distinction with no difference on disk: the child would run under exactly
    // the fence its plan describes, which is the property that matters. The
    // ledger carries two `spawn-admitted` lines and one child starts -- an
    // overcount of admissions, never an undercount of children.
    const root = fenceCaseRoot();
    const ctx = fenceContext(root);
    const spawner = spawnerFor(root);

    const first = spawner.prepare("worker", ctx);
    spawner.prepare("worker", ctx);

    const recorder = recordingSpawner();
    spawner.execute(first, recorder);
    expect(recorder.calls).toEqual([first.plan]);
  });

  test("a fence replaced from outside this process is caught", () => {
    // The case no in-process record could ever see, and the reason the check
    // moved onto the artifacts. Nothing here calls `prepare` a second time; the
    // published fence is simply overwritten, as another process or an operator's
    // hand would overwrite it.
    const root = fenceCaseRoot();
    const ctx = fenceContext(root);
    const spawner = spawnerFor(root);
    const admission = spawner.prepare("worker", ctx);

    writeFence(renderFence("secretary", ctx, { document: fenceDocument() }), ctx.fencePath);

    const recorder = recordingSpawner();
    expect(() => spawner.execute(admission, recorder)).toThrow(/no longer the one this plan/);
    expect(recorder.calls).toEqual([]);
  });

  test("a settings file replaced after admission is caught", () => {
    // Checked as well as the fence, and not as belt and braces: the fence is
    // what the deny hook reads, but `settings.local.json` is what carries the
    // hooks block to the CLI. A child launched with a settings file that lost
    // its `hooks` entry runs with no deny hook at all -- and its fence would sit
    // on disk pristine and unread.
    const root = fenceCaseRoot();
    const spawner = spawnerFor(root);
    const admission = spawner.prepare("worker", fenceContext(root));
    const plan = admission.plan;
    expect(plan).not.toBeNull();
    if (plan === null) {
      return;
    }

    writeFileSync(plan.settingsPath, JSON.stringify({ permissionMode: "default" }), "utf8");

    const recorder = recordingSpawner();
    expect(() => spawner.execute(admission, recorder)).toThrow(/no longer the ones this plan/);
    expect(recorder.calls).toEqual([]);
  });

  test("an unreadable fence refuses rather than being taken on trust", () => {
    // Fail-closed in every branch: a fence that cannot be read back is not a
    // fence that was verified.
    const root = fenceCaseRoot();
    const spawner = spawnerFor(root);
    const admission = spawner.prepare("worker", fenceContext(root));
    const plan = admission.plan;
    if (plan === null) {
      return;
    }

    writeFileSync(plan.fencePath, "{ not json", "utf8");

    const recorder = recordingSpawner();
    expect(() => spawner.execute(admission, recorder)).toThrow(/cannot be read back/);
    expect(recorder.calls).toEqual([]);
  });

  test("admissions at different fence paths do not interfere", () => {
    const root = fenceCaseRoot();
    const spawner = spawnerFor(root);
    const first = spawner.prepare("worker", fenceContext(join(root, "a")));
    const second = spawner.prepare("worker", fenceContext(join(root, "b")));

    const recorder = recordingSpawner();
    spawner.execute(first, recorder);
    spawner.execute(second, recorder);
    expect(recorder.calls).toEqual([first.plan, second.plan]);
  });

  test("mutating the plan's settings cannot make weakened files look admitted", () => {
    // `Fence` freezes itself but stores `settings` by reference, so
    // `plan.fence.settings` is mutable after `prepare` returns. A caller could
    // delete the `hooks` block from it, rewrite BOTH published files from the
    // mutated object, and a verification that compared the files against
    // `plan.fence` would find them in perfect agreement -- and start a child
    // with no deny hook. The expectation is therefore snapshotted at admission,
    // before the plan is ever exposed, so it is not reachable from the value
    // the caller holds.
    const root = fenceCaseRoot();
    const ctx = fenceContext(root);
    const spawner = spawnerFor(root);
    const admission = spawner.prepare("worker", ctx);
    const plan = admission.plan;
    expect(plan).not.toBeNull();
    if (plan === null) {
      return;
    }

    const settings = plan.fence.settings as Record<string, unknown>;
    expect(settings["hooks"]).toBeDefined();
    delete settings["hooks"];
    // Republish both files from the weakened object, exactly as an attacker
    // holding the plan would.
    writeFence(plan.fence, plan.fencePath);
    writeFileSync(plan.settingsPath, JSON.stringify(plan.fence.settings), "utf8");

    const recorder = recordingSpawner();
    expect(() => spawner.execute(admission, recorder)).toThrow(/no longer/);
    expect(recorder.calls).toEqual([]);
  });

  test("a refused outcome is refused by execute, and the spawner is never invoked", () => {
    // The zero-call canary of D-0205 obligation 2, restated over the second
    // stage. A refused outcome carries no plan, so this is the state a caller
    // reaches by ignoring `outcome.admitted` -- the ordinary mistake, and the
    // one that would start a child under no fence at all.
    const root = fenceCaseRoot();
    const spawner = spawnerFor(root);
    const refused = spawner.prepare("no-such-role", fenceContext(root));
    const recorder = recordingSpawner();

    expect(refused.admitted).toBe(false);
    expect(() => spawner.execute(refused, recorder)).toThrow(/refused spawn outcome/);
    expect(recorder.calls).toEqual([]);
  });
});
