/**
 * Reading a rendered measurement report back, for the cases that compare one.
 *
 * These live outside `render.test.ts` because a second test file needs them.
 * Interlock's `tests/measurement/test_measurement_cli.py` imports them straight
 * from `tests/measurement/test_render.py`, which is free there because pytest
 * collects a module once however many times it is imported. Vitest collects per
 * **file**: importing `render.test.ts` from `cli.test.ts` would register all 71
 * of the render belt's cases a second time, under the importing file's name --
 * a parity ledger that counted them would be counting the same coverage twice.
 * So the shared half moves here, to a module the runner does not collect, and
 * both test files import it. Recorded as a systematic mapping in
 * `parity/measurement.cli.ledger.json` rather than as a decision: it changes
 * where the helpers live and nothing about what they assert.
 *
 * Nothing about the parsers themselves changed in the move. They are two
 * readers written against the report's *syntax* -- the table and fence shapes,
 * and JSON's -- and against nothing that names a field, which is what lets the
 * two of them stand on opposite sides of an equality assertion and catch a fact
 * that reaches one rendering and not the other.
 */

import { expect } from "vitest";

import { isAscii, reportValue } from "../../src/measurement/format.js";
import { PythonFloat } from "../../src/measurement/provenance.js";
import { cell, type ReportValue } from "../../src/measurement/render.js";

/**
 * The fixed clock every report in these two files is built at.
 *
 * `GENERATED_AT` is after `PERIOD_END`, because a report whose period has not
 * closed is refused and the cases here are about what a closed one renders.
 */
const T0 = 1_700_000_000_000;
const DAY_MS = 86_400_000;

/**
 * One object rather than four exported constants, because `PERIOD_START` *is*
 * `T0` -- the period opens at the instant the control plane was created -- and
 * two exported names for one binding is a duplicate export the repository's
 * unused-code gate refuses. The two names are both worth keeping: they mean
 * different things to a reader even where they hold the same number.
 */
export const REPORT_CLOCK = Object.freeze({
  /** The clock the control plane is migrated at. */
  T0,
  /** The period's inclusive start. */
  PERIOD_START: T0,
  /** The period's exclusive end, one day on. */
  PERIOD_END: T0 + DAY_MS,
  /** `generated_at_ms`: after the period closes, so the report is not refused. */
  GENERATED_AT: T0 + DAY_MS + 60_000,
});

/**
 * The vocabulary a verdict would be written in. Word boundaries, because
 * "passed" must fail this and "surpassed" is not the claim being policed.
 */
export const VERDICT_WORDS =
  /\b(pass|passes|passed|passing|fail|fails|failed|failing|go|no-go|nogo)\b/gi;

// --------------------------------------------------------------------------
// two parsers written here, neither one a copy of the report's field list
// --------------------------------------------------------------------------

const ROW = /^\| `([^`]+)` \| (.*) \|$/;
const BLOCK = /^### fact `([^`]+)`$/;

/**
 * Read a rendered Markdown report back into `key -> value`.
 *
 * Knows the table and fence syntax and nothing about which facts exist, which is
 * what makes it usable as one side of an equality assertion.
 *
 * The fence is read off the opening line rather than assumed to be three
 * backticks, because `D-0111` widens it past any run of backticks the value
 * holds. A parser that looked for a literal ``` would stop at the value's own
 * text on exactly the report the widening exists for.
 */
export function parseMarkdown(text: string): Map<string, string> {
  const facts = new Map<string, string>();
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    const row = ROW.exec(line);
    if (row !== null && row[1] !== "Fact") {
      const key = row[1] as string;
      expect(facts.has(key), `${key} appears twice in the Markdown`).toBe(false);
      facts.set(key, row[2] as string);
      index += 1;
      continue;
    }
    const block = BLOCK.exec(line);
    if (block !== null) {
      const opening = lines[index + 1] as string;
      expect(opening.startsWith("```"), opening).toBe(true);
      const fence = opening.slice(0, opening.length - "text".length);
      expect(/^`+$/.test(fence), opening).toBe(true);
      const end = lines.indexOf(fence, index + 2);
      expect(end, `the block for ${block[1]} is never closed`).toBeGreaterThan(index + 1);
      facts.set(block[1] as string, lines.slice(index + 2, end).join("\n"));
      index = end + 1;
      continue;
    }
    index += 1;
  }
  return facts;
}

/**
 * `JSON.parse`, keeping Python's int/float distinction.
 *
 * See the module docstring: `JSON.parse` collapses `1.0` and `1` into one
 * `number`, and the two are two different renderings on both sides of the
 * equality assertion. The reviver reads each number's own source text -- the
 * only place the distinction survives -- and the availability of that text is
 * asserted rather than assumed, because falling back silently turns a missing
 * runtime feature into a rendering-shaped inequality.
 */
export function parseReportJson(text: string): unknown {
  let sawSource = false;
  const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown => {
    if (typeof value === "number") {
      const source = context?.source;
      if (source === undefined) {
        return value;
      }
      sawSource = true;
      return /[.eE]/.test(source) ? new PythonFloat(value) : value;
    }
    return value;
  };
  const parsed: unknown = JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
  expect(
    sawSource,
    "JSON.parse did not hand the reviver the numbers' source text, so a float " +
      "cannot be told from an int here; this runtime is too old for this test",
  ).toBe(true);
  return parsed;
}

/**
 * Flatten a parsed JSON report into `dotted key -> rendered value`.
 *
 * Mappings recurse; every other leaf is rendered with the module's own cell
 * formatter, except a multi-line string, which the Markdown carries verbatim in
 * a fenced block and is therefore compared verbatim.
 */
export function walkJson(payload: unknown, prefix = ""): Map<string, string> {
  const flat = new Map<string, string>();
  if (isPlainObject(payload)) {
    const entries = Object.entries(payload);
    if (entries.length === 0) {
      flat.set(prefix, cell(null));
      return flat;
    }
    for (const [key, value] of entries) {
      for (const [nested, rendered] of walkJson(value, prefix === "" ? key : `${prefix}.${key}`)) {
        flat.set(nested, rendered);
      }
    }
    return flat;
  }
  if (typeof payload === "string" && payload.includes("\n")) {
    // The Markdown carries this in a fenced block, one escaped line per line
    // (D-0109 applied to a block; see `renderMarkdown`). Compared through the
    // same escape, so the equality is over the facts and not over which
    // rendering happened to be given a hostile value.
    flat.set(prefix, payload.split("\n").map(reportValue).join("\n"));
    return flat;
  }
  flat.set(prefix, cell(payload as ReportValue));
  return flat;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PythonFloat)
  );
}

/** Re-exported so a case that only needs the ASCII check has one import. */
export { isAscii };
