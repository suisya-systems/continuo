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
| D-0025 | An expensive, identical fixture is built once per test file and copied per case | accepted |
| D-0026 | A gate relay targets the stage the gate is about to enter | accepted |
| D-0027 | A converted control-plane fixture opens the template copy through the public entry point | accepted |
| D-0028 | The spike-schema template stops short of the cases whose subject is creation | accepted |
| D-0029 | The remaining two spike-schema files convert whole, and the CI cap is not the fix | accepted |
| D-0100 | The read-only capability is an open flag, not a `mode=ro` URI | accepted |
| D-0101 | Module-private names a source case reaches are exported and marked `@internal` | accepted |
| D-0102 | The read-only error classifier keeps only the result-code branch | accepted |
| D-0103 | A report snapshot refuses a deferred body rather than awaiting or draining it | accepted |
| D-0104 | Rendered figures match Python's formatter, pinned by an oracle | accepted |
| D-0105 | Maps keyed by database-supplied ids are `Map`, never plain objects | accepted |
| D-0106 | The measurement barrel stays as narrow as the invariant that guards it | accepted |
| D-0107 | The header's acceptance predicate counts both disqualifying populations | accepted |
| D-0108 | An invariant a public constructor can walk around is repaired, not disclosed | accepted |
| D-0109 | A renderer's ASCII claim covers the values it prints, not only the words it authors | accepted |
| D-0110 | The content fingerprint orders by storage class as well as by value | accepted |
| D-0111 | A fenced block's fence is widened past any backtick run its value holds | accepted |
| D-0112 | The CLI is parsed by a purpose-built parser, not by an argparse port | accepted |
| D-0113 | The cp932 help-text guarantee is asserted as ASCII, and on the bytes | accepted |
| D-0114 | The package walk is `import.meta.glob`, and the renderer the port adds is bound, not exempted | accepted |
| D-0115 | The write scan names better-sqlite3's whole SQL surface, and restores the pragma keyword | accepted |
| D-0116 | The statement trace names its issuer from the V8 call site, and folds the two languages' spellings | accepted |
| D-0117 | The catalogue's no-copy property is read off the syntax, because JavaScript has no string identity | accepted |
| D-0200 | CPython's `fnmatch`, `shlex` and path semantics are transcribed, and pinned by a differential vector | accepted |
| D-0201 | Wire-format keys stay verbatim; in-memory identifiers are camelCase | accepted |
| D-0203 | A `~user` path in a sandbox rule is refused, not passed through | accepted |
| D-0204 | The `PreToolUse` deny hook ships as hand-written JavaScript | accepted |
| D-0205 | The spawn precondition's wiring is asserted as a module-graph dependency | accepted |
| D-0206 | The fence ledger takes no cross-process lock, and interlock is a single writer | accepted |
| D-0207 | The hook's argv surface reproduces argparse's two passes, rather than being waived | accepted |
| D-0208 | The deny hook must be the program the hook command runs, not a string it mentions | accepted |
| D-0209 | `npm test` builds first, because the deny hook's dependencies come from `dist/` | accepted |
| D-0210 | A JSON number's Python spelling is recorded on its container slot, never inside the value | accepted |
| D-0211 | Every container rebuild carries the number record, and the sites are enumerated and pinned | accepted |
| D-0212 | The rebuild-site enumeration is audited mechanically, and the one site that does not carry states a proof | accepted |
| D-0213 | The settings generator is ported on a transcribed `os.path`, and its thirteen rebuild branches are enumerated and pinned | accepted |
| D-0214 | `sandbox doctor` and the readback complete the settings subsystem, and the argparse surface grows two actions rather than one helper | accepted |
| D-0215 | A truthy non-mapping `sandbox.filesystem` is refused, not coerced to the empty mapping | accepted |
| D-0216 | `_is_inside_root` compares normcased paths, so Windows path identity is not a sandbox escape | accepted |

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
ledger and repaired in a dedicated change after parity. The operator **withdrew that rule on 2026-08-22**, and lane A has since recorded the replacement as
`D-0023` (inherited defects are repaired in continuo, at the first belt that touches them): interlock is frozen, so "after parity, follow upstream" has no upstream to follow, and
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

- **Keep disclosing (rejected -- this is the withdrawn `D-0022`, now `D-0023`).** It was the right rule while an
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

## D-0204 — The `PreToolUse` deny hook ships as hand-written JavaScript

**Status.** accepted (2026-08-22)

**Context.** The deny hook is not imported; it is **launched as a subprocess by path**. Interlock's
`fencing/spawn.py` computes `default_hook_script()` as `Path(__file__).resolve().with_name("hook.py")`,
the rendered role document carries the command line
`{python} {hook_script} --role worker --fence {fence_path}`, and interlock's own hook tests run that
file as a child process and feed it a `PreToolUse` payload on stdin. Two things follow that a
TypeScript port cannot argue away:

- **The script token must name a real existing file.** `checkHookResolvable` in
  `src/fencing/renderer.ts` walks every surviving `shlex` token of the hook command and refuses with
  `hook-unresolvable` when a token ending in `.sh` / `.py` / `.mjs` / `.js` / `.cjs` is not a file on
  disk. A hook that exists only as a compiler input is a fence that refuses to render.
- **Node 22 cannot execute a `.ts` file**, and Node 22 is a required CI cell under `D-0003`
  (`engines.node` is `>=22.14.0 <23 || >=24.0.0 <25`; the matrix is 22 and 24 on ubuntu and
  windows). Measured on this machine, Node **v22.17.0**, 2026-08-22: running a `.ts` file inside
  this package raises `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"`. The
  same file runs only under `--experimental-strip-types`, which additionally prints an
  `ExperimentalWarning` on stderr -- and a hook whose stderr carries a warning banner is a hook
  whose transcript the CLI and the ported tests have to be taught to ignore.

So the artifact has to be a file Node runs directly, unflagged, from the source tree during
`npm test` and from `dist/` in an installed package.

**Decision.** The hook ships as **`src/fencing/hook.mjs`, hand-written JavaScript**, and that file
is the artifact -- copied into `dist/` rather than compiled into it, so the path
`default_hook_script()` computes resolves to the same content in both trees. This is a **deliberate
deviation** from the repository's TypeScript policy, taken for exactly one file and stated here so
nobody has to rediscover why it is not `.ts`. It is mitigated with JSDoc type annotations, which
give an editor and a reviewer the same shapes the rest of the port declares in TypeScript.

**Revisit when** Node's type stripping is stable and on by default in **every** required CI cell --
at that point the constraint above disappears and the hook can become TypeScript like everything
else. Tracked in `suisya-systems/continuo#18` with the other post-parity repairs (`D-0022`).

**Alternatives.**

- **`hook.ts` compiled, with a thin `.mjs` entry point that imports it (rejected -- it does not
  work).** The entry point has the same problem one level down: a `.mjs` cannot import a `.ts` at
  runtime either, so the entry would have to import from `dist/`, which is the third alternative
  below wearing a different hat.
- **Run the hook through a loader (`tsx`, `--import`) in the tests only (rejected).** It makes the
  suite exercise a launch path that exists **only for tests**: production would start
  `node hook.mjs` while the tests start `node --import tsx hook.ts`, and the fail-closed behaviour
  the cases pin would be pinned on the wrong process. That is the same shape `D-0014` rejected for
  parameter injection -- "the test would then exercise a path that exists for tests, and the case
  would no longer prove anything about what production does" -- and it is worse here, because the
  thing not being proven is the deny decision itself.
- **Point the hook path into `dist/` and build before testing (rejected).** `npm test` would stop
  working standalone: a clean checkout, or a source edit without a rebuild, would run the previous
  build's hook, and the failure mode of a stale fail-closed hook is a **stale deny set** that no
  assertion in the suite is looking at. It also makes the renderer's `hook-unresolvable` refusal
  depend on build state rather than on the tree.
- **Keep invoking interlock's `hook.py` through a Python interpreter (rejected).** It would make the
  TypeScript package depend on a Python runtime at spawn time, which is precisely the dependency the
  port exists to remove, and it would leave the port's own hook semantics untested.

**Consequence worth stating plainly.** The fail-closed core -- the one component whose job is to
deny a tool call when anything at all is wrong with its input -- is the single file in this port
without type checking. That **raises** the value of its differential and subprocess tests rather
than lowering it: with no compiler between the source and the deny decision, the tests that run the
real file as a real child process on real stdin bytes are the only thing standing behind it, so the
hook's cases are ported as subprocess cases and are not permitted to degrade into in-process
function calls.

**Falsified by.** Node shipping unflagged, non-experimental type stripping across the whole required
matrix of `D-0003`; or the hook ceasing to be launched by path (a CLI that loaded the hook in
process would remove the constraint entirely and, with it, this decision's reason to exist).

---

## D-0205 — The spawn precondition's wiring is asserted as a module-graph dependency

**Status.** accepted (2026-08-22)

**Context.** interlock#71's canary acceptance does not ask for a fail-closed spawn precondition to
**exist**; it asks for it to be **wired into the production spawn path**. `fencing/spawn.py` states
the obligation in its own module docstring, and the shape it names is negative:

> The shape that matters is negative: on a broken configuration the spawner callable is **never
> invoked**. Not invoked with a narrowed fence, not invoked with a warning logged -- not invoked. A
> downgraded spawn is the failure mode the criterion names, and it is the one a "best effort"
> renderer produces.

interlock#74 acceptance criterion 4 asks how that obligation is re-expressed once the host is an ESM
module graph rather than a Python package. It has to be re-expressed rather than translated, because
the Python original's wiring is not written down anywhere a test can read: `FencedSpawner.spawn`
calls `self._admit(role, ctx)` and only then `spawner(outcome.plan)`, and the fact that no other
code path reaches the spawner is a property of the module, not an assertion in the suite.

**The failure mode.** A precondition that exists as a function nobody's spawn code calls is not a
precondition; it is dead code with the shape of one. And a test that only calls the precondition
directly **cannot tell those two apart** -- it is green in both worlds. This is the same error
direction `D-0200` and `D-0203` name for the fence itself: the port denies less than interlock does,
no error is raised, and every test reports success. The way it arrives here is a refactor rather than
an input: someone adds a second way to start a child, or moves the render/battery step behind a flag,
and nothing in the suite notices that the fence stopped being a precondition.

**Decision.** Two obligations, and the second is the one that is new.

1. **The production spawn path imports and calls the precondition directly.** No registry, no
   configuration key, no "the caller is expected to call `admit` first". The module that starts a
   child is the module that imports the precondition, so the dependency is visible in the import
   graph and survives being read.
2. **A target-only test asserts that the dependency exists**, not merely that the precondition
   behaves correctly when called. Concretely, that test drives the **production** spawn entry point
   with a deliberately broken configuration -- one of the brokenness classes `spawn.py` enumerates:
   config deleted (`document-unreadable` / `role-absent`), hook path unresolvable
   (`hook-unresolvable`), sandbox profile absent (`sandbox-profile-absent`), or a fence whose own
   breach battery fails to deny every rule -- and asserts on the **injected spawner callable**: call
   count is exactly `0`. Not "called with a narrowed fence", not "called once and a warning logged"
   -- zero. The spawner is injected for this reason and no other, the same way `spawn.py` injects it
   ("`spawner` is injected so the precondition is testable without a real `claude -p` child"), and
   the injection point is a production parameter, not a test seam.
   The behavioural half is paired with a **static half**: a check that the production module's
   import graph actually reaches the precondition module, so that deleting the call and satisfying
   the behavioural assertion some other way (an early return, a duplicated inline check) is caught
   as the divergence it is.

These are **target-only** cases in the sense of `docs/test-translation-conventions.md`: they have no
interlock original, because in Python the obligation was carried by review and by the module's
docstring. They are recorded as target-only in this lane's parity ledger with this decision as their
justification, so a later reader does not mistake them for cases invented without provenance.

**What is actually in the tree at the time of writing.** `src/fencing/spawn.ts` does **not exist
yet** -- PR 1 shipped `rules.ts`, `renderer.ts`, `battery.ts`, `roles.json` and the CPython
transcription layer, and the spawn port is a later PR in this lane. This entry is therefore written
as the constraint that port must satisfy, taken from `spawn.py` as read on 2026-08-22, and not as a
description of code already present. The pieces it depends on **are** present and were read: the
renderer already raises `hook-unresolvable` and the other `RefusalReason` codes the precondition
consumes. When `spawn.ts` lands, the two obligations above are its acceptance conditions, and the
PR that adds it names them.

**Alternatives.**

- **Assert only the precondition's own behaviour (rejected).** It is the test everybody writes and
  it cannot distinguish a wired precondition from dead code, which is the entire question interlock#71
  asked. It would let the port claim the canary acceptance while providing none of it.
- **Wire the precondition by an import-time side effect -- a module that registers itself when
  imported (rejected).** ESM has no faithful analogue of Python's module-level wiring: import order
  is determined by the graph rather than by execution, a tree-shaking bundler is entitled to drop a
  module imported only for its effects, and Vitest's module registry can re-evaluate a module
  between tests. Beyond fidelity it is simply worse to reason about -- "the fence is applied because
  something, somewhere, imported this file" is not a property a reviewer can check by reading the
  spawn path.
- **A lint rule forbidding direct calls to the child-starting API (rejected as the primary
  mechanism).** It constrains this repository's source only, says nothing at runtime, and is
  trivially silenced with an inline disable comment. It may be added later as a second line of
  defence; it cannot be the first.

**Falsified by.** The production spawn path gaining a **second entry point that does not route
through the precondition** -- at that moment the module-graph dependency stops being equivalent to
the obligation, and the assertion has to be restated over both entry points (or the second one
removed). Also by interlock replacing the injected-`spawner` shape with a different seam, which
would change what "the spawner was never invoked" is asserted against.

---

## D-0206 — The fence ledger takes no cross-process lock, and interlock is a single writer

**Status.** accepted (2026-08-22, operator decision)

**Context.** `FenceLedger.transaction` in `fencing/spawn.py` takes an exclusive `fcntl.flock` on a
`.lock` sibling of the ledger, and degrades to the in-process lock alone where `fcntl` is
unavailable -- the module imports it under `try` / `except ImportError` and sets it to `None`, which
is the Windows path. So interlock itself already ships two behaviours here, and the weaker of the
two is one it runs in production on a supported platform.

**Node has no `flock` in core, on any platform.** There is no equivalent to fall back to, only a
choice between a native dependency and doing without.

**Decision.** Take interlock's own `fcntl is None` branch on every platform: the ledger serialises
writers **within a process** and takes no cross-process lock. Interlock is documented as a single
writer to a given ledger path.

**What is lost, exactly.** Only this: two continuo processes publishing a fence to the **same path**
concurrently can interleave their publish-then-record sequences. Everything else is unchanged and
worth stating so nobody re-derives it under pressure:

- Each ledger **line** is still atomic -- it is a single `O_APPEND` write, and the kernel does not
  split those.
- Within one process nothing is lost at all: every call on this path is synchronous.
- Publication of the fence file itself is unaffected; it is a temp-sibling write plus `rename`, and
  `rename` is atomic independently of any of this.

**One visible artefact difference.** No `.lock` file is created any more. A test that asserted on
the contents of the ledger's directory would see the difference; the parity ledger records it.

**Why a hand-written lockfile was rejected, which is the part that matters.** The obvious
substitute is an `O_EXCL` lockfile. It is worse than the gap it closes, and the asymmetry is not
close:

> `flock` is released by the **kernel** when the holder dies. An `O_EXCL` lockfile is not. A single
> `SIGKILL`ed spawner therefore leaves a stale lock that blocks every later process indefinitely --
> and the operation it blocks is **the recording of a refusal**, which `spawn.py` states must never
> wait.

Trading a narrow concurrency window for a permanent deadlock on the fail-closed path inverts the
subsystem's whole polarity. A lease with a timeout would reintroduce the window it was meant to
close, plus a clock dependency and a new way to be wrong.

**Alternatives.**

- **Add a native `flock` binding (rejected).** It would restore the guarantee exactly, and this is
  the option to revisit if multi-process publication ever becomes real. It was rejected now because
  it buys a guarantee nothing in the port currently needs, at the cost of a second native dependency
  on a package that has deliberately kept to one (`D-0003`, `D-0009`) -- and a native module is
  precisely the kind of dependency that turns "install" into a support surface across the Windows
  and Node cells this project treats as required.
- **A hand-written lockfile (rejected).** See above; it converts a window into a deadlock.
- **Serialise through a database row (not considered seriously).** The fence ledger is a JSONL file
  on purpose: it has to be readable and appendable when the control plane is exactly what is
  unavailable.

**Falsified by.** Interlock gaining a real multi-process publication path to one ledger, or continuo
growing one -- at which point the native binding is the option to reopen, not the lockfile. Tracked
with the port's other deferred items in suisya-systems/continuo#18.

---

## D-0207 — The hook's argv surface reproduces argparse's two passes, rather than being waived

**Status.** accepted (2026-08-22)

**Context.** `src/fencing/hook.mjs`'s first version parsed its command line in a single eager sweep:
walk the tokens left to right, act on each one as it is met, stop at the first thing that does not
fit. CPython's `argparse` does not work that way. It runs **two passes** -- `_parse_optional`
classifies every token first, deciding per token whether it is an option, a value, or the `--`
end-of-options marker, and only then does `_parse_known_args` consume options and their arguments --
and it reports leftovers at end-of-parse rather than at the point it met them. `-h`/`--help` is an
*action*, not a flag inspected up front, so it fires in positional order.

Those are not stylistic differences; they change the answer. A differential over **900 random one-to
three-token argv vectors**, drawn from a realistic alphabet (`-h`, `--help`, `--`, `--=`, `--fence`,
`--fen`, `--role`, `-x`, `-1`, `-1.5`, a real fence path, junk, and empty strings), found **123
exit-code divergences (13.7%)** against CPython 3.12.3's `argparse`. **14 of them were fail-open** --
the port exiting 0 where interlock exits 2 -- and all 14 had one shape, a help token ahead of an
ambiguous `--...=` token:

```
interlock-fence-hook -h  --=     interlock rc=2 (ambiguous option)   port rc=0   FAIL-OPEN
interlock-fence-hook -x  --help  interlock rc=0 (help)               port rc=2   fail-closed
```

argparse rejects `-h --=` because `--=` is classified -- and found to be an ambiguous abbreviation of
`--help`, `--fence` and `--role` -- before `-h` ever runs. The single-pass port ran `-h` first,
printed help, and exited 0. For this file exit 0 means *no opinion*, which the CLI reads as "carry
on": a hook that exits 0 permitted the call.

**Decision.** `parseArguments` is rewritten as argparse's own structure rather than as an
approximation of its results. It classifies every token (`_parse_optional`, including
`_get_option_tuples` prefix matching and the ambiguity report), then consumes (`consume_optional`,
`_match_argument`), then reports missing required actions and **all** extras at end-of-parse. `--`
is modelled. `-h`/`--help` fires as an action in positional order. The `--help` text, the `usage:`
line, the `expected one argument` wording, prefix abbreviation, the `--fence=VALUE` inline form and
the `_negative_number_matcher` transcription are unchanged and still byte-verified.

The reasoning that decided this against waiving the surface, stated so it is not re-argued:

- **A single remaining fail-open instance removes the justification for waiving the argv surface.**
  A waiver is a claim that the divergences are cosmetic. One vector on which the port permits a call
  interlock blocks is not cosmetic, and it is not made cosmetic by the other 886 agreeing. The
  measurement that would have supported a waiver is the one that refuted it.
- **The hook is a shipped artifact, and the argv shapes the current renderer emits are not an upper
  bound on reachability.** `hook.mjs` is installed, named by path in a rendered `roles.json`, and
  launched as a process. A later caller, an operator running it by hand to see what it says, a
  changed renderer, a CLI that re-quotes the command line -- each reaches this parser with argv the
  renderer never emits. Pinning today's production shape pins the one case that was never in doubt.
- **This file's contract is that no path reaches the interpreter's own error handling.** The source
  says so in its own header, and the port carries it: the import guard, the catch-all in `main`, the
  `uncaughtException` and `unhandledRejection` handlers all exist to keep exit 1 -- the status
  interlock's A6 measured being *absorbed* by the CLI -- unreachable. An argv surface exempted from
  that contract would be inconsistent with the rest of the module: the parser is the first thing the
  process runs, and it is the one place a divergence decides the exit status by itself, with no fence
  read and no decision to fall back on.

**Alternatives.**

- **Waive the argv surface: port only the argv cases interlock's own tests exercise, and add a
  target-only test pinning the production argv shape (rejected).** It is cheaper and it is the shape
  a waiver normally takes -- but it trades away the only property this file exists to have. It
  answers "does the hook parse what the renderer emits", which was never the question; the question
  is what the hook does with argv nobody predicted, and the answer under a waiver is "whatever the
  single-pass sweep happens to do", which the differential showed is sometimes exit 0. It also puts
  the waiver in the worst possible place: a fail-open in the deny hook is invisible, because the
  evidence of a working fence is that the forbidden operation did not happen, and nothing downstream
  is allowed to read the exit status as a health check.
- **Keep the single pass and special-case the 14 measured vectors (rejected).** It fixes the sample,
  not the parser. The 14 are what one seed found in a 900-vector sample of a three-token space; the
  next reader of this file has no way to tell which of the remaining shapes are still wrong.
- **Depend on a third-party argparse-compatible parser (rejected).** It moves a fail-closed decision
  into a dependency whose version can change under the fence, and `hook.mjs` deliberately loads
  nothing outside its own directory layout (see the module header: an environment variable naming the
  code the fence runs would be a fence bypass). The parser is ~200 lines of transcription; the
  dependency is a supply chain.

**Verified by.** Re-running the differential after the rewrite: 900 vectors, **0 exit-code
divergences, 0 fail-open, 900/900 stderr byte-equal, 900/900 stdout byte-equal, exit 1 never
occurred**. Widened to all 1,332 one- and two-token combinations of a 36-token alphabet plus 4,000
random three-to-four-token vectors (5,332 total): 0 divergences, 100% stderr byte-equality. At
process level, 576 distinct argv vectors run as real child processes of the built hook produced only
exit 0 and exit 2, and every exit 0 was the help print.

**Falsified by.** CPython changing `argparse`'s classification order or its message text -- the
port's oracle is CPython 3.12.3, and the transcription is of that version's `_parse_known_args`,
`_parse_optional`, `_get_option_tuples` and `_match_argument`. Also falsified if the hook stops being
launched by path with a caller-controlled command line, at which point the argv surface stops being
reachable and this decision stops having a subject.

---

## D-0208 — The deny hook must be the program the hook command runs, not a string it mentions

**Status.** accepted (2026-08-22)

**Context.** The renderer decides whether a `PreToolUse` hook command invokes interlock's deny hook,
and everything the fence is worth rests on that decision: only a command classified as *invoking* is
checked for `--fence` and `--role`, and only a role with at least one such command renders at all.
Interlock decides it with a substring test (`renderer.py:412`):

```python
if str(ctx.hook_script) in hook["command"]:
```

A command that merely **mentions** the hook path therefore passes. Measured against interlock at
`65f36c5` rather than reasoned about -- driving `render_fence` with

```
/bin/echo {hook_script} --role worker --fence {fence_path}
```

returns a fence of **17 rules**. Every other check agrees: `_check_command_resolves` finds
`/bin/echo` on PATH and finds the script token on disk, `_check_invocation` finds `--fence` and
`--role` carrying exactly the right values, and the matcher is universal. The CLI then runs `echo`,
the deny hook never executes, and the render succeeds -- a session that believes it is fenced and is
not. It is the fail-open shape `D-0204` and `D-0207` are otherwise built to keep unreachable, one
layer earlier: no wrong decision is made, because no decision is made at all. Continuo reproduced it
faithfully during the port, and the same 17-rule render was measured here before this change.

**Decision.** A hook command invokes the deny hook only if the hook script is the program that
actually runs. The command is tokenised with `split()` from `src/fencing/shlex.js` -- the CPython
transcription pinned by the `D-0200` differential vector, not a hand-rolled splitter, because a
mis-parsed token boundary would move this decision -- and the hook script must be

**argv[1], with argv[0] equal to `ctx.python`** -- the interpreter the renderer itself recorded,
which is exactly what the shipped `{python} {hook_script} ...` renders to. That is the only accepted
shape; there is no second one.

**Position alone is not sufficient, and that is the crux of the entry.** The command

```
true /path/hook.mjs --fence X --role worker
```

places the hook at argv[1], exactly where the real command places it, and would satisfy a naive
position check -- `true` resolves on PATH just as `echo` does, and exits 0 having run nothing. It is
the `argv[0] === ctx.python` half that rejects it. A repair that checked only the argv position would
have looked correct, passed a test written against the `echo` shape, and left the hole open.

A command that does not tokenise is not treated as invoking the hook, and the render still refuses:
`checkCommandResolves` raises `rule-syntax` on the same string, and with no invoking hook left
`hook-absent` follows.

**Amended 2026-08-22, before this decision shipped: the hook at argv[0] is no longer accepted.**
This entry originally admitted a second shape -- the hook script at argv[0], "a directly executable
hook, run by the kernel through its shebang". **That branch was a hole on Windows**, and it was a
hole this port invented: interlock decides the question with a substring test and has no notion of
argv positions at all. The shipped `src/fencing/hook.mjs` has **no shebang** and is mode **0644**.
On POSIX the branch is masked -- `checkCommandResolves` tests the launcher with `access(X_OK)` and
refuses it `hook-unresolvable` -- but **on Windows `X_OK` is only an existence check** (Windows has
no executable bit), so there the render **succeeded**. `cmd` cannot execute a `.mjs` directly, so
the deny hook then failed to launch and **the child ran unfenced with the spawn recorded as
admitted**. Windows is a required CI cell (`D-0003`), so a check that is sound on one platform and
open on another is not a check.

Requiring the recorded interpreter is strictly tighter, closes the hole on every platform rather
than special-casing Windows, and **costs nothing**: all four roles in `src/fencing/roles.json`
render `{python} {hook_script} ...`, and interlock's own `hook.py` is likewise not executable, so
the argv[0] shape is one **nothing in this project or its source ever produces**. Validating it
properly instead -- shebang present *and* executable bit *and* not Windows -- was rejected: it would
keep a platform-conditional branch alive to accept a shape with no producer. Deployments that
genuinely need it are covered by the falsifier below.

**This is a deliberate divergence from interlock, and it is recorded as one.** The direction of the
difference is that **interlock renders a document continuo refuses**. Under `D-0023`, which superseded `D-0022` --
interlock is frozen, so no upstream fix will come and "disclose but do not repair" no longer has an
upstream to defer to -- an inherited defect is repaired here, continuo is authoritative, and the
parity ledger carries the difference as an intentional divergence rather than an inherited
limitation, so it stays traceable when parity is judged against interlock.
`parity/fencing.renderer.ledger.json` holds the reproduction and the 17-rule measurement.

**What a role document must now look like.** Every `PreToolUse` command that is meant to enforce the
fence must begin with the recorded interpreter followed by the hook: `{python} {hook_script} --role
<role> --fence {fence_path}`. A wrapper, a shell, a launcher, a bare hook path, or any other
program in front of the hook is refused with `hook-absent`, whatever else the command line says. The
**shipped `src/fencing/roles.json` is unaffected**: all four roles (`worker`, `curator`,
`dispatcher`, `secretary`) already use the `{python} {hook_script} ...` form, and all four still
render.

**Alternatives.**

- **Keep the substring test and disclose it (rejected).** That was the pre-freeze answer, and the
  premise it rested on -- that a repair belongs upstream, or in a change moving both sides together
  -- no longer exists. What remains is a documented fail-open in a fence.
- **Check the argv position only (rejected).** Refuted above by `true /path/hook.mjs ...`: it admits
  any launcher willing to ignore its arguments.
- **Compare a resolved/canonical path instead of the recorded string (rejected here).** It would
  additionally accept a symlink or a relative spelling of the same file, which sounds strictly
  better, but it makes the check depend on the filesystem at render time and diverges further from
  the source than the property requires. `FenceContext` already canonicalises `hookScript` through
  `str(Path(...))`, and the rendered command is built from that same string, so the equality holds
  for every command the renderer itself emits.

**Verified by.** Execution, not inspection. The 40 translated renderer cases (39 collected; one
source case is not ported) were run before and after with every `FenceRefusal`'s codes printed:
**identical code sets, case for case** -- in particular
`test_a_hook_pointed_at_another_fence_refuses` still refuses with `hook-invocation-wrong` on the
`--fence` mismatch and does not fail earlier on the new check. Four target-only cases were added
(interlock has none, because interlock has the defect): the `/bin/echo` shape refuses with
`hook-absent`, the `true` shape refuses with `hook-absent`, the shipped `{python} {hook_script}`
shape still renders, and -- after the amendment -- an *executable* hook at argv[0] (mode 0755, so
the launcher check is satisfied on both platforms) refuses with exactly `{hook-absent}`. Reverting
the check to the substring test makes the decoy cases fail, and re-measures both shapes rendering 17
rules.

The amendment was re-measured the same way, on the same four shapes, with every refusal's codes
logged across all 45 renderer cases under one fixed order seed: the `echo` decoy refuses
`hook-absent` before and after, the `true` decoy refuses `hook-absent` before and after, the shipped
`{python} {hook_script}` shape renders 17 rules before and after, and the bare `{hook_script}` shape
at argv[0] moves from **renders 17 rules** to **refuses `hook-absent`** at mode 0755 (at the shipped
mode 0644 it moves from `hook-unresolvable` to `hook-absent, hook-unresolvable`). The full-suite
code log differs in **exactly one line** -- the added refusal from the rewritten target-only case.
**No ported case changed its refusal codes.**

**Falsified by.** A deployment where the deny hook legitimately has to run behind another program --
a sandbox launcher, a wrapper that sets an environment, `sudo` -- at which point the accepted shapes
must be widened deliberately, by naming the wrapper in the context, rather than by relaxing this back
to a substring.

**Generalisations this port adds are outside parity's reach.** The amendment above is one of two
instances from this pull request of a single shape: **a generalisation the port adds can open a hole
the source never had** -- and both were in code written to close a *different* hole. Instance A is
the argv[0] branch itself: repairing a genuine fail-open (the substring test) required knowing which
token is the program, and while implementing it a second shape, "a directly executable hook at
argv[0]", was accepted. Nothing produces that shape -- interlock has no notion of argv positions,
its `hook.py` is 0644 with no shebang, every shipped role renders `{python} {hook_script} ...` --
and on Windows it admitted an unfenced child. Instance B is the deny hook's chunked stdin read: the
fix for a real bug (a >64KB pipe read returning empty, because fd 0 is non-blocking by then and
`readFileSync` threw `EAGAIN`) had to accumulate chunks and decode once, and the decode reached for
was `Buffer.concat(chunks).toString("utf8")` -- **lossy**, substituting U+FFFD where Python's
`sys.stdin.read()` raises `UnicodeDecodeError` that the hook's bare `except` turns into a deny. The
repair thus introduced a fail-open on invalid UTF-8: an event carrying raw bytes (a filename on a
Linux filesystem is the realistic source) parsed, arrived with a **mangled** `tool_input`, and was
admitted where interlock denies. The correct idiom, `new TextDecoder("utf-8", { fatal: true })`,
already existed 300 lines away in `src/fencing/state.ts`, with a comment naming this exact hazard.

Such an addition -- an extra accepted shape, a new code path, a "more general" version of a check --
**cannot be judged by parity**: the source's suite cannot exercise it, the differential oracle has no
counterpart to compare it against, and the ledger has no node id for it. It is the only genuinely new
code in a parity port, and it needs the scrutiny new code gets, not the confidence the surrounding
translation has earned. Two questions catch both instances:

- **Who produces this shape?** If nothing in either codebase does, delete it rather than validate it.
  A branch with no producer cannot be exercised by any test that means anything.
- **Does an equivalent already exist in this repository?** Instance B's correct form was already
  written down. Reaching for the platform default instead of the local idiom is how a codebase grows
  two answers to one question, one of them wrong.

The corollary for review: **a fix is not finished when the original finding stops reproducing -- ask
what the fix itself now admits.**

---

## D-0209 — `npm test` builds first, because the deny hook's dependencies come from `dist/`

**Status.** accepted (2026-08-22)

**Context.** `D-0204` ships the `PreToolUse` deny hook as hand-written JavaScript so that Node can
launch it directly, and interlock's suite launches it **as a real subprocess** -- that is the only
way to observe the property the file exists for, which is what the hook does to a process's exit
status and stdout when it denies.

A subprocess is plain Node. It has no Vite, so its `import` of `./state.js` cannot be redirected to
`state.ts` the way an in-process test's can. The hook therefore resolves its three dependencies from
the **built** tree. In-process cases pass without a build and subprocess cases do not: with
`dist/fencing/state.js` moved aside, **9 of the deny hook's 21 cases fail**.

The failure is naturally silent, which is what makes this worth a decision rather than a one-line
script edit. A missing build makes the hook deny with `fence-unavailable` -- so every
`decision == "block"` assertion in the suite still passes. A suite can be fully green against a hook
that never read a fence.

**This looks like something `D-0204` already rejected, and the difference matters.** That entry
turned down "point the hook path into `dist/` and build before testing" for two reasons:

1. `npm test` would stop working standalone, and a **stale** build's hook would run -- a stale
   fail-closed hook is a stale deny set that no assertion is looking at;
2. the renderer's `hook-unresolvable` refusal would depend on build state rather than on the tree.

Reason 2 does not apply here: the hook's **path** stays in `src/fencing/hook.mjs`, so
`defaultHookScript()` and the renderer's file-existence check still answer about the source tree.
Only the hook's **dependencies** come from `dist/`, and only when it is launched as a real process.

Reason 1 is answered rather than ignored: the staleness it describes is a hazard of building
*sometimes*. Building **always**, as part of `test` itself, removes it -- there is no run in which
the hook's dependencies are older than the sources they were compiled from.

**Decision.** A `pretest` script runs `npm run build`. npm invokes it automatically before `test`,
so `npm test`, `npm run verify` and every CI cell get the built tree without any of them having to
remember. Measured cost: about **2.5 seconds**, warm or clean.

**Why not fix it in CI instead.** The repository's own workflow runs `npm run build` *after* both
`npm test` steps, so moving those lines would fix CI and leave every developer's local `npm test`
broken in the silent direction described above. A guarantee that lives in the workflow file is one a
local run does not get.

**Where this belongs in the wider picture.** This is one of three places in this port where the suite
was green while proving nothing; the three are written up together in
`docs/test-translation-conventions.md`, section 10 ("Make it fail on purpose, and confirm it fails for the reason you expect"), which also states the
check that catches the shape.

**Consequence for the other lanes.** `npm test` now costs ~2.5s more for everyone, including lanes
that never touch fencing. That is the price of the guarantee, and it is paid in the one place where
forgetting it is invisible.

**Alternatives.**

- **Build only the fencing subset on demand from inside the test (rejected).** A second, partial
  build path that has to be kept in step with the real one, and it would run per test file.
- **Assert the build exists and fail loudly instead of building (rejected as the whole answer, kept
  as a belt).** The suite does still fail with "run `npm run build` first" if the dependencies are
  missing -- a guard is cheaper to read than a mystery -- but a guard that only complains leaves
  every fresh checkout red on first run.
- **Give the hook a source-tree fallback (rejected).** It would have to load `.ts`, which is the
  thing `D-0204` established Node cannot do on a required cell.

**Falsified by.** Node gaining stable, default-on type stripping across every required cell, which
would let the hook be TypeScript and load its dependencies from source -- the same condition
`D-0204` records for revisiting, tracked in suisya-systems/continuo#18.

---

## D-0025 -- An expensive, identical fixture is built once per test file and copied per case

**Context.** Almost every ported case starts from the same thing: a production control plane
migrated to head. Creating one is not cheap, because the control plane runs with
`synchronous = FULL` (D-0012) and fsyncs on every commit. Measured on this worker's Linux box,
N=30: **87.5ms to create one, 0.97ms to copy an existing one -- about 90x.** Lane B measured the
same ratio on CI hardware (51ms against 0.5ms). The suite creates one in roughly 250 places, 227 of
them in `measurement` alone.

That cost is now a scheduling problem rather than an annoyance. The Windows cell hit the 20-minute
CI cap and PRs were being cancelled; the cap was raised to 40 minutes as first aid, and `main`
alone already sits at 15m31s -- 78% of the old cap -- with the port less than half done.

The obvious fix, migrating one database per file and copying it, was tried and failed: a template
built in a `caseRoot()` is removed when the case that built it finishes, so **236 cases failed with
`ENOENT`** on the second case onward. The missing piece was not the copy. It was that the testkit
had no temporary directory whose lifetime is longer than one case.

**Decision.** The testkit gains a second scope alongside `caseRoot()`, which is unchanged:

- `suiteRoot(label)` -- a temporary directory shared by every test in the **file**, removed when the
  file's tests finish.
- `suiteTemplate(filename, build)` -- the form callers actually want: `build` runs **once**, lazily,
  on the first `copyInto()`, and each case gets its own copy in its own `caseRoot()`.

Four properties are load-bearing.

*The scope is the file, not the run.* `isolate: true` gives each file its own worker, so a
file-scoped template never crosses a worker boundary, and D-0005's "no test shares filesystem state
with another" holds unchanged -- what is shared is build-once, read-only, and copied before use.

*The build is lazy and its outcome is memoized, failures included.* A file whose selected cases
never copy pays nothing, and a build that throws reports the same diagnosis to every later case
rather than re-running a known failure 25 times.

*The copy carries `<name>-*` sidecars.* The control plane uses the rollback journal and not WAL
(D-0012) and leaves no `-journal` / `-wal` / `-shm` behind once closed, so today this copies nothing
extra. It is written this way so that correctness does not **depend** on that: a template that did
leave a WAL, copied without it, would hand out a database quietly missing committed rows -- a silent
wrong answer, which is strictly worse than a loud failure. The rule is "do not depend on the count
being zero", not "the count is zero, so skip it".

*Both helpers must be called from the top level of the test file.* Two distinct ways of getting this
wrong were measured on Vitest 4.1.11, and both now throw. An `afterAll` registered from inside a
running test is accepted and then **never runs**, so the directory would silently outlive the run.
An `afterAll` registered inside a `describe` body binds to **that block**, so the directory is
removed when the block finishes -- while a sibling block, or a later top-level test, is still copying
from it. The second was raised by the review gate against an earlier draft whose own documentation
invited it, and was reproduced before being fixed: a `suiteRoot()` taken in one `describe` was
already gone by the time a second `describe` ran. Rejecting both is what makes the promised lifetime
true rather than usually true. The check is for a **parent collector**, not for a name: Vitest leaves
the file collector's name empty, and `describe("")` is legal and produces a nested collector with an
empty name too, so a name check would wave through the one shape most likely to be written by
accident -- a block whose title is parametrised and comes out empty. That escape was raised by the
review gate against the first version of the guard, and is now pinned by its own case.

**Alternatives.**

- **One template for the whole run, via `globalSetup` + `provide` (rejected).** It saves 19
  migrations rather than 250 -- about 1.6 seconds beyond what the file scope already gets, which is
  roughly 7% of the available win. In exchange it buys shared read-only state crossing worker
  boundaries, its own teardown, and Windows file-locking on a handle no test owns. The cost/benefit
  does not carry.
- **A template in a `caseRoot()` (rejected -- this is the failure being repaired).** Pinned as a
  negative control in `testkit.contract.test.ts`: two symmetric cases copy a case-scoped template,
  and an `afterAll` asserts that exactly one copied and exactly one saw `ENOENT`. Without it, the
  positive test would be measured against nothing.
- **Copy only the database file (rejected).** See the sidecar property above.
- **Move every lane's `productionDb()` in this PR (rejected).** Three lanes are porting in parallel
  into the same tree. The helper lands on its own, with one converted file as evidence that it
  works; each lane moves its own cases afterwards.

**Consequences.**

- `test/measurement/cohort.test.ts` is converted as the worked example: 25 migrations become 1.
  Same 26 cases, all green across four seeds; the file's test time falls from **1.38s to 0.36s**.
- Extrapolated over the roughly 250 creation sites, the suite stands to lose on the order of 20
  seconds of fsync per run per matrix cell, which is the point of the exercise on the Windows cell.
- `caseRoot()` keeps its exact semantics and every existing caller is untouched.
- The new contract is verified by deliberate breakage, not by being green: reverting the template to
  case scope fails with `ENOENT: ... copyfile ... template.sqlite3`; removing the sidecar copy fails
  the sidecar assertion; dropping the memoization fails `builds === 1`. All three were run.

**Falsifier.** If a case ever needs a template it may write to in place, or two files need to share
one build, the file scope is the wrong shape and the run-scoped alternative gets re-costed against
its failure modes rather than against its saving.

**Status.** accepted

**Source.** Task `continuo-testkit-suite-tmpdir`, 2026-08-22. Scope and naming ratified by the
window before implementation, on the measurement above.


## D-0109 -- A renderer's ASCII claim covers the values it prints, not only the words it authors

**Context.** Every renderer in the measurement harness carries the same sentence in its own
docstring: *ASCII only -- this reaches a cp932 console.* It was true of the words the renderer
authored. It was not true of the values it printed, and those are the ones that come from outside: a
run id, an action id, a repository path, an incident class, a fact state, the name a v1 adapter gives
itself, a query name used as a Markdown field.

Two failures follow, and the second is the one that matters:

- **The console.** One character outside cp932 turns the report into a `UnicodeEncodeError` on the
  terminal it is read from -- the exact failure the ASCII rule exists to prevent, arriving through
  the door the rule did not cover.
- **The structure.** A value containing a newline injects a line. Every itemisation in this harness
  prints `      <id>`, so an id spelling `a1\n      justified: 999` produces a line a reader cannot
  tell from one the harness wrote. `action.action_id`, `incident.fact_state` and the rest are
  unconstrained TEXT: nothing in the DDL says an id may not contain a newline.

`docs/cli-output-policy.md` puts this outside its own scope in terms -- it "governs what continuo
*authors*, not what it handles", and says a path that echoes external text "has to deal with encoding
on its own terms -- that problem is real, and it is not this policy". This entry is that path dealing
with it.

**Decision.** One helper, `reportValue` in `src/measurement/format.ts`: any character below `U+0020`
or from `U+007F` up becomes `\uXXXX`, exactly as `json.dumps(ensure_ascii=True)` escapes one.
Printable ASCII is untouched, so an ordinary report is unchanged character for character. Every
externally-supplied value a measurement renderer prints goes through it.

Applied to all seven merged renderers rather than to the three the review gate happened to name:
`false-termination`, `fixtures`, `shadow`, `canary`, `latency`, `ac9` and `provenance`'s Markdown.
A rule held by some renderers is not a property of the harness, and `render` composes all of them
into one document.

Not `pythonRepr`: that quotes the value, which is right for a refusal message where the reader needs
its boundaries, and wrong here, where the value sits after a label or in a table column and quotes
would change every line of every report.

**Alternatives.**

- **Reproduce and disclose (rejected -- and previously chosen).** The operator ruled exactly this way
  for the `action_id` case on 2026-08-22 under `D-0022`, and withdrew `D-0022` later the same day
  once interlock was confirmed frozen. With no upstream to follow, disclosure means shipping a
  line-forgery hole nobody will ever close.
- **Escape only the structural characters, leave non-ASCII (rejected).** It fixes the forgery and
  leaves the crash, and the crash is the one the docstrings already promise against.
- **Refuse a value that is not printable (rejected).** A report that refuses to render because a
  repository is named in Japanese is worse than one that renders it escaped; and the harness's job
  here is to report what it found.

**Consequences.** continuo's rendered reports differ from interlock's wherever a value is non-ASCII
or carries a control character -- in a direction that is legible rather than broken. Each affected
ledger records it under `divergences`.

**Falsified by.** interlock resuming and escaping these itself, at which point the two agree again.

## D-0110 -- The content fingerprint orders by storage class as well as by value

**Context.** `fingerprintDatabase` hashes a table's rows `ORDER BY` every column, and `feedValue`
tags each value with its storage class so that `1` and `'1'` cannot collide. Those two facts do not
compose: SQLite's `ORDER BY` compares INTEGER `1` and REAL `1.0` as **equal**, so two rows differing
only in storage class tie, and a tie is broken by whatever order the rows happen to come back in.

Two databases holding identical content therefore produce two digests -- which is precisely the claim
the field exists to make, and the one thing an aggregate fingerprint was rejected for failing to
support.

**Decision.** The ordering is every value column first, in the source's own order, and then every
column's `typeof()` as a tie-breaker: `ORDER BY "a", "b", typeof("a"), typeof("b")`. `typeof()`
then separates only rows the value comparison left completely equal, so no other digest moves.

Appended rather than interleaved, and the difference is not cosmetic. `ORDER BY "a", typeof("a"),
"b", ...` reorders rows that do not tie at all: `(INTEGER 1, 2)` and `(REAL 1.0, 1)` are separated
by the second column under the source's ordering, and interleaving sorts them by the first column's
storage class instead -- moving a digest that had no ambiguity in it. The first version of this
change interleaved; the review gate caught it.

Raised by the codex review gate on the provenance belt and disclosed there under `D-0022`; repaired
here on that rule's withdrawal.

**Alternatives.**

- **Disclose it (rejected -- and previously chosen).** The disclosure argued that a tie-breaker would
  move continuo's digests away from interlock's. It moves them only for tables containing such a
  tie, and for those the interlock digest is not a function of content in the first place -- so what
  parity would preserve is the agreement of two numbers that do not mean what the field says they
  mean.
- **Order by `rowid` instead (rejected).** Total, and wrong: a `VACUUM` renumbers rowids and changes
  nothing a report can read, so the digest would move for a change no reader can see.
- **Hash a canonical set of rows rather than a sequence (rejected).** It removes the ordering
  question entirely and costs the streaming read -- the digest would have to hold every row of the
  table before hashing any of it, which `ac9`'s cursor change deliberately avoided.

**A fourth term was asked for and is not there.** The review gate pointed out that REAL `0.0` and
`-0.0` are numerically equal, share `typeof() = 'real'`, and are untouched by `COLLATE BINARY`, so the
three terms would leave them in insertion order while `feedValue` hashes `'0.0'` and `'-0.0'` apart.
The pair is **unconstructible**: this SQLite normalises `-0.0` to `0.0` on the way in, measured rather
than assumed. A term that can never fire is a claim the code cannot keep, so the premise is pinned by
a target-only case instead -- a build that stopped normalising fails there rather than quietly
producing two digests for one content.

**Consequences.** A digest over a table holding a **complete-row** cross-storage-class tie differs
from interlock's. Every other digest is unchanged, which is what the appended form buys.

The over-reach the review caught is not distinguishable from outside without recomputing the hash --
the test file's own rule forbids that -- so the appended form is held by the ordering expression's
shape, by this entry, and by review, while the target-only case pins the property the divergence
exists for. Recorded in `parity/measurement.provenance.ledger.json` under `divergences`.

**Falsified by.** interlock adopting the same tie-breaker, or the schema gaining a constraint that
makes a mixed-storage-class column impossible.

---

## D-0027 -- A converted control-plane fixture opens the template copy through the public entry point


**Context.** D-0025 landed `suiteTemplate()` with one converted file as evidence and left each lane
to move its own cases. This is the control_plane lane doing that. Nine files qualify --
`ai-invocation`, `ci-ingest`, `events`, `gates`, `policy-seed`, `policy`, `production-schema`,
`repo-link`, `watcher` -- on three properties that make the template's single build the same fixture
every case was already getting: exactly one `createProductionControlPlane` call in the file, every
case on `nowMs: T0`, and no `migrationsDir` override. A fourth property decides the two that do not
convert: no case may assert about the database being **absent**, because a template hands out a
database that exists.

`migrator.test.ts` fails all four -- 39 calls, 12 assertions about `existsSync` and sidecars, three
clock values -- and it fails them for a reason that is not incidental: *creation itself* is what that
file tests, so a template would delete its subject. It keeps creating its own. `spike-schema.test.ts`
uses the spike `createControlPlane` and would want a template of its own; out of scope here.

The question this decision answers is the one D-0025 did not have to: `cohort.test.ts` hands its
cases a **path**, but every fixture in these nine hands back an **open connection** from
`createProductionControlPlane`. Copying a template does not produce a connection, so each converted
fixture has to open the copy, and how it opens it is a real choice.

**Decision.** The copy is opened with `openProductionControlPlane`, the module's public entry point
for an existing database, rather than with `openControlPlaneConnection` + `configureConnection`
directly.

The two spellings produce an identically configured handle -- both end at `configureConnection`, so
both carry `foreign_keys = ON` and `synchronous = FULL`, and neither sets a journal mode (D-0012).
What separates them is what happens when the template is wrong. `openProductionControlPlane`
verifies the file is at head before returning, so a template that built against the wrong schema, or
copied without a sidecar it needed, is a typed refusal at the first case. The direct spelling would
hand out the connection anyway and let the case fail somewhere downstream, or -- worse -- pass.

Measured on this worker's Linux box, N=30: **44.5ms to create a migrated control plane, 2.78ms to
copy one and open it through the public entry point, 1.34ms through the direct one.** The verification
costs about 1.4ms per case and buys the failure mode above; against the 41.7ms the copy saves, it is
not a trade worth making the other way. (The absolute create figure is lower than D-0025's 87.5ms
because that one was measured cold, on the first creation of the process; the steady-state figure is
the one a suite actually pays, and the ratio is what the decision turns on either way.)

Two smaller consequences of the same rule:

- **The template is the migrated schema and nothing else.** `watcher.test.ts` seeds a repository row
  and `ai-invocation.test.ts` a run and an incident; those stay in the per-case fixture. Every file's
  `suiteTemplate` declaration is therefore the same four lines, which is what makes it checkable by
  eye that nine files got the same fixture.
- **`events.test.ts` keeps `dbPathFixture()` alongside the new `productionDb()`.** One case hands the
  bare name to `rawConnection` and builds its own table in it; it wants a name where no file exists,
  not a control plane. Converting it would have been the absence-assertion mistake in miniature.
  `production-schema.test.ts` had no such case, so its `dbPathFixture` is gone.

**Alternatives.**

- **Open with `openControlPlaneConnection` + `configureConnection` (rejected).** 1.4ms per case
  cheaper and silent about a broken template. See above.
- **Put each file's seed rows into its template (rejected).** It would save a handful of INSERTs
  against making every file's template a different thing, which is the property that lets this
  migration be reviewed as one change rather than nine.
- **Convert `migrator.test.ts` too, with the absence cases left creating their own (rejected).** The
  file would then hold two ways of getting a database, distinguished by a property -- "does this case
  care that creation happened?" -- that a later case would have to re-derive to add itself correctly.

**Consequences.**

- 297 fixture call sites across the nine files are served by nine template builds. Case counts are
  unchanged, file by file: 31, 25, 58, 50, 35, 34, 45, 24, 31 before and after, and the
  `control_plane` suite stays at 605.
- The nine files' measured test time falls from **44.3s to 10.9s** in one run of the suite. No ledger
  changes, because nothing about what is ported changed.
- Behaviour preservation is what the review is against, not the speed: a moved number here would be a
  defect in the migration, and none moved.

**Falsifier.** A control_plane case that needs a clock other than `T0`, a `migrationsDir` override, or
a database that does not exist yet. Any of the three puts its file back on `createProductionControlPlane`
rather than bending the template to cover it.

**Status.** accepted

**Source.** Task `continuo-control-plane-productiondb`, 2026-08-28. Decision id allocated by the
window; recipe and file list from continuo issue 37.
---

## D-0210 — A JSON number's Python spelling is recorded on its container slot, never inside the value

**Status.** accepted (2026-08-22)

**Context.** JavaScript has one number type, and two things CPython knows about a JSON number were
gone by the time `JSON.parse` returned.

1. **int/float provenance.** `json.loads` gives `1` and `1.0` different types, so `json.dumps`
   re-emits them differently and `type(x).__name__` answers differently. The visible cost was one
   field: the fence ledger's `at`, which interlock fills from `time.time()` (always a `float`) and
   which this port wrote as `"at": 0` where interlock writes `"at": 0.0`. It was the ONLY field in
   which a continuo ledger line differed from interlock's for the same inputs. The same collapse
   made a refusal say `permissions.deny must be a list, got int` where interlock says `got float`,
   and that sentence is persisted in a ledger refusal detail.
2. **Exact integers past `2**53`.** `JSON.parse("9007199254740993")` is `9007199254740992`. The
   authored value is destroyed before any serialiser can see it.

Both reach artefacts that `D-0201` compares BY BYTES across a restart, so a role document carrying
either renders a fence that disagrees with interlock's bytes forever -- a permanent "the fence
changed" that no operator can clear.

**Decision.** `pyJsonLoads` already rescans the source text once, to recover the key order
`JSON.parse` destroys. That scan now also records, for every number it passes, how the source spelled
it: `int` or `float` by CPython's own rule from `json/scanner.py` (a `.`, an `e` or an `E` sends the
literal to `parse_float`), plus the literal text. The record hangs on the **container**, keyed by
property name or by array index, next to the key order and by the same mechanism -- a non-enumerable
`Symbol.for` property. `formatNumber` consults it to pick `int.__repr__` or `float.__repr__` and to
re-emit a big integer's own digits; `pyTypeNameOf(container, key)` consults it to answer `int` /
`float` per the DOCUMENT rather than per the JavaScript value; `FenceLedger.append` asserts
`PY_FLOAT` for the clock's value, which is built in code and has no document behind it.

**Why the container and not the value.** A number is a primitive. It has no identity to key a side
table by, so carrying the spelling *in the value* means a boxed `Number` or a `bigint` -- and that
breaks `===`, `typeof` and arithmetic for every ordinary number in the parsed tree. The tree is not
inert: `state.ts` decides whether a persisted fence is loadable with `payload.format == 1`, and
interlock accepts a fence whose `format` is `1.0` precisely because `1.0 == 1` in Python. A boxed
`1.0` would have made that fence unloadable, which is a behaviour change interlock does not have,
introduced by a repair for a spelling. The measured result stands: a `"format": 1.0` fence still
loads, and `parity/fencing.restart.ledger.json` says why that is deliberate rather than accidental.

**What it does not fix, stated narrowly so the claim stays true.**

- The **value** of an integer past `2**53` is still the rounded double. The exact digits are recovered
  for RE-EMISSION only, so such an integer round-trips unchanged and arithmetic on it is arithmetic
  on the rounded value. Out of scope rather than faked.
- A number at the **root** of a document has no container slot, so `pyJsonLoads("1.0")` still dumps
  as `1`. Every fencing artefact has an object at its root; the one reachable case is a corrupt
  ledger line, whose `'float' object is not subscriptable` reads `'int'` here.
- `pyStr` still renders an integral float as an int, visible only for a role document that spells
  `role_kind` or `permission_mode` as a number.
- A container rebuilt without carrying its spellings loses them, exactly as it would lose its key
  order, and nothing makes a site that forgets go red. **This entry shipped claiming the port's
  rebuild sites all carried the record, and naming three; there were four, and the fourth --
  `deepSortKeys` -- was the last call `settingsPayload` makes before the result becomes
  `fence.settings`. So the repair reached everything except `settings.local.json` and the persisted
  fence, which are the artefacts it was for.** `D-0211` repairs that, finds a fifth site
  (`settingsPayload` itself), pins both, and replaces the claim with the list of five and the
  obligation on any site added later. The corrected list lives in the header of
  `src/fencing/pyjson.ts`.

**Measured, not argued.** interlock's `FencedSpawner.spawn` and continuo's were driven to an
admission over the shipped role document with the same context paths, the same `python`, the same
hook file and the clock pinned to the same value. All three artefacts -- `fence-worker.json`,
`settings.local.json` and `fence-ledger.jsonl` -- compare EQUAL under `cmp`, at clocks `0.0`,
`1700000000.0`, `1700000000.5` and `1700000000.125`. With the `PY_FLOAT` assertion removed, the
ledger diverges again in exactly one place and the other two artefacts stay equal, which is the
control that says the repair is what closed it. The differential corpus gained
`pyjson.number_documents`: 32 documents covering both sides of `2**53`, a thirty-digit integer,
integral floats, every exponent spelling, `0` against `0.0`, `-0` against `-0.0`, duplicate keys and
nesting -- each asserted on its `loads -> dumps` bytes AND on `type(x).__name__` at every number.
With the spelling ignored, 16 of them fail.

**Alternatives.**

- **Box the divergent numbers only (rejected).** Narrower than boxing everything and still fatal:
  the values that need a spelling are exactly the ones a document supplies, which are exactly the
  ones the fence compares.
- **A `bigint` for integers past `2**53` (rejected).** It is exact and it is a primitive, but it puts
  a second numeric type into a tree that `pyRepr`, `pySet`, `pyIn` and every rule comparison walk,
  in exchange for arithmetic this subsystem never performs on such a value.
- **Hand-roll the whole loader so numbers never pass through `JSON.parse` (rejected).** `D-0200`'s
  reasoning applies unchanged: `JSON.parse` supplies every value, every string unescape and every
  parse error this port is pinned against, and trading that surface for one property is the wrong
  direction.

**Measured over the wrong corpus, and that is the lesson `D-0211` carries.** The measurement above
is sound and it is not sufficient: it drove the SHIPPED role document, which carries no number
anywhere in `env`, `permissions`, `sandbox` or `hooks`. Every artefact it compared was byte-equal
whether or not `deepSortKeys` carried the record, so the control it ran ("remove the assertion and
watch the ledger diverge") could only ever see the one field it had been built around. A
differential measurement is bounded by the inputs it is run over, and this one's inputs could not
express the property the repair was about.

**Falsified by.** A fencing artefact that needs a scalar at its root, or a role document that spells
`role_kind` as a number -- either would move an item out of the "not fixed" list above and into the
work.

---

## D-0211 — Every container rebuild carries the number record, and the sites are enumerated and pinned

**Status.** accepted (2026-08-28)

**Context.** `D-0210` records a JSON number's Python spelling on its CONTAINER SLOT, because a
number is a primitive with nothing to hang a record on. The cost of that choice is an obligation it
cannot enforce: a rebuilt container is a NEW container, its record starts empty, and a site that
forgets to carry the old one across loses every spelling under it. Nothing goes red. The values are
still numbers, every comparison still holds, and the only visible effect is bytes in a file that
`D-0201` compares across a restart.

That obligation was not met, and the entry said it was. `D-0210` shipped naming three rebuild sites
(`stripMeta`, `substitute`, `pyDict`) and claiming they were all of them. There was a fourth,
`deepSortKeys`, and it is the LAST call `settingsPayload` makes before the result becomes
`fence.settings` -- so the repair stopped one call short of `settings.local.json` and the persisted
fence, which are the two artefacts it was made for. Measured with `"env": {"A": 1.0, "B":
9007199254740993}`: interlock writes `1.0` and `9007199254740993`, continuo wrote `1` and
`9007199254740992`. The READBACK half was sound throughout; only the RENDER half diverged, which is
the direction that writes a wrong file.

Asking the same question of the call one level up found a **fifth** site: `settingsPayload` builds a
new object out of `rendered`, so a section whose value is a bare number (`"env": 1.0`) leaves its
spelling behind. A section is normally a mapping, whose record rides on the mapping object itself,
which is why no other shape reaches the gap and why nothing had noticed it.

The review gate then found a **sixth**, and it is the one that says why the enumeration has to be of
BRANCHES rather than of functions: `pyDict` was on the list and carries the record -- in its mapping
branch. Its other branch builds a mapping out of a SEQUENCE OF PAIRS, where each value arrives as
element 1 of a pair and its record is therefore on the pair, not on the container being built.
`dict([["x", 1.0]])` dumps `{"x": 1.0}` in CPython and dumped `{"x": 1}` here. `state.ts` writes the
persisted fence through `pyDict(fence.settings)`; the pair form is not reachable from
`FencedSpawner`, but `Fence`, `fenceToJson` and `writeFence` are exported, which is exactly where
`pyDict`'s own note says its divergences live. Counting functions is what let a carried function
hide an uncarried branch.

**A seventh divergence, from the same gate, in the other half of the mechanism.** `formatNumber`
checked NaN and the two infinities BEFORE consulting a recorded `int` spelling. A 400-digit integer
is legal JSON; `JSON.parse` makes it `Infinity`, CPython's `int` is arbitrary precision and re-emits
every digit. So this port wrote `Infinity` into `settings.local.json` for a value CPython writes in
full -- and `Infinity` is not legal JSON, so the artefact stopped being readable by anything but
CPython's own decoder, which is worse than a byte difference. The recorded spelling now outranks
every branch below it, guarded on `kind === "int"`: `1e400` is a `float` by CPython's own rule, both
sides overflow to infinity, and both must keep writing `Infinity`. Both directions are pinned in
`pyjson.number_documents`.

**Decision.** Three parts, and the third is the one that keeps the first two from recurring.

1. **Both sites carry the record.** `deepSortKeys` calls `carryNumberSpellings` on both branches --
   the mapped array and the sorted object -- and deliberately does NOT call `rememberKeyOrder`,
   because replacing the source order with a sorted one is the whole point of that rebuild.
   `settingsPayload` carries key by key instead, because one of its keys (`permissionMode`) does not
   come from the container it copies, and handing that key a spelling recorded for some role
   document's own `permissionMode` would be the stale-spelling trap described below.
2. **All of them are pinned, at the artefact.** Six target-only cases in
   `test/fencing/spawn-precondition.test.ts` drive `FencedSpawner.spawn` and assert on the BYTES of
   the written `settings.local.json` and the published fence. The document has to arrive as TEXT --
   serialised, patched, and read back through `loadDocument` -- because a spelling cannot be written
   in TypeScript at all: the literal `1.0` IS `1`, so a case that built the role body in code would
   carry no spelling into the document and would pass against the broken renderer. That is why the
   gap existed. The `formatNumber` ordering is pinned in the differential corpus instead
   (`pyjson.number_documents` gained the 400-digit integer, its negative, and `1e400` as the control
   that must not change), because that check runs against CPython on every cell. Every case was
   confirmed to fail, for the stated reason, with its repair reverted
   (`docs/test-translation-conventions.md` section 10).
3. **The claim is replaced by an enumeration plus an obligation.** The header of
   `src/fencing/pyjson.ts` now lists every rebuild BRANCH and says that a new one must carry the
   record AND be pinned. A normative record that overstates its own coverage is worse than one that
   states a narrow claim, because the reader who checks it stops looking -- and this entry's own
   first draft proves the point: it said five sites, and the sixth was inside a function already on
   the list.

**The measurement is a file now.** `D-0210`'s commit message claims 91,775 comparisons over 18,355
documents with no divergence. The harness that produced it was never committed, so when this lane
restarted the number could not be reproduced or re-run -- the only evidence left was the sentence
claiming it, which is the same failure mode as a normative comment that overstates its coverage.
`scripts/pyjson-roundtrip-sweep.mjs` is the replacement: it generates the product of 52 numeric
literals and six container shapes, asks CPython for the five spellings this subsystem persists or
asserts on (`dumps`, `dumps(sort_keys)`, `dumps(sort_keys, indent=2)`, `dumps(sort_keys,
separators)`, and `type(x).__name__` at every number), and compares. **No divergence over 5,616
documents / 28,080 comparisons**, re-run at this lane's tip. It stopped at thirty digits as first
written and so could not see the `formatNumber` ordering defect above; the overflow boundary and its
`1e400` control were added when review found it, which is the sweep earning its place as a file. It is deliberately not wired into
`npm run verify` or CI, for the reason `scripts/oracle/` is not either: the matrix cells have no
CPython, which is why a vector is committed instead. The durable check stays
`pyjson.number_documents` in `parity/oracle/fnmatch-shlex-corpus.json`, which runs on every cell.

Writing it hit the trap it was written to check: the walker used `Object.keys`, JavaScript hoisted
`"10"` in front of `"2"`, and the harness reported 48 divergences of its own making before `pyKeys`
replaced it. The same collapse `pyjson.ts` exists to close, met while building the check for it.

**An eighth: a serialiser's fallback answering a document's question.** `pyTypeName` classifies a
number with no recorded spelling, and D-0210 pointed that fallback at `pyNumberKind`. The two answer
different questions. `pyNumberKind` classifies a value BUILT IN CODE for a serialiser, where `-0` can
only have come from a Python float and a magnitude past `2**53` is already a claim about a rounded
value -- both float, correctly. `pyTypeName` is only ever handed a value that came from a DOCUMENT,
and the only shape that reaches it without a spelling is a number at the document ROOT, where the
question is which LITERAL CPython read. CPython's rule there is syntactic: no `.`, `e` or `E` is an
`int`, arbitrary precision, no negative zero. So the shared fallback reported `9007199254740992` and
`-0` as `float` where CPython says `int` -- a regression against `main`, in the sentence
`FenceLedger.refusals()` persists for a corrupt ledger line (`'float' object is not subscriptable`).
The fallback is now the document's rule, and the serialiser keeps its own.

What no value-derived rule can recover is stated rather than papered over: an integral float at a
ROOT (`1.0`, `1e16`) is the same double as the integer and reads `int` where CPython says `float`.
That is D-0210's root-slot boundary in its type-name half, and it is now asserted in BOTH directions
-- the deviation at the root AND the correct answer for the same document inside a container -- so a
future repair that closes it fails the case instead of silently outgrowing the disclosure.

**A ninth, and the only one on the live spawn path.** `FenceLedger.append` builds its entry as
`{event, at, ...payload}`. A SPREAD is a rebuild like any other, and this one is reached by every
admission and every refusal continuo records. Without the carry, a caller handing it a
document-derived payload got the numbers re-spelled by JavaScript:
`{"at": 1.0, "big": 9007199254740993}` was written as `{"at": 1, "big": 9007199254740992.0}` -- the
exact defect D-0210 was opened for, in the exact artefact it was opened about, one call away from
the assertion that closed it. The record is built as ONE map rather than as a carry followed by the
`PY_FLOAT` assertion, because `rememberNumberSpellings` REPLACES the record: asserting `at` after
carrying the payload would have dropped everything carried. The `PY_FLOAT` assertion still applies
only when the caller supplied no `at` of its own.

That makes nine instances across three review rounds, every one of them the same shape -- a
container rebuilt without its record -- and every one invisible to the suite before it was pinned.
The generalisation is in the header of `src/fencing/pyjson.ts` and it is the durable part of this
entry: the mechanism's cost is a standing obligation, the obligation has no runtime enforcement, and
so the enumeration and the pins are the enforcement.

**A safety claim that described an armed trap as disarmed.** `carryNumberSpellings` said entries
whose value the rebuild REPLACED are harmless "because a spelling is only consulted for a value that
is still a number". A replacement number IS still a number: the function carries the whole record
keyed by NAME, with no check that the value under each name is the one whose spelling was recorded,
so loading `{"x": 1.0}` and rebuilding with `x = 2` dumps `2.0` where CPython dumps `2`. No site in
this port replaces a number, so nothing reaches it today -- which is precisely why the comment is
the only thing standing between it and the next rebuild site. The comment now states the trap, names
the condition under which carrying the record wholesale is correct, and says what a site that
replaces values has to do instead.

**Alternatives.**

- **Record the spelling inside the value after all (rejected).** It removes the obligation by
  removing the container, and it is the alternative `D-0210` rejected for reasons that have not
  changed: a boxed `Number` or a `bigint` breaks `===`, `typeof` and arithmetic across a tree the
  fence's own comparisons walk. Trading a byte-level property for a comparison-level one is the
  wrong direction.
- **A runtime assertion that every rebuilt container carries a record (rejected).** Most rebuilds
  legitimately have nothing to carry, so the assertion would have to know which ones should -- which
  is the enumeration it was supposed to replace, written twice.
- **Leave `settingsPayload` and add a sixth bullet to the "not fixed" list (rejected).** It is a
  five-line carry with a case that pins it. Listing a defect one can fix, in the same edit that
  criticises an entry for overstating coverage, is the failure repeating itself in the other
  direction.

**Falsified by.** A rebuild site that has to REPLACE a number under a key it keeps -- the wholesale
carry is then wrong for that site, and the trap above stops being hypothetical.

---

## D-0111 -- A fenced block's fence is widened past any backtick run its value holds

**Context.** `renderMarkdown` prints a multi-line value as a fenced block rather than as a table
cell, because a cell cannot hold a newline and collapsing a query's SQL or a section's narrative into
one line would leave the Markdown reader with less than the JSON reader has. The fence is three
backticks, and interlock's is always three.

A fenced block is closed by a line of backticks **at least as long as the one that opened it**. A
value carrying a line of three backticks therefore ends its own block, and everything after it -- the
rest of that value, and every later block in the report -- is read as the report's own structure.
That is the same injection `D-0109` closed for table cells, one delimiter along, and it is reachable
the same way: a block's value is whatever the database or the caller supplied, and `ReportSection` is
a public export.

**The escape cannot close this one.** `D-0109`'s repair is `reportValue`, which escapes every
non-ASCII character and every C0 control. Applied to a whole block value it escapes the newlines too
and collapses the block back into the single line the block exists to avoid; applied line by line --
which is what this module does, and it is how the ASCII half of the hazard is closed here -- it
leaves the backtick alone, because a backtick is printable ASCII and escaping it would need a rule
`reportValue` does not have and that the JSON rendering would not share.

**Decision.** The fence is `max(3, longest run of backticks in the escaped value + 1)` backticks,
and the closing fence matches. A value holding no backticks -- which is every value an ordinary
report carries -- gets exactly the three the source emits, so no report interlock renders correctly
is rendered differently here.

**Alternatives.**

- **Escape the backtick as well (rejected).** It closes the hole and costs more: the escape would
  apply to every backtick in every value, including the ones in prose, and the JSON rendering has no
  equivalent, so one value would have two spellings across the two renderings of one document.
- **Indent the block by four spaces instead of fencing it (rejected).** It removes the fence and
  the language tag with it, and it changes every block in every report rather than the ones that
  need it.
- **Refuse a value carrying a fence (rejected).** The value is a measurement's own text. A report
  that refuses to print a fact because of a character in it is a worse artefact than one that prints
  it, and the refusal would fire in the middle of a report that already holds a SHARED lock.
- **Disclose it and leave the fence at three (rejected).** `D-0023`: interlock is frozen, so
  "disclose now, repair after parity" has no second half. The repair is four lines and its cost on a
  correct report is zero, which is a strictly better trade than a note in a ledger.

**Consequences.** A report whose values carry a backtick fence renders differently from interlock's,
which is the point: interlock's is truncated at that line. Recorded in
`parity/measurement.render.ledger.json` under `divergences`, with the parity cost stated.

The Markdown parser in `test/measurement/render.test.ts` reads the fence off the opening line rather
than assuming three, for the same reason -- a parser that looked for a literal ``` would stop at the
value's own text on exactly the report this exists for.

**Made to fail on purpose.** With the widening removed, the block parses back as `before` and the
target-only case goes red naming the truncation (conventions section 10: read the failure, not the
colour).

**Falsified by.** interlock adopting the same widening, or the block rendering being replaced by one
with no delimiter a value can spell.

---

## D-0028 -- The spike-schema template stops short of the cases whose subject is creation

**Context.** D-0027 converted the nine control_plane files that build a *production* control plane
and left `spike-schema.test.ts` explicitly out of scope: it is the one file in the lane that uses the
spike `createControlPlane`, so it needed a template of its own rather than a tenth copy of that
recipe. This is that template.

The file qualifies more cleanly than any of the nine did. `createControlPlane` takes a path and
nothing else -- no clock, no `migrationsDir`, no options at all -- so D-0027's first three properties
("one create call, every case on `T0`, no override") are not merely satisfied here, they are
unfalsifiable: every one of the 50 fixture calls in the file was already asking for a byte-identical
database. What is left to judge is only D-0027's fourth property, the one about a template handing
out a database that exists.

**Decision.** 46 of the 50 fixture call sites take a copy of one `suiteTemplate`, opened with
`openControlPlane`. Four keep calling `createControlPlane`, through a second fixture
(`createdControlPlane()`) that exists to be named at those call sites.

The four are not the ones D-0027's rule would have caught. No case in this file asserts that the
database is *absent* while also taking the fixture -- the three that assert absence (`an absent
database is refused and not created`, `the ddl is refused if the marking is removed`, `a creation
that cannot connect leaves no file behind`) build their own paths and never touched the fixture to
begin with. The four that
must keep creating split into two kinds, and only the first kind is what D-0027 meant by "creation
itself is what it tests":

- **`createControlPlane` is the act under test.** `creating over an existing path is refused` and
  `a creation that loses a race does not delete the winners database`. Both call `createControlPlane`
  as the statement being asserted about, and both need the database it refuses over to be one a
  creation put there. A copy would still make them pass, which is the problem: they would be passing
  about a situation their prose does not describe.
- **The assertion is one `openControlPlane` already makes.** `a created database is stamped so it can
  be recognised` asserts `application_id` and `user_version`; `the expected fingerprint is derived
  from the ddl not pinned beside it` asserts `schemaFingerprint(cp) == expectedSchemaFingerprint()`.
  `openControlPlane` verifies all three on the way in. Over a copy neither case could fail on its own
  assertion -- the fixture would have refused first -- so each would be reduced to a second report of
  a failure every other case in the file was already reporting.

That second kind is new. D-0027 did not meet it because `openProductionControlPlane` verifies a
*ledger head*, which no production case asserts directly; `openControlPlane` verifies the *stamps and
the schema shape*, which two spike cases assert exactly. It is the shape section 10 of
`docs/test-translation-conventions.md` is about, arriving from the fixture rather than from the
subject: green would still have been green, and red would still have been red, but the case would no
longer have been the thing deciding which.

Measured rather than argued. With the `application_id` stamp deleted from `createControlPlane`,
`a created database is stamped so it can be recognised` fails on its own assertion
(`expected +0 to be 1229736757`) rather than on the fixture -- which is the property the exclusion
buys, and it is only observable while the case still creates its own database.

**Decision, second half.** The template is opened with `openControlPlane` for D-0027's reason
unchanged: a template that built something that is not this schema becomes a typed refusal at the
first case rather than a case running against the wrong database. Both entry points end at
`configureConnection`, so the handle a converted case gets carries the same two pragmas it always
did.

**Measurement.** N=30 on this worker's Linux box, on the pinned prebuilt better-sqlite3 (D-0009):
**97.5ms to create a spike control plane, 2.70ms to copy one and open it, 0.33ms to copy it alone.**

The 97.5ms is worth recording because it is not where one would look for it. It is not the DDL: the
same schema against an in-memory database is 0.5ms, and the same creation with `synchronous = OFF` is
2.68ms. It is fsyncs -- the DDL runs at SQLite's own default of `synchronous = FULL`, before
`configureConnection` is reached -- so what the template removes is one durable commit per case, of a
file no case needs to be durable. That is also why `openControlPlane` is affordable here despite
doing strictly more work than `createControlPlane`: it opens four connections and builds the DDL
twice in memory to verify, and all of that together is 2.4ms against one fsync's 95ms.

**Alternatives.**

- **Convert all 50 (rejected).** It is faster by four creations, roughly 0.4s, and it costs the two
  pins above. The four exclusions are 8% of the file's fixture calls and the whole of its evidence
  that creation stamps what it claims to stamp.
- **Keep one fixture and pass a flag (rejected).** `controlPlane({ create: true })` reads as a
  performance switch at the call site. A separately named `createdControlPlane()` makes the call site
  say which property it depends on, which is the thing a later reader has to get right.
- **Give the two `openControlPlane`-verifies-it cases a `rawConnection` over the copy (rejected).**
  It would restore their ability to fail without a creation, but by asserting against a connection
  with none of the module's discipline -- so a stamp written by `createControlPlane` and a stamp
  written by nothing would look the same to them if the template were ever built another way.

**Consequences.**

- 46 fixture call sites are served by one template build; four creations remain, plus the eleven
  cases that build their own paths, or no database at all, and never used the fixture. The file's case count is unchanged at 65,
  and the suite's at 1363.
- The file's measured test time falls from **7.18s to 1.38s** on an idle box. The pair is
  load-sensitive -- re-measured while the other lanes were running, the same comparison is 6.0s to
  2.2s -- so the ratio is worth less than the per-case figures above; both halves of each pair were
  measured together.
- No ledger changes: nothing about what is ported changed, only what the fixture copies.
- The template's lazy build now runs inside whichever case copies first, which under a shuffled order
  is not a fixed case. That is sound here only because no case in this file patches a `schemaSeams`
  entry before taking its fixture -- every seam case takes its control plane first and patches
  afterwards -- so the template is never built through a replaced seam. Recorded at the declaration,
  because a new case that patched first would build the template through the patch and the failure
  would appear in a different case.

**Falsifier.** A spike-schema case that needs a database which does not exist yet, or that patches a
`schemaSeams` entry before taking its fixture. Either puts that case back on `createdControlPlane()`
rather than bending the template to cover it.

**Status.** accepted

**Source.** Task `continuo-spike-schema-template`, 2026-08-28. Decision id allocated by the window;
scope and exclusion from continuo issue 37.


## D-0029 -- The remaining two spike-schema files convert whole, and the CI cap is not the fix

**Context.** D-0028 migrated `spike-schema.test.ts` on the strength of issue 37's sentence that it
"uses the spike `createControlPlane` and would want a template of its own". That sentence turned out
to undercount. `spike-schema.test.ts` is not the only file building a *spike* control plane -- it is
one of three. `lease.test.ts` (40 fixture calls) and `outbox.test.ts` (50) build one exactly the same
way, and were invisible to issue 37's survey because that survey went looking for
`createProductionControlPlane` call sites and these files do not have any.

What forced the question was CI rather than the survey. PR 41 failed on the `windows-latest, node 22`
cell with a per-test timeout of 60s inside `lease.test.ts`, on a run where that one file took **401
seconds for 61 cases**. The failure is not a defect in D-0028's migration, and the evidence is
positive rather than an absence: the immediately preceding run of `main` alone failed the same way,
with the timeout landing on **`spike-schema.test.ts` itself** -- the file D-0028 had not yet
converted. The slow Windows cell blows the per-test cap on whichever control_plane file it happens to
be grinding through, which is the pace problem issue 37 records under "The Windows CI cells set the
pace". D-0028 moved that cell from 20m04s to 12m56s and relocated the timeout to the next-heaviest
file rather than removing it.

**Decision.** Both remaining files convert, and **every one of their 90 fixture call sites converts** --
there are no exclusions in either file. That is not an oversight of D-0028's two exclusion kinds; it
is that neither kind is present:

- **Nothing here has creation as its subject.** Each file contains exactly one `createControlPlane`
  call, in its own fixture. No case calls it as the act under test, so D-0028's first kind cannot
  arise.
- **Nothing here asserts what `openControlPlane` verifies.** Neither file mentions `application_id`,
  `user_version`, `SCHEMA_REVISION` or a schema fingerprint anywhere, so D-0028's second kind -- the
  assertion the opener would make vacuous -- has nothing to catch.
- **Nothing here patches `schemaSeams`.** D-0028's falsifier is a case that replaces a connect seam
  before taking its fixture, because the template's lazy build runs inside whichever case copies
  first. The three `patchSeam` calls across the two files replace `leaseSeams.uuid4Hex`,
  `outboxSeams.uuid4Hex` and `destinationSeams.uuid4Hex`. None is on the path the template builds
  through.

**The one assertion that looks like a disqualifier and is not.** `outbox.test.ts` contains
`expect(existsSync(dbPath)).toBe(false)`, which is exactly the shape D-0027's fourth property
excludes -- a case asserting the database is absent. Read in place, it sits on the line after that
case's own `unlinkSync(dbPath)`: it asserts *the deletion the case just performed*, on the way to
showing that the destination's dedup evidence survives the database being destroyed. It is an
assertion about absence, not an assertion that nothing was created, and the two are opposite in what
they require of a fixture. A grep for the exclusion rule finds it; reading it does not. Recorded
because the rule is applied by search, and this is the false positive that search produces.

**Measurement.** Per case, unchanged from D-0028 and re-confirmed: 97.5ms to create a spike control
plane against 2.70ms to copy and open one. Per file, on this Linux box: `lease.test.ts` **4.77s to
1.11s**, `outbox.test.ts` **6.39s to 1.80s**. The Linux figures understate what the change is for --
the cost removed is one fsync per case, and it is the Windows cells that pay for fsyncs.

Verified the same way D-0028 was, by making the template's build throw and reading which cases go
red: exactly **40 of 61** in `lease.test.ts` and exactly **50 of 76** in `outbox.test.ts`, matching
the fixture-call counts exactly. Wall-clock improvement alone would not have shown which call sites
actually moved.

**Alternatives.**

- **Re-run CI and hope (rejected).** It might have passed -- an earlier run of this same branch did.
  But the failure is a threshold effect on a cell that is already the slowest thing in the matrix, so
  a green re-run buys one PR and hands the same coin-flip to the next. Issue 37 states the position
  this decision is following: "The cap is not the fix -- the testkit template is."
- **Raise the per-test timeout above 60s (rejected).** It converts a failing signal into a slower
  passing one, and the number it would have to clear is unknown, because 401 seconds for 61 cases is
  a symptom whose magnitude depends on how loaded the runner is that morning.
- **Do the two files as a separate task (rejected by the window, and correctly).** It would have left
  PR 41 red, or green only by a re-run, while the change that makes it green sat in a queue behind it.
- **Put each file's seed rows in its template (rejected, D-0027's rule kept).** `lease.test.ts` seeds
  one run and `outbox.test.ts` a run and a lease. Those stay per-case, so all three spike files'
  template declarations are the same four lines and can be compared by eye.

**Consequences.**

- All three spike-schema files are now on the template: 46/50, 40/40 and 50/50 fixture call sites, for
  136 of 140. The four exceptions are D-0028's, and all four are in `spike-schema.test.ts`.
- Case counts are unchanged file by file -- 65, 61, 76 -- and `control_plane` stays at 605.
- No ledger changes. Nothing about what is ported changed, only what the fixture copies.
- The scope of PR 41 grew after review. The migration is the same recipe applied twice more with no
  exclusions, and the review that matters is the exclusion judgement, which is recorded above in full
  rather than left to the diff.

**Falsifier.** A case in either file that comes to need a database which does not exist yet, that
asserts a stamp or fingerprint `openControlPlane` already checks, or that patches a `schemaSeams`
entry before taking its fixture. Any of the three puts that case back on `createControlPlane`, the way
D-0028's four are.

**Status.** accepted

**Source.** Task `continuo-spike-schema-template`, 2026-08-28, after the PR 41 CI failure. Decision id
allocated by the window; scope extension approved by the user through the window.

---

---

## D-0212 — The rebuild-site enumeration is audited mechanically, and the one site that does not carry states a proof

**Status.** accepted (2026-08-28)

**Context.** `D-0211` closed six rebuild sites and then a seventh, one per review round, every one
the same shape: a container rebuilt without the number record `D-0210` hangs on its slots. Six
defects of one type, found one at a time, leaves a question the last fix cannot answer -- *is the
class exhausted, or is the enumeration simply as far as anyone has read?* Each round had found its
site by reading the previous round's list and asking what it missed, which is a method that cannot
terminate: it can only ever find what a reader thinks to look for.

So this entry did not read the list. It swept `src/fencing` mechanically for every construct that
builds a container (`{...x}`, `[...x]`, `Object.fromEntries`, `Object.assign`, `.map`, `.filter`,
`.sort`, `Array.from`), traced the three points where a spelling-bearing container can enter the
subsystem at all -- `loadDocument` (`renderer.ts`), `FenceLedger.events` (`spawn.ts`) and
`readFence` (`state.ts`), the only three `pyJsonLoads` call sites -- and classified every construct
reachable from them.

**Finding: no eighth defect, and two errors in the enumeration itself.**

1. **The header of `src/fencing/pyjson.ts` named six branches and omitted `FenceLedger.append`.**
   `D-0211`'s own body counts it as the seventh and its case comment calls it "the seventh branch
   this decision enumerates", and it is byte-pinned. Only the normative comment -- the one the
   header itself says is the enforcement -- was stale, because `append` was repaired in the last
   commit of that lane and the paragraph above it was not re-read. Corrected here.

2. **One rebuild branch had never been named at all: `pyIterate`'s array branch.** It returns
   `[...value]`, which drops the index-keyed record exactly as every other rebuild does. Measured:
   `pyJsonDumps` of the copy of `[1.0, 9007199254740993]` is `[1, 9007199254740992.0]`. CPython's
   `json.dumps(list(x))` is `[1.0, 9007199254740993]` and cannot be otherwise, because there the
   spelling lives in the VALUE and `list()` has nothing to lose. `pyIterate` is the transcription of
   Python's iteration, so it is precisely the site where the port's container-side representation
   parts company with Python's value-side one -- and it had been invisible for seven rounds because
   it does not look like a rebuild. It looks like a loop.

**Decision.** `pyIterate` keeps the drop, and the enumeration gains it with a proof rather than a
carry. Both halves matter and they are separate claims.

*Why it is not a defect today.* `pysemantics` is deliberately absent from the package surface
(`src/index.ts` states this, with its reasons), so its consumers are exactly the seven call sites in
this subsystem and that set is closed. Five end in `pyRepr`, `pyStr` or set membership; two are
`pyDict`'s own, which read each spelling off `items[index]` -- the ORIGINAL element, never the copy
-- because this exact drop is what `D-0211`'s sixth site was about. No result of any of the seven
reaches `pyJsonDumps` or `pyTypeNameOf`, so no artefact's bytes and no persisted type name depend on
the record `pyIterate` discards. This is the difference between `pyIterate` and `pyDict`, which
`D-0211` had to repair even though `FencedSpawner` never reaches its pair branch: `Fence`,
`fenceToJson` and `writeFence` ARE exported, and no call-site enumeration bounds a caller outside
this repository.

*Why carrying would be worse than not carrying.* `carryNumberSpellings` transfers an index-keyed
record wholesale, and an index-keyed record does not survive REORDERING. `renderer.ts` sorts a
`pyIterate` result (`pyIterate(allowed).map(pyStr).sort()`). Carrying there would hand element 0's
spelling to whatever sorted into position 0 -- the stale-record trap `carryNumberSpellings` warns
about, currently unreachable, and adding the carry is what would arm it. A carry is correct for a
rebuild that preserves its slots, and `pyIterate` exists to hand callers an array they may rearrange.

*What replaces the carry.* Three target-only cases, because a proof nothing checks is a sentence.
The first MEASURES the drop, so a future carry is a deliberate change and not a silent one. The
second and third pin the proof's two premises, and review moved both of them from checking a
SPELLING to checking the PROPERTY -- which is the same lesson as the enumeration itself, one level
down:

- *The consumer set.* Counted per file, over the directory WALKED RECURSIVELY at run time rather
  than over a list of file names, and over every REFERENCE to the identifier rather than over
  occurrences of the text `pyIterate(` -- because `const it = pyIterate; it(v)` and
  `xs.map(pyIterate)` are consumers that a call-spelling scan never sees, and a `src/fencing/helpers/`
  that does not exist today is one directory away from a consumer a flat scan never reads. Comments
  are stripped first, so a typo fix in prose cannot fire a case that would then be turned off rather
  than read.
- *The package surface.* Asserted by IDENTITY against the entry module's actual exported values, not
  by grepping `src/index.ts` for a `from` string: a re-export through some other barrel, or under a
  renamed binding, reaches a caller just as well and mentions nothing. Whatever route it takes it
  arrives as the same function object. Collected one level THROUGH namespace objects, because
  `export * as semantics from "./fencing/pysemantics.js"` puts one object on the surface and every
  function behind it. The manifest's `exports` map is asserted WHOLE rather than by its keys, since a
  new condition under the existing `"."` publishes a second target without adding a subpath.

*What these two cases are, and are not.* They are TRIPWIRES on the premises, not a decision
procedure for reachability. A source scan cannot be exhaustive -- `eval`, a dynamic `import()`, a
build step that emits a new entry point, all pass it -- and an entry-point identity check sees the
surface as it is built today. What they are for is making the premises LOUD: the realistic ways this
proof stops holding are someone adding a call site or exporting the module, and both now turn a
suite red rather than passing unnoticed. Stated here because the alternative reading -- that these
cases prove unreachability -- is exactly the overstated-coverage failure `D-0211` was written about,
and it would be an odd entry that repeated it while correcting it. Three review rounds, each naming
a different escape route (an unlisted file, an aliased reference, a nested directory, a renamed
re-export, a namespace re-export, an export condition), are the evidence for the modesty rather than
against it: the guards got stronger each round and the class of escapes did not close.

Each case was confirmed to fail, alone and for its stated reason, with its premise broken. Adding
the carry fails the first and NOTHING ELSE, which is itself the corroboration that the drop is
unobservable. Three vectors fail the second: a reference in a file the sweep had not named, an
aliased reference carrying no call spelling, and a reference under a nested directory. Three fail
the third: a barrel re-export under a new name, an `export * as` namespace re-export, and a
`package.json` export target -- both a new subpath and a new condition under the existing one.

**What this entry can and cannot claim.** It can claim the sweep was mechanical and its scope
closed: `src/fencing` imports nothing outside itself and only `src/index.ts` re-exports it, and that
re-export is pure, so no `pyJsonLoads` container can reach `control_plane` or `measurement` at all.
It cannot claim there will never be a tenth branch -- it can only claim that the ninth was found by
grep rather than by reading, and that the list it produced is falsifiable in the way the previous
three were not.

**An adjacent class this audit did NOT close, named so it is not mistaken for covered.** `pyRepr`
never consults a spelling, at any call site. `D-0211` fixed the READ half for `pyTypeName` by adding
`pyTypeNameOf(container, key)`; `pyRepr` has no such form. So a document-derived `1.0` reaching a
refusal detail prints `1` where CPython prints `1.0` -- measured against CPython 3.12.3 at, among
others, `allow entry not a string:` (`renderer.ts`), `forbidden_allow_regex entry ... is not a valid
regex:` (`renderer.ts`) and `persisted rule field ... must be a non-empty string, got` (`state.ts`),
all of which are persisted in ledger refusal details. At several of them the container IS in scope,
so the form exists to fix it. This is the same family as the `pyStr` residue already disclosed in
`pysemantics.ts` and in this lane's parity ledger, and it is a READ-site gap rather than a
rebuild-site one, so it is out of this entry's scope and is recorded rather than repaired in
passing. **One correction to that disclosure belongs here**, because this audit falsified it: the
`pyStr` note calls its residue "REDUCIBLE ... since the document's spelling is recoverable". At
`renderer.ts`'s permission-mode call site it is NOT recoverable, because `pyIterate` has already
dropped the record before `pyStr` is reached. Threading a container and a key through the six call
sites, which is what that note proposes, would not close that one.

**Alternatives.**

- **Carry in `pyIterate` for uniformity (rejected).** The reordering hazard above; and a carry no
  consumer reads is an unpinnable claim, which is the thing `D-0211` spent three rounds learning to
  distrust.
- **Say nothing, since nothing is broken (rejected).** The header states a CLOSED list ("the sites
  in this port are"). A closed list that omits a site is false, and `D-0211`'s own finding is that a
  normative record which overstates its coverage is worse than one that states a narrow claim,
  because the reader who checks it stops looking. Two of the three previous undercounts were found
  by someone reading that paragraph and trusting it.
- **A lint rule forbidding uncarried rebuilds (rejected, again).** `D-0211` rejected the runtime
  form; the static form fails for the same reason plus one more. Most rebuilds legitimately have
  nothing to carry, so the rule needs the enumeration it was meant to replace -- and it would flag
  `pyIterate`, where not carrying is the correct answer.

**Falsified by.** `pysemantics` reaching the package surface, or an eighth `pyIterate` call site
whose result reaches a serialiser or a type name. Both are pinned, so either falsification is a red
suite rather than a silent one.

---

## D-0213 — The settings generator is ported on a transcribed `os.path`, and its thirteen rebuild branches are enumerated and pinned

**Status.** accepted (2026-08-28)

**Context.** PR 3 of the fencing + settings lane ports
`src/claude_org_runtime/settings/generator.py` and the 106 cases of
`tests/test_settings_generator.py`. The module renders a role template into the `settings.local.json`
a worker actually runs under, and on the way it makes two decisions that are security-relevant in
**opposite** directions:

- **Layer 3 suppression** DROPS a `sandbox.filesystem.deny{Read,Write}` entry whose realpath escapes
  the sandbox read roots. Dropping too much is a deny that stops covering a credential file.
- **Symlink canonicalisation** REWRITES a deny path that crosses an absolute symlink to its realpath,
  so bwrap can bind it. Dropping too little -- leaving an unbindable path in the file -- is worse
  than it looks: bubblewrap aborts the launch, and Claude Code's documented response to a failed
  launch is to retry the command with `dangerouslyDisableSandbox`. A kept-but-unbindable entry does
  not fail closed; it turns the sandbox off for every command that follows.

Both decisions are computed from paths, and both compose `os.path` primitives whose exact answers
决定 the outcome. Three things followed from that, and each is a decision rather than an
implementation detail.

**Decision 1: `os.path` is transcribed, both namespaces, and checked against CPython.**
`src/fencing/pypath.ts` already transcribed `posixpath.normpath` and `os.path.expanduser` for the
fence (D-0200). It now carries `join`, `normpath`, `isabs`, `split`, `splitdrive`, `dirname`,
`realpath`, `islink` and `readlink`, from **both** `posixpath` and `ntpath`, dispatched on
`process.platform` at call time the way Python binds `os.path` at import time. Node's `path` module
is not that function on either platform: `path.posix.normalize("a/b/")` keeps the trailing separator
that `posixpath.normpath` drops, which is precisely the difference that makes the equality half of
`_is_inside_root`'s boundary test stop firing.

`parity/oracle/ospath-vector.json` is the check -- at the time of writing 63 paths x 6 functions x 2
namespaces plus 30 join argument tuples; **67 paths x 7 functions** since `D-0216` added `normcase` and
the four non-ASCII-case paths that make it non-vacuous. The counts are restated rather than left stale,
because a number in prose that no test reads is the first thing a port outgrows. Generated from CPython
3.12.3 by `scripts/oracle/dump_ospath.py`, asserted by
`test/settings/ospath-oracle.test.ts` on **every** matrix cell. Both namespaces are dumped from one
interpreter because `ntpath` is importable on Linux and its answers do not depend on the host; a
Windows-only check would leave the half this port ships to Windows unverified on the cells where
most runs happen. Result at the time of writing: 0 divergences.

`realpath` is the exception and it is named rather than glossed. `ntpath.realpath` is written on
`nt._getfinalpathname`, a Win32 API with no user-space equivalent, so the Windows half is an
**adaptation**: CPython's non-strict walk-back structure reproduced around Node's
`fs.realpathSync.native`, with the three things it does not reproduce (8.3 expansion of an
unresolved tail, the `\\?\` prefix round-trip, case canonicalisation of a missing path) written at
the function. The POSIX half is a straight transcription of `_joinrealpath`. Neither is in the
vector, because a static vector cannot pin a function of the filesystem.

**Decision 2: the module's THIRTEEN rebuild branches are enumerated and each is pinned.**
D-0211 made carrying a JSON number's recorded Python spelling an obligation on every container
rebuild, enforceable only by enumeration plus pins -- a rebuilt container starts with an empty
record, the values are still numbers, every comparison still holds, and nothing goes red. This
module is by far the largest concentration of them in the port: it rebuilds a document at every
level it touches, and there are thirteen branches, listed in `src/settings/generator.ts`'s header
and referenced from `src/fencing/pyjson.ts`'s.

Three of the thirteen are not a plain wholesale `carryNumberSpellings`, and one of those is the
reason this is a decision and not a checklist item:

> **The KEPT deny list is a FILTERED copy, so a wholesale carry is not merely absent -- it is
> WRONG.** The spelling record is keyed by index. Suppress the entry at index 0 and the number that
> was at index 1 becomes index 0, where the carried record holds the *suppressed* entry's slot --
> usually empty, so the number is classified by value and written `1` where CPython writes `1.0`;
> and if the dropped neighbour happened to be a float, the surviving number inherits a spelling that
> was never its own. It is carried per surviving element instead, re-keyed as the list is built.

Each of the thirteen was probed by removing its carry and confirming the corresponding pin goes
red **for its own stated reason** (`docs/test-translation-conventions.md` section 10). The first
draft of the pin block had one non-discriminating case -- it believed it pinned the
`permissions.deny` object rebuild while actually pinning the array carry one call inside it, because
a spelling hangs on the container that IMMEDIATELY holds the number and the float had been nested a
level too deep. The probe is what found that; the block now puts one float on a key of its own at
every level, and the note is in the test file so the next reader does not have to rediscover it.

**Decision 3: the CLI's `argparse` is a second, scoped transcription -- `hook.mjs`'s is not
generalised.** `src/fencing/hook.mjs` carries a full transcription of CPython's two-pass parser,
measured at 0 divergences over 5,332 argv vectors (D-0207). Generalising it to serve the settings
CLI would put the fence's argv surface -- the surface whose single fail-open instance is what made
D-0207 reject a waiver -- behind a helper written for a different caller's needs, which is
`docs/test-translation-conventions.md` rule 11's shape exactly. `src/settings/argparse.ts` is the
same two-pass STRUCTURE over the option set this CLI declares, and what it does not model
(positionals other than the subcommand, `nargs` other than 0 and 1, short options taking an
argument, negative-number option strings, mutually exclusive groups) is a `throw` wherever the
parser could reach it, not a silent fallthrough.

**Alternatives.**

- **Use Node's `path` for `os.path` (rejected).** It is the substitution D-0200 already rejected for
  `normpath`, arriving one subsystem later with more surface. The trailing-separator difference
  alone changes a suppression decision, and on Windows the two disagree about `C:x` and about
  whether a normalised path keeps its separators.
- **Extend the existing `fnmatch-shlex` vector rather than adding a second one (rejected).** It would
  work -- the vector regenerates byte-identically, so additions are a clean diff -- but the corpus,
  the dump script and the oracle test all belong to the fencing lane, and a parallel lane is auditing
  two of those files right now. A separate corpus/vector/script triple is zero-conflict and reads as
  what it is.
- **Skip the `os.path` oracle and rely on the 106 translated cases (rejected).** They exercise the
  transcription only through the shapes interlock's fixtures happen to use. The rule that decides a
  suppression is `normpath` composed with a separator test, and the inputs that separate a right
  transcription from a nearly-right one -- `a/b/`, `//a`, `C:x`, a UNC root -- are inputs no
  translated case constructs. That is 2d's argument, applied where the fence is not the subject.
- **Port `sandbox_doctor` in the same PR (rejected, scope).** It is PR 4 of this lane, 77 further
  source cases in `tests/test_sandbox_symlink_deny.py`. The canonicalisation helpers it shares with
  the generator are ported here because `render_role_with_metadata` calls them unconditionally; their
  own dedicated cases are not, and the ledger says so.

**What the review gate found, and what it says about both repairs.** Two P2 findings, both real,
both now repaired with the half they must not break pinned beside them.

1. **`_kept_entry_string` asks `startswith("/")`, which is not "is this absolute" on Windows.**
   `{anchor: 'absolute', path: 'C:\\secret'}` fell through to the empty-anchor branch and was
   emitted as the original DICT -- the exact shape that function exists to stop emitting, since
   Claude Code answers a dict in `denyRead` with "Expected string, but received object" and rejects
   the file. Repaired to `osIsabs`, which is identical to the source on POSIX; the neighbouring
   `_canonicalize_sandbox_deny` already spelled the same test `os.path.isabs` with a comment giving
   this exact reason, so the source author saw it at one site and not the other. Recorded as an
   intentional divergence in the ledger, along with the sibling site (`absolute_pattern`) that is
   deliberately NOT changed, because its consequence is which entries get suppressed rather than the
   shape of an emitted value.
2. **The argparse `--` separator was consumed as an option's argument**, so `--worker-dir --` parsed
   into a worker_dir of `"--"`. **The first fix for this was wrong, and the way it was wrong is the
   point**: it assumed `_match_argument`'s `(-*A-*)` let an optional absorb the separator and take
   the token after it. `_get_nargs_pattern` strips the `-` when the action is an optional, so
   CPython rejects `--worker-dir -- /wd` too. Eight separator shapes were then MEASURED against
   CPython 3.12.3 on this exact parser and are pinned as a table, byte-for-byte on the error text --
   including the two that show the separator is never *removed* either (`unrecognized arguments:
   --`, and `-- settings` reaching a subcommand choice as `invalid choice: '--'`). Reading the
   source of `argparse` would have given the first answer; running it gave the right one.

**What the gate found in round 2, and the one thing it changed about the first response.** Three
more P2s, all measured against CPython before being believed. Two were argparse: a
negative-number-shaped token (`--out -1`) was classified as an unknown option, so the preceding
option failed -- the first draft of `argparse.ts` claimed `_negative_number_matcher` "has no
subject", which mistook the matcher's subject (the ARGUMENT token) for the condition that gates it
(`_has_negative_number_optionals`, decided by the declared option strings); and an unrecognized
option ahead of a valid subcommand was collected into `extras` and then abandoned by the subparser
path's early return, so `claude-org-runtime --bogus settings generate ...` GENERATED a settings file
for a command line the parser did not understand. `parse_args` is now `parse_known_args` plus a
root-level extras report, which is argparse's own structure and the reason CPython names the ROOT
prog for an extra found on either side of the subcommand.

The third changed the first response rather than adding to it. Round 1 repaired
`_kept_entry_string`'s `startswith("/")` and recorded the two sibling sites as
deliberately-not-changed, on the reasoning that their consequence is reachability rather than
emitted shape. Round 2 raised one of them, and reading the three together showed the boundary was
not a boundary: `startswith("/")` IS `posixpath.isabs`, so the repair is a no-op on the platform
interlock runs on at ALL THREE sites, and the source is already inconsistent -- two neighbouring
functions use `os.path.isabs`, one of them with a comment giving exactly this reason. All three are
now repaired as one divergence. **The "keep the blast radius small" instinct produced a worse
answer than making the module agree with itself**, and it is recorded because the instinct is
usually right.

Those three repairs are invisible on a POSIX cell by construction, which is not good enough for a
repair (rule 11: a pin that cannot fail on the cell a reviewer runs is a pin nobody has seen fail).
`pypath.ts` dispatches on `process.platform` at CALL time -- deliberately, because that is how
Python binds `os.path` -- so three target-only cases patch that property for the length of one test
and each revert was confirmed to turn its pin red on Linux.

**Verified by.** `npm run verify` green: lint, knip, typecheck, native smoke, 1544 tests, parity.
106/106 source cases mapped, 103 ported and 3 adapted, **no waivers and nothing not-ported**; the
source file re-run at `65f36c5` on the porting host reports 106 passed. The `os.path` oracle agrees
with CPython 3.12.3 at every position in both namespaces. Every one of the thirteen rebuild branches
and the seam were probed red individually, and the eight `--` shapes agree with CPython on the exact
error text.

**Falsified by.** CPython changing `posixpath` or `ntpath` semantics -- the vector is 3.12.3 and the
transcription is of that version. Also falsified if `os.path.realpath`'s Windows adaptation is ever
handed a path where 8.3 expansion or the `\\?\` prefix round-trip decides a suppression, at which
point the adaptation stops being a spelling difference and becomes a behavioural one; the settings
suite's tmp-directory cases realpath their `worker_dir` up front precisely because that expansion is
observable on the Windows cells.

---

## D-0112 -- The CLI is parsed by a purpose-built parser, not by an argparse port

**Context.** `measure report` is interlock's only entry point, and its parser is `argparse` -- a
standard-library module with subcommands, generated `--help`, `type=`, `choices=`, `required=` and
an introspectable action list. Node's standard library has none of it. `node:util`'s `parseArgs`
handles flags and stops exactly short of the two things this command is built on: it has no
subcommand support and generates no help text. Continuo had no CLI at all before this belt, so
there was nothing to extend either.

Three of the ported cases depend on more than "the flags parse". `test_the_command_is_mounted_on_the_top_level_cli`
needs a subcommand table. Both cp932 cases walk `parser._actions` and a subparsers action's
`choices` to collect **every** help string reachable from a parser -- a check written against a
hand-kept list would police the strings whoever wrote it remembered, and the walk polices the ones
that exist.

**Decision.** `src/cli/parser.ts` is a small parser written for this port, carrying only the surface
the two CLI modules use: long flags taking one value, `int` and `choices` coercion, `required`, a
subcommand table, a `version` flag, and generated `--help`. It is **not** an argparse port and says
so in its own docstring: no positional arguments, no prefix matching, no `nargs`, no argument
groups, no `argv[0]` inference of `prog`, and no dozen actions.

Two of argparse's behaviours are reproduced deliberately because cases rest on them:

- **The parser is introspectable**, and `helpStrings` -- the port of the source suite's
  `_help_strings` -- lives beside the structure it walks rather than in the test, so the two cannot
  drift apart.
- **`--help` writes and stops.** argparse raises `SystemExit(0)`; a parser that returned an empty
  namespace would run the command with no arguments. The stop is `HelpRequested`, a value, so the
  boundary that owns stdout is the one that writes it. There is no `process.exit` in the module: a
  library that exits cannot be tested in process, and a suite that spawns a subprocess per case is a
  suite nobody runs.

Where it differs from argparse it is stricter, in one place and on purpose: **a flag given twice is
refused** where argparse silently keeps the last value. A command line naming one flag twice with
two values is one whose author believes something about it that is not true, and the report it
produces carries no sign of which half won.

**Rule 11 applies to all of it.** This is new code with no source to underwrite it: it was not
reviewed in interlock, not exercised there, and its shape is not evidence of anything. So it is
pinned by ten target-only cases and a 23-mutation sweep rather than by the ported cases, which
mostly cannot see it -- three of them build the arguments namespace by hand and never reach the
parser at all.

**What was measured.** Every one of the parser's guards was deleted in turn and the case that names
it went red: a required flag, a value outside a flag's choices, a flag given twice, a value-taking
flag that consumes no value, `--help` scanned over the whole command line rather than the current
parser's own tokens, and the integer coercion. The last two are worth naming:

- **`--help` after a subcommand.** The first implementation scanned the whole of `argv`, so
  `measure report --help` printed the **top-level** screen -- the one screen that does not list the
  flags the operator was asking about. Found by running the built CLI, not by a test; the test was
  written afterwards and the mutation confirms it.
- **The integer coercion needs both of its halves.** `Number("1.5")` is `1.5`, `Number("0x10")` is
  `16`, and `Number("")` is `0` -- a period boundary quietly at the epoch selects every run ever
  recorded. With only the `Number.isSafeInteger` half left, `0x10` and the empty string are both
  accepted; the target-only case originally used `1.5` alone, which the surviving half refuses, so
  it could not tell the two guards apart.

**And seven things the review gate found that the sweep could not.** A mutation sweep asks whether the
cases can see the behaviour the module *has*. It cannot ask whether that behaviour is the source's,
and it cannot ask about a path no case takes. Three of the four are the first kind and were answered
by reading Python; the fourth is the second kind and is the most serious defect this belt produced:

- **`int()` accepts underscores between digits.** `int("1_700_000_000_000")` is `1700000000000`, so
  the source's parser takes `--period-start-ms 1_700_000_000_000` and the first version of this one
  refused it. That is the worst direction for a divergence to run in: it fails only for the operator
  who spelled a long timestamp readably, and every test written against a plain spelling stays green.
  The coercion now matches Python's rule exactly -- a single underscore **between** digits and
  nowhere else, so `_1`, `1_` and `1__0` are still errors -- and both directions are pinned.
  Whitespace padding is accepted for the same reason: `int(" 12 ")` is `12`.
- **A refusal named the wrong command.** `continuo measure report --bogus` printed
  `usage: continuo measure report` and, under it, `continuo: error: ...`. The usage line came from
  the parser that refused and the error line from the root, so the two named different commands and
  the operator was sent to read the flags of the one that has none of them. `UsageError` now carries
  the `prog` of the parser that raised it.
- **`--flag=value` is argparse's other spelling of `--flag value`,** and this parser took only one of
  them. The two are the same command line; a port that accepts one is a port that refuses command
  lines interlock runs. Split at the **first** `=`, because the value on the right of it may hold
  more, and pinned with a commit string that carries one.
- **The entry-point guard did not resolve `process.argv[1]`,** and that is the path every installed
  user takes. npm publishes a `bin` on Unix as a symlink -- `node_modules/.bin/continuo` -> the real
  `dist/cli.js` -- and Node sets `argv[1]` to the link while resolving `import.meta.url` to the real
  file, so the guard was false and **the process exited 0 having run no command and printed
  nothing.** `node dist/cli.js` worked throughout, which is why every test and every smoke run in
  this belt was green over it. Both sides now go through `realpathSync`.

  The last one is worth reading twice as a *measurement* failure rather than a coding one. It is the
  shape conventions section 10 describes -- a property no case was watching -- and the sweep could
  not have found it, because the sweep only mutates lines the cases already reach. It also resisted
  the first mutation written for it: resolving only the module's side of the comparison is
  **equivalent** to the fix in a checkout with no symlinks in its path, so that mutation survived and
  said nothing. The mutation that reproduces the defect is the one that leaves `argv[1]` unresolved.
- **A flag was swallowed as another flag's missing value,** and this is the only one of the five
  whose symptom is a *wrong* report rather than no report. `--fixture-commit --format json` recorded
  `--format` as the commit the labelled corpus came from and then rendered in the default format:
  the operator gets a plausible document whose provenance is false and whose rendering is not the one
  they asked for, and nothing downstream can catch it, because a commit is an opaque string and
  `--format`'s default is valid. argparse refuses a next-token value that reads as a flag, and so
  does this now -- **with argparse's exception for a negative number**, because `--grace-ms -1` is a
  command line a ported case runs and a guard written without the exception would leave that case
  green for the parser's refusal instead of the window model's. `--flag=--literal` is the escape
  hatch for a value that really does begin with a dash, which is argparse's escape hatch too.
- **`--version=x` printed the version and exited 0.** argparse refuses a value handed to a
  zero-argument action, and dropping it silently reads to the operator as though the value was
  understood. Matched, argparse's wording included.

**One of the gate's findings was not adopted, and that is a decision rather than an omission.**
Python's `int()` accepts **any Unicode decimal digit** -- `int("１２")` is `12`, and so is
`int("१२")` -- so the source's parser takes a full-width timestamp and this one refuses it. The
review asked for it to be decoded. It is refused instead, for three reasons that point the same way:

- The value is an epoch millisecond **the report prints in its header**. Decoding `１２` produces a
  document saying `12`, which the operator cannot get back by copying what they typed.
- Decoding it correctly needs a Unicode digit-value table. NFKD folds the full-width forms and not
  the Devanagari ones, so there is no normalization shortcut -- and a table written here is new code
  with no source to underwrite it whose failure mode is a **silently wrong number** rather than an
  error. That is exactly the class rule 11 names, and the wrong number is worse than the refusal.
- The refusal is fail-visible and quotes what it got. On the Japanese console `D-0113` is about, an
  IME left in full-width mode is the likely cause, and `--period-start-ms takes an integer, got
  '１２'` is the message that fixes it.

So `\d` in the coercion is ASCII on purpose. It is a divergence, it is recorded as one in
`parity/measurement.cli.ledger.json`, and a target-only case pins it so that it stays deliberate
rather than decaying into an accident nobody chose.

**Alternatives.**

- **Depend on a parser library (rejected).** The repository has two runtime dependencies and adds
  them deliberately. A CLI parser is not where a third belongs, and none of them reproduces
  argparse's help-string walk anyway -- the check would have to be written against library internals
  that no version pins.
- **Use `node:util`'s `parseArgs` and hand-write the help (rejected).** The help text is then a
  second structure beside the flag list, kept in step by hand, and the cp932 walk would police the
  copy rather than the flags. That is precisely the defect the source's walk exists to catch.
- **Skip the top-level CLI and mount nothing (rejected).** One ported case asserts the command is
  reachable from the top-level entry point, and a `measure report` that only works when imported is
  not the command the report's operators are given.

**Consequences.**

- `src/cli.ts` mounts **one** subtree where interlock's mounts six. `dispatcher`, `settings`,
  `sandbox`, `attention` and `migrate` name modules continuo has not ported, and mounting a
  subcommand for an absent module puts a command in `--help` that cannot run. Recorded in
  `parity/measurement.cli.ledger.json` under `divergences`.
- The package grows a `bin` (`continuo` -> `dist/cli.js`) and `knip.json` grows `src/cli.ts` as an
  entry, so the modules under it are not read as dead code.
- A later lane mounting its own subtree adds one `sub.addParser` call and its module's
  `addSubparsers`, and inherits the ASCII walk without doing anything.

**Status.** accepted

**Source.** Measured 2026-08-28 on Node 22 / vitest 4.1.11, against interlock `65f36c5`. Falsified
by: Node's standard library gaining subcommands and generated help in `parseArgs`, at which point
this module is a wrapper worth deleting.

---

## D-0113 -- The cp932 help-text guarantee is asserted as ASCII, and on the bytes

**Context.** Interlock's CLI module carries an **ASCII only** rule in its docstring, and the reason
is operational rather than aesthetic: this report is read on a Japanese Windows console, where
stdout is cp932, and a single character cp932 cannot encode is a `UnicodeEncodeError` that kills the
process mid-`--help`. `pytest` captures stdout as UTF-8 and cannot see it, so the source guards it
twice -- `text.encode("cp932")` on every help string in process, and `--help` run in a real
subprocess with `PYTHONIOENCODING=cp932`.

**Neither guard has a counterpart in Node.** `TextEncoder` emits UTF-8 and nothing else; there is no
cp932 encoder in the runtime, and `TextDecoder` decodes Shift-JIS but cannot encode to it. And Node
writes UTF-8 to stdout whatever the console's code page is, so there is no `PYTHONIOENCODING` to
set and no exception to provoke: the same em-dash that kills the Python process renders as mojibake
here and exits 0.

**Decision.** The port asserts **ASCII**, in both places.

- The two in-process cases assert `isAscii(text)` over the same walk. ASCII is a subset of cp932, so
  this implies encodability; and the source's first case already asserts `text.isascii()` beside its
  `encode`, which makes the port's assertion that case's own stronger half.
- The subprocess case asserts that `--help` wrote **no byte above 0x7F**. ASCII bytes are the same
  bytes in cp932, so a `--help` that passes renders identically on the console the source case is
  about. Its other two assertions -- exit 0, `--fingerprint` present -- are unchanged.

**The property being guaranteed is the same one, and the port's is narrower than the source's.**
cp932 admits thousands of characters ASCII does not; a help string in Japanese would pass in
interlock and fail here. That is a real difference and it is the right way round: everything under
`--help` in both codebases is written in English, and ASCII is a property a reviewer can check by
eye while cp932-encodability is not.

**What was measured.** An em-dash was put in one help string. Both the in-process case and the
subprocess case went red -- which also confirms the subprocess case is reaching the built CLI rather
than passing on an absent binary, the hazard conventions section 10 instance 1 describes. The case
asserts `dist/cli.js` exists before spawning it for that reason.

**The walk is the load-bearing half, and it can be vacuous.** Both in-process cases are a loop over
`helpStrings(parser)`, and a walk that returned an empty array -- or that stopped at the top-level
parser -- makes both of them green over nothing. A target-only case therefore asserts the walk
reaches a string only the innermost parser holds. Measured: with the recursion into subparsers
deleted, that case goes red and the two cp932 cases stay green.

**Alternatives.**

- **Vendor a cp932 encoding table (rejected).** Several thousand mappings, maintained here, to check
  a property that ASCII already implies for every string this repository will ever put in `--help`.
- **Assert nothing and rely on review (rejected).** The source's own history is the argument: the
  rule is written in the module docstring *and* guarded twice, because a docstring does not stop an
  em-dash from being typed.
- **Spawn the subprocess with a cp932 console for real (rejected).** There is no portable way to do
  it, and on the CI matrix the cells that could are the ones that already set the pace.

**Consequences.**

- `test_the_help_of_the_mounted_subcommand_encodes_to_cp932` becomes a case that asserts **more**
  than its source, which checks only encodability there. Rule 0 makes that a divergence like any
  other, so it is recorded as `adapted` in the ledger rather than passing silently.
- The rule extends to every string the CLI can print, `src/cli/parser.ts`'s own generated usage and
  option lines included -- they are inside the walk, and the walk is what the cases loop over.

**Status.** accepted

**Source.** Measured 2026-08-28 on Node 22 (Linux), against interlock `65f36c5`. Falsified by: Node
gaining a general encoder (`TextEncoder` with a label), or this CLI needing to print a language
ASCII cannot spell -- at which point the guarantee has to become real cp932 encodability and the
table stops being optional.

---

## D-0214 — `sandbox doctor` and the readback complete the settings subsystem, and the argparse surface grows two actions rather than one helper

**Status.** accepted (2026-08-28)

**Context.** PR 4 of the fencing + settings lane, and the last planned item of continuo issue #37's
fencing + settings section. It ports two source files at once because they are the two halves of one
question -- what a rendered configuration actually does when something reads it back:

- `src/claude_org_runtime/settings/sandbox_doctor.py` and the 77 cases of
  `tests/test_sandbox_symlink_deny.py`. This is the **detection** half of the symlink-deny fix
  `D-0213` ported the **repair** half of. The generator canonicalises the deny paths it renders
  itself; a worker's effective deny set is the merge of several settings scopes, and only some of
  them come from this runtime.
- `src/claude_org_runtime/fencing/readback.py` and the 15 cases of
  `tests/fencing/test_readback.py`. The `system/init` event is the one public surface that reports
  the effective `permissionMode` and `tools`, and it reports **no hooks and no sandbox key** -- which
  is why `D-0023`'s weakening of item 3 is narrowed rather than removed.

With them the settings subsystem is complete: 183 of 183 collected cases, 106 in
`parity/settings.settings-generator.ledger.json` and 77 here, no waivers and nothing not-ported. The
fencing subsystem's `test_readback.py` closes at 124 of 124.

**Decision 1: `argparse.ts` grows `append` and `store_false`, transcribed, rather than the CLI being
bent to the parser it has.** `sandbox doctor` declares `--settings` as `action="append"` and two
`action="store_false"` flags, and `src/settings/argparse.ts` -- written for `settings generate` in
`D-0213` -- had neither. The two alternatives were both worse in the same direction. Spelling
`--settings` as a plain store would silently audit only the **last** scope named, in a command whose
entire premise is that a deny path in *any* scope aborts the launch. Spelling `store_false` as
`store_true` with an inverted constant would take the *default* with it: `_StoreFalseAction` defaults
to `True`, and the collapsed form defaults to `false` -- the live bwrap canary off for every run that
did not ask to turn it off, reporting a preflight it never performed.

Both are transcribed from CPython's actions rather than approximated, and one thing that fell out of
writing them is recorded because nothing went red for it: an earlier draft answered "does this action
consume a following token" **three times** -- in `usage()`, in `help()` and in the parse loop -- and
`--no-probe-bwrap` rendered as `--no-probe-bwrap PROBE_BWRAP` in `--help` while parsing correctly.
The question is now asked in one place, and the pin that catches it reads a store_false flag's help.

**Decision 2: four private generator helpers become exports, and the privacy moves to
`src/index.ts`.** `sandbox_doctor.py` imports `_absolute_symlink_in_chain`, `_literal_path_prefix`,
`_permission_rule_host_path`, `_split_permission_rule` and `_PERMISSION_PATH_TOOLS` from the
generator -- underscore-private names, imported anyway, because the doctor's job is to answer the
same question the generator answers over scopes the generator did not render, and a second
implementation would be a second thing to keep in step. TypeScript has no underscore convention that
`import` ignores, so the privacy the source expresses by naming is expressed here by these staying
**off the package surface**. `canonicalizePermissionDeny` and `canonicalizeSandboxDeny` join them for
the narrower reason that six ported cases call them directly and reaching them only through
`renderRoleWithMetadata` would assert less than the source does.

**Decision 3: `analyzeTargets` calls `absoluteSymlinkInChain` directly, NOT through
`generatorSeams`.** This looks like an inconsistency with `D-0213`, and it is the source's own
binding rule. Python's `from .generator import _absolute_symlink_in_chain` binds at **import** time,
so the generator suite's autouse "keep these unit tests off the host filesystem" fixture never
reached `sandbox_doctor` -- and must not, because the doctor's cases build **real symlinks on disk**
and assert on what the filesystem says. Reading it through the seam would make those cases answer
from a fixture another file installed.

**Decision 4: the two capability gates are probed, and spelled as two `skipIf` sites.** The source
probes rather than inferring, and says why for each: Windows creates symlinks under Developer Mode or
elevation, so a blanket `skipif(win32)` would give up coverage on hosts that can run these; and
bwrap's *presence* is not its ability to start, because Ubuntu 24.04 and many containers block the
unprivileged user namespaces it needs. Both conditions are evaluated at module load -- collection
time, as pytest's are -- and each is **one** `skipIf` bound to a constant and reused by the 42 and 2
cases that need it, so the ledger approves a count of 2 rather than 44. Both gates were open on the
porting host: bubblewrap is present and starts, and the two oracle cases ran against the real binary
rather than skipping.

**One adapted case worth naming.** `test_the_readback_carries_no_hooks_and_no_sandbox` asserts
`not hasattr(readback, "hooks")` on a frozen dataclass. `InitReadback` is a TypeScript interface and
is **erased**, so there is no object to interrogate about a field it never received, and
`"hooks" in readback` would be green for any object nobody set the key on -- including one produced
by a `parseInitEvent` that had grown a `hooks` field and left it `undefined`, which is the change the
source's assertion exists to catch. It is translated as the assertion over the readback's own keys,
listed exhaustively, which is strictly **stronger**: it fails for `hooks`, for `sandbox`, and for any
third field a future `parseInitEvent` starts reporting.

**Consequences.** The unified parser now declares two subcommands where interlock declares three;
`state migrate` belongs to another lane and its absence is stated in `cli.ts` rather than implied.
`knip.json` declares `bwrap` as an external binary, because the oracle cases spawn it. Two inherited
defects routed to this pass by PR #43's review gate are repaired here rather than carried, under
`D-0023`; they are `D-0215` and `D-0216`, and each has its own decision because each changes
behaviour interlock exhibits.

---

## D-0215 — A truthy non-mapping `sandbox.filesystem` is refused, not coerced to the empty mapping

**Status.** accepted (2026-08-28)

**Context.** An inherited defect, disclosed by PR #43's review gate at its round limit and routed to
this pass because `sandbox doctor` -- ported here -- owns the half that observes it.
`_evaluate_sandbox_suppressions` reads

```python
fs = sandbox.get("filesystem") or {}
if not isinstance(fs, dict):
    fs = {}
```

so an enabled sandbox whose `filesystem` is a **truthy non-mapping** is silently coerced to the empty
mapping. Measured on this port before the repair, a role declaring
`sandbox: {enabled: true, filesystem: "invalid"}` renders

```json
{"enabled": true, "filesystem": {"denyRead": [], "denyWrite": []}}
```

A malformed security configuration becomes a valid, less restrictive one, and nothing says so.

**What makes it worth a repair rather than a disclosure is the readback.** Handed that render,
`sandbox doctor` reports `deny targets: 0 (0 unusable by bwrap)` and
`RESULT: sandbox deny paths are usable by bwrap.` -- a clean bill of health for a file whose author's
`filesystem` key was thrown away. The doctor's own module note says a preflight that gates a launch
"must not pass by accident", and this is the accident.

**Decision.** The coercion becomes a refusal: `PyValueError`, which `run` turns into `error: ...` and
rc 2.

**The warrant is not invented here, which matters because `docs/test-translation-conventions.md`
section 11 says a repair carries none from the source.** interlock **already refuses this shape**,
one module over: `sandbox_doctor.validate_settings` answers a non-mapping `sandbox.filesystem` with
`sandbox.filesystem must be an object` and the CLI exits 2. The half that WRITES the file and the
half that CHECKS it disagreed about the same shape. The message here is the doctor's own sentence so
that they no longer do, and that agreement is **asserted** rather than left as a resemblance.

**Scope, pinned in both directions.** Only a truthy non-mapping raises. `x or {}` has already
replaced an absent, `null`, `{}`, `[]`, `0` or `""` `filesystem` with `{}` before the type test, so
every document interlock accepts is still accepted -- six rows pin that, because getting it wrong
would reject documents interlock renders. The refusal also sits **after** the `enabled` gate, exactly
where the coercion sat, so a disabled sandbox with junk under `filesystem` renders as it always did;
moving the check one line earlier would look like a tidy-up and would start rejecting documents on a
path the defect never touched.

**Consequences.** This is a deliberate divergence on **every** platform, unlike `D-0213`'s
`os.path.isabs` repair -- interlock renders `denyRead: []` for this input on Linux too. That is
exactly why the disclosure said it needed a decision id of its own rather than riding along.
Recorded in `parity/settings.sandbox-symlink-deny.ledger.json`, and the entry it replaces is removed
from `parity/settings.settings-generator.ledger.json`'s `inherited_limitations`.

---

## D-0216 — `_is_inside_root` compares normcased paths, so Windows path identity is not a sandbox escape

**Status.** accepted (2026-08-28)

**Context.** The second inherited defect routed here. `_is_inside_root` decides whether a Layer 3
deny entry escaped the sandbox read roots by composing `normpath` with an `os.sep` boundary test, and
compares with `==` and `startswith` -- both case-**sensitive**, with `os.path.normcase` applied on
neither side. Windows path identity is case-**insensitive**.

Measured on this port before the repair, under a simulated `ntpath`: a `worker_dir` authored
`c:\Users\Foo\worker` against a realpath the OS returns as `C:\Users\Foo\worker\secret`
renders `denyRead: []` with one suppression whose reason is `realpath escapes sandbox read roots`.
The two paths name the same directory, and the entry that was dropped is an **in-root** deny -- the
kind that covers a credential file inside the worker directory. Dropping a deny is the direction that
stops covering something.

**Decision.** The **comparison** is normcased, and nothing else.

`src/fencing/pypath.ts` gains `normcase` from both namespaces -- `ntpath.normcase` is
`s.replace("/", "\\").lower()` and `posixpath.normcase` is the identity -- dispatched on
`process.platform` at call time like the rest of the transcription. It joins
`parity/oracle/ospath-vector.json` as a **seventh** function, so it is checked against CPython 3.12.3
on every matrix cell rather than argued from two specifications.

**The corpus had to grow for that check to mean anything, and the first version of it did not.** The
new assertion was green on the first run, and so was a deliberately broken `ntNormcase` that lowered
only `[A-Z]` -- because all 63 existing paths were ASCII, so the identity stood in for the Unicode
fold with nothing to say so. `str.lower()` is a FULL Unicode lowering, and that is the half a reading
of the two specifications is least likely to get right. Four paths were added -- a plain accented
capital, the Turkish dotted capital I (which lowers to `i` + U+0307 and CHANGES LENGTH), the capital
sharp S, and one combining them with a `..` component -- and the ASCII-only probe now fails on the
first of them. The vacuity guard gained the two assertions that keep it that way: the namespaces must
disagree on `normcase` somewhere, and the POSIX column must be exactly the corpus. This is
`docs/test-translation-conventions.md` section 10 doing its job on a check that had just been
written: green proved nothing until the probe ran.

**Scoping the fold to the comparison is what answers the design question the disclosure left open,
and it was a real question rather than a spelling one.** `normcase` has to be applied consistently,
and the open half was whether `sandbox_read_roots` REPORTS the normcased form or the operator's.
`metadata.sandboxReadRoots` is what `settings show --explain` prints and what the launcher's
`/sandbox` status displays, and an operator has to recognise the path they wrote. Normcasing the
stored roots would have folded a **display** value to answer a **comparison** question. Both halves
are pinned separately, because the display half would stay green under the wrong answer to the other.

**Consequences.** Windows only. `posixpath.normcase` is the identity, so this is a no-op on the
platform interlock runs on -- but unlike `D-0213`'s `isabs` repair, that is a property of the
**platform** rather than of the substitution, so it is a deliberate divergence and is pinned in the
direction that would break: two paths differing only in case are two different files on POSIX, and an
entry under one must still not be judged in-root by the other. All three pins were confirmed to go
red with the repair reverted. Recorded in `parity/settings.sandbox-symlink-deny.ledger.json`, and the
entry it replaces is removed from `parity/settings.settings-generator.ledger.json`'s
`inherited_limitations`.

---

## D-0114 -- The package walk is `import.meta.glob`, and the renderer the port adds is bound, not exempted

**Context.** `tests/measurement/test_known_holes.py` binds section 7's five open questions to the
suite so that filling one silently fails. Two of its properties are **discovery-driven on purpose**,
and the docstring says why: a test that reads a hand-written list of modules covers exactly the
modules that existed on the day it was written, and the module that fills a hole is by definition a
later one. So it walks the package with `pkgutil.iter_modules`, and a public `render_*` with no
entry in `REPORT_FACTORIES` **fails** rather than being skipped.

**Python's walk imports a name computed at run time. ESM cannot.** A dynamic `import()` of a path
built from `readdirSync` reaches Node, not Vite: the `.ts` file is never transformed, and importing
the built `dist/` copy instead would produce a **second module graph**, where a class reached through
the walk fails `instanceof` against the same class reached through a static import. Both spellings
are available and both are wrong.

**Decision.** The walk is `import.meta.glob("../../src/measurement/*.ts")`, in
`test/measurement/module-scan.ts`.

- Vite expands it **from the same directory listing**, at transform time. A module added to the
  package is imported on the next run without this file being edited, which is the property the
  source's two discovery tests are built on.
- Measured: the namespaces it yields are the **same module instances** a static import of
  `../../src/measurement/x.js` yields (`ns.renderShadowReconciliation === renderShadowReconciliation`
  is true), so nothing about identity or `instanceof` changes.
- The expansion is cross-checked against a `readdirSync` of the package, and a module on disk that
  the walk did not import is an error. Vite's expansion is a build-time artefact; without the check,
  a stale one would narrow every discovery below it and read as a clean pass.
- `index.ts` is excluded, because `pkgutil.iter_modules` excludes `__init__`. The **static** walk
  (`*.py` -> every file in the package) includes it, because the source's glob does. The two sets
  differ in the source and they differ here.

**The static walk's subject set is "every file in the package", not an extension.** A file the scan
cannot parse as TypeScript is a failure, not a skip. This is
`docs/test-translation-conventions.md` section 10 instance 3 applied before it could happen again:
the fencing belt's `*.ts` glob silently stopped covering `hook.mjs` on the day that file shipped,
and stayed green over the rest.

**Discovery finds one renderer the source has no counterpart for.** `render_header_json` and
`render_json` are `json.dumps` calls in Python. Node has no `json.dumps`, so `renderPythonJson` is
this port's own spelling of it, and `D-0017` rule 4 makes it **one** renderer shared by the two
callers rather than two copies -- which means it is exported from `provenance.ts`, which means
`/^render[A-Z]/` finds it.

**Decision.** It is **bound to a factory and read for a verdict like the other ten**, and its
parametrized case is declared target-only in the ledger.

- **Rejected: name it out of the walk.** A renderer that dodges discovery by being spelled
  differently is precisely what the source's design refuses to allow, and an exemption list is the
  hand-written list the walk exists to replace.
- **Rejected: rename it so the predicate misses it.** Same objection, reached by a different route,
  and it would trade a real property for a naming convention.
- It takes a second argument, the nesting depth, where every renderer the source discovers is unary.
  A one-entry `EXTRA_ARGUMENTS` table supplies it, and a target-only case fails if a key in that
  table names a renderer discovery does not find -- a stale key would be ignored in silence and the
  renderer would then be called with `depth` undefined, which renders wrongly rather than not at all.

**What was measured.** Seven mutations, each red for its own reason and for no other:
a new `export function renderWindowSummary` in `windows.ts` is reported as `unbound`; renaming
`renderLatencyReport` is reported as `stale`; a verdict word added to `renderAc9Report`'s first line
turns three cases red naming the word; the same word added inside `pythonJsonString` turns
`renderPythonJson` and the two renderers built on it red; an em-dash in a rendered line trips the
ASCII half alone; a rendered line that mentions `Q-0005` is **not** reported, which is the source's
own exemption for a sentence that states the hole rather than closing it; and a `Status: PASS` line
pushed **immediately before** that note is not reported either -- the source's exemption is a
240-character neighbourhood rather than a sentence, which is where a verdict is most likely to be
added, so a target-only case scopes the exemption to the LINE and goes red on exactly that mutation
while the ported cases stay green. Raised by the review gate.

**Status.** accepted

**Source.** Measured 2026-08-28 on Node 22 / Vite (vitest 4.1.11), against interlock `65f36c5`.
Falsified by: Vite dropping `import.meta.glob`, or Node gaining a way to import a run-time specifier
inside the transformed graph -- either would make a literal directory walk available again; or by
`json.dumps` acquiring a Node counterpart, which would remove the eleventh renderer.

---

## D-0115 -- The write scan names better-sqlite3's whole SQL surface, and restores the pragma keyword

**Context.** Hole 5 is that the measurement harness never writes, and `ai_invocation` least of all:
its single-writer property (`interlock D-0003`) holds only while nothing here writes. The source
proves it by parsing every `.py` in the package and classifying every `execute` / `executemany` /
`executescript` call -- parsed rather than grepped, so an `INSERT` inside a docstring does not fire
and an `INSERT` built by an f-string does.

**The set of methods is the load-bearing half.** `execute` / `executemany` / `executescript` is
every `sqlite3` API that is handed a statement; if it were a subset, a write through the missing one
would be invisible and the scan would report a clean package.

**Decision.** The port's set is `prepare`, `exec` and `pragma` -- better-sqlite3's complete set of
methods handed SQL text. Everything else on the driver takes bindings, not text.

- **`pragma()` takes the statement without its keyword.** `connection.pragma("query_only = ON")` is
  `PRAGMA query_only = ON`. The keyword is restored before the verb is read, because the source's
  rule for a pragma is "offending if the text sets anything", and a text of `query_only = ON` would
  be classified by its first word `query_only` as an unrecognised verb -- a red for the wrong
  reason, which is the failure mode conventions section 10 is about.
- **Matched on the method name whatever the receiver is**, exactly as the source matches `.execute(`.
  A `RegExp.exec` in a measurement module would therefore be reported as an unrecognised statement
  verb. That is loud and in the safe direction; a scan that quietly narrowed itself around a receiver
  it did not recognise is how a write hides. There is no such call today.
- **A statement whose text cannot be resolved statically is a failure**, as in the source, because
  an uninspectable statement is where a write would sit unread.

**The leading verb is not sufficient here, and it is sufficient in the source.** This is the one
place the port has to assert more than what it ports, and the reason is the driver rather than the
test: `sqlite3.Connection.execute` **refuses a second statement** ("You can only execute one
statement at a time"), so on the source's runtime a text whose first verb is `SELECT` cannot also
run an `INSERT`. `exec` runs every statement in the string. That is
`docs/test-translation-conventions.md` rule 9 reached through an API rather than through a type --
the port's surface admits a value the source's excludes, and nothing in the diff looks odd, because
reading the leading verb is what the source does.

So every write verb the text carries **beyond its leading position** is reported too, over a copy
with string literals, quoted identifiers and comments blanked -- `WHERE status = 'DELETE'` is not a
delete, and `replace(` is SQLite's string function rather than the statement verb. The same sweep
closes a hole **both** runtimes have and which the source therefore also carries: SQLite accepts a
CTE in front of a write, so `WITH x AS (...) DELETE FROM run` leads with `WITH`, which is in the
source's `READ_VERBS`. That half is an inherited defect repaired under `D-0023`, and the ledger
records both halves as divergences.

**The resolver gains two forms and loses none.** Statements arrive five ways here: a literal, a
template, a module or local constant, an entry in a query mapping, and a `sql` field of a record
class. The source's `QUERY.format(...)` is this port's `QUERY.replace("{placeholders}", ...)`; the
source's `sql=` keyword on a call is this port's `sql:` property of an options object; the source's
`MappingProxyType({...})` unwrap is this port's `readOnlyMap([[k, v], ...])`. Each is resolved to the
text that is actually executed.

**The five read-only-proof exemptions map one for one.** `reader.py`'s
`_arm_and_verify_both_mechanisms`, `_require_query_only`, `prove_read_only`, `_undo_the_probe` and
`measurement_snapshot` are `reader.ts`'s `armAndVerifyBothMechanisms`, `requireQueryOnly`,
`proveReadOnly`, `undoTheProbe` and `measurementSnapshot`. They are named function by function, not
module by module, so a second function added to `reader.ts` is still covered. The enclosing function
is resolved **outermost-first**, because `ast.walk` is breadth-first and the source's `setdefault`
therefore records the outermost enclosing function rather than the nearest -- a statement inside a
closure is attributed to the named function that holds it, which is what the exemptions are written
against.

**Three more places where part of a statement was read and the rest treated as absent**, all
raised by the review gate's second round and all closed the same way -- by refusing rather than by
guessing.

- **A template resolves whole, or not at all.** The source's resolver returns the first non-blank
  literal fragment, which is enough to name a verb and not enough to see a statement:
  `exec(`SELECT 1; ${suffix}`)` classified as `SELECT` and the suffix was never looked at. The whole
  text is resolved now. Where it cannot be, the fragment rule survives behind a precondition that
  makes it sound: the call must compile a **single** statement -- measured, `prepare("INSERT ...;
  INSERT ...")` throws `The supplied SQL string contains more than one statement` -- and the
  fragment's verb must not be `WITH`, because a CTE puts its write after the head. A **numeric**
  interpolation is admitted without being computed: its string form is digits, a sign, a dot, `e`,
  `Infinity` or `NaN`, none of which can hold a separator, a keyword or a quote. That is not a
  convenience; it is the one interpolation `reader.ts` writes into an `exec`, and refusing it would
  report the read-only probe itself as uninspectable.
- **An ambiguous name resolves to nothing.** The source keys its bindings by name over a walk of the
  whole tree, so a `const statement = "INSERT ..."` in one function resolves to another function's
  `"SELECT ..."`. A scope chain is the complete answer and is more machinery than the property
  needs; a name declared more than once resolves to nothing instead, and its statement is reported
  uninspectable. Fail-closed is the direction an ambiguity has to fail in a scan whose subject is a
  hidden write. Measured: no name used as a statement argument in this package is declared twice in
  its module.
- **A pragma has two setter spellings, and `=` is one of them.** SQLite accepts
  `PRAGMA user_version(1)` as well as `PRAGMA user_version = 1`, and the source tests only for the
  character. Measured against better-sqlite3 13.0.3: `pragma("user_version(7)")` then
  `pragma("user_version", { simple: true })` reads back **7**. The test is inverted -- an argument
  makes a pragma a setter **unless** its name is one of SQLite's introspection pragmas, because
  parentheses alone do not separate the two (`PRAGMA table_info("run")` is a read). That list is the
  engine's, not this package's, and a pragma missing from it is reported rather than skipped.

**And three more of the same family, which is what makes it a family rather than a list.** Every
finding on this scan across three review rounds has one shape: *a resolver reads part of a text and
treats the rest as absent.* Named, so the next person extending the scan checks for it rather than
rediscovering it.

- **`.replace(needle, insertion)` is performed, not skipped.** The source's `.format()` branch
  returns the template and never looks at the arguments, which is sound for a bind-parameter list
  and not for an arbitrary insertion: `QUERY.replace("{tail}", "; INSERT ...")` was classified from
  a text the write is not in. The replacement runs when both arguments resolve; the text is
  unresolvable when the insertion is not.
- **Only `prepare` may fall back to the fragment rule.** For a `pragma`, every statement the call can
  hold reads `PRAGMA`, and whether it *sets* is decided by what follows the name -- so
  `pragma(`user_version ${suffix}`)` reduced to its fragment reads as a plain read whatever the
  suffix does. The source has no `pragma()` method to have this problem with; it issues pragmas
  through `execute`, where the whole text is the statement.
- **One unreadable `sql:` field makes the whole `recordClass.sql` unresolvable.** Dropping it was
  fail-open twice: the query is never classified, and because the module's other record classes
  still resolve, the access returns a non-empty list and the scan reports a clean package.

**What was measured.** 42 statements found across the fourteen modules, every one statically
resolved, none unclassified, and none reported by the hidden-write sweep. Six mutations, each red
for its own reason: an `INSERT` added to `cohort.ts` reports `cohort.selectCohort: INSERT`;
`connection.prepare(String(Math.random()))` reports `statement not statically inspectable`; a scan
that matches no method at all trips the `seen > 20` guard with `only 0 executed statements found;
the scan is not working`, which is the source's own guard against a vacuous pass;
`exec("SELECT 1; INSERT INTO ai_invocation ...")` reports `INSERT behind a leading SELECT`;
`WITH doomed AS (...) DELETE FROM run ...` reports `DELETE behind a leading WITH`; and a statement
carrying `replace(...)`, a literal `'DELETE'` and a `-- INSERT INTO run` comment reports **nothing**,
which is the direction the blanking exists for. Six more for the second round:
`exec(`SELECT 1; ${unresolvable}`)` and `prepare(`WITH x AS (SELECT 1) ${tail}`)` report `statement
not statically inspectable`; `exec(`SELECT 1; ${aWriteConstant}`)` reports `INSERT behind a leading
SELECT`; a second `const statement` in `false-termination.ts` reports its own function
uninspectable; `pragma("user_version(1)")` reports `sets a pragma`; and `pragma('table_info("run")')`
reports **nothing**. Five more for the third round: a `.replace` that really inserts
`; INSERT ...` reports `INSERT behind a leading SELECT` while the same replace inserting a comment
reports nothing; a `.replace` with an unresolvable insertion and an interpolated `pragma` both
report `statement not statically inspectable`; an unreadable `sql:` on one record class reports
`canary.readInterlockRecords` uninspectable; and `export const { MIN_SAMPLE_SIZE } = ...` is
reported by name by the forbidden-name walk. Four for the fourth round:
`(PROMPT_REDUCTION_TARGET) > 0.5` and `(PROMPT_REDUCTION_TARGET as number) > 0.5` are both reported
by file, line and constant; a read opening with a block comment reports **nothing**; and
`/* harmless */ INSERT ...` still reports `INSERT`.

**Two shapes TypeScript has and `ast` does not.** The fourth review round found both, and they are
the same observation as rule 9 reached through the syntax tree rather than through a type: a scan
written against the source's node shapes sees a node the source could not produce.

- **Erasable wrappers.** `ast.parse` has no node for parentheses -- `(X) > y` and `X > y` are one
  tree -- and none for a cast, because Python has no casts. So `(PROMPT_REDUCTION_TARGET) > measured`
  named no operand and the comparison scan permitted the comparison it exists to reject. Parentheses,
  `as`, `satisfies`, `!` and the angle-bracket assertion are unwrapped, in the comparison scan and in
  the statement resolvers alike.
- **A statement opening with a block comment.** The source's `_leading_verb` skips `--` lines only,
  so `/* why this query is shaped this way */ SELECT ...` read as a verb of `/*`. This is the one
  finding on this scan that was a **false positive** rather than a fail-open -- it refuses a
  legitimate query rather than admitting a write -- and it is repaired for that reason: a guard that
  costs whoever next writes a commented query is a guard that gets edited around. Only the LEADING
  comment run is stripped, because a comment marker inside a string literal has something before it
  and cannot be reached that way.

**Status.** accepted

**Source.** Measured 2026-08-28 against interlock `65f36c5` and better-sqlite3 13.0.3. Falsified by:
better-sqlite3 gaining another method that takes SQL text (the set would have to grow with it), or
this package reaching a statement form the resolver cannot follow -- which fails loudly rather than
silently, and is a reason to widen the resolver, not the exemptions.

---

## D-0116 -- The statement trace names its issuer from the V8 call site, and folds the two languages' spellings

**Context.** `tests/measurement/test_query_catalogue.py` keeps section 6's catalogue complete by
running a real report through a connection that records every statement, and then asserting each
recorded statement is either in the header's catalogue or named, with a reason, in
`render.UNATTESTED_STATEMENTS`. The point of it is a module **this file has never heard of**: a new
module reaching the report path fails the case without anyone editing the case. That only works if
the recorder can name the code that issued the statement, and the source names it by reading the
caller off the stack -- `sys._getframe(1)`, rendered as `<file stem>.<function name>`.

**Nothing is passed in, deliberately.** A recorder told who its caller is can only be told by callers
that were edited to tell it, which is the hand-written list the design refuses.

**Decision, part one: read the call site, do not parse the stack string.** `Error.captureStackTrace`
with `Error.prepareStackTrace` returning the call-site array hands back objects with `getFileName()`
and `getFunctionName()`. `error.stack` is a **rendered string with no format contract**; a regex over
it would be a second parser of a format V8 is free to change, and it would fail by returning a
plausible wrong name rather than by throwing. `prepareStackTrace` is saved and restored around the
capture, because it is global and Vitest installs its own.

The recorder itself is a `Proxy` rather than the source's forwarding class. better-sqlite3's
`Database` keeps its state on the native handle and its methods are not bound, so a hand-written
wrapper would have to enumerate the surface and would silently stop forwarding whatever it had not
heard of -- and this file's every assertion is about the report that connection produced. The
non-recorded methods are returned bound to the real connection, because `this` would otherwise be
the proxy. A target-only case pins the whole of it: the report built through the recorder renders
byte-identically to one built without it.

**Compiling and running are one call in the source's driver and two in this one.** `execute`
compiles and runs; better-sqlite3's `prepare` returns a `Statement` that runs only when `run` /
`get` / `all` / `iterate` is called on it. Recording at `prepare` alone would report a statement the
report **compiled and then skipped** as one the report ran -- and `every catalogued query was one the
report ran` is the case whose entire subject is that a catalogued query really was executed, so the
mismatch is fail-open in precisely the worst place. `prepare` therefore records the text and wraps
the statement it returns; the flag is set when an execution method fires, and the chaining modifiers
(`raw`, `pluck`, `expand`, `bind`, `safeIntegers`) hand back the wrapper so a chain is still watched.
`exec` and `pragma` run immediately and are recorded executed. **The four ported cases read the
executed set**, which is the source's set exactly; a target-only case reads the two sets apart, so a
stuck flag fails as a recorder fault rather than as a catalogue fault. Raised by the review gate.

**Decision, part two: fold the two spellings rather than tabulate them.** `UNATTESTED_STATEMENTS` is
keyed by the **source's** function names -- `reader._require_query_only`, `provenance._columns_of` --
and `render.ts` records why: the report is what a parity comparison of the two implementations is
made from, so renaming the keys would make the two reports differ on a field whose subject is
identical. The trace, though, observes this port's names: `reader.requireQueryOnly`,
`provenance.columnsOf`. One function, two conventions.

Both sides are folded to a form neither convention can move -- lower case, underscores removed --
and the comparison is made on the folded form.

- **Rejected: a hand-written table from one spelling to the other.** It is exactly the "keep this
  list current" note the source's own docstring says does not survive a new module: the table would
  be correct for the nine exemptions that exist and silent about the tenth.
- **Rejected: rekeying `UNATTESTED_STATEMENTS` to the port's names.** It would move a field of the
  published report for the convenience of a test.
- The fold discards information, and discarding too much is how it fails: two exemptions that folded
  together would let an entry written for one function excuse a statement issued by another, and
  every case in the file would stay green over a hole in the catalogue. A target-only case asserts
  the fold stays one-to-one over `UNATTESTED_STATEMENTS`.

**What was measured.** The trace records 32 statements over the populated fixture, from nine
functions, all executed, and every one of the nine matches its exemption through the fold.
Mutations, each red for its own reason and for no other: an uncatalogued statement added to
`cohort.ts` is reported by name and turns the trace case red; an exemption for a function nothing
calls turns `no declared exemption is stale` red and nothing else; a second exemption spelled
`provenance.columns_of` beside `provenance._columns_of` turns the fold's target-only case red while
the eight ported cases stay green; a recorder made to return a wrong `user_version` turns the
forwarding case red alone; a `prepare` of a catalogued query added and never run turns the
compile-versus-run case red alone; and the same mutation **with the flag forced back to counting a
prepare as a run** leaves `every catalogued query was one the report ran` GREEN over a catalogued
query the report never executed, which is the fail-open the flag closes.

**Status.** accepted

**Source.** Measured 2026-08-28 on Node 22.17.0 / V8, vitest 4.1.11, better-sqlite3 13.0.3, against
interlock `65f36c5`. Falsified by: V8 withdrawing the structured stack-trace API (there is no second
way to name an unknown caller, and the trace half would have to be redesigned rather than reparsed);
by the port and the source converging on one spelling of these function names, which would retire
the fold; or by better-sqlite3 gaining another way to run a prepared statement, which the execution
set would have to grow with -- it fails toward reporting a statement as unrun, which is red rather
than green.

---

## D-0117 -- The catalogue's no-copy property is read off the syntax, because JavaScript has no string identity

**Context.** `test_a_catalogued_module_executes_the_constant_and_not_a_copy` is the case that makes
the query catalogue worth having. Its docstring states the property exactly: "Equality of text is not
the property; identity of object is." A statement inlined at its call site as a copy of the
catalogued text passes the *other* case on the day it is written, and stops passing it only once the
two have already disagreed -- which is one report too late, because the disagreeing report is the
artefact. So the source asserts `any(text is constant for constant in constants)`: the catalogue must
hold **the same string object** the module executes.

**`is` has no counterpart for a JavaScript string.** Strings are primitives; `===` compares by value,
and there is no operator, no `Object.is`, and no reflective API that can tell a constant apart from a
copy of it. A literal translation -- `constants.includes(text)` -- is `==` where the source wrote
`is`, and it is **weaker in precisely the direction the case exists to cover**: a pasted copy passes
it. `docs/test-translation-conventions.md` rule 0 makes that a defect, not a simplification, and it
is one no failing test would have found.

**Decision.** The property is asserted on the **syntax**, in three parts, and all three must hold:

1. the module's `QUERY_DEFINITIONS` entry for the name is an **identifier**, not a literal -- so what
   the catalogue is built from is the constant, and there is one string with no copy to drift;
2. some module-level string constant of that module holds that text at run time -- the source's
   `vars(module)` half, kept because part 1 alone says nothing about the value;
3. every statement call in the module hands the driver a name, a member access or an index -- never a
   literal and never a composed expression -- which is the source's `_execute_arguments` check,
   translated node kind for node kind, with `.replace("{placeholders}", ...)` unwrapped where the
   source unwraps `.format(...)`.

Parts 1 and 3 stand on the two ends the object identity joined: the catalogue is built from the
constant, and the call site executes the constant. Together they are what `is` asserted, reached
through the only surface that can observe it.

**They are also exactly as wide as `is` was, hole included.** Neither the source nor this reads the
two ends against *each other*: a module holding two byte-identical constants, one named by the
catalogue and the other executed at the call site, satisfies both. That is the source's shape and
not a weakening introduced here -- measured: CPython folds two equal module-level string literals to
one object, so `is` cannot separate the twins either. Closing it means comparing the two identifiers,
which asserts more than the source does, so it lives in a pair of target-only cases beside the
faithful translation rather than in its slot (rule 0). Raised by the review gate.

**`vars(module)` includes private names; an ESM namespace does not.** Reading part 2 off the module
namespace alone would fail a module-private constant that Python's `vars` would find -- **stricter**
than the source, which rule 0 makes wrong in the same way as weaker. So the namespace's string values
are unioned with the module-level `const NAME = <string literal>` declarations read off the source,
and a constant that stops being exported is still found. Measured both ways.

- **Rejected: assert value equality and note the gap in the ledger.** The ledger would then describe
  coverage the suite does not have, over the one case whose whole subject is the difference between
  a copy and the original.
- **Rejected: give the queries an opaque wrapper object so identity becomes observable.** It buys the
  assertion by changing the module under test into something the source does not have, and the
  catalogue's texts are published in the report as strings.

**What was measured.** Five mutations, each red for its own reason and for no other: the catalogue
entry replaced by a **byte-identical** string literal turns this case red and no other -- the case
the literal translation could not fail; the call site replaced by a byte-identical literal likewise;
the entry's text edited so it drifts from the constant turns four cases red, this one among them; the
constant made module-private leaves all 13 green, which is the `vars(module)` half being the source's
width rather than the namespace's; and a byte-identical twin constant executed at the call site while
the catalogue keeps naming the original leaves the eight ported cases green and turns only the
target-only pair red, which is the hole being the source's and the repair being declared as one.

**Status.** accepted

**Source.** Measured 2026-08-28 on Node 22.17.0, TypeScript compiler API, vitest 4.1.11, against
interlock `65f36c5`. Falsified by: JavaScript gaining an observable identity for primitive strings,
which would make the source's assertion directly translatable; or this package building a catalogue
some way other than a literal array of `[name, CONSTANT]` pairs, which the syntax read would have to
follow.

