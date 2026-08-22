import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";

/**
 * How the control plane opens SQLite, and why it is not `sqlite/open.ts`.
 *
 * `openDatabase` sets `journal_mode = WAL`. The control plane must not: three
 * of the migrator's refusal properties are stated in terms of the database
 * file being *untouched* by a refused open, and WAL breaks all three.
 *
 * 1. `sidecars(path) == []` -- the ported cases assert that a refused open
 *    left no `-journal` / `-wal` / `-shm` beside the database. WAL creates
 *    `-wal` and `-shm` on the first write and removes them only on a clean
 *    last-connection close, so the assertion would fail on a correct
 *    implementation and, worse, could be "fixed" by deleting the assertion.
 * 2. Byte-identity -- `test_creating_over_an_existing_path_is_refused` compares
 *    the file's bytes before and after. Under WAL recent commits are not in the
 *    main file, so "unchanged" stops meaning what the test means by it.
 * 3. `PRAGMA journal_mode = WAL` **is itself a write** to the database header.
 *    A verification pass that set it would mutate a file the module promises
 *    never to touch.
 *
 * Interlock sets exactly two pragmas and no journal mode (`migrator._configure`),
 * leaving the rollback journal in force. This file carries that forward.
 * See DECISIONS.md D-0012.
 */

/** Options for opening a control-plane connection. */
export interface ControlPlaneOpenOptions {
  /** Open without write permission. Defaults to false. */
  readonly readonly?: boolean;
  /** Refuse to create the file if absent. Defaults to true. */
  readonly fileMustExist?: boolean;
}

/**
 * Open a connection to a control-plane database.
 *
 * Applies no pragmas: a caller that wants the connection *configured* calls
 * {@link configureConnection}. The separation exists because verification runs
 * on a read-only connection over a file that is being inspected precisely
 * because it is not yet trusted, and the fewest pragmas it can be touched with
 * is none.
 *
 * Measured on better-sqlite3 13.0.3, because the tempting justification for the
 * split turns out to be false: `foreign_keys = ON` and `synchronous = FULL`
 * both *succeed* on a read-only connection and neither changes a byte of the
 * file. It is `journal_mode = WAL` that is different -- it throws
 * `SQLITE_READONLY`, "attempt to write a readonly database". So routing
 * verification through the WAL opener would not quietly corrupt the file; it
 * would fail outright, and every refusal that depends on reading an untrusted
 * database would arrive as a driver error instead of as a typed refusal.
 */
export function openControlPlaneConnection(
  path: string,
  options: ControlPlaneOpenOptions = {},
): SqliteDatabase {
  const readonly = options.readonly ?? false;
  const fileMustExist = options.fileMustExist ?? true;
  return new Database(path, { readonly, fileMustExist });
}

/**
 * The two pragmas every writable control-plane connection carries.
 *
 * Both are per-connection rather than stored in the file, which is why they are
 * reapplied on every open rather than assumed:
 *
 * - `foreign_keys = ON` because SQLite defaults it off, and a connection that
 *   forgets it reads and writes a different schema from the one the file
 *   declares.
 * - `synchronous = FULL` because interlock's D-0001 makes resume-after-kill a
 *   first-class requirement, and a commit that is only in the operating
 *   system's cache is a durable claim that is not durable.
 */
export function configureConnection(connection: SqliteDatabase): void {
  connection.pragma("foreign_keys = ON");
  connection.pragma("synchronous = FULL");
}
