/**
 * The writer audit and the rollback comparison.
 *
 * Ported from interlock `tests/canary/test_audit.py` at `65f36c5`. Every case
 * here maps to one source node id; the mapping, and the target-only cases that
 * occupy no source slot, are recorded in the belt's parity ledger.
 *
 * Durable half (D-0026). The audit's construction is what these tests hold on
 * to: attribution is physical presence in a store, the enumeration reads the
 * stores themselves rather than the ledger's opinion of them, and the
 * byte-identity claim is over a canonical serialisation whose stability is
 * itself asserted -- a comparison that must be forgiven false alarms is not
 * evidence, and one that cannot see a real difference is worse.
 *
 * The `describe` blocks are the source file's own comment banners, in the
 * source's order. A banner is half of a target id, so they are carried across
 * verbatim rather than reworded.
 *
 * Three runtime differences run through the whole file and are noted once here
 * rather than at every call site:
 *
 * - **`with connection:` becomes `connection.transaction(...)()`.** Python's
 *   `sqlite3` connection context manager commits on success and rolls back on
 *   an exception; better-sqlite3 is in autocommit, so the source's implicit
 *   transactions are spelled out where it had them and nowhere else. The two
 *   statements the source runs *without* a `with` block (the `DROP TRIGGER` and
 *   the `PRAGMA user_version = 999`) are run bare here for the same reason: the
 *   point of both is that the digest read afterwards on the **same connection**
 *   sees them.
 * - **`bytes` equality is a `Buffer` comparison.** `canonicalSqliteBytes`
 *   returns a `Buffer`, and `===` on two of them is identity, so every
 *   `assert x == y` over bytes is `expect(x.equals(y))` -- never `toEqual` on
 *   the two buffers, which would compare them as byte-indexed objects and
 *   report a diff nobody can read.
 * - **A Python tuple is a JavaScript array.** `report.dual_written == ()`
 *   becomes `toEqual([])`, and a tuple *of* tuples becomes an array of arrays;
 *   these are ordered sequences on both sides, not sets, and the ported cases
 *   compare them positionally because the source does.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  canonicalSqliteBytes,
  compareAcrossRollback,
  type StoreSnapshot,
  snapshotStores,
  sqliteRunIds,
  writerAudit,
} from "../../src/canary/audit.js";
import { createRoutingLedger, INTERLOCK, SYNTHETIC_V1 } from "../../src/canary/ledger.js";
import { REHEARSAL_MARKING } from "../../src/canary/marking.js";
import { RunStartRoutingPoint } from "../../src/canary/routing.js";
import { SyntheticV1RunStore } from "../../src/canary/synthetic_v1.js";
import { createControlPlane } from "../../src/control_plane/schema.js";
import { caseRoot } from "../testkit/cases.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

/**
 * The source's four fixtures, built together.
 *
 * pytest composes them one request at a time and each case names only the ones
 * it uses; a single call is the closest honest spelling, because the source's
 * `routing` fixture is built over the `ledger` fixture's live connection and
 * three of the four share one `tmp_path`. A case that the source gives fewer
 * fixtures still gets all four here -- the extra ones are an empty ledger, an
 * empty control plane and an empty JSON-lines file, none of which any assertion
 * can see.
 *
 * The label is `cnry-adt` (D-0020): short, and sharing no word with anything
 * this file asserts about a message.
 */
function fixtures(): {
  readonly ledger: SqliteDatabase;
  readonly interlock: SqliteDatabase;
  readonly synthetic: SyntheticV1RunStore;
  readonly routing: RunStartRoutingPoint;
} {
  const root = caseRoot("cnry-adt");
  const ledger = closeAfterTest(createRoutingLedger(join(root, "routing-ledger.sqlite3")));
  const interlock = closeAfterTest(createControlPlane(join(root, "control-plane.sqlite3")));
  const synthetic = SyntheticV1RunStore.create(join(root, "synthetic-v1-runs.jsonl"));
  return { ledger, interlock, synthetic, routing: new RunStartRoutingPoint(ledger) };
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
 * The source's `start_on_interlock` helper: the run row that *is* the interlock
 * store's evidence of a write.
 *
 * `at` defaults to `T0`, as the source's does; two cases pass `T0 + 3`
 * explicitly and the difference is visible in the canonical bytes, so the
 * default is reproduced rather than inlined.
 */
function startOnInterlock(interlock: SqliteDatabase, runId: string, at: number = T0): void {
  interlock.transaction(() => {
    interlock
      .prepare("INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)")
      .run(runId, "running", at, at);
  })();
}

// --------------------------------------------------------------------------
// the writer audit
// --------------------------------------------------------------------------

describe("the writer audit", () => {
  test("a clean split audits clean and the report is labelled", () => {
    const { ledger, interlock, synthetic, routing } = fixtures();
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0, reason: "baseline" });
    routing.routeRunStart("run-a", { nowMs: T0 + 1 });
    synthetic.startRun("run-a", { nowMs: T0 + 1 });
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0 + 2, reason: "canary" });
    routing.routeRunStart("run-b", { nowMs: T0 + 3 });
    startOnInterlock(interlock, "run-b", T0 + 3);

    const report = writerAudit(ledger, interlock, synthetic);
    expect(report.dualWritten).toEqual([]);
    expect(report.unledgered).toEqual([]);
    expect(report.misrouted).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.interlockWritten).toEqual(["run-b"]);
    expect(report.syntheticV1Written).toEqual(["run-a"]);
    // The label is part of the report's contract, not decoration: the *output*
    // is what carries the rehearsal marking, so it is compared verbatim rather
    // than searched for.
    expect(report.label).toBe(REHEARSAL_MARKING);
  });

  test("a record written by both systems is named", () => {
    const { ledger, interlock, synthetic, routing } = fixtures();
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0, reason: "canary" });
    routing.routeRunStart("run-dual", { nowMs: T0 + 1 });
    startOnInterlock(interlock, "run-dual");
    synthetic.startRun("run-dual", { nowMs: T0 + 2 }); // the dual write

    const report = writerAudit(ledger, interlock, synthetic);
    expect(report.dualWritten).toEqual(["run-dual"]);
    expect(report.clean).toBe(false);
    // The synthetic-side copy also contradicts the ledger, and the report says
    // so rather than folding it into the dual-write count.
    //
    // Python's `in` over a tuple of tuples is structural containment;
    // `Array#includes` is identity, so the membership test is spelled with
    // `toContainEqual`. It is containment and not equality of the whole list on
    // purpose: the source asserts nothing either way about the interlock-side
    // half of the same dual write.
    expect(report.misrouted).toContainEqual([SYNTHETIC_V1, "run-dual"]);
  });

  test("a write that bypassed the routing point is named", () => {
    // No routing decision is ever taken here -- the source's case asks for no
    // `routing` fixture at all -- so the audit runs against a completely empty
    // ledger and must not go looking for a current route.
    const { ledger, interlock, synthetic } = fixtures();
    startOnInterlock(interlock, "run-rogue");

    const report = writerAudit(ledger, interlock, synthetic);
    expect(report.unledgered).toEqual([[INTERLOCK, "run-rogue"]]);
    expect(report.clean).toBe(false);
  });

  test("a run in the wrong store is named", () => {
    const { ledger, interlock, synthetic, routing } = fixtures();
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0, reason: "canary" });
    routing.routeRunStart("run-b", { nowMs: T0 + 1 });
    synthetic.startRun("run-b", { nowMs: T0 + 2 }); // ledger says interlock

    const report = writerAudit(ledger, interlock, synthetic);
    expect(report.misrouted).toEqual([[SYNTHETIC_V1, "run-b"]]);
    expect(report.clean).toBe(false);
  });

  test("the audit reads the stores not the ledger", () => {
    // A ledger row with no store record is not a write; the audit does not
    // invent one from the ledger's opinion.
    const { ledger, interlock, synthetic, routing } = fixtures();
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0, reason: "canary" });
    routing.routeRunStart("run-ledger-only", { nowMs: T0 + 1 });

    const report = writerAudit(ledger, interlock, synthetic);
    expect(report.interlockWritten).toEqual([]);
    expect(report.syntheticV1Written).toEqual([]);
    expect(report.clean).toBe(true);
  });
});

// --------------------------------------------------------------------------
// canonical serialisation: stable where it must be, sensitive where it must be
// --------------------------------------------------------------------------

describe("canonical serialisation: stable where it must be, sensitive where it must be", () => {
  test("insertion order does not move the canonical bytes", () => {
    const root = caseRoot("cnry-adt");
    const a = closeAfterTest(createControlPlane(join(root, "a.sqlite3")));
    const b = closeAfterTest(createControlPlane(join(root, "b.sqlite3")));
    for (const [connection, order] of [
      [a, ["run-1", "run-2"]],
      [b, ["run-2", "run-1"]],
    ] as const) {
      connection.transaction(() => {
        for (const runId of order) {
          connection
            .prepare(
              "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) " +
                "VALUES (?, 'running', ?, ?)",
            )
            .run(runId, T0, T0);
        }
      })();
    }
    // Two distinct files, with distinct names and opposite physical row order,
    // holding the same two facts.
    expect(canonicalSqliteBytes(a).equals(canonicalSqliteBytes(b))).toBe(true);
  });

  test("a single changed value moves the canonical bytes", () => {
    const { interlock } = fixtures();
    startOnInterlock(interlock, "run-1");
    const before = canonicalSqliteBytes(interlock);
    interlock.transaction(() => {
      interlock
        .prepare("UPDATE run SET status = 'done', updated_at_ms = ? WHERE run_id = 'run-1'")
        .run(T0 + 1);
    })();
    expect(canonicalSqliteBytes(interlock).equals(before)).toBe(false);
  });

  test("exclusion excludes exactly the named table", () => {
    const { ledger, routing } = fixtures();
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0, reason: "canary" });
    const withRouting = canonicalSqliteBytes(ledger);
    const without = canonicalSqliteBytes(ledger, { excludeTables: ["routing_decision"] });
    expect(withRouting.equals(without)).toBe(false);
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0 + 1, reason: "rollback" });
    expect(
      canonicalSqliteBytes(ledger, { excludeTables: ["routing_decision"] }).equals(without),
    ).toBe(true);
  });

  test("a schema only mutation moves the canonical bytes", () => {
    // A rollback that created or dropped an EMPTY table -- or touched only an
    // index or trigger -- writes no row; the canonical stream must see it
    // anyway, or "byte-identical" would be blind to exactly the class of store
    // surgery a migration starts with.
    const { ledger, interlock, synthetic, routing } = fixtures();
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0, reason: "canary" });
    const before = snapshotStores(ledger, interlock, synthetic);
    interlock.transaction(() => {
      interlock.exec("CREATE TABLE migration_scaffold (x TEXT)"); // empty, rowless
    })();
    const after = snapshotStores(ledger, interlock, synthetic);
    const comparison = compareAcrossRollback(before, after);
    expect(comparison.interlockIdentical).toBe(false);
    expect(comparison.onlyTheRoutingDecisionChanged).toBe(false);
  });

  test("the exclusion does not take the routing schema with it", () => {
    // Excluding the routing relation excludes its ROWS only. A rollback that
    // dropped the append-only trigger and then appended the expected row must
    // still move the excluded-form digest -- otherwise the exclusion that
    // licenses the rollback would also be its hiding place.
    const { ledger, routing } = fixtures();
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0, reason: "canary" });
    const before = canonicalSqliteBytes(ledger, { excludeTables: ["routing_decision"] });
    ledger.exec("DROP TRIGGER routing_decision_is_never_edited");
    const after = canonicalSqliteBytes(ledger, { excludeTables: ["routing_decision"] });
    expect(before.equals(after)).toBe(false);
  });

  test("a changed revision stamp is a changed store", () => {
    const { interlock } = fixtures();
    const before = canonicalSqliteBytes(interlock);
    // A pragma takes no bound parameter, so the value is inlined here as it is
    // in the source.
    interlock.pragma("user_version = 999");
    expect(canonicalSqliteBytes(interlock).equals(before)).toBe(false);
  });

  test("a blob value is canonicalised not crashed on", () => {
    // S5's outbox payload carries no typeof CHECK, so a store can legally hold
    // bytes -- and the store the canonicaliser most needs to see, one with an
    // unexpected write in it, must not be the one it cannot serialise.
    const { interlock } = fixtures();
    startOnInterlock(interlock, "run-1");
    interlock.transaction(() => {
      interlock
        .prepare(
          "INSERT INTO outbox (message_id, run_id, recipient, payload, dedup_key, " +
            "status, enqueued_at_ms) VALUES ('msg-1', 'run-1', 'peer', ?, 'dk-1', " +
            "'pending', ?)",
        )
        .run(Buffer.from([0x00, 0x01, 0xff]), T0);
    })();
    const first = canonicalSqliteBytes(interlock);
    expect(first.equals(canonicalSqliteBytes(interlock))).toBe(true);
    // Python's `b"$blob_sha256" in first` is a substring search over the byte
    // stream, so this is one too -- deliberately not a parse of the JSON, which
    // would assert a shape the source does not.
    expect(first.includes(Buffer.from("$blob_sha256", "utf-8"))).toBe(true);
  });

  test("the enumeration reads every run keyed table", () => {
    // "Enumeration is capture" has to survive a run that exists only in a child
    // table: a foreign writer with foreign_keys off can leave one, and an audit
    // that read only `run` would call that store unwritten.
    //
    // A bare database, opened by the driver rather than by any opener in this
    // package: no application_id, no user_version, no pragmas, and a `run_id`
    // in `outbox` with no parent row. `sqliteRunIds` must need none of that.
    const scratch = closeAfterTest(
      new Database(join(caseRoot("cnry-adt"), "scratch.sqlite3"), { fileMustExist: false }),
    );
    scratch.exec("CREATE TABLE run (run_id TEXT PRIMARY KEY)");
    scratch.exec("CREATE TABLE outbox (message_id TEXT, run_id TEXT)");
    scratch.exec("CREATE TABLE unrelated (note TEXT)");
    scratch.exec("INSERT INTO run VALUES ('run-parent')");
    scratch.exec("INSERT INTO outbox VALUES ('msg-1', 'run-orphan')");
    scratch.exec("INSERT INTO outbox VALUES ('msg-2', NULL)");
    scratch.exec("INSERT INTO unrelated VALUES ('no run key here')");
    expect(sqliteRunIds(scratch)).toEqual(["run-orphan", "run-parent"]);
  });
});

// --------------------------------------------------------------------------
// the rollback comparison
// --------------------------------------------------------------------------

describe("the rollback comparison", () => {
  test("a rollback alone changes only the routing decision", () => {
    const { ledger, interlock, synthetic, routing } = fixtures();
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0, reason: "baseline" });
    routing.routeRunStart("run-a", { nowMs: T0 + 1 });
    synthetic.startRun("run-a", { nowMs: T0 + 1 });
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0 + 2, reason: "canary" });
    routing.routeRunStart("run-b", { nowMs: T0 + 3 });
    startOnInterlock(interlock, "run-b", T0 + 3);

    const before = snapshotStores(ledger, interlock, synthetic);
    const rollback = routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0 + 4, reason: "rollback" });
    const after = snapshotStores(ledger, interlock, synthetic);

    const comparison = compareAcrossRollback(before, after);
    expect(comparison.onlyTheRoutingDecisionChanged).toBe(true);
    // The second half of the pair the predicate deliberately does not answer:
    // *what* was appended, held to the decision the routing point returned.
    expect(comparison.appendedDecisions).toEqual([
      [rollback.decisionSeq, SYNTHETIC_V1, T0 + 4, "rollback"],
    ]);
    expect(comparison.label).toBe(REHEARSAL_MARKING);
  });

  test("a store write during the window is seen", () => {
    const { ledger, interlock, synthetic, routing } = fixtures();
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0, reason: "canary" });
    const before = snapshotStores(ledger, interlock, synthetic);
    startOnInterlock(interlock, "run-smuggled"); // a migration would look like this
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0 + 1, reason: "rollback" });
    const after = snapshotStores(ledger, interlock, synthetic);

    const comparison = compareAcrossRollback(before, after);
    expect(comparison.interlockIdentical).toBe(false);
    expect(comparison.onlyTheRoutingDecisionChanged).toBe(false);
  });

  test("a ledger write during the window is seen", () => {
    const { ledger, interlock, synthetic, routing } = fixtures();
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0, reason: "canary" });
    const before = snapshotStores(ledger, interlock, synthetic);
    routing.routeRunStart("run-late", { nowMs: T0 + 1 }); // an in-flight state conversion
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0 + 2, reason: "rollback" });
    const after = snapshotStores(ledger, interlock, synthetic);

    const comparison = compareAcrossRollback(before, after);
    expect(comparison.runLedgerIdentical).toBe(false);
    expect(comparison.onlyTheRoutingDecisionChanged).toBe(false);
  });

  test("the predicate answers touched nothing else not rollback happened", () => {
    // Two identical snapshots satisfy the predicate vacuously, by design: it
    // answers "did anything beyond routing change?", and "did a rollback
    // actually happen?" is appendedDecisions' question. A caller asserting a
    // rollback must ask both -- as the rehearsal test does.
    const { ledger, interlock, synthetic, routing } = fixtures();
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0, reason: "canary" });
    const snapshot = snapshotStores(ledger, interlock, synthetic);
    const comparison = compareAcrossRollback(snapshot, snapshot);
    expect(comparison.onlyTheRoutingDecisionChanged).toBe(true);
    expect(comparison.appendedDecisions).toEqual([]);
  });

  test("a rewritten history is not an append", () => {
    // Snapshots taken around a history that shrank (or changed under its
    // prefix) must not read as a clean rollback. The ledger's own triggers
    // forbid this; the comparison must still be able to say it, because the
    // comparison, not the trigger, is what the rehearsal's evidence cites.
    const { ledger, interlock, synthetic, routing } = fixtures();
    routing.routeNewRunsTo(INTERLOCK, { nowMs: T0, reason: "canary" });
    routing.routeNewRunsTo(SYNTHETIC_V1, { nowMs: T0 + 1, reason: "rollback" });
    const after = snapshotStores(ledger, interlock, synthetic);
    const longerHistory = snapshotStores(ledger, interlock, synthetic);
    // The source rebuilds the snapshot type by keyword with exactly these four
    // fields; an object literal is the same construction, and it is the case
    // that pins the snapshot's complete public shape -- a fifth required member
    // would break it here.
    const trimmed: StoreSnapshot = {
      interlockDigest: after.interlockDigest,
      syntheticV1Digest: after.syntheticV1Digest,
      runLedgerDigest: after.runLedgerDigest,
      routingDecisionRows: after.routingDecisionRows.slice(0, 1),
    };
    const comparison = compareAcrossRollback(longerHistory, trimmed);
    expect(comparison.decisionsAppendedOnly).toBe(false);
    expect(comparison.appendedDecisions).toEqual([]);
    expect(comparison.onlyTheRoutingDecisionChanged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// integer precision in the digest (target-only)
// ---------------------------------------------------------------------------

describe("integer precision in the digest (target-only)", () => {
  // Carries no warrant from the source: Python's `int` is arbitrary precision,
  // so `canonical_sqlite_bytes` cannot lose a 64-bit value and interlock has no
  // case for it. This port can, and did -- reading rows as JavaScript `number`s
  // collapses every integer past 2**53 onto the nearest double, so two stores
  // differing by one in that range digested identically and a rollback that
  // changed such a value would have been reported as touching nothing. Raised
  // by the review gate; the repair is `safeIntegers(true)` in
  // `canonicalSqliteBytes`, and this is the case that holds it there (D-0023).
  test("target-only -- two int64 values a double cannot tell apart digest differently", () => {
    const root = caseRoot("cnry-adt");

    // 2**53 and 2**53 + 1: distinct as SQLite INTEGERs, the same IEEE-754
    // double. `9007199254740993` is not writable as a JavaScript number
    // literal at all, so both are bound as bigints.
    const digestOf = (value: bigint): string => {
      const store = new Database(join(root, `wide-${value}.sqlite3`), { fileMustExist: false });
      onTestFinished(() => {
        store.close();
      });
      store.exec("CREATE TABLE wide (run_id TEXT PRIMARY KEY, measured INTEGER NOT NULL)");
      store.prepare("INSERT INTO wide (run_id, measured) VALUES (?, ?)").run("run-1", value);
      return createHash("sha256").update(canonicalSqliteBytes(store)).digest("hex");
    };

    const low = digestOf(9007199254740992n);
    const high = digestOf(9007199254740993n);

    expect(low).not.toBe(high);

    // And the odd value reaches the bytes as its own digits, rather than as the
    // even double it would have been rounded to. Asserted on the text because
    // that is what the digest is taken over: a digest difference alone would
    // also be satisfied by two values that were both wrong.
    const store = new Database(join(root, "witness.sqlite3"), { fileMustExist: false });
    onTestFinished(() => {
      store.close();
    });
    store.exec("CREATE TABLE wide (run_id TEXT PRIMARY KEY, measured INTEGER NOT NULL)");
    store
      .prepare("INSERT INTO wide (run_id, measured) VALUES (?, ?)")
      .run("run-1", 9007199254740993n);
    expect(canonicalSqliteBytes(store).toString("utf-8")).toContain("9007199254740993");
  });
});
