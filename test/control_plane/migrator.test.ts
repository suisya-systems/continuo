/**
 * The production migrator -- every rule of production-schema.md section 3.2.
 *
 * Ported from interlock `tests/control_plane/test_migrator.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping, and the four cases
 * that are adapted or deferred rather than translated straight, are recorded in
 * `parity/control-plane.ledger.json`.
 *
 * Section 3.2 is six numbered rules, and each of them is here as an executable
 * property rather than as prose: forward-only with no reverse step, one step per
 * transaction, checksum verification on every open, refusal of a database ahead
 * of the code, migration only by an explicit call, and corrupt state refused
 * rather than recovered as empty. They are written against the artifact, not
 * against a description of it, because the failures they guard are silent ones:
 * a step skipped for being misnamed, a historical step edited after it ran, an
 * opener that quietly migrates the database a read-only report was pointed at.
 * None of those announce themselves, so the test has to be the thing that
 * notices.
 *
 * Most cases run against a **scratch ledger** in a per-test temporary directory
 * rather than against the real `migrations/` directory. The discipline under
 * test is the migrator's, not `0001_initial.sql`'s: a scratch ledger can be
 * given a hole, a duplicate number, or a step that fails halfway, and the real
 * one deliberately cannot. `migrationsDir` exists as a parameter for exactly
 * this and for nothing else.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { openControlPlaneConnection } from "../../src/control_plane/connection.js";
import * as m from "../../src/control_plane/migrator.js";
import {
  createProductionControlPlane,
  discoverMigrationSteps,
  headVersion,
  MIGRATIONS_DIR,
  migrateControlPlane,
  migratorSeams,
  openProductionControlPlane,
  PRODUCTION_APPLICATION_ID,
  renderCurrentSchema,
} from "../../src/control_plane/migrator.js";
import {
  ControlPlaneRefusal,
  CorruptStateRefused,
  DatabaseAheadOfCodeRefused,
  MigrationChecksumRefused,
  MigrationStepsRefused,
  MissingStateRefused,
} from "../../src/control_plane/refusals.js";
import { SPIKE_APPLICATION_ID } from "../../src/control_plane/spike.js";
import {
  bytesOf,
  caseRoot,
  databasePath,
  ledgerRows,
  rawConnection,
  rowsOf,
  sidecars,
  tablesOf,
  versionOf,
  writeStep,
  writeStepBytes,
} from "../testkit/cases.js";
import { chdirForTest } from "../testkit/cwd.js";
import { expectRefusal, expectSqliteError } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const T1 = T0 + 60_000;
const T2 = T0 + 120_000;

// --------------------------------------------------------------------------
// fixtures -- a scratch ledger whose steps can be as broken as the case needs
// --------------------------------------------------------------------------

/**
 * The source's `ledger` and `db_path` fixtures, as one call.
 *
 * pytest composes them through the shared `tmp_path`: both live in the same
 * per-test directory, and several cases derive sibling directories from
 * `ledger.parent`. Returning the root alongside them keeps that relationship
 * explicit instead of leaving it to be rediscovered from a `join("..")`.
 */
function scratch(): { root: string; ledger: string; dbPath: string } {
  const root = caseRoot("migrator");
  const ledger = join(root, "ledger");
  writeStep(ledger, "0001_alpha.sql", "CREATE TABLE alpha (id INTEGER PRIMARY KEY);\n");
  writeStep(ledger, "0002_beta.sql", "CREATE TABLE beta (id INTEGER PRIMARY KEY);\n");
  return { root, ledger, dbPath: databasePath(root) };
}

/** A build that knows step 0001 only -- the older half of a rolling deploy. */
function olderBuildLedger(root: string, ledger: string): string {
  const older = join(root, "older-build");
  writeStep(older, "0001_alpha.sql", readFileSync(join(ledger, "0001_alpha.sql"), "utf8"));
  return older;
}

/**
 * Let a newer build migrate `dbPath` after verification and before connect.
 *
 * The window is driven deterministically rather than by timing: the real
 * `verifyReadonly` runs, and the newer build's migration is spliced in
 * immediately after it returns -- exactly where the closed read-only connection
 * leaves the file unobserved.
 *
 * The re-patch from inside the wrapper is the source's, and it is why the seam
 * helper snapshots at each patch and unwinds LIFO: undoing only the outermost
 * patch would leave the wrapper armed for the rest of the file.
 */
function migrateInTheGap(ledger: string, dbPath: string): void {
  const real = migratorSeams.verifyReadonly;
  patchSeam(migratorSeams, "verifyReadonly", (target, steps, requireLedger) => {
    const applied = real(target, steps, requireLedger);
    patchSeam(migratorSeams, "verifyReadonly", real); // once, not on re-verification
    migrateControlPlane(dbPath, { nowMs: T1, migrationsDir: ledger }).close();
    return applied;
  });
}

// --------------------------------------------------------------------------
// rule 1 -- forward-only. There are no down migrations.
// --------------------------------------------------------------------------

const REVERSE_WORDS = [
  "down",
  "rollback",
  "revert",
  "unapply",
  "undo",
  "reverse",
  "backward",
] as const;

describe("rule 1 -- forward-only", () => {
  test("the module exposes no down migration api", () => {
    // A reverse step that has never been exercised is a promise the recovery
    // path cannot keep (section 3.2 rule 1), so the guarantee is asserted as an
    // absence of surface rather than as a docstring: there is nothing a caller
    // could reach for even by accident. A rollback is a restore of the file.
    //
    // Adapted from `dir(m)`, which has no ESM analogue. Two halves, and both
    // are needed: the namespace catches what a caller can import, and the
    // source scan catches an export that exists but is not re-exported through
    // the namespace under test. The `__all__ <= public` half of the source
    // assertion is dropped -- TypeScript has no `__all__`, and there is nothing
    // for it to mean.
    const exported = Object.keys(m);
    // Anti-vacuity: an import that resolved to an empty namespace would make
    // every assertion below pass while proving nothing at all.
    expect(exported.length).toBeGreaterThan(0);

    const seamKeys = Object.keys(migratorSeams);
    const offenders = [...exported, ...seamKeys].filter((name) =>
      REVERSE_WORDS.some((word) => name.toLowerCase().includes(word)),
    );
    expect(offenders).toEqual([]);

    const source = readFileSync(
      fileURLToPath(new URL("../../src/control_plane/migrator.ts", import.meta.url)),
      "utf8",
    );
    const declared = [
      ...source.matchAll(/export (?:function|const|class|interface|type) (\w+)/g),
    ].map((match) => match[1] as string);
    expect(declared.length).toBeGreaterThan(0);
    expect(
      declared.filter((name) => REVERSE_WORDS.some((word) => name.toLowerCase().includes(word))),
    ).toEqual([]);
  });

  test("no step file carries a reverse half", () => {
    // The other place a down migration could hide: a paired 0003_x.down.sql, or
    // a step whose own name advertises an undo. Discovery would refuse the
    // former by filename anyway; this says it is not written in the first place.
    const entries = readdirSync(MIGRATIONS_DIR);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        REVERSE_WORDS.some((word) => entry.toLowerCase().includes(word)),
        entry,
      ).toBe(false);
    }
  });
});

// --------------------------------------------------------------------------
// rule 2 -- one step, one transaction
// --------------------------------------------------------------------------

describe("rule 2 -- one step, one transaction", () => {
  test("a step whose second statement fails leaves no trace of its first", () => {
    // The precise failure this guards: a step applied statement-by-statement
    // OUTSIDE a transaction leaves the database carrying the half that ran, at
    // a version nobody applied. Two statements, the second unrunnable.
    const { root, ledger, dbPath } = scratch();
    writeStep(
      ledger,
      "0003_half.sql",
      "CREATE TABLE gamma (id INTEGER PRIMARY KEY);\n" +
        "INSERT INTO no_such_table (id) VALUES (1);\n",
    );

    expectRefusal(
      () => createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }),
      MigrationStepsRefused,
      /0003_half\.sql/,
    );

    // create() unlinks a database it could not finish, so the surviving
    // evidence is that nothing was left behind at all.
    expect(existsSync(dbPath)).toBe(false);

    // Now the same failure against a database that already exists, where the
    // previous version is a real place to be left at rather than nothing.
    const good = join(root, "good");
    writeStep(good, "0001_alpha.sql", readFileSync(join(ledger, "0001_alpha.sql"), "utf8"));
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: good }).close();

    // 0002 applies and commits; 0003 fails and is rolled back, so the database
    // is left at 2 -- the previous version, not the one that failed.
    expectRefusal(
      () => migrateControlPlane(dbPath, { nowMs: T1, migrationsDir: ledger }),
      MigrationStepsRefused,
      /still at version 2/,
    );

    expect(versionOf(dbPath)).toEqual([2, 2]);
    const present = tablesOf(dbPath);
    expect(present).toContain("alpha");
    // 0002 ran in a transaction of its own and stays committed; only the failed
    // step's half is rolled back, which is what "one step, one transaction"
    // means as distinct from "one migration call, one transaction".
    expect(present).toContain("beta");
    expect(present).not.toContain("gamma");
    expect(ledgerRows(dbPath).map((row) => row["version"])).toEqual([1, 2]);
  });

  test("each step commits with its own ledger row", () => {
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();

    const rows = ledgerRows(dbPath);
    expect(rows.map((row) => row["version"])).toEqual([1, 2]);
    expect(rows.map((row) => row["name"])).toEqual(["alpha", "beta"]);
    // applied_at_ms is the caller's clock verbatim: no DEFAULT, no strftime.
    expect(new Set(rows.map((row) => row["applied_at_ms"]))).toEqual(new Set([T0]));
    for (const row of rows) {
      const version = String(row["version"]).padStart(4, "0");
      const step = readFileSync(join(ledger, `${version}_${String(row["name"])}.sql`));
      expect(row["checksum"]).toBe(createHash("sha256").update(step).digest("hex"));
    }
  });
});

// --------------------------------------------------------------------------
// rule 3 -- an applied step is checksum-verified on every open
// --------------------------------------------------------------------------

describe("rule 3 -- checksum verification", () => {
  test("an applied step whose bytes changed is refused naming both checksums", () => {
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();
    const recorded = ledgerRows(dbPath)[0]?.["checksum"] as string;

    const step = join(ledger, "0001_alpha.sql");
    writeFileSync(
      step,
      `${readFileSync(step, "utf8")}-- a clarifying comment, added later\n`,
      "utf8",
    );
    const nowHashesTo = createHash("sha256").update(readFileSync(step)).digest("hex");
    expect(nowHashesTo).not.toBe(recorded);

    const refusal = expectRefusal(
      () => openProductionControlPlane(dbPath, { migrationsDir: ledger }),
      MigrationChecksumRefused,
    );

    // Both digests, because the operator's question is which of the two
    // artifacts moved, and an error naming only one cannot answer it.
    expect(refusal.message).toContain(recorded);
    expect(refusal.message).toContain(nowHashesTo);
    expect(refusal.message).toContain("0001_alpha.sql");

    // And migrating is not the escape hatch: the divergence is reported before
    // anything is applied, so migration never papers over it.
    expectRefusal(
      () => migrateControlPlane(dbPath, { nowMs: T1, migrationsDir: ledger }),
      MigrationChecksumRefused,
    );
  });

  test("renaming an applied step is the same refusal", () => {
    // The rename breaks the only link between a ledger row and the bytes it
    // attests to, even when those bytes are untouched.
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();
    renameSync(join(ledger, "0001_alpha.sql"), join(ledger, "0001_alpha_renamed.sql"));

    expectRefusal(
      () => openProductionControlPlane(dbPath, { migrationsDir: ledger }),
      MigrationChecksumRefused,
      /renamed/,
    );
  });

  test("a checksum refusal does not write to the database", () => {
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();
    const before = bytesOf(dbPath);
    const step = join(ledger, "0002_beta.sql");
    writeFileSync(step, `${readFileSync(step, "utf8")}-- edited\n`, "utf8");

    expectRefusal(
      () => openProductionControlPlane(dbPath, { migrationsDir: ledger }),
      MigrationChecksumRefused,
    );

    // Verification runs over a read-only connection precisely so that a
    // database on its way to being refused is not written to -- not even a
    // rollback journal it would then have to recover from.
    expect(bytesOf(dbPath).equals(before)).toBe(true);
    expect(sidecars(dbPath)).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// rule 4 -- a database ahead of the code is refused, never downgraded
// --------------------------------------------------------------------------

describe("rule 4 -- ahead of the code", () => {
  test("a database ahead of the code is refused and left at its own version", () => {
    const { root, ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();

    const olderBuild = olderBuildLedger(root, ledger);
    expect(headVersion(discoverMigrationSteps(olderBuild))).toBe(1);

    expectRefusal(
      () => openProductionControlPlane(dbPath, { migrationsDir: olderBuild }),
      DatabaseAheadOfCodeRefused,
      /only up to 1/,
    );
    expectRefusal(
      () => migrateControlPlane(dbPath, { nowMs: T1, migrationsDir: olderBuild }),
      DatabaseAheadOfCodeRefused,
    );

    // Never downgraded: the newer build's table is still there, the ledger row
    // for it is still there, and the version has not moved.
    expect(versionOf(dbPath)).toEqual([2, 2]);
    expect(tablesOf(dbPath)).toContain("beta");
    expect(ledgerRows(dbPath).map((row) => row["version"])).toEqual([1, 2]);
  });
});

// --------------------------------------------------------------------------
// rule 5 -- behind the code is migrated, and only by an explicit call
// --------------------------------------------------------------------------

describe("rule 5 -- migration is an explicit call", () => {
  test("opening a database behind the code refuses instead of migrating", () => {
    const { root, ledger, dbPath } = scratch();
    const firstOnly = join(root, "first-only");
    writeStep(firstOnly, "0001_alpha.sql", readFileSync(join(ledger, "0001_alpha.sql"), "utf8"));
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: firstOnly }).close();
    const before = bytesOf(dbPath);

    // The source matches on the Python function name. Function names appearing
    // in refusal text are the target's names (docs/test-translation-conventions.md);
    // the property -- that the refusal tells the operator what to call -- is
    // unchanged.
    expectRefusal(
      () => openProductionControlPlane(dbPath, { migrationsDir: ledger }),
      ControlPlaneRefusal,
      /migrateControlPlane/,
    );

    // This is the measurement harness's read-only guarantee (D-0040,
    // measurement-harness.md section 1) reduced to its one testable fact: the
    // opener is incapable of writing DDL, so a report tool pointed at a stale
    // production database cannot become the thing that migrated it. v1's
    // org_metrics_report.py documents that exact accident.
    expect(bytesOf(dbPath).equals(before)).toBe(true);
    expect(versionOf(dbPath)).toEqual([1, 1]);
    expect(tablesOf(dbPath)).not.toContain("beta");
    expect(sidecars(dbPath)).toEqual([]);
  });

  test("the explicit call is what migrates and then opening succeeds", () => {
    const { root, ledger, dbPath } = scratch();
    const firstOnly = join(root, "first-only");
    writeStep(firstOnly, "0001_alpha.sql", readFileSync(join(ledger, "0001_alpha.sql"), "utf8"));
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: firstOnly }).close();

    const migrated = migrateControlPlane(dbPath, { nowMs: T1, migrationsDir: ledger });
    try {
      expect(versionOf(dbPath)).toEqual([2, 2]);
      expect(tablesOf(dbPath)).toContain("beta");
      // The clock of each step is the clock of the call that applied it, so
      // the ledger says when each step ran rather than when the file was last
      // touched.
      expect(ledgerRows(dbPath).map((row) => row["applied_at_ms"])).toEqual([T0, T1]);
    } finally {
      migrated.close();
    }

    const opened = openProductionControlPlane(dbPath, { migrationsDir: ledger });
    try {
      expect(opened.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      opened.close();
    }
  });

  test("migrating an at-head database twice is a no-op", () => {
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();
    const before = ledgerRows(dbPath);

    migrateControlPlane(dbPath, { nowMs: T1, migrationsDir: ledger }).close();

    const after = ledgerRows(dbPath);
    expect(after).toEqual(before);
    expect(after).toHaveLength(2);
    // T1 appears nowhere: a no-op migration writes no row, so the ledger cannot
    // accumulate one entry per process start and misreport when a step ran.
    expect(new Set(after.map((row) => row["applied_at_ms"])).has(T1)).toBe(false);
    expect(versionOf(dbPath)).toEqual([2, 2]);
  });

  test("migrating never creates a database", () => {
    const { ledger, dbPath } = scratch();
    expectRefusal(
      () => migrateControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }),
      MissingStateRefused,
    );
    expect(existsSync(dbPath)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// the ledger is evidence: immutable and undeletable
// --------------------------------------------------------------------------

describe("the ledger is evidence", () => {
  test("a schema_migration row cannot be updated", () => {
    const { ledger, dbPath } = scratch();
    const connection = createProductionControlPlane(dbPath, {
      nowMs: T0,
      migrationsDir: ledger,
    });
    try {
      // Both halves of the source's `pytest.raises(sqlite3.IntegrityError,
      // match="written once")`: the trigger's abort is a constraint failure,
      // which is what `IntegrityError` names, and the message is the trigger's.
      expectSqliteError(
        () =>
          connection
            .prepare("UPDATE schema_migration SET checksum = ? WHERE version = 1")
            .run("0".repeat(64)),
        { code: /^SQLITE_CONSTRAINT/, message: /written once/ },
      );
      expect(rowCount(connection)).toBe(2);
    } finally {
      connection.close();
    }
  });

  test("a schema_migration row cannot be deleted", () => {
    const { ledger, dbPath } = scratch();
    const connection = createProductionControlPlane(dbPath, {
      nowMs: T0,
      migrationsDir: ledger,
    });
    try {
      // Deleting the row is the other way to make an edited step verify: with
      // no row there is no recorded checksum to contradict the new bytes.
      expectSqliteError(
        () => connection.prepare("DELETE FROM schema_migration WHERE version = 1").run(),
        { code: /^SQLITE_CONSTRAINT/, message: /never deleted/ },
      );
      expect(rowCount(connection)).toBe(2);
    } finally {
      connection.close();
    }
  });
});

function rowCount(connection: ReturnType<typeof openControlPlaneConnection>): number {
  return (connection.prepare("SELECT COUNT(*) AS n FROM schema_migration").get() as { n: number })
    .n;
}

// --------------------------------------------------------------------------
// discovery -- a badly formed ledger is a refusal, never a silent skip
// --------------------------------------------------------------------------

describe("discovery", () => {
  test("a numbering gap is refused", () => {
    const root = caseRoot("migrator");
    const directory = join(root, "gap");
    writeStep(directory, "0001_alpha.sql", "CREATE TABLE alpha (id INTEGER);\n");
    writeStep(directory, "0003_gamma.sql", "CREATE TABLE gamma (id INTEGER);\n");

    expectRefusal(
      () => discoverMigrationSteps(directory),
      MigrationStepsRefused,
      /jumps from 1 to 3/,
    );
  });

  test("a duplicate version prefix is refused", () => {
    const root = caseRoot("migrator");
    const directory = join(root, "dupe");
    writeStep(directory, "0001_alpha.sql", "CREATE TABLE alpha (id INTEGER);\n");
    writeStep(directory, "0002_beta.sql", "CREATE TABLE beta (id INTEGER);\n");
    writeStep(directory, "0002_beta_again.sql", "CREATE TABLE beta2 (id INTEGER);\n");

    expectRefusal(
      () => discoverMigrationSteps(directory),
      MigrationStepsRefused,
      /both claim version 2/,
    );
  });

  parametrize(
    "a malformed step filename is refused not skipped",
    [
      ["0002-fix.sql", "0002-fix.sql"], // hyphen where the convention has an underscore
      ["0002_Fix.sql", "0002_Fix.sql"], // upper case, which sorts and reads differently
      ["two_fix.sql", "two_fix.sql"], // no version at all
      ["002_fix.sql", "002_fix.sql"], // three digits: sorts wrong the moment there are 10 steps
      ["0002_.sql", "0002_.sql"], // a version with no name
    ],
    (filename) => {
      const root = caseRoot("migrator");
      const directory = join(root, "malformed");
      writeStep(directory, "0001_alpha.sql", "CREATE TABLE alpha (id INTEGER);\n");
      writeStep(directory, filename, "CREATE TABLE other (id INTEGER);\n");

      // Skipping it would be the dangerous outcome: a schema change that
      // happened on the databases whose operator ran the file by hand and not
      // on the rest, with no error anywhere to say so.
      expectRefusal(
        () => discoverMigrationSteps(directory),
        MigrationStepsRefused,
        /not a migration step name/,
      );
    },
  );

  test("a step numbered zero is refused", () => {
    const root = caseRoot("migrator");
    const directory = join(root, "zero");
    writeStep(directory, "0000_zero.sql", "CREATE TABLE zero (id INTEGER);\n");

    expectRefusal(
      () => discoverMigrationSteps(directory),
      MigrationStepsRefused,
      /versions start at 1/,
    );
  });

  test("an absent ledger directory is a broken build not an empty ledger", () => {
    const root = caseRoot("migrator");
    expectRefusal(
      () => discoverMigrationSteps(join(root, "nowhere")),
      MigrationStepsRefused,
      /is not a directory/,
    );
  });

  test("an empty ledger directory is a broken build not a schema at version zero", () => {
    // The wheel that shipped without its .sql package data lands here: the
    // directory exists because it is a package, and every step in it is gone.
    // Treated as an empty migration set it would produce a "production"
    // database with no control-plane tables in it whose version -- 0 -- equals
    // this build's head, so the opener would then call it current. That is
    // corrupt state recovered as empty (section 3.2 rule 6, R3).
    const root = caseRoot("migrator");
    const dbPath = databasePath(root);
    const directory = join(root, "empty");
    mkdirSync(directory);
    writeFileSync(join(directory, "__init__.py"), "", "utf8");

    expectRefusal(
      () => discoverMigrationSteps(directory),
      MigrationStepsRefused,
      /contains no migration steps/,
    );

    expectRefusal(
      () => createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: directory }),
      MigrationStepsRefused,
      /contains no migration steps/,
    );
    expect(existsSync(dbPath)).toBe(false);
  });

  parametrize(
    "a file that looks like a step but is not one is refused not skipped",
    [
      ["0002_beta.sql.bak", "0002_beta.sql.bak"], // an editor's backup of a real step
      ["0002_beta.sql~", "0002_beta.sql~"], // another editor's
      ["0002_beta.sql.rej", "0002_beta.sql.rej"], // a patch that did not apply
      ["notes.txt", "notes.txt"], // anything else that is not a packaging companion
    ],
    (filename) => {
      // A suffix test would pass over all of these in silence, which is the
      // very divergence STEP_FILENAME's comment claims is refused: the operator
      // who ran 0002_beta.sql.bak by hand has a database this build cannot
      // reproduce.
      const root = caseRoot("migrator");
      const directory = join(root, "leftovers");
      writeStep(directory, "0001_alpha.sql", "CREATE TABLE alpha (id INTEGER);\n");
      writeStep(directory, filename, "CREATE TABLE beta (id INTEGER);\n");

      expectRefusal(
        () => discoverMigrationSteps(directory),
        MigrationStepsRefused,
        /not a migration step name/,
      );
    },
  );

  test("the packaging companions are still skipped", () => {
    const root = caseRoot("migrator");
    const directory = join(root, "packaged");
    writeStep(directory, "0001_alpha.sql", "CREATE TABLE alpha (id INTEGER);\n");
    writeFileSync(join(directory, "__init__.py"), "", "utf8");
    writeFileSync(join(directory, "README.md"), "the ledger\n", "utf8");
    mkdirSync(join(directory, "__pycache__"));

    expect(discoverMigrationSteps(directory).map((step) => step.name)).toEqual(["alpha"]);
  });

  test("a step whose bytes are not utf8 is a typed refusal", () => {
    const root = caseRoot("migrator");
    const directory = join(root, "mojibake");
    writeStep(directory, "0001_alpha.sql", "CREATE TABLE alpha (id INTEGER);\n");
    // Built from an explicit byte array: the source's b"... \xff\n" is not
    // expressible as an ASCII source literal, and `Buffer.from(str)` would
    // encode U+00FF as two valid UTF-8 bytes, which decodes cleanly and
    // defeats the case.
    writeStepBytes(
      directory,
      "0002_beta.sql",
      Buffer.concat([
        Buffer.from("CREATE TABLE beta (id INTEGER); -- ", "ascii"),
        Buffer.from([0xff]),
        Buffer.from("\n", "ascii"),
      ]),
    );

    // Not a decoder error: every fault in this build reaches the caller as the
    // module's refusal family, or the caller cannot handle them uniformly.
    expectRefusal(
      () => discoverMigrationSteps(directory),
      MigrationStepsRefused,
      /not valid UTF-8/,
    );
  });

  test("a refused ledger creates no database", () => {
    const root = caseRoot("migrator");
    const dbPath = databasePath(root);
    const directory = join(root, "gap");
    writeStep(directory, "0002_beta.sql", "CREATE TABLE beta (id INTEGER);\n");

    expectRefusal(
      () => createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: directory }),
      MigrationStepsRefused,
    );
    expect(existsSync(dbPath)).toBe(false);
  });

  test("a step ending in an incomplete statement is refused", () => {
    const root = caseRoot("migrator");
    const dbPath = databasePath(root);
    const directory = join(root, "truncated");
    writeStep(directory, "0001_alpha.sql", "CREATE TABLE alpha (\n    id INTEGER\n");

    expectRefusal(
      () => createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: directory }),
      MigrationStepsRefused,
      /incomplete statement/,
    );
    expect(existsSync(dbPath)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// rule 6 -- corrupt state is refused, never recovered as empty
// --------------------------------------------------------------------------

describe("rule 6 -- corrupt state is refused", () => {
  test("user_version disagreeing with the ledger head is refused", () => {
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();
    const connection = rawConnection(dbPath);
    try {
      // The pragma is the cheap check and the table is the authority
      // (section 3.1); a disagreement means one was written by something that
      // did not write the other, so neither can be trusted afterwards.
      connection.pragma("user_version = 1");
    } finally {
      connection.close();
    }

    expectRefusal(
      () => openProductionControlPlane(dbPath, { migrationsDir: ledger }),
      CorruptStateRefused,
      /user_version/,
    );
    expect(versionOf(dbPath)).toEqual([2, 1]);
  });

  test("a ledger with a hole is refused", () => {
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();
    let connection = rawConnection(dbPath);
    try {
      // The delete trigger is the front door; this reaches around it the way a
      // hand-run sqlite3 session would, to prove the opener does not depend on
      // the trigger having been in force when the damage was done.
      connection.pragma("writable_schema = ON");
      connection
        .prepare("DELETE FROM sqlite_master WHERE name = 'schema_migration_rows_are_never_deleted'")
        .run();
      connection.pragma("writable_schema = OFF");
    } finally {
      connection.close();
    }
    connection = rawConnection(dbPath);
    try {
      connection.prepare("DELETE FROM schema_migration WHERE version = 1").run();
    } finally {
      connection.close();
    }
    // The sabotage has to have worked for the refusal below to mean anything.
    // Without this, a SQLite build that ignored the writable_schema edit would
    // leave the trigger in force, the delete would abort, and the case would
    // fail with a confusing mismatch instead of an explicit one.
    expect(ledgerRows(dbPath).map((row) => row["version"])).toEqual([2]);

    expectRefusal(
      () => openProductionControlPlane(dbPath, { migrationsDir: ledger }),
      CorruptStateRefused,
      /not contiguous/,
    );
  });

  test("a production database without its ledger is refused not rebuilt", () => {
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();
    const connection = rawConnection(dbPath);
    try {
      connection.exec("DROP TABLE schema_migration");
    } finally {
      connection.close();
    }

    expectRefusal(
      () => openProductionControlPlane(dbPath, { migrationsDir: ledger }),
      CorruptStateRefused,
      /no schema_migration table/,
    );
    // Not rebuilt behind the caller's back, and the rows it did hold survive.
    expect(tablesOf(dbPath)).not.toContain("schema_migration");
    expect(tablesOf(dbPath)).toContain("alpha");
  });

  test("an absent database is refused and not created", () => {
    const { ledger, dbPath } = scratch();
    expectRefusal(
      () => openProductionControlPlane(dbPath, { migrationsDir: ledger }),
      MissingStateRefused,
    );
    expect(existsSync(dbPath)).toBe(false);
  });

  test("a file that is not a database is refused and left alone", () => {
    const { ledger, dbPath } = scratch();
    writeFileSync(dbPath, "not a database, just a note someone left in the state directory");
    const before = bytesOf(dbPath);

    expectRefusal(
      () => openProductionControlPlane(dbPath, { migrationsDir: ledger }),
      CorruptStateRefused,
    );

    expect(bytesOf(dbPath).equals(before)).toBe(true);
    expect(sidecars(dbPath)).toEqual([]);
  });

  test("creating under a missing parent directory is a typed refusal", () => {
    // A bare ENOENT reads as "the database is absent", which is the opposite
    // diagnosis from the true one: the path was never creatable because nobody
    // made the directory it lives in.
    const { root, ledger } = scratch();
    const target = join(root, "nonexistent", "production.sqlite3");

    expectRefusal(
      () => createProductionControlPlane(target, { nowMs: T0, migrationsDir: ledger }),
      ControlPlaneRefusal,
      /could not be created/,
    );
    expect(existsSync(target)).toBe(false);
  });

  test("a write lock held by another writer is a typed refusal", () => {
    // The collision is forced for real: a second connection holds the write
    // lock for the whole attempt. It must arrive as this module's refusal
    // rather than as a raw SQLite error, and it must arrive only after the
    // busy_timeout has actually been waited out -- a deploy that fails
    // instantly on a racing reader is the failure the timeout exists to
    // prevent.
    //
    // Real timers throughout. Faking them would make the elapsed-time
    // assertion below instantly and vacuously true.
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();
    writeStep(ledger, "0003_gamma.sql", "CREATE TABLE gamma (id INTEGER);\n");
    patchSeam(migratorSeams, "migrationBusyTimeoutMs", 250);

    const blocker = rawConnection(dbPath);
    blocker.exec("BEGIN IMMEDIATE");
    blocker.exec("CREATE TABLE squatter (id INTEGER)");
    let waitedMs: number;
    try {
      const started = process.hrtime.bigint();
      expectRefusal(
        () => migrateControlPlane(dbPath, { nowMs: T1, migrationsDir: ledger }),
        MigrationStepsRefused,
        /could not take the write lock/,
      );
      waitedMs = Number(process.hrtime.bigint() - started) / 1e6;
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }

    // It waited, rather than failing the deploy at once. The threshold is 80%
    // of the patched timeout, as the source has it: raising it "to be safe" is
    // how a timing test becomes flaky on the slowest matrix cell.
    expect(waitedMs).toBeGreaterThanOrEqual(200);
    expect(versionOf(dbPath)).toEqual([2, 2]);
    expect(tablesOf(dbPath)).not.toContain("gamma");
  });

  test("creating over an existing path is refused", () => {
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();
    const before = bytesOf(dbPath);

    expectRefusal(
      () => createProductionControlPlane(dbPath, { nowMs: T1, migrationsDir: ledger }),
      ControlPlaneRefusal,
      /already exists/,
    );
    expect(bytesOf(dbPath).equals(before)).toBe(true);
  });

  parametrize<unknown>(
    "the clock must be an integer of epoch milliseconds",
    [
      ["None", null],
      ["1.5", 1.5],
      ["1700000000000", "1700000000000"],
      ["True", true],
    ],
    (badClock) => {
      // `True` is in the list on purpose. In Python it is an `int`, so a bool
      // would store 1 -- a timestamp in 1970 that the `typeof` CHECK cannot
      // catch, because SQLite sees a perfectly good integer. TypeScript's types
      // reject all four at compile time, so the values arrive here through a
      // cast: the guard exists for callers reaching this function from
      // JavaScript, where they arrive exactly as they do in Python.
      const { ledger, dbPath } = scratch();
      expect(() =>
        createProductionControlPlane(dbPath, {
          nowMs: badClock as unknown as number,
          migrationsDir: ledger,
        }),
      ).toThrow(TypeError);
      expect(existsSync(dbPath)).toBe(false);
    },
  );
});

// --------------------------------------------------------------------------
// the two databases are never mistaken for one another
// --------------------------------------------------------------------------

describe("the two databases never meet", () => {
  test("the production application id differs from the spike", () => {
    const { ledger, dbPath } = scratch();
    expect(PRODUCTION_APPLICATION_ID).not.toBe(SPIKE_APPLICATION_ID);
    const connection = createProductionControlPlane(dbPath, {
      nowMs: T0,
      migrationsDir: ledger,
    });
    try {
      expect(connection.pragma("application_id", { simple: true })).toBe(PRODUCTION_APPLICATION_ID);
    } finally {
      connection.close();
    }
  });

  // `a spike database is refused by the production opener` and `a production
  // database is refused by the spike opener` are NOT ported here. Both need
  // interlock's `control_plane/schema.py` -- the spike creator and the spike
  // opener -- which is out of this pilot's scope. They are recorded in the
  // parity ledger as not yet ported, with that reason, rather than satisfied by
  // stamping an application id by hand: a hand-built "spike database" would
  // exercise the same production-side branch while proving nothing about the
  // spike module, and the mirror case has no target-side function to call at
  // all.

  test("a foreign database is refused", () => {
    const { root, ledger } = scratch();
    const other = join(root, "someone-elses.sqlite3");
    const connection = rawConnection(other);
    connection.exec("CREATE TABLE notes (body TEXT)");
    connection.close();

    expectRefusal(
      () => openProductionControlPlane(other, { migrationsDir: ledger }),
      CorruptStateRefused,
      /application_id/,
    );
  });

  test("migrating a foreign database does not relabel it", () => {
    // claimBlankDatabase stamps only a database that is both unstamped and
    // empty; anything with objects in it falls through to the refusal by name,
    // so migration can never be the operation that adopts someone else's file.
    const { root, ledger } = scratch();
    const other = join(root, "someone-elses.sqlite3");
    const connection = rawConnection(other);
    connection.exec("CREATE TABLE notes (body TEXT)");
    connection.close();

    expectRefusal(
      () => migrateControlPlane(other, { nowMs: T0, migrationsDir: ledger }),
      CorruptStateRefused,
      /application_id/,
    );

    const inspect = rawConnection(other);
    try {
      expect(inspect.pragma("application_id", { simple: true })).toBe(0);
      expect(tablesOf(other)).not.toContain("schema_migration");
    } finally {
      inspect.close();
    }
  });
});

// --------------------------------------------------------------------------
// the real ledger, and the generated reading aid
// --------------------------------------------------------------------------

describe("the real ledger", () => {
  test("a step that leaves a dangling reference is refused and rolled back", () => {
    // Foreign keys are checked per step, not per statement, and that is the
    // trade. The rebuild in 0003_outbox_cancelled_status.sql needs
    // PRAGMA foreign_keys = OFF -- SQLite cannot alter a CHECK, and the
    // documented table rebuild drops a table three others reference -- and that
    // pragma does nothing inside a transaction, so it is issued around the
    // whole migration. What replaces the per-statement enforcement is a
    // whole-database foreign_key_check inside each step's own transaction, and
    // this is the test that it actually refuses: without it, turning the pragma
    // off would be a hole in every step rather than a licence for one.
    const { ledger, dbPath } = scratch();
    writeStep(
      ledger,
      "0003_child.sql",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES alpha(id));\n" +
        "INSERT INTO child (id, parent) VALUES (1, 404);\n",
    );

    expectRefusal(
      () => createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }),
      MigrationStepsRefused,
      /foreign key violation/,
    );

    expect(existsSync(dbPath)).toBe(false);
  });

  test("the migrating connection ends with foreign keys enforced", () => {
    // The pragma is turned off for the duration of the migration and must not
    // leak into the handle the caller goes on to write through: a connection
    // that silently does not enforce foreign keys is the failure the whole
    // configure block exists to prevent.
    const { ledger, dbPath } = scratch();
    const connection = createProductionControlPlane(dbPath, {
      nowMs: T0,
      migrationsDir: ledger,
    });
    try {
      expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      connection.close();
    }

    const reopened = openProductionControlPlane(dbPath, { migrationsDir: ledger });
    try {
      expect(reopened.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      reopened.close();
    }
  });

  test("the outbox rebuild carries every row and every reference forward", () => {
    // 0003 is a table rebuild, and a rebuild that loses a row loses evidence.
    //
    // Migrated in two halves deliberately: the database is created at 0002 from
    // a copy of the shipped steps, rows and a child reference are written into
    // it, and only then is the real ledger applied. A rebuild verified only
    // against an empty database proves nothing about the INSERT INTO ... SELECT
    // at its centre.
    const root = caseRoot("migrator");
    const dbPath = databasePath(root);
    const at0002 = join(root, "at-0002");
    for (const name of ["0001_initial.sql", "0002_policy_seed.sql"]) {
      writeStep(at0002, name, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }

    const connection = createProductionControlPlane(dbPath, {
      nowMs: T0,
      migrationsDir: at0002,
    });
    try {
      connection
        .prepare(
          "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES ('run-1', 'running', ?, ?)",
        )
        .run(T0, T0);
      connection
        .prepare(
          "INSERT INTO outbox (message_id, run_id, recipient, payload, dedup_key," +
            "                    status, retry_count, enqueued_at_ms, delivered_at_ms)" +
            " VALUES ('msg-1', 'run-1', 'secretary', '{}', 'dk-1', 'delivered', 4, ?, ?)",
        )
        .run(T0, T0 + 1);
      // A child of outbox, in the shape the three shipped referrers have --
      // event_consumption, gate_transition and gate_relay all carry REFERENCES
      // outbox(message_id). It is written by hand here rather than through one
      // of them because each of those needs a gate or an event around it, and
      // what is under test is the reference, not their rows.
      //
      // The table list is materialised before the per-table pragma loop:
      // querying while a statement is still iterating on the same connection is
      // not safe in better-sqlite3, and the source's generator expression reads
      // as if it were.
      const tables = (
        connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      const referrers = tables.filter((table) =>
        (connection.pragma(`foreign_key_list(${table})`) as { table: string }[]).some(
          (row) => row.table === "outbox",
        ),
      );
      expect(new Set(referrers)).toEqual(
        new Set(["event_consumption", "gate_transition", "gate_relay"]),
      );
      connection.exec("CREATE TABLE child (message_id TEXT REFERENCES outbox(message_id))");
      connection.exec("INSERT INTO child VALUES ('msg-1')");
    } finally {
      connection.close();
    }

    const migrated = migrateControlPlane(dbPath, { nowMs: T1 });
    try {
      expect(versionOf(dbPath)).toEqual([headVersion(), headVersion()]);
      // Every column of the row survives the rebuild, including the delivery
      // evidence and the attempt count.
      expect(
        migrated
          .prepare(
            "SELECT run_id, recipient, dedup_key, status, retry_count, delivered_at_ms" +
              "  FROM outbox WHERE message_id = 'msg-1'",
          )
          .get(),
      ).toEqual({
        run_id: "run-1",
        recipient: "secretary",
        dedup_key: "dk-1",
        status: "delivered",
        retry_count: 4,
        delivered_at_ms: T0 + 1,
      });
      // And the reference into it: the rebuild drops and recreates the parent
      // table, so a child left dangling would be the silent half of the risk.
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
      expect(migrated.prepare("SELECT message_id FROM child").all()).toEqual([
        { message_id: "msg-1" },
      ]);
      expect(migrated.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      migrated.close();
    }
  });

  test("the real ledger is discoverable and contiguous", () => {
    const steps = discoverMigrationSteps();
    expect(steps.length, "the production DDL ledger must ship with the package").toBeGreaterThan(0);
    expect(steps.map((step) => step.version)).toEqual(
      Array.from({ length: steps.length }, (_, index) => index + 1),
    );
    expect(headVersion(steps)).toBe(steps[steps.length - 1]?.version);
  });

  test("the real ledger migrates an empty database to head", () => {
    const root = caseRoot("migrator");
    const dbPath = databasePath(root);
    const connection = createProductionControlPlane(dbPath, { nowMs: T0 });
    try {
      const head = headVersion();
      expect(versionOf(dbPath)).toEqual([head, head]);
      expect(connection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      connection.close();
    }

    openProductionControlPlane(dbPath).close();
  });

  test("render current schema matches a freshly migrated database", () => {
    const root = caseRoot("migrator");
    const dbPath = databasePath(root);
    const connection = createProductionControlPlane(dbPath, { nowMs: T0 });
    let fromDisk: string;
    try {
      fromDisk = renderCurrentSchema(connection);
    } finally {
      connection.close();
    }

    // The definition of the current schema is "whatever the steps produce from
    // nothing", so the generated reading aid must be derivable without a
    // database to point at -- otherwise docs/schema-current.sql could drift
    // from the steps and nothing would notice.
    expect(renderCurrentSchema()).toBe(fromDisk);
  });

  test("the generated schema says it must not be applied", () => {
    const rendered = renderCurrentSchema();
    expect(rendered).toContain("DO NOT EDIT, AND DO NOT APPLY");
    expect(rendered).toContain(`schema_migration head: ${headVersion()}`);
    // It is a reading aid, not a step: the header has to say so, because the
    // dangerous mistake is not reading the file, it is applying it.
    expect(rendered).toContain("GENERATED FILE");
    expect(rendered.endsWith("\n")).toBe(true);
  });

  test("the generated schema is ascii so it survives a cp932 console", () => {
    const rendered = renderCurrentSchema();
    // Python's `.encode("ascii")` raises on the first non-ASCII code point.
    // The equivalent assertion is that every code unit is below 0x80; a
    // round-trip through a "latin1" buffer would not fail on one.
    const offending = [...rendered].filter((character) => character.charCodeAt(0) > 0x7f);
    expect(offending).toEqual([]);
  });

  test("rendering leaves no database behind", () => {
    // renderCurrentSchema() migrates an in-memory database when given no
    // connection; a file appearing anywhere would mean the "reading aid" had
    // become a writer.
    const root = caseRoot("migrator");
    chdirForTest(root);
    renderCurrentSchema();
    expect(readdirSync(root)).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// a caller's open transaction is not ours to commit
// --------------------------------------------------------------------------

describe("a caller's open transaction", () => {
  test("migrating a connection with an open transaction is refused", () => {
    // Adapted. Python's sqlite3 opens a transaction before DML under the
    // driver's default isolation level and *commits* it when isolation_level is
    // set to None, so migrating used to commit the caller's work as a side
    // effect. better-sqlite3 has no implicit BEGIN and no isolation level, so
    // that specific hazard cannot exist here -- but the property it protects
    // does, and it is what is asserted: a connection handed over mid-transaction
    // is refused, and its work is still uncommitted afterwards.
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: 1, migrationsDir: ledger }).close();
    const connection = rawConnection(dbPath);
    try {
      connection.exec("BEGIN");
      connection.prepare("INSERT INTO alpha (id) VALUES (7)").run();
      expect(connection.inTransaction).toBe(true);

      const caught = expectRefusal(
        () => migrateControlPlane(connection, { nowMs: 2, migrationsDir: ledger }),
        ControlPlaneRefusal,
      );
      // The message has to say what to do about it, since the caller is the
      // only one that can decide whether that work should land.
      expect(caught.message).toContain("commit or roll it back");
      // Still open, so a rollback still undoes it: nothing was decided for the
      // caller.
      expect(connection.inTransaction).toBe(true);
      connection.exec("ROLLBACK");
    } finally {
      connection.close();
    }
    expect(rowsOf(dbPath, "alpha")).toEqual([]);
  });

  test("a refused migration does not commit the caller's open transaction", () => {
    // The sharp end: the database is refused (a foreign application_id), and a
    // refusal that has already persisted somebody's half-finished work is the
    // opposite of what a refusal means (R3).
    //
    // Adapted for the same reason as the case above: the transaction is opened
    // explicitly rather than by the driver.
    const { root, ledger } = scratch();
    const target = join(root, "foreign.sqlite3");
    const setup = rawConnection(target);
    try {
      setup.exec("CREATE TABLE scratch (v TEXT)");
      setup.pragma(`application_id = ${SPIKE_APPLICATION_ID}`);
    } finally {
      setup.close();
    }

    const connection = rawConnection(target);
    try {
      connection.exec("BEGIN");
      connection.prepare("INSERT INTO scratch VALUES ('half-finished')").run();
      expectRefusal(
        () => migrateControlPlane(connection, { nowMs: 2, migrationsDir: ledger }),
        ControlPlaneRefusal,
      );
      connection.exec("ROLLBACK");
    } finally {
      connection.close();
    }
    expect(rowsOf(target, "scratch")).toEqual([]);
  });

  test("an autocommit connection is still migrated", () => {
    // The refusal is about an open transaction, not about a driver mode: the
    // ordinary caller that opens its own connection must still work.
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: 1, migrationsDir: ledger }).close();
    writeStep(ledger, "0003_gamma.sql", "CREATE TABLE gamma (id INTEGER PRIMARY KEY);\n");
    const connection = rawConnection(dbPath);
    try {
      migrateControlPlane(connection, { nowMs: 2, migrationsDir: ledger });
    } finally {
      connection.close();
    }
    expect(tablesOf(dbPath)).toContain("gamma");
  });
});

// --------------------------------------------------------------------------
// the verify-close-reopen window: a rolling deploy migrating in the gap
// --------------------------------------------------------------------------

describe("the verify-close-reopen window", () => {
  test("opening refuses a database a newer build migrated in the verify-reopen gap", () => {
    // DatabaseAheadOfCodeRefused exists so an older build cannot operate on a
    // database a newer one has moved forward, and a rolling deploy is the
    // deployment shape it was written for. Verification on a read-only
    // connection that is closed before the writable one is opened leaves a
    // window in which exactly that can happen, so the returned handle is
    // verified again on itself.
    const { root, ledger, dbPath } = scratch();
    const olderBuild = olderBuildLedger(root, ledger);
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: olderBuild }).close();
    expect(versionOf(dbPath)).toEqual([1, 1]);

    migrateInTheGap(ledger, dbPath);

    expectRefusal(
      () => openProductionControlPlane(dbPath, { migrationsDir: olderBuild }),
      DatabaseAheadOfCodeRefused,
      /only up to 1/,
    );
    expect(versionOf(dbPath)).toEqual([2, 2]);
  });

  test("migrating refuses a database a newer build migrated in the verify-reopen gap", () => {
    // migrateControlPlane's path branch has the same window, and a no-op
    // migration is where it hides: with the database already past this build's
    // head there is nothing to apply, so without re-verification the older
    // build silently gets a writable handle to a database ahead of its code.
    const { root, ledger, dbPath } = scratch();
    const olderBuild = olderBuildLedger(root, ledger);
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: olderBuild }).close();

    migrateInTheGap(ledger, dbPath);

    expectRefusal(
      () => migrateControlPlane(dbPath, { nowMs: T2, migrationsDir: olderBuild }),
      DatabaseAheadOfCodeRefused,
      /only up to 1/,
    );
    expect(versionOf(dbPath)).toEqual([2, 2]);
  });

  test("a step is not applied over a database another migrator moved", () => {
    // Re-verification is a read at a point in time; the write path needs the
    // check inside the transaction that does the writing. With the write lock
    // held, a ledger head that is not exactly step.version - 1 means another
    // migrator moved the database between the verification and this step, so
    // the step is refused instead of applied on top of a shape this build never
    // saw.
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();
    writeStep(ledger, "0003_gamma.sql", "CREATE TABLE gamma (id INTEGER PRIMARY KEY);\n");

    const realApplyStep = migratorSeams.applyStep;
    let moved = false;
    patchSeam(migratorSeams, "applyStep", (connection, step, nowMs) => {
      if (!moved) {
        moved = true;
        const other = openControlPlaneConnection(dbPath);
        try {
          other.exec("BEGIN IMMEDIATE");
          other.exec("CREATE TABLE gamma (id INTEGER PRIMARY KEY)");
          const steps = discoverMigrationSteps(ledger);
          other
            .prepare(
              "INSERT INTO schema_migration (version, name, checksum, applied_at_ms) VALUES (3, 'gamma', ?, ?)",
            )
            .run(steps[steps.length - 1]?.checksum, T1);
          other.pragma("user_version = 3");
          other.exec("COMMIT");
        } finally {
          other.close();
        }
      }
      return realApplyStep(connection, step, nowMs);
    });

    expectRefusal(
      () => migrateControlPlane(dbPath, { nowMs: T2, migrationsDir: ledger }),
      MigrationStepsRefused,
      /moved/,
    );
    expect(versionOf(dbPath)).toEqual([3, 3]);
    expect(ledgerRows(dbPath).map((row) => row["version"])).toEqual([1, 2, 3]);
  });
});

/**
 * Seam liveness.
 *
 * Target-only, and not counted in the parity ledger. The three cases above
 * replace `migratorSeams` entries and would keep passing if a later refactor
 * made the production code call the underlying functions directly and left the
 * seam as a decoration -- the replacement would simply never be reached, and
 * the assertions, which are about refusals, would still hold for the wrong
 * reason. These assert that production code really does route through the
 * record.
 */
describe("seam liveness (target-only)", () => {
  test("migrateControlPlane calls verifyReadonly through the seam record", () => {
    const { ledger, dbPath } = scratch();
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();
    const real = migratorSeams.verifyReadonly;
    let calls = 0;
    patchSeam(migratorSeams, "verifyReadonly", (target, steps, requireLedger) => {
      calls += 1;
      return real(target, steps, requireLedger);
    });
    migrateControlPlane(dbPath, { nowMs: T1, migrationsDir: ledger }).close();
    expect(calls).toBe(1);
  });

  test("applyPending calls applyStep through the seam record", () => {
    const { ledger, dbPath } = scratch();
    const real = migratorSeams.applyStep;
    let calls = 0;
    patchSeam(migratorSeams, "applyStep", (connection, step, nowMs) => {
      calls += 1;
      return real(connection, step, nowMs);
    });
    createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: ledger }).close();
    expect(calls).toBe(2);
  });

  test("the busy timeout is read from the seam record at call time", () => {
    const { ledger, dbPath } = scratch();
    patchSeam(migratorSeams, "migrationBusyTimeoutMs", 123);
    const connection = createProductionControlPlane(dbPath, {
      nowMs: T0,
      migrationsDir: ledger,
    });
    try {
      expect(connection.pragma("busy_timeout", { simple: true })).toBe(123);
    } finally {
      connection.close();
    }
  });
});
