/**
 * `continuo ci observe` and `continuo ci show` (`D-1113`) -- target-only.
 *
 * Interlock has no `ci` subtree and no producer for `ci_observation`; the verbs
 * replace rondo's `joinChecks` (rondo `87e62f0`), so every case here is a
 * continuo decision. The documents are handed to the verb through
 * `ciCliSeams.readFile`, keyed by the path the argv names, so no case touches a
 * forge or a file other than the database.
 *
 * The cases that would each cost a real result if the verbs got them wrong:
 * a still-running check folding to `passed`; a rerun's green being outvoted by
 * the red run it replaced; a document about another repository, pull request or
 * commit being recorded; a head update leaving the old head's red in the
 * verdict; and `0007` losing a row it rebuilt.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";

import { main } from "../../src/cli.js";
import { ciCliSeams } from "../../src/control_plane/ci_cli.js";
import { recordCiObservation, scopeVerdicts } from "../../src/control_plane/ci_ingest.js";
import {
  createProductionControlPlane,
  MIGRATIONS_DIR,
  migrateControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { observePullRequest, upsertRepository } from "../../src/control_plane/repo_link.js";
import { caseRoot, databasePath, rowsOf, suiteTemplate } from "../testkit/cases.js";
import { patchSeam } from "../testkit/seams.js";

const T0 = 1_700_000_000_000;
const HEAD = "a".repeat(40);
const NEW_HEAD = "c".repeat(40);
const OWNER = "suisya-systems";
const NAME = "continuo";
const PR = 7;
const REPO_NODE = "R_kgDOexample";
const REPO_ID = `github:${REPO_NODE}`;

const template = suiteTemplate("ci-cli.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function pullRequest(fields: { head?: string; updated?: number; number?: number } = {}): string {
  return JSON.stringify({
    number: fields.number ?? PR,
    node_id: "PR_kwDOexample",
    state: "open",
    updated_at: iso(fields.updated ?? 0),
    merged_at: null,
    closed_at: null,
    merge_commit_sha: "d".repeat(40),
    head: { sha: fields.head ?? HEAD, repo: { name: "a-fork" } },
    base: { repo: { name: NAME, node_id: REPO_NODE, owner: { login: OWNER } } },
  });
}

type Run = {
  name: string;
  status: string;
  conclusion?: string;
  at: number;
  head?: string;
  id?: number;
};

function checkRuns(...runs: Run[]): string {
  return JSON.stringify([
    {
      total_count: runs.length,
      check_runs: runs.map((one) => ({
        id: one.id ?? 1,
        name: one.name,
        head_sha: one.head ?? HEAD,
        status: one.status,
        conclusion: one.conclusion ?? null,
        started_at: iso(one.at),
        completed_at: one.status === "completed" ? iso(one.at) : null,
      })),
    },
  ]);
}

function status(head: string = HEAD): string {
  return JSON.stringify([{ sha: head, total_count: 0, statuses: [] }]);
}

/** A fresh database, and the streams and documents the verbs will see. */
function fixture(label: string) {
  const path = template.copyInto(caseRoot(`ci-${label}`));
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  let ids = 0;
  patchSeam(ciCliSeams, "write", (text: string) => {
    out.push(text);
  });
  patchSeam(ciCliSeams, "writeError", (text: string) => {
    err.push(text);
  });
  patchSeam(ciCliSeams, "nowMs", () => T0 + 3_600_000);
  patchSeam(ciCliSeams, "newId", () => {
    ids += 1;
    return `id-${ids}`;
  });
  patchSeam(ciCliSeams, "readFile", (file: string) => Buffer.from(files.get(file) ?? "", "utf8"));

  const observe = (documents: { pr?: string; runs: string; status?: string }): number => {
    files.set("pr.json", documents.pr ?? pullRequest());
    files.set("runs.json", documents.runs);
    files.set("status.json", documents.status ?? status());
    out.length = 0;
    err.length = 0;
    return main([
      "ci",
      "observe",
      "--db",
      path,
      "--repo",
      `${OWNER}/${NAME}`,
      "--pr",
      String(PR),
      "--pull-request",
      "pr.json",
      "--check-runs",
      "runs.json",
      "--status",
      "status.json",
      "--observer",
      "rondo-host",
      "--json",
    ]);
  };
  const show = (json = true): Record<string, unknown> | string => {
    out.length = 0;
    const code = main([
      "ci",
      "show",
      "--db",
      path,
      "--repo",
      `${OWNER}/${NAME}`,
      "--pr",
      String(PR),
      ...(json ? ["--json"] : []),
    ]);
    expect(code).toBe(0);
    return json ? (JSON.parse(out.join("")) as Record<string, unknown>) : out.join("");
  };
  return { path, out, err, observe, show };
}

describe("ci observe, then ci show", () => {
  test("green checks, a skipped one among them, show passed on the head", () => {
    const cp = fixture("green");
    expect(
      cp.observe({
        runs: checkRuns(
          { name: "test", status: "completed", conclusion: "success", at: 1000 },
          { name: "docs", status: "completed", conclusion: "skipped", at: 1000 },
        ),
      }),
    ).toBe(0);
    expect(JSON.parse(cp.out.join(""))).toMatchObject({
      schema: "continuo.ci.observe/1",
      ok: true,
      repo_id: REPO_ID,
      pr_number: PR,
      head_sha: HEAD,
      pull_request_event: "pr_head_updated",
      observed: 2,
      recorded: 2,
      duplicate: 0,
    });
    expect(cp.show()).toMatchObject({
      schema: "continuo.ci.show/1",
      head_sha: HEAD,
      verdict: "passed",
      scopes: [
        { check_scope: "check_run", scope_id: "docs", verdict: "passed", detail: "skipped" },
        { check_scope: "check_run", scope_id: "test", verdict: "passed", detail: "success" },
      ],
    });
  });

  test("a check still running keeps the verdict at pending, and its finish moves it", () => {
    const cp = fixture("pending");
    cp.observe({
      runs: checkRuns(
        { name: "test", status: "completed", conclusion: "success", at: 1000 },
        { name: "e2e", status: "in_progress", at: 1000 },
      ),
    });
    expect(cp.show()).toMatchObject({ verdict: "pending" });
    cp.observe({
      runs: checkRuns(
        { name: "test", status: "completed", conclusion: "success", at: 1000 },
        { name: "e2e", status: "completed", conclusion: "success", at: 5000 },
      ),
    });
    expect(JSON.parse(cp.out.join(""))).toMatchObject({ recorded: 1, duplicate: 1 });
    expect(cp.show()).toMatchObject({ verdict: "passed" });
  });

  test("a failure outranks a check still running", () => {
    const cp = fixture("red");
    cp.observe({
      runs: checkRuns(
        { name: "test", status: "completed", conclusion: "failure", at: 1000 },
        { name: "e2e", status: "queued", at: 1000 },
      ),
    });
    expect(cp.show()).toMatchObject({ verdict: "failed" });
  });

  test("a rerun that goes green replaces the red run of the same name", () => {
    const cp = fixture("rerun");
    cp.observe({
      runs: checkRuns({ name: "test", status: "completed", conclusion: "failure", at: 1000 }),
    });
    expect(cp.show()).toMatchObject({ verdict: "failed" });
    cp.observe({
      runs: checkRuns({
        name: "test",
        status: "completed",
        conclusion: "success",
        at: 9000,
        id: 2,
      }),
    });
    expect(cp.show()).toMatchObject({ verdict: "passed" });
  });

  test("a rerun that comes back to an earlier verdict is recorded, not absorbed", () => {
    // pending -> passed -> (rerun) pending, then failed -> passed -> (rerun) failed:
    // the third observation repeats the first one's verdict, and it must still
    // move the answer. Raised by Codex review of this change.
    const cp = fixture("rerun-cycle");
    const at = (id: number, status: string, conclusion: string | undefined, when: number) =>
      cp.observe({
        runs: checkRuns({
          name: "test",
          status,
          ...(conclusion === undefined ? {} : { conclusion }),
          at: when,
          id,
        }),
      });
    at(1, "in_progress", undefined, 1000);
    at(1, "completed", "success", 2000);
    expect(cp.show()).toMatchObject({ verdict: "passed" });
    at(2, "queued", undefined, 3000);
    expect(cp.show()).toMatchObject({ verdict: "pending" });
    at(2, "completed", "failure", 4000);
    at(3, "completed", "success", 5000);
    expect(cp.show()).toMatchObject({ verdict: "passed" });
    at(4, "completed", "failure", 6000);
    expect(cp.show()).toMatchObject({ verdict: "failed" });
  });

  test("observing the same documents twice records nothing the second time", () => {
    const cp = fixture("repoll");
    const runs = checkRuns({ name: "test", status: "completed", conclusion: "success", at: 1000 });
    cp.observe({ runs });
    expect(cp.observe({ runs })).toBe(0);
    expect(JSON.parse(cp.out.join(""))).toMatchObject({
      pull_request_event: null,
      recorded: 0,
      duplicate: 1,
    });
    expect(rowsOf(cp.path, "ci_observation")).toHaveLength(1);
  });

  test("a head update leaves the old head's red out of the verdict", () => {
    const cp = fixture("head-moved");
    cp.observe({
      runs: checkRuns({ name: "test", status: "completed", conclusion: "failure", at: 1000 }),
    });
    cp.observe({
      pr: pullRequest({ head: NEW_HEAD, updated: 2000 }),
      runs: checkRuns({
        name: "test",
        status: "completed",
        conclusion: "success",
        at: 3000,
        head: NEW_HEAD,
      }),
      status: status(NEW_HEAD),
    });
    expect(cp.show()).toMatchObject({ head_sha: NEW_HEAD, verdict: "passed" });
  });

  test("nothing observed for the head is no_run, not passed", () => {
    const cp = fixture("none");
    cp.observe({ runs: checkRuns() });
    expect(cp.show()).toMatchObject({ head_sha: HEAD, verdict: "no_run", scopes: [] });
  });

  test("the human rendering escapes a check name that could break its line", () => {
    const cp = fixture("human");
    cp.observe({
      runs: checkRuns({
        name: "a\nforged line",
        status: "completed",
        conclusion: "success",
        at: 1,
      }),
    });
    expect(cp.show(false)).toBe(
      `ci ${OWNER}/${NAME}#${PR} in ${cp.path}: passed head=${HEAD}\n` +
        `scope check_run "a\\nforged line" passed detail=success attempt=1 occurred=${T0 + 1}\n`,
    );
  });
});

describe("ci observe refuses a document about something else, writing nothing", () => {
  test.each([
    [
      "checks about another commit",
      {
        runs: checkRuns({ name: "t", status: "queued", at: 0, head: NEW_HEAD }),
        status: status(NEW_HEAD),
      },
    ],
    ["another pull request", { pr: pullRequest({ number: PR + 1 }), runs: checkRuns() }],
    [
      "another repository",
      {
        pr: pullRequest().replace(`"login":"${OWNER}"`, '"login":"someone-else"'),
        runs: checkRuns(),
      },
    ],
    ["a short page", { runs: JSON.stringify([{ total_count: 3, check_runs: [] }]) }],
  ])("%s", (_label, documents) => {
    const cp = fixture(`refused-${_label.replace(/\W+/g, "-")}`);
    expect(cp.observe(documents)).toBe(2);
    const refusal = JSON.parse(cp.err.join("")) as { ok: boolean };
    expect(refusal.ok).toBe(false);
    expect(rowsOf(cp.path, "repository")).toHaveLength(0);
    expect(rowsOf(cp.path, "ci_observation")).toHaveLength(0);
  });
});

test("ci show refuses a repository it has never recorded", () => {
  const cp = fixture("unknown-repo");
  expect(
    main(["ci", "show", "--db", cp.path, "--repo", `${OWNER}/${NAME}`, "--pr", "1", "--json"]),
  ).toBe(2);
  expect(JSON.parse(cp.err.join(""))).toMatchObject({
    ok: false,
    error: { class: "RepoResolutionError" },
  });
});

test("a rollup stays subordinate to check runs and commit statuses (0007's view)", () => {
  const path = template.copyInto(caseRoot("ci-rollup"));
  const connection = openProductionControlPlane(path);
  onTestFinished(() => {
    connection.close();
  });
  seedPullRequest(connection);
  observation(connection, "rollup", "combined", "failed", "o-1");
  observation(connection, "commit_status", "ci/lint", "passed", "o-2");
  expect(scopeVerdicts(connection, { repoId: REPO_ID, prNumber: PR })).toMatchObject([
    { checkScope: "commit_status", verdict: "passed" },
  ]);
});

test("0007 carries every ci_observation row across the rebuild", () => {
  // A database built with the steps before 0007, holding one observation, then
  // brought to head by the real directory.
  const root = caseRoot("ci-0007");
  const before = join(root, "before");
  mkdirSync(before);
  for (const step of [
    "0001_initial.sql",
    "0002_policy_seed.sql",
    "0003_outbox_cancelled_status.sql",
    "0004_run_writer_epoch.sql",
    "0005_outbox_delivery_resource.sql",
    "0006_delegation_record.sql",
  ]) {
    copyFileSync(join(MIGRATIONS_DIR, step), join(before, step));
  }
  const path = databasePath(root);
  const old = createProductionControlPlane(path, { nowMs: T0, migrationsDir: before });
  seedPullRequest(old);
  observation(old, "check_suite", "suite-1", "failed", "o-1");
  const rows = rowsOf(path, "ci_observation");
  const projected = scopeVerdicts(old, { repoId: REPO_ID, prNumber: PR });
  old.close();

  migrateControlPlane(path, { nowMs: T0 + 1 }).close();
  expect(rowsOf(path, "ci_observation")).toEqual(rows);
  const current = openProductionControlPlane(path);
  onTestFinished(() => {
    current.close();
  });
  expect(scopeVerdicts(current, { repoId: REPO_ID, prNumber: PR })).toEqual(projected);
});

type Connection = ReturnType<typeof openProductionControlPlane>;

function seedPullRequest(connection: Connection): void {
  upsertRepository(connection, {
    repoId: REPO_ID,
    owner: OWNER,
    name: NAME,
    providerRepoId: REPO_NODE,
    nowMs: T0,
  });
  observePullRequest(connection, {
    repoId: REPO_ID,
    prNumber: PR,
    headSha: HEAD,
    state: "open",
    observedAtMs: T0,
    ingestedAtMs: T0,
    eventId: "pr-1",
    producer: "test",
  });
}

function observation(
  connection: Connection,
  checkScope: string,
  scopeId: string,
  verdict: string,
  observationId: string,
): void {
  recordCiObservation(connection, {
    observationId,
    repoId: REPO_ID,
    prNumber: PR,
    headSha: HEAD,
    checkScope,
    scopeId,
    attempt: 1,
    verdict,
    observer: "test",
    observerEpoch: 1,
    occurredAtMs: T0,
    ingestedAtMs: T0,
  });
}
