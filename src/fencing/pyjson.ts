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

import { isPlainObject, PyTypeError, pyKeys, pyTypeName, rememberKeyOrder } from "./pysemantics.js";

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
 * KNOWN LIMIT, stated precisely because the whole point of this module is
 * byte agreement: CPython distinguishes `int` from `float` and this port
 * cannot, because `JSON.parse` collapses `1` and `1.0` to the same `number`.
 * Every number therefore has to be CLASSIFIED, and the rule below is "a safe
 * integer is an `int`, everything else is a `float`":
 *
 * - it is exact for the literals a fencing document actually carries -- `0`,
 *   `2`, a port number, a timeout -- which CPython also reads as `int`;
 * - it is exact for every non-integral float, at every magnitude (measured:
 *   `1e-05`, `0.0001`, `1e-07`, `5e-324`, `1.23e-05`, `-0.0`, `1e-300`,
 *   `6.02e+23`, `1.7976931348623157e+308` all agree byte for byte);
 * - it disagrees for a float literal whose value is integral -- `1e15` is
 *   `1000000000000000.0` to CPython and `1000000000000000` here;
 * - it disagrees for an integer literal above 2**53, which `JSON.parse` has
 *   already rounded to a different value before this function sees it. That
 *   one is unreachable through any parsed document and unfixable here.
 *
 * The cutoff is `Number.isSafeInteger` rather than `Number.isInteger` for the
 * second and third points together: above 2**53 the "it was an int" reading
 * is already wrong (the value has been rounded), and printing the double's
 * exact expansion produced `1.7976931348623157e308` as a 309-DIGIT INTEGER
 * where CPython writes eleven characters. Classifying those as floats makes
 * the large-magnitude cases agree exactly.
 */
export function formatNumber(value: number): string {
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
  if (Object.is(value, -0)) {
    // `JSON.parse("-0.0")` yields -0, and CPython's repr keeps the sign.
    // `(-0).toExponential()` drops it, so the exponential path below would
    // silently write `0.0` for a value the source document spelled `-0.0`.
    return "-0.0";
  }
  if (Number.isSafeInteger(value)) {
    // `int.__repr__`: plain digits, no decimal point, no exponent. Below
    // 2**53 `String` never reaches for exponential notation, so it is already
    // that.
    return String(value);
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

  function encode(item: unknown, level: number): string {
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
      return formatNumber(item);
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
      const parts = item.map((child) => encode(child, level + 1));
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
        return `${encodeString(key, ensureAscii)}${keySeparator}${encode(child, level + 1)}`;
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
 * The order of the keys in one JSON value, as the SOURCE TEXT wrote them.
 *
 * `null` for a scalar, which carries no order and needs no node.
 */
type OrderNode =
  | { readonly keys: readonly string[]; readonly children: readonly (OrderNode | null)[] }
  | { readonly items: readonly (OrderNode | null)[] };

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
 * So the text is scanned a second time, for key order alone, and the order is
 * recorded on each parsed object with
 * {@link ../fencing/pysemantics.ts | rememberKeyOrder}. The scan cannot fail:
 * it only ever runs on text `JSON.parse` has already accepted.
 *
 * The cost of NOT doing this is not cosmetic. `repr()` of a dict is part of
 * several refusal messages, `_check_placeholders` walks a mapping in key order
 * and emits one reason per placeholder, and both are compared byte for byte --
 * against interlock, and against the copy of themselves the ledger stored
 * before the last restart.
 */
export function pyJsonLoads(text: string): unknown {
  const value: unknown = JSON.parse(text);
  applyKeyOrder(value, new KeyOrderScan(text).scan());
  return value;
}

function applyKeyOrder(value: unknown, node: OrderNode | null): void {
  if (node === null) {
    return;
  }
  if ("items" in node) {
    if (!Array.isArray(value)) {
      return;
    }
    node.items.forEach((child, index) => {
      applyKeyOrder(value[index], child ?? null);
    });
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  rememberKeyOrder(value, node.keys);
  node.keys.forEach((key, index) => {
    applyKeyOrder(value[key], node.children[index] ?? null);
  });
}

/**
 * A structure-only scan of JSON text that is already known to be valid.
 *
 * It reads no values: strings are handed back to `JSON.parse` for unescaping
 * so a key spelled `"2"` matches the parsed key `"2"`, and every other
 * scalar is skipped by finding where it ends. Validity is the caller's
 * precondition, which is why nothing here reports an error -- an error would
 * mean `JSON.parse` and this scan disagree about the same bytes, and the
 * defensive `return` in {@link applyKeyOrder} is what keeps that from
 * corrupting an order.
 */
class KeyOrderScan {
  private index = 0;

  constructor(private readonly src: string) {}

  scan(): OrderNode | null {
    this.skipWhitespace();
    return this.value();
  }

  private value(): OrderNode | null {
    const ch = this.src[this.index];
    if (ch === "{") {
      return this.object();
    }
    if (ch === "[") {
      return this.array();
    }
    if (ch === '"') {
      this.string();
      return null;
    }
    this.skipScalar();
    return null;
  }

  private object(): OrderNode {
    this.index += 1;
    const keys: string[] = [];
    const children: (OrderNode | null)[] = [];
    this.skipWhitespace();
    if (this.src[this.index] === "}") {
      this.index += 1;
      return { keys, children };
    }
    for (;;) {
      this.skipWhitespace();
      keys.push(this.string());
      this.skipWhitespace();
      // The ':' separator.
      this.index += 1;
      this.skipWhitespace();
      children.push(this.value());
      this.skipWhitespace();
      if (this.src[this.index] === ",") {
        this.index += 1;
        continue;
      }
      // The closing '}'.
      this.index += 1;
      return { keys, children };
    }
  }

  private array(): OrderNode {
    this.index += 1;
    const items: (OrderNode | null)[] = [];
    this.skipWhitespace();
    if (this.src[this.index] === "]") {
      this.index += 1;
      return { items };
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.value());
      this.skipWhitespace();
      if (this.src[this.index] === ",") {
        this.index += 1;
        continue;
      }
      this.index += 1;
      return { items };
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

  /** A number, `true`, `false` or `null`: skipped up to its delimiter. */
  private skipScalar(): void {
    while (this.index < this.src.length && !SCALAR_END.has(this.src[this.index] as string)) {
      this.index += 1;
    }
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
