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
 * - **31 of 33** now. The two that remain are unreachable rather than
 *   unexercised, and are recorded as such in
 *   `parity/measurement.canary.ledger.json`:
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
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULES = [
  "ac9",
  "false-termination",
  "fixtures",
  "shadow",
  "canary",
  "latency",
  "provenance",
];

/** Each `reportValue(...)` call, once, in source order. */
function callSites(source) {
  const sites = [];
  for (const match of source.matchAll(/reportValue\(([^()]*(\([^()]*\))?[^()]*)\)/g)) {
    if (!sites.includes(match[0])) {
      sites.push(match[0]);
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
  symlinkSync(join(process.cwd(), "node_modules"), join(scratch, "node_modules"));

  let sites = 0;
  let covered = 0;
  for (const module of modules) {
    const path = join(scratch, "src", "measurement", `${module}.ts`);
    const original = readFileSync(path, "utf8");
    const uncovered = [];
    let hits = 0;
    for (const site of callSites(original)) {
      const inner = site.slice("reportValue(".length, -1);
      writeFileSync(path, original.replace(site, inner));
      let red = false;
      try {
        execFileSync("npx", ["vitest", "run", `test/measurement/${module}.test.ts`], {
          cwd: scratch,
          env: { ...process.env, CI: "1", CONTINUO_TEST_SEED: "7" },
          stdio: "ignore",
        });
      } catch {
        red = true;
      }
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
