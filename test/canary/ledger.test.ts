/**
 * The routing ledger's database-enforced guarantees.
 *
 * Ported from interlock `tests/canary/test_ledger.py` at `65f36c5`. Every case
 * here maps to one source node id; the mapping, and the target-only cases that
 * occupy no source slot, are recorded in the belt's parity ledger.
 *
 * These tests are the durable half (D-0026): the ledger implementation may be
 * thrown away, but whatever records run ownership at the real canary still has
 * to refuse a mid-flight owner change, an edited routing history and a store it
 * cannot verify -- and refuse them **in the store**, not in the discipline of
 * the writer.
 *
 * The `describe` blocks are the source file's own comment banners, in the
 * source's order. A banner is half of a target id, so they are carried across
 * verbatim rather than reworded.
 *
 * Three runtime differences run through the whole file and are noted once here
 * rather than at every call site:
 *
 * - **`ledger.commit()` has no translation.** better-sqlite3 runs in
 *   autocommit, so a statement is durable when it returns. The source's
 *   explicit commits are dropped and nothing downstream of them changes; the
 *   `with ledger:` blocks its two helpers use are real transactions and are
 *   translated as such.
 * - **`sqlite3.IntegrityError` becomes a result code.** better-sqlite3 raises
 *   one error type for everything, so every `pytest.raises(sqlite3.IntegrityError)`
 *   is `expectSqliteError(..., { code: /^SQLITE_CONSTRAINT/ })` -- the code is
 *   what carries the distinction Python's exception hierarchy carried (D-0016)
 *   -- and the source's `match=` half is kept alongside it wherever it had one.
 *   Where the source has **no** `match=`, none is added: several of those cases
 *   are deliberately agnostic about which of two constraints fires first, and
 *   naming one would assert more than the source does (rule 0).
 * - **Every connection under test comes from this module's own opener.** That
 *   is not incidental to the two `INSERT OR REPLACE` cases: they are refused
 *   only because `configureLedgerConnection` sets `recursive_triggers = ON`, so
 *   a case that opened its own raw handle would pass for the wrong reason -- or
 *   rather, would fail, silently rewriting the row the trigger exists to
 *   protect.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  CorruptLedgerRefused,
  collapsedLedgerSql,
  createRoutingLedger,
  LEDGER_APPLICATION_ID,
  LEDGER_REVISION,
  LEDGER_SCHEMA_PATH,
  LEDGER_TABLES,
  ledgerSeams,
  loadLedgerSql,
  MissingLedgerRefused,
  openRoutingLedger,
  RoutingLedgerRefusal,
} from "../../src/canary/ledger.js";
import { REHEARSAL_MARKING } from "../../src/canary/marking.js";
// The source imports the control plane's application id *inside* the one case
// that uses it, so that `canary` carries no import-time dependency on
// `control_plane`. The dependency this file introduces is the test's, not the
// module's -- `src/canary/ledger.ts` imports nothing from `control_plane` --
// and a static import here is the honest spelling of that in TypeScript.
import { SPIKE_APPLICATION_ID } from "../../src/control_plane/spike.js";
import { bytesOf, caseRoot, rawConnection, sidecars } from "../testkit/cases.js";
import { expectRefusal, expectSqliteError } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

/**
 * Every `pytest.raises(sqlite3.IntegrityError)` in this file, as a result code.
 *
 * Deliberately the whole `SQLITE_CONSTRAINT` family and not one member:
 * `RAISE(ABORT, ...)` arrives as `SQLITE_CONSTRAINT_TRIGGER`, a `CHECK` as
 * `SQLITE_CONSTRAINT_CHECK` and a duplicate rowid as
 * `SQLITE_CONSTRAINT_PRIMARYKEY`, and `sqlite3.IntegrityError` covers all
 * three without distinguishing them (D-0016).
 */
const CONSTRAINT = /^SQLITE_CONSTRAINT/;

/**
 * The source's `ledger_path` fixture: a name inside a fresh per-test directory,
 * where no file exists yet.
 *
 * The label is `cnry-ldg`, not something readable like "routing-ledger-refused"
 * (D-0020). Every refusal this module raises interpolates the path into its
 * message and `caseRoot(label)` puts the label into that path, so a label
 * sharing a word with a message under test would make that case's `match`
 * vacuous -- the pattern is a *search* over the whole message, and it would
 * find the word in the path however the refusal came out.
 */
function ledgerPath(): string {
  return join(caseRoot("cnry-ldg"), "routing-ledger.sqlite3");
}

/**
 * The source's `ledger` fixture, as a plain call (function scope).
 *
 * Created rather than copied from a file-scoped template: creation *is* the
 * subject of several cases here, the pragmas the rest depend on are applied by
 * the opener on the way out, and a 27-case file is not where the copy trick
 * pays for its own risk.
 *
 * The close is registered with `onTestFinished` at the moment the connection is
 * opened, and it tolerates an already-closed handle: seven cases close the
 * connection themselves partway through, exactly as the source's do, and
 * Python's teardown closing a closed connection is a no-op there too.
 */
function ledgerFixture(): { path: string; ledger: SqliteDatabase } {
  const path = ledgerPath();
  return { path, ledger: closeAfterTest(createRoutingLedger(path)) };
}

/** Close a connection when the test finishes, whatever the test does with it. */
function closeAfterTest(connection: SqliteDatabase): SqliteDatabase {
  onTestFinished(() => {
    try {
      connection.close();
    } catch {
      // Already closed by the test. Closing twice is not an error worth
      // failing a passing test over.
    }
  });
  return connection;
}

/**
 * The source's `add_decision` helper.
 *
 * `decision_seq` is omitted, so SQLite assigns it as `max + 1`: the first call
 * yields 1, the second 2. Wrapped in a transaction because the source's `with
 * ledger:` is one -- and because a refusal raised inside it must still escape,
 * which better-sqlite3's `transaction()` does after rolling back.
 */
function addDecision(
  ledger: SqliteDatabase,
  options: { owningSystem?: string; at?: number; reason?: string } = {},
): void {
  const owningSystem = options.owningSystem ?? "synthetic_v1";
  const at = options.at ?? T0;
  const reason = options.reason ?? "baseline";
  ledger.transaction(() => {
    ledger
      .prepare(
        "INSERT INTO routing_decision (owning_system, decided_at_ms, reason) VALUES (?, ?, ?)",
      )
      .run(owningSystem, at, reason);
  })();
}

/** The source's `add_run` helper. */
function addRun(
  ledger: SqliteDatabase,
  options: { runId?: string; owningSystem?: string; seq?: number; at?: number } = {},
): void {
  const runId = options.runId ?? "run-1";
  const owningSystem = options.owningSystem ?? "synthetic_v1";
  const seq = options.seq ?? 1;
  const at = options.at ?? T0;
  ledger.transaction(() => {
    ledger
      .prepare(
        "INSERT INTO run_owner (run_id, owning_system, decision_seq, routed_at_ms) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run(runId, owningSystem, seq, at);
  })();
}

/** `ledger.execute(sql, params)` -- a statement run outside any transaction. */
function execute(ledger: SqliteDatabase, sql: string, ...params: (string | number)[]): void {
  ledger.prepare(sql).run(...params);
}

/** The one column of a one-row, one-column read -- Python's `fetchone()[0]`. */
function scalar(ledger: SqliteDatabase, sql: string): unknown {
  return ledger.prepare(sql).pluck().get();
}

// --------------------------------------------------------------------------
// the marking
// --------------------------------------------------------------------------

describe("the marking", () => {
  test("the DDL carries the rehearsal marking as one sentence", () => {
    // Reaches into the loader's own collapsing rule deliberately (Python reads
    // the private `_collapsed`): the property is that the DDL carries the
    // sentence *as the loader will read it*, and a test that reimplemented the
    // regex would compare its own construction against itself.
    const collapsed = collapsedLedgerSql(readFileSync(LEDGER_SCHEMA_PATH, "utf-8"));

    expect(collapsed).toContain(REHEARSAL_MARKING);
  });

  test("the DDL is refused if the marking is removed", () => {
    const root = caseRoot("cnry-ldg");
    const stripped = join(root, "stripped.sql");
    const text = readFileSync(LEDGER_SCHEMA_PATH, "utf-8");
    expect(text).toContain("NOT A");
    // `replaceAll`, because Python's `str.replace` replaces every occurrence
    // and JS's string-pattern `replace` replaces only the first. The edit turns
    // "NOT A DISCHARGE" into "A DISCHARGE" -- the smallest change that breaks
    // the sentence, rather than deleting the header wholesale, which would
    // also pass while testing less.
    writeFileSync(stripped, text.replaceAll("NOT A", "A"), "utf-8");
    patchSeam(ledgerSeams, "ledgerSchemaPath", stripped);

    expectRefusal(() => loadLedgerSql(), RoutingLedgerRefusal, "rehearsal");
  });
});

// --------------------------------------------------------------------------
// no mid-flight owner change, enforced by the store
// --------------------------------------------------------------------------

describe("no mid-flight owner change, enforced by the store", () => {
  test("a run never changes owning system", () => {
    const { ledger } = ledgerFixture();
    addDecision(ledger);
    addRun(ledger, { owningSystem: "synthetic_v1" });

    expectSqliteError(
      () =>
        execute(ledger, "UPDATE run_owner SET owning_system = 'interlock' WHERE run_id = 'run-1'"),
      { code: CONSTRAINT, message: /mid-flight/ },
    );
  });

  test("a run owner row admits no update at all", () => {
    // There is nothing legitimately updatable on the row, so even a
    // same-value update is refused: the trigger guards the row, not a column.
    const { ledger } = ledgerFixture();
    addDecision(ledger);
    addRun(ledger);

    expectSqliteError(
      () =>
        execute(ledger, "UPDATE run_owner SET routed_at_ms = routed_at_ms WHERE run_id = 'run-1'"),
      { code: CONSTRAINT, message: /mid-flight/ },
    );
  });

  test("a run owner row is never deleted", () => {
    const { ledger } = ledgerFixture();
    addDecision(ledger);
    addRun(ledger);

    expectSqliteError(() => execute(ledger, "DELETE FROM run_owner"), {
      code: CONSTRAINT,
      message: /never deleted/,
    });
  });

  test("or replace is not a way around the owner trigger", () => {
    // INSERT OR REPLACE resolves the conflict by deleting the standing row,
    // and with recursive_triggers off (SQLite's default) that implicit
    // delete fires no trigger at all -- a mid-flight owner change in one
    // statement. The connections this module hands out turn the pragma on,
    // and this test holds them to it.
    // Two decisions, so the replacement row agrees with the decision it
    // cites and only the delete trigger stands between it and the rewrite.
    const { ledger } = ledgerFixture();
    addDecision(ledger, { owningSystem: "synthetic_v1" });
    addDecision(ledger, { owningSystem: "interlock", reason: "canary" });
    addRun(ledger, { owningSystem: "synthetic_v1", seq: 1 });

    expectSqliteError(
      () =>
        execute(
          ledger,
          "INSERT OR REPLACE INTO run_owner (run_id, owning_system, decision_seq, routed_at_ms) " +
            "VALUES ('run-1', 'interlock', 2, ?)",
          T0 + 1,
        ),
      { code: CONSTRAINT, message: /never deleted/ },
    );
    expect(scalar(ledger, "SELECT owning_system FROM run_owner WHERE run_id = 'run-1'")).toBe(
      "synthetic_v1",
    );
  });

  test("or replace is not a way around the decision history", () => {
    const { ledger } = ledgerFixture();
    addDecision(ledger);

    expectSqliteError(
      () =>
        execute(
          ledger,
          "INSERT OR REPLACE INTO routing_decision " +
            "(decision_seq, owning_system, decided_at_ms, reason) " +
            "VALUES (1, 'interlock', ?, 'rewritten')",
          T0 + 1,
        ),
      { code: CONSTRAINT, message: /never deleted/ },
    );
  });

  test("a run owner must agree with the decision it cites", () => {
    // The foreign key proves the decision exists; this proves the row is not
    // lying about it. An owner row citing a synthetic_v1 decision while
    // naming interlock would be an immutable, verifiable contradiction.
    const { ledger } = ledgerFixture();
    addDecision(ledger, { owningSystem: "synthetic_v1" });

    expectSqliteError(() => addRun(ledger, { owningSystem: "interlock", seq: 1 }), {
      code: CONSTRAINT,
      message: /its routing decision names/,
    });
  });

  test("one ledger row per run", () => {
    const { ledger } = ledgerFixture();
    addDecision(ledger);
    addRun(ledger, { runId: "run-1" });

    // No `match=` in the source, and none here: two constraints could fire --
    // the BEFORE INSERT trigger (interlock against a synthetic_v1 decision) or
    // the primary key -- and the source is deliberately agnostic about which.
    expectSqliteError(() => addRun(ledger, { runId: "run-1", owningSystem: "interlock" }), {
      code: CONSTRAINT,
    });
  });
});

// --------------------------------------------------------------------------
// the routing history is append-only, in order
// --------------------------------------------------------------------------

describe("the routing history is append-only, in order", () => {
  test("a routing decision is never edited", () => {
    const { ledger } = ledgerFixture();
    addDecision(ledger);

    expectSqliteError(
      () => execute(ledger, "UPDATE routing_decision SET owning_system = 'interlock'"),
      {
        code: CONSTRAINT,
        message: /never edited/,
      },
    );
  });

  test("a routing decision is never deleted", () => {
    const { ledger } = ledgerFixture();
    addDecision(ledger);

    expectSqliteError(() => execute(ledger, "DELETE FROM routing_decision"), {
      code: CONSTRAINT,
      message: /never deleted/,
    });
  });

  test("a decision cannot be back filled behind the newest", () => {
    // The newest row IS the routing, so an insert at a smaller sequence would
    // change which decision is current without appending anything.
    const { ledger } = ledgerFixture();
    addDecision(ledger);
    addDecision(ledger, { owningSystem: "interlock", reason: "canary" });

    // An occupied sequence number is a plain uniqueness refusal ...
    expectSqliteError(
      () =>
        execute(
          ledger,
          "INSERT INTO routing_decision (decision_seq, owning_system, decided_at_ms, reason) " +
            "VALUES (1, 'synthetic_v1', ?, 'rewrite')",
          T0,
        ),
      { code: CONSTRAINT },
    );
    // ... and a vacant one BEHIND the newest is refused by the ordering
    // trigger: it would change which decision is current without appending.
    expectSqliteError(
      () =>
        execute(
          ledger,
          "INSERT INTO routing_decision (decision_seq, owning_system, decided_at_ms, reason) " +
            "VALUES (0, 'synthetic_v1', ?, 'prehistory')",
          T0,
        ),
      { code: CONSTRAINT, message: /appended in order/ },
    );
  });
});

// --------------------------------------------------------------------------
// the vocabulary is closed, the types are asserted
// --------------------------------------------------------------------------

describe("the vocabulary is closed, the types are asserted", () => {
  // The two ids are the full SQL statements, exactly as `pytest --collect-only`
  // printed them: pytest builds the id from the parameter value, and the second
  // value is two adjacent Python string literals that concatenate with one
  // space. Reproduced verbatim so the parity ledger can match on the id.
  parametrize(
    "the owning system vocabulary is closed",
    [
      [
        "INSERT INTO routing_decision (owning_system, decided_at_ms, reason) VALUES ('v1', ?, 'r')",
        "INSERT INTO routing_decision (owning_system, decided_at_ms, reason) VALUES ('v1', ?, 'r')",
      ],
      [
        "INSERT INTO run_owner (run_id, owning_system, decision_seq, routed_at_ms) VALUES ('run-x', 'v1', 1, ?)",
        "INSERT INTO run_owner (run_id, owning_system, decision_seq, routed_at_ms) VALUES ('run-x', 'v1', 1, ?)",
      ],
    ] as const,
    (tableInsert) => {
      // 'v1' in particular is refused: the stand-in is named synthetic_v1 so a
      // rehearsal ledger can never read as evidence against the live system.
      const { ledger } = ledgerFixture();
      addDecision(ledger);

      // No `match=`: in the run_owner expansion either the CHECK or the
      // agrees-with-its-decision trigger can be what surfaces.
      expectSqliteError(() => execute(ledger, tableInsert, T0), { code: CONSTRAINT });
    },
  );

  test("a timestamp that is not an integer is refused", () => {
    const { ledger } = ledgerFixture();

    // The column's INTEGER affinity does not coerce non-numeric text, so it is
    // the `typeof` CHECK that refuses this -- in the store, which is the point.
    expectSqliteError(
      () =>
        execute(
          ledger,
          "INSERT INTO routing_decision (owning_system, decided_at_ms, reason) " +
            "VALUES ('interlock', 'yesterday', 'r')",
        ),
      { code: CONSTRAINT },
    );
  });

  test("an empty reason is refused", () => {
    // A decision with no reason is unauditable; a rollback especially so.
    const { ledger } = ledgerFixture();

    expectSqliteError(
      () =>
        execute(
          ledger,
          "INSERT INTO routing_decision (owning_system, decided_at_ms, reason) " +
            "VALUES ('interlock', ?, '')",
          T0,
        ),
      { code: CONSTRAINT },
    );
  });
});

// --------------------------------------------------------------------------
// refusal discipline (R3): never created by an open, never read when broken
// --------------------------------------------------------------------------

describe("refusal discipline (R3): never created by an open, never read when broken", () => {
  test("an absent ledger is not an empty one", () => {
    // The `ledger` fixture is deliberately NOT taken: nothing exists at the path.
    const path = ledgerPath();

    expectRefusal(() => openRoutingLedger(path), MissingLedgerRefused);
  });

  test("creation refuses an existing path", () => {
    const { path } = ledgerFixture();

    expectRefusal(() => createRoutingLedger(path), RoutingLedgerRefusal, "already exists");
  });

  test("a file that is not a database is refused", () => {
    const impostor = join(caseRoot("cnry-ldg"), "impostor.sqlite3");
    writeFileSync(impostor, "not a database", "utf-8");

    // No `match=`: the source does not care whether the refusal came from the
    // open or from `integrity_check`, and better-sqlite3 chooses differently
    // from CPython's `sqlite3` about which of the two notices first.
    expectRefusal(() => openRoutingLedger(impostor), CorruptLedgerRefused);
  });

  test("some other database is refused by application id", () => {
    const other = join(caseRoot("cnry-ldg"), "other.sqlite3");
    const connection = rawConnection(other);
    // The decoy carries both ledger table names and the right revision, so the
    // only thing separating it from a ledger is its identity. That the refusal
    // names `application_id` is the assertion that identity is checked before
    // shape.
    connection.exec("CREATE TABLE routing_decision (x)");
    connection.exec("CREATE TABLE run_owner (x)");
    connection.pragma(`user_version = ${LEDGER_REVISION}`);
    connection.close();

    expectRefusal(() => openRoutingLedger(other), CorruptLedgerRefused, "application_id");
  });

  test("another revision is refused never migrated", () => {
    const { path, ledger } = ledgerFixture();
    ledger.pragma(`user_version = ${LEDGER_REVISION + 1}`);
    ledger.close();

    expectRefusal(() => openRoutingLedger(path), CorruptLedgerRefused, "revision");
  });

  test("a ledger that lost a trigger is refused", () => {
    // integrity_check passes on a database that has lost a trigger -- and the
    // trigger here IS the mid-flight immutability, so the shape is compared.
    const { path, ledger } = ledgerFixture();
    ledger.exec("DROP TRIGGER run_owner_never_changes_mid_flight");
    ledger.close();

    // "trigger" matches the *fingerprint* message ("a table, trigger or CHECK
    // differs"), not a message naming the dropped trigger: nothing in this
    // module knows which object went missing.
    expectRefusal(() => openRoutingLedger(path), CorruptLedgerRefused, "trigger");
  });

  test("a ledger that lost a table is missing state not empty", () => {
    const { path, ledger } = ledgerFixture();
    ledger.exec("DROP TABLE run_owner");
    ledger.close();

    // Both the table check and the fingerprint check would trip here; that this
    // says "missing ledger table" is the assertion that the ladder's order
    // holds. The pattern stops before the "(s)", as the source's does -- which
    // is fortunate, since `(s)` would otherwise be a capture group.
    expectRefusal(() => openRoutingLedger(path), CorruptLedgerRefused, "missing ledger table");
  });

  test("a dangling ledger reference is refused", () => {
    // foreign_keys is per-connection, so a foreign writer can leave a
    // run_owner row pointing at a decision that does not exist; opening
    // refuses the store rather than reading partial state.
    const { path, ledger } = ledgerFixture();
    // Issued outside any transaction: `PRAGMA foreign_keys` is a silent no-op
    // inside one, and this insert has to actually land.
    ledger.pragma("foreign_keys = OFF");
    // There are no routing_decision rows at all, so the agrees-with-its-decision
    // trigger's subselect is NULL and its WHEN is vacuous. That case belongs to
    // the foreign key, which is exactly what `foreign_key_check` then finds.
    addRun(ledger, { seq: 99 });
    ledger.close();

    expectRefusal(() => openRoutingLedger(path), CorruptLedgerRefused, "dangling");
  });

  test("a directory is not a ledger", () => {
    const root = caseRoot("cnry-ldg");

    // Exists, so not Missing; not a regular file, so Corrupt. A port that only
    // caught the driver's SQLITE_CANTOPEN would produce neither message.
    expectRefusal(() => openRoutingLedger(root), CorruptLedgerRefused, "regular file");
  });

  test("a verifiable ledger reopens with its rows", () => {
    const { path, ledger } = ledgerFixture();
    addDecision(ledger);
    addRun(ledger);
    ledger.close();

    const reopened = closeAfterTest(openRoutingLedger(path));
    expect(scalar(reopened, "SELECT COUNT(*) FROM run_owner")).toBe(1);
    expect(LEDGER_TABLES).toStrictEqual(["routing_decision", "run_owner"]);
  });

  test("the ledger application id is not the control plane's", () => {
    // Inequality only, as the source asserts: what matters is that a ledger
    // handed to the S5 opener -- or the reverse -- is refused as "some other
    // database" rather than reported as one with missing tables.
    expect(LEDGER_APPLICATION_ID).not.toBe(SPIKE_APPLICATION_ID);
  });
});

// --------------------------------------------------------------------------
// the DDL ships to dist (target-only)
// --------------------------------------------------------------------------

describe("the DDL ships to dist (target-only)", () => {
  test("target-only -- the built package carries routing_ledger.sql byte for byte", () => {
    // Python packages data files through its own mechanism, so interlock has no
    // counterpart case. In this port `LEDGER_SCHEMA_PATH` resolves beside
    // `ledger.js`, so a build that emits the JavaScript and forgets the `.sql`
    // ships a module in which the ledger can be neither created nor opened --
    // and every case in this file still passes, because they all run against
    // the source tree. That is the typical accident, and this is the only case
    // that can see it.
    //
    // Byte-for-byte and not merely present: the schema fingerprint hashes these
    // exact bytes, so a copy that normalised a line ending would make the
    // packaged build refuse every ledger the source build wrote.
    const built = fileURLToPath(new URL("../../dist/canary/routing_ledger.sql", import.meta.url));
    const builtModule = fileURLToPath(new URL("../../dist/canary/ledger.js", import.meta.url));

    // Reported honestly rather than as a confusing failure: without a build
    // there is nothing to check, and the message says so.
    expect(
      existsSync(builtModule),
      "dist/canary/ledger.js does not exist, so there is no build to check. " +
        "Run `npm run build` first (`npm test` does, via pretest).",
    ).toBe(true);
    expect(
      existsSync(built),
      "dist/canary/ledger.js exists but dist/canary/routing_ledger.sql does not: the build " +
        "emitted the module without the DDL it reads at runtime. Check " +
        "scripts/copy-canary-schema.mjs is still in package.json's build script.",
    ).toBe(true);
    expect(bytesOf(built).equals(bytesOf(LEDGER_SCHEMA_PATH))).toBe(true);
  });
});

// --------------------------------------------------------------------------
// seam liveness (target-only)
// --------------------------------------------------------------------------

describe("seam liveness (target-only)", () => {
  test("target-only -- loadLedgerSql reads the schema path through the seam record", () => {
    // A seam production stopped routing through would leave "the DDL is refused
    // if the marking is removed" green for the wrong reason: the replacement
    // would simply never be reached, and the real DDL -- which does carry the
    // marking -- would load without refusing... at which point that case would
    // fail rather than pass. What this pins is the other direction: that the
    // seam is what `loadLedgerSql` reads, so the *content* it returns is the
    // patched file's (D-0014).
    const marker = "-- seam liveness marker\n";
    const copy = join(caseRoot("cnry-ldg"), "routing_ledger.sql");
    writeFileSync(copy, marker + readFileSync(LEDGER_SCHEMA_PATH, "utf-8"), "utf-8");
    patchSeam(ledgerSeams, "ledgerSchemaPath", copy);

    expect(loadLedgerSql().startsWith(marker)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// store enforcement on every connection (target-only)
// --------------------------------------------------------------------------

describe("store enforcement on every connection (target-only)", () => {
  test("target-only -- a reopened ledger also refuses INSERT OR REPLACE", () => {
    // The source exercises OR REPLACE only through the *create* path's
    // connection, so `recursive_triggers = ON` could be applied on that path
    // alone and the whole ported belt would stay green -- while every
    // long-running process, which opens rather than creates, ran without the
    // guarantee. The pragma is per-connection; this asserts the open path
    // carries it too.
    const { path, ledger } = ledgerFixture();
    addDecision(ledger, { owningSystem: "synthetic_v1" });
    addDecision(ledger, { owningSystem: "interlock", reason: "canary" });
    addRun(ledger, { owningSystem: "synthetic_v1", seq: 1 });
    ledger.close();

    const reopened = closeAfterTest(openRoutingLedger(path));
    expectSqliteError(
      () =>
        execute(
          reopened,
          "INSERT OR REPLACE INTO run_owner (run_id, owning_system, decision_seq, routed_at_ms) " +
            "VALUES ('run-1', 'interlock', 2, ?)",
          T0 + 1,
        ),
      { code: CONSTRAINT, message: /never deleted/ },
    );
    expect(scalar(reopened, "SELECT owning_system FROM run_owner WHERE run_id = 'run-1'")).toBe(
      "synthetic_v1",
    );
  });

  test("target-only -- a trigger dropped by a foreign connection is caught at reopen", () => {
    // The ported case drops the trigger through the module's own connection,
    // which is the one thing that cannot happen in production: the writer that
    // damages a store is a `sqlite3` session or another process, holding a
    // handle this module never configured. The fingerprint is compared at open
    // and not held in memory, so the damage is found on the way back in --
    // which is what this asserts, and what a cached expected fingerprint or a
    // verify-on-create-only design would lose.
    const { path, ledger } = ledgerFixture();
    ledger.close();

    const foreign = rawConnection(path);
    foreign.exec("DROP TRIGGER run_owner_rows_are_never_deleted");
    foreign.close();

    expectRefusal(() => openRoutingLedger(path), CorruptLedgerRefused, "trigger");
  });

  test("target-only -- the ledger stays on the rollback journal, created and reopened", () => {
    // The design constraint that this module must not build on
    // `src/sqlite/open.ts`'s `openDatabase` comes down to one pragma:
    // `openDatabase` sets `journal_mode = WAL`, and WAL is a persistent header
    // write that leaves `-wal`/`-shm` beside the file. Both halves are asserted
    // because either alone can be satisfied by accident -- the sidecars are
    // removed again when a WAL connection closes cleanly, so a case that only
    // listed the directory after a close would not see WAL at all.
    const { path, ledger } = ledgerFixture();
    expect(ledger.pragma("journal_mode", { simple: true })).toBe("delete");
    addDecision(ledger);
    addRun(ledger);
    expect(sidecars(path)).toStrictEqual([]);
    ledger.close();

    const reopened = closeAfterTest(openRoutingLedger(path));
    expect(reopened.pragma("journal_mode", { simple: true })).toBe("delete");
    expect(sidecars(path)).toStrictEqual([]);
  });

  test("target-only -- a refused open leaves the file byte identical and makes no sidecar", () => {
    // "Verification only reads, so a refused file is left exactly as it was
    // found" is stated in the source's docstring and asserted by no source
    // case. It is also the reason this module must never set `journal_mode =
    // WAL`: WAL is a header write and it leaves `-wal`/`-shm` beside the file,
    // so a shared opener that set it would break this silently.
    const { path, ledger } = ledgerFixture();
    ledger.pragma(`user_version = ${LEDGER_REVISION + 1}`);
    ledger.close();
    const before = bytesOf(path);

    expectRefusal(() => openRoutingLedger(path), CorruptLedgerRefused, "revision");

    expect(bytesOf(path).equals(before)).toBe(true);
    expect(sidecars(path)).toStrictEqual([]);
  });
});
