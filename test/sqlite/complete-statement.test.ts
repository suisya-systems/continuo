import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { MIGRATIONS_DIR } from "../../src/control_plane/migrator.js";
import { isCompleteStatement, splitLinesKeepEnds } from "../../src/sqlite/complete-statement.js";

/**
 * The differential corpus that pins the `sqlite3_complete` transcription.
 *
 * `src/sqlite/complete-statement.ts` transcribes SQLite's own
 * `sqlite3_complete()` because better-sqlite3 exposes no equivalent and the
 * migrator needs one to split a step file into statements. A transcription that
 * is 99% right is a transcription that silently truncates trigger DDL, so it is
 * checked against the original rather than reviewed by eye.
 *
 * `parity/oracle/complete-statement-vector.json` holds what Python's
 * `sqlite3.complete_statement` -- SQLite's own function -- answers for every
 * input. Regenerate it with `scripts/oracle/dump_complete_statement.py`
 * (DECISIONS.md D-0013).
 *
 * The corpus is **rebuilt, not committed**: it is every cumulative line-prefix
 * of the shipped migration files, which are already in the repository, plus the
 * adversarial cases in `parity/oracle/complete-statement-corpus.json`. The
 * prefixes of an 85 KB file come to tens of megabytes; committing them to
 * assert 2,271 booleans would be absurd, and rebuilding them from the committed
 * files is exact.
 *
 * This corpus earned its place on its first run: it found a wrong cell in the
 * transcribed state table (state 6, TRIGGER, on a SEMI token) that made the
 * machine treat the first semicolon *inside* a trigger body as a statement
 * terminator. 42 of the 2,203 inputs disagreed. Nothing else in the suite
 * caught it.
 */

const ORACLE_DIR = fileURLToPath(new URL("../../parity/oracle/", import.meta.url));

interface Vector {
  readonly sqlite_version: string;
  readonly count: number;
  readonly expected: boolean[];
}

/**
 * Rebuild the corpus in the exact order the Python side built it.
 *
 * Kept in one function used by every case below, because a corpus that the two
 * halves construct differently is a comparison of two different things.
 */
function corpus(): string[] {
  const inputs: string[] = [];
  for (const name of readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    const text = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    let buffer = "";
    for (const line of splitLinesKeepEnds(text)) {
      buffer += line;
      inputs.push(buffer);
    }
  }
  const adversarial = JSON.parse(
    readFileSync(join(ORACLE_DIR, "complete-statement-corpus.json"), "utf8"),
  ) as { adversarial: string[] };
  inputs.push(...adversarial.adversarial);
  return inputs;
}

function vector(): Vector {
  return JSON.parse(
    readFileSync(join(ORACLE_DIR, "complete-statement-vector.json"), "utf8"),
  ) as Vector;
}

describe("sqlite3_complete transcription", () => {
  test("agrees with SQLite's own answer on every corpus input", () => {
    const inputs = corpus();
    const expected = vector();

    // The corpus must be the same length on both sides, or the comparison is
    // silently off by however many inputs a migration file gained or lost. This
    // is also what turns "someone edited a step file" into an explicit failure
    // telling them to regenerate the vector.
    expect(
      inputs.length,
      "corpus length changed -- regenerate parity/oracle/complete-statement-vector.json " +
        "with scripts/oracle/dump_complete_statement.py",
    ).toBe(expected.count);
    expect(expected.expected).toHaveLength(expected.count);

    const mismatches: { index: number; expected: boolean; actual: boolean; tail: string }[] = [];
    for (const [index, input] of inputs.entries()) {
      const actual = isCompleteStatement(input);
      if (actual !== expected.expected[index]) {
        mismatches.push({
          index,
          expected: expected.expected[index] as boolean,
          actual,
          tail: input.slice(-120),
        });
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(mismatches).toHaveLength(0);
  });

  test("the corpus is not vacuous", () => {
    // A corpus rebuilt from a missing migrations directory, or a vector of all
    // one value, would make the comparison above pass while proving nothing.
    const inputs = corpus();
    const expected = vector();
    expect(inputs.length).toBeGreaterThan(2_000);
    expect(inputs.some((input) => input.toLowerCase().includes("create trigger"))).toBe(true);
    // Both answers are represented, so neither a stuck-true nor a stuck-false
    // implementation could agree with the vector everywhere.
    expect(expected.expected.filter(Boolean).length).toBeGreaterThan(100);
    expect(expected.expected.filter((value) => !value).length).toBeGreaterThan(100);
  });

  test("the trigger-body semicolon is not a statement terminator", () => {
    // The exact bug the corpus caught, kept as a named case so a future reader
    // meets it as a property rather than as one index in a vector.
    expect(isCompleteStatement("CREATE TRIGGER t BEFORE DELETE ON x BEGIN SELECT 1;")).toBe(false);
    expect(isCompleteStatement("CREATE TRIGGER t BEFORE DELETE ON x BEGIN SELECT 1; END;")).toBe(
      true,
    );
  });
});
