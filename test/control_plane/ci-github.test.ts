/**
 * Reading GitHub's check documents into one entry per check -- target-only.
 *
 * `src/control_plane/ci_github.ts` has no interlock counterpart: it replaces
 * rondo's `readEntries` / `joinChecks` (rondo `87e62f0`), so every case here is
 * a continuo decision rather than a translated one. The documents are written as
 * `gh api --paginate --slurp` prints them -- an array of pages.
 */

import { describe, expect, test } from "vitest";
import {
  GithubChecksUnreadable,
  readGithubChecks,
  readGithubPullRequest,
} from "../../src/control_plane/ci_github.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const AT = "2026-09-22T01:00:00Z";
const LATER = "2026-09-22T01:05:00Z";

function run(fields: Record<string, unknown>): Record<string, unknown> {
  return { id: 1, name: "build", head_sha: SHA, started_at: AT, ...fields };
}

function runs(...entries: Record<string, unknown>[]): string {
  return JSON.stringify([{ total_count: entries.length, check_runs: entries }]);
}

function statuses(...entries: Record<string, unknown>[]): string {
  return JSON.stringify([{ sha: SHA, total_count: entries.length, statuses: entries }]);
}

describe("readGithubChecks", () => {
  test("a completed run's conclusion: neutral and skipped pass, the rest keep or fail", () => {
    const read = readGithubChecks(
      runs(
        ...[
          "success",
          "neutral",
          "skipped",
          "cancelled",
          "timed_out",
          "failure",
          "action_required",
          "stale",
          "something_new",
        ].map((conclusion) =>
          run({ name: conclusion, status: "completed", conclusion, completed_at: LATER }),
        ),
      ),
      statuses(),
    );
    expect(read.headSha).toBe(SHA);
    expect(read.entries.map((entry) => [entry.name, entry.state])).toEqual([
      ["success", "passed"],
      ["neutral", "passed"],
      ["skipped", "passed"],
      ["cancelled", "cancelled"],
      ["timed_out", "timed_out"],
      ["failure", "failed"],
      ["action_required", "failed"],
      ["stale", "failed"],
      ["something_new", "failed"],
    ]);
    // `neutral` passes but still says what it was.
    expect(read.entries[1]).toEqual({
      kind: "check_run",
      name: "neutral",
      state: "passed",
      detail: "neutral",
      occurredAtMs: Date.parse(LATER),
      sourceId: 1,
    });
  });

  test("a run in flight is pending whatever conclusion it still carries, stamped at its start", () => {
    const read = readGithubChecks(
      runs(run({ status: "in_progress", conclusion: "success", completed_at: LATER })),
      statuses(),
    );
    expect(read.entries).toEqual([
      {
        kind: "check_run",
        name: "build",
        state: "pending",
        detail: "in_progress",
        occurredAtMs: Date.parse(AT),
        sourceId: 1,
      },
    ]);
  });

  test("a commit status: success passes, pending waits, failure and error fail", () => {
    const read = readGithubChecks(
      runs(),
      statuses(
        ...["success", "pending", "failure", "error"].map((state) => ({
          id: 10,
          context: `ci/${state}`,
          state,
          updated_at: AT,
        })),
      ),
    );
    expect(read.entries.map((entry) => [entry.kind, entry.name, entry.state])).toEqual([
      ["commit_status", "ci/success", "passed"],
      ["commit_status", "ci/pending", "pending"],
      ["commit_status", "ci/failure", "failed"],
      ["commit_status", "ci/error", "failed"],
    ]);
  });

  test("no check of either kind is an empty list about the status document's commit", () => {
    expect(readGithubChecks(runs(), statuses())).toEqual({ headSha: SHA, entries: [] });
  });

  test("every page is read, and a single unslurped page reads the same", () => {
    const pageOne = { total_count: 2, check_runs: [run({ name: "one", status: "queued" })] };
    const pageTwo = { total_count: 2, check_runs: [run({ name: "two", status: "queued" })] };
    const read = readGithubChecks(JSON.stringify([pageOne, pageTwo]), statuses());
    expect(read.entries.map((entry) => entry.name)).toEqual(["one", "two"]);
    const single = readGithubChecks(
      JSON.stringify(pageOne).replace('"total_count":2', '"total_count":1'),
      JSON.stringify({ sha: SHA, total_count: 0, statuses: [] }),
    );
    expect(single.entries.map((entry) => entry.name)).toEqual(["one"]);
  });

  test("a page short of the forge's own count is refused, not read as fewer checks", () => {
    const short = JSON.stringify([
      { total_count: 2, check_runs: [run({ status: "completed", conclusion: "success" })] },
    ]);
    expect(() => readGithubChecks(short, statuses())).toThrow(
      new GithubChecksUnreadable(
        "the forge reported 2 'check_runs' on this commit and answered with 1",
      ),
    );
  });

  test("documents about two commits are refused", () => {
    expect(() =>
      readGithubChecks(runs(run({ head_sha: OTHER_SHA, status: "queued" })), statuses()),
    ).toThrow(GithubChecksUnreadable);
  });

  test("an abbreviated commit is refused", () => {
    expect(() =>
      readGithubChecks(runs(), JSON.stringify({ sha: "abc1234", total_count: 0, statuses: [] })),
    ).toThrow(/not a full SHA/);
  });

  test.each([
    ["not JSON", "{", statuses()],
    ["no list", JSON.stringify([{ total_count: 0 }]), statuses()],
    ["no name", runs({ head_sha: SHA, status: "queued", started_at: AT }), statuses()],
    ["no timestamp", runs(run({ status: "completed", conclusion: "success" })), statuses()],
    ["a bad timestamp", runs(run({ status: "queued", started_at: "soon" })), statuses()],
    ["no status sha", runs(), JSON.stringify([{ statuses: [] }])],
    ["no check-run id", runs(run({ id: null, status: "queued" })), statuses()],
    ["no page of check runs", "[]", statuses()],
    ["no page of statuses", runs(run({ status: "queued" })), "[]"],
    [
      "a page with no count",
      JSON.stringify([{ check_runs: [run({ status: "queued" })] }]),
      statuses(),
    ],
    [
      "a page with a count that is not a number",
      JSON.stringify([{ total_count: "1", check_runs: [run({ status: "queued" })] }]),
      statuses(),
    ],
  ])("%s is refused as unreadable", (_label, checkRuns, status) => {
    expect(() => readGithubChecks(checkRuns, status)).toThrow(GithubChecksUnreadable);
  });

  test("a refusal naming forge text stays ASCII", () => {
    expect(() =>
      readGithubChecks(
        runs(run({ name: "\u30d3\u30eb\u30c9", status: "queued", started_at: "x" })),
        statuses(),
      ),
    ).toThrow(/^check run "\\u30d3\\u30eb\\u30c9" carried an unreadable 'started_at'$/);
  });
});

describe("readGithubPullRequest", () => {
  const MERGE = "d".repeat(40);

  function document(fields: Record<string, unknown>): string {
    return JSON.stringify({
      number: 7,
      node_id: "PR_1",
      state: "open",
      updated_at: AT,
      merged_at: null,
      closed_at: null,
      merge_commit_sha: MERGE,
      head: { sha: SHA.toUpperCase(), repo: { name: "fork", node_id: "R_fork" } },
      base: { repo: { name: "continuo", node_id: "R_base", owner: { login: "suisya" } } },
      ...fields,
    });
  }

  test("an open pull request: the base repository, the head lowercased, no merge commit", () => {
    expect(readGithubPullRequest(document({}))).toEqual({
      owner: "suisya",
      name: "continuo",
      providerRepoId: "R_base",
      prNumber: 7,
      providerPrId: "PR_1",
      headSha: SHA,
      state: "open",
      updatedAtMs: Date.parse(AT),
      mergedAtMs: null,
      closedAtMs: null,
      mergeCommitSha: null,
    });
  });

  test("a closed pull request with merged_at is merged, and carries its merge commit", () => {
    const read = readGithubPullRequest(
      document({ state: "closed", merged_at: LATER, closed_at: LATER }),
    );
    expect(read).toMatchObject({
      state: "merged",
      mergedAtMs: Date.parse(LATER),
      closedAtMs: Date.parse(LATER),
      mergeCommitSha: MERGE,
    });
  });

  test("a closed pull request without merged_at is closed", () => {
    expect(readGithubPullRequest(document({ state: "closed", closed_at: LATER }))).toMatchObject({
      state: "closed",
      mergedAtMs: null,
      mergeCommitSha: null,
    });
  });

  test.each([
    ["no number", { number: null }],
    ["an abbreviated head", { head: { sha: "abc1234" } }],
    ["no base repository", { base: {} }],
  ])("%s is refused as unreadable", (_label, fields) => {
    expect(() => readGithubPullRequest(document(fields))).toThrow(GithubChecksUnreadable);
  });
});
