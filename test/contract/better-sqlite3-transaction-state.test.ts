import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openControlPlaneConnection } from "../../src/control_plane/connection.js";
import { MEMORY, openDatabase } from "../../src/sqlite/open.js";
import { bytesOf, caseRoot, sidecars } from "../testkit/cases.js";

/**
 * Driver behaviours the migrator relies on, pinned as a contract.
 *
 * The migrator issues its own `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` rather
 * than using better-sqlite3's `transaction()` wrapper, because it needs the
 * `began` flag that separates "the BEGIN itself failed" from "a later statement
 * failed" and the typed conversion that goes with each. That rests on two
 * behaviours of the driver, and both were *measured* rather than assumed when
 * the port was written (DECISIONS.md D-0016).
 *
 * A measurement that is not re-run is a fact about one afternoon. These tests
 * re-run it, so a better-sqlite3 upgrade that changes either behaviour turns the
 * gate red instead of silently leaking a half-applied migration step.
 *
 * The third case pins the fact D-0012 rests on, for the same reason.
 */

describe("better-sqlite3 transaction state (contract)", () => {
  test("inTransaction tracks a manually issued BEGIN IMMEDIATE", () => {
    const db = openDatabase(MEMORY);
    try {
      expect(db.inTransaction).toBe(false);
      db.exec("BEGIN IMMEDIATE");
      expect(db.inTransaction).toBe(true);
      db.exec("ROLLBACK");
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a connection is in autocommit outside an explicit BEGIN", () => {
    // The premise interlock's `transaction()` precondition is written against,
    // measured on this driver rather than assumed from documentation.
    //
    // Python's `sqlite3` opens a transaction of its own before a DML statement
    // when `isolation_level` is not `None`, and commits it at some later point
    // of its choosing -- so a multi-statement invariant can be published a step
    // at a time. `txn.py` refuses such a connection outright. better-sqlite3
    // has no `isolation_level` and no such mode, which is why that refusal has
    // no reachable trigger here and its source case is recorded `not-ported`
    // (parity/control-plane.events.ledger.json).
    //
    // This lives in the contract suite, not among the ported cases: it is a
    // claim about the driver, and if a future release ever did open a
    // transaction of its own, the refusal `txn.ts` cannot currently trigger
    // would become necessary -- and this is the test that would say so.
    const root = caseRoot("txn-contract");
    const db = openControlPlaneConnection(join(root, "t.sqlite3"), { fileMustExist: false });
    try {
      expect("isolation_level" in db).toBe(false);
      db.exec("CREATE TABLE t (a INTEGER)");
      expect(db.inTransaction).toBe(false);
      db.prepare("INSERT INTO t VALUES (1)").run();
      // No transaction was opened, so there is nothing left for the driver to
      // commit later: a second connection already sees the row.
      expect(db.inTransaction).toBe(false);
      const other = openControlPlaneConnection(join(root, "t.sqlite3"));
      try {
        expect(other.prepare("SELECT a FROM t").pluck().all()).toEqual([1]);
      } finally {
        other.close();
      }
    } finally {
      db.close();
    }
  });

  test("exec() issues no implicit COMMIT", () => {
    // Python's `executescript()` commits before running what it was given, which
    // is why the source deliberately does not use it for step SQL. If `exec()`
    // ever behaved that way, a step that failed halfway would leave its first
    // half committed -- and the ported case that catches exactly that would
    // start failing for a reason nobody would look for here.
    const db = openDatabase(MEMORY);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("CREATE TABLE t (a)");
      expect(db.inTransaction).toBe(true);
      db.exec("ROLLBACK");
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as {
        n: number;
      };
      expect(remaining.n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("a read-only connection accepts the control plane's pragmas and writes nothing", () => {
    // D-0012's actual justification, kept honest. The tempting version of that
    // decision says pragmas cannot be issued read-only; they can. What cannot is
    // `journal_mode = WAL`, and that is why the control plane does not go
    // through the WAL opener: verification would fail outright rather than
    // return a typed refusal.
    const root = caseRoot("contract");
    const path = join(root, "probe.sqlite");
    writeFileSync(path, "");
    const writable = openControlPlaneConnection(path, { fileMustExist: false });
    writable.exec("CREATE TABLE t (a)");
    writable.close();
    const before = bytesOf(path);

    const readonly = openControlPlaneConnection(path, { readonly: true });
    try {
      readonly.pragma("foreign_keys = ON");
      expect(readonly.pragma("foreign_keys", { simple: true })).toBe(1);
      readonly.pragma("synchronous = FULL");
      expect(() => readonly.pragma("journal_mode = WAL")).toThrow(/readonly/i);
    } finally {
      readonly.close();
    }

    expect(bytesOf(path).equals(before)).toBe(true);
    expect(sidecars(path)).toEqual([]);
    // Nothing else appeared in the directory either.
    expect(readdirSync(root)).toEqual(["probe.sqlite"]);
  });
});
