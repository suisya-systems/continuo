import { existsSync } from "node:fs";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { MEMORY, openDatabase } from "../../src/sqlite/open.js";
import { tempDatabasePath } from "../helpers/tmp.js";

/**
 * The native addon is the one dependency that can be "installed" and still be
 * unusable: a missing prebuilt binary for this Node ABI, a wrong platform
 * triple, or a source build that failed after npm reported success. These tests
 * make that state fail the build on the cell where it happens.
 */
describe("better-sqlite3 native addon", () => {
  it("loads and answers a query on an in-memory database", () => {
    const db = openDatabase(MEMORY);
    try {
      expect(db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
    } finally {
      db.close();
    }
  });

  it("reports a bundled SQLite version", () => {
    const db = openDatabase(MEMORY);
    try {
      const row = db.prepare("SELECT sqlite_version() AS v").get() as {
        v: string;
      };
      expect(row.v).toMatch(/^3\.\d+\.\d+$/);
    } finally {
      db.close();
    }
  });

  it("creates and reopens a database file", () => {
    const path = tempDatabasePath("native-load");

    const first = openDatabase(path, { fileMustExist: false });
    try {
      first.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
      first.prepare("INSERT INTO t (id, label) VALUES (?, ?)").run(1, "a");
    } finally {
      first.close();
    }

    expect(existsSync(path)).toBe(true);

    const second = openDatabase(path);
    try {
      expect(second.prepare("SELECT label FROM t WHERE id = 1").get()).toEqual({
        label: "a",
      });
    } finally {
      second.close();
    }
  });

  it("runs on a Node version inside the declared engines range", () => {
    // The floor is not cosmetic. better-sqlite3 v13 builds its prebuilt binary
    // at NAPI_VERSION=10, which Node provides only from v22.14.0 / v23.6.0
    // onward -- while the dependency's own `engines` field says merely ">=22".
    // A Node 22.0-22.13 runtime therefore satisfies the dependency's declared
    // range and still cannot load the addon, so continuo declares the real
    // floor itself (D-0003).
    const [major = 0, minor = 0] = process.versions.node.split(".").map((part) => Number(part));

    // Node 23 is excluded outright rather than given a >=23.6.0 floor: it was
    // never an LTS line and reached EOL on 2026-06-01, so admitting it would
    // declare support for a runtime nothing tests.
    expect([22, 24]).toContain(major);
    if (major === 22) {
      expect(minor).toBeGreaterThanOrEqual(14);
    }
  });
});
