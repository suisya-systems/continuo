/**
 * The seeded time base, value for value against `docs/time-base-policy.md`.
 *
 * Ported from interlock `tests/control_plane/test_policy_seed.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping is recorded in the
 * parity ledger.
 *
 * Every number in `0002_policy_seed.sql` is a *decision* -- `D-0031` for the
 * detection budgets and the reconcile period, `D-0032` for gate ownership --
 * and the whole point of holding them as policy rows rather than as constants
 * is that changing one is a deliberate, versioned act. That property is only
 * real if a silent drift fails something, so this file transcribes sections
 * 3.2, 3.3, 4 and 6.1 of the design document into tables and compares the
 * seeded rows against them exactly. A migration that quietly relaxed a
 * tolerance would otherwise be indistinguishable from one that fixed a typo.
 *
 * The tables below are therefore duplication **on purpose**. They are not
 * derived from the SQL, they are read from the design document, and the test is
 * the comparison between two independently written copies of the same decision.
 * A helper that generated the expectations from the migration would assert only
 * that SQLite can read back what it stored.
 *
 * The `describe` blocks are the source file's own comment banners, one per
 * section of the document: the revision itself, then 3.2 (the classes), 3.3 (P
 * as a consequence of the budgets), 4 (gate stage tolerances), 6.1 (ownership),
 * and finally the property that makes all of it versioned data rather than
 * merely data.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import { caseRoot, databasePath } from "../testkit/cases.js";
import { parametrize } from "../testkit/parametrize.js";

const T0 = 1_700_000_000_000;

const MINUTE_MS = 60_000;

/** docs/time-base-policy.md section 3.3: "The reconcile period P is 120 seconds." */
const RECONCILE_PERIOD_MS = 120 * 1000;

/**
 * Section 3.2's table, transcribed: incident class -> (threshold_kind, T, L,
 * budget_kind). The three relative classes carry a multiple or a count in T
 * rather than a duration, and `lease_orphan` carries a multiple in L too -- the
 * adjudicated `budget_kind` column (section 3.2, the lease_orphan row's
 * "2 x lease TTL") is what lets it say so instead of precomputing some assumed
 * TTL into milliseconds.
 */
const DETECTION_LATENCY = new Map<
  string,
  readonly [thresholdKind: string, t: number, l: number, budgetKind: string]
>([
  ["relay_gap", ["absolute_ms", 3 * MINUTE_MS, 5 * MINUTE_MS, "absolute_ms"]],
  ["relay_delivery_stall", ["absolute_ms", 2 * MINUTE_MS, 5 * MINUTE_MS, "absolute_ms"]],
  ["ci_outcome_undrained", ["absolute_ms", 3 * MINUTE_MS, 5 * MINUTE_MS, "absolute_ms"]],
  ["consumer_backlog", ["absolute_ms", 5 * MINUTE_MS, 10 * MINUTE_MS, "absolute_ms"]],
  ["watcher_silence", ["scope_interval_multiple", 3, 10 * MINUTE_MS, "absolute_ms"]],
  ["watcher_error_streak", ["consecutive_count", 5, 10 * MINUTE_MS, "absolute_ms"]],
  ["watcher_scope_uncovered", ["absolute_ms", 0, 10 * MINUTE_MS, "absolute_ms"]],
  ["session_no_evidence", ["absolute_ms", 10 * MINUTE_MS, 15 * MINUTE_MS, "absolute_ms"]],
  ["observation_unavailable", ["absolute_ms", 5 * MINUTE_MS, 10 * MINUTE_MS, "absolute_ms"]],
  // L = 2 x the lease's own TTL, so both sides of this row are multiples and
  // the DDL's T + P <= L CHECK deliberately does not reach it; the
  // policy_budget_violation pass asserts the inequality per subject instead.
  ["lease_orphan", ["lease_ttl_multiple", 1, 2, "lease_ttl_multiple"]],
]);

/**
 * Section 4. `null` is not "unset": it is how "never a gap" is expressed, so
 * that the relay-gap detector has no special case for the human stage.
 *
 * Written as (gate_type, stage, tolerance_ms) triples rather than as a map with
 * a tuple key, because JavaScript has no tuple keys and a stringified one would
 * make the comparison a comparison of the stringification. Sorted-triple
 * equality is what the source's dict equality means, and it is strictly
 * stronger: a duplicated (gate_type, stage) would collapse in a Python dict
 * comprehension and fails here.
 */
const GATE_STAGE_TOLERANCE: readonly (readonly [
  gateType: string,
  stage: string,
  toleranceMs: number | null,
])[] = [
  ["worker_escalation", "received", 3 * MINUTE_MS],
  ["worker_escalation", "presented", null],
  ["worker_escalation", "answered", 2 * MINUTE_MS],
  ["merge_approval", "received", 3 * MINUTE_MS],
  ["merge_approval", "presented", null],
  ["merge_approval", "answered", 2 * MINUTE_MS],
];

/**
 * Section 6.1: ball_holder is a function of (gate_type, stage) and is who a
 * relay_gap incident names; standing_owner is a function of gate_type alone.
 * worker_escalation stands with the Secretary (D-0016, the single human
 * window); merge_approval stands with the human, whose decision it is.
 */
const GATE_STAGE_OWNER: readonly (readonly [
  gateType: string,
  stage: string,
  ballHolder: string,
  standingOwner: string,
])[] = [
  ["worker_escalation", "received", "secretary", "secretary"],
  ["worker_escalation", "presented", "human", "secretary"],
  ["worker_escalation", "answered", "secretary", "secretary"],
  ["merge_approval", "received", "secretary", "human"],
  ["merge_approval", "presented", "human", "human"],
  ["merge_approval", "answered", "secretary", "human"],
];

// --------------------------------------------------------------------------
// fixtures -- a production control plane, per test
// --------------------------------------------------------------------------

/**
 * The source's `cp` fixture: a freshly migrated production database.
 *
 * A plain function called inside the test, per the conventions' scope rule --
 * the source fixture is function-scoped, and the close is registered at
 * acquisition so it unwinds before the temporary directory `caseRoot`
 * registered first. On Windows an open handle would otherwise keep a lock on
 * the file and the cleanup would fail describing the directory rather than the
 * connection nobody closed.
 *
 * The source also sets `row_factory = sqlite3.Row` to get name-addressable
 * rows; better-sqlite3 returns object rows already, so there is nothing to set.
 */
function cp(): SqliteDatabase {
  const root = caseRoot("policy-seed");
  const connection = createProductionControlPlane(databasePath(root), { nowMs: T0 });
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

/** The source's `revision_id` fixture: the one revision the seed inserts. */
function revisionIdOf(connection: SqliteDatabase): number {
  const rows = connection.prepare("SELECT revision_id FROM policy_revision").all() as {
    revision_id: number;
  }[];
  expect(rows.length, "the initial seed is exactly one revision").toBe(1);
  return rows[0]?.revision_id as number;
}

type LatencyRow = {
  incident_class: string;
  threshold_kind: string;
  threshold_value: number;
  reconcile_period_ms: number;
  budget_ms: number;
  budget_kind: string;
};

type ToleranceRow = { gate_type: string; stage: string; tolerance_ms: number | null };

type OwnerRow = { gate_type: string; stage: string; ball_holder: string; standing_owner: string };

/** Every row of `sql`, typed at the call site the way the source's Row access is. */
function query<T>(connection: SqliteDatabase, sql: string, ...params: unknown[]): T[] {
  return connection.prepare(sql).all(...(params as never[])) as T[];
}

/** `SELECT COUNT(*) ...` -- the source's `fetchone()[0]` on a counting query. */
function countOf(connection: SqliteDatabase, sql: string, ...params: unknown[]): number {
  return (connection.prepare(sql).get(...(params as never[])) as { n: number }).n;
}

/**
 * A total order over the transcribed tuples, so two dicts compare as arrays.
 *
 * Returns 0 for equal elements rather than falling through to 1. A comparator
 * that never answers 0 is inconsistent -- `cmp(a, b)` and `cmp(b, a)` both say
 * "greater" -- and `Array#sort` is only required to be well behaved given a
 * consistent one, so the order two equal rows come out in would be at the
 * engine's discretion. Both sides of every comparison here are sorted with
 * this same function, so an unstable answer would show up as a spurious
 * inequality between two lists that hold the same rows.
 */
function byTuple(left: readonly unknown[], right: readonly unknown[]): number {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

// --------------------------------------------------------------------------
// the revision itself
// --------------------------------------------------------------------------

describe("the revision itself", () => {
  test("the seed is one revision carrying the decisions that set it", () => {
    const connection = cp();
    const rows = query<{ decided_by: string; note: string }>(
      connection,
      "SELECT * FROM policy_revision",
    );
    expect(rows.length).toBe(1);
    const row = rows[0] as { decided_by: string; note: string };
    // D-0031 decided the budgets and the period, D-0032 the ownership; the
    // column exists so a report can say which decision it was judged under.
    expect(row.decided_by).toContain("D-0031");
    expect(row.decided_by).toContain("D-0032");
    expect(row.note.trim()).not.toBe("");
  });

  test("the first revision is effective from zero rather than from a wall clock", () => {
    // A migration that read a clock would produce a different effective_at_ms
    // on every database it was applied to, and the checksum discipline would
    // then be pinning bytes whose EFFECT still differed. Zero is also the
    // honest value: a detector binding "the revision effective at :now_ms"
    // finds this one for every :now_ms there is.
    const connection = cp();
    expect(
      (
        connection.prepare("SELECT effective_at_ms FROM policy_revision").get() as {
          effective_at_ms: number;
        }
      ).effective_at_ms,
    ).toBe(0);
  });

  test("every seeded row hangs off that one revision", () => {
    const connection = cp();
    const revisionId = revisionIdOf(connection);
    for (const table of [
      "policy_detection_latency",
      "policy_gate_stage_tolerance",
      "policy_gate_stage_owner",
    ]) {
      const others = countOf(
        connection,
        `SELECT COUNT(*) AS n FROM ${table} WHERE revision_id <> ?`,
        revisionId,
      );
      expect(others, table).toBe(0);
    }
  });
});

// --------------------------------------------------------------------------
// section 3.2 -- the classes
// --------------------------------------------------------------------------

describe("section 3.2 -- the classes", () => {
  test("exactly the classes of section 3 2 are seeded", () => {
    const connection = cp();
    const seeded = new Set(
      query<{ incident_class: string }>(
        connection,
        "SELECT incident_class FROM policy_detection_latency",
      ).map((row) => row.incident_class),
    );
    // Both directions: a missing class is a condition nothing ages, and an
    // extra one is a tolerance no document decided.
    expect(seeded).toEqual(new Set(DETECTION_LATENCY.keys()));
  });

  // The source parametrizes over `sorted(DETECTION_LATENCY)`, so the ids come
  // from the transcribed table rather than from a second hand-written list that
  // could drift from it.
  parametrize(
    "each detection latency row matches the document",
    [...DETECTION_LATENCY.keys()].sort().map((name) => [name, name] as const),
    (incidentClass) => {
      const connection = cp();
      const [expectedKind, expectedT, expectedL, expectedBudgetKind] = DETECTION_LATENCY.get(
        incidentClass,
      ) as readonly [string, number, number, string];
      const row = connection
        .prepare("SELECT * FROM policy_detection_latency WHERE incident_class = ?")
        .get(incidentClass) as LatencyRow | undefined;
      expect(row).not.toBeUndefined();
      const found = row as LatencyRow;
      expect(found.threshold_kind).toBe(expectedKind);
      expect(found.threshold_value).toBe(expectedT);
      expect(found.budget_ms).toBe(expectedL);
      expect(found.budget_kind).toBe(expectedBudgetKind);
    },
  );

  test("every class is evaluated on the base reconcile period", () => {
    // Section 3.3 permits a class with a large L - T to run on a multiple of P,
    // and none is moved here: a coarser period is a cost optimisation, there is
    // no measured pass cost yet to justify one, and choosing one anyway would be
    // deciding policy inside a migration.
    const connection = cp();
    const periods = new Map(
      query<{ incident_class: string; reconcile_period_ms: number }>(
        connection,
        "SELECT incident_class, reconcile_period_ms FROM policy_detection_latency",
      ).map((row) => [row.incident_class, row.reconcile_period_ms] as const),
    );
    expect(new Set(periods.values())).toEqual(new Set([RECONCILE_PERIOD_MS]));
  });
});

// --------------------------------------------------------------------------
// section 3.3 -- P is a consequence of the budgets, not a choice
// --------------------------------------------------------------------------

describe("section 3.3 -- P is a consequence of the budgets, not a choice", () => {
  test("the absolute classes satisfy t plus p le l", () => {
    // The derivation rule of section 3.1, checked against the seeded rows
    // rather than against the DDL's CHECK -- the CHECK proves no row can be
    // inserted that violates it, this proves the rows that WERE inserted are
    // the ones the document derived.
    const connection = cp();
    for (const row of query<LatencyRow>(connection, "SELECT * FROM policy_detection_latency")) {
      if (row.threshold_kind !== "absolute_ms" || row.budget_kind !== "absolute_ms") {
        continue;
      }
      expect(
        row.threshold_value + row.reconcile_period_ms <= row.budget_ms,
        row.incident_class,
      ).toBe(true);
    }
  });

  test("the reconcile period is the largest the tightest budget admits", () => {
    // P = min(L - T) over the absolute classes. If a future revision tightened
    // a budget without moving P, this fails -- which is the point: section 3.3
    // calls the period a consequence of the budgets rather than a choice, and a
    // consequence that no longer follows is a broken derivation.
    const connection = cp();
    const slack = query<LatencyRow>(connection, "SELECT * FROM policy_detection_latency")
      .filter((row) => row.threshold_kind === "absolute_ms" && row.budget_kind === "absolute_ms")
      .map((row) => row.budget_ms - row.threshold_value);
    expect(Math.min(...slack)).toBe(RECONCILE_PERIOD_MS);
  });

  test("the binding classes are the ones the document names", () => {
    // Section 3.3's L - T table: relay_gap and ci_outcome_undrained sit at
    // 2 min and are what P was derived FROM; they are the constraint, not a
    // near miss that a later edit may quietly widen away from.
    const connection = cp();
    const slack = new Map(
      query<LatencyRow>(connection, "SELECT * FROM policy_detection_latency")
        .filter((row) => row.threshold_kind === "absolute_ms" && row.budget_kind === "absolute_ms")
        .map((row) => [row.incident_class, row.budget_ms - row.threshold_value] as const),
    );
    expect(slack.get("relay_gap")).toBe(2 * MINUTE_MS);
    expect(slack.get("ci_outcome_undrained")).toBe(2 * MINUTE_MS);
    expect(slack.get("relay_delivery_stall")).toBe(3 * MINUTE_MS);
    expect(slack.get("watcher_scope_uncovered")).toBe(10 * MINUTE_MS);
    const binding = new Set(["relay_gap", "ci_outcome_undrained"]);
    for (const [incidentClass, value] of slack) {
      if (!binding.has(incidentClass)) {
        expect(value >= 3 * MINUTE_MS, incidentClass).toBe(true);
      }
    }
  });

  test("the relative classes are left relative", () => {
    // Precomputing a relative threshold into milliseconds bakes one scope's
    // interval, or one lease's TTL, into a row every other subject also reads.
    const connection = cp();
    const kinds = new Map(
      query<LatencyRow>(connection, "SELECT * FROM policy_detection_latency").map(
        (row) => [row.incident_class, [row.threshold_kind, row.budget_kind] as const] as const,
      ),
    );
    expect(kinds.get("watcher_silence")?.[0]).toBe("scope_interval_multiple");
    expect(kinds.get("watcher_error_streak")?.[0]).toBe("consecutive_count");
    expect(kinds.get("lease_orphan")).toEqual(["lease_ttl_multiple", "lease_ttl_multiple"]);
    // And exactly one class has a relative BUDGET, which is why budget_kind
    // defaults to 'absolute_ms': every other row reads as it did before the
    // column existed.
    const relativeBudgets = [...kinds]
      .filter(([, [, budget]]) => budget !== "absolute_ms")
      .map(([name]) => name);
    expect(relativeBudgets).toEqual(["lease_orphan"]);
  });

  test("the watcher silence budget bounds a scopes interval", () => {
    // Section 3.3 spells this consequence out: with L = 10 min, P = 120 s and
    // T = 3 x the scope's own interval, a scope registered slower than about
    // 160 s cannot be served inside its budget and is reported rather than
    // silently under-served. The arithmetic is asserted so the three numbers
    // cannot drift apart.
    const connection = cp();
    const row = connection
      .prepare("SELECT * FROM policy_detection_latency WHERE incident_class = 'watcher_silence'")
      .get() as LatencyRow;
    const boundMs = (row.budget_ms - row.reconcile_period_ms) / row.threshold_value;
    expect(boundMs).toBeGreaterThanOrEqual(159_000);
    expect(boundMs).toBeLessThanOrEqual(161_000);
  });
});

// --------------------------------------------------------------------------
// section 4 -- gate stage tolerances
// --------------------------------------------------------------------------

describe("section 4 -- gate stage tolerances", () => {
  test("exactly the stage tolerances of section 4 are seeded", () => {
    const connection = cp();
    const seeded = query<ToleranceRow>(connection, "SELECT * FROM policy_gate_stage_tolerance")
      .map((row) => [row.gate_type, row.stage, row.tolerance_ms] as const)
      .sort(byTuple);
    expect(seeded).toEqual([...GATE_STAGE_TOLERANCE].sort(byTuple));
  });

  test("the human stage is untimed because a slow human is not a gap", () => {
    // NULL is the mechanism, not a gap in the seed: the detector joins this
    // table and the row simply does not match. Expressing it as a very large
    // tolerance instead would make "never" a number someone could shrink.
    const connection = cp();
    for (const gateType of ["worker_escalation", "merge_approval"]) {
      const row = connection
        .prepare(
          "SELECT tolerance_ms FROM policy_gate_stage_tolerance " +
            "WHERE gate_type = ? AND stage = 'presented'",
        )
        .get(gateType) as { tolerance_ms: number | null } | undefined;
      expect(row, `${gateType} must opt out by value, not by absence`).not.toBeUndefined();
      // `null`, not `undefined`: a stored SQL NULL, on a key that is present
      // (D-0007). Absence would be the other bug entirely.
      expect((row as { tolerance_ms: number | null }).tolerance_ms).toBeNull();
    }
  });

  test("the answered leg carries the tightest tolerance in the system", () => {
    // This is the leg v1 actually dropped, and work is blocked on it: the
    // answer is durable and the worker does not have it.
    const connection = cp();
    const values = query<{ tolerance_ms: number | null }>(
      connection,
      "SELECT tolerance_ms FROM policy_gate_stage_tolerance",
    )
      .map((row) => row.tolerance_ms)
      .filter((value): value is number => value !== null);
    const answered = (
      connection
        .prepare(
          "SELECT tolerance_ms FROM policy_gate_stage_tolerance " +
            "WHERE gate_type = 'worker_escalation' AND stage = 'answered'",
        )
        .get() as { tolerance_ms: number }
    ).tolerance_ms;
    expect(answered).toBe(Math.min(...values));
    expect(Math.min(...values)).toBe(2 * MINUTE_MS);
  });

  test("the terminal stage has no tolerance row", () => {
    // forwarded is terminal, the gate is closed, and there is nothing left to
    // be late for; a row here would age a gate that has already finished.
    const connection = cp();
    expect(
      countOf(
        connection,
        "SELECT COUNT(*) AS n FROM policy_gate_stage_tolerance WHERE stage = 'forwarded'",
      ),
    ).toBe(0);
  });

  test("undecided gate types are not seeded", () => {
    // time-base-policy.md decides numbers for worker_escalation and
    // merge_approval only. Seeding a plan_approval tolerance would be a policy
    // decision taken in a migration file -- exactly what holding these values
    // as versioned data exists to prevent.
    const connection = cp();
    for (const table of ["policy_gate_stage_tolerance", "policy_gate_stage_owner"]) {
      const seeded = new Set(
        query<{ gate_type: string }>(connection, `SELECT gate_type FROM ${table}`).map(
          (row) => row.gate_type,
        ),
      );
      expect(seeded).toEqual(new Set(["worker_escalation", "merge_approval"]));
    }
  });
});

// --------------------------------------------------------------------------
// section 6.1 -- gate ownership, resolved
// --------------------------------------------------------------------------

describe("section 6.1 -- gate ownership, resolved", () => {
  test("exactly the owners of section 6 1 are seeded", () => {
    const connection = cp();
    const seeded = query<OwnerRow>(connection, "SELECT * FROM policy_gate_stage_owner")
      .map((row) => [row.gate_type, row.stage, row.ball_holder, row.standing_owner] as const)
      .sort(byTuple);
    expect(seeded).toEqual([...GATE_STAGE_OWNER].sort(byTuple));
  });

  test("the ball holder moves with the stage and the standing owner does not", () => {
    const connection = cp();
    for (const [gateType, expectedStanding] of [
      ["worker_escalation", "secretary"],
      ["merge_approval", "human"],
    ] as const) {
      const rows = query<OwnerRow>(
        connection,
        "SELECT * FROM policy_gate_stage_owner WHERE gate_type = ?",
        gateType,
      );
      // standing_owner is a function of gate_type alone: one value across
      // every stage, or it is not standing.
      expect(new Set(rows.map((row) => row.standing_owner))).toEqual(new Set([expectedStanding]));
      // ball_holder is a function of (gate_type, stage), and it must actually
      // vary -- if it did not, the distinction section 6.1 draws would be
      // decorative and a relay_gap incident could name the wrong role.
      expect(new Set(rows.map((row) => row.ball_holder)).size).toBeGreaterThan(1);
    }
  });

  test("ownership lives only in policy and never on the gate row", () => {
    // Neither field is a column on gate, which is what makes drift between the
    // stage and its owner unrepresentable rather than merely unlikely.
    const connection = cp();
    const columns = new Set(
      (connection.pragma("table_info(gate)") as { name: string }[]).map((row) => row.name),
    );
    expect(columns.has("ball_holder")).toBe(false);
    expect(columns.has("standing_owner")).toBe(false);
    expect(columns.has("owner")).toBe(false);
  });

  test("every stage that can hold a gate has a ball holder", () => {
    // Ownership covers exactly the stages at which a gate can still be waiting
    // on someone. forwarded is not one of them.
    const connection = cp();
    const staged = new Set(
      query<{ stage: string }>(
        connection,
        "SELECT DISTINCT stage FROM policy_gate_stage_owner",
      ).map((row) => row.stage),
    );
    expect(staged).toEqual(new Set(["received", "presented", "answered"]));
  });

  test("the terminal stage has no ball holder row", () => {
    // time-base-policy.md section 4 gives the forwarded cell as "--" on every
    // column, ball holder included: the gate is closed and no one holds the
    // ball. Naming one to satisfy the NOT NULL column would be policy decided
    // in a migration file, and the invented value is the one a report would
    // cite.
    const connection = cp();
    expect(
      countOf(
        connection,
        "SELECT COUNT(*) AS n FROM policy_gate_stage_owner WHERE stage = 'forwarded'",
      ),
    ).toBe(0);
  });

  test("the standing owner of both gate types survives the absent forwarded row", () => {
    // standing_owner is a function of gate_type alone, so dropping the terminal
    // stage costs no information: both types are still answerable from the
    // stages that remain.
    const connection = cp();
    const standing = new Map(
      query<{ gate_type: string; standing_owner: string }>(
        connection,
        "SELECT DISTINCT gate_type, standing_owner FROM policy_gate_stage_owner",
      ).map((row) => [row.gate_type, row.standing_owner] as const),
    );
    expect(standing).toEqual(
      new Map([
        ["worker_escalation", "secretary"],
        ["merge_approval", "human"],
      ]),
    );
  });

  test("no stage carries a tolerance without a ball holder to name", () => {
    // The relay-gap detector matches through the tolerance table and then names
    // the stage's ball holder, so a stage with a tolerance and no owner row
    // would raise an incident it cannot attribute. Holding the two tables to the
    // same stage set is what keeps the closed gate out of the detector entirely.
    const connection = cp();
    const timed = query<{ gate_type: string; stage: string }>(
      connection,
      "SELECT gate_type, stage FROM policy_gate_stage_tolerance WHERE tolerance_ms IS NOT NULL",
    ).map((row) => [row.gate_type, row.stage] as const);
    const owned = query<{ gate_type: string; stage: string }>(
      connection,
      "SELECT gate_type, stage FROM policy_gate_stage_owner",
    ).map((row) => [row.gate_type, row.stage] as const);
    const ownedKeys = new Set(owned.map((pair) => JSON.stringify(pair)));
    // `timed <= owned`, as a subset check over the pairs.
    for (const pair of timed) {
      expect(ownedKeys.has(JSON.stringify(pair)), JSON.stringify(pair)).toBe(true);
    }
    expect([...timed, ...owned].some(([, stage]) => stage === "forwarded")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// the seed is data, and it is versioned data
// --------------------------------------------------------------------------

describe("the seed is data, and it is versioned data", () => {
  parametrize(
    "a second revision supersedes by insertion rather than by update",
    [
      ["policy_detection_latency", "policy_detection_latency"],
      ["policy_gate_stage_tolerance", "policy_gate_stage_tolerance"],
      ["policy_gate_stage_owner", "policy_gate_stage_owner"],
    ] as const,
    (table) => {
      // Changing a tolerance is a new policy_revision and a fresh set of rows, so
      // a report written last month can still be recomputed under the tolerances
      // it was actually judged by. The revision is part of every primary key,
      // which is what makes the old rows survivable rather than merely
      // conventionally preserved.
      const connection = cp();
      const revisionId = revisionIdOf(connection);
      connection
        .prepare("INSERT INTO policy_revision (note, decided_by, effective_at_ms) VALUES (?, ?, ?)")
        .run("a later revision", "D-9999", T0);
      const later = (
        connection.prepare("SELECT MAX(revision_id) AS v FROM policy_revision").get() as {
          v: number;
        }
      ).v;
      expect(later).not.toBe(revisionId);

      const original = countOf(
        connection,
        `SELECT COUNT(*) AS n FROM ${table} WHERE revision_id = ?`,
        revisionId,
      );
      const columns = (connection.pragma(`table_info(${table})`) as { name: string }[])
        .map((column) => column.name)
        .filter((name) => name !== "revision_id");
      connection
        .prepare(
          `INSERT INTO ${table} SELECT ? AS revision_id, ${columns.join(", ")} ` +
            `FROM ${table} WHERE revision_id = ?`,
        )
        .run(later, revisionId);

      expect(
        countOf(connection, `SELECT COUNT(*) AS n FROM ${table} WHERE revision_id = ?`, revisionId),
      ).toBe(original);
    },
  );
});
