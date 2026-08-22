import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pyJsonDumps, pyJsonLoads } from "../../../src/fencing/pyjson.js";
import { FenceContext, loadDocument, type RoleDocument } from "../../../src/fencing/renderer.js";
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
 * Continuo has no shipped hook yet: `fencing/hook.py` -- and with it the
 * fail-closed PreToolUse semantics that are its whole content -- lands in a
 * later PR of this lane. Creating a stub `hook.mjs` under `src/` to satisfy the
 * fixture would ship an untested fail-closed hook, which is precisely the thing
 * this PR's boundary exists to prevent: a hook that exists is a hook a spawn
 * will wire in, and one that has never been tested fails open in exactly the
 * way i04 section 5 measured.
 *
 * So this creates a real file inside the per-test root and returns its path.
 * The property every ported renderer case actually depends on is "the context
 * names a hook script that exists", not "which file it is" -- the renderer
 * reads the path, never the contents. The one source case that depends on the
 * shipped default (`test_the_default_hook_launcher_resolves_on_this_platform`)
 * is therefore NOT ported rather than faked; see the parity ledger.
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
 */
export function fenceContext(root: string = fenceCaseRoot()): FenceContext {
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
    hookScript: hookScriptForTest(root),
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
