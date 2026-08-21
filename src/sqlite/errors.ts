/**
 * Classifying SQLite errors the way Python's `sqlite3` exception hierarchy does.
 *
 * Interlock's migrator branches on Python exception *classes*:
 * `sqlite3.OperationalError` for lock contention, `sqlite3.IntegrityError` for
 * a trigger's `RAISE(ABORT, ...)`, `sqlite3.DatabaseError` for "this file is
 * not a database", and a catch-all `sqlite3.Error` around step application.
 * better-sqlite3 raises a single `SqliteError` carrying a `code` string
 * instead, so the branches have to be rebuilt from codes.
 *
 * The mapping is written down once, here, rather than being re-derived at each
 * call site -- a `catch` that tests `message.includes("locked")` is the shape
 * this file exists to prevent, because SQLite's message text is not a
 * compatibility surface and its codes are.
 *
 * Mapping (DECISIONS.md D-0016):
 *
 * | Python                      | SQLite result codes                        |
 * |-----------------------------|--------------------------------------------|
 * | `sqlite3.IntegrityError`    | `SQLITE_CONSTRAINT*`                        |
 * | `sqlite3.OperationalError`  | `SQLITE_BUSY*`, `SQLITE_LOCKED*` (lock role)|
 * | `sqlite3.DatabaseError`     | every `SQLITE_` code (see below)            |
 * | `sqlite3.OperationalError`  | `SQLITE_CANTOPEN*` (absent/unopenable file) |
 * | `sqlite3.Error`             | anything carrying a `SQLITE_` code           |
 *
 * Only the predicates the port actually branches on are exported. The rest of
 * the table is documented rather than written: an unused predicate is a guess
 * about a future branch, and a guess that nothing exercises is the shape of a
 * mapping that is wrong when it is finally reached.
 *
 * The `DatabaseError` row is the one that surprises. Every `sqlite3` error class
 * except `InterfaceError` descends from it -- `OperationalError` ("no such
 * column") included -- so a Python `except sqlite3.DatabaseError` is very nearly
 * "any error from the database". {@link isSqliteError} draws the same line:
 * better-sqlite3 signals misuse of its own API with plain `TypeError`s rather
 * than `SQLITE_` codes, so what carries a code is what came from SQLite.
 */

/** The shape better-sqlite3 gives its errors. Not exported by the package. */
export interface SqliteErrorLike extends Error {
  readonly code: string;
}

/**
 * True when `error` came from SQLite.
 *
 * Recognised by the presence of a `SQLITE_`-prefixed `code`, not by
 * `instanceof`: better-sqlite3's `SqliteError` constructor is reachable only
 * through the default export's `.SqliteError` property, and pinning the check
 * to that identity would break the moment a second copy of the package is
 * resolved anywhere in the graph.
 */
export function isSqliteError(error: unknown): error is SqliteErrorLike {
  return (
    error instanceof Error &&
    typeof (error as unknown as { code?: unknown }).code === "string" &&
    (error as unknown as { code: string }).code.startsWith("SQLITE_")
  );
}

/** The SQLite result code, or `undefined` if this is not a SQLite error. */
export function sqliteCodeOf(error: unknown): string | undefined {
  return isSqliteError(error) ? error.code : undefined;
}

/**
 * The write lock could not be taken within `busy_timeout`.
 *
 * `SQLITE_LOCKED` is included: it is the same operator-visible situation (some
 * other holder has the database) and the migrator's refusal text speaks to
 * that, not to the distinction between a table-level and a file-level lock.
 */
export function isBusyError(error: unknown): boolean {
  const code = sqliteCodeOf(error);
  return code !== undefined && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
}
