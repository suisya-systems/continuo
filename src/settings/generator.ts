/**
 * The schema-driven worker `.claude/settings.local.json` generator.
 *
 * Port of interlock `src/claude_org_runtime/settings/generator.py` at `65f36c5`.
 * The 106 cases of `tests/test_settings_generator.py` map one-to-one onto
 * `test/settings/settings-generator.test.ts`; the mapping is
 * `parity/settings.settings-generator.ledger.json`.
 *
 * ## What this module decides, and why the small print matters
 *
 * It renders a role template into the settings file a worker actually runs
 * under, and on the way it makes two decisions that are security-relevant in
 * opposite directions:
 *
 * - **Layer 3 suppression** DROPS a `sandbox.filesystem.deny{Read,Write}` entry
 *   whose realpath escapes the sandbox read roots. Dropping too much is a deny
 *   that stops covering a credential file; dropping too little is a bubblewrap
 *   launch that fails, and Claude Code's documented answer to a failed launch is
 *   to retry the command with `dangerouslyDisableSandbox` -- so a kept-but-
 *   unbindable entry does not fail closed, it turns the sandbox off for every
 *   later command.
 * - **Symlink canonicalisation** REWRITES a deny path that crosses an absolute
 *   symlink to its realpath, so the deny survives and bwrap can bind it.
 *
 * Both are decided from paths, and both compose `os.path` primitives whose
 * exact answers decide the outcome. That is why `src/fencing/pypath.ts`
 * transcribes `posixpath` and `ntpath` rather than calling Node's `path`, and
 * why `parity/oracle/ospath-vector.json` checks the transcription against
 * CPython instead of against a reading of it. See D-0213.
 *
 * ## Numbers, and the obligation this module inherits
 *
 * A role template is a JSON document, so it can carry numbers, and D-0210 /
 * D-0211 make it an obligation on **every container rebuild** to carry the
 * recorded Python spelling of those numbers across. Counting FUNCTIONS instead
 * of BRANCHES is exactly what let D-0210 ship with a hole, so these are counted
 * as branches, and there are **thirteen**:
 *
 *  1. `substitute`, array branch
 *  2. `substitute`, object branch
 *  3. `pyList` -- `list(x)`, over each deny array and each `additionalDirectories`
 *  4. the `additionalDirectories` map in `evaluateSandboxSuppressions`
 *  5. the role-template copy in `renderRoleWithMetadata`
 *  6. `newFs` in `evaluateSandboxSuppressions`
 *  7. the KEPT list in `evaluateSandboxSuppressions`
 *  8. `newSandbox` in `evaluateSandboxSuppressions`
 *  9. `newFs` in `canonicalizeSandboxFilesystem`
 * 10. `newSandbox` in `canonicalizeSandboxFilesystem`
 * 11. `out` in `canonicalizeSandboxDeny`
 * 12. `out` in `canonicalizePermissionDeny`
 * 13. `newPermissions` in `renderRoleWithMetadata`
 *
 * Each one is pinned, and each pin was confirmed to fail -- for its own stated
 * reason -- with its carry removed; see the target-only block at the end of
 * `test/settings/settings-generator.test.ts`. **A new rebuild branch has to do
 * both.**
 *
 * Three of the thirteen are not a plain wholesale `carryNumberSpellings`:
 *
 * - **7 is a FILTERED copy**, so its indices do not line up with the source
 *   array's. Carrying the record wholesale would hand element 0 of the kept
 *   list the spelling recorded for element 0 of the input -- a different entry,
 *   and usually one with no spelling at all, so the number would be classified
 *   by value and written `1` where CPython writes `1.0`. It is carried per
 *   surviving element instead, re-keyed to the new index.
 * - **8/10 (`{**sandbox, "filesystem": new_fs}`) and 13
 *   (`{**permissions, "deny": ...}`) REPLACE the value under a key they keep**,
 *   which is the case `carryNumberSpellings` warns about. Both replacements are
 *   containers, and a spelling is only ever consulted for a value that is still
 *   a number, so the wholesale carry is correct here -- stated rather than
 *   assumed, because the next such rebuild may not be.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { pyJsonDumps, pyJsonLoads } from "../fencing/pyjson.js";
import {
  expanduser,
  OS_CURDIR,
  OS_PARDIR,
  osAltsep,
  osDirname,
  osIsabs,
  osIslink,
  osJoin,
  osNormpath,
  osReadlink,
  osRealpath,
  osSep,
  osSplitdrive,
} from "../fencing/pypath.js";
import { pyRepr } from "../fencing/pyrepr.js";
import {
  carryNumberSpellings,
  getOwn,
  isPlainObject,
  PyKeyError,
  type PyNumberSpelling,
  PyTypeError,
  PyValueError,
  pyEntries,
  pyIterate,
  pyKeys,
  pyNumberSpelling,
  pyOr,
  pyStr,
  pyTruthy,
  pyTypeName,
  rememberKeyOrder,
  rememberNumberSpellings,
  setOwn,
} from "../fencing/pysemantics.js";

/**
 * Keys under `worker_roles[<role>]` / `roles[<role>]` that are *not* part of
 * the emitted `settings.local.json` content.
 */
const META_KEYS: ReadonlySet<string> = new Set(["description", "$comment", "sandbox_by_pattern"]);

/**
 * WSL kernel markers as exposed by `/proc/version` + `/proc/sys/kernel/osrelease`.
 *
 * `microsoft-standard-WSL` keeps the legacy precise marker so historical
 * fixtures continue to match; `Microsoft` / `WSL` add coverage for WSL1 and
 * proc/version-only detection paths.
 */
const WSL_MARKERS: readonly string[] = ["microsoft-standard-WSL", "Microsoft", "WSL"];

const DEFAULT_WSL_PROBE_PATHS: readonly string[] = ["/proc/version", "/proc/sys/kernel/osrelease"];

const VALID_ANCHORS: readonly string[] = [
  "home",
  "worker_dir",
  "claude_org_path",
  "base_clone",
  "absolute",
];

const VALID_PATTERNS: readonly string[] = ["A", "B", "C"];

/**
 * Layer 2 tools whose argument is a filesystem path.
 *
 * `Read` / `Edit` are the pair Claude Code's sandbox docs name as contributing
 * to the bwrap deny set; `Write` is included because this repo's own schema
 * treats it as a Layer 2 filesystem deny. Canonicalising a rule that turns out
 * not to reach bwrap is harmless -- the realpath form denies the same files --
 * whereas omitting one that does reach it leaves the launch failure in place.
 */
const PERMISSION_PATH_TOOLS: readonly string[] = ["Read", "Edit", "Write"];

const ROLE_KIND_TO_SCHEMA_KEY: ReadonlyMap<string, string> = new Map([
  ["worker", "worker_roles"],
  ["org", "roles"],
]);

/**
 * Pattern B context placeholders, and the flag whose absence leaves each one
 * unresolved. Insertion order is the order `visit` reports a hit in.
 */
const PATTERN_B_PLACEHOLDER_FLAGS: ReadonlyMap<string, string> = new Map([
  ["{base_clone}", "--base-clone"],
  ["{task_id}", "--task-id"],
  ["{branch_ref}", "--branch-ref"],
]);

// ---------------------------------------------------------------------------
// seams
// ---------------------------------------------------------------------------

/**
 * The module attributes interlock's suite replaces with `monkeypatch.setattr`,
 * and the two streams `redirect_stdout` / `capsys` capture.
 *
 * `_absolute_symlink_in_chain` is here because the source's autouse fixture
 * patches exactly that name -- "keep these unit tests off the host filesystem"
 * -- and Python resolves a module-level name at CALL time, so the replacement
 * reaches `_canonicalize_escaping_path`'s default. An ESM import binding cannot
 * be rebound from outside, so the call site goes through this record instead;
 * `docs/test-translation-conventions.md` rule 5 covers the shape and the
 * liveness test each seam owes.
 */
export const generatorSeams = {
  /** `generator._absolute_symlink_in_chain`. */
  absoluteSymlinkInChain: (path: string): string | null => absoluteSymlinkInChain(path),
  /** `sys.stdout.write`. */
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  /** `print(..., file=sys.stderr)`, newline included by the caller. */
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
};

// ---------------------------------------------------------------------------
// the schema
// ---------------------------------------------------------------------------

/**
 * Path to the schema bundled with the package.
 *
 * `fileURLToPath`, never `URL.pathname`: on Windows the latter yields a
 * leading-slash form every filesystem call rejects, and on every platform it is
 * percent-encoded, so a checkout under a directory containing a space resolves
 * to `.../my%20worker/role_configs_schema.json`. `bundledDocumentPath` in
 * `renderer.ts` carries the same note for the same reason.
 */
export function bundledSchemaPath(): string {
  return fileURLToPath(new URL("./role_configs_schema.json", import.meta.url));
}

/** `FileNotFoundError`, which is the only `OSError` the CLI turns into rc 2. */
export class SchemaNotFoundError extends Error {
  /** `exc.filename`. */
  readonly filename: string;

  constructor(filename: string, message: string) {
    super(message);
    this.name = "SchemaNotFoundError";
    this.filename = filename;
    Object.setPrototypeOf(this, SchemaNotFoundError.prototype);
  }
}

/**
 * `load_schema`: the role-configs schema, `None` -> bundled SoT.
 *
 * Three failure modes, kept apart exactly as the source keeps them: a missing
 * file is a `FileNotFoundError` the CLI reports as rc 2; malformed JSON is a
 * `JSONDecodeError` it also reports as rc 2; and a byte sequence that is not
 * UTF-8 is a `UnicodeDecodeError`, which the source does NOT catch. The strict
 * decoder is what keeps the third one a stop: `readFileSync(p, "utf8")`
 * substitutes U+FFFD for an undecodable byte and never fails, so a schema with
 * one stray byte inside `Bash(git push *)` would render a healthy-looking
 * settings file in which that deny rule has silently become unmatchable.
 *
 * `pyJsonLoads`, not `JSON.parse`: the document's key order and the Python
 * spelling of every number in it are both part of the bytes this renders back
 * out, and `JSON.parse` destroys both.
 */
export function loadSchema(path?: string | null): Record<string, unknown> {
  const target = path ?? bundledSchemaPath();
  let bytes: Buffer;
  try {
    bytes = readFileSync(target);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SchemaNotFoundError(target, `${target}: no such file or directory`);
    }
    // Every other OSError propagates, as it does in the source: the CLI catches
    // `FileNotFoundError` alone, so a permission error is a crash there too.
    throw exc;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = pyJsonLoads(text);
  if (!isPlainObject(parsed)) {
    // `json.load` returning a non-dict is not an error in the source either;
    // the AttributeError arrives at the first `.get`. Reported here instead,
    // at the same fail-closed moment, with the type named.
    throw new PyTypeError(`schema is not a JSON object: got ${pyTypeName(parsed)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// substitution
// ---------------------------------------------------------------------------

/**
 * `_substitute`.
 *
 * `str.replace` in Python replaces EVERY occurrence; JavaScript's
 * `String.prototype.replace` with a string pattern replaces only the first.
 * `split`/`join` is the all-occurrences form, and the difference is reachable:
 * `additionalDirectories: ["{worker_dir}/a", "{worker_dir}/b"]` is two entries,
 * but `"{base_clone}/.git/worktrees/{base_clone}"` is one string with two.
 *
 * The mapping is iterated in insertion order, so a replacement value that
 * itself contains a later placeholder IS substituted again -- the source's
 * behaviour, not a bug being reproduced: `_reject_unresolved_pattern_b_placeholders`
 * is what catches the case the operator got wrong.
 */
function substitute(value: unknown, mapping: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const [placeholder, replacement] of mapping) {
      out = out.split(`{${placeholder}}`).join(replacement);
    }
    return out;
  }
  if (Array.isArray(value)) {
    // A mapped array is a NEW container, 1:1 with the old one, so the number
    // spellings ride across on the same indices. @see the module header.
    return carryNumberSpellings(
      value,
      value.map((v) => substitute(v, mapping)),
    );
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    const keys = pyKeys(value);
    for (const k of keys) {
      setOwn(out, k, substitute(getOwn(value, k), mapping));
    }
    return carryNumberSpellings(value, rememberKeyOrder(out, keys));
  }
  return value;
}

/** `list(x)`, keeping the number spellings a 1:1 copy would otherwise drop. */
function pyList(value: unknown): unknown[] {
  return carryNumberSpellings(value, pyIterate(value));
}

// ---------------------------------------------------------------------------
// WSL detection
// ---------------------------------------------------------------------------

/**
 * `_detect_wsl`: annotation-only WSL detection.
 *
 * The result is recorded in the suppression metadata and in the emitted
 * `$comment` `platform=` prefix, but does NOT gate the suppression decision --
 * escape is judged from realpath, so devcontainer and non-WSL symlink-escape
 * cases suppress too.
 *
 * The decode is strict and OUTSIDE the `catch`, because the source's
 * `except OSError` does not cover `UnicodeDecodeError` either: a `/proc/version`
 * that is not UTF-8 aborts detection rather than silently reading as though the
 * markers were absent, which is the answer that would quietly relabel a WSL
 * host `platform=linux`.
 */
export function detectWsl(probePaths: readonly string[] = DEFAULT_WSL_PROBE_PATHS): boolean {
  for (const path of probePaths) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (const marker of WSL_MARKERS) {
      if (content.includes(marker)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * `_literal_path_prefix`: the leading non-glob path prefix of a pattern.
 *
 * `/etc/passwd` -> `/etc/passwd`; `/etc/**` -> `/etc`; `foo/bar` -> `foo/bar`;
 * `**\/credentials*` -> `null` (the first segment is itself a glob, so there is
 * no anchored prefix `realpath` could resolve). Patterns of the form `/*...`
 * return `null` too.
 *
 * Split on `/` on every platform, because that is what the source does: these
 * are pattern strings from a JSON document, not host paths.
 */
function literalPathPrefix(pattern: string): string | null {
  const globChars = ["*", "?", "["];
  const parts = pattern.split("/");
  if (parts.length === 0) {
    // Unreachable -- `"".split("/")` is `[""]` in both languages -- and kept
    // because the source keeps it. Removing a guard because it is currently
    // dead is how the next reader learns it was never needed.
    return null;
  }
  if (globChars.some((c) => (parts[0] as string).includes(c))) {
    return null;
  }
  const out: string[] = [];
  for (const part of parts) {
    if (globChars.some((c) => part.includes(c))) {
      break;
    }
    out.push(part);
  }
  if (out.length === 0) {
    return null;
  }
  const result = out.join("/");
  if (result === "") {
    // Pattern was `/<glob>...`; no usable anchored prefix.
    return null;
  }
  return result;
}

/** `_normalize_root`. */
function normalizeRoot(root: string): string {
  return osNormpath(root).replace(/\/+$/, "") || "/";
}

/**
 * `_is_inside_root`: is `target` (already realpath'd) inside any of `roots`?
 *
 * The roots are compared *without* an additional realpath pass. WSL and
 * devcontainer suppression hinges on the realpath'd target landing outside the
 * user-specified read roots; if the roots were realpath'd too the symlink would
 * be resolved on both sides and the escape would silently disappear.
 *
 * The boundary separator is composed from `os.sep`, so the prefix check works
 * on both POSIX and Windows -- `normpath` has already normalised either input
 * to native separators.
 */
function isInsideRoot(target: string, roots: readonly string[]): boolean {
  const targetNorm = osNormpath(target);
  const sepChar = osSep();
  for (const r of roots) {
    if (!pyTruthy(r)) {
      continue;
    }
    const normalized = normalizeRoot(r);
    if (targetNorm === normalized) {
      return true;
    }
    const boundary =
      normalized.endsWith("/") || normalized.endsWith(sepChar) ? normalized : normalized + sepChar;
    if (targetNorm.startsWith(boundary)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// context and entries
// ---------------------------------------------------------------------------

/**
 * `GeneratorContext`.
 *
 * `workerDir` and `claudeOrgPath` keep the legacy substitution semantics. The
 * Pattern B additions are optional context placeholders; `pattern` is
 * informational metadata, and the renderer does not gate behaviour on it.
 */
export interface GeneratorContext {
  readonly workerDir: string;
  readonly claudeOrgPath: string;
  readonly baseClone: string | null;
  readonly taskId: string | null;
  readonly branchRef: string | null;
  readonly pattern: string | null;
}

/**
 * `_build_substitution_mapping`.
 *
 * Optional Pattern B placeholders are only added when set, so an unknown
 * placeholder passes through untouched -- which is what keeps templates that
 * never reference Pattern B context working, and what makes
 * {@link rejectUnresolvedPatternBPlaceholders} the thing that reports the
 * operator's missing flag.
 */
function buildSubstitutionMapping(ctx: GeneratorContext): Map<string, string> {
  const mapping = new Map<string, string>([
    ["worker_dir", ctx.workerDir],
    ["claude_org_path", ctx.claudeOrgPath],
  ]);
  if (ctx.baseClone !== null) {
    mapping.set("base_clone", ctx.baseClone);
  }
  if (ctx.taskId !== null) {
    mapping.set("task_id", ctx.taskId);
  }
  if (ctx.branchRef !== null) {
    mapping.set("branch_ref", ctx.branchRef);
  }
  return mapping;
}

/**
 * `_anchor_base_path`: an anchor name resolved to its absolute base path.
 *
 * `absolute` returns `""` so the caller treats the entry path itself as
 * fully-qualified.
 */
function anchorBasePath(anchor: string, ctx: GeneratorContext): string {
  if (anchor === "home") {
    return expanduser("~");
  }
  if (anchor === "worker_dir") {
    return ctx.workerDir;
  }
  if (anchor === "claude_org_path") {
    return ctx.claudeOrgPath;
  }
  if (anchor === "base_clone") {
    if (ctx.baseClone === null) {
      throw new PyValueError(
        "sandbox entry uses anchor='base_clone' but the generator " +
          "context has no base_clone. Pattern B requires " +
          "--base-clone to resolve {base_clone}-anchored entries.",
      );
    }
    return ctx.baseClone;
  }
  if (anchor === "absolute") {
    return "";
  }
  throw new PyValueError(
    `unknown sandbox entry anchor: ${pyRepr(anchor)}. valid: ${pyRepr([...VALID_ANCHORS])}`,
  );
}

/** `_NormalizedSandboxEntry`. */
interface NormalizedSandboxEntry {
  readonly anchor: string;
  readonly path: string;
  readonly suppressOnSymlinkEscape: boolean;
  /** The operator's original entry value, so it can be surfaced untouched. */
  readonly raw: unknown;
}

/**
 * `_normalize_sandbox_entry`.
 *
 * Legacy strings keep their historical anchoring: absolute paths are
 * `anchor='absolute'`, everything else -- including `~`-prefixed strings such
 * as `~/.aws/credentials` -- is anchored at `worker_dir`. The schema flags that
 * as a legacy ambiguity the structured form was introduced to fix; the legacy
 * interpretation is kept here for backward compatibility.
 *
 * `null` means the shape is unrecognised, and the caller passes the entry
 * through to the rendered output untouched.
 */
export function normalizeSandboxEntry(entry: unknown): NormalizedSandboxEntry | null {
  if (typeof entry === "string") {
    // `osIsabs`, not `startswith("/")`. @see the note on the same repair in
    // `keptEntryString`: on POSIX the two are the same function, and on Windows
    // the slash test calls `C:\\secrets\\*` worker_dir-RELATIVE, so its
    // reachability is then judged by joining it onto the worker directory --
    // a path that names nothing, and a deny rule dropped or kept for a reason
    // that has nothing to do with the entry.
    if (osIsabs(entry)) {
      return { anchor: "absolute", path: entry, suppressOnSymlinkEscape: true, raw: entry };
    }
    return { anchor: "worker_dir", path: entry, suppressOnSymlinkEscape: true, raw: entry };
  }
  if (isPlainObject(entry)) {
    const anchor = Object.hasOwn(entry, "anchor") ? getOwn(entry, "anchor") : "worker_dir";
    if (typeof anchor !== "string" || !VALID_ANCHORS.includes(anchor)) {
      return null;
    }
    const path = getOwn(entry, "path");
    if (typeof path !== "string") {
      return null;
    }
    const suppress = Object.hasOwn(entry, "suppressOnSymlinkEscape")
      ? getOwn(entry, "suppressOnSymlinkEscape")
      : true;
    // Strict bool check: `bool('false') == True` would silently flip the
    // operator's intent, so a non-bool value makes the entry pass through to
    // the rendered output untouched. `typeof x === "boolean"` is the exact
    // counterpart -- Python's `isinstance(1, bool)` is False, and so is this.
    if (typeof suppress !== "boolean") {
      return null;
    }
    return { anchor, path, suppressOnSymlinkEscape: suppress, raw: entry };
  }
  return null;
}

// ---------------------------------------------------------------------------
// bwrap symlink canonicalisation
// ---------------------------------------------------------------------------
//
// Claude Code merges BOTH `sandbox.filesystem.deny{Read,Write}` (Layer 3) and
// the path-shaped `permissions.deny` rules (Layer 2 `Read(...)` / `Edit(...)`)
// into the single deny set it hands to bubblewrap. bwrap materialises one mount
// point per deny path inside a staging newroot BEFORE the pivot, so an ABSOLUTE
// symlink anywhere in a deny path's component chain resolves against that
// staging root, where the target does not exist yet: mount-point creation fails
// with ENOENT and bwrap aborts the whole launch.
//
// The launch failure is not fail-closed. Claude Code's documented escape hatch
// retries the command with `dangerouslyDisableSandbox`, so every subsequent
// Bash command runs unsandboxed. On WSL2 this fires whenever a credential
// directory is a symlink into `/mnt/c`, which is a very common setup.
//
// So the fix is to rewrite an escaping deny path to its realpath rather than
// drop it: the deny survives, and bwrap can bind it.

/**
 * `_absolute_symlink_in_chain`: the first component of `path` that is an
 * ABSOLUTE symlink, or `null` when the chain is clean.
 *
 * Only absolute links are reported, because relative links resolve correctly
 * inside bwrap's staging newroot. Non-absolute inputs return `null`: a
 * project-relative deny path is not a concrete host path, so it never reaches
 * bwrap as one.
 *
 * The walk emulates kernel path resolution rather than inspecting the literal
 * components, because two textual shortcuts both produce false negatives that
 * were verified to still abort bwrap: `normpath` collapses `link/..` and would
 * erase the very component to inspect, and a RELATIVE link may point at an
 * ABSOLUTE one, so checking only each literal component's immediate target
 * would clear the first and never look at the second.
 *
 * The walk starts from the path's ANCHOR rather than from `os.sep`: on Windows
 * `os.path.join('\\', 'C:')` yields the drive-relative `'C:'`, which would
 * silently rebase every subsequent component.
 */
export function absoluteSymlinkInChain(
  path: string,
  options: {
    readonly islinkFn?: (p: string) => boolean;
    readonly readlinkFn?: (p: string) => string;
    readonly maxLinks?: number;
  } = {},
): string | null {
  const islinkFn = options.islinkFn ?? osIslink;
  const readlinkFn = options.readlinkFn ?? osReadlink;
  const maxLinks = options.maxLinks ?? 40;
  if (!osIsabs(path)) {
    return null;
  }
  const sepChar = osSep();
  const alt = osAltsep();
  const normalized = alt !== null ? path.split(alt).join(sepChar) : path;
  const [drive, rest] = osSplitdrive(normalized);
  const root = drive + sepChar;
  const remaining = rest.split(sepChar).filter((p) => p !== "" && p !== OS_CURDIR);
  let resolved = root;
  let followed = 0;
  while (remaining.length > 0) {
    const part = remaining.shift() as string;
    if (part === OS_PARDIR) {
      resolved = osDirname(resolved) || root;
      continue;
    }
    const candidate = osJoin(resolved, part);
    let target: string;
    try {
      if (!islinkFn(candidate)) {
        resolved = candidate;
        continue;
      }
      target = readlinkFn(candidate);
    } catch {
      // Unreadable or racing component: not something we can canonicalise, so
      // the operator's entry is left untouched.
      return null;
    }
    if (osIsabs(target)) {
      return candidate;
    }
    followed += 1;
    if (followed > maxLinks) {
      // Bounds symlink-loop resolution the way the kernel's ELOOP limit does.
      return null;
    }
    const spliced = alt !== null ? target.split(alt).join(sepChar) : target;
    remaining.unshift(...spliced.split(sepChar).filter((p) => p !== "" && p !== OS_CURDIR));
  }
  return null;
}

/** `_split_permission_rule`: `'Read(~/.aws/*)'` -> `['Read', '~/.aws/*']`. */
function splitPermissionRule(rule: unknown): [tool: string, spec: string] | null {
  if (typeof rule !== "string" || !rule.endsWith(")")) {
    return null;
  }
  const openIdx = rule.indexOf("(");
  if (openIdx <= 0) {
    return null;
  }
  return [rule.slice(0, openIdx), rule.slice(openIdx + 1, -1)];
}

/**
 * `_permission_rule_host_path`: the absolute host path a `Read` / `Edit` rule
 * spec anchors at, or `null`.
 *
 * The rule syntax uses `//path` for an absolute path and `~/` for a
 * home-relative one; a bare or single-slash spec is project-relative. Only the
 * first two name a concrete host path Claude Code can expand into the bwrap
 * deny set. Unanchored globs land here too, which matches the observed
 * behaviour: they never made bwrap fail, because they are not expanded.
 *
 * Only the anchor is substituted; the remainder keeps the rule's own `/`
 * separators rather than being normalised to the platform's. On Windows that
 * yields a mixed spelling, which is deliberate -- the value is a
 * permission-rule path, whose grammar separates with `/`.
 */
function permissionRuleHostPath(spec: string): string | null {
  if (spec.startsWith("~/")) {
    return expanduser("~") + spec.slice(1);
  }
  if (spec.startsWith("//")) {
    return spec.slice(1);
  }
  return null;
}

/** One deny path rewritten from a symlinked form to its realpath. */
export interface SandboxPathRewrite {
  /** `"permissions.deny"` | `"sandbox.filesystem.denyRead"` | ... */
  readonly layer: string;
  readonly original: unknown;
  readonly rewritten: unknown;
  readonly symlink: string;
  readonly realpath: string;
}

/** The filesystem seam pair every canonicalising helper takes. */
interface FilesystemSeams {
  readonly realpathFn?: (p: string) => string;
  readonly symlinkProbeFn?: ((p: string) => string | null) | null;
}

/**
 * `_canonicalize_escaping_path`: rewrite a deny path whose chain crosses an
 * absolute symlink.
 *
 * Returns `[rewritten, offendingSymlink, resolvedLiteral]`, or `null` when the
 * path is already bwrap-safe. The glob tail is preserved verbatim: only the
 * leading literal prefix is canonicalised.
 *
 * `symlinkProbeFn` is the second half of the filesystem seam `realpathFn`
 * opens. Both must describe the SAME world: a caller that injects a fake
 * `realpathFn` to simulate a symlinked layout but leaves the probe reading the
 * real filesystem gets a half-real answer whose outcome depends on the host it
 * runs on. The default is read from {@link generatorSeams} at call time, which
 * is what makes the source's autouse "no host symlinks" patch reach it.
 */
function canonicalizeEscapingPath(
  absolutePath: string,
  seams: FilesystemSeams,
): [rewritten: string, symlink: string, resolved: string] | null {
  const realpathFn = seams.realpathFn ?? osRealpath;
  const probe = seams.symlinkProbeFn ?? generatorSeams.absoluteSymlinkInChain;
  const literal = literalPathPrefix(absolutePath);
  if (literal === null) {
    return null;
  }
  const link = probe(literal);
  if (link === null) {
    return null;
  }
  const resolved = realpathFn(literal);
  if (resolved === osNormpath(literal)) {
    // realpath did not actually move the path; rewriting would be a no-op that
    // only adds churn to the emitted file.
    return null;
  }
  return [resolved + absolutePath.slice(literal.length), link, resolved];
}

/**
 * `_canonicalize_permission_deny`: Layer 2 `Read` / `Edit` / `Write` rules.
 *
 * Layer 2 is not merely a tool-level guard: Claude Code folds these rules into
 * the bwrap deny set, so a `Read(~/.aws/*)` mirror kept as a compensating
 * control for a suppressed Layer 3 entry is exactly what re-injects the
 * unbindable path and takes the whole sandbox down.
 */
function canonicalizePermissionDeny(
  deny: readonly unknown[],
  seams: FilesystemSeams,
): [out: unknown[], rewrites: SandboxPathRewrite[]] {
  const out: unknown[] = [];
  const rewrites: SandboxPathRewrite[] = [];
  for (const rule of deny) {
    const parsed = splitPermissionRule(rule);
    if (parsed === null) {
      out.push(rule);
      continue;
    }
    const [tool, spec] = parsed;
    if (!PERMISSION_PATH_TOOLS.includes(tool)) {
      out.push(rule);
      continue;
    }
    const target = permissionRuleHostPath(spec);
    if (target === null) {
      out.push(rule);
      continue;
    }
    const result = canonicalizeEscapingPath(target, seams);
    if (result === null) {
      out.push(rule);
      continue;
    }
    const [rewrittenPath, link, resolved] = result;
    const newRule = `${tool}(//${rewrittenPath.replace(/^\/+/, "")})`;
    out.push(newRule);
    rewrites.push({
      layer: "permissions.deny",
      original: rule,
      rewritten: newRule,
      symlink: link,
      realpath: resolved,
    });
  }
  // 1:1 with the input, so the number spellings ride across on the same
  // indices. A non-string entry is appended unchanged at its own position.
  return [carryNumberSpellings(deny, out), rewrites];
}

/**
 * `_canonicalize_sandbox_deny`: KEPT Layer 3 deny entries.
 *
 * Escape suppression already drops entries that resolve outside the sandbox
 * read roots, but an entry can cross an absolute symlink and still land inside
 * them -- a symlinked worker_dir, for instance. Those are kept and would break
 * bwrap just the same.
 *
 * `~/`-anchored raw strings are expanded before the check, because Claude Code
 * resolves that prefix when building the deny set: `~/.aws/**` reaches bwrap as
 * an escaping absolute path even though the authored string does not start
 * with `/`.
 */
function canonicalizeSandboxDeny(
  entries: readonly unknown[],
  layer: string,
  seams: FilesystemSeams,
): [out: unknown[], rewrites: SandboxPathRewrite[]] {
  const out: unknown[] = [];
  const rewrites: SandboxPathRewrite[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      out.push(entry);
      continue;
    }
    let probe = entry;
    if (probe.startsWith("~/")) {
      probe = expanduser("~") + probe.slice(1);
    }
    // `isabs`, not `startsWith("/")`: a Windows entry begins with a drive
    // letter, which the prefix test would pass over uncanonicalised.
    if (!osIsabs(probe)) {
      out.push(entry);
      continue;
    }
    const result = canonicalizeEscapingPath(probe, seams);
    if (result === null) {
      out.push(entry);
      continue;
    }
    const [rewrittenPath, link, resolved] = result;
    out.push(rewrittenPath);
    rewrites.push({
      layer,
      original: entry,
      rewritten: rewrittenPath,
      symlink: link,
      realpath: resolved,
    });
  }
  return [carryNumberSpellings(entries, out), rewrites];
}

// ---------------------------------------------------------------------------
// suppression
// ---------------------------------------------------------------------------

/** One `sandbox.filesystem` entry that was dropped from Layer 3. */
export interface SandboxSuppression {
  readonly layer: string;
  /** The original raw-string or structured entry. */
  readonly entry: unknown;
  readonly reason: string;
  readonly realpath: string;
  readonly sandboxReadRoots: readonly string[];
}

/** `SandboxMetadata`: the suppression report `settings show --explain` prints. */
export interface SandboxMetadata {
  enabled: boolean;
  wslDetected: boolean;
  sandboxReadRoots: readonly string[];
  suppressions: SandboxSuppression[];
  rewrites: SandboxPathRewrite[];
}

/** `SandboxMetadata()` with the dataclass's field defaults. */
export function sandboxMetadata(overrides: Partial<SandboxMetadata> = {}): SandboxMetadata {
  return {
    enabled: false,
    wslDetected: false,
    sandboxReadRoots: [],
    suppressions: [],
    rewrites: [],
    ...overrides,
  };
}

/**
 * `SandboxMetadata.to_jsonable`.
 *
 * The keys are WIRE FORMAT and stay verbatim (D-0201): they are read by
 * `settings show --explain --json` consumers, so `sandbox_read_roots` is not
 * renamed to match the in-memory camelCase.
 */
export function sandboxMetadataToJsonable(metadata: SandboxMetadata): Record<string, unknown> {
  return {
    enabled: metadata.enabled,
    wsl_detected: metadata.wslDetected,
    sandbox_read_roots: [...metadata.sandboxReadRoots],
    suppressions: metadata.suppressions.map((s) => ({
      layer: s.layer,
      entry: s.entry,
      reason: s.reason,
      realpath: s.realpath,
      sandbox_read_roots: [...s.sandboxReadRoots],
    })),
    rewrites: metadata.rewrites.map((r) => ({
      layer: r.layer,
      original: r.original,
      rewritten: r.rewritten,
      symlink: r.symlink,
      realpath: r.realpath,
    })),
  };
}

/** `RenderResult`. */
export interface RenderResult {
  readonly settings: Record<string, unknown>;
  readonly sandbox: SandboxMetadata;
}

/**
 * `_kept_entry_string`: normalise a KEPT deny entry to the contract's string
 * form.
 *
 * `sandbox.filesystem.denyRead` / `denyWrite` are a list of STRINGS: the bwrap
 * launcher consumes the rendered `settings.local.json` directly, and Claude
 * Code's settings schema rejects a structured object in these arrays. Emitting
 * the internal dict shape there is the bug this fixes -- it made `/doctor`
 * report "Expected string, but received object" for every dict entry.
 *
 * Two pass-throughs: a raw-string entry is already contract-compliant, and a
 * malformed structured entry with no concrete absolute rendering (`anchor:
 * 'absolute'` paired with a RELATIVE path, i.e. an empty `anchorBase`) is kept
 * as the original dict so the launcher surfaces the operator error rather than
 * this code silently anchoring the path against the wrong base.
 */
function keptEntryString(entry: unknown, anchorBase: string, substitutedPath: string): unknown {
  if (!isPlainObject(entry)) {
    return entry;
  }
  // -- INHERITED DEFECT, REPAIRED IN PASS (D-0023, D-0213) --
  // The source tests `substituted_path.startswith("/")`. On Windows that is not
  // "is this absolute": `C:\secret` fails it, falls through to the empty-anchor
  // branch below, and is emitted as the original DICT -- which is precisely the
  // shape this function exists to stop emitting, because Claude Code's settings
  // schema answers it with "Expected string, but received object" and rejects
  // the whole file. `canonicalizeSandboxDeny` already spells the same test
  // `os.path.isabs` with a comment saying why ("a Windows entry begins with a
  // drive letter, which the prefix test would pass over"); the source author saw
  // it at one site and not at this one.
  //
  // The repair is `osIsabs`, which is IDENTICAL to `startswith("/")` on POSIX --
  // `posixpath.isabs` is that test -- so nothing changes on the platform
  // interlock runs on, and on Windows a drive-letter path is emitted as the
  // string the contract asks for. Recorded as a deliberate divergence in
  // `parity/settings.settings-generator.ledger.json`.
  if (osIsabs(substitutedPath)) {
    // Already absolute (anchor='absolute', or an absolute path under any
    // anchor): emit verbatim.
    return substitutedPath;
  }
  if (anchorBase === "") {
    return entry;
  }
  return osJoin(anchorBase, substitutedPath);
}

/**
 * `_evaluate_sandbox_suppressions`: realpath-escape suppression over
 * `sandbox.filesystem.deny{Read,Write}`.
 *
 * A deny entry is suppressed when its realpath resolves outside the sandbox's
 * read roots (`worker_dir` + `filesystem.additionalDirectories`). Layer 2
 * `permissions.deny` is untouched.
 */
function evaluateSandboxSuppressions(
  sandbox: unknown,
  ctx: GeneratorContext,
  seams: {
    readonly realpathFn?: (p: string) => string;
    readonly wslDetector?: () => boolean;
  },
): [sandbox: unknown, metadata: SandboxMetadata] {
  const realpathFn = seams.realpathFn ?? osRealpath;
  const wslDetector = seams.wslDetector ?? detectWsl;
  const metadata = sandboxMetadata({ wslDetected: wslDetector() });
  if (!isPlainObject(sandbox) || !pyTruthy(getOwn(sandbox, "enabled"))) {
    return [sandbox, metadata];
  }
  metadata.enabled = true;
  const fsCandidate = pyOr(getOwn(sandbox, "filesystem"), {});
  const fs: Record<string, unknown> = isPlainObject(fsCandidate) ? fsCandidate : {};
  const mapping = buildSubstitutionMapping(ctx);
  const additionalRaw = pyList(pyOr(getOwn(fs, "additionalDirectories"), []));
  const additional = carryNumberSpellings(
    additionalRaw,
    additionalRaw.map((a) => substitute(a, mapping)),
  );
  const readRootsRaw: unknown[] = [ctx.workerDir, ...additional];
  const readRoots: string[] = [];
  for (const r of readRootsRaw) {
    if (!pyTruthy(r)) {
      continue;
    }
    if (typeof r !== "string") {
      // `os.path.normpath` raises `TypeError: expected str, bytes or
      // os.PathLike object` for a non-string read root, at exactly this point.
      // The message is the port's own -- forging CPython's errno-shaped text
      // would launder a runtime difference into a familiar-looking lie -- but
      // the class and the position are the source's. @see D-0017.
      throw new PyTypeError(`sandbox read root is not a path: got ${pyTypeName(r)} (${pyRepr(r)})`);
    }
    readRoots.push(normalizeRoot(r));
  }
  metadata.sandboxReadRoots = readRoots;

  const newFs: Record<string, unknown> = {};
  const fsKeys = pyKeys(fs);
  for (const key of fsKeys) {
    setOwn(newFs, key, getOwn(fs, key));
  }
  carryNumberSpellings(fs, rememberKeyOrder(newFs, fsKeys));
  // Only emit additionalDirectories when the original sandbox had the key --
  // the documented contract is "forwarded as-is" except for the
  // suppression-driven mutations on deny{Read,Write}, so an absent key stays
  // absent.
  if (Object.hasOwn(fs, "additionalDirectories")) {
    setOwn(newFs, "additionalDirectories", additional);
  }
  for (const layerKey of ["denyRead", "denyWrite"] as const) {
    const entries = pyList(pyOr(getOwn(fs, layerKey), []));
    const kept: unknown[] = [];
    const keptSpellings = new Map<string, PyNumberSpelling>();
    /**
     * Append a kept entry, carrying its number spelling to the NEW index.
     *
     * The kept list is a FILTERED copy, so a wholesale carry would hand each
     * surviving entry the spelling recorded for whatever used to sit at that
     * index. @see the module header.
     */
    const push = (value: unknown, sourceIndex: number): void => {
      if (value === entries[sourceIndex]) {
        const spelling = pyNumberSpelling(entries, sourceIndex);
        if (spelling !== undefined) {
          keptSpellings.set(String(kept.length), spelling);
        }
      }
      kept.push(value);
    };
    for (const [index, entry] of entries.entries()) {
      const normalized = normalizeSandboxEntry(entry);
      if (normalized === null) {
        // Unrecognised shape: kept as-is so the launcher sees the operator's
        // original input.
        push(entry, index);
        continue;
      }
      const substitutedPath = substitute(normalized.path, mapping) as string;
      const anchorBase = anchorBasePath(normalized.anchor, ctx);
      const literal = literalPathPrefix(substitutedPath);
      // `osIsabs`, not `startswith("/")` -- the third and last site of the same
      // repair, so `C:\\*` is kept as-is on Windows exactly as `/*` is on POSIX
      // rather than being judged as a worker_dir-anchored glob.
      const absolutePattern = osIsabs(substitutedPath);

      let anchoredRelativeGlob = false;
      let targetLiteral: string;
      if (literal === null && absolutePattern) {
        // Absolute pure-glob (`/*`): without fnmatch'ing the actual filesystem
        // reachability cannot be computed, so the entry is kept as-is.
        push(keptEntryString(entry, anchorBase, substitutedPath), index);
        continue;
      }
      if (literal === null) {
        // Pure glob anchored at the entry's anchor.
        if (normalized.anchor === "absolute") {
          push(keptEntryString(entry, anchorBase, substitutedPath), index);
          continue;
        }
        targetLiteral = anchorBase;
        anchoredRelativeGlob = true;
      } else if (osIsabs(literal)) {
        targetLiteral = literal;
      } else if (anchorBase !== "") {
        // realpath the anchor base first, so target/realpath composition
        // matches the pre-Phase-1 worker_dir semantics on real filesystems.
        targetLiteral = osJoin(realpathFn(anchorBase), literal);
      } else {
        // anchor=absolute with a relative path is malformed. Resolving it
        // against CWD would produce surprising suppressions, so it is kept and
        // the launcher surfaces the issue.
        push(keptEntryString(entry, anchorBase, substitutedPath), index);
        continue;
      }

      const targetRp = realpathFn(targetLiteral);
      if (isInsideRoot(targetRp, readRoots)) {
        push(keptEntryString(entry, anchorBase, substitutedPath), index);
        continue;
      }
      if (!normalized.suppressOnSymlinkEscape) {
        push(keptEntryString(entry, anchorBase, substitutedPath), index);
        continue;
      }
      let reason: string;
      if (anchoredRelativeGlob) {
        reason = `${normalized.anchor} realpath escapes sandbox read roots (anchored relative pattern)`;
        if (normalized.anchor === "worker_dir") {
          // The legacy worker_dir wording is preserved verbatim for the common
          // case so existing operators and dashboards keep parsing it.
          reason = "worker_dir realpath escapes sandbox read roots (anchored relative pattern)";
        }
      } else {
        reason = "realpath escapes sandbox read roots";
      }
      metadata.suppressions.push({
        layer: `sandbox.filesystem.${layerKey}`,
        entry,
        reason,
        realpath: targetRp,
        sandboxReadRoots: readRoots,
      });
    }
    setOwn(newFs, layerKey, rememberNumberSpellings(kept, keptSpellings));
  }

  const newSandbox: Record<string, unknown> = {};
  const sandboxKeys = pyKeys(sandbox);
  for (const key of sandboxKeys) {
    setOwn(newSandbox, key, getOwn(sandbox, key));
  }
  setOwn(newSandbox, "filesystem", newFs);
  // `filesystem` is REPLACED by this rebuild, which is the case
  // `carryNumberSpellings` warns about -- but the replacement is a container,
  // and a spelling is only ever consulted for a value that is still a number.
  // @see the module header.
  carryNumberSpellings(
    sandbox,
    rememberKeyOrder(
      newSandbox,
      sandboxKeys.includes("filesystem") ? sandboxKeys : [...sandboxKeys, "filesystem"],
    ),
  );
  return [newSandbox, metadata];
}

/**
 * `_canonicalize_sandbox_filesystem`: Layer 3 canonicalisation, irrespective of
 * `enabled`.
 *
 * Deliberately not gated on `sandbox.enabled`: Claude Code unions the deny
 * arrays across settings scopes independently of which scope turns the sandbox
 * on, so entries rendered under a locally-disabled sandbox still reach bwrap
 * once any other scope enables it. Running one layer conditionally and the
 * other unconditionally left an escaping path in the rendered file.
 */
function canonicalizeSandboxFilesystem(
  sandbox: unknown,
  seams: FilesystemSeams,
): [sandbox: unknown, rewrites: SandboxPathRewrite[]] {
  if (!isPlainObject(sandbox)) {
    return [sandbox, []];
  }
  const fs = getOwn(sandbox, "filesystem");
  if (!isPlainObject(fs)) {
    return [sandbox, []];
  }
  const rewrites: SandboxPathRewrite[] = [];
  const newFs: Record<string, unknown> = {};
  const fsKeys = pyKeys(fs);
  for (const key of fsKeys) {
    setOwn(newFs, key, getOwn(fs, key));
  }
  carryNumberSpellings(fs, rememberKeyOrder(newFs, fsKeys));
  for (const layerKey of ["denyRead", "denyWrite"] as const) {
    const entries = getOwn(fs, layerKey);
    if (!Array.isArray(entries)) {
      continue;
    }
    const [canonical, layerRewrites] = canonicalizeSandboxDeny(
      entries,
      `sandbox.filesystem.${layerKey}`,
      seams,
    );
    rewrites.push(...layerRewrites);
    setOwn(newFs, layerKey, canonical);
  }
  if (rewrites.length === 0) {
    return [sandbox, []];
  }
  const newSandbox: Record<string, unknown> = {};
  const sandboxKeys = pyKeys(sandbox);
  for (const key of sandboxKeys) {
    setOwn(newSandbox, key, getOwn(sandbox, key));
  }
  setOwn(newSandbox, "filesystem", newFs);
  carryNumberSpellings(
    sandbox,
    rememberKeyOrder(
      newSandbox,
      sandboxKeys.includes("filesystem") ? sandboxKeys : [...sandboxKeys, "filesystem"],
    ),
  );
  return [newSandbox, rewrites];
}

/**
 * `_format_entry_for_comment`.
 *
 * Legacy raw strings render as-is. Structured entries render as
 * `<anchor>:<path>` so the anchor is preserved for the launcher's `/sandbox`
 * status display, except for `anchor=absolute` where the path is already
 * fully-qualified and the prefix would be redundant.
 */
function formatEntryForComment(entry: unknown): string {
  if (typeof entry === "string") {
    return entry;
  }
  if (isPlainObject(entry)) {
    const anchor = Object.hasOwn(entry, "anchor") ? getOwn(entry, "anchor") : "worker_dir";
    const path = Object.hasOwn(entry, "path") ? getOwn(entry, "path") : "";
    if (anchor === "absolute") {
      return pyStr(path);
    }
    return `${pyStr(anchor)}:${pyStr(path)}`;
  }
  return pyRepr(entry);
}

/**
 * `_format_suppression_comment`: the top-level `$comment`.
 *
 * The prefix `platform=<linux|wsl>, layer-3 entries suppressed: [` is
 * contract-fixed -- the launcher parses it for `/sandbox` status -- so the
 * rewrite report is appended as a separate clause rather than folded into the
 * bracket list.
 */
function formatSuppressionComment(metadata: SandboxMetadata): string {
  const platform = metadata.wslDetected ? "wsl" : "linux";
  const formatted = metadata.suppressions.map((s) => formatEntryForComment(s.entry));
  let comment = `platform=${platform}, layer-3 entries suppressed: [${formatted.join(", ")}]`;
  if (metadata.rewrites.length > 0) {
    const pairs = metadata.rewrites
      .map((r) => `${formatEntryForComment(r.original)} -> ${formatEntryForComment(r.rewritten)}`)
      .join(", ");
    comment += `; symlink-canonicalized deny paths: [${pairs}]`;
  }
  return comment;
}

/**
 * `_reject_unresolved_pattern_b_placeholders`: fail fast when the rendered
 * sandbox still contains a Pattern B placeholder.
 *
 * `substitute` only replaces placeholders whose key is in the mapping, and
 * `buildSubstitutionMapping` omits the Pattern B keys when the matching context
 * field is null. A sandbox declaring `"{base_clone}/.git/worktrees/{task_id}"`
 * rendered without those flags would produce a `settings.local.json` the bwrap
 * launcher cannot consume, so the misconfiguration is rejected at render time
 * with the flag name the operator most likely missed.
 */
function rejectUnresolvedPatternBPlaceholders(sandbox: unknown, ctx: GeneratorContext): void {
  const visit = (value: unknown): string | null => {
    if (typeof value === "string") {
      for (const placeholder of PATTERN_B_PLACEHOLDER_FLAGS.keys()) {
        if (value.includes(placeholder)) {
          return placeholder;
        }
      }
      return null;
    }
    if (Array.isArray(value)) {
      for (const v of value) {
        const hit = visit(v);
        if (hit !== null) {
          return hit;
        }
      }
      return null;
    }
    if (isPlainObject(value)) {
      for (const key of pyKeys(value)) {
        const hit = visit(getOwn(value, key));
        if (hit !== null) {
          return hit;
        }
      }
      return null;
    }
    return null;
  };

  const hit = visit(sandbox);
  if (hit === null) {
    return;
  }
  const flag = PATTERN_B_PLACEHOLDER_FLAGS.get(hit) as string;
  const patternLabel = pyTruthy(ctx.pattern) ? `--pattern ${ctx.pattern}` : "the selected pattern";
  throw new PyValueError(
    `rendered sandbox still contains the unresolved ${hit} ` +
      `placeholder; ${patternLabel} requires ${flag} so the bwrap ` +
      "launcher receives a concrete path " +
      "(sandbox.filesystem entries are consumed literally).",
  );
}

/**
 * `_select_sandbox_for_pattern`: resolve `sandbox_by_pattern` to one `sandbox`.
 *
 * Returns `null` for the legacy single-`sandbox` (or no-sandbox) case, so
 * {@link renderRoleWithMetadata} falls through to the pre-Phase-1 behaviour.
 */
function selectSandboxForPattern(options: {
  readonly role: string;
  readonly roleKind: string;
  readonly rawRole: Record<string, unknown>;
  readonly pattern: string | null;
}): unknown {
  const { role, roleKind, rawRole, pattern } = options;
  const hasSandbox = Object.hasOwn(rawRole, "sandbox");
  const hasSandboxByPattern = Object.hasOwn(rawRole, "sandbox_by_pattern");
  if (!hasSandboxByPattern) {
    // Legacy single-sandbox path; `pattern` stays informational.
    return null;
  }
  const raw = getOwn(rawRole, "sandbox_by_pattern");
  if (roleKind === "org") {
    // Key PRESENCE, not value, drives the reject, so `sandbox_by_pattern: null`
    // on an org role is still surfaced as misconfiguration.
    throw new PyValueError(
      `org role ${pyRepr(role)} declares 'sandbox_by_pattern' which is ` +
        "reserved for worker roles; org roles use the single 'sandbox' " +
        "shape (secretary / dispatcher / curator do not vary by " +
        "Pattern A/B/C).",
    );
  }
  if (hasSandbox) {
    throw new PyValueError(
      `worker role ${pyRepr(role)} declares both 'sandbox' and ` +
        "'sandbox_by_pattern'; these are mutually exclusive (the " +
        "Pattern A/B/C surfaces differ per role-pattern-sandbox-contract " +
        "in claude-org-ja docs/contracts/).",
    );
  }
  if (!isPlainObject(raw)) {
    throw new PyValueError(
      `role ${pyRepr(role)}: 'sandbox_by_pattern' must be a dict keyed ` +
        `by pattern (A/B/C); got ${pyTypeName(raw)}.`,
    );
  }
  // `.sort()` compares UTF-16 code units where CPython's `sorted()` compares
  // code points; the two agree except for astral characters, which no pattern
  // key is. `deepSortKeys` in `renderer.ts` carries the same note.
  const unknown = pyKeys(raw)
    .filter((k) => !VALID_PATTERNS.includes(k))
    .sort();
  if (unknown.length > 0) {
    throw new PyValueError(
      `role ${pyRepr(role)}: 'sandbox_by_pattern' has unknown pattern ` +
        `keys: ${pyRepr(unknown)}. valid: ${pyRepr([...VALID_PATTERNS])}`,
    );
  }
  if (pattern === null) {
    throw new PyValueError(
      `role ${pyRepr(role)} declares 'sandbox_by_pattern'; --pattern ` +
        `(one of ${pyRepr([...VALID_PATTERNS])}) is required to select ` +
        "the sandbox surface.",
    );
  }
  if (!VALID_PATTERNS.includes(pattern)) {
    throw new PyValueError(
      `unknown pattern: ${pyRepr(pattern)}. valid: ${pyRepr([...VALID_PATTERNS])}`,
    );
  }
  const selected = getOwn(raw, pattern);
  if (selected === null || selected === undefined) {
    const defined = pyKeys(raw).sort();
    throw new PyValueError(
      `role ${pyRepr(role)} declares 'sandbox_by_pattern' but has no ` +
        `entry for pattern ${pyRepr(pattern)}. defined: ${pyRepr(defined)}`,
    );
  }
  return selected;
}

/** The optional arguments `render_role_with_metadata` takes after the role. */
export interface RenderOptions {
  readonly role: string;
  readonly workerDir: string;
  readonly claudeOrgPath: string;
  readonly roleKind?: string;
  readonly baseClone?: string | null;
  readonly taskId?: string | null;
  readonly branchRef?: string | null;
  readonly pattern?: string | null;
  readonly realpathFn?: (p: string) => string;
  readonly wslDetector?: () => boolean;
  readonly symlinkProbeFn?: ((p: string) => string | null) | null;
}

/**
 * `render_role_with_metadata`: the per-role `settings.local.json` plus the
 * suppression metadata.
 *
 * `roleKind` selects which schema bucket the role is looked up in: `worker`
 * (default, `schema['worker_roles']`) preserves the pre-Phase-1 behaviour;
 * `org` looks the role up in `schema['roles']`.
 */
export function renderRoleWithMetadata(
  schema: Record<string, unknown>,
  options: RenderOptions,
): RenderResult {
  const roleKind = options.roleKind ?? "worker";
  const schemaKey = ROLE_KIND_TO_SCHEMA_KEY.get(roleKind);
  if (schemaKey === undefined) {
    throw new PyValueError(
      `unknown role_kind: ${pyRepr(roleKind)}. ` +
        `valid: ${pyRepr([...ROLE_KIND_TO_SCHEMA_KEY.keys()].sort())}`,
    );
  }
  const rolesCandidate = pyOr(getOwn(schema, schemaKey), {});
  if (!isPlainObject(rolesCandidate)) {
    // `roles.items()` on a non-mapping is an AttributeError in CPython, at this
    // point. Reported here with the type named, same fail-closed direction.
    throw new PyTypeError(
      `schema[${pyRepr(schemaKey)}] is not a mapping: got ${pyTypeName(rolesCandidate)}`,
    );
  }
  const roles = rolesCandidate;
  const available = pyEntries(roles)
    .filter(([k, v]) => !k.startsWith("$") && isPlainObject(v))
    .map(([k]) => k)
    .sort();
  const role = options.role;
  if (!Object.hasOwn(roles, role) || role.startsWith("$") || !isPlainObject(getOwn(roles, role))) {
    const kindLabel = roleKind === "worker" ? "worker role" : "org role";
    throw new PyKeyError(`unknown ${kindLabel}: ${pyRepr(role)}. available: ${pyRepr(available)}`);
  }
  const rawRole = getOwn(roles, role) as Record<string, unknown>;
  const pattern = options.pattern ?? null;
  const selectedSandbox = selectSandboxForPattern({ role, roleKind, rawRole, pattern });
  const ctx: GeneratorContext = {
    workerDir: options.workerDir,
    claudeOrgPath: options.claudeOrgPath,
    baseClone: options.baseClone ?? null,
    taskId: options.taskId ?? null,
    branchRef: options.branchRef ?? null,
    pattern,
  };

  const template: Record<string, unknown> = {};
  const templateKeys: string[] = [];
  for (const [k, v] of pyEntries(rawRole)) {
    if (META_KEYS.has(k)) {
      continue;
    }
    setOwn(template, k, v);
    templateKeys.push(k);
  }
  carryNumberSpellings(rawRole, rememberKeyOrder(template, templateKeys));
  if (Object.hasOwn(rawRole, "sandbox_by_pattern")) {
    // `selectSandboxForPattern` already validated mutual exclusivity vs the
    // legacy single `sandbox` field, so this assignment is the sole sandbox
    // source the renderer sees. The key is new, so it lands at the end of the
    // key order exactly as Python's assignment does.
    setOwn(template, "sandbox", selectedSandbox);
  }
  const rendered = substitute(template, buildSubstitutionMapping(ctx)) as Record<string, unknown>;

  const sandbox = getOwn(rendered, "sandbox");
  let metadata: SandboxMetadata;
  if (isPlainObject(sandbox)) {
    rejectUnresolvedPatternBPlaceholders(sandbox, ctx);
    const [newSandbox, evaluated] = evaluateSandboxSuppressions(sandbox, ctx, {
      ...(options.realpathFn !== undefined ? { realpathFn: options.realpathFn } : {}),
      ...(options.wslDetector !== undefined ? { wslDetector: options.wslDetector } : {}),
    });
    metadata = evaluated;
    setOwn(rendered, "sandbox", newSandbox);
  } else {
    const wslDetector = options.wslDetector ?? detectWsl;
    metadata = sandboxMetadata({ wslDetected: wslDetector() });
  }

  const seams: FilesystemSeams = {
    ...(options.realpathFn !== undefined ? { realpathFn: options.realpathFn } : {}),
    ...(options.symlinkProbeFn !== undefined ? { symlinkProbeFn: options.symlinkProbeFn } : {}),
  };
  // Both layers are canonicalised whether or not THIS role enables a sandbox:
  // Claude Code merges permissions.deny and the Layer 3 deny arrays into the
  // bwrap deny set of whatever sandbox is in effect, which may be enabled by
  // user or managed settings rather than by the rendered role.
  const [canonicalSandbox, sandboxRewrites] = canonicalizeSandboxFilesystem(
    getOwn(rendered, "sandbox"),
    seams,
  );
  if (sandboxRewrites.length > 0) {
    setOwn(rendered, "sandbox", canonicalSandbox);
    metadata.rewrites.push(...sandboxRewrites);
  }

  const permissions = getOwn(rendered, "permissions");
  if (isPlainObject(permissions) && Array.isArray(getOwn(permissions, "deny"))) {
    const [canonicalDeny, denyRewrites] = canonicalizePermissionDeny(
      getOwn(permissions, "deny") as unknown[],
      seams,
    );
    if (denyRewrites.length > 0) {
      const newPermissions: Record<string, unknown> = {};
      const permissionKeys = pyKeys(permissions);
      for (const key of permissionKeys) {
        setOwn(newPermissions, key, getOwn(permissions, key));
      }
      setOwn(newPermissions, "deny", canonicalDeny);
      // `deny` is REPLACED, and the replacement is a list. @see the module
      // header on why the wholesale carry stays correct here.
      carryNumberSpellings(
        permissions,
        rememberKeyOrder(
          newPermissions,
          permissionKeys.includes("deny") ? permissionKeys : [...permissionKeys, "deny"],
        ),
      );
      setOwn(rendered, "permissions", newPermissions);
      metadata.rewrites.push(...denyRewrites);
    }
  }

  // Emit the conditionally-required `$comment` whenever the runtime suppressed
  // at least one Layer 3 entry or rewrote a path. `$comment` is dropped from
  // the input role via META_KEYS before render, so this never overwrites
  // operator-authored metadata.
  if (metadata.suppressions.length > 0 || metadata.rewrites.length > 0) {
    setOwn(rendered, "$comment", formatSuppressionComment(metadata));
  }
  return { settings: rendered, sandbox: metadata };
}

/**
 * `render_role`: the rendered content alone.
 *
 * NOTE: when case E suppresses at least one Layer 3 entry, the renderer adds
 * back a runtime-emitted `$comment`. That is the suppression metadata surface,
 * not the operator-authored input `$comment`, which is always dropped.
 */
export function renderRole(
  schema: Record<string, unknown>,
  options: RenderOptions,
): Record<string, unknown> {
  return renderRoleWithMetadata(schema, options).settings;
}

// ---------------------------------------------------------------------------
// show output
// ---------------------------------------------------------------------------

/**
 * `_format_show_output`.
 *
 * Both variants project from the same {@link RenderResult}, so the final deny
 * set and the suppression reasons come from a single source of truth.
 */
export function formatShowOutput(
  result: RenderResult,
  role: string,
  options: { readonly explain: boolean; readonly asJson: boolean },
): string {
  if (options.asJson) {
    const payload: Record<string, unknown> = { role, settings: result.settings };
    if (options.explain) {
      setOwn(payload, "sandbox", sandboxMetadataToJsonable(result.sandbox));
    }
    return `${pyJsonDumps(payload, { indent: 2, ensureAscii: false })}\n`;
  }

  const lines: string[] = [`role: ${role}`];
  const permissions = pyOr(getOwn(result.settings, "permissions"), {});
  const deny = pyList(pyOr(getOwn(permissions, "deny"), []));
  lines.push(`permissions.deny (${deny.length}):`);
  for (const d of deny) {
    lines.push(`  - ${pyStr(d)}`);
  }

  const sandbox = getOwn(result.settings, "sandbox");
  if (isPlainObject(sandbox)) {
    lines.push(`sandbox.enabled: ${pyStr(pyTruthy(getOwn(sandbox, "enabled")))}`);
    if (pyTruthy(getOwn(sandbox, "enabled"))) {
      const fs = pyOr(getOwn(sandbox, "filesystem"), {});
      for (const key of ["denyRead", "denyWrite", "additionalDirectories"]) {
        const entries = pyList(pyOr(getOwn(fs, key), []));
        lines.push(`sandbox.filesystem.${key} (${entries.length}):`);
        for (const e of entries) {
          lines.push(`  - ${pyStr(e)}`);
        }
      }
      lines.push(
        `sandbox.failIfUnavailable: ${pyStr(pyTruthy(getOwn(sandbox, "failIfUnavailable")))}`,
      );
    }
  } else {
    lines.push("sandbox.enabled: false");
  }

  // Surface the runtime-emitted `$comment` in both --explain and bare modes, so
  // operators always see the at-a-glance suppression summary.
  const comment = getOwn(result.settings, "$comment");
  if (typeof comment === "string") {
    lines.push(`$comment: ${comment}`);
  }

  if (options.explain) {
    lines.push(`wsl_detected: ${pyStr(result.sandbox.wslDetected)}`);
    lines.push(`sandbox_read_roots (${result.sandbox.sandboxReadRoots.length}):`);
    for (const r of result.sandbox.sandboxReadRoots) {
      lines.push(`  - ${r}`);
    }
    if (result.sandbox.suppressions.length > 0) {
      lines.push(`suppressions (${result.sandbox.suppressions.length}):`);
      for (const s of result.sandbox.suppressions) {
        lines.push(
          `  - ${s.layer} entry=${pyRepr(s.entry)} reason=${pyRepr(s.reason)} realpath=${s.realpath}`,
        );
      }
    } else {
      lines.push("suppressions: (none)");
    }
    if (result.sandbox.rewrites.length > 0) {
      lines.push(`rewrites (${result.sandbox.rewrites.length}):`);
      for (const r of result.sandbox.rewrites) {
        lines.push(
          `  - ${r.layer} ${pyRepr(r.original)} -> ${pyRepr(r.rewritten)} ` +
            `(absolute symlink at ${r.symlink} -> ${r.realpath})`,
        );
      }
    } else {
      lines.push("rewrites: (none)");
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export { ROLE_KIND_TO_SCHEMA_KEY, VALID_PATTERNS };

/** Write `text` to `out`, creating the parent directory as the source does. */
function writeOut(out: string, text: string): void {
  // `args.out.parent` of a bare filename is `Path(".")`, where `dirname` of the
  // same string is `""` -- and `mkdirSync("")` throws.
  mkdirSync(osDirname(out) || OS_CURDIR, { recursive: true });
  writeFileSync(out, text, { encoding: "utf8" });
}

/** The namespace fields `run` / `runShow` read. */
export interface SettingsArgs {
  readonly role: string;
  readonly worker_dir: string;
  readonly claude_org_path: string;
  readonly out?: string | null;
  readonly schema?: string | null;
  readonly role_kind?: string;
  readonly base_clone?: string | null;
  readonly task_id?: string | null;
  readonly branch_ref?: string | null;
  readonly pattern?: string | null;
  readonly explain?: boolean;
  readonly json?: boolean;
}

/** The two schema-load failures the CLI turns into rc 2, shared by both verbs. */
function loadSchemaForCli(args: SettingsArgs): Record<string, unknown> | number {
  try {
    return loadSchema(args.schema ?? null);
  } catch (exc) {
    if (exc instanceof SchemaNotFoundError) {
      generatorSeams.stderr(`error: schema not found: ${exc.filename}\n`);
      return 2;
    }
    if (exc instanceof SyntaxError) {
      // -- ADAPTED MESSAGE (D-0017) -- CPython's `JSONDecodeError` reads
      // `Expecting value: line 1 column 1 (char 0)`; `JSON.parse`'s reads
      // `Unexpected token ...`. Forging CPython's wording would launder a
      // parser difference into a familiar-looking lie. No ported case reads it.
      generatorSeams.stderr(`error: schema is not valid JSON: ${exc.message}\n`);
      return 2;
    }
    throw exc;
  }
}

/** `run`: `settings generate`. */
export function run(args: SettingsArgs): number {
  const schema = loadSchemaForCli(args);
  if (typeof schema === "number") {
    return schema;
  }

  const roleKind = args.role_kind ?? "worker";
  if (roleKind === "org") {
    // Org-side settings.local.json files are hand-maintained. The `roles[*]`
    // schema entries describe audit constraints, not a settings template, so
    // rendering them as JSON would produce a misleading file.
    generatorSeams.stderr(
      "error: settings generate does not support --role-kind org " +
        "(org settings.local.json files are hand-maintained; " +
        "use `settings show --role-kind org` for inspection).\n",
    );
    return 2;
  }
  let rendered: Record<string, unknown>;
  try {
    rendered = renderRole(schema, {
      role: args.role,
      workerDir: args.worker_dir,
      claudeOrgPath: args.claude_org_path,
      roleKind,
      baseClone: args.base_clone ?? null,
      taskId: args.task_id ?? null,
      branchRef: args.branch_ref ?? null,
      pattern: args.pattern ?? null,
    });
  } catch (exc) {
    if (exc instanceof PyKeyError) {
      generatorSeams.stderr(`error: ${pyStr(exc.args[0])}\n`);
      return 2;
    }
    if (exc instanceof PyValueError) {
      generatorSeams.stderr(`error: ${exc.message}\n`);
      return 2;
    }
    throw exc;
  }

  const text = `${pyJsonDumps(rendered, { indent: 2, ensureAscii: false })}\n`;
  if (args.out === null || args.out === undefined) {
    generatorSeams.stdout(text);
  } else {
    writeOut(args.out, text);
  }
  return 0;
}

/** `run_show`: `settings show`. */
export function runShow(args: SettingsArgs): number {
  const schema = loadSchemaForCli(args);
  if (typeof schema === "number") {
    return schema;
  }

  let result: RenderResult;
  try {
    result = renderRoleWithMetadata(schema, {
      role: args.role,
      workerDir: args.worker_dir,
      claudeOrgPath: args.claude_org_path,
      roleKind: args.role_kind ?? "worker",
      baseClone: args.base_clone ?? null,
      taskId: args.task_id ?? null,
      branchRef: args.branch_ref ?? null,
      pattern: args.pattern ?? null,
    });
  } catch (exc) {
    if (exc instanceof PyKeyError) {
      generatorSeams.stderr(`error: ${pyStr(exc.args[0])}\n`);
      return 2;
    }
    if (exc instanceof PyValueError) {
      generatorSeams.stderr(`error: ${exc.message}\n`);
      return 2;
    }
    throw exc;
  }

  const text = formatShowOutput(result, args.role, {
    explain: args.explain === true,
    asJson: args.json === true,
  });
  if (args.out === null || args.out === undefined) {
    generatorSeams.stdout(text);
  } else {
    writeOut(args.out, text);
  }
  return 0;
}
