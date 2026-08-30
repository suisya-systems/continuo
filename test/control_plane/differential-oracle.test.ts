import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { dumpControlPlaneState, SHARED_HEAD_VERSION } from "../oracle/control-plane-dump.js";

/**
 * The differential oracle: control-plane database state, Python against
 * TypeScript.
 *
 * `parity/oracle/control-plane-state.json` was produced by **interlock's**
 * migrator (`scripts/oracle/dump_control_plane.py`, run against the interlock
 * checkout; the command is in `docs/differential-oracle.md`). This test
 * produces the same normalised dump through continuo's migrator and asserts
 * they are equal.
 *
 * That is a different claim from anything the ported cases make. They asserted
 * that continuo's migrator behaves as its own tests require. This asserts that
 * the database the two implementations *build* is the same database -- same
 * schema objects, same seeded rows, same column affinities and defaults, same
 * ledger, same pragmas. Verbatim SQL does not give that on its own: it fixes
 * the text, not the execution order, the transaction boundaries, the pragmas in
 * force, or the value representations coming back through two different
 * drivers.
 *
 * **The comparison spans the shared migration history, which ends at
 * `SHARED_HEAD_VERSION`.** Interlock is a frozen source, so that is the
 * terminus of the shared half rather than a high-water mark that moves;
 * migration steps above it are continuo's own, and there is no second
 * implementation on the other side of one to compare it against.
 *
 * **What this face therefore does not claim.** A continuo-only migration is
 * outside the comparison entirely -- its DDL, its seeded rows, the column
 * affinities it introduces and the pragmas in force while it runs are all
 * unexamined here, and a defect introduced by one does not surface in this
 * test. Read it as "the shared history builds the same database", never as
 * "the database is the same database".
 *
 * Regenerating the vector is a deliberate act, not a convenience: run the
 * Python side and commit the result, so a change to it appears in review as a
 * change to the oracle rather than as a passing test.
 *
 * Scope: this is the pilot's **one** implemented face. CLI results, state
 * transitions and exception classification are designed but not built here
 * (DECISIONS.md D-0018).
 */

const VECTOR = fileURLToPath(
  new URL("../../parity/oracle/control-plane-state.json", import.meta.url),
);

describe("differential oracle: control-plane database state", () => {
  test("the TypeScript migrator builds the database the Python migrator builds", () => {
    const actual = dumpControlPlaneState();

    // An escape hatch for regeneration only, and it fails the test when used so
    // it can never be left on in CI: a "self-updating" golden vector asserts
    // nothing at all.
    if (process.env["CONTINUO_ORACLE_WRITE"] === "1") {
      writeFileSync(VECTOR, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
      throw new Error(
        "CONTINUO_ORACLE_WRITE was set: the vector was overwritten from the " +
          "TypeScript side. That is not an oracle -- regenerate it from " +
          "scripts/oracle/dump_control_plane.py instead, and unset this variable.",
      );
    }

    const raw = JSON.parse(readFileSync(VECTOR, "utf8")) as typeof actual & {
      source: { repository: string; revision: string };
    };

    // The vector is evidence of parity against ONE interlock revision, so its
    // provenance is checked before its contents: a vector regenerated from a
    // different checkout answers a different question, and comparing against it
    // would report parity with something nobody named.
    const ledger = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../parity/control-plane.ledger.json", import.meta.url)),
        "utf8",
      ),
    ) as { source: { revision: string } };
    expect(raw.source.revision).toBe(ledger.source.revision);

    const { source: _source, ...expected } = raw;

    // Compared field by field before the whole-object assertion, so a failure
    // says which face diverged rather than printing a hundred-kilobyte diff.
    expect(actual.application_id).toBe(expected.application_id);
    expect(actual.user_version).toBe(expected.user_version);
    expect(actual.foreign_keys).toBe(expected.foreign_keys);
    expect(actual.integrity_check).toEqual(expected.integrity_check);
    expect(actual.foreign_key_check).toEqual(expected.foreign_key_check);

    expect(actual.schema.map((row) => `${row.type}:${row.name}`)).toEqual(
      expected.schema.map((row) => `${row.type}:${row.name}`),
    );
    for (const [index, object] of actual.schema.entries()) {
      expect(object, `schema object ${object.type} ${object.name}`).toEqual(expected.schema[index]);
    }

    expect(Object.keys(actual.tables)).toEqual(Object.keys(expected.tables));
    for (const name of Object.keys(actual.tables)) {
      expect(actual.tables[name]?.columns, `columns of ${name}`).toEqual(
        expected.tables[name]?.columns,
      );
      expect(actual.tables[name]?.row_count, `row count of ${name}`).toBe(
        expected.tables[name]?.row_count,
      );
      expect(actual.tables[name]?.rows, `rows of ${name}`).toEqual(expected.tables[name]?.rows);
    }

    expect(actual).toEqual(expected);
  });

  test("the vector is not vacuous", () => {
    // A vector that had been regenerated from an empty or failed run would make
    // the comparison above pass while comparing nothing. The shipped ledger
    // seeds real rows, so both facts are asserted directly.
    const expected = JSON.parse(readFileSync(VECTOR, "utf8")) as ReturnType<
      typeof dumpControlPlaneState
    > & { source: { revision: string } };
    expect(expected.source.revision).not.toBe("");
    expect(expected.schema.length).toBeGreaterThan(50);
    expect(Object.keys(expected.tables).length).toBeGreaterThan(10);
    // Tied to the shared terminus rather than spelled as a number, so the
    // vector and the version the dump migrates to cannot drift apart.
    expect(expected.tables["schema_migration"]?.row_count).toBe(SHARED_HEAD_VERSION);
    expect(expected.user_version).toBe(SHARED_HEAD_VERSION);
    // 0002_policy_seed.sql is the numeric table of time-base-policy.md section 3
    // as data; if it seeded nothing, the rebuild in 0003 would have nothing to
    // carry forward and this face of the oracle would be comparing empty tables.
    expect(expected.tables["policy_revision"]?.row_count).toBeGreaterThan(0);
  });
});
