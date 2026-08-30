/**
 * Types for `ts-ast.mjs`.
 *
 * Hand-written because the module it describes is `.mjs`: `tsc` does not read
 * JavaScript here (`allowJs` is off, by the same decision that keeps
 * `tsconfig.json` a type-check-only configuration), so every TypeScript caller
 * would otherwise see `any` and lose the guarantees its sweep depends on.
 */

import type { SourceFile } from "typescript/unstable/ast";

/** The tree for `source`, parsed as though it were the file at `fileName`. */
export declare function parseSourceFile(fileName: string, source: string): SourceFile;

/** Shut the compiler child process down. Without it the host does not exit. */
export declare function disposeParser(): void;
