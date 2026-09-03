/**
 * Step 4 of `docs/design/minimal-operating-loop.md`: the endpoint's lease, held
 * and renewed by its launcher for as long as the endpoint runs.
 *
 * ## What was missing, and why it read as nothing being wrong
 *
 * Section 4.9 settles the shape and rules out the two shortcuts that would have
 * made this module unnecessary -- a TTL longer than the lap, which is not a
 * property when the wait is unbounded, and an endpoint scoped to a worker turn,
 * which is a smaller window rather than a bounded one. What it leaves is one
 * sentence of construction: *"whatever process launches the endpoint holds its
 * lease and renews it on a timer for as long as the endpoint runs"*. Until this
 * module, **nothing under `src/` called `renew`, and nothing acquired
 * `outbox-delivery` at all** -- so on a real lap there was no lease row for the
 * resource the worker's `mcp.json` names, `--endpoint-epoch` was a number an
 * operator typed that pointed at nothing, and every fenced write the endpoint
 * attempted would have been refused as a stale writer. It looked like it worked
 * only because lap 1 never delivers through the endpoint (`D-0064`).
 *
 * ## The two rules a tick obeys, and why each is a rule rather than a habit
 *
 * - **A tick never throws.** It runs on a timer, which is outside every `try`
 *   and every `await` in `performLap`. A throw there would bypass
 *   `isOperatorRefusal` in `lap/cli.ts`, bypass the teardown that stops the
 *   worker, leave a fenced child running with nobody polling it, and exit 1
 *   with a stack trace where every other refusal in this CLI is one line and
 *   exit 2. So a failed renewal **latches** ({@link HeldDeliveryLease.failure})
 *   and the lap reads it at a point where it can act on it.
 * - **A tick never re-acquires.** `renew` refuses an expired lease
 *   (`LeaseNotHeld`) precisely so that a returning holder has to re-acquire,
 *   and re-acquiring raises the epoch (`control_plane/lease.ts`). But the epoch
 *   is already rendered into the running worker's `mcp.json` and fixed in the
 *   endpoint's environment at startup, so a re-acquisition here would mint a
 *   token the endpoint can never be told about -- turning a lease this process
 *   *could* still recover into an endpoint durably fenced out of its own
 *   outbox. `renew` also cannot tell "expired while I stalled" from "taken
 *   over": both are `LeaseNotHeld`, and the answer is the same either way, so
 *   this module does not branch on it.
 *
 * ## Safety does not rest on the timer
 *
 * The timer is about avoiding *spurious* refusals and about legibility, not
 * about exclusion. Every fenced write re-evaluates the lease against a live
 * clock inside the write itself (`FENCE_SQL`), so a lapsed lease can never
 * admit a write however late a renewal is. That is why a late tick costs a
 * refusal and never a wrong write.
 *
 * ## ASCII only, for `docs/cli-output-policy.md`'s reason
 *
 * The refusal messages here reach an operator's console through `lap/cli.ts`.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { acquire, type Lease, release, renew } from "../control_plane/lease.js";
import { pythonRepr } from "../control_plane/python_repr.js";
import { ControlPlaneRefusal } from "../control_plane/refusals.js";
// The one delivery lease resource lap 1 admits, imported rather than respelled
// so this module and the `mcp.json` the materialiser renders cannot drift.
// Side-effect free: `endpoint.ts` guards its process entry point, and
// `workspace/materializer.ts` already imports the same constant from it.
import { DELIVERY_LEASE_RESOURCE } from "../messagebus/endpoint.js";

/**
 * The endpoint's lease was lost, and the worker's endpoint can no longer write.
 *
 * In the {@link ControlPlaneRefusal} family, so `lap/cli.ts` reports it as one
 * stderr line and exit 2 alongside every other refusal a lap can meet -- and
 * declared here rather than reusing `LapRefused` so that this module imports
 * nothing from `root.ts`, which imports it. The lease refusal underneath is on
 * `cause`, so a caller that wants to tell an expiry from a takeover still can
 * (the message differs; the type does not).
 */
export class EndpointLeaseLost extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "EndpointLeaseLost";
    // The family's convention: extending a built-in under a downlevel emit
    // target loses the prototype chain, and `instanceof` then silently reports
    // false. See `control_plane/refusals.ts`.
    Object.setPrototypeOf(this, EndpointLeaseLost.prototype);
  }
}

/**
 * How long the endpoint's lease is taken and re-taken for.
 *
 * **Chosen against {@link DELIVERY_LEASE_RENEWAL_INTERVAL_MS}, never against
 * the lap's duration** -- which is the distinction section 4.9 was written to
 * make. Four renewal intervals fit inside one TTL, so three consecutive ticks
 * can be missed and the lease still stands.
 *
 * Sixty seconds rather than the orchestrator's thirty because the acquisition
 * happens *before* `materializeWorkspace`, and materialisation runs git through
 * `spawnSync`: the event loop is blocked for the whole of it, so no tick can
 * fire during a `git worktree add`. Sixty seconds does not cover the worst case
 * that permits -- `git.ts`'s per-command bound alone defaults to two minutes --
 * and is not meant to. What covers it is the synchronous renewal `performLap`
 * performs the instant materialisation returns, which turns "the lease lapsed
 * while git ran" into a refusal **before any child exists** rather than into a
 * worker whose endpoint can never write.
 *
 * **Not a flag**, deliberately. A TTL knob is an invitation to answer an
 * expired lease by making the number bigger, which is the first of the two
 * answers section 4.9 records as wrong.
 */
export const DELIVERY_LEASE_TTL_MS = 60_000;

/** Milliseconds between renewals: a quarter of {@link DELIVERY_LEASE_TTL_MS}. */
export const DELIVERY_LEASE_RENEWAL_INTERVAL_MS = 15_000;

/**
 * How soon a tick that found the connection mid-transaction tries again.
 *
 * Short, because it is a deferral rather than a period: the transaction it
 * stepped around is a write the orchestrator is in the middle of, not a state
 * that lasts.
 */
const BUSY_RETRY_MS = 250;

/**
 * The timer and the clock, injectable so a case does not spend wall-clock.
 *
 * The same convention and the same reason as `TurnCompletion`'s `sleep`
 * and `elapsedMs`: a per-request record rather than a mutable module seam, so
 * two cases running concurrently cannot see each other's substitution.
 */
export interface DeliveryLeaseTimers {
  /**
   * Schedule `fn` after `ms`, and answer with the canceller.
   *
   * A canceller rather than a handle, so this interface carries no timer type
   * and a case can substitute a plain recorder. The default is a **self-
   * rearming `setTimeout`**, not `setInterval`: ticks cannot pile up behind a
   * blocked event loop, and the busy-connection retry above is expressible as
   * "re-arm sooner" rather than as a whole period lost.
   *
   * Not `unref`-ed, matching `session/runtime.ts`'s reasoning about its own
   * timers. Correctness comes from {@link HeldDeliveryLease.stop} running on
   * every path, not from the timer being invisible to the event loop -- and an
   * unref'd timer here would let the process exit between two renewals with the
   * endpoint still running.
   */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /** Milliseconds between renewals. Tests only; production uses the constant. */
  readonly intervalMs?: number;
  /** The lease's TTL. Tests only; production uses the constant. */
  readonly ttlMs?: number;
}

const DEFAULT_SCHEDULE = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  return () => {
    clearTimeout(handle);
  };
};

/**
 * Take the one delivery lease and keep it alive, or refuse.
 *
 * A thin, deliberate wrapper over {@link acquire}, for the reason
 * `run_lifecycle.ts`'s `acquireRunLease` gives about its own: the acquire side
 * cannot name the resource itself. It goes further than that one, because it is
 * also the only place the TTL is spelled -- `renew` sets the expiry
 * **absolutely** rather than extending it, so a renewal carrying a different
 * TTL from the acquisition would silently shorten the lease at every tick. One
 * function, one number, no way to disagree with itself.
 *
 * The returned holder is **already armed**. There is no `start()` to forget:
 * an acquisition whose renewal was never armed is the failure this module
 * exists to remove, and it would be invisible for exactly one TTL.
 *
 * @throws {import("../control_plane/lease.js").LeaseHeld} the delivery lease
 *   has a live holder. `outbox-delivery` is one global resource (`D-0053` rule
 *   4), so this is also what refuses a second concurrent lap -- before anything
 *   irreversible, which is why the acquisition is early.
 */
export function holdDeliveryLease(
  connection: SqliteDatabase,
  options: {
    /** The lease claimant. The admitted run's, so the endpoint writes as it. */
    readonly holder: string;
    /** The lap's live wall clock, read at the acquisition and at every tick. */
    readonly nowMs: () => number;
  } & DeliveryLeaseTimers,
): HeldDeliveryLease {
  const ttlMs = options.ttlMs ?? DELIVERY_LEASE_TTL_MS;
  const lease = acquire(connection, {
    resource: DELIVERY_LEASE_RESOURCE,
    holder: options.holder,
    nowMs: options.nowMs(),
    ttlMs,
  });
  return new HeldDeliveryLease(connection, lease, {
    nowMs: options.nowMs,
    ttlMs,
    intervalMs: options.intervalMs ?? DELIVERY_LEASE_RENEWAL_INTERVAL_MS,
    schedule: options.schedule ?? DEFAULT_SCHEDULE,
  });
}

/**
 * One delivery lease, held for the endpoint's whole life.
 *
 * Constructed by {@link holdDeliveryLease} and by nothing else: the constructor
 * is reachable so a case can hand in a lease it took itself, and every
 * production path goes through the factory so that the TTL cannot be spelled
 * twice.
 */
export class HeldDeliveryLease {
  readonly #connection: SqliteDatabase;
  readonly #nowMs: () => number;
  readonly #ttlMs: number;
  readonly #intervalMs: number;
  readonly #schedule: (fn: () => void, ms: number) => () => void;

  /** The live token. Replaced by each renewal, which keeps its epoch. */
  #lease: Lease;
  /** The canceller for the armed tick, or `null` when nothing is armed. */
  #cancel: (() => void) | null = null;
  /** The renewal failure that latched, or `null`. See the module docstring. */
  #failure: Error | null = null;
  /** Whether {@link stop} has run. Idempotent, and it disarms permanently. */
  #stopped = false;

  constructor(
    connection: SqliteDatabase,
    lease: Lease,
    options: {
      readonly nowMs: () => number;
      readonly ttlMs: number;
      readonly intervalMs: number;
      readonly schedule: (fn: () => void, ms: number) => () => void;
    },
  ) {
    this.#connection = connection;
    this.#lease = lease;
    this.#nowMs = options.nowMs;
    this.#ttlMs = options.ttlMs;
    this.#intervalMs = options.intervalMs;
    this.#schedule = options.schedule;
    this.#arm(this.#intervalMs);
  }

  /**
   * The epoch the endpoint's `INTERLOCK_MESSAGEBUS_EPOCH` is rendered with.
   *
   * Taken from the acquisition and never re-read from the row, for the reason
   * `D-0068` gives about the session lease: a number read back later answers a
   * different question, because by then the row may belong to somebody else.
   * A renewal keeps the epoch, so this stays true for the lease's whole life.
   */
  get epoch(): number {
    return this.#lease.epoch;
  }

  /** The renewal failure that latched, or `null` while the lease is held. */
  get failure(): Error | null {
    return this.#failure;
  }

  /**
   * One renewal attempt. **Never throws**, for the reason the module docstring
   * gives, and never re-acquires, for the reason it gives too.
   *
   * Callable by hand as well as by the timer: `performLap` ticks once by hand
   * the instant `materializeWorkspace` returns, because materialisation is
   * synchronous and no timer could have fired during it.
   */
  tick(): void {
    if (this.#stopped || this.#failure !== null) {
      return;
    }
    if (this.#connection.inTransaction) {
      // **Stepped around rather than attempted.** `withImmediate` refuses a
      // connection that is already in a transaction, and the orchestrator
      // genuinely holds a `BEGIN IMMEDIATE` across an `await provider.stop()`,
      // so this window is reachable on an ordinary loser path. Attempting
      // anyway would latch a `LeaseUsageError` -- a defect-shaped exception --
      // over a lease that is perfectly healthy.
      //
      // Deliberately NOT solved with a second connection: that trades a
      // bounded local deferral for cross-connection `SQLITE_BUSY` against the
      // very transaction being stepped around, and buys nothing, because the
      // fence is re-evaluated inside every write regardless.
      this.#arm(BUSY_RETRY_MS);
      return;
    }
    try {
      this.#lease = renew(this.#connection, this.#lease, {
        nowMs: this.#nowMs(),
        ttlMs: this.#ttlMs,
      });
    } catch (error) {
      // Latched and disarmed. Everything reachable here is an `Error`; the
      // normalisation is for the type rather than for a case anyone has seen.
      this.#failure = error instanceof Error ? error : new Error(String(error));
      this.#disarm();
      return;
    }
    this.#arm(this.#intervalMs);
  }

  /**
   * Refuse if a renewal has latched, in the operator-facing family.
   *
   * {@link EndpointLeaseLost} rather than the lease refusal itself, because the
   * message an operator needs is not "renew was refused" but *which* lease was
   * lost and what it was for. The original is on `cause`, so a caller that
   * wants to discriminate still can.
   *
   * @throws {EndpointLeaseLost}
   */
  requireHeld(): void {
    if (this.#failure === null) {
      return;
    }
    throw new EndpointLeaseLost(
      `the endpoint delivery lease ${pythonRepr(DELIVERY_LEASE_RESOURCE)} is no longer held ` +
        `by ${pythonRepr(this.#lease.holder)} at epoch ${this.#lease.epoch}, so the worker's ` +
        `endpoint could not write under the epoch its configuration was rendered with: ` +
        this.#failure.message,
      { cause: this.#failure },
    );
  }

  /**
   * Disarm the timer and give the lease up. Idempotent, and **never throws**.
   *
   * Releasing rather than letting it expire, because `outbox-delivery` is one
   * global resource: a lease abandoned at the end of a lap withholds it from
   * the next lap for a whole TTL, for no benefit. `release` only ever shortens
   * and is a legal no-op on an already-expired row.
   *
   * The refusal is swallowed for the reason `stopSession` swallows its own:
   * this runs in a `finally`, and an exception thrown from there would
   * **replace** whatever the lap was returning or throwing. A teardown that
   * reported itself instead of the gate that was just opened is the one way
   * this call could do real harm. `release` refuses with `LeaseNotHeld` exactly
   * when somebody else now holds the row, which is a state a teardown meets and
   * has nothing to do about.
   */
  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#disarm();
    try {
      release(this.#connection, this.#lease, { nowMs: this.#nowMs() });
    } catch {
      // Deliberately empty. See above.
    }
  }

  /**
   * Stop renewing and **leave the lease standing**. Idempotent, never throws.
   *
   * For the one state in which giving the lease back would be an act against a
   * process that is no longer this lap's to act on: `performLap`'s teardown can
   * decide it must NOT stop the worker, because a takeover writer may have
   * adopted the child -- and that child's endpoint is still writing under this
   * lease. A release there would fence it out immediately, which is the same
   * harm the teardown stood down from doing with a signal, reached by a
   * different road.
   *
   * The lease is left to expire on its own instead. That costs the next lap at
   * most one TTL on a global resource, and it is the safe direction: the
   * adopted endpoint keeps working for the rest of the window it was already
   * going to have, and nothing this lap does shortens it.
   *
   * After this, {@link stop} is a no-op -- which is what lets `performLap`'s
   * outer `finally` stay unconditional.
   */
  abandon(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#disarm();
  }

  #arm(ms: number): void {
    if (this.#stopped) {
      return;
    }
    this.#disarm();
    this.#cancel = this.#schedule(() => {
      this.#cancel = null;
      this.tick();
    }, ms);
  }

  #disarm(): void {
    const cancel = this.#cancel;
    this.#cancel = null;
    if (cancel !== null) {
      cancel();
    }
  }
}
