/**
 * Sandbox preflight / canary for a rendered `settings.local.json`.
 *
 * Port of interlock `src/claude_org_runtime/settings/sandbox_doctor.py` at
 * `65f36c5`. The 77 cases of `tests/test_sandbox_symlink_deny.py` map onto
 * `test/settings/sandbox-symlink-deny.test.ts`; the mapping is
 * `parity/settings.sandbox-symlink-deny.ledger.json`.
 *
 * This is the *detection* half of the symlink-deny fix. `generator.ts`
 * canonicalises the deny paths it renders itself, but a worker's effective deny
 * set is the merge of several settings scopes -- user `~/.claude/settings.json`,
 * project settings, managed settings -- and only some of them come from this
 * runtime. Any scope can contribute a deny path that crosses an absolute
 * symlink and takes the whole sandbox down.
 *
 * That failure is dangerously quiet. bubblewrap aborts at launch:
 *
 *     bwrap: Can't create file at /home/<user>/.aws/config: No such file or
 *     directory
 *
 * and Claude Code's documented escape hatch then retries the command with
 * `dangerouslyDisableSandbox`, so the session keeps working -- unsandboxed --
 * with no standing signal that isolation is off. An operator can believe the
 * sandbox is enforcing a boundary for months while it enforces nothing.
 *
 * `sandbox doctor` turns that into a loud, checkable failure:
 *
 * 1. **Static analysis** -- collect every deny path the settings contribute to
 *    the sandbox (Layer 3 `sandbox.filesystem.deny{Read,Write}` plus Layer 2
 *    `permissions.deny` `Read` / `Edit` rules, which Claude Code merges into the
 *    same set) and flag the ones whose component chain crosses an absolute
 *    symlink, with the realpath rewrite that would fix each.
 * 2. **Live canary** -- when `bwrap` is present, actually launch it with the
 *    collected deny paths bound and report whether the sandbox comes up. This
 *    catches unbindable paths whose cause is something other than a symlink.
 *
 * Exit status is non-zero when either check fails, so it can gate a worker
 * launch instead of being advisory.
 *
 * ## The number-spelling obligation reaches this module, at one branch
 *
 * D-0211 makes carrying a JSON number's recorded Python spelling an obligation
 * on every container rebuild, and it is easy to read this module as having
 * none: it collects paths, and a path is a string. It has **one**, and the way
 * in is the malformed-input path this module exists to surface rather than
 * skip. A `permissions.deny` of `[1.0]` is a non-string rule, so it is reported
 * as `unsupported-entry` with the number **as** `Finding.source` -- and
 * `toJsonable` then hands that number to `pyJsonDumps` under a key on a freshly
 * built object. Without a carry, `--json` prints `1` where CPython prints
 * `1.0`, in the field whose only job is to quote the operator's input back so
 * they can find it in their settings file.
 *
 * The branch is {@link findingToJsonable}, and it is pinned. There is no second
 * one: every other container this module builds holds strings it composed
 * itself.
 *
 * ## What is NOT transcribed, and why that is safe here
 *
 * `run_bwrap_canary` shells out. `child_process.spawnSync` is not
 * `subprocess.run`, and the difference that matters -- what happens to a
 * `stderr` that is not valid UTF-8 -- is settled by decoding with an explicit
 * replacement rather than by `Buffer.toString`'s silent one, because only the
 * FIRST line is read and a mangled first line is a mangled diagnostic, not a
 * wrong verdict. The verdict is `returncode`, which no decoding touches.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as nodeJoin, delimiter as pathDelimiter } from "node:path";

import { pyJsonDumps, pyJsonLoads } from "../fencing/pyjson.js";
import {
  expanduser,
  osIsabs,
  osJoin,
  osNormcase,
  osNormpath,
  osRealpath,
  osSplit,
} from "../fencing/pypath.js";
import {
  type PyNumberSpelling,
  pyNumberSpelling,
  pyStr,
  rememberNumberSpellings,
} from "../fencing/pysemantics.js";
import {
  absoluteSymlinkInChain,
  literalPathPrefix,
  PERMISSION_PATH_TOOLS,
  permissionRuleHostPath,
  splitPermissionRule,
} from "./generator.js";

// Status values for a single deny target.
export const STATUS_OK = "ok";
export const STATUS_SYMLINK_ESCAPE = "symlink-escape";
export const STATUS_UNSUPPORTED = "unsupported-entry";

// Status values for the live bwrap canary.
export const CANARY_PASS = "pass";
export const CANARY_FAIL = "fail";
export const CANARY_SKIPPED = "skipped";

/**
 * Settings scopes Claude Code merges besides the file under test.
 *
 * The deny arrays are unioned across every scope, so a symlinked path in any
 * one of them aborts the launch no matter how clean the rendered worker file
 * is. Checking the worker file alone would hand out a clean bill of health for
 * a sandbox that cannot start.
 */
export const USER_SETTINGS_PATH = "~/.claude/settings.json";

/**
 * `MANAGED_SETTINGS_PATHS`, and `doctorSeams` is why it is not a plain `const`.
 *
 * Four source cases replace this with `()` so discovery cannot pick up a
 * managed settings file that happens to exist on the porting host. An ESM
 * binding cannot be rebound from outside, so it is read through the seam
 * record (`docs/test-translation-conventions.md` rule 5).
 */
export const DEFAULT_MANAGED_SETTINGS_PATHS: readonly string[] = [
  "/etc/claude-code/managed-settings.json",
  "/Library/Application Support/ClaudeCode/managed-settings.json",
];

/**
 * Project-level scopes live side by side: `settings.json` is the checked-in one
 * and `settings.local.json` the generated / personal one. Claude Code unions
 * both, so checking whichever was passed and ignoring its sibling would leave
 * half the project scope unaudited.
 */
export const PROJECT_SCOPE_FILENAMES: readonly string[] = ["settings.json", "settings.local.json"];

/**
 * The module attributes interlock's suite replaces with `monkeypatch.setattr`,
 * plus the two streams `redirect_stdout` / `capsys` capture.
 *
 * Every seam here owes a liveness case (rule 5): a seam nothing reads is a
 * `monkeypatch` that silently stopped reaching production. They are asserted in
 * the target-only block of `test/settings/sandbox-symlink-deny.test.ts`.
 */
export const doctorSeams = {
  /** `sandbox_doctor.MANAGED_SETTINGS_PATHS`. */
  managedSettingsPaths: DEFAULT_MANAGED_SETTINGS_PATHS as readonly string[],
  /** `sandbox_doctor.shutil.which`. */
  which: (name: string): string | null => whichOnPath(name),
  /** `sandbox_doctor.discover_merged_scopes`. */
  discoverMergedScopes: (inputs?: readonly string[] | null): string[] =>
    discoverMergedScopes(inputs),
  /** `sys.stdout.write`. */
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  /** `print(..., file=sys.stderr)`. */
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
};

/**
 * `os.defpath`: what CPython searches when `PATH` is not set at all.
 *
 * CPython tries `os.confstr("CS_PATH")` first and falls back to `os.defpath`;
 * Node exposes neither `confstr` nor a `defpath`, and the two agree on every
 * platform this port runs on (`/bin:/usr/bin` measured on the porting host).
 * The fallback is transcribed rather than the confstr call, because the value
 * is what matters and the call is not reachable from here.
 */
const OS_DEFPATH = process.platform === "win32" ? ".;C:\\bin" : "/bin:/usr/bin";

/**
 * `shutil.which`, narrowed to the one lookup this module makes.
 *
 * Only the PATH search is transcribed -- no Windows `curdir` prepend, no
 * `PATHEXT` expansion -- because the single caller asks for `bwrap`, which
 * exists on POSIX and not on Windows, and a Windows host answers `null` either
 * way. The narrowing is stated rather than left implicit: a second caller
 * wanting a `.exe` would need the rest, and rule 11 puts that on whoever adds it
 * rather than on a helper generalised in advance for a caller that does not
 * exist.
 *
 * **Three details of `shutil.which` that a plain `PATH.split()` loop drops, all
 * of them in the same direction.** Every one of them makes the lookup answer
 * `null` for a `bwrap` that is in fact reachable, and this module's answer to
 * "not found" is `CANARY_SKIPPED` -- which, with no static findings, exits 0.
 * A preflight that reports success without running its live check is exactly
 * the silent pass the command exists to prevent.
 *
 * - **`PATH` unset is not `PATH` empty.** CPython falls back to the system
 *   default path; only an explicitly EMPTY `PATH` means "search nowhere"
 *   (`if not path: return None`, after the fallback).
 * - **An empty component searches the current directory.** `os.path.join("",
 *   "bwrap")` is `"bwrap"`, a cwd-relative path, so a `PATH` of `":/usr/bin"`
 *   has three meanings and not two.
 * - **Directories are deduplicated by their normcased form**, so a `PATH` that
 *   repeats a directory stats it once. Behaviour-neutral for the answer, and
 *   transcribed because it is the reason CPython's loop is not a plain `for`.
 *
 * `X_OK` is not testable without `access(2)`, so the file's existence stands in
 * -- the canary's answer to a present-but-unexecutable `bwrap` is then a FAIL
 * from the launch rather than a SKIP from the lookup, which is the same safe
 * side as the three above.
 */
function whichOnPath(name: string): string | null {
  // `path = os.environ.get("PATH", None)`, then the defpath fallback, then
  // `if not path: return None`. The order matters: an unset `PATH` gets the
  // fallback and an empty one does not.
  const fromEnv = process.env["PATH"];
  const path = fromEnv === undefined ? OS_DEFPATH : fromEnv;
  if (path === "") {
    return null;
  }
  const seen = new Set<string>();
  for (const dir of path.split(pathDelimiter)) {
    const normdir = osNormcase(dir);
    if (seen.has(normdir)) {
      continue;
    }
    seen.add(normdir);
    // `os.path.join(dir, cmd)`. Both this and `node:path`'s `join` turn an
    // empty `dir` into the bare name -- MEASURED, because the empty-component
    // case is what this line exists for and "the transcription is required
    // here" would have been a claim with no probe behind it. They differ only
    // in normalisation (`posixpath.join("/usr//bin", "x")` keeps the doubled
    // separator that `path.join` collapses), which no `stat` can observe. The
    // transcription is used anyway, because a lookup that agreed with CPython
    // by coincidence is one the next reader has to re-derive.
    const candidate = osJoin(dir, name);
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** `SettingsSource`: one settings file participating in the merge. */
export interface SettingsSource {
  readonly label: string;
  readonly settings: Record<string, unknown>;
}

/** `DenyTarget`: one concrete host path the settings contribute to the deny set. */
export interface DenyTarget {
  /** `"permissions.deny"` | `"sandbox.filesystem.denyRead"` | ... */
  readonly layer: string;
  /** The original rule / entry as authored. */
  readonly source: unknown;
  /** Absolute host path (glob tail included). */
  readonly path: string;
  /** Which settings scope contributed it. */
  readonly sourceFile: string;
  /**
   * The Python spelling recorded for `source`, when `source` is a number the
   * document supplied one for.
   *
   * Read off the deny array at collection time and re-hung on the `source` key
   * of the JSON object by {@link findingToJsonable}. A spelling hangs on the
   * container that immediately holds the number, so it cannot be looked up
   * later from the value: by then the value is a bare double with no identity
   * to key a side table by. @see the module header.
   */
  readonly sourceSpelling: PyNumberSpelling | undefined;
}

/** `Finding`: verdict for a single deny target. */
export interface Finding {
  readonly layer: string;
  readonly source: unknown;
  readonly path: string;
  readonly status: string;
  readonly detail: string;
  readonly suggestion: string | null;
  readonly sourceFile: string;
  /** @see {@link DenyTarget.sourceSpelling}. */
  readonly sourceSpelling: PyNumberSpelling | undefined;
}

/**
 * `Finding.to_jsonable`.
 *
 * **A container rebuild, and the module's only number-spelling branch.** The
 * `source` field is the operator's authored entry verbatim, which for the
 * `unsupported-entry` status can be a NUMBER -- that is the whole reason the
 * status exists. A spelling is recorded against the container that immediately
 * held the number (the `permissions.deny` array, say) and this object is a
 * different container, so the record has to be re-hung on the new key or
 * `pyJsonDumps` classifies the value afresh and writes `1` for CPython's `1.0`.
 */
export function findingToJsonable(finding: Finding): Record<string, unknown> {
  const out: Record<string, unknown> = {
    layer: finding.layer,
    source: finding.source,
    path: finding.path,
    status: finding.status,
    detail: finding.detail,
    suggestion: finding.suggestion,
    source_file: finding.sourceFile,
  };
  if (finding.sourceSpelling !== undefined) {
    // NOT `carryNumberSpellings`: that matches slots by NAME, and the number
    // arrives here from index `"3"` of a deny array and leaves under the key
    // `"source"`. A wholesale carry would find no `source` entry in the record
    // and quietly do nothing -- green, and `1` where CPython writes `1.0`.
    rememberNumberSpellings(out, new Map([["source", finding.sourceSpelling]]));
  }
  return out;
}

/** `DoctorReport`: full preflight result. */
export interface DoctorReport {
  readonly findings: readonly Finding[];
  readonly canaryStatus: string;
  readonly canaryDetail: string;
  readonly sandboxDisabled: boolean;
}

/** `DoctorReport.failures`. */
export function reportFailures(report: DoctorReport): Finding[] {
  return report.findings.filter((f) => f.status !== STATUS_OK);
}

/**
 * `DoctorReport.ok`: whether this settings file should be allowed to gate a
 * launch.
 *
 * A file that explicitly sets `sandbox.enabled: false` never launches a sandbox
 * of its own, so its deny paths cannot abort one and the gate passes. The
 * findings are still reported: the deny arrays merge across settings scopes, so
 * a symlinked path here becomes live the moment any other scope enables the
 * sandbox.
 */
export function reportOk(report: DoctorReport): boolean {
  if (report.sandboxDisabled) {
    return true;
  }
  return reportFailures(report).length === 0 && report.canaryStatus !== CANARY_FAIL;
}

/** `DoctorReport.to_jsonable`. */
export function reportToJsonable(report: DoctorReport): Record<string, unknown> {
  return {
    ok: reportOk(report),
    sandbox_disabled: report.sandboxDisabled,
    findings: report.findings.map(findingToJsonable),
    canary: {
      status: report.canaryStatus,
      detail: report.canaryDetail,
    },
  };
}

/** `isinstance(x, dict)` over a `json.load` result: a mapping, never an array. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `validate_settings`: return an error message when the settings shape cannot
 * be checked.
 *
 * Only the containers this module reads are validated, but they are validated
 * strictly: a `deny` given as a bare string is iterable, so without this the
 * scan would walk it character by character, find no targets, and hand out a
 * clean bill of health for a malformed file. A preflight that gates a launch
 * must not pass by accident.
 */
export function validateSettings(settings: unknown): string | null {
  if (!isMapping(settings)) {
    return "settings root must be a JSON object";
  }

  const permissions = settings["permissions"];
  if (permissions !== undefined && permissions !== null) {
    if (!isMapping(permissions)) {
      return "permissions must be an object";
    }
    const deny = permissions["deny"];
    if (deny !== undefined && deny !== null && !Array.isArray(deny)) {
      return "permissions.deny must be an array";
    }
  }

  const sandbox = settings["sandbox"];
  if (sandbox !== undefined && sandbox !== null) {
    if (!isMapping(sandbox)) {
      return "sandbox must be an object";
    }
    const fs = sandbox["filesystem"];
    if (fs !== undefined && fs !== null) {
      if (!isMapping(fs)) {
        return "sandbox.filesystem must be an object";
      }
      for (const key of ["denyRead", "denyWrite"] as const) {
        const entries = fs[key];
        if (entries !== undefined && entries !== null && !Array.isArray(entries)) {
          return `sandbox.filesystem.${key} must be an array`;
        }
      }
    }
  }
  return null;
}

/**
 * `collect_deny_targets`: collect every deny path `settings` contributes to the
 * sandbox.
 *
 * Both layers are collected because Claude Code merges them: per
 * https://code.claude.com/docs/en/sandboxing, "Paths from both
 * sandbox.filesystem settings and permission rules are merged together into the
 * final sandbox configuration". Auditing Layer 3 alone is what lets a Layer 2
 * credential mirror silently break the sandbox.
 *
 * Only entries that name a *concrete host path* are collected;
 * project-relative and unanchored-glob rules are skipped because Claude Code
 * does not expand them into host paths for the deny set.
 */
export function collectDenyTargets(
  settings: Record<string, unknown>,
  options: { readonly sourceFile?: string } = {},
): DenyTarget[] {
  const sourceFile = options.sourceFile ?? "";
  const targets: DenyTarget[] = [];

  const permissions = settings["permissions"];
  if (isMapping(permissions)) {
    const denyRaw = permissions["deny"];
    // `permissions.get("deny") or []`: a falsy value yields the empty list. A
    // truthy non-list would be iterated by the source and is what
    // `validateSettings` refuses before ever reaching here; the CLI runs the
    // validation, so only a direct caller can construct the shape, and for one
    // that does the array test is the same skip the validation would have been.
    const deny = Array.isArray(denyRaw) ? denyRaw : [];
    for (const [index, rule] of deny.entries()) {
      if (typeof rule !== "string") {
        targets.push({
          layer: "permissions.deny",
          source: rule,
          path: "",
          sourceFile,
          sourceSpelling: pyNumberSpelling(deny, index),
        });
        continue;
      }
      const parsed = splitPermissionRule(rule);
      if (parsed === null) {
        continue;
      }
      const [tool, spec] = parsed;
      if (!PERMISSION_PATH_TOOLS.includes(tool)) {
        continue;
      }
      const hostPath = permissionRuleHostPath(spec);
      if (hostPath === null) {
        continue;
      }
      targets.push({
        layer: "permissions.deny",
        source: rule,
        path: hostPath,
        sourceFile,
        sourceSpelling: undefined,
      });
    }
  }

  const sandbox = settings["sandbox"];
  if (isMapping(sandbox)) {
    const fs = sandbox["filesystem"];
    if (isMapping(fs)) {
      for (const key of ["denyRead", "denyWrite"] as const) {
        const entriesRaw = fs[key];
        const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
        for (const [index, entry] of entries.entries()) {
          if (typeof entry !== "string") {
            // The renderer emits kept entries as strings; a structured dict
            // surviving into a rendered file means the entry was malformed, so
            // surface it rather than skipping to a clean result.
            targets.push({
              layer: `sandbox.filesystem.${key}`,
              source: entry,
              path: "",
              sourceFile,
              sourceSpelling: pyNumberSpelling(entries, index),
            });
            continue;
          }
          let path = entry;
          if (path.startsWith("~/")) {
            path = expanduser("~") + path.slice(1);
          }
          // `isabs`, not `startswith("/")`: on Windows an expanded entry begins
          // with a drive letter, so the prefix test would drop every concrete
          // Layer 3 target and leave the report claiming there was nothing to
          // check.
          if (!osIsabs(path)) {
            continue;
          }
          targets.push({
            layer: `sandbox.filesystem.${key}`,
            source: entry,
            path,
            sourceFile,
            sourceSpelling: undefined,
          });
        }
      }
    }
  }

  return targets;
}

/** `analyze_targets`: statically classify each deny target as bwrap-safe or not. */
export function analyzeTargets(targets: readonly DenyTarget[]): Finding[] {
  const findings: Finding[] = [];
  for (const target of targets) {
    if (target.path === "") {
      findings.push({
        layer: target.layer,
        source: target.source,
        path: "",
        status: STATUS_UNSUPPORTED,
        detail:
          "entry is not a string, so its bwrap usability cannot " +
          "be verified; a rendered settings file should contain " +
          "only string deny entries",
        suggestion: null,
        sourceFile: target.sourceFile,
        sourceSpelling: target.sourceSpelling,
      });
      continue;
    }
    const literal = literalPathPrefix(target.path);
    if (literal === null) {
      findings.push({
        layer: target.layer,
        source: target.source,
        path: target.path,
        status: STATUS_OK,
        detail: "no anchored literal prefix; not expanded to a host path",
        suggestion: null,
        sourceFile: target.sourceFile,
        sourceSpelling: target.sourceSpelling,
      });
      continue;
    }
    // The IMPORT, not `generatorSeams.absoluteSymlinkInChain`. The source binds
    // this name at import time (`from .generator import
    // _absolute_symlink_in_chain`), so the generator suite's autouse "no host
    // symlinks" patch does NOT reach it -- and must not, because the doctor's
    // own cases build real symlinks on disk and assert on what the filesystem
    // says. Reading it through the seam would make those cases answer from a
    // fixture the generator's suite installed.
    const link = absoluteSymlinkInChain(literal);
    if (link === null) {
      findings.push({
        layer: target.layer,
        source: target.source,
        path: target.path,
        status: STATUS_OK,
        detail: "no absolute symlink in the path chain",
        suggestion: null,
        sourceFile: target.sourceFile,
        sourceSpelling: target.sourceSpelling,
      });
      continue;
    }
    const resolved = osRealpath(literal);
    const rewritten = resolved + target.path.slice(literal.length);
    findings.push({
      layer: target.layer,
      source: target.source,
      path: target.path,
      status: STATUS_SYMLINK_ESCAPE,
      detail:
        `absolute symlink at ${link} -> ${osRealpath(link)}; ` +
        "bwrap cannot create a mount point under it and will abort " +
        "the sandbox launch",
      suggestion: rewritten,
      sourceFile: target.sourceFile,
      sourceSpelling: target.sourceSpelling,
    });
  }
  return findings;
}

/** `os.path.lexists`: exists, following no final symlink. */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** `_bwrap_source_for`: pick a bind source matching the deny target's type. */
function bwrapSourceFor(path: string): string | null {
  const real = osRealpath(path);
  if (!existsSync(real)) {
    return null;
  }
  try {
    return statSync(real).isDirectory() ? null : "/dev/null";
  } catch {
    // `os.path.isdir` answers `False` for anything it cannot stat, and the
    // source's next step for a non-directory is `/dev/null`. Reached only by a
    // path that raced `existsSync` on the line above.
    return "/dev/null";
  }
}

/** `subprocess.CompletedProcess`, narrowed to the three fields this module reads. */
export interface CompletedProcess {
  readonly args: readonly string[];
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The injected stand-in for the real binary. */
export type CanaryRunner = (cmd: string[]) => CompletedProcess;

/**
 * `run_bwrap_canary`: launch bwrap with the collected deny paths bound.
 *
 * Returns `[status, detail]`. This is the canary that answers the question the
 * static check can only approximate: does the sandbox actually come up on
 * *this* machine with *these* settings?
 */
export function runBwrapCanary(
  targets: readonly DenyTarget[],
  options: { readonly runner?: CanaryRunner | null; readonly bwrapPath?: string | null } = {},
): [status: string, detail: string] {
  const runner = options.runner ?? null;
  let resolvedBwrap = options.bwrapPath ?? doctorSeams.which("bwrap");
  // An injected `runner` stands in for the real binary, so requiring bwrap on
  // PATH would make the caller's substitution depend on the host having the
  // tool it is substituting for.
  if (resolvedBwrap === null && runner === null) {
    return [CANARY_SKIPPED, "bwrap not found on PATH; live canary not run"];
  }
  resolvedBwrap = resolvedBwrap ?? "bwrap";

  // Deliberately no `--proc` / `--dev`: those mount fresh filesystems that
  // *shadow* the corresponding host trees, and a shadowed region has no symlink
  // for bwrap to trip over -- it simply creates plain directories and succeeds.
  // Probing with them would blind the canary to any deny path under the
  // shadowed prefix and make it disagree with the static analysis. The probe
  // only needs to create the mount points, and `true` needs neither /proc nor
  // /dev.
  const argv: string[] = [resolvedBwrap, "--ro-bind", "/", "/"];
  // `tempfile.TemporaryDirectory()`: created before the loop and removed
  // whatever the loop does, which is what the `finally` is for.
  const emptyDir = mkdtempSync(nodeJoin(tmpdir(), "continuo-canary-"));
  let proc: CompletedProcess;
  let bound = 0;
  try {
    for (const target of targets) {
      const literal = literalPathPrefix(target.path);
      if (literal === null || !lexists(literal)) {
        continue;
      }
      const source = bwrapSourceFor(literal);
      argv.push("--ro-bind", source ?? emptyDir, literal);
      bound += 1;
    }
    if (bound === 0) {
      return [CANARY_SKIPPED, "no concrete deny paths to probe"];
    }
    argv.push("true");

    const run: CanaryRunner = runner ?? defaultRunner;
    try {
      proc = run(argv);
    } catch (exc) {
      // `except (OSError, subprocess.SubprocessError)`. A thrown runner is the
      // launch failing, which is a canary FAIL and not an exception the caller
      // has to handle -- the whole point is that an unlaunchable sandbox is
      // reported rather than raised.
      return [
        CANARY_FAIL,
        `could not launch bwrap: ${exc instanceof Error ? exc.message : String(exc)}`,
      ];
    }
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }

  if (proc.returncode === 0) {
    return [CANARY_PASS, `bwrap started with ${bound} deny path(s) bound`];
  }
  const stderr = pyStripSplitlines(proc.stderr ?? "");
  const first = stderr.length > 0 ? (stderr[0] as string) : `exit status ${proc.returncode}`;
  return [CANARY_FAIL, first];
}

/** `(proc.stderr or "").strip().splitlines()`. */
function pyStripSplitlines(text: string): string[] {
  // Python's `str.strip()` with no argument strips whitespace including `\r`,
  // so a CRLF stream does not leave a bare `\r` at the end of the first line.
  const stripped = text.replace(/^\s+/, "").replace(/\s+$/, "");
  if (stripped === "") {
    return [];
  }
  return stripped.split(/\r\n|\n|\r/);
}

/** `subprocess.run(cmd, capture_output=True, text=True, timeout=30)`. */
function defaultRunner(cmd: string[]): CompletedProcess {
  const result = spawnSync(cmd[0] as string, cmd.slice(1), {
    timeout: 30_000,
    // Bytes, decoded below: `text=True` decodes with the locale encoding and
    // replaces nothing, while a `Buffer.toString("utf8")` silently substitutes
    // U+FFFD. Only the first stderr line is ever read and the verdict is the
    // return code, so an explicit lossy decode is honest here where it would be
    // a fail-open in the fence (D-0207's `TextDecoder({fatal: true})` note).
    encoding: "buffer",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return {
    args: cmd,
    // A signalled process has `status === null`; Python reports `-signum`.
    // Either way it is non-zero, which is all the verdict reads.
    returncode: result.status ?? -1,
    stdout: decoder.decode(result.stdout ?? new Uint8Array()),
    stderr: decoder.decode(result.stderr ?? new Uint8Array()),
  };
}

/** `diagnose`: run the full preflight against a single parsed settings mapping. */
export function diagnose(
  settings: Record<string, unknown>,
  options: { readonly probeBwrap?: boolean; readonly runner?: CanaryRunner | null } = {},
): DoctorReport {
  return diagnoseSources([{ label: "", settings }], options);
}

/**
 * `diagnose_sources`: run the preflight against the *merged* deny set of every
 * scope.
 *
 * Claude Code unions the deny arrays across settings scopes, so a symlinked
 * path contributed by `~/.claude/settings.json` or by managed settings aborts
 * the launch no matter how clean the rendered worker file is. Checking one file
 * in isolation would report a clean preflight for a sandbox that cannot start
 * -- exactly the silent failure this command exists to catch.
 *
 * `sandbox.enabled` is resolved conservatively: the gate is only relaxed when
 * no scope enables the sandbox and at least one explicitly disables it. Any
 * scope turning it on means a launch can be aborted.
 */
export function diagnoseSources(
  sources: readonly SettingsSource[],
  options: { readonly probeBwrap?: boolean; readonly runner?: CanaryRunner | null } = {},
): DoctorReport {
  const probeBwrap = options.probeBwrap ?? true;
  let enabledAnywhere = false;
  let disabledAnywhere = false;
  for (const source of sources) {
    const sandbox = source.settings["sandbox"];
    if (!isMapping(sandbox)) {
      continue;
    }
    // `is True` / `is False`, not truthiness: `"enabled": 1` is neither, and
    // reading it as an enable would relax nothing while reading it as a disable
    // would relax the gate for a value nobody wrote.
    if (sandbox["enabled"] === true) {
      enabledAnywhere = true;
    } else if (sandbox["enabled"] === false) {
      disabledAnywhere = true;
    }
  }
  const sandboxDisabled = disabledAnywhere && !enabledAnywhere;

  const targets: DenyTarget[] = [];
  for (const source of sources) {
    targets.push(...collectDenyTargets(source.settings, { sourceFile: source.label }));
  }
  const findings = analyzeTargets(targets);
  let status: string;
  let detail: string;
  if (sandboxDisabled) {
    [status, detail] = [CANARY_SKIPPED, "sandbox.enabled is false; no sandbox launch to probe"];
  } else if (probeBwrap) {
    [status, detail] = runBwrapCanary(targets, { runner: options.runner ?? null });
  } else {
    [status, detail] = [CANARY_SKIPPED, "live canary disabled (--no-probe-bwrap)"];
  }
  return {
    findings,
    canaryStatus: status,
    canaryDetail: detail,
    sandboxDisabled,
  };
}

/**
 * `load_source`: load and shape-validate one settings file.
 *
 * Returns `[source, error]`; exactly one is non-`null`.
 */
export function loadSource(path: string): [SettingsSource | null, string | null] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [null, `settings not found: ${path}`];
    }
    // `except OSError`. EISDIR, EACCES and friends land here, as they do in the
    // source, with the platform's own message rather than a forged errno text.
    return [null, `could not read ${path}: ${exc instanceof Error ? exc.message : String(exc)}`];
  }
  let settings: unknown;
  try {
    // `pyJsonLoads`, not `JSON.parse`: the loaded document's numbers are
    // reported back to the operator through `--json`, so their recorded Python
    // spelling has to exist before anything can carry it. @see the module header.
    settings = pyJsonLoads(text);
  } catch (exc) {
    // -- ADAPTED MESSAGE (D-0017) -- CPython's `JSONDecodeError` reads
    // `Expecting value: line 1 column 1 (char 0)`; this parser's differs.
    // Forging CPython's wording would launder a parser difference into a
    // familiar-looking lie, and no ported case reads the text.
    return [null, `${path} is not valid JSON: ${exc instanceof Error ? exc.message : String(exc)}`];
  }
  const invalid = validateSettings(settings);
  if (invalid !== null) {
    return [null, `${path}: ${invalid}`];
  }
  return [{ label: path, settings: settings as Record<string, unknown> }, null];
}

/** `Path.is_file`. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `Path.exists`. */
function pathExists(path: string): boolean {
  return existsSync(path);
}

/**
 * `Path.resolve`, as the identity key discovery deduplicates on.
 *
 * `resolve()` on a path that does not exist still normalises it, and
 * `osRealpath` is this repository's transcription of the same non-strict walk.
 */
function resolveKey(path: string): string {
  return osRealpath(path);
}

/** `path.parent`. */
function parentOf(path: string): string {
  const [head] = osSplit(osNormpath(path));
  return head === "" ? "." : head;
}

/**
 * `discover_merged_scopes`: settings scopes that merge into the effective deny
 * set, if present.
 *
 * Two families are discovered:
 *
 * - **Sibling project scopes.** `.claude/settings.json` and
 *   `.claude/settings.local.json` are separate scopes that Claude Code unions,
 *   so pointing `--settings` at one must not leave the other unchecked. They
 *   are derived from each input's directory rather than from a fixed list, so
 *   the project scope is picked up wherever the file happens to live.
 * - **Global scopes.** The user settings and any managed settings.
 *
 * Only files that exist are returned, so a machine without managed settings
 * simply contributes fewer scopes rather than erroring. Discovery never returns
 * a path already present in `inputs`.
 */
export function discoverMergedScopes(inputs?: readonly string[] | null): string[] {
  const given = [...(inputs ?? [])];
  const seen = new Set(given.filter(pathExists).map(resolveKey));
  const found: string[] = [];

  const add = (candidate: string): void => {
    if (!isFile(candidate)) {
      return;
    }
    const resolved = resolveKey(candidate);
    if (seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    found.push(candidate);
  };

  for (const path of given) {
    for (const name of PROJECT_SCOPE_FILENAMES) {
      add(nodeJoin(parentOf(path), name));
    }
  }
  add(expanduser(USER_SETTINGS_PATH));
  for (const candidate of doctorSeams.managedSettingsPaths) {
    add(candidate);
  }
  return found;
}

/** `format_report`: human-readable rendering of a {@link DoctorReport}. */
export function formatReport(
  report: DoctorReport,
  options: { readonly verbose?: boolean } = {},
): string {
  const verbose = options.verbose ?? false;
  const failures = reportFailures(report);
  const lines: string[] = [];
  const shown = verbose ? report.findings : failures;
  lines.push(`deny targets: ${report.findings.length} (${failures.length} unusable by bwrap)`);
  for (const f of shown) {
    const marker = f.status === STATUS_OK ? "ok " : "FAIL";
    // `f"{f.source}"` is `str(source)`, not `repr`. For a container `str` IS
    // `repr` in Python (`str({"a": 1})` is `{'a': 1}`), which is the shape an
    // `unsupported-entry` finding reaches this line with, and `pyStr` is this
    // repository's transcription of exactly that split.
    lines.push(`  [${marker}] ${f.layer}: ${pyStr(f.source)}`);
    if (f.sourceFile !== "") {
      lines.push(`         from: ${f.sourceFile}`);
    }
    lines.push(`         path: ${f.path}`);
    lines.push(`         ${f.detail}`);
    if (f.suggestion !== null && f.suggestion !== "") {
      lines.push(`         suggested rewrite: ${f.suggestion}`);
    }
  }
  lines.push(`bwrap canary: ${report.canaryStatus} - ${report.canaryDetail}`);
  if (report.sandboxDisabled) {
    lines.push("");
    lines.push(
      "RESULT: sandbox.enabled is false in these settings, so no sandbox " +
        "launch can be aborted here and the check passes. Any finding " +
        "above is still latent: deny arrays merge across settings scopes, " +
        "so it becomes live as soon as another scope enables the sandbox.",
    );
  } else if (failures.length > 0 && report.canaryStatus === CANARY_PASS) {
    lines.push("");
    lines.push(
      "RESULT: bwrap started here, but the deny paths above cross an " +
        "absolute symlink and are only bindable while some mount hides " +
        "the link from the sandbox. That is not a property to depend on: " +
        "the same settings abort the launch as soon as the link is " +
        "visible. Treated as a failure; apply the suggested rewrites.",
    );
  } else if (!reportOk(report)) {
    lines.push("");
    lines.push(
      "RESULT: the sandbox will NOT start with these settings. Claude " +
        "Code falls back to running Bash commands unsandboxed, so this " +
        "fails silently unless it is checked. Re-render the worker " +
        "settings with a runtime that canonicalizes symlinked deny paths, " +
        "or set sandbox.allowUnsandboxedCommands=false to make the " +
        "fallback a hard error.",
    );
  } else {
    lines.push("RESULT: sandbox deny paths are usable by bwrap.");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `run`: the `sandbox doctor` verb.
 *
 * `args` is the parsed namespace, and the source reads three of its fields with
 * `getattr(args, name, default)` -- so a `SimpleNamespace` missing them still
 * works, which is what nine of the ported cases construct. The optional fields
 * here are that `getattr` default, spelled in the type.
 */
export interface DoctorArgs {
  /** `--settings`, `action="append"`. A bare value is accepted; see below. */
  readonly settings: string | readonly string[];
  readonly json?: boolean;
  readonly verbose?: boolean;
  readonly probe_bwrap?: boolean;
  readonly merge_scopes?: boolean;
}

export function run(args: DoctorArgs): number {
  const requested = args.settings;
  // `if not isinstance(requested, list): requested = [requested]`. One ported
  // case passes `settings=path` rather than `settings=[path]`, so this is a
  // reachable branch and not defensive padding.
  const paths: string[] = Array.isArray(requested)
    ? [...(requested as readonly string[])]
    : [requested as string];

  if ((args.merge_scopes ?? true) === true) {
    paths.push(...doctorSeams.discoverMergedScopes(paths));
  }

  const sources: SettingsSource[] = [];
  for (const path of paths) {
    const [source, error] = loadSource(path);
    if (error !== null) {
      doctorSeams.stderr(`error: ${error}\n`);
      return 2;
    }
    sources.push(source as SettingsSource);
  }

  const report = diagnoseSources(sources, { probeBwrap: args.probe_bwrap ?? true });
  if ((args.json ?? false) === true) {
    doctorSeams.stdout(
      `${pyJsonDumps(reportToJsonable(report), { indent: 2, ensureAscii: false })}\n`,
    );
  } else {
    doctorSeams.stdout(formatReport(report, { verbose: args.verbose ?? false }));
  }
  return reportOk(report) ? 0 : 1;
}
