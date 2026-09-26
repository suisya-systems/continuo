/**
 * `continuo workspace remove`: the cleanup after a merge (`D-1119`, #230).
 *
 * Target-only: interlock has no such verb. Every case drives `src/cli.ts`'s
 * `main`, so a verb nothing mounts cannot stay green. The fixture is a real git
 * repository with a real worktree and a `workspace_materialized` event naming
 * it, appended directly rather than through the materialiser, whose fence and
 * endpoint preconditions have nothing to do with removal.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { helpStrings } from "../../src/cli/parser.js";
import { buildParser, main } from "../../src/cli.js";
import { appendEvent } from "../../src/control_plane/events.js";
import { LapRunIntent } from "../../src/control_plane/lap_run_intent.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { admitRun } from "../../src/control_plane/run_admission.js";
import { closeRun } from "../../src/control_plane/run_close.js";
import { workspaceCliSeams } from "../../src/workspace/cli.js";
import {
  branchExists,
  type GitOptions,
  repositoryRoot,
  runGitChecked,
} from "../../src/workspace/git.js";
import { WORKSPACE_MATERIALIZED_EVENT_TYPE } from "../../src/workspace/materializer.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { aDelegationRecord } from "../testkit/delegation.js";
import { patchSeam } from "../testkit/seams.js";

const T0 = 1_700_000_000_000;
const RUN_ID = "run-1";
const TOPIC = "feat/run-1";
const SCHEMA = "continuo.workspace.remove/1";

const template = suiteTemplate("workspace-cli.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

interface Fixture {
  readonly path: string;
  readonly connection: SqliteDatabase;
  readonly repository: string;
  readonly workspace: string;
  readonly git: GitOptions;
}

/**
 * A control plane holding one admitted run whose worktree exists.
 *
 * `materialize: false` leaves the event out; `close: false` leaves the run at
 * `created`.
 */
function fixture(options: { materialize?: boolean; close?: boolean } = {}): Fixture {
  const root = caseRoot("workspace-cli");
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  const setup: GitOptions = { cwd: repoDir, timeoutMs: 60_000 };
  runGitChecked(["init", "--initial-branch=main", "."], setup);
  runGitChecked(["config", "user.name", "continuo test"], setup);
  runGitChecked(["config", "user.email", "continuo@example.invalid"], setup);
  runGitChecked(["config", "commit.gpgsign", "false"], setup);
  writeFileSync(join(repoDir, "README.md"), "seed\n", "utf8");
  runGitChecked(["add", "README.md"], setup);
  runGitChecked(["commit", "-m", "seed"], setup);
  const repository = repositoryRoot(setup);
  const git: GitOptions = { cwd: repository, timeoutMs: 60_000 };
  const workspace = join(repository, "..", "wt");
  runGitChecked(["worktree", "add", "--no-track", "-b", TOPIC, workspace, "main"], git);

  const path = template.copyInto(root);
  const connection = openProductionControlPlane(path);
  onTestFinished(() => {
    connection.close();
  });
  admitRun(connection, {
    delegationRecord: aDelegationRecord(),
    intent: new LapRunIntent({
      runId: RUN_ID,
      leaseClaimantId: "secretary-1",
      workspace,
      role: "worker",
      baseBranch: "main",
      topicBranch: TOPIC,
      prompt: "port the thing",
    }),
    nowMs: T0,
  });
  if (options.materialize !== false) {
    appendEvent(connection, {
      eventId: "evt-materialized",
      eventType: WORKSPACE_MATERIALIZED_EVENT_TYPE,
      subjectKind: "run",
      subjectId: RUN_ID,
      dedupKey: "materialized:run-1",
      producer: "workspace_materializer",
      occurredAtMs: T0,
      ingestedAtMs: T0,
      runId: RUN_ID,
      payload: JSON.stringify({ repository, topic_branch: TOPIC, workspace }),
    });
  }
  if (options.close !== false) {
    closeRun(connection, { runId: RUN_ID, outcome: "completed", actorId: "op", nowMs: T0 + 1 });
  }
  return { path, connection, repository, workspace, git };
}

function capture(): { out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  patchSeam(workspaceCliSeams, "write", (text: string) => {
    out.push(text);
  });
  patchSeam(workspaceCliSeams, "writeError", (text: string) => {
    err.push(text);
  });
  return { out: () => out.join(""), err: () => err.join("") };
}

function remove(path: string, json = false): number {
  return main([
    "workspace",
    "remove",
    "--db",
    path,
    "--run-id",
    RUN_ID,
    ...(json ? ["--json"] : []),
  ]);
}

function eventCount(connection: SqliteDatabase): number {
  return (connection.prepare("SELECT COUNT(*) AS n FROM event").get() as { n: number }).n;
}

describe("continuo workspace remove", () => {
  test("removes the worktree, keeps the branch, appends no event, and is idempotent", () => {
    const f = fixture();
    const events = eventCount(f.connection);
    const streams = capture();

    expect(remove(f.path, true)).toBe(0);
    expect(streams.err()).toBe("");
    expect(JSON.parse(streams.out())).toStrictEqual({
      schema: SCHEMA,
      ok: true,
      db: f.path,
      run_id: RUN_ID,
      workspace: f.workspace,
      repository: f.repository,
      topic_branch: TOPIC,
      outcome: "removed",
    });
    expect(existsSync(f.workspace)).toBe(false);
    expect(branchExists(TOPIC, f.git)).toBe(true);
    expect(eventCount(f.connection)).toBe(events);

    // The retry a host makes after a crash: nothing left to do, and not an error.
    const again = capture();
    expect(remove(f.path)).toBe(0);
    expect(again.out()).toContain("already absent:");
    expect(again.out()).toContain(`branch ${TOPIC} left in place`);
  });

  test("removes a worktree whose directory is already gone but git still lists", () => {
    const f = fixture();
    renameSync(f.workspace, `${f.workspace}-moved`);
    const streams = capture();

    expect(remove(f.path, true)).toBe(0);
    expect(JSON.parse(streams.out())["outcome"]).toBe("removed");
    expect(runGitChecked(["worktree", "list", "--porcelain"], f.git).stdout).not.toContain("wt\n");
  });

  test("refuses a dirty worktree and leaves it in place", () => {
    const f = fixture();
    writeFileSync(join(f.workspace, "work.txt"), "unsaved\n", "utf8");
    const streams = capture();

    expect(remove(f.path, true)).toBe(2);
    expect(streams.out()).toBe("");
    const doc = JSON.parse(streams.err()) as { ok: boolean; error: { class: string } };
    expect(doc.ok).toBe(false);
    expect(doc.error.class).toBe("GitCommandFailed");
    expect(existsSync(join(f.workspace, "work.txt"))).toBe(true);
  });

  test("refuses a run that is not terminal", () => {
    const f = fixture({ close: false });
    const streams = capture();

    expect(remove(f.path)).toBe(2);
    expect(streams.err()).toMatch(/^error: run run-1 is at status created; close it/);
    expect(existsSync(f.workspace)).toBe(true);
  });

  test("refuses a run with no workspace_materialized event", () => {
    const f = fixture({ materialize: false });
    const streams = capture();

    expect(remove(f.path, true)).toBe(2);
    const doc = JSON.parse(streams.err()) as { error: { class: string; message: string } };
    expect(doc.error.class).toBe("WorkspaceRemoveRefused");
    expect(doc.error.message).toContain("no workspace_materialized event");
    expect(existsSync(f.workspace)).toBe(true);
  });

  test("refuses a path that exists but is no longer a worktree of the repository", () => {
    const f = fixture();
    runGitChecked(["worktree", "remove", f.workspace], f.git);
    mkdirSync(f.workspace);
    const streams = capture();

    expect(remove(f.path)).toBe(2);
    expect(streams.err()).toContain("is not a worktree of");
    expect(existsSync(f.workspace)).toBe(true);
  });

  test("is reachable from the top-level parser", () => {
    expect(
      helpStrings(buildParser()).some((text) => text.startsWith("Remove the git worktree")),
    ).toBe(true);
  });
});
