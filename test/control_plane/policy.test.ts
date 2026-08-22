/**
 * What `policy.ts` must keep true, with the second revision always on record.
 *
 * Ported from interlock `tests/control_plane/test_policy.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping is recorded in the
 * parity ledger.
 *
 * `D-0031`'s corollary -- a `policy_*` join without a `revision_id` predicate is
 * a defect -- has a property that makes it dangerous to test carelessly: it is
 * *invisible* while only one revision exists. A suite that seeds one revision
 * and reads it back passes identically whether the module binds a revision or
 * ignores the column entirely. So the fixture here puts **two** revisions on
 * record before anything is asserted, and every reader test asserts it got
 * exactly the one it asked for. A regression that dropped the predicate would
 * return two rows, or the wrong row, in every one of them.
 *
 * The rest of the file is the arithmetic of `time-base-policy.md` section 3
 * exercised against real subjects rather than restated:
 *
 * * the section 3.3 worked bound (`L` = 10 min, `P` = 120 s, `T` = 3 polls, so a
 *   scope may poll no slower than 160 s) driven as an actual `watcher_scope` on
 *   both sides of the boundary, since the boundary is where a `<` written as a
 *   `<=` hides;
 * * the half-open window rule (section 2, rule 4) at an exact boundary instant,
 *   asserting both halves of the claim -- the instant belongs to the later
 *   window, *and* it belongs to exactly one; and
 * * `consecutive_count` refused as a duration, because the coercion that a
 *   refusal prevents (5 failures read as 5 ms) is silent and produces a
 *   tolerance every subject crosses immediately.
 *
 * Every timestamp is {@link T0} plus arithmetic. No test reads a clock: the
 * module takes `nowMs` from its caller precisely so a tolerance boundary can be
 * driven to either side of itself, and a suite that used a wall clock could not
 * do that.
 *
 * The four `describe` blocks are the source file's own section banners, in the
 * source's order: resolving a revision, then the readers that depend on that
 * resolution, then a relative threshold meeting its subject, then section 10's
 * per-subject `T + P <= L` pass.
 *
 * Each pytest fixture (`cp`, `two_revisions`) is a plain function called inside
 * the test, per the conventions' rule 8: the source's fixtures are function
 * scoped, and a per-test call is the mapping that keeps them so. The connection's
 * `close()` is registered with `onTestFinished` at the point of acquisition, so
 * an open handle never outlives the test that opened it -- on Windows that
 * handle is what fails the temporary-directory cleanup.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import type { BudgetViolation } from "../../src/control_plane/policy.js";
import {
  budgetViolations,
  detectionLatency,
  effectiveRevisionId,
  gateStageOwner,
  gateStageTolerance,
  NoEffectiveRevision,
  NotADuration,
  PolicyRefusal,
  PolicyRowMissing,
  PolicyUsageError,
  resolveToleranceMs,
  revisionOverPeriod,
} from "../../src/control_plane/policy.js";
import { caseRoot, databasePath } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

/**
 * The note of the revision `0002_policy_seed.sql` writes. Looked up by note
 * rather than assumed to be `1` so these tests survive a later seed step.
 */
const SEED_NOTE =
  "initial time base: detection latency budgets, gate stage tolerances " +
  "and gate stage owners as first decided";

/**
 * `L` and `P` for `watcher_silence` as seeded (section 3.2 / 3.3), and the scope
 * poll interval the two of them bound: (600000 - 120000) / 3.
 */
const SILENCE_BUDGET_MS = 600_000;
const RECONCILE_PERIOD_MS = 120_000;
const SILENCE_MULTIPLE = 3;
const MAX_LEGAL_INTERVAL_MS = Math.floor(
  (SILENCE_BUDGET_MS - RECONCILE_PERIOD_MS) / SILENCE_MULTIPLE,
);

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------

/** The source's `cp` fixture: a fresh production control plane at `T0`. */
function cpFixture(): SqliteDatabase {
  const connection = createProductionControlPlane(databasePath(caseRoot("policy")), {
    nowMs: T0,
  });
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

// --------------------------------------------------------------------------
// helpers -- the smallest legal row of each kind
// --------------------------------------------------------------------------

function seedRevisionId(cp: SqliteDatabase): number {
  const row = cp
    .prepare<[string], { revision_id: number }>(
      "SELECT revision_id FROM policy_revision WHERE note = ?",
    )
    .get(SEED_NOTE);
  // Narrowed with a throw rather than an `expect().not.toBeUndefined()` plus a
  // cast: `expect` does not narrow, so the cast would survive an edit that
  // removed the assertion and would then be a claim about a value nobody
  // checked.
  if (row === undefined) {
    expect.fail("0002_policy_seed.sql must have applied");
  }
  return Number(row.revision_id);
}

function addRevision(
  cp: SqliteDatabase,
  options: { readonly note: string; readonly at: number; readonly decidedBy?: string },
): number {
  const info = cp
    .prepare("INSERT INTO policy_revision (note, decided_by, effective_at_ms) VALUES (?, ?, ?)")
    .run(options.note, options.decidedBy ?? "D-test", options.at);
  return Number(info.lastInsertRowid);
}

function addDetectionLatency(
  cp: SqliteDatabase,
  revisionId: number,
  incidentClass: string,
  thresholdKind: string,
  thresholdValue: number,
  options: {
    readonly reconcilePeriodMs?: number;
    readonly budgetMs?: number;
    readonly budgetKind?: string;
  } = {},
): void {
  cp.prepare(
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
    options.reconcilePeriodMs ?? RECONCILE_PERIOD_MS,
    options.budgetMs ?? SILENCE_BUDGET_MS,
    options.budgetKind ?? "absolute_ms",
  );
}

function addStageTolerance(
  cp: SqliteDatabase,
  revisionId: number,
  gateType: string,
  stage: string,
  toleranceMs: number | null,
): void {
  cp.prepare(
    "INSERT INTO policy_gate_stage_tolerance (revision_id, gate_type, stage, tolerance_ms)" +
      " VALUES (?, ?, ?, ?)",
  ).run(revisionId, gateType, stage, toleranceMs);
}

function addStageOwner(
  cp: SqliteDatabase,
  revisionId: number,
  gateType: string,
  stage: string,
  ballHolder: string,
  standingOwner: string,
): void {
  cp.prepare(
    `
        INSERT INTO policy_gate_stage_owner (revision_id, gate_type, stage, ball_holder,
                                             standing_owner)
        VALUES (?, ?, ?, ?, ?)
        `,
  ).run(revisionId, gateType, stage, ballHolder, standingOwner);
}

function addRepository(cp: SqliteDatabase, repoId = "repo-1", at: number = T0): string {
  cp.prepare(
    `
        INSERT INTO repository (repo_id, provider, provider_repo_id, owner, name,
                                created_at_ms, updated_at_ms)
        VALUES (?, 'github', NULL, 'acme', 'widget', ?, ?)
        `,
  ).run(repoId, at, at);
  return repoId;
}

function addWatcherScope(
  cp: SqliteDatabase,
  scopeId: string,
  options: {
    readonly expectedIntervalMs: number;
    readonly enabled?: number;
    readonly retiredAtMs?: number | null;
    readonly at?: number;
  },
): string {
  cp.prepare(
    `
        INSERT INTO watcher_scope (scope_id, scope_kind, repo_id, pr_id, expected_interval_ms,
                                   enabled, registered_at_ms, retired_at_ms)
        VALUES (?, 'ci_repository', 'repo-1', NULL, ?, ?, ?, ?)
        `,
  ).run(
    scopeId,
    options.expectedIntervalMs,
    options.enabled ?? 1,
    options.at ?? T0,
    options.retiredAtMs ?? null,
  );
  return scopeId;
}

function addLease(
  cp: SqliteDatabase,
  resource: string,
  options: {
    readonly ttlMs: number;
    readonly at?: number;
    readonly holder?: string;
    readonly epoch?: number;
  },
): string {
  const at = options.at ?? T0;
  cp.prepare(
    "INSERT INTO lease (resource, holder, epoch, acquired_at_ms, expires_at_ms)" +
      " VALUES (?, ?, ?, ?, ?)",
  ).run(resource, options.holder ?? "watcher-a", options.epoch ?? 1, at, at + options.ttlMs);
  return resource;
}

/**
 * The source's `two_revisions` fixture: the seeded revision, plus a later one
 * that changes every value it can.
 *
 * The later revision is deliberately *different* in every column the readers
 * return, so a reader that bound the wrong revision -- or none -- returns a
 * value no assertion below accepts, rather than the same number by luck.
 */
function twoRevisions(cp: SqliteDatabase): readonly [number, number] {
  const first = seedRevisionId(cp);
  const second = addRevision(cp, { note: "tightened after the 2026-09 review", at: T0 + 10_000 });
  addDetectionLatency(cp, second, "watcher_silence", "scope_interval_multiple", 2, {
    budgetMs: SILENCE_BUDGET_MS,
  });
  addDetectionLatency(cp, second, "ci_outcome_undrained", "absolute_ms", 60_000, {
    budgetMs: 300_000,
  });
  addDetectionLatency(cp, second, "watcher_error_streak", "consecutive_count", 9);
  addStageTolerance(cp, second, "worker_escalation", "received", 60_000);
  addStageTolerance(cp, second, "worker_escalation", "presented", null);
  addStageOwner(cp, second, "worker_escalation", "received", "dispatcher_core", "human");
  return [first, second];
}

/**
 * Python's `(violation,) = ...` unpacking, which asserts the count and binds the
 * element in one step. Written as a helper so the count assertion cannot be lost
 * on the way to `[0]`, which is exactly what an indexed read would do.
 */
function onlyOne(violations: readonly BudgetViolation[]): BudgetViolation {
  expect(violations).toHaveLength(1);
  return violations[0] as BudgetViolation;
}

// --------------------------------------------------------------------------
// resolving a revision -- the predicate every other reader depends on
// --------------------------------------------------------------------------

describe("resolving a revision -- the predicate every other reader depends on", () => {
  test("the effective revision is the latest one at or before now", () => {
    const cp = cpFixture();
    const [first, second] = twoRevisions(cp);

    expect(effectiveRevisionId(cp, { nowMs: T0 })).toBe(first);
    expect(effectiveRevisionId(cp, { nowMs: T0 + 9_999 })).toBe(first);
    expect(effectiveRevisionId(cp, { nowMs: T0 + 10_000 })).toBe(second);
    expect(effectiveRevisionId(cp, { nowMs: T0 + 10_001 })).toBe(second);
  });

  test("two revisions sharing an instant resolve to the higher revision id", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    const corrected = addRevision(cp, {
      note: "a correction filed in the same pass",
      at: T0 + 5_000,
    });
    const superseding = addRevision(cp, {
      note: "and the row that corrects it",
      at: T0 + 5_000,
    });

    expect(effectiveRevisionId(cp, { nowMs: T0 + 5_000 })).toBe(superseding);
    expect(superseding).toBeGreaterThan(corrected);
    expect(corrected).toBeGreaterThan(first);
  });

  test("an instant before every revision is refused rather than answered", () => {
    const cp = cpFixture();
    cp.prepare("DELETE FROM policy_gate_stage_owner").run();
    cp.prepare("DELETE FROM policy_gate_stage_tolerance").run();
    cp.prepare("DELETE FROM policy_detection_latency").run();
    cp.prepare("DELETE FROM policy_revision").run();

    expectRefusal(() => effectiveRevisionId(cp, { nowMs: T0 }), NoEffectiveRevision);
  });

  test("a period within one revision is homogeneous", () => {
    const cp = cpFixture();
    const [first] = twoRevisions(cp);

    expect(revisionOverPeriod(cp, { periodStartMs: T0, periodEndMs: T0 + 5_000 })).toEqual([first]);
  });

  test("a period spanning a change reports both revisions oldest first", () => {
    const cp = cpFixture();
    const [first, second] = twoRevisions(cp);

    expect(revisionOverPeriod(cp, { periodStartMs: T0, periodEndMs: T0 + 20_000 })).toEqual([
      first,
      second,
    ]);
  });

  test("a revision effective exactly at a boundary belongs to the later window only", () => {
    // Half-open `[start, end)`: the boundary instant is in one window, the
    // later one.
    const cp = cpFixture();
    const [first, second] = twoRevisions(cp);
    const boundary = T0 + 10_000;

    const earlier = revisionOverPeriod(cp, { periodStartMs: T0, periodEndMs: boundary });
    const later = revisionOverPeriod(cp, {
      periodStartMs: boundary,
      periodEndMs: boundary + 10_000,
    });

    expect(earlier).toEqual([first]);
    expect(later).toEqual([second]);
    const laterSet = new Set(later);
    expect(earlier.filter((revision) => laterSet.has(revision))).toEqual([]);
  });

  test("two revisions sharing an instant inside a period count once", () => {
    // A correction filed in the same millisecond is one change, not two.
    //
    // `effectiveRevisionId` has always resolved a tie to the higher
    // `revision_id`; `revisionOverPeriod` used to order by
    // `effective_at_ms, revision_id` and return *both* rows, so the superseded
    // row -- in force for zero milliseconds -- joined the period set. That is a
    // revision the report names as having governed part of the period when it
    // never governed any of it (`measurement-harness.md` section 6, `D-0040`).
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    const superseded = addRevision(cp, {
      note: "a correction filed in the same pass",
      at: T0 + 5_000,
    });
    const superseding = addRevision(cp, {
      note: "and the row that corrects it",
      at: T0 + 5_000,
    });

    const over = revisionOverPeriod(cp, { periodStartMs: T0, periodEndMs: T0 + 10_000 });

    expect(over).toEqual([first, superseding]);
    expect(over, "a revision in force for zero ms is not in the period").not.toContain(superseded);
  });

  test("the period set is exactly what the detector would bind at each instant", () => {
    // The two functions must agree by construction, not by coincidence.
    //
    // They answer the same question -- which revision is in force -- for one
    // instant and for a window, so the window's members can only be revisions
    // the per-instant reader would itself have returned. Sweeping the instants
    // and comparing against `effectiveRevisionId` binds the pair to each other
    // rather than to a tie-break rule pasted into this file: if one of them ever
    // re-derives the rule locally and drifts, this fails.
    const cp = cpFixture();
    seedRevisionId(cp);
    addRevision(cp, { note: "a correction filed in the same pass", at: T0 + 5_000 });
    addRevision(cp, { note: "and the row that corrects it", at: T0 + 5_000 });
    addRevision(cp, { note: "a later change", at: T0 + 9_000 });

    const instants = [T0, T0 + 4_999, T0 + 5_000, T0 + 5_001, T0 + 8_999, T0 + 9_000, T0 + 9_999];
    const boundAtEachInstant = new Set(
      instants.map((instant) => effectiveRevisionId(cp, { nowMs: instant })),
    );

    const over = revisionOverPeriod(cp, { periodStartMs: T0, periodEndMs: T0 + 10_000 });

    expect(new Set(over)).toEqual(boundAtEachInstant);
    expect(new Set(over).size, "no revision is named twice").toBe(over.length);
    for (const instant of instants) {
      // every member is in force somewhere, and the last member is in force at
      // the period's final millisecond -- the two ends of the same claim.
      expect(over).toContain(effectiveRevisionId(cp, { nowMs: instant }));
    }
    expect(over.at(-1)).toBe(effectiveRevisionId(cp, { nowMs: T0 + 9_999 }));
  });

  test("a period is refused when its end precedes its start", () => {
    const cp = cpFixture();
    twoRevisions(cp);

    expectRefusal(
      () => revisionOverPeriod(cp, { periodStartMs: T0 + 1, periodEndMs: T0 }),
      PolicyUsageError,
    );
  });
});

// --------------------------------------------------------------------------
// every reader returns exactly the bound revision's row
// --------------------------------------------------------------------------

describe("every reader returns exactly the bound revision's row", () => {
  test("detection latency returns one row per bound revision", () => {
    const cp = cpFixture();
    const [first, second] = twoRevisions(cp);

    const underFirst = detectionLatency(cp, {
      revisionId: first,
      incidentClass: "ci_outcome_undrained",
    });
    const underSecond = detectionLatency(cp, {
      revisionId: second,
      incidentClass: "ci_outcome_undrained",
    });

    expect(underFirst.thresholdValue).toBe(180_000);
    expect(underFirst.budgetMs).toBe(300_000);
    expect(underFirst.thresholdKind).toBe("absolute_ms");
    expect(underFirst.budgetKind).toBe("absolute_ms");
    expect(underSecond.thresholdValue).toBe(60_000);
  });

  test("a class the bound revision never decided is missing not empty", () => {
    const cp = cpFixture();
    const [, second] = twoRevisions(cp);

    expectRefusal(
      () => detectionLatency(cp, { revisionId: second, incidentClass: "lease_orphan" }),
      PolicyRowMissing,
    );
  });

  test("gate stage tolerance returns the bound revisions value", () => {
    const cp = cpFixture();
    const [first, second] = twoRevisions(cp);

    expect(
      gateStageTolerance(cp, {
        revisionId: first,
        gateType: "worker_escalation",
        stage: "received",
      }),
    ).toBe(180_000);
    expect(
      gateStageTolerance(cp, {
        revisionId: second,
        gateType: "worker_escalation",
        stage: "received",
      }),
    ).toBe(60_000);
  });

  test("the human stage is never a gap and says so as a null tolerance", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);

    // `null`, not `undefined`: the seeded row exists and stores SQL NULL
    // (`D-0007`), which is a different fact from the absent row asserted by the
    // case below.
    expect(
      gateStageTolerance(cp, {
        revisionId: first,
        gateType: "worker_escalation",
        stage: "presented",
      }),
    ).toBeNull();
  });

  test("a stage the revision never decided is not the same fact as never a gap", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);

    expectRefusal(
      () =>
        gateStageTolerance(cp, {
          revisionId: first,
          gateType: "worker_escalation",
          stage: "forwarded",
        }),
      PolicyRowMissing,
    );
    expectRefusal(
      () =>
        gateStageTolerance(cp, {
          revisionId: first,
          gateType: "plan_approval",
          stage: "received",
        }),
      PolicyRowMissing,
    );
  });

  test("gate stage owner returns the bound revisions ball holder and standing owner", () => {
    const cp = cpFixture();
    const [first, second] = twoRevisions(cp);

    const underFirst = gateStageOwner(cp, {
      revisionId: first,
      gateType: "worker_escalation",
      stage: "received",
    });
    const underSecond = gateStageOwner(cp, {
      revisionId: second,
      gateType: "worker_escalation",
      stage: "received",
    });

    expect(underFirst.ballHolder).toBe("secretary");
    expect(underFirst.standingOwner).toBe("secretary");
    expect(underSecond.ballHolder).toBe("dispatcher_core");
    expect(underSecond.standingOwner).toBe("human");
  });

  test("the standing owner differs from the ball holder where the gate type says so", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);

    const received = gateStageOwner(cp, {
      revisionId: first,
      gateType: "merge_approval",
      stage: "received",
    });

    expect(received.ballHolder).toBe("secretary");
    expect(received.standingOwner).toBe("human");
  });
});

// --------------------------------------------------------------------------
// a relative threshold meets its subject
// --------------------------------------------------------------------------

describe("a relative threshold meets its subject", () => {
  test("an absolute tolerance is the row itself", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);

    expect(
      resolveToleranceMs(cp, {
        revisionId: first,
        incidentClass: "ci_outcome_undrained",
        subject: undefined,
      }),
    ).toBe(180_000);
  });

  test("a scope multiple is scaled by that scopes own poll interval", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    addRepository(cp);
    addWatcherScope(cp, "scope-fast", { expectedIntervalMs: 30_000 });
    addWatcherScope(cp, "scope-slow", { expectedIntervalMs: 120_000 });

    const fast = resolveToleranceMs(cp, {
      revisionId: first,
      incidentClass: "watcher_silence",
      subject: "scope-fast",
    });
    const slow = resolveToleranceMs(cp, {
      revisionId: first,
      incidentClass: "watcher_silence",
      subject: "scope-slow",
    });

    expect(fast).toBe(SILENCE_MULTIPLE * 30_000);
    expect(slow).toBe(SILENCE_MULTIPLE * 120_000);
  });

  test("a lease ttl multiple is scaled by that leases own ttl", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    addLease(cp, "watcher_scope:scope-1", { ttlMs: 300_000 });

    expect(
      resolveToleranceMs(cp, {
        revisionId: first,
        incidentClass: "lease_orphan",
        subject: "watcher_scope:scope-1",
      }),
    ).toBe(300_000);
  });

  test("a consecutive count is refused as a duration", () => {
    // 5 consecutive failures is not 5 milliseconds, and no subject makes it one.
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    addRepository(cp);
    addWatcherScope(cp, "scope-1", { expectedIntervalMs: 60_000 });

    expectRefusal(
      () =>
        resolveToleranceMs(cp, {
          revisionId: first,
          incidentClass: "watcher_error_streak",
          subject: "scope-1",
        }),
      NotADuration,
    );
    expectRefusal(
      () =>
        resolveToleranceMs(cp, {
          revisionId: first,
          incidentClass: "watcher_error_streak",
          subject: undefined,
        }),
      NotADuration,
    );
  });

  test("a relative threshold without a subject is refused not read as the bare multiple", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);

    expectRefusal(
      () =>
        resolveToleranceMs(cp, {
          revisionId: first,
          incidentClass: "watcher_silence",
          subject: undefined,
        }),
      PolicyUsageError,
    );
  });

  test("a subject that does not exist is refused", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);

    expectRefusal(
      () =>
        resolveToleranceMs(cp, {
          revisionId: first,
          incidentClass: "watcher_silence",
          subject: "scope-absent",
        }),
      PolicyUsageError,
    );
  });
});

// --------------------------------------------------------------------------
// section 10's per-subject T + P <= L pass
// --------------------------------------------------------------------------

describe("section 10's per-subject T + P <= L pass", () => {
  test("a scope polling within the bound raises no violation", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    addRepository(cp);
    addWatcherScope(cp, "scope-ok", { expectedIntervalMs: MAX_LEGAL_INTERVAL_MS });

    expect(budgetViolations(cp, { revisionId: first, nowMs: T0 })).toEqual([]);
  });

  test("a scope polling one millisecond slower than the bound is reported", () => {
    // The section 3.3 arithmetic: (600000 - 120000) / 3 = 160000 ms, exercised
    // at the edge.
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    addRepository(cp);
    addWatcherScope(cp, "scope-slow", { expectedIntervalMs: MAX_LEGAL_INTERVAL_MS + 1 });

    const violation = onlyOne(budgetViolations(cp, { revisionId: first, nowMs: T0 }));

    expect(violation.incidentClass).toBe("watcher_silence");
    expect(violation.subjectKind).toBe("watcher_scope");
    expect(violation.subjectId).toBe("scope-slow");
    expect(violation.toleranceMs).toBe(SILENCE_MULTIPLE * (MAX_LEGAL_INTERVAL_MS + 1));
    expect(violation.budgetMs).toBe(SILENCE_BUDGET_MS);
    expect(violation.excessMs).toBe(SILENCE_MULTIPLE);
  });

  test("only the misconfigured scope is named when others are fine", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    addRepository(cp);
    addWatcherScope(cp, "scope-a", { expectedIntervalMs: 60_000 });
    addWatcherScope(cp, "scope-b", { expectedIntervalMs: 600_000 });
    addWatcherScope(cp, "scope-c", { expectedIntervalMs: 120_000 });

    const violations = budgetViolations(cp, { revisionId: first, nowMs: T0 });

    expect(violations.map((violation) => violation.subjectId)).toEqual(["scope-b"]);
  });

  test("a retired or disabled scope has no watcher to be late and is not reported", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    addRepository(cp);
    addWatcherScope(cp, "scope-retired", {
      expectedIntervalMs: 600_000,
      retiredAtMs: T0 + 1_000,
    });
    addWatcherScope(cp, "scope-disabled", { expectedIntervalMs: 600_000, enabled: 0 });

    expect(budgetViolations(cp, { revisionId: first, nowMs: T0 })).toEqual([]);
  });

  test("a lease whose orphan window fits its own ttl raises no violation", () => {
    // `lease_orphan` is relative on BOTH sides: T = 1 x TTL, L = 2 x TTL.
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    addLease(cp, "watcher_scope:scope-1", { ttlMs: RECONCILE_PERIOD_MS });

    expect(budgetViolations(cp, { revisionId: first, nowMs: T0 })).toEqual([]);
  });

  test("a lease ttl shorter than the reconcile period breaks its own budget", () => {
    // T + P <= L with T = TTL and L = 2 x TTL reduces to P <= TTL.
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    addLease(cp, "watcher_scope:scope-1", { ttlMs: RECONCILE_PERIOD_MS - 1 });

    const violation = onlyOne(budgetViolations(cp, { revisionId: first, nowMs: T0 }));

    expect(violation.incidentClass).toBe("lease_orphan");
    expect(violation.subjectKind).toBe("lease");
    expect(violation.subjectId).toBe("watcher_scope:scope-1");
    expect(violation.toleranceMs).toBe(RECONCILE_PERIOD_MS - 1);
    expect(violation.budgetMs).toBe(2 * (RECONCILE_PERIOD_MS - 1));
    expect(violation.excessMs).toBe(1);
  });

  test("an expired lease has no orphan window left to size", () => {
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    addLease(cp, "watcher_scope:scope-1", { ttlMs: RECONCILE_PERIOD_MS - 1 });

    expect(budgetViolations(cp, { revisionId: first, nowMs: T0 + RECONCILE_PERIOD_MS })).toEqual(
      [],
    );
  });

  test("the pass reads only the bound revision", () => {
    // The whole point of D-0031's corollary, as one assertion.
    //
    // The second revision halves `watcher_silence`'s multiple, so the same scope
    // is a violation under one revision and not under the other. A pass that
    // omitted the `revision_id` predicate would report it twice.
    const cp = cpFixture();
    const [first, second] = twoRevisions(cp);
    addRepository(cp);
    addWatcherScope(cp, "scope-1", { expectedIntervalMs: 200_000 });

    const underFirst = budgetViolations(cp, { revisionId: first, nowMs: T0 });
    const underSecond = budgetViolations(cp, { revisionId: second, nowMs: T0 });

    expect(underFirst.map((violation) => violation.subjectId)).toEqual(["scope-1"]);
    expect(underSecond).toEqual([]);
  });

  test("a consecutive count class is skipped rather than stopping the pass", () => {
    // It has no duration to compare, and it is not the misconfigured thing.
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    addRepository(cp);
    addWatcherScope(cp, "scope-slow", { expectedIntervalMs: 600_000 });

    const violations = budgetViolations(cp, { revisionId: first, nowMs: T0 });

    expect(violations.map((violation) => violation.incidentClass)).toEqual(["watcher_silence"]);
  });

  test("an absolute threshold under a relative budget scales only the budget", () => {
    // The other asymmetry: T absolute, L a multiple of the subject's own TTL.
    //
    // Every case above has the *relative* side on `T` (`watcher_silence`) or on
    // both (`lease_orphan`), so the branch that leaves `T` alone while scaling
    // `L` has never been driven. It is the branch most easily written backwards,
    // because "the relative kind" appears on both sides of the pass and scaling
    // the wrong one still produces a plausible number -- here it would produce
    // `480001 * 300000`, which no reader would recognise as a millisecond
    // tolerance but which no assertion would have caught either.
    //
    // The arithmetic: `L = 2 x 300000 = 600000`, `P = 120000`, so `T` may be
    // `480000` and no more.
    const cp = cpFixture();
    const revision = addRevision(cp, {
      note: "an absolute T under a relative L",
      at: T0 + 1_000,
    });
    addDetectionLatency(cp, revision, "forward_stall", "absolute_ms", 480_000, {
      budgetMs: 2,
      budgetKind: "lease_ttl_multiple",
    });
    addLease(cp, "watcher_scope:scope-1", { ttlMs: 300_000 });

    expect(budgetViolations(cp, { revisionId: revision, nowMs: T0 })).toEqual([]);

    cp.prepare(
      "UPDATE policy_detection_latency SET threshold_value = 480001" +
        " WHERE revision_id = ? AND incident_class = 'forward_stall'",
    ).run(revision);
    const violation = onlyOne(budgetViolations(cp, { revisionId: revision, nowMs: T0 }));

    expect(violation.subjectKind).toBe("lease");
    expect(violation.subjectId).toBe("watcher_scope:scope-1");
    // T is untouched by the lease's TTL; only L is scaled by it.
    expect(violation.toleranceMs).toBe(480_001);
    expect(violation.budgetMs).toBe(600_000);
    expect(violation.excessMs).toBe(1);
  });

  test("a row whose two relative sides name different subjects is refused", () => {
    // T scaled by a scope's interval and L by some lease's TTL ties nothing to
    // anything.
    const cp = cpFixture();
    const revision = addRevision(cp, { note: "a defective row", at: T0 + 1_000 });
    addDetectionLatency(cp, revision, "incoherent", "scope_interval_multiple", 3, {
      budgetMs: 2,
      budgetKind: "lease_ttl_multiple",
    });

    expectRefusal(
      () => budgetViolations(cp, { revisionId: revision, nowMs: T0 + 1_000 }),
      PolicyRefusal,
    );
  });

  test("a fully absolute row is left to the ddl check", () => {
    // Nothing here re-evaluates what the CHECK already refused at insert time.
    const cp = cpFixture();
    const first = seedRevisionId(cp);
    addRepository(cp);
    addWatcherScope(cp, "scope-ok", { expectedIntervalMs: 60_000 });
    addLease(cp, "watcher_scope:scope-ok", { ttlMs: 300_000 });

    const violations = budgetViolations(cp, { revisionId: first, nowMs: T0 });
    const absoluteClasses = new Set(
      (
        cp
          .prepare(
            "SELECT incident_class FROM policy_detection_latency" +
              " WHERE revision_id = ? AND threshold_kind = 'absolute_ms'" +
              "   AND budget_kind = 'absolute_ms'",
          )
          .all(first) as { incident_class: string }[]
      ).map((row) => row.incident_class),
    );

    expect(absoluteClasses.size).toBeGreaterThan(0);
    const reported = new Set(violations.map((violation) => violation.incidentClass));
    expect([...absoluteClasses].filter((incidentClass) => reported.has(incidentClass))).toEqual([]);
  });
});
