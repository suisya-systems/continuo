/**
 * Copy the deny hook into the build output.
 *
 * `tsc` emits `.js` from `.ts`; it does not copy a hand-written `.mjs`. And
 * `src/fencing/hook.mjs` is hand-written for a reason that this step is the
 * other half of: the hook is launched **as a process, by path**, and Node 22
 * cannot execute a `.ts` file, so the hook has to be a file Node can run in the
 * built tree as well as in the source tree.
 *
 * Without this step, `dist/fencing/` ships `spawn.js` next to no `hook.mjs` at
 * all. `defaultHookScript()` then names a file that does not exist, and
 * `renderer.ts`'s `checkCommandResolves` refuses every render with
 * `hook-unresolvable` -- so nothing can be spawned. That is the fail-closed
 * direction, but it is still "works in development, refuses when installed",
 * which is exactly the class of failure `copy-roles-document.mjs` exists to
 * prevent for `roles.json`.
 *
 * **Byte for byte.** The copied file is the hook, not a transform of it: it
 * locates its own dependencies relative to its own location, and a rewritten
 * copy would be a different program enforcing the fence.
 */

import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FROM = join(ROOT, "src", "fencing", "hook.mjs");
const INTO = join(ROOT, "dist", "fencing", "hook.mjs");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

try {
  statSync(FROM);
} catch {
  fail(`${FROM} does not exist; the deny hook is missing from the source tree`);
}

mkdirSync(dirname(INTO), { recursive: true });
copyFileSync(FROM, INTO);

if (!readFileSync(FROM).equals(readFileSync(INTO))) {
  fail(`${INTO} differs from ${FROM} after copying`);
}

// A hook that copied cleanly but cannot find its fence logic beside it is a
// hook that denies everything, so the sibling it loads is checked here rather
// than discovered by a spawned worker being fenced out of its own job.
for (const sibling of ["state.js", "pyrepr.js", "pyjson.js"]) {
  try {
    statSync(join(dirname(INTO), sibling));
  } catch {
    fail(`${join(dirname(INTO), sibling)} is missing; the copied deny hook would deny everything`);
  }
}

const bytes = statSync(INTO).size;
process.stdout.write(`deny hook: ${bytes} bytes -> dist/fencing/hook.mjs\n`);
