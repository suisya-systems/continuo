import { codePointEscape, uLiteralAtom } from "./uescape.js";

/**
 * Python's `fnmatch`, transcribed.
 *
 * `fencing/rules.py` decides whether a tool call is denied by calling
 * `fnmatch.fnmatchcase`. That makes CPython's glob-to-regex translation part of
 * the fence's semantics, not an implementation detail of it -- and the two
 * plausible shortcuts both fail in the **dangerous** direction:
 *
 * - *Reach for a glob library.* Every popular one implements shell globbing,
 *   where `*` stops at a path separator. `fnmatch`'s `*` does not: it is
 *   `(?s:.*)`, and it crosses `/` freely. A fence rule `**\/*.pem` that stopped
 *   at a separator would deny fewer paths than interlock denies.
 * - *Hand-roll `* -> .*`, `? -> .`.* That drops bracket expressions entirely,
 *   and `[!seq]`, empty ranges, and the `&&` / `~~` / `||` set-operation
 *   escaping are exactly where a hand-rolled version and CPython part company.
 *
 * A rule that matches less than its source is a hole in the fence with no probe
 * and no error, which is the failure mode the whole fencing lineage exists to
 * prevent (F2/V15/V16). So this is a **transcription of CPython 3.12.3's
 * `Lib/fnmatch.py`**, checked against the original by a differential vector
 * rather than by eye -- the same discipline `D-0013` applied to
 * `sqlite3_complete`, for the same reason: reviewing a translation of a
 * character-class parser by reading it is the task human review is worst at.
 *
 * Authority: `DECISIONS.md` D-0200. The vector and its regeneration procedure:
 * `docs/differential-oracle.md`.
 *
 * ## The four places this departs from the Python text, and why each is safe
 *
 * All four are forced by JavaScript's `RegExp`, and none of them changes which
 * strings match. That claim is not a promise -- it is what the differential
 * vector checks, input by input, against CPython itself.
 *
 * 1. **Atomic groups.** CPython emits `(?>.*?fixed)` for an interior
 *    `STAR fixed` pair. JavaScript has no atomic group, so this emits the
 *    standard emulation `(?=(.*?fixed))\N`: a lookahead captures the same
 *    minimal match, and the backreference consumes exactly it, which forbids
 *    the backtracking the atomic group forbids. The group indices are assigned
 *    in emission order, and nothing else in the output opens a group.
 * 2. **`\Z`.** JavaScript has no `\Z`. Python's `\Z` matches only at the very
 *    end of the string; JavaScript's `$` **without** the `m` flag matches only
 *    at the very end of the string. They agree. (Python's `$` does not -- it
 *    also matches before a trailing newline -- which is why CPython spells it
 *    `\Z` and why this must not be translated to `$` under `m`.)
 * 3. **`(?s:...)`.** JavaScript has no inline scoped flags. The whole pattern
 *    is the scope in CPython's output, so this compiles with the `s` flag,
 *    which is the same thing said globally.
 * 4. **Every literal is respelled for `u` mode.** CPython's `translate` emits
 *    identity escapes -- `\&`, `\~`, `\ `, `\#` -- that `u` mode rejects
 *    outright, so an earlier revision of this file compiled **without** `u` and
 *    took their Annex B meaning (the literal character) instead. That was
 *    correct about the escapes and wrong about the consequence: without `u` a
 *    regex atom matches one UTF-16 **code unit**, while CPython's `fnmatch`
 *    matches one Unicode **code point**. `fnmatchcase("\u{1f600}", "?")` is
 *    `True` in CPython and was `false` here, because the emoji is two code
 *    units and `.` consumed one -- a rule using `?` denying less than interlock
 *    denies, which is precisely the hole this module exists to close.
 *
 *    So `u` is now always set, and nothing that reaches the output relies on an
 *    identity escape `u` forbids. Every literal character is emitted through
 *    `uescape.ts` as one `u`-legal atom: printable ASCII as itself, a
 *    SyntaxCharacter behind a backslash, everything else as `\u{...}`. That
 *    module is shared with `pyregex.ts`, which solved the same problem first.
 *
 * `translate` also walks its input by **code point** rather than by UTF-16
 * index, for the same reason: CPython indexes a `str` by code point, so an
 * astral character inside a bracket expression or standing as a range endpoint
 * would otherwise be sliced through the middle.
 */

/**
 * CPython's `re.escape`, and why this file no longer spells it that way.
 *
 * `re.escape` is a `str.translate` over one fixed table, and the table is not
 * the set a JavaScript author would guess -- it includes space, `#`, `~`, `&`
 * and the ASCII whitespace controls, and it does **not** include `/`, `:` or
 * `,`. Taken from CPython 3.12.3 `Lib/re/__init__.py`:
 *
 * ```python
 * _special_chars_map = {i: '\\' + chr(i) for i in b'()[]{}?*+-|^$\\.&~# \t\n\r\v\f'}
 * ```
 *
 * Reproducing that table verbatim is what forced the old no-`u` compile: half
 * of it (`- & ~ # ` and the whitespace controls) is an identity escape `u` mode
 * rejects. What the table is FOR, though, is "this character must not be read
 * as syntax", and `u` mode has its own spelling for that. So each literal goes
 * out as {@link uLiteralAtom} instead:
 *
 * | character | `re.escape` | here |
 * |---|---|---|
 * | `^ $ \ . * + ? ( ) [ ] { } \|` | `\c` | `\c` -- identical |
 * | `- & ~ #` and space | `\c` | `c` -- none of them is syntax outside a class |
 * | `\t \n \r \v \f` | `\c` | `\u{...}` |
 * | anything else | `c` | `c`, or `\u{...}` when not printable ASCII |
 *
 * The middle two rows are where the output text differs from CPython's, and
 * neither row changes which strings match. That claim is not a promise: it is
 * what `test/fencing/fnmatch-shlex-oracle.test.ts` checks, input by input,
 * against CPython itself.
 */
function escapeLiteral(text: string): string {
  let out = "";
  // Iterating a string yields CODE POINTS, so an astral character is one `ch`
  // and becomes one atom rather than two surrogate halves.
  for (const ch of text) {
    out += uLiteralAtom(ch, false);
  }
  return out;
}

/**
 * One character of a bracket-expression body, as a `u`-legal class atom.
 *
 * CPython escapes `&`, `~` and `|` in a class body to keep `&&` / `~~` / `||`
 * from being read as the set operations Python's `re` reserves them for. `u`
 * mode has no set operations, so nothing forces it here -- but `v` mode does,
 * and a class body that cannot be re-read as an operator under any flag is one
 * less thing to get wrong later. `\&` and `\~` are not legal under `u`, so the
 * escaping is done with a code-point escape instead of a backslash.
 */
function escapeClassLiteral(ch: string): string {
  if (ch === "&" || ch === "~" || ch === "|") {
    return codePointEscape(ch.codePointAt(0) as number);
  }
  return uLiteralAtom(ch, true);
}

/**
 * Every character of `text`, as `u`-legal class atoms.
 *
 * This is also where the divergence the oracle found on its first run is
 * closed. Python's `re` accepts `]` as the **first** character of a character
 * class and reads it as a literal `]`, so CPython's `translate` emits `[]]` and
 * `[^]]` and never escapes it. JavaScript's grammar does not: `[]` is the *empty*
 * class, which matches nothing, so `[]]` parses as "match nothing, then `]`"
 * and `[^]]` as "match any character, then `]`". Both are valid regexes, so
 * nothing throws -- they simply mean something else.
 *
 * The two directions are worth separating, because only one of them is safe:
 * `[]]` matches strictly less than CPython (a rule that stops denying), while
 * `[^]]` matches strictly more (a rule that denies the wrong things). The first
 * is a hole in the fence.
 *
 * It was first closed by a special case that escaped a `]` in that one
 * position. That special case is gone: `escapeClassBody` escapes **every**
 * SyntaxCharacter wherever it appears in a class body, so `]` can no longer
 * reach the output raw from any position, not just the first. A rule stated
 * over all characters cannot be defeated by finding a second place the
 * character can occur, which a positional patch can.
 *
 * Found by `test/fencing/fnmatch-shlex-oracle.test.ts` at 15 of the then-4,425
 * inputs. No ported test could have found it: interlock's fencing suite never
 * exercises a bracket expression whose first member is `]`, because in Python
 * `fnmatch` is the standard library and correct by construction.
 */
function escapeClassBody(text: string): string {
  let out = "";
  for (const ch of text) {
    out += escapeClassLiteral(ch);
  }
  return out;
}

/** The sentinel CPython uses for a `*` while the parts list is being built. */
const STAR = Symbol("STAR");

type Part = string | typeof STAR;

/**
 * `fnmatch.translate`, transcribed: a shell pattern to a regular expression.
 *
 * Returns the JavaScript regex **source**. There is no way to quote a
 * meta-character in a shell pattern, exactly as in CPython.
 *
 * The structure below follows CPython's two passes literally -- first a parts
 * list with `STAR` sentinels, then the star-joining pass -- rather than being
 * reorganised into something more idiomatic. A transcription that has been
 * tidied is a transcription whose divergences are hidden in the tidying.
 */
export function translate(pat: string): string {
  const res: Part[] = [];
  const add = (part: Part): void => {
    res.push(part);
  };
  let i = 0;
  // CPython indexes a `str` by CODE POINT, so the scan below does too: `chars`
  // holds one code point per slot, every index is a code-point index, and every
  // slice is taken through `slice()`. Walking `pat` by UTF-16 index instead
  // would cut an astral character in half -- splitting a bracket expression
  // across its surrogates, or handing a range a half-character endpoint.
  const chars = Array.from(pat);
  const n = chars.length;
  const slice = (from: number, to: number): string => chars.slice(from, to).join("");

  while (i < n) {
    const c = chars[i] as string;
    i = i + 1;
    if (c === "*") {
      // compress consecutive `*` into one
      if (res.length === 0 || res[res.length - 1] !== STAR) {
        add(STAR);
      }
    } else if (c === "?") {
      add(".");
    } else if (c === "[") {
      let j = i;
      if (j < n && chars[j] === "!") {
        j = j + 1;
      }
      if (j < n && chars[j] === "]") {
        j = j + 1;
      }
      while (j < n && chars[j] !== "]") {
        j = j + 1;
      }
      if (j >= n) {
        add("\\[");
      } else {
        let stuff = slice(i, j);
        if (!stuff.includes("-")) {
          // CPython: `stuff.replace('\\', r'\\\\')` -- escape the one character
          // its class body could otherwise re-read as syntax. Here every
          // character is respelled, not just the backslash, because `u` mode
          // reads more of them as syntax than Python's `re` does.
          stuff = escapeClassBody(stuff);
        } else {
          const chunks: string[] = [];
          let k = chars[i] === "!" ? i + 2 : i + 1;
          for (;;) {
            // `str.find(sub, start, end)` -- bounded, and -1 when absent.
            k = indexOfWithin(chars, "-", k, j);
            if (k < 0) {
              break;
            }
            chunks.push(slice(i, k));
            i = k + 1;
            k = k + 3;
          }
          const chunk = slice(i, j);
          if (chunk) {
            chunks.push(chunk);
          } else {
            chunks[chunks.length - 1] += "-";
          }
          // Remove empty ranges -- invalid in RE.
          for (let m = chunks.length - 1; m > 0; m--) {
            const left = chunks[m - 1] as string;
            const right = chunks[m] as string;
            // CPython compares single characters with `>`, which on `str` is a
            // code-point-wise comparison, and takes `[-1]` / `[1:]` of a `str`
            // by code point. Both are done by code point here: an astral range
            // endpoint compared or trimmed as UTF-16 would compare its high
            // surrogate (0xd800..0xdbff, i.e. BELOW every CJK character) and
            // trim half of itself away.
            const leftEnd = lastCodePoint(left);
            const rightStart = firstCodePoint(right);
            if ((leftEnd.codePointAt(0) as number) > (rightStart.codePointAt(0) as number)) {
              chunks[m - 1] =
                left.slice(0, left.length - leftEnd.length) + right.slice(rightStart.length);
              chunks.splice(m, 1);
            }
          }
          // Escape backslashes and hyphens for set difference (--).
          // Hyphens that create ranges shouldn't be escaped -- so they are the
          // `join` separator, outside the per-chunk escaping, exactly as in
          // CPython.
          stuff = chunks.map(escapeClassBody).join("-");
        }
        // CPython escapes the set operations (`&&`, `~~` and `||`) with a
        // separate `re.sub` pass here. `escapeClassBody` has already done it,
        // per character, because `\&` and `\~` are not legal under `u`.
        i = j + 1;
        if (!stuff) {
          // Empty range: never match.
          add("(?!)");
        } else if (stuff === "!") {
          // Negated empty range: match any character.
          add(".");
        } else {
          if (stuff[0] === "!") {
            stuff = `^${stuff.slice(1)}`;
          }
          // CPython also guards `stuff[0] in ('^', '[')` here, because its
          // class body carries those characters raw. This one cannot: `^` and
          // `[` are SyntaxCharacters, so `escapeClassBody` emitted them as
          // `\^` and `\[`, and the same escaping is what removed the
          // leading-`]` divergence the oracle caught on its first run (see the
          // note at the foot of this file).
          add(`[${stuff}]`);
        }
      }
    } else {
      add(escapeLiteral(c));
    }
  }

  return joinTranslatedParts(res);
}

/**
 * CPython's second pass over the parts list -- "Deal with STARs".
 *
 * The interior `STAR fixed` case is the one that needs an atomic group: a
 * minimal `.*?` followed by `fixed`, with **no possibility of backtracking**.
 * Without atomicity the translation is still correct about which strings match,
 * but it is catastrophically slower on adversarial input, which is why CPython
 * spells it `(?>...)`. The lookahead-plus-backreference emulation preserves
 * both halves: the same match, and the same refusal to backtrack into it.
 */
function joinTranslatedParts(inp: readonly Part[]): string {
  const res: string[] = [];
  const add = (part: string): void => {
    res.push(part);
  };
  let i = 0;
  const n = inp.length;
  // Group numbering for the atomic-group emulation. Nothing else this function
  // emits opens a capturing group, so a running counter is exact.
  let group = 0;

  // Fixed pieces at the start?
  while (i < n && inp[i] !== STAR) {
    add(inp[i] as string);
    i += 1;
  }
  // Now deal with STAR fixed STAR fixed ...
  while (i < n) {
    // inp[i] is STAR
    i += 1;
    if (i === n) {
      add(".*");
      break;
    }
    // inp[i] is not STAR
    const fixedParts: string[] = [];
    while (i < n && inp[i] !== STAR) {
      fixedParts.push(inp[i] as string);
      i += 1;
    }
    const fixed = fixedParts.join("");
    if (i === n) {
      add(".*");
      add(fixed);
    } else {
      group += 1;
      // CPython: add(f"(?>.*?{fixed})")
      add(`(?=(.*?${fixed}))\\${group}`);
    }
  }
  // CPython: return fr'(?s:{res})\Z' -- the `(?s:...)` becomes the `s` flag and
  // `\Z` becomes `$` without `m`, both applied by `compilePattern` below.
  return res.join("");
}

/**
 * `fnmatch._compile_pattern`, minus the cache.
 *
 * CPython caches with an `lru_cache(maxsize=32768)`; a `Map` here would grow
 * without bound, and the fence renders a handful of patterns per role, so the
 * cache is dropped rather than approximated. Dropping it changes speed, not
 * behaviour.
 */
function compilePattern(pat: string): RegExp {
  // `s` for CPython's `(?s:...)`; no `m`, so `$` is `\Z`; `u` so that `.`,
  // a class member and a range endpoint each mean one CODE POINT, as they do
  // in CPython. See departures 2-4 in the module docstring: `translate` emits
  // nothing `u` mode rejects, which is what makes the flag available.
  //
  // The leading `^` is CPython's `.match()` rather than part of `translate()`'s
  // output: `re.match` anchors at the start of the string, and `exec` does not.
  // Anchoring here rather than testing `found.index === 0` afterwards keeps the
  // engine from scanning forward for a match that could only ever be at 0.
  return new RegExp(`^${translate(pat)}$`, "su");
}

/**
 * `fnmatch.fnmatchcase`: does `name` match `pat`, case included?
 *
 * `fnmatch.fnmatch` -- which case-normalises through `os.path.normcase` and is
 * therefore case-insensitive on Windows -- is deliberately **not** provided.
 * `fencing/rules.py` calls `fnmatchcase` at every site, and a case-insensitive
 * variant sitting next to it in the module namespace is an invitation to use
 * the one that makes a fence behave differently on Windows than on Linux.
 */
export function fnmatchcase(name: string, pat: string): boolean {
  // CPython: `match(name) is not None`, where `match` is `re.compile(...).match`
  // -- anchored at the start, and the pattern's own `\Z` anchors the end.
  return compilePattern(pat).test(name);
}

/** Python's `s[-1]` on a non-empty `str`: the last CODE POINT, not code unit. */
function lastCodePoint(text: string): string {
  const point = text.codePointAt(text.length - 2);
  // `codePointAt` at the position of a low surrogate returns the surrogate
  // itself, so the pair is detected by asking one slot EARLIER whether that
  // slot begins an astral character that ends here.
  if (point !== undefined && point > 0xffff) {
    return text.slice(-2);
  }
  return text.slice(-1);
}

/** Python's `s[0]` / `s[1:]` boundary: the first CODE POINT of `text`. */
function firstCodePoint(text: string): string {
  return String.fromCodePoint(text.codePointAt(0) as number);
}

/**
 * Python's `str.find(sub, start, end)`: bounded search, `-1` when absent.
 *
 * Over the code-point array rather than the string, so the returned index is a
 * code-point index like every other index in `translate`. `sub` is always a
 * single BMP character here, so a slot-wise comparison is the whole search.
 */
function indexOfWithin(chars: readonly string[], sub: string, start: number, end: number): number {
  for (let index = Math.max(start, 0); index < end && index < chars.length; index += 1) {
    if (chars[index] === sub) {
      return index;
    }
  }
  return -1;
}
