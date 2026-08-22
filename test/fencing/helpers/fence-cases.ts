import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { pyJsonDumps, pyJsonLoads } from "../../../src/fencing/pyjson.js";
import {
  FenceContext,
  loadDocument,
  type RoleDocument,
  renderFence,
} from "../../../src/fencing/renderer.js";
import type { Fence } from "../../../src/fencing/rules.js";
import {
  defaultHookScript,
  FencedSpawner,
  FenceLedger,
  type SpawnOutcome,
  type SpawnPlan,
} from "../../../src/fencing/spawn.js";
import { writeFence } from "../../../src/fencing/state.js";
import { caseRoot } from "../../testkit/cases.js";

/**
 * The fencing belt's fixtures -- interlock `tests/fencing/conftest.py` at
 * `65f36c5`.
 *
 * Belt-specific, and deliberately not in `test/testkit/`: the testkit is frozen
 * (docs/test-translation-conventions.md, "The testkit is frozen"), and a helper
 * that only the fencing cases need has not earned a place in the shared surface
 * where an edit to it changes what every other belt asserts.
 *
 * The source's four fixtures map one to one, except `hook_script` -- see
 * {@link hookScriptForTest}, which is the one adaptation in this file and is
 * recorded in the parity ledger as such.
 *
 * Later PRs of this lane add the fixtures the remaining suites share, and they
 * come from three different source files rather than from `conftest.py`:
 * {@link fenceLedger} (the `ledger` fixture of both spawn suites),
 * {@link recordingSpawner} (`test_spawn_precondition.RecordingSpawner`),
 * {@link spawnFor} (that file's module-level `spawn()` helper) and
 * {@link publishedFence} (`test_deny_hook.published`). They live here rather
 * than beside their one suite because {@link fenceContext} and
 * {@link fenceDocument} are their inputs, and a second copy of the context
 * construction is a second thing free to drift from the source's `ctx`.
 */

/**
 * The `caseRoot` label for every fencing case.
 *
 * D-0020: a label travels into the temporary directory name, the directory name
 * travels into every substituted `{interlock_root}` / `{hook_script}` /
 * `{fence_path}`, and those land inside the refusal messages these tests match
 * on with `expectRefusal`. A label that shares vocabulary with a match literal
 * makes the assertion unfalsifiable -- `expectRefusal(..., /hook script not
 * found/)` would still pass against a refusal that merely quoted a path
 * containing the phrase, so the case would go green for a reason that has
 * nothing to do with the property.
 *
 * The literals reachable from this belt include `hook script not found`,
 * `unsubstituted placeholder`, `no role`, `fence refused`, `sandbox profile`,
 * `forbidden-allow`, `matcher` and `not a valid regex`. "quill" is a word this
 * subsystem has no other use for, and it shares no substring with any of them.
 * Renaming it is not cosmetic: check the new word against the match literals
 * first.
 */
const CASE_LABEL = "quill";

/** pytest's `tmp_path`, for this belt. Removed when the test finishes. */
export function fenceCaseRoot(): string {
  return caseRoot(CASE_LABEL);
}

/** The `document` fixture: the shipped role document. */
export function fenceDocument(): RoleDocument {
  return loadDocument();
}

/**
 * The `hook_script` fixture -- **ADAPTED**, and the adaptation is the point.
 *
 * The source returns `default_hook_script()`, the shipped hook file. The
 * renderer requires every hook command's script token to name a file that
 * EXISTS, so a fixture handing back a path to nothing turns every renderer case
 * into a refusal case.
 *
 * When this fixture was written continuo had no shipped hook at all, so a
 * throwaway was the only option. **That is no longer true** -- this PR ships
 * `src/fencing/hook.mjs`, and {@link shippedHookScript} hands back its path.
 * This function is nonetheless kept, unchanged, and it is still what
 * {@link fenceContext} defaults to, for a reason that outlived its original
 * one: a renderer case needs "the context names a script file that exists" and
 * nothing more, and a fixture that reached for the shipped hook there would
 * couple every renderer refusal to the hook's own file layout -- moving or
 * renaming `hook.mjs` would then fail forty renderer cases that have no opinion
 * about the hook. Fixtures that need the hook to RUN ask for it by name; see
 * {@link shippedHookScript} and {@link publishedFence}.
 *
 * So this creates a real file inside the per-test root and returns its path.
 * The property every ported renderer case actually depends on is "the context
 * names a hook script that exists", not "which file it is" -- the renderer
 * reads the path, never the contents. The one source case that genuinely
 * depends on the shipped default
 * (`test_the_default_hook_launcher_resolves_on_this_platform`) asks for it by
 * name through {@link shippedHookScript} instead; it was not ported while there
 * was no shipped hook, and it is ported (adapted) now that there is. The parity
 * ledger records both the lift and what the adaptation changed.
 *
 * The `.mjs` suffix is not decoration. `checkCommandResolves` only demands
 * existence for tokens ending in a script suffix, so a name with no suffix
 * would pass that check without the file existing at all, and the fixture would
 * stop pinning the thing it is here to pin.
 */
export function hookScriptForTest(root: string): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, "hook.mjs");
  // Never executed by these cases: the renderer stats the path and reads
  // nothing. The body says so, so a later reader does not take it for the real
  // hook.
  writeFileSync(path, "// Not the deny hook. A file for the renderer to find.\n", "utf8");
  return path;
}

/**
 * The `ctx` fixture: the three directories created, the fence path not.
 *
 * `fencePath` is a NAME, not a file, exactly as the source's is -- the fence is
 * written there by the spawn path, and the renderer only ever substitutes and
 * compares the string. A helper that created it would silently defeat any later
 * case asserting nothing was published.
 *
 * `options.hookScript` is ADDITIVE and defaults to the previous behaviour, so
 * every merged renderer and battery call site is unaffected. It exists because
 * the source's `ctx` fixture composes the `hook_script` fixture, and continuo
 * now has two of those: the throwaway {@link hookScriptForTest} (a file for the
 * renderer to stat) and the real {@link shippedHookScript} (a file for the
 * deny-hook suite to RUN). Passing it is how a suite says which one it means.
 */
export function fenceContext(
  root: string = fenceCaseRoot(),
  options?: { readonly hookScript?: string },
): FenceContext {
  const interlockRoot = join(root, "interlock");
  const workerDir = join(root, "worker");
  const orgPath = join(root, "claude-org");
  for (const path of [interlockRoot, workerDir, orgPath]) {
    mkdirSync(path, { recursive: true });
  }
  return new FenceContext({
    interlockRoot,
    workerDir,
    claudeOrgPath: orgPath,
    hookScript: options?.hookScript ?? hookScriptForTest(root),
    fencePath: join(interlockRoot, "state", "fence-worker.json"),
  });
}

/**
 * `dataclasses.replace(ctx, ...)`.
 *
 * Two source cases build a broken context by replacing one field of the good
 * one. Rebuilding it by hand at each call site would let a case drift from the
 * fixture in a field it did not mean to change -- and both of those cases
 * assert a refusal, so a drifted field would still refuse and the case would
 * stay green for the wrong reason.
 */
export function replaceFenceContext(
  ctx: FenceContext,
  changes: {
    readonly interlockRoot?: string;
    readonly workerDir?: string;
    readonly claudeOrgPath?: string;
    readonly hookScript?: string;
    readonly fencePath?: string;
    readonly python?: string;
    readonly extra?: Readonly<Record<string, string>>;
  },
): FenceContext {
  return new FenceContext({
    interlockRoot: changes.interlockRoot ?? ctx.interlockRoot,
    workerDir: changes.workerDir ?? ctx.workerDir,
    claudeOrgPath: changes.claudeOrgPath ?? ctx.claudeOrgPath,
    hookScript: changes.hookScript ?? ctx.hookScript,
    fencePath: changes.fencePath ?? ctx.fencePath,
    python: changes.python ?? ctx.python,
    extra: changes.extra ?? ctx.extra,
  });
}

/**
 * `json.loads(json.dumps(value))` -- the deep copy the source repeats inline
 * wherever it edits a nested part of the document.
 *
 * `structuredClone` is NOT the same thing and must not be substituted for it.
 * The document is JSON, and the round trip through this pair is what carries
 * the SOURCE KEY ORDER onto the copy: `pyJsonLoads` records it and the
 * renderer's placeholder walk emits one reason per placeholder in that order.
 * A copy without it reports the reasons of a refusal in JavaScript's
 * enumeration order, which hoists integer-like keys, so a document with an
 * `env` key named `"2"` would refuse with the same codes in a different order
 * than interlock does.
 */
export function deepCopyDocument<T>(value: T): T {
  return pyJsonLoads(pyJsonDumps(value)) as T;
}

/**
 * A deep copy of `document` with `role` altered.
 *
 * A `null` (or `undefined`) value DELETES the key, which is how the "config
 * deleted" and "sandbox profile absent" cases are built without editing the
 * shipped document. Setting the key to `null` instead would be a different
 * test: the renderer distinguishes an ABSENT key from one present with a null
 * value, and for `permissions` that difference is the whole of a legitimate
 * sandbox-only role.
 */
export function mutate(
  document: RoleDocument,
  role: string,
  changes: Readonly<Record<string, unknown>>,
): RoleDocument {
  const clone = deepCopyDocument(document);
  const roles = clone.roles as Record<string, unknown>;
  const body = roles[role] as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined) {
      delete body[key];
    } else {
      // `body[key] = value` as `dict.__setitem__`: always an own, enumerable
      // data property. Plain assignment to the literal key `"__proto__"`
      // invokes the inherited accessor instead, so the key would VANISH from
      // the body -- a case that meant to add a discarded axis would then
      // render a healthy fence and assert a refusal that never came.
      Object.defineProperty(body, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return clone;
}

/**
 * The shipped deny hook, as an absolute path -- what the SOURCE's `hook_script`
 * fixture returns (`default_hook_script()`).
 *
 * This is the fixture to use wherever the hook has to be a real, runnable
 * artefact rather than a name the renderer stats: the deny-hook suite launches
 * it as a SUBPROCESS, so a throwaway `// not the deny hook` file there would
 * exit 0 -- which the PreToolUse contract reads as *no opinion*, i.e. allow.
 * The suite would then be green with the fence doing nothing, which is the i04
 * section 5 absorption failure reproduced inside our own test bed.
 *
 * A function rather than a module-level constant, matching
 * `defaultHookScript` itself: a constant would resolve at import time, so a
 * resolution failure would abort collection with no case name attached to it
 * instead of failing the one case that asked for the hook.
 */
export function shippedHookScript(): string {
  return defaultHookScript();
}

/**
 * The `ledger` fixture -- BOTH of them.
 *
 * `test_restart_preserves_fence.py` names the file `ledger.jsonl` and
 * `test_spawn_precondition.py` names it `fence-ledger.jsonl`. Nothing in either
 * suite depends on which name it is, but the name is not free to change either:
 * `test_the_ledger_is_append_only` reads `ledger.path` back BY TEXT and
 * `test_the_record_survives_a_fresh_reader` opens a second `FenceLedger` on the
 * same path, so the parameter is carried rather than unified -- a translated
 * fixture that quietly picked one name would be a place where the target and
 * the source disagree for no recorded reason.
 *
 * The default is the restart suite's name because that suite also builds
 * per-role ledgers by hand (`{role}.jsonl`), so its call sites are the ones
 * already passing a name.
 *
 * No cleanup is registered: the ledger is a path inside `root`, and `root` is a
 * `caseRoot()` that the testkit already removes when the test finishes. A
 * second cleanup here would be a second thing to keep in step with it.
 */
export function fenceLedger(root: string, filename = "ledger.jsonl"): FenceLedger {
  return new FenceLedger(join(root, filename));
}

/**
 * `RecordingSpawner`: "a spawner that records the fact it was called at all".
 *
 * The AC4 canary (interlock#71, D-0205). `spawner.calls == []` is asserted
 * seven times across the two spawn suites, and it is the ONE assertion that
 * separates "the spawn was refused" from "the spawn was quietly narrowed": a
 * best-effort renderer would hand the spawner a fence with the broken part
 * dropped, and every other assertion in those cases -- refusal code present,
 * refusal on disk -- would still hold. Only the call count says the child never
 * started.
 *
 * So the recorded calls are exposed as a real array and the identity of the
 * pushed value is preserved. `calls.length === 0` would be the same assertion
 * today, but `toEqual([])` on the array is what the source writes and what a
 * later case wanting `calls[0]` (the admitted suite asserts `len(...) == 1`)
 * can build on.
 *
 * A callable object rather than a class: the source's `RecordingSpawner` is
 * used ONLY as `__call__` -- `FencedSpawner.spawn` takes a plain callable -- so
 * a class here would force every call site to write `spawner.call` or
 * `(p) => spawner(p)`, and the second spelling would break the identity that
 * `expect(spawner.calls)` depends on being the same object.
 *
 * `{pid: 4242}` is the source's return value verbatim, and it is asserted:
 * `test_a_good_configuration_admits` checks `outcome.result == {"pid": 4242}`,
 * so this is a wire value, not a placeholder.
 */
export interface RecordingSpawner {
  (plan: SpawnPlan): unknown;
  /** Every plan handed to this spawner, in call order. Empty means never invoked. */
  readonly calls: SpawnPlan[];
}

export function recordingSpawner(): RecordingSpawner {
  const calls: SpawnPlan[] = [];
  const spawner = (plan: SpawnPlan): unknown => {
    calls.push(plan);
    return { pid: 4242 };
  };
  return Object.assign(spawner, { calls });
}

/**
 * The module-level `spawn()` helper of `test_restart_preserves_fence.py`.
 *
 * Named `spawnFor` and not `spawn` because `FencedSpawner.spawn` is the thing
 * under test in the neighbouring suite and a bare `spawn` imported into that
 * file would read as the method.
 *
 * The `assert outcome.admitted` is INSIDE the helper in the source and stays
 * inside it here. Every restart case is "spawn, then check the far side"; if
 * the near side ever stopped admitting, the far-side assertions would fail with
 * a `null` fence and a message about a property access rather than about the
 * spawn -- and `test_every_role_holds_across_restart`, which loops over every
 * role, would name no role at all.
 *
 * The source's spawner is `lambda plan: calls.append(plan) or {"pid": 1}` over
 * a local `calls` list that is then discarded -- the helper returns only the
 * outcome, so nothing can observe it. It is not reproduced: an array written
 * and never read is not behaviour, and it would trip `noUnusedVariables`. The
 * `{pid: 1}` IS reproduced, because it is the value that lands in
 * `outcome.result`. Note it differs from {@link recordingSpawner}'s `4242`;
 * the two suites use different sentinels and neither is normalised to the
 * other.
 */
export function spawnFor(
  ctx: FenceContext,
  document: RoleDocument,
  ledger: FenceLedger,
  role = "worker",
): SpawnOutcome {
  const outcome = new FencedSpawner({ ledger, document }).spawn(role, ctx, () => ({ pid: 1 }));
  expect(outcome.admitted, `spawn of ${role} was refused: ${JSON.stringify(outcome.reasons)}`).toBe(
    true,
  );
  return outcome;
}

/** The pair `test_deny_hook.py`'s `published` fixture returns. */
export interface PublishedFence {
  readonly fence: Fence;
  readonly path: string;
}

/**
 * The `published` fixture: render `worker`, write the fence, return the pair.
 *
 * The context is built with {@link shippedHookScript}, NOT with the throwaway
 * {@link hookScriptForTest}. This is the one fixture where that choice is
 * load-bearing rather than cosmetic: the deny-hook suite runs the real
 * `hook.mjs` against the file this writes, so the hook command recorded inside
 * the published fence and the executable the suite actually launches have to be
 * the same file. If they diverged, the suite would be proving that some hook
 * denies while the fence names another -- and the published fence is precisely
 * the artefact a live session hands to the hook.
 *
 * `writeFence` rather than a hand-written JSON file, and the path it RETURNS
 * rather than the path passed in: publication goes through a temp file and a
 * rename, and the return value is the published name.
 *
 * The source writes to `tmp_path / "fence.json"`, which is a SIBLING of the
 * `ctx.fence_path` the same `tmp_path` produces -- so a case asserting nothing
 * was published at `ctx.fence_path` is not confused by this one. That layout is
 * kept.
 */
export function publishedFence(root: string = fenceCaseRoot()): PublishedFence {
  const ctx = fenceContext(root, { hookScript: shippedHookScript() });
  const fence = renderFence("worker", ctx, { document: fenceDocument() });
  const path = writeFence(fence, join(root, "fence.json"));
  return { fence, path };
}
