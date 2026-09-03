/**
 * Whose child is it: the composition root's session teardown policy.
 *
 * **Why this file is not driven through the CLI verb**, when
 * `test/lap/cli.test.ts` says in its own header that everything should be.
 * The state under test here is a lease takeover that lands *between* this lap's
 * spawn and its identity read-back, leaving a second writer holding the run and
 * possibly having adopted the very child this lap started. There is no command
 * line that produces it: `test/gate_item2/orchestrator-walk.test.ts` builds it
 * by stalling one orchestrator inside its `wait` seam and running a second
 * orchestrator's whole recovery inline, and neither of those is reachable from
 * an argv. So this file reaches `performLap` directly, which is the smallest
 * surface that still contains the `finally` the policy lives in.
 *
 * **What is being defended.** `SessionOrchestrator` decides, and records on
 * `LoserTerminated.stopAttempted`, that in this one state it must NOT stop the
 * session: a session-level stop cannot name a process generation, so it could
 * kill the worker the *winner* adopted. That decision is a property of a module
 * this step does not own, and step 8 added a `finally` one frame above it that
 * calls `provider.stop` -- so the decision is now only as good as this file.
 * It is the shape the Codex review named in as many words: the enclosing
 * teardown silently overriding an inner component's deliberate restraint.
 *
 * **Target-only**, for the reason `test/lap/root.test.ts` gives. It drives real
 * git through the materialiser, so it is registered in `SPAWNING_TESTS`
 * (`scripts/run-suite.mjs`); it starts no `claude` child, because the provider
 * here is `test/gate_item2/helpers.ts`'s scripted one.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { NOTIFY_RECIPIENT } from "../../src/control_plane/handlers.js";
import { LapRunIntent } from "../../src/control_plane/lap_run_intent.js";
import { acquire, StaleWriterRefused } from "../../src/control_plane/lease.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { admitRun } from "../../src/control_plane/run_admission.js";
import { prepareBinding } from "../../src/control_plane/session_binding.js";
import {
  type LapRequest,
  type LapTerminalReadout,
  performLap,
  sessionMayBeStopped,
} from "../../src/lap/root.js";
import type { ProviderResult } from "../../src/session/provider.js";
import { LoserTerminated, OrchestrationRefused } from "../../src/supervisor.js";
import { type GitOptions, runGitChecked } from "../../src/workspace/git.js";
import { WORKSPACE_MATERIALIZED_EVENT_TYPE } from "../../src/workspace/materializer.js";
import { ScriptedProvider } from "../gate_item2/helpers.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusalAsync } from "../testkit/errors.js";

const T0 = 1_700_000_000_000;
const RUN_ID = "run-teardown-1";
const BASE_BRANCH = "main";
const TOPIC_BRANCH = "feat/topic";
const HOLDER = "operator-1";

/** A second run, so a session identity can be bound somewhere this lap is not. */
const OTHER_RUN_ID = "some-other-run";

/** Two minutes: comfortably longer than the orchestrator default 30-second TTL. */
const SLOW_MS = 120_000;

/** The refusal a `LoserTerminated` carries. Only carried here, never inspected. */
function staleWriter(sessionId: string): StaleWriterRefused {
  return new StaleWriterRefused(`the lease under session ${sessionId} went stale`, {
    actionId: `gate:${sessionId}`,
    observed: undefined,
  });
}

/**
 * A `LoserTerminated` in the state the orchestrator refuses to stop in.
 *
 * Constructed rather than provoked. `orchestrator-walk.test.ts` provokes the
 * real one and asserts the orchestrator's own behaviour there; what is under
 * test HERE is what the layer above does with the value, so the value is what
 * this file needs. Its fields are the ones that walk carries out --
 * `stopAttempted: false` alongside a stop that was neither answered nor
 * confirmed -- so a change to their meaning shows up as a type error rather
 * than as a case that quietly stops matching reality.
 */
function loserThatMustNotStop(sessionId: string): LoserTerminated {
  return new LoserTerminated(
    `session ${sessionId} is an UNRESOLVED hazard: a takeover writer has confirmed ` +
      "the binding, so this claimant stood down from the stop",
    {
      sessionId,
      refusal: staleWriter(sessionId),
      detectedAtMs: T0,
      terminatedAtMs: T0,
      stopAnswer: null,
      stopConfirmed: false,
      stopAttempted: false,
    },
  );
}

/** The same, for a loser that DID stop -- the anti-vacuity half. */
function loserThatDidStop(sessionId: string): LoserTerminated {
  return new LoserTerminated(`session ${sessionId} was terminated`, {
    sessionId,
    refusal: staleWriter(sessionId),
    detectedAtMs: T0,
    terminatedAtMs: T0,
    stopAnswer: null,
    stopConfirmed: true,
    stopAttempted: true,
  });
}

function initRepository(root: string): GitOptions {
  mkdirSync(root, { recursive: true });
  const git: GitOptions = { cwd: root, timeoutMs: 60_000 };
  runGitChecked(["init", `--initial-branch=${BASE_BRANCH}`, "."], git);
  runGitChecked(["config", "user.name", "continuo test"], git);
  runGitChecked(["config", "user.email", "continuo@example.invalid"], git);
  runGitChecked(["config", "commit.gpgsign", "false"], git);
  writeFileSync(join(root, "README.md"), "seed\n", "utf8");
  runGitChecked(["add", "README.md"], git);
  runGitChecked(["commit", "-m", "seed"], git);
  return git;
}

/** A reader that is never reached: every case here fails before the poll. */
const UNREACHED_READER = {
  readTerminalReport(): Promise<ProviderResult<LapTerminalReadout>> {
    throw new Error("the transcript must not be read: the walk failed before the turn");
  },
};

interface Fixture {
  readonly connection: SqliteDatabase;
  readonly provider: ScriptedProvider;
  readonly request: LapRequest;
}

/**
 * A repository, an admitted run, and a `performLap` request over a scripted
 * provider whose `start` does whatever the case says.
 */
function fixture(label: string, onStart: () => never, nowMs: () => number = () => T0): Fixture {
  const root = caseRoot(label);
  const repository = join(root, "repo");
  initRepository(repository);

  const databasePath = join(root, "production.sqlite3");
  createProductionControlPlane(databasePath, { nowMs: T0 }).close();
  const connection = openProductionControlPlane(databasePath);
  onTestFinished(() => {
    connection.close();
  });

  admitRun(connection, {
    intent: new LapRunIntent({
      runId: RUN_ID,
      leaseClaimantId: HOLDER,
      workspace: join(root, "worktree"),
      role: "worker",
      baseBranch: BASE_BRANCH,
      topicBranch: TOPIC_BRANCH,
      prompt: "do the work",
    }),
    nowMs: T0,
  });

  const provider = new ScriptedProvider();
  // The seam `ScriptedProvider` offers for advancing the world inside the
  // critical section. Throwing from it is how a case puts a rejection where the
  // orchestrator's own walk would put one.
  provider.onStart = onStart;

  return {
    connection,
    provider,
    request: {
      runId: RUN_ID,
      repository,
      artifactRoot: join(root, "artifacts"),
      endpoint: {
        epoch: 1,
        recipient: NOTIFY_RECIPIENT,
        destinationDir: join(root, "destination"),
        endpointModule: join(root, "endpoint.js"),
        node: process.execPath,
      },
      fence: { interlockRoot: root, claudeOrgPath: join(root, "claude-org") },
      nowMs,
      sessionUuidFactory: () => "00000000-0000-0000-0000-000000000001",
      completion: { pollIntervalMs: 0, timeoutMs: 1_000 },
      gitTimeoutMs: 60_000,
    },
  };
}

// --------------------------------------------------------------------------

describe("the rule, on its own", () => {
  test("a loser that stood down from the stop must not be stopped", () => {
    expect(sessionMayBeStopped(loserThatMustNotStop("s"))).toBe(false);
  });

  test("everything else is this lap's own session to stop", () => {
    // The anti-vacuity half, four ways. Without it a predicate that answered
    // `false` unconditionally would satisfy the case above -- and would restore
    // the leak the teardown was added to close, silently.
    expect(sessionMayBeStopped(loserThatDidStop("s"))).toBe(true);
    expect(sessionMayBeStopped(new OrchestrationRefused("the walk stopped"))).toBe(true);
    expect(sessionMayBeStopped(new Error("something else"))).toBe(true);
    // `undefined` is the successful path: nothing went wrong, and the session
    // is stopped because the turn is over.
    expect(sessionMayBeStopped(undefined)).toBe(true);
  });
});

describe("only a session this lap actually bound", () => {
  test("a session id this run never bound is not stopped", async () => {
    // The identity is captured from the factory the instant it is minted, which
    // is what lets the teardown cover a walk that failed after spawning. But
    // minting happens BEFORE `prepareBinding`, so an id the orchestrator then
    // fails to bind -- because another run already holds it -- leaves the
    // captured value set for a session this lap never started. Stopping on that
    // kills another run's worker: the same harm `sessionMayBeStopped` prevents,
    // reached by a different road.
    //
    // The other run is built first and holds the binding; this lap is then
    // pointed at the same identity through its factory.
    const shared = "00000000-0000-0000-0000-0000000000ff";
    const f = fixture("bound-elsewhere", () => {
      throw new OrchestrationRefused("unreachable: the binding is refused first");
    });
    // The other run has to exist: `session.run_id` is a foreign key onto it.
    f.connection
      .prepare(
        "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms)" +
          " VALUES (:run_id, 'created', :now, :now)",
      )
      .run({ run_id: OTHER_RUN_ID, now: T0 });
    prepareBinding(
      f.connection,
      acquire(f.connection, {
        resource: "session-run:some-other-run",
        holder: "other",
        nowMs: T0,
        ttlMs: 600_000,
      }),
      {
        sessionId: shared,
        runId: OTHER_RUN_ID,
        provider: "scripted",
        nowMs: T0,
        attemptId: null,
      },
    );

    await expectRefusalAsync(
      () =>
        performLap(f.connection, f.provider, UNREACHED_READER, {
          ...f.request,
          sessionUuidFactory: () => shared,
        }),
      Error,
    );

    // Whatever refused it, the other run's session was not touched.
    expect(f.provider.stopCalls).toEqual([]);
  });
});

describe("the rule, where it actually runs", () => {
  test("performLap does not stop a session a takeover writer may have adopted", async () => {
    // The case the Codex review named. `provider.stop` here would reach a child
    // the winner adopted, and a session-level stop cannot name a process
    // generation -- so this assertion is the whole of what keeps step 8's
    // `finally` from overriding `SessionOrchestrator`'s deliberate restraint.
    // Note it is green on a build with NO teardown at all: that is what the
    // next case is for.
    const f = fixture("teardown-stands-down", () => {
      throw loserThatMustNotStop("00000000-0000-0000-0000-000000000001");
    });

    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      LoserTerminated,
      /UNRESOLVED hazard/,
    );

    expect(f.provider.stopCalls).toEqual([]);
  });

  test("performLap does stop a session whose walk failed while it still owned it", async () => {
    // The pair, and the reason the case above cannot stand alone. A walk that
    // failed with this lap still holding the run leaves a child nobody else is
    // supervising, and its referenced handle keeps `lap perform` from
    // returning. The session id is the one the factory minted, which is what
    // makes the teardown reachable at all on a path with no outcome to read it
    // from.
    const f = fixture("teardown-stops", () => {
      throw new OrchestrationRefused("the provider would not start");
    });

    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      OrchestrationRefused,
      /would not start/,
    );

    expect(f.provider.stopCalls).toEqual(["00000000-0000-0000-0000-000000000001"]);
  });

  test("a teardown that fails does not become the lap's outcome", async () => {
    // `stopSession` swallows, and this is why: an exception thrown from a
    // `finally` REPLACES whatever the block was returning or throwing. Without
    // the swallow the operator reads a teardown's complaint instead of the
    // refusal that actually stopped the lap -- or, on the successful path,
    // instead of the gate that was just opened.
    const f = fixture("teardown-fails", () => {
      throw new OrchestrationRefused("the provider would not start");
    });
    f.provider.stop = (): Promise<ProviderResult<never>> => {
      throw new Error("the stop itself blew up");
    };

    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      OrchestrationRefused,
      /would not start/,
    );
  });

  test("the spawn really was fenced before any of this", async () => {
    // Anti-vacuity for the whole file: every case above would also pass on a
    // build that never got as far as spawning. `startCalls` is the scripted
    // provider's record of having been asked, and the settings it was asked
    // with are the fence's -- so reaching the teardown at all means the fenced
    // path ran.
    const f = fixture("teardown-was-fenced", () => {
      throw new OrchestrationRefused("the provider would not start");
    });

    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      OrchestrationRefused,
    );

    expect(f.provider.startCalls).toHaveLength(1);
    const settings = f.provider.startCalls[0]?.settings as Record<string, unknown>;
    expect(settings["cli_args"]).toContain("--settings");
    expect(settings["cli_args"]).toContain("--permission-mode");
  });
});

describe("D-0066: the orchestrator is given a live clock", () => {
  /**
   * A clock that reads `T0` once and then jumps two minutes.
   *
   * The first read is `performLap`'s own -- the scalar it hands the materialiser
   * -- so this models a materialisation that took two minutes, which is what a
   * `git worktree add` on a large repository can take. Every read after it is
   * the orchestrator's.
   */
  function slowMaterialisation(): () => number {
    let reads = 0;
    return () => {
      reads += 1;
      return reads === 1 ? T0 : T0 + SLOW_MS;
    };
  }

  test("the lease is taken at the time it is actually taken", async () => {
    // The failure this pins is invisible on a fast machine and silent on a slow
    // one. `materializeWorkspace` can only close over the instant it was given
    // -- its request carries a `number`, not a clock -- so a `performLap` that
    // passed those options straight through would hand the orchestrator a clock
    // frozen at the START of materialisation. The lease TTL defaults to 30
    // seconds, so a materialisation slower than that acquires a lease already
    // expired, and a concurrent claimant on a live clock could take it over at
    // once -- putting this lap on the loser path after it had spawned.
    const f = fixture(
      "clock-live",
      () => {
        throw new OrchestrationRefused("the provider would not start");
      },
      slowMaterialisation(),
    );

    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      OrchestrationRefused,
    );

    const lease = f.connection
      .prepare("SELECT acquired_at_ms, expires_at_ms FROM lease WHERE resource = :resource")
      .get({ resource: `session-run:${RUN_ID}` }) as
      | { acquired_at_ms: number; expires_at_ms: number }
      | undefined;
    expect(lease, "the orchestrator took no lease").toBeDefined();

    // Taken on the advanced clock, not on the materialisation instant.
    expect(lease?.acquired_at_ms).toBe(T0 + SLOW_MS);
    // And therefore alive rather than born expired. Its own assertion, because
    // this is the property that matters: a lease whose expiry is already behind
    // the wall clock is a lease anyone can take.
    expect(lease?.expires_at_ms).toBeGreaterThan(T0 + SLOW_MS);

    // The other half of the boundary, and the reason this is not a bug in the
    // materialiser: step 7's event is a statement about when IT ran, and
    // unfreezing the orchestrator clock must not move it. Without this
    // assertion, a "fix" that made the materialiser read a live clock on every
    // call would pass everything above.
    const materialised = f.connection
      .prepare("SELECT occurred_at_ms FROM event WHERE event_type = :type")
      .get({ type: WORKSPACE_MATERIALIZED_EVENT_TYPE }) as { occurred_at_ms: number };
    expect(materialised.occurred_at_ms).toBe(T0);
  });
});
