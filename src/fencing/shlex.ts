/**
 * Python's `shlex.split` and `shlex.quote`, transcribed.
 *
 * `fencing/renderer.py` uses both, and each one guards a different hole:
 *
 * - **`quote`** builds the hook command line. A rendered path containing a
 *   space arrives at the CLI as two arguments; one containing a shell
 *   metacharacter arrives as something else entirely. The renderer's own tests
 *   pin this at the string level, because the first version of the case was
 *   written against the filesystem and failed on Windows for a reason that had
 *   nothing to do with the property.
 * - **`split`** parses that command line back to check it: that the launcher
 *   resolves, that the script token names a file that exists, and -- the load
 *   bearing one -- that `--fence` and `--role` carry *this* fence and *this*
 *   role. `hook --fence /tmp/stale.json` names our hook and enforces somebody
 *   else's rules, and only a real parse catches it.
 *
 * Both directions therefore have to agree with CPython rather than merely be
 * reasonable. A naive `split(" ")` would parse the hook command line into
 * different tokens than Python's lexer does, and the failure would be silent in
 * the dangerous direction: a mis-parsed `--fence` value compares unequal, so a
 * *correct* configuration would be refused, while a token boundary that
 * happened to line up would let a *wrong* one through.
 *
 * The backslash is the sharp edge. `shlex.split` treats `\` as an escape **on
 * every platform**, so an unquoted `C:\Users\...` is silently mangled -- which
 * is exactly why the renderer quotes before it splits, and why this pair must
 * be transcribed together.
 *
 * Authority: `DECISIONS.md` D-0200. Checked against CPython by the differential
 * vector, not by eye; see `docs/differential-oracle.md`.
 *
 * ## Scope
 *
 * This transcribes CPython 3.12.3 `Lib/shlex.py` **as `split()` configures it**:
 * `posix=True`, `whitespace_split=True`, `commenters=""`, and no
 * `punctuation_chars`. The general `shlex` class is not reproduced -- the
 * renderer never varies these, and a configurable lexer here would be a surface
 * with no caller and no test.
 *
 * Two consequences of that configuration are worth stating, because they delete
 * whole branches of the original:
 *
 * - With `punctuation_chars` empty, the `'c'` state and the `_pushback_chars`
 *   lookahead queue are unreachable.
 * - With `whitespace_split` true, `wordchars` is unreachable too: every branch
 *   that consults it is reached only when the `whitespace_split` branch beside
 *   it would have accepted the character anyway. CPython's `wordchars` includes
 *   a list of Latin-1 letters under posix, and none of it can affect the
 *   result here.
 */

/**
 * Raised where CPython raises `ValueError`.
 *
 * `renderer.py` catches `ValueError` around both `shlex.split` calls and turns
 * it into a `rule-syntax` refusal, so this needs to be catchable as one thing
 * and distinguishable from a programming error. A bare `Error` would be caught
 * by the same `catch` as a genuine bug in the renderer and reported as a
 * malformed hook command.
 */
export class ShlexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShlexError";
    // Extending a built-in under a downlevel emit target loses the prototype
    // chain, and `instanceof` then silently reports false. `renderer.ts`
    // routes on `instanceof ShlexError` to tell an unquotable hook command
    // from a defect in the renderer, so a broken chain would let a real bug
    // be reported as a malformed document -- or escape the catch entirely.
    Object.setPrototypeOf(this, ShlexError.prototype);
  }
}

const WHITESPACE = " \t\r\n";
const QUOTES = "'\"";
const ESCAPE = "\\";
const ESCAPED_QUOTES = '"';

/**
 * `shlex.split(s, comments=False, posix=True)`.
 *
 * Transcribed from `shlex.read_token`'s state machine rather than rewritten as
 * a regex: the states interact through `escapedstate` and `quoted` in ways a
 * regex cannot express, and `quoted` is what makes `split('""')` return one
 * **empty** token instead of no tokens at all.
 *
 * @throws {ShlexError} on an unterminated quote or a trailing escape, matching
 * CPython's "No closing quotation" / "No escaped character".
 */
export function split(s: string): string[] {
  const tokens: string[] = [];
  // The input as a character cursor. CPython reads one character at a time from
  // a `StringIO` and gets `''` at end of file; `charAt` past the end returns
  // `""`, which is the same sentinel, so the EOF tests transcribe directly.
  let cursor = 0;
  const read = (): string => {
    const ch = s.charAt(cursor);
    cursor += 1;
    return ch;
  };

  // `shlex.__next__` loops on `get_token` until it sees `eof`, which is `None`
  // under posix. `readToken` returns `null` for that.
  for (;;) {
    const token = readToken();
    if (token === null) {
      break;
    }
    tokens.push(token);
  }
  return tokens;

  function readToken(): string | null {
    let quoted = false;
    let escapedstate = " ";
    let state: string | null = " ";
    let token = "";

    for (;;) {
      const nextchar = read();

      if (state === null) {
        token = ""; // past end of file
        break;
      } else if (state === " ") {
        if (!nextchar) {
          state = null; // end of file
          break;
        } else if (WHITESPACE.includes(nextchar)) {
          if (token || quoted) {
            break; // emit current token
          }
        } else if (ESCAPE.includes(nextchar)) {
          escapedstate = "a";
          state = nextchar;
        } else if (QUOTES.includes(nextchar)) {
          state = nextchar;
        } else {
          // CPython consults `wordchars` first and falls through to this same
          // assignment via the `whitespace_split` branch. See the module
          // docstring: with `whitespace_split` true the two are the same
          // branch.
          token = nextchar;
          state = "a";
        }
      } else if (QUOTES.includes(state)) {
        quoted = true;
        if (!nextchar) {
          // end of file
          throw new ShlexError("No closing quotation");
        }
        if (nextchar === state) {
          state = "a";
        } else if (ESCAPE.includes(nextchar) && ESCAPED_QUOTES.includes(state)) {
          escapedstate = state;
          state = nextchar;
        } else {
          token += nextchar;
        }
      } else if (ESCAPE.includes(state)) {
        if (!nextchar) {
          // end of file
          throw new ShlexError("No escaped character");
        }
        // In posix shells, only the quote itself or the escape character may be
        // escaped within quotes. Anything else keeps its backslash, so
        // `"a\b"` is four characters and not three.
        if (QUOTES.includes(escapedstate) && nextchar !== state && nextchar !== escapedstate) {
          token += state;
        }
        token += nextchar;
        state = escapedstate;
      } else if (state === "a") {
        if (!nextchar) {
          state = null; // end of file
          break;
        } else if (WHITESPACE.includes(nextchar)) {
          state = " ";
          if (token || quoted) {
            break; // emit current token
          }
        } else if (QUOTES.includes(nextchar)) {
          state = nextchar;
        } else if (ESCAPE.includes(nextchar)) {
          escapedstate = "a";
          state = nextchar;
        } else {
          // As in state ' ': `wordchars`, `quotes` and the `whitespace_split`
          // branch collapse into one under this configuration.
          token += nextchar;
        }
      }
    }

    const result = token;
    // The posix empty-token rule, and the reason `quoted` is tracked at all:
    // an unquoted empty result is end of input, but a *quoted* one is a real,
    // empty argument.
    if (!quoted && result === "") {
      return null;
    }
    return result;
  }
}

/**
 * CPython's `shlex._find_unsafe`.
 *
 * ```python
 * _find_unsafe = re.compile(r'[^\w@%+=:,./-]', re.ASCII).search
 * ```
 *
 * Written out as an explicit ASCII class rather than using `\w`: JavaScript's
 * `\w` is already ASCII-only, but relying on that hides the fact that CPython
 * had to ask for `re.ASCII` to get it. Without that flag `\w` would match
 * letters like `e` with an acute accent and `quote` would leave them unquoted.
 */
const UNSAFE = /[^A-Za-z0-9_@%+=:,./-]/;

/**
 * `shlex.quote`: a shell-escaped version of `s`.
 *
 * The empty string becomes `''` -- without that, an empty value would vanish
 * from the command line entirely rather than arriving as an empty argument.
 */
export function quote(s: string): string {
  if (!s) {
    return "''";
  }
  if (!UNSAFE.test(s)) {
    return s;
  }
  // Use single quotes, and put single quotes into double quotes.
  // The string `$'b` is then quoted as `'$'"'"'b'`.
  return `'${s.split("'").join(`'"'"'`)}'`;
}
