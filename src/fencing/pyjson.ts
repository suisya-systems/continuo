/**
 * CPython's `json.dumps`, transcribed once, for the JSON-shaped values this
 * subsystem persists.
 *
 * This is NOT a convenience wrapper over `JSON.stringify`. Interlock writes
 * every durable fencing artefact through `json.dumps(..., sort_keys=True)` --
 * `fencing/state.py:121` (the persisted fence, `indent=2`),
 * `fencing/state.py:185` (the fence digest input, `separators=(",", ":")`),
 * `fencing/spawn.py:116` (the spawn ledger line) and `fencing/spawn.py:320`
 * (the child's `settings.local.json`) -- and the restart path compares those
 * artefacts BY BYTES to decide whether the fence changed. A serialiser that
 * agrees with CPython on every value except one therefore does not produce a
 * "slightly different file": it produces a permanent, unfixable "the fence
 * changed" on every restart for the documents it disagrees on, or -- in the
 * digest case -- two different digests for one fence.
 *
 * The specific reason a sorted-key OBJECT cannot stand in for a sorted-key
 * SERIALISER: a JavaScript object always enumerates integer-like keys FIRST,
 * in ascending numeric order, no matter what order they were inserted in.
 * There is no way to build an object whose enumeration order is
 * `"10"` before `"2"`, and that is exactly the order CPython's pure-string key
 * sort produces:
 *
 *     env {"10": "a", "2": "b", "b": "c", "a": "d"}
 *     CPython  {"10": "a", "2": "b", "a": "d", "b": "c"}
 *     stringify {"2": "b", "10": "a", "a": "d", "b": "c"}
 *
 * So a role whose `env` carries a numeric-looking key ("2", "10", a PID, a
 * port) renders a byte-different settings document on every render while the
 * in-memory payload looks perfectly correct. Sorting happens HERE, at
 * serialisation time, where the ordering can be expressed.
 *
 * Domain: what `JSON.parse` can produce -- `null`, boolean, number, string,
 * array, plain object -- plus `undefined`, which is what a missing key looks
 * like in TypeScript and which Python would have seen as `None`. Anything else
 * is a `TypeError` in CPython and a {@link PyTypeError} here rather than a
 * silently dropped key, because a dropped key in a settings payload is a fence
 * rendered without a section its author wrote.
 *
 * ## Numbers: what the second scan recovers, and what it does not
 *
 * JavaScript has ONE number type, so two things CPython knows about a JSON
 * number are gone by the time `JSON.parse` returns: whether the document wrote
 * an `int` or a `float` (`1` and `1.0` become the same double, and `json.dumps`
 * spells them differently and `type(x).__name__` answers differently), and the
 * exact digits of an integer past 2**53 (`9007199254740993` comes back as
 * `...992`, so the authored value is destroyed before anything can serialise
 * it). Both reach disk through artefacts this port compares BY BYTES.
 *
 * {@link pyJsonLoads} already rescans the source text once, to recover the key
 * order `JSON.parse` destroys. That scan now also records, for every number it
 * passes, the spelling the source used -- `int` or `float` by Python's own rule
 * (a `.`, an `e` or an `E` makes it a float), plus the literal text. The record
 * hangs on the CONTAINER, keyed by property name or by array index, because a
 * number is a primitive with no identity to hang anything on; see
 * {@link ../fencing/pysemantics.ts | rememberNumberSpellings} for why boxing it
 * instead would have been the worse defect (`===` on ordinary numbers is what
 * the fence's own comparisons are built on, and it is untouched here).
 * {@link formatNumber} then re-emits the spelling CPython would have written,
 * and {@link ../fencing/pysemantics.ts | pyTypeNameOf} answers `int`/`float`
 * per the DOCUMENT rather than per the JavaScript value. A number that never
 * came from a document -- a literal in TypeScript, a computed value -- carries
 * no spelling and is classified by value, which is exact for the shapes code
 * produces (see `pyNumberKind`).
 *
 * What is still lost, stated narrowly so the claim above stays true:
 *
 * - the VALUE of an integer past 2**53 is still the rounded double. The exact
 *   digits are recovered for RE-EMISSION only, so a big integer round-trips
 *   through this module unchanged and arithmetic on it is arithmetic on the
 *   rounded value.
 * - a number at the ROOT of a document has no container slot, so
 *   `pyJsonLoads("1.0")` still dumps as `1`. Every fencing artefact -- the
 *   persisted fence, a settings document, a ledger line, a role document -- has
 *   an object at its root.
 * - a container REBUILT without carrying its spellings across loses them. This
 *   is a standing obligation on every rebuild site, not a property the module
 *   can enforce: the record hangs on the container, so a new container starts
 *   empty and nothing goes red when one forgets. The five sites in this port
 *   are `stripMeta`, `substitute`, `deepSortKeys` and `settingsPayload` in
 *   `renderer.ts`, and `pyDict` in `pysemantics.ts`; four carry the record with
 *   `carryNumberSpellings`, next to the `rememberKeyOrder` call they already
 *   made for the same reason, and `settingsPayload` carries it key by key
 *   because one of its keys does not come from the container it copies. **Any
 *   new rebuild site has to do the same, and has to be pinned**: D-0210 shipped
 *   with `deepSortKeys` uncarried and this list naming only three, and neither
 *   the suite nor this comment said so -- the repair reached everything except
 *   `settings.local.json` and the persisted fence, which were the artefacts it
 *   was for. See D-0211.
 * - `pyStr` still renders an integral float as an int, which is visible only
 *   for a role document that spells `role_kind` or `permission_mode` as a
 *   number. Recorded there rather than fixed in passing.
 *
 * It lives beside `./pyrepr.js` rather than inside it because the two
 * primitives escape DIFFERENTLY and share nothing but a superficial
 * resemblance: `repr()` picks its quote character and emits backslash-x and
 * eight-digit backslash-U escapes; `json.dumps` always double-quotes, has no
 * backslash-x escape at all, and spells an astral character as a SURROGATE
 * PAIR of four-digit backslash-u escapes. Putting them in one file invites
 * reusing one escaper for the other, and the result would be a settings file
 * CPython cannot even parse back.
 *
 * Pinned against CPython by the differential vector, like the other
 * Python-semantics helpers in this port -- see `docs/differential-oracle.md`.
 */

import {
  isPlainObject,
  type PyNumberSpelling,
  PyTypeError,
  pyKeys,
  pyNumberKind,
  pyNumberSpelling,
  pyTypeName,
  rememberKeyOrder,
  rememberNumberSpellings,
} from "./pysemantics.js";

/** Options mirroring the `json.dumps` keyword arguments this port uses. */
export interface PyJsonDumpsOptions {
  /**
   * `sort_keys=True`: sort each mapping's keys by code point before emitting.
   *
   * WITHOUT it, key order is the JavaScript object's enumeration order, and
   * that is NOT the source document's insertion order: integer-like keys have
   * already been hoisted to the front by the time `JSON.parse` returns.
   * Measured: an `env` of `{"10", "2", "b", "a"}` dumps unsorted as
   * `"2"`-then-`"10"` here and `"10"`-then-`"2"` in CPython. So the unsorted
   * form reproduces CPython only for a payload BUILT IN CODE with
   * non-numeric keys (interlock's one unsorted `json.dumps` in this
   * subsystem, `fencing/hook.py:220`, is exactly that). Anything read from a
   * document and written back must pass `sortKeys: true`, which is what all
   * four durable fencing artefacts do.
   */
  sortKeys?: boolean;
  /**
   * `indent=N`: pretty-print with N spaces per level.
   *
   * CPython treats `indent=0` and `indent=None` as DIFFERENT: `0` still puts
   * every item on its own line (with no leading spaces), `None` keeps
   * everything on one line. Omitting the option is `None`.
   */
  indent?: number;
  /**
   * `separators=(item, key)`. Defaults follow CPython exactly: `(", ", ": ")`
   * with no indent, `(",", ": ")` once an indent is given -- because a trailing
   * space before a newline would be dead weight in the pretty-printed form.
   */
  separators?: readonly [string, string];
  /**
   * `ensure_ascii`. CPython's default is `true` (escape every non-ASCII
   * character as `\uXXXX`), and it is the default here for the same reason:
   * silently switching to raw UTF-8 output would change the bytes of every
   * artefact carrying a non-ASCII value.
   */
  ensureAscii?: boolean;
}

/**
 * Lexicographic comparison by CODE POINT, which is what CPython's `sorted()`
 * does to `str` keys.
 *
 * `Array.prototype.sort` compares UTF-16 CODE UNITS, and the two orders
 * disagree for exactly one region: an astral character (U+10000 and above) is
 * stored as a surrogate pair starting at U+D800..U+DBFF, so JavaScript sorts it
 * BELOW every character in U+E000..U+FFFF, while CPython sorts it above. A
 * private-use or CJK-compatibility key next to an emoji key is enough to swap
 * two lines of the settings document -- and since the restart check is a byte
 * comparison, that is a fence that reports "changed" forever.
 */
function compareByCodePoint(a: string, b: string): number {
  // Iterating a string yields code points, not code units, so this walks the
  // same sequence CPython would.
  const ita = a[Symbol.iterator]();
  const itb = b[Symbol.iterator]();
  for (;;) {
    const ca = ita.next();
    const cb = itb.next();
    if (ca.done === true) {
      // A prefix sorts before its extensions; equal length means equal string.
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

/** The short escapes CPython's json encoder emits by name rather than by code. */
const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * `json.encoder.encode_basestring{,_ascii}`.
 *
 * Note what is NOT escaped, in both modes: U+007F (DEL). CPython's ASCII
 * encoder escapes `[^ -~]`, and its non-ASCII encoder escapes `[\x00-\x1f\\"]`;
 * DEL falls outside the first range but inside the printable half of the
 * second, so it survives as a raw character in `ensure_ascii=False` output and
 * is written as a four-digit escape under the default. Writing "escape all
 * control characters" here would be more sensible and would disagree with the
 * file on disk.
 */
function encodeString(value: string, ensureAscii: boolean): string {
  let out = '"';
  // Code points, not code units: an astral character has to be measured whole
  // to decide whether it needs escaping, and then re-emitted as the surrogate
  // PAIR CPython writes.
  for (const ch of value) {
    const short = SHORT_ESCAPES[ch];
    if (short !== undefined) {
      out += short;
      continue;
    }
    const code = ch.codePointAt(0) as number;
    if (code < 0x20) {
      out += unicodeEscape(code);
      continue;
    }
    if (!ensureAscii || code < 0x7f) {
      out += ch;
      continue;
    }
    if (code < 0x10000) {
      out += unicodeEscape(code);
      continue;
    }
    // CPython emits the UTF-16 surrogate pair, not `\U0001f600`: the JSON
    // grammar has no eight-digit escape, so a `repr`-style escape here would
    // produce a settings file no JSON parser could read back.
    const rest = code - 0x10000;
    out += unicodeEscape(0xd800 + (rest >> 10));
    out += unicodeEscape(0xdc00 + (rest & 0x3ff));
  }
  return `${out}"`;
}

/**
 * `float.__repr__`, which is what `json.dumps` uses for every non-integral
 * number.
 *
 * `String(n)` is close but not equal, and the differences are visible in a
 * byte comparison:
 *
 * - the exponent threshold: `String(1e17)` is `"100000000000000000"` where
 *   CPython says `"1e+17"` (CPython switches to exponential once the decimal
 *   point sits past digit 16 or at/before -4; JavaScript waits until 1e21);
 * - the exponent width: `String(1e-7)` is `"1e-7"`, CPython says `"1e-07"`.
 *
 * The shortest round-tripping digit string itself is the same in both -- both
 * implement Ryu/Grisu-style shortest repr -- so it is taken from
 * `toExponential()`, which is specified to produce "as many digits as
 * necessary to uniquely specify the number", and only the FORMATTING is
 * redone.
 *
 * WHICH repr is used is decided by {@link ../fencing/pysemantics.ts | pyNumberKind}
 * from the SOURCE SPELLING where there is one and from the value where there is
 * not -- the whole int/float question this module used to have no answer to.
 * The two arms:
 *
 * - `int`: plain digits, no decimal point, no exponent. Below 2**53 that is
 *   `String(value)`; above it the double has already been rounded and the only
 *   faithful answer is the literal the DOCUMENT wrote, which is what
 *   `spelling.text` carries (`9007199254740993`, not `...992`). With neither --
 *   an `int` spelling asserted in code over a value past 2**53 -- the exact
 *   expansion of the double is the honest reading of what is actually held.
 * - `float`: `float.__repr__`, including `Py_DTSF_ADD_DOT_0`, so an integral
 *   float prints `0.0`, `1.0`, `1000000000000000.0` and `1e+16` rather than
 *   `0`, `1`, `1000000000000000` and `1e+16`.
 *
 * Measured against CPython across the magnitude range by the differential
 * vector: `1e-05`, `0.0001`, `1e-07`, `5e-324`, `1.23e-05`, `-0.0`, `1e-300`,
 * `6.02e+23` and `1.7976931348623157e+308` all agree byte for byte, and so do
 * the round trips of `0`, `0.0`, `1.0`, `-0.0`, `-0`, `1e16`, `1E16`, `1e+16`,
 * `1e-7`, `9007199254740992`, `9007199254740993`, `-9007199254740993` and a
 * thirty-digit integer.
 */
export function formatNumber(value: number, spelling?: PyNumberSpelling | undefined): string {
  if (Number.isNaN(value)) {
    // `allow_nan=True` is CPython's default, and these three spellings are not
    // legal JSON. Reproduced rather than rejected: interlock never passes
    // allow_nan=False, so a NaN in a document produces a file that CPython can
    // read back and other parsers cannot, and this port has to make the same
    // file.
    return "NaN";
  }
  if (value === Number.POSITIVE_INFINITY) {
    return "Infinity";
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return "-Infinity";
  }
  if (pyNumberKind(value, spelling) === "int") {
    // `int.__repr__`: plain digits, no decimal point, no exponent.
    if (Number.isSafeInteger(value)) {
      // Below 2**53 `String` never reaches for exponential notation, so it is
      // already that -- and `String(-0)` is `"0"`, which is right: a document
      // that spells `-0` is spelling Python's `int` 0, whose repr has no sign.
      return String(value);
    }
    if (spelling?.text != null) {
      // The document's own digits. `JSON.parse` rounded `9007199254740993` to
      // `...992` before anything here could see it, so the VALUE is no longer
      // evidence of what was written and re-deriving the text from it would
      // write a different integer into a file that is compared by bytes.
      return spelling.text;
    }
    if (Number.isInteger(value)) {
      // An `int` asserted in code over a magnitude past 2**53. There is no
      // source text to fall back on, so the double's exact integer value --
      // what is actually held -- is printed, which is also what CPython's
      // `int()` of the same float would repr.
      return BigInt(value).toString();
    }
    // An `int` spelling over a value that is not integral describes a Python
    // value that cannot exist. Rather than throw inside a serialiser whose
    // failure mode is an unwritten fence, the value is printed as what it
    // demonstrably is, and the float arm below does that.
  }
  if (Object.is(value, -0)) {
    // CPython's float repr keeps the sign. `(-0).toExponential()` drops it, so
    // the exponential path below would silently write `0.0` for a value the
    // source document spelled `-0.0`.
    return "-0.0";
  }
  const [mantissa, exponentText] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  const negative = (mantissa as string).startsWith("-");
  const digits = (mantissa as string).replace("-", "").replace(".", "");
  // `decpt` in CPython's format_float_short: the position of the decimal point
  // relative to the start of the digit string.
  const decpt = exponent + 1;
  const sign = negative ? "-" : "";
  if (decpt <= -4 || decpt > 16) {
    const head = digits.slice(0, 1);
    const tail = digits.slice(1);
    const expDigits = Math.abs(exponent).toString().padStart(2, "0");
    const expSign = exponent < 0 ? "-" : "+";
    return `${sign}${head}${tail === "" ? "" : `.${tail}`}e${expSign}${expDigits}`;
  }
  if (decpt <= 0) {
    return `${sign}0.${"0".repeat(-decpt)}${digits}`;
  }
  if (decpt >= digits.length) {
    // Py_DTSF_ADD_DOT_0: a float whose repr would otherwise look like an int
    // gets a trailing `.0`.
    return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
  }
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

/**
 * `json.dumps` for JSON-shaped values.
 *
 * Returns the CANONICAL form. Where a byte comparison, a digest or a file
 * write is involved, this string -- not the in-memory object -- is the thing
 * that has to be produced and compared.
 */
export function pyJsonDumps(value: unknown, options: PyJsonDumpsOptions = {}): string {
  const sortKeys = options.sortKeys ?? false;
  const ensureAscii = options.ensureAscii ?? true;
  const indent = options.indent;
  const indented = indent !== undefined;
  const [itemSeparator, keySeparator] =
    options.separators ?? (indented ? [",", ": "] : [", ", ": "]);
  const indentUnit = indented ? " ".repeat(indent) : "";

  function newlineIndent(level: number): string {
    return indented ? `\n${indentUnit.repeat(level)}` : "";
  }

  // `spelling` is how the SOURCE DOCUMENT wrote this particular number, looked
  // up from the container on the way in rather than carried by the value --
  // which a JavaScript number cannot do. It is `undefined` for the root and for
  // anything built in code, and `formatNumber` then classifies by value.
  function encode(item: unknown, level: number, spelling?: PyNumberSpelling | undefined): string {
    if (item === null || item === undefined) {
      return "null";
    }
    if (item === true) {
      return "true";
    }
    if (item === false) {
      return "false";
    }
    if (typeof item === "string") {
      return encodeString(item, ensureAscii);
    }
    if (typeof item === "number") {
      return formatNumber(item, spelling);
    }
    if (typeof item === "bigint") {
      return item.toString();
    }
    if (Array.isArray(item)) {
      if (item.length === 0) {
        // CPython special-cases the empty container: no newline, no indent.
        return "[]";
      }
      const inner = newlineIndent(level + 1);
      const parts = item.map((child, childIndex) =>
        encode(child, level + 1, pyNumberSpelling(item, childIndex)),
      );
      return `[${inner}${parts.join(itemSeparator + inner)}${newlineIndent(level)}]`;
    }
    if (item instanceof Map || item instanceof Set || item instanceof Date) {
      // These pass `isPlainObject` (it only rules out arrays and null), and
      // falling into the mapping branch below would serialise a populated Map
      // as `{}` -- a settings file silently missing everything it was meant to
      // carry. CPython raises here; so does this.
      throw new PyTypeError(
        `Object of type ${(item as object).constructor.name} is not JSON serializable`,
      );
    }
    if (isPlainObject(item)) {
      // Own keys in the order the SOURCE DOCUMENT wrote them -- which is not
      // the object's enumeration order, because JavaScript forces integer-like
      // keys to the front. That hoisting is precisely why the sort below
      // cannot be delegated to the object and has to happen on the way out,
      // and `pyKeys` is what makes the UNSORTED branch (interlock's
      // `fencing/hook.py:220`) right for a payload that came from a document.
      let keys = pyKeys(item);
      if (sortKeys) {
        keys = keys.sort(compareByCodePoint);
      }
      if (keys.length === 0) {
        return "{}";
      }
      const inner = newlineIndent(level + 1);
      const parts = keys.map((key) => {
        const child = (item as Record<string, unknown>)[key];
        return `${encodeString(key, ensureAscii)}${keySeparator}${encode(
          child,
          level + 1,
          pyNumberSpelling(item, key),
        )}`;
      });
      return `{${inner}${parts.join(itemSeparator + inner)}${newlineIndent(level)}}`;
    }
    // A function, a symbol, a Map, a Date: CPython raises `TypeError: Object of
    // type X is not JSON serializable`. Raised rather than skipped, because a
    // skipped key writes a settings file that is missing a section its author
    // wrote and reports success.
    throw new PyTypeError(`Object of type ${pyTypeName(item)} is not JSON serializable`);
  }

  return encode(value, 0);
}

/**
 * What one JSON container held that the parsed value cannot hold: the order the
 * SOURCE TEXT wrote its keys in, and how the source text spelled each of its
 * numbers.
 *
 * `null` for a scalar, which is not a container and needs no node. The
 * `numbers` map is keyed by property name for an object and by decimal index
 * for an array, which is the key {@link ../fencing/pysemantics.ts | pyNumberSpelling}
 * looks a slot up by.
 */
type OrderNode =
  | {
      readonly keys: readonly string[];
      readonly children: readonly (OrderNode | null)[];
      readonly numbers: ReadonlyMap<string, PyNumberSpelling>;
    }
  | {
      readonly items: readonly (OrderNode | null)[];
      readonly numbers: ReadonlyMap<string, PyNumberSpelling>;
    };

/** One scanned value: its container node, and -- if it was a number -- its spelling. */
interface Scanned {
  readonly node: OrderNode | null;
  readonly spelling: PyNumberSpelling | null;
}

/**
 * `json.loads`, preserving the source key order that `JSON.parse` destroys.
 *
 * `JSON.parse` is still what produces every VALUE and every parse ERROR here:
 * its number handling, its string unescaping and its exception text are the
 * ones the rest of this port and the ported tests are pinned against, and
 * hand-rolling substitutes for them to gain key order would be trading a large
 * correctness surface for a small one. What it cannot do is remember that the
 * document said `{"10": ..., "2": ...}` in that order -- a JavaScript object
 * hoists integer-like keys to the front and no amount of care while building
 * one avoids it.
 *
 * So the text is scanned a second time, and what that scan recovers is recorded
 * on each parsed container: the key order, with
 * {@link ../fencing/pysemantics.ts | rememberKeyOrder}, and the spelling of
 * every number, with
 * {@link ../fencing/pysemantics.ts | rememberNumberSpellings} -- the second
 * property `JSON.parse` destroys, and for the same reason (see the module
 * header). The scan cannot fail: it only ever runs on text `JSON.parse` has
 * already accepted.
 *
 * The cost of NOT doing this is not cosmetic. `repr()` of a dict is part of
 * several refusal messages, `_check_placeholders` walks a mapping in key order
 * and emits one reason per placeholder, and both are compared byte for byte --
 * against interlock, and against the copy of themselves the ledger stored
 * before the last restart.
 */
export function pyJsonLoads(text: string): unknown {
  const value: unknown = JSON.parse(text);
  applyDocumentOrder(value, new DocumentScan(text).scan());
  return value;
}

function applyDocumentOrder(value: unknown, node: OrderNode | null): void {
  if (node === null) {
    return;
  }
  if ("items" in node) {
    if (!Array.isArray(value)) {
      return;
    }
    rememberNumberSpellings(value, node.numbers);
    node.items.forEach((child, index) => {
      applyDocumentOrder(value[index], child ?? null);
    });
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  rememberKeyOrder(value, node.keys);
  rememberNumberSpellings(value, node.numbers);
  node.keys.forEach((key, index) => {
    applyDocumentOrder(value[key], node.children[index] ?? null);
  });
}

/**
 * A scan of JSON text that is already known to be valid, for the two properties
 * the parsed value cannot hold.
 *
 * It interprets almost nothing: strings are handed back to `JSON.parse` for
 * unescaping so a key spelled `"2"` matches the parsed key `"2"`, and the only
 * other scalar it looks INSIDE is a number, whose literal text is the sole
 * surviving evidence of how the document spelled it. Validity is the caller's
 * precondition, which is why nothing here reports an error -- an error would
 * mean `JSON.parse` and this scan disagree about the same bytes, and the
 * defensive `return` in {@link applyDocumentOrder} is what keeps that from
 * corrupting an order.
 */
class DocumentScan {
  private index = 0;

  constructor(private readonly src: string) {}

  scan(): OrderNode | null {
    this.skipWhitespace();
    // The root's own spelling is discarded, and this is the one thing the
    // mechanism cannot carry: a spelling hangs on a CONTAINER SLOT, and the root
    // of a document sits in no container. `pyJsonLoads("1.0")` therefore still
    // dumps as `1`. Every artefact this subsystem reads -- the persisted fence,
    // a settings document, a ledger line, a role document -- has an object at
    // its root, so no caller in the port reaches the case.
    return this.value().node;
  }

  private value(): Scanned {
    const ch = this.src[this.index];
    if (ch === "{") {
      return { node: this.object(), spelling: null };
    }
    if (ch === "[") {
      return { node: this.array(), spelling: null };
    }
    if (ch === '"') {
      this.string();
      return { node: null, spelling: null };
    }
    return { node: null, spelling: this.scalar() };
  }

  private object(): OrderNode {
    this.index += 1;
    const keys: string[] = [];
    const children: (OrderNode | null)[] = [];
    const numbers = new Map<string, PyNumberSpelling>();
    this.skipWhitespace();
    if (this.src[this.index] === "}") {
      this.index += 1;
      return { keys, children, numbers };
    }
    for (;;) {
      this.skipWhitespace();
      const key = this.string();
      keys.push(key);
      this.skipWhitespace();
      // The ':' separator.
      this.index += 1;
      this.skipWhitespace();
      const scanned = this.value();
      children.push(scanned.node);
      if (scanned.spelling !== null) {
        // `set`, so a DUPLICATED key keeps the LAST spelling -- which is the
        // value `JSON.parse` kept, while `pyKeys` keeps the FIRST position. The
        // two halves of `{"a": 1, "a": 2.0}` have to agree with each other or
        // the spelling would describe a value that is no longer there.
        numbers.set(key, scanned.spelling);
      }
      this.skipWhitespace();
      if (this.src[this.index] === ",") {
        this.index += 1;
        continue;
      }
      // The closing '}'.
      this.index += 1;
      return { keys, children, numbers };
    }
  }

  private array(): OrderNode {
    this.index += 1;
    const items: (OrderNode | null)[] = [];
    const numbers = new Map<string, PyNumberSpelling>();
    this.skipWhitespace();
    if (this.src[this.index] === "]") {
      this.index += 1;
      return { items, numbers };
    }
    for (;;) {
      this.skipWhitespace();
      const scanned = this.value();
      if (scanned.spelling !== null) {
        numbers.set(String(items.length), scanned.spelling);
      }
      items.push(scanned.node);
      this.skipWhitespace();
      if (this.src[this.index] === ",") {
        this.index += 1;
        continue;
      }
      this.index += 1;
      return { items, numbers };
    }
  }

  /** The string starting at the cursor, unescaped by `JSON.parse` itself. */
  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.src.length) {
      const ch = this.src[this.index];
      if (ch === "\\") {
        // Skip the escape AND the character it escapes, so a `\"` does not end
        // the string and a `\\` does not swallow the closing quote.
        this.index += 2;
        continue;
      }
      this.index += 1;
      if (ch === '"') {
        break;
      }
    }
    return JSON.parse(this.src.slice(start, this.index)) as string;
  }

  /**
   * A number, `true`, `false` or `null`, consumed up to its delimiter -- and,
   * for a number, CLASSIFIED the way Python's JSON grammar classifies it.
   *
   * This is the second thing the rescan exists for. `JSON.parse` has already
   * turned `1` and `1.0` into the same double and `9007199254740993` into
   * `...992`; the source text is the only surviving evidence of either, and
   * this is the last point at which it is in hand.
   *
   * The rule is CPython's own, from `json/scanner.py`: a literal containing a
   * `.`, an `e` or an `E` goes to `parse_float`, and everything else goes to
   * `parse_int`. It is applied to text `JSON.parse` has already accepted, so a
   * leading digit or `-` is enough to tell a number from `true`/`false`/`null`.
   */
  private scalar(): PyNumberSpelling | null {
    const start = this.index;
    while (this.index < this.src.length && !SCALAR_END.has(this.src[this.index] as string)) {
      this.index += 1;
    }
    const text = this.src.slice(start, this.index);
    const first = text[0];
    if (first === undefined || (first !== "-" && (first < "0" || first > "9"))) {
      return null;
    }
    const isFloat = text.includes(".") || text.includes("e") || text.includes("E");
    return { kind: isFloat ? "float" : "int", text };
  }

  private skipWhitespace(): void {
    while (this.index < this.src.length && JSON_WHITESPACE.has(this.src[this.index] as string)) {
      this.index += 1;
    }
  }
}

/** The four characters RFC 8259 allows between tokens. */
const JSON_WHITESPACE: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r"]);

/** What terminates an unquoted scalar. */
const SCALAR_END: ReadonlySet<string> = new Set([",", "}", "]", " ", "\t", "\n", "\r"]);
