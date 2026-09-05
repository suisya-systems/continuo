import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { expect, onTestFinished, test } from "vitest";

import { LeaseHeld } from "../../src/control_plane/lease.js";
import { ClaudeCliSessionProvider } from "../../src/session/claude_cli_provider.js";
import {
  IdentityUnconfirmed,
  READBACK_POLL_INTERVAL_MS,
  SessionOrchestrator,
  type SessionOrchestratorOptions,
} from "../../src/supervisor.js";
import { fakeCli, fakeEnv, spawnLog } from "../session/helpers/fake-cli.js";
import {
  type SpawnLogEntry,
  spawned,
  stopSessionsAtTeardown,
} from "../session/helpers/session-cases.js";
import { caseRoot } from "../testkit/cases.js";
import { skipIf } from "../testkit/marks.js";
import { Clock, expectAsyncRefusal, makeControlPlane, RUN_ID, TTL_MS } from "./helpers.js";

/**
 * The mediated proof over the real C2 provider (fake CLI, real subprocesses).
 *
 * Ported from interlock `tests/gate_item2/test_mediated_real_provider.py` at
 * `65f36c5`.
 *
 * Same shapes as `orchestrator-walk.test.ts`, now driven through
 * {@link ClaudeCliSessionProvider} over the S2 fake CLI (`../session/helpers/`)
 * so the assertions reach the provider's own durable artifacts: the spawn log
 * (which argv was ever executed), the per-session `record.json`, and the
 * captured event streams (the C2 stand-in for the transcript). The fake CLI
 * honours whatever identity it is told to claim and refuses nothing -- the
 * mediated outcome is Interlock's doing.
 *
 * Major-1 separation (the review's three kill shapes) is explicit here:
 *
 * - supervisor-only kill: the child survives (its own process group) and is
 *   adopted, uniquely, without a second spawn;
 * - supervisor+child kill: only the binding and the provider record remain,
 *   and recovery resumes -- never re-claims -- the bound identity;
 * - claimant dies pre-admission with the retry inside the window is
 *   `orchestrator-walk.test.ts`'s ("the u27 shape through interlock spawns
 *   only the winner") and the fault-injection harness's, where the kill is a
 *   real SIGKILL at an armed anchor.
 *
 * ---------------------------------------------------------------------------
 * Platform sweep, stated once. The provider *fails closed* wherever a pid's
 * liveness or identity cannot be proven (#17): recovery around an orphan
 * record refuses to adopt, signal or resume rather than guess. That refusal
 * is design, not breakage -- so the shapes below are provable only where
 * their proof surface exists, and are skipped (with the dependency named)
 * everywhere else.
 *
 * - Orphan liveness at all (kill-0 probe): POSIX only. On Windows an orphan
 *   record's liveness is unknowable and every recovery around it is refused.
 * - A *live* orphan's identity (pid-recycling guard): needs the pid's command
 *   line, i.e. /proc. macOS is POSIX without /proc: dead orphans resolve
 *   (kill-0), live ones refuse.
 *
 * Everything else in this file (the fresh-start walk, the identity mismatch,
 * the race with the refusal absent) drives only this instance's own children
 * and is platform-free.
 * ---------------------------------------------------------------------------
 */

const IS_POSIX = process.platform !== "win32";
const HAS_PROC = statSync("/proc", { throwIfNoEntry: false })?.isDirectory() === true;

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function harness(): {
  readonly cp: SqliteDatabase;
  readonly clock: Clock;
  readonly root: string;
  readonly spawnLogPath: string;
  readonly stateRoot: string;
} {
  const cp = makeControlPlane();
  onTestFinished(() => {
    cp.close();
  });
  const root = caseRoot("gate-item2-mediated");
  const spawnLogPath = spawnLog(root);
  const stateRoot = join(root, "state");
  return { cp, clock: new Clock(), root, spawnLogPath, stateRoot };
}

function makeProvider(root: string, stateRoot: string): ClaudeCliSessionProvider {
  return stopSessionsAtTeardown(
    new ClaudeCliSessionProvider(stateRoot, { claudeCommand: fakeCli(root), stopTimeout: 2.0 }),
  );
}

function makeRealOrchestrator(
  cp: SqliteDatabase,
  clock: Clock,
  workspace: string,
  provider: ClaudeCliSessionProvider,
  holder: string,
  sessionId: string = UUID_A,
  overrides: Partial<SessionOrchestratorOptions> = {},
): SessionOrchestrator {
  return new SessionOrchestrator(cp, provider, {
    runId: RUN_ID,
    holder,
    workspace,
    role: "worker",
    nowMs: clock.nowMs,
    sessionUuidFactory: () => sessionId,
    settings: { prompt: "reply with ok", resumePrompt: "resume" },
    ttlMs: TTL_MS,
    // The source's 200 attempts: the ask at zero plus 199 intervals.
    readbackBudgetMs: 199 * READBACK_POLL_INTERVAL_MS,
    wait: () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
    ...overrides,
  });
}

function eventSessionIds(stateRoot: string, sessionId: string): Set<string> {
  const names = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync(join(stateRoot, sessionId));
  } catch {
    return names;
  }
  for (const filename of entries.filter(
    (name: string) => name.startsWith("events-") && name.endsWith(".jsonl"),
  )) {
    const text = readFileSync(join(stateRoot, sessionId, filename), "utf8");
    for (const line of text.split("\n")) {
      if (line === "") {
        continue;
      }
      try {
        const event = JSON.parse(line) as { session_id?: unknown };
        if (typeof event.session_id === "string" && event.session_id !== "") {
          names.add(event.session_id);
        }
      } catch {}
    }
  }
  return names;
}

function activeRows(cp: SqliteDatabase): [string, string, string][] {
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

test("the walk commits the exact identity the provider is told to claim", async () => {
  const { cp, clock, root, spawnLogPath, stateRoot } = harness();
  fakeEnv("FAKE_MODE", "ok");
  const provider = makeProvider(root, stateRoot);
  const outcome = await makeRealOrchestrator(
    cp,
    clock,
    join(root, "workspace"),
    provider,
    "sup-1",
  ).start();

  expect(outcome.sessionId).toBe(UUID_A);
  const spawns: readonly SpawnLogEntry[] = spawned(spawnLogPath);
  expect(spawns).toHaveLength(1);
  const argv = (spawns[0] as SpawnLogEntry).argv;
  expect(argv[argv.indexOf("--session-id") + 1]).toBe(UUID_A);
  // The provider's captured stream -- the C2 transcript stand-in -- names
  // exactly the committed identity and no other writer's.
  expect(eventSessionIds(stateRoot, UUID_A)).toEqual(new Set([UUID_A]));
  expect(activeRows(cp)).toEqual([[UUID_A, "identity_confirmed", "observed"]]);
});

test("a reported identity that disagrees is never confirmed", async () => {
  const { cp, clock, root, stateRoot } = harness();
  fakeEnv("FAKE_MODE", "ok");
  fakeEnv("FAKE_REPORT_ID", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const provider = makeProvider(root, stateRoot);
  const orchestrator = makeRealOrchestrator(cp, clock, join(root, "workspace"), provider, "sup-1");

  // Which of the two detection paths runs here is a race against the child
  // (continuo #92), and this assertion no longer depends on winning it: both
  // now answer with `FailureKind.IDENTITY_INCIDENT`, which the orchestrator
  // refuses as this one class (D-0047). The two paths are forced apart, one
  // per case, in `orchestrator-walk.test.ts`; what this case still measures
  // is that a real child claiming a real other identity is refused at all.
  await expectAsyncRefusal(() => orchestrator.start(), IdentityUnconfirmed);
  // The binding never claimed a read-back that contradicted it.
  const rows = activeRows(cp);
  expect(rows).toHaveLength(1);
  const [, phase, observation] = rows[0] as [string, string, string];
  expect([phase, observation]).toEqual(["spawned", "unobserved"]);
});

test("recovery around an impounded identity is refused, not resumed (target-only)", async () => {
  // The resume half of continuo #92, over the real provider and with no race
  // in it: the incident is already *persisted* by the time this walk starts,
  // so `resume` answers with it deterministically -- there is no child left
  // to lose a race to. `start` and `resume` share `#spawn`, so a fix that
  // covered only `start` would leave this verb raising the other class.
  const { cp, clock, root, spawnLogPath, stateRoot } = harness();
  fakeEnv("FAKE_MODE", "ok");
  fakeEnv("FAKE_REPORT_ID", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const provider = makeProvider(root, stateRoot);
  const workspace = join(root, "workspace");
  await expectAsyncRefusal(
    () => makeRealOrchestrator(cp, clock, workspace, provider, "sup-1").start(),
    IdentityUnconfirmed,
  );

  // A new supervisor life over the same state root: the binding is at
  // 'spawned' and the provider knows the session, so recovery goes through
  // `resume` -- which refuses on the record's own incident.
  clock.advancePastExpiry();
  const second = makeProvider(root, stateRoot);
  const refusal = await expectAsyncRefusal(
    () => makeRealOrchestrator(cp, clock, workspace, second, "sup-2").recover(),
    IdentityUnconfirmed,
  );
  expect(String(refusal.message)).toContain("identity incident");

  // No second writer was minted on the impounded id, and the binding still
  // says exactly what it can prove.
  expect(spawned(spawnLogPath)).toHaveLength(1);
  const recovered = activeRows(cp);
  expect(recovered).toHaveLength(1);
  const [, phaseAfter, observationAfter] = recovered[0] as [string, string, string];
  expect([phaseAfter, observationAfter]).toEqual(["spawned", "unobserved"]);
});

skipIf(
  !HAS_PROC,
  "adoption requires confirming the surviving pid's command line via /proc; where /proc does " +
    "not exist (macOS, Windows) the provider fails closed and refuses to adopt -- by design " +
    "(#17), so the adoption shape is provable only where the proof surface exists",
)("supervisor-only kill: the surviving child is adopted not respawned", async () => {
  const { cp, clock, root, spawnLogPath, stateRoot } = harness();
  fakeEnv("FAKE_MODE", "events-then-hang");
  fakeEnv("FAKE_SLEEP", "60");
  const firstSupervisor = makeProvider(root, stateRoot);
  const outcome = await makeRealOrchestrator(
    cp,
    clock,
    join(root, "workspace"),
    firstSupervisor,
    "sup-1",
  ).start();
  expect(outcome.binding.bindingPhase).toBe("identity_confirmed");

  // The supervisor dies; the child does not (its own process group). A new
  // supervisor process is a new provider instance over the same state root.
  clock.advancePastExpiry();
  const secondSupervisor = makeProvider(root, stateRoot);
  const recovered = await makeRealOrchestrator(
    cp,
    clock,
    join(root, "workspace"),
    secondSupervisor,
    "sup-2",
  ).recover();

  expect(recovered.sessionId).toBe(UUID_A);
  expect(recovered.path).toBe("resumed");
  // Adoption, not respawn: still exactly one spawned process, ever.
  expect(spawned(spawnLogPath)).toHaveLength(1);
  expect(eventSessionIds(stateRoot, UUID_A)).toEqual(new Set([UUID_A]));
  expect(activeRows(cp)).toHaveLength(1);
});

skipIf(
  !IS_POSIX,
  "resuming an orphan record requires determining the recorded pid's liveness (the kill-0 " +
    "probe); on Windows that is unknowable and the provider fails closed, refusing to adopt, " +
    "signal or resume around it -- by design (#17), so the resume shape is provable only on POSIX",
)("supervisor and child kill: recovery resumes the bound identity", async () => {
  const { cp, clock, root, spawnLogPath, stateRoot } = harness();
  fakeEnv("FAKE_MODE", "ok");
  const firstSupervisor = makeProvider(root, stateRoot);
  await makeRealOrchestrator(cp, clock, join(root, "workspace"), firstSupervisor, "sup-1").start();
  // The 'ok' child has already exited by the time the walk confirms (its
  // readout is the result event); the supervisor now "dies" too.

  clock.advancePastExpiry();
  const secondSupervisor = makeProvider(root, stateRoot);
  const recovered = await makeRealOrchestrator(
    cp,
    clock,
    join(root, "workspace"),
    secondSupervisor,
    "sup-2",
  ).recover();

  expect(recovered.sessionId).toBe(UUID_A);
  const spawns = spawned(spawnLogPath);
  expect(spawns).toHaveLength(2);
  const [firstArgv, secondArgv] = [
    (spawns[0] as SpawnLogEntry).argv,
    (spawns[1] as SpawnLogEntry).argv,
  ];
  expect(firstArgv[firstArgv.indexOf("--session-id") + 1]).toBe(UUID_A);
  expect(secondArgv).not.toContain("--session-id"); // never a fresh claim (U28)
  expect(secondArgv[secondArgv.indexOf("--resume") + 1]).toBe(UUID_A);
  expect(eventSessionIds(stateRoot, UUID_A)).toEqual(new Set([UUID_A]));
  expect(activeRows(cp)).toEqual([[UUID_A, "identity_confirmed", "observed"]]);
});

test("the provider refusal is not the mechanism", async () => {
  const { cp, clock, root, spawnLogPath, stateRoot } = harness();
  fakeEnv("FAKE_MODE", "ok");
  const provider = makeProvider(root, stateRoot);
  await makeRealOrchestrator(cp, clock, join(root, "workspace"), provider, "sup-1").start();

  const rival = makeProvider(root, stateRoot);
  await expectAsyncRefusal(
    () => makeRealOrchestrator(cp, clock, join(root, "workspace"), rival, "sup-2", UUID_A).start(),
    LeaseHeld,
  );
  expect(spawned(spawnLogPath)).toHaveLength(1); // the loser produced no process
});
