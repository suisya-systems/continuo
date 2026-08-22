/**
 * The one place that knows how to spell a literal code point in a `u`-mode
 * regular expression source.
 *
 * Two translators in this directory emit JavaScript regex source from a Python
 * one: `pyregex.ts` (Python's `re` dialect, for `roles.json`'s deny patterns)
 * and `fnmatch.ts` (CPython's glob-to-regex translation). Both hit the same
 * wall -- Python spells `\&`, `\~`, `\ ` and `\#` as identity escapes and
 * `u` mode rejects every one of them -- and both need the same answer.
 *
 * It lives here rather than in either caller because this port has already paid
 * for the alternative once: two transcriptions of one primitive do not stay in
 * agreement, and the half that drifts drifts silently, in whichever direction
 * the drift happens to take. One definition, two importers.
 *
 * ## What `u` mode actually allows
 *
 * Under `u` an identity escape -- a backslash in front of a character that
 * means only itself -- is legal for a **strictly enumerated** set, and the set
 * is not the same inside and outside a character class:
 *
 * - **Outside a class** (`IdentityEscape :: [+U] SyntaxCharacter | [+U] /`):
 *   only `^ $ \ . * + ? ( ) [ ] { } |` and `/`.
 * - **Inside a class** the same, plus `-` (`ClassEscape :: [+U] -`). Note that
 *   `\b` inside a class is *not* an identity escape: it is U+0008 backspace.
 *
 * Everything else -- `\&`, `\~`, `\ `, `\#`, `\!`, `\@` -- is a SyntaxError.
 * So a character that needs escaping but is not on those lists cannot be
 * escaped at all; it has to be **respelled**, and `\u{...}` is the spelling
 * that works for every code point in both dialects and can be re-read as
 * syntax by neither.
 */

/**
 * `SyntaxCharacter`, verbatim from the grammar: the characters `u` mode lets a
 * backslash precede outside a character class.
 */
export const U_SYNTAX_CHARACTERS: ReadonlySet<string> = new Set("^$\\.*+?()[]{}|");

/**
 * Printable ASCII that is a plain literal in a `u`-mode source and needs no
 * escape at all: 0x20..0x7e minus {@link U_SYNTAX_CHARACTERS}.
 *
 * Anything outside this set goes out as a code-point escape rather than as
 * itself. That covers the control characters and the whole of non-ASCII, and it
 * is not caution for its own sake: a raw U+2028 in a pattern source is a line
 * terminator to some tooling and a literal to the regex engine, and a lone
 * surrogate copied through is not even well-formed text.
 *
 * `-` is on this list, which is correct **outside** a class and wrong inside
 * one; {@link uLiteralAtom} handles that difference rather than the list.
 */
export const ORDINARY_ASCII = /^[0-9A-Za-z !"#%&',\-/:;<=>@_`~]$/;

/** One code point, spelled so that no dialect can read it as syntax. */
export function codePointEscape(point: number): string {
  return `\\u{${point.toString(16)}}`;
}

/**
 * One character, spelled as a `u`-legal regex atom meaning exactly itself.
 *
 * `ch` must be a single code point (which may be two UTF-16 code units). Pass
 * `inClass` for a character being emitted between `[` and `]`, where `-` is
 * structural and must be escaped.
 *
 * The result is always a **single atom**: one literal, one identity escape, or
 * one `\u{...}`. Callers concatenate these, so a two-atom result would silently
 * change a range endpoint or a quantifier's target.
 */
export function uLiteralAtom(ch: string, inClass: boolean): string {
  if (inClass && ch === "-") {
    // Legal only inside a class -- and required there, since an unescaped `-`
    // between two atoms is a range.
    return "\\-";
  }
  if (ORDINARY_ASCII.test(ch)) {
    return ch;
  }
  if (U_SYNTAX_CHARACTERS.has(ch)) {
    return `\\${ch}`;
  }
  return codePointEscape(ch.codePointAt(0) as number);
}
