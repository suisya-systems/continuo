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
 * The copy is verified rather than assumed. A silent no-op here -- a renamed
 * source directory, a glob that stops matching -- produces a package that fails
 * only at run time, on the machine of whoever installed it.
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FROM = join(ROOT, "src", "control_plane", "migrations");
const INTO = join(ROOT, "dist", "control_plane", "migrations");

const steps = readdirSync(FROM).filter((entry) => entry.endsWith(".sql"));
if (steps.length === 0) {
  process.stderr.write(
    `no .sql steps found in ${FROM}; the ledger is missing from the source tree\n`,
  );
  process.exit(1);
}

mkdirSync(INTO, { recursive: true });
for (const step of steps) {
  copyFileSync(join(FROM, step), join(INTO, step));
}

// Verify what landed, byte for byte. The checksum in every ledger row is taken
// over these bytes, so a copy that altered so much as a line ending would make
// the packaged build refuse databases the source build wrote.
for (const step of steps) {
  const source = readFileSync(join(FROM, step));
  const copied = readFileSync(join(INTO, step));
  if (!source.equals(copied)) {
    process.stderr.write(`${step} differs after copying into ${INTO}\n`);
    process.exit(1);
  }
}

const copied = readdirSync(INTO).filter((entry) => entry.endsWith(".sql"));
if (copied.length !== steps.length) {
  process.stderr.write(`copied ${copied.length} steps but the source holds ${steps.length}\n`);
  process.exit(1);
}

const bytes = steps.reduce((total, step) => total + statSync(join(INTO, step)).size, 0);
process.stdout.write(
  `migrations: ${steps.length} step(s), ${bytes} bytes -> dist/control_plane/migrations\n`,
);
