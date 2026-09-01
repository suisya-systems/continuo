/**
 * S2 -- the C2 `SessionProvider`, over Interlock-supervised `claude -p`.
 *
 * The implementation of the provisional S1 interface (`./provider.ts`) against
 * the provider the 2026-08-18 ruling selected: **C2 -- Interlock-supervised
 * `claude -p` subprocesses**. Interlock spawns the worker as a child process it
 * owns outright, and Interlock's own process supervision *is* the session
 * lifecycle.
 *
 * What this module knows about the backend it drives, and where that knowledge
 * comes from (interlock's `investigation/i01-supervisor-probe.md`,
 * `i02-conversation-probe.md`, `pre-spawn-fence-search.md`; CLI `2.1.234`
 * probed, `2.1.237` smoke-checked -- see {@link CLI_VERSION_WRITTEN_AGAINST}):
 *
 * - **Exit 0 is never taken as evidence of anything** (i01 3.4). A SIGINT'd run
 *   exits 0 with `is_error: true`; a refused `--session-id` exits 1 with an
 *   *empty stdout*. The verdict, such as one exists, lives in the child's own
 *   structured output, so the readout here is built from the stream-json events
 *   the child wrote and the process disposition is only ever carried as detail.
 * - **The identity the child actually received is read back and reconciled**
 *   with the one this provider committed before the spawn. Under U27 two
 *   processes both exit 0 reporting the *same* `session_id` while only one of
 *   them can be the run's writer, so agreement of ids is checked positively and
 *   a disagreement is an **incident** -- persisted, and answered as a typed
 *   failure on every subsequent read -- not a warning.
 * - **stderr is captured separately and surfaced.** The `already in use`
 *   refusal appears on stderr with stdout completely empty (i01 3.3); a
 *   supervisor that read only stdout would be blind in the one case that
 *   matters most.
 * - **Each child gets its own process group** and is stopped by signalling the
 *   group, because the CLI does not reap MCP-server children of its own and a
 *   pid-targeted signal leaves them running (i01 3.5, hazard H1).
 *
 * Two assumptions this module states because the probes proved them, and
 * because issue `#17`'s acceptance criteria require them stated next to the
 * code they constrain:
 *
 * **The provider's `already in use` refusal is never relied on as a lock**
 * (U27: a 2-3 s admission window admitted two claimants to one id, and both
 * wrote one transcript; U34: the width is a one-machine figure, not a constant;
 * U38: the claim is a file-existence check that deleting the transcript
 * releases). Where the refusal happens it is carried verbatim as the child's
 * own outcome -- defence in depth, never exclusion.
 *
 * **`--resume` is treated as unguarded** (U32: two concurrent resumes of one
 * session were both admitted, simultaneously and at a 5 s stagger). Nothing in
 * the provider stops a second resume of the same session, and nothing here
 * pretends to. Re-entry is gated by the lease this module deliberately cannot
 * name (D-0009's contract separation).
 *
 * What is *not* here is as deliberate as in the stub: no verb sends anything to
 * a running child. The one prompt a spawn carries is the argument `claude -p`
 * requires to create or re-enter a session at all.
 *
 * ## D-0301, in this file
 *
 * The five verbs return promises and each one runs inside the per-instance
 * exclusion queue, because Python gets mutual exclusion between verbs from
 * having one thread and the port has to build it. `probeCapabilities` stays
 * synchronous. Every read of a child's exit state is preceded by
 * `sessionRuntime.settleExits()`, without which a child that has already
 * finished still reads as running -- see `./runtime.ts` for the measurement.
 *
 * ## The three lints this file's own prose has to satisfy
 *
 * Three ported cases read this file as **text**.
 * `test_the_refusal_is_stated_not_to_be_a_lock_next_to_the_spawn_path` requires
 * the sentence above and the token `U27` to be present, and requires the
 * sentence again inside {@link ClaudeCliSessionProvider._startSession}'s own
 * documentation block.
 * `test_resume_says_it_is_unguarded_and_names_the_lease_as_the_gate` requires
 * `U32` and the word `lease` inside {@link ClaudeCliSessionProvider.resume}'s.
 * And the third -- the import lint, which cannot be named here without failing
 * itself -- requires that the directory name of the subsystem holding the lease
 * never appear in this file, in either the source's snake spelling or this
 * repository's camel one. So the phrase is written with a space throughout,
 * nothing from that directory is imported, and **that lint's own node id is not
 * written down here either**: it contains the forbidden token, so a comment
 * quoting it turns the lint red against a file that imports nothing.
 *
 * Ported from interlock `src/claude_org_runtime/session/claude_cli_provider.py`
 * at `65f36c5`.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { pyJsonDumps } from "../fencing/pyjson.js";
import { pyRepr } from "../fencing/pyrepr.js";
import {
  getOwn,
  PyValueError,
  pyKeys,
  pyLstrip,
  pyStr,
  pyStrip,
  pyTruthy,
} from "../fencing/pysemantics.js";
import {
  CapabilityReport,
  Failure,
  FailureKind,
  Observation,
  Ok,
  type ProviderResult,
  REQUIRED_CAPABILITIES,
  SessionProvider,
  SessionReadout,
  SpawnRefused,
  type StartRequest,
  WorkspaceTransition,
  WorkspaceVerdict,
} from "./provider.js";
import { type ChildHandle, ChildTimeout, type ProbeResult, sessionRuntime } from "./runtime.js";
import { claudeSessionUuid } from "./uuid5.js";

// --------------------------------------------------------------------------
// The constants the backend and the settings surface are described by
// --------------------------------------------------------------------------

/**
 * The CLI this implementation was written against, recorded per issue `#17`
 * and D-0010.
 *
 * The supervision and identity findings were probed on `2.1.234`; the flag
 * surface, `--session-id` honouring and `--resume` identity read-back were
 * re-confirmed by smoke run on `2.1.237` while interlock's module was written.
 * The capability probe records the *running* build's own raw answer at probe
 * time; this constant records what the code was written to.
 */
export const CLI_VERSION_WRITTEN_AGAINST = "2.1.237 (Claude Code); probes ran on 2.1.234";

/**
 * `settings` key: the prompt the started session's one turn runs.
 *
 * A `claude -p` process is one turn; without a prompt there is no process, so a
 * spawn without one uses {@link DEFAULT_PROMPT}. This is spawn configuration,
 * not delivery: no verb can write to a session that is already running
 * (D-0009).
 */
const PROMPT_SETTING = "prompt";

/**
 * `settings` key: the prompt a later {@link ClaudeCliSessionProvider.resume}
 * re-enters the session with. Persisted at start, because resume takes only a
 * session id (S1) and may run in a supervisor that has nothing else.
 */
const RESUME_PROMPT_SETTING = "resume_prompt";

/**
 * `settings` key: extra CLI arguments appended verbatim to every spawn of this
 * session -- the seam through which per-role configuration arrives without this
 * module importing the layer that rendered it.
 */
const CLI_ARGS_SETTING = "cli_args";

/** The prompt a start carries when the caller named none. */
const DEFAULT_PROMPT =
  "You are a supervised continuo worker session. Confirm you are running " +
  "and await instructions delivered separately.";

/** The prompt a resume carries when the caller named none at start. */
const DEFAULT_RESUME_PROMPT =
  "The supervisor re-entered this session after a restart. Report the state " +
  "of your current task and continue.";

/**
 * The provider's own word for the transition it makes when a start is asked for
 * a workspace that does not exist yet. Same word as the stub's on purpose: the
 * transition is the same.
 */
const CREATE_WORKSPACE = "create-workspace";

/**
 * The characters a session id may use once it has to name a state directory.
 *
 * `^...$` without the `m` flag is `re.fullmatch`, and the anchors are not
 * interchangeable with Python's: Python's `$` matches *before* a trailing
 * newline, so `re.match(r"[A-Za-z0-9._-]+$", "a\n")` succeeds where `fullmatch`
 * fails. JavaScript's unflagged `$` matches only at the end of the string, so
 * this spelling is `fullmatch` and an id carrying a newline is refused --
 * which matters, because such an id is a directory name carrying a newline.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/**
 * The help-text flag whose presence renders each CLI-dependent capability.
 *
 * `session.list`, `session.read-state` and `session.stop` do not appear here
 * because under C2 they are rendered by Interlock's own supervision of children
 * it spawned -- the probe for those is that the CLI exists and identifies
 * itself at all.
 *
 * A `Map` and not an object literal because **insertion order is observable**:
 * it is the iteration order that builds `missingFlags`, whose `repr()` is
 * interpolated into the capability report's detail. An object literal gives the
 * same order here, and would stop doing so the day a capability name looked
 * like an integer.
 */
const CAPABILITY_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  ["session.start", ["--print", "--session-id"]],
  ["session.resume", ["--resume"]],
  ["session.structured-readout", ["--output-format", "--verbose"]],
]);

/**
 * Environment variable stamped into every spawned child -- and inherited by
 * everything the child starts, MCP servers included.
 *
 * It is the marker that lets a *later* group sweep prove a process group is
 * still this session's: after the leader is reaped its pid (and so the pgid) is
 * recyclable, and a sweep that signalled an unverified group could kill
 * strangers.
 */
const CHILD_ENV_SESSION_UUID = "INTERLOCK_SESSION_UUID";

/**
 * Flags this provider renders itself.
 *
 * A per-role `cli_args` carrying one of these would be appended *after* the
 * provider's own and could override the committed identity or the
 * structured-output invocation. Refused at settings validation, before any
 * spawn.
 *
 * **The order is load-bearing**: {@link matchesOwnedFlag} returns the *first*
 * match and that flag string appears verbatim in the refusal, so `-p` is
 * checked before `--print`, `-r` before `--resume`, and `-c` before
 * `--continue`.
 */
const PROVIDER_OWNED_FLAGS: readonly string[] = [
  "-p",
  "--print",
  "-r",
  "--resume",
  "-c",
  "--continue",
  "--session-id",
  "--output-format",
  "--verbose",
];

/**
 * How much of a session's captured stderr a readout carries.
 *
 * A tail, because the messages that matter (the refusal, a fatal startup error)
 * are last, and a readout that embedded megabytes of stderr would itself be
 * unreadable.
 */
const STDERR_TAIL_CHARS = 2000;

/**
 * Name of the record file inside a session's state directory.
 *
 * The record is what makes an orphan *detectable* after a supervisor restart:
 * the CLI has no public surface that lists `-p` children (i01 3.6), so the only
 * roster that can exist is the one this provider writes itself.
 */
const RECORD_NAME = "record.json";

/**
 * The NUL no operating system can carry in an argv, spelled as an escape so
 * this file stays ASCII text.
 */
const NUL = "\u0000";

/**
 * The poll interval of both orphan loops and of the group sweep:
 * `time.sleep(0.05)`.
 *
 * Real time, never a fake timer: what these loops wait on is a process exiting
 * and `/proc` catching up with it, and neither moves when a clock is advanced.
 */
const ORPHAN_POLL_MS = 50;

// --------------------------------------------------------------------------
// Small Python primitives this module needs
// --------------------------------------------------------------------------

/**
 * The provider-owned flag `part` would reach the CLI as, or `null`.
 *
 * Three spellings reach the parser as the same option: the exact form, the
 * `--flag=value` form, and -- for the single-dash short forms -- the
 * attached-value form (`-r<uuid>`), which the CLI's option parser accepts. All
 * three are recognised, because a rejection that knew two of the three would be
 * a rejection with a doorway in it.
 */
function matchesOwnedFlag(part: string): string | null {
  for (const flag of PROVIDER_OWNED_FLAGS) {
    if (part === flag || part.startsWith(`${flag}=`)) {
      return flag;
    }
    if (!flag.startsWith("--") && part.startsWith(flag)) {
      return flag;
    }
  }
  return null;
}

/** True when the id is safe to use, whole, as one directory name. */
function isOnePathComponent(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId) && sessionId !== "." && sessionId !== "..";
}

/**
 * `sorted(strings)` -- CPython's default, which is code **point** order.
 *
 * JavaScript's `<` on strings compares UTF-16 code *units*, so an astral
 * character sorts before U+E000..U+FFFF there and after it in CPython. Two
 * places reach this: the state root's directory listing, whose entries are
 * caller-chosen session ids, and `sorted(result_event)` in the readout, whose
 * keys come out of the child's own JSON. Neither is a place to guess.
 */
function comparePythonStrings(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const x = (a[i] as string).codePointAt(0) as number;
    const y = (b[i] as string).codePointAt(0) as number;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.length - b.length;
}

/**
 * `except OSError`.
 *
 * The same discriminator `stub_provider.ts` carries, and duplicated rather than
 * shared for now: both copies are four lines of Node shim, the stub's carries a
 * page of rationale specific to the three call sites it has, and promoting them
 * into a shared module mid-belt would edit a landed, ledgered file for a
 * cosmetic reason. Measured on the porting host (Node v22.17.0): a *system*
 * error carries a numeric `errno` (`EEXIST`, `errno: -17`), while an
 * argument-validation error does not (`ERR_INVALID_ARG_VALUE`, `errno`
 * `undefined`) -- and the second is exactly the shape Python raises
 * `ValueError` for.
 */
function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return typeof (error as NodeJS.ErrnoException | null)?.errno === "number";
}

/**
 * `f"{exc}"`, which is `str(exc)`: the message alone, never the class name.
 *
 * The text either way is Node's rather than CPython's -- `ENOENT: no such file
 * or directory, open 'x'` against `[Errno 2] No such file or directory: 'x'` --
 * and no ported case compares it, so the divergence is confined to the
 * interpolated half of six refusal messages.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `{"errno": exc.errno}`.
 *
 * Node's `errno` is the **negation** of the number CPython reports and its
 * symbolic name lives in `code` instead. No ported case asserts on the value,
 * so this is a divergence the ledger records rather than one that a translation
 * table nothing would exercise papers over.
 */
function errnoOf(error: unknown): number | null {
  return isSystemError(error) ? (error.errno ?? null) : null;
}

/**
 * `repr(exc)` -- `ClassName('message')`, which is what `{exc!r}` renders.
 *
 * Reached only by the broken-record reason, where the source interpolates the
 * exception object rather than its message. The class names differ between the
 * runtimes (`SyntaxError` where CPython says `JSONDecodeError`) and no case
 * compares them; what the shape has to keep is that the reason names *what*
 * went wrong rather than only that something did.
 */
function pyExceptionRepr(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}(${pyRepr(error.message)})`;
  }
  return pyRepr(error);
}

/**
 * `f"{a_float}"` for a value the source holds as a `float`.
 *
 * Python prints `5.0` where `String(5)` prints `5`, and both timeouts are
 * interpolated into refusal messages that end in `s`.
 */
function secondsText(seconds: number): string {
  return Number.isInteger(seconds) ? `${String(seconds)}.0` : String(seconds);
}

/** `Path.is_dir()`: follows symlinks, and answers `false` rather than raising. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `Path(path).resolve()` with CPython's default `strict=False`.
 *
 * Neither of Node's two obvious spellings is this function. `fs.realpathSync`
 * **throws** for a path that does not exist, and the workspace a start is asked
 * for usually does not exist yet -- that is the whole of `#createWorkspace`'s
 * reason to be. `path.resolve` never throws but never follows a symlink either,
 * and on macOS `/tmp` is a symlink to `/private/tmp`, so a rendered workspace
 * path would then disagree with the `cwd` the child reports for that same
 * directory.
 *
 * CPython resolves as far as the path exists and normalises the rest, which is
 * what the walk below does: realpath the longest existing ancestor, then rejoin
 * the components that do not exist yet.
 *
 * One difference is left in rather than hidden. CPython resolves `..` *after*
 * following symlinks, so `/a/link/..` with `link -> /b` is `/` for it and `/a`
 * for `path.resolve`'s lexical normalisation. Reproducing that needs a
 * component-by-component walk with a symlink budget, no ported case constructs
 * such a path, and the port would be inventing a traversal the source's suite
 * has no oracle for.
 */
function pyResolve(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let head = absolute;
  for (;;) {
    try {
      const real = realpathSync(head);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch {
      const parent = dirname(head);
      if (parent === head) {
        // Even the root did not resolve -- an unmounted drive, say. The lexical
        // answer is the honest one, and CPython's non-strict resolve gives it
        // too.
        return absolute;
      }
      missing.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * `repr(bytes)` -- `b'...'`, which is what `{line[:200]!r}` renders.
 *
 * CPython picks the quote the same way it picks a `str`'s, escapes backslash,
 * tab, newline and carriage return by name, keeps printable ASCII literal, and
 * writes everything else as `\xNN`. Reached by the two garbage-line messages,
 * where a naive `buffer.toString()` would render undecodable bytes as U+FFFD --
 * losing exactly the evidence the message exists to carry.
 */
function pyBytesRepr(bytes: Uint8Array): string {
  let hasSingle = false;
  let hasDouble = false;
  for (const byte of bytes) {
    if (byte === 0x27) {
      hasSingle = true;
    }
    if (byte === 0x22) {
      hasDouble = true;
    }
  }
  const quote = hasSingle && !hasDouble ? 0x22 : 0x27;
  let out = `b${String.fromCharCode(quote)}`;
  for (const byte of bytes) {
    if (byte === quote || byte === 0x5c) {
      out += `\\${String.fromCharCode(byte)}`;
    } else if (byte === 0x09) {
      out += "\\t";
    } else if (byte === 0x0a) {
      out += "\\n";
    } else if (byte === 0x0d) {
      out += "\\r";
    } else if (byte >= 0x20 && byte < 0x7f) {
      out += String.fromCharCode(byte);
    } else {
      out += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return out + String.fromCharCode(quote);
}

/**
 * `not line.strip()` for a `bytes` line.
 *
 * Python's `bytes.strip()` with no argument strips ASCII whitespace, so a line
 * of spaces is skipped exactly as an empty one is -- while still consuming an
 * index, which is why the line numbers in the garbage messages can have gaps.
 */
function isBlankLine(line: Uint8Array): boolean {
  for (const byte of line) {
    const whitespace =
      byte === 0x20 ||
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0b ||
      byte === 0x0c ||
      byte === 0x0d;
    if (!whitespace) {
      return false;
    }
  }
  return true;
}

/** `None` where a Python `dict.get` would have answered it. */
function noneOf(value: unknown): unknown {
  return value === undefined ? null : value;
}

/** `f"{generation:03d}"`. */
function paddedGeneration(generation: number): string {
  return String(generation).padStart(3, "0");
}

/**
 * One of the two prompt settings, checked in the source's order.
 *
 * Three checks, and the order between them is observable whenever a value trips
 * more than one: type and emptiness, then the NUL, then the leading `-`.
 *
 * Note what is **not** done: the value returned is the caller's, unstripped.
 * Emptiness is judged after a strip and a leading `-` is judged after a left
 * strip, but the prompt the caller wrote is the prompt the child receives.
 */
function validatedPrompt(sessionId: string, name: string, value: unknown): string | Failure {
  if (typeof value !== "string" || pyStrip(value) === "") {
    return new Failure(
      FailureKind.REFUSED_BY_PROVIDER,
      `settings[${pyRepr(name)}] for session ${pyRepr(sessionId)} ` +
        `must be a non-empty string, got ${pyRepr(value)}`,
    );
  }
  if (value.includes(NUL)) {
    return new Failure(
      FailureKind.REFUSED_BY_PROVIDER,
      `settings[${pyRepr(name)}] for session ${pyRepr(sessionId)} ` +
        "contains a NUL, which no operating system can carry in an argv",
    );
  }
  // `value.lstrip().startswith("-")`, and `pyLstrip` rather than
  // `value.replace(/^\s+/, "")` because the two whitespace sets are not the
  // same one. Python strips per `str.isspace()`, which includes U+001C..U+001F
  // and U+0085; JavaScript's `\s` includes none of them, so a prompt whose
  // first character is U+001C followed by `--resume` is refused by interlock
  // and would have been *carried into an argv as a flag* here. The set differs
  // the other way too -- U+FEFF is `\s` to JavaScript and not whitespace to
  // Python -- so the naive spelling is wrong in both directions.
  if (pyLstrip(value).startsWith("-")) {
    return new Failure(
      FailureKind.REFUSED_BY_PROVIDER,
      `settings[${pyRepr(name)}] for session ${pyRepr(sessionId)} ` +
        "begins with '-' and would be parsed as a CLI flag rather " +
        "than carried as a prompt",
    );
  }
  return value;
}

/**
 * The one sentence `readState`, `stop` and `resume` all use for a session that
 * is not there. One function, because the source writes the same string three
 * times and a port with three copies is a port with three chances to drift.
 */
function unknownSessionDetail(sessionId: string): string {
  return (
    `this provider holds no session ${pyRepr(sessionId)} and its state ` +
    "root holds no record of one"
  );
}

// --------------------------------------------------------------------------
// The durable per-session record
// --------------------------------------------------------------------------

/**
 * Everything about one session that must survive this process.
 *
 * Written **before** the child is spawned (with {@link SessionRecord.pid} still
 * unset) and updated with the pid immediately after, so the identity is on disk
 * ahead of the process that will carry it.
 *
 * **The field names are `snake_case` because the file is.** Interlock's
 * `_SessionRecord.to_json` names each key explicitly and the differential
 * oracle compares the two runtimes' files, so this interface is the wire format
 * rather than a rendering of it; a `camelCase` shape here would need a
 * translation layer whose only job would be to be got wrong once.
 */
interface SessionRecord {
  readonly session_id: string;
  readonly claude_session_uuid: string;
  readonly workspace: string;
  readonly role: string;
  readonly resume_prompt: string;
  readonly cli_args: readonly string[];
  readonly generation: number;
  readonly argv: readonly string[];
  readonly pid: number | null;
  /**
   * On POSIX the child is its own session leader (`start_new_session`), so its
   * process group id equals its pid; recorded separately anyway so a reader of
   * the file does not need to know that.
   */
  readonly pgid: number | null;
  /**
   * A persisted identity incident. Once set it never clears: the one thing
   * worse than a session whose identity broke is one whose identity broke and
   * then read as healthy after a restart.
   */
  readonly incident: string | null;
}

/**
 * `record.to_json()` -- `json.dumps(..., indent=2)` over the keys in field
 * order.
 *
 * `pyJsonDumps` and not `JSON.stringify`, for the reason its own module gives:
 * `json.dumps` defaults to `ensure_ascii=True`, so a non-ASCII character in a
 * resume prompt or an argv is `\uXXXX`-escaped on disk. The two renderings are
 * different files, and the differential oracle compares files.
 */
function recordToJson(record: SessionRecord): string {
  return pyJsonDumps(
    {
      session_id: record.session_id,
      claude_session_uuid: record.claude_session_uuid,
      workspace: record.workspace,
      role: record.role,
      resume_prompt: record.resume_prompt,
      cli_args: [...record.cli_args],
      generation: record.generation,
      argv: [...record.argv],
      pid: record.pid,
      pgid: record.pgid,
      incident: record.incident,
    },
    { indent: 2 },
  );
}

/**
 * `type(raw).__name__` for the shapes `json.loads` can return that are not an
 * object. Only reached by the "must be an object" message.
 */
function pyTypeWord(value: unknown): string {
  if (value === null) {
    return "NoneType";
  }
  if (Array.isArray(value)) {
    return "list";
  }
  if (typeof value === "string") {
    return "str";
  }
  if (typeof value === "boolean") {
    return "bool";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "float";
  }
  return typeof value;
}

/**
 * `_SessionRecord.from_json(text)`.
 *
 * Every field is checked here rather than trusted, because a record that
 * decodes but carries the wrong types would not fail until the field is *used*
 * -- a `generation` of `null` blowing up inside a path format, say -- which is
 * a crash where the broken-record readout should have been.
 *
 * **The order of the checks is observable.** `generation` and `incident` are
 * validated *before* any string or list field, so a record missing
 * `session_id` and carrying `"generation": null` reports the generation error.
 *
 * Three rule-9 notes on `int`, all unreachable from the ported suite and all
 * recorded rather than left to be found:
 *
 * - CPython's `isinstance(True, int)` is `True`, so `"pid": true` parses there
 *   and becomes the pid `1`. Here it is refused, because `os.kill(1, ...)` is
 *   init and a record is attacker-shaped input in the planted-record cases.
 * - CPython refuses `"pid": 3.0` (a `float` is not an `int`); `JSON.parse`
 *   collapses `3.0` to the number `3` before this function can see the
 *   spelling, so it is accepted.
 * - CPython *accepts* `"pid": 0` and `"pid": -1`, because they are `int`s and
 *   nothing downstream of it refuses them. This port refuses them, for the
 *   reason spelled out at the check itself: the two values POSIX reads as
 *   "the caller's own group" and "every process the caller may signal" must
 *   not reach a stop ladder, and refusing them at the seam alone would turn a
 *   verb that owes a typed answer into a rejected promise.
 */
function recordFromJson(text: string): SessionRecord {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PyValueError(`a session record must be an object, got ${pyTypeWord(raw)}`);
  }

  const textField = (key: string): string => {
    const value = getOwn(raw, key);
    if (typeof value !== "string" || value === "") {
      throw new PyValueError(
        `record field ${pyRepr(key)} must be a non-empty string, got ${pyRepr(noneOf(value))}`,
      );
    }
    return value;
  };

  const stringsField = (key: string): readonly string[] => {
    const value = getOwn(raw, key);
    if (!Array.isArray(value) || !value.every((part) => typeof part === "string")) {
      throw new PyValueError(
        `record field ${pyRepr(key)} must be a list of strings, got ${pyRepr(noneOf(value))}`,
      );
    }
    return value as readonly string[];
  };

  const optionalIntField = (key: string): number | null => {
    const value = getOwn(raw, key);
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new PyValueError(
        `record field ${pyRepr(key)} must be an integer or null, got ${pyRepr(value)}`,
      );
    }
    // The range check the source does not have, and the one place it can be
    // done. `_optional_int` accepts any `int`, so a record carrying `"pid": 0`
    // is a *well-formed* record to CPython -- and interlock survives that only
    // because `os.kill(0, 0)` and `os.killpg(0, sig)` do not raise: they
    // silently address the caller's OWN process group, so the source answers
    // "yes, that process exists" about itself and, in the stop ladder, would
    // SIGKILL the interpreter running it. This port refuses those pids at the
    // seam instead (`assertPid` / `assertSignallablePgid` in
    // `src/session/runtime.ts`), which is right and stays -- but a refusal at
    // the seam is a THROW, out of a `readState`/`stop`/`resume` that owes its
    // caller a typed `Failure` or a broken-record readout. So the value is
    // stopped here, where the record is already being validated and where the
    // answer the contract wants -- a broken record, classified exactly as every
    // other type-invalid field is -- is one `PyValueError` away.
    //
    // `record.pgid || record.pid` is what makes a recorded `0` quiet rather
    // than loud: the falsy fallback swallows it into the pid before any seam
    // sees it, so a `0` pgid would never have reached `assertSignallablePgid`
    // at all.
    if (value < 1) {
      throw new PyValueError(
        `record field ${pyRepr(key)} must be a positive integer or null, got ${pyRepr(value)}`,
      );
    }
    return value;
  };

  const generation = getOwn(raw, "generation");
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
    throw new PyValueError(
      `record field 'generation' must be a non-negative integer, got ${pyRepr(noneOf(generation))}`,
    );
  }
  const incident = getOwn(raw, "incident");
  if (incident !== undefined && incident !== null && typeof incident !== "string") {
    throw new PyValueError(
      `record field 'incident' must be a string or null, got ${pyRepr(incident)}`,
    );
  }
  // The construction order below is the source's keyword-argument order, and it
  // decides which error a record breaking several rules at once reports.
  return {
    session_id: textField("session_id"),
    claude_session_uuid: textField("claude_session_uuid"),
    workspace: textField("workspace"),
    role: textField("role"),
    resume_prompt: textField("resume_prompt"),
    cli_args: stringsField("cli_args"),
    generation,
    argv: stringsField("argv"),
    pid: optionalIntField("pid"),
    pgid: optionalIntField("pgid"),
    incident: incident === undefined ? null : incident,
  };
}

/**
 * One session as this provider currently holds it.
 *
 * {@link Supervised.child} is the child *this* provider instance spawned, or
 * `null` for a session known only through its durable record -- an orphan of an
 * earlier supervisor life, observed through the record's pid and the files the
 * child writes.
 *
 * `record` is mutable because `#recordIncident` reassigns it in place, which is
 * what makes the impound hold in memory even when the durable write fails.
 */
interface Supervised {
  record: SessionRecord;
  readonly child: ChildHandle | null;
  readonly providerDetail: Readonly<Record<string, unknown>>;
}

/**
 * A session whose durable record exists but cannot be read.
 *
 * Not "no session" (a record is right there) and not a readable one either. The
 * verbs split on it the same way they split on {@link Uninterpretable}: the
 * reading verbs report the session as explicitly unobservable with this reason
 * (R4 -- it must not vanish from the roster), and the acting verbs refuse,
 * because signalling or resuming a child whose identity cannot be read is
 * acting on a guess.
 */
interface BrokenRecord {
  readonly kind: "broken-record";
  readonly sessionId: string;
  readonly reason: string;
}

/**
 * A session whose own output could not be read as a readout.
 *
 * Not a {@link SessionReadout} and not a {@link Failure}, because which of the
 * two it becomes depends on the verb: `readState` owes the caller a loud typed
 * failure, while `listSessions` owes a roster in which this session still
 * appears -- as explicitly unobservable, with this reason -- rather than a
 * roster that failed wholesale because one child wrote garbage.
 *
 * A tagged interface rather than a class because the two are only ever
 * discriminated, never constructed by a caller; the tag is what
 * `isinstance(outcome, _Uninterpretable)` reads.
 */
interface Uninterpretable {
  readonly kind: "uninterpretable";
  /**
   * The {@link FailureKind} the verbs that owe a typed failure must raise.
   *
   * Carried on the value rather than chosen at each conversion site, because
   * the *reason* is known where the outcome is built and nowhere else: by the
   * time `readState` or `#spawn` turns one of these into a `Failure`, all it
   * has left is prose. Every site that used to hard-code
   * `UNINTERPRETABLE_RESPONSE` now reads this instead, so an identity incident
   * keeps its narrower kind through whichever verb happens to observe it
   * first (continuo D-0047).
   */
  readonly failureKind: FailureKind;
  readonly detail: string;
  readonly providerDetail: Readonly<Record<string, unknown>>;
}

function isUninterpretable(value: unknown): value is Uninterpretable {
  return (value as Uninterpretable | null)?.kind === "uninterpretable";
}

function isBrokenRecord(value: unknown): value is BrokenRecord {
  return (value as BrokenRecord | null)?.kind === "broken-record";
}

/** `_Uninterpretable(detail, provider_detail)`. */
function uninterpretable(
  detail: string,
  providerDetail: Readonly<Record<string, unknown>> = {},
): Uninterpretable {
  return {
    kind: "uninterpretable",
    failureKind: FailureKind.UNINTERPRETABLE_RESPONSE,
    detail,
    providerDetail,
  };
}

/**
 * The same value, carrying the identity-incident kind instead.
 *
 * Two call sites and one prefix between them: the branch that *detects* a
 * disagreeing identity and the branch that answers from the persisted
 * incident. They exist as one helper so the two cannot drift into different
 * kinds -- which is the whole point, since which of them runs is a race
 * against the child (continuo D-0047).
 */
function identityIncident(
  detail: string,
  providerDetail: Readonly<Record<string, unknown>> = {},
): Uninterpretable {
  return {
    kind: "uninterpretable",
    failureKind: FailureKind.IDENTITY_INCIDENT,
    detail,
    providerDetail,
  };
}

/** The complete stream-json lines a child has written, and the last bad one. */
interface ParsedEvents {
  readonly events: readonly Record<string, unknown>[];
  readonly garbage: string | null;
}

/** The three values `#readSettings` resolves, or the refusal it issues instead. */
interface ResolvedSettings {
  readonly prompt: string;
  readonly resumePrompt: string;
  readonly cliArgs: readonly string[];
}

/** Constructor options, which are keyword-only in the source. */
export interface ClaudeCliSessionProviderOptions {
  /**
   * The CLI to run -- a single executable name or path, or a full command
   * prefix, so a test can supply `[execPath, fakeCli]` without pretending a
   * script is directly executable on every platform.
   */
  readonly claudeCommand?: string | readonly string[] | undefined;
  /**
   * Arguments appended to **every** spawn this provider makes, before the
   * per-session {@link CLI_ARGS_SETTING}. The seam for provider-wide choices (a
   * pinned `--model`, say) that are not per-role configuration.
   */
  readonly baseCliArgs?: readonly string[] | undefined;
  /**
   * Seconds `stop` waits after a terminate before escalating to a kill.
   *
   * **Seconds, not milliseconds**, because the source's `stop_timeout: float =
   * 5.0` is seconds and the value is interpolated into three refusal messages
   * that say `s`. The seam takes milliseconds and the conversion lives in the
   * constructor.
   */
  readonly stopTimeout?: number | undefined;
  /**
   * Seconds each capability-probe subprocess is given.
   *
   * Its own knob because the two costs are unrelated: a probe is a CLI
   * answering `--version`, whose slowness says nothing about how long a
   * terminated child should be given to die.
   */
  readonly probeTimeout?: number | undefined;
}

// --------------------------------------------------------------------------
// The provider
// --------------------------------------------------------------------------

/**
 * The five verbs and the capability probe, over `claude -p` children.
 *
 * @param stateRoot directory for the per-session durable records and captured
 * output. Required and never defaulted, exactly as for the stub: two providers
 * silently sharing a directory would adopt each other's children.
 */
export class ClaudeCliSessionProvider extends SessionProvider {
  /**
   * Resolved for the same reason the stub resolves it: children run with their
   * workspace as cwd, and a relative state root would name a different
   * directory to every reader.
   */
  readonly #stateRoot: string;

  readonly #command: readonly string[];

  readonly #baseCliArgs: readonly string[];

  readonly #stopTimeoutSeconds: number;

  readonly #stopTimeoutMs: number;

  readonly #probeTimeoutSeconds: number;

  readonly #probeTimeoutMs: number;

  /**
   * `self._sessions: dict[str, _Supervised]`.
   *
   * A `Map` and not an object literal, for two reasons the source gets from
   * `dict` for free. Rule 9's third family: the key is a caller-chosen session
   * id, so an id of `constructor` would read as an existing session on an
   * object literal and be refused as a duplicate before anything spawned. And
   * the **insertion order is observable** -- it is the leading segment of every
   * roster `listSessions` returns -- where an object literal hoists
   * integer-like keys such as `10` to the front.
   */
  readonly #sessions = new Map<string, Supervised>();

  /**
   * D-0301 part 3: the per-instance exclusion queue the five verbs run in.
   *
   * In Python `read_state` **cannot** run while `stop` is mid-ladder -- one
   * thread -- so the source gets mutual exclusion from its language. Without
   * this a `readState` could interleave at any `await` inside `stop` and
   * observe a half-finished ladder: signalled, not yet waited for, the group
   * not yet swept. **Neither `probeCapabilities` nor the observer fan-out is queued, and
   * the reason is not the one it looks like.** Both are synchronous (D-0301
   * part 2), so nothing can interleave *into* them -- but that answers the
   * wrong question. The hazard a synchronous probe carries is the opposite
   * one: `start` runs the gate *before* entering this queue, so a `start`
   * issued while a `stop` is mid-ladder blocks the event loop for up to the
   * probe timeout, delaying both the ladder's own timer and the child's
   * `'exit'` event. A child that exited during that window is not observed
   * until the loop turns again, so the stop can spend its deadline and
   * escalate to SIGKILL for a child that was already gone -- an outcome the
   * source cannot produce, because there `stop` simply finishes before `start`
   * begins.
   *
   * It is left this way deliberately, because the obvious repair is worse.
   * Queueing the gate means `start` can no longer refuse on the calling turn,
   * and that synchronous refusal is parity: Python raises `SpawnRefused` out
   * of `start` itself, and the ported case
   * `test_an_unusable_interpreter_fails_the_probe_and_refuses_the_spawn` pins
   * it through `expectRefusal`, a synchronous helper. So D-0301's part 2 and
   * part 3 meet here and cannot both be satisfied; part 2 and the source win,
   * and this paragraph is the residual rather than a claim there is none.
   *
   * Reaching it needs two verbs called concurrently on one instance, which
   * nothing in this port or its suite does -- and which S1 does not define,
   * the interface being provisional (`PROVISIONAL`) with no concurrency
   * contract of its own. If one is ever settled, this is the first place it
   * lands.
   */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(stateRoot: string, options: ClaudeCliSessionProviderOptions = {}) {
    super();
    this.#stateRoot = pyResolve(stateRoot);
    const claudeCommand = options.claudeCommand ?? "claude";
    if (typeof claudeCommand === "string") {
      // The emptiness check below fires only on the sequence branch, as the
      // source's does: `claudeCommand: ""` becomes a one-element command and is
      // accepted at construction, failing later at the probe.
      this.#command = [claudeCommand];
    } else {
      this.#command = [...claudeCommand].map((part) => pyStr(part));
      if (this.#command.length === 0) {
        throw new PyValueError("claude_command must name at least one argument");
      }
    }
    this.#baseCliArgs = [...(options.baseCliArgs ?? [])].map((part) => pyStr(part));
    for (const part of this.#baseCliArgs) {
      const owned = matchesOwnedFlag(part);
      if (owned !== null) {
        // Programmer error, so it raises at construction rather than surfacing
        // per-spawn: a provider-wide argument overriding the committed identity
        // or the structured readout is never a per-session condition to report.
        throw new PyValueError(
          `base_cli_args carries ${pyRepr(owned)}, which this provider ` +
            "renders itself; provider-wide arguments must not override " +
            "the committed identity or the structured readout",
        );
      }
    }
    this.#stopTimeoutSeconds = options.stopTimeout ?? 5.0;
    this.#stopTimeoutMs = this.#stopTimeoutSeconds * 1000;
    this.#probeTimeoutSeconds = options.probeTimeout ?? 10.0;
    this.#probeTimeoutMs = this.#probeTimeoutSeconds * 1000;
  }

  /**
   * Run `body` after every verb already queued on this instance.
   *
   * Both continuations are the same function on purpose: a verb must run after
   * its predecessor **whether that predecessor settled or threw**, and
   * `queue.then(body)` alone would leave the queue permanently rejected the
   * first time a verb raised.
   */
  #serialise<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(body, body);
    // Stored as a promise that cannot reject, so a failed verb does not carry
    // its rejection into every later one as an unhandled rejection warning.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // -- the capability probe (D-0010) -------------------------------------

  /**
   * Ask the CLI's public surface what it is and which flags it carries.
   *
   * Two invocations, both public and documented: `--version` identifies the
   * build, and `--help` is scanned for the flags each capability is rendered
   * with ({@link CAPABILITY_FLAGS}). There is no `capabilities` subcommand to
   * ask -- `claude capabilities` runs as a *billed model prompt* (i01 2) -- so
   * the help text is the honest surface. The raw version answer is carried in
   * the report's detail so the record D-0010 asks for exists wherever the
   * report goes.
   *
   * Synchronous (D-0301 part 2): `spawnSync` is an exact analogue of the
   * source's `subprocess.run(..., timeout=)` on both branches this function
   * distinguishes.
   */
  probeCapabilities(): ProviderResult<CapabilityReport> {
    const versionRun = this.#runProbe("--version");
    if (versionRun instanceof Failure) {
      return versionRun;
    }
    // Stripped, where the help text below deliberately is not. The asymmetry is
    // the source's: a version is a word, and the help text is a document whose
    // trailing newline is part of the evidence written to disk.
    const version = pyStrip(versionRun.stdout.toString("utf8"));
    if (version === "") {
      return new Failure(
        FailureKind.UNINTERPRETABLE_RESPONSE,
        `${pyRepr(this.#command[0])} answered the version probe with nothing`,
      );
    }

    const helpRun = this.#runProbe("--help");
    if (helpRun instanceof Failure) {
      return helpRun;
    }
    const helpText = helpRun.stdout.toString("utf8");

    // `set(REQUIRED_CAPABILITIES) - set(_CAPABILITY_FLAGS)`: the three verbs C2
    // renders through Interlock's own supervision are supported the moment the
    // CLI answered both probes at all.
    const supported = new Set<string>();
    for (const capability of REQUIRED_CAPABILITIES) {
      if (!CAPABILITY_FLAGS.has(capability)) {
        supported.add(capability);
      }
    }
    // A plain object, whose insertion order `pyRepr` preserves, because the
    // rendering of this map is what lands in the detail. Every key is a
    // capability name, none of which is integer-like.
    const missingFlags: Record<string, string[]> = {};
    let anyMissing = false;
    for (const [capability, flags] of CAPABILITY_FLAGS) {
      // A plain substring test over the whole help text, never tokenised --
      // `flag not in help_text` is what the source asks, and a tokeniser would
      // answer a different question about a document whose layout is the CLI's.
      const absent = flags.filter((flag) => !helpText.includes(flag));
      if (absent.length > 0) {
        missingFlags[capability] = absent;
        anyMissing = true;
      } else {
        supported.add(capability);
      }
    }
    // Written **after** the capability computation and **before** the report,
    // as the source orders it: the pointer this returns is interpolated below.
    const evidence = this.#recordProbeEvidence(version, helpText);
    return new Ok(
      new CapabilityReport({
        providerVersion: version,
        supported,
        detail:
          `version probe answered ${pyRepr(version)}; help text ` +
          `${anyMissing ? `is missing ${pyRepr(missingFlags)}` : "carries every required flag"}` +
          `; raw probe output ${evidence}` +
          `; written against ${CLI_VERSION_WRITTEN_AGAINST}`,
      }),
    );
  }

  /**
   * Keep the probe's raw answers, per D-0010's record requirement.
   *
   * The `--help` text is pages long, so the report's `detail` carries a pointer
   * rather than the pages; the file under the state root is the durable record.
   * Failing to write it degrades the record, not the probe -- and says so in
   * the pointer instead of silently pointing at nothing.
   */
  #recordProbeEvidence(version: string, helpText: string): string {
    const path = join(this.#stateRoot, "probe-evidence.txt");
    try {
      mkdirSync(this.#stateRoot, { recursive: true });
      // `writeAtomic` is `path.with_suffix(".part")` then `os.replace`, so the
      // partial here is `probe-evidence.part` and **not**
      // `probe-evidence.txt.part`. It shares that seam member with the record
      // write, which is why the two ported cases that substitute the member
      // have to discriminate on the basename.
      sessionRuntime.writeAtomic(
        path,
        `$ ${this.#command.join(" ")} --version\n${version}\n\n` +
          `$ ${this.#command.join(" ")} --help\n${helpText}`,
      );
    } catch (exc) {
      return `could not be recorded at ${path}: ${errorText(exc)}`;
    }
    return `recorded at ${path}`;
  }

  /** `subprocess.run([*command, flag], capture_output=True, timeout=, check=False)`. */
  #runProbe(flag: string): ProbeResult | Failure {
    // Only `command[0]` is named in every one of these messages, and it is
    // `repr`'d -- the rest of a command prefix is not the thing that could not
    // be executed.
    const name = pyRepr(this.#command[0]);
    let completed: ProbeResult;
    try {
      completed = sessionRuntime.runProbe([...this.#command, flag], this.#probeTimeoutMs);
    } catch (exc) {
      if (exc instanceof ChildTimeout) {
        return new Failure(
          FailureKind.TIMED_OUT,
          `${name} did not answer ${flag} within ${secondsText(this.#probeTimeoutSeconds)}s`,
        );
      }
      if (isSystemError(exc)) {
        return new Failure(
          FailureKind.BACKEND_UNREACHABLE,
          `${name} could not be executed: ${errorText(exc)}`,
          { errno: errnoOf(exc) },
        );
      }
      // The source has no third branch and would let such an exception out of
      // the probe, so this one does too: swallowing it would turn a defect in
      // the seam into a `Failure` a caller is invited to retry.
      throw exc;
    }
    if (completed.status !== 0) {
      return new Failure(
        FailureKind.BACKEND_UNREACHABLE,
        `${name} exited ${String(completed.status)} for ${flag}`,
        { stderr: completed.stderr.toString("utf8") },
      );
    }
    return completed;
  }

  // -- the five verbs (D-0009) -------------------------------------------

  /**
   * Spawn one `claude -p` child. Called by `start` after the gate.
   *
   * The identity is derived and durably recorded **before** the spawn
   * ({@link claudeSessionUuid}, {@link SessionRecord}), and read back from the
   * child's own structured output afterwards -- never inferred from the exit
   * code.
   *
   * The CLI's own `Session ID ... is already in use` refusal, when it happens,
   * arrives on the child's stderr with exit 1 and is carried verbatim in the
   * readout. **It is never relied on as a lock**: U27 measured a multi-second
   * admission window inside which two claimants of one id were both admitted,
   * and U38 shows the claim itself is a transcript-file existence check.
   * Exclusion, where it exists, is the fencing token issued a layer above --
   * this code is written to be correct with the CLI's refusal assumed absent.
   */
  protected _startSession(request: StartRequest): Promise<ProviderResult<SessionReadout>> {
    return this.#serialise(() => this.#startOneSession(request));
  }

  /**
   * The body of `_startSession`, inside the queue.
   *
   * The order of the steps is the source's and several ported cases assert it:
   * id shape, id reuse (memory then disk), settings, workspace resolve and
   * create, identity derivation, the identity-holder scan, the record, the
   * spawn.
   */
  async #startOneSession(request: StartRequest): Promise<ProviderResult<SessionReadout>> {
    const sessionId = request.sessionId;
    if (!isOnePathComponent(sessionId)) {
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `session id ${pyRepr(sessionId)} is not usable as a single ` +
          "path component; this provider names a state directory after " +
          "the session and will not let an id reach outside its state root",
      );
    }
    // The in-memory table first, then the disk, as the source short-circuits
    // them. `existsSync` is `Path.exists()`: it follows symlinks and answers
    // true for a `record.json` that is a directory, which is deliberate -- such
    // a record is broken, and a broken record still holds its id.
    if (this.#sessions.has(sessionId) || existsSync(this.#recordPath(sessionId))) {
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `session ${pyRepr(sessionId)} already exists in this ` +
          "provider's state root; this provider does not reuse a " +
          "session id",
      );
    }

    const settings = this.#readSettings(request);
    if (settings instanceof Failure) {
      return settings;
    }

    let workspace: string;
    let workspaceExists: boolean;
    try {
      // Resolved before it is recorded: the record outlives this process, and a
      // relative path in it would name a different directory to every future
      // supervisor's working directory.
      workspace = pyResolve(request.workspace);
      workspaceExists = isDirectory(workspace);
    } catch (exc) {
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `the workspace configured for session ${pyRepr(sessionId)} ` +
          `is not a usable path: ${errorText(exc)}`,
      );
    }
    if (!workspaceExists) {
      const refusal = this.#createWorkspace(request, workspace);
      if (refusal !== null) {
        return refusal;
      }
    }

    const sessionUuid = claudeSessionUuid(sessionId);
    // After the workspace has possibly been created, as the source orders it: a
    // refused identity clash therefore still leaves a freshly created workspace
    // directory behind, and that is the observable ordering rather than an
    // accident of it.
    const holder = this.#holderOfUuid(sessionUuid);
    if (holder !== null && holder !== sessionId) {
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `session id ${pyRepr(sessionId)} derives provider identity ` +
          `${sessionUuid}, which session ${pyRepr(holder)} already holds; two ` +
          "sessions must not share one identity",
      );
    }
    const record: SessionRecord = {
      session_id: sessionId,
      claude_session_uuid: sessionUuid,
      workspace,
      role: request.role,
      resume_prompt: settings.resumePrompt,
      cli_args: settings.cliArgs,
      generation: 0,
      // The start argv, in the one order that matters: the provider's own flags
      // first, then the provider-wide arguments, then the per-role ones, so
      // neither of the last two can precede -- and so override -- the committed
      // identity. The **start** prompt is not persisted anywhere else: only
      // `resume_prompt` is a record field, so the prompt survives solely inside
      // this argv.
      argv: [
        ...this.#command,
        "-p",
        settings.prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--session-id",
        sessionUuid,
        ...this.#baseCliArgs,
        ...settings.cliArgs,
      ],
      pid: null,
      pgid: null,
      incident: null,
    };
    return await this.#spawn(record, true);
  }

  /**
   * Every session this provider supervises or holds a durable record of.
   *
   * Includes orphans: a record written by an earlier supervisor life names a
   * session this instance never spawned, and leaving it off the roster would
   * make the one copy of the truth about it invisible exactly when it matters
   * (i01 3.6: the CLI itself lists nothing). A session whose own output cannot
   * be interpreted appears as explicitly unobservable with the reason -- one
   * broken child must not fail the whole roster, and must not vanish from it
   * either (R4).
   */
  listSessions(): Promise<ProviderResult<readonly SessionReadout[]>> {
    return this.#serialise(async () => {
      let discovered: (Supervised | BrokenRecord)[];
      try {
        discovered = this.#discoverRecords();
      } catch (exc) {
        return new Failure(
          FailureKind.BACKEND_UNREACHABLE,
          `the state root ${this.#stateRoot} could not be read: ${errorText(exc)}`,
          { errno: errnoOf(exc) },
        );
      }
      const readouts: SessionReadout[] = [];
      for (const session of discovered) {
        if (isBrokenRecord(session)) {
          // No `providerDetail` here, as the source passes none: a record that
          // could not be read carries nothing to describe it with.
          readouts.push(
            new SessionReadout({
              sessionId: session.sessionId,
              observation: Observation.COULD_NOT_OBSERVE,
              couldNotObserveReason: session.reason,
            }),
          );
          continue;
        }
        const outcome = await this.#readout(session);
        if (isUninterpretable(outcome)) {
          // The key asymmetry with `readState`, and it is deliberate: an
          // uninterpretable child does not fail the roster.
          readouts.push(
            new SessionReadout({
              sessionId: session.record.session_id,
              observation: Observation.COULD_NOT_OBSERVE,
              couldNotObserveReason: outcome.detail,
              providerDetail: outcome.providerDetail,
            }),
          );
        } else {
          readouts.push(outcome);
        }
      }
      return new Ok(readouts);
    });
  }

  /**
   * The session's state from its own structured output, or a loud failure.
   *
   * Tolerant of what it can be (unknown event types, unknown fields, events
   * that have not arrived yet) and loud about what it cannot: a complete line
   * that is not JSON, an init event that names no identity, or an identity that
   * disagrees with the one committed before the spawn all come back as typed
   * failures with the evidence attached, never as an empty or invented readout
   * (R4).
   */
  readState(sessionId: string): Promise<ProviderResult<SessionReadout>> {
    return this.#serialise(async () => {
      const session = this.#find(sessionId);
      if (session === null) {
        return new Failure(FailureKind.UNKNOWN_SESSION, unknownSessionDetail(sessionId));
      }
      if (isBrokenRecord(session)) {
        // The session exists -- its record is right there -- but cannot be
        // read, which per S1 is a readout of "could not observe" with the
        // reason, not a failed call (R4). Note it names the *argument*, not the
        // record's own idea of which session it is.
        return new Ok(
          new SessionReadout({
            sessionId,
            observation: Observation.COULD_NOT_OBSERVE,
            couldNotObserveReason: session.reason,
          }),
        );
      }
      const outcome = await this.#readout(session);
      if (isUninterpretable(outcome)) {
        return new Failure(outcome.failureKind, outcome.detail, outcome.providerDetail);
      }
      return new Ok(outcome);
    });
  }

  /**
   * Signal the child's process group, confirm the exit, then report.
   *
   * The whole group (i01 3.5): the CLI leaves MCP-server children of its own
   * unreaped, and a pid-targeted signal would orphan them. The readout is taken
   * after the exit is confirmed rather than assumed from the signal, and
   * everything the session left behind -- its record, its captured output --
   * stays on disk under the state root as the disposition of the stop.
   */
  stop(sessionId: string): Promise<ProviderResult<SessionReadout>> {
    return this.#serialise(async () => {
      const session = this.#find(sessionId);
      if (session === null) {
        return new Failure(FailureKind.UNKNOWN_SESSION, unknownSessionDetail(sessionId));
      }
      if (isBrokenRecord(session)) {
        return new Failure(
          FailureKind.REFUSED_BY_PROVIDER,
          `refusing to stop session ${pyRepr(sessionId)}: ${session.reason} ` +
            "-- without a readable record there is no pid or process " +
            "group this provider can be sure is the session's to signal",
        );
      }
      const refusal = await this.#terminate(session);
      if (refusal !== null) {
        return refusal;
      }
      const outcome = await this.#readout(session);
      if (isUninterpretable(outcome)) {
        return new Failure(outcome.failureKind, outcome.detail, outcome.providerDetail);
      }
      return new Ok(outcome);
    });
  }

  /**
   * Re-enter one session: adopt its live child, or spawn `--resume`.
   *
   * **Identity read-back and refusal only.** `--resume` is unguarded -- U32
   * admitted two concurrent resumes of one session, simultaneously and
   * staggered -- so nothing here can make re-entry exclusive and nothing here
   * pretends to: the single-writer property comes from the lease this module
   * deliberately cannot import (D-0009), orchestrated *around* this call.
   *
   * The reclaim order is the one issue `#17` fixes, because inverting it
   * creates the second live writer U32 will not refuse:
   *
   * 1. **Resolve the surviving process first.** A recorded child that is still
   *    alive -- confirmed as ours by its command line carrying this session's
   *    UUID, so a recycled pid is never trusted (i02 3.3) -- is *adopted*, not
   *    resumed around and not restarted.
   * 2. A recorded child that is gone has its exit **confirmed** before anything
   *    else happens.
   * 3. Only then is `--resume` spawned. Never a fresh `--session-id` claim: U28
   *    shows the dead session still holds the claim, the re-claim is refused,
   *    and a supervisor that read that refusal as fatal would fail to recover
   *    its own worker.
   */
  resume(sessionId: string): Promise<ProviderResult<SessionReadout>> {
    return this.#serialise(async () => {
      const session = this.#find(sessionId);
      if (session === null) {
        return new Failure(FailureKind.UNKNOWN_SESSION, unknownSessionDetail(sessionId));
      }
      if (isBrokenRecord(session)) {
        return new Failure(
          FailureKind.REFUSED_BY_PROVIDER,
          `refusing to resume session ${pyRepr(sessionId)}: ${session.reason} ` +
            "-- without a readable record neither the surviving process " +
            "nor the identity to resume can be resolved, and resuming on " +
            "a guess is how a second live writer is minted (U32)",
        );
      }
      if (session.record.incident !== null) {
        return new Failure(
          FailureKind.IDENTITY_INCIDENT,
          `identity incident: ${session.record.incident}`,
          { session_id: sessionId, expected: session.record.claude_session_uuid },
        );
      }

      const liveness = await this.#childLiveness(session);
      if (liveness instanceof Failure) {
        return liveness;
      }
      if (liveness) {
        // Step 1: the surviving process, adopted. `#find` already put an
        // orphan's record into the table; a live child of our own is simply
        // still ours. Either way the session is re-entered by reading it, not
        // by spawning a second writer next to it.
        const adopted = await this.#readout(session);
        if (isUninterpretable(adopted)) {
          return new Failure(adopted.failureKind, adopted.detail, adopted.providerDetail);
        }
        return new Ok(adopted);
      }

      // Step 2 is complete here: `#childLiveness` returned false only for an
      // exit it confirmed. The finished generation is now reconciled *before* a
      // new one may bury it -- a child that reported the wrong identity and
      // then exited would otherwise be resumed straight past the incident, with
      // the evidence abandoned in the previous generation's file. Note that
      // this message wraps `detail` in a prefix, where every other
      // uninterpretable site passes it bare.
      const finished = await this.#readout(session);
      if (isUninterpretable(finished)) {
        return new Failure(
          // The prefix is this site's own, but the kind stays the readout's:
          // a finished generation that contradicted the committed identity is
          // an identity incident whether the caller reaches it through
          // `readState` or through the resume that refuses to bury it.
          finished.failureKind,
          `refusing to resume session ${pyRepr(sessionId)}: its finished ` +
            `generation cannot be reconciled first -- ${finished.detail}`,
          finished.providerDetail,
        );
      }
      try {
        // `resume` is not wrapped by the base class's gate -- only `start` is --
        // so it asks for itself, and only on the path that actually spawns. The
        // adoption path above never probes.
        this.requireSpawnable();
      } catch (exc) {
        if (!(exc instanceof SpawnRefused)) {
          throw exc;
        }
        return new Failure(
          FailureKind.INCOMPATIBLE_PROVIDER,
          `resuming ${pyRepr(sessionId)} would spawn a child, and the spawn ` +
            `precondition refused it (D-0010): ${exc.message}`,
        );
      }
      const record: SessionRecord = {
        ...session.record,
        generation: session.record.generation + 1,
        // The resume argv, and `--session-id` is deliberately absent from it.
        argv: [
          ...this.#command,
          "--resume",
          session.record.claude_session_uuid,
          "-p",
          session.record.resume_prompt,
          "--output-format",
          "stream-json",
          "--verbose",
          ...this.#baseCliArgs,
          ...session.record.cli_args,
        ],
        pid: null,
        pgid: null,
      };
      return await this.#spawn(record, false);
    });
  }

  // -- spawning and its record -------------------------------------------

  /**
   * Commit the record, start the child, read the identity back later.
   *
   * Shared by the start and resume paths so that both write the durable record
   * *before* the process exists. What this module guarantees is the mechanical
   * order of its own writes: mkdir, record with no pid, open the two capture
   * files, spawn, record with the pid, register, read out.
   *
   * `fresh` distinguishes a start from a resume in exactly two places, both of
   * them removals: a start that could not spawn, or could not record its
   * child's pid, takes its own directory back down, because a session that
   * never had a process is not a session and a half-written record would refuse
   * the id forever while showing a phantom orphan. A resume keeps the
   * directory, because the previous generation's evidence is in it.
   */
  async #spawn(record: SessionRecord, fresh: boolean): Promise<ProviderResult<SessionReadout>> {
    const sessionId = record.session_id;
    const directory = this.#sessionDir(sessionId);
    try {
      mkdirSync(directory, { recursive: true });
      this.#writeRecord(record);
    } catch (exc) {
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `the state for session ${pyRepr(sessionId)} could not be ` +
          `prepared under ${this.#stateRoot}: ${errorText(exc)}`,
        { errno: errnoOf(exc) },
      );
    }

    const eventsPath = this.#eventsPath(sessionId, record.generation);
    const stderrPath = this.#stderrPath(sessionId, record.generation);
    // `dict(os.environ)` plus the marker. Node's `env` *replaces* the child's
    // environment rather than extending it, so the copy is what keeps the child
    // in the same world as its parent -- and the copying itself is under test,
    // because every scenario switch the fake CLI reads travels this way.
    const environment: NodeJS.ProcessEnv = { ...process.env };
    environment[CHILD_ENV_SESSION_UUID] = record.claude_session_uuid;

    let eventsFd: number | undefined;
    let stderrFd: number | undefined;
    let child: ChildHandle | undefined;
    let spawnFailure: unknown;
    try {
      // `open(path, "wb")` -- truncating. Each generation gets its own pair, so
      // in practice nothing is ever truncated.
      eventsFd = openSync(eventsPath, "w");
      stderrFd = openSync(stderrPath, "w");
      child = await sessionRuntime.spawn([...record.argv], {
        cwd: record.workspace,
        env: environment,
        stdin: "ignore",
        stdout: eventsFd,
        stderr: stderrFd,
        newProcessGroup: true,
      });
    } catch (exc) {
      spawnFailure = exc;
    } finally {
      // Closed here, before anything else looks at the directory, and that
      // ordering is the Windows half of the failure path: `#removeSessionDir`
      // below unlinks these two files, and Windows refuses to unlink a file
      // this process still holds open. The `with open(...)` block the source
      // writes closes them at the same point, for the plainer reason that its
      // block ends there.
      if (eventsFd !== undefined) {
        closeSync(eventsFd);
      }
      if (stderrFd !== undefined) {
        closeSync(stderrFd);
      }
    }
    if (child === undefined) {
      // Node reports a failed spawn on a later turn, where Python's `Popen`
      // raises `OSError` from the constructor; the seam folds the two turns
      // back into one settled outcome, so this branch covers both an `open`
      // that failed and a spawn that did.
      const failure = new Failure(
        FailureKind.BACKEND_UNREACHABLE,
        `could not spawn a child for session ${pyRepr(sessionId)}: ${errorText(spawnFailure)}`,
        { argv: [...record.argv], errno: errnoOf(spawnFailure) },
      );
      if (fresh) {
        this.#removeSessionDir(sessionId);
      }
      return failure;
    }

    // The pgid is derived by construction and never asked of the operating
    // system, which could only race the child's exit: `newProcessGroup` is
    // `setsid`, so the child leads its own group and its pgid is its pid.
    const recorded: SessionRecord = {
      ...record,
      pid: child.pid,
      pgid: sessionRuntime.isPosix() ? child.pid : null,
    };
    try {
      this.#writeRecord(recorded);
    } catch (exc) {
      // A running child whose pid never reached the durable record is a child
      // the next supervisor life cannot adopt, cannot signal, and -- reading
      // the pid-less record as "gone" -- would resume around, minting the
      // second live writer. So it is killed rather than left running.
      //
      // SIGKILL, to the whole group, and immediately: there is no SIGTERM grace
      // here as there is in the stop ladder, because there is no one left to
      // report a graceful exit to.
      if (sessionRuntime.isPosix()) {
        sessionRuntime.signalGroup(child.pid, "SIGKILL");
      } else {
        sessionRuntime.signalChild(child, "SIGKILL");
      }
      try {
        await sessionRuntime.waitForExit(child, this.#stopTimeoutMs);
      } catch (waitExc) {
        if (!(waitExc instanceof ChildTimeout)) {
          throw waitExc;
        }
        // The state directory is **kept even when fresh** here, so the id stays
        // reserved, and the session is registered so this instance can still
        // reach the child whose pid it could not record.
        this.#sessions.set(sessionId, {
          record: recorded,
          child,
          providerDetail: {
            pid: child.pid,
            generation: recorded.generation,
            record_update_failed: errorText(exc),
          },
        });
        return new Failure(
          FailureKind.TIMED_OUT,
          `the pid of session ${pyRepr(sessionId)}'s child could ` +
            `not be durably recorded (${errorText(exc)}), and the child (pid ` +
            `${String(child.pid)}) survived ${secondsText(this.#stopTimeoutSeconds)}s past the ` +
            "SIGKILL; it stays under this instance's in-memory " +
            "supervision, but the durable record carries no pid",
          { errno: errnoOf(exc), pid: child.pid },
        );
      }
      if (fresh) {
        this.#removeSessionDir(sessionId);
      }
      // Nothing is registered in the table on this branch: the child is gone
      // and, when fresh, so is its directory.
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `the pid of session ${pyRepr(sessionId)}'s child could not ` +
          `be durably recorded (${errorText(exc)}); the child was terminated ` +
          "rather than left running unadoptably",
        { errno: errnoOf(exc), pid: child.pid },
      );
    }

    const session: Supervised = {
      record: recorded,
      child,
      providerDetail: { pid: child.pid, generation: recorded.generation },
    };
    this.#sessions.set(sessionId, session);
    // Taken immediately, so the ordinary answer is a could-not-observe with a
    // reason: the child has almost certainly written nothing yet.
    const outcome = await this.#readout(session);
    if (isUninterpretable(outcome)) {
      return new Failure(outcome.failureKind, outcome.detail, outcome.providerDetail);
    }
    return new Ok(outcome);
  }

  // -- settings and workspace --------------------------------------------

  /**
   * The three settings this provider reads, validated in the source's order.
   *
   * `prompt` then `resume_prompt`, and for each: non-empty string, then NUL,
   * then a leading `-`; **then** `cli_args`, per element NUL then owned flag.
   * The order is observable whenever an input trips more than one rule, and
   * everything here completes before the workspace is resolved -- nothing
   * durable has happened when a refusal is issued.
   *
   * Unknown keys belong to someone else and are ignored: `settings` is opaque
   * per-role configuration in S1, so there is no schema to fail against here.
   */
  #readSettings(request: StartRequest): ResolvedSettings | Failure {
    const sessionId = request.sessionId;
    // `getOwn` rather than a property read, for rule 9's third family:
    // `settings` is caller-supplied, and a plain `settings.prompt` would find
    // an inherited value on an object whose prototype carries one, where a
    // Python `dict` finds nothing.
    // Two calls rather than the source's two-element loop, and the difference
    // is TypeScript's alone: a loop narrows its own `value` and tells the
    // compiler nothing about the two variables it read, so the returned pair
    // would need a cast that asserts exactly what the loop just checked. The
    // *order* is the source's, and it is the observable part -- `prompt` is
    // validated through all three of its checks before `resume_prompt` is
    // looked at.
    const prompt = validatedPrompt(
      sessionId,
      PROMPT_SETTING,
      getOwn(request.settings, PROMPT_SETTING) ?? DEFAULT_PROMPT,
    );
    if (prompt instanceof Failure) {
      return prompt;
    }
    const resumePrompt = validatedPrompt(
      sessionId,
      RESUME_PROMPT_SETTING,
      getOwn(request.settings, RESUME_PROMPT_SETTING) ?? DEFAULT_RESUME_PROMPT,
    );
    if (resumePrompt instanceof Failure) {
      return resumePrompt;
    }

    const rawArgs = getOwn(request.settings, CLI_ARGS_SETTING);
    let cliArgs: readonly string[] = [];
    if (rawArgs === undefined || rawArgs === null) {
      cliArgs = [];
    } else if (Array.isArray(rawArgs)) {
      // `[str(part) for part in raw_args]`: elements are coerced **before** the
      // two checks, so `cli_args: [123]` becomes `"123"` and passes.
      const coerced = (rawArgs as readonly unknown[]).map((part) => pyStr(part));
      for (const [index, part] of coerced.entries()) {
        if (part.includes(NUL)) {
          return new Failure(
            FailureKind.REFUSED_BY_PROVIDER,
            `settings[${pyRepr(CLI_ARGS_SETTING)}][${String(index)}] for session ` +
              `${pyRepr(sessionId)} contains a NUL, which no ` +
              "operating system can carry in an argv",
          );
        }
        const owned = matchesOwnedFlag(part);
        if (owned !== null) {
          return new Failure(
            FailureKind.REFUSED_BY_PROVIDER,
            `settings[${pyRepr(CLI_ARGS_SETTING)}][${String(index)}] for session ` +
              `${pyRepr(sessionId)} carries ${pyRepr(owned)}, which this ` +
              "provider renders itself; per-role arguments must not " +
              "override the committed identity or the structured " +
              "readout",
          );
        }
      }
      cliArgs = coerced;
    } else {
      // A bare string is refused explicitly rather than iterated: iterating one
      // would pass its characters to the CLI as separate arguments.
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `settings[${pyRepr(CLI_ARGS_SETTING)}] for session ` +
          `${pyRepr(sessionId)} must be a list or tuple of arguments, ` +
          `got ${pyRepr(rawArgs)}`,
      );
    }
    return { prompt, resumePrompt, cliArgs };
  }

  /**
   * Announce the workspace transition, and make it unless vetoed.
   *
   * Returns `null` when the workspace is there afterwards, and a
   * {@link Failure} otherwise. Synchronous, because the observer fan-out is
   * (D-0301 part 2).
   */
  #createWorkspace(request: StartRequest, workspace: string): Failure | null {
    const transition = new WorkspaceTransition({
      sessionId: request.sessionId,
      workspace,
      kind: CREATE_WORKSPACE,
      providerDetail: { role: request.role },
    });
    // Asked **before** the directory is made: a veto means nothing was created
    // and nothing was spawned.
    const decision = this.evaluateWorkspaceTransition(transition);
    if (decision.verdict === WorkspaceVerdict.VETO) {
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `creating workspace ${workspace} for session ` +
          `${pyRepr(request.sessionId)} was vetoed: ${decision.reason}`,
        { transition: CREATE_WORKSPACE },
      );
    }
    try {
      mkdirSync(workspace, { recursive: true });
    } catch (exc) {
      if (isSystemError(exc)) {
        return new Failure(
          FailureKind.REFUSED_BY_PROVIDER,
          `workspace ${workspace} could not be created: ${errorText(exc)}`,
          { errno: errnoOf(exc) },
        );
      }
      // The source's `except ValueError`: a path the operating system is never
      // even asked about -- one carrying a NUL, say.
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `the workspace configured for session ${pyRepr(request.sessionId)} ` +
          `is not a usable path: ${errorText(exc)}`,
      );
    }
    return null;
  }

  // -- liveness, termination and the group sweep --------------------------

  /**
   * Is the recorded child alive -- resolved, never guessed.
   *
   * For a child of this instance the answer is `poll()`. For an orphan the
   * recorded pid alone is not evidence -- pids recycle -- so a live pid counts
   * only when its command line still carries this session's UUID. A live pid
   * whose identity cannot be read is a typed failure: on it this provider will
   * neither adopt (it may be a stranger) nor spawn a resume (it may be the
   * session's own writer, and a resume next to a live writer is the U32
   * failure), and it will certainly not signal it.
   *
   * Note the asymmetry with `#orphanChildAlive`: `pidExists` is
   * `os.kill(pid, 0)`, so a **zombie counts as alive here** and as gone there.
   * It is the source's asymmetry and it is observable.
   */
  async #childLiveness(session: Supervised): Promise<boolean | Failure> {
    const child = session.child;
    if (child !== null) {
      // D-0301 part 4: without the macrotask yield a child that exited a moment
      // ago still reads as running.
      await sessionRuntime.settleExits();
      return sessionRuntime.exitStatusOf(child) === null;
    }
    const record = session.record;
    if (record.pid === null) {
      // Recorded before the spawn and never updated: the previous supervisor
      // died inside the one window the record cannot cover. There is no pid to
      // resolve, so the only safe reading is "gone".
      return false;
    }
    if (!sessionRuntime.isPosix()) {
      // No signal-0 probe and no `/proc`: unknowable, and unknowable must fail
      // closed -- reading it as "gone" would let resume spawn next to a
      // possibly-live writer and let stop report success over a running child.
      return new Failure(
        FailureKind.BACKEND_UNREACHABLE,
        `pid ${String(record.pid)} recorded for session ` +
          `${pyRepr(record.session_id)} cannot have its liveness determined ` +
          "on this platform; refusing to adopt, signal or resume " +
          "around it",
        { pid: record.pid },
      );
    }
    if (!sessionRuntime.pidExists(record.pid)) {
      return false;
    }
    const cmdline = sessionRuntime.pidCmdline(record.pid);
    if (cmdline === null) {
      return new Failure(
        FailureKind.BACKEND_UNREACHABLE,
        `pid ${String(record.pid)} recorded for session ` +
          `${pyRepr(record.session_id)} is alive, but its command line could ` +
          "not be read on this platform, so whether it is still that " +
          "session's child is unknowable; refusing to adopt, signal or " +
          "resume around it",
        { pid: record.pid },
      );
    }
    return cmdline.includes(record.claude_session_uuid);
  }

  /**
   * An adopted orphan that is still identifiably ours.
   *
   * `pidRunning` and not `pidExists`, so a **zombie reads as gone** -- the stop
   * loops below wait on this, and waiting for a pid that has already exited but
   * is not yet reaped to disappear waits for an exit that already happened. The
   * `Z` check must stay ahead of the command-line check: a zombie's
   * `/proc/<pid>/cmdline` is zero bytes, which is a successful read of a string
   * carrying no UUID, so the reversed order would read our own exited child as
   * a stranger on a recycled pid.
   */
  #orphanChildAlive(record: SessionRecord): boolean {
    const pid = record.pid;
    if (pid === null) {
      return false;
    }
    if (!sessionRuntime.pidRunning(pid)) {
      return false;
    }
    const cmdline = sessionRuntime.pidCmdline(pid);
    if (cmdline === null) {
      // Spelled as a statement rather than as `cmdline?.includes(...)`, which
      // would answer `undefined` -- and an unreadable command line is a `False`
      // here, not a third value the loops above would then have to interpret.
      return false;
    }
    return cmdline.includes(record.claude_session_uuid);
  }

  /** Stop the child's whole process group and confirm the exit. */
  async #terminate(session: Supervised): Promise<Failure | null> {
    const liveness = await this.#childLiveness(session);
    if (liveness instanceof Failure) {
      // Fail closed, and **nothing is signalled**: an unknowable liveness
      // aborts the stop before the first rung of the ladder.
      return liveness;
    }
    if (!liveness) {
      // The leader's being gone does not end the stop: an MCP child that
      // ignored its parent's death is still running in the group (H1), and
      // reporting done over it would be the supervision promise quietly not
      // kept.
      return await this.#sweepAfterExit(session);
    }
    const record = session.record;
    const child = session.child;
    if (child !== null) {
      // `record.pgid or process.pid` -- a **falsy** fallback, so a recorded
      // pgid of `0` becomes the pid. `??` would keep the `0`, and signalling
      // group 0 is signalling the caller's own process group.
      const target = record.pgid || child.pid;
      if (sessionRuntime.isPosix()) {
        sessionRuntime.signalGroup(target, "SIGTERM");
      } else {
        sessionRuntime.signalChild(child, "SIGTERM");
      }
      try {
        await sessionRuntime.waitForExit(child, this.#stopTimeoutMs);
      } catch (exc) {
        if (!(exc instanceof ChildTimeout)) {
          throw exc;
        }
        if (sessionRuntime.isPosix()) {
          sessionRuntime.signalGroup(target, "SIGKILL");
        } else {
          sessionRuntime.signalChild(child, "SIGKILL");
        }
        try {
          // A **fresh, full** stop timeout, as the source gives it: the worst
          // case before the failure below is two of them, plus the sweep's own.
          await sessionRuntime.waitForExit(child, this.#stopTimeoutMs);
        } catch (killExc) {
          if (!(killExc instanceof ChildTimeout)) {
            throw killExc;
          }
          // A child that survives SIGKILL is stuck in the kernel; reporting the
          // bound loudly beats blocking the caller on a wait that may never
          // return.
          return new Failure(
            FailureKind.TIMED_OUT,
            `the child (pid ${String(child.pid)}) of session ` +
              `${pyRepr(record.session_id)} did not exit within ` +
              `${secondsText(this.#stopTimeoutSeconds)}s of SIGKILL`,
            { pid: child.pid },
          );
        }
      }
      // The leader's exit is not the group's (H1). And because waiting also
      // *reaped* the leader, freeing its pid and pgid for reuse, the sweep is
      // the marker-verified one: an unverified group under a recycled number is
      // never signalled.
      return await this.#sweepAfterExit(session);
    }

    // An adopted orphan is not a child of this process, so there is no wait;
    // the exit is confirmed by the child no longer being *identifiably ours*.
    // Rechecked at every poll and before every escalation, because the pid can
    // be reaped and reused between two looks, and a signal aimed at yesterday's
    // number would land on a stranger.
    const pid = record.pid as number;
    const target = record.pgid || pid;
    sessionRuntime.signalGroup(target, "SIGTERM");
    let deadline = sessionRuntime.monotonicMs() + this.#stopTimeoutMs;
    while (this.#orphanChildAlive(record)) {
      if (sessionRuntime.monotonicMs() >= deadline) {
        // The second re-check narrows the reap-and-recycle race: without it the
        // SIGKILL could be aimed at a number that stopped being ours between
        // the loop's condition and here. It is also why this loop can leave
        // without having sent SIGKILL at all.
        if (this.#orphanChildAlive(record)) {
          sessionRuntime.signalGroup(target, "SIGKILL");
        }
        break;
      }
      await sessionRuntime.sleep(ORPHAN_POLL_MS);
    }
    // Recomputed fresh, a second full timeout, even when the loop above left
    // because the child died -- in which case this loop's condition is false
    // immediately and it costs nothing.
    deadline = sessionRuntime.monotonicMs() + this.#stopTimeoutMs;
    while (this.#orphanChildAlive(record)) {
      if (sessionRuntime.monotonicMs() >= deadline) {
        // "the **recorded** child", where the owned-child path above says "the
        // child". Two different strings in the source; do not unify them.
        return new Failure(
          FailureKind.TIMED_OUT,
          `the recorded child (pid ${String(pid)}) of session ` +
            `${pyRepr(record.session_id)} did not exit within ` +
            `${secondsText(this.#stopTimeoutSeconds)}s of SIGKILL`,
          { pid },
        );
      }
      await sessionRuntime.sleep(ORPHAN_POLL_MS);
    }
    return await this.#sweepAfterExit(session);
  }

  /**
   * The H1 sweep for a leader that is already gone -- proven, then done.
   *
   * Once the leader is reaped its pid, and with it the pgid, is recyclable, so
   * a group under that number is signalled **only when at least one of its live
   * members provably carries this session's environment marker**. A group whose
   * members cannot be verified is left untouched: killing what cannot be proven
   * ours is the worse failure, and on a platform without `/proc` there is
   * nothing to prove with.
   *
   * No SIGTERM here, straight to SIGKILL: the leader is already dead and the
   * survivors are children that already ignored whatever it got.
   */
  async #sweepAfterExit(session: Supervised): Promise<Failure | null> {
    const record = session.record;
    // The same falsy fallback as the ladder's, and it yields `null` only when
    // both fields are absent -- a recorded pgid of `0` with no pid is `null`
    // here exactly as `0 or None` is in the source.
    const pgid = record.pgid || record.pid;
    if (!sessionRuntime.isPosix() || pgid === null) {
      return null;
    }
    // **Bytes**, compared against the raw `/proc/<pid>/environ`, which is
    // NUL-terminated rather than NUL-separated. See the seam for why decoding
    // first and splitting is the wrong shape.
    const marker = Buffer.from(`${CHILD_ENV_SESSION_UUID}=${record.claude_session_uuid}`, "utf8");
    if (!sessionRuntime.groupMemberCarriesMarker(pgid, marker)) {
      return null;
    }
    sessionRuntime.signalGroup(pgid, "SIGKILL");
    const deadline = sessionRuntime.monotonicMs() + this.#stopTimeoutMs;
    while (sessionRuntime.groupMemberCarriesMarker(pgid, marker)) {
      if (sessionRuntime.monotonicMs() >= deadline) {
        return new Failure(
          FailureKind.TIMED_OUT,
          `process group ${String(pgid)} of session ` +
            `${pyRepr(record.session_id)} still has members carrying its ` +
            `marker ${secondsText(this.#stopTimeoutSeconds)}s after SIGKILL`,
          { pgid },
        );
      }
      await sessionRuntime.sleep(ORPHAN_POLL_MS);
    }
    return null;
  }

  // -- the readout ---------------------------------------------------------

  /**
   * One session as its own output currently reports it.
   *
   * Built from the stream-json lines the child wrote, in this order of
   * evidence:
   *
   * 1. an **identity check** on every event that names one -- the C2 form of
   *    the roster read-back. Disagreement is persisted as an incident and every
   *    later read keeps failing;
   * 2. a `result` event, whose `terminal_reason` (falling back to its `subtype`)
   *    is the child's own last word. The process exit code is carried in the
   *    detail and never consulted for the verdict;
   * 3. any other event, whose `subtype` or `type` is the child's own word for
   *    where it is;
   * 4. nothing parseable yet from a live child -- **could not observe**, with
   *    the reason (R4);
   * 5. an exit with no structured output at all, reported as the process
   *    disposition with the captured stderr surfaced -- which is where the
   *    CLI's refusals live (i01 3.3).
   */
  async #readout(session: Supervised): Promise<SessionReadout | Uninterpretable> {
    // D-0301 part 4, once for the whole function: everything below that asks
    // whether the child is still running reads a value libuv publishes on a
    // macrotask turn.
    await sessionRuntime.settleExits();
    const record = session.record;
    if (record.incident !== null) {
      // The committed identity rides on every answer about an impounded
      // session, not only on the answer that first detected the mismatch: which
      // call detects it is a race against the child -- a slow machine can put
      // the whole detection inside `start()`'s own readout -- and the evidence
      // must not depend on winning it.
      //
      // The *kind* is part of that evidence, which is why both branches go
      // through `identityIncident`: continuo #92 measured the race deciding
      // which exception class the orchestrator raised, because this branch and
      // the detecting branch below were only alike in their prose (D-0047).
      return identityIncident(`identity incident: ${record.incident}`, {
        session_id: record.session_id,
        expected: record.claude_session_uuid,
      });
    }
    const parsed = this.#parseEvents(session);
    if (isUninterpretable(parsed)) {
      // The captured-output *file* could not be read. That is a failure of the
      // observation channel, not an answer in an uninterpretable shape: per
      // S1's contract it is a readout of "could not observe" with the reason,
      // never a failed call.
      return new SessionReadout({
        sessionId: record.session_id,
        observation: Observation.COULD_NOT_OBSERVE,
        couldNotObserveReason: parsed.detail,
        providerDetail: parsed.providerDetail,
      });
    }
    const { events, garbage } = parsed;
    const baseDetail: Record<string, unknown> = {
      pid: record.pid,
      generation: record.generation,
      ...session.providerDetail,
    };
    const stderrTail = this.#stderrTail(record);
    if (stderrTail !== "") {
      baseDetail["stderr_tail"] = stderrTail;
    }

    for (const event of events) {
      const reported = getOwn(event, "session_id");
      if (reported !== undefined && reported !== null && reported !== record.claude_session_uuid) {
        const incident =
          `session ${pyRepr(record.session_id)} committed identity ` +
          `${pyRepr(record.claude_session_uuid)} before the spawn, but the ` +
          `child's own ${pyStr(getOwn(event, "type") ?? "?")} event reports ` +
          `${pyRepr(reported)}. Two processes reporting one id -- or one ` +
          "process reporting another's -- is the U27 failure shape; " +
          "this session is impounded, not warned about.";
        this.#recordIncident(session, incident);
        return identityIncident(`identity incident: ${incident}`, {
          ...baseDetail,
          expected: record.claude_session_uuid,
          reported,
        });
      }
    }

    if (garbage !== null) {
      // An uninterpretable line does not stop later, well-formed lines from
      // being read, but it is never silently dropped either: it rides in the
      // detail when a readout is still possible, and it is the loud answer
      // itself when nothing better exists (below).
      baseDetail["uninterpretable_line"] = garbage;
    }

    // The read-back is positive, not merely non-contradictory: structured
    // output that never names the session's identity cannot be reconciled with
    // the one committed before the spawn, and accepting it anyway would let
    // schema drift quietly defeat the one check U27 makes mandatory. A live
    // child is given time (below); a finished one is answered loudly.
    const identityReadBack = events.some((event) => {
      const reported = getOwn(event, "session_id");
      return reported !== undefined && reported !== null;
    });
    // The **last** result event, which is what `next(... reversed(events) ...)`
    // finds.
    let resultEvent: Record<string, unknown> | null = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as Record<string, unknown>;
      if (getOwn(event, "type") === "result") {
        resultEvent = event;
        break;
      }
    }
    if (resultEvent !== null) {
      if (!identityReadBack) {
        return uninterpretable(
          `the child of session ${pyRepr(record.session_id)} finished ` +
            "without any event naming a session identity, so the " +
            "identity committed before the spawn cannot be read back " +
            "and reconciled; its outcome is not accepted on trust",
          { ...baseDetail, expected: record.claude_session_uuid },
        );
      }
      const terminalReason = getOwn(resultEvent, "terminal_reason");
      const subtype = getOwn(resultEvent, "subtype");
      // Python's `or`: a falsy `terminal_reason` -- an empty string, `0`,
      // `false` -- falls through to `subtype`. `??` would keep the empty string
      // and then refuse it as unnameable, which is a different answer.
      const word = pyTruthy(terminalReason) ? terminalReason : subtype;
      if (typeof word !== "string" || pyStrip(word) === "") {
        return uninterpretable(
          `the child of session ${pyRepr(record.session_id)} wrote a result ` +
            "event carrying neither a terminal_reason nor a subtype; " +
            "a result that names no outcome cannot be read as one",
          { ...baseDetail, result_keys: pyKeys(resultEvent).sort(comparePythonStrings) },
        );
      }
      return new SessionReadout({
        sessionId: record.session_id,
        observation: Observation.OBSERVED,
        providerState: word,
        providerDetail: {
          ...baseDetail,
          is_error: noneOf(getOwn(resultEvent, "is_error")),
          subtype: noneOf(subtype),
          terminal_reason: noneOf(terminalReason),
          returncode: this.#returncode(session),
        },
      });
    }

    const liveness = await this.#childLiveness(session);
    if (liveness instanceof Failure) {
      // Unknowable liveness is likewise an observation-channel failure: the
      // session is reported as itself, explicitly unobservable, with the
      // reason. The *acting* verbs still consult `#childLiveness` directly and
      // keep failing closed on it.
      return new SessionReadout({
        sessionId: record.session_id,
        observation: Observation.COULD_NOT_OBSERVE,
        couldNotObserveReason: liveness.detail,
        providerDetail: { ...baseDetail, ...liveness.providerDetail },
      });
    }
    if (liveness) {
      if (garbage !== null) {
        // Ahead of the events-based readout on purpose: a live child that wrote
        // one uninterpretable line fails loudly rather than reporting its last
        // good event as though nothing had happened.
        return uninterpretable(garbage, baseDetail);
      }
      if (events.length > 0 && !identityReadBack) {
        // The child is speaking but has not yet said who it is. The identity
        // may still arrive, so this is tolerated as an explicit
        // could-not-observe rather than either accepted as an observed state or
        // condemned as an incident.
        return new SessionReadout({
          sessionId: record.session_id,
          observation: Observation.COULD_NOT_OBSERVE,
          couldNotObserveReason:
            "the child is emitting events, but none has named a " +
            "session identity yet; an observed state is withheld " +
            "until the committed identity reads back",
          providerDetail: baseDetail,
        });
      }
      if (events.length > 0) {
        const last = events[events.length - 1] as Record<string, unknown>;
        const subtype = getOwn(last, "subtype");
        const word = pyTruthy(subtype) ? subtype : getOwn(last, "type");
        if (typeof word !== "string" || pyStrip(word) === "") {
          return uninterpretable(
            `the child of session ${pyRepr(record.session_id)} wrote an ` +
              "event carrying neither a subtype nor a type; an event " +
              "that names nothing cannot be read as a state",
            { ...baseDetail, event_keys: pyKeys(last).sort(comparePythonStrings) },
          );
        }
        return new SessionReadout({
          sessionId: record.session_id,
          observation: Observation.OBSERVED,
          providerState: word,
          providerDetail: baseDetail,
        });
      }
      return new SessionReadout({
        sessionId: record.session_id,
        observation: Observation.COULD_NOT_OBSERVE,
        couldNotObserveReason: "the child is running but has not emitted anything parseable yet",
        providerDetail: baseDetail,
      });
    }

    // The child is gone without a result event.
    if (garbage !== null) {
      return uninterpretable(garbage, baseDetail);
    }
    if (events.length > 0 && !identityReadBack) {
      return uninterpretable(
        `the child of session ${pyRepr(record.session_id)} is gone after ` +
          "emitting events, none of which named a session identity; the " +
          "identity committed before the spawn cannot be read back and " +
          "reconciled",
        { ...baseDetail, expected: record.claude_session_uuid },
      );
    }
    const returncode = this.#returncode(session);
    if (returncode !== null) {
      // A child of ours: the operating system's word for its exit is a fact
      // this supervisor observed. What it is *not* is a verdict -- exit 0 with
      // no result event says nothing about success, and the word carries the
      // number rather than an interpretation of it. The seam is what makes the
      // number Python's: a child killed by signal N reports `-N`, so a
      // SIGTERM'd child is `exited--15`, with the two hyphens the source
      // produces.
      return new SessionReadout({
        sessionId: record.session_id,
        observation: Observation.OBSERVED,
        providerState: `exited-${String(returncode)}`,
        providerDetail: { ...baseDetail, returncode },
      });
    }
    return new SessionReadout({
      sessionId: record.session_id,
      observation: Observation.COULD_NOT_OBSERVE,
      couldNotObserveReason:
        `the recorded child (pid ${String(record.pid)}) is gone, wrote no ` +
        "result event, and was not a child of this supervisor, so its " +
        "exit status was not observable",
      providerDetail: baseDetail,
    });
  }

  /**
   * The complete stream-json lines the child has written so far.
   *
   * Complete lines only: the CLI writes whole lines, but the *file* can still
   * be read mid-flush, so a trailing fragment without its newline is "not
   * arrived yet", never corruption. A **complete** line that does not parse is
   * the opposite case -- the child answered, in a shape this interface cannot
   * interpret -- and is returned as the loud half rather than skipped.
   *
   * Unknown event types and unknown fields are tolerated by construction: an
   * event is an object, and nothing here enumerates which objects exist.
   */
  #parseEvents(session: Supervised): ParsedEvents | Uninterpretable {
    const record = session.record;
    const path = this.#eventsPath(record.session_id, record.generation);
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (exc) {
      if (isSystemError(exc) && exc.code === "ENOENT") {
        // `except FileNotFoundError`, caught before the wider `except OSError`
        // in the source and so winning: the file the spawn opens exists from
        // the spawn onwards, and its absence before that is not a fault.
        return { events: [], garbage: null };
      }
      return uninterpretable(
        `the captured output of session ${pyRepr(record.session_id)} at ` +
          `${path} could not be read: ${errorText(exc)}`,
        { errno: errnoOf(exc) },
      );
    }
    // `raw.rpartition(b"\n")`: everything up to the last newline is complete,
    // and a trailing fragment is discarded rather than parsed.
    const lastNewline = raw.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      return { events: [], garbage: null };
    }
    const body = raw.subarray(0, lastNewline);

    const events: Record<string, unknown>[] = [];
    let garbage: string | null = null;
    let lineNumber = 0;
    let start = 0;
    // `body.split(b"\n")` -- and the count includes **every** line, blank ones
    // among them, because the number in the garbage message is 1-based over
    // that split.
    for (let cursor = 0; cursor <= body.length; cursor += 1) {
      if (cursor !== body.length && body[cursor] !== 0x0a) {
        continue;
      }
      const line = body.subarray(start, cursor);
      start = cursor + 1;
      lineNumber += 1;
      if (isBlankLine(line)) {
        continue;
      }
      let event: unknown;
      try {
        // Decoded **fatally**, as `line.decode("utf-8")` is: Node's `"utf8"`
        // substitutes U+FFFD silently, which would turn an undecodable line
        // into a JSON parse of replacement characters and remove the
        // `UnicodeDecodeError` branch the source has.
        event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      } catch {
        // Overwritten by each later bad line: only the LAST one survives, as
        // the source's single `garbage` variable does.
        garbage =
          `line ${String(lineNumber)} of session ${pyRepr(record.session_id)}'s ` +
          `captured output is complete but is not JSON: ${pyBytesRepr(line.subarray(0, 200))}`;
        continue;
      }
      if (typeof event !== "object" || event === null || Array.isArray(event)) {
        garbage =
          `line ${String(lineNumber)} of session ${pyRepr(record.session_id)}'s ` +
          `captured output is JSON but not an object: ${pyBytesRepr(line.subarray(0, 200))}`;
        continue;
      }
      events.push(event as Record<string, unknown>);
    }
    return { events, garbage };
  }

  /** `Popen.poll()` for a child of ours, and `None` for an orphan. */
  #returncode(session: Supervised): number | null {
    return session.child === null ? null : sessionRuntime.exitStatusOf(session.child);
  }

  /** The tail of the generation's captured stderr, or `""` when it cannot be read. */
  #stderrTail(record: SessionRecord): string {
    const path = this.#stderrPath(record.session_id, record.generation);
    let text: string;
    try {
      // `errors="replace"`, which is what Node's `"utf8"` decode does: an
      // undecodable byte becomes U+FFFD rather than an exception. Deliberately
      // NOT the fatal decode `#parseEvents` uses -- stderr is a human's text,
      // and one broken byte in it must not hide the message around it.
      text = readFileSync(path, "utf8");
    } catch {
      return "";
    }
    // Sliced first, stripped after, as the source orders it. Python slices by
    // **code points**; `String.prototype.slice` counts UTF-16 units, so an
    // astral character near the boundary would move the cut. The cheap
    // comparison comes first: a string of at most 2000 units holds at most 2000
    // code points, so nothing needs counting.
    const tail =
      text.length <= STDERR_TAIL_CHARS ? text : Array.from(text).slice(-STDERR_TAIL_CHARS).join("");
    return pyStrip(tail);
  }

  // -- the durable record's plumbing --------------------------------------

  #sessionDir(sessionId: string): string {
    return join(this.#stateRoot, sessionId);
  }

  #recordPath(sessionId: string): string {
    return join(this.#sessionDir(sessionId), RECORD_NAME);
  }

  /**
   * `events-{generation:03d}.jsonl`.
   *
   * Zero-padded to three digits and **not truncated above 999**: generation
   * 1000 gives `events-1000.jsonl`, which `padStart` reproduces exactly.
   */
  #eventsPath(sessionId: string, generation: number): string {
    return join(this.#sessionDir(sessionId), `events-${paddedGeneration(generation)}.jsonl`);
  }

  #stderrPath(sessionId: string, generation: number): string {
    return join(this.#sessionDir(sessionId), `stderr-${paddedGeneration(generation)}.log`);
  }

  /**
   * Write the record atomically. Raises where the source raises; every caller
   * catches.
   *
   * No `fsync`, as the source does none: adding one would change what a crash
   * between the two writes leaves behind, which is the property the
   * commit-before-spawn ordering is about.
   */
  #writeRecord(record: SessionRecord): void {
    sessionRuntime.writeAtomic(this.#recordPath(record.session_id), recordToJson(record));
  }

  /**
   * Impound the session: in memory unconditionally, and on disk if it can.
   *
   * A durable-write failure is **swallowed**, because degraded durability is
   * not a reason to let the incident read as healthy right now.
   */
  #recordIncident(session: Supervised, incident: string): void {
    session.record = { ...session.record, incident };
    try {
      this.#writeRecord(session.record);
    } catch {
      // Deliberately nothing. The in-memory impound still holds.
    }
  }

  /**
   * Take a session directory back down -- one level, silently.
   *
   * Flat on purpose: a *subdirectory* makes the unlink raise, which aborts the
   * loop and leaves the directory in place. That is the source's behaviour and
   * a ported case depends on it, so `rmSync(..., { recursive: true })` is the
   * wrong tool however much tidier it looks.
   */
  #removeSessionDir(sessionId: string): void {
    const directory = this.#sessionDir(sessionId);
    try {
      for (const entry of readdirSync(directory)) {
        try {
          unlinkSync(join(directory, entry));
        } catch (exc) {
          // `unlink(missing_ok=True)` swallows only a missing file; everything
          // else -- a subdirectory above all -- reaches the outer catch and
          // ends the loop there.
          if (!isSystemError(exc) || exc.code !== "ENOENT") {
            throw exc;
          }
        }
      }
      rmdirSync(directory);
    } catch {
      // Entirely silent, as the source's bare `except OSError: pass` is.
    }
  }

  /**
   * The session this provider holds for `sessionId`: supervised, broken, or
   * none at all.
   *
   * The in-memory table wins, with no disk read and no revalidation. A broken
   * record is **never cached**, so a record repaired or finished being written
   * between two calls starts answering as itself.
   */
  #find(sessionId: string): Supervised | BrokenRecord | null {
    const held = this.#sessions.get(sessionId);
    if (held !== undefined) {
      return held;
    }
    // An unsafe id is "no session", not a broken record: the path-escape
    // defence on the reading verbs.
    if (!isOnePathComponent(sessionId)) {
      return null;
    }
    const recordPath = this.#recordPath(sessionId);
    let record: SessionRecord;
    try {
      // `read_text(encoding="utf-8")` with CPython's default `errors="strict"`,
      // which is the fatal decode and NOT `readFileSync(path, "utf8")`. Node's
      // `"utf8"` substitutes U+FFFD for an undecodable byte, so a record with
      // one corrupt byte in its workspace path, its resume prompt or its argv
      // would parse as perfectly good JSON and be *acted on* -- resumed with a
      // mangled path, or spawned with a mangled argument -- where the source
      // raises `UnicodeDecodeError` and takes the broken-record route below.
      // The convention and its reason are D-0015's; the spelling is the one
      // `src/fencing/state.ts`, `src/settings/generator.ts` and the SQLite
      // migrator already use. (That third path is described rather than
      // spelled: this module's own text is scanned for the name of the
      // directory it lives in, in prose as much as in an import.)
      //
      // `UnicodeDecodeError` is a `ValueError`, so the source's
      // `except (OSError, ValueError, KeyError, TypeError)` already covers it
      // and it needs no branch of its own; `TextDecoder`'s refusal is a
      // `TypeError` here and lands in the same wide catch.
      const bytes = readFileSync(recordPath);
      record = recordFromJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (exc) {
      if (isSystemError(exc) && exc.code === "ENOENT") {
        return null;
      }
      // Wider than a Python reader expects, and deliberately so. The source
      // catches `(OSError, ValueError, KeyError, TypeError)`, which is every
      // shape its file read and its parser can produce; the JavaScript classes
      // do not line up with those four, and a narrower catch here would let an
      // unexpected shape escape a verb that owes its caller a typed answer.
      return {
        kind: "broken-record",
        sessionId,
        reason:
          `a durable record for session ${pyRepr(sessionId)} exists at ` +
          `${recordPath} but could not be read as one: ${pyExceptionRepr(exc)}`,
      };
    }
    // The identity a directory may hold is a pure function of its name, so a
    // record that names another session -- copied, or altered -- is checkable
    // and is not acted on.
    if (
      record.session_id !== sessionId ||
      record.claude_session_uuid !== claudeSessionUuid(sessionId)
    ) {
      return {
        kind: "broken-record",
        sessionId,
        reason:
          `the record at ${recordPath} names session ` +
          `${pyRepr(record.session_id)} with identity ` +
          `${pyRepr(record.claude_session_uuid)}, which is not what its ` +
          `directory ${pyRepr(sessionId)} derives; a misplaced or ` +
          "altered record is not acted on",
      };
    }
    const session: Supervised = {
      record,
      // `process` stays `None`: every later liveness, stop and resume decision
      // for this session takes the orphan path.
      child: null,
      providerDetail: { adopted_from_record: true },
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  /**
   * Which session, if any, already holds `sessionUuid`.
   *
   * A **broken** record still conservatively reserves the identity its
   * *directory name* derives: it may have a live child behind it. An unreadable
   * state root answers `null`, and the spawn path fails moments later with its
   * own reason.
   */
  #holderOfUuid(sessionUuid: string): string | null {
    let discovered: (Supervised | BrokenRecord)[];
    try {
      discovered = this.#discoverRecords();
    } catch {
      return null;
    }
    for (const entry of discovered) {
      if (isBrokenRecord(entry)) {
        if (claudeSessionUuid(entry.sessionId) === sessionUuid) {
          return entry.sessionId;
        }
        continue;
      }
      if (entry.record.claude_session_uuid === sessionUuid) {
        return entry.record.session_id;
      }
    }
    return null;
  }

  /**
   * Every session this instance supervises, then every one it can find on disk.
   *
   * **The order is the roster's order**: in-memory sessions in insertion order
   * first, then on-disk-only directories in sorted order, so orphans come last.
   *
   * It also **mutates** `#sessions`, because `#find` caches every valid record
   * it reads -- so calling this twice can return a different overall order, as
   * previously-orphan entries move into the leading segment. Observable, and
   * reproduced rather than tidied away.
   *
   * `existsSync` on the record and not a file-type test: a `record.json` that
   * is a directory is a *broken* record that must stay on the roster, not one
   * that vanishes from it.
   */
  #discoverRecords(): (Supervised | BrokenRecord)[] {
    const discovered: (Supervised | BrokenRecord)[] = [...this.#sessions.values()];
    const known = new Set(this.#sessions.keys());
    if (!isDirectory(this.#stateRoot)) {
      return discovered;
    }
    for (const name of readdirSync(this.#stateRoot).sort(comparePythonStrings)) {
      if (known.has(name) || !existsSync(join(this.#stateRoot, name, RECORD_NAME))) {
        continue;
      }
      const session = this.#find(name);
      if (session !== null) {
        discovered.push(session);
      }
    }
    return discovered;
  }

  // -- what the source's cases reach through `provider._sessions[...]` ----

  /**
   * The live child this provider holds for `sessionId`, or `null`.
   *
   * `provider._sessions[session_id].process` in the source, which is a
   * module-private attribute twelve of the ported cases reach directly. The
   * repository's answer to that is to export the reach as a named accessor and
   * mark it `@internal` (D-0101), rather than widening the public surface or
   * leaving the table reachable.
   *
   * Also the `HoldsChildren` shape the belt's teardown helper needs: it stops
   * every session and then **waits** for each child, which is the structural
   * half of the Windows cleanup hazard.
   *
   * @internal Not package API. Never re-exported from `src/index.ts`.
   */
  childOf(sessionId: string): ChildHandle | null {
    return this.#sessions.get(sessionId)?.child ?? null;
  }

  /**
   * Every session id this instance still holds a table entry for.
   *
   * The companion of {@link ClaudeCliSessionProvider.childOf}, and it exists for
   * one reason: the belt's teardown reaches the live children through
   * `listSessions()`, which is a **verb** and can refuse. This table cannot,
   * so a roster that comes back as a `Failure` still has somewhere to fall
   * back to instead of abandoning whatever is running.
   *
   * @internal Not package API (D-0101). Never re-exported from `src/index.ts`.
   */
  heldSessionIds(): readonly string[] {
    return [...this.#sessions.keys()];
  }
}
