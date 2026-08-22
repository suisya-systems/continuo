/**
 * The fence, expressed as an explicit list of *rules*.
 *
 * This module is the reason the breach-probe battery can be mechanically
 * complete. Interlock's D-0023 asks for "one forbidden operation per **rule** in
 * the role's fence, not one per role", and a hand-maintained probe list drifts
 * from the fence the moment a rule is added. So the fence is not a blob of
 * rendered JSON here: it is a list of {@link FenceRule}, each with a stable
 * {@link FenceRule.ruleId}, and `battery.ts` derives exactly one probe per rule
 * from that list. Coverage is then a set equality, not a promise.
 *
 * The same list is what {@link decide} evaluates and what the `PreToolUse` deny
 * hook enforces, so the enforcement path and the probed path cannot diverge
 * either.
 *
 * Ported from interlock `src/claude_org_runtime/fencing/rules.py` at `65f36c5`.
 *
 * ## The matching primitives are transcriptions, not approximations
 *
 * Three standard-library behaviours reach into this file's decisions, and each
 * is transcribed from CPython rather than approximated with a Node equivalent:
 * {@link fnmatchcase} (`./fnmatch.js`), and `normpath` / `expanduser`
 * (`./pypath.js`). Every one of them has a plausible-looking Node substitute
 * that disagrees with CPython in a way that makes a rule match *less* -- a
 * denial that quietly stops applying. See `docs/differential-oracle.md` and
 * `DECISIONS.md` D-0200.
 */

import { fnmatchcase } from "./fnmatch.js";
import { expanduser, normalizePath } from "./pypath.js";
import { pyRepr } from "./pyrepr.js";
import { pyStrip } from "./pysemantics.js";

/**
 * Rule layers.
 *
 * `sandbox` is checked before `permissions` because a sandbox deny is a
 * filesystem-level statement and must not be overridable by a permission rule
 * that happens to be more specific.
 */
export const LAYER_SANDBOX = "sandbox";
export const LAYER_PERMISSIONS = "permissions";

export const KIND_PERMISSION_DENY = "permission-deny";
export const KIND_SANDBOX_DENY_READ = "sandbox-deny-read";
export const KIND_SANDBOX_DENY_WRITE = "sandbox-deny-write";

/**
 * Tools a sandbox deny path is enforced against.
 *
 * `Bash` is deliberately in the write set as well: a denied write path reached
 * through a shell redirect is the same breach as one reached through the Write
 * tool.
 */
const READ_TOOLS = ["Read", "Glob", "Grep", "NotebookRead"] as const;
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"] as const;

/**
 * The token substituted for a wildcard when a witness operation is synthesized
 * from a rule.
 *
 * It has to be inert -- the battery never executes a witness, but a value that
 * reads like a real path or flag invites someone to.
 */
export const WITNESS_TOKEN = "interlock-breach-witness";

/**
 * A rule that cannot be parsed. Always fatal -- never skipped.
 *
 * Interlock's F2/V15/V16 record that codebase's habit of ignore-and-continue on
 * bad input. A fence rule that fails to parse and is dropped is a hole with no
 * probe and no error, which is precisely the failure mode the fencing work
 * exists to catch, so parsing throws instead of returning null.
 *
 * A subclass of `Error` rather than a plain one because the renderer
 * distinguishes it from a genuine bug: a `RuleSyntaxError` becomes a
 * `rule-syntax` refusal reason and the render continues collecting reasons,
 * while anything else is a defect in the renderer itself and must not be
 * dressed up as a malformed document.
 */
export class RuleSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSyntaxError";
    // Extending a built-in loses the prototype chain under a downlevel emit
    // target, and `instanceof` then silently reports false. The ported tests
    // assert refusal *type*, so a broken chain would quietly demote a type
    // assertion to a message assertion -- and `renderer.ts` routes on
    // `instanceof RuleSyntaxError` to tell a malformed document from a defect
    // in the renderer itself, so a false negative there reports a real bug as
    // a rule-syntax refusal.
    Object.setPrototypeOf(this, RuleSyntaxError.prototype);
  }
}

/**
 * No rule in this fence carries that id. The source raises `KeyError`.
 *
 * A distinct class rather than a bare `Error` because every other refusal
 * family in this port keeps its type distinct, and a caller catching this one
 * is asking a different question than a caller catching {@link
 * RuleSyntaxError}: an unknown rule id means the caller's *notion of the fence*
 * is stale -- a restart diff comparing against an id the current fence no
 * longer renders -- not that a document failed to parse.
 */
export class FenceRuleNotFound extends Error {
  constructor(ruleId: string) {
    // `str(KeyError('x'))` is `"'x'"`: KeyError's `__str__` reprs its argument
    // instead of returning it, so the quotes are part of the message interlock
    // produces and the ported tests assert on.
    super(pyRepr(ruleId));
    this.name = "FenceRuleNotFound";
    Object.setPrototypeOf(this, FenceRuleNotFound.prototype);
  }
}

/** A `Mapping[str, Any]` in the source: the tool input a hook event carries. */
export type ToolInput = Readonly<Record<string, unknown>>;

/**
 * One denial in a role's fence.
 *
 * `ruleId` is derived from the rule's own content, never assigned by hand, so
 * two renders of the same fence produce the same ids and a diff across restart
 * is meaningful.
 */
export class FenceRule {
  readonly layer: string;
  readonly kind: string;
  readonly tool: string;
  readonly spec: string;

  constructor(layer: string, kind: string, tool: string, spec: string) {
    this.layer = layer;
    this.kind = kind;
    this.tool = tool;
    this.spec = spec;
    // The source is a frozen dataclass. Freezing here keeps a caller from
    // mutating a rule out from under the id that was derived from it -- which
    // would make the restart diff compare an id to a rule that no longer
    // matches it.
    Object.freeze(this);
  }

  get ruleId(): string {
    return `${this.layer}:${this.kind}:${this.tool}:${this.spec}`;
  }

  matches(toolName: string, toolInput: ToolInput): boolean {
    if (this.kind === KIND_PERMISSION_DENY) {
      return permissionMatches(this, toolName, toolInput);
    }
    if (this.kind === KIND_SANDBOX_DENY_READ) {
      return sandboxMatches(this, toolName, toolInput, READ_TOOLS);
    }
    if (this.kind === KIND_SANDBOX_DENY_WRITE) {
      return sandboxMatches(this, toolName, toolInput, WRITE_TOOLS);
    }
    throw new RuleSyntaxError(`unknown rule kind: ${this.kind}`);
  }
}

/** The fence's answer about one tool call. */
export interface Decision {
  readonly denied: boolean;
  readonly ruleId: string | null;
  readonly layer: string | null;
  readonly reason: string;
}

/**
 * The source's `Decision(...)` constructor, with its defaults.
 *
 * A helper rather than a class because the source's dataclass is pure data and
 * its only method is `__bool__`, which has no TypeScript analogue worth having:
 * `if (decision)` would be true for *every* decision, including a
 * `denied=false` one. Making the type an interface removes the temptation --
 * there is nothing to truthiness-test, so `decision.denied` is the only way to
 * ask.
 */
export function makeDecision(
  init: { denied: boolean } & Partial<Omit<Decision, "denied">>,
): Decision {
  return Object.freeze({
    denied: init.denied,
    ruleId: init.ruleId ?? null,
    layer: init.layer ?? null,
    reason: init.reason ?? "",
  });
}

/** A rendered per-role fence: the rules, plus the settings they came from. */
export class Fence {
  readonly role: string;
  readonly roleKind: string;
  readonly permissionMode: string;
  readonly rules: readonly FenceRule[];
  readonly settings: Readonly<Record<string, unknown>>;

  constructor(init: {
    role: string;
    roleKind: string;
    permissionMode: string;
    rules: readonly FenceRule[];
    settings: Readonly<Record<string, unknown>>;
  }) {
    this.role = init.role;
    this.roleKind = init.roleKind;
    this.permissionMode = init.permissionMode;
    this.rules = Object.freeze([...init.rules]);
    this.settings = init.settings;
    Object.freeze(this);
  }

  ruleIds(): readonly string[] {
    return this.rules.map((rule) => rule.ruleId);
  }

  /**
   * The rule with this id.
   *
   * Throws {@link FenceRuleNotFound} where the source raises `KeyError`.
   * Returning `undefined` would let a caller carry on with a missing rule, and
   * every caller here is asking about a rule it believes the fence has.
   */
  rule(ruleId: string): FenceRule {
    for (const candidate of this.rules) {
      if (candidate.ruleId === ruleId) {
        return candidate;
      }
    }
    throw new FenceRuleNotFound(ruleId);
  }

  decide(toolName: string, toolInput: ToolInput): Decision {
    return decide(this, toolName, toolInput);
  }
}

/**
 * Deny-only evaluation. `denied: false` means *no opinion*, not approval.
 *
 * The fence never says "allow". Saying so would make the hook an authority on
 * permitting operations, and a bug in this file would then *widen* the worker's
 * reach rather than narrow it.
 */
export function decide(fence: Fence, toolName: string, toolInput: ToolInput): Decision {
  for (const layer of [LAYER_SANDBOX, LAYER_PERMISSIONS]) {
    for (const rule of fence.rules) {
      if (rule.layer !== layer) {
        continue;
      }
      if (rule.matches(toolName, toolInput)) {
        return makeDecision({
          denied: true,
          ruleId: rule.ruleId,
          layer: rule.layer,
          // Python renders `{rule.spec!r}` single-quoted. The reason string is
          // shown to an operator and is asserted on in the ported tests, so the
          // quoting is reproduced rather than replaced with JSON.stringify.
          reason: `${fence.role}: ${toolName} denied by ${rule.kind} rule ${pyRepr(rule.spec)}`,
        });
      }
    }
  }
  return makeDecision({ denied: false });
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/**
 * `"Bash(git push *)"` -> a {@link FenceRule}.
 *
 * A bare tool name (`"WebFetch"`) denies the whole tool.
 */
export function parsePermissionRule(raw: unknown): FenceRule {
  // Python: `not isinstance(raw, str) or not raw.strip()`. The second half is a
  // whitespace-only check, not merely an empty-string one.
  if (typeof raw !== "string" || pyStrip(raw) === "") {
    throw new RuleSyntaxError(`permission rule must be a non-empty string: ${pyRepr(raw)}`);
  }
  const text = pyStrip(raw);
  if (!text.endsWith(")")) {
    if (text.includes("(")) {
      throw new RuleSyntaxError(`unbalanced permission rule: ${pyRepr(raw)}`);
    }
    return new FenceRule(LAYER_PERMISSIONS, KIND_PERMISSION_DENY, text, "*");
  }
  // Python's `str.partition` splits at the FIRST separator and reports whether
  // one was found. `head` empty or no separator at all is unparseable.
  const body = text.slice(0, -1);
  const cut = body.indexOf("(");
  const head = cut < 0 ? body : body.slice(0, cut);
  const tail = cut < 0 ? "" : body.slice(cut + 1);
  if (head === "" || cut < 0) {
    throw new RuleSyntaxError(`unparseable permission rule: ${pyRepr(raw)}`);
  }
  return new FenceRule(LAYER_PERMISSIONS, KIND_PERMISSION_DENY, pyStrip(head), tail);
}

/**
 * A sandbox deny entry -> a {@link FenceRule}.
 *
 * Accepts the plain string form and the structured `{"path": ...}` form the v1
 * renderer grew. The `anchor` key is *not* honoured here: paths reach this
 * module already substituted, because a rule whose meaning still depends on a
 * later resolution step cannot be probed.
 */
export function parseSandboxEntry(raw: unknown, kind: string): FenceRule {
  let path: string;
  if (typeof raw === "string") {
    path = raw;
  } else if (isMapping(raw) && typeof raw["path"] === "string") {
    path = raw["path"];
  } else {
    throw new RuleSyntaxError(`unparseable sandbox entry: ${pyRepr(raw)}`);
  }
  path = pyStrip(path);
  if (path === "") {
    throw new RuleSyntaxError(`empty sandbox path: ${pyRepr(raw)}`);
  }
  if (path.includes("{") || path.includes("}")) {
    throw new RuleSyntaxError(`unsubstituted placeholder in sandbox path: ${pyRepr(path)}`);
  }
  if (process.platform !== "win32" && /^~[^/]/.test(path)) {
    // The `~user` form, under a runtime that cannot resolve it. This is the
    // same principle as the placeholder check above -- a rule whose meaning
    // still depends on a later resolution step cannot be probed -- applied to
    // an input class CPython never had to face. `posixpath.expanduser` asks the
    // `pwd` database; Node has no equivalent, so `expanduser` returns the path
    // unchanged (CPython's own lookup-failed branch), and the rule's spec is
    // then a literal `~someuser/secrets` that matches no real path. That is a
    // deny rule which silently covers nothing: no probe fails, because the
    // breach battery derives its probe from the same unexpanded spec, and no
    // error is raised. Refusing here turns that hole into a loud refusal.
    //
    // Deliberately posix-only. `ntpath.expanduser` resolves `~user` from
    // USERPROFILE / HOMEDRIVE+HOMEPATH with no `pwd` database at all, and
    // `pypath.ts` transcribes that in full -- so on Windows the resolution step
    // genuinely happens and refusing would deny a rule interlock resolves
    // correctly. The refusal is scoped to the platform that cannot resolve it,
    // exactly as `expanduser` itself dispatches on the platform.
    //
    // `~/` and a bare `~` are unaffected: they are the current user's home,
    // which `expanduser` resolves without `pwd`.
    //
    // Authority: `DECISIONS.md` D-0203. A divergence from CPython's
    // passthrough, made in the fail-closed direction.
    throw new RuleSyntaxError(`unresolvable user home in sandbox path: ${pyRepr(path)}`);
  }
  const tool = kind === KIND_SANDBOX_DENY_READ ? "Read" : "Write";
  return new FenceRule(LAYER_SANDBOX, kind, tool, normalizePath(path));
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

function permissionMatches(rule: FenceRule, toolName: string, toolInput: ToolInput): boolean {
  if (toolName !== rule.tool) {
    return false;
  }
  const subject = permissionSubject(toolName, toolInput);
  if (subject === null) {
    // A rule scoped to a tool whose subject we cannot read still denies the
    // tool: failing open here would turn an unrecognized payload shape into a
    // silent bypass.
    return true;
  }
  return specMatches(rule.spec, subject);
}

function permissionSubject(toolName: string, toolInput: ToolInput): string | null {
  if (toolName === "Bash") {
    const command = toolInput["command"];
    return typeof command === "string" ? command : null;
  }
  for (const key of ["file_path", "path", "notebook_path", "url", "pattern"]) {
    const value = toolInput[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function specMatches(spec: string, subject: string): boolean {
  if (spec === "*") {
    return true;
  }
  if (spec.endsWith(":*")) {
    // `Bash(git add:*)` is a prefix rule, not a glob.
    const prefix = spec.slice(0, -2);
    return subject === prefix || subject.startsWith(prefix);
  }
  if (hasGlobMetacharacter(spec)) {
    return fnmatchcase(subject, spec) || fnmatchcase(normalizePath(subject), normalizePath(spec));
  }
  return subject === spec || normalizePath(subject) === normalizePath(spec);
}

function sandboxMatches(
  rule: FenceRule,
  toolName: string,
  toolInput: ToolInput,
  tools: readonly string[],
): boolean {
  if (toolName === "Bash") {
    const command = toolInput["command"];
    // A substring test, not a path test: the denied path reached through a
    // shell redirect is the same breach, and the shell's own quoting means
    // there is no reliable operand to parse out.
    return typeof command === "string" && command.includes(rule.spec);
  }
  if (!tools.includes(toolName)) {
    return false;
  }
  const subject = permissionSubject(toolName, toolInput);
  if (subject === null) {
    return true;
  }
  return pathIsWithin(normalizePath(subject), rule.spec);
}

/** Python: `any(ch in spec for ch in "*?[")`. */
function hasGlobMetacharacter(spec: string): boolean {
  return spec.includes("*") || spec.includes("?") || spec.includes("[");
}

function pathIsWithin(candidate: string, root: string): boolean {
  if (hasGlobMetacharacter(root)) {
    return fnmatchcase(candidate, root);
  }
  // Python: `root.rstrip("/")` strips EVERY trailing slash, not just one.
  return candidate === root || candidate.startsWith(`${root.replace(/\/+$/, "")}/`);
}

// ---------------------------------------------------------------------------
// witness synthesis -- the input side of the breach battery
// ---------------------------------------------------------------------------

/**
 * A concrete operand that the rule matches.
 *
 * Synthesized from the rule text rather than written by hand: that is what keeps
 * the probe list from drifting away from the fence. Callers must check the
 * result with {@link FenceRule.matches} -- `battery.probesFor` does, and refuses
 * to build a battery it cannot prove complete.
 */
export function witnessSubject(rule: FenceRule): string {
  const spec = rule.spec;
  if (spec === "*") {
    return WITNESS_TOKEN;
  }
  if (spec.endsWith(":*")) {
    return pyStrip(`${spec.slice(0, -2)} ${WITNESS_TOKEN}`);
  }
  // Order matters and is the source's: `**/` before `**` before `*`, so a
  // directory-crossing glob becomes a directory rather than a bare token.
  let subject = spec.split("**/").join(`${WITNESS_TOKEN}-dir/`);
  subject = subject.split("**").join(WITNESS_TOKEN);
  subject = subject.split("*").join(WITNESS_TOKEN);
  subject = subject.split("?").join("x");
  // The source calls `os.path.expanduser` here, NOT `_normalize_path`. The
  // asymmetry is deliberate and load-bearing: the witness is an operand for a
  // probe, and normalising it would move it away from the very rule it is meant
  // to trip -- `probe_for` then rejects its own probe and the battery refuses
  // to build.
  return expanduser(subject);
}

// ---------------------------------------------------------------------------
// small Python-semantics helpers
// ---------------------------------------------------------------------------

function isMapping(value: unknown): value is Record<string, unknown> {
  // `typeof null === "object"` and arrays are objects, so both are excluded
  // explicitly. Python's `isinstance(raw, Mapping)` is true for neither.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
