/**
 * The harness's opener: read-only proved, not claimed, and the migrator's
 * refusals reused.
 *
 * Ported from interlock `tests/measurement/test_reader.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping, and the cases that are
 * adapted or deferred rather than translated straight, are recorded in
 * `parity/measurement.ledger.json`.
 *
 * Interlock's `ACCEPTANCE.md` section 3 condition 5 asks for read-only **by
 * capability, not by convention**, and the distance between those two is the
 * whole subject of this file. A harness that merely *is* read-only today passes
 * every test that writes through it and then reads back nothing; the tests that
 * matter are the ones that take the claim apart -- remove one mechanism and
 * show the other still refuses the write, degrade the open call behind the
 * opener's back and show it notices, hash the file across an open and show that
 * even the noticing wrote nothing.
 *
 * The identity cases (a spike database, a database behind or ahead of this
 * build, an edited step) assert the **migrator's own refusal types**
 * deliberately: the property under test is that the harness reuses that
 * verification rather than growing a second copy of it, and a test that
 * accepted any `ControlPlaneRefusal` would keep passing on the day the copy
 * appeared.
 *
 * **The one mechanism that is spelled differently here.** Interlock's first
 * read-only mechanism is a `file:...?mode=ro` URI; better-sqlite3 does not
 * accept URI filenames at all, so continuo passes `readonly: true` and gets the
 * same `SQLITE_OPEN_READONLY`. `D-0100` records the substitution and the
 * measurements behind it. It reaches this file in two places and nowhere else:
 * the cases that build a read-only connection by hand, and the two refusal
 * messages that named the URI in their text.
 */

import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import {
  ControlPlaneRefusal,
  CorruptStateRefused,
  DatabaseAheadOfCodeRefused,
  MigrationChecksumRefused,
  MissingStateRefused,
} from "../../src/control_plane/refusals.js";
import * as measurementPackage from "../../src/measurement/index.js";
import {
  AsynchronousReportRefused,
  measurementSnapshot,
  NestedSnapshotRefused,
  openForMeasurement,
  proveReadOnly,
  ReadOnlyCapabilityRefused,
  readerSeams,
  requireQueryOnly,
  theErrorSaysTheDatabaseIsReadOnly,
} from "../../src/measurement/reader.js";
import { caseRoot, sidecars, writeStep } from "../testkit/cases.js";
import { expectRefusal, expectSqliteError } from "../testkit/errors.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

/**
 * A write that is valid against every production database.
 *
 * The ledger table is bootstrapped by the migrator itself, so it exists at
 * every version. Its DELETE/UPDATE triggers do not touch INSERT, so nothing but
 * the read-only capability under test can be what refuses this statement.
 */
const A_VALID_WRITE =
  "INSERT INTO schema_migration (version, name, checksum, applied_at_ms) " +
  `VALUES (9999, 'not_a_step', '${"0".repeat(64)}', 0)`;

/**
 * SQLite's answer when a write reaches a read-only database.
 *
 * Interlock asserts `pytest.raises(sqlite3.OperationalError, match="readonly")`
 * -- an exception class and a message search. better-sqlite3 raises one error
 * type for everything and carries the distinction on `code` (`D-0016`), so the
 * class half maps to the result code and the message half is kept as well.
 * Asserting both is what keeps the translated case from being the weaker
 * message-only check.
 */
function expectReadOnlyRefusal(action: () => unknown): void {
  expectSqliteError(action, { code: /^SQLITE_READONLY/, message: /readonly/ });
}

// --------------------------------------------------------------------------
// fixtures
//
// Every source fixture is translated to a per-test call rather than to a
// `beforeEach` (docs/test-translation-conventions.md rule 8): function scope is
// pytest's default here, and a shared fixture is a coupling the port's
// isolation contract exists to keep out.
// --------------------------------------------------------------------------

/** A real database migrated to head with the real ledger, then let go of. */
function productionDb(root: string): string {
  const path = join(root, "production.sqlite3");
  createProductionControlPlane(path, { nowMs: T0 }).close();
  return path;
}

/** A two-step scratch ledger, so "behind" and "ahead" can both be built. */
function scratchLedger(root: string): string {
  const directory = join(root, "ledger");
  writeStep(directory, "0001_alpha.sql", "CREATE TABLE alpha (id INTEGER PRIMARY KEY);\n");
  writeStep(directory, "0002_beta.sql", "CREATE TABLE beta (id INTEGER PRIMARY KEY);\n");
  return directory;
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * An ordinary read-write connection -- the control for every refusal here.
 *
 * Closed by the caller in a `finally`, exactly as the source closes its own,
 * because several cases need the handle gone *before* their last assertion:
 * hashing the file or listing its sidecars while a connection is open would
 * measure the journal rather than the database. On Windows an open handle also
 * keeps a lock on the file, and the temp-directory cleanup then fails with a
 * message about the directory rather than about the connection nobody closed.
 */
function writableConnection(path: string, options: { readonly timeout?: number } = {}) {
  const connection = new Database(path, {
    fileMustExist: true,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
  return connection;
}

/** A read-only connection built by hand -- interlock's `mode=ro` URI (`D-0100`). */
function readOnlyConnection(path: string): SqliteDatabase {
  return new Database(path, { readonly: true, fileMustExist: true });
}

// --------------------------------------------------------------------------
// the capability itself
// --------------------------------------------------------------------------

describe("the capability itself", () => {
  test("a write through the harness connection is refused", () => {
    const path = productionDb(caseRoot("reader"));
    const connection = openForMeasurement(path);
    try {
      expectReadOnlyRefusal(() => connection.exec(A_VALID_WRITE));
      // A read still works: the point is an instrument, not a closed door.
      expect(connection.pragma("user_version", { simple: true })).toBeGreaterThan(0);
    } finally {
      connection.close();
    }
  });

  test("the same write succeeds on an ordinary connection", () => {
    // The control for every refusal in this file. Without it, a typo in
    // A_VALID_WRITE would make each of them pass for the wrong reason -- the
    // statement rejected as malformed rather than as a write -- and the suite
    // would certify a capability nobody had tested. Run against a copy, so the
    // database the other tests hash stays untouched.
    const root = caseRoot("reader");
    const path = productionDb(root);
    const copy = join(root, "writable-copy.sqlite3");
    copyFileSync(path, copy);
    const connection = writableConnection(copy);
    try {
      connection.exec(A_VALID_WRITE);
    } finally {
      connection.close();
    }
  });

  test("query_only alone refuses the write with the file opened read-write", () => {
    // Mechanism 2 on its own. There are two mechanisms so that neither one's
    // failure is load-bearing, which is only a property if each is
    // independently sufficient -- this test and the next are that pair.
    const path = productionDb(caseRoot("reader"));
    const connection = writableConnection(path);
    try {
      connection.pragma("query_only = ON");
      expectReadOnlyRefusal(() => connection.exec(A_VALID_WRITE));
    } finally {
      connection.close();
    }
  });

  test("the read-only open flag alone refuses the write with query_only off", () => {
    // Mechanism 1 on its own, with the connection-level guard explicitly down
    // so that it cannot be what refuses.
    const path = productionDb(caseRoot("reader"));
    const connection = readOnlyConnection(path);
    try {
      connection.pragma("query_only = OFF");
      expect(connection.pragma("query_only", { simple: true })).toBe(0);
      expectReadOnlyRefusal(() => connection.exec(A_VALID_WRITE));
    } finally {
      connection.close();
    }
  });

  test("the harness connection reports query_only in force", () => {
    const path = productionDb(caseRoot("reader"));
    const connection = openForMeasurement(path);
    try {
      expect(connection.pragma("query_only", { simple: true })).toBe(1);
    } finally {
      connection.close();
    }
  });

  test("a connection that is not read-only is refused by the probe", () => {
    // The failure this refusal exists for: the open call stops carrying the
    // capability -- a dropped option, a future edit -- and every figure the
    // harness prints afterwards comes off a connection that could have changed
    // what it measured. query_only would still be ON, so nothing else in the
    // open would notice; only asking the file for a write lock does.
    const path = productionDb(caseRoot("reader"));
    const before = digest(path);

    patchSeam(
      readerSeams,
      "openReadOnly",
      (target: string) => new Database(target, { fileMustExist: true }),
    );

    expectRefusal(() => openForMeasurement(path), ReadOnlyCapabilityRefused, /read-only/);
    // The probe takes a lock and rolls it back without modifying a page, so
    // even the connection that turned out to be writable wrote nothing.
    expect(digest(path)).toBe(before);
    expect(sidecars(path)).toEqual([]);
  });

  test("a busy database is refused rather than certified read-only", () => {
    // The defect this test is the regression for: the probe accepted ANY
    // operational error as "the file refused the write", and a writable
    // connection whose write is blocked by another writer's RESERVED lock
    // fails with SQLITE_BUSY / "database is locked". A control plane with a
    // watcher or dispatcher mid-transaction is therefore not an edge case --
    // it is the ordinary state -- and under it the degraded, fully writable
    // connection below was handed back as the measurement handle and would
    // INSERT into schema_migration through it.
    //
    // Two things have to be true at once for the reproduction: the open call
    // is degraded exactly as in the test above, so the connection really is
    // read-write, and a second connection holds BEGIN IMMEDIATE so the probe's
    // write cannot land. The probe must then refuse -- an unproved capability
    // is refused on the same terms as an absent one.
    const path = productionDb(caseRoot("reader"));

    // timeout 0: with the default busy handler this test would spend five
    // seconds blocking before SQLite gave the answer it is about.
    patchSeam(
      readerSeams,
      "openReadOnly",
      (target: string) => new Database(target, { fileMustExist: true, timeout: 0 }),
    );

    const writer = writableConnection(path);
    let refusal: ReadOnlyCapabilityRefused;
    try {
      writer.exec("BEGIN IMMEDIATE");
      refusal = expectRefusal(() => openForMeasurement(path), ReadOnlyCapabilityRefused);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }

    // The two facts are different and the operator's next move differs with
    // them, so the refusal must not report contention as "the database was
    // writable" -- that sends someone to fix an open call that is not broken.
    expect(refusal.message).toContain("inconclusive");
    expect(refusal.message).toContain("database is locked");
    expect(refusal.message).not.toContain("was not opened read-only");
  });

  test("the probe still certifies an idle read-only database", () => {
    // The other half of the same fix: refusing every unrecognised refusal must
    // not become refusing everything. With no writer in the way the real
    // read-only connection produces a real SQLITE_READONLY error and the open
    // succeeds, which is the case the harness exists for.
    const path = productionDb(caseRoot("reader"));
    const connection = openForMeasurement(path);
    try {
      expect(connection.pragma("query_only", { simple: true })).toBe(1);
      expectReadOnlyRefusal(() => connection.exec(A_VALID_WRITE));
    } finally {
      connection.close();
    }
  });

  test("only a read-only error counts as proof of the read-only open flag", () => {
    // Bind the classifier to errors SQLite actually raised, not to strings
    // pasted into the test: a pasted message would keep this test green on the
    // day SQLite reworded one, which is the day the classifier needs to fail.
    const root = caseRoot("reader");
    const path = productionDb(root);
    const copy = join(root, "writable-copy.sqlite3");
    copyFileSync(path, copy);

    const readOnly = readOnlyConnection(copy);
    const writer = writableConnection(copy);
    const blocked = writableConnection(copy, { timeout: 0 });
    let readOnlyError: Error;
    let busyError: Error;
    try {
      // The source asserts only `sqlite3.OperationalError`, deliberately: the
      // point is that the classifier -- not the test -- tells the two apart.
      // `SQLITE_` is the same width of claim, and naming the two codes here
      // would be the test answering its own question.
      readOnlyError = expectSqliteError(() => readOnly.exec(A_VALID_WRITE), {
        code: /^SQLITE_/,
      });
      writer.exec("BEGIN IMMEDIATE");
      busyError = expectSqliteError(() => blocked.exec(A_VALID_WRITE), { code: /^SQLITE_/ });
    } finally {
      writer.exec("ROLLBACK");
      for (const handle of [readOnly, writer, blocked]) {
        handle.close();
      }
    }

    expect(theErrorSaysTheDatabaseIsReadOnly(readOnlyError)).toBe(true);
    expect(theErrorSaysTheDatabaseIsReadOnly(busyError)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// the public entry point: the same probe, off a connection the caller holds
// --------------------------------------------------------------------------

describe("the public probe", () => {
  test("openForMeasurement proves the capability through the public probe", () => {
    // What makes the tests below meaningful: the public name is not a second
    // entry point that happens to agree, it is the one openForMeasurement
    // itself goes through. A spy rather than a source read, because a copy of
    // the probe added later would still pass a source read of this module.
    const path = productionDb(caseRoot("reader"));
    const calls: [SqliteDatabase, string | undefined][] = [];
    const real = readerSeams.proveReadOnly;

    patchSeam(readerSeams, "proveReadOnly", (connection, target) => {
      calls.push([connection, target]);
      return real(connection, target);
    });

    const connection = openForMeasurement(path);
    try {
      expect(calls).toEqual([[connection, path]]);
    } finally {
      connection.close();
    }
  });

  test("the public probe certifies a connection the caller opened read-only", () => {
    // The case the public name exists for (ACCEPTANCE.md section 3 condition
    // 5): the evidence is taken off the live connection the report is measured
    // through, not off a second connection opened to prove a point about it.
    const path = productionDb(caseRoot("reader"));
    const before = digest(path);
    const connection = readOnlyConnection(path);
    try {
      connection.pragma("query_only = ON");
      expect(proveReadOnly(connection, path)).toBeUndefined();
      // The probe lowers the connection guard for one statement; a caller
      // handing over an armed connection must get it back armed, or the
      // harness disarmed itself while checking that it was armed.
      expect(connection.pragma("query_only", { simple: true })).toBe(1);
    } finally {
      connection.close();
    }
    expect(digest(path)).toBe(before);
    expect(sidecars(path)).toEqual([]);
  });

  test("the public probe refuses a writable connection", () => {
    // Same verdict openForMeasurement reaches when its open call has stopped
    // carrying the read-only flag -- reached here on a handle the caller
    // opened, since a report measured through a writable connection could have
    // changed the thing it was reporting.
    const path = productionDb(caseRoot("reader"));
    const before = digest(path);
    const connection = writableConnection(path);
    try {
      expectRefusal(
        () => proveReadOnly(connection, path),
        ReadOnlyCapabilityRefused,
        /was not opened read-only/,
      );
      expect(connection.pragma("query_only", { simple: true })).toBe(1);
    } finally {
      connection.close();
    }
    // The probe writes the user_version the file already holds and rolls back,
    // so even the connection that turned out to be writable changed nothing.
    expect(digest(path)).toBe(before);
    expect(sidecars(path)).toEqual([]);
  });

  test("the public probe refuses a busy database as inconclusive", () => {
    // The defect that made this probe public rather than copied: a writable
    // connection blocked by another writer's RESERVED lock raises the same
    // failure as a read-only file, and the earlier probe read that as proof.
    // "Could not be proved" and "was writable" are two different facts;
    // conflating them sends an operator to fix an open call that is not
    // broken, and it is how a live control plane certified a writable handle
    // as read-only.
    const path = productionDb(caseRoot("reader"));
    const writer = writableConnection(path);
    // timeout 0: with the default busy handler the blocked connection would
    // sit for five seconds before returning the very answer this test is
    // about.
    const blocked = writableConnection(path, { timeout: 0 });
    let refusal: ReadOnlyCapabilityRefused;
    try {
      writer.exec("BEGIN IMMEDIATE");
      refusal = expectRefusal(() => proveReadOnly(blocked, path), ReadOnlyCapabilityRefused);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
      blocked.close();
    }

    expect(refusal.message).toContain("inconclusive");
    expect(refusal.message).toContain("database is locked");
    expect(refusal.message).not.toContain("was not opened read-only");
  });

  test("query_only that does not take effect is refused", () => {
    // PRAGMA is a silent no-op for a name SQLite does not know, so "issued"
    // and "in force" are different states and only the read-back separates
    // them. Simulated here by handing the check a connection that answers 0.
    const path = productionDb(caseRoot("reader"));
    const connection = writableConnection(path);
    try {
      connection.pragma("query_only = OFF");
      expectRefusal(
        () => requireQueryOnly(path, connection, "in this test"),
        ReadOnlyCapabilityRefused,
        /query_only/,
      );
    } finally {
      connection.close();
    }
  });
});

// --------------------------------------------------------------------------
// the migrator's verification, reused rather than re-derived
// --------------------------------------------------------------------------

describe("the migrator's verification, reused", () => {
  test("a database behind this build is refused without being migrated", () => {
    const root = caseRoot("reader");
    const ledger = scratchLedger(root);
    const oneStep = join(root, "one_step");
    writeStep(oneStep, "0001_alpha.sql", readFileSync(join(ledger, "0001_alpha.sql"), "utf8"));
    const path = join(root, "behind.sqlite3");
    createProductionControlPlane(path, { nowMs: T0, migrationsDir: oneStep }).close();

    const before = digest(path);
    const refusal = expectRefusal(
      () => openForMeasurement(path, { migrationsDir: ledger }),
      ControlPlaneRefusal,
    );
    // Behind, specifically -- not the ahead refusal, which is a different
    // diagnosis with a different remedy.
    expect(refusal).not.toBeInstanceOf(DatabaseAheadOfCodeRefused);
    expect(refusal.message).toContain("never migrates");
    expect(digest(path)).toBe(before);
  });

  test("a database ahead of this build is refused", () => {
    const root = caseRoot("reader");
    const ledger = scratchLedger(root);
    const path = join(root, "ahead.sqlite3");
    createProductionControlPlane(path, { nowMs: T0, migrationsDir: ledger }).close();

    const oneStep = join(root, "one_step");
    writeStep(oneStep, "0001_alpha.sql", readFileSync(join(ledger, "0001_alpha.sql"), "utf8"));
    expectRefusal(
      () => openForMeasurement(path, { migrationsDir: oneStep }),
      DatabaseAheadOfCodeRefused,
    );
  });

  test("an applied step whose bytes changed is refused", () => {
    const root = caseRoot("reader");
    const ledger = scratchLedger(root);
    const path = join(root, "edited.sqlite3");
    createProductionControlPlane(path, { nowMs: T0, migrationsDir: ledger }).close();
    // The dangerous edit: harmless-looking, leaves the version untouched, and
    // is invisible from the version number alone.
    writeFileSync(
      join(ledger, "0002_beta.sql"),
      "CREATE TABLE beta (id INTEGER PRIMARY KEY, note TEXT);\n",
      "utf8",
    );
    expectRefusal(
      () => openForMeasurement(path, { migrationsDir: ledger }),
      MigrationChecksumRefused,
    );
  });

  test("an absent database is refused rather than measured as empty", () => {
    // An absent database is not an empty one. Measured as empty it reports
    // zero incidents and a perfect miss rate.
    const root = caseRoot("reader");
    expectRefusal(
      () => openForMeasurement(join(root, "nothing-here.sqlite3")),
      MissingStateRefused,
    );
  });

  test("a file that is not a database is refused", () => {
    const root = caseRoot("reader");
    const path = join(root, "not-a-database.sqlite3");
    writeFileSync(path, "this is not an SQLite file");
    expectRefusal(() => openForMeasurement(path), CorruptStateRefused);
  });
});

// --------------------------------------------------------------------------
// opening writes nothing at all
// --------------------------------------------------------------------------

describe("opening writes nothing", () => {
  test("opening leaves the file byte-identical and makes no sidecar", () => {
    // Interlock's v1 reporter promoted the database it read to WAL, which is a
    // write to the file and creates a -wal companion. Hashing the bytes
    // catches the promotion, the journal and any accidental page write in one
    // assertion.
    const path = productionDb(caseRoot("reader"));
    const before = digest(path);
    const connection = openForMeasurement(path);
    try {
      connection.prepare("SELECT COUNT(*) FROM schema_migration").get();
      expect(sidecars(path)).toEqual([]);
    } finally {
      connection.close();
    }
    expect(digest(path)).toBe(before);
    expect(sidecars(path)).toEqual([]);
  });

  test("a refused open writes nothing either", () => {
    // A database on its way to a refusal must not be written to on the way,
    // not even a rollback journal: the operator's next move after a checksum
    // refusal is forensic, and an instrument that touched the evidence has
    // spoiled it.
    const root = caseRoot("reader");
    const ledger = scratchLedger(root);
    const path = join(root, "ahead.sqlite3");
    createProductionControlPlane(path, { nowMs: T0, migrationsDir: ledger }).close();
    const oneStep = join(root, "one_step");
    writeStep(oneStep, "0001_alpha.sql", readFileSync(join(ledger, "0001_alpha.sql"), "utf8"));

    const before = digest(path);
    expectRefusal(
      () => openForMeasurement(path, { migrationsDir: oneStep }),
      DatabaseAheadOfCodeRefused,
    );
    expect(digest(path)).toBe(before);
    expect(sidecars(path)).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// "never migrates, never takes a lease" as a structural property
// --------------------------------------------------------------------------

/**
 * Every name `src/measurement/reader.ts` imports, and every module it imports
 * from.
 *
 * Interlock walks the module's Python AST for `Import` / `ImportFrom` nodes.
 * The property is the same and so is the granularity -- module paths and the
 * bound names -- but the parser is not: continuo has no AST of its own to walk
 * and adding one for a single test would be a dependency this port does not
 * otherwise need. The scan is deliberately over the **source text**, which is
 * the artifact the claim is about: an import added later has to appear here.
 *
 * ESM's static import form is what makes a regular expression sufficient where
 * it would not be for Python: every import is a top-level statement of a fixed
 * shape, `import` cannot appear inside a function, and a dynamic `import()`
 * would not match the pattern -- so the sweep also asserts, separately, that
 * the module contains no dynamic import that could smuggle a writer in.
 */
function importedNames(sourcePath: string): Set<string> {
  const source = readFileSync(sourcePath, "utf8");
  const names = new Set<string>();
  const pattern = /^import\s+(?:type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) {
    const clause = match[1] ?? "";
    const module = match[2] ?? "";
    names.add(module);
    for (const binding of clause.replace(/[{}]/g, " ").split(",")) {
      // `a as b` binds b and names a; both are recorded, as Python records
      // both the imported name and its alias.
      for (const part of binding.split(/\s+as\s+/)) {
        const name = part.replace(/^\s*(?:type)\s+/, "").trim();
        if (name !== "" && name !== "*") {
          names.add(name);
          names.add(`${module}.${name}`);
        }
      }
    }
  }
  return names;
}

const READER_SOURCE = fileURLToPath(new URL("../../src/measurement/reader.ts", import.meta.url));

describe("never migrates, never takes a lease", () => {
  test("the opener imports no writer and no lease", () => {
    // Structural, because "the harness never migrates and holds no lease"
    // (measurement-harness.md section 1, interlock D-0040) is a claim about
    // capability: a module that cannot name migrateControlPlane cannot call
    // it, whereas a module that merely does not call it today is one edit from
    // doing so, and that edit reads as innocuous in review. The same argument
    // covers the lease -- an instrument with a writer epoch could produce a
    // fenced write.
    const imported = importedNames(READER_SOURCE);
    const forbidden = [
      "migrateControlPlane",
      "createProductionControlPlane",
      "openProductionControlPlane",
    ];
    expect(forbidden.filter((name) => imported.has(name))).toEqual([]);
    expect([...imported].filter((name) => name.toLowerCase().includes("lease"))).toEqual([]);
    expect([...imported].filter((name) => name.toLowerCase().includes("txn"))).toEqual([]);
    // The half ESM adds: a dynamic import would carry the same capability past
    // the static scan above.
    expect(readFileSync(READER_SOURCE, "utf8")).not.toMatch(/\bimport\s*\(/);
  });

  test("the opener reuses the migrator's verifier rather than its own", () => {
    // The other half of the same property: the identity rules live in one
    // place.
    const imported = importedNames(READER_SOURCE);
    expect(imported.has("verifyProductionDatabase")).toBe(true);
    // Interlock also asserts `reader.verify_production_database is
    // m.verify_production_database`. In ESM a named import *is* the exporting
    // module's binding -- there is no module dictionary to rebind and no way
    // for the imported name to be a copy -- so the import above, taken
    // together with the module it names, is that identity rather than evidence
    // for it.
    expect(imported.has("../control_plane/migrator.js.verifyProductionDatabase")).toBe(true);
  });

  test("the package exports no way to write", () => {
    const offenders = Object.keys(measurementPackage).filter((name) =>
      ["migrate", "create", "write", "lease"].some((word) => name.toLowerCase().includes(word)),
    );
    expect(offenders).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// the report snapshot -- one state for the whole report, and what it costs
// --------------------------------------------------------------------------

function runCount(connection: SqliteDatabase): number {
  return (connection.prepare("SELECT count(*) AS n FROM run").get() as { n: number }).n;
}

function insertARun(connection: SqliteDatabase, runId: string): void {
  connection
    .prepare(
      "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'completed', ?, ?)",
    )
    .run(runId, T0, T0);
}

describe("the report snapshot", () => {
  test("a writer cannot move the database under an open snapshot", () => {
    // The defect the snapshot exists for: without a held read transaction
    // every statement of a report is its own SQLite snapshot, so a writer
    // committing mid-report puts the figures and the fingerprint on different
    // states of the database (measurement-harness.md section 6).
    const path = productionDb(caseRoot("reader"));
    const connection = openForMeasurement(path);
    // timeout 0: the blocked writer must answer now rather than sit on the
    // default busy handler, which would make this test slow and say nothing
    // more.
    const writer = writableConnection(path, { timeout: 0 });
    try {
      let before = 0;
      measurementSnapshot(connection, { target: path }, () => {
        before = runCount(connection);
        expectSqliteError(() => insertARun(writer, "run-mid-report"), { message: /locked/ });
        expect(runCount(connection)).toBe(before);
      });
      // ...and the lock is released when the snapshot closes, so the writer
      // that was blocked is blocked for the report's duration and no longer.
      insertARun(writer, "run-after-report");
      expect(runCount(connection)).toBe(before + 1);
    } finally {
      writer.close();
      connection.close();
    }
  });

  test("an asynchronous report body is refused, not awaited (target-only)", () => {
    // Target-only: this translates no source case and is not counted as ported
    // coverage. It guards a hazard the TRANSLATION introduced and interlock
    // cannot have (D-0103).
    //
    // Interlock's `measurement_snapshot` is a `@contextmanager` used with
    // `with`, and a `with` body cannot return early and carry on later. The
    // TypeScript form is a callback, and an `async` one returns a pending
    // Promise at its first await -- at which point the `finally` would release
    // the snapshot and every read after the await would run on its own state of
    // the database. That is silently the exact defect the snapshot exists to
    // remove.
    //
    // The callback type rejects this at compile time; the cast here is what an
    // untyped JavaScript caller does, and it is the runtime half being pinned.
    const path = productionDb(caseRoot("reader"));
    const connection = openForMeasurement(path);
    try {
      const asyncBody = async () => {
        await Promise.resolve();
        return 1;
      };
      expectRefusal(
        () =>
          measurementSnapshot(
            connection,
            { target: path },
            asyncBody as unknown as (connection: SqliteDatabase) => number,
          ),
        AsynchronousReportRefused,
        /asynchronous report body/,
      );
      // Refusing must not also leak the lock it refused to hold: the check runs
      // inside the try, so the snapshot is released on the way out.
      expect(connection.inTransaction).toBe(false);
    } finally {
      connection.close();
    }
  });

  test("the snapshot holds the read lock before the body runs (target-only)", () => {
    // Target-only: this translates no source case and is not counted as ported
    // coverage. It exists because a mutation sweep found the property
    // unguarded on BOTH sides.
    //
    // SQLite's `BEGIN` is DEFERRED and acquires nothing until a statement
    // actually reads, so `measurementSnapshot` issues a read of its own before
    // handing control to the body. Delete that read and the database is still
    // free to move under everything up to the report's first query -- which is
    // the entire defect the snapshot exists to remove.
    //
    // The source's own case for the snapshot cannot see this: it calls
    // `_run_count(connection)` as the first statement inside the scope, and
    // that read takes the SHARED lock the materialising read was supposed to
    // have taken already. The assertion then passes either way. So this case
    // challenges the writer FIRST, before the body has read anything, which is
    // the only arrangement that can tell the two implementations apart.
    const path = productionDb(caseRoot("reader"));
    const connection = openForMeasurement(path);
    const writer = writableConnection(path, { timeout: 0 });
    try {
      measurementSnapshot(connection, { target: path }, () => {
        // No read before this point, deliberately.
        expectSqliteError(() => insertARun(writer, "run-before-the-first-read"), {
          message: /locked/,
        });
      });
    } finally {
      writer.close();
      connection.close();
    }
  });

  test("both read-only mechanisms are still in force inside the snapshot", () => {
    // A snapshot is a transaction, and a transaction is the shape a write
    // comes in: if holding one had cost the connection either mechanism, the
    // fix for the moving database would have bought it with the capability
    // that makes the harness an instrument.
    const path = productionDb(caseRoot("reader"));
    const before = digest(path);
    const connection = openForMeasurement(path);
    try {
      measurementSnapshot(connection, { target: path }, () => {
        expect(connection.pragma("query_only", { simple: true })).toBe(1);
        expectReadOnlyRefusal(() => connection.exec(A_VALID_WRITE));
        // The read-only open flag, proved off the live connection inside the
        // snapshot: the probe has to work here or a caller who holds a report
        // open cannot evidence the capability the report is measured through.
        expect(proveReadOnly(connection, path)).toBeUndefined();
        expect(connection.pragma("query_only", { simple: true })).toBe(1);
      });
    } finally {
      connection.close();
    }
    expect(digest(path)).toBe(before);
    expect(sidecars(path)).toEqual([]);
  });

  test("a snapshot inside a snapshot is refused", () => {
    // Nesting would silently do nothing -- the inner BEGIN would fail or the
    // inner exit would end the outer snapshot early -- so it is a refusal with
    // a message rather than a second scope that reads as if it worked.
    const path = productionDb(caseRoot("reader"));
    const connection = openForMeasurement(path);
    try {
      measurementSnapshot(connection, { target: path }, () => {
        expectRefusal(
          () =>
            measurementSnapshot(connection, { target: path }, () => {
              /* never reached */
            }),
          NestedSnapshotRefused,
        );
        // The outer snapshot survived the refusal.
        expect(connection.inTransaction).toBe(true);
      });
    } finally {
      connection.close();
    }
  });

  test("the snapshot is released even when the report raises", () => {
    const path = productionDb(caseRoot("reader"));
    const connection = openForMeasurement(path);
    const writer = writableConnection(path, { timeout: 0 });
    try {
      // Interlock raises ZeroDivisionError, which has no TypeScript analogue;
      // the property is that *whatever* the report throws travels out and the
      // snapshot is released anyway, so the class is arbitrary and only its
      // identity across the boundary is asserted.
      class TheReportFailed extends Error {}
      expectRefusal(
        () =>
          measurementSnapshot(connection, { target: path }, () => {
            runCount(connection);
            throw new TheReportFailed("the report failed halfway");
          }),
        TheReportFailed,
        /the report failed halfway/,
      );
      expect(connection.inTransaction).toBe(false);
      // A snapshot left open would block every writer on the control plane for
      // as long as the process lived, which is why the release is in a finally
      // rather than at the end of the body.
      insertARun(writer, "run-after-the-failure");
    } finally {
      writer.close();
      connection.close();
    }
  });

  test("the snapshot refuses a connection whose guard is down", () => {
    const path = productionDb(caseRoot("reader"));
    const connection = openForMeasurement(path);
    try {
      connection.pragma("query_only = OFF");
      expectRefusal(
        () =>
          measurementSnapshot(connection, { target: path }, () => {
            /* never reached */
          }),
        ReadOnlyCapabilityRefused,
      );
      expect(connection.inTransaction).toBe(false);
    } finally {
      connection.close();
    }
  });
});
