import { readdirSync, readFileSync, statSync } from "node:fs";
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
 *
 * One narrow exemption, and it comes with a replacement guard rather than a
 * hole. A document CARRIED VERBATIM from interlock cannot be edited to satisfy
 * this rule: its bytes are pinned by digest in `carried-documents.test.ts` and
 * the artefacts rendered from it are compared byte for byte, so "just remove
 * the em dash" would break parity in order to satisfy a policy about consoles.
 * `role_configs_schema.json` carries Japanese `docs_section` values and several
 * em dashes for exactly that reason. So the whole-file scan skips it, and
 * {@link CARRIED_VERBATIM}'s own test takes over: it asserts WHICH KEYS of the
 * schema hold non-ASCII, which is the question the console hazard actually
 * turns on -- a non-ASCII string under `permissions.allow` reaches every
 * rendered `settings.local.json` and therefore every console, where one under
 * `description` is dropped before rendering and never can.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCANNED_DIRS = ["src", "scripts", "test"];
const SCANNED_EXTENSIONS = [".ts", ".mts", ".mjs", ".js", ".json", ".sql"];

/**
 * Directories never descended into. `node_modules` and `dist` are not continuo's
 * source; `.git` is not text.
 */
const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);

/**
 * Documents carried byte-for-byte from interlock, whose bytes this repository
 * is not free to change. Kept in step with `carried-documents.test.ts`'s
 * `CARRIED` list by hand, deliberately: this is a short list, and an exemption
 * that grew automatically with that list would be an exemption nobody reviewed.
 */
const CARRIED_VERBATIM = new Set(["src/settings/role_configs_schema.json"]);

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
  const allPaths = files.map((f) => relative(REPO_ROOT, f).split(sep).join("/"));
  const relativePaths = allPaths.filter((p) => !CARRIED_VERBATIM.has(p));

  it("scans a non-empty set of files", () => {
    // Guards its own vacuity: a moved directory or a changed extension list
    // must fail here rather than silently checking nothing.
    expect(files.length).toBeGreaterThan(5);
  });

  it("the carried-verbatim exemption still names a file that is actually scanned", () => {
    // An exemption for a path the walk never reaches is an exemption that will
    // silently stop covering anything the day the file moves.
    for (const exempt of CARRIED_VERBATIM) {
      expect(allPaths, `${exempt} is exempted but not scanned`).toContain(exempt);
    }
  });

  it("scans the root-level files that write to a console", () => {
    // Named explicitly, because this one is reached only through
    // rootSourceFiles() and its omission is what a directory-only scan looks
    // like when it is wrong.
    expect(relativePaths).toContain("vitest.config.ts");
  });

  it.each(relativePaths)("%s contains only ASCII", (relativePath) => {
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
  });
});

/**
 * The replacement guard for the one carried-verbatim exemption above.
 *
 * The console hazard is not "this file contains a Japanese character"; it is
 * "a Japanese character reaches a `print()`". For the role-configs schema those
 * are different questions, because the renderer drops most of the document
 * before anything is emitted: `description` and `$comment` are stripped from
 * every role body (`_META_KEYS`), and the `$comment_*` keys hang on containers
 * the renderer never descends into.
 *
 * So this asserts the SHAPE of where non-ASCII lives, keyed by path with the
 * role names collapsed to `*`. A re-carry that moved one of these strings into
 * `permissions.allow`, or added a non-ASCII rule spec, changes the set and
 * turns this red -- which is the change that would matter, and the one a
 * whole-file byte scan cannot distinguish from the change that does not.
 */
describe("the carried role-configs schema keeps its non-ASCII out of the rendered surface", () => {
  const SCHEMA = "src/settings/role_configs_schema.json";

  /**
   * Where a non-ASCII string is allowed to sit, as a key path with every role
   * name replaced by `*`.
   *
   * `roles.*.docs_section` is the one entry on this list that CAN reach a
   * console: it is not a `_META_KEYS` key, so `settings show --role-kind org
   * --json` prints it, and interlock prints it too (`ensure_ascii=False`). That
   * is inherited behaviour, recorded as such in
   * `parity/settings.settings-generator.ledger.json`; it is disclosed here
   * rather than repaired, because repairing it would mean this port emitting a
   * different document from its source.
   */
  const ALLOWED_PATHS: ReadonlySet<string> = new Set([
    "global.$comment_forbidden_allow_regex",
    "roles.*.description",
    "roles.*.docs_section",
    "worker_roles.$comment",
    "worker_roles.*.description",
  ]);

  function nonAsciiPaths(value: unknown, path: readonly string[] = []): string[] {
    if (typeof value === "string") {
      return [...value].some((c) => (c.codePointAt(0) ?? 0) > 126) ? [path.join(".")] : [];
    }
    if (Array.isArray(value)) {
      return value.flatMap((v, i) => nonAsciiPaths(v, [...path, String(i)]));
    }
    if (typeof value === "object" && value !== null) {
      return Object.entries(value).flatMap(([key, v]) => {
        // Collapse the role name so the expectation is about the FIELD, not
        // about which roles happen to be authored today.
        const segment = path.length === 1 && !key.startsWith("$") ? "*" : key;
        return nonAsciiPaths(v, [...path, segment]);
      });
    }
    return [];
  }

  it("every non-ASCII string sits under a key the renderer drops, or docs_section", () => {
    const schema: unknown = JSON.parse(readFileSync(join(REPO_ROOT, SCHEMA), "utf8"));
    const found = new Set(nonAsciiPaths(schema));
    // Both directions: an unexpected path is a new console hazard, and a
    // disappeared one means this guard has stopped watching what it names.
    expect([...found].sort()).toEqual([...ALLOWED_PATHS].sort());
  });

  it("no permission rule, hook or sandbox entry carries a non-ASCII character", () => {
    // The narrow, direct form of the same claim, spelled out because these are
    // the fields that reach a rendered settings.local.json verbatim.
    const schema: unknown = JSON.parse(readFileSync(join(REPO_ROOT, SCHEMA), "utf8"));
    const risky = nonAsciiPaths(schema).filter((p) =>
      ["permissions", "hooks", "sandbox", "required_allow", "required_deny", "env"].some((field) =>
        p.split(".").includes(field),
      ),
    );
    expect(risky).toEqual([]);
  });
});
