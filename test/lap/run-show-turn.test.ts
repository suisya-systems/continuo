/**
 * `run show --state-root`: a running lap's turn so far, so a host reads it from
 * a field and not from the provider's state-root layout (D-1124, issue #218).
 *
 * Target-only. The session directory is written by hand in the Claude
 * provider's on-disk shape (`record.json`, `events-NNN.jsonl`), because that
 * layout is exactly what this verb is meant to keep out of a host: if the
 * reader stopped composing it, these cases would read nothing and go red.
 *
 * Here and not under `test/control_plane/`, because a case that knows the
 * provider's files beside the control plane is the join that directory's
 * suite is kept free of.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { expect, onTestFinished, test } from "vitest";

import { main } from "../../src/cli.js";
import { LapRunIntent } from "../../src/control_plane/lap_run_intent.js";
import type { Lease } from "../../src/control_plane/lease.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { admitRun } from "../../src/control_plane/run_admission.js";
import { runCliSeams } from "../../src/control_plane/run_cli.js";
import { acquireRunLease } from "../../src/control_plane/run_lifecycle.js";
import { prepareBinding, releaseBinding } from "../../src/control_plane/session_binding.js";
import { COMMAND_OUTPUT_LIMIT } from "../../src/lap/cli.js";
import { lapStateRoot } from "../../src/lap/root.js";
import { caseRoot } from "../testkit/cases.js";
import { aDelegationRecord } from "../testkit/delegation.js";
import { patchSeam } from "../testkit/seams.js";

const T0 = 1_700_000_000_000;
const RUN_ID = "run/218";
const SESSION_ID = "22222222-2222-5222-8222-222222222222";

/** A control plane holding one admitted run with one bound session. */
function fixture(provider: string): {
  path: string;
  connection: SqliteDatabase;
  root: string;
  lease: Lease;
} {
  const root = caseRoot("run-show-turn");
  const path = join(root, "cp.sqlite3");
  createProductionControlPlane(path, { nowMs: T0 }).close();
  const connection = openProductionControlPlane(path);
  onTestFinished(() => {
    connection.close();
  });
  admitRun(connection, {
    delegationRecord: aDelegationRecord(),
    intent: new LapRunIntent({
      runId: RUN_ID,
      leaseClaimantId: "secretary-1",
      workspace: resolve(root, "wt"),
      role: "worker",
      baseBranch: "main",
      topicBranch: "feat/218",
      prompt: "do the thing",
    }),
    nowMs: T0,
  });
  const lease = acquireRunLease(connection, {
    runId: RUN_ID,
    holder: "lap-1",
    nowMs: T0,
    ttlMs: 300_000,
  });
  prepareBinding(connection, lease, { sessionId: SESSION_ID, runId: RUN_ID, provider, nowMs: T0 });
  return { path, connection, root, lease };
}

/** The session directory a Claude lap leaves under `<parent>/<run id>/`, mid-turn. */
function writeSession(parent: string, generation: number, transcript: string): void {
  const directory = join(lapStateRoot(parent, RUN_ID), SESSION_ID);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "record.json"),
    JSON.stringify({
      session_id: SESSION_ID,
      claude_session_uuid: "33333333-3333-5333-8333-333333333333",
      workspace: resolve(parent, "wt"),
      role: "worker",
      resume_prompt: "go on",
      cli_args: [],
      generation,
      argv: ["claude"],
      pid: 4242,
      pgid: 4242,
      incident: null,
    }),
  );
  writeFileSync(join(directory, `events-${String(generation).padStart(3, "0")}.jsonl`), transcript);
}

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

/** `run show --json`'s sessions, from the one line it wrote. */
function showSessions(path: string, extra: readonly string[]): Record<string, unknown>[] {
  const chunks: string[] = [];
  patchSeam(runCliSeams, "write", (text: string) => {
    chunks.push(text);
  });
  expect(main(["run", "show", "--db", path, "--run-id", RUN_ID, "--json", ...extra])).toBe(0);
  const document = JSON.parse(chunks.join("")) as { sessions: Record<string, unknown>[] };
  return document.sessions;
}

const LONG_OUTPUT = "x".repeat(COMMAND_OUTPUT_LIMIT + 10);

const TRANSCRIPT =
  line({ type: "system", subtype: "init" }) +
  line({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
  }) +
  line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: LONG_OUTPUT }] },
  }) +
  line({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a" } }],
    },
  }) +
  '{"type":"user","message":';

test("names the running turn's commands in lap perform's shape, capped, and its partial line", () => {
  const { path, root } = fixture("claude-cli");
  const parent = join(root, "state");
  writeSession(parent, 1, TRANSCRIPT);

  const [session] = showSessions(path, ["--state-root", parent]);

  expect(session?.["turn"]).toStrictEqual({
    generation: 1,
    commands: [
      {
        index: 2,
        command: "ls",
        output: "x".repeat(COMMAND_OUTPUT_LIMIT),
        output_omitted_chars: 10,
        is_error: false,
      },
      // A call whose result has not arrived yet.
      {
        index: 4,
        command: 'Read {"file_path":"/a"}',
        output: "",
        output_omitted_chars: 0,
        is_error: false,
      },
    ],
    partial_line: true,
  });
});

test("a transcript ending on a newline has no partial line", () => {
  const { path, root } = fixture("claude-cli");
  const parent = join(root, "state");
  writeSession(parent, 0, line({ type: "system", subtype: "init" }));

  const [session] = showSessions(path, ["--state-root", parent]);

  expect(session?.["turn"]).toStrictEqual({ generation: 0, commands: [], partial_line: false });
});

test("turn is null without --state-root, for a missing record, for Codex, and once released", () => {
  const claude = fixture("claude-cli");
  const parent = join(claude.root, "state");
  writeSession(parent, 1, TRANSCRIPT);
  expect(showSessions(claude.path, [])[0]?.["turn"]).toBeNull();
  expect(
    showSessions(claude.path, ["--state-root", join(claude.root, "elsewhere")])[0]?.["turn"],
  ).toBeNull();

  const codex = fixture("codex-cli");
  writeSession(join(codex.root, "state"), 1, TRANSCRIPT);
  expect(
    showSessions(codex.path, ["--state-root", join(codex.root, "state")])[0]?.["turn"],
  ).toBeNull();

  releaseBinding(claude.connection, claude.lease, {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    nowMs: T0 + 1,
  });
  expect(showSessions(claude.path, ["--state-root", parent])[0]?.["turn"]).toBeNull();
});
