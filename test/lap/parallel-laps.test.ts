/**
 * Two laps, on one control plane, at the same instant -- `D-1104`'s proof.
 *
 * **What the evidence that existed could not show.**
 * `test/lap/endpoint-lease.test.ts` proved the old serialisation in one
 * process: two acquisitions, one refusal. Its replacement cannot be "two
 * processes both exited 0", because **that is green under serial execution
 * too** -- a case that would pass if the second lap started after the first
 * finished proves nothing about concurrency. So the proof is a **barrier**:
 * both lap children write a ready marker and block, the parent takes its
 * evidence while both are blocked, and only then writes the release file. A
 * missing marker is a failure, never permission to proceed serially.
 *
 * **The ordering below is part of the specification, not an implementation
 * detail** (`D-1104`, design section 9.3). Everything needing two live leases
 * is observed **while both children are still blocked**, because the moment a
 * child is released its lap may finish and `performLap`'s `finally` stops that
 * lease -- after which a poll is a stale-writer refusal and the two-live-lease
 * read is a race. The five steps are:
 *
 *   1. both children write their ready markers after the lap has acquired and
 *      materialised, and block;
 *   2. the parent, with both blocked, reads the `lease` table and asserts two
 *      live rows with the expected holders, resources and epochs;
 *   3. the parent starts each **built** endpoint from its lap's **rendered
 *      `mcp.json`**, polls, asserts the cross-delivery absences, acks, and
 *      attempts the cross-partition ack that must be refused;
 *   4. only then does the parent write the release file;
 *   5. both laps exit 0 without `LeaseHeld`, and the terminal assertions are
 *      taken after the exits.
 *
 * **Why the hold is in the child.** The endpoints belong to this test process,
 * so a barrier between *them* would not prove the two **laps** overlapped: lap
 * A could complete before lap B started and every endpoint assertion would
 * still pass. A lap's duration is its child's duration, so the child is the
 * only place a hold can go -- which is why `test/session/helpers/fake-claude.mjs`
 * carries one additive `FAKE_MODE` (`barrier`), the only one of its modes that
 * holds and then succeeds. The barrier is files, not signals: this file runs on
 * the Windows serial pass and POSIX signals are not portable there.
 *
 * **Why the endpoints are started from the rendered `mcp.json` rather than
 * from an env this test composes.** What has to be true is that the
 * *materialiser's own output* is what two concurrent endpoints run under. A
 * test-composed env would prove that two endpoints can be partitioned, not
 * that the two this lap configured are.
 *
 * **Two repositories, one control plane, one destination directory.** The
 * shared thing has to be the plane -- that is where the contended lease and
 * the partitioned rows live -- and the shared destination is what proves the
 * dropbox's fence file keys per run by itself. The repositories are separate on
 * purpose and it is not a weakening: git serialises its own index behind a lock
 * of its own, so two concurrent `git worktree add` calls on one repository
 * would inject a flake from a subsystem this entry does not touch.
 *
 * **Wall-clock budget** (`D-1103`, design section 9.4). This case is mandatory
 * in every `double-green` cell -- a credential-gated or opt-in case proves
 * nothing about the gate -- so it uses the repository fake child and never an
 * authenticated `claude`, reaches no network, and every wait it performs is
 * bounded and fails loudly rather than hanging. A barrier that can hang turns a
 * red cell into a cancelled one, which is the failure `D-1103` records as the
 * one that explains nothing.
 *
 * **Target-only.** No parity ledger claims this file, on the same ground as
 * `test/lap/cli.test.ts`: interlock has no composition root to port from.
 *
 * **This file starts real child processes** -- two built `lap perform`
 * processes, their two fake workers, and two built endpoints -- so it is listed
 * in `SPAWNING_TESTS` in `scripts/run-suite.mjs` and runs on the Windows serial
 * pass (`D-0048`).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";
import { main } from "../../src/cli.js";
import { dbCliSeams } from "../../src/control_plane/cli.js";
import {
  DELIVERY_LEASE_RESOURCE,
  deliveryResourceForRun,
} from "../../src/control_plane/delivery_resource.js";
import { KeyedDropbox } from "../../src/control_plane/destination.js";
import { openGate } from "../../src/control_plane/gates.js";
import { HUMAN_GATED_RECIPIENT, NOTIFY_RECIPIENT } from "../../src/control_plane/handlers.js";
import { acquire as acquireLease, release as releaseLease } from "../../src/control_plane/lease.js";
import { openProductionControlPlane } from "../../src/control_plane/migrator.js";
import { runCliSeams } from "../../src/control_plane/run_cli.js";
import { deliverRelays, presentGate } from "../../src/gate/operator.js";
import { DELIVERY_LEASE_TTL_MS } from "../../src/lap/endpoint_lease.js";
import { runGitChecked } from "../../src/workspace/git.js";
import { MCP_CONFIG_FILENAME } from "../../src/workspace/materializer.js";
import { StdioEndpointClient } from "../messagebus/helpers/stdio-endpoint.js";
import { type FakeMode, fakeCli } from "../session/helpers/fake-cli.js";
import { caseRoot } from "../testkit/cases.js";
import { patchSeams } from "../testkit/seams.js";

/** The built CLI, and the built endpoint: what an operator actually runs. */
const CLI_ENTRY = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const ENDPOINT_ENTRY = fileURLToPath(new URL("../../dist/messagebus/endpoint.js", import.meta.url));

/** An arbitrary fixed instant, for the setup verbs only. See {@link world}. */
const T0 = 1_700_000_000_000;
const BASE_BRANCH = "main";
const TOPIC_BRANCH = "feat/topic";
const ROLE = "worker";
const REPORT_TEXT = "The fence refuses the push. May I publish?";

/**
 * How long the parent waits for a marker, and how long a child waits for its
 * release. Both bounded, and the child's is the larger of the two so that a
 * parent giving up is the failure reported rather than a child timing out
 * first and turning the diagnosis into "the lap exited 1".
 */
const MARKER_WAIT_MS = 60_000;
const CHILD_BARRIER_TIMEOUT_S = "90";

/** How much of a captured child file the failure message carries. */
const EVIDENCE_TAIL_CHARS = 4_000;

/** The whole case, generously: six processes, two worktrees, one release. */
const CASE_TIMEOUT_MS = 180_000;

/** One lap's paths and, once started, its process. */
interface LapUnderTest {
  readonly runId: string;
  readonly repository: string;
  readonly workspace: string;
  readonly artifactDir: string;
  /**
   * The directory this lap's provider must end up writing under -- **derived**,
   * never passed (`D-1105`). Both laps are given one `--state-root` parent, so
   * this path existing with only this lap's session under it is the whole of
   * the evidence that the derivation happened.
   */
  readonly stateRoot: string;
  readonly readyMarker: string;
  readonly claudeCommand: readonly [string, string];
  readonly resource: string;
  child?: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  exitCode?: number | null;
}

/** A repository with one commit on {@link BASE_BRANCH}. */
function initRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  const git = { cwd: root, timeoutMs: 60_000 } as const;
  runGitChecked(["init", `--initial-branch=${BASE_BRANCH}`, "."], git);
  runGitChecked(["config", "user.name", "continuo test"], git);
  runGitChecked(["config", "user.email", "continuo@example.invalid"], git);
  runGitChecked(["config", "commit.gpgsign", "false"], git);
  writeFileSync(join(root, "README.md"), "seed\n", "utf8");
  runGitChecked(["add", "README.md"], git);
  runGitChecked(["commit", "-m", "seed"], git);
}

/**
 * One control plane and two admitted runs, both through the CLI.
 *
 * The setup verbs run at {@link T0} while the laps read the **real** wall
 * clock, and the split is deliberate: a real child fences against the system
 * clock, so a lease acquired at a frozen 2023 instant is already expired by the
 * time the endpoint writes under it. `test/gate/endpoint-relay.test.ts` records
 * the same requirement for the same reason.
 */
function world(label: string): {
  readonly root: string;
  readonly databasePath: string;
  readonly destinationDir: string;
  readonly stateRootParent: string;
  readonly laps: readonly [LapUnderTest, LapUnderTest];
  readonly releaseMarker: string;
} {
  const root = caseRoot(label);
  const databasePath = join(root, "production.sqlite3");
  const destinationDir = join(root, "destination");
  const releaseMarker = join(root, "release");
  // **One `--state-root` for both laps, and that is the point of the case**
  // (`D-1105`). Handing each lap its own would be what a careful caller does
  // and would prove nothing: the question is whether a caller that does NOT is
  // still safe, which is the situation `D-1104` created when it removed the
  // global delivery lease that had made two concurrent laps impossible.
  const stateRootParent = join(root, "state");

  const out: string[] = [];
  patchSeams(dbCliSeams, {
    write: (text: string) => {
      out.push(text);
    },
  });
  patchSeams(runCliSeams, {
    write: (text: string) => {
      out.push(text);
    },
  });

  expect(main(["db", "create", "--db", databasePath, "--now-ms", String(T0)])).toBe(0);

  const laps = (["a", "b"] as const).map((suffix): LapUnderTest => {
    const runId = `run-parallel-${suffix}`;
    const lapRoot = join(root, suffix);
    mkdirSync(lapRoot, { recursive: true });
    const repository = join(lapRoot, "repo");
    initRepository(repository);
    const workspace = join(lapRoot, "worktree");
    const artifactRoot = join(lapRoot, "artifacts");
    expect(
      main([
        "run",
        "admit",
        "--db",
        databasePath,
        "--run-id",
        runId,
        "--lease-claimant-id",
        `claimant-${suffix}`,
        "--workspace",
        workspace,
        "--role",
        ROLE,
        "--base-branch",
        BASE_BRANCH,
        "--topic-branch",
        TOPIC_BRANCH,
        "--prompt",
        "do the work",
        "--now-ms",
        String(T0),
      ]),
      out.join(""),
    ).toBe(0);
    return {
      runId,
      repository,
      workspace,
      artifactDir: join(artifactRoot, runId),
      stateRoot: join(stateRootParent, runId),
      readyMarker: join(root, `ready-${suffix}`),
      claudeCommand: fakeCli(lapRoot),
      resource: deliveryResourceForRun(runId),
      stdout: [],
      stderr: [],
    };
  }) as unknown as readonly [LapUnderTest, LapUnderTest];

  return { root, databasePath, destinationDir, stateRootParent, laps, releaseMarker };
}

/** Start one built `lap perform`, with its child held at the barrier. */
function startLap(
  lap: LapUnderTest,
  options: {
    readonly databasePath: string;
    readonly destinationDir: string;
    readonly stateRootParent: string;
    readonly releaseMarker: string;
  },
): void {
  const mode: FakeMode = "barrier";
  const child = spawn(
    process.execPath,
    [
      CLI_ENTRY,
      "lap",
      "perform",
      "--db",
      options.databasePath,
      "--run-id",
      lap.runId,
      "--repository",
      lap.repository,
      "--artifact-root",
      join(lap.artifactDir, ".."),
      // The shared PARENT, deliberately: what the provider writes under is
      // `lap.stateRoot`, and this command line is what has to derive it.
      "--state-root",
      options.stateRootParent,
      "--endpoint-recipient",
      NOTIFY_RECIPIENT,
      "--endpoint-destination-dir",
      options.destinationDir,
      // The BUILT endpoint, because the rendered `mcp.json` this test reads
      // back and spawns from has to name the module an operator would run.
      "--endpoint-module",
      ENDPOINT_ENTRY,
      "--node",
      process.execPath,
      "--interlock-root",
      lap.repository,
      "--claude-org-path",
      join(lap.repository, "claude-org"),
      "--poll-interval-ms",
      "10",
      "--turn-timeout-ms",
      "120000",
      "--git-timeout-ms",
      "60000",
      "--claude-command",
      lap.claudeCommand[0],
      "--claude-command",
      lap.claudeCommand[1],
    ],
    {
      // `pipe` on stdin too, though nothing is written to it: the typed
      // overload for `ignore` on stdin hands back a narrower child than the
      // two readable streams this test reads, and an open, unused stdin is
      // what the endpoint spawn below uses as well.
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        FAKE_MODE: mode,
        FAKE_RESULT_TEXT: REPORT_TEXT,
        FAKE_BARRIER_READY: lap.readyMarker,
        FAKE_BARRIER_RELEASE: options.releaseMarker,
        FAKE_BARRIER_TIMEOUT: CHILD_BARRIER_TIMEOUT_S,
      },
    },
  ) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => lap.stdout.push(chunk));
  child.stderr.on("data", (chunk: string) => lap.stderr.push(chunk));
  child.once("close", (code) => {
    lap.exitCode = code;
  });
  lap.child = child;
  onTestFinished(() => {
    if (lap.exitCode === undefined) {
      child.kill();
    }
  });
}

/** Wait until *path* exists, or fail loudly at the deadline. */
async function waitForFile(path: string, what: string, extra: () => string): Promise<void> {
  const deadline = Date.now() + MARKER_WAIT_MS;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      // Loudly, and with the child's own words: a bare timeout here would
      // report "the parent waited" and hide the refusal that stopped the lap.
      throw new Error(`${what} never appeared at ${path} within ${MARKER_WAIT_MS}ms.\n${extra()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The env the materialiser actually wrote for this lap's endpoint. */
function renderedEndpointEnv(lap: LapUnderTest): {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
} {
  const path = join(lap.artifactDir, MCP_CONFIG_FILENAME);
  const document = JSON.parse(readFileSync(path, "utf-8")) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const servers = Object.values(document.mcpServers);
  expect(servers, `${path} named no MCP server`).toHaveLength(1);
  const server = servers[0];
  if (server === undefined) {
    throw new Error(`${path} named no MCP server`);
  }
  return { command: server.command, args: server.args, env: server.env };
}

/** Start one built endpoint from a lap's own rendered configuration. */
async function startEndpoint(lap: LapUnderTest): Promise<StdioEndpointClient> {
  expect(
    existsSync(ENDPOINT_ENTRY),
    `${ENDPOINT_ENTRY} is missing: this file runs the BUILT endpoint, so run npm run build`,
  ).toBe(true);
  const rendered = renderedEndpointEnv(lap);
  const child = spawn(rendered.command, [...rendered.args], {
    stdio: ["pipe", "pipe", "pipe"],
    // The rendered env and nothing else of ours that could contradict it: the
    // point of reading it back is that the materialiser's output is what runs.
    env: { ...process.env, ...rendered.env },
  }) as ChildProcessWithoutNullStreams;
  const stderr: string[] = [];
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  onTestFinished(async () => {
    child.kill();
    await new Promise((resolve) => child.once("close", resolve));
    // A startup refusal is the death this file must not mistake for an empty
    // queue, and the resource admission is exactly what `D-1104` widened.
    expect(stderr.join("")).not.toContain("FATAL:");
  });
  const client = new StdioEndpointClient(child);
  await client.handshake();
  return client;
}

/** Read one outbox row's ownership columns. */
function ownership(
  connection: SqliteDatabase,
  messageId: string,
): { status: string; writer_epoch: number | null; delivery_resource: string } {
  const row = connection
    .prepare<[string], { status: string; writer_epoch: number | null; delivery_resource: string }>(
      "SELECT status, writer_epoch, delivery_resource FROM outbox WHERE message_id = ?",
    )
    .get(messageId);
  if (row === undefined) {
    throw new Error(`no outbox row ${messageId}`);
  }
  return row;
}

/** Open a gate for *runId* and enqueue its `presented` relay. */
function relayFor(
  connection: SqliteDatabase,
  runId: string,
  gateId: string,
  nowMs: number,
): string {
  const originEventSeq = (
    connection.prepare<[], { seq: number }>("SELECT MAX(seq) AS seq FROM event").get() ?? { seq: 1 }
  ).seq;
  openGate(connection, {
    gateId,
    gateType: "worker_escalation",
    subjectKind: "run",
    subjectId: runId,
    rationale: "the parallel-lap proof needs a row in each partition",
    originEventSeq,
    createdAtMs: nowMs,
    actorKind: "system",
    actorId: "parallel-laps-test",
    runId,
  });
  return presentGate(connection, { gateId, nowMs }).messageId;
}

/**
 * A control row addressed to a recipient neither endpoint serves, in one
 * partition, written past the module.
 *
 * Raw because it is a control and not a producer under test: what it asserts is
 * that the recipient term on `due` excludes it, and the honest way to place a
 * row of a shape no in-tree producer writes is to write it directly. The
 * companion columns 0003's `CASE` requires are spelled out for the same reason.
 */
function offRecipientRow(
  connection: SqliteDatabase,
  messageId: string,
  resource: string,
  nowMs: number,
): void {
  connection
    .prepare<[string, string, string, string, number, string]>(
      `INSERT INTO outbox (message_id, run_id, recipient, payload, dedup_key, status,
                           retry_count, enqueued_at_ms, delivery_resource)
       VALUES (?, NULL, ?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .run(messageId, HUMAN_GATED_RECIPIENT, "{}", messageId, nowMs, resource);
}

/**
 * The session directories under one state root, by name.
 *
 * "A subdirectory holding a `record.json`" is `#discoverRecords`'s own rule
 * (`src/session/claude_cli_provider.ts`), so this reads the roster the provider
 * would build rather than a listing of everything on disk -- `probe-evidence.txt`
 * lives at the root of the state root and is not a session.
 */
function sessionsUnder(stateRoot: string): readonly string[] {
  if (!existsSync(stateRoot)) {
    return [];
  }
  return readdirSync(stateRoot)
    .filter((entry) => existsSync(join(stateRoot, entry, "record.json")))
    .sort();
}

/**
 * Everything the runner knows about why a lap's child stopped, as text.
 *
 * **Written for a failure this test could not explain, and it explained it.**
 * At `019e3b8a` -- this file's own merge, before it was touched again -- the
 * Windows cell failed with `[0, 2]`: every step-2 and step-3 assertion passing,
 * both leases live, both endpoints partitioned, and one lap exiting 2 with "the
 * child ... is gone without writing a result event", and the same failure
 * recurred on the next branch to touch this file. The lap's own stderr says
 * only that the child went; **why it went is in the child's captured stderr and
 * event stream**, which the provider writes into the session directory as
 * `stderr-<generation>.log` and `events-<generation>.jsonl` -- files that live
 * on the runner and are thrown away with it.
 *
 * So the evidence is pulled into the assertion message, and the next red cell
 * settled the question in one run: three children across two Node versions had
 * a **complete `result` line** in their transcripts and an empty stderr. That
 * is `D-1106` -- the provider read the transcript and asked whether the child
 * was still running in that order, so a child that wrote its last line and
 * exited in between was reported as having written nothing. The ordering is
 * fixed and `test/session/liveness-read-ordering.test.ts` holds it.
 *
 * **This function stays, and not out of sentiment.** `D-1106` closed one way
 * for a child to be reported gone with no report; the message an operator and
 * this case see is the same for every other way -- a child that died
 * mid-stream, a barrier deadline the fake announces on its own stderr, a
 * transcript that was truncated. The lap will never say which. Nothing else
 * here reads those two files, and the cost of keeping them is two small reads
 * when the message is built.
 *
 * Reading is best-effort and never throws: this runs while a test is already
 * failing, and a diagnostic that raises replaces the failure being diagnosed.
 * Each file is tailed rather than quoted whole, because an event stream is
 * unbounded and only its end is in question.
 */
function childEvidence(lap: LapUnderTest): string {
  const tail = (path: string): string => {
    try {
      const text = readFileSync(path, "utf8");
      return text.length > EVIDENCE_TAIL_CHARS ? `...${text.slice(-EVIDENCE_TAIL_CHARS)}` : text;
    } catch (error) {
      return `<unreadable: ${String(error)}>`;
    }
  };
  if (!existsSync(lap.stateRoot)) {
    return `${lap.runId}: no state root at ${lap.stateRoot}`;
  }
  const lines: string[] = [`${lap.runId}: state root ${lap.stateRoot}`];
  for (const session of readdirSync(lap.stateRoot)) {
    const dir = join(lap.stateRoot, session);
    let entries: readonly string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // `probe-evidence.txt` and anything else that is a file rather than a
      // session directory: not an error, just not evidence.
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith("stderr-") || entry.startsWith("events-")) {
        lines.push(`--- ${session}/${entry} ---`, tail(join(dir, entry)));
      }
    }
  }
  return lines.join("\n");
}

describe("two laps on one control plane, at the same instant (target-only)", () => {
  test(
    "both laps hold their own delivery lease, and neither reaches the other's rows",
    async () => {
      const w = world("parallel");
      const [lapA, lapB] = w.laps;

      // ---- step 1: both children reach the barrier and block ----------------
      startLap(lapA, w);
      startLap(lapB, w);
      await waitForFile(
        lapA.readyMarker,
        "lap A's ready marker",
        () => `lap A stdout: ${lapA.stdout.join("")}\nlap A stderr: ${lapA.stderr.join("")}`,
      );
      await waitForFile(
        lapB.readyMarker,
        "lap B's ready marker",
        () => `lap B stdout: ${lapB.stdout.join("")}\nlap B stderr: ${lapB.stderr.join("")}`,
      );
      // Neither has exited. This is the assertion that makes every one below it
      // an assertion about two CONCURRENT laps rather than about two laps.
      expect(lapA.exitCode, `lap A exited before the barrier: ${lapA.stderr.join("")}`).toBe(
        undefined,
      );
      expect(lapB.exitCode, `lap B exited before the barrier: ${lapB.stderr.join("")}`).toBe(
        undefined,
      );

      const connection = openProductionControlPlane(w.databasePath);
      onTestFinished(() => {
        connection.close();
      });

      // ---- step 2: two live leases, with both children still blocked -------
      const nowMs = Date.now();
      const leases = connection
        .prepare<[number], { resource: string; holder: string; epoch: number }>(
          "SELECT resource, holder, epoch FROM lease WHERE expires_at_ms > ? ORDER BY resource",
        )
        .all(nowMs);
      const delivery = leases.filter((row) => row.resource.startsWith(DELIVERY_LEASE_RESOURCE));
      expect(
        delivery.map((row) => ({ resource: row.resource, holder: row.holder, epoch: row.epoch })),
      ).toEqual([
        { resource: lapA.resource, holder: "claimant-a", epoch: 1 },
        { resource: lapB.resource, holder: "claimant-b", epoch: 1 },
      ]);
      // **The anti-vacuity control for the whole file, and it belongs here.**
      // Two live leases at epoch 1 could mean the exclusion was removed rather
      // than partitioned. It was not: a second claim on the SAME resource is
      // still refused, which is what says the concurrency above comes from the
      // two names differing.
      expect(() =>
        acquireLease(connection, {
          resource: lapA.resource,
          holder: "a-third-party",
          nowMs,
          ttlMs: DELIVERY_LEASE_TTL_MS,
        }),
      ).toThrowError(/held/);

      // ---- step 3: two endpoints, from the two rendered configurations -----
      // Each lap's `mcp.json` must name its own resource, or the endpoint the
      // worker runs is fenced under a lease its launcher does not hold.
      expect(renderedEndpointEnv(lapA).env["INTERLOCK_MESSAGEBUS_RESOURCE"]).toBe(lapA.resource);
      expect(renderedEndpointEnv(lapB).env["INTERLOCK_MESSAGEBUS_RESOURCE"]).toBe(lapB.resource);
      expect(renderedEndpointEnv(lapA).env["INTERLOCK_MESSAGEBUS_EPOCH"]).toBe("1");

      const messageA = relayFor(connection, lapA.runId, "gate-parallel-a", nowMs);
      const messageB = relayFor(connection, lapB.runId, "gate-parallel-b", nowMs);
      expect(ownership(connection, messageA).delivery_resource).toBe(lapA.resource);
      expect(ownership(connection, messageB).delivery_resource).toBe(lapB.resource);
      const controlA = "control/a";
      const controlB = "control/b";
      offRecipientRow(connection, controlA, lapA.resource, nowMs);
      offRecipientRow(connection, controlB, lapB.resource, nowMs);

      const endpointA = await startEndpoint(lapA);
      const endpointB = await startEndpoint(lapB);

      const polledA = (await endpointA.callTool("poll")) as { messages: { message_id: string }[] };
      const polledB = (await endpointB.callTool("poll")) as { messages: { message_id: string }[] };
      const idsA = polledA.messages.map((message) => message.message_id);
      const idsB = polledB.messages.map((message) => message.message_id);
      // **Negative evidence is the substance; the positive half is the setup.**
      // A's message is absent from B's result, not filtered out of it.
      expect(idsA).toEqual([messageA]);
      expect(idsB).toEqual([messageB]);
      expect(idsA).not.toContain(messageB);
      expect(idsB).not.toContain(messageA);

      // Each delivered row carries its own resource and its own epoch, and the
      // off-recipient controls are untouched by either endpoint.
      expect(ownership(connection, messageA)).toEqual({
        status: "delivered",
        writer_epoch: 1,
        delivery_resource: lapA.resource,
      });
      expect(ownership(connection, messageB)).toEqual({
        status: "delivered",
        writer_epoch: 1,
        delivery_resource: lapB.resource,
      });
      expect(ownership(connection, controlA)).toEqual({
        status: "pending",
        writer_epoch: null,
        delivery_resource: lapA.resource,
      });
      expect(ownership(connection, controlB)).toEqual({
        status: "pending",
        writer_epoch: null,
        delivery_resource: lapB.resource,
      });

      // The dropbox honoured a token under EACH resource's own key. This is
      // what makes the partition coherent end to end rather than only in the
      // database: had the resource stayed global while the epochs went per run,
      // one run's epoch 1 would be refused as stale against the other's
      // watermark, in a destination they share.
      const fence = new KeyedDropbox(w.destinationDir, "parallel-laps-test");
      expect(fence.honouredToken(lapA.resource)).toBe(1);
      expect(fence.honouredToken(lapB.resource)).toBe(1);

      // **The one hazard partitioning the poll does not close.** The id an
      // endpoint acks is caller-supplied, so B is handed A's id DIRECTLY --
      // past its own poll, which correctly never returned it -- and must
      // refuse. Without the ack's resource equality this succeeds, and A's gate
      // would later advance on evidence B produced.
      const crossAck = await endpointB.callToolRaw("ack", { message_id: messageA });
      expect(crossAck.isError, crossAck.text).toBe(true);
      expect(crossAck.text).toContain("belongs to delivery resource");
      expect(ownership(connection, messageA).status).toBe("delivered");

      // Each endpoint settles its own, which is the positive half of the same
      // check: the refusal above must not be "this endpoint cannot ack".
      const ackA = (await endpointA.callTool("ack", { message_id: messageA })) as {
        recorded: boolean;
      };
      expect(ackA.recorded).toBe(true);
      expect(ownership(connection, messageA).status).toBe("acked");

      // ---- step 4: release, and only now ----------------------------------
      writeFileSync(w.releaseMarker, "go\n", "utf8");

      // ---- step 5: both laps exit 0, with no LeaseHeld --------------------
      const codes = await Promise.all(
        [lapA, lapB].map(
          (lap) =>
            new Promise<number | null>((resolve) => {
              if (lap.exitCode !== undefined) {
                resolve(lap.exitCode);
                return;
              }
              lap.child?.once("close", (code) => resolve(code));
            }),
        ),
      );
      // The two laps' own stderr, and -- because the lap only ever says that
      // its child went, never why -- what the children themselves wrote. See
      // {@link childEvidence}.
      expect(
        codes,
        `A: ${lapA.stderr.join("")}\nB: ${lapB.stderr.join("")}\n` +
          `${childEvidence(lapA)}\n${childEvidence(lapB)}`,
      ).toEqual([0, 0]);
      for (const lap of [lapA, lapB]) {
        expect(lap.stderr.join("") + lap.stdout.join("")).not.toContain("LeaseHeld");
      }

      // **Two laps, one `--state-root`, two state roots** (`D-1105`). Both
      // command lines above named `w.stateRootParent` and nothing else; what
      // the two providers wrote under is one derived directory each. Taken
      // after the exits because that is when every record and the probe
      // evidence have been written.
      //
      // The parent's own children are asserted exactly, and that is the half
      // that goes red when the derivation is removed: a lap built over the
      // parent puts its session directory -- named by a session uuid -- and
      // `probe-evidence.txt` there instead, so the listing is neither run id.
      expect(readdirSync(w.stateRootParent).sort()).toEqual([lapA.runId, lapB.runId].sort());
      const sessionsA = sessionsUnder(lapA.stateRoot);
      const sessionsB = sessionsUnder(lapB.stateRoot);
      // One session under each, and the two are different sessions: the second
      // half is what says the rosters are disjoint rather than identical.
      expect(sessionsA).toHaveLength(1);
      expect(sessionsB).toHaveLength(1);
      expect(sessionsA).not.toEqual(sessionsB);
      // `#discoverRecords` reads exactly this listing, so a lap's roster
      // carries its own session and no other run's -- which is the hazard
      // `D-1104` point 21 measured and left open.
      expect(sessionsA).not.toContain(sessionsB[0]);
      // The probe wrote into the derived directory too, so nothing about this
      // lap's state landed in the shared parent.
      expect(existsSync(join(lapA.stateRoot, "probe-evidence.txt"))).toBe(true);
      expect(existsSync(join(lapB.stateRoot, "probe-evidence.txt"))).toBe(true);

      // Both leases were released by their own laps, and neither withheld
      // anything from the other.
      const afterExit = connection
        .prepare<[number], { resource: string }>(
          "SELECT resource FROM lease WHERE expires_at_ms > ? AND resource LIKE 'outbox-delivery%'",
        )
        .all(Date.now());
      expect(afterExit).toEqual([]);

      // **The post-lap window, and the observed-red control for P-10.** A relay
      // enqueued after both laps exited is run-bound, and a globally-pinned
      // drainer never selects it -- which is the ordinary path, not an edge
      // case, because `gate present` and `gate answer` run during the human
      // suspend, after `lap perform` has returned. The global pass delivering
      // nothing IS the control: it is what the verb did before this change.
      const postLap = relayFor(connection, lapB.runId, "gate-post-lap", Date.now());
      const globalPass = deliverRelays(connection, {
        holder: "operator-global",
        destinationDir: w.destinationDir,
        nowMs: Date.now(),
        ttlMs: DELIVERY_LEASE_TTL_MS,
      });
      expect(globalPass.delivered.map((message) => message.messageId)).not.toContain(postLap);
      const runPass = deliverRelays(connection, {
        holder: "operator-run-b",
        destinationDir: w.destinationDir,
        runId: lapB.runId,
        nowMs: Date.now(),
        ttlMs: DELIVERY_LEASE_TTL_MS,
      });
      expect(runPass.delivered.map((message) => message.messageId)).toContain(postLap);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a lap is still refused while THIS run's delivery lease is held, and not while another run's is",
    async () => {
      // The retained refusal, and its complement, in one case: `D-1104`
      // narrows `LeaseHeld` from "a lap is running" to "this run's lap is
      // running" -- it does not remove it. One lap process is enough for both
      // halves, so this case pays for no second child.
      const w = world("refusal");
      const [lap, other] = w.laps;
      const connection = openProductionControlPlane(w.databasePath);
      onTestFinished(() => {
        connection.close();
      });

      // Another run's resource, and the global one, are both held: neither is
      // this lap's, so neither may refuse it.
      const nowMs = Date.now();
      for (const resource of [other.resource, DELIVERY_LEASE_RESOURCE]) {
        acquireLease(connection, {
          resource,
          holder: "somebody-else",
          nowMs,
          ttlMs: DELIVERY_LEASE_TTL_MS,
        });
      }
      startLap(lap, w);
      await waitForFile(
        lap.readyMarker,
        "the lap's ready marker",
        () => `stdout: ${lap.stdout.join("")}\nstderr: ${lap.stderr.join("")}`,
      );
      writeFileSync(w.releaseMarker, "go\n", "utf8");
      const code = await new Promise<number | null>((resolve) => {
        if (lap.exitCode !== undefined) {
          resolve(lap.exitCode);
          return;
        }
        lap.child?.once("close", (exit) => resolve(exit));
      });
      expect(code, lap.stderr.join("")).toBe(0);

      // Now this run's own resource is held, and the refusal lands -- at the
      // acquisition, which is before the worktree, the fence and any child.
      const held = acquireLease(connection, {
        resource: lap.resource,
        holder: "a-running-lap",
        nowMs: Date.now(),
        ttlMs: DELIVERY_LEASE_TTL_MS,
      });
      onTestFinished(() => {
        releaseLease(connection, held, { nowMs: Date.now() });
      });
      const second: LapUnderTest = {
        ...lap,
        readyMarker: join(w.root, "ready-refused"),
        stdout: [],
        stderr: [],
      };
      startLap(second, w);
      const refusedCode = await new Promise<number | null>((resolve) => {
        second.child?.once("close", (exit) => resolve(exit));
      });
      expect(refusedCode).not.toBe(0);
      expect(second.stdout.join("") + second.stderr.join("")).toContain(lap.resource);
      // The marker is the evidence that no child ran: a refusal at the
      // acquisition happens before the lap has anything to hold.
      expect(existsSync(second.readyMarker)).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );
});
