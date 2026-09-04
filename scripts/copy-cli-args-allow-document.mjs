/**
 * Copy the `cli_args` allowlist document into the build output.
 *
 * `tsc` emits JavaScript and declarations; it does not copy data files. But
 * `bundledCliArgsAllowPath()` resolves `cli_args_allow.json` relative to the
 * *module* (`cli_args_allow.ts`'s `import.meta.url`), so a build without this
 * step ships `dist/fencing/cli_args_allow.js` beside no `cli_args_allow.json`
 * at all. `loadCliArgsAllowlist()` called without an explicit path then throws
 * `CliArgsAllowlistUnreadable`, and because every caller treats that as fatal
 * the failure is total in both directions: no run carrying operator arguments
 * can be admitted, and no admitted lap carrying them can perform.
 *
 * The failure mode is the nasty one -- "works in development, refuses when
 * installed" -- because a source-tree run finds the file next to
 * `cli_args_allow.ts` and only a packaged consumer sees it missing.
 * `copy-roles-document.mjs` carries the same obligation for the same reason,
 * and this step runs immediately after it in `package.json`'s `build`.
 *
 * **Byte for byte, not a transform.** `test/contract/` pins this document's
 * SHA-256 exactly as it pins `roles.json`'s (`D-0088`, decision D3), because
 * what the document authorises is a function of these exact bytes: an entry is
 * matched against a submitted `cli_args` by whole-vector string equality, so a
 * copy that normalised the JSON or changed a line ending would ship a build
 * whose allowlist is not the one that was reviewed and pinned.
 */

import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FROM = join(ROOT, "src", "fencing", "cli_args_allow.json");
const INTO = join(ROOT, "dist", "fencing", "cli_args_allow.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

try {
  statSync(FROM);
} catch {
  fail(`${FROM} does not exist; the cli_args allowlist is missing from the source tree`);
}

mkdirSync(dirname(INTO), { recursive: true });
copyFileSync(FROM, INTO);

// Verify what landed, byte for byte -- see the header comment above.
if (!readFileSync(FROM).equals(readFileSync(INTO))) {
  fail(`${INTO} differs from ${FROM} after copying`);
}

// A document that copied cleanly but is not the shape the loader reads would
// satisfy the byte check and still leave every non-empty `cli_args` throwing
// `CliArgsAllowlistUnreadable` at admission. The shape is asserted here so that
// the build fails instead of the installed CLI.
//
// The assertion is that `entries` is an ARRAY, and deliberately not that it is
// non-empty: the shipped document authorises nothing (`D-0088`, decision D1),
// so an emptiness check would fail every build there is.
const parsed = JSON.parse(readFileSync(INTO, "utf8"));
if (!Array.isArray(parsed?.entries)) {
  fail(`${INTO} has no 'entries' array`);
}

const bytes = statSync(INTO).size;
process.stdout.write(
  `cli_args allowlist: ${bytes} bytes, ${parsed.entries.length} entries -> ` +
    "dist/fencing/cli_args_allow.json\n",
);
