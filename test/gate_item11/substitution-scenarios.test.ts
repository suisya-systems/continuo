import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { expect, onTestFinished, test } from "vitest";

import { KeyedDropbox } from "../../src/control_plane/destination.js";
import { NOTIFY_RECIPIENT, spikeRegistry } from "../../src/control_plane/handlers.js";
import {
  acquire,
  effectKind,
  type Lease,
  StaleWriterRefused,
  writeHistory,
} from "../../src/control_plane/lease.js";
import { Outbox } from "../../src/control_plane/outbox.js";
import { createControlPlane, reconstruct } from "../../src/control_plane/schema.js";
import { Observation, type SessionProvider, StartRequest } from "../../src/session/provider.js";
import { caseRoot } from "../testkit/cases.js";
import { skipIf } from "../testkit/marks.js";
import { PROVIDERS, type ProviderEntry } from "./registry.js";
import { BIND_EFFECT, bindSession, releaseSession, unwrap } from "./substitution.js";

/**
 * The control plane doing its job with a provider actually in the loop.
 *
 * Ported from interlock `tests/gate_item11/test_substitution_scenarios.py` at
 * `65f36c5`.
 *
 * `no-provider-detail-leaks.test.ts` proves the suite does not *need* a
 * provider. This file drives the other direction: real sessions started by a
 * real provider, their readouts bound into the schema through
 * `./substitution.ts`, and the lease and outbox run over the result.
 *
 * Parameterised over `registry.PROVIDERS`, so each case is re-measured
 * against every provider that ships -- the same one-line cost when a new
 * provider lands. `[S3]` always runs; `[S2]` is skipped wherever the real
 * `claude` CLI is not on `PATH` (the registry's own `unavailable()`), the same
 * gate the source's `entry` fixture applies with `pytest.skip(reason)`.
 * `vitest list` omits a `skipIf`-gated case entirely where pytest still
 * collects a skipped node id, so each `[S2]` case is `conditionally_collected`
 * in `parity/gate_item11.substitution-scenarios.ledger.json`.
 */

const S2 = PROVIDERS.S2 as ProviderEntry;
const S3 = PROVIDERS.S3 as ProviderEntry;
const S2_UNAVAILABLE = S2.unavailable();

const T0 = 1_700_000_000_000;
const TTL_MS = 30_000;
const RUN_ID = "run-1";
const RESOURCE = "sessions-of-run-1";
const HOLDER = "item11-writer";

/** Long enough that a read straight after the spawn always lands before the child reports. */
const NEVER_ANNOUNCES = 3600;

interface Scenario {
  readonly cp: SqliteDatabase;
  readonly lease: Lease;
  readonly provider: SessionProvider;
  readonly root: string;
}

async function scenario(entry: ProviderEntry): Promise<Scenario> {
  const root = caseRoot("gate-item11-substitution");
  const cp = createControlPlane(join(root, "control-plane.sqlite3"));
  onTestFinished(() => {
    cp.close();
  });
  cp.prepare(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'running', ?, ?)",
  ).run(RUN_ID, T0, T0);
  const lease = acquire(cp, { resource: RESOURCE, holder: HOLDER, nowMs: T0, ttlMs: TTL_MS });

  const provider = entry.factory(join(root, "state"));
  provider.requireSpawnable();
  onTestFinished(async () => {
    for (const readout of unwrap(await provider.listSessions(), "list_sessions")) {
      await provider.stop(readout.sessionId);
    }
  });

  return { cp, lease, provider, root };
}

async function start(
  provider: SessionProvider,
  root: string,
  sessionId: string,
  settings: Readonly<Record<string, unknown>> = {},
) {
  const workspace = join(root, "workspaces", sessionId);
  const request = new StartRequest({ sessionId, workspace, role: "worker", settings });
  return unwrap(await provider.start(request), `start(${sessionId})`);
}

async function waitUntilObserved(provider: SessionProvider, sessionId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let readout = unwrap(await provider.readState(sessionId), `read_state(${sessionId})`);
  while (readout.observation === Observation.COULD_NOT_OBSERVE) {
    expect(Date.now() < deadline, `child never reported: ${String(readout)}`).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    readout = unwrap(await provider.readState(sessionId), `read_state(${sessionId})`);
  }
  return readout;
}

// --------------------------------------------------------------------------
// a provider readout becomes the binding item 2 reads
// --------------------------------------------------------------------------

async function aProviderReadoutBecomesTheBindingItem2Reads(entry: ProviderEntry): Promise<void> {
  // Start a session, bind it, and read it back by query alone (D-0001). The
  // state word in the row is the child's own, uninterpreted.
  const { cp, lease, provider, root } = await scenario(entry);
  await start(provider, root, "sess-1");
  const readout = await waitUntilObserved(provider, "sess-1");
  bindSession(cp, lease, readout, { runId: RUN_ID, provider: entry.id, nowMs: T0 });

  const state = reconstruct(cp, T0);
  expect(state.activeSessions.map((row) => row.session_id)).toEqual(["sess-1"]);
  const bound = state.activeSessions[0] as Record<string, unknown>;
  expect(bound.run_id).toBe(RUN_ID);
  expect(bound.provider).toBe(entry.id);
  expect(bound.observation).toBe("observed");
  expect(bound.provider_state).toBe(readout.providerState);
}

skipIf(S2_UNAVAILABLE !== null, S2_UNAVAILABLE ?? "")(
  "a provider readout becomes the binding item 2 reads[S2]",
  async () => {
    await aProviderReadoutBecomesTheBindingItem2Reads(S2);
  },
);
test("a provider readout becomes the binding item 2 reads[S3]", async () => {
  await aProviderReadoutBecomesTheBindingItem2Reads(S3);
});

// --------------------------------------------------------------------------
// a session that cannot be observed binds as itself and not as nothing
// --------------------------------------------------------------------------

async function aSessionThatCannotBeObservedBindsAsItself(entry: ProviderEntry): Promise<void> {
  // R4, end to end: could-not-observe reaches the database with its reason.
  const { cp, lease, provider, root } = await scenario(entry);
  const readout = await start(provider, root, "sess-quiet", { announce_after: NEVER_ANNOUNCES });
  expect(readout.observation).toBe(Observation.COULD_NOT_OBSERVE);

  bindSession(cp, lease, readout, { runId: RUN_ID, provider: entry.id, nowMs: T0 });

  const bound = reconstruct(cp, T0).activeSessions[0] as Record<string, unknown>;
  expect(bound.observation).toBe("unobserved");
  expect(bound.provider_state).toBeNull();
  expect(bound.observation_reason).toBe(readout.couldNotObserveReason);
  expect((bound.observation_reason as string).trim()).not.toBe("");
}

skipIf(S2_UNAVAILABLE !== null, S2_UNAVAILABLE ?? "")(
  "a session that cannot be observed binds as itself and not as nothing[S2]",
  async () => {
    await aSessionThatCannotBeObservedBindsAsItself(S2);
  },
);
test("a session that cannot be observed binds as itself and not as nothing[S3]", async () => {
  await aSessionThatCannotBeObservedBindsAsItself(S3);
});

// --------------------------------------------------------------------------
// the second live session is refused by us and not by the provider
// --------------------------------------------------------------------------

async function theSecondLiveSessionIsRefusedByUs(entry: ProviderEntry): Promise<void> {
  // The exclusion is ours (D-0024, U27, U32): the provider starts the second
  // child without complaint, and the partial unique index refuses the row.
  const { cp, lease, provider, root } = await scenario(entry);
  const first = await waitUntilObserved(
    provider,
    (await start(provider, root, "sess-1")).sessionId,
  );
  bindSession(cp, lease, first, { runId: RUN_ID, provider: entry.id, nowMs: T0 });

  const second = await start(provider, root, "sess-2");
  expect(second.sessionId, "the provider offered no exclusion of its own").toBe("sess-2");

  expect(() =>
    bindSession(cp, lease, second, { runId: RUN_ID, provider: entry.id, nowMs: T0 + 1 }),
  ).toThrow();

  expect(reconstruct(cp, T0).activeSessions.map((row) => row.session_id)).toEqual(["sess-1"]);
}

skipIf(S2_UNAVAILABLE !== null, S2_UNAVAILABLE ?? "")(
  "the second live session is refused by us and not by the provider[S2]",
  async () => {
    await theSecondLiveSessionIsRefusedByUs(S2);
  },
);
test("the second live session is refused by us and not by the provider[S3]", async () => {
  await theSecondLiveSessionIsRefusedByUs(S3);
});

// --------------------------------------------------------------------------
// a released binding frees the run for the next session
// --------------------------------------------------------------------------

async function aReleasedBindingFreesTheRunForTheNextSession(entry: ProviderEntry): Promise<void> {
  // Stop and start again: one active binding throughout, two rows of history.
  const { cp, lease, provider, root } = await scenario(entry);
  const first = await waitUntilObserved(
    provider,
    (await start(provider, root, "sess-1")).sessionId,
  );
  bindSession(cp, lease, first, { runId: RUN_ID, provider: entry.id, nowMs: T0 });
  unwrap(await provider.stop("sess-1"), "stop(sess-1)");
  releaseSession(cp, "sess-1", { releasedAtMs: T0 + 10 });

  const second = await waitUntilObserved(
    provider,
    (await start(provider, root, "sess-2")).sessionId,
  );
  bindSession(cp, lease, second, { runId: RUN_ID, provider: entry.id, nowMs: T0 + 11 });

  expect(reconstruct(cp, T0 + 11).activeSessions.map((row) => row.session_id)).toEqual(["sess-2"]);
  const bound = cp.prepare("SELECT session_id FROM session ORDER BY bound_at_ms").all() as {
    session_id: string;
  }[];
  expect(bound.map((row) => row.session_id)).toEqual(["sess-1", "sess-2"]);
}

skipIf(S2_UNAVAILABLE !== null, S2_UNAVAILABLE ?? "")(
  "a released binding frees the run for the next session[S2]",
  async () => {
    await aReleasedBindingFreesTheRunForTheNextSession(S2);
  },
);
test("a released binding frees the run for the next session[S3]", async () => {
  await aReleasedBindingFreesTheRunForTheNextSession(S3);
});

// --------------------------------------------------------------------------
// a stale holder cannot bind a session it started
// --------------------------------------------------------------------------

async function aStaleHolderCannotBindASessionItStarted(entry: ProviderEntry): Promise<void> {
  // Losing the lease is not softened by the provider having answered.
  const { cp, lease, provider, root } = await scenario(entry);
  const readout = await waitUntilObserved(
    provider,
    (await start(provider, root, "sess-1")).sessionId,
  );
  acquire(cp, {
    resource: RESOURCE,
    holder: "another-writer",
    nowMs: T0 + TTL_MS + 1,
    ttlMs: TTL_MS,
  });

  expect(() =>
    bindSession(cp, lease, readout, { runId: RUN_ID, provider: entry.id, nowMs: T0 + TTL_MS + 2 }),
  ).toThrow(StaleWriterRefused);
  expect(reconstruct(cp, T0 + TTL_MS + 2).activeSessions).toEqual([]);

  const history = writeHistory(cp, { kind: effectKind(RESOURCE, BIND_EFFECT) });
  expect(history.map((row) => row.status)).toEqual(["refused"]);
  expect(history.map((row) => row.writer_epoch)).toEqual([lease.epoch]);
}

skipIf(S2_UNAVAILABLE !== null, S2_UNAVAILABLE ?? "")(
  "a stale holder cannot bind a session it started[S2]",
  async () => {
    await aStaleHolderCannotBindASessionItStarted(S2);
  },
);
test("a stale holder cannot bind a session it started[S3]", async () => {
  await aStaleHolderCannotBindASessionItStarted(S3);
});

// --------------------------------------------------------------------------
// an effect about a provider session stays exactly once across a resend
// --------------------------------------------------------------------------

async function anEffectStaysExactlyOnceAcrossAResend(entry: ProviderEntry): Promise<void> {
  // The outbox half of the scope, with the provider's session as the subject.
  const { cp, lease, provider, root } = await scenario(entry);
  const readout = await waitUntilObserved(
    provider,
    (await start(provider, root, "sess-1")).sessionId,
  );
  bindSession(cp, lease, readout, { runId: RUN_ID, provider: entry.id, nowMs: T0 });

  const dropbox = new KeyedDropbox(join(root, "destination"), "item11-dropbox");
  const outbox = new Outbox(cp, {
    resource: RESOURCE,
    holder: HOLDER,
    registry: spikeRegistry(dropbox),
  });
  outbox.enqueue({
    messageId: "msg-1",
    recipient: NOTIFY_RECIPIENT,
    payload: `{"session":"${readout.sessionId}"}`,
    dedupKey: `session-bound:${readout.sessionId}`,
    nowMs: T0,
    epoch: lease.epoch,
    runId: RUN_ID,
  });

  const first = outbox.attempt("msg-1", { nowMs: T0 + 1, epoch: lease.epoch });
  const again = outbox.attempt("msg-1", { nowMs: T0 + 2, epoch: lease.epoch });

  expect(first.deduplicated).toBe(false);
  expect(again.deduplicated).toBe(true);
  expect(dropbox.effectCount(first.idempotencyKey)).toBe(1);
  expect(outbox.recordAck("msg-1", { nowMs: T0 + 3 }).recorded).toBe(true);
}

skipIf(S2_UNAVAILABLE !== null, S2_UNAVAILABLE ?? "")(
  "an effect about a provider session stays exactly once across a resend[S2]",
  async () => {
    await anEffectStaysExactlyOnceAcrossAResend(S2);
  },
);
test("an effect about a provider session stays exactly once across a resend[S3]", async () => {
  await anEffectStaysExactlyOnceAcrossAResend(S3);
});
