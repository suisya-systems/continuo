/**
 * CPython's `re` source dialect, translated into JavaScript's.
 *
 * `renderer.py:_check_forbidden_allow` compiles AUTHOR-SUPPLIED patterns out of
 * the global config and runs `pattern.search(entry)` over every
 * `permissions.allow` entry. That makes CPython's regex dialect part of the
 * fence's semantics, exactly as `fnmatch`'s glob dialect is (see
 * `src/fencing/fnmatch.ts`), and the shortcut -- handing the author's string
 * straight to `new RegExp` -- fails in the DANGEROUS direction on constructs
 * the shipped `roles.json` already uses. Confirmed holes, all of them
 * "interlock refuses, continuo renders", all of them silent:
 *
 * - `$`. Python's `$` without MULTILINE matches at the end of the string OR
 *   just before a final newline; JavaScript's matches only at the very end. So
 *   `^Bash\(\*\)$` catches the allow entry `"Bash(*)\n"` in interlock and
 *   misses it here -- and a trailing newline is what a hand-edited JSON string
 *   or a copied-out shell line carries.
 * - `.`. Python's `.` excludes `\n` and nothing else. JavaScript's also
 *   excludes `\r`, U+2028 and U+2029, so `Bash\(rm:.*\)` stops matching the
 *   allow entry `"Bash(rm:-rf /\r)"`.
 * - `^` and `$` under MULTILINE. Python breaks lines at `\n` alone;
 *   JavaScript's `m` flag also breaks at `\r`, U+2028 and U+2029.
 * - `\w \d \s \b` and their negations. Python's are Unicode-aware for `str`
 *   patterns; JavaScript's are ASCII-only. `^\w+$` catches the allow
 *   entry `"Caf\u00e9"` in interlock and misses it here, because
 *   JavaScript's `\w` stops at the `e`.
 * - `{,n}`. Python reads it as `{0,n}`; JavaScript reads it as four literal
 *   characters, so `a{,3}` stops matching `"zzz"` and starts matching the
 *   literal text `a{,3}`.
 * - `(?P<name>...)`. Python's named-group spelling is a SyntaxError in
 *   JavaScript -- which at least fails loudly -- but `(?P=name)` is not, and
 *   neither is a pattern that merely *contains* a construct whose meaning
 *   differs.
 *
 * Refusing the divergent constructs instead of translating them is not
 * available: the shipped document uses `^Bash\(\s*\*\s*\)$`,
 * `^Read\(\s*\*\s*\)$` and `^mcp__claude-peers__`, so refusing `$` or `\s`
 * would refuse interlock's own roles.json.
 *
 * ## The default is FAIL-CLOSED, and that is the point
 *
 * An earlier revision of this module was a list of the constructs somebody had
 * noticed, with a `default:` arm that COPIED THROUGH anything else on the
 * assumption that it meant the same thing in both dialects. `.` was not on
 * that list. It was emitted verbatim, and a 4,000-pattern differential fuzz
 * against CPython found 54 match divergences of which every single one was
 * `.`. That is what an enumerate-the-known-bad translator costs: the hole is
 * always the construct nobody thought of, and it is silent by construction.
 *
 * So the polarity is inverted here. The walk recognises constructs POSITIVELY:
 *
 * - {@link METACHARACTERS} and {@link CLASS_METACHARACTERS} name every
 *   character that carries meaning beyond itself. Each one has an explicit arm
 *   in {@link Walk.stepOutsideClass} / {@link Walk.stepInClass} that emits a
 *   translation justified in a comment, or throws.
 * - Anything else is a LITERAL, and {@link Walk.literal} still does not copy it
 *   through blind: printable ASCII on the {@link ORDINARY_ASCII} allow-list
 *   goes out as itself, and every other code point -- control characters,
 *   non-ASCII, astral, lone surrogates -- goes out as an explicit `\u{...}`
 *   code-point escape, which denotes exactly that code point in both dialects
 *   and cannot be re-read as syntax by either.
 * - A metacharacter that reaches {@link Walk.literal} throws. That arm is the
 *   guard the old `default:` should have been: it is what fires the day
 *   somebody adds a character to `METACHARACTERS` and forgets the case arm, or
 *   the day a future JavaScript grammar gives meaning to a character that has
 *   none today. `.` would have been a loud refusal instead of 54 silent
 *   divergences.
 *
 * Throwing is the safe direction, and it is the polarity the REST of this port
 * already uses -- `parseSandboxEntry` refuses a `~user` path rather than guess
 * at it, `checkForbiddenAllow` refuses a pattern it cannot compile,
 * `loadDocument` aborts on a bad byte. The caller
 * ({@link ../fencing/renderer.ts | checkForbiddenAllow}) turns any throw into a
 * `global-config-invalid` refusal, which is what interlock produces for a
 * pattern `re` itself rejects: an operator sees a named pattern and a stopped
 * spawn. A wrong-but-valid regex is the hole; a refusal is a loud stop.
 *
 * ## Divergences, and the direction each one fails in
 *
 * 1. **Constructs Python accepts and this refuses.** `(?i:...)` and every other
 *    scoped inline-flag group, `(?>...)` atomic groups, possessive `a*+`,
 *    `(?(1)a|b)` conditionals, `(?#comment)`, `\N{NAME}`, multi-digit
 *    backreferences, octal escapes past `\0oo`, `[\W]`, a literal `-`
 *    following a completed range (`[a-z-\w]`), and a QUANTIFIED LOOKAROUND
 *    (`(?=a)*`, which Python repeats and `u` mode rejects outright).
 *    JavaScript has no equivalent for the first four, and the rest are
 *    ambiguous enough that a guess would be a silent mistranslation. Interlock
 *    renders these documents and this refuses them: over-refusal, which stops a
 *    spawn rather than admitting one, and which is loud (a
 *    `global-config-invalid` reason naming the pattern) rather than quiet.
 * 2. **Unicode data version.** `\w` and `\d` are emitted as the property
 *    escapes `[\p{L}\p{N}_]` and `\p{Nd}`, which are category-exact against
 *    CPython's `SRE_UNI_IS_WORD` / `IS_DECIMAL` -- verified codepoint by
 *    codepoint over the whole of U+0000..U+10FFFF, with ZERO codepoints
 *    matching in Python and not here. The 5,004 `\w` and 80 `\d` codepoints
 *    that match here and not in Python are, every one of them, characters
 *    UNASSIGNED in Python 3.12.3's Unicode 15.0.0 tables and assigned in
 *    Node 22's Unicode 16.0 tables. A forbidden-allow pattern therefore denies
 *    slightly MORE here (`\w`) on strings containing characters that did not
 *    exist when the Python side's tables were built -- and slightly less for
 *    the negated `\W`, which is the one residue of this that fails open. No
 *    frozen table is shipped for it: pinning a copy of Unicode 15.0 would go
 *    stale against interlock the moment its interpreter is upgraded, and would
 *    be a second source of truth for a difference that only ever concerns
 *    codepoints no allow entry can contain today.
 * 3. **`IGNORECASE`.** `(?i)` becomes RegExp's `i` under `u`, which is Unicode
 *    simple case folding; CPython's is full case folding over the same tables.
 *    They differ on a handful of characters (the sharp S, the ligatures).
 *    Recorded rather than fixed, for the same reason as (2).
 * 4. **Compile-failure message text for constructs the WALK does not reach.**
 *    An unbalanced `(` survives the walk and is rejected by `new RegExp`, whose
 *    SyntaxError wording is not CPython's. Every message this module authors
 *    itself carries CPython's wording and its `at position N` suffix -- the
 *    offset is not decoration, it is the only thing that tells an operator
 *    WHICH `[` in a long pattern was never closed -- but the engine's messages
 *    do not.
 *
 * Two whole classes of Python compile error are reproduced here rather than
 * left to `new RegExp`, because the emulations above would otherwise make the
 * pattern legal: `nothing to repeat` (see {@link Walk.lastAtom}) and
 * `invalid group reference` / `unknown group name` (see
 * {@link Walk.groupCount}). Both were measured as "Python rejects, we compile"
 * divergences before they were closed.
 *
 * Only `u` and `i` ever reach `new RegExp`. `m` and `s` are deliberately NOT
 * forwarded: they are tracked as walk state and compiled away into explicit
 * lookarounds and character classes, because JavaScript's notion of a line
 * terminator is four characters wide and Python's is one. Forwarding them
 * would reintroduce the `.` bug in two more places.
 *
 * The `u` flag is always set. It is what makes the property escapes legal and
 * what makes an astral literal one atom instead of two surrogate halves -- and
 * it is also why several literals are re-emitted here in escaped form: `u` mode
 * outlaws identity escapes (`\-`, `\ `, `\#`) and bare `{`, `}`, `]` that
 * Python happily reads as literals. Each of those is rewritten to an explicit
 * code-point escape, which means the same character in both dialects.
 *
 * `fnmatch.ts` reaches the same conclusion by the same route and shares the
 * spelling primitive with this file (`uescape.ts`). It got there second, and
 * the interval between the two is recorded in `DECISIONS.md` D-0200: without
 * `u`, a regex atom matches one UTF-16 code unit, so `?` failed to match an
 * astral character that CPython's `?` matches -- a fence rule that denied less
 * than its source, which is the failure this whole directory exists to prevent.
 */

import { codePointEscape, ORDINARY_ASCII } from "./uescape.js";

/**
 * A pattern this translator will not guess at.
 *
 * Its own type, so a caller can tell "Python would have rejected this too"
 * apart from a bug in the walk -- both become the same refusal reason, but
 * only one of them is a defect.
 */
export class PythonRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythonRegexError";
  }
}

/**
 * `SRE_UNI_IS_WORD`: alphanumeric per the Unicode tables, or underscore.
 *
 * Emitted as a class BODY (no brackets) so it can be spliced into a character
 * class the author wrote -- `[\w.-]` has to stay one class, not become a
 * nested one.
 */
const WORD_BODY = "\\p{L}\\p{N}_";

/** `SRE_UNI_IS_DECIMAL`: exactly the decimal-digit category. */
const DIGIT_BODY = "\\p{Nd}";

/**
 * `SRE_UNI_IS_SPACE`, which is NOT `\p{White_Space}` and NOT JavaScript's
 * `\s`.
 *
 * `\p{White_Space}` alone is short by four codepoints: U+001C..U+001F, the
 * file/group/record/unit separators, are `str.isspace()` in Python and carry no
 * `White_Space` property. JavaScript's own `\s` is wrong in the other direction
 * as well -- it matches U+FEFF, which Python does not -- which is the same trap
 * `pyStrip` exists for in `rules.ts`. The union below was checked codepoint by
 * codepoint against CPython: zero disagreement in either direction.
 */
const SPACE_BODY = "\\t\\n\\v\\f\\r \\u001c-\\u001f\\u0085\\p{White_Space}";

/** Escapes that name a character class, mapped to their class bodies. */
const CLASS_BODIES: ReadonlyMap<string, string> = new Map([
  ["w", WORD_BODY],
  ["d", DIGIT_BODY],
  ["s", SPACE_BODY],
]);

/** Escapes that mean the same character in both dialects. */
const LITERAL_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["n", "\\n"],
  ["r", "\\r"],
  ["t", "\\t"],
  ["f", "\\f"],
  ["v", "\\v"],
  // Python's `\a` is BEL. JavaScript has no `\a`, and under `u` it is a
  // SyntaxError rather than the literal `a` it would be without `u`.
  ["a", "\\x07"],
]);

/**
 * Every character that means more than itself OUTSIDE a character class.
 *
 * The switch in {@link Walk.stepOutsideClass} must have an arm for each one.
 * {@link Walk.literal} throws if a member reaches it, which is how a missing
 * arm becomes a refusal instead of a verbatim copy-through -- the failure that
 * shipped `.` unchanged.
 */
const METACHARACTERS: ReadonlySet<string> = new Set(".^$*+?()[]{}|\\");

/**
 * The same, INSIDE a character class, where `$ ( ) * + . ? { } |` are already
 * plain literals in both dialects.
 *
 * `^` is absent because only a LEADING `^` negates, and {@link Walk.openClass}
 * consumes that one before the body walk starts; anywhere else it is a
 * literal.
 */
const CLASS_METACHARACTERS: ReadonlySet<string> = new Set("\\[]-");

/**
 * Printable ASCII that is a plain literal in both dialects and legal verbatim
 * in a `u`-mode source: 0x20..0x7e minus the SyntaxCharacter set.
 *
 * Shared with `fnmatch.ts` through `uescape.ts` rather than restated here --
 * the two translators must agree about which characters `u` mode lets through
 * verbatim, and two copies of that list do not stay in agreement.
 *
 * Note that it contains `-`, `[`, `]` and `\`, which {@link CLASS_METACHARACTERS}
 * and {@link METACHARACTERS} intercept before {@link Walk.literal} consults it.
 */

/**
 * Translate `source` from Python's dialect to JavaScript's and compile it.
 *
 * Throws {@link PythonRegexError} for a construct that cannot be translated
 * faithfully, and whatever `RegExp` throws for a source that survives the walk
 * but is still not a legal JavaScript pattern. Both are failures the caller
 * must convert into a refusal; neither may be swallowed.
 */
export function compilePythonRegex(source: string): RegExp {
  const state = new Walk(source);
  const body = state.run();
  return new RegExp(body, state.flags);
}

/** The walk's cursor and its state: the flags, the class depth, the positions. */
class Walk {
  private readonly src: string;
  private index = 0;
  private out = "";
  /**
   * `u` is unconditional; `i` is the only inline flag forwarded. See the module
   * note on why `m` and `s` are compiled away instead.
   */
  public flags = "u";
  /** `(?s)`: `.` also matches `\n`. Compiled into the `.` arm, never a flag. */
  private dotall = false;
  /** `(?m)`: `^` and `$` also match around `\n`. Compiled into their arms. */
  private multiline = false;
  /** Inside `[...]`, where `$`, `(`, `*` and friends are literals. */
  private inClass = false;
  /** Where the open `[` was, for CPython's "at position N" suffix. */
  private classStart = 0;
  /**
   * Where the character-class item being read started.
   *
   * CPython reports a bad range at the position of its LOWER bound, not at the
   * dash, so `[ab-\d]` is "at position 2" and not 3.
   */
  private classItemStart = 0;
  /** True immediately after `*`, `+`, `?` or `{n,m}`: `+` there is possessive. */
  private afterQuantifier = false;
  /**
   * What precedes the cursor, for CPython's "nothing to repeat".
   *
   * Python refuses to quantify a zero-width assertion -- `^*`, `$?`, `\b{2,}`,
   * `\A*`, `\B*` are all "nothing to repeat" -- while it happily quantifies a
   * LOOKAROUND (`(?=a)*` compiles). JavaScript draws that line somewhere else
   * again, and the emulations this module emits move it further: `\b` goes out
   * as a `(?:...)` group and `^` under MULTILINE as a lookbehind alternation,
   * both of which JavaScript is willing to repeat. Without this state `(?m)^{2}`
   * and `\b*` would COMPILE here and be a compile error in interlock -- the
   * "interlock refuses, continuo renders" direction, reached through a
   * translation that was otherwise faithful.
   */
  private lastAtom: "none" | "assertion" | "atom" = "none";
  /**
   * Capturing groups opened so far, and the names among them.
   *
   * CPython validates a backreference against the groups seen TO ITS LEFT and
   * raises at compile time -- `(a)\2(b)` is "invalid group reference 2" even
   * though a second group does eventually exist. JavaScript is happy to
   * compile `\2` there and treats it as never-matching, so a global config
   * interlock rejects outright would render here.
   */
  private groupCount = 0;
  /** Named groups seen so far, mapped to their group NUMBER for the message. */
  private readonly groupNames = new Map<string, number>();
  /**
   * Source offsets of the `(` groups still open, innermost last.
   *
   * `new RegExp` rejects an unbalanced pattern too, but with its own wording
   * and no offset -- "Invalid regular expression: /(/u: Unterminated group"
   * where CPython says "missing ), unterminated subpattern at position 0". A
   * `forbidden_allow_regex` entry of `Bash(*)` (an operator pasting a
   * permission spec where a regex was wanted) hits this on the first try, so
   * the two messages are not an exotic corner.
   */
  private readonly openGroups: number[] = [];

  constructor(source: string) {
    this.src = source;
  }

  public run(): string {
    this.readLeadingFlags();
    while (this.index < this.src.length) {
      const ch = this.src[this.index] as string;
      const quantified = this.afterQuantifier;
      this.afterQuantifier = false;
      if (this.inClass) {
        this.stepInClass(ch);
      } else {
        this.stepOutsideClass(ch, quantified);
      }
    }
    if (this.inClass) {
      // CPython: "unterminated character set at position N", N being the `[`.
      // Reaching `new RegExp` with an unbalanced class would be a JavaScript
      // SyntaxError too, but only by luck, and with different wording: say it
      // here so the message names the actual defect at the actual offset.
      throw this.fail("unterminated character set", this.classStart);
    }
    // CPython reports the INNERMOST unclosed group, because `sre_parse`
    // recurses and the deepest parse fails first: `(((` is "at position 2",
    // while `((a)` -- whose inner group does close -- is "at position 0".
    const unclosed = this.openGroups.at(-1);
    if (unclosed !== undefined) {
      throw this.fail("missing ), unterminated subpattern", unclosed);
    }
    return this.out;
  }

  /**
   * A refusal carrying CPython's `at position N` suffix.
   *
   * These are messages this PORT authors, not messages an engine hands it, so
   * there is no excuse for them to read differently from `re`'s: an operator
   * comparing a continuo refusal against the interlock one it is supposed to
   * mirror should see the same text, offset included.
   */
  private fail(message: string, index: number): PythonRegexError {
    return new PythonRegexError(`${message} at position ${this.codePointOffset(index)}`);
  }

  /**
   * A UTF-16 cursor, restated as CPython's offset.
   *
   * CPython indexes a `str` by CODE POINT and JavaScript indexes by UTF-16
   * unit, so a single astral character anywhere to the left -- an emoji in a
   * forbidden-allow pattern is not hypothetical -- shifts every offset after it
   * by one. Measured before this conversion existed: every message that
   * disagreed with `re`'s in the differential fuzz disagreed only in the
   * number, and every one of those patterns contained an astral literal.
   */
  private codePointOffset(index: number): number {
    let offset = 0;
    for (let i = 0; i < index; offset += 1) {
      i += (this.src.codePointAt(i) as number) > 0xffff ? 2 : 1;
    }
    return offset;
  }

  /**
   * CPython's `nothing to repeat`, raised when a quantifier has no repeatable
   * atom in front of it.
   *
   * @see lastAtom for why this cannot be left to `new RegExp`.
   */
  private requireRepeatableAtom(): void {
    if (this.lastAtom !== "atom") {
      throw this.fail("nothing to repeat", this.index);
    }
  }

  // ------------------------------------------------------------------
  // leading global flags
  // ------------------------------------------------------------------

  /**
   * `(?i)`, `(?s)`, `(?m)` and combinations, at the start only.
   *
   * Python 3.11+ raises "global flags not at the start of the expression" for
   * one anywhere else, so anything this loop does not consume is either a
   * different construct or an error, and both are handled downstream.
   * CPython accepts several in a row (`(?i)(?m)a` compiles), so this loops.
   */
  private readLeadingFlags(): void {
    for (;;) {
      const match = /^\(\?([a-zA-Z]+)\)/.exec(this.src.slice(this.index));
      if (match === null) {
        return;
      }
      const position = this.index;
      for (const letter of match[1] as string) {
        if (letter === "i") {
          if (!this.flags.includes("i")) {
            this.flags += "i";
          }
        } else if (letter === "s") {
          this.dotall = true;
        } else if (letter === "m") {
          this.multiline = true;
        } else if (letter === "u") {
          // `re.UNICODE` is the default for `str` patterns: a no-op, not a
          // change of meaning.
        } else {
          // `a` (ASCII-only classes) and `L` (locale) would change what `\w`
          // means, and `x` (verbose) changes how the REST of the source is
          // parsed -- whitespace and `#` comments stop being literals. Guessing
          // at any of the three rewrites the author's pattern.
          throw this.fail(
            `inline flag '${letter}' has no JavaScript equivalent and changes ` +
              "what the pattern matches",
            position,
          );
        }
      }
      this.index += (match[0] as string).length;
    }
  }

  // ------------------------------------------------------------------
  // outside a character class
  // ------------------------------------------------------------------

  /**
   * One step of the walk outside a class.
   *
   * Every arm below corresponds to a member of {@link METACHARACTERS}. The
   * `default:` arm does NOT copy its character through -- it hands it to
   * {@link literal}, which either emits an allow-listed literal, emits an
   * explicit code-point escape, or throws.
   */
  private stepOutsideClass(ch: string, quantified: boolean): void {
    switch (ch) {
      case "\\":
        this.index += 1;
        // An escape is an atom unless `escapeOutsideClass` says otherwise:
        // `\A`, `\Z`, `\b` and `\B` are the four that are assertions.
        this.lastAtom = "atom";
        this.escape(false);
        return;
      case "[":
        this.openClass();
        return;
      case "]":
        // Python reads a stray `]` as a literal; `u` mode rejects it.
        this.emit("\\]");
        this.index += 1;
        this.lastAtom = "atom";
        return;
      case "}":
        // Same, for a `}` that closed no quantifier.
        this.emit("\\}");
        this.index += 1;
        this.lastAtom = "atom";
        return;
      case "{":
        this.quantifierOrLiteralBrace();
        return;
      case ".":
        this.dot();
        return;
      case "^":
        this.caret();
        return;
      case "$":
        this.dollar();
        return;
      case "(":
        this.group();
        return;
      case ")":
      case "|":
        // Group close and alternation: identical in both dialects, including
        // precedence and the empty-branch case (`a|` matches the empty string
        // in both). A closed group is repeatable -- including a lookaround,
        // which Python does allow a quantifier on -- while a fresh branch has
        // nothing in front of it, which is why `a|*` is "nothing to repeat".
        if (ch === ")" && this.openGroups.pop() === undefined) {
          throw this.fail("unbalanced parenthesis", this.index);
        }
        this.emit(ch);
        this.index += 1;
        this.lastAtom = ch === ")" ? "atom" : "none";
        return;
      case "*":
      case "+":
      case "?":
        this.requireRepeatableAtom();
        if (quantified && ch === "+") {
          // `a*+`, `a{2}+`, `a?+`: Python 3.11+ possessive quantifiers, which
          // forbid the backtracking that would otherwise find a match.
          // JavaScript has no possessive form, and the emulation via an atomic
          // lookahead group changes group numbering, which would silently
          // renumber the author's own backreferences.
          throw this.fail("possessive quantifiers have no JavaScript equivalent", this.index);
        }
        this.emit(ch);
        this.index += 1;
        this.afterQuantifier = true;
        return;
      default:
        this.literal(ch, false);
        this.lastAtom = "atom";
        return;
    }
  }

  /**
   * Python's `.`: every character EXCEPT `\n`, or every character under
   * DOTALL.
   *
   * JavaScript's `.` excludes four characters, not one -- `\n`, `\r`, U+2028
   * and U+2029 -- so a verbatim `.` makes a forbidden-allow pattern match
   * FEWER allow entries here than in interlock, which is the direction that
   * admits a spawn interlock refuses. Measured: in a 4,000-pattern
   * differential fuzz against CPython this was the sole cause of all 54 match
   * divergences.
   *
   * `[\s\S]` rather than the `s` flag, and `[^\n]` rather than `.`, so the
   * emitted source says what it means without depending on a flag that also
   * changes the meaning of `^` and `$`.
   */
  private dot(): void {
    this.emit(this.dotall ? "[\\s\\S]" : "[^\\n]");
    this.index += 1;
    this.lastAtom = "atom";
  }

  /**
   * Python's `^`: the start of the string, plus after every `\n` under
   * MULTILINE.
   *
   * Without MULTILINE the dialects agree exactly, so the character goes out as
   * itself. With it they do not: JavaScript's `m` breaks lines at `\r`, U+2028
   * and U+2029 as well, so `(?m)^b` would match inside `"a\rb"` here and not
   * in interlock. The `m` flag is therefore never set; the Python meaning is
   * spelled out with lookbehinds instead.
   */
  private caret(): void {
    this.emit(this.multiline ? "(?:(?<![\\s\\S])|(?<=\\n))" : "^");
    this.index += 1;
    this.lastAtom = "assertion";
  }

  /**
   * Python's `$`: the end of the string or just before a FINAL newline, plus
   * before every `\n` under MULTILINE.
   *
   * Both readings are spelled out rather than delegated to `$` and `m`. The
   * flagless case has no JavaScript equivalent at all (JavaScript's `$` is the
   * very end), and the MULTILINE case has the same four-line-terminators
   * problem as {@link caret}.
   */
  private dollar(): void {
    this.emit(this.multiline ? "(?=\\n|(?![\\s\\S]))" : "(?=\\n?(?![\\s\\S]))");
    this.index += 1;
    this.lastAtom = "assertion";
  }

  /** `{n}` `{n,}` `{n,m}` `{,m}`, or a literal brace. */
  private quantifierOrLiteralBrace(): void {
    const match = /^\{(\d*)(?:,(\d*))?\}/.exec(this.src.slice(this.index));
    const lower = match?.[1] ?? "";
    const upper = match?.[2];
    if (match === null || (lower === "" && upper === undefined)) {
      // CPython reads `a{}` and a lone `a{` as literal text -- but NOT `a{,}`,
      // which is the quantifier `a{0,}`: `re.compile("{,}")` fails with
      // "nothing to repeat", which only a quantifier can. `u` mode rejects the
      // bare brace, so the literal is escaped rather than copied.
      this.emit("\\{");
      this.index += 1;
      this.lastAtom = "atom";
      return;
    }
    this.requireRepeatableAtom();
    // `{,3}` is `{0,3}` in Python and four literal characters in JavaScript:
    // the pattern stops being a quantifier and starts being a string.
    const min = lower === "" ? "0" : lower;
    this.emit(upper === undefined ? `{${min}}` : `{${min},${upper}}`);
    this.index += (match[0] as string).length;
    this.afterQuantifier = true;
  }

  /** `(`, `(?:`, the lookarounds, and the Python-only spellings. */
  private group(): void {
    const rest = this.src.slice(this.index);
    if (!rest.startsWith("(?")) {
      this.openGroups.push(this.index);
      this.emit("(");
      this.index += 1;
      this.groupCount += 1;
      this.lastAtom = "none";
      return;
    }
    const named = /^\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest);
    if (named !== null) {
      const name = named[1] as string;
      const previous = this.groupNames.get(name);
      if (previous !== undefined) {
        // JavaScript rejects a duplicate name too, but as a `new RegExp`
        // SyntaxError whose text names neither group number. CPython's offset
        // is the name inside the SECOND `(?P<`.
        throw this.fail(
          `redefinition of group name '${name}' as group ${this.groupCount + 1}; ` +
            `was group ${previous}`,
          this.index + 4,
        );
      }
      this.openGroups.push(this.index);
      this.emit(`(?<${name}>`);
      this.index += (named[0] as string).length;
      this.groupCount += 1;
      this.groupNames.set(name, this.groupCount);
      this.lastAtom = "none";
      return;
    }
    const backref = /^\(\?P=([A-Za-z_][A-Za-z0-9_]*)\)/.exec(rest);
    if (backref !== null) {
      const target = backref[1] as string;
      if (!this.groupNames.has(target)) {
        // CPython's wording and offset: the name starts after `(?P=`.
        throw this.fail(`unknown group name '${target}'`, this.index + 4);
      }
      this.emit(`\\k<${target}>`);
      this.index += (backref[0] as string).length;
      this.lastAtom = "atom";
      return;
    }
    for (const prefix of ["(?:", "(?=", "(?!", "(?<=", "(?<!"]) {
      if (rest.startsWith(prefix)) {
        this.openGroups.push(this.index);
        this.emit(prefix);
        this.index += prefix.length;
        this.lastAtom = "none";
        return;
      }
    }
    // Everything left is either Python-only with no JavaScript spelling
    // (`(?>` atomic, `(?(` conditional, `(?#` comment, `(?i:` scoped flags,
    // `(?P>` recursion) or a Python error. Both must stop the render: the
    // first group would otherwise be mistranslated, the second is what
    // interlock refuses.
    throw this.fail(
      `unsupported group ${JSON.stringify(rest.slice(0, 4))}: no JavaScript ` +
        "equivalent with the same meaning",
      this.index,
    );
  }

  // ------------------------------------------------------------------
  // character classes
  // ------------------------------------------------------------------

  private openClass(): void {
    this.classStart = this.index;
    this.emit("[");
    this.index += 1;
    if (this.src[this.index] === "^") {
      this.emit("^");
      this.index += 1;
    }
    this.classItemStart = this.index;
    if (this.src[this.index] === "]") {
      // `[]]` and `[^]]` are a class CONTAINING `]` in Python. JavaScript reads
      // `[]` as an empty class -- one that matches nothing -- followed by a
      // literal `]`, so the author's class would quietly stop matching.
      this.emit("\\]");
      this.index += 1;
    }
    this.inClass = true;
    // A character class is ONE atom, and the walk inside it never touches
    // `lastAtom`: `[abc]*` repeats the class, not the `c`.
    this.lastAtom = "atom";
  }

  /**
   * One step of the walk inside a class.
   *
   * Same polarity as {@link stepOutsideClass}: the arms cover
   * {@link CLASS_METACHARACTERS} exhaustively and everything else goes through
   * {@link literal}, which never copies an unrecognised character through.
   */
  private stepInClass(ch: string): void {
    if (ch === "]") {
      this.emit("]");
      this.index += 1;
      this.inClass = false;
      return;
    }
    if (ch === "-") {
      if (CLASS_ESCAPE_AFTER_DASH.test(this.src.slice(this.index))) {
        // `[a-\w]` is "bad character range" in Python. Splicing the expansion
        // in would produce `[a-\p{L}...]`, and if that happened to be a legal
        // range the class would silently mean something the author never
        // wrote.
        throw this.badRange(this.index + 3);
      }
      // A range operator, or a literal dash at either end of the class. Both
      // dialects read it the same way in the cases that survive to here.
      this.emit("-");
      this.index += 1;
      return;
    }
    // Everything below starts a new class ITEM, which is the offset CPython
    // reports for a bad range whose lower bound is that item.
    this.classItemStart = this.index;
    if (ch === "\\") {
      this.index += 1;
      this.escape(true);
      return;
    }
    if (ch === "[") {
      // Literal in Python; a nested class under `v` mode and an error risk
      // under future grammars. Escaped, which is literal in every mode.
      this.emit("\\[");
      this.index += 1;
      return;
    }
    this.literal(ch, true);
  }

  /** CPython's `bad character range a-\w at position N`, wording included. */
  private badRange(end: number): PythonRegexError {
    return this.fail(
      `bad character range ${this.src.slice(this.classItemStart, end)}`,
      this.classItemStart,
    );
  }

  // ------------------------------------------------------------------
  // literals
  // ------------------------------------------------------------------

  /**
   * A character that means only itself -- the fail-closed `default:`.
   *
   * The throw is not decoration. It is the guard whose absence let `.` ship: an
   * earlier revision copied every unrecognised character straight into the
   * output, so a metacharacter with no case arm silently became "whatever
   * JavaScript thinks it means". Here a metacharacter that reaches this path is
   * a defect in the walk above, and it stops the render loudly instead of
   * widening a fence quietly.
   *
   * Non-metacharacters are still not copied blind. Printable ASCII on
   * {@link ORDINARY_ASCII} goes out as itself; every other code point goes out
   * as `\u{...}`, which denotes exactly that code point in both dialects and
   * cannot be re-read as syntax by either.
   */
  private literal(ch: string, inClass: boolean): void {
    const reserved = inClass ? CLASS_METACHARACTERS : METACHARACTERS;
    if (reserved.has(ch)) {
      throw this.fail(
        `internal: metacharacter ${JSON.stringify(ch)} has no translation arm`,
        this.index,
      );
    }
    if (ORDINARY_ASCII.test(ch)) {
      this.emit(ch);
      this.index += 1;
      return;
    }
    if (PASSTHROUGH_ESCAPES.has(ch)) {
      // Reachable only inside a class, where `$ ( ) * + . ? { } | ^` are plain
      // literals that `u` mode nonetheless wants spelled with a backslash.
      this.emit(`\\${ch}`);
      this.index += 1;
      return;
    }
    this.emitCodePointAtCursor();
  }

  // ------------------------------------------------------------------
  // escapes
  // ------------------------------------------------------------------

  /** `this.index` points at the character AFTER the backslash. */
  private escape(inClass: boolean): void {
    const start = this.index - 1;
    if (this.index >= this.src.length) {
      throw this.fail("bad escape (end of pattern)", start);
    }
    const ch = this.src[this.index] as string;

    const body = CLASS_BODIES.get(ch);
    if (body !== undefined) {
      this.index += 1;
      if (inClass) {
        this.emit(body);
        this.rejectRangeAfterClassEscape();
      } else {
        this.emit(`[${body}]`);
      }
      return;
    }
    const negated = CLASS_BODIES.get(ch.toLowerCase());
    if (negated !== undefined && ch === ch.toUpperCase()) {
      if (inClass) {
        // `[\W]` is a NEGATED set inside a positive one. Expressing that needs
        // `v`-mode nested classes, whose grammar differs elsewhere in ways this
        // walk does not model, so it is refused rather than approximated.
        throw this.fail(
          `\\${ch} inside a character class has no JavaScript equivalent under the u flag`,
          start,
        );
      }
      this.index += 1;
      this.emit(`[^${negated}]`);
      return;
    }

    const literal = LITERAL_ESCAPES.get(ch);
    if (literal !== undefined) {
      this.index += 1;
      this.emit(literal);
      return;
    }

    if (inClass) {
      this.escapeInClass(ch, start);
      return;
    }
    this.escapeOutsideClass(ch, start);
  }

  private escapeInClass(ch: string, start: number): void {
    if (ch === "b") {
      // Backspace inside a class, in both dialects.
      this.index += 1;
      this.emit("\\b");
      return;
    }
    if (ch === "x" || ch === "u" || ch === "U") {
      this.hexEscape(ch, start);
      return;
    }
    if (/[0-9A-Za-z]/.test(ch)) {
      // `[\A]`, `[\1]`, `[\q]`: Python raises "bad escape" for the first and
      // last, and reads `\1` as an octal escape rather than the backreference
      // it looks like. None of the three is worth guessing at.
      throw this.fail(`bad escape \\${ch}`, start);
    }
    this.emitLiteralCodePoint(true);
  }

  private escapeOutsideClass(ch: string, start: number): void {
    switch (ch) {
      case "A":
        // Python's `\A` is the start of the string even under MULTILINE, which
        // `^` is not.
        this.index += 1;
        this.emit("(?<![\\s\\S])");
        this.lastAtom = "assertion";
        return;
      case "Z":
        // Python's `\Z` is the very end -- no trailing-newline concession, and
        // unaffected by MULTILINE.
        this.index += 1;
        this.emit("(?![\\s\\S])");
        this.lastAtom = "assertion";
        return;
      case "b":
        this.index += 1;
        // JavaScript's `\b` is ASCII-word-based even under `u`, so it is
        // rebuilt from the Unicode word class the rest of this module uses.
        this.emit(
          `(?:(?<=[${WORD_BODY}])(?![${WORD_BODY}])|(?<![${WORD_BODY}])(?=[${WORD_BODY}]))`,
        );
        this.lastAtom = "assertion";
        return;
      case "B":
        this.index += 1;
        // The trailing `(?:(?<=[\s\S])|(?=[\s\S]))` is not decoration: it is
        // CPython's `SRE_AT_NON_BOUNDARY`, which returns 0 outright when the
        // subject is EMPTY (`ptr == beginning && ptr == end`), so
        // `re.search(r"\B", "")` finds nothing. JavaScript's `\B` matches
        // there, and so does the naive two-lookaround emulation. The suffix
        // says "there is a character on one side or the other", which is
        // exactly the case the guard excludes.
        this.emit(
          `(?:(?<=[${WORD_BODY}])(?=[${WORD_BODY}])|(?<![${WORD_BODY}])(?![${WORD_BODY}])` +
            "(?:(?<=[\\s\\S])|(?=[\\s\\S])))",
        );
        this.lastAtom = "assertion";
        return;
      case "x":
      case "u":
      case "U":
        this.hexEscape(ch, start);
        return;
      default:
        break;
    }
    if (ch === "0") {
      // `\0`, `\0o`, `\0oo` are octal in Python. `\012` is a JavaScript
      // SyntaxError under `u`, so the value is computed here instead.
      const octal = /^0[0-7]{0,2}/.exec(this.src.slice(this.index)) as RegExpExecArray;
      const text = octal[0] as string;
      this.index += text.length;
      this.emitCodePoint(Number.parseInt(text, 8));
      return;
    }
    if (/[1-9]/.test(ch)) {
      const digits = /^[0-9]+/.exec(this.src.slice(this.index)) as RegExpExecArray;
      if ((digits[0] as string).length > 1) {
        // `\12` is group 12 if the pattern has twelve groups and the octal
        // character 012 otherwise -- a rule JavaScript does not share.
        throw this.fail(
          `\\${digits[0] as string} is ambiguous between a backreference and an octal escape`,
          start,
        );
      }
      if (Number.parseInt(ch, 10) > this.groupCount) {
        // CPython's offset is the DIGIT, not the backslash.
        throw this.fail(`invalid group reference ${ch}`, start + 1);
      }
      this.index += 1;
      this.emit(`\\${ch}`);
      return;
    }
    if (/[A-Za-z]/.test(ch)) {
      // Python reserves unknown ASCII-letter escapes: `re.compile("\\q")`
      // raises "bad escape \q". Refusing here is the same answer.
      throw this.fail(`bad escape \\${ch}`, start);
    }
    this.emitLiteralCodePoint(false);
  }

  /** `\xNN`, `\uNNNN`, `\UNNNNNNNN`. */
  private hexEscape(kind: string, start: number): void {
    const width = kind === "x" ? 2 : kind === "u" ? 4 : 8;
    const digits = this.src.slice(this.index + 1, this.index + 1 + width);
    if (digits.length !== width || !/^[0-9a-fA-F]+$/.test(digits)) {
      // CPython echoes only the HEX PREFIX it managed to read, so `\xZZ` is
      // "incomplete escape \x" and `\x4` is "incomplete escape \x4".
      const seen = (/^[0-9a-fA-F]*/.exec(digits) as RegExpExecArray)[0] as string;
      throw this.fail(`incomplete escape \\${kind}${seen}`, start);
    }
    const value = Number.parseInt(digits, 16);
    if (value > 0x10ffff) {
      throw this.fail(`bad escape \\${kind}${digits}: not a code point`, start);
    }
    this.index += 1 + width;
    this.emitCodePoint(value);
  }

  /**
   * The escaped character, re-emitted as a code-point escape.
   *
   * Python reads `\-`, `\ `, `\#`, `\&` and every other escaped non-letter as
   * the character itself. `u` mode rejects those identity escapes outright, so
   * copying them through would turn a working interlock pattern into a
   * `global-config-invalid` refusal, and dropping the backslash would be wrong
   * inside a class (`\-` there is a literal dash, not a range).
   */
  private emitLiteralCodePoint(inClass: boolean): void {
    const ch = this.src[this.index] as string;
    if (PASSTHROUGH_ESCAPES.has(ch) || (inClass && ch === "-")) {
      // Already a legal `u`-mode identity escape, and it means the same
      // character. Kept verbatim so a translated source stays readable next to
      // the pattern the author wrote.
      this.index += 1;
      this.emit(`\\${ch}`);
      return;
    }
    this.emitCodePointAtCursor();
  }

  /** The code point at the cursor, consumed and emitted as `\u{...}`. */
  private emitCodePointAtCursor(): void {
    const point = this.src.codePointAt(this.index) as number;
    this.index += String.fromCodePoint(point).length;
    this.emitCodePoint(point);
  }

  private emitCodePoint(point: number): void {
    this.emit(codePointEscape(point));
  }

  private emit(text: string): void {
    this.out += text;
  }

  /** @see stepInClass -- the mirror case, `[\w-a]`. */
  private rejectRangeAfterClassEscape(): void {
    const rest = this.src.slice(this.index);
    if (rest.startsWith("-") && !rest.startsWith("-]") && rest.length > 1) {
      throw this.badRange(this.index + 2);
    }
  }
}

/**
 * Escaped characters `u` mode already accepts as themselves.
 *
 * Everything else Python lets an author escape -- `\-`, `\ `, `\#`, `\&`,
 * `\~` -- is a SyntaxError under `u`, and goes out as a code-point escape
 * instead.
 */
const PASSTHROUGH_ESCAPES: ReadonlySet<string> = new Set("^$\\.*+?()[]{}|/");

/** `-\w`, `-\d`, `-\s` and negations: a range whose upper bound is a class. */
const CLASS_ESCAPE_AFTER_DASH = /^-\\[wWdDsS]/;
