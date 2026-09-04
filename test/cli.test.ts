/**
 * The unified `continuo` entry point's own concerns: not a subtree's verbs
 * (each has its own `test/<subtree>/cli.test.ts`), but what `src/cli.ts` adds
 * on top of every one of them.
 *
 * `installEpipeGuard` is `#124`'s fix. Every subtree writes through its own
 * seam and every seam ends at a bare `process.stdout.write` /
 * `process.stderr.write` (`src/gate/cli.ts:167-173` and the same shape in each
 * other subtree), so the fix cannot live in a shared write function -- there
 * isn't one, on purpose (each subtree's write seam is deliberately its own,
 * the same way `withControlPlane`'s docstring explains for its `finally`).
 * What the subtrees do share is the one process and its two streams, which is
 * where this listener sits. Driven against a real `EventEmitter` standing in
 * for the stream rather than the process's actual `process.stdout`, because
 * this suite must not depend on -- or disturb -- the runner's own stdout.
 */

import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";

import { installEpipeGuard } from "../src/cli.js";

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`write ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("installEpipeGuard", () => {
  test("an EPIPE on a guarded stream's error event does not escape", () => {
    const stream = new EventEmitter() as unknown as NodeJS.WritableStream;
    installEpipeGuard([stream]);

    expect(() => stream.emit("error", errnoError("EPIPE"))).not.toThrow();
  });

  test("guards every stream it is given, not only the first", () => {
    const first = new EventEmitter() as unknown as NodeJS.WritableStream;
    const second = new EventEmitter() as unknown as NodeJS.WritableStream;
    installEpipeGuard([first, second]);

    expect(() => first.emit("error", errnoError("EPIPE"))).not.toThrow();
    expect(() => second.emit("error", errnoError("EPIPE"))).not.toThrow();
  });

  test("a stream error that is not EPIPE still escapes", () => {
    const stream = new EventEmitter() as unknown as NodeJS.WritableStream;
    installEpipeGuard([stream]);

    expect(() => stream.emit("error", errnoError("EACCES"))).toThrow("write EACCES");
  });
});
