import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  createProductionControlPlane,
  discoverMigrationSteps,
} from "../../src/control_plane/migrator.js";

/**
 * The TypeScript half of the differential oracle.
 *
 * Migrates an empty database through the **shared migration history** with a
 * fixed clock and returns a **normalised** description of the resulting
 * database state. The Python half, `scripts/oracle/dump_control_plane.py`,
 * produces the same structure through interlock's migrator against the same
 * SQL; the vector it produced is committed at
 * `parity/oracle/control-plane-state.json`, and
 * `test/control_plane/differential-oracle.test.ts` compares this against it.
 *
 * **The shared history ends at {@link SHARED_HEAD_VERSION}, and steps beyond
 * it are continuo's own.** Interlock is a frozen source, so that terminus is
 * settled rather than provisional: no step will ever be added to the shared
 * half. Comparing the two migrators past it would not be a comparison at all
 * -- there is nothing on the other side to compare a continuo-only step
 * against -- so this dump stops where the two implementations still have the
 * same thing to build.
 *
 * **What that means this face does not claim.** A continuo-only migration is
 * outside the comparison: its DDL, the rows it seeds, the column affinities it
 * introduces and the pragmas in force while it runs are all unexamined here.
 * Nothing about a step past {@link SHARED_HEAD_VERSION} is asserted by this
 * face, and a defect introduced by one will not surface in it. Those steps
 * are covered by their own tests and by the statement-completeness face (2b),
 * whose corpus is rebuilt from every shipped migration file including them.
 *
 * Why this face exists at all, given the SQL is copied verbatim: copying
 * guarantees the *text* is identical. It says nothing about the order the
 * statements run in, where the transaction boundaries fall, which pragmas are
 * in force while they run, or how the two drivers represent the values that
 * come back. Every one of those can differ while both suites stay green, and
 * every one of them changes the database. The dump is where such a difference
 * becomes visible.
 *
 * The normalisation is deliberate in three places:
 *
 * - `applied_at_ms` is **fixed, not stripped**. Stripping it would hide a
 *   migrator that ignored the caller's clock and used its own.
 * - Rows are ordered by every column. Neither driver promises an order without
 *   an `ORDER BY`, and an accidental agreement is worse than a mismatch.
 * - Nothing path-dependent is emitted. The database lives in a temporary
 *   directory whose name differs on every run and between the two runtimes.
 */

/** The clock every dump is taken at. Fixed so two dumps are comparable. */
export const ORACLE_NOW_MS = 1_700_000_000_000;

/**
 * The last migration version both implementations ship.
 *
 * Interlock's ledger ends here, so this is the terminus of the shared history
 * and not a running high-water mark. Steps above it exist in continuo alone.
 */
export const SHARED_HEAD_VERSION = 3;

/** Ordering for schema objects, as the generated reading aid uses. */
const KIND_ORDER: Record<string, number> = { table: 0, view: 1, index: 2, trigger: 3 };

export interface ControlPlaneStateDump {
  application_id: number;
  user_version: number;
  foreign_keys: number;
  integrity_check: string[];
  foreign_key_check: unknown[];
  schema: { type: string; name: string; sql: string }[];
  tables: Record<
    string,
    {
      columns: {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }[];
      row_count: number;
      rows: Record<string, unknown>[];
    }
  >;
}

/**
 * The shared steps, copied byte for byte into `directory`.
 *
 * Copied rather than filtered in the migrator, because the migrator has no
 * "up to version N" mode and should not grow one for a test: a build that can
 * stop halfway through its own ledger is a build that can ship a database
 * halfway migrated. The copies are byte-identical, so the checksums the
 * migrator computes are this build's own -- a hand-written stand-in would be
 * refused as an edited step rather than accepted as the shared history.
 */
function sharedStepsInto(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const shared = discoverMigrationSteps().filter((step) => step.version <= SHARED_HEAD_VERSION);
  if (shared.length !== SHARED_HEAD_VERSION) {
    // Anti-vacuity: a dump taken over fewer steps than the shared history has
    // would compare a smaller database and still look like a comparison.
    throw new Error(
      `expected ${SHARED_HEAD_VERSION} shared migration steps, found ${shared.length}`,
    );
  }
  for (const step of shared) {
    copyFileSync(step.path, join(directory, basename(step.path)));
  }
  return directory;
}

export function dumpControlPlaneState(): ControlPlaneStateDump {
  const directory = mkdtempSync(join(tmpdir(), "continuo-oracle-"));
  const path = join(directory, "production.sqlite3");
  const connection = createProductionControlPlane(path, {
    nowMs: ORACLE_NOW_MS,
    migrationsDir: sharedStepsInto(join(directory, "shared-steps")),
  });
  try {
    const schema = (
      connection
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { type: string; name: string; sql: string }[]
    )
      .map((row) => ({ type: row.type, name: row.name, sql: row.sql.trim() }))
      .sort(
        (a, b) =>
          (KIND_ORDER[a.type] ?? 9) - (KIND_ORDER[b.type] ?? 9) ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );

    const tableNames = (
      connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);

    const tables: ControlPlaneStateDump["tables"] = {};
    for (const name of tableNames) {
      const columns = (
        connection.pragma(`table_info(${name})`) as {
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
          pk: number;
        }[]
      ).map((column) => ({
        name: column.name,
        type: column.type,
        notnull: column.notnull,
        dflt_value: column.dflt_value,
        pk: column.pk,
      }));
      const order = columns.map((column) => `"${column.name}"`).join(", ");
      const rows = connection.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).all() as Record<
        string,
        unknown
      >[];
      tables[name] = { columns, row_count: rows.length, rows };
    }

    return {
      application_id: connection.pragma("application_id", { simple: true }) as number,
      user_version: connection.pragma("user_version", { simple: true }) as number,
      foreign_keys: connection.pragma("foreign_keys", { simple: true }) as number,
      integrity_check: (connection.pragma("integrity_check") as { integrity_check: string }[]).map(
        (row) => row.integrity_check,
      ),
      foreign_key_check: connection.pragma("foreign_key_check") as unknown[],
      schema,
      tables,
    };
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
