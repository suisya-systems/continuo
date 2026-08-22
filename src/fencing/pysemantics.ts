/**
 * Python's value semantics, transcribed for the JSON-shaped documents the
 * fencing subsystem reads.
 *
 * The fencing renderer is a transcription of `fencing/renderer.py`, and that
 * file is written in idiomatic Python: `x or default`, `for item in x`,
 * `set(x or ())`, `needle in haystack`. Every one of those idioms is
 * *polymorphic* -- it accepts any object of the right protocol, not only the
 * one shape the author had in mind -- and the natural JavaScript translation
 * of each one is narrower than the original:
 *
 * - `x or default` becomes `x ?? default`, which falls back only on
 *   null/undefined and therefore **keeps** an empty list where Python would
 *   have replaced it (usually harmless) -- or, worse, the translator notices
 *   that and writes `Array.isArray(x) ? x : []`, which **discards** a truthy
 *   non-array where Python would have used it.
 * - `for item in x` becomes a `for...of` guarded by `Array.isArray`, which
 *   silently iterates zero times over a string or an object where Python
 *   iterates characters or keys -- or raises `TypeError` over a number, where
 *   the guard yields nothing at all.
 *
 * Both mistranslations land on the same value: the empty list. And in a fence
 * renderer, an empty list means *no rules were checked*, which means the check
 * passes, which means the fence stops denying -- with no exception raised and
 * the breach battery still reporting green, because the battery only probes
 * the rules that were rendered. That is precisely the silent-hole failure mode
 * (F2/V15/V16) this subsystem exists to prevent, so the Python idioms are
 * reproduced here as named helpers rather than paraphrased at each call site.
 *
 * The scope is deliberately narrow: the values that reach these helpers come
 * from `JSON.parse` of a role document, so "iterable" means array, string,
 * plain object (plus `Map`/`Set`, handled for completeness), and everything
 * else is a `TypeError` in Python and a {@link PyTypeError} here.
 */

import { formatNumber } from "./pyjson.js";
import { pyRepr } from "./pyrepr.js";

/**
 * Python's `TypeError`, for the operations Python refuses to perform at all.
 *
 * Raised rather than absorbed. Where CPython raises `TypeError`, returning an
 * empty list instead would convert a loud authoring error into exactly the
 * silent hole described above: a `forbidden_allow_regex: 7` would stop being a
 * crash and start being an empty forbidden-allow list.
 */
export class PyTypeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "PyTypeError";
    // `extends TypeError`, not `extends Error`: CPython raises the BUILTIN
    // `TypeError` at each of these sites, and the ported tests spell that
    // `expect(...).toThrow(TypeError)`. Under `extends Error` that assertion
    // fails on a port that is behaving correctly, and the usual repair is to
    // loosen the assertion to `Error` -- which then also passes for a
    // `RangeError`, a `SyntaxError` from a bad regex, or a TypeError from a
    // typo in this module, so the test stops distinguishing "Python refused
    // this value" from "the port crashed".
    // Extending a built-in under a downlevel emit target loses the prototype
    // chain, and `instanceof` then silently reports false -- which would turn
    // a fail-closed `catch (e) { if (e instanceof PyTypeError) ... }` into a
    // rethrow or, worse, into a swallowed error.
    Object.setPrototypeOf(this, PyTypeError.prototype);
  }
}

/**
 * Python's `ValueError`, for the operations Python attempts and then refuses.
 *
 * The distinction from {@link PyTypeError} is not cosmetic: `dict()` reports
 * the two failures it can have with two different classes -- an argument that
 * is not iterable at all is a `TypeError`, an argument that iterates to
 * something other than key/value pairs is a `ValueError` -- and a caller that
 * catches only one of them (interlock's `fence_from_json` catches both, its
 * `write_fence` catches neither) must see the same split here.
 *
 * `extends Error`, deliberately NOT `extends TypeError`. `ShlexError` and
 * `PythonRegexError` are the other two stand-ins for a CPython `ValueError` in
 * this subsystem and both are plain `Error` subclasses; more importantly,
 * making this a `TypeError` would put it inside every `catch (e) { if (e
 * instanceof TypeError) }` in the port -- including `fence_from_json`'s, where
 * it belongs, but also anywhere a future `except TypeError` is transcribed,
 * which would silently widen a catch CPython keeps narrow.
 */
export class PyValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PyValueError";
    // Extending a built-in under a downlevel emit target loses the prototype
    // chain, and `instanceof` then silently reports false -- which would turn
    // `fenceFromJson`'s `except (KeyError, TypeError, ValueError)` into a
    // rethrow, so a malformed persisted fence would escape as an internal
    // error instead of the refusal an operator can read.
    Object.setPrototypeOf(this, PyValueError.prototype);
  }
}

/**
 * Python's truthiness.
 *
 * False for `None` (here: `undefined`/`null`), `False`, `0`, `-0`, `NaN`,
 * `""`, `[]`, `{}`, and an empty `Map`/`Set`. True for everything else.
 *
 * JavaScript disagrees on exactly the two cases that matter here: `[]` and
 * `{}` are **truthy** in JavaScript and **falsy** in Python. That inversion is
 * the whole bug. `global_cfg.get("permission_modes") or DEFAULTS` in Python
 * falls back to the defaults when the key holds an empty list; the same
 * expression written with `||` or `??` in JavaScript would keep the empty list
 * and accept no permission mode at all. Conversely `x or ()` written as
 * `Array.isArray(x) ? x : []` throws away a truthy object that Python would
 * have iterated.
 */
export function pyTruthy(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    // NaN is falsy in Python, and `NaN !== 0` is true, so it has to be
    // excluded explicitly. `value !== 0` also covers -0, because -0 === 0.
    return !Number.isNaN(value) && value !== 0;
  }
  if (typeof value === "bigint") {
    return value !== 0n;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value instanceof Map || value instanceof Set) {
    return value.size > 0;
  }
  if (isPlainObject(value)) {
    return Object.keys(value).length > 0;
  }
  // Any other object: Python's default `__bool__` for an instance without one
  // is True, and there is no JSON value that lands here anyway.
  return true;
}

/**
 * Python's `value or fallback`.
 *
 * NOT `??`, which falls back only on null/undefined, and NOT `||`, whose
 * falsy set is JavaScript's rather than Python's. The difference is
 * observable for `[]`, `{}`, `0` and `""`: `permissions.get("x") or []` in
 * Python replaces an empty dict with the fallback, and -- the direction that
 * opens holes -- **preserves** a non-empty dict or a non-empty string, which
 * the caller then iterates as keys or as characters.
 *
 * The return type stays `unknown` on purpose: what comes back is either the
 * caller's fallback or an arbitrary JSON value, and pretending otherwise would
 * hand the call site a type it has not actually checked.
 */
export function pyOr<T>(value: unknown, fallback: T): unknown {
  return pyTruthy(value) ? value : fallback;
}

/**
 * Python's `for item in value`, for JSON-shaped values.
 *
 * - An array yields its items.
 * - A **string yields its characters**. This is load-bearing, not a curiosity:
 *   `for hook in group.get("hooks", []) or []` over the string `"oops"` yields
 *   `'o'`, `'o'`, `'p'`, `'s'`, each of which then fails the `isinstance(hook,
 *   dict)` check and appends a rule-syntax reason -- so interlock *refuses* a
 *   document with a malformed hook group. A translation that skipped
 *   non-arrays would render that document cleanly.
 * - A plain object yields its **keys**, which is why `set(global_cfg.get(
 *   "forbidden_allow_exact") or ())` works on the plausible authoring shape
 *   `{"Bash(rm:*)": "why this is forbidden"}`.
 * - `null`/`undefined` yields `[]`. Python would raise here, but every call
 *   site in this subsystem passes the value through {@link pyOr} first, which
 *   turns `None` into the fallback; accepting it costs nothing and keeps the
 *   helpers composable in either order.
 * - Anything else (number, boolean) is **not** iterable in Python, so this
 *   throws {@link PyTypeError}. Yielding `[]` there would be another hole of
 *   exactly the kind this module exists to close.
 */
export function pyIterate(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return [...value];
  }
  if (typeof value === "string") {
    // `Array.from` iterates code points, which is what Python iterates over a
    // `str`. Splitting on "" would iterate UTF-16 code units instead and tear
    // astral characters in half.
    return Array.from(value);
  }
  if (value instanceof Set) {
    return [...value];
  }
  if (value instanceof Map) {
    return [...value.keys()];
  }
  if (isPlainObject(value)) {
    // `pyKeys`, not `Object.keys`: `for raw in global_cfg["forbidden_allow_regex"]`
    // over an object yields the keys in the order the DOCUMENT wrote them, and
    // that order decides the order of the reasons a refusal carries.
    return pyKeys(value);
  }
  throw new PyTypeError(`'${pyTypeName(value)}' object is not iterable`);
}

/**
 * Python's `needle in haystack`.
 *
 * Membership for a sequence, **key** membership for a mapping, and --
 * surprisingly -- **substring** for a string. That last case is not a
 * convenience added here; it is what `mode not in allowed` does when a role
 * document sets `global.permission_modes` to a string. With
 * `permission_modes: "default"`, the mode `"faul"` is `in` it, so a bogus
 * permission mode is accepted. Reproducing the surprise is the point: the
 * fence must be judged by what interlock does, and hiding this behind a
 * "sensible" array-only membership test would make the port disagree with the
 * source on a real document.
 *
 * The `TypeError` cases are reproduced too: `1 in "abc"` and `"x" in 7` both
 * raise in Python.
 */
export function pyIn(needle: unknown, haystack: unknown): boolean {
  if (typeof haystack === "string") {
    if (typeof needle !== "string") {
      throw new PyTypeError(
        `'in <string>' requires string as left operand, not ${pyTypeName(needle)}`,
      );
    }
    return haystack.includes(needle);
  }
  if (Array.isArray(haystack)) {
    // Python's `in` tries identity before equality, which is why a NaN that is
    // literally the same object counts as present. `Object.is` covers that
    // case; `===` covers ordinary equality for the scalars JSON carries.
    return haystack.some((item) => item === needle || Object.is(item, needle));
  }
  if (haystack instanceof Set || haystack instanceof Map) {
    return haystack.has(needle);
  }
  if (isPlainObject(haystack)) {
    // JSON object keys are always strings, so a non-string needle is simply
    // absent rather than an error.
    return typeof needle === "string" && Object.hasOwn(haystack, needle);
  }
  throw new PyTypeError(`argument of type '${pyTypeName(haystack)}' is not iterable`);
}

/**
 * Python's `set(iterable)`, including the part that REFUSES.
 *
 * `set()` requires every element to be hashable, and `list`, `dict` and `set`
 * are not: `set(["a", []])` raises `TypeError: unhashable type: 'list'`
 * uncaught. `renderer.py:335` builds the forbidden-allow exact set exactly
 * that way, so a global config whose `forbidden_allow_exact` holds a nested
 * list or object does not produce a `FenceRefusal` in interlock -- it aborts
 * the render outright, and no spawn happens at all.
 *
 * `new Set(items)` reproduces neither half: it accepts the object happily and
 * the role RENDERS. The guard itself is not disarmed (a Set never matches an
 * object against a string entry), which is exactly why the difference is easy
 * to miss -- what is lost is interlock's hard stop on a malformed global
 * config, and with it the operator's only signal that the file is wrong.
 *
 * Raised, not returned: the caller must not turn this into a refusal reason,
 * because CPython does not either.
 */
export function pySet(items: readonly unknown[]): Set<unknown> {
  for (const item of items) {
    if (!pyHashable(item)) {
      throw new PyTypeError(`unhashable type: '${pyTypeName(item)}'`);
    }
  }
  return new Set(items);
}

/**
 * `hash(value)` would succeed.
 *
 * Everything JSON can carry is hashable except the two containers. The values
 * reaching this subsystem all came out of `loadDocument`, so `list` and `dict`
 * are the only two names CPython could print.
 *
 * Exported because hashability leaks out of `set()` into places that look
 * unrelated: `re.compile` hashes its argument to consult `re._cache`, so
 * `re.compile([])` raises `unhashable type: 'list'` and NOT the
 * `first argument must be string or compiled pattern` that the same call
 * raises for `re.compile(7)`. Both are TypeErrors the renderer turns into a
 * `global-config-invalid` reason, and the reason text is compared byte for
 * byte.
 */
export function pyHashable(value: unknown): boolean {
  return !Array.isArray(value) && !isPlainObject(value);
}

/**
 * Python's `dict(value)`, including both of the ways it REFUSES.
 *
 * `state.py:85` builds the persisted payload with `dict(fence.settings)`, and
 * that call is the only validation a `Fence.settings` ever gets: the dataclass
 * checks nothing, so a fence whose settings are a string, a number or a list is
 * CONSTRUCTED and then dies here. The spread that used to stand in for it
 * (`{...settings}`) refuses nothing at all, and the three shapes below are what
 * that costs -- measured against CPython, not reasoned about:
 *
 *     dict("ab")        ValueError: dictionary update sequence element #0 has
 *                       length 1; 2 is required     | spread: {"0":"a","1":"b"}
 *     dict(7)           TypeError: 'int' object is not iterable
 *                                                   | spread: {}
 *     dict([["a", 1]])  {"a": 1}                    | spread: {"0":["a",1]}
 *
 * Every one of those spread results is a fence that PUBLISHES: a settings
 * payload interlock would have refused to write is written, and the file the
 * provider loads carries either nonsense or nothing where the operator wrote
 * something. The middle row is the worst of the three, because an empty
 * settings object is a syntactically perfect file with no denials in it.
 *
 * Not reachable from {@link ../fencing/spawn.ts | FencedSpawner} -- a rendered
 * fence always carries an object -- but `fenceToJson`, `writeFence` and `Fence`
 * are all exported, so the exported API is exactly where the divergence lives.
 *
 * ## The one thing this cannot reproduce, stated rather than hidden
 *
 * A Python `dict` key may be any hashable value and keeps its type; a
 * JavaScript object key is always a string. `dict([[1, "a"]])` is `{1: "a"}` in
 * CPython and `{"1": "a"}` here. The coercion applied is `json.dumps`'s own key
 * coercion (`1` -> `"1"`, `True` -> `"true"`, `None` -> `"null"`, via
 * {@link ../fencing/pyjson.ts | formatNumber} for numbers), because the only
 * thing this project ever does with the resulting dict is serialise it -- so
 * the coercion happens one step earlier than CPython performs it and the BYTES
 * on disk agree. Two consequences that do not: `{1: "a", "1": "b"}` is two
 * entries in CPython and one here, and CPython's `sort_keys=True` raises
 * `TypeError: '<' not supported between instances of 'str' and 'int'` on a
 * mixed-type key set where this port sorts the coerced strings and writes the
 * file. Neither is reachable from a JSON-sourced document, whose keys are
 * strings by construction.
 */
export function pyDict(value: unknown): Record<string, unknown> {
  // `isinstance(value, Mapping)`: a mapping is COPIED key by key, not treated
  // as an iterable of pairs. `pyKeys`, so the copy keeps the source order the
  // way CPython's dict does -- see `rememberKeyOrder`.
  if (isPlainObject(value)) {
    const keys = pyKeys(value);
    const copied: Record<string, unknown> = {};
    for (const key of keys) {
      // `defineProperty`, never `copied[key] = ...`. Plain assignment routes the
      // single key `"__proto__"` through the inherited accessor on
      // `Object.prototype` instead of creating an own property: the setting
      // vanishes from the copy AND the copy's prototype is replaced.
      //
      // A Python dict has no such key -- `{"__proto__": 1}` is an ordinary
      // entry -- and `"__proto__"` is a perfectly valid JSON key, so a role
      // document may carry one. The damage is quiet and durable: `fenceToJson`
      // would drop it while `settings.local.json`, written down a different
      // path, keeps it, and the restart diff would then report "the settings
      // changed" on every comparison, for a fence nobody changed.
      //
      // `renderer.ts` carries `setOwn` for this same hazard; this is the same
      // fix at the other site that rebuilds an object from a JSON document.
      Object.defineProperty(copied, key, {
        value: value[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    // The spellings travel with the order, for the reason `carryNumberSpellings`
    // gives: `dict(document)` is a REBUILD, and a `1.0` whose spelling stayed
    // behind on the original reaches disk as `1`.
    return carryNumberSpellings(value, rememberKeyOrder(copied, keys));
  }
  // `pyIterate` maps `null`/`undefined` to `[]` as a convenience for the
  // renderer's `pyOr` call sites. Here that convenience would turn `dict(None)`
  // into an empty settings payload -- published, not refused -- where CPython
  // raises. The null check therefore comes first and by hand.
  if (value === null || value === undefined) {
    throw new PyTypeError(`'${pyTypeName(value)}' object is not iterable`);
  }
  const out: Record<string, unknown> = {};
  const order: string[] = [];
  const seen = new Set<string>();
  // A string iterates its CHARACTERS, which is why `dict("ab")` fails at the
  // element and not at the argument: `'a'` is a perfectly good sequence, it is
  // just one item long.
  const items = pyIterate(value);
  for (let index = 0; index < items.length; index += 1) {
    const pair = dictSequenceItem(items[index], index);
    if (pair.length !== 2) {
      throw new PyValueError(
        `dictionary update sequence element #${index} has length ${pair.length}; 2 is required`,
      );
    }
    const rawKey = pair[0];
    // Order matters and is measured: `dict([[["x"], 1]])` has a well-formed
    // 2-element element and still raises, because the KEY is a list. CPython
    // checks the length first and the hash second, so a 3-element element with
    // an unhashable head reports the length, not the hash.
    if (!pyHashable(rawKey)) {
      throw new PyTypeError(`unhashable type: '${pyTypeName(rawKey)}'`);
    }
    const key = dictKey(rawKey);
    if (!seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
    // A repeated key keeps its FIRST position and takes the LAST value, which
    // is what `order` above and this assignment together reproduce.
    out[key] = pair[1];
  }
  return rememberKeyOrder(out, order);
}

/**
 * One element of a `dict()` update sequence, as a sequence.
 *
 * CPython reports a non-sequence element with its own message rather than the
 * `not iterable` one the argument itself would get, so the two are not
 * interchangeable: `dict(7)` and `dict([7])` say different things, and the
 * ledger stores whichever one an operator has to act on.
 */
function dictSequenceItem(element: unknown, index: number): unknown[] {
  const unusable = new PyTypeError(
    `cannot convert dictionary update sequence element #${index} to a sequence`,
  );
  // Same `pyIterate` null convenience as above: `dict([None])` is this message
  // in CPython, and an empty list here would become the length-0 `ValueError`.
  if (element === null || element === undefined) {
    throw unusable;
  }
  try {
    return pyIterate(element);
  } catch (exc) {
    if (exc instanceof PyTypeError) {
      throw unusable;
    }
    throw exc;
  }
}

/**
 * A Python dict key as the JavaScript object property it has to become.
 *
 * `json.dumps`'s coercion, applied early -- see the note in {@link pyDict} for
 * why early, and for what that costs.
 */
function dictKey(key: unknown): string {
  if (typeof key === "string") {
    return key;
  }
  if (key === null || key === undefined) {
    return "null";
  }
  if (typeof key === "boolean") {
    return key ? "true" : "false";
  }
  if (typeof key === "number") {
    // `formatNumber`, not `String`: CPython writes `-0.0` and `1e+300` where
    // `String` writes `0` and `1e+300` -- and the persisted fence is compared
    // byte for byte across a restart.
    return formatNumber(key);
  }
  // A `bigint` is the only remaining hashable JavaScript value, and `String`
  // renders it the way CPython renders an `int` key.
  return String(key);
}

/**
 * A Python `dict`, as distinct from a list.
 *
 * `typeof null === "object"` and `typeof [] === "object"`, so both have to be
 * excluded by hand. Every `isinstance(x, dict)` in the renderer is a
 * fail-closed guard, and a guard that admitted an array would let a list-
 * shaped `sandbox` reach code that reads `.filesystem` off it.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `type(value).__name__`, for the values a refusal message names.
 *
 * These strings are persisted in the ledger as part of a refusal detail, so
 * they are Python's names ("list", "str", "NoneType"), not JavaScript's.
 *
 * For a NUMBER the answer is DOCUMENT-DERIVED, not value-derived, whenever the
 * caller can supply the spelling the source text used -- see
 * {@link pyNumberKind} for why the value alone cannot answer it and
 * {@link pyTypeNameOf} for the form that looks the spelling up. `permissions.deny`
 * set to `1.0` is `got float` in interlock and was `got int` here until the
 * spelling reached this function; the sentence is persisted in a ledger refusal
 * detail, so the difference is durable.
 */
export function pyTypeName(value: unknown, spelling?: PyNumberSpelling | undefined): string {
  if (value === null || value === undefined) {
    return "NoneType";
  }
  if (Array.isArray(value)) {
    return "list";
  }
  switch (typeof value) {
    case "string":
      return "str";
    case "number":
      return pyNumberKind(value, spelling);
    case "bigint":
      return "int";
    case "boolean":
      return "bool";
    case "object":
      return "dict";
    default:
      return typeof value;
  }
}

/**
 * `type(mapping[key]).__name__` with the SOURCE DOCUMENT's spelling applied.
 *
 * The container-and-key form exists because a JavaScript number carries no
 * provenance and cannot be given any without ceasing to be a number (see
 * {@link rememberNumberSpellings}). The spelling lives on the container, so the
 * only callers that can ask a document-derived question are the ones that still
 * hold the container -- which every refusal site in the renderer does.
 */
export function pyTypeNameOf(container: unknown, key: string | number): string {
  const value =
    typeof container === "object" && container !== null
      ? (container as Record<string, unknown>)[String(key)]
      : undefined;
  return pyTypeName(value, pyNumberSpelling(container, key));
}

/**
 * Python's `str()`, for the scalars a rendered fence carries.
 *
 * `String(null)` is `"null"` and `String(true)` is `"true"`; Python's `str`
 * gives `"None"` and `"True"`. The difference reaches disk: `role_kind` is
 * `str(body.get("role_kind", "worker"))`, and the rendered fence is compared
 * across an Interlock-initiated restart, so a role document with
 * `"role_kind": null` must persist `"None"` or the two sides disagree about
 * whether the fence changed.
 *
 * Floats are left to `String`, which differs from Python for whole-valued
 * floats (`str(1.0)` is `"1.0"`, `String(1)` is `"1"`). This is now a REDUCIBLE
 * residue rather than an impossibility: since {@link PyNumberSpelling} the
 * document's spelling is recoverable, and a role document with
 * `"role_kind": 1.0` still persists `"1"` here and `"1.0"` in interlock. It is
 * left alone deliberately. Taking the spelling would mean threading a container
 * and a key through all six call sites -- two of which (`state.ts`) read a
 * value back out of a payload the port itself wrote, where the spelling is
 * whatever this port chose -- and the field it lands in is `role_kind` /
 * `permission_mode`, which no interlock role document spells as a number.
 * Recorded in `parity/fencing.spawn-precondition.ledger.json` rather than
 * fixed on the way past.
 *
 * Containers are NOT left to `String`. Python has no separate `str` for a
 * `list` or a `dict`: `str(x)` on a container IS `repr(x)`, so
 * `str({"a": None})` is `"{'a': None}"` and `str([1, "a"])` is `"[1, 'a']"`.
 * JavaScript's `String` instead gives `"[object Object]"` for an object and a
 * comma-joined, `null`-eliding `"1,a,,true"` for an array. Both land in
 * `Fence.roleKind` / `Fence.permissionMode` -- `role_kind` is
 * `str(body.get("role_kind", "worker"))` and is a wire field per D-0201 -- and
 * the restart check compares those strings, so a role document with a
 * container in `role_kind` would persist a value the source never writes and
 * report "the fence changed" forever. `"[object Object]"` also collapses
 * EVERY distinct object to one string, so two different fences would compare
 * equal.
 */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    return pyRepr(value);
  }
  return String(value);
}

// Python's `repr()` is the neighbouring primitive and deliberately does NOT
// live here: `./pyrepr.js` carries the single transcription of it, shared with
// `rules.ts`, `battery.ts`, `renderer.ts` and -- for containers only --
// `pyStr` above. Two hand-written reprs drift, and a refusal message that
// misnames the offending value is one an operator cannot act on.

/**
 * Where a JSON object's keys stood in the SOURCE TEXT.
 *
 * `Symbol.for`, not a private symbol, so a value that crossed a module
 * boundary compiled twice still matches; non-enumerable by construction, so
 * `Object.keys`, `JSON.stringify` and every `isPlainObject` guard in this
 * subsystem are untouched by its presence.
 *
 * This exists because a JavaScript object CANNOT hold the order Python holds.
 * A `dict` preserves insertion order for every key; a JavaScript object hoists
 * integer-like keys to the front in ascending numeric order and there is no
 * way to build one that enumerates `"10"` before `"2"`. `pyjson.ts` already
 * records that for the SERIALISER, where the answer was to sort on the way
 * out. `repr()` does not sort, so the same hazard reaches
 * {@link ../fencing/pyrepr.ts | pyRepr} and every `for key in mapping` loop
 * with no sort available to hide behind:
 *
 *     allow: [{"10": "a", "2": "b"}]
 *     CPython   allow entry not a string: {'10': 'a', '2': 'b'}
 *     Object.entries  allow entry not a string: {'2': 'b', '10': 'a'}
 *
 * and, through `_check_placeholders`, the ORDER OF THE REFUSAL REASONS
 * themselves, which the ledger stores and the ported tests compare.
 */
const KEY_ORDER = Symbol.for("continuo.pyjson.key-order");

/**
 * Record the source key order on a freshly built object.
 *
 * Called by {@link ../fencing/pyjson.ts | pyJsonLoads} for every object it
 * parses, and by the renderer wherever it REBUILDS a document object
 * (`stripMeta`, `substitute`), because a rebuilt object gets JavaScript's
 * enumeration order back unless the order is carried across with it.
 */
export function rememberKeyOrder<T extends object>(value: T, keys: readonly string[]): T {
  Object.defineProperty(value, KEY_ORDER, {
    value: [...keys],
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return value;
}

/**
 * `list(mapping)`: the keys in PYTHON's order.
 *
 * The recorded order when there is one, `Object.keys` otherwise -- an object
 * built in code, not read from a document, never had a source order and its
 * enumeration order is the one CPython would have seen anyway.
 *
 * Keys recorded but since removed are dropped and keys added since are
 * appended, so this stays correct for an object that was rebuilt key by key.
 */
export function pyKeys(value: Readonly<Record<string, unknown>>): string[] {
  const own = Object.keys(value);
  const recorded = (value as Record<PropertyKey, unknown>)[KEY_ORDER];
  if (!Array.isArray(recorded)) {
    return own;
  }
  const pending = new Set(own);
  const ordered: string[] = [];
  for (const key of recorded as readonly string[]) {
    // `delete` returns false for a key already emitted, which is what makes a
    // duplicated source key (`{"a": 1, "a": 2}`) collapse to one entry at its
    // FIRST position, exactly as CPython's dict does.
    if (pending.delete(key)) {
      ordered.push(key);
    }
  }
  for (const key of own) {
    if (pending.has(key)) {
      ordered.push(key);
    }
  }
  return ordered;
}

/** `mapping.items()`: {@link pyKeys} paired with the values. */
export function pyEntries(value: Readonly<Record<string, unknown>>): [string, unknown][] {
  return pyKeys(value).map((key) => [key, value[key]]);
}

/**
 * How Python spelled one number: as an `int` or as a `float`, and with which
 * digits.
 *
 * `text` is the literal EXACTLY as the source document wrote it, and it is
 * consulted for one case only: an integer whose magnitude is past 2**53, which
 * `JSON.parse` has already rounded to a different value. Re-emitting the
 * recorded text is what makes `9007199254740993` come back out of
 * {@link ../fencing/pyjson.ts | pyJsonDumps} as itself instead of as
 * `9007199254740992`. It is `null` for a spelling asserted in code
 * ({@link PY_FLOAT}), which has no source text behind it.
 *
 * What `text` is NOT: a repaired VALUE. The number in the parsed tree is still
 * the rounded double, so arithmetic on a recovered big integer is arithmetic on
 * the rounded one. That boundary is deliberate -- see the module header of
 * `pyjson.ts` -- because the alternative (a `bigint` or a boxed number in the
 * tree) buys exact arithmetic nothing in this subsystem performs at the price
 * of `===` on ordinary numbers, which the fence's own comparisons are built on.
 */
export interface PyNumberSpelling {
  readonly kind: "int" | "float";
  readonly text: string | null;
}

/**
 * "This number is a Python `float`", for a value produced by CODE rather than
 * read from a document.
 *
 * The one call site that needs it is the fence ledger's `at`, which interlock
 * fills from `time.time()` -- a `float` on every platform, so an integral
 * timestamp prints `0.0` there and printed `0` here until this existed. That
 * one field was the ONLY byte in which a continuo ledger line differed from
 * interlock's for the same inputs.
 */
export const PY_FLOAT: PyNumberSpelling = { kind: "float", text: null };

/**
 * Which Python type a number is, when nobody recorded which one it was.
 *
 * The value alone cannot answer this -- JavaScript has ONE number type, so `1`
 * and `1.0` are the same double and `type(x).__name__` has no local evidence to
 * read. Where a spelling is available it is authoritative; where it is not,
 * this is the classification, and it is chosen to be exact for the values that
 * arise in code rather than in documents:
 *
 * - a safe integer is an `int`, which is what a TypeScript integer literal
 *   stands for and what CPython reads `0`, `2` or a port number as;
 * - `-0` is a `float`, because Python's `int` has no negative zero at all: the
 *   only Python value spelled `-0.0` is a float, so a JavaScript `-0` can only
 *   have come from one;
 * - everything else -- every non-integral value, and every magnitude past
 *   2**53, where "it was an int" is already a claim about a value that has been
 *   rounded -- is a `float`, which also makes `1e300` print as eleven
 *   characters rather than as a 301-digit integer.
 */
export function pyNumberKind(
  value: number,
  spelling?: PyNumberSpelling | undefined,
): "int" | "float" {
  if (spelling !== undefined) {
    return spelling.kind;
  }
  if (Object.is(value, -0)) {
    return "float";
  }
  return Number.isSafeInteger(value) ? "int" : "float";
}

/**
 * Where a JSON number's SPELLING is kept, since the number cannot keep it.
 *
 * Same mechanism as {@link rememberKeyOrder} above, and for the same reason:
 * the property JavaScript cannot represent is recorded beside the value rather
 * than inside it. The difference is what it hangs on. Key order belongs to a
 * mapping, so it hangs on the mapping; a number is a PRIMITIVE, has no identity
 * to key a side table by, and cannot be given one -- a boxed `Number` or a
 * `bigint` would carry the spelling and break `===`, `typeof` and arithmetic on
 * every ordinary number in the tree with it. `state.ts` decides whether a
 * persisted fence is loadable with `payload.format == 1`, and the fence's rules
 * and decisions compare numbers by value throughout; a representation that made
 * those comparisons stop working would be a worse defect than the one it fixed.
 *
 * So the spelling hangs on the CONTAINER, keyed by the property name (an object)
 * or by the decimal index (an array). Non-enumerable, `Symbol.for`, exactly as
 * the key order is, so `Object.keys`, `JSON.stringify` and every
 * `isPlainObject` guard are untouched by its presence.
 *
 * The cost of the choice, stated rather than left to be discovered: a number
 * that is not in a container has nowhere to hang its spelling. That is the
 * root of a document (`pyJsonLoads("1.0")`) and nothing else -- every artefact
 * this subsystem reads has an object or an array at its root.
 */
const NUMBER_SPELLINGS = Symbol.for("continuo.pyjson.number-spellings");

/** Record the source spelling of every number directly inside one container. */
export function rememberNumberSpellings<T extends object>(
  value: T,
  spellings: ReadonlyMap<string, PyNumberSpelling>,
): T {
  if (spellings.size === 0) {
    return value;
  }
  Object.defineProperty(value, NUMBER_SPELLINGS, {
    value: new Map(spellings),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return value;
}

/** The recorded spelling of `container[key]`, if the source text supplied one. */
export function pyNumberSpelling(
  container: unknown,
  key: string | number,
): PyNumberSpelling | undefined {
  if (typeof container !== "object" || container === null) {
    return undefined;
  }
  const recorded = (container as Record<PropertyKey, unknown>)[NUMBER_SPELLINGS];
  if (!(recorded instanceof Map)) {
    return undefined;
  }
  return (recorded as Map<string, PyNumberSpelling>).get(String(key));
}

/**
 * Carry the recorded spellings from a container onto the container REBUILT from
 * it.
 *
 * The companion of the `rememberKeyOrder` call every rebuild site already
 * makes, and needed at exactly the same places for exactly the same reason: a
 * rebuilt object or a mapped array is a NEW container, and a spelling that
 * stayed behind on the old one is a `1.0` that reaches `settings.local.json` as
 * `1`. Entries for keys the rebuild dropped are harmless -- a spelling is only
 * ever read through a key that is still there -- and entries whose value the
 * rebuild REPLACED are harmless too, because a spelling is only consulted for a
 * value that is still a number.
 */
export function carryNumberSpellings<T extends object>(from: unknown, to: T): T {
  if (typeof from !== "object" || from === null) {
    return to;
  }
  const recorded = (from as Record<PropertyKey, unknown>)[NUMBER_SPELLINGS];
  if (!(recorded instanceof Map)) {
    return to;
  }
  return rememberNumberSpellings(to, recorded as Map<string, PyNumberSpelling>);
}

/**
 * Python's `str.strip()` with no argument: strips whitespace per
 * `str.isspace()`.
 *
 * `String.prototype.trim` is not that set -- see {@link isPythonWhitespace} for
 * the two directions it differs in and the fence hole each one opens.
 */
export function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isPythonWhitespace(text[start] as string)) {
    start += 1;
  }
  while (end > start && isPythonWhitespace(text[end - 1] as string)) {
    end -= 1;
  }
  return text.slice(start, end);
}

/**
 * `str.isspace()`, which is NOT JavaScript's `\s`.
 *
 * The two sets differ in both directions, and both directions open a hole:
 *
 * - JS `\s` matches U+FEFF (the byte-order mark); Python's `str.isspace()` does
 *   not. `"\uFEFFBash(...)"` from a BOM-saved document must keep the BOM in the
 *   tool name on both sides, so the mis-authored rule fails the same way here
 *   as it does in interlock.
 * - Python's `str.isspace()` matches U+001C..U+001F (the ASCII file/group/
 *   record/unit separators) and U+0085 (NEL); JS `\s` matches none of them.
 *   This direction is the dangerous one. A deny entry `"\u001cBash(git push *)"`
 *   is stripped by Python to `Bash(git push *)` and denies tool `Bash`. Keeping
 *   the U+001C gives tool `"\u001cBash"`, and a real hook event carries
 *   `tool_name` `"Bash"` -- so THE RULE NEVER FIRES. Worse, the breach battery
 *   stays green, because `witnessSubject` synthesizes its probe from the same
 *   corrupt rule and the probe matches its own rule perfectly. Silent, green,
 *   and open: precisely the failure this subsystem exists to prevent.
 *
 * The membership is checked against CPython over the whole code-point range by
 * the differential vector, not by eye.
 */
function isPythonWhitespace(ch: string): boolean {
  // U+001C..U+001F and U+0085 are whitespace to Python (bidirectional class B
  // or WS) and invisible to JS `\s`.
  if ((ch >= "\u001c" && ch <= "\u001f") || ch === "\u0085") {
    return true;
  }
  // U+FEFF is the only character JS `\s` matches that Python does not.
  return ch !== "\ufeff" && /\s/.test(ch);
}
