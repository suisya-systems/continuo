/**
 * The controller: spawn, barrier, kill, restart, cleanup.
 *
 * Ported from interlock `tests/fault_injection/controller.py` at `65f36c5`.
 *
 * Design sections 3 (the two-phase barrier), 5 (combination semantics), 7 (the
 * injected clock) and 8 (OS policy, signal hygiene and cleanup). **Durable**: it
 * speaks only the fault-runner contract and holds a `CaseAdapter`; it never
 * imports an implementation module.
 *
 * The one paragraph worth reading before the code: **the kill is always a real
 * signal from outside the process.** Phase one is the driver announcing that it
 * is inside the named window and blocking on its control pipe; phase two is
 * `process.kill(pid, "SIGKILL")`. No reply is ever written for a kill case --
 * the blocked read is torn down by the kill -- and the controller then asserts
 * the exit status, because a role process that exited any other way failed the
 * case as a *harness* error and must be attributable as one.
 *
 * **Asynchrony is the one structural adaptation.** The source is synchronous:
 * it blocks a thread on a queue while a reader thread fills it. Node has no
 * blocking read on a child's pipe, so every method that waits for the driver is
 * `async` and the cases `await` it. Nothing about the *ordering* changes -- the
 * barrier is still what sequences the run, and the waits are still bounded by
 * the same host-monotonic deadlines -- but the shape of every call site does.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import Database from "better-sqlite3";

import * as contract from "./contract.js";
import {
  ArmedAnchor,
  type CaseAdapter,
  ContractViolation,
  type DestinationObserver,
  EVENT_CHECKPOINT,
  EVENT_DONE,
  EVENT_ERROR,
  EVENT_HELLO,
  EVENT_RECOVERY_COMPLETE,
  EVENT_SYNC,
  type FaultCase,
  Handshake,
  type InvariantRow,
} from "./contract.js";

/**
 * How long the teardown ladder waits between `SIGTERM` and `SIGKILL`
 * (design 8.2). Host monotonic time, never the injected clock.
 */
export const TEARDOWN_GRACE_S = 2.0;

const POSIX = process.platform !== "win32";

/** `SIGKILL`'s number, for the negative exit status a killed process reports. */
const SIGKILL_NUMBER = 9;

/**
 * A case failed, with the reproduction line attached.
 *
 * Thrown *instead of* re-instantiating whatever the original error was: the
 * harness can surface errors whose constructors take more than a message, and
 * rebuilding one of those from a string turns a real failure into an error
 * about reporting it. The original is always the `cause`.
 */
export class CaseFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CaseFailure";
  }
}

/** An armed barrier was never reached. A harness fault, not a component one. */
export class BarrierTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BarrierTimeout";
  }
}

/**
 * A role process did not exit within the time the wait allowed.
 *
 * The counterpart of Python's `subprocess.TimeoutExpired`, and it exists because
 * of a divergence that is easy to miss: `Popen.wait(timeout=...)` RAISES, so in
 * the source the line after it -- `process.reaped = True` -- is simply not
 * reached when the wait times out, and the still-live child therefore stays
 * eligible for the teardown ladder. A port whose wait merely RETURNS would mark
 * that child reaped, teardown's `reaped` fast path would skip signalling it, and
 * a live process could go on mutating the case's database after the case had
 * moved on. Raised by the review gate on this change.
 */
export class ProcessWaitTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessWaitTimeout";
  }
}

/** A case outran its budget (design 9). Converted from a CI hang. */
export class CaseTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseTimeout";
  }
}

/** The file a manifest case lives in, named by the reproduction line. */
export const CASE_TEST_FILE = "test/fault_injection/cases.test.ts";

/**
 * The title of one manifest case, as Vitest's `-t` matches it.
 *
 * The LEAF title, deliberately, and not the `describe > test` path. MEASURED on
 * vitest 4.1.11 against this very file:
 *
 * - `-t 'the manifest cases > run one manifest case\[disp__...\]'` selects
 *   **nothing** (22 skipped) -- `-t` does not match the joined path;
 * - `-t 'run one manifest case\[disp__...\]'` selects **exactly one** (1
 *   passed, 21 skipped).
 *
 * The leaf title is still unique across the file, because the case id is, so
 * naming it selects one test and not three -- which is the property the source
 * builds its whole reproduction line around.
 */
export function caseTestTitle(caseId: string): string {
  return `run one manifest case[${caseId}]`;
}

/**
 * Escape a test title for Vitest's `-t`.
 *
 * `-t` is a **regular expression**, not a literal substring -- and a manifest
 * case title is full of characters that mean something in one. `[disp__...]`
 * reads as a CHARACTER CLASS, so the pattern matches a single character from
 * that set and selects nothing; a combination case id additionally contains `+`
 * (`sup+disp__...`), which is a quantifier. MEASURED on vitest 4.1.11: the
 * unescaped title selects **0** of this file's 22 tests and the run then exits
 * reporting success, while the escaped one selects exactly **1**. Reporting
 * success while running nothing is precisely the failure mode the source warns
 * about for pytest's `-k` and takes pains to avoid, so inheriting it in a new
 * spelling would be losing the property rather than translating it.
 *
 * Every ECMAScript regular-expression metacharacter is escaped, including `-`
 * (meaningful inside a class) and `/` (a delimiter if the value is ever pasted
 * into a literal). Raised by the review gate on this change.
 */
export function escapeTestNamePattern(title: string): string {
  return title.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

export interface EventRecord {
  readonly event?: string;
  readonly [key: string]: unknown;
}

/**
 * The single reproduction line a failing case prints (design 4.4).
 *
 * It carries the profile as well as the seed, because the profile is a third
 * input to *selection*: two thirds of the matrix is `full`-only, and the re-run
 * of a nightly failure under the default `fast` profile would collect no tests
 * at all and report success by collecting nothing.
 *
 * Same case id, same suite seed, same manifest version give the same armed
 * windows, the same payloads and the same schedule decisions.
 */
export function reproLine(options: {
  caseId: string;
  suiteSeed: number;
  manifestVersion: number;
  contractVersion?: number;
  resolvedSkewMs?: number | null;
  profile?: string | null;
}): string {
  const contractVersion = options.contractVersion ?? contract.FAULT_RUNNER_CONTRACT_VERSION;
  const resolvedSkewMs = options.resolvedSkewMs ?? null;
  const profile = options.profile ?? "fast";
  // Single-quoted on both shells so the backslashes the escape introduces reach
  // Vitest intact: inside POSIX double quotes a backslash is consumed by the
  // shell, and PowerShell treats single quotes as fully literal.
  const pattern = escapeTestNamePattern(caseTestTitle(options.caseId));
  const testId = `${CASE_TEST_FILE} -t '${pattern}'`;
  // Spelled for the shell of the host that printed it. The line exists to be
  // pasted, and POSIX `VAR=value cmd` is a syntax error in both PowerShell and
  // cmd.exe -- so on the Windows jobs the advertised way to reproduce a failure
  // would not run.
  const command =
    process.platform === "win32"
      ? `$env:S9_PROFILE='${profile}'; $env:S9_SUITE_SEED='${options.suiteSeed}'; ` +
        `npx vitest run ${testId}`
      : `S9_PROFILE=${profile} S9_SUITE_SEED=${options.suiteSeed} npx vitest run ${testId}`;
  return (
    `S9-REPRO case_id=${options.caseId} suite_seed=${options.suiteSeed} ` +
    `manifest_version=${options.manifestVersion} contract_version=${contractVersion} ` +
    `resolved_skew_ms=${resolvedSkewMs} profile=${profile}\n` +
    `S9-RERUN ${command}`
  );
}

/**
 * One role process: an independent PID with an independent connection.
 *
 * The source's reader thread becomes a `data` handler that splits the child's
 * event pipe on newlines; `events` is the same queue with the same two
 * sentinels -- an event, or `null` for end of stream.
 */
export class RoleProcess {
  readonly role: string;
  readonly child: ChildProcess;
  readonly generation: number;
  readonly stderrPath: string;
  readonly pgid: number | null;
  readonly trace: EventRecord[] = [];
  reaped = false;
  stopped = false;
  /** Set by the `exit` handler. Node always reaps, so this is also "pid may be recycled". */
  exited = false;
  exitStatus: number | null = null;
  /**
   * The last error the control pipe reported, kept for a failure report.
   *
   * Never thrown from. See the `error` listener installed in the constructor for
   * why swallowing is the source's stance and not a shortcut.
   */
  controlWriteError: Error | null = null;

  /** Events read but not yet consumed, and the waiters queued for them. */
  private readonly pending: (EventRecord | null)[] = [];
  private readonly waiters: ((value: EventRecord | null) => void)[] = [];
  private buffer = "";

  constructor(options: {
    role: string;
    child: ChildProcess;
    generation: number;
    stderrPath: string;
    pgid: number | null;
  }) {
    this.role = options.role;
    this.child = options.child;
    this.generation = options.generation;
    this.stderrPath = options.stderrPath;
    this.pgid = options.pgid;

    const stdout = this.child.stdout;
    if (stdout === null) {
      throw new ContractViolation(`${this.role}: the driver was spawned without an event pipe`);
    }
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line === "") {
          continue;
        }
        try {
          this.push(JSON.parse(line) as EventRecord);
        } catch {
          this.push({ event: EVENT_ERROR, type: "MalformedEvent" });
        }
      }
    });
    stdout.on("end", () => {
      this.push(null);
    });
    stdout.on("error", () => {
      this.push(null);
    });
    const stdin = this.child.stdin;
    if (stdin !== null) {
      // A control-pipe error is recorded and swallowed, never thrown.
      //
      // THE SOURCE GETS THIS FROM A LANGUAGE DIFFERENCE. Python's
      // `stdin.write()`/`flush()` raise `BrokenPipeError` SYNCHRONOUSLY, so its
      // `try/except (BrokenPipeError, ValueError): pass` really does catch the
      // case its comment describes -- "the driver is gone; for a kill case that
      // is the expected shape and the caller's own exit-status assertion is the
      // authority". Node reports the same condition ASYNCHRONOUSLY through the
      // stream's `error` event, so the synchronous `try/catch` in `send()`
      // cannot see it -- and a stream `error` with no listener is thrown
      // globally, which would take down the Vitest worker instead of producing
      // an attributable case failure. That is the opposite of what this harness
      // exists to do: a driver dying is a thing cases DELIBERATELY cause.
      //
      // Recorded rather than merely discarded, so a report can still say the
      // pipe broke. Raised by the review gate on the rebased tip.
      stdin.on("error", (error: Error) => {
        this.controlWriteError = error;
      });
    }
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      // Python's `Popen.returncode`: the exit code, or the negated signal
      // number when the process was terminated by a signal.
      this.exitStatus = signal === null ? (code ?? 0) : -signalNumber(signal);
    });
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  private push(event: EventRecord | null): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(event);
      return;
    }
    this.pending.push(event);
  }

  /** Write one command line to the driver's control pipe. */
  send(command: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (stdin === null || stdin.destroyed || !stdin.writable) {
      // The driver is gone. For a kill case that is the expected shape and the
      // caller's own exit-status assertion is the authority.
      return;
    }
    try {
      // The callback consumes the asynchronous failure too: without one, a write
      // that fails after this call returns surfaces only on the stream's `error`
      // event. The listener installed in the constructor is the backstop; this
      // is the per-write half.
      stdin.write(`${stableStringify(command)}\n`, (error) => {
        if (error) {
          this.controlWriteError = error;
        }
      });
    } catch (error) {
      // The synchronous half, which is the one Python's `except BrokenPipeError`
      // sees.
      this.controlWriteError = error as Error;
    }
  }

  async nextEvent(timeoutS: number): Promise<EventRecord> {
    const event = await this.take(timeoutS);
    if (event === undefined) {
      throw new BarrierTimeout(
        `${this.role}: no protocol event within ${timeoutS.toFixed(1)}s; ` +
          `trace so far: ${JSON.stringify(this.trace)}`,
      );
    }
    if (event === null) {
      throw new BarrierTimeout(
        `${this.role}: the event pipe closed while an event was expected; ` +
          `stderr is at ${this.stderrPath}`,
      );
    }
    this.trace.push(event);
    return event;
  }

  /** Consume events until one of `kinds` arrives. */
  async waitForEvent(kinds: Iterable<string>, timeoutS: number): Promise<EventRecord> {
    const wanted = new Set(kinds);
    const deadline = monotonicS() + timeoutS;
    for (;;) {
      const remaining = deadline - monotonicS();
      if (remaining <= 0) {
        throw new BarrierTimeout(
          `${this.role}: waited ${timeoutS.toFixed(1)}s for one of ` +
            `${JSON.stringify([...wanted].sort())}; trace: ${JSON.stringify(this.trace)}`,
        );
      }
      const event = await this.nextEvent(remaining);
      if (event.event !== undefined && wanted.has(event.event)) {
        return event;
      }
      if (event.event === EVENT_ERROR) {
        throw new Error(
          `${this.role}: the driver reported ${JSON.stringify(event["type"])}; ` +
            `stderr is at ${this.stderrPath}`,
        );
      }
    }
  }

  /** Read to end of stream, so the trace is complete for a report. */
  async drain(timeoutS: number): Promise<void> {
    const deadline = monotonicS() + timeoutS;
    for (;;) {
      const remaining = deadline - monotonicS();
      if (remaining <= 0) {
        return;
      }
      const event = await this.take(remaining);
      if (event === undefined || event === null) {
        return;
      }
      this.trace.push(event);
    }
  }

  /**
   * One event, `null` at end of stream, or `undefined` when the wait timed out.
   *
   * The source's `queue.get(timeout=...)`. A timed-out waiter is removed from
   * the queue so a later event does not resolve a promise nobody is holding.
   */
  private take(timeoutS: number): Promise<EventRecord | null | undefined> {
    const ready = this.pending.shift();
    if (ready !== undefined) {
      return Promise.resolve(ready);
    }
    return new Promise((resolve) => {
      let settled = false;
      const waiter = (value: EventRecord | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(waiter);
      const timer = setTimeout(
        () => {
          if (settled) {
            return;
          }
          settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          resolve(undefined);
        },
        Math.max(0, timeoutS * 1000),
      );
      // A pending timer must not hold the process open on its own.
      timer.unref?.();
    });
  }

  /** Resolves once the child has exited, or after `timeoutS`. */
  async waitForExit(timeoutS: number): Promise<number | null> {
    if (this.exited) {
      return this.exitStatus;
    }
    const deadline = monotonicS() + timeoutS;
    while (!this.exited && monotonicS() < deadline) {
      await delay(5);
    }
    return this.exitStatus;
  }
}

/** `JSON.stringify` with sorted keys, matching the source's `sort_keys=True`. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return item;
  });
}

/** Host monotonic seconds. Never the injected clock (design 7). */
function monotonicS(): number {
  return Number(process.hrtime.bigint() / 1_000_000n) / 1000;
}

function signalNumber(signal: NodeJS.Signals): number {
  const known = osConstants.signals as unknown as Record<string, number | undefined>;
  return known[signal] ?? SIGKILL_NUMBER;
}

/**
 * Spawn / barrier / kill / restart / cleanup for one case.
 *
 * Every timeout below runs on the **host monotonic clock** and is never skewed:
 * the injected clock models the wall clock, which is what lease expiry
 * arithmetic uses, and a harness that skewed its own watchdogs would have no way
 * of noticing it had hung (design 7).
 */
export class Controller {
  readonly profile: string | null;
  readonly workdir: string;
  readonly adapter: CaseAdapter;
  readonly case: FaultCase;
  readonly suiteSeed: number;
  readonly barrierTimeoutS: number;
  readonly caseTimeoutS: number;
  readonly dbPath: string;
  readonly processes = new Map<string, RoleProcess>();

  private readonly spawned: RoleProcess[] = [];
  private readonly deadline: number;

  constructor(options: {
    workdir: string;
    adapter: CaseAdapter;
    case: FaultCase;
    suiteSeed: number;
    barrierTimeoutS: number;
    caseTimeoutS: number;
    profile?: string | null;
  }) {
    this.profile = options.profile ?? null;
    this.workdir = options.workdir;
    this.adapter = options.adapter;
    this.case = { ...options.case };
    this.suiteSeed = Math.trunc(options.suiteSeed);
    this.barrierTimeoutS = options.barrierTimeoutS;
    this.caseTimeoutS = options.caseTimeoutS;
    this.dbPath = join(this.workdir, "control-plane.sqlite3");
    this.deadline = monotonicS() + this.caseTimeoutS;
    mkdirSync(this.workdir, { recursive: true });
  }

  // -- lifecycle ---------------------------------------------------------

  bootstrap(): void {
    this.checkDeadline();
    this.adapter.bootstrap(this.dbPath, {
      roles: this.case["targets"] as string[],
      nowMs: Math.trunc(this.case["clock_base_ms"] as number),
    });
  }

  private checkDeadline(): void {
    if (monotonicS() > this.deadline) {
      throw new CaseTimeout(
        `${this.case["case_id"]} outran its ${this.caseTimeoutS.toFixed(0)}s budget ` +
          "(design 9); teardown ran and the trace is attached",
      );
    }
  }

  private remaining(wantS: number): number {
    return Math.max(0.1, Math.min(wantS, this.deadline - monotonicS()));
  }

  /**
   * Start one role process: separate OS process, separate session.
   *
   * `key` names the process slot. It defaults to the role, and differs only for
   * a second process of the same role -- the claimant a lease takeover needs,
   * which is the same script under a different holder identity.
   */
  async spawn(
    role: string,
    options: {
      armed?: readonly ArmedAnchor[];
      generation?: number;
      clockOffsetMs?: number;
      key?: string | null;
      extraArguments?: readonly string[];
    } = {},
  ): Promise<RoleProcess> {
    this.checkDeadline();
    const armed = options.armed ?? [];
    const generation = options.generation ?? 0;
    const clockOffsetMs = options.clockOffsetMs ?? 0;

    const { executable, prefixArguments } = this.adapter.driverCommand();
    const commandArguments = [
      ...prefixArguments,
      "--role",
      role,
      "--db",
      this.dbPath,
      "--case-id",
      String(this.case["case_id"]),
      "--suite-seed",
      String(this.suiteSeed),
      "--armed",
      armed.map((anchor) => anchor.wire()).join(","),
      "--clock-base-ms",
      String(this.case["clock_base_ms"]),
      "--clock-offset-ms",
      String(clockOffsetMs),
      "--restart-generation",
      String(generation),
      "--control-fd",
      "0",
      "--event-fd",
      "1",
      ...this.adapter.roleArguments(role, { case: this.case, workdir: this.workdir }),
      // Appended last so a repeated option wins: this is how a claimant gets a
      // different holder identity without the adapter growing a second code
      // path for it.
      ...(options.extraArguments ?? []),
    ];

    const slot = options.key ?? role;
    const stderrPath = join(this.workdir, `${slot}-g${generation}.stderr`);
    const stderrFd = openSync(stderrPath, "w");
    let child: ChildProcess;
    try {
      child = spawn(executable, commandArguments, {
        stdio: ["pipe", "pipe", stderrFd],
        // Its own session and process group, so a stray grandchild cannot be
        // confused with it and the group can be signalled as a unit.
        detached: POSIX,
        env: childEnvironment(),
      });
    } finally {
      closeSync(stderrFd);
    }

    const roleProcess = new RoleProcess({
      role,
      child,
      generation,
      stderrPath,
      pgid: POSIX ? (child.pid ?? null) : null,
    });
    this.processes.set(slot, roleProcess);
    this.spawned.push(roleProcess);

    const hello = await roleProcess.waitForEvent(
      [EVENT_HELLO],
      this.remaining(this.barrierTimeoutS),
    );
    new Handshake({
      protocolVersion: Number(hello["protocol_version"]),
      contractVersion: Number(hello["contract_version"]),
      role: String(hello["role"]),
      caseId: String(hello["case_id"]),
      restartGeneration: Number(hello["restart_generation"]),
    }).check({
      // Versions and vocabulary membership are not enough. A driver that
      // answered with a *valid* but different role, case or generation would
      // still be recorded under the slot the controller asked for, so the
      // harness would drive one role while reporting another -- or run
      // generation 0 twice and call the second one a restart. The handshake is
      // the only place that can catch it, because every later event is
      // correlated by the slot rather than by the wire.
      expectRole: role,
      expectCaseId: String(this.case["case_id"]),
      expectGeneration: generation,
    });
    return roleProcess;
  }

  /**
   * A second claimant on the same resource, under its own clock.
   *
   * `armed` and `behaviours` are the claimant's own, and deliberately not the
   * case's. A claimant that inherited the case's behaviours would apply them to
   * the incumbent too -- which for the single-writer cases would fence out the
   * writer that is supposed to *win*, inverting the case. And a claimant that
   * could not be armed could only ever be run to completion, so "concurrently"
   * could never mean two live processes.
   */
  async spawnClaimant(
    role: string,
    options: {
      holderSuffix: string;
      clockOffsetMs: number;
      armed?: readonly ArmedAnchor[];
      behaviours?: readonly string[];
    },
  ): Promise<RoleProcess> {
    const holder = `${this.adapter.holderOf(role)}-${options.holderSuffix}`;
    const extra: string[] = ["--holder", holder];
    for (const behaviour of options.behaviours ?? []) {
      extra.push("--behaviour", behaviour);
    }
    return this.spawn(role, {
      armed: options.armed ?? [],
      clockOffsetMs: options.clockOffsetMs,
      key: claimantKey(role),
      extraArguments: extra,
    });
  }

  // -- barrier -----------------------------------------------------------

  /** Wait until `role` reports it is blocked inside its armed window. */
  async waitAtAnchor(role: string): Promise<EventRecord> {
    const roleProcess = this.require(role);
    return roleProcess.waitForEvent(
      [EVENT_CHECKPOINT, EVENT_SYNC],
      this.remaining(this.barrierTimeoutS),
    );
  }

  /**
   * Aligned mode (design 5): wait until *every* target is blocked.
   *
   * No kill is issued before the barrier is complete, so the kill set is applied
   * to a system in a known joint state -- which is what "in combination" means
   * here, rather than a race between siblings.
   */
  async barrierAligned(roles: readonly string[]): Promise<Record<string, EventRecord>> {
    const at: Record<string, EventRecord> = {};
    for (const role of roles) {
      at[role] = await this.waitAtAnchor(role);
    }
    return at;
  }

  /** Phase two, pass-through case: reply `continue` and let it proceed. */
  release(role: string): void {
    this.require(role).send({ cmd: contract.CMD_CONTINUE });
  }

  /**
   * Move one role's injected clock while it is blocked at a barrier.
   *
   * Per-role by construction (design 7): skew between roles is two offsets,
   * never a global shift, and the host clock is never touched.
   */
  async setClockOffset(role: string, offsetMs: number): Promise<EventRecord> {
    const roleProcess = this.require(role);
    roleProcess.send({ cmd: contract.CMD_SET_CLOCK_OFFSET, offset_ms: Math.trunc(offsetMs) });
    return roleProcess.waitForEvent(
      [contract.EVENT_CLOCK_OFFSET],
      this.remaining(this.barrierTimeoutS),
    );
  }

  // -- faults ------------------------------------------------------------

  /**
   * Phase two: a real, uncatchable kill of a process inside its window.
   *
   * The exit status is asserted to be `-SIGKILL` **wherever the platform can
   * report it**, which is every POSIX host regardless of the case's lane. Keying
   * that check on the lane instead would have left the twelve (role x window)
   * cells that gate item 4 is read from -- all on the portable lane -- accepting
   * a role process that exited any other way, including one that was never
   * killed at all. The lane governs where *gate evidence* is read from
   * (design 8.1); it does not govern whether the harness checks its own work.
   */
  async kill(role: string, options: { assertExitStatus?: boolean } = {}): Promise<number | null> {
    const assertExitStatus = options.assertExitStatus ?? POSIX;
    const roleProcess = this.require(role);
    if (roleProcess.reaped || roleProcess.exited) {
      // Already gone: its pid may have been recycled, and signalling a recycled
      // id is the one thing design section 8.2 forbids outright. The recorded
      // exit status is the answer, and for a kill case it is the wrong one --
      // which is the point.
      //
      // `exited` counts here, not just `reaped`, and that is the Node
      // difference again. In the source this branch tests `reaped` alone and
      // the fall-through `os.kill` is SAFE for a process that exited on its
      // own: an un-waited-for child is a zombie, and a zombie's pid cannot be
      // recycled, so the signal either lands on the zombie or raises
      // `ProcessLookupError`, which the source catches. Node reaps every child
      // the moment it exits, so "exited but not reaped by us" is precisely the
      // window in which the pid IS available for reuse -- and signalling it
      // could hit an unrelated process. Raised by the review gate on the
      // integrated tip.
      const status = roleProcess.exitStatus;
      if (assertExitStatus && status !== -SIGKILL_NUMBER) {
        throw new ContractViolation(
          `${role} exited ${status}, not -SIGKILL: the case did not inject the crash it ` +
            "claims to have injected",
        );
      }
      return status;
    }
    if (POSIX) {
      try {
        process.kill(roleProcess.pid, "SIGKILL");
      } catch {
        // It died on its own between the barrier and the kill. Not an error
        // here: the exit-status assertion below is what decides whether the case
        // still means anything.
      }
      // Sweep the group so a grandchild cannot outlive the leader holding the
      // controller's pipe open.
      //
      // THE ONE PLACE THE PORT CANNOT REPRODUCE THE SOURCE'S ORDERING. The
      // source sweeps the group *after* the leader is dead but deliberately
      // *before* it is reaped, because an unreaped zombie's pid -- and so its
      // pgid -- cannot be recycled, which is the only window in which sweeping
      // the group is provably safe. Node reaps every child automatically (there
      // is no `waitid(WNOWAIT)` equivalent and no way to decline the reap), so
      // that window is not available. Sweeping is therefore done here, straight
      // after the signal and before the exit is observed, and is skipped
      // entirely once `exited` is set -- signalling a possibly-recycled group is
      // the worse of the two failures.
      if (roleProcess.pgid !== null && !roleProcess.exited) {
        try {
          process.kill(-roleProcess.pgid, "SIGKILL");
        } catch {
          // Gone, or not ours.
        }
      }
    } else {
      roleProcess.child.kill("SIGKILL");
    }
    const status = await roleProcess.waitForExit(this.remaining(this.barrierTimeoutS));
    // Only once the exit is CONFIRMED. A wait that timed out leaves a possibly
    // live child, and marking it reaped would take it out of teardown's ladder
    // -- see ProcessWaitTimeout for why the source gets this for free.
    if (!roleProcess.exited) {
      throw new ProcessWaitTimeout(
        `${role} did not exit after the kill within the wait; it is left unreaped so teardown ` +
          "still signals it",
      );
    }
    roleProcess.reaped = true;
    if (assertExitStatus && status !== -SIGKILL_NUMBER) {
      throw new ContractViolation(
        `${role} exited ${status}, not -SIGKILL: the case did not inject the crash it claims ` +
          "to have injected",
      );
    }
    this.unwedge(role);
    return status;
  }

  /** Pause a holder so its lease can lapse under it (Linux lane only). */
  sigstop(role: string): void {
    if (!POSIX) {
      throw new ContractViolation("SIGSTOP cases are Linux-lane only (design 8.1)");
    }
    const roleProcess = this.require(role);
    if (roleProcess.exited || roleProcess.reaped) {
      // Same pid-reuse rule as `kill`. A holder that died before it could be
      // paused is a case that cannot mean what it says, so this refuses rather
      // than signalling into the dark.
      throw new ContractViolation(
        `${role} had already exited when the case tried to pause it; SIGSTOP would be sent to a ` +
          "pid that may have been reused",
      );
    }
    process.kill(roleProcess.pid, "SIGSTOP");
    roleProcess.stopped = true;
  }

  /**
   * A stopped process consumes nothing. Checked, not assumed.
   *
   * The controller has already written `continue` to the control pipe. A running
   * process would answer it within microseconds; a stopped one cannot answer it
   * at all until `SIGCONT`. If an event arrives here the pause did not take, and
   * the case's whole determinism argument -- that pause / takeover / return is a
   * sequence rather than a race -- is void.
   */
  async assertNoProgressWhileStopped(
    role: string,
    options: { settleS?: number } = {},
  ): Promise<void> {
    const settleS = options.settleS ?? 0.5;
    const roleProcess = this.require(role);
    if (!roleProcess.stopped) {
      throw new ContractViolation(`${role} was never stopped`);
    }
    let event: EventRecord | null | undefined;
    try {
      event = await roleProcess.nextEvent(settleS);
    } catch (error) {
      if (error instanceof BarrierTimeout) {
        return;
      }
      throw error;
    }
    throw new ContractViolation(
      `${role} produced ${JSON.stringify(event)} while stopped: SIGSTOP did not take, so the ` +
        "pause/takeover/return order was a scheduling accident",
    );
  }

  sigcont(role: string): void {
    const roleProcess = this.require(role);
    if (roleProcess.stopped && !roleProcess.exited && !roleProcess.reaped) {
      // A stopped process cannot exit until it is continued, so reaching here
      // with `exited` set means something else killed it; either way the pid is
      // no longer safely ours to signal.
      process.kill(roleProcess.pid, "SIGCONT");
      roleProcess.stopped = false;
    }
  }

  /**
   * Re-execute the same command line with the next restart generation.
   *
   * There is no warm state handed across a restart: the command line and the
   * database file are the whole input, and the entrypoint must recover before it
   * proceeds. The controller waits for the recovery-complete event before
   * returning, which is what makes `restart_order` sequential and each case's
   * intermediate state pinned (design 5).
   */
  async restart(
    role: string,
    options: { armed?: readonly ArmedAnchor[] } = {},
  ): Promise<RoleProcess> {
    const previous = this.require(role);
    const roleProcess = await this.spawn(role, {
      armed: options.armed ?? [],
      generation: previous.generation + 1,
    });
    await roleProcess.waitForEvent([EVENT_RECOVERY_COMPLETE], this.remaining(this.caseTimeoutS));
    return roleProcess;
  }

  /** Let a role finish its script and exit cleanly. */
  async runToCompletion(role: string): Promise<EventRecord> {
    const roleProcess = this.require(role);
    const event = await roleProcess.waitForEvent([EVENT_DONE], this.remaining(this.caseTimeoutS));
    const status = await roleProcess.waitForExit(this.remaining(this.barrierTimeoutS));
    if (!roleProcess.exited) {
      throw new ProcessWaitTimeout(
        `${role} reported done but had not exited within the wait; it is left unreaped so ` +
          "teardown still signals it",
      );
    }
    roleProcess.reaped = true;
    if (status !== 0) {
      throw new Error(
        `${role} exited ${status} after reporting done; stderr is at ${roleProcess.stderrPath}`,
      );
    }
    return event;
  }

  private unwedge(role: string): void {
    const observer = this.adapter.observer(this.workdir, role);
    if (typeof observer.unwedge === "function") {
      observer.unwedge();
    }
  }

  private require(role: string): RoleProcess {
    const roleProcess = this.processes.get(role);
    if (roleProcess === undefined) {
      throw new ContractViolation(`${role} has no process slot in this case`);
    }
    return roleProcess;
  }

  // -- evidence ----------------------------------------------------------

  observer(role: string): DestinationObserver {
    return this.adapter.observer(this.workdir, role);
  }

  /** Run a named invariant query (design 6.2) against the store. */
  query(name: string, parameters: Record<string, unknown>): InvariantRow[] {
    const queries = this.adapter.invariantQueries();
    if (!(name in queries)) {
      throw new ContractViolation(
        `${JSON.stringify(name)} is not an invariant this adapter binds; the contract names ` +
          `${JSON.stringify([...contract.SQL_INVARIANTS].sort())}`,
      );
    }
    const store = this.adapter.storePath(name, {
      controlPlane: this.dbPath,
      workdir: this.workdir,
    });
    if (!existsSync(store)) {
      return [];
    }
    const connection = new Database(store, { readonly: true, fileMustExist: true });
    try {
      return connection.prepare(queries[name] as string).all(parameters) as InvariantRow[];
    } finally {
      connection.close();
    }
  }

  /** The latest instant any role reported, in the injected frame. */
  lastReportedNowMs(options: { default: number }): number {
    const instants: number[] = [];
    for (const entry of this.allTraces()) {
      for (const event of entry.trace) {
        const nowMs = event["now_ms"];
        if (typeof nowMs === "number" && Number.isInteger(nowMs)) {
          instants.push(nowMs);
        }
      }
    }
    return instants.length > 0 ? Math.max(...instants) : options.default;
  }

  traces(): Record<string, readonly EventRecord[]> {
    const out: Record<string, readonly EventRecord[]> = {};
    for (const [slot, roleProcess] of this.processes) {
      out[slot] = [...roleProcess.trace];
    }
    return out;
  }

  /** Every generation's trace, in spawn order -- the failure report body. */
  allTraces(): readonly { role: string; generation: number; trace: readonly EventRecord[] }[] {
    return this.spawned.map((roleProcess) => ({
      role: roleProcess.role,
      generation: roleProcess.generation,
      trace: [...roleProcess.trace],
    }));
  }

  // -- teardown ----------------------------------------------------------

  /**
   * Unconditional, layered, and reaps last (design 8.2).
   *
   * The source's ordering rests on an unreaped leader keeping its pgid
   * un-recyclable; see the note in {@link Controller.kill} for why Node cannot
   * reproduce that and what is done instead. The ladder itself -- `SIGCONT`
   * first because a stopped process ignores `SIGTERM`, then `SIGTERM`, a grace
   * period, then `SIGKILL` -- is unchanged, and teardown still never throws.
   */
  async teardown(): Promise<void> {
    for (const roleProcess of this.spawned) {
      try {
        await this.teardownOne(roleProcess);
      } catch {
        // Teardown never raises.
      }
    }
  }

  private async teardownOne(roleProcess: RoleProcess): Promise<void> {
    if (roleProcess.reaped || roleProcess.exited) {
      closePipes(roleProcess);
      roleProcess.reaped = true;
      return;
    }
    if (POSIX && roleProcess.pgid !== null) {
      for (const signal of ["SIGCONT", "SIGTERM"] as const) {
        // A stopped process ignores SIGTERM until it is continued, so SIGCONT
        // leads the ladder.
        try {
          process.kill(-roleProcess.pgid, signal);
        } catch {
          // Gone, or not ours.
        }
      }
      await grace(roleProcess, TEARDOWN_GRACE_S);
      if (!roleProcess.exited) {
        try {
          process.kill(-roleProcess.pgid, "SIGKILL");
        } catch {
          // Gone, or not ours.
        }
      }
    } else {
      roleProcess.child.kill("SIGKILL");
    }
    await roleProcess.waitForExit(5);
    roleProcess.reaped = true;
    closePipes(roleProcess);
  }
}

function closePipes(roleProcess: RoleProcess): void {
  for (const stream of [roleProcess.child.stdin, roleProcess.child.stdout]) {
    try {
      stream?.destroy();
    } catch {
      // Already closed.
    }
  }
}

/** Wait out the grace period, returning early once the child has exited. */
async function grace(roleProcess: RoleProcess, seconds: number): Promise<void> {
  const deadline = monotonicS() + seconds;
  while (monotonicS() < deadline) {
    if (roleProcess.exited) {
      return;
    }
    await delay(50);
  }
}

/**
 * Inherit the environment and add what the driver needs.
 *
 * Inheriting rather than hand-building is load-bearing on Windows: an
 * interpreter started without `SystemRoot` and without the `PATH` its DLLs are
 * found on never reaches `main()`. The source additionally prepends the
 * repository root to `PYTHONPATH` because it spawns by dotted module path; the
 * port spawns by file path, so there is no import path to extend.
 */
function childEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Node's type stripping warns on stderr once per process. stderr is the
    // driver's diagnostic channel and never part of the protocol, so the
    // warning is harmless -- it is silenced only so a failed case's stderr file
    // opens on the failure rather than on a notice about an unrelated flag.
    NODE_NO_WARNINGS: "1",
  };
}

export function claimantKey(role: string): string {
  return `${role}#claimant`;
}

/**
 * Applied writes whose epoch went backwards -- the forbidden interleaving.
 *
 * ACCEPTANCE.md section 2's single-writer row: the state item's history is a
 * linear sequence with no interleaving from the rejected writer. Refused rows
 * are ignored on purpose; a refusal is the evidence that the fence held, not
 * evidence that it did not. The history arrives in the database's own insertion
 * order, never in the caller's -- under injected skew a timestamp ordering would
 * manufacture regressions and hide real ones.
 */
export function epochRegressions(history: readonly InvariantRow[]): [InvariantRow, InvariantRow][] {
  const applied = history.filter((row) => row["status"] === "applied");
  const regressions: [InvariantRow, InvariantRow][] = [];
  for (let index = 0; index + 1 < applied.length; index += 1) {
    const first = applied[index] as InvariantRow;
    const second = applied[index + 1] as InvariantRow;
    const firstEpoch = Number(first["writer_epoch"] ?? 0);
    const secondEpoch = Number(second["writer_epoch"] ?? 0);
    if (secondEpoch < firstEpoch) {
      regressions.push([{ ...first }, { ...second }]);
    }
  }
  return regressions;
}

// ---------------------------------------------------------------------------
// executing one manifest case -- design 5, 7, 8
// ---------------------------------------------------------------------------

/**
 * How many times the destination must have been asked, per fault kind.
 *
 * `drop-delivery`: the refused attempt and the resend that followed it.
 * `dup-delivery`: both copies of the message, under one key.
 * `lost-ack`: the first delivery and the re-delivery the missing ack caused.
 * `recipient-unavailable`: the refused attempts plus the one that landed.
 *     Counting fewer would accept a run in which the recipient was never
 *     actually unavailable, which is the failure mode this table exists for.
 * `late-ack`: the first delivery and the re-delivery the missing ack caused.
 */
const ATTEMPT_FLOOR: Readonly<Record<string, number>> = Object.freeze({
  "drop-delivery": 2,
  "dup-delivery": 2,
  "lost-ack": 2,
  "recipient-unavailable": 4,
  "late-ack": 2,
});

/**
 * How high the **outbox row's own** `retry_count` must have climbed, per fault
 * kind.
 *
 * Deliberately a second table and not a reuse of the one above, because the two
 * count different things. `ATTEMPT_FLOOR` counts attempts at a destination
 * *key*, and `dup-delivery` reaches its floor of two with two different messages
 * sharing one key -- each row attempted exactly once. Only a fault whose repeat
 * lands on the *same row* raises that row's retry count, so only those appear
 * here. Reusing the other table would fail `dup-delivery` for doing precisely
 * what it is supposed to do.
 *
 * This exists because a floor of one says no more than "an attempt happened": an
 * outbox that incremented once and never again, or lost the count across a
 * restart, would satisfy it while breaking ACCEPTANCE.md section 2's
 * "monotonically increasing, restart-surviving retry count".
 */
const RETRY_COUNT_FLOOR: Readonly<Record<string, number>> = Object.freeze({
  "drop-delivery": 2, // the refused attempt and the resend
  "lost-ack": 2, // the delivery and the re-delivery
  "recipient-unavailable": 4, // the refused attempts and the one that landed
});

function armedFor(faultCase: FaultCase, role: string): ArmedAnchor[] {
  const arms = (faultCase["arms"] as Record<string, string[]>) ?? {};
  return (arms[role] ?? []).map((wire) => ArmedAnchor.parse(wire));
}

export interface CaseOutcome {
  resolvedSkewMs: number | null;
  atKill: Record<string, Record<string, number>>;
  unresolvedAtKill: Record<string, InvariantRow[]>;
}

/**
 * Drive one case to its end state and return what the assertions need.
 *
 * The shape of a case is entirely manifest data: which roles are armed where,
 * whether the barrier is aligned or staggered, the kill and restart orders, the
 * clock programme. Nothing here decides anything a case did not declare -- that
 * is what makes `case_id + manifest_version` denote one fully-specified case
 * (design 4.1).
 *
 * Two observations are taken *during* the run and returned, because they cannot
 * be reconstructed afterwards:
 *
 * `atKill`
 *     the destination's effect count for each target, read between phase two and
 *     the restart. This is what proves the window was the window: a kill at
 *     `after_effect_before_record` must find the effect already present, and a
 *     kill at `before_durable_write` must find it absent. Read only at the end
 *     of the case, both look identical -- recovery has re-attempted by then --
 *     and the harness would be certifying the third ACCEPTANCE.md section 2
 *     window without ever having entered it.
 *
 * `unresolvedAtKill`
 *     the outbox rows still unacked at the same moment, so a restart case can
 *     assert that recovery had something to recover.
 */
export async function executeCase(
  controller: Controller,
  faultCase: FaultCase,
): Promise<CaseOutcome> {
  const targets = faultCase["targets"] as string[];
  const fault = faultCase["fault"] as string;
  const barrierMode = faultCase["barrier"] as string;
  let resolvedSkewMs: number | null = null;
  /**
   * A claimant deliberately left blocked at its barrier so that it is still live
   * while the restart below happens. Released once the restart is done.
   */
  let heldClaimant: string | null = null;

  controller.bootstrap();
  for (const role of targets) {
    await controller.spawn(role, { armed: armedFor(faultCase, role) });
  }

  if (barrierMode === contract.BARRIER_STAGGERED) {
    // Kills are not barrier-simultaneous: A dies at its checkpoint, B keeps
    // operating against the survivor state, then B dies at a later armed
    // checkpoint (design 5). Dispatch is on the *barrier mode*, which is the
    // field design section 5 defines combination semantics on -- not on the
    // fault string, which would leave the declared mode unread.
    for (const step of faultCase["staggered"] as { wait: string; kill: string }[]) {
      await controller.waitAtAnchor(step.wait);
      await controller.kill(step.kill);
    }
  } else if (
    ["sigkill", "staggered-sigkill", "recipient-unavailable", "late-ack"].includes(fault)
  ) {
    // Aligned mode: every target is frozen inside its window before any kill is
    // issued, so the kill set is applied to a known joint state.
    //
    // `recipient-unavailable` and `late-ack` are kill-shaped too, and
    // deliberately so. Both invariants ACCEPTANCE.md section 2 names for them
    // are about *surviving a restart* -- "retry count is durable across
    // restarts" and "deliver the ack after the sender has restarted" -- so a
    // case with no kill in it could not observe either. What distinguishes them
    // from a plain `sigkill` is the behaviour the driver carries, not the shape
    // of the kill.
    await controller.barrierAligned(targets);
    for (const role of faultCase["kill_order"] as string[]) {
      await controller.kill(role);
    }
  } else if (["sigkill-expire", "resumed-writer-race"].includes(fault)) {
    // ACCEPTANCE.md section 2's lease row: "kill the lease holder without
    // release", and its single-writer row: "a write is attempted concurrently
    // from a resumed process and its replacement".
    //
    // The two are one mechanic anchored at two different points. The holder is
    // killed at its armed anchor and never releases, so its lease row is left
    // behind with a live expiry and an epoch nobody holds. A claimant whose
    // clock has crossed that expiry then takes the resource over -- that is the
    // replacement. Finally the killed holder is restarted: it comes back with
    // *no epoch in memory*, re-runs its script from the top, and meets the
    // claimant's live lease.
    //
    // That last step is why the driver records a refusal at `acquire`. A
    // SIGKILLed process cannot "return as a stale writer" the way a SIGSTOPped
    // one does -- it has no token left to present -- so the refusal it does earn
    // is the one at the resource boundary, and that is the refusal this case
    // asserts. The stale-token-write half of the row is proved by
    // `sigstop-expire`, where the holder really does keep its epoch across the
    // takeover.
    await controller.barrierAligned(targets);
    for (const killed of faultCase["kill_order"] as string[]) {
      await controller.kill(killed);
    }
    const claimant = faultCase["claimant"] as Record<string, unknown> | null;
    if (claimant !== null) {
      resolvedSkewMs = contract.resolveSkewMs(claimant["clock"] as string, {
        ttlMs: faultCase["ttl_ms"] as number,
        elapsedMs: faultCase["ttl_ms"] as number,
      });
      const claimantArmed = ((claimant["arms"] as string[] | undefined) ?? []).map((wire) =>
        ArmedAnchor.parse(wire),
      );
      await controller.spawnClaimant(claimant["role"] as string, {
        holderSuffix: claimant["holder_suffix"] as string,
        clockOffsetMs: resolvedSkewMs,
        armed: claimantArmed,
        behaviours: (claimant["behaviours"] as string[] | undefined) ?? [],
      });
      if (claimantArmed.length > 0) {
        // "A write is attempted concurrently from a resumed process and its
        // replacement" -- so the replacement is held at its barrier rather than
        // run to completion, and is *still alive and still holding* when the
        // resumed process comes back below. Running it to completion here would
        // leave the resumed process meeting nothing but a lease row belonging to
        // a process that had already exited, which is not a concurrent write by
        // any reading. It is released after the restart, at the end.
        await controller.waitAtAnchor(claimantKey(claimant["role"] as string));
        heldClaimant = claimantKey(claimant["role"] as string);
      } else {
        await controller.runToCompletion(claimantKey(claimant["role"] as string));
      }
    }
  } else if (fault === "writer-race") {
    // "Two writers race for the same state item." They cannot both be live
    // writers: `acquire`'s upsert only replaces a lapsed row, so the second
    // claimant on one resource is refused at the resource boundary rather than
    // merged into the history. That refusal *is* section 2's invariant ("a stale
    // writer is rejected, not merged"), and the ledger row it leaves is the
    // durable observable.
    //
    // The incumbent is held at its barrier for the whole race, so the racer
    // provably meets a live lease rather than a lapsed one -- the ordering is a
    // barrier, never a sleep.
    const role = targets[0] as string;
    await controller.waitAtAnchor(role);
    const racer = faultCase["claimant"] as Record<string, unknown> | null;
    if (racer !== null) {
      await controller.spawnClaimant(racer["role"] as string, {
        holderSuffix: racer["holder_suffix"] as string,
        // No skew: the point is that the incumbent's lease is *live*.
        clockOffsetMs: 0,
        // The racer's own behaviours, not the case's -- giving these to the
        // incumbent would fence out the writer that is supposed to win. Refused
        // at acquire and then carrying on with a token the row rejects, it runs
        // its whole script against the same state item while the incumbent is
        // still frozen at its barrier. That is what makes the history half of
        // section 2's single-writer observable reachable: a racer that stopped
        // at acquire would contribute no write for an interleaving to be visible
        // in.
        behaviours: (racer["behaviours"] as string[] | undefined) ?? [],
      });
      await controller.runToCompletion(claimantKey(racer["role"] as string));
    }
    controller.release(role);
    await controller.runToCompletion(role);
  } else if (["clock-fwd", "clock-back", "sigstop-expire"].includes(fault)) {
    const role = targets[0] as string;
    await controller.waitAtAnchor(role);
    if (fault === "sigstop-expire") {
      // Only while the holder is provably blocked at its sync point: already
      // holding its lease and between operations.
      controller.sigstop(role);
    }
    const claimant = faultCase["claimant"] as Record<string, unknown> | null;
    if (claimant !== null) {
      resolvedSkewMs = contract.resolveSkewMs(claimant["clock"] as string, {
        ttlMs: faultCase["ttl_ms"] as number,
        elapsedMs: faultCase["ttl_ms"] as number,
      });
      await controller.spawnClaimant(claimant["role"] as string, {
        holderSuffix: claimant["holder_suffix"] as string,
        clockOffsetMs: resolvedSkewMs,
      });
      await controller.runToCompletion(claimantKey(claimant["role"] as string));
    }
    if (fault === "sigstop-expire") {
      // The design's determinism argument for this case is that a stopped
      // process *cannot consume the continue until it is resumed*, so the pause
      // / takeover / return order is a sequence and not a scheduling accident.
      // That argument is only worth anything if it is checked: the release is
      // issued while the holder is still stopped, and the holder must make no
      // progress on it. Without this the signal is decoration -- the process was
      // already blocked on its control pipe.
      controller.release(role);
      await controller.assertNoProgressWhileStopped(role);
      controller.sigcont(role);
    } else {
      const skew = faultCase["skew"] as Record<string, unknown> | null;
      if (skew !== null) {
        // Same-role skew: the offset lands while the process is blocked and the
        // *next* operation observes it.
        resolvedSkewMs = contract.resolveSkewMs(skew["direction"] as string, {
          ttlMs: faultCase["ttl_ms"] as number,
          elapsedMs: faultCase["ttl_ms"] as number,
        });
        await controller.setClockOffset(role, resolvedSkewMs);
      }
      controller.release(role);
    }
    await controller.runToCompletion(role);
  } else if (
    [
      "drop-delivery",
      "dup-delivery",
      "lost-ack",
      "dup-ack",
      "re-ack",
      "incident-repeat",
      "incident-replay",
      "observation-outage",
    ].includes(fault)
  ) {
    // Surface faults: the injection is in what the script does, not in what
    // happens to the process. The barrier is a pass-through here, used to pin
    // the moment rather than to kill -- the ack-multiplicity injections, the
    // repeated incident condition and the broken observation seam all need the
    // script to keep running past the anchor to be observable at all.
    const role = targets[0] as string;
    await controller.waitAtAnchor(role);
    if (!faultCase["release_after_barrier"]) {
      throw new ContractViolation(
        `${faultCase["case_id"]}: a delivery-surface fault anchors at a pass-through barrier ` +
          "and must declare release_after_barrier",
      );
    }
    controller.release(role);
    await controller.runToCompletion(role);
  } else {
    throw new ContractViolation(`unknown fault kind ${JSON.stringify(fault)}`);
  }

  const atKill: Record<string, Record<string, number>> = {};
  for (const role of targets) {
    const observer = controller.observer(role);
    const counted: Record<string, number> = {};
    for (const key of controller.adapter.effectKeys(role, faultCase)) {
      counted[key] = observer.effectCount(key);
    }
    atKill[role] = counted;
  }
  const unresolvedAtKill: Record<string, InvariantRow[]> = {};
  for (const role of targets) {
    unresolvedAtKill[role] = recoverableState(controller, role, faultCase);
  }

  if (faultCase["restart_after"]) {
    const order = faultCase["restart_order"];
    if (order === "concurrent") {
      throw new ContractViolation(
        "concurrent restart is a distinct manifest value and no seed case declares it (design 5)",
      );
    }
    for (const role of order as string[]) {
      // Sequential by contract: target N+1 starts only after target N's
      // entrypoint has signalled recovery-complete, so each case pins which
      // component recovers into which intermediate state.
      await controller.restart(role, { armed: [] });
      await controller.runToCompletion(role);
    }
  }

  if (heldClaimant !== null) {
    // Only now: the resumed process has been and gone while this one was
    // holding, which is the concurrency the case is named for.
    controller.release(heldClaimant);
    await controller.runToCompletion(heldClaimant);
  }

  return { resolvedSkewMs, atKill, unresolvedAtKill };
}

/**
 * Durable state the kill left mid-flight, for this role.
 *
 * Deliberately wider than the outbox. A kill inside `bind` leaves no unacked
 * message but does leave a lease row held by a process that no longer exists and
 * a half-written binding -- state a restart has to reconcile. Counting only
 * outbox rows would call that case "nothing to recover" and let its recovery
 * assertion pass on an empty set, which is the same vacuity in a new place.
 */
function recoverableState(
  controller: Controller,
  role: string,
  faultCase: FaultCase,
): InvariantRow[] {
  const nowMs = controller.lastReportedNowMs({
    default: Math.trunc(faultCase["clock_base_ms"] as number),
  });
  const params = controller.adapter.queryParameters(role, { nowMs });
  const state: InvariantRow[] = [];
  for (const row of controller.query(contract.INVARIANT_RETRY_COUNT_DURABLE, {
    holder_prefix: params["holder_prefix"],
  })) {
    if (row["status"] !== "acked") {
      state.push({ ...row, evidence: "outbox" });
    }
  }
  for (const row of controller.query(contract.INVARIANT_NO_PENDING_ACTION, {
    scope: params["scope"],
  })) {
    state.push({ ...row, evidence: "action" });
  }
  for (const row of controller.query(contract.INVARIANT_LEASE_SINGLE_HOLDER, { now_ms: nowMs })) {
    if (row["resource"] === params["resource"]) {
      state.push({ ...row, evidence: "lease" });
    }
  }
  // Gate item 4 says the work a restart resumes is "unresolved incidents"
  // (interlock D-0001), so an incident still open at the kill is recoverable
  // state in exactly the sense this function means. Before the matrix wrote
  // incident rows the omission cost nothing; once it does, a case that killed
  // with an incident open would otherwise be judged to have had nothing to
  // recover.
  for (const row of controller.query(contract.INVARIANT_UNRESOLVED_INCIDENTS, {
    scope: params["scope"],
  })) {
    state.push({ ...row, evidence: "incident" });
  }
  return state;
}

/**
 * A repeated incident condition is collapsed under its dedup key.
 *
 * ACCEPTANCE.md section 2's dedup row is explicit that the Issue fixes the
 * *fields* and not the semantics: whether a repeat increments `retry count` on
 * the existing incident or opens a linked one is Q-0002, as is the
 * re-notification window in absolute time, and "tests must parameterise both
 * rather than hard-code either". So this function asserts *the rule the case
 * declared* and has no opinion of its own. What it does assert unconditionally
 * is the part the Issue does fix (interlock D-0007): a repeat is collapsed under
 * the dedup key rather than producing an unbounded stream of unrelated
 * incidents, and `dedup_key` and `retry_count` are present on every row.
 */
function assertIncidentCollapse(
  faultCase: FaultCase,
  role: string,
  rows: readonly InvariantRow[],
  fail: (message: string) => void,
): void {
  const parameters = (faultCase["incident_params"] as Record<string, unknown> | null) ?? {};
  const collapse = parameters["collapse"] as string | null | undefined;
  const repeats = Number(parameters["repeats"] ?? 0);
  const expectCollapse = parameters["expect_collapse"];
  if (rows.length === 0) {
    fail(`${role}: no incident was raised, so the collapse rule asserts nothing`);
    return;
  }

  const byKey = new Map<string, InvariantRow[]>();
  for (const row of rows) {
    const key = String(row["dedup_key"]);
    const group = byKey.get(key);
    if (group === undefined) {
      byKey.set(key, [row]);
    } else {
      group.push(row);
    }
  }

  for (const row of rows) {
    if (!row["dedup_key"]) {
      fail(
        `${role}: incident ${JSON.stringify(row["incident_id"])} has no dedup key ` +
          "(interlock D-0007)",
      );
    }
    if (row["retry_count"] === null || row["retry_count"] === undefined) {
      fail(
        `${role}: incident ${JSON.stringify(row["incident_id"])} has no retry count ` +
          "(interlock D-0007)",
      );
    }
  }

  if (collapse === null || collapse === undefined) {
    // No rule declared: the case is not making a Q-0002 claim, so only the
    // fields are checked. This is the shape every seed case has.
    return;
  }

  if (expectCollapse === false) {
    // The raises fell outside the case's own re-notification window, so there is
    // nothing to collapse *under either rule*: each raise is its own condition
    // as far as the window is concerned. Asserting this is what makes the window
    // a real parameter rather than one that is carried and ignored -- and it is
    // deliberately checked before the rule branch, because outside the window
    // the rule does not apply at all.
    for (const [key, group] of byKey) {
      if (group.length !== repeats) {
        fail(
          `${role}: dedup key ${JSON.stringify(key)} produced ${group.length} incident(s) for ` +
            `${repeats} raise(s) outside its re-notification window; outside the window nothing ` +
            "is collapsed",
        );
      }
      const linked = group.filter((row) => row["related_incident_id"] !== null);
      if (linked.length > 0) {
        fail(
          `${role}: dedup key ${JSON.stringify(key)} linked ${linked.length} incident(s) ` +
            "although the raises fell outside its window",
        );
      }
    }
    return;
  }

  for (const [key, group] of byKey) {
    if (collapse === "increment-in-place") {
      if (group.length !== 1) {
        fail(
          `${role}: dedup key ${JSON.stringify(key)} opened ${group.length} incidents under ` +
            "the increment-in-place rule, which collapses onto one",
        );
        continue;
      }
      const only = group[0] as InvariantRow;
      if (Number(only["retry_count"]) !== repeats - 1) {
        fail(
          `${role}: dedup key ${JSON.stringify(key)} was raised ${repeats} time(s) but its ` +
            `incident carries retry_count=${only["retry_count"]}, not ${repeats - 1}`,
        );
      }
    } else if (collapse === "open-linked") {
      if (group.length !== repeats) {
        fail(
          `${role}: dedup key ${JSON.stringify(key)} opened ${group.length} incidents under ` +
            `the open-linked rule, which opens one per repeat (${repeats})`,
        );
        continue;
      }
      const root = group.filter((row) => row["related_incident_id"] === null);
      if (root.length !== 1) {
        fail(
          `${role}: dedup key ${JSON.stringify(key)} has ${root.length} unlinked incidents; ` +
            "a linked chain has exactly one root",
        );
        continue;
      }
      const linked = new Set<unknown>(
        group.map((row) => row["related_incident_id"]).filter((value) => value !== null),
      );
      const rootId = (root[0] as InvariantRow)["incident_id"];
      if (linked.size > 0 && (linked.size !== 1 || !linked.has(rootId))) {
        fail(
          `${role}: dedup key ${JSON.stringify(key)} links to ` +
            `${JSON.stringify([...linked].sort())}, not to its own chain root ` +
            `${JSON.stringify(rootId)}`,
        );
      }
    } else {
      fail(`${role}: ${JSON.stringify(collapse)} is not a collapse rule this harness implements`);
    }
  }
}

/**
 * The outage is classified, and classified as exactly one thing.
 *
 * ACCEPTANCE.md section 2's observation row, and interlock D-0006 behind it. The
 * assertion is deliberately **not** a disjunction over the two non-anomaly
 * states: a harness that classified a genuine read failure as
 * `NO_ACTIVITY_EVIDENCE` would pass a disjunction while committing the exact
 * conflation D-0006 exists to forbid. Each observation mode names one fact state
 * and the case asserts that one.
 *
 * Nothing here reads a fact state's *meaning* -- Q-0012 is open and this is a
 * check that the reader's outcome was named correctly, not that the name implies
 * anything.
 */
function assertObservationClassified(
  faultCase: FaultCase,
  role: string,
  rows: readonly InvariantRow[],
  fail: (message: string) => void,
): void {
  const observation = (faultCase["observation"] as Record<string, unknown> | null) ?? {};
  const mode = observation["mode"] as string | undefined;
  if (rows.length === 0) {
    fail(`${role}: the observation produced no incident row to classify`);
    return;
  }
  for (const row of rows) {
    const state = row["fact_state"] as string;
    if (!contract.FACT_STATES.includes(state as (typeof contract.FACT_STATES)[number])) {
      fail(
        `${role}: incident ${JSON.stringify(row["incident_id"])} carries fact state ` +
          `${JSON.stringify(state)}, which is outside the closed set (interlock D-0005)`,
      );
    }
    if (!row["detector_version"]) {
      fail(
        `${role}: incident ${JSON.stringify(row["incident_id"])} carries no detector version; ` +
          "a fact state without one cannot be replayed (interlock D-0007)",
      );
    }
  }
  if (mode === undefined) {
    return;
  }
  const wanted = contract.OBSERVATION_FACT_STATES[mode];
  const wrong = rows.filter((row) => row["fact_state"] !== wanted);
  if (wrong.length > 0) {
    const seen = [...new Set(wrong.map((row) => row["fact_state"] as string))].sort();
    fail(
      `${role}: the observation path was made ${JSON.stringify(mode)}, which is ${wanted}; it ` +
        `was classified ${JSON.stringify(seen)}. Collapsing a read failure and a quiet worker ` +
        "into one state is what interlock D-0006 forbids",
    );
  }
}

/**
 * Assert exactly what the case declared, by name, and nothing else.
 *
 * Every failure carries the reproduction line, because a case that cannot be
 * re-run alone is not a case (design 4.4).
 */
export function assertInvariants(
  controller: Controller,
  faultCase: FaultCase,
  options: {
    resolvedSkewMs: number | null;
    atKill?: Record<string, Record<string, number>> | null;
    unresolvedAtKill?: Record<string, readonly InvariantRow[]> | null;
  },
): void {
  const repro = reproLine({
    caseId: faultCase["case_id"] as string,
    suiteSeed: controller.suiteSeed,
    manifestVersion: faultCase["manifest_version"] as number,
    resolvedSkewMs: options.resolvedSkewMs,
    profile: controller.profile,
  });

  const fail = (message: string): never => {
    throw new Error(`${message}\n${repro}\ntraces: ${JSON.stringify(controller.allTraces())}`);
  };

  // The instant the final state is read at, in the injected frame: the latest
  // `now_ms` any participant reported.
  //
  // A fixed `base + 4 * ttl` was the obvious choice and it is wrong: it sits
  // past every lease's expiry, so `lease-single-holder` returns nothing on every
  // case and `no-unowned-outbox`'s liveness arm is false for every row -- two
  // invariants that can then only ever pass. Reading at the last instant the run
  // actually reached keeps both meaningful, and it is exactly the instant a
  // recovering process would see.
  const nowMs = controller.lastReportedNowMs({
    default: Math.trunc(faultCase["clock_base_ms"] as number),
  });
  const expected = faultCase["expected"] as {
    queries: string[];
    destination: string[];
    recovery_owner: string | null;
  };
  const fault = faultCase["fault"] as string;

  for (const role of faultCase["targets"] as string[]) {
    const params = controller.adapter.queryParameters(role, { nowMs });

    for (const name of expected.queries) {
      const wanted = contract.INVARIANT_PARAMETERS[name] ?? [];
      const bound: Record<string, unknown> = {};
      for (const key of wanted) {
        bound[key] = params[key];
      }
      const rows = controller.query(name, bound);

      if (name === contract.INVARIANT_NO_UNOWNED_OUTBOX) {
        // ACCEPTANCE.md section 2: no outbox row remains in a state with no
        // owner after recovery.
        if (rows.length > 0) {
          fail(`${role}: ${rows.length} outbox row(s) left unowned: ${JSON.stringify(rows)}`);
        }
      } else if (name === contract.INVARIANT_RETRY_COUNT_DURABLE) {
        if (rows.length === 0) {
          fail(`${role}: no outbox rows at all; the script wrote nothing`);
        }
        const floor = Math.max(1, RETRY_COUNT_FLOOR[fault] ?? 1);
        for (const row of rows) {
          if (Number(row["retry_count"]) < floor) {
            fail(
              `${role}: ${row["message_id"]} carries retry_count=${row["retry_count"]}; a ` +
                `${fault} case injected at least ${floor} attempt(s), so a lower durable count ` +
                "means the count was not kept across them",
            );
          }
          if (row["status"] !== "acked") {
            fail(`${role}: ${row["message_id"]} ended ${JSON.stringify(row["status"])}, not acked`);
          }
        }
      } else if (name === contract.INVARIANT_SINGLE_ACKED_STATE) {
        for (const row of rows) {
          // Message identity shows exactly one acked state regardless of ack
          // multiplicity; a duplicate delivery is a second row under the same
          // dedup key and still one effect.
          if (row["acked_rows"] !== row["rows_total"]) {
            fail(
              `${role}: dedup key ${JSON.stringify(row["dedup_key"])} is half-acked: ` +
                `${JSON.stringify(row)}`,
            );
          }
        }
      } else if (name === contract.INVARIANT_LINEAR_WRITER_HISTORY) {
        // Non-vacuity first. "No epoch regression" over an empty history is true
        // of a database nobody ever wrote to, and a query that silently matches
        // nothing would report exactly that -- which is how this invariant was
        // vacuous before the scope parameter existed. A history that cannot see
        // a write cannot see an interleaving either.
        if (rows.length === 0) {
          fail(
            `${role}: the write history is empty, so 'no interleaving' asserts nothing; the ` +
              "query is not seeing this role's writes",
          );
        }
        const regressions = epochRegressions(rows);
        if (regressions.length > 0) {
          fail(`${role}: a rejected writer interleaved: ${JSON.stringify(regressions)}`);
        }
      } else if (name === contract.INVARIANT_RECORDED_REFUSALS) {
        if (fault === "clock-back") {
          // The backward-skew row of ACCEPTANCE.md section 2 is about the
          // refusal, not about the absence of a symptom: a renewal whose new
          // expiry lands at or before its own acquisition is refused outright
          // rather than silently clamped, and that refusal is what this case
          // exists to observe.
          const skewRefusals = rows.filter((row) => row["refusal"] === "ClockSkewRefused");
          if (skewRefusals.length === 0) {
            fail(
              `${role}: no ClockSkewRefused was recorded, so the backward skew never reached ` +
                "the expiry boundary",
            );
          }
        }
        if (["writer-race", "resumed-writer-race"].includes(fault)) {
          // The half of section 2's single-writer observable that is about the
          // *history* only means something if the rejected writer actually
          // attempted a write. A refusal at `acquire` alone would leave the
          // history containing nothing but the winner's rows, and "no
          // interleaving from the rejected writer" would then be true of every
          // run -- including one in which atomic fencing had stopped working. So
          // the case requires the refusal that can only come from a write:
          // `StaleWriterRefused` is raised by the fence, inside the write's own
          // transaction.
          const fenced = rows.filter((row) => row["refusal"] === "StaleWriterRefused");
          if (fenced.length === 0) {
            fail(
              `${role}: no write was refused by the fence, so the rejected writer never ` +
                "attempted one and 'no interleaving' asserts nothing about fencing",
            );
          }
        }
        if (["dup-ack", "re-ack"].includes(fault)) {
          // The ack-multiplicity injections leave no trace in the control plane
          // by construction -- an idempotent ack changes nothing, which is the
          // invariant. So the evidence that the *second* ack happened at all is
          // the ignored-ack row, and without checking for it the case would pass
          // identically on a driver that stopped issuing the duplicate.
          const ignored = rows.filter((row) => row["refusal"] === "AckAlreadyRecorded");
          if (ignored.length === 0) {
            fail(
              `${role}: no ack was ever ignored as already-recorded, so this ${fault} case ` +
                "never issued the second ack it claims to inject",
            );
          }
        }
        // The returning holder's write attempt is refused and that refusal is
        // recorded, not silently dropped. This is a SQL query over a persisted
        // row on purpose: an event-trace line would only prove the harness saw
        // an exception (design 5).
        if (rows.length === 0) {
          fail(`${role}: the stale writer's refusal was never recorded`);
        }
      } else if (name === contract.INVARIANT_NO_PENDING_ACTION) {
        if (rows.length > 0) {
          fail(`${role}: recovery left ${rows.length} action(s) pending: ${JSON.stringify(rows)}`);
        }
      } else if (name === contract.INVARIANT_LEASE_SINGLE_HOLDER) {
        const held = rows.filter((row) => row["resource"] === params["resource"]);
        if (held.length === 0 && fault !== "sigstop-expire") {
          // Same non-vacuity rule: "at most one live holder" over a resource
          // nobody holds is a statement about nothing. A Secretary case is the
          // one exception -- its script ends by releasing, which is the point of
          // the release step.
          if (!(contract.ROLE_SCRIPTS[role] ?? []).includes(contract.OPERATION_LEASE_RELEASE)) {
            fail(
              `${role}: no live holder on ${JSON.stringify(params["resource"])} at ` +
                `now_ms=${nowMs}, so the single-holder assertion is vacuous`,
            );
          }
        }
        if (held.length > 1) {
          fail(`${role}: ${held.length} live holders on one resource: ${JSON.stringify(held)}`);
        }
        if (fault === "clock-back" && held.length > 0) {
          // A holder whose clock ran backwards never gains authority: a renewal
          // landing at or before the acquisition is refused outright, and one
          // that is accepted only ever shortens. So the expiry may never exceed
          // what the acquisition itself bought. The ceiling is measured against
          // the row's own acquisition rather than against the clock base,
          // because the acquisition instant is what the TTL was added to.
          const first = held[0] as InvariantRow;
          const ceiling =
            Number(first["acquired_at_ms"]) + Math.trunc(faultCase["ttl_ms"] as number);
          if (Number(first["expires_at_ms"]) > ceiling) {
            fail(
              `${role}: a backward-skewed renewal extended the lease to ` +
                `${first["expires_at_ms"]} (> ${ceiling})`,
            );
          }
        }
      } else if (name === contract.INVARIANT_INCIDENT_COLLAPSE) {
        assertIncidentCollapse(faultCase, role, rows, fail);
      } else if (name === contract.INVARIANT_UNRESOLVED_INCIDENTS) {
        // "Work resumes from unresolved incidents" (gate item 4). After the
        // restart the incident the case opened must still be readable from
        // SQLite alone -- the packet is in the row, not in anyone's context
        // (interlock D-0003, D-0007) -- and it must carry the two fields D-0007
        // makes mandatory.
        if (rows.length === 0) {
          fail(
            `${role}: no unresolved incident survived, so 'work resumes from unresolved ` +
              "incidents' asserts nothing",
          );
        }
        for (const row of rows) {
          if (!row["dedup_key"]) {
            fail(`${role}: incident ${JSON.stringify(row["incident_id"])} carries no dedup key`);
          }
          if (row["retry_count"] === null || row["retry_count"] === undefined) {
            fail(`${role}: incident ${JSON.stringify(row["incident_id"])} carries no retry count`);
          }
        }
      } else if (name === contract.INVARIANT_OBSERVATION_CLASSIFIED) {
        assertObservationClassified(faultCase, role, rows, fail);
      } else if (name === contract.INVARIANT_NO_ANOMALY_ESCALATION) {
        // The query is a COUNT, so it always has exactly one row and "none were
        // produced" is a pass rather than an empty result.
        if (rows.length === 0) {
          fail(`${role}: the escalation count returned no row at all`);
        }
        const escalations = Number((rows[0] as InvariantRow)["escalations"]);
        if (escalations) {
          fail(
            `${role}: ${escalations} termination/restart recommendation(s) were produced from ` +
              "an observation outage. interlock D-0006: observation-unavailable and " +
              "no-activity-evidence are not anomalies",
          );
        }
      } else if (name === contract.INVARIANT_ONE_BINDING_PER_RUN) {
        // Gate item 2: at-most-one is the schema's partial unique index; the
        // non-empty half of "exactly one" is asserted here, after recovery -- a
        // restart that ends with no active binding re-identified nothing.
        if (rows.length > 1) {
          fail(
            `${role}: ${rows.length} active bindings for one run: ` +
              `${JSON.stringify(rows.map((row) => row["session_id"]))}`,
          );
        }
        if (faultCase["restart_after"] && rows.length === 0) {
          fail(
            `${role}: no active session binding after recovery, so re-identification yielded ` +
              "nothing; exactly-one is at-most-one plus this non-empty read",
          );
        }
        for (const row of rows) {
          // A surviving binding that never reached the read-back commit
          // re-identified nothing: the row exists, but the identity was never
          // reconciled with what the provider actually assigned (interlock
          // D-0027), which is the specific thing this invariant is cited as
          // evidence for.
          if (faultCase["restart_after"] && row["binding_phase"] !== "identity_confirmed") {
            fail(
              `${role}: the surviving binding for ${JSON.stringify(row["session_id"])} is ` +
                `${JSON.stringify(row["binding_phase"])}, not identity_confirmed -- recovery ` +
                "finished without committing the read-back",
            );
          }
        }
      } else {
        throw new ContractViolation(
          `${JSON.stringify(name)} is a named invariant with no assertion behind it. The chain ` +
            "above has no default arm on purpose: a case that declared this name would " +
            "otherwise run its SQL, assert nothing, and report coverage it does not have",
        );
      }
    }

    const observer = controller.observer(role);
    const claimant = faultCase["claimant"] as Record<string, unknown> | null;
    // Two different shapes wear the same manifest field. In a takeover the
    // claimant wins and the incumbent is the superseded one; in a race the
    // incumbent is alive and holding, so the *claimant* is the writer that was
    // rejected. Reading them the same way would assert that whichever writer
    // actually won produced no effect at all.
    const superseded =
      claimant !== null && claimant["role"] === role && contract.TAKEOVER_FAULTS.includes(fault);
    const rejectedClaimant =
      claimant !== null && claimant["role"] === role && !contract.TAKEOVER_FAULTS.includes(fault);

    for (const name of expected.destination) {
      const keys = controller.adapter.effectKeys(role, faultCase);
      if (name === contract.INVARIANT_ONE_EFFECT_PER_KEY) {
        // The counterparty's own record, read out of process, after the kill:
        // SQLite alone cannot prove this (ACCEPTANCE.md section 2).
        if (superseded && claimant !== null) {
          // In a takeover case the effect belongs to the epoch that won. The
          // interesting half is the other one: the fenced-out holder came back
          // and reached the destination *zero* times, which is the
          // destination-side statement of "a stale writer is rejected, not
          // merged".
          const winner = controller.adapter.effectKeys(role, faultCase, {
            holderSuffix: claimant["holder_suffix"] as string,
          });
          for (const key of winner) {
            const count = observer.effectCount(key);
            if (count !== 1) {
              fail(
                `${role}: claimant key ${JSON.stringify(key)} produced ${count} effects, not one`,
              );
            }
          }
          for (const key of keys) {
            const count = observer.effectCount(key);
            if (count !== 0) {
              fail(
                `${role}: the superseded holder's key ${JSON.stringify(key)} reached the ` +
                  `destination ${count} time(s)`,
              );
            }
          }
          continue;
        }
        for (const key of keys) {
          const count = observer.effectCount(key);
          if (count !== 1) {
            fail(`${role}: ${JSON.stringify(key)} produced ${count} effects, not one`);
          }
        }
        if (rejectedClaimant && claimant !== null) {
          // The loser of the race never got a lease, so it never reached the
          // destination. That zero is the destination-side statement of "a stale
          // writer is rejected, not merged" -- the control-plane half is the
          // recorded refusal.
          const loser = controller.adapter.effectKeys(role, faultCase, {
            holderSuffix: claimant["holder_suffix"] as string,
          });
          for (const key of loser) {
            const count = observer.effectCount(key);
            if (count !== 0) {
              fail(
                `${role}: the rejected writer's key ${JSON.stringify(key)} reached the ` +
                  `destination ${count} time(s); it was refused and should have reached it none`,
              );
            }
          }
        }
      } else if (name === contract.INVARIANT_DELIVERED_IMPLIES_EFFECT) {
        // A delivery-surface fault is *about* the repeat: the resend after a
        // drop, the second copy of a duplicate, the re-delivery after a lost
        // ack. Counting one attempt would accept a run in which the repeat never
        // happened -- the case would then be reporting coverage of a fault it
        // did not inject. The floor is therefore stated per fault kind and read
        // from the destination's own attempt log.
        const floor = ATTEMPT_FLOOR[fault] ?? 1;
        for (const key of keys) {
          const attempts = observer.attemptCount(key);
          if (attempts < floor) {
            fail(
              `${role}: ${JSON.stringify(key)} was attempted ${attempts} time(s) at the ` +
                `destination; a ${fault} case requires at least ${floor}, because the repeat ` +
                "is the evidence",
            );
          }
        }
        // One effect *record* per delivery dedup key, counted over the
        // destination's whole store and not only over the keys we expected: a
        // per-key existence test cannot see an extra effect published under a
        // key nobody asked about.
        const published = typeof observer.effects === "function" ? [...observer.effects()] : [];
        if (published.length > 0 && published.length !== new Set(keys).size && !superseded) {
          fail(
            `${role}: the destination holds ${published.length} effect records for ` +
              `${new Set(keys).size} dedup key(s): ${JSON.stringify(published)}`,
          );
        }
        for (const key of keys) {
          if (observer.attemptCount(key) < 1) {
            fail(`${role}: ${JSON.stringify(key)} was never attempted at the destination`);
          }
          if (observer.effectCount(key) < 1) {
            fail(
              `${role}: ${JSON.stringify(key)} is delivered in our rows but absent at the ` +
                "destination",
            );
          }
        }
      } else if (name === contract.INVARIANT_LIVE_PROCESSES_PER_SESSION) {
        // Gate item 2: a process is an external effect, so the count is the
        // destination's own -- real processes, read out of process with the
        // killed role, never inferred from rows.
        if (typeof observer.liveProcessReport !== "function") {
          fail(
            `${role}: the case names ` +
              `${JSON.stringify(contract.INVARIANT_LIVE_PROCESSES_PER_SESSION)} but the ` +
              "adapter's observer exposes no liveProcessReport()",
          );
          continue;
        }
        const live = observer.liveProcessReport();
        if (Object.keys(live).length === 0) {
          fail(
            `${role}: the live-process report names no session at all, so 'no two live ` +
              "processes per id' asserts nothing",
          );
        }
        for (const sessionUuid of Object.keys(live).sort()) {
          const count = live[sessionUuid];
          if (count === null || count === undefined) {
            // The destination's ledger holds a start with no exit from a process
            // that is dead now: when it died is unknowable, so any overlap is
            // unprovable either way. Indeterminate fails loudly rather than
            // passing as "one" (ACCEPTANCE.md section 2: a case that cannot
            // observe its invariant does not certify it).
            fail(
              `${role}: session ${JSON.stringify(sessionUuid)}'s liveness record is ` +
                "indeterminate (a start with no exit, process gone); the overlap cannot be " +
                "certified",
            );
            continue;
          }
          if (count > 1) {
            fail(
              `${role}: ${count} provider processes were concurrently live against session ` +
                `${JSON.stringify(sessionUuid)}; two live processes on one id is the violation ` +
                "item 2 names, not a residual to be weighed",
            );
          }
        }
      } else if (name === contract.INVARIANT_TRANSCRIPT_SINGLE_WRITER) {
        // The captured event streams are the C2 transcript stand-in: one
        // identity per stream, no duplicated turn. An interleaved transcript
        // fails item 2 outright.
        if (typeof observer.transcriptReport !== "function") {
          fail(
            `${role}: the case names ` +
              `${JSON.stringify(contract.INVARIANT_TRANSCRIPT_SINGLE_WRITER)} but the ` +
              "adapter's observer exposes no transcriptReport()",
          );
          continue;
        }
        const transcripts = observer.transcriptReport();
        if (Object.keys(transcripts).length === 0) {
          fail(
            `${role}: the transcript report names no session, so 'no interleaved transcript' ` +
              "asserts nothing",
          );
        }
        for (const sessionUuid of Object.keys(transcripts).sort()) {
          const shape = transcripts[sessionUuid];
          const distinct = [...(shape?.distinct_ids ?? [])];
          const duplicates = Number(shape?.duplicate_turn_ids ?? 0);
          if (distinct.length > 1) {
            fail(
              `${role}: session ${JSON.stringify(sessionUuid)}'s stream names ` +
                `${distinct.length} identities: ${JSON.stringify(distinct)}`,
            );
          }
          if (distinct.length > 0 && distinct[0] !== sessionUuid) {
            fail(
              `${role}: session ${JSON.stringify(sessionUuid)}'s stream names ` +
                `${JSON.stringify(distinct[0])} instead of its own identity`,
            );
          }
          if (duplicates) {
            fail(
              `${role}: session ${JSON.stringify(sessionUuid)}'s stream carries ${duplicates} ` +
                "duplicated turn id(s) -- an interleaved transcript is a failed gate item, not " +
                "an accepted weakening",
            );
          }
          const streams = shape?.streams;
          const ledgerStarts = shape?.ledger_starts;
          if (streams !== undefined && ledgerStarts !== undefined && streams > ledgerStarts) {
            // A stream is one child's stdout; every one must be accounted for by
            // an admitted spawn in the ledger. A surplus stream is a writer
            // nobody admitted, hiding as "just another generation".
            // (Cross-stream concurrency itself is
            // live-processes-per-session's question -- the ledger's interval
            // overlap.)
            fail(
              `${role}: session ${JSON.stringify(sessionUuid)} has ${streams} event stream(s) ` +
                `but only ${ledgerStarts} admitted spawn(s); a stream with no admitted spawn ` +
                "is an unaccounted writer",
            );
          }
        }
      } else {
        throw new ContractViolation(
          `${JSON.stringify(name)} is a named destination invariant with no assertion behind ` +
            "it; the chain has no silent default",
        );
      }
    }
  }

  // -- the window was the window ----------------------------------------
  //
  // ACCEPTANCE.md section 2 calls the after-effect window "the one that proves
  // idempotency rather than luck". Proving it requires knowing the effect was
  // already at the destination when the process died -- which is only observable
  // between the kill and the restart, because recovery re-attempts and both
  // windows look identical afterwards.
  const atKill = options.atKill ?? null;
  if (atKill !== null && contract.KILL_FAULTS.includes(fault)) {
    for (const role of faultCase["targets"] as string[]) {
      const anchors = armedFor(faultCase, role);
      const counted = atKill[role] ?? {};
      if (Object.keys(counted).length === 0 || anchors.length === 0) {
        continue;
      }
      const first = anchors[0] as ArmedAnchor;
      if (!contract.CHECKPOINTS.includes(first.anchor as (typeof contract.CHECKPOINTS)[number])) {
        continue;
      }
      if (
        first.operation !== contract.OPERATION_ATTEMPT &&
        first.operation !== contract.OPERATION_SESSION_START
      ) {
        // Only record -> effect -> result paths have effect windows: the
        // delivery attempt, and the session-start whose effect is the spawn,
        // counted from the destination's own ledger. A kill armed on `ack` sits
        // *after* that role's delivery by construction, so counting effects
        // against the anchor's name would be reading a window that operation
        // does not have.
        continue;
      }
      const occurrence = first.occurrence;
      const present = Object.values(counted).reduce((total, value) => total + value, 0);
      // Occurrence N means N-1 earlier deliveries have already completed, so the
      // expected count is stated against the occurrence rather than against
      // zero -- otherwise the `occ2` variant, which exists precisely to arm a
      // later pass through the loop, would look like a kill that landed too
      // late.
      const expectedEffects = contract.EFFECT_BEARING_CHECKPOINTS.includes(first.anchor)
        ? occurrence
        : occurrence - 1;
      if (present !== expectedEffects) {
        fail(
          `${role}: killed at occurrence ${occurrence} of ${first.anchor}, where the ` +
            `destination should hold ${expectedEffects} effect(s); it held ${present}. The ` +
            "kill did not land inside the window this case claims to prove",
        );
      }
    }
  }

  const owner = expected.recovery_owner;
  const unresolvedAtKill = options.unresolvedAtKill ?? null;
  if (faultCase["restart_after"] && owner !== null) {
    // "Somebody recovered it" is not an assertion (design 5). Two things are
    // checked, because the recovery-complete event alone is emitted by every
    // restart and would be tautological: the named role signalled it, *and*
    // there was unfinished work at the moment of the kill for its recovery to
    // have driven to resolution. A case that left nothing unresolved proves
    // nothing about recovery and is a manifest error, not a pass.
    const recovered = controller
      .allTraces()
      .filter(
        (entry) =>
          entry.role === owner &&
          entry.generation > 0 &&
          entry.trace.some((event) => event.event === EVENT_RECOVERY_COMPLETE),
      );
    if (recovered.length === 0) {
      fail(`${owner} never signalled recovery-complete after its restart`);
    }

    if (unresolvedAtKill !== null) {
      const leftBehind = (faultCase["targets"] as string[]).flatMap(
        (role) => unresolvedAtKill[role] ?? [],
      );
      if (leftBehind.length === 0) {
        fail(
          "the kill left no durable state -- no unacked message, no pending action, no held " +
            `lease -- so the restart recovered nothing and naming ${JSON.stringify(owner)} as ` +
            "the recovery owner asserts recovery vacuously",
        );
      }
    }
  }

  if (faultCase["restart_after"] && owner === null && unresolvedAtKill !== null) {
    // The other direction, so the rule cannot be satisfied by simply declining
    // to name an owner: a case that *did* leave work behind must say whose
    // recovery resolved it.
    const leftBehind = (faultCase["targets"] as string[]).flatMap(
      (role) => unresolvedAtKill[role] ?? [],
    );
    if (leftBehind.length > 0) {
      fail(
        `the kill left ${leftBehind.length} piece(s) of durable state behind but the case ` +
          "names no recovery owner; 'somebody recovered it' is not an assertion (design 5)",
      );
    }
  }
}
