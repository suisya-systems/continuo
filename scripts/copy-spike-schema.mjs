/**
 * Copy the spike DDL into the build output.
 *
 * `tsc` emits JavaScript and declarations; it does not copy data files. But
 * `SPIKE_SCHEMA_PATH` resolves relative to the *module* (`schema.ts`'s
 * `import.meta.url`), so a build without this step ships
 * `dist/control_plane/schema.js` beside no `spike_schema.sql` at all --
 * `loadSchemaSql` then fails to read the file, and every entry point that
 * calls it (`createControlPlane`, `openControlPlane`,
 * `expectedSchemaFingerprint`) refuses, which is a module that refuses
 * everything.
 *
 * Byte-for-byte, not a transform: `expectedSchemaFingerprint` hashes this
 * file's exact bytes, and a copy that altered so much as a line ending would
 * make the packaged build's fingerprint disagree with a database written by
 * the source build.
 */

import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FROM = join(ROOT, "src", "control_plane", "spike_schema.sql");
const INTO = join(ROOT, "dist", "control_plane", "spike_schema.sql");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

try {
  statSync(FROM);
} catch {
  fail(`${FROM} does not exist; the spike schema is missing from the source tree`);
}

mkdirSync(dirname(INTO), { recursive: true });
copyFileSync(FROM, INTO);

// Verify what landed, byte for byte -- see the header comment above.
if (!readFileSync(FROM).equals(readFileSync(INTO))) {
  fail(`${INTO} differs from ${FROM} after copying`);
}

const bytes = statSync(INTO).size;
process.stdout.write(`spike schema: ${bytes} bytes -> dist/control_plane/spike_schema.sql\n`);
