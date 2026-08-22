import { describe, expect, test } from "vitest";

import { pythonRepr } from "../../src/control_plane/python_repr.js";

/**
 * `src/control_plane/python_repr.ts` against CPython's `repr`.
 *
 * The renderer exists because five copies of it had accumulated across the
 * belt in four different states, and two were wrong in ways nothing could see:
 * refusal text is asserted by almost nothing, which is exactly why it drifts.
 * The expectations here were measured on CPython.
 */

describe("python_repr (contract)", () => {
  test("scalars render as Python renders them", () => {
    expect(pythonRepr("run")).toBe("'run'");
    // `String(null)` is "null"; Python's repr of absence is `None`, and the
    // guards that raise these messages fire ON absence.
    expect(pythonRepr(null)).toBe("None");
    expect(pythonRepr(undefined)).toBe("None");
    // Python prints True/False, not true/false. One of the five copies this
    // module replaces had no boolean branch at all.
    expect(pythonRepr(true)).toBe("True");
    expect(pythonRepr(false)).toBe("False");
    expect(pythonRepr(7)).toBe("7");
  });

  test("a mapping renders its contents, not [object Object]", () => {
    // Three of the five copies fell through to `String(value)` here, dropping
    // the one thing the message exists to show: WHICH value was rejected.
    expect(pythonRepr({ output_tokens: 5, status: "reported" })).toBe(
      "{'output_tokens': 5, 'status': 'reported'}",
    );
    expect(pythonRepr(["run", "session"])).toBe("['run', 'session']");
  });

  test("a cycle renders Python's ellipsis rather than overflowing the stack", () => {
    // Measured on CPython:
    //   d = {'a': 1}; d['self'] = d  ->  {'a': 1, 'self': {...}}
    //   l = [1]; l.append(l)         ->  [1, [...]]
    // Without this, a cyclic value handed to one of the validation guards that
    // call this renderer overflows the stack, and the caller gets a RangeError
    // instead of the typed refusal the guard is documented to raise.
    const selfish: Record<string, unknown> = { a: 1 };
    selfish["self"] = selfish;
    expect(pythonRepr(selfish)).toBe("{'a': 1, 'self': {...}}");

    const looping: unknown[] = [1];
    looping.push(looping);
    expect(pythonRepr(looping)).toBe("[1, [...]]");
  });

  test("a repeated but acyclic value is rendered each time, not elided", () => {
    // The seen-set is unwound on the way out, so sharing is not mistaken for a
    // cycle -- otherwise the second occurrence of one shared object would
    // silently print as `{...}`.
    const shared = { k: 1 };
    expect(pythonRepr([shared, shared])).toBe("[{'k': 1}, {'k': 1}]");
  });
});
