import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Executable half of docs/cli-output-policy.md (D-0006).
 *
 * Inherited accident class from the Python lineage: a non-ASCII character in a
 * help string or a `print()` crashes with UnicodeEncodeError on a cp932 Windows
 * console, and it does so only on a real terminal -- a test harness that
 * captures stdout as UTF-8 never sees it. The mechanical rule below is
 * deliberately wider than the policy it enforces (whole file, not just output
 * literals), because "is this string ever printed?" is not decidable by
 * inspection, and an em dash in a comment costs nothing to avoid.
 *
 * Scope: source that continuo ships or executes. Prose files (docs/, README,
 * DECISIONS.md) are exempt -- they are read, never written to a console.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCANNED_DIRS = ["src", "scripts", "test"];
const SCANNED_EXTENSIONS = [".ts", ".mts", ".mjs", ".js", ".json", ".sql"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function offendersIn(text: string): { line: number; column: number; char: string }[] {
  const found: { line: number; column: number; char: string }[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const [column, char] of [...line].entries()) {
      const code = char.codePointAt(0) ?? 0;
      // Tab, and the printable ASCII range. `\r` is tolerated so a file checked
      // out with CRLF on the Windows cell does not fail for its line endings.
      if (code === 9 || code === 13 || (code >= 32 && code <= 126)) continue;
      found.push({ line: index + 1, column: column + 1, char });
    }
  }
  return found;
}

describe("ASCII-only output policy", () => {
  const files = SCANNED_DIRS.flatMap((dir) => walk(join(REPO_ROOT, dir)));

  it("scans a non-empty set of files", () => {
    // Guards its own vacuity: a moved directory or a changed extension list
    // must fail here rather than silently checking nothing.
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => relative(REPO_ROOT, f).split(sep).join("/")))(
    "%s contains only ASCII",
    (relativePath) => {
      const text = readFileSync(join(REPO_ROOT, relativePath), "utf8");
      const offenders = offendersIn(text);
      expect(
        offenders.map(
          (o) =>
            `${relativePath}:${o.line}:${o.column} U+${(o.char.codePointAt(0) ?? 0)
              .toString(16)
              .toUpperCase()
              .padStart(4, "0")}`,
        ),
      ).toEqual([]);
    },
  );
});
