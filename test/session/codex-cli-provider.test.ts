/**
 * `CodexCliSessionProvider` (continuo D-1114, issue #220) against the fake
 * `codex` in `./helpers/fake-codex.mjs`.
 *
 * No parity ledger claims this file: interlock has no Codex provider, so every
 * case is target-only. The supervision the provider inherits is the Claude
 * provider's and is covered there; what is pinned here is the dialect -- the
 * argv, the prompt on stdin, the per-session `CODEX_HOME`, the fence
 * translation and its refusals, the adopted identity, and the turn's facts
 * with the post-turn checks.
 *
 * **The hook is real.** A scripted tool call makes the fake run the command
 * the provider wrote into `hooks.json`, which is `src/fencing/codex_hook.mjs`
 * over a fence rendered by the real renderer, so a denial in a report here was
 * decided by the shipped hook. It loads `rules.js` from `dist/`, so the build
 * must exist (`npm test` builds first).
 *
 * Every refusal sits next to the nearest accepted case (anti-vacuity): a gate
 * that refused everything would fail the accepted half.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { expect, test } from "vitest";
import { PyValueError } from "../../src/fencing/pysemantics.js";
import { renderFence } from "../../src/fencing/renderer.js";
import { writeFence } from "../../src/fencing/state.js";
import type { TerminalReport } from "../../src/session/claude_cli_provider.js";
import { CodexCliSessionProvider } from "../../src/session/codex_cli_provider.js";
import {
  Failure,
  FailureKind,
  Ok,
  type ProviderResult,
  SpawnRefused,
} from "../../src/session/provider.js";
import { claudeSessionUuid } from "../../src/session/uuid5.js";
import {
  fenceContext,
  fenceDocument,
  hookScriptForTest,
  shippedHookScript,
} from "../fencing/helpers/fence-cases.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";
import { fakeCodexCli, fakeEnv, fakeMode, spawnLog } from "./helpers/fake-cli.js";
import {
  cliRequest,
  POLL_DEADLINE_MS,
  POLL_INTERVAL_MS,
  spawned,
  stopSessionsAtTeardown,
  waitForExit,
  waitForSpawns,
} from "./helpers/session-cases.js";

const SESSION = "sess-1";
const MCP_SERVER = "continuo-messagebus";

interface Lap {
  readonly root: string;
  readonly cliArgs: readonly string[];
  readonly settingsPath: string;
  readonly codexHome: string;
}

/** A worker fence rendered and published as the materializer does, plus an operator home. */
function lap(
  options: { readonly allowedBash?: readonly string[]; readonly hookScript?: string } = {},
): Lap {
  const root = caseRoot("codexprov");
  const ctx = fenceContext(join(root, "fence"), {
    hookScript: options.hookScript ?? shippedHookScript(),
  });
  const fence = renderFence("worker", ctx, {
    document: fenceDocument(),
    allowedBash: options.allowedBash ?? ["npm test"],
    nonInteractive: true,
  });
  mkdirSync(dirname(ctx.fencePath), { recursive: true });
  writeFence(fence, ctx.fencePath);
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const settingsPath = join(artifacts, "settings.local.json");
  writeFileSync(settingsPath, JSON.stringify(fence.settings), "utf8");
  const mcpPath = join(artifacts, "mcp.json");
  writeFileSync(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER]: {
          command: process.execPath,
          args: [join(root, "endpoint.mjs")],
          env: { INTERLOCK_MESSAGEBUS_DB: join(root, "bus.db") },
        },
      },
    }),
    "utf8",
  );
  const codexHome = join(root, "operator-codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), '{"token":"operator"}', "utf8");
  return {
    root,
    settingsPath,
    codexHome,
    cliArgs: [
      "--settings",
      settingsPath,
      "--permission-mode",
      "acceptEdits",
      "--setting-sources",
      "",
      "--mcp-config",
      mcpPath,
      "--strict-mcp-config",
    ],
  };
}

function providerFor(l: Lap): CodexCliSessionProvider {
  return stopSessionsAtTeardown(
    new CodexCliSessionProvider(join(l.root, "state"), {
      claudeCommand: fakeCodexCli(l.root),
      codexHome: l.codexHome,
    }),
  );
}

function start(
  provider: CodexCliSessionProvider,
  l: Lap,
  settings: Readonly<Record<string, unknown>> = {},
): Promise<ProviderResult<unknown>> {
  return provider.start(
    cliRequest(l.root, SESSION, { prompt: "do the lap", cli_args: l.cliArgs, ...settings }),
  );
}

function refusalOf(result: ProviderResult<unknown>): Failure {
  expect(result, `expected Failure, got ${String(result)}`).toBeInstanceOf(Failure);
  return result as Failure;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `readTerminalReport` once the turn is no longer pending: the report, or the refusal. */
async function finished(provider: CodexCliSessionProvider): Promise<TerminalReport | Failure> {
  const deadline = performance.now() + POLL_DEADLINE_MS;
  for (;;) {
    const result = await provider.readTerminalReport(SESSION);
    if (result instanceof Failure) {
      return result;
    }
    const readout = (result as Ok<TerminalReport | { kind: "no-report"; pending: boolean }>).value;
    if (readout.kind === "report") {
      return readout;
    }
    if (!readout.pending || performance.now() > deadline) {
      throw new Error(`no report: ${JSON.stringify(readout)}`);
    }
    await pause(POLL_INTERVAL_MS);
  }
}

async function reportOf(provider: CodexCliSessionProvider): Promise<TerminalReport> {
  const outcome = await finished(provider);
  expect(outcome, outcome instanceof Failure ? outcome.detail : "").not.toBeInstanceOf(Failure);
  return outcome as TerminalReport;
}

async function refusedTurn(provider: CodexCliSessionProvider, kind: FailureKind): Promise<string> {
  const outcome = await finished(provider);
  expect(outcome).toBeInstanceOf(Failure);
  expect((outcome as Failure).kind).toBe(kind);
  return (outcome as Failure).detail;
}

/** A code-mode tool call whose shell command the fake puts through the real hook. */
function bash(command: string, output = ""): Record<string, unknown> {
  return {
    name: "exec",
    input: `text(await tools.exec_command({cmd: ${JSON.stringify(command)}}))`,
    hook: { tool_name: "Bash", tool_input: { command } },
    output,
  };
}

const SPAWN_AGENT = {
  kind: "function",
  namespace: "collaboration",
  name: "spawn_agent",
  input: "{}",
  hook: { tool_name: "collaborationspawn_agent", tool_input: {} },
};

// --------------------------------------------------------------------------
// Construction and the probe
// --------------------------------------------------------------------------

test("base_cli_args admits a model pin and nothing else", () => {
  const l = lap();
  const make = (baseCliArgs: readonly string[]) =>
    new CodexCliSessionProvider(join(l.root, "state"), { codexHome: l.codexHome, baseCliArgs });
  expect(make(["--model", "gpt-6-astra"])).toBeInstanceOf(CodexCliSessionProvider);
  expect(make([])).toBeInstanceOf(CodexCliSessionProvider);
  expectRefusal(() => make(["--sandbox", "danger-full-access"]), PyValueError, "--sandbox");
  expectRefusal(() => make(["--model", "--yolo"]), PyValueError, "--model");
  expectRefusal(() => make(["-c", "approval_policy=on-request"]), PyValueError, "-c");
});

test("the operator's Codex home must be absolute", () => {
  const l = lap();
  expect(
    () => new CodexCliSessionProvider(join(l.root, "state"), { codexHome: "relative/home" }),
  ).toThrow(TypeError);
});

test("the probe reads exec --help and proves codex sandbox runs", () => {
  const l = lap();
  const log = join(l.root, "sandbox.jsonl");
  fakeEnv("FAKE_CODEX_SANDBOX_LOG", log);
  const report = providerFor(l).probeCapabilities();
  expect(report).toBeInstanceOf(Ok);
  const value = (report as Ok<{ providerVersion: string; supported: ReadonlySet<string> }>).value;
  expect(value.providerVersion).toBe("codex-cli 9.9.9-fake");
  expect(value.supported.has("session.start")).toBe(true);
  expect(value.supported.has("session.resume")).toBe(true);
  const [probe] = spawned(log);
  expect(probe?.argv.slice(0, 3)).toEqual([
    "sandbox",
    "-C",
    join(l.root, "state", "codex-probe+home"),
  ]);
  expect(probe?.argv.slice(-2)).toEqual(["--", "true"]);
});

test("a codex whose sandbox cannot come up refuses at the probe, before any worktree", () => {
  const l = lap();
  fakeEnv("FAKE_CODEX_SANDBOX", "broken");
  const refusal = providerFor(l).probeCapabilities();
  expect(refusalOf(refusal).kind).toBe(FailureKind.INCOMPATIBLE_PROVIDER);
  expect(refusalOf(refusal).detail).toContain("cannot run 'true'");
  expectRefusal(() => start(providerFor(l), l), SpawnRefused);
});

test("a help text missing a required flag is a missing capability", () => {
  const l = lap();
  fakeEnv("FAKE_HELP_OMIT", "--strict-config");
  const report = providerFor(l).probeCapabilities();
  const value = (report as Ok<{ supported: ReadonlySet<string>; detail: string }>).value;
  expect(value.supported.has("session.start")).toBe(false);
  expect(value.detail).toContain("--strict-config");
});

// --------------------------------------------------------------------------
// Start: argv, stdin, the per-session home
// --------------------------------------------------------------------------

/**
 * Point the lap's fence at a base `.git` whose branch ref is `branch`, the
 * way `gitMetadataRoots` names it (`/`-separated, the ref a FILE), and
 * return the paths involved.
 */
function withBranchRef(l: ReturnType<typeof lap>, branch: string) {
  const gitDir = join(l.root, "base", ".git");
  const ref = `${gitDir}/refs/heads/${branch}`;
  mkdirSync(dirname(ref), { recursive: true });
  writeFileSync(ref, "0".repeat(40), "utf8");
  const settings = JSON.parse(readFileSync(l.settingsPath, "utf8")) as {
    sandbox: { filesystem: Record<string, unknown> };
  };
  settings.sandbox.filesystem["additionalDirectories"] = [gitDir, ref];
  writeFileSync(l.settingsPath, JSON.stringify(settings), "utf8");
  return { gitDir, ref };
}

async function profileOf(l: ReturnType<typeof lap>): Promise<string> {
  const log = spawnLog(l.root);
  expect(await start(providerFor(l), l)).toBeInstanceOf(Ok);
  const [entry] = await waitForSpawns(log, 1);
  return (entry?.argv ?? []).find((part) => part.startsWith("permissions=")) ?? "";
}

test("a write root that is a file is left out of the profile, a directory kept", async () => {
  // gitMetadataRoots names the branch ref and packed-refs, both files; Codex
  // mounts `.git` under every writable root, so a file root made the real
  // helper panic (exit 101) on the first real lap.
  const l = lap();
  const { gitDir, ref } = withBranchRef(l, "lap/branch");
  const permissions = await profileOf(l);
  expect(permissions).toContain(`${JSON.stringify(gitDir)} = "write"`);
  expect(permissions).not.toContain(JSON.stringify(ref));
});

test("the branch's ref and log directories are writable and every sibling in them is pinned read-only (D-1114 rule 8)", async () => {
  const l = lap();
  const { gitDir } = withBranchRef(l, "lap/branch");
  const heads = `${gitDir}/refs/heads`;
  const logs = `${gitDir}/logs/refs/heads`;
  writeFileSync(`${heads}/lap/other`, "1".repeat(40), "utf8");
  writeFileSync(`${heads}/main`, "2".repeat(40), "utf8");
  mkdirSync(`${logs}/lap`, { recursive: true });
  writeFileSync(`${logs}/lap/branch`, "", "utf8");
  writeFileSync(`${logs}/lap/other`, "", "utf8");
  const permissions = await profileOf(l);
  // What a commit needs: `<ref>.lock` beside the ref, the reflog beside its log.
  expect(permissions).toContain(`${JSON.stringify(`${heads}/lap`)} = "write"`);
  expect(permissions).toContain(`${JSON.stringify(`${logs}/lap`)} = "write"`);
  // A sibling branch stays as it is, in both places.
  expect(permissions).toContain(`${JSON.stringify(`${heads}/lap/other`)} = "read"`);
  expect(permissions).toContain(`${JSON.stringify(`${logs}/lap/other`)} = "read"`);
  // The branch's own ref and log are not pinned, and nothing above the
  // namespace -- the base branch included -- is granted.
  expect(permissions).not.toContain(JSON.stringify(`${heads}/lap/branch`));
  expect(permissions).not.toContain(JSON.stringify(`${logs}/lap/branch`));
  expect(permissions).not.toContain(`${JSON.stringify(heads)} = "write"`);
  expect(permissions).not.toContain(JSON.stringify(`${heads}/main`));
});

test("a top-level topic branch refuses a Codex lap before it spawns; a namespaced one does not", async () => {
  const l = lap();
  withBranchRef(l, "topic");
  const log = spawnLog(l.root);
  const refusal = refusalOf(await start(providerFor(l), l));
  expect(refusal.kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
  expect(refusal.detail).toContain("top-level name");
  expect(spawned(log)).toEqual([]);
  const namespaced = lap();
  withBranchRef(namespaced, "lap/topic");
  expect(await profileOf(namespaced)).toContain('"write"');
});

test("start runs codex exec with the fence as -c overrides and the prompt on stdin", async () => {
  const l = lap();
  const log = spawnLog(l.root);
  fakeEnv("FAKE_RESULT_TEXT", "done");
  const provider = providerFor(l);
  expect(await start(provider, l)).toBeInstanceOf(Ok);
  const [entry] = await waitForSpawns(log, 1);
  const argv = entry?.argv ?? [];
  const workspace = join(l.root, "workspaces", SESSION);
  const home = join(l.root, "state", "codex-homes+", SESSION);
  expect(argv.slice(0, 9)).toEqual([
    "exec",
    "--json",
    "--ignore-user-config",
    "--strict-config",
    "--ignore-rules",
    "--dangerously-bypass-hook-trust",
    "--skip-git-repo-check",
    "-C",
    workspace,
  ]);
  expect(argv.at(-1)).toBe("-");
  expect(argv).toContain('approval_policy="never"');
  expect(argv).toContain('default_permissions="fence"');
  expect(argv).toContain('web_search="disabled"');
  const permissions = argv.find((part) => part.startsWith("permissions=")) ?? "";
  expect(permissions).toContain(`${JSON.stringify(workspace)} = "write"`);
  // The parent of every session's home, not only this one's: a finished
  // session's home keeps its copy of auth.json, and a sibling lap's child must
  // not read it.
  expect(permissions).toContain(`${JSON.stringify(dirname(home))} = "deny"`);
  expect(permissions).toContain(`${JSON.stringify(l.codexHome)} = "deny"`);
  expect(permissions).toContain(`${JSON.stringify(`${workspace}/**/.env`)} = "deny"`);
  expect(argv.find((part) => part.startsWith("mcp_servers="))).toContain(MCP_SERVER);
  const entryWithPrompt = entry as unknown as { prompt: string; codexHome: string };
  expect(entryWithPrompt.prompt).toBe("do the lap");
  expect(entryWithPrompt.codexHome).toBe(home);
  // The command line carries continuo's own UUID, which orphan liveness reads.
  expect(argv[argv.indexOf("-o") + 1]).toContain(claudeSessionUuid(SESSION));

  const hooks = readFileSync(join(home, "hooks.json"), "utf8");
  expect(hooks).toContain("codex_hook.mjs");
  expect(hooks).toContain(`--mcp-server ${MCP_SERVER}`);
  expect(hooks).toContain(join(l.root, "state", SESSION, "hook-000.jsonl"));
  expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"token":"operator"}');
  if (process.platform !== "win32") {
    expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
  }
  const report = await reportOf(provider);
  expect(report.report).toBe("done");
  // No tool call, so nothing was denied: `[]`, as Claude says it, not `null`.
  expect(report.permissionDenials).toEqual([]);
});

// --------------------------------------------------------------------------
// The turn's facts
// --------------------------------------------------------------------------

test("the report carries the rollout's commands, the hook's denials and the token spend", async () => {
  const l = lap();
  fakeEnv("FAKE_RESULT_TEXT", "pushed nothing");
  fakeEnv(
    "FAKE_TRANSCRIPT_EVENTS",
    JSON.stringify([bash("git status", "clean"), bash("git push origin main")]),
  );
  const provider = providerFor(l);
  await start(provider, l);
  const report = await reportOf(provider);
  expect(report.report).toBe("pushed nothing");
  expect(report.terminalReason).toBe("turn.completed");
  expect(report.isError).toBe(false);
  expect(report.commands.map((c) => c.output)).toEqual([
    "clean",
    "Command blocked by PreToolUse hook",
  ]);
  expect(report.commands[0]?.command).toContain("exec text(await tools.exec_command");
  // Decided by the shipped hook: `git status` is a role allow entry, `git push`
  // is not and is a deny rule besides.
  expect(report.permissionDenials).toEqual([
    { toolName: "Bash", toolInput: { command: "git push origin main" } },
  ]);
  expect(report.spend).toEqual({
    totalCostUsd: null,
    numTurns: null,
    durationMs: 1234,
    model: "fake-model",
    inputTokens: 100,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 0,
    outputTokens: 7,
    reasoningOutputTokens: 3,
  });
});

test("a turn.failed is a report marked as an error", async () => {
  const l = lap();
  fakeEnv("FAKE_RESULT_TEXT", "could not finish");
  fakeEnv("FAKE_IS_ERROR", "1");
  const provider = providerFor(l);
  await start(provider, l);
  const report = await reportOf(provider);
  expect(report.isError).toBe(true);
  expect(report.terminalReason).toBe("turn.failed");
  expect(report.spend.inputTokens).toBeNull();
});

test("a tool call with no hook log refuses the turn; the same call through the hook does not", async () => {
  const l = lap();
  fakeEnv("FAKE_RESULT_TEXT", "done");
  fakeEnv("FAKE_TRANSCRIPT_EVENTS", JSON.stringify([{ ...bash("git status"), hook: undefined }]));
  const provider = providerFor(l);
  await start(provider, l);
  expect(await refusedTurn(provider, FailureKind.UNINTERPRETABLE_RESPONSE)).toContain(
    "hook log is empty",
  );

  const through = lap();
  fakeEnv("FAKE_TRANSCRIPT_EVENTS", JSON.stringify([bash("git status")]));
  const accepted = providerFor(through);
  await start(accepted, through);
  expect((await reportOf(accepted)).permissionDenials).toEqual([]);
});

test("a sub-agent call the hook denied is reported; one it never saw refuses the turn", async () => {
  const l = lap();
  fakeEnv("FAKE_RESULT_TEXT", "done");
  fakeEnv("FAKE_TRANSCRIPT_EVENTS", JSON.stringify([SPAWN_AGENT]));
  const provider = providerFor(l);
  await start(provider, l);
  expect((await reportOf(provider)).permissionDenials).toEqual([
    { toolName: "collaborationspawn_agent", toolInput: {} },
  ]);

  const unseen = lap();
  fakeEnv(
    "FAKE_TRANSCRIPT_EVENTS",
    JSON.stringify([bash("git status"), { ...SPAWN_AGENT, hook: undefined }]),
  );
  const refused = providerFor(unseen);
  await start(refused, unseen);
  expect(await refusedTurn(refused, FailureKind.UNINTERPRETABLE_RESPONSE)).toContain(
    "collaborationspawn_agent",
  );
});

test("a turn_context that is not the rendered fence refuses the turn", async () => {
  for (const policy of [
    { approval_policy: "on-request" },
    { sandbox_policy: { type: "workspace-write", network_access: true } },
    { active_permission_profile: { id: ":workspace" } },
  ]) {
    const l = lap();
    fakeEnv("FAKE_RESULT_TEXT", "done");
    fakeEnv("FAKE_CODEX_POLICY", JSON.stringify(policy));
    const provider = providerFor(l);
    await start(provider, l);
    expect(await refusedTurn(provider, FailureKind.UNINTERPRETABLE_RESPONSE)).toContain(
      "turn_context",
    );
  }
});

test("a turn with no rollout cannot be verified and is refused", async () => {
  const l = lap();
  fakeEnv("FAKE_RESULT_TEXT", "done");
  fakeEnv("FAKE_CODEX_NO_ROLLOUT", "1");
  const provider = providerFor(l);
  await start(provider, l);
  expect(await refusedTurn(provider, FailureKind.UNINTERPRETABLE_RESPONSE)).toContain(
    "no single rollout",
  );
});

// --------------------------------------------------------------------------
// Identity
// --------------------------------------------------------------------------

test("the first reported thread is adopted, and a second one is an incident", async () => {
  const l = lap();
  fakeEnv("FAKE_RESULT_TEXT", "done");
  fakeEnv("FAKE_CODEX_THREAD_ID", "thread-a");
  fakeEnv("FAKE_CODEX_SECOND_THREAD", "thread-b");
  const provider = providerFor(l);
  await start(provider, l);
  const detail = await refusedTurn(provider, FailureKind.IDENTITY_INCIDENT);
  expect(detail).toContain("'thread-a'");
  expect(detail).toContain("'thread-b'");
});

test("a rollout whose session_meta names another thread is an identity incident", async () => {
  const l = lap();
  fakeEnv("FAKE_RESULT_TEXT", "done");
  fakeEnv("FAKE_CODEX_META_ID", "someone-else");
  const provider = providerFor(l);
  await start(provider, l);
  expect(await refusedTurn(provider, FailureKind.IDENTITY_INCIDENT)).toContain("someone-else");
});

test("resume re-enters the adopted thread with the resume prompt on stdin", async () => {
  const l = lap();
  const log = spawnLog(l.root);
  fakeEnv("FAKE_RESULT_TEXT", "first");
  fakeEnv("FAKE_CODEX_THREAD_ID", "thread-a");
  const provider = providerFor(l);
  await start(provider, l, { resume_prompt: "carry on" });
  await reportOf(provider);
  await waitForExit(provider, SESSION);
  // Codex scribbles trust into it; the provider takes it away before each spawn.
  const home = join(l.root, "state", "codex-homes+", SESSION);
  writeFileSync(join(home, "config.toml"), 'approval_policy = "on-request"\n', "utf8");
  fakeEnv("FAKE_RESULT_TEXT", "second");
  expect(await provider.resume(SESSION)).toBeInstanceOf(Ok);
  const entries = await waitForSpawns(log, 2);
  const resumed = entries[1] as unknown as { argv: string[]; prompt: string };
  expect(resumed.argv.slice(0, 2)).toEqual(["exec", "resume"]);
  expect(resumed.argv.slice(-2)).toEqual(["thread-a", "-"]);
  expect(resumed.argv).not.toContain("-C");
  expect(resumed.prompt).toBe("carry on");
  expect(existsSync(join(home, "config.toml"))).toBe(false);
  const report = await reportOf(provider);
  expect(report.generation).toBe(1);
  expect(report.report).toBe("second");
});

test("a resumed child naming another thread is an incident", async () => {
  const l = lap();
  fakeEnv("FAKE_RESULT_TEXT", "first");
  fakeEnv("FAKE_CODEX_THREAD_ID", "thread-a");
  const provider = providerFor(l);
  await start(provider, l);
  await reportOf(provider);
  await waitForExit(provider, SESSION);
  fakeEnv("FAKE_CODEX_RESUME_THREAD", "thread-z");
  await provider.resume(SESSION);
  expect(await refusedTurn(provider, FailureKind.IDENTITY_INCIDENT)).toContain("thread-z");
});

test("a session whose first transcript names no thread cannot be resumed", async () => {
  const l = lap();
  fakeMode("silent");
  const provider = providerFor(l);
  await start(provider, l);
  await provider.stop(SESSION);
  const refusal = refusalOf(await provider.resume(SESSION));
  expect(refusal.kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
  expect(refusal.detail).toContain("no Codex thread to resume");
});

// --------------------------------------------------------------------------
// Refusals before the spawn
// --------------------------------------------------------------------------

test("anything but the materializer's fence vector is refused before anything exists", async () => {
  const l = lap();
  const log = spawnLog(l.root);
  const provider = providerFor(l);
  for (const cliArgs of [[], [...l.cliArgs, "--model", "x"], l.cliArgs.slice(0, -1)]) {
    const refusal = refusalOf(await start(provider, l, { cli_args: cliArgs }));
    expect(refusal.kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
    expect(refusal.detail).toContain("fence vector");
  }
  expect(existsSync(join(l.root, "workspaces", SESSION))).toBe(false);
  expect(spawned(log)).toEqual([]);
});

test("a settings key or deny rule the translation does not know is refused", async () => {
  const cases: [(settings: Record<string, unknown>) => void, string][] = [
    [(s) => Object.assign(s, { apiKeyHelper: "x" }), "a key the Codex translation"],
    [
      (s) => (s["permissions"] as { deny: string[] }).deny.push("Read(src/secret.txt)"),
      "no Codex permission-profile spelling",
    ],
    [
      (s) => {
        const group = (s["hooks"] as { PreToolUse: { hooks: { command: string }[] }[] })
          .PreToolUse[0];
        if (group?.hooks[0] !== undefined) {
          group.hooks[0].command += " --extra";
        }
      },
      "exactly the one deny hook",
    ],
  ];
  for (const [mutate, reason] of cases) {
    const l = lap();
    const settings = JSON.parse(readFileSync(l.settingsPath, "utf8")) as Record<string, unknown>;
    mutate(settings);
    writeFileSync(l.settingsPath, JSON.stringify(settings), "utf8");
    const refusal = refusalOf(await start(providerFor(l), l));
    expect(refusal.kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
    expect(refusal.detail).toContain(reason);
  }
});

test("a hook with no codex_hook.mjs beside it is refused", async () => {
  const root = caseRoot("codexprov");
  const l = lap({ hookScript: hookScriptForTest(join(root, "lonely")) });
  expect(refusalOf(await start(providerFor(l), l)).detail).toContain("codex_hook.mjs is missing");
});

test("an interpreter in allowed_bash is refused; an ordinary program is not", async () => {
  for (const entry of ["python3 build.py", "bash -c make", "/usr/bin/node x.js"]) {
    const l = lap({ allowedBash: [entry] });
    expect(refusalOf(await start(providerFor(l), l)).detail).toContain("executes its stdin");
  }
  const l = lap({ allowedBash: ["npm test"] });
  fakeEnv("FAKE_RESULT_TEXT", "done");
  const provider = providerFor(l);
  expect(await start(provider, l)).toBeInstanceOf(Ok);
  await reportOf(provider);
});

test("a sandbox that lets a write or a read through refuses the spawn and copies no credentials", async () => {
  for (const mode of ["leaky-write", "leaky-read"]) {
    const l = lap();
    const log = spawnLog(l.root);
    fakeEnv("FAKE_CODEX_SANDBOX", mode);
    const refusal = refusalOf(await start(providerFor(l), l));
    expect(refusal.kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
    expect(refusal.detail).toContain(mode === "leaky-write" ? "write outside" : "read denials");
    expect(spawned(log)).toEqual([]);
    expect(existsSync(join(l.root, "state", "codex-homes+", SESSION, "auth.json"))).toBe(false);
    expect(existsSync(join(l.root, "state", SESSION, "sandbox-probe"))).toBe(false);
  }
});
