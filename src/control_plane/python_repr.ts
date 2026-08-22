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
    // Single quotes written by hand, never `JSON.stringify` (D-0017 rule 3):
    // Python's `repr` prefers single quotes and the source's assertions match
    // that text.
    return `'${value}'`;
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
