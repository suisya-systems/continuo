import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { renderFence } from "../../src/fencing/renderer.js";
import { specMatches } from "../../src/fencing/rules.js";
import { writeFence } from "../../src/fencing/state.js";
import {
  fenceCaseRoot,
  fenceContext,
  fenceDocument,
  shippedHookScript,
} from "./helpers/fence-cases.js";

/**
 * `codex_hook.mjs`, the Codex worker's `PreToolUse` hook (D-1114), run as the
 * process Codex runs.
 *
 * Codex lets a call through when its hook exits 1, crashes or times out, and
 * under `approval_policy = "never"` it has no permission mode behind the hook,
 * so this hook is an allowlist and is default deny. A default-deny gate is
 * trivially "correct" on every deny case if it denies everything, so every
 * deny below sits next to an allow of the nearest call that should pass
 * (anti-vacuity): the gate is shown open where it must be, not merely shut.
 *
 * As with `deny-hook.test.ts`, a subprocess case runs plain Node against
 * `dist/fencing/`, so a missing build is asserted rather than left to read as a
 * deny.
 */

const CODEX_HOOK = fileURLToPath(new URL("../../src/fencing/codex_hook.mjs", import.meta.url));
const BUILT_CODEX_HOOK = fileURLToPath(
  new URL("../../dist/fencing/codex_hook.mjs", import.meta.url),
);
const BUILT_RULES = fileURLToPath(new URL("../../dist/fencing/rules.js", import.meta.url));
const MCP_SERVER = "continuo-messagebus";

function requireBuild(): void {
  expect(
    existsSync(BUILT_RULES) && existsSync(BUILT_CODEX_HOOK),
    "codex_hook.mjs loads rules.js from dist/fencing/ when it runs as a process. " +
      "Run `npm run build` first -- `npm test` does not.",
  ).toBe(true);
}

interface Lap {
  readonly root: string;
  readonly fencePath: string;
  readonly logPath: string;
  readonly workerDir: string;
  readonly interlockRoot: string;
}

/** A worker fence on disk, with `allowed_bash` merged in as a lap renders it. */
function lap(allowedBash: readonly string[] = ["npm test", "git push origin main"]): Lap {
  const root = fenceCaseRoot();
  const ctx = fenceContext(root, { hookScript: shippedHookScript() });
  const fence = renderFence("worker", ctx, { document: fenceDocument(), allowedBash });
  const fencePath = writeFence(fence, join(root, "fence-worker.json"));
  return {
    root,
    fencePath,
    logPath: join(root, "hook-000.jsonl"),
    workerDir: ctx.workerDir,
    interlockRoot: ctx.interlockRoot,
  };
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function hookArgs(l: Lap, overrides: Readonly<Record<string, string>> = {}): string[] {
  const values: Record<string, string> = {
    "--role": "worker",
    "--fence": l.fencePath,
    "--mcp-server": MCP_SERVER,
    "--log": l.logPath,
    ...overrides,
  };
  return Object.entries(values).flat();
}

function runRaw(
  l: Lap,
  input: string,
  argv: readonly string[] = hookArgs(l),
  script = CODEX_HOOK,
): Run {
  requireBuild();
  const result = spawnSync(process.execPath, [script, ...argv], {
    input,
    encoding: "utf8",
    cwd: l.root,
    timeout: 15_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function call(
  l: Lap,
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, unknown>> = {},
): Run {
  const event = {
    session_id: "s",
    turn_id: "turn-1",
    cwd: l.workerDir,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "exec-1",
    ...extra,
  };
  return runRaw(l, JSON.stringify(event));
}

function expectAllowed(run: Run): void {
  expect(run.stderr, run.stdout).toBe("");
  expect(run.stdout).toBe("");
  expect(run.status).toBe(0);
}

/** The deny contract: JSON deny on stdout, the reason on stderr, exit 2. */
function expectDenied(run: Run, reason?: RegExp): string {
  expect(run.status, run.stderr).toBe(2);
  const payload = JSON.parse(run.stdout) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  expect(payload.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(payload.hookSpecificOutput.permissionDecision).toBe("deny");
  const text = payload.hookSpecificOutput.permissionDecisionReason;
  expect(run.stderr).toBe(`${text}\n`);
  if (reason !== undefined) {
    expect(text).toMatch(reason);
  }
  return text;
}

function logLines(l: Lap): Record<string, unknown>[] {
  return readFileSync(l.logPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const bash = (command: string): Record<string, unknown> => ({ command });
const patch = (...lines: string[]): Record<string, unknown> => ({
  command: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n"),
});

describe("the fence the hook reads", () => {
  test("allowed_bash is carried in the persisted fence's settings.permissions.allow", () => {
    // Checked rather than assumed: the hook's allowlist is read from here.
    const l = lap(["npm test"]);
    const onDisk = JSON.parse(readFileSync(l.fencePath, "utf8")) as {
      settings: { permissions: { allow: string[] } };
    };
    expect(onDisk.settings.permissions.allow).toContain("Bash(git add:*)");
    expect(onDisk.settings.permissions.allow).toContain("Bash(npm test)");
  });

  test("the exported specMatches is Claude's prefix and exact matcher", () => {
    expect(specMatches("git add:*", "git add x")).toBe(true);
    expect(specMatches("git add:*", "git commit -m x")).toBe(false);
    expect(specMatches("npm test", "npm test")).toBe(true);
    expect(specMatches("npm test", "npm testx")).toBe(false);
  });
});

describe("Bash", () => {
  test("a role allow entry admits; a command outside every entry is denied", () => {
    const l = lap();
    expectAllowed(call(l, "Bash", bash("git add src/x.ts")));
    expectAllowed(call(l, "Bash", bash("git status")));
    expectDenied(call(l, "Bash", bash("git checkout main")), /not in this lap's allowed Bash/);
    expectDenied(call(l, "Bash", bash("rm x")), /not in this lap's allowed Bash/);
  });

  test("an allowed_bash entry admits exactly what it names", () => {
    expectAllowed(call(lap(), "Bash", bash("npm test")));
    expectDenied(call(lap([]), "Bash", bash("npm test")), /not in this lap's allowed Bash/);
    expectDenied(call(lap(), "Bash", bash("npm install")), /not in this lap's allowed Bash/);
  });

  test("an allow entry admits only the program it names, split as the shell splits", () => {
    const l = lap(["npm:*", "npm test"]);
    expectAllowed(call(l, "Bash", bash("npm run build")));
    expectAllowed(call(l, "Bash", bash("npm test")));
    // specMatches alone admits each of these: a bare prefix and a normalised
    // path.
    for (const command of ["npm/../node_modules/.bin/x", "./npm test"]) {
      expectDenied(call(l, "Bash", bash(command)), /not in this lap's allowed Bash/);
    }
    // And white space JavaScript splits on and the shell does not; the plain
    // character set refuses these before the program is even read.
    for (const command of [
      "npm\u00a0/../x",
      "cat\u00a0/../node_modules/.bin/x",
      "cat\f/../x",
      "cat\v/../x",
      "cat\ta",
    ]) {
      expectDenied(call(l, "Bash", bash(command)), /may contain only/);
    }
  });

  test("a :* prefix entry ends at a word, not inside one (#223)", () => {
    const l = lap(["git diff:*"]);
    expectAllowed(call(l, "Bash", bash("git diff")));
    expectAllowed(call(l, "Bash", bash("git diff HEAD")));
    // `git difftool --extcmd=...` runs any program; `git diff-tree` is another command.
    for (const command of ["git difftool -y --extcmd=sh HEAD", "git diff-tree HEAD"]) {
      expectDenied(call(l, "Bash", bash(command)), /not in this lap's allowed Bash/);
    }
  });

  // POSIX only: the cases spell paths with `join`, and a Windows path's
  // backslashes are refused by PLAIN_COMMAND before hook.mjs's rules are
  // reached -- by design, and Codex on Windows is unmeasured (D-1114).
  test.skipIf(process.platform === "win32")(
    "hook.mjs's deny rules still apply to an admitted command",
    () => {
      const l = lap();
      // Admitted by the allowed_bash entry, then denied by `Bash(git push *)`.
      const reason = expectDenied(call(l, "Bash", bash("git push origin main")));
      expect(reason).not.toMatch(/not in this lap's allowed Bash/);
      // Admitted by the read-only set, then denied by the denyRead substring rule.
      const secret = join(l.interlockRoot, ".secrets", "token");
      const readReason = expectDenied(call(l, "Bash", bash(`cat ${secret}`)));
      expect(readReason).not.toMatch(/not in this lap's allowed Bash/);
      // The paired allows: same programs, paths no rule names.
      expectAllowed(call(l, "Bash", bash(`cat ${join(l.workerDir, "README.md")}`)));
    },
  );

  test("the read-only set admits reading programs and nothing else", () => {
    const l = lap();
    for (const command of [
      "cat README.md",
      "head -5 a",
      "tail -n 2 a",
      "ls -la",
      "wc -l a",
      "grep -rn foo src",
      "pwd",
    ]) {
      expectAllowed(call(l, "Bash", bash(command)));
    }
    for (const command of ["find . -delete", "sed -n 1p a", "rg --pre x foo", "sh -i", "node"]) {
      expectDenied(call(l, "Bash", bash(command)), /not in this lap's allowed Bash/);
    }
  });

  test("a command with any character outside the plain set is denied, quoted or not", () => {
    const l = lap();
    for (const command of [
      "git status; rm -rf x",
      "git status && rm x",
      "cat a | sh",
      "cat a > b",
      "cat < a",
      "cat `whoami`",
      "cat $(whoami)",
      "cat $HOME",
      "git status\nrm x",
      "git status\rrm x",
      "cat a\\ b",
      "git commit -m 'a; b'",
      "git status &",
      // zsh (a login shell Codex may run the command in) runs code from these.
      "ls *(e:'curl example.com':)",
      "cat =(curl example.com)",
      "git status *(e:'touch x':)",
      // Globs, braces, tilde, history and the like: special in some shell.
      "ls *",
      "cat a?",
      "cat [ab]",
      "cat a{b,c}",
      "cat ~/.ssh/id_ed25519",
      "git commit -m 'hi!'",
      "cat #a",
      "git status\tx",
    ]) {
      expectDenied(call(l, "Bash", bash(command)), /may contain only/);
    }
    // The nearest admitted spellings: every allowed character appears here.
    expectAllowed(call(l, "Bash", bash("git status")));
    expectAllowed(call(l, "Bash", bash("git commit -m 'a b'")));
    expectAllowed(call(l, "Bash", bash('git commit -m "add note: a_b, c+d=e @x 50% -f"')));
    expectAllowed(call(l, "Bash", bash("cat ./src/a.ts")));
  });

  test("a Bash call with no string command is denied", () => {
    const l = lap();
    expectDenied(call(l, "Bash", {}), /no command/);
    expectDenied(call(l, "Bash", { command: ["git", "status"] }), /no command/);
    expectAllowed(call(l, "Bash", bash("git status")));
  });
});

describe("apply_patch", () => {
  test("a patch inside the worktree is allowed, relative or absolute", () => {
    const l = lap();
    expectAllowed(call(l, "apply_patch", patch("*** Add File: notes.txt", "+hi")));
    expectAllowed(
      call(l, "apply_patch", patch(`*** Update File: ${join(l.workerDir, "a.ts")}`, "@@", "+x")),
    );
  });

  test("a path an Edit rule denies is denied, whichever header names it", () => {
    const l = lap();
    const settings = join(homedir(), ".claude", "settings.json");
    for (const header of [
      `*** Add File: ${settings}`,
      `*** Update File: ${settings}`,
      `*** Delete File: ${settings}`,
    ]) {
      expectDenied(call(l, "apply_patch", patch(header, "+x")));
    }
    // A move whose target is denied, from a source that is not.
    expectDenied(
      call(l, "apply_patch", patch("*** Update File: a.txt", `*** Move to: ${settings}`, "@@")),
    );
    // Relative paths are resolved against the event's cwd before the check.
    const state = join(l.interlockRoot, ".state");
    expectDenied(
      call(l, "apply_patch", patch("*** Add File: .state/x", "+x"), { cwd: l.interlockRoot }),
    );
    expectDenied(call(l, "apply_patch", patch(`*** Add File: ${state}/x`, "+x")));
    // The paired allow: the same header shapes on a path nothing denies.
    expectAllowed(
      call(l, "apply_patch", patch("*** Update File: a.txt", "*** Move to: b.txt", "@@")),
    );
  });

  test("a header behind a U+0085 (NEL) is still checked, as Codex's parser trims it", () => {
    const l = lap();
    const settings = join(homedir(), ".claude", "settings.json");
    expectDenied(
      call(
        l,
        "apply_patch",
        patch("*** Add File: ok.txt", "+ok", `\u0085*** Add File: ${settings}`, "+x"),
      ),
    );
    expectAllowed(call(l, "apply_patch", patch("*** Add File: ok.txt", "+ok", "\u0085+x")));
  });

  test("a patch the hook cannot read paths from is denied", () => {
    const l = lap();
    expectDenied(call(l, "apply_patch", patch()), /names no file/);
    expectDenied(call(l, "apply_patch", {}), /no patch text/);
    expectDenied(call(l, "apply_patch", patch("*** Copy File: x", "+x")), /unrecognised/);
    expectDenied(
      call(l, "apply_patch", patch("*** Add File: x", "+x"), { cwd: undefined }),
      /no absolute cwd/,
    );
    expectAllowed(call(l, "apply_patch", patch("*** Add File: x", "+x")));
  });
});

describe("tools by name", () => {
  test("only the named MCP server is admitted, in the spelling Codex gives it", () => {
    const l = lap();
    // Measured on the first real lap: `continuo-messagebus`'s tools reach the
    // hook as `mcp__continuo_messagebus__<tool>`.
    expectAllowed(call(l, "mcp__continuo_messagebus__send", { text: "hi" }));
    for (const name of [
      "mcp__codex_apps__sites_deploy_site_version",
      "mcp__other__send",
      `mcp__${MCP_SERVER}__send`,
      "mcp__continuo_messagebusx__send",
    ]) {
      expectDenied(call(l, name, {}), /not available in a lap/);
    }
  });

  test("every other tool Codex exposes is denied", () => {
    const l = lap();
    for (const name of [
      "webrun",
      "view_image",
      "collaborationspawn_agent",
      "collaborationwait_agent",
      "clockcurr_time",
      "image_gen__imagegen",
      "create_goal",
      "request_plugin_install",
      "list_mcp_resources",
      "read_mcp_resource",
      "write_stdin",
      "Read",
    ]) {
      expectDenied(call(l, name, {}), /not available in a lap/);
    }
    expectAllowed(call(l, "Bash", bash("pwd")));
  });
});

describe("fail closed", () => {
  test("stdin that is not a tool event is denied", () => {
    const l = lap();
    expectDenied(runRaw(l, "not json"), /JSON event/);
    expectDenied(runRaw(l, ""), /JSON event/);
    expectDenied(runRaw(l, "[1]"), /not a JSON object/);
    expectDenied(runRaw(l, JSON.stringify({ tool_input: bash("pwd") })), /no tool_name/);
    expectAllowed(runRaw(l, JSON.stringify({ tool_name: "Bash", tool_input: bash("pwd") })));
  });

  test("a missing fence or another role's fence denies an otherwise allowed call", () => {
    const l = lap();
    const event = JSON.stringify({ tool_name: "Bash", tool_input: bash("git status") });
    expectDenied(runRaw(l, event, hookArgs(l, { "--fence": join(l.root, "absent.json") })));
    expectDenied(runRaw(l, event, hookArgs(l, { "--role": "curator" })));
    expectAllowed(runRaw(l, event));
  });

  test("a command line that is not the rendered shape is denied", () => {
    const l = lap();
    const event = JSON.stringify({ tool_name: "Bash", tool_input: bash("pwd") });
    const good = hookArgs(l);
    expectDenied(runRaw(l, event, good.slice(0, -2)));
    expectDenied(runRaw(l, event, [...good, "--extra", "x"]));
    expectDenied(runRaw(l, event, [...good, "--role", "worker"]));
    expectAllowed(runRaw(l, event, good));
  });

  test("a log line that cannot be written denies", () => {
    const l = lap();
    const event = JSON.stringify({ tool_name: "Bash", tool_input: bash("pwd") });
    const unwritable = join(l.root, "no-such-dir", "hook.jsonl");
    expectDenied(runRaw(l, event, hookArgs(l, { "--log": unwritable })), /log/);
    expect(existsSync(unwritable)).toBe(false);
    expectAllowed(runRaw(l, event));
  });

  test("the built copy runs from dist/fencing/ as well as from the source tree", () => {
    const l = lap();
    const event = JSON.stringify({ tool_name: "Bash", tool_input: bash("git status") });
    expect(readFileSync(BUILT_CODEX_HOOK).equals(readFileSync(CODEX_HOOK))).toBe(true);
    expectAllowed(runRaw(l, event, hookArgs(l), BUILT_CODEX_HOOK));
    expectDenied(
      runRaw(
        l,
        JSON.stringify({ tool_name: "webrun", tool_input: {} }),
        hookArgs(l),
        BUILT_CODEX_HOOK,
      ),
    );
  });
});

describe("the log", () => {
  test("one line per call, allowed and denied, carrying the turn id", () => {
    const l = lap();
    expectAllowed(call(l, "Bash", bash("git status")));
    const reason = expectDenied(call(l, "webrun", { search_query: [{ q: "x" }] }));
    expect(logLines(l)).toEqual([
      {
        tool_name: "Bash",
        tool_input: { command: "git status" },
        denied: false,
        reason: null,
        turn_id: "turn-1",
      },
      {
        tool_name: "webrun",
        tool_input: { search_query: [{ q: "x" }] },
        denied: true,
        reason,
        turn_id: "turn-1",
      },
    ]);
  });
});
