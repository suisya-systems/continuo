import { existsSync, rmSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MEMORY, openDatabase } from "../../src/sqlite/open.js";
import { tempDatabasePath } from "../helpers/tmp.js";

describe("openDatabase", () => {
  it("enforces foreign keys on the connection", () => {
    const db = openDatabase(MEMORY);
    try {
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

      db.exec(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id)
        );
      `);

      expect(() => db.prepare("INSERT INTO child (id, parent_id) VALUES (1, 999)").run()).toThrow(
        /FOREIGN KEY constraint failed/,
      );
    } finally {
      db.close();
    }
  });

  it("refuses a missing file by default", () => {
    const path = tempDatabasePath("missing");
    expect(() => openDatabase(path)).toThrow();
  });

  it("creates a missing file when told to", () => {
    const path = tempDatabasePath("created");
    const db = openDatabase(path, { fileMustExist: false });
    db.close();
    expect(openDatabase(path).close()).toBeDefined();
  });

  it("does not migrate: opening leaves the schema untouched", () => {
    // Interlock D-0040: migration is an explicit call, never a side effect of
    // opening, so a read-only consumer can be read-only by construction.
    const path = tempDatabasePath("no-migrate");
    const created = openDatabase(path, { fileMustExist: false });
    created.close();

    const db = openDatabase(path);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      expect(tables).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("closes the handle when connection setup fails", () => {
    // Opening is lazy: `new Database` succeeds on a file that is not a database,
    // and `journal_mode = WAL` is what throws. If openDatabase let that escape
    // without closing, the native handle would live until garbage collection --
    // and on Windows it would hold a lock, so the caller could not delete the
    // file. Deleting it here is the assertion that the handle is gone.
    const path = tempDatabasePath("not-a-db");
    writeFileSync(path, "this is not a SQLite database, but it is a real file");

    expect(() => openDatabase(path)).toThrow(/not a database/);

    // Honest about where this bites: on POSIX, unlinking a file with an open
    // descriptor always succeeds, so this assertion is trivially true on the
    // Linux cells. It has teeth on the required Windows cells, where a retained
    // handle raises EBUSY / EPERM. That is the cell it is written for.
    expect(() => rmSync(path)).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("opens read-only without upgrading the journal mode", () => {
    const path = tempDatabasePath("readonly");
    const writable = openDatabase(path, { fileMustExist: false });
    writable.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    writable.close();

    const db = openDatabase(path, { readonly: true });
    try {
      expect(() => db.exec("CREATE TABLE u (id INTEGER PRIMARY KEY)")).toThrow();
    } finally {
      db.close();
    }
  });
});
