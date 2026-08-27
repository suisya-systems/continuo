/**
 * CI ingestion -- the identity, the refusals at the edge, and the verdict projection.
 *
 * Ported from interlock `tests/control_plane/test_ci_ingest.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping is recorded in the
 * parity ledger.
 *
 * These tests are for the two failures `docs/production-schema.md` section 6.1
 * names and `D-0033` decides against, asserted from the API side rather than from
 * the DDL. The production-schema suite already pins what the `CHECK` constraints
 * and the `ci_current_verdict` view do to hand-written `INSERT`s; what is unproven
 * until here is that `src/control_plane/ci_ingest.ts` renders the *same* identity
 * the unique index enforces, refuses a malformed one before any of it reaches a
 * transaction, and folds the projection the way section 6.3 rule 5 says.
 *
 * The cases that would each cost a real result if the module got them wrong:
 *
 * * a **re-poll** of the identical fact is an idempotent no-op at the *first*
 *   statement of the append, so nothing downstream of it -- the consumption
 *   fan-out, the delivery outbox, the evidence row -- sees the repeat;
 * * an **indeterminate followed by the recovered verdict** for the same attempt is
 *   a new observation and moves the projection, which is the case that would
 *   otherwise strand a PR at `indeterminate` forever;
 * * a **head update** invalidates prior verdicts rather than letting them be
 *   overwritten, and the superseded rows stay in the table as evidence;
 * * a **late arrival** that orders lower is stored and moves nothing, which is the
 *   sentence section 6.3 exists to make true;
 * * a **rollup** stops projecting the moment a fine-grained scope exists;
 * * the **severity fold** puts `indeterminate` above `passed` and treats
 *   `no_run` as absent evidence rather than as a pass.
 *
 * Every timestamp is {@link T0} and arithmetic on it. The schema gives no timestamp
 * column a `DEFAULT` and no function here reads a clock, so a suite whose
 * expectations moved with the wall clock would be asserting something the
 * production code cannot even observe.
 *
 * Three translation notes, each a rule rather than a local choice:
 *
 * * The source's `cp` fixture is a plain function called inside the test
 *   (conventions rule 8), and the connection registers its `close()` with
 *   `onTestFinished` at the point of acquisition (rule 1).
 * * Every aggregate and every bare expression in a `SELECT` list is read
 *   **positionally** -- `.pluck()` for a single column, `.raw()` for a tuple --
 *   because SQLite promises no name for one and reading it by the name it
 *   "obviously" has silently yields `undefined` (`D-0021`, `D-0007`).
 * * The `caseRoot` label is `ci`, a short module nickname (`D-0020`). This file
 *   asserts no `match=` pattern at all -- its source uses none -- so no pattern
 *   can be made vacuous by the temp path; the short label keeps it that way for
 *   any pattern a later edit adds.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  CI_VERDICTS,
  EmptyIdentityFieldRefused,
  MalformedAttemptRefused,
  MalformedHeadShaRefused,
  observationDedupKey,
  prVerdict,
  recordCiObservation,
  scopeVerdicts,
  UnknownCheckScopeRefused,
  UnknownVerdictRefused,
  UnsupportedProviderRefused,
  VERDICT_SEVERITY,
} from "../../src/control_plane/ci_ingest.js";
import type { AppendedEvent } from "../../src/control_plane/events.js";
import { registerConsumer, subscribe } from "../../src/control_plane/events.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const REPO = "repo-1";
const PR_NUMBER = 7;

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
  return productionTemplate.copyInto(caseRoot("ci"));
}

/**
 * The source's `cp` fixture: a production control plane created at `T0`, with
 * the repository and pull request an observation needs already in it.
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
  addRepository(connection);
  addPullRequest(connection);
  return connection;
}

// --------------------------------------------------------------------------
// helpers -- the smallest legal surroundings an observation needs
// --------------------------------------------------------------------------

function addRepository(cp: SqliteDatabase, repoId: string = REPO, at: number = T0): string {
  cp.prepare<[string, number, number]>(
    `
        INSERT INTO repository (repo_id, provider, provider_repo_id, owner, name,
                                created_at_ms, updated_at_ms)
        VALUES (?, 'github', NULL, 'acme', 'widget', ?, ?)
        `,
  ).run(repoId, at, at);
  return repoId;
}

/**
 * A bare spine row for a head observation, so a PR row has a `head_event_seq`.
 *
 * Written with SQL rather than through `appendEvent` on purpose: the PR head
 * projection is another agent's surface (section 7.2), and a CI test that went
 * through it would fail for reasons that have nothing to do with CI.
 */
function addHeadEvent(cp: SqliteDatabase, headSha: string, at: number): number {
  const cursor = cp
    .prepare<[string, string, string, number, number]>(
      `
        INSERT INTO event (event_id, event_type, subject_kind, subject_id, run_id, payload,
                           producer, producer_epoch, dedup_key, occurred_at_ms, ingested_at_ms)
        VALUES (?, 'pr_head_updated', 'pull_request', ?, NULL, '{}', 'gh-watcher', NULL,
                ?, ?, ?)
        `,
    )
    .run(
      `evt-head-${headSha.slice(0, 4)}-${at}`,
      `${REPO}#${PR_NUMBER}`,
      `pr_head/${REPO}/${PR_NUMBER}/${headSha}`,
      at,
      at,
    );
  return Number(cursor.lastInsertRowid);
}

function addPullRequest(cp: SqliteDatabase, headSha: string = SHA_A, at: number = T0): string {
  const headEventSeq = addHeadEvent(cp, headSha, at);
  cp.prepare<[string, number, string, number, number, number, number]>(
    `
        INSERT INTO pull_request (pr_id, repo_id, pr_number, provider_pr_id, head_sha,
                                  head_observed_at_ms, head_event_seq, state, merge_commit_sha,
                                  merged_at_ms, closed_at_ms, created_at_ms, updated_at_ms)
        VALUES ('pr-1', ?, ?, NULL, ?, ?, ?, 'open', NULL, NULL, NULL, ?, ?)
        `,
  ).run(REPO, PR_NUMBER, headSha, at, headEventSeq, at, at);
  return "pr-1";
}

/** Advance the PR head, in the provider's order the monotonicity trigger requires. */
function moveHead(cp: SqliteDatabase, headSha: string, at: number): void {
  const headEventSeq = addHeadEvent(cp, headSha, at);
  cp.prepare<[string, number, number, number]>(
    `
        UPDATE pull_request
           SET head_sha = ?, head_observed_at_ms = ?, head_event_seq = ?, updated_at_ms = ?
         WHERE pr_id = 'pr-1'
        `,
  ).run(headSha, at, headEventSeq, at);
}

function observe(
  cp: SqliteDatabase,
  options: {
    readonly observationId: string;
    readonly verdict: string;
    readonly at: number;
    readonly headSha?: string;
    readonly checkScope?: string;
    readonly scopeId?: string;
    readonly attempt?: number;
    readonly provider?: string;
  },
): AppendedEvent {
  const {
    observationId,
    verdict,
    at,
    headSha = SHA_A,
    checkScope = "check_suite",
    scopeId = "suite-1",
    attempt = 1,
  } = options;
  return recordCiObservation(cp, {
    observationId,
    repoId: REPO,
    prNumber: PR_NUMBER,
    headSha,
    checkScope,
    scopeId,
    attempt,
    verdict,
    observer: "gh-watcher",
    observerEpoch: 1,
    occurredAtMs: at,
    ingestedAtMs: at,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
  });
}

/**
 * A subscribed delivery consumer, so the fan-out has something to fan out to.
 *
 * Without one, "the duplicate append ran nothing downstream" would be true
 * vacuously: there would be no consumption row and no outbox row to be absent.
 */
function registerDeliveryConsumer(cp: SqliteDatabase, at: number = T0): string {
  registerConsumer(cp, {
    consumerId: "secretary",
    kind: "delivery",
    leaseResource: "consumer:secretary",
    registeredAtMs: at,
    registeredFromSeq: 0,
  });
  subscribe(cp, {
    consumerId: "secretary",
    eventType: "ci_observed",
    recipient: "secretary",
    addedAtMs: at,
  });
  return "secretary";
}

/**
 * The row counts of the four tables an append touches.
 *
 * `COUNT(*)` is an aggregate expression, so it is read with `.pluck()` --
 * positionally -- rather than by a name SQLite never promised (`D-0021`).
 */
function counts(cp: SqliteDatabase): Record<string, number> {
  const result: Record<string, number> = {};
  for (const table of ["event", "ci_observation", "event_consumption", "outbox"]) {
    result[table] = Number(cp.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
  }
  return result;
}

function verdictByScope(cp: SqliteDatabase): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of scopeVerdicts(cp, { repoId: REPO, prNumber: PR_NUMBER })) {
    result[row.scopeId] = row.verdict;
  }
  return result;
}

// --------------------------------------------------------------------------
// the identity, rendered once
// --------------------------------------------------------------------------

describe("the identity, rendered once", () => {
  test("the dedup key is the identity tuple rendered in the documented order", () => {
    expect(
      observationDedupKey({
        repoId: REPO,
        prNumber: PR_NUMBER,
        headSha: SHA_A,
        checkScope: "check_suite",
        scopeId: "suite-1",
        attempt: 2,
        verdict: "failed",
      }),
    ).toBe(`ci/github/${REPO}/7/${SHA_A}/check_suite/suite-1/2/failed`);
  });

  test("the appended event carries the rendered identity as its dedup key", () => {
    const cp = cpFixture();
    const appended = observe(cp, { observationId: "obs-1", verdict: "passed", at: T0 });

    const dedupKey = cp
      .prepare<[number | null], string>("SELECT dedup_key FROM event WHERE seq = ?")
      .pluck()
      .get(appended.seq);
    expect(dedupKey).toBe(
      observationDedupKey({
        repoId: REPO,
        prNumber: PR_NUMBER,
        headSha: SHA_A,
        checkScope: "check_suite",
        scopeId: "suite-1",
        attempt: 1,
        verdict: "passed",
      }),
    );
  });

  test("the evidence row is linked to the seq the append assigned", () => {
    const cp = cpFixture();
    const appended = observe(cp, { observationId: "obs-1", verdict: "passed", at: T0 });

    expect(appended.duplicate).toBe(false);
    expect(
      cp
        .prepare<[], number>("SELECT event_seq FROM ci_observation WHERE observation_id = 'obs-1'")
        .pluck()
        .get(),
    ).toBe(appended.seq);
  });
});

// --------------------------------------------------------------------------
// idempotency and the recovered verdict
// --------------------------------------------------------------------------

describe("idempotency and the recovered verdict", () => {
  test("a repoll of the identical fact is a noop at the first statement of the append", () => {
    const cp = cpFixture();
    registerDeliveryConsumer(cp);
    observe(cp, { observationId: "obs-1", verdict: "passed", at: T0 });
    const before = counts(cp);

    const repoll = observe(cp, { observationId: "obs-2", verdict: "passed", at: T0 + 5_000 });

    expect(repoll.duplicate).toBe(true);
    expect(repoll.seq).toBeNull();
    // Nothing downstream of statement 1 ran: no second consumption row, no
    // second outbox row, and no evidence row for the re-poll's own id.
    expect(repoll.consumptions).toEqual([]);
    expect(repoll.messages).toEqual([]);
    expect(counts(cp)).toEqual(before);
    expect(
      Number(
        cp
          .prepare("SELECT COUNT(*) FROM ci_observation WHERE observation_id = 'obs-2'")
          .pluck()
          .get(),
      ),
    ).toBe(0);
  });

  test("a recovered verdict for the same attempt appends and moves the projection", () => {
    const cp = cpFixture();
    observe(cp, { observationId: "obs-1", verdict: "indeterminate", at: T0 + 1_000 });
    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("indeterminate");

    const recovered = observe(cp, { observationId: "obs-2", verdict: "failed", at: T0 + 2_000 });

    expect(recovered.duplicate).toBe(false);
    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("failed");
    // The indeterminate observation is not deleted or overwritten; it is what we
    // actually saw at the time.
    expect(
      cp
        .prepare<[], string>("SELECT verdict FROM ci_observation WHERE observation_id = 'obs-1'")
        .pluck()
        .get(),
    ).toBe("indeterminate");
  });

  test("a repeat of the recovered verdict is still refused", () => {
    const cp = cpFixture();
    observe(cp, { observationId: "obs-1", verdict: "indeterminate", at: T0 + 1_000 });
    observe(cp, { observationId: "obs-2", verdict: "failed", at: T0 + 2_000 });

    const again = observe(cp, { observationId: "obs-3", verdict: "failed", at: T0 + 3_000 });

    expect(again.duplicate).toBe(true);
    expect(
      Number(
        cp.prepare("SELECT COUNT(*) FROM ci_observation WHERE verdict = 'failed'").pluck().get(),
      ),
    ).toBe(1);
  });
});

// --------------------------------------------------------------------------
// ordering: the head, and the late arrival
// --------------------------------------------------------------------------

describe("ordering: the head, and the late arrival", () => {
  test("a head update invalidates prior verdicts instead of letting them be overwritten", () => {
    const cp = cpFixture();
    observe(cp, { observationId: "obs-1", verdict: "failed", at: T0 + 1_000 });
    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("failed");

    moveHead(cp, SHA_B, T0 + 2_000);

    // The old verdict is gone from the projection without anything having been
    // written over it, and there is no evidence at all for the new head yet.
    expect(scopeVerdicts(cp, { repoId: REPO, prNumber: PR_NUMBER })).toEqual([]);
    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("no_run");
    expect(
      cp
        .prepare("SELECT head_sha, verdict FROM ci_observation WHERE observation_id = 'obs-1'")
        .raw()
        .get(),
    ).toEqual([SHA_A, "failed"]);
  });

  test("a superseded head observation is never eligible again", () => {
    const cp = cpFixture();
    observe(cp, { observationId: "obs-1", verdict: "failed", at: T0 + 1_000 });
    moveHead(cp, SHA_B, T0 + 2_000);

    observe(cp, {
      observationId: "obs-2",
      verdict: "passed",
      at: T0 + 3_000,
      headSha: SHA_B,
    });

    expect(verdictByScope(cp)).toEqual({ "suite-1": "passed" });
    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("passed");
    expect(Number(cp.prepare("SELECT COUNT(*) FROM ci_observation").pluck().get())).toBe(2);
  });

  test("a late arrival that orders lower is stored and does not move the projection", () => {
    const cp = cpFixture();
    observe(cp, { observationId: "obs-late-loser", verdict: "failed", at: T0 + 2_000 });
    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("failed");

    const late = observe(cp, { observationId: "obs-2", verdict: "passed", at: T0 + 1_000 });

    expect(late.duplicate).toBe(false);
    expect(
      Number(
        cp
          .prepare("SELECT COUNT(*) FROM ci_observation WHERE observation_id = 'obs-2'")
          .pluck()
          .get(),
      ),
    ).toBe(1);
    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("failed");
  });

  test("a higher attempt wins over an earlier one even when it arrives first", () => {
    const cp = cpFixture();
    observe(cp, { observationId: "obs-2", verdict: "passed", at: T0 + 1_000, attempt: 2 });
    observe(cp, { observationId: "obs-1", verdict: "failed", at: T0 + 2_000, attempt: 1 });

    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("passed");
  });
});

// --------------------------------------------------------------------------
// the rollup's subordinate eligibility, and the severity fold
// --------------------------------------------------------------------------

describe("the rollup's subordinate eligibility, and the severity fold", () => {
  test("a rollup drops out of the projection once a finegrained scope exists", () => {
    const cp = cpFixture();
    observe(cp, {
      observationId: "obs-rollup",
      verdict: "failed",
      at: T0 + 1_000,
      checkScope: "rollup",
      scopeId: "head",
    });
    expect(verdictByScope(cp)).toEqual({ head: "failed" });

    observe(cp, { observationId: "obs-suite", verdict: "passed", at: T0 + 2_000 });

    expect(verdictByScope(cp)).toEqual({ "suite-1": "passed" });
    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("passed");
  });

  test("indeterminate outranks passed because an unobservable check is not a green one", () => {
    const cp = cpFixture();
    observe(cp, {
      observationId: "obs-1",
      verdict: "passed",
      at: T0 + 1_000,
      scopeId: "suite-1",
    });
    observe(cp, {
      observationId: "obs-2",
      verdict: "indeterminate",
      at: T0 + 1_000,
      scopeId: "suite-2",
    });

    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("indeterminate");
  });

  test("failed outranks every other verdict in the fold", () => {
    const cp = cpFixture();
    const verdicts = ["passed", "cancelled", "timed_out", "failed"];
    for (const [index, verdict] of verdicts.entries()) {
      observe(cp, {
        observationId: `obs-${index}`,
        verdict,
        at: T0 + 1_000,
        scopeId: `suite-${index}`,
      });
    }

    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("failed");
  });

  test("no run is absent evidence rather than a pass", () => {
    const cp = cpFixture();
    observe(cp, { observationId: "obs-1", verdict: "no_run", at: T0 + 1_000 });

    expect(verdictByScope(cp)).toEqual({ "suite-1": "no_run" });
    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("no_run");
  });

  test("a no run scope never outvotes a real verdict", () => {
    const cp = cpFixture();
    observe(cp, {
      observationId: "obs-1",
      verdict: "no_run",
      at: T0 + 1_000,
      scopeId: "suite-1",
    });
    observe(cp, {
      observationId: "obs-2",
      verdict: "passed",
      at: T0 + 1_000,
      scopeId: "suite-2",
    });

    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("passed");
  });

  test("a pull request with no observation at all is absent evidence", () => {
    const cp = cpFixture();
    expect(prVerdict(cp, { repoId: REPO, prNumber: PR_NUMBER })).toBe("no_run");
  });

  test("the severity order ranks every member of the closed verdict set", () => {
    cpFixture();
    expect(new Set(Object.keys(VERDICT_SEVERITY))).toEqual(CI_VERDICTS);
    // Narrowed with a throw rather than a cast: the assertion above has already
    // pinned that every member of the closed set has a rank, so `undefined` here
    // is a bug that should say so rather than reach `toBeGreaterThan` as `NaN`.
    const severity = (verdict: string): number => {
      const rank = VERDICT_SEVERITY[verdict];
      if (rank === undefined) {
        throw new Error(`no severity for '${verdict}'`);
      }
      return rank;
    };
    expect(severity("failed")).toBeGreaterThan(severity("timed_out"));
    expect(severity("timed_out")).toBeGreaterThan(severity("cancelled"));
    expect(severity("cancelled")).toBeGreaterThan(severity("indeterminate"));
    expect(severity("indeterminate")).toBeGreaterThan(severity("passed"));
  });
});

// --------------------------------------------------------------------------
// refusals at the edge
// --------------------------------------------------------------------------

describe("refusals at the edge", () => {
  test("a case variant provider is refused at the edge", () => {
    const cp = cpFixture();
    expectRefusal(
      () => observe(cp, { observationId: "obs-1", verdict: "passed", at: T0, provider: "GITHUB" }),
      UnsupportedProviderRefused,
    );

    expect(counts(cp).ci_observation).toBe(0);
  });

  test("an abbreviated head sha is refused because two heads can share a prefix", () => {
    const cp = cpFixture();
    expectRefusal(
      () =>
        observe(cp, {
          observationId: "obs-1",
          verdict: "passed",
          at: T0,
          headSha: SHA_A.slice(0, 7),
        }),
      MalformedHeadShaRefused,
    );
  });

  test("an upper case head sha is refused", () => {
    const cp = cpFixture();
    expectRefusal(
      () =>
        observe(cp, {
          observationId: "obs-1",
          verdict: "passed",
          at: T0,
          headSha: SHA_A.toUpperCase(),
        }),
      MalformedHeadShaRefused,
    );
  });

  test("an attempt below one is refused", () => {
    const cp = cpFixture();
    expectRefusal(
      () => observe(cp, { observationId: "obs-1", verdict: "passed", at: T0, attempt: 0 }),
      MalformedAttemptRefused,
    );
  });

  test("a verdict outside the closed set is refused", () => {
    const cp = cpFixture();
    expectRefusal(
      () => observe(cp, { observationId: "obs-1", verdict: "green", at: T0 }),
      UnknownVerdictRefused,
    );
  });

  test("a check scope outside the closed set is refused", () => {
    const cp = cpFixture();
    expectRefusal(
      () => observe(cp, { observationId: "obs-1", verdict: "passed", at: T0, checkScope: "job" }),
      UnknownCheckScopeRefused,
    );
  });

  test("an empty scope id is refused so the rendered key stays unambiguous", () => {
    const cp = cpFixture();
    expectRefusal(
      () => observe(cp, { observationId: "obs-1", verdict: "passed", at: T0, scopeId: "" }),
      EmptyIdentityFieldRefused,
    );
  });

  test("a refused observation appends no event", () => {
    const cp = cpFixture();
    registerDeliveryConsumer(cp);
    const before = counts(cp);

    expectRefusal(
      () => observe(cp, { observationId: "obs-1", verdict: "passed", at: T0, headSha: "abc" }),
      MalformedHeadShaRefused,
    );

    expect(counts(cp)).toEqual(before);
  });
});
