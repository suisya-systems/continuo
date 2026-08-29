/**
 * The TypeScript half of the format-string differential oracle
 * (`docs/differential-oracle.md`, `scripts/oracle/dump_pyformat.py`).
 *
 * `src/attention/pyformat.ts` transcribes three CPython functions -- `string.Formatter().parse`,
 * `str.format_map` and `str.__format__` -- because `notify.render_text` runs an OPERATOR'S
 * template through all three. A ported test can only catch a divergence interlock's suite already
 * had an assertion for, and interlock's `test_notify.py` asserts about five templates. This file
 * makes the other claim: given the corpus, what CPython produced and what the transcription
 * produces are the same answer, compared on every field.
 *
 * Every case here is **target-only** -- none is counted as ported coverage. They are declared in
 * `parity/attention.notify.ledger.json`, which is also where the four divergences this oracle
 * found in the transcription's first draft are recorded.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { formatMap, parseFormat } from "../../src/attention/pyformat.js";
import { PyValueError } from "../../src/fencing/pysemantics.js";

const ROOT = join(import.meta.dirname, "..", "..");

interface Corpus {
  readonly values: Readonly<Record<string, string>>;
  readonly templates: readonly string[];
}

interface VectorRow {
  readonly template: string;
  readonly placeholders: readonly string[];
  readonly unknown: readonly string[];
  readonly rendered: string | null;
  readonly error: string | null;
  readonly message: string | null;
}

interface Vector {
  readonly generator: { readonly python: string; readonly implementation: string };
  readonly values: Readonly<Record<string, string>>;
  readonly rows: readonly VectorRow[];
}

const corpus = JSON.parse(
  readFileSync(join(ROOT, "parity", "oracle", "pyformat-corpus.json"), "utf8"),
) as Corpus;
const vector = JSON.parse(
  readFileSync(join(ROOT, "parity", "oracle", "pyformat-vector.json"), "utf8"),
) as Vector;

/** `notify._placeholders`, as the module's own private copy computes it. */
function placeholders(template: string): string[] {
  const out = new Set<string>();
  let chunks: ReturnType<typeof parseFormat>;
  try {
    chunks = parseFormat(template);
  } catch (error) {
    if (!(error instanceof PyValueError)) {
      throw error;
    }
    out.add("__invalid__");
    return [...out].sort();
  }
  for (const chunk of chunks) {
    if (chunk.fieldName === null || chunk.fieldName === "") {
      continue;
    }
    if (chunk.fieldName.includes(".") || chunk.fieldName.includes("[")) {
      out.add("__invalid__");
      continue;
    }
    out.add(chunk.fieldName);
  }
  return [...out].sort();
}

/** One row of this side's answer, in the vector's shape. */
function answer(template: string, values: Readonly<Record<string, string>>): VectorRow {
  const found = placeholders(template);
  const allowed = new Set(Object.keys(values));
  const unknown = found.filter((name) => !allowed.has(name)).sort();
  if (unknown.length > 0) {
    return { template, placeholders: found, unknown, rendered: null, error: null, message: null };
  }
  const map = Object.assign(Object.create(null) as Record<string, string>, values);
  try {
    return {
      template,
      placeholders: found,
      unknown,
      rendered: formatMap(template, map),
      error: null,
      message: null,
    };
  } catch (error) {
    if (!(error instanceof PyValueError)) {
      throw error;
    }
    return {
      template,
      placeholders: found,
      unknown,
      rendered: null,
      // CPython raises `ValueError` for every refusal this module can reach: `format_map`
      // supplies no positional argument tuple, so even `{}` and `{0}` are the "Format string
      // contains positional fields" `ValueError` rather than the `IndexError` an empty tuple
      // would have produced. The vector is what settled that, and the ledger records it.
      error: "ValueError",
      message: error.message,
    };
  }
}

describe("the pyformat vector is not vacuous", () => {
  test("the corpus rebuilds to the size the vector was generated at", () => {
    expect(vector.rows.length).toBe(corpus.templates.length);
    expect(vector.rows.map((row) => row.template)).toEqual([...corpus.templates]);
    expect(vector.values).toEqual(corpus.values);
  });

  test("the corpus exercises every outcome the module can produce", () => {
    // A corpus that only rendered, or only refused, would let half the transcription be wrong
    // with the oracle green -- which is the failure mode section 5 of the oracle document names.
    expect(vector.rows.filter((row) => row.rendered !== null).length).toBeGreaterThan(20);
    expect(vector.rows.filter((row) => row.error !== null).length).toBeGreaterThan(10);
    expect(vector.rows.filter((row) => row.unknown.length > 0).length).toBeGreaterThan(4);
    expect(vector.rows.filter((row) => row.unknown.includes("__invalid__")).length).toBeGreaterThan(
      4,
    );
  });
});

describe("CPython's format-string machinery agrees with the transcription at every position", () => {
  test("every template in the corpus", () => {
    const mine = corpus.templates.map((template) => answer(template, vector.values));
    // Compared as WHOLE ROWS rather than field by field in a loop: a mismatch then prints the
    // template beside both answers, which is the diff a reader can act on.
    expect(mine).toEqual(vector.rows.map((row) => ({ ...row })));
  });
});
