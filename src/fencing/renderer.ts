/**
 * The per-role fencing renderer, carried onto Interlock.
 *
 * Carried from `claude_org_runtime/settings/generator.py` per PORTING_LEDGER's
 * row for that file: the per-role permission / sandbox / hooks generation and
 * validation is the invariant that carries; the two axes that do **not** come
 * with it are named there explicitly and are refused rather than silently
 * ignored here:
 *
 * - the `transport.descriptor` allowlist derivation (classified `discard`),
 * - the A / B / C `sandbox_by_pattern` machinery (discarded with the old
 *   worker layout by D-0014).
 *
 * Refusing them matters more than dropping them. A role document that still
 * carries a discarded axis was authored against the old contract, and
 * rendering it while ignoring the axis produces a fence that is *narrower
 * than its author believed* -- exactly the silent downgrade D-0023 part 2
 * forbids.
 *
 * Everything in this module is fail-closed by construction: every validation
 * failure raises {@link FenceRefusal}, and there is no code path that returns
 * a partially rendered fence. F2/V15/V16 record how easily this codebase
 * reaches for ignore-and-continue, so the tests assert the refusal, not just
 * the absence of the bad value.
 */

import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { isAbsolute, delimiter as pathDelimiter, sep as pathSep } from "node:path";
import { fileURLToPath } from "node:url";
import { pyJsonLoads } from "./pyjson.js";
import { compilePythonRegex } from "./pyregex.js";
import { pyRepr } from "./pyrepr.js";
import {
  carryNumberSpellings,
  getOwn,
  isPlainObject,
  type PyNumberSpelling,
  pyEntries,
  pyHashable,
  pyIn,
  pyIterate,
  pyKeys,
  pyNumberSpelling,
  pyOr,
  pySet,
  pyStr,
  pyStrip,
  pyTypeName,
  pyTypeNameOf,
  rememberKeyOrder,
  rememberNumberSpellings,
  setOwn,
} from "./pysemantics.js";
import {
  Fence,
  type FenceRule,
  KIND_SANDBOX_DENY_READ,
  KIND_SANDBOX_DENY_WRITE,
  parsePermissionRule,
  parseSandboxEntry,
  RuleSyntaxError,
} from "./rules.js";
import { quote, ShlexError, split as shlexSplit } from "./shlex.js";

/**
 * Axes the ledger discards. Their presence is an authoring error, not a
 * no-op.
 */
export const DISCARDED_ROLE_KEYS: readonly string[] = [
  "sandbox_by_pattern",
  "transport",
  "transport_descriptor",
];

/** Keys on a role that describe it rather than fence it. */
const META_KEYS: ReadonlySet<string> = new Set([
  "description",
  "$comment",
  "role_kind",
  "permission_mode",
]);

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/**
 * Stable refusal identifiers; the ledger stores these strings verbatim.
 *
 * Values, not just names, are load-bearing: they are persisted and compared
 * across a restart, so a value must never change even if the field it
 * describes is renamed.
 */
export const RefusalReason = {
  DOCUMENT_UNREADABLE: "document-unreadable",
  ROLE_ABSENT: "role-absent",
  DISCARDED_AXIS: "discarded-axis",
  FORBIDDEN_ALLOW: "forbidden-allow",
  UNSUBSTITUTED_PLACEHOLDER: "unsubstituted-placeholder",
  HOOK_UNRESOLVABLE: "hook-unresolvable",
  HOOK_ABSENT: "hook-absent",
  HOOK_MATCHER_TOO_NARROW: "hook-matcher-too-narrow",
  HOOK_NOT_A_COMMAND: "hook-not-a-command",
  HOOK_INVOCATION_WRONG: "hook-invocation-wrong",
  GLOBAL_CONFIG_INVALID: "global-config-invalid",
  SANDBOX_PROFILE_ABSENT: "sandbox-profile-absent",
  RULE_SYNTAX: "rule-syntax",
  EMPTY_FENCE: "empty-fence",
  PERMISSION_MODE_INVALID: "permission-mode-invalid",
  PERMISSION_MODE_BYPASS: "permission-mode-bypass",
} as const;

export type RefusalReasonCode = (typeof RefusalReason)[keyof typeof RefusalReason];

/** One `(code, detail)` pair, in the order it was found. */
type Reason = readonly [RefusalReasonCode, string];

/**
 * A fence that could not be rendered soundly. Never downgraded.
 *
 * Carries every reason found rather than the first, so a refusal recorded in
 * the ledger explains the whole breakage instead of one symptom of it.
 *
 * `Object.setPrototypeOf` in the constructor: extending a built-in under a
 * downlevel emit target loses the prototype chain, and `instanceof` then
 * silently reports false. Ported tests assert refusal *type*, so a broken
 * chain would turn a type assertion into a message assertion without saying
 * so.
 */
export class FenceRefusal extends Error {
  readonly role: string;
  readonly reasons: readonly Reason[];

  constructor(role: string, reasons: readonly Reason[]) {
    const detail = reasons.map(([code, d]) => `${code}: ${d}`).join("; ");
    // `f"fence refused for role {role!r}: ..."`, and `!r` is `pyRepr`, not a
    // pair of hand-written quotes. A JSON object key can hold ANY character,
    // and `renderFence(role, ...)` takes an arbitrary caller string on top of
    // that, so the three cases a bare wrap gets wrong are all reachable:
    // `it's` makes CPython switch to DOUBLE quotes, a backslash is doubled,
    // and a control character becomes an escape -- where a bare wrap writes
    // the RAW control character into a refusal an operator reads on a
    // terminal, which is the one failure here that is not merely cosmetic.
    super(`fence refused for role ${pyRepr(role)}: ${detail}`);
    this.name = "FenceRefusal";
    this.role = role;
    this.reasons = [...reasons];
    Object.setPrototypeOf(this, FenceRefusal.prototype);
  }

  get codes(): readonly RefusalReasonCode[] {
    return this.reasons.map(([code]) => code);
  }

  toJson(): { role: string; reasons: { code: RefusalReasonCode; detail: string }[] } {
    return {
      role: this.role,
      reasons: this.reasons.map(([code, detail]) => ({ code, detail })),
    };
  }
}

/**
 * Everything a rendered fence needs substituted into it.
 *
 * `fencePath` is where Interlock persists the rendered fence for the deny
 * hook to read back. It is an input rather than an output because the hook
 * command line embeds it, and a hook whose fence path is decided after the
 * settings are written would name a file that does not exist yet.
 */
export class FenceContext {
  readonly interlockRoot: string;
  readonly workerDir: string;
  readonly claudeOrgPath: string;
  readonly hookScript: string;
  readonly fencePath: string;
  /**
   * The interpreter the deny hook runs under.
   *
   * The source defaults this to `sys.executable or "python3"`: the
   * *running* interpreter rather than a literal name, because `python3` is
   * frequently absent on Windows (only `python.exe` / `py.exe` exist), which
   * would make every render refuse with `hook-unresolvable`, and because the
   * hook has to import Interlock, so the one interpreter guaranteed to be
   * able to is the one Interlock is running on.
   *
   * -- DEVIATION (recorded decision, flagged in the port report) --
   * Continuo's hook is a Node script, not a Python one, so "the running
   * interpreter" is `process.execPath` (Node's equivalent of
   * `sys.executable`: the absolute path to the binary currently executing),
   * not a Python executable at all. The `{python}` placeholder name is kept
   * verbatim because it is wire vocabulary shared with role documents carried
   * verbatim from interlock (see `roles.json`, whose bytes are pinned by
   * `test/contract/carried-documents.test.ts`); what changes is only
   * what the default resolves to. There is no `"python3"` fallback because
   * `process.execPath` is documented by Node to always be an absolute path
   * -- unlike `sys.executable`, which Python's own docs say can be an empty
   * string in embedded contexts.
   */
  readonly python: string;
  readonly extra: Readonly<Record<string, string>>;

  constructor(init: {
    readonly interlockRoot: string;
    readonly workerDir: string;
    readonly claudeOrgPath: string;
    readonly hookScript: string;
    readonly fencePath: string;
    readonly python?: string;
    readonly extra?: Readonly<Record<string, string>>;
  }) {
    // The source declares these five fields as `pathlib.Path`, and every
    // read of them goes through `str()`. `str(Path(x))` is not the identity:
    // it drops `.` components, collapses runs of separators, drops a
    // trailing separator, and on Windows rewrites `/` to `\`. A TypeScript
    // port that holds plain strings makes `String(x)` a no-op and therefore
    // renders a *different* fence for a caller who passed a non-canonical
    // path.
    //
    // Normalising here, at construction, rather than at each read is what
    // keeps that faithful: in the source there is no observable form of
    // these fields other than the `str()` of the Path, so a context that
    // stores the canonical form is indistinguishable from one that stores a
    // Path -- and it leaves no read site able to forget the conversion.
    //
    // The failure modes this prevents run in both directions, so neither is
    // safe to leave: `hook_script: "dir/./hook.py"` substitutes a
    // `{hook_script}` the `commandRunsHook` token comparison then fails to
    // match, so the render refuses with `hook-absent` for a hook that is
    // actually wired (fails closed, but wrongly); and `fence_path:
    // "/a//b.json"` makes the `--fence` comparison in `checkInvocation`
    // reject a command the source accepts, producing a different reason set
    // than the ledger records.
    this.interlockRoot = pyStrPath(init.interlockRoot);
    this.workerDir = pyStrPath(init.workerDir);
    this.claudeOrgPath = pyStrPath(init.claudeOrgPath);
    this.hookScript = pyStrPath(init.hookScript);
    this.fencePath = pyStrPath(init.fencePath);
    // `python` is a `str` in the source, not a Path, so it is NOT normalised
    // -- normalising it would diverge in the other direction.
    this.python = init.python ?? process.execPath;
    this.extra = init.extra ?? {};
  }

  mapping(): Record<string, string> {
    const base: Record<string, string> = {
      // Already canonical: the constructor applied `str(Path(...))` once.
      interlock_root: this.interlockRoot,
      worker_dir: this.workerDir,
      claude_org_path: this.claudeOrgPath,
      hook_script: this.hookScript,
      fence_path: this.fencePath,
      python: this.python,
    };
    // The source is `{str(k): str(v) for k, v in self.extra.items()}`. Keys
    // out of `Object.entries` are already strings; `pyStr` on the value is
    // the identity for the declared `string` type and keeps the conversion
    // honest for an untyped caller reaching this through JavaScript.
    for (const [k, v] of Object.entries(this.extra)) {
      base[k] = pyStr(v);
    }
    return base;
  }
}

/**
 * Where the bundled `roles.json` lives relative to this module.
 *
 * The source resolves this through `importlib.resources.files`, which finds
 * the file inside whatever installed package it ships in. There is no
 * packaging equivalent to resolve here -- `roles.json` sits beside this
 * module in the source tree and is bundled with it -- so the direct
 * `import.meta.url`-relative path is the honest translation, not a
 * simplification.
 *
 * `fileURLToPath`, never `URL.pathname`. `.pathname` is the URL's *encoded*
 * path component, and it fails in two separate ways this project is already
 * on notice for:
 *
 * - On Windows it yields a leading-slash form (`/C:/checkout/roles.json`)
 *   that `readFileSync` rejects, so the bundled document would be
 *   unreadable on the platform CLAUDE.md names as the standing hazard.
 * - On *every* platform it is percent-encoded, so a checkout under a
 *   directory containing a space resolves to `.../my%20worker/roles.json`
 *   and opens with ENOENT.
 *
 * Both failures surface as a `document-unreadable` refusal rather than a
 * crash, which is the fail-closed direction but still the wrong answer: no
 * role renders at all. CLAUDE.md flags the file-URL-to-path conversion
 * (`pathToFileURL` and its inverse) as a known trap for exactly this
 * reason.
 */
export function bundledDocumentPath(): string {
  return fileURLToPath(new URL("./roles.json", import.meta.url));
}

/** The document's shape: the parts this module reads out of it. */
export interface RoleDocument {
  readonly roles: Readonly<Record<string, unknown>>;
  readonly global?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export function loadDocument(path?: string): RoleDocument {
  const target = path ?? bundledDocumentPath();
  // Read the bytes, decode them separately, and parse separately. The source
  // does `target.open(encoding="utf-8")` inside a `try` that catches ONLY
  // `OSError` and `json.JSONDecodeError`, so the third failure -- a
  // `UnicodeDecodeError` from a byte sequence that is not UTF-8 -- propagates
  // and aborts the render. Splitting the three steps is what lets each one
  // land where the source puts it.
  let bytes: Buffer;
  try {
    bytes = readFileSync(target);
  } catch (exc) {
    // -- ADAPTED MESSAGE (D-0017) --
    // The source embeds `str(exc)` for the OSError, which on CPython reads
    // `[Errno 2] No such file or directory: '/x'`. Node's own message for
    // the same condition is `ENOENT: no such file or directory, open '/x'`.
    // The two cannot be reconciled without hand-forging an errno string,
    // and forging it would be worse than the divergence: it would report a
    // Python errno text for a failure Node classified, so a future runtime
    // difference (a different errno, a different failing syscall) would be
    // laundered into a familiar-looking lie. The refusal CODE
    // (`document-unreadable`) is the part the ledger and every caller
    // compare, and that is byte-identical; only the free-text detail
    // differs. Recorded as an adapted row under D-0017.
    throw new FenceRefusal("<document>", [
      [RefusalReason.DOCUMENT_UNREADABLE, `${target}: ${describe(exc)}`],
    ]);
  }
  // `readFileSync(target, "utf-8")` -- and `Buffer.toString("utf8")` under it
  // -- SUBSTITUTES U+FFFD for every undecodable byte and never fails. A
  // roles.json carrying one stray byte inside `Bash(curl *)` would therefore
  // render a complete, healthy-looking fence in which that rule has silently
  // become `Bash(cu\uFFFDrl *)`, which no real command will ever match -- and
  // the breach battery would stay green, because `witnessSubject` builds its
  // probe out of the same corrupted spec, so the probe misses the same way the
  // fence does. The strict decoder is what makes the byte a stop.
  //
  // The `TypeError` it throws is deliberately NOT wrapped in a `FenceRefusal`:
  // the source does not catch `UnicodeDecodeError` either, and turning an
  // abort into a structured refusal would hand callers a refusal reason for a
  // condition interlock never produces one for. D-0015 established the same
  // strict decode for migration step files; there the source DOES refuse, so
  // there it is wrapped. The decoder is the shared part, not the handling.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let document: unknown;
  try {
    // `pyJsonLoads`, not `JSON.parse`: the document's SOURCE KEY ORDER is part
    // of the behaviour. `Object.entries` on a parsed object hoists
    // integer-like keys to the front, which reorders both `repr()` of a dict
    // inside a refusal message and the reasons `_check_placeholders` emits.
    // The parse errors are still `JSON.parse`'s, unchanged.
    document = pyJsonLoads(text);
  } catch (exc) {
    throw new FenceRefusal("<document>", [
      [RefusalReason.DOCUMENT_UNREADABLE, `${target}: ${describe(exc)}`],
    ]);
  }
  if (!isPlainObject(document) || !isPlainObject((document as Record<string, unknown>).roles)) {
    throw new FenceRefusal("<document>", [
      [RefusalReason.DOCUMENT_UNREADABLE, `${target}: no 'roles' object`],
    ]);
  }
  return document as RoleDocument;
}

export function roleNames(document?: RoleDocument): readonly string[] {
  const doc = document ?? loadDocument();
  // `[name for name in doc["roles"] if not name.startswith("$")]` iterates the
  // dict in insertion order, and callers turn this list into probe order and
  // report order.
  return pyKeys(doc.roles).filter((name) => !name.startsWith("$"));
}

/**
 * Render one role's fence, or refuse.
 *
 * There is no `strict=false`. A renderer with a lenient mode grows a caller
 * that uses it, and that caller is the downgraded spawn D-0023 forbids.
 */
export function renderFence(
  role: string,
  ctx: FenceContext,
  options?: { readonly document?: RoleDocument },
): Fence {
  const doc = options?.document ?? loadDocument();
  const reasons: Reason[] = [];
  const roles = isPlainObject(getOwn(doc, "roles"))
    ? (getOwn(doc, "roles") as Record<string, unknown>)
    : {};
  // `roles[role]` where `role` is `"__proto__"` (or `"constructor"`, or
  // `"toString"`) reads Object.prototype's member instead of a missing key.
  // For `"__proto__"` that hands back `Object.prototype` itself, which is an
  // object and therefore passes the `isPlainObject` gate, so the port walks
  // on and refuses with `sandbox-profile-absent` + `hook-absent` +
  // `empty-fence` where the source refuses with `role-absent`. Both refuse,
  // so it is not a hole today -- but it is one inherited property away from
  // being one, and the refusal reason set is what the ledger compares.
  const body = getOwn(roles, role);
  if (!isPlainObject(body)) {
    // `f"no role {role!r} in document"`.
    throw new FenceRefusal(role, [
      [RefusalReason.ROLE_ABSENT, `no role ${pyRepr(role)} in document`],
    ]);
  }

  for (const key of DISCARDED_ROLE_KEYS) {
    // `key in body` also consults the prototype chain. It is safe for
    // today's three literal key names, but it is one rename away from a
    // discarded axis called `constructor` or `toString` refusing EVERY role
    // in the document -- a spurious total refusal. `Object.hasOwn` is
    // Python's `in` on a dict: own keys only.
    if (Object.hasOwn(body, key)) {
      reasons.push([
        RefusalReason.DISCARDED_AXIS,
        // `f"{key!r} was discarded ..."`. The keys are literals today, so
        // this is the same string either way; it goes through `pyRepr`
        // anyway so that renaming a discarded axis cannot quietly introduce
        // a divergence.
        `${pyRepr(key)} was discarded by the porting ledger (R5) and may not be authored`,
      ]);
    }
  }

  const globalCfg = isPlainObject(getOwn(doc, "global"))
    ? (getOwn(doc, "global") as Record<string, unknown>)
    : {};
  // `body.get("permission_mode", "default")`: own key or the default. `in`
  // would find an inherited `permission_mode` that no author wrote.
  const permissionMode = Object.hasOwn(body, "permission_mode") ? body.permission_mode : "default";
  reasons.push(...checkPermissionMode(permissionMode, globalCfg));

  const mapping = ctx.mapping();
  const rendered = substitute(stripMeta(body), mapping) as Record<string, unknown>;
  // Hook commands are *shell strings*, not argv, so a substituted path
  // containing a space arrives as two arguments and one containing a shell
  // metacharacter arrives as something else entirely. They are re-rendered
  // from the unsubstituted source with a shell-quoted mapping.
  // `"hooks" in rendered`, prototype-safely. `rendered` is rebuilt from the
  // JSON document, so its keys are attacker-supplied in the same sense the
  // document is; `in` would answer true for `hooks` inherited from
  // Object.prototype if the name ever changed to one that exists there.
  if (Object.hasOwn(rendered, "hooks")) {
    const quotedMapping: Record<string, string> = {};
    for (const [key, value] of Object.entries(mapping)) {
      quotedMapping[key] = quote(value);
    }
    setOwn(rendered, "hooks", substitute(getOwn(stripMeta(body), "hooks"), quotedMapping));
  }
  reasons.push(...checkPlaceholders(rendered));

  // `permissions = rendered.get("permissions", {})` (renderer.py:210), then
  // `if not isinstance(permissions, dict)` (renderer.py:211). The `{}` DEFAULT
  // is the whole asymmetry: a MISSING key yields `{}`, which IS a dict, so
  // line 211 adds no reason and the role renders. A key that is PRESENT with a
  // non-dict value -- including `null` -- is refused.
  //
  // Collapsing the two (`getOwn` -> `undefined` -> not an object -> refuse)
  // costs a whole legitimate role shape: a sandbox-only role, deny paths and
  // hooks and no permissions block at all, renders in interlock and could
  // NEVER spawn here. Measured in an 800-document differential fuzz: this one
  // line was the sole cause of all 187 reason-code divergences.
  let permissions: Record<string, unknown>;
  const permissionsPresent = Object.hasOwn(rendered, "permissions");
  const renderedPermissions = permissionsPresent ? getOwn(rendered, "permissions") : {};
  if (isPlainObject(renderedPermissions)) {
    permissions = renderedPermissions;
  } else {
    reasons.push([RefusalReason.RULE_SYNTAX, "permissions must be an object"]);
    permissions = {};
  }
  // `permissions.get("allow", [])` (renderer.py:214): the default applies only
  // when the KEY IS ABSENT. An explicit `"allow": null` yields `None`, which is
  // not a list, which `_check_forbidden_allow` REFUSES. Written as `?? []` this
  // renders instead -- a document interlock rejects would be admitted, and the
  // allow list nobody validated is the one the child runs under.
  reasons.push(
    ...checkForbiddenAllow(
      Object.hasOwn(permissions, "allow") ? getOwn(permissions, "allow") : [],
      globalCfg,
    ),
  );

  const rules: FenceRule[] = [];
  let deny: unknown = Object.hasOwn(permissions, "deny") ? permissions.deny : [];
  // A string here iterates character by character and renders one rule per
  // letter -- each of which the self-battery then happily "denies", while
  // the rule that was meant is absent. Refuse the shape rather than the
  // symptom.
  if (deny === null || deny === undefined) {
    deny = [];
  } else if (!Array.isArray(deny)) {
    reasons.push([
      RefusalReason.RULE_SYNTAX,
      // `pyTypeNameOf`, not `pyTypeName(deny)`: `"deny": 1.0` is `got float` in
      // interlock and would be `got int` from the value alone, and this
      // sentence is persisted in a ledger refusal detail.
      `permissions.deny must be a list, got ${pyTypeNameOf(permissions, "deny")}`,
    ]);
    deny = [];
  }
  for (const raw of deny as unknown[]) {
    try {
      rules.push(parsePermissionRule(raw));
    } catch (exc) {
      if (exc instanceof RuleSyntaxError) {
        reasons.push([RefusalReason.RULE_SYNTAX, exc.message]);
      } else {
        throw exc;
      }
    }
  }

  const sandbox = getOwn(rendered, "sandbox");
  if (sandbox === undefined || sandbox === null) {
    reasons.push([
      RefusalReason.SANDBOX_PROFILE_ABSENT,
      // `f"role {role!r} declares no sandbox profile"`.
      `role ${pyRepr(role)} declares no sandbox profile`,
    ]);
  } else if (!isPlainObject(sandbox) || !isPlainObject(getOwn(sandbox, "filesystem"))) {
    reasons.push([
      RefusalReason.SANDBOX_PROFILE_ABSENT,
      "sandbox.filesystem is missing or not an object",
    ]);
  } else {
    const filesystem = getOwn(sandbox, "filesystem") as Record<string, unknown>;
    const axes: readonly [string, string][] = [
      ["denyRead", KIND_SANDBOX_DENY_READ],
      ["denyWrite", KIND_SANDBOX_DENY_WRITE],
    ];
    for (const [key, kind] of axes) {
      // `filesystem.get(key, [])`. `in` here would find an inherited
      // member for an axis renamed to anything Object.prototype carries,
      // and the non-list branch below would then refuse every sandbox
      // profile in the document.
      const entries = Object.hasOwn(filesystem, key) ? filesystem[key] : [];
      if (entries === null || entries === undefined) {
        continue;
      }
      if (!Array.isArray(entries)) {
        reasons.push([
          RefusalReason.RULE_SYNTAX,
          // @see the `permissions.deny` refusal above for why the container
          // and the key are passed rather than the value.
          `sandbox.filesystem.${key} must be a list, got ${pyTypeNameOf(filesystem, key)}`,
        ]);
        continue;
      }
      for (const entry of entries) {
        try {
          rules.push(parseSandboxEntry(entry, kind));
        } catch (exc) {
          if (exc instanceof RuleSyntaxError) {
            reasons.push([RefusalReason.RULE_SYNTAX, exc.message]);
          } else {
            throw exc;
          }
        }
      }
    }
  }

  reasons.push(...checkHooks(getOwn(rendered, "hooks"), ctx, role));

  const deduped = dedupe(rules);
  if (deduped.length === 0) {
    reasons.push([RefusalReason.EMPTY_FENCE, "a fence with no deny rule is not a fence"]);
  }

  if (reasons.length > 0) {
    throw new FenceRefusal(role, reasons);
  }

  // The source passes `permission_mode` to `_settings_payload` WITHOUT a
  // `str()` -- the annotation says `str`, but the value handed over is
  // whatever the document carried. The `str()` is applied only to
  // `Fence.permission_mode` on the line below. That split is observable: a
  // document whose `global.permission_modes` admits a non-string mode
  // persists the raw value in `settings.permissionMode` and the `pyStr` of
  // it in `Fence.permissionMode`. Reproduced rather than tidied, because
  // `settings` is the dict a restart diffs.
  const settings = settingsPayload(rendered, permissionMode);
  return new Fence({
    role,
    // `str(body.get("role_kind", "worker"))`. `pyStr`, not `String`: an
    // explicit `"role_kind": null` is `"None"` in the source and `"null"`
    // under `String`, and `roleKind` is part of what a restart diff
    // compares -- a mismatch there reads as "the fence changed".
    roleKind: Object.hasOwn(body, "role_kind") ? pyStr(body.role_kind) : "worker",
    permissionMode: pyStr(permissionMode),
    rules: deduped,
    settings,
  });
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

/**
 * U15's answer, encoded.
 *
 * `investigation/i04-pretooluse-fence-probe.md` measured `PreToolUse`
 * ordering under `bypassPermissions`: the hook still runs and its `deny`
 * decision still stops the tool, but `bypassPermissions` removes the
 * *permission* layer underneath it, leaving a single point of failure whose
 * sibling failure mode (A6/U35: a non-zero exit absorbed) is already on the
 * record. So the renderer refuses `bypassPermissions` outright rather than
 * rendering a one-layer fence.
 */
function checkPermissionMode(
  mode: unknown,
  globalCfg: Readonly<Record<string, unknown>>,
): Reason[] {
  // `global_cfg.get("permission_modes") or ["default", "plan", "acceptEdits"]`
  // (renderer.py:311). A truthy non-list is USED AS IS -- Python never checks
  // the type here -- and the `in` test below then means something else again:
  // key membership for an object, SUBSTRING for a string. Falling back to the
  // defaults on a non-list, as an `Array.isArray` guard does, WIDENS the set of
  // accepted modes past the one the document authorised.
  const allowed = pyOr(globalCfg.permission_modes, ["default", "plan", "acceptEdits"]);
  if (mode === "bypassPermissions") {
    return [
      [
        RefusalReason.PERMISSION_MODE_BYPASS,
        "bypassPermissions drops the permission layer and leaves the PreToolUse " +
          "hook as the only fence (U15); refused",
      ],
    ];
  }
  if (!pyIn(mode, allowed)) {
    // `sorted(allowed)` raises TypeError on mixed types in Python. That raise
    // is deliberately NOT reproduced: it can only fire on a path that is
    // already refusing, and sorting the stringified items keeps the message
    // stable for the all-strings case, which is the only one a real document
    // reaches.
    const sorted = pyIterate(allowed)
      .map((v) => pyStr(v))
      .sort();
    return [
      [
        RefusalReason.PERMISSION_MODE_INVALID,
        // `f"... is not one of {sorted(allowed)}"` interpolates a LIST,
        // whose f-string form is its `repr` -- so the brackets, the ", "
        // joiner and the per-item quoting all come from `pyRepr`, not from
        // hand-written punctuation that gets the escaping wrong for a mode
        // containing an apostrophe or a backslash.
        `permission_mode ${pyRepr(mode)} is not one of ${pyRepr(sorted)}`,
      ],
    ];
  }
  return [];
}

function checkForbiddenAllow(
  allow: unknown,
  globalCfg: Readonly<Record<string, unknown>>,
): Reason[] {
  if (!Array.isArray(allow)) {
    return [[RefusalReason.RULE_SYNTAX, "permissions.allow must be a list"]];
  }
  // `set(global_cfg.get("forbidden_allow_exact") or ())` (renderer.py:335) and
  // `for raw in global_cfg.get("forbidden_allow_regex") or ()`
  // (renderer.py:338). Python consumes ANY iterable here, and a JSON OBJECT is
  // one: `set({"Bash(rm:*)": "why"})` is `{"Bash(rm:*)"}`, so keying each
  // forbidden rule to its rationale is a working authoring shape. An
  // `Array.isArray(x) ? x : []` guard turns that document into an EMPTY
  // forbidden-allow list, which SILENTLY DISARMS THE ENTIRE GLOBAL
  // FORBIDDEN-ALLOW CHECK: every `permissions.allow` entry passes, no reason is
  // recorded, and the breach battery stays green because it probes only the
  // deny rules that were rendered.
  // `set(...)`, not `new Set(...)`: CPython's constructor REFUSES an
  // unhashable element, so a `forbidden_allow_exact` holding a nested list or
  // object raises `TypeError: unhashable type: 'list'` out of
  // `_check_forbidden_allow` -- uncaught, no `FenceRefusal`, no spawn.
  // `new Set` would store it and let the role render. See `pySet`.
  const exact = pySet(pyIterate(pyOr(globalCfg.forbidden_allow_exact, [])));
  const found: Reason[] = [];
  // The AUTHORED pattern string is carried alongside the compiled regex: the
  // refusal message interpolates `pattern.pattern`, which is what the author
  // wrote, and `RegExp.source` is the engine's normalisation of it (`""`
  // becomes `"(?:)"`, `/` gains a backslash). Naming a pattern that does not
  // appear in the global config sends the operator looking for a line that is
  // not there.
  const patterns: { readonly regex: RegExp; readonly source: string }[] = [];
  for (const raw of pyIterate(pyOr(globalCfg.forbidden_allow_regex, []))) {
    // `re.compile` takes only a string (or an already-compiled pattern) and
    // raises TypeError on anything else -- which the source catches alongside
    // `re.error` and turns into a GLOBAL_CONFIG_INVALID reason.
    // `new RegExp(String(raw))` would instead coerce `7` into the perfectly
    // valid pattern /7/, so a malformed global config would render rather than
    // refuse, and the entry the author meant as a forbidden pattern would
    // quietly forbid the digit 7 instead.
    if (typeof raw !== "string") {
      // WHICH TypeError depends on hashability, because `re.compile` consults
      // `re._cache` -- a dict keyed by the pattern -- BEFORE it type-checks:
      // `re.compile([])` raises `unhashable type: 'list'` and `re.compile(7)`
      // raises `first argument must be string or compiled pattern`. Measured
      // against CPython 3.12.3; both texts land in a ledger-persisted reason.
      found.push([
        RefusalReason.GLOBAL_CONFIG_INVALID,
        `forbidden_allow_regex entry ${pyRepr(raw)} is not a valid regex: ` +
          (pyHashable(raw)
            ? "first argument must be string or compiled pattern"
            : `unhashable type: '${pyTypeName(raw)}'`),
      ]);
      continue;
    }
    try {
      // `new RegExp(raw)` is the hole this call replaces. Python and JavaScript
      // regex dialects differ, and the differences are not all loud: Python's
      // `$` also matches just before a trailing newline, its `\w` / `\d` /
      // `\s` / `\b` are Unicode-aware where JavaScript's are ASCII-only, and
      // `{,3}` is `{0,3}` there and four literal characters here. Each one
      // makes the forbidden-allow pattern match FEWER allow entries than
      // interlock's does -- a hole with no error and no probe, since nothing
      // in the battery exercises the global config. `compilePythonRegex`
      // translates the source and THROWS for anything it cannot translate
      // faithfully; see `pyregex.ts` for the constructs it refuses and the
      // direction each residual divergence fails in.
      //
      // Whatever it throws must become a GLOBAL_CONFIG_INVALID reason and
      // never an escaping exception -- escaping here would bypass
      // FencedSpawner's refusal handling, so a broken forbidden-allow list
      // would produce no durable spawn-refused event at all. Which is also
      // what interlock does for a pattern `re` itself rejects.
      patterns.push({ regex: compilePythonRegex(raw), source: raw });
    } catch (exc) {
      found.push([
        RefusalReason.GLOBAL_CONFIG_INVALID,
        `forbidden_allow_regex entry ${pyRepr(raw)} is not a valid regex: ${describe(exc)}`,
      ]);
    }
  }
  for (const entry of allow) {
    if (typeof entry !== "string") {
      found.push([RefusalReason.RULE_SYNTAX, `allow entry not a string: ${pyRepr(entry)}`]);
      continue;
    }
    if (exact.has(entry)) {
      found.push([
        RefusalReason.FORBIDDEN_ALLOW,
        // `f"{entry!r} is on the global forbidden-allow list"`. An allow
        // entry is operator-authored text: `Bash(grep:it's)` makes CPython
        // switch to double quotes, and `Bash(sed:a\\b)` doubles the
        // backslash.
        `${pyRepr(entry)} is on the global forbidden-allow list`,
      ]);
      continue;
    }
    for (const { regex, source } of patterns) {
      // `pattern.search(entry)` is an unanchored search, which is what
      // `RegExp.prototype.test` does for a regex without the `g` flag. `g` is
      // never set here, so there is no `lastIndex` to carry between entries.
      if (regex.test(entry)) {
        found.push([
          RefusalReason.FORBIDDEN_ALLOW,
          // `f"{entry!r} matches forbidden-allow pattern {pattern.pattern!r}"`.
          // `pattern.pattern` is the string the author WROTE; `RegExp.source`
          // is what the engine normalised it to, which differs for at least
          // the empty pattern (`""` becomes `"(?:)"`) and an unescaped `/`
          // (which gains a backslash). Reporting the normalised form names a
          // pattern the operator cannot find in their global config.
          `${pyRepr(entry)} matches forbidden-allow pattern ${pyRepr(source)}`,
        ]);
        break;
      }
    }
  }
  return found;
}

/** Matchers the CLI treats as "every tool". */
const UNIVERSAL_MATCHERS: ReadonlySet<string> = new Set(["*", ".*", ""]);

function matcherIsUniversal(matcher: unknown): boolean {
  return (
    matcher === null ||
    matcher === undefined ||
    // `matcher.strip()`, not `String.prototype.trim`. The two whitespace sets
    // differ, and one of the differences lands squarely on this line: `trim`
    // also strips U+FEFF, `strip` does not. A BOM-saved role document whose
    // matcher reads `"\uFEFF*"` is NOT universal in interlock -- it refuses
    // with `hook-matcher-too-narrow` -- while `trim` turns it into `"*"` and
    // renders a fence whose deny hook the CLI scopes to a matcher it reads
    // narrowly. Every rule outside that matcher is then silently exempt, and
    // the breach battery stays green because it calls `decide` directly and
    // never consults the matcher at all. See {@link pyStrip}.
    (typeof matcher === "string" && UNIVERSAL_MATCHERS.has(pyStrip(matcher)))
  );
}

/**
 * Every hook command must name a file that exists *now*.
 *
 * "Hook path unresolvable" is one of the three broken configurations issue
 * #9 names. It is checked at render time because that is the last moment
 * before the child inherits the settings, and because the hook process
 * itself cannot report its own absence -- a missing hook does not fail, it
 * simply never runs.
 */
function checkHooks(hooks: unknown, ctx: FenceContext, role: string): Reason[] {
  if (!isPlainObject(hooks)) {
    return [[RefusalReason.HOOK_ABSENT, "no PreToolUse hooks declared"]];
  }
  const entries = (hooks as Record<string, unknown>).PreToolUse;
  if (!Array.isArray(entries) || entries.length === 0) {
    return [[RefusalReason.HOOK_ABSENT, "no PreToolUse hooks declared"]];
  }
  const problems: Reason[] = [];
  let commands = 0;
  const interlockMatchers: unknown[] = [];
  for (const group of entries) {
    if (!isPlainObject(group)) {
      problems.push([RefusalReason.RULE_SYNTAX, `hook group not an object: ${pyRepr(group)}`]);
      continue;
    }
    // `for hook in group.get("hooks", []) or []` (renderer.py:394). A STRING
    // here iterates PER CHARACTER, and each character then fails the
    // `isinstance(hook, dict)` test below and appends a `hook not a command:
    // 'o'` rule-syntax reason -- so interlock REFUSES a document whose hook
    // group is malformed. Skipping non-arrays renders a document with one good
    // hook group and one broken one CLEANLY, and the broken group's hooks
    // simply never run: the fence the operator reads is not the fence the child
    // gets.
    const groupHooks = pyIterate(pyOr(getOwn(group, "hooks"), []));
    for (const hook of groupHooks) {
      if (!isPlainObject(hook) || typeof (hook as Record<string, unknown>).command !== "string") {
        problems.push([RefusalReason.RULE_SYNTAX, `hook not a command: ${pyRepr(hook)}`]);
        continue;
      }
      const hookObj = hook as Record<string, unknown>;
      const command = hookObj.command as string;
      // Only `type: "command"` entries are executed as commands. An entry of
      // another type carrying a `command` key looks correct to a reader and
      // is never run, which is the silent direction.
      if (hookObj.type !== "command") {
        problems.push([
          RefusalReason.HOOK_NOT_A_COMMAND,
          `PreToolUse hook has type ${pyRepr(hookObj.type)}, not 'command': ${pyRepr(command)}`,
        ]);
        continue;
      }
      commands += 1;
      problems.push(...checkCommandResolves(command));
      if (commandRunsHook(command, ctx)) {
        interlockMatchers.push((group as Record<string, unknown>).matcher);
        problems.push(...checkInvocation(command, ctx, role));
      }
    }
  }
  if (commands === 0) {
    problems.push([RefusalReason.HOOK_ABSENT, "no PreToolUse command hooks declared"]);
  }
  if (interlockMatchers.length === 0) {
    problems.push([
      RefusalReason.HOOK_ABSENT,
      `no PreToolUse hook invokes Interlock's deny hook (${ctx.hookScript})`,
    ]);
  } else if (!interlockMatchers.some((m) => matcherIsUniversal(m))) {
    // A narrow matcher is the quietest hole of all: the fence still holds
    // every rule, the self-battery still denies every probe -- because it
    // calls the decision function directly -- and the CLI simply never
    // consults the hook for the tools the matcher leaves out.
    problems.push([
      RefusalReason.HOOK_MATCHER_TOO_NARROW,
      `Interlock's deny hook is scoped to matcher ${pyRepr(interlockMatchers)}; it ` +
        "must match all tools ('*'), because the fence spans Bash, Read, Write, " +
        "Edit and WebFetch rules and a narrow matcher silently exempts the rest",
    ]);
  }
  return problems;
}

/**
 * The deny hook has to be the program that actually RUNS.
 *
 * -- INTENTIONAL DIVERGENCE (D-0208; continuo is authoritative) --
 * The source decides this with a substring test (`renderer.py:412`:
 * `if str(ctx.hook_script) in command`), and that fails OPEN. A command that
 * merely MENTIONS the hook path satisfies every downstream check and is
 * rendered, while the deny hook never executes. Measured against interlock
 * itself, the command
 *
 *     /bin/echo {hook_script} --role worker --fence {fence_path}
 *
 * renders 17 rules: `checkCommandResolves` finds `/bin/echo` on PATH and the
 * script token on disk, `checkInvocation` finds `--fence` and `--role`
 * carrying the right values, and the matcher is universal. The CLI then runs
 * `echo`, and the session believes it is fenced when it is not. Interlock is
 * frozen, so the defect is repaired here rather than disclosed.
 *
 * So exactly ONE shape is accepted: argv[0] is `ctx.python` -- the interpreter
 * this renderer itself recorded -- and argv[1] is the hook script, which is
 * exactly what the shipped `{python} {hook_script} ...` renders to.
 *
 * POSITION ALONE IS NOT SUFFICIENT, and that is the crux. The command
 *
 *     true /path/hook.mjs --fence X --role worker
 *
 * puts the hook at argv[1] and would satisfy a naive position check, because
 * `true` resolves on PATH exactly as `echo` does -- and it exits 0 without
 * running the hook. It is the `argv[0] === ctx.python` half that rejects it.
 *
 * THE HOOK AT argv[0] IS NOT ACCEPTED, and that restriction is load-bearing
 * on Windows. D-0208 originally also admitted a "directly executable hook" at
 * argv[0], on the theory that the kernel would run it through its shebang.
 * The shipped `src/fencing/hook.mjs` has no shebang and is mode 0644, so on
 * POSIX `checkCommandResolves` refuses it with `hook-unresolvable`. But
 * `accessSync(path, X_OK)` on Windows is only an existence check -- Windows
 * has no executable bit -- so there the render SUCCEEDED, `cmd` cannot
 * execute a `.mjs` directly, the deny hook never launched, and the child ran
 * UNFENCED while the spawn was recorded as admitted. Windows is a required CI
 * cell (D-0003), so a branch that is sound on POSIX and open on Windows is a
 * hole, not a generalisation. Requiring the recorded interpreter closes it on
 * every platform at once, and costs nothing: all four roles in
 * `src/fencing/roles.json` -- like interlock's own non-executable `hook.py`
 * -- render `{python} {hook_script} ...`, so nothing this project ships ever
 * produced the argv[0] shape.
 *
 * A command that does not tokenise is not treated as invoking the hook; the
 * render still refuses, because `checkCommandResolves` raises `rule-syntax`
 * on the same string and, with no invoking hook left, `hook-absent` follows.
 */
function commandRunsHook(command: string, ctx: FenceContext): boolean {
  let tokens: string[];
  try {
    tokens = shlexSplit(command);
  } catch (exc) {
    if (exc instanceof ShlexError) {
      return false;
    }
    throw exc;
  }
  // Both halves, and no alternative: the recorded interpreter at argv[0] and
  // the hook script at argv[1]. See the Windows failure mode above for why
  // there is no argv[0]-only branch.
  return tokens[0] === String(ctx.python) && tokens[1] === String(ctx.hookScript);
}

/**
 * Interlock's hook has to be invoked *at Interlock's fence*.
 *
 * Containing the hook script's path is not enough. `hook.py --fence
 * /tmp/stale.json` names our hook and reads somebody else's rules, and the
 * published fence is simply never consulted -- an admitted spawn enforcing a
 * fence nobody rendered. So the flags are parsed and compared.
 */
function checkInvocation(command: string, ctx: FenceContext, role: string): Reason[] {
  const problems: Reason[] = [];
  let tokens: string[];
  try {
    tokens = shlexSplit(command);
  } catch (exc) {
    if (exc instanceof ShlexError) {
      return [[RefusalReason.RULE_SYNTAX, `unparseable hook command: ${exc.message}`]];
    }
    throw exc;
  }

  const expected: readonly (readonly [string, string])[] = [
    // Already `str(Path(...))`-canonical: FenceContext normalises on
    // construction, so this is the same string the source compares.
    ["--fence", ctx.fencePath],
    ["--role", role],
  ];
  for (const [flag, want] of expected) {
    const index = tokens.indexOf(flag);
    if (index === -1) {
      problems.push([
        RefusalReason.HOOK_INVOCATION_WRONG,
        // `f"... is invoked without {flag}: {command!r}"`.
        `Interlock's deny hook is invoked without ${flag}: ${pyRepr(command)}`,
      ]);
      continue;
    }
    const got = index + 1 < tokens.length ? tokens[index + 1] : undefined;
    if (got !== want) {
      problems.push([
        RefusalReason.HOOK_INVOCATION_WRONG,
        // `f"... is invoked with {flag}={got!r}, expected {want!r}"`. `got`
        // is `None` when the flag is last on the command line, and `pyRepr`
        // already spells `undefined` as `None`, so the ternary that used to
        // stand here was reproducing one case of `!r` by hand and getting the
        // other one (quoting, escaping) wrong.
        `Interlock's deny hook is invoked with ${flag}=${pyRepr(got)}, expected ${pyRepr(want)}`,
      ]);
    }
  }
  return problems;
}

/**
 * Both halves of a hook command must resolve: the launcher and the script.
 *
 * i04 section 5 measured an unresolvable hook failing **open** at exit 127 when it
 * was launched through `bash`. A launcher that does not exist produces the
 * same 127, so checking only the script would leave the identical hole one
 * token to the left.
 */
function checkCommandResolves(command: string): Reason[] {
  const problems: Reason[] = [];
  let tokens: string[];
  try {
    tokens = shlexSplit(command);
  } catch (exc) {
    if (exc instanceof ShlexError) {
      return [[RefusalReason.RULE_SYNTAX, `unparseable hook command: ${exc.message}`]];
    }
    throw exc;
  }
  if (tokens.length === 0) {
    return [[RefusalReason.RULE_SYNTAX, "empty hook command"]];
  }

  const launcher = tokens[0] as string;
  let resolved: boolean;
  if (launcher.includes(pathSep) || (process.platform === "win32" && launcher.includes("/"))) {
    resolved = isExecutableFile(launcher);
  } else {
    resolved = which(launcher) !== null;
  }
  if (!resolved) {
    problems.push([RefusalReason.HOOK_UNRESOLVABLE, `hook launcher not executable: ${launcher}`]);
  }

  // -- ADAPTATION (recorded decision; carried to the parity ledger) --
  // The source checks only (".sh", ".py") suffixes here, because interlock's
  // hook is a Python script. Continuo's hook is a JavaScript/TypeScript-
  // compiled file, so this ALSO checks (".mjs", ".js", ".cjs"), keeping
  // ".sh" and ".py" too. Without the added suffixes the port would render a
  // fence whose deny hook does not exist -- the exact "hook path
  // unresolvable" hole i04 measured failing OPEN at exit 127 -- so the
  // widening stays.
  //
  // It is NOT purely-stricter-and-harmless, and the known edge is recorded
  // rather than hidden: the test is a suffix test on every surviving shlex
  // token, not just on the ones that are script arguments. So a hook command
  // like
  //
  //     bash run.sh --glob '*.js'
  //
  // leaves the token `*.js` -- a glob pattern, quoted precisely so the shell
  // will NOT expand it -- which ends in ".js", names no file, and therefore
  // refuses with `hook-unresolvable` where the source renders. The
  // divergence is fail-closed (the port refuses a command interlock
  // accepts), which is the safe direction for a fence, and no role document
  // in this repository carries such a token. A role document that needs one
  // must be reworded rather than have this check relaxed.
  const scriptSuffixes = [".sh", ".py", ".mjs", ".js", ".cjs"];
  for (const token of tokens.slice(1)) {
    if (scriptSuffixes.some((suffix) => token.endsWith(suffix)) && !existsAsFile(token)) {
      problems.push([RefusalReason.HOOK_UNRESOLVABLE, `hook script not found: ${token}`]);
    }
  }
  return problems;
}

function checkPlaceholders(value: unknown, path = ""): Reason[] {
  const problems: Reason[] = [];
  if (typeof value === "string") {
    for (const match of value.matchAll(PLACEHOLDER)) {
      problems.push([
        RefusalReason.UNSUBSTITUTED_PLACEHOLDER,
        `${path || "<root>"}: {${match[1]}} was never substituted`,
      ]);
    }
  } else if (isPlainObject(value)) {
    // `for key, item in value.items()` walks a dict in INSERTION order, and
    // one reason is emitted per placeholder found, so the walk order IS the
    // reason order. `Object.entries` would report `env.2` before `env.10` for
    // a document that wrote `"10"` first.
    for (const [key, item] of pyEntries(value)) {
      problems.push(...checkPlaceholders(item, path ? `${path}.${key}` : key));
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      problems.push(...checkPlaceholders(item, `${path}[${index}]`));
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// rendering helpers
// ---------------------------------------------------------------------------

function stripMeta(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const kept: string[] = [];
  for (const [k, v] of pyEntries(body)) {
    if (META_KEYS.has(k) || DISCARDED_ROLE_KEYS.includes(k)) {
      continue;
    }
    setOwn(out, k, v);
    kept.push(k);
  }
  // A rebuilt object loses the source order with the object it was rebuilt
  // from -- `{k: v for k, v in body.items() if ...}` keeps it in Python -- so
  // it is carried across explicitly. Without this, `_check_placeholders` runs
  // over `rendered`, which is always a rebuild, and the order recorded at load
  // time never reaches it. The number SPELLINGS travel the same way and for the
  // same reason: `rendered` is what reaches `settings.local.json`, and a `1.0`
  // whose spelling stayed behind on `body` is written there as `1`.
  return carryNumberSpellings(body, rememberKeyOrder(out, kept));
}

function substitute(value: unknown, mapping: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") {
    // `String.prototype.replace` with a function argument mirrors Python's
    // `re.sub` replacement semantics: an unknown key is left EXACTLY as it
    // was (the whole match), which is what later makes it a refusal.
    return value.replace(PLACEHOLDER, (whole, key: string) => {
      return Object.hasOwn(mapping, key) ? (mapping[key] as string) : whole;
    });
  }
  if (Array.isArray(value)) {
    // The mapped array is a NEW container, so the spellings of the numbers it
    // holds -- which substitution leaves untouched -- have to come across with
    // it. @see stripMeta.
    return carryNumberSpellings(
      value,
      value.map((v) => substitute(v, mapping)),
    );
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    const keys = pyKeys(value);
    for (const k of keys) {
      setOwn(out, k, substitute(value[k], mapping));
    }
    // @see stripMeta -- the same rebuild, and the same reason for carrying the
    // order and the number spellings across it.
    return carryNumberSpellings(value, rememberKeyOrder(out, keys));
  }
  return value;
}

function dedupe(rules: readonly FenceRule[]): FenceRule[] {
  const seen = new Set<string>();
  const unique: FenceRule[] = [];
  for (const rule of rules) {
    if (seen.has(rule.ruleId)) {
      continue;
    }
    seen.add(rule.ruleId);
    unique.push(rule);
  }
  return unique;
}

/**
 * The `settings.local.json` body handed to the child.
 *
 * Key ordering is fixed and the payload is plain data, because this dict is
 * what gets diffed across an Interlock-initiated restart.
 *
 * The source is `json.loads(json.dumps(payload, sort_keys=True))`: a DEEP
 * key sort at every level of the structure, not merely at the top.
 *
 * **THE OBJECT RETURNED HERE IS NOT THE CANONICAL FORM.** The canonical form
 * is the STRING `pyJsonDumps(settings, { sortKeys: true })`, and anywhere the
 * payload is written to disk, hashed, or compared across a restart it is that
 * string -- not this object, and never `JSON.stringify` of it -- that has to
 * be produced.
 *
 * The reason is that the canonical order is not expressible as an object at
 * all: JavaScript enumerates integer-like keys FIRST, in numeric order,
 * whatever order they were inserted in. For `env` keys `{"10", "2", "a"}`
 * CPython's pure-string sort gives `"10"`, `"2"`, `"a"` and no object can
 * enumerate them that way, so a role with a numeric-looking env key would
 * render a byte-different settings document on every render -- a permanent
 * false "the fence changed" on the restart check (D-0201: state.py writes
 * this payload with `sort_keys` and the spawn path restores it BY BYTES).
 *
 * `deepSortKeys` is kept because it is still the right shape for the
 * in-memory value: it reproduces the source's `json.loads(json.dumps(...))`
 * round trip, and the sort it applies is correct for every key that is not
 * integer-like. It is the SERIALISER, not this object, that closes the
 * remaining gap.
 */
function settingsPayload(
  rendered: Readonly<Record<string, unknown>>,
  // `unknown`, not `string`: the source annotates this `str` but never
  // coerces, and the payload is persisted verbatim. Narrowing it here would
  // quietly insert a `str()` the source does not perform.
  permissionMode: unknown,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { permissionMode };
  // Carried key by key rather than with `carryNumberSpellings`, and that is the
  // one difference from the other rebuild sites: `permissionMode` does NOT come
  // from `rendered`, so copying `rendered`'s whole record wholesale could hand
  // it a spelling recorded for a `permissionMode` some role document happened
  // to author -- a stale spelling on a value from somewhere else, which is the
  // trap `carryNumberSpellings` itself warns about.
  const spellings = new Map<string, PyNumberSpelling>();
  for (const key of ["permissions", "sandbox", "hooks", "env"]) {
    // `key in rendered` on a document-derived object: `Object.hasOwn` keeps
    // an inherited member from being copied into the child's settings, which
    // is the direction that would hand the child a key nobody authored.
    if (Object.hasOwn(rendered, key)) {
      setOwn(payload, key, rendered[key]);
      // A section is normally a mapping, whose own spellings ride on the
      // mapping object and need nothing here. This is for the section that is
      // a bare NUMBER -- `"env": 1.0` -- whose spelling lives on the container
      // it was read out of, i.e. on `rendered`, and would otherwise be left
      // behind by this copy. Measured before the carry existed: CPython writes
      // `"env": 1.0` and this port wrote `"env": 1`.
      const spelling = pyNumberSpelling(rendered, key);
      if (spelling !== undefined) {
        spellings.set(key, spelling);
      }
    }
  }
  return deepSortKeys(rememberNumberSpellings(payload, spellings)) as Record<string, unknown>;
}

/**
 * Recursively rebuild every plain object with its keys in sorted order.
 *
 * `.sort()` here is JavaScript's default comparator (UTF-16 code units) and
 * the enumeration order it produces is overridden for integer-like keys, so
 * this is an approximation of CPython's ordering by construction -- see the
 * note on {@link settingsPayload}. It is deliberately not "fixed" to look
 * exact, because a comparator that appeared exact would invite treating this
 * object as the canonical form.
 */
function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    // A mapped array is a NEW container. @see stripMeta -- the same rebuild,
    // and the same reason for carrying the number spellings across it. An
    // array index is not reordered here, so the recorded keys still address
    // the same elements.
    return carryNumberSpellings(value, value.map(deepSortKeys));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      setOwn(out, key, deepSortKeys(value[key]));
    }
    // The spellings are keyed by property NAME, so sorting the keys does not
    // disturb them. `rememberKeyOrder` is deliberately NOT called: the whole
    // point of this rebuild is to replace the source order with a sorted one.
    return carryNumberSpellings(value, out);
  }
  return value;
}

// ---------------------------------------------------------------------------
// small shared pieces
// ---------------------------------------------------------------------------

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `str(pathlib.Path(x))`.
 *
 * The source's FenceContext holds `Path` objects and stringifies them at
 * every use, so the substituted `{hook_script}` / `{fence_path}` text, the
 * `commandRunsHook` token comparison and the `--fence` comparison all see
 * the CANONICAL spelling, never the caller's. `Path` is a lexical
 * normaliser, not a resolver -- it touches no filesystem and, importantly,
 * does NOT collapse `..` (`Path("a/../b")` stays `"a/../b"`, because with
 * symlinks in play that collapse would be wrong).
 *
 * `node:path`'s `normalize` is close but not the same and must not be
 * substituted for this: it collapses `..`, it KEEPS a trailing separator
 * (`normalize("a/b/")` is `"a/b/"`, `str(Path("a/b/"))` is `"a/b"`), and it
 * flattens a leading `//` that POSIX pathlib preserves.
 */
function pyStrPath(raw: string): string {
  return process.platform === "win32" ? windowsStrPath(raw) : posixStrPath(raw);
}

/**
 * `str(PurePosixPath(x))`. Verified against CPython 3 for: `""` -> `"."`,
 * `"."` -> `"."`, `"./"` -> `"."`, `".."` -> `".."`, `"/"` -> `"/"`,
 * `"dir/./hook.py"` -> `"dir/hook.py"`, `"/a//b"` -> `"/a/b"`,
 * `"a/b/"` -> `"a/b"`, `"a/."` -> `"a"`, `"/a/b/./"` -> `"/a/b"`,
 * `"a//b/.//c/"` -> `"a/b/c"`, `"a/../b"` -> `"a/../b"` (NOT collapsed),
 * `"//a/b"` -> `"//a/b"`, `"///a"` -> `"/a"`, `"//"` -> `"//"`.
 */
function posixStrPath(raw: string): string {
  if (raw === "") {
    return ".";
  }
  let lead = 0;
  while (lead < raw.length && raw[lead] === "/") {
    lead += 1;
  }
  // POSIX leaves a path beginning with exactly two slashes
  // implementation-defined, and pathlib preserves that pair verbatim while
  // collapsing one-or-three-or-more to a single slash. Reproduced because
  // the fence path is compared as a string, not resolved.
  const root = lead === 0 ? "" : lead === 2 ? "//" : "/";
  const parts = raw
    .slice(lead)
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) {
    return root === "" ? "." : root;
  }
  return root + parts.join("/");
}

/**
 * `str(PureWindowsPath(x))`. Verified against CPython 3 for: `"C:/a/b"` ->
 * `"C:\\a\\b"`, `"C:/a//b/"` -> `"C:\\a\\b"`, `"C:/a/./b"` ->
 * `"C:\\a\\b"`, `"C:"` -> `"C:"` (drive-relative, no root),
 * `"C:/"` -> `"C:\\"`, `"C:a/b"` -> `"C:a\\b"`, `"a/b/"` -> `"a\\b"`,
 * `"/a"` -> `"\\a"`, `""` -> `"."`, `"//server/share/x"` ->
 * `"\\\\server\\share\\x"`, `"//server/share"` -> `"\\\\server\\share\\"`
 * (a UNC drive always carries its root), `"//srv/sh//x/./y/"` ->
 * `"\\\\srv\\sh\\x\\y"`.
 *
 * The drive letter's case is preserved, exactly as pathlib preserves it --
 * lowercasing it here would change a string the `--fence` check compares.
 */
function windowsStrPath(raw: string): string {
  if (raw === "") {
    return ".";
  }
  const s = raw.replace(/\//g, "\\");
  let drive = "";
  let root = "";
  let rest = s;
  if (s.startsWith("\\\\")) {
    // UNC. pathlib folds `\\server\share` into the drive, and gives that
    // drive a root of `\` whenever the share component is non-empty.
    const unc = /^\\\\([^\\]*)\\([^\\]*)/.exec(s);
    if (unc === null) {
      // `\\` or `\\server` with no share separator at all: the whole thing
      // is the drive and there is no root.
      return s;
    }
    const share = unc[2] as string;
    drive = `\\\\${unc[1] as string}\\${share}`;
    rest = s.slice((unc[0] as string).length);
    root = share !== "" || rest.startsWith("\\") ? "\\" : "";
  } else if (/^[A-Za-z]:/.test(s)) {
    drive = s.slice(0, 2);
    rest = s.slice(2);
    root = rest.startsWith("\\") ? "\\" : "";
  } else if (s.startsWith("\\")) {
    root = "\\";
  }
  const tail = rest
    .split("\\")
    .filter((part) => part !== "" && part !== ".")
    .join("\\");
  const out = drive + root + tail;
  return out === "" ? "." : out;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function existsAsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A faithful equivalent of Python's `shutil.which` for a bare command name
 * (no path separator).
 *
 * Node has no built-in `which`. This searches `PATH` the way `shutil.which`
 * does -- each directory in order, first hit wins -- and on Windows also
 * honours `PATHEXT`, which is exactly what `shutil.which` itself does on
 * that platform (it does not simply check for `X_OK`, because Windows has no
 * such bit; it appends each `PATHEXT` extension in turn). On POSIX, `X_OK`
 * via `accessSync` is the direct equivalent of the executable-bit check
 * `shutil.which` performs there.
 */
function which(command: string): string | null {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const dirs = pathEnv.split(pathDelimiter).filter((d) => d.length > 0);

  if (process.platform === "win32") {
    const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(pathDelimiter)
      .filter((e) => e.length > 0);
    // If the command itself already carries one of the recognised
    // extensions, Windows (and shutil.which) tries it as-is first.
    const candidates = pathext.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()))
      ? [command]
      : pathext.map((ext) => command + ext);
    for (const dir of dirs) {
      for (const candidate of candidates) {
        const full = isAbsolute(candidate) ? candidate : `${dir}${pathSep}${candidate}`;
        if (existsAsFile(full)) {
          return full;
        }
      }
    }
    return null;
  }

  for (const dir of dirs) {
    const full = `${dir}${pathSep}${command}`;
    if (isExecutableFile(full)) {
      return full;
    }
  }
  return null;
}
