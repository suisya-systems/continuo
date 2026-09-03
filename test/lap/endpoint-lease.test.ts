/**
 * Step 4: the endpoint's lease, held and renewed for the endpoint's whole life.
 *
 * **Target-only**, for the reason `test/lap/root.test.ts` gives about its own
 * file: interlock has no composition root and no launcher, so there is no
 * source node id to port and no parity ledger claims this file.
 *
 * **It starts no `claude` child**, but it does drive real git through the
 * materialiser in the second half, so it is registered in `SPAWNING_TESTS`
 * (`scripts/run-suite.mjs`) exactly as `test/lap/teardown.test.ts` is and for
 * the same reason.
 *
 * Two halves, and the split is the same one `root.test.ts` makes. The first
 * drives {@link HeldDeliveryLease} directly with an injected timer and an
 * injected clock, because every rule the renewal obeys -- a tick that latches
 * rather than throwing, a tick that never re-acquires, a tick that steps around
 * a busy connection -- is a rule about *when* something happens, and a case that
 * waited for wall-clock to produce it would be a case that sometimes did not.
 * The second drives `performLap`, because the questions there are about the
 * order: which epoch reaches the worker's `mcp.json`, what a second lap meets,
 * what a refusal gives back, and what a loss costs depending on which side of
 * the spawn it lands.
 *
 * The wall-clock half -- a real endpoint child polling successfully after more
 * than one TTL has passed -- is `test/messagebus/endpoint-lease-renewal.test.ts`,
 * which is where the actual process is.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { NOTIFY_RECIPIENT } from "../../src/control_plane/handlers.js";
import { LapRunIntent } from "../../src/control_plane/lap_run_intent.js";
import {
  acquire,
  ClockSkewRefused,
  type Lease,
  LeaseHeld,
  LeaseNotHeld,
  readLease,
} from "../../src/control_plane/lease.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { admitRun } from "../../src/control_plane/run_admission.js";
import {
  DELIVERY_LEASE_RENEWAL_INTERVAL_MS,
  DELIVERY_LEASE_TTL_MS,
  EndpointLeaseLost,
  type HeldDeliveryLease,
  holdDeliveryLease,
} from "../../src/lap/endpoint_lease.js";
import { type LapRequest, type LapTerminalReadout, performLap } from "../../src/lap/root.js";
import { DELIVERY_LEASE_RESOURCE } from "../../src/messagebus/endpoint.js";
import { Ok, type ProviderResult } from "../../src/session/provider.js";
import { OrchestrationRefused } from "../../src/supervisor.js";
import { type GitOptions, runGitChecked } from "../../src/workspace/git.js";
import { MCP_CONFIG_FILENAME, MCP_SERVER_NAME } from "../../src/workspace/materializer.js";
import { observed, ScriptedProvider } from "../gate_item2/helpers.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal, expectRefusalAsync } from "../testkit/errors.js";

const T0 = 1_700_000_000_000;
const RUN_ID = "run-endpoint-lease-1";
const BASE_BRANCH = "main";
const TOPIC_BRANCH = "feat/topic";
const HOLDER = "operator-1";
const SESSION_ID = "00000000-0000-0000-0000-000000000001";

/** A second claimant, for the cases about somebody else holding the resource. */
const OTHER_HOLDER = "operator-2";

/** Ten TTLs: long enough that no renewal could bridge it. */
const FAR_FUTURE_MS = T0 + 10 * DELIVERY_LEASE_TTL_MS;

// --------------------------------------------------------------------------
// half one: the holder itself, on an injected timer
// --------------------------------------------------------------------------

/** One armed tick, as the injected scheduler recorded it. */
interface ArmedTick {
  readonly fire: () => void;
  readonly ms: number;
  cancelled: boolean;
}

/**
 * A scheduler that records rather than schedules.
 *
 * Nothing fires on its own, so a case says exactly when a renewal is attempted
 * and against which reading of the clock. The cancellation is recorded too,
 * because "the timer was disarmed" is half of what a latch and a stop have to
 * do -- a holder that stopped renewing but left a timer armed would keep
 * `lap perform` alive after the lap was over, and no assertion about the lease
 * row would see it.
 */
class Scheduler {
  readonly armed: ArmedTick[] = [];

  schedule = (fn: () => void, ms: number): (() => void) => {
    const tick: ArmedTick = { fire: fn, ms, cancelled: false };
    this.armed.push(tick);
    return () => {
      tick.cancelled = true;
    };
  };

  /** The tick waiting to fire, which must be exactly one. */
  pending(): ArmedTick {
    const live = this.armed.filter((tick) => !tick.cancelled);
    expect(live, "exactly one tick should be armed").toHaveLength(1);
    return live[0] as ArmedTick;
  }

  /** Fire the armed tick, which spends it: these model one-shot timers. */
  fire(): void {
    fire(this.pending());
  }
}

/**
 * Fire one armed tick, marking it spent first.
 *
 * A one-shot timer is gone once it has run, and the holder clears its own
 * handle before calling back rather than after -- so a recorder that left a
 * fired tick "armed" would make every later `pending()` ambiguous and would
 * report a disarm that did happen as one that did not.
 */
function fire(tick: ArmedTick): void {
  tick.cancelled = true;
  tick.fire();
}

/** A control plane with nothing in it but a schema. */
function plane(label: string): SqliteDatabase {
  const path = join(caseRoot(label), "production.sqlite3");
  createProductionControlPlane(path, { nowMs: T0 }).close();
  const connection = openProductionControlPlane(path);
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

/** The delivery lease row, as SQL sees it. */
function deliveryRow(connection: SqliteDatabase): Lease {
  const row = readLease(connection, DELIVERY_LEASE_RESOURCE);
  expect(row, "the delivery lease row should exist").toBeDefined();
  return row as Lease;
}

/** A held delivery lease over a clock the case moves by hand. */
function held(
  connection: SqliteDatabase,
  clock: { ms: number },
  scheduler: Scheduler,
): HeldDeliveryLease {
  return holdDeliveryLease(connection, {
    holder: HOLDER,
    nowMs: () => clock.ms,
    schedule: scheduler.schedule,
  });
}

describe("the endpoint's lease is held and renewed by its launcher (D-0072)", () => {
  test("the acquisition takes the delivery resource and arms a renewal", () => {
    // The whole of what was missing before this step: nothing under `src/`
    // acquired `outbox-delivery` at all, so the epoch a worker's endpoint was
    // configured with named no lease. Both halves are asserted, because either
    // one alone is satisfied by a build that does not renew: the row, and the
    // armed tick that keeps it.
    const connection = plane("delivery-acquire");
    const scheduler = new Scheduler();
    const hold = held(connection, { ms: T0 }, scheduler);

    const row = deliveryRow(connection);
    expect(row.holder).toBe(HOLDER);
    expect(row.epoch).toBe(1);
    expect(hold.epoch).toBe(1);
    expect(row.expiresAtMs).toBe(T0 + DELIVERY_LEASE_TTL_MS);
    expect(scheduler.pending().ms).toBe(DELIVERY_LEASE_RENEWAL_INTERVAL_MS);
    expect(hold.failure).toBeNull();
  });

  test("a renewal moves the expiry past a whole TTL and keeps the epoch", () => {
    // The property the endpoint depends on and cannot observe: its
    // `INTERLOCK_MESSAGEBUS_EPOCH` is fixed at startup, so a renewal that
    // bumped the epoch would fence out the very process it was keeping alive.
    // Asserted straight out of SQL rather than off the returned token, because
    // the row is what the endpoint's own fenced writes are validated against.
    const connection = plane("delivery-renew");
    const clock = { ms: T0 };
    const scheduler = new Scheduler();
    const hold = held(connection, clock, scheduler);

    clock.ms = T0 + DELIVERY_LEASE_TTL_MS - 1;
    scheduler.fire();

    const row = deliveryRow(connection);
    expect(row.epoch).toBe(1);
    expect(hold.epoch).toBe(1);
    expect(row.acquiredAtMs).toBe(T0);
    // Past the original expiry, which is the point: the endpoint may go on
    // writing without knowing a renewal happened.
    expect(row.expiresAtMs).toBeGreaterThan(T0 + DELIVERY_LEASE_TTL_MS);
    expect(hold.failure).toBeNull();
    // And re-armed, so the next TTL is covered too. A build that renewed once
    // and stopped would pass every assertion above.
    expect(scheduler.pending().ms).toBe(DELIVERY_LEASE_RENEWAL_INTERVAL_MS);
  });

  test("a tick past the expiry latches, disarms, and does NOT re-acquire", () => {
    // The rule the module docstring calls the second of two. Re-acquiring here
    // would look like recovery and would be the worst available outcome: the
    // epoch would rise, the running worker's `mcp.json` would still carry the
    // old one, and the endpoint would be durably fenced out of its own outbox
    // with nobody able to tell it. The epoch assertion is what pins that.
    const connection = plane("delivery-lapsed");
    const clock = { ms: T0 };
    const scheduler = new Scheduler();
    const hold = held(connection, clock, scheduler);

    clock.ms = FAR_FUTURE_MS;
    scheduler.fire();

    expect(hold.failure).toBeInstanceOf(LeaseNotHeld);
    expect(deliveryRow(connection).epoch).toBe(1);
    expect(scheduler.armed.every((tick) => tick.cancelled)).toBe(true);
    expectRefusal(
      () => {
        hold.requireHeld();
      },
      EndpointLeaseLost,
      /no longer held/,
    );
  });

  test("the latched refusal carries the lease refusal as its cause", () => {
    // The taxonomy an operator meets is `ControlPlaneRefusal`, which
    // `lap/cli.ts` turns into one line and exit 2; the lease refusal underneath
    // it is what a caller reads to tell an expiry from a takeover. Losing the
    // cause would leave that distinction unreachable and nothing else would
    // notice.
    const connection = plane("delivery-cause");
    const clock = { ms: T0 };
    const scheduler = new Scheduler();
    const hold = held(connection, clock, scheduler);

    clock.ms = FAR_FUTURE_MS;
    scheduler.fire();

    let thrown: unknown;
    try {
      hold.requireHeld();
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { cause?: unknown }).cause).toBe(hold.failure);
  });

  test("a tick under a backwards clock latches rather than throwing", () => {
    // `renew` refuses a new expiry at or before the acquisition, and a tick is
    // reached from a timer -- outside every `try` in `performLap` -- so this
    // has to latch like every other refusal. A build that let it escape would
    // exit 1 with a stack trace and leave the worker child running.
    const connection = plane("delivery-skew");
    const clock = { ms: T0 };
    const scheduler = new Scheduler();
    const hold = held(connection, clock, scheduler);

    clock.ms = T0 - DELIVERY_LEASE_TTL_MS;
    scheduler.fire();

    expect(hold.failure).toBeInstanceOf(ClockSkewRefused);
  });

  test("a tick that finds the connection in a transaction changes nothing and retries sooner", () => {
    // `withImmediate` refuses a connection already in a transaction, and the
    // orchestrator genuinely holds a `BEGIN IMMEDIATE` across an awaited
    // `provider.stop()`. Attempting anyway would latch a `LeaseUsageError` --
    // a defect-shaped exception -- over a lease that is perfectly healthy, and
    // the lap would refuse for a reason that has nothing to do with the lease.
    const connection = plane("delivery-busy");
    const clock = { ms: T0 };
    const scheduler = new Scheduler();
    const hold = held(connection, clock, scheduler);
    const before = deliveryRow(connection).expiresAtMs;

    connection.prepare("BEGIN IMMEDIATE").run();
    clock.ms = T0 + 1_000;
    scheduler.fire();

    expect(hold.failure).toBeNull();
    expect(deliveryRow(connection).expiresAtMs).toBe(before);
    // Sooner than the interval: the transaction it stepped around is a write in
    // progress, not a state that lasts.
    const retry = scheduler.pending();
    expect(retry.ms).toBeLessThan(DELIVERY_LEASE_RENEWAL_INTERVAL_MS);

    // And the deferral is a deferral: the next tick on an idle connection
    // renews. Without this the case above is satisfied by a holder that gave up.
    connection.prepare("COMMIT").run();
    fire(retry);
    expect(hold.failure).toBeNull();
    expect(deliveryRow(connection).expiresAtMs).toBeGreaterThan(before);
  });

  test("stop gives the lease back, disarms, and is idempotent", () => {
    // `outbox-delivery` is one global resource, so a lease abandoned at the end
    // of a lap withholds it from the next lap for a whole TTL. The second stop
    // is asserted because it runs from a `finally` that a future edit could
    // reach twice.
    const connection = plane("delivery-stop");
    const clock = { ms: T0 };
    const scheduler = new Scheduler();
    const hold = held(connection, clock, scheduler);

    clock.ms = T0 + 1_000;
    hold.stop();
    hold.stop();

    expect(scheduler.armed.every((tick) => tick.cancelled)).toBe(true);
    expect(deliveryRow(connection).expiresAtMs).toBeLessThanOrEqual(clock.ms);
    // The property the release is FOR: the next claimant does not wait a TTL.
    const next = acquire(connection, {
      resource: DELIVERY_LEASE_RESOURCE,
      holder: OTHER_HOLDER,
      nowMs: clock.ms,
      ttlMs: DELIVERY_LEASE_TTL_MS,
    });
    expect(next.epoch).toBe(2);
  });

  test("stop swallows a release the row refuses", () => {
    // The state a teardown actually meets: this holder stalled past its TTL and
    // somebody else took the resource. `release` refuses that with
    // `LeaseNotHeld`, and an exception out of a `finally` would REPLACE the
    // lap's outcome -- reporting the teardown instead of the gate that was just
    // opened.
    const connection = plane("delivery-stop-taken");
    const clock = { ms: T0 };
    const scheduler = new Scheduler();
    const hold = held(connection, clock, scheduler);

    clock.ms = FAR_FUTURE_MS;
    const taken = acquire(connection, {
      resource: DELIVERY_LEASE_RESOURCE,
      holder: OTHER_HOLDER,
      nowMs: clock.ms,
      ttlMs: DELIVERY_LEASE_TTL_MS,
    });

    expect(() => {
      hold.stop();
    }).not.toThrow();
    // And the winner's lease is untouched: a swallowed release must also be a
    // release that did nothing, not one that shortened somebody else's row.
    expect(deliveryRow(connection).epoch).toBe(taken.epoch);
    expect(deliveryRow(connection).expiresAtMs).toBe(taken.expiresAtMs);
  });

  test("a tick after stop does nothing", () => {
    // A timer that has already been handed to the platform can still fire once
    // after it is cleared under some schedulers, and by then `lap/cli.ts` may
    // have closed the connection. Skipping is what makes the ordering in
    // `performLap`'s outer `finally` safe rather than lucky.
    const connection = plane("delivery-tick-after-stop");
    const clock = { ms: T0 };
    const scheduler = new Scheduler();
    const hold = held(connection, clock, scheduler);
    const armed = scheduler.pending();

    hold.stop();
    const after = deliveryRow(connection).expiresAtMs;
    clock.ms = T0 + 1_000;
    fire(armed);

    expect(hold.failure).toBeNull();
    expect(deliveryRow(connection).expiresAtMs).toBe(after);
  });
});

// --------------------------------------------------------------------------
// half two: the lease inside the lap's order
// --------------------------------------------------------------------------

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

/** A finished turn with something to escalate. */
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

/** The reader every successful case here uses. */
const REPORTING_READER = {
  readTerminalReport: (): Promise<ProviderResult<LapTerminalReadout>> =>
    Promise.resolve(new Ok<LapTerminalReadout>(REPORT)),
};

/** A reader the failing cases never reach. */
const UNREACHED_READER = {
  readTerminalReport(): Promise<ProviderResult<LapTerminalReadout>> {
    throw new Error("the transcript must not be read: this lap fails before the turn");
  },
};

interface Fixture {
  readonly connection: SqliteDatabase;
  readonly provider: ScriptedProvider;
  readonly request: LapRequest;
  readonly artifactRoot: string;
}

/**
 * A repository, an admitted run, and a `performLap` request whose walk succeeds.
 *
 * The same shape as `test/lap/teardown.test.ts`'s and deliberately its own copy:
 * each file in this directory states the world it runs in, and a shared fixture
 * would make a change made for one file's cases silently change another's.
 */
function fixture(label: string, nowMs: () => number = () => T0): Fixture {
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
  provider.nextReadouts = [observed(SESSION_ID)];
  const artifactRoot = join(root, "artifacts");

  return {
    connection,
    provider,
    artifactRoot,
    request: {
      runId: RUN_ID,
      repository,
      artifactRoot,
      providerStateRoot: join(root, "state"),
      workerCommand: [process.execPath],
      endpoint: {
        recipient: NOTIFY_RECIPIENT,
        destinationDir: join(root, "destination"),
        endpointModule: join(root, "endpoint.js"),
        node: process.execPath,
      },
      fence: { interlockRoot: root, claudeOrgPath: join(root, "claude-org") },
      nowMs,
      sessionUuidFactory: () => SESSION_ID,
      completion: { pollIntervalMs: 0, timeoutMs: 1_000 },
      gitTimeoutMs: 60_000,
    },
  };
}

/** The endpoint's environment, as the worker's MCP configuration carries it. */
function endpointEnv(artifactRoot: string): Record<string, string> {
  const document = JSON.parse(
    readFileSync(join(artifactRoot, RUN_ID, MCP_CONFIG_FILENAME), "utf8"),
  ) as {
    mcpServers: Record<string, { env: Record<string, string> }>;
  };
  const server = document.mcpServers[MCP_SERVER_NAME];
  expect(server, "the worker's MCP configuration should register the endpoint").toBeDefined();
  return (server as { env: Record<string, string> }).env;
}

describe("the epoch the worker's endpoint starts under is a lease this lap holds (D-0074)", () => {
  test("the rendered epoch and holder are the live delivery lease's", async () => {
    // **This case fails on the build before step 4**, which is why it is the
    // first one: `--endpoint-epoch` was a number an operator typed, nothing
    // acquired `outbox-delivery`, and so the endpoint was configured to write
    // under a lease that did not exist. Reading the row rather than the flag is
    // what makes the assertion about the world instead of about the argument.
    const f = fixture("mcp-epoch");
    const outcome = await performLap(f.connection, f.provider, REPORTING_READER, f.request);
    expect(outcome.ingested.gateOpened).toBe(true);

    const env = endpointEnv(f.artifactRoot);
    const row = deliveryRow(f.connection);
    expect(env["INTERLOCK_MESSAGEBUS_RESOURCE"]).toBe(DELIVERY_LEASE_RESOURCE);
    expect(env["INTERLOCK_MESSAGEBUS_HOLDER"]).toBe(HOLDER);
    expect(env["INTERLOCK_MESSAGEBUS_EPOCH"]).toBe(String(row.epoch));
    expect(env["INTERLOCK_MESSAGEBUS_HOLDER"]).toBe(row.holder);
    expect(outcome.endpointLeaseFailure).toBeNull();
  });

  test("the lease is given back when the lap is over", async () => {
    // The consequence of `outbox-delivery` being one global resource: a lap
    // that held on until expiry would make the next lap wait a TTL for nothing.
    const f = fixture("lease-returned");
    await performLap(f.connection, f.provider, REPORTING_READER, f.request);

    // `T0 + 1`, not `T0`: a release clamps to `MAX(acquired_at_ms + 1, nowMs)`
    // so that it cannot violate the row's own `expires_at_ms > acquired_at_ms`
    // CHECK. The one-millisecond window is `release`'s documented safe
    // direction -- it withholds the resource rather than handing it to a second
    // claimant -- and asserting the exact bound is what would notice a build
    // that stopped releasing and left the full TTL standing.
    expect(deliveryRow(f.connection).expiresAtMs).toBeLessThanOrEqual(T0 + 1);
  });

  test("a lap that refuses still gives the lease back", async () => {
    // The path that matters more than the successful one: the acquisition
    // happens before the materialiser, so every refusal below it -- and there
    // are five taxonomies of them -- passes through the same `finally`. A build
    // that released only on success would block the resource for a TTL after
    // exactly the runs an operator is about to retry.
    const f = fixture("lease-returned-on-refusal");
    f.provider.onStart = () => {
      throw new OrchestrationRefused("the provider would not start");
    };

    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      OrchestrationRefused,
    );

    expect(deliveryRow(f.connection).expiresAtMs).toBeLessThanOrEqual(T0 + 1);
  });

  test("a second lap is refused while the first holds the delivery lease", async () => {
    // Recorded rather than discovered (`D-0074`): one delivery resource means
    // one endpoint permitted to write, so two concurrent laps against one
    // control plane serialise. The refusal lands at the acquisition, which is
    // before the worktree, the fence and any child -- and `startCalls` is what
    // says so.
    const f = fixture("second-lap");
    acquire(f.connection, {
      resource: DELIVERY_LEASE_RESOURCE,
      holder: OTHER_HOLDER,
      nowMs: T0,
      ttlMs: DELIVERY_LEASE_TTL_MS,
    });

    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      LeaseHeld,
      /outbox-delivery/,
    );

    expect(f.provider.startCalls).toEqual([]);
  });
});

describe("where a lost renewal is surfaced depends on which side of the spawn it lands (D-0073)", () => {
  test("a lease lost during materialisation refuses BEFORE any child exists", async () => {
    // The window no timer can cover: `materializeWorkspace` is synchronous and
    // its git runs through `spawnSync`, so the event loop is blocked for the
    // whole of it. This clock reads `T0` for the acquisition and for the
    // materialiser's own stamp, then jumps far past the TTL -- which is a
    // `git worktree add` that outran the lease. The refusal, and the empty
    // `startCalls`, are the whole point: a worker started here would have an
    // endpoint fenced out of its own outbox for a whole turn, and the only
    // symptom would be silence.
    let reads = 0;
    const f = fixture("lost-before-spawn", () => {
      reads += 1;
      return reads <= 2 ? T0 : FAR_FUTURE_MS;
    });

    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      EndpointLeaseLost,
      /no longer held/,
    );

    expect(f.provider.startCalls).toEqual([]);
  });

  test("a lease lost after the turn costs the lease and never the report", async () => {
    // `D-0065`'s trade, applied to the other thing a lap can lose. The turn is
    // over and its report is in hand; throwing here would discard a completed
    // turn's words over a lease the report never travelled on -- lap 1's report
    // reaches the gate through the transcript, not through the endpoint.
    //
    // The loss is provoked inside the walk, which is where a real one would
    // happen, by firing the armed renewal against a clock past the TTL.
    const clock = { ms: T0 };
    const scheduler = new Scheduler();
    const f = fixture("lost-after-turn", () => clock.ms);
    f.provider.onStart = () => {
      // Two milliseconds, not two minutes. The clock is the lap's own, so a
      // jump big enough to lapse a 60-second lease would also lapse the
      // ORCHESTRATOR's -- and the lap would end on the loser path instead, which
      // is a different case with a different subject. A one-millisecond delivery
      // TTL puts the loss exactly where this case wants it and nowhere else.
      clock.ms = T0 + 2;
      scheduler.fire();
      return undefined;
    };

    const outcome = await performLap(f.connection, f.provider, REPORTING_READER, {
      ...f.request,
      deliveryLease: { ttlMs: 1, schedule: scheduler.schedule },
    });

    // The gate is open and the report is on it.
    expect(outcome.ingested.gateOpened).toBe(true);
    expect(outcome.report.report).toBe("please review");
    // And the loss is reported rather than swallowed: an operator has to know
    // the worker's endpoint stopped being able to write partway through.
    expect(outcome.endpointLeaseFailure).toBeInstanceOf(LeaseNotHeld);
  });
});
