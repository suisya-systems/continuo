/**
 * The session belt's single seam over the operating system.
 *
 * Interlock's session subsystem talks to the OS through Python's `subprocess`,
 * `os` and `time` modules directly: `Popen`, `Popen.wait(timeout=)`,
 * `subprocess.run(timeout=)`, `os.kill`, `os.killpg`, `os.replace`,
 * `time.monotonic`, `time.sleep`, and hand-rolled `/proc` reads. Every one of
 * those is a *module-level* name in Python, so a source case can replace it
 * with `monkeypatch.setattr` and the code inside the module sees the
 * replacement on its next call. ESM cannot do that: bindings are resolved at
 * link time and cannot be rebound from outside the module (D-0014). This file
 * is the reproduction of that late binding for the session belt.
 *
 * ## Why one record and not several
 *
 * The obvious alternative is a small record per concern -- a spawn seam, a
 * clock seam, a `/proc` seam. It was rejected for two reasons, and the second
 * is the load-bearing one.
 *
 * 1. The concerns are not separable in the source. `_terminate` signals a
 *    group, waits on a child, reads the monotonic clock, sleeps, and re-reads
 *    `/proc` inside one loop; `_spawn` writes the record, spawns, writes the
 *    record again and -- if that write fails -- signals, waits and sweeps. A
 *    per-concern split would have every call site importing three records to
 *    reproduce one Python function.
 * 2. **A seam nothing routes through is decoration** (D-0014's consequence
 *    note). One record with one rule -- *every internal call site in this belt
 *    goes through `sessionRuntime.x(...)`, never through an imported binding*
 *    -- is a rule that can be checked by reading, and the belt's seam-liveness
 *    cases can assert it per substituted key. Several records multiply the
 *    places that rule can be quietly broken.
 *
 * The seam is deliberately *narrow*: it carries spawn and the capability
 * probe, exit-waiting with a timeout, process-group signalling, pid liveness
 * plus the two `/proc` reads, the monotonic clock, and the atomic record
 * write. It carries nothing else. In particular the ordinary reads of
 * `record.json`, `events-NNN.jsonl` and `stderr-NNN.log` are **not** here:
 * no source case patches them, and a substitute for them would let the belt
 * fake the very evidence the readout is built from. Substituting anything
 * here is reserved for the three sanctioned categories the pre-belt design
 * review named -- a Windows-equivalent branch, a write failure, and a signal
 * no-op -- because the normal path is supposed to drive a real child process.
 *
 * ## The four asynchronous members, and why exactly those (D-0301)
 *
 * A child's exit status in Node is held by libuv and published only on a
 * **macrotask** turn of the event loop. Measured on the porting host (Node
 * v22.17.0): a child that exits at t=200ms still reads `exitCode === null`
 * with the loop blocked to t=1500ms, and still reads `null` after 5000
 * `await Promise.resolve()` turns; one `setTimeout(0)` releases it. So there
 * is no synchronous, in-process way to observe an exit, and D-0301 decided
 * the shape of the port around that fact rather than around tidiness.
 *
 * Exactly four members are asynchronous -- they are exactly the sites that
 * *wait on an already-running child*:
 *
 * - {@link SessionRuntime.spawn} -- Node reports a failed spawn on a later
 *   turn (`'error'`), where Python's `Popen` raises `OSError` from the
 *   constructor. Folding that back into one settled outcome is what lets the
 *   provider classify a spawn failure the way the source does.
 * - {@link SessionRuntime.waitForExit} -- `Popen.wait(timeout=)`.
 * - {@link SessionRuntime.sleep} -- `time.sleep(0.05)` in the orphan and
 *   sweep deadline loops.
 * - {@link SessionRuntime.settleExits} -- the macrotask yield the measurement
 *   above makes mandatory before any read of a child's exit state.
 *
 * **Everything else here is synchronous, because its Python counterpart is
 * and because Node offers an exact analogue.** `spawnSync` matches
 * `subprocess.run(timeout=)` on both branches the source distinguishes;
 * `performance.now()` matches `time.monotonic()`; `process.kill(-pgid, sig)`
 * matches `os.killpg`; `readFileSync` matches every `/proc` and record read.
 * Making any of them asynchronous would push `await` into
 * `probeCapabilities`, which D-0301 part 2 keeps synchronous so the contract
 * battery's gate cases and the observer fan-out port unchanged.
 *
 * Ported against interlock `65f36c5`,
 * `src/claude_org_runtime/session/claude_cli_provider.py` (the module-level
 * primitives at lines 1720-1827, `_spawn`, `_run_probe`, `_write_record`) and
 * `stub_provider.py` (the stdin pipe and its terminate/kill ladder). This file
 * has no Python counterpart of its own: it is the adapter those two modules'
 * OS calls collapse into.
 *
 * @internal Not package API (D-0101). Never re-exported from `src/index.ts`.
 */

import { type ChildProcess, spawn as nodeSpawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Writable } from "node:stream";

// --------------------------------------------------------------------------
// Value types
// --------------------------------------------------------------------------

/**
 * A spawned child, as this subsystem sees it. Python's `subprocess.Popen`.
 *
 * The Node `ChildProcess` behind it is deliberately **not** reachable from
 * this interface. Every operation on a live child -- reading its exit status,
 * waiting for it, signalling it -- is a method on {@link SessionRuntime}, so
 * that patching the seam actually changes what the belt does. A handle that
 * exposed `.child` would let a call site reach past the record without
 * looking like it was reaching past anything, which is the exact way a seam
 * becomes decoration (D-0014).
 *
 * The consequence is that handles are always real: there is no way to build
 * one that is not backed by a process, and the runtime refuses any object it
 * did not mint. That is the intended posture -- the design review's rule is
 * that the belt drives genuine children and substitutes only the three
 * unreachable branches.
 */
export interface ChildHandle {
  /**
   * The OS pid.
   *
   * Never `undefined`, unlike `ChildProcess.pid`: {@link SessionRuntime.spawn}
   * resolves only after Node's `'spawn'` event, and a spawn that produced no
   * pid rejected instead of resolving.
   */
  readonly pid: number;
  /**
   * `Popen.stdin` -- the pipe under `stdin: "pipe"`, `null` under
   * `stdin: "ignore"`.
   *
   * Exposed as the stream object itself because two stub cases assert the
   * *identity* of this object across verbs; handing back a wrapper would make
   * them compare two different things and pass for the wrong reason.
   */
  readonly stdin: Writable | null;
  /**
   * `Popen.stdin.closed`.
   *
   * **Answers "did {@link ChildHandle.closeStdin} run?", not "is the stream
   * usable?"**, and the distinction is the whole point of the member. Node
   * destroys a child's stdin pipe *by itself* the moment the child dies, so
   * `stdin.destroyed` is `true` for any exited child whether or not anything
   * closed it; Python's `Popen.stdin.closed` is `False` there, because a
   * `Popen`'s pipe is a file object nobody touched. Measured side by side on
   * the porting host, against the **rejected** `destroyed` spelling -- node:
   * `running: stdin.destroyed = false`, then
   * `after SIGTERM, WITHOUT closeStdin(): stdin.destroyed = true`; python:
   * `running: stdin.closed = False`, then
   * `after terminate, without close(): stdin.closed = False`. The divergence
   * is the second row. What this member reports now is the flag below, so on
   * that same row it answers `false`, as Python does.
   *
   * The `destroyed` spelling is therefore *vacuous* for the two source cases
   * that use this: `test_reading_an_exited_session_releases_its_child_pipe`
   * and `test_a_refused_resume_releases_the_exited_childs_pipe` both assert
   * `stdin.closed` on a child that has already exited, so both would stay
   * green with the ported `_close_child_input` **deleted** -- and the stub's
   * own `if not stdin.closed` guard would invert, closing nothing where the
   * source closes and closing where the source skips.
   */
  stdinClosed(): boolean;
  /** `Popen.stdin.close()`. Idempotent, and a no-op when there is no pipe. */
  closeStdin(): void;
  /**
   * `session.process.stdin = <a freshly opened pipe>`.
   *
   * @internal Reached only by the port of
   * `test_a_refused_resume_releases_the_exited_childs_pipe`
   * (`tests/session/test_stub_provider.py:572`), where the source assigns over
   * `Popen.stdin` -- a plain attribute in Python, unreachable in TypeScript
   * without this member (D-0101). The case exists because `stop()` has
   * *already* closed the real pipe by the time `resume` refuses, so without a
   * replacement the assertion that follows is satisfied by the previous verb
   * and proves nothing about `resume`. Its helper `_reopened_pipe` builds one
   * with `os.pipe()`, closes the read end, and wraps the write end.
   *
   * Resets the closed-by-us flag {@link ChildHandle.stdinClosed} reports, for
   * the same reason: a replacement that inherited the flag would read as
   * already closed and make the case vacuous a second way.
   *
   * Not part of the belt's production paths -- no provider replaces a child's
   * stdin -- so it is `@internal`, never re-exported, and takes a `Writable`
   * rather than `Writable | null` because the one case that reaches it hands
   * over an open pipe.
   */
  replaceStdin(stream: Writable): void;
}

/**
 * The `Popen(...)` keyword arguments this subsystem actually uses.
 *
 * Narrower than `Popen`'s signature on purpose: the union types below are the
 * only values interlock passes, so a widening of this interface is a signal
 * that the port has started inventing spawn shapes the source has no case for.
 */
export interface SpawnOptions {
  /** `cwd=`. The source always passes an absolute path here. */
  readonly cwd: string;
  /**
   * `env=` -- an explicit, complete environment.
   *
   * Both providers build it as a copy of `os.environ` plus their own keys, and
   * Node's `env` likewise *replaces* the inherited environment rather than
   * extending it, so the mapping is direct. Omitting it would silently give
   * the child the porting host's environment without the session marker, and
   * the marker is the only proof a process group is still this session's.
   */
  readonly env: NodeJS.ProcessEnv;
  /** `subprocess.PIPE` / `subprocess.DEVNULL`. */
  readonly stdin: "pipe" | "ignore";
  /** `subprocess.DEVNULL`, or a caller-opened file descriptor. */
  readonly stdout: "ignore" | number;
  /** `subprocess.DEVNULL`, or a caller-opened file descriptor. */
  readonly stderr: "ignore" | number;
  /**
   * POSIX `start_new_session=True`.
   *
   * See {@link SessionRuntime.spawn} for what this does and does not do on
   * Windows -- it is honoured only where the source's POSIX branch runs.
   */
  readonly newProcessGroup: boolean;
}

/**
 * `subprocess.run(capture_output=True, check=False)`'s `CompletedProcess`.
 *
 * `status` carries **Python's** convention, not Node's: a child killed by
 * signal N reports `-N`. See {@link SessionRuntime.exitStatusOf}.
 */
export interface ProbeResult {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

/**
 * `subprocess.TimeoutExpired`.
 *
 * A distinct type rather than an errno-bearing `Error`, because the source
 * distinguishes it from `OSError` at three call sites and answers each with a
 * different `FailureKind`: `_run_probe` maps it to `TIMED_OUT` and `OSError`
 * to `BACKEND_UNREACHABLE`, and `_terminate`'s ladder escalates on it rather
 * than propagating. Collapsing the two into one error shape would make those
 * branches indistinguishable at the catch site.
 *
 * `Object.setPrototypeOf` for the reason every other error class in this
 * repository carries it: extending a built-in loses the prototype chain under
 * a downlevel emit and `instanceof` then silently answers `false`, which here
 * would turn "the child outlived SIGKILL" into an unhandled exception
 * escaping a verb.
 */
export class ChildTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildTimeout";
    Object.setPrototypeOf(this, ChildTimeout.prototype);
  }
}

// --------------------------------------------------------------------------
// The seam's shape
// --------------------------------------------------------------------------

/**
 * The operating-system surface the session belt is allowed to touch.
 *
 * @see sessionRuntime for the live record and the rule about call sites.
 */
export interface SessionRuntime {
  // -- spawn and capability probe ----------------------------------------

  /**
   * `subprocess.Popen(argv, **options)`.
   *
   * Asynchronous (D-0301) for one reason only: Node reports a spawn failure on
   * a **later turn**. `spawn("/no/such/binary")` returns a `ChildProcess` with
   * `pid === undefined` and fires `'error'` afterwards, where Python's `Popen`
   * raises `OSError` from the constructor. Resolving on `'spawn'` and
   * rejecting on `'error'` folds the two turns back into the one settled
   * outcome the source's `try/except OSError` expects, and it is what makes
   * `child.pid` a `number` on {@link ChildHandle}.
   */
  spawn(argv: readonly string[], options: SpawnOptions): Promise<ChildHandle>;

  /**
   * `subprocess.run([...argv], capture_output=True, timeout=, check=False)`.
   *
   * **Synchronous**, and that is a decision rather than an omission (D-0301
   * part 2): `spawnSync` was measured to match `subprocess.run(timeout=)` on
   * both branches the source distinguishes, so keeping it synchronous is what
   * lets `probeCapabilities` and the whole `interlock D-0010` gate port
   * unchanged.
   *
   * Throws the way Python raises: {@link ChildTimeout} for
   * `subprocess.TimeoutExpired`, and the underlying `NodeJS.ErrnoException`
   * for `OSError`. A non-zero exit is **not** an exception -- it is returned,
   * because `_run_probe` classifies it itself.
   */
  runProbe(argv: readonly string[], timeoutMs: number): ProbeResult;

  // -- exit ---------------------------------------------------------------

  /**
   * `Popen.poll()` -- the exit status, or `null` while the child runs.
   *
   * Python's convention is reproduced exactly: a child killed by signal N
   * reports `-N`, never `null`, because `provider_state` is rendered as
   * `exited-{returncode}` and that string is compared in ported cases.
   *
   * Reads a value libuv publishes on a loop turn, so after anything that could
   * have ended the child, call {@link SessionRuntime.settleExits} first
   * (D-0301 part 4). Without it this answers `null` for a child that is
   * already a zombie.
   */
  exitStatusOf(child: ChildHandle): number | null;

  /**
   * `Popen.wait(timeout=)`.
   *
   * Resolves with the same value {@link SessionRuntime.exitStatusOf} would
   * report. Rejects with {@link ChildTimeout} when `timeoutMs` elapses first;
   * omitting `timeoutMs` is Python's unbounded `wait()`, which the stub's
   * ladder uses after its `kill()`.
   */
  waitForExit(child: ChildHandle, timeoutMs?: number): Promise<number>;

  /**
   * One real macrotask turn, after which a finished child's exit status is
   * readable.
   *
   * **This must not be implemented with `await Promise.resolve()` or any other
   * microtask.** Measured: 5000 microtask turns leave `child.exitCode` at
   * `null` for a child that exited 1.3 seconds earlier; one `setTimeout(0)`
   * releases it. A microtask implementation is a silent defect -- everything
   * still compiles, the ladder still runs, and six cases that take a readout
   * straight after a state change become flaky in the "already exited but
   * still reads as running" direction, which under the shuffled double-green
   * order (D-0005) blames whichever case the shuffle put nearby.
   */
  settleExits(): Promise<void>;

  // -- process-group signalling -------------------------------------------

  /**
   * `os.killpg(pgid, signum)`, tolerating a group that is already gone.
   *
   * Swallows exactly `ESRCH` (`ProcessLookupError` -- the group is empty,
   * which for a stop is the desired state) and `EPERM` (`PermissionError` -- a
   * recycled pgid now owned by someone else, likewise). Every other error
   * propagates, as the source's bare `except ProcessLookupError` /
   * `except PermissionError` does.
   *
   * POSIX only, and **not gated here**: the source's callers each check
   * `os.name == "posix"` before calling, so gating inside would hide a caller
   * that forgot rather than surface it.
   */
  signalGroup(pgid: number, signal: NodeJS.Signals): void;

  /**
   * `Popen.terminate()` / `Popen.kill()` -- a signal to the leader alone.
   *
   * Used by the source's non-POSIX `_terminate` branch and by the stub's
   * ladder, both of which signal the process rather than the group.
   *
   * A child already known to have exited is passed over silently, and a
   * delivery that fails because the process vanished in between is likewise
   * silent -- `send_signal` swallows `ProcessLookupError`. Any *other* failure
   * to deliver throws, as Python's `PermissionError` does; see the
   * implementation for why the `'error'` event and not `kill()`'s boolean is
   * what carries it.
   */
  signalChild(child: ChildHandle, signal: NodeJS.Signals): void;

  // -- platform and liveness ----------------------------------------------

  /**
   * `os.name == "posix"`.
   *
   * Read from `process.platform` **at call time**, never captured at module
   * load: the one source case that exercises the non-POSIX liveness refusal
   * does it with `monkeypatch.setattr(s2.os, "name", "nt")`, and a value
   * frozen at import would give that patch nothing to bite on.
   */
  isPosix(): boolean;

  /**
   * `os.kill(pid, 0)` -- does a process with this pid exist?
   *
   * A **zombie counts as alive** here, and `EPERM` counts as alive too (it
   * exists; it is simply someone else's). Both are the source's semantics and
   * both are observable: `_child_liveness` uses this one, so an unreaped
   * orphan reads as alive there, while `_orphan_child_alive` uses
   * {@link SessionRuntime.pidRunning}, where the same zombie reads as gone.
   * That asymmetry is deliberate in the source -- do not unify them.
   */
  pidExists(pid: number): boolean;

  /**
   * Alive **and not a zombie**, via `/proc/<pid>/stat`.
   *
   * An orphan is normally reaped by init the moment it dies, but a process
   * that is nobody's init -- this one, under the test runner -- can be left
   * holding an unreaped zombie whose pid still answers signal 0. Waiting on
   * such a pid to disappear waits forever for an exit that already happened.
   */
  pidRunning(pid: number): boolean;

  /**
   * `/proc/<pid>/cmdline`, NUL bytes replaced by spaces, decoded as UTF-8 with
   * replacement. `null` means *honestly unknown*, and the callers fail closed
   * on it rather than adopting or signalling a process they cannot identify.
   */
  pidCmdline(pid: number): string | null;

  /**
   * Does any live member of process group `pgid` carry `marker` in its
   * environment?
   *
   * The positive proof the group sweep requires before it signals anything.
   * `marker` is **bytes**, compared against the raw `/proc/<pid>/environ`; see
   * the implementation for why decoding first is wrong.
   */
  groupMemberCarriesMarker(pgid: number, marker: Uint8Array): boolean;

  // -- monotonic clock -----------------------------------------------------

  /** `time.monotonic()`, in milliseconds. */
  monotonicMs(): number;

  /** `time.sleep(seconds)`, in milliseconds. */
  sleep(ms: number): Promise<void>;

  // -- durable record write -------------------------------------------------

  /**
   * Write `text` to a sibling partial file and `os.replace` it onto `path`.
   *
   * The partial's name is Python's `Path(path).with_suffix(".part")`, which
   * **replaces** the extension rather than appending to it.
   */
  writeAtomic(path: string, text: string): void;
}

// --------------------------------------------------------------------------
// Argument fences
//
// Rule 9: the port's types are wider than the source's. Every number below is
// an `int` in Python, and `int` excludes NaN, Infinity and fractions; `number`
// admits all three. Two of these values also arrive from `record.json`, which
// is attacker-shaped input in the planted-record cases, so they are checked at
// the seam as well as at the record parser.
// --------------------------------------------------------------------------

/**
 * A pid this seam will act on.
 *
 * `pid >= 1` is not pedantry. POSIX `kill(2)` reads pid `0` as *the caller's
 * own process group* and negative pids as groups, so `os.kill(0, 0)` in the
 * source answers "yes, my own group exists" rather than "yes, that process
 * exists". Interlock is safe from it only because a real `Popen` pid is never
 * 0 or negative; a *record* can carry anything. Refusing loudly beats
 * answering a question nobody asked.
 */
function assertPid(pid: number, what: string): void {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new RangeError(`${what} must be a positive integer pid, not ${String(pid)}`);
  }
}

/**
 * A pgid this seam will **signal**.
 *
 * `pgid >= 2` because of a measurement, not a hunch. `process.kill(-1, sig)`
 * is POSIX's broadcast to every process the caller may signal -- it is not a
 * check on group 1 -- and `process.kill(-0, sig)` is `kill(0, sig)`, the
 * caller's own group. Measured on the porting host: `kill(-1, 0)` succeeded
 * against a group it does not own, while `kill(-103, 0)` returned EPERM. So a
 * `pgid` of 0 or 1 arriving from a corrupt or hand-planted `record.json` turns
 * the stop ladder's SIGKILL into suicide, or into a machine-wide kill.
 *
 * This fence has **no counterpart in the source** and is outside parity's
 * reach (D-0208): no interlock case plants such a pgid, and the callers'
 * `record.pgid or record.pid` falsy-fallback already turns a recorded `0` into
 * the pid before it gets here. It is kept because the failure it prevents is
 * unrecoverable and would land on whichever process happened to be running the
 * suite.
 */
function assertSignallablePgid(pgid: number): void {
  // Two refusals, not one, because they have different reasons and a single
  // message would be wrong for whichever case it was not written for. `2.5`,
  // `NaN` and `2 ** 53` are not "below 2", and telling their caller that a
  // pgid below 2 is the caller's own group sends them looking for a `0` that
  // is not there.
  if (!Number.isSafeInteger(pgid)) {
    throw new RangeError(
      `refusing to signal process group ${String(pgid)}: a pgid must be an ` +
        "integer the platform could have issued",
    );
  }
  if (pgid < 2) {
    throw new RangeError(
      `refusing to signal process group ${String(pgid)}: a pgid below 2 means ` +
        "the caller's own group (0) or every process it may signal (1), neither " +
        "of which is a session's group",
    );
  }
}

// --------------------------------------------------------------------------
// Python string and path semantics used by the primitives
// --------------------------------------------------------------------------

/**
 * `str.split()` with no argument: split on runs of whitespace, with leading
 * and trailing whitespace discarded.
 *
 * `text.split(/\s+/)` is **not** this, and the difference is load-bearing in
 * both `/proc/<pid>/stat` parsers below. On `" S 6 17"` it yields a leading
 * `""`, shifting every field index by one; on `""` it yields `[""]`, one
 * element, where Python yields `[]` -- and `_pid_running` reads an empty field
 * list as *running*, so the naive version turns "unparseable stat" into "state
 * is the empty string, which is not Z, so running" by a different route and
 * hides that it ever happened.
 */
function pySplitWhitespace(text: string): string[] {
  const trimmed = text.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}

/**
 * The fields of a `/proc/<pid>/stat` line after the comm field.
 *
 * `text.rpartition(")")[2]` in the source, and the parse is the only correct
 * one rather than a style preference. A process's `comm` is user-controlled
 * and may contain both spaces and parentheses; measured against a process
 * named `we) ird (nm`, a naive whitespace split reports `state = "ird"` and
 * `pgrp = "S"`. It never throws -- it just yields a state that is not `"Z"`,
 * so a zombie reads as running, and a pgrp that matches nothing, so the group
 * sweep finds no members and reports success.
 *
 * `rpartition` with no separator present returns `("", "", text)`, so the
 * whole string is the tail in that case -- not the empty string. Reproduced
 * here by the `lastIndexOf` branch.
 *
 * Index map after the comm: `[0]` state, `[1]` ppid, `[2]` pgrp.
 */
function statFieldsAfterComm(text: string): string[] {
  const close = text.lastIndexOf(")");
  return pySplitWhitespace(close === -1 ? text : text.slice(close + 1));
}

/**
 * `pathlib.Path(path).with_suffix(suffix)`.
 *
 * **The extension is replaced, not appended.** `record.json` becomes
 * `record.part` and `probe-evidence.txt` becomes `probe-evidence.part`. The
 * naive `path + ".part"` is a *different file*, and the difference is visible:
 * `_remove_session_dir` unlinks one directory level, so a stray
 * `record.json.part` left by a failed write would be swept exactly like the
 * real partial while `record.part` would not, and the two names differ again
 * in the roster scan that skips entries with no `record.json`.
 *
 * Python's own rule, reproduced rather than approximated with `extname`: a
 * name has a suffix only when the dot is neither the first nor the last
 * character of the name. So `.hidden` has none (gaining `.hidden.part`) and
 * `file.` has none either (gaining `file..part`), where `path.extname("file.")`
 * answers `"."` and would produce `file.part`.
 */
function pyWithSuffix(path: string, suffix: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name;
  return join(dirname(path), stem + suffix);
}

/**
 * `str.isdigit()` restricted to ASCII, which is what `/proc` entry names are.
 *
 * Python's `isdigit()` also accepts other Unicode digit forms; no such name
 * exists under `/proc`, and admitting one here would only build a path that
 * cannot be read.
 */
function isAsciiDigits(name: string): boolean {
  return /^[0-9]+$/.test(name);
}

/** `Path.is_dir()`: follows symlinks, and answers `false` on any `OSError`. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// Exit-status translation
// --------------------------------------------------------------------------

/**
 * Signal name to number, from the platform's own table.
 *
 * `os.constants.signals` is read rather than typed out, so the numbers are the
 * host's and not this file's guess about them.
 */
const SIGNAL_NUMBERS = osConstants.signals as Partial<Record<NodeJS.Signals, number>>;

/**
 * Node's `(exitCode, signalCode)` pair as Python's single signed
 * `Popen.returncode`.
 *
 * Python packs a signal death into a negative number; Node splits it across
 * two fields and never produces a number for it. The port has to synthesise
 * the source's value because `provider_state` is rendered as
 * `exited-{returncode}` and ported cases compare that string.
 *
 * Returns `null` while both fields are `null`, which is `poll()`'s "still
 * running" -- but see {@link SessionRuntime.exitStatusOf} on why a finished
 * child can also read that way before a macrotask turn.
 */
function toPythonReturncode(
  exitCode: number | null,
  signalCode: NodeJS.Signals | null,
): number | null {
  if (exitCode !== null) {
    return exitCode;
  }
  if (signalCode === null) {
    return null;
  }
  const signum = SIGNAL_NUMBERS[signalCode];
  if (signum === undefined) {
    // Unreachable: `signalCode` is a name libuv took from this platform's own
    // signal table, which is the table `os.constants.signals` exposes. It
    // throws rather than substituting a number because every substitute is a
    // lie about how the child died -- `-1` would read as SIGHUP -- and a
    // wrong `exited-N` is the kind of defect that stays green forever.
    throw new Error(
      `the child was killed by ${signalCode}, which this platform's signal table does not name`,
    );
  }
  return -signum;
}

// --------------------------------------------------------------------------
// The real child handle
// --------------------------------------------------------------------------

/**
 * The only implementation of {@link ChildHandle}.
 *
 * Kept private so that {@link nodeChildOf} can refuse a handle this runtime
 * did not mint: with the `ChildProcess` unreachable from the interface, an
 * object literal shaped like a `ChildHandle` could otherwise be passed to
 * `waitForExit` and wait forever on nothing.
 */
class NodeChildHandle implements ChildHandle {
  readonly pid: number;
  /**
   * The Node child, for {@link nodeChildOf}.
   *
   * Held rather than passed around because every verb on a live child is a
   * method on {@link SessionRuntime} and each one needs it. It carries a
   * permanent `'error'` listener installed at spawn; the reason that listener
   * exists, and what it does and does not swallow, is written out in
   * {@link SessionRuntime.spawn}'s implementation.
   */
  readonly child: ChildProcess;

  /**
   * Mutable so {@link NodeChildHandle.replaceStdin} can substitute it, which
   * is what the source's `session.process.stdin = ...` assignment needs.
   */
  #stdin: Writable | null;

  /**
   * `Popen.stdin.closed`, tracked by us rather than asked of the stream.
   *
   * See {@link ChildHandle.stdinClosed} for the measurement: Node destroys the
   * pipe when the child dies, Python does not, so the stream's own state
   * answers a different question from the one the source asks.
   */
  #closedByUs = false;

  constructor(child: ChildProcess, pid: number) {
    this.child = child;
    this.pid = pid;
    this.#stdin = child.stdin;
  }

  /**
   * The stream object itself, so the stub cases that compare pipe *identity*
   * across verbs compare the same thing the source does.
   */
  get stdin(): Writable | null {
    return this.#stdin;
  }

  stdinClosed(): boolean {
    // `true` for a child spawned with `stdin: "ignore"`, where Python's
    // `Popen.stdin` is `None` and the stub's guard
    // (`stdin is not None and not stdin.closed`) skips the close. Encoding
    // "there is nothing to close" as "already closed" lets every caller write
    // the guard as one question.
    return this.#stdin === null ? true : this.#closedByUs;
  }

  closeStdin(): void {
    if (this.#stdin === null) {
      return;
    }
    // `destroy()` rather than `end()`, for two reasons that both come from the
    // source. First, Python's `.closed` flips *synchronously* on `close()`;
    // Node's own `.closed` flips on a later `'close'` event, so a guard reading
    // the stream's `.closed` immediately after a close would see `false` and
    // close twice. Second, `destroy()` discards anything buffered -- which is
    // safe here precisely because nothing is ever written to this pipe: it is
    // held open only so the default child has an input to block on, and
    // delivery belongs to the message bus (`interlock D-0009` / S8).
    if (!this.#stdin.destroyed) {
      this.#stdin.destroy();
    }
    // Set **outside** the `destroyed` guard. A child that exited on its own
    // has had its pipe destroyed by Node already, and that is exactly the
    // state `test_reading_an_exited_session_releases_its_child_pipe` reads
    // afterwards: skipping the flag there would make the close a no-op the
    // assertion cannot see.
    this.#closedByUs = true;
  }

  replaceStdin(stream: Writable): void {
    this.#stdin = stream;
    // A fresh pipe is open, whatever happened to the one it replaces.
    this.#closedByUs = false;
  }
}

function nodeChildOf(handle: ChildHandle): ChildProcess {
  if (!(handle instanceof NodeChildHandle)) {
    throw new TypeError(
      "this ChildHandle was not produced by sessionRuntime.spawn; the session " +
        "runtime acts only on real children",
    );
  }
  return handle.child;
}

// --------------------------------------------------------------------------
// The seam record
// --------------------------------------------------------------------------

/**
 * The session belt's replaceable operating-system surface.
 *
 * **Every internal call site goes through this record** --
 * `sessionRuntime.pidExists(...)`, never a directly imported helper -- because
 * that is the only thing that makes a patch reach production code. That
 * includes calls *inside this file*: {@link SessionRuntime.pidExists} asks
 * `sessionRuntime.isPosix()` rather than reading `process.platform`, so
 * patching `isPosix` reproduces `monkeypatch.setattr(s2.os, "name", "nt")`
 * exactly as the source case intends -- in Python that patch is seen by
 * `_pid_exists` too, not only by `_child_liveness`.
 *
 * Patched from tests with `patchSeam` from `test/testkit/seams.ts`, which
 * reproduces pytest's snapshot-at-patch-time and LIFO restore (D-0014). Each
 * substituted key needs a target-only seam-liveness case proving production
 * routes through it; a seam nothing routes through installs cleanly, goes
 * green, and exercised the real thing the whole time.
 *
 * @internal Not package API (D-0101). Never re-exported from `src/index.ts`.
 */
export const sessionRuntime: SessionRuntime = {
  spawn(argv: readonly string[], options: SpawnOptions): Promise<ChildHandle> {
    return new Promise<ChildHandle>((resolve, reject) => {
      const file = argv[0];
      if (file === undefined) {
        // `subprocess.Popen([])` raises `IndexError` on POSIX and `ValueError`
        // on Windows; the stub's backstop catches both and reports the
        // caller's settings as unusable. Neither provider reaches here with an
        // empty argv -- the stub refuses it before any spawn, on purpose, so
        // the answer does not depend on which platform's layer rejects it --
        // so this is a loud stop rather than a translated exception type.
        reject(new RangeError("cannot spawn an empty argv"));
        return;
      }

      // `detached: true` is Node's `start_new_session=True`: measured, the
      // child gets its own session as well as its own group (sid === pgid ===
      // pid), which is what makes `pgid = pid` true by construction.
      //
      // On Windows the source passes `CREATE_NEW_PROCESS_GROUP`, and Node has
      // no way to send that flag. `detached` is NOT the equivalent -- libuv
      // maps it to `DETACHED_PROCESS`, which detaches from the console instead
      // of starting a group. Passing nothing is the right divergence: the flag
      // only changes who receives CTRL_C / CTRL_BREAK, which interlock never
      // sends (its Windows branch calls `TerminateProcess` against the pid),
      // while `DETACHED_PROCESS` buys a real hazard -- a child that outlives
      // the worker keeps the events and stderr handles open, and Windows will
      // not delete an open file, so temp cleanup fails in whichever case the
      // shuffled order cleans up into.
      const detached = options.newProcessGroup && sessionRuntime.isPosix();

      const child = nodeSpawn(file, argv.slice(1), {
        cwd: options.cwd,
        env: options.env,
        stdio: [options.stdin, options.stdout, options.stderr],
        detached,
      });

      // The `'error'` listener is never removed. `ChildProcess` inherits
      // `EventEmitter`'s rule that an `'error'` event with no listener is
      // *rethrown*, and Node emits one long after the spawn settles -- a
      // `kill()` that cannot deliver EPERM emits `'error'` rather than
      // throwing. An uncaught throw there would take down the test worker from
      // outside any verb, so this listener is the backstop that keeps a stray
      // post-spawn `'error'` from doing that.
      //
      // It is a backstop and **not** the handler: `signalChild` installs its
      // own listener around the `kill()` call and rethrows what it catches, so
      // a delivery failure surfaces at the call that caused it, the way
      // `Popen.terminate()` re-raises `PermissionError`. Reaching this sink
      // after the promise has settled therefore means the error belongs to no
      // call in flight -- there is nowhere to surface it to, and Python has no
      // post-construction error channel on `Popen` to compare against -- so it
      // is swallowed rather than rethrown.
      let settled = false;
      child.on("error", (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      child.once("spawn", () => {
        if (settled) {
          return;
        }
        settled = true;
        const pid = child.pid;
        if (pid === undefined) {
          // Unreachable: `'spawn'` fires only once the process exists. Kept
          // because it is the single place the `number` on `ChildHandle.pid`
          // is established, and a silent `undefined` there would surface much
          // later as a `kill(undefined)`.
          reject(new Error("the child spawned without a pid"));
          return;
        }
        resolve(new NodeChildHandle(child, pid));
      });
    });
  },

  runProbe(argv: readonly string[], timeoutMs: number): ProbeResult {
    const file = argv[0];
    if (file === undefined) {
      throw new RangeError("cannot probe with an empty argv");
    }

    const result = spawnSync(file, argv.slice(1), {
      timeout: timeoutMs,
      // Load-bearing for the liveness of the whole suite, not a fidelity
      // detail. Node's default `killSignal` is SIGTERM where
      // `subprocess.run(timeout=)` sends `kill()`, and `timeout` is not a
      // wall-clock bound: `spawnSync` sends the signal and then keeps waiting
      // for the child to actually exit. Measured against a child that ignores
      // SIGTERM, the SIGTERM spelling returned after 3018ms for a 500ms
      // timeout and reported `status: 0, signal: null` -- a clean success --
      // with `error.code === "ETIMEDOUT"` beside it; an earlier variant that
      // never exits blocked past 120 seconds. Nothing can interrupt it,
      // because the event loop is inside the synchronous call, so vitest's
      // `testTimeout` cannot fire and the worker simply stops (D-0029 forbids
      // raising that timeout, and a larger one would not have helped).
      killSignal: "SIGKILL",
      // Python's `subprocess.run` leaves stdin inherited. Handing a
      // synchronous probe the test worker's own stdin would let it consume
      // bytes nothing else can get back, and no source case observes the
      // probe's stdin, so it is closed instead.
      stdio: ["ignore", "pipe", "pipe"],
      // `subprocess.run` has no output cap. Node's default `maxBuffer` is 1 MB
      // and turns an over-long answer into an ENOBUFS error the source has no
      // branch for -- and `claude --help` is, in the source's own words, pages
      // long.
      maxBuffer: 64 * 1024 * 1024,
    });

    // Classify on `error` **before** `status`. On the timeout path
    // `spawnSync` can report both an error and a plausible-looking status
    // (measured above), so checking `status === 0` first turns a timed-out
    // probe into a passing one.
    if (result.error !== undefined) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") {
        throw new ChildTimeout(`${file} did not answer within ${String(timeoutMs)}ms`);
      }
      // `OSError` in the source, carrying `.errno` for the failure detail.
      throw result.error;
    }

    const status = toPythonReturncode(result.status, result.signal);
    if (status === null) {
      // Unreachable: `spawnSync` returns only once the child is gone, so one
      // of `status` / `signal` is always set when there is no error.
      throw new Error(`the probe of ${file} reported neither an exit code nor a signal`);
    }
    return { status, stdout: result.stdout, stderr: result.stderr };
  },

  exitStatusOf(child: ChildHandle): number | null {
    const node = nodeChildOf(child);
    return toPythonReturncode(node.exitCode, node.signalCode);
  },

  async waitForExit(child: ChildHandle, timeoutMs?: number): Promise<number> {
    const node = nodeChildOf(child);

    // `Popen.wait()` on an already-finished child returns immediately, and it
    // has to here too: once libuv has published the exit there will be no
    // further `'exit'` event to listen for, so a listener-only implementation
    // would hang until the timeout on every second call.
    const already = toPythonReturncode(node.exitCode, node.signalCode);
    if (already !== null) {
      return already;
    }

    let timer: NodeJS.Timeout | undefined;
    let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    try {
      return await new Promise<number>((resolve, reject) => {
        onExit = (code, signal) => {
          const status = toPythonReturncode(code, signal);
          if (status === null) {
            // Unreachable: `'exit'` always carries one of the two.
            reject(new Error("the child exited reporting neither a code nor a signal"));
            return;
          }
          resolve(status);
        };
        node.once("exit", onExit);
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            reject(
              new ChildTimeout(
                `the child (pid ${String(child.pid)}) did not exit within ${String(timeoutMs)}ms`,
              ),
            );
          }, timeoutMs);
          // Deliberately NOT `timer.unref()`. An unref'd timer does not hold
          // the event loop open, so a worker with nothing else pending could
          // exit in the middle of the stop ladder -- between the SIGTERM and
          // the SIGKILL -- leaving the child running and the case reporting
          // nothing at all.
        }
      });
    } finally {
      // Cleared on **every** exit from this function, including the resolve
      // path: a live timer left behind holds the loop open for the rest of
      // `stop_timeout` after each successful wait, which under the ladder's
      // two waits plus the sweep is seconds per stop.
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (onExit !== undefined) {
        node.removeListener("exit", onExit);
      }
    }
  },

  settleExits(): Promise<void> {
    // `setTimeout(0)`, and nothing else. See the interface's note: microtasks
    // do not release `exitCode`, so `await Promise.resolve()` here would look
    // like a yield and be one, without being the *kind* of yield libuv needs.
    // `setImmediate` is also a macrotask and would very likely do, but the
    // measurement behind D-0301 was taken with `setTimeout`, so that is what
    // this ships.
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  },

  signalGroup(pgid: number, signal: NodeJS.Signals): void {
    assertSignallablePgid(pgid);
    try {
      // Node has no `killpg`; the negated pid is POSIX `kill(2)`'s own
      // spelling for "the process group", and it is what `os.killpg` calls.
      process.kill(-pgid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // `ProcessLookupError`: the group has no members, which for a stop is
      // already the desired state.
      if (code === "ESRCH") {
        return;
      }
      // `PermissionError`: a recycled pgid now owned by someone else, so the
      // group this session's child led no longer exists. The two reasons
      // differ and the source catches them separately, so they are matched on
      // `code` here rather than collapsed into one `catch`.
      if (code === "EPERM") {
        return;
      }
      throw error;
    }
  },

  signalChild(child: ChildHandle, signal: NodeJS.Signals): void {
    const node = nodeChildOf(child);

    // `Popen.send_signal` polls first and returns without signalling anything
    // if the child has already exited (bpo-38630: signalling a reaped pid is
    // how you signal whoever inherited it). Node's `kill()` guards the same
    // way through its internal handle, and reaching for the poll here as well
    // costs nothing and keeps the two readable side by side.
    if (toPythonReturncode(node.exitCode, node.signalCode) !== null) {
      return;
    }

    // A failed delivery is re-raised, because Python re-raises it:
    // `Popen.send_signal` swallows only `ProcessLookupError` and lets
    // `PermissionError` out, and all five call sites the port has --
    // `stub_provider.py:369/373`, `claude_cli_provider.py:971/1198/1205` --
    // are bare `terminate()` / `kill()` calls that would propagate it.
    //
    // The synchronous evidence is the `'error'` event, not the boolean. Read
    // from Node v22.17.0's own `ChildProcess.prototype.kill`: ESRCH returns
    // `false` quietly, EINVAL / ENOSYS *throw* (so they propagate here without
    // help), and every other errno -- EPERM among them -- reaches
    // `this.emit('error', ...)`, a plain synchronous `emit` inside `kill()`.
    // A listener installed around the call therefore has the error in hand by
    // the time `kill()` returns.
    //
    // The boolean cannot do this job: `kill()` answers `false` for a child
    // that was already gone *and* for one it could not signal, and the first
    // is the case Python explicitly passes over. Throwing on `false` would
    // turn every ordinary second SIGTERM in the stop ladder into an exception.
    //
    // If a future Node ever deferred that `emit` to a later turn, this
    // degrades to the previous behaviour -- the permanent sink from `spawn`
    // swallows it and nothing is thrown -- rather than to a crash.
    let deliveryError: Error | undefined;
    const capture = (error: Error): void => {
      deliveryError = error;
    };
    node.on("error", capture);
    try {
      // The return value is otherwise dropped for the reason Python drops it:
      // signalling is not evidence of stopping, and the source takes its
      // readout after the wait, never from the signal.
      node.kill(signal);
    } finally {
      node.removeListener("error", capture);
    }
    if (deliveryError !== undefined) {
      throw deliveryError;
    }
  },

  isPosix(): boolean {
    return process.platform !== "win32";
  },

  pidExists(pid: number): boolean {
    assertPid(pid, "pidExists");
    // Through the record, so a patched `isPosix` reaches here exactly as
    // `monkeypatch.setattr(s2.os, "name", "nt")` reaches `_pid_exists`.
    // `false` rather than an error: the callers gate on the platform first,
    // and this is the source's answer on a platform where the question has no
    // POSIX meaning.
    if (!sessionRuntime.isPosix()) {
      return false;
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        return false;
      }
      if (code === "EPERM") {
        // It exists; it is simply owned by someone else. Reporting `false`
        // here would let the stop ladder conclude a foreign process on a
        // recycled pid had "exited".
        return true;
      }
      throw error;
    }
    return true;
  },

  pidRunning(pid: number): boolean {
    assertPid(pid, "pidRunning");
    if (!sessionRuntime.pidExists(pid)) {
      return false;
    }
    let text: string;
    try {
      text = readFileSync(join("/proc", String(pid), "stat"), "utf8");
    } catch {
      // No `/proc` -- macOS, or a hardened mount. The pid answered signal 0,
      // so "running" is the honest answer and the zombie refinement is simply
      // unavailable. `errors="replace"` in the source is Node's default
      // decode behaviour for `"utf8"`, which substitutes U+FFFD rather than
      // throwing.
      return true;
    }
    const fields = statFieldsAfterComm(text);
    const state = fields[0];
    return state === undefined || state !== "Z";
  },

  pidCmdline(pid: number): string | null {
    assertPid(pid, "pidCmdline");
    let raw: Buffer;
    try {
      raw = readFileSync(join("/proc", String(pid), "cmdline"));
    } catch {
      // Honestly unknown. The callers fail closed on `null` -- a live pid
      // whose command line cannot be read is a hard refusal to adopt, signal
      // or resume around it, never a quiet `false`.
      return null;
    }
    // Substituted in **bytes**, as the source does. NUL is a single 0x00 byte
    // in UTF-8 and never occurs inside a multi-byte sequence, so decoding
    // first would give the same answer here -- but the byte form is what the
    // source pins, and it stays correct if the argv is ever not UTF-8.
    const bytes = Buffer.from(raw);
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 0) {
        bytes[i] = 0x20;
      }
    }
    // A zombie's cmdline is **zero bytes** -- not missing, not stale, empty --
    // so this is a successful read of a string that contains no session UUID.
    // Benign only because `pidRunning`'s `Z` check runs first in
    // `_orphan_child_alive`; reordering the two would read our own exited
    // child as "a stranger on a recycled pid".
    return bytes.toString("utf8");
  },

  groupMemberCarriesMarker(pgid: number, marker: Uint8Array): boolean {
    // Not `assertSignallablePgid`: a comparison against a pgid of 0 or 1 is
    // inert, and the source answers `False` for a group with no marked
    // members rather than refusing. But a non-integer would stringify to
    // something no `stat` field can equal, so the sweep would silently report
    // "nothing here is ours" -- which reads as success -- and that is refused
    // loudly instead.
    if (!Number.isSafeInteger(pgid)) {
      throw new RangeError(`groupMemberCarriesMarker needs an integer pgid, not ${String(pgid)}`);
    }
    // Requires `/proc`: both the group roster and each member's environment
    // are read from it, and where it does not exist the honest answer is that
    // nothing can be verified -- returned as `false` so that no unverified
    // group is ever signalled. Killing what cannot be proven ours is the
    // worse failure.
    if (!isDirectory("/proc")) {
      return false;
    }
    const target = String(pgid);
    // An `OSError` from the directory listing propagates, as `iterdir()`'s
    // does: a `/proc` that cannot be listed is not a `/proc` with no members.
    for (const name of readdirSync("/proc")) {
      if (!isAsciiDigits(name)) {
        continue;
      }
      let text: string;
      try {
        text = readFileSync(join("/proc", name, "stat"), "utf8");
      } catch {
        // The process exited between the listing and the read.
        continue;
      }
      const fields = statFieldsAfterComm(text);
      if (fields.length < 3 || fields[2] !== target || fields[0] === "Z") {
        continue;
      }
      let environ: Buffer;
      try {
        environ = readFileSync(join("/proc", name, "environ"));
      } catch {
        // Measured: this is **EACCES**, not ENOENT, for any process we do not
        // own -- so a foreign member of the group lands here on every scan.
        // Skipping it is what makes an unverifiable group read as unverified,
        // and hence untouched.
        continue;
      }
      // A plain substring test over the raw bytes, matching the source's
      // `marker in environ`. `/proc/<pid>/environ` is NUL-*terminated*, so
      // decoding it into a string and splitting on NUL invents a trailing
      // empty entry; and an entry with a legitimately empty value (`FOO=`)
      // survives the round trip and must not be filtered out. Comparing bytes
      // sidesteps both. Note the consequence the source accepts: the match is
      // a substring, so `NAME=<uuid>` also matches a longer value carrying
      // that prefix.
      if (environ.indexOf(marker) !== -1) {
        return true;
      }
    }
    return false;
  },

  monotonicMs(): number {
    // `performance.now()` and not `Date.now()`: the deadline loops compare
    // against a value taken before the first poll, and a wall clock stepped
    // backwards by NTP mid-stop would move the deadline into the future and
    // hold the loop past its bound. That is the reason the source uses
    // `time.monotonic()` rather than `time.time()`, and it is the same reason
    // here.
    return performance.now();
  },

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      // Not `unref()`-ed, for the same reason `waitForExit`'s timer is not:
      // the poll loops in the stop ladder are the only pending work at that
      // moment, and an unref'd timer would let the worker exit between two
      // polls with the child still running.
      setTimeout(resolve, ms);
    });
  },

  writeAtomic(path: string, text: string): void {
    const partial = pyWithSuffix(path, ".part");
    writeFileSync(partial, text, "utf8");
    // `os.replace`: atomic within a filesystem and overwrites an existing
    // destination. No `fsync` -- the source does none here, and adding one
    // would change what a crash between the two writes leaves behind, which
    // is the property the commit-before-spawn ordering is about.
    //
    // Failures propagate as the `OSError` they translate: `_spawn` catches
    // one around the first write and answers REFUSED_BY_PROVIDER, and catches
    // one around the second write and *kills the child*, so swallowing
    // anything here would leave an unadoptable process running.
    renameSync(partial, path);
  },
};
