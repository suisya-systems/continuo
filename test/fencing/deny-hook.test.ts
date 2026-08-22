import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { probesFor } from "../../src/fencing/battery.js";
import { pyJsonDumps } from "../../src/fencing/pyjson.js";
import {
  type FenceContext,
  type RoleDocument,
  renderFence,
  roleNames,
} from "../../src/fencing/renderer.js";
import type { Fence } from "../../src/fencing/rules.js";
import { split as shlexSplit } from "../../src/fencing/shlex.js";
import { writeFence } from "../../src/fencing/state.js";
import {
  fenceCaseRoot,
  fenceContext,
  fenceDocument,
  publishedFence,
  replaceFenceContext,
  shippedHookScript,
} from "./helpers/fence-cases.js";

/**
 * The `PreToolUse` deny hook -- proven to deny, not merely to run.
 *
 * Ported from interlock `tests/fencing/test_deny_hook.py` at `65f36c5`. Every
 * case here maps to one source node id.
 *
 * Interlock's issue #9 is explicit: "Assert the *effect* -- the forbidden
 * operation did not happen -- and never the hook's own exit code." A6 of
 * `investigation/pre-spawn-fence-search.md` (U35) watched a hook exit 1 and be
 * absorbed, and `investigation/i04-pretooluse-fence-probe.md` reproduced the
 * same absorption on `PreToolUse` itself: the hook ran, exited 1, the tool call
 * went through, and the session exited 0.
 *
 * So the division of labour in this suite is deliberate, and it is carried into
 * the port unchanged:
 *
 * - **What the hook decides** is asserted here, in process and by subprocess,
 *   from the hook's *decision payload*.
 * - **That the CLI honours the decision** is not assertable in a unit test at
 *   all. It is measured in `investigation/i04-pretooluse-fence-probe.md` by
 *   whether the forbidden operation happened, and that file is the evidence --
 *   not anything below.
 *
 * The exit status is asserted in exactly one place -- the "exit status
 * contract" block -- and for one reason: to pin that this hook never uses
 * **1**, the status measured being swallowed. That is an assertion about our
 * hook's contract, not evidence that a fence held. Nothing here may grow into
 * an exit-code suite.
 *
 * ## What the port had to do differently, and why it is not weaker
 *
 * The source launches the hook two ways -- `python -m
 * claude_org_runtime.fencing.hook` for most cases, and the *rendered command
 * string* for the last class, whose whole point is that the two launches are
 * not the same program. Node has no `-m`: `hook.mjs` is only ever launched by
 * path (D-0204), so both launches collapse onto `node <hook.mjs>` and the last
 * class no longer differs by *mechanism*. It still differs in everything it was
 * written to vary -- the argv comes out of the rendered settings via `shlex`,
 * the child runs in a foreign working directory, and the environment is
 * stripped -- so it is kept, and the property it defends is defended instead by
 * the two assertions marked "the rendered command reached the FENCE" below.
 * Without them a port-specific hole opens: interlock's hook *exits 1* when it
 * cannot load itself, so the source's `returncode != 1` catches that; ours
 * denies with exit 2 instead, so `returncode != 1` no longer distinguishes "the
 * fence denied this probe" from "the hook could not load and denied by
 * default". Asserting the rule id closes it.
 *
 * That hazard is not local to this file: see docs/test-translation-conventions.md
 * section 9, "Make it fail on purpose, and confirm it fails for the reason you expect", which collects the three cases in this
 * port where a green case had stopped proving anything.
 */

/**
 * The compiled fence logic `hook.mjs` loads at runtime.
 *
 * `hook.mjs` resolves `state.js` / `pyrepr.js` / `pyjson.js` against two fixed
 * directories: beside itself, and `../../dist/fencing/`. Under Vitest the first
 * one resolves through Vite (which maps `state.js` onto `state.ts`), so an
 * **in-process** case needs no build. A **subprocess** case is plain Node with
 * no resolver, so it needs `dist/fencing/` to exist.
 *
 * `npm test` does not build. A missing build therefore does not make the hook
 * misbehave -- it makes it deny with `fence-unavailable`, which is fail-closed
 * and is exactly what several cases below expect to see for other reasons. That
 * is the silent shape: a suite green while the hook never read a fence. So the
 * subprocess helpers assert the build is present first, and say what to run.
 */
const BUILT_FENCE_LOGIC = fileURLToPath(new URL("../../dist/fencing/state.js", import.meta.url));

function requireBuiltFenceLogic(): void {
  expect(
    existsSync(BUILT_FENCE_LOGIC),
    "the deny hook resolves its fence logic from dist/fencing/ when it runs as a real process, " +
      "and that directory is missing. Run `npm run build` first -- `npm test` does not.",
  ).toBe(true);
}

/**
 * The hook module, loaded by URL.
 *
 * `hook.mjs` is deliberately outside `tsconfig.json`'s program (D-0204: it is
 * hand-written JavaScript because it is launched by path and Node cannot run a
 * `.ts` file), so a static `import` of it from a TypeScript test is a
 * compile error -- there is no declaration file, and adding one to `src/`
 * would put a second description of the hook's surface next to the JSDoc that
 * already describes it. Importing by a computed URL types the module as `any`
 * and the shape is restated here instead, next to the cases that use it.
 *
 * One module instance, from one specifier, matters: `hookSeams` is the record
 * the hook's own call sites go through, so a case that replaces an entry has to
 * be holding the same object the module is reading. That case replaces it in a
 * child process (see "an internal error denies instead of escaping as a
 * traceback"), so only the surface the in-process cases call is restated here.
 */
interface HookDecision {
  readonly denied: boolean;
  readonly ruleId: string | null;
  readonly layer: string | null;
  readonly reason: string;
}

interface HookModule {
  readonly EXIT_DENY: number;
  readonly EXIT_NO_OPINION: number;
  decidePayload(
    fencePath: string,
    event: Readonly<Record<string, unknown>>,
    options?: { role?: string | null },
  ): Promise<[HookDecision, Record<string, unknown>]>;
}

function hookUrl(): string {
  return pathToFileURL(shippedHookScript()).href;
}

async function loadHook(): Promise<HookModule> {
  return (await import(hookUrl())) as unknown as HookModule;
}

/**
 * The `ctx` and `document` fixtures, as one per-test call.
 *
 * Function scope in the source and function scope here. `hookScript` is the
 * **shipped** hook, which is what the source's `ctx` composes: its `hook_script`
 * fixture returns `default_hook_script()`. Continuo's default is a throwaway
 * file for the renderer to stat (see `fence-cases.ts`), and this is the one
 * suite where that substitution would be fatal rather than cosmetic -- a
 * throwaway would exit 0, and exit 0 from a `PreToolUse` hook reads as *no
 * opinion*.
 */
function fixtures(): { ctx: FenceContext; document: RoleDocument; root: string } {
  const root = fenceCaseRoot();
  return {
    root,
    ctx: fenceContext(root, { hookScript: shippedHookScript() }),
    document: fenceDocument(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `payload["hookSpecificOutput"]`.
 *
 * Throws where Python raises `KeyError`, rather than returning an empty object.
 * An empty object would make `permissionDecision == "deny"` fail with a message
 * about `undefined` -- or, worse, let a later `toEqual` on a nested field pass
 * vacuously against a payload that carries no decision at all.
 */
function hookSpecificOutput(payload: Record<string, unknown>): Record<string, unknown> {
  const specific = payload["hookSpecificOutput"];
  if (!isRecord(specific)) {
    throw new Error(`payload carries no hookSpecificOutput object: ${JSON.stringify(payload)}`);
  }
  return specific;
}

/** `payload["interlock"]["rule_id"]` -- the wire key, verbatim (D-0201). */
function payloadRuleId(payload: Record<string, unknown>): unknown {
  const interlock = payload["interlock"];
  if (!isRecord(interlock)) {
    throw new Error(`payload carries no interlock object: ${JSON.stringify(payload)}`);
  }
  return interlock["rule_id"];
}

/**
 * `fence.settings["hooks"]["PreToolUse"]`, flattened to command strings.
 *
 * Every step throws where the source would raise `KeyError` or `TypeError`. A
 * lenient walk that returned `[]` would make "the rendered command passes the
 * role" pass against settings that declare no hooks whatsoever.
 */
function renderedCommands(fence: Fence): string[] {
  const hooks = fence.settings["hooks"];
  if (!isRecord(hooks)) {
    throw new Error(`${fence.role}: settings has no 'hooks' object`);
  }
  const groups = hooks["PreToolUse"];
  if (!Array.isArray(groups)) {
    throw new Error(`${fence.role}: settings.hooks has no 'PreToolUse' list`);
  }
  const commands: string[] = [];
  for (const [index, group] of groups.entries()) {
    if (!isRecord(group)) {
      throw new Error(`${fence.role}: settings.hooks.PreToolUse[${index}] is not an object`);
    }
    const entries = group["hooks"];
    if (!Array.isArray(entries)) {
      throw new Error(`${fence.role}: settings.hooks.PreToolUse[${index}] has no 'hooks' list`);
    }
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry["command"] !== "string") {
        throw new Error(`${fence.role}: a PreToolUse hook entry carries no command string`);
      }
      commands.push(entry["command"]);
    }
  }
  return commands;
}

/** The source's `_rendered_command`: the first command the renderer emitted. */
function renderedCommand(fence: Fence): string {
  const command = renderedCommands(fence)[0];
  if (command === undefined) {
    throw new Error(`${fence.role}: the rendered settings declare no PreToolUse command`);
  }
  return command;
}

/**
 * The source's `_clean_env`, which pops `PYTHONPATH` so the package is
 * deliberately *not* importable from the child's environment.
 *
 * There is no `PYTHONPATH` here, and that is a property of the port rather than
 * a gap in the translation: `hook.mjs` resolves its dependencies against two
 * fixed directories relative to its own file and states in its header that no
 * environment variable may extend that list, precisely because the environment
 * is inherited by the child the hook is fencing. So the nearest analogues are
 * removed -- `NODE_PATH`, the one variable that can add a module search root,
 * and `NODE_OPTIONS`, which can inject a loader -- and the case still runs the
 * hook with nothing in the environment helping it find its own code.
 */
function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment["PYTHONPATH"];
  delete environment["NODE_PATH"];
  delete environment["NODE_OPTIONS"];
  return environment;
}

interface HookRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The source's module-level `run_hook_subprocess`.
 *
 * `spawnSync` with `input` hands the child a pipe that is closed once the bytes
 * are written, so `readStdinToEnd()` sees EOF. That is not a convenience: the
 * hook's stdin read is synchronous and blocks to end of file, exactly as
 * `sys.stdin.read()` does, so an in-process `main()` under the runner would
 * inherit the runner's own stdin and wait on it forever whenever that is a
 * terminal.
 */
function runHookSubprocess(fencePath: string, event: Readonly<Record<string, unknown>>): HookRun {
  requireBuiltFenceLogic();
  const result = spawnSync(process.execPath, [shippedHookScript(), "--fence", fencePath], {
    input: pyJsonDumps(event),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** `subprocess.run(..., input=<raw>)` for the two cases that send raw bytes. */
function runHookWithRawStdin(fencePath: string, input: string): HookRun {
  requireBuiltFenceLogic();
  const result = spawnSync(process.execPath, [shippedHookScript(), "--fence", fencePath], {
    input,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Run one rendered command string, the way the source runs it. */
function runRenderedCommand(
  command: string,
  event: Readonly<Record<string, unknown>>,
  cwd: string,
): HookRun {
  requireBuiltFenceLogic();
  const argv = shlexSplit(command);
  const launcher = argv[0];
  if (launcher === undefined) {
    throw new Error("the rendered hook command is empty");
  }
  const result = spawnSync(launcher, argv.slice(1), {
    input: pyJsonDumps(event),
    encoding: "utf8",
    cwd,
    env: cleanEnvironment(),
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** `json.loads(result.stdout)`, with the parse failure naming the payload. */
function stdoutPayload(run: HookRun): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (error) {
    throw new Error(
      `the hook wrote no JSON payload (status ${String(run.status)}): ` +
        `${JSON.stringify(run.stdout)} / stderr ${JSON.stringify(run.stderr)} / ${String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`the hook's payload is not an object: ${run.stdout}`);
  }
  return parsed;
}

/** The `PreToolUse` event one probe stands for. */
function probeEvent(probe: {
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    tool_name: probe.toolName,
    // `dict(probe.tool_input)`: a copy, so nothing downstream can retarget the
    // probe the battery proved.
    tool_input: { ...probe.toolInput },
  };
}

describe("the hook denies", () => {
  test("every probe is denied through the hook", async () => {
    // The battery, run through the hook rather than the fence object.
    //
    // Same probes, second observation point. If the hook and the fence ever
    // disagreed, the enforcement path would be narrower than the probed one.
    const hook = await loadHook();
    const { fence, path } = publishedFence();
    for (const probe of probesFor(fence)) {
      const [decision, payload] = await hook.decidePayload(path, probeEvent(probe));
      expect(decision.denied, probe.ruleId).toBe(true);
      expect(decision.ruleId).toBe(probe.ruleId);
      expect(hookSpecificOutput(payload)["permissionDecision"]).toBe("deny");
    }
  });

  test("all roles deny all their probes through the hook", async () => {
    const hook = await loadHook();
    const { ctx, document, root } = fixtures();
    for (const role of roleNames(document)) {
      const fence = renderFence(role, ctx, { document });
      const path = writeFence(fence, join(root, `fence-${role}.json`));
      for (const probe of probesFor(fence)) {
        const [decision] = await hook.decidePayload(path, probeEvent(probe));
        expect(decision.denied, `${role}:${probe.ruleId}`).toBe(true);
      }
    }
  });

  test("the payload carries both output shapes", async () => {
    // Which shape a given CLI build honours is not something a fence should
    // depend on knowing, so both are emitted.
    const hook = await loadHook();
    const { fence, path } = publishedFence();
    const probe = probesFor(fence)[0];
    if (probe === undefined) {
      throw new Error("the worker fence has no rules, so the battery has no probe to send");
    }
    const [, payload] = await hook.decidePayload(path, probeEvent(probe));
    expect(hookSpecificOutput(payload)["hookEventName"]).toBe("PreToolUse");
    expect(hookSpecificOutput(payload)["permissionDecision"]).toBe("deny");
    expect(payload["decision"]).toBe("block");
    // `assert payload["reason"]`. Python's truth test on a `str` is exactly
    // "non-empty", and spelling it that way also refuses a payload whose reason
    // is not a string at all -- which `toBeTruthy` would accept.
    const reason = payload["reason"];
    expect(typeof reason === "string" && reason !== "").toBe(true);
  });

  test("an unfenced operation gets no opinion rather than an allow", async () => {
    // The fence never says "allow".
    //
    // Saying so would make this hook an authority on *permitting* operations,
    // and a bug here would then widen the worker's reach instead of narrowing
    // it.
    const hook = await loadHook();
    const { path } = publishedFence();
    const [decision, payload] = await hook.decidePayload(path, {
      tool_name: "Read",
      tool_input: { file_path: "/tmp/ordinary.txt" },
    });
    expect(decision.denied).toBe(false);
    expect(payload).toEqual({});
  });
});

describe("fail open is tested for explicitly", () => {
  // Issue #9's fifth criterion, and F2/V15/V16's ignore-and-continue habit.
  //
  // Every one of these is an input the hook could plausibly shrug at. None of
  // them may produce anything but a deny.

  test("missing fence file denies", async () => {
    const hook = await loadHook();
    const root = fenceCaseRoot();
    const [decision, payload] = await hook.decidePayload(join(root, "absent.json"), {
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    });
    expect(decision.denied).toBe(true);
    expect(hookSpecificOutput(payload)["permissionDecision"]).toBe("deny");
  });

  test("malformed fence file denies", async () => {
    const hook = await loadHook();
    const root = fenceCaseRoot();
    const path = join(root, "fence.json");
    writeFileSync(path, "{ this is not json", "utf8");
    const [decision] = await hook.decidePayload(path, { tool_name: "Bash", tool_input: {} });
    expect(decision.denied).toBe(true);
  });

  test("fence file with no rules denies", async () => {
    const hook = await loadHook();
    const root = fenceCaseRoot();
    const path = join(root, "fence.json");
    // `json.dumps`, not `JSON.stringify`: this file is read back by the hook's
    // own reader, and the two differ in separators and in `ensure_ascii`.
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
    const [decision] = await hook.decidePayload(path, { tool_name: "Bash", tool_input: {} });
    expect(decision.denied).toBe(true);
  });

  test("event with no tool name denies rather than guessing", async () => {
    const hook = await loadHook();
    const { path } = publishedFence();
    const [decision] = await hook.decidePayload(path, { tool_input: { command: "rm -rf /" } });
    expect(decision.denied).toBe(true);
  });

  test("a rule scoped to a tool denies an unreadable payload", async () => {
    // An unrecognized payload shape must not become a silent bypass.
    const hook = await loadHook();
    const { path } = publishedFence();
    const [decision] = await hook.decidePayload(path, { tool_name: "WebFetch", tool_input: {} });
    expect(decision.denied).toBe(true);
  });

  test("empty stdin denies", () => {
    const { path } = publishedFence();
    const run = runHookWithRawStdin(path, "");
    expect(stdoutPayload(run)["decision"]).toBe("block");
  });

  test("non json stdin denies", () => {
    const { path } = publishedFence();
    const run = runHookWithRawStdin(path, "not json at all");
    expect(stdoutPayload(run)["decision"]).toBe("block");
  });

  test("an internal error denies instead of escaping as a traceback", async () => {
    // An unhandled traceback exits **1**, and exit 1 is the status i04 section
    // 4 measured being absorbed. So the catch-all denies.
    //
    // ADAPTED, in the launch and in nothing else. The source is
    // `monkeypatch.setattr(hook_module, "read_fence", boom)` followed by an
    // in-process `main([...])`; the port's equivalent of the monkeypatch is a
    // replacement of `hookSeams.readFence` (D-0014), and that is what happens
    // below -- but `main()` reads stdin synchronously to EOF before it reaches
    // the fence, so calling it inside the runner would block on the runner's
    // own stdin whenever that is a terminal. So the seam is replaced, and
    // `main()` is called, inside a child Node process that has a closed stdin.
    // The assertion is the source's (`main` RETURNED `EXIT_DENY`, read back
    // from a file the child writes) plus the thing the case is named for: the
    // child's own exit status, which would be 1 if the error had escaped.
    //
    // `boom` throws a plain `Error`, as the source's throws a plain
    // `RuntimeError`. That matters more here than it reads: a `FenceStateError`
    // would take the *unreadable fence* branch instead, and `hook.mjs` loads
    // its `state.js` from `dist/`, so a `FenceStateError` constructed from
    // `src/` is a different class object with the same name -- a case built
    // that way would be asserting a different branch than it named.
    const hook = await loadHook();
    const { path } = publishedFence();
    const root = fenceCaseRoot();
    const runner = join(root, "internal-error-runner.mjs");
    const codePath = join(root, "main-returned.txt");
    writeFileSync(
      runner,
      [
        "// Written by test/fencing/deny-hook.test.ts. Replaces the hook's own",
        "// `read_fence` seam and runs `main()` in a process whose stdin is closed.",
        'import { writeFileSync } from "node:fs";',
        "const [hookHref, fencePath, outPath] = process.argv.slice(2);",
        "const hook = await import(hookHref);",
        "hook.hookSeams.readFence = () => {",
        '  throw new Error("synthetic failure inside the hook");',
        "};",
        'const code = await hook.main(["--fence", fencePath]);',
        'writeFileSync(outPath, String(code), "utf8");',
        "process.exitCode = code;",
        "",
      ].join("\n"),
      "utf8",
    );

    requireBuiltFenceLogic();
    const result = spawnSync(process.execPath, [runner, hookUrl(), path, codePath], {
      input: "",
      encoding: "utf8",
    });
    expect(
      existsSync(codePath),
      `main() never returned: status ${String(result.status)}, stderr ${result.stderr}`,
    ).toBe(true);
    // `assert code == EXIT_DENY`, with EXIT_DENY read from the hook rather than
    // written as `2` here: a suite that hard-codes the status is a suite that
    // agrees with itself rather than with the module.
    const returned = readFileSync(codePath, "utf8");
    expect(returned).toBe(String(hook.EXIT_DENY));
    expect(result.status, result.stderr).toBe(hook.EXIT_DENY);
  });
});

describe("the fence must belong to the role", () => {
  // The fence path is publish-and-replace, so identity has to be checked.
  //
  // Two roles accidentally sharing a `fencePath` would mean a later spawn
  // silently re-points the earlier one at somebody else's rules -- and a worker
  // would lose denials the curator never had, with nothing failing.

  test("a fence for another role is denied", async () => {
    const hook = await loadHook();
    const { ctx, document, root } = fixtures();
    const curator = renderFence("curator", ctx, { document });
    const path = writeFence(curator, join(root, "shared.json"));
    const [decision] = await hook.decidePayload(
      path,
      { tool_name: "Bash", tool_input: { command: "echo hi" } },
      { role: "worker" },
    );
    expect(decision.denied).toBe(true);
    // The source asserts `"curator" in reason and "worker" in reason`. Both
    // names are asserted in their quoted form, which is how the hook
    // interpolates them: the reason also carries the fence PATH, and a bare
    // substring test would be satisfied by a temporary directory that happened
    // to contain the word -- the D-0020 failure, in the one file where the
    // refusal message is built from a path this test chose.
    expect(decision.reason).toContain("'curator'");
    expect(decision.reason).toContain("'worker'");
  });

  test("the matching role is evaluated normally", async () => {
    const hook = await loadHook();
    const { ctx, document, root } = fixtures();
    const worker = renderFence("worker", ctx, { document });
    const path = writeFence(worker, join(root, "worker.json"));
    const probe = probesFor(worker)[0];
    if (probe === undefined) {
      throw new Error("the worker fence has no rules, so the battery has no probe to send");
    }
    const [decision] = await hook.decidePayload(path, probeEvent(probe), { role: "worker" });
    expect(decision.denied).toBe(true);
    expect(decision.ruleId).toBe(probe.ruleId);
  });

  test("the rendered command passes the role", () => {
    const { ctx, document } = fixtures();
    const fence = renderFence("worker", ctx, { document });
    expect(renderedCommands(fence).some((command) => command.includes("--role worker"))).toBe(true);
  });
});

describe("exit status contract", () => {
  // One narrow assertion, and a note about what it is not.
  //
  // This does **not** show that a denial was enforced. It shows only that this
  // hook never signals a denial with exit **1**, the status
  // `investigation/i04-pretooluse-fence-probe.md` section 4 measured being
  // absorbed at exit 0 with no other trace. Enforcement is measured in that
  // file, by whether the forbidden operation happened.

  test("a deny never uses exit 1", async () => {
    const hook = await loadHook();
    const { fence, path } = publishedFence();
    const probe = probesFor(fence)[0];
    if (probe === undefined) {
      throw new Error("the worker fence has no rules, so the battery has no probe to send");
    }
    const run = runHookSubprocess(path, probeEvent(probe));
    expect(run.status, run.stderr).not.toBe(1);
    expect(run.status, run.stderr).toBe(hook.EXIT_DENY);
  });

  test("no opinion exits zero and says nothing", async () => {
    const hook = await loadHook();
    const { path } = publishedFence();
    const run = runHookSubprocess(path, {
      tool_name: "Read",
      tool_input: { file_path: "/tmp/ordinary.txt" },
    });
    expect(run.status, run.stderr).toBe(hook.EXIT_NO_OPINION);
    expect(run.stdout.trim()).toBe("");
  });

  test("a deny is readable on both stdout and stderr", () => {
    const { fence, path } = publishedFence();
    const probe = probesFor(fence)[0];
    if (probe === undefined) {
      throw new Error("the worker fence has no rules, so the battery has no probe to send");
    }
    const run = runHookSubprocess(path, probeEvent(probe));
    expect(stdoutPayload(run)["decision"]).toBe("block");
    expect(run.stderr.trim()).not.toBe("");
  });
});

describe("the rendered command is the one that works", () => {
  // Run the command the *renderer emits*, not a convenient equivalent.
  //
  // In the source the rest of the file invokes the hook as `python -m
  // claude_org_runtime.fencing.hook`, and that is exactly how a real hole hid:
  // the rendered settings invoke the file **by path**, which runs it with no
  // parent package, and the relative imports at the top raised `ImportError`
  // and exited **1** -- the status i04 section 4 measured being absorbed. Every
  // shipped role would have run behind an inert fence, and the suite would have
  // stayed green.
  //
  // So these tests take the command string out of the rendered settings and
  // execute it, with the hook's own code deliberately *not* reachable through
  // the child's environment.

  test("the rendered command denies a probe", async () => {
    const { ctx, document, root } = fixtures();
    const fence = renderFence("worker", ctx, { document });
    writeFence(fence, ctx.fencePath);
    const probe = probesFor(fence)[0];
    if (probe === undefined) {
      throw new Error("the worker fence has no rules, so the battery has no probe to send");
    }
    const run = runRenderedCommand(renderedCommand(fence), probeEvent(probe), root);
    expect(run.status, run.stderr).not.toBe(1);
    const payload = stdoutPayload(run);
    expect(payload["decision"]).toBe("block");
    // The rendered command reached the FENCE, not merely a deny. See the file
    // header: interlock's hook exits 1 when it cannot load itself and this one
    // denies instead, so without this line a hook that never read the fence
    // would satisfy every assertion above it.
    expect(payloadRuleId(payload)).toBe(probe.ruleId);
  });

  test("the rendered command never exits 1 even when it cannot work", async () => {
    // The failure direction that is silent.
    //
    // Exit 1 is absorbed, so a hook that breaks *must not* break that way --
    // including when the thing that broke is the hook's own ability to load.
    const hook = await loadHook();
    const { ctx, document, root } = fixtures();
    const fence = renderFence("worker", ctx, { document });
    // No fence file at all: the hook cannot answer, so it must deny. Note that
    // `ctx.fencePath` is a name and nothing has written it, which is the state
    // the source relies on here too.
    const run = runRenderedCommand(
      renderedCommand(fence),
      { tool_name: "Bash", tool_input: { command: "echo hi" } },
      root,
    );
    expect(run.status, run.stderr).toBe(hook.EXIT_DENY);
    expect(stdoutPayload(run)["decision"]).toBe("block");
  });

  test("every role rendered command runs", async () => {
    const hook = await loadHook();
    const { ctx, document, root } = fixtures();
    for (const role of roleNames(document)) {
      // `dataclasses.replace(ctx, fence_path=tmp_path / role / "fence.json")`.
      const roleCtx = replaceFenceContext(ctx, { fencePath: join(root, role, "fence.json") });
      const fence = renderFence(role, roleCtx, { document });
      writeFence(fence, roleCtx.fencePath);
      const probe = probesFor(fence)[0];
      if (probe === undefined) {
        throw new Error(`${role}: the fence has no rules, so the battery has no probe to send`);
      }
      const run = runRenderedCommand(renderedCommand(fence), probeEvent(probe), root);
      expect(run.status, `${role}: ${run.stderr}`).toBe(hook.EXIT_DENY);
      const payload = stdoutPayload(run);
      expect(payload["decision"], role).toBe("block");
      // As above: the deny has to be the FENCE's, per role.
      expect(payloadRuleId(payload), role).toBe(probe.ruleId);
    }
  });
});
