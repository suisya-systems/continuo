import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { fnmatchcase } from "../../src/fencing/fnmatch.js";
import { type PyJsonDumpsOptions, pyJsonDumps, pyJsonLoads } from "../../src/fencing/pyjson.js";
import { expanduser, normalizePath, normpath } from "../../src/fencing/pypath.js";
import { compilePythonRegex, PythonRegexError } from "../../src/fencing/pyregex.js";
import { pyRepr } from "../../src/fencing/pyrepr.js";
import {
  PyTypeError,
  pyEntries,
  pyIn,
  pyIterate,
  pyOr,
  pySet,
  pyStr,
  pyStrip,
} from "../../src/fencing/pysemantics.js";
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

/**
 * One regex pattern's answer: either what `re.search` found for every subject,
 * or the `re.error` `re.compile` raised.
 *
 * The search half is ONE STRING rather than a list, encoded `"start,end"` per
 * subject and joined with `|`, with an empty cell for no match. 190 patterns x
 * 107 subjects is 20,330 answers, and a vector at one JSON line per answer is a
 * file nobody reads. The offsets are CODE POINTS, because `re` counts code
 * points and JavaScript counts UTF-16 units -- the comparison has to be in the
 * unit both sides can express.
 */
type RegexExpectation = { readonly search: string } | { readonly error: string };

type IterateExpectation = { readonly items: string[] } | { readonly error: string };
type InExpectation = { readonly result: boolean } | { readonly error: string };
type SetExpectation = { readonly items: string[] } | { readonly error: string };

interface LoadsExpectation {
  /** `[path, keys]` for every mapping in the document, in dict order. */
  readonly key_order: [string, string[]][];
  readonly roundtrip: string;
}

interface MappingExpectation {
  readonly keys: string[];
  readonly items: [string, string][];
}

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
  readonly pyregex: {
    readonly patterns: number;
    readonly subjects: number;
    readonly expected: RegexExpectation[];
  };
  readonly pyjson: {
    readonly dumps: { readonly count: number; readonly expected: string[] };
    readonly dumps_numbers: { readonly count: number; readonly expected: string[] };
    readonly loads: { readonly count: number; readonly expected: LoadsExpectation[] };
  };
  readonly pysemantics: {
    readonly or: { readonly count: number; readonly expected: string[] };
    readonly iterate: { readonly count: number; readonly expected: IterateExpectation[] };
    readonly in: { readonly count: number; readonly expected: InExpectation[] };
    readonly set: { readonly count: number; readonly expected: SetExpectation[] };
    readonly str: { readonly count: number; readonly expected: string[] };
    readonly mapping: { readonly count: number; readonly expected: MappingExpectation[] };
  };
  readonly normalize_path: {
    readonly oracle_username: string;
    readonly count: number;
    readonly posix: string[];
    readonly windows: string[];
  };
}

interface Corpus {
  readonly fnmatch: { readonly patterns: string[]; readonly names: string[] };
  readonly shlex_split: string[];
  readonly shlex_quote: string[];
  readonly pypath: {
    readonly oracle_home: string;
    readonly oracle_username: string;
    readonly normpath: string[];
    readonly expanduser: string[];
    readonly expanduser_accepted_deviations: string[];
    readonly normalize_path: string[];
    readonly normalize_path_accepted_deviations: string[];
  };
  readonly pystr: {
    readonly repr: string[];
    readonly repr_nonstring: string[];
    readonly strip: string[];
  };
  readonly pyregex: {
    readonly patterns: string[];
    readonly subjects: string[];
    readonly refused: string[];
    readonly refusal_message_deviations: string[];
    readonly python_only_refusals: string[];
    readonly ignorecase_match_deviations: [string, string][];
    readonly astral_anchor_match_deviations: [string, string][];
  };
  readonly pyjson: {
    readonly dumps: string[];
    readonly dumps_options: string[];
    readonly dumps_numbers: string[];
    readonly dumps_number_accepted_deviations: string[];
    readonly loads: string[];
  };
  readonly pysemantics: {
    readonly values: string[];
    readonly or: [string, string][];
    readonly iterate: string[];
    readonly in: [string, string][];
    readonly set: string[][];
    readonly iterate_accepted_deviations: string[];
    readonly set_accepted_deviations: string[][];
    readonly str: string[];
    readonly mapping_texts: string[];
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
    expect(corpus.pyregex.patterns.length).toBe(vector.pyregex.patterns);
    expect(corpus.pyregex.subjects.length).toBe(vector.pyregex.subjects);
    expect(vector.pyregex.expected).toHaveLength(corpus.pyregex.patterns.length);
    expect(corpus.pyjson.dumps.length * corpus.pyjson.dumps_options.length).toBe(
      vector.pyjson.dumps.count,
    );
    expect(corpus.pyjson.dumps_numbers).toHaveLength(vector.pyjson.dumps_numbers.count);
    expect(corpus.pyjson.loads).toHaveLength(vector.pyjson.loads.count);
    expect(corpus.pysemantics.or).toHaveLength(vector.pysemantics.or.count);
    expect(corpus.pysemantics.iterate).toHaveLength(vector.pysemantics.iterate.count);
    expect(corpus.pysemantics.in).toHaveLength(vector.pysemantics.in.count);
    expect(corpus.pysemantics.set).toHaveLength(vector.pysemantics.set.count);
    expect(corpus.pysemantics.str).toHaveLength(vector.pysemantics.str.count);
    expect(corpus.pysemantics.mapping_texts).toHaveLength(vector.pysemantics.mapping.count);
    expect(corpus.pypath.normalize_path).toHaveLength(vector.normalize_path.count);
    expect(vector.normalize_path.oracle_username).toBe(corpus.pypath.oracle_username);
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
    // Same guard one level up for the regex face: a corpus of patterns CPython
    // rejects would compare only refusals, and a corpus that never matches
    // would be satisfied by a translator that emits `(?!)`.
    const compiled = vector.pyregex.expected.filter((e) => "search" in e);
    expect(compiled.length).toBeGreaterThan(100);
    expect(vector.pyregex.expected.filter((e) => "error" in e).length).toBeGreaterThan(10);
    const cells = compiled.flatMap((e) => (e as { search: string }).search.split("|"));
    expect(cells.filter((cell) => cell !== "").length).toBeGreaterThan(1000);
    expect(cells.filter((cell) => cell === "").length).toBeGreaterThan(1000);
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

/**
 * A JavaScript string index, in the unit CPython counts.
 *
 * `re` reports offsets in CODE POINTS and `RegExp` in UTF-16 code units, so the
 * two are only comparable after a conversion, and only one direction is
 * available: JavaScript can count code points, Python cannot count surrogates.
 *
 * A caveat worth stating rather than discovering: `index` can fall BETWEEN the
 * two halves of an astral character (see the astral-anchor deviations below),
 * and `slice` there yields a lone surrogate, which `Array.from` counts as one.
 * That is deliberate -- the offset the divergence reports is the one an
 * operator would see -- and it is why the deviation list records positions that
 * look off by one.
 */
function codePointOffset(text: string, index: number): number {
  return Array.from(text.slice(0, index)).length;
}

/** The key a `[pattern, subject]` deviation entry is looked up by. */
function pairKey(pattern: string, subject: string): string {
  return JSON.stringify([pattern, subject]);
}

describe("the CPython regex dialect agrees with CPython", () => {
  /**
   * `renderer.py:_check_forbidden_allow` compiles AUTHOR-SUPPLIED patterns out
   * of the global config and runs `search` over every `permissions.allow`
   * entry, so CPython's regex dialect is part of the fence exactly as fnmatch's
   * glob dialect is -- and `src/fencing/pyregex.ts` is a thousand lines of
   * translation between two dialects that agree on most of their surface and
   * not on all of it.
   *
   * The module's own header records what an enumerate-the-known-bad translator
   * cost the first time: `.` was not on the list of constructs somebody had
   * noticed, it was copied through verbatim, and a differential fuzz found 54
   * match divergences of which every single one was `.`. That fuzz was run once
   * and thrown away. This is the same claim, made from a committed corpus that
   * anybody can rerun -- which is the difference between evidence and an
   * anecdote (`docs/differential-oracle.md` section 5).
   */
  test("the patterns each side refuses, in both directions", () => {
    const refused = new Set(corpus.pyregex.refused);
    const messageDeviations = new Set(corpus.pyregex.refusal_message_deviations);
    const pythonOnly = new Set(corpus.pyregex.python_only_refusals);
    const mismatches: string[] = [];

    for (const [index, pattern] of corpus.pyregex.patterns.entries()) {
      const expected = vector.pyregex.expected[index] as RegexExpectation;
      const pythonError = "error" in expected ? expected.error : undefined;
      const label = `pattern ${JSON.stringify(pattern)}`;

      let thrown: unknown;
      try {
        compilePythonRegex(pattern);
      } catch (error) {
        thrown = error;
      }
      if (
        thrown !== undefined &&
        !(thrown instanceof PythonRegexError || thrown instanceof SyntaxError)
      ) {
        // A refusal has to be one of the two kinds the caller converts into a
        // `global-config-invalid` reason. Anything else is the port crashing,
        // and "it threw" must not be allowed to stand in for that.
        mismatches.push(
          `${label}: threw neither PythonRegexError nor SyntaxError: ${String(thrown)}`,
        );
        continue;
      }
      const message = thrown === undefined ? undefined : (thrown as Error).message;

      if (refused.has(pattern)) {
        if (message === undefined) {
          mismatches.push(`${label}: listed under pyregex.refused, but continuo compiled it`);
        } else if (pythonError !== undefined) {
          mismatches.push(
            `${label}: listed under pyregex.refused (a construct CPython accepts), but CPython ` +
              `refuses it too (${pythonError}); the entry belongs in ` +
              "refusal_message_deviations or nowhere",
          );
        }
        continue;
      }

      if (pythonOnly.has(pattern)) {
        // The open defect, asserted from both ends so that closing it turns
        // this list red rather than leaving it as a false confession.
        if (pythonError === undefined) {
          mismatches.push(
            `${label}: listed under pyregex.python_only_refusals, but CPython compiled it`,
          );
        }
        if (message !== undefined) {
          mismatches.push(
            `${label}: listed under pyregex.python_only_refusals, but continuo refuses it too ` +
              `(${message}) -- the defect is fixed; remove the entry`,
          );
        }
        continue;
      }

      if (pythonError !== undefined) {
        if (message === undefined) {
          mismatches.push(
            `${label}: CPython refuses it (${pythonError}) and continuo COMPILED it -- the ` +
              "interlock-refuses-continuo-renders direction",
          );
          continue;
        }
        if (messageDeviations.has(pattern)) {
          if (message === pythonError) {
            mismatches.push(
              `${label}: listed under pyregex.refusal_message_deviations, but the two messages ` +
                "now agree; remove the entry",
            );
          }
          continue;
        }
        if (message !== pythonError) {
          mismatches.push(
            `${label}: CPython ${JSON.stringify(pythonError)}, ` +
              `continuo ${JSON.stringify(message)}`,
          );
        }
        continue;
      }

      if (message !== undefined) {
        mismatches.push(
          `${label}: CPython compiled it, continuo refused with ${JSON.stringify(message)} -- ` +
            "an unlisted refusal. Fail-closed is the safe direction, but an unrecorded refusal " +
            "is a document interlock renders and continuo does not, with nothing saying so.",
        );
      }
    }

    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  test("re.search agrees at every pattern x subject", () => {
    // Patterns one side refuses have no search result to compare; they are
    // asserted by the test above and skipped here.
    const skip = new Set([...corpus.pyregex.refused, ...corpus.pyregex.python_only_refusals]);
    const declared = new Map<string, string>();
    for (const [pattern, subject] of corpus.pyregex.ignorecase_match_deviations) {
      declared.set(pairKey(pattern, subject), "ignorecase_match_deviations");
    }
    for (const [pattern, subject] of corpus.pyregex.astral_anchor_match_deviations) {
      declared.set(pairKey(pattern, subject), "astral_anchor_match_deviations");
    }
    const exercised = new Set<string>();
    const mismatches: string[] = [];

    for (const [index, pattern] of corpus.pyregex.patterns.entries()) {
      const expected = vector.pyregex.expected[index] as RegexExpectation;
      if (!("search" in expected) || skip.has(pattern)) {
        continue;
      }
      const cells = expected.search.split("|");
      const compiled = compilePythonRegex(pattern);
      for (const [subjectIndex, subject] of corpus.pyregex.subjects.entries()) {
        const found = compiled.exec(subject);
        const actual =
          found === null
            ? ""
            : `${codePointOffset(subject, found.index)},` +
              `${codePointOffset(subject, found.index + found[0].length)}`;
        const want = cells[subjectIndex] as string;
        const key = pairKey(pattern, subject);
        const listed = declared.get(key);
        if (actual === want) {
          if (listed !== undefined) {
            mismatches.push(
              `pattern ${JSON.stringify(pattern)} vs subject ${JSON.stringify(subject)} is ` +
                `listed under pyregex.${listed}, but the two sides now agree; remove the entry`,
            );
          }
          continue;
        }
        if (listed !== undefined) {
          exercised.add(key);
          continue;
        }
        mismatches.push(
          `pattern ${JSON.stringify(pattern)} vs subject ${JSON.stringify(subject)}: ` +
            `CPython ${want === "" ? "no match" : want}, ` +
            `continuo ${actual === "" ? "no match" : actual} ` +
            `(translated to /${compiled.source}/${compiled.flags})`,
        );
      }
    }

    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
    // A declared deviation whose pattern is no longer in the corpus would
    // otherwise sit there licensing a divergence nothing exercises.
    expect(
      [...declared.keys()].filter((key) => !exercised.has(key)),
      "declared match deviations that no corpus cell reached",
    ).toEqual([]);
  });
});

/**
 * The `json.dumps` keyword arguments each option name stands for.
 *
 * The same table lives in `scripts/oracle/dump_fnmatch_shlex.py` under the same
 * names; the corpus holds the names alone, because the two sides spell the
 * arguments differently and neither spelling belongs in a shared file.
 */
const DUMPS_OPTIONS: Readonly<Record<string, PyJsonDumpsOptions>> = {
  default: {},
  sorted: { sortKeys: true },
  indent2: { indent: 2 },
  indent2_sorted: { indent: 2, sortKeys: true },
  // `indent: 0` is NOT "no indent": CPython still breaks every item onto its
  // own line, with no leading spaces.
  indent0_sorted: { indent: 0, sortKeys: true },
  indent4_sorted: { indent: 4, sortKeys: true },
  compact: { separators: [",", ":"] },
  compact_sorted: { separators: [",", ":"], sortKeys: true },
  raw_unicode: { ensureAscii: false },
  raw_unicode_sorted: { ensureAscii: false, sortKeys: true },
};

/**
 * The numbers behind `pyjson.dumps_numbers`.
 *
 * Named rather than embedded for the reason `pystr.repr_nonstring` is: JSON
 * cannot express the int/float distinction, and this table exists to probe
 * exactly it. `float_one_point_zero` is `1` here and `1.0` in Python, which is
 * not a transcription error but the limit `formatNumber` documents -- it is in
 * the corpus's deviation list and asserted as such.
 */
const DUMPS_NUMBERS: Readonly<Record<string, number>> = {
  int_0: 0,
  int_neg1: -1,
  int_max_safe: 9007199254740991,
  float_neg_zero: -0,
  float_half: 0.5,
  float_third: 1 / 3,
  float_1e16: 1e16,
  float_1e17: 1e17,
  float_1e21: 1e21,
  float_1e_minus_4: 1e-4,
  float_1e_minus_5: 1e-5,
  float_1e_minus_7: 1e-7,
  float_max: 1.7976931348623157e308,
  float_min_subnormal: 5e-324,
  float_avogadro: 6.02e23,
  float_1e300: 1e300,
  float_nan: Number.NaN,
  float_inf: Number.POSITIVE_INFINITY,
  float_neg_inf: Number.NEGATIVE_INFINITY,
  float_1e15: 1e15,
  float_one_point_zero: 1,
};

describe("the JSON serialiser agrees with CPython byte for byte", () => {
  /**
   * Every durable fencing artefact reaches disk through `json.dumps`, and the
   * restart path compares those artefacts BY BYTES to decide whether the fence
   * changed. A serialiser that agrees with CPython on every value except one
   * does not produce a slightly different file; it produces a permanent,
   * unfixable "the fence changed" for the documents it disagrees on.
   */
  test("dumps, over every value x option", () => {
    const mismatches: string[] = [];
    let index = 0;
    for (const text of corpus.pyjson.dumps) {
      // Parsed with `pyJsonLoads`, not `JSON.parse`: half of what this section
      // checks is key order, and only the loader that records it can carry the
      // document's own order into the serialiser.
      const value = pyJsonLoads(text);
      for (const optionName of corpus.pyjson.dumps_options) {
        const expected = vector.pyjson.dumps.expected[index] as string;
        const options = DUMPS_OPTIONS[optionName] as PyJsonDumpsOptions;
        let actual: string;
        try {
          actual = pyJsonDumps(value, options);
        } catch (error) {
          actual = `threw ${error instanceof Error ? error.message : String(error)}`;
        }
        if (actual !== expected) {
          mismatches.push(
            `value ${text} with options ${optionName}: ` +
              `CPython ${JSON.stringify(expected)}, continuo ${JSON.stringify(actual)}`,
          );
        }
        index += 1;
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  test("dumps, over the numbers float.__repr__ formats differently from String()", () => {
    const accepted = new Set(corpus.pyjson.dumps_number_accepted_deviations);
    const mismatches: string[] = [];
    for (const [index, name] of corpus.pyjson.dumps_numbers.entries()) {
      const expected = vector.pyjson.dumps_numbers.expected[index] as string;
      const actual = pyJsonDumps(DUMPS_NUMBERS[name] as number);
      if (accepted.has(name)) {
        // The known limit, asserted rather than excused: an integral float is
        // indistinguishable from an int once `JSON.parse` has read it, so
        // continuo must write the INT spelling and CPython must have written
        // something else. The day they agree, this entry is stale and says so.
        expect(actual, `accepted deviation ${name} must render as an int`).toBe(
          String(DUMPS_NUMBERS[name]),
        );
        expect(
          expected,
          `${name} is listed under dumps_number_accepted_deviations but CPython agrees; ` +
            "remove it",
        ).not.toBe(actual);
        continue;
      }
      if (actual !== expected) {
        mismatches.push(`number ${name}: CPython ${expected}, continuo ${actual}`);
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  /**
   * Every mapping's keys, in the order `pyKeys` reports them, paired with the
   * path that reaches it -- the same walk the Python half does.
   *
   * Built through `pyEntries` rather than `Object.entries`, because the
   * property under test is precisely the one `Object.entries` destroys.
   */
  function recordKeyOrder(value: unknown, path: string, out: [string, string[]][]): void {
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        recordKeyOrder(child, `${path}[${index}]`, out);
      });
      return;
    }
    if (typeof value === "object" && value !== null) {
      const entries = pyEntries(value as Record<string, unknown>);
      out.push([path, entries.map(([key]) => key)]);
      for (const [key, child] of entries) {
        recordKeyOrder(child, `${path}.${key}`, out);
      }
    }
  }

  test("loads preserves the SOURCE key order, which is the whole reason it exists", () => {
    const mismatches: string[] = [];
    for (const [index, text] of corpus.pyjson.loads.entries()) {
      const expected = vector.pyjson.loads.expected[index] as LoadsExpectation;
      const parsed = pyJsonLoads(text);
      const order: [string, string[]][] = [];
      recordKeyOrder(parsed, "$", order);
      if (JSON.stringify(order) !== JSON.stringify(expected.key_order)) {
        mismatches.push(
          `text ${text}: CPython key order ${JSON.stringify(expected.key_order)}, ` +
            `continuo ${JSON.stringify(order)}`,
        );
      }
      // The round trip puts the VALUES under the same lens as the order: a
      // loader that kept the order and lost a number's spelling would pass the
      // check above and still write a different file.
      const roundtrip = pyJsonDumps(parsed);
      if (roundtrip !== expected.roundtrip) {
        mismatches.push(
          `text ${text}: CPython round trip ${JSON.stringify(expected.roundtrip)}, ` +
            `continuo ${JSON.stringify(roundtrip)}`,
        );
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });
});

/**
 * The values behind `pysemantics.values`.
 *
 * The same table lives in the Python half under the same names. Two of them
 * carry the whole point of the module: `list_empty` and `dict_empty` are FALSY
 * in Python and truthy in JavaScript, and every mistranslation of that
 * inversion lands on the empty list -- which, in a fence renderer, means no
 * rules were checked.
 */
const SEMANTICS_VALUES: Readonly<Record<string, unknown>> = {
  none: null,
  true: true,
  false: false,
  int_0: 0,
  int_1: 1,
  int_neg1: -1,
  str_empty: "",
  str_abc: "abc",
  str_0: "0",
  str_astral: "a\ud83d\ude00b",
  list_empty: [],
  list_abc: ["a", "b", "c"],
  list_nested: ["a", ["b"], { c: 1 }],
  dict_empty: {},
  dict_ab: { a: 1, b: "x" },
  float_half: 0.5,
};

describe("the Python value semantics agree with CPython", () => {
  test("the values table matches the corpus", () => {
    // The names are the contract between the two halves; a name in one table
    // and not the other would compare a value against another value's answer.
    expect(Object.keys(SEMANTICS_VALUES).sort()).toEqual([...corpus.pysemantics.values].sort());
  });

  test("or, including the two values Python calls falsy and JavaScript does not", () => {
    const mismatches: string[] = [];
    for (const [index, [value, fallback]] of corpus.pysemantics.or.entries()) {
      const expected = vector.pysemantics.or.expected[index] as string;
      const actual = pyRepr(pyOr(SEMANTICS_VALUES[value], SEMANTICS_VALUES[fallback]));
      if (actual !== expected) {
        mismatches.push(`${value} or ${fallback}: CPython ${expected}, continuo ${actual}`);
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  test("iteration, over a string by character and a mapping by key", () => {
    const accepted = new Set(corpus.pysemantics.iterate_accepted_deviations);
    const mismatches: string[] = [];
    for (const [index, name] of corpus.pysemantics.iterate.entries()) {
      const expected = vector.pysemantics.iterate.expected[index] as IterateExpectation;
      let actual: IterateExpectation;
      try {
        actual = { items: pyIterate(SEMANTICS_VALUES[name]).map(pyRepr) };
      } catch (error) {
        if (!(error instanceof PyTypeError)) {
          mismatches.push(`value ${name}: threw a non-PyTypeError: ${String(error)}`);
          continue;
        }
        actual = { error: error.message };
      }
      if (accepted.has(name)) {
        // Documented in `src/fencing/pysemantics.ts`: `None` yields `[]` here
        // and raises in Python, because every call site passes the value
        // through `pyOr` first. Asserted in both directions.
        expect(actual, `accepted deviation ${name} must yield no items`).toEqual({ items: [] });
        expect(
          "error" in expected,
          `${name} is listed under iterate_accepted_deviations but CPython did not raise; ` +
            "remove it",
        ).toBe(true);
        continue;
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `value ${name}: CPython ${JSON.stringify(expected)}, continuo ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  test("in, including substring membership for a string haystack", () => {
    const mismatches: string[] = [];
    for (const [index, [needle, haystack]] of corpus.pysemantics.in.entries()) {
      const expected = vector.pysemantics.in.expected[index] as InExpectation;
      let actual: InExpectation;
      try {
        actual = { result: pyIn(SEMANTICS_VALUES[needle], SEMANTICS_VALUES[haystack]) };
      } catch (error) {
        if (!(error instanceof PyTypeError)) {
          mismatches.push(`${needle} in ${haystack}: threw a non-PyTypeError: ${String(error)}`);
          continue;
        }
        actual = { error: error.message };
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `${needle} in ${haystack}: CPython ${JSON.stringify(expected)}, ` +
            `continuo ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  test("set, including the unhashable element that ABORTS the render", () => {
    const accepted = new Set(
      corpus.pysemantics.set_accepted_deviations.map((c) => JSON.stringify(c)),
    );
    const mismatches: string[] = [];
    for (const [index, names] of corpus.pysemantics.set.entries()) {
      const expected = vector.pysemantics.set.expected[index] as SetExpectation;
      let actual: SetExpectation;
      try {
        // Sorted, because a set has no order to compare. Every repr here is
        // ASCII, so JavaScript's UTF-16 sort and Python's code-point sort
        // agree on it.
        actual = {
          items: [...pySet(names.map((name) => SEMANTICS_VALUES[name]))].map(pyRepr).sort(),
        };
      } catch (error) {
        if (!(error instanceof PyTypeError)) {
          mismatches.push(`set(${names.join(", ")}): threw a non-PyTypeError: ${String(error)}`);
          continue;
        }
        actual = { error: error.message };
      }
      if (accepted.has(JSON.stringify(names))) {
        // Python's numeric tower makes `False == 0`, so `set()` collapses them
        // and a JavaScript `Set` does not. Asserted in both directions.
        expect(
          JSON.stringify(actual),
          `set(${names.join(", ")}) is listed under set_accepted_deviations but the two sides ` +
            "now agree; remove it",
        ).not.toBe(JSON.stringify(expected));
        continue;
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `set(${names.join(", ")}): CPython ${JSON.stringify(expected)}, ` +
            `continuo ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  test("str, which is repr for a container and None/True for the scalars", () => {
    const mismatches: string[] = [];
    for (const [index, name] of corpus.pysemantics.str.entries()) {
      const expected = vector.pysemantics.str.expected[index] as string;
      const actual = pyStr(SEMANTICS_VALUES[name]);
      if (actual !== expected) {
        mismatches.push(
          `str(${name}): CPython ${JSON.stringify(expected)}, continuo ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });

  test("dict.items() and iteration over a mapping, in the SOURCE key order", () => {
    const mismatches: string[] = [];
    for (const [index, text] of corpus.pysemantics.mapping_texts.entries()) {
      const expected = vector.pysemantics.mapping.expected[index] as MappingExpectation;
      const mapping = pyJsonLoads(text) as Record<string, unknown>;
      // `pyIterate` over a mapping yields its keys -- which is what makes
      // `set(global_cfg.get("forbidden_allow_exact") or ())` work on the
      // plausible authoring shape `{"Bash(rm:*)": "why this is forbidden"}`.
      const keys = pyIterate(mapping);
      if (JSON.stringify(keys) !== JSON.stringify(expected.keys)) {
        mismatches.push(
          `text ${text}: CPython keys ${JSON.stringify(expected.keys)}, ` +
            `continuo ${JSON.stringify(keys)}`,
        );
      }
      const items = pyEntries(mapping).map(([key, value]) => [key, pyRepr(value)]);
      if (JSON.stringify(items) !== JSON.stringify(expected.items)) {
        mismatches.push(
          `text ${text}: CPython items ${JSON.stringify(expected.items)}, ` +
            `continuo ${JSON.stringify(items)}`,
        );
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });
});

describe("rules._normalize_path agrees with CPython", () => {
  /**
   * The COMPOSED function, as distinct from the two halves pinned above:
   * `posixpath.normpath(os.path.expanduser(p).replace(os.sep, "/"))`. It is
   * what decides whether a sandbox deny rule covers a candidate path, and both
   * of its halves have already been shown to have a plausible Node substitute
   * that disagrees with CPython.
   *
   * `os.sep` is platform-dependent in the source and stays that way in the
   * port, so the vector records both compositions and this picks the one for
   * the platform it is running on. That is not a formality: on Windows a deny
   * entry `~\.aws` is ONE component to `ntpath` -- the backslash terminates the
   * user field -- so interlock expands it and denies the read, while a
   * posix-only transcription returns it unchanged and does not.
   */
  test("normalizePath, with the environment pinned to the vector's values", () => {
    const home = corpus.pypath.oracle_home;
    const username = corpus.pypath.oracle_username;
    // `normalizePath` takes no home parameter -- it is a transcription of a
    // function that takes none -- so the environment is what has to be pinned.
    // An oracle that read the runner's HOME would compare two environments.
    const previous = {
      HOME: process.env["HOME"],
      USERPROFILE: process.env["USERPROFILE"],
      USERNAME: process.env["USERNAME"],
    };
    const expectedList =
      process.platform === "win32" ? vector.normalize_path.windows : vector.normalize_path.posix;
    const mismatches: string[] = [];
    try {
      process.env["HOME"] = home;
      process.env["USERPROFILE"] = home;
      process.env["USERNAME"] = username;
      const accepted = new Set(corpus.pypath.normalize_path_accepted_deviations);
      for (const [index, input] of corpus.pypath.normalize_path.entries()) {
        const expected = expectedList[index] as string;
        const actual = normalizePath(input);
        if (process.platform !== "win32" && accepted.has(input)) {
          // A `~someuser` path, on POSIX only: `ntpath`'s `~user` handling is
          // pure environment and string work and is transcribed in full, so on
          // Windows these inputs are compared like any other. `posixpath`
          // consults the `pwd` database, which Node cannot, so continuo returns
          // it unchanged -- and the value CPython produced is the generating
          // machine's `pwd` entry rather than a property of CPython, which is
          // the second reason it is asserted here instead of compared. The
          // deviation is CONTAINED one layer up: `parseSandboxEntry` refuses a
          // `~user` path on posix, so no fence rule can be built on one
          // (`DECISIONS.md` D-0203).
          expect(actual, `accepted deviation ${JSON.stringify(input)} must pass through`).toBe(
            input,
          );
          expect(
            expected,
            `${JSON.stringify(input)} is listed under normalize_path_accepted_deviations but ` +
              "CPython agrees; remove it",
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
    } finally {
      for (const [name, was] of Object.entries(previous)) {
        if (was === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = was;
        }
      }
    }
    expect(mismatches, `${mismatches.length} divergence(s) from CPython`).toEqual([]);
  });
});
