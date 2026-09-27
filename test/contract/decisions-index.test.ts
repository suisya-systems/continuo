/**
 * `DECISIONS.md`'s index table agrees with the entries below it.
 *
 * The index is what a reader -- and an AI worker building on the record -- scans first, and it is
 * written by hand in the same change as the entry, by lanes that append in parallel. Nothing else
 * reads it, so a row that is missing, or that still says `accepted` after its entry was superseded,
 * stays wrong until somebody happens to notice. This file is the check.
 *
 * The comparison, per id:
 *
 * - every entry heading (`## D-NNNN -- Title`) has exactly one index row, and every row an entry;
 * - the row's title is the heading's title, character for character (a `|` inside a title is
 *   written `\|` in the table);
 * - the row's status is the entry's `**Status.**` line, with backticks, a trailing period and a
 *   trailing parenthetical such as `(2026-08-22)` dropped. An entry with no `**Status.**` line
 *   reads as `accepted` -- many entries predate the line -- unless it is named in
 *   `INDEX_ONLY_STATUS` below.
 *
 * Target-only: it translates no source case and belongs to no belt's ledger, like every other file
 * in `test/contract/`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

interface Row {
  readonly title: string;
  readonly status: string;
}

interface Parsed {
  readonly index: ReadonlyMap<string, Row>;
  readonly entries: ReadonlyMap<string, Row>;
  readonly duplicates: readonly string[];
}

/** Entry headings use an em dash or two hyphens; the em dash is escaped to keep this file ASCII. */
const EM_DASH = String.fromCharCode(0x2014);
const HEADING = new RegExp(`^## (D-\\d{4}) (?:${EM_DASH}|--) (.*)$`, "m");

/**
 * Entries whose status the index records and the entry itself does not. `D-0906` supersedes
 * `D-0903` and says the entry "stays in this file exactly as written, marked superseded in the
 * index", so the index row is the only place that status is written down.
 */
const INDEX_ONLY_STATUS: ReadonlyMap<string, string> = new Map([
  ["D-0903", "superseded by D-0906"],
]);

function normaliseStatus(raw: string): string {
  return raw
    .replace(/`/g, "")
    .replace(/\.$/, "")
    .replace(/ \([^)]*\)$/, "")
    .trim();
}

function parse(text: string): Parsed {
  const split = text.indexOf("\n---\n");
  const head = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? "" : text.slice(split);
  const duplicates: string[] = [];

  const index = new Map<string, Row>();
  for (const row of head.matchAll(/^\| (D-\d{4}) \| (.*) \| ([^|]*) \|$/gm)) {
    const [, id, title, status] = row as unknown as [string, string, string, string];
    if (index.has(id)) duplicates.push(`index row ${id}`);
    index.set(id, { title: title.replace(/\\\|/g, "|"), status: status.trim() });
  }

  const entries = new Map<string, Row>();
  for (const chunk of body.split(/^(?=## D-\d{4} )/m)) {
    const heading = chunk.match(HEADING);
    if (heading === null || heading.index !== 0) continue;
    const [, id, title] = heading as unknown as [string, string, string];
    const status = chunk.match(/^\*\*Status\.\*\* (.*)$/m)?.[1];
    if (entries.has(id)) duplicates.push(`entry ${id}`);
    entries.set(id, {
      title: title.trim(),
      status:
        status === undefined ? (INDEX_ONLY_STATUS.get(id) ?? "accepted") : normaliseStatus(status),
    });
  }

  return { index, entries, duplicates };
}

/** Every disagreement between the index and the entries, one line each. */
function disagreements({ index, entries, duplicates }: Parsed): string[] {
  const found = duplicates.map((what) => `duplicate ${what}`);
  for (const [id, entry] of entries) {
    const row = index.get(id);
    if (row === undefined) {
      found.push(`${id}: entry has no index row`);
      continue;
    }
    if (row.title !== entry.title) {
      found.push(
        `${id}: index title ${JSON.stringify(row.title)} is not the heading's ${JSON.stringify(entry.title)}`,
      );
    }
    if (row.status !== entry.status) {
      found.push(
        `${id}: index status ${JSON.stringify(row.status)} is not the entry's ${JSON.stringify(entry.status)}`,
      );
    }
  }
  for (const id of index.keys()) {
    if (!entries.has(id)) found.push(`${id}: index row has no entry`);
  }
  return found;
}

const DECISIONS = readFileSync(
  fileURLToPath(new URL("../../DECISIONS.md", import.meta.url)),
  "utf8",
);

describe("DECISIONS.md index", () => {
  test("parses a plausible number of entries and rows", () => {
    // A reformatting that breaks either parse must go red here rather than compare two empty maps.
    const { index, entries } = parse(DECISIONS);
    expect(entries.size).toBeGreaterThanOrEqual(180);
    expect(index.size).toBeGreaterThanOrEqual(180);
  });

  test("has one row per entry, with the entry's title and status", () => {
    expect(disagreements(parse(DECISIONS))).toEqual([]);
  });

  test("reports each kind of drift it claims to catch", () => {
    // Anti-vacuity: a check never seen red is not a check.
    const doc = [
      "| ID | Title | Status |",
      "|---|---|---|",
      "| D-0001 | One | accepted |",
      "| D-0002 | Two \\| too | accepted |",
      "| D-0004 | Orphan | accepted |",
      "",
      "---",
      "",
      "## D-0001 -- One",
      "",
      "**Status.** accepted (2026-08-22)",
      "",
      `## D-0002 ${EM_DASH} Two | two`,
      "",
      "**Status.** superseded by `D-0003`",
      "",
      "## D-0003 -- Three",
      "",
    ].join("\n");
    expect(disagreements(parse(doc))).toEqual([
      'D-0002: index title "Two | too" is not the heading\'s "Two | two"',
      'D-0002: index status "accepted" is not the entry\'s "superseded by D-0003"',
      "D-0003: entry has no index row",
      "D-0004: index row has no entry",
    ]);
  });
});
