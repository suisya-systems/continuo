/**
 * The source inventory's own enforcement.
 *
 * `scripts/parity-check.mjs` checks the inventory files a **ledger** points at.
 * That is the right scope for it, and it leaves a gap: an inventory file for a
 * subsystem nobody has started porting is referenced by no ledger, so nothing
 * reads it. Duplicated node ids, a `.all.txt` that has drifted from the
 * per-file inventories it aggregates, a file quietly deleted, a count that no
 * longer adds up to interlock's suite baseline -- all of that would sit in the
 * tree green until the belt that ports the subsystem finally opened it, which
 * is months later and by then the diff that broke it is unfindable.
 *
 * So this checks the inventory as a whole, against
 * `parity/source-inventory.manifest.json`, which is its index and the record of
 * how it reconciles with interlock at `65f36c5`. It runs without an interlock
 * checkout: the node ids are a committed snapshot, and everything below is a
 * property of the snapshot rather than of the source tree.
 *
 * What it reports:
 *
 *  1. **stray**       -- an inventory file the manifest does not name, or a
 *                        manifest path with no file. Both directions matter: an
 *                        unnamed file is uncounted evidence, and a named
 *                        missing one is a count with nothing behind it.
 *  2. **shape**       -- a line that is not a node id belonging to the file's
 *                        own source path. This is what keeps the inventories
 *                        comment-free, which they must be, because
 *                        `parity-check.mjs` reads every non-empty line as a
 *                        node id -- a `# note` line there is a source case that
 *                        does not exist.
 *  3. **count**       -- a recorded `collected` that disagrees with the lines,
 *                        or `totals` that do not add up.
 *  4. **aggregate**   -- a `.all.txt` that is not exactly the concatenation of
 *                        its files' inventories, in the manifest's order.
 *  5. **duplicate**   -- one node id in two inventories. Two subsystems
 *                        claiming a case is how a total reaches 2,194 while
 *                        actually holding fewer distinct cases.
 *  6. **baseline**    -- the reconciliation with the suite baseline: node ids
 *                        plus collection-time-skipped modules must be the
 *                        collected total, and the breakdown must add up to it.
 *  7. **fabricated**  -- a module recorded as skipped at collection time that
 *                        nevertheless has an inventory file or a node id. Those
 *                        modules yield no node id; one appearing means a case
 *                        was invented for a test pytest never collected.
 *  8. **unclassified**-- a subsystem the belts document does not name. Being in
 *                        the inventory is evidence, not a commitment to port,
 *                        and the place that says which is which has to cover
 *                        every subsystem or the distinction is only rhetorical.
 *
 * Wired into `npm run verify` beside `npm run parity`, for the reason the
 * parity check states about itself: a ledger nobody checks is a spreadsheet,
 * and so is an inventory.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = "parity/source-inventory.manifest.json";
const INVENTORY_DIR = "parity/source-inventory";

const problems = [];

function fail(kind, detail) {
  problems.push(`${kind}: ${detail}`);
}

/**
 * An inventory file's lines, with the file's own shape rules applied.
 *
 * Returned as read, in order, because order is part of what `aggregate` checks:
 * an inventory is a collection snapshot, and a sorted copy of one is a
 * different artefact that no longer says what pytest would emit.
 */
function readInventory(path, sourcePath) {
  const raw = readFileSync(join(ROOT, path), "utf8");
  const lines = raw.split("\n");
  if (lines.length === 0 || lines[lines.length - 1] !== "") {
    fail("shape", `${path}: does not end with a newline`);
  }
  const ids = [];
  for (const [index, line] of lines.entries()) {
    if (line === "" && index === lines.length - 1) {
      continue;
    }
    const at = `${path}:${index + 1}`;
    if (line.trim() === "") {
      fail("shape", `${at}: blank line; an inventory holds node ids and nothing else`);
      continue;
    }
    if (line !== line.trim()) {
      fail("shape", `${at}: node id carries leading or trailing whitespace`);
    }
    if (!line.startsWith(`${sourcePath}::`)) {
      fail("shape", `${at}: expected a node id under '${sourcePath}', found: ${line}`);
    }
    ids.push(line);
  }
  return ids;
}

const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));

// (1) both directions, so neither an unnamed file nor a named absent one passes.
const onDisk = new Set(
  readdirSync(join(ROOT, INVENTORY_DIR))
    .filter((entry) => entry.endsWith(".txt"))
    .map((entry) => `${INVENTORY_DIR}/${entry}`),
);
const named = new Set();
for (const subsystem of manifest.subsystems) {
  named.add(subsystem.inventory);
  for (const file of subsystem.files) {
    named.add(file.inventory);
  }
}
for (const path of named) {
  if (!onDisk.has(path)) {
    fail("stray", `${MANIFEST} names an inventory that does not exist: ${path}`);
  }
}
for (const path of onDisk) {
  if (!named.has(path)) {
    fail("stray", `${path} is not named by ${MANIFEST}, so nothing counts it`);
  }
}

// (2), (3), (4), (5).
const seen = new Map();
let countedFiles = 0;
let countedIds = 0;
for (const subsystem of manifest.subsystems) {
  const expected = [];
  for (const file of subsystem.files) {
    if (!onDisk.has(file.inventory)) {
      continue;
    }
    countedFiles += 1;
    const ids = readInventory(file.inventory, file.path);
    if (ids.length !== file.collected) {
      fail(
        "count",
        `${file.inventory}: holds ${ids.length} node ids but ${MANIFEST} records ${file.collected}`,
      );
    }
    for (const id of ids) {
      const first = seen.get(id);
      if (first !== undefined && first !== file.inventory) {
        fail("duplicate", `${id} is claimed by both ${first} and ${file.inventory}`);
      }
      seen.set(id, file.inventory);
    }
    expected.push(...ids);
  }
  countedIds += expected.length;
  if (!onDisk.has(subsystem.inventory)) {
    continue;
  }
  if (expected.length !== subsystem.collected) {
    fail(
      "count",
      `${subsystem.name}: its files hold ${expected.length} node ids but ${MANIFEST} records ${subsystem.collected}`,
    );
  }
  const aggregate = readFileSync(join(ROOT, subsystem.inventory), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  if (aggregate.length !== expected.length || aggregate.some((id, i) => id !== expected[i])) {
    fail(
      "aggregate",
      `${subsystem.inventory} is not the concatenation of its ${subsystem.files.length} per-file inventories in the order ${MANIFEST} lists them`,
    );
  }
}

// (3) again, for the recorded totals, which is the number a reader quotes.
if (manifest.totals.subsystems !== manifest.subsystems.length) {
  fail(
    "count",
    `totals.subsystems records ${manifest.totals.subsystems} but the manifest lists ${manifest.subsystems.length}`,
  );
}
if (manifest.totals.files !== countedFiles) {
  fail("count", `totals.files records ${manifest.totals.files} but ${countedFiles} were read`);
}
if (manifest.totals.node_ids !== countedIds) {
  fail("count", `totals.node_ids records ${manifest.totals.node_ids} but ${countedIds} were read`);
}
if (seen.size !== countedIds) {
  fail("duplicate", `${countedIds} node ids were read but only ${seen.size} are distinct`);
}

// (6) and (7): the reconciliation this whole file exists to keep true.
const baseline = manifest.suite_baseline;
const skips = manifest.collection_time_skips.modules;
if (baseline.node_ids !== countedIds) {
  fail(
    "baseline",
    `suite_baseline.node_ids records ${baseline.node_ids} but the inventory holds ${countedIds}`,
  );
}
if (baseline.collection_time_skipped_modules !== skips.length) {
  fail(
    "baseline",
    `suite_baseline.collection_time_skipped_modules records ${baseline.collection_time_skipped_modules} but ${skips.length} modules are listed`,
  );
}
if (baseline.node_ids + skips.length !== baseline.collected) {
  fail(
    "baseline",
    `${baseline.node_ids} node ids + ${skips.length} collection-time skips is not the recorded baseline of ${baseline.collected}`,
  );
}
if (baseline.passed + baseline.skipped + baseline.xfailed !== baseline.collected) {
  fail(
    "baseline",
    `${baseline.passed} passed + ${baseline.skipped} skipped + ${baseline.xfailed} xfailed is not ${baseline.collected}`,
  );
}
if (skips.length > baseline.skipped) {
  fail(
    "baseline",
    `${skips.length} collection-time skips cannot be part of only ${baseline.skipped} skipped outcomes`,
  );
}
const skipped = new Set(skips.map((module) => module.path));
for (const module of skips) {
  if (!module.reason) {
    fail("baseline", `collection-time skip has no reason: ${module.path}`);
  }
}
for (const subsystem of manifest.subsystems) {
  for (const file of subsystem.files) {
    if (skipped.has(file.path)) {
      fail(
        "fabricated",
        `${file.path} is recorded as skipped at collection time, so it yields no node id, yet ${file.inventory} inventories it`,
      );
    }
  }
}
for (const [id, path] of seen) {
  if (skipped.has(id.split("::")[0])) {
    fail("fabricated", `${path} holds a node id from a collection-time-skipped module: ${id}`);
  }
}

// (8): every subsystem is classified somewhere a human reads.
const beltsPath = manifest.porting_intent.document;
const belts = readFileSync(join(ROOT, beltsPath), "utf8");
for (const subsystem of manifest.subsystems) {
  if (!belts.includes(`\`${subsystem.name}\``)) {
    fail(
      "unclassified",
      `${beltsPath} does not name the '${subsystem.name}' subsystem, so its porting status is unstated`,
    );
  }
}

if (problems.length > 0) {
  console.error(`source inventory: ${problems.length} problem(s)\n`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

console.log(
  `source inventory: ${manifest.totals.node_ids} node ids across ${manifest.totals.files} files ` +
    `in ${manifest.totals.subsystems} subsystems, all distinct; ` +
    `+ ${skips.length} collection-time-skipped modules = ${baseline.collected}, ` +
    `the suite baseline at ${manifest.source.revision_short}.`,
);
