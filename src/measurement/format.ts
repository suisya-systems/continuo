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
 * The rounding is done on the **exact decimal expansion** of the double rather
 * than on the double itself, because "is this a tie" is a question about the
 * stored binary value and not about the decimal literal someone typed.
 * `toFixed(EXPANSION_DIGITS)` is specified to be correctly rounded, and every
 * value that is a tie at `digits` places is exactly representable well inside
 * that width, so a tie arrives here as a run of zeros after the `5` and is
 * recognised as one. A non-tie arrives with its true digits and is rounded
 * normally, which is what both languages already agreed on.
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

  const negative = value < 0 || Object.is(value, -0);
  const expanded = Math.abs(value).toFixed(EXPANSION_DIGITS);
  const [whole = "0", fraction = ""] = expanded.split(".");

  const kept = fraction.slice(0, digits).padEnd(digits, "0");
  const rest = fraction.slice(digits);

  let roundUp = false;
  if (rest !== "") {
    const first = rest[0] ?? "0";
    if (first > "5") {
      roundUp = true;
    } else if (first === "5") {
      const tie = /^0*$/.test(rest.slice(1));
      if (tie) {
        // The half-to-even rule: round up only when the digit being kept is
        // odd, so the result's last digit is always even. This is the one
        // branch `toFixed` gets differently.
        const last = digits === 0 ? (whole.at(-1) ?? "0") : (kept.at(-1) ?? "0");
        roundUp = (Number(last) & 1) === 1;
      } else {
        roundUp = true;
      }
    }
  }

  let magnitude = `${whole}${kept}`;
  if (roundUp) {
    magnitude = incrementDecimalString(magnitude);
  }

  const pad = digits + 1;
  const padded = magnitude.padStart(pad, "0");
  const head = padded.slice(0, padded.length - digits);
  const tail = padded.slice(padded.length - digits);
  const rendered = digits === 0 ? head : `${head}.${tail}`;

  // The sign is kept even when the magnitude rounds to zero: Python prints
  // `-0.00` for a small negative value and for `-0.0`, and dropping it here
  // would be a second, quieter divergence than the one this function exists to
  // remove.
  return negative ? `-${rendered}` : rendered;
}

/**
 * How many decimal places the exact expansion is taken to.
 *
 * `toFixed` accepts up to 100 and is correctly rounded at every width. Twenty
 * is far past the widest tie that can exist at the precisions this harness
 * formats, and short enough to keep the string work trivial.
 */
const EXPANSION_DIGITS = 20;

/** `"1299" -> "1300"`, on a string of digits with no sign and no point. */
function incrementDecimalString(digits: string): string {
  const out = digits.split("");
  let index = out.length - 1;
  while (index >= 0) {
    const digit = Number(out[index]);
    if (digit < 9) {
      out[index] = String(digit + 1);
      return out.join("");
    }
    out[index] = "0";
    index -= 1;
  }
  return `1${out.join("")}`;
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
