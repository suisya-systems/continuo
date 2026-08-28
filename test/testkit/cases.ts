import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { beforeAll, onTestFinished } from "vitest";

import { createSuiteDir, createTempDir } from "../helpers/tmp.js";

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

/**
 * A temporary directory shared by every test in the **file**, removed when the
 * file's tests are done.
 *
 * The counterpart to {@link caseRoot}, which stays exactly as it was: a case's
 * own state still belongs in a per-test directory. This one exists for the one
 * thing a per-test directory cannot hold -- a fixture that is expensive to build,
 * identical for every case, and therefore worth building once and copying.
 *
 * Most callers want {@link suiteTemplate} rather than this. Reach for the bare
 * directory when what is shared is not a single file.
 *
 * Must be called from the top level of the test file; see {@link createSuiteDir}
 * for why a `describe` body is not close enough.
 */
export function suiteRoot(label = "suite"): string {
  return createSuiteDir(label);
}

/** A file built once per test file, and copied into a fresh directory per case. */
export interface SuiteTemplate {
  /**
   * Copy the template into `directory`, building it first if this is the first
   * call, and return the path of the copy.
   *
   * `as` overrides the copy's filename; sidecars are renamed to match it.
   */
  copyInto(directory: string, as?: string): string;
}

/**
 * Build a file once per test file, and hand each case its own copy.
 *
 * This is the shape the per-case cost is actually paid in. A migrated
 * production control plane costs about 87.5ms to create and about 0.97ms to
 * copy (N=30, one Linux box), and the ported suite creates one in roughly 250
 * places, so what the copy buys is most of the suite's wall clock.
 *
 * ```ts
 * const production = suiteTemplate("production.sqlite3", (path) => {
 *   createProductionControlPlane(path, { nowMs: T0 }).close();
 * });
 *
 * function productionDb(): string {
 *   return production.copyInto(caseRoot("cohort"));
 * }
 * ```
 *
 * Three properties are load-bearing:
 *
 * - **The build happens once, in the file's own `beforeAll`, not inside a
 *   case.** It was lazy at first -- built inside whichever case copied first --
 *   and that charged a *file-level* cost to an arbitrary *test*, where a
 *   per-test timeout measures it. Under a shuffled order the case that pays is
 *   a function of the seed, so a slow machine produced a red naming an innocent
 *   case, and a different one at each seed. That is not hypothetical: on one
 *   `windows-latest` cell `lease.test.ts` failed at
 *   `a backward skewed renewal shortens rather than extends` after 66,325ms
 *   against a 60,000ms cap, while the same commit at the cell's other seed was
 *   green -- and at that seed, on a fast box, that case is the one carrying the
 *   build (237ms against 33-43ms for its neighbours). Building in `beforeAll`
 *   puts the cost where it belongs: attributed to the file, measured against
 *   `hookTimeout`, and in the same place at every seed.
 *
 *   **What this gives up, stated rather than buried:** a file whose selected
 *   tests never copy now pays for a build it does not use. That shows up under
 *   `-t` filtering and `.only`, never in a full run, because every file that
 *   takes a template copies from it. The trade is a bounded cost on a developer
 *   convenience path against a seed-dependent red on the slowest CI cell, and
 *   the second is worse: it spends a person's attention on the wrong case.
 *
 *   The **failure** semantics are unchanged. The outcome is memoized and
 *   rethrown from `copyInto`, exactly as before, so a `build` that throws is
 *   still reported by the case that asked for a copy rather than by the hook --
 *   a file whose tests never copy is not failed by a build it never needed.
 * - **The template outlives the case that first asked for it.** That is the
 *   whole point. A template built in a {@link caseRoot} is removed when its
 *   first case finishes, and every later case fails with `ENOENT` -- the failure
 *   this helper was written in response to, and the one pinned in
 *   `testkit.contract.test.ts`.
 * - **Sidecars travel with the copy.** Anything matching `<name>-*` beside the
 *   template -- `-journal`, `-wal`, `-shm` -- is copied too. The control plane
 *   uses the rollback journal and not WAL (D-0012) and leaves none of these
 *   behind once closed, so today this copies nothing extra. It is written this
 *   way so that correctness does not *depend* on that: a template that did leave
 *   a WAL would otherwise be copied without its committed data, handing out a
 *   database that is quietly missing rows rather than one that fails.
 *
 * The copy is a plain file copy, so each case gets an independent database that
 * it may write to freely; the template itself is never opened after it is built.
 */
type TemplateOutcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

export function suiteTemplate(filename: string, build: (path: string) => void): SuiteTemplate {
  const source = join(suiteRoot(filename), filename);
  let outcome: TemplateOutcome | undefined;

  /**
   * Build once, remember what happened, and never throw from here.
   *
   * Capturing the error rather than letting it out is what keeps the failure
   * attributed to the case that wanted a copy even though the build now runs in
   * a hook: `copyInto` rethrows it below.
   */
  function ensureBuilt(): TemplateOutcome {
    if (outcome !== undefined) {
      return outcome;
    }
    let resolved: TemplateOutcome;
    try {
      build(source);
      if (!existsSync(source)) {
        throw new Error(
          `suiteTemplate(${JSON.stringify(filename)}) ran its build function, but no file ` +
            `exists at ${source} afterwards. The build function must create the file at the ` +
            `path it is given.`,
        );
      }
      resolved = { ok: true };
    } catch (error) {
      resolved = { ok: false, error };
    }
    outcome = resolved;
    return resolved;
  }

  // Registered here, which is the file's top level: `suiteRoot` above refuses a
  // call from inside a test or a `describe`, so this hook is always the file's
  // own and always runs before its first case.
  beforeAll(() => {
    ensureBuilt();
  });

  return {
    copyInto(directory: string, as: string = filename): string {
      // Still idempotent, and still correct if something reaches a copy before
      // the hook has run -- another top-level helper, say. `beforeAll` moves
      // *when* the cost is paid; it is not the only thing that may pay it.
      const built = ensureBuilt();
      if (!built.ok) {
        throw built.error;
      }

      mkdirSync(directory, { recursive: true });
      const target = join(directory, as);
      copyFileSync(source, target);
      for (const sidecar of sidecars(source)) {
        // `sidecars` matches `<filename>-*`, so what is left after the template's
        // own name is the suffix the copy must keep.
        copyFileSync(sidecar, join(directory, `${as}${basename(sidecar).slice(filename.length)}`));
      }
      return target;
    },
  };
}
