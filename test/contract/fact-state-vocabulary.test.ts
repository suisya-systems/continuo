/**
 * The one closed fact-state vocabulary, wherever this repository writes it down.
 *
 * `D-0901` makes `src/attention/fact_state.ts` the canonical statement of the six names for
 * continuo's detector layer. It is not the only statement: four other places already carried the
 * set or a decision about it, each written against a different subject and each with its own
 * reason to be where it is --
 *
 * | where | subject |
 * |---|---|
 * | `src/attention/fact_state.ts` | the detector layer's vocabulary (`D-0901`) |
 * | `src/measurement/fixtures.ts` | the seventh-value refusal on a fixture label |
 * | `test/fault_injection/contract.ts` | the acceptance harness's vocabulary check |
 * | `DECISIONS.md` `D-0302` | the oracle the S1 prose lint reads |
 * | `DECISIONS.md` `D-0901` | the adoption itself |
 *
 * Consolidating them into one import was considered and rejected: the fault-injection contract is
 * deliberately free of `src/` imports, and a decision record cannot import anything at all. What
 * is left once consolidation is off the table is drift, and this file is the check that catches
 * it. Target-only: it translates no source case and belongs to no belt's ledger, like every other
 * file in `test/contract/`.
 *
 * The sixth party is the **DDL**, which is here for the opposite reason. `incident.fact_state` is
 * unconstrained text on purpose -- a `CHECK` duplicating the closed set would turn a `D-` entry
 * that extends it into a migration of a schema that promises no migration -- and `D-0034` ratified
 * that this belt carries that as-is rather than repairing it. So the assertion is that the
 * constraint is **absent**, which is the one form of agreement the other five cannot state about
 * themselves.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { FACT_STATES as ATTENTION_FACT_STATES } from "../../src/attention/fact_state.js";
import { FACT_STATES as FIXTURE_FACT_STATES } from "../../src/measurement/fixtures.js";
import { FACT_STATES as HARNESS_FACT_STATES } from "../fault_injection/contract.js";

function repoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");
}

const DECISIONS = repoFile("DECISIONS.md");

/**
 * Read a decision entry's `- \`NAME\`` bullets, by the parse the S1 lint uses.
 *
 * Reproduced rather than shared with `test/session/provider-contract.test.ts`: that case's whole
 * substance is that it performs interlock's own parse, and importing a helper from here would put
 * this file between it and the entry it reads. Both fail loudly on an implausible parse, for the
 * same reason -- a reformatting that breaks the bullets must go red rather than check nothing.
 *
 * The em dash is written as an escape so this file stays ASCII, and the heading each entry uses is
 * passed in because the two entries were written at different times and do not share a spelling
 * (`D-0302` opens with an em dash, `D-0901` with two hyphens).
 */
function namesUnder(heading: string): readonly string[] {
  const at = DECISIONS.indexOf(heading);
  expect(at, `${heading} was not found in DECISIONS.md`).toBeGreaterThanOrEqual(0);
  const body = DECISIONS.slice(at + heading.length).split("\n## ")[0] ?? "";
  const names = [...body.matchAll(/^- `([A-Z][A-Z_]+)`$/gm)].map((match) => match[1] as string);
  expect(
    names.length,
    `implausible fact-state parse from ${heading}: ${JSON.stringify(names)}`,
  ).toBeGreaterThanOrEqual(6);
  return names;
}

describe("the closed fact-state vocabulary is one vocabulary", () => {
  test("D-0901's list is the six names D-0302 restated", () => {
    // D-0901 supersedes D-0302's "restatement, not an adoption" limitation and does NOT amend
    // D-0302, because the S1 lint parses that entry by heading. Two entries carrying the set is
    // therefore deliberate, and this is what stops them from disagreeing.
    expect(namesUnder("## D-0901 --")).toEqual(namesUnder("## D-0302 \u2014"));
  });

  test("the detector layer's vocabulary is the one D-0901 adopts", () => {
    expect([...ATTENTION_FACT_STATES]).toEqual([...namesUnder("## D-0901 --")]);
  });

  test("the measurement fixture guard refuses a seventh value from the same list", () => {
    // `src/measurement/fixtures.ts` rejects any `fact_state` outside this set, so a divergence
    // here makes a label the detector layer would produce unloadable by the grader.
    expect([...FIXTURE_FACT_STATES]).toEqual([...ATTENTION_FACT_STATES]);
  });

  test("the acceptance harness checks against the same list", () => {
    expect([...HARNESS_FACT_STATES]).toEqual([...ATTENTION_FACT_STATES]);
  });

  test("the two src copies are closed at runtime, not merely typed readonly", () => {
    // `readonly` and `as const` are erased at emit. A seventh state is a `D-` entry in every one of
    // these places, and a caller that could push one onto the array would have added a fact state
    // without writing that entry.
    //
    // `test/fault_injection/contract.ts`'s copy is deliberately NOT on this list. It is closed by
    // `as const` alone, which is a compile-time claim; strengthening it would be an edit to a
    // landed belt's file, which `D-0504` established is its own PR rather than a passing change
    // made by whichever belt notices. The difference is recorded here and in `D-0901` rather than
    // silently fixed or silently ignored -- the value agreement above is asserted for all three
    // regardless, and that is the property this file exists for.
    for (const [name, list] of [
      ["src/attention/fact_state.ts", ATTENTION_FACT_STATES],
      ["src/measurement/fixtures.ts", FIXTURE_FACT_STATES],
    ] as const) {
      expect(Object.isFrozen(list), `${name}'s list is not frozen`).toBe(true);
    }
    expect(Object.isFrozen(HARNESS_FACT_STATES), "recorded, not asserted -- see above").toBe(false);
  });

  test("the DDL constrains fact_state's emptiness and nothing else", () => {
    // Carried as-is (D-0034). Both the production migration and the spike schema say in prose why
    // the column is unconstrained; this asserts that the prose is still true of the SQL, which is
    // the half a comment cannot check. `spike-schema.test.ts` owns the behavioural pin (an
    // unknown fact state inserts successfully) and is deliberately not touched.
    for (const path of [
      "src/control_plane/spike_schema.sql",
      "src/control_plane/migrations/0001_initial.sql",
    ]) {
      const sql = withoutSqlComments(repoFile(path));
      const incident = tableBody(sql, "incident");
      const checks = [...incident.matchAll(/CHECK \(([^\n]*)\)/g)].map(
        (match) => match[1] as string,
      );
      const aboutFactState = checks.filter((check) => check.includes("fact_state"));

      expect(aboutFactState, `${path} constrains incident.fact_state beyond non-emptiness`).toEqual(
        ["length(fact_state) > 0"],
      );
      for (const state of ATTENTION_FACT_STATES) {
        expect(incident, `${path} names ${state} inside the incident table`).not.toContain(state);
      }
    }
  });
});

/** Strip `--` line comments, so a name mentioned in the rationale is not read as a constraint. */
function withoutSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at < 0 ? line : line.slice(0, at);
    })
    .join("\n");
}

/** The parenthesised body of one `CREATE TABLE`, up to the statement's terminating `);`. */
function tableBody(sql: string, table: string): string {
  const at = sql.indexOf(`CREATE TABLE ${table} (`);
  expect(at, `no CREATE TABLE ${table} in the schema`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n);", at);
  expect(end, `CREATE TABLE ${table} is unterminated`).toBeGreaterThan(at);
  return sql.slice(at, end);
}
