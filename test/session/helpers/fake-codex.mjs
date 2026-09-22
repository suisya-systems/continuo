/**
 * The fake `codex` executable `codex-cli-provider.test.ts` runs the Codex
 * provider against (continuo D-1114). `fake-claude.mjs`'s counterpart: every
 * scenario is an environment switch, so the provider under test is the same
 * object in every case and only the backend's behaviour changes.
 *
 * It renders only what the provider reads, in the shapes measured on
 * `codex-cli 0.153.4` (`.worker-scratch` measurements, summarised in the
 * provider's header): `--version`; `exec --help`; `sandbox ... -- <cmd>`; and
 * `exec` / `exec resume <thread>` with the prompt on stdin, writing `--json`
 * events to stdout and a rollout under `$CODEX_HOME/sessions/`.
 *
 * **Scripted tool calls run the real hook.** For each call in
 * `FAKE_TRANSCRIPT_EVENTS` that names a `hook` payload, the command in
 * `$CODEX_HOME/hooks.json` -- the one the provider rendered -- is executed
 * with that payload on stdin, as Codex does, so the hook log the provider
 * reads is the real `codex_hook.mjs`'s and not a stand-in. The command is
 * split here rather than handed to `sh -c`, so the Windows cell needs no
 * shell: it is a line of words `shlex.quote` produced, and those are bare or
 * single-quoted.
 *
 * `.mjs` under `test/` for the reasons `fake-claude.mjs` gives.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

const FAKE_VERSION = "codex-cli 9.9.9-fake";

const HELP_LINES = [
  "  resume  Resume a previous session by id or pick the most recent with --last",
  "      --json                      Print events to stdout as JSONL",
  "      --ignore-user-config        Do not load `$CODEX_HOME/config.toml`",
  "      --strict-config             Error out on unknown config fields",
  "      --ignore-rules              Do not load execpolicy `.rules` files",
  "      --dangerously-bypass-hook-trust  Run enabled hooks without persisted trust",
  "      --skip-git-repo-check       Allow running outside a Git repository",
  "  -o, --output-last-message <FILE>  Where the last agent message is written",
];

const args = process.argv.slice(2);
const env = process.env;

/**
 * One line to stdout, written synchronously and whole: stdout is the events
 * file, which the provider reads while this is still running (and on Windows
 * a file-backed `process.stdout.write` is asynchronous). See `fake-claude.mjs`.
 */
function out(text) {
  const bytes = Buffer.from(`${text}\n`, "utf8");
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(1, bytes, written, bytes.length - written);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function argAfter(flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/** The words of a command `shlex.quote` built: bare, or `'...'` / `"..."` runs. */
function shellWords(command) {
  const words = [];
  let word = null;
  let at = 0;
  while (at < command.length) {
    const c = command[at];
    if (c === " ") {
      if (word !== null) {
        words.push(word);
        word = null;
      }
      at += 1;
    } else if (c === "'" || c === '"') {
      const end = command.indexOf(c, at + 1);
      word = (word ?? "") + command.slice(at + 1, end);
      at = end + 1;
    } else {
      word = (word ?? "") + c;
      at += 1;
    }
  }
  if (word !== null) {
    words.push(word);
  }
  return words;
}

/** `codex sandbox ... -- <cmd>`: the sandbox's answer, per `FAKE_CODEX_SANDBOX`. */
function sandbox() {
  if (env.FAKE_CODEX_SANDBOX_LOG) {
    appendFileSync(env.FAKE_CODEX_SANDBOX_LOG, `${JSON.stringify({ argv: args })}\n`);
  }
  const command = args.slice(args.indexOf("--") + 1);
  const mode = env.FAKE_CODEX_SANDBOX ?? "ok";
  if (mode === "broken") {
    process.stderr.write("bwrap: Can't mkdir /tmp/.git: Read-only file system\n");
    return 1;
  }
  if (command[0] === "true") {
    return 0;
  }
  if (command[0] === "touch") {
    if (mode === "leaky-write") {
      writeFileSync(command[1], "");
      return 0;
    }
    process.stderr.write(`touch: cannot touch '${command[1]}': Read-only file system\n`);
    return 1;
  }
  if (command[0] === "cat") {
    if (mode === "leaky-read") {
      return 0;
    }
    process.stderr.write(`cat: ${command[1]}: Permission denied\n`);
    return 1;
  }
  return 127;
}

/** The rollout for `thread`, found if it exists (a resume appends to it). */
function rolloutPath(home, thread) {
  const directory = join(home, "sessions", "2026", "09", "22");
  mkdirSync(directory, { recursive: true });
  const existing = readdirSync(directory).find((name) => name.endsWith(`-${thread}.jsonl`));
  return join(directory, existing ?? `rollout-2026-09-22T00-00-00-${thread}.jsonl`);
}

/** Run `hooks.json`'s command on `payload`; `true` when the hook blocked the call. */
function runHook(home, payload) {
  const hooks = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
  const words = shellWords(hooks.hooks.PreToolUse[0].hooks[0].command);
  const result = spawnSync(words[0], words.slice(1), {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return result.status !== 0 || result.stdout.includes('"deny"');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  if (args[0] === "--version") {
    out(FAKE_VERSION);
    return 0;
  }
  if (args[0] === "exec" && args[1] === "--help") {
    const omitted = (env.FAKE_HELP_OMIT ?? "").split(/\s+/).filter((token) => token !== "");
    out("Usage: codex exec [OPTIONS] [PROMPT]");
    for (const line of HELP_LINES) {
      if (!omitted.some((flag) => line.includes(flag))) {
        out(line);
      }
    }
    return 0;
  }
  if (args[0] === "sandbox") {
    return sandbox();
  }

  const prompt = await readStdin();
  const home = env.CODEX_HOME ?? "";
  if (env.FAKE_SPAWN_LOG) {
    appendFileSync(
      env.FAKE_SPAWN_LOG,
      `${JSON.stringify({ argv: args, cwd: process.cwd(), prompt, codexHome: home })}\n`,
    );
  }
  const mode = env.FAKE_MODE ?? "ok";
  const sleepForMs = Number(env.FAKE_SLEEP ?? "60") * 1000;
  if (mode === "silent") {
    await sleep(sleepForMs);
    return 0;
  }

  const resuming = args[1] === "resume";
  const thread = resuming
    ? (env.FAKE_CODEX_RESUME_THREAD ?? args[args.length - 2])
    : (env.FAKE_CODEX_THREAD_ID ?? randomUUID());
  out(JSON.stringify({ type: "thread.started", thread_id: thread }));
  if (env.FAKE_CODEX_SECOND_THREAD) {
    out(JSON.stringify({ type: "thread.started", thread_id: env.FAKE_CODEX_SECOND_THREAD }));
  }
  out(JSON.stringify({ type: "turn.started" }));
  if (mode === "events-then-hang") {
    await sleep(sleepForMs);
    return 0;
  }

  const rollout = rolloutPath(home, thread);
  const write = (type, payload) => {
    if (env.FAKE_CODEX_NO_ROLLOUT !== "1") {
      appendFileSync(rollout, `${JSON.stringify({ timestamp: "t", type, payload })}\n`);
    }
  };
  const turnId = randomUUID();
  if (!existsSync(rollout)) {
    write("session_meta", { id: env.FAKE_CODEX_META_ID ?? thread, cli_version: "9.9.9-fake" });
  }
  write("event_msg", { type: "task_started", turn_id: turnId });
  write("turn_context", {
    turn_id: turnId,
    model: "fake-model",
    approval_policy: "never",
    sandbox_policy: { type: "workspace-write", network_access: false },
    active_permission_profile: { id: "fence" },
    ...JSON.parse(env.FAKE_CODEX_POLICY ?? "{}"),
  });

  for (const [index, call] of JSON.parse(env.FAKE_TRANSCRIPT_EVENTS ?? "[]").entries()) {
    const callId = `call_${index}`;
    const functionCall = call.kind === "function";
    write("response_item", {
      type: functionCall ? "function_call" : "custom_tool_call",
      name: call.name,
      ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
      [functionCall ? "arguments" : "input"]: call.input,
      call_id: callId,
    });
    const blocked =
      call.hook !== undefined &&
      runHook(home, {
        session_id: thread,
        turn_id: turnId,
        transcript_path: rollout,
        cwd: process.cwd(),
        hook_event_name: "PreToolUse",
        permission_mode: "bypassPermissions",
        tool_use_id: callId,
        ...call.hook,
      });
    const text = blocked ? "Command blocked by PreToolUse hook" : (call.output ?? "");
    write("response_item", {
      type: functionCall ? "function_call_output" : "custom_tool_call_output",
      call_id: callId,
      output: functionCall ? text : [{ type: "input_text", text }],
    });
  }

  if (env.FAKE_RESULT_TEXT !== undefined) {
    out(
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: env.FAKE_RESULT_TEXT },
      }),
    );
    const last = argAfter("-o");
    if (last !== undefined) {
      writeFileSync(last, env.FAKE_RESULT_TEXT);
    }
  }
  write("event_msg", { type: "task_complete", turn_id: turnId, duration_ms: 1234 });
  if (env.FAKE_IS_ERROR === "1") {
    out(JSON.stringify({ type: "turn.failed", error: { message: "fake failure" } }));
  } else {
    const usage = JSON.parse(
      env.FAKE_CODEX_USAGE ??
        '{"input_tokens":100,"cached_input_tokens":80,"cache_write_input_tokens":0,' +
          '"output_tokens":7,"reasoning_output_tokens":3}',
    );
    out(JSON.stringify({ type: "turn.completed", usage }));
  }
  return Number(env.FAKE_EXIT ?? "0");
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    process.stderr.write(`fake-codex: ${String(error)}\n`);
    process.exit(1);
  });
