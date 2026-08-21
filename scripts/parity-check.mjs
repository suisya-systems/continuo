/**
 * The parity ledger's enforcement.
 *
 * A ledger nobody checks is a spreadsheet. This is the check, and it is wired
 * into `npm run verify` and into CI so that the ways a port silently loses
 * coverage all turn the gate red:
 *
 *  1. **missing**   -- a source case with no ledger entry.
 *  2. **duplicate** -- one source case claimed twice, or two source cases
 *                      pointing at one target test (which would look like full
 *                      coverage while half of it was never written).
 *  3. **unmapped**  -- a target test in a ported file that no ledger entry
 *                      claims, and that is not declared target-only. Without
 *                      this, a case could be deleted from the ledger and left
 *                      running, or added to the file and never accounted for.
 *  4. **unapproved non-running tests** -- any `skip`, `todo`, `fails`, or
 *                      `xfail` construct anywhere under `test/` that the ledger
 *                      does not name, with a reason. A skip added quietly is
 *                      the cheapest way to make a port look finished.
 *  5. **shrinkage** -- fewer source cases, or fewer mapped cases, than the
 *                      ledger's own recorded totals.
 *
 * Run: `node scripts/parity-check.mjs`
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGERS = ["parity/control-plane.ledger.json"];

/** Constructs that stop a test from running, or expect it to fail. */
const NON_RUNNING = [
  /\b(?:test|it|describe)\.skip\b/,
  /\b(?:test|it|describe)\.todo\b/,
  /\b(?:test|it)\.fails\b/,
  /\bskipIf\(/,
  /\bxfail\(/,
];

const problems = [];

function fail(kind, detail) {
  problems.push(`${kind}: ${detail}`);
}

/** Every test id the runner would collect, as `<relative file>::<full name>`. */
function collectTargetTests() {
  const raw = execFileSync(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "list", "--json"],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // `vitest list` loads vitest.config.ts, which fails closed under CI
      // without a seed (D-0005). Listing is not a test run and has no seed of
      // its own, so CI is cleared for this child only.
      env: { ...process.env, CI: "", CONTINUO_TEST_SEED: "" },
    },
  );
  const start = raw.indexOf("[");
  if (start < 0) {
    throw new Error(`could not parse 'vitest list --json' output:\n${raw}`);
  }
  return JSON.parse(raw.slice(start)).map(
    (entry) => `${relative(ROOT, entry.file).split("\\").join("/")}::${entry.name}`,
  );
}

/** Every file under `test/`, so the non-running sweep cannot miss a directory. */
function testFiles(directory = join(ROOT, "test")) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...testFiles(path));
    } else if (entry.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

const collected = collectTargetTests();
const claimedTargets = new Map();
const approvedNonRunning = new Map();

for (const ledgerPath of LEDGERS) {
  const ledger = JSON.parse(readFileSync(join(ROOT, ledgerPath), "utf8"));

  // (1) and (5): the source inventory is a committed snapshot taken at the
  // recorded revision, so this runs without an interlock checkout.
  const inventory = readFileSync(join(ROOT, ledger.source.file.inventory), "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "");
  if (inventory.length !== ledger.source.file.collected) {
    fail(
      "shrinkage",
      `${ledgerPath}: inventory holds ${inventory.length} source cases but the ledger records ${ledger.source.file.collected}`,
    );
  }

  const seenSources = new Set();
  for (const entry of ledger.entries) {
    if (seenSources.has(entry.source_nodeid)) {
      fail("duplicate", `${ledgerPath}: source case claimed twice: ${entry.source_nodeid}`);
    }
    seenSources.add(entry.source_nodeid);

    if (entry.target_id !== null) {
      const previous = claimedTargets.get(entry.target_id);
      if (previous !== undefined) {
        fail(
          "duplicate",
          `${ledgerPath}: target test claimed by two source cases: ${entry.target_id} (${previous} and ${entry.source_nodeid})`,
        );
      }
      claimedTargets.set(entry.target_id, entry.source_nodeid);
    }

    if (entry.disposition !== "ported" && (entry.reason ?? "") === "") {
      fail(
        "unexplained",
        `${ledgerPath}: ${entry.source_nodeid} is '${entry.disposition}' with no reason`,
      );
    }
  }

  for (const nodeid of inventory) {
    if (!seenSources.has(nodeid)) {
      fail("missing", `${ledgerPath}: source case has no ledger entry: ${nodeid}`);
    }
  }
  for (const nodeid of seenSources) {
    if (!inventory.includes(nodeid)) {
      fail(
        "unknown-source",
        `${ledgerPath}: ledger entry names a case absent from the inventory: ${nodeid}`,
      );
    }
  }

  const mapped = ledger.entries.filter((entry) => entry.target_id !== null).length;
  const recorded = ledger.totals.ported + ledger.totals.adapted;
  if (mapped < recorded) {
    fail("shrinkage", `${ledgerPath}: ${mapped} cases mapped, but the ledger records ${recorded}`);
  }

  // (3): everything the runner collects from a ported file is either claimed by
  // an entry or declared target-only.
  const targetOnly = new Set(ledger.target.target_only_tests.ids);
  for (const id of collected) {
    if (!id.startsWith(`${ledger.target.test_file}::`)) {
      continue;
    }
    if (!claimedTargets.has(id) && !targetOnly.has(id)) {
      fail("unmapped", `${ledgerPath}: target test claimed by no ledger entry: ${id}`);
    }
  }
  for (const id of targetOnly) {
    if (!collected.includes(id)) {
      fail("missing", `${ledgerPath}: declared target-only test does not exist: ${id}`);
    }
  }
  for (const [id, source] of claimedTargets) {
    if (!collected.includes(id)) {
      fail("missing", `${ledgerPath}: ${source} maps to a target test that does not exist: ${id}`);
    }
  }

  for (const approval of ledger.target.approved_non_running ?? []) {
    approvedNonRunning.set(approval.file, approval);
  }
}

// (4): a skip, todo, fails or xfail anywhere under test/ has to be approved by
// name in a ledger, with a reason.
for (const path of testFiles()) {
  const relativePath = relative(ROOT, path).split("\\").join("/");
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    // The definitions inside the testkit's own helpers are the implementation
    // of the mapping, not a use of it.
    if (relativePath === "test/testkit/marks.ts") {
      continue;
    }
    if (!NON_RUNNING.some((pattern) => pattern.test(line))) {
      continue;
    }
    const approval = approvedNonRunning.get(relativePath);
    if (approval === undefined) {
      fail(
        "unapproved-skip",
        `${relativePath}:${index + 1} uses a non-running test construct that no ledger approves: ${line.trim()}`,
      );
    }
  }
}

if (problems.length > 0) {
  process.stderr.write("parity ledger check failed:\n");
  for (const problem of problems) {
    process.stderr.write(`  - ${problem}\n`);
  }
  process.stderr.write(`\n${problems.length} problem(s).\n`);
  process.exit(1);
}

process.stdout.write(`parity ledger check passed (${collected.length} target tests collected).\n`);
