import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { onTestFinished } from "vitest";

import { createTempDir } from "../helpers/tmp.js";

/**
 * pytest's `tmp_path`, and the inspection helpers a ported control-plane case
 * needs.
 *
 * `tmp_path` is one directory per **test**, created before the test and removed
 * after it. Two properties of that are load-bearing here and are easy to lose:
 *
 * - *Per test, not per file.* A file-scoped directory under a shuffled order
 *   makes a leaked file fail whichever test happens to run second.
 * - *The path is a fresh directory, and the database inside it does not exist
 *   yet.* Many ported cases assert `not db_path.exists()`, so a helper that
 *   creates the file would defeat them.
 */

/** pytest's `tmp_path`: a unique directory for the running test. */
export function caseRoot(label = "case"): string {
  return createTempDir(label);
}

/**
 * The `db_path` fixture: a path inside `root` where no file exists yet.
 *
 * Note this is a *name*, not a file. The source fixture is the same, and the
 * cases that assert nothing was created depend on it.
 */
export function databasePath(root: string): string {
  return join(root, "production.sqlite3");
}

/**
 * A connection with none of the module's discipline, for inspection and
 * sabotage -- the source's `raw()`.
 *
 * Closed when the test finishes. On Windows an open handle keeps a lock on the
 * file, and the temp-directory cleanup then fails with a message about the
 * directory rather than about the connection nobody closed.
 */
export function rawConnection(path: string): SqliteDatabase {
  const connection = new Database(path, { fileMustExist: false });
  // "None of the module's discipline" has to include the driver's own. Python's
  // `sqlite3.connect` has no defensive mode, while better-sqlite3 enables
  // SQLITE_DBCONFIG_DEFENSIVE by default, which refuses a direct write to
  // `sqlite_master` even under `PRAGMA writable_schema = ON`.
  //
  // The cases that reach around a trigger to build a state the module must
  // refuse are simulating a hand-run `sqlite3` session, and a hand-run session
  // is not defensive. Leaving it on would not make those cases safer -- it would
  // make them fail while *constructing* the damage, so the refusal they exist to
  // assert would never be reached.
  connection.unsafeMode(true);
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
 * Journal and WAL files -- evidence that a "refused" open in fact wrote.
 *
 * Sorted, and matched by the source's `{name}-*` glob rather than by a fixed
 * list of suffixes, so a sidecar nobody predicted still shows up.
 */
export function sidecars(path: string): string[] {
  const prefix = `${basename(path)}-`;
  return readdirSync(dirname(path))
    .filter((entry) => entry.startsWith(prefix))
    .sort()
    .map((entry) => join(dirname(path), entry));
}

/** The names of the tables in the database at `path`. */
export function tablesOf(path: string): string[] {
  return withConnection(path, (connection) =>
    (
      connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    )
      .map((row) => row.name)
      .sort(),
  );
}

/** Every row of `table`, as objects. */
export function rowsOf(path: string, table: string): Record<string, unknown>[] {
  return withConnection(
    path,
    (connection) => connection.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[],
  );
}

/** The ledger rows, oldest first. */
export function ledgerRows(path: string): Record<string, unknown>[] {
  return withConnection(
    path,
    (connection) =>
      connection.prepare("SELECT * FROM schema_migration ORDER BY version").all() as Record<
        string,
        unknown
      >[],
  );
}

/**
 * The pair the source's `version_of` returns: the ledger head and
 * `PRAGMA user_version`.
 *
 * Returned together because the property under test is almost always that the
 * two *agree*; asserting them separately lets a case pass while they disagree.
 */
export function versionOf(path: string): [number, number] {
  return withConnection(path, (connection) => {
    const head = (
      connection.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migration").get() as {
        v: number;
      }
    ).v;
    const pragma = connection.pragma("user_version", { simple: true }) as number;
    return [head, pragma];
  });
}

/** Open, read, close -- so an inspection never holds a lock past its use. */
function withConnection<T>(path: string, read: (connection: SqliteDatabase) => T): T {
  const connection = new Database(path, { fileMustExist: true });
  try {
    return read(connection);
  } finally {
    connection.close();
  }
}

/** Write `sql` as a step file in `directory`, creating the directory if needed. */
export function writeStep(directory: string, filename: string, sql: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, sql, "utf8");
  return path;
}

/** Write raw bytes as a step file -- for the not-valid-UTF-8 case. */
export function writeStepBytes(directory: string, filename: string, bytes: Uint8Array): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, bytes);
  return path;
}

/** The bytes of `path`, for the cases that assert a file was left alone. */
export function bytesOf(path: string): Buffer {
  return readFileSync(path);
}
