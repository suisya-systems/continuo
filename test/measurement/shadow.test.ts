/**
 * Four keys composed from real rows, five buckets that partition, and no miss without a verdict.
 *
 * Ported from interlock `tests/measurement/test_shadow.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping, and the cases that are
 * adapted rather than translated straight, are recorded in
 * `parity/measurement.shadow.ledger.json`.
 *
 * `shadow.ts` can be wrong in three ways that a cheerful test suite would never
 * notice, so each one gets adversarial treatment here:
 *
 * * **A key that does not compose from what the schema stores.** Every key test
 *   builds the rows through the production schema and the real writers
 *   (`repo_link`, `ci_ingest`, `gates.openGate`) and then asserts the key's
 *   components, so a key that quietly needed a column the schema has not got
 *   fails at insert time rather than passing against a hand-built dictionary.
 * * **A lowercasing that is a second source of truth.** A test that stored a
 *   lowercase slug would pass whether the fold happened in SQL, in JavaScript,
 *   or not at all. So the repository is stored as `Aa-Org/Renga` -- case
 *   preserved, as `0001_initial.sql` requires -- and the v1 adapter hands over
 *   the key spelled the way v1 spells it. If the fold is missing the episodes
 *   do not pair, and the test sees a fabricated `interlock_only` plus a
 *   fabricated candidate miss.
 * * **A `v1_only` episode that becomes a number without anyone deciding.**
 *   Section 3.3's rule has two halves and both are tested from the outside: the
 *   miss count *refuses* while a candidate is open, and the open candidate is
 *   still in the bucket, still counted, and still printed.
 *
 * The reconciliation tests are pure -- no connection, no clock -- because the
 * reconciliation is. Where a test needs a censored episode it goes through
 * `windows.classifyEpisodes` and `censoredEpisodeIds` rather than naming an id
 * by hand, so the integration between the two modules is exercised by the same
 * assertion that exercises the bucket.
 *
 * Nothing here re-implements the module to compare against; expected keys,
 * buckets and counts are written out by hand.
 */

import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { recordCiObservation } from "../../src/control_plane/ci_ingest.js";
import { openGate } from "../../src/control_plane/gates.js";
import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import { detectionLatency } from "../../src/control_plane/policy.js";
import { observePullRequest, upsertRepository } from "../../src/control_plane/repo_link.js";
import { isAscii } from "../../src/measurement/format.js";
import { openForMeasurement } from "../../src/measurement/reader.js";
import {
  ADJUDICATIONS,
  AdjudicationPending,
  AWAITING_HUMAN,
  BOTH,
  BOUNDED_ONSET_CAVEAT,
  CENSORED,
  CorrelationKey,
  censoredEpisodeIds,
  DuplicateCorrelationKey,
  DuplicateEpisodeIdRefused,
  EpisodeKeyRefused,
  FROM_FIXTURE_LABEL,
  INTERLOCK_ONLY,
  MISS,
  ONSET_BUCKET_MS,
  ONSET_OBSERVED,
  ONSET_UPPER_BOUND,
  POSITIONAL_KEY_CAVEAT,
  RECONCILIATION_BUCKETS,
  readCiOutcomeEpisodes,
  readInterlockEpisodes,
  readPrMergeEpisodes,
  readSessionLivenessEpisodes,
  readWorkerEscalationEpisodes,
  reconcile,
  renderShadowReconciliation,
  SHADOW_ABSENT,
  SHADOW_PRESENT,
  ShadowEpisode,
  type ShadowReconciliation,
  ShadowReferenceAbsent,
  ShadowRefusal,
  SUBJECT_CI_OUTCOME,
  SUBJECT_PR_MERGE,
  SUBJECT_SESSION_LIVENESS,
  SUBJECT_WORKER_ESCALATION,
  UNDETERMINED,
  UNMATCHED_KEY,
  UnknownAdjudication,
  UnknownSubjectClass,
  V1_FALSE_POSITIVE,
  V1_ONLY,
  V1Reference,
} from "../../src/measurement/shadow.js";
import { classifyEpisodes, Episode } from "../../src/measurement/windows.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const DAY_MS = 86_400_000;
const PERIOD_START = T0;
const PERIOD_END = T0 + DAY_MS;

/** `0002_policy_seed.sql`'s revision, found by note rather than assumed to be 1. */
const SEED_NOTE =
  "initial time base: detection latency budgets, gate stage tolerances " +
  "and gate stage owners as first decided";

/**
 * An absolute-`L` class, used where a test needs a window and not a policy
 * argument (`time-base-policy.md` section 3.2).
 */
const ABSOLUTE_CLASS = "session_no_evidence";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/**
 * The fact_state a session-liveness episode carries in these fixtures.
 * `incident.fact_state` is unconstrained text, so the reader is *told* which
 * states are the class -- which is exactly what the reader refuses to guess.
 */
const LIVENESS_STATE = "session_no_evidence";

// --------------------------------------------------------------------------
// helpers -- the world, built through the real writers
// --------------------------------------------------------------------------

/** The source's `db` fixture, as a per-test call (rule 8). */
function productionDb(): string {
  const path = join(caseRoot("shadow"), "production.sqlite3");
  createProductionControlPlane(path, { nowMs: T0 }).close();
  return path;
}

/**
 * An ordinary writable handle -- deliberately not the harness's.
 *
 * The harness's connection cannot write (`reader.ts`); fixtures are built
 * through a second connection rather than by relaxing that property.
 */
function withWritable<T>(path: string, body: (connection: SqliteDatabase) => T): T {
  const connection = new Database(path, { fileMustExist: true });
  try {
    return body(connection);
  } finally {
    connection.close();
  }
}

/** Read through the harness's read-only handle, and close it afterwards. */
function withMeasurement<T>(path: string, body: (connection: SqliteDatabase) => T): T {
  const connection = openForMeasurement(path);
  try {
    return body(connection);
  } finally {
    connection.close();
  }
}

function addRun(cp: SqliteDatabase, runId: string, at = T0): string {
  cp.prepare(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'running', ?, ?)",
  ).run(runId, at, at);
  return runId;
}

function addSession(cp: SqliteDatabase, sessionId: string, runId: string, at = T0): string {
  cp.prepare(
    `
        INSERT INTO session (session_id, run_id, provider, binding_phase,
                             observation, observation_reason, bound_at_ms)
        VALUES (?, ?, 'agent_view', 'spawned', 'unobserved', 'not read back yet', ?)
        `,
  ).run(sessionId, runId, at);
  return sessionId;
}

function addIncident(
  cp: SqliteDatabase,
  incidentId: string,
  fields: {
    readonly runId: string | null;
    readonly sessionId: string | null;
    readonly createdAtMs: number;
    readonly elapsedMs: number | null;
    readonly factState?: string;
  },
): string {
  cp.prepare(
    `
        INSERT INTO incident (incident_id, run_id, session_id, fact_state,
                              detector_version, dedup_key, elapsed_ms,
                              created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, 'd-1', ?, ?, ?, ?)
        `,
  ).run(
    incidentId,
    fields.runId,
    fields.sessionId,
    fields.factState ?? LIVENESS_STATE,
    `dk/${incidentId}`,
    fields.elapsedMs,
    fields.createdAtMs,
    fields.createdAtMs,
  );
  return incidentId;
}

function addOriginEvent(cp: SqliteDatabase, eventId: string, runId: string, at: number): number {
  const info = cp
    .prepare(
      `
        INSERT INTO event (event_id, event_type, subject_kind, subject_id, run_id,
                           producer, dedup_key, occurred_at_ms, ingested_at_ms)
        VALUES (?, 'worker_escalation_raised', 'run', ?, ?, 'worker', ?, ?, ?)
        `,
    )
    .run(eventId, runId, runId, `dk/${eventId}`, at, at);
  return Number(info.lastInsertRowid);
}

/** One `worker_escalation` gate at `received`, opened the real way. */
function addEscalation(
  cp: SqliteDatabase,
  gateId: string,
  fields: { readonly runId: string | null; readonly at: number },
): string {
  const seq = addOriginEvent(cp, `evt/${gateId}`, fields.runId ?? "run-orphan-origin", fields.at);
  openGate(cp, {
    gateId,
    gateType: "worker_escalation",
    subjectKind: "run",
    subjectId: fields.runId ?? "no-run",
    rationale: "the worker asked",
    originEventSeq: seq,
    createdAtMs: fields.at,
    actorKind: "worker",
    actorId: "worker-1",
    runId: fields.runId,
  });
  return gateId;
}

function addRepository(cp: SqliteDatabase, repoId: string, owner: string, name: string): string {
  return upsertRepository(cp, { repoId, owner, name, nowMs: T0 });
}

function addPullRequest(
  cp: SqliteDatabase,
  fields: {
    readonly repoId: string;
    readonly prNumber: number;
    readonly headSha: string;
    readonly state?: string;
    readonly observedAtMs?: number;
    readonly mergedAtMs?: number | null;
    readonly mergeCommitSha?: string | null;
    readonly closedAtMs?: number | null;
    readonly eventId?: string;
  },
): void {
  const observedAtMs = fields.observedAtMs ?? T0;
  observePullRequest(cp, {
    repoId: fields.repoId,
    prNumber: fields.prNumber,
    headSha: fields.headSha,
    state: fields.state ?? "open",
    observedAtMs,
    ingestedAtMs: observedAtMs,
    eventId: fields.eventId ?? "evt-pr",
    producer: "pr_watcher",
    mergedAtMs: fields.mergedAtMs ?? null,
    mergeCommitSha: fields.mergeCommitSha ?? null,
    closedAtMs: fields.closedAtMs ?? null,
  });
}

function addCiObservation(
  cp: SqliteDatabase,
  fields: {
    readonly observationId: string;
    readonly repoId: string;
    readonly prNumber: number;
    readonly headSha: string;
    readonly checkScope: string;
    readonly scopeId: string;
    readonly verdict: string;
    readonly occurredAtMs: number;
  },
): void {
  recordCiObservation(cp, {
    observationId: fields.observationId,
    repoId: fields.repoId,
    prNumber: fields.prNumber,
    headSha: fields.headSha,
    checkScope: fields.checkScope,
    scopeId: fields.scopeId,
    attempt: 1,
    verdict: fields.verdict,
    observer: "pr_watcher",
    observerEpoch: 1,
    occurredAtMs: fields.occurredAtMs,
    ingestedAtMs: fields.occurredAtMs,
  });
}

function seedRevisionId(path: string): number {
  return withWritable(path, (connection) => {
    const row = connection
      .prepare<[string], { revision_id: number }>(
        "SELECT revision_id FROM policy_revision WHERE note = ?",
      )
      .get(SEED_NOTE);
    if (row === undefined) {
      expect.fail("0002_policy_seed.sql must have applied");
    }
    return Number(row.revision_id);
  });
}

function anEpisode(
  episodeId: string,
  fields: {
    readonly subjectClass?: string;
    readonly parts?: readonly string[] | null;
    readonly shape?: string;
    readonly onsetMs?: number;
    readonly keyGap?: string | null;
  } = {},
): ShadowEpisode {
  const subjectClass = fields.subjectClass ?? SUBJECT_PR_MERGE;
  const parts = fields.parts === undefined ? ["github", "o/r", "1"] : fields.parts;
  const key = parts === null ? null : new CorrelationKey({ subjectClass, parts });
  return new ShadowEpisode({
    episodeId,
    subjectClass,
    shape: fields.shape ?? "merged",
    onsetMs: fields.onsetMs ?? T0,
    key,
    keyGap: fields.keyGap ?? null,
    evidence: [["note", "fixture"]],
  });
}

function reconciled(
  interlock: readonly ShadowEpisode[],
  v1: readonly ShadowEpisode[] | V1Reference,
  options: {
    readonly censoredIds?: Iterable<string>;
    readonly fixtureLabels?: ReadonlyMap<string, string>;
    readonly source?: string;
  } = {},
): ShadowReconciliation {
  const reference =
    v1 instanceof V1Reference
      ? v1
      : V1Reference.observed({ source: options.source ?? "v1-adapter", episodes: v1 });
  return reconcile({
    periodStartMs: PERIOD_START,
    periodEndMs: PERIOD_END,
    interlockEpisodes: interlock,
    v1Reference: reference,
    censoredIds: options.censoredIds ?? [],
    fixtureLabels: options.fixtureLabels ?? new Map(),
  });
}

/** A bucket-count map as a plain object, for whole-value comparison. */
function countsOf(report: ShadowReconciliation): Record<string, number> {
  return Object.fromEntries(report.counts());
}

// --------------------------------------------------------------------------
// the four correlation keys, composed from what the schema actually stores
// --------------------------------------------------------------------------

describe("the four correlation keys", () => {
  test("the ci_outcome key composes from ci_observation joined to repository", () => {
    // Provider, folded slug, PR number and head -- and the outcome is the
    // projection. The two scopes disagree on purpose. A reader that took the
    // newest observation would report `passed`; section 6.3 rule 5 says the
    // head's verdict is the most severe of its eligible scopes, and this reader
    // gets it by calling `prVerdict` rather than folding a second time.
    const path = productionDb();
    withWritable(path, (cp) => {
      const repoId = addRepository(cp, "repo-1", "Aa-Org", "Renga");
      addPullRequest(cp, { repoId, prNumber: 302, headSha: SHA_A });
      addCiObservation(cp, {
        observationId: "obs-1",
        repoId,
        prNumber: 302,
        headSha: SHA_A,
        checkScope: "check_suite",
        scopeId: "suite-1",
        verdict: "failed",
        occurredAtMs: T0 + MINUTE,
      });
      addCiObservation(cp, {
        observationId: "obs-2",
        repoId,
        prNumber: 302,
        headSha: SHA_A,
        checkScope: "workflow_run",
        scopeId: "wf-1",
        verdict: "passed",
        occurredAtMs: T0 + 2 * MINUTE,
      });
    });

    const episodes = withMeasurement(path, (connection) =>
      readCiOutcomeEpisodes(connection, {
        onsetFromMs: PERIOD_START,
        onsetToMs: PERIOD_END,
      }),
    );

    expect(episodes).toHaveLength(1);
    const episode = episodes[0] as ShadowEpisode;
    expect(episode.subjectClass).toBe(SUBJECT_CI_OUTCOME);
    expect(episode.key).not.toBeNull();
    expect(episode.key?.parts).toEqual(["github", "aa-org/renga", "302", SHA_A]);
    expect(episode.shape, "a green scope must not soften a red one").toBe("failed");
    expect(
      episode.onsetMs,
      "the onset is the provider's earliest eligible observation of this head, not our ingest of it",
    ).toBe(T0 + MINUTE);
    expect(episode.key?.positional).toBe(false);
  });

  test("a case-differing repo slug still matches the v1 spelling", () => {
    // The fold is real, and it is the database's own fold. `repository`
    // preserves `Aa-Org/Renga` in its columns (only `repository_by_slug`
    // folds), so a key built without folding would read `Aa-Org/Renga` and
    // never meet v1's `aa-org/renga`. The pairing is the assertion: unfolded,
    // this test sees one `interlock_only` and one candidate miss instead of one
    // `both`.
    const path = productionDb();
    withWritable(path, (cp) => {
      const repoId = addRepository(cp, "repo-1", "Aa-Org", "Renga");
      addPullRequest(cp, {
        repoId,
        prNumber: 302,
        headSha: SHA_A,
        state: "merged",
        mergedAtMs: T0 + MINUTE,
        mergeCommitSha: SHA_B,
        closedAtMs: T0 + MINUTE,
      });
    });

    const ours = withMeasurement(path, (connection) =>
      readPrMergeEpisodes(connection, { onsetFromMs: PERIOD_START, onsetToMs: PERIOD_END }),
    );

    const v1Episode = new ShadowEpisode({
      episodeId: "v1-merge-302",
      subjectClass: SUBJECT_PR_MERGE,
      shape: "merged",
      onsetMs: T0 + MINUTE,
      key: new CorrelationKey({
        subjectClass: SUBJECT_PR_MERGE,
        // v1 stored a pr_url and normalised it to a lowercase slug.
        parts: ["github", "aa-org/renga", "302"],
      }),
    });

    const report = reconciled(ours, [v1Episode]);
    expect(report.counts().get(BOTH)).toBe(1);
    expect(report.counts().get(INTERLOCK_ONLY)).toBe(0);
    expect(report.counts().get(V1_ONLY)).toBe(0);
  });

  test("the pr_merge key omits the head and onsets at the provider merge", () => {
    // Three components, not four, and the merge instant is the provider's.
    const path = productionDb();
    withWritable(path, (cp) => {
      const repoId = addRepository(cp, "repo-1", "owner", "repo");
      addPullRequest(cp, { repoId, prNumber: 7, headSha: SHA_A });
      addPullRequest(cp, {
        repoId,
        prNumber: 7,
        headSha: SHA_B,
        state: "merged",
        observedAtMs: T0 + 3 * MINUTE,
        mergedAtMs: T0 + 3 * MINUTE,
        mergeCommitSha: SHA_B,
        closedAtMs: T0 + 3 * MINUTE,
        eventId: "evt-pr-merged",
      });
    });

    const episodes = withMeasurement(path, (connection) =>
      readPrMergeEpisodes(connection, { onsetFromMs: PERIOD_START, onsetToMs: PERIOD_END }),
    );

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.key).not.toBeNull();
    expect(episodes[0]?.key?.parts).toEqual(["github", "owner/repo", "7"]);
    expect(episodes[0]?.onsetMs).toBe(T0 + 3 * MINUTE);
  });

  test("escalations are numbered over the run's whole history, not the window", () => {
    // The positional ordinal must not change when the report period changes.
    // Three escalations; the window admits only the last two. Numbering within
    // the window would call them 1 and 2 -- and a daily report would then pair
    // the run's third escalation with v1's first.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-1");
      addEscalation(cp, "gate-1", { runId: "run-1", at: T0 });
      addEscalation(cp, "gate-2", { runId: "run-1", at: T0 + MINUTE });
      addEscalation(cp, "gate-3", { runId: "run-1", at: T0 + 2 * MINUTE });
    });

    const episodes = withMeasurement(path, (connection) =>
      readWorkerEscalationEpisodes(connection, {
        onsetFromMs: T0 + MINUTE,
        onsetToMs: T0 + 3 * MINUTE,
      }),
    );

    expect(episodes.map((episode) => episode.episodeId)).toEqual([
      "escalation:gate-2",
      "escalation:gate-3",
    ]);
    expect(episodes.map((episode) => episode.key?.parts)).toEqual([
      ["run-1", "2"],
      ["run-1", "3"],
    ]);
    expect(episodes.every((episode) => episode.key?.positional === true)).toBe(true);
    expect(episodes.every((episode) => episode.positionalKey)).toBe(true);
  });

  test("an escalation without a run lands in unmatched_key rather than being dropped", () => {
    // A key component the row does not have is a bucket, not a disappearance.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-orphan-origin");
      addEscalation(cp, "gate-orphan", { runId: null, at: T0 });
    });

    const episodes = withMeasurement(path, (connection) =>
      readWorkerEscalationEpisodes(connection, {
        onsetFromMs: PERIOD_START,
        onsetToMs: PERIOD_END,
      }),
    );

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.key).toBeNull();
    expect(episodes[0]?.keyGap).toContain("run_id");

    const report = reconciled(episodes, [anEpisode("v1-1")]);
    expect(report.counts().get(UNMATCHED_KEY)).toBe(1);
    expect(report.filedEpisodeIds()).toContain(episodes[0]?.episodeId);
  });

  test("the session_liveness key buckets the onset and not the detection", () => {
    // Onset is `created_at_ms - elapsed_ms`, bucketed to 60 s. The two
    // incidents were *raised* five minutes apart and the condition began within
    // the same minute in both. Keying on `created_at_ms` would put them in
    // different buckets, which is the reconciliation disagreeing about identity
    // precisely because the two detectors have different latencies -- the
    // quantity AC-10 is trying to measure.
    const path = productionDb();
    const onset = T0 + 10 * MINUTE;
    withWritable(path, (cp) => {
      addRun(cp, "run-1");
      addIncident(cp, "inc-fast", {
        runId: "run-1",
        sessionId: null,
        createdAtMs: onset + MINUTE,
        elapsedMs: MINUTE,
      });
      addIncident(cp, "inc-slow", {
        runId: "run-1",
        sessionId: null,
        createdAtMs: onset + 6 * MINUTE + 30_000,
        elapsedMs: 6 * MINUTE + 30_000,
      });
    });

    const episodes = withMeasurement(path, (connection) =>
      readSessionLivenessEpisodes(connection, {
        onsetFromMs: PERIOD_START,
        onsetToMs: PERIOD_END,
        factStates: [LIVENESS_STATE],
      }),
    );

    expect(episodes).toHaveLength(2);
    expect(new Set(episodes.map((episode) => episode.onsetMs))).toEqual(new Set([onset]));
    expect(new Set(episodes.map((episode) => JSON.stringify(episode.key?.parts)))).toEqual(
      new Set([JSON.stringify(["run-1", String(Math.floor(onset / ONSET_BUCKET_MS))])]),
    );
  });

  test("session liveness recovers the run through the session binding", () => {
    // Section 3.3 says `incident` joined to `session`, and this is why.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-1");
      addSession(cp, "sess-1", "run-1");
      addIncident(cp, "inc-1", {
        runId: null,
        sessionId: "sess-1",
        createdAtMs: T0 + 2 * MINUTE,
        elapsedMs: MINUTE,
      });
    });

    const episodes = withMeasurement(path, (connection) =>
      readSessionLivenessEpisodes(connection, {
        onsetFromMs: PERIOD_START,
        onsetToMs: PERIOD_END,
        factStates: [LIVENESS_STATE],
      }),
    );

    expect(episodes[0]?.key?.parts[0]).toBe("run-1");
  });

  test("an incident with no elapsed_ms cannot state an onset and is unmatched", () => {
    // The nullable column is a key gap, not a licence to use the detection time.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-1");
      addIncident(cp, "inc-1", {
        runId: "run-1",
        sessionId: null,
        createdAtMs: T0 + 2 * MINUTE,
        elapsedMs: null,
      });
    });

    const episodes = withMeasurement(path, (connection) =>
      readSessionLivenessEpisodes(connection, {
        onsetFromMs: PERIOD_START,
        onsetToMs: PERIOD_END,
        factStates: [LIVENESS_STATE],
      }),
    );

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.key).toBeNull();
    expect(episodes[0]?.keyGap).toContain("elapsed_ms");

    const report = reconciled(episodes, [anEpisode("v1-1")]);
    expect(report.counts().get(UNMATCHED_KEY)).toBe(1);
  });

  test("the liveness reader refuses to guess which fact_states are the class", () => {
    // No silent default: the schema does not carry the closed set, so the
    // caller does.
    const path = productionDb();
    const refusal = withMeasurement(path, (connection) =>
      expectRefusal(
        () =>
          readSessionLivenessEpisodes(connection, {
            onsetFromMs: PERIOD_START,
            onsetToMs: PERIOD_END,
            factStates: [],
          }),
        ShadowRefusal,
      ),
    );
    expect(refusal.message).toContain("fact_state");
  });

  test("readInterlockEpisodes covers every subject class", () => {
    // One call, four classes -- a class read by nobody would be all candidate
    // miss.
    const path = productionDb();
    withWritable(path, (cp) => {
      const repoId = addRepository(cp, "repo-1", "owner", "repo");
      addPullRequest(cp, {
        repoId,
        prNumber: 7,
        headSha: SHA_A,
        state: "merged",
        mergedAtMs: T0 + MINUTE,
        mergeCommitSha: SHA_B,
        closedAtMs: T0 + MINUTE,
      });
      addCiObservation(cp, {
        observationId: "obs-1",
        repoId,
        prNumber: 7,
        headSha: SHA_A,
        checkScope: "check_suite",
        scopeId: "suite-1",
        verdict: "passed",
        occurredAtMs: T0 + MINUTE,
      });
      addRun(cp, "run-1");
      addEscalation(cp, "gate-1", { runId: "run-1", at: T0 + MINUTE });
      addIncident(cp, "inc-1", {
        runId: "run-1",
        sessionId: null,
        createdAtMs: T0 + 3 * MINUTE,
        elapsedMs: MINUTE,
      });
    });

    const episodes = withMeasurement(path, (connection) =>
      readInterlockEpisodes(connection, {
        onsetFromMs: PERIOD_START,
        onsetToMs: PERIOD_END,
        livenessFactStates: [LIVENESS_STATE],
      }),
    );

    expect(new Set(episodes.map((episode) => episode.subjectClass))).toEqual(
      new Set([
        SUBJECT_CI_OUTCOME,
        SUBJECT_PR_MERGE,
        SUBJECT_WORKER_ESCALATION,
        SUBJECT_SESSION_LIVENESS,
      ]),
    );
  });

  test("a selection window that is empty or inverted is refused", () => {
    const path = productionDb();
    withMeasurement(path, (connection) => {
      expectRefusal(
        () =>
          readPrMergeEpisodes(connection, {
            onsetFromMs: PERIOD_END,
            onsetToMs: PERIOD_START,
          }),
        ShadowRefusal,
      );
    });
  });
});

// --------------------------------------------------------------------------
// the no-shadow-reference state
// --------------------------------------------------------------------------

describe("the no-shadow-reference state", () => {
  test("an empty v1 input is the no-shadow-reference state, not all interlock_only", () => {
    // The whole point of the adapter, and the flattering answer it refuses.
    // Nine Interlock episodes and an adapter that returned nothing: reconciled
    // naively that is nine improvements and no miss anywhere -- a perfect
    // period produced by the *absence* of data. The report says instead that it
    // had no second observer, and every comparison accessor refuses.
    const ours = Array.from({ length: 9 }, (_unused, n) =>
      anEpisode(`ours-${n}`, { parts: ["github", "o/r", String(n)] }),
    );

    const report = reconciled(ours, V1Reference.observed({ source: "v1-adapter", episodes: [] }));

    expect(report.available).toBe(false);
    expect(report.shadowReference).toBe(SHADOW_ABSENT);
    expect(report.interlockEpisodeCount).toBe(9);
    expect(report.shadowAbsentReason).toContain("no episodes");
    for (const accessor of [
      () => report.counts(),
      () => report.filedEpisodeIds(),
      () => report.awaitingAdjudication(),
      () => report.adjudicationCounts(),
      () => report.confirmedMissCount(),
    ]) {
      expectRefusal(accessor, ShadowReferenceAbsent);
    }

    const rendered = renderShadowReconciliation(report);
    expect(rendered).toContain("ABSENT");
    expect(
      rendered,
      "a report with no reference must not print a bucket a reader could take for a comparison",
    ).not.toContain(INTERLOCK_ONLY);
  });

  test("an absent reference must say why, and the reason reaches the report", () => {
    const report = reconciled(
      [anEpisode("ours-1")],
      V1Reference.absent({ reason: "outside the shadow period" }),
    );
    expect(report.shadowReference).toBe(SHADOW_ABSENT);
    expect(renderShadowReconciliation(report)).toContain("outside the shadow period");
  });

  test("attesting empty is the explicit way to say v1 saw nothing", () => {
    // The real state exists and is reachable -- but only on purpose.
    const report = reconciled(
      [anEpisode("ours-1")],
      V1Reference.attestsEmpty({ source: "v1-adapter" }),
    );
    expect(report.shadowReference).toBe(SHADOW_PRESENT);
    expect(report.counts().get(INTERLOCK_ONLY)).toBe(1);
    expect(report.counts().get(V1_ONLY)).toBe(0);
  });
});

// --------------------------------------------------------------------------
// v1_only: neither counted nor discarded without a verdict
// --------------------------------------------------------------------------

describe("v1_only: neither counted nor discarded without a verdict", () => {
  test("a v1_only episode is never counted as a miss without a classification", () => {
    // Both halves of section 3.3's rule, from the outside. Not counted: the
    // only method that returns a miss number refuses, and names the episode.
    // Not discarded: the same episode is in the bucket, in the counts, in the
    // awaiting list, and in the rendered report.
    const candidate = anEpisode("v1-1", {
      shape: "relay_gap",
      parts: ["github", "o/r", "9"],
    });
    const report = reconciled([], [candidate]);

    expect(report.counts().get(V1_ONLY)).toBe(1);
    expect(report.v1Only.map((item) => item.episode.episodeId)).toEqual(["v1-1"]);
    expect(report.awaitingAdjudication().map((item) => item.episode.episodeId)).toEqual(["v1-1"]);
    expect(report.adjudicationCounts().get(AWAITING_HUMAN)).toBe(1);

    const refusal = expectRefusal(() => report.confirmedMissCount(), AdjudicationPending);
    expect(refusal.message).toContain("v1-1");

    const rendered = renderShadowReconciliation(report);
    expect(rendered).toContain("awaiting human adjudication");
    expect(rendered).toContain("v1-1");
    expect(rendered).not.toContain("confirmed misses");
  });

  test("a fixture label settles a candidate, and a false positive is not a miss", () => {
    // A label makes the count available; `v1_false_positive` keeps it at zero.
    // The second half matters more than the first: v1 raising something we did
    // not is a miss *or* v1's own false positive, and a harness that assumed
    // the former would report AC-10 failing every time v1 alarmed on nothing.
    const missed = anEpisode("v1-miss", {
      shape: "relay_gap",
      parts: ["github", "o/r", "1"],
    });
    const bogus = anEpisode("v1-bogus", { shape: "ghost", parts: ["github", "o/r", "2"] });
    const report = reconciled([], [missed, bogus], {
      fixtureLabels: new Map([
        ["relay_gap", MISS],
        ["ghost", V1_FALSE_POSITIVE],
      ]),
    });

    expect(report.awaitingAdjudication()).toEqual([]);
    expect(report.confirmedMissCount()).toBe(1);
    expect(Object.fromEntries(report.adjudicationCounts())).toEqual({
      [MISS]: 1,
      [V1_FALSE_POSITIVE]: 1,
      [UNDETERMINED]: 0,
      [AWAITING_HUMAN]: 0,
    });
    expect(report.v1Only.map((item) => item.adjudicationSource)).toEqual([
      FROM_FIXTURE_LABEL,
      FROM_FIXTURE_LABEL,
    ]);
    expect(renderShadowReconciliation(report)).toContain("confirmed misses: 1");
  });

  test("undetermined is a settled answer and is not a miss", () => {
    // `D-0006`'s "cannot determine is a legitimate outcome", applied to the
    // report.
    const report = reconciled([], [anEpisode("v1-1", { shape: "murky" })], {
      fixtureLabels: new Map([["murky", UNDETERMINED]]),
    });
    expect(report.awaitingAdjudication()).toEqual([]);
    expect(report.confirmedMissCount()).toBe(0);
    expect(report.adjudicationCounts().get(UNDETERMINED)).toBe(1);
  });

  test("a fixture label outside the vocabulary is refused", () => {
    expectRefusal(
      () =>
        reconciled([], [anEpisode("v1-1")], {
          fixtureLabels: new Map([["merged", "probably"]]),
        }),
      UnknownAdjudication,
    );
  });
});

// --------------------------------------------------------------------------
// the partition, and censoring's precedence
// --------------------------------------------------------------------------

describe("the partition, and censoring's precedence", () => {
  test("the five buckets partition the input with no double counting", () => {
    // Every episode from both sides is filed exactly once. One episode of each
    // kind, plus both halves of a matched pair, plus a censored one from each
    // side. The assertion is a multiset equality: an episode dropped,
    // duplicated, or filed twice fails it, and no bucket-by-bucket count could.
    const pairedOurs = anEpisode("ours-paired", { parts: ["github", "o/r", "1"] });
    const pairedV1 = anEpisode("v1-paired", { parts: ["github", "o/r", "1"] });
    const oursOnly = anEpisode("ours-only", { parts: ["github", "o/r", "2"] });
    const v1OnlyEpisode = anEpisode("v1-only", { parts: ["github", "o/r", "3"] });
    const keylessOurs = anEpisode("ours-keyless", { parts: null, keyGap: "no pr_number" });
    const keylessV1 = anEpisode("v1-keyless", { parts: null, keyGap: "no pr_number" });
    const censoredOurs = anEpisode("ours-censored", { parts: ["github", "o/r", "4"] });
    const censoredV1 = anEpisode("v1-censored", { parts: ["github", "o/r", "5"] });

    const ours = [pairedOurs, oursOnly, keylessOurs, censoredOurs];
    const theirs = [pairedV1, v1OnlyEpisode, keylessV1, censoredV1];

    const report = reconciled(ours, theirs, {
      censoredIds: new Set(["ours-censored", "v1-censored"]),
    });

    expect(countsOf(report)).toEqual({
      [BOTH]: 1,
      [INTERLOCK_ONLY]: 1,
      [V1_ONLY]: 1,
      [UNMATCHED_KEY]: 2,
      [CENSORED]: 2,
    });
    const filed = report.filedEpisodeIds();
    expect(new Set(filed).size, "no episode may be filed twice").toBe(filed.length);
    expect([...filed].sort(), "no episode may go missing").toEqual(
      [...ours, ...theirs].map((episode) => episode.episodeId).sort(),
    );
  });

  test("a pair is censored when either half is, and no miss is fabricated", () => {
    // Matching happens before censoring, and this is the case that proves it.
    // The Interlock half is censored; its v1 counterpart is not. Censoring
    // first would drop our half, leave v1's unmatched, and report a *miss* --
    // fabricated out of a report boundary, which is exactly what section 3.5
    // exists to stop.
    const ours = anEpisode("ours-1", { parts: ["github", "o/r", "1"] });
    const theirs = anEpisode("v1-1", { parts: ["github", "o/r", "1"] });

    const report = reconciled([ours], [theirs], { censoredIds: new Set(["ours-1"]) });

    expect(countsOf(report)).toEqual({
      [BOTH]: 0,
      [INTERLOCK_ONLY]: 0,
      [V1_ONLY]: 0,
      [UNMATCHED_KEY]: 0,
      [CENSORED]: 2,
    });
    expect(report.censored.map((episode) => episode.episodeId).sort()).toEqual(["ours-1", "v1-1"]);
  });

  test("censored ids come from the windows module and not from here", () => {
    // The one adaptor, exercised end to end. The window's own boundary decides:
    // an episode whose `[onset, onset+L+grace)` ends one millisecond past the
    // period is censored, and the reconciliation files the v1 counterpart as
    // censored too rather than as a miss. Nothing in this test names a censored
    // id by hand.
    const path = productionDb();
    const revisionId = seedRevisionId(path);
    const graceMs = 0;
    const { windowReport, lateOnset } = withMeasurement(path, (connection) => {
      const budgetMs = Number(
        detectionLatency(connection, { revisionId, incidentClass: ABSOLUTE_CLASS }).budgetMs,
      );
      // One millisecond too late to be judged inside this period.
      const onset = PERIOD_END - budgetMs - graceMs + 1;
      return {
        lateOnset: onset,
        windowReport: classifyEpisodes(connection, {
          revisionId,
          periodStartMs: PERIOD_START,
          periodEndMs: PERIOD_END,
          graceMs,
          episodes: [new Episode("ours-late", ABSOLUTE_CLASS, onset)],
        }),
      };
    });

    expect(censoredEpisodeIds(windowReport)).toEqual(new Set(["ours-late"]));

    const report = reconciled(
      [anEpisode("ours-late", { parts: ["github", "o/r", "1"], onsetMs: lateOnset })],
      [anEpisode("v1-late", { parts: ["github", "o/r", "1"], onsetMs: lateOnset })],
      { censoredIds: censoredEpisodeIds(windowReport) },
    );
    expect(report.counts().get(CENSORED)).toBe(2);
    expect(report.counts().get(V1_ONLY)).toBe(0);
  });

  test("a keyless censored episode is censored and does not inflate the key bucket", () => {
    // Section 7 reads `unmatched_key` as a verdict on the KEY, not on the
    // period.
    const report = reconciled(
      [anEpisode("ours-1", { parts: null, keyGap: "no run_id" })],
      [anEpisode("v1-1")],
      { censoredIds: new Set(["ours-1"]) },
    );
    expect(report.counts().get(UNMATCHED_KEY)).toBe(0);
    expect(report.counts().get(CENSORED)).toBe(1);
  });
});

// --------------------------------------------------------------------------
// the positional key, said out loud
// --------------------------------------------------------------------------

describe("the positional key, said out loud", () => {
  test("the positional caveat rides on the key and on the report", () => {
    // Sections 3.3 and 7: the weakest join must not be invisible at read time.
    const positional = new CorrelationKey({
      subjectClass: SUBJECT_WORKER_ESCALATION,
      parts: ["run-1", "2"],
    });
    expect(positional.positional).toBe(true);
    expect(
      new CorrelationKey({ subjectClass: SUBJECT_PR_MERGE, parts: ["github", "o/r", "1"] })
        .positional,
    ).toBe(false);

    const episode = new ShadowEpisode({
      episodeId: "ours-1",
      subjectClass: SUBJECT_WORKER_ESCALATION,
      shape: "received",
      onsetMs: T0,
      keyGap: "gate.run_id is NULL",
    });
    const report = reconciled([episode], [anEpisode("v1-1")]);
    expect(report.positionalCaveat).toBe(POSITIONAL_KEY_CAVEAT);
    expect(renderShadowReconciliation(report)).toContain("positional");
  });

  test("two escalations at one ordinal are refused with the caveat attached", () => {
    // The positional key colliding is the key failing; it is named, not
    // absorbed.
    const first = new ShadowEpisode({
      episodeId: "ours-1",
      subjectClass: SUBJECT_WORKER_ESCALATION,
      shape: "received",
      onsetMs: T0,
      key: new CorrelationKey({
        subjectClass: SUBJECT_WORKER_ESCALATION,
        parts: ["run-1", "2"],
      }),
    });
    const second = new ShadowEpisode({
      episodeId: "ours-2",
      subjectClass: SUBJECT_WORKER_ESCALATION,
      shape: "received",
      onsetMs: T0 + 1,
      key: new CorrelationKey({
        subjectClass: SUBJECT_WORKER_ESCALATION,
        parts: ["run-1", "2"],
      }),
    });
    const refusal = expectRefusal(
      () => reconciled([first, second], [anEpisode("v1-1")]),
      DuplicateCorrelationKey,
    );
    expect(refusal.message).toContain("same order");
  });

  test("a matched pair that disagrees on shape is a finding and not a miss", () => {
    const ours = anEpisode("ours-1", { shape: "failed", parts: ["github", "o/r", "1"] });
    const theirs = anEpisode("v1-1", { shape: "passed", parts: ["github", "o/r", "1"] });
    const report = reconciled([ours], [theirs]);
    expect(report.counts().get(BOTH)).toBe(1);
    expect(report.counts().get(V1_ONLY)).toBe(0);
    expect(report.both[0]?.shapeAgrees).toBe(false);
    expect(report.both[0]?.onsetDeltaMs).toBe(0);
  });
});

// --------------------------------------------------------------------------
// refusals that keep an episode from vanishing
// --------------------------------------------------------------------------

describe("refusals that keep an episode from vanishing", () => {
  test("an episode with neither key nor gap, or with both, is refused", () => {
    expectRefusal(
      () =>
        new ShadowEpisode({
          episodeId: "e",
          subjectClass: SUBJECT_PR_MERGE,
          shape: "merged",
          onsetMs: T0,
        }),
      EpisodeKeyRefused,
    );
    expectRefusal(
      () =>
        new ShadowEpisode({
          episodeId: "e",
          subjectClass: SUBJECT_PR_MERGE,
          shape: "merged",
          onsetMs: T0,
          key: new CorrelationKey({
            subjectClass: SUBJECT_PR_MERGE,
            parts: ["github", "o/r", "1"],
          }),
          keyGap: "also this",
        }),
      EpisodeKeyRefused,
    );
  });

  test("an empty key component is a missing component and is refused", () => {
    expectRefusal(
      () => new CorrelationKey({ subjectClass: SUBJECT_PR_MERGE, parts: ["github", "", "1"] }),
      EpisodeKeyRefused,
    );
  });

  test("a key of another subject class is refused", () => {
    expectRefusal(
      () =>
        new ShadowEpisode({
          episodeId: "e",
          subjectClass: SUBJECT_PR_MERGE,
          shape: "merged",
          onsetMs: T0,
          key: new CorrelationKey({
            subjectClass: SUBJECT_CI_OUTCOME,
            parts: ["github", "o/r", "1", SHA_A],
          }),
        }),
      EpisodeKeyRefused,
    );
  });

  test("a subject class outside the table is refused", () => {
    expectRefusal(
      () => new CorrelationKey({ subjectClass: "something_new", parts: ["a"] }),
      UnknownSubjectClass,
    );
  });

  test("one episode id on both sides is refused", () => {
    expectRefusal(
      () => reconciled([anEpisode("shared")], [anEpisode("shared")]),
      DuplicateEpisodeIdRefused,
    );
  });

  test("an empty or inverted report period is refused", () => {
    expectRefusal(
      () =>
        reconcile({
          periodStartMs: PERIOD_END,
          periodEndMs: PERIOD_START,
          interlockEpisodes: [],
          v1Reference: V1Reference.attestsEmpty({ source: "v1" }),
          censoredIds: [],
          fixtureLabels: new Map(),
        }),
      ShadowRefusal,
    );
  });
});

// --------------------------------------------------------------------------
// the report's own shape
// --------------------------------------------------------------------------

describe("the report's own shape", () => {
  test("the buckets are section 3.3's five and counts emits all of them at zero", () => {
    expect(RECONCILIATION_BUCKETS).toEqual([
      BOTH,
      INTERLOCK_ONLY,
      V1_ONLY,
      UNMATCHED_KEY,
      CENSORED,
    ]);
    const report = reconciled([], V1Reference.attestsEmpty({ source: "v1" }));
    expect(countsOf(report)).toEqual(
      Object.fromEntries(RECONCILIATION_BUCKETS.map((name) => [name, 0])),
    );
    expect(report.filedEpisodeIds()).toEqual([]);
  });

  test("the rendered report is ASCII and survives a cp932 console", () => {
    // CLI output must not crash a Windows terminal on an em-dash.
    const report = reconciled(
      [anEpisode("ours-1", { parts: ["github", "o/r", "1"] })],
      [anEpisode("v1-1", { shape: "relay_gap", parts: ["github", "o/r", "2"] })],
    );
    const rendered = renderShadowReconciliation(report);
    expect(isAscii(rendered)).toBe(true);
    expect(isAscii(POSITIONAL_KEY_CAVEAT)).toBe(true);
    expect([...report.counts().keys()]).toEqual([...RECONCILIATION_BUCKETS]);
    expect([...ADJUDICATIONS]).toEqual([MISS, V1_FALSE_POSITIVE, UNDETERMINED]);
  });

  test("a malformed liveness incident outside the window is not selected", () => {
    // A key gap is not a window exemption. An incident that cannot compute its
    // key still has to belong to the period before it is reported in it.
    // Letting keyless incidents past the selection window would put every
    // historical malformed row into `unmatched_key` in every report forever,
    // and two adjacent periods would count the same ancient rows twice --
    // destroying the one signal section 7 reads out of that bucket, that the
    // key itself needs replacing.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-1");
      addIncident(cp, "inc-ancient-no-elapsed", {
        runId: "run-1",
        sessionId: null,
        createdAtMs: T0 - 30 * DAY_MS,
        elapsedMs: null,
      });
      addIncident(cp, "inc-ancient-no-run", {
        runId: null,
        sessionId: null,
        createdAtMs: T0 - 30 * DAY_MS,
        elapsedMs: MINUTE,
      });
    });

    const episodes = withMeasurement(path, (connection) =>
      readSessionLivenessEpisodes(connection, {
        onsetFromMs: PERIOD_START,
        onsetToMs: PERIOD_END,
        factStates: [LIVENESS_STATE],
      }),
    );

    expect(episodes.map((episode) => episode.episodeId)).toEqual([]);
  });

  test("a malformed liveness incident inside the window says it was bounded", () => {
    // Not dropped, and not passed off as an onset either. Section 3.3's
    // fallback chain never silently drops, so the row is still reported;
    // `created_at_ms` is an upper bound on the onset (`0001_initial.sql` pins
    // it `NOT NULL` and checks `elapsed_ms >= 0`), and the episode declares
    // that it was selected on the bound so a reader can see the period boundary
    // is not exact for it.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-1");
      addIncident(cp, "inc-no-elapsed", {
        runId: "run-1",
        sessionId: null,
        createdAtMs: T0 + 2 * MINUTE,
        elapsedMs: null,
      });
    });

    const episodes = withMeasurement(path, (connection) =>
      readSessionLivenessEpisodes(connection, {
        onsetFromMs: PERIOD_START,
        onsetToMs: PERIOD_END,
        factStates: [LIVENESS_STATE],
      }),
    );

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.key).toBeNull();
    expect(episodes[0]?.onsetBasis).toBe(ONSET_UPPER_BOUND);
    expect(episodes[0]?.onsetMs).toBe(T0 + 2 * MINUTE);
    expect(episodes[0]?.evidence.get("onset_basis")).toBe(ONSET_UPPER_BOUND);

    const report = reconciled(episodes, [anEpisode("v1-1")]);
    expect(report.counts().get(UNMATCHED_KEY)).toBe(1);
    expect(renderShadowReconciliation(report)).toContain(BOUNDED_ONSET_CAVEAT);
  });

  test("a liveness incident with no run is windowed on its derivable onset", () => {
    // `run_id` missing does not make the onset unknown, so the onset windows
    // it. The incident is *raised* inside the period and its condition began
    // before the period started. Windowing it on `created_at_ms` would pull an
    // episode belonging to the previous period into this one; windowing it on
    // the onset -- which `elapsed_ms` still makes derivable -- keeps the two
    // reports disjoint.
    const path = productionDb();
    withWritable(path, (cp) => {
      addIncident(cp, "inc-no-run", {
        runId: null,
        sessionId: null,
        createdAtMs: PERIOD_START + MINUTE,
        elapsedMs: 10 * MINUTE,
      });
    });

    const { thisPeriod, previousPeriod } = withMeasurement(path, (connection) => ({
      thisPeriod: readSessionLivenessEpisodes(connection, {
        onsetFromMs: PERIOD_START,
        onsetToMs: PERIOD_END,
        factStates: [LIVENESS_STATE],
      }),
      previousPeriod: readSessionLivenessEpisodes(connection, {
        onsetFromMs: PERIOD_START - DAY_MS,
        onsetToMs: PERIOD_START,
        factStates: [LIVENESS_STATE],
      }),
    }));

    expect(thisPeriod.map((episode) => episode.episodeId)).toEqual([]);
    expect(previousPeriod.map((episode) => episode.episodeId)).toEqual(["liveness:inc-no-run"]);
    expect(previousPeriod[0]?.key).toBeNull();
    expect(previousPeriod[0]?.onsetBasis).toBe(ONSET_OBSERVED);
    expect(previousPeriod[0]?.onsetMs).toBe(PERIOD_START - 9 * MINUTE);
  });

  test("an episode selected on a bound may not carry a correlation key", () => {
    // A latency measured against a bound is not a latency.
    // `MatchedPair.onsetDeltaMs` subtracts the two sides' onsets, so a keyed
    // episode whose instant is only an upper bound would report a fabricated
    // detection latency as a measured one.
    const refusal = expectRefusal(
      () =>
        new ShadowEpisode({
          episodeId: "liveness:inc-1",
          subjectClass: SUBJECT_SESSION_LIVENESS,
          shape: LIVENESS_STATE,
          onsetMs: T0,
          key: new CorrelationKey({
            subjectClass: SUBJECT_SESSION_LIVENESS,
            parts: ["run-1", "1"],
          }),
          onsetBasis: ONSET_UPPER_BOUND,
        }),
      EpisodeKeyRefused,
    );
    expect(refusal.message).toContain("latency");
  });
});

// --------------------------------------------------------------------------
// properties the ported cases leave unguarded (target-only)
// --------------------------------------------------------------------------

describe("properties the ported cases leave unguarded (target-only)", () => {
  test("a fixture label outside the vocabulary is refused even when no episode wears it", () => {
    // Target-only, and an INHERITED gap: interlock's own suite cannot tell
    // `reconcile`'s vocabulary check from a module without one, because its
    // case labels the shape its v1 episode already carries -- so the
    // V1OnlyEpisode constructor refuses it a moment later and the test passes
    // either way. The two checks are not the same check. A label whose shape
    // never appears in this period is exactly the typo that reaches no
    // constructor: a corpus that says `undetermind` settles nothing, and
    // without the early refusal the report is computed against a corpus the
    // caller believes covers a shape it does not.
    expectRefusal(
      () =>
        reconciled([], [anEpisode("v1-1", { shape: "merged" })], {
          fixtureLabels: new Map([["a_shape_no_episode_has", "probably"]]),
        }),
      UnknownAdjudication,
    );
  });

  test("two subject classes spelling the same parts do not pair", () => {
    // Target-only, and INHERITED: no ported case gives two episodes of
    // different subject classes the same components, so the class's presence in
    // the token is unexercised. The docstring names the failure -- a merge
    // episode reported as agreeing with a CI outcome -- and it is a `both` that
    // should have been one `interlock_only` and one candidate miss, which is
    // the one direction the reconciliation must never invent.
    const ours = anEpisode("ours-1", {
      subjectClass: SUBJECT_PR_MERGE,
      parts: ["github", "o/r", "1"],
    });
    const theirs = anEpisode("v1-1", {
      subjectClass: SUBJECT_SESSION_LIVENESS,
      shape: LIVENESS_STATE,
      parts: ["github", "o/r", "1"],
    });

    const report = reconciled([ours], [theirs]);
    expect(report.counts().get(BOTH)).toBe(0);
    expect(report.counts().get(INTERLOCK_ONLY)).toBe(1);
    expect(report.counts().get(V1_ONLY)).toBe(1);
  });

  test("a negative onset buckets downward, not toward zero", () => {
    // Target-only, and INHERITED: every ported case onsets after T0, and
    // `Math.trunc` and `Math.floor` agree on every positive instant, so the
    // source's own comment ("floor division, so a negative onset buckets
    // downward like every other instant rather than toward zero") is
    // unexercised on both sides. A negative onset is reachable from rows the
    // schema permits -- `created_at_ms` and `elapsed_ms` are both non-negative
    // and their difference need not be -- and under truncation the two
    // instants below become one bucket, which is two distinct conditions on one
    // run collapsing into a single episode identity.
    const path = productionDb();
    withWritable(path, (cp) => {
      addRun(cp, "run-1");
      // onset -1000: one bucket below zero.
      addIncident(cp, "inc-before-epoch", {
        runId: "run-1",
        sessionId: null,
        createdAtMs: 1_000,
        elapsedMs: 2_000,
      });
      // onset 0: the first bucket at or after the epoch.
      addIncident(cp, "inc-at-epoch", {
        runId: "run-1",
        sessionId: null,
        createdAtMs: 1_000,
        elapsedMs: 1_000,
      });
    });

    const episodes = withMeasurement(path, (connection) =>
      readSessionLivenessEpisodes(connection, {
        onsetFromMs: -DAY_MS,
        onsetToMs: DAY_MS,
        factStates: [LIVENESS_STATE],
      }),
    );

    const buckets = new Map(episodes.map((episode) => [episode.episodeId, episode.key?.parts[1]]));
    expect(buckets.get("liveness:inc-before-epoch")).toBe("-1");
    expect(buckets.get("liveness:inc-at-epoch")).toBe("0");
  });
});

describe("a deliberate divergence from interlock (target-only)", () => {
  test("the positional caveat prints for an unpaired escalation in any bucket", () => {
    // Target-only, and `D-0108`, decided by the operator on 2026-08-22 with the
    // withdrawal of `D-0022`.
    //
    // interlock guards the caveat on the unmatched_key bucket alone, and that
    // is the bucket where a positional episode is LEAST likely to be the story.
    // An escalation whose key composed and found no counterpart is filed
    // interlock_only or v1_only -- and a run of exactly those is what an
    // ordering divergence looks like, which is the situation the caveat exists
    // to warn about. So the warning went missing precisely when the key was the
    // first thing to doubt. Raised by the codex review gate on the shadow belt
    // and disclosed there under D-0022; repaired here now that D-0022 is
    // withdrawn.
    const ours = new ShadowEpisode({
      episodeId: "ours-1",
      subjectClass: SUBJECT_WORKER_ESCALATION,
      shape: "received",
      onsetMs: T0,
      key: new CorrelationKey({
        subjectClass: SUBJECT_WORKER_ESCALATION,
        parts: ["run-1", "1"],
      }),
    });
    const theirs = new ShadowEpisode({
      episodeId: "v1-1",
      subjectClass: SUBJECT_WORKER_ESCALATION,
      shape: "received",
      onsetMs: T0,
      key: new CorrelationKey({
        // The same run, one ordinal further along: exactly what a divergence in
        // escalation order produces.
        subjectClass: SUBJECT_WORKER_ESCALATION,
        parts: ["run-1", "2"],
      }),
    });

    const report = reconciled([ours], [theirs]);
    // Neither episode is in unmatched_key -- both computed a key and neither
    // found a counterpart.
    expect(report.counts().get(UNMATCHED_KEY)).toBe(0);
    expect(report.counts().get(INTERLOCK_ONLY)).toBe(1);
    expect(report.counts().get(V1_ONLY)).toBe(1);
    expect(renderShadowReconciliation(report)).toContain(POSITIONAL_KEY_CAVEAT);
  });
});

describe("hostile values in the rendering (target-only)", () => {
  test("an episode id cannot forge a line and cannot reach a cp932 console", () => {
    // Target-only, and `D-0109`. This module was NOT among the three the
    // inventory listed: the ledger recorded no disclosure for it, and the
    // defect was found by reading the renderer rather than the ledger. Episode
    // ids, shapes and evidence values all arrive from the v1 adapter or the
    // database, and all went into the line verbatim.
    const candidate = anEpisode("v1-1\n    - forged: a line the harness never wrote", {
      shape: "relay_gap\u2014em-dash",
      parts: ["github", "o/r", "9"],
    });
    const rendered = renderShadowReconciliation(reconciled([], [candidate]));

    expect(isAscii(rendered)).toBe(true);
    expect(rendered).toContain("\\u000a");
    expect(rendered).toContain("\\u2014");
    // The itemisation still has exactly one entry: the newline did not open a
    // second.
    expect(rendered.split("\n").filter((line) => line.trimStart().startsWith("- "))).toHaveLength(
      1,
    );
  });
});

describe("every externally-supplied field at once (target-only)", () => {
  test("a reconciliation whose every caller value is hostile still renders one report", () => {
    // Target-only, and the structural form of the D-0109 check. The v1 adapter
    // supplies its own name, every episode id, every shape and every evidence
    // pair, and the report prints all of them.
    const ours = new ShadowEpisode({
      episodeId: "ours-1\u2014one",
      subjectClass: SUBJECT_WORKER_ESCALATION,
      shape: "received\u2014shape",
      onsetMs: T0,
      keyGap: "gate.run_id is NULL\nNOTE: forged",
      evidence: [["gate_id\u2014k", "g\n    - forged evidence"]],
    });
    const theirs = new ShadowEpisode({
      episodeId: "v1-1\n    - forged: a line the harness never wrote",
      subjectClass: SUBJECT_PR_MERGE,
      shape: "merged\u2014shape",
      onsetMs: T0,
      key: new CorrelationKey({ subjectClass: SUBJECT_PR_MERGE, parts: ["github", "o/r", "1"] }),
      evidence: [["note\u2014k", "v\u20141"]],
    });

    const report = reconcile({
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      interlockEpisodes: [ours],
      v1Reference: V1Reference.observed({
        source: "v1-adapter\u2014one\n  shadow reference: forged",
        episodes: [theirs],
      }),
      censoredIds: [],
      fixtureLabels: new Map(),
    });
    const rendered = renderShadowReconciliation(report);

    expect(isAscii(rendered)).toBe(true);
    // One line per bucket, one awaiting-adjudication entry, and no forged ones.
    expect(
      rendered.split("\n").filter((line) => line.startsWith("  shadow reference:")),
    ).toHaveLength(1);
    expect(rendered.split("\n").filter((line) => line.trimStart().startsWith("- "))).toHaveLength(
      1,
    );
  });
});

describe("the absent branch, fully escaped (target-only)", () => {
  test("an absent reference's reason is escaped too", () => {
    // The absence reason is rendered by a branch no other case reaches, and
    // reverting its escape was the one site the all-fields case above missed --
    // measured by reverting each of this renderer's six sites in turn.
    const report = reconciled(
      [anEpisode("ours-1")],
      V1Reference.absent({ reason: "outside the shadow period\u2014entirely\n  reason: forged" }),
    );
    const rendered = renderShadowReconciliation(report);

    expect(isAscii(rendered)).toBe(true);
    expect(rendered.split("\n").filter((line) => line.startsWith("  reason: "))).toHaveLength(1);
  });
});
