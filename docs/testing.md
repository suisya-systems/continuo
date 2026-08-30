# Testing continuo

Authority: [`DECISIONS.md`](../DECISIONS.md) `D-0001` (runner), `D-0005` (the CI rule), `D-0048` (the Windows split).

## Commands

```bash
npm ci --ignore-scripts   # install exactly what the lockfile pins, no source builds
npm run typecheck  # tsc --noEmit over src/, test/, scripts/
npm run smoke:native   # prove the better-sqlite3 addon actually loads
npm test           # the suite, once, in a random order
npm run verify     # all of the above, in that order
```

`npm test` runs `scripts/run-suite.mjs`, which on every platform but Windows is `vitest run` and
nothing else: a single non-watch pass that exits non-zero on any failure. On Windows it runs the
suite in two passes -- see [Windows runs the child-process tests
apart](#windows-runs-the-child-process-tests-apart). Any argument at all (`npm test --
test/messagebus`, `npm test -- --reporter=json`) turns the split off and says so on stderr: the two
passes cannot honour a filter or a single report file without lying about one of them, and CI passes
no arguments. Use `npm run test:watch` while working.

## The suite is the specification

Continuo is a **test-first parity port** of interlock. The specification being ported is
interlock's test suite, not its Python source. A ported test is a faithful translation or it is a
change of behaviour that needs a decision -- there is no third category, and "the TypeScript version
does it slightly differently" is the failure mode the discipline exists to prevent.

## Order is random, and that is the point

Every run shuffles both file order and, within a file, test order. A suite that only passes in one
order has hidden coupling between tests, and that coupling is a property of the suite worth failing
over. CI runs each required cell twice at two distinct seeds
([`docs/ci-merge-gate.md`](./ci-merge-gate.md)).

Consequences for how tests are written:

- **No test may depend on another having run.** Not for fixtures, not for database state, not for
  the working directory.
- **No shared mutable module state between tests.** Vitest isolates each *file* in its own worker;
  within a file, isolation is the test's own responsibility.
- **`retry: 0`.** A test that passes on a second attempt under a shuffled order is exactly the
  signal this rule exists to surface, and retrying erases it.

## Isolation contract

For the duration of the port:

| Property | Setting |
|---|---|
| File order | shuffled |
| Test order within a file | shuffled |
| Tests concurrent within a file | **no** (`sequence.concurrent: false`) |
| Files parallel across workers | yes (Vitest default), each isolated -- except the child-process tests on Windows |
| Hook order | `stack` (Vitest default) |
| Filesystem state | per-test temporary directory |

Ordering and concurrency are separate properties. The ported suite has never been run concurrently,
so turning concurrency on during translation would mix two independent sources of failure. It is a
later decision, taken on its own evidence.

## Windows runs the child-process tests apart

On `windows-latest` the `double-green` cell fails roughly one run in five, and about two thirds of
those failures are timeouts or budget overruns rather than assertions (issue #83). The signature is
starvation rather than a slow test: a job that trips a watchdog is already running slower than the
*median green job* on the same cell, and `D-1003` named the mechanism -- several vitest workers on a
small runner, each spawning child processes of its own. The general form of that fix is `D-0048`;
`D-1003`'s own skip stays where it is until a re-measurement says otherwise.

So on Windows `npm test` runs the suite in two passes: everything that does not spawn children, in
parallel as before, and then the files that do, one at a time. The set is listed in
`scripts/run-suite.mjs`, which also records how it was measured and refuses to run when a test file
reaches `child_process` -- in its own text or a helper's -- without being classified there. Two
passes that between them skipped a file are not a green suite, and the script checks the two runs
account for every file before it reports one.

Nothing else moves: the seed and the double-green rule (`D-0005`) reach each pass unchanged, no time
budget is touched (`D-0602`), and Linux still runs one pass exactly as it did.

Two knobs exist for measuring the trade rather than for daily use. `CONTINUO_SERIALIZE_SPAWN_TESTS`
(`0`/`1`) forces the split off or on whatever the platform, and `CONTINUO_SPAWN_TEST_WORKERS` sets
how many workers the serialized pass gets (default `1`). Serialization buys contention relief with
wall time and the Windows cell has the least of it to spend, so which of those settings is right is
a measurement on that cell, not an opinion. CI sets neither.

## Temporary files

Never a fixed path. `test/helpers/tmp.ts` provides:

```ts
import { createTempDir, tempDatabasePath } from "../helpers/tmp.js";

const dir  = createTempDir("my-case");     // removed when the test finishes
const path = tempDatabasePath("my-case");  // <fresh dir>/continuo.sqlite
```

Both register their own cleanup through `onTestFinished`, so it runs whether the test passes or
fails. Uniqueness comes from `mkdtemp`; the worker id in the directory name is a readability aid
only, and nothing depends on its numbering (Vitest 4 starts `VITEST_WORKER_ID` at 0, Vitest 5 at 1).

## Timeouts are a hang backstop, not a speed assertion

`testTimeout` and `hookTimeout` are set well above anything the suite needs (`vitest.config.ts`).
That is deliberate. The suite is I/O-bound -- the control plane commits with `synchronous = FULL`
(D-0012), so every commit fsyncs -- and CI runner speed varies enormously. One measured run had the
same test take 321ms on one `windows-latest` runner and 13.6s on another, same commit, same
workflow.

A timeout tuned close to observed timings turns that variance into a red merge gate, and the person
who investigates learns only that a machine was busy. What protects correctness here is `retry: 0`
and the double-green rule (D-0005): a test that only passes sometimes stays failed, and it fails for
the reason it actually failed.

If a test genuinely hangs it still fails. It just fails later, which is the cheaper mistake.

## Contract tests

`test/contract/` holds tests that pin decisions rather than behaviour of continuo's own code:

- `sqlite-values.test.ts` -- the SQLite value mapping (`D-0007`). Fails when a dependency upgrade
  changes how a stored value reads back.
- `ascii-output-policy.test.ts` -- the ASCII-only output policy (`D-0006`).
- `lockfile-platforms.test.ts` -- that `package-lock.json` describes every required CI platform, not
  only the one it was last generated on.

They are ordinary tests and run with everything else. Their purpose is that a decision recorded in
prose is also enforced by something that can turn red.
