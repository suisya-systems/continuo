import Database from "better-sqlite3";

import type { Database as SqliteDatabase } from "better-sqlite3";

/**
 * The single place where a SQLite connection is created.
 *
 * Interlock's `D-0040` makes migration an explicit call, separate from opening,
 * so that a read-only consumer (the measurement harness) can be read-only by
 * construction. This function carries that property forward: it opens, it sets
 * connection-level pragmas, and it does not create or alter a single table.
 *
 * The value-representation contract for everything read through this connection
 * is `docs/sqlite-value-contract.md` (D-0003).
 */
export interface OpenDatabaseOptions {
  /** Open the file without write permission. Defaults to false. */
  readonly readonly?: boolean;
  /**
   * Refuse to create the file if it does not exist. Defaults to true: a typo in
   * a path must not silently produce an empty database that then fails a
   * migration checksum much later.
   */
  readonly fileMustExist?: boolean;
}

/** Path accepted for an in-memory database. */
export const MEMORY = ":memory:" as const;

export function openDatabase(
  path: string,
  options: OpenDatabaseOptions = {},
): SqliteDatabase {
  const readonly = options.readonly ?? false;
  // An in-memory database never exists beforehand, so the guard would make it
  // impossible to open one.
  const fileMustExist =
    path === MEMORY ? false : (options.fileMustExist ?? true);

  const db = new Database(path, { readonly, fileMustExist });

  // Enforced on every connection rather than stored in the file, because
  // `foreign_keys` is a per-connection setting in SQLite: a connection that
  // forgets it silently accepts rows the schema forbids.
  db.pragma("foreign_keys = ON");

  if (!readonly) {
    // WAL is a file-level property and only settable on a writable connection.
    db.pragma("journal_mode = WAL");
  }

  return db;
}
