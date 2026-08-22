/**
 * Number formatting that agrees with Python's, digit for digit.
 *
 * The measurement harness's whole output is figures, and interlock#74's
 * acceptance criterion 3 is that continuo's CLI "produces reports with the same
 * figures and fields on the shared fixture corpus". That makes rendered number
 * text a parity surface, not presentation -- a report whose percentage reads
 * `0.13` where interlock's reads `0.12` fails that criterion even though the
 * underlying double is bit-identical.
 *
 * `Number.prototype.toFixed` is not that formatter. It and Python's `format(v,
 * '.2f')` agree on every value except an exact tie, and there they round in
 * opposite directions:
 *
 * | value   | Python `.2f` | JS `toFixed(2)` |
 * |---------|--------------|-----------------|
 * | `0.125` | `0.12`       | `0.13`          |
 * | `0.375` | `0.38`       | `0.38`          |
 *
 * Python rounds an exact tie to **even**; JavaScript rounds it **away from
 * zero**. `0.375` agrees only by coincidence -- rounding to even and rounding up
 * give the same digit there.
 *
 * Ties are rare but not hypothetical, and they are reachable from real report
 * data. An exact tie at two decimal places requires the value's fractional part
 * to be one of `.125`, `.375`, `.625`, `.875` (nothing else is both a tie and
 * exactly representable as a double), and a percentage is `count / count * 100`
 * -- so one false termination in eight hundred applied is `0.125` percent, and
 * the two implementations print different reports of the same database.
 *
 * See `D-0104`.
 */

/**
 * `format(value, `.${digits}f`)` from Python, including its tie-breaking.
 *
 * The rounding is done on the **exact** value of the double, using integer
 * arithmetic, because "is this a tie" is a question about the stored binary
 * value and the answer is not recoverable from any truncated decimal rendering
 * of it.
 *
 * An earlier version took the expansion from `toFixed(20)` and classified a tie
 * by looking for a `5` followed by zeros. That is wrong in the direction that
 * matters, and a review caught it: `toFixed` **rounds**, so a value that is
 * merely very close to a tie is rendered as one. `0.00005` at four places is the
 * worked example -- its double is
 * `0.0000500000000000000023960868011929648...`, strictly above the halfway
 * point, so CPython rounds it up to `0.0001`; `toFixed(20)` renders it as
 * `0.00005000000000000000`, which reads as an exact tie and rounds half-to-even
 * *down* to `0.0000`. Widening the expansion does not fix the class: a double
 * needs up to 1074 decimal places to write exactly, and `toFixed` accepts at
 * most 100.
 *
 * So the value is decomposed into `mantissa * 2 ** exponent` -- which is what it
 * literally is -- and the digits are produced by exact `BigInt` division. There
 * is no rounding anywhere except the one this function is deciding.
 */
export function formatFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) {
    // Python renders these as `inf` / `-inf` / `nan`; JavaScript as `Infinity`
    // / `NaN`. No figure in this harness is non-finite -- every rate is a
    // ratio of two counts guarded by an empty-denominator check -- so rather
    // than pick a spelling nobody can test against, this refuses to guess.
    throw new RangeError(
      `formatFixed received ${String(value)}; every figure in a measurement ` +
        `report is a ratio of counts and cannot be non-finite, so this is a ` +
        `bug in the caller rather than a value to render`,
    );
  }
  if (!Number.isInteger(digits) || digits < 0 || digits > 100) {
    throw new RangeError(`formatFixed digits must be an integer in [0, 100], got ${digits}`);
  }

  const negative = value < 0 || Object.is(value, -0);
  const { mantissa, exponent } = decompose(Math.abs(value));

  // The integer to render is round-half-even(|value| * 10 ** digits), and
  // |value| * 10 ** digits is exactly `mantissa * 10 ** digits * 2 ** exponent`.
  const scaled = mantissa * 10n ** BigInt(digits);
  let rounded: bigint;
  if (exponent >= 0) {
    // No fractional part at all: the product is an integer and there is nothing
    // to round.
    rounded = scaled << BigInt(exponent);
  } else {
    const denominator = 1n << BigInt(-exponent);
    const quotient = scaled / denominator;
    const remainder = scaled % denominator;
    const twice = remainder * 2n;
    if (twice > denominator) {
      rounded = quotient + 1n;
    } else if (twice < denominator) {
      rounded = quotient;
    } else {
      // The exact tie, and the one branch `toFixed` decides differently: round
      // so the kept digit is even.
      rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
    }
  }

  const rendered = placeDecimalPoint(rounded.toString(), digits);
  // The sign is kept even when the magnitude rounds to zero: Python prints
  // `-0.00` for a small negative value and for `-0.0`, and dropping it here
  // would be a second, quieter divergence than the one this function exists to
  // remove.
  return negative ? `-${rendered}` : rendered;
}

/**
 * A non-negative finite double as the exact `mantissa * 2 ** exponent` it is.
 *
 * Read straight out of the IEEE 754 bits rather than derived with `Math.log2`
 * and friends, because every floating-point step on the way to an exact
 * decomposition is a place the exactness can be lost -- which is the whole
 * defect this replaced.
 */
function decompose(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biasedExponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xf_ffff_ffff_ffffn;

  if (biasedExponent === 0) {
    // Subnormal: no implicit leading 1, and the exponent is fixed at the
    // smallest normal's.
    return { mantissa: fraction, exponent: -1074 };
  }
  return { mantissa: fraction | (1n << 52n), exponent: biasedExponent - 1075 };
}

/** `("1234", 2) -> "12.34"`, zero-padding a magnitude too short to split. */
function placeDecimalPoint(magnitude: string, digits: number): string {
  if (digits === 0) {
    return magnitude;
  }
  const padded = magnitude.padStart(digits + 1, "0");
  return `${padded.slice(0, padded.length - digits)}.${padded.slice(padded.length - digits)}`;
}

/**
 * Is every character of `text` ASCII?
 *
 * Python's `str.isascii()`, which several ported cases assert on rendered
 * output. The rule it enforces is `D-0006`: a report reaches a cp932 console,
 * where one non-ASCII character raises `UnicodeEncodeError` -- and a test
 * harness capturing stdout as UTF-8 never sees it, so the assertion has to be
 * on the string.
 *
 * Compared by code point rather than by regular expression over code units, so
 * a lone surrogate is correctly reported as non-ASCII.
 */
export function isAscii(text: string): boolean {
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * Python's `repr()` for a string -- what a refusal message's `!r` produces.
 *
 * Several ported refusals interpolate a caller-supplied value with `!r`, and the
 * message text is a parity surface for the same reason the figures are: an
 * operator reads it, and `D-0017` allows the wording to change only where the
 * port has no equivalent of what it named. So the escaping is matched, not
 * approximated.
 *
 * Python's rules, verified against CPython 3.12 rather than recalled:
 *
 * - Single quotes normally. A string containing `'` but no `"` is quoted with
 *   `"` instead, and the `'` is then **not** escaped. A string with both is
 *   quoted with `'` and its `'` escaped.
 * - A backslash doubles; the active quote escapes; newline, carriage return and
 *   tab take their short forms.
 * - Every character `str.isprintable()` rejects is escaped, not merely the C0
 *   controls: that is the Unicode general categories `Cc`, `Cf`, `Cs`, `Co`,
 *   `Cn`, `Zl`, `Zp` and `Zs` -- with `U+0020` the one exception, since an
 *   ordinary space is printable. So `U+0085` (NEL), `U+00A0` (no-break space),
 *   `U+2028` (line separator) and a lone surrogate are all escaped. Missing this
 *   was not cosmetic: `U+2028` is a line separator, so an id containing one
 *   could break an operator-facing refusal across lines exactly as a raw newline
 *   could.
 * - The escape width is Python's: `\xNN` up to `U+00FF`, `\uNNNN` up to
 *   `U+FFFF`, `\UNNNNNNNN` above it.
 * - Printable non-ASCII passes through unescaped (Python 3's `repr` is not
 *   `ascii()`), so `e` with an acute accent and an emoji both survive intact.
 *
 * That last rule is deliberate rather than an oversight, and it interacts with
 * `D-0006`: a refusal naming a non-ASCII id will carry it into the message. That
 * is exactly what interlock does, and it is the same disclosed inherited
 * limitation as the unescaped `action_id` in the false-termination renderer --
 * settled by the operator on 2026-08-22 as reproduce-and-disclose. Escaping here
 * would make continuo's refusal text differ from interlock's for the same input.
 *
 * The naive single-quote wrap is what this replaces, and it was wrong in a way
 * worth naming: a value containing a newline injected a line break into an
 * operator-facing message, so a crafted id could forge what looked like a second
 * line of a refusal.
 */
export function pythonRepr(value: string): string {
  const hasSingle = value.includes("'");
  const hasDouble = value.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";

  let body = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\") {
      body += "\\\\";
    } else if (character === quote) {
      body += `\\${character}`;
    } else if (character === "\n") {
      body += "\\n";
    } else if (character === "\r") {
      body += "\\r";
    } else if (character === "\t") {
      body += "\\t";
    } else if (!isPrintable(character, code)) {
      body += escapeCodePoint(code);
    } else {
      body += character;
    }
  }
  return `${quote}${body}${quote}`;
}

/**
 * Python's `str.isprintable()` for one character.
 *
 * The rule is a Unicode general-category test, so it is written as one rather
 * than as a list of ranges somebody would have to maintain: non-printable is
 * `Cc`, `Cf`, `Cs`, `Co`, `Cn`, `Zl`, `Zp`, `Zs`, and `U+0020` is carved back
 * out because an ordinary space is printable while every other space separator
 * is not.
 *
 * `code` is passed in rather than re-derived so a lone surrogate -- which
 * `for...of` yields as a single unpaired code unit -- is classified from its own
 * value instead of being re-encoded.
 */
function isPrintable(character: string, code: number): boolean {
  if (code === 0x20) {
    return true;
  }
  return !NON_PRINTABLE.test(character);
}

/**
 * The general categories Python treats as non-printable.
 *
 * `Cs` (surrogate) is listed explicitly because a lone surrogate reaches here as
 * its own character and must be escaped rather than emitted, where it would
 * produce invalid UTF-8 on the way to a console.
 */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** `\xNN`, `\uNNNN` or `\UNNNNNNNN`, at Python's widths. */
function escapeCodePoint(code: number): string {
  if (code <= 0xff) {
    return `\\x${code.toString(16).padStart(2, "0")}`;
  }
  if (code <= 0xffff) {
    return `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return `\\U${code.toString(16).padStart(8, "0")}`;
}

/**
 * Python's string ordering: by Unicode **code point**, not UTF-16 code unit.
 *
 * JavaScript's `<` on strings, and the default `Array.prototype.sort`, compare
 * UTF-16 code units. Python compares code points. The two disagree for every
 * comparison involving a supplementary character: `U+10000` encodes as the
 * surrogate pair `D800 DC00`, so JavaScript sorts it BEFORE `U+E000`, while
 * Python sorts it after.
 *
 * That is not a cosmetic difference where a sort feeds a digest. The fixture
 * corpus's content digest is taken over cases **in sorted order**, and the
 * digest is documented as the corpus's identity across both runtimes -- so a
 * corpus with a supplementary character in a case name would hash differently
 * here than in interlock while both implementations believed they agreed.
 *
 * Used for every place the source sorts strings: the corpus walk, the digest's
 * case order, and the sorted lists that appear in refusal messages.
 */
export function comparePythonStrings(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const a = (leftPoints[index] as string).codePointAt(0) ?? 0;
    const b = (rightPoints[index] as string).codePointAt(0) ?? 0;
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return leftPoints.length - rightPoints.length;
}
