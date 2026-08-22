/**
 * Persisting a rendered fence, and diffing it across an Interlock restart.
 *
 * Under C2 the only restart there is is Interlock respawning a `claude -p`
 * child from persisted state (D-0027; #8 closed as moot). So "the fence
 * survives restart" reduces to a property of this file plus the renderer: the
 * fence written before the crash and the fence re-rendered after it must be the
 * same object, rule for rule and byte for byte in the settings payload.
 *
 * That is also the *whole* of what a rendered-input diff can prove, and the
 * gate record says so in D-0023's terms: it shows what we wrote, not what the
 * provider loaded. The breach battery is what narrows the remainder.
 *
 * Ported from interlock `src/claude_org_runtime/fencing/state.py` at `65f36c5`.
 *
 * ## Why every serialisation here goes through `pyJsonDumps`
 *
 * Two artefacts in this file are compared BY BYTES: the persisted fence (which
 * `spawn.ts` rolls back byte for byte on a failed publication) and the
 * canonical settings string {@link diffFences} compares. `JSON.stringify` is
 * not a substitute for `json.dumps(..., sort_keys=True)`: a JavaScript object
 * enumerates integer-like keys FIRST in ascending numeric order, so a settings
 * payload carrying a key like `"2"` beside `"10"` serialises in an order
 * CPython never produces, and the restart check then reports "the fence
 * changed" on every single restart. Sorting has to happen at serialisation
 * time, which is exactly what `./pyjson.js` exists for -- see its header.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { pyJsonDumps, pyJsonLoads } from "./pyjson.js";
import { pyRepr } from "./pyrepr.js";
import {
  isPlainObject,
  PyTypeError,
  PyValueError,
  pyDict,
  pyIterate,
  pyStr,
} from "./pysemantics.js";
import {
  Fence,
  FenceRule,
  KIND_PERMISSION_DENY,
  KIND_SANDBOX_DENY_READ,
  KIND_SANDBOX_DENY_WRITE,
  LAYER_PERMISSIONS,
  LAYER_SANDBOX,
} from "./rules.js";

const LAYERS: ReadonlySet<string> = new Set([LAYER_PERMISSIONS, LAYER_SANDBOX]);
const KINDS: ReadonlySet<string> = new Set([
  KIND_PERMISSION_DENY,
  KIND_SANDBOX_DENY_READ,
  KIND_SANDBOX_DENY_WRITE,
]);

export const FENCE_FORMAT_VERSION = 1;

/**
 * A persisted fence that cannot be read back. Never recovered from.
 *
 * The hook treats this as *deny everything* and the spawn path treats it as
 * *refuse to spawn*; neither is allowed to continue with a partially read
 * fence.
 *
 * `RuntimeError` in the source. `Object.setPrototypeOf` for the reason every
 * other error class in this subsystem carries it: extending a built-in under a
 * downlevel emit target loses the prototype chain and `instanceof` then
 * silently reports false -- and `fenceFromJson` routes on
 * `instanceof FenceStateError` to tell "already refused" from "raised by
 * CPython", so a broken chain would rewrite a precise refusal message into the
 * generic `malformed persisted fence` one.
 */
export class FenceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FenceStateError";
    Object.setPrototypeOf(this, FenceStateError.prototype);
  }
}

/**
 * `KeyError`, for the subscripts `fenceFromJson` performs inside its `try`.
 *
 * The source reaches `payload["rules"]` and three more keys directly, and
 * catches `KeyError` alongside `TypeError` and `ValueError` to turn a missing
 * key into `malformed persisted fence: 'rules'`. A TypeScript `payload["rules"]`
 * yields `undefined` and raises nothing, so the miss has to be raised
 * explicitly or the port would walk on with `undefined` where interlock stops
 * -- `str(payload["role"])` on a missing role would become the string
 * `"undefined"` and a fence with no role would load cleanly.
 *
 * Exported, and marked `@internal` rather than added to `src/index.ts`: nothing
 * in THIS module lets it escape (every path that raises it is inside the `try`
 * that converts it), but `spawn.ts`'s `FenceLedger.refusals` reaches
 * `entry["event"]` the same way and must raise the same class, and one
 * `KeyError` stand-in for the fencing subsystem is the point. A second copy
 * there would be free to drift in exactly the detail that is observable -- the
 * message rendering below.
 *
 * `KeyError.__str__` reprs its argument rather than returning it, which is why
 * the message is `pyRepr(key)` and not `key` -- CPython prints `'rules'`, with
 * the quotes, and that text lands in the refusal.
 *
 * @internal Not package API (D-0101).
 */
export class PyKeyError extends Error {
  constructor(key: string) {
    super(pyRepr(key));
    this.name = "PyKeyError";
    Object.setPrototypeOf(this, PyKeyError.prototype);
  }
}

/**
 * `mapping[key]` as Python performs it: present or `KeyError`.
 *
 * `Object.hasOwn`, never a plain `in` or a bare read: every payload here came
 * out of `JSON.parse`, whose objects inherit from `Object.prototype`, so a
 * persisted fence with no `"rules"` key still answers `payload["constructor"]`
 * with a function and `payload["toString"]` with a method. Reading an inherited
 * member as if it were persisted data is how a corrupt fence loads cleanly.
 */
function getItem(mapping: Readonly<Record<string, unknown>>, key: string): unknown {
  if (!Object.hasOwn(mapping, key)) {
    throw new PyKeyError(key);
  }
  return mapping[key];
}

/** `mapping.get(key)`: the same own-property discipline, without the raise. */
function getOwn(mapping: unknown, key: string): unknown {
  if (typeof mapping !== "object" || mapping === null) {
    return undefined;
  }
  return Object.hasOwn(mapping, key) ? (mapping as Record<string, unknown>)[key] : undefined;
}

/**
 * Reconstruct one rule, refusing anything that is not exactly a rule.
 *
 * Coercing these fields with `str()` would let a corrupted-but-still-valid JSON
 * fence through in the one direction that is silent: a mistyped `layer` is
 * skipped by `decide`, and a `null` spec becomes the string `"None"` and
 * matches nothing. Either removes a denial while the hook goes on treating the
 * fence as sound -- so the vocabularies are closed and every field is
 * type-checked.
 */
function ruleFromJson(entry: unknown): FenceRule {
  // `isinstance(entry, Mapping)`. A JSON array is not a Mapping and neither is
  // `null`, and `isPlainObject` excludes both -- `typeof null === "object"` and
  // an array is an object, so neither exclusion is automatic.
  if (!isPlainObject(entry)) {
    throw new FenceStateError(`persisted rule is not an object: ${pyRepr(entry)}`);
  }
  const fields: Record<string, string> = {};
  for (const key of ["layer", "kind", "tool", "spec"]) {
    const value = getOwn(entry, key);
    // Python: `not isinstance(value, str) or not value`. The second half
    // rejects the EMPTY string, and no other falsy value can reach it -- a
    // `0` or a `false` already failed the type test. Reproduced as an explicit
    // `=== ""` rather than `!value` so a future edit cannot widen it.
    if (typeof value !== "string" || value === "") {
      throw new FenceStateError(
        `persisted rule field ${pyRepr(key)} must be a non-empty string, got ${pyRepr(value)}`,
      );
    }
    fields[key] = value;
  }
  const layer = fields["layer"] as string;
  const kind = fields["kind"] as string;
  if (!LAYERS.has(layer)) {
    throw new FenceStateError(`persisted rule has unknown layer: ${pyRepr(layer)}`);
  }
  if (!KINDS.has(kind)) {
    throw new FenceStateError(`persisted rule has unknown kind: ${pyRepr(kind)}`);
  }
  return new FenceRule(layer, kind, fields["tool"] as string, fields["spec"] as string);
}

/** The persisted shape of a fence. Wire keys verbatim (D-0201). */
export function fenceToJson(fence: Fence): Record<string, unknown> {
  return {
    format: FENCE_FORMAT_VERSION,
    role: fence.role,
    role_kind: fence.roleKind,
    permission_mode: fence.permissionMode,
    rules: fence.rules.map((r) => ({ layer: r.layer, kind: r.kind, tool: r.tool, spec: r.spec })),
    // `dict(fence.settings)`, and `pyDict` is that call rather than a spread
    // for two independent reasons:
    //
    // 1. It PRESERVES key order. A spread loses the order `pyJsonLoads`
    //    attached to the parsed object, and without it `pyKeys` falls back to
    //    `Object.keys`, which hoists integer-like keys to the front. That order
    //    is invisible in the persisted file (which sorts) but visible in
    //    `repr()` of this dict, which reaches refusal messages the ported cases
    //    compare byte for byte.
    // 2. It REFUSES a non-mapping. `Fence` validates `settings` nowhere, so
    //    this call is the only thing standing between a settings payload that
    //    is a string, a number or a list and a published fence -- a spread
    //    publishes `{"0": "a", "1": "b"}` for `"ab"` and `{}` for `7`, where
    //    interlock raises. See `pyDict` for the measurements.
    settings: pyDict(fence.settings),
  };
}

export function fenceFromJson(payload: Readonly<Record<string, unknown>>): Fence {
  try {
    const format = getOwn(payload, "format");
    if (!equalsFormatVersion(format)) {
      throw new FenceStateError(`unsupported fence format: ${pyRepr(format)}`);
    }
    const rawRules = getItem(payload, "rules");
    if (rawRules === null) {
      // `pyIterate` maps `null` to `[]` as a convenience for the renderer's
      // `pyOr` call sites. Here that convenience would turn `"rules": null`
      // into the `persisted fence carries no rules` refusal, where CPython
      // raises `TypeError: 'NoneType' object is not iterable` and the message
      // becomes `malformed persisted fence: ...`. Both refuse; the ledger
      // compares the message, so the raise is reproduced rather than adapted.
      throw new PyTypeError("'NoneType' object is not iterable");
    }
    const rules = pyIterate(rawRules).map((entry) => ruleFromJson(entry));
    if (rules.length === 0) {
      throw new FenceStateError("persisted fence carries no rules");
    }
    // Argument order is the source's, and it is observable: CPython evaluates
    // the arguments left to right, so a payload missing BOTH `role` and
    // `settings` reports `'role'`, not `'settings'`.
    const role = pyStr(getItem(payload, "role"));
    const roleKind = pyStr(getItem(payload, "role_kind"));
    const permissionMode = pyStr(getItem(payload, "permission_mode"));
    const settings = getItem(payload, "settings");
    return new Fence({
      role,
      roleKind,
      permissionMode,
      rules,
      // The source's dataclass validates nothing here, so a fence whose
      // `settings` is a list or a string is CONSTRUCTED and fails later, at
      // `dict(fence.settings)` inside `fenceToJson`. Refusing it here instead
      // would be a different -- and, being earlier, a more useful -- behaviour
      // than interlock's, which is exactly what a parity port does not get to
      // choose. The cast carries that: the type is a lie the source also tells.
      settings: settings as Readonly<Record<string, unknown>>,
    });
  } catch (exc) {
    if (exc instanceof FenceStateError) {
      throw exc;
    }
    // `except (KeyError, TypeError, ValueError)`. `PyKeyError` is the KeyError
    // this module raises for a missing subscript; `PyTypeError` extends
    // `TypeError`, which covers what `pyIterate` and `pyStr` raise; and
    // `PyValueError` is the tuple's third arm -- unreachable through today's
    // call graph, because `pyDict` runs on the way OUT in `fenceToJson`, and
    // listed anyway rather than leaving a `catch` that has quietly stopped
    // matching the `except` it transcribes. Anything
    // else is a defect in this port rather than a malformed document, and is
    // rethrown so it is not laundered into a refusal an operator would read as
    // "the file on disk is bad".
    if (
      exc instanceof PyKeyError ||
      exc instanceof TypeError ||
      exc instanceof PyValueError ||
      exc instanceof RangeError
    ) {
      throw new FenceStateError(`malformed persisted fence: ${describe(exc)}`);
    }
    throw exc;
  }
}

/**
 * Python's `payload.get("format") != FENCE_FORMAT_VERSION`, including the part
 * that looks like a bug.
 *
 * `True == 1` in Python, because `bool` is a subclass of `int`. So a fence
 * whose `"format"` is the JSON literal `true` PASSES interlock's version check
 * and is loaded. `true !== 1` in JavaScript, so reproducing that takes an
 * explicit branch. Inherited defect, disclosed rather than repaired (D-0022):
 * repairing it here would make the port refuse a file interlock accepts, and
 * the refusal would be invisible until a hand-edited fence hit it.
 *
 * `1.0 == 1` is the same rule and needs no branch: `JSON.parse` collapses both
 * spellings to the same `number`.
 */
function equalsFormatVersion(value: unknown): boolean {
  if (typeof value === "boolean") {
    // `True` is 1 and `False` is 0 under the comparison, so the whole rule is
    // one line. The cast is only to stop TypeScript from narrowing the constant
    // to its literal type and calling the `false` half a comparison between
    // types with no overlap -- which is exactly the reasoning Python does not
    // do, and the reason a boolean gets here at all.
    return (value ? 1 : 0) === (FENCE_FORMAT_VERSION as number);
  }
  return value === FENCE_FORMAT_VERSION;
}

/**
 * Write EVERY byte of `body` to `handle`, looping until the buffer is drained.
 *
 * `fs.writeSync` is `write(2)`: it is permitted to write FEWER bytes than
 * requested and return normally -- near a quota boundary, on a filesystem that
 * has just run out of space, when a signal interrupts a large write, and on
 * some platforms for any sufficiently large buffer. A single unchecked
 * `writeSync` therefore has a silent short-write mode, and every caller in this
 * subsystem then does the same three things with the truncated file: `fsync`
 * it, rename it into place, and report success.
 *
 * The failure mode that makes this fail-OPEN rather than merely lossy: a
 * truncated `settings.local.json` can lose the trailing `hooks` block outright
 * while still being written, fsynced and renamed. The child launches with NO
 * deny hook configured, the spawn is recorded in the ledger as admitted, and
 * nothing anywhere reports a problem -- an unfenced child that the durable
 * record says was fenced. The fence file and the ledger line have the same
 * shape of exposure: a fence the hook reads back short enforces a SUBSET of the
 * rules, and a short ledger line corrupts the one durable record written when
 * something has already gone wrong.
 *
 * This is a PORT defect, not an inherited one. interlock writes through
 * `handle.write(body)` on a buffered text file, and CPython's `BufferedWriter`
 * loops internally over the raw layer: measured on CPython 3.12 against a
 * `RawIOBase` capped at 7 bytes per call, a 301-byte body produced 43 raw
 * writes and a byte-identical file. So this loop restores parity rather than
 * adding a behaviour interlock lacks (D-0023: repaired at the first belt that
 * touches the code).
 *
 * One deliberate deviation from CPython, in the pathological case: given a raw
 * layer that makes NO progress, `BufferedWriter` retries forever (measured -- a
 * zero-returning raw write hangs the interpreter rather than raising). This
 * throws instead. A real `write(2)` on a regular file signals failure with an
 * error, never with a successful zero, so the branch is unreachable through the
 * OS; if it is ever reached, a refusal the spawn path already knows how to roll
 * back is strictly better than a hung spawn, and hanging is not a fidelity
 * property worth reproducing.
 *
 * @internal Not package API (D-0101). Exported only so `spawn.ts` -- which
 * already imports from this module, so no cycle is created -- shares this one
 * implementation at all three write sites rather than growing a second copy
 * free to drift.
 */
export function writeAllSync(handle: number, body: Buffer): void {
  let offset = 0;
  while (offset < body.length) {
    // The offset/length form, NOT `body.subarray(offset)`: a subarray allocates
    // a new view on every iteration, and the explicit offset is what makes it
    // obvious that progress is measured in bytes actually accepted.
    const written = writeSync(handle, body, offset, body.length - offset);
    if (written <= 0) {
      throw new ShortWriteError(offset, body.length);
    }
    offset += written;
  }
}

/**
 * The zero-progress refusal, carrying a `code` so it is an *I/O* failure.
 *
 * `spawn.ts` rolls a half-finished publication back only for errors its
 * `isOSError` accepts -- the transcription of interlock's `except OSError:` --
 * and it decides by looking for a string `code`. A plain `Error` would escape
 * that catch, and the escape is the fail-open shape all over again in a new
 * place: `writeFence` would already have published the new fence, the settings
 * write would then throw past the rollback, and the previous session's fence
 * would be left replaced by one belonging to a spawn that was never admitted.
 *
 * The code is deliberately NOT a POSIX errno. The condition this fires on has
 * no errno of its own -- a real `write(2)` that stops short reports its reason
 * on the NEXT call, typically `ENOSPC` or `EDQUOT` -- and stamping one of those
 * on here would forge a kernel classification into a message an operator reads.
 * A distinct code says what actually happened and still routes to the rollback.
 */
class ShortWriteError extends Error implements NodeJS.ErrnoException {
  readonly code = "ESHORTWRITE";

  constructor(written: number, total: number) {
    super(`short write: wrote ${written} of ${total} bytes and then made no progress`);
    this.name = "ShortWriteError";
    Object.setPrototypeOf(this, ShortWriteError.prototype);
  }
}

/**
 * Atomically publish the fence the deny hook will read.
 *
 * Written to a temporary sibling and renamed: a hook that read a half-written
 * fence would either deny everything (a stalled worker) or, worse, parse a
 * truncated rule list and enforce a *subset* of the fence. The rename makes the
 * second impossible.
 *
 * ## The bytes, and why they are pinned twice
 *
 * `newline=""` in the source pins the line endings to the `\n` in `body`,
 * because Python's text mode would emit CRLF on Windows -- making the same
 * fence a different file byte for byte depending on where it was published, and
 * `spawn.ts` restores this file BY BYTES on a failed publication. Node performs
 * no newline translation at all, so the `\n` written here is the `\n` on disk
 * on every platform; the `Buffer.from(body, "utf8")` below is what makes that
 * explicit rather than incidental, and it is why the file is opened as a
 * descriptor instead of through `writeFileSync`: the source flushes and
 * `fsync`s before the rename, and `writeFileSync` gives no descriptor to
 * `fsync`.
 *
 * `renameSync` for `os.replace`: both are an atomic replace-if-exists on POSIX
 * and both use `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING` on Windows, where
 * a plain `rename(2)` would fail because the destination exists.
 *
 * ## One deviation, stated because the return value is persisted
 *
 * The source opens with `path = Path(path)` and RETURNS that `Path`, so a
 * caller who passed `"dir//fence.json"` gets `"dir/fence.json"` back, and
 * `spawn.ts` writes `str(fence_path)` into the ledger. This port returns the
 * caller's string unchanged. The normaliser that would reproduce
 * `str(Path(...))` is `pyStrPath`, which is private to `renderer.ts` and inside
 * PR 1's frozen boundary; duplicating a transcription that is already pinned by
 * a differential vector would create a second copy free to drift from it. The
 * divergence is unreachable through the production path -- `FenceContext`
 * canonicalises `fencePath` in its constructor, so `spawn.ts` hands this
 * function an already-canonical string -- and is reachable only by calling
 * `writeFence` directly with a non-canonical path, where it changes the
 * recorded spelling and nothing else. Reported for a follow-up that lifts
 * `pyStrPath` into a shared module.
 */
export function writeFence(fence: Fence, path: string): string {
  const parent = pathParent(path);
  mkdirSync(parent, { recursive: true });
  const tmp = tmpSibling(path);
  const body = `${pyJsonDumps(fenceToJson(fence), { sortKeys: true, indent: 2 })}\n`;
  const handle = openSync(tmp, "w");
  try {
    // Full write BEFORE the fsync, and the rename is after the `try` -- an
    // incomplete write throws out of this block and the rename below is then
    // unreachable, so no partially written fence can ever be published.
    writeAllSync(handle, Buffer.from(body, "utf8"));
    fsyncSync(handle);
  } finally {
    // The source's `with` closes the handle on the way out of the block,
    // including the failing way out. A descriptor leaked here would keep the
    // half-written temp file open for the life of the process.
    closeSync(handle);
  }
  renameSync(tmp, path);
  return path;
}

export function readFence(path: string): Fence {
  // Read, decode and parse as three steps, the way `renderer.loadDocument`
  // does: the source's `try` catches ONLY `OSError` and `json.JSONDecodeError`,
  // so a file that is not valid UTF-8 aborts rather than refusing.
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (exc) {
    // -- ADAPTED MESSAGE (D-0017) -- the source embeds `str(exc)`, which reads
    // `[Errno 2] No such file or directory: '/x'` on CPython and
    // `ENOENT: no such file or directory, open '/x'` under Node. Forging the
    // errno text would launder a Node classification into a Python-looking lie;
    // the error TYPE (`FenceStateError`) is what every caller compares, and it
    // is identical. Same reasoning, same authority, as `loadDocument`.
    throw new FenceStateError(`cannot read fence at ${path}: ${describe(exc)}`);
  }
  // `{ fatal: true }`: `Buffer.toString("utf8")` substitutes U+FFFD for every
  // undecodable byte and never fails, so one stray byte inside a `spec` would
  // load a complete, healthy-looking fence in which that rule matches nothing
  // -- and the breach battery would stay green, because it derives its probe
  // from the same corrupted spec. The `TypeError` this throws is deliberately
  // NOT wrapped: the source does not catch `UnicodeDecodeError` either.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let payload: unknown;
  try {
    // `pyJsonLoads`, not `JSON.parse`: the parsed object's SOURCE key order is
    // what `repr()` of a persisted rule prints inside a refusal message, and
    // `JSON.parse` alone hoists integer-like keys to the front of it.
    payload = pyJsonLoads(text);
  } catch (exc) {
    throw new FenceStateError(`cannot read fence at ${path}: ${describe(exc)}`);
  }
  // `isinstance(payload, dict)`: a fence file whose top level is a list or a
  // string is refused here rather than subscripted below.
  if (!isPlainObject(payload)) {
    throw new FenceStateError(`cannot read fence at ${path}: not an object`);
  }
  return fenceFromJson(payload);
}

/** The rendered-input diff across an Interlock-initiated restart. */
export class FenceDiff {
  readonly addedRules: readonly string[];
  readonly removedRules: readonly string[];
  readonly settingsChanged: boolean;
  readonly permissionModeChanged: boolean;

  constructor(init: {
    addedRules: readonly string[];
    removedRules: readonly string[];
    settingsChanged: boolean;
    permissionModeChanged: boolean;
  }) {
    this.addedRules = Object.freeze([...init.addedRules]);
    this.removedRules = Object.freeze([...init.removedRules]);
    this.settingsChanged = init.settingsChanged;
    this.permissionModeChanged = init.permissionModeChanged;
    // Frozen dataclass in the source. The diff is the evidence a restart is
    // judged on; an editable one can be made to say "identical" by a caller
    // rather than by the fence actually being identical.
    Object.freeze(this);
  }

  get identical(): boolean {
    // Python's `not (a or b or c or d)` over two tuples and two bools: a tuple
    // is falsy when EMPTY, so this is a length test, not a null test.
    return !(
      this.addedRules.length > 0 ||
      this.removedRules.length > 0 ||
      this.settingsChanged ||
      this.permissionModeChanged
    );
  }

  toJson(): Record<string, unknown> {
    return {
      identical: this.identical,
      added_rules: [...this.addedRules],
      removed_rules: [...this.removedRules],
      settings_changed: this.settingsChanged,
      permission_mode_changed: this.permissionModeChanged,
    };
  }
}

export function diffFences(before: Fence, after: Fence): FenceDiff {
  const beforeIds = new Set(before.ruleIds());
  const afterIds = new Set(after.ruleIds());
  return new FenceDiff({
    addedRules: sortedDifference(afterIds, beforeIds),
    removedRules: sortedDifference(beforeIds, afterIds),
    settingsChanged: canonical(before.settings) !== canonical(after.settings),
    permissionModeChanged: before.permissionMode !== after.permissionMode,
  });
}

/**
 * `sorted(a - b)`.
 *
 * CPython sorts `str` by CODE POINT; `Array.prototype.sort` compares UTF-16
 * CODE UNITS, and the two disagree for one region: an astral character is
 * stored as a surrogate pair starting at U+D800, so JavaScript sorts it BELOW
 * every character in U+E000..U+FFFF while CPython sorts it above. A rule id
 * carries a `spec` copied from the role document, so an emoji beside a
 * private-use character in two paths is enough to swap two entries of
 * `added_rules` -- and that list is persisted and compared. The same
 * comparison, for the same reason, is in `./pyjson.js`, where it orders keys;
 * it is private there and this list is not keys, so the ordering is spelled out
 * again rather than reached for through an export that does not exist.
 */
function sortedDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  const out = [...left].filter((id) => !right.has(id));
  out.sort(compareByCodePoint);
  return out;
}

function compareByCodePoint(a: string, b: string): number {
  // Iterating a string yields code points, not code units, so this walks the
  // sequence CPython compares.
  const ita = a[Symbol.iterator]();
  const itb = b[Symbol.iterator]();
  for (;;) {
    const ca = ita.next();
    const cb = itb.next();
    if (ca.done === true) {
      // A prefix sorts before its extensions; both exhausted means equal.
      return cb.done === true ? 0 : -1;
    }
    if (cb.done === true) {
      return 1;
    }
    const pa = ca.value.codePointAt(0) as number;
    const pb = cb.value.codePointAt(0) as number;
    if (pa !== pb) {
      return pa < pb ? -1 : 1;
    }
  }
}

/**
 * `json.dumps(value, sort_keys=True, separators=(",", ":"))`.
 *
 * The comparison this feeds is `!=` on the RESULT, so the whole point is that
 * two payloads which differ only in key order compare EQUAL. `JSON.stringify`
 * cannot deliver that: it emits the object's own enumeration order, which has
 * already hoisted integer-like keys, so two settings payloads carrying the same
 * pairs would still have to agree on insertion order to compare equal here.
 */
function canonical(value: unknown): string {
  return pyJsonDumps(value, { sortKeys: true, separators: [",", ":"] });
}

/**
 * `str(exc)` for the errors this module catches.
 *
 * `String(error)` would prefix the class name (`Error: ...`), which CPython's
 * `str(exc)` never does.
 */
function describe(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * `Path(path).parent`, for the one use the source makes of it: `mkdir`.
 *
 * Measured against both: `dirname` and `Path(...).parent` agree on every shape
 * that reaches here, including the two that are easy to get wrong -- a trailing
 * separator (`"a/b/"` -> `"a"` in both) and a bare filename (`"a"` -> `"."` in
 * both, NOT the empty string, which `mkdirSync` would reject with ENOENT).
 *
 * It stays a named function rather than a bare `dirname` call so the Python
 * concept being reproduced is written down at the one place it is decided.
 */
function pathParent(path: string): string {
  return dirname(path);
}

/**
 * `path.with_name(path.name + ".tmp")`.
 *
 * NOT `path + ".tmp"`: `Path("a/b/").with_name(...)` is `a/b.tmp`, because
 * `.name` is the last component with any trailing separator already dropped,
 * while string concatenation would produce `a/b/.tmp` -- a temp file in a
 * DIFFERENT directory from the fence, which then makes the rename a
 * cross-directory move and no longer atomic if the two sit on different
 * filesystems.
 *
 * `with_name` raises `ValueError` on a path with no name at all. Measured
 * against CPython 3 rather than assumed, because the boundary is not the
 * obvious one: `"/"`, `"."` and `""` have an empty `.name` and raise, while
 * `".."` does NOT -- its name is `".."` and the temp file is `"...tmp"`. Node's
 * `basename` disagrees on exactly one of those (`basename(".")` is `"."`, where
 * pathlib says `""`), which is why the `"."` case is spelled out below and
 * `".."` is deliberately absent from the guard.
 *
 * The source does not catch the `ValueError` and `spawn.ts` catches only
 * `OSError`, so it propagates in both. It is raised here as a plain `Error`:
 * `ValueError` has no JavaScript counterpart, and an exported class for a
 * condition nothing catches would be surface with no caller. The wording is
 * adapted -- CPython prints `PosixPath('/') has an empty name`, naming a class
 * this port does not have.
 */
function tmpSibling(path: string): string {
  const name = basename(path);
  if (name === "" || name === ".") {
    throw new Error(`${pyRepr(path)} has an empty name`);
  }
  return join(dirname(path), `${name}.tmp`);
}
