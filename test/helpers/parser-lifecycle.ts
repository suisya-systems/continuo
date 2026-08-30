import { afterAll } from "vitest";
import { disposeParser } from "../../scripts/lib/ts-ast.mjs";

/**
 * Releases the TypeScript parser at the end of every test file.
 *
 * `scripts/lib/ts-ast.mjs` talks to a compiler child process -- TypeScript 7
 * has no in-process parser -- and holds that child, plus the last snapshot's
 * program and every tree decoded from it, for the life of the module. This
 * hands all of it back as soon as the file that asked for it is done.
 *
 * **What this is not.** Under `vitest run` as configured here, a file that
 * forgot to dispose would still finish: each test file gets its own worker
 * process (`isolate: true`), the worker is torn down when the file ends, and
 * the compiler child goes with it. Measured on TypeScript 7.0.2, the child
 * does not hold the event loop open either, so even a plain `node` script that
 * never disposes exits. So this is not load-bearing for the suite terminating
 * today; it is the module's own contract -- whoever opens the compiler closes
 * it -- kept rather than left to two behaviours (worker teardown, an unref'd
 * handle) that nothing here controls and neither of which is promised by the
 * `unstable` API this is built on.
 *
 * **Why a `setupFiles` entry** rather than an `afterAll` in each parsing test:
 * the set of files that parse is not visible from the files themselves.
 * `test/measurement/known-holes.test.ts` parses through `module-scan.ts` and
 * `test/fault_injection/protocol.test.ts` through `conformance.ts`, neither of
 * which names TypeScript anywhere. A rule that has to be remembered by whoever
 * next imports one of those helpers is a rule that will be missed. Registered
 * here it costs nothing to the files that never parse: the compiler is spawned
 * on the first parse, so `disposeParser` after none is a no-op.
 *
 * `test/gate_item11/support/suite-runs-unchanged.config.ts` names this file
 * too. That config is deliberately not the main one, and a standalone config
 * inherits no `setupFiles`, so the invariant has to be asked for in both
 * places or it holds in only one of them.
 */
afterAll(() => {
  disposeParser();
});
