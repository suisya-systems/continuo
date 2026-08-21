# Continuo — DECISIONS

This file is the canonical, append-only record of Continuo's design decisions.

Continuo is the **TypeScript port** of [`suisya-systems/interlock`](https://github.com/suisya-systems/interlock).
Interlock remains the **design lineage of record**: its `DECISIONS.md` (`D-0001`..`D-0042`),
`investigation/`, and `docs/parity-audit.md` hold the decisions this port carries. Where an entry
below cites an interlock decision it does so as `interlock D-00NN`, to keep the two numbering
spaces distinct.

## How to use this file

- **IDs are permanent.** `D-0001` ... are stable identifiers. Once assigned, an ID is never
  reused, renumbered, merged into another entry, or deleted.
- **Supersession keeps the ID.** A decision that stops being true keeps its ID and gains
  `Status: superseded by D-XXXX`; the replacement gets a new ID at the end of the list.
- **Cross-reference by ID only.** Never cite this file by line number, heading order, or table
  position.
- **Every entry states what would falsify it.** A decision taken on facts that can change records
  the fact and the version it was measured at, so a later reader can tell "still true" from "was
  true in 2026".

## Index

| ID | Title | Status |
|---|---|---|
| D-0001 | Vitest is the test runner | accepted |
| D-0002 | ESM, NodeNext resolution, and explicit `.js` import suffixes | accepted |
| D-0003 | better-sqlite3 v13 and the supported Node range are pinned together | accepted |
| D-0004 | TypeScript strictness beyond `strict` | accepted |
| D-0005 | The double-green rule, and where it is enforced | accepted |
| D-0006 | ASCII-only for anything continuo prints | accepted |
| D-0007 | The SQLite value-representation contract | accepted |
| D-0008 | The package is `private` until publication is decided | accepted |

---

## D-0001 — Vitest is the test runner

**Context.** Interlock's suite is the specification being ported: 2190 passed / 8 skipped /
1 xfailed as of interlock PR #72 (squash `65f36c5`), **green twice under random ordering**. That
last property is a discipline, not a statistic -- it is how the suite proves it has no hidden
inter-test coupling -- and interlock#74 carries it into continuo's CI as an acceptance criterion.
So the runner choice is decided by one question before any other: can it randomize execution order,
with a seed that is explicit and replayable, on every platform the project must support?

The pre-delegation design review (Codex, gpt-5.6-sol, 2026-08-22) recorded the rationale as
"`--test-randomize` landed in Node 26.1 and is unavailable on LTS". **That premise is partly wrong
and is not adopted here.** Verified against the Node.js release notes and CLI documentation on
2026-08-22:

- `--test-randomize` / `--test-random-seed` shipped via nodejs/node#61747. They appear on the
  Current line in **v26.1.0** *and were backported to **v24.16.0*** (2026-05-21), which is Active
  LTS. The documentation for v24 reads "Added in: v24.16.0".
- They are **absent from Node 22.x**, which entered Maintenance on 2025-10-21 (EOL 2027-04-30) and
  therefore receives no semver-minor backports. Measured directly: `node --help` on the local
  v22.17.0 lists no such flag.
- The feature is marked **Stability 1.0 - Early development**, so its flag names and seed semantics
  may change inside the LTS window.

The accurate statement is narrower than the review's, and still decisive: **node:test cannot
randomize order uniformly across a matrix that includes Node 22.** On Node 22 there is no supported
mechanism at all -- shuffling the file list handed to `node --test` reorders files but never
subtests within a file, so the property the double-green rule tests for is exactly the one that
would go unobserved.

**Decision.** **Vitest** (pinned `4.1.11`) is continuo's test runner and assertion library.
Random ordering is configured in `vitest.config.ts` and covers both axes (`sequence.shuffle.files`
and `sequence.shuffle.tests`); CI injects only the seed (`D-0005`).

**Alternatives.**

- **`node:test` (rejected).** Zero dependencies and no build step for tests are real advantages, and
  on Node 24.16+/26 it can now randomize. It is rejected because the required matrix includes Node
  22, where it cannot; because a Stability 1.0 feature is a poor foundation for the one CI rule the
  whole port is graded on; and because it would put the flagship discipline on a different footing
  per matrix cell, which is the same thing as not having it.
- **Jest (rejected).** No first-class ESM story for the NodeNext graph `D-0002` fixes, and its
  ordering support is per-file (`testSequencer`), not per-test.
- **`node:test` on a Node-24-only matrix (rejected, but revisitable).** Dropping Node 22 would make
  node:test viable. It is rejected now because better-sqlite3's support window and interlock#74 both
  name Node 22/24 LTS, and narrowing the supported runtimes to win a runner argument is the tail
  wagging the dog.

**Consequences.**

- **Shuffle scope.** Both file order and, within a file, test order are randomized. Hooks stay
  `'stack'` and tests are **not** concurrent (`D-0005`): ordering and concurrency are separate
  properties, and the ported suite has never been run concurrently.
- **Seed replay.** A failing run is reproduced with `CONTINUO_TEST_SEED=<seed> npm test`. The seed is
  printed on success as well as failure -- Vitest logs `Running tests with seed "<n>"` whenever
  shuffle is active, and `vitest.config.ts` echoes it once more before the banner. Reproducibility
  holds for a fixed set of discovered test files; adding or removing a file changes the resulting
  order at the same seed.
- **Node 26-only features are avoided.** No part of the test infrastructure may depend on a runtime
  feature absent from Node 22 (`D-0003`).
- **Cost.** A Vite-based transform pipeline and its dependency tree now sit under the tests, and the
  assertion vocabulary must be mapped from pytest by hand rather than inherited.
- **Revisitable, with a named trigger.** When Node 22 leaves the required matrix (its EOL is
  2027-04-30) the node:test path becomes viable, and the stability marking is the remaining
  objection. This entry is then reconsidered rather than assumed.

**Status.** accepted

**Source.** interlock#74 (belt step 1; open question 1 of interlock#73). Codex design review
2026-08-22, Blocker 1 -- **adopted in conclusion, corrected in premise**. Node facts verified
2026-08-22 against nodejs.org release notes for v24.16.0 / v26.1.0, `nodejs.org/api/test.html`, and
`nodejs/Release` `schedule.json`; Node 22 absence measured locally on v22.17.0.

---

## D-0002 — ESM, NodeNext resolution, and explicit `.js` import suffixes

**Context.** The port lands roughly 38k lines of tests plus their implementation. Module format,
resolution algorithm, and import-specifier style are the three settings that every one of those
files encodes in its import statements. Deferring them means rewriting every import later; there is
no incremental migration path that does not touch the whole graph.

**Decision.** `"type": "module"`. TypeScript `module` and `moduleResolution` are both `NodeNext`.
Relative imports in source carry the **`.js` suffix** (`./sqlite/open.js`), which is what NodeNext
requires and what the emitted ESM actually resolves. `verbatimModuleSyntax` is on, so type-only
imports are written as such and the emitted module graph is identical to the source graph.
Distribution is `dist/` with an `exports` map and generated `.d.ts` + `.d.ts.map`.

**Alternatives.** CommonJS (rejected: the ecosystem the port depends on is moving away from it, and
interlock has no CJS consumers to preserve); ESM with bundler-style resolution and extensionless
imports (rejected: it requires a bundler at publish time to produce output Node can load, adding a
build tool the project otherwise does not need); dual CJS/ESM output (rejected: no consumer asks for
it, and it doubles the surface every ported module must be correct on).

**Consequences.** Every relative import in the port is written `.js` even though the file on disk is
`.ts`; this reads wrong at first and is correct. `__dirname` and `require` are unavailable --
`import.meta.url` and `createRequire` replace them. The `exports` map means deep imports into
`dist/` are not part of the public surface, so anything a consumer needs must be re-exported from
`src/index.ts` deliberately.

**Status.** accepted

**Source.** interlock#74 refinement comment (2026-08-22); Codex design review 2026-08-22, Major 1.

---

## D-0003 — better-sqlite3 v13 and the supported Node range are pinned together

**Context.** Interlock's core is synchronous SQLite: `migrator.py`, `events.py`, `gates.py` and the
transaction discipline in `txn.py` are all written against a driver that returns rows rather than
promises. A promise-returning driver would not be a port, it would be a redesign of every call site.
better-sqlite3 is the synchronous driver, and it is a **native addon**, which makes the Node version
range part of the same decision rather than a separate one.

**Decision.** `better-sqlite3` is pinned to **`13.0.3`** exactly, and `engines.node` is
**`>=22.14.0 <25`**. The required CI matrix is Node **22** and **24** on **ubuntu-latest** and
**windows-latest**. `package-lock.json` is committed; CI installs with `npm ci`. A native-load smoke
(`scripts/smoke-native.mjs`: import, open `:memory:`, `SELECT 1`, read `sqlite_version()`, close)
runs in every cell **before** the suite.

**Alternatives.** `node:sqlite` (rejected: synchronous and dependency-free, but still marked
experimental and its API is younger than this port's needs); `sql.js` / WASM (rejected: no real file
locking, so the lease and single-writer disciplines interlock depends on cannot be exercised);
`sqlite3` / `node-sqlite3-wasm` (rejected: asynchronous, see Context); accepting better-sqlite3's own
`engines` range (rejected, see below).

**Consequences.**

- **The declared floor is `22.14.0`, not `22`.** better-sqlite3 v13 declares `engines: {node: ">=22"}`,
  but it builds its prebuilt binary at `NAPI_VERSION=10` (`binding.gyp`), and Node provides
  Node-API 10 only from **v22.14.0** / v23.6.0 onward. Node 22.0-22.13 therefore satisfies the
  dependency's declared range and still cannot load the addon. Continuo declares the real floor
  itself rather than inheriting an understated one.
- **v13 is Node-API, so prebuilds are ABI-stable across Node majors.** v13.0.0 moved off NAN/V8-ABI
  onto `node-addon-api`, and the prebuilt binaries ship **inside the npm tarball** (eight
  platform/arch files; `prebuild-install` was removed) -- one binary per platform, not per Node
  major. There is no post-install download, so a CI cell cannot half-install the addon because a
  binary host was unreachable. The smoke test exists for the residual case: an unlisted platform,
  where npm reports success and the addon still will not load.
- **Node 26 Current is deliberately outside the range.** It is not in the required matrix and the
  `engines` ceiling excludes it. Adding it is a decision, not a version bump.
- The bundled SQLite at this pin is **3.53.4**. A SQLite version change is a semantic change to the
  port's substrate and travels with a dependency bump, not silently.
- `save-exact=true` in `.npmrc` keeps the manifest honest about what was resolved.

**Status.** accepted

**Source.** interlock#74 (better-sqlite3 named in belt step 1); Codex design review 2026-08-22,
Blocker 3. Facts verified 2026-08-22 against `WiseLibs/better-sqlite3` v13.0.3 (`package.json`,
`binding.gyp`, v13.0.0 release notes, tarball `prebuilds/` listing) and the Node-API version matrix
at `nodejs.org/api/n-api.html`. Local measurement on Node v22.17.0 / linux-x64: prebuilt binary
loads, `sqlite_version()` = 3.53.4.

---

## D-0004 — TypeScript strictness beyond `strict`

**Context.** The port's safety argument is that the test suite is the specification. That argument
weakens wherever the type system quietly asserts something the runtime does not guarantee. Two such
places are not covered by `strict`.

**Decision.** `strict: true`, plus **`noUncheckedIndexedAccess`** and
**`exactOptionalPropertyTypes`** (neither is implied by `strict`), plus `noImplicitOverride`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`,
`allowUnreachableCode: false`. `skipLibCheck` stays on -- it checks dependency `.d.ts` files, not
continuo's own code.

**Alternatives.** `strict` alone (rejected: `rows[0]` types as non-optional when the array may be
empty, which is precisely the shape every `.all()` result has, and `{ readonly?: boolean }` would
accept an explicit `undefined` that `exactOptionalPropertyTypes` distinguishes from absence -- a
distinction `D-0007` makes load-bearing for SQLite values).

**Consequences.** Indexed reads must be narrowed or defaulted at the call site, which is visible
friction in test helpers that destructure rows. Optional properties may not be assigned an explicit
`undefined`, so option objects are built by omission. Both are one-time costs paid during the port
rather than a migration afterwards.

**Status.** accepted

**Source.** Codex design review 2026-08-22, Major 4; interlock#74 refinement comment.

---

## D-0005 — The double-green rule, and where it is enforced

**Context.** interlock#74's first acceptance criterion is that every ported test is green **twice in
a row under random ordering**. Stated that loosely, at least three CI shapes satisfy the words and
none of them satisfies the intent: separate matrix cells each running once (two greens, one order
each, no cell tested twice); two runs at the same seed (the same order twice, which proves nothing
about order); and a workflow whose shuffle is switched on by a CLI flag that a later edit drops
without turning anything red.

**Decision.** Double-green means: **within each required matrix cell, the suite runs twice, in two
independent processes, serially, at two distinct explicit seeds, and both runs must pass.** The
merge gate is a single aggregate job named **`ci-gate`**, and it is the only name the branch ruleset
references.

Enforcement is split deliberately:

- **Randomization lives in `vitest.config.ts`**, never on the command line: `sequence.shuffle`
  `{files: true, tests: true}`, `retry: 0`, `passWithNoTests: false`, `sequence.concurrent: false`.
  CI injects only `CONTINUO_TEST_SEED`.
- **The seed is mandatory under CI.** `vitest.config.ts` throws when `CI` is set and
  `CONTINUO_TEST_SEED` is not, because Vitest's default seed is `Date.now()` and a run whose order
  cannot be reproduced makes an ordering failure unactionable. Seeds are printed on success too.
- **`ci-gate` is fail-closed.** It carries `if: ${{ always() }}` -- without it, a failing matrix job
  *skips* the gate, and GitHub reports a skipped required check as **success**. It asserts
  `needs.double-green.result == 'success'` as an allow-list (`!= 'failure'` would let `cancelled`
  and `skipped` through) and additionally refuses any `failure`/`cancelled`/`skipped` anywhere in
  `needs.*`, because per-matrix aggregation of `needs.<job>.result` is observed runner behaviour
  rather than a documented guarantee.
- **The ruleset references `ci-gate`, not the matrix legs.** A matrix leg's check-run name embeds
  its matrix values (`double-green (ubuntu-latest, node 22)`), so requiring leg names means every
  matrix edit changes the set of required contexts.

**Alternatives.** Two runs in one process (rejected: module state, timers and the SQLite handle
cache survive between them, so the second run is not independent); `--sequence.shuffle` on the CLI
(rejected, see Enforcement); a fixed repository-wide seed (rejected: it freezes one order, so an
order-dependent bug that the fixed order happens to avoid is never found); requiring the matrix leg
names directly (rejected: protection moves when the matrix moves).

**Consequences.** Test-suite wall-clock in CI roughly doubles, which is the price of the property.
`retry: 0` is not negotiable: a test that passes on retry under a shuffled order is exactly the
signal this rule exists to surface. Seeds vary per run (derived from `github.run_id`,
`github.run_attempt` and the cell coordinates), so re-running a red build explores new orders rather
than replaying the one that was green. The ruleset is a repository setting and therefore lives
outside this repository's diff -- its contents are recorded in `docs/ci-merge-gate.md` so the
setting can be audited against an intent that is under version control.

**Status.** accepted

**Source.** interlock#74 acceptance criterion 1 and its 2026-08-22 refinement comment; Codex design
review 2026-08-22, Blocker 2 and Blocker 4. GitHub behaviours verified 2026-08-22 against
docs.github.com "Troubleshooting required status checks" (skipped-reports-as-success), the `needs`
context reference, and the rulesets REST reference.

---

## D-0006 — ASCII-only for anything continuo prints

**Context.** A recurring accident in the Python lineage: a non-ASCII character in an `argparse`
help string or a `print()` crashes with `UnicodeEncodeError` on a cp932 Windows console. It is
invisible to the test suite, because pytest captures stdout as UTF-8; it appears only on a real
terminal. The character that caused it was usually an em dash typed without thinking.

**Decision.** Every byte continuo writes to stdout or stderr is ASCII. Enforced mechanically by
`test/contract/ascii-output-policy.test.ts`, which fails on any non-ASCII codepoint in `src/`,
`scripts/`, or `test/`. Windows is a required CI cell (`D-0003`), so the policy is observed where it
matters.

**Alternatives.** Restricting the check to string literals that are demonstrably printed (rejected:
"is this string ever printed?" is not decidable by inspection, and the false-negative is a crash on
a user's console); reconfiguring the console encoding at startup (rejected: it fixes continuo's own
output and not that of anything continuo is embedded in, and it fails where the console cannot be
reconfigured); trusting review (rejected: this is the accident class that survived review in the
lineage repeatedly).

**Consequences.** The mechanical rule is **wider than the policy it enforces** -- it forbids
non-ASCII in comments and test names too, not only in printed strings. That is deliberate: an em
dash in a comment costs nothing to avoid, and the wider rule needs no judgment call. Prose files
(`docs/`, `README.md`, this file) are exempt; they are read, never written to a console. Test data
that must contain non-ASCII bytes is constructed from escapes or `Buffer` literals rather than
written verbatim.

**Status.** accepted

**Source.** interlock#74 open question 3 and its 2026-08-22 refinement comment; Codex design review
2026-08-22, Major 6.

---

## D-0007 — The SQLite value-representation contract

**Context.** The ported suite asserts on values read out of SQLite in tens of thousands of places.
Python's `sqlite3` and better-sqlite3 do not agree on every mapping, and the disagreements are
silent. If the mapping is settled by accident -- by whatever the first ported module happened to
do -- then changing it later means rewriting fixtures, expectations and types across the entire
port.

**Decision.** The mapping is fixed at bootstrap, written down in
[`docs/sqlite-value-contract.md`](./docs/sqlite-value-contract.md), and pinned by
`test/contract/sqlite-values.test.ts`, which is executable and therefore fails on a dependency
upgrade that changes any of it. In summary: `INTEGER` -> `number` (**lossy beyond 2^53**, see
below), `REAL` -> `number`, `TEXT` -> `string`, `BLOB` -> `Buffer`, SQL `NULL` -> `null`, a row that
does not exist -> `undefined`, an empty result set -> `[]`, a column not in the result ->
`undefined`.

**Alternatives.** `defaultSafeIntegers(true)` repository-wide, making every `INTEGER` a `bigint`
(rejected as the default: it changes the type of every small integer too, so every assertion in the
ported suite would need `1n` instead of `1`, and JSON serialization of a `bigint` throws --
available as a deliberate per-connection opt-in where a column genuinely carries int64 identifiers);
a row-mapping layer that normalizes types on read (rejected at bootstrap: it is an abstraction
whose requirements are not yet known, and interposing it later is cheaper than removing it).

**Consequences.**

- **`null` and `undefined` mean different things and must not be conflated.** `null` is a stored SQL
  NULL; `undefined` is absence -- of a row, or of a column. `exactOptionalPropertyTypes` (`D-0004`)
  keeps the type system able to express the difference.
- **Two measured hazards are pinned as tests rather than left as prose.** (1) An `INTEGER` larger
  than `Number.MAX_SAFE_INTEGER` is **silently rounded** on read -- SQLite stores the exact int64,
  and no error is raised: `9007199254740993` reads back as `9007199254740992`. (2) An `undefined`
  parameter binds as **SQL NULL** rather than raising, so a typo'd property name reaches the
  database as NULL instead of as an error. Booleans and plain objects *do* throw, and a missing
  parameter throws on arity -- it is `undefined` specifically that passes.
- Any module handling identifiers that can exceed 2^53 must opt into safe integers explicitly and
  say so in its own tests.

**Status.** accepted

**Source.** Codex design review 2026-08-22, Major 5; interlock#74 refinement comment. Every mapping
above was measured on better-sqlite3 13.0.3 / Node v22.17.0 on 2026-08-22, not taken from
documentation.

---

## D-0008 — The package is `private` until publication is decided

**Context.** The npm name `@suisya-systems/continuo` is chosen (interlock#74; bare `continuo` is
taken). The port is at parity with nothing yet, and a `0.0.x` publish of an empty surface would put
a name on the registry that consumers could install and that the project would then owe a
deprecation path.

**Decision.** `"private": true` in `package.json`. Publication is a separate, deliberate decision
recorded here when taken. The repository itself is public, and MIT-licensed, matching interlock.

**Alternatives.** Publishing `0.0.0` to reserve the scoped name (rejected: the scope is already
controlled by the organization, so there is nothing to squat); leaving `private` unset (rejected: an
accidental `npm publish` is then one command away).

**Consequences.** `npm publish` refuses until this entry is superseded. `version` stays `0.0.0` and
no release automation reads it. The `files` and `exports` fields are nonetheless maintained from the
start, so the eventual first publish is a decision rather than a packaging project.

**Status.** accepted

**Source.** interlock#74 refinement comment; Codex design review 2026-08-22, Nit.
