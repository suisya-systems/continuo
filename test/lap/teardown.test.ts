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
import { Ok, type ProviderResult } from "../../src/session/provider.js";
import { LoserTerminated, OrchestrationRefused } from "../../src/supervisor.js";
import { type GitOptions, runGitChecked } from "../../src/workspace/git.js";
import { WORKSPACE_MATERIALIZED_EVENT_TYPE } from "../../src/workspace/materializer.js";
import { observed, ScriptedProvider } from "../gate_item2/helpers.js";
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

/** The one session identity every case here mints. */
const SESSION_ID = "00000000-0000-0000-0000-000000000001";

/** A finished turn with something to escalate, for the cases that reach the poll. */
const REPORT = {
  kind: "report",
  sessionId: SESSION_ID,
  generation: 0,
  report: "please review",
  terminalReason: "completed",
  subtype: "success",
  isError: false,
  returncode: 0,
} as const;

/**
 * A fixture whose walk **succeeds**, so a case can reach the poll.
 *
 * The scripted provider needs one confirming read-back for the orchestrator to
 * commit the binding; everything else is the default success path.
 */
function successfulWalk(label: string): Fixture {
  const f = fixture(label, () => {
    throw new Error("unreachable: this fixture's walk succeeds");
  });
  f.provider.onStart = undefined;
  f.provider.nextReadouts = [observed(SESSION_ID)];
  return f;
}

/** A reader that is never reached: those cases fail before the poll. */
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
      providerStateRoot: join(root, "state"),
      // Absolute, because `D-0067` requires every token of the worker command to
      // be one. The scripted provider never runs it; the rule is checked in the
      // preflight regardless, which is the point of the rule.
      workerCommand: [process.execPath],
      endpoint: {
        // No `epoch`: `performLap` takes the delivery lease itself and renders
        // the epoch it minted (`D-0074`).
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

describe("D-0068: the owner's identity is the lease epoch, not the session id", () => {
  test("a session another claimant has taken over is not stopped", async () => {
    // **The hole a session-id comparison leaves open, and it is the common case
    // rather than a corner.** `SessionOrchestrator.recover()` reads the id off
    // the existing binding and keeps it, so after a legitimate takeover the
    // binding still names the same session -- an id check passes and the
    // original lap stops a worker the new owner has adopted. And the window is
    // wide: the orchestrator's lease defaults to 30 seconds while
    // `--turn-timeout-ms` defaults to fifteen minutes, so any lap whose worker
    // works for longer than half a minute spends most of its poll holding an
    // expired lease that anybody may take.
    //
    // The takeover is performed here directly -- `acquire` on the same resource
    // under a different holder, which is what raises the epoch -- because that
    // is the whole of what a second claimant does that this lap can observe.
    // The takeover happens **during the poll**, which is where it happens in
    // life: the walk finishes, the lease's 30 seconds run out while the worker
    // works, and a second claimant recovers the run. Doing it inside the spawn
    // instead would raise the epoch before this lap's own lease is observable,
    // which is a different and easier situation than the one under test.
    const f = successfulWalk("epoch-taken-over");
    const taken: string[] = [];
    const readerThatLosesTheLease = {
      readTerminalReport(): Promise<ProviderResult<LapTerminalReadout>> {
        if (taken.length === 0) {
          acquire(f.connection, {
            resource: `session-run:${RUN_ID}`,
            holder: "someone-else",
            nowMs: T0 + SLOW_MS,
            ttlMs: 600_000,
          });
          taken.push("taken");
        }
        return Promise.resolve(new Ok<LapTerminalReadout>(REPORT));
      },
    };

    const outcome = await performLap(f.connection, f.provider, readerThatLosesTheLease, f.request);

    // The lap itself succeeded: the gate is open, which is the point -- losing
    // the lease does not undo the work, it only means the child is no longer
    // this lap's to stop.
    expect(outcome.ingested.gateOpened).toBe(true);
    expect(taken, "the takeover never happened, so the case proves nothing").toEqual(["taken"]);
    expect(f.provider.stopCalls).toEqual([]);
  });

  test("the epoch comes from the acquisition, not from a later read of the row", async () => {
    // **Where the first version of this rule defeated itself.** It learned the
    // epoch by reading the lease row back after the walk had started -- which
    // answers a different question. If this process is suspended past the TTL
    // between the orchestrator's acquire and that read, the row already belongs
    // to a later claimant, so the lap records **the winner's epoch as its own**,
    // passes its own ownership check, and stops the winner's worker: the exact
    // failure the check was added to prevent, defeated by where it got its
    // number.
    //
    // The takeover here lands inside the spawn -- after the acquire, before any
    // later read -- which is that window made deterministic. With the epoch
    // taken from the acquisition it is this lap's own (lower) value and the
    // comparison fails; with the epoch re-read it is the winner's and the
    // comparison passes.
    const f = fixture("epoch-from-acquisition", () => {
      throw new OrchestrationRefused("unreachable: replaced below");
    });
    f.provider.onStart = () => {
      acquire(f.connection, {
        resource: `session-run:${RUN_ID}`,
        holder: "someone-else",
        nowMs: T0 + SLOW_MS,
        ttlMs: 600_000,
      });
      throw new OrchestrationRefused("the walk stops, having lost the lease inside the spawn");
    };

    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      OrchestrationRefused,
    );

    expect(f.provider.stopCalls).toEqual([]);
  });

  test("a lease nobody took is still this lap's to stop, and the session is stopped", async () => {
    // The anti-vacuity half for the takeover case above, on the same successful
    // walk: with no second claimant the epoch does not move and the child is
    // reaped as usual. Without this, a rule that stood down whenever it could
    // not prove ownership would pass the case above and leak every child.
    const f = successfulWalk("epoch-unclaimed");
    const outcome = await performLap(
      f.connection,
      f.provider,
      { readTerminalReport: () => Promise.resolve(new Ok<LapTerminalReadout>(REPORT)) },
      f.request,
    );

    expect(outcome.ingested.gateOpened).toBe(true);
    expect(f.provider.stopCalls).toEqual([SESSION_ID]);
  });

  test("a lease that merely expired is still this lap's to stop", async () => {
    // The anti-vacuity half, and a real distinction rather than a formality.
    // An expired lease nobody claimed leaves this lap the only party with a
    // claim on the child -- so the child is still its to stop, and a rule that
    // stood down on expiry would leak exactly the children the teardown was
    // added to reap. Only a CHANGE of epoch means somebody else is holding it.
    const f = fixture("epoch-merely-expired", () => {
      throw new OrchestrationRefused("the provider would not start");
    });

    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      OrchestrationRefused,
    );

    expect(f.provider.stopCalls).toEqual(["00000000-0000-0000-0000-000000000001"]);
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
   * A clock that reads `T0` twice and then jumps two minutes.
   *
   * The first two reads are `performLap`'s own -- the endpoint lease's
   * acquisition (`D-0072`) and the scalar it hands the materialiser -- so this
   * models a materialisation that took two minutes, which is what a
   * `git worktree add` on a large repository can take. Every read after them is
   * the endpoint lease's post-materialisation renewal and the orchestrator's.
   */
  function slowMaterialisation(): () => number {
    let reads = 0;
    return () => {
      reads += 1;
      return reads <= 2 ? T0 : T0 + SLOW_MS;
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
    // The endpoint lease is given a TTL that outlasts the simulated
    // materialisation, because what is under test here is the ORCHESTRATOR's
    // clock. With the shipped 60-second TTL this fixture would refuse before
    // the orchestrator ever ran -- correctly, and that interaction is pinned in
    // `test/lap/endpoint-lease.test.ts` rather than here, where it would
    // silently replace this case's subject.
    const request: LapRequest = { ...f.request, deliveryLease: { ttlMs: 10 * SLOW_MS } };

    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, request),
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
