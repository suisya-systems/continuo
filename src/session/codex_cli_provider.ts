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
 *   OS sandbox denies the reads Claude's sandbox denies (measure2-read,
 *   measure3 Q1). `CODEX_HOME` and the operator's Codex home are denied too.
 * - `S.hooks`' deny hook becomes `codex_hook.mjs` beside it, the allowlisting
 *   hook a Codex worker needs because Codex has no permission mode behind its
 *   hook (see that file's header).
 * - `S.env` becomes `shell_environment_policy.set`, and `P`'s one server
 *   becomes `mcp_servers`.
 *
 * Anything this does not recognise refuses the spawn: a fence layer a CLI
 * cannot enforce is a lap that does not run (the owner's decision on #220),
 * and the day the Claude fence grows a layer, a Codex lap refuses until
 * someone translates it.
 *
 * ## Config arrives on the command line and nowhere else
 *
 * `--ignore-user-config --strict-config --ignore-rules` and every setting as a
 * `-c` override (measure3 Q1/Q2): no `config.toml` is rendered, the target
 * repository's `.codex/` and `.rules` are not loaded, and a key this Codex
 * build does not know is a startup error rather than a silently ignored line.
 * The per-session `CODEX_HOME` holds only `auth.json` (a 0600 copy, never a
 * link, so the operator's file is not readable through it) and `hooks.json`,
 * and both are rewritten before every spawn; the `config.toml` Codex scribbles
 * trust entries into is removed. It sits beside the session directory, not in
 * it (`codex-homes+/<id>`, a name no session id can spell), because the session
 * directory is taken down flat and the home holds the rollout `resume` needs.
 * Every session's home shares that one parent, and the profile denies the
 * parent: a copy of `auth.json` outlives its session, and one lap's child
 * could otherwise read another's (a sibling's home is under `:root` read).
 *
 * ## What is weaker than Claude, stated where it is weaker
 *
 * - **Identity is adopted, not committed.** Codex 0.153.4 has no flag to name
 *   a thread before it starts, so generation 0 adopts the first
 *   `thread.started` it reports and every later event must agree with it;
 *   a resume must name the same thread. The rollout's `session_meta` is a
 *   second witness. Orphan recognition is unchanged: the command line carries
 *   continuo's own UUID in the `-o` path.
 * - **`write_stdin` does not fire the hook** (measure3 Q3), so an
 *   `allowed_bash` entry whose program reads commands from stdin would escape
 *   the allowlist; the interpreters and shells in {@link STDIN_PROGRAMS} are
 *   refused outright. Another program that does so is bounded only by the OS
 *   sandbox.
 * - **The D-1112 socket probe does not apply**: Codex's sandbox came up and
 *   enforced under the AF_UNIX-EPERM filter (understand-codex section 4). Its
 *   place is taken by `codex sandbox` self-tests that prove the denials hold.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";

import { quote, split as shlexSplit } from "../fencing/shlex.js";
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
import type { ProbeOptions } from "./runtime.js";

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
 * remove sub-agents (measure3 Q4): the hook and the post-turn check hold that.
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
 * Programs that execute what arrives on their stdin (design-final O5). A Bash
 * allow entry naming one is refused for a Codex lap, because `write_stdin`
 * reaches a running process without the hook seeing it. Compared after a
 * trailing version is dropped, so `python3.12` and `node22` are caught.
 */
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
]);

/** The only permission mode the materializer renders for a `-p` child (D-0081). */
const FENCE_PERMISSION_MODE = "acceptEdits";

/** The permission profile's name, in `-c` and in the post-turn check. */
const PROFILE = "fence";

/** Depth Codex expands a `**` deny glob to at spawn (measure2-read row 4). */
const GLOB_SCAN_MAX_DEPTH = 6;

/** Seconds Codex gives the hook; `codex_hook.mjs` denies on its own at 20. */
const HOOK_TIMEOUT_SECONDS = 30;

/**
 * The name Codex gives an MCP server's tools, `mcp__<this>__<tool>`, for the
 * server the fence names. The one place that spelling lives: measured only for
 * a server named `x` (measure2-hook section 2), so whether Codex rewrites the
 * hyphen in `continuo-messagebus` is confirmed on the first real lap, and a
 * wrong guess fails closed (the hook denies every endpoint call).
 */
function codexToolServerName(configName: string): string {
  return configName;
}

/** The fence as this provider reads it off `S` and `P`. */
interface CodexFence {
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

function within(path: string, root: string): boolean {
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

/** `Read(x)` to the profile paths it denies, or `null` for a shape not translated. */
function readDenyPaths(rule: string, workspace: string): readonly string[] | null {
  if (rule.startsWith("~/")) {
    return [join(homedir(), rule.slice(2))];
  }
  if (isAbsolute(rule)) {
    return [rule];
  }
  if (rule.startsWith("**/") && !rule.slice(3).includes("/")) {
    return [`${workspace}/${rule}`];
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
 */
function translateFence(cliArgs: readonly string[]): CodexFence | string {
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
    if (!isStringArray(entries) || !entries.every((entry) => isAbsolute(entry))) {
      return `${settingsPath}'s sandbox.filesystem.${key} is not a list of absolute paths`;
    }
    paths[key] = entries;
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
    !hasOnlyKeys(group as Record<string, unknown>, ["matcher", "hooks"]) ||
    field(group, "matcher") !== "*" ||
    !hasOnlyKeys(handler as Record<string, unknown>, ["type", "command"]) ||
    field(handler, "type") !== "command" ||
    tokens.length !== 6 ||
    tokens[2] !== "--role" ||
    tokens[4] !== "--fence" ||
    basename(tokens[1] as string) !== "hook.mjs"
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
  const env = settings["env"] ?? {};
  if (!isStringRecord(env)) {
    return `${settingsPath}'s env is not a mapping of strings`;
  }

  const allow = (permissions["allow"] ?? []) as string[];
  for (const entry of allow) {
    const spec = entry.startsWith("Bash(") && entry.endsWith(")") ? entry.slice(5, -1) : null;
    const program = spec?.split(/[ \t:]/)[0] ?? "";
    if (STDIN_PROGRAMS.has(basename(program).replace(/[0-9.]+$/, ""))) {
      return (
        `the allow entry ${JSON.stringify(entry)} runs a program that executes its stdin, ` +
        "and a Codex worker's write_stdin reaches a running process without the hook " +
        "seeing it; interpreters and shells are not allowed_bash entries for a Codex lap"
      );
    }
  }
  const readRules: string[] = [];
  for (const entry of (permissions["deny"] ?? []) as string[]) {
    if (entry.startsWith("Read(") && entry.endsWith(")")) {
      const rule = entry.slice(5, -1);
      if (readDenyPaths(rule, "/") === null) {
        return `the deny rule ${JSON.stringify(entry)} has no Codex permission-profile spelling`;
      }
      readRules.push(rule);
    }
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

  return {
    python: tokens[0] as string,
    hookScript,
    role: tokens[3] as string,
    fencePath: tokens[5] as string,
    env,
    writeRoots: paths["additionalDirectories"] ?? [],
    denyRead: paths["denyRead"] ?? [],
    denyWrite: paths["denyWrite"] ?? [],
    readRules,
    mcpName: names[0] as string,
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
    super(stateRoot, options);
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
   * worktree exists (design-final O3). A Codex whose sandbox cannot come up
   * runs no command and still reports a finished turn (understand-codex
   * section 4), so this is where that is found out cheaply. `codex sandbox`
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
      // The prompt is on stdin (`-`, measure3 Q6): a prompt argument is read
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
   * Render the per-session home and prove the profile holds (design section
   * 6.4): `true` must run, a write outside the writable roots must fail and
   * leave nothing, and a read of the operator's `auth.json` must fail.
   * Credentials are copied in last, so a refused spawn leaves none behind.
   */
  protected override _cliPrepareSpawn(record: SessionRecord, run: CliProbeRunner): Failure | null {
    const sessionId = record.session_id;
    const fence = this.#translations.get(sessionId);
    this.#translations.delete(sessionId);
    if (fence === undefined) {
      return refused(`session '${sessionId}' reached its spawn with no translated fence`);
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
      quote(codexToolServerName(fence.mcpName)),
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
      // (measure3 Q2), and `codex sandbox` below does read it.
      rmSync(join(home, "config.toml"), { force: true });
      writeFileSync(join(home, "hooks.json"), `${JSON.stringify(hooks)}\n`, "utf8");
    } catch (exc) {
      return refused(`the Codex home ${home} could not be prepared: ${String(exc)}`);
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

    try {
      const auth = join(home, "auth.json");
      rmSync(auth, { force: true });
      copyFileSync(operatorAuth, auth);
      chmodSync(auth, 0o600);
    } catch (exc) {
      return refused(`the operator's Codex credentials could not be copied: ${String(exc)}`);
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
   * post-turn checks that refuse it (design section 6.5, section 7):
   *
   * - the rollout's `session_meta` must name the adopted thread, or it is an
   *   identity incident;
   * - its last `turn_context` must show `approval_policy` never, a
   *   `workspace-write` sandbox without network, and the `fence` profile --
   *   the proof the `-c` configuration was what ran;
   * - a turn that made a tool call must have a hook log, because an untrusted
   *   or missing hook is skipped silently (measure2-hook section 3);
   * - every sub-agent call must have been denied by the hook.
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
    const calls: { line: number; id: unknown; command: string; name: string }[] = [];
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
        });
      } else if (type === "function_call") {
        const input = field(payload, "arguments");
        calls.push({
          line,
          id: field(payload, "call_id"),
          command: `${name} ${String(input)}`,
          name,
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
    if (calls.length > 0 && (hookLog === null || hookLog.length === 0)) {
      return uninterpretable(
        `the turn made ${calls.length} tool call(s) and the hook log is empty, so the ` +
          "fence's hook did not run; the turn is not accepted",
      );
    }
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
    // No hook log here means no tool call (the case above refused the other),
    // and the rollout records every call before it runs: the answer is "none
    // denied", which Claude's report gives as `[]` too, not "cannot say".
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
   * The permission profile (design section 5): read everywhere, write in the
   * workspace and the git metadata roots, the fence's write denials read-only
   * where they fall inside a write root, and its read denials, every
   * session's `CODEX_HOME` (their common parent: each holds a copy of the
   * credentials) and the operator's Codex home denied. Denials are written
   * last so a path named twice ends on the stricter access.
   */
  #profile(fence: CodexFence, workspace: string): Record<string, unknown> {
    const filesystem: Record<string, unknown> = {
      glob_scan_max_depth: GLOB_SCAN_MAX_DEPTH,
      ":root": "read",
    };
    const roots = [workspace, ...fence.writeRoots];
    for (const root of roots) {
      filesystem[root] = "write";
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
      for (const path of readDenyPaths(rule, workspace) ?? []) {
        filesystem[path] = "deny";
      }
    }
    filesystem[this.#homesRoot()] = "deny";
    filesystem[this.#codexHome] = "deny";
    return { [PROFILE]: { filesystem } };
  }

  /** Every `-c` / `--disable` the spawn is configured by (design-final O1). */
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
