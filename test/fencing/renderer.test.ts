import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";

import { describe, expect, test } from "vitest";

import { pyJsonDumps } from "../../src/fencing/pyjson.js";
import {
  FenceContext,
  FenceRefusal,
  loadDocument,
  RefusalReason,
  type RoleDocument,
  renderFence,
  roleNames,
} from "../../src/fencing/renderer.js";
import {
  type Fence,
  KIND_PERMISSION_DENY,
  KIND_SANDBOX_DENY_READ,
  KIND_SANDBOX_DENY_WRITE,
  LAYER_PERMISSIONS,
  LAYER_SANDBOX,
} from "../../src/fencing/rules.js";
import { quote, split as shlexSplit } from "../../src/fencing/shlex.js";
import { expectRefusal } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";
import {
  deepCopyDocument,
  fenceCaseRoot,
  fenceContext,
  fenceDocument,
  hookScriptForTest,
  mutate,
  replaceFenceContext,
  shippedHookScript,
} from "./helpers/fence-cases.js";

/**
 * The per-role fencing renderer: what it renders, and what it refuses.
 *
 * Ported from interlock `tests/fencing/test_renderer.py` at `65f36c5`. Every
 * one of the 40 source cases maps to one case here; the mapping and the four
 * that are adapted are recorded in `parity/fencing.renderer.ledger.json`,
 * along with the target-only cases that pin this port's two intentional
 * divergences from the source renderer (D-0208).
 *
 * The refusals carry most of the weight of this file. D-0023 part 2 makes
 * fail-closed Interlock's own obligation, and F2/V15/V16 record how readily
 * that codebase reaches for ignore-and-continue instead -- so every case below
 * asserts a *refusal with a named reason*, never merely that a bad value is
 * absent from the output. `expectRefusal` keeps both halves of the source's
 * `pytest.raises`, and where the source inspects `excinfo.value.codes` the
 * codes are asserted here too: "it threw" is satisfied by a refusal for an
 * unrelated reason, which is how a fence stops meaning what its ledger says.
 */

/** `re.compile(r"\{[a-z_]+\}")`, as a search over one string. */
const PLACEHOLDER = /\{[a-z_]+\}/g;

function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[0]);
}

/**
 * `Path(launcher).is_file() or shutil.which(launcher)`.
 *
 * Both halves, because both halves are the property: a launcher named by an
 * absolute path has to BE a file, and a bare name has to be findable on `PATH`.
 * Returning `true` for a name that merely appears in a `PATH` directory listing
 * would make the case pass on a directory of that name, so each candidate is
 * stat'ed.
 */
function launcherResolvesHere(launcher: string): boolean {
  const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();
  if (isFile(launcher)) {
    return true;
  }
  // `PATHEXT` is Windows' answer to "which name on disk is this"; an empty
  // extension is always tried first, as `shutil.which` does.
  const extensions = ["", ...(process.env["PATHEXT"] ?? "").split(delimiter).filter(Boolean)];
  for (const directory of (process.env["PATH"] ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      if (isFile(join(directory, launcher + extension))) {
        return true;
      }
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `fence.settings["hooks"]["PreToolUse"]`.
 *
 * Throws where Python raises `KeyError`, rather than returning an empty list.
 * An empty list would make "the deny hook is wired into every role" pass
 * vacuously on a settings payload that carries no hooks at all -- the exact
 * silent hole the case exists to catch.
 */
function preToolUseGroups(fence: Fence): Record<string, unknown>[] {
  const hooks = fence.settings["hooks"];
  if (!isRecord(hooks)) {
    throw new Error(`${fence.role}: settings has no 'hooks' object`);
  }
  const groups = hooks["PreToolUse"];
  if (!Array.isArray(groups)) {
    throw new Error(`${fence.role}: settings.hooks has no 'PreToolUse' list`);
  }
  return groups.map((group, index) => {
    if (!isRecord(group)) {
      throw new Error(`${fence.role}: settings.hooks.PreToolUse[${index}] is not an object`);
    }
    return group;
  });
}

/** The hooks of one PreToolUse group, as objects. */
function groupHooks(group: Record<string, unknown>): Record<string, unknown>[] {
  const hooks = group["hooks"];
  if (!Array.isArray(hooks)) {
    throw new Error("PreToolUse group has no 'hooks' list");
  }
  return hooks.map((hook) => {
    if (!isRecord(hook)) {
      throw new Error("PreToolUse hook is not an object");
    }
    return hook;
  });
}

/** Every rendered hook command, in order -- the source's nested comprehension. */
function hookCommands(fence: Fence): string[] {
  return preToolUseGroups(fence).flatMap((group) =>
    groupHooks(group).map((hook) => {
      const command = hook["command"];
      if (typeof command !== "string") {
        throw new Error(`${fence.role}: PreToolUse hook has no 'command' string`);
      }
      return command;
    }),
  );
}

describe("renders", () => {
  test("every shipped role renders", () => {
    const document = fenceDocument();
    const ctx = fenceContext();
    expect(roleNames(document).length).toBeGreaterThan(0);
    for (const role of roleNames(document)) {
      const fence = renderFence(role, ctx, { document });
      expect(fence.role).toBe(role);
      expect(fence.rules.length, `${role} rendered an empty fence`).toBeGreaterThan(0);
    }
  });

  test("all three layers are present on the worker role", () => {
    // Item 3's predicate names permission, sandbox *and* hooks as one object.
    const document = fenceDocument();
    const fence = renderFence("worker", fenceContext(), { document });
    const kinds = new Set(fence.rules.map((rule) => rule.kind));
    expect(kinds).toContain(KIND_PERMISSION_DENY);
    expect(kinds).toContain(KIND_SANDBOX_DENY_READ);
    expect(kinds).toContain(KIND_SANDBOX_DENY_WRITE);
    expect(preToolUseGroups(fence).length).toBeGreaterThan(0);
  });

  test("layers are labelled so the battery can report per layer", () => {
    const document = fenceDocument();
    const fence = renderFence("worker", fenceContext(), { document });
    const layers = new Set(fence.rules.map((rule) => rule.layer));
    expect(layers).toEqual(new Set([LAYER_PERMISSIONS, LAYER_SANDBOX]));
  });

  test("placeholders are substituted everywhere", () => {
    const document = fenceDocument();
    const ctx = fenceContext();
    for (const role of roleNames(document)) {
      const fence = renderFence(role, ctx, { document });
      // `json.dumps(fence.settings)`, not `JSON.stringify`: the escaping and
      // the key order are the source's, so a placeholder hiding inside a
      // non-ASCII-escaped string is found the same way here.
      const leftovers = placeholdersIn(pyJsonDumps(fence.settings));
      expect(leftovers, `${role}: unsubstituted ${leftovers.join(", ")}`).toEqual([]);
      for (const rule of fence.rules) {
        expect(placeholdersIn(rule.spec)).toEqual([]);
      }
    }
  });

  test("the deny hook is wired into every role", () => {
    const document = fenceDocument();
    const ctx = fenceContext();
    for (const role of roleNames(document)) {
      const commands = hookCommands(renderFence(role, ctx, { document }));
      expect(commands.some((command) => command.includes(ctx.hookScript))).toBe(true);
      expect(commands.some((command) => command.includes(ctx.fencePath))).toBe(true);
    }
  });

  test("paths with spaces survive into the hook command", () => {
    // A hook command is a shell string, not argv. An unquoted path containing a
    // space arrives as two arguments; one containing a shell metacharacter
    // arrives as something else entirely.
    //
    // ADAPTED: the source builds this context around `default_hook_script()`.
    // Continuo has no shipped hook yet, so the hook script is a real file the
    // fixture creates. The property under test is the quoting of the CONTEXT
    // paths, which is unchanged -- and putting the hook file inside the
    // space-bearing directory makes the case strictly stronger than its source,
    // because the hook path now needs the quoting too.
    const document = fenceDocument();
    const root = join(fenceCaseRoot(), "a dir with spaces");
    mkdirSync(root, { recursive: true });
    const ctx = new FenceContext({
      interlockRoot: root,
      workerDir: join(root, "w"),
      claudeOrgPath: join(root, "org"),
      hookScript: hookScriptForTest(root),
      fencePath: join(root, "state dir", "fence.json"),
    });
    const fence = renderFence("worker", ctx, { document });
    const command = hookCommands(fence)[0] as string;
    const tokens = shlexSplit(command);
    expect(tokens).toContain(ctx.fencePath);
    expect(tokens[tokens.indexOf("--fence") + 1]).toBe(ctx.fencePath);
  });

  test("the default hook launcher resolves on this platform", () => {
    // The default must be launchable *here*, not on the author's machine.
    //
    // A literal `"python3"` is frequently absent on Windows -- only
    // `python.exe` / `py.exe` exist -- so every render there would refuse with
    // `hook-unresolvable`, and the fence would be unspawnable rather than
    // merely mis-launched. The hook also has to import the runtime, so the one
    // interpreter guaranteed to manage it is the running one.
    //
    // ADAPTED, in exactly one of its four assertions. The source asserts
    // `ctx.python == (sys.executable or "python3")`: the default is the running
    // PYTHON. Continuo's hook is a Node script (D-0204), so `FenceContext`
    // defaults `python` to `process.execPath` -- a recorded deviation,
    // documented at the field itself. The assertion is not dropped; it is
    // replaced by the one that means the same thing here: the default IS the
    // running interpreter. The other three carry across unchanged -- the
    // shipped hook script exists, the launcher resolves on THIS platform, and
    // the render succeeds rather than refusing `hook-unresolvable`, which the
    // source calls the actual regression.
    const document = fenceDocument();
    const hookScript = shippedHookScript();
    expect(existsSync(hookScript), `${hookScript} is not a file`).toBe(true);
    const ctx = fenceContext(fenceCaseRoot(), { hookScript });
    // `Path(ctx.python).is_file() or shutil.which(ctx.python)`.
    expect(launcherResolvesHere(ctx.python), `${ctx.python} does not resolve here`).toBe(true);
    // The Python-interpreter identity half, in its Node spelling.
    expect(ctx.python).toBe(process.execPath);
    // Renders rather than refusing -- the actual regression.
    expect(renderFence("worker", ctx, { document }).rules.length).toBeGreaterThan(0);
  });

  test("shlex mangles an unquoted backslash path and quoting prevents it", () => {
    // The hazard the quoting exists for, at the string level.
    //
    // `shlex.split` treats a backslash as an escape *on every platform*, so an
    // unquoted `C:\Users\...` is silently mangled -- and the mangled token then
    // fails the hook-path check, refusing every render there.
    //
    // This asserts both halves: that the hazard is real, and that quoting
    // removes it. It touches no filesystem, because the property is about
    // string handling and the first version of this test (in interlock) failed
    // on Windows for a reason that had nothing to do with the property -- it
    // tried to create a directory whose name contained a literal backslash,
    // which Windows cannot represent at all.
    const raw = "C:\\Users\\happy\\interlock\\fence.json";
    expect(raw).toContain("\\");
    // The hazard: unquoted, the backslashes are eaten.
    expect(shlexSplit(`py ${raw}`)[1]).not.toBe(raw);
    // The fix: quoted, the token survives intact.
    expect(shlexSplit(`py ${quote(raw)}`)[1]).toBe(raw);
  });

  test("the renderers own output roundtrips through shlex", () => {
    // The same property, on the bytes the renderer actually emits.
    //
    // The context paths are never created: rendering does not touch the
    // filesystem for them, so a synthetic path exercises the quoting without
    // needing a directory name the host may forbid. On Windows these paths
    // carry real backslashes; on POSIX the space in the name is what forces the
    // quoting.
    //
    // ADAPTED for the same reason as the case above, and the adaptation is
    // confined to the one path that CANNOT be synthetic: the hook script is a
    // real file, created outside the never-created tree so that the tree stays
    // never created.
    const document = fenceDocument();
    const caseDir = fenceCaseRoot();
    const root = join(caseDir, "a dir with spaces", "never created");
    const ctx = new FenceContext({
      interlockRoot: root,
      workerDir: join(root, "w"),
      claudeOrgPath: join(root, "org"),
      hookScript: hookScriptForTest(caseDir),
      fencePath: join(root, "state", "fence.json"),
    });
    const fence = renderFence("worker", ctx, { document });
    const command = hookCommands(fence)[0] as string;
    const tokens = shlexSplit(command);
    expect(tokens[tokens.indexOf("--fence") + 1]).toBe(ctx.fencePath);
    expect(tokens[0]).toBe(ctx.python);
  });

  test("rendering is deterministic", () => {
    // Two renders must be byte-identical, or a restart diff means nothing.
    const document = fenceDocument();
    const ctx = fenceContext();
    const first = renderFence("worker", ctx, { document });
    const second = renderFence("worker", ctx, { document });
    expect(first.ruleIds()).toEqual(second.ruleIds());
    // The canonical form is the STRING, never the object: JavaScript hoists
    // integer-like keys, so comparing the payloads as objects would compare an
    // order neither render could ever produce.
    expect(pyJsonDumps(first.settings, { sortKeys: true })).toBe(
      pyJsonDumps(second.settings, { sortKeys: true }),
    );
  });

  test("rule ids are stable and unique", () => {
    const document = fenceDocument();
    const ctx = fenceContext();
    for (const role of roleNames(document)) {
      const ids = renderFence(role, ctx, { document }).ruleIds();
      expect(new Set(ids).size, `${role} has duplicate rule ids`).toBe(ids.length);
    }
  });
});

/**
 * PORTING_LEDGER R5: the transport and pattern axes do not come across.
 *
 * They are *refused*, not ignored. A role document still carrying a discarded
 * axis was authored against the old contract, so rendering it while dropping
 * the axis produces a fence narrower than its author believed -- a silent
 * downgrade.
 */
describe("discarded axes", () => {
  parametrize(
    "a discarded axis refuses the render",
    [
      ["sandbox_by_pattern", "sandbox_by_pattern"],
      ["transport", "transport"],
      ["transport_descriptor", "transport_descriptor"],
    ] as const,
    (axis) => {
      const document = fenceDocument();
      const broken = mutate(document, "worker", { [axis]: { A: {} } });
      const refusal = expectRefusal(
        () => renderFence("worker", fenceContext(), { document: broken }),
        FenceRefusal,
      );
      expect(refusal.codes).toContain(RefusalReason.DISCARDED_AXIS);
    },
  );

  test("the fencing package does not import the discarded transport module", () => {
    // The ledger's other half: the carried renderer must not drag the
    // `transport.descriptor` dependency along with it.
    //
    // The source globs the package's `*.py`; this globs the package's `*.ts`,
    // which is the same set of files under a different extension. The two
    // exemptions are the source's, translated: the source spares the RST
    // literal ``transport.descriptor`` (a doc comment naming the axis is not an
    // import of it), which in TSDoc is written with single backticks; and it
    // spares a file that says DISCARDED or carries a docstring, whose marker is
    // `/**` here rather than a triple quote.
    const packageDir = join(import.meta.dirname, "..", "..", "src", "fencing");
    // `.mjs` as well as `.ts`, and that is not a detail. The source globs the
    // package's `*.py`, which covers EVERY file in it including `hook.py`. This
    // port's package is not all one extension: `D-0204` ships the deny hook as
    // hand-written JavaScript, so a `.ts`-only glob silently stops scanning the
    // most security-critical file in the package -- and it stops silently,
    // because the assertion still passes over the remaining files.
    //
    // Measured rather than reasoned about: with `transport.descriptor` appended
    // to `hook.mjs`, a `.ts`-only glob reported this case GREEN. The guard was
    // weakened by the same pull request that shipped the file it stopped
    // covering, which is the shape worth remembering -- adding a file can
    // narrow a check that names no file at all.
    //
    // Written up with the other two instances of the shape in
    // docs/test-translation-conventions.md section 10, "Make it fail on purpose, and confirm it fails for the reason you expect".
    const sources = readdirSync(packageDir).filter(
      (entry) => entry.endsWith(".ts") || entry.endsWith(".mjs"),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const entry of sources) {
      const text = readFileSync(join(packageDir, entry), "utf8");
      expect(
        text.replaceAll("`transport.descriptor`", ""),
        `${entry} references the discarded transport axis`,
      ).not.toContain("transport.descriptor");
      expect(
        !text.includes("sandbox_by_pattern") || text.includes("DISCARDED") || text.includes("/**"),
      ).toBe(true);
    }
  });
});

describe("refusals", () => {
  test("absent role refuses", () => {
    const document = fenceDocument();
    const refusal = expectRefusal(
      () => renderFence("no-such-role", fenceContext(), { document }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.ROLE_ABSENT);
  });

  test("config deleted refuses", () => {
    // "config deleted" -- the first of issue #9's three broken configurations.
    const root = fenceCaseRoot();
    const refusal = expectRefusal(() => loadDocument(join(root, "gone.json")), FenceRefusal);
    expect(refusal.codes).toContain(RefusalReason.DOCUMENT_UNREADABLE);
  });

  test("malformed document refuses rather than rendering nothing", () => {
    const path = join(fenceCaseRoot(), "roles.json");
    writeFileSync(path, "{not json", "utf8");
    expectRefusal(() => loadDocument(path), FenceRefusal);
  });

  test("sandbox profile absent refuses", () => {
    // "sandbox profile absent" -- the second.
    const document = fenceDocument();
    const broken = mutate(document, "worker", { sandbox: null });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.SANDBOX_PROFILE_ABSENT);
  });

  test("hook path unresolvable refuses", () => {
    // "hook path unresolvable" -- the third, and the one U42 says cannot be
    // left to the hook itself.
    //
    // `investigation/i04-pretooluse-fence-probe.md` section 5 measured the same
    // missing hook failing *closed* under `python3` (exit 2) and *open* under
    // `bash` (exit 127). Whether a broken fence holds therefore depends on the
    // launcher, so it has to be caught before the spawn.
    const document = fenceDocument();
    const root = fenceCaseRoot();
    const brokenCtx = replaceFenceContext(fenceContext(root), {
      hookScript: join(root, "not-there.py"),
    });
    const refusal = expectRefusal(
      () => renderFence("worker", brokenCtx, { document }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.HOOK_UNRESOLVABLE);
  });

  test("hooks absent refuses", () => {
    const document = fenceDocument();
    const broken = mutate(document, "worker", { hooks: null });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.HOOK_ABSENT);
  });

  test("forbidden allow refuses", () => {
    const document = fenceDocument();
    const broken = mutate(document, "worker", {
      permissions: { allow: ["Bash(git *)"], deny: ["Bash(git push *)"] },
    });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.FORBIDDEN_ALLOW);
  });

  test("forbidden allow by regex refuses", () => {
    const document = fenceDocument();
    const broken = mutate(document, "worker", {
      permissions: { allow: ["Bash( * )"], deny: ["Bash(git push *)"] },
    });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.FORBIDDEN_ALLOW);
  });

  test("empty deny list refuses", () => {
    // A role with nothing denied is not a fence, and must not render as one.
    const document = fenceDocument();
    const broken = mutate(document, "worker", {
      permissions: { allow: [], deny: [] },
      sandbox: { filesystem: { denyRead: [], denyWrite: [] } },
    });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.EMPTY_FENCE);
  });

  test("unparseable rule refuses rather than being skipped", () => {
    // The ignore-and-continue case, stated directly. A rule that fails to parse
    // and is dropped leaves a hole with no probe and no error --
    // indistinguishable from a fence that never had the rule.
    const document = fenceDocument();
    const broken = mutate(document, "worker", {
      permissions: { allow: [], deny: ["Bash(git push *)", "Bash(oops"] },
    });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.RULE_SYNTAX);
  });

  test("a deny list authored as a string refuses", () => {
    // The mis-authoring that renders one rule per *letter*.
    //
    // `"deny": "WebFetch"` iterates character by character, so the fence gains
    // rules for tools `W`, `e`, `b` ... each of which the self-battery
    // cheerfully denies -- while the rule that was meant is simply absent. A
    // green battery over the wrong rules is the worst shape this fence can
    // take.
    const document = fenceDocument();
    const broken = mutate(document, "worker", {
      permissions: { allow: [], deny: "WebFetch" },
    });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.RULE_SYNTAX);
  });

  test("a sandbox deny list authored as a string refuses", () => {
    const document = fenceDocument();
    const broken = mutate(document, "worker", {
      sandbox: { filesystem: { denyRead: "/etc/shadow", denyWrite: [] } },
    });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.RULE_SYNTAX);
  });

  test("an unlaunchable hook refuses", () => {
    // The launcher is as load-bearing as the script it launches.
    //
    // i04 section 5 measured an unresolvable hook failing **open** at exit 127
    // under `bash`. A launcher that does not exist produces the same 127, so
    // checking only the script leaves the identical hole one token to the left.
    const document = fenceDocument();
    const brokenCtx = replaceFenceContext(fenceContext(), {
      python: "python3-that-does-not-exist",
    });
    const refusal = expectRefusal(
      () => renderFence("worker", brokenCtx, { document }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.HOOK_UNRESOLVABLE);
  });

  test("a narrow hook matcher refuses", () => {
    // The quietest hole of the lot.
    //
    // With the deny hook scoped to `"Bash"`, the fence still carries every Read
    // / Write / WebFetch rule and the self-battery still denies every probe --
    // because the battery calls the decision function directly. The CLI simply
    // never consults the hook for the exempted tools, and nothing anywhere goes
    // red.
    const document = fenceDocument();
    const hooks = deepCopyDocument(roleHooks(document, "worker"));
    firstPreToolUseGroup(hooks)["matcher"] = "Bash";
    const broken = mutate(document, "worker", { hooks });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.HOOK_MATCHER_TOO_NARROW);
  });

  test("every shipped role scopes the deny hook to all tools", () => {
    const document = fenceDocument();
    const ctx = fenceContext();
    for (const role of roleNames(document)) {
      const fence = renderFence(role, ctx, { document });
      for (const group of preToolUseGroups(fence)) {
        const invokesInterlock = groupHooks(group).some((hook) => {
          const command = hook["command"];
          return typeof command === "string" && command.includes(ctx.hookScript);
        });
        if (invokesInterlock) {
          // `group.get("matcher")` is `None` for an absent key, which is
          // `undefined` here -- both spellings are accepted, because a rebuilt
          // payload can carry an explicit null the source never distinguishes.
          expect([undefined, null, "*", ".*", ""]).toContain(group["matcher"]);
        }
      }
    }
  });

  test("a hook entry that is not a command refuses", () => {
    // Only `type: "command"` entries are executed as commands. An entry of
    // another type carrying a `command` key reads as correct and never runs.
    const document = fenceDocument();
    const hooks = deepCopyDocument(roleHooks(document, "worker"));
    firstHook(hooks)["type"] = "prompt";
    const broken = mutate(document, "worker", { hooks });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.HOOK_NOT_A_COMMAND);
  });

  test("a hook pointed at another fence refuses", () => {
    // Naming our hook is not the same as running it at our fence.
    //
    // `hook.py --fence /tmp/stale.json` passes a substring check, reads
    // somebody else's rules, and never consults the fence that was published --
    // an admitted spawn enforcing a fence nobody rendered.
    const document = fenceDocument();
    const hooks = deepCopyDocument(roleHooks(document, "worker"));
    firstHook(hooks)["command"] =
      "{python} {hook_script} --role worker --fence /tmp/stale-fence.json";
    const broken = mutate(document, "worker", { hooks });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.HOOK_INVOCATION_WRONG);
  });

  test("a hook invoked for another role refuses", () => {
    const document = fenceDocument();
    const hooks = deepCopyDocument(roleHooks(document, "worker"));
    firstHook(hooks)["command"] = "{python} {hook_script} --role curator --fence {fence_path}";
    const broken = mutate(document, "worker", { hooks });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.HOOK_INVOCATION_WRONG);
  });

  test("a hook with no fence flag refuses", () => {
    const document = fenceDocument();
    const hooks = deepCopyDocument(roleHooks(document, "worker"));
    firstHook(hooks)["command"] = "{python} {hook_script}";
    const broken = mutate(document, "worker", { hooks });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.HOOK_INVOCATION_WRONG);
  });

  test("a malformed global regex refuses rather than raising", () => {
    // Escaping as `re.error` would bypass the spawn's refusal handling
    // entirely, so a broken forbidden-allow list would produce no durable
    // `spawn-refused` event at all.
    const document = fenceDocument();
    const broken = deepCopyDocument(document);
    // `broken["global"]` is declared readonly on `RoleDocument`; the source
    // edits the parsed copy in place, and the copy is nobody else's.
    const globalCfg: unknown = broken["global"];
    if (!isRecord(globalCfg)) {
      throw new Error("the shipped document has no 'global' object");
    }
    globalCfg["forbidden_allow_regex"] = ["^Bash([unclosed"];
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.GLOBAL_CONFIG_INVALID);
  });

  test("unsubstituted placeholder refuses", () => {
    const document = fenceDocument();
    const broken = mutate(document, "worker", {
      sandbox: { filesystem: { denyWrite: ["{no_such_placeholder}/x"] } },
    });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.UNSUBSTITUTED_PLACEHOLDER);
  });

  test("a refusal reports every reason not just the first", () => {
    const document = fenceDocument();
    const broken = mutate(document, "worker", {
      sandbox: null,
      hooks: null,
      permissions: { allow: ["Bash(gh *)"], deny: ["Bash(git push *)"] },
    });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    const codes = new Set<string>(refusal.codes);
    for (const expected of [
      RefusalReason.SANDBOX_PROFILE_ABSENT,
      RefusalReason.HOOK_ABSENT,
      RefusalReason.FORBIDDEN_ALLOW,
    ]) {
      expect(codes).toContain(expected);
    }
  });
});

/**
 * U15's answer, as it reaches the rendered fence.
 *
 * `investigation/i04-pretooluse-fence-probe.md` section 3 measured that
 * `PreToolUse` *does* fire and *does* deny under `bypassPermissions`. The
 * renderer refuses the mode anyway, and the reason is in section 4 of the same
 * file: under `bypassPermissions` the hook is the only layer left, and a hook
 * exiting 1 was measured being absorbed at exit 0 with no other signal.
 */
describe("permission mode is U15's answer", () => {
  test("bypass permissions refuses the render", () => {
    const document = fenceDocument();
    const broken = mutate(document, "worker", { permission_mode: "bypassPermissions" });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.PERMISSION_MODE_BYPASS);
  });

  test("an unknown permission mode refuses", () => {
    const document = fenceDocument();
    const broken = mutate(document, "worker", { permission_mode: "yolo" });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.PERMISSION_MODE_INVALID);
  });

  test("no shipped role asks for bypass permissions", () => {
    const document = fenceDocument();
    for (const [role, body] of Object.entries(document.roles)) {
      const permissionMode = isRecord(body) ? body["permission_mode"] : undefined;
      expect(permissionMode, role).not.toBe("bypassPermissions");
    }
  });
});

/**
 * The deny hook has to be the program that RUNS -- **target-only**, D-0208.
 *
 * These four cases are target-only: interlock has no case for this property
 * because interlock has the defect. `renderer.py:412` decides that a command
 * invokes the deny hook with a substring test, so a command that merely
 * MENTIONS the hook path is admitted, the CLI runs something else, and the
 * session believes it is fenced when it is not. Measured against interlock at
 * `65f36c5`, not reasoned about: `/bin/echo {hook_script} --role worker --fence
 * {fence_path}` renders a fence of 17 rules there. Interlock is frozen, so
 * continuo repairs it and the parity ledger carries the difference as an
 * intentional divergence rather than an inherited limitation.
 *
 * The first two cases are the pair that matters. `/bin/echo` shows the defect;
 * `true` shows why POSITION ALONE IS NOT THE FIX -- it puts the hook at argv[1]
 * exactly where the real command puts it, resolves on PATH exactly as `echo`
 * does, and exits 0 without running anything. Only `argv[0] === ctx.python`
 * rejects it.
 *
 * The codes are asserted with `toContain` rather than by equality because the
 * two decoy launchers do not resolve on every platform (`/bin/echo` is absent
 * on Windows, `true` is not on its PATH), so those runs carry an extra
 * `hook-unresolvable`. `hook-absent` -- "no PreToolUse hook invokes Interlock's
 * deny hook" -- is the code this property owns, and it is present on every
 * platform.
 *
 * The accepted shape is exactly one: `ctx.python` at argv[0], the hook script
 * at argv[1]. A hook at argv[0] was admitted when D-0208 first landed and is
 * refused now, because that branch was open on Windows -- the last case here
 * pins the tightened rule and records the failure mode.
 */
describe("the deny hook must be the program that runs (target-only, D-0208)", () => {
  test("a hook merely mentioned on the command line refuses (target-only)", () => {
    const document = fenceDocument();
    const hooks = deepCopyDocument(roleHooks(document, "worker"));
    firstHook(hooks)["command"] = "/bin/echo {hook_script} --role worker --fence {fence_path}";
    const broken = mutate(document, "worker", { hooks });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    // Not merely "it refused": every OTHER check passes on this command, so a
    // refusal for any other reason would mean the property is unprotected.
    expect(refusal.codes).toContain(RefusalReason.HOOK_ABSENT);
  });

  test("a hook at argv[1] under a launcher that is not the interpreter refuses (target-only)", () => {
    // The counter-example that makes a position-only check insufficient.
    const document = fenceDocument();
    const hooks = deepCopyDocument(roleHooks(document, "worker"));
    firstHook(hooks)["command"] = "true {hook_script} --role worker --fence {fence_path}";
    const broken = mutate(document, "worker", { hooks });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    expect(refusal.codes).toContain(RefusalReason.HOOK_ABSENT);
  });

  test("the shipped {python} {hook_script} shape still renders (target-only)", () => {
    // The other half of the divergence: the check must not be so strict that
    // the document this repository actually ships stops rendering.
    const document = fenceDocument();
    const ctx = fenceContext();
    const fence = renderFence("worker", ctx, { document });
    const invoking = hookCommands(fence).filter((command) => {
      const tokens = shlexSplit(command);
      return tokens[0] === ctx.python && tokens[1] === ctx.hookScript;
    });
    expect(invoking.length).toBeGreaterThan(0);
  });

  test("an unparseable hook command refuses hook-absent as well as rule-syntax (target-only)", () => {
    // The second intentional divergence of this check, pinned so it stops
    // being a sentence in a decision entry that no case measures.
    //
    // interlock refuses this command with `rule-syntax` alone: its substring
    // test never tokenises, so the command still counts as invoking the hook
    // and `hook-absent` is never reached. continuo tokenises first (D-0208),
    // `commandRunsHook` returns false on the `ShlexError`, no invoking hook
    // remains, and `hook-absent` is appended. Both codes, not one.
    //
    // The direction is fail-closed -- continuo refuses strictly more loudly
    // about a document interlock also refuses -- and it is recorded in
    // `parity/fencing.renderer.ledger.json` under `intentional_divergences`.
    const document = fenceDocument();
    const hooks = deepCopyDocument(roleHooks(document, "worker"));
    // The unbalanced quote is the whole input: everything else about this
    // command is the shipped, correct shape.
    firstHook(hooks)["command"] = '{python} {hook_script} --role worker --fence "{fence_path}';
    const broken = mutate(document, "worker", { hooks });
    const refusal = expectRefusal(
      () => renderFence("worker", fenceContext(), { document: broken }),
      FenceRefusal,
    );
    // Set equality, not `toContain`: the divergence IS the extra code, so a
    // containment check would pass against interlock's own code set and pin
    // nothing. Sorted, because the order is not the property.
    expect([...new Set(refusal.codes)].sort()).toEqual(
      [RefusalReason.RULE_SYNTAX, RefusalReason.HOOK_ABSENT].sort(),
    );
  });

  test("an executable hook at argv[0] refuses: the recorded interpreter is required (target-only)", () => {
    // D-0208 also admitted this shape once -- a hook at argv[0], on the theory
    // that an executable file with a shebang is run by the kernel. It is
    // refused now, and this case is the evidence that the tighter rule holds.
    //
    // The branch was unsound on Windows, which is a required CI cell (D-0003).
    // The shipped `src/fencing/hook.mjs` has NO shebang and is mode 0644, so
    // on POSIX `checkCommandResolves` refuses it with `hook-unresolvable` --
    // but `accessSync(path, X_OK)` on Windows is only an existence check, so
    // there the render SUCCEEDED, `cmd` cannot execute a `.mjs` directly, the
    // deny hook never launched, and the child ran UNFENCED with the spawn
    // recorded as admitted. Nothing this project ships ever produced the
    // shape: all four roles render `{python} {hook_script} ...`, exactly as
    // interlock's own non-executable `hook.py` does.
    const root = fenceCaseRoot();
    const ctx = fenceContext(root);
    // The chmod is what makes this case prove the RULE rather than the
    // accident. With the executable bit set, `checkCommandResolves` is
    // satisfied on POSIX -- and it is satisfied on Windows either way -- so
    // the refusal below cannot be the old `hook-unresolvable` defence firing
    // on one platform. It is `commandRunsHook` refusing the shape on both.
    chmodSync(ctx.hookScript, 0o755);
    const document = fenceDocument();
    const hooks = deepCopyDocument(roleHooks(document, "worker"));
    firstHook(hooks)["command"] = "{hook_script} --role worker --fence {fence_path}";
    const patched = mutate(document, "worker", { hooks });
    const refusal = expectRefusal(
      () => renderFence("worker", ctx, { document: patched }),
      FenceRefusal,
    );
    // Set equality, not `toContain`: `hook-absent` alone is the whole claim.
    // An extra `hook-unresolvable` would mean the launcher check refused the
    // command first and this case had stopped measuring the invocation rule.
    expect([...new Set(refusal.codes)].sort()).toEqual([RefusalReason.HOOK_ABSENT]);
  });
});

// ---------------------------------------------------------------------------
// document surgery -- the source's inline `json.loads(json.dumps(...))` edits
// ---------------------------------------------------------------------------

/** `document["roles"][role]["hooks"]`, as an object. */
function roleHooks(document: RoleDocument, role: string): Record<string, unknown> {
  const body = document.roles[role];
  if (!isRecord(body) || !isRecord(body["hooks"])) {
    throw new Error(`role ${role} has no hooks object`);
  }
  return body["hooks"];
}

/** `hooks["PreToolUse"][0]`. Throws where Python raises `KeyError`/`IndexError`. */
function firstPreToolUseGroup(hooks: Record<string, unknown>): Record<string, unknown> {
  const groups = hooks["PreToolUse"];
  if (!Array.isArray(groups) || !isRecord(groups[0])) {
    throw new Error("hooks.PreToolUse[0] is not an object");
  }
  return groups[0];
}

/** `hooks["PreToolUse"][0]["hooks"][0]`. */
function firstHook(hooks: Record<string, unknown>): Record<string, unknown> {
  const inner = firstPreToolUseGroup(hooks)["hooks"];
  if (!Array.isArray(inner) || !isRecord(inner[0])) {
    throw new Error("hooks.PreToolUse[0].hooks[0] is not an object");
  }
  return inner[0];
}
