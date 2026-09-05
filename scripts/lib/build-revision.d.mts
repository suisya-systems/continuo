/**
 * Types for `build-revision.mjs`.
 *
 * Hand-written for the reason `ts-ast.d.mts` gives: `tsc` does not read
 * JavaScript here (`allowJs` is off), so a TypeScript caller would otherwise
 * see `any`.
 */

/** One git invocation's outcome, reduced to what the derivation reads. */
export interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: unknown;
}

/** The revision implied by three git results: a sha, a dirty sha, or `unknown`. */
export declare function deriveRevision(inputs: {
  readonly toplevel: GitResult;
  readonly head: GitResult;
  readonly status: GitResult;
  readonly root: string;
}): string;

/** Run the three git commands from `root` and derive the revision. */
export declare function readGitRevision(root: string): {
  readonly revision: string;
  readonly why: string;
};

/** Every codepoint outside U+0020..U+007E as a `\uXXXX` escape. */
export declare function ascii(text: string): string;
