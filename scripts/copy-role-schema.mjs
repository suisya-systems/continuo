/**
 * Copy the role-configs schema into the build output.
 *
 * `tsc` emits JavaScript and declarations; it does not copy data files. But
 * `bundledSchemaPath()` resolves `role_configs_schema.json` relative to the
 * *module* (`generator.ts`'s `import.meta.url`), so a build without this step
 * ships `dist/settings/generator.js` beside no schema at all. `loadSchema()`
 * called without an explicit path then raises, and every `settings generate`
 * that did not pass `--schema` fails -- which is the shape the fence document's
 * copy step exists to prevent, in the neighbouring package.
 *
 * The failure mode is the nasty one -- "works in development, fails when
 * installed" -- because a source-tree run finds the file next to `generator.ts`
 * and only a packaged consumer sees it missing.
 *
 * **Byte for byte, not a transform.** `src/settings/role_configs_schema.json`
 * is carried verbatim from interlock, and the settings file rendered from it is
 * a function of these exact bytes -- including the Python spelling of every
 * number in it, which D-0210 records on the container slot and this port
 * re-emits. A copy that normalised the JSON would make the packaged build
 * render a different file from the source build.
 *
 * That the SOURCE file is still interlock's bytes is a separate claim, checked
 * separately: `test/contract/carried-documents.test.ts` pins its digest, and
 * `biome.json` excludes it from the formatter -- both because a repository-wide
 * `biome check --write` silently reformatted the fence document once already.
 */

import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FROM = join(ROOT, "src", "settings", "role_configs_schema.json");
const INTO = join(ROOT, "dist", "settings", "role_configs_schema.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

try {
  statSync(FROM);
} catch {
  fail(`${FROM} does not exist; the role-configs schema is missing from the source tree`);
}

mkdirSync(dirname(INTO), { recursive: true });
copyFileSync(FROM, INTO);

// Verify what landed, byte for byte -- see the header comment above.
if (!readFileSync(FROM).equals(readFileSync(INTO))) {
  fail(`${INTO} differs from ${FROM} after copying`);
}

// A schema that copied cleanly but carries no worker roles would satisfy the
// byte check and still leave every render raising, so the shape is asserted too.
const parsed = JSON.parse(readFileSync(INTO, "utf8"));
const workerRoles = Object.keys(parsed?.worker_roles ?? {}).filter((name) => !name.startsWith("$"));
if (workerRoles.length === 0) {
  fail(`${INTO} declares no worker roles`);
}

const bytes = statSync(INTO).size;
process.stdout.write(
  `role-configs schema: ${bytes} bytes, ${workerRoles.length} worker roles -> dist/settings/role_configs_schema.json\n`,
);
