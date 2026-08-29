/**
 * Dedup state for attention notifications.
 *
 * Ported from interlock `claude_org_runtime/attention/dedup.py` at `65f36c5`. State lives at
 * `.state/attention_notified.json` and carries two namespaces with deliberately different
 * semantics, which is the invariant `PORTING_LEDGER.md` classes as carry material:
 *
 * - `events` -- keyed by `event:<events.id>`. Recorded once, never expires. The watch loop must
 *   not replay the same database event row.
 * - `pending` -- keyed by `pending:<task_id>:<kind>`. Cooldown-gated (`cooldownSec`) so a stuck
 *   pending decision re-notifies on a slow cadence instead of either rotting silently or ringing
 *   on every poll.
 *
 * **The corruption handling is deliberately NOT carried.** The source downgrades every read
 * failure -- unreadable file, malformed JSON, wrong shape -- to a warning on stderr and returns an
 * empty `DedupState`. That was safe while this file was an advisory notification ledger. It is not
 * safe for durable, authoritative dedup state: an empty ledger says "nothing has been notified",
 * so every already-handled event is free to fire again, which is the resume-without-double-
 * execution violation `PORTING_LEDGER.md`'s own row for this module rules out. `D-0034` ratified
 * the repair as fail-closed **inside this sub-belt**, and `D-0904` records the boundary this
 * module draws: an ABSENT namespace is empty, a PRESENT but unusable one is a refusal.
 *
 * Rebuilding the state from durable records instead of refusing it is the larger repair `D-0034`
 * named as declined-for-now; nothing here forecloses it.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pyJsonDumps } from "../fencing/pyjson.js";
import { getOwn } from "../fencing/pysemantics.js";
import { parseIso, pyIsoUtc } from "./pytime.js";

/**
 * The source value of `source=` that selects the record-once namespace.
 *
 * Everything else is cooldown-gated, exactly as the source's `if source == "state.db.events"`
 * says: the default is the safer of the two, because a namespace nobody recognised would
 * otherwise be recorded forever on the strength of a typo.
 */
const STATE_DB_EVENTS = "state.db.events";

/**
 * The refusal a corrupt dedup file raises.
 *
 * Its own family rather than `src/control_plane/refusals.ts`'s: that file documents itself as
 * *the control plane's* refusals and its class identity is load-bearing across the two modules
 * that share it, so a `catch (e) { if (e instanceof ControlPlaneRefusal) ... }` written about a
 * database must not start catching an attention state file as well.
 */
export class DedupStateRefused extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DedupStateRefused";
    // Extending a built-in under a downlevel emit target loses the prototype chain, and
    // `instanceof` then silently reports false -- which would turn a type assertion in a ported
    // case into a message assertion without saying so.
    Object.setPrototypeOf(this, DedupStateRefused.prototype);
  }
}

/** One namespace: a dedup key to the ISO-8601 UTC instant it was last notified at. */
export type DedupNamespace = Record<string, string>;

/**
 * In-memory mirror of `attention_notified.json`.
 *
 * Both namespaces are built with `Object.create(null)` and read with `Object.hasOwn`, per
 * `docs/test-translation-conventions.md` rule 9. The keys are caller-supplied -- an `events.id`
 * and a `task_id` reach them unfiltered -- and Python's `dict` has no inherited keys where an
 * object literal carries `Object.prototype`. A task named `constructor` would otherwise read an
 * inherited value and be treated as already notified, which is the silent-suppression direction.
 */
export class DedupState {
  readonly events: DedupNamespace;
  readonly pending: DedupNamespace;

  constructor(
    init: {
      readonly events?: Readonly<DedupNamespace>;
      readonly pending?: Readonly<DedupNamespace>;
    } = {},
  ) {
    this.events = emptyNamespace();
    this.pending = emptyNamespace();
    for (const [key, value] of Object.entries(init.events ?? {})) {
      this.events[key] = value;
    }
    for (const [key, value] of Object.entries(init.pending ?? {})) {
      this.pending[key] = value;
    }
  }

  /** interlock `DedupState.to_dict`: a copy, so a caller cannot mutate the state through it. */
  toDict(): { readonly events: DedupNamespace; readonly pending: DedupNamespace } {
    return { events: { ...this.events }, pending: { ...this.pending } };
  }
}

/**
 * Read dedup state from `path`, or refuse.
 *
 * A file that is not there is empty state -- nothing has ever been notified, and creating one is
 * the legitimate next step. Everything else the source recovered from is now a refusal; see the
 * module header for why, and `D-0904` for where the line falls.
 */
export function loadState(path: string): DedupState {
  if (!existsSync(path)) {
    return new DedupState();
  }

  let raw: string;
  try {
    // Read BYTES and decode with a fatal decoder, rather than `readFileSync(path, "utf8")`.
    // Python's `read_text(encoding="utf-8")` raises `UnicodeDecodeError` on an undecodable byte;
    // Node's utf8 read substitutes U+FFFD and carries on, and the damage that does is not
    // hypothetical. An undecodable byte INSIDE a JSON string leaves the document syntactically
    // valid, so the parse below succeeds and the state loads with a dedup key that is not the key
    // that was written -- an already-notified event free to fire again, which is precisely what
    // this module refuses everywhere else. The `fatal` decoder puts that file on the refusing side
    // where it belongs. (The source's own answer is worse than either: `UnicodeDecodeError` is a
    // `ValueError`, so it escapes its `except OSError` and takes the watcher down. D-0904's
    // fail-closed repair is what this is; the crash is not reproduced.)
    raw = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new DedupStateRefused(
      `cannot read attention dedup state ${path}: ${describeError(error)}; ` +
        `refusing to continue with empty state`,
      { cause: error },
    );
  }

  if (raw.trim() === "") {
    // The source returns empty state here without even a warning. `saveState` writes through a
    // fully-written temporary file and a rename, so it never produces a blank one: a blank file at
    // this path is a truncation from outside, which is precisely the already-notified-forgotten
    // shape the repair exists to refuse.
    throw new DedupStateRefused(
      `attention dedup state ${path} is blank; refusing to continue with empty state`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new DedupStateRefused(
      `attention dedup state ${path} is not valid JSON (${describeError(error)}); ` +
        `refusing to continue with empty state`,
      { cause: error },
    );
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new DedupStateRefused(
      `attention dedup state ${path} top-level is not a JSON object; ` +
        `refusing to continue with empty state`,
    );
  }

  return new DedupState({
    events: readNamespace(path, data, "events"),
    pending: readNamespace(path, data, "pending"),
  });
}

/**
 * One namespace out of the parsed document.
 *
 * The two halves of the boundary `D-0904` draws are both here. An **absent** key is an empty
 * namespace: the source's `data.get("events")` returns `None` for it, `test_load_partial_shape`
 * pins that reading, and an absent namespace is the same class of fact as an absent file. A
 * **present** key whose value is not an object, or whose entries are not strings, is a refusal:
 * the source silently substitutes `{}` for the first and silently drops the entry for the second,
 * and each of those is the "malformed state loads as empty" defect at a narrower scope.
 */
function readNamespace(path: string, data: object, field: "events" | "pending"): DedupNamespace {
  const value = getOwn(data, field);
  if (value === undefined) {
    return emptyNamespace();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DedupStateRefused(
      `attention dedup state ${path} field '${field}' is not a JSON object; ` +
        `refusing to continue with empty state`,
    );
  }
  const namespace = emptyNamespace();
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new DedupStateRefused(
        `attention dedup state ${path} entry '${field}[${JSON.stringify(key)}]' is not a string; ` +
          `refusing to continue with empty state`,
      );
    }
    namespace[key] = entry;
  }
  return namespace;
}

/**
 * Atomically write dedup state to `path`.
 *
 * `mkstemp` in the destination directory, then `os.replace`, transcribed: the rename is what makes
 * the reader above never see a half-written document, and it is why a blank file at this path can
 * only have come from outside. The temporary file is removed on the failure path so a refused
 * write leaves the directory as it found it -- which `test_save_is_atomic_replaces_existing`
 * asserts directly.
 */
export function saveState(path: string, state: DedupState): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  // `mkstemp`'s own prefix, kept so an operator who finds one recognises what wrote it. The
  // random component is `mkstemp`'s; `wx` below is its exclusive-creation half.
  const temporary = join(directory, `.attention_notified.${randomBytes(9).toString("hex")}`);
  try {
    writeFileSync(
      temporary,
      `${pyJsonDumps(state.toDict(), { indent: 2, ensureAscii: false, sortKeys: true })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The source swallows this exact cleanup failure too: the write's own error is the one the
      // caller needs, and losing it to a failed unlink would report the wrong problem.
    }
    throw error;
  }
}

/**
 * Whether `key` is unseen, or past its cooldown.
 *
 * `state.db.events` is record-once: a key present in that namespace is never notified again, at
 * any age. Everything else is cooldown-gated, and a garbled stored timestamp counts as never
 * notified -- the source's own comment says why, and it is the direction that costs an extra
 * alarm rather than swallowing one.
 */
export function shouldNotify(
  state: DedupState,
  key: string,
  options: { readonly source: string; readonly cooldownSec: number; readonly now: Date },
): boolean {
  const { source, cooldownSec, now } = options;
  if (source === STATE_DB_EVENTS) {
    return !Object.hasOwn(state.events, key);
  }
  // `docs/test-translation-conventions.md` rule 9: the source types this `int`, so CPython
  // excludes `NaN` and the infinities by construction. `number` admits all three, and a `NaN`
  // cooldown makes the comparison below false for every key at every age -- notifications
  // silently suppressed forever, with nothing red anywhere. A negative cooldown is excluded for
  // the same reason `config.load_config` rejects one: it is not a shorter wait, it is no wait.
  if (!Number.isInteger(cooldownSec) || cooldownSec < 0) {
    throw new DedupStateRefused(
      `attention dedup cooldownSec must be a non-negative integer, got ${String(cooldownSec)}`,
    );
  }
  // The same rule-9 exposure one argument along, and in the same silent direction: `new Date(NaN)`
  // is a value this runtime admits and `datetime` excludes, and `NaN.getTime()` makes the cooldown
  // comparison below false for every key -- the notification suppressed with nothing red anywhere.
  // `recordNotified` already refuses it through `pyIsoUtc`; the read path needs the same answer,
  // and it is checked here rather than at the top because the `state.db.events` branch above never
  // looks at the clock.
  if (Number.isNaN(now.getTime())) {
    throw new DedupStateRefused(`attention dedup now must be a valid instant, got ${String(now)}`);
  }
  if (!Object.hasOwn(state.pending, key)) {
    return true;
  }
  const last = state.pending[key] as string;
  // The source tests the stored value for truthiness, so a stored empty string is "never
  // notified" rather than a timestamp that fails to parse. Both reach the same answer here; the
  // spelling is kept because the two are different questions and only one of them is about time.
  if (last === "") {
    return true;
  }
  const lastAt = parseIso(last);
  if (lastAt === null) {
    return true;
  }
  return (now.getTime() - lastAt.getTime()) / 1000 >= cooldownSec;
}

/** Record `key` as notified at `now`, in whichever namespace `source` selects. */
export function recordNotified(
  state: DedupState,
  key: string,
  options: { readonly source: string; readonly now: Date },
): void {
  const timestamp = pyIsoUtc(options.now);
  if (options.source === STATE_DB_EVENTS) {
    state.events[key] = timestamp;
  } else {
    state.pending[key] = timestamp;
  }
}

/** A map with no inherited keys, which is what Python's `dict` is. */
function emptyNamespace(): DedupNamespace {
  return Object.create(null) as DedupNamespace;
}

/** The message half of an unknown thrown value, for a refusal that names its cause. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
