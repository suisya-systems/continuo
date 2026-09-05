/**
 * CPython's `repr()`, transcribed once.
 *
 * Interlock builds its refusal messages with `!r` -- `f"unparseable sandbox
 * entry: {raw!r}"` and a dozen more like it -- and the ported tests assert on
 * the whole message through `expectRefusal`, so the exact bytes CPython would
 * have produced are part of the observable behaviour this port has to match.
 * `JSON.stringify` is the obvious substitute and is wrong in several
 * independent ways: it always double-quotes, it renders `None` as `null`, and
 * it escapes nothing the way CPython does.
 *
 * **This module exists so there is exactly one transcription.** `rules.ts`,
 * `battery.ts` and `renderer.ts` each grew their own copy, and the copies had
 * already drifted: `renderer.ts`'s fell through to `String(value)` for objects,
 * so a malformed hook entry was reported as `hook not a command: [object
 * Object]` where interlock says `hook not a command: {'cmd': 'x'}`. A refusal
 * message that does not name the offending value is a refusal an operator
 * cannot act on, and two hand-written transcriptions of one CPython primitive
 * will not stay in agreement. Import from here; do not re-transcribe.
 *
 * `type(x).__name__` is the neighbouring primitive and lives in
 * `./pysemantics.js` as `pyTypeName`, for the same one-transcription reason.
 *
 * Pinned against CPython by the differential vector, like the other
 * Python-semantics helpers in this port -- see `docs/differential-oracle.md`.
 */

import { pyNumberText } from "./pyjson.js";
import { type PyNumberSpelling, pyKeys, pyNumberSpelling } from "./pysemantics.js";

/**
 * The complement of `str.isprintable()`, as a character class.
 *
 * CPython's `repr()` escapes every character for which `str.isprintable()` is
 * false, and `str.isprintable()` is defined by Unicode general category:
 * nonprintable is exactly `Cc | Cf | Cs | Co | Cn | Zl | Zp | Zs`, with the
 * single exception of the ASCII space U+0020, which is printable and is
 * carved out below.
 *
 * Spelling it with Unicode property escapes rather than an enumerated list is
 * deliberate: an enumerated list is a snapshot of one Unicode version that
 * silently stops being right, and the failure mode is a rule spec containing an
 * invisible character -- a BOM, a zero-width joiner, a bidi override -- being
 * echoed back into a refusal message *as itself*. The operator then reads a
 * message that looks identical to a well-formed one and cannot see why the rule
 * was rejected.
 */
const NONPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** `str.isprintable()`, for one character. */
function isPythonPrintable(ch: string): boolean {
  // U+0020 is the one Zs that Python calls printable.
  if (ch === " ") {
    return true;
  }
  return !NONPRINTABLE.test(ch);
}

/**
 * `repr()` of a `str`.
 *
 * CPython picks the quote: single, unless the string contains a single quote
 * and no double quote. Note the consequence -- under double quotes a `'` is
 * NOT escaped.
 */
function pyReprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  // Iterating the string yields code points, not UTF-16 units, which is what
  // CPython iterates. A lone surrogate still arrives here as a single unit and
  // is caught by the Cs branch of NONPRINTABLE.
  for (const ch of value) {
    if (ch === quote || ch === "\\") {
      out += `\\${ch}`;
      continue;
    }
    if (ch === "\t") {
      out += "\\t";
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") {
      out += "\\r";
      continue;
    }
    const code = ch.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    if (code < 0x7f || isPythonPrintable(ch)) {
      out += ch;
      continue;
    }
    // Non-printable above U+007F. CPython chooses the shortest escape that
    // fits, and the width is load-bearing: a literal U+00A0 and the four
    // characters `\xa0` are different text, and the ported tests compare
    // refusal messages byte for byte.
    if (code < 0x100) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else if (code < 0x10000) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += `\\U${code.toString(16).padStart(8, "0")}`;
    }
  }
  return out + quote;
}

/**
 * Python's `repr()`, for the JSON-shaped values that reach a refusal message.
 *
 * The domain is what `json.load` can produce -- `None`, `bool`, `int`, `float`,
 * `str`, `list`, `dict` -- plus `undefined`, which is what a missing key looks
 * like in TypeScript and which Python would have seen as `None`.
 *
 * `spelling` is how a NUMBER's `int`/`float` identity and its exact digits reach
 * this function, and it is optional for the same reason
 * {@link ../fencing/pysemantics.ts | pyTypeName}'s is: a JavaScript number
 * carries no provenance, the record hangs on its CONTAINER, and only a caller
 * still holding the container can supply it. Callers that hold one should use
 * {@link pyReprOf}. It is needed only for a number this function is handed
 * DIRECTLY: the container arms below look each child's spelling up themselves,
 * so `repr()` of a dict or a list is document-faithful with no argument at all.
 */
export function pyRepr(value: unknown, spelling?: PyNumberSpelling | undefined): string {
  if (typeof value === "string") {
    return pyReprString(value);
  }
  if (value === null || value === undefined) {
    return "None";
  }
  if (value === true) {
    return "True";
  }
  if (value === false) {
    return "False";
  }
  if (typeof value === "number") {
    // `String(value)` is not CPython's number formatting and diverges on three
    // reachable shapes: `1e16` is `1e+16` to CPython and `10000000000000000`
    // to `String`, `1e20` is `1e+20` and `100000000000000000000`, and `-0.0`
    // is `-0.0` and `0`. `permission_mode: 1e16` reaches a refusal message, so
    // this is not theoretical. `pyNumberText` is the single transcription of
    // CPython's `repr(float)` / `repr(int)` split, shared with `json.dumps` --
    // which uses the same primitive in CPython -- and re-deriving it here is
    // what this module's header forbids.
    return pyNumberText(value, spelling);
  }
  if (Array.isArray(value)) {
    // Python renders a one-element list as `[x]` and never `[x,]`.
    //
    // The spelling of each element is looked up HERE rather than expected from
    // the caller: this array IS the container the record hangs on, so a nested
    // `1.0` reprs as `1.0` without any call site having to thread anything.
    // Without it `allow entry not a string: [1.0]` read `[1]` where interlock
    // writes `[1.0]`, in a refusal detail the ledger stores verbatim.
    return `[${value.map((item, index) => pyRepr(item, pyNumberSpelling(value, index))).join(", ")}]`;
  }
  if (typeof value === "object") {
    // `pyKeys`, not `Object.keys`: `repr()` of a dict does NOT sort, so there
    // is nowhere later to repair the order. A JavaScript object hoists
    // integer-like keys to the front, so `{"10": "a", "2": "b"}` reprs as
    // `{'2': 'b', '10': 'a'}` here and `{'10': 'a', '2': 'b'}` in CPython --
    // reachable through `allow entry not a string: {...}`, which the ported
    // tests compare byte for byte. Note the contrast with `pyjson.ts`, which
    // SORTS: sorting here would be a different wrong answer.
    const record = value as Record<string, unknown>;
    const keys = pyKeys(record);
    // The value's spelling is read off THIS object, for the reason the array
    // arm above states.
    return `{${keys
      .map((k) => `${pyReprString(k)}: ${pyRepr(record[k], pyNumberSpelling(record, k))}`)
      .join(", ")}}`;
  }
  return String(value);
}

/**
 * `repr(container[key])` with the SOURCE DOCUMENT's number spelling applied.
 *
 * The container-and-key companion of {@link pyRepr}, and the exact analogue of
 * {@link ../fencing/pysemantics.ts | pyTypeNameOf} -- which several refusal
 * sites already call on the same slot, one interpolation away. Use it wherever
 * a refusal names a value the document supplied and the container is still in
 * hand; `pyRepr` alone is correct only for a value with no document behind it,
 * or for a container, whose children look themselves up.
 */
export function pyReprOf(container: unknown, key: string | number): string {
  const value =
    typeof container === "object" && container !== null
      ? (container as Record<string, unknown>)[String(key)]
      : undefined;
  return pyRepr(value, pyNumberSpelling(container, key));
}
