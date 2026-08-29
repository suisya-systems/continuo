/**
 * Read-only loaders for the attention watcher.
 *
 * The classifier is pure; this module is the only place that touches the filesystem and SQLite.
 * Each loader tolerates missing files and returns an empty list -- first-start environments (no
 * `state.db`, no `pending_decisions.json`) must not crash the watcher.
 *
 * Ported from interlock `claude_org_runtime/attention/readers.py` at `65f36c5`. The invariants
 * carry; two mechanisms are rewritten, and both are recorded in
 * `parity/attention.readers.ledger.json`:
 *
 * - **SQLite.** `sqlite3.connect("file:...?mode=ro", uri=True)` becomes `openDatabase(path,
 *   { readonly: true })`. Python's connect is lazy and fails at the first statement; this one
 *   fails at its opening pragma. Both degrade to "no events" with a warning naming the state DB,
 *   which is what the source's case asserts.
 * - **The backward tail walk.** `_chunk_reaches_cutoff` is reached through {@link readersSeams}
 *   rather than as a module global, because ESM bindings cannot be rebound from outside the way
 *   `monkeypatch.setattr` rebinds a Python module dict entry
 *   (`docs/test-translation-conventions.md` rule 5).
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { splitLinesKeepEnds } from "../sqlite/complete-statement.js";
import { openDatabase } from "../sqlite/open.js";

/**
 * Event `kind` column values relevant to attention classification.
 *
 * Narrowing the SELECT keeps `scan` cheap on busy databases (`events` grows unbounded) and gives
 * the unit tests a fixed surface to assert.
 */
export const RELEVANT_EVENT_KINDS: readonly string[] = Object.freeze([
  "notify_sent",
  "ci_completed",
  "worker_completed",
  "pr_merged",
]);

/**
 * Broker journal (interlock Issue #167). `.state/broker/queue.jsonl` is the org-broker's
 * append-only journal; `duplicate_sidecar_detected` is the line the daemon writes when two
 * distinct sidecar instances poll for the same owner inside one lease window. Field shape:
 * `{ts, event, owner, instances}`.
 */
export const BROKER_JOURNAL_NAME = "queue.jsonl";
export const DUPLICATE_SIDECAR_EVENT = "duplicate_sidecar_detected";

/**
 * Delivery-ownership signals (interlock Issue #166). Two more lines the daemon already writes but
 * nobody read, both meaning "this owner is not receiving push and only a human can fix it".
 *
 * `delivery_register_superseded` -- a sidecar presented an observer secret that no longer
 * matches, i.e. a session that was superseded by a rotate. It latches and never claims again, so
 * this fires once per bypassing session.
 *
 * `delivery_adopt_expired` -- an explicit adopt was armed but no adopting sidecar registered
 * before the deadline, so the daemon reverted the handover.
 *
 * Neither repeats. That is why they get their own, much longer freshness window than
 * `duplicate_sidecar_detected`, which re-emits per lease window.
 */
export const DELIVERY_SUPERSEDED_EVENT = "delivery_register_superseded";
export const DELIVERY_ADOPT_EXPIRED_EVENT = "delivery_adopt_expired";

/**
 * The journal is append-only and never rotated, so a running watcher must not re-read it whole on
 * every poll. Instead the tail is walked backwards one chunk at a time and the walk stops at the
 * first line older than the freshness window -- so the amount read follows the window the
 * operator configured, not an unrelated byte constant.
 */
export const BROKER_JOURNAL_CHUNK_BYTES = 64 * 1024;

/**
 * Safety bound on that walk: a journal whose lines all lack a usable `ts` (or a clock that jumped
 * backwards) would otherwise drag the scan to the top of an unbounded file on every poll. Hitting
 * this cap is reported rather than silently truncating the window.
 */
export const BROKER_JOURNAL_MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** One row of `events`, as the classifier consumes it. */
export interface EventRow {
  readonly id: unknown;
  readonly occurred_at: unknown;
  readonly actor: unknown;
  readonly kind: unknown;
  readonly payload: Record<string, unknown>;
}

/** One journal record, with `ts` normalized to a finite number. */
export type JournalRecord = Record<string, unknown> & { readonly ts: number };

/** The projection `readBrokerDuplicates` publishes: exactly three keys. */
export interface DuplicateSidecarRow {
  readonly ts: number;
  readonly owner: unknown;
  readonly instances: unknown;
}

/**
 * The one seam this module carries, and the only place production reaches it.
 *
 * The source spies on `_chunk_reaches_cutoff` with `monkeypatch.setattr` to prove the backward
 * walk stays linear in the bytes it reads. ESM has no equivalent rebinding, so the internal call
 * goes through this record and the test replaces the entry
 * (`docs/test-translation-conventions.md` rule 5). Its liveness is pinned by a target-only case.
 */
export const readersSeams = {
  chunkReachesCutoff,
};

function warn(message: string): void {
  // ASCII only, and stderr rather than a log sink: the source writes with `print(file=sys.stderr)`
  // and its cases read the rendered text back through `capsys`, so the observable being ported is
  // the stderr text itself (docs/cli-output-policy.md).
  process.stderr.write(`${message}\n`);
}

/** What `str(exc)` would have rendered for the diagnostic line. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Return rows from `events` that may produce attention events.
 *
 * Returns `[]` for any read error -- missing file, missing `events` table, non-SQLite file,
 * corrupt page, or query-time SQLite errors. A long-running `watch` must not crash because of a
 * transient database issue; we log a one-line warning and let the next poll retry.
 */
export function readEvents(stateDbPath: string): EventRow[] {
  if (!existsSync(stateDbPath)) {
    return [];
  }
  let connection: SqliteDatabase;
  try {
    connection = openDatabase(stateDbPath, { readonly: true });
  } catch (error) {
    warn(
      `warning: cannot open state DB ${stateDbPath}: ${describeError(error)}; ` +
        `treating as no events`,
    );
    return [];
  }
  try {
    let hasEvents: unknown;
    try {
      hasEvents = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
        .get();
    } catch (error) {
      warn(
        `warning: state DB ${stateDbPath} is unreadable (${describeError(error)}); ` +
          `treating as no events`,
      );
      return [];
    }
    if (hasEvents === undefined) {
      return [];
    }
    const placeholders = RELEVANT_EVENT_KINDS.map(() => "?").join(",");
    let rows: Record<string, unknown>[];
    try {
      rows = connection
        .prepare(
          `SELECT id, occurred_at, actor, kind, payload_json ` +
            `FROM events WHERE kind IN (${placeholders}) ` +
            `ORDER BY id ASC`,
        )
        .all(...RELEVANT_EVENT_KINDS) as Record<string, unknown>[];
    } catch (error) {
      warn(
        `warning: state DB events query failed (${describeError(error)}); ` +
          `treating as no events`,
      );
      return [];
    }
    return rows.map((row) => ({
      id: row["id"],
      occurred_at: row["occurred_at"],
      actor: row["actor"],
      kind: row["kind"],
      payload: safePayload(row["payload_json"]),
    }));
  } finally {
    connection.close();
  }
}

/**
 * Return entries from `pending_decisions.json` (or `[]` if absent).
 *
 * Tolerates malformed JSON: a corrupt register must not crash the watcher (the register is owned
 * by the Secretary pane, not the watcher, and may briefly be inconsistent while being rewritten).
 */
export function readPendingDecisions(pendingPath: string): Record<string, unknown>[] {
  if (!existsSync(pendingPath)) {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(pendingPath, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.filter((entry): entry is Record<string, unknown> => isPlainObject(entry));
}

/** Options shared by the two journal consumers. */
export interface BrokerJournalOptions {
  readonly nowEpoch: number;
  readonly windowSec: number;
  readonly chunkBytes?: number;
  readonly maxScanBytes?: number;
}

/**
 * Return recent `duplicate_sidecar_detected` lines from the broker journal.
 *
 * Each returned row is `{ts, owner, instances}` -- the raw journal fields, normalized only in that
 * `ts` is a usable number. Rows older than `windowSec` are dropped: the store re-emits per
 * instance pair once per lease window for as long as the condition lasts, so a short window is
 * what makes the alert mean "this is happening now" rather than "this happened once".
 *
 * Only the journal tail is read, walked backwards in `chunkBytes` steps until a line older than
 * the window turns up. The bytes read therefore follow the configured window rather than a fixed
 * constant. The `maxScanBytes` cap only guards the pathological case (no usable timestamps at
 * all, or a clock that jumped backwards) and says so on stderr rather than truncating the window
 * silently.
 *
 * A line whose `ts` is missing, non-numeric, or non-finite is **skipped** rather than treated as
 * fresh. That is the opposite of the classifier's malformed-timestamp posture and deliberately
 * so: this signal repeats on its own while the condition holds, so a dropped line costs at most
 * one lease window of delay, whereas an undateable line sitting in the tail would re-alert every
 * cooldown until the journal grew past it.
 */
export function readBrokerDuplicates(
  brokerStateDir: string,
  options: BrokerJournalOptions,
): DuplicateSidecarRow[] {
  return readBrokerEvents(
    brokerStateDir,
    [DUPLICATE_SIDECAR_EVENT],
    options,
    "duplicate-sidecar",
  ).map((record) => ({
    ts: record.ts,
    owner: record["owner"],
    instances: record["instances"],
  }));
}

/**
 * Return recent delivery-ownership signals from the broker journal.
 *
 * Both underlying events are one-shot, unlike `duplicate_sidecar_detected`. The caller therefore
 * passes a much longer `windowSec`: a repeating signal can afford a short window because it will
 * fire again, and these cannot.
 *
 * Rows are returned **raw** (only `ts` normalized) so the classifier can name the specific
 * instance or adoption in the notification; the two event shapes do not share a field set beyond
 * `owner`, and flattening them here would throw away exactly the detail an operator needs to act.
 */
export function readBrokerDeliverySignals(
  brokerStateDir: string,
  options: BrokerJournalOptions,
): JournalRecord[] {
  return readBrokerEvents(
    brokerStateDir,
    [DELIVERY_SUPERSEDED_EVENT, DELIVERY_ADOPT_EXPIRED_EVENT],
    options,
    "delivery-ownership",
  );
}

/**
 * Tail the broker journal for `eventNames` inside the freshness window.
 *
 * Shared engine for the journal consumers. Returns each matching record as-is with `ts`
 * normalized; per-event projection is the caller's job. `what` only names the signal class in the
 * two warning lines, so a degraded read says which consumer went quiet.
 */
function readBrokerEvents(
  brokerStateDir: string,
  eventNames: readonly string[],
  options: BrokerJournalOptions,
  what: string,
): JournalRecord[] {
  const path = join(brokerStateDir, BROKER_JOURNAL_NAME);
  if (!existsSync(path)) {
    return [];
  }
  const { nowEpoch, windowSec } = options;
  const cutoff = nowEpoch - windowSec;
  const maxScanBytes = Math.max(1, options.maxScanBytes ?? BROKER_JOURNAL_MAX_SCAN_BYTES);
  let walk: { lines: string[]; capped: boolean };
  try {
    walk = tailLinesBackTo(path, cutoff, {
      chunkBytes: Math.max(1, options.chunkBytes ?? BROKER_JOURNAL_CHUNK_BYTES),
      maxScanBytes,
    });
  } catch (error) {
    warn(
      `warning: cannot read broker journal ${path}: ${describeError(error)}; ` +
        `treating as no ${what} signals`,
    );
    return [];
  }
  if (walk.capped) {
    warn(
      `warning: broker journal ${path} scanned back ${maxScanBytes} bytes ` +
        `without reaching the ${windowSec}s freshness window; older ${what} ` +
        `signals inside the window may be missing`,
    );
  }
  const out: JournalRecord[] = [];
  for (const line of walk.lines) {
    const record = journalRecord(line);
    if (record === null || !eventNames.includes(record["event"] as string)) {
      continue;
    }
    const ts = journalTs(record);
    if (ts === null || ts < cutoff) {
      continue;
    }
    out.push({ ...record, ts });
  }
  return out;
}

/**
 * Read whole journal lines back to the first one older than `cutoff`.
 *
 * Returns `capped: true` when the walk stopped on `maxScanBytes` rather than on an old-enough
 * line or the top of the file -- i.e. the caller cannot assume the window is fully covered.
 */
function tailLinesBackTo(
  path: string,
  cutoff: number,
  bounds: { chunkBytes: number; maxScanBytes: number },
): { lines: string[]; capped: boolean } {
  // Chunks are collected newest-first and joined once at the end: each iteration must inspect only
  // the bytes it just read, or the walk would re-decode the whole accumulated tail per chunk
  // (quadratic -- and `watch` pays it on every poll).
  const parts: Buffer[] = [];
  const fd = openSync(path, "r");
  let pos: number;
  let capped = false;
  try {
    const stats = fstatSync(fd);
    // Refuse anything that is not a regular file, BEFORE the walk and by asking the descriptor
    // rather than the path. `Path.open("rb")` raises `IsADirectoryError` in the source, and the
    // temptation is to let the first `readSync` raise `EISDIR` instead -- which is what happens on
    // Linux, where a directory reports a non-zero size, so the walk enters its loop and the read
    // fails. **On Windows a directory reports size 0**, so `pos` starts at 0, the loop never runs,
    // nothing is ever read, and the reader hands back an empty list with no warning at all. That
    // is the exact outcome the two `unreadable journal warns` cases exist to forbid: a degraded
    // read that is indistinguishable from "nothing is wrong", for a consumer whose whole job is
    // reporting silence. Asking `fstat` first also closes the gap between the open and the stat,
    // and makes the warning identical on every platform rather than quoting whichever syscall the
    // host happened to fail at.
    if (!stats.isFile()) {
      throw new Error(`cannot read ${path}: not a regular file`);
    }
    const size = stats.size;
    pos = size;
    while (pos > 0) {
      if (size - pos >= bounds.maxScanBytes) {
        capped = true;
        break;
      }
      // Clamped to what is left of the scan budget, which the source does not do: it computes the
      // step from `chunk_bytes` alone and only re-checks the cap at the top of the NEXT iteration,
      // so a chunk larger than the remaining budget is read in full first. Two things go wrong
      // there, and D-0023 repairs an inherited defect at the belt that touches the code rather
      // than disclosing it: the walk reads (and allocates) past the bound it advertises, and -- the
      // worse half -- if that oversized chunk happens to reach an old-enough line or the top of the
      // file, the walk ends WITHOUT `capped`, so the operator is told the window was covered when
      // the read went past the cap to cover it. A target-only case pins both halves.
      const remaining = bounds.maxScanBytes - (size - pos);
      const start = Math.max(0, pos - Math.min(bounds.chunkBytes, remaining));
      const chunk = Buffer.alloc(pos - start);
      readSync(fd, chunk, 0, chunk.length, start);
      parts.push(chunk);
      pos = start;
      const last = parts[parts.length - 1] as Buffer;
      if (readersSeams.chunkReachesCutoff(last, cutoff, { atFileStart: pos === 0 })) {
        break;
      }
    }
  } finally {
    closeSync(fd);
  }
  // Node's `Buffer#toString("utf8")` substitutes U+FFFD for an invalid sequence, which is what
  // Python's `errors="replace"` does: a chunk boundary landing mid-codepoint (or any single
  // corrupt byte) does not discard the whole read. The damaged first line is dropped whenever we
  // did not reach byte 0.
  const buf = Buffer.concat([...parts].reverse());
  let lines = pythonSplitLines(buf.toString("utf8"));
  if (pos > 0 && lines.length > 0) {
    lines = lines.slice(1);
  }
  return { lines, capped };
}

/**
 * `str.splitlines()`, not `String#split("\n")`.
 *
 * Python splits on eleven boundaries, and a journal line is written with `ensure_ascii=False`, so
 * a U+2028 inside an owner name really does end a line there and really does leave both halves
 * unparseable. `splitLinesKeepEnds` already carries that list for the SQL splitter
 * (`src/sqlite/complete-statement.ts`); the terminators are stripped here because
 * `splitlines()` does not keep them.
 */
function pythonSplitLines(text: string): string[] {
  return splitLinesKeepEnds(text).map((line) => line.replace(LINE_TERMINATOR, ""));
}

/**
 * The line boundaries `splitLinesKeepEnds` splits on, anchored at the end of a kept line.
 *
 * Built from `String.fromCharCode` rather than written as a character class literal, so this file
 * stays ASCII (a form feed or a U+2028 written literally is invisible to a reader and to a diff)
 * and so the list is the same eleven code points the splitter itself uses.
 */
const LINE_TERMINATOR = new RegExp(
  `(?:\r\n|[${[0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]
    .map((point) => `\\u${point.toString(16).padStart(4, "0")}`)
    .join("")}])$`,
);

/**
 * True when the oldest complete line in `chunk` predates `cutoff`.
 *
 * The journal is a single daemon appending in time order, so the first complete line of the
 * oldest chunk read so far is the oldest line held; once it predates the cutoff, everything
 * inside the window has already been read. Lines without a usable `ts` (corrupt, or a schema the
 * daemon has not written since) simply do not end the walk, which is what `maxScanBytes`
 * ultimately bounds.
 */
function chunkReachesCutoff(
  chunk: Buffer,
  cutoff: number,
  options: { atFileStart: boolean },
): boolean {
  let lines = chunk.toString("utf8").split("\n");
  if (!options.atFileStart && lines.length > 0) {
    // The leading fragment continues into the bytes before this chunk; the trailing one continues
    // into the chunk already read. Both are skipped by `journalRecord` as unparseable, so only the
    // ordering of the scan matters here.
    lines = lines.slice(1);
  }
  for (const raw of lines) {
    const record = journalRecord(raw);
    if (record === null) {
      continue;
    }
    const ts = journalTs(record);
    if (ts !== null) {
      return ts < cutoff;
    }
  }
  return false;
}

/** Parse one journal line into an object (`null` if unusable). */
function journalRecord(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed === "") {
    return null;
  }
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isPlainObject(record) ? record : null;
}

/**
 * Return the record's epoch `ts` as a finite number (or `null`).
 *
 * A boolean is excluded explicitly, as the source excludes `bool` for being an `int` subclass:
 * `typeof true === "boolean"` already does that here, but the guard is kept where the source put
 * it so the two files answer the same question in the same place. The finiteness check is not
 * decoration either -- `JSON.parse('{"ts": 1e400}')` yields `Infinity`, and a non-finite `ts`
 * would never age out of the window and would re-alert forever.
 */
function journalTs(record: Record<string, unknown>): number | null {
  const ts = record["ts"];
  if (typeof ts === "boolean" || typeof ts !== "number") {
    return null;
  }
  return Number.isFinite(ts) ? ts : null;
}

/** Coerce `events.payload_json` to a plain object (or empty). */
function safePayload(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === "") {
    return {};
  }
  if (typeof raw !== "string") {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  return isPlainObject(value) ? value : {};
}

/**
 * Python's `isinstance(x, dict)`.
 *
 * An array is an `object` in JavaScript where it is not a `dict` in Python, so the array check is
 * load-bearing: the journal's `[1, 2, 3]` line and a `pending_decisions.json` holding a list of
 * lists both depend on it.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
