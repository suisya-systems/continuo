import type { Database as SqliteDatabase } from "better-sqlite3";
import { expect } from "vitest";

import { acquire, type Lease } from "../../src/control_plane/lease.js";
import { createControlPlane, openControlPlane } from "../../src/control_plane/schema.js";
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
} from "../../src/session/provider.js";
import { SessionOrchestrator, type SessionOrchestratorOptions } from "../../src/supervisor.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";

/**
 * Fixtures for the mediated crash-window proof: a scripted S1 provider.
 *
 * Ported from interlock `tests/gate_item2/conftest.py` at `65f36c5`.
 *
 * The provider here is deliberately *adversarial in the U27/U32 direction*: it
 * refuses nothing. A second start on a claimed id is admitted, a second
 * resume is admitted, and no call ever excludes another -- exactly the
 * surface the real C2 provider measures out (the "already in use" refusal is
 * not atomic inside the admission window, and `--resume` excludes nothing at
 * all). Every case in this belt therefore passes with the provider's own
 * refusal assumed absent, which is what the issue requires: the exclusion
 * under test is Interlock's, not the provider's.
 */

export const T0 = 1_000_000;
export const TTL_MS = 30_000;
export const RUN_ID = "run-1";
export const RESOURCE = `session-run:${RUN_ID}`;
const DATABASE_NAME = "control-plane.sqlite3";

/**
 * The caller's clock, advanced one millisecond per observation.
 *
 * The auto-advance keeps every fenced write's idempotency key distinct
 * without any test importing a measured duration -- no U27/U34 figure is
 * ever a constant here.
 */
export class Clock {
  #t: number;

  constructor(start: number = T0) {
    this.#t = start;
  }

  nowMs = (): number => {
    this.#t += 1;
    return this.#t;
  };

  advancePastExpiry(ttlMs: number = TTL_MS): void {
    this.#t += ttlMs + 1;
  }
}

export function observed(sessionId: string, state: string = "running"): SessionReadout {
  return new SessionReadout({ sessionId, observation: Observation.OBSERVED, providerState: state });
}

export function unconfirmed(
  sessionId: string,
  reason: string = "no event has named an identity yet",
): SessionReadout {
  return new SessionReadout({
    sessionId,
    observation: Observation.COULD_NOT_OBSERVE,
    couldNotObserveReason: reason,
  });
}

class ScriptedSession {
  readonly sessionId: string;
  /** Readouts served by successive `readState` calls; the last one repeats. */
  readouts: SessionReadout[];
  live: boolean;

  constructor(sessionId: string, readouts: readonly SessionReadout[] = [], live = true) {
    this.sessionId = sessionId;
    this.readouts = [...readouts];
    this.live = live;
  }
}

/** An S1 provider that records everything and refuses nothing. */
export class ScriptedProvider extends SessionProvider {
  readonly sessions = new Map<string, ScriptedSession>();
  readonly startCalls: StartRequest[] = [];
  readonly resumeCalls: string[] = [];
  readonly stopCalls: string[] = [];
  /**
   * Called (with the request) before a start is admitted; may return a
   * `ProviderResult` to override, or `undefined` to proceed. This is the
   * seam a test uses to advance the world *inside* the critical section.
   */
  onStart: ((request: StartRequest) => ProviderResult<SessionReadout> | undefined) | undefined;
  onResume: ((sessionId: string) => ProviderResult<SessionReadout> | undefined) | undefined;
  /** Readouts to serve for the *next* started/resumed session. */
  nextReadouts: SessionReadout[] = [];

  probeCapabilities(): ProviderResult<CapabilityReport> {
    return new Ok(
      new CapabilityReport({
        providerVersion: "scripted 1.0",
        supported: new Set(REQUIRED_CAPABILITIES),
        detail: "in-memory scripted provider; refuses nothing (U27/U32)",
      }),
    );
  }

  protected async _startSession(request: StartRequest): Promise<ProviderResult<SessionReadout>> {
    this.startCalls.push(request);
    if (this.onStart !== undefined) {
      const override = this.onStart(request);
      if (override !== undefined) {
        return override;
      }
    }
    // Deliberately no "already exists" refusal: U27's admission window means
    // the real provider admits this shape too.
    const session = new ScriptedSession(request.sessionId, this.nextReadouts);
    this.nextReadouts = [];
    this.sessions.set(request.sessionId, session);
    return new Ok(unconfirmed(request.sessionId, "child spawned; nothing parseable yet"));
  }

  async listSessions(): Promise<ProviderResult<readonly SessionReadout[]>> {
    return new Ok(Array.from(this.sessions.values(), (session) => this.#readout(session)));
  }

  async readState(sessionId: string): Promise<ProviderResult<SessionReadout>> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return new Failure(
        FailureKind.UNKNOWN_SESSION,
        `no session ${JSON.stringify(sessionId)} on record`,
      );
    }
    return new Ok(this.#readout(session));
  }

  async stop(sessionId: string): Promise<ProviderResult<SessionReadout>> {
    this.stopCalls.push(sessionId);
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return new Failure(
        FailureKind.UNKNOWN_SESSION,
        `no session ${JSON.stringify(sessionId)} on record`,
      );
    }
    session.live = false;
    session.readouts = [observed(sessionId, "exited-137")];
    return new Ok(observed(sessionId, "exited-137"));
  }

  async resume(sessionId: string): Promise<ProviderResult<SessionReadout>> {
    this.resumeCalls.push(sessionId);
    if (this.onResume !== undefined) {
      const override = this.onResume(sessionId);
      if (override !== undefined) {
        return override;
      }
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      // Deliberately no exclusion and no existence check beyond the record
      // (U32: --resume refuses nothing) -- but a resume of a session this
      // provider has no record of at all cannot invent one.
      return new Failure(
        FailureKind.UNKNOWN_SESSION,
        `no session ${JSON.stringify(sessionId)} on record`,
      );
    }
    session.live = true;
    session.readouts = this.nextReadouts.length > 0 ? [...this.nextReadouts] : session.readouts;
    this.nextReadouts = [];
    return new Ok(unconfirmed(sessionId, "resumed; nothing parseable yet"));
  }

  #readout(session: ScriptedSession): SessionReadout {
    if (session.readouts.length > 0) {
      const head = session.readouts[0] as SessionReadout;
      if (session.readouts.length > 1) {
        session.readouts.shift();
      }
      return head;
    }
    return observed(session.sessionId);
  }

  /** A session the provider already knows (a prior life's record). */
  plant(sessionId: string, readouts: readonly SessionReadout[] = [], live = true): void {
    this.sessions.set(sessionId, new ScriptedSession(sessionId, readouts, live));
  }
}

// --------------------------------------------------------------------------
// the control-plane fixture
// --------------------------------------------------------------------------

const spikeTemplate = suiteTemplate(DATABASE_NAME, (path) => {
  createControlPlane(path).close();
});

/** A fresh control-plane database with `run-1` seeded, per case. */
export function makeControlPlane(): SqliteDatabase {
  const dbPath = spikeTemplate.copyInto(caseRoot("gate-item2"), DATABASE_NAME);
  const connection = openControlPlane(dbPath);
  connection
    .prepare(
      "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'running', ?, ?)",
    )
    .run(RUN_ID, T0, T0);
  return connection;
}

export function makeUuids(): () => string {
  let counter = 1;
  return () => {
    const id = String(counter).padStart(12, "0");
    counter += 1;
    return `00000000-0000-4000-8000-${id}`;
  };
}

export function makeOrchestrator(
  cp: SqliteDatabase,
  clock: Clock,
  provider: SessionProvider,
  uuids: () => string,
  workspace: string,
  holder = "sup-a",
  overrides: Partial<SessionOrchestratorOptions> = {},
): SessionOrchestrator {
  return new SessionOrchestrator(cp, provider, {
    runId: RUN_ID,
    holder,
    workspace,
    role: "worker",
    nowMs: clock.nowMs,
    sessionUuidFactory: uuids,
    ttlMs: TTL_MS,
    readbackAttempts: 3,
    wait: null, // the scripted provider answers synchronously
    providerName: "scripted",
    ...overrides,
  });
}

/** Another claimant takes the lease after expiry, raising the epoch. */
export function takeOver(
  cp: SqliteDatabase,
  clock: Clock,
  holder = "sup-b",
  resource: string = RESOURCE,
): Lease {
  clock.advancePastExpiry();
  return acquire(cp, { resource, holder, nowMs: clock.nowMs(), ttlMs: TTL_MS });
}

export function refusals(cp: SqliteDatabase): Record<string, unknown>[] {
  return cp
    .prepare(
      "SELECT action_id, kind, refusal_reason, writer_epoch FROM action" +
        " WHERE status = 'refused' ORDER BY rowid",
    )
    .all() as Record<string, unknown>[];
}

export function activeRows(cp: SqliteDatabase): [string, string, string][] {
  return cp
    .prepare(
      "SELECT session_id, binding_phase, observation FROM session WHERE released_at_ms IS NULL",
    )
    .all()
    .map((row) => {
      const r = row as { session_id: string; binding_phase: string; observation: string };
      return [r.session_id, r.binding_phase, r.observation] as [string, string, string];
    });
}

/**
 * `pytest.raises(SomeError, match="...")` for an `async` action.
 *
 * `test/testkit/errors.ts`'s `expectRefusal` is synchronous throughout
 * (`action: () => unknown`), which fits every belt ported before this one --
 * D-0801 is the first place continuo drives an orchestration whose refusals
 * arrive as rejected promises rather than synchronous throws (the five
 * `SessionProvider` verbs are `Promise`-returning since D-0301, so
 * `SessionOrchestrator.start()`/`recover()` are `async` all the way through).
 * This is the async twin, kept local to this belt's own helpers rather than
 * added to the shared `testkit/errors.ts` while other belts are mid-flight
 * against it.
 */
export async function expectAsyncRefusal<T extends Error>(
  action: () => Promise<unknown>,
  type: new (...args: never[]) => T,
  match?: RegExp | string,
): Promise<T> {
  let thrown: unknown;
  let threw = false;
  try {
    await action();
  } catch (error) {
    threw = true;
    thrown = error;
  }
  expect(threw, `expected ${type.name} to be thrown, but nothing was thrown`).toBe(true);
  expect(thrown, `expected ${type.name}, got ${describeThrown(thrown)}`).toBeInstanceOf(type);
  if (match !== undefined) {
    const pattern = typeof match === "string" ? new RegExp(escapeRegExp(match)) : match;
    expect(String((thrown as Error).message)).toMatch(pattern);
  }
  return thrown as T;
}

function describeThrown(value: unknown): string {
  if (value instanceof Error) {
    return `${value.constructor.name}(${JSON.stringify(value.message)})`;
  }
  return JSON.stringify(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
