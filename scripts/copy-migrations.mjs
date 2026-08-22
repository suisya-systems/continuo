/**
 * Copy the production DDL ledger into the build output.
 *
 * `tsc` emits JavaScript and declarations; it does not copy data files. But
 * `MIGRATIONS_DIR` resolves relative to the *module*, so in a build without
 * this step `dist/control_plane/migrations/` does not exist and every entry
 * point refuses -- `discoverMigrationSteps` reports the ledger as missing from
 * the build, which is exactly what it should do and exactly not what anyone
 * wants to discover after publishing.
 *
 * Interlock carries the same obligation in its packaging metadata, with the
 * same warning written next to it: "without this the wheel ships a migrator
 * whose steps are missing, which every opener then refuses."
 *
 * **The packaged ledger must be the same ledger, not a filtered one.** A naive
 * `*.sql` copy is the trap: an editor's `0004_fix.sql.bak` left in the source
 * directory is *refused* by `discoverMigrationSteps` in a source-tree run and
 * would be silently dropped on the way into `dist`, so the packaged build would
 * migrate happily where the source build refuses. That is the strict-discovery
 * rule defeated by the build system, and it would show up as "works when
 * installed, fails in development", which is the worst direction for this
 * particular disagreement to run.
 *
 * So this script applies the module's *own* rules -- imported from the build
 * output, never restated here, because a second copy of `STEP_FILENAME` is a
 * second thing to keep in sync -- and refuses anything the migrator would
 * refuse.
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FROM = join(ROOT, "src", "control_plane", "migrations");
const INTO = join(ROOT, "dist", "control_plane", "migrations");

// Imported from dist rather than re-declared: this script runs after `tsc`, so
// the compiled module is present, and using it means the packaging rule cannot
// drift away from the discovery rule.
//
// `pathToFileURL`, never the bare path. Dynamic `import()` takes a URL, and on
// Windows an absolute path starts with a drive letter, which the ESM loader
// reads as a URL scheme and rejects: ERR_UNSUPPORTED_ESM_URL_SCHEME, "Received
// protocol 'd:'". On POSIX the bare path happens to resolve, so this is
// invisible everywhere except the cell that catches it.
const { LEDGER_COMPANIONS, STEP_FILENAME } = await import(
  pathToFileURL(join(ROOT, "dist", "control_plane", "migrator.js")).href
);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const entries = readdirSync(FROM);
const steps = [];
for (const entry of entries) {
  if (LEDGER_COMPANIONS.has(entry)) {
    continue;
  }
  if (!STEP_FILENAME.test(entry)) {
    fail(
      `${join(FROM, entry)} is neither a migration step name nor a packaging companion. ` +
        `discoverMigrationSteps refuses this ledger, so packaging it -- with or without ` +
        `this entry -- would ship a build that disagrees with the source tree. ` +
        `Remove it, or add it to LEDGER_COMPANIONS if it genuinely belongs beside the steps.`,
    );
  }
  steps.push(entry);
}

if (steps.length === 0) {
  fail(`no migration steps found in ${FROM}; the ledger is missing from the source tree`);
}

mkdirSync(INTO, { recursive: true });
for (const step of steps) {
  copyFileSync(join(FROM, step), join(INTO, step));
}

// Verify what landed, byte for byte. The checksum in every ledger row is taken
// over these bytes, so a copy that altered so much as a line ending would make
// the packaged build refuse databases the source build wrote.
for (const step of steps) {
  if (!readFileSync(join(FROM, step)).equals(readFileSync(join(INTO, step)))) {
    fail(`${step} differs after copying into ${INTO}`);
  }
}

// And that nothing extra is in the destination -- a step deleted from source
// but left behind in a stale `dist/` would be discovered there and applied.
const copied = readdirSync(INTO).sort();
const expected = [...steps].sort();
if (copied.length !== expected.length || copied.some((name, index) => name !== expected[index])) {
  fail(
    `${INTO} holds [${copied.join(", ")}] but the source ledger is [${expected.join(", ")}]; ` +
      `run \`npm run clean\` and build again`,
  );
}

const bytes = steps.reduce((total, step) => total + statSync(join(INTO, step)).size, 0);
process.stdout.write(
  `migrations: ${steps.length} step(s), ${bytes} bytes -> dist/control_plane/migrations\n`,
);
