import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { probesFor, runBattery } from "../../src/fencing/battery.js";
import { pyJsonDumps, pyJsonLoads } from "../../src/fencing/pyjson.js";
import {
  type FenceContext,
  type RoleDocument,
  renderFence,
  roleNames,
} from "../../src/fencing/renderer.js";
import type { Fence } from "../../src/fencing/rules.js";
import type { SpawnOutcome, SpawnPlan } from "../../src/fencing/spawn.js";
import { diffFences, FenceStateError, readFence, writeFence } from "../../src/fencing/state.js";
import { expectRefusal } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";
import {
  fenceCaseRoot,
  fenceContext,
  fenceDocument,
  fenceLedger,
  mutate,
  replaceFenceContext,
  spawnFor,
} from "./helpers/fence-cases.js";

/**
 * An Interlock-initiated restart preserves the fence.
 *
 * Ported from interlock `tests/fencing/test_restart_preserves_fence.py` at
 * `65f36c5`. Every case here maps to one source node id.
 *
 * Issue #9's first criterion, re-pointed by C2: "Under C2 the restart in
 * question is Interlock respawning a `-p` child from persisted state -- **there
 * is no other kind**." D-0027 removed the provider-supervisor restart path
 * entirely, and `#8` -- the issue that would have probed it -- was closed as
 * **moot, not passed**. So the whole of "survives restart" is the respawn
 * modelled here.
 *
 * The criterion's own wording fixes the METHOD, and the translation keeps it:
 * the fence is shown preserved "by the breach battery denying every rule after
 * restart as it did before". Not by comparing rule counts, not by trusting the
 * persisted file -- by RE-RUNNING the battery on the far side. A translation
 * that asserted a rule count where the source re-runs the battery would be
 * green against a persisted fence whose rules had all stopped denying, which is
 * the one outcome this criterion exists to exclude.
 *
 * What this cannot show is stated in `docs/per-role-fencing.md` and in the gate
 * record: the rendered-input diff proves what Interlock wrote, not what the
 * provider loaded. That gap is item 3's residual.
 */

/**
 * `outcome.plan` on an admitted outcome.
 *
 * `SpawnPlan | None` in the source too, but Python reaches `outcome.plan.
 * fence_path` unguarded and raises `AttributeError` on `None`. TypeScript
 * refuses the unguarded read at compile time, so the guard is written once
 * here rather than as a non-null assertion at each of the fourteen call sites:
 * an assertion suppresses the check, while this one FAILS, and it names the
 * role while doing it.
 */
function planOf(outcome: SpawnOutcome): SpawnPlan {
  const plan = outcome.plan;
  if (plan === null) {
    throw new Error(`${outcome.role}: an admitted spawn carries no plan`);
  }
  return plan;
}

/** `outcome.fence`, same reasoning as {@link planOf}. */
function fenceOf(outcome: SpawnOutcome): Fence {
  const fence = outcome.fence;
  if (fence === null) {
    throw new Error(`${outcome.role}: an admitted spawn carries no fence`);
  }
  return fence;
}

/**
 * `json.loads(path.read_text(encoding="utf-8"))` over a published fence.
 *
 * `pyJsonLoads`, not `JSON.parse`: the cases below edit one field of the
 * payload and write it back with `pyJsonDumps`, and only this pair carries the
 * SOURCE key order across the round trip. `JSON.parse` hoists integer-like
 * keys, which would reorder a persisted rule and make the file these cases
 * hand to `readFence` differ from the one interlock hands to `read_fence` in a
 * way no assertion here would mention.
 */
function payloadOf(path: string): Record<string, unknown> {
  return pyJsonLoads(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** `payload["rules"]`, as the list of objects the source subscripts. */
function rulesOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const rules = payload["rules"];
  if (!Array.isArray(rules)) {
    throw new Error("the persisted fence has no 'rules' list");
  }
  return rules as Record<string, unknown>[];
}

/**
 * `sequence[index]` as Python performs it: present, or `IndexError`.
 *
 * `noUncheckedIndexedAccess` types every element read as possibly `undefined`,
 * and the two ways out of that are a non-null assertion or this. The assertion
 * is the wrong one here: the cases below index a fence's rule list at a FIXED
 * offset (2, 3, 0), so an index that fell off the end would mean the shipped
 * document had shrunk -- exactly the kind of drift this belt exists to notice,
 * and `!` would turn it into a `TypeError` about `undefined` several lines
 * later instead of a message naming the list and the offset.
 */
function at<T>(sequence: readonly T[], index: number, what: string): T {
  const item = sequence[index];
  if (item === undefined) {
    throw new Error(`${what}: no element at index ${index} (length ${sequence.length})`);
  }
  return item;
}

/** `path.write_text(json.dumps(payload), encoding="utf-8")`. */
function writePayload(path: string, payload: Record<string, unknown>): void {
  writeFileSync(path, pyJsonDumps(payload), "utf8");
}

/**
 * `document["roles"]["worker"]["permissions"]["deny"]`.
 *
 * Throws where Python raises `KeyError`/`TypeError`, rather than returning an
 * empty list: the one case that reads this slices the first two entries out of
 * it to build a WEAKENED role, and an empty list would build a role with no
 * denials at all -- which refuses to render, so the case would fail for a
 * reason that has nothing to do with the diff it is asserting on.
 */
function denyListOf(document: RoleDocument, role: string): unknown[] {
  const roles = document.roles as Record<string, unknown>;
  const body = roles[role] as Record<string, unknown> | undefined;
  const permissions = body?.["permissions"] as Record<string, unknown> | undefined;
  const deny = permissions?.["deny"];
  if (!Array.isArray(deny)) {
    throw new Error(`${role}: the shipped document has no permissions.deny list`);
  }
  return [...deny];
}

/**
 * The `ctx`, `document` and `ledger` fixtures, as one per-test call.
 *
 * `root` is returned alongside them because it IS the source's `tmp_path`: the
 * `ctx` fixture is built from it, and three cases build a second path under the
 * same directory (`tmp_path / role / "fence.json"`, `tmp_path / f"{role}.jsonl"`,
 * `tmp_path / "fence.json"`). Handing back a different directory would make
 * those siblings of nothing, and the case that asserts no `.tmp` file is left
 * beside the published fence would then be looking in an empty directory.
 */
function fixtures(): {
  root: string;
  ctx: FenceContext;
  document: RoleDocument;
  ledger: ReturnType<typeof fenceLedger>;
} {
  const root = fenceCaseRoot();
  return { root, ctx: fenceContext(root), document: fenceDocument(), ledger: fenceLedger(root) };
}

/** `b"\r\n"`, as the needle `Buffer.includes` takes. */
const CRLF = Buffer.from("\r\n", "ascii");

/** `b"\n"[0]`: the byte a published file has to end on. */
const LF = 0x0a;

describe("the battery holds across restart", () => {
  test("every rule is denied before and after an interlock respawn", () => {
    const { ctx, document, ledger } = fixtures();
    const first = spawnFor(ctx, document, ledger);
    const before = runBattery(fenceOf(first));
    expect(before.allDenied).toBe(true);

    // The crash. Interlock is gone; the persisted fence is all that is left.
    const restored = readFence(planOf(first).fencePath);

    // The respawn, from persisted state. The battery is RE-RUN here -- the
    // criterion's method -- rather than the restored fence being compared to
    // the first one.
    const after = runBattery(restored);
    expect(after.allDenied).toBe(true);
    expect(after.coveredRuleIds).toEqual(before.coveredRuleIds);
    // `zip` stops at the shorter sequence, and so does this. Reproducing that
    // is safe only because the set equality above already pins that the two
    // batteries cover the same rule ids; without it a truncated `after` would
    // slip through, which is the source's shape and not a licence to write it
    // in a case that lacks the set assertion.
    const pairs = Math.min(after.results.length, before.results.length);
    for (let index = 0; index < pairs; index += 1) {
      const a = at(after.results, index, "the battery after the restart");
      const b = at(before.results, index, "the battery before the restart");
      expect(a.probe.ruleId).toBe(b.probe.ruleId);
      expect(a.decision.ruleId).toBe(b.decision.ruleId);
    }
  });

  test("every role holds across restart", () => {
    const { root, ctx, document } = fixtures();
    for (const role of roleNames(document)) {
      const roleCtx = replaceFenceContext(ctx, { fencePath: join(root, role, "fence.json") });
      const outcome = spawnFor(roleCtx, document, fenceLedger(root, `${role}.jsonl`), role);
      const restored = readFence(planOf(outcome).fencePath);
      const report = runBattery(restored);
      expect(report.allDenied, role).toBe(true);
      expect(report.coveredRuleIds).toEqual(new Set(fenceOf(outcome).ruleIds()));
    }
  });

  test("a re render after restart matches the persisted fence", () => {
    // The rendered-input diff the issue asks for.
    //
    // Interlock respawning from persisted state may either re-render or read
    // back; the two must agree, or "the fence survived" would depend on which
    // path the restart happened to take.
    const { ctx, document, ledger } = fixtures();
    const outcome = spawnFor(ctx, document, ledger);
    const persisted = readFence(planOf(outcome).fencePath);
    const reRendered = renderFence("worker", ctx, { document });
    const diff = diffFences(persisted, reRendered);
    expect(diff.identical, pyJsonDumps(diff.toJson())).toBe(true);
  });

  test("the diff reports a fence that did change", () => {
    // The diff has to be capable of saying no, or its yes means nothing.
    const { ctx, document, ledger } = fixtures();
    const outcome = spawnFor(ctx, document, ledger);
    const weakened = mutate(document, "worker", {
      permissions: { allow: [], deny: denyListOf(document, "worker").slice(0, 2) },
    });
    const diff = diffFences(fenceOf(outcome), renderFence("worker", ctx, { document: weakened }));
    expect(diff.identical).toBe(false);
    // `assert diff.removed_rules` is Python truthiness over a tuple: non-empty,
    // not merely present.
    expect(diff.removedRules.length).toBeGreaterThan(0);
    expect(diff.settingsChanged).toBe(true);
  });

  test("a rule dropped across restart shows up as an unprobed gap", () => {
    // The failure mode the criterion exists to catch: a restart that comes back
    // with a *smaller* fence and no error anywhere.
    const { ctx, document, ledger } = fixtures();
    const outcome = spawnFor(ctx, document, ledger);
    const fencePath = planOf(outcome).fencePath;
    const payload = payloadOf(fencePath);
    // `list.pop(3)`: removes the rule at index 3 and hands it back.
    const dropped = at(rulesOf(payload).splice(3, 1), 0, "the rule dropped from the fence");
    writePayload(fencePath, payload);

    const restored = readFence(fencePath);
    const after = runBattery(restored);
    // The battery on the far side is still green -- it can only probe the rules
    // it was given. It is the *diff* that catches the loss, which is exactly why
    // the criterion asks for both.
    expect(after.allDenied).toBe(true);
    const missing = fenceOf(outcome)
      .ruleIds()
      .filter((ruleId) => !after.coveredRuleIds.has(ruleId));
    expect(missing.length).toBeGreaterThan(0);
    const diff = diffFences(fenceOf(outcome), restored);
    expect(diff.identical).toBe(false);
    expect(diff.removedRules.length).toBeGreaterThan(0);
    const droppedId = `${dropped["layer"]}:${dropped["kind"]}:${dropped["tool"]}:${dropped["spec"]}`;
    expect(diff.removedRules).toContain(droppedId);
  });
});

describe("persistence fails closed", () => {
  test("a truncated fence file is an error not a smaller fence", () => {
    const { ctx, document, ledger } = fixtures();
    const outcome = spawnFor(ctx, document, ledger);
    const fencePath = planOf(outcome).fencePath;
    const raw = readFileSync(fencePath, "utf8");
    // `raw[: len(raw) // 2]`. Python slices by code point and JavaScript by
    // UTF-16 unit; the published fence is `ensure_ascii` JSON, so the two
    // agree here -- and if it ever stopped being ASCII the halves would still
    // both be broken JSON, which is what the case asserts on.
    writeFileSync(fencePath, raw.slice(0, Math.floor(raw.length / 2)), "utf8");
    expectRefusal(() => readFence(fencePath), FenceStateError);
  });

  test("a fence with no rules is rejected on read", () => {
    const root = fenceCaseRoot();
    const path = join(root, "fence.json");
    writeFileSync(
      path,
      pyJsonDumps({
        format: 1,
        role: "worker",
        role_kind: "worker",
        permission_mode: "default",
        rules: [],
        settings: {},
      }),
      "utf8",
    );
    expectRefusal(() => readFence(path), FenceStateError);
  });

  // Valid JSON is not a valid fence.
  //
  // Coercing these fields with `str()` fails in the SILENT direction: a
  // mistyped `layer` is skipped by the decision function and a `null` spec
  // becomes the string `"None"` and matches nothing. Either removes a denial
  // while the hook goes on treating the fence as sound. So the assertion is
  // that the read REFUSES, never that the value came back changed.
  parametrize<readonly [field: string, value: unknown]>(
    "a corrupted rule field is rejected rather than coerced",
    [
      ["layer-typo-layer", ["layer", "typo-layer"]],
      ["kind-typo-kind", ["kind", "typo-kind"]],
      ["spec-None", ["spec", null]],
      ["tool-None", ["tool", null]],
      ["spec-", ["spec", ""]],
      ["layer-7", ["layer", 7]],
    ],
    ([field, value]) => {
      const { ctx, document, ledger } = fixtures();
      const outcome = spawnFor(ctx, document, ledger);
      const fencePath = planOf(outcome).fencePath;
      const payload = payloadOf(fencePath);
      // `payload["rules"][2][field] = value`, including when `value` is `None`:
      // the key is SET to null, never deleted. A deleted key is a different
      // corruption (a missing field) and is a different code path in
      // `fenceFromJson`.
      at(rulesOf(payload), 2, "the persisted rules")[field] = value;
      writePayload(fencePath, payload);
      expectRefusal(() => readFence(fencePath), FenceStateError);
    },
  );

  test("a rule that is not an object is rejected", () => {
    const { ctx, document, ledger } = fixtures();
    const outcome = spawnFor(ctx, document, ledger);
    const fencePath = planOf(outcome).fencePath;
    const payload = payloadOf(fencePath);
    rulesOf(payload)[0] = "Bash(git push *)" as unknown as Record<string, unknown>;
    writePayload(fencePath, payload);
    expectRefusal(() => readFence(fencePath), FenceStateError);
  });

  test("an unknown format version is rejected", () => {
    const { ctx, document, ledger } = fixtures();
    const outcome = spawnFor(ctx, document, ledger);
    const fencePath = planOf(outcome).fencePath;
    const payload = payloadOf(fencePath);
    payload["format"] = 99;
    writePayload(fencePath, payload);
    expectRefusal(() => readFence(fencePath), FenceStateError);
  });

  test("the published files carry lf endings on every platform", () => {
    // Same convention as `curator.ledger` (PR #35).
    //
    // Text mode emits CRLF on Windows, which would make the same fence a
    // different file byte-for-byte depending on where it was published -- and
    // the publication rollback in `spawn.ts` restores this file **by bytes**,
    // so a platform-dependent separator would turn "put it back" into "put
    // something else back".
    //
    // The assertion is therefore on BYTES. Reading these files as text would
    // decode the separator away and the case would pass on the platform it
    // exists to fail on.
    const { ctx, document, ledger } = fixtures();
    const outcome = spawnFor(ctx, document, ledger);
    const plan = planOf(outcome);
    for (const path of [plan.fencePath, plan.settingsPath, ledger.path]) {
      const raw = readFileSync(path);
      expect(raw.includes(CRLF), path).toBe(false);
      expect(raw.at(raw.length - 1), path).toBe(LF);
    }
  });

  test("a crlf rewrite of the fence does not survive a republish", () => {
    // The Windows failure, reproduced deliberately on any platform.
    //
    // A fence rewritten with CRLF is different bytes. Re-publishing must put the
    // LF form back, or the rollback path would be restoring a file the renderer
    // never produced.
    const { ctx, document, ledger } = fixtures();
    const outcome = spawnFor(ctx, document, ledger);
    const path = planOf(outcome).fencePath;
    // Read BEFORE writing, and the care is the source's own: `open(path, "w")`
    // truncates, so reading inside the write would have written an empty file
    // and asserted on nothing. The two statements are ordered for that reason
    // and must not be folded into one read-modify-write expression whose
    // evaluation order a later edit could flip.
    const body = readFileSync(path, "utf8");
    // `newline="\r\n"`: Python translates each `\n` the writer emits into
    // `\r\n`. The body came out of `pyJsonDumps` and carries no `\r`, so a
    // whole-string replacement is the same bytes.
    writeFileSync(path, body.replaceAll("\n", "\r\n"), "utf8");
    expect(readFileSync(path).includes(CRLF)).toBe(true);

    writeFence(fenceOf(outcome), path);
    expect(readFileSync(path).includes(CRLF)).toBe(false);
    expect(readFence(path).ruleIds()).toEqual(fenceOf(outcome).ruleIds());
  });

  test("publication is atomic", () => {
    // A hook reading a half-written fence would enforce a *subset* of it.
    //
    // The rename makes that impossible; this pins that no partial file is left
    // behind under the published name, and that no `.tmp` sibling survives it.
    const root = fenceCaseRoot();
    const ctx = fenceContext(root);
    const document = fenceDocument();
    const fence = renderFence("worker", ctx, { document });
    const path = writeFence(fence, join(root, "fence.json"));
    expect(statSync(path).isFile()).toBe(true);
    // `path.parent.glob("*.tmp")`. The directory is `root`, which the temp
    // helper made for this test alone, so anything ending in `.tmp` here was
    // left by the publication.
    expect(readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect(readFence(path).ruleIds()).toEqual(fence.ruleIds());
  });

  test("republishing replaces cleanly", () => {
    const root = fenceCaseRoot();
    const ctx = fenceContext(root);
    const document = fenceDocument();
    const fence = renderFence("worker", ctx, { document });
    const path = writeFence(fence, join(root, "fence.json"));
    writeFence(renderFence("curator", ctx, { document }), path);
    expect(readFence(path).role).toBe("curator");
  });
});

describe("restart does not widen the fence", () => {
  test("probes are identical objects across restart", () => {
    const { ctx, document, ledger } = fixtures();
    const outcome = spawnFor(ctx, document, ledger);
    const before = probesFor(fenceOf(outcome)).map((probe) => probe.toJson());
    const after = probesFor(readFence(planOf(outcome).fencePath)).map((probe) => probe.toJson());
    // List equality in the source, so ORDER is part of the assertion: a restart
    // that returned the same probes in a different order would change the order
    // the battery reports breaches in, and every report comparison downstream.
    expect(after).toEqual(before);
  });

  test("permission mode survives and is never upgraded to bypass", () => {
    const { ctx, document, ledger } = fixtures();
    const outcome = spawnFor(ctx, document, ledger);
    const restored = readFence(planOf(outcome).fencePath);
    expect(restored.permissionMode).toBe(fenceOf(outcome).permissionMode);
    expect(restored.permissionMode).not.toBe("bypassPermissions");
  });
});
