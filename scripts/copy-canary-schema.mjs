/**
 * Copy the routing ledger DDL into the build output.
 *
 * `tsc` emits JavaScript and declarations; it does not copy data files. But
 * `LEDGER_SCHEMA_PATH` resolves relative to the *module* (`ledger.ts`'s
 * `import.meta.url`), so a build without this step ships `dist/canary/ledger.js`
 * beside no `routing_ledger.sql` at all -- `loadLedgerSql` then fails to read
 * the file, and every entry point that calls it (`createRoutingLedger`,
 * `openRoutingLedger`, `expectedLedgerFingerprint`) refuses. Since
 * `expectedLedgerFingerprint` runs inside verification, that is a packaged
 * build in which the ledger can be neither created nor opened.
 *
 * Byte-for-byte, not a transform, and the check matters twice over here. The
 * schema fingerprint hashes this file's exact bytes, so a copy that altered so
 * much as a line ending would make the packaged build's fingerprint disagree
 * with a ledger written by the source build -- every existing ledger would be
 * refused as "does not carry this build's ledger schema". The marking guard is
 * the second: `loadLedgerSql` matches `REHEARSAL_MARKING` after collapsing
 * whitespace, and a copy that re-wrapped the header would strip the D-0022
 * label from the artifact an operator reads.
 */

import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FROM = join(ROOT, "src", "canary", "routing_ledger.sql");
const INTO = join(ROOT, "dist", "canary", "routing_ledger.sql");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

try {
  statSync(FROM);
} catch {
  fail(`${FROM} does not exist; the routing ledger schema is missing from the source tree`);
}

mkdirSync(dirname(INTO), { recursive: true });
copyFileSync(FROM, INTO);

// Verify what landed, byte for byte -- see the header comment above.
if (!readFileSync(FROM).equals(readFileSync(INTO))) {
  fail(`${INTO} differs from ${FROM} after copying`);
}

const bytes = statSync(INTO).size;
process.stdout.write(
  `canary routing ledger schema: ${bytes} bytes -> dist/canary/routing_ledger.sql\n`,
);
