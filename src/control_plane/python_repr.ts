/**
 * Python's `repr`, for the values this package interpolates into refusal text.
 *
 * `D-0017` rule 3 says Python's `repr` of a name becomes single quotes written
 * by hand, and rule 4 says rows interpolated into messages get **one**
 * renderer. This is that one renderer for `control_plane`.
 *
 * It exists because the alternative was measured rather than imagined: five
 * copies of this function had accumulated across the belt, in four different
 * states, and two of them were wrong in ways no test could see -- refusal text
 * is asserted by almost nothing, which is exactly why it drifts.
 *
 * - `events.ts`, `ci_ingest.ts`, `lease.ts` -- string / None / bool, then
 *   `String(value)`. An object therefore rendered as `[object Object]`,
 *   dropping the one thing the message exists to show.
 * - `repo_link.ts` -- no boolean branch at all, so `True` printed as `true`.
 * - `ai_invocation.ts` -- the complete one, which is what this file is.
 *
 * Every message that names a rejected value is how an operator finds out
 * *which* value was rejected, so "nothing asserts it" is a reason to centralise
 * it, not a reason to leave it.
 */

/**
 * Render `value` the way Python's `repr` would, for the shapes that reach
 * refusal text here: strings, `None`, booleans, numbers, lists and mappings.
 *
 * Deliberately not a general `repr`: it covers what this subsystem
 * interpolates and nothing more. A shape it does not know falls through to
 * `String(value)`, which is what every copy it replaces already did.
 */
export function pythonRepr(value: unknown): string {
  return renderRepr(value, new Set());
}

/**
 * `repr` of a string, with Python's quoting and escaping.
 *
 * Not simply "wrap it in apostrophes" -- that is what this renderer used to do,
 * and it produced `'a'b'` for a value containing a quote: ambiguous text, not
 * parity text, on the paths that report exactly which rejected value the caller
 * passed. Measured against CPython:
 *
 * ```
 * repr("a'b")   -> "a'b"      # switches to double quotes
 * repr('a"b')   -> 'a"b'      # stays single
 * repr('a\'"b') -> 'a\'"b'    # both present: single, with the quote escaped
 * repr('a\\b')   -> 'a\\b'
 * repr('a\nb')   -> 'a\nb'
 * ```
 *
 * So: prefer single quotes; switch to double only when the value contains a
 * single quote AND no double quote; otherwise escape the single quote.
 * Backslash and the C0 controls are escaped either way (D-0017 rule 3, the
 * mechanical-format contract).
 */
function reprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = "";
  for (const character of value) {
    if (character === "\\") {
      out += "\\\\";
    } else if (character === quote) {
      out += `\\${quote}`;
    } else if (character === "\n") {
      out += "\\n";
    } else if (character === "\r") {
      out += "\\r";
    } else if (character === "\t") {
      out += "\\t";
    } else {
      const code = character.codePointAt(0) ?? 0;
      // Python escapes anything `str.isprintable()` calls unprintable, not just
      // the C0 controls: `repr("\u0085")` is `'\\x85'` and `repr("\u2028")` is
      // `'\\u2028'`. `ensure_ascii` is a `json.dumps` default rather than a repr
      // one, so printable non-ASCII stays literal -- but a C1 control or a line
      // separator emitted raw is both non-parity text and a way to put a line
      // break into a log through a refusal message.
      //
      // Approximated rather than reproduced exactly: full `isprintable()` needs
      // the Unicode category table. This covers the classes reachable here --
      // C0, DEL, C1, the line and paragraph separators, and lone surrogates --
      // and the approximation is recorded in the ledger.
      const unprintable =
        code < 0x20 ||
        code === 0x7f ||
        (code >= 0x80 && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029 ||
        (code >= 0xd800 && code <= 0xdfff);
      if (!unprintable) {
        out += character;
      } else if (code <= 0xff) {
        out += `\\x${code.toString(16).padStart(2, "0")}`;
      } else {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
      }
    }
  }
  return `${quote}${out}${quote}`;
}

/**
 * The recursive half, carrying the set of containers already being rendered.
 *
 * Python's `repr` detects a cycle and prints an ellipsis marker rather than
 * recursing forever: a self-referencing dict is `{'a': 1, 'self': {...}}` and a
 * self-referencing list is `[1, [...]]`. Without that, a cyclic value handed to
 * one of the validation guards that call this renderer overflows the stack, and
 * the caller gets a `RangeError` instead of the typed refusal the guard is
 * documented to raise -- the error about the bad input replaced by an error
 * about rendering it.
 */
function renderRepr(value: unknown, seen: Set<object>): string {
  if (typeof value === "string") {
    return reprString(value);
  }
  // `String(null)` is "null" and `String(undefined)` is "undefined"; Python's
  // repr of the absence these stand for is `None`. These messages are how an
  // operator reads back what was rejected, and the guards that raise them fire
  // *on* absence -- so absence has to render as the source renders it.
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  // A list, before the object branch: an array is an object, and rendering one
  // as a mapping of its indices would be worse than `[object Object]`.
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[...]";
    }
    seen.add(value);
    try {
      return `[${value.map((item) => renderRepr(item, seen)).join(", ")}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (value instanceof Map) {
    if (seen.has(value)) {
      return "{...}";
    }
    seen.add(value);
    try {
      const entries = [...value.entries()].map(
        ([key, item]) => `${renderRepr(key, seen)}: ${renderRepr(item, seen)}`,
      );
      return `{${entries.join(", ")}}`;
    } finally {
      seen.delete(value);
    }
  }
  if (value instanceof Set) {
    if (seen.has(value)) {
      return "{...}";
    }
    seen.add(value);
    try {
      return `{${[...value].map((item) => renderRepr(item, seen)).join(", ")}}`;
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "{...}";
    }
    seen.add(value);
    try {
      const entries = Object.entries(value as Record<string, unknown>).map(
        ([key, item]) => `${renderRepr(key, seen)}: ${renderRepr(item, seen)}`,
      );
      return `{${entries.join(", ")}}`;
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}

/**
 * `repr(list_of_strings)` -- a Python list of single-quoted names.
 *
 * Kept distinct from {@link pythonRepr}'s array branch only as a named
 * shorthand for the common `repr(sorted(...))` case; it produces the same text.
 */
export function pythonList(values: readonly string[]): string {
  return `[${values.map((value) => `'${value}'`).join(", ")}]`;
}

/**
 * `repr(tuple_of_strings)` -- and the trailing comma of a 1-tuple.
 *
 * `('ok',)` is what makes it a tuple rather than a parenthesised expression,
 * and Python prints it. A renderer that drops it produces text no Python
 * program would have written.
 */
export function pythonTuple(values: readonly string[]): string {
  const rendered = values.map((value) => `'${value}'`);
  return rendered.length === 1 ? `(${rendered[0]},)` : `(${rendered.join(", ")})`;
}
