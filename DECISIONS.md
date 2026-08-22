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
- **The port's belts hold disjoint number ranges**, so three lanes appending at once conflict only
  in the index table above and never over an ID. `D-0019`+ is the control-plane belt, `D-0100`+ the
  measurement belt, `D-0200`+ the fencing and settings belt. The ranges are an allocation, not a
  meaning: nothing about an entry follows from which range it is in.

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
| D-0009 | Install with `--ignore-scripts`; the prebuilt binary is the artifact | accepted |
| D-0010 | Biome is the linter and formatter | accepted |
| D-0011 | Package-quality tooling: publint, attw, knip, Dependabot, editor pins | accepted |
| D-0012 | The control plane uses the rollback journal, not WAL | accepted |
| D-0013 | `sqlite3_complete` is transcribed, and pinned by a differential corpus | accepted |
| D-0014 | Seam records reproduce monkeypatch on module internals | accepted |
| D-0015 | Strict UTF-8 decoding for migration step files | accepted |
| D-0016 | Mapping Python sqlite3 exception classes to better-sqlite3 result codes | accepted |
| D-0017 | What refusal message text may change in translation, and what may not | accepted |
| D-0018 | The differential oracle, and the one face this pilot implements | accepted |
| D-0019 | One parity ledger per source test file | accepted |
| D-0020 | A temp-directory label may not contain refusal vocabulary | accepted |
| D-0021 | Values read from SQLite are not re-narrowed to reproduce Python's `int()` | accepted |
| D-0022 | Inherited defects are disclosed and repaired after parity, not during | superseded by D-0023 |
| D-0023 | Inherited defects are repaired in continuo, at the first belt that touches them | accepted |
| D-0024 | The control_plane inherited-defect repairs, and what a failed COMMIT costs | accepted |
| D-0026 | A gate relay targets the stage the gate is about to enter | accepted |
| D-0100 | The read-only capability is an open flag, not a `mode=ro` URI | accepted |
| D-0101 | Module-private names a source case reaches are exported and marked `@internal` | accepted |
| D-0102 | The read-only error classifier keeps only the result-code branch | accepted |
| D-0103 | A report snapshot refuses a deferred body rather than awaiting or draining it | accepted |
| D-0104 | Rendered figures match Python's formatter, pinned by an oracle | accepted |
| D-0105 | Maps keyed by database-supplied ids are `Map`, never plain objects | accepted |
| D-0106 | The measurement barrel stays as narrow as the invariant that guards it | accepted |
| D-0107 | The header's acceptance predicate counts both disqualifying populations | accepted |
| D-0108 | An invariant a public constructor can walk around is repaired, not disclosed | accepted |
| D-0200 | CPython's `fnmatch`, `shlex` and path semantics are transcribed, and pinned by a differential vector | accepted |
| D-0201 | Wire-format keys stay verbatim; in-memory identifiers are camelCase | accepted |
| D-0203 | A `~user` path in a sandbox rule is refused, not passed through | accepted |

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
**`>=22.14.0 <23 || >=24.0.0 <25`** -- the two LTS lines and nothing between them. The required CI matrix is Node **22** and **24** on **ubuntu-latest** and
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
- **Node 23 is excluded outright, not merely floored.** Node-API 10 arrives in v23.6.0, so a naive
  `>=22.14.0 <25` range would still admit 23.0-23.5, where npm reports the package compatible and
  the addon cannot load. Node 23 was never an LTS line and reached EOL on 2026-06-01, so the range
  names the two LTS lines instead of carrying a third floor for a runtime nothing tests.
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

---

## D-0009 — Install with `--ignore-scripts`; the prebuilt binary is the artifact

**Context.** `D-0003` chose better-sqlite3 partly because v13 ships prebuilt binaries **inside the
npm tarball** -- eight platform/arch files, no post-install download, no toolchain needed. The first
CI run on this repository showed that npm does not do that by default.

better-sqlite3 v13 declares **no `install` script**. npm's fallback for a package that contains a
`binding.gyp` and no install script is to run **`node-gyp rebuild`** anyway. On the
`windows-latest` / Node 22 cell that failed outright:

```
gyp ERR! find VS unknown version "undefined" found at "C:\Program Files\Microsoft Visual Studio\18\Enterprise"
gyp ERR! find VS Failure details: RangeError [ERR_CHILD_PROCESS_STDIO_MAXBUFFER]
gyp ERR! configure error: Could not find any Visual Studio installation to use
```

The node-gyp bundled with that Node line could not parse the runner's Visual Studio 18 install, and
the failure is at **configure** time -- before any compilation decision is reached. The same cell on
Node 24, whose npm bundles a newer node-gyp, found the toolchain and passed. So the required matrix
was one node-gyp version away from being green or red for reasons that have nothing to do with
continuo.

The build was **never producing anything**. `binding.gyp` runs `node lib/binding.js` to detect a
prebuild for the host and, when one exists, emits an empty target: measured locally, the resulting
`build/Release/` contains no `.node` file at all, and better-sqlite3's loader prefers
`prebuilds/<platform>-<arch>.node` over `build/` regardless. The entire node-gyp invocation was
overhead that could still fail the build.

**Decision.** CI installs with **`npm ci --ignore-scripts`**. The prebuilt binary shipped in the
tarball is the artifact continuo runs; no source build happens on any cell, and no C++ toolchain is
a requirement for working on this repository. `scripts/smoke-native.mjs` proves it each run: it
asserts the prebuild for the host platform exists on disk **and** that no `build/` directory was
created, then loads the addon and queries it.

**Alternatives.**

- **Install the MSVC toolchain on the Windows cells (rejected).** It makes a green build depend on a
  toolchain that produces nothing, and it makes every contributor need one too.
- **Pin an `npm_config_msvs_version`, or upgrade node-gyp on the Node 22 cell (rejected).** It fixes
  this instance of a class. The class is "a native build we do not want runs anyway and can fail for
  environmental reasons"; not running it removes the class.
- **`npm ci --omit=optional` or vendoring the binary (rejected).** The optional platform packages are
  Vite's, not better-sqlite3's, and are needed (`test/contract/lockfile-platforms.test.ts`).
- **Keep scripts enabled and tolerate the failure on one cell (rejected).** Windows is a required
  cell (`D-0005`); a cell that cannot install never reaches the suite, so the double-green rule
  cannot fail closed on it.

**Consequences.**

- **`--ignore-scripts` applies to every dependency, not just better-sqlite3.** That is acceptable
  here because nothing in the tree needs an install script: Vite's and Rolldown's platform-specific
  binaries arrive as ordinary optional *packages*, not as build steps. Any future dependency that
  genuinely needs a lifecycle script will fail visibly, and adding it is a decision -- which is the
  intended posture, since an install script is arbitrary code execution at `npm ci` time.
- **Installs are faster and hermetic.** Measured locally: 9s with scripts, under 1s without.
- **The smoke test is now load-bearing, not decorative.** It is the thing that would notice a silent
  regression to a source-built binary. Verified by creating a `build/` directory by hand: the smoke
  fails with a message naming this decision.
- Contributors need no C++ toolchain, on any platform.

**Status.** accepted

**Source.** First CI run of PR #1 on `suisya-systems/continuo` (run 32515324352, head `f25a390`):
`double-green (windows-latest, node 22)` red at `npm ci`, the other three cells green, and `ci-gate`
correctly red as a result. Root cause measured locally against better-sqlite3 13.0.3
(`binding.gyp`, `lib/binding.js`, and an empty `build/Release/`), 2026-08-22.

---

## D-0010 — Biome is the linter and formatter

**Context.** The repository had no lint or format tooling: style and import order were whatever
each edit produced, and nothing gated them. The candidates for a TypeScript project in 2026 are
Biome (one tool: linter + formatter + import sorting, a single Rust binary) and the
ESLint + typescript-eslint + Prettier stack (three tools, plugin ecosystem, and -- uniquely --
type-aware lint rules that consult the TypeScript checker).

What type-aware linting would buy here is small. The tsconfig already carries `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`,
`noImplicitReturns` and friends (D-0004), and `npm run typecheck` runs the full checker over
`src`, `test`, and `scripts` on every verify and every CI cell. The marginal catches of
typescript-eslint's type-aware rules (floating promises, unsafe `any` flow) sit on top of a
checker this repository already runs at maximum strictness -- worth having, not worth three
config surfaces and a plugin chain for a codebase this size.

**Decision.** Biome (`@biomejs/biome`, pinned exact like every dependency), configured in
`biome.json`:

- **Formatter and linter both enabled**, `recommended` preset, plus import organizing via the
  `assist.source.organizeImports` action. `npm run lint` runs `biome check .`, which evaluates
  all three; format-only entry points exist as `npm run format` / `npm run format:check`.
- **`lineWidth: 100`**, measured against the existing code rather than chosen on taste: the
  longest pre-existing line was 86 characters, so 100 reformats the least and the default 80
  would have rewrapped compliant code.
- **`complexity/useLiteralKeys` is off.** The contract tests read index-signature fields with
  bracket access (`row["i"]`, `engines?.["node"]`) deliberately, to say "this key is data, not a
  property the type system vouches for". The rule would rewrite them to dot access, which is a
  meaning change, not a style fix.
- **`vcs.useIgnoreFile: true`**: `.gitignore` is the single ignore list; `dist/`,
  `node_modules/`, and coverage output are excluded without a second copy of the list.
  `package-lock.json` is additionally excluded -- it is generated, and reformatting it would
  create diffs npm then rewrites.
- **CI**: one `lint` job on `ubuntu-latest` / Node 24, wired into `ci-gate`'s `needs` and its
  allow-list check. Lint output is platform-independent text analysis, so running it per matrix
  cell would quadruple an identical answer; the merge gate remains `ci-gate` alone (D-0005
  posture: the ruleset references no new check name).
- `npm run verify` now runs lint first -- it is the cheapest gate and fails in milliseconds.

**Alternatives.**

- **ESLint + typescript-eslint + Prettier (rejected for now).** Chosen against for the reasons
  above: three tools and their interop config versus one, slower runs, and a type-aware margin
  that the existing checker configuration has already thinned. If the codebase grows async-heavy
  logic where floating-promise detection earns its keep, adding typescript-eslint *alongside*
  Biome's formatter is a compatible follow-up decision, not a reversal.
- **Prettier alone, no linter (rejected).** Format churn was the smaller half of the problem;
  import order and the mechanical bug-shape rules (unused expressions, accidental `==`) need a
  linter.
- **Biome with type-aware rules pending (noted).** Biome's own type inference (shipped from 2.x)
  covers a growing subset of type-aware rules without the checker dependency; the `recommended`
  preset picks these up as they stabilize, which is the passive path to the same coverage.

**Consequences.**

- One binary, no plugin resolution, no `.eslintrc`/`.prettierrc` interplay: `biome.json` is the
  whole configuration surface. Biome ships platform binaries as optional npm packages (same
  mechanism as Vite's), which the lockfile-platform contract test already polices.
- Biome has no install script, so `npm ci --ignore-scripts` (D-0009) is unaffected.
- The one-time reformat touched most files under `test/` and `src/` mechanically (line
  rewrapping, import reordering, one `!x || x.y` to `x?.y` rewrite in
  `scripts/smoke-native.mjs`). No logic changed; `npm run verify` is the witness.
- A contributor whose editor formats with Prettier will see `format:check` fail on details where
  the two disagree; the repository answer is Biome's.

**Status.** accepted

**Source.** Tooling comparison at introduction time, 2026-08-22, against Biome 2.5.10 on this
repository (16 files, lint + format in under 10ms).

---

## D-0011 — Package-quality tooling: publint, attw, knip, Dependabot, editor pins

**Context.** The package's publishable surface (`exports`, `types`, `files`) is maintained from the
start so the eventual first publish is a decision rather than a packaging project (D-0008), but
nothing checked that surface: a broken `exports` map or a type declaration unresolvable under
NodeNext would land silently, because no consumer exists yet to notice. Likewise nothing swept for
unused exports or dependencies, dependency pins had no update automation, and the editor-level
conventions Biome enforces after the fact (D-0010) were not communicated to editors before the
fact.

**Decision.** Five additions, one decision, because they answer the same question -- "does the
package stay healthy without a human remembering to check?":

- **publint** (`npm run publint`, `publint --strict`) lints the packed tarball's metadata:
  `exports` map consistency, file inclusion, ESM/CJS field agreement. Runs after `npm run build`
  since it inspects `dist/`.
- **@arethetypeswrong/cli** (`npm run attw`, `attw --pack .`) resolves the packed tarball's types
  under every module-resolution mode. Configured in `.attw.json` with one ignored rule,
  **`cjs-resolves-to-esm`**: the package is deliberately ESM-only (D-0002) and ships no CJS
  artifact, so a `require()` from a CJS consumer resolving to an ESM file is the *declared* shape
  of this package, not a packaging accident. (On the supported Node range -- 22.14+ and 24, D-0003
  -- `require()` of a synchronous ESM graph additionally works natively.) All other rules,
  including the node10/node16 resolution checks that pass today, stay live.
- **knip** (`npm run knip`, configured in `knip.json`) reports unused files, exports, and
  dependencies. Entry points are declared explicitly: `src/index.ts` (the public surface),
  `scripts/*.mjs` (run via npm scripts), `test/**/*.test.ts`, and `vitest.config.ts`. The vitest
  plugin is disabled (`"vitest": false`) because it *executes* `vitest.config.ts` to discover
  entries, and that config fails closed when `CI` is set without a `CONTINUO_TEST_SEED` (D-0005)
  -- knip is not a test run and gets no seed, so the config is declared as a static entry instead.
  `ignoreExportsUsedInFile: true` keeps an export that its own module consumes (e.g.
  `createTempDir` in `test/helpers/tmp.ts`) from reading as dead.
- **Dependabot** (`.github/dependabot.yml`): npm and github-actions ecosystems, weekly.
  `versioning-strategy: increase` rewrites exact pins to exact pins (save-exact posture, D-0003).
  Major updates of `better-sqlite3` / `@types/better-sqlite3` are ignored: a major can move the
  prebuilt binary set, the Node-API floor, and the bundled SQLite, which travel with a DECISIONS
  entry (D-0003), not a bot PR. The lockfiles Dependabot regenerates are policed by the existing
  platform-coverage contract test.
- **`.editorconfig` / `.nvmrc`**: the editorconfig restates only what `biome.json` already
  enforces (space/2, LF, line width 100) so editors produce compliant text instead of text Biome
  rewrites; `.nvmrc` says `22`, the lower supported LTS line (engines floor `22.14.0`, D-0003), so
  version managers land contributors on the line most likely to expose a floor violation.

**CI**: one `package` job on `ubuntu-latest` / Node 24 runs knip, then build, then publint and
attw. All three checks are platform-independent, so one cell is enough (D-0010 reasoning); the job
is wired into `ci-gate`'s `needs` and its allow-list, and the ruleset references no new check name
(D-0005 posture). Locally, `npm run verify` now runs knip after lint (cheap, text-only); publint
and attw live behind `npm run check:package`, which builds first, so verify keeps working without a
build step.

**Alternatives.**

- **Wiring publint/attw into `verify` (rejected).** Both need `dist/` to exist and to be current;
  verify is deliberately runnable on a clean worktree without a build. A stale-dist false green is
  worse than a second command.
- **Ignoring attw's node10 rules preemptively (rejected).** The common ESM-only advice is to
  ignore `node10` resolution failures, but this package resolves cleanly under node10 today
  (`main` + `types` fallbacks are maintained). An ignore that nothing triggers is a blind spot on
  layaway; the one rule actually triggered is the one ignored.
- **Renovate instead of Dependabot (deferred).** More expressive grouping and scheduling, but a
  third-party app installation for a repository with two runtime dependencies. Dependabot is
  GitHub-native and its config is one file. Revisit if update-PR volume ever needs grouping.
- **A shared `tool.config` monolith (not considered seriously).** Each tool reads its own file;
  inventing indirection would trade five small explicit configs for one bespoke one.

**Consequences.**

- A change that breaks the `exports` map, ships a type declaration NodeNext cannot resolve, or
  strands an export or dependency turns the merge gate red before any consumer exists to be
  broken.
- `attw --pack` and `publint` both run `npm pack` internally; nothing is published (the package
  remains `private: true`, D-0008).
- knip findings are a merge-gate concern, so "temporarily unused" code needs either an entry
  declaration or removal -- that friction is the feature.
- Dependabot PRs arrive weekly and each must pass the full gate, including the double-green
  matrix and the lockfile platform test; a bot PR has no shortcut.
- None of the new tools ship install scripts that matter here; `npm ci --ignore-scripts` (D-0009)
  is unaffected. The three new devDependencies are pure-JS (no native bindings), so the
  platform-coverage test's required-binding list is unchanged.

**Status.** accepted

**Source.** Introduced 2026-08-22 against publint 0.3.24, @arethetypeswrong/cli 0.18.5, and knip
6.32.2 on this repository. attw baseline measured before configuration: the only failing rule was
`cjs-resolves-to-esm` (node10, node16-from-ESM, and bundler all green). knip baseline: two
devDependencies unflagged once npm scripts referenced them, one export used only in its own file.

---

## D-0012 — The control plane uses the rollback journal, not WAL

**Context.** `src/sqlite/open.ts` -- the generic opener written at bootstrap -- issues
`db.pragma("journal_mode = WAL")` on every writable connection. That is a reasonable default for a
database that is written to concurrently, and it is the wrong default for the control plane, whose
refusal contract several ported cases state in terms of what a *refused* operation does **not** do
to a file.

interlock's `control_plane/migrator.py` does not set a journal mode at all. `_configure` issues
exactly two pragmas -- `PRAGMA foreign_keys = ON` and `PRAGMA synchronous = FULL` -- and a grep for
`journal_mode` across the whole `control_plane` package returns no hits, so SQLite's default
rollback journal is what the source behaves under. Three groups of ported assertions depend on that,
and each fails under WAL for a different reason:

- Three cases assert `sidecars(dbPath) == []`. The source's helper is documented as "Journal and WAL
  files -- evidence that a 'refused' open in fact wrote." WAL creates `-wal` and `-shm` on the first
  write and removes them only on a clean last-connection close, so a correct implementation would
  leave them behind and the assertion would read as an implementation bug -- and the tempting fix is
  to delete the assertion, which discards the property.
- Four cases compare the database file's **bytes** before and after the refused operation (`a
  checksum refusal does not write to the database`, `opening a database behind the code refuses
  instead of migrating`, `creating over an existing path is refused`, and `a file that is not a
  database is refused and left alone`). Under WAL recent commits live in the sidecar, so "the main
  file is unchanged" stops meaning what those tests mean by it.
- Setting `journal_mode = WAL` is itself a write to the database header, so on a writable connection
  it mutates a file the module may not have decided to trust yet -- and on the read-only connection
  verification actually uses, it throws `SQLITE_READONLY` outright. Either way the WAL opener cannot
  serve the path that inspects an untrusted database, which is the path the refusal cases are about.

**Decision.** The control plane gets its own opener, `src/control_plane/connection.ts`, and
`src/sqlite/open.ts` is left unchanged. It exports two functions and the split between them is the
decision:

- `openControlPlaneConnection(path, options)` opens the file and applies **no pragmas**.
- `configureConnection(connection)` applies exactly the two pragmas interlock's `_configure`
  applies, in that order, and nothing else.

Splitting open from configure is not tidiness. Verification runs on a **read-only** connection over
a file that is being inspected precisely because it is not yet trusted, and the fewest pragmas such
a file can be touched with is none.

The tempting justification for that split is that pragmas cannot be issued read-only, and it is
false. Measured on better-sqlite3 13.0.3: `foreign_keys = ON` and `synchronous = FULL` both succeed
on a read-only connection and neither changes a byte. It is `journal_mode = WAL` that differs -- it
throws `SQLITE_READONLY`, "attempt to write a readonly database". So routing verification through
the WAL opener would not quietly corrupt an untrusted file; it would fail outright, and every
refusal that depends on reading one would reach the caller as a driver error rather than as a typed
refusal.

**Alternatives.**

- **Change `src/sqlite/open.ts` to drop WAL (rejected).** It settles the journal mode of every
  future consumer by way of the control plane's refusal semantics. The rollback journal is right
  *here* because of what these tests assert; it is not established as right for the spike database
  or for anything else, and D-0007's posture is that a shared default is chosen deliberately, not
  inherited from whichever module was ported first.
- **Add a `journalMode` option to the generic opener (rejected).** It makes the dangerous setting
  the default and the safe one opt-in, so a new control-plane call site is wrong unless someone
  remembers a flag. A separate module cannot be reached by forgetting.
- **Keep WAL and relax the byte-identity and sidecar assertions (rejected).** interlock#74 asks for
  a faithful translation; these are the assertions that give the refusal cases their teeth.
  Weakening a ported assertion to accommodate a target-side choice that has no source-side
  counterpart is the failure mode the parity ledger exists to make visible, and this one has an easy
  correct fix.
- **`journal_mode = MEMORY` or `OFF` to avoid sidecars (not considered seriously).** Both are
  divergences from the source in the opposite direction, and `OFF` gives up rollback -- which
  contradicts `synchronous = FULL`, whose whole point is that a committed step is durable.

**Consequences.**

- Control-plane connections are single-writer with reader/writer exclusion, which is what interlock
  has today; nothing in the ported suite depends on WAL's concurrent-reader behaviour.
- Two openers now exist, and nothing mechanical stops a future module under `src/control_plane/`
  from importing `openDatabase` instead. The sidecar and byte-identity assertions would catch it
  only in the cases that make them. That gap is stated rather than papered over: the module comment
  in `connection.ts` names this decision, and a lint rule confining the import is the obvious
  follow-up if a second control-plane module ever lands.
- `configureConnection` is applied by callers rather than folded into open, so a writable connection
  that skips it silently runs with `foreign_keys` off. That risk is real and accepted: the read-only
  verification path cannot be served otherwise, and `the migrating connection ends with foreign keys
  enforced` pins the property for the path that matters.
- The two pragmas are per-connection, not stored in the file, so they are reapplied on every open
  rather than assumed from a previous session.

**Status.** accepted

**Source.** `control_plane/migrator.py::_configure` read directly in the interlock checkout at
`/home/happy_ryo/work/org/workers/interlock` (main @ 65f36c5) on 2026-08-22, together with a
`journal_mode` grep over the whole `control_plane` package that returns no hits, and the docstring
of the source's sidecar helper. The read-only pragma behaviour above was measured directly against
better-sqlite3 13.0.3 (SQLite 3.53.4) on the same date. Falsified if interlock's control plane
adopts a journal mode -- at which point this repository follows it rather than keeping the rollback
journal on its own authority -- or if the ported cases that assert `sidecars(dbPath) == []` and
byte-identity are themselves retired.

---

## D-0013 — `sqlite3_complete` is transcribed, and pinned by a differential corpus

**Context.** interlock's migrator does not split a migration step on `;`. `migrator._statements`
accumulates lines and asks `sqlite3.complete_statement(buffer)` where each statement ends, and that
choice is load-bearing rather than stylistic: the production DDL is largely triggers, and a naive
split on `;` cuts every `CREATE TRIGGER ... BEGIN ... END` in half at the first statement inside its
body. better-sqlite3 exposes no equivalent API, so porting the migrator
(`src/control_plane/migrator.ts`) means either reproducing that oracle or changing what a migration
step means.

**Decision.** `src/sqlite/complete-statement.ts` **transcribes** SQLite's `sqlite3_complete()` from
`src/complete.c`: the 8x8 state table, the token classes, and the early-return points, kept in the
original's shape and ordering so the two files can be diffed against each other. It is a
transcription, not a reimplementation -- the shape is the review mechanism.

The transcription was validated differentially against Python's `sqlite3.complete_statement` over a
corpus of **2,203 inputs**: every cumulative line-prefix of the three shipped migration files
(`src/control_plane/migrations/0001_initial.sql`, `0002_policy_seed.sql`,
`0003_outbox_cancelled_status.sql`) plus 30 hand-built adversarial cases -- unterminated string,
unterminated trigger, `;` inside a string literal, `--` comment tail, unclosed `/* */`, bracket and
backtick identifiers, `EXPLAIN`, and the near-keywords `creates` / `ends`.

**The comparison is a standing check, not a one-off run.** `test/sqlite/complete-statement.test.ts`
rebuilds the corpus from the committed migration files and the committed adversarial list, and
asserts the transcription against the vector at every position;
`scripts/oracle/dump_complete_statement.py` regenerates the vector. The corpus is rebuilt rather
than committed because the cumulative prefixes of an 85 KB file come to tens of megabytes, and
rebuilding them from files that are already in the repository is exact.

**That corpus earned its place on the first run.** One cell of the state table was wrong -- state 6,
`TRIGGER`, on a `SEMI` token -- and it made the machine treat the first semicolon *inside* a trigger
body as a statement terminator. 42 of the 2,203 inputs mismatched. After the fix, 2,203/2,203 agree.
A transcription that is 99% right is a transcription that silently truncates trigger DDL.

**Alternatives.**

- **`sql.trimEnd().endsWith(";")` (rejected).** Misclassifies every trigger (the `;` before `END` is
  not a boundary) and every statement whose tail is a `--` comment. It is the shortcut this decision
  exists to refuse.
- **Call `prepare()` and classify the resulting error as "incomplete" (rejected).** It conflates
  *incomplete* with *invalid*. A statement referencing a table that an earlier statement in the same
  step creates fails to prepare while being perfectly complete, so the incomplete-statement refusal
  would fire on a valid migration step.
- **Depending on a third-party SQL splitter (not considered seriously).** The requirement is not "a
  splitter" but "the same answers as the oracle interlock used"; anything not diffable against
  `complete.c` cannot be argued to meet it.

**Consequences.**

- **`splitLinesKeepEnds` lives in the same file and is part of the same fidelity claim.** It
  reproduces Python's `str.splitlines(keepends=True)` boundary set, which is wider than `"\n"`.
  Splitting at fewer points than the source does could merge two statements into one execution,
  which changes what a mid-step failure rolls back -- a data-integrity difference, not a formatting
  one.
- **The statement splitter stays a generator, as the source is.** An eager array is the tempting
  simplification and it is wrong: it would raise the incomplete-statement refusal before any
  statement ran, so the partial-execution-then-rollback path would never be exercised, and the
  ported tests that assert on it would pass for the wrong reason.
- Both functions are internal (`src/sqlite/`), not part of the published surface (D-0002); they
  exist to serve the migrator, not as a general SQL utility.
- SQL text itself is migrated verbatim per the port's SQL policy, so a dialect deviation surfaces as
  a recorded decision rather than as a quiet edit to the splitter.

**Status.** accepted

**Source.** Transcribed from SQLite's `src/complete.c`. Differential run against Python's
`sqlite3.complete_statement` (SQLite 3.45.1) over 2,203 inputs, 2026-08-22: 42 mismatches before the
state-table fix, 0 after. What falsifies this: any input on which the two disagree. The corpus is
derived from the migration files as they stand, so adding or editing a migration changes it -- the
length check in the test turns that into an explicit instruction to regenerate rather than a silent
drift. An upstream change to `sqlite3_complete()`'s state table, or to Python's `str.splitlines`
boundary set, would invalidate the transcription rather than merely age it.

---

## D-0014 — Seam records reproduce monkeypatch on module internals

**Context.** Three ported cases patch a function that the module under test calls *itself*:
`_verify_readonly` (the two verify-reopen-gap cases) and `_apply_step` (one case). In Python this is
ordinary `monkeypatch.setattr`, and it works because a module-level name is resolved at call time
through the module dictionary -- rebinding the dict entry changes what the caller inside the module
sees on its next call. ESM has no equivalent: bindings are resolved at link time and cannot be
rebound from outside the module. `vi.mock` does not reach this case either -- it replaces a module
for its *importers*, and an intra-module call has no importer to intercept. The same problem applies
to `MIGRATION_BUSY_TIMEOUT_MS`: Python reads the module-level constant at call time and the
lock-contention case patches it to 250 ms, while a TypeScript `export const` is immutable.

**Decision.** `src/control_plane/migrator.ts` exports a **seam record**:

```ts
export const migratorSeams = { migrationBusyTimeoutMs, verifyReadonly, applyStep };
```

Every internal call site goes *through* the record (`migratorSeams.verifyReadonly(...)`,
`migratorSeams.applyStep(...)`, `busy_timeout = ${migratorSeams.migrationBusyTimeoutMs}`), so
replacing an entry changes what production code actually calls. That is a reproduction of Python's
late binding, not a workaround for its absence. The record is not re-exported from `src/index.ts`:
it is a testing seam, not public surface.

Tests patch it through `patchSeam` in `test/testkit/seams.ts`, which reproduces the two load-bearing
properties of pytest's `monkeypatch`: it snapshots the value present **at each patch**, not once,
and undoes in **LIFO** order. Both matter here -- one ported case re-patches the same key from
inside its own wrapper to disarm it after a single call, so a restore in registration order would
leave the wrapper installed for the rest of the file.

The seam is kept honest by three **target-only "seam liveness" tests** in
`test/control_plane/migrator.test.ts`, which assert that production code routes through the record:
they count calls through a wrapper, and one asserts that a patched busy timeout reaches `PRAGMA
busy_timeout`.

**Alternatives.**

- **Parameter injection -- pass `verifyReadonly`/`applyStep` in as arguments (rejected).** It
  changes the production call graph. The ported case would then exercise a path that only tests use,
  so a green result would prove something about the injection point rather than about the behaviour
  the source case was written to pin.
- **`vi.mock` on the module (rejected).** It substitutes the module for its importers; the calls in
  question are intra-module and never cross that boundary, so the replacement is simply not reached.
- **`vi.spyOn` on the module namespace object (rejected).** ESM namespace objects are not writable,
  and it cannot touch a plain data key such as a timeout constant at all.
- **Dropping the three cases as untranslatable (rejected).** They cover the verify-reopen gap and a
  mid-apply failure -- exactly the windows a forward-only migrator has to get right. Marking them as
  waivers would spend the pilot's credibility on its hardest cases.

**Consequences.**

- Refactoring an internal call site to call `verifyReadonlyImpl`/`applyStepImpl` directly would
  leave all three ported cases **green for the wrong reason** -- the replacement would never be
  reached. The seam-liveness tests exist precisely to turn that refactor red, and they must be
  maintained alongside the seam; a seam without them is a decoration.
- The record's keys are part of the module's name surface, so the ported "no down migration api"
  case scans `Object.keys(migratorSeams)` as well as the module's exports. Adding a seam named after
  a down-migration operation fails that case.
- Seams are a cost, not a convenience: each one is production indirection that exists for tests.
  Follow-on batches add a seam only where the source case patches a module internal, and the
  translation convention says so.
- `patchSeam` is registered through `onTestFinished`, so a patch is undone whether the test passes
  or fails and is scoped to the test rather than the file -- under the shuffled order of D-0005, a
  patch that outlived its test would fail a different test on each run.

**Status.** accepted

**Source.** The three affected cases and their Python originals were read against the local
interlock checkout on 2026-08-22; the ESM binding and `vi.mock` limitations were confirmed by the
ported cases failing under those approaches before the seam record was introduced. What would
falsify this: a Vitest/Node mechanism that rebinds a live ESM export as seen by its own module -- if
intra-module rebinding becomes available, the seam record is redundant indirection and the three
cases should move to it, with the seam-liveness tests deleted alongside.

---

## D-0015 — Strict UTF-8 decoding for migration step files

**Context.** One ported case writes a migration step file whose bytes are not valid UTF-8 and
requires a typed refusal -- `MigrationStepsRefused` whose message matches `not valid UTF-8` --
rather than a decoder exception escaping raw, and rather than a read that quietly succeeds. Python's
`Path.read_text()` raises `UnicodeDecodeError` there, so the source test gets its refusal for free.
Node's `Buffer.toString("utf8")` does not: it substitutes U+FFFD for every undecodable byte and
**never throws**. The naive port therefore does not refuse at all -- the corrupted step decodes to
something plausible, is stored with the rest, and is then applied to the database. The test does not
merely fail; it fails by describing the exact production accident the refusal exists to prevent,
which is half a schema change landing on a real database.

**Decision.** `discoverMigrationSteps` (`src/control_plane/migrator.ts`) decodes step bodies with
`new TextDecoder("utf-8", { fatal: true }).decode(bytes)`. The `TypeError` that decoder throws is
caught and re-thrown as `MigrationStepsRefused`, carrying the original as `cause`.

Two properties of the surrounding code are part of this decision, not incidental:

- **The checksum is taken over the raw bytes**, `createHash("sha256").update(readFileSync(path))`,
  never over the decoded or normalized text. The property the checksum protects is that the file has
  not been touched at all since it ran, so a whitespace-only edit must change it. No line-ending
  normalization either: a CRLF/LF change *is* a checksum change, by design.
- **The failing test writes its bad bytes as an explicit byte array**, `Buffer.concat` with
  `Buffer.from([0xff])`. `Buffer.from(someString)` cannot express this case -- a literal U+00FF
  encodes to two *valid* UTF-8 bytes, which decode cleanly and turn the test green for the wrong
  reason -- and a raw undecodable byte cannot be written into the source file anyway (D-0006).

**Alternatives.**

- **`Buffer.toString("utf8")` plus a post-hoc scan for U+FFFD (rejected).** It cannot distinguish a
  corrupted file from one that legitimately contains U+FFFD, and it re-derives, badly, a check the
  decoder already performs exactly.
- **Letting the decoder's `TypeError` propagate unwrapped (rejected).** Callers discriminate
  migration failures by type; a bare `TypeError` reaching them is indistinguishable from a
  programming error, and the ported case asserts on `MigrationStepsRefused` specifically.
- **Decoding lazily, at apply time rather than at discovery (rejected).** Discovery is the point
  where the whole ledger is validated as a set; deferring this one check means a corrupted step is
  reported only after earlier steps have already been applied.
- **Reproducing Python's `UnicodeDecodeError` message text (not considered seriously).** See
  Consequences -- the assertion does not depend on it, and fabricating another runtime's diagnostic
  string is worse than differing from it.

**Consequences.**

- **The refusal message differs from Python's in its parenthetical.** It interpolates whatever the
  platform decoder says, where Python says `'utf-8' codec can't decode byte 0xff in position 0:
  invalid start byte`. The ported assertion matches the substring `not valid UTF-8`, which the port
  emits identically, so this is an accepted deviation recorded here rather than a parity gap.
- **`TextDecoder` is the decoding path for this file class; `Buffer.toString` is not.** The two
  differ only on invalid input, which makes the wrong one silently fine in every test that uses
  valid bytes -- the reason this is written down rather than left to reviewers.
- Any future normalization of step text (trimming, line-ending fixes) would have to run *after* the
  checksum, or it silently forgives edits the checksum exists to catch.

**Status.** accepted

**Source.** Ported control-plane migrator case, translated 2026-08-22 against the interlock source
suite. `Buffer.toString("utf8")` substituting U+FFFD without throwing, and `Buffer.from` encoding
U+00FF as two valid UTF-8 bytes, were both observed in this repository while the case was red, not
taken from documentation. Falsified if a Node release makes `Buffer.toString("utf8")` fatal, or if
`TextDecoder` with `fatal: true` stops throwing on an invalid sequence -- in either case the strict
decoder here becomes redundant rather than wrong.

---

## D-0016 — Mapping Python sqlite3 exception classes to better-sqlite3 result codes

**Context.** Interlock's migrator branches on Python exception *classes*: `sqlite3.OperationalError`
for lock contention, `sqlite3.IntegrityError` for a trigger's `RAISE(ABORT, ...)`,
`sqlite3.DatabaseError` for "file is not a database", and a catch-all `sqlite3.Error` around step
application. better-sqlite3 raises **one** error type carrying a `code` string, so those four
branches do not survive translation as written -- they have to be rebuilt from result codes. Done ad
hoc, each `catch` site invents its own test, and the tempting test is `message.includes("locked")`:
SQLite's message text is not a compatibility surface, so that translation is green today and wrong
after any upgrade that reworded a message.

**Decision.** The mapping is written down once, in [`src/sqlite/errors.ts`](./src/sqlite/errors.ts),
as a table in the module comment, and every branch the port actually takes goes through a predicate
there rather than through an inline `catch` test. `isSqliteError` and `sqliteCodeOf` extract the
code; two predicates carry the two classes the migrator branches on: `isBusyError` (`SQLITE_BUSY*`
**and** `SQLITE_LOCKED*`) and `isNotADatabaseError` (`SQLITE_NOTADB`, `SQLITE_CORRUPT*`).

The constraint and cant-open rows of the table are **documented and not written**. Nothing in the
port branches on them -- the ledger-trigger cases assert `SQLITE_CONSTRAINT*` from the test side,
and the absent-database case is settled by a `statSync` before the file is ever opened. An unused
predicate is a guess about a future branch, and a guess nothing exercises is the shape of a mapping
that turns out to be wrong on the day it is finally reached; knip would flag it as dead surface in
any case (D-0011).

`isSqliteError` recognises an error by the presence of a `SQLITE_`-prefixed `code`, **not** by
`instanceof`. better-sqlite3's `SqliteError` constructor is reachable only through the default
export's `.SqliteError` property, and pinning the check to that identity breaks the moment a second
copy of the package is resolved anywhere in the graph -- an `instanceof` that quietly answers false
turns every one of these branches into its fallback path.

On the test side the same split is kept by `expectSqliteError` in
[`test/testkit/errors.ts`](./test/testkit/errors.ts), which asserts the **code** and optionally the
message. A source `pytest.raises(sqlite3.IntegrityError, match="written once")` asserts a class and
a message search; the naive Vitest translation asserts the message alone, dropping the type half
without leaving a trace. Asserting the code keeps both halves, and keeps the durable half
load-bearing.

The refusal family this feeds is separately load-bearing and lives in
[`src/control_plane/refusals.ts`](./src/control_plane/refusals.ts) as **one** declaration that every
module imports, never as parallel declarations -- class identity has to hold across the module
boundary for `instanceof` assertions to mean anything. `MigrationChecksumRefused` and
`DatabaseAheadOfCodeRefused` descend from `CorruptStateRefused`; `MigrationStepsRefused` descends
from `ControlPlaneRefusal` **directly and deliberately not** from `CorruptStateRefused`, because no
database is at fault when this build's own step files are unusable, and an operator who reads it as
corruption reaches for a restore when the fix is a rebuild. Every subclass constructor calls
`Object.setPrototypeOf`: extending a built-in under a downlevel emit target loses the prototype
chain, and `instanceof` then silently reports false.

**Alternatives.**

- **Recreating the Python class hierarchy as TS error classes and wrapping every better-sqlite3 call
  to rethrow into it (rejected).** It buys the `instanceof` spelling of the source at the cost of a
  wrapper on every call site, and the classification still has to be done from codes -- the same
  table, plus a translation layer that can drop `cause` and stack.
- **Matching on message text (rejected).** It is the translation that looks most like the source's
  `match=` and it depends on strings SQLite does not promise; the codes are the documented surface.
- **`instanceof db.SqliteError` (rejected).** See Decision: correct until two copies of the package
  are resolved, then silently false everywhere.
- **Distinguishing `SQLITE_LOCKED` from `SQLITE_BUSY` in the migrator (not considered seriously).**
  Both mean some other holder has the database, which is what the refusal text says; the
  table-level/file-level distinction has no different operator move.
- **Folding `MigrationStepsRefused` under `CorruptStateRefused` to flatten the family (rejected).**
  It is the one split in the hierarchy that changes what the operator does next.

**Consequences.**

- New SQLite branches must be expressed as a predicate in `src/sqlite/errors.ts`, not as an inline
  `catch` test. That friction is the point: the mapping stays reviewable in one place.
- The predicates are prefix matches (`SQLITE_CONSTRAINT*`, `SQLITE_BUSY*`, ...), so extended result
  codes SQLite adds within an existing family classify correctly without an edit here.
- `isSqliteError` will accept a non-better-sqlite3 error that happens to carry a `SQLITE_`-prefixed
  `code`. Nothing in this tree produces one, and the alternative failure -- refusing a genuine
  SQLite error because module identity differs -- is the worse direction to be wrong in.
- The migrator issues its own `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` rather than using
  better-sqlite3's `transaction()` wrapper, and relies on two behaviours measured directly (see
  Source): `db.inTransaction` tracks a manually issued `BEGIN IMMEDIATE`, and `db.exec()` issues no
  implicit `COMMIT`. If either changed, the rollback path would silently leak a half-applied step.

**Status.** accepted

**Source.** Mapping derived from interlock `control_plane` (`main` @ 65f36c5) by reading the
migrator's `except` clauses. Transaction behaviour was **measured, not assumed**, on 2026-08-22
against better-sqlite3 13.0.3 (bundling SQLite 3.53.4, D-0003): `db.inTransaction` is true after a
manual `BEGIN IMMEDIATE` and false after `ROLLBACK`, and a `CREATE TABLE` run through `db.exec()`
inside a manual transaction is rolled back -- so `exec()` does not commit implicitly. Falsified by:
either of those two probes reporting otherwise on a future better-sqlite3, or a result code moving
out of the family its predicate matches; `test/contract/` re-runs the probes, so an upgrade that
changes them is red rather than silent.

---

## D-0017 — What refusal message text may change in translation, and what may not

**Context.** pytest's `raises(match=)` is a regex **search** over the exception's string form, so
interlock's refusal messages are the oracle for 32 of this file's 64 collected cases -- the
assertion is on the text, not on the exception class. That makes the message wording part of the
contract being ported, and it makes improvisation dangerous in a way that is easy to miss: a
translator who rewrites a message to read better in TypeScript does not get a red test with a diff,
they get a regex that no longer matches a string nobody is looking at, and the fix is to relax the
pattern. Every relaxation is a case that stops testing anything. Left to case-by-case judgement, the
rule also drifts -- the same class of substitution gets made in one file and not the next.

**Decision.** Five rules, applied globally, each with at least one instance in this pilot:

1. **Function and module names in refusal text are the target's names.** The source asserts
`match="migrate_control_plane"`; the port emits and asserts `migrateControlPlane`. The same for the
generated schema header, which names `control_plane/migrator.ts` and
`src/control_plane/migrations/`. The property under test -- that the refusal tells the operator what
to call and where to look -- is preserved exactly; a message telling a TypeScript operator to call
`migrate_control_plane` would be a faithful string and a broken instruction. 2. **Literal data in
messages is carried verbatim.** `LEDGER_COMPANIONS` keeps interlock's five names, `__init__.py` and
`__pycache__` included: the allowlist is by provenance, and what the ledger directory may contain is
a step-file decision, not a translation detail. 3. **Mechanical formats are reproduced, not
approximated.** Python's `{:#x}` becomes `` `0x${n.toString(16)}` `` -- lower-case, because that is
what the source's assertions match. Python's `repr` of a name becomes single quotes written by hand,
never `JSON.stringify`. 4. **Rows interpolated into messages get one renderer.** `renderRow` /
`renderRows` in `migrator.ts` turn better-sqlite3 row objects into Python-tuple-shaped text, rather
than an inline join at each call site. 5. **A message difference forced by the runtime is an
accepted deviation recorded in the parity ledger** -- for example the decoder's own wording inside
the not-valid-UTF-8 refusal (D-0015). It is never papered over by hand-copying Python's wording into
a message the runtime did not produce.

Ordering that messages depend on is preserved too: discovery iterates entries in sorted order, and
the file named as the incumbent in a duplicate-version refusal is whichever sorts first. Python's
`sorted()` over `str` is code-*point* order while JavaScript's default `Array#sort` is UTF-16
code-*unit* order; they agree for every code point below U+FFFF, which covers every filename the
naming convention admits. The sort runs on raw basenames *before* the `STEP_FILENAME` filter, so a
non-BMP filename could in principle make them disagree -- and would then be refused by that filter
in both languages regardless of which one sorted first.

**Alternatives.**

- **Keep the source's identifier spellings verbatim, including `migrate_control_plane` (rejected).**
  It maximizes textual fidelity and destroys the property the text exists for: the message would
  name a function this package does not export. Rule 1 changes the token and keeps the meaning;
  verbatim would keep the token and lose the meaning.
- **Substitute Node equivalents into `LEDGER_COMPANIONS` -- drop the Python names, add
  `node_modules` (rejected).** Two ported cases are a matched pair pinning the exact list: one
  requires the companions to be skipped, the other requires `notes.txt` to be **refused**.
  Substituting flips one of the pair red, and the tempting repair -- "skip anything not ending in
  `.sql`" -- turns four cases vacuously green while silently skipping `0007_fix.sql.bak` and
  `0007_fix.sql~`. A skipped step is a schema change that happened on some databases and not others.
- **`JSON.stringify` for quoting names, and `toUpperCase()` on hex (rejected).** Both are the
  idiomatic JavaScript reflex and both change bytes the source's regexes match: double quotes where
  Python's `repr` emits single ones, `0xILKP`-style upper-case where `{:#x}` emits lower.
- **Rewrite the assertions to be structural -- match on an error code, not on text (deferred).** A
  better long-term shape, but it is a change to what the tests assert, which is exactly what a
  parity port must not do on the way in. Revisit after the full port is green, as a change made once
  against a passing baseline.
- **Normalize message text through a translation table at assert time (not considered seriously).**
  It would let both spellings pass, which is another way of saying it tests neither.

**Consequences.**

- The five rules are the only sanctioned reasons a ported message may differ from its source. Any
  other difference is a bug in the translation, and the reviewer's question is "which rule?" rather
  than "does this read well?".
- Rule 1 is applied as a global sweep, so a reviewer can check it by grepping for source-style
  snake_case identifiers in message strings rather than by reading each message against its source.
- Rule 4 makes `renderRow` load-bearing: two refusal messages interpolate rows through it, and both
  are matched by ported cases, so a change to its output is a change to the contract rather than to
  formatting. It does **not** feed the differential oracle (D-0018), which compares a JSON dump
  built from pragma output and row objects.
- Rule 5 means the parity ledger, not the code, is where message deviations are counted -- an
  accepted deviation is visible in the ledger's reason column and is a PR review argument, per the
  waiver posture.
- The companion allowlist carries Python-flavoured names into a TypeScript package indefinitely.
  That is intended: removing them is a step-file decision that needs its own entry here.

**Status.** accepted

**Source.** `raises(match=)` search semantics and the affected assertions read from the interlock
`control_plane` tests at the pinned source revision, 2026-08-22; the rules above are instantiated in
`src/control_plane/migrator.ts` (`LEDGER_COMPANIONS`, `renderCompanions`, `renderRow`, `renderRows`,
the `0x${...toString(16)}` sites) and in the ported cases the parity ledger maps to them. Falsified
if a ported case's assertion is found to match message text that no rule above sanctions, or if the
sort-order claim fails -- Python `sorted()` over basenames and JavaScript `Array#sort` agreeing on
code-unit order is what makes the incumbent named in a duplicate-version refusal identical in both
languages, and a discovery path that sorts on anything other than the raw basename breaks it.

---

## D-0018 — The differential oracle, and the one face this pilot implements

**Context.** This pilot copies interlock's SQL verbatim -- the three migration files are
byte-identical, verified with `cmp`. That fixes the *text* and nothing else. It says nothing about
the order the statements execute in, where the transaction boundaries fall, which pragmas are in
force while they run, or how two different drivers represent the values that come back. Each of
those can differ while both suites stay green, and each of them changes the database. A ported test
asserts what its author thought to assert; it cannot notice a difference nobody wrote an assertion
about.

**Decision.** For any face that can be normalised, feed the same fixture vector to the Python
implementation and to the TypeScript one and compare the normalised output. The design review named
four candidate faces: DB state, CLI results, state transitions, exception classification. **This
pilot implements exactly one -- control-plane DB state** -- and defers the rest to later belt work.

The implemented face:

- [`scripts/oracle/dump_control_plane.py`](./scripts/oracle/dump_control_plane.py) migrates an empty
  database to head through **interlock's** migrator at a fixed clock (`1700000000000`) and prints a
  normalised JSON dump.
- [`test/oracle/control-plane-dump.ts`](./test/oracle/control-plane-dump.ts) does the same through
  continuo's.
- The vector the Python side produced is committed at `parity/oracle/control-plane-state.json`, and
  `test/control_plane/differential-oracle.test.ts` compares against it. CI therefore gets a
  cross-runtime comparison without needing a Python interpreter or an interlock checkout.
- The dump covers `application_id`, `user_version`, `foreign_keys`, `integrity_check`,
  `foreign_key_check`, every schema object's stored SQL text, and for every table its full column
  metadata (name / type / notnull / default / pk) plus every row.

Normalisation is deliberate in two places. `applied_at_ms` is **fixed**, not stripped -- stripping
it would hide a migrator that ignored the caller's clock. Rows are ordered by **every** column,
because neither driver promises an order without `ORDER BY` and an accidental agreement is worse
than a mismatch. Nothing path-dependent is emitted.

Regeneration is one-directional on purpose: the test refuses to write the vector from the TypeScript
side. Setting `CONTINUO_ORACLE_WRITE=1` overwrites it **and fails the test**, so a self-updating
golden vector cannot be left armed in CI. The vector is regenerated by running the Python script
against an interlock checkout.

**Alternatives.**

- **Trust the verbatim SQL and skip the oracle (rejected).** It is the tempting one, and it is wrong
  for the reason above: identical text is not identical execution. The oracle found a real
  divergence on its first run -- see Consequences.
- **Run the Python side in CI on every build (rejected).** It would make every continuo build depend
  on a Python toolchain and an interlock checkout being present and at a known revision, which is a
  much larger operational surface than a committed vector regenerated on demand.
- **Strip the timestamp instead of fixing the clock (rejected).** A migrator that writes
  `time.time()` regardless of the injected clock would compare equal.
- **Compare only row contents, not the stored schema text (rejected).** That is exactly the
  divergence that was found; SQLite keeps `CREATE TABLE` text verbatim in `sqlite_master`, so schema
  text is observable state, not formatting.
- **All four faces in this pilot (deferred).** PR-size discipline; the value of the pilot is the
  mechanism and the recorded design, not coverage breadth.

**Consequences.**

- **It found a real divergence on its first run that no ported test had caught.** continuo's
  `SCHEMA_MIGRATION_DDL` had been *retyped* rather than copied, differing from interlock's by
  whitespace and one trailing comment. Because SQLite stores `CREATE TABLE` text verbatim, the two
  databases' schemas differed textually. Fixed by carrying the DDL across byte-for-byte; the dumps
  are now equal. This is a second class of defect from the state-table bug the `complete_statement`
  corpus found (D-0013) -- that one a ported assertion caught, this one only the oracle could.
- **The comparison is itself guarded.** A "vector is not vacuous" test asserts the committed vector
  has more than 50 schema objects, more than 10 tables, exactly 3 `schema_migration` rows, and a
  non-empty `policy_revision` table, so a vector regenerated from an empty or failed run cannot make
  the comparison pass while comparing nothing.
- Updating the vector is a reviewable diff. A migration change shows up as a schema-text diff in the
  PR rather than as a silently re-recorded golden file.
- The CLI, state-transition and exception-classification faces remain unimplemented. Until they
  exist, parity on those faces rests on the ported assertions alone.

**Status.** accepted

**Source.** Codex design review 2026-08-22 (differential oracle item); implemented 2026-08-22
against the interlock checkout at `/home/happy_ryo/work/org/workers/interlock` (main @ `65f36c5`).
The three migration files were compared with `cmp` on that date. Falsified by: the two dumps ceasing
to be equal after a change on either side, or the vector being regenerated from a source revision
other than the one recorded alongside it -- the vector is only evidence of parity against the
interlock revision it was produced from, so a stale `source_revision` makes the comparison
meaningless rather than merely out of date.

---

## D-0019 — One parity ledger per source test file

**Context.** The pilot shipped one ledger, `parity/control-plane.ledger.json`, covering one source
file. `scripts/parity-check.mjs` is written to that shape: `source.file.inventory` names a single
file's collected node ids, `source.file.collected` is that file's count, and the "unmapped" sweep is
gated on `id.startsWith(`${ledger.target.test_file}::`)` -- one target file's prefix. The port now
has twelve more `control_plane` source files to account for, and three lanes translating
concurrently, so the question is whether a lane keeps one ledger listing many files or one ledger
per file.

**Decision.** One ledger per **source test file**, named
`parity/<subsystem>.<source-file>.ledger.json`, and each lane appends its ledgers to `LEDGERS` as a
labelled block. This is the canonical form for all three lanes.

The deciding property is that it needs **no change to the shared check**. A multi-file ledger would
mean generalizing `source.file` to a list and reworking the inventory, totals and unmapped sweeps --
an edit to the one script every lane depends on, made while two other lanes are mid-flight. Per-file
ledgers reach the same coverage guarantee with additive data only.

Per-file also matches what the ledger is *for*. It is reconciled by a human against
`pytest --collect-only` output for one file at a time, and `source.file.collected` is a per-file
count. A merge conflict between lanes is then a block boundary in `LEDGERS`, not two lanes editing
one line.

**Alternatives.**

- **One ledger per lane, listing many source files (rejected).** It matches the way work is
  dispatched, but the unit of *reconciliation* is the file, and it would require the shared-script
  change described above, at the moment it is most expensive to make.
- **One ledger for the whole subsystem (rejected).** A single 585-entry file that three lanes all
  append to is a merge conflict on every PR.
- **Keep the pilot's single ledger and grow it (rejected).** Same conflict surface, and it would put
  a lane's entries inside the artefact the pilot's reviewers already signed off on.

**Consequences.**

- `LEDGERS` grows by one line per translated file. That is the intended conflict surface: additive,
  and trivially resolvable.
- **A target test file with no ledger at all is invisible to the check.** The unmapped sweep only
  examines files some ledger claims, so a whole translated file could be added with no ledger and
  the gate would stay green. This is a pre-existing hole, not one this decision opens, but per-file
  ledgers make it easier to hit by accident. Closing it -- failing when a file under
  `test/control_plane/` is claimed by no ledger and is not declared target-only -- is a change to the
  shared script and is deliberately left to a coordinated cross-lane change rather than folded in
  here.

**Falsifier.** If the shared check is generalized to multi-file ledgers for another reason, the
argument above (no shared-script change) no longer holds and the packaging should be revisited.

**Status.** accepted

**Source.** Lane A, 2026-08-22, ratified by the operator as the form for all three lanes.

---

## D-0020 — A temp-directory label may not contain refusal vocabulary

**Context.** Every control-plane refusal interpolates the database path into its message, and
`caseRoot(label)` puts the label into that path. `expectRefusal(fn, Type, match)` reproduces
`pytest.raises(Type, match=)`, which is a regex **search** over the whole message. Put those three
facts together and a label that shares a word with a refusal message makes that word's `match`
**vacuous**: the pattern matches the path, so it can no longer fail, and the case silently degrades
to a bare `instanceof` check.

This was found in review, not in theory. With the label `"spike-schema"`, the four expansions of
`a database that lost a constraint is refused` kept their source's `match="schema"` and it could not
discriminate: every one of them would have stayed green for an `integrity_check` failure, a missing
state table, or a foreign `application_id` -- any `CorruptStateRefused` at all -- rather than the
fingerprint mismatch they exist to pin. In interlock the same pattern *is* discriminating, because
pytest names `tmp_path` after the test function and this one truncates to
`test_a_database_that_lost_a_co0`, which contains no `schema`.

**Decision.** A `caseRoot` label may not contain any word that appears in a refusal message the file
asserts on. Labels are short module nicknames -- `s5`, `migrator`, `policy` -- not descriptions.
Confirmed by mutation: with the label fixed, changing the fingerprint refusal's wording turns all
four expansions red, and restoring it turns them green again.

**Alternatives.**

- **Tighten each `match` to a phrase unique to the branch (rejected as the primary fix).** It works,
  but it changes what the case asserts relative to its source, and a parity port must not do that on
  the way in. Renaming the label restores the source's exact discrimination instead.
- **Assert in the testkit that a match pattern does not also match the database path (deferred).**
  The right long-term guard, and it would catch this class for every lane. `test/testkit/` is frozen,
  so it is a helper-only PR merged ahead of the belts that need it, not an edit made in passing.
- **Leave it and disclose (rejected).** The whole point of the `match` half is that the refusal
  family's members share a message shape and differ by type and wording; a vacuous match is a case
  that has stopped testing the thing it names.

**Consequences.**

- Checked mechanically for all four `test/control_plane/*.test.ts` files as of this PR: no
  `expectRefusal` / `expectSqliteError` match literal is satisfied by the temp path its case builds.
- The hazard is worst for a `parametrize`d case, where one vacuous match hides behind several
  passing expansions.

**Falsifier.** If refusal messages stop interpolating the database path, or the testkit gains the
guard described above, the label restriction stops being load-bearing.

**Status.** accepted

**Source.** Lane A pre-Codex self-review, 2026-08-22; found independently by two adversarial audit
passes and confirmed by mutation.

---

## D-0021 — Values read from SQLite are not re-narrowed to reproduce Python's `int()`

**Context.** interlock narrows almost every numeric read with `int(...)`: `int(row[3])`,
`None if row[0] is None else int(row[0])`, and so on. The port reads the same columns with
`Number(...)`. These are not the same function, and the columns are not as constrained as they look:
`policy_detection_latency`, `watcher_scope` and `lease` declare their numeric columns `INTEGER` but
carry no `typeof(x) = 'integer'` `CHECK`, and SQLite's INTEGER *affinity* stores a value it cannot
losslessly convert -- a REAL, or a non-numeric TEXT -- exactly as given.

So for a row that a hand-run `sqlite3` session damaged, the two languages diverge: Python truncates
`3.5` to `3`, and raises `ValueError`/`TypeError` on `'abc'`; the port propagates `3.5`, and turns
`'abc'` into `NaN`. `NaN` then flows into `toleranceMs + periodMs <= budgetMs`, which is always
false, so the subject is reported as a budget violation with `excessMs: NaN` rather than raising.

**Decision.** Do not re-narrow. `INTEGER -> number` as `D-0007` fixes it, applied at the read, with
no truncation and no coercion error. The divergence is disclosed in the affected files' parity
ledgers instead.

The reason is that the alternative is already a rejected decision. `D-0007`'s alternatives record
"a row-mapping layer that normalizes types on read (**rejected** at bootstrap: it is an abstraction
whose requirements are not yet known, and interposing it later is cheaper than removing it)". A
shared `asInt()` applied at every numeric read site is that layer under another name, and adopting
it here -- inside a lane, for one module -- would settle a repository-wide representation question
as a side effect of a translation, which is the specific failure `D-0007` exists to prevent.

**Alternatives.**

- **A shared `asInt()` reproducing `int()`'s truncate-or-refuse behaviour (rejected, above).** It is
  the more faithful answer in isolation and the wrong way to decide it. If the port later wants it,
  it is a `D-0007` amendment applied everywhere at once, against a passing baseline.
- **Per-site `Math.trunc()` (rejected).** It reproduces the truncation and silently drops the
  refusal half, so a `TEXT` in a numeric column becomes `NaN` anyway -- the worse half of both
  options.
- **Add `typeof` CHECKs to the DDL so the state is unreachable (rejected).** The SQL carries
  verbatim; changing it is a schema change, not a translation.

**Consequences.**

- No ported case reaches the divergence: it needs a row that violates the column's declared type,
  which only a hand-damaged database has. It is a robustness difference, not a behavioural one under
  test.
- Every affected ledger carries an `inherited_limitations` entry pointing here, so the difference is
  a disclosed review topic rather than something a reader has to rediscover from the diff.

**Falsifier.** If a later belt finds a case where the divergence is reachable through the public API
-- or if `D-0007` is amended to adopt a normalization layer -- this entry is superseded.

**Status.** accepted

**Source.** Lane A adversarial audit of `policy.ts`, 2026-08-22; the affinity behaviour was measured
on better-sqlite3 13.0.3 (`CREATE TABLE t(v INTEGER)` binding `3.5` reads back `3.5`; binding
`'abc'` reads back `'abc'`), not taken from documentation.

## D-0022 — Inherited defects are disclosed and repaired after parity, not during

> **SUPERSEDED by `D-0023`.** The rule below is no longer in force. It rests on a premise that
> stopped being true: that a defect faithfully reproduced from interlock would eventually be fixed
> *upstream*, so disclosing it here was deferral rather than abandonment. **interlock is now frozen**
> -- no upstream change is coming -- so an item disclosed and left alone is an item nobody will ever
> fix. Read `D-0023` for the rule that replaced it. The text is kept intact, per this file's own
> convention that an ID is never rewritten, and because the reasoning it records is still the
> reasoning a reader needs in order to understand why the port hesitated.

**Context.** The review gate on the event-spine belt raised three defects in `txn.ts` / `events.ts`,
two of them P1:

- a `COMMIT` that fails (`SQLITE_BUSY` from a concurrent reader, which the rollback journal makes
  reachable -- `D-0012`) leaves the transaction **open** while its scope is dropped, so the next
  `transaction()` call sees `inTransaction` and silently *joins* an orphaned transaction: its writes
  never commit and the locks stay held;
- `markSkipped`, joined to a caller's transaction, can settle a consumption as `skipped` and commit
  it **without** the `consumption_skipped` audit event, because `appendEvent` answers a duplicate
  `dedup_key` by returning rather than raising, and dedup keys are caller-controlled;
- the transaction scope is installed **before** `BEGIN IMMEDIATE` succeeds, so a failed `BEGIN`
  leaves `currentScope()` answering for a transaction that was never opened.

Every one is real. Every one is also **structurally identical in interlock**: `txn.py` puts `COMMIT`
in an `else:` clause with `del _SCOPES[key]` in the `finally` and no failed-commit handling anywhere;
`_SCOPES[key] = scope` is the line before `connection.execute("BEGIN IMMEDIATE")`; and
`mark_skipped` reaches `append_event`, which catches `_DuplicateFact` and converts it to a normal
return. None of the three is pinned by a case in either suite.

That is the tension this entry settles. A correctness review says fix them. `interlock#74`'s
acceptance criterion 5 says known limitations stay **disclosed** rather than silently repaired, and
the whole premise of the port is that continuo does what interlock does. A review that cannot see
interlock will keep raising these every round, so the disagreement is one of *criteria*, not of a
fix that has not converged yet.

**Decision.** For a defect that is (a) reproduced faithfully from interlock, (b) pinned by no case on
either side, and (c) raised by review rather than by a failing test: **disclose it in the affected
file's parity ledger under `inherited_limitations`, do not repair it during the port, and repair it
in a dedicated change after parity is reached.** A remediation belt for these three is reserved.

The three are recorded in `parity/control-plane.events.ledger.json`, each naming the interlock
construct it mirrors and the review that raised it.

**Alternatives.**

- **Repair them now and record each as a disclosed deviation (rejected by the operator; it was the
  porting lane's recommendation).** The argument for it: none is behaviour anyone depends on, no
  ported case observes any of them, and criterion 5 forbids *silent* fixes rather than recorded ones
  -- so a documented repair arguably satisfies it while leaving the thing that actually runs less
  fragile. The argument against, which decided it: every repair is a place where "continuo does what
  interlock does" stops being true, and it is claimed at exactly the moment the parity audit and the
  differential oracle are being used to establish that sentence. Deferring costs a known, disclosed
  interval of fragility; repairing costs the clarity of the parity claim itself.
- **Repair only the two P1s (rejected).** The severity split is the reviewer's, not a property of the
  code, and it would make the rule un-restatable -- which is what turns a rule into case-by-case
  judgement and then into drift.
- **Leave them undisclosed because the source has them (never considered).** That is the failure
  criterion 5 is written against.

**Consequences.**

- **The review gate will keep flagging these.** That is expected and is not a regression: the
  ledger, not the reviewer, is the record of what was decided. A later belt must not "discover" them
  and quietly repair them -- the ledger entries exist so the next reader finds the decision instead.
- The repairs are reserved as a post-parity change, so they land against a green baseline where a
  behavioural difference from interlock is a deliberate, reviewable diff rather than noise inside a
  translation.
- This entry generalises: it is the standing rule for the belts still to come, not a one-off ruling
  about three findings.

**Falsifier.** If one of these is shown to be reachable from a ported case -- i.e. the suites *can*
tell the two implementations apart -- it stops being an inherited limitation and becomes a parity
failure to fix immediately. Likewise if interlock repairs one upstream, continuo follows rather than
waiting.

**Status.** superseded by `D-0023`

**Source.** Codex review gate, 2026-08-22, rounds 1 and 2 (two P1, one P2); escalated by lane A per
`docs/test-translation-conventions.md` rule 0 and decided by the operator.

## D-0100 — The read-only capability is an open flag, not a `mode=ro` URI

**Context.** Interlock's measurement harness is read-only **by capability, not by convention**
(`ACCEPTANCE.md` section 3 condition 5, interlock `D-0040`), and it says so with two independent
mechanisms: the SQLite `file:...?mode=ro` URI and `PRAGMA query_only = ON`. Two mechanisms exist so
that neither one's failure is load-bearing, and the module proves both in force before it reads a
row.

Continuo cannot carry the first mechanism as written. **better-sqlite3 does not accept URI
filenames.** Measured on better-sqlite3 13.0.3 / Node 22.17.0: opening
`file:///tmp/.../t.sqlite3?mode=ro` fails with `SQLITE_CANTOPEN: unable to open database file` --
the driver does not set `SQLITE_OPEN_URI`, so the whole string is taken as a path. There is no
option to enable it.

**Decision.** The first mechanism is the driver's `readonly: true` open flag, which sets the same
`SQLITE_OPEN_READONLY` the URI was asking for. Everything else about the module is unchanged: both
mechanisms are still armed, still read back, and still proved independently sufficient by their own
ported cases.

The substitution reaches exactly three places, and no more:

- `openReadOnlyImpl` in `src/measurement/reader.ts`, which is the seam the degraded-capability cases
  replace.
- Two refusal messages that named the URI in their text ("was not opened mode=ro" becomes "was not
  opened read-only"; the inconclusive-probe message likewise). This is a `D-0017` message-text
  change: the text named a mechanism that does not exist here, so keeping it would have made the
  refusal point an operator at a URI they could not have written.
- The hand-built read-only connections in `test/measurement/reader.test.ts`.

**What was measured, and why the probe still means something.** The risk in this substitution is
that the probe becomes vacuous -- {@link proveReadOnly} lowers `query_only` and offers the file a
write, and it is only evidence if the *file handle* is what refuses. Measured on the same build:

| connection | `query_only` | a write | result |
|---|---|---|---|
| `readonly: true` | lowered to 0 | `PRAGMA user_version = <current>` | refused, `SQLITE_READONLY` |
| read-write | `ON` | same | refused, `SQLITE_READONLY` |
| read-write | lowered to 0 | same | **accepted** |
| read-write, blocked by `BEGIN IMMEDIATE` | lowered to 0 | same | refused, `SQLITE_BUSY` |

Row 1 is the property that matters: with the connection-level guard down, the read-only *handle*
still refuses, so the probe is answering a question about the file and not about the pragma. Rows 2
and 3 are the two mechanisms' independence. Row 4 is the contention case the probe must report as
inconclusive rather than as proof, and it is distinguishable by code (`D-0102`).

**Alternatives.**

- **Patch better-sqlite3 or reach the URI through a `PRAGMA` (rejected).** There is no pragma that
  opens a file, and vendoring a patched driver to spell one flag differently is a maintenance
  liability out of all proportion to the change.
- **Drop to one mechanism and rely on `query_only` alone (rejected).** That is precisely what the
  two-mechanism design refuses. `query_only` is a connection-level setting a later edit can lower;
  the open flag is a property of the handle and cannot be raised after the fact.
- **Keep the URI text in the refusal messages (rejected).** A message is an instruction to an
  operator. Naming a mechanism this build does not use sends them to look for a URI that is not
  there.

**Consequences.**

- One source case's message assertion changes wording (`the public probe refuses a writable
  connection`, matching `was not opened read-only` instead of `was not opened mode=ro`), and two
  cases assert the absence of that same new wording. All three are recorded as `adapted` in
  `parity/measurement.ledger.json` rather than passing silently.
- Interlock's URI is built from the **resolved** path, because a relative path inside a SQLite URI
  is resolved against the process working directory and would silently name a different file. That
  hazard does not exist here -- there is no URI to build -- so the port does not resolve the path,
  and the difference is noted at `openReadOnlyImpl` so a later reader does not "restore" a
  resolution step that is now meaningless.
- `docs/measurement-harness.md` section 1 is adjusted to say the same thing, which is one of the
  language-specific adjustments that document carries.

**Status.** accepted

**Source.** Measured 2026-08-22 on better-sqlite3 13.0.3 / Node 22.17.0 (Linux), against interlock
`65f36c5`. Falsified by: better-sqlite3 gaining URI support (at which point the URI form becomes
available again, though the flag stays equivalent and there would be no reason to switch), or by any
build where a `readonly: true` connection accepts a write with `query_only` lowered -- which would
mean row 1 above no longer holds and the probe had stopped proving anything.

---

## D-0101 — Module-private names a source case reaches are exported and marked `@internal`

**Context.** Python has no enforced module privacy. A test can reach `reader._require_query_only` or
`reader._the_error_says_the_database_is_read_only` through the module dictionary, and interlock's
suite does exactly that for both: one case proves that "issued" and "in force" are separated by the
`PRAGMA` read-back and by nothing else, and one drives the read-only classifier with two errors
SQLite actually raised rather than with strings pasted into the test.

TypeScript has no such reach. A module-level function that is not exported is unreachable from a
test file, full stop.

**Decision.** Where a source case reaches a module-private name, the target exports that name and
marks it `@internal` in its doc comment, with a line saying which source case reaches it and that
interlock's is private. It is not re-exported from `src/measurement/index.ts` or `src/index.ts`, so
it is not package API; the barrel test (`the package exports no way to write`) keeps that honest.

**Alternatives.**

- **Drop the two cases (rejected).** Both assert properties nothing else in the file covers. The
  classifier case in particular is the regression test for a defect that certified a writable handle
  as read-only.
- **Re-derive the property through the public API (rejected).** `requireQueryOnly` can only be
  reached publicly by first constructing a connection whose `query_only` silently did not take,
  which is a state SQLite will not produce on demand -- the source simulates it by calling the check
  directly, and so must the port.
- **A separate "internals" export object, e.g. `readerInternals` (rejected).** It is the same
  exported reachability with an extra indirection, and it reads like the seam record (`D-0014`),
  which is a different thing with different rules -- a seam is *replaced* by tests, an internal is
  merely *called* by them. Conflating the two would invite someone to patch an internal and expect
  production to notice.

**Consequences.**

- Two entries in `parity/measurement.ledger.json` are `adapted` on this ground, and each says so.
- `knip` supplies the pressure that keeps the rule narrow, at no extra configuration: test files are
  knip entry points (`knip.json`), so an exported internal is "used" only for as long as some test
  calls it. An internal whose case is deleted becomes an unused export and turns the `knip` gate red,
  rather than lingering as public surface nobody asked for.
- The rule is deliberately narrow. It licenses an export for a name a **source case already
  reached**, not for one the translator finds convenient.

**Status.** accepted

**Source.** 2026-08-22, translating `tests/measurement/test_reader.py` at interlock `65f36c5`.
Falsified by: TypeScript or the runner gaining a way to reach a module-private binding from a test
(there is none today, and `vi.mock` replaces a module for its importers rather than exposing its
internals).

---

## D-0102 — The read-only error classifier keeps only the result-code branch

**Context.** `prove_read_only` is only evidence when the refusal it got back **names read-only**. An
earlier version accepted any `OperationalError`, and a writable connection blocked by another
writer's RESERVED lock raises exactly that with "database is locked" -- so a live control plane
became a way of certifying a read-write handle as read-only. The classifier that fixes this is
`_the_error_says_the_database_is_read_only`, and interlock's has **two** branches: the result code
if the interpreter exposes one, and a case-insensitive search for `readonly` / `read-only` in the
message otherwise.

The second branch is not defensive depth in interlock -- it is the branch that does the work.
`sqlite3.Error.sqlite3_errorcode` exists only on Python 3.11+ and interlock's build runs 3.10, so
the string comparison is the live mechanism there and the code branch is the one that "takes over
silently when the interpreter is upgraded".

**Decision.** Continuo keeps the **code branch only**. better-sqlite3 puts a `SQLITE_`-prefixed
`code` on every error it raises (this is already the basis of `D-0016`), so the branch interlock
documents as preferred is the one that always applies, and there is no interpreter version at which
it is absent. The match is by prefix, `SQLITE_READONLY`, because SQLite's extended codes
(`SQLITE_READONLY_DBMOVED` and friends) carry the same primary result code and are the same answer
to the question.

**Alternatives.**

- **Carry the string branch across as an unreachable fallback (rejected).** A branch no input can
  reach is a branch no test can pin, and an untested fallback in a security-shaped classifier is
  worse than no fallback: the day something does reach it, nobody has ever checked that it is right.
  This is the same argument `src/sqlite/errors.ts` already makes for not writing unused predicates.
- **Match the message as well, as a belt-and-braces check (rejected).** It would make the classifier
  *stricter* than interlock's in a way no source case asks for, and SQLite's message text is not a
  compatibility surface. A rewording upstream would then turn a correct probe into an inconclusive
  one and stop reports for no reason.
- **Match `SQLITE_READONLY` exactly rather than by prefix (rejected).** It would classify every
  extended read-only code as inconclusive, which is a refusal for a database that genuinely is
  read-only.

**Consequences.**

- The classifier is total on this input space in a way interlock's is not: there is no "the error had
  no code" path, so no input falls through for a reason unrelated to what SQLite decided.
- The source case that drives the classifier translates straight and gets *stronger*, not weaker: it
  still supplies two errors SQLite actually raised, and the assertion is now against the code SQLite
  set rather than against words in a sentence.
- Recorded as `adapted` for the one entry it touches, because a reviewer comparing the two functions
  side by side will see one branch missing and should find the reason here rather than reconstruct
  it.

**Status.** accepted

**Source.** 2026-08-22, against better-sqlite3 13.0.3 (every raised error carries `code`) and
interlock `65f36c5` (`measurement/reader.py`, which records the 3.10 constraint in its own
docstring). Falsified by: better-sqlite3 raising a SQLite-originated error with no `code`, which
would reopen the question of what to do with an unclassifiable refusal -- the answer would still be
"refuse as inconclusive", but the classifier would then need the absent-code case written down.

---

## D-0103 — A report snapshot refuses a deferred body rather than awaiting or draining it

**Context.** Interlock's `measurement_snapshot` is a Python `@contextmanager`, used with `with`. A
`with` body cannot return early and carry on later: the scope ends when the body ends, and the read
transaction is released exactly then.

TypeScript has no `with`, so the port expresses the scope as a callback -- and a callback **can**
return early and carry on later. An `async` body returns a pending Promise at its first `await`, at
which point `measurementSnapshot`'s `finally` runs and rolls the snapshot back. Every read after
that `await` then executes on its own separate state of the database, which is silently the exact
defect the snapshot exists to remove, arriving through the mechanism meant to remove it, with no
error anywhere and a `db_fingerprint` still attesting a single state.

This is a hazard the **translation** created. It is not in interlock and could not be.

**Decision.** A thenable result is **refused**, not awaited. The refusal is guarded twice:

- **Compile time.** The callback's return type is `T & (T extends PromiseLike<unknown> ? never :
  unknown)`, which collapses to `never` for a Promise-returning body, so the call site does not
  compile. Verified: `Argument of type '() => Promise<number>' is not assignable to parameter of
  type '(connection: Database) => never'`.
- **Runtime, before invocation.** A function's laziness is knowable from its own kind without
  calling it (`Object.prototype.toString` reads an internal class the syntax sets and no userland
  property can forge). Three kinds defer and all three are refused by one rule: `async` returns at
  its first `await`, `function*` returns an iterator having executed **nothing at all**, and `async
  function*` does both. This check runs before the snapshot is opened, so this branch genuinely
  **prevents** the work: the body never runs and no lock is ever taken.
- **Runtime, after invocation.** An ordinary function that *returns* a Promise or an iterator is
  none of those kinds, and by the time the value is in hand the body has already been entered. Nothing can
  un-start it, so this branch is **containment and a report, not prevention**, and it is written
  down that way rather than claimed as a guarantee. It does two things: the check runs **inside** the
  `try`, so the existing `finally` still releases the snapshot -- refusing must not leak the lock it
  is refusing to hold -- and an abandoned **native** Promise gets a no-op rejection handler, because
  the caller never receives it and an unhandled rejection terminates Node by default, which would
  turn a refusal into a crash. Only a native one: a merely structural thenable's `then` is arbitrary
  user code, and calling it there would run that code synchronously inside the still-held snapshot,
  where it could read through the lock this branch exists to release, block, or throw and replace the
  refusal with its own error. The residual exposure -- a non-native promise-like rejecting unobserved
  -- is the smaller of the two hazards and is accepted knowingly rather than traded for the larger
  one. An iterator result is discriminated by a callable `next` **and** a self-iteration
  protocol, not by `Symbol.iterator` alone: an array of rows is iterable and already fully evaluated,
  and it is the most obvious thing a report body returns, so refusing it would be a worse bug than
  the one being fixed.

Thenables are detected structurally (a callable `.then`) rather than by `instanceof Promise`, because
a Promise from another realm and a userland thenable suspend in exactly the same way.

**Alternatives.**

- **Await the body and make the function async (rejected).** It would hold a SHARED lock -- which
  blocks *every* writer on the control plane, including the watcher, the dispatcher and the CI
  ingest (see the cost note on `measurementSnapshot`) -- across an arbitrary suspension the harness
  does not control. That is a worse thing to do than refuse. Nothing in the harness is asynchronous:
  better-sqlite3 is a synchronous driver and every read in a report is a synchronous call, so the
  shape being refused is one the harness has no reason to produce.
- **Compile-time guard only (rejected).** The port publishes a package; an untyped consumer reaches
  this function with no type check between them, and this failure is silent by construction.
- **Runtime guard only (rejected).** A mistake a type can catch should not wait for a test run.
- **Only the post-invocation thenable check (rejected).** It was the first implementation and it is
  not enough: it reports the problem after the body has begun, so for the case that *can* be caught
  early -- an `async function`, which is the overwhelmingly common way to write one -- it gave up
  prevention for no reason.
- **Letting the abandoned Promise reject unobserved (rejected).** Node's default for an unhandled
  rejection is to terminate the process, so a refusal designed to keep a report honest would instead
  take the process down some milliseconds later, at a point with no connection to the cause.
- **Return the connection and let callers begin/end by hand (rejected).** It reintroduces the
  un-exited scope the callback form exists to make impossible, which is a larger hole than the one
  being closed.

**Consequences.**

- One target-only test, `an asynchronous report body is refused, not awaited (target-only)`. It is
  declared in `parity/measurement.ledger.json` and is **not** counted as ported coverage -- it
  translates no source case, because there is no source case to translate.
- `AsynchronousReportRefused` is port-only surface, exported from `src/measurement/index.ts` and
  re-exported from `src/index.ts` -- the package exports only `.` (`D-0002`), so a name absent from
  the root entry point is one an installed consumer cannot reach at all. It descends from
  `ControlPlaneRefusal`, so a caller catching the family catches this too.
- The branches are pinned separately by the target-only test, because they promise different things:
  the before-invocation branches assert the body never ran and no transaction was opened, the
  after-invocation branches assert only that the snapshot was released and no unhandled rejection
  escaped. A single test over one of them would read as a guarantee the others do not make. The test
  also pins the **negative** case -- an ordinary iterable result is accepted -- so the discrimination
  cannot silently widen into "refuse anything iterable".
- Every later belt that translates a Python `@contextmanager` to a callback inherits this question.
  The answer is this entry: refuse, guard at both levels, and do not quietly make the scope async.

**Status.** accepted

**Source.** Raised as a P1 by the `codex exec review` gate on this PR, 2026-08-22, against
`src/measurement/reader.ts`; the split into a preventing and a containing branch came from the same
gate's second round, which observed that the first implementation detected the Promise only after the
body had started. Compile-time behaviour verified with `tsc -p tsconfig.json --noEmit` on
TypeScript 5.8.3 the same day. Falsified by: the harness acquiring a genuinely asynchronous read path
(it has none while better-sqlite3 is the driver), which would make "refuse" the wrong answer and
require deciding what may hold the control plane's SHARED lock across a suspension.

## D-0104 — Rendered figures match Python's formatter, pinned by an oracle

**Context.** interlock#74's acceptance criterion 3 is that continuo's measurement CLI "produces
reports with the same figures and fields on the shared fixture corpus". That makes the **rendered
text of a number** a parity surface, not presentation: a report whose percentage reads `0.13` where
interlock's reads `0.12` fails that criterion even though the underlying double is bit-identical.

`Number.prototype.toFixed` is not the same function as Python's `format(v, '.Nf')`. They agree on
every input except an **exact tie**, where Python rounds to even and JavaScript rounds away from
zero:

| value   | Python `.2f` | JS `toFixed(2)` |
|---------|--------------|-----------------|
| `0.125` | `0.12`       | `0.13`          |
| `0.375` | `0.38`       | `0.38`          |
| `0.5` at width 0 | `0` | `1` |

`0.375` agrees only by coincidence -- rounding to even and rounding up give the same digit there,
which is exactly how a spot-check of two or three values concludes that `toFixed` is fine.

Ties are rare and they are reachable from real data. An exact tie at two places requires the
fractional part to be one of `.125`, `.375`, `.625`, `.875` -- nothing else is both a tie and exactly
representable as a double -- and every figure this harness prints is `count / count * 100`. One false
termination in eight hundred applied is `0.125` percent.

**Decision.** `src/measurement/format.ts` provides `formatFixed(value, digits)`, which reproduces
Python's formatter including its tie-breaking, and every rendered figure in the harness goes through
it. The value is decomposed into the `mantissa * 2 ** exponent` it literally is, straight out of the
IEEE 754 bits, and the digits are produced by exact `BigInt` division -- so the only rounding
anywhere is the one being decided. "Is this a tie" is a question about the stored binary value, and
it is answered exactly rather than approximately. `isAscii` lives
beside it as `str.isascii()`, which several ported cases assert on rendered output (`D-0006`).

A reimplementation is exactly the kind of artefact that reads correct and is not, so it is pinned
against the thing it reimplements, as a **differential oracle face**
(`docs/differential-oracle.md`, `D-0018`):

- `scripts/oracle/dump_fixed_format.py` asks CPython for its answer on every corpus input at four
  widths and writes them to `parity/oracle/fixed-format-vector.json`.
- `test/measurement/format.test.ts` rebuilds the corpus and compares. It may only compare; there is
  no write path.
- The corpus is **rebuilt, not committed** -- only Python's answers are. It is therefore built with
  no RNG: Python's Mersenne Twister is not reproducible in JavaScript, so a sampled corpus could not
  be rebuilt on the other side. The vector records the corpus length and the test checks it before
  comparing, so a changed corpus arrives as an instruction to regenerate rather than as an
  off-by-one comparison against the wrong answers.
- 4,795 values x 4 widths. Every tie class is enumerated exhaustively rather than sampled, and
  each is probed one ULP either side, because the tie -- and the value that merely looks like one --
  are the only places the two languages disagree.

This face needs **no interlock checkout**: the oracle is CPython itself, reached through the standard
library, which makes it the cheapest of the faces to regenerate.

**Alternatives.**

- **Use `toFixed` and accept the divergence (rejected).** It is a silent, data-dependent difference
  in the artefact the acceptance criterion is about, and it would surface as a one-digit diff in a
  report years from now with nothing pointing at the cause.
- **Round the value before formatting (rejected).** Pre-rounding a double introduces its own error
  and does not address tie-breaking; it moves the disagreement rather than removing it.
- **Pin with a hand-written table of examples (rejected).** This is the `sqlite3_complete` argument
  (`D-0013`) again: a transcription is only checkable against the thing it transcribes, and
  reviewing tie-breaking by eye is what human review is worst at. The oracle also caught a wrong
  expectation *in the test* -- see Consequences.
- **Format integers only and avoid decimals in reports (rejected).** The reports are rates. Section
  3.4's headline is a percentage.

**Consequences.**

- Every later module in this belt that renders a figure must use `formatFixed`, not `toFixed`. The
  mutation sweep on this PR includes a `toFixed`-instead-of-`formatFixed` mutation for exactly that
  reason.
- **The first implementation was wrong, and a review caught what the corpus had not.** It took the
  expansion from `toFixed(20)` and classified a tie by looking for a `5` followed by zeros. But
  `toFixed` *rounds*, so a value merely close to a tie is rendered as one: `0.00005` at four places
  has the double `0.0000500000000000000023960868011929648...`, strictly above the halfway point --
  CPython rounds it up to `0.0001` and the transcription rounded it half-to-even down to `0.0000`.
  Widening the expansion does not fix the class (a double needs up to 1074 decimal places and
  `toFixed` accepts 100); only exact arithmetic does. The corpus missed it because it held no
  near-tie values, so the corpus now probes **one ULP either side of every tie** as well as the tie
  itself. Recorded here because it is the more useful half of the lesson: the oracle is necessary and
  it is not sufficient, since a corpus can only answer for the inputs somebody thought to put in it.
- **It corrected a wrong expectation the moment it ran.** A hand-written case asserted
  `formatFixed(99.995, 2) === "99.99"`, reading `99.995` as a tie that half-to-even sends down. It
  is not a tie: the nearest double is `99.99500000000000454747350886464118957519531250`, strictly
  above the halfway point, and CPython prints `100.00`. The corpus comparison was already green;
  the hand-written expectation was the thing that was wrong. That is the argument for the oracle in
  one line.
- The vector is roughly 280 KB and read in full on every test run. That is deliberate over a smaller
  sampled corpus: ties are sparse, and a corpus that samples is a corpus that misses them.
- `formatFixed` **throws** on a non-finite value rather than rendering `inf` / `nan`. Python and
  JavaScript spell those differently, no ported case pins either spelling, and every figure in this
  harness is a ratio of counts behind an empty-denominator guard -- so reaching it is a caller bug
  and guessing a spelling would be inventing parity where none was tested.

**Status.** accepted

**Source.** Divergence measured 2026-08-22 on Node 22.17.0 / CPython 3.12.3. Falsified by: a
JavaScript engine adopting round-half-even in `toFixed` (it is specified, so this would be a spec
change, not an engine one), or by the vector ceasing to match after a CPython change -- in which case
the question is which of the two is now the parity target, not which is right.

---

## D-0105 — Maps keyed by database-supplied ids are `Map`, never plain objects

**Context.** Interlock passes ground truth around as `Mapping[str, str]` keyed by `action_id`, and
reads it with `.get(action_id)`. The obvious TypeScript translation is a plain object or a
`Record<string, string>`, and it is subtly wrong.

A JavaScript object carries `Object.prototype`. An `action_id` is a string that arrives **from the
database** -- it is not drawn from a closed set and nothing in the DDL constrains its spelling. A
lookup for an id spelling `__proto__`, `constructor`, `toString` or `valueOf` therefore does not miss:
it finds something inherited, and this code reads a found value as *a source having offered a
verdict*. In `adjudicate` that is not a crash, which would be visible -- it is a silent wrong answer,
and the wrong answer is "a ground-truth source spoke" when none did.

Python's `dict` has no such behaviour, so there is nothing in the source that guards against it and
nothing in the ported cases that would catch it.

**Decision.** Any map keyed by a value that arrives from the database is a `Map` / `ReadonlyMap`.
Objects and `Record<...>` are for maps whose keys are a closed set fixed in the source.

This is applied uniformly rather than case by case, so there is no judgement call at each site about
whether a particular id "could" collide.

**Alternatives.**

- **`Object.create(null)` (rejected).** It removes the prototype and keeps object syntax, but it is
  a property of how each map was *constructed*, invisible at every use site, and lost the first time
  someone writes `{ ...labels }` or `JSON.parse`. The failure mode is a map that looks identical and
  behaves differently.
- **`Object.hasOwn` at each lookup (rejected).** Correct where remembered, and this is precisely the
  kind of guard that gets dropped when a call site is copied.
- **Validate ids against a pattern on the way in (rejected).** It invents a constraint the schema
  does not have, so the port would refuse databases interlock accepts.

**Consequences.**

- The ported cases spell map construction as `new Map([[...]])` rather than as an object literal, and
  read with `.get` / `.has`. This changes how a case is written and never what it asserts; it is
  recorded once in each ledger's `target.systematic_mappings` rather than as a per-case adaptation,
  because a note repeated twenty times is a note nobody reads.
- `Map` also preserves insertion order for any key type and has an honest `.size`, both of which the
  rendering relies on.
- Where a ported case asserts a whole mapping equals `{}` or `{"a": ...}`, the target converts with
  `Object.fromEntries` at the assertion. That is safe in the direction it is used -- building a plain
  object for comparison, never looking one up.

**Status.** accepted

**Source.** 2026-08-22, translating `tests/measurement/test_false_termination.py` at interlock
`65f36c5`. Falsified by: the schema gaining a constraint that closes the set of `action_id` spellings,
which would remove the hazard but not the reason to prefer the clearer container.

## D-0200 — CPython's `fnmatch`, `shlex` and path semantics are transcribed, and pinned by a differential vector

**Status.** accepted (2026-08-22)

**Context.** The fencing lane's rule engine does not merely *resemble* Python's standard library --
it calls it, and the answers are the fence:

- `fencing/rules.py` decides whether a tool call is denied with `fnmatch.fnmatchcase`, and
  normalises every path it compares with `os.path.expanduser` + `posixpath.normpath`.
- `fencing/renderer.py` builds the `PreToolUse` hook command line with `shlex.quote` and then parses
  it back with `shlex.split` to check that `--fence` and `--role` carry *this* fence and *this*
  role.
- Refusal messages embed values with `!r`, and the ported tests assert **both halves** of a refusal
  (type and message) through `expectRefusal`, so `repr` is part of the asserted surface (`D-0017`).

Every one of these has an obvious Node substitute, and every substitute disagrees with CPython
somewhere:

| Python | The obvious Node substitute | Where they part company |
|---|---|---|
| `fnmatch.fnmatchcase` | a glob library | shell globbing stops `*` at `/`; `fnmatch`'s `*` is `(?s:.*)` and crosses it |
| `fnmatch.translate` | `* -> .*`, `? -> .` by hand | bracket expressions, `[!seq]`, empty ranges, `&&`/`~~`/`||` escaping |
| `posixpath.normpath` | `path.posix.normalize` | `a/` -> `a` vs `a/`; `//a` -> `//a` vs `/a` |
| `shlex.split` | `String.split(" ")` | quotes, and `\` as an escape **on every platform** |
| `shlex.quote` | a hand-written quoter | the safe-character set is exactly `[\w@%+=:,./-]` under `re.ASCII` |
| `repr` | `JSON.stringify` | single vs double quotes; `None` vs `null` |
| `str.strip` | `String.trim` | `trim` also strips U+FEFF |

**The error direction is what makes this a decision rather than a preference.** A matcher that
matches *less* than CPython's produces a rule that denies less than interlock denies. There is no
probe for the gap and no error raised: the breach battery derives its probes from the same rule
text, so a rule that fails to match its own subject fails identically on both sides of the check.
That is a hole in the fence that every test in the suite reports as green.

**Decision.** `src/fencing/fnmatch.ts`, `src/fencing/shlex.ts` and `src/fencing/pypath.ts`
**transcribe** CPython 3.12.3's `Lib/fnmatch.py`, `Lib/shlex.py` and `Lib/posixpath.py`, keeping the
original's structure and ordering so the files can be read against each other. `pyRepr` and
`pyStrip` in `src/fencing/rules.ts` do the same for the two string builtins. They are
transcriptions, not reimplementations -- the shape is the review mechanism, exactly as in `D-0013`.

The same argument reached four more CPython behaviours as the lane went on, and the same decision
covers them: `src/fencing/pyregex.ts` (CPython's `re` **source dialect**, which
`renderer.py:_check_forbidden_allow` hands author-supplied patterns to), `src/fencing/pyjson.ts`
(`json.dumps`/`json.loads`, whose output every durable fencing artefact is written from and compared
by BYTES), `rules._normalize_path` as a **composed** function, and `src/fencing/pysemantics.ts`
(Python's `or`, iteration, `in`, `set()`, `str()` and `dict.items()`, each of which has a JavaScript
near-equivalent that is *narrower* than the original -- and each narrowing lands on the empty list,
which in a fence renderer means no rules were checked).

They are validated **differentially** against CPython over a committed corpus
(`parity/oracle/fnmatch-shlex-corpus.json`), regenerated by
`scripts/oracle/dump_fnmatch_shlex.py` and compared by
`test/fencing/fnmatch-shlex-oracle.test.ts`: 7,448 `fnmatchcase` results (98 patterns x 76 names),
45 `shlex.split` results including the four inputs CPython **rejects**, 50 `shlex.quote` results, 60
`normpath`, 22 `expanduser`, 51 `repr` and 21 `strip`; then 16,938 `re` answers (190 patterns, of
which CPython compiles 158 and each of those is searched against all 107 subjects, while the other
32 are recorded as the `re.error` they raise), 250 `json.dumps` results (25 values x 10 option
sets), 21 number renderings, 18 `json.loads` key-order-and-round-trip pairs, 74 value-semantics
results and 42 `_normalize_path` results in both the posix and the Windows composition -- about
25,100 comparisons in all.

**Every number in this entry is reproducible from the tree**, which is the point of stating them.
An earlier revision of `src/fencing/pyregex.ts` cited a 4,000-pattern differential fuzz that had
been run once and discarded; a reviewer observed, correctly, that a number nobody can reproduce is
not evidence. The regex face above is that claim rebuilt as a committed corpus.

**Four departures from the Python text, all forced by JavaScript's `RegExp`, none of them changing
which strings match.** That last clause is not a promise; it is what the vector checks.

1. **Atomic groups.** CPython emits `(?>.*?fixed)`. JavaScript has none, so the transcription emits
   the standard `(?=(.*?fixed))\N` emulation, which preserves both the match and the refusal to
   backtrack.
2. **`\Z`.** JavaScript has no `\Z`; `$` **without** the `m` flag means the same thing. (Python's
   `$` does not -- it also matches before a trailing newline -- which is why CPython spells it `\Z`.)
3. **`(?s:...)`.** No inline scoped flags in JavaScript; the whole pattern is the scope in CPython's
   output, so the `s` flag says the same thing globally.
4. **Every literal is respelled so the source is legal under `u`.** CPython's `translate` emits
   identity escapes -- `\&`, `\~`, `\ `, `\#` -- and `u` mode rejects every one of them. `u` is
   nevertheless **required**, so `src/fencing/fnmatch.ts` emits each literal character as one
   `u`-legal atom instead: printable ASCII as itself, a SyntaxCharacter (`^ $ \ . * + ? ( ) [ ] { }
   |`) behind a backslash, everything else as `\u{...}`. `translate` also walks its input by code
   point rather than by UTF-16 index. The spelling primitive is shared with `src/fencing/pyregex.ts`
   through `src/fencing/uescape.ts` -- one definition, two importers, because this port has already
   paid once for two transcriptions of one primitive drifting apart.

   **This entry used to say the opposite, and the correction is the point.** The original text read
   "the `u` flag is deliberately **not** used", reasoning from the identity escapes to dropping the
   flag. The reasoning about the escapes was right; the conclusion was a fence hole. Without `u` a
   regex atom matches one UTF-16 **code unit**, while CPython's `fnmatch` matches one Unicode **code
   point**: `fnmatchcase("<U+1F600>", "?")` is `True` in CPython and was `false` here, because the
   emoji is two code units and `.` consumed one. Any rule using `?`, and any rule whose spec or
   subject carries an astral character, therefore denied **less** than interlock denies -- silently,
   which is the exact failure mode this decision exists to prevent.

   The 4,425 differential comparisons did not catch it because not one corpus input contained a
   character outside the BMP, and that gap was part of the defect. The corpus now carries astral
   patterns and astral subjects (bare, inside a bracket expression, as both range endpoints
   including the inverted range that drives CPython's empty-range removal, and adjacent to BMP
   characters) in `fnmatch`, `pystr.repr` and `shlex_quote`, and then U+FFFF -- the last BMP code
   point, and the input that separates a `> 0xffff` from a `>= 0xffff` in the code-point helpers --
   after a reviewer observed that a boundary tested from one side is not tested. The `fnmatch`
   product is now 7,448 and the whole vector about 7,700. Against the extended corpus the old
   implementation mismatches CPython at 35 inputs and the current one at none; a separate
   transcription mismatched CPython at 35 inputs, 29 of them in the hole direction; the current one
   agrees at every position.

   Randomised differential runs were also used while developing this, at a scale the committed
   corpus does not reach (millions of pattern-by-subject comparisons, including an independent
   adversarial re-run that found zero divergences on any input free of lone surrogates). Those
   harnesses are **not** committed and their numbers are therefore **not** evidence this repository
   can reproduce -- they are recorded here as what was done, not as a check that stands. The
   committed corpus is the standing check, and it is the only number in this entry a reader can
   verify by running something.

   It also made the leading-`]` special case below unnecessary. Escaping **every** SyntaxCharacter
   wherever it appears in a class body subsumes it, and a rule stated over all positions cannot be
   defeated by finding a second position, which a positional patch can.

**The vector earned its place on the first run, the same way `D-0013`'s did.** 15 of the then-4,425
`fnmatch` inputs mismatched. Python's `re` accepts `]` as the *first* character of a character class
and reads it as a literal, so CPython's `translate` emits `[]]` and `[^]]` unescaped. JavaScript's
grammar does not: `[]` is the **empty class**, so `[]]` parses as "match nothing, then `]`" and
`[^]]` as "match any character, then `]`". Neither throws. They simply mean something else -- and
`[]]` is the dangerous direction, because it matches strictly *less* than CPython and a rule built
on it stops denying.

No ported test could have found it. Interlock's fencing suite never exercises a bracket expression
whose first member is `]`, because in Python `fnmatch` is the standard library and correct by
construction -- there is nothing to assert. This is `docs/differential-oracle.md` section 1's
ceiling arriving in a new place.

**And the second time, the vector was the thing that needed fixing.** The `u`-flag hole in departure
4 was found by review, not by the oracle, because the corpus had no astral input to find it with. A
differential vector is only as strong as the alphabet its corpus spans, so "extend the corpus in the
same commit" below is not a formality: a whole class of characters absent from the corpus is a whole
class of divergences the vector reports as green.

**What the extended vector caught on its first run, and what it settles.** Nothing in the regex,
JSON or value-semantics faces produced a *silent* divergence in the fail-open direction, which is
the claim those faces exist to make. Four divergences surfaced, all of them pinned in the
corpus and asserted in **both** directions so that closing one turns the entry red rather than
leaving a false confession behind -- which is exactly what happened to the first of them, whose
entry went red and was removed when the walk learned CPython's fixed-width lookbehind rule:

1. **Variable-width lookbehind -- the one in the dangerous direction, now CLOSED.** CPython rejects
   `(?<=a+)b` at compile time (`look-behind requires fixed-width pattern`, raised with `pos` unset,
   so the message carries no `at position N` suffix); JavaScript's lookbehind is variable-width and
   `compilePythonRegex` compiled it. So interlock turned such a `forbidden_allow_regex` into a
   `global-config-invalid` refusal and **stopped the spawn**, while continuo rendered the role and
   proceeded. This was the only fail-open divergence the extended vector found, and it is the one
   result that justifies the whole corpus: nothing in the ported test suite could have produced it,
   because in Python `re` is the standard library and there is nothing to assert about it.

   `src/fencing/pyregex.ts` now refuses a lookbehind whose body it cannot *prove* fixed-width.
   CPython's width analysis is deliberately not reproduced -- it is a min/max walk over the parse
   tree, and rebuilding it here would be a second engine to keep in step. Instead the walk tracks
   lookbehind nesting and refuses, inside a body, every construct whose width *can* vary:
   alternation, `*`, `+`, `?` (greedy or non-greedy), a range repeat `{n,m}` / `{n,}` / `{,m}`, and
   any backreference (`\1`, `(?P=name)`) -- whose width is the referenced group's. An exact `{n}`
   and every fixed-width atom stay legal, so `(?<=ab)c`, `(?<!ab)c` and `(?<=a{2})b` still compile,
   and the shipped `src/fencing/roles.json` (which uses no lookbehind at all) is unaffected.

   That rule over-refuses six shapes CPython accepts: the equal-width alternations `(?<=ab|cd)e`
   and `(?<=a|b)c`, the width-neutral `(?<=a{2}?)b` and `(?<=a{1,1})b`, and a backreference to a
   fixed-width group, `(a)(?<=\1)b` and `(?P<n>a)(?<=(?P=n))b`. Over-refusal is the direction this
   module is built to fail in -- a named pattern and a stopped spawn, not a pattern that might mean
   something else -- and all six are pinned under `pyregex.refused`, asserted in both directions.
   `pyregex.python_only_refusals` is now empty and kept only so the mechanism stays wired; the two
   patterns that were in it moved into the ordinary refusal comparison, where the message is
   compared against CPython's byte for byte.
2. **The emulated anchors match inside an astral character.** `$`, `\Z` and `(?m)^`/`(?m)$` are
   compiled away into `(?![\s\S])` / `(?<![\s\S])` lookarounds, because JavaScript's line
   terminator is four characters wide and Python's is one. Under `u`, an index *between* the two
   surrogate halves satisfies **both** lookarounds -- neither half is a whole code point from
   there -- and the engine does try that index. So `\A\Z` and `(?m)^$` match a string made of one
   emoji, which CPython does not, and `\Z` reports an offset one code point early. The direction is
   over-matching: continuo forbids an allow entry interlock permits, which is fail-closed and loud.
   29 pairs, listed under `pyregex.astral_anchor_match_deviations`.
3. **`IGNORECASE` folding.** `(?i)` becomes RegExp's `i` under `u`, which is *simple* case folding;
   CPython's is full folding, and it folds the Turkish dotted and dotless I onto ASCII `i` where
   JavaScript does not. CPython matches more, so this one is fail-open, and it is the concrete
   instance of the divergence `src/fencing/pyregex.ts` records as class 3. 7 pairs, listed under
   `pyregex.ignorecase_match_deviations`.
4. **`set()` and Python's numeric tower.** `set([0, False])` has one element in Python and two in
   JavaScript. It cannot change a fence decision -- the forbidden-allow set is only ever probed with
   strings -- and reproducing it would mean rebuilding hash semantics, so it is recorded rather than
   emulated.

The 20 constructs the translator refuses outright and the 9 whose refusal *message* differs from
CPython's are recorded the same way (`pyregex.refused`, `pyregex.refusal_message_deviations`);
everywhere else the message this port authors is CPython's byte for byte, `at position N` included,
and the test compares it as such.

**One known limitation, which no implementation can close.** A *lone surrogate* in a pattern still
diverges. A Python `str` can hold an unpaired U+D83D next to an unpaired U+DE00 and keep them
distinct; in JavaScript those two code units *are* U+1F600, and no strategy inside `fnmatch.ts` can
separate them. Both directions occur, and one is a hole: `[!<lone D83D><lone DE00>]` against
U+1F600 matches in CPython and not here. It is reachable in principle -- UTF-8 cannot encode a lone
surrogate, but `json.load` and `JSON.parse` both accept a `"\ud83d"` escape, so a role document
could carry one -- and it was found by a fuzz run through the empty-range-removal merge rather than
by anyone writing surrogates side by side. Recorded here because this module's whole thesis is that
a rule matching less than its source is a hole with no probe, and this is the one remaining case.

**One accepted deviation, recorded rather than hidden.** CPython resolves `~someuser` through the
`pwd` database; Node has no equivalent, so `expanduser` returns those paths unchanged -- which is
the branch CPython itself takes when the lookup fails. The affected inputs stay **in** the corpus,
listed under `pypath.expanduser_accepted_deviations`, and the test asserts both that continuo passes
them through *and* that CPython did something different, so the entry fails loudly if it ever goes
stale. Whether a `~someuser` path should instead be **refused** by `parseSandboxEntry` -- turning a
silent hole into a loud refusal, as the adjacent `{placeholder}` check already does -- was referred
to the operator and is decided in `D-0203`: it is refused, so the deviation recorded here is
*contained* rather than merely accepted, while `expanduser` itself stays a transcription. The
shipped `roles.json` contains no `~user` path, so no ported case is affected either way.

**Alternatives.**

- **Use a glob library and a shell-words package (rejected).** The requirement is not "a glob" and
  "a tokenizer". It is *these* answers, because interlock's fence is defined by them. A dependency
  that is 99% compatible is a fence with holes nobody can enumerate.
- **Hand-roll the subset the shipped `roles.json` needs (rejected).** It would work today and rot
  the first time a rule is authored with a bracket expression -- and rot silently, in the direction
  that denies less.
- **Compare the generated regex *source* rather than match results (rejected).** The four departures
  above mean the two sources are deliberately not identical, so a text comparison would be red on
  every input while proving nothing. The vector records CPython's `translate` output anyway, but
  only to annotate a mismatch: when the two disagree about a match, the next question is always
  which regex is wrong.

**Falsified by.** A CPython release changing any of these behaviours (the vector records
`python_version`, `3.12.3`); or the fence gaining a matching primitive not covered by the corpus, in
which case the corpus is extended in the same commit.

---

## D-0201 — Wire-format keys stay verbatim; in-memory identifiers are camelCase

**Status.** accepted (2026-08-22)

**Context.** The fencing lane produces two kinds of names, and they have different owners.

Some are a **format**: the persisted fence at `fence_path` is written by the renderer and read back
by the `PreToolUse` deny hook, possibly across a restart and possibly by a different process; the
battery report and the fence diff are JSON documents an operator reads; the hook's stdout payload is
consumed by the Claude CLI, whose key names (`hookSpecificOutput`, `permissionDecision`) are not
ours to choose. Interlock's `state.py` writes this file with `sort_keys=True` and the spawn path
restores it **by bytes**.

Others are just TypeScript identifiers, and the repository's linter and every other module in the
port spell those in camelCase.

Conflating the two is a real hazard in both directions: renaming a wire key to `ruleId` makes a
fence written by continuo unreadable by any other reader of that format and breaks the byte
comparison the restart check depends on, while carrying `role_kind` through the TypeScript as a
field name makes the port read as a transliteration and invites the next person to "fix" it.

**Decision.** The boundary is the serialisation function, and it is explicit.

- **Wire keys are verbatim**, in the source's spelling, wherever they appear in a persisted or
  emitted document: `rule_id`, `role_kind`, `permission_mode`, `tool_name`, `tool_input`,
  `all_denied`, `denied_by_its_own_rule`, `decided_by`, `added_rules`, `removed_rules`,
  `settings_changed`, `permission_mode_changed`, `format`, and the CLI's own `hookSpecificOutput` /
  `permissionDecision` / `permissionDecisionReason` (already camelCase in the source -- carried
  across unchanged, not "corrected").
- **In-memory identifiers are camelCase**: `ruleId`, `roleKind`, `permissionMode`, `toolName`,
  `toolInput`, `allDenied`, `deniedByItsOwnRule`.
- The two meet **only** inside a `toJson` / `fromJson` pair. No wire key appears as a TypeScript
  property name outside one, and no camelCase name is ever written to disk.

**Consequence.** The mapping is a diff a reviewer can check in one place per type, instead of a
convention they have to trust everywhere. It also means the ported tests can assert on the emitted
document with the source's own key names, which is what makes those assertions comparable to
interlock's.

**Alternatives.**

- **snake_case throughout (rejected).** Fights Biome and every other module in the repository, and
  makes the port look like a transliteration rather than a port.
- **camelCase throughout, converting at the edges automatically (rejected).** An automatic
  round-trip converter cannot know that `hookSpecificOutput` is already camelCase *by the CLI's
  choice* and must not be touched, nor that `rule_id` inside a battery report is a format and not a
  field. It would also make the on-disk fence change shape whenever the converter's rules changed.

**Falsified by.** The CLI changing its hook payload key names, or the persisted fence gaining a
declared schema that renames its keys -- either of which is a format change with its own migration,
not a naming preference.

---

## D-0203 — A `~user` path in a sandbox rule is refused, not passed through

**Status.** accepted (2026-08-22)

**Context.** `fencing/rules.py` normalises every path it compares through `os.path.expanduser`. On
POSIX, CPython resolves `~someuser` by asking the `pwd` database, and returns the path **unchanged**
when that lookup fails. Node has no `pwd` lookup at all, so `src/fencing/pypath.ts` can only ever
take CPython's failure branch: `~someuser/secrets` comes back as the literal string
`~someuser/secrets`, and `parseSandboxEntry` builds a `FenceRule` whose spec is that literal.

Both of CPython's branches are reachable in practice, and the refusal below covers **both**. Measured
on the Linux cell, 2026-08-22: `os.path.expanduser("~root/secrets")` returns `/root/secrets` -- a
name that exists in the `pwd` database resolves and interlock renders the rule -- while
`os.path.expanduser("~nosuchuser/x")` returns `'~nosuchuser/x'` unchanged. Continuo refuses **every
`~user` form on posix**, the resolvable ones included, so the divergence is wider than "interlock
carries an unexpanded path": for `~root` interlock renders a correct rule and continuo refuses the
document.

**The failure mode is a fence hole with no symptom.** Such a rule matches no real path -- nothing on
disk is named `~someuser/secrets` -- so a sandbox deny entry the operator wrote to protect another
user's home silently covers nothing. No error is raised, because passthrough is a legal CPython
outcome, not a defect. No probe fails either: the fencing breach battery derives one probe per rule
*from that rule's own spec*, so the probe is built from the same unexpanded literal and matches it.
The battery stays green while continuo denies strictly less than interlock does. That is the error
direction `D-0200` names as the reason this lane transcribes rather than substitutes, arriving
through the *input* rather than through the matcher.

**This is the source's own principle, applied to an input class Python never had to face.** The
adjacent check in the same function refuses an unsubstituted `{placeholder}`, and interlock's own
comment on `parseSandboxEntry` gives the reason: paths reach this module already substituted,
"because a rule whose meaning still depends on a later resolution step cannot be probed". A `~user`
path under a runtime with no `pwd` database is exactly such a rule -- its meaning depends on a
resolution step that will never happen. Python needed no check because under CPython the step does
happen; the input class only becomes unresolvable once the host is Node.

**Decision.** `parseSandboxEntry` in `src/fencing/rules.ts` throws `RuleSyntaxError` --
`unresolvable user home in sandbox path: <repr>` -- for **every** path in the `~user` form on posix:
a leading `~` followed by anything other than a separator or end-of-string, whether or not CPython
would have been able to resolve that name. Refusing the resolvable ones too is the point rather than
an overreach: continuo cannot perform the `pwd` lookup that decides which of the two CPython
branches a given name takes, so admitting `~root` would mean *guessing* that this host resolves it
the way the authoring host did -- and a guess that is wrong lands on the passthrough branch, which
is the silent hole this decision exists to close. `~/...` and a bare `~` are the *current* user's
home, resolved without `pwd`, and expand exactly as before. The check sits beside the
`{placeholder}` refusal because it is the same check.

**The refusal is posix-only, deliberately.** `ntpath.expanduser` resolves `~user` from
`USERPROFILE`, else `HOMEDRIVE` + `HOMEPATH`, with no `pwd` database in the picture, and
`src/fencing/pypath.ts` transcribes that in full. On Windows the resolution step genuinely happens,
so a `~user` rule *is* probeable there and refusing it would reject a rule interlock resolves
correctly -- a fidelity loss bought for nothing. The refusal is therefore scoped to the platform
that cannot perform the step, dispatching on `process.platform` for the same reason `expanduser`
does: `os.path` is not one function.

**The refusal lives at the rule-parsing boundary, not inside `expanduser`.** `src/fencing/pypath.ts`
stays a faithful transcription of CPython so that it remains checkable *against* CPython by the
differential vector; bending it would leave the oracle comparing continuo with continuo. The
recorded deviation in `parity/oracle/fnmatch-shlex-corpus.json`
(`pypath.expanduser_accepted_deviations`) therefore stands unchanged, still asserting both halves --
passthrough here, disagreement with CPython there -- but is now described as **contained** by this
refusal rather than merely accepted.

**It is a deliberate divergence from CPython, made fail-closed.** Interlock on POSIX accepts such an
entry either way -- resolving it when the `pwd` lookup succeeds, carrying the unexpanded path when it
fails; continuo refuses the document in both cases.
The operator approved the divergence on 2026-08-22, on the ground that a loud refusal at load time
is strictly safer than a deny rule that covers nothing, and that a fence document is authored once
by a human who can act on a refusal but cannot see a silent hole.

**No ported case changes.** The shipped `src/fencing/roles.json` carries only `~/.ssh`, never a
`~user` path, and no interlock fencing case exercises one. This adds a refusal on an input class the
ported suite does not reach, and removes nothing from it.

**Alternatives.**

- **Parse `/etc/passwd` to emulate `pwd` (rejected).** It reproduces CPython's *successful* branch
  only approximately: CPython goes through NSS, so LDAP, SSSD and every other non-file source would
  be invisible, and the emulation would be right on developer machines and wrong on the hosts that
  matter. Reimplementing a piece of the C library from a file format is out of scope for a parity
  port, and its failure would again be silent and in the denies-less direction.
- **Keep the passthrough and log a warning (rejected).** A warning is not a fence. The entry would
  still parse into a live rule covering nothing, and the operator who wrote it would still believe
  the path was denied.
- **Refuse on every platform (rejected).** Simpler and uniform, but it would reject Windows rules
  interlock resolves correctly -- trading a real capability for symmetry.

**Falsified by.** Node, or a dependency this port is willing to take, gaining a real `pwd` lookup:
`posixExpanduser` could then take CPython's *success* branch and the refusal would become an
unnecessary divergence to remove. Also by interlock refusing or pre-substituting `~user` paths
upstream, which would turn this decision into a plain translation.

## D-0106 — The measurement barrel stays as narrow as the invariant that guards it

**Context.** Interlock's `tests/measurement/test_reader.py` asserts that the measurement package
exports no name containing `migrate`, `create`, `write` or `lease`. The property it protects is real
and load-bearing: the harness is read-only by capability (`ACCEPTANCE.md` section 3 condition 5), and
a writer re-exported from the harness's own front door would be a writer its callers could reach
without ever naming the control plane.

Interlock keeps that property structurally. Its `measurement/__init__.py` re-exports **only**
`reader`'s names, so the module that has no writers is the only module in the barrel, and the other
twelve modules are reached by their own paths.

continuo cannot copy that shape. `D-0002` exports `.` alone, so a name absent from the package entry
is a name an installed consumer cannot reach at all -- which is why this port's measurement barrel
grew to carry every module. That worked for six modules and stopped working at the seventh: `canary`
is the AC-7 writer audit, and its vocabulary is full of the forbidden word because what it audits
**is** writing. `WriterAudit`, `WrittenRecord`, `auditWriters`, `DualWriteFinding`,
`FILE_REFUSED_THE_WRITE` -- not one of them writes anything, and every one of them trips a substring
rule that exists to catch writers.

**Decision.** The measurement barrel (`src/measurement/index.ts`) carries only names that satisfy the
invariant. Anything the invariant excludes is re-exported to consumers from the package entry
(`src/index.ts`) directly out of its module, with a comment saying why it takes the long way round.

The assertion is not relaxed, not narrowed to "names that are verbs", and not given an allow-list.
It is a ported case and its substring rule is exactly what makes it hard to defeat by accident: a
rule that reasoned about which write-shaped names are "really" writers is a rule that would one day
be argued into admitting one.

**Alternatives.**

- **Weaken the assertion to exclude known-safe names (rejected).** This is the fidelity trade the
  port exists to refuse. It also removes the property's whole value: the next name added would be
  argued against the same list, and the argument would be made by whoever wanted the export.
- **Rename canary's exports so they do not contain `write` (rejected).** It would make continuo's
  public vocabulary differ from interlock's for the whole AC-7 surface, so a reader following
  `measurement-harness.md` section 5 would find no name it mentions.
- **Do not export canary at all (rejected).** `Q-0005` is open and the canary report is the artefact
  a human reads to close it; a report nobody can reach is not a deliverable.

**Consequences.** The measurement barrel is no longer "every measurement name", so a later module
must check the invariant before adding itself to it -- the reader test fails loudly if it does not,
which is the intended enforcement. Package consumers see no difference: every canary name is exported
from `.` exactly as the others are.

**Falsified by.** interlock widening `measurement/__init__.py` to re-export its whole harness, which
would mean it had either dropped the assertion or reconciled it with canary's vocabulary upstream --
and this port would then follow whichever it chose.
---

## D-0023 — Inherited defects are repaired in continuo, at the first belt that touches them

**Context.** `D-0022` said that a defect faithfully reproduced from interlock, pinned by no case on
either side and raised by review rather than by a failing test, should be **disclosed** in the
parity ledger and repaired after parity. That rule had a premise: interlock would still be there to
fix it, so continuo diverging early would cost the parity claim more than the defect cost anyone.

**The premise is gone. interlock is frozen** -- it will not be changed again. So every inherited
defect has exactly one place left where it can be fixed, and "inherited" stops being a reason to
wait. An item disclosed under `D-0022` and left alone is not deferred; it is abandoned.

**Decision.** Inherited defects are **repaired in continuo**. The right moment is normally *now* --
the belt that is already editing that code is the cheapest place to fix it, and the one where the
person doing it has the source open. Concretely:

- Repair it in the belt that touches the code, unless the repair is large enough to be its own
  change (a concurrency redesign, say) -- in which case name the belt it is scheduled into, in the
  ledger, rather than leaving it open-ended.
- When a defect is repaired, its ledger entry moves from `inherited, disclosed` to a **deliberate
  divergence**: continuo's behaviour is now the intended one, and the entry says so. Any test that
  pinned the inherited behaviour is inverted in the same change.
- **The trail is the point.** Parity is still established by comparison against interlock, so every
  place the two now differ on purpose has to be reachable from the ledger. A divergence nobody can
  find is indistinguishable from a translation error.

**Alternatives.**

- **Keep `D-0022` and schedule one repair belt after parity (rejected).** It concentrates the work
  at the moment the code is coldest, and it asks a later reader to reconstruct context that is free
  today. It also leaves a growing list whose only purpose is to be worked through later.
- **Repair silently, without moving the ledger entry (rejected).** That is the failure
  interlock#74's acceptance criterion 5 is written against, and it would break the trail the third
  bullet above exists to keep.

**Consequences.**

- The review gate stops being answered with "inherited, see `D-0022`". That answer was correct under
  the old rule and is now a deferral that needs a reason of its own.
- Ledger entries become the record of where continuo deliberately differs from interlock, not only
  of where it deliberately agrees. That is a larger claim to keep true, and the reason the trail
  requirement is stated as a rule rather than left to habit.

**Falsifier.** If interlock is un-frozen and upstream repair becomes possible again, the premise
returns and this decision should be revisited.

**Status.** accepted

**Source.** Operator decision, 2026-08-22, applied across all three lanes; the measurement lane's
`D-0107` and `D-0108` are the first and second applications.


## D-0107 -- The header's acceptance predicate counts both disqualifying populations

**Context.** `Ac9Report.supportsAcceptanceClaim` is false while two populations are non-empty:
`unboundedMissing` (an invocation with no ceiling, so nothing to impute it at) and
`unconfirmedResponseCount` (an invocation that never finished, whose `model_response_count` is still
`startInvocation`'s request-time placeholder of 1). Both disqualify on the same grounds -- the
bounded figure stops being a bound over the cohort and becomes a bound over the imputable subset,
with the rest contributing zero, which is the treat-missing-as-zero bias wearing the bound's name.

interlock's provenance header carries only the first. `imputation_from_ac9` reads
`len(report.unbounded_missing)`, and `ImputationRule.supports_acceptance_claim` is
`unbounded_missing == 0`. So over a report containing one unfinished invocation, the AC-9 section
says the claim is unsupported and the header says it is supported.

**This is not two artefacts disagreeing; it is one document contradicting itself.**
`render.py` builds the header at line 699 and the AC-9 section at line 480 by separate paths, and
both land in the same rendered report. Measured against interlock at `65f36c5` rather than inferred:

```
.header.imputation_rule.supports_acceptance_claim          true
.sections.ac9.facts.imputation.supports_acceptance_claim   false
```

**Decision.** `ImputationRule` carries `unconfirmedResponseCount` as well, its predicate requires
both counts to be zero, `imputationFromAc9` supplies both, and the header's mapping prints the new
count. The two predicates now give one answer, and a reader can see which population produced it.

Adding the *count* rather than folding it into `unbounded_missing` is the point. A predicate whose
input the reader cannot see is worse than the contradiction it replaces, and `unbounded_missing: 1`
for a row that has a ceiling would be a false statement about which thing went wrong.

The new field is **required, with no default**. An optional count falling back to zero would leave a
public construction path -- `new ImputationRule({...})` without it -- emitting
`supports_acceptance_claim: true` over a report whose AC-9 section says otherwise, which is the
contradiction this decision exists to remove, reintroduced through the door the decision left open.
A caller with no unfinished invocations writes `0` and thereby says so.

**This is a deliberate, permanent divergence from the source, and the only one in this belt.** The
operator ruled on 2026-08-22, with the render evidence in hand and the parity cost stated: continuo's
rendered report will differ from interlock's for any period containing an unfinished invocation, and
interlock#74 AC3 compares those documents. interlock is frozen, so no upstream fix is coming and
continuo is authoritative here. `parity/measurement.ac9.ledger.json` and
`parity/measurement.provenance.ledger.json` both record it as a divergence, so the AC3 reconciliation
can reach it from the ledger rather than discovering it as an unexplained difference.

**Alternatives.**

- **Reproduce the contradiction and disclose it (rejected on the operator's ruling).** It was this
  lane's recommendation and the precedent set for the shadow caveat and the provenance `ORDER BY`
  tie. It was rejected because those are omissions a reader can work around, while this is a
  published document asserting both `true` and `false` about the same claim -- the reader cannot
  work out which half to believe without reading the source of the tool.
- **Fold the count into `unbounded_missing` (rejected).** It fixes the predicate and breaks the
  field: a row with a recorded ceiling would be reported as having none.
- **Drop `supports_acceptance_claim` from the header (rejected).** It removes the contradiction by
  removing the answer, and section 2.4 requires the disqualification to be visible where the figures
  are.

**Falsified by.** interlock resuming and reconciling the two predicates upstream, at which point this
stops being a divergence and becomes a plain translation.
---

## D-0024 — The control_plane inherited-defect repairs, and what a failed COMMIT costs

**Context.** `D-0023` made inherited defects continuo's to fix. Six of them were carried by
`control_plane`, all raised by the review gate rather than by a failing test, and all disclosed in
the parity ledgers while `D-0022` was in force. They are repaired together, after the translation
belts, because four of them are about **where a transaction boundary falls** and reviewing that as
one change is very different from reviewing it spread across six.

**Decision.** All six are repaired, and each ledger entry moves from `inherited, disclosed` to a
deliberate divergence naming this entry.

1. **A failed `COMMIT` is rolled back.** SQLite leaves the transaction *active* when `COMMIT` fails
   -- `SQLITE_BUSY` from a concurrent reader is reachable under the rollback journal (`D-0012`).
   interlock lets the error out and drops its scope, so the next `transaction()` on that connection
   sees `inTransaction` and silently **joins the orphan**: its writes never commit and the locks stay
   held. Continuo rolls back and re-raises the **`COMMIT`'s own** error.
2. **The transaction scope is installed after `BEGIN IMMEDIATE` succeeds**, not before, so a failed
   `BEGIN` cannot leave `currentScope()` answering for a transaction that was never opened.
3. **`markSkipped` detects a duplicate before it writes.** interlock relies on the append raising and
   the transaction rolling back, which holds only while `markSkipped` *owns* the transaction. Joined
   to a caller's, the settle survived and the outer commit published a consumption marked `skipped`
   with no event explaining it.
4. **`closeGate` refuses if the gate advanced** between the payload's read and the transaction's
   reload, so the audit event and the gate row it describes cannot disagree.
5. **The outbox's no-op/stale classification runs in one transaction** with the protected write it
   classifies.
6. **The spike opener re-verifies the handle it returns.**

**What the first one costs, stated because it was chosen with the cost known.** `SQLITE_BUSY` is a
*retryable* failure: a caller that waited and committed again might have succeeded. Rolling back
throws that write away. The alternative considered was to leave the transaction open and **poison
the scope** so a later join fails loudly -- which preserves the retry but adds a new failure mode to
every caller of `transaction()`, including ones that have nothing to do with contention. Releasing
the locks and taking the loss was judged the better trade, because an orphaned transaction is
invisible at the point it is created and expensive everywhere afterwards. Recorded here so that
"why does this not retry?" has an answer that is not archaeology.

The earlier code carried a comment arguing *against* rolling back, on the grounds that it would
replace the `COMMIT`'s error with the `ROLLBACK`'s. That worry is answered by separating the two --
the rollback is attempted, and the commit's error is what propagates -- rather than by leaving the
transaction open. The comment is corrected in the same change; a comment that argues for the wrong
behaviour is worse than no comment, because the next reader takes it as the reason.

**One finding in the same set is NOT repaired here.** `enqueueRelay` validates only that its target
is a relayed stage, not that it follows the gate's current one, so a `forwarded` relay can be
enqueued and acked while the gate is still `received` and accepted later against an answer it
predates. Fixing it means deciding what `ADMISSIBLE`'s edges mean -- direct successor only, or
anything reachable -- which is a question about the design's own semantics rather than about the
port. It is escalated with an enumeration of the affected transitions rather than settled here.

**Alternatives.**

- **Repair them during the translation belts (rejected).** Four of the six are one subject, and
  mixing them into translations would have made each PR carry both "is this translation faithful?"
  and "is this concurrency design right?" -- two review questions with different reviewers and
  different evidence.
- **Repair only the two the gate called P1 (rejected).** The severity split is the reviewer's, not a
  property of the code, and it would leave the same defect class half-fixed.

**Consequences.**

- Five parity ledgers now carry deliberate divergences rather than disclosures. Parity is still
  established against interlock, so those entries are the trail `D-0023` requires: every place the
  two now differ on purpose is reachable from the ledger.
- Two pin tests are inverted, most visibly the spike opener's seam-liveness count, whose comment used
  to argue that verifying the returned handle would mean "verifying a file it had already opened for
  writing". `migrator.ts` had disproved that since the pilot.

**Falsifier.** If a caller is found that genuinely needs to retry a `SQLITE_BUSY` commit on the same
transaction, item 1's trade is wrong for that caller and the poisoned-scope alternative should be
revisited.

**Status.** accepted

**Source.** Operator decision, 2026-08-22, on lane A's design note; the six repairs and the
`enqueueRelay` escalation are that note's items.


## D-0108 -- An invariant a public constructor can walk around is repaired, not disclosed

**Context.** `D-0022` ruled that a defect reproduced faithfully from interlock, pinned by no case on
either side, and raised by review rather than by a failing test, is **disclosed** in the parity
ledger and repaired in a dedicated change after parity. The operator **withdrew that rule on
2026-08-22**: interlock is frozen, so "after parity, follow upstream" has no upstream to follow, and
every inherited defect will eventually have to be repaired here. The cheapest moment to repair one
is the belt already editing that file.

This entry is the measurement lane's first application of the withdrawal, covering three defects the
review gate raised across three belts and this lane disclosed under `D-0022`. All three were
verified against interlock at `65f36c5` before being recorded, and all three are now repaired.

**The first two share their shape with `D-0107`**, which is why they are settled together:

- `ShadowReference`'s constructor validates only the distribution for a present reference, so one
  built with a distribution and no `bothBucketCount` is accepted and the renderer emits `over null
  both-bucket episode(s)` -- a heading that announces a comparison and names no population.
- `classifyEpisodes` resolves a caller-declared `graceMs` and never validates it when the episode
  list is empty, because `requireGraceMs` runs inside `episodeWindow`. A report over zero episodes
  therefore carries `grace_ms = -1` and states it. The source's own docstring names the consequence:
  "on a report that classified no episodes, nothing would ever raise, so it would render clean."

In both, the invariant exists, the module's own API upholds it, and the **exported constructor walks
around it**. That is exactly `D-0107`'s finding -- an optional count defaulting to zero reintroduced
the contradiction that decision removed -- and the same answer applies: a type this package exports
is a public door, and an invariant that only the tidy path enforces is not an invariant.

The third is different in kind and is repaired for its own reason:

- `renderShadowReconciliation` prints `POSITIONAL_KEY_CAVEAT` only when an episode in the
  `unmatched_key` bucket is positional -- and that is the bucket where a positional episode is
  *least* likely to be the story. An escalation whose key composed and found no counterpart is filed
  `interlock_only` or `v1_only`, and a run of exactly those is what an ordering divergence looks
  like. The warning went missing precisely when the key was the first thing to doubt.

**Decision.** All three are repaired, and each is recorded in its ledger under `divergences` rather
than `inherited_limitations`, with the interlock behaviour it departs from, the evidence that
interlock behaves that way, and the target-only case that pins the new behaviour.

`requireGraceMs` is **called** a second time rather than copied: the same function, in
`classifyEpisodes`, after the grace is resolved. `require_grace_ms`'s own docstring argues against a
second copy of the check, and that argument is about a second *definition* of what a legal grace is,
not about a second call site.

**Alternatives.**

- **Keep disclosing (rejected -- this is the withdrawn `D-0022`).** It was the right rule while an
  upstream repair was possible to follow. With interlock frozen it means shipping a defect nobody
  will ever fix, in a package that is now the authority for this behaviour.
- **Repair the two constructors and leave the caveat (rejected).** The caveat's failure is the one a
  reader actually meets: the other two need a hand-built object, while an unpaired escalation is
  ordinary output. Fixing only what a reviewer typed first is how a rule becomes case-by-case.
- **Validate `graceMs` by duplicating the check in `classifyEpisodes` (rejected).** Two definitions
  of a legal grace drift; one function called twice does not.

**Consequences.** continuo refuses two inputs interlock accepts, and prints a caveat interlock omits.
Each is reachable from its ledger's `divergences` block, so the `interlock#74` AC3 reconciliation
finds a recorded decision rather than an unexplained difference. `D-0022` remains in this file as the
record of what was decided and when; its withdrawal is noted here rather than by editing it, because
it belongs to another lane.

**Falsified by.** interlock resuming. Every one of these would then be a bug report upstream, and
continuo would follow whatever interlock decided rather than keeping its own answer.
---

## D-0026 — A gate relay targets the stage the gate is about to enter

**Context.** `D-0024` repaired six inherited `control_plane` defects and deliberately left a seventh
open, because fixing it meant deciding what `ADMISSIBLE`'s edges mean rather than how to translate
them. This entry settles that one.

`enqueueRelay` checked only that its target was in `RELAYED_STAGES`. So a `forwarded` relay could be
put in front of a worker while the gate was still `received`, acked there, and then -- after the
ordinary `presented` and `answered` advances -- accepted by `advanceOnAck(toStage: "forwarded")`.
The gate would record the answer as forwarded on the strength of an acknowledgement of a payload
that **predates the answer it is supposed to carry**. interlock has the same gap.

**Decision.** A relay must target the stage the gate is **about to enter**: its `toStage` must be
reachable from the gate's *current* stage by one `advance` edge of `ADMISSIBLE`. The predecessor is
read off the table, not hardcoded, so the rule cannot drift from the state machine it is derived
from.

**Direct predecessor, not "anything reachable."** The reachable reading leaves the defect in place:
`received` reaches `forwarded`, which is the attack exactly. The two `RELAYED_STAGES` each have a
single direct predecessor (`presented` <- `received`, `forwarded` <- `answered`), so the rule is
total and unambiguous.

The `open` edge does not enter into it. Its target is `received`, which is not a relayed stage, so
`enqueueRelay` can never consult that row -- including or excluding it changes nothing.

**Decided on evidence rather than on principle**, and the evidence is worth recording because it is
the whole basis of the choice. Every `enqueueRelay` call site in interlock -- twelve, all in
`tests/control_plane/test_gates.py`, with no production caller at all, because the reconcile driver
does not exist -- enqueues at the direct predecessor. Eleven target `presented` immediately after the
gate is opened, at `received`; the twelfth targets `forwarded` and its helper advances the gate to
`answered` first. Enqueuing ahead appears nowhere. interlock is frozen, so those twelve are the
complete record of what the design intended.

> **This rule is a statement about how relays are used, not a claim that enqueuing ahead is
> inherently wrong.** If a later reconcile driver has a genuine reason to put a relay in front of a
> recipient before the gate reaches the stage it answers, the right response is to relax this
> deliberately -- widening the rule, saying why, and superseding this entry -- not to work around
> the refusal. The target-only test that pins it is the thing that will fail, and it is written to
> say so. A future designer should not be bound by a decision whose reasoning they cannot see.

**Alternatives.**

- **Anything reachable from the current stage (rejected).** Blocks nothing the direct-predecessor
  rule blocks, and leaves the defect that prompted the change.
- **Leave it inherited and disclosed (rejected).** That was `D-0022`'s answer, withdrawn by `D-0023`
  when interlock froze: no upstream fix is coming, so disclosure without repair is abandonment.
- **Validate in `advanceOnAck` instead of at enqueue time (considered).** It would catch the same
  stale ack one step later, but the outbox row and the message would already exist and a recipient
  may already have acted on them. Refusing at enqueue keeps the bad state from being created.

**The check runs only when a relay is CREATED**, never on the idempotent re-enqueue. That is not a
detail: `enqueueRelay` is idempotent so a Secretary killed after its commit can replay on recovery
and get back the id already in force rather than sending a human a second copy -- and the crash
window that matters is exactly the one that **moves the stage**. A replay arriving after
`advanceOnAck` committed finds the gate already at `toStage`, where the predecessor no longer holds.
A first draft of this decision checked before the existing-relay lookup and refused there, breaking
the recovery path the function exists to serve. Pinned by its own target-only test, confirmed by
mutation.

**Consequences.**

- The refusal is `InadmissibleTransitionRefused`, which is the family a caller already handles for a
  transition the table does not admit -- the relay's target is exactly that.
- The gates ledger entry moves from `inherited, disclosed` to a deliberate divergence naming this
  decision, keeping the trail `D-0023` requires.
- All 48 existing ported cases pass unchanged, which is the same evidence as the survey, arrived at
  from the other direction.

**Falsifier.** A caller that legitimately needs to enqueue a relay before the gate reaches the target
stage's predecessor. None exists today; if one appears, this decision is what should be revisited.

**Status.** accepted

**Source.** Operator decision, 2026-08-22, on lane A's survey of `ADMISSIBLE`'s advance edges and all
twelve `enqueue_relay` call sites.

