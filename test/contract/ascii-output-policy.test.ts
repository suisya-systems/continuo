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

/**
 * Directories never descended into. `node_modules` and `dist` are not continuo's
 * source; `.git` is not text.
 */
const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);

/** Extensions scanned at the repository root. Code only -- see rootSourceFiles. */
const ROOT_SCANNED_EXTENSIONS = [".ts", ".mts", ".mjs", ".js"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Root-level source files, which are not inside any scanned directory and are
 * easy to forget. `vitest.config.ts` in particular writes the seed line to
 * stderr on every single run, so a non-ASCII character there would reach a
 * cp932 console more reliably than anything in src/.
 *
 * Discovered rather than listed, so a new root-level script is covered the day
 * it is added instead of the day someone remembers this file.
 */
function rootSourceFiles(): string[] {
  return readdirSync(REPO_ROOT)
    .filter((entry) => {
      // Dot-files are excluded and JSON is not scanned at the root. Both
      // exclusions keep this list deterministic: a working copy may hold
      // untracked local files (editor state, tooling config) that are not
      // continuo's source and must not decide whether the suite is green.
      // Root JSON is configuration -- package.json, tsconfig.json -- and is
      // never written to a console.
      if (entry.startsWith(".")) return false;
      const full = join(REPO_ROOT, entry);
      if (!statSync(full).isFile()) return false;
      return ROOT_SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext));
    })
    .map((entry) => join(REPO_ROOT, entry));
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
  const files = [
    ...SCANNED_DIRS.flatMap((dir) => walk(join(REPO_ROOT, dir))),
    ...rootSourceFiles(),
  ];
  const relativePaths = files.map((f) =>
    relative(REPO_ROOT, f).split(sep).join("/"),
  );

  it("scans a non-empty set of files", () => {
    // Guards its own vacuity: a moved directory or a changed extension list
    // must fail here rather than silently checking nothing.
    expect(files.length).toBeGreaterThan(5);
  });

  it("scans the root-level files that write to a console", () => {
    // Named explicitly, because this one is reached only through
    // rootSourceFiles() and its omission is what a directory-only scan looks
    // like when it is wrong.
    expect(relativePaths).toContain("vitest.config.ts");
  });

  it.each(relativePaths)(
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
