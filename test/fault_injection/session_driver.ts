/**
 * The session adapter: gate item 2's `session-start` cases.
 *
 * Ported from interlock `tests/fault_injection/session_driver.py` at `65f36c5`
 * (follow-on task on D-0601 / D-0801; see DECISIONS.md).
 *
 * Where `spike_driver.ts` binds the harness to the S6/S7 spike surface, this
 * module binds it to the *real* crash-window components: `SessionOrchestrator`
 * (`src/supervisor.ts`, the supervisor join layer) and `ClaudeCliSessionProvider`
 * (`src/session/claude_cli_provider.ts`) over a deterministic fake CLI. It is
 * the second of `ADAPTER_MODULES` -- the only files in this tree
 * `import-graph.test.ts` permits to import `src/` -- and it exists so the four
 * injection points of gate item 2 are exercised by a real `SIGKILL` against a
 * real process at an armed anchor, not by an in-process simulation.
 *
 * One role (`sup`), one operation (`session-start`). The orchestrator's own
 * seams (`src/supervisor.ts`'s `SEAM_*` exports) are mapped onto the barrier's
 * anchors, so the kill lands exactly where the case says: before the binding
 * commit, between the commit and the spawn, between the spawn and the
 * read-back's commit, or after the read-back's commit.
 *
 * Two deliberate departures from the spike driver's rules, stated rather than
 * hidden:
 *
 * - a real wall-clock wait appears here, in two places: the orchestrator's own
 *   `wait` (the read-back poll) and the seam's poll for the destination's own
 *   spawn record. Every *timestamp* still comes from the injected {@link Clock}
 *   -- the wait is IO pacing against a real subprocess, never a figure that
 *   reaches a row, and never a measured admission-window width (design's U34).
 * - this adapter is a `CaseAdapter`, not a `FullFaultAdapter` (D-0601's two
 *   adapter classes): the full conformance battery presupposes a three-role
 *   delivery loop this adapter deliberately does not have. Its own
 *   reachability/kill/recovery checks live in
 *   `test/gate_item2/session-driver-harness.test.ts`.
 *
 * **No dedicated reaper for the destination's grandchild.** The provider spawns
 * each fake-CLI child detached (its own session/process group -- exactly the
 * shape the mediated real-provider tests already exercise), so a `SIGKILL` of
 * the `sup` role process never touches it: that is the point (the "surviving
 * child" window `#refuseAndTerminate` and `recover()`'s adoption path are
 * about). Nothing here or in `controller.ts` ever kills the destination on
 * purpose. The four session cases are single-role, non-combination, and
 * `bootstrap` never repeats within a case, so the fake CLI's own release
 * (see {@link stopFilePath}, a condition rather than a fixed sleep, plus a
 * bounded safety cap) is what ends it -- the same reasoning `controller.ts`'s
 * `teardown()` docstring gives for why *that* ladder reaps role processes but
 * not their detached grandchildren: the destination's lifetime is its own
 * concern, bounded and self-terminating, and a harness-side reaper would be
 * solving a problem the fixture does not have. `vitest`'s own worker teardown
 * is the backstop if a run is ever aborted mid-case, exactly as it is for the
 * session belt's own fake-CLI fixture.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";

import { LeaseHeld } from "../../src/control_plane/lease.js";
import { createControlPlane, openControlPlane } from "../../src/control_plane/schema.js";
import { ClaudeCliSessionProvider } from "../../src/session/claude_cli_provider.js";
import { uuid5 } from "../../src/session/uuid5.js";
import {
  READBACK_POLL_INTERVAL_MS,
  SEAM_AFTER_ADMISSION_BEFORE_SPAWN,
  SEAM_AFTER_READBACK_COMMIT,
  SEAM_AFTER_SPAWN_BEFORE_READBACK_COMMIT,
  SEAM_BEFORE_ADMISSION_COMMIT,
  SessionOrchestrator,
} from "../../src/supervisor.js";

import * as contract from "./contract.js";
import {
  ArmedAnchor,
  type CaseAdapter,
  ContractViolation,
  type DestinationObserver,
  EVENT_DONE,
  EVENT_ERROR,
  EVENT_HELLO,
  EVENT_RECOVERY_COMPLETE,
  type FaultCase,
  type TranscriptShape,
} from "./contract.js";
import {
  Barrier,
  Clock,
  INVARIANT_QUERIES,
  RESTART_CLOCK_ADVANCE_MS,
  stableStringify,
} from "./spike_driver.js";

/** This file, which is what the controller spawns. */
const DRIVER_SOURCE_PATH = fileURLToPath(import.meta.url);

const RUN_ID = "run-session-start";
const RESOURCE = `session-run:${RUN_ID}`;
const HOLDER = "sup-session";

/**
 * The orchestrator's seams, mapped onto the contract's anchors. The first
 * three are checkpoint windows; the fourth is the sync point (there is no
 * further write for a checkpoint to sit in front of).
 */
const SEAM_ANCHORS: Readonly<Record<string, { anchor: string; kind: string }>> = Object.freeze({
  [SEAM_BEFORE_ADMISSION_COMMIT]: {
    anchor: contract.CHECKPOINT_BEFORE_DURABLE_WRITE,
    kind: contract.EVENT_CHECKPOINT,
  },
  [SEAM_AFTER_ADMISSION_BEFORE_SPAWN]: {
    anchor: contract.CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
    kind: contract.EVENT_CHECKPOINT,
  },
  [SEAM_AFTER_SPAWN_BEFORE_READBACK_COMMIT]: {
    anchor: contract.CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
    kind: contract.EVENT_CHECKPOINT,
  },
  [SEAM_AFTER_READBACK_COMMIT]: {
    anchor: contract.SYNC_IDENTITY_READBACK_COMMITTED,
    kind: contract.EVENT_SYNC,
  },
});

/**
 * The upper bound on how long the fake CLI will hold, if nothing ever tells
 * it to stop.
 *
 * Not the figure that ends the hold on the path any of the four cases
 * actually take -- {@link stopFilePath} is -- but a safety net against an
 * orphaned child outliving a run that failed before reaching the point that
 * writes the stop file (an assertion failure between the kill and the
 * cleanup, say). Held well under `RUNNER_BUDGET_CEILING_S` so a leaked
 * process still exits before the suite's own watchdogs would have reason to
 * suspect one.
 */
const HOLD_SAFETY_CAP_MS = 45_000;

function fakeCliPath(workdir: string): string {
  return join(workdir, "fake-claude-session.mjs");
}

function spawnLogPath(workdir: string): string {
  return join(workdir, "session-spawns.jsonl");
}

function stateRootPath(workdir: string): string {
  return join(workdir, "session-state");
}

/**
 * The file whose *existence* releases a holding fake CLI (see
 * {@link FAKE_CLI_SOURCE}).
 *
 * A condition on the filesystem, not a fixed sleep: the P3 "surviving child"
 * window -- recovery adopts a live process rather than spawning a duplicate --
 * is only genuinely exercised if the child is provably still alive at the
 * instant `recover()` looks for it, on every runner speed, not merely on one
 * fast enough to beat a guessed timeout. `runWalk` creates this file in a
 * `finally` once a generation's own walk is over (success or failure),
 * releasing whatever earlier generation's child is still waiting -- there is
 * at most one live child across these single-role, non-combination cases, so
 * one shared path is unambiguous.
 */
function stopFilePath(workdir: string): string {
  return join(workdir, "session-driver-stop");
}

/**
 * Deterministic identity per (case, generation) -- never a random UUID.
 *
 * Deterministic so two runs of one case produce comparable traces; distinct
 * per generation so a recovery that finds no binding mints a genuinely fresh
 * identity rather than colliding with a half-dead claim.
 */
function sessionUuidFor(caseId: string, generation: number): string {
  return uuid5(NAMESPACE_URL_UUID, `continuo-i18:${caseId}:${generation}`);
}

/** RFC 4122's URL namespace, the same one `uuid.NAMESPACE_URL` names. */
const NAMESPACE_URL_UUID = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * Block the event loop for `ms`, with a real signal-in-front-of-a-process
 * discipline: no timestamp derives from this, it is IO pacing.
 *
 * Node has no blocking `sleep`; `Atomics.wait` on a scratch buffer is the
 * standard synchronous substitute, and synchronicity is required here because
 * `SessionOrchestrator`'s `seam` callback is itself synchronous (mirroring
 * `Barrier.hit`, which blocks with a real `readSync`).
 */
function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, Math.max(0, ms));
}

/**
 * The deterministic fake CLI, written to the case's own workdir.
 *
 * Same discipline as the S2 test harness (`test/session/helpers/fake-claude.mjs`):
 * it honours whatever identity it is told to claim and refuses nothing (the
 * design's U27/U32 assumed absent by construction), and emits the minimal
 * stream-json walk (`init` -> `result`) so the identity read-back is positive.
 * Kept as its own file rather than reusing the S2 fixture: this adapter needs
 * its own start/exit ledger with real pids and timestamps (for
 * `live-processes-per-session`'s interval-overlap computation), which the S2
 * fixture's spawn log does not carry, and duplicating that shape onto a fixture
 * built for the session belt's own 65 cases would risk it for both.
 */
const FAKE_CLI_SOURCE = `
import { appendFileSync, existsSync, writeSync } from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);

function out(text) {
  writeSync(1, \`\${text}\\n\`);
}

if (args.includes("--version")) {
  out("9.9.9-fake (Claude Code)");
  process.exit(0);
}

if (args.includes("--help")) {
  out("Usage: claude [options] [command] [prompt]");
  out("  -p, --print                Print response and exit");
  out("  --session-id <uuid>        Use a specific session ID");
  out("  -r, --resume [value]       Resume a conversation by session ID");
  out("  --output-format <format>   Output format (json | stream-json)");
  out("  --verbose                  Override verbose mode");
  process.exit(0);
}

function argAfter(flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

const claimed = argAfter("--session-id") ?? argAfter("--resume") ?? null;

const log = process.env.SESSION_DRIVER_SPAWN_LOG;
function ledger(event) {
  if (log) {
    appendFileSync(
      log,
      \`\${JSON.stringify({ event, uuid: claimed, pid: process.pid, t: Date.now() / 1000, argv: args })}\\n\`,
      "utf8",
    );
  }
}

ledger("start");

function emit(payload) {
  out(JSON.stringify(payload));
}

emit({ type: "system", subtype: "init", session_id: claimed });

// Holds until \`stopFile\` appears, polling rather than sleeping a fixed
// duration: the surviving-child window has to be true AT THE INSTANT a
// restarted generation looks for it, on every runner speed, not merely on
// one that beats a guessed timeout. The safety cap bounds an orphan if
// nothing ever writes the stop file (a run that failed before its own
// cleanup, say).
const stopFile = process.env.SESSION_DRIVER_STOP_FILE;
const safetyCapMs = Number(process.env.SESSION_DRIVER_SAFETY_CAP_MS ?? "0");
const pollMs = 20;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  if (stopFile) {
    let waitedMs = 0;
    while (!existsSync(stopFile) && (safetyCapMs <= 0 || waitedMs < safetyCapMs)) {
      await sleep(pollMs);
      waitedMs += pollMs;
    }
  }
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    session_id: claimed,
  });
  ledger("exit");
  process.exit(0);
}

main();
`;

interface LedgerEntry {
  readonly event?: string;
  readonly uuid?: string | null;
  readonly pid?: number;
  readonly t?: number;
}

/**
 * The destination's own record: real processes and captured streams.
 *
 * A spawned process is the external effect of `session-start`, so both
 * reports are read from outside the killed role -- the ledger the fake CLI
 * itself appends to for liveness, the provider's own captured
 * `events-*.jsonl` for the transcript stand-in -- never inferred from
 * control-plane rows.
 */
class SessionObserver implements DestinationObserver {
  readonly #workdir: string;

  constructor(workdir: string) {
    this.#workdir = workdir;
  }

  #sessionUuids(): string[] {
    const root = stateRootPath(this.#workdir);
    if (!existsSync(root)) {
      return [];
    }
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  #ledger(): LedgerEntry[] {
    const log = spawnLogPath(this.#workdir);
    if (!existsSync(log)) {
      return [];
    }
    const entries: LedgerEntry[] = [];
    for (const line of readFileSync(log, "utf8").split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      try {
        entries.push(JSON.parse(line) as LedgerEntry);
      } catch {
        // A torn line from a killed writer: not this observer's evidence to fix.
      }
    }
    return entries;
  }

  /**
   * Processes live right now on this session id, filtered to this workdir's
   * own fake CLI so a concurrent run elsewhere is never counted.
   */
  #liveNow(sessionUuid: string): number {
    if (!existsSync("/proc")) {
      return 0;
    }
    const marker = fakeCliPath(this.#workdir);
    let count = 0;
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      let cmdline: string;
      try {
        cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      } catch {
        continue;
      }
      if (cmdline.includes(sessionUuid) && cmdline.includes(marker)) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * `{sessionUuid: max concurrently-live process count}`.
   *
   * Read from the destination's own start/exit ledger, not from our rows:
   * each spawn writes a start line and (on a normal exit) an exit line, so
   * the maximum interval overlap per id is answerable *after* every child has
   * exited -- a post-hoc `/proc` scan alone would report 0 for a violation
   * whose two processes both finished. A start with no exit line is treated
   * as still open if the process is live now, and as an unknowable point
   * otherwise (a SIGKILLed child writes no exit; its interval is not
   * invented).
   */
  liveProcessReport(): Readonly<Record<string, number | null>> {
    const report: Record<string, number | null> = {};
    for (const uuid of this.#sessionUuids()) {
      report[uuid] = 0;
    }
    const intervals = new Map<string, [number, number][]>();
    const opens = new Map<string, number>();
    const indeterminate = new Set<string>();
    for (const entry of this.#ledger()) {
      const uuid = entry.uuid;
      if (!uuid) {
        continue;
      }
      if (!(uuid in report)) {
        report[uuid] = 0;
      }
      const key = `${uuid} ${entry.pid}`;
      if (entry.event === "start") {
        opens.set(key, Number(entry.t));
      } else if (entry.event === "exit") {
        const started = opens.get(key);
        if (started !== undefined) {
          opens.delete(key);
          const list = intervals.get(uuid) ?? [];
          list.push([started, Number(entry.t)]);
          intervals.set(uuid, list);
        }
      }
    }
    for (const [key, started] of opens) {
      const uuid = key.slice(0, key.indexOf(" "));
      if (this.#liveNow(uuid) > 0) {
        const list = intervals.get(uuid) ?? [];
        list.push([started, Number.POSITIVE_INFINITY]);
        intervals.set(uuid, list);
        continue;
      }
      // Not live now -- but it may have exited between the ledger snapshot
      // above and this `/proc` check: the restarted generation's stop-file
      // release and the fake CLI's own normal exit race this scan, and a
      // process that exited in that window is a closed interval, not an
      // unexplained death. Re-read the ledger fresh rather than judge a
      // still-open entry on a snapshot that may already be stale.
      const exited = this.#ledger().find(
        (entry) => entry.event === "exit" && `${entry.uuid} ${entry.pid}` === key,
      );
      if (exited !== undefined) {
        const list = intervals.get(uuid) ?? [];
        list.push([started, Number(exited.t)]);
        intervals.set(uuid, list);
      } else {
        indeterminate.add(uuid);
      }
    }
    for (const uuid of Object.keys(report)) {
      if (indeterminate.has(uuid)) {
        report[uuid] = null;
        continue;
      }
      const spans = [...(intervals.get(uuid) ?? [])].sort((a, b) => a[0] - b[0]);
      let peak = 0;
      for (let index = 0; index < spans.length; index += 1) {
        const [start] = spans[index] as [number, number];
        let overlap = 1;
        for (let earlier = 0; earlier < index; earlier += 1) {
          const [, earlierEnd] = spans[earlier] as [number, number];
          if (earlierEnd > start) {
            overlap += 1;
          }
        }
        peak = Math.max(peak, overlap);
      }
      report[uuid] = Math.max(peak, this.#liveNow(uuid));
    }
    return report;
  }

  /**
   * Per session: the identities its streams name, and doubled turns.
   *
   * A stream (one `events-NNN.jsonl`, `src/session/claude_cli_provider.ts`'s
   * own capture file) belongs to one child process, so *within* a stream two
   * writers double its `init`/`result` events and a foreign writer plants a
   * second identity -- both counted here. Every stream must be accounted for
   * by a ledger start record, so a writer nobody admitted cannot hide as
   * "just another generation".
   */
  transcriptReport(): Readonly<Record<string, TranscriptShape>> {
    const report: Record<string, TranscriptShape> = {};
    const startsPerUuid = new Map<string, number>();
    for (const entry of this.#ledger()) {
      if (entry.event === "start" && entry.uuid) {
        startsPerUuid.set(entry.uuid, (startsPerUuid.get(entry.uuid) ?? 0) + 1);
      }
    }
    for (const sessionUuid of this.#sessionUuids()) {
      const distinct = new Set<string>();
      let duplicates = 0;
      let streams = 0;
      const directory = join(stateRootPath(this.#workdir), sessionUuid);
      const files = existsSync(directory)
        ? readdirSync(directory)
            .filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"))
            .sort()
        : [];
      for (const file of files) {
        streams += 1;
        const seen = new Map<string, number>();
        for (const line of readFileSync(join(directory, file), "utf8").split("\n")) {
          if (line.trim() === "") {
            continue;
          }
          let event: { session_id?: unknown; type?: unknown };
          try {
            event = JSON.parse(line) as { session_id?: unknown; type?: unknown };
          } catch {
            continue;
          }
          if (typeof event.session_id === "string" && event.session_id !== "") {
            distinct.add(event.session_id);
          }
          const kind = event.type;
          if (kind === "system" || kind === "result") {
            seen.set(String(kind), (seen.get(String(kind)) ?? 0) + 1);
          }
        }
        for (const count of seen.values()) {
          if (count > 1) {
            duplicates += count - 1;
          }
        }
      }
      report[sessionUuid] = {
        distinct_ids: [...distinct].sort(),
        duplicate_turn_ids: duplicates,
        streams,
        ledger_starts: startsPerUuid.get(sessionUuid) ?? 0,
      };
    }
    return report;
  }

  /**
   * Spawns on one session id, counted from the destination's ledger.
   *
   * The key shape is `spawn:<session_uuid>`. This is what lets the
   * controller's window-landing gate prove the kill really fell where the
   * case claims: a kill before the effect window must find zero spawn
   * records, and one after it exactly one.
   */
  effectCount(idempotencyKey: string): number {
    if (!idempotencyKey.startsWith("spawn:")) {
      return 0;
    }
    const sessionUuid = idempotencyKey.slice("spawn:".length);
    return this.#ledger().filter((entry) => entry.event === "start" && entry.uuid === sessionUuid)
      .length;
  }

  attemptCount(idempotencyKey: string): number {
    return this.effectCount(idempotencyKey);
  }

  /** No delivery surface to unwedge. */
  unwedge(): void {
    // Intentionally empty: see the file header's reaper note.
  }
}

/** `contract.CaseAdapter` for the session lane (D-0601's two adapter classes). */
export class SessionAdapter implements CaseAdapter {
  readonly name = "session";
  readonly driverModule = "test/fault_injection/session_driver.ts";

  /** The operation these cases inject into, named so a report can cite it. */
  readonly operation = contract.OPERATION_SESSION_START;

  /**
   * The command that runs this driver as a child process.
   *
   * Same shape as `SpikeAdapter.driverCommand` (type-stripped `.ts`, via the
   * same register shim); see that method's docstring for why the `--import`
   * specifier is an `href` and not a path. One deliberate difference: this
   * adapter's import graph reaches `src/session/claude_cli_provider.ts`,
   * which reaches `src/fencing/pyjson.ts` -- a file that uses a TypeScript
   * parameter property (`constructor(private readonly src: string)`), a
   * non-erasable construct Node's plain type-*stripping* refuses outright
   * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, in both the flagged strip-only mode
   * on Node <23.6 and the unflagged default on Node >=23.6). `spike_driver.ts`
   * never imports that far and has never needed more than stripping.
   * `--experimental-transform-types` asks Node for the fuller *transform*
   * that lowers parameter properties (and enums, and namespaces) to plain
   * JavaScript instead of refusing them; it implies strip-types, so it is
   * requested unconditionally here rather than only below Node 23.
   */
  driverCommand(): { executable: string; prefixArguments: readonly string[] } {
    const register = new URL("./driver-register.mjs", import.meta.url).href;
    return {
      executable: process.execPath,
      prefixArguments: ["--experimental-transform-types", "--import", register, DRIVER_SOURCE_PATH],
    };
  }

  /** Create the control plane, the run row, and the fake CLI the walk spawns. */
  bootstrap(dbPath: string, options: { roles: readonly string[]; nowMs: number }): void {
    const connection = createControlPlane(dbPath);
    try {
      connection
        .prepare(
          "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'running', ?, ?)",
        )
        .run(RUN_ID, Math.trunc(options.nowMs), Math.trunc(options.nowMs));
    } finally {
      connection.close();
    }
    const workdir = dirname(dbPath);
    writeFileSync(fakeCliPath(workdir), FAKE_CLI_SOURCE, "utf8");
    mkdirSync(join(workdir, "workspace"), { recursive: true });
  }

  roleArguments(_role: string, options: { case: FaultCase; workdir: string }): readonly string[] {
    const ttlMs = Number(options.case["ttl_ms"] ?? 30_000);
    return ["--workdir", options.workdir, "--ttl-ms", String(ttlMs)];
  }

  observer(workdir: string, _role: string): DestinationObserver {
    return new SessionObserver(workdir);
  }

  /** The store is the same spike control-plane schema, so its SQL binds unchanged. */
  invariantQueries(): Readonly<Record<string, string>> {
    return { ...INVARIANT_QUERIES };
  }

  storePath(_name: string, options: { controlPlane: string; workdir: string }): string {
    return options.controlPlane;
  }

  queryParameters(_role: string, options: { nowMs: number }): Readonly<Record<string, unknown>> {
    return {
      resource: RESOURCE,
      holder: HOLDER,
      holder_prefix: `${HOLDER}-m%`,
      scope: RUN_ID,
      now_ms: Math.trunc(options.nowMs),
    };
  }

  /**
   * One key: the generation-0 spawn. The controller samples its count between
   * the kill and the restart, which is what proves the kill landed inside the
   * claimed window (zero spawns before the effect window, exactly one after
   * it).
   */
  effectKeys(
    _role: string,
    faultCase: FaultCase,
    _options: { holderSuffix?: string } = {},
  ): readonly string[] {
    return [`spawn:${sessionUuidFor(String(faultCase["case_id"]), 0)}`];
  }

  holderOf(_role: string): string {
    return HOLDER;
  }
}

export const SESSION_ADAPTER = new SessionAdapter();

// ---------------------------------------------------------------------------
// the driver process
// ---------------------------------------------------------------------------

interface ParsedArguments {
  role: string;
  db: string;
  caseId: string;
  suiteSeed: number;
  armed: string;
  clockBaseMs: number;
  clockOffsetMs: number;
  restartGeneration: number;
  controlFd: number;
  eventFd: number;
  workdir: string;
  ttlMs: number;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const parsed: Partial<ParsedArguments> = {
    armed: "",
    clockOffsetMs: 0,
    restartGeneration: 0,
    controlFd: 0,
    eventFd: 1,
    ttlMs: 30_000,
  };
  const remaining = [...argv];
  const requireInteger = (option: string, value: string): number => {
    const parsedValue = Number(value);
    if (!Number.isInteger(parsedValue)) {
      throw new ContractViolation(`${option} expects an integer, got ${JSON.stringify(value)}`);
    }
    return parsedValue;
  };
  const next = (option: string): string => {
    const value = remaining.shift();
    if (value === undefined) {
      throw new ContractViolation(`${option} expects a value`);
    }
    return value;
  };
  while (remaining.length > 0) {
    const option = remaining.shift() as string;
    switch (option) {
      case "--role":
        parsed.role = next(option);
        break;
      case "--db":
        parsed.db = next(option);
        break;
      case "--case-id":
        parsed.caseId = next(option);
        break;
      case "--suite-seed":
        parsed.suiteSeed = requireInteger(option, next(option));
        break;
      case "--armed":
        parsed.armed = next(option);
        break;
      case "--clock-base-ms":
        parsed.clockBaseMs = requireInteger(option, next(option));
        break;
      case "--clock-offset-ms":
        parsed.clockOffsetMs = requireInteger(option, next(option));
        break;
      case "--restart-generation":
        parsed.restartGeneration = requireInteger(option, next(option));
        break;
      case "--control-fd":
        parsed.controlFd = requireInteger(option, next(option));
        break;
      case "--event-fd":
        parsed.eventFd = requireInteger(option, next(option));
        break;
      case "--workdir":
        parsed.workdir = next(option);
        break;
      case "--ttl-ms":
        parsed.ttlMs = requireInteger(option, next(option));
        break;
      default:
        throw new ContractViolation(`unknown option ${JSON.stringify(option)}`);
    }
  }
  if (parsed.role !== contract.ROLE_SUPERVISOR) {
    throw new ContractViolation(`--role must be ${JSON.stringify(contract.ROLE_SUPERVISOR)}`);
  }
  for (const [option, value] of [
    ["--db", parsed.db],
    ["--case-id", parsed.caseId],
    ["--suite-seed", parsed.suiteSeed],
    ["--clock-base-ms", parsed.clockBaseMs],
    ["--workdir", parsed.workdir],
  ] as const) {
    if (value === undefined) {
      throw new ContractViolation(`${option} is required`);
    }
  }
  return parsed as ParsedArguments;
}

/**
 * The commit-before-spawn walk for one role process: fresh admission at
 * generation 0, recovery at every later generation.
 */
async function runWalk(options: {
  connection: SqliteDatabase;
  workdir: string;
  caseId: string;
  generation: number;
  ttlMs: number;
  clock: Clock;
  barrier: Barrier;
  armed: readonly ArmedAnchor[];
  emit: (message: Record<string, unknown>) => void;
}): Promise<void> {
  const { connection, workdir, caseId, generation, ttlMs, clock, barrier, armed, emit } = options;
  const effectWindowArmed = armed.some(
    (anchor) => anchor.anchor === contract.CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
  );

  const seam = (name: string): void => {
    const mapped = SEAM_ANCHORS[name];
    if (mapped === undefined) {
      throw new ContractViolation(`unknown orchestrator seam ${JSON.stringify(name)}`);
    }
    if (mapped.anchor === contract.CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD && effectWindowArmed) {
      // "After the effect" must be true *at the barrier*, not merely after
      // the spawn call returned: the controller samples the destination's
      // ledger between the kill and the restart, and a child that had not
      // yet written its start line would make a genuinely-entered window
      // read as never entered. IO pacing only -- the ledger is the
      // destination's own record, and no timestamp from here reaches a row.
      const log = spawnLogPath(workdir);
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (existsSync(log) && readFileSync(log, "utf8").includes('"start"')) {
          break;
        }
        sleepSync(10);
      }
    }
    barrier.hit(mapped.anchor, { operation: contract.OPERATION_SESSION_START, kind: mapped.kind });
  };

  const provider = new ClaudeCliSessionProvider(stateRootPath(workdir), {
    claudeCommand: [process.execPath, fakeCliPath(workdir)],
    stopTimeout: 2.0,
  });
  // The provider's own spawn forwards `process.env`; the fake CLI reads these
  // switches through it. Set here (once, before the walk) rather than at
  // bootstrap, so a restart's own provider instance still sees them. Every
  // generation's spawn gets the same stop-file path: at most one live child
  // exists at a time across these single-role, non-combination cases, so one
  // shared path is unambiguous, and a fresh spawn checking a not-yet-written
  // file behaves exactly like a first spawn would.
  process.env["SESSION_DRIVER_SPAWN_LOG"] = spawnLogPath(workdir);
  process.env["SESSION_DRIVER_STOP_FILE"] = stopFilePath(workdir);
  process.env["SESSION_DRIVER_SAFETY_CAP_MS"] = String(HOLD_SAFETY_CAP_MS);

  const orchestrator = new SessionOrchestrator(connection, provider, {
    runId: RUN_ID,
    holder: `${HOLDER}-g${generation}`,
    workspace: join(workdir, "workspace"),
    role: "worker",
    nowMs: () => clock.nowMs(),
    sessionUuidFactory: () => sessionUuidFor(caseId, generation),
    settings: { prompt: "reply with ok", resumePrompt: "resume" },
    ttlMs,
    resource: RESOURCE,
    readbackBudgetMs: 400 * READBACK_POLL_INTERVAL_MS,
    // IO pacing against a real subprocess; no timestamp is ever read from the
    // host clock (`clock` above supplies every `nowMs`).
    wait: () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
    attemptIdFactory: attemptIds(caseId, generation),
    seam,
  });

  try {
    if (generation === 0) {
      await orchestrator.start();
      return;
    }

    // Recovery: the predecessor was SIGKILLed holding the lease, and a lease
    // cannot tell dead from slow -- the retry waits out the TTL. The wait is
    // the injected clock's, never the wall's.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await orchestrator.recover();
        emit({ event: EVENT_RECOVERY_COMPLETE, now_ms: clock.nowMs() });
        return;
      } catch (error) {
        if (!(error instanceof LeaseHeld)) {
          throw error;
        }
        clock.advance(ttlMs + 1_000);
      }
    }
    throw new ContractViolation("the dead claimant's lease never expired");
  } finally {
    // Release any fake CLI still holding, whatever generation spawned it. A
    // SIGKILLed generation 0 never reaches this (the signal tears the process
    // down before any `finally` runs, exactly like the barrier's own kill
    // path), so in every one of these four cases it is generation 1 that
    // writes this -- on both its success and its failure path, since an
    // assertion failure downstream must not leak a live process either.
    try {
      writeFileSync(stopFilePath(workdir), "");
    } catch {
      // Best effort: a workdir already gone is nothing to release into.
    }
    // Writing the marker does not itself prove the detached child has SEEN
    // it -- the fake CLI polls every 20ms, and the driver process (this one)
    // is what the controller waits on before letting the case's temp
    // directory be removed. Without this wait, a fast-running case could
    // report done, have its workdir deleted by the test's own cleanup, and
    // leave the still-polling detached child orphaned until the safety cap.
    // Best effort and bounded: a process this does not manage to observe
    // exit is still bounded by `HOLD_SAFETY_CAP_MS` inside the fake CLI
    // itself.
    await waitForNoLiveChild(workdir, 2_000);
  }
}

/**
 * Block (async) until no process whose command line names this workdir's
 * fake CLI is visible in `/proc`, or until `timeoutMs` elapses.
 *
 * Scoped by the workdir's own marker path, not by session id: at most one
 * live child exists at a time across these single-role cases, and the path
 * itself already disambiguates one case's temp directory from another's.
 * A no-op wherever `/proc` does not exist (non-Linux); the session-start
 * cases are Linux-lane only, so nothing relies on this wait there.
 */
async function waitForNoLiveChild(workdir: string, timeoutMs: number): Promise<void> {
  if (!existsSync("/proc")) {
    return;
  }
  const marker = fakeCliPath(workdir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let found = false;
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      let cmdline: string;
      try {
        cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      } catch {
        continue;
      }
      if (cmdline.includes(marker)) {
        found = true;
        break;
      }
    }
    if (!found) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function attemptIds(caseId: string, generation: number): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${caseId}:g${generation}:attempt-${counter}`;
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArguments(argv);
  const eventFd = parsed.eventFd;
  const emit = (message: Record<string, unknown>): void => {
    writeSync(eventFd, `${stableStringify(message)}\n`);
  };

  emit({
    event: EVENT_HELLO,
    protocol_version: contract.PROTOCOL_VERSION,
    contract_version: contract.FAULT_RUNNER_CONTRACT_VERSION,
    role: parsed.role,
    case_id: parsed.caseId,
    restart_generation: parsed.restartGeneration,
    adapter: SESSION_ADAPTER.name,
  });

  const armed = parsed.armed
    .split(",")
    .filter((item) => item.trim() !== "")
    .map((item) => ArmedAnchor.parse(item));
  const clock = new Clock({
    baseMs: parsed.clockBaseMs + parsed.restartGeneration * RESTART_CLOCK_ADVANCE_MS,
    offsetMs: parsed.clockOffsetMs,
  });
  const barrier = new Barrier({ armed, emit, controlFd: parsed.controlFd, clock });

  const connection = openControlPlane(parsed.db);
  try {
    await runWalk({
      connection,
      workdir: parsed.workdir,
      caseId: parsed.caseId,
      generation: parsed.restartGeneration,
      ttlMs: parsed.ttlMs,
      clock,
      barrier,
      armed,
      emit,
    });
    emit({ event: EVENT_DONE, now_ms: clock.nowMs() });
    return 0;
  } catch (error) {
    // The driver reports, never hides.
    emit({ event: EVENT_ERROR, type: (error as Error)?.constructor?.name ?? "Error" });
    process.stderr.write(`${String((error as Error)?.stack ?? error)}\n`);
    return 1;
  } finally {
    try {
      connection.close();
    } catch {
      // Closing a dead connection.
    }
  }
}

/**
 * Whether this process was STARTED as the driver, rather than importing it.
 *
 * Same reasoning as `spike_driver.ts`'s `startedAsDriver`: every test file
 * imports this module for `SESSION_ADAPTER`, so the guard must distinguish
 * that from being spawned as the role process.
 */
function startedAsDriver(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  return pathResolve(invoked) === pathResolve(DRIVER_SOURCE_PATH);
}

if (startedAsDriver()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${String((error as Error)?.stack ?? error)}\n`);
      process.exitCode = 1;
    });
}
