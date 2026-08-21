import { describe, expect, it } from "vitest";

import { MEMORY, openDatabase } from "../../src/sqlite/open.js";

/**
 * Executable half of docs/sqlite-value-contract.md (D-0003).
 *
 * The ported test suite asserts on values read out of SQLite in tens of
 * thousands of places. If the JavaScript representation of a stored value is
 * settled by accident rather than by decision, changing it later means rewriting
 * fixtures and expectations across the whole port. These tests pin the mapping
 * so a dependency upgrade that changes it fails here, once, with a name.
 */
describe("SQLite to JavaScript value contract", () => {
  function withDb<T>(fn: (db: ReturnType<typeof openDatabase>) => T): T {
    const db = openDatabase(MEMORY);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  it("maps the five storage classes to fixed JavaScript types", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BLOB, n INTEGER)");
      db.prepare("INSERT INTO t VALUES (?, ?, ?, ?, ?)").run(
        42,
        1.5,
        "x",
        Buffer.from([1, 2]),
        null,
      );

      const row = db.prepare("SELECT * FROM t").get() as Record<string, unknown>;

      expect(typeof row["i"]).toBe("number");
      expect(row["i"]).toBe(42);
      expect(typeof row["r"]).toBe("number");
      expect(row["r"]).toBe(1.5);
      expect(typeof row["s"]).toBe("string");
      expect(row["b"]).toBeInstanceOf(Buffer);
      // SQL NULL is `null`, and is distinguishable from a missing key.
      expect(row["n"]).toBeNull();
      expect("n" in row).toBe(true);
    });
  });

  it("distinguishes SQL NULL, a missing column, and a missing row", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)");
      db.prepare("INSERT INTO t (id, v) VALUES (1, NULL)").run();

      const present = db.prepare("SELECT * FROM t WHERE id = 1").get() as Record<string, unknown>;
      // A column that exists and holds SQL NULL.
      expect(present["v"]).toBeNull();
      // A column that does not exist in the result at all.
      expect(present["nope"]).toBeUndefined();
      expect("nope" in present).toBe(false);

      // A row that does not exist: `undefined`, never `null`.
      expect(db.prepare("SELECT * FROM t WHERE id = 999").get()).toBeUndefined();
      // ...and an empty result set is an empty array, not `undefined`.
      expect(db.prepare("SELECT * FROM t WHERE id = 999").all()).toEqual([]);
    });
  });

  it("reads INTEGER as number by default, which is lossy beyond 2^53", () => {
    // This is the sharp edge, and it is silent: SQLite stores an exact int64,
    // and the default read rounds it. Recorded as a test rather than only as
    // prose so that any module that must survive large identifiers is forced to
    // opt into safe integers deliberately.
    withDb((db) => {
      db.exec("CREATE TABLE t (i INTEGER)");
      db.exec("INSERT INTO t VALUES (9007199254740993)");

      // Stored exactly, on the SQLite side.
      expect(db.prepare("SELECT i = 9007199254740993 AS eq FROM t").get()).toEqual({ eq: 1 });

      // Read back as a Number: rounded, with no error raised.
      const value = (db.prepare("SELECT i FROM t").get() as { i: number }).i;
      expect(typeof value).toBe("number");
      expect(value).toBe(9007199254740992);
      expect(Number.isSafeInteger(value)).toBe(false);
    });
  });

  it("returns bigint for every INTEGER once safe integers are enabled", () => {
    // The opt-in is all-or-nothing on the connection: it is not a per-column
    // setting, so enabling it changes the type of small integers too.
    withDb((db) => {
      db.exec("CREATE TABLE t (i INTEGER)");
      db.exec("INSERT INTO t VALUES (1), (9007199254740993)");
      db.defaultSafeIntegers(true);

      const rows = db.prepare("SELECT i FROM t ORDER BY i").all() as {
        i: bigint;
      }[];
      expect(rows.map((r) => typeof r.i)).toEqual(["bigint", "bigint"]);
      expect(rows[1]?.i).toBe(9007199254740993n);
    });
  });

  it("accepts a bigint parameter and still reads it back as number", () => {
    withDb((db) => {
      expect(db.prepare("SELECT ? AS v").get(7n)).toEqual({ v: 7 });
    });
  });

  it("binds `undefined` silently as NULL -- a hazard, pinned here", () => {
    // Measured, not assumed. `undefined` is NOT rejected: it is bound as SQL
    // NULL. So a typo'd property (`row.stauts`) reaches the database as NULL
    // rather than as an error, which is why the write path must not accept
    // `undefined` from callers -- see docs/sqlite-value-contract.md section 4.
    withDb((db) => {
      db.exec("CREATE TABLE t (v INTEGER)");
      db.prepare("INSERT INTO t (v) VALUES (?)").run(undefined);
      expect(db.prepare("SELECT v, typeof(v) AS ty FROM t").get()).toEqual({
        v: null,
        ty: "null",
      });
    });
  });

  it("rejects a JavaScript value with no storage class", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (v INTEGER)");
      // Booleans, objects and symbols have no SQLite storage class and throw.
      expect(() => db.prepare("INSERT INTO t (v) VALUES (?)").run(true)).toThrow(/can only bind/);
      // Arity is checked: a missing parameter is an error, unlike `undefined`.
      expect(() => db.prepare("INSERT INTO t (v) VALUES (?)").run()).toThrow(
        /Too few parameter values/,
      );
    });
  });
});
