/**
 * The `PreToolUse` hook a Codex CLI lap worker runs under (D-1114).
 *
 * `hook.mjs` is the deny hook: every call is allowed unless a fence rule denies
 * it, because Claude's own permission mode already refuses what the settings
 * do not allow. Codex has no such mode. Under `approval_policy = "never"` every
 * tool the model is shown simply runs, so for a Codex worker this file is the
 * allowlist as well as the deny list, and it is **default deny**:
 *
 * - `Bash`: a single command with no shell composition, admitted by a
 *   `Bash(<spec>)` entry of the fence's `settings.permissions.allow` (the
 *   role's git entries plus the run's `allowed_bash`, D-1110) under Claude's
 *   own matcher, or by a fixed read-only first word. Then `hook.mjs`'s rules.
 * - `apply_patch`: every path the patch names, checked as a `Write` so the
 *   fence's `Edit(...)` rules apply (D-0089). A patch naming no path is denied.
 * - `mcp__<--mcp-server>__*`: the endpoint's own server, then `hook.mjs`'s
 *   rules. Codex spells a `-` in a server name as `_` in its tool names
 *   (measured on the first real lap: `continuo-messagebus` reaches this hook
 *   as `mcp__continuo_messagebus__poll`), so that is the prefix admitted, and
 *   the rules see the Claude spelling the fence's own rules are written in.
 *   No other server; `mcp__codex_apps__*` is the operator's ChatGPT
 *   connectors, not the lap's.
 * - Anything else -- `webrun`, `view_image`, `collaboration*` (sub-agents,
 *   which Codex cannot switch off), `clock*`, `image_gen*`, goals, plugin
 *   installs, MCP resources -- is denied by name, because it was never named.
 *
 * `hook.mjs` is imported, not edited: its argv and help text are a port of
 * interlock's and stay byte-identical. Importing it does not run it
 * (`invokedAsScript` compares `argv[1]` with its own path).
 *
 * ## Fail closed, harder than `hook.mjs` has to
 *
 * Codex runs the call when its hook exits 1, crashes, is missing, or times out
 * (D-1114 M4). So every path here ends in exactly one of two
 * ways: exit 0 with nothing on stdout (allow), or the JSON deny on stdout, the
 * reason on stderr and exit 2 (both forms were measured to block). The only
 * static imports are Node built-ins; `hook.mjs` and `rules.js` arrive by
 * `import()` inside `try`, from the same two fixed directories `hook.mjs` uses
 * and for the same reason (an environment variable naming them would let the
 * fenced child pick its own hook). `uncaughtException` and
 * `unhandledRejection` deny. A watchdog denies before Codex's own hook timeout
 * would let the call through. And the log line is written before the verdict:
 * the log is the lap's `permission_denials` and its evidence that the hook ran
 * at all, so a call whose line cannot be written is denied.
 *
 * ## What the allowlist does not bound
 *
 * `write_stdin` does not fire this hook (D-1114 M5). Nothing the read-only
 * set or the role's git entries run executes its stdin, and the provider
 * refuses interpreter programs in `allowed_bash`; what remains is the OS
 * sandbox's to hold, as it is for Claude.
 */

import { Buffer } from "node:buffer";
import { appendFileSync, writeSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";

const EXIT_ALLOW = 0;
const EXIT_DENY = 2;

/**
 * Below the `"timeout": 30` the provider renders into `hooks.json`: a hook
 * Codex times out is a hook whose call runs.
 */
const WATCHDOG_MILLISECONDS = 20_000;

/** Same pair, same order, and the same reason as `hook.mjs`'s list. */
const DEPENDENCY_DIRECTORIES = Object.freeze([
  new URL("./", import.meta.url),
  new URL("../../dist/fencing/", import.meta.url),
]);

/**
 * First words admitted without an allow entry. Claude reads files with its
 * built-in Read / Grep / LS tools, which its fence never gates through Bash;
 * Codex has no such tools, so without these a Codex worker could not read the
 * tree at all. Each one only reads. `find` (`-exec`, `-delete`), `rg` (`--pre`)
 * and `sed` (`e`, `w`) are left out because they do not.
 */
const READ_ONLY_PROGRAMS = new Set(["cat", "head", "tail", "ls", "wc", "grep", "pwd"]);

/**
 * Refused anywhere in a `Bash` command, quoted or not: `;` `&` `|` `<` `>`
 * backtick `$` newline CR backslash. An allow entry names ONE command, and
 * checking a quoted string for composition is a shell parser this file will
 * not carry; the model is told to issue single commands.
 */
const SHELL_COMPOSITION = /[;&|<>`$\n\r\\]/;

/**
 * The program a shell runs for `command`: its first word as `bash -c` splits
 * it, on space and tab only. Not `\s` and not `trim()`: JavaScript's white
 * space includes NBSP, form feed and vertical tab, which the shell does not
 * split on, so `cat<NBSP>/../node_modules/.bin/x` would read as `cat` here and
 * run `x` there.
 *
 * @param {string} command
 * @returns {string}
 */
function programOf(command) {
  return command.replace(/^[ \t]+/, "").split(/[ \t]/)[0];
}

/**
 * `specMatches` under one more condition: the command runs the program the
 * spec names. `specMatches` is the deny side's matcher, where matching too much
 * only refuses more; as an allowlist its bare prefix admits `npm:*` for
 * `npm/../evil`, and its path normalisation admits `npm test` for
 * `./npm test`, each a different program. An allow entry whose own first word
 * is a glob (`Bash(*)`) therefore admits nothing here.
 *
 * @param {Function} specMatches
 * @param {string} spec
 * @param {string} command
 * @returns {boolean}
 */
function admits(specMatches, spec, command) {
  const named = spec.endsWith(":*") ? spec.slice(0, -2) : spec;
  return programOf(command) === programOf(named) && specMatches(spec, command);
}

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;
const PATCH_FRAME = new Set(["*** Begin Patch", "*** End Patch", "*** End of File"]);

/** @type {string | null} */
let logPath = null;
/** @type {Record<string, unknown>} */
let event = {};
let decided = false;

/**
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @returns {unknown}
 */
function own(object, key) {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/**
 * The one log line for this call. Throws when it cannot be written.
 *
 * @param {boolean} denied
 * @param {string | null} reason
 */
function logCall(denied, reason) {
  if (logPath === null) {
    throw new Error("no --log path");
  }
  const toolName = own(event, "tool_name");
  const line = JSON.stringify({
    tool_name: typeof toolName === "string" ? toolName : null,
    tool_input: own(event, "tool_input") ?? null,
    denied,
    reason,
    turn_id: own(event, "turn_id") ?? null,
  });
  appendFileSync(logPath, `${line}\n`);
}

/**
 * Deny and end the process. Synchronous writes then `process.exit`, so neither
 * a pending stdin read nor a later event turn can outlive the verdict.
 *
 * @param {string} reason
 * @returns {never}
 */
function deny(reason) {
  if (!decided) {
    decided = true;
    let text = reason;
    try {
      logCall(true, reason);
    } catch (error) {
      text = `${reason}; and the hook log could not be written: ${describe(error)}`;
    }
    const payload = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: text,
      },
    };
    try {
      writeSync(1, JSON.stringify(payload));
    } catch {
      // The exit status still denies.
    }
    try {
      writeSync(2, `${text}\n`);
    } catch {
      // Diagnostic only.
    }
  }
  process.exit(EXIT_DENY);
}

/** @returns {never} */
function allow() {
  try {
    logCall(false, null);
  } catch (error) {
    deny(`continuo codex hook could not write its log, so the call is denied: ${describe(error)}`);
  }
  decided = true;
  process.exit(EXIT_ALLOW);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    return "<unprintable error>";
  }
}

/**
 * `--role R --fence F --mcp-server NAME --log PATH`, each exactly once, nothing
 * else. Any other shape is a rendering defect and denies.
 *
 * @param {readonly string[]} argv
 * @returns {{ role: string, fence: string, mcpServer: string, log: string }}
 */
function parseArguments(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  const names = new Set(["--role", "--fence", "--mcp-server", "--log"]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || !names.has(name) || Object.hasOwn(values, name)) {
      throw new Error(`unexpected argument ${JSON.stringify(name)}`);
    }
    if (value === undefined || value === "") {
      throw new Error(`${name} needs a non-empty value`);
    }
    values[name] = value;
  }
  for (const name of names) {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`${name} is required`);
    }
  }
  return {
    role: values["--role"],
    fence: values["--fence"],
    mcpServer: values["--mcp-server"],
    log: values["--log"],
  };
}

/** @returns {Promise<string>} stdin to EOF, strict UTF-8 (as `hook.mjs`). */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/**
 * `hook.mjs` from beside this file, `rules.js` from the first directory that
 * carries it.
 */
async function loadDependencies() {
  const hook = await import(new URL("./hook.mjs", import.meta.url).href);
  let lastError = new Error("no candidate directory for rules.js was tried");
  for (const directory of DEPENDENCY_DIRECTORIES) {
    try {
      const rules = await import(new URL("rules.js", directory).href);
      if (typeof rules.specMatches !== "function") {
        throw new Error(`the fence logic at ${directory.href} does not export specMatches`);
      }
      if (typeof hook.decidePayload !== "function" || typeof hook.hookSeams !== "object") {
        throw new Error("hook.mjs does not export decidePayload and hookSeams");
      }
      return { hook, specMatches: rules.specMatches };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Deny unless `hook.mjs`'s rules have no objection to this exact event.
 *
 * @param {{ decidePayload: Function }} hook
 * @param {string} fencePath
 * @param {string} role
 * @param {Record<string, unknown>} probe
 */
async function requireNoDenyRule(hook, fencePath, role, probe) {
  const [decision] = await hook.decidePayload(fencePath, probe, { role });
  if (decision.denied !== false) {
    deny(String(decision.reason));
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  logPath = args.log;

  let parsed;
  try {
    parsed = JSON.parse(await readStdin());
  } catch (error) {
    deny(`continuo codex hook could not read a JSON event on stdin: ${describe(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    deny("continuo codex hook: the PreToolUse event is not a JSON object");
  }
  event = parsed;
  const toolName = own(event, "tool_name");
  const toolInput = own(event, "tool_input");
  if (typeof toolName !== "string" || toolName === "") {
    deny("continuo codex hook: the PreToolUse event carried no tool_name");
  }
  const input =
    typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)
      ? toolInput
      : {};

  const { hook, specMatches } = await loadDependencies();

  if (toolName === "Bash") {
    const command = own(input, "command");
    if (typeof command !== "string" || command.trim() === "") {
      deny("continuo codex hook: a Bash call carried no command");
    }
    if (SHELL_COMPOSITION.test(command)) {
      deny(
        "continuo codex hook: shell composition (; & | < > ` $ newline backslash) is not " +
          "allowed in a lap; issue one command per call",
      );
    }
    await hook.hookSeams.loadDependencies();
    const fence = await hook.hookSeams.readFence(args.fence);
    if (fence.role !== args.role) {
      deny(`continuo codex hook: the fence at ${args.fence} is not the ${args.role} fence`);
    }
    const permissions = own(fence.settings, "permissions");
    const allowList =
      typeof permissions === "object" && permissions !== null ? own(permissions, "allow") : [];
    const specs = (Array.isArray(allowList) ? allowList : [])
      .filter(
        (entry) => typeof entry === "string" && entry.startsWith("Bash(") && entry.endsWith(")"),
      )
      .map((entry) => entry.slice("Bash(".length, -1));
    if (
      !READ_ONLY_PROGRAMS.has(programOf(command)) &&
      !specs.some((spec) => admits(specMatches, spec, command))
    ) {
      deny(
        `continuo codex hook: ${JSON.stringify(command)} is not in this lap's allowed Bash ` +
          "commands (the role's allow entries, the run's allowed_bash, or a read-only " +
          "cat/head/tail/ls/wc/grep/pwd)",
      );
    }
    await requireNoDenyRule(hook, args.fence, args.role, { tool_name: "Bash", tool_input: input });
    allow();
  }

  if (toolName === "apply_patch") {
    const patch = own(input, "command");
    if (typeof patch !== "string") {
      deny("continuo codex hook: an apply_patch call carried no patch text");
    }
    const cwd = own(event, "cwd");
    const paths = [];
    for (const raw of patch.split("\n")) {
      // Trimmed as Codex's patch parser trims a hunk header before matching it.
      const line = raw.trim();
      if (!line.startsWith("***") || PATCH_FRAME.has(line)) {
        continue;
      }
      const match = PATCH_PATH.exec(line);
      if (match === null) {
        deny(`continuo codex hook: unrecognised patch header ${JSON.stringify(line)}`);
      }
      const path = match[1];
      if (!isAbsolute(path) && (typeof cwd !== "string" || !isAbsolute(cwd))) {
        deny(
          `continuo codex hook: relative patch path ${JSON.stringify(path)} with no absolute cwd`,
        );
      }
      paths.push(isAbsolute(path) ? resolve(path) : resolve(cwd, path));
    }
    if (paths.length === 0) {
      deny("continuo codex hook: the patch names no file, so there is nothing to check it against");
    }
    for (const path of paths) {
      await requireNoDenyRule(hook, args.fence, args.role, {
        tool_name: "Write",
        tool_input: { file_path: path },
      });
    }
    allow();
  }

  const mcpPrefix = `mcp__${args.mcpServer.replaceAll("-", "_")}__`;
  if (toolName.startsWith(mcpPrefix)) {
    await requireNoDenyRule(hook, args.fence, args.role, {
      tool_name: `mcp__${args.mcpServer}__${toolName.slice(mcpPrefix.length)}`,
      tool_input: input,
    });
    allow();
  }

  deny(`continuo codex hook: the tool ${JSON.stringify(toolName)} is not available in a lap`);
}

process.on("uncaughtException", (error) => {
  deny(`continuo codex hook failed and denied by default: ${describe(error)}`);
});
process.on("unhandledRejection", (error) => {
  deny(`continuo codex hook failed and denied by default: ${describe(error)}`);
});
// An event loop that empties with no verdict (a promise nothing settles) would
// end the process with status 0, which Codex reads as allow.
process.on("beforeExit", () => {
  deny("continuo codex hook stopped without a verdict and denied by default");
});
setTimeout(() => {
  deny("continuo codex hook did not decide in time and denied by default");
}, WATCHDOG_MILLISECONDS).unref();

main().then(
  () => deny("continuo codex hook reached no verdict and denied by default"),
  (error) => deny(`continuo codex hook failed and denied by default: ${describe(error)}`),
);
