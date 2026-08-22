/**
 * The fixed-format oracle: `formatFixed` against CPython's own formatter.
 *
 * **Target-only.** Nothing here translates a source case. `src/measurement/
 * format.ts` exists because `Number.prototype.toFixed` disagrees with Python's
 * `format(v, '.Nf')` on exact ties, and interlock has no test for its own
 * formatter -- in Python the behaviour is the standard library's, so there is
 * nothing there to assert and nothing to translate. The whole file is declared
 * as target-only in `parity/measurement.ledger.json`.
 *
 * It is the same shape as the `sqlite3_complete` corpus (`D-0013`) and for the
 * same reason: a reimplementation can only be checked against the thing it
 * reimplements. Reviewing tie-breaking by eye is exactly the task human review
 * is worst at.
 *
 * The corpus is **rebuilt here, not committed** -- only Python's answers are
 * (`parity/oracle/fixed-format-vector.json`). The two constructions must agree
 * element for element, so the vector records the corpus length and this file
 * checks it before comparing: "somebody changed the corpus" then arrives as an
 * explicit instruction to regenerate rather than as a silent misalignment that
 * compares value 40 against value 41's answer.
 *
 * Regenerate with, from the repository root:
 *
 * ```
 * PYTHONDONTWRITEBYTECODE=1 python3 scripts/oracle/dump_fixed_format.py \
 *   parity/oracle/fixed-format-vector.json
 * ```
 *
 * No interlock checkout is needed: the oracle is CPython itself.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { formatFixed, isAscii } from "../../src/measurement/format.js";

/**
 * The corpus, rebuilt from the same rules as `dump_fixed_format.py:corpus()`.
 *
 * Kept structurally parallel to the Python, statement for statement, because
 * the two are one specification written twice and a reader has to be able to
 * diff them by eye. Any change here is a change there.
 */
function corpus(): number[] {
  const values: number[] = [];

  for (const whole of [0, 1, 2, 3, 4, 5, 12, 99, 100, 12345]) {
    for (const fraction of [
      0.0, 0.005, 0.015, 0.025, 0.05, 0.1, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 0.995,
      0.9995,
    ]) {
      values.push(whole + fraction);
      values.push(-(whole + fraction));
    }
  }

  for (let n = 1; n < 25; n += 1) {
    for (let k = 0; k <= n; k += 1) {
      values.push((k / n) * 100);
    }
  }
  for (const n of [32, 50, 64, 80, 100, 128, 160, 200, 250, 256, 400, 500, 800]) {
    for (let k = 0; k <= n; k += 1) {
      values.push((k / n) * 100);
    }
  }

  let value = -1000.0;
  for (let index = 0; index < 600; index += 1) {
    values.push(value);
    value += 3.3391304347826085;
  }
  for (let step = 0; step < 400; step += 1) {
    values.push(step / 7919.0);
  }

  values.push(0.0, -0.0, 1e-9, -1e-9, 1e15, -1e15);
  return values;
}

interface Vector {
  readonly source: {
    readonly corpus_length: number;
    readonly widths: readonly number[];
    readonly python_version: string;
  };
  readonly rendered: Readonly<Record<string, readonly string[]>>;
}

const vector = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../parity/oracle/fixed-format-vector.json", import.meta.url)),
    "utf8",
  ),
) as Vector;

describe("the fixed-format oracle (target-only)", () => {
  test("the rebuilt corpus is the one the vector was produced from", () => {
    // Checked before any comparison: a corpus of a different length is
    // compared off-by-one against Python's answers, which produces a wall of
    // mismatches that says nothing about the formatter.
    expect(corpus()).toHaveLength(vector.source.corpus_length);
  });

  test("the vector is not vacuous", () => {
    // A vector regenerated from a failed or empty run would otherwise let every
    // comparison below pass while comparing nothing.
    expect(vector.source.corpus_length).toBeGreaterThan(4_000);
    expect(vector.source.widths.length).toBeGreaterThan(1);
    expect(vector.source.python_version).toMatch(/^\d+\.\d+/);
    for (const width of vector.source.widths) {
      expect(vector.rendered[String(width)]).toHaveLength(vector.source.corpus_length);
    }
  });

  test("formatFixed agrees with CPython on every corpus value, at every width", () => {
    const values = corpus();
    const mismatches: string[] = [];

    for (const width of vector.source.widths) {
      const expected = vector.rendered[String(width)];
      expect(expected, `the vector has no answers for width ${width}`).toBeDefined();
      for (const [index, value] of values.entries()) {
        const ours = formatFixed(value, width);
        const theirs = expected?.[index];
        if (ours !== theirs) {
          // Collected rather than asserted one at a time: a rounding bug
          // usually breaks a whole class of inputs at once, and the class is
          // the diagnosis. A per-value assertion would report only the first.
          if (mismatches.length < 20) {
            mismatches.push(
              `.${width}f of ${value} (index ${index}): python ${String(theirs)}, continuo ${ours}`,
            );
          }
        }
      }
    }

    expect(mismatches, `${mismatches.length} mismatch(es) against CPython`).toEqual([]);
  });

  test("the tie cases toFixed gets wrong are the ones this exists for", () => {
    // A regression guard on the *motivation*, not just the behaviour. If
    // `formatFixed` were ever quietly replaced by `toFixed`, the corpus
    // comparison above would catch it -- but this names the specific inputs, so
    // the failure says what broke rather than "417 mismatches".
    expect(formatFixed(0.125, 2)).toBe("0.12");
    expect((0.125).toFixed(2)).toBe("0.13");

    expect(formatFixed(0.375, 2)).toBe("0.38");
    expect(formatFixed(0.625, 2)).toBe("0.62");
    expect(formatFixed(0.875, 2)).toBe("0.88");

    // The half-to-even rule is about the digit being KEPT, so the same
    // fractional tie rounds differently against an odd and an even integer.
    expect(formatFixed(0.5, 0)).toBe("0");
    expect(formatFixed(1.5, 0)).toBe("2");
    expect(formatFixed(2.5, 0)).toBe("2");
    expect(formatFixed(3.5, 0)).toBe("4");

    // One in eight hundred, as a percentage: the tie a real report reaches.
    expect(formatFixed((1 / 800) * 100, 2)).toBe("0.12");
  });

  test("a carry propagates out of the fraction and into a new digit", () => {
    expect(formatFixed(9.999, 2)).toBe("10.00");
    expect(formatFixed(0.999, 2)).toBe("1.00");
    expect(formatFixed(-9.999, 2)).toBe("-10.00");

    // Not a tie, and a good demonstration of why the rounding is done on the
    // exact expansion rather than on the decimal literal: `99.995` looks like a
    // tie that half-to-even would send DOWN to 99.99, but the nearest double is
    // 99.99500000000000454747350886464118957519531250, which is strictly above
    // the halfway point and rounds up on any rule at all. CPython prints
    // "100.00" here and so does this.
    expect(formatFixed(99.995, 2)).toBe("100.00");
  });

  test("the sign survives a magnitude that rounds to zero", () => {
    // Python prints `-0.00` here, and so must this: dropping the sign would be
    // a quieter divergence than the one the function exists to remove.
    expect(formatFixed(-0.001, 2)).toBe("-0.00");
    expect(formatFixed(-0.0, 2)).toBe("-0.00");
    expect(formatFixed(0.0, 2)).toBe("0.00");
  });

  test("a non-finite figure is a caller bug, not a value to render", () => {
    // Python would print `inf` / `nan`; rather than pick a spelling no ported
    // case pins, the function refuses. Every figure in this harness is a ratio
    // of counts behind an empty-denominator guard, so reaching here is a bug.
    expect(() => formatFixed(Number.NaN, 2)).toThrow(RangeError);
    expect(() => formatFixed(Number.POSITIVE_INFINITY, 2)).toThrow(RangeError);
    expect(() => formatFixed(Number.NEGATIVE_INFINITY, 2)).toThrow(RangeError);
  });
});

describe("isAscii (target-only)", () => {
  test("it is Python's str.isascii", () => {
    expect(isAscii("")).toBe(true);
    expect(isAscii("plain ASCII -- with a double hyphen")).toBe(true);
    expect(isAscii("\u007f")).toBe(true);
    expect(isAscii("\u0080")).toBe(false);
    // The character class this whole policy exists for (D-0006): an em dash
    // encodes fine as UTF-8 and raises UnicodeEncodeError on a cp932 console.
    // Written as an escape because this file is itself scanned by
    // test/contract/ascii-output-policy.test.ts, which reads whole files rather
    // than trying to decide which literals are printed.
    expect(isAscii("an em dash \u2014 here")).toBe(false);
  });

  test("it counts code points, so a lone surrogate is not ASCII", () => {
    // A regular expression over code *units* can be fooled here; iterating the
    // string yields the astral character as one code point above 0x7f, and the
    // lone surrogate as one too.
    expect(isAscii("\u{1f600}")).toBe(false);
    expect(isAscii("\ud800")).toBe(false);
  });
});
