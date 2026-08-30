import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Reading a ported module's own source text, and reading a JSDoc block out of
 * it.
 *
 * Interlock's session tests assert three things that have no runtime form in
 * TypeScript:
 *
 * - `S2_SOURCE = Path(s2.__file__).read_text()` and the stub's equivalent -- a
 *   module's source read as text, then searched for a sentence
 *   (`"never relied on as a lock"`, `"U27"`) or for something that must be
 *   absent (`"control_plane"`, `"socket"`, `"urllib"`, `"http://"`);
 * - `ClaudeCliSessionProvider._start_session.__doc__`;
 * - `ClaudeCliSessionProvider.resume.__doc__`.
 *
 * A Python docstring is a **string on the object**; a JSDoc block is a comment
 * and is gone before anything runs. So the two docstring assertions are
 * re-pointed at the module's own text, which is the idiom the source already
 * uses for `S2_SOURCE` -- the same file, read the same way, asking about a
 * bounded region of it instead of the whole.
 *
 * These helpers are the belt's copies of the ones
 * `test/session/provider-contract.test.ts` grew for S1. They are **not**
 * promoted into `test/testkit/`, which is frozen (a change to it is its own PR),
 * and they are not imported from that file either -- that file is a landed,
 * reviewed translation and rewiring it is not this scaffolding's business.
 */

/**
 * A ported module's source text.
 *
 * `path` is repository-relative, e.g. `src/session/claude_cli_provider.ts`.
 *
 * **It must be the `.ts` (or `.mjs`) file, never a build artefact**, and the
 * guard below is not defensive tidiness -- it is rule 10's exact shape. `tsc`
 * strips comments, so a read that resolved into `dist/` would return text with
 * *half of what these assertions are about* removed: every docstring case would
 * fail (visibly, which is fine) and every "this string does not appear" case
 * would pass unconditionally (which is not). The absence cases are the ones
 * that matter here -- `test_the_provider_imports_nothing_from_the_control_plane`
 * and `test_no_claude_cli_and_no_network` -- and they would go green against a
 * file that had never been read.
 */
export function repoSource(path: string): string {
  if (path.startsWith("/") || path.includes("..")) {
    throw new Error(`repoSource takes a repository-relative path, got ${JSON.stringify(path)}`);
  }
  if (path.startsWith("dist/")) {
    throw new Error(
      `repoSource refuses ${JSON.stringify(path)}: dist/ holds compiled output with the comments ` +
        "stripped, and the assertions this feeds are about the comments and about strings that " +
        "must be absent -- both of which a build artefact answers wrongly and silently",
    );
  }
  if (!path.endsWith(".ts") && !path.endsWith(".mjs")) {
    throw new Error(`repoSource expects a .ts or .mjs source file, got ${JSON.stringify(path)}`);
  }
  // Three levels up from test/session/helpers/ is the repository root.
  return readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");
}

/**
 * A JSDoc block, unwrapped to one whitespace-collapsed line.
 *
 * Collapsing is what makes a comparison survive the hundred-column wrap: the
 * sentence a case looks for is written as one phrase and the block it lives in
 * may be three lines with a `*` and an indent on each.
 */
export function unwrapDocBlock(block: string): string {
  return block
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The documentation block **immediately preceding** a declaration.
 *
 * The bound and the adjacency check are the whole helper, and the reason is the
 * one rule 10 keeps naming: an unbounded search finds *a* block and reads as
 * though it found *the* block. Searching backwards from the declaration for the
 * nearest `*` + `/` gives the closest preceding block, and requiring that only
 * whitespace separates the two is what stops it being some earlier
 * declaration's. Without the second half, deleting a method's documentation
 * entirely leaves the case green against its neighbour's -- and `resume` and
 * `_startSession` are neighbours whose recorded sentences differ, so the wrong
 * block is a plausible read and not an absurd one.
 */
export function docBlockBefore(source: string, declaration: RegExp): string {
  const at = source.search(declaration);
  if (at < 0) {
    throw new Error(`declaration not found: ${String(declaration)}`);
  }
  const closed = source.lastIndexOf("*/", at);
  const opened = closed < 0 ? -1 : source.lastIndexOf("/**", closed);
  if (closed < 0 || opened < 0) {
    throw new Error(`no documentation block precedes ${String(declaration)}`);
  }
  const between = source.slice(closed + 2, at);
  if (between.trim() !== "") {
    throw new Error(
      `the documentation block before ${String(declaration)} is not adjacent to it: ` +
        `${JSON.stringify(between.trim().slice(0, 80))} sits between them`,
    );
  }
  return unwrapDocBlock(source.slice(opened, closed + 2));
}

/**
 * A method declaration inside a class body, for {@link docBlockBefore}.
 *
 * Anchored to the start of a two-space-indented line, which does three things
 * a bare `name(` does not: `start(` cannot match `_startSession(`; a method
 * *name* appearing in a data literal or in prose cannot be mistaken for its
 * declaration; and a nested function inside a method body, indented further,
 * cannot either.
 *
 * The modifier list is wider than S1's because the concrete providers need it:
 * their verbs are `async`, some are `override`, and `_startSession` is
 * `protected`. Order is not fixed -- `protected override async` and
 * `override protected async` are both legal -- so the group repeats rather than
 * enumerating an order.
 */
export function methodDeclaration(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^ {2}(?:(?:public|private|protected|static|abstract|override|async)\\s+)*${escaped}\\s*(?:<[^>\\n]*>)?\\(`,
    "m",
  );
}
