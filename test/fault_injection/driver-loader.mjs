/**
 * Resolve a relative `.js` import specifier to the `.ts` file beside it.
 *
 * Node's type stripping runs a `.ts` entry point but does **not** rewrite import
 * specifiers, and this repository's TypeScript is `NodeNext` with explicit `.js`
 * suffixes on relative imports (D-0002) -- so `./schema.js` inside
 * `src/control_plane/` resolves to a file that does not exist and the driver
 * child dies with `ERR_MODULE_NOT_FOUND` before it reaches `main()`.
 *
 * Rewriting the imports instead is not available: the suffixes are what makes
 * the emitted ESM graph identical to the source graph, which is what `NodeNext`
 * requires and what D-0002 fixed at bootstrap.
 *
 * Scope is deliberately narrow. Only a **relative** specifier ending in `.js`
 * is considered, and only when the `.ts` file actually exists; anything else
 * falls through to Node's own resolution untouched, so a bare specifier
 * (`better-sqlite3`, `node:fs`) and a real `.js` file (`src/fencing/hook.mjs`'s
 * neighbours) both resolve exactly as they otherwise would.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
    // `context.parentURL` is ALREADY a URL string, so it is used as the base
    // directly. The previous round trip through `fileURLToPath` and back was
    // not merely redundant: converting a URL to a Windows path and re-parsing
    // it is exactly the kind of step that reintroduces a bare `d:\...`, which
    // is what Node's loader refuses.
    if (context.parentURL === undefined) {
      return nextResolve(specifier, context);
    }
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true, format: "module-typescript" };
    }
  }
  return nextResolve(specifier, context);
}
