/**
 * The role driver that binds the fault-runner contract to the spike surface.
 *
 * Ported from interlock `tests/fault_injection/spike_driver.py` at `65f36c5`.
 *
 * **Throwaway (interlock D-0026).** This module is one of the two adapters
 * permitted to import `src/control_plane`; `import-graph.test.ts` asserts that
 * no other module in this tree does. It dies with the spike schema. The
 * contract, controller, manifest, conformance battery and the cases are the
 * durable half and none of them names a spike symbol.
 *
 * It is two things in one file, on purpose:
 *
 * - an **executable module** -- `node <flags> spike_driver.ts <arguments>` is
 *   the role process the controller spawns (design 2.1: an independent PID, an
 *   independent SQLite connection, its own lease identity, and a restart
 *   entrypoint that recovers before it proceeds);
 * - an **adapter object** ({@link SPIKE_ADAPTER}) implementing
 *   `contract.FullFaultAdapter`, which is how the controller and the tests reach
 *   the spike's schema without importing it.
 *
 * Three contract obligations are worth pointing at directly, because they are
 * the ones an adapter gets wrong quietly:
 *
 * **The clock is fully virtual (design 7).** `nowMs` comes from {@link Clock}
 * and from nowhere else -- not as a base, not as a fallback. Every spike API
 * takes `nowMs` as an argument and the database has no clock of its own, so this
 * costs nothing and buys the identical-event-trace property the conformance
 * battery requires. `Date.now()` / `performance.now()` do not appear in this
 * file and a conformance test asserts it by parsing the source.
 *
 * **The barrier hook never raises (design 3).** It writes one line and blocks
 * reading one line -- a real blocking `readSync` on the inherited control pipe,
 * measured to block rather than spin. The kill is a real signal from outside the
 * process; an exception would unwind the stack, run `finally` blocks and close
 * the SQLite connection in an orderly way, which is exactly the crash a
 * fault-injection harness must not simulate.
 *
 * **Every step is resumable by query.** The restart entrypoint re-executes the
 * same command line with `--restart-generation N`; there is no warm state. Each
 * operation therefore asks the database what has already happened before doing
 * it, which is what "reconstruct its view by query from SQLite alone"
 * (interlock D-0001) means in a script.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";

import {
  ATTEMPT_LOG_NAME,
  type DeliveryReceipt,
  DestinationRefusal,
  KeyedDropbox,
  LOCK_NAME,
} from "../../src/control_plane/destination.js";
import { NOTIFY_RECIPIENT, spikeRegistry } from "../../src/control_plane/handlers.js";
import {
  acquire,
  and_,
  ClockSkewRefused,
  effectKind,
  eq,
  fencedInsert,
  fencedUpdate,
  fenceEpoch,
  increment,
  isNull,
  Lease,
  LeaseHeld,
  LeaseNotHeld,
  ProtectedWrite,
  param,
  protectedWrite,
  readLease,
  release as releaseLease,
  renew,
  StaleWriterRefused,
  value,
} from "../../src/control_plane/lease.js";
import {
  CHECKPOINTS as OUTBOX_CHECKPOINTS,
  Outbox,
  UNOWNED_OUTBOX_QUERY,
} from "../../src/control_plane/outbox.js";
import { createControlPlane, openControlPlane } from "../../src/control_plane/schema.js";

import * as contract from "./contract.js";
import {
  ArmedAnchor,
  CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
  CHECKPOINT_BEFORE_DURABLE_WRITE,
  CMD_CONTINUE,
  CMD_SET_CLOCK_OFFSET,
  ContractViolation,
  type DestinationObserver,
  EVENT_CHECKPOINT,
  EVENT_CLOCK_OFFSET,
  EVENT_DONE,
  EVENT_ERROR,
  EVENT_HELLO,
  EVENT_RECOVERY_COMPLETE,
  EVENT_STEP,
  EVENT_SYNC,
  type FaultCase,
  type FullFaultAdapter,
  OPERATION_ACK,
  OPERATION_ATTEMPT,
  OPERATION_BIND,
  OPERATION_ENQUEUE,
  OPERATION_LEASE_ACQUIRE,
  OPERATION_LEASE_RELEASE,
  OPERATION_LEASE_RENEW,
  OPERATION_OBSERVE,
  ROLE_SCRIPTS,
} from "./contract.js";

/** This file, which is what the controller spawns and the clock check parses. */
export const DRIVER_SOURCE_PATH = fileURLToPath(import.meta.url);

/** Identifies the driver in reports; the source's dotted `-m` module path. */
export const DRIVER_MODULE = "test/fault_injection/spike_driver.ts";

/**
 * Every script step advances the injected clock by this much. A declared,
 * deterministic increment (design 7) -- never a measured duration.
 */
export const STEP_ADVANCE_MS = 100;

/**
 * How far the injected clock starts ahead per restart generation.
 *
 * Load-bearing, and the reason is easy to miss: a restarted process whose clock
 * began again at `clockBaseMs` would be running *behind* the state its
 * predecessor wrote, which is an undeclared backward clock skew injected into
 * every restart -- work enqueued at `base + 300` would not even be due yet, so
 * "recover before you proceed" would recover nothing. Time really does pass
 * across a restart. The increment is derived from `--restart-generation`, which
 * is on the command line, so it stays a script-declared deterministic increment
 * and the trace stays byte-identical across re-runs (design 7). It is far below
 * any case's TTL, so a restart still finds its own lease live.
 */
export const RESTART_CLOCK_ADVANCE_MS = 1_000;

// -- script-shaping behaviours ---------------------------------------------
//
// They are *script* behaviour, not process faults: the fault kinds that carry
// them inject at the delivery surface rather than at the process, and the
// barrier still anchors them (design 4.1).

export const BEHAVIOUR_DROP_DELIVERY = "drop-delivery";
export const BEHAVIOUR_DUP_DELIVERY = "dup-delivery";
export const BEHAVIOUR_LOST_ACK = "lost-ack";

/**
 * "Hold the recipient unavailable across several retry attempts." The refusal
 * budget is read from the destination's own attempt log rather than from a
 * counter in this process, so it survives a restart instead of starting again at
 * zero and refusing the first N attempts of *every* generation -- which would
 * mean the message never lands at all.
 */
export const BEHAVIOUR_RECIPIENT_UNAVAILABLE = "recipient-unavailable";

/**
 * "Duplicate the ack": the same ack is recorded twice while the row is still
 * acked-once, within one generation.
 */
export const BEHAVIOUR_DUP_ACK = "dup-ack";

/**
 * "Ack an already-acked message": an ack issued against a row that has already
 * reached its terminal state.
 */
export const BEHAVIOUR_RE_ACK = "re-ack";

/**
 * "Replay a persisted incident packet": every raise after the first is sourced
 * from the row already in SQLite rather than from a fresh observation, which is
 * what a replay is. The packet is in the row and not in anyone's context
 * (interlock D-0003, D-0007), so replaying it means reading it back.
 */
export const BEHAVIOUR_INCIDENT_REPLAY = "incident-replay";

/**
 * Carry on as a writer that believes it holds the lease and does not.
 *
 * Two things use it, and they are the same injection seen from two sides.
 *
 * The conformance battery needs the *same* writer refused twice, so it can check
 * that two refusal ids do not collide -- no ordinary case does that.
 *
 * ACCEPTANCE.md section 2's single-writer row needs something more important:
 * its observable is that "the state item's history in SQLite is a linear
 * sequence with no interleaving from the rejected writer", and a writer that is
 * turned away at `acquire` never attempts a write at all, so that half of the
 * observable is true of every run and could not fail. A racer under this
 * behaviour fabricates the token `acquire` refused it and runs its whole script
 * against the same state item -- which is exactly the real hazard, a process
 * that has not noticed it lost its lease. Every write it makes is refused *at
 * the fence* and recorded there, and the history finally has the opportunity to
 * show an interleaving that atomic fencing is what prevents.
 */
export const BEHAVIOUR_STALE_WRITER = "stale-writer";

export const BEHAVIOURS = [
  BEHAVIOUR_DROP_DELIVERY,
  BEHAVIOUR_DUP_DELIVERY,
  BEHAVIOUR_LOST_ACK,
  BEHAVIOUR_RECIPIENT_UNAVAILABLE,
  BEHAVIOUR_DUP_ACK,
  BEHAVIOUR_RE_ACK,
  BEHAVIOUR_STALE_WRITER,
  BEHAVIOUR_INCIDENT_REPLAY,
] as const;

/**
 * How many attempts the recipient refuses before it becomes available again.
 * "Several" in ACCEPTANCE.md section 2's outbox row; three is the smallest
 * number for which "monotonically increasing" says more than "incremented".
 */
export const DEFAULT_UNAVAILABLE_ATTEMPTS = 3;

/**
 * The bound on the behaviour-driven retry loop in {@link opAttempt}. It exists
 * so a destination that refuses forever becomes an attributable case failure
 * rather than a wedged process the barrier watchdog has to reap.
 */
export const MAX_ATTEMPTS_PER_MESSAGE = 8;

/**
 * The detector version stamped on every incident this harness raises. Q-0009
 * (detector-version semantics for replay) is open; this is a constant string so
 * the trace stays byte-identical, and it settles nothing.
 */
export const DETECTOR_VERSION = "s9-harness-1";

/**
 * The two collapse rules ACCEPTANCE.md section 2 requires the tests to
 * parameterise rather than choose between (Q-0002). The driver implements both
 * and is *told* which to apply; it never picks.
 */
export const COLLAPSE_INCREMENT_IN_PLACE = "increment-in-place";
export const COLLAPSE_OPEN_LINKED = "open-linked";

export const COLLAPSE_RULES = [COLLAPSE_INCREMENT_IN_PLACE, COLLAPSE_OPEN_LINKED] as const;

/**
 * The action kind an escalation would carry. Nothing in the spike composes it;
 * the harness does, precisely so that "no termination or restart recommendation
 * is produced" is an assertion about a row a broken driver *would* write.
 */
export const ESCALATION_EFFECT = "recommend_restart";

/**
 * The file the observation seam reads. The fault acts here -- on the reader --
 * and never on the classifier or on the assertion.
 */
export const OBSERVATION_FILE_NAME = "observation.json";

// ---------------------------------------------------------------------------
// the injected clock -- design 7
// ---------------------------------------------------------------------------

/**
 * `nowMs() = base + advance + offset`. No host clock is ever read.
 *
 * `baseMs` is a fixed constant from the manifest, `advanceMs` grows only by
 * script-declared increments, and `offsetMs` moves only by the controller's
 * `set_clock_offset` command while the process is blocked at an armed barrier.
 * That is the whole model, and it is why two runs of one case with one seed
 * produce byte-identical traces on different days.
 */
export class Clock {
  baseMs: number;
  offsetMs: number;
  advanceMs: number;

  constructor(options: { baseMs: number; offsetMs?: number; advanceMs?: number }) {
    this.baseMs = options.baseMs;
    this.offsetMs = options.offsetMs ?? 0;
    this.advanceMs = options.advanceMs ?? 0;
  }

  nowMs(): number {
    return this.baseMs + this.advanceMs + this.offsetMs;
  }

  advance(byMs: number = STEP_ADVANCE_MS): number {
    this.advanceMs += Math.trunc(byMs);
    return this.nowMs();
  }

  setOffset(offsetMs: number): number {
    this.offsetMs = Math.trunc(offsetMs);
    return this.nowMs();
  }
}

// ---------------------------------------------------------------------------
// the two-phase barrier, phase one -- design 3.1
// ---------------------------------------------------------------------------

/**
 * Phase one of the kill barrier: announce, then block.
 *
 * The hook holds no new locks, touches no SQLite state and does no database
 * work, so the process freezes mid-window with its transaction exactly as the
 * operation script left it. Phase two -- the kill -- is a signal from the
 * controller and never anything this class does.
 */
export class Barrier {
  private readonly armed: readonly ArmedAnchor[];
  private readonly emit: (message: Record<string, unknown>) => void;
  private readonly controlFd: number;
  private readonly clock: Clock;
  private readonly occurrences = new Map<string, number>();
  private carry = "";

  constructor(options: {
    armed: readonly ArmedAnchor[];
    emit: (message: Record<string, unknown>) => void;
    controlFd: number;
    clock: Clock;
  }) {
    this.armed = [...options.armed];
    this.emit = options.emit;
    this.controlFd = options.controlFd;
    this.clock = options.clock;
  }

  private nextOccurrence(operation: string, anchor: string): number {
    // The source keys its occurrence counter by the tuple `(operation, anchor)`.
    // JavaScript has no value equality for arrays as Map keys, so the pair is
    // joined by NUL -- written as an escape, and chosen because it cannot occur
    // in either an operation or an anchor name, so the encoding is injective and
    // two different pairs cannot collide onto one counter.
    const key = `${operation}\u0000${anchor}`;
    const seen = (this.occurrences.get(key) ?? 0) + 1;
    this.occurrences.set(key, seen);
    return seen;
  }

  private isArmed(operation: string, anchor: string, occurrence: number): boolean {
    for (const armed of this.armed) {
      if (armed.anchor !== anchor || armed.occurrence !== occurrence) {
        continue;
      }
      if (armed.operation === null || armed.operation === operation) {
        return true;
      }
    }
    return false;
  }

  /**
   * Pass an anchor. Returns immediately unless this occurrence is armed.
   *
   * An unarmed anchor costs one map lookup and no protocol round-trip, so a case
   * perturbs the timing of nothing it is not about.
   */
  hit(anchor: string, options: { operation: string; kind?: string }): void {
    const kind = options.kind ?? EVENT_CHECKPOINT;
    const occurrence = this.nextOccurrence(options.operation, anchor);
    if (!this.isArmed(options.operation, anchor, occurrence)) {
      return;
    }
    this.emit({
      event: kind,
      name: anchor,
      operation: options.operation,
      occurrence,
      now_ms: this.clock.nowMs(),
    });
    this.block();
  }

  /**
   * Read the control pipe until told to continue.
   *
   * A kill case never gets a reply: the blocked read is torn down by the SIGKILL
   * itself. EOF means the controller is gone, and a role process whose
   * controller has vanished exits rather than spinning -- the controller's
   * teardown ladder (design 8.2) is the authority on cleanup, and a driver that
   * outlived it has nothing left to report to.
   *
   * `readSync` on the inherited pipe genuinely blocks (measured: a 700ms hold
   * consumed zero `EAGAIN` retries), which is what makes this the source's
   * blocking `readline()` and not a poll. The `EAGAIN` arm is kept anyway,
   * because a pipe left in non-blocking mode by a future caller would otherwise
   * turn a barrier into a crash.
   */
  private block(): void {
    for (;;) {
      const line = this.readLine();
      if (line === null) {
        hardExit(70); // EX_SOFTWARE: the controller went away.
      }
      let command: Record<string, unknown>;
      try {
        command = JSON.parse(line) as Record<string, unknown>;
      } catch {
        hardExit(70);
      }
      const name = command["cmd"];
      if (name === CMD_CONTINUE) {
        return;
      }
      if (name === CMD_SET_CLOCK_OFFSET) {
        const nowMs = this.clock.setOffset(Number(command["offset_ms"]));
        this.emit({
          event: EVENT_CLOCK_OFFSET,
          offset_ms: this.clock.offsetMs,
          now_ms: nowMs,
        });
        continue;
      }
      hardExit(70);
    }
  }

  /** One newline-terminated line from the control pipe, or `null` at EOF. */
  private readLine(): string | null {
    for (;;) {
      const newline = this.carry.indexOf("\n");
      if (newline >= 0) {
        const line = this.carry.slice(0, newline);
        this.carry = this.carry.slice(newline + 1);
        return line;
      }
      const chunk = Buffer.alloc(4096);
      let read: number;
      try {
        read = readSync(this.controlFd, chunk, 0, chunk.length, null);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EAGAIN") {
          continue;
        }
        if (code === "EOF") {
          return this.carry === "" ? null : this.flushCarry();
        }
        throw error;
      }
      if (read === 0) {
        return this.carry === "" ? null : this.flushCarry();
      }
      this.carry += chunk.subarray(0, read).toString("utf8");
    }
  }

  private flushCarry(): string {
    const line = this.carry;
    this.carry = "";
    return line;
  }
}

/**
 * Leave the process **now**, without unwinding.
 *
 * The source's `os._exit`. `process.exit()` is not the same thing: it runs
 * `exit` listeners and flushes streams, which is orderly shutdown -- the very
 * behaviour the barrier exists to avoid modelling.
 */
function hardExit(status: number): never {
  // `process.exit` is the closest Node has: like `os._exit` it terminates
  // without unwinding, so no `finally` runs and the SQLite connection is not
  // closed in an orderly way. It differs in emitting the `exit` event, which
  // this module registers no listener for, and it keeps the source's status --
  // which matters, because the controller reads the exit status to tell a
  // crash from a clean finish.
  process.exit(status);
}

// ---------------------------------------------------------------------------
// the destination side
// ---------------------------------------------------------------------------

/** The subset of `Destination` the driver's wrappers delegate through. */
interface DropboxLike {
  readonly name: string;
  apply(
    idempotencyKey: string,
    payload: string,
    fencingToken?: number | null,
    fenceScope?: string | null,
  ): DeliveryReceipt;
  effectCount(idempotencyKey: string): number;
  attemptCount(idempotencyKey: string): number;
}

/**
 * A `KeyedDropbox` that refuses a named attempt, then behaves.
 *
 * This is the `drop-delivery` fault: the delivery is dropped at the destination,
 * the outbox row stays pending and due, and the resend is what the case asserts.
 * It is deterministic -- the attempt index is counted, not timed -- and it is
 * the destination refusing, not an exception injected into our own code path.
 */
class DroppingDropbox implements DropboxLike {
  readonly name: string;
  protected readonly inner: DropboxLike;
  protected readonly root: string;
  private readonly dropAttempt: number;
  private readonly seen = new Map<string, number>();

  constructor(inner: DropboxLike, options: { root: string; dropAttempt: number }) {
    this.inner = inner;
    this.root = options.root;
    this.dropAttempt = options.dropAttempt;
    this.name = inner.name;
  }

  apply(
    idempotencyKey: string,
    payload: string,
    fencingToken: number | null = null,
    fenceScope: string | null = null,
  ): DeliveryReceipt {
    const seen = (this.seen.get(idempotencyKey) ?? 0) + 1;
    this.seen.set(idempotencyKey, seen);
    if (seen === this.dropAttempt) {
      // The dropped attempt is recorded at the destination before it is refused.
      // Without it the destination's own log would show a single attempt for the
      // whole case, and "the resend happened" would be unprovable from the
      // counterparty's record -- which is the only record ACCEPTANCE.md section
      // 2 accepts for an external effect.
      this.logDropped(idempotencyKey, payload);
      throw new DestinationRefusal(
        `the harness dropped attempt ${seen} for ${JSON.stringify(idempotencyKey)}`,
      );
    }
    return this.inner.apply(idempotencyKey, payload, fencingToken, fenceScope);
  }

  protected logDropped(idempotencyKey: string, payload: string): void {
    const line = JSON.stringify({
      fencing_token: null,
      idempotency_key: idempotencyKey,
      payload_sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
    });
    const log = join(this.root, ATTEMPT_LOG_NAME);
    mkdirSync(dirname(log), { recursive: true });
    const handle = openSync(
      log,
      fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      writeSync(handle, `${line}\n`);
      // fsync: the attempt log is the counterparty's own record, and a kill
      // immediately after this call must not lose it.
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  }

  effectCount(idempotencyKey: string): number {
    return this.inner.effectCount(idempotencyKey);
  }

  attemptCount(idempotencyKey: string): number {
    return this.inner.attemptCount(idempotencyKey);
  }
}

/**
 * A destination that is unavailable for its first *N* attempts.
 *
 * ACCEPTANCE.md section 2's outbox row asks for the recipient to be held
 * unavailable "across several retry attempts", with a retry count that is
 * monotonically increasing and **survives a restart**. That last word is what
 * dictates the shape here: the refusal budget is read from the destination's own
 * append-only attempt log, not from a counter in this process. A process-local
 * counter would start again at zero in every generation and go on refusing the
 * first N attempts forever, so the message would never land and the case would
 * be asserting a wedge rather than a resend.
 *
 * Reading the counterparty's own record also means the budget is measured in the
 * same evidence the case asserts against.
 */
class UnavailableDropbox extends DroppingDropbox {
  private readonly unavailableAttempts: number;

  constructor(inner: DropboxLike, options: { root: string; unavailableAttempts: number }) {
    super(inner, { root: options.root, dropAttempt: 0 });
    this.unavailableAttempts = Math.trunc(options.unavailableAttempts);
  }

  override apply(
    idempotencyKey: string,
    payload: string,
    fencingToken: number | null = null,
    fenceScope: string | null = null,
  ): DeliveryReceipt {
    if (this.attemptCount(idempotencyKey) < this.unavailableAttempts) {
      this.logDropped(idempotencyKey, payload);
      throw new DestinationRefusal(
        `the recipient is unavailable for ${JSON.stringify(idempotencyKey)}`,
      );
    }
    return this.inner.apply(idempotencyKey, payload, fencingToken, fenceScope);
  }
}

/**
 * How many of this role's messages this generation may deliver.
 *
 * Only `dup-delivery` narrows it, and only in the first generation:
 * ACCEPTANCE.md section 2's dedup row asks for a **restart between the duplicate
 * arrivals**, so the first copy is delivered and acked before the kill-free
 * restart and the duplicate arrives afterwards, into a destination that has
 * already seen the key. Delivering both before the restart would make the
 * restart a no-op and the recovery assertion vacuous.
 */
function deliverable(ctx: Context): number {
  if (ctx.behaviours.includes(BEHAVIOUR_DUP_DELIVERY) && ctx.restartGeneration === 0) {
    return 1;
  }
  return ctx.messages;
}

/** One destination directory per role: its *own* destination (design 2.1). */
function dropboxRoot(workdir: string, role: string): string {
  return join(workdir, "destinations", role);
}

// ---------------------------------------------------------------------------
// the harness refusal ledger -- design 5
// ---------------------------------------------------------------------------
//
// ACCEPTANCE.md section 2 requires the returning holder's refused write to be
// *recorded, not silently dropped*, and design section 5 holds that record to
// the same standard as any other observable: a SQLite query or a persisted
// field, and explicitly **not** a harness event-trace line -- a trace proves the
// harness saw an exception, not that the refusal is durable.
//
// The lease module already records one class of refusal durably
// (`protectedWrite` inserts a refused `action` row), but only that class:
// `LeaseHeld`, `LeaseNotHeld` and `ClockSkewRefused` leave no row at all, and
// the outbox's `enqueue` refusal is recorded under a `kind` that is not composed
// by `effectKind` and therefore cannot be attributed to a resource by query. So
// providing the durable record is the driver's obligation, as the design says.
//
// **One deviation from design section 5, forced and deliberate.** The design
// puts this ledger "in the same database". It cannot go there:
// `openControlPlane` verifies a sha256 fingerprint over *every* object in
// `sqlite_master`, so a harness table added to the control plane makes the next
// open refuse the file outright. The ledger is therefore a **sidecar SQLite
// file** beside the control plane. Everything else section 5 asks for is
// unchanged: append-only, harness-owned, written outside the fence because it
// records a failure to write control state, and read back by a named SQL query.

export const REFUSAL_LEDGER_NAME = "harness-refusals.sqlite3";

const REFUSAL_DDL = `
CREATE TABLE IF NOT EXISTS harness_refusal (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    resource   TEXT    NOT NULL,
    holder     TEXT    NOT NULL,
    epoch      INTEGER NOT NULL,
    operation  TEXT    NOT NULL,
    refusal    TEXT    NOT NULL,
    now_ms     INTEGER NOT NULL
)
`;

export function refusalLedgerPath(workdir: string): string {
  return join(workdir, REFUSAL_LEDGER_NAME);
}

/** Append one refusal. Its own connection, its own file, never fenced. */
function recordRefusal(
  ctx: Context,
  options: { operation: string; refusal: string; epoch: number; nowMs: number },
): void {
  const connection = new Database(refusalLedgerPath(ctx.workdir));
  try {
    connection.exec(REFUSAL_DDL);
    connection
      .prepare(
        "INSERT INTO harness_refusal (resource, holder, epoch, operation, refusal, now_ms) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        ctx.resource,
        ctx.holder,
        Math.trunc(options.epoch),
        options.operation,
        options.refusal,
        Math.trunc(options.nowMs),
      );
  } finally {
    connection.close();
  }
}

// ---------------------------------------------------------------------------
// the operation script -- design 2.1
// ---------------------------------------------------------------------------

/**
 * The seed's stream, as a deterministic generator.
 *
 * The source seeds `random.Random` with the contract's per-case seed. Python's
 * Mersenne Twister stream is not reproducible outside CPython, and it does not
 * need to be: what the conformance battery requires is that **two runs of one
 * case with one seed produce identical traces**, which is a statement about this
 * implementation being deterministic, not about matching interlock's bytes. The
 * seed's authority is payload and schedule only (design 4.3), so the payload
 * bytes differ from interlock's and nothing that is asserted does.
 *
 * SplitMix64, which is a standard, exactly-specified 64-bit generator -- so the
 * stream is a written-down function of the seed rather than a property of a
 * runtime.
 */
class SeededRandom {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = BigInt.asUintN(64, seed);
  }

  private next(): bigint {
    this.state = BigInt.asUintN(64, this.state + 0x9e3779b97f4a7c15n);
    let z = this.state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return BigInt.asUintN(64, z ^ (z >> 31n));
  }

  /** `random.Random.choice`, over a string. */
  choice(alphabet: string): string {
    const index = Number(this.next() % BigInt(alphabet.length));
    return alphabet[index] as string;
  }
}

function roleSalt(role: string): bigint {
  const salts: Record<string, bigint> = { sup: 0x11n, disp: 0x22n, sec: 0x33n };
  return salts[role] ?? 0n;
}

/** Everything one role process needs, and nothing warm across a restart. */
export class Context {
  readonly role: string;
  readonly resource: string;
  readonly holder: string;
  readonly runId: string;
  readonly dbPath: string;
  readonly workdir: string;
  readonly caseId: string;
  readonly suiteSeed: number;
  readonly manifestVersion: number;
  readonly ttlMs: number;
  readonly messages: number;
  readonly behaviours: readonly string[];
  readonly restartGeneration: number;
  readonly clock: Clock;
  readonly barrier: Barrier;
  readonly emit: (message: Record<string, unknown>) => void;
  // -- case parameters ----------------------------------------------------
  //
  // Every one of these arrives on the command line. None of them has a value
  // this module chose: the observation mode and the escalation policy are the
  // case's, and the three incident parameters are the case's precisely because
  // Q-0002 and Q-0003 are open and a driver-side default would settle them by
  // inertia (compare `resource`/`holder`, which kept Q-0001 open on this spike
  // schema the same way).
  readonly observationMode: string;
  readonly escalateOn: readonly string[];
  readonly incidentDedupKey: string | null;
  readonly incidentRepeats: number;
  readonly incidentCollapse: string | null;
  readonly incidentRenotifyWindowMs: number | null;
  readonly incidentReconcileIntervalMs: number | null;
  readonly unavailableAttempts: number;

  connection!: SqliteDatabase;
  lease: Lease | null = null;
  readonly rng: SeededRandom;

  constructor(options: {
    role: string;
    resource: string;
    holder: string;
    runId: string;
    dbPath: string;
    workdir: string;
    caseId: string;
    suiteSeed: number;
    manifestVersion: number;
    ttlMs: number;
    messages: number;
    behaviours: readonly string[];
    restartGeneration: number;
    clock: Clock;
    barrier: Barrier;
    emit: (message: Record<string, unknown>) => void;
    observationMode?: string;
    escalateOn?: readonly string[];
    incidentDedupKey?: string | null;
    incidentRepeats?: number;
    incidentCollapse?: string | null;
    incidentRenotifyWindowMs?: number | null;
    incidentReconcileIntervalMs?: number | null;
    unavailableAttempts?: number;
  }) {
    this.role = options.role;
    this.resource = options.resource;
    this.holder = options.holder;
    this.runId = options.runId;
    this.dbPath = options.dbPath;
    this.workdir = options.workdir;
    this.caseId = options.caseId;
    this.suiteSeed = options.suiteSeed;
    this.manifestVersion = options.manifestVersion;
    this.ttlMs = options.ttlMs;
    this.messages = options.messages;
    this.behaviours = [...options.behaviours];
    this.restartGeneration = options.restartGeneration;
    this.clock = options.clock;
    this.barrier = options.barrier;
    this.emit = options.emit;
    this.observationMode = options.observationMode ?? contract.OBSERVATION_HEALTHY;
    this.escalateOn = [...(options.escalateOn ?? [])];
    this.incidentDedupKey = options.incidentDedupKey ?? null;
    this.incidentRepeats = options.incidentRepeats ?? 0;
    this.incidentCollapse = options.incidentCollapse ?? null;
    this.incidentRenotifyWindowMs = options.incidentRenotifyWindowMs ?? null;
    this.incidentReconcileIntervalMs = options.incidentReconcileIntervalMs ?? null;
    this.unavailableAttempts = options.unavailableAttempts ?? DEFAULT_UNAVAILABLE_ATTEMPTS;
    this.rng = new SeededRandom(
      contract.caseSeed({
        manifestVersion: this.manifestVersion,
        caseId: this.caseId,
        suiteSeed: this.suiteSeed,
      }) ^ roleSalt(this.role),
    );
  }

  // -- message identity, derived and therefore restart-stable -------------

  messageId(index: number): string {
    return `${this.holder}-m${index}`;
  }

  dedupKey(index: number): string {
    // `dup-delivery` is *two messages under one dedup key*: the duplicate
    // arrives as its own row and the destination's idempotency key collapses it,
    // which is the ACCEPTANCE.md section 2 dedup row exactly.
    if (this.behaviours.includes(BEHAVIOUR_DUP_DELIVERY)) {
      return `${this.holder}-dedup`;
    }
    return `${this.holder}-dedup-${index}`;
  }

  payload(index: number): string {
    // Payload bytes are the seed's business (design 4.3) and nothing else is:
    // the seed never chooses a checkpoint, a fault or a target.
    let token = "";
    for (let i = 0; i < 8; i += 1) {
      token += this.rng.choice("0123456789abcdef");
    }
    if (this.behaviours.includes(BEHAVIOUR_DUP_DELIVERY)) {
      // "Deliver the same message twice" means the *same* message: one dedup key
      // and one payload. A duplicate whose bytes differed would be a payload
      // conflict, which the destination refuses outright -- correctly, and it is
      // a different case from the dedup row.
      return JSON.stringify({ n: 0, token: "duplicate" });
    }
    return JSON.stringify({ n: index, token });
  }
}

/**
 * A refusal's `action_id`: deterministic, and unique per attempt.
 *
 * `protectedWrite` passes `attemptId` straight through as the primary key of the
 * refusal row, so an id composed only of holder and operation collides the
 * moment the same stale writer is refused twice -- and the collision surfaces as
 * a raw constraint error from inside the transaction *instead of*
 * `StaleWriterRefused`, losing the refusal record that ACCEPTANCE.md section 2
 * requires to be durable. A harness cannot randomise, because a uuid would break
 * the byte-identical-trace property. So the generation and the repeat index --
 * both script-declared and both on the command line or derived from it -- carry
 * the uniqueness instead.
 */
function attemptId(ctx: Context, operation: string, repeat = 0): string {
  return `refused-${ctx.holder}-${operation}-g${ctx.restartGeneration}-r${repeat}`;
}

function rows(
  connection: SqliteDatabase,
  sql: string,
  parameters: Record<string, unknown>,
): Record<string, unknown>[] {
  return connection.prepare(sql).all(parameters) as Record<string, unknown>[];
}

/**
 * Each role process opens its **own** connection (design 2.1).
 *
 * Never inherited across the spawn, never shared between roles: a SIGKILL has to
 * take down a connection mid-transaction, which is the crash SQLite's journal
 * actually has to recover from.
 */
function openOrCreate(ctx: Context): SqliteDatabase {
  return openControlPlane(ctx.dbPath);
}

// -- lease -----------------------------------------------------------------

/**
 * Take or resume this role's own lease, or be refused and record it.
 *
 * A restarted holder whose lease row is still its own and still live *renews*
 * rather than re-acquiring: renewal keeps the epoch, and keeping the epoch is
 * what lets the restarted process own the outbox rows its predecessor stamped.
 * When the lease has lapsed or moved on, re-acquiring raises the epoch -- and
 * then `Outbox.recover` re-stamps the orphaned rows, which is the other half of
 * the same recovery.
 *
 * **Refusal at acquire returns `null` rather than throwing.** Two of the
 * ACCEPTANCE.md section 2 rows need this. A second live claimant on one resource
 * is refused here, by `acquire`'s upsert, and not at any later write -- so "two
 * writers race for the same state item ... a stale writer is rejected, not
 * merged" is observed at exactly this point. So is the return of a holder that
 * was SIGKILLed without releasing: it comes back with no epoch in memory,
 * re-runs its script from the top, and meets the claimant that took the resource
 * over. `LeaseHeld` is persisted nowhere by the lease module, so the refusal
 * ledger is what makes it the durable record section 2 demands rather than an
 * exception nobody kept.
 */
export function opLeaseAcquire(ctx: Context): Lease | null {
  ctx.barrier.hit(CHECKPOINT_BEFORE_DURABLE_WRITE, { operation: OPERATION_LEASE_ACQUIRE });
  const nowMs = ctx.clock.advance();
  const observed = readLease(ctx.connection, ctx.resource);
  let took = "acquired";
  let lease: Lease | null = null;
  try {
    if (observed !== undefined && observed.holder === ctx.holder && observed.looksLiveAt(nowMs)) {
      try {
        lease = renew(ctx.connection, observed, { nowMs, ttlMs: ctx.ttlMs });
        took = "renewed";
      } catch (error) {
        if (!(error instanceof LeaseNotHeld)) {
          throw error;
        }
        lease = acquire(ctx.connection, {
          resource: ctx.resource,
          holder: ctx.holder,
          nowMs,
          ttlMs: ctx.ttlMs,
        });
      }
    } else {
      lease = acquire(ctx.connection, {
        resource: ctx.resource,
        holder: ctx.holder,
        nowMs,
        ttlMs: ctx.ttlMs,
      });
    }
  } catch (error) {
    if (!(error instanceof LeaseHeld)) {
      throw error;
    }
    took = `refused:${error.constructor.name}`;
    recordRefusal(ctx, {
      operation: OPERATION_LEASE_ACQUIRE,
      refusal: error.constructor.name,
      // No epoch was granted, and saying so is the honest record: the ledger's
      // epoch column is what this writer *held*, which is nothing.
      epoch: 0,
      nowMs,
    });
    if (ctx.behaviours.includes(BEHAVIOUR_STALE_WRITER)) {
      // ... and now carry on anyway, holding a token the lease row will reject.
      // Not a way around the refusal: the refusal above is recorded either way.
      // It is how the case reaches the *other* half of the single-writer
      // observable, the one about the write history, which a writer that stops
      // at `acquire` can never reach.
      //
      // The epoch is taken from the row that actually exists and moved one past
      // it, which is what a writer that had lost the lease without noticing
      // would present.
      const observedNow = readLease(ctx.connection, ctx.resource);
      lease = new Lease(
        ctx.resource,
        ctx.holder,
        (observedNow !== undefined ? observedNow.epoch : 0) + 1,
        nowMs,
        nowMs + ctx.ttlMs,
      );
      took = `stale-writer:${error.constructor.name}`;
    }
  }
  ctx.lease = lease;
  ctx.barrier.hit(CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT, {
    operation: OPERATION_LEASE_ACQUIRE,
  });
  ctx.emit({
    event: EVENT_STEP,
    operation: OPERATION_LEASE_ACQUIRE,
    outcome: took,
    epoch: lease !== null ? lease.epoch : 0,
    now_ms: nowMs,
  });
  return lease;
}

export function opLeaseRenew(ctx: Context): void {
  const current = ctx.lease;
  if (current === null) {
    throw new ContractViolation("lease-renew runs only with a lease in hand");
  }
  ctx.barrier.hit(CHECKPOINT_BEFORE_DURABLE_WRITE, { operation: OPERATION_LEASE_RENEW });
  const nowMs = ctx.clock.advance();
  let outcome: string;
  try {
    ctx.lease = renew(ctx.connection, current, { nowMs, ttlMs: ctx.ttlMs });
    outcome = "renewed";
  } catch (error) {
    if (!(error instanceof LeaseNotHeld) && !(error instanceof ClockSkewRefused)) {
      throw error;
    }
    // Losing a renewal is a legitimate observation under a skew or takeover
    // case, not a driver fault: the refusal is the evidence. Only the class name
    // goes on the wire -- refusal texts carry a uuid and would break the
    // identical-trace property (design 6.3) -- and the durable record goes to
    // the ledger, because the lease module records no row for either of these.
    outcome = `refused:${error.constructor.name}`;
    recordRefusal(ctx, {
      operation: OPERATION_LEASE_RENEW,
      refusal: error.constructor.name,
      epoch: ctx.lease ? ctx.lease.epoch : 0,
      nowMs,
    });
  }
  ctx.barrier.hit(CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT, { operation: OPERATION_LEASE_RENEW });
  ctx.emit({
    event: EVENT_STEP,
    operation: OPERATION_LEASE_RENEW,
    outcome,
    epoch: ctx.lease ? ctx.lease.epoch : null,
    now_ms: nowMs,
  });
}

export function opLeaseRelease(ctx: Context): void {
  const current = ctx.lease;
  if (current === null) {
    throw new ContractViolation("lease-release runs only with a lease in hand");
  }
  ctx.barrier.hit(CHECKPOINT_BEFORE_DURABLE_WRITE, { operation: OPERATION_LEASE_RELEASE });
  const nowMs = ctx.clock.advance();
  let outcome: string;
  try {
    ctx.lease = releaseLease(ctx.connection, current, { nowMs });
    outcome = "released";
  } catch (error) {
    if (!(error instanceof LeaseNotHeld)) {
      throw error;
    }
    outcome = `refused:${error.constructor.name}`;
    recordRefusal(ctx, {
      operation: OPERATION_LEASE_RELEASE,
      refusal: error.constructor.name,
      epoch: ctx.lease ? ctx.lease.epoch : 0,
      nowMs,
    });
  }
  ctx.barrier.hit(CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT, {
    operation: OPERATION_LEASE_RELEASE,
  });
  ctx.emit({
    event: EVENT_STEP,
    operation: OPERATION_LEASE_RELEASE,
    outcome,
    now_ms: nowMs,
  });
}

// -- the Supervisor's identity binding --------------------------------------

/**
 * Bind an identity to this role's run -- the Supervisor's write-set.
 *
 * Resumable by query: the schema's `session_one_active_binding_per_run` index
 * permits exactly one live session per run, so a restarted Supervisor that
 * re-inserted would hit a constraint error instead of recovering. It asks first,
 * which is what interlock D-0001 requires of every restart.
 */
export function opBind(ctx: Context): void {
  const lease = ctx.lease;
  if (lease === null) {
    throw new ContractViolation("bind runs only with a lease in hand");
  }
  const sessionId = `${ctx.holder}-session`;
  const existing = rows(
    ctx.connection,
    "SELECT session_id FROM session WHERE run_id = :run_id AND released_at_ms IS NULL",
    { run_id: ctx.runId },
  );
  if (existing.length > 0) {
    ctx.emit({
      event: EVENT_STEP,
      operation: OPERATION_BIND,
      outcome: "adopted",
      now_ms: ctx.clock.nowMs(),
    });
    return;
  }

  ctx.barrier.hit(CHECKPOINT_BEFORE_DURABLE_WRITE, { operation: OPERATION_BIND });
  const nowMs = ctx.clock.advance();
  const statement = fencedInsert("session", {
    values: {
      session_id: param("session_id"),
      run_id: param("run_id"),
      provider: param("provider"),
      binding_phase: param("binding_phase"),
      observation: param("observation"),
      provider_state: param("provider_state"),
      bound_at_ms: param("bound_at_ms"),
    },
    // `session` genuinely has no `writer_epoch` column; the fence is still a
    // clause of the write itself.
    stampsWriterEpoch: false,
  });
  const write = new ProtectedWrite({
    kind: effectKind(ctx.resource, "bind_session"),
    idempotencyKey: `bind_session:${sessionId}`,
    statement,
    exactlyOnceMechanism: "transactional_with_record",
    params: {
      session_id: sessionId,
      run_id: ctx.runId,
      provider: "harness",
      // The spike roles' bind is a one-step bind of an already-observed session;
      // the staged prepared -> spawned -> identity_confirmed walk is the
      // session-start operation's, not this one's.
      binding_phase: "identity_confirmed",
      observation: "observed",
      provider_state: "running",
      bound_at_ms: nowMs,
    },
    runId: ctx.runId,
  });
  let outcome: string;
  try {
    protectedWrite(ctx.connection, lease, write, {
      nowMs,
      // A deterministic refusal id: the module's default is a uuid, and a uuid
      // in the evidence is a re-run that cannot be compared. It also has to be
      // unique *per attempt* -- see `attemptId`.
      attemptId: attemptId(ctx, OPERATION_BIND),
    });
    outcome = "bound";
  } catch (error) {
    if (!(error instanceof StaleWriterRefused)) {
      throw error;
    }
    outcome = `refused:${error.constructor.name}`;
    recordRefusal(ctx, {
      operation: OPERATION_BIND,
      refusal: error.constructor.name,
      epoch: lease.epoch,
      nowMs,
    });
  }
  ctx.barrier.hit(CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT, { operation: OPERATION_BIND });
  ctx.emit({
    event: EVENT_STEP,
    operation: OPERATION_BIND,
    outcome,
    now_ms: nowMs,
  });
}

// -- the observation seam and the incident packet ----------------------------
//
// ACCEPTANCE.md section 2's last row asks for the observation path to "fail or
// return nothing while the worker is genuinely healthy", classified
// `OBSERVATION_UNAVAILABLE` and never as an anomaly, with `NO_ACTIVITY_EVIDENCE`
// likewise not an anomaly (interlock D-0006).
//
// The shape below is chosen so the case can actually FAIL. The fault acts on the
// **reader** -- a file the driver reads through -- and the classifier maps the
// reader's outcome onto a fact state. If the reader collapsed a read failure
// into an empty result (the exact defect D-0006 exists to police) the two modes
// would produce the same fact state and the case would go red. A design in which
// the same step both chose the fact state and asserted it could only fail if it
// contradicted itself, which is not a test of anything.

/** The observation path failed. Not an anomaly -- a missing observation. */
export class ObservationUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationUnavailable";
  }
}

export function observationPath(workdir: string, role: string): string {
  return join(workdir, "observations", role, OBSERVATION_FILE_NAME);
}

/**
 * Prepare the seam the case's observation mode asks for.
 *
 * `unreadable` deliberately leaves *no* file: the read raises. `silent` writes a
 * well-formed observation carrying no activity -- readable, and empty, which is
 * a different fact about the world from "we could not look".
 */
export function writeObservation(workdir: string, role: string, options: { mode: string }): void {
  const path = observationPath(workdir, role);
  mkdirSync(dirname(path), { recursive: true });
  if (options.mode === contract.OBSERVATION_UNREADABLE) {
    if (existsSync(path)) {
      rmSync(path);
    }
    return;
  }
  const activity = options.mode === contract.OBSERVATION_SILENT ? [] : [{ kind: "tool_use" }];
  writeFileSync(path, JSON.stringify({ activity }), "utf8");
}

/**
 * Read the worker's activity, or fail to.
 *
 * Raising and returning nothing are kept apart on purpose: this function is the
 * seam interlock D-0006 is about, and a reader that swallowed the exception into
 * an empty list would make an outage indistinguishable from a quiet worker.
 */
export function readObservation(ctx: Context): unknown[] {
  const path = observationPath(ctx.workdir, ctx.role);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ObservationUnavailable(`${path}: ${String(error)}`);
  }
  const parsed = JSON.parse(raw) as { activity?: unknown[] };
  return [...(parsed.activity ?? [])];
}

/**
 * The reader's outcome, named. Nothing here is a verdict.
 *
 * interlock D-0005 fixes the names and D-0006 fixes one relation between two of
 * them; per-state semantics are Q-0012 and stay open, so this function maps
 * *what the read did* onto a name and stops there. It never decides what the
 * name means, and no other function maps a name onto an action.
 */
export function classifyObservation(ctx: Context): string {
  let activity: unknown[];
  try {
    activity = readObservation(ctx);
  } catch (error) {
    if (error instanceof ObservationUnavailable) {
      return contract.FACT_OBSERVATION_UNAVAILABLE;
    }
    throw error;
  }
  return activity.length > 0 ? contract.FACT_ACTIVE_EVIDENCE : contract.FACT_NO_ACTIVITY_EVIDENCE;
}

/** This role's live session binding, or `null` if it has none. */
function boundSessionId(ctx: Context): string | null {
  const found = rows(
    ctx.connection,
    "SELECT session_id FROM session WHERE run_id = :run_id AND released_at_ms IS NULL",
    { run_id: ctx.runId },
  );
  return found.length > 0 ? String(found[0]?.["session_id"]) : null;
}

/**
 * Persist one incident packet, collapsing per the case's declared rule.
 *
 * Returns `[incidentId, outcome]`. Both Q-0002 rules are implemented and the
 * caller is *told* which to apply -- the schema deliberately permits both
 * (`dedup_key` is indexed but not unique, `related_incident_id` is a plain
 * nullable self-reference) and this driver may not choose between them any more
 * than the schema did.
 */
export function raiseIncident(
  ctx: Context,
  options: {
    factState: string;
    dedupKey: string;
    repeat: number;
    nowMs: number;
    lease?: Lease | null;
  },
): [string, string] {
  const own = ctx.lease;
  if (own === null) {
    throw new ContractViolation("raise_incident runs only with a lease in hand");
  }
  const lease = options.lease ?? own;
  const openRows = rows(
    ctx.connection,
    "SELECT incident_id, retry_count, created_at_ms FROM incident " +
      "WHERE dedup_key = :dedup_key AND resolved_at_ms IS NULL " +
      "ORDER BY created_at_ms, incident_id",
    { dedup_key: options.dedupKey },
  );
  const windowMs = ctx.incidentRenotifyWindowMs;
  const first = openRows[0];
  const withinWindow =
    openRows.length > 0 &&
    (windowMs === null || options.nowMs - Number(first?.["created_at_ms"]) <= windowMs);

  let statement: ReturnType<typeof fencedInsert>;
  let params: Record<string, unknown>;
  let incidentId: string;
  let outcome: string;

  if (withinWindow && ctx.incidentCollapse === COLLAPSE_INCREMENT_IN_PLACE) {
    const root = first as Record<string, unknown>;
    statement = fencedUpdate("incident", {
      set: {
        retry_count: increment("retry_count"),
        updated_at_ms: param("updated_at_ms"),
      },
      where: and_(eq("incident_id", param("incident_id")), isNull("resolved_at_ms")),
      // `incident` has no `writer_epoch` column, so the fence is a clause of the
      // write without stamping one.
      stampsWriterEpoch: false,
    });
    params = { incident_id: root["incident_id"], updated_at_ms: options.nowMs };
    incidentId = String(root["incident_id"]);
    outcome = "collapsed";
  } else {
    incidentId = `${options.dedupKey}-i${options.repeat}`;
    const related = withinWindow ? String(first?.["incident_id"]) : null;
    statement = fencedInsert("incident", {
      values: {
        incident_id: param("incident_id"),
        run_id: param("run_id"),
        session_id: param("session_id"),
        fact_state: param("fact_state"),
        detector_version: param("detector_version"),
        dedup_key: param("dedup_key"),
        retry_count: value(0),
        related_incident_id: param("related_incident_id"),
        created_at_ms: param("created_at_ms"),
        updated_at_ms: param("updated_at_ms"),
      },
      stampsWriterEpoch: false,
    });
    params = {
      incident_id: incidentId,
      run_id: ctx.runId,
      // Foreign keys are enforced, and the binding is not guaranteed to exist:
      // only the Supervisor's script binds at all, and even there the bind can
      // have been refused by a fence. So the row is looked up rather than
      // assumed.
      session_id: boundSessionId(ctx),
      fact_state: options.factState,
      detector_version: DETECTOR_VERSION,
      dedup_key: options.dedupKey,
      related_incident_id: related,
      created_at_ms: options.nowMs,
      updated_at_ms: options.nowMs,
    };
    outcome = related ? "linked" : "opened";
  }

  const write = new ProtectedWrite({
    kind: effectKind(ctx.resource, "raise_incident"),
    idempotencyKey: `raise_incident:${incidentId}:${options.repeat}`,
    statement,
    exactlyOnceMechanism: "transactional_with_record",
    params,
    runId: ctx.runId,
    // Deliberately NOT `incidentId: incidentId`: on the refusal path that would
    // insert an `action` row referencing an incident this write did not manage
    // to create, which is a foreign-key violation in exactly the case where the
    // refusal record matters most.
  });
  try {
    protectedWrite(ctx.connection, lease, write, {
      nowMs: options.nowMs,
      attemptId: attemptId(ctx, "raise_incident", options.repeat),
    });
  } catch (error) {
    if (!(error instanceof StaleWriterRefused)) {
      throw error;
    }
    recordRefusal(ctx, {
      operation: OPERATION_OBSERVE,
      refusal: error.constructor.name,
      epoch: lease.epoch,
      nowMs: options.nowMs,
    });
    outcome = `refused:${error.constructor.name}`;
  }
  return [incidentId, outcome];
}

/**
 * Record a termination/restart recommendation -- or refuse to.
 *
 * This is where interlock D-0006 is *enforced* rather than merely hoped for. The
 * escalation policy is case data: the manifest names which fact states this case
 * would escalate on, and the driver refuses the two D-0006 settles are not
 * anomalies even when it is asked, recording that refusal durably. That is what
 * makes "no termination or restart recommendation is produced from it" an
 * assertion about a row a broken driver would have written, rather than a count
 * of rows nothing in the tree can write.
 *
 * Nothing here reads a fact state's *meaning*: the policy arrives from outside,
 * so Q-0012 stays open.
 */
export function escalate(
  ctx: Context,
  options: { factState: string; incidentId: string; nowMs: number },
): string {
  const lease = ctx.lease;
  if (lease === null) {
    throw new ContractViolation("escalate runs only with a lease in hand");
  }
  if (!ctx.escalateOn.includes(options.factState)) {
    return "not-escalated";
  }
  if (contract.ESCALATION_REFUSED_FACT_STATES.includes(options.factState)) {
    recordRefusal(ctx, {
      operation: OPERATION_OBSERVE,
      refusal: "EscalationRefusedNotAnAnomaly",
      epoch: lease.epoch,
      nowMs: options.nowMs,
    });
    return "escalation-refused";
  }
  // The recommendation is an `action` row, which is what the schema calls a
  // side-effect record -- and it has to be written by a *fenced* insert, because
  // `protectedWrite` only synthesises an action row on the refusal path. A
  // successful protected write leaves no action row behind, so an escalation
  // recorded any other way would be invisible to the query that is supposed to
  // catch it.
  const statement = fencedInsert("action", {
    values: {
      action_id: param("action_id"),
      run_id: param("run_id"),
      kind: param("kind"),
      idempotency_key: param("idempotency_key"),
      exactly_once_mechanism: param("exactly_once_mechanism"),
      status: value("applied"),
      // `action` really does carry a `writer_epoch`, so the fence stamps one.
      // Omitting the column while leaving the builder's default in place raises
      // `UnfencedStatement` before the row is ever written -- which would make
      // this whole path unreachable, and a "no recommendation was produced"
      // assertion means nothing if a recommendation could not have been produced
      // either way.
      writer_epoch: fenceEpoch,
      created_at_ms: param("created_at_ms"),
      applied_at_ms: param("applied_at_ms"),
    },
  });
  const escalationId = `${options.incidentId}-escalation`;
  const kind = effectKind(ctx.resource, ESCALATION_EFFECT);
  const write = new ProtectedWrite({
    kind,
    idempotencyKey: `${ESCALATION_EFFECT}:${escalationId}`,
    statement,
    // interlock D-0004: an action with a real side effect is not the AI's to
    // apply. A restart recommendation is exactly that, so it names the human
    // gate.
    exactlyOnceMechanism: "human_gate",
    params: {
      action_id: escalationId,
      run_id: ctx.runId,
      kind,
      idempotency_key: `${ESCALATION_EFFECT}:${escalationId}`,
      exactly_once_mechanism: "human_gate",
      created_at_ms: options.nowMs,
      applied_at_ms: options.nowMs,
    },
    runId: ctx.runId,
  });
  protectedWrite(ctx.connection, lease, write, {
    nowMs: options.nowMs,
    attemptId: attemptId(ctx, ESCALATION_EFFECT),
  });
  return "escalated";
}

/**
 * Read the worker, name what the read found, and persist the packet.
 *
 * The repeats are the ACCEPTANCE.md section 2 dedup row's "raise the same
 * incident condition repeatedly within a window"; the window and the collapse
 * rule are the case's, never this module's.
 */
export function opObserve(ctx: Context): void {
  const own = ctx.lease;
  if (own === null) {
    throw new ContractViolation("observe runs only with a lease in hand");
  }
  const dedupKey = ctx.incidentDedupKey ?? `${ctx.holder}-observation`;
  let repeats = Math.max(1, ctx.incidentRepeats);

  // Resumable by query, like every other step (interlock D-0001). A restarted
  // process re-runs its script from the top, and re-observing would either
  // collide on the incident's primary key or increment a retry count that no
  // repeat earned -- so an observation already on record is adopted rather than
  // taken again. The seam is also left as the predecessor found it: a restart
  // must not repair the observation path on its way past.
  if (
    ctx.restartGeneration > 0 &&
    rows(ctx.connection, "SELECT incident_id FROM incident WHERE dedup_key = :dedup_key", {
      dedup_key: dedupKey,
    }).length > 0
  ) {
    ctx.emit({
      event: EVENT_STEP,
      operation: OPERATION_OBSERVE,
      outcome: "adopted",
      now_ms: ctx.clock.nowMs(),
    });
    return;
  }

  const factState = classifyObservation(ctx);
  // The stale-writer injection: a token one epoch off the row, so every
  // protected write below is fenced out. Two repeats, because one refusal cannot
  // collide with anything -- the defect this exists to expose is a refusal id
  // that repeats.
  const stale = ctx.behaviours.includes(BEHAVIOUR_STALE_WRITER);
  const lease = stale
    ? new Lease(own.resource, own.holder, own.epoch + 1, own.acquiredAtMs, own.expiresAtMs)
    : null;
  if (stale) {
    repeats = Math.max(repeats, 2);
  }
  const replay = ctx.behaviours.includes(BEHAVIOUR_INCIDENT_REPLAY);
  const outcomes: string[] = [];
  let incidentId = "";
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    ctx.barrier.hit(CHECKPOINT_BEFORE_DURABLE_WRITE, { operation: OPERATION_OBSERVE });
    const nowMs = ctx.clock.advance();
    let raised = factState;
    if (replay && repeat > 0) {
      // The replay: this raise is not a fresh observation at all, it is the
      // persisted packet read back and submitted again. Whether the replay is
      // collapsed or opens a linked incident is the case's declared rule -- the
      // same rule a repeat follows -- which is the point: a replayed packet must
      // not be a way around dedup.
      const persisted = rows(
        ctx.connection,
        "SELECT fact_state FROM incident WHERE dedup_key = :dedup_key " +
          "ORDER BY created_at_ms, incident_id LIMIT 1",
        { dedup_key: dedupKey },
      );
      if (persisted.length > 0) {
        raised = String(persisted[0]?.["fact_state"]);
      }
    }
    const [raisedId, outcome] = raiseIncident(ctx, {
      factState: raised,
      dedupKey,
      repeat,
      nowMs,
      lease,
    });
    incidentId = raisedId;
    outcomes.push(outcome);
    ctx.barrier.hit(CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT, { operation: OPERATION_OBSERVE });
  }
  const escalation = escalate(ctx, {
    factState,
    incidentId,
    nowMs: ctx.clock.nowMs(),
  });
  ctx.emit({
    event: EVENT_STEP,
    operation: OPERATION_OBSERVE,
    outcome: outcomes.join(","),
    fact_state: factState,
    escalation,
    now_ms: ctx.clock.nowMs(),
  });
  ctx.barrier.hit(contract.SYNC_OBSERVED, { operation: OPERATION_OBSERVE, kind: EVENT_SYNC });
}

// -- the outbox surface ------------------------------------------------------

function makeOutbox(ctx: Context): Outbox {
  const root = dropboxRoot(ctx.workdir, ctx.role);
  let dropbox: DropboxLike = new KeyedDropbox(root, `${ctx.role}-dropbox`);
  if (ctx.behaviours.includes(BEHAVIOUR_DROP_DELIVERY) && ctx.restartGeneration === 0) {
    // Only the first generation drops: a restart's job is to drive the
    // unfinished work to resolution, and a destination that keeps refusing would
    // be testing the harness's patience rather than the resend.
    dropbox = new DroppingDropbox(dropbox, { root, dropAttempt: 1 });
  } else if (ctx.behaviours.includes(BEHAVIOUR_RECIPIENT_UNAVAILABLE)) {
    // Deliberately *not* gated on the generation: this budget is durable, so it
    // keeps counting across the restart and stops refusing on its own.
    dropbox = new UnavailableDropbox(dropbox, {
      root,
      unavailableAttempts: ctx.unavailableAttempts,
    });
  }
  return new Outbox(ctx.connection, {
    resource: ctx.resource,
    holder: ctx.holder,
    registry: spikeRegistry(dropbox),
    checkpoint: (name: string) => {
      ctx.barrier.hit(name, { operation: OPERATION_ATTEMPT });
    },
  });
}

export function opEnqueue(ctx: Context, outbox: Outbox): void {
  const lease = ctx.lease;
  if (lease === null) {
    throw new ContractViolation("enqueue runs only with a lease in hand");
  }
  for (let index = 0; index < ctx.messages; index += 1) {
    const messageId = ctx.messageId(index);
    const payload = ctx.payload(index);
    const known = rows(
      ctx.connection,
      "SELECT message_id FROM outbox WHERE message_id = :message_id",
      { message_id: messageId },
    );
    if (known.length > 0) {
      ctx.emit({
        event: EVENT_STEP,
        operation: OPERATION_ENQUEUE,
        outcome: "already-enqueued",
        message_id: messageId,
        now_ms: ctx.clock.nowMs(),
      });
      continue;
    }
    ctx.barrier.hit(CHECKPOINT_BEFORE_DURABLE_WRITE, { operation: OPERATION_ENQUEUE });
    const nowMs = ctx.clock.advance();
    let outcome: string;
    try {
      outbox.enqueue({
        messageId,
        recipient: NOTIFY_RECIPIENT,
        payload,
        dedupKey: ctx.dedupKey(index),
        nowMs,
        epoch: lease.epoch,
        runId: ctx.runId,
      });
      outcome = "enqueued";
    } catch (error) {
      if (!(error instanceof StaleWriterRefused)) {
        throw error;
      }
      outcome = `refused:${error.constructor.name}`;
      recordRefusal(ctx, {
        operation: OPERATION_ENQUEUE,
        refusal: error.constructor.name,
        epoch: lease.epoch,
        nowMs,
      });
    }
    ctx.barrier.hit(CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT, { operation: OPERATION_ENQUEUE });
    ctx.emit({
      event: EVENT_STEP,
      operation: OPERATION_ENQUEUE,
      outcome,
      message_id: messageId,
      now_ms: nowMs,
    });
  }
}

/**
 * The record -> effect -> result path: where all four windows live.
 *
 * Scoped to **this role's own rows**, by the message ids this role derives from
 * its own holder identity. That scoping is load-bearing rather than tidy:
 * `Outbox.due()` returns every unacked row in the database, not the rows of the
 * outbox object's own `(resource, holder)`, and the fence it validates is
 * `writer_epoch = :epoch` against *this* writer's live lease -- so with every
 * role sitting at epoch 1 (which is the normal case, since each holds a
 * different resource) one role's delivery loop will happily deliver another
 * role's messages into its own destination. Disjoint write-sets are what makes a
 * combination case a cross-role interleaving rather than three processes doing
 * each other's work (design 2.1 item 5), so the driver scopes what the API does
 * not.
 */
export function opAttempt(ctx: Context, outbox: Outbox): void {
  const lease = ctx.lease;
  if (lease === null) {
    throw new ContractViolation("attempt runs only with a lease in hand");
  }
  const due = new Map(outbox.due(ctx.clock.nowMs()).map((message) => [message.messageId, message]));
  for (let index = 0; index < deliverable(ctx); index += 1) {
    const messageId = ctx.messageId(index);
    const message = due.get(messageId);
    if (message === undefined || message.status === "acked") {
      continue;
    }
    // One attempt per message normally. A case that holds the recipient
    // unavailable needs *several*, and they have to happen here: a resend driven
    // only by restart generations would give at most two attempts, and
    // "monotonically increasing" wants more than one increment to be meaningful.
    // The loop is bounded so a destination that refuses forever becomes an
    // attributable failure and not a wedge (design 8.2), and it only ever runs
    // more than once for a case that asked for it -- so no other case's
    // `attempt` occurrence indices move.
    const attempts = ctx.behaviours.includes(BEHAVIOUR_RECIPIENT_UNAVAILABLE)
      ? MAX_ATTEMPTS_PER_MESSAGE
      : 1;
    for (let round = 0; round < attempts; round += 1) {
      const nowMs = ctx.clock.advance();
      let outcome: string;
      let deduplicated = false;
      try {
        const result = outbox.attempt(messageId, { nowMs, epoch: lease.epoch });
        outcome = "delivered";
        deduplicated = result.deduplicated;
      } catch (error) {
        if (error instanceof DestinationRefusal) {
          outcome = `refused:${error.constructor.name}`;
        } else if (error instanceof StaleWriterRefused) {
          outcome = `refused:${error.constructor.name}`;
          recordRefusal(ctx, {
            operation: OPERATION_ATTEMPT,
            refusal: error.constructor.name,
            epoch: lease.epoch,
            nowMs,
          });
        } else {
          throw error;
        }
      }
      ctx.emit({
        event: EVENT_STEP,
        operation: OPERATION_ATTEMPT,
        outcome,
        message_id: messageId,
        deduplicated,
        now_ms: nowMs,
      });
      if (outcome === "delivered") {
        break;
      }
    }
  }
}

/**
 * How many times each message is acked in this generation.
 *
 * Once by default. It used to be twice unconditionally, as standing evidence
 * that acks are idempotent -- but ACCEPTANCE.md section 2's Ack row asks for
 * "duplicate the ack" and "ack an already-acked message" as *injections*, and an
 * injection every case performs anyway is one no case can fail on. So the repeat
 * is behaviour-driven now: the cases that name the injection get it, and the
 * baseline cases ack once, which is what lets a regression in one of the two
 * shapes actually turn a case red.
 */
function ackRepeats(ctx: Context): number {
  if (ctx.behaviours.includes(BEHAVIOUR_DUP_ACK) || ctx.behaviours.includes(BEHAVIOUR_RE_ACK)) {
    return 2;
  }
  return 1;
}

/** Record the acks for this role's own messages. */
export function opAck(ctx: Context, outbox: Outbox): void {
  if (ctx.behaviours.includes(BEHAVIOUR_LOST_ACK) && ctx.restartGeneration === 0) {
    ctx.emit({
      event: EVENT_STEP,
      operation: OPERATION_ACK,
      outcome: "lost",
      now_ms: ctx.clock.nowMs(),
    });
    return;
  }
  for (let index = 0; index < ctx.messages; index += 1) {
    const messageId = ctx.messageId(index);
    const found = rows(ctx.connection, "SELECT status FROM outbox WHERE message_id = :message_id", {
      message_id: messageId,
    });
    const status = found.length > 0 ? found[0]?.["status"] : undefined;
    if (found.length === 0 || status === "pending") {
      continue;
    }
    if (ctx.behaviours.includes(BEHAVIOUR_RE_ACK) && status !== "acked") {
      // "Ack an already-acked message" means exactly that: drive the row to its
      // terminal state first, then ack it again below. Without this the second
      // ack would be a duplicate of a non-terminal ack, which is the *other*
      // injection.
      outbox.recordAck(messageId, { nowMs: ctx.clock.advance() });
    }
    for (let repeat = 0; repeat < ackRepeats(ctx); repeat += 1) {
      ctx.barrier.hit(CHECKPOINT_BEFORE_DURABLE_WRITE, { operation: OPERATION_ACK });
      const nowMs = ctx.clock.advance();
      const outcome = outbox.recordAck(messageId, { nowMs });
      if (!outcome.recorded) {
        // An ack against a row that is already terminal changes nothing -- which
        // is the invariant, and which is also why it leaves no trace of its own
        // anywhere in the control plane. That silence is a problem for the two
        // cases whose whole injection is the *second* ack: with no record, a
        // case asserting "exactly one acked state" passes identically whether
        // the duplicate was issued or never happened at all.
        //
        // So the ignored ack goes in the harness ledger, which exists for
        // exactly this -- the classes the spike persists nowhere. It is a
        // persisted, query-answerable row, which is the standard ACCEPTANCE.md
        // section 2 sets, and it makes the ack-multiplicity cases fail if the
        // multiplicity ever stops happening.
        recordRefusal(ctx, {
          operation: OPERATION_ACK,
          refusal: "AckAlreadyRecorded",
          epoch: ctx.lease !== null ? ctx.lease.epoch : 0,
          nowMs,
        });
      }
      ctx.barrier.hit(CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT, { operation: OPERATION_ACK });
      ctx.emit({
        event: EVENT_STEP,
        operation: OPERATION_ACK,
        outcome: outcome.recorded ? "recorded" : "already-acked",
        message_id: messageId,
        now_ms: nowMs,
      });
    }
  }
}

const SIMPLE_OPERATIONS: Readonly<Record<string, (ctx: Context) => void>> = Object.freeze({
  [OPERATION_LEASE_ACQUIRE]: opLeaseAcquire as (ctx: Context) => void,
  [OPERATION_LEASE_RENEW]: opLeaseRenew,
  [OPERATION_LEASE_RELEASE]: opLeaseRelease,
  [OPERATION_BIND]: opBind,
  [OPERATION_OBSERVE]: opObserve,
});

// ---------------------------------------------------------------------------
// recovery -- design 2.1, item 4 of the role-process contract
// ---------------------------------------------------------------------------

/**
 * Recover before proceeding. The command line and the file are the input.
 *
 * Reconstruct by query, re-establish the lease (already done by
 * {@link opLeaseAcquire}), adopt the rows the dead generation left unowned, and
 * drive them to resolution. Only then does the operation script continue.
 */
export function recover(ctx: Context, outbox: Outbox): void {
  const lease = ctx.lease;
  if (lease === null) {
    throw new ContractViolation("recovery runs only with a lease in hand");
  }
  const nowMs = ctx.clock.advance();
  const report = outbox.recover({ nowMs, epoch: lease.epoch });
  ctx.emit({
    event: EVENT_STEP,
    operation: "recover",
    adopted: [...report.adopted].sort(),
    still_unowned: [...report.stillUnowned].sort(),
    now_ms: nowMs,
  });
  opAttempt(ctx, outbox);
  opAck(ctx, outbox);
  ctx.emit({
    event: EVENT_RECOVERY_COMPLETE,
    generation: ctx.restartGeneration,
    now_ms: ctx.clock.nowMs(),
  });
}

/** Run this role's operation script (design 2.1). */
export function runScript(ctx: Context): void {
  const steps = ROLE_SCRIPTS[ctx.role] ?? [];
  let outbox: Outbox | null = null;

  for (const step of steps) {
    if (step === OPERATION_LEASE_ACQUIRE) {
      if (opLeaseAcquire(ctx) === null) {
        // Refused at acquire. The script is *over*, and it ended correctly: this
        // writer was rejected rather than merged, which is the whole of what the
        // case is asserting. Carrying on would mean writing without a lease,
        // which is the defect.
        if (ctx.restartGeneration > 0) {
          // A restart's contract is "recover before you proceed", and this
          // restart did: it reconstructed its view from SQLite alone, found the
          // resource held by someone else, and declined to write. That is
          // recovery concluding correctly, not recovery failing to happen -- so
          // the event is emitted, and the controller is not left waiting on a
          // process that has already done everything it may do.
          ctx.emit({
            event: EVENT_RECOVERY_COMPLETE,
            generation: ctx.restartGeneration,
            adopted: [],
            outcome: "refused",
            now_ms: ctx.clock.nowMs(),
          });
        }
        break;
      }
      ctx.barrier.hit(contract.SYNC_LEASE_ACQUIRED, {
        operation: OPERATION_LEASE_ACQUIRE,
        kind: EVENT_SYNC,
      });
      outbox = makeOutbox(ctx);
      if (ctx.restartGeneration > 0) {
        recover(ctx, outbox);
      }
      continue;
    }
    if (outbox === null) {
      throw new ContractViolation("a role script acquires its lease first");
    }
    const simple = SIMPLE_OPERATIONS[step];
    if (simple !== undefined) {
      simple(ctx);
    } else if (step === OPERATION_ENQUEUE) {
      opEnqueue(ctx, outbox);
    } else if (step === OPERATION_ATTEMPT) {
      opAttempt(ctx, outbox);
    } else if (step === OPERATION_ACK) {
      opAck(ctx, outbox);
    } else {
      throw new ContractViolation(`unknown script step ${JSON.stringify(step)}`);
    }
  }

  ctx.barrier.hit(contract.SYNC_SCRIPT_COMPLETE, {
    operation: OPERATION_ACK,
    kind: EVENT_SYNC,
  });
}

// ---------------------------------------------------------------------------
// the adapter object -- contract.FullFaultAdapter
// ---------------------------------------------------------------------------

/**
 * The destination's own record, read from outside the killed process.
 *
 * `KeyedDropbox` is file-backed and its effect files are published with a hard
 * link, so the record survives a SIGKILL of the writer and the controller can
 * read it directly. That is what design 6.2 requires of the destination
 * observer: the counterparty's evidence, never a re-derivation from our own
 * rows.
 */
class DropboxObserver implements DestinationObserver {
  private readonly dropbox: KeyedDropbox;
  private readonly root: string;

  constructor(root: string, name: string) {
    this.root = root;
    this.dropbox = new KeyedDropbox(root, name);
  }

  effectCount(idempotencyKey: string): number {
    return this.dropbox.effectCount(idempotencyKey);
  }

  attemptCount(idempotencyKey: string): number {
    return this.dropbox.attemptCount(idempotencyKey);
  }

  effects(): readonly string[] {
    return this.dropbox.effects();
  }

  /**
   * Remove a lock file a SIGKILLed writer left behind.
   *
   * `KeyedDropbox` serialises its critical section with an exclusive lock file
   * and nothing reaps it; a process killed inside that section wedges the
   * destination for every later attempt. Reaping it is the controller's job
   * precisely because the controller is the one that fired the signal.
   *
   * The lock path is composed from the root this observer was handed rather than
   * read off the dropbox's private field, which is what the source does; the
   * value is the same and the reach into another module's internals is not
   * needed.
   */
  unwedge(): void {
    const lock = join(this.root, LOCK_NAME);
    try {
      rmSync(lock);
    } catch {
      // Not there. Nothing to reap.
    }
  }
}

/**
 * Named SQL over the spike schema. The names are the contract's and the
 * assertions are written against them; this mapping is the throwaway half.
 */
const INVARIANT_QUERIES: Readonly<Record<string, string>> = Object.freeze({
  // No outbox row is left in a state with no owner after recovery
  // (ACCEPTANCE.md section 2, outbox resend row). This is the outbox's own
  // query.
  [contract.INVARIANT_NO_UNOWNED_OUTBOX]: UNOWNED_OUTBOX_QUERY,
  // Retry count is durable across restarts and never goes backwards; the
  // schema's own trigger forbids a decrease, so the query reports the values and
  // the test asserts the floor it expects.
  [contract.INVARIANT_RETRY_COUNT_DURABLE]: `
        SELECT message_id, status, retry_count, writer_epoch
          FROM outbox
         WHERE message_id LIKE :holder_prefix
         ORDER BY message_id
    `,
  // Exactly one acked state per message identity, regardless of ack multiplicity
  // (ACCEPTANCE.md section 2, ack row).
  [contract.INVARIANT_SINGLE_ACKED_STATE]: `
        SELECT dedup_key,
               COUNT(*)                                    AS rows_total,
               SUM(CASE WHEN status = 'acked' THEN 1 ELSE 0 END) AS acked_rows
          FROM outbox
         WHERE message_id LIKE :holder_prefix
         GROUP BY dedup_key
         ORDER BY dedup_key
    `,
  // The applied-write history for one role's own write scope, in the database's
  // own insertion order -- never in the caller's skewed clock order. A non-empty
  // epoch regression here is the interleaving ACCEPTANCE.md section 2 forbids.
  //
  // Scoped by `run_id` and not by resource, because `action` has no resource
  // column and the workaround -- encoding the resource in `action.kind` via
  // `effectKind` -- only reaches the rows the lease module itself writes. The
  // outbox's delivery rows carry the handler's bare `kind` ("notify"), so a
  // resource-suffix filter would silently match nothing and this invariant would
  // be vacuous. Every role has its own run, so `run_id` is per-resource in
  // practice.
  [contract.INVARIANT_LINEAR_WRITER_HISTORY]: `
        SELECT rowid AS write_seq, action_id, kind, status, writer_epoch,
               refusal_reason, created_at_ms, applied_at_ms
          FROM action
         WHERE run_id = :scope
         ORDER BY write_seq
    `,
  // Gate item 2: the run's active session bindings, with the count the partial
  // unique index already caps at one. The query reports; "exactly one" --
  // non-empty included -- is the assertion's, made after recovery.
  [contract.INVARIANT_ONE_BINDING_PER_RUN]: `
        SELECT session_id, run_id, binding_phase, observation, bound_at_ms
          FROM session
         WHERE run_id = :scope AND released_at_ms IS NULL
         ORDER BY bound_at_ms, session_id
    `,
  // The refusal of a stale writer, durable and query-answerable. This is a SQL
  // query over a persisted row, not a harness event-trace line: the trace would
  // only prove the harness saw an exception (design 5).
  //
  // `holder LIKE :holder || '%'` and not `holder = :holder`: a claimant or a
  // racer is this holder plus a suffix, and its refusal is the one several of
  // the ACCEPTANCE.md section 2 rows are actually about -- the second writer
  // that was rejected rather than merged. Scoping to the exact holder would make
  // precisely those refusals invisible and report them as "never recorded". The
  // refusal belongs to the resource's timeline, which is what the resource
  // predicate already pins, not to one holder identity.
  [contract.INVARIANT_RECORDED_REFUSALS]: `
        SELECT seq, resource, holder, epoch, operation, refusal, now_ms
          FROM harness_refusal
         WHERE resource = :resource
           AND holder LIKE :holder || '%'
         ORDER BY seq
    `,
  // Nothing is left half-recorded once recovery has run.
  [contract.INVARIANT_NO_PENDING_ACTION]: `
        SELECT action_id, kind, idempotency_key, writer_epoch, created_at_ms
          FROM action
         WHERE run_id = :scope
           AND status = 'pending'
         ORDER BY rowid
    `,
  // One live holder per resource at the observation instant. The spike schema
  // keeps one mutable lease row per resource and no history table, so this is
  // the final-state half only -- the timeline property is asserted through
  // linear-writer-history and recorded-refusals instead (design 5).
  [contract.INVARIANT_LEASE_SINGLE_HOLDER]: `
        SELECT resource, holder, epoch, acquired_at_ms, expires_at_ms
          FROM lease
         WHERE expires_at_ms > :now_ms
         ORDER BY resource
    `,
  // Every incident row in the scope. The assertion groups by dedup key and
  // checks whichever collapse rule the case declared -- so neither Q-0002 rule
  // appears in this SQL, which is the same reason the schema indexes `dedup_key`
  // without making it unique. A query that counted rows per key would have
  // chosen the increment-in-place rule by arithmetic.
  [contract.INVARIANT_INCIDENT_COLLAPSE]: `
        SELECT incident_id, dedup_key, fact_state, detector_version,
               retry_count, related_incident_id, created_at_ms, updated_at_ms,
               resolved_at_ms
          FROM incident
         WHERE run_id = :scope
         ORDER BY created_at_ms, incident_id
    `,
  // "Work resumes from unresolved incidents" (gate item 4, interlock D-0001) is
  // one query, and the schema says so in a comment on the index this uses.
  [contract.INVARIANT_UNRESOLVED_INCIDENTS]: `
        SELECT incident_id, dedup_key, fact_state, retry_count, created_at_ms
          FROM incident
         WHERE run_id = :scope
           AND resolved_at_ms IS NULL
         ORDER BY created_at_ms, incident_id
    `,
  // What the observation path was classified as. Every incident row in the scope
  // is one, because an escalation is an `action` row and not an incident -- the
  // recommendation and the fact it was drawn from are different records on
  // purpose.
  [contract.INVARIANT_OBSERVATION_CLASSIFIED]: `
        SELECT incident_id, fact_state, detector_version, dedup_key,
               created_at_ms
          FROM incident
         WHERE run_id = :scope
         ORDER BY created_at_ms, incident_id
    `,
  // The termination/restart recommendations produced in this scope. A COUNT, so
  // the query always returns exactly one row and "none were produced" is a pass
  // rather than an empty result the assertion would have to guess about. A
  // driver that escalated on an interlock D-0006 state moves this number, which
  // is what makes the assertion falsifiable.
  [contract.INVARIANT_NO_ANOMALY_ESCALATION]: `
        SELECT COUNT(*) AS escalations
          FROM action
         WHERE run_id = :scope
           AND kind LIKE 'recommend_restart@%'
           AND status <> 'refused'
    `,
});

/**
 * Resource names are **per-case data, not a role table** -- Q-0001 (which
 * component may hold which resource) was open on this spike schema and this
 * harness did not answer it by inertia. These are the spike adapter's defaults
 * for its own three scripts and nothing more.
 */
export function resourceOf(role: string): string {
  return `harness-${role}`;
}

export function holderOf(role: string): string {
  return `holder-${role}`;
}

export function runIdOf(role: string): string {
  return `run-${role}`;
}

/** `contract.FullFaultAdapter` over the spike surface. Throwaway with it. */
export class SpikeAdapter implements FullFaultAdapter {
  readonly name = "spike";
  readonly driverModule = DRIVER_MODULE;
  readonly driverSourcePath = DRIVER_SOURCE_PATH;

  /**
   * The command that runs this driver as a child process.
   *
   * The source spawns `python -m <dotted module>`. Node has no equivalent, and
   * the two flags here are what replace it. Type stripping runs the `.ts` file
   * directly, which is the only way the driver can live in `test/` and still
   * import `src/` -- CI runs `typecheck` and `parity` before any build, so a
   * driver that imported `dist/` would break collection on a clean checkout.
   * The register shim adds the `.js` -> `.ts` resolution that stripping does not
   * do on its own.
   *
   * The flag is passed only where it is needed: type stripping is on by default
   * from Node 23.6, and this keeps the command correct across the whole
   * supported range rather than pinning it to the version that happened to be
   * installed.
   */
  driverCommand(): { executable: string; prefixArguments: readonly string[] } {
    const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    const register = fileURLToPath(new URL("./driver-register.mjs", import.meta.url));
    const flags = major < 23 ? ["--experimental-strip-types"] : [];
    return {
      executable: process.execPath,
      prefixArguments: [...flags, "--import", register, DRIVER_SOURCE_PATH],
    };
  }

  /** Create the control plane and the run rows the scripts presuppose. */
  bootstrap(dbPath: string, options: { roles: readonly string[]; nowMs: number }): void {
    const connection = createControlPlane(dbPath);
    try {
      const insert = connection.prepare(
        "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
      );
      for (const role of options.roles) {
        insert.run(runIdOf(role), "running", options.nowMs, options.nowMs);
      }
    } finally {
      connection.close();
    }
  }

  roleArguments(role: string, options: { case: FaultCase; workdir: string }): readonly string[] {
    const faultCase = options.case;
    const behaviours = (faultCase["behaviours"] as string[] | undefined) ?? [];
    const argv: string[] = [
      "--resource",
      resourceOf(role),
      "--holder",
      holderOf(role),
      "--run-id",
      runIdOf(role),
      "--workdir",
      options.workdir,
      "--ttl-ms",
      String(faultCase["ttl_ms"]),
      "--messages",
      String(faultCase["messages"] ?? 1),
      "--manifest-version",
      String(faultCase["manifest_version"]),
    ];
    for (const behaviour of behaviours) {
      argv.push("--behaviour", behaviour);
    }

    // Forwarded verbatim, and only when the case declared them: a case that says
    // nothing gets the driver's inert defaults, which is what keeps the seed
    // cases running exactly as they did.
    const observation = faultCase["observation"] as Record<string, unknown> | null | undefined;
    if (observation) {
      argv.push("--observation-mode", String(observation["mode"]));
      for (const factState of (observation["escalate_on"] as string[] | undefined) ?? []) {
        argv.push("--escalate-on", factState);
      }
    }

    const incident = faultCase["incident_params"] as Record<string, unknown> | null | undefined;
    if (incident) {
      // `dedup_key` is the case's, never composed here. Q-0002 asks what
      // composes an incident dedup key; a driver-side formula would answer it by
      // inertia, exactly as a role-to-resource table would have answered Q-0001.
      if (incident["dedup_key"] !== null && incident["dedup_key"] !== undefined) {
        argv.push("--incident-dedup-key", String(incident["dedup_key"]));
      }
      if (incident["repeats"]) {
        argv.push("--incident-repeats", String(incident["repeats"]));
      }
      if (incident["collapse"] !== null && incident["collapse"] !== undefined) {
        argv.push("--incident-collapse", String(incident["collapse"]));
      }
      if (incident["renotify_window_ms"] !== null && incident["renotify_window_ms"] !== undefined) {
        argv.push("--incident-renotify-window-ms", String(incident["renotify_window_ms"]));
      }
      if (
        incident["reconcile_interval_ms"] !== null &&
        incident["reconcile_interval_ms"] !== undefined
      ) {
        argv.push("--incident-reconcile-interval-ms", String(incident["reconcile_interval_ms"]));
      }
    }

    if (faultCase["unavailable_attempts"]) {
      argv.push("--unavailable-attempts", String(faultCase["unavailable_attempts"]));
    }
    return argv;
  }

  observer(workdir: string, role: string): DestinationObserver {
    return new DropboxObserver(dropboxRoot(workdir, role), `${role}-dropbox`);
  }

  invariantQueries(): Readonly<Record<string, string>> {
    return { ...INVARIANT_QUERIES };
  }

  // -- helpers the cases use to name rows without importing the spike -----

  resourceOf(role: string): string {
    return resourceOf(role);
  }

  holderOf(role: string): string {
    return holderOf(role);
  }

  runIdOf(role: string): string {
    return runIdOf(role);
  }

  /**
   * The destination keys `role`'s script produced under `faultCase`.
   *
   * The durable tests count effects per key without knowing how a key is
   * spelled; `dup-delivery` is exactly the case where two messages share one
   * key, and one key is what "duplicate delivery causes exactly one effect" is
   * counted over.
   */
  effectKeys(
    role: string,
    faultCase: FaultCase,
    options: { holderSuffix?: string } = {},
  ): readonly string[] {
    let holder = holderOf(role);
    if (options.holderSuffix) {
      holder = `${holder}-${options.holderSuffix}`;
    }
    const behaviours = (faultCase["behaviours"] as string[] | undefined) ?? [];
    const dedupKeys = behaviours.includes(BEHAVIOUR_DUP_DELIVERY)
      ? [`${holder}-dedup`]
      : Array.from(
          { length: Number(faultCase["messages"] ?? 1) },
          (_unused, index) => `${holder}-dedup-${index}`,
        );
    return dedupKeys.map((key) => `${NOTIFY_RECIPIENT}:notify:${key}`);
  }

  /** Bind the contract's invariant parameters to this schema's spelling. */
  queryParameters(role: string, options: { nowMs: number }): Readonly<Record<string, unknown>> {
    return {
      resource: resourceOf(role),
      holder: holderOf(role),
      // `-m%` and not `-%`: a claimant's holder is this holder plus a suffix,
      // and a looser pattern would sweep the claimant's rows into assertions
      // scoped to this role.
      holder_prefix: `${holderOf(role)}-m%`,
      scope: runIdOf(role),
      now_ms: Math.trunc(options.nowMs),
    };
  }

  /** The refusal ledger is a sidecar; everything else is the control plane. */
  storePath(name: string, options: { controlPlane: string; workdir: string }): string {
    if (name === contract.INVARIANT_RECORDED_REFUSALS) {
      return refusalLedgerPath(options.workdir);
    }
    return options.controlPlane;
  }

  /** The outbox's own constants, for the battery's equality assertion (design 6.2). */
  checkpointVocabulary(): readonly string[] {
    return [...OUTBOX_CHECKPOINTS];
  }

  /** The driver's own parser, so the battery can test acceptance rather than help text. */
  parseDriverArguments(argv: readonly string[]): void {
    parseArguments(argv);
  }

  openStore(dbPath: string): SqliteDatabase {
    return openControlPlane(dbPath);
  }
}

export const SPIKE_ADAPTER = new SpikeAdapter();

// ---------------------------------------------------------------------------
// the executable module
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
  resource: string;
  holder: string;
  runId: string;
  workdir: string;
  ttlMs: number;
  messages: number;
  manifestVersion: number;
  behaviour: string[];
  observationMode: string;
  escalateOn: string[];
  incidentDedupKey: string | null;
  incidentRepeats: number;
  incidentCollapse: string | null;
  incidentRenotifyWindowMs: number | null;
  incidentReconcileIntervalMs: number | null;
  unavailableAttempts: number;
}

/**
 * The driver's `--help`, which the conformance battery reads.
 *
 * The battery runs `--help` in a real subprocess and asserts every option the
 * contract names appears in stdout, which also smoke-tests that the module is
 * executable at all. ASCII only: this text reaches a console whose encoding is
 * cp932 on the Windows job, and a dash outside ASCII crashes `--help` there
 * while every in-process test still passes.
 */
function helpText(): string {
  const lines = [
    `usage: ${DRIVER_MODULE} [options]`,
    "",
    "Role driver: one role process over the control-plane spike surface.",
    "Spawned by the fault-injection controller; not useful by hand.",
    "",
    "options:",
  ];
  const described: [string, string][] = [
    ["--role", `one of ${contract.ROLES.join(", ")}`],
    ["--db", "path to the control-plane database"],
    ["--case-id", "the manifest case this process is running"],
    ["--suite-seed", "the run's suite seed"],
    ["--armed", "comma-separated armed anchors, each 'operation@anchor:occurrence'"],
    ["--clock-base-ms", "the injected clock's base instant"],
    ["--clock-offset-ms", "the injected clock's starting offset"],
    ["--restart-generation", "0 for a first start, N for the Nth restart"],
    ["--control-fd", "file descriptor the controller writes commands to"],
    ["--event-fd", "file descriptor this process writes events to"],
    ["--resource", "the lease resource this role holds"],
    ["--holder", "this role's lease holder identity"],
    ["--run-id", "the run this role's rows belong to"],
    ["--workdir", "the case's working directory"],
    ["--ttl-ms", "lease TTL"],
    ["--messages", "how many messages this role's script enqueues"],
    ["--manifest-version", "the manifest version this case came from"],
    ["--behaviour", `repeatable; one of ${BEHAVIOURS.join(", ")}`],
    ["--observation-mode", `one of ${contract.OBSERVATION_MODES.join(", ")}`],
    ["--escalate-on", "repeatable; fact states this case's policy would escalate on"],
    ["--incident-dedup-key", "the case's incident dedup key"],
    ["--incident-repeats", "how many times the condition is raised"],
    ["--incident-collapse", `one of ${COLLAPSE_RULES.join(", ")}`],
    ["--incident-renotify-window-ms", "the case's re-notification window"],
    ["--incident-reconcile-interval-ms", "Q-0003; refused a value by validation"],
    ["--unavailable-attempts", "how many attempts the recipient refuses"],
  ];
  for (const [option, description] of described) {
    lines.push(`  ${option.padEnd(34)}${description}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A hand-rolled parser, because the contract's CLI is the contract's.
 *
 * The repository's own `src/cli/parser.ts` reproduces argparse for the shipped
 * CLI; this surface is smaller and is defined by {@link contract.driverCliArguments}
 * rather than by that CLI's conventions, so it is parsed here rather than
 * routed through a parser built for a different contract. An unknown option is
 * a hard error: the controller composes this command line, so an option it does
 * not recognise means the two have drifted.
 */
/**
 * One CLI integer, parsed the way `argparse(type=int)` parses it.
 *
 * The same class of defect the review gate found twice elsewhere in this belt
 * (the suite seed, and an armed anchor's occurrence index), swept here rather
 * than left for a third round to find one at a time. `argparse` with `type=int`
 * rejects the whole argument if any of it is not a whole number;
 * `Number.parseInt` accepts a prefix (`"12x"` -> 12) and yields `NaN` for
 * nonsense, and `NaN` then flows into the clock, the message count or the
 * generation without ever comparing unequal to anything.
 *
 * These options are composed by the controller rather than typed by a person,
 * so a malformed one is a harness bug -- which is exactly why it must be loud:
 * a silently truncated `--clock-base-ms` or `--suite-seed` corrupts the injected
 * clock or the per-case digest while every assertion still passes, and the
 * identical-trace property the battery checks would be quietly untrue.
 *
 * A leading `-` is accepted because `--clock-offset-ms` is genuinely negative
 * for a backward skew (design 7).
 */
function requireInteger(option: string, raw: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new ContractViolation(`${option} expects a whole number, got ${JSON.stringify(raw)}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new ContractViolation(`${option} is past the exactly-representable range: ${raw}`);
  }
  return parsed;
}

/**
 * @internal Not package API -- exported so the conformance battery can assert that
 * the parser accepts every option the contract names (interlock D-0101's rule for
 * a module-private name a case has to reach).
 */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    role: "",
    db: "",
    caseId: "",
    suiteSeed: 0,
    armed: "",
    clockBaseMs: 0,
    clockOffsetMs: 0,
    restartGeneration: 0,
    controlFd: 0,
    eventFd: 1,
    resource: "",
    holder: "",
    runId: "",
    workdir: "",
    ttlMs: 30_000,
    messages: 1,
    manifestVersion: 1,
    behaviour: [],
    observationMode: contract.OBSERVATION_HEALTHY,
    escalateOn: [],
    incidentDedupKey: null,
    incidentRepeats: 0,
    incidentCollapse: null,
    incidentRenotifyWindowMs: null,
    incidentReconcileIntervalMs: null,
    unavailableAttempts: DEFAULT_UNAVAILABLE_ATTEMPTS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index] as string;
    const next = (): string => {
      index += 1;
      const supplied = argv[index];
      if (supplied === undefined) {
        throw new ContractViolation(`${option} needs a value`);
      }
      return supplied;
    };
    switch (option) {
      case "--role":
        parsed.role = next();
        break;
      case "--db":
        parsed.db = next();
        break;
      case "--case-id":
        parsed.caseId = next();
        break;
      case "--suite-seed":
        parsed.suiteSeed = requireInteger(option, next());
        break;
      case "--armed":
        parsed.armed = next();
        break;
      case "--clock-base-ms":
        parsed.clockBaseMs = requireInteger(option, next());
        break;
      case "--clock-offset-ms":
        parsed.clockOffsetMs = requireInteger(option, next());
        break;
      case "--restart-generation":
        parsed.restartGeneration = requireInteger(option, next());
        break;
      case "--control-fd":
        parsed.controlFd = requireInteger(option, next());
        break;
      case "--event-fd":
        parsed.eventFd = requireInteger(option, next());
        break;
      case "--resource":
        parsed.resource = next();
        break;
      case "--holder":
        parsed.holder = next();
        break;
      case "--run-id":
        parsed.runId = next();
        break;
      case "--workdir":
        parsed.workdir = next();
        break;
      case "--ttl-ms":
        parsed.ttlMs = requireInteger(option, next());
        break;
      case "--messages":
        parsed.messages = requireInteger(option, next());
        break;
      case "--manifest-version":
        parsed.manifestVersion = requireInteger(option, next());
        break;
      case "--behaviour": {
        const behaviour = next();
        if (!(BEHAVIOURS as readonly string[]).includes(behaviour)) {
          throw new ContractViolation(
            `${JSON.stringify(behaviour)} is not a driver behaviour; the driver implements ` +
              `${JSON.stringify([...BEHAVIOURS])}`,
          );
        }
        parsed.behaviour.push(behaviour);
        break;
      }
      case "--observation-mode": {
        const mode = next();
        if (!(contract.OBSERVATION_MODES as readonly string[]).includes(mode)) {
          throw new ContractViolation(`${JSON.stringify(mode)} is not an observation mode`);
        }
        parsed.observationMode = mode;
        break;
      }
      case "--escalate-on": {
        const factState = next();
        if (!(contract.FACT_STATES as readonly string[]).includes(factState)) {
          throw new ContractViolation(`${JSON.stringify(factState)} is not a fact state`);
        }
        parsed.escalateOn.push(factState);
        break;
      }
      case "--incident-dedup-key":
        parsed.incidentDedupKey = next();
        break;
      case "--incident-repeats":
        parsed.incidentRepeats = requireInteger(option, next());
        break;
      case "--incident-collapse": {
        const rule = next();
        if (!(COLLAPSE_RULES as readonly string[]).includes(rule)) {
          throw new ContractViolation(`${JSON.stringify(rule)} is not a collapse rule`);
        }
        parsed.incidentCollapse = rule;
        break;
      }
      case "--incident-renotify-window-ms":
        parsed.incidentRenotifyWindowMs = requireInteger(option, next());
        break;
      case "--incident-reconcile-interval-ms":
        parsed.incidentReconcileIntervalMs = requireInteger(option, next());
        break;
      case "--unavailable-attempts":
        parsed.unavailableAttempts = requireInteger(option, next());
        break;
      default:
        throw new ContractViolation(`unknown option ${JSON.stringify(option)}`);
    }
  }
  if (!(contract.ROLES as readonly string[]).includes(parsed.role)) {
    throw new ContractViolation(`--role must be one of ${JSON.stringify([...contract.ROLES])}`);
  }
  return parsed;
}

export function main(argv: readonly string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(helpText());
    return 0;
  }
  const parsed = parseArguments(argv);

  // Nothing but the protocol may reach the event pipe. A stray write to stdout
  // from any imported module would otherwise corrupt the stream. The source
  // dups stderr over fd 1 for the rest of the process; here the events are
  // written to the event fd directly with `writeSync`, and nothing in this
  // module writes to stdout by any other route.
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
    adapter: SPIKE_ADAPTER.name,
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

  const ctx = new Context({
    role: parsed.role,
    resource: parsed.resource,
    holder: parsed.holder,
    runId: parsed.runId,
    dbPath: parsed.db,
    workdir: parsed.workdir,
    caseId: parsed.caseId,
    suiteSeed: parsed.suiteSeed,
    manifestVersion: parsed.manifestVersion,
    ttlMs: parsed.ttlMs,
    messages: parsed.messages,
    behaviours: parsed.behaviour,
    restartGeneration: parsed.restartGeneration,
    clock,
    barrier,
    emit,
    observationMode: parsed.observationMode,
    escalateOn: parsed.escalateOn,
    incidentDedupKey: parsed.incidentDedupKey,
    incidentRepeats: parsed.incidentRepeats,
    incidentCollapse: parsed.incidentCollapse,
    incidentRenotifyWindowMs: parsed.incidentRenotifyWindowMs,
    incidentReconcileIntervalMs: parsed.incidentReconcileIntervalMs,
    unavailableAttempts: parsed.unavailableAttempts,
  });
  // The seam is prepared before the script runs and only in the first
  // generation: a restart must find the world as its predecessor left it, not a
  // freshly repaired observation path.
  if (parsed.restartGeneration === 0) {
    writeObservation(parsed.workdir, parsed.role, { mode: parsed.observationMode });
  }
  ctx.connection = openOrCreate(ctx);
  try {
    runScript(ctx);
    emit({ event: EVENT_DONE, now_ms: clock.nowMs() });
    return 0;
  } catch (error) {
    // The driver reports, never hides.
    emit({ event: EVENT_ERROR, type: (error as Error)?.constructor?.name ?? "Error" });
    process.stderr.write(`${String((error as Error)?.stack ?? error)}\n`);
    return 1;
  } finally {
    try {
      ctx.connection.close();
    } catch {
      // Closing a dead connection.
    }
  }
}

/** `json.dumps(..., sort_keys=True)`, so the event stream is byte-stable. */
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

// The process entrypoint. Guarded so importing this module for `SPIKE_ADAPTER`
// -- which every test file does -- does not run a role script.
if (process.argv[1] === DRIVER_SOURCE_PATH) {
  process.exitCode = main(process.argv.slice(2));
}
