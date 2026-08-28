/**
 * How much of the renderers' escaping is actually pinned by a test?
 *
 * `D-0109` routes every externally-supplied value a measurement report prints
 * through `reportValue`. Adding those calls is easy; knowing that a test would
 * notice if one were deleted is not, and the two are routinely confused. A
 * suite can be green because the escaping works, or green because nothing
 * exercises it -- and from the outside those look identical.
 *
 * So this measures it. For each `reportValue(x)` call in a measurement module it
 * removes exactly that call, leaving `x`, and runs that module's own test file.
 * A site is **covered** when the suite goes red. A site that stays green is one
 * where the escaping could be deleted tomorrow and nothing would say so.
 *
 * The numbers this produced while `D-0109` was being written, which are the
 * reason it exists:
 *
 * - **22 of 31** on the first pass. The gap was not missing tests but weak
 *   hostile values: some carried only a newline and some only a non-ASCII
 *   character, so a site printing the first hid from the ASCII assertion and a
 *   site printing the second hid from the line-count one.
 * - **28 of 31** once every hostile value carried BOTH at once, and cases were
 *   added for the branches only reached when a v1 side is absent.
 * - **31 of 33** as this script first reported it -- and that denominator was
 *   wrong twice over, for the same reason in two spellings. The scan was
 *   textual, and a text scan is blind to whatever shape it did not anticipate:
 *   a regex allowing one nested `(...)` group missed
 *   `reportValue(renderCell(value).trim())` in `provenance.ts`, and matching
 *   the literal `reportValue(` missed `audit.recordClasses.map(reportValue)` in
 *   `canary.ts`, where the function is passed rather than called. Both misses
 *   are silent, and both fail in the one direction a measurement must not: an
 *   unseen site is never reported as uncovered, so it shrinks the denominator
 *   and reads as a BETTER score.
 * - **33 of 35** at that point. `callSites` walks the TypeScript AST instead, which ends
 *   that class rather than patching instances of it -- an identifier is an
 *   identifier however it is spelled. Both recovered sites measure as covered.
 *   The two that remain are unreachable rather than unexercised, and are
 *   recorded as such in `parity/measurement.canary.ledger.json`:
 *   - `finding.interlock.store` is `INTERLOCK_STORE`, a module constant;
 *   - `evidence.uri` comes from `pathToFileURL`, which percent-encodes every
 *     non-ASCII byte and every control character, so the value is printable
 *     ASCII however the database's directory is named.
 * - **37 of 39** now, with `render.ts` added. Four sites -- a banner line, a
 *   dotted key, a table cell and a line of a fenced block -- and all four
 *   covered. The block one is why the module is in this list at all rather than
 *   being taken on trust: the first version of that renderer left fenced blocks
 *   verbatim, on the argument that only this package's own constants reach one,
 *   and the argument was wrong. A fact carrying a newline becomes a block, and a
 *   fact is whatever the database or the caller supplied -- a v1 shadow source,
 *   a run id, a baseline's description. Nothing in the file looked wrong; the
 *   report simply carried a non-ASCII line through to the console, and only
 *   rendering a hostile report showed it.
 *
 * **A hostile value that is also a path needs care.** A newline is a legal
 * filename character on POSIX and an invalid one on Windows, so a fixture that
 * builds a directory from one passes locally and fails only on the Windows
 * cells, with an `ENOENT` from `mkdir` and no assertion reached. Where the value
 * under test becomes a path -- a corpus root, a fixture case id -- give it the
 * non-ASCII half only, and route the newline through a value that is not a path.
 *
 * Run it from the repository root:
 *
 *     node scripts/escaping-coverage.mjs            # every module
 *     node scripts/escaping-coverage.mjs canary     # one module
 *
 * It copies the tree to a scratch directory and never edits the working copy.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const MODULES = [
  "ac9",
  "false-termination",
  "fixtures",
  "shadow",
  "canary",
  "latency",
  "provenance",
  "render",
];

/**
 * Every reference to `reportValue` in the module, as a mutation site.
 *
 * Found by walking the TypeScript AST, NOT by scanning text. Two successive
 * versions of this scan were text-based and each was found blind to a spelling
 * it did not anticipate: a regex allowing one nested `(...)` group missed
 * `reportValue(renderCell(value).trim())`, and matching the literal
 * `reportValue(` missed `audit.recordClasses.map(reportValue)`, where the
 * function is passed rather than called. Both failures are silent and both
 * point the same way -- a site the scan cannot see is never mutated, never
 * reported as uncovered, and quietly shrinks the denominator, so the omission
 * always reads as a BETTER score. That is the one direction a measurement must
 * not fail in, and a third unanticipated spelling was always going to exist.
 *
 * The AST ends the class rather than patching instances of it. An identifier is
 * an identifier however it is spelled, comments and string literals are trivia
 * and never match, and each occurrence carries its own offsets -- so two
 * textually identical calls are two sites and are mutated separately, which the
 * text versions could not do (they deduplicated by text and then mutated only
 * the first occurrence).
 *
 * A site is mutated by removing the protection and leaving the value:
 * a call becomes its own argument, and a reference becomes the identity
 * function.
 */
function callSites(source, fileName) {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sites = [];

  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === "reportValue") {
      const parent = node.parent;
      if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) {
        // The import binding names the helper; it is not a use of it.
      } else if (ts.isCallExpression(parent) && parent.expression === node) {
        const argument = parent.arguments.map((one) => one.getText(parsed)).join(", ");
        sites.push({
          label: argument,
          start: parent.getStart(parsed),
          end: parent.getEnd(),
          replacement: argument,
        });
      } else {
        // Passed rather than called -- `.map(reportValue)` and anything else
        // that hands the function on. Removing the protection here means
        // handing on something that returns its input unchanged.
        sites.push({
          label: `${parent.getText(parsed)} (reportValue passed as a reference)`,
          start: node.getStart(parsed),
          end: node.getEnd(),
          replacement: "((value) => value)",
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return sites;
}

/** `source` with exactly one site's protection removed. */
function withoutSite(source, site) {
  return source.slice(0, site.start) + site.replacement + source.slice(site.end);
}

function main() {
  const wanted = process.argv.slice(2);
  const modules = wanted.length > 0 ? wanted : MODULES;

  const scratch = mkdtempSync(join(tmpdir(), "continuo-escaping-"));
  for (const entry of ["src", "test", "package.json", "tsconfig.json", "vitest.config.ts"]) {
    cpSync(entry, join(scratch, entry), { recursive: true });
  }
  // "junction" rather than a plain directory symlink: on Windows, creating a
  // directory symlink needs Developer Mode or SeCreateSymbolicLinkPrivilege, so
  // an ordinary non-administrator run fails with EPERM here -- before a single
  // test runs, on the platform whose CI cells this script is meant to serve.
  // A junction needs no privilege and no elevation. The type argument is
  // ignored on POSIX, so this is the same call there.
  symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "junction");

  // Run vitest through this same node binary and vitest's own entry script
  // rather than through `npx`. `execFileSync` without a shell cannot launch
  // `npx` on Windows, where the executable is `npx.cmd`, and that failure would
  // arrive as a thrown error -- which is exactly what this script reads as
  // "the mutation was caught". Resolving the entry makes the invocation mean
  // the same thing on every platform in the matrix.
  const requireFromScratch = createRequire(join(scratch, "package.json"));
  const vitestManifest = requireFromScratch.resolve("vitest/package.json");
  const vitestEntry = join(
    dirname(vitestManifest),
    JSON.parse(readFileSync(vitestManifest, "utf8")).bin.vitest,
  );

  /** Green or red for `module`'s own test file, in the scratch tree as it stands. */
  function isGreen(module) {
    try {
      execFileSync(process.execPath, [vitestEntry, "run", `test/measurement/${module}.test.ts`], {
        cwd: scratch,
        env: { ...process.env, CI: "1", CONTINUO_TEST_SEED: "7" },
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }

  let sites = 0;
  let covered = 0;
  for (const module of modules) {
    const path = join(scratch, "src", "measurement", `${module}.ts`);
    const original = readFileSync(path, "utf8");

    // Read the failure, not the colour (conventions section 10). A red run only
    // means "this mutation was caught" if the same suite is green when nothing
    // is mutated. Without this check a module whose tests cannot even start --
    // a pre-existing failure, a collection-time crash, a vitest that will not
    // launch -- reports every one of its sites as covered, and the script's
    // whole output becomes a fail-open that reads as a perfect score.
    if (!isGreen(module)) {
      throw new Error(
        `${module}: the unmutated suite is not green, so a red run would prove nothing. ` +
          `Fix test/measurement/${module}.test.ts first, then re-measure.`,
      );
    }

    const uncovered = [];
    let hits = 0;
    const found = callSites(original, `${module}.ts`);
    for (const site of found) {
      writeFileSync(path, withoutSite(original, site));
      const red = !isGreen(module);
      writeFileSync(path, original);
      if (red) {
        hits += 1;
      } else {
        uncovered.push(site.label);
      }
    }
    const total = found.length;
    sites += total;
    covered += hits;
    const tail = uncovered.length > 0 ? `  UNCOVERED: ${uncovered.join(", ")}` : "";
    process.stdout.write(`${module.padEnd(18)} ${hits}/${total}${tail}\n`);
  }
  process.stdout.write(`\ncoverage ${covered}/${sites}\n`);
  process.stdout.write(`scratch tree left at ${scratch}\n`);
}

main();
