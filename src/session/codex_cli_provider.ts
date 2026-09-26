/**
 * The lap worker over the OpenAI Codex CLI (`codex exec`), as a subclass of the
 * Claude provider (continuo D-1114, issue #220).
 *
 * Everything that supervises a child -- the record, the order of writes,
 * liveness, the stop ladder, the group sweep, the queue, the identity *rules*
 * -- is {@link ClaudeCliSessionProvider}'s and is inherited unchanged. What
 * this file overrides is the CLI's dialect, through the `protected _cli*`
 * seams that class keeps for it: how the CLI is probed, how its argv is
 * spelled, where its prompt goes, what is prepared before each spawn, how its
 * transcript names an identity and ends a turn, and where a turn's facts are
 * read from.
 *
 * ## The fence, translated rather than re-rendered
 *
 * The materializer renders one fence for every provider: `cli_args` is the
 * Claude flag vector `--settings S --permission-mode acceptEdits
 * --setting-sources '' --mcp-config P --strict-mcp-config`. This provider takes
 * **exactly** that vector (whole-vector equality, the D-0088 technique) and
 * translates the two documents it names into Codex's own spelling:
 *
 * - `S.sandbox` and the `Read(...)` denials become a from-scratch permission
 *   profile, passed with `-c` and selected with `default_permissions`, so the
 *   OS sandbox denies the reads Claude's sandbox denies (D-1114 M3).
 *   `CODEX_HOME` and the operator's Codex home are denied too.
 * - `S.hooks`' deny hook becomes `codex_hook.mjs` beside it, the allowlisting
 *   hook a Codex worker needs because Codex has no permission mode behind its
 *   hook (see that file's header).
 * - `S.env` becomes `shell_environment_policy.set`, and `P`'s one server
 *   becomes `mcp_servers`.
 *
 * Anything this does not recognise refuses the spawn: a fence layer a CLI
 * cannot enforce is a lap that does not run (the owner's decision on #220),
 * and the day the Claude fence grows a layer, a Codex lap refuses until
 * someone translates it. Which shapes are translated into which layer, and
 * which refuse, is a table (D-1118): `test/session/codex-fence-shapes.test.ts`,
 * whose partition test fails on a shape that is neither.
 *
 * ## Config arrives on the command line and nowhere else
 *
 * `--ignore-user-config --strict-config --ignore-rules` and every setting as a
 * `-c` override (D-1114 M3, M6): no `config.toml` is rendered, the target
 * repository's `.codex/` and `.rules` are not loaded, and a key this Codex
 * build does not know is a startup error rather than a silently ignored line.
 * The per-session `CODEX_HOME` holds only `auth.json` (a link to the real
 * path of the operator's file, which every Codex lap's profile denies, so it
 * reads as denied through the link from any lap) and `hooks.json`, and both
 * are rewritten before every spawn; the `config.toml` Codex scribbles trust
 * entries into is removed. It sits beside the session directory, not in it
 * (`codex-homes+/<id>`, a name no session id can spell), because the session
 * directory is taken down flat and the home holds the rollout `resume` needs.
 * Every session's home shares that one parent, which the profile denies too:
 * the homes hold other sessions' rollouts, and a link Codex might replace with
 * a file on a token refresh would otherwise be readable to a sibling session.
 *
 * ## What is weaker than Claude, stated where it is weaker
 *
 * - **Identity is adopted, not committed.** Codex 0.153.4 has no flag to name
 *   a thread before it starts, so generation 0 adopts the first
 *   `thread.started` it reports and every later event must agree with it;
 *   a resume must name the same thread. The rollout's `session_meta` is a
 *   second witness. Orphan recognition is unchanged: the command line carries
 *   continuo's own UUID in the `-o` path.
 * - **`write_stdin` does not fire the hook** (D-1114 M5), so an
 *   `allowed_bash` entry whose program reads commands from stdin would escape
 *   the allowlist; the interpreters and shells in {@link STDIN_PROGRAMS} are
 *   refused outright. Another program that does so is bounded only by the OS
 *   sandbox.
 * - **The D-1112 socket probe does not apply**: Codex's sandbox came up and
 *   enforced under the AF_UNIX-EPERM filter (D-1114 M2). Its
 *   place is taken by `codex sandbox` self-tests that prove the denials hold.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";

import { fnmatchcase } from "../fencing/fnmatch.js";
import { pyJsonDumps } from "../fencing/pyjson.js";
import { parsePermissionRule } from "../fencing/rules.js";
import { quote, split as shlexSplit } from "../fencing/shlex.js";
import { readFence } from "../fencing/state.js";
import {
  ClaudeCliSessionProvider,
  type ClaudeCliSessionProviderOptions,
  type CliProbePlan,
  type CliProbeRunner,
  type CliTerminalWords,
  type CliTurnFacts,
  type DeniedToolCall,
  pyResolve,
  type SessionRecord,
  type TurnCommand,
} from "./claude_cli_provider.js";
import { Failure, FailureKind } from "./provider.js";
import { type ProbeOptions, sessionRuntime } from "./runtime.js";

/** The Codex build this was written and measured against (D-0010's record). */
const CODEX_VERSION_WRITTEN_AGAINST = "codex-cli 0.153.4";

/**
 * The flags `codex exec --help` must carry, per capability. A plain substring
 * test, as for Claude. `resume` is the subcommand's own line in the listing.
 */
const CODEX_CAPABILITY_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "session.start",
    [
      "--ignore-user-config",
      "--strict-config",
      "--ignore-rules",
      "--dangerously-bypass-hook-trust",
      "--skip-git-repo-check",
      "--output-last-message",
    ],
  ],
  ["session.resume", ["resume"]],
  ["session.structured-readout", ["--json"]],
]);

/**
 * The flags every `codex exec` and `codex exec resume` spawn starts with. All
 * of them are in `codex exec resume --help` too (checked on 0.153.4); `-C` is
 * not, so a resume's working directory is the spawn's `cwd`, which is the
 * workspace for both.
 */
const EXEC_FLAGS: readonly string[] = [
  "--json",
  "--ignore-user-config",
  "--strict-config",
  "--ignore-rules",
  "--dangerously-bypass-hook-trust",
  "--skip-git-repo-check",
];

/**
 * Tool surfaces a lap has no use for, switched off by name. The hook denies
 * them anyway; this keeps them out of the model's view. `multi_agent` does not
 * remove sub-agents (D-1114 M5): the hook and the post-turn check hold that.
 */
const DISABLED_FEATURES: readonly string[] = [
  "apps",
  "image_generation",
  "goals",
  "view_image",
  "multi_agent",
];

/**
 * Environment the worker's commands get on top of Codex's `core` set. The
 * editor and pager values close the one known `write_stdin` route through an
 * allowlisted command: `git commit` opening an editor that then reads the
 * model's keystrokes.
 */
const NEUTRAL_ENV: Readonly<Record<string, string>> = {
  GIT_EDITOR: "true",
  EDITOR: "true",
  VISUAL: "true",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * `S.env` names a Codex lap refuses (#223): what the shell and the loader read
 * to pick the program a command runs, git's own knobs, and {@link NEUTRAL_ENV}'s
 * names, which would be overridden silently. The hook admits `cat` or
 * `git diff` by name; under a fence-set `PATH` or `GIT_EXTERNAL_DIFF` that name
 * runs something else.
 */
const STEERING_ENV =
  /^(?:PATH|HOME|SHELL|IFS|ENV|BASH_ENV|ZDOTDIR|CODEX_HOME|NODE_OPTIONS|NODE_PATH|EDITOR|VISUAL|PAGER|MANPAGER|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|LESSOPEN|LESSCLOSE|RUBYOPT|PYTHON[A-Z0-9_]*|PERL[A-Z0-9_]*|(?:LD|DYLD|GIT|XDG|NPM_CONFIG)_[A-Z0-9_]*)$/;

/**
 * Codex's own tool names a deny rule might name: each reaches the lap either
 * under another name (`apply_patch` is checked as `Write`, a shell call as
 * `Bash`) or without the hook at all (`write_stdin`, `wait`), so a rule naming
 * one matches nothing (#223).
 */
const CODEX_TOOL_NAMES: ReadonlySet<string> = new Set([
  "apply_patch",
  "exec_command",
  "shell",
  "exec",
  "wait",
  "write_stdin",
]);

/**
 * Programs that execute what arrives on their stdin (D-1114 rule 5). A Bash
 * allow entry naming one is refused for a Codex lap, because `write_stdin`
 * reaches a running process without the hook seeing it. Compared after a
 * trailing version is dropped, so `python3.12` and `node22` are caught.
 */
/** The characters an allowed program name may use in a Codex lap (D-1114 rule 5). */
const PLAIN_PROGRAM = /^[A-Za-z0-9_./+-]+$/;

const STDIN_PROGRAMS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "node",
  "python",
  "perl",
  "ruby",
  "deno",
  "bun",
  "npx",
  "env",
  "xargs",
  "ksh",
  "mksh",
  "csh",
  "tcsh",
  "pwsh",
  "php",
  "lua",
  "irb",
  "nodejs",
  "ash",
  "busybox",
  "tclsh",
  "expect",
  // Compared unversioned, so `sqlite3` is `sqlite`.
  "sqlite",
  "gdb",
  "pypy",
  "ipython",
  "psql",
  "mysql",
  "ed",
  "ex",
  "vi",
  "vim",
  "nvim",
  "dc",
  "gnuplot",
  "R",
  "Rscript",
  "julia",
  // Programs that read a script from a file argument, which may be /dev/stdin.
  "awk",
  "gawk",
  "mawk",
  "nawk",
  "sed",
  // Programs that run the program their arguments name, which may be any of
  // the above (#223): `timeout 600 bash` reads stdin as surely as `bash`.
  "timeout",
  "nice",
  "nohup",
  "stdbuf",
  "time",
  "setsid",
  "script",
  "sudo",
  "doas",
  "chroot",
  "unshare",
  "strace",
  "ltrace",
  "ionice",
  "taskset",
  "chrt",
  "flock",
  "nsenter",
  "watch",
  "su",
  "runuser",
  "pkexec",
  "systemd-run",
  "firejail",
  "fakeroot",
  "parallel",
  // Shell builtins the login shell runs as a command's first word.
  "command",
  "exec",
  "builtin",
  "eval",
  "source",
  ".",
]);

/** A program's name without a trailing version: `python3.12`, `node22`, `bash-5.2`. */
function unversioned(program: string): string {
  const name = basename(program);
  return name.replace(/[-0-9.]+$/, "") || name;
}

/** The only permission mode the materializer renders for a `-p` child (D-0081). */
const FENCE_PERMISSION_MODE = "acceptEdits";

/** The permission profile's name, in `-c` and in the post-turn check. */
const PROFILE = "fence";

/**
 * The calls the post-turn check lets through without a hook log line, and
 * nothing else (D-1117): the direct `wait`, measured not to fire the hook; a
 * code-mode script that names no identifier but `text`, so it can reach no
 * tool; and a `write_stdin` that writes nothing, direct or as a script whose
 * argument holds only names, numbers and empty strings. `write_stdin` never
 * fires the hook, so one that writes input counts: that input reaches a running
 * process past the hook. (A script that also makes a hooked call is covered by
 * that call's line; D-1117 names that residual.) Every other call, a failed
 * script included, may have fired it.
 */
const TOOL_FREE_SCRIPT = /^(?:[\s\d+\-*/%().,;]|\btext\b)*$/;
const STDIN_POLL_SCRIPT =
  /^\s*(?:text\()?await tools\.write_stdin\(\{(?:\s*\w+\s*:\s*(?:\d+|""|'')\s*(?:,|(?=\})))*\s*\}\)\)?;?\s*$/;

function hookFree(name: string, input: string): boolean {
  switch (name) {
    case "exec":
      return TOOL_FREE_SCRIPT.test(input) || STDIN_POLL_SCRIPT.test(input);
    case "wait":
      return true;
    case "write_stdin":
      try {
        const args: unknown = JSON.parse(input);
        return isRecord(args) && (args["chars"] === undefined || args["chars"] === "");
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/**
 * The platform a Codex lap would run on. A seam, so the translation's cases
 * still run in the suite's Windows cells, where a real lap is refused (D-1118).
 */
export const codexCliSeams = { platform: process.platform as string };

/** Depth Codex expands a `**` deny glob to at spawn (D-1114 M3). */
const GLOB_SCAN_MAX_DEPTH = 6;

/** Seconds Codex gives the hook; `codex_hook.mjs` denies on its own at 20. */
const HOOK_TIMEOUT_SECONDS = 30;

/** The fence as this provider reads it off `S` and `P`. */
export interface CodexFence {
  readonly python: string;
  readonly hookScript: string;
  readonly role: string;
  readonly fencePath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly writeRoots: readonly string[];
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  /** The `x` of every `Read(x)` deny rule. */
  readonly readRules: readonly string[];
  readonly mcpName: string;
  readonly mcpCommand: string;
  readonly mcpArgs: readonly string[];
  readonly mcpEnv: Readonly<Record<string, string>>;
}

/** Constructor options: the Claude provider's, plus where `auth.json` comes from. */
export interface CodexCliSessionProviderOptions extends ClaudeCliSessionProviderOptions {
  /** The operator's Codex home, absolute: `auth.json` is copied from it. */
  readonly codexHome: string;
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A TOML value for a `-c` override. A JSON string literal is a valid TOML
 * basic string, and every key is quoted, so a path key needs no escaping rule
 * of its own. `--strict-config` refuses whatever this gets wrong.
 */
function toml(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(toml).join(", ")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`)
    .join(", ")}}`;
}

function paddedGeneration(generation: number): string {
  return String(generation).padStart(3, "0");
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * The branch ref among the fence's write roots (`gitMetadataRoots`' item 3,
 * `<common dir>/refs/heads/<branch>`), split where `refs/heads/` starts, or
 * `null` for a detached checkout that has none. Split on `/` because
 * `gitMetadataRoots` spells every path that way.
 */
function branchRefOf(
  writeRoots: readonly string[],
): { readonly commonDir: string; readonly branch: string } | null {
  for (const root of writeRoots) {
    const at = root.indexOf("/refs/heads/");
    const commonDir = root.slice(0, at);
    // Only the ref gitMetadataRoots names, beside its own common directory's
    // `objects` and `packed-refs`: any other path through a `refs/heads`
    // (a role's own directory) would have its parent granted write (#223).
    if (
      at > 0 &&
      writeRoots.includes(`${commonDir}/objects`) &&
      writeRoots.includes(`${commonDir}/packed-refs`)
    ) {
      return { commonDir, branch: root.slice(at + "/refs/heads/".length) };
    }
  }
  return null;
}

/**
 * Every directory the profile grants write in, and the entries inside them
 * pinned back to read -- computed in ONE place, because the spawn's refusal of
 * a write denial that contains a write root has to see exactly the roots the
 * profile will grant, rule 8's included (D-1114).
 */
function effectiveWriteRoots(
  fence: CodexFence,
  workspace: string,
): { readonly roots: readonly string[]; readonly pinned: readonly string[] } {
  // Directories only. Codex mounts a read-only `.git`/`.codex`/`.agents`
  // under every writable root, so a FILE root (the branch ref, packed-refs:
  // gitMetadataRoots' 3 and 4) makes bwrap fail and the helper panic (exit
  // 101, measured on the first real lap). Dropping one narrows the profile,
  // never widens it; git writes `<ref>.lock` and the reflog beside the ref,
  // not into it, so the ref file alone would not have let a commit through.
  const roots = [workspace, ...fence.writeRoots.filter(isDirectory)];
  // What `git commit` does need instead (D-1114 rule 8, the owner's answer):
  // the branch's parent directory under `refs/heads` for `<ref>.lock`, and
  // the same directory under `logs/` for the reflog. Every OTHER entry
  // already in either directory -- a sibling branch's ref or log -- is
  // pinned read-only, so the grant reaches this branch and new names only.
  const pinned: string[] = [];
  const ref = branchRefOf(fence.writeRoots);
  if (ref !== null) {
    const slash = ref.branch.lastIndexOf("/");
    const namespace = ref.branch.slice(0, slash);
    const own = ref.branch.slice(slash + 1);
    for (const dir of [
      `${ref.commonDir}/refs/heads/${namespace}`,
      `${ref.commonDir}/logs/refs/heads/${namespace}`,
    ]) {
      if (!isDirectory(dir)) {
        continue;
      }
      roots.push(dir);
      for (const entry of readdirSync(dir)) {
        if (entry !== own) {
          pinned.push(`${dir}/${entry}`);
        }
      }
    }
  }
  return { roots, pinned };
}

/** `path` with its deepest existing ancestor replaced by that ancestor's real path. */
function realOf(path: string): string {
  const rest: string[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      if (dirname(at) === at) {
        return resolve(path);
      }
      rest.push(basename(at));
    }
  }
}

/**
 * Where `path` lies against `root` -- inside it (or it), over it, or apart --
 * the same by their spellings and by their real paths, or `null` when a link
 * makes the two disagree (#223): the profile keys the spelling and the kernel
 * follows the link, so no one answer holds.
 */
function relationOf(path: string, root: string): "in" | "over" | "apart" | null {
  const relation = (p: string, r: string) =>
    within(p, r) ? "in" : within(r, p) ? "over" : "apart";
  const spelled = relation(path, root);
  return spelled === relation(realOf(path), realOf(root)) ? spelled : null;
}

/** The directory a file's real path lies in, or `null` if it cannot be resolved. */
function realDirectoryOf(path: string): string | null {
  try {
    return dirname(realpathSync(path));
  } catch {
    return null;
  }
}

function within(path: string, root: string): boolean {
  // Resolved first: rule 8's roots are spelled with `/` and a fence's paths may
  // not be, so on Windows a raw prefix test against `sep` never matched (#224).
  path = resolve(path);
  root = resolve(root);
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** A file's JSONL lines as objects with their 1-based line numbers; garbage skipped. */
function readJsonLines(path: string): { line: number; value: Record<string, unknown> }[] | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines: { line: number; value: Record<string, unknown> }[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    try {
      const value: unknown = JSON.parse(raw);
      if (isRecord(value)) {
        lines.push({ line: index + 1, value });
      }
    } catch {
      // A partial or foreign line names nothing.
    }
  }
  return lines;
}

/** The first `thread.started` thread id among `events`, or `null`. */
function firstThreadId(events: readonly Record<string, unknown>[]): string | null {
  for (const event of events) {
    const id = threadIdOf(event);
    if (typeof id === "string" && id !== "") {
      return id;
    }
  }
  return null;
}

function threadIdOf(event: Readonly<Record<string, unknown>>): unknown {
  return field(event, "type") === "thread.started" ? field(event, "thread_id") : undefined;
}

/**
 * Whether an absolute path is spelled the one way a profile key and the
 * spawn's containment checks agree on (#223): no `.` or `..` segment, no empty
 * segment (`//x`, a trailing separator), and no brace, which Codex's glob may
 * read differently from the fence's matcher. A key Codex resolved differently
 * from `within` would pin or deny a path the checks never looked at.
 */
function plainPath(path: string): boolean {
  return (
    !/[{}]/.test(path) &&
    path
      .split(/[\\/]/)
      .every((part, index) => (index === 0 ? true : part !== "" && part !== "." && part !== ".."))
  );
}

/**
 * `Read(x)` to the profile paths it denies, or `null` for a shape not
 * translated. `roots` are the profile's write roots, the workspace first: a
 * rule of `**` and one segment is denied under each of them (the owner's answer on #223,
 * D-1118), so every place the lap can create a file is covered; the fence's
 * matcher reads it as anywhere, and a matching file outside every write root
 * stays readable.
 */
function readDenyPaths(rule: string, roots: readonly string[]): readonly string[] | null {
  const workspace = roots[0] ?? "/";
  if (rule.startsWith("~/")) {
    return plainPath(rule.slice(1)) ? [join(homedir(), rule.slice(2))] : null;
  }
  if (isAbsolute(rule)) {
    return plainPath(rule) ? [rule] : null;
  }
  // `~` alone and `~user` name a home directory to the fence's matcher and a
  // workspace file to the branch below; neither reading is safe to pick (#223).
  if (
    rule.startsWith("~") ||
    /[{}]/.test(rule) ||
    rule.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return null;
  }
  if (rule.startsWith("**/") && !rule.slice(3).includes("/")) {
    return [...new Set(roots)].map((root) => `${root}/${rule}`);
  }
  if (!rule.includes("/")) {
    return [join(workspace, rule), `${workspace}/**/${rule}`];
  }
  return null;
}

function refused(detail: string): Failure {
  return new Failure(FailureKind.REFUSED_BY_PROVIDER, detail);
}

/**
 * The fence vector and the two documents it names, read and validated, or the
 * reason they are not translatable. Shape only: every key the Codex rendering
 * does not consume is a reason, so an unknown key is a refusal and never a
 * silently dropped layer.
 *
 * Exported for the fence-shape table (`test/session/codex-fence-shapes.test.ts`,
 * #223), which walks every input shape through it.
 */
export function translateFence(cliArgs: readonly string[]): CodexFence | string {
  if (codexCliSeams.platform === "win32") {
    return (
      "a Codex lap does not run on Windows until Codex's Windows sandbox is measured " +
      "(#226, D-1118): nothing this translation writes into a profile is claimed there"
    );
  }
  const shape = [
    "--settings",
    null,
    "--permission-mode",
    FENCE_PERMISSION_MODE,
    "--setting-sources",
    "",
    "--mcp-config",
    null,
    "--strict-mcp-config",
  ];
  if (
    cliArgs.length !== shape.length ||
    shape.some((want, index) => want !== null && cliArgs[index] !== want)
  ) {
    return (
      `cli_args is ${JSON.stringify(cliArgs)}; the Codex provider translates exactly the ` +
      "fence vector the materializer renders (--settings S --permission-mode acceptEdits " +
      "--setting-sources '' --mcp-config P --strict-mcp-config) and nothing else"
    );
  }
  const settingsPath = cliArgs[1] as string;
  const mcpPath = cliArgs[7] as string;
  if (!isAbsolute(settingsPath) || !isAbsolute(mcpPath)) {
    return "the fence's --settings and --mcp-config paths must be absolute";
  }
  let settings: unknown;
  let mcp: unknown;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  } catch (exc) {
    return `the fence's documents could not be read: ${String(exc)}`;
  }

  if (
    !isRecord(settings) ||
    !hasOnlyKeys(settings, ["permissionMode", "permissions", "sandbox", "hooks", "env"])
  ) {
    return `${settingsPath} carries a key the Codex translation does not know`;
  }
  if (settings["permissionMode"] !== FENCE_PERMISSION_MODE) {
    return `${settingsPath} is not an ${FENCE_PERMISSION_MODE} fence`;
  }
  const permissions = settings["permissions"] ?? {};
  if (
    !isRecord(permissions) ||
    !hasOnlyKeys(permissions, ["allow", "deny"]) ||
    !isStringArray(permissions["allow"] ?? []) ||
    !isStringArray(permissions["deny"] ?? [])
  ) {
    return `${settingsPath}'s permissions are not the allow / deny lists the translation reads`;
  }
  const sandbox = settings["sandbox"];
  const filesystem = field(sandbox, "filesystem");
  if (
    !isRecord(sandbox) ||
    !hasOnlyKeys(sandbox, ["enabled", "filesystem"]) ||
    sandbox["enabled"] !== true ||
    !isRecord(filesystem) ||
    !hasOnlyKeys(filesystem, ["denyRead", "denyWrite", "additionalDirectories"])
  ) {
    return `${settingsPath}'s sandbox is not an enabled filesystem sandbox the translation reads`;
  }
  const paths: Record<string, string[]> = {};
  for (const key of ["denyRead", "denyWrite", "additionalDirectories"]) {
    const entries = filesystem[key] ?? [];
    if (
      !isStringArray(entries) ||
      !entries.every((entry) => isAbsolute(entry) && plainPath(entry))
    ) {
      return (
        `${settingsPath}'s sandbox.filesystem.${key} is not a list of absolute paths ` +
        "spelled plainly (no '.', '..' or empty segment, no brace)"
      );
    }
    paths[key] = entries;
  }
  // A write denial is kept by comparing it with the write roots as a literal
  // path; a glob (`/tmp/*/protected`) never compares as inside one and would
  // be dropped from the profile, so it is refused instead (D-1114 rule 2).
  const globbed = (paths["denyWrite"] ?? []).find((entry) => /[*?[\]{}]/.test(entry));
  if (globbed !== undefined) {
    return (
      `${settingsPath}'s sandbox.filesystem.denyWrite entry ${JSON.stringify(globbed)} is a glob, ` +
      "which a Codex permission profile cannot be checked to keep"
    );
  }

  const groups = field(settings["hooks"], "PreToolUse");
  const group = Array.isArray(groups) && groups.length === 1 ? groups[0] : undefined;
  const handlers = field(group, "hooks");
  const handler = Array.isArray(handlers) && handlers.length === 1 ? handlers[0] : undefined;
  const command = field(handler, "command");
  let tokens: string[] = [];
  try {
    tokens = typeof command === "string" ? shlexSplit(command) : [];
  } catch {
    tokens = [];
  }
  if (
    !isRecord(settings["hooks"]) ||
    !hasOnlyKeys(settings["hooks"], ["PreToolUse"]) ||
    // Records first: a missing group or handler (an empty or doubled list)
    // is a refusal like any other unexpected shape, not a TypeError.
    !isRecord(group) ||
    !hasOnlyKeys(group, ["matcher", "hooks"]) ||
    field(group, "matcher") !== "*" ||
    !isRecord(handler) ||
    !hasOnlyKeys(handler, ["type", "command"]) ||
    field(handler, "type") !== "command" ||
    tokens.length !== 6 ||
    tokens[2] !== "--role" ||
    tokens[4] !== "--fence" ||
    basename(tokens[1] as string) !== "hook.mjs" ||
    // A relative interpreter, hook or fence would be resolved against
    // whatever directory Codex runs the hook in, which the worker can write.
    ![tokens[0], tokens[1], tokens[5]].every((token) => isAbsolute(token as string))
  ) {
    return (
      `${settingsPath}'s hooks are not exactly the one deny hook ` +
      "'<interpreter> <dir>/hook.mjs --role R --fence F' the translation replaces"
    );
  }
  const hookScript = tokens[1] as string;
  if (!existsSync(join(dirname(hookScript), "codex_hook.mjs"))) {
    return `codex_hook.mjs is missing beside ${hookScript}; a Codex worker has no fence without it`;
  }
  // The hook reads its allow and deny lists from F; everything else here is
  // read from S. They are published together from one fence, and a lap whose
  // two documents disagree is fenced by one nothing here checked (#223).
  const canonical = (value: unknown) => pyJsonDumps(value, { sortKeys: true });
  let hookFence: ReturnType<typeof readFence>;
  try {
    hookFence = readFence(tokens[5] as string);
  } catch (exc) {
    return `the fence ${tokens[5] as string} the hook reads could not be read: ${String(exc)}`;
  }
  if (hookFence.role !== tokens[3] || canonical(hookFence.settings) !== canonical(settings)) {
    return (
      `the fence ${tokens[5] as string} the hook reads is not the ${tokens[3] as string} fence ` +
      `${settingsPath} holds, so the hook would enforce lists this translation never read`
    );
  }
  const env = settings["env"] ?? {};
  if (!isStringRecord(env)) {
    return `${settingsPath}'s env is not a mapping of strings`;
  }
  const steering = Object.keys(env).find(
    (key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || STEERING_ENV.test(key.toUpperCase()),
  );
  if (steering !== undefined) {
    return (
      `${settingsPath}'s env sets ${JSON.stringify(steering)}, which is not a plain name or ` +
      "steers which program a Codex lap's allowlisted commands run (or is one this " +
      "provider sets itself); the hook admits those commands by name"
    );
  }

  const allow = (permissions["allow"] ?? []) as string[];
  for (const entry of allow) {
    if (!(entry.startsWith("Bash(") && entry.endsWith(")"))) {
      continue;
    }
    // The program exactly as codex_hook.mjs's `admits` reads it (`programOf`
    // of the spec without its `:*`), so the name checked here is the name the
    // hook will match. A name outside a plain character set -- a quote, a glob,
    // a `:`, an empty name -- cannot be classified and is refused (D-1114 rule 5).
    const spec = entry.slice(5, -1);
    const named = spec.endsWith(":*") ? spec.slice(0, -2) : spec;
    const program = named.replace(/^[ \t]+/, "").split(/[ \t]/)[0] ?? "";
    if (!PLAIN_PROGRAM.test(program)) {
      return (
        `the allow entry ${JSON.stringify(entry)} names its program as ${JSON.stringify(program)}, ` +
        "which cannot be checked against the programs that execute their stdin; a program " +
        "name for a Codex lap is letters, digits and _ . / + - only"
      );
    }
    if (STDIN_PROGRAMS.has(unversioned(program))) {
      return (
        `the allow entry ${JSON.stringify(entry)} runs a program that executes its stdin, ` +
        "and a Codex worker's write_stdin reaches a running process without the hook " +
        "seeing it; interpreters and shells are not allowed_bash entries for a Codex lap"
      );
    }
    // The hook's matcher reads `?` and `[...]` as wildcards; Claude's rule
    // grammar has only `*`, so the hook would admit what Claude never does.
    if (/[?[\]]/.test(named)) {
      return (
        `the allow entry ${JSON.stringify(entry)} uses ? or [ ], which the Codex hook reads ` +
        "as a wildcard and Claude reads as a literal character"
      );
    }
  }
  // Every deny rule is classified by the tool it names, the way the fence's
  // own parser reads it, and a tool with no Codex layer behind it refuses the
  // lap (#223). Other allow entries (Read, Edit, WebFetch, ...) only grant,
  // and the hook grants nothing it was not written to, so they are narrowed,
  // never dropped.
  const readRules: string[] = [];
  const editDenials: string[] = [];
  const mcpRules: string[] = [];
  for (const entry of (permissions["deny"] ?? []) as string[]) {
    let rule: ReturnType<typeof parsePermissionRule>;
    try {
      rule = parsePermissionRule(entry);
    } catch {
      return `the deny rule ${JSON.stringify(entry)} cannot be parsed`;
    }
    const { tool, spec } = rule;
    // The hook enforces F's rules, not S's list: a rule S names and F lacks
    // would be read here and enforced nowhere.
    if (!hookFence.rules.some((held) => held.ruleId === rule.ruleId)) {
      return (
        `the deny rule ${JSON.stringify(entry)} is not among the rules of the fence ` +
        `${tokens[5] as string} the hook enforces`
      );
    }
    const whole = !entry.includes("(");
    const untranslatable = `the deny rule ${JSON.stringify(entry)} has no Codex permission-profile spelling`;
    if (tool === "Bash") {
      // codex_hook.mjs puts every admitted Bash call through hook.mjs's rules.
      continue;
    }
    if (tool === "Read") {
      if (whole || spec === "*" || readDenyPaths(spec, ["/"]) === null) {
        return untranslatable;
      }
      readRules.push(spec);
    } else if (tool === "Edit" || tool === "Write") {
      // A patch is checked as a Write by the hook; a shell write is not, so
      // the path has to reach the profile too, which a glob or a relative
      // path cannot be checked to do.
      const path = spec.startsWith("~/") ? join(homedir(), spec.slice(2)) : spec;
      if (whole || !isAbsolute(path) || !plainPath(path) || /[*?[\]]/.test(path)) {
        return (
          `the deny rule ${JSON.stringify(entry)} is not one absolute or ~/ path, so a Codex ` +
          "permission profile cannot be checked to keep it against a shell write"
        );
      }
      editDenials.push(path);
    } else if (tool.startsWith("mcp__")) {
      mcpRules.push(entry);
    } else if (
      ["Grep", "Glob", "LS", "NotebookRead", "NotebookEdit", "MultiEdit"].includes(tool) ||
      CODEX_TOOL_NAMES.has(tool)
    ) {
      // Codex reads and writes through `cat`, `grep` and `apply_patch`, which
      // the hook checks as Bash and Write; a rule under these names never
      // matches what a Codex worker runs.
      return untranslatable;
    }
    // Any other tool (WebFetch, Task, ...) is one a Codex lap has no route to:
    // the hook denies every tool it was not written to admit.
  }

  // D-1114 rule 8: `git commit` needs the ref's DIRECTORY writable, and a
  // top-level branch's directory is `refs/heads` itself, which holds the base
  // branch too. `lap perform`'s preflight refuses it before a worktree exists;
  // this is the same rule for any other caller of the provider.
  const ref = branchRefOf(paths["additionalDirectories"] ?? []);
  if (ref !== null && !ref.branch.includes("/")) {
    return (
      `the topic branch ${JSON.stringify(ref.branch)} is a top-level name; a Codex lap ` +
      "can commit only on a branch under a namespace (such as lap/<name>), because the " +
      "directory it must write is the branch's parent and refs/heads itself holds every branch"
    );
  }

  const servers = field(mcp, "mcpServers");
  const names = isRecord(servers) ? Object.keys(servers) : [];
  const server = names.length === 1 ? field(servers, names[0] as string) : undefined;
  if (
    !isRecord(mcp) ||
    !hasOnlyKeys(mcp, ["mcpServers"]) ||
    !isRecord(server) ||
    !hasOnlyKeys(server, ["command", "args", "env"]) ||
    typeof server["command"] !== "string" ||
    !isAbsolute(server["command"]) ||
    !isStringArray(server["args"] ?? []) ||
    !isStringRecord(server["env"] ?? {})
  ) {
    return `${mcpPath} is not exactly one stdio MCP server the translation reads`;
  }
  // The hook admits `mcp__<name with - as _>__*`: a name that could spell
  // another prefix -- the operator's `codex_apps` connectors among them -- is
  // refused (#223).
  const mcpName = names[0] as string;
  if (!/^[A-Za-z0-9-]+$/.test(mcpName) || mcpName.replaceAll("-", "_") === "codex_apps") {
    return `${mcpPath}'s server name ${JSON.stringify(mcpName)} is not letters, digits and - only`;
  }
  // The hook checks a call to the lap's server as `mcp__<name>__<tool>` by
  // name equality, so a rule for the whole server, with a wildcard, or in
  // Codex's `_` spelling matches no call (#223). A rule for another server is
  // kept by the hook's default deny.
  // Codex spells a qualified tool name in [A-Za-z0-9_] and at most 64
  // characters, so a tool part outside that is a name the hook never sees.
  const serverWide = mcpRules.find((entry) => {
    const { tool } = parsePermissionRule(entry);
    const server = tool.slice("mcp__".length).split("__")[0] ?? "";
    return (
      server.replaceAll("-", "_") === mcpName.replaceAll("-", "_") &&
      !(new RegExp(`^mcp__${mcpName}__[A-Za-z0-9_]+$`).test(tool) && tool.length <= 64)
    );
  });
  if (serverWide !== undefined) {
    return (
      `the deny rule ${JSON.stringify(serverWide)} names the lap's MCP server as a whole or ` +
      "by a spelling the Codex hook matches against no call; name each tool as mcp__" +
      `${mcpName}__<tool>`
    );
  }

  return {
    python: tokens[0] as string,
    hookScript,
    role: tokens[3] as string,
    fencePath: tokens[5] as string,
    env,
    writeRoots: paths["additionalDirectories"] ?? [],
    denyRead: paths["denyRead"] ?? [],
    denyWrite: [...(paths["denyWrite"] ?? []), ...editDenials],
    readRules,
    mcpName,
    mcpCommand: server["command"],
    mcpArgs: (server["args"] ?? []) as string[],
    mcpEnv: (server["env"] ?? {}) as Record<string, string>,
  };
}

/**
 * Whether a probe that was run failed by **exiting non-zero** -- the answer a
 * denial gives -- as opposed to timing out or not running at all. The runner
 * reports a non-zero exit as a `Failure` carrying the child's `stderr`.
 */
function exitedNonZero(outcome: unknown): boolean {
  return (
    outcome instanceof Failure &&
    outcome.kind === FailureKind.BACKEND_UNREACHABLE &&
    Object.hasOwn(outcome.providerDetail, "stderr")
  );
}

// --------------------------------------------------------------------------
// The provider
// --------------------------------------------------------------------------

/**
 * {@link ClaudeCliSessionProvider}, speaking `codex exec`. See the module
 * header for what is translated, what is refused, and what is weaker.
 */
export class CodexCliSessionProvider extends ClaudeCliSessionProvider {
  readonly #stateRoot: string;

  readonly #codexHome: string;

  /**
   * The fence each pending spawn was translated to: set where the vector is
   * read (`_cliSessionArgs` for a start, `_cliResumeArgv` for a resume), read
   * by the argv, and taken by `_cliPrepareSpawn`. One translation per spawn,
   * so the profile in the argv and the hook in `hooks.json` are one reading.
   */
  readonly #translations = new Map<string, CodexFence>();

  constructor(stateRoot: string, options: CodexCliSessionProviderOptions) {
    // The inherited default is `claude`; a Codex provider built without a
    // command must run `codex`, not probe Claude with `exec --help`.
    super(stateRoot, { ...options, claudeCommand: options.claudeCommand ?? "codex" });
    if (typeof options.codexHome !== "string" || !isAbsolute(options.codexHome)) {
      throw new TypeError("codexHome must be an absolute path to the operator's Codex home");
    }
    this.#stateRoot = pyResolve(stateRoot);
    this.#codexHome = resolve(options.codexHome);
  }

  // -- probe -------------------------------------------------------------

  /** `[]` or `["--model", X]` and nothing else: every other flag is this provider's. */
  protected override _cliCheckBaseArgs(args: readonly string[]): string | null {
    if (args.length === 0) {
      return null;
    }
    const model = args[1];
    if (args.length === 2 && args[0] === "--model" && model !== undefined && /^[^-]/.test(model)) {
      return null;
    }
    return args[0] ?? "";
  }

  protected override _cliProbe(): CliProbePlan {
    return {
      helpArgs: ["exec", "--help"],
      flags: CODEX_CAPABILITY_FLAGS,
      writtenAgainst: CODEX_VERSION_WRITTEN_AGAINST,
    };
  }

  /**
   * `codex sandbox -- true` under a minimal from-scratch profile, before any
   * worktree exists (D-1114 rule 4). A Codex whose sandbox cannot come up
   * runs no command and still reports a finished turn (D-1114 M2),
   * so this is where that is found out cheaply. `codex sandbox`
   * is offline and needs no credentials.
   */
  protected override _cliProbeExtra(run: CliProbeRunner): Failure | null {
    const home = join(this.#stateRoot, "codex-probe+home");
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      rmSync(join(home, "config.toml"), { force: true });
    } catch (exc) {
      return new Failure(
        FailureKind.INCOMPATIBLE_PROVIDER,
        `the Codex sandbox probe home ${home} could not be prepared: ${String(exc)}`,
      );
    }
    const profile = { [PROFILE]: { filesystem: { ":root": "read", [home]: "write" } } };
    const outcome = run(
      ["sandbox", "-C", home, "-c", `permissions=${toml(profile)}`, "-P", PROFILE, "--", "true"],
      this.#probeEnv(home),
    );
    if (outcome instanceof Failure) {
      return new Failure(
        FailureKind.INCOMPATIBLE_PROVIDER,
        `the Codex sandbox cannot run 'true' under a minimal profile here, so a Codex ` +
          `worker would run no command at all: ${outcome.detail}`,
        outcome.providerDetail,
      );
    }
    return null;
  }

  // -- argv ----------------------------------------------------------------

  /** The whole-vector check and the translation, before anything durable exists. */
  protected override _cliSessionArgs(
    sessionId: string,
    cliArgs: readonly string[],
  ): Failure | null {
    const fence = translateFence(cliArgs);
    if (typeof fence === "string") {
      return refused(`session '${sessionId}': ${fence}`);
    }
    this.#translations.set(sessionId, fence);
    return null;
  }

  protected override _cliStartArgv(
    command: readonly string[],
    baseCliArgs: readonly string[],
    record: Omit<SessionRecord, "argv">,
    _prompt: string,
  ): readonly string[] {
    return [
      ...command,
      "exec",
      ...EXEC_FLAGS,
      "-C",
      record.workspace,
      ...this.#configArgs(this.#translationOf(record.session_id), record),
      // The prompt is on stdin (`-`, D-1114 M7): a prompt argument is read
      // as a subcommand or a flag by clap when it looks like one.
      ...baseCliArgs,
      "-",
    ];
  }

  /**
   * `codex exec resume <thread> -`, re-translating the fence from the recorded
   * vector. Refused when generation 0 never named a thread: there is nothing
   * to resume, and `--last` would pick whatever thread is newest.
   */
  protected override _cliResumeArgv(
    command: readonly string[],
    baseCliArgs: readonly string[],
    record: Omit<SessionRecord, "argv">,
  ): readonly string[] | Failure {
    const thread = this.#adoptedThread(record.session_id);
    if (thread === null) {
      return refused(
        `session '${record.session_id}' has no thread.started in its first transcript, ` +
          "so there is no Codex thread to resume",
      );
    }
    const fence = translateFence(record.cli_args);
    if (typeof fence === "string") {
      return refused(`session '${record.session_id}': ${fence}`);
    }
    this.#translations.set(record.session_id, fence);
    return [
      ...command,
      "exec",
      "resume",
      ...EXEC_FLAGS,
      ...this.#configArgs(fence, record),
      ...baseCliArgs,
      thread,
      "-",
    ];
  }

  protected override _cliPromptInput(prompt: string): string | null {
    return prompt;
  }

  protected override _cliEnv(record: SessionRecord): Readonly<Record<string, string>> {
    return { CODEX_HOME: this.#homeOf(record.session_id) };
  }

  /**
   * Render the per-session home and prove the profile holds (D-1114
   * rule 4): `true` must run, a write outside the writable roots must fail and
   * leave nothing, and a read of the operator's `auth.json` must fail.
   * The credential link is made last, so a refused spawn never gets one.
   */
  protected override _cliPrepareSpawn(record: SessionRecord, run: CliProbeRunner): Failure | null {
    const sessionId = record.session_id;
    const fence = this.#translations.get(sessionId);
    this.#translations.delete(sessionId);
    if (fence === undefined) {
      return refused(`session '${sessionId}' reached its spawn with no translated fence`);
    }
    // A denial that CONTAINS a write root cannot be kept by a profile whose
    // root entry grants write (and read) beneath it, and Claude's sandbox would
    // deny those writes; the lap is refused rather than widened. Read denials
    // too (#223): Codex resolves the more specific entry, so the root stays
    // readable under a denied parent.
    const { roots } = effectiveWriteRoots(fence, record.workspace);
    const readDenials = [
      ...fence.denyRead,
      ...fence.readRules.flatMap((rule) => readDenyPaths(rule, roots) ?? []),
    ];
    // A glob is asked whether it matches a write root or any directory above
    // one (`/home/*` matches `/home/u`, above the workspace), by the fence's
    // matcher, whose `*` crosses `/` and so matches at least what Codex's does.
    for (const glob of readDenials.filter((path) => /[*?[\]]/.test(path))) {
      const covered = roots
        .flatMap((root) => [root, realOf(root)])
        .flatMap((root) => {
          const chain: string[] = [];
          for (let at = resolve(root); ; at = dirname(at)) {
            chain.push(at);
            if (dirname(at) === at) {
              return chain;
            }
          }
        })
        .find((dir) => fnmatchcase(dir, glob));
      if (covered !== undefined) {
        return refused(
          `the fence denies reads under ${glob}, which matches ${covered}, the workspace, a git ` +
            "directory the worker must write or a directory above one; a Codex permission " +
            "profile cannot keep that",
        );
      }
    }
    for (const [denials, verb] of [
      [fence.denyWrite, "writes"],
      [readDenials.filter((path) => !/[*?[\]]/.test(path)), "reads"],
    ] as const) {
      for (const path of denials) {
        for (const root of roots) {
          const relation = relationOf(path, root);
          if (relation === null) {
            return refused(
              `the fence denies ${verb} under ${path}, and it and ${root} are not in the ` +
                "same place by their real paths as by their spelling; a Codex permission " +
                "profile cannot be checked to keep that",
            );
          }
          if (relation === "over") {
            return refused(
              `the fence denies ${verb} under ${path}, which contains ${record.workspace} or a ` +
                "git directory the worker must write; a Codex permission profile cannot keep that",
            );
          }
        }
      }
    }
    const home = this.#homeOf(sessionId);
    const hookLog = join(
      this.#sessionDir(sessionId),
      `hook-${paddedGeneration(record.generation)}.jsonl`,
    );
    const hookCommand = [
      quote(fence.python),
      quote(join(dirname(fence.hookScript), "codex_hook.mjs")),
      "--role",
      quote(fence.role),
      "--fence",
      quote(fence.fencePath),
      "--mcp-server",
      quote(fence.mcpName),
      "--log",
      quote(hookLog),
    ].join(" ");
    const hooks = {
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: hookCommand, timeout: HOOK_TIMEOUT_SECONDS }],
          },
        ],
      },
    };
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      chmodSync(home, 0o700);
      // Codex writes project trust into it even under --ignore-user-config
      // (D-1114 M6), and `codex sandbox` below does read it.
      rmSync(join(home, "config.toml"), { force: true });
      writeFileSync(join(home, "hooks.json"), `${JSON.stringify(hooks)}\n`, "utf8");
    } catch (exc) {
      return refused(`the Codex home ${home} could not be prepared: ${String(exc)}`);
    }
    // Codex runs the call when its hook exits 0 with nothing to say, exits 1,
    // or cannot start (D-1114 M4), so an interpreter that is not Node -- or
    // any hook that does not deny -- is a lap with no allowlist at all. The
    // rendered hook is asked once, with no event, and must deny (#223).
    const probeLog = join(this.#sessionDir(sessionId), "hook-probe.jsonl");
    let answer: { readonly status: number; readonly stdout: Buffer } | null = null;
    try {
      answer = sessionRuntime.runProbe(
        [
          fence.python,
          join(dirname(fence.hookScript), "codex_hook.mjs"),
          "--role",
          fence.role,
          "--fence",
          fence.fencePath,
          "--mcp-server",
          fence.mcpName,
          "--log",
          probeLog,
        ],
        HOOK_TIMEOUT_SECONDS * 1000,
      );
    } catch {
      answer = null;
    }
    rmSync(probeLog, { force: true });
    if (answer?.status !== 2 || !String(answer.stdout).includes('"permissionDecision":"deny"')) {
      return refused(
        `the hook rendered for session '${sessionId}' (${fence.python} codex_hook.mjs) did not ` +
          "deny an empty event; a Codex lap whose hook does not deny runs every call",
      );
    }

    const sandbox = [
      "sandbox",
      "-C",
      record.workspace,
      "-c",
      `permissions=${toml(this.#profile(fence, record.workspace))}`,
      "-P",
      PROFILE,
      "--",
    ];
    const env = this.#probeEnv(home);
    const up = run([...sandbox, "true"], env);
    if (up instanceof Failure) {
      return refused(
        `the Codex sandbox cannot run 'true' under session '${sessionId}''s profile: ${up.detail}`,
      );
    }
    const marker = join(this.#sessionDir(sessionId), "sandbox-probe");
    const write = run([...sandbox, "touch", marker], env);
    const wrote = existsSync(marker);
    rmSync(marker, { force: true });
    if (!exitedNonZero(write) || wrote) {
      return refused(
        `the Codex sandbox let session '${sessionId}''s profile write outside its writable ` +
          "roots, or could not be asked; the fence's write boundary does not hold",
      );
    }
    const operatorAuth = join(this.#codexHome, "auth.json");
    const read = run([...sandbox, "cat", operatorAuth], env);
    if (!exitedNonZero(read)) {
      return refused(
        `the Codex sandbox let session '${sessionId}''s profile read ${operatorAuth}, or ` +
          "could not be asked; the fence's read denials do not hold",
      );
    }

    // A LINK to the operator's file, never a copy (Codex review round 2). A
    // copy at rest under this state root is readable to a lap whose state root
    // is a sibling (`lap perform` derives one per run under a shared parent),
    // which this profile's denials cannot name; the link's target is the real
    // path every Codex lap's profile denies, so reading it through the link
    // fails the same way from any lap (measured on the real sandbox). It also
    // keeps one credential: a refresh Codex writes lands in the operator's
    // file, not in a copy that drifts from it.
    //
    // Windows copies instead: a symlink there needs a privilege a runner may
    // not hold, and Codex's Windows sandbox is unmeasured (D-1114), so nothing
    // this profile says about Windows is claimed.
    try {
      const auth = join(home, "auth.json");
      rmSync(auth, { force: true });
      if (process.platform === "win32") {
        copyFileSync(operatorAuth, auth);
      } else {
        symlinkSync(realpathSync(operatorAuth), auth);
      }
    } catch (exc) {
      return refused(`the operator's Codex credentials could not be linked: ${String(exc)}`);
    }
    return null;
  }

  // -- identity and the terminal event --------------------------------------

  protected override _cliIdentityOf(event: Readonly<Record<string, unknown>>): unknown {
    return threadIdOf(event);
  }

  /**
   * The thread generation 0 adopted: the first `thread.started` of
   * `events-000.jsonl`, derived and never stored. For generation 0 that is
   * `events` itself; `""` while no event has named one, when there is nothing
   * to compare it with.
   */
  protected override _cliExpectedIdentity(
    record: SessionRecord,
    events: readonly Record<string, unknown>[],
  ): string {
    const adopted =
      record.generation === 0 ? firstThreadId(events) : this.#adoptedThread(record.session_id);
    return adopted ?? "";
  }

  protected override _cliIsTerminal(event: Readonly<Record<string, unknown>>): boolean {
    const type = field(event, "type");
    return type === "turn.completed" || type === "turn.failed";
  }

  protected override _cliTerminalWords(event: Readonly<Record<string, unknown>>): CliTerminalWords {
    const type = field(event, "type");
    return { terminalReason: type, subtype: null, isError: type === "turn.failed" };
  }

  // -- the turn's facts ------------------------------------------------------

  /**
   * The report, spend, commands and denials of the verified turn, and the
   * post-turn checks that refuse it (D-1114 rule 7, its count as D-1117):
   *
   * - the rollout's `session_meta` must name the adopted thread, or it is an
   *   identity incident;
   * - its last `turn_context` must show `approval_policy` never, a
   *   `workspace-write` sandbox without network, and the `fence` profile --
   *   the proof the `-c` configuration was what ran;
   * - every sub-agent call must have been denied by the hook;
   * - the hook log must have at least one line per call that could have fired
   *   the hook, because an untrusted or missing hook is skipped silently
   *   (D-1114 M4); only a tool-free script, `wait` and a `write_stdin` that
   *   writes nothing are exempt.
   */
  protected override _cliTurnFacts(
    record: SessionRecord,
    events: readonly Record<string, unknown>[],
    _lineNumbers: readonly number[],
    terminal: Readonly<Record<string, unknown>>,
  ): CliTurnFacts | Failure {
    const uninterpretable = (detail: string): Failure =>
      new Failure(
        FailureKind.UNINTERPRETABLE_RESPONSE,
        `session '${record.session_id}' generation ${record.generation}: ${detail}`,
      );
    const thread = this._cliExpectedIdentity(record, events);

    let body: unknown;
    for (const event of events.slice(0, events.lastIndexOf(terminal as Record<string, unknown>))) {
      const item = field(event, "item");
      if (field(event, "type") === "item.completed" && field(item, "type") === "agent_message") {
        body = field(item, "text");
      }
    }

    const rollout = this.#rollout(record.session_id, thread);
    if (rollout === null) {
      return uninterpretable(
        `no single rollout for thread '${thread}' under the session's CODEX_HOME, so the ` +
          "configuration the turn ran under cannot be verified",
      );
    }
    const meta = rollout.find((entry) => field(entry.value, "type") === "session_meta");
    const metaId = field(field(meta?.value, "payload"), "id");
    if (metaId !== thread) {
      return new Failure(
        FailureKind.IDENTITY_INCIDENT,
        `identity incident: session '${record.session_id}' adopted Codex thread '${thread}', ` +
          `but its rollout's session_meta names ${JSON.stringify(metaId ?? null)}`,
        { expected: thread, reported: metaId ?? null },
      );
    }
    const started = rollout.findLastIndex(
      (entry) => field(field(entry.value, "payload"), "type") === "task_started",
    );
    const turn = rollout.slice(Math.max(started, 0));
    const payloadsOf = (type: string) =>
      turn
        .filter((entry) => field(entry.value, "type") === type)
        .map((entry) => ({ line: entry.line, payload: field(entry.value, "payload") }));

    const context = payloadsOf("turn_context").at(-1)?.payload;
    const policy = field(context, "sandbox_policy");
    if (
      field(context, "approval_policy") !== "never" ||
      field(policy, "type") !== "workspace-write" ||
      field(policy, "network_access") !== false ||
      field(field(context, "active_permission_profile"), "id") !== PROFILE
    ) {
      return uninterpretable(
        "the rollout's turn_context does not show approval_policy never, a workspace-write " +
          `sandbox without network and the '${PROFILE}' profile; the fence did not run as rendered`,
      );
    }

    const responses = payloadsOf("response_item");
    const calls: { line: number; id: unknown; command: string; name: string; input: string }[] = [];
    const outputs = new Map<unknown, string>();
    for (const { line, payload } of responses) {
      const type = field(payload, "type");
      const namespace = field(payload, "namespace");
      const name = `${typeof namespace === "string" ? namespace : ""}${String(field(payload, "name"))}`;
      if (type === "custom_tool_call") {
        const input = field(payload, "input");
        calls.push({
          line,
          id: field(payload, "call_id"),
          command: `${name} ${String(input)}`,
          name,
          input: String(input),
        });
      } else if (type === "function_call") {
        const input = field(payload, "arguments");
        calls.push({
          line,
          id: field(payload, "call_id"),
          command: `${name} ${String(input)}`,
          name,
          input: String(input),
        });
      } else if (type === "custom_tool_call_output" || type === "function_call_output") {
        const output = field(payload, "output");
        const text = Array.isArray(output)
          ? output
              .map((part: unknown) => field(part, "text"))
              .filter((part): part is string => typeof part === "string")
              .join("\n")
          : typeof output === "string"
            ? output
            : "";
        outputs.set(field(payload, "call_id"), text);
      }
    }
    const commands: TurnCommand[] = calls.map((call) => ({
      index: call.line,
      command: call.command,
      output: outputs.get(call.id) ?? "",
      isError: false,
    }));

    const hookLog = readJsonLines(
      join(
        this.#sessionDir(record.session_id),
        `hook-${paddedGeneration(record.generation)}.jsonl`,
      ),
    );
    const denied = (hookLog ?? []).filter((entry) => entry.value["denied"] === true);
    for (const call of calls.filter((c) => c.name.startsWith("collaboration"))) {
      const refusals = denied.filter((entry) => entry.value["tool_name"] === call.name).length;
      const made = calls.filter((c) => c.name === call.name).length;
      if (refusals < made) {
        return uninterpretable(
          `the turn called ${call.name} and the hook did not deny it; a Codex worker's ` +
            "sub-agents are outside the fence",
        );
      }
    }
    // A lower bound, not a pairing: a code-mode `exec` call runs any number of
    // tool calls (or none) and the rollout does not record the inner ones, so a
    // call cannot be matched to its log line. So every call needs a log line of
    // its own unless it provably could not fire the hook: a script that fails
    // may have called a tool first, and a script can reach a tool by a name no
    // pattern lists (`tools["exec_command"]`), so the exemption is an
    // allowlist, not a list of hooked names. An empty log is then no refusal
    // of its own: a turn of tool-free calls has nothing to show.
    const hooked = calls.filter((call) => !hookFree(call.name, call.input)).length;
    if (hooked > (hookLog?.length ?? 0)) {
      return uninterpretable(
        `the turn made ${hooked} tool call(s) the hook must have seen and the hook log has ` +
          `${hookLog?.length ?? 0} line(s), so the hook did not run for every call; the turn ` +
          "is not accepted",
      );
    }
    // No hook log here means no call that could fire the hook (the case above
    // refused the other), and the rollout records every call before it runs:
    // the answer is "none denied", which Claude's report gives as `[]` too, not
    // "cannot say".
    const permissionDenials: DeniedToolCall[] = denied.map((entry) => ({
      toolName: String(entry.value["tool_name"]),
      toolInput: isRecord(entry.value["tool_input"]) ? entry.value["tool_input"] : {},
    }));

    const usage = field(terminal, "usage");
    const model = field(context, "model") ?? field(field(meta?.value, "payload"), "model") ?? null;
    const complete = payloadsOf("event_msg")
      .filter((entry) => field(entry.payload, "type") === "task_complete")
      .at(-1)?.payload;
    return {
      body,
      permissionDenials: Object.freeze(permissionDenials),
      spend: {
        totalCostUsd: null,
        numTurns: null,
        durationMs: numberOrNull(field(complete, "duration_ms")),
        model: typeof model === "string" ? model : null,
        inputTokens: numberOrNull(field(usage, "input_tokens")),
        cachedInputTokens: numberOrNull(field(usage, "cached_input_tokens")),
        cacheWriteInputTokens: numberOrNull(field(usage, "cache_write_input_tokens")),
        outputTokens: numberOrNull(field(usage, "output_tokens")),
        reasoningOutputTokens: numberOrNull(field(usage, "reasoning_output_tokens")),
      },
      commands: Object.freeze(commands),
    };
  }

  // -- private ---------------------------------------------------------------

  #sessionDir(sessionId: string): string {
    return join(this.#stateRoot, sessionId);
  }

  /** `<stateRoot>/codex-homes+`: `+` is outside every session id's alphabet. */
  #homesRoot(): string {
    return join(this.#stateRoot, "codex-homes+");
  }

  #homeOf(sessionId: string): string {
    return join(this.#homesRoot(), sessionId);
  }

  #probeEnv(home: string): ProbeOptions {
    return { env: { ...process.env, CODEX_HOME: home } };
  }

  #translationOf(sessionId: string): CodexFence {
    const fence = this.#translations.get(sessionId);
    if (fence === undefined) {
      // `_cliSessionArgs` runs first on every start; reaching here without it
      // is a defect in the seam order, not a condition to report.
      throw new Error(`no translated fence for session '${sessionId}'`);
    }
    return fence;
  }

  /** The thread `events-000.jsonl` adopted, or `null`. */
  #adoptedThread(sessionId: string): string | null {
    const lines = readJsonLines(join(this.#sessionDir(sessionId), "events-000.jsonl"));
    return lines === null ? null : firstThreadId(lines.map((entry) => entry.value));
  }

  /**
   * The one `sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl` under the session's
   * home, parsed, or `null` for none or several.
   */
  #rollout(
    sessionId: string,
    thread: string,
  ): { line: number; value: Record<string, unknown> }[] | null {
    if (thread === "") {
      return null;
    }
    const found: string[] = [];
    const walk = (directory: string, depth: number): void => {
      let names: string[];
      try {
        names = readdirSync(directory);
      } catch {
        return;
      }
      for (const name of names) {
        if (depth < 3) {
          walk(join(directory, name), depth + 1);
        } else if (name.startsWith("rollout-") && name.endsWith(`-${thread}.jsonl`)) {
          found.push(join(directory, name));
        }
      }
    };
    walk(join(this.#homeOf(sessionId), "sessions"), 0);
    return found.length === 1 ? readJsonLines(found[0] as string) : null;
  }

  /**
   * The permission profile (D-1114 rule 2): read everywhere, write in the
   * workspace and the git metadata roots, the fence's write denials read-only
   * where they fall inside a write root, and its read denials, every
   * session's `CODEX_HOME` (their common parent) and the operator's Codex
   * home -- by the path given and by the real path its `auth.json` resolves
   * to, which is what the per-session link points at -- denied. Denials are written
   * last so a path named twice ends on the stricter access.
   */
  #profile(fence: CodexFence, workspace: string): Record<string, unknown> {
    const filesystem: Record<string, unknown> = {
      glob_scan_max_depth: GLOB_SCAN_MAX_DEPTH,
      ":root": "read",
    };
    const { roots, pinned } = effectiveWriteRoots(fence, workspace);
    for (const root of roots) {
      filesystem[root] = "write";
    }
    for (const path of pinned) {
      filesystem[path] = "read";
    }
    for (const path of fence.denyWrite) {
      if (roots.some((root) => within(path, root))) {
        filesystem[path] = "read";
      }
    }

    for (const path of fence.denyRead) {
      filesystem[path] = "deny";
    }
    for (const rule of fence.readRules) {
      for (const path of readDenyPaths(rule, roots) ?? []) {
        filesystem[path] = "deny";
      }
    }
    filesystem[this.#homesRoot()] = "deny";
    filesystem[this.#codexHome] = "deny";
    const realAuthHome = realDirectoryOf(join(this.#codexHome, "auth.json"));
    if (realAuthHome !== null) {
      filesystem[realAuthHome] = "deny";
    }
    return { [PROFILE]: { filesystem } };
  }

  /** Every `-c` / `--disable` the spawn is configured by (D-1114 rule 2). */
  #configArgs(fence: CodexFence, record: Omit<SessionRecord, "argv">): readonly string[] {
    const workspace = record.workspace;
    const lastMessage = join(
      this.#sessionDir(record.session_id),
      // Codex writes it and nothing reads it: it is here so the child's
      // command line carries continuo's UUID, which orphan liveness checks.
      `last-message-${paddedGeneration(record.generation)}-${record.claude_session_uuid}.txt`,
    );
    const overrides: readonly (readonly [string, unknown])[] = [
      ["approval_policy", "never"],
      ["default_permissions", PROFILE],
      ["permissions", this.#profile(fence, workspace)],
      ["web_search", "disabled"],
      ["shell_environment_policy", { inherit: "core", set: { ...fence.env, ...NEUTRAL_ENV } }],
      [
        "mcp_servers",
        {
          [fence.mcpName]: {
            command: fence.mcpCommand,
            args: fence.mcpArgs,
            env: fence.mcpEnv,
            default_tools_approval_mode: "approve",
          },
        },
      ],
      ["projects", { [workspace]: { trust_level: "untrusted" } }],
    ];
    return [
      ...overrides.flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`]),
      ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
      "-o",
      lastMessage,
    ];
  }
}
