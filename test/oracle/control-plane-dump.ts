import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProductionControlPlane } from "../../src/control_plane/migrator.js";

/**
 * The TypeScript half of the differential oracle.
 *
 * Migrates an empty database to head with a fixed clock and returns a
 * **normalised** description of the resulting database state. The Python half,
 * `scripts/oracle/dump_control_plane.py`, produces the same structure through
 * interlock's migrator against the same SQL; the vector it produced is
 * committed at `parity/oracle/control-plane-state.json`, and
 * `test/control_plane/differential-oracle.test.ts` compares this against it.
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

export function dumpControlPlaneState(): ControlPlaneStateDump {
  const directory = mkdtempSync(join(tmpdir(), "continuo-oracle-"));
  const path = join(directory, "production.sqlite3");
  const connection = createProductionControlPlane(path, { nowMs: ORACLE_NOW_MS });
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
