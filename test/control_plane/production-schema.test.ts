/**
 * The production control-plane DDL -- section 11's verification table, made executable.
 *
 * Ported from interlock `tests/control_plane/test_production_schema.py` at
 * `65f36c5`. Every case here maps to one source node id; the mapping is
 * recorded in the parity ledger.
 *
 * `docs/production-schema.md` section 11 is a list of claims about constraints
 * that were exercised by hand against an in-memory database while the design was
 * being written. A hand-run check is evidence that a claim *was* true once; it is
 * not a thing that fails when someone widens a `CHECK` a year from now. This
 * module turns each row of that table into one test named after the claim, so the
 * document and the schema cannot drift apart silently: a change to the DDL that
 * contradicts the design has to break a test whose name says which sentence of the
 * design it broke.
 *
 * Three tests here are not from section 11, and each is an obligation the design
 * hands to the implementation in so many words:
 *
 * * **Commit order** (section 5.2, `D-0030`). `event.seq` is only usable as a
 *   consumer cursor if a committed gap can never be back-filled. Section 11 says
 *   outright that it does not establish this, because it needs two connections and
 *   interleaved transactions. `no committed event seq is ever observed out of
 *   commit order` is that test, and it is the thing that fails if this database
 *   is ever put behind something admitting concurrent writers.
 * * **All-or-nothing append** (section 5.4). The append is one transaction over
 *   the event, the per-consumer consumption rows, the delivery outbox rows and any
 *   typed side table. The property that matters on the failure path is that a
 *   fan-out which dies part way leaves *no* event row behind -- an event with no
 *   delivery record is precisely v1's push-vs-poll duplication returning.
 * * **The two adjudicated design gaps.** `run.status`'s closed set and
 *   forward-only rule, and `policy_detection_latency.budget_kind`, were settled
 *   during implementation because section 2 and `time-base-policy.md` section
 *   3.2 respectively left them underspecified. Each gets a test that pins the
 *   decision, so the next reader finds the adjudication asserted rather than
 *   inferred from the DDL.
 *
 * One section 11 row is **stale** and is deliberately not reproduced as written --
 * see `gate stage may only name an open or advance transition of its own gate`.
 *
 * Every timestamp below is an integer of milliseconds since the Unix epoch, and
 * every one of them comes from {@link T0} and arithmetic on it rather than from a
 * clock. That is the schema's own convention (no timestamp column has a
 * `DEFAULT`) applied to its tests: a suite whose expectations move with the wall
 * clock cannot assert a tolerance boundary.
 *
 * Translation notes, each a rule rather than a local choice:
 *
 * * The source's `db_path` and `cp` fixtures are plain functions called inside
 *   the test (conventions rule 8); every connection registers its `close()` with
 *   `onTestFinished` at the point of acquisition (rule 1), so the LIFO unwind and
 *   the "only what was acquired" property both hold.
 * * `sqlite3.IntegrityError` and `sqlite3.OperationalError` become
 *   {@link expectSqliteError} on the result **code** (`D-0016`) -- better-sqlite3
 *   raises one error type for everything. Where the source also gave a `match=`,
 *   both halves are kept: the message half is a `RAISE(ABORT, ...)` string or a
 *   `CHECK`/`UNIQUE` message SQLite renders from the DDL, and the DDL is carried
 *   byte-identically, so the source's patterns match unchanged.
 * * Every aggregate, every expression and every bare bound parameter in a
 *   `SELECT` list is read **positionally** -- `.pluck()` for a single column,
 *   `.raw()` for a tuple -- because SQLite promises no name for one and reading it
 *   by the name it "obviously" has silently yields `undefined` (`D-0021`,
 *   `D-0007`). The source reads tuples, so `.raw()` also keeps the shape its
 *   assertions compare.
 * * The `caseRoot` label is `s11`, a short section nickname (`D-0020`). No
 *   refusal this file matches on interpolates a path at all -- they are all
 *   SQLite's own constraint messages -- and the label shares no word with any of
 *   the `match` literals below, so none of them can be satisfied by the temp path.
 * * The source's `second_connection` sets `isolation_level=None`,
 *   `PRAGMA foreign_keys = ON` and `PRAGMA busy_timeout = 0`. better-sqlite3 has
 *   no implicit transaction management to switch off, so `isolation_level=None`
 *   is the runtime's own behaviour; the other two are **not** the driver's
 *   defaults (foreign keys are off, and the busy timeout is 5,000 ms), so they
 *   are set explicitly and pinned by the one target-only test in this file.
 *   Letting the driver's 5,000 ms stand would turn "a lock conflict surfaces as a
 *   failure to acquire" into "a five-second pause and then a failure", which is
 *   what the source's comment says the zero is there to prevent.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { expectSqliteError } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/**
 * The result-code family every `CHECK`, `UNIQUE`, foreign key and
 * `RAISE(ABORT, ...)` refusal below arrives as -- Python's
 * `sqlite3.IntegrityError` (`D-0016`).
 */
const CONSTRAINT = /^SQLITE_CONSTRAINT/;

/** The family Python's `sqlite3.OperationalError` carries for a lock conflict. */
const CONTENTION = /^SQLITE_(BUSY|LOCKED)/;

/**
 * The note of the revision seeded by `0002_policy_seed.sql`. The seed is the
 * numeric table of `time-base-policy.md` section 3 as data, so the tests that
 * read policy read *those* numbers rather than restating them.
 */
const SEED_NOTE =
  "initial time base: detection latency budgets, gate stage tolerances " +
  "and gate stage owners as first decided";

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
 *
 * The source hands out a name where no file exists yet; this hands out one that
 * already holds the migrated database. Every case in this file passed that name
 * straight to the `cp` fixture, so nothing here observes the difference -- the
 * cases that do assert about an absent database live in `migrator.test.ts`,
 * which is why that file keeps creating its own.
 */
function productionDb(): string {
  return productionTemplate.copyInto(caseRoot("s11"));
}

/**
 * The source's `cp` fixture: a production control plane created at `T0`.
 *
 * The connection now comes from `openProductionControlPlane` over a copy rather
 * than from creating one. Both apply the same two pragmas, and opening verifies
 * the copy is at head -- so a template that failed to build is a refusal here
 * rather than a case that quietly runs against the wrong schema.
 */
function cpFixture(path: string = productionDb()): SqliteDatabase {
  const connection = openProductionControlPlane(path);
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

/**
 * A second writer against the same file, configured like the first.
 *
 * The source passes `isolation_level=None` because these tests drive
 * `BEGIN`/`COMMIT` themselves -- the point of the commit-order test is *when*
 * each transaction commits, which the driver's implicit transaction management
 * would decide. better-sqlite3 has no implicit transaction management, so that
 * half is the runtime's own behaviour. The busy timeout defaults to zero so that
 * a lock conflict surfaces as a failure to acquire rather than as a five-second
 * pause -- which is what better-sqlite3 would otherwise do, so the pragma is not
 * decoration.
 */
function secondConnection(path: string, busyTimeoutMs = 0): SqliteDatabase {
  const connection = new Database(path, { fileMustExist: true, timeout: busyTimeoutMs });
  onTestFinished(() => {
    try {
      connection.close();
    } catch {
      // Already closed by the test; closing twice is not worth failing over.
    }
  });
  connection.pragma("foreign_keys = ON");
  connection.pragma(`busy_timeout = ${busyTimeoutMs}`);
  return connection;
}

/** `value` unless it was not supplied at all -- `null` is a value, not an absence. */
function or<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

// --------------------------------------------------------------------------
// helpers -- the smallest legal row of each kind
// --------------------------------------------------------------------------

function addRun(cp: SqliteDatabase, runId = "run-1", status = "running", at: number = T0): string {
  cp.prepare<[string, string, number, number]>(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
  ).run(runId, status, at, at);
  return runId;
}

interface EventOverrides {
  readonly event_type?: string;
  readonly subject_kind?: string;
  readonly subject_id?: string;
  readonly run_id?: string | null;
  readonly payload?: string;
  readonly producer?: string;
  readonly producer_epoch?: number | null;
  readonly dedup_key?: string;
}

/** Append one event and return the `seq` it was assigned. */
function addEvent(
  cp: SqliteDatabase,
  eventId = "evt-1",
  at: number = T0,
  overrides: EventOverrides = {},
): number {
  const cursor = cp
    .prepare<{
      event_id: string;
      event_type: string;
      subject_kind: string;
      subject_id: string;
      run_id: string | null;
      payload: string;
      producer: string;
      producer_epoch: number | null;
      dedup_key: string;
      occurred_at_ms: number;
      ingested_at_ms: number;
    }>(
      `
        INSERT INTO event (event_id, event_type, subject_kind, subject_id, run_id, payload,
                           producer, producer_epoch, dedup_key, occurred_at_ms, ingested_at_ms)
        VALUES (:event_id, :event_type, :subject_kind, :subject_id, :run_id, :payload,
                :producer, :producer_epoch, :dedup_key, :occurred_at_ms, :ingested_at_ms)
        `,
    )
    .run({
      event_id: eventId,
      event_type: or(overrides.event_type, "ci.check_suite.completed"),
      subject_kind: or(overrides.subject_kind, "run"),
      subject_id: or(overrides.subject_id, "run-1"),
      run_id: or(overrides.run_id, null),
      payload: or(overrides.payload, "{}"),
      producer: or(overrides.producer, "gh-watcher"),
      producer_epoch: or(overrides.producer_epoch, null),
      dedup_key: or(overrides.dedup_key, `dk/${eventId}`),
      occurred_at_ms: at,
      ingested_at_ms: at,
    });
  return Number(cursor.lastInsertRowid);
}

function addConsumer(
  cp: SqliteDatabase,
  consumerId = "cons-1",
  kind = "compute",
  at: number = T0,
  registeredFromSeq = 0,
): string {
  cp.prepare<[string, string, string, number, number]>(
    `
        INSERT INTO consumer (consumer_id, kind, lease_resource, registered_at_ms,
                              registered_from_seq)
        VALUES (?, ?, ?, ?, ?)
        `,
  ).run(consumerId, kind, `consumer:${consumerId}`, at, registeredFromSeq);
  return consumerId;
}

function addSubscription(
  cp: SqliteDatabase,
  consumerId = "cons-1",
  eventType = "ci.check_suite.completed",
  recipient: string | null = null,
  at: number = T0,
): void {
  cp.prepare<[string, string, string | null, number]>(
    "INSERT INTO consumer_subscription (consumer_id, event_type, recipient, added_at_ms)" +
      " VALUES (?, ?, ?, ?)",
  ).run(consumerId, eventType, recipient, at);
}

interface ConsumptionOverrides {
  readonly status?: string;
  readonly attempt_count?: number;
  readonly message_id?: string | null;
  readonly last_error?: string | null;
  readonly writer_epoch?: number | null;
  readonly settled_at_ms?: number | null;
}

function addConsumption(
  cp: SqliteDatabase,
  consumerId: string,
  eventSeq: number,
  at: number = T0,
  overrides: ConsumptionOverrides = {},
): void {
  cp.prepare<{
    consumer_id: string;
    event_seq: number;
    status: string;
    attempt_count: number;
    message_id: string | null;
    last_error: string | null;
    writer_epoch: number | null;
    created_at_ms: number;
    settled_at_ms: number | null;
  }>(
    `
        INSERT INTO event_consumption (consumer_id, event_seq, status, attempt_count, message_id,
                                       last_error, writer_epoch, created_at_ms, settled_at_ms)
        VALUES (:consumer_id, :event_seq, :status, :attempt_count, :message_id, :last_error,
                :writer_epoch, :created_at_ms, :settled_at_ms)
        `,
  ).run({
    consumer_id: consumerId,
    event_seq: eventSeq,
    status: or(overrides.status, "pending"),
    attempt_count: or(overrides.attempt_count, 0),
    message_id: or(overrides.message_id, null),
    last_error: or(overrides.last_error, null),
    writer_epoch: or(overrides.writer_epoch, null),
    created_at_ms: at,
    settled_at_ms: or(overrides.settled_at_ms, null),
  });
}

interface OutboxOverrides {
  readonly run_id?: string | null;
  readonly recipient?: string;
  readonly payload?: string;
  readonly status?: string;
  readonly retry_count?: number;
  readonly writer_epoch?: number | null;
  readonly delivered_at_ms?: number | null;
  readonly acked_at_ms?: number | null;
}

function addOutbox(
  cp: SqliteDatabase,
  messageId = "msg-1",
  dedupKey = "dk-1",
  at: number = T0,
  overrides: OutboxOverrides = {},
): string {
  cp.prepare<{
    message_id: string;
    run_id: string | null;
    recipient: string;
    payload: string;
    dedup_key: string;
    status: string;
    retry_count: number;
    writer_epoch: number | null;
    enqueued_at_ms: number;
    delivered_at_ms: number | null;
    acked_at_ms: number | null;
  }>(
    `
        INSERT INTO outbox (message_id, run_id, recipient, payload, dedup_key, status,
                            retry_count, writer_epoch, enqueued_at_ms, delivered_at_ms,
                            acked_at_ms)
        VALUES (:message_id, :run_id, :recipient, :payload, :dedup_key, :status, :retry_count,
                :writer_epoch, :enqueued_at_ms, :delivered_at_ms, :acked_at_ms)
        `,
  ).run({
    message_id: messageId,
    run_id: or(overrides.run_id, null),
    recipient: or(overrides.recipient, "secretary"),
    payload: or(overrides.payload, "{}"),
    dedup_key: dedupKey,
    status: or(overrides.status, "pending"),
    retry_count: or(overrides.retry_count, 0),
    writer_epoch: or(overrides.writer_epoch, null),
    enqueued_at_ms: at,
    delivered_at_ms: or(overrides.delivered_at_ms, null),
    acked_at_ms: or(overrides.acked_at_ms, null),
  });
  return messageId;
}

interface RepositoryOverrides {
  readonly provider?: string;
  readonly provider_repo_id?: string | null;
  readonly owner?: string;
  readonly name?: string;
}

function addRepository(
  cp: SqliteDatabase,
  repoId = "repo-1",
  at: number = T0,
  overrides: RepositoryOverrides = {},
): string {
  cp.prepare<{
    repo_id: string;
    provider: string;
    provider_repo_id: string | null;
    owner: string;
    name: string;
    at: number;
  }>(
    `
        INSERT INTO repository (repo_id, provider, provider_repo_id, owner, name,
                                created_at_ms, updated_at_ms)
        VALUES (:repo_id, :provider, :provider_repo_id, :owner, :name, :at, :at)
        `,
  ).run({
    repo_id: repoId,
    provider: or(overrides.provider, "github"),
    provider_repo_id: or(overrides.provider_repo_id, null),
    owner: or(overrides.owner, "acme"),
    name: or(overrides.name, "widget"),
    at,
  });
  return repoId;
}

interface PullRequestOverrides {
  readonly repo_id?: string;
  readonly provider_pr_id?: string | null;
  readonly state?: string;
  readonly merge_commit_sha?: string | null;
  readonly merged_at_ms?: number | null;
  readonly closed_at_ms?: number | null;
}

/**
 * A PR row, with an event appended for its head observation if none is given.
 *
 * `head_event_seq` is `NOT NULL`: a head is never recorded except as the
 * projection of an observation on the spine, so the helper cannot build a
 * legal row without one.
 */
function addPullRequest(
  cp: SqliteDatabase,
  prId = "pr-1",
  prNumber = 7,
  headSha: string = SHA_A,
  headEventSeq: number | null = null,
  at: number = T0,
  overrides: PullRequestOverrides = {},
): string {
  const seq =
    headEventSeq === null
      ? addEvent(cp, `evt-head-${prId}-${headSha.slice(0, 4)}`, at, {
          event_type: "pr.head.observed",
          subject_kind: "pull_request",
          subject_id: prId,
        })
      : headEventSeq;
  cp.prepare<{
    pr_id: string;
    repo_id: string;
    pr_number: number;
    provider_pr_id: string | null;
    head_sha: string;
    head_event_seq: number;
    state: string;
    merge_commit_sha: string | null;
    merged_at_ms: number | null;
    closed_at_ms: number | null;
    at: number;
  }>(
    `
        INSERT INTO pull_request (pr_id, repo_id, pr_number, provider_pr_id, head_sha,
                                  head_observed_at_ms, head_event_seq, state, merge_commit_sha,
                                  merged_at_ms, closed_at_ms, created_at_ms, updated_at_ms)
        VALUES (:pr_id, :repo_id, :pr_number, :provider_pr_id, :head_sha, :at, :head_event_seq,
                :state, :merge_commit_sha, :merged_at_ms, :closed_at_ms, :at, :at)
        `,
  ).run({
    pr_id: prId,
    repo_id: or(overrides.repo_id, "repo-1"),
    pr_number: prNumber,
    provider_pr_id: or(overrides.provider_pr_id, null),
    head_sha: headSha,
    head_event_seq: seq,
    state: or(overrides.state, "open"),
    merge_commit_sha: or(overrides.merge_commit_sha, null),
    merged_at_ms: or(overrides.merged_at_ms, null),
    closed_at_ms: or(overrides.closed_at_ms, null),
    at,
  });
  return prId;
}

interface RunPrLinkOverrides {
  readonly unlinked_at_ms?: number | null;
  readonly unlink_reason?: string | null;
}

function addRunPrLink(
  cp: SqliteDatabase,
  runId = "run-1",
  prId = "pr-1",
  role = "primary",
  resolution = "project_registry",
  at: number = T0,
  overrides: RunPrLinkOverrides = {},
): void {
  cp.prepare<{
    run_id: string;
    pr_id: string;
    role: string;
    resolution: string;
    linked_at_ms: number;
    unlinked_at_ms: number | null;
    unlink_reason: string | null;
  }>(
    `
        INSERT INTO run_pr_link (run_id, pr_id, role, resolution, linked_at_ms,
                                 unlinked_at_ms, unlink_reason)
        VALUES (:run_id, :pr_id, :role, :resolution, :linked_at_ms, :unlinked_at_ms,
                :unlink_reason)
        `,
  ).run({
    run_id: runId,
    pr_id: prId,
    role,
    resolution,
    linked_at_ms: at,
    unlinked_at_ms: or(overrides.unlinked_at_ms, null),
    unlink_reason: or(overrides.unlink_reason, null),
  });
}

interface CiObservationOverrides {
  readonly provider?: string;
  readonly repo_id?: string;
  readonly pr_number?: number;
  readonly head_sha?: string;
  readonly check_scope?: string;
  readonly scope_id?: string;
  readonly attempt?: number;
  readonly verdict?: string;
  readonly verdict_detail?: string | null;
  readonly source_id?: string | null;
  readonly observer?: string;
  readonly observer_epoch?: number;
}

function addCiObservation(
  cp: SqliteDatabase,
  observationId = "obs-1",
  eventSeq: number | null = null,
  at: number = T0,
  overrides: CiObservationOverrides = {},
): string {
  const seq =
    eventSeq === null
      ? addEvent(cp, `evt-${observationId}`, at, {
          subject_kind: "pull_request",
          subject_id: "pr-1",
        })
      : eventSeq;
  cp.prepare<{
    observation_id: string;
    event_seq: number;
    provider: string;
    repo_id: string;
    pr_number: number;
    head_sha: string;
    check_scope: string;
    scope_id: string;
    attempt: number;
    verdict: string;
    verdict_detail: string | null;
    source_id: string | null;
    observer: string;
    observer_epoch: number;
    occurred_at_ms: number;
    ingested_at_ms: number;
  }>(
    `
        INSERT INTO ci_observation (observation_id, event_seq, provider, repo_id, pr_number,
                                    head_sha, check_scope, scope_id, attempt, verdict,
                                    verdict_detail, source_id, observer, observer_epoch,
                                    occurred_at_ms, ingested_at_ms)
        VALUES (:observation_id, :event_seq, :provider, :repo_id, :pr_number, :head_sha,
                :check_scope, :scope_id, :attempt, :verdict, :verdict_detail, :source_id,
                :observer, :observer_epoch, :occurred_at_ms, :ingested_at_ms)
        `,
  ).run({
    observation_id: observationId,
    event_seq: seq,
    provider: or(overrides.provider, "github"),
    repo_id: or(overrides.repo_id, "repo-1"),
    pr_number: or(overrides.pr_number, 7),
    head_sha: or(overrides.head_sha, SHA_A),
    check_scope: or(overrides.check_scope, "check_suite"),
    scope_id: or(overrides.scope_id, "suite-1"),
    attempt: or(overrides.attempt, 1),
    verdict: or(overrides.verdict, "passed"),
    verdict_detail: or(overrides.verdict_detail, null),
    source_id: or(overrides.source_id, null),
    observer: or(overrides.observer, "gh-watcher"),
    observer_epoch: or(overrides.observer_epoch, 1),
    occurred_at_ms: at,
    ingested_at_ms: at,
  });
  return observationId;
}

interface WatcherScopeOverrides {
  readonly scope_kind?: string;
  readonly repo_id?: string | null;
  readonly pr_id?: string | null;
  readonly expected_interval_ms?: number;
  readonly enabled?: number;
  readonly retired_at_ms?: number | null;
}

function addWatcherScope(
  cp: SqliteDatabase,
  scopeId = "scope-1",
  at: number = T0,
  overrides: WatcherScopeOverrides = {},
): string {
  cp.prepare<{
    scope_id: string;
    scope_kind: string;
    repo_id: string | null;
    pr_id: string | null;
    expected_interval_ms: number;
    enabled: number;
    registered_at_ms: number;
    retired_at_ms: number | null;
  }>(
    `
        INSERT INTO watcher_scope (scope_id, scope_kind, repo_id, pr_id, expected_interval_ms,
                                   enabled, registered_at_ms, retired_at_ms)
        VALUES (:scope_id, :scope_kind, :repo_id, :pr_id, :expected_interval_ms, :enabled,
                :registered_at_ms, :retired_at_ms)
        `,
  ).run({
    scope_id: scopeId,
    scope_kind: or(overrides.scope_kind, "ci_repository"),
    repo_id: or(overrides.repo_id, "repo-1"),
    pr_id: or(overrides.pr_id, null),
    expected_interval_ms: or(overrides.expected_interval_ms, 60_000),
    enabled: or(overrides.enabled, 1),
    registered_at_ms: at,
    retired_at_ms: or(overrides.retired_at_ms, null),
  });
  return scopeId;
}

function addLease(
  cp: SqliteDatabase,
  resource: string,
  holder = "watcher-a",
  epoch = 1,
  at: number = T0,
  ttlMs = 300_000,
): void {
  cp.prepare<[string, string, number, number, number]>(
    "INSERT INTO lease (resource, holder, epoch, acquired_at_ms, expires_at_ms)" +
      " VALUES (?, ?, ?, ?, ?)",
  ).run(resource, holder, epoch, at, at + ttlMs);
}

/**
 * The fenced heartbeat of `docs/production-schema.md` section 8.3, verbatim
 * in shape: an upsert whose insert arm carries the same lease predicate as its
 * update arm, and which derives the lease resource from the scope rather than
 * accepting it as a parameter.
 */
const HEARTBEAT = `
INSERT INTO watcher_liveness (
        scope_id, holder, holder_epoch, last_attempt_at_ms, last_result,
        last_success_at_ms, last_change_at_ms, last_error_at_ms, last_error,
        consecutive_errors, attempt_count)
SELECT :scope_id, :holder, :epoch, :now_ms, :result,
       CASE WHEN :result <> 'error'           THEN :now_ms END,
       CASE WHEN :result =  'observed_change' THEN :now_ms END,
       CASE WHEN :result =  'error'           THEN :now_ms END,
       CASE WHEN :result =  'error'           THEN :error  END,
       CASE WHEN :result =  'error' THEN 1 ELSE 0 END, 1
 WHERE EXISTS (SELECT 1 FROM lease
                WHERE resource = 'watcher_scope:' || :scope_id
                  AND holder = :holder AND epoch = :epoch
                  AND expires_at_ms > :now_ms)
    ON CONFLICT(scope_id) DO UPDATE
   SET holder = :holder, holder_epoch = :epoch,
       last_attempt_at_ms = :now_ms, last_result = :result,
       last_success_at_ms = CASE WHEN :result <> 'error'
                                 THEN :now_ms ELSE last_success_at_ms END,
       last_change_at_ms  = CASE WHEN :result = 'observed_change'
                                 THEN :now_ms ELSE last_change_at_ms END,
       last_error_at_ms   = CASE WHEN :result = 'error'
                                 THEN :now_ms ELSE last_error_at_ms END,
       last_error         = CASE WHEN :result = 'error' THEN :error ELSE NULL END,
       consecutive_errors = CASE WHEN :result = 'error'
                                 THEN consecutive_errors + 1 ELSE 0 END,
       attempt_count      = attempt_count + 1
 WHERE watcher_liveness.holder_epoch <= :epoch
   AND EXISTS (SELECT 1 FROM lease
                WHERE resource = 'watcher_scope:' || :scope_id
                  AND holder = :holder AND epoch = :epoch
                  AND expires_at_ms > :now_ms)
`;

interface HeartbeatOptions {
  readonly holder?: string;
  readonly epoch?: number;
  readonly nowMs?: number;
  readonly result?: string;
  readonly error?: string | null;
}

/**
 * Run the fenced heartbeat and return the number of rows it affected.
 *
 * Zero rows is the refusal: either the lease is not ours or a higher epoch
 * holds the row. That the two are indistinguishable from the row count alone
 * is by design (section 8.3) -- the watcher reads once to find out which.
 */
function heartbeat(cp: SqliteDatabase, scopeId: string, options: HeartbeatOptions = {}): number {
  const cursor = cp
    .prepare<{
      scope_id: string;
      holder: string;
      epoch: number;
      now_ms: number;
      result: string;
      error: string | null;
    }>(HEARTBEAT)
    .run({
      scope_id: scopeId,
      holder: or(options.holder, "watcher-a"),
      epoch: or(options.epoch, 1),
      now_ms: or(options.nowMs, T0),
      result: or(options.result, "observed_no_change"),
      error: or(options.error, null),
    });
  return cursor.changes;
}

interface GateOverrides {
  readonly gate_type?: string;
  readonly run_id?: string | null;
  readonly subject_kind?: string;
  readonly subject_id?: string;
  readonly rationale?: string;
  readonly options?: string;
  readonly deadline_at_ms?: number | null;
  readonly stage?: string;
  readonly stage_seq?: number | null;
  readonly outcome?: string | null;
  readonly superseded_by?: string | null;
  readonly closed_at_ms?: number | null;
}

/** A gate as it must be born: stage `received`, no projection, not closed. */
function addGate(
  cp: SqliteDatabase,
  gateId = "gate-1",
  originEventSeq: number | null = null,
  at: number = T0,
  overrides: GateOverrides = {},
): string {
  const seq =
    originEventSeq === null
      ? addEvent(cp, `evt-open-${gateId}`, at, {
          subject_kind: "gate",
          subject_id: gateId,
          event_type: "gate.opened",
        })
      : originEventSeq;
  cp.prepare<{
    gate_id: string;
    gate_type: string;
    run_id: string | null;
    subject_kind: string;
    subject_id: string;
    origin_event_seq: number;
    rationale: string;
    options: string;
    deadline_at_ms: number | null;
    stage: string;
    stage_seq: number | null;
    outcome: string | null;
    superseded_by: string | null;
    at: number;
    closed_at_ms: number | null;
  }>(
    `
        INSERT INTO gate (gate_id, gate_type, run_id, subject_kind, subject_id, origin_event_seq,
                          rationale, options, deadline_at_ms, stage, stage_seq,
                          stage_entered_at_ms, outcome, superseded_by, created_at_ms, closed_at_ms)
        VALUES (:gate_id, :gate_type, :run_id, :subject_kind, :subject_id, :origin_event_seq,
                :rationale, :options, :deadline_at_ms, :stage, :stage_seq, :at, :outcome,
                :superseded_by, :at, :closed_at_ms)
        `,
  ).run({
    gate_id: gateId,
    gate_type: or(overrides.gate_type, "worker_escalation"),
    run_id: or(overrides.run_id, null),
    subject_kind: or(overrides.subject_kind, "run"),
    subject_id: or(overrides.subject_id, "run-1"),
    origin_event_seq: seq,
    rationale: or(overrides.rationale, "the worker needs a decision it may not make itself"),
    options: or(overrides.options, '["approve", "reject"]'),
    deadline_at_ms: or(overrides.deadline_at_ms, null),
    stage: or(overrides.stage, "received"),
    stage_seq: or(overrides.stage_seq, null),
    outcome: or(overrides.outcome, null),
    superseded_by: or(overrides.superseded_by, null),
    at,
    closed_at_ms: or(overrides.closed_at_ms, null),
  });
  return gateId;
}

interface GateTransitionOverrides {
  readonly actor_kind?: string;
  readonly actor_id?: string;
  readonly writer_epoch?: number | null;
  readonly message_id?: string | null;
  readonly body?: string | null;
  readonly supersedes_seq?: number | null;
}

function addGateTransition(
  cp: SqliteDatabase,
  gateId = "gate-1",
  transitionKind = "open",
  fromStage: string | null = null,
  toStage = "received",
  at: number = T0,
  overrides: GateTransitionOverrides = {},
): number {
  const cursor = cp
    .prepare<{
      gate_id: string;
      transition_kind: string;
      from_stage: string | null;
      to_stage: string;
      actor_kind: string;
      actor_id: string;
      writer_epoch: number | null;
      message_id: string | null;
      body: string | null;
      supersedes_seq: number | null;
      at: number;
    }>(
      `
        INSERT INTO gate_transition (gate_id, transition_kind, from_stage, to_stage, actor_kind,
                                     actor_id, writer_epoch, message_id, body, supersedes_seq,
                                     occurred_at_ms, recorded_at_ms)
        VALUES (:gate_id, :transition_kind, :from_stage, :to_stage, :actor_kind, :actor_id,
                :writer_epoch, :message_id, :body, :supersedes_seq, :at, :at)
        `,
    )
    .run({
      gate_id: gateId,
      transition_kind: transitionKind,
      from_stage: fromStage,
      to_stage: toStage,
      actor_kind: or(overrides.actor_kind, "worker"),
      actor_id: or(overrides.actor_id, "worker-1"),
      writer_epoch: or(overrides.writer_epoch, null),
      message_id: or(overrides.message_id, null),
      body: or(overrides.body, null),
      supersedes_seq: or(overrides.supersedes_seq, null),
      at,
    });
  return Number(cursor.lastInsertRowid);
}

/** Point the gate's projection at one of its own transitions. */
function projectGateStage(
  cp: SqliteDatabase,
  gateId: string,
  stage: string,
  stageSeq: number,
  at: number = T0,
): void {
  cp.prepare<[string, number, number, string]>(
    "UPDATE gate SET stage = ?, stage_seq = ?, stage_entered_at_ms = ? WHERE gate_id = ?",
  ).run(stage, stageSeq, at, gateId);
}

function addPolicyRevision(
  cp: SqliteDatabase,
  note: string,
  at: number,
  decidedBy = "test",
): number {
  const cursor = cp
    .prepare<[string, string, number]>(
      "INSERT INTO policy_revision (note, decided_by, effective_at_ms) VALUES (?, ?, ?)",
    )
    .run(note, decidedBy, at);
  return Number(cursor.lastInsertRowid);
}

function addDetectionLatency(
  cp: SqliteDatabase,
  revisionId: number,
  incidentClass: string,
  thresholdKind: string,
  thresholdValue: number,
  reconcilePeriodMs: number,
  budgetMs: number,
  budgetKind = "absolute_ms",
): void {
  cp.prepare<[number, string, string, number, number, number, string]>(
    `
        INSERT INTO policy_detection_latency (revision_id, incident_class, threshold_kind,
                                              threshold_value, reconcile_period_ms, budget_ms,
                                              budget_kind)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
  ).run(
    revisionId,
    incidentClass,
    thresholdKind,
    thresholdValue,
    reconcilePeriodMs,
    budgetMs,
    budgetKind,
  );
}

function addStageTolerance(
  cp: SqliteDatabase,
  revisionId: number,
  gateType: string,
  stage: string,
  toleranceMs: number | null,
): void {
  cp.prepare<[number, string, string, number | null]>(
    "INSERT INTO policy_gate_stage_tolerance (revision_id, gate_type, stage, tolerance_ms)" +
      " VALUES (?, ?, ?, ?)",
  ).run(revisionId, gateType, stage, toleranceMs);
}

interface AiInvocationOverrides {
  readonly incident_id?: string | null;
  readonly run_id?: string | null;
  readonly provider?: string;
  readonly model?: string;
  readonly adapter_version?: string;
  readonly usage_status?: string;
  readonly output_tokens?: number | null;
  readonly input_tokens?: number | null;
  readonly cache_read_tokens?: number | null;
  readonly max_output_tokens?: number | null;
  readonly model_response_count?: number;
  readonly attempt_count?: number;
  readonly finished_at_ms?: number | null;
}

function addAiInvocation(
  cp: SqliteDatabase,
  invocationId = "inv-1",
  at: number = T0,
  overrides: AiInvocationOverrides = {},
): string {
  cp.prepare<{
    invocation_id: string;
    incident_id: string | null;
    run_id: string | null;
    provider: string;
    model: string;
    adapter_version: string;
    usage_status: string;
    output_tokens: number | null;
    input_tokens: number | null;
    cache_read_tokens: number | null;
    max_output_tokens: number | null;
    model_response_count: number;
    attempt_count: number;
    started_at_ms: number;
    finished_at_ms: number | null;
  }>(
    `
        INSERT INTO ai_invocation (invocation_id, incident_id, run_id, provider, model,
                                   adapter_version, usage_status, output_tokens, input_tokens,
                                   cache_read_tokens, max_output_tokens, model_response_count,
                                   attempt_count, started_at_ms, finished_at_ms)
        VALUES (:invocation_id, :incident_id, :run_id, :provider, :model, :adapter_version,
                :usage_status, :output_tokens, :input_tokens, :cache_read_tokens,
                :max_output_tokens, :model_response_count, :attempt_count, :started_at_ms,
                :finished_at_ms)
        `,
  ).run({
    invocation_id: invocationId,
    incident_id: or(overrides.incident_id, null),
    run_id: or(overrides.run_id, null),
    provider: or(overrides.provider, "anthropic"),
    model: or(overrides.model, "some-model"),
    adapter_version: or(overrides.adapter_version, "a1"),
    usage_status: or(overrides.usage_status, "reported"),
    output_tokens: or(overrides.output_tokens, 100),
    input_tokens: or(overrides.input_tokens, 200),
    cache_read_tokens: or(overrides.cache_read_tokens, null),
    max_output_tokens: or(overrides.max_output_tokens, 1024),
    model_response_count: or(overrides.model_response_count, 1),
    attempt_count: or(overrides.attempt_count, 1),
    started_at_ms: at,
    finished_at_ms: or(overrides.finished_at_ms, null),
  });
  return invocationId;
}

/** The revision `0002_policy_seed.sql` wrote, looked up by its note. */
function seedRevisionId(cp: SqliteDatabase): number {
  const row = cp
    .prepare<[string], number>("SELECT revision_id FROM policy_revision WHERE note = ?")
    .pluck()
    .get(SEED_NOTE);
  expect(row, "0002_policy_seed.sql must have applied").not.toBeUndefined();
  return Number(row);
}

// The two liveness queries, section 8.4, and the relay-gap detector, section
// 9.6. They are reproduced here rather than imported because they are what the
// design promises the reconcile pass will be able to express -- the assertion is
// about the schema admitting the query, not about any one caller's copy of it.
const SILENCE_QUERY = `
SELECT s.scope_id,
       :now_ms - l.last_attempt_at_ms AS silent_for_ms
  FROM watcher_scope s
  JOIN watcher_liveness l ON l.scope_id = s.scope_id
  JOIN policy_detection_latency p
    ON p.incident_class = 'watcher_silence'
   AND p.revision_id = (SELECT revision_id FROM policy_revision
                         WHERE effective_at_ms <= :now_ms
                         ORDER BY effective_at_ms DESC, revision_id DESC LIMIT 1)
 WHERE s.enabled = 1 AND s.retired_at_ms IS NULL
   AND p.threshold_kind = 'scope_interval_multiple'
   AND :now_ms - l.last_attempt_at_ms > s.expected_interval_ms * p.threshold_value
`;

const COVERAGE_QUERY = `
SELECT s.scope_id
  FROM watcher_scope s
  LEFT JOIN watcher_liveness l ON l.scope_id = s.scope_id
 WHERE s.enabled = 1 AND s.retired_at_ms IS NULL
   AND l.scope_id IS NULL
`;

const RELAY_GAP_QUERY = `
WITH effective AS (
    SELECT revision_id FROM policy_revision
     WHERE effective_at_ms <= :now_ms
     ORDER BY effective_at_ms DESC, revision_id DESC
     LIMIT 1)
SELECT g.gate_id, g.gate_type, g.stage, g.stage_entered_at_ms,
       :now_ms - g.stage_entered_at_ms AS age_ms
  FROM gate g
  JOIN policy_gate_stage_tolerance p
    ON p.gate_type = g.gate_type AND p.stage = g.stage
   AND p.revision_id = (SELECT revision_id FROM effective)
 WHERE g.closed_at_ms IS NULL
   AND p.tolerance_ms IS NOT NULL
   AND :now_ms - g.stage_entered_at_ms > p.tolerance_ms
`;

/** Every column of every row, read positionally -- the source's `fetchall()`. */
function rowsRaw(cp: SqliteDatabase, sql: string, params?: Record<string, unknown>): unknown[][] {
  if (params === undefined) {
    return cp.prepare(sql).raw().all() as unknown[][];
  }
  return cp.prepare<Record<string, unknown>>(sql).raw().all(params) as unknown[][];
}

/** The first row, read positionally -- the source's `fetchone()`. */
function rowRaw(cp: SqliteDatabase, sql: string, params: unknown[] = []): unknown[] | undefined {
  return cp
    .prepare(sql)
    .raw()
    .get(...params) as unknown[] | undefined;
}

/** `SELECT count(*) ...` -- an aggregate, so it is read positionally. */
function countOf(cp: SqliteDatabase, sql: string, params: unknown[] = []): number {
  return Number(
    cp
      .prepare(sql)
      .pluck()
      .get(...params),
  );
}

// --------------------------------------------------------------------------
// section 5 -- the outbox status lattice (0003_outbox_cancelled_status.sql)
// --------------------------------------------------------------------------

describe("section 5 -- the outbox status lattice (0003_outbox_cancelled_status.sql)", () => {
  test("a pending or delivered message may be cancelled and a cancelled one is terminal", () => {
    const cp = cpFixture();
    // Section 5's widened vocabulary: 'cancelled' is what a message nobody
    // wants sent any more moves to, and it is TERMINAL -- with no edge out, a
    // retired message cannot be resurrected into the delivery path by any
    // later writer.
    addOutbox(cp, "msg-pending", "dk-p");
    addOutbox(cp, "msg-delivered", "dk-d", T0, {
      status: "delivered",
      delivered_at_ms: T0 + 1,
    });

    cp.exec("UPDATE outbox SET status = 'cancelled' WHERE message_id = 'msg-pending'");
    cp.exec("UPDATE outbox SET status = 'cancelled' WHERE message_id = 'msg-delivered'");

    for (const target of ["pending", "delivered", "acked"]) {
      expectSqliteError(
        () => {
          cp.prepare<[string]>("UPDATE outbox SET status = ? WHERE message_id = 'msg-pending'").run(
            target,
          );
        },
        { code: CONSTRAINT, message: /terminal/ },
      );
    }
  });

  test("cancelling a delivered message does not erase that it was delivered", () => {
    const cp = cpFixture();
    // The evidence argument the forward-only trigger was written for survives
    // the lattice: cancellation is a status change, never an erasure.
    addOutbox(cp, "msg-1", "dk-1", T0, {
      status: "delivered",
      delivered_at_ms: T0 + 1,
      retry_count: 3,
    });

    cp.exec("UPDATE outbox SET status = 'cancelled' WHERE message_id = 'msg-1'");
    expect(
      rowRaw(
        cp,
        "SELECT status, delivered_at_ms, retry_count FROM outbox WHERE message_id = 'msg-1'",
      ),
    ).toEqual(["cancelled", T0 + 1, 3]);

    expectSqliteError(
      () => {
        cp.exec("UPDATE outbox SET delivered_at_ms = NULL WHERE message_id = 'msg-1'");
      },
      { code: CONSTRAINT, message: /delivered once/ },
    );
    expectSqliteError(
      () => {
        cp.exec("UPDATE outbox SET retry_count = 0 WHERE message_id = 'msg-1'");
      },
      { code: CONSTRAINT, message: /retry_count/ },
    );
  });

  test("an acked message is never cancelled", () => {
    const cp = cpFixture();
    // The answer arrived; the row that carries it is what the section 9.5 stage
    // advance is justified by, so there is no edge from 'acked' to anywhere --
    // and a cancelled row cannot carry an ack in the first place.
    addOutbox(cp, "msg-1", "dk-1", T0, {
      status: "acked",
      delivered_at_ms: T0 + 1,
      acked_at_ms: T0 + 2,
    });

    expectSqliteError(
      () => {
        cp.exec("UPDATE outbox SET status = 'cancelled' WHERE message_id = 'msg-1'");
      },
      { code: CONSTRAINT, message: /terminal/ },
    );
    expectSqliteError(
      () => {
        addOutbox(cp, "msg-2", "dk-2", T0, {
          status: "cancelled",
          delivered_at_ms: T0 + 1,
          acked_at_ms: T0 + 2,
        });
      },
      { code: CONSTRAINT, message: /acked_at_ms/ },
    );
  });

  test("a message never marked delivered cannot jump straight to acked", () => {
    const cp = cpFixture();
    // An ack for a message that was never recorded as sent is either a lost
    // 'delivered' write or an ack for something that was never sent; both are
    // faults, and the lattice has no pending -> acked edge for either to hide
    // behind.
    addOutbox(cp, "msg-1");

    expectSqliteError(
      () => {
        cp.prepare<[number, number]>(
          "UPDATE outbox SET status = 'acked', delivered_at_ms = ?, acked_at_ms = ?" +
            " WHERE message_id = 'msg-1'",
        ).run(T0 + 1, T0 + 2);
      },
      { code: CONSTRAINT, message: /terminal/ },
    );
  });

  test("the undelivered index stops matching a cancelled row", () => {
    const cp = cpFixture();
    // If the partial index kept matching cancelled rows, every pass that reads
    // it -- events.orphaned_outbox, gates.stalled_relays -- would go on aging a
    // retired message forever, which is the whole defect 0003 closes.
    addOutbox(cp, "msg-1");
    const live = "SELECT message_id FROM outbox WHERE status IN ('pending', 'delivered')";

    expect(cp.prepare(live).pluck().all()).toEqual(["msg-1"]);
    cp.exec("UPDATE outbox SET status = 'cancelled' WHERE message_id = 'msg-1'");
    expect(cp.prepare(live).pluck().all()).toEqual([]);

    const indexSql = cp
      .prepare<[], string>("SELECT sql FROM sqlite_schema WHERE name = 'outbox_undelivered'")
      .pluck()
      .get();
    expect(String(indexSql)).toContain("status IN ('pending', 'delivered')");

    // And the predicate has to be spelled as the index spells it: SQLite may use
    // a partial index only when the query's WHERE carries the index's own
    // predicate as a term, so the complement returns the same rows and loses the
    // index -- a full scan of every message ever enqueued, none of which are
    // ever deleted.
    const plan = (where: string): string =>
      rowsRaw(
        cp,
        `EXPLAIN QUERY PLAN SELECT message_id FROM outbox WHERE ${where} AND enqueued_at_ms < 1`,
      )
        .map((row) => String(row))
        .join(" ");

    expect(plan("status IN ('pending', 'delivered')")).toContain("SEARCH");
    expect(plan("status IN ('pending', 'delivered')")).toContain("outbox_undelivered");
    expect(plan("status <> 'acked'")).toContain("SCAN");
  });
});

// --------------------------------------------------------------------------
// section 5 -- the event spine
// --------------------------------------------------------------------------

describe("section 5 -- the event spine", () => {
  test("a repolled fact does not append twice", () => {
    const cp = cpFixture();
    // Section 5.2: a producer that re-polls, restarts mid-append or re-fetches
    // the same page collides on dedup_key. This is what lets several producers
    // share one spine with no single-writer lease over the table.
    addEvent(cp, "evt-1", T0, { dedup_key: "github/check_suite/99/completed" });
    expectSqliteError(
      () => {
        addEvent(cp, "evt-2", T0, { dedup_key: "github/check_suite/99/completed" });
      },
      // `event.dedup_key`, with the dot UNESCAPED, because the source's
      // `match="event.dedup_key"` is a regex whose `.` matches any character.
      // Escaping it here would assert something narrower than the source does.
      { code: CONSTRAINT, message: /event.dedup_key/ },
    );

    expect(countOf(cp, "SELECT count(*) FROM event")).toBe(1);
  });

  test("the spine is append only", () => {
    const cp = cpFixture();
    const seq = addEvent(cp);

    expectSqliteError(
      () => {
        cp.prepare<[number]>("UPDATE event SET payload = '{\"a\":1}' WHERE seq = ?").run(seq);
      },
      { code: CONSTRAINT, message: /append-only/ },
    );
    expectSqliteError(
      () => {
        cp.prepare<[number]>("DELETE FROM event WHERE seq = ?").run(seq);
      },
      { code: CONSTRAINT, message: /never deleted|replayed from/ },
    );

    expect(rowRaw(cp, "SELECT payload FROM event WHERE seq = ?", [seq])).toEqual(["{}"]);
  });

  test("a delivery subscription needs a recipient and a compute one must not have it", () => {
    const cp = cpFixture();
    // Section 5.3: the kind and the recipient are two halves of one fact, and a
    // delivery consumer with nowhere to deliver is a fan-out that silently drops.
    addConsumer(cp, "cons-delivery", "delivery");
    addConsumer(cp, "cons-compute", "compute");

    expectSqliteError(
      () => {
        addSubscription(cp, "cons-delivery", "ci.check_suite.completed", null);
      },
      { code: CONSTRAINT, message: /delivery subscription/ },
    );
    expectSqliteError(
      () => {
        addSubscription(cp, "cons-compute", "ci.check_suite.completed", "secretary");
      },
      { code: CONSTRAINT, message: /compute subscription/ },
    );

    addSubscription(cp, "cons-delivery", "ci.check_suite.completed", "secretary");
    addSubscription(cp, "cons-compute", "ci.check_suite.completed", null);
    expect(countOf(cp, "SELECT count(*) FROM consumer_subscription")).toBe(2);
  });

  test("no committed event seq is ever observed out of commit order", () => {
    // Section 5.2 / `D-0030`: the property a consumer cursor rests on.
    //
    // A cursor over `seq` is sound only if a committed gap can never be filled
    // in later -- a consumer that advanced past `N` would otherwise never see a
    // row arriving at `N-1`. SQLite serialises write transactions, so `seq` is
    // assigned in commit order. This test is the thing that fails if this
    // database is ever put behind something that admits concurrent writers.
    const dbPath = productionDb();
    cpFixture(dbPath);

    const writerA = secondConnection(dbPath);
    const writerB = secondConnection(dbPath);
    const reader = secondConnection(dbPath);

    writerA.exec("BEGIN IMMEDIATE");
    const seqA = addEvent(writerA, "evt-a", T0);

    // The interleave the design's soundness argument depends on being
    // impossible: while A holds the write transaction, B cannot start one,
    // so B cannot be assigned a seq that commits before A's.
    expectSqliteError(
      () => {
        writerB.exec("BEGIN IMMEDIATE");
      },
      { code: CONTENTION, message: /locked|busy/ },
    );

    // Nothing A wrote is visible anywhere else until it commits.
    expect(countOf(reader, "SELECT count(*) FROM event")).toBe(0);
    writerA.exec("COMMIT");
    expect(rowsRaw(reader, "SELECT seq FROM event ORDER BY seq")).toEqual([[seqA]]);

    writerB.exec("BEGIN IMMEDIATE");
    const seqB = addEvent(writerB, "evt-b", T0 + 1);
    // B's row is later in commit order and it is later in seq order; and it
    // is still invisible, so no reader can observe B before A.
    expect(seqB).toBeGreaterThan(seqA);
    expect(rowsRaw(reader, "SELECT seq FROM event ORDER BY seq")).toEqual([[seqA]]);
    writerB.exec("COMMIT");

    const observed = reader
      .prepare<[], number>("SELECT seq FROM event ORDER BY rowid")
      .pluck()
      .all();
    expect(observed).toEqual([...observed].sort((left, right) => left - right));
    expect(observed).toEqual([seqA, seqB]);
  });

  test("an append whose fanout fails leaves no event behind", () => {
    // Section 5.4: the append is one transaction, or it is nothing.
    //
    // An event on the spine with no delivery record is exactly v1's
    // push-vs-poll duplication -- the window in which a fact exists and nobody
    // is obliged to deliver it. The fan-out below dies on its second
    // consumption row (an unregistered consumer), and the property asserted is
    // that the *event* goes with it.
    const cp = cpFixture();
    addConsumer(cp, "cons-1", "compute");

    cp.exec("BEGIN");
    const doomed = addEvent(cp, "evt-1", T0, { dedup_key: "fact/1" });
    addConsumption(cp, "cons-1", doomed);
    expectSqliteError(
      () => {
        addConsumption(cp, "cons-never-registered", doomed);
      },
      { code: CONSTRAINT },
    );
    cp.exec("ROLLBACK");

    expect(countOf(cp, "SELECT count(*) FROM event")).toBe(0);
    expect(countOf(cp, "SELECT count(*) FROM event_consumption")).toBe(0);

    // And the whole append, done in one transaction, lands as one unit: the
    // event, the per-consumer consumption row, the outbox row for the delivery
    // consumer, and the typed side table row keyed by the event's seq.
    addRepository(cp);
    addConsumer(cp, "cons-relay", "delivery");
    cp.exec("BEGIN");
    const seq = addEvent(cp, "evt-1", T0, {
      dedup_key: "fact/1",
      subject_kind: "pull_request",
      subject_id: "pr-1",
    });
    addConsumption(cp, "cons-1", seq);
    addOutbox(cp, "msg-1", "event/evt-1/cons-relay");
    addConsumption(cp, "cons-relay", seq, T0, { message_id: "msg-1" });
    addCiObservation(cp, "obs-1", seq);
    cp.exec("COMMIT");

    expect(countOf(cp, "SELECT count(*) FROM event_consumption WHERE event_seq = ?", [seq])).toBe(
      2,
    );
    expect(
      rowRaw(cp, "SELECT message_id FROM event_consumption WHERE consumer_id = 'cons-relay'"),
    ).toEqual(["msg-1"]);
    expect(rowRaw(cp, "SELECT event_seq FROM ci_observation")).toEqual([seq]);
  });
});

// --------------------------------------------------------------------------
// section 6 -- CI observation identity, ordering and the verdict projection
// --------------------------------------------------------------------------

describe("section 6 -- CI observation identity, ordering and the verdict projection", () => {
  test("a repeated ci observation identity is refused", () => {
    const cp = cpFixture();
    addRepository(cp);
    addCiObservation(cp, "obs-1");
    expectSqliteError(
      () => {
        addCiObservation(cp, "obs-2");
      },
      { code: CONSTRAINT, message: /ci_observation/ },
    );

    // A re-run is a different attempt, and a different attempt is a different
    // fact rather than a duplicate of the same one.
    addCiObservation(cp, "obs-3", null, T0, { attempt: 2 });
    expect(countOf(cp, "SELECT count(*) FROM ci_observation")).toBe(2);
  });

  test("a provider outside the closed set is refused on an observation", () => {
    const cp = cpFixture();
    // D-0033: provider is CHECKed to 'github' alone, and a second provider
    // widens the CHECK in a migration step that brings its substitution test.
    // ci_observation is held to the same narrowing as repository.
    addRepository(cp);
    const spellings = ["GITHUB", "github.com", "gitlab", " github"];
    for (const [index, spelling] of spellings.entries()) {
      expectSqliteError(
        () => {
          addCiObservation(cp, `obs-bad-${index}`, null, T0, { provider: spelling });
        },
        { code: CONSTRAINT, message: /provider/ },
      );
    }
    addCiObservation(cp, "obs-1", null, T0, { provider: "github" });
  });

  test("a provider spelling variant cannot reproject a red pull request green", () => {
    const cp = cpFixture();
    // The cost of a merely non-empty provider, demonstrated. provider is part of
    // ci_observation_identity, so a spelling variant is admitted as a second row
    // for the SAME fact; the ci_current_verdict per-scope subquery does not
    // discriminate on provider, so the later-timestamped bogus row would win on
    // occurred_at_ms and the red PR would project green -- the section 6.1
    // verdict-honesty failure. The narrowed CHECK is what makes the second
    // insert impossible.
    addRepository(cp);
    addPullRequest(cp);
    addCiObservation(cp, "obs-red", null, T0, { verdict: "failed" });
    expectSqliteError(
      () => {
        addCiObservation(cp, "obs-green", null, T0 + 1_000, {
          provider: "GITHUB",
          verdict: "passed",
        });
      },
      { code: CONSTRAINT, message: /provider/ },
    );

    expect(rowsRaw(cp, "SELECT verdict FROM ci_current_verdict")).toEqual([["failed"]]);
  });

  test("a verdict outside the closed set is refused", () => {
    const cp = cpFixture();
    addRepository(cp);
    expectSqliteError(
      () => {
        addCiObservation(cp, "obs-1", null, T0, { verdict: "probably_fine" });
      },
      { code: CONSTRAINT, message: /verdict/ },
    );

    const verdicts = ["passed", "failed", "cancelled", "timed_out", "no_run", "indeterminate"];
    for (const [index, verdict] of verdicts.entries()) {
      addCiObservation(cp, `obs-v${index}`, null, T0, { verdict });
    }
  });

  test("an indeterminate observation is superseded by the recovered verdict", () => {
    const cp = cpFixture();
    // Section 6.2: 'could not observe' is a verdict of its own, and the recovery
    // supersedes it without either row being rewritten. The repeat of the
    // recovered verdict is still the same fact and is still refused.
    addRepository(cp);
    addPullRequest(cp);
    addCiObservation(cp, "obs-1", null, T0, { verdict: "indeterminate" });
    addCiObservation(cp, "obs-2", null, T0 + 1_000, { verdict: "failed" });
    expectSqliteError(
      () => {
        addCiObservation(cp, "obs-3", null, T0 + 2_000, { verdict: "failed" });
      },
      { code: CONSTRAINT },
    );

    expect(rowsRaw(cp, "SELECT verdict FROM ci_current_verdict")).toEqual([["failed"]]);
  });

  test("a rollup drops out of the projection once a finegrained scope exists", () => {
    const cp = cpFixture();
    // Section 6.3 rule 3: the rollup is a fallback, not a peer. Two rows for one
    // head would otherwise let a reader pick whichever agreed with it.
    addRepository(cp);
    addPullRequest(cp);
    addCiObservation(cp, "obs-rollup", null, T0, {
      check_scope: "rollup",
      scope_id: "head",
      verdict: "passed",
    });
    expect(new Set(cp.prepare("SELECT check_scope FROM ci_current_verdict").pluck().all())).toEqual(
      new Set(["rollup"]),
    );

    addCiObservation(cp, "obs-suite", null, T0 + 1_000, {
      check_scope: "check_suite",
      scope_id: "suite-1",
      verdict: "failed",
    });
    expect(rowsRaw(cp, "SELECT check_scope, verdict FROM ci_current_verdict")).toEqual([
      ["check_suite", "failed"],
    ]);
  });
});

// --------------------------------------------------------------------------
// section 7 -- run to PR linkage
// --------------------------------------------------------------------------

describe("section 7 -- run to PR linkage", () => {
  test("a merged pull request does not reopen", () => {
    const cp = cpFixture();
    addRepository(cp);
    addPullRequest(cp);
    cp.prepare<[number, number, string, number]>(
      "UPDATE pull_request SET state = 'merged', merged_at_ms = ?, closed_at_ms = ?," +
        " merge_commit_sha = ?, updated_at_ms = ? WHERE pr_id = 'pr-1'",
    ).run(T0 + 10, T0 + 10, SHA_B, T0 + 10);
    expectSqliteError(
      () => {
        cp.exec("UPDATE pull_request SET state = 'open' WHERE pr_id = 'pr-1'");
      },
      { code: CONSTRAINT, message: /does not reopen/ },
    );
  });

  test("a closed unmerged pull request reopens and a merged one does not", () => {
    const cp = cpFixture();
    // The two cases the single 'is it closed' flag cannot tell apart: a close is
    // revocable and a merge is a fact.
    addRepository(cp);
    addPullRequest(cp, "pr-open", 1);
    cp.prepare<[number]>(
      "UPDATE pull_request SET state = 'closed', closed_at_ms = ? WHERE pr_id = 'pr-open'",
    ).run(T0 + 10);
    cp.exec("UPDATE pull_request SET state = 'open', closed_at_ms = NULL WHERE pr_id = 'pr-open'");
    expect(
      rowRaw(cp, "SELECT state, closed_at_ms FROM pull_request WHERE pr_id = 'pr-open'"),
    ).toEqual(["open", null]);

    addPullRequest(cp, "pr-merged", 2);
    cp.prepare<[number, number, string]>(
      "UPDATE pull_request SET state = 'merged', merged_at_ms = ?, closed_at_ms = ?," +
        " merge_commit_sha = ? WHERE pr_id = 'pr-merged'",
    ).run(T0 + 10, T0 + 10, SHA_B);
    expectSqliteError(
      () => {
        cp.exec(
          "UPDATE pull_request SET state = 'open', closed_at_ms = NULL," +
            " merged_at_ms = NULL, merge_commit_sha = NULL WHERE pr_id = 'pr-merged'",
        );
      },
      { code: CONSTRAINT, message: /does not reopen/ },
    );
  });

  test("a late older head observation cannot revive superseded ci evidence", () => {
    const cp = cpFixture();
    // Section 7.2: the head is a projection of the provider's own order, so a
    // slow poller returning with yesterday's head must be refused rather than
    // rewinding the head every CI verdict is keyed by.
    addRepository(cp);
    const first = addEvent(cp, "evt-head-1", T0);
    addPullRequest(cp, "pr-1", 7, SHA_A, first, T0);
    const later = addEvent(cp, "evt-head-2", T0 + 1_000);

    cp.prepare<[string, number, number]>(
      "UPDATE pull_request SET head_sha = ?, head_observed_at_ms = ?, head_event_seq = ?" +
        " WHERE pr_id = 'pr-1'",
    ).run(SHA_B, T0 + 1_000, later);
    expectSqliteError(
      () => {
        cp.prepare<[string, number, number]>(
          "UPDATE pull_request SET head_sha = ?, head_observed_at_ms = ?, head_event_seq = ?" +
            " WHERE pr_id = 'pr-1'",
        ).run(SHA_A, T0, first);
      },
      { code: CONSTRAINT, message: /only moves forward/ },
    );

    expect(rowRaw(cp, "SELECT head_sha FROM pull_request")).toEqual([SHA_B]);
  });

  test("a second live primary pr per run is refused and a repoint keeps both links", () => {
    const cp = cpFixture();
    // Section 7.3: one live primary, unbounded history. The unlink is what makes
    // a re-point expressible without deleting the evidence of the first link.
    addRun(cp);
    addRepository(cp);
    addPullRequest(cp, "pr-1", 1);
    addPullRequest(cp, "pr-2", 2);
    addRunPrLink(cp, "run-1", "pr-1");

    expectSqliteError(
      () => {
        addRunPrLink(cp, "run-1", "pr-2");
      },
      { code: CONSTRAINT, message: /run_pr_link\.run_id/ },
    );

    cp.prepare<[number, string]>(
      "UPDATE run_pr_link SET unlinked_at_ms = ?, unlink_reason = ? WHERE pr_id = 'pr-1'",
    ).run(T0 + 10, "re-pointed at the reopened PR");
    addRunPrLink(cp, "run-1", "pr-2", "primary", "project_registry", T0 + 11);

    expect(
      rowsRaw(cp, "SELECT pr_id, unlinked_at_ms IS NULL FROM run_pr_link ORDER BY pr_id"),
    ).toEqual([
      ["pr-1", 0],
      ["pr-2", 1],
    ]);
  });

  test("a link resolution cannot say we guessed from the working directory", () => {
    const cp = cpFixture();
    // Section 7.4: how the link was resolved is evidence. A guess recorded as a
    // resolution is a link nobody can later audit.
    addRun(cp);
    addRepository(cp);
    addPullRequest(cp);
    expectSqliteError(
      () => {
        addRunPrLink(cp, "run-1", "pr-1", "primary", "working_directory_guess");
      },
      { code: CONSTRAINT, message: /resolution/ },
    );

    const resolutions = ["project_registry", "explicit_operator", "provider_event"];
    for (const [index, resolution] of resolutions.entries()) {
      addPullRequest(cp, `pr-r${index}`, 10 + index);
      addRunPrLink(cp, "run-1", `pr-r${index}`, "supporting", resolution);
    }
  });
});

// --------------------------------------------------------------------------
// section 8 -- watcher liveness
// --------------------------------------------------------------------------

describe("section 8 -- watcher liveness", () => {
  test("a stale watchers heartbeat is refused by the fence", () => {
    const cp = cpFixture();
    addRepository(cp);
    const scope = addWatcherScope(cp);
    addLease(cp, `watcher_scope:${scope}`, "watcher-a", 7);

    expect(heartbeat(cp, scope, { epoch: 7, nowMs: T0 + 1 })).toBe(1);
    // The replaced watcher returning with its old token matches neither arm.
    expect(heartbeat(cp, scope, { epoch: 3, nowMs: T0 + 2 })).toBe(0);
    expect(rowRaw(cp, "SELECT holder_epoch, last_attempt_at_ms FROM watcher_liveness")).toEqual([
      7,
      T0 + 1,
    ]);
  });

  test("a watcher bootstraps and then keeps both success and error history", () => {
    const cp = cpFixture();
    // Section 8.3: the insert arm exists so that the first heartbeat of a scope
    // is not indistinguishable from a stale-writer refusal, and the two history
    // columns are implications rather than biconditionals so that a recovery and
    // a failure are both writable.
    addRepository(cp);
    const scope = addWatcherScope(cp);
    addLease(cp, `watcher_scope:${scope}`, "watcher-a", 1);

    expect(heartbeat(cp, scope, { nowMs: T0 + 1, result: "observed_change" })).toBe(1);
    expect(
      heartbeat(cp, scope, { nowMs: T0 + 2, result: "error", error: "403 from the provider" }),
    ).toBe(1);
    expect(heartbeat(cp, scope, { nowMs: T0 + 3, result: "observed_no_change" })).toBe(1);

    expect(
      rowRaw(
        cp,
        "SELECT last_result, last_success_at_ms, last_change_at_ms, last_error_at_ms," +
          " last_error, consecutive_errors, attempt_count FROM watcher_liveness",
      ),
    ).toEqual(["observed_no_change", T0 + 3, T0 + 1, T0 + 2, null, 0, 3]);
  });

  test("a roster entry must name a subject", () => {
    const cp = cpFixture();
    // The pr_id biconditional only binds the ci_pull_request kind, so a
    // 'ci_repository' row with repo_id and pr_id both NULL would be a roster
    // entry for nothing at all. No watcher has a subject to heartbeat for, so
    // the section 8.4 coverage query below would report it as uncovered forever
    // -- and a roster that permanently alarms is a roster nobody reads, which
    // defeats the one thing the roster exists to do.
    addRepository(cp);
    expectSqliteError(
      () => {
        addWatcherScope(cp, "scope-nowhere", T0, { repo_id: null });
      },
      { code: CONSTRAINT, message: /repo_id/ },
    );

    // The pull-request kind still needs its repository named too, so the
    // biconditional and this rule hold together rather than at each other's
    // expense.
    addPullRequest(cp);
    expectSqliteError(
      () => {
        addWatcherScope(cp, "scope-pr-nowhere", T0, {
          scope_kind: "ci_pull_request",
          repo_id: null,
          pr_id: "pr-1",
        });
      },
      { code: CONSTRAINT, message: /repo_id/ },
    );
    addWatcherScope(cp, "scope-pr", T0, { scope_kind: "ci_pull_request", pr_id: "pr-1" });

    // Nothing subjectless survived to sit in the coverage report.
    expect(rowsRaw(cp, COVERAGE_QUERY)).toEqual([["scope-pr"]]);
  });

  test("a watcher holding another scopes lease cannot heartbeat this one", () => {
    const cp = cpFixture();
    // The lease resource is derived from the scope inside the statement, so a
    // misrouted heartbeat cannot mark an unwatched scope healthy and silence its
    // watcher_silence predicate.
    addRepository(cp);
    addWatcherScope(cp, "scope-a");
    addWatcherScope(cp, "scope-b");
    addLease(cp, "watcher_scope:scope-b", "watcher-b", 1);

    expect(heartbeat(cp, "scope-b", { holder: "watcher-b", nowMs: T0 + 1 })).toBe(1);
    expect(heartbeat(cp, "scope-a", { holder: "watcher-b", nowMs: T0 + 1 })).toBe(0);

    expect(rowsRaw(cp, "SELECT scope_id FROM watcher_liveness")).toEqual([["scope-b"]]);
    expect(rowsRaw(cp, COVERAGE_QUERY)).toEqual([["scope-a"]]);
  });

  test("the silence query scales the policy multiple by the scopes own interval", () => {
    const cp = cpFixture();
    // Section 8.4: the threshold is stored as a multiple precisely so that one
    // scope's poll interval is not baked into a row every other scope reads.
    addRepository(cp);
    const scope = addWatcherScope(cp, "scope-1", T0, { expected_interval_ms: 60_000 });
    addLease(cp, `watcher_scope:${scope}`, "watcher-a", 1, T0, 10 ** 9);
    heartbeat(cp, scope, { nowMs: T0 });

    const multiple = rowRaw(
      cp,
      "SELECT threshold_value FROM policy_detection_latency" +
        " WHERE revision_id = ? AND incident_class = 'watcher_silence'",
      [seedRevisionId(cp)],
    );
    expect(multiple, "time-base-policy.md section 3.2: three missed polls").toEqual([3]);

    expect(rowsRaw(cp, SILENCE_QUERY, { now_ms: T0 + 120_000 })).toEqual([]);
    expect(rowsRaw(cp, SILENCE_QUERY, { now_ms: T0 + 198_000 })).toEqual([[scope, 198_000]]);
  });
});

// --------------------------------------------------------------------------
// section 9 -- the Gate entity
// --------------------------------------------------------------------------

describe("section 9 -- the Gate entity", () => {
  test("a gate cannot be created already claiming a projection", () => {
    const cp = cpFixture();
    // Section 9.2: the projection is set by the opening transition, which cannot
    // exist before the gate does. A gate born at 'presented', or born naming a
    // stage_seq, or born closed, is a claim with no history under it.
    expectSqliteError(
      () => {
        addGate(cp, "gate-presented", null, T0, { stage: "presented" });
      },
      { code: CONSTRAINT, message: /opens at stage received/ },
    );
    expectSqliteError(
      () => {
        addGate(cp, "gate-seq", null, T0, { stage_seq: 1 });
      },
      { code: CONSTRAINT, message: /opens at stage received/ },
    );
    expectSqliteError(
      () => {
        addGate(cp, "gate-closed", null, T0, { outcome: "withdrawn", closed_at_ms: T0 });
      },
      { code: CONSTRAINT, message: /opens at stage received/ },
    );

    expect(countOf(cp, "SELECT count(*) FROM gate")).toBe(0);
  });

  test("a gate can be opened end to end", () => {
    const cp = cpFixture();
    // Create with a null projection, append the opening transition, then point
    // the projection at it -- the only order the triggers admit.
    const gate = addGate(cp);
    const opened = addGateTransition(cp, gate, "open", null, "received");
    projectGateStage(cp, gate, "received", opened);

    expect(rowRaw(cp, "SELECT stage, stage_seq FROM gate")).toEqual(["received", opened]);

    // And the projection still cannot claim a stage no transition of this gate
    // reached.
    expectSqliteError(
      () => {
        projectGateStage(cp, gate, "answered", opened, T0 + 1);
      },
      { code: CONSTRAINT, message: /projection/ },
    );
  });

  test("gate stage may only name an open or advance transition of its own gate", () => {
    const cp = cpFixture();
    // Section 9.2, with one section 11 row corrected rather than reproduced.
    //
    // The section 11 table claims the trigger "fires when pointed at the `open`
    // transition". It does not, and it must not: the section 9.2 DDL admits
    // `transition_kind IN ('open', 'advance')`, and another section 11 row says
    // an end-to-end open -- whose only transition is the `open` one -- is
    // accepted. Both cannot be true. The DDL wins, because a gate whose opening
    // transition could not back its own projection could never reach a legal
    // state at all. **Document fix owed: that one row of section 11 is stale and
    // should read "fires when pointed at a resend, correction or close
    // transition, or at another gate's transition".**
    const gate = addGate(cp, "gate-1");
    const other = addGate(cp, "gate-2");
    const opened = addGateTransition(cp, gate, "open", null, "received");
    projectGateStage(cp, gate, "received", opened);

    const advance = addGateTransition(cp, gate, "advance", "received", "presented", T0 + 1);
    projectGateStage(cp, gate, "presented", advance, T0 + 1);
    expect(rowRaw(cp, "SELECT stage, stage_seq FROM gate WHERE gate_id = 'gate-1'")).toEqual([
      "presented",
      advance,
    ]);

    // What the trigger is actually for: a stage backed by a transition kind that
    // does not move the gate, and a stage backed by another gate's history.
    const resend = addGateTransition(cp, gate, "resend", "presented", "presented", T0 + 2);
    expectSqliteError(
      () => {
        projectGateStage(cp, gate, "presented", resend, T0 + 2);
      },
      { code: CONSTRAINT, message: /projection/ },
    );

    const foreign = addGateTransition(cp, other, "open", null, "received", T0 + 3);
    expectSqliteError(
      () => {
        projectGateStage(cp, gate, "received", foreign, T0 + 3);
      },
      { code: CONSTRAINT, message: /projection/ },
    );
  });

  test("a gate stage projection never walks backwards", () => {
    const cp = cpFixture();
    const gate = addGate(cp);
    const opened = addGateTransition(cp, gate, "open", null, "received");
    projectGateStage(cp, gate, "received", opened);
    const advance = addGateTransition(cp, gate, "advance", "received", "presented", T0 + 1);
    projectGateStage(cp, gate, "presented", advance, T0 + 1);

    expectSqliteError(
      () => {
        projectGateStage(cp, gate, "received", opened, T0 + 2);
      },
      { code: CONSTRAINT, message: /never walks backwards/ },
    );
    expectSqliteError(
      () => {
        cp.prepare<[string]>("UPDATE gate SET stage_seq = NULL WHERE gate_id = ?").run(gate);
      },
      { code: CONSTRAINT, message: /never walks backwards/ },
    );
  });

  test("gate transitions are immutable and undeletable", () => {
    const cp = cpFixture();
    const gate = addGate(cp);
    const seq = addGateTransition(cp, gate, "open", null, "received");

    expectSqliteError(
      () => {
        cp.prepare<[number]>("UPDATE gate_transition SET to_stage = 'answered' WHERE seq = ?").run(
          seq,
        );
      },
      { code: CONSTRAINT, message: /correction transition/ },
    );
    expectSqliteError(
      () => {
        cp.prepare<[number]>("DELETE FROM gate_transition WHERE seq = ?").run(seq);
      },
      { code: CONSTRAINT, message: /never deleted|relay-gap evidence/ },
    );
  });

  test("an outcome outside the terminal taxonomy is refused", () => {
    const cp = cpFixture();
    // Section 9.4: 'closed' is not an outcome. Every close names which of the
    // six ways it ended, because the taxonomy is what the measurement harness
    // counts against.
    const gate = addGate(cp);
    expectSqliteError(
      () => {
        cp.prepare<[number, string]>(
          "UPDATE gate SET outcome = 'done', closed_at_ms = ? WHERE gate_id = ?",
        ).run(T0 + 1, gate);
      },
      { code: CONSTRAINT, message: /outcome/ },
    );

    cp.prepare<[number, string]>(
      "UPDATE gate SET outcome = 'expired', closed_at_ms = ? WHERE gate_id = ?",
    ).run(T0 + 1, gate);
    expect(rowRaw(cp, "SELECT outcome FROM gate")).toEqual(["expired"]);
  });

  test("a closed gate keeps its outcome", () => {
    const cp = cpFixture();
    const gate = addGate(cp);
    cp.prepare<[number, string]>(
      "UPDATE gate SET outcome = 'withdrawn', closed_at_ms = ? WHERE gate_id = ?",
    ).run(T0 + 1, gate);

    expectSqliteError(
      () => {
        cp.prepare<[string]>("UPDATE gate SET outcome = 'expired' WHERE gate_id = ?").run(gate);
      },
      { code: CONSTRAINT, message: /keeps its outcome/ },
    );
    expectSqliteError(
      () => {
        cp.prepare<[string]>("UPDATE gate SET closed_at_ms = NULL WHERE gate_id = ?").run(gate);
      },
      { code: CONSTRAINT, message: /keeps its outcome/ },
    );
  });

  test("a second relay for the same gate stage is refused", () => {
    const cp = cpFixture();
    // Section 9.5: the enqueue is idempotent because the relay row is the
    // identity of 'this stage has been sent', not a log of sends.
    const gate = addGate(cp);
    addOutbox(cp, "msg-1", "gate/gate-1/presented");
    addOutbox(cp, "msg-2", "gate/gate-1/presented/again");
    cp.prepare<[string, number]>(
      "INSERT INTO gate_relay (gate_id, to_stage, message_id, enqueued_at_ms)" +
        " VALUES (?, 'presented', 'msg-1', ?)",
    ).run(gate, T0);

    expectSqliteError(
      () => {
        cp.prepare<[string, number]>(
          "INSERT INTO gate_relay (gate_id, to_stage, message_id, enqueued_at_ms)" +
            " VALUES (?, 'presented', 'msg-2', ?)",
        ).run(gate, T0 + 1);
      },
      { code: CONSTRAINT, message: /gate_relay/ },
    );
  });

  test("the relay gap detector emits one row per gate with two revisions on record", () => {
    const cp = cpFixture();
    // Section 9.6: policy rows are versioned and never updated in place, so a
    // join without a revision predicate would alarm once per tolerance ever
    // recorded -- some of them retired months ago.
    const gate = addGate(cp);
    const opened = addGateTransition(cp, gate, "open", null, "received");
    projectGateStage(cp, gate, "received", opened);

    const later = addPolicyRevision(cp, "a later tolerance for the same stage", T0);
    addStageTolerance(cp, later, "worker_escalation", "received", 240_000);

    const now = T0 + 300_000;
    const rows = rowsRaw(cp, RELAY_GAP_QUERY, { now_ms: now });
    expect(rows.length).toBe(1);
    expect(rows[0]?.[0]).toBe(gate);

    // And a gate inside the effective revision's tolerance emits nothing.
    expect(rowsRaw(cp, RELAY_GAP_QUERY, { now_ms: T0 + 200_000 })).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// section 10 -- policy data
// --------------------------------------------------------------------------

describe("section 10 -- policy data", () => {
  test("the detection budget check includes the reconcile period", () => {
    const cp = cpFixture();
    // time-base-policy.md section 3.1: T + P <= L is the whole derivation, and
    // making it a CHECK is what stops a tolerance being raised to the budget and
    // leaving the pass no room to notice the crossing.
    const revision = addPolicyRevision(cp, "budget arithmetic", T0);

    addDetectionLatency(cp, revision, "relay_gap", "absolute_ms", 180_000, 120_000, 300_000);
    expectSqliteError(
      () => {
        addDetectionLatency(cp, revision, "t_equals_l", "absolute_ms", 300_000, 120_000, 300_000);
      },
      { code: CONSTRAINT },
    );
    expectSqliteError(
      () => {
        addDetectionLatency(cp, revision, "over_budget", "absolute_ms", 240_000, 120_000, 300_000);
      },
      { code: CONSTRAINT },
    );
  });

  test("a relative threshold stores losslessly and an over budget absolute one does not", () => {
    const cp = cpFixture();
    // Section 10: three of the classes are not absolute durations, and
    // precomputing them into milliseconds would bake one subject's interval or
    // TTL into a row every other subject also reads.
    const revision = addPolicyRevision(cp, "the four kinds", T0);

    addDetectionLatency(
      cp,
      revision,
      "watcher_silence",
      "scope_interval_multiple",
      3,
      120_000,
      600_000,
    );
    addDetectionLatency(
      cp,
      revision,
      "watcher_error_streak",
      "consecutive_count",
      5,
      120_000,
      600_000,
    );
    addDetectionLatency(
      cp,
      revision,
      "lease_orphan",
      "lease_ttl_multiple",
      1,
      120_000,
      2,
      "lease_ttl_multiple",
    );
    addDetectionLatency(
      cp,
      revision,
      "ci_outcome_undrained",
      "absolute_ms",
      180_000,
      120_000,
      300_000,
    );
    expect(
      countOf(cp, "SELECT count(*) FROM policy_detection_latency WHERE revision_id = ?", [
        revision,
      ]),
    ).toBe(4);

    expectSqliteError(
      () => {
        addDetectionLatency(cp, revision, "over_budget", "absolute_ms", 600_000, 120_000, 300_000);
      },
      { code: CONSTRAINT },
    );
    expectSqliteError(
      () => {
        addDetectionLatency(cp, revision, "unknown_kind", "vibes", 1, 120_000, 300_000);
      },
      { code: CONSTRAINT, message: /threshold_kind/ },
    );
  });

  test("budget kind exempts a relative budget from the absolute arithmetic", () => {
    const cp = cpFixture();
    // The second adjudicated gap, pinned.
    //
    // `time-base-policy.md` section 3.2 gives `lease_orphan` a budget of
    // `2 x lease TTL`, which an absolute `budget_ms` column cannot hold: read
    // as milliseconds, `2` is smaller than any threshold and the `T + P <= L`
    // CHECK would refuse the row the policy table exists to carry. So the budget
    // carries its own kind, the CHECK applies only when *both* sides are
    // absolute, and a relative budget is asserted per subject by the reconcile
    // pass's `policy_budget_violation` instead -- where the subject's own TTL is
    // known.
    const revision = addPolicyRevision(cp, "relative budgets", T0);

    // 1 + 120000 > 2 by absolute arithmetic; the row is still legal, because 2
    // is a multiple of the lease TTL and not a duration.
    addDetectionLatency(
      cp,
      revision,
      "lease_orphan",
      "lease_ttl_multiple",
      1,
      120_000,
      2,
      "lease_ttl_multiple",
    );

    // The default keeps every row that says nothing absolute, so the CHECK is
    // not opted out of by omission.
    cp.prepare<[number]>(
      "INSERT INTO policy_detection_latency (revision_id, incident_class, threshold_kind," +
        " threshold_value, reconcile_period_ms, budget_ms) VALUES (?, 'defaulted'," +
        " 'absolute_ms', 180000, 120000, 300000)",
    ).run(revision);
    expect(
      rowRaw(
        cp,
        "SELECT budget_kind FROM policy_detection_latency" +
          " WHERE revision_id = ? AND incident_class = 'defaulted'",
        [revision],
      ),
    ).toEqual(["absolute_ms"]);
    expectSqliteError(
      () => {
        cp.prepare<[number]>(
          "INSERT INTO policy_detection_latency (revision_id, incident_class, threshold_kind," +
            " threshold_value, reconcile_period_ms, budget_ms) VALUES (?, 'defaulted_over'," +
            " 'absolute_ms', 240000, 120000, 300000)",
        ).run(revision);
      },
      { code: CONSTRAINT },
    );

    expectSqliteError(
      () => {
        addDetectionLatency(cp, revision, "unknown_budget", "absolute_ms", 1, 120_000, 2, "ttl");
      },
      { code: CONSTRAINT, message: /budget_kind/ },
    );
  });

  test("the seeded policy is the time base documents own numbers", () => {
    const cp = cpFixture();
    // 0002_policy_seed.sql is time-base-policy.md section 3.2 as data. If a
    // number moves in the document without the seed moving with it, the
    // detector runs on a tolerance nobody decided.
    const seeded = new Map<string, unknown[]>();
    for (const row of rowsRaw(
      cp,
      "SELECT incident_class, threshold_kind, threshold_value, reconcile_period_ms," +
        " budget_ms, budget_kind FROM policy_detection_latency WHERE revision_id = :revision_id",
      { revision_id: seedRevisionId(cp) },
    )) {
      seeded.set(String(row[0]), row.slice(1));
    }

    expect(seeded.get("relay_gap")).toEqual([
      "absolute_ms",
      180_000,
      120_000,
      300_000,
      "absolute_ms",
    ]);
    expect(seeded.get("ci_outcome_undrained")).toEqual([
      "absolute_ms",
      180_000,
      120_000,
      300_000,
      "absolute_ms",
    ]);
    expect(seeded.get("consumer_backlog")).toEqual([
      "absolute_ms",
      300_000,
      120_000,
      600_000,
      "absolute_ms",
    ]);
    expect(seeded.get("watcher_silence")).toEqual([
      "scope_interval_multiple",
      3,
      120_000,
      600_000,
      "absolute_ms",
    ]);
    expect(seeded.get("watcher_error_streak")).toEqual([
      "consecutive_count",
      5,
      120_000,
      600_000,
      "absolute_ms",
    ]);
    expect(seeded.get("lease_orphan")).toEqual([
      "lease_ttl_multiple",
      1,
      120_000,
      2,
      "lease_ttl_multiple",
    ]);
    // The reconcile period is one decision, not one per class.
    expect(new Set([...seeded.values()].map((values) => values[2]))).toEqual(new Set([120_000]));
  });
});

// --------------------------------------------------------------------------
// measurement-harness.md section 2.3 -- the AI invocation record
// --------------------------------------------------------------------------

describe("measurement-harness.md section 2.3 -- the AI invocation record", () => {
  test("an invocations output token ceiling scales with its response count", () => {
    const cp = cpFixture();
    // A multi-response invocation legitimately exceeds a single response's cap,
    // so the ceiling is per response and the CHECK multiplies. Asserting against
    // the flat cap would refuse every honest agentic loop.
    addAiInvocation(cp, "inv-many", T0, {
      output_tokens: 3_000,
      max_output_tokens: 1_024,
      model_response_count: 4,
    });
    expectSqliteError(
      () => {
        addAiInvocation(cp, "inv-one", T0, {
          output_tokens: 3_000,
          max_output_tokens: 1_024,
          model_response_count: 1,
        });
      },
      { code: CONSTRAINT },
    );
  });

  test("an invocation that reports usage must carry the tokens it reported", () => {
    const cp = cpFixture();
    // measurement-harness.md: 'unavailable' and 'zero' must stay distinguishable,
    // or every provider outage reads as a free invocation in the report.
    expectSqliteError(
      () => {
        addAiInvocation(cp, "inv-1", T0, { usage_status: "reported", output_tokens: null });
      },
      { code: CONSTRAINT },
    );
    addAiInvocation(cp, "inv-2", T0, { usage_status: "unavailable", output_tokens: null });
  });
});

// --------------------------------------------------------------------------
// section 3.1 -- the migration ledger
// --------------------------------------------------------------------------

describe("section 3.1 -- the migration ledger", () => {
  test("a migration record is written once and never deleted", () => {
    const cp = cpFixture();
    const applied = cp
      .prepare<[], number>("SELECT version FROM schema_migration ORDER BY version")
      .pluck()
      .all();
    expect(applied.length, "the fixture database is migrated to head").toBeGreaterThan(0);

    expectSqliteError(
      () => {
        cp.prepare<[string]>("UPDATE schema_migration SET checksum = ? WHERE version = 1").run(
          "0".repeat(64),
        );
      },
      { code: CONSTRAINT, message: /written once/ },
    );
    expectSqliteError(
      () => {
        cp.exec("DELETE FROM schema_migration WHERE version = 1");
      },
      { code: CONSTRAINT, message: /never deleted/ },
    );
  });
});

// --------------------------------------------------------------------------
// section 2 -- the two conventions, and the adjudicated run status
// --------------------------------------------------------------------------

describe("section 2 -- the two conventions, and the adjudicated run status", () => {
  test("run status is a closed set that only walks forward", () => {
    const cp = cpFixture();
    // The first adjudicated gap, pinned.
    //
    // Section 2 says the production `run` table "carries a CHECK on a closed
    // status set and a forward-only trigger" and never enumerates the set. The
    // set adopted here is `created -> running <-> suspended -> {completed,
    // failed, cancelled}`. Two properties are deliberate: `suspended` is **not**
    // terminal, because a suspend is resumable (`time-base-policy.md` section
    // 3.4 has a paused run suspend its session predicates by *status*, which
    // only works if the status can come back); and a terminal run is never
    // reopened, because every completion is a fact some report has already
    // counted.
    expectSqliteError(
      () => {
        addRun(cp, "run-bogus", "paused");
      },
      { code: CONSTRAINT },
    );

    const run = addRun(cp, "run-1", "created");
    for (const legal of ["running", "suspended", "running", "completed"]) {
      cp.prepare<[string, string]>("UPDATE run SET status = ? WHERE run_id = ?").run(legal, run);
    }
    expect(rowRaw(cp, "SELECT status FROM run")).toEqual(["completed"]);

    for (const reopen of ["created", "running", "suspended", "failed", "cancelled"]) {
      expectSqliteError(
        () => {
          cp.prepare<[string, string]>("UPDATE run SET status = ? WHERE run_id = ?").run(
            reopen,
            run,
          );
        },
        { code: CONSTRAINT, message: /never reopened/ },
      );
    }

    const rewound = addRun(cp, "run-2", "running");
    expectSqliteError(
      () => {
        cp.prepare<[string]>("UPDATE run SET status = 'created' WHERE run_id = ?").run(rewound);
      },
      { code: CONSTRAINT, message: /terminal/ },
    );

    // A suspend is not a terminal state: it resumes, and it may also end.
    cp.prepare<[string]>("UPDATE run SET status = 'suspended' WHERE run_id = ?").run(rewound);
    cp.prepare<[string]>("UPDATE run SET status = 'cancelled' WHERE run_id = ?").run(rewound);
  });

  test("no timestamp column in the production schema carries a default", () => {
    const cp = cpFixture();
    // Section 2: the clock is the caller's. ACCEPTANCE.md section 2 injects
    // clock skew across expiry boundaries, and a column defaulted to SQLite's
    // own clock makes that case untestable while handing a recovering process a
    // timestamp it never chose.
    const tables = cp
      .prepare<[], string>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .pluck()
      .all();
    for (const table of tables) {
      const columns = cp.pragma(`table_info(${table})`) as {
        name: string;
        dflt_value: unknown;
      }[];
      for (const { name: column, dflt_value: dflt } of columns) {
        if (column.endsWith("_at_ms") || column.endsWith("_at")) {
          expect(dflt, `${table}.${column} defaults to ${String(dflt)}`).toBeNull();
        }
      }
    }
  });
});

// --------------------------------------------------------------------------
// target-only -- the second connection carries the pragmas the source pins
// --------------------------------------------------------------------------

describe("target only", () => {
  /**
   * The source's `second_connection` pins two connection properties that
   * better-sqlite3's defaults do **not** satisfy: foreign keys are off by
   * default, and the busy timeout is 5,000 ms rather than zero. Neither is
   * observable from the commit-order case -- a five-second wait still ends in
   * `SQLITE_BUSY`, and nothing that case writes has a foreign key to violate --
   * so a helper that silently stopped applying them would leave that case green
   * while it no longer reproduced the source's configuration. This is the test
   * that goes red instead.
   */
  test("the second connection is configured the way the source configures it", () => {
    const dbPath = productionDb();
    cpFixture(dbPath);

    const connection = secondConnection(dbPath);
    expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(connection.pragma("busy_timeout", { simple: true })).toBe(0);
  });
});
