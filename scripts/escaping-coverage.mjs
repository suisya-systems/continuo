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
 *   wrong. It found call sites with a regular expression that allowed at most
 *   one nested `(...)` group, so `reportValue(renderCell(value).trim())` in
 *   `provenance.ts` was never mutated and never counted. A site this script
 *   cannot see is a site it cannot report as uncovered, so the omission made
 *   the score look better rather than worse. The scan is now balanced-
 *   parenthesis (see `callSites`).
 * - **32 of 34** now, with the recovered site measured and covered. The two
 *   that remain are unreachable rather than unexercised, and are recorded as
 *   such in `parity/measurement.canary.ledger.json`:
 *   - `finding.interlock.store` is `INTERLOCK_STORE`, a module constant;
 *   - `evidence.uri` comes from `pathToFileURL`, which percent-encodes every
 *     non-ASCII byte and every control character, so the value is printable
 *     ASCII however the database's directory is named.
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

const MODULES = [
  "ac9",
  "false-termination",
  "fixtures",
  "shadow",
  "canary",
  "latency",
  "provenance",
];

/**
 * Each `reportValue(...)` call, once, in source order.
 *
 * The argument is found by scanning for the parenthesis that balances the one
 * the call opens, NOT by a regular expression. An earlier version matched at
 * most one nested `(...)` group and so silently skipped
 * `reportValue(renderCell(value).trim())` in `provenance.ts`, which has two --
 * the call and the method call after it. That is the worst failure this script
 * can have: a site it never mutates is a site it never reports as uncovered,
 * so the omission shrinks the denominator and reads as a better result. The
 * review gate caught it; nothing here would have.
 */
function callSites(source) {
  const sites = [];
  const open = "reportValue(";
  for (let at = source.indexOf(open); at !== -1; at = source.indexOf(open, at + 1)) {
    let depth = 0;
    let end = -1;
    for (let i = at + open.length - 1; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      throw new Error(`unbalanced reportValue( at offset ${at}`);
    }
    const site = source.slice(at, end + 1);
    if (!sites.includes(site)) {
      sites.push(site);
    }
  }
  return sites;
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
    for (const site of callSites(original)) {
      const inner = site.slice("reportValue(".length, -1);
      writeFileSync(path, original.replace(site, inner));
      const red = !isGreen(module);
      writeFileSync(path, original);
      if (red) {
        hits += 1;
      } else {
        uncovered.push(inner);
      }
    }
    const total = callSites(original).length;
    sites += total;
    covered += hits;
    const tail = uncovered.length > 0 ? `  UNCOVERED: ${uncovered.join(", ")}` : "";
    process.stdout.write(`${module.padEnd(18)} ${hits}/${total}${tail}\n`);
  }
  process.stdout.write(`\ncoverage ${covered}/${sites}\n`);
  process.stdout.write(`scratch tree left at ${scratch}\n`);
}

main();
