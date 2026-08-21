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
| D-0009 | Install with `--ignore-scripts`; the prebuilt binary is the artifact | accepted |
| D-0010 | Biome is the linter and formatter | accepted |
| D-0011 | Package-quality tooling: publint, attw, knip, Dependabot, editor pins | accepted |

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
