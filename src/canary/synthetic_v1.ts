/**
 * The synthetic counterparty -- a stand-in for v1, and only a stand-in.
 *
 * Ported from interlock `src/claude_org_runtime/canary/synthetic_v1.py` at
 * `65f36c5`.
 *
 * **This is not v1.** It is a deliberately small append-only run store that
 * plays v1's structural part in the item 10 rehearsal: a second system with its
 * own store, into which runs the routing point assigns to `synthetic_v1` are
 * written. It reproduces none of v1's behaviour, load or failure modes, which
 * is exactly why the rehearsal it enables is not a discharge -- item 10 is
 * discharged at the canary itself, with **live v1** as the counterparty
 * (D-0022). Throwaway by default (D-0026).
 *
 * The store is a JSON-lines file rather than SQLite, on purpose: the
 * counterparty's store should look like *another system's* store, not like a
 * second copy of ours -- v1's durable state was files, not a database -- and a
 * format this dumb keeps anyone from mistaking the stand-in for an
 * implementation. One record per line, keys sorted, no in-place mutation:
 * finishing a run appends a `run_finished` record rather than editing the
 * `run_started` one.
 *
 * Every write path of the synthetic system lands in this file. That closure is
 * what makes the writer audit's enumeration of the store a capture of *all*
 * synthetic-side writes rather than a sample (see `audit.ts`).
 *
 * The store is **single-writer**, like the rehearsal that drives it: the
 * start-once check is a read followed by an append, which two concurrent
 * writers could interleave. The stand-in does not pretend to solve v1's
 * concurrency -- a stand-in that quietly did would be one more thing the
 * rehearsal appeared to prove and had not -- and the real counterparty's own
 * store discipline is among the things only the canary exercises.
 *
 * Two things the port has to say that Python did not have to:
 *
 * - **The canonical line.** Python's `json.dumps(record, sort_keys=True,
 *   separators=(",", ":"))` is stdlib; `JSON.stringify` is not the same
 *   function (it neither sorts keys nor escapes non-ASCII), so the renderer is
 *   written out below. It is written *here*, rather than reused from
 *   `src/fencing/pyjson.ts` which already implements `json.dumps` in full,
 *   because the canary package imports no other module of this runtime -- a
 *   structural property the belt asserts, and the analogue of the source's
 *   "stdlib only" import list. See {@link canonicalJson}.
 * - **`Path` semantics and Python's types.** Where the source relies on a
 *   Python type to exclude a value (rule 9 of the translation conventions), the
 *   comment at the site says what TypeScript admits instead and what is done
 *   about it.
 */

import { appendFileSync, closeSync, openSync, readFileSync, statSync } from "node:fs";

/** The synthetic store refused a write or an open. Nothing was written. */
export class SyntheticStoreRefusal extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    // Both lines are required: extending a built-in loses the prototype chain
    // under a downlevel emit, and the tests assert refusal *types*.
    this.name = "SyntheticStoreRefusal";
    Object.setPrototypeOf(this, SyntheticStoreRefusal.prototype);
  }
}

/** One line of the store, as it is written and as it is read back. */
type StoreRecord = Record<string, unknown>;

/** The stand-in system's run store: an append-only JSON-lines file. */
export class SyntheticV1RunStore {
  readonly #path: string;

  /**
   * Records the path and touches nothing.
   *
   * The laziness is load-bearing, not incidental: a store may name a path that
   * does not exist yet, and the refusal for that surfaces from the first read
   * or write rather than from construction. A ported case constructs a store
   * over an absent file *outside* the refusal assertion and would fail against
   * an eager constructor.
   */
  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Create an empty store, refusing to clobber anything that exists -- the same
   * explicit-creation discipline as both real stores (R3).
   */
  static create(path: string): SyntheticV1RunStore {
    // `wx` is O_EXCL, not exists()-then-write: the check-then-create window
    // would let a racing creator's store be truncated by the loser -- the same
    // race the ledger and S5 close the same way. An `existsSync` guard would
    // pass the ported case just as well, which is why the flag is the thing
    // being held here.
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SyntheticStoreRefusal(`${path} already exists; refusing to create over it`, {
          cause: error,
        });
      }
      // Every other OSError-equivalent (ENOENT for a missing parent, EACCES)
      // propagates unwrapped, as it does in the source.
      throw error;
    }
    return new SyntheticV1RunStore(path);
  }

  /**
   * Append a `run_started` record.
   *
   * Refuses when `runId` was already started; the synthetic system, like the
   * real ones, does not start a run twice.
   *
   * The guard reads {@link runIds}, which is **every** run id in **any**
   * record -- so a store holding only a `run_finished` record for a run still
   * refuses to start it. That is the source's guard, and it is wider than
   * "already started" sounds; narrowing it to the started set would be a
   * different function.
   */
  startRun(runId: string, options: { readonly nowMs: number }): void {
    if (this.runIds().includes(runId)) {
      throw new SyntheticStoreRefusal(`run '${runId}' was already started in this store`);
    }
    this.#append({ record: "run_started", run_id: runId, at_ms: options.nowMs });
  }

  /**
   * Append a `run_finished` record for a run this store started.
   *
   * Refuses for a run never started here, or already finished -- either would
   * fabricate history. The two checks are in that order, and the order is
   * observable: a run that is both would report "never started".
   */
  finishRun(runId: string, options: { readonly nowMs: number }): void {
    const { started, finished } = this.#startedAndFinished();
    if (!started.has(runId)) {
      throw new SyntheticStoreRefusal(`run '${runId}' was never started in this store`);
    }
    if (finished.has(runId)) {
      throw new SyntheticStoreRefusal(`run '${runId}' is already finished in this store`);
    }
    this.#append({ record: "run_finished", run_id: runId, at_ms: options.nowMs });
  }

  /**
   * Every run this system has written a record for, sorted. This is the store's
   * answer to the writer audit's question.
   *
   * Sorted and deduplicated, which is not file order: the audit compares this
   * against the ledger's enumeration, and a comparison whose left side depends
   * on write order is a comparison that reports a difference nobody made.
   */
  runIds(): readonly string[] {
    const ids = new Set<string>();
    for (const record of this.records()) {
      ids.add(runIdOf(record));
    }
    // Python's `sorted()` over `str` compares by **code point**; JavaScript's
    // default comparator compares UTF-16 **code units**, and the two disagree
    // above the BMP. Every run id the rehearsal writes is ASCII, so nothing
    // reaches the disagreement today -- it is spelled out anyway, because a
    // sort whose carve-out is undocumented is the kind that stops being true
    // quietly.
    return [...ids].sort(byCodePoint);
  }

  /**
   * The records, in file order.
   *
   * Refuses a missing or unparseable file -- refused, never read as empty (R3
   * applies to the stand-in too, because an audit over a store read as empty is
   * an audit that proves nothing).
   */
  records(): readonly StoreRecord[] {
    // `statSync` with `throwIfNoEntry: false`, not `existsSync`, and not a
    // `statSync` that throws: Python's `Path.is_file()` answers false for an
    // absent path *and* for a directory, and both must reach the same refusal.
    // It follows symlinks, as `is_file()` does.
    const stats = statSync(this.#path, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isFile()) {
      throw new SyntheticStoreRefusal(`${this.#path} does not exist; refusing to read`);
    }

    const records: StoreRecord[] = [];
    const lines = splitLines(decodeUtf8(readFileSync(this.#path)));
    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        // Note what is *not* here: a blank line is not skipped. Python's
        // `json.loads("")` raises, so a store with a hole in the middle of it
        // is refused, and reproducing that is the difference between "the store
        // is intact" and "the parts of it that parsed are intact".
        throw new SyntheticStoreRefusal(
          `${this.#path}:${lineNumber} is not a record: ${String(error)}; a ` +
            "broken store is refused, not read as empty",
          { cause: error },
        );
      }
      if (!isRecord(parsed) || !Object.hasOwn(parsed, "run_id")) {
        throw new SyntheticStoreRefusal(
          `${this.#path}:${lineNumber} carries no run_id; refusing to audit around it`,
        );
      }
      records.push(parsed);
    }
    return records;
  }

  /** The started and finished sets, bucketed by the `record` field. */
  #startedAndFinished(): {
    readonly started: ReadonlySet<string>;
    readonly finished: ReadonlySet<string>;
  } {
    const started = new Set<string>();
    const finished = new Set<string>();
    for (const record of this.records()) {
      // `record.get("record")` in the source: a record with no `record` key is
      // in neither bucket rather than an error, which is how a store written by
      // some future record class stays readable.
      if (record["record"] === "run_started") {
        started.add(runIdOf(record));
      } else if (record["record"] === "run_finished") {
        finished.add(runIdOf(record));
      }
    }
    return { started, finished };
  }

  /** The sole write path. */
  #append(record: StoreRecord): void {
    let line = `${canonicalJson(record)}\n`;
    // A crash can leave a byte-complete final record missing only its newline;
    // records() still reads that store, so a legitimate append must not fuse
    // itself onto the torn tail and turn a readable store into a refused one.
    //
    // Both halves of the condition matter, and the empty half is the trap: an
    // empty store's "last byte" is absent, and prepending a newline there would
    // write a leading blank line -- which records() then refuses, breaking
    // every store this module ever creates.
    const existing = readFileSync(this.#path);
    const tail = existing.subarray(existing.length - 1);
    if (tail.length > 0 && tail[0] !== 0x0a) {
      line = `\n${line}`;
    }
    appendFileSync(this.#path, line, "utf-8");
  }
}

/**
 * `json.dumps(record, sort_keys=True, separators=(",", ":"))`, byte for byte.
 *
 * Exported because `audit.ts` canonicalises both stores with the *same*
 * renderer, and two copies of this would be two things to keep in step with
 * Python -- the failure `D-0017` rule 4's "one renderer" exists to stop. It
 * lives in this module rather than in a shared one because the canary package
 * imports nothing else in this runtime; see the module docstring.
 *
 * Three differences from `JSON.stringify`, none of which an assertion that
 * parses the text can see:
 *
 * - **Sorted keys**, by code point (Python's `sort_keys=True`).
 * - **Separators**: `","` and `":"`, with no spaces. `json.dumps` defaults to
 *   `", "` / `": "`, so the separators are given explicitly at the source's
 *   call site and are given explicitly here.
 * - **`ensure_ascii=True`**: every character from `U+007F` up is escaped as
 *   `\uXXXX` (lower case, four digits, a surrogate *pair* above the BMP).
 *   `JSON.stringify` emits it raw.
 *
 * `undefined` renders as `null`, matching the way `JSON.stringify` handles the
 * only spelling of absence Python has; nothing this module writes reaches it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      // Python emits `NaN` / `Infinity` here, which is not JSON at all. A store
      // line that no reader can parse is the corrupt state R3 refuses, so this
      // refuses to write it instead.
      throw new TypeError(`canonicalJson cannot render ${String(value)} as JSON`);
    }
    return String(value);
  }
  if (typeof value === "bigint") {
    // Python's `int` is arbitrary precision and `json.dumps` writes it as its
    // decimal digits; `BigInt.prototype.toString()` writes the same digits, so
    // this is the encoding that matches the source rather than a departure from
    // it. `audit.ts` reads SQLite INTEGERs as bigints precisely so that a
    // 64-bit value wider than a double survives into the digest intact.
    return value.toString();
  }
  if (typeof value === "string") {
    return canonicalJsonString(value);
  }
  if (Array.isArray(value)) {
    // Indexed rather than `.map`, which SKIPS the holes in a sparse array and
    // would render `[1, , 2]` as `[1,,2]` -- not JSON, and unparseable on the
    // way back in. Python has no sparse array, so this is a hazard the
    // translation introduces rather than one the source has.
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      items.push(canonicalJson(value[index]));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort(byCodePoint)
      .map(
        (key) =>
          `${canonicalJsonString(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`canonicalJson cannot render a ${typeof value} as JSON`);
}

/**
 * One JSON string literal, escaped as `json.dumps` escapes it.
 *
 * Built on `JSON.stringify`, which already handles quotes, backslashes and the
 * C0 controls identically, then escaping what `ensure_ascii` would. JavaScript
 * strings are UTF-16, so a character above the BMP is already two code units
 * and escaping each one produces exactly the surrogate pair Python emits.
 */
function canonicalJsonString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Python's ordering for `sorted()` and `sort_keys=True`, which is by **code
 * point**. JavaScript's default comparator is by UTF-16 code unit, and the two
 * disagree above the BMP: a leading surrogate is `0xD800`..`0xDBFF`, so an
 * astral character sorts *below* `U+E000`..`U+FFFF` under code units and
 * *above* them under code points.
 */
function byCodePoint(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    // Both are in range, so the `??` arms are unreachable; they are here
    // because `noUncheckedIndexedAccess` types the element as possibly
    // undefined and a non-null assertion would be the wrong way to say it.
    const a = (leftPoints[index] ?? "").codePointAt(0) ?? 0;
    const b = (rightPoints[index] ?? "").codePointAt(0) ?? 0;
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return leftPoints.length - rightPoints.length;
}

/**
 * `bytes.decode("utf-8")`, strict.
 *
 * `readFileSync(path, "utf-8")` substitutes `U+FFFD` for invalid input, which
 * would turn a store whose bytes are damaged into one that parses into
 * plausible-looking records (D-0015). Python's `read_text` raises; so does
 * this, and the error propagates unwrapped exactly as the source's
 * `UnicodeDecodeError` does -- it is not a refusal in the source either.
 */
function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * `str.splitlines()`.
 *
 * Not `split("\n")`: Python breaks on the full line-boundary set (CR, CRLF, VT,
 * FF, the file/group/record separators, NEL and the two Unicode separators) and
 * drops a single trailing terminator, so `"a\n"` is one line and `""` is none.
 * `"".split("\n")` in JavaScript is `[""]` -- one bogus empty line, which would
 * then fail `JSON.parse` and turn a legitimately empty store into a refused
 * one. A blank line in the *middle* survives, because Python keeps it and the
 * refusal it causes is a property the port owes its source.
 *
 * Written as a scan rather than as a `split` over a character class, because
 * the class would carry three literal control characters and the linter
 * (rightly, in general) refuses those inside a regular expression. The set is
 * therefore named once, below, where each member can say what it is.
 */
function splitLines(text: string): readonly string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const point = text.charCodeAt(index);
    if (!LINE_BOUNDARIES.has(point)) {
      continue;
    }
    lines.push(text.slice(start, index));
    // CRLF is one boundary, not two: splitting it in two would report a blank
    // line between every pair of records in a Windows-written store.
    if (point === 0x0d && text.charCodeAt(index + 1) === 0x0a) {
      index += 1;
    }
    start = index + 1;
  }
  // Python drops only the *terminator*, not a final unterminated line: `"a\n"`
  // is one line and `"a"` is also one, while `""` is none. What is left after
  // the last boundary is a line exactly when it is non-empty.
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

/**
 * `str.splitlines()`'s boundary set, restricted to the code units that can
 * appear here: LF, VT, FF, CR, FS, GS, RS, NEL, LINE SEPARATOR and PARAGRAPH
 * SEPARATOR. All are in the BMP, so comparing code *units* is exact.
 */
const LINE_BOUNDARIES: ReadonlySet<number> = new Set([
  0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
]);

/** A parsed line that is a JSON *object*, which is what a record must be. */
function isRecord(value: unknown): value is StoreRecord {
  // `typeof null` and `typeof []` are both `"object"` in JavaScript, so
  // `isinstance(record, dict)` needs all three tests rather than one.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `run_id` of a record, as a string.
 *
 * Rule 9: Python's `record["run_id"]` is whatever the JSON held, and a store
 * mixing a `str` id with an `int` one makes `sorted()` raise `TypeError` there.
 * Nothing here can raise that, so the value is rendered instead. The source
 * type-checks neither, so neither does this: refusing a non-string id would be
 * a guard the source does not have.
 */
function runIdOf(record: StoreRecord): string {
  const value = record["run_id"];
  return typeof value === "string" ? value : String(value);
}
