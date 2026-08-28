/**
 * S3 -- the stub `SessionProvider`, over local child processes.
 *
 * A deliberately trivial implementation of the provisional S1 interface
 * (`./provider.ts`) with **no Claude CLI in the loop and no network**: a
 * "session" here is one ordinary local child process, and every verb is
 * rendered with the standard library alone.
 *
 * Why it exists, and why it is written before the real provider (interlock
 * D-0020): the control-plane suite is written against *a* provider, and
 * whichever provider is available while it is written is the one whose
 * vocabulary leaks into it. With this stub in place first, no Agent-View-shaped
 * (or `claude -p`-shaped) assumption can enter the suite, so gate item 11
 * measures a structural property rather than a retrofit.
 *
 * **Deliberately trivial** is a requirement, not a caveat. Nothing here is
 * allowed to make a control-plane test pass for a reason the real provider
 * would not share, so:
 *
 * - there is no retry, no reconnection, no cache of the capability probe -- the
 *   fail-closed probe (D-0010) runs on each spawn because that is what the
 *   contract says happens, not what is cheapest;
 * - the readout carries the **child's own** state word, read back from the file
 *   the child put it in, rather than a word this module invents from the exit
 *   status. A provider's state vocabulary is the provider's, and a stub that
 *   invented one would be answering, in the stub, a question the real provider
 *   answers differently;
 * - the *could not observe* case is reached the way a real provider reaches it
 *   -- a child that is alive but has not yet said anything about itself -- and
 *   not by an injected fault. Item 11's re-run exercises the degraded paths, so
 *   the degraded paths have to be reachable without patching a seam.
 *
 * What is *not* here is as deliberate: no verb hands anything to a child. The
 * child reads its standard input and this module never puts a byte into it.
 * Delivery is `MessageBus`'s under D-0009 and is built as S8; a stub that grew
 * a delivery path would make gate items 6 and 11 unmeasurable.
 *
 * ## Two things this file's own prose is not allowed to say
 *
 * `test_no_claude_cli_and_no_network` reads **this file's source text** and
 * requires five substrings to be absent from it, case-insensitively and
 * comments included: the name of the Berkeley IPC endpoint abstraction, the two
 * Python HTTP client libraries, and the two URL schemes. So there is no link
 * anywhere below, and the scheme-shaped spellings are avoided even in prose.
 * `test_no_verb_writes_to_a_child` reads the class's public member names and
 * forbids seven delivery-shaped words in them, which is why the two `@internal`
 * accessors at the bottom are named `childOf` and `stateFileOf`.
 *
 * ## What the port changes, and what it deliberately does not: the child is Node
 *
 * The source's child is a Python interpreter: `sys.executable` is both the
 * thing the capability probe interrogates and the program the default child
 * runs, and the probe reports `python <version>`. **Here the child is Node**
 * -- `process.execPath`, `node -e <program>`, and a report of
 * `node <version>`. The alternative, keeping a real `python3` child, would add
 * an interpreter dependency to a TypeScript package's test suite that the
 * Windows matrix cell does not guarantee.
 *
 * That substitution reaches the default child program, the probe argv and the
 * `provider_version` prefix, and **nothing else**: the probe's `detail` is
 * carried over verbatim, every refusal message is the source's, and every other
 * ported case asserts what its source asserts. One case is `adapted` for it
 * (`test_the_probe_reports_a_build_and_every_required_capability`, which
 * compares the prefix), and the rest stay `ported`.
 *
 * ## D-0301, in this file
 *
 * The five verbs return promises and each one runs inside the per-instance
 * exclusion queue, because Python gets mutual exclusion between verbs from
 * having one thread and the port has to build it. `probeCapabilities` stays
 * synchronous. Every read of a child's exit status is preceded by
 * `sessionRuntime.settleExits()`, without which a child that has already
 * finished still reads as running -- see `./runtime.ts` for the measurement.
 *
 * Ported from interlock `src/claude_org_runtime/session/stub_provider.py` at
 * `65f36c5`.
 */

import { mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { pyRepr } from "../fencing/pyrepr.js";
import { getOwn, PyTypeError, PyValueError, pyStr, pyStrip } from "../fencing/pysemantics.js";
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
  type StartRequest,
  WorkspaceTransition,
  WorkspaceVerdict,
} from "./provider.js";
import { type ChildHandle, ChildTimeout, sessionRuntime } from "./runtime.js";

// --------------------------------------------------------------------------
// The constants a caller supplying its own child has to honour
// --------------------------------------------------------------------------

/**
 * The environment variable through which a child is told where to put its own
 * state word. Named rather than inlined so a caller supplying its own child
 * program can honour the same convention.
 */
export const STATE_FILE_ENV = "INTERLOCK_STUB_STATE_FILE";

/**
 * How long the default child waits before announcing its state word, in
 * seconds.
 *
 * Its only purpose is to make the *could not observe* window reachable: a child
 * that is alive and has not reported yet is the case D-0006 requires the system
 * to tolerate, and a test cannot exercise a window that closes before the spawn
 * returns.
 */
export const ANNOUNCE_AFTER_ENV = "INTERLOCK_STUB_ANNOUNCE_AFTER";

/**
 * The state word the default child reports once it is up. It is the *child's*
 * word, not this module's: nothing here interprets it, ranks it, or maps it
 * onto anything.
 */
export const DEFAULT_CHILD_STATE = "working";

/**
 * The provider's own word for the transition it makes when a start is asked for
 * a workspace that does not exist yet (gate item 7's surface).
 */
export const CREATE_WORKSPACE = "create-workspace";

/**
 * The whitespace CPython's `float()` strips, as a regular-expression class.
 *
 * Neither `\s` nor `str.isspace()`, and both near misses are wrong. Measured by
 * asking CPython 3.12 `float(chr(cp) + "1")` for every code point below
 * U+11000: the set that succeeds is U+0009..U+000D, U+0020, U+0085, U+00A0,
 * U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F and U+3000 -- which is
 * JavaScript's `\s` plus U+0085 and minus U+FEFF. It is *not* `str.isspace()`:
 * that set also holds U+001C..U+001F, and a U+001C in front of a digit raises
 * rather than converting -- because the conversion maps only NON-ASCII spaces
 * to a blank and then parses what is left with C's ASCII `isspace`.
 */
const FLOAT_BLANK =
  "[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

/** A run of digits with CPython's `_` separators: `1`, `10`, `1_0`, never `1__0`. */
const FLOAT_DIGITS = "[0-9](?:_?[0-9])*";

/**
 * The spellings CPython's `float()` accepts, minus the two it accepts and
 * `time.sleep` then refuses.
 *
 * `inf`, `infinity` and `nan` are deliberately absent: `float()` takes them and
 * `time.sleep` raises on all three, so a child that refuses them at the parse
 * dies in the same place with the same effect on the caller. Written as a
 * grammar rather than handed to `Number()`, because `Number` and `float` accept
 * *different* strings in both directions -- `Number("0x10")` is 16 where
 * `float("0x10")` raises, and `Number("1_0")` is `NaN` where `float("1_0")` is
 * `10.0`.
 */
const FLOAT_LITERAL =
  `^${FLOAT_BLANK}*[+-]?(?:${FLOAT_DIGITS}(?:\\.(?:${FLOAT_DIGITS})?)?|\\.${FLOAT_DIGITS})` +
  `(?:[eE][+-]?${FLOAT_DIGITS})?${FLOAT_BLANK}*$`;

/**
 * The default child: it announces itself and then stays up until its standard
 * input closes.
 *
 * The source's program is Python and this one is JavaScript (the Node-child
 * substitution this file's header records); what it
 * does is the same, statement for statement, and the two properties that are
 * load-bearing are both preserved.
 *
 * 1. **The word is put in a sibling partial file and renamed onto the state
 *    file**, so a reader never sees half a word. The source says so in its own
 *    comment, and `_readout` below has no way to tell "half written" from
 *    "written": a torn read of `working` is `work`, which is a perfectly good
 *    state word this module would report as the child's.
 * 2. **The child blocks until its standard input closes**, which is what makes
 *    `closeStdin()` -- and only `closeStdin()` -- end it. Python spells that
 *    `sys.stdin.read()`; the Node spelling has to be the `'end'` event plus a
 *    `resume()`, because a paused stream never reaches its end.
 *
 * 3. **An announce delay the source cannot sleep on kills the child.** The
 *    source spells the delay `time.sleep(float(os.environ[...]))`, and
 *    `announce_after` is caller-supplied opaque settings, so the value can be
 *    anything at all. `Number(...)` plus `setTimeout(...)` is not that pair and
 *    fails in the one direction nothing would notice: `Number("")` is `0`,
 *    `Number("x")` is `NaN`, `setTimeout` reads both -- and every negative --
 *    as *fire immediately*, so a value CPython refuses outright became a
 *    healthy live session announcing `working` rather than the child exit the
 *    caller is owed. `float()` and `time.sleep()` are therefore reproduced,
 *    measured against CPython 3.12 rather than assumed, and the child throws
 *    (exit 1, nothing written) exactly where the Python one raises:
 *    `float("")` and `float("x")` raise `ValueError`; `float("  1.5  ")` is
 *    `1.5`; `float("1_0")` is `10.0`; `float("nan")` and `float("inf")` do NOT
 *    raise, and `time.sleep` then rejects them separately -- `ValueError` for
 *    NaN, `OverflowError` for either infinity -- as it rejects any negative.
 *
 * Two divergences left standing, both in the direction of a dead child rather
 * than a live one, and both unreachable from any caller that means it:
 * `float()` also accepts non-ASCII decimal digits (the Arabic-Indic pair for
 * one and two converts to `12.0`, through
 * `_PyUnicode_TransformDecimalAndSpaceToASCII`), which is not reproduced; and
 * this child refuses `inf`/`nan` at the parse where CPython accepts them and
 * refuses them one line later at the sleep. Neither changes what the caller
 * observes, which in both cases is a child that exited.
 *
 * `require` rather than an `import`: `node -e` evaluates its argument as
 * CommonJS, where a top-level `import` is a syntax error.
 */
export const DEFAULT_CHILD_PROGRAM = [
  'const fs = require("fs");',
  `const statePath = process.env[${JSON.stringify(STATE_FILE_ENV)}];`,
  `const raw = process.env[${JSON.stringify(ANNOUNCE_AFTER_ENV)}] ?? "0";`,
  // `float(raw)`, which is a grammar and not a cast.
  `if (!new RegExp(${JSON.stringify(FLOAT_LITERAL)}).test(raw)) {`,
  '  throw new Error("could not convert string to float: " + JSON.stringify(raw));',
  "}",
  `const after = Number(raw.replace(new RegExp(${JSON.stringify(FLOAT_BLANK)}, "g"), "").replace(/_/g, ""));`,
  // `time.sleep(after)`: its own two refusals, after the conversion succeeded.
  "if (!Number.isFinite(after) || after < 0) {",
  '  throw new Error("sleep length must be a non-negative finite float: " + String(after));',
  "}",
  "const announce = () => {",
  `  fs.writeFileSync(statePath + ".part", ${JSON.stringify(DEFAULT_CHILD_STATE)});`,
  '  fs.renameSync(statePath + ".part", statePath);',
  '  process.stdin.on("end", () => { process.exit(0); });',
  "  process.stdin.resume();",
  "};",
  // A timer, re-armed, because `setTimeout` stores its delay in a signed 32-bit
  // integer and *fires immediately* past 2**31-1 ms (about 24.8 days) with only
  // a warning. That is the same "announces when it should not" failure as an
  // unparsed delay, reached through arithmetic instead: `announce_after` is the
  // caller's number, and `time.sleep(3e6)` sleeps for 34 days.
  "const arm = (left) => {",
  "  const step = Math.min(left, 2147483647);",
  "  setTimeout(left > step ? () => arm(left - step) : announce, step);",
  "};",
  "arm(after * 1000);",
  "",
].join("\n");

/**
 * The program the capability probe runs.
 *
 * `sys.version.split()[0]` in the source -- the build's own version, asked of
 * the executable through its own command-line surface rather than read from
 * this process (D-0010: the point of the probe is to find out whether the thing
 * that would be spawned works).
 */
const VERSION_PROBE_PROGRAM = "process.stdout.write(process.versions.node)";

/**
 * The characters a session id may use once this provider has to name a file
 * after it.
 *
 * An allow-list rather than a list of things to reject: a stub that tried to
 * canonicalise arbitrary ids would be reimplementing path semantics it has no
 * need for, and each platform has its own way for a "harmless" id to land
 * somewhere else -- a separator on POSIX, a drive qualifier such as `C:foo` on
 * Windows, an embedded NUL on both.
 *
 * `^...$` without the `m` flag is `re.fullmatch`, and the anchors are not
 * interchangeable with Python's. Python's `$` matches *before* a trailing
 * newline, so `re.match(r"[A-Za-z0-9._-]+$", "a\n")` succeeds where
 * `fullmatch` fails; JavaScript's unflagged `$` matches only at the end of the
 * string, so this spelling is `fullmatch` and `"a\n"` is refused. Measured on
 * the porting host rather than assumed, because a session id carrying a newline
 * is a file name carrying a newline.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/**
 * True when the id is safe to use, whole, as a file name on any platform.
 *
 * A session id is the caller's to choose (S1), and this provider turns it into
 * a file name, so an id that escapes the state root would let a caller pick
 * which file the provider deletes and rewrites.
 */
function isOnePathComponent(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId) && sessionId !== "." && sessionId !== "..";
}

// --------------------------------------------------------------------------
// Python's two exception families, as Node hands them over
// --------------------------------------------------------------------------

/**
 * `except OSError`.
 *
 * The source distinguishes `OSError` from `ValueError` at three call sites and
 * answers each with a different `FailureKind`, so the port needs a
 * discriminator that is as reliable as Python's class hierarchy. Measured on
 * the porting host (Node v22.17.0): a *system* error carries a numeric `errno`
 * (`mkdir` over an existing file -> `Error`, `code: "EEXIST"`, `errno: -17`),
 * while an argument-validation error does not (`mkdir` on a path holding a NUL
 * -> `TypeError`, `code: "ERR_INVALID_ARG_VALUE"`, `errno: undefined`). The
 * second is exactly the shape Python raises `ValueError` for.
 *
 * The naive discriminator -- `error instanceof TypeError` -- gets the same two
 * cases right and then misfiles the third: `TextDecoder`'s fatal decode failure
 * is a `TypeError` too, and it is the one the source routes to
 * `UnicodeDecodeError` rather than to either of these.
 *
 * Note what `errno` is **not**: the source's `exc.errno` is a positive
 * `errno.h` number, Node's is its negation, and the two also disagree with each
 * other's spelling of `code`. Nothing in the ported suite asserts on the value,
 * so this is a divergence the ledger records rather than one the port papers
 * over with a translation table nothing would exercise.
 */
function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return typeof (error as NodeJS.ErrnoException | null)?.errno === "number";
}

/**
 * `f"{exc}"`, which is `str(exc)`: the message alone, never the class name.
 *
 * `String(error)` would render `Error: ENOENT: ...`, prefixing a class name
 * Python does not print. The text either way is Node's rather than CPython's --
 * `ENOENT: no such file or directory, unlink 'x'` against
 * `[Errno 2] No such file or directory: 'x'` -- and no ported case compares it,
 * so the divergence is in the interpolated half of four refusal messages and
 * nowhere else.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `Path.is_dir()`: follows symlinks, and answers `false` rather than raising.
 *
 * The `catch` is wider than a Python reader expects and has to be. CPython's
 * `is_dir()` swallows `OSError` **and** `ValueError`, so a workspace path
 * carrying a NUL answers `False` there and travels on to `_create_workspace`,
 * where the `mkdir` raises and the refusal is issued. Node's `statSync` throws
 * `ERR_INVALID_ARG_VALUE` for that path instead, so a narrower catch here would
 * move the refusal one step earlier -- to a branch that reports the same
 * `FailureKind` with the same message, but **without announcing the
 * `create-workspace` transition first**. The announcement is gate item 7's
 * surface and its ordering is what
 * `test_creating_a_workspace_is_announced_before_it_is_made` and
 * `test_a_vetoed_workspace_is_neither_created_nor_started` are about, so the
 * port keeps the source's route through it.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `f"{a_float}"` for a value the source holds as a `float`.
 *
 * Python prints `5.0` where `String(5)` prints `5`, and the stop timeout is
 * interpolated into the probe's timeout refusal. No case compares that message,
 * but the fix costs one line and the alternative is a divergence that has to be
 * written down instead.
 */
function secondsText(seconds: number): string {
  return Number.isInteger(seconds) ? `${String(seconds)}.0` : String(seconds);
}

// --------------------------------------------------------------------------
// One started session
// --------------------------------------------------------------------------

/** One started session: the request that asked for it, and its child. */
interface StubSession {
  readonly child: ChildHandle;
  readonly stateFile: string;
  /**
   * `provider_detail` on every readout for this session.
   *
   * **Shared by reference**, as the source's `Mapping` is: `_readout` hands
   * this very object to each `SessionReadout` it builds, and only the exited
   * branch copies it (to add the return code). Nothing mutates it, so the
   * sharing is invisible -- but a port that copied defensively would be making
   * a different promise from the one the source makes, and a later case
   * asserting identity would then pass or fail for the wrong reason.
   */
  readonly providerDetail: Readonly<Record<string, unknown>>;
}

/** Constructor options, which are keyword-only in the source. */
export interface LocalProcessSessionProviderOptions {
  /**
   * `python_executable` in the source, renamed for the Node-child substitution
   * this file's header records: the
   * executable is both the thing the capability probe interrogates and the
   * program the default child runs. Defaults to the running Node binary, so the
   * stub needs nothing installed.
   */
  readonly nodeExecutable?: string | undefined;
  /**
   * Seconds {@link LocalProcessSessionProvider.stop} waits for a terminated
   * child before killing it, and the bound on the capability probe.
   *
   * **Seconds, not milliseconds**, because the source's `stop_timeout: float =
   * 5.0` is seconds and the value is interpolated into a refusal message that
   * says `s`. The seam takes milliseconds, and the one conversion lives in the
   * constructor.
   */
  readonly stopTimeout?: number | undefined;
}

// --------------------------------------------------------------------------
// The provider
// --------------------------------------------------------------------------

/**
 * The five verbs and the capability probe, over local child processes.
 *
 * @param stateRoot directory this provider puts its per-session state files in.
 * Required and never defaulted to a shared temporary location: two providers
 * silently sharing a directory would read each other's children, and a stub
 * whose sessions leak into another run's is a stub that makes the control-plane
 * suite lie.
 */
export class LocalProcessSessionProvider extends SessionProvider {
  /**
   * Resolved, because the child is started with its workspace as its working
   * directory: a relative root would name one directory to this process and a
   * different one to the child, and every session would then look permanently
   * unobservable for a reason nothing reports.
   *
   * `path.resolve` and not `fs.realpathSync`: CPython's `Path.resolve()` with
   * its default `strict=False` makes the path absolute and normalises it
   * without requiring it to exist, while `realpathSync` throws for a path that
   * does not exist yet -- which the state root usually does not, since this
   * class creates it. The one thing `resolve` does not do is follow symlinks in
   * the existing prefix, and nothing here compares this path against another
   * rendering of it, so that difference is unobservable in the ported suite.
   */
  readonly #stateRoot: string;

  readonly #node: string;

  readonly #stopTimeoutSeconds: number;

  readonly #stopTimeoutMs: number;

  /**
   * `self._sessions: dict[str, _Session]`.
   *
   * A `Map` and not an object literal, for rule 9's third family: the key is
   * `request.session_id`, which is entirely the caller's string. A plain object
   * inherits `constructor`, `toString` and `__proto__` from `Object.prototype`,
   * so a session id of `constructor` would read as an existing session and be
   * refused as a duplicate before anything spawned, and assigning to a session
   * id of `__proto__` would silently repoint the object's prototype instead of
   * recording a session. A `Map` has neither hazard, and it keeps the insertion
   * order `list_sessions` reports in without the integer-key hoisting an object
   * literal would apply to an id such as `10`.
   */
  readonly #sessions = new Map<string, StubSession>();

  /**
   * D-0301 part 3: the per-instance exclusion queue the five verbs run in.
   *
   * In Python `read_state` **cannot** run while `stop` is mid-ladder -- one
   * thread -- so the source gets mutual exclusion from its language for free.
   * Without this, a `readState` could interleave at any `await` inside `stop`
   * and observe a half-finished ladder: signalled, not yet waited for, the pipe
   * not yet released. That is a state no source case can construct and none
   * forbids, so nothing in the ported suite would catch it; the target-only
   * case that drives two verbs into the queue at once is what keeps it from
   * being decoration.
   *
   * **Neither `probeCapabilities` nor the observer fan-out is queued, and
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

  constructor(stateRoot: string, options: LocalProcessSessionProviderOptions = {}) {
    super();
    this.#stateRoot = resolve(stateRoot);
    this.#node = options.nodeExecutable ?? process.execPath;
    this.#stopTimeoutSeconds = options.stopTimeout ?? 5.0;
    this.#stopTimeoutMs = this.#stopTimeoutSeconds * 1000;
  }

  /**
   * Run `body` after every verb already queued on this instance.
   *
   * Both continuations are the same function on purpose: a verb must run after
   * its predecessor **whether that predecessor settled or threw**, and
   * `queue.then(body)` alone would leave the queue permanently rejected the
   * first time a verb raised -- which for this provider means the first
   * `SpawnRefused` reaching a caller who never handled it.
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
   * Ask the executable, through its own command-line surface, what build it is.
   *
   * Public surface only: `node -e` and its exit status, nothing about how this
   * process happens to be running. An executable that cannot be run is reported
   * as a {@link Failure}, which is what refuses the next spawn -- the stub does
   * not fall back to `process.versions` from in-process, because the point of
   * the probe is to find out whether the thing that would be spawned works.
   *
   * Synchronous (D-0301 part 2). `spawnSync` is an exact analogue of the
   * source's `subprocess.run(..., timeout=)` on both branches this function
   * distinguishes.
   */
  probeCapabilities(): ProviderResult<CapabilityReport> {
    let completed: { readonly status: number; readonly stdout: Buffer; readonly stderr: Buffer };
    try {
      completed = sessionRuntime.runProbe(
        [this.#node, "-e", VERSION_PROBE_PROGRAM],
        this.#stopTimeoutMs,
      );
    } catch (exc) {
      // `except subprocess.TimeoutExpired` first, `except OSError` second, as
      // the source orders them. The two are unrelated classes in Python and
      // unrelated shapes here, so the order is documentation rather than
      // dispatch -- but it is the source's order and it costs nothing to keep.
      if (exc instanceof ChildTimeout) {
        return new Failure(
          FailureKind.TIMED_OUT,
          `the interpreter ${pyRepr(this.#node)} did not answer the version ` +
            `probe within ${secondsText(this.#stopTimeoutSeconds)}s`,
        );
      }
      if (isSystemError(exc)) {
        return new Failure(
          FailureKind.BACKEND_UNREACHABLE,
          `the interpreter ${pyRepr(this.#node)} could not be executed: ${errorText(exc)}`,
          { errno: exc.errno },
        );
      }
      // Not `OSError` and not `TimeoutExpired`. The source has no third branch
      // and would let such an exception out of the verb, so this one does too:
      // swallowing it would turn a defect in the seam into a `Failure` a caller
      // is invited to retry.
      throw exc;
    }
    if (completed.status !== 0) {
      return new Failure(
        FailureKind.BACKEND_UNREACHABLE,
        `the interpreter ${pyRepr(this.#node)} exited ${String(completed.status)} ` +
          "for the version probe",
        // `decode("utf-8", "replace")`, which is what Node's `"utf8"` does:
        // an undecodable byte becomes U+FFFD rather than an exception. The
        // opposite choice is made in `#readout`, deliberately, and the reason
        // is written there.
        { stderr: completed.stderr.toString("utf8") },
      );
    }
    const version = pyStrip(completed.stdout.toString("utf8"));
    if (version === "") {
      return new Failure(
        FailureKind.UNINTERPRETABLE_RESPONSE,
        `the interpreter ${pyRepr(this.#node)} answered the version probe ` + "with nothing",
      );
    }
    return new Ok(
      new CapabilityReport({
        // `python {version}` in the source. The child is Node here (see this
        // file's header), and
        // this prefix is the one assertion that substitution changes.
        providerVersion: `node ${version}`,
        supported: REQUIRED_CAPABILITIES,
        detail: "local child processes; no Claude CLI and no network",
      }),
    );
  }

  // -- the five verbs (D-0009) -------------------------------------------

  /** Spawn one child. Called by `start` only after the gate passes. */
  protected _startSession(request: StartRequest): Promise<ProviderResult<SessionReadout>> {
    return this.#serialise(() => this.#spawnOneChild(request));
  }

  /**
   * The body of `_startSession`, inside the queue.
   *
   * The order of the steps is the source's and is asserted by five of the
   * ported cases: id shape, duplicate id, workspace usability, workspace
   * creation (announce, then make), state-file preparation, environment,
   * command validation, spawn, record.
   */
  async #spawnOneChild(request: StartRequest): Promise<ProviderResult<SessionReadout>> {
    const sessionId = request.sessionId;
    if (!isOnePathComponent(sessionId)) {
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `session id ${pyRepr(sessionId)} is not usable as a single ` +
          "file name; this provider names a state file after the session " +
          "and will not let an id reach outside its state root",
      );
    }
    if (this.#sessions.has(sessionId)) {
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `session ${pyRepr(sessionId)} already exists; this provider ` +
          "does not reuse a session id",
      );
    }

    const workspace = request.workspace;
    let workspaceExists: boolean;
    try {
      workspaceExists = isDirectory(workspace);
    } catch (exc) {
      // The source's `except ValueError` around `Path(...)` / `.is_dir()`, kept
      // for the reason the source keeps it: unreachable on a modern CPython,
      // where `is_dir()` answers `False` for an unusable path instead of
      // raising, and unreachable here for the same reason -- {@link isDirectory}
      // swallows what `statSync` throws. S1 only requires the workspace to be a
      // non-empty string, so if some future platform did raise here, an
      // unusable one is caller input this verb refuses with a reason rather
      // than an exception.
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

    const stateFile = this.#stateFile(sessionId);
    try {
      mkdirSync(this.#stateRoot, { recursive: true });
      // `state_file.unlink(missing_ok=True)`. A stale file from an earlier
      // session of the same name would be read as this child's word.
      //
      // `unlinkSync` in its own `catch` rather than `rmSync(..., {force: true})`:
      // `rm` answers `ERR_FS_EISDIR` where `unlink` answers the `EISDIR` that
      // Python's `IsADirectoryError` is, and that error belongs in the outer
      // handler below rather than being swallowed by `force`.
      try {
        unlinkSync(stateFile);
      } catch (exc) {
        if (!isSystemError(exc) || exc.code !== "ENOENT") {
          throw exc;
        }
      }
    } catch (exc) {
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `the state file for session ${pyRepr(sessionId)} could not ` +
          `be prepared under ${this.#stateRoot}: ${errorText(exc)}`,
        { errno: isSystemError(exc) ? exc.errno : null },
      );
    }

    // `dict(os.environ)`: a copy of the whole environment, snapshotted at spawn
    // time, plus this provider's own two keys. Node's `env` option likewise
    // *replaces* the child's environment rather than extending it, so omitting
    // the copy would hand the child a bare environment rather than this one.
    const environment: NodeJS.ProcessEnv = { ...process.env };
    environment[STATE_FILE_ENV] = stateFile;
    // `request.settings.get("announce_after")`, and `getOwn` rather than a
    // property read for rule 9: `settings` is opaque caller-supplied data, and
    // a plain `settings.announce_after` would find an inherited value on an
    // object whose prototype carries one, where a Python `dict` finds nothing.
    const announceAfter = getOwn(request.settings, "announce_after");
    // `if announce_after is not None`. `undefined` is the second nothing --
    // what an absent key produces here -- and means exactly what `None` means.
    // Note that `0` is set, as it is in the source: the check is against
    // nothing, never against falsiness.
    if (announceAfter !== undefined && announceAfter !== null) {
      environment[ANNOUNCE_AFTER_ENV] = pyStr(announceAfter);
    }

    let command: readonly string[];
    try {
      command = this.#childCommand(request);
    } catch (exc) {
      if (!(exc instanceof PyTypeError || exc instanceof PyValueError)) {
        throw exc;
      }
      // The caller's settings are unusable -- the wrong shape, empty, or
      // carrying a NUL. All of them are the same answer, and it is reached
      // before any spawn is attempted so that no platform's idea of which
      // exception to raise can change it.
      //
      // Echoing the setting back is shape-checked for the same reason
      // `#childCommand` checks it: `settings` is opaque, so the value may be a
      // number, or a bare string whose iteration would report its characters as
      // arguments. Anything that is not already a sequence of arguments is
      // reported as itself, not taken apart.
      const raw = getOwn(request.settings, "command");
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `the child command configured for session ` +
          `${pyRepr(sessionId)} is unusable: ${exc.message}`,
        { command: Array.isArray(raw) ? [...(raw as readonly unknown[])] : pyRepr(raw) },
      );
    }

    let child: ChildHandle;
    try {
      child = await sessionRuntime.spawn(command, {
        cwd: workspace,
        env: environment,
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
        // The stub's `Popen` passes neither `start_new_session` nor
        // `creationflags`; its stop ladder signals the child and never a group.
        newProcessGroup: false,
      });
    } catch (exc) {
      if (isSystemError(exc)) {
        return new Failure(
          FailureKind.BACKEND_UNREACHABLE,
          `could not spawn a child for session ${pyRepr(sessionId)}: ${errorText(exc)}`,
          { command: [...command], errno: exc.errno },
        );
      }
      // Not `OSError` and not `(ValueError, IndexError)`. The source has no
      // third branch and would let such an exception out of the verb, so this
      // one does too -- the same reason `probeCapabilities` and `#childCommand`
      // above each re-throw what they do not recognise. Swallowing it would
      // report a defect in the seam as `REFUSED_BY_PROVIDER`, which tells an
      // operator to fix a configuration that is fine.
      if (!(exc instanceof PyValueError || exc instanceof RangeError)) {
        throw exc;
      }
      // `except (ValueError, IndexError)`. A backstop: the two cases that used
      // to arrive here -- an empty command and one carrying a NUL -- are now
      // refused by `#childCommand` before any spawn is attempted, precisely so
      // that the answer does not depend on which platform's layer rejects them.
      // `RangeError` is the pair's rendering here: `subprocess.Popen([])` is
      // `IndexError` on POSIX and `ValueError` on Windows, and the seam's
      // empty-argv reject spells both as one `RangeError` (see
      // `SessionRuntime.spawn`). Note the detail carries no `errno`, as the
      // source's does not.
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `the child command configured for session ` +
          `${pyRepr(sessionId)} is unusable: ${errorText(exc)}`,
        { command: [...command] },
      );
    }

    const session: StubSession = {
      stateFile,
      child,
      providerDetail: { pid: child.pid, command: [...command] },
    };
    this.#sessions.set(sessionId, session);
    return new Ok(await this.#readout(sessionId, session));
  }

  /**
   * Every session this provider started and has not forgotten.
   *
   * `Ok([])` when there are none: this provider is in-process, so being
   * reachable is not in question, and an empty list is a fact about the
   * provider rather than a failure to read it (R4).
   *
   * An array where the source returns a tuple, and the readouts are built one
   * at a time rather than with `Promise.all`, so the order is the insertion
   * order of successful starts -- which is what the source's `dict` gives it.
   */
  listSessions(): Promise<ProviderResult<readonly SessionReadout[]>> {
    return this.#serialise(async () => {
      const readouts: SessionReadout[] = [];
      for (const [sessionId, session] of this.#sessions) {
        readouts.push(await this.#readout(sessionId, session));
      }
      return new Ok(readouts);
    });
  }

  /** The child's current state, or an explicit could-not-observe. */
  readState(sessionId: string): Promise<ProviderResult<SessionReadout>> {
    return this.#serialise(async () => {
      const session = this.#sessions.get(sessionId);
      if (session === undefined) {
        return new Failure(
          FailureKind.UNKNOWN_SESSION,
          `this provider holds no session ${pyRepr(sessionId)}`,
        );
      }
      return new Ok(await this.#readout(sessionId, session));
    });
  }

  /**
   * Terminate the child, then report what it looks like afterwards.
   *
   * The readout is taken *after* the wait rather than assumed from the
   * terminate call, because a provider accepting a stop is not evidence that
   * the session stopped.
   *
   * The session is **not** removed from the table: an exited session is still
   * one this provider holds, `readState` on it is a legitimate question, and
   * its id stays taken.
   */
  stop(sessionId: string): Promise<ProviderResult<SessionReadout>> {
    return this.#serialise(async () => {
      const session = this.#sessions.get(sessionId);
      if (session === undefined) {
        return new Failure(
          FailureKind.UNKNOWN_SESSION,
          `this provider holds no session ${pyRepr(sessionId)}`,
        );
      }
      // D-0301 part 4: without the yield a child that has already finished
      // still reads as running, and the ladder below would signal a corpse and
      // then wait `stop_timeout` for it.
      await sessionRuntime.settleExits();
      if (sessionRuntime.exitStatusOf(session.child) === null) {
        sessionRuntime.signalChild(session.child, "SIGTERM");
        try {
          await sessionRuntime.waitForExit(session.child, this.#stopTimeoutMs);
        } catch (exc) {
          if (!(exc instanceof ChildTimeout)) {
            throw exc;
          }
          sessionRuntime.signalChild(session.child, "SIGKILL");
          // No timeout on the post-kill wait, as the source has none: a child
          // that outlives SIGKILL is not a case a deadline improves.
          await sessionRuntime.waitForExit(session.child);
        }
      }
      this.#closeChildInput(session);
      return new Ok(await this.#readout(sessionId, session));
    });
  }

  /**
   * Re-enter a session this provider still holds a child for.
   *
   * A local child process cannot be re-entered once it is gone, and this stub
   * does not pretend otherwise: re-entering a session whose child has exited is
   * refused with a reason rather than answered with a readout of something that
   * is not running. Whether the real provider can do better is the real
   * provider's business.
   */
  resume(sessionId: string): Promise<ProviderResult<SessionReadout>> {
    return this.#serialise(async () => {
      const session = this.#sessions.get(sessionId);
      if (session === undefined) {
        return new Failure(
          FailureKind.UNKNOWN_SESSION,
          `this provider holds no session ${pyRepr(sessionId)}`,
        );
      }
      await sessionRuntime.settleExits();
      const returncode = sessionRuntime.exitStatusOf(session.child);
      if (returncode !== null) {
        // Before the refusal, not after: a refused resume still releases the
        // descriptor, so repeated failed resumes are not a way to exhaust them.
        this.#closeChildInput(session);
        return new Failure(
          FailureKind.REFUSED_BY_PROVIDER,
          `the child of session ${pyRepr(sessionId)} has exited; a local child ` +
            "process cannot be re-entered",
          { returncode },
        );
      }
      return new Ok(await this.#readout(sessionId, session));
    });
  }

  // -- the parts the verbs are built from --------------------------------

  /**
   * The child to run: the caller's, if its settings name one.
   *
   * `settings` is opaque per-role configuration in S1, so a caller may supply
   * its own child; whatever it supplies still gets {@link STATE_FILE_ENV} and
   * is still read through the same readout, so no verb behaves differently for
   * the default child than for any other.
   *
   * The order of the four checks is the source's and is observable whenever an
   * input trips more than one: shape, then stringify every element, then
   * emptiness, then the NUL scan -- which reports the **index** of the first
   * offender.
   *
   * The contents are checked here rather than by letting the spawn reject them,
   * because *which layer rejects them is platform-dependent and the
   * classification must not be*. On POSIX an empty argv raises `IndexError` and
   * an embedded NUL raises `ValueError`, both before the operating system is
   * involved. On Windows an empty argv reaches `CreateProcess`, which fails
   * with `OSError` (`WinError 87`, `errno` 22) -- indistinguishable at the call
   * site from a genuine spawn failure, and so classified as
   * `BACKEND_UNREACHABLE`. That inverted the answer the contract owes the
   * caller: unusable *settings* say "fix your configuration"
   * (`REFUSED_BY_PROVIDER`), while an unreachable backend says "the child could
   * not be started" and invites a retry that cannot succeed. Deciding it before
   * the spawn makes the verdict a property of the request rather than of the
   * platform.
   */
  #childCommand(request: StartRequest): readonly string[] {
    const command = getOwn(request.settings, "command");
    if (command === undefined || command === null) {
      return [this.#node, "-e", DEFAULT_CHILD_PROGRAM];
    }
    if (!Array.isArray(command)) {
      // `isinstance(command, (list, tuple))` in the source. JavaScript has no
      // tuple, so an array is the whole of the accepted shape -- and a bare
      // string is refused along with everything else, because iterating it
      // would spawn its first character.
      throw new PyTypeError(
        `a child command must be a list or tuple of arguments, got ${pyRepr(command)}`,
      );
    }
    // `[str(part) for part in command]`. Non-string elements are coerced, not
    // rejected; `pyStr` rather than `String` because Python renders `True` and
    // `None` differently from JavaScript and a coerced argument is one the
    // operating system will actually receive.
    const argv = (command as readonly unknown[]).map((part) => pyStr(part));
    if (argv.length === 0) {
      throw new PyValueError("a child command must name at least one argument");
    }
    for (const [index, part] of argv.entries()) {
      if (part.includes("\u0000")) {
        throw new PyValueError(
          `argument ${String(index)} of the child command contains a NUL, ` +
            "which no operating system can carry in an argv",
        );
      }
    }
    return argv;
  }

  /**
   * `self._state_root / f"{session_id}.state"`.
   *
   * `join` normalises where Python's `/` operator does not, so an id containing
   * `..` would resolve *upwards* here and merely concatenate there. Every id
   * reaching this method has passed {@link isOnePathComponent}, which admits no
   * separator and no `..`, so the difference is unreachable -- and it is named
   * because the allow-list is the only thing making it so.
   */
  #stateFile(sessionId: string): string {
    return join(this.#stateRoot, `${sessionId}.state`);
  }

  /**
   * Announce the workspace transition, and make it unless vetoed.
   *
   * This is gate item 7's surface with a real producer behind it. The stub
   * creates a workspace it was asked to start in and never removes one:
   * announcing a transition it does not make would give the control-plane suite
   * a veto to test that nothing acts on.
   *
   * Returns `null` when the workspace is there afterwards, and a {@link Failure}
   * otherwise. Synchronous, because the observer fan-out is (D-0301 part 2).
   */
  #createWorkspace(request: StartRequest, workspace: string): Failure | null {
    const transition = new WorkspaceTransition({
      sessionId: request.sessionId,
      workspace,
      kind: CREATE_WORKSPACE,
      providerDetail: { role: request.role },
    });
    // Asked **before** the directory is made, which is the whole of gate item
    // 7's promise: a veto means nothing was created and nothing was spawned.
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
          { errno: exc.errno },
        );
      }
      // `except ValueError`: a path the operating system is never even asked
      // about -- one carrying a NUL, say. {@link isDirectory} answered `false`
      // for it rather than raising, so this is where an unusable workspace
      // surfaces, exactly as it does in the source.
      return new Failure(
        FailureKind.REFUSED_BY_PROVIDER,
        `the workspace configured for session ${pyRepr(request.sessionId)} ` +
          `is not a usable path: ${errorText(exc)}`,
      );
    }
    return null;
  }

  /**
   * What the provider currently reports for one session.
   *
   * Three cases, and the middle one is the case item 11 exercises:
   *
   * - the child has exited -- observed, and the state word is the child's exit
   *   disposition as the operating system reports it;
   * - the child is alive and has not put its state word anywhere yet, or its
   *   state file cannot be read -- **could not observe**, with the reason,
   *   which is neither an error nor an observation of nothing (R4);
   * - the child is alive and has reported -- observed, carrying the word the
   *   child itself chose, uninterpreted.
   *
   * The exit check is first, so an exit wins over a stale word in the file.
   */
  async #readout(sessionId: string, session: StubSession): Promise<SessionReadout> {
    // D-0301 part 4, and the one line that decides whether six cases are flaky:
    // libuv publishes a child's exit status on a macrotask turn, so a read
    // taken without this yield answers `null` for a child that is already a
    // zombie.
    await sessionRuntime.settleExits();
    const returncode = sessionRuntime.exitStatusOf(session.child);
    if (returncode !== null) {
      // An exited session stays in the table -- reading it is a legitimate
      // question -- so the pipe held open for its child is released here rather
      // than only in `stop`, which a child that exited on its own is never
      // handed to.
      this.#closeChildInput(session);
      return new SessionReadout({
        sessionId,
        observation: Observation.OBSERVED,
        // `f"exited-{returncode}"`, and the seam is what makes the number
        // Python's: a child killed by signal N reports `-N`, so a SIGTERM'd
        // child is `exited--15`, with the two hyphens the source produces.
        providerState: `exited-${String(returncode)}`,
        providerDetail: { ...session.providerDetail, returncode },
      });
    }
    let reported: string;
    try {
      // `read_text(encoding="utf-8")`, which **raises** on bytes that are not
      // UTF-8. `readFileSync(path, "utf8")` does not: it substitutes U+FFFD
      // silently, and with it the not-UTF-8 branch below would be unreachable
      // and `test_a_state_word_that_is_not_utf8_is_could_not_observe` would
      // report the replacement characters as a perfectly good state word. So
      // the bytes are read and decoded fatally (D-0015), which is the same call
      // `src/fencing/state.ts` and `src/settings/generator.ts` make for the
      // same reason.
      const bytes = readFileSync(session.stateFile);
      reported = pyStrip(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (exc) {
      if (isSystemError(exc) && exc.code === "ENOENT") {
        // `except FileNotFoundError`, which is caught **before** the wider
        // `except OSError` in the source and so wins: not yet written is the
        // ordinary shape of "has not reported", it is the same case as an empty
        // file, and splitting the two would make a caller match on which one it
        // got.
        reported = "";
      } else if (isSystemError(exc)) {
        return new SessionReadout({
          sessionId,
          observation: Observation.COULD_NOT_OBSERVE,
          couldNotObserveReason:
            `the child is running but its state file ` +
            `${session.stateFile} could not be read: ${errorText(exc)}`,
          providerDetail: session.providerDetail,
        });
      } else {
        // `except UnicodeDecodeError`. A child may put whatever it likes in the
        // file. Bytes that are not a word are a state this provider could not
        // observe, with the reason -- not an exception, and not a state
        // invented on the child's behalf.
        return new SessionReadout({
          sessionId,
          observation: Observation.COULD_NOT_OBSERVE,
          couldNotObserveReason: `the child is running but wrote a state that is not UTF-8: ${errorText(exc)}`,
          providerDetail: session.providerDetail,
        });
      }
    }
    if (reported === "") {
      return new SessionReadout({
        sessionId,
        observation: Observation.COULD_NOT_OBSERVE,
        couldNotObserveReason: "the child is running but has not reported a state yet",
        providerDetail: session.providerDetail,
      });
    }
    return new SessionReadout({
      sessionId,
      observation: Observation.OBSERVED,
      providerState: reported,
      providerDetail: session.providerDetail,
    });
  }

  /**
   * Release the pipe held open for the child's standard input.
   *
   * Closing a pipe is not delivery: nothing is ever put into it. It is held
   * open only so the default child has an input to block on, and released here
   * so a stopped session leaks no file descriptor.
   *
   * `stdinClosed()` answers "did this run already?", not "is the stream
   * usable?" -- Node destroys a child's stdin by itself when the child dies,
   * where Python's `Popen.stdin.closed` stays `False`, so the guard is written
   * against the seam's own flag. `runtime.ts` carries the side-by-side
   * measurement and what the naive spelling costs.
   */
  #closeChildInput(session: StubSession): void {
    if (!session.child.stdinClosed()) {
      session.child.closeStdin();
    }
  }

  // -- what three source cases reach through `provider._sessions[...]` ----

  /**
   * The live child this provider holds for `sessionId`, or `null`.
   *
   * `provider._sessions[session_id].process` in the source, which is a
   * module-private attribute a test reaches directly. The repository's answer to
   * that is to export the reach as a named accessor and mark it `@internal`
   * (D-0101), rather than widening the public surface or leaving the map
   * reachable.
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
   * The companion of {@link LocalProcessSessionProvider.childOf}, and it exists
   * for one reason: the belt's teardown reaches the live children through
   * `listSessions()`, which is a **verb** and can refuse. This table cannot, so
   * a roster that comes back as a `Failure` still has somewhere to fall back to
   * instead of abandoning whatever is running.
   *
   * @internal Not package API (D-0101). Never re-exported from `src/index.ts`.
   */
  heldSessionIds(): readonly string[] {
    return [...this.#sessions.keys()];
  }

  /**
   * The state file this provider named for `sessionId`, or `null`.
   *
   * `provider._sessions[session_id].state_file`, reached by
   * `test_a_state_word_that_is_not_utf8_is_could_not_observe` so that its poll
   * loop can wait for the child to have written the file at all.
   *
   * @internal Not package API. Never re-exported from `src/index.ts`.
   */
  stateFileOf(sessionId: string): string | null {
    return this.#sessions.get(sessionId)?.stateFile ?? null;
  }
}
