import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { acquire, LeaseHeld, StaleWriterRefused } from "../../src/control_plane/lease.js";
import * as sessionBinding from "../../src/control_plane/session_binding.js";
import { Failure, FailureKind, Ok } from "../../src/session/provider.js";
import {
  DEFAULT_READBACK_BUDGET_MS,
  IdentityUnconfirmed,
  LoserTerminated,
  OrchestrationRefused,
  ProviderStartFailed,
  READBACK_POLL_INTERVAL_MS,
  SessionOrchestrator,
} from "../../src/supervisor.js";
import { caseRoot } from "../testkit/cases.js";
import {
  activeRows,
  Clock,
  expectAsyncRefusal,
  gateMoments,
  identityIncident,
  makeControlPlane,
  makeOrchestrator,
  makeUuids,
  observed,
  RESOURCE,
  RUN_ID,
  refusals,
  ScriptedProvider,
  TTL_MS,
  takeOver,
  unconfirmed,
} from "./helpers.js";

/**
 * The Interlock-mediated proof, layer by layer (issue #18).
 *
 * Ported from interlock `tests/gate_item2/test_orchestrator_walk.py` at
 * `65f36c5`.
 *
 * Every case here runs a crash-and-retry shape *through* the control plane
 * and asserts the outcome the provider cannot supply: the losing claimant
 * never becomes a process, a second writer is refused durably, and
 * re-identification after a kill yields exactly one session for the run. The
 * provider fixture refuses nothing (see `./helpers.ts`), so every pass here
 * is a pass with the provider's own refusal assumed absent -- it is defence
 * in depth, not the mechanism. No assertion reads an exit code; every one
 * reads a durable row or the provider's recorded call list.
 */

function harness(): {
  readonly cp: SqliteDatabase;
  readonly clock: Clock;
  readonly provider: ScriptedProvider;
  readonly uuids: () => string;
  readonly workspace: string;
} {
  const cp = makeControlPlane();
  onTestFinished(() => {
    cp.close();
  });
  return {
    cp,
    clock: new Clock(),
    provider: new ScriptedProvider(),
    uuids: makeUuids(),
    workspace: caseRoot("gate-item2-orch"),
  };
}

// --------------------------------------------------------------------------
// the admission ordering itself
// --------------------------------------------------------------------------

describe("the admission ordering itself", () => {
  test("the binding is committed before the provider is asked to spawn", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const seen: [string, string][] = [];

    provider.onStart = (request) => {
      const row = cp
        .prepare(
          "SELECT binding_phase, observation FROM session WHERE session_id = ?" +
            " AND released_at_ms IS NULL",
        )
        .get(request.sessionId) as { binding_phase: string; observation: string } | undefined;
      expect(row, "the spawn ran before the binding was committed").toBeDefined();
      const defined = row as { binding_phase: string; observation: string };
      seen.push([defined.binding_phase, defined.observation]);
      return undefined;
    };

    const outcome = await makeOrchestrator(cp, clock, provider, uuids, workspace).start();

    // The write-ahead had already committed -- and honestly: the row said
    // 'spawned'/'unobserved', never claiming a read-back that had not happened.
    expect(seen).toStrictEqual([["spawned", "unobserved"]]);
    expect(outcome.path).toBe("started");
    expect(outcome.binding.bindingPhase).toBe("identity_confirmed");
    expect(outcome.binding.observation).toBe("observed");
  });

  test("the readback is committed not assumed", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const outcome = await makeOrchestrator(cp, clock, provider, uuids, workspace).start();
    const row = cp
      .prepare(
        "SELECT binding_phase, observation, provider_state FROM session WHERE session_id = ?",
      )
      .get(outcome.sessionId) as {
      binding_phase: string;
      observation: string;
      provider_state: string;
    };
    expect([row.binding_phase, row.observation]).toEqual(["identity_confirmed", "observed"]);
    expect(row.provider_state).toBe("running");
  });

  test("an identity that never reads back is never confirmed", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    provider.nextReadouts = Array.from({ length: 10 }, () => unconfirmed("ignored"));
    await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace).start(),
      IdentityUnconfirmed,
    );
    const rows = activeRows(cp);
    expect(rows).toHaveLength(1);
    const [, phase, observation] = rows[0] as [string, string, string];
    expect(phase).toBe("spawned");
    expect(observation).toBe("unobserved");
  });
});

// --------------------------------------------------------------------------
// the losing claimant never becomes a process
// --------------------------------------------------------------------------

describe("the losing claimant never becomes a process", () => {
  test("a claimant against a live lease never reaches the provider", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    await makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a").start();
    await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-b").start(),
      LeaseHeld,
    );
    // One spawn ever; the second claimant died at the lease, not at the
    // provider, and wrote nothing.
    expect(provider.startCalls).toHaveLength(1);
    expect(activeRows(cp)).toHaveLength(1);
  });

  test("the u27 shape through interlock spawns only the winner", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    // sup-a acquires the lease and dies before prepare_binding commits: the
    // uuid factory is the seam between acquire and the admission write.
    const die = (): never => {
      throw new Error("claimant killed inside the admission window");
    };

    await expect(
      new SessionOrchestrator(cp, provider, {
        runId: RUN_ID,
        holder: "sup-a",
        workspace: "w",
        role: "worker",
        nowMs: clock.nowMs,
        sessionUuidFactory: die,
        ttlMs: TTL_MS,
      }).start(),
    ).rejects.toThrow("claimant killed inside the admission window");
    expect(provider.startCalls).toEqual([]);
    expect(activeRows(cp)).toEqual([]);

    // The retry: through Interlock it must wait out the dead claimant's
    // lease (a lease cannot tell dead from slow), then it alone spawns.
    await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a-retry").recover(),
      LeaseHeld,
    );
    clock.advancePastExpiry();
    const outcome = await makeOrchestrator(
      cp,
      clock,
      provider,
      uuids,
      workspace,
      "sup-a-retry",
    ).recover();
    expect(outcome.path).toBe("started");
    expect(provider.startCalls.map((request) => request.sessionId)).toEqual([outcome.sessionId]);
    expect(activeRows(cp).map((row) => row[0])).toEqual([outcome.sessionId]);
  });

  test("a stale claimant returning before its admission write never spawns", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const stopAndLose = (): string => {
      // The world moves while sup-a is stopped between its acquire and its
      // admission write: the lease expires and sup-b takes over (epoch up).
      takeOver(cp, clock, "sup-b");
      return "11111111-1111-4111-8111-111111111111";
    };

    await expectAsyncRefusal(
      () =>
        makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a", {
          sessionUuidFactory: stopAndLose,
        }).start(),
      StaleWriterRefused,
    );

    expect(provider.startCalls).toEqual([]); // the loser never became a process
    expect(activeRows(cp)).toEqual([]);
    const recorded = refusals(cp);
    expect(recorded).toHaveLength(1);
    expect(String((recorded[0] as Record<string, unknown>).kind)).toContain("prepare_binding");
  });

  test("a claimant stopped inside the critical section is terminated measured", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    provider.onStart = (_request) => {
      takeOver(cp, clock, "sup-b");
      return undefined;
    };

    const caught = await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a").start(),
      LoserTerminated,
    );

    // The process was created (that is the residual) -- and then terminated,
    // immediately and measurably, before any identity was confirmed.
    expect(provider.stopCalls).toEqual([caught.sessionId]);
    expect(caught.terminationLatencyMs).toBeGreaterThanOrEqual(0);
    expect(refusals(cp).some((row) => String(row.kind).includes("post_spawn_gate"))).toBe(true);
    // The loser's binding never reached identity_confirmed.
    const binding = sessionBinding.bindingForSession(cp, caught.sessionId);
    expect(binding !== undefined && binding.bindingPhase === "spawned").toBe(true);
  });
});

// --------------------------------------------------------------------------
// recovery: the four injection points, re-identified from SQLite alone
// --------------------------------------------------------------------------

describe("recovery: the four injection points, re-identified from SQLite alone", () => {
  test("killed before the binding commit recovery starts fresh", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    clock.advancePastExpiry(); // any prior claimant's lease is history
    const outcome = await makeOrchestrator(
      cp,
      clock,
      provider,
      uuids,
      workspace,
      "sup-2",
    ).recover();
    expect(outcome.path).toBe("started");
    expect(provider.startCalls).toHaveLength(1);
    expect(activeRows(cp).map((row) => row[0])).toEqual([outcome.sessionId]);
  });

  test("killed between commit and spawn recovery respawns the bound identity", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const lease = acquire(cp, {
      resource: RESOURCE,
      holder: "sup-1",
      nowMs: clock.nowMs(),
      ttlMs: TTL_MS,
    });
    const sessionId = uuids();
    sessionBinding.prepareBinding(cp, lease, {
      sessionId,
      runId: RUN_ID,
      provider: "scripted",
      nowMs: clock.nowMs(),
    });
    clock.advancePastExpiry();

    const outcome = await makeOrchestrator(
      cp,
      clock,
      provider,
      uuids,
      workspace,
      "sup-2",
    ).recover();
    expect(outcome.path).toBe("respawned");
    expect(outcome.sessionId).toBe(sessionId); // the committed identity, not a new one
    expect(provider.startCalls.map((request) => request.sessionId)).toEqual([sessionId]);
    expect(provider.resumeCalls).toEqual([]);
    expect(outcome.binding.bindingPhase).toBe("identity_confirmed");
  });

  test("killed after the mark but before the spawn ran recovery respawns", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const lease = acquire(cp, {
      resource: RESOURCE,
      holder: "sup-1",
      nowMs: clock.nowMs(),
      ttlMs: TTL_MS,
    });
    const sessionId = uuids();
    sessionBinding.prepareBinding(cp, lease, {
      sessionId,
      runId: RUN_ID,
      provider: "scripted",
      nowMs: clock.nowMs(),
    });
    sessionBinding.markSpawned(cp, lease, { sessionId, runId: RUN_ID, nowMs: clock.nowMs() });
    clock.advancePastExpiry();

    const outcome = await makeOrchestrator(
      cp,
      clock,
      provider,
      uuids,
      workspace,
      "sup-2",
    ).recover();
    expect(outcome.path).toBe("respawned");
    expect(outcome.sessionId).toBe(sessionId);
    expect(provider.startCalls.map((request) => request.sessionId)).toEqual([sessionId]);
    expect(provider.resumeCalls).toEqual([]);
  });

  test("killed between spawn and readback recovery resumes never reclaims", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const lease = acquire(cp, {
      resource: RESOURCE,
      holder: "sup-1",
      nowMs: clock.nowMs(),
      ttlMs: TTL_MS,
    });
    const sessionId = uuids();
    sessionBinding.prepareBinding(cp, lease, {
      sessionId,
      runId: RUN_ID,
      provider: "scripted",
      nowMs: clock.nowMs(),
    });
    sessionBinding.markSpawned(cp, lease, { sessionId, runId: RUN_ID, nowMs: clock.nowMs() });
    provider.plant(sessionId, [], false); // the provider knows the dead child
    clock.advancePastExpiry();

    const outcome = await makeOrchestrator(
      cp,
      clock,
      provider,
      uuids,
      workspace,
      "sup-2",
    ).recover();
    expect(outcome.path).toBe("resumed");
    expect(provider.startCalls).toEqual([]);
    expect(provider.resumeCalls).toEqual([sessionId]);
    expect(outcome.binding.bindingPhase).toBe("identity_confirmed");
  });

  test("killed after the readback commit recovery resumes and rewrites nothing", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const outcome = await makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-1").start();
    const confirmedAt = (
      cp
        .prepare("SELECT binding_phase FROM session WHERE session_id = ?")
        .get(outcome.sessionId) as {
        binding_phase: string;
      }
    ).binding_phase;
    expect(confirmedAt).toBe("identity_confirmed");

    clock.advancePastExpiry();
    const recovered = await makeOrchestrator(
      cp,
      clock,
      provider,
      uuids,
      workspace,
      "sup-2",
    ).recover();
    expect(recovered.path).toBe("resumed");
    expect(recovered.sessionId).toBe(outcome.sessionId);
    expect(provider.resumeCalls).toEqual([outcome.sessionId]);
    expect(provider.startCalls).toHaveLength(1); // still only the original spawn
    // Exactly one active binding, same identity, still confirmed.
    expect(activeRows(cp)).toEqual([[outcome.sessionId, "identity_confirmed", "observed"]]);
  });

  test("every recovery ends with exactly one active binding", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const outcome = await makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-1").start();
    for (let generation = 2; generation < 5; generation += 1) {
      clock.advancePastExpiry();
      const recovered = await makeOrchestrator(
        cp,
        clock,
        provider,
        uuids,
        workspace,
        `sup-${generation}`,
      ).recover();
      expect(recovered.sessionId).toBe(outcome.sessionId);
      expect(activeRows(cp)).toHaveLength(1);
    }
  });
});

// --------------------------------------------------------------------------
// the U32 shape, mediated; orphans; refusal durability
// --------------------------------------------------------------------------

describe("the U32 shape, mediated; orphans; refusal durability", () => {
  test("the u32 shape through interlock issues no second resume", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const outcome = await makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-1").start();
    clock.advancePastExpiry();
    const first = await makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-2").recover();
    expect(first.sessionId).toBe(outcome.sessionId);
    await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-3").recover(),
      LeaseHeld,
    );
    expect(provider.resumeCalls).toEqual([outcome.sessionId]); // exactly one, ever
  });

  test("a stale recoverer is refused before its resume", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const outcome = await makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-1").start();
    clock.advancePastExpiry();

    const recoverer = makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-2");
    const originalReadState = provider.readState.bind(provider);

    provider.readState = async (sessionId: string) => {
      provider.readState = originalReadState;
      takeOver(cp, clock, "sup-3");
      return originalReadState(sessionId);
    };

    await expectAsyncRefusal(() => recoverer.recover(), StaleWriterRefused);
    expect(provider.resumeCalls).toEqual([]); // refused before the verb, not after
    expect(refusals(cp).some((row) => String(row.kind).includes("post_spawn_gate"))).toBe(true);
    expect(outcome.sessionId).toBeTruthy(); // the binding still names the one session
  });

  test("an orphan the binding does not name is never adopted", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const orphan = "99999999-9999-4999-8999-999999999999";
    provider.plant(orphan, [], true); // a leftover from some other life
    clock.advancePastExpiry();

    const outcome = await makeOrchestrator(
      cp,
      clock,
      provider,
      uuids,
      workspace,
      "sup-2",
    ).recover();
    expect(outcome.sessionId).not.toBe(orphan);
    expect(provider.resumeCalls).toEqual([]); // the orphan was not resumed
    expect(provider.startCalls.map((request) => request.sessionId)).not.toContain(orphan);
    // The orphan is still enumerable -- unadopted, not erased.
    const listed = await provider.listSessions();
    const roster = new Set(
      (listed as Ok<readonly (typeof outcome.readout)[]>).value.map((r) => r.sessionId),
    );
    expect(roster.has(orphan)).toBe(true);
  });

  test("a claimant that stalls in the readback never returns success", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const stalled: { b?: Awaited<ReturnType<SessionOrchestrator["recover"]>> } = {};

    const takeoverDuringWait = async (): Promise<void> => {
      if (stalled.b !== undefined) {
        return;
      }
      clock.advancePastExpiry(); // A's lease dies while A is stalled
      // From here the provider reports the session normally -- which is
      // exactly what a stale A sees on waking.
      for (const session of provider.sessions.values()) {
        session.readouts = [];
      }
      // B's full recovery, run inline while A is stalled: resume the
      // session and confirm the binding under B's (live) lease.
      stalled.b = await makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-b").recover();
    };

    // A's readouts stay unconfirmed until B has taken over.
    provider.nextReadouts = Array.from({ length: 4 }, () => unconfirmed("pending"));
    const a = makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a", {
      wait: takeoverDuringWait,
      readbackBudgetMs: 3 * READBACK_POLL_INTERVAL_MS,
    });
    const caught = await expectAsyncRefusal(() => a.start(), LoserTerminated);

    expect(stalled.b, "B's recovery never ran while A was stalled").toBeDefined();
    const b = stalled.b as NonNullable<typeof stalled.b>;
    expect(b.sessionId).toBe(caught.sessionId);
    // A left a durable refusal and stood down from the stop: B has confirmed
    // the binding, so a session-level stop from A could have killed the very
    // worker B adopted. A's possibly-rogue process is surfaced as an
    // unresolved hazard, not silently trusted and not blindly killed.
    expect(caught.stopAttempted).toBe(false);
    expect(provider.stopCalls).not.toContain(caught.sessionId);
    expect(caught.message).toContain("UNRESOLVED hazard");
    expect(refusals(cp).some((row) => String(row.kind).includes("post_spawn_gate"))).toBe(true);
    expect(activeRows(cp)).toEqual([[b.sessionId, "identity_confirmed", "observed"]]);
  });

  test("a provider failure does not bypass the fence", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    provider.onStart = (_request) => {
      takeOver(cp, clock, "sup-b");
      return new Failure(
        FailureKind.UNINTERPRETABLE_RESPONSE,
        "the readout failed after Popen; a process may exist",
      );
    };
    await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a").start(),
      LoserTerminated,
    );
    expect(refusals(cp).some((row) => String(row.kind).includes("post_spawn_gate"))).toBe(true);
  });

  test("a fruitless readback still ends in a fenced write", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const loseWhilePolling = (): void => {
      takeOver(cp, clock, "sup-b");
    };
    provider.nextReadouts = Array.from({ length: 10 }, () => unconfirmed("never"));
    const caught = await expectAsyncRefusal(
      () =>
        makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a", {
          wait: loseWhilePolling,
          readbackBudgetMs: 2 * READBACK_POLL_INTERVAL_MS,
        }).start(),
      LoserTerminated,
    );
    // No takeover writer had confirmed anything, so the loser's own child
    // was stopped rather than left as a hazard.
    expect(caught.stopAttempted).toBe(true);
    expect(provider.stopCalls).toContain(caught.sessionId);
  });

  test("an unconfirmed stop is reported as unconfirmed", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    provider.onStart = (_request) => {
      takeOver(cp, clock, "sup-b");
      return undefined;
    };
    const realStop = provider.stop.bind(provider);
    provider.stop = async (sessionId: string) => {
      provider.stopCalls.push(sessionId);
      return new Failure(FailureKind.TIMED_OUT, "child did not exit within 2s of SIGKILL");
    };
    const caught = await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a").start(),
      LoserTerminated,
    );
    expect(caught.stopConfirmed).toBe(false);
    expect(caught.message).toContain("NOT confirmed");
    provider.stop = realStop;
  });

  test("a loser stands down while a newer writer is mid walk", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    provider.onStart = (_request) => {
      clock.advancePastExpiry();
      const leaseB = acquire(cp, {
        resource: RESOURCE,
        holder: "sup-b",
        nowMs: clock.nowMs(),
        ttlMs: TTL_MS,
      });
      // B is mid-walk: it has crossed its gate (reached the provider) but
      // has not confirmed. Driving B's real gate write is the point.
      makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-b")._postSpawnGate(leaseB, {
        moment: "before-resume",
      });
      return undefined;
    };
    const caught = await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a").start(),
      LoserTerminated,
    );
    expect(caught.stopAttempted).toBe(false);
    expect(provider.stopCalls).not.toContain(caught.sessionId);
  });

  test("recovery through a different provider is refused", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const lease = acquire(cp, {
      resource: RESOURCE,
      holder: "sup-0",
      nowMs: clock.nowMs(),
      ttlMs: TTL_MS,
    });
    sessionBinding.prepareBinding(cp, lease, {
      sessionId: uuids(),
      runId: RUN_ID,
      provider: "some-other-backend",
      nowMs: clock.nowMs(),
    });
    clock.advancePastExpiry();
    await expectAsyncRefusal(
      () =>
        makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-1", {
          providerName: "scripted",
        }).recover(),
      OrchestrationRefused,
      "different provider",
    );
    expect(provider.startCalls).toEqual([]);
    expect(provider.resumeCalls).toEqual([]);
  });

  test("refusals are rows not log lines", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const stopAndLose = (): string => {
      takeOver(cp, clock, "sup-b");
      return "22222222-2222-4222-8222-222222222222";
    };
    await expectAsyncRefusal(
      () =>
        makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a", {
          sessionUuidFactory: stopAndLose,
        }).start(),
      StaleWriterRefused,
    );
    const recorded = refusals(cp);
    expect(recorded.length, "a refused admission left no durable record").toBeGreaterThan(0);
    expect(recorded.every((row) => Boolean(row.refusal_reason))).toBe(true);
  });
});

// --------------------------------------------------------------------------
// an identity incident refuses the same way whoever detects it (continuo #92)
// --------------------------------------------------------------------------

/**
 * The race continuo #92 measured, forced both ways instead of run twice.
 *
 * A mismatched identity has two legitimate detection points: the readout the
 * provider takes immediately after the spawn (which the verb then answers
 * with), and the read-back poll `#awaitIdentity` runs afterwards. With a real
 * child, which of them sees it first is event-loop scheduling against process
 * startup -- a contended runner shifts the odds, which is how a documentation
 * pull request went red. Nothing here is left to that: the scripted provider
 * is told exactly when to produce the incident, so each case exercises one
 * detection point and only that one.
 *
 * What every case asserts is that the *caller-visible class* does not move:
 * `IdentityUnconfirmed`, never `ProviderStartFailed` (D-0047). These are
 * target-only -- interlock's suite has no case for either forced path, and
 * this is the assertion its `test_a_reported_identity_that_disagrees_is_never_confirmed`
 * was only accidentally making.
 */
describe("an identity incident refuses the same way whoever detects it (target-only)", () => {
  /**
   * A binding already at `spawned` for a session the provider knows: the row
   * a crash leaves behind after the write-ahead mark and a spawn that
   * happened. `recover()` from here goes through `resume`, which is the verb
   * the start-only fix would have left racing.
   */
  function spawnedBinding(
    cp: SqliteDatabase,
    clock: Clock,
    provider: ScriptedProvider,
    uuids: () => string,
  ): string {
    const lease = acquire(cp, {
      resource: RESOURCE,
      holder: "sup-1",
      nowMs: clock.nowMs(),
      ttlMs: TTL_MS,
    });
    const sessionId = uuids();
    sessionBinding.prepareBinding(cp, lease, {
      sessionId,
      runId: RUN_ID,
      provider: "scripted",
      nowMs: clock.nowMs(),
    });
    sessionBinding.markSpawned(cp, lease, { sessionId, runId: RUN_ID, nowMs: clock.nowMs() });
    provider.plant(sessionId); // the spawn did happen; the child is out there
    clock.advancePastExpiry();
    return sessionId;
  }

  test("start: detected by the post-spawn readout, inside the verb's own answer", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    // Detection point 1, forced: the child's event beat the readout the
    // provider takes immediately after spawning, so `start` itself answers
    // with the incident and `#awaitIdentity` is never reached.
    provider.onStart = (request) => identityIncident(request.sessionId);

    const refusal = await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace).start(),
      IdentityUnconfirmed,
    );

    expect(provider.readStateCalls, "the poll ran; this case must not reach it").toBe(0);
    expect(refusal.lastAnswer).toBeInstanceOf(Failure);
    expect((refusal.lastAnswer as Failure).kind).toBe(FailureKind.IDENTITY_INCIDENT);
    // Through the fence, not around it: the refusal is preceded by a gate
    // write that a stale claimant would have failed.
    expect(gateMoments(cp)).toContain("identity-incident-start");
    const rows = activeRows(cp);
    expect(rows).toHaveLength(1);
    expect([rows[0]?.[1], rows[0]?.[2]]).toEqual(["spawned", "unobserved"]);
  });

  test("start: detected only by the read-back poll", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    // Detection point 2, forced: the spawn's own readout saw nothing (the
    // ordinary answer), and the child's contradicting event lands during the
    // poll instead.
    provider.onReadState = (sessionId) => identityIncident(sessionId);

    const refusal = await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace).start(),
      IdentityUnconfirmed,
    );

    // Terminal, not polled to exhaustion: one read-back settled it, where the
    // harness's budget buys three.
    expect(provider.readStateCalls).toBe(1);
    expect((refusal.lastAnswer as Failure).kind).toBe(FailureKind.IDENTITY_INCIDENT);
    expect(gateMoments(cp)).toContain("identity-incident-readback");
    const rows = activeRows(cp);
    expect(rows).toHaveLength(1);
    expect([rows[0]?.[1], rows[0]?.[2]]).toEqual(["spawned", "unobserved"]);
  });

  test("resume: detected inside the verb's own answer", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const sessionId = spawnedBinding(cp, clock, provider, uuids);
    provider.onResume = (id) => identityIncident(id);

    const refusal = await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-2").recover(),
      IdentityUnconfirmed,
    );

    expect(provider.resumeCalls).toEqual([sessionId]);
    expect((refusal.lastAnswer as Failure).kind).toBe(FailureKind.IDENTITY_INCIDENT);
    expect(gateMoments(cp)).toContain("identity-incident-resume");
    expect(activeRows(cp)).toEqual([[sessionId, "spawned", "unobserved"]]);
  });

  test("resume: detected only by the read-back poll", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const sessionId = spawnedBinding(cp, clock, provider, uuids);
    // Call 0 is `recover`'s own probe ("does the provider know this
    // session?") and must answer normally, or the walk never reaches the
    // resume this case is about. The incident lands on the poll that follows.
    provider.onReadState = (id, call) => (call === 0 ? undefined : identityIncident(id));

    const refusal = await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-2").recover(),
      IdentityUnconfirmed,
    );

    expect(provider.resumeCalls).toEqual([sessionId]);
    expect(provider.readStateCalls, "the probe, then one conclusive poll").toBe(2);
    expect((refusal.lastAnswer as Failure).kind).toBe(FailureKind.IDENTITY_INCIDENT);
    expect(gateMoments(cp)).toContain("identity-incident-readback");
    expect(activeRows(cp)).toEqual([[sessionId, "spawned", "unobserved"]]);
  });

  test("resume: the probe's own incident is refused before the verb runs", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    const sessionId = spawnedBinding(cp, clock, provider, uuids);
    // The third detection point, and the one that only a provider which does
    // not *persist* its incidents can reach: `recover` probes `readState`
    // before it resumes, and that probe can be the first thing to see the
    // mismatch. S1 does not require a provider to record it, so the resume
    // must not run on the strength of the walk having asked too early --
    // resuming here is what buries the incident under a new generation.
    provider.onReadState = (id, call) => (call === 0 ? identityIncident(id) : undefined);

    const refusal = await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-2").recover(),
      IdentityUnconfirmed,
    );

    expect(provider.resumeCalls, "the resume ran past a known incident").toEqual([]);
    expect((refusal.lastAnswer as Failure).kind).toBe(FailureKind.IDENTITY_INCIDENT);
    expect(gateMoments(cp)).toContain("identity-incident-probe");
    expect(activeRows(cp)).toEqual([[sessionId, "spawned", "unobserved"]]);
  });

  test("a start that genuinely failed to start is still ProviderStartFailed", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    // The regression guard the unification must not break: only the identity
    // kind is redirected. `UNINTERPRETABLE_RESPONSE` still covers garbage
    // output and unreadable capture files, and those are not identity
    // conflicts -- which is exactly why the discriminator had to be a kind of
    // its own rather than a match on `detail`'s prose.
    provider.onStart = () =>
      new Failure(
        FailureKind.UNINTERPRETABLE_RESPONSE,
        "identity incident: the prose alone must not decide this",
      );

    await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace).start(),
      ProviderStartFailed,
    );
  });

  test("a stale claimant is refused as a stale writer, not as an identity refusal", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    // The precedence the new path must not bypass: the fenced gate runs
    // before the identity refusal is raised, so a claimant whose lease was
    // taken over while the provider was answering leaves as a refused stale
    // writer with its child handled -- never as a quiet IdentityUnconfirmed.
    // Forced on the *poll* path deliberately: the start walk already fences
    // between the verb and its interpretation, so a takeover during `onStart`
    // would be caught by that older gate and prove nothing about this one.
    // Here the only gate between the incident and the throw is the new
    // path's own.
    provider.onReadState = (sessionId) => {
      takeOver(cp, clock, "sup-b");
      return identityIncident(sessionId);
    };

    const caught = await expectAsyncRefusal(
      () => makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a").start(),
      LoserTerminated,
    );
    expect(provider.stopCalls).toContain(caught.sessionId);
    expect(refusals(cp).length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// D-0098: the read-back window is a budget the caller declares
// --------------------------------------------------------------------------

describe("D-0098: the post-spawn read-back window is a caller's budget", () => {
  test("the budget buys the polls it pays for, and the refusal names it", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    // A child that is healthy and merely young: it never names itself inside
    // the window. This is the shape rondo's lap-1 dogfood met on a real
    // `claude` (issue #174, F-1) -- empty stderr, a zero-byte events file, and
    // a binding left at `spawned`.
    // `unconfirmed`'s first argument is the readout's OWN session id, so a
    // readout naming "pending" is a child that has not yet said its name --
    // the spelling every case in this file uses for it.
    provider.nextReadouts = [unconfirmed("pending")];

    const refusal = await expectAsyncRefusal(
      () =>
        makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a", {
          readbackBudgetMs: 7 * READBACK_POLL_INTERVAL_MS,
        }).start(),
      IdentityUnconfirmed,
    );

    // Seven intervals of budget, seven asks. Counted rather than timed: the
    // pacing is this harness's (`wait: null`), so what the budget can be held
    // to here is the number of questions it bought.
    expect(provider.readStateCalls).toBe(7);
    // **The operator's own number, in the sentence they read.** The refusal
    // this replaces said "within 50 attempts", which names a constant no
    // command line could reach -- so an operator who had just raised the
    // budget could not tell whether the value they passed was the one that ran
    // out. Both halves are asserted because each answers a different question:
    // the milliseconds are what they typed, the attempts and the interval are
    // what the class did with it.
    expect(refusal.message).toContain(`within the ${String(7 * READBACK_POLL_INTERVAL_MS)} ms`);
    expect(refusal.message).toContain(`7 attempts at ${String(READBACK_POLL_INTERVAL_MS)} ms`);
    // Unchanged by the budget: nothing is confirmed on trust when it runs out.
    const rows = activeRows(cp);
    expect(rows).toHaveLength(1);
    expect([rows[0]?.[1], rows[0]?.[2]]).toEqual(["spawned", "unobserved"]);
    expect(gateMoments(cp)).toContain("readback-exhausted");
  });

  test("a budget shorter than one interval still buys the one poll", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    provider.nextReadouts = [unconfirmed("nothing yet")];

    await expectAsyncRefusal(
      () =>
        makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a", {
          readbackBudgetMs: 1,
        }).start(),
      IdentityUnconfirmed,
    );

    // Rounding down would make a one-millisecond budget refuse a provider that
    // had ALREADY answered, which is a refusal about arithmetic rather than
    // about the child.
    expect(provider.readStateCalls).toBe(1);
  });

  test("the default window is thirty seconds, not the two and a half that never fitted", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    provider.nextReadouts = [unconfirmed("nothing yet")];

    // Built here rather than through `makeOrchestrator`, which supplies a
    // budget of its own: what this case is about is the value a caller who has
    // NOT been taught the option gets, which is every caller the day this
    // lands, and it can only be observed by omitting the field.
    const orchestrator = new SessionOrchestrator(cp, provider, {
      runId: RUN_ID,
      holder: "sup-a",
      workspace,
      role: "worker",
      nowMs: clock.nowMs,
      sessionUuidFactory: uuids,
      ttlMs: TTL_MS,
      wait: null,
      providerName: "scripted",
    });
    const refusal = await expectAsyncRefusal(() => orchestrator.start(), IdentityUnconfirmed);

    expect(DEFAULT_READBACK_BUDGET_MS).toBe(30_000);
    expect(provider.readStateCalls).toBe(DEFAULT_READBACK_BUDGET_MS / READBACK_POLL_INTERVAL_MS);
    expect(refusal.message).toContain(`within the ${String(DEFAULT_READBACK_BUDGET_MS)} ms`);
    // The measurement this default has to clear: 11.3 s was the slowest warm
    // start rondo measured, and the old window was 2.5 s. A default that fits
    // one measurement and not the next is the defect in a smaller size, so the
    // case names the floor rather than only the number chosen.
    expect(DEFAULT_READBACK_BUDGET_MS).toBeGreaterThan(11_300);
  });

  test("a budget below a millisecond is a caller's defect, not a refusal", () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    for (const budget of [0, -1, Number.NaN]) {
      expect(
        () =>
          makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a", {
            readbackBudgetMs: budget,
          }),
        String(budget),
      ).toThrow(RangeError);
    }
  });

  test("the budget buys time, not leniency", async () => {
    const { cp, clock, provider, uuids, workspace } = harness();
    // The one readout `defaultIdentityConfirmation` is deliberately written to
    // reject, and it is the hard case rather than the easy one: the readout
    // NAMES the committed identity and the provider OBSERVED it, so only the
    // provider's state -- the child's own exit -- withholds confirmation. A
    // budget is a window, so a larger one must not turn "the process died"
    // into "the identity read back", which is exactly what a fix that loosened
    // the check instead of widening the window would do while passing every
    // case above.
    provider.onReadState = (sessionId) => new Ok(observed(sessionId, "exited-1"));

    const refusal = await expectAsyncRefusal(
      () =>
        makeOrchestrator(cp, clock, provider, uuids, workspace, "sup-a", {
          readbackBudgetMs: 4 * READBACK_POLL_INTERVAL_MS,
        }).start(),
      IdentityUnconfirmed,
    );

    expect(provider.readStateCalls).toBe(4);
    expect(refusal.message).toContain("rather than confirmed on trust");
    const rows = activeRows(cp);
    expect(rows).toHaveLength(1);
    expect([rows[0]?.[1], rows[0]?.[2]]).toEqual(["spawned", "unobserved"]);
  });
});
