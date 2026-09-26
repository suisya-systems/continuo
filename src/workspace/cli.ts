/**
 * `continuo workspace remove`: sweep up the worktree a closed run was
 * materialised into (`D-1119`).
 *
 * Mounted into the unified CLI by `src/cli.ts`, which owns no flag of its own
 * here (`D-0030`). The host calls it after a merge (rondo `D-0064` section 5):
 * rondo reaches continuo only through this CLI, so the library export
 * {@link removeWorktree} was not enough on its own.
 *
 * **What it removes, and what it leaves.** The one worktree the run's
 * `workspace_materialized` event names, in the repository that event names --
 * never a path supplied on the command line, so the verb cannot be pointed at a
 * directory the run did not create. The topic branch is left alone: it is what
 * the pull request was opened from, and whether it goes is the forge's and the
 * operator's decision, not a cleanup's.
 *
 * **The four rules `D-1119` settles.**
 *
 * 1. The run must be terminal. A clean worktree that a live lap is still
 *    running in is not a leftover, and git's dirty check cannot tell the two
 *    apart.
 * 2. A worktree with uncommitted changes is refused, by git itself:
 *    {@link removeWorktree} never passes `--force`, and there is no flag here
 *    that would.
 * 3. A worktree git no longer knows about, at a path that no longer exists, is
 *    `absent` rather than an error, so a retried cleanup is a no-op. A path that
 *    exists but is not a worktree of that repository is refused: it is
 *    something else now, and removing it is not this verb's to decide.
 * 4. No event is appended, as `run close` appends none (`D-0084`): whether the
 *    worktree is there is a question git answers, and a spine fact about it
 *    would be a second answer.
 *
 * **ASCII only**, for the reason `docs/cli-output-policy.md` gives.
 */

import { existsSync } from "node:fs";
import type { Database as SqliteDatabase } from "better-sqlite3";

import { addJsonArgument, jsonRequested, refusalLine, successLine } from "../cli/json_output.js";
import { ArgparseExit, type Namespace, type Subparsers } from "../cli/parser.js";
import { openProductionControlPlane } from "../control_plane/migrator.js";
import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import { readRun, TERMINAL_RUN_STATUSES } from "../control_plane/run_lifecycle.js";
import { type GitOptions, GitRefusal, removeWorktree, runGitChecked } from "./git.js";
import { sameExistingPath, WORKSPACE_MATERIALIZED_EVENT_TYPE } from "./materializer.js";

// ASCII only: these reach --help on a cp932 console.
const DESCRIPTION =
  "Remove the git worktree a closed run was materialised into, as its " +
  "workspace_materialized event names it. A worktree with uncommitted changes " +
  "is refused; one that is already gone is reported as absent; the topic " +
  "branch is left in place. Appends no event.";
const DB_HELP =
  "path to the production control plane database file. It must already exist " +
  "and be at this build's head.";
const RUN_ID_HELP =
  "the run whose worktree to remove. It must be at a terminal status " +
  "(completed, failed or cancelled).";

const REMOVE_SCHEMA = "continuo.workspace.remove/1";

/** The seam record, in the shape `run_cli.ts`'s `runCliSeams` has. */
export const workspaceCliSeams = {
  write: (text: string): void => {
    process.stdout.write(text);
  },
  writeError: (text: string): void => {
    process.stderr.write(text);
  },
};

/** An operator-facing refusal of `workspace remove`. */
export class WorkspaceRemoveRefused extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceRemoveRefused";
    Object.setPrototypeOf(this, WorkspaceRemoveRefused.prototype);
  }
}

/** What one removal did. */
export interface RemovedWorkspace {
  readonly runId: string;
  readonly workspace: string;
  readonly repository: string;
  readonly topicBranch: string;
  readonly outcome: "removed" | "absent";
}

/** The run's `workspace_materialized` payload: at most one per run (`D-0057`). */
function materializedPayload(connection: SqliteDatabase, runId: string): string | undefined {
  const row = connection
    .prepare(
      "SELECT payload FROM event WHERE run_id = :run_id AND event_type = :type ORDER BY seq LIMIT 1",
    )
    .get({ run_id: runId, type: WORKSPACE_MATERIALIZED_EVENT_TYPE }) as
    | { payload: string | null }
    | undefined;
  return row?.payload ?? undefined;
}

function payloadString(payload: Record<string, unknown>, key: string, runId: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value === "") {
    throw new WorkspaceRemoveRefused(
      `run ${runId}'s ${WORKSPACE_MATERIALIZED_EVENT_TYPE} event carries no '${key}'`,
    );
  }
  return value;
}

/**
 * The `branch` line of `workspace`'s entry in `git worktree list --porcelain`:
 * `undefined` when git does not list it, `null` when it is listed detached.
 *
 * Paths are compared through {@link sameExistingPath}, the rule the
 * materialiser's own sweep uses: git lists the canonical path, and the payload
 * may hold a spelling through a symlinked parent or a Windows 8.3 short name.
 */
function registeredBranch(workspace: string, git: GitOptions): string | null | undefined {
  for (const entry of runGitChecked(["worktree", "list", "--porcelain"], git).stdout.split(
    "\n\n",
  )) {
    const lines = entry.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    if (path !== undefined && sameExistingPath(path, workspace)) {
      return lines.find((line) => line.startsWith("branch "))?.slice(7) ?? null;
    }
  }
  return undefined;
}

/**
 * Remove the worktree `runId` was materialised into.
 *
 * @throws {WorkspaceRemoveRefused} for an unknown run, a run not yet terminal,
 *   a run with no `workspace_materialized` event, a worktree no longer on the
 *   run's topic branch, or a path that exists but is not a worktree of the
 *   recorded repository.
 * @throws {GitRefusal} if git refuses the removal (a dirty worktree) or cannot
 *   run in the recorded repository.
 */
export function removeRunWorkspace(connection: SqliteDatabase, runId: string): RemovedWorkspace {
  const run = readRun(connection, runId);
  if (run === undefined) {
    throw new WorkspaceRemoveRefused(`no run ${runId} in this control plane`);
  }
  if (!(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
    throw new WorkspaceRemoveRefused(
      `run ${runId} is at status ${run.status}; close it before removing its worktree`,
    );
  }
  const raw = materializedPayload(connection, runId);
  if (raw === undefined) {
    throw new WorkspaceRemoveRefused(
      `run ${runId} has no ${WORKSPACE_MATERIALIZED_EVENT_TYPE} event; there is no worktree to remove`,
    );
  }
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const workspace = payloadString(payload, "workspace", runId);
  const repository = payloadString(payload, "repository", runId);
  const topicBranch = payloadString(payload, "topic_branch", runId);
  const git: GitOptions = { cwd: repository };

  let outcome: RemovedWorkspace["outcome"];
  const branch = registeredBranch(workspace, git);
  if (branch !== undefined) {
    // The path alone does not prove the worktree is still this run's: once it
    // is removed, a later run may materialise at the same path. Each
    // materialisation creates its own topic branch, so the branch checked out
    // there is what ties the worktree to this run.
    if (branch !== `refs/heads/${topicBranch}`) {
      throw new WorkspaceRemoveRefused(
        `${workspace} is checked out on ${branch ?? "a detached HEAD"}, not on run ` +
          `${runId}'s topic branch ${topicBranch}; refusing to remove it`,
      );
    }
    removeWorktree(workspace, git);
    outcome = "removed";
  } else if (existsSync(workspace)) {
    throw new WorkspaceRemoveRefused(
      `${workspace} exists but is not a worktree of ${repository}; refusing to remove it`,
    );
  } else {
    outcome = "absent";
  }
  return { runId, workspace, repository, topicBranch, outcome };
}

/** `continuo workspace remove`. */
export function cmdWorkspaceRemove(args: Namespace): number {
  const path = String(args["db"]);
  const json = jsonRequested(args);
  try {
    const connection = openProductionControlPlane(path);
    try {
      const done = removeRunWorkspace(connection, String(args["run_id"]));
      workspaceCliSeams.write(
        json
          ? successLine(REMOVE_SCHEMA, path, {
              run_id: done.runId,
              workspace: done.workspace,
              repository: done.repository,
              topic_branch: done.topicBranch,
              outcome: done.outcome,
            })
          : `${done.outcome === "removed" ? "removed" : "already absent:"} worktree ` +
              `${done.workspace} of run ${done.runId} in ${path}; ` +
              `branch ${done.topicBranch} left in place\n`,
      );
    } finally {
      connection.close();
    }
  } catch (error) {
    if (error instanceof ControlPlaneRefusal || error instanceof GitRefusal) {
      workspaceCliSeams.writeError(
        json ? refusalLine(REMOVE_SCHEMA, path, error) : `error: ${error.message}\n`,
      );
      throw new ArgparseExit(2, "refused workspace verb");
    }
    throw error;
  }
  return 0;
}

/** `add_subparsers`: mount `remove` under `workspace`. */
export function addSubparsers(sub: Subparsers): void {
  const remove = sub.addParser("remove", DESCRIPTION);
  remove.addArgument({
    optionStrings: ["--db"],
    dest: "db",
    required: true,
    metavar: "DB",
    help: DB_HELP,
  });
  remove.addArgument({
    optionStrings: ["--run-id"],
    dest: "run_id",
    required: true,
    metavar: "RUN_ID",
    help: RUN_ID_HELP,
  });
  addJsonArgument(remove);
  remove.setDefaults({ func: cmdWorkspaceRemove });
}
