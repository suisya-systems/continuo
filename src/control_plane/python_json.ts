/**
 * `json.dumps`, byte for byte, for the JSON this package **persists**.
 *
 * Three modules write JSON into a database column -- the event payload, the
 * `consumption_skipped` audit body, a gate's `options` list -- and interlock
 * writes those same columns with Python's `json.dumps`. The bytes are therefore
 * a parity surface: the differential oracle compares stored text, and two
 * databases whose payload columns differ have diverged even when every
 * assertion that reads through `JSON.parse` agrees.
 *
 * `JSON.stringify` is not that function. It differs in two ways, and each was
 * found in review rather than in a failing test, because no assertion that
 * parses the text can see either:
 *
 * - **Separators.** `json.dumps` defaults to `", "` and `": "`, with the
 *   spaces. `JSON.stringify` emits neither.
 * - **Non-ASCII.** `json.dumps` defaults to `ensure_ascii=True` and escapes
 *   every character from `U+007F` up as `\uXXXX` (lower-case, four digits, a
 *   surrogate *pair* above the BMP). `JSON.stringify` emits the character
 *   raw. This one is not hypothetical here: a gate's rationale or a skip reason
 *   is operator-written prose, and this organization writes prose in Japanese.
 *
 * Measured against CPython, not taken from documentation:
 *
 * ```
 * json.dumps('caf\u00e9')       -> "caf\u00e9"
 * json.dumps('\u65e5\u672c\u8a9e')      -> "\u65e5\u672c\u8a9e"
 * json.dumps('\U0001F600') -> "\ud83d\ude00"   (a surrogate pair)
 * json.dumps('\x7f')       -> "\u007f"           (DEL is escaped too)
 * ```
 *
 * One renderer, per `D-0017` rule 4: a second copy is a second thing to keep in
 * step with Python, and the two copies that existed before this file already
 * disagreed with it in the same way.
 */

/**
 * One JSON string literal, escaped as `json.dumps` escapes it.
 *
 * Built on `JSON.stringify`, which already handles quotes, backslashes and the
 * C0 controls identically, then escaping what `ensure_ascii` would. JavaScript
 * strings are UTF-16, so a character above the BMP is already two code units
 * and escaping each one produces exactly the surrogate pair Python emits.
 */
export function pythonJsonString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** One JSON number or string, as `json.dumps` renders it. */
function pythonJsonScalar(value: string | number): string {
  return typeof value === "string" ? pythonJsonString(value) : JSON.stringify(value);
}

/** `json.dumps(list)` for a list of strings. */
export function pythonJsonList(values: readonly string[]): string {
  return `[${values.map(pythonJsonString).join(", ")}]`;
}

/**
 * `json.dumps(dict)` preserving the **given** order.
 *
 * Python dicts keep insertion order and `json.dumps` follows it, so a payload
 * written as a dict literal is stored in the order the source wrote it -- which
 * is generally not alphabetical.
 */
export function pythonJsonObject(entries: readonly (readonly [string, string | number])[]): string {
  return `{${entries.map(([key, value]) => `${pythonJsonString(key)}: ${pythonJsonScalar(value)}`).join(", ")}}`;
}

/**
 * `json.dumps(value, sort_keys=True)`.
 *
 * Only the flat shape this package writes is handled, and anything else is
 * refused rather than silently emitted as text Python would not have produced.
 */
export function pythonJsonDumpsSorted(value: Record<string, string | number>): string {
  const entries = Object.keys(value)
    .sort(byCodePoint)
    .map((key) => {
      const item = value[key];
      if (typeof item !== "string" && typeof item !== "number") {
        throw new TypeError(
          `pythonJsonDumpsSorted handles only flat string/number payloads; '${key}' is ${typeof item}`,
        );
      }
      return [key, item] as const;
    });
  return pythonJsonObject(entries);
}

/**
 * `json.dumps(value, sort_keys=True)` for an arbitrary JSON document.
 *
 * The flat form above covers the two columns whose payloads are fixed shapes.
 * This one covers a payload assembled from a caller's own map, which can carry
 * `null`, arrays and nested objects. It is here rather than in the module that
 * needed it because the fourth hand-written copy of this logic had already
 * drifted from the other three -- it sorted by UTF-16 code unit while this
 * module had moved to code point -- which is exactly the failure `D-0017`
 * rule 4's "one renderer" exists to stop.
 *
 * `undefined` renders as `null`, matching how the callers build a body from
 * optional fields; Python's `None` is the only spelling of absence there.
 *
 * **One difference cannot be reproduced and is disclosed instead.** Python
 * distinguishes `1` from `1.0` and renders them as `1` and `1.0`; JavaScript
 * has a single number type and cannot tell them apart, so a whole-number float
 * renders here as an integer. Every number this package persists is an integer
 * (timestamps, sequences, counts), so nothing currently reaches it.
 */
export function pythonJsonDocumentSorted(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      // Python emits NaN / Infinity here, which is not valid JSON and which the
      // `json_valid` CHECK on these columns would reject. Refuse rather than
      // write something the database will not accept.
      throw new TypeError(`pythonJsonDocumentSorted cannot render ${String(value)} as JSON`);
    }
    return String(value);
  }
  if (typeof value === "string") {
    return pythonJsonString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(pythonJsonDocumentSorted).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort(byCodePoint)
      .map(
        (key) =>
          `${pythonJsonString(key)}: ${pythonJsonDocumentSorted((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(", ")}}`;
  }
  throw new TypeError(`pythonJsonDocumentSorted cannot render a ${typeof value} as JSON`);
}

/**
 * Python's ordering for `sort_keys=True`, which is by **code point**.
 *
 * JavaScript's default `Array#sort` compares UTF-16 **code units**, and the two
 * disagree above the BMP: an astral character's leading surrogate is `0xD800`
 * to `0xDBFF`, so it sorts *below* `U+E000`..`U+FFFF` under code units and
 * *above* them under code points. Measured, not reasoned about:
 *
 * ```
 * python:  ['a', '\uffff', '\U0001f600']      # 0x61, 0xffff, 0x1f600
 * js sort: ['a', '\u{1f600}', '\uffff']       # 0x61, 0x1f600, 0xffff
 * ```
 *
 * Iterating a string yields code points rather than code units, which is what
 * makes this the right comparison rather than a longer one.
 *
 * The keys this package writes today are all ASCII literals, so nothing
 * currently reaches the disagreement. It is fixed here anyway because this
 * module's whole claim is that its output is `json.dumps` byte for byte, and a
 * claim with a carve-out nobody has written down is the kind that stops being
 * true quietly. Raised by the measurement lane, 2026-08-22.
 */
function byCodePoint(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = (a[index] as string).codePointAt(0) ?? 0;
    const y = (b[index] as string).codePointAt(0) ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.length - b.length;
}
