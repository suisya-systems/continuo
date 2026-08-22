/**
 * Copy the per-role fence document into the build output.
 *
 * `tsc` emits JavaScript and declarations; it does not copy data files. But
 * `bundledDocumentPath()` resolves `roles.json` relative to the *module*
 * (`renderer.ts`'s `import.meta.url`), so a build without this step ships
 * `dist/fencing/renderer.js` beside no `roles.json` at all. `loadDocument()`
 * called without an explicit path then refuses with `document-unreadable`, and
 * because the renderer is fail-closed by construction that refusal is total:
 * every role fails to render, so nothing can be spawned.
 *
 * The failure mode is the nasty one -- "works in development, refuses when
 * installed" -- because a source-tree run finds the file next to `renderer.ts`
 * and only a packaged consumer sees it missing. `src/control_plane`'s two
 * copy steps carry the same obligation for the same reason.
 *
 * **Byte for byte, not a transform.** `src/fencing/roles.json` is carried
 * verbatim from interlock, and the fence rendered from it -- including the
 * settings payload a restart diffs -- is a function of these exact bytes. A
 * copy that normalised the JSON or changed a line ending would make the
 * packaged build render a fence that compares unequal to one the source build
 * wrote.
 *
 * That the SOURCE file is still interlock's bytes is a separate claim, and it
 * is checked separately: `test/contract/carried-documents.test.ts` pins its
 * digest, and `biome.json` excludes it from the formatter. Both of those exist
 * because a repository-wide `biome check --write` silently reformatted the
 * document once already, while comments went on asserting a `cmp` that nothing
 * ran.
 */

import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FROM = join(ROOT, "src", "fencing", "roles.json");
const INTO = join(ROOT, "dist", "fencing", "roles.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

try {
  statSync(FROM);
} catch {
  fail(`${FROM} does not exist; the role document is missing from the source tree`);
}

mkdirSync(dirname(INTO), { recursive: true });
copyFileSync(FROM, INTO);

// Verify what landed, byte for byte -- see the header comment above.
if (!readFileSync(FROM).equals(readFileSync(INTO))) {
  fail(`${INTO} differs from ${FROM} after copying`);
}

// A document that copied cleanly but carries no roles would satisfy the byte
// check and still leave every render refusing, so the shape is asserted too.
const parsed = JSON.parse(readFileSync(INTO, "utf8"));
const roles = Object.keys(parsed?.roles ?? {}).filter((name) => !name.startsWith("$"));
if (roles.length === 0) {
  fail(`${INTO} declares no roles`);
}

const bytes = statSync(INTO).size;
process.stdout.write(
  `role document: ${bytes} bytes, ${roles.length} roles -> dist/fencing/roles.json\n`,
);
