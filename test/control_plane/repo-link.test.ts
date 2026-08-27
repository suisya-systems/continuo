/**
 * What `repo_link` must keep true -- the 2026-08-06 regression, and section 7's cardinality.
 *
 * Ported from interlock `tests/control_plane/test_repo_link.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping is recorded in the
 * parity ledger.
 *
 * These tests exist for two things that a reading of the DDL alone does not
 * give.
 *
 * The first is the **2026-08-06 regression**. v1's run->PR tools defaulted an
 * omitted `--repo` to the cwd repository and recorded renga PR #302 with
 * claude-org-ja PR #302's branch, commit and merge time, exiting `ok`. The
 * tests named for it assert the *absence* of the defaulting -- against the
 * `CHECK`, so no writer can name a working-directory guess, and against the
 * API's own signature, so no caller can pass one. An absence is exactly the
 * kind of property that rots quietly when someone later adds a convenience
 * argument, which is why it is asserted rather than documented.
 *
 * The second is **section 7's cardinality**, whose three questions get three
 * different answers (several PRs per run, across repositories; several runs
 * per PR; one live `primary` per run). Each is one test named as the property,
 * and each would pass just as well against a schema that answered a
 * *different* one of the three -- so all three are here, not a representative
 * one.
 *
 * Every timestamp is {@link T0} plus arithmetic. The schema gives no timestamp
 * column a `DEFAULT` because the caller owns the clock; a suite whose
 * expectations moved with the wall clock could not assert an ordering
 * boundary.
 *
 * Translation notes, each a rule rather than a local choice:
 *
 * * The pytest `cp` fixture is a plain function called inside the test
 *   (conventions rule 8), and the connection registers its `close()` with
 *   `onTestFinished` at the point of acquisition (rule 1) -- on Windows an open
 *   handle is what fails the temporary-directory cleanup, and the acquisition
 *   site is the only place that knows the acquisition succeeded.
 * * The source raises `sqlite3.IntegrityError` at four call sites, always from
 *   a `CHECK`, a unique index or the `pull_request_head_is_monotonic` trigger.
 *   better-sqlite3 raises one error type, so those become
 *   {@link expectSqliteError} on the **result code** (`SQLITE_CONSTRAINT*`),
 *   which is the durable half of the assertion (`D-0016`); the message text
 *   SQLite prints is not a compatibility surface.
 * * `test_an_unlink_records_a_reason_or_does_not_happen` expects a bare
 *   `ValueError` from `_require_text`. Python's untyped `ValueError` maps to
 *   `TypeError` in this port -- the house convention, since `repo_link.py`
 *   declares no `UsageError(ValueError)` subclass of its own (see
 *   `gates.test.ts`'s translation notes). Recorded `adapted`.
 * * `inspect.signature(function).parameters` has no runtime equivalent: TypeScript
 *   erases parameter names, and each ported function takes `(connection, options)`
 *   with the source's keyword arguments as properties of `options`. The
 *   equivalent surface is therefore read out of the module's own **source text**
 *   -- the two positional parameters plus every option property -- and the
 *   forbidden-word search runs over that, case-folded so a `cwdDefault` added in
 *   camelCase is caught by the source's lowercase `"default"`. Recorded
 *   `adapted`; a target-only case below pins that the scan is not vacuous.
 * * The `caseRoot` label is `rl`, a short module nickname (`D-0020`). This file
 *   asserts no `match=` pattern at all -- its source uses none -- so no pattern
 *   can be made vacuous by the temp path; the short label keeps it that way for
 *   any pattern a later edit adds.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import type { ObservedPullRequest } from "../../src/control_plane/repo_link.js";
import {
  linkRunPr,
  observePullRequest,
  PullRequestObservationRefused,
  primaryLink,
  RESOLUTIONS,
  RepoResolutionError,
  RunPrLinkRefused,
  resolveRepository,
  unlinkRunPr,
  upsertRepository,
} from "../../src/control_plane/repo_link.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { expectRefusal, expectSqliteError } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_MERGE = "c".repeat(40);

/** The result code family a `CHECK`, a unique index or a trigger produces. */
const CONSTRAINT = /^SQLITE_CONSTRAINT/;

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------

/**
 * The migrated database every case starts from, built once for this file.
 *
 * Every case here wants the same thing -- a production control plane created at
 * `T0`, at head, with no `migrationsDir` override -- and creating one costs
 * about 44ms against about 2.8ms to copy one and open it. Building it once per
 * file and handing each case its own copy keeps the per-case fixture identical
 * while removing the migrations this file used to run (D-0027).
 */
const productionTemplate = suiteTemplate("production.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/**
 * The source's `db_path` fixture, as a per-test call: a fresh copy of the
 * template in a fresh per-case directory.
 */
function productionDb(): string {
  return productionTemplate.copyInto(caseRoot("rl"));
}

/**
 * The source's `cp` fixture: a production control plane created at `T0`.
 *
 * The connection now comes from `openProductionControlPlane` over a copy rather
 * than from creating one. Both apply the same two pragmas, and opening verifies
 * the copy is at head -- so a template that failed to build is a refusal here
 * rather than a case that quietly runs against the wrong schema.
 */
function cpFixture(): SqliteDatabase {
  const connection = openProductionControlPlane(productionDb());
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

// --------------------------------------------------------------------------
// helpers -- the smallest legal row of each kind
// --------------------------------------------------------------------------

function addRun(cp: SqliteDatabase, runId = "run-1", at: number = T0): string {
  cp.prepare<[string, string, number, number]>(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
  ).run(runId, "running", at, at);
  return runId;
}

function addRepo(
  cp: SqliteDatabase,
  repoId = "repo-a",
  owner = "aainc",
  name = "renga",
  providerRepoId: string | null = "R_kgDO0001",
  at: number = T0,
): string {
  return upsertRepository(cp, { repoId, owner, name, providerRepoId, nowMs: at });
}

function addScope(
  cp: SqliteDatabase,
  scopeId: string,
  options: {
    readonly repoId: string;
    readonly prId: string;
    readonly at?: number;
    readonly retiredAtMs?: number | null;
  },
): string {
  const { repoId, prId, at = T0, retiredAtMs = null } = options;
  cp.prepare<[string, string, string, number, number, number | null]>(
    "INSERT INTO watcher_scope (scope_id, scope_kind, repo_id, pr_id, expected_interval_ms," +
      " enabled, registered_at_ms, retired_at_ms) VALUES (?, 'ci_pull_request', ?, ?, ?, 1," +
      " ?, ?)",
  ).run(scopeId, repoId, prId, 60_000, at, retiredAtMs);
  return scopeId;
}

/** One provider observation, with the fields the state implies filled in. */
function observe(
  cp: SqliteDatabase,
  options: {
    readonly repoId: string;
    readonly prNumber: number;
    readonly headSha?: string;
    readonly state?: string;
    readonly at: number;
    readonly eventId?: string | null;
    readonly mergeCommitSha?: string | null;
    readonly mergedAtMs?: number | null;
    readonly closedAtMs?: number | null;
  },
): ObservedPullRequest {
  const {
    repoId,
    prNumber,
    headSha = SHA_A,
    state = "open",
    at,
    eventId = null,
    mergeCommitSha = null,
    mergedAtMs = null,
    closedAtMs = null,
  } = options;

  // `kwargs.setdefault`: what the caller passed wins, and the state's implied
  // facts fill in the rest.
  let resolvedMergeCommitSha = mergeCommitSha;
  let resolvedMergedAtMs = mergedAtMs;
  let resolvedClosedAtMs = closedAtMs;
  if (state === "merged") {
    resolvedMergeCommitSha = mergeCommitSha ?? SHA_MERGE;
    resolvedMergedAtMs = mergedAtMs ?? at;
    resolvedClosedAtMs = closedAtMs ?? at;
  } else if (state === "closed") {
    resolvedClosedAtMs = closedAtMs ?? at;
  }

  return observePullRequest(cp, {
    repoId,
    prNumber,
    headSha,
    state,
    observedAtMs: at,
    ingestedAtMs: at,
    eventId: eventId ?? `evt-${repoId}-${prNumber}-${at}`,
    producer: "gh-watcher",
    mergeCommitSha: resolvedMergeCommitSha,
    mergedAtMs: resolvedMergedAtMs,
    closedAtMs: resolvedClosedAtMs,
  });
}

/**
 * The source's `rows()`: every result row as a plain object keyed by the
 * database's own column names.
 *
 * Every `SELECT` below names plain columns -- no expression, no aggregate, no
 * bare bound parameter -- so reading by name is what SQLite promises here.
 */
function rows(
  cp: SqliteDatabase,
  sql: string,
  params: readonly unknown[] = [],
): Record<string, unknown>[] {
  return cp.prepare<unknown[], Record<string, unknown>>(sql).all(...params);
}

// --------------------------------------------------------------------------
// the API's own signature, read out of the module source
// --------------------------------------------------------------------------

const REPO_LINK_SOURCE = readFileSync(
  fileURLToPath(new URL("../../src/control_plane/repo_link.ts", import.meta.url)),
  "utf8",
);

/**
 * The names a caller can address on `functionName`: its positional parameters
 * and, since the ported surface takes the source's keyword arguments as an
 * options object, that object's properties.
 *
 * This is `inspect.signature(...).parameters` for a language that erases the
 * names at compile time -- the answer has to come from the text, because there
 * is nothing left to reflect on at runtime.
 */
function parameterNamesOf(functionName: string): string[] {
  const marker = `export function ${functionName}(`;
  const start = REPO_LINK_SOURCE.indexOf(marker);
  if (start < 0) {
    throw new Error(`no exported function '${functionName}' in repo_link.ts`);
  }
  const open = start + marker.length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < REPO_LINK_SOURCE.length; i += 1) {
    const character = REPO_LINK_SOURCE[i];
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) {
    throw new Error(`unbalanced parameter list for '${functionName}'`);
  }
  const parameters = REPO_LINK_SOURCE.slice(open + 1, close);
  const names: string[] = [];
  for (const match of parameters.matchAll(/(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/g)) {
    names.push(match[1] as string);
  }
  return names;
}

// --------------------------------------------------------------------------
// the cardinality decision (section 7.3)
// --------------------------------------------------------------------------

describe("the cardinality decision (section 7.3)", () => {
  test("one run may hold several pull requests across repositories", () => {
    const cp = cpFixture();
    const run = addRun(cp);
    const left = addRepo(cp, "repo-a", "aainc", "renga", "R_left");
    const right = addRepo(cp, "repo-b", "aainc", "claude-org-ja", "R_right");
    const a = observe(cp, { repoId: left, prNumber: 302, at: T0 }).prId;
    const b = observe(cp, { repoId: right, prNumber: 302, at: T0 + 1 }).prId;
    expect(a).not.toBe(b);

    linkRunPr(cp, {
      runId: run,
      prId: a,
      role: "primary",
      resolution: "project_registry",
      linkedAtMs: T0 + 2,
    });
    linkRunPr(cp, {
      runId: run,
      prId: b,
      role: "supporting",
      resolution: "explicit_operator",
      linkedAtMs: T0 + 3,
    });

    const linked = rows(cp, "SELECT pr_id, role FROM run_pr_link WHERE run_id = ? ORDER BY pr_id", [
      run,
    ]);
    expect(linked).toEqual([
      { pr_id: a, role: "primary" },
      { pr_id: b, role: "supporting" },
    ]);
  });

  test("one pull request may be touched by several runs", () => {
    const cp = cpFixture();
    const first = addRun(cp, "run-1");
    const second = addRun(cp, "run-2");
    const repo = addRepo(cp);
    const pr = observe(cp, { repoId: repo, prNumber: 7, at: T0 }).prId;

    linkRunPr(cp, {
      runId: first,
      prId: pr,
      role: "primary",
      resolution: "project_registry",
      linkedAtMs: T0 + 1,
    });
    linkRunPr(cp, {
      runId: second,
      prId: pr,
      role: "primary",
      resolution: "project_registry",
      linkedAtMs: T0 + 2,
    });

    const holders = rows(cp, "SELECT run_id FROM run_pr_link WHERE pr_id = ? ORDER BY run_id", [
      pr,
    ]);
    expect(holders.map((row) => row["run_id"])).toEqual([first, second]);
  });

  test("exactly one link per run is primary at a time", () => {
    const cp = cpFixture();
    const run = addRun(cp);
    const repo = addRepo(cp);
    const first = observe(cp, { repoId: repo, prNumber: 1, at: T0 }).prId;
    const second = observe(cp, { repoId: repo, prNumber: 2, at: T0 + 1 }).prId;

    linkRunPr(cp, {
      runId: run,
      prId: first,
      role: "primary",
      resolution: "project_registry",
      linkedAtMs: T0 + 2,
    });
    expectRefusal(
      () =>
        linkRunPr(cp, {
          runId: run,
          prId: second,
          role: "primary",
          resolution: "project_registry",
          linkedAtMs: T0 + 3,
        }),
      RunPrLinkRefused,
    );

    // A supporting link alongside the primary is not the constrained case.
    linkRunPr(cp, {
      runId: run,
      prId: second,
      role: "supporting",
      resolution: "project_registry",
      linkedAtMs: T0 + 4,
    });
    expect(primaryLink(cp, { runId: run })?.["pr_id"]).toBe(first);
  });

  test("a repointed run keeps both links as history", () => {
    const cp = cpFixture();
    const run = addRun(cp);
    const repo = addRepo(cp);
    const abandoned = observe(cp, { repoId: repo, prNumber: 1, at: T0 }).prId;
    const adopted = observe(cp, { repoId: repo, prNumber: 2, at: T0 + 1 }).prId;

    linkRunPr(cp, {
      runId: run,
      prId: abandoned,
      role: "primary",
      resolution: "project_registry",
      linkedAtMs: T0 + 2,
    });
    unlinkRunPr(cp, {
      runId: run,
      prId: abandoned,
      unlinkedAtMs: T0 + 3,
      unlinkReason: "superseded by a rebased pull request",
    });
    linkRunPr(cp, {
      runId: run,
      prId: adopted,
      role: "primary",
      resolution: "explicit_operator",
      linkedAtMs: T0 + 4,
    });

    expect(primaryLink(cp, { runId: run })?.["pr_id"]).toBe(adopted);
    const history = rows(
      cp,
      "SELECT pr_id, unlinked_at_ms, unlink_reason FROM run_pr_link" +
        " WHERE run_id = ? ORDER BY linked_at_ms",
      [run],
    );
    expect(history).toEqual([
      {
        pr_id: abandoned,
        unlinked_at_ms: T0 + 3,
        unlink_reason: "superseded by a rebased pull request",
      },
      { pr_id: adopted, unlinked_at_ms: null, unlink_reason: null },
    ]);
  });

  test("an unlink records a reason or does not happen", () => {
    const cp = cpFixture();
    const run = addRun(cp);
    const repo = addRepo(cp);
    const pr = observe(cp, { repoId: repo, prNumber: 1, at: T0 }).prId;
    linkRunPr(cp, {
      runId: run,
      prId: pr,
      role: "primary",
      resolution: "project_registry",
      linkedAtMs: T0 + 1,
    });

    expectRefusal(
      () => unlinkRunPr(cp, { runId: run, prId: pr, unlinkedAtMs: T0 + 2, unlinkReason: "" }),
      TypeError,
    );
    expectRefusal(
      () =>
        unlinkRunPr(cp, {
          runId: run,
          prId: "pr-that-was-never-linked",
          unlinkedAtMs: T0 + 2,
          unlinkReason: "typo",
        }),
      RunPrLinkRefused,
    );
    // `not.toBeUndefined()` would also pass for `null`, and the source asserts
    // `is not None` against a function whose absent answer is a MISSING ROW.
    // D-0007 keeps those two facts apart, so the assertion has to as well.
    expect(primaryLink(cp, { runId: run })).toBeDefined();
    expect(primaryLink(cp, { runId: run })).not.toBeNull();
  });
});

// --------------------------------------------------------------------------
// the 2026-08-06 regression (sections 7.1 and 7.4)
// --------------------------------------------------------------------------

describe("the 2026-08-06 regression (sections 7.1 and 7.4)", () => {
  /** Asserted twice: against the CHECK, and against the API's own signature. */
  test("resolution has no value meaning we guessed from the working directory", () => {
    const cp = cpFixture();

    expect(RESOLUTIONS).toEqual(["project_registry", "explicit_operator", "provider_event"]);

    const run = addRun(cp);
    const repo = addRepo(cp);
    const pr = observe(cp, { repoId: repo, prNumber: 1, at: T0 }).prId;
    expectSqliteError(
      () =>
        cp
          .prepare<[string, string, number]>(
            "INSERT INTO run_pr_link (run_id, pr_id, role, resolution, linked_at_ms)" +
              " VALUES (?, ?, 'primary', 'cwd_default', ?)",
          )
          .run(run, pr, T0 + 1),
      { code: CONSTRAINT },
    );
    expectRefusal(
      () =>
        linkRunPr(cp, {
          runId: run,
          prId: pr,
          role: "primary",
          resolution: "cwd_default",
          linkedAtMs: T0 + 1,
        }),
      RunPrLinkRefused,
    );

    // And there is no argument through which a working directory could arrive.
    const forbidden = ["cwd", "dir", "path", "default", "current", "fallback"];
    for (const functionName of [
      "resolveRepository",
      "upsertRepository",
      "linkRunPr",
      "observePullRequest",
    ]) {
      for (const parameter of parameterNamesOf(functionName)) {
        const folded = parameter.toLowerCase();
        expect(
          forbidden.some((word) => folded.includes(word)),
          `${functionName} / ${parameter}`,
        ).toBe(false);
      }
    }
  });

  /**
   * The 2026-08-06 regression: nothing is guessed, and nothing is written.
   *
   * On that date the resolution of an omitted repository fell back to the cwd's,
   * renga PR #302 was recorded with claude-org-ja PR #302's facts, and the tool
   * exited `ok`. Here the home repository exists and holds a PR of the very same
   * number, which is the condition under which the incident corrupted silently
   * rather than failing loudly -- and the resolution still refuses.
   */
  test("an unresolvable repository fails to link rather than defaulting", () => {
    const cp = cpFixture();
    addRun(cp);
    const home = addRepo(cp, "repo-home", "aainc", "claude-org-ja", "R_home");
    observe(cp, { repoId: home, prNumber: 302, at: T0 });

    expectRefusal(
      () => resolveRepository(cp, { owner: "aainc", name: "renga" }),
      RepoResolutionError,
    );
    expectRefusal(() => resolveRepository(cp, { providerRepoId: "R_renga" }), RepoResolutionError);
    expectRefusal(() => resolveRepository(cp), RepoResolutionError);

    expect(rows(cp, "SELECT run_id FROM run_pr_link")).toEqual([]);
    expect(resolveRepository(cp, { owner: "aainc", name: "claude-org-ja" })).toBe(home);
  });

  test("a rename is absorbed on the existing row and observations stay attached", () => {
    const cp = cpFixture();
    const repo = addRepo(cp, "repo-a", "aainc", "renga", "R_stable", T0);
    const pr = observe(cp, { repoId: repo, prNumber: 302, at: T0 + 1 }).prId;

    const absorbed = upsertRepository(cp, {
      repoId: "repo-a-would-be-new",
      owner: "aainc-labs",
      name: "renga-next",
      providerRepoId: "R_stable",
      nowMs: T0 + 2,
    });

    expect(absorbed).toBe(repo);
    expect(rows(cp, "SELECT repo_id FROM repository")).toHaveLength(1);
    expect(rows(cp, "SELECT owner, name, updated_at_ms FROM repository")).toEqual([
      { owner: "aainc-labs", name: "renga-next", updated_at_ms: T0 + 2 },
    ]);
    expect(rows(cp, "SELECT repo_id FROM pull_request WHERE pr_id = ?", [pr])).toEqual([
      { repo_id: repo },
    ]);
    expect(resolveRepository(cp, { owner: "aainc-labs", name: "renga-next" })).toBe(repo);
  });

  test("a slug matches case insensitively while the columns keep their case", () => {
    const cp = cpFixture();
    const repo = addRepo(cp, "repo-a", "AAInc", "Renga", "R_case");

    expect(rows(cp, "SELECT owner, name FROM repository")).toEqual([
      { owner: "AAInc", name: "Renga" },
    ]);
    expect(resolveRepository(cp, { owner: "aainc", name: "renga" })).toBe(repo);
    expect(resolveRepository(cp, { owner: "AAINC", name: "RENGA" })).toBe(repo);
    expectSqliteError(
      () =>
        cp
          .prepare<[number, number]>(
            "INSERT INTO repository (repo_id, provider, provider_repo_id, owner, name," +
              " created_at_ms, updated_at_ms) VALUES ('repo-dup', 'github', NULL, 'aainc'," +
              " 'renga', ?, ?)",
          )
          .run(T0, T0),
      { code: CONSTRAINT },
    );
  });

  test("a repo id is never reassigned to another repository", () => {
    const cp = cpFixture();
    addRepo(cp, "repo-a", "aainc", "renga", "R_left");
    expectRefusal(
      () =>
        upsertRepository(cp, {
          repoId: "repo-a",
          owner: "aainc",
          name: "other",
          providerRepoId: "R_right",
          nowMs: T0 + 1,
        }),
      RepoResolutionError,
    );
  });
});

// --------------------------------------------------------------------------
// the pull-request projection (section 7.2)
// --------------------------------------------------------------------------

describe("the pull-request projection (section 7.2)", () => {
  test("a recreated pull request is a new row and the old row survives", () => {
    const cp = cpFixture();
    const repo = addRepo(cp);
    const old = observe(cp, { repoId: repo, prNumber: 11, at: T0 }).prId;
    observe(cp, { repoId: repo, prNumber: 11, headSha: SHA_A, state: "closed", at: T0 + 1 });
    const fresh = observe(cp, { repoId: repo, prNumber: 12, headSha: SHA_B, at: T0 + 2 }).prId;

    expect(old).not.toBe(fresh);
    expect(
      rows(cp, "SELECT pr_number, state, head_sha FROM pull_request ORDER BY pr_number"),
    ).toEqual([
      { pr_number: 11, state: "closed", head_sha: SHA_A },
      { pr_number: 12, state: "open", head_sha: SHA_B },
    ]);
  });

  test("a head move records the event that moved it", () => {
    const cp = cpFixture();
    const repo = addRepo(cp);
    const first = observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, at: T0 });
    const second = observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_B, at: T0 + 1 });

    expect(first.eventType).toBe("pr_head_updated");
    expect(second.eventType === "pr_head_updated" && second.headMoved).toBe(true);
    const projected = rows(
      cp,
      "SELECT head_sha, head_observed_at_ms, head_event_seq FROM pull_request",
    );
    expect(projected).toEqual([
      { head_sha: SHA_B, head_observed_at_ms: T0 + 1, head_event_seq: second.event?.seq },
    ]);
    expect(Number(second.event?.seq)).toBeGreaterThan(Number(first.event?.seq));
  });

  test("a late older head observation is refused as evidence not a projection", () => {
    const cp = cpFixture();
    const repo = addRepo(cp);
    observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_B, at: T0 + 10 });
    expectRefusal(
      () => observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, at: T0 + 5 }),
      PullRequestObservationRefused,
    );
    expect(rows(cp, "SELECT head_sha FROM pull_request")).toEqual([{ head_sha: SHA_B }]);
  });

  /**
   * The staleness of a head is a property of the head, not of the transition.
   *
   * `_plan` names the transition most-consequential-first, so a delayed merge,
   * close or reopen that also carries an older, different `head_sha` used to
   * return before the head-order test the bare `pr_head_updated` branch makes.
   * The `pull_request_head_is_monotonic` trigger (migrations/0001_initial.sql)
   * still refuses the write, so nothing stale ever landed -- but the caller got
   * a raw `IntegrityError` saying only that *some* constraint failed, which is
   * precisely the loss of naming {@link PullRequestObservationRefused} exists to
   * prevent, and the docstring's contract promises the name "for a head move the
   * provider's own order does not support" on every transition alike.
   */
  parametrize<{ readonly state: string; readonly extra: { readonly mergeCommitSha?: string } }>(
    "a late older head is refused by name on every transition",
    [
      ["merged-extra0", { state: "merged", extra: { mergeCommitSha: SHA_MERGE } }],
      ["closed-extra1", { state: "closed", extra: {} }],
      // the reopen, from a prior closed
      ["open-extra2", { state: "open", extra: {} }],
    ],
    ({ state, extra }) => {
      const cp = cpFixture();
      const repo = addRepo(cp);
      observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, at: T0 + 10 });
      if (state === "open") {
        // a reopen is only reachable from a prior close
        observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, state: "closed", at: T0 + 20 });
      }
      const beforeState = rows(cp, "SELECT state, head_sha, head_observed_at_ms FROM pull_request");
      const beforeEvents = rows(cp, "SELECT seq FROM event");

      expectRefusal(
        () =>
          observe(cp, {
            repoId: repo,
            prNumber: 1,
            headSha: SHA_B,
            state,
            at: T0 + 5,
            eventId: "evt-late",
            mergeCommitSha: extra.mergeCommitSha ?? null,
          }),
        PullRequestObservationRefused,
      );

      // Nothing of the observation survives: not the stale head, not the newer
      // head_observed_at_ms it would have been paired with, not the event.
      expect(rows(cp, "SELECT state, head_sha, head_observed_at_ms FROM pull_request")).toEqual(
        beforeState,
      );
      expect(rows(cp, "SELECT seq FROM event")).toEqual(beforeEvents);
    },
  );

  test("a no change observation appends nothing", () => {
    const cp = cpFixture();
    const repo = addRepo(cp);
    observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, at: T0 });
    const before = rows(cp, "SELECT seq FROM event");

    const repeat = observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, at: T0 + 60_000 });

    expect(repeat.changed === false && repeat.event === null).toBe(true);
    expect(rows(cp, "SELECT seq FROM event")).toEqual(before);
    expect(rows(cp, "SELECT head_observed_at_ms FROM pull_request")).toEqual([
      { head_observed_at_ms: T0 },
    ]);
  });

  test("a reopen clears closed at ms and unretires the watcher scope", () => {
    const cp = cpFixture();
    const repo = addRepo(cp);
    const pr = observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, at: T0 }).prId;
    const scope = addScope(cp, "scope-1", { repoId: repo, prId: pr, at: T0 });
    observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, state: "closed", at: T0 + 1 });
    cp.prepare<[number, string]>(
      "UPDATE watcher_scope SET retired_at_ms = ? WHERE scope_id = ?",
    ).run(T0 + 1, scope);

    const reopened = observe(cp, {
      repoId: repo,
      prNumber: 1,
      headSha: SHA_A,
      state: "open",
      at: T0 + 2,
    });

    expect(reopened.eventType).toBe("pr_reopened");
    expect(reopened.reactivatedScopes).toEqual([scope]);
    expect(rows(cp, "SELECT state, closed_at_ms FROM pull_request")).toEqual([
      { state: "open", closed_at_ms: null },
    ]);
    // Section 7.2: without the scope the pull request is watched in name only.
    expect(rows(cp, "SELECT retired_at_ms FROM watcher_scope")).toEqual([{ retired_at_ms: null }]);
  });

  /**
   * A stale state cannot rewind the projection just because the head stood still.
   *
   * `pull_request_head_is_monotonic` (migrations/0001_initial.sql) orders the
   * *head*, and the head test above orders it by name -- but neither says
   * anything when the head does not move and only `state` does. The provider
   * sequence close -> reopen -> close leaves a poll from the intervening open
   * period in flight; it carries the same `head_sha`, so it reached none of
   * those checks, and its default dedup key (built from `observed_at_ms` for a
   * reopen) differs from the earlier reopen's, so the spine did not stop it
   * either. It was accepted as a *second* reopen: the PR went back to open,
   * `closed_at_ms` was cleared, a `pr_reopened` event landed on the spine behind
   * the newer `pr_closed`, and -- the wider blast radius -- section 8.2's
   * retired `watcher_scope` was reactivated, putting a watcher back on a pull
   * request the provider has closed.
   *
   * `head_observed_at_ms` is the watermark that stops it: the projection writes
   * `max(observed_at_ms, current)` on every transition, so it is the instant of
   * the newest observation we have projected and not merely of the head's first
   * sighting -- which is what section 7.2's "re-observing the SAME head may
   * refresh the timestamp and no more" describes.
   */
  test("a late state observation with an unchanged head is refused too", () => {
    const cp = cpFixture();
    const repo = addRepo(cp);
    const pr = observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, at: T0 }).prId;
    const scope = addScope(cp, "scope-1", { repoId: repo, prId: pr, at: T0 });
    observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, state: "closed", at: T0 + 10 });
    observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, state: "open", at: T0 + 20 });
    observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, state: "closed", at: T0 + 30 });
    cp.prepare<[number, string]>(
      "UPDATE watcher_scope SET retired_at_ms = ? WHERE scope_id = ?",
    ).run(T0 + 30, scope);
    const beforePr = rows(cp, "SELECT state, closed_at_ms, head_observed_at_ms FROM pull_request");
    const beforeEvents = rows(cp, "SELECT seq, event_type FROM event");

    // The delayed poll from between the reopen and the second close. Same head,
    // so only the ordering of the STATE can refuse it.
    expectRefusal(
      () =>
        observe(cp, {
          repoId: repo,
          prNumber: 1,
          headSha: SHA_A,
          state: "open",
          at: T0 + 25,
          eventId: "evt-delayed-open",
        }),
      PullRequestObservationRefused,
    );

    expect(rows(cp, "SELECT state, closed_at_ms, head_observed_at_ms FROM pull_request")).toEqual(
      beforePr,
    );
    expect(rows(cp, "SELECT seq, event_type FROM event")).toEqual(beforeEvents);
    // The half with the wider blast radius: a retired scope stays retired.
    expect(rows(cp, "SELECT retired_at_ms FROM watcher_scope")).toEqual([
      { retired_at_ms: T0 + 30 },
    ]);
  });

  /**
   * The tie goes the same way for a state as for a head, and for one reason.
   *
   * `head_moved and observed_at_ms <= head_observed_at_ms` refuses the tie
   * because the section 7.2 trigger requires the head's observation instant to
   * *advance*. Section 7.2 states no rule for a state that moves alone, so the
   * choice is ours, and admitting the tie would leave exactly the reviewer's
   * sequence open one millisecond wide: a delayed observation stamped at the
   * recorded instant would still rewind the state. Two contradictory provider
   * states cannot both be true of one instant, so the later arrival is a late
   * read, not a projection.
   */
  test("a state transition at the watermark instant is refused like a head move", () => {
    const cp = cpFixture();
    const repo = addRepo(cp);
    observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, at: T0 });
    observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, state: "closed", at: T0 + 30 });

    expectRefusal(
      () =>
        observe(cp, {
          repoId: repo,
          prNumber: 1,
          headSha: SHA_A,
          state: "open",
          at: T0 + 30,
          eventId: "evt-tie",
        }),
      PullRequestObservationRefused,
    );
    expect(rows(cp, "SELECT state FROM pull_request")).toEqual([{ state: "closed" }]);
  });

  test("a merged pull request does not reopen", () => {
    const cp = cpFixture();
    const repo = addRepo(cp);
    observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, at: T0 });
    const merged = observe(cp, {
      repoId: repo,
      prNumber: 1,
      headSha: SHA_A,
      state: "merged",
      at: T0 + 1,
    });
    expect(merged.eventType).toBe("pr_merged");

    expectRefusal(
      () => observe(cp, { repoId: repo, prNumber: 1, headSha: SHA_A, state: "open", at: T0 + 2 }),
      PullRequestObservationRefused,
    );
    expectSqliteError(
      () => cp.prepare("UPDATE pull_request SET state = 'open' WHERE pr_number = 1").run(),
      { code: CONSTRAINT },
    );
    expect(rows(cp, "SELECT state, merged_at_ms FROM pull_request")).toEqual([
      { state: "merged", merged_at_ms: T0 + 1 },
    ]);
  });

  /** Section 5.4's all-or-nothing, reached through this module's side effect. */
  test("an observation whose projection fails leaves no event behind", () => {
    const cp = cpFixture();
    expectSqliteError(
      () => observe(cp, { repoId: "repo-that-does-not-exist", prNumber: 1, at: T0 }),
      { code: CONSTRAINT },
    );
    expect(rows(cp, "SELECT seq FROM event")).toEqual([]);
    expect(rows(cp, "SELECT pr_id FROM pull_request")).toEqual([]);
  });

  test("a merge observed without its merge commit is refused by name", () => {
    const cp = cpFixture();
    const repo = addRepo(cp);
    expectRefusal(
      () =>
        observePullRequest(cp, {
          repoId: repo,
          prNumber: 1,
          headSha: SHA_A,
          state: "merged",
          observedAtMs: T0,
          ingestedAtMs: T0,
          eventId: "evt-1",
          producer: "gh-watcher",
          mergedAtMs: T0,
          closedAtMs: T0,
        }),
      PullRequestObservationRefused,
    );
    expect(rows(cp, "SELECT seq FROM event")).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// the signature scan (target-only)
// --------------------------------------------------------------------------

describe("the signature scan (target-only)", () => {
  /**
   * The forbidden-word case above is only as good as the list of names it
   * searches. TypeScript erases parameter names, so that list is read out of the
   * module's source text -- and a scan that silently returned nothing would make
   * the whole assertion vacuous while still reporting green. This pins that the
   * scan finds each ported signature's real, complete surface: both positional
   * parameters and every property of the options object.
   */
  test("the parameter scan finds the ported signatures", () => {
    expect(parameterNamesOf("resolveRepository")).toEqual([
      "connection",
      "options",
      "owner",
      "name",
      "providerRepoId",
      "provider",
    ]);
    expect(parameterNamesOf("upsertRepository")).toEqual([
      "connection",
      "options",
      "repoId",
      "owner",
      "name",
      "nowMs",
      "providerRepoId",
      "provider",
    ]);
    expect(parameterNamesOf("linkRunPr")).toEqual([
      "connection",
      "options",
      "runId",
      "prId",
      "role",
      "resolution",
      "linkedAtMs",
    ]);
    expect(parameterNamesOf("observePullRequest")).toEqual([
      "connection",
      "options",
      "repoId",
      "prNumber",
      "headSha",
      "state",
      "observedAtMs",
      "ingestedAtMs",
      "eventId",
      "producer",
      "producerEpoch",
      "providerPrId",
      "mergeCommitSha",
      "mergedAtMs",
      "closedAtMs",
      "runId",
      "dedupKey",
      "payload",
    ]);
    expect(() => parameterNamesOf("noSuchFunction")).toThrow(/no exported function/);
  });
});
