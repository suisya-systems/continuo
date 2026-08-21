/**
 * A transcription of SQLite's `sqlite3_complete()` (`src/complete.c`).
 *
 * Interlock splits a migration step into executable statements by accumulating
 * lines until `sqlite3.complete_statement()` says the buffer is a complete
 * statement. That is the only splitter that gets trigger bodies right -- the
 * production DDL is largely triggers, and a naive split on `;` cuts every one
 * of them in half at the first statement inside its `BEGIN ... END`.
 *
 * better-sqlite3 exposes no equivalent, so the function is transcribed here.
 * Two shortcuts were considered and rejected, because each one is green on the
 * cases that matter and wrong on the schema being ported:
 *
 * - **"ends with `;`"** misclassifies every trigger (whose body ends `END;`
 *   only after interior semicolons) and every `--` comment tail.
 * - **"try `prepare()` and classify the failure"** conflates *incomplete* with
 *   *invalid*: a statement referring to a table an earlier statement in the
 *   same step created fails to prepare while being perfectly complete, so the
 *   incomplete-statement refusal would fire on a valid step.
 *
 * This is a transcription, not a reimplementation: the state table, the token
 * classes, and the early-return points are the C original's, so that a future
 * reader can diff the two. It is pinned by `test/sqlite/complete-statement.test.ts`,
 * which compares this function against SQLite's own answer over every prefix of
 * the shipped ledger plus an adversarial corpus (DECISIONS.md D-0013).
 */

// Token classes, named as in complete.c.
const TK_SEMI = 0;
const TK_WS = 1;
const TK_OTHER = 2;
const TK_EXPLAIN = 3;
const TK_CREATE = 4;
const TK_TEMP = 5;
const TK_TRIGGER = 6;
const TK_END = 7;

/**
 * The state machine, verbatim from complete.c.
 *
 * Rows are states (0 INVALID, 1 START, 2 NORMAL, 3 EXPLAIN, 4 CREATE, 5 TEMP,
 * 6 TRIGGER, 7 END); columns are the token classes above. State 1 is the only
 * accepting state -- which is why an empty string, and a string of nothing but
 * whitespace, are *not* complete.
 */
// biome-ignore format: the table is a transcription of complete.c's `trans[8][8]`.
// Its column alignment is what lets a reader diff it against the C original, which
// is the only way to check a transcription. Reflowing it destroys that.
const TRANSITIONS: readonly (readonly number[])[] = [
  /*             SEMI  WS  OTHER  EXPLAIN  CREATE  TEMP  TRIGGER  END */
  /* 0 INVALID */ [ 1,  0,     2,       3,      4,    2,       2,   2 ],
  /* 1 START   */ [ 1,  1,     2,       3,      4,    2,       2,   2 ],
  /* 2 NORMAL  */ [ 1,  2,     2,       2,      2,    2,       2,   2 ],
  /* 3 EXPLAIN */ [ 1,  3,     3,       2,      4,    2,       2,   2 ],
  /* 4 CREATE  */ [ 1,  4,     2,       2,      2,    5,       6,   2 ],
  /* 5 TEMP    */ [ 1,  5,     2,       2,      2,    2,       6,   2 ],
  /* 6 TRIGGER */ [ 6,  6,     6,       6,      6,    6,       6,   7 ],
  /* 7 END     */ [ 1,  7,     6,       6,      6,    6,       6,   7 ],
];

/**
 * SQLite's `IdChar`: what may appear inside an unquoted identifier or keyword.
 *
 * Includes every code unit at or above 0x80, which is how SQLite admits
 * non-ASCII identifiers without knowing anything about encodings.
 */
function isIdChar(ch: string): boolean {
  return /[0-9A-Za-z_$]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\r" || ch === "\t" || ch === "\n" || ch === "\f";
}

/**
 * Whether `sql` ends on a statement boundary -- SQLite's own answer.
 *
 * Returns false for text that ends inside an unterminated string, an
 * unterminated `[...]` or backtick identifier, an unclosed C-style comment, or
 * a `CREATE TRIGGER` whose `END;` has not arrived. Returns false for the empty
 * string.
 */
export function isCompleteStatement(sql: string): boolean {
  let state = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i] as string;
    let token: number;

    if (ch === ";") {
      token = TK_SEMI;
    } else if (isSpace(ch)) {
      token = TK_WS;
    } else if (ch === "/") {
      // A C-style comment, or a bare slash operator.
      if (sql[i + 1] !== "*") {
        token = TK_OTHER;
      } else {
        i += 2;
        while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
          i += 1;
        }
        // An unterminated /* ... */ can never be completed by what follows,
        // so the C original returns 0 outright rather than falling out of the
        // loop in whatever state it happened to be in.
        if (i >= sql.length) {
          return false;
        }
        i += 1;
        token = TK_WS;
      }
    } else if (ch === "-") {
      // A `--` comment to end of line, or a bare minus.
      if (sql[i + 1] !== "-") {
        token = TK_OTHER;
      } else {
        while (i < sql.length && sql[i] !== "\n") {
          i += 1;
        }
        // Note the asymmetry with the block comment above, and keep it: a
        // trailing line comment does not invalidate an otherwise complete
        // statement, so this returns the state rather than false.
        if (i >= sql.length) {
          return state === 1;
        }
        token = TK_WS;
      }
    } else if (ch === "[") {
      i += 1;
      while (i < sql.length && sql[i] !== "]") {
        i += 1;
      }
      if (i >= sql.length) {
        return false;
      }
      token = TK_OTHER;
    } else if (ch === "`" || ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < sql.length && sql[i] !== quote) {
        i += 1;
      }
      if (i >= sql.length) {
        return false;
      }
      token = TK_OTHER;
    } else if (isIdChar(ch)) {
      let n = 1;
      while (i + n < sql.length && isIdChar(sql[i + n] as string)) {
        n += 1;
      }
      token = keywordToken(sql, i, n);
      i += n - 1;
    } else {
      // Operators and punctuation.
      token = TK_OTHER;
    }

    state = (TRANSITIONS[state] as readonly number[])[token] as number;
    i += 1;
  }

  return state === 1;
}

/**
 * Classify the `n`-character word at `offset`.
 *
 * Only four keywords matter to the machine, and each is matched on its exact
 * length as well as its letters -- `creates` is not `create`, and the C
 * original's `nId==6` guard is what says so.
 */
function keywordToken(sql: string, offset: number, n: number): number {
  const word = sql.slice(offset, offset + n).toLowerCase();
  switch (word[0]) {
    case "c":
      return n === 6 && word === "create" ? TK_CREATE : TK_OTHER;
    case "t":
      if (n === 7 && word === "trigger") return TK_TRIGGER;
      if (n === 4 && word === "temp") return TK_TEMP;
      if (n === 9 && word === "temporary") return TK_TEMP;
      return TK_OTHER;
    case "e":
      if (n === 3 && word === "end") return TK_END;
      if (n === 7 && word === "explain") return TK_EXPLAIN;
      return TK_OTHER;
    default:
      return TK_OTHER;
  }
}

/**
 * Python's line-boundary set, named code point by code point.
 *
 * The statement splitter feeds SQLite one *line* at a time, and the set of
 * characters Python treats as a line boundary is wider than `\n`. Splitting at
 * fewer points than the source does could merge two statements into one
 * execution, which changes what a mid-step failure rolls back.
 *
 * Built with `new RegExp` from an explicit list rather than written as a regex
 * literal, because the list is the interesting part -- the separators nobody
 * thinks about are exactly the ones a literal would quietly lose.
 */
const LINE_BOUNDARY_CODE_POINTS = [
  0x0a, // line feed
  0x0b, // line tabulation
  0x0c, // form feed
  0x0d, // carriage return
  0x1c, // file separator
  0x1d, // group separator
  0x1e, // record separator
  0x85, // next line
  0x2028, // line separator
  0x2029, // paragraph separator
];

const PYTHON_LINE_BOUNDARY = new RegExp(
  `\r\n|[${LINE_BOUNDARY_CODE_POINTS.map((point) => `\\u${point.toString(16).padStart(4, "0")}`).join("")}]`,
  "g",
);

export function splitLinesKeepEnds(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  PYTHON_LINE_BOUNDARY.lastIndex = 0;
  let match = PYTHON_LINE_BOUNDARY.exec(text);
  while (match !== null) {
    lines.push(text.slice(start, match.index + match[0].length));
    start = match.index + match[0].length;
    match = PYTHON_LINE_BOUNDARY.exec(text);
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}
