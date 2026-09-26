/**
 * The Codex fence translation's shape table (issue #223, D-1118).
 *
 * `translateFence` reads a lap's fence -- `S` (the Claude settings) and `P`
 * (the MCP config) -- and either translates it into Codex's layers or refuses
 * the lap. D-1114's rule is that nothing is dropped: a shape Codex cannot
 * enforce refuses. {@link TABLE} is that rule written out. Each row is one
 * family of input shapes with its verdict and the Codex layer that enforces
 * it (translated) or the words of its refusal (refused).
 *
 * Three tests pin it:
 *
 * - **The partition.** A corpus of shapes, crossed from the forms each axis
 *   can take, goes through the real `translateFence`. Every shape must be
 *   claimed by a row (the first whose `claims` holds) and come out as that row
 *   says. A shape the translation accepts that no translated row claims --
 *   neither translated nor refused -- fails here. So does a row the corpus
 *   never reaches.
 * - **The examples.** Each row's example runs through `start` against the
 *   fake `codex`: a refusal with the row's words and nothing spawned, or a
 *   spawn whose profile carries what the row says.
 * - **The spawn rows.** Shapes whose verdict depends on the workspace, the
 *   links on disk or the hook itself are decided at the spawn, not in
 *   `translateFence`, and each has its own case.
 *
 * "Narrowed" in a layer means Codex gives less than Claude (an allow entry the
 * hook does not honour). That is not a dropped restriction.
 */

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import process from "node:process";

import { expect, test } from "vitest";
import { Fence, parsePermissionRule } from "../../src/fencing/rules.js";
import { readFence, writeFence } from "../../src/fencing/state.js";
import { codexCliSeams, translateFence } from "../../src/session/codex_cli_provider.js";
import { FailureKind } from "../../src/session/provider.js";
import { hookScriptForTest } from "../fencing/helpers/fence-cases.js";
import { patchSeam } from "../testkit/seams.js";
import {
  type Lap,
  lap,
  MCP_SERVER,
  profileOf,
  providerFor,
  publish,
  refusalOf,
  SESSION,
  start,
  withBranchRef,
} from "./helpers/codex-lap.js";
import { spawnLog } from "./helpers/fake-cli.js";
import { spawned } from "./helpers/session-cases.js";

type Axis =
  | "allow"
  | "deny"
  | "denyRead"
  | "denyWrite"
  | "additionalDirectories"
  | "env"
  | "settings"
  | "mcp";

interface Row {
  readonly axis: Axis;
  readonly shape: string;
  readonly claims: (value: string) => boolean;
  readonly verdict: "translated" | "refused";
  /** Translated: the Codex layer that enforces it. Refused: words of the refusal. */
  readonly layer: string;
  /** One shape of the family, with `{root}` for the lap's root. */
  readonly example: string;
  /** Translated: a line the spawn's `permissions=` profile must carry. */
  readonly profile?: (l: Lap) => string;
}

// --------------------------------------------------------------------------
// The shape predicates, written from the rule each row states
// --------------------------------------------------------------------------

/** No `.` / `..` / empty segment after the root, and no brace. */
function plain(path: string): boolean {
  return (
    !/[{}]/.test(path) &&
    path.split(/[\\/]/).every((part, index) => index === 0 || !["", ".", ".."].includes(part))
  );
}

const GLOB = /[*?[\]]/;

function absPlain(path: string): boolean {
  return isAbsolute(path) && plain(path);
}

/** A deny entry as the fence's parser reads it, or `null` when it cannot. */
function rule(entry: string): { tool: string; spec: string; whole: boolean } | null {
  try {
    const { tool, spec } = parsePermissionRule(entry);
    return { tool, spec, whole: !entry.includes("(") };
  } catch {
    return null;
  }
}

function denies(test: (r: { tool: string; spec: string; whole: boolean }) => boolean) {
  return (entry: string) => {
    const r = rule(entry);
    return r !== null && test(r);
  };
}

/** A home-relative or absolute path, as a Read / Edit rule's spec names one. */
function specPath(spec: string): string {
  return spec.startsWith("~/") ? join(homedir(), spec.slice(2)) : spec;
}

/** The program a `Bash(...)` allow entry names, the way the hook reads it. */
function programOf(entry: string): string {
  const spec = entry.slice(5, -1);
  const named = spec.endsWith(":*") ? spec.slice(0, -2) : spec;
  return named.replace(/^[ \t]+/, "").split(/[ \t]/)[0] ?? "";
}

const bashAllow = (entry: string) => entry.startsWith("Bash(") && entry.endsWith(")");
const INTERPRETERS =
  /^(?:sh|bash|zsh|dash|fish|node|nodejs|python|perl|ruby|deno|bun|npx|env|xargs|ksh|mksh|csh|tcsh|pwsh|php|lua|irb|ash|busybox|tclsh|expect|sqlite|gdb|pypy|ipython|psql|mysql|ed|ex|vi|vim|nvim|dc|gnuplot|R|Rscript|julia|awk|gawk|mawk|nawk|sed|timeout|nice|nohup|stdbuf|time|setsid|script|sudo|doas|chroot|unshare|strace|ltrace|ionice|taskset|chrt|flock|nsenter|watch|su|runuser|pkexec|systemd-run|firejail|fakeroot|parallel|command|exec|builtin|eval|source|\.)$/;
const READ_WRITE_OTHERS = ["Grep", "Glob", "LS", "NotebookRead", "NotebookEdit", "MultiEdit"];
const CODEX_TOOLS = ["apply_patch", "exec_command", "shell", "exec", "wait", "write_stdin"];
const LAP_SERVER = `mcp__${MCP_SERVER}`;
const STEERING =
  /^(?:PATH|HOME|SHELL|IFS|ENV|BASH_ENV|ZDOTDIR|CODEX_HOME|NODE_OPTIONS|NODE_PATH|EDITOR|VISUAL|PAGER|MANPAGER|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|LESSOPEN|LESSCLOSE|RUBYOPT|PYTHON\w*|PERL\w*|(?:LD|DYLD|GIT|XDG|NPM_CONFIG)_\w*)$/;

// An absolute path reaches the profile as the fence wrote it, separators
// included: `{root}/x` is `${l.root}/x` there, not `join(l.root, "x")` (win32).
const profileHas = (path: (l: Lap) => string, access: string) => (l: Lap) =>
  `${JSON.stringify(path(l))} = "${access}"`;
const workspaceOf = (l: Lap) => join(l.root, "workspaces", SESSION);

// --------------------------------------------------------------------------
// The table
// --------------------------------------------------------------------------

const TABLE: readonly Row[] = [
  // -- S.permissions.allow: grants; the Codex hook is default-deny -----------
  {
    axis: "allow",
    shape: "an entry that is not Bash(...) (Read, Edit, WebFetch, Task, mcp__..., bare Bash)",
    claims: (e) => !bashAllow(e),
    verdict: "translated",
    layer: "narrowed: codex_hook.mjs admits only Bash, apply_patch and the lap's server",
    example: "WebFetch",
  },
  {
    axis: "allow",
    shape: "Bash(...) whose program is not plain characters (quoted, globbed, empty)",
    claims: (e) => !/^[A-Za-z0-9_./+-]+$/.test(programOf(e)),
    verdict: "refused",
    layer: "cannot be checked against",
    example: "Bash('python3' x.py)",
  },
  {
    axis: "allow",
    shape: "Bash(...) running a program that executes its stdin, or runs its argument",
    claims: (e) => {
      const name = basename(programOf(e));
      return INTERPRETERS.test(name.replace(/[-0-9.]+$/, "") || name);
    },
    verdict: "refused",
    layer: "executes its stdin",
    example: "Bash(timeout 60 bash)",
  },
  {
    axis: "allow",
    shape: "Bash(...) using ? or [ ], a wildcard to the hook and a literal to Claude",
    claims: (e) => /[?[\]]/.test(e.slice(5, -1)),
    verdict: "refused",
    layer: "reads as a wildcard",
    example: "Bash(make [ab])",
  },
  {
    axis: "allow",
    shape: "Bash(<plain program> ...), exact, :* prefix (to a word) or * wildcard",
    claims: () => true,
    verdict: "translated",
    layer: "codex_hook.mjs allowlist (programOf equality + specMatches, :* ends at a word)",
    example: "Bash(git diff:*)",
  },

  // -- S.permissions.deny ----------------------------------------------------
  {
    axis: "deny",
    shape: "an entry the fence's parser cannot read",
    claims: (e) => rule(e) === null,
    verdict: "refused",
    layer: "cannot be parsed",
    example: "Bash(git log",
  },
  {
    axis: "deny",
    shape: "Bash(...) or bare Bash",
    claims: denies((r) => r.tool === "Bash"),
    verdict: "translated",
    layer: "codex_hook.mjs runs hook.mjs's rules on every admitted Bash call",
    example: "Bash(curl *)",
  },
  {
    axis: "deny",
    shape: "Read(~/<plain path>)",
    claims: denies(
      (r) => r.tool === "Read" && !r.whole && /^~\/./.test(r.spec) && plain(r.spec.slice(1)),
    ),
    verdict: "translated",
    layer: "permission profile: the path under the home directory is deny",
    example: "Read(~/.netrc)",
    profile: profileHas(() => join(homedir(), ".netrc"), "deny"),
  },
  {
    axis: "deny",
    shape: "Read(<absolute plain path>), a glob included",
    claims: denies((r) => r.tool === "Read" && !r.whole && absPlain(r.spec)),
    verdict: "translated",
    layer: "permission profile: the path is deny (a glob covers what exists at spawn, depth 6)",
    example: "Read({root}/secret)",
    profile: profileHas((l) => `${l.root}/secret`, "deny"),
  },
  {
    axis: "deny",
    shape: "Read(**/<one segment>)",
    claims: denies((r) => r.tool === "Read" && /^\*\*\/[^/{}]+$/.test(r.spec)),
    verdict: "translated",
    layer:
      "permission profile: <root>/**/<segment> is deny under the workspace and every write " +
      "root (depth 6, at spawn); a match outside every write root stays readable",
    example: "Read(**/*.key)",
    profile: profileHas((l) => `${workspaceOf(l)}/**/*.key`, "deny"),
  },
  {
    axis: "deny",
    shape: "Read(<one segment>), not ~, * or a dot segment",
    claims: denies(
      (r) =>
        r.tool === "Read" &&
        !r.whole &&
        !r.spec.includes("/") &&
        !r.spec.startsWith("~") &&
        !/[{}]/.test(r.spec) &&
        !["", "*", ".", ".."].includes(r.spec),
    ),
    verdict: "translated",
    layer: "permission profile: <workspace>/<segment> and <workspace>/**/<segment> are deny",
    example: "Read(.env)",
    profile: profileHas((l) => `${workspaceOf(l)}/**/.env`, "deny"),
  },
  {
    axis: "deny",
    shape: "any other Read: bare Read, Read(*), ~ or ~user, //x, relative with /, dot segments",
    claims: denies((r) => r.tool === "Read"),
    verdict: "refused",
    layer: "has no Codex permission-profile spelling",
    example: "Read(~root/.netrc)",
  },
  {
    axis: "deny",
    shape: "Edit / Write(<absolute or ~/ plain path, no glob>)",
    claims: denies(
      (r) =>
        (r.tool === "Edit" || r.tool === "Write") &&
        !r.whole &&
        absPlain(specPath(r.spec)) &&
        !GLOB.test(r.spec),
    ),
    verdict: "translated",
    layer:
      "codex_hook.mjs checks apply_patch as Write; the profile keeps shell writes " +
      "(read inside a write root, :root read outside, refused over one at spawn)",
    example: "Write({root}/elsewhere/x)",
  },
  {
    axis: "deny",
    shape: "any other Edit / Write: bare, relative, globbed",
    claims: denies((r) => r.tool === "Edit" || r.tool === "Write"),
    verdict: "refused",
    layer: "cannot be checked to keep it against a shell write",
    example: "Edit(**/src/**)",
  },
  {
    axis: "deny",
    shape: "Grep, Glob, LS, NotebookRead, NotebookEdit, MultiEdit, or a Codex tool name",
    claims: denies((r) => READ_WRITE_OTHERS.includes(r.tool) || CODEX_TOOLS.includes(r.tool)),
    verdict: "refused",
    layer: "has no Codex permission-profile spelling",
    example: "Grep(**/secrets/**)",
  },
  {
    axis: "deny",
    shape: "mcp__<lap server>__<tool>, exactly",
    claims: denies(
      (r) => new RegExp(`^${LAP_SERVER}__[A-Za-z0-9_]+$`).test(r.tool) && r.tool.length <= 64,
    ),
    verdict: "translated",
    layer: "codex_hook.mjs runs hook.mjs's rules on every call to the lap's server",
    example: `${LAP_SERVER}__ack`,
  },
  {
    axis: "deny",
    shape: "the lap's server whole, with a wildcard, or in Codex's _ spelling",
    claims: denies(
      (r) =>
        r.tool.startsWith("mcp__") &&
        (r.tool.slice(5).split("__")[0] ?? "").replaceAll("-", "_") ===
          MCP_SERVER.replaceAll("-", "_"),
    ),
    verdict: "refused",
    layer: "matches against no call",
    example: LAP_SERVER,
  },
  {
    axis: "deny",
    shape: "any other tool (WebFetch, Task, another server's tool, ...)",
    claims: () => true,
    verdict: "translated",
    layer: "codex_hook.mjs denies every tool it does not admit; web_search is disabled",
    example: "WebFetch",
  },

  // -- S.sandbox.filesystem --------------------------------------------------
  {
    axis: "denyRead",
    shape: "an absolute plain path, a glob included",
    claims: absPlain,
    verdict: "translated",
    layer: "permission profile: deny (a glob covers what exists at spawn, depth 6)",
    example: "{root}/secrets",
    profile: profileHas((l) => `${l.root}/secrets`, "deny"),
  },
  {
    axis: "denyWrite",
    shape: "an absolute plain path without a glob",
    claims: (p) => absPlain(p) && !GLOB.test(p),
    verdict: "translated",
    layer: "permission profile: read inside a write root, :root read outside",
    example: "{root}/elsewhere",
  },
  {
    axis: "denyWrite",
    shape: "an absolute plain path with a glob",
    claims: absPlain,
    verdict: "refused",
    layer: "is a glob",
    example: "{root}/*/protected",
  },
  {
    axis: "additionalDirectories",
    shape: "an absolute plain path",
    claims: absPlain,
    verdict: "translated",
    layer: "permission profile: write if a directory at spawn; a file is left out (narrowed)",
    example: "{root}/extra",
    profile: profileHas((l) => `${l.root}/extra`, "write"),
  },
  ...(["denyRead", "denyWrite", "additionalDirectories"] as const).map(
    (axis): Row => ({
      axis,
      shape: "relative, or with a '.', '..' or empty segment, or a brace",
      claims: () => true,
      verdict: "refused",
      layer: "spelled plainly",
      example: "{root}/a/../b",
    }),
  ),

  // -- S.env, S's keys, P ----------------------------------------------------
  {
    axis: "env",
    shape: "a plain name that steers nothing the hook admits by name",
    claims: (k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !STEERING.test(k.toUpperCase()),
    verdict: "translated",
    layer: "shell_environment_policy.set",
    example: "WORKER_DIR",
  },
  {
    axis: "env",
    shape: "PATH, HOME, SHELL, shell startup, loader, git or editor names, or not a plain name",
    claims: () => true,
    verdict: "refused",
    layer: "steers which program",
    example: "GIT_EXTERNAL_DIFF",
  },
  {
    axis: "settings",
    shape: "a top-level key outside permissionMode / permissions / sandbox / hooks / env",
    claims: () => true,
    verdict: "refused",
    layer: "a key the Codex translation does not know",
    example: "apiKeyHelper",
  },
  {
    axis: "mcp",
    shape: "one server named in letters, digits and -, not codex-apps",
    claims: (n) => /^[A-Za-z0-9-]+$/.test(n) && n.replaceAll("-", "_") !== "codex_apps",
    verdict: "translated",
    layer: "mcp_servers (the one server) + codex_hook.mjs's --mcp-server prefix",
    example: MCP_SERVER,
  },
  {
    axis: "mcp",
    shape: "a server name with any other character, or codex-apps",
    claims: () => true,
    verdict: "refused",
    layer: "is not letters, digits and - only",
    example: "codex_apps",
  },
];

// --------------------------------------------------------------------------
// The corpus: every axis crossed with the forms it can take
// --------------------------------------------------------------------------

const PATHS = [
  "{root}/x",
  "{root}/x/*",
  "{root}/**/x",
  "{root}/[a]",
  "{root}/{a,b}",
  "{root}/a/../b",
  "{root}/./b",
  "{root}/x/",
  "{root}//x",
  "x",
  "./x",
  "~/x",
];
const SPECS = [
  null,
  "*",
  "~",
  "~/x",
  "~/a/../b",
  "~root/x",
  "//x",
  ...PATHS,
  "a/b",
  "**/x",
  "**/a/b",
  "*.key",
  " x",
  "..",
  "git push *",
  "git log:*",
];
const DENY_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Bash",
  ...READ_WRITE_OTHERS,
  ...CODEX_TOOLS,
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  LAP_SERVER,
  `${LAP_SERVER}__poll`,
  `${LAP_SERVER.replaceAll("-", "_")}__poll`,
  `${LAP_SERVER}__*`,
  "mcp__other__x",
  "Foo",
];

const CORPUS: Readonly<Record<Axis, readonly string[]>> = {
  deny: [
    ...DENY_TOOLS.flatMap((tool) =>
      SPECS.map((spec) => (spec === null ? tool : `${tool}(${spec})`)),
    ),
    " Read(.env)",
    "Read(**/)",
    "Read({a,b})",
    "Read(**/{a,b})",
    `${LAP_SERVER}__send-message`,
    `${LAP_SERVER}__${"x".repeat(60)}`,
    "mcp__continuo-messagebus-admin__drop",
    "Read (.env)",
    "Read(.env",
    "Read(x))",
  ],
  allow: [
    "Bash(npm test)",
    "Bash(git diff:*)",
    "Bash(npm run *)",
    "Bash(make [ab])",
    "Bash(tool ?)",
    "Bash(python3 x.py)",
    "Bash(timeout 60 bash)",
    "Bash(bash-5.2 -c x)",
    "Bash(nodejs x.js)",
    "Bash(sqlite3 x.db)",
    "Bash(awk -f x)",
    "Bash(sed -n p x)",
    "Bash(ionice bash)",
    "Bash(. x)",
    "Bash(pypy3 x)",
    "Bash(R -q)",
    "Bash(/usr/bin/env x)",
    "Bash('python3' x.py)",
    "Bash(*)",
    "Bash()",
    "Bash(git log | head)",
    "Bash( npm test)",
    "Bash(\tbash -c x)",
    "Bash",
    " Bash(python3 x)",
    "bash(python3 x)",
    "Read",
    "Read(/x/**)",
    "Edit",
    "WebFetch",
    "Task",
    `${LAP_SERVER}__poll`,
    "Foo",
  ],
  denyRead: PATHS,
  denyWrite: PATHS,
  additionalDirectories: PATHS,
  env: [
    "WORKER_DIR",
    "INTERLOCK_ROOT",
    "FOO",
    "PATH",
    "HOME",
    "SHELL",
    "IFS",
    "ENV",
    "BASH_ENV",
    "ZDOTDIR",
    "CODEX_HOME",
    "NODE_OPTIONS",
    "EDITOR",
    "PAGER",
    "GIT_DIR",
    "GIT_EXTERNAL_DIFF",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "A=B",
    "1X",
    "XDG_CONFIG_HOME",
    "SHELLOPTS",
    "PS4",
    "npm_config_script_shell",
    "LESSOPEN",
    "PYTHONPATH",
    "Path",
    "GITHUB_TOKEN",
  ],
  settings: ["apiKeyHelper", "model", "statusLine", "additionalDirectories", "disableAllHooks"],
  mcp: ["continuo-messagebus", "srv", "srv_x", "codex_apps", "codex-apps", "a.b", "a b", "a/b"],
};

// --------------------------------------------------------------------------
// Applying a shape to a published lap
// --------------------------------------------------------------------------

function fill(value: string, l: Lap): string {
  return value.replaceAll("{root}", l.root);
}

function apply(l: Lap, axis: Axis, raw: string): void {
  const value = fill(raw, l);
  if (axis === "mcp") {
    const mcp = JSON.parse(readFileSync(l.mcpPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    mcp.mcpServers = { [value]: Object.values(mcp.mcpServers)[0] };
    writeFileSync(l.mcpPath, JSON.stringify(mcp), "utf8");
    return;
  }
  publish(l, (settings) => {
    if (axis === "allow" || axis === "deny") {
      settings["permissions"][axis] = [...(settings["permissions"][axis] ?? []), value];
    } else if (axis === "env") {
      settings["env"] = { ...settings["env"], [value]: "x" };
    } else if (axis === "settings") {
      settings[value] = {};
    } else {
      const filesystem = settings["sandbox"]["filesystem"];
      filesystem[axis] = [...(filesystem[axis] ?? []), value];
    }
  });
}

function rowFor(axis: Axis, raw: string, l: Lap): Row | undefined {
  const value = fill(raw, l);
  return TABLE.find((row) => row.axis === axis && row.claims(value));
}

// --------------------------------------------------------------------------
// The tests
// --------------------------------------------------------------------------

/**
 * Every corpus shape through `translateFence`, against `table`: what is wrong,
 * and which rows no shape reached.
 */
function partition(table: readonly Row[]): { wrong: string[]; unreached: string[] } {
  const l = lap();
  const saved = [l.settingsPath, l.mcpPath, l.fencePath].map(
    (path) => [path, readFileSync(path)] as const,
  );
  const reached = new Set<Row>();
  const wrong: string[] = [];
  for (const [axis, values] of Object.entries(CORPUS) as [Axis, readonly string[]][]) {
    for (const raw of values) {
      apply(l, axis, raw);
      const outcome = translateFence(l.cliArgs);
      for (const [path, bytes] of saved) {
        writeFileSync(path, bytes);
      }
      const value = fill(raw, l);
      const row = table.find((candidate) => candidate.axis === axis && candidate.claims(value));
      const got = typeof outcome === "string" ? "refused" : "translated";
      if (row === undefined) {
        // Neither translated nor refused BY THE TABLE: a shape no row names.
        wrong.push(`${axis} ${JSON.stringify(raw)}: no row claims it (${got})`);
        continue;
      }
      reached.add(row);
      if (got !== row.verdict) {
        wrong.push(
          `${axis} ${JSON.stringify(raw)}: ${got} (${String(outcome).slice(0, 160)}), ` +
            `but the row "${row.shape}" says ${row.verdict}`,
        );
      } else if (row.verdict === "refused" && !String(outcome).includes(row.layer)) {
        wrong.push(`${axis} ${JSON.stringify(raw)}: refused as ${JSON.stringify(outcome)}`);
      }
    }
  }
  const unreached = table
    .filter((row) => !reached.has(row))
    .map((row) => `${row.axis}: ${row.shape}`);
  return { wrong, unreached };
}

test("every shape in the corpus is claimed by one row and comes out as that row says", () => {
  // No row the corpus never reaches, either: a dead row is a claim nothing tests.
  expect(partition(TABLE)).toEqual({ wrong: [], unreached: [] });
});

test("the partition fails on a shape no row names, and on a row that misstates a verdict", () => {
  // Anti-vacuity: without the deny axis's last row, the shapes it claimed are
  // accepted by the translation and named by nothing.
  const last = TABLE.findLast((row) => row.axis === "deny");
  const { wrong } = partition(TABLE.filter((row) => row !== last));
  expect(wrong.some((line) => line.includes('"WebFetch": no row claims it (translated)'))).toBe(
    true,
  );
  // And a row saying "translated" where the translation refuses is caught.
  const flipped = TABLE.map((row) =>
    row.axis === "env" && row.verdict === "refused"
      ? { ...row, verdict: "translated" as const }
      : row,
  );
  expect(partition(flipped).wrong.some((line) => line.includes('"PATH": refused'))).toBe(true);
});

test.each(TABLE.map((row) => [`${row.axis}: ${row.shape}`, row] as const))(
  "the table's example -- %s",
  async (_name, row) => {
    const l = lap();
    mkdirSync(join(l.root, "extra"), { recursive: true });
    apply(l, row.axis, row.example);
    expect(rowFor(row.axis, row.example, l)).toBe(row);
    if (row.verdict === "refused") {
      const log = spawnLog(l.root);
      const refusal = refusalOf(await start(providerFor(l), l));
      expect(refusal.kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
      expect(refusal.detail).toContain(row.layer);
      expect(spawned(log)).toEqual([]);
    } else {
      const profile = await profileOf(l);
      if (row.profile !== undefined) {
        expect(profile).toContain(row.profile(l));
      }
    }
  },
);

// -- The spawn rows ---------------------------------------------------------

async function refusedAtSpawn(l: Lap, words: string): Promise<void> {
  const log = spawnLog(l.root);
  const refusal = refusalOf(await start(providerFor(l), l));
  expect(refusal.kind).toBe(FailureKind.REFUSED_BY_PROVIDER);
  expect(refusal.detail).toContain(words);
  expect(spawned(log)).toEqual([]);
}

test("a read or write denial over the workspace refuses the spawn, by any axis that names one", async () => {
  const cases: [Axis, (l: Lap) => string, string][] = [
    ["denyWrite", (l) => join(l.root, "workspaces"), "denies writes under"],
    ["denyRead", (l) => join(l.root, "workspaces"), "denies reads under"],
    ["deny", (l) => `Read(${join(l.root, "workspaces")})`, "denies reads under"],
    ["deny", (l) => `Edit(${join(l.root, "workspaces")})`, "denies writes under"],
  ];
  for (const [axis, value, words] of cases) {
    const l = lap();
    apply(l, axis, value(l));
    await refusedAtSpawn(l, words);
  }
});

test("an Edit denial inside the workspace is pinned read-only, as a write denial is", async () => {
  const l = lap();
  const path = join(workspaceOf(l), "src", "x.ts");
  apply(l, "deny", `Edit(${path})`);
  expect(await profileOf(l)).toContain(`${JSON.stringify(path)} = "read"`);
});

test("a denial whose link makes it contain the workspace refuses the spawn", async () => {
  // A symlink needs a privilege a Windows runner may not hold (see the Codex
  // provider's auth.json link); there the case has nothing to build.
  if (process.platform === "win32") {
    return;
  }
  const l = lap();
  mkdirSync(join(l.root, "workspaces"), { recursive: true });
  symlinkSync(join(l.root, "workspaces"), join(l.root, "alias"));
  apply(l, "denyWrite", join(l.root, "alias"));
  await refusedAtSpawn(l, "real paths");
});

test("a directory through a refs/heads that is not the branch ref is not taken for rule 8", async () => {
  const l = lap();
  const declared = join(l.root, "data", "refs", "heads", "ns", "x");
  mkdirSync(declared, { recursive: true });
  apply(l, "additionalDirectories", declared);
  const profile = await profileOf(l);
  expect(profile).toContain(`${JSON.stringify(declared)} = "write"`);
  expect(profile).not.toContain(JSON.stringify(join(l.root, "data", "refs", "heads", "ns")));
  // The nearest accepted rule-8 case still grants the namespace.
  const git = lap();
  const { gitDir } = withBranchRef(git, "lap/topic");
  expect(await profileOf(git)).toContain(`${JSON.stringify(`${gitDir}/refs/heads/lap`)} = "write"`);
});

test("S and the fence the hook reads must be one fence", async () => {
  const disagreeing = lap();
  publish(
    disagreeing,
    (settings) => {
      settings["permissions"]["allow"].push("Bash(make)");
    },
    "settings",
  );
  await refusedAtSpawn(disagreeing, "is not the worker fence");
});

test("a hook that does not deny an empty event refuses the spawn", async () => {
  const hookScript = hookScriptForTest(join(lap().root, "silent"));
  writeFileSync(join(dirname(hookScript), "codex_hook.mjs"), "process.exit(0);\n", "utf8");
  const l = lap({ hookScript });
  await refusedAtSpawn(l, "did not deny an empty event");
});

test("a relative interpreter, hook or fence in the hook command is refused", async () => {
  const l = lap();
  publish(l, (settings) => {
    const handler = settings["hooks"]["PreToolUse"][0]["hooks"][0];
    handler.command = handler.command.replace(/^\S+/, "node");
  });
  await refusedAtSpawn(l, "are not exactly the one deny hook");
});

test("a deny rule S names and the hook's fence lacks is refused", async () => {
  const l = lap();
  apply(l, "deny", "Bash(make *)");
  const fence = readFence(l.fencePath);
  writeFence(
    new Fence({
      role: fence.role,
      roleKind: fence.roleKind,
      permissionMode: fence.permissionMode,
      rules: fence.rules.filter((held) => held.spec !== "make *"),
      settings: fence.settings,
    }),
    l.fencePath,
  );
  await refusedAtSpawn(l, "is not among the rules");
});

test("a glob read denial whose fixed part is over the workspace refuses the spawn", async () => {
  for (const [axis, value] of [
    ["denyRead", (l: Lap) => join(l.root, "*")],
    ["deny", (l: Lap) => `Read(${join(l.root, "work*")})`],
  ] as const) {
    const l = lap();
    apply(l, axis, value(l));
    await refusedAtSpawn(l, "denies reads under");
  }
  // The nearest accepted case: a glob inside the workspace.
  const inside = lap();
  apply(inside, "denyRead", `${workspaceOf(inside)}/*.pem`);
  expect(await profileOf(inside)).toContain('*.pem" = "deny"');
});

test("the hook self-test needs both the deny on stdout and exit 2", async () => {
  const deny = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } });
  for (const body of [
    `process.stdout.write(${JSON.stringify(deny)}); process.exit(0);`,
    "process.exit(2);",
  ]) {
    const hookScript = hookScriptForTest(join(lap().root, "half"));
    writeFileSync(join(dirname(hookScript), "codex_hook.mjs"), `${body}\n`, "utf8");
    await refusedAtSpawn(lap({ hookScript }), "did not deny an empty event");
  }
});

test("rule 8 needs both objects and packed-refs beside the refs/heads it takes", async () => {
  for (const sibling of ["objects", "packed-refs"]) {
    const l = lap();
    const common = join(l.root, "data");
    const ref = `${common}/refs/heads/ns/x`;
    mkdirSync(`${common}/refs/heads/ns`, { recursive: true });
    mkdirSync(`${common}/objects`, { recursive: true });
    writeFileSync(ref, "0".repeat(40), "utf8");
    writeFileSync(`${common}/packed-refs`, "", "utf8");
    apply(l, "additionalDirectories", `${common}/${sibling}`);
    apply(l, "additionalDirectories", ref);
    expect(await profileOf(l)).not.toContain(JSON.stringify(`${common}/refs/heads/ns`));
  }
});

test("a Read rule of ** and one segment is denied under every write root, not only the workspace", async () => {
  const l = lap();
  const { gitDir } = withBranchRef(l, "lap/topic");
  apply(l, "deny", "Read(**/*.key)");
  const profile = await profileOf(l);
  for (const root of [workspaceOf(l), gitDir, `${gitDir}/objects`, `${gitDir}/refs/heads/lap`]) {
    expect(profile).toContain(`${JSON.stringify(`${root}/**/*.key`)} = "deny"`);
  }
});

test("a Codex lap on Windows is refused before anything exists, until #226 measures it", async () => {
  const l = lap();
  patchSeam(codexCliSeams, "platform", "win32");
  await refusedAtSpawn(l, "does not run on Windows");
  expect(translateFence(l.cliArgs)).toContain("#226");
  // The nearest accepted case: the same lap elsewhere.
  patchSeam(codexCliSeams, "platform", "linux");
  expect(typeof translateFence(l.cliArgs)).toBe("object");
});
