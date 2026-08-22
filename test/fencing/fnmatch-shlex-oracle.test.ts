import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { fnmatchcase } from "../../src/fencing/fnmatch.js";
import { expanduser, normpath } from "../../src/fencing/pypath.js";
import { pyRepr } from "../../src/fencing/pyrepr.js";
import { pyStrip } from "../../src/fencing/pysemantics.js";
import { quote, ShlexError, split } from "../../src/fencing/shlex.js";

/**
 * The fnmatch/shlex differential oracle.
 *
 * **Target-only.** These cases translate no interlock node id. They exist
 * because `src/fencing/fnmatch.ts` and `src/fencing/shlex.ts` are
 * *transcriptions* of CPython, and a transcription is only checkable against
 * the thing it transcribes -- interlock's suite has nothing to say about it,
 * since in Python the behaviour is supplied by the standard library and is true
 * by construction.
 *
 * That is the ceiling `docs/differential-oracle.md` section 1 describes,
 * arriving in a new place: translate interlock's fencing suite perfectly and a
 * wrong bracket-expression parser is still invisible, because every ported case
 * asserts a fence decision that both a right and a slightly-wrong matcher
 * happen to agree on. The rules that *would* separate them are the ones nobody
 * wrote a test for.
 *
 * Authority: `DECISIONS.md` D-0200. Regeneration:
 * `scripts/oracle/dump_fnmatch_shlex.py`, by hand, never from this side.
 */

const ROOT = join(import.meta.dirname, "..", "..");

type SplitExpectation = { readonly tokens: string[] } | { readonly error: string };

interface Vector {
  readonly python_version: string;
  readonly fnmatch: {
    readonly patterns: number;
    readonly names: number;
    readonly count: number;
    readonly translate: string[];
    readonly expected: boolean[];
  };
  readonly shlex_split: { readonly count: number; readonly expected: SplitExpectation[] };
  readonly shlex_quote: { readonly count: number; readonly expected: string[] };
  readonly pypath: {
    readonly oracle_home: string;
    readonly normpath: { readonly count: number; readonly expected: string[] };
    readonly expanduser: { readonly count: number; readonly expected: string[] };
  };
  readonly pystr: {
    readonly repr: { readonly count: number; readonly expected: string[] };
    readonly repr_nonstring: { readonly count: number; readonly expected: string[] };
    readonly strip: { readonly count: number; readonly expected: string[] };
  };
}

interface Corpus {
  readonly fnmatch: { readonly patterns: string[]; readonly names: string[] };
  readonly shlex_split: string[];
  readonly shlex_quote: string[];
  readonly pypath: {
    readonly oracle_home: string;
    readonly normpath: string[];
    readonly expanduser: string[];
    readonly expanduser_accepted_deviations: string[];
  };
  readonly pystr: {
    readonly repr: string[];
    readonly repr_nonstring: string[];
    readonly strip: string[];
  };
}

const corpus: Corpus = JSON.parse(
  readFileSync(join(ROOT, "parity", "oracle", "fnmatch-shlex-corpus.json"), "utf8"),
);
const vector: Vector = JSON.parse(
  readFileSync(join(ROOT, "parity", "oracle", "fnmatch-shlex-vector.json"), "utf8"),
);

describe("the vector is not vacuous", () => {
  /**
   * A golden file regenerated from a failed or empty run would let every
   * comparison below pass while comparing nothing. The pilot's oracle carries
   * the same guard for the same reason.
   */
  test("the corpus rebuilds to the size the vector was generated at", () => {
    expect(corpus.fnmatch.patterns.length).toBe(vector.fnmatch.patterns);
    expect(corpus.fnmatch.names.length).toBe(vector.fnmatch.names);
    expect(vector.fnmatch.count).toBe(corpus.fnmatch.patterns.length * corpus.fnmatch.names.length);
    expect(vector.fnmatch.expected).toHaveLength(vector.fnmatch.count);
    expect(corpus.shlex_split).toHaveLength(vector.shlex_split.count);
    expect(corpus.shlex_quote).toHaveLength(vector.shlex_quote.count);
    expect(corpus.pypath.normpath).toHaveLength(vector.pypath.normpath.count);
    expect(corpus.pypath.expanduser).toHaveLength(vector.pypath.expanduser.count);
    expect(vector.pypath.oracle_home).toBe(corpus.pypath.oracle_home);
  });

  test("the corpus exercises both answers, and both outcomes of a split", () => {
    // All-false would be satisfied by a matcher that never matches, which is
    // the safe direction and therefore the one most likely to pass unnoticed.
    const matched = vector.fnmatch.expected.filter(Boolean).length;
    expect(matched).toBeGreaterThan(50);
    expect(matched).toBeLessThan(vector.fnmatch.count - 50);
    // The error paths are where a lexer transcription drifts most easily.
    expect(vector.shlex_split.expected.filter((e) => "error" in e).length).toBeGreaterThan(0);
    expect(vector.shlex_split.expected.filter((e) => "tokens" in e).length).toBeGreaterThan(0);
  });
});

describe("fnmatch.fnmatchcase agrees with CPython at every position", () => {
  /**
   * One case for the whole product rather than 6,789 cases: the comparison is
   * positional, and a failure has to name the pattern and the name that
   * diverged, which a per-position `test.each` would do at the cost of making
   * the suite's case count depend on the corpus size -- and the parity ledger
   * counts target tests.
   *
   * Every mismatch is collected before failing. The first divergence is rarely
   * the informative one; a whole class of them (every pattern with a bracket
   * expression, say) is what points at the branch that is wrong.
   */
  test("every pattern x name in the corpus", () => {
    const mismatches: string[] = [];
    let index = 0;
    for (const [patternIndex, pattern] of corpus.fnmatch.patterns.entries()) {
      for (const name of corpus.fnmatch.names) {
        const expected = vector.fnmatch.expected[index] as boolean;
        let actual: boolean | string;
        try {
          actual = fnmatchcase(name, pattern);
        } catch (error) {
          actual = `threw ${error instanceof Error ? error.message : String(error)}`;
        }
        if (actual !== expected) {
          mismatches.push(
            `pattern ${JSON.stringify(pattern)} vs name ${JSON.stringify(name)}: ` +
              `CPython ${expected}, continuo ${String(actual)} ` +
              `(CPython translate: ${JSON.stringify(vector.fnmatch.translate[patternIndex])})`,
          );
        }
        index += 1;
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });
});

describe("shlex agrees with CPython at every position", () => {
  test("split, including the inputs CPython refuses", () => {
    const mismatches: string[] = [];
    for (const [index, text] of corpus.shlex_split.entries()) {
      const expected = vector.shlex_split.expected[index] as SplitExpectation;
      let actual: SplitExpectation;
      try {
        actual = { tokens: split(text) };
      } catch (error) {
        if (!(error instanceof ShlexError)) {
          mismatches.push(
            `input ${JSON.stringify(text)}: threw a non-ShlexError: ${String(error)}`,
          );
          continue;
        }
        actual = { error: error.message };
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `input ${JSON.stringify(text)}: CPython ${JSON.stringify(expected)}, ` +
            `continuo ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  test("quote", () => {
    const mismatches: string[] = [];
    for (const [index, text] of corpus.shlex_quote.entries()) {
      const expected = vector.shlex_quote.expected[index] as string;
      const actual = quote(text);
      if (actual !== expected) {
        mismatches.push(
          `input ${JSON.stringify(text)}: CPython ${JSON.stringify(expected)}, ` +
            `continuo ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  test("quote and split round-trip, which is the property the renderer needs", () => {
    // The renderer quotes a path into a command line and then parses that line
    // back to check the flags. If the pair does not round-trip, a correct
    // configuration is refused -- and the backslash case is the one that bites,
    // because `shlex.split` treats `\` as an escape on every platform.
    for (const text of corpus.shlex_quote) {
      expect(split(`launcher ${quote(text)}`)[1], `round-trip of ${JSON.stringify(text)}`).toBe(
        text,
      );
    }
  });
});

describe("posixpath agrees with CPython at every position", () => {
  /**
   * `normpath` is where a plausible substitution -- Node's
   * `path.posix.normalize` -- silently moves what a sandbox deny rule covers.
   * `src/fencing/pypath.ts` lists the rows where the two disagree; this is what
   * checks that the transcription sits on CPython's side of them.
   */
  test("normpath", () => {
    const mismatches: string[] = [];
    for (const [index, input] of corpus.pypath.normpath.entries()) {
      const expected = vector.pypath.normpath.expected[index] as string;
      const actual = normpath(input);
      if (actual !== expected) {
        mismatches.push(
          `input ${JSON.stringify(input)}: CPython ${JSON.stringify(expected)}, ` +
            `continuo ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  test("expanduser, with HOME pinned to the value the vector was generated at", () => {
    // The home directory is passed explicitly rather than read from the
    // environment: an oracle that depended on the runner's `HOME` would compare
    // two environments and call it a comparison of two implementations.
    const home = corpus.pypath.oracle_home;
    const accepted = new Set(corpus.pypath.expanduser_accepted_deviations);
    const mismatches: string[] = [];
    for (const [index, input] of corpus.pypath.expanduser.entries()) {
      const expected = vector.pypath.expanduser.expected[index] as string;
      const actual = expanduser(input, home);
      if (accepted.has(input)) {
        // A `~someuser` path, which Node cannot resolve. The deviation is
        // asserted rather than excused: continuo must return the path
        // UNCHANGED (CPython's own lookup-failed branch), and CPython must have
        // done something else -- otherwise this entry has gone stale and is
        // licensing a divergence that no longer exists.
        //
        // It is also CONTAINED rather than merely accepted. `expanduser` is a
        // transcription and stays one, so that it remains checkable against
        // CPython right here; the refusal lives one layer up, where
        // `parseSandboxEntry` rejects a `~user` path on posix with
        // `RuleSyntaxError`. So no fence rule can be built on a path this
        // branch passed through unresolved -- the silent hole (a deny rule
        // covering nothing, no probe, no error) is closed at the boundary, not
        // by bending the transcription. See `DECISIONS.md` D-0203.
        expect(actual, `accepted deviation ${JSON.stringify(input)} must pass through`).toBe(input);
        expect(
          expected,
          `${JSON.stringify(input)} is listed as a deviation but CPython agrees; ` +
            "remove it from expanduser_accepted_deviations",
        ).not.toBe(actual);
        continue;
      }
      if (actual !== expected) {
        mismatches.push(
          `input ${JSON.stringify(input)}: CPython ${JSON.stringify(expected)}, ` +
            `continuo ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });
});

describe("the Python string semantics in rules.ts agree with CPython", () => {
  /**
   * These two helpers look like conveniences and are not. `repr` decides the
   * text of a refusal message, and the ported tests assert both halves of a
   * refusal through `expectRefusal` -- so a `repr` that quotes differently from
   * CPython either fails a faithful translation or, worse, passes a sloppy one.
   */
  test("repr, over strings", () => {
    const mismatches: string[] = [];
    for (const [index, input] of corpus.pystr.repr.entries()) {
      const expected = vector.pystr.repr.expected[index] as string;
      const actual = pyRepr(input);
      if (actual !== expected) {
        mismatches.push(`input ${JSON.stringify(input)}: CPython ${expected}, continuo ${actual}`);
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  test("repr, over the non-string values a malformed document can carry", () => {
    // Named rather than embedded: JSON cannot express Python's int/float
    // distinction, and `repr(1)` and `repr(1.0)` differ.
    const values: Record<string, unknown> = {
      none: null,
      true: true,
      false: false,
      int_0: 0,
      int_42: 42,
      int_neg1: -1,
      list_empty: [],
      list_abc: ["a", "b", "c"],
      dict_empty: {},
      dict_ab: { a: 1, b: "x" },
    };
    const mismatches: string[] = [];
    for (const [index, name] of corpus.pystr.repr_nonstring.entries()) {
      const expected = vector.pystr.repr_nonstring.expected[index] as string;
      const actual = pyRepr(values[name]);
      if (actual !== expected) {
        mismatches.push(`value ${name}: CPython ${expected}, continuo ${actual}`);
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  test("strip, where it parts company with trim()", () => {
    const mismatches: string[] = [];
    for (const [index, input] of corpus.pystr.strip.entries()) {
      const expected = vector.pystr.strip.expected[index] as string;
      const actual = pyStrip(input);
      if (actual !== expected) {
        mismatches.push(
          `input ${JSON.stringify(input)}: CPython ${JSON.stringify(expected)}, ` +
            `continuo ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });
});
