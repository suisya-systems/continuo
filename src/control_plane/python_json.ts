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
    .sort()
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
