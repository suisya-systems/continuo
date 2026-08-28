/**
 * The run-start routing point's contract.
 *
 * Ported from interlock `tests/canary/test_routing.py` at `65f36c5`. Every case
 * here maps to one source node id; the mapping, and the target-only cases that
 * occupy no source slot, are recorded in the belt's parity ledger.
 *
 * Durable half (D-0026): whatever routes runs at the real canary still has to
 * refuse to assume an owner nobody decided, keep a started run's owner across
 * every later policy flip, and make rollback a single appended decision.
 *
 * Two runtime differences run through the file and are noted once here rather
 * than at each call site:
 *
 * - **`sqlite3.IntegrityError` becomes a result code.** better-sqlite3 raises
 *   one error type for everything, so the two `pytest.raises(sqlite3.IntegrityError)`
 *   cases are `expectSqliteError(..., { code: CONSTRAINT })` -- the whole
 *   `SQLITE_CONSTRAINT` family, because that is the width of the Python class
 *   (D-0016). Neither source case carries a `match=`, so none is added: naming
 *   the constraint that fires would assert more than the source does (rule 0).
 * - **Every connection under test comes from `createRoutingLedger`.** The
 *   routing point sets no pragmas of its own; it inherits
 *   `configureLedgerConnection`'s, `recursive_triggers = ON` included. A case
 *   that opened a raw handle would be exercising a different store.
 */

import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { createRoutingLedger, INTERLOCK, SYNTHETIC_V1 } from "../../src/canary/ledger.js";
import {
  NoRoutingDecision,
  OwnerChangeRefused,
  RunStartRoutingPoint,
  UnknownOwningSystem,
  UnroutedRun,
} from "../../src/canary/routing.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal, expectSqliteError } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant -- the source's `T0`. */
const T0 = 1_700_000_000_000;

/**
 * Every `pytest.raises(sqlite3.IntegrityError)` in this file, as a result code.
 *
 * Deliberately the whole family and not one member: a `CHECK` arrives as
 * `SQLITE_CONSTRAINT_CHECK` and a duplicate run id as
 * `SQLITE_CONSTRAINT_PRIMARYKEY`, and `sqlite3.IntegrityError` covers both
 * without distinguishing them (D-0016).
 */
const CONSTRAINT = /^SQLITE_CONSTRAINT/;

/**
 * The source's `ledger` and `routing` fixtures, as one call (function scope).
 *
 * The label is `cnry-rtg` and not something readable like `owner-change-refused`
 * (D-0020): `caseRoot(label)` puts the label into the temp path, refusals
 * interpolate paths nowhere in *this* module -- but the convention is a
 * whole-belt one and a nickname costs nothing.
 */
function routingFixture(): { ledger: SqliteDatabase; routing: RunStartRoutingPoint } {
  const path = join(caseRoot("cnry-rtg"), "routing-ledger.sqlite3");
  const ledger = createRoutingLedger(path);
  onTestFinished(() => {
    try {
      ledger.close();
    } catch {
      // Already closed by the test. Closing twice is not an error worth failing
      // a passing test over.
    }
  });
  return { ledger, routing: new RunStartRoutingPoint(ledger) };
}

/** Every `run_owner` row, as objects -- the source's `SELECT * FROM run_owner`. */
function runOwnerRows(ledger: SqliteDatabase): Record<string, unknown>[] {
  return ledger.prepare("SELECT * FROM run_owner").all() as Record<string, unknown>[];
}

describe("the run-start routing point's contract", () => {
  test("no owner is assumed before a decision exists", () => {
    const { routing } = routingFixture();

    expectRefusal(() => routing.currentDecision(), NoRoutingDecision);
    expectRefusal(() => routing.routeRunStart("run-1", { nowMs: T0 }), NoRoutingDecision);
  });

  test("the baseline is itself a recorded decision", () => {
    const { routing } = routingFixture();

    const decision = routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0, reason: "baseline" });

    expect(decision.decisionSeq).toBe(1);
    // The source's `==` on a frozen dataclass is structural equality over all
    // four fields. This comparison is also what pins the `Number(...)` on
    // `lastInsertRowid`: the left side is assembled from arguments and a
    // `lastInsertRowid` that stayed a bigint would not equal the number the
    // SELECT on the right reads back.
    expect(routing.currentDecision()).toEqual(decision);
  });

  test("the vocabulary is closed at the api too", () => {
    const { routing } = routingFixture();

    expectRefusal(
      () =>
        routing.routeNewRunsTo("v1", {
          nowMs: T0,
          reason: "the live system is not in this rehearsal",
        }),
      UnknownOwningSystem,
    );
  });

  test("a run is routed under the newest decision", () => {
    const { routing } = routingFixture();
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0, reason: "baseline" });
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0 + 1, reason: "canary" });

    const routed = routing.routeRunStart("run-1", { nowMs: T0 + 2 });

    expect(routed.owningSystem).toBe(INTERLOCK);
    expect(routed.decisionSeq).toBe(2);
  });

  test("a policy flip does not move a started run", () => {
    const { routing } = routingFixture();
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0, reason: "baseline" });
    const routed = routing.routeRunStart("run-1", { nowMs: T0 + 1 });

    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0 + 2, reason: "canary" });

    expect(routing.routedRun("run-1")).toEqual(routed);
  });

  test("re routing to the same owner is an idempotent no op", () => {
    // A router that crashed between the ledger write and the system-specific
    // start may retry; the retry must not become a second row or a new time.
    const { routing } = routingFixture();
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0, reason: "baseline" });

    const first = routing.routeRunStart("run-1", { nowMs: T0 + 1 });
    const again = routing.routeRunStart("run-1", { nowMs: T0 + 99 });

    expect(again).toEqual(first);
  });

  test("re routing under a flipped policy is an owner change and refused", () => {
    const { routing } = routingFixture();
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0, reason: "baseline" });
    routing.routeRunStart("run-1", { nowMs: T0 + 1 });
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0 + 2, reason: "canary" });

    expectRefusal(
      () => routing.routeRunStart("run-1", { nowMs: T0 + 3 }),
      OwnerChangeRefused,
      /mid-flight/,
    );

    // The refusal left the ledger row exactly as it was.
    expect(routing.routedRun("run-1").owningSystem).toBe(SYNTHETIC_V1);
  });

  test("a non ownership integrity failure passes through as itself", () => {
    // An empty run_id fails the DDL CHECK, which is not an ownership question:
    // it must surface as the database's own refusal -- not as an idempotent
    // retry, not as an owner change -- and write nothing.
    const { ledger, routing } = routingFixture();
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0, reason: "baseline" });

    expectSqliteError(() => routing.routeRunStart("", { nowMs: T0 + 1 }), { code: CONSTRAINT });

    expect(ledger.prepare("SELECT COUNT(*) FROM run_owner").pluck().get()).toBe(0);
  });

  test("an idempotent retry does not absorb a validation failure", () => {
    // A retry of an already-routed run that itself fails a CHECK (a string
    // timestamp, say) is a broken write, not a duplicate: it must surface as the
    // database's refusal rather than be read as "already done".
    const { routing } = routingFixture();
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0, reason: "baseline" });
    routing.routeRunStart("run-1", { nowMs: T0 + 1 });

    expectSqliteError(
      // The source's `# type: ignore[arg-type]`, in TypeScript. `nowMs` is
      // declared `number` here as it is `int` there, so the string this case
      // exists to send has to be pushed past the type in both languages.
      () => routing.routeRunStart("run-1", { nowMs: "later" as unknown as number }),
      { code: CONSTRAINT },
    );
  });

  test("a run never routed reads as such", () => {
    const { routing } = routingFixture();

    expectRefusal(() => routing.routedRun("run-never"), UnroutedRun);
  });

  test("rollback is route new runs to and nothing else", () => {
    // The rollback's whole footprint: one appended routing_decision row.
    const { ledger, routing } = routingFixture();
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0, reason: "baseline" });
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0 + 1, reason: "canary" });
    routing.routeRunStart("run-1", { nowMs: T0 + 2 });

    const rowsBefore = runOwnerRows(ledger);
    const rollback = routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0 + 3, reason: "rollback" });

    expect(rollback.decisionSeq).toBe(3);
    expect(runOwnerRows(ledger)).toEqual(rowsBefore);

    // And a run starting after the rollback falls under it.
    expect(routing.routeRunStart("run-2", { nowMs: T0 + 4 }).owningSystem).toBe(SYNTHETIC_V1);
  });
});

// --------------------------------------------------------------------------
// target-only: the classification the source does by message text
// --------------------------------------------------------------------------

/**
 * Three properties the port's own machinery carries and the source's suite has
 * no warrant for (rule 11). None of them occupies a ported case's slot.
 *
 * The first is D-0402 itself. The source classifies the already-routed conflict
 * by substring-matching `"UNIQUE constraint failed: run_owner.run_id"`; the port
 * classifies by result code, and the two ported cases that would notice an
 * over-broad classification (`a non ownership integrity failure ...` and `an
 * idempotent retry does not absorb ...`) cannot notice a *too narrow* one --
 * they only ever exercise `CHECK`. If the accepted set lost
 * `SQLITE_CONSTRAINT_PRIMARYKEY`, the idempotent-retry case would go red, but
 * nothing would say *why*, and the reason is the whole point: the code and the
 * message disagree on this DDL.
 */
describe("classification by result code, not message text (target-only)", () => {
  test("target-only -- the duplicate run conflict carries a primary key code under a unique message", () => {
    const { ledger, routing } = routingFixture();
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0, reason: "baseline" });
    routing.routeRunStart("run-1", { nowMs: T0 + 1 });

    // The same statement `routeRunStart` runs, issued directly so the raw error
    // is observable rather than absorbed by the idempotency path.
    const error = expectSqliteError(
      () =>
        ledger
          .prepare(
            "INSERT INTO run_owner (run_id, owning_system, decision_seq, routed_at_ms) " +
              "SELECT :run_id, owning_system, decision_seq, :now_ms " +
              "  FROM routing_decision ORDER BY decision_seq DESC LIMIT 1",
          )
          .run({ run_id: "run-1", now_ms: T0 + 2 }),
      { code: "SQLITE_CONSTRAINT_PRIMARYKEY" },
    );

    // The disagreement, pinned: the message says UNIQUE, the code says PRIMARY
    // KEY. A port that matched the source's substring would work by accident and
    // stop working when SQLite reworded it; a port that accepted only
    // `SQLITE_CONSTRAINT_UNIQUE` would never reach the idempotency path at all.
    expect(error.message).toContain("UNIQUE constraint failed: run_owner.run_id");
  });

  test("target-only -- a retry under a later decision naming the same owner returns the original row", () => {
    // The source's docstring says `decision_seq` is not compared, and its
    // idempotency case never flips the policy in between, so nothing in the
    // source's suite distinguishes "compares owning_system" from "compares the
    // whole row". This does.
    const { routing } = routingFixture();
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0, reason: "baseline" });
    const first = routing.routeRunStart("run-1", { nowMs: T0 + 1 });
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0 + 2, reason: "re-affirmed" });

    const again = routing.routeRunStart("run-1", { nowMs: T0 + 99 });

    expect(again).toEqual(first);
    expect(again.decisionSeq).toBe(1);
    expect(again.routedAtMs).toBe(T0 + 1);
  });

  test("target-only -- an unknown owning system is refused before anything is written", () => {
    // The source asserts only that the refusal is raised; "nothing was written"
    // is `RoutingRefused`'s documented contract and the reason the membership
    // test precedes the transaction, so it is pinned beside the faithful case
    // rather than folded into it.
    const { ledger, routing } = routingFixture();

    expectRefusal(
      () => routing.routeNewRunsTo("v2", { nowMs: T0, reason: "a third system" }),
      UnknownOwningSystem,
    );

    expect(ledger.prepare("SELECT COUNT(*) FROM routing_decision").pluck().get()).toBe(0);
  });
});
