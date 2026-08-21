# Testing continuo

Authority: [`DECISIONS.md`](../DECISIONS.md) `D-0001` (runner), `D-0005` (the CI rule).

## Commands

```bash
npm ci             # install exactly what the lockfile pins
npm run typecheck  # tsc --noEmit over src/, test/, scripts/
npm run smoke:native   # prove the better-sqlite3 addon actually loads
npm test           # the suite, once, in a random order
npm run verify     # all of the above, in that order
```

`npm test` is `vitest run`: a single non-watch pass that exits non-zero on any failure. Use
`npm run test:watch` while working.

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
| Files parallel across workers | yes (Vitest default), each isolated |
| Hook order | `stack` (Vitest default) |
| Filesystem state | per-test temporary directory |

Ordering and concurrency are separate properties. The ported suite has never been run concurrently,
so turning concurrency on during translation would mix two independent sources of failure. It is a
later decision, taken on its own evidence.

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

## Contract tests

`test/contract/` holds tests that pin decisions rather than behaviour of continuo's own code:

- `sqlite-values.test.ts` -- the SQLite value mapping (`D-0007`). Fails when a dependency upgrade
  changes how a stored value reads back.
- `ascii-output-policy.test.ts` -- the ASCII-only output policy (`D-0006`).

They are ordinary tests and run with everything else. Their purpose is that a decision recorded in
prose is also enforced by something that can turn red.
