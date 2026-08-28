/**
 * The item 10 rehearsal, end to end -- Issue #23's acceptance criteria as one
 * scenario.
 *
 * Ported from interlock `tests/canary/test_rehearsal.py` at `65f36c5`. The file
 * holds one source node id and one target case; the mapping is recorded in the
 * belt's parity ledger.
 *
 * A REHEARSAL AGAINST A SYNTHETIC COUNTERPARTY (D-0022), and the file says so
 * because the *output* of this scenario is the rehearsal's evidence. It is not
 * a discharge: item 10 is discharged at the canary itself, with live v1 as the
 * counterparty, under numeric criteria Q-0005 leaves open -- none appear below,
 * and none of the timestamps or counts here is a go/no-go threshold.
 *
 * The scenario is the canary shape (D-0013) played against the stand-in, with
 * the review-required minimum of three runs, so that "one worker at a time on
 * Interlock" and "exactly one new run routed to Interlock in total" are
 * separate assertions:
 *
 *     run-v1-before  starts under the baseline decision   -> synthetic_v1
 *     run-canary     starts under the canary decision     -> interlock
 *     run-v1-after   starts after the rehearsed rollback  -> synthetic_v1
 *
 * with run-v1-before finishing on the synthetic side mid-canary (v1-started
 * runs finish on v1), a writer audit over both stores before and after the
 * rollback, and the rollback itself asserted to have changed only the routing
 * decision.
 *
 * Three runtime differences run through the case and are noted once here rather
 * than at every call site:
 *
 * - **`with interlock:` becomes `interlock.transaction(...)()`.** Python's
 *   `sqlite3` connection context manager commits on success and rolls back on
 *   an exception; better-sqlite3 is in autocommit, so the source's one implicit
 *   transaction is spelled out where it had it and nowhere else.
 * - **A Python tuple is a JavaScript array.** `mid.dual_written == ()` becomes
 *   `toEqual([])`, and `final.synthetic_v1_written == ("run-v1-after",
 *   "run-v1-before")` becomes an array in that same order -- which is sorted,
 *   not chronological, and the ported assertion keeps the source's order
 *   because the source's comparison is positional.
 * - **`dict(connection.execute(...))` becomes `Object.fromEntries`.** Python
 *   builds a mapping out of two-column rows and compares two dicts, which is
 *   order-insensitive; `toEqual` over two plain objects is the same question.
 */

import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

// Through the barrel, not the modules behind it: `tests/canary/test_rehearsal.py`
// imports every canary name from the package, and the rehearsal is the one case
// that plays the whole layer the way a caller would. Reaching past the barrel
// here would leave the surface a caller actually has untested by this file.
import {
  compareAcrossRollback,
  createRoutingLedger,
  INTERLOCK,
  REHEARSAL_MARKING,
  RunStartRoutingPoint,
  SYNTHETIC_V1,
  SyntheticV1RunStore,
  snapshotStores,
  writerAudit,
} from "../../src/canary/index.js";
import { createControlPlane } from "../../src/control_plane/schema.js";
import { caseRoot } from "../testkit/cases.js";

/** An arbitrary fixed epoch-milliseconds instant -- the source's `T0`. */
const T0 = 1_700_000_000_000;

/**
 * The source's `stores` fixture: a routing ledger, a control plane standing in
 * for Interlock, and the synthetic counterparty's store, all under one
 * `tmp_path`.
 *
 * The source's `finally` closes the control plane and then the ledger. Cleanup
 * is registered at acquisition here (rule 1) and Vitest unwinds those callbacks
 * LIFO, so registering the ledger first and the control plane second gives the
 * source's close order exactly.
 *
 * The label is `cnry-rhs` (D-0020): short, and sharing no word with anything
 * this file asserts about a message.
 */
function stores(): {
  readonly ledger: SqliteDatabase;
  readonly interlock: SqliteDatabase;
  readonly synthetic: SyntheticV1RunStore;
} {
  const root = caseRoot("cnry-rhs");
  const ledger = closeAfterTest(createRoutingLedger(join(root, "routing-ledger.sqlite3")));
  const interlock = closeAfterTest(createControlPlane(join(root, "control-plane.sqlite3")));
  const synthetic = SyntheticV1RunStore.create(join(root, "synthetic-v1-runs.jsonl"));
  return { ledger, interlock, synthetic };
}

/** Close a connection when the test finishes, whatever the test does with it. */
function closeAfterTest(connection: SqliteDatabase): SqliteDatabase {
  onTestFinished(() => {
    try {
      connection.close();
    } catch {
      // Already closed by the test. Closing twice is not an error worth failing
      // a passing test over.
    }
  });
  return connection;
}

/**
 * The rehearsal's run-start path: consult the routing point first, then take
 * the answer to the owning system's own start -- the routing point itself
 * starts nothing and knows neither store.
 *
 * The source's helper, argument for argument. The interlock branch's INSERT
 * names the control plane's `run` table's four columns and no others, which is
 * exactly what continuo's ported `run` table has.
 */
function startRun(
  routing: RunStartRoutingPoint,
  interlock: SqliteDatabase,
  synthetic: SyntheticV1RunStore,
  runId: string,
  at: number,
): string {
  const routed = routing.routeRunStart(runId, { nowMs: at });
  if (routed.owningSystem === INTERLOCK) {
    interlock.transaction(() => {
      interlock
        .prepare(
          "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) " +
            "VALUES (?, 'running', ?, ?)",
        )
        .run(runId, at, at);
    })();
  } else {
    synthetic.startRun(runId, { nowMs: at });
  }
  return routed.owningSystem;
}

describe("the item 10 rehearsal, end to end", () => {
  test("the rehearsed canary and rollback", () => {
    const { ledger, interlock, synthetic } = stores();
    const routing = new RunStartRoutingPoint(ledger);

    // Baseline: new runs belong to the (synthetic) old system, as a recorded
    // decision rather than an assumption.
    routing.routeNewRunsTo(SYNTHETIC_V1, {
      nowMs: T0,
      reason: "baseline: v1 stand-in owns new runs",
    });
    expect(startRun(routing, interlock, synthetic, "run-v1-before", T0 + 1)).toBe(SYNTHETIC_V1);

    // The canary decision, and under it exactly one new run.
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0 + 2, reason: "canary: one worker on interlock" });
    expect(startRun(routing, interlock, synthetic, "run-canary", T0 + 3)).toBe(INTERLOCK);

    // A v1-started run finishes on v1, mid-canary, owner untouched.
    synthetic.finishRun("run-v1-before", { nowMs: T0 + 4 });
    expect(routing.routedRun("run-v1-before").owningSystem).toBe(SYNTHETIC_V1);

    // Writer audit over both stores: no record written by both systems.
    const mid = writerAudit(ledger, interlock, synthetic);
    // Both, separately: `dualWritten` is the acceptance criterion and `clean` is
    // the reading aid, so neither stands in for the other.
    expect(mid.dualWritten).toEqual([]);
    expect(mid.clean).toBe(true);

    // The rehearsed rollback: one routing decision, nothing else. The stores
    // are canonically byte-identical across it except for the routing rows.
    const before = snapshotStores(ledger, interlock, synthetic);
    const rollback = routing.routeNewRunsTo(SYNTHETIC_V1, {
      nowMs: T0 + 5,
      reason: "rollback: routing decision only",
    });
    const after = snapshotStores(ledger, interlock, synthetic);
    const comparison = compareAcrossRollback(before, after);
    expect(comparison.onlyTheRoutingDecisionChanged).toBe(true);
    // The second half of the pair: `onlyTheRoutingDecisionChanged` is vacuously
    // true for two identical snapshots, so the appended row is named exactly --
    // one positional 4-tuple in the routing_decision column order.
    expect(comparison.appendedDecisions).toEqual([
      [rollback.decisionSeq, SYNTHETIC_V1, T0 + 5, "rollback: routing decision only"],
    ]);

    // Subsequent new runs go back to the stand-in.
    expect(startRun(routing, interlock, synthetic, "run-v1-after", T0 + 6)).toBe(SYNTHETIC_V1);

    // Exactly one new run was routed to Interlock, in total, and no run
    // changed owner at any point in the scenario.
    const ownerRows = ledger.prepare("SELECT run_id, owning_system FROM run_owner").raw().all() as [
      string,
      string,
    ][];
    const owners = Object.fromEntries(ownerRows);
    expect(owners).toEqual({
      "run-v1-before": SYNTHETIC_V1,
      "run-canary": INTERLOCK,
      "run-v1-after": SYNTHETIC_V1,
    });
    expect(Object.values(owners).filter((system) => system === INTERLOCK).length).toBe(1);

    // The Interlock-started run is still running on Interlock. What a real
    // rollback does with such runs is Q-0005's open question; the rehearsal
    // shows only that the rollback itself did not touch it.
    const final = writerAudit(ledger, interlock, synthetic);
    expect(final.clean).toBe(true);
    expect(final.interlockWritten).toEqual(["run-canary"]);
    // Sorted, not chronological: 'run-v1-after' precedes 'run-v1-before'.
    expect(final.syntheticV1Written).toEqual(["run-v1-after", "run-v1-before"]);

    // The output is labelled: a rehearsal against a synthetic counterparty,
    // naming the canary as its discharge point.
    for (const output of [mid, final, comparison]) {
      expect(output.label).toBe(REHEARSAL_MARKING);
    }
    expect(REHEARSAL_MARKING).toContain("SYNTHETIC COUNTERPARTY");
    expect(REHEARSAL_MARKING).toContain("NOT A DISCHARGE");
    expect(REHEARSAL_MARKING).toContain("AT THE CANARY ITSELF");
    expect(REHEARSAL_MARKING).toContain("Q-0005 REMAINS OPEN");
  });
});
