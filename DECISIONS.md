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
  in the index table above and never over an ID. `D-0019`..`D-0099` is the control-plane belt and
  the shared band for cross-belt decisions taken at the window, `D-01xx` the measurement belt,
  `D-02xx` the fencing and settings belt, `D-03xx` the session belt, `D-04xx` the canary belt,
  `D-05xx` the messagebus belt (the last three allocated by D-0032), `D-07xx` the
  secretary belt (allocated by D-0701), `D-09xx` the attention belt -- shared across its three
  sub-belts A1 (facts), A2 (dedup and config) and A3 (notify and pipeline) -- and `D-10xx` the
  gate_item11 belt (both allocated by D-0034). The ranges are an allocation,
  not a meaning: nothing about an entry follows from which range it is in.

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
| D-0008 | The package is `private` until publication is decided | superseded by D-0045 |
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
| D-0030 | One parser for the whole CLI: the argparse transcription wins, and the purpose-built parser's cases are re-pointed onto it | accepted |
| D-0031 | The source inventory is complete and unconditional; porting intent is recorded separately | accepted |
| D-0032 | Three not-porting proposals are ratified, and three belts start with D-ranges allocated | accepted |
| D-0033 | A suite template is built in the file's `beforeAll`, so a shared cost is not charged to an arbitrary test | accepted |
| D-0034 | The attention belt and the gate_item11 belt both start, and design proposals ratified within them are named | accepted |
| D-0035 | `curator` is ratified `not-porting`; `migrate` is reviewed and stays `decision-pending` | accepted |
| D-0036 | interlock is a frozen source, not a decision-maker: every question continuo has open is settled at continuo's own human gate | accepted |
| D-0043 | `migrate` is ratified `not-porting`: the belt's subject is gone on both sides, and the fired revisiting trigger is replaced by one that can still fire | accepted |
| D-0044 | Errata for `D-0035`'s `curator` clause: the withdrawal condition is restated without a foreign repository, and the premise is narrowed to the claim that survives | accepted |
| D-0045 | `@suisya-systems/continuo` is published: `D-0008` is superseded, and the release path must build before it packs | accepted |
| D-0046 | `run.status` has exactly one in-place writer; lap 1's consumer role is played by the admission command, and the lease is scoped to the run | accepted |
| D-0047 | An identity incident gets its own `FailureKind`, and every path refuses it as `IdentityUnconfirmed` | accepted |
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
| D-0118 | The last two measurement files convert whole, and the copy is verified by the testkit rather than by an opener | accepted |
| D-0119 | The remaining six measurement files convert whole, closing out the belt's per-case control-plane creation | accepted |
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
| D-0301 | The five session verbs are `Promise`-returning, serialised per instance, and the capability probe stays synchronous | accepted |
| D-0302 | The watcher's closed fact-state set is restated here, so the S1 vocabulary lint has an oracle in this repository | accepted |
| D-0401 | The canary routing ledger gets its own opener, and `recursive_triggers` is part of the store | accepted |
| D-0402 | An already-routed run is recognised by result code and a re-read, never by message text | accepted |
| D-0403 | The structural belt keeps its subject when the tree changes language | accepted |
| D-0404 | The ledger DDL is a shipped data file, and the belt asserts it reached `dist/` | accepted |
| D-0405 | The `INSERT OR REPLACE` bypass is real, and repairing it is its own change | accepted |
| D-0406 | With the replacement guard in place, an already-routed run is a trigger refusal confirmed by a re-read | accepted |
| D-0407 | The routing point reads its INTEGER columns 64-bit wide | accepted |
| D-0501 | The messagebus package owns `send`, `poll` and `ack`, and nothing the outbox already owns | accepted |
| D-0502 | The MCP wire keeps interlock's snake_case keys and env names; the endpoint is launched as the built module by path | accepted |
| D-0503 | The facade's own caller bug gets a class the outbox does not share | accepted |
| D-0504 | The third AST scan stays in its belt; the frozen testkit is not changed by this PR | accepted |
| D-0601 | The fault-injection belt takes `D-06xx`, its own `test/fault_injection/` directory, and two adapter classes | accepted |
| D-0602 | The fault-injection watchdogs are scaled for this port's runners, and the manifest's numbers are left alone | accepted |
| D-0701 | The secretary belt takes `D-07xx`; `submit()` is synchronous, and the stall is proved by state order | accepted |
| D-0801 | The gate_item2 belt takes `D-08xx`; `SessionOrchestrator` is `async` end to end, and the session-driver-harness file is deferred | accepted |
| D-0603 | The session adapter's driver command needs `--experimental-transform-types`, not `--experimental-strip-types` | accepted |
| D-0604 | D-0602's scale reaches the suite budget too: `installSuiteBudget` stops reading `suite_timeout_s` raw, and the ceiling stays off it | accepted |
| D-0802 | D-0801's deferred session-driver-harness file lands; no dedicated reaper for the destination's grandchild | accepted |
| D-0901 | The attention belt takes `D-09xx`; the six-name fact vocabulary is adopted, not merely restated | accepted |
| D-0902 | A1 lands the one `config.ts` constant its classifier imports; the config belt stays A2's | accepted |
| D-0903 | The classifier carries a fact state it is given and derives none; the retargeted invariant is a guard with measured probes | superseded by D-0906 |
| D-0904 | Dedup state fails closed: an absent namespace is empty, a present but unusable one is a refusal; the belt's `datetime` transcriptions get one home | accepted |
| D-0905 | `isinstance(value, int)` is a question about the config DOCUMENT; the dataclass's own defaults become one exported record | accepted |
| D-0906 | D-0903 is falsified as written: the classifier carries no fact state, and the retargeted invariant is withdrawn rather than re-homed | accepted |
| D-0907 | The attention subsystem's `src/index.ts` surface: nothing is re-exported, and the CLI is the intended surface | accepted |
| D-0951 | A refused dedup ledger stops the attention CLI at exit 2 and leaves the file untouched | accepted |
| D-0952 | The operator's template goes through a transcribed CPython, checked by a differential oracle rather than by review | accepted |
| D-1001 | The gate_item11 belt takes `D-10xx`; `src/index.ts`'s dual re-export is an allowlisted exception, and `test_suite_runs_unchanged.py` is a declared follow-on | accepted |
| D-1002 | The gate_item11 belt completes at 64/64: `test_suite_runs_unchanged.py`'s double-suite-run measurement lands as a vitest `globalSetup` plus a subprocess double-run over `--reporter=json`, and continuo#70 is resolved as intentional | accepted |
| D-1003 | `suite-runs-unchanged.test.ts` skips on Windows CI: a measured resource-contention failure, not a coverage gap the belt is silently accepting | accepted |
| D-0048 | Windows runs the child-process-spawning tests apart from the rest of the suite | accepted |
| D-0049 | The runtime surfaces continuo operates -- the fence hook, the default worker prompt and the CLI descriptions -- say `continuo`, not `Interlock` | accepted |
| D-0050 | The production schema is the control plane the lap runs on, and the spike schema is not a fallback | accepted |
| D-0051 | A run is created by one writer, `continuo run admit`, which appends `run_created` in the same transaction and refuses a second admission | accepted |
| D-0052 | The runner's per-test timeout is scaled on a slow platform, from the same constant the harness budgets use | accepted |
| D-0053 | The broker belt is declined and discharged rather than ported, and the endpoint moves onto the production schema with the outbox aligned to `cancelled` | accepted |
| D-0054 | `writer_epoch` on `outbox` is delivery-side ownership, not producer provenance: the delivery worker adopts one row immediately before it attempts it | accepted |
| D-0055 | The lap's execution intent is fixed at admission as `LapRunIntent`, written with the run in one transaction, and carries no authority | accepted |
| D-0056 | The report ingress reads the transcript: the provider gains a terminal-report read API, and the escalation event and its gate are written in one transaction | accepted |
| D-0217 | `FencedSpawner` splits into `prepare` and `execute`, and the single-spawn-path obligation is restated over both with a provenance check | accepted |
| D-0057 | The delegation intent and the materialisation result are two records, and materialisation is artifact-first and one-way | accepted |
| D-0058 | The worker's MCP configuration is a materialised artifact, validated by the endpoint's own config class | accepted |

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

**Status.** superseded by `D-0045`

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

## D-0030 -- One parser for the whole CLI: the argparse transcription wins, and the purpose-built parser's cases are re-pointed onto it

**Context.** Two lanes landed CLI infrastructure independently, and the repository carried **two
ArgumentParser implementations and two unified CLIs** (issue 45):

- the fencing + settings lane (`D-0213`) brought `src/settings/argparse.ts`, a 525-line transcription
  of CPython's `argparse`, and `src/settings/cli.ts`'s `buildRuntimeParser` -- prog
  `claude-org-runtime`, mounting `settings` and `sandbox`, **reachable from no bin at all**;
- the measurement lane (`D-0112`) brought `src/cli/parser.ts`, a purpose-built parser written
  precisely because it is *not* an argparse port, and `src/cli.ts` -- prog `continuo`, mounting
  `measure`, wired to the published `bin`.

Nothing was broken and every case was green, but `D-0017` rule 4 ("one renderer") was violated at the
CLI layer, and the cost was concrete rather than aesthetic: **`continuo sandbox doctor` -- the
preflight whose whole job is to say whether a worker's sandbox will actually launch -- could not be
run from the published binary.** PR 47's review routed the mounting here rather than lane-side,
because mounting it without consolidating meant either re-declaring a security-relevant flag surface
(`--settings`, `--no-merge-scopes`, `--no-probe-bwrap`) in a second parser with different semantics,
or adding an argv passthrough the purpose-built parser has no shape for.

**Decision.** The **argparse transcription wins**. It moves to `src/cli/parser.ts` -- the CLI
package, one parser -- and `src/cli.ts` is the one unified CLI, mounting `measure`, `settings` and
`sandbox` under the `continuo` bin. `buildRuntimeParser` is gone; each subtree's own module owns its
flags and exports a function that mounts them (`measurementCli.addSubparsers`,
`addSettingsSubparsers`, `addSandboxSubparsers`), so the entry point mounts a subtree without knowing
a flag of it.

**Why that side, in one line: the loser's distinctive properties are mostly argparse behaviours it
reproduced, so they survive the move natively; the winner's are not reproducible without becoming
it.** Taken property by property, from the two lanes' own lists:

| `D-0112`'s parser had | after the move |
|---|---|
| the flag-swallowing guard, with the negative-number exception `--grace-ms -1` needs | argparse's own `_parse_optional` + `_negative_number_matcher`, already transcribed and measured against CPython 3.12.3 |
| `=value` splitting | already there |
| `--version` | `action="version"` -- an argparse action, added to the transcription |
| `type=int` | `type=` -- an argparse feature the source's `cli.py` actually declares, added |
| the introspectable help walk (`_help_strings`, `D-0113`) | ported onto the transcription's structure, ~15 lines, still living beside the structure it walks |
| a flag given twice is refused | kept as a per-declaration opt-in, `refuseRepeat` -- see below |

**The rejected alternative and its cost.** Keeping the purpose-built parser meant growing it two-pass
classification, the `--` separator, prefix abbreviation with the ambiguity report, `store_true` /
`store_false` / `append`, extras propagated from a subparser to the root, and CPython's exact message
wording -- which is to say, rewriting it into the file it would have replaced, in one step, with 106
ported settings cases, 92 ported sandbox cases and 18 target-only cases measured against CPython
3.12.3 riding on the result. That is rule 11's hazard at full size on the surface that decides what a
sandbox preflight checks. The transcription's cost, by contrast, is three additive argparse features
and two opt-in flags.

**What the loser cost anyway, stated rather than buried.** Six target-only cases were **re-pointed,
not deleted**, and one was **added**:

- Five are wording. argparse says `argument --period-start-ms: invalid int value: '1.5'` where
  `D-0112` said `--period-start-ms takes an integer, got '1.5'`, and `argument --fixture-commit:
  expected one argument` where it named the token it declined to swallow. That last one also cost a
  sub-assertion: the case checked the message mentioned `--format`, which argparse's wording does
  not -- and the usage line lists every flag, so keeping it would have been an assertion that passes
  against any refusal at all (conventions rule 10). Dropped rather than made vacuous.
- One is a **behaviour change**, and it is the one worth reading twice. `a nested command's refusal
  names the nested command` drove `continuo measure report --bogus`, which the purpose-built parser
  refused in the child. **CPython does not**: an unrecognized token is an *extra*, handed up by the
  subparser action and reported by the ROOT under the root's prog. Measured on a replica of this
  exact command tree at CPython 3.12.3: `continuo: error: unrecognized arguments: --bogus`. The
  settings suite already pinned that from the other side, and it is not a nicety -- it is what stops
  an unknown option ahead of a valid subcommand from being silently dropped, which is a defect that
  lane found and fixed. So the case was re-pointed onto a refusal argparse *does* raise in the child
  (a value-taking flag with nothing after it), where the property it names -- usage line and error
  line naming the same parser -- is still live, and the behaviour it used to assert is now pinned by
  the added case rather than lost.

**The two places the merged parser is deliberately not CPython**, both `D-0112`'s, both carried as
**per-declaration opt-ins** so that nothing the settings and sandbox surfaces are measured against
changes:

- **`type: "int"` takes ASCII digits only.** Python's `int()` takes any Unicode decimal digit, so a
  full-width `12` is `12` there and refused here. Decoding it needs a Unicode digit-value table --
  NFKD folds the full-width forms and not the Devanagari ones -- which would be new code whose
  failure mode is a silently wrong epoch millisecond printed in a report header. The refusal now
  *says which rule it applied*, so on the console it reads as a divergence rather than as the parity
  refusal CPython gives for `1.5`. The neighbouring refusal for an integer past `2**53-1` is the same
  shape and the same reason (conventions rule 9: Python's `int` is arbitrary precision, a JavaScript
  `number` is not).
- **`refuseRepeat` refuses a flag given twice**, declared on the measurement report's flags and
  nowhere else. argparse keeps the last value silently, and a report produced from
  `--format json --format markdown` carries no sign of which half won.

  **The known limitation this leaves**, disclosed rather than smoothed over: one binary now answers
  two ways -- `continuo measure report --format a --format b` is refused and
  `continuo settings generate --role a --role b` keeps the last value. Each subtree matches its own
  source, which is what a parity port owes; making them agree means either dropping a safety
  property `D-0112` justified or diverging the settings surface from the CPython behaviour 18 cases
  measure it against. Neither is this task's to take.

**Two defects the consolidation found, both repaired, neither reachable by any existing case.** They
are the reason the merge is worth more than tidiness -- each was a place where one file had a
property and its twin did not, and nothing was red:

1. **`ignored explicit argument` dropped the value.** CPython's is
   `msg = _('ignored explicit argument %r')`, so `--version=x` is
   `argument --version: ignored explicit argument 'x'` (measured), and `src/fencing/hook.mjs` -- the
   0-divergence transcription of the same function -- carries the repr. The settings transcription
   did not, and no case there read the message. The measurement lane's `--version=x` case does, and
   asserting it against the merged parser is what surfaced the gap.
2. **A `choices` action rendered its metavar as `DEST`.** argparse renders `{a,b}` when no metavar is
   declared, and it is the only place `--help` says what the accepted values ARE. On the settings
   flags the two agree wherever a metavar is declared, so nothing there ever showed it; consolidating
   would have turned `--fingerprint {aggregate,content}` into `--fingerprint FINGERPRINT` and taken
   the list off the screen.

`--help` and the usage line are also **wrapped** now, at the fixed 79 columns the measurement lane's
parser used -- fixed rather than the terminal's, so that what a case reads does not depend on the
window it ran in. The settings help strings are short and the measurement ones are paragraphs; merged
and unwrapped, `continuo measure report --help` was a 260-column usage line and a wall of soft-wrapped
prose. The rendered usage now matches CPython's on the same command tree exactly.

**What was measured.** A replica of the merged command tree was built in CPython 3.12.3 and driven
over eighteen argv vectors covering every re-pointed case and every message this port emits: the
extras-at-the-root behaviour, the child-raised refusals, `invalid int value` for `1.5` / `0x10` / the
empty string, the underscore spelling being *accepted*, `ignored explicit argument 'x'`, the
negative-number value, the full-width digits CPython accepts and this port refuses, and the usage
rendering. Beyond that, the whole suite is the check that matters: **the 106 settings cases, the 92
sandbox cases and the 18 argparse-behaviour target-only cases pass against the merged parser
unchanged**, which is the positive evidence that the transcription is the side that did not have to
move.

**Test-count delta: +1, from three changes.** Two target-only cases added -- one pinning that the root reports extras, one pinning the two help-screen repairs above -- and one case removed from `test/contract/ascii-output-policy.test.ts`, which parametrises one case per scanned source file and now scans one file fewer, because two parser modules became one. No ported case was added, removed or re-dispositioned; the three ledgers record the re-pointings.

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

## D-0118 -- The last two measurement files convert whole, and the copy is verified by the testkit rather than by an opener

**Context.** D-0029 closed the control-plane belt's conversion and named `latency.test.ts` as the
one measurement file still building a production control plane per case. It undercounted by one, in
the same way issue 37's survey undercounted the spike files: `provenance.test.ts` builds one per case
too, 46 times, and is the heavier of the two. PR 50's run put a number on it -- the slow
`windows-latest` cell blew the 60s per-test cap at **81s** inside this file, on the single case that
builds **five** control planes rather than one. (The task brief said four; read line by line the case
takes `productionDb` five times -- `first`, `second`, `onlyInteger`, `nocaseA`, `nocaseB` -- and the
count is recorded here because the exclusion judgement below is a per-call-site judgement and an
off-by-one in the census is the thing that would hide a site.)

**Decision.** Both files convert, and **every one of their 65 fixture call sites converts** -- 46 in
`provenance.test.ts`, 19 in `latency.test.ts`. There are no exclusions in either file. As in D-0029
that is not an oversight of D-0028's two exclusion kinds; it is that no kind is present. Judged per
call site and measured, not argued:

- **Nothing here has creation as its subject.** Each file contains exactly one
  `createProductionControlPlane` call, in its own fixture. `provenance.test.ts` builds two databases
  by hand -- the non-production header case and the empty-ledger case -- and neither goes through the
  fixture, so neither moves.
- **Nothing here asserts what an opener would verify.** `latency.test.ts` never mentions
  `application_id`, `user_version` or a schema stamp. `provenance.test.ts` does, in one case, and it
  is the shape that is *not* excluded: it reads `application_id`, `user_version` and the migration
  head **off the database it was handed** and asserts the header agrees with them. A copy carries all
  three verbatim, so the case is comparing the header against the same file it always was.
- **Nothing here patches a seam before taking its fixture.** Neither file contains a `patchSeam`
  call at all, so D-0028's falsifier -- a seam replaced before the lazy template build runs inside
  whichever case copies first -- cannot arise.
- **Nothing here needs a database that does not exist yet.** Neither file contains an `existsSync`,
  an `unlinkSync` or any assertion about a file's absence, which is D-0027's fourth property.

**D-0027's other half does not apply on this belt, and the testkit covers what it was for.** A
converted control-plane fixture returns a *connection*, and D-0027 has it opened through
`openProductionControlPlane` so that a template which failed to build is a refusal rather than a case
running quietly against the wrong schema. A measurement fixture returns a **path**: the case opens it
itself, through `openForMeasurement` or a plain writable handle, and there is no public entry point
for the fixture to route through. The guarantee is not lost, because `suiteTemplate` already provides
it directly -- it memoizes the build's *outcome*, rethrows the same failure into every later case, and
raises if the build function returned without leaving a file at the path. That is why
`cohort.test.ts`, `render.test.ts`, `known-holes.test.ts` and `cli.test.ts` are already this shape;
this entry records the reason rather than leaving it to be re-derived a fifth time.

**`provenance.test.ts` keeps its fixture's filename parameter.** `productionDb(name)` names the copy,
because three cases build a second, third, fourth and fifth database to compare digests across and
depend on the paths differing. `suiteTemplate.copyInto`'s `as` argument carries it, so the call sites
are untouched.

**Measurement.** Per case, on this Linux box: **42.5ms** to create a production control plane against
**0.68ms** to copy one (N=30). Per file, tests-only wall clock: `provenance.test.ts` **4.18s to
1.17s**, `latency.test.ts` **0.92s to 0.17s**. The case that blew the Windows cap goes **295ms to
126ms** run alone, and the 126ms still contains the file's single template build, which a full-file
run amortises. As in D-0029 the Linux figures understate the point: what is removed is one fsync per
case, and it is the Windows cells that pay for fsyncs.

Verified the way D-0028 and D-0029 were, by making each template's build throw and reading which
cases go red:

- `provenance.test.ts`: **71 of 77** red. The file has 47 case-producing declarations, 41 of which
  take the fixture; one of those 41 is a `parametrize` over the 31 section-6 fields, so 40 + 31 = 71.
  The 6 green are exactly the 6 declarations that never call `productionDb`, by name.
- `latency.test.ts`: **19 of 23** red, matching the 19 fixture call sites one for one, with no
  `parametrize` in the file.

Wall-clock improvement alone would not have shown which call sites actually moved, and in
`provenance.test.ts` the red count is not the call-site count -- the parametrised block is one site
and 31 cases. The reconciliation above is what makes the two numbers agree.

**Alternatives.**

- **Raise the per-test timeout above 60s (rejected, D-0029's position kept).** Issue 37: "The cap is
  not the fix -- the testkit template is." The brief for this task forbids it outright.
- **Convert `latency.test.ts` only, as D-0029's sentence literally named (rejected).** It is the
  smaller of the two and not the file that failed. Leaving `provenance.test.ts` would have kept the
  type-A flake source and handed the next PR the same coin-flip on a slower cell.
- **Give `provenance.test.ts`'s tie-digest case a template of its own holding the `probe` table
  (rejected, D-0027's rule kept).** Each of its five databases gets a *different* `probe`, which is
  the whole subject; the rows stay per-case and the template stays the same four lines every other
  converted file declares.

**Consequences.**

- Case counts are unchanged file by file -- 77 and 23 -- and this branch adds no case to the suite.
  Measured both ways: 1834 on `b552317` and 1834 on this branch across five seeds before D-0030
  landed, then 1835 on `origin/main` and 1835 here after merging it. The +1 is D-0030's, in
  `test/measurement/cli.test.ts`; the two settings files it also touched changed their imports and
  their parser, not their case counts.
- No ledger changes. Nothing about what is ported changed, only what the fixture copies.
- This closes the type-A Windows pace-flake sources: no test file in the port now builds a production
  or spike control plane per case.

**Falsifier.** A case in either file that comes to need a database which does not exist yet, that
asserts a stamp or fingerprint against a constant rather than against the file it was handed, or that
patches a `migratorSeams` or `schemaSeams` entry before taking its fixture -- the two records on the
path the template's lazy build runs through. Any of the three puts that case back on
`createProductionControlPlane`, the way D-0028's four are.

**Status.** accepted

**Source.** Task `continuo-provenance-latency-template`, 2026-08-28, after the PR 50 CI observation.
Measured on Node 22.17.0, better-sqlite3 13.0.3, vitest 4.1.11. Decision id allocated by the window.
---

## D-0031 -- The source inventory is complete and unconditional; porting intent is recorded separately

**Context.** `parity/source-inventory/` held 1,317 node ids: `control_plane`, `measurement`,
`fencing` and `settings` -- the four subsystems interlock#74's acceptance criteria name, and the four
belts had ported. Interlock's suite at `65f36c5` is 2,199. The 877 collected node ids that were not in
it -- and the five modules pytest never collects at all -- were recorded nowhere: not as ported,
not as deferred, not as declined. "Is anything missing?" had no
answer, because the only list that existed was the list of things someone had already chosen to
look at.

Completing the inventory raises a question the four-subsystem version never had to answer. An
inventory is *evidence that a case exists*. A porting plan is a *commitment*. They were the same
list while the list was exactly the ported subsystems, and they cannot stay the same list once it is
complete -- `tests/gate_record/` makes structural assertions about **interlock's own
`docs/gate-record.md`**, a document continuo does not have; `tests/scrub/` verifies a Python
developer tool that runs over interlock's captured state. Writing those into a shared list makes a
porting decision by filing a snapshot.

The tempting resolutions both fail:

- **Inventory only what will be ported.** Then the denominator moves with every decision, the
  reconciliation against 2,199 is impossible, and the completeness question is answered "nothing we
  chose to look at."
- **Inventory everything and read the inventory as the plan.** Then filing evidence commits the
  project to porting 2,194 cases, including tests about a document it does not own.

**Decision.** Three layers, with the boundaries enforced rather than described.

1. **The inventory files hold node ids and nothing else.** All 2,194, unconditionally, in collection
   order. No comments, no notes, no blank lines -- `scripts/parity-check.mjs` reads every non-empty
   line as a node id, so a `# deferred` line there is a source case that does not exist. The
   inventory answers one question, "what does pytest collect", and it answers it for the whole
   suite.
2. **`parity/source-inventory.manifest.json` holds everything *about* the inventory**: the interlock
   revision, the collection command and the Python and pytest versions behind it, the per-file and
   per-subsystem counts, and the reconciliation with the suite baseline. It also names the five
   modules a module-level `pytest.importorskip` stops pytest from collecting -- which is the only
   place they *can* be named, since they yield no node id.
3. **`parity/source-inventory.belts.md` holds porting intent**, per subsystem, as `in-scope`,
   `candidate-lane`, `retarget`, `decision-pending` or `not-porting`, with a reason. Every status
   there is a proposal. Confirming one is a human gate, and D-range allocation
   (see "How to use this file") is part of the same gate.

`scripts/source-inventory-check.mjs` enforces the layering: the shape rule keeps layer 1 free of
prose, the reconciliation rule keeps layer 2 honest about 2,194 + 5 = 2,199, and the
`unclassified` rule requires every subsystem in layer 2 to be named in layer 3. It checks that a
status was **given**, never which one -- a check that enforced today's answer would make changing it
a fight with CI, and the answers are exactly what is meant to change.

**Why the count of record is `pytest --collect-only`, not a scan of the source.** A static count of
`def test_` lines is wrong in both directions at once. It misses every `parametrize` expansion, and
it counts the ~250 test functions in the five quarantined modules that pytest never collects -- so
it is simultaneously too low and too high, by amounts nothing in the resulting file discloses. The
whole suite is collected in **one** run and split by path afterwards, because a single-directory
pytest run and a whole-tree one differ in conftest hooks and import order and can collect different
sets, silently.

**The reconciliation, and why 2,190 is not the denominator.** pytest reports a module-level skip
separately from the collected count: at `65f36c5` collection yields **2,194 node ids** and five
modules skip at import, and the suite run reports **2,190 passed, 8 skipped, 1 xfailed** -- 2,199
outcomes. 2,194 + 5 = 2,199. Five of the eight skips are those collection-time ones; the other three
have node ids and are in the inventory. **2,190 is a result breakdown, not a denominator**, and
quoting it as one understates coverage by nine cases while looking like a total.

**What this decision does not do.** It does not decide what continuo ports. Every status in
`source-inventory.belts.md` today was written by reading what each subsystem's tests drive and what
interlock's `PORTING_LEDGER.md` already classed the file as, and each is offered as a proposal with
its evidence attached.

**Falsifier.** If a belt starts and finds that its subsystem's proposed status was wrong in a way
that cost real work -- a `not-porting` subsystem it turns out continuo needs, or a `candidate-lane`
that cannot be ported at all -- the proposals were written too confidently and the document should
retreat to `decision-pending` plus evidence, rather than offering a status. Equally, if the three
layers are found being kept in sync by hand rather than by the check, the check is not covering
enough of the boundary.

**Source.** Task `continuo-remaining-inventory`, 2026-08-28. Codex design review of the same date
raised the layering as its Blocker and the evidence/commitment separation as a Major; both are
adopted here. Measured against interlock `65f36c5` on Python 3.12.3 with pytest 9.1.1. Decision id
allocated by the window.

---

## D-0032 -- Three not-porting proposals are ratified, and three belts start with D-ranges allocated

**Context.** D-0031 separated evidence from commitment: `parity/source-inventory.belts.md` holds a
porting-intent status per subsystem, every status was written as a proposal, and confirming one --
together with allocating a D-range to any belt that starts -- is a human gate. Until that gate is
passed, the document's `not-porting` rows decline nothing and its `candidate-lane` rows start
nothing.

**Decision.** The human gate was passed on 2026-08-28, in two halves recorded as one decision
because they were ratified together.

1. **Three `not-porting` proposals are ratified as decisions.** `gate_record` (64 cases), `scrub`
   (20) and `package_smoke` (1) -- 85 cases in all -- will not be ported, for the reasons
   `source-inventory.belts.md` already states per subsystem: `gate_record` asserts the structure of
   a document continuo does not have, and the technique is already held natively
   (`test/contract/carried-documents.test.ts`); `scrub` is interlock-side developer tooling whose
   TypeScript twin would be a second scrubber to keep in agreement with the first; `package_smoke`
   is package plumbing continuo already holds more strictly. The inventory itself is unchanged --
   all 2,194 node ids stay, per D-0031's layering -- but the effective porting target becomes
   2,194 - 85 = **2,109**: the pool of cases not declined, within which every unratified status is
   still a proposal, not a commitment to port all 2,109.
2. **Three belts start, with D-ranges allocated.** `session` (142 cases) takes `D-03xx`, `canary`
   (70) takes `D-04xx`, and `messagebus` (43) takes `D-05xx`; all three move from
   `candidate-lane` to `in-scope` with a belt start date of 2026-08-28. The ordering follows the
   dependency argument already in the belts document: `session` is the belt `gate_item2` and
   `gate_item11` wait on, `canary`'s store-enforced guarantees are the property continuo ports
   best, and `messagebus` is the destination the five quarantined broker modules are pointed at.

Statuses not named here are untouched and remain proposals; ratifying them is a later pass of the
same gate.

This is the gate D-0031 defined, exercised for the first time -- not a supersession of it. D-0031's
"every status there is a proposal" described the document as first written; it now holds for the
unratified rows, and the belts document marks ratified rows explicitly so the two states cannot be
confused. D-0031's three-layer boundary is unchanged.

**Falsifier.** For the first half, D-0031's falsifier applies with more force now that the answer
is ratified rather than proposed: if a belt finds it needs one of the three declined subsystems,
this entry is superseded, not edited. For the second half, if any of the three belts cannot in fact
be ported largely as its cases stand, the `in-scope` status retreats and the allocated range stays
burned -- ranges are permanent whether or not the belt completes.

**Source.** Ratified by the user on 2026-08-28, task `continuo-belts-ratification`. Decision id
allocated by the window in the shared band (`D-0019`..`D-0099`, see "How to use this file").

---

## D-0401 -- The canary routing ledger gets its own opener, and `recursive_triggers` is part of the store

**Context.** The canary's routing ledger is a separate SQLite file whose whole point is that its
guarantees are refused **in the store, not in the discipline of the writer** -- interlock's
`tests/canary/test_ledger.py` says so in as many words, and it is why this subsystem was ratified
into scope (D-0032). Continuo already has two openers: `src/control_plane/`'s, and the generic
`openDatabase` in `src/sqlite/open.ts`. Reaching for either was the obvious move and is wrong in
four separate ways.

**Decision.** `src/canary/ledger.ts` carries its own `createRoutingLedger` / `openRoutingLedger` /
`configureLedgerConnection`, sharing nothing with the control plane's but the shape of the idea.

1. **`recursive_triggers = ON`, on every writable connection, beside `foreign_keys = ON`.** This is
   the load-bearing one. `run_owner`'s immutability is enforced by `BEFORE UPDATE` and
   `BEFORE DELETE` triggers -- but with `recursive_triggers` at SQLite's default (OFF, and
   better-sqlite3's default too) `INSERT OR REPLACE` resolves a primary-key conflict with an
   **implicit DELETE that fires no trigger at all**, and the re-insert then passes every remaining
   guard. A run changes owning system mid-flight in one statement, which is precisely what gate
   item 10 forbids. The pragma is per-connection, so it cannot live in the file; it lives in
   `configureLedgerConnection`, which every connection this module hands out passes through.
   Two ported cases (`or_replace_is_not_a_way_around_the_owner_trigger`, and the same for the
   decision history) exist to catch this, and they catch it only because they route through the
   module's own opener -- a test that opened a raw handle would pass over the hole.
2. **No `journal_mode` pragma, ever.** The ledger stays on the rollback journal. `openDatabase` sets
   WAL, and WAL is both a header write and a pair of `-wal` / `-shm` sidecar files -- which would
   falsify, by construction, every assertion that a *refused* open left the file untouched. The
   control plane made the same choice for its own reasons (D-0012); this is that choice again, on
   different evidence.
3. **Verification runs on the connection that is returned.** Verifying one handle and then opening a
   second to hand back leaves a window in which the verified file is replaced -- or deleted, in
   which case a plain open creates the empty database the function promises never to make.
4. **Its own identity and its own fingerprint.** `application_id` is `0x494c4b43` (`ILKC`), distinct
   from the spike's `0x494c4b35` (`ILK5`), so a ledger handed to the control-plane opener -- or the
   reverse -- is refused as *some other database* rather than reported as one with missing tables.
   The expected schema fingerprint is **derived** on every verification by building the DDL into a
   `:memory:` database and hashing it, never pinned as a hex constant, so the schema and the value
   it is checked against cannot drift apart.

Creation claims its path with `openSync(path, "wx", 0o600)` and never `existsSync`-then-create: only
the process that actually created the file can reach the unlink-on-failure cleanup, so the loser of
a race cannot delete the winner's live store.

**Alternatives.**

- **Extend the control-plane opener with a `recursiveTriggers` option (rejected).** It would put a
  flag on a shared opener whose other caller must never set it, and the failure mode of getting it
  wrong is silent at both call sites. The two stores agree on almost nothing else -- application id,
  fingerprint, table set, refusal vocabulary -- so the shared surface would have been the `new
  Database` call and nothing more.
- **Set the pragma at the call sites that use `INSERT OR REPLACE` (rejected).** There are no such
  call sites in the port: `INSERT OR REPLACE` is what an *attacker* of the invariant writes, not the
  module. The pragma has to be on before anyone else's statement arrives.
- **Enforce immutability in TypeScript instead (rejected).** That is exactly the "discipline of the
  writer" the source file's framing rejects, and it would not survive a second writer.

**Falsifier.** If a future SQLite makes conflict-resolution DELETEs fire triggers unconditionally,
point 1 becomes belt-and-braces rather than load-bearing -- the pragma stays, but the reasoning
above stops being the reason. Measured on better-sqlite3 13.0.3 / SQLite 3.53.4: with
`recursive_triggers` removed from `configureLedgerConnection`, the two `or replace` cases go red and
nothing else does.

---

## D-0402 -- An already-routed run is recognised by result code and a re-read, never by message text

**Context.** `route_run_start` has to tell three situations apart: a run being routed for the first
time, a **retry** of a route that already happened (a router that crashed between the ledger write
and the system start may legitimately retry), and an attempt to move a started run to a different
owner. Interlock separates them by matching the SQLite exception's *text*:

```python
if "UNIQUE constraint failed: run_owner.run_id" not in str(error):
    raise
```

D-0016 already established that SQLite's message text is not a compatibility surface and its result
codes are. This is the case that makes the point sharpest, because the substring is doing real
control-flow work: get it too wide and a `CHECK` violation is silently absorbed as an idempotent
retry, and the run is reported as routed when nothing was written.

**Decision.** The port classifies on `sqliteCodeOf(error)` and then **confirms by re-reading**.
`SQLITE_CONSTRAINT_PRIMARYKEY` or `SQLITE_CONSTRAINT_UNIQUE` means "a row for this run already
exists"; the existing `run_owner` row and the current decision are then read back, after the
transaction has ended, and compared on `owningSystem` **only**. Equal is an idempotent no-op
returning the original row unchanged -- the retry's `nowMs` is discarded and the original
`decisionSeq` and `routedAtMs` are kept. Different is `OwnerChangeRefused`. Every other constraint
code -- `SQLITE_CONSTRAINT_CHECK`, `_FOREIGNKEY`, `_TRIGGER` -- is rethrown **as itself**: an
integrity failure that is not an ownership question is not one this method has an opinion about.

**Measured, and the reason this entry exists at all.** On better-sqlite3 13.0.3, a duplicate
`run_id` against `run_owner`'s `run_id TEXT PRIMARY KEY` returns code
**`SQLITE_CONSTRAINT_PRIMARYKEY`** while its message reads **`UNIQUE constraint failed:
run_owner.run_id`**. The code and the text disagree. A port that transcribed the source's substring
into a code check of `SQLITE_CONSTRAINT_UNIQUE` alone -- the reading the message invites -- never
reaches the idempotency path at all: three cases go red. Both codes are therefore accepted, and a
target-only case pins the disagreement itself so that a future driver quietly changing one of the
two is a red test rather than a behaviour change.

Comparing `owningSystem` and never `decisionSeq` is also load-bearing in both directions: comparing
the full row would turn a legitimate retry under a later decision naming the same owner into a
refusal, and comparing nothing would let a genuine owner change through.

**Alternatives.**

- **Pre-check with a `SELECT` before inserting (rejected).** It reintroduces the lookup-then-insert
  window the source's single-statement `INSERT .. SELECT` exists to close, against a rollback
  committing on another connection -- which is the run-boundary property under rehearsal.
- **Keep the substring match (rejected).** D-0016, and the measurement above: the text and the code
  do not even agree with each other here.
- **Accept any `SQLITE_CONSTRAINT*` (rejected).** That is the too-wide reading, and
  `an_idempotent_retry_does_not_absorb_a_validation_failure` is the source's own case against it.

**Falsifier.** If better-sqlite3 or SQLite changes which code a `TEXT PRIMARY KEY` conflict reports,
the target-only case that pins the pairing goes red first, naming the change. Measured 2026-08-28 on
better-sqlite3 13.0.3, SQLite 3.53.4.

---

## D-0403 -- The structural belt keeps its subject when the tree changes language

**Context.** `tests/canary/test_structural.py` is the one file in this belt whose subject is not
behaviour but **the source tree itself**: it walks each `canary/*.py` with Python's `ast` and asserts
the package imports no other interlock module, then probes its own guard with a file containing the
three ways around it (a relative sibling import, an import inside a function, one behind
`TYPE_CHECKING`). Ported naively, "assert over the Python tree" has no meaning in a TypeScript repo,
and the tempting repairs -- drop the case, or weaken it to a regex over filenames -- both turn the
strongest structural claim in the belt into decoration.

**Decision.** The case keeps its subject: the port asserts the same property over **its own** tree,
parsed with the TypeScript compiler API rather than matched with a regex, for the reason the source
prefers `ast` over a regex. The guard-probe case is ported too, against the port's own escape routes
-- a deep relative import, an import inside a function body, a type-only import, and a dynamic
`import()`.

**One import is allowed, explicitly and narrowly: `src/sqlite/errors.ts`.** Interlock's routing layer
imports only `sqlite3`, `dataclasses` and its own package, and that poverty is what the source case
asserts. The port cannot match it exactly, because D-0402 forbids classifying SQLite failures by
message text and the code-based replacement lives in `src/sqlite/errors.ts` -- a module Python has no
counterpart for, since its `sqlite3` exception classes are built in. The allowance is written into
the test as a single named exception with the reason beside it, and the three affected cases are
recorded as `adapted` in `parity/canary.structural.ledger.json`. Nothing else outside `src/canary/`
is permitted: not `control_plane`, not `session`, not any provider layer.

`src/canary/routing.ts` therefore carries its own ~20-line private `repr()` rather than importing
`src/control_plane/python_repr.ts`, which would widen the allowance to a second module for a
cosmetic reason. The duplication is deliberate and is the smaller cost.

The written record moves with the code: `docs/canary-routing-rehearsal.md` is ported from
interlock's, with paths and identifiers rewritten to continuo's per D-0017 rule 1, every design claim
kept, and one added paragraph disclosing the `src/sqlite/errors.ts` allowance -- because a durable
artifact that still said "it imports no other module" would be a document asserting something the
tree does not do. `Q-0005` stays explicitly open there; no numeric go/no-go criterion is stated.

**Alternatives.**

- **Copy the two needed predicates into `src/canary/` (rejected, and rejected by the window's human
  gate on 2026-08-28).** It would buy literal import poverty at the price of a second SQLite error
  classifier to keep in agreement with the first -- against D-0016's whole point, which is that the
  mapping is written down **once**.
- **Match imports with a regex (rejected).** The guard-probe case is precisely the case a regex
  fails; the source wrote that case because it did not trust itself either.
- **Drop the two tree-walking cases as unportable (rejected).** They are the belt's structural
  claim. A `not-ported` row here would be the most misleading row in the ledger.

**Falsifier.** If the canary ever genuinely needs a second module outside its package, this entry is
superseded rather than edited, and the allowance list is not simply extended in passing -- the point
of a one-item list is that adding to it is a decision.

---

## D-0404 -- The ledger DDL is a shipped data file, and the belt asserts it reached `dist/`

**Context.** `routing_ledger.sql` is loaded at runtime from a path resolved against the module
(`import.meta.url`), exactly as the spike schema is, so that an operator can read and diff the DDL
without importing code -- and so that `loadLedgerSql`'s rehearsal-marking guard is checked against
the artifact people actually read. `tsc` emits JavaScript and declarations; it does not copy data
files. A build without a copy step therefore ships `dist/canary/ledger.js` beside no SQL at all, and
because the path is only resolved when it is used, the failure appears at the first `create` **or**
`open` -- a module that refuses everything.

**Decision.** `scripts/copy-canary-schema.mjs` copies `src/canary/routing_ledger.sql` into
`dist/canary/`, verifies the result **byte for byte**, and is wired into `npm run build` alongside
the five copy steps already there. Byte-for-byte matters twice here: the schema fingerprint hashes
this file's exact bytes, so a copy that normalised so much as a line ending would make a packaged
build's fingerprint disagree with a database written from the source tree.

The placement is **asserted by a target-only case**, not left to the build script's own check. The
typical accident is a belt that is green in the source tree while `dist/` silently lacks the asset,
and neither the suite nor the type-checker would notice -- the failure only shows up for whoever
installed the package. The case carries no warrant from interlock, which packages data files by a
different mechanism entirely, so it is target-only rather than a translation of anything.

**Alternatives.**

- **Inline the DDL as a TypeScript string (rejected).** It removes the copy step and the whole
  reason the file exists: the marking guard would then check a string in the same module that
  applies it, which is a check with nothing on the other side of it, and the operator-readable
  artifact would be gone.
- **Trust the copy script's own byte check and skip the test (rejected).** That verifies the copy
  ran when it ran; it does not verify the build wired it in. Removing the `&&` from `package.json`
  is the failure being guarded against, and only a test that reads `dist/` catches it.

**Falsifier.** If the build moves to a bundler that carries assets natively, the copy step becomes
redundant and this entry is superseded -- but the target-only placement case stays, because its
subject is the built artifact, not the mechanism that filled it.

---

## D-0405 -- The `INSERT OR REPLACE` bypass is real, and repairing it is its own change

**Context.** The routing ledger's headline guarantee is that no run changes owning system
mid-flight, and that this is refused **by the store, not by the discipline of the writer**. D-0401
records how that is held: `BEFORE UPDATE` and `BEFORE DELETE` triggers, plus
`recursive_triggers = ON` on every connection this package hands out, because with the pragma off
`INSERT OR REPLACE` resolves a conflict with an implicit DELETE that fires no trigger.

The review gate raised the obvious question the pragma leaves open: the pragma is **per-connection**,
so what about a connection this package did not hand out? Interlock's own DDL concedes the point in
a comment. The gate is right, and this entry records the measurement rather than the concession.

**Measured** (better-sqlite3 13.0.3, SQLite 3.53.4, 2026-08-28). Against a ledger created and routed
through this package's own API, an ordinary `new Database(path)` -- no pragmas, which is every
caller that has not read `ledger.ts` -- ran

```sql
INSERT OR REPLACE INTO run_owner (run_id, owning_system, decision_seq, routed_at_ms)
VALUES ('run-1', 'interlock', <seq>, 4)
```

and **succeeded**: the owner moved from `synthetic_v1` to `interlock` mid-flight. The tampered
ledger then **passed `openRoutingLedger` in full** -- `integrity_check`, `application_id`,
`user_version`, table presence, schema fingerprint and `foreign_key_check` all hold, because
ownership is data and none of those rungs reads it. So the guarantee is real against every writer
that goes through this package and absent against one that does not, and nothing downstream notices.

**The repair works, and it cannot land in this belt.** A schema-level `BEFORE INSERT` guard on
`run_owner` that refuses an insert whose key already exists closes the hole completely, and --
measured -- closes it **with `recursive_triggers` OFF as well**, because a `BEFORE INSERT` trigger
fires ahead of conflict resolution. That is the right fix. It is not available here, for two reasons
that are the same reason twice:

1. Firing ahead of conflict resolution is exactly what makes it work, and it means an ordinary
   duplicate `INSERT` now raises `SQLITE_CONSTRAINT_TRIGGER` where it raised
   `SQLITE_CONSTRAINT_PRIMARYKEY`. That is the signal D-0402's idempotent-retry path classifies on,
   so the routing point's conflict handling has to be re-decided with it.
2. Worse, and decisive: the two ported cases `or_replace_is_not_a_way_around_the_owner_trigger` and
   `..._the_decision_history` assert the refusal's **message**, matching `never deleted` -- the
   delete trigger's own sentence, which is what interlock's `match=` pins. A guard that fires first
   changes that message. Repairing the defect inside this belt would therefore require rewriting
   what two of the seventy translated cases assert, and they would then assert something interlock's
   suite does not say. That is the failure `docs/test-translation-conventions.md` rule 0 exists to
   prevent, and it is not a trade a translator may make on their own.

**Decision.** The defect is **not disclosed and left** -- D-0023 removed that option, and this entry
is not an appeal to "inherited". It is **scheduled as its own change**, which is the escape D-0023's
second bullet provides for a repair too large for the belt in hand. That change owns, together: the
schema guards, the D-0402 re-decision, the re-pointing of the two ported cases onto the new refusal
(recorded as deliberate divergences, with interlock's assertions kept visible in the ledger), and a
target-only case that reproduces the measurement above -- a foreign connection must fail to move an
owner. Until it lands, `parity/canary.routing-ledger.ledger.json` carries the defect with a pointer
to this entry, so the trail D-0023's third bullet requires is reachable from the ledger.

Continuo's own store gains a divergence from interlock's DDL when that change lands. That is
expected and is the point: interlock is frozen, so continuo is where this can be true.

**Alternatives.**

- **Repair it here and adjust the two cases' expectations (rejected).** It buys a real fix at the
  cost of the belt's claim to be a faithful translation, in the same commit that claims 70/70. The
  two are separable and should be separate.

**Carried out** (2026-08-29, continuo#55). Both `..._is_never_replaced` guards are in
`routing_ledger.sql`; the re-decision this entry booked is **D-0406**, which also records the one
thing the measurement here did not anticipate -- that a `BEFORE INSERT` guard runs ahead of `CHECK`
constraints too, so the guard has to defer to them or it swallows a validation failure. The two
ported cases are re-pointed onto the new refusal and recorded as deliberate divergences in
`parity/canary.routing-ledger.ledger.json`, with interlock's `match=` kept visible beside each;
the measurement above is now a target-only case driving a foreign connection. The [P2] the belt left
open beside this one is closed by **D-0407**. What this entry predicted has held: continuo's store
now diverges from interlock's DDL, which is the point of the entry rather than a cost of it.
- **Widen the refusal assertions to match either message (rejected).** A pattern satisfied by both
  the old and the new sentence is a pattern that stops testing which guard fired -- and which guard
  fires is the entire subject of the repair.
- **Set the pragma defensively from more places (rejected).** There is no place to set it: the
  hostile writer is one this package never sees.

**Falsifier.** If SQLite ever fires conflict-resolution DELETEs through triggers regardless of
`recursive_triggers`, the bypass closes on its own and the scheduled change reduces to deleting this
entry's reason for existing. Re-run `tmp/`-style probe: create a ledger, route a run, then attempt
the `INSERT OR REPLACE` above on a bare connection.

---

## D-0406 -- With the replacement guard in place, an already-routed run is a trigger refusal confirmed by a re-read

**Context.** D-0405 scheduled the repair of the `INSERT OR REPLACE` bypass and named the price:
the guard that closes it is a `BEFORE INSERT` trigger, and a `BEFORE INSERT` trigger fires **ahead
of conflict resolution**. That is what makes it work on a connection with `recursive_triggers` OFF,
and it is also what puts it ahead of the primary key. So the duplicate `run_id` that D-0402
measured as `SQLITE_CONSTRAINT_PRIMARYKEY` now arrives as `SQLITE_CONSTRAINT_TRIGGER`, and that is
the signal `route_run_start`'s idempotent-retry path classifies on. **This entry re-decides D-0402's
classification for the changed code; everything else D-0402 decided still stands** -- the ban on
message-substring matching (D-0016), the confirmation by re-read, and the comparison on
`owningSystem` only.

Firing ahead of conflict resolution has a second consequence D-0402 never had to face, and it is
the one that makes this more than a widened set. `SQLITE_CONSTRAINT_PRIMARYKEY` and
`SQLITE_CONSTRAINT_UNIQUE` are **specific**: on `ROUTE_RUN_START_SQL`, which writes only
`run_owner` and whose only uniqueness is `run_id`, either one can mean exactly one thing.
`SQLITE_CONSTRAINT_TRIGGER` is **not**: five triggers in the DDL raise it, and one of them --
`run_owner_matches_its_decision` -- sits on this very statement. A port that simply added the third
code to the accepted set would read any trigger refusal as "already routed" and hand back a row for
a write that never happened.

**Decision.** The accepted set gains `SQLITE_CONSTRAINT_TRIGGER`, and the classification becomes
two-stage:

1. **The code proposes.** `SQLITE_CONSTRAINT_PRIMARYKEY` / `_UNIQUE` keep D-0402's meaning
   unchanged, and their path through the method is untouched -- including the fact that a re-read
   finding no row surfaces as `UnroutedRun`, which is the source's own shape.
2. **The store disposes, for `_TRIGGER` only.** The `run_owner` row is read back before the error
   is read as an ownership question. A row means the replacement guard is what fired, and the
   existing idempotent-retry / `OwnerChangeRefused` decision runs on it exactly as before. **No row
   means some other trigger fired, and the error propagates as itself** -- the same disposition
   every non-ownership integrity failure has had since D-0402.

The asymmetry between the two branches is deliberate and is the point: the wider code gets the
stricter confirmation, because it is the only one of the three that more than one constraint can
produce.

**The guard defers to the row's own CHECKs, and that is load-bearing here rather than tidiness.**
SQLite runs `BEFORE INSERT` triggers ahead of constraint checking (measured: a duplicate insert
carrying a `TEXT` value in an INTEGER column reports the trigger, not the `CHECK`). A guard whose
`WHEN` were a bare `EXISTS (...)` would therefore answer a malformed duplicate with "you may not
replace this", the re-read would find the standing row, and the retry would be reported as an
idempotent success **with nothing written** -- which is precisely what the ported case
`an_idempotent_retry_does_not_absorb_a_validation_failure` exists to forbid, and it would have gone
red. So `run_owner_is_never_replaced`'s `WHEN` restates the column CHECKs and stands aside for a row
the table would reject anyway: a malformed retry is a `CHECK` failure, reaches neither branch above,
and passes through as itself. The restatement is duplication in the DDL, and it is written down
there in capitals, because a CHECK added to `run_owner` and not to the guard would reopen this
quietly.

**The sentinel `routing_decision` has to reserve.** SQLite gives `NEW.decision_seq` the value
**-1** in a `BEFORE INSERT` trigger when the insert supplies no sequence -- the manual calls it
undefined; measured on SQLite 3.53.4 it is -1, on an empty table and a populated one alike. The
guard asks whether `NEW.decision_seq` is already in the table, so a row stored **at** -1 would make
every ordinary, sequence-omitting append look like a replacement and be refused: a working ledger
bricked by a value only an out-of-band writer could have put there.

`CHECK (decision_seq >= 0)` reserves the negative half, and it has to be the half rather than the
one value: SQLite assigns an omitted rowid as **MAX + 1**, so a stored -2 makes the next
auto-assigned sequence -1 -- the sentinel arriving as the value being *written* rather than the
value being *matched*. Excluding everything negative closes both directions at once, and with 0 the
smallest legal sequence an auto-assignment is always 1 or more. Any other value the undefined case
might take is harmless on its own terms: it matches no row, the guard stands aside, and standing
aside is the right answer for an insert that cannot collide.

**Zero stays legal, deliberately.** `routing_decision_is_appended_in_order` is what refuses a
back-filled sequence, and the ported case that pins it inserts 0 and matches that trigger's
sentence; a CHECK swallowing 0 first would leave that case green while it asserted something else.
Both boundaries are pinned by target-only cases so neither can be widened quietly.

Raised as [P2] by the review gate on this change, in two rounds -- the stored sentinel first, the
assigned one second -- reproduced each time, and closed here rather than disclosed. `run_owner`
needs nothing equivalent: `run_id` is not a rowid alias, so `NEW.run_id` is always the value the
insert supplied.

**Measured** (better-sqlite3 13.0.3, SQLite 3.53.4, 2026-08-29). With both guards in place: a
duplicate `run_id` reports `SQLITE_CONSTRAINT_TRIGGER` with the guard's sentence and no longer
reports `UNIQUE constraint failed: run_owner.run_id` at all; a duplicate carrying a non-integer
`routed_at_ms` reports `SQLITE_CONSTRAINT_CHECK`, as does a duplicate `decision_seq` naming a system
outside the vocabulary or carrying an empty reason (each guard's `WHEN` restates every CHECK on its
table, which is why); `INSERT OR REPLACE` is refused on a connection whose `recursive_triggers`
reads 0, with the standing row unchanged; and an explicit `decision_seq` of -1 or -2 is refused by
CHECK with appends still appending after it. All 87 cases of the canary belt are green, and the two
ported `or replace ...` cases changed only the sentence they match.

**Alternatives.**

- **Accept `_TRIGGER` unconfirmed (rejected).** It is the too-wide reading D-0402 already rejected
  once, one code along: `run_owner_matches_its_decision` raises the same code on the same statement.
- **Keep the guard out of `run_owner` and repair only `routing_decision` (rejected).** Ownership is
  the guarantee the belt is named for; repairing the lesser half would be a change that looks like
  the repair and is not.
- **Distinguish the guard by its message (rejected).** D-0016. The message is what D-0402 refused to
  classify on, and the guard's own sentence is not a compatibility surface either.
- **A bare `EXISTS (...)` guard, and re-point the validation case too (rejected).** That case is
  interlock's, its subject is the exact confusion the bare guard would create, and rule 0 does not
  let a translator trade it away. The `WHEN` clause costs four predicates and keeps it.

**Falsifier.** `test/canary/routing.test.ts::target-only -- the duplicate run conflict is the
replacement guard, not the primary key` goes red if the code changes back, and
`test/canary/ledger.test.ts::target-only -- the replacement guard defers to the row's own CHECKs`
goes red if the `WHEN` clause is simplified. If SQLite ever runs `CHECK` constraints ahead of
`BEFORE INSERT` triggers, the second becomes unnecessary rather than wrong.

---

## D-0407 -- The routing point reads its INTEGER columns 64-bit wide

**Context.** The canary belt's review gate raised, and the belt left open as a [P2], the last of
three 64-bit narrowings in this package: `routeNewRunsTo` took `lastInsertRowid` through
`Number(...)`, and `currentDecision` / `routedRun` read `decision_seq`, `decided_at_ms` and
`routed_at_ms` as JavaScript numbers. SQLite's INTEGER is 64-bit and Python's `int` is arbitrary
precision, so this is the port's own defect and not interlock's: a ledger carrying a `decision_seq`
at or past 2**53 -- which the schema permits -- would have been reported with a sequence id or a
timestamp that disagreed with the stored row by one, presented as the store's own value.

It was left open in the belt with a stated reason: the two narrowings that **were** repaired sat on
the audit digest and the rollback comparison, where a wide value arrives as ordinary data in any
audited column and the failure is silent and evidential -- a changed store reported as untouched.
This one is reachable only by a writer that inserts an explicit `decision_seq` past 2**53, which no
continuo API can do. That writer is the out-of-band one D-0405 is about, so the belt recorded it in
`parity/canary.routing.ledger.json` and pointed it at this change, where the classification it sits
beside was being re-decided anyway.

**Decision.** The three statements run with `safeIntegers(true)`, and every integer read is passed
through a local `narrowInteger` that returns a `number` when a double holds the value exactly and
leaves a `bigint` when it does not -- the same rule, and the same five lines, `src/canary/audit.ts`
already applies to the digest and the rollback rows. `RoutingDecision.decisionSeq` /
`.decidedAtMs` and `RoutedRun.decisionSeq` / `.routedAtMs` widen to `number | bigint`
(`LedgerInteger`).

**Why narrow back rather than always return `bigint`.** Every value any continuo API can write is
inside the safe range, so narrowing keeps the observable type exactly what it was for every ledger
this package can produce -- the ported cases still compare `decisionSeq` with `toBe(1)` and
`toBe(3)`, which a `bigint` fails. The widening is visible only where the alternative was a wrong
answer.

**Why not refuse a wide value instead.** `measurement/fixtures.ts` refuses beyond
`Number.MAX_SAFE_INTEGER` (D-0007), and that is right where the value is a caller's input being
validated. Here the value is already in the store, written by someone else; a reader whose job is
to report what the ledger holds should report it, not refuse to look. Refusing would also give
`currentDecision` a new refusal type the source has no counterpart for.

**Known and left: the boundary is the safe range, not exact representability.** A stored value a
double happens to hold exactly but which sits outside the safe range -- 2**53 itself -- comes back
as a `bigint` where `routeNewRunsTo` returns the `number` its caller passed. `Number.isSafeInteger`
is the boundary this repo already draws for the same question in `src/canary/audit.ts` (twice, over
this very ledger's integers), `src/measurement/ac9.ts` and `src/measurement/fixtures.ts` (D-0007),
so narrowing here on a different rule would give the routing point and the audit two different
answers about the same column of the same store -- the drift D-0017 rule 4 exists to prevent, and a
worse trade than a type that differs past 2**53. Raised as [P2] by the review gate on this change
and recorded in `parity/canary.routing.ledger.json`. Moving the rule is a decision that moves all
four sites together; it is not this entry's to make unilaterally.

**Falsifier.** `test/canary/routing.test.ts::target-only -- a decision sequence past 2**53 survives
the round trip` writes 2**53+1 through a foreign connection and asserts the value comes back
identical; with `safeIntegers` removed it reads 9007199254740992 and the case goes red naming the
loss.
## D-0301 — The five session verbs are `Promise`-returning, serialised per instance, and the capability probe stays synchronous

**Context.** The `session` belt (D-0032) ports interlock's `tests/session/` -- 142 node ids over
`claude_org_runtime/session/`. The source is written against Python's blocking process API and uses
it as a load-bearing guarantee, not as a convenience. `stop()` runs a `SIGTERM` -> `Popen.wait(
timeout)` -> `SIGKILL` -> `wait(timeout)` ladder; a pid that cannot be recorded triggers an
immediate group `SIGKILL` followed by a bounded wait; an orphan whose supervisor died is chased
through two `time.monotonic()` deadlines polling at `time.sleep(0.05)`; and a group sweep after
exit does the same again. Nothing in that is decoration -- `test_a_child_that_outlives_the_
emergency_kill_is_not_abandoned`, `test_stop_reaps_a_group_member_that_outlived_the_leader` and
their neighbours assert the ladder's *outcomes*.

Node's `ChildProcess` is asynchronous, so the shape of the port is a decision that has to be taken
before the first case is typed: retrofitting it through 142 cases is the belt's largest re-work
risk. The question was raised as the Blocker of the pre-belt design review.

**The measurement that settles it.** A child's exit status in Node is held by libuv and released
only on a loop turn. Spawn a child that exits at t=200ms, then block the loop to t=1500ms and poll
(Node v22.17.0, Linux 6.18.33.2 WSL2):

```
t= 300ms  exitCode=null  signalCode=null  kill(pid,0)=true  /proc/<pid>/stat state=Z
t= 600ms  ... identical
t= 900ms  ... identical
t=1200ms  ... identical
after 5000 microtask turns (await Promise.resolve())   exitCode=null
after one macrotask turn (setTimeout(0))               exitCode=7, /proc state ENOENT
```

So an in-process **synchronous** `stop()` ladder has three candidate waits and all three are wrong:
busy-waiting `child.exitCode` never observes an exit, so every stop escalates to `SIGKILL` and then
reports `TIMED_OUT` after `2 x stop_timeout`, on every stop; busy-waiting `kill(pid, 0)` sees the
unreaped zombie as alive forever, identically; and busy-waiting `/proc/<pid>/stat != "Z"` terminates
correctly but never yields a return code, because reaping is libuv's -- which permanently destroys
the `exited-<returncode>` state word for a child of ours.

The second half of the measurement is what rules out the reflex fix: microtask asynchrony buys
nothing. `await Promise.resolve()` 5000 times leaves `exitCode` at `null`; one `setTimeout(0)`
releases it. Making the verbs `async` is necessary but not sufficient -- a *macrotask* yield is
required before any read of a child's exit state.

**Decision.** Four parts, taken together because each of the last three is a defect the first one
ships without it.

1. **The five D-0009 verbs are `Promise`-returning.** `start`, `listSessions`, `readState`, `stop`
   and `resume` return `Promise<ProviderResult<...>>`, in the abstract base and in both providers.
   `start` stays concrete and final on the base -- `requireSpawnable()` then
   `this.startSession(request)` -- so the four contract cases that pin the gate's identity
   (`test_a_subclass_cannot_override_the_gate_away[start]`, `[require_spawnable]` and the two mixin
   variants) still resolve `start` to the base's own function. `startSession` remains the only
   `_`-prefixed hook, so `test_exactly_the_five_d0009_verbs_and_no_sixth` and
   `VERB_IMPLEMENTATION_HOOKS` are unchanged.

   The asynchrony is imposed **from below and on the shared contract**, not chosen per provider:
   `stop` needs a wait in *both* providers, and Node reports a spawn failure asynchronously where
   Python's `Popen` raises `OSError` synchronously (measured: `spawn("/no/such/binary")` returns
   with `pid === undefined` and fires `'error'` on a later turn), which is the classification
   `test_a_child_that_cannot_be_spawned_is_a_failure` and its neighbours assert.

2. **The capability probe stays synchronous.** `probeCapabilities`, `requireSpawnable`,
   `checkSpawnPrecondition`, `registerWorkspaceObserver`, `evaluateWorkspaceTransition` and every
   value constructor are synchronous. This is not a concession to tidiness: `subprocess.run(...,
   timeout=)` has an **exact** analogue in `spawnSync`, measured to match on both branches the
   source distinguishes -- a missing executable returns `{status: null, error.code: "ENOENT",
   error.errno: -2}` synchronously (Python's `except OSError`), and a timeout returns
   `{status: null, signal: "SIGKILL", error.code: "ETIMEDOUT"}` with the child already killed
   (Python's `TimeoutExpired`), provided `killSignal: "SIGKILL"` is passed, because Node's default
   is `SIGTERM` where `subprocess.run` sends `kill()`.

   Keeping the probe synchronous is what lets
   `test_require_spawnable_is_the_contracts_own_gate_not_each_implementations` port unchanged, and
   it keeps the observer fan-out sequential, so
   `test_every_observer_is_asked_even_after_a_veto`'s ordering assertion keeps its teeth with no
   "sequential await, never `Promise.all`" caveat attached to it.

3. **The five verbs are serialised per provider instance.** Each public verb body runs inside a
   per-instance exclusion queue. In Python, `read_state` **cannot** run while `stop` is mid-ladder
   -- one thread -- so the source gets mutual exclusion from its language for free. Without the
   queue, a `readState` could interleave at any `await` inside `stop` and observe a half-finished
   ladder: record replaced, incident recorded, exit not yet confirmed, the in-memory session map
   already mutated. That is a state **no source case can construct and none forbids**, so nothing
   in the ported suite would catch it -- which is precisely why it is decided here rather than left
   to be discovered. No verb calls another verb in either provider, so the queue cannot deadlock.

4. **Every read of a child's exit state is preceded by one macrotask yield.** The runtime adapter
   exposes it as `settleExits()`, implemented with a real macrotask and never with
   `await Promise.resolve()`, per the measurement above. Six cases take a readout immediately after
   a state change; without the yield they are flaky in the "the child has exited but `exitCode` is
   still `null`" direction, which under the shuffled double-green order (D-0005) is the worst
   available failure shape.

The asynchronous surface is confined to one internal runtime adapter (the design review's Major),
and within it **exactly four members are asynchronous** -- `spawn`, `waitForExit`, `sleep` and
`settleExits` -- because those are exactly the sites that wait on an already-running child.
Everything else the adapter carries is synchronous in Node as it is in Python: `spawnSync` for the
probe, `performance.now()` for the monotonic clock, `process.kill(-pgid, sig)` for group signalling,
and `readFileSync` for `/proc` and for every durable record write.

**The rejected alternative, and what it actually costs.** "Keep the verbs synchronous by moving the
supervisor into a separate process" is not a variation on this decision; §0's measurement means it
is the *only* way to have synchronous verbs at all, and it is worse on the belt's own subject.

- With a **fresh supervisor per call**, every session is permanently an orphan, because the child is
  re-parented when the supervisor exits. `session.process` is then always absent, which makes at
  least eight cases unportable outright -- among them
  `test_exit_zero_is_not_taken_as_evidence_of_success` (asserts `returncode == 0`),
  `test_the_stderr_only_refusal_is_captured_and_surfaced` (waits for `exited-1`), and the two stub
  cases that assert the **identity of the in-process stdin pipe object**, which cannot cross a
  process boundary. It also makes `test_a_live_orphan_is_adopted_not_resumed_around` vacuous: under
  it, everything is an orphan, so the case stops discriminating the path it was written to
  discriminate. And it is expensive in exactly the place D-0029 forbids relief: one `node -e 0`
  start measures 17.5ms here, and the suite's `_wait_for_state` helper polls every 20ms for up to
  10s, so a single case can spend ~8.8s in process startup alone before doing any work.
- With a **long-lived supervisor daemon**, the return code and the pipe survive, at the price of
  inventing a daemon, a wire protocol, a blocking pipe read and a cross-process re-raise of
  `SpawnRefused` -- none of which any source case covers. It is also self-defeating: interlock's
  whole record-discovery and orphan-adoption machinery exists *because* no supervisor survives, and
  a daemon puts a second live process on the state root, which is the shape this subsystem was
  written to prevent.

**Falsifier.** *Primary, and re-runnable:* a synchronous in-process way to read a child's exit
status appears in Node. Concretely -- if the measurement above ever shows `child.exitCode` updating
while the event loop is blocked, this decision's premise is gone, the ladder can be transcribed
literally, and the queue, `settleExits()` and the whole asynchronous surface become indirection to
delete. *Against part 3:* a source case that depends on a verb being re-entered while another is in
flight. None of the 142 does, so the queue carries a target-only liveness case; if that case can be
deleted with no source case turning red, the queue was never load-bearing and this entry
over-reached. *Against part 4:* if, with `settleExits()` in place, the cases that read a readout
straight after a state change are still flaky, then the own-child return code is not reproducible in
process at all, and `exited-<returncode>` needs a decision of its own rather than being a
consequence of this one.

**Source.** Task `continuo-session-port`, 2026-08-28, against interlock `65f36c5`. The blocking-site
census is `claude_org_runtime/session/claude_cli_provider.py` (four `Popen.wait(timeout=)` calls,
three `time.sleep(0.05)` deadline loops, one `subprocess.run(timeout=)` probe) and
`stub_provider.py`; `provider.py` has no blocking site at all and inherits asynchrony only through
`start()`. Every measurement quoted here was reproduced on the porting host on Node v22.17.0,
Linux 6.18.33.2-microsoft-standard-WSL2. The question was raised as the Blocker of the pre-belt
design review; the recommendation there was Promise-ification, and parts 2, 3 and 4 are this belt's
additions to it. Decision id from the `D-03xx` range allocated to this belt by D-0032.

---

## D-0701 -- The secretary belt takes `D-07xx`; `submit()` is synchronous, and the stall is proved by state order

**Context.** The secretary belt ports interlock `tests/secretary/` at `65f36c5` -- 11 node ids over
two files, the behavioural and structural halves of gate item 8's **rehearsal** (interlock Issue
#21, interlock D-0022). It is the smallest belt in the inventory and depends on nothing else in it,
which is why `parity/source-inventory.belts.md` named it a reasonable first port for anyone wanting
the shape of an observation belt.

It is also the belt where a word-for-word translation would have been quietly wrong in three
separate places, and all three are decided here rather than in a ledger `reason` field, because each
one is a rule the next observation belt will meet again.

The subject in all three is the same: **the source's design is written against CPython's
concurrency, and continuo does not have it.** interlock's `IntakeQueue` is lock-free over a
`collections.deque` because `append` and `popleft` are atomic under the GIL, and it documents the
price -- the capacity check is exact under one producer and approximate within the number of
concurrent producers, because a check-then-append race can overshoot `capacity` by at most `P - 1`.
Neither the atomicity nor the race exists in a single Node isolate.

**Decision.**

1. **`D-07xx` is allocated to the secretary belt**, and `parity/source-inventory.belts.md` moves
   `secretary` from `candidate-lane` to `in-scope`. Ranges are permanent whether or not a belt
   completes (D-0032).

2. **`submit()` is synchronous and run-to-completion, and the capacity bound is therefore exact.**
   It declares a return type of `IntakeReceipt`, never a Promise. Nothing else in the package is
   `async` either. The source's tolerance for a `P - 1` overshoot is **not carried**: the
   concurrent-producer case is recorded `adapted` and re-pointed at the property that does hold
   here -- submitted asynchronously from eight interleaved producers, the accepted count is
   *exactly* `capacity`, with nothing lost and nothing duplicated -- and the case witnesses the
   interleaving so that a serial run cannot satisfy it.

3. **The structural "no lock at all" rule is re-pointed at `await`, not deleted and not
   transcribed.** The source's third structural case bans `with` blocks and lock constructors
   because a Python context manager acquires implicitly and is therefore invisible to its ban on
   *called names*. Node has no lock to take, so the sentence does not port. The subject does: the
   wait a call-name ban cannot see, which in this runtime is `await` -- a suspension point whose
   resumption is at the mercy of whatever else holds the loop. `src/secretary/` is held to no
   `async`, no `await`, no `yield`, and no Promise or cross-thread synchronisation object anywhere,
   plus the return type of `submit()` above. The source's blanket ban on `await` in a Python package
   is **not** carried across to continuo's tests, which are asynchronous by necessity.

4. **A stall is proved by state order, never by a clock.** Each behavioural case has its consumer
   take an item, publish the stage it reached, and park on a Promise the test holds the only
   resolver for; the submits are then made and the receipts collected, and the case asserts the
   stall was still unreleased and the consumer still incomplete. The one case whose subject is a
   genuinely blocked *thread* keeps one: a `worker_threads` worker parked in `Atomics.wait` on a
   flag the test is the only writer of, released in teardown. **No latency threshold is stated or
   used anywhere in the belt** -- interlock `Q-0011` is open, and the runner's timeouts bound how
   long a failing run hangs rather than how fast a passing one must be. Receipt stamps are checked
   for order (`answeredNs >= receivedNs`) and never against a bound.

**Alternatives.**

- **Make `submit()` `async` and port the concurrency literally (rejected).** It would reproduce the
  overshoot race by hand, in order to keep a tolerance for it -- inventing the defect so the ported
  assertion could pass. It also puts a suspension point on the exact path item 8 says must have
  none, so the belt's headline property would be false in the port and asserted true in its tests.
- **Keep the `100 <= accepted <= 107` tolerance as the source wrote it (rejected).** The upper bound
  is unreachable here, so the case stays green over an implementation that had begun dropping or
  duplicating requests -- a translated case subtly weaker than its source, which
  `docs/test-translation-conventions.md` rule 0 exists to refuse. Recording it `adapted` puts the
  trade in the ledger where a reviewer sees it.
- **Transcribe the "no `with` block" rule (rejected).** TypeScript has no `with`-as-acquire, so the
  case would pass on an empty file and on a package full of `await`s alike -- green by losing its
  subject, convention rule 10.
- **Ban `await` everywhere in the belt, tests included, as the source bans it (rejected).** The
  source's ban is on its *package*, and its tests use threads freely. Continuo's tests need `await`
  to have a consumer to stall at all; carrying the ban into them would forbid the only mechanism
  that can prove the property.
- **Prove the stall with a timer -- submit for N milliseconds and assert the consumer did not
  advance (rejected).** That is a latency threshold wearing a different hat, and `Q-0011` is the
  question it would be answering without authority. It is also the flakiest possible spelling of a
  fact the resolver already states exactly.

**Falsifier.** `test/secretary/structural.test.ts::the package has no suspension point at all` goes
red the moment `submit()` gains an `async` modifier or a `Promise<...>` return type, and was
measured doing so; `test/secretary/behaviour.test.ts::concurrent producers never lose or duplicate a
request` goes red if the accepted count moves off `capacity` in either direction, and its
interleaving witness goes red if the producers stop interleaving. If a future continuo Secretary
genuinely needs a durable, asynchronous intake, this entry is superseded rather than edited -- the
receipt would then be a promise of a receipt, and item 8 would need re-arguing, not re-testing.

**Source.** Belt dispatched 2026-08-29, task `continuo-secretary-port`, Refs #37. The range
allocation follows the gate D-0032 exercised for `session`, `canary` and `messagebus`.
## D-0302 — The watcher's closed fact-state set is restated here, so the S1 vocabulary lint has an oracle in this repository

**Context.** interlock's `tests/session/test_provider_contract.py` carries a lint over the *source
text* of the provider interface: none of the watcher's fact-state names may appear anywhere in it,
token or prose, comments and docstrings included. Writing `observation unavailable` into a docstring
maps the interface onto the fact-state set as surely as importing the constant would, and the whole
point of `SessionReadout` is that a provider's own lifecycle word is carried **uninterpreted** --
conversion belongs to the detector layer.

The case does not hard-code the vocabulary. It reads it out of interlock's `DECISIONS.md`, splitting
on the `## D-0005 —` heading and collecting every `- \`NAME\`` bullet in that entry's body, and it
fails loudly on an implausible parse rather than silently checking nothing. That indirection is the
substance of the case, not plumbing: interlock's D-0005 says a seventh state may be added only by a
new `D-` entry, so reading the set from the file makes the lint widen automatically on the day such
an entry lands, where a copied list would go stale and keep passing.

**A mechanical port of that parse reads the wrong entry.** `D-0005` in *this* repository is the
double-green rule. A port that split continuo's `DECISIONS.md` on `## D-0005 —` would find an entry
with no such bullets, and the source's own `>= 6` guard would fire -- which is the guard working, but
it does not give the ported case an oracle.

Two alternatives were rejected before this one. **Copying the six names into the test file** loses
exactly the property the source built the indirection for. **Vendoring interlock's `DECISIONS.md`**
into this repository puts a second copy of another project's decision record under version control
here, to be kept in agreement by hand.

**Decision.** The closed set is restated in this file, and the ported lint reads it from here, by the
same parse the source uses. The set, carried from interlock D-0005 unchanged:

- `ACTIVE_EVIDENCE`
- `KNOWN_WAIT`
- `EXPLICIT_BLOCK`
- `NO_ACTIVITY_EVIDENCE`
- `OBSERVATION_UNAVAILABLE`
- `TERMINAL`

This is a **restatement for the oracle's sake, not an adoption**. Continuo has no watcher and this
entry does not give it one; what is decided here is that these six names are the vocabulary the
session interface's prose must stay clear of. The procedural half of interlock's D-0005 is carried
with the list and is what makes the indirection worth keeping: a seventh name is added by a new `D-`
entry in this file, never by editing a list inside a test, and on the day one lands the lint widens
without anyone remembering to widen it.

The parse is deliberately the source's, character for character -- split on the heading, collect
`^- \`[A-Z][A-Z_]+\`$` from the body, refuse a parse of fewer than six. Reproducing it rather than
writing a friendlier one keeps a single failure mode: if this entry is ever reformatted so the
bullets stop matching, the case goes red here for the same reason it would go red there.

**Falsifier.** If interlock adds a seventh fact state and this list is not updated, the ported lint
passes while the source's fails -- the copied-list failure this entry claims to avoid, arriving one
level up. That is the cost of restating rather than reading interlock's own file, and it is accepted
because the alternative is a vendored copy of that file with the same exposure and more surface. The
observation that would show the trade was wrong is a divergence found by anything other than this
sentence: if a reviewer ever discovers the two lists disagree, the restatement needs a mechanical
check against interlock at the pinned revision, in the shape of `test/contract/carried-documents.
test.ts`.

**Source.** Task `continuo-session-port`, 2026-08-28, porting
`tests/session/test_provider_contract.py::test_no_fact_state_vocabulary_appears_anywhere_in_s1` from
interlock `65f36c5`. The six names and the "a seventh requires a new `D-` entry" rule are interlock
D-0005, quoted from that revision. Decision id from the `D-03xx` range allocated to this belt by
D-0032.

---

## D-0033 -- A suite template is built in the file's `beforeAll`, so a shared cost is not charged to an arbitrary test

**Context.** D-0025 made an expensive, identical fixture a per-**file** artifact copied per case,
because migrating a control plane costs about 87.5ms and copying one about 0.97ms. What it did not
settle was *when* the build runs, and the helper it produced built lazily -- inside whichever case
called `copyInto` first.

That places a **file-level** cost inside an **arbitrary test**, where a per-test timeout measures
it. Under `sequence.shuffle.tests` (D-0005) the case that pays is a function of the seed, so a slow
machine produces a red that names an innocent case, and names a different one at each seed.

This is not a hypothesis. On a `windows-latest, node 24` cell,
`test/control_plane/lease.test.ts` failed at `a backward skewed renewal shortens rather than
extends` after **66,325ms** against the 60,000ms cap, while the same commit at that cell's other
seed was green. The case cannot take 66 seconds by its own logic: it is one fixture, three SQLite
calls and two assertions, with no timer, no sleep and no loop. Reproduced on a fast Linux box, at
the failing seed that case runs in **237ms** against 33-43ms for its neighbours, and at the passing
seed a *different* case holds that slot at **135ms**. It is the build, and which case carries it is
the seed's choice.

D-0029 is the same subject one step earlier. It ruled that the CI cap is not the fix for this file
being slow on Windows, and converted its fixtures onto the template. What it did not reach is that
the template's own build is still timed as though it were a test.

**Decision.** `suiteTemplate` registers a `beforeAll` at the point it is called -- which is the test
file's top level, since `suiteRoot` already refuses a call from inside a test or a `describe` -- and
builds there. The cost is then attributed to the file, measured against `hookTimeout`, and paid in
the same place at every seed. Measured after the change, at both of that cell's seeds, the outlier
is gone and `lease.test.ts`'s spread is flat at 66-85ms.

**Failure semantics are deliberately unchanged.** The build runs through a memoising helper that
never throws: the outcome is captured and rethrown from `copyInto`. So a `build` that throws is
still reported by the case that asked for a copy, and a file whose selected tests never copy is
still not failed by a build it never needed. The rejected alternative -- letting `beforeAll` throw
directly -- would fail every test in the file, including the ones that never wanted the template,
which is worse than what D-0025 shipped rather than better.

**The trade, stated rather than buried.** D-0025's laziness bought something real: a file whose
selected tests never copy pays nothing. That is now given up. It shows up under `-t` filtering and
`.only`, and never in a full run, because every file that takes a template copies from it. A
bounded cost on a developer convenience path is accepted in exchange for removing a seed-dependent
red on the slowest CI cell, because the second costs a person's attention and spends it on the
wrong case.

This amends D-0025's mechanism and supersedes nothing: the decision that an expensive identical
fixture is built once per file and copied per case is unchanged, and is what makes this entry's
subject exist at all.

**Falsifier.** If a file appears whose selected tests genuinely may not copy in a *full* run --
a template taken behind a capability probe, say, where the guarded cases are the only consumers --
then the build is being paid for nothing on every host that lacks the capability, and laziness was
the right default after all. The narrower repair would then be a template that builds on first use
but is *warmed* by an explicit call, rather than one that always builds. Equally: if a red is ever
seen naming `hookTimeout` on a template build, the cost has not been removed, only relocated, and
the file needs D-0029's answer -- a cheaper fixture -- rather than this one.

**Source.** Task `continuo-session-port`, 2026-08-29, from a CI failure on PR #59 that was
triaged to this helper rather than to the branch under review. Timings measured on the porting host
(Node v22.17.0, Linux 6.18.33.2-microsoft-standard-WSL2) and on the `windows-latest, node 24` cell
of run 33203831023. `test/testkit/` is frozen and a change to it is its own PR merged before the
belts that need it rebase onto it (`docs/test-translation-conventions.md`); this decision and that
PR are the same change. Decision id allocated by the window in the shared band
(`D-0019`..`D-0099`).

---

## D-0501 -- The messagebus package owns `send`, `poll` and `ack`, and nothing the outbox already owns

**Context.** The messagebus belt ports interlock `tests/messagebus/` at `65f36c5` -- 43 node ids over
five files, S8's worker-outbound bus, its MCP endpoint, the carried v1 delivery specifications, a
stale-readout case and an import-graph guard.

Every one of those cases is about *delivery*, and continuo already has a delivery module:
`src/control_plane/outbox.ts`, 74 ported source cases of resend, ack, dedup and fencing. The obvious
way to make a "message bus" is to give it a `message` table, a delivery state machine and a retry
loop of its own, and the result would be **two answers to every delivery question** -- two retry
counts, two definitions of "settled", two fences -- with nothing in the build able to say which is
authoritative. Two answers to a delivery question is how a message gets delivered twice, or not at
all.

interlock decided this before continuo met it, and put the decision in the first paragraph of its
own `bus.py`: *the existing outbox API is used as found, not modified* (its Issue `#19` scope note),
so that the fault-injection evidence S7 accumulated keeps describing the path this bus actually
takes.

**Decision.** `src/messagebus/` is a **facade**. Its entire owned surface is:

- `send` -- a registry lookup, then `Outbox.enqueue` unchanged;
- `poll` -- `Outbox.due`, filtered to one recipient, each row re-read and then `Outbox.attempt`;
- `ack` -- a recipient-boundary check, then `Outbox.recordAck` unchanged;
- `DeliveredEnvelope` -- the presentation record `poll` returns;
- `endpoint.ts` -- the JSON-RPC transport that exposes `poll` and `ack`.

**Everything else is the outbox's and is not re-implemented here.** Retry counting, the
pending/delivered/acked transition, lease fencing and refusal recording, destination-level
idempotency, and ack persistence all stay in `src/control_plane/outbox.ts`. This package adds **no
table, no migration and no DDL**: `src/messagebus/` contains three `.ts` files and no data file, and
`import-graph.test.ts`'s walk fails on a non-TypeScript file appearing there rather than skipping it.
Refusals raised by the outbox propagate through the facade unwrapped, so a fence refusal reaches the
caller as the outbox's own class and message.

The one place the facade has judgement of its own is `poll`'s skip of a message settled since the
`due()` snapshot, and it is a **skip, not a state change**: the row is left exactly as the outbox
left it.

**Alternatives.**

- **A messagebus-owned delivery table (rejected).** It is what the name suggests and what a reader
  expects, and it would have made the belt self-contained. It also duplicates a subsystem with 74
  ported cases behind it, and the duplicate would be the one with no fault-injection evidence.
- **Wrapping the outbox's refusals in messagebus classes (rejected).** It reads tidier at the
  boundary and it hides the fence: a caller that catches a `MessageBusError` cannot tell a stale
  lease from a malformed argument, and the stale lease is the one it must not retry.

**Falsifier.** If a delivery property is ever needed that the outbox genuinely cannot express -- a
per-recipient visibility timeout, say, or a priority order -- then the facade has to either grow
state or push the feature down into S7, and this entry stops being a complete description. The
repair is the second: interlock's scope note is about not *modifying* the outbox API during the
spike, not about never extending it. The observation that would show the trade was wrong is a
`src/messagebus/` module that finds itself reading or writing an `outbox`, `action` or `lease` row
directly; there are none today, and `MessageBus` reaches SQLite only through an `Outbox` instance it
constructs.

**Source.** Task `continuo-messagebus-port`, 2026-08-29, porting `tests/messagebus/` from interlock
`65f36c5`. The constraint is interlock's own, quoted from `bus.py` at that revision, and was
restated as the belt's headline design constraint at the window. Decision id from the `D-05xx` range
allocated to this belt by D-0032.

---

## D-0502 -- The MCP wire keeps interlock's snake_case keys and env names; the endpoint is launched as the built module by path

**Context.** The endpoint is not library API. It is a **process** a worker's MCP configuration
launches, speaking line-delimited JSON-RPC on stdio. Three things about it are contracts with
something outside this repository, and each has an in-repository convention pulling the other way:

- the tool payload keys (`message_id`, `dedup_key`, `retry_count`, `receipt_ref`, ...) against the
  port's camelCase;
- the environment variables (`INTERLOCK_MESSAGEBUS_DB` and its five siblings) against the package's
  own name;
- how the child is started, where the source's `python -m claude_org_runtime.messagebus.endpoint`
  has no TypeScript spelling at all.

**Decision.**

1. **The wire keeps the source's snake_case keys, and the rename stops at the transport boundary.**
   `DeliveredEnvelope` is camelCase like everything else in `src/`; `endpoint.ts` carries an explicit
   `envelopeToWire` that spells the wire keys out. `message_id` is the argument name the `ack` tool's
   own `inputSchema` declares, so it is part of a published tool contract rather than a naming
   preference -- and it is written out at the boundary rather than produced by a serializer, because
   a serializer would make a wire contract a side effect of a naming convention.

2. **The environment variables keep the `INTERLOCK_MESSAGEBUS_` prefix**, for the same reason
   `STATE_FILE_ENV` in `src/session/stub_provider.ts` keeps `INTERLOCK_STUB_STATE_FILE`: the name is
   read by a configuration file this repository does not own, and renaming it buys nothing and
   breaks a worker's MCP config on the day of the rename.

3. **The child is `node dist/messagebus/endpoint.js`** -- the built module, which is what an MCP
   configuration would actually launch -- guarded by the `isEntryPoint()` shape `src/cli.ts` already
   uses (`realpathSync` on both sides, because a symlinked launcher makes the URL form disagree with
   `process.argv[1]`). The two end-to-end cases assert `dist/messagebus/endpoint.js` exists, with a
   message naming `npm run pretest`, so a missing build is a legible red rather than a spawn failure.
   `test/measurement/cli.test.ts` makes the same choice for `dist/cli.js`.

4. **Every line the endpoint writes goes through `pythonJsonDocumentSorted`**, not
   `JSON.stringify`. The source emits `ensure_ascii=True` and D-0006 requires ASCII for anything
   continuo prints; rather than write a fourth JSON renderer (D-0017 rule 4: one renderer), the
   endpoint uses the transcription `src/control_plane/python_json.ts` already carries. It sorts
   object keys where the source's call does not, which carries no meaning in JSON and no consumer
   here compares response text.

**Falsifier.** If continuo ever publishes its own MCP server naming and the `INTERLOCK_` prefix
becomes actively misleading to an operator reading their own config, point 2 should be revisited --
with a deprecation window that reads both names, not a rename. If `dist/` stops being the thing a
consumer runs (a bundler, a single-file build), point 3's path moves with it, and the two cases that
name it are where that shows up.

**Source.** Task `continuo-messagebus-port`, 2026-08-29, porting
`tests/messagebus/test_endpoint.py` from interlock `65f36c5`.

---

## D-0503 -- The facade's own caller bug gets a class the outbox does not share

**Context.** Python spells both the outbox's usage errors and the bus's cross-recipient ack refusal
as the one builtin, `ValueError`, because that is the builtin available. Two source cases assert
`pytest.raises(ValueError)` against refusals raised by **different layers**:
`test_an_ack_for_a_never_polled_message_is_refused` (the outbox's) and
`test_an_ack_from_the_wrong_recipient_is_refused` (the facade's).

A literal translation would assert one class for both, and `docs/test-translation-conventions.md`
already records why that is dangerous: a refusal family whose members differ only by message stays
green while the taxonomy a caller acts on is wrong, which is why `expectRefusal` asserts the class as
well as the text.

**Decision.** `MessageBusUsageError` exists and is thrown **only** by code in `src/messagebus/`. It
is used for exactly one thing: an ack naming a recipient the message is not addressed to. The
outbox's `OutboxUsageError`, `HandlerRejected`, `HumanGateRequired` and `StaleWriterRefused` keep
reaching callers unchanged through the facade, which is D-0501's "exceptions are the outbox's own"
in its concrete form. The two ack cases therefore now pin **which layer refused**, which the source's
assertions could not.

This is a **narrowing, not a widening**: nothing that was refused before is accepted, and nothing
that was accepted is refused. What changed is what a caller can distinguish.

**Falsifier.** If a second facade-level refusal appears whose caller should handle it differently
from the recipient-boundary one, `MessageBusUsageError` becomes a family and this entry needs a
successor naming the members. If the endpoint's tool-error text is ever depended on by a client
matching the literal word `ValueError`, this decision has a cost it does not have today -- the text
renders `constructor.name`, so the class name is what a client sees.

**Source.** Task `continuo-messagebus-port`, 2026-08-29, porting
`tests/messagebus/test_carried_specifications.py` and `tests/messagebus/test_messagebus.py` from
interlock `65f36c5`.

---

## D-0504 -- The third AST scan stays in its belt; the frozen testkit is not changed by this PR

**Context.** `test/messagebus/import-graph.test.ts` is the **third** structural scan in this
repository, after `test/canary/structural.test.ts` and `test/secretary/structural.test.ts`. All
three parse `src/**` with the TypeScript compiler API and walk it, and all three carry a near-identical
`importedModules` helper. Three copies of a helper is the point at which duplication normally gets
factored out, and the belt's brief raised exactly that.

Two facts pull against it. First, `docs/test-translation-conventions.md` freezes `test/testkit/`: a
change to it **is its own PR, merged before the belts that need it rebase onto it** -- the rule
D-0033 was landed under. Second, the three scans ask **different questions**. canary and secretary
ask *"does this package import anything outside an allowlist?"*; messagebus asks *"does any import,
anywhere, name a session backend?"*, plus a ban on dynamic-import primitives that neither of the
others has. Only `importedModules` is genuinely common; `calledNames`, `referencedIdentifiers` and
`exportedNames` have no messagebus use, and `namesASessionBackend` has no canary or secretary use.

**Decision.** The scan stays local to `test/messagebus/`, and `test/testkit/` is **not touched by
this belt**. The duplication is recorded here rather than left to be rediscovered at the fourth
instance.

The shared extraction remains the right end state, and this entry says what it should be when it
happens: a `test/testkit/ast.ts` exporting `importedModules` alone -- the one helper all three
already agree on, and the one whose subtleties (`import type` seen because it is erased at emit,
`export ... from` counted as an edge, relative specifiers resolved to absolute paths, dynamic
`import()` and `require()` reached inside function bodies) are what a fourth hand-written copy would
get wrong. Its own contract test would be target-only, as the rest of the testkit's are. The
question each belt asks *about* the resulting set stays in that belt, because it is that belt's
subject and not a helper.

**Why not now:** doing it here would put a frozen-testkit change inside a belt PR, against the rule,
and would make this belt's merge depend on a second PR landing first -- in an environment where two
other lanes are appending to `DECISIONS.md`, `belts.md` and `scripts/parity-check.mjs` concurrently
and the worker cannot force-push. The cost of waiting is one more copy of one function; the cost of
not waiting is a cross-cutting change to the file every belt's tests import, merged under a belt's
review rather than its own.

**Falsifier.** If a fourth structural scan is written before the extraction happens, the trade has
gone wrong: at four copies the odds that they have silently drifted -- one of them missing
`export ... from`, say, which is a real dependency edge -- are high enough that a divergence is more
likely than not, and the extraction should be done first. The observation that would show it
*already* wrong is any disagreement between the three existing `importedModules` bodies about which
node kinds are edges; they were compared at this belt's writing and agree.

**Carried out** (2026-08-29, task `continuo-testkit-ast`). Done ahead of the falsifier rather than
in response to it firing: the `gate_item11` belt was about to add a fourth AST-scanning structural
test, which would have made a fourth hand-written copy of `importedModules` and let the falsifier's
condition come due, so the extraction was made before that fourth copy was written rather than
after. `test/testkit/ast.ts` now exports `importedModules` alone --
the one helper the three files already agreed on -- and `test/canary/structural.test.ts`,
`test/secretary/structural.test.ts` and `test/messagebus/import-graph.test.ts` were rewritten to
import it rather than carry their own copy. `calledNames`, `referencedIdentifiers`, `exportedNames`
and `namesASessionBackend` stay local to the belts that use them, as this entry anticipated. The
extraction's own contract test is target-only, in `test/testkit/testkit.contract.test.ts`
("importedModules sees every route a static import list would miss"), alongside the testkit's other
target-only contracts. The three original scans' behaviour is unchanged: a mutation probe that
temporarily added a forbidden import to `src/canary/index.ts`, `src/secretary/index.ts` and
`src/messagebus/bus.ts` in turn confirmed all three structural tests still turn red for the same
reason they did before the extraction, then the probe was reverted.

**Source.** Task `continuo-messagebus-port`, 2026-08-29. The freeze rule is
`docs/test-translation-conventions.md` and D-0033's own closing paragraph.

---

## D-0801 -- The gate_item2 belt takes `D-08xx`; `SessionOrchestrator` is `async` end to end, and the session-driver-harness file is deferred

**Context.** `tests/gate_item2/` (interlock `65f36c5`) is 34 cases across three files, downstream of
the session belt (`D-0301`/`D-0302`, ported PR #61): every case runs a crash-and-retry shape
*through* the control plane and asserts a durable row, never an exit code. Porting it needs two new
modules with no continuo counterpart yet -- `claude_org_runtime.control_plane.session_binding`
(the staged session<->run binding, `prepared` -> `spawned` -> `identity_confirmed`) and
`claude_org_runtime.supervisor.SessionOrchestrator` (the lease-before-spawn walk that composes the
binding, the lease and the S1 provider verbs) -- ported here to `src/control_plane/session_binding.ts`
and `src/supervisor.ts`.

**Decision 1: the `D-08xx` band is reserved for this belt**, per D-0019's per-source-file ledger
convention and D-0032's D-range allocation.

**Decision 2: `SessionOrchestrator.start()` and `.recover()` are `async`, and every private helper
downstream of a provider verb call is `async` with them.** The source drives five ordinary blocking
calls; D-0301 already made continuo's `SessionProvider` verbs (`start`, `listSessions`, `readState`,
`stop`, `resume`) `Promise`-returning, because Node has no synchronous way to wait for a child to
exit. `SessionOrchestrator` calls all four of the non-list verbs, so the async-ness D-0301 introduced
at the leaf necessarily reaches this join layer -- there is no way to write a `SessionOrchestrator`
over continuo's `SessionProvider` that stays synchronous. This is a calling-convention change with no
effect on what any case asserts: every value compared, every row read and every exception raised is
the source's. `pytest.raises(SomeError, match=...)` becomes `expectAsyncRefusal`, this belt's local
async twin of `test/testkit/errors.ts`'s `expectRefusal` (kept local to `test/gate_item2/helpers.ts`
rather than added to the shared testkit while `fault_injection` and `messagebus` are mid-flight
against shared files).

One further consequence, specific to `#refuseAndTerminate` (the port of `_refuse_and_terminate`): the
source holds SQLite's write lock across its `provider.stop(session_id)` call inside one
`BEGIN IMMEDIATE` transaction, using the lock itself to serialise the loser's stop-or-stand-down
decision against a winner's concurrent `confirm_identity`. `better-sqlite3` is synchronous and has no
async API to hold a transaction open across an `await`, so the port's transaction still opens before
the read-only check-and-decide and is rolled back (never committed -- the block only ever reads)
around the same `await this.#provider.stop(sessionId)`, in the same order the source's `try/finally`
does. Node's single-threaded event loop means nothing else can touch this same connection object
during that `await` unless another already-running task does, and nothing in this belt's tests does;
this is stated as the residual rather than assumed away, in the same spirit as gate item 2's own
statement that the admission-to-spawn window "cannot be closed from here" (`ACCEPTANCE.md` section 2).

**Decision 3: `test_session_driver_harness.py` (6 of the 34 node ids) is deferred to a dedicated
follow-on task, not ported in this change.** That file drives
`tests.fault_injection.controller.Controller` / `execute_case` / `assert_invariants` against a
`SESSION_ADAPTER` from `tests/fault_injection/session_driver.py` -- the fault-injection harness
itself, real SIGKILL and all. `fault_injection` is its own `candidate-lane` belt
(`parity/source-inventory.belts.md`) and is being ported concurrently in a sibling worktree (PR #62);
porting the harness here as a "ついで" would duplicate that lane's work and risk disagreeing with it.
`parity/gate_item2.orchestrator-walk.ledger.json` (23 cases) and
`parity/gate_item2.mediated-real-provider.ledger.json` (5 cases) land in this change -- both are
downstream only of the already-ported session belt and are fully in-memory or real-subprocess-but-
no-fault-injection. `test/gate_item2/mediated-real-provider.test.ts` reuses `test/session/helpers/`
(`fakeCli`, `spawnLog`, `stopSessionsAtTeardown`, `spawned`) built for the session belt's own
`claude-cli-provider.test.ts`, rather than re-deriving the fake CLI fixture.

Investigating the blocker turned up a narrower fact than "wait for `fault_injection` to land":
`SessionAdapter`'s execution-path methods (`bootstrap`, `spawn`, `roleArguments`, `observer`,
`invariantQueries`, `queryParameters`, `effectKeys`, `holderOf`) are a deliberate stub that throws
`ContractViolation` on every call -- `fault_injection`'s own header on that file already names this as
its own declared follow-on (D-0601) on the session belt landing, and the session belt has landed
(PR #61) without the adapter itself yet being re-bound to it. So `fault_injection` landing on `main`
does not, by itself, unblock these 6 node ids. Ratified by human decision 2026-08-29 (via secretary,
option "(a')"): this belt ships as 28/34 in its own PR, and re-binding `SessionAdapter` to
`src/supervisor.ts` / `src/session/claude_cli_provider.ts` -- landing these 6 node ids together with
`fault_injection`'s own 4 full-profile session-start manifest cases, since one real `SessionAdapter`
serves both -- is dispatched as a separate follow-on task. `parity/gate_item2.session-driver-harness.
ledger.json` records the 6 as `not-ported` with the reason above; a faithful draft of all 6 against the
current `controller.ts` / `manifest.ts` APIs (`feat/continuo-fault-injection-port` at HEAD `16a9c2c`
when drafted) is held at `tmp/session-driver-harness.draft.test.ts` (gitignored, this task's own
branch) as a handoff asset for the follow-on worker, expected to need rework once the adapter is real.

**Falsifier.** If a future belt needs `SessionOrchestrator` to expose a synchronous entry point (a
CLI driving it directly, say), the async-everywhere decision above is the wrong default there and
that caller needs its own adapter -- this decision is about the join layer over an async provider
contract, not a claim that every caller wants a promise. If `fault_injection`'s session-driver adapter
lands with a shape `test_session_driver_harness.py`'s cases cannot be ported against directly (its own
`SESSION_ADAPTER` assumes a three-role delivery loop the full battery needs but this file's four cases
do not), the remaining 6 node ids need a follow-up ledger and belt update rather than silent inclusion
in either lane's totals.

**Source.** Task `continuo-gate-item2-port`, 2026-08-29, porting `tests/gate_item2/` from interlock
`65f36c5`. Decision id from the `D-08xx` range this entry allocates.

---

## D-0601 — The fault-injection belt takes `D-06xx`, its own `test/fault_injection/` directory, and two adapter classes

**Context.** `parity/source-inventory.belts.md` classed `fault_injection` (98 cases) as
`candidate-lane` and left three questions open in writing: which `D-` range the belt gets, whether
the cases merge into `test/contract/` or take a directory of their own, and what it means to run a
"conformance battery with one adapter in it". This entry answers all three before any code lands,
because each one is load-bearing on how the other 97 cases are written.

**Decision 1 -- the band is `D-06xx`.** The index note in this file allocates `D-0019`..`D-0099` to
the control plane and the window, `D-01xx` measurement, `D-02xx` fencing and settings, `D-03xx`
session, `D-04xx` canary, `D-05xx` messagebus (the last three by D-0032). `D-06xx` is the next free
range and is reserved here for the fault-injection belt. As the index note already says, the range
is an allocation and not a meaning: nothing about an entry follows from which range it is in. The
point is only that concurrent lanes appending at once conflict in the index table and never over an
ID.

**Decision 2 -- the cases get `test/fault_injection/`, not `test/contract/`.** `belts.md` floated
the merge on the grounds that continuo "already has the same instinct in `test/contract/`". The
instinct is the same; the shape is not. `test/contract/` holds assertions *about* continuo's
modules. This belt ports an independent acceptance system: it has a wire protocol
(`contract.ts`), a spawn/barrier/kill/restart engine (`controller.ts`), a frozen case matrix and
its generator (`manifest.ts`, `manifest.json`), a conformance battery (`conformance.ts`), a
collection-time policy layer for lanes, profiles and budgets (`policy.ts`), and role drivers that
run as **real child processes**. Merging six such modules into a directory of ordinary contract
tests would bury the seam that `test_import_graph.py` exists to police -- the rule that exactly one
module may import the implementation under test -- in a directory where every file imports
implementations by design. Interlock keeps the harness in `tests/fault_injection/` for the same
reason, and the belt keeps that boundary.

**Decision 3 -- the adapters are two classes, and only one of them is a battery subject.** The
source's `ADAPTERS` tuple in `test_conformance.py` has one member and its docstring says the others
join "when I-12 and I-14 land". Read carelessly, "a conformance battery with one adapter" sounds
like a comparison test with nothing to compare against. It is not a comparison test. It is a
**qualification exam**: `conformance.ts` asserts the contract itself -- every checkpoint reachable
and blocking, the barrier round-trip, a real SIGKILL leaving a readable database, an idempotent
restart, an injected clock, identical traces under one seed, the CLI surface, and that no invariant
query is vacuous -- so an adapter that has not passed it cannot contribute matrix results. One
subject is a complete exam; a second subject adds coverage of the *next* adapter, not of the exam.

So the belt names the two roles explicitly rather than leaving them implied by a tuple:

- a **`FullFaultAdapter`** is a battery subject. It implements the whole `Adapter` surface and the
  conformance battery runs against every one the build ships. Today that is exactly one, the spike
  driver over `src/control_plane`.
- a **`CaseAdapter`** is the narrower thing a manifest case's `adapter` field may name. It is
  resolved from a registry at collection time and needs only what the cases routed to it use.

The distinction is structural, not documentary: the registry refuses to be empty, and every
`adapter` name a manifest case declares must resolve in it, so a case routed to an adapter nobody
registered fails at collection rather than as a spawn failure in CI. That is the same rule the
source states for its own manifest validation ("an unknown adapter must refuse at collection, never
surface as a spawn failure") raised to cover the registry as well as the name.

**What this belt does *not* claim.** The manifest carries 59 cases, of which 55 route to the spike
adapter and 4 to the session adapter (`session-start`, gate item 2's four injection points). The
session driver stands on a `SessionOrchestrator` and a C2 provider that continuo has not ported --
`src/session/` does not exist at this revision. Those four cases are therefore declared in the
ledger as a **follow-on dependency**, not as passing coverage, and this belt's completion claim is
"the acceptance harness is ported and the spike adapter passes the battery", never "98 cases at
parity". The two are different sentences and the ledger keeps them apart.

**Falsifier.** If `test/fault_injection/` is later merged into `test/contract/` without the import
seam surviving, `test/fault_injection/import-graph.test.ts` goes red naming the module that
reached the implementation. If a second full adapter is added without passing the battery,
`test/fault_injection/conformance.test.ts` collects it and fails. If the adapter registry is
emptied, its own structural case fails rather than the matrix silently collecting nothing.

---

## D-0602 — The fault-injection watchdogs are scaled for this port's runners, and the manifest's numbers are left alone

**Context.** `manifest.json` carries interlock's CI budgets: a `fast` profile with a 15s per-case
watchdog and a 10s per-barrier one. Those numbers are calibrated on interlock's runners. On PR #62
they met continuo's, and two cases failed on the `windows-latest` / node 22 cell:

    CaseTimeout: disp__attempt__after_effect_before_record__sigkill outran its 15s budget
    CaseTimeout: disp__lease-acquire__lease-acquired__clock-fwd outran its 15s budget

**The stack is the whole diagnosis.** Both failed at the *identical* site --
`Controller.checkDeadline` -> `Controller.spawn` -> `executeCase` at the FIRST spawn, the one
immediately after `bootstrap()`. Neither case had started a role process. Creating the schema alone
had consumed the entire budget. The same suite was green on windows/node 24 and on all four ubuntu
cells, and both cases pass everywhere else, so nothing distinguishes them except which machine they
happened to run on.

That is a phenomenon this repository has already measured and already written down. From
`vitest.config.ts`, for one test on one commit in one workflow:

    linux-latest              28ms
    windows-latest (healthy) 321ms
    windows-latest (slow)  13,556ms

a 42x spread between two Windows runners with no code between them, on work that is exactly what a
case does -- the control plane runs `synchronous = FULL` (interlock D-0012), so every commit fsyncs,
and a case creates, migrates and re-reads a database several times.

**Two hypotheses were measured and discarded before this one.** The port spawns a child per role and
type-strips `src/control_plane` on each spawn, so per-spawn cost was the obvious suspect: measured at
**210ms median** (n=5, linux/node 22), and `NODE_COMPILE_CACHE` moved it not at all (208ms vs 210ms).
Spawn count was the second: the two failures were assumed to be the multi-spawn cases until the stack
showed both dying before *any* spawn. Neither survived contact with the evidence, and both are
recorded here because a reader's first instinct will be the same as mine was.

**Decision.** The budgets are scaled **where they are used**, by this port, and the manifest keeps
interlock's numbers:

- `PORT_BUDGET_SCALE = 3` applied to the per-case, combination and per-barrier budgets;
- held under `RUNNER_BUDGET_CEILING_S = 50`, because Vitest's own `testTimeout` is 60s and the two
  failures are not equivalent. The harness's `CaseTimeout` names the case, carries the `S9-REPRO`
  line and runs the teardown ladder; the runner's says a test took too long and leaves the role
  processes to a teardown that never ran. Keeping the harness strictly faster preserves the
  attributable failure design section 8.2 asks for.

**What is NOT changed, and why.** `manifest.json`'s profile numbers stay exactly as interlock wrote
them. A ported case -- `the profiles carry the budgets the watchdogs enforce` -- asserts them
literally, and editing them would make this port's evidence disagree with its source over a fact
about interlock's CI rather than about continuo's. The source's own docstring says these are
"harness engineering parameters, not acceptance thresholds", revisable by an ordinary diff; this
entry takes that at its word while leaving the recorded values alone.

**One place this is stricter than the source, stated plainly.** The `full` profile's combination
budget is 60s, which already equals the runner's timeout, so a 60s harness budget could never fire
first. The ceiling holds it at 50s. That is a tighter number than interlock's on that one cell, and
it buys a better failure rather than a weaker one.

**Why not simply raise the runner's timeout.** `testTimeout` lives in `vitest.config.ts`, which every
lane shares; a belt does not get to widen the whole suite's tolerance to fix its own cell.

**Falsifier.** If a case's runtime grows past the scaled budget for a reason that is not runner
weather -- a matrix that has genuinely got slower -- the watchdog still fires and still names the
case, which is what design section 9 asks of it. If the scale is ever suspected of hiding growth,
the measurement to redo is the one above: run the belt on a healthy runner and compare against the
unscaled number.

---

## D-0034 -- The attention belt and the gate_item11 belt both start, and design proposals ratified within them are named

**Context.** `parity/source-inventory.belts.md` held both subsystems at `retarget`: `attention`
(194 cases, none a straight carry) and `gate_item11` (64 cases across four files, two of which --
`test_no_provider_detail_leaks.py` and `test_suite_runs_unchanged.py` -- need re-derivation against
continuo's module graph rather than Python imports). D-0031's gate applies here exactly as it did at
D-0032 -- a `retarget` status proposes nothing until a human confirms it, and starting a belt is a
separate act from allocating it a D-range.

**Decision.** The human gate was passed on 2026-08-30, for two belts and several design proposals
made within them, recorded together because they were ratified in one pass.

1. **The `attention` belt starts, split into three sub-belts sharing one D-range.** A1 (facts, 90
   cases), A2 (dedup and config, 44 cases) and A3 (notify and pipeline, 60 cases) all move from
   `retarget` toward completion under `D-09xx`, allocated once and shared across the three so that
   cross-sub-belt cross-references never leave the range. `test_broker_journal_contract.py` is not
   part of the 194: it is a `broker`-belt file with no node ids (see the `broker` section of
   `source-inventory.belts.md`), and it is named here only because the two subsystems sit next to
   each other in that document and are not to be confused.
2. **Four design points within the attention belt are ratified, not left to the implementing
   sub-belt to decide:**
   - The six-name fact vocabulary is promoted **beyond** D-0302's "restatement for the oracle's
     sake, not an adoption": A1's own work will carry a new `D-` entry, in the range this belt
     allocates, that supersedes D-0302's limitation and adopts the vocabulary as more than a lint
     oracle. This entry does not itself allocate that id or write that entry -- it ratifies that A1
     is the belt that does, ahead of any other belt reaching for the same six names.
   - The mapping from the source's eighteen `kind` values to the six fact states is **not
     invented** by this port: every ported case is required to give its fact state explicitly, so
     no continuo-authored kind-to-state table exists for a belt case to silently depend on.
   - The dedup subsystem's inherited defect -- malformed state loading as an empty `DedupState`
     (the same defect `source-inventory.belts.md` flagged when this belt was still `retarget`) --
     is repaired **fail-closed now**, inside A2. Rebuilding the corrupted state instead of refusing
     it is a different, larger repair and cannot land in A2 for the same reason D-0405 gives for its
     one deferred repair: it is named here as declined-for-now rather than silently out of scope,
     and the belt that eventually takes it on is not yet chosen -- naming one before A2 exists would
     be inventing a commitment this gate was not asked to make.
   - The belt's parity ledgers follow D-0208's notation for a translated case whose mechanism
     changes while the property it asserts is preserved: that case is recorded `adapted`, with the
     divergence stated in the ledger, never folded silently into `ported`. D-0019's ledger
     vocabulary is otherwise unchanged -- `not-ported` and waivers remain available for cases this
     belt declines outright. `test_broker_journal_contract` is not a case at all -- it has no node
     ids and is not part of the source-inventory manifest's file registration -- so it gets a
     standalone, metadata-only ledger recording **zero entries** when the belt starts, outside the
     parity checker's normal file-to-inventory linkage: an explicit, checked-in "this file
     contributes nothing" rather than the file's total absence from every attention ledger being
     mistaken for an oversight, with the reason cross-referenced to `source-inventory.belts.md`
     rather than restated in the ledger. The DDL's lack of a constraint on `incident.fact_state` is
     carried as-is -- it is a property of the schema this port inherits, not a defect this belt
     repairs. The notify backend stays `stdout`, carried unchanged from the source rather than
     generalised to a pluggable backend.
3. **The `gate_item11` belt starts, under `D-10xx`.** `D-0504`'s testkit extraction is a
   precondition, run first as its own PR (`PR-0`), because both
   `test_no_provider_detail_leaks.py` and `test_suite_runs_unchanged.py` need the frozen testkit to
   already exist rather than growing a second copy of it. `src/index.ts`'s two re-exported
   vocabularies are carried as an allowlist exception to the leak check -- a named exception with a
   falsifier, not a silent gap -- reserving a subpath-exports split as a future, separately-decided
   move. The thirteen `test_suite_runs_unchanged` cases are ported by a scoped subprocess
   double-run rather than by re-deriving interlock's own suite-identity check, and a spike proves
   the double-run shape works before the belt commits to it.

**This is the gate D-0031 defined, exercised again -- not a supersession of D-0032.** D-0032
ratified three subsystems at the 2026-08-28 gate; this entry ratifies two more at the 2026-08-30
gate, under the same document and the same three-layer boundary. Statuses not named here remain
proposals.

**Falsifier.** The A1/A2/A3 split is expected to cite across itself -- that is the reason `D-09xx`
is allocated once rather than three times -- so cross-citation is not what would falsify the
sharing. What would is a collision: two sub-belts minting decisions that land on the same id because
neither sub-belt's author could see the other's in-flight entry. If that happens, the shared-range
allocation is what is wrong, and a future entry splits `D-09xx` into per-sub-belt slices. If the
fail-closed dedup repair is found to lose data a caller needed, the deferred rebuild belt is what
was missing, not evidence against fail-closed itself. If the gate_item11 double-run spike shows the
subprocess shape does not scale to thirteen cases, the belt's approach is what is wrong, not the
D-range allocation, which stays burned either way.

**Source.** Ratified by the user on 2026-08-30, task `continuo-belt-ratification-2`. Decision id
allocated by the window in the shared band (`D-0019`..`D-0099`, see "How to use this file").

---

## D-0035 -- `curator` is ratified `not-porting`; `migrate` is reviewed and stays `decision-pending`

**Context.** `parity/source-inventory.belts.md` held both `curator` (71 cases) and `migrate` (11
cases) at `decision-pending`: whether continuo carries either surface at all was undecided upstream,
and porting either would have settled that by implication rather than by an explicit answer. D-0031
requires a human gate before either status moves.

**Decision.** The human gate was passed on 2026-08-29, for two subsystems, recorded together
because they were reviewed in one pass (continuo#77).

1. **`curator` moves from `decision-pending` to `not-porting`.** The promotion gate's premise is
   that a filesystem write into a live skill directory *is* the promotion, which is a claim about
   running Claude Code sessions. continuo is a safety-substrate library, not the operator of those
   sessions, so it does not own that surface, and the tests have no subject here. The existing note
   that `test_promotion_gate.py` would be high-value *if* the answer had been yes is kept, unedited,
   as the reason a future reversal would be cheap to act on. The effective porting target moves from
   `2,194 - 85 = 2,109` (D-0032's count) to `2,194 - 156 = 2,038`, `156 = 85 + 71`.
2. **`migrate` stays `decision-pending`, reviewed rather than left unexamined.** `tests/test_migrate.py`
   checks v1-to-v2 key normalisation against a migration/comparison bridge that exists in neither
   repository; deciding to port it would not produce anything to port it against. The status is
   unchanged, but `source-inventory.belts.md` now records that this was reviewed at the human gate on
   2026-08-29 and deliberately left pending, so a later reader does not mistake it for an unexamined
   entry.

**Falsifier.** For `curator`: if continuo, or a layer built on it, grows a surface that promotes
skills by writing into a live skill directory, the subject exists and this decision is superseded,
not edited -- `suisya-systems/cadenza#9`'s agentic-layer direction is a live candidate, not a
theoretical one. For `migrate`: the trigger for revisiting is the run-boundary cutover bridge
actually being designed; the `jsonschema`-equivalent dependency question comes with it and does not
need answering before then.

**Source.** Ratified by the user on 2026-08-29, task `continuo-decision-pending-ratification`,
continuo#77. Decision id allocated by the window in the shared band (`D-0019`..`D-0099`, see "How to
use this file").

---

## D-0603 — The session adapter's driver command needs `--experimental-transform-types`, not `--experimental-strip-types`

**Context.** `test/fault_injection/session_driver.ts` (D-0601's second adapter, deferred until this
task) is the first module in `test/fault_injection/` to import `src/session/`. Its
`driverCommand()` spawns itself as a type-stripped `.ts` child process, mirroring
`SpikeAdapter.driverCommand`'s `major < 23 ? ["--experimental-strip-types"] : []`. Under that flag
(or under Node's unflagged default stripping on Node >=23.6, which is the same strip-only mode) the
spawned process died immediately with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter
property is not supported in strip-only mode`, pointing at `src/fencing/pyjson.ts`'s
`DocumentScan` class (`constructor(private readonly src: string) {}`) -- a file
`src/session/claude_cli_provider.ts` imports transitively. `spike_driver.ts` never reaches that far
(it imports only `src/control_plane/`), so this class of import was never exercised through the
driver-spawn path before.

**Decision.** `SessionAdapter.driverCommand()` passes `--experimental-transform-types`
unconditionally (it implies strip-types, so no version branch is needed): Node's fuller *transform*
mode lowers a parameter property (and an enum, and a namespace) to plain JavaScript instead of
refusing it outright. `SpikeAdapter.driverCommand()` is left unchanged -- it has never needed more
than stripping and D-0601 already keeps the two adapters independent.

**Falsifier.** If a future `src/` file the session adapter's import graph reaches uses a
non-erasable TypeScript construct the transform mode itself does not lower (none is known at the
time of this entry), the spawn would fail again with a different Node diagnostic and this decision
would need revisiting, not merely re-measuring.

**Source.** Task `continuo-session-adapter-followon`, 2026-08-29, measured on Node v22.17.0
(within the `engines` range `>=22.14.0 <23`).

---

## D-0802 — D-0801's deferred session-driver-harness file lands; no dedicated reaper for the destination's grandchild

**Context.** D-0801 shipped `gate_item2` at 28/34, deferring `tests/gate_item2/
test_session_driver_harness.py` (6 node ids) to a follow-on task because it drives
`test/fault_injection/controller.ts` against a `SessionAdapter`
(`test/fault_injection/session_driver.ts`) that was, at the time, a stub refusing every
execution-path call (D-0601's own declared follow-on on the session belt landing). This task
re-binds `SessionAdapter` to `src/supervisor.ts`'s `SessionOrchestrator` and
`src/session/claude_cli_provider.ts`'s `ClaudeCliSessionProvider`, lands the 6 deferred node ids as
`test/gate_item2/session-driver-harness.test.ts`, and -- since one real `SessionAdapter` serves both
-- makes `test/fault_injection/`'s own 4 `full`-profile `session-start` manifest cases executable at
the same time (`parity/fault-injection.cases.ledger.json`'s declared follow-on, closed by the same
change).

**Decision 1 -- the adapter gets its own fake CLI, not the session belt's S2 fixture.** The
session-start cases' `live-processes-per-session` invariant needs an interval-overlap computation
over real pids and timestamps (a start ledger line and, on a normal exit, an exit line), so the
observer can answer "was any session id ever concurrently live under two processes" even after both
have exited. `test/session/helpers/fake-claude.mjs` (the session belt's own fixture, `FAKE_MODE` /
`FAKE_SPAWN_LOG` etc.) records only `{argv, cwd}` per spawn -- enough for the session belt's own 142
cases, not enough for this one. `session_driver.ts` therefore carries its own small embedded fake
CLI (mirroring the source's own bespoke `_FAKE_CLI`, which is likewise separate from
`tests/session/test_claude_cli_provider.py`'s fixture), keeping the session belt's fixture
unchanged and unrisked by a shape it was not built for.

**Decision 2 -- no dedicated reaper for the destination's grandchild.** The fault belt's own
teardown ladder (`controller.ts`'s `teardown()`) reaps role *processes*; it was never asked whether
a role's own detached grandchildren need reaping too, and the session adapter is the first case
where a role process spawns one on purpose (`ClaudeCliSessionProvider` spawns the fake CLI
detached, its own session/process group -- the same shape the session belt's own mediated-provider
tests already exercise, so a `SIGKILL` of the `sup` role process never touches it; that is the
point, since it is what lets `recover()`'s adoption path find a live child rather than a corpse).
Evaluated and found **not needed**: the four session-start manifest cases are single-role,
non-combination, and never repeat `bootstrap()` within a case, so the fake CLI's own release is
what ends the process on every path. That release is a *condition on the filesystem*, not a fixed
sleep (a first draft used a fixed hold and a codex review round correctly flagged it: on a slow
enough runner the child could exit before a restarted generation's `recover()` looked for it,
making the P3 "surviving child" adoption path timing-dependent rather than reliably exercised) --
the fake CLI polls for a stop-file's existence, and `session_driver.ts`'s `runWalk` writes that
file in a `finally` once a generation's own walk is over, on both its success and its failure path
(a `SIGKILL`ed generation 0 never reaches its own `finally` -- the signal tears the process down
first, exactly like the barrier's own kill path -- so in every one of the four cases it is
generation 1 that releases generation 0's still-living child). A bounded safety cap
(`HOLD_SAFETY_CAP_MS`, well under `RUNNER_BUDGET_CEILING_S`) is the backstop if nothing ever writes
the file, and `vitest`'s own worker teardown is the backstop beyond that for an aborted run, exactly
as it already is for the session belt's own fake-CLI fixture. A dedicated harness-side reaper would
still be solving a problem this fixture does not have; the observation is recorded here rather than
left implicit, per the fault belt's own request to have this question actually evaluated.

A second codex review round, on the merged tip, caught a related race in
`SessionObserver.liveProcessReport()`: the stop-file release above makes the fake CLI's own normal
exit and the observer's ledger-snapshot-then-`/proc`-check race each other, so a process that exited
in that narrow window read as an unexplained death (`null`, "indeterminate") rather than the closed,
ordinary interval it was. Fixed by re-reading the ledger for that specific `(uuid, pid)` immediately
before declaring indeterminate, rather than judging a still-open ledger entry against the snapshot
taken before the `/proc` check ran.

A third round caught the remaining half of the same shape: writing the stop-file marker does not
prove the detached child has *seen* it yet (the fake CLI polls every 20ms), and nothing was waiting
for that observation before `runWalk` returned and the test's own `caseRoot()` cleanup could remove
the workdir the marker lives in -- a fast case could leave the still-polling child orphaned, invisible
to the marker it is waiting for, until `HOLD_SAFETY_CAP_MS` expired. `runWalk`'s `finally` now also
awaits `waitForNoLiveChild` (a bounded, `/proc`-scoped poll on the workdir's own fake-CLI marker path)
before returning, so the walk does not report done while a process this case spawned is still running.

**Decision 3 -- per-case budgets route through D-0602's scaling, not literal numbers.** The source's
`barrier_timeout_s=20.0, case_timeout_s=60.0` become `barrierTimeoutS(PROFILE)` /
`caseTimeoutS(faultCase, PROFILE)` (`test/fault_injection/policy.ts`), exactly as
`test/fault_injection/protocol.test.ts` and `cases.test.ts` already do -- scaled and held under
`RUNNER_BUDGET_CEILING_S` for this port's runners, never the manifest's own numbers written as a
literal at a new call site.

**Decision 4 -- the Linux-lane skip is read from the manifest, not re-derived from
`process.platform`.** The source's file-level `pytestmark = pytest.mark.skipif(not _LINUX, ...)`
becomes a per-test `skipIf(laneSkipReason(...) !== null, ...)`, reusing `test/fault_injection/
policy.ts`'s own `laneSkipReason` -- the same lane test every other manifest case in
`cases.test.ts` already trusts, since all four session-start cases already declare `"lane":
"linux"` in the manifest. This is a narrowing of translation effort, not a new policy: the reason
text and the underlying platform check are unchanged.

**Totals.** `gate_item2` is 34/34 ported (26 `ported` + 8 `adapted`, 0 waivers, 0 not-ported).
`parity/gate_item2.session-driver-harness.ledger.json` records the 6 as `adapted` (D-0801's
async-everywhere change, this entry's budget/lane/teardown adaptations, and the translation
itself). `parity/source-inventory.belts.md` moves `gate_item2` from `candidate-lane` to `in-scope`
(ratified 2026-08-29), the same status the D-0801 entry above already anticipated moving to once the
deferral closed.

**Falsifier.** If a future session-start case becomes a combination case (more than one target, or
a staggered kill), Decision 2's "single-role, non-combination" premise no longer holds and the
no-reaper conclusion needs re-evaluating against that shape specifically -- a role process being
sigkilled while its own grandchild's parent role is a *different, still-alive* role would be a genuinely
new hazard this task's four cases cannot exercise.

**Source.** Task `continuo-session-adapter-followon`, 2026-08-29, porting
`tests/gate_item2/test_session_driver_harness.py` from interlock `65f36c5` and re-binding
`test/fault_injection/session_driver.ts` per D-0601's declared follow-on.

---

## D-0901 -- The attention belt takes `D-09xx`; the six-name fact vocabulary is adopted, not merely restated

**Context.** `D-0302` wrote the six watcher fact states into this repository and was explicit about
how far that went: "a restatement for the oracle's sake, not an adoption. Continuo has no watcher
and this entry does not give it one." The names existed here so that the ported S1 prose lint had
something to read; nothing in `src/` was entitled to treat them as its own vocabulary. Two places
nevertheless carried the list already -- `src/measurement/fixtures.ts`, which refuses a seventh
value on a fixture label, and `test/fault_injection/contract.ts`, which validates against it -- and
each had its own local reason, which is exactly the shape a vocabulary drifts apart in.

`D-0034` ratified, at the 2026-08-30 human gate, that A1 would be the belt that closes this: "A1's
own work will carry a new `D-` entry, in the range this belt allocates, that supersedes D-0302's
limitation and adopts the vocabulary as more than a lint oracle." This is that entry, and it is the
first in the `D-09xx` range D-0034 allocated to the attention belt.

**Decision.** The closed set is the vocabulary continuo's **detector layer** uses. It is stated in
`src/attention/fact_state.ts` as a union type, a frozen list and a refusal, and nowhere in that
module is there a predicate, a semantics, or a mapping from anything to a fact state -- interlock
`Q-0012` is open and a port does not answer an upstream question by shipping an implementation of
it. The set, unchanged from `D-0302` and from interlock `D-0005`:

- `ACTIVE_EVIDENCE`
- `KNOWN_WAIT`
- `EXPLICIT_BLOCK`
- `NO_ACTIVITY_EVIDENCE`
- `OBSERVATION_UNAVAILABLE`
- `TERMINAL`

The procedural half is carried with the names, as it was at `D-0302` and at interlock `D-0005`: a
seventh state is added by a new `D-` entry in this file, never by editing a list inside a module or
a test.

**`D-0302` is superseded in its limitation and left textually untouched.** Not out of tidiness:
`test/session/provider-contract.test.ts` locates the closed set by splitting `DECISIONS.md` on the
literal heading `## D-0302 \u2014`, and that indirection is the substance of the ported case rather
than plumbing. Amending the entry risks the parse; rewriting the lint to read this entry instead
would change a ported case to suit a decision made after it. So both entries carry the list, which
is a drift risk this belt creates and therefore has to close --
`test/contract/fact-state-vocabulary.test.ts` asserts that `D-0901`, `D-0302`,
`src/attention/fact_state.ts`, `src/measurement/fixtures.ts` and
`test/fault_injection/contract.ts` all state the same six names in the same order, and that the two
`src/` copies are frozen rather than merely typed `readonly`. The harness copy is closed by `as
const` alone -- a compile-time claim that is erased at emit -- and strengthening it would be an
edit to a landed belt's file, which `D-0504` established belongs in its own PR rather than in
whichever belt happens to notice. The contract test therefore **records** that difference with an
assertion rather than repairing it, so that the day someone freezes it the record goes red and is
updated deliberately.

**The DDL is the sixth party and agrees by carrying no constraint at all.** `incident.fact_state`
is unconstrained text in both `src/control_plane/spike_schema.sql` and
`src/control_plane/migrations/0001_initial.sql`, because a `CHECK` duplicating the closed set would
turn a `D-` entry that extends it into a migration of a schema that promises none. `D-0034`
ratified that this belt carries that as-is rather than repairing it, so the contract test asserts
the **absence**: the only `CHECK` mentioning the column is `length(fact_state) > 0`, and no fact
state is named inside the table. `test/control_plane/spike-schema.test.ts` keeps its behavioural
pin (an unknown fact state inserts successfully) and is not touched.

**Falsifier.** `D-0302`'s own falsifier still stands and is inherited rather than retired: if
interlock adds a seventh fact state and neither entry here is updated, both this repository's lists
pass while the source's fails. What would falsify *this* entry specifically is a consumer that
needs to know what a state means -- if a belt reaches for a predicate over the set and cannot
proceed without one, the adoption was made a step too early and `Q-0012` had to be answered
upstream first. The contract test is the observation for the drift risk this entry creates: if it
ever goes red because two lists disagree, the two-entry arrangement is what was wrong, not the
adoption.

**Source.** Task `continuo-attention-a1`, 2026-08-29, porting `tests/attention/test_readers.py`
and `tests/attention/test_classifier.py` from interlock `65f36c5`. Decision id from the `D-09xx`
range allocated to the attention belt by `D-0034`, and the first id A1 mints in it.

---

## D-0902 -- A1 lands the one `config.ts` constant its classifier imports; the config belt stays A2's

**Context.** `D-0034` split the attention belt into A1 (facts, 90 cases), A2 (dedup and config, 44
cases) and A3 (notify and pipeline, 60 cases). The split is by *test file*, and the source's module
graph does not respect it: `classifier.py` -- A1's subject -- imports `DEFAULT_NOTIFY` from
`config.py`, which is A2's. A1 cannot resolve a severity without it, and A2 cannot start until A1
has landed the classifier those cases run against.

Three options were weighed. **Waiting for A2** inverts the dependency the source has and would
leave A1's 61 classifier cases unportable. **Moving the constant into `classifier.ts`** makes the
port's module graph differ from the source's for a scheduling reason, and A2 would then have to
move it back, which is a diff whose only content is undoing this one. **Landing the file with only
what A1 needs** keeps the graph the source's and leaves A2 an ordinary addition.

**Decision.** `src/attention/config.ts` exists and holds exactly two names: `Severity` and
`DEFAULT_NOTIFY`, both carried from the source unchanged. `AttentionConfig`, the loader, `Template`,
the placeholder allowlist and the sound modes are **not** here and are A2's to add;
`tests/attention/test_config.py`'s 34 cases are untouched by this belt and are not in any ledger it
writes. The file's own header says so, so the next reader of it does not have to reconstruct the
split from two decision entries.

`DEFAULT_NOTIFY` is built with `Object.create(null)` and read with `Object.hasOwn`, per
`docs/test-translation-conventions.md` rule 9: the attention kind is a caller-supplied string used
as a map key, Python's `dict` has no inherited keys, and an object literal carries
`Object.prototype`. A target-only case pins that a notify map keyed by `toString` overrides nothing.

**This was put to the window rather than decided in the belt.** The scope boundary between A1 and
A2 is a ratified one, and a worker narrowing or widening it on its own authority is the failure
mode `D-0031`'s gate exists to prevent. The window's answer, on 2026-08-29, was that a minimum seam
inside a ratified three-way split is an implementation detail it can settle, on two conditions --
that the ledger and a `D-` entry record the boundary, and that the file itself carries a line for
A2's brief. Both are met.

**Falsifier.** If A2 finds that `DEFAULT_NOTIFY` cannot be completed in place -- that the loader
needs it to be a different shape, say, or that the config belt's own cases pin a construction this
file forecloses -- then landing it early was wrong and the constant should have travelled with its
belt. The observation is A2 having to *change* this file rather than *extend* it.

**Source.** Task `continuo-attention-a1`, 2026-08-29. Boundary confirmed by the window in the same
task before implementation began.

---

## D-0903 -- The classifier carries a fact state it is given and derives none; the retargeted invariant is a guard with measured probes

**Context.** `parity/source-inventory.belts.md` classes every `attention` file as `carry
(invariant) / rewrite (mechanism)` and names `test_classifier.py`'s invariant as the strongest in
the subsystem: *every row of the fact vocabulary has a pinned expectation*. In the source, the
vocabulary being pinned is its own eighteen-value classification table -- the `notify_sent`
subtypes and the per-kind severity defaults. Continuo has neither a watcher nor that table's
purpose, and `D-0034` ratified that the port re-derives the invariant onto the closed fact-state
set instead, while **not** inventing the mapping from the source's eighteen `kind` values to the
six states: "every ported case is required to give its fact state explicitly, so no
continuo-authored kind-to-state table exists for a belt case to silently depend on."

That leaves the shape of the port to decide, and there are only two ways a fact state can reach an
`AttentionEvent`: the classifier derives it, or the caller supplies it. Deriving it is the
forbidden table under another name -- a `switch`, a default, or a lookup are the same object.

**Decision 1 -- the fact is an input, required, and carried uninterpreted.** Every row
`src/attention/classifier.ts` accepts carries a `factState`, and the event it produces carries that
same value back. Nothing in the module reads it, branches on it, or validates it against the row's
kind. This is the posture `D-0021` and `D-0302` already give `SessionReadout`, where a provider's
own lifecycle word is carried without conversion because conversion belongs to the detector layer;
the classifier is downstream of that layer, so the fact arrives already decided.

The field is **required and has no default**. An optional field needs a fallback, and the only
fallback available is a function of the row -- which is the table again, with one row. Requiring it
makes a caller who has not decided a compile error instead of a silent guess.

**Decision 2 -- the retargeted invariant is a guard whose falsification is measured, not assumed.**
`test/attention/classifier.test.ts` holds `PINNED_FACT_STATES`, one pinned expectation per
vocabulary row, and asserts set equality against `FACT_STATES` in both directions. Its keys are the
vocabulary and its values are what the classifier must do with each; it is not a mapping *to* a
fact state and nothing in the belt reads it as one. The fact states named by the 61 ported cases
are deliberately rotated across cases of the same kind, so no reader can extract a kind-to-state
table from the pattern, and a target-only case asserts the absence directly: the same row under two
different fact states classifies identically in every field but the one that was varied.

A "for every row of the vocabulary" check is **green on an empty vocabulary**, which is precisely
the shape that rots into a guard nobody has seen fail. So the belt follows the secretary belt's
seven-probe precedent and records each probe measured red in
`parity/attention.classifier.ledger.json`, rather than shipping an unfalsified guard with a
confident comment on it.

**Rejected alternative: parametrising the carry-through over `FACT_STATES` directly.** It is
shorter and it covers all six automatically, and that is the problem -- a table derived from the
vocabulary agrees with the vocabulary by construction and can never disagree with it, so the guard
would assert nothing about whether anybody had actually pinned anything. The literals are written
out for the same reason `D-0302` refused to copy a list into a test: the check has to be able to
fail.

**Falsifier.** If a later belt -- A3's pipeline, most likely -- finds that no caller is in a
position to supply a fact state, then the fact does not belong on the classifier's input at all and
this shape is wrong; the observation would be A3 having to invent a value to pass, which is the
forbidden mapping arriving one layer up. Conversely, if `Q-0012` is settled upstream and a genuine
kind-to-state derivation is published, this entry is superseded by one that adopts it rather than
amended -- the port does not get to author that mapping either way.

**Source.** Task `continuo-attention-a1`, 2026-08-29, porting
`tests/attention/test_classifier.py` (61 cases) from interlock `65f36c5`, under `D-0034`'s
ratified constraints.

---

## D-1001 -- The gate_item11 belt takes `D-10xx`; `src/index.ts`'s dual re-export is an allowlisted exception, and `test_suite_runs_unchanged.py` is a declared follow-on

**Context.** Gate item 11 (interlock issue `#20`, `ACCEPTANCE.md` section 1) claims that swapping
the session backend costs the control plane nothing: no provider detail may leak into it, and the
control-plane suite runs unmodified against either provider. `tests/gate_item11/` measures that in
64 node ids across four files. D-0034 ratified the belt's start (2026-08-30) and allocated `D-10xx`.
This task is the belt's first PR: the 51 cases in `test_no_provider_detail_leaks.py` (35),
`test_registry_availability.py` (4) and `test_substitution_scenarios.py` (12). The remaining 13
(`test_suite_runs_unchanged.py`) are a declared follow-on, Decision 3 below.

**Decision 1 -- AST scanning re-derives the source's two leak predicates against continuo's module
graph, using the shared `importedModules` primitive (D-0504).** The source's
`_names_a_session_backend` and `_knows_a_session_backend` ask two different questions over Python's
dotted module names: the first has no exception for the S1 contract module
(`claude_org_runtime.session.provider`) and is used only over the control-plane package and its own
suite; the second excludes the contract and is used only over the whole of `src/` and the whole of
`tests/`, because `src/supervisor.ts`'s join between session and the control plane is a cost D-0009
accepts. Both are ported as path-containment predicates (`namesASessionBackend`,
`knowsASessionBackend` in `test/gate_item11/no-provider-detail-leaks.test.ts`) over
`test/testkit/ast.ts`'s `importedModules`, which resolves a relative specifier to an absolute path
rather than leaving a dotted name to compare by prefix -- the same primitive
`test/messagebus/import-graph.test.ts`, `test/canary/structural.test.ts` and
`test/secretary/structural.test.ts` already share (D-0504). The two directory walks the source
parametrizes over (`src/control_plane/`'s `rglob("*.py")`, `tests/control_plane/`'s) are ported as
listings, not hand-written lists, following the same precedent
`test/messagebus/import-graph.test.ts` set: a `.ts` file with no `.py` analogue (`connection.ts`,
`python_json.ts`, `python_repr.ts`, `refusals.ts`, `spike.ts` under `src/control_plane/`;
`differential-oracle.test.ts` under `test/control_plane/`) still gets a case, declared target-only in
`parity/gate_item11.no-provider-detail-leaks.ledger.json`; a `.py` file with no `.ts` analogue
(`__init__.py` under `src/control_plane/`, `src/control_plane/migrations/` and
`tests/control_plane/`) is `not-ported` there, with no coverage lost since the property is checked
over every file each directory actually contains.

**Decision 2 -- `src/index.ts`'s dual re-export is an allowlisted exception to
`test_no_shipped_module_knows_both_a_provider_and_the_control_plane`, ratified here with its
falsifier.** interlock's per-directory `__init__.py` package layout never produces a single module
that re-exports both a session backend and the control plane -- the source's own version of this
test finds nothing. continuo ships one package entry point (D-0002, `exports` restricted to `.`), so
`src/index.ts` is the one barrel that must re-export everything: it re-exports `./control_plane/*.js`
directly and `./session/index.js`, which itself re-exports both `LocalProcessSessionProvider` (S3)
and `ClaudeCliSessionProvider` (S2). Measured: without an exception, `src/index.ts` is the only file
under `src/` this scan finds, and it is a structural consequence of D-0002 rather than a leak of
knowledge into an implementation module -- nothing in `src/index.ts` acts on a provider's state or
composes it with control-plane logic, it only re-exports both vocabularies to the same top level.
The exception is named explicitly in `test/gate_item11/no-provider-detail-leaks.test.ts`
(`ALLOWED_BARRELS`) and recorded in `parity/gate_item11.no-provider-detail-leaks.ledger.json`'s entry
for that case, rather than narrowed into the scan itself, so it stays visible to a reviewer and to a
future case that adds a second barrel.

**Falsifier.** A subpath-exports split (`./control_plane`, `./session` as two separate entry points
under `exports`, in place of today's single `.`) that let a provider swap touch only the `./session`
subpath -- never `src/index.ts`'s control-plane half -- would remove the structural reason for this
exception, and the day such a split lands, this exception should be revisited rather than carried
forward by inertia. Splitting exports is not this task's move: D-0002 is a separate, already-ratified
decision, and nothing here proposes revisiting it.

**Decision 3 -- `test_suite_runs_unchanged.py`'s 13 cases are a declared follow-on, not silently
dropped.** The source measures item 11's exit condition operationally: run the control-plane suite
twice, once under `-p tests.gate_item11.provider_plugin` (a live session bound before collection) and
once without, and diff the outcomes, the collected test ids and a SHA-256 of every collected file.
Porting that needs a scoped subprocess double-run of continuo's own suite -- spawning `vitest run`
twice, once with an environment variable a `globalSetup` reads to bind a live provider before the
suite starts, and comparing the two JSON reporter outputs -- which is a different shape from
anything this belt's first three files needed, and CLAUDE.md's own belt guidance requires a spike
before that shape is committed to. It is out of this task's scope; `parity/source-inventory.belts.md`
records it as the belt's declared next PR, and `gate_item11` stays `retarget` (not `in-scope`) until
that PR lands and the belt reaches 64/64.

**Totals.** `parity/gate_item11.no-provider-detail-leaks.ledger.json` records 35 cases (0 `ported`,
32 `adapted`, 3 `not-ported`, 0 waivers). `parity/gate_item11.registry-availability.ledger.json`
records 4 (4 `ported`). `parity/gate_item11.substitution-scenarios.ledger.json` records 12 (0
`ported`, 12 `adapted`, since every S1 verb is `Promise`-returning per D-0301) -- the six `[S2]`
cases are `conditionally_collected`: `vitest list` omits a `skipIf`-gated case entirely where pytest
still collects a skipped node id, gated on whether the real `claude` CLI is on `PATH` (the same
premise `parity/gate_item2.mediated-real-provider.ledger.json`'s two capability gates document).

**Falsifier (Decision 3).** If the spike for the subprocess double-run shape shows it does not scale
or does not reproduce the source's comparison faithfully, the belt's approach to
`test_suite_runs_unchanged.py` is what is wrong, not this task's scoping decision to defer it.

**Source.** Task `continuo-gate-item11-p1`, 2026-08-29, porting
`tests/gate_item11/test_no_provider_detail_leaks.py`, `test_registry_availability.py` and
`test_substitution_scenarios.py` from interlock `65f36c5`, under the belt start D-0034 ratified.
---

## D-0119 -- The remaining six measurement files convert whole, closing out the belt's per-case control-plane creation

**Context.** D-0118 converted `provenance.test.ts` and `latency.test.ts`, the two heaviest files, and
left `cohort.test.ts` and `render.test.ts` already on the template from earlier PRs -- four of the
belt's ten files. Six still built a production control plane per case: `ac9.test.ts` (40 call
sites), `canary.test.ts` (28), `windows.test.ts` (24), `reader.test.ts` (23),
`false-termination.test.ts` (20) and `shadow.test.ts` (17), 152 in total. This task's brief estimated
all ten files as unconverted; the survey above (call sites counted from each file's own
`productionDb(` occurrences, cross-checked against the pre-task tree at `8ff9124`) found four already
done, and the window narrowed the task to the remaining six before any conversion work started.

**Decision.** All six files convert, and every one of their 152 fixture call sites converts -- there
are no exclusions, judged the same way D-0118 judged its two:

- **Nothing here has creation as its subject.** Each file contains exactly one
  `createProductionControlPlane` call, in its own fixture (`ac9.test.ts` additionally parameterises
  the copy's filename, which `suiteTemplate.copyInto`'s `as` argument already carries, the same shape
  `provenance.test.ts` kept in D-0118).
- **Nothing here asserts what an opener would verify against a constant.** None of the six files
  compare a stamp or fingerprint to a hardcoded value; where a digest is taken (`reader.test.ts`,
  `canary.test.ts`) it is compared against a digest of the same file taken earlier in the same case,
  which a template copy satisfies identically to a per-case build.
- **`patchSeam` never precedes the fixture in a way that matters.** `canary.test.ts` and
  `reader.test.ts` each call `patchSeam` on `readerSeams` (`openReadOnly`, `proveReadOnly`) --
  never on `schemaSeams` or `migratorSeams`, the two seams a converted template's lazy build could
  run through. This is now moot regardless of call order: `suiteTemplate` registers its build in the
  file's own `beforeAll`, which runs before every case's body, so no per-case seam patch can reach the
  build in the first place.
- **Nothing here needs a database that does not exist yet.** None of the six files contains an
  `existsSync`, an `unlinkSync`, or an assertion about a file's absence.

**Measurement.** Per-fixture cost on this Linux box, N=30: **85.93ms** to create a production control
plane against **0.60ms** to copy one -- consistent with D-0118's 42.5ms/0.68ms figure on the same
methodology (the difference in the create figure is machine variance between tasks, not a regression;
the copy figure is stable). Running the six files together, `tests`-phase wall clock (vitest's own
reported segment, three runs each side, this box, both states rebuilt from `dist/` before each run):
before **40.08s / 50.58s / 51.51s**, after **16.67s / 27.11s / 31.64s** -- roughly halved despite this
box's shared-runner noise (the paired `Duration` figures move the same direction: 13.79-19.28s before
against 11.16-17.83s after). As in D-0118 and D-0029, the Linux figures understate the point: what
each converted call site removes is one `fsync`, and Windows CI cells pay for those specifically.

Verified the way D-0118 was: `npm run typecheck`, the full suite (`npm test`, 78 files / 2423 passed +
2 expected-fail + 1 skipped, unchanged from before this branch), `npm run parity` (2425 target tests
collected, matching the pre-existing ledger) and `npm run inventory` (2194 node ids across 77 files,
matching the suite baseline at `65f36c5`) all pass against the converted tree. No case's assertions,
node ids, or ledger totals changed; only the six files' `productionDb` fixtures did.

**Alternatives.**

- **Convert only the files the brief named as highest call-site count first, deferring the rest
  (rejected).** Nothing in D-0118's exclusion analysis distinguishes any of the six files from the
  four already converted; deferring any of them would leave that file's per-case `fsync` cost on
  Windows CI for no reason tied to risk or size.
- **Raise the per-test timeout for `ac9.test.ts`'s bounded-figure case instead (rejected, D-0029's
  position kept).** The brief for this task explicitly forbids raising the cap; this decision reports
  whether the conversion resolves that file's known Windows flake as an observation, not as the fix.

**Consequences.**

- Case counts are unchanged file by file. No ledger changed; only how each file's `productionDb`
  fixture is built.
- This closes the measurement belt's own per-case control-plane creation: after this task, no file
  under `test/measurement/` builds a production control plane inside a case body rather than in a
  file-scoped `suiteTemplate`.
- The known Windows-only 60s timeout on `ac9.test.ts`'s bounded-figure case (noted in this task's
  brief) could not be reproduced or disproved from this Linux box; the fixture-cost mechanism it was
  attributed to is now removed from that file, and whether the flake is actually gone is left for the
  next Windows CI run to show rather than claimed here.

**Falsifier.** A case in any of the six files that comes to need a database which does not exist yet,
that asserts a stamp against a constant rather than against the file it was handed, or that patches a
`schemaSeams` or `migratorSeams` entry before taking its fixture -- the two records the template's
lazy build runs through. Any of the three puts that case back on `createProductionControlPlane`, the
way D-0118's are.

**Status.** accepted

**Source.** Task `continuo-measurement-suite-template`, 2026-08-29, closing out the measurement belt's
suiteTemplate migration D-0118 started. Measured on Node 22.17.0, better-sqlite3 13.0.3, vitest
4.1.11. Decision id allocated in the measurement belt's own `D-01xx` band (see "How to use this
file"), the next free id after D-0118.

---

## D-1002 -- The gate_item11 belt completes at 64/64: `test_suite_runs_unchanged.py`'s double-suite-run measurement lands as a vitest `globalSetup` plus a subprocess double-run over `--reporter=json`, and continuo#70 is resolved as intentional

**Context.** D-1001's Decision 3 deferred `tests/gate_item11/test_suite_runs_unchanged.py`'s 13
cases -- the operational half of item 11's claim, run the control-plane suite twice (once with a
live session bound before collection, once without) and diff the outcomes, the collected ids and a
digest of every collected file -- pending a spike into whether continuo's own suite runner supports
the same shape. This task is that spike plus the port.

**Decision 1 -- the spike confirms the shape and finds it needs no pytest-plugin analogue: vitest's
own `--reporter=json` already carries what `outcome_recorder.py` had to be written to collect.**
Measured directly (`node_modules/.bin/vitest run <file> --reporter=json --outputFile=<path>`,
vitest 4.1.11): the JSON reporter's `testResults[]` gives, per file, a `status` (`"passed"` /
`"failed"`) and a `name` (the file's own path, usable for both a digest and an outcome key), and per
test inside it an `assertionResults[].status`. Two further measurements this decision rests on:

- **Hook failures are distinguishable from test failures without a custom reporter.** A `beforeAll`
  throw sets every contained test's `status` to `"skipped"` and the *file's* `status` to `"failed"`;
  an `afterAll` throw leaves every contained test `"passed"` and only the file `"failed"`. That is
  enough to tell "a test started passing only because its fixture stopped running" (source's own
  worry, `test_every_test_reaches_the_same_verdict_either_way`'s docstring) from "the suite's own
  results are unchanged but teardown broke" -- not the same setup/call/teardown vocabulary pytest's
  plugin recorded, but a strictly comparable pair (`{test, file}` per id) for the same purpose. See
  `test/gate_item11/support/run.ts`'s own module doc.
- **A `globalSetup` module that throws aborts the run, but the JSON reporter still writes a report**
  (`{success: false, testResults: []}`), unlike pytest where a failed `pytest_configure` leaves no
  report file at all. `support/run.ts` checks `testResults.length > 0` (via the `outcomes` map
  built from it) rather than the source's `report.exists()`, which is the direct translation of the
  same fail-closed intent (D-0010): a provider that could not qualify must not produce a
  measurement that looks like anything ran.

Consequence: `outcome_recorder.py` has no port. `test/gate_item11/support/run.ts` reads vitest's
JSON reporter output directly and builds the outcome/artifact maps `suite-runs-unchanged.test.ts`
compares, which is a re-derivation against continuo's own test runner rather than a line-for-line
port of a pytest plugin whose whole reason to exist was that pytest did not expose this by default.

**Decision 2 -- the "provider fixture" is a `globalSetup` module read by a dedicated vitest config
(`support/suite-runs-unchanged.config.ts`), not a flag on the main config.** Vitest has no
per-invocation plugin flag analogous to pytest's `-p`, so the source's `argv += ["-p",
"tests.gate_item11.provider_plugin"]` (present only for the bound run) has no direct target. The
config file's `globalSetup` entry is always present; what varies between the two runs is whether
`support/provider-plugin.ts`'s `globalSetup` finds `CONTINUO_ITEM11_PROVIDER` in the subprocess
environment `support/run.ts` builds -- absent, it returns immediately and is inert, the same
"harmless when unset" contract the source's own `outcome_recorder.py` documents for `REPORT_ENV`.
Measured (nested-vitest spike): a `vitest run` subprocess spawned from inside a running vitest
worker works cleanly with no environment-variable interference once `VITEST`/`VITEST_POOL_ID`/
`VITEST_WORKER_ID` are not force-inherited by accident, and `test/control_plane`'s 605 cases run in
~7s either way -- three such runs (unbound, `[S3]` bound, `[S2]` bound) comfortably inside a single
outer test's budget, which is why `CASE_TIMEOUT_MS` is generous (900s) rather than tuned to the
measured figure: the same asymmetry `vitest.config.ts`'s own `testTimeout` comment gives for a slow
CI cell. The config is spawned via `node <repo>/node_modules/vitest/vitest.mjs run --config <path>`
(`process.execPath` plus the package's own `bin` target) rather than `node_modules/.bin/vitest`, so
the subprocess launch does not depend on a POSIX shebang shim continuo's own Windows cell lacks.

The double-run's own config deliberately does not reuse `vitest.config.ts`: that file's
`resolveSeed()` throws under CI without `CONTINUO_TEST_SEED` (D-0005), which has nothing to do with
item 11, and this measurement compares *outcomes and artifact digests*, not order-sensitivity --
the main config's own job, D-0005's double-green rule already covers it. `support/suite-runs-
unchanged.config.ts` runs in collection order, no shuffle.

**Decision 3 -- `driveOnce` (the source's `drive_once`) is added to `test/gate_item11/
substitution.ts` rather than to a new file.** Part 1 (D-1001) did not need it, since nothing in the
51 cases it ported drove a full lease-to-outbox round trip to *qualify* a provider before a
measurement -- that is `provider_plugin.py`'s job alone in the source, and its TypeScript home is
the module already documented as "the one file in this fixture package that turns a provider's own
words into a `session` row", which `driveOnce` also does, just as a precondition rather than as an
assertion. Async because every `SessionProvider` verb it calls is `Promise`-returning (D-0301); the
sqlite operations inside it stay synchronous, as `bindSession` already was.

**Decision 4 (continuo#70) -- `test_substitution_scenarios.py`'s (and its port's) never calling
`registry.disqualified()` is the source's own design, not a gap this belt should close.** Verified
directly against interlock at `65f36c5`: `grep -n disqualified tests/gate_item11/
test_substitution_scenarios.py` returns nothing -- the source's own `entry` fixture skips on
`unavailable()` only, never calls `disqualified()`. The only source call site is
`provider_plugin.py`'s `bind()`, now ported as `support/provider-plugin.ts`'s `globalSetup` in this
task. The reason is the shape of what each file measures: `test_substitution_scenarios.py` exercises
the control-plane binding path itself, case by case, so a session whose readout would disqualify it
is exactly a case worth having (the binding logic still has to translate whatever state a provider
reports, disqualifying or not -- `sessionRow`'s `OBSERVATION_WORD` mapping has no third case for
"disqualified"). `test_suite_runs_unchanged.py` instead spends an entire double-suite-run measuring
against one bound session, and `disqualified()` is the fail-closed gate (D-0010) that stops it from
spending that cost on a backend already known to be broken, *before* either subprocess starts.
Nothing here changes; `test/gate_item11/substitution-scenarios.test.ts` is unmodified by this task.

**Totals.** `parity/gate_item11.suite-runs-unchanged.ledger.json` records 13 (0 `ported`, 13
`adapted`, 0 `not-ported`, 0 waivers) -- all `adapted`, since every case reads `support/run.ts`'s
`{test, file}` outcome pair or the `globalSetup`-printed stdout rather than pytest's own per-phase
dict, per Decision 1. The six `[S2]` cases are `conditionally_collected`, the same premise
`parity/gate_item11.substitution-scenarios.ledger.json`'s six declarations and
`parity/gate_item2.mediated-real-provider.ledger.json`'s two capability gates already document.
`parity/source-inventory.belts.md` moves `gate_item11` from `retarget` to `in-scope` (ratified
2026-08-30, D-0034; completed 2026-08-29), the belt's own precedent from D-1001's text. The belt is
now 64/64.

**Falsifier.** If a future continuo test runner migration removes `--reporter=json` or `globalSetup`
support, or changes either's semantics around hook-failure status or an aborted run's report
contents, `support/run.ts` and `support/provider-plugin.ts` need re-verification against the new
runner before this measurement can be trusted again -- this decision rests on vitest 4.1.11's
measured behaviour, not on a documented contract either module promises to keep.

**Source.** Task `continuo-gate-item11-p2`, 2026-08-29, porting
`tests/gate_item11/test_suite_runs_unchanged.py` from interlock `65f36c5`, completing the belt D-0034
started and D-1001 began, per the spike-first approach that task's brief required.

---

## D-0904 -- Dedup state fails closed: an absent namespace is empty, a present but unusable one is a refusal; the belt's `datetime` transcriptions get one home

**Context.** `PORTING_LEDGER.md`'s row for `attention/dedup.py` carries the two dedup namespaces --
record-once for `events`, cooldown-gated for `pending` -- and rules **out** the module's corruption
handling in the same breath: "a broken state file recovers as empty" was safe while this was an
advisory notification ledger, and once dedup state is durable and authoritative an empty ledger says
nothing has been notified, so every already-handled event is free to fire again. That is the
resume-without-double-execution violation `D-0001` exists to prevent. `parity/source-inventory.
belts.md` names the two source cases that pin the defect, and `D-0034` ratified the repair as
**fail-closed, inside A2**, with rebuilding the state from durable records named as declined-for-now
rather than silently out of scope. `D-0023` supplies the rest of the procedure: the case that pinned
an inherited behaviour is inverted in the change that repairs it, and the divergence stays reachable
from the parity ledger.

What none of that settles is **where the new line falls**, and the source has four silent recovery
paths, not two. This entry is that boundary.

**Decision 1 -- an ABSENT namespace is empty; a PRESENT but unusable one is a refusal.** The line is
between "no state was written" and "state was written and cannot be trusted", and it is drawn once
for the file and for each namespace inside it:

- a **missing file** loads as an empty `DedupState`, unchanged from the source. Nothing has ever
  been notified, and creating one is the legitimate next step. `test_load_missing_returns_empty`
  ports straight.
- a **missing `events` or `pending` key** is an empty namespace, unchanged from the source, for the
  same reason one level down. `test_load_partial_shape` ports straight, and it is the case that
  fixes this half of the line.
- everything else refuses with `DedupStateRefused`: an unreadable file, a blank one, text that is
  not JSON, a top level that is not an object, a namespace that is present and is not an object, and
  an entry whose value is not a string. The last two are the repaired defect at a narrower scope --
  the source substitutes `{}` for the first and silently drops the entry for the second, and a
  dropped entry is one already-notified key forgotten, which is exactly the effect the repair
  exists to prevent.

**An undecodable byte is on the refusing side too, and the first draft of this decision got it
wrong.** The draft read the file with Node's `utf8` mode and recorded that an undecodable file
reaches a refusal either way, at the JSON parse -- Python raises `UnicodeDecodeError` there, which
is a `ValueError` and escapes its own `except OSError`, so the source CRASHES rather than
recovering. That reasoning holds only when the bad byte breaks the syntax. A bad byte **inside a
JSON string** leaves the document valid: Node substitutes U+FFFD, the parse succeeds, and the state
loads carrying a dedup key that is not the key that was written -- an already-notified event free to
fire again, arriving through the reader this repair exists to harden. The file is read as bytes and
decoded with a fatal `TextDecoder`. Found by the codex review gate on the finished belt, which is
where the claim's own falsifier finally got exercised.

**A blank file is on the refusing side, and that is the one call here that is not forced.** The
source returns empty state for it without even a warning, so it could be read as a third flavour of
"nothing was written". It is not: `saveState` writes through a fully-written temporary file and a
rename, so it never produces a blank one, and a blank file at that path is therefore a truncation
from outside -- the same class of event as a half-written document, arriving with no content to say
so.

**`DedupStateRefused` is its own family, not `src/control_plane/refusals.ts`'s.** That file
documents itself as *the control plane's* refusals and its class identity is load-bearing across the
two modules that share it, so a `catch` written about a database must not begin catching an
attention state file. The cost is one more small class; the alternative couples two subsystems
`D-0009` separates, for the sake of a message.

**Decision 2 -- the belt's `datetime` transcriptions live in `src/attention/pytime.ts`, not
privately inside whichever module needed one first.** `dedup.py` and `classifier.py` both round-trip
an ISO-8601 timestamp through `datetime`, and both depend on CPython's exact answers rather than on
the platform's:

- `datetime.fromisoformat` accepts a **narrower** grammar than `Date.parse`, which takes shapes it
  rejects (`"05/12/2026 11:59:00"`, `"May 12 2026"`) and rolls an impossible date forward
  (`2026-02-30`) where `fromisoformat` raises -- and reads a naive `"2026-05-12T11:59:00"` as
  **local** time where the source attaches UTC.
- `datetime.isoformat` prints **no** fractional part when the microsecond field is zero and **six**
  digits when it is not, where `Date#toISOString` always prints three.

Every one of those differences turns a garbled or old stored timestamp into a recent one, or changes
the bytes of a durable file.

**The grammar is measured, not recalled, and the first transcription was too narrow.** A2 inherited
A1's regex -- extended calendar dates, a `T` or space separator -- and the codex review gate
observed that `fromisoformat` on CPython 3.12 takes considerably more than that: basic format
(`20260512`, `115900`), ISO week dates (`2026-W20-2`, `2026W202`, `2026-W20`), an hour-only or
hour-and-minute time, **any** single character as the date/time separator, a two-digit-hour offset,
a sub-second offset, and a fractional second **truncated** rather than rounded at six digits. Every
form left out is a stored timestamp the port would read as garbled while the source read it as
real -- an extra notification where the source applies the cooldown, which is the safe direction and
still not parity. The grammar was re-derived by running 68 inputs through `datetime.fromisoformat`
on CPython 3.12.3 (the interpreter interlock's suite runs on at `65f36c5`) and against `parseIso`;
all 68 now agree, and 26 of them are pinned in a target-only case. The measurement also caught a
defect the reviewer had not named: a sub-second offset whose fraction was being stripped put the
instant a whole **second** away, not a microsecond.

**A second review round found four more, and the set grew to 90 inputs.** An ISO week can resolve
*outside* `datetime`'s own year range (`9999-W52-7` is "year 10000 is out of range"), and letting it
through was the one divergence here in the dangerous direction -- a garbled stored value read as a
**future** instant, which suppresses a notification rather than letting it through. `Date.UTC`'s
two-digit-year remapping had been undone for calendar dates and not for the week resolver, which is
rule 11's own shape: a repair applied at one entry point and not at its sibling. A UTC offset whose
hour, minute and second are all zero discards its fraction in CPython, so `+00:00:00.5` is plain UTC
while `+00:00:02.25` is 2.25 seconds. And the date/time separator is one character to Python, which
indexes a `str` by code point, and two UTF-16 units here when it is astral. All 90 inputs now agree,
and each of the four carries its own probe.

**A third round found two more, and one of them was introduced by the first round's own fix.** The
fractional second attaches to the end of whatever precision was written -- `11.5` is 11:00:00.500000
and `11:59.5` is 11:59:00.500000, and an abbreviated offset takes one too -- where the grammar
allowed it only after a seconds field; the set is now 100 inputs and all 100 agree. And the fatal
`TextDecoder` that closed the U+FFFD hole **strips a leading BOM by default**, where the
`readFileSync(path, "utf8")` it replaced did not and Python's `utf-8` codec does not either
(stripping is `utf-8-sig`'s job). CPython's `json.loads` refuses a BOM outright, so the repair had
quietly moved a file the source rejects onto the accepting side of a repair whose whole point is to
refuse. That is rule 11's own warning arriving inside the belt that cites it, and the decode now
reads `{ fatal: true, ignoreBOM: true }` -- in **both** loaders, which is the other half of the same
round: `loadConfig` had been left on the loose decode for two rounds after `loadState` was hardened,
so an undecodable byte inside a template body would have loaded altered.

**A fourth round found one defect in each file, and each is a previous decision reaching a case it
had not considered.** A UTC offset can carry a valid boundary timestamp out of `datetime`'s own
domain -- `9999-12-31T23:59:59-23:59` parses and then raises `OverflowError` on the source's
`astimezone(timezone.utc)`, which `_parse_iso`'s `except ValueError` does not catch, so **interlock
crashes there**. This belt's second inherited-defect repair under `D-0023`, and the repaired answer
is the `null` every other unusable value already gets: the safe direction, since the year-10000
`Date` the port produced beforehand reads as a *future* instant and suppresses the notification. And
the `PyValueError` wrapper the third round put around the config decode had been wrapped around the
**read** as well, so a directory or a permission denial was reported as malformed configuration --
the source keeps `OSError` and `UnicodeDecodeError` apart and lets each propagate as itself, so the
read moved outside the try. The differential set is 104 inputs: 102 comparable ones agree and the
two CPython raises `OverflowError` on are recorded as repaired, classified separately by the
generator so a crash can never be scored as a match.

**A fifth round found the same lesson a third time: two callers holding two spellings of one
domain.** `pyIsoUtc` tested the rendered string, which admits year 0000 where `datetime.MINYEAR` is
1; `shouldNotify` tested only for `NaN`, which admits `new Date("-000001-01-01T00:00:00Z")` -- a
valid `Date` whose subtraction from a 2026 timestamp gives a *negative* age, reading as "well inside
the cooldown" and suppressing the notification exactly as silently as `NaN` did. Both approximations
were wrong in the same direction, and both were written a round apart, so they now share one
exported predicate (`isRepresentableInstant`) that a single probe falsifies for both callers at
once. Three of this belt's nine post-review defects have this one shape -- a rule applied at one of
two call sites -- which is `D-0024`'s finding restated and is the thing worth carrying out of this
belt.

**A round on the integrated tip closed the other half of the third round's own decision.**
`json.JSONDecodeError` is a `ValueError` in Python and `load_config` lets it propagate; `JSON.parse`
raises a `SyntaxError`, which a caller catching this loader's refusals would miss. Other belts in
this port *disclose* that difference rather than repairing it, and that would have been defensible
here too -- except that the config decode two lines above had already been re-raised as
`PyValueError` on exactly this argument, so the file answered one question two ways. That makes it
a fourth instance of the shape above rather than a new judgement call, and consistency inside one
function is the cheaper half to fix.

**A PR review found a fifth instance of the same shape, in a constant rather than a function.**
`ALLOWED_PLACEHOLDERS` was `Object.freeze(new Set(...))`, which seals an object's own properties
while a `Set`'s contents live in an internal slot: `.delete("pr")` and `.add("evil")` both
succeeded, measured, and A3's `render_text` reads this constant on every notification. The
repository's own `FrozenSet` (`src/session/provider.ts`) was evaluated and **not** reused, measured
rather than assumed -- it overrides the mutators and still lets `Set.prototype.add.call` reach the
internal slot, which is precisely the route a parallel lane reported as a P1, and its own header
discloses the hole. A frozen **array** has no internal slot to reach: six mutation routes including
the prototype-call ones all throw. The weaker structure is the stronger guarantee, and
`VALID_SOUND_MODES` one declaration below was already a frozen array standing in for a source
`frozenset`; the whole API cost is `.includes(name)` where a `Set` would have taken `.has(name)`.

**The case written to pin it was itself green under the regression it guards, on the first draft**
-- restored to a frozen `Set`, every array route throws for the wrong reason (`push` is not a
function there) while `.delete` goes through. It now asserts `Array.isArray` first. That is rule 10
arriving inside the fix for a rule-9 defect, and it is worth recording because the belt's own habit
of probing every guard is the only thing that caught it.

**The same review found the grammar's last gap, and it was a gap in what the oracle was pointed
at.** `parseIso` ports `_parse_iso`, whose first line is `if s.endswith("Z"): s = s[:-1] +
"+00:00"` -- not redundant with `fromisoformat`'s native `Z`, because on a **date-only** value the
rewrite is what makes `2026-05-12Z` midnight, where a parser knowing `Z` only as a time-zone suffix
consumes it as the separator and refuses the empty time. Four such forms were `null` here and are
midnight UTC to the source. The differential oracle had been comparing against bare
`fromisoformat` rather than against the wrapper, which is why five rounds of measurement did not
find it: **an oracle is only as good as the function it is pointed at**, and that is the sharper
form of this belt's own lesson about measuring rather than reasoning. It now models `_parse_iso`,
114 comparable inputs agree, and the `Z` arm was removed from the offset grammar because nothing
reaching it can still carry one -- dead code there could mask a bug in the rewrite, and the probe
confirms two *ported* cases now depend on it. A1 wrote both privately inside `src/attention/classifier.ts`, which was
right for a sub-belt with one consumer; A2 is the second consumer, and two private copies of one
CPython function inside one directory is the drift shape
`docs/test-translation-conventions.md` rule 11 names -- the copies agree on the day they are written
and nothing goes red on the day they stop. So the transcriptions get one home in the belt's own
directory, beside the two modules that need them.

**Rejected alternative: importing them from `classifier.ts`.** It is a smaller diff and it puts
`fromisoformat` behind a name that has nothing to do with it; a module that transcribes CPython is
not a detail of the module that first called it.

**Decision 3 -- the rule-9 exposures are guarded rather than disclosed.** Two values this runtime
admits and CPython excludes reach this module, and each is guarded and pinned by a target-only case
rather than left in the ledger as a known limitation, because both fail in the direction that loses
an alarm silently. The dedup key is caller-supplied and Python's `dict` has no inherited keys, so
both namespaces are built with `Object.create(null)` and read with `Object.hasOwn` -- otherwise a
task named `constructor` reads as already notified forever. `cooldown_sec` is `int` in the source,
so `NaN` and the infinities are excluded there; here a `NaN` cooldown makes every comparison false
and suppresses every pending notification for the life of the process, so it is refused. The **clock**
argument carries the same exposure and was missed in the first pass, found by the codex review gate:
`new Date(NaN).getTime()` is `NaN`, so `shouldNotify` answered false for every key at every age while
`recordNotified` already refused the same value through `pyIsoUtc`. Both paths refuse it now. The
`parity/attention.dedup.ledger.json` entry for each records the mutation that was measured red.

**One inherited limitation is carried rather than repaired**, and it is A1's disclosure rather than
a new one: a `Date` resolves to one millisecond and a `datetime` to one microsecond, so a stored
timestamp within a fraction of a millisecond of a cooldown boundary can be judged on the other side
of it from the source. Repairing it means carrying an epoch in microseconds through every consumer
of `parseIso` instead of a `Date`, which is a change to the belt's shared vocabulary rather than to
one module. The write side has no such limitation: `pyIsoUtc` renders the six digits the source
renders.

**Falsifier (Decision 1).** The line is drawn on the claim that an absent namespace cannot be the
residue of a lost one. If a writer is ever added that can produce a document with one namespace
missing -- a partial write, a migration, a hand-edited file that a tool then re-saves -- then
"absent means empty" stops being a statement about state that was never written and becomes the
defect again under a narrower name, and `test_load_partial_shape`'s reading is what would have to
move. The observation is a second writer of this file appearing anywhere in the port.

**Falsifier (Decision 2).** If A3 or a later belt needs a `datetime` answer these two functions
cannot give -- a `strftime`, a timezone database, an aware/naive distinction the port has so far had
no use for -- then a two-function module was the wrong shape and the belt needs the fuller
transcription that `src/fencing/pysemantics.ts` is for the string primitives. The observation is a
third consumer arriving with a requirement rather than a call site.

**Falsifier (Decision 3).** `D-0034` already states the one for the repair as a whole: if
fail-closed is found to lose data a caller needed, the deferred rebuild belt is what was missing,
not evidence against fail-closed. What would falsify this decision specifically is an operator
finding a refusal where the source recovered, on a file this port itself wrote -- which would mean
the refusing side of Decision 1 had caught a shape `saveState` can actually produce.

**Source.** Task `continuo-attention-a2`, 2026-08-29, porting `tests/attention/test_dedup.py`
(10 cases) from interlock `65f36c5`, under `D-0034`'s ratified constraints. Decision id from the
`D-09xx` range `D-0034` allocated to the attention belt, and the first id A2 mints in it -- A1 used
`D-0901`..`D-0903`.

---

## D-0905 -- `isinstance(value, int)` is a question about the config DOCUMENT; the dataclass's own defaults become one exported record

**Context.** `tests/attention/test_config.py`'s 34 cases are the second half of A2, and the loader
under them is close to a straight translation: the same knobs, the same refusal messages, the same
backward-compat auto-scale. Two things in it are not translatable as written, and both are the
shape `docs/test-translation-conventions.md` rule 9 warns about -- the obvious TypeScript is the
*right* TypeScript, and the ported suite cannot fail on either, because the values that break them
are values Python's types excluded.

**Decision 1 -- the integer check asks what the DOCUMENT wrote, not what the value is.** Python's
`json.loads` produces an `int` only for a literal with no `.`, `e` or `E`, so `1.0`, `1e2` and
`-0.0` are `float`s and `isinstance(value, int)` refuses all three. Every one of them is an ordinary
integer to `Number.isInteger`. So `loadConfig` parses with `pyJsonLoads` -- which records the
spelling the source text used -- and asks `pyTypeNameOf`, which answers `int` or `float` per the
document. That is the same question the source asks and it produces the same answer; it also
produces the message, because the refusal prints `type(value).__name__`, which is `float` for a
value that is integral here.

**Why this is not a `Number.isInteger` guard with a note.** The failure is silent and in the
accepting direction: `cooldown_sec: 1e2` is refused by interlock and would have loaded here, so the
port would be *wider* than the specification it exists to reproduce, with nothing red. The
transcription already exists in this repository (`src/fencing/pyjson.ts`,
`src/fencing/pysemantics.ts`) and is already shared by `src/settings/` and `src/session/`, so the
cost is an import rather than a new module.

**One divergence in the same area is guarded, and the first draft of this entry argued the
opposite.** That draft said a knob above 2**53 should be *disclosed* rather than refused: Python's
`int` is arbitrary-precision and loads it exactly, this runtime rounds it, refusing would make the
port narrower than its source, and nothing observable followed because all ten knobs are thresholds
compared against an age. **The loader's own backward-compat auto-scale falsifies the last clause**,
which the codex review gate found: the auto-scale computes `floor + 1` and then `max + 1`, and past
2**53 each of those expressions *is* its own input, so `{"pending_decision_min":
9007199254740992}` produced a ladder with `max == min` and was refused by the constructor with a
message about `max <= min` -- a refusal naming the wrong knob, for a value interlock accepts. The
choice was therefore never between refusing and accepting; it was between refusing where the value
is read and refusing three steps later with a misleading message.

`loadConfig` refuses a value above `MAX_SAFE_INTEGER - 2`, two below the limit because **two**
successive increments have to stay exact, and the target-only case pins both halves: the refusal,
and that the largest admitted value still auto-scales to a strictly increasing ladder. This is
narrower than interlock for an input interlock handles, it is recorded as such here and in
`parity/attention.config.ledger.json`, and the smallest refused value is some 285 million years in
minutes.

**Decision 2 -- the dataclass's own defaults become one exported record, read by both the
constructor and the loader.** `load_config` reads four defaults back out of
`AttentionConfig.__dataclass_fields__` to decide whether a legacy document's TTL ladder needs
auto-scaling. A dataclass carries its defaults at runtime and a TypeScript class does not, so the
choice is between naming them twice and naming them once: `ATTENTION_CONFIG_DEFAULTS` is the once.
Two copies would reintroduce exactly the drift `__dataclass_fields__` was avoiding, in the place
where the two disagreeing means a legacy config either fails to load or is scaled against a
threshold nobody uses -- and no ported case would notice, because every one of them supplies its own
values.

**Decision 3 -- the maps keyed by an attention kind are `dict`s, and the presence tests over the
document are own-key tests.** `notify` and `templates` are keyed by a kind the operator's own file
supplies, so both are built with `Object.create(null)`; `DEFAULT_NOTIFY` already was, under
`D-0902`, so all three severity and template maps in the module now agree. `__proto__` earns its own
target-only case because it fails in the opposite direction from `constructor`: assigning it on an
object literal sets the prototype and stores nothing, so the one kind the operator configured is
silently absent while every other kind in the same document loads fine. The loader's own presence
tests over the raw document use `Object.hasOwn` rather than `in` for the same reason, and the ledger
says plainly that this half is defensive rather than measured -- none of the fourteen top-level JSON
keys collides with an `Object.prototype` member.

**`D-0902`'s falsifier is answered: A2 extended this file rather than changing it.** `Severity` and
`DEFAULT_NOTIFY` are byte-identical to what A1 landed, construction and freeze included. The one
edit above them is the module header, which A1 wrote to describe an A1-shaped file and which now
describes the finished one; the ledger records that explicitly, because "A2 changed A1's file" is
the observation `D-0902` asks a reviewer to look for and a header rewrite is not it.

**Falsifier (Decision 1).** If `pyJsonLoads`'s spelling record is ever found not to survive a path
this loader takes -- a nested container rebuilt rather than carried, which `src/fencing/pyjson.ts`'s
own header names as a standing obligation on every rebuild site -- then the check silently falls
back to classifying by value and the float case goes green for the wrong reason. That is what the
target-only case measures, and it is why it carries five literals rather than one.

**Falsifier (Decision 2).** If a consumer ever needs a default that is not a constant -- one derived
from another field, or from the environment -- then a frozen record is the wrong shape and the
defaults belong behind a function. Nothing in interlock's dataclass has such a field today.

**Source.** Task `continuo-attention-a2`, 2026-08-29, porting `tests/attention/test_config.py`
(34 cases) from interlock `65f36c5`, under `D-0034`'s ratified constraints and `D-0902`'s boundary.
Decision id from the `D-09xx` range `D-0034` allocated to the attention belt; `D-0901`..`D-0903` are
A1's and `D-0904` is A2's first.

---

## D-0906 -- D-0903 is falsified as written: the classifier carries no fact state, and the retargeted invariant is withdrawn rather than re-homed

**Context.** `D-0903` decided that `src/attention/classifier.ts` takes the watcher's fact state as a
**required input** and carries it onto the event uninterpreted. The reasoning was that a fact can
only reach an event two ways -- the classifier derives it, or the caller supplies it -- and that
deriving it is the kind-to-state table `D-0034` forbids this port from inventing. Supplying it put
the decision back where it was made.

That entry carried a falsifier, and the falsifier fired:

> If a later belt -- A3's pipeline, most likely -- finds that no caller is in a position to supply a
> fact state, then the fact does not belong on the classifier's input at all and this shape is
> wrong; the observation would be A3 having to invent a value to pass, which is the forbidden
> mapping arriving one layer up.

**A3 reported exactly that observation.** Porting `tests/attention/test_cli.py`, it found nothing in
continuo's attention pipeline able to produce a fact state to hand the classifier: the CLI reads
`events`, `pending_decisions.json` and the broker journal, and none of them carries one. A caller
there could only have invented a value -- and inventing one per row shape is the same table
`D-0034` forbids, one layer up, which is the sentence above almost word for word.

**Decision.** `D-0903`'s shape is withdrawn. `src/attention/classifier.ts` names no fact state
anywhere: the input types carry none, `AttentionEvent` has no `factState`, and `to_dict()` emits no
`fact_state`. The 61 ported cases become plain translations of their source, which is what they
were always asserting -- none of them ever asserted anything **about** a fact state, they only had
to supply one.

`D-0034`'s ratified constraint is satisfied more simply than before, and the distinction is worth
stating because the entry's literal wording no longer holds. That wording -- "every ported case is
required to give its fact state explicitly" -- was a **means**, and its stated **end** was that "no
continuo-authored kind-to-state table exists for a belt case to silently depend on". A module that
carries no fact at all cannot hold such a table, so the end is met without the means. Reading the
ratified text that way is not this belt's call to make alone, which is why it went to the human gate
and is recorded here as the answer that came back rather than as an inference.

**The retargeted invariant is withdrawn, not re-homed, and this is the part that costs something.**
`parity/source-inventory.belts.md` proposed that `test_classifier.py`'s strongest invariant -- every
row of the fact vocabulary has a pinned expectation -- be re-derived onto the closed fact-state set.
With the fact gone from this subsystem there is nothing in the classifier for that invariant to be
about: it presupposes a fact the port does not carry, so it is not re-derivable here in principle
rather than merely inconvenient to place. It is **abandoned**, and the belts document says so in
those words instead of quietly dropping the sentence.

What remains is narrower and is not offered as an equivalent. `test/contract/fact-state-vocabulary.
test.ts` pins that every place stating the six names states the same six in the same order, and that
the DDL still constrains `incident.fact_state` only for emptiness. That is an agreement between
statements of a vocabulary; it is **not** "every row has a pinned expectation", and conflating the
two would be describing coverage this port does not have -- the exact failure the ledger exists to
prevent.

**What survives.** `D-0901` stands: the six-name vocabulary is still adopted, and
`src/attention/fact_state.ts` still holds it. That adoption never rested on the classifier -- it is
justified by three consumers that predate this belt (`src/measurement/fixtures.ts`'s seventh-value
refusal, `test/fault_injection/contract.ts`'s vocabulary check, and the DDL's deliberate absence of
a constraint) and by `D-0034`'s ratification that A1 would be the belt to make it. `D-0902` also
stands; it is about a config constant and is untouched by this.

**`D-0903` is superseded, not amended.** The entry stays in this file exactly as written, marked
superseded in the index, for the same reason `D-0901` left `D-0302` alone: an entry that recorded a
decision and named what would falsify it, and was then falsified by that named observation, is more
useful intact than edited. The eight target-only cases that went with the shape were measured red
against five distinct mutations while it stood, and
`parity/attention.classifier.ledger.json` keeps that record under
`withdrawn_by_D_0906` -- evidence that the shape was load-bearing while it existed, not decoration.

**Falsifier.** If continuo later grows a detector layer that does produce fact states, this entry is
the one that was premature and the shape `D-0903` described is what should return -- the observation
would be a caller with a real fact and nowhere to put it. Note that this is not symmetric with what
happened here: `D-0903` was withdrawn because nothing could supply a value, and it would return
because something can, so the two readings cannot both be right at the same time.

**Source.** Task `continuo-attention-a1`, 2026-08-29, on the A3 lane's report against
`tests/attention/test_cli.py`. Decision id allocated by the window in the `D-09xx` range that
`D-0034` gave the attention belt (`D-0904`/`D-0905` are A2's). Ratified at the human gate before
this belt made the change.

---

## D-1003 -- `suite-runs-unchanged.test.ts` skips on Windows CI: a measured resource-contention failure, not a coverage gap the belt is silently accepting

**Context.** PR #73 (D-1002) failed `double-green (windows-latest, node 24)` in CI (run
`33242488019`, job `99074077395`) after merging `main` forward twice (through `attention` A1's PR
#71 and the `measurement` suite-template migration PR #72, the latter specifically to rule out that
this was `measurement`'s own already-known Windows slowness). The failure's own signature ruled out
a simple "make the Windows cell faster" fix.

**Diagnosis.** Three things read from the job's own annotations, not inferred:

1. **Not a job-level timeout.** The job completed in 15m44s, inside every configured limit; nothing
   here is GitHub Actions' own workflow timeout firing.
2. **A file with nothing to do with this belt blew its own budget.** `test/fault_injection/policy.ts`
   raised `ContractViolation: the fast profile spent 447s in this fault-injection file, over its
   240s suite budget (design 9)`, alongside a `BarrierTimeout` inside the same file's controller.
   Nothing in `test/fault_injection/` was touched by this task's diff. D-0602 already tuned that
   budget for this port's runners; this run blew through it by nearly 2x with unrelated code.
3. **This belt's own double-run failed too, the same way a subprocess timeout looks.**
   `support/run.ts`'s `the unbound run wrote no report; vitest exited 1` fired with **empty**
   `stdout` and `stderr`. A vitest crash ordinarily writes something to one of the two; a `spawnSync`
   `timeout` (`support/run.ts`'s `RUN_TIMEOUT_MS`, 300s) instead kills the child with `SIGTERM`,
   leaves `status` `null`, and `run()`'s `completed.status ?? 1` reports that as plain exit code 1
   with whatever was captured before the kill -- empty, if the kill lands early. The `[S3]` failures
   in the same job show partial `stdout` (the `globalSetup` header lines) before the same failure,
   consistent with a slow run reaching its own internal deadline rather than crashing outright.

Both symptoms point the same direction: `suite-runs-unchanged.test.ts` spawns up to two full
subprocess re-runs of the entire `test/control_plane` suite (14 files, 605 cases, `synchronous =
FULL` fsync on every commit) *while the outer suite's own parallel worker pool is still running*,
including `fault_injection`'s own real-child-process, timing-sensitive tests. On a two-vCPU Windows
runner that is already the slowest cell in the matrix (D-0029's own finding), that is enough
concurrent CPU/IO demand to starve an unrelated file past its tuned budget and to push this belt's
own nested runs past their own internal timeout. `ubuntu-latest` (both Node versions) passed in
~2.5 minutes each in the same run -- the contention is a Windows-runner-resource fact, not a defect
in the measurement's logic.

**Decision.** `suite-runs-unchanged.test.ts` gates every case (not only `[S2]`'s existing
`claude`-CLI-availability gate) on `process.platform === "win32"`, the same `skipIf` shape as
`[S2]`'s: a platform capability gate, recorded as `conditionally_collected` in
`parity/gate_item11.suite-runs-unchanged.ledger.json` (seven more entries, `[S3]` and unbound,
alongside the six `[S2]` entries D-1002 already recorded) rather than a silent narrowing. Applied
**alongside**, not instead of, `support/suite-runs-unchanged.config.ts`'s nested `fileParallelism:
false`: serialising the nested run's own 14 files is free and can only lengthen that run's own wall
time, never widen what it measures, but nothing about it was measured sufficient alone against a
runner already saturated by the outer suite's own pool, and CI is the only place that contention is
reproducible at all -- so both land together rather than staging a second, unverifiable round.

**Why this is not a coverage gap the belt is silently accepting.** Item 11's property -- no provider
detail leaks into the control plane; the control-plane suite runs unmodified against either provider
-- is a fact about this repository's source and runtime behaviour, not about the operating system
running it: nothing in `src/session/`, `src/control_plane/`, or this belt's own fixtures branches on
`process.platform`. Two things already cover Windows without this file's help:
`no-provider-detail-leaks.test.ts`'s static AST scan runs on every OS unmodified (it reads import
graphs, not processes), and `test/control_plane`'s own 605 cases run -- and must pass -- on Windows
every time as part of the ordinary suite, which is already evidence the suite itself is
Windows-compatible. What the skip gives up is narrower than either: literal re-confirmation, via
*this specific subprocess double-run*, that swapping providers costs nothing *on Windows
specifically*, as opposed to on Linux where the same code already ran the same way.

**Relationship to D-0029.** D-0029 rejected raising a timeout cap and rejected "re-run CI and hope"
in favour of reducing the *real* per-case cost (the spike-schema template), on the position that "the
cap is not the fix". This decision does not raise any cap, and does not touch `fault_injection`'s
budget or any other belt's -- both stay exactly as D-0602 tuned them. The reason this decision is a
platform skip rather than a D-0029-style cost reduction is that D-0029 had a general cost-reduction
move available (a cheaper fixture achieving the identical assertions) and this measurement does not:
its entire premise (D-1002) is running the *real*, unmodified `test/control_plane` suite as a real
subprocess twice, which is not a cost a testkit trick can remove without ceasing to measure what item
11 asks for. `fileParallelism: false` is the cost reduction available here, and it is applied; what
remains is a cost this measurement cannot shed further without narrowing its own scope (rejected --
see D-1002's own totals) and that a two-vCPU Windows runner cannot currently absorb alongside the
rest of the suite.

**Falsifier.** If a future change removes the resource pressure this decision responds to --
`fault_injection`'s own suite budget or watchdogs are re-tuned for a larger CI runner (out of this
belt's hands, D-0602), a Windows runner with more cores becomes the CI default, or
`test/control_plane` itself gets substantially cheaper to run twice (the `measurement` belt's own
143x suite-template speedup, landed the same day as this decision in PR #72, is exactly the kind of
change that could someday make this moot for a different subsystem) -- this skip should be revisited
and the Windows gate lifted if a re-measurement shows the contention is gone. It should not be lifted
on the strength of one green re-run alone; D-0029 already recorded why that is not evidence on this
cell.

**Source.** Task `continuo-gate-item11-p2`, 2026-08-29, responding to PR #73's CI failure (run
`33242488019`) after D-1002 landed; the option (skip on Windows, keep full scope on Ubuntu) was
presented with two alternatives and their trade-offs, and selected at the human gate via the
secretary.

---

## D-0951 -- A refused dedup ledger stops the attention CLI at exit 2 and leaves the file untouched

**Context.** A2's `D-0904` made `attention/dedup.py`'s reader fail closed: a state file that is
present and unusable is a `DedupStateRefused`, not an empty `DedupState`, because an empty ledger
says nothing has ever been notified and therefore frees every already-handled event to fire again --
the resume-without-double-execution violation `D-0001` exists to prevent. `D-0034` ratified that
repair and `D-0023` supplies the procedure for it: the source case that pinned the inherited
behaviour is inverted in the change that repairs it.

What `D-0904` deliberately did not settle is what the **caller** does with the refusal, and A3 owns
the only caller there is. `tests/attention/test_cli.py::test_scan_recovers_from_broken_dedup_state`
is the case that pins the source's answer -- `attention scan` returns 0 and the corrupt file is
silently replaced with an empty one -- so a decision had to be made here rather than inherited.

**Decision.** `attention scan` and `attention watch` report the refusal on stderr and exit **2**,
and **write nothing**. In particular the refused file is left byte for byte as it was found.

Three parts, each with its own reason:

- **Exit 2, not 1 and not 0.** Two is what `_load_cfg_or_exit` already exits with for a config it
  cannot read, and the two failures are the same kind of failure: an input this command was pointed
  at cannot be used. A distinct code would be a distinction the operator has to look up, and there
  is nothing behind it.
- **The refusal is caught, not left to escape.** In Python a `SystemExit` escaping `main` is what
  sets the process's exit status; the interpreter's own top level does that. Node has no such top
  level, so a `DedupStateRefused` allowed to propagate would reach the operator as an unhandled
  error with a stack trace, and the message naming the file would be buried above it. `src/cli.ts`'s
  `main` therefore turns an escaping `ArgparseExit` -- this port's `SystemExit` stand-in -- into its
  code, which is CPython's behaviour rather than an invention. A target-only case measures it.
- **Nothing is written.** This is the half a silent recovery destroys, and it is not merely the
  negation of the source's behaviour. An operator can still look at the file that was refused; and
  no later run can mistake a rewritten empty ledger for a ledger that was always empty, which is
  precisely the confusion that makes the inherited defect dangerous rather than merely untidy.

**`watch` stops too, rather than polling on.** A loop that re-read the same unusable file every ten
seconds would print the same refusal forever and notify nothing, which is a worse operator surface
than stopping and is not more available: the watcher cannot do its job without a ledger it can
trust.

**Rejected alternative: refuse the ledger but keep scanning with an empty in-memory state, writing
nothing.** It looks strictly safer -- no double execution is recorded, no file is damaged -- and it
is not: every already-notified event would be re-notified on every poll, which is the alert storm
the dedup ledger exists to prevent, and the operator would be told about it only on stderr, once,
under a wall of notifications.

**Falsifier.** If an operator turns out to need `scan` to keep running past a refused ledger -- say
a deployment where the ledger lives on a filesystem that is briefly unreadable and the notifications
matter more than the duplicates -- then the flat refusal is wrong and the answer is a flag that says
so explicitly, not a default that decides it for them. The observation would be a real deployment
asking for it; nothing in either suite does.

**Source.** Task `continuo-attention-a3`, 2026-08-29, porting `tests/attention/test_cli.py` (26
cases) from interlock `65f36c5`. Decision id from `D-0951`, the start of the stretch of `D-09xx`
the window allocated to sub-belt A3 so that three concurrent sub-belts could not collide on an id.

---

## D-0952 -- The operator's template goes through a transcribed CPython, checked by a differential oracle rather than by review

**Context.** `notify.render_text` is the one place in the attention subsystem that formats a string
**the operator wrote**. It reads `attention.json`'s `templates`, asks which placeholders the
template names, checks them against the design's section 6 allowlist, and renders. Three CPython
functions are load-bearing in that sentence: `string.Formatter().parse` decides which names a
template references, `str.format_map` renders it, and `str.__format__` applies each format spec.

The port could have substituted a regular expression over `\{(\w+)\}`. What that costs is not
hypothetical, and it falls on the operator in both directions: a parser that misses
`{summary!r:>10}`'s name hands the allowlist the wrong set and lets a template reach a field the
design forbids, and one that reads `{{pr}}` as a reference to `pr` renders `42` where CPython
renders the literal text `{pr}`. On the rendering side, a transcription that refuses a template
CPython renders replaces the operator's own text with the English default -- silently, since the
whole contract of this path is that a bad template must not crash the watcher -- and one that
renders a template CPython refuses is the crash that contract exists to prevent.

**Decision 1 -- the three functions are transcribed, in `src/attention/pyformat.ts`.** Not
approximated, and not narrowed to what this belt's own cases happen to write. `formatValue`
implements `str.__format__` and no other type's, because `_format_with_event` builds its mapping out
of six strings and nothing else; a number reaching it is a caller error rather than a case to guess
at, and it is refused rather than run through a near-miss of the numeric mini-language.

`classifier.ts`'s private `formatMap` is deliberately **not** replaced by this one. It formats a
closed set of templates the port itself ships, and a private substitution is the right size for a
closed set; consolidating the two is an edit to a landed belt's file, which `D-0504` established
belongs in its own PR. It is named here so the second copy is a recorded choice rather than
something a later reader has to decide was an oversight.

**Decision 2 -- the transcription is checked against CPython, not against review.** A differential
oracle in the shape `D-0200`'s `fnmatch`/`shlex` vector established: a committed corpus
(`parity/oracle/pyformat-corpus.json`), a Python half (`scripts/oracle/dump_pyformat.py`) run by
hand and its output committed (`parity/oracle/pyformat-vector.json`), and a comparison
(`test/attention/pyformat-oracle.test.ts`) that rebuilds the same corpus and asserts agreement on
every field -- placeholder set, unknown set, rendering, exception class, and exception message text.

**This is a decision because the measurement changed the answer, five times.** The transcription was
written from CPython's own source -- `Objects/stringlib/unicode_format.h` and
`Python/formatter_unicode.c` -- rather than guessed at, and its first draft still disagreed with
CPython on five inputs. Review had found none of them:

- `{}` and `{0}` raise `ValueError("Format string contains positional fields")`, not `IndexError`.
  `format_map` passes **no** positional argument tuple, and `get_field_object` tests for that before
  it tests any index.
- `{pr:010}` **renders**, as `4200000000`. A leading `0` sets the fill character and takes the `=`
  alignment branch only when the type's own `default_align` is `>`, which is the numeric types'
  default and not `str`'s. The draft, reading the grammar, made it a refusal.
- `{pr:0}` renders `42`, for the same reason and with the same wrong first answer.
- `{pr:{}}` follows from the first.
- an unprintable presentation type is **escaped** in the refusal message -- `Unknown format code
  '\xa' for object of type 'str'` -- where a `%c` transcription puts a literal newline in the middle
  of an operator's warning line.

A sixth arrived later, on the integration tip, and it was **this belt's own regression rather than
a misreading of CPython**: the repair for `{pr:010}` removed two guards in one edit when only one
of them was wrong. The alignment guard had to go; the `fill == ""` guard beside it was right,
because an explicit fill character wins over the `0` -- `format("ab", "*>010")` is `"********ab"`.
The corpus did not notice, because it carried `{pr:*^10}` and `{pr:010}` and no input combining the
two. That is the oracle's own limit stated exactly: **it is only as good as the combinations the
corpus asks about**, and a repair is a new combination. Eight of them are in the corpus now.

The codex review gate found the area and not the fault -- its comment claimed `{summary:>010}`
should pad with spaces, which CPython contradicts. Measuring the claim instead of acting on it is
what turned up the real defect one case over, and that is the general rule this entry ends on: a
review comment that is wrong on its own terms can still be the reason a bug is found, and it is
only worth that if the response to it is a measurement.

After the repairs, all 101 templates agree on every compared field. Five of the six would have
shipped as a silent behaviour difference in an operator-facing path.

**A finding about the source, recorded because it is easy to lose.** The first of those five means
the source's own `except (ValueError, IndexError)` around `_format_with_event` has an
**unreachable** half: that function only ever calls `format_map`, and `format_map` raises
`ValueError` for every positional field, so no template can produce the `IndexError` the catch
names. The port catches the class that can arrive and says why, rather than declaring a stand-in
class nothing can raise. Nothing about the port's behaviour differs from the source's here; the
observation is about interlock.

**Rejected alternative: compare only the exception class, not its message.** It is the cheaper
vector and it would have passed the fifth divergence, because the class was right and only the text
was wrong -- and that text is what an operator reads on stderr when their template is refused.

**Falsifier.** If the corpus turns out to be the thing under review rather than the transcription --
if a divergence is found by some other means in a shape the corpus does not cover -- then the corpus
is too narrow and the answer is to widen it in the change that found the gap. The vector's own
not-vacuous cases guard the degenerate version of that: a corpus that only rendered, or only
refused, would let half the transcription be wrong with the oracle green.

**Source.** Task `continuo-attention-a3`, 2026-08-29, porting `tests/attention/test_notify.py` (34
cases) from interlock `65f36c5`.
---

## D-0036 -- interlock is a frozen source, not a decision-maker: every question continuo has open is settled at continuo's own human gate

**Context.** `D-0023` established one consequence of interlock being frozen -- an inherited defect is
repaired here, because no upstream repair is coming. The premise is broader than the consequence
`D-0023` drew from it, and the rest of the repository had not caught up. Documents written earlier
still described interlock as an active party: a subsystem's status was "undecided upstream", an
inherited `Q-` number "stays open" in a tense that implies someone is working on it, and
`source-inventory.belts.md`'s `broker` section said in terms that "whatever continuo decides about
them, it decides after interlock does. They are `retarget` upstream first."

That is not a wording problem. On 2026-08-30 the window read those sentences and reported continuo's
remaining `broker` work to the owner as **blocked on upstream `Q-0023`**, which is not a state that
exists: `Q-0023` is a question interlock recorded and never answered, in a repository that is now
frozen. A reader -- human or agent -- who takes "pending upstream" at face value concludes that
waiting is the correct behaviour, and waiting is unbounded here. The text produced the mistake, so
the text is what gets fixed.

**Decision.** interlock is the **frozen source** of this port -- not archived: on GitHub
`isArchived` is `false`, the last push was 2026-08-21 UTC, and 8 issues are still open there. What
makes it frozen is not its repository state but its trajectory: development moved to this TypeScript
port, and `interlock#63` has sat unanswered since it was raised, with no sign anyone upstream is
going to act on it. It supplies test cases, prior design reasoning, and `PORTING_LEDGER.md`
classifications, and it is cited as the design lineage of record. It supplies **no decisions and no
answers**. Concretely:

1. **No continuo status, belt, or document is ever "blocked upstream" or "pending upstream".** There
   is no upstream process left to be pending on. Where such a phrase appears it is wrong, not merely
   imprecise, and it is rewritten rather than annotated.
2. **An interlock `Q-` number names a question interlock left unanswered.** It is not a request in
   flight and no answer is in transit. The reference stays -- it is the record of what the question
   asked and where it came from, and that is worth keeping -- but its status is stated as
   *unanswered*, never as *open pending upstream*.
3. **If continuo needs one of those questions answered, continuo answers it**, at this repository's
   human gate, as a `D-` entry, on continuo's own terms. Declining to answer stays a legitimate
   position: this decision does not force `Q-0005`, `Q-0011` or `Q-0023` to be settled now. What it
   forbids is recording the decline as *waiting*.
4. **The human gate this file already relies on (`D-0031`, `D-0032`, `D-0034`, `D-0035`) is the only
   decision-making body over continuo.** `decision-pending` means undecided *here*.

**Consequences.**

- `parity/source-inventory.belts.md` loses the "retarget upstream first" sentence in the `broker`
  section and states instead what actually has to be decided about the 54 collected cases and the 5
  uncollected modules, and who decides it. The problem statement is kept in full; only the
  instruction to wait is removed.
- The `retarget` and `decision-pending` definitions in the same document's status vocabulary are
  re-worded to locate the decision here.
- `docs/measurement-harness.md`, `docs/production-schema.md`, `docs/canary-routing-rehearsal.md`,
  `docs/secretary-intake-boundary.md`, `docs/lease-fencing.md` and
  `docs/test-translation-conventions.md` say "unanswered" where they said "open" or "settled
  upstream", with one framing sentence per known-holes list; `docs/per-role-fencing.md` says the
  hook-runtime question is one continuo answers rather than one with an expected answer. `README.md`
  states the same thing about interlock in its design-lineage section.
- **Entries already in this file are not rewritten**, per this file's own rule that an ID is never
  rewritten. `D-0035`'s "undecided upstream", `D-0901`'s "had to be answered upstream first", and
  similar phrasings in earlier entries stay as written and are read through this entry: they record
  what was believed when they were taken, and the authority they describe is now here.
- `parity/attention.broker-journal-contract.ledger.json`'s `where_the_status_lives` said the broker
  is "`retarget` upstream first" and that continuo decides after interlock does. It is the status
  pointer a reader reaches the uncollected `test_broker_journal_contract.py` through, so it
  recreated the same wait from a second entrance; it now says what the belts document says.
- **The `where_a_fix_belongs: "upstream"` fields already in the parity ledgers are not rewritten in
  this sweep**, and `docs/test-translation-conventions.md` says how to read them instead. Each is
  one of two different things -- a repair `D-0023` sends to the next belt that touches the
  behaviour, or a fix that is structurally impossible here (it needs a v1 store, an interlock
  module, or a decision this port has no standing to take) -- and telling them apart is a judgement
  per entry against that entry's `note`. A blanket rewrite would assert repairs continuo cannot
  make. The per-entry pass is proposed as its own change, at the human gate, and is named here so it
  is not mistaken for something this decision already did.
- Nothing about the port's *evidence* rules changes. The five uncollected broker modules still have
  no node ids and nothing may be invented for them (`D-0031`); that is a constraint on evidence, and
  this entry does not license filling it in from judgement.

**Rejected alternative: leave the text and record the correction as an operating rule** (a memory, a
window convention, a line in a runbook). Rejected because the failure mode is a *reader* forming a
false belief from the document in front of them. Every new agent and every new reader starts from
the text; a convention held somewhere else is not in the path. The owner's instruction on 2026-08-30
was explicit that the text producing the misreading has to go, or the problem recurs indefinitely.

**Rejected alternative: delete the interlock `Q-` references entirely.** Rejected because they carry
real information -- what was asked, why it was not answered, and what a continuo answer would have
to cover. Deleting them would trade one wrong reading ("someone will answer this") for another
("nobody ever noticed this"). The reference is kept and its status is corrected.

**Falsifier.** If interlock is un-frozen and someone resumes answering its open questions, the
premise returns and this entry should be revisited -- as should `D-0023`, which rests on the same
fact. Short of that: if a later reader is found treating a continuo `decision-pending` or `retarget`
status as an external blocker despite this sweep, the rewrite did not reach the text they read, and
the answer is to find that text rather than to restate the rule.

**Source.** Task `continuo-upstream-authority-sweep`, 2026-08-30. Prompted by the window reporting
`broker` as blocked on upstream `Q-0023` on the same date, and the owner's correction that the
misleading text -- not the misreading -- is the thing to remove.

---

## D-0043 -- `migrate` is ratified `not-porting`: the belt's subject is gone on both sides, and the fired revisiting trigger is replaced by one that can still fire

**Context.** `D-0035` left `migrate` (11 cases, `tests/test_migrate.py`) at `decision-pending` with
one explicit revisiting trigger: "the run-boundary cutover bridge actually being designed". That
trigger has since fired. `docs/design/minimal-operating-loop.md` section 5.2 is that design, and it
reviewed the belt against both sides of the port. So the status is not deferrable as it stands: a
`decision-pending` whose only trigger has already fired is a status nothing can move.

The status question was put to the human gate with that review as its evidence.

**Decision.** `migrate` moves from `decision-pending` to `not-porting`. The grounds are that the
belt's subject evaporated on both sides, not that porting it is expensive:

1. **The belt's subject is ja v1 *file* artefacts.** `interlock
   src/claude_org_runtime/migrate/v1_to_v2.py:1` states it: migrate `.state/` artefacts from the v1
   (claude-org-ja) layout to v2. There are two branches -- journal JSONL and org-state markdown --
   and the assertions are about key normalisation (`worker` -> `task_id`, `dir` -> `worker_dir`,
   `pane` -> `pane_id`/`pane_name`) and markdown column augmentation.
2. **Both inputs are gone or reshaped on the live ja side.** `ja tools/journal_append.py:9-18`
   records `.state/journal.jsonl` as decommissioned with the `events` table as the sole write
   target, and no such file exists in ja today. ja's live registry header is
   `| Task ID | Pattern | Directory | Project | Status |`, which matches none of the three lowercase
   keys `_augment_header` switches on, so that branch is a copy-through no-op against live ja state.
3. **The successor's cutover is specified as *no* state conversion**, in three independent places in
   this repository: `src/control_plane/spike.ts:5-8`, `src/control_plane/migrator.ts:584-592`, and
   `src/canary/routing.ts:23-30` ("There is no other rollback code path -- no migration hook, no
   state converter"). Routing at the run boundary is the design; converting in-flight state is not.
4. **The dependency question `D-0035` deferred is small and already answered by the frozen tree.**
   The `jsonschema`-equivalent question gates 2 of the 11 cases, and both already skip in
   interlock's own frozen tree; a further three reach modules interlock deleted and skip
   unconditionally.

**Falsifier.** The replacement for `D-0035`'s fired trigger, stated so that it can still fire and so
that it can be evaluated without opening another repository's issue tracker: **if a cutover is ever
specified that must convert in-flight state rather than route at the run boundary, or if a v1 shadow
episode adapter is built that reads ja's file artefacts rather than ja's `events` table, then the
subject exists here and this decision is superseded** -- not edited. The second disjunct is the live
one: `V1Reference` (`src/measurement/shadow.ts:603-682`) has no producer in `src/`, and
`--v1-shadow-run-ids` supplies a different type (`V1ShadowInput`, a cohort exclusion), so an adapter
is outstanding work near this belt. It is outstanding as an *episode-level* adapter over ja's
`events` table; only a file-reading one would restore this belt's subject.

**Consequences.**

- `D-0035` is **not rewritten**. Its ID and `accepted` status stand, and this file's rules make
  partial supersession unavailable, so its clause 2 (`migrate` stays `decision-pending`) and its
  `migrate` falsifier are read through this entry: they record the status as it was on 2026-08-29,
  and the status now lives here. The same motion `D-0044` makes for clause 1.
- `parity/source-inventory.belts.md` has to move the `migrate` section and the roll-up table from
  `decision-pending` to `not-porting`, which takes the ratified `not-porting` total from 156 to 167
  cases and the effective porting target from `2,194 - 156 = 2,038` to `2,194 - 167 = 2,027`. The
  inventory itself stays at 2,194: the evidence set is unconditional and does not shrink with the
  decision. **That edit is not made by this entry** -- this task writes `DECISIONS.md` only -- and
  is a declared follow-on.
- **No code changes.** Nothing in `src/` or `test/` is added, deleted, or re-pointed.
- **Do not conflate this belt with a `continuo migrate` CLI verb.** The CLI mount over
  `createProductionControlPlane` / `migrateControlPlane` / `verifyProductionDatabase` (proposed as
  `continuo db create|migrate|verify` in `docs/design/minimal-operating-loop.md` section 6.1) shares
  only the word. Ratifying this belt neither authorises nor blocks that mount.

**Rejected alternative: keep `decision-pending` on a new trigger.** Re-arming on a condition the same
evidence rules out produces a status nothing can falsify, which is the defect being repaired here,
one iteration later.

**Rejected alternative: port it as a rewrite against the shadow adapter.** Every assertion in the
belt is about journal key names or markdown column augmentation, none of which survives a move to
episode-level correlation. It would port approximately zero assertions while counting a belt as
ported, which is parity accounting that lies.

**Source.** Human gate, 2026-08-30, task `continuo-decisions-batch-1`, on the review in
`docs/design/minimal-operating-loop.md` section 5.2. Decision id allocated by the window in the
shared band (`D-0019`..`D-0099`, see "How to use this file").

**Why this batch (`D-0043`..`D-0046`) skips `D-0037`..`D-0042`.** The next free numbers would have
shadowed interlock decisions that continuo documents still cite unqualified -- `D-0037` and `D-0039`
in `docs/time-base-policy.md` and `docs/production-schema.md` are interlock's, and a reader
following one of those numbers into this file would have landed on a real but unrelated entry.
Starting above interlock's highest ID (`D-0042`) removes that class of collision for every later
entry too. The gap means nothing else: a range is an allocation, and an ID is permanent whether or
not its neighbours are ever used. The unqualified citations themselves are repaired in the same
change, per this file's rule that an interlock decision is cited as `interlock D-00NN`.

---

## D-0044 -- Errata for `D-0035`'s `curator` clause: the withdrawal condition is restated without a foreign repository, and the premise is narrowed to the claim that survives

**Context.** `D-0035` clause 1 ratified `curator` (71 cases) as `not-porting`. The status is right
and is not in question here: nothing on the lap writes skill material. `grep -rn skills src/`
returns five hits and every one is a denial or a comment -- `src/fencing/roles.json:92-93` denies
`Write(**/.claude/skills/**)` and `Edit(**/.claude/skills/**)` for the curator role, `:100` adds
`denyWrite`, and the remaining two are prose in `role_configs_schema.json`. There is no promotion
gate, candidate digest, or path-audit module anywhere in `src/`.

Two things about the *entry* are wrong, and one of them is a fact about the record itself. This is
the motion `D-0036` set the precedent for: an entry that stands, with a separate entry saying how it
is to be read.

**Decision.** `curator` stays `not-porting`. `D-0035` keeps its ID and its `accepted` status and is
not edited. This entry is the errata, and it has three parts.

1. **The withdrawal condition is restated without naming another repository.** Read `D-0035`'s
   `curator` falsifier as: *if continuo, or any layer built on it, grows a surface that writes into
   a live skill directory, the subject exists here and the decision is superseded.* The continuo
   half of that condition is checkable in this repository; the layer half is checkable in whatever
   layer is built on continuo, which is a surface this project is party to rather than an issue in
   a repository it only reads. Neither half sends a reader to a foreign issue tracker for a status,
   which is what the withdrawn clause did. That clause -- the one pointing at
   `suisya-systems/cadenza#9` -- is withdrawn, per part 2.
2. **`cadenza#9` is not what `D-0035` says it is, and was not when the entry was written.**
   `D-0035` cites it as an "agentic-layer direction" and "a live candidate, not a theoretical one".
   cadenza#9 is a **G2 delegation-contract freeze marker**. It carries no agent-layer, skill, or
   promotion content; `grep -rniE "skill|agent"` over cadenza's `src/` returns zero; and the issue
   body has never been edited since it was created on 2026-08-29T03:38Z, which *precedes*
   `D-0035`'s ratification on the same day. So the clause was unsupported when written, not merely
   stale. It has already misled once: this task's own brief reproduced the confusion.
3. **The premise sentence is narrower than `D-0035` states it.** `D-0035` grounds the decision on
   "continuo is a safety-substrate library, not the operator of those sessions". Shipped code
   contradicts the second half: `src/session/claude_cli_provider.ts:1-8` declares itself the
   provider "over Interlock-supervised `claude -p`" and spawns with `-p` at `:1307` and `:1566`. The
   claim that survives, and the only one the decision needs, is: **continuo does not own the
   skill-promotion surface** -- verified by the absence of any writer and any gate module.

**Consequences.**

- The 71 cases stay declined; the `not-porting` totals and the effective porting target are
  unchanged by this entry. `test_promotion_gate.py`'s recorded value if the answer had been yes
  stays as `D-0035` wrote it -- it is the reason a future reversal would be cheap to act on.
- **The belts-document half is already done and is not re-proposed here.** The `curator` section of
  `parity/source-inventory.belts.md` already carries a self-contained falsifier that names no other
  repository, in the shape part 1 restates. This entry exists because that file does not rewrite
  `DECISIONS.md` entries, so without it a reader who finds the belts document's condition and then
  `D-0035`'s has two different withdrawal conditions for one decision.
- Only `DECISIONS.md` is touched. No code, no belt status, no parity ledger changes.

**Falsifier.** Part 1 is superseded by the event it names -- a live skill-directory writer -- which
supersedes `D-0035` with it. Part 2 is falsified by the record: if cadenza#9 is shown to have
carried agent-layer or skill-promotion content at the time `D-0035` was ratified, the first erratum
is wrong and the original clause was merely stale rather than unsupported. Part 3 is falsified if a
skill-promotion writer or gate module appears in `src/`, which is part 1's condition in its
continuo-local form -- the narrower claim is the one that fails first, and it fails here.

**Rejected alternative: leave `D-0035` alone at zero cost.** The dead pointer stays in the file a
reader is sent to for decisions, and it has already produced one confusion; and the two-conditions
problem above is worse than a single wrong condition was.

**Rejected alternative: reopen `curator` because the premise sentence is wrong.** That reads a
premise as if it were a falsifier, and would reopen 71 cases against a surface that does not exist.

**Rejected alternative: edit `D-0035` in place.** This file's rules make an ID permanent and its text
unrewritten, and they do not offer partial supersession -- `D-0035` covers two subsystems and only
one of them is being read differently here.

**Source.** Human gate, 2026-08-30, task `continuo-decisions-batch-1`, on the review in
`docs/design/minimal-operating-loop.md` section 5.3. Decision id allocated by the window in the
shared band (`D-0019`..`D-0099`).

---

## D-0045 -- `@suisya-systems/continuo` is published: `D-0008` is superseded, and the release path must build before it packs

**Context.** `D-0008` made the package `private` "until publication is decided", and said so in a
form that anticipated this entry: "the `files` and `exports` fields are nonetheless maintained from
the start, so the eventual first publish is a decision rather than a packaging project". That is
verified -- `exports`, `files` and `bin` are all present, and `check:package` already runs
`publint --strict` and `attw` against the packed tarball.

The host application that runs the lap needs to import continuo, and today nothing can: `"private":
true` at `0.0.0` refuses `npm publish` by `D-0008`'s own terms. The decision is which shape the
dependency takes, and it survives whether the application is hosted in cadenza or in a package of
its own -- only the identity of the importer changes.

**Decision.** Publish `@suisya-systems/continuo` to the registry and let consumers take it as an
ordinary npm dependency. `D-0008` is **superseded by this entry**, which is the path `D-0008` was
written to make deliberate rather than to prevent. It is also the only option under which the
version a consumer builds against is a stated fact rather than a property of somebody's checkout,
which starts to matter the moment two repositories ship one application.

**Two constraints are inherited, and they become the consuming application's constraints the moment
it depends on continuo.** They are recorded here because they are not visible from the dependency
line:

1. **A native runtime dependency.** `better-sqlite3` (plus its types), under `D-0009`'s policy of
   installing with `--ignore-scripts` and treating the prebuilt binary as the artifact. A consumer
   that installs continuo without that policy is back in the `node-gyp` territory `D-0009` exists to
   keep off every platform.
2. **A Node floor.** `engines.node` is `>=22.14.0 <23 || >=24.0.0 <25` (`D-0003`): floor 22.14.0,
   and odd majors excluded. The consumer inherits the whole range, not just the floor.

**The release path must have a build step, and this entry does not ship without naming it.**
Superseding `D-0008` is not by itself enough to publish something that works. `dist/` is gitignored
(`.gitignore:2`), `npm publish` runs no build of its own, and `scripts` has `build`, `pretest` and
`check:package` but **no `prepare` and no `prepack`**. A publish from a fresh checkout therefore
ships a tarball whose `main` and `exports` point at files that are not in it. The fix is small and
already in the repository, and it is one of exactly two:

- **the release path runs `npm run check:package`** -- which builds, then checks the packed tarball
  with `publint --strict` and `attw` -- before it publishes; or
- **a `prepack` hook is added**, which npm runs on the publishing side.

`prepack` is deliberately **not** `prepare`: `prepare` is what npm runs when a *consumer* installs a
git dependency, and adding it would collide with `D-0009`'s `--ignore-scripts` install policy.
`prepack` runs where the tarball is built, so it does not reopen that blast radius.

**Consequences.**

- `package.json` drops `"private": true` and takes a real `version`; `npm publish` stops refusing.
- Whichever build step above is chosen has to exist **before** the first publish, or the first
  publish reproduces byte for byte the defect option B was rejected for.
- **This entry changes no files other than `DECISIONS.md`.** Lifting `private`, setting the version,
  and wiring the release path are a separate change; this is the decision that authorises them.
- Any import allowlist on the consuming side (cadenza's `ALLOWED_EXTERNALS_BY_LAYER`, if cadenza
  hosts the application) is extended binding by binding on that side. `FORBIDDEN_PACKAGES` there
  blocks `interlock` and `claude-org-runtime`; continuo is neither, so there is nothing to resolve,
  only an allowlist to widen -- and that is the consumer's change, not this one.

**Rejected alternative: a git dependency pinned by sha.** npm builds a git dependency by running its
`prepare` script, and continuo has none, so the install produces a package whose
`main: ./dist/index.js` points at nothing. Adding `prepare` to fix that collides with `D-0009`'s
`--ignore-scripts` policy -- it reopens `D-0009`'s blast radius to avoid superseding `D-0008`, which
is the worse trade.

**Rejected alternative: one workspace across both repositories.** Cheapest to start, and it defers
both other decisions, which is its whole appeal and its whole problem: it works on a developer's
machine and answers nothing about how the application is distributed. Acceptable only as an
explicitly temporary bridge while the first lap is built, and only if it names publication as the
destination -- as a permanent shape it makes "which continuo is this running" a property of a
checkout.

**Falsifier.** If a published tarball is found whose `main` or `exports` do not resolve inside the
package, the build step named above was not in the release path and the prerequisite half of this
decision was not met -- the repair is the release path, not the decision. Separately: if the
application turns out to ship as a single tree that never resolves continuo from a registry, the
dependency shape this entry chose is answering a question that stopped existing, and it should be
revisited rather than maintained.

**Source.** Human gate, 2026-08-30, task `continuo-decisions-batch-1`, on the option table in
`docs/design/minimal-operating-loop.md` section 6.4 (option A). Decision id allocated by the window
in the shared band (`D-0019`..`D-0099`).

---

## D-0046 -- `run.status` has exactly one in-place writer; lap 1's consumer role is played by the admission command, and the lease is scoped to the run

**Context.** Nothing in `src/` creates a run or advances one: the run-lifecycle writer is unbuilt,
and `registerConsumer` appears only at its definition and in the barrel, so the consumer half of the
close is unbuilt too. What has to be settled before either is written is **who owns the
transition**, because the production schema deliberately splits it. `docs/production-schema.md`
section 4.2 states that `run.status` is exclusively one writer's, and that an observer of a merge
does **not** move a run to `completed`: it appends `pr_merged` and a *consumer* of that event makes
the transition. Section 7.1 records what the collapse of those two roles cost in v1 -- a
repo-resolution mistake wrote a foreign PR's metadata onto a run row, and the tool exited `ok`.

The lap has no CI watcher, so the split has no second party by default. Left unstated, the shape
that gets written is the collapse, for the ordinary reason that it is one function shorter.

**Decision.**

1. **`run.status` has exactly one in-place writer.** One code path performs the transition; no other
   path may write the column. A write to `run.status` reaching the row from anywhere else is an
   **anomaly**, not an alternative route -- it is treated as a fault to be surfaced, not as a
   supported call site to be documented.
2. **For lap 1, the admission command plays the consumer's part.** The event is appended by whatever
   observes the fact, and the admission command consumes it and makes the transition. The collapse
   -- the observer transitioning the run directly -- is **not** taken, even though lap 1 has no
   watcher to justify keeping the roles apart. The split is not bureaucracy: it is the control that
   was missing when v1 wrote another repository's PR metadata onto a run row.
3. **The lease is scoped to the run.** The resource name is per run identifier, so two runs never
   contend and one run has a single claimant. Kinds are composed against that resource by
   `effect_kind(resource, effect)` and read back with `resourceOfKind`
   (`src/control_plane/lease.ts`), which is what ties an `action` row's `writer_epoch` to the lease
   that allocated it.
4. **The first implementation step is bounded, and the DDL trigger is deliberately left undecided.**
   Step one is (a) a run-lifecycle module whose writes go through the existing protected-write gate
   -- `fencedUpdate` and `protectedWrite` in `src/control_plane/lease.ts`, where `run` already holds
   a seat in `PROTECTED_TABLES` -- and (b) a `writer_epoch` column on the `run` table, which is the
   column that gate stamps. **A DDL trigger that refuses a status transition made without a live
   lease is not introduced in this step.** Such a trigger is `BEFORE UPDATE OF status ON run` and
   nothing wider: `docs/production-schema.md` section 4.2's writer table fences `run.status` with
   the run lease epoch and assigns *no* fence to `run` creation, so an insert must stay
   lease-free. The trigger is the mechanism that would make rule 1 enforced rather than observed,
   and it is a *separate* decision: introducing it now fails every existing test that advances a
   `run` row's status without holding a lease (28 such sites at the time of this decision).

**Consequences.**

- The `run` table gains `writer_epoch`. The events layer already speaks the column
  (`src/control_plane/events.ts`), and the existing `run_status_is_forward_only` trigger
  (`src/control_plane/migrations/0001_initial.sql`) is unaffected: it constrains the *direction* of
  a transition, this decision constrains *who* may make one.
- **Rule 1 is, at step one, a convention plus a gate that the single writer opts into.** Nothing
  stops a second writer that does not go through the module until the trigger question is answered.
  That is stated here rather than glossed, so the guarantee is not read as stronger than it is.
- Answering the trigger question means either migrating those 28 status-advancing sites onto
  lease-holding helpers or deciding the trigger is not worth its test cost. Neither is decided
  here. Whichever way it goes, run *creation* stays unfenced, per the writer table above.
- **Implementation is out of scope for this entry.** No module, column, migration, or test is added
  by it; only `DECISIONS.md` changes.

**Falsifier.** If a legitimate operation is found that must advance two runs in one transaction, the
run-scoped lease is the wrong granularity and rule 3 is superseded. If a `run.status` write is
observed reaching the table outside the lifecycle module and nothing detects it, then step one's
bounded shape is not a control at all and the trigger question has to be answered rather than
deferred. And if the consumer indirection in rule 2 is found to have no reader on the lap -- no
event that any party other than the admission command appends -- then the split is being paid for
without buying the separation it exists for, and the collapse should be reconsidered explicitly
rather than drifted into.

**Rejected alternative: collapse the roles for lap 1 and split them when a watcher arrives.**
Cheapest now, and it is exactly the shape v1 shipped. The cost of the collapse was not that it was
hard to undo; it was that a resolution mistake had nothing between it and the run row. Lap 1 has
fewer parties, not fewer mistakes.

**Rejected alternative: introduce the live-lease trigger with the module, in one step.** It is the
stronger guarantee and it is where this should end up, but it converts 28 existing status-advancing
test sites into failures in the same change that introduces the writer, which buries the writer's own review under a
test migration.

**Source.** Human gate, 2026-08-30, task `continuo-decisions-batch-1`, on
`docs/design/minimal-operating-loop.md` section 6.2, against `docs/production-schema.md` sections
4.2 and 7.1. Decision id allocated by the window in the shared band (`D-0019`..`D-0099`).

---

## D-0907 -- The attention subsystem's `src/index.ts` surface: nothing is re-exported, and the CLI is the intended surface

**Context.** `package.json` restricts `exports` to a single entry point, `.` (`D-0002`), so any name
not re-exported from `src/index.ts` is unreachable to an installed consumer -- there is no subpath
around the barrel. The attention subsystem (A1's `classifier`/`readers`/`fact_state`, A2's
`config`/`dedup`/`pytime`, A3's `notify`/`pyformat`/`cli` helpers) currently re-exports nothing:
`grep -c attention src/index.ts` is `0`. continuo#76 asked whether that gap is an oversight three
belts left unresolved or a considered answer, because under `D-0002` adding one name to the barrel
*is* adding it to the public API, and interlock -- a package with no such single-entry-point
constraint -- never had to answer this question. continuo#76 surfaced from review of continuo#75
(A3), which is why that issue is the trigger even though the decision spans all three sub-belts and
is not an A3-only concern: A3 exporting its own names alone would leave the subsystem inconsistent,
and exporting all of them would let one belt decide the public surface of the other two.

The subsystem's actual product surface today is the CLI, `continuo attention scan|watch`
(`src/cli.ts`), which is fully wired and fully functional with zero barrel exports. Nothing
programmatic currently calls into `src/attention/*` from outside the subsystem, so there is no
functional pressure forcing an answer either way -- continuo#76 named this correctly as a
product/API-surface judgment call, not a technical necessity, and referred it to the human gate.

**Decision.** Option 1 from continuo#76: **export nothing.** `src/index.ts` is left unchanged --
`grep -c attention src/index.ts` stays `0` -- and the CLI is recorded here as the attention
subsystem's intended external surface, not as a placeholder for a barrel export that has simply not
been written yet.

Reasons, in the order that mattered at the gate:

- **The CLI already is the complete, working external surface.** It needs no barrel entry to
  function, so adding one buys no capability that does not already exist; it only adds a promise.
- **Publication is decided but not yet live, which makes this the cheapest possible moment to say
  "not yet."** `D-0045` supersedes `D-0008` and commits continuo to publishing `@suisya-systems/
  continuo` -- but `package.json` is still `"private": true` at `"version": "0.0.0"`, and the
  package 404s on the npm registry (checked at the secretary, 2026-08-31). Nothing has installed
  this package as a dependency yet. A name added to the barrel today is trivial to add later and a
  breaking change to remove after the first publish; the asymmetry favors waiting for a consumer
  that asks for it, not pre-committing on its behalf.
- **`exports` being restricted to `.` (`D-0002`) makes the barrel the entire public API, not a
  convenience re-export.** Six modules existing under `src/attention/` is not, by itself, a reason
  to publish them -- that reasoning would publish everything eventually and make the barrel a mirror
  of the source tree rather than a considered surface.

**Consequences.** No code changes: `src/index.ts` is untouched, and no contract test is added, since
continuo#76's acceptance criteria only requires pinning the exported names when the chosen shape is
non-trivial (options 2 or 3) -- option 1 has no shape to pin beyond the `grep -c` count already
checked by continuo#76 itself. If a future belt wants to export part of the subsystem, that is a new
decision in this same `D-09xx` range, not a re-litigation of this one: this entry answers "as of
2026-08-31, with the CLI as the only consumer," not "forever."

**Rejected alternative (continuo#76's option 2): export a small deliberate surface** (candidates
named in the issue: `Severity` and `DEFAULT_NOTIFY` from `src/attention/config.ts`, and/or the
fact-state vocabulary type from `src/attention/fact_state.ts`). Rejected for now because nothing
consumes these programmatically yet, and choosing which names are "small enough" to publish ahead of
any consumer asking for them is exactly the kind of compatibility promise the still-unpublished
state of the package (D-0045/D-0008) makes premature to lock in.

**Rejected alternative (continuo#76's option 3): export the subsystem broadly**, matching how
`control_plane` and `session` are treated in `src/index.ts`. Rejected because `control_plane` and
`session` are re-exported broadly precisely because other in-repo and external code composes them
(`D-1001`'s dual re-export); nothing does that for attention, so matching the precedent would publish
six modules on the strength of the precedent alone rather than on any need it serves.

**Falsifier.** If a real consumer -- in this repository or an external one, once the package is
actually published -- needs an attention module programmatically and the CLI cannot serve that need
(for example, embedding the classifier or the notify formatter in another tool's process rather than
shelling out), this decision is wrong and should be revisited by adding the specific names that
consumer needs, following continuo#76's option 2 shape rather than reopening option 3's broad
question. Absent such a consumer, the silence recorded here is deliberate, not a gap: a future belt
finding `grep -c attention src/index.ts` at `0` should read this entry, not assume the barrel entry
was forgotten.

**Status.** accepted

**Source.** Human gate, 2026-08-31, on continuo#76 (which itself surfaced from review of
continuo#75, A3). Decision id from the `D-09xx` range `D-0034` allocated to the attention belt; taken
as the next free id after A1's `D-0901`..`D-0903`/`D-0906` and A2's `D-0904`..`D-0905`, and ahead of
A3's `D-0951`..`D-0952`, since this decision is not owned by a single sub-belt.

---

## D-0047 -- An identity incident gets its own `FailureKind`, and every path refuses it as `IdentityUnconfirmed`

**Context.** A child that reports a session id other than the one committed before its spawn is the
U27 failure shape, and `ClaudeCliSessionProvider` impounds the session over it. The mismatch has two
legitimate detection points: the readout the provider takes **immediately after spawning**
(`#spawn`, whose answer `start` and `resume` both return), and the read-back poll
`SessionOrchestrator.#awaitIdentity` runs afterwards. Which one fires first is event-loop scheduling
against process startup.

Before this decision the caller saw a *different exception class* depending on which won:
`#unwrap` turned the verb's `Failure` into `ProviderStartFailed`, while `#awaitIdentity` -- which
treated only `Ok` as conclusive -- polled to exhaustion and raised `IdentityUnconfirmed`. The
provider's own comment already said this must not happen ("which call detects it is a race against
the child ... and the evidence must not depend on winning it"), but it said it about the *persisted
incident*, not about the class. continuo#92 was filed when the race went the other way on a
contended `windows-latest` runner and turned a pull request whose entire diff was 80 lines of this
file red.

The naive repair -- translate `UNINTERPRETABLE_RESPONSE` at the `start` verb into
`IdentityUnconfirmed` -- is wrong, and an independent review said so before this was taken:
that kind also carries a line that is not JSON, a `result` event naming no outcome, and a capture
file that cannot be read, so splitting on it would classify broken output as an identity conflict.
Matching the `detail` prose instead would promote a message to an internal protocol.

**Decision.** Three parts, in this order, because the first is what makes the others honest.

1. **A typed discriminator.** `FailureKind` gains a seventh member, `IDENTITY_INCIDENT`
   (`identity-incident`), emitted from every place an identity incident is built: `#readout`'s
   persisted-incident branch, `#readout`'s live mismatch scan, and `resume`'s own record-incident
   guard. `Uninterpretable` carries the kind so each verb forwards what the readout decided rather
   than hard-coding one. Sites that are **not** incidents keep `UNINTERPRETABLE_RESPONSE`, including
   the two "finished without any event naming a session identity" branches -- those are *never read
   back*, not *positively contradicted*.
2. **One refusal class, everywhere the orchestrator can learn the fact.** `#unwrap` raises
   `IdentityUnconfirmed` for `IDENTITY_INCIDENT` and `ProviderStartFailed` for everything else, so a
   start that genuinely failed to start is unchanged. `#awaitIdentity` treats an incident as
   terminal instead of polling a decided outcome to exhaustion. `recover()`'s pre-resume probe
   refuses one too: the C2 provider persists incidents and would refuse the resume as well, but S1
   does not require that of a provider, and a walk that resumed on the strength of having asked too
   early would bury the incident under a new generation. `start` and `resume` share `#spawn`, so
   both verbs are covered; fixing only `start` would have left the same nondeterminism one verb
   over.
3. **One helper, and it goes through the fence.** Both roads run through
   `#refuseIdentityConfirmation`, which calls `#validateAfterSpawn` **before** it raises. The
   stale-writer precedence is therefore preserved exactly: a claimant that lost its lease while the
   provider was answering leaves as `LoserTerminated` with its child handled, never as a quiet
   identity refusal. The gate row's `moment` records which road was taken, so nothing is lost that a
   reader of the `action` table wanted.

`IdentityUnconfirmed`'s documentation is widened to the two meanings it now carries: never
positively read back, and positively contradicted.

**Rejected alternative: accept both classes and widen what callers treat as this refusal.** That
records an ambiguity as intended behaviour without anyone deciding it is. It would also make this
declared port's case weaker than its source's, which the parity rules do not permit without
recording it -- and the thing being weakened is the only assertion in the file that says which
refusal a caller gets.

**Rejected alternative: remove the post-spawn readout so path (a) cannot exist.** Returning success
from `start` after a terminal safety fact has been learned *and persisted* would conceal a known
incident, and contradicts the documented invariant that every later answer about an impounded
session keeps failing. Whether that readout should exist at all is a separate question (continuo#92
leaves it open); it is not settled here.

**Consequences.** `FailureKind` has seven members where interlock's has six. This is a deliberate
divergence under D-0023 (interlock is frozen; the belt touching the code repairs it here) and is
recorded in `parity/session.claude-cli-provider.ledger.json`'s `divergences` and in
`parity/session.provider-contract.ledger.json`'s. Two assertions move with it: the ported
`test_a_wrong_identity_read_back_is_an_incident` now asserts the narrower kind and its ledger entry
becomes `adapted` (neither weaker nor stronger -- both spellings pin exactly one member of a closed
vocabulary), and the target-only `FailureKind.members.length` count goes 6 -> 7. The vocabulary's
other target-only case needed no change: it was written to state a relative order rather than the
whole list, deliberately, "so a seventh member must expand the axis, not fail this case" -- the
repository had already decided that adding a member is a thing that may happen.

Eight target-only cases land with it, and they are the point of the change rather than its
paperwork: seven in `test/gate_item2/orchestrator-walk.test.ts` force one detection point each
across both verbs (and pin the `ProviderStartFailed` guard and the stale-writer precedence), and one in
`test/gate_item2/mediated-real-provider.test.ts` takes the resume half over the real provider with
the race *removed* -- the incident is already persisted, so there is no child left to lose a race
to. Both mutations were measured: disabling `#unwrap`'s branch reddens the two verb-detected cases,
and disabling `#awaitIdentity`'s reddens the two poll cases. **A green run is not the evidence
here** -- D-1003 already ruled that out for this cell -- the forced cases are.

**Falsifier.** If a caller appears that must tell `ProviderStartFailed` and `IdentityUnconfirmed`
apart *for an identity incident specifically* -- retry logic that treats a failed spawn differently
from an impounded identity, an operator surface that renders them separately, a log classifier that
splits on the class -- then this unification destroyed a distinction that was worth building and
needs a successor entry. The premise it was taken on, and the thing to re-measure: today neither
class name appears anywhere outside `src/index.ts`'s re-exports and the tests, so no caller depends
on the accidental distinction and the migration cost is nil. Separately, if `IDENTITY_INCIDENT` ever
starts being emitted for something that is not a committed-versus-reported mismatch, the
discriminator has stopped discriminating and part 1 has failed on its own terms.

**Source.** Human gate, 2026-08-31, task `continuo-identity-refusal-unify`, on continuo#92
(including its "Independent review" and "Revised criteria" sections), against interlock `65f36c5`
(`src/claude_org_runtime/session/provider.py`, `session/claude_cli_provider.py`,
`supervisor/session_orchestrator.py`). Decision id allocated by the window in the shared band
(`D-0019`..`D-0099`): the change straddles the session belt (`FailureKind` in
`src/session/provider.ts`) and the gate_item2 belt (`src/supervisor.ts`), and the adoption itself
was taken at the window rather than inside either belt's work.

---

## D-0604 -- D-0602's scale reaches the suite budget too: `installSuiteBudget` stops reading `suite_timeout_s` raw, and the ceiling stays off it

**Context.** `D-0602` scaled this belt's watchdogs for continuo's runners by `PORT_BUDGET_SCALE = 3`,
applied where a budget is *used* so the manifest keeps interlock's numbers. It reached two of the
three budgets. `policy.installSuiteBudget()` -- the design-section-9 growth check every belt file
installs -- kept reading `suite_timeout_s` straight out of the profile, so the `fast` profile's 240s
was the one budget in the belt still calibrated on interlock's CI while the per-case and per-barrier
ones around it had already moved. Nothing chose that; `D-0602` simply did not enumerate this call
site, and under this file's append-only rule that entry is left exactly as written -- this one
carries the correction.

The measurement is continuo#94's. Thirty *green* Windows jobs (2026-08-28..30), 60 suite runs, wall
time of `test/fault_injection/conformance.test.ts`:

    n=60   min 49s   p50 129s   p90 161s   max 195s
    as a fraction of the 240s budget:  p50 54%   p90 67%   max 81%

A passing Windows run already spent over half the file budget, and the worst passing run 81% -- a
1.25x wobble from the p90 *green* run trips it. Over the repository's life, `over its 240s suite
budget` appears in **10 of the 40** Windows `double-green` job failures (workflow `tests`, id
`339613836`, every job execution, all attempts, 2026-08-21..2026-08-30; `cancelled` excluded), so
about a quarter of all Windows failures came through this one unscaled number. That is the same
runner weather `D-0602` measured, arriving at the one budget `D-0602` missed.

**Decision.** The suite budget is scaled like the other two. `policy.suiteBudgetS(profile)` returns
`suite_timeout_s * PORT_BUDGET_SCALE`, and the comparison itself is `policy.suiteBudgetViolation()`,
a pure function of the profile and the elapsed seconds that `installSuiteBudget()` wires to a clock
-- so the enforcement path is reachable from a test rather than only from a hook. `fast` becomes
240s -> 720s effective and `full` 1500s -> 4500s. **No number in `manifest.ts` changes**, exactly as
`D-0602` ruled: the profile numbers stay interlock's, and `the profiles carry the budgets the
watchdogs enforce` still asserts them literally. The failure message prints the manifest's raw
number and the scale beside the effective one, so a failing log does not send a reader looking for
720 in a manifest that says 240.

**Alternatives.**

- **Reuse `scaledBudgetS()`, which every other scaled budget uses.** Rejected: it would cap the
  suite budget at `RUNNER_BUDGET_CEILING_S = 50` and turn `fast`'s 240s into 50s. That ceiling
  exists for a specific race -- a *case* budget competes with Vitest's per-test `testTimeout`, and
  if the runner wins, the failure stops naming the case. The suite budget races nothing: it is a
  comparison made in `afterAll` against the file's own wall time, after every test has finished. The
  ceiling would protect nothing here and only mis-scale, so `suiteBudgetS()` is a separate function
  and says so at its definition.
- **Raise `suite_timeout_s` in the manifest.** Rejected on `D-0602`'s grounds and `D-0029`'s: it is
  the "raise the timeout" move `D-0029` and `D-1003` both anti-recommend, it invents a threshold,
  and a ported case asserts interlock's numbers literally. Scaling at the point of use invents
  nothing -- the factor is the one `D-0602` already established with its own measurement.
- **Fold this into continuo#83's Windows-flake work.** Rejected deliberately: #83's direction is
  serialization of the child-process-spawning tests, and its AC-3 requires the chosen direction not
  to share a diff with adjacent repairs. The two are independent and can land in either order.

**Consequences.** The growth detector on these files is weakened: 240s -> 720s of effective
headroom. Measured green p90 is 161s, so a file would have to become **4.5x** slower than today's
worst-case-but-passing Windows run before the budget fires. It still detects the unbounded growth
design section 9 asks it to detect, with a wide margin, and the alternative -- a detector that fires
on a 1.25x wobble -- mostly reports runner weather. Expected effect, from continuo#94: Windows-only
red run rate 22.1% -> ~17% (estimate, not a claim this entry rests on).

**Falsifier.** If a belt file's runtime crosses 720s for a reason that is not runner weather, the
watchdog still fires and still names the profile and the file, which is what design section 9 asks
of it -- and the message now carries the raw number and the scale, so the diff to argue about is
visible from the log alone. If the scale is ever suspected of hiding growth, the measurement to redo
is continuo#94's: sample the file's wall time over green Windows jobs and compare the p90 against
the *unscaled* budget. If a fourth budget is ever added to the belt and read raw, the case
"no budget in `policy.ts` is read outside the functions that scale it"
(`test/fault_injection/manifest.test.ts`) goes red rather than the omission surviving a second time -- and its sibling case asserts the
ENFORCER, `suiteBudgetViolation`, not just `suiteBudgetS`'s arithmetic, which is the review gate's
correction on this change: a guard that checked only the helper would have been green over exactly
the defect being repaired. Both were observed red before they were kept.

**Status.** accepted

**Source.** Human gate, 2026-08-31, task `continuo-suite-budget-scale`, on continuo#94 (whose body
is the primary specification and carries the measurements above). Decision id allocated inside the
fault-injection belt's band (`D-06xx`, `D-0601`), following `D-0603`: this amends `D-0602`'s
implementation within the belt that owns it and takes no ruling outside it.

---

## D-0048 -- Windows runs the child-process-spawning tests apart from the rest of the suite

**Context.** `double-green (windows-latest, node 24)` failed 17.7% of its executions over the seven
days to 2026-08-30, and `windows-latest, node 22` 10.7%; the ubuntu cells failed 0.9%. Windows alone
blocked 22.1% of all CI runs. Read from the Actions API over the workflow's whole life (195 runs,
1580 job executions, 800 `double-green` cell executions, all attempts, `cancelled` excluded), the 35
suite-step failures split 22 timeout-or-budget, 9 assertion-only, 2 both, 2 neither. The timeout
class is the majority, and its signature is starvation rather than a slow test: those jobs have a
p50 wall time of 808s against a p50 of 697s for *green* jobs on the same cell. 24 of the 40 Windows
failures had the sibling Windows cell green, which is a machine-local signature, not a code one.

**Diagnosis, and why it is D-1003's.** D-1003 already named the mechanism on one file: vitest workers
running in parallel on a small runner, each spawning child processes of its own, produce enough
concurrent demand to push an *unrelated* file past its own tuned budget. That decision skipped
`suite-runs-unchanged.test.ts` as the instance in front of it and said so. The measurement above says
the class did not stop there: by directory the 35 suite failures are `fault_injection` 21,
`control_plane` 11, `measurement` 9, and six others, so the contention is general and the stopgap was
scoped to one file.

**Decision.** On Windows, `npm test` runs the suite in two passes rather than one:
`scripts/run-suite.mjs` runs the files that do not spawn child processes in parallel exactly as
before, then the files that do, one at a time. Everywhere else, and for any invocation given an
argument, it is `vitest run` and nothing else.

Three parts of that are load-bearing and are recorded here rather than left to the file:

1. **The set is measured, not grepped.** `ChildProcess.prototype.spawn` was wrapped in a setup file
   and the whole suite run, which attributes every asynchronous spawn to the file that caused it
   (193 spawns over 89 files); the synchronous entry points take no shared object and cannot be
   intercepted that way, so those came from their call sites under `test/`, including the ones
   reached through a helper. The result is 18 files. A static closure was rejected as the selector:
   followed through `src/` it classifies by what a module *could* do -- `src/control_plane/lease.ts`
   names a spawn most of its callers never reach -- and covers a third of the suite. The closure is
   kept only as a *guard*, stopping at `test/`'s edge, which is why three files appear in
   `scripts/run-suite.mjs` as classified-not-spawning with a reason each.
2. **The structural checks stay in the parallel pass.** The dozen sweeps that parse syntax trees
   through `scripts/lib/ts-ast.mjs` do spawn a child -- the TypeScript 7 compiler is a separate
   program -- but exactly one, long-lived, shut down per file by `test/helpers/parser-lifecycle.ts`.
   Their subprocess demand is already bounded by the worker count, and serializing them would roughly
   double the serial pass to relieve contention they do not create.
3. **A split that is not the whole suite is a failure, not a green run.** The script refuses to run
   when a listed file no longer exists or when a test file reaches `child_process` unclassified, and
   after both passes it checks the two JSON reports account between them for every file the include
   glob matches. Two green passes that skipped a file between them are the failure mode this shape
   introduces, and it is checked rather than trusted.

**What this does not change.** The double-green rule and its seed (D-0005) reach each pass exactly as
they reached the single run, and CI still calls the entry point twice per cell with two distinct
seeds. No time budget moves: D-0602's manifest is untouched, and `installSuiteBudget()`'s unscaled
`suite_timeout_s` -- which accounts for about a quarter of Windows failures on its own -- was kept
out of this diff as continuo#94 and landed separately as `D-0604` while this branch was open. `ci-gate` and the required check
set are untouched. Linux runs what it ran before. D-1003's skip stays as it is: its own falsifier
asks for a re-measurement, and this decision does not assume the answer.

**Why not the alternatives.** Skipping the spawning tests on Windows (~28% of the suite, including
the process-lifecycle behaviour the cell exists to check) gives up coverage that would have to be
argued back. Raising the budgets is the move D-0029 and D-1003 both anti-recommend, and starvation
under a full pool is not bounded by a larger number. Demoting the Windows cell from required also
hides the assertion class and has no compensating control to hand. A larger runner (option E below)
is the fallback, not the alternative, and is priced separately. Reducing the real per-test cost
(a per-file SQLite template) is the change that would make all of this unnecessary, and it is blocked
behind `test/testkit`'s own freeze.

**What it costs, measured on the cell rather than modelled.** Serialization buys contention relief
with wall time, and this cell has the least of it to spend: before the change, p90 job wall time was
930s and the worst observed *green* job 1864s against a 2400s `timeout-minutes` cap. On Linux, whole
suite minus the file D-1003 already skips on Windows, the split cost 1.92x at one worker (58.6s to
112.4s) and 1.21x at two (71.1s) -- and 1.92x applied to the worst green job would have exceeded the
cap, so the affordability of one worker was recorded here as an open measurement rather than an
assumption, with `CONTINUO_SPAWN_TEST_WORKERS` added so that one worker and two could be compared on
the Windows cell itself.

That measurement has since been run, at one worker, on the branch that carries this decision: five
executions of both Windows cells (run `33356059264`, attempts 1-5, `head_sha` `e3aeddd`), all ten
jobs green, all twenty suite runs splitting as intended and accounting for all 89 files across their
two passes.

| | before | at one worker (n=10) |
|---|---|---|
| job wall p50 | ~640s | 762s |
| job wall p90 | ~930s | **1017s** (42% of the 2400s cap) |
| job wall max (green) | 1864s (78% of cap) | **1054s** (44%) |
| `conformance.test.ts` p50 | 129s (n=60) | 35.7s (n=20) |
| `conformance.test.ts` p90 | 161s | **57.1s** |

Three things follow, and they are the reason this section is a result rather than a precondition.
The affordability question is answered: p90 is 1017s against the ~1500s at which option B would have
been unaffordable at this runner size, so E is not needed. **The Linux 1.92x did not reproduce on
Windows** -- p90 rose 9% and the worst green job *fell* by 43% -- which is what the ratio being an
upper bound rather than a prediction meant: part of what serialization removes on Windows is the
contention that made each file slow to begin with. And the primary criterion below is met with
margin: 161s to 57.1s is a 2.8x contention relief where 1.5x was asked for.

Two limits on what that measurement shows, recorded so a later reader does not over-read it. It was
taken **before D-0604** (which scales the fault-injection suite budget from an effective 240s to
720s) reached this branch, so it is a clean comparison against the pre-change baseline but not a
measurement of the two changes together; nothing was censored by the old budget either way, since the
worst `conformance.test.ts` run in the sample reached 139.7s, well inside 240s. And ten jobs cannot
decide the secondary criterion below, which asks for 30 -- with the further caveat that D-0604 makes
zero budget-class failures easier to achieve, so that criterion is weaker evidence after D-0604 than
it was when continuo#83 wrote it.

The comparison against two workers was **not run**: one worker cleared both bars using 42% of the
cap, so the second sample would have chosen between two affordable settings rather than deciding
anything, and it was dropped for time at the window. One worker therefore ships as the default, which
is what this decision records. `CONTINUO_SPAWN_TEST_WORKERS` stays in `scripts/run-suite.mjs` for the
comparison a future runner change would make worth taking; CI passes no value for it, so the workflow
file is untouched by this decision.

**Falsifier.** Stated as continuo#83 states it, so that "CI is green now" is not what closes this:

> **Primary criterion (a measurement, not a streak).** Re-run the sampling procedure on 30 green
> Windows jobs after the change and compare the wall time of
> `test/fault_injection/conformance.test.ts` against the pre-change baseline (n=60, p50 129s, p90
> 161s, max 195s). The decision holds if **p90 falls below ~110s** (a ~1.5x contention relief). This
> measures the mechanism directly and does not depend on any failure occurring or not occurring.
>
> **Secondary criterion (exposure).** Across the next **30 decided** `double-green (windows-latest,
> node 24)` executions -- all attempts, `cancelled` excluded -- **zero** timeout/budget-class
> failures. Under the null hypothesis that nothing changed, the timeout-class rate on that cell is
> ~10.6%, so 30 clean executions happen by luck with probability ~3.5%. Assertion-class failures
> (the continuo#92 shape) are explicitly **not** counted against this criterion.
>
> **Falsified if** either a timeout/budget-class failure recurs within those 30 executions, or the
> p90 does not move -- the second case meaning the serialization did not actually relieve contention,
> whatever the failure count did.
>
> **Not evidence:** any number of green runs below N=20 (at the measured 17.7% cell rate, N=5 is
> green by luck 37.8% of the time and N=10 14.3%).

**Where the falsifier stands as this lands.** The primary criterion is **met**: p90 161s to 57.1s,
against the ~110s the criterion asks for. It was evaluated on 10 jobs rather than 30 because it is a
measurement of wall time and not a count of failures -- 20 suite runs is a sample of the quantity
itself, which is exactly why continuo#83 preferred it to a green streak. The secondary criterion is
**open**: it needs 30 decided executions of `double-green (windows-latest, node 24)` and this
decision lands with 5. It should be evaluated later, from the Actions API, with D-0604's effect on it
noted above.

**Status.** accepted (2026-08-31)

**Source.** Task `continuo-windows-serialize-spawn-tests`, 2026-08-31, implementing the direction
selected at the human gate on continuo#83 (option B of seven, with the spike measurement named as
part of the recommendation). Decision id from the `D-0019`..`D-0099` shared band for cross-belt
decisions taken at the window; this one is not owned by a belt, since the runner entry point is
shared by all of them.

## D-0049 -- The runtime surfaces continuo operates say `continuo`, not `Interlock`

**Context.** Continuo carries interlock's source text faithfully, and for the test suite that
faithfulness is the whole discipline (`AGENTS.md` section 1). A set of runtime strings inherited that
discipline by accident rather than by decision. They are not assertions and no case reads them; they
are what an operator or a spawned worker sees at runtime.

**The inventory, counted two ways.** Nine distinct strings, at ten sites -- one message text appears
at two sites. Counts below are of *distinct strings* unless a site count is given.

Carried byte-verbatim from interlock at `65f36c5` -- **seven strings, eight sites**:

| # | String | Site | Interlock source |
|---|---|---|---|
| 1 | the `argparse` program name `interlock-fence-hook`, printed in the usage line and every argument error | `src/fencing/hook.mjs` `PROG` | `fencing/hook.py` |
| 2 | the `--help` description opening *"Interlock PreToolUse deny hook."* | `src/fencing/hook.mjs` `HELP_TEXT` | `fencing/hook.py` |
| 3 | *"Interlock cannot read its own fence, so it cannot tell whether this ..."* | `src/fencing/hook.mjs` | `fencing/hook.py` |
| 4 | *"Interlock deny hook could not load its own fence logic and denied ..."* | `src/fencing/hook.mjs` | `fencing/hook.py` |
| 5 | *"Interlock deny hook failed and denied by default: ..."* | `src/fencing/hook.mjs`, **two sites** | `fencing/hook.py` |
| 6 | the default prompt handed to a `claude -p` child: *"You are a supervised Interlock worker session ..."* | `src/session/claude_cli_provider.ts` | `session/claude_cli_provider.py:155-156` |
| 7 | *"Measurement harness for the Interlock control plane"* | `src/measurement/cli.ts`, the belt's **standalone** parser (prog `continuo measure`, *"for driving this command without the top-level CLI"*) | `measurement/cli.py:341` |

Not carried -- continuo's own text -- **two strings, two sites**:

| # | String | Site | Why it is continuo's |
|---|---|---|---|
| 8 | *"TypeScript runtime for the Interlock control plane"* | `src/cli.ts`, the top-level parser | interlock has no such string; a TypeScript runtime is not something it could have described. The sibling descriptions in the same two files all say *"a production control plane"*. |
| 9 | *"Interlock deny hook failed while denying: ..."* | `src/fencing/hook.mjs`, the last-resort `catch` around the deny path | the `catch` itself is continuo's; interlock's `hook.py` has no such guard, and its only `Interlock ...` message strings are items 1-5 above. |

Item 7 is **not** the description the mounted `continuo measure` subcommand prints: that one is
declared in `src/cli.ts` and already said *"a production control plane"*.

An operator running continuo does not run Interlock. A worker continuo spawns is not an Interlock
worker session. The strings named a system that is not there.

**Decision.** All nine strings say `continuo`, at all ten sites. `PROG` becomes
`continuo-fence-hook`; the hook's `--help` description, its three distinct carried messages (items
3-5, at four sites) and continuo's own last-resort message are reworded to match; the default worker
prompt says *"a supervised continuo worker session"*; the top-level and standalone-measurement
descriptions both say *"the continuo control plane"*.

Three things this decision does **not** do:

1. **It does not touch anything a case asserts.** Every literal a ported or adapted case reads keeps
   interlock's spelling: `INTERLOCK_MESSAGEBUS_*` and `interlock-messagebus`
   (`test/messagebus/endpoint.test.ts`, and `D-0502` decides them besides),
   `interlock-measurement-report` (`test/measurement/cli.test.ts:223`, from a **ported** case),
   `interlock-breach-witness` (in the pinned oracle vector), the hook's `interlock` payload key
   (`D-0201`, *"the wire key, verbatim"*), and the uuid5 namespace at `src/session/uuid5.ts:120`,
   which every derived session UUID depends on.
2. **It does not touch identifiers anything outside this repository reads.**
   `INTERLOCK_STUB_STATE_FILE` and `INTERLOCK_SESSION_UUID` keep their names for the reason `D-0502`
   already gave: the name is read by a configuration file this repository does not own.
3. **It does not touch `owning_system = 'interlock'`**, the canary's persisted vocabulary. That one
   is a `CHECK` constraint plus roughly thirty ported assertions; it is documented rather than
   changed (`src/canary/ledger.ts`).

The line the decision draws is therefore: **what continuo emits at runtime says continuo; what
continuo is compared against, keyed by, or asserted on keeps interlock's spelling.**

**Alternatives.**

- *Leave all nine verbatim.* Rejected: the port's fidelity obligation is to interlock's **suite**,
  which is the specification (`AGENTS.md:11-12`). A free-standing string no case reads carries no
  parity claim, and keeping it costs an operator a wrong system name at exactly the moment a fence
  has failed closed and they are reading stderr.
- *Change only continuo's own two strings* (items 8 and 9), since those need no divergence at all.
  Rejected as worse than either extreme: the seven carried strings sit beside them in the same output
  surfaces, so the top-level parser would say `continuo` while the measurement belt's standalone
  parser -- the same phrase, one word apart -- still said `Interlock`, and item 9's line of the
  hook's stderr would disagree with items 3-5 beside it.
  Half a rename is less legible than none.
- *File this per belt* (fencing, session, measurement). Rejected: the three surfaces are changed for
  one reason and should stand or fall together; splitting the record would let one be reverted
  without the others and reintroduce exactly the inconsistency above.

**Consequences.** `continuo-fence-hook`'s usage line and argument errors change text, as do the
hook's `--help` description and its four fail-closed stderr sites, the default worker prompt, and two
parser descriptions. No test changes: none of the nine is asserted anywhere (verified by
exact-string grep over `test/`), which is also why the suite cannot witness this change -- the reason
it is recorded here instead.

`HELP_TEXT` in `hook.mjs` is a hand-wrapped reproduction of what CPython's `argparse` folds at 79
columns. `Interlock` (9) to `continuo` (8) shortens its first line to 74 characters; the next word,
`against`, would take it to 82, so the fold point is unchanged. But the text is now continuo's own
and no longer reproduces interlock's `--help` byte for byte -- a later reader should not re-derive it
by diffing against CPython for the source string.

`DECISIONS.md`'s own record of the 2026-08-22 help-token measurement (`D-0207`) is written in terms
of the literal command `interlock-fence-hook`. It is a record of what was measured then and is **not**
edited: the program it names is the one that was run.

**Status.** accepted (2026-09-01)

**Falsifier.** Evidence that any of the nine strings is depended on from outside this repository --
a fence configuration, a log parser, or a harness matching on `interlock-fence-hook` or on one of the
stderr messages. That would put them in `D-0502`'s class (names an external file reads) rather than
in this one, and this decision would be superseded rather than amended.

**Falsified by.** interlock resuming. The seven carried strings would then be a divergence continuo
maintains against a live upstream rather than against a frozen one, and the question of whether to
follow upstream wording would be reopened under `D-0023`.

**Source.** Task `continuo-interlock-naming-audit`, 2026-09-01. The audit classified all 2309
interlock mentions in the tree and separated carried text from continuo's own by grepping the frozen
interlock checkout at `65f36c5`; these nine were the runtime surfaces in the (b) and judgement
classes. Direction selected at the human gate (D1), which also directed that the coupled pairs be
changed together. Decision id from the `D-0019`..`D-0099` shared band for cross-belt decisions taken
at the window: this one spans the fencing, session and measurement belts and is owned by none of
them. (Ids `D-0037`..`D-0042` are left unused, as they have been throughout, because continuo cites
interlock's decisions of those numbers.)
---

## D-0050 -- The production schema is the control plane the lap runs on, and the spike schema is not a fallback

**Context.** `docs/design/minimal-operating-loop.md` section 6.1 calls this "the most upstream
decision in the document", and the reason is structural rather than rhetorical: sections 5.1, 5.4 and
5.5 all list it as a dependency, and section 4.2 shows the two databases **refuse each other** at
open. `src/control_plane/spike.ts` declares the spike `application_id` (`ILK5`, `0x494c4b35`) and
`migrator.ts`'s `verifyProductionDatabase` names it explicitly, so that being handed a spike file
produces "this is a spike database" rather than "this is some other database" -- and that refusal
already states, in the shipped message, that "there is no migration from the spike schema and none
will be written".

So the two schemas are siblings, not a version pair, and nothing in the build will convert one into
the other. What was missing was not a mechanism but a **recorded choice**: every module was written
against production, `continuo db create|migrate|verify` was mounted over the production migrator, and
the measurement harness reads a production database -- yet no entry said that this is the control
plane, which left "run the lap on the spike schema, it is smaller" as a question a later reader could
reasonably believe was still open. It is not, and this entry is where that stops being inferable only
from the code.

**Decision.** **The production schema is the control plane.** `continuo` runs the operating loop on a
production database -- `application_id` `ILKP`, the forward-only migration ledger in
`src/control_plane/migrations/`, opened at head through `openProductionControlPlane`. The spike schema
is not a supported target for it, not a lighter-weight alternative for a small lap, and not a stage
on the way to production.

Three facts settle it, in the order they mattered:

1. **The spike schema has no `event` table.** It holds six: `run`, `session`, `lease`, `outbox`,
   `incident` and `action`. Production holds twenty-four, including `event`, `consumer`,
   `event_consumption`, `gate`, `gate_transition`, `gate_relay`, `run_pr_link` and `ci_observation`.
   The lap is *defined* by the gate, and the gate's `origin_event_seq` is a foreign key onto a table
   the spike does not have -- so this is not a matter of the spike being less convenient. The lap
   cannot be expressed there at all.
2. **There is no bridge and there will be none.** interlock `D-0013` and `D-0026` put the cutover at
   the run boundary with no state conversion, and `migrator.ts` enforces that by refusing a spike
   file outright. A decision to run on the spike would therefore be a decision to have no path back.
3. **The rest of the build already assumes it.** The event spine, the gates, the leases, the outbox,
   the repo links, the measurement harness and the `db` verbs are all written against the production
   DDL. Choosing otherwise now would not be selecting between two supported options; it would be
   abandoning the implemented one.

**Consequences.**

- Every command in the operating loop opens its database through `openProductionControlPlane`, which
  is the production standard **plus** the at-head check. A database that is behind is refused rather
  than migrated in passing: `continuo db migrate` is where a file moves forward, and a write command
  that quietly migrated the file it was pointed at would make the forward-only ledger a side effect
  rather than a decision.
- The spike modules stay. `schema.ts` and `spike.ts` are not deleted by this entry and are not
  deprecated by it: they are a ported subsystem with its own suite, and `spike.ts`'s constant is what
  makes the production verifier's diagnosis specific. What this entry removes is their candidacy as
  the lap's store, not their existence.
- Section 6.1's other half is already built. The verb set it pairs the recommendation with --
  `continuo db create|migrate|verify` -- shipped ahead of this entry, mounted under `D-0030`'s rule
  that the subtree's own module owns its parser. This entry records the schema choice that the mount
  had already assumed.

**Falsifier.** A control-plane capability the lap needs that production's DDL cannot express while
the spike's can. Nothing of the sort is known -- the containment runs the other way, production being
a strict superset in every table the lap touches -- but a concrete instance would mean the two are
not sibling and superset after all, and would reopen this. A *second* production-shaped schema (a
future re-baseline of the migration ledger) is not a falsifier of this entry: that is a question about
the ledger's own history, which the migrator's checksum rules already govern.

**Rejected alternative: run lap 1 on the spike schema and move to production later.** The move is the
thing that does not exist. With no migration between them and the cutover fixed at the run boundary,
"later" means re-admitting every run under a new database -- and the lap would have to be rewritten
first, since its gate cannot be stored in a schema with no `event` table.

**Rejected alternative: leave it unrecorded, since the code already only does one of these.** This is
what was in place before this entry, and it is the state section 6.1 objected to. A decision that is
merely implied by which module was written first is one that a reader who has not read every module
will re-open, and re-opening it costs more than recording it.

**Status.** accepted

**Source.** Human gate, task `continuo-lap1-schema-and-run-writer`, on
`docs/design/minimal-operating-loop.md` section 6.1's recommendation, taken as written. Decision id
allocated from the `D-0019`..`D-0099` shared band after checking `origin/main` at `9db40bc`, where
`D-0049` is the highest id in the band.

---

## D-0051 -- A run is created by one writer, `continuo run admit`, which appends `run_created` in the same transaction and refuses a second admission

**Context.** `D-0046` settled who may *transition* a run and deliberately said nothing about who
creates one: section 4.2's writer table fences `run.status` with the run lease epoch and assigns run
creation **no** fence, so `run_lifecycle.ts` shipped as the single in-place writer of `status` with a
docstring saying, in as many words, that a `createRun` there "would be a second writer to the run
table wearing this module's name". The result was a build that could advance a run it had no way to
create: nothing under `src/` inserted a `run` row, and every suite that needed one wrote it by hand.

`docs/design/minimal-operating-loop.md` section 6.2 asks for that writer and for the event vocabulary
the lap emits, `EVENT_TYPES` having no word for anything the lap produces.

**Decision.**

1. **Run creation has exactly one implementation site: `src/control_plane/run_admission.ts`.** Not
   `run_lifecycle.ts`, which stays the in-place writer of `status` and stays ignorant of events and
   of the CLI. The two are separate modules because they are separate rules -- one is fenced and
   one is deliberately lease-free -- and putting both behind one name would make the fence look like
   a property of the table rather than of the transition.
2. **The row is inserted at `created`, and admission transitions nothing.** A run inserted directly
   at `running` would reach `running` without passing through `advanceRunStatus`, which is `D-0046`
   rule 1 evaded by starting past the gate rather than by writing around it. Every later status is
   the lifecycle writer's.
3. **The row and its `run_created` event are one transaction.** `event.run_id` is a foreign key onto
   `run(run_id)`, so the order is forced: insert, then append. What is not forced is the failure in
   between, and that is what the shared transaction buys -- a run whose existence has no recorded
   cause is not a state this build can reach. `txn.ts`'s `transaction` joins an inner block to an
   outer one, so `appendEvent` runs inside admission's boundary unchanged.
4. **A second admission of one run identifier is refused, not absorbed.** This is a deliberate
   difference from the spine underneath, where a re-appended `dedup_key` is an idempotent no-op: a
   producer restating one observed fact is ordinary, and a second statement that a run *begins* is
   either a mistaken repeat or two callers believing they own one identifier. Both are things an
   operator has to see. The refusal is `RunAlreadyAdmitted`, in the `ControlPlaneRefusal` family, so
   it reaches the operator as one line and exit 2.
5. **One event type is added: `run_created`.** `EVENT_TYPES` is defined as the vocabulary *this
   implementation produces*, so a type is registered when its producer is written and not before.
   `run_created` names an objective fact about the database in the `subject_pastparticiple` form the
   existing words use (`pr_merged`, `gate_expired`, `consumption_skipped`). Types for producers this
   lap does not write -- `session_spawned`, `run_completed`, `run_delegated` -- are **not** registered
   ahead of them, because a vocabulary that lists words nothing emits stops being an answer to "what
   is worth subscribing to".
6. **The surface is `continuo run admit --db DB --run-id ID [--now-ms MS]`**, its own subtree under
   `D-0030`'s rule, declared by `src/control_plane/run_cli.ts` and only mounted by `src/cli.ts`. It
   opens through `openProductionControlPlane` -- at head required, per `D-0050` -- and it never
   migrates. The clock is read once and passed down; nothing below the command reads one.

**Consequences.**

- **`D-0046`'s structural check changes shape, and this is where that is said.**
  `test/control_plane/run-lifecycle.test.ts` asserted that no module under `src/` writes the `run`
  table in raw SQL, scanning for `UPDATE run` and `INSERT INTO run` together. That conflated two
  rules `D-0046` states separately. The scan is now two cases: `UPDATE run` stays at **zero** across
  `src/`, and `INSERT INTO run` must equal **exactly the admission module**. Dropping `INSERT` from
  the scan instead was rejected: it would pass for any number of creation writers, including zero,
  and zero is what it would read as the day the module is deleted.
- **A run row is now creatable from the shipped binary.** Before this, `continuo db create` produced
  a control plane whose central table no command could write.
- **A run identifier is printable ASCII (U+0020..U+007E).** Narrower than the `run` table's own
  `CHECK`, which asks only for non-empty text, and narrower on purpose: the column holds every
  identifier any writer ever admits, while this is the rule for the one writer that puts identifiers
  there **and** promises to print them back. It is quoted verbatim into the one-line success report
  and into the `RunAlreadyAdmitted` message, both of which end at a single newline, so an identifier
  carrying its own newline would make the command appear to print a second line it never wrote --
  with `error: ` a prefix worth forging -- and one carrying a character a cp932 console cannot encode
  would make it print none at all, on a platform `D-0003` puts on the merge path.
  `docs/cli-output-policy.md` governs what continuo authors and leaves external values to "any code
  path that echoes external text to a console" to handle "on its own terms"; this is that path
  handling it. Refused at the writer rather than escaped at the print site, so that the row, the
  event and every report about them quote the same string -- escaping in the CLI would trade a
  visible refusal for a database holding an identifier no report can quote back faithfully.
- **No consumer is registered for `run_created`.** The append fans out to nobody and that is not a
  defect: `D-0046` rule 2 gives the consumer half its own step. `D-0046`'s falsifier -- that the
  consumer indirection has no reader on the lap -- remains live and is not resolved here.
- **`D-0046`'s collapse is not taken.** Admission does not observe a fact and transition a run in one
  motion; it creates a run and records that it did. Section 6.2's conditional requirement to record a
  collapse therefore does not fire, and nothing here supersedes `D-0046`.

**Falsifier.** A run identifier that a real caller must use and this rule refuses -- an upstream id
carrying a non-ASCII label, say. That would mean the identifier and its printable form are two things
rather than one, and admission would need to store the first and report the second, rather than
narrowing the first. Also: a legitimate operation that must create a run *and* leave it un-admitted, or admit a
run that already exists -- a resumption path, or a re-import of runs from another store. Either would
mean rule 4's refusal is the wrong shape and that admission needs a separate verb for the case rather
than a relaxation of this one. And if a second module is ever found to need an `INSERT INTO run`, rule
1 is wrong rather than the test: the check should not be widened to two files without an entry saying
which module owns what.

**Rejected alternative: make a repeat admission an idempotent success.** It is the friendlier shape
for a script that retries, and it is wrong here for the reason rule 4 gives: the two callers it would
silently reconcile are the case that most needs to be visible. A retrying script can read the run.

**Rejected alternative: create the run inside `appendEvent`'s `sideEffect`.** It is the shape the
events layer already offers, and it cannot work: the side effect runs *after* the event row is
inserted, so the foreign key onto `run(run_id)` would have nothing to point at.

**Status.** accepted

**Source.** Human gate, task `continuo-lap1-schema-and-run-writer`, on
`docs/design/minimal-operating-loop.md` section 6.2 and against `D-0046`; the command's shape (rules
2, 4 and 6) was settled at the gate from a prior design review, and this entry records it. Decision id
from the `D-0019`..`D-0099` shared band, next after `D-0050`.

---

## D-0052 -- The runner's per-test timeout is scaled on a slow platform, and the scale has one home

**Context.** `D-0602` and `D-0604` scaled this port's *harness* budgets -- the fault-injection
per-case, per-barrier and suite watchdogs -- by `PORT_BUDGET_SCALE = 3`, because interlock's numbers
are calibrated on interlock's runners and continuo's Windows cells are not those runners. One layer
above them, Vitest's own `testTimeout` and `hookTimeout` stayed a flat `60_000`, written into
`vitest.config.ts` and copied verbatim into
`test/gate_item11/support/suite-runs-unchanged.config.ts`. Nothing chose that; it is the same
omission `D-0604` repaired one level down, sitting one level up.

It is not theoretical. On continuo#99 the `windows-latest` / node 24 cell failed with

    Test timed out in 60000ms.

in `test/canary/audit.test.ts` and `test/control_plane/gates.test.ts` -- two files that PR touched by
zero lines. A re-run went 8/8 green. The failure was the machine, and the merge gate charged it to
the change.

**The measurement.** Workflow `tests` (id `339613836`), every job execution, all attempts,
2026-08-21..2026-08-30, `cancelled` excluded -- 195 runs, 1580 job executions
(`notes/continuo-windows-flake-measurements-2026-08-31.md`, taken *before* `56a964c` landed, so the
failure-rate column is historical and the duration ratio is the durable fact):

    green job wall time, p50:   ubuntu-latest ~70s     windows-latest ~640s   (~9x)
    windows p90 ~930s, max 1864s

Byte-identical work, a nine-fold gap. Against that, `60_000` on Windows is the same budget the fast
cell gets, and the largest single-test figure this repository has ever measured on a slow Windows
runner is 13,556ms -- 4.4x of headroom where linux has 2000x.

**Decision.**

1. **One home for the scale.** `test/helpers/runner-timeouts.ts` owns `PORT_BUDGET_SCALE = 3`,
   `RUNNER_TIMEOUT_BASE_MS = 60_000` and `runnerTimeoutMs(platform)`. Both Vitest configs call
   `runnerTimeoutMs()`; `test/fault_injection/policy.ts` re-exports the constant from there rather
   than declaring its own. There is now no second place to raise the number and forget the first.
2. **The predicate is the platform**, `process.platform === "win32"`, and not `CI`, and not an
   environment variable. The evidence above is a property of the OS -- NTFS plus a scanner against an
   fsync on every commit -- and the workload does not vary by cell. Keying on `CI` would make the
   machine a developer reproduces a Windows failure on behave differently from the machine that
   failed, which is the one occasion the budget matters. An environment variable has to be set by
   every workflow, every nested run and every local shell, and forgetting it fails silently -- the
   failure mode this entry exists to remove.
3. **The harness budgets keep their unconditional scale.** `PORT_BUDGET_SCALE` is applied on every
   platform where `D-0602` applied it, and this entry does not narrow it. The asymmetry is
   deliberate: a harness budget that fires names the case, prints the `S9-REPRO` line and runs the
   teardown ladder, so being generous there costs a slower failure and nothing else, while the
   runner's timeout produces an unattributable one. `RUNNER_BUDGET_CEILING_S = 50` still holds every
   case budget below the *fast* runner's 60s, which is the smaller of the two and therefore the
   binding one; `manifest.test.ts` now asserts that ordering against `RUNNER_TIMEOUT_BASE_MS`, so
   the two layers cannot drift into a race where the runner kills a case before its watchdog does.
   Nothing is scaled twice: the runner's timeout and a harness budget are separate numbers compared
   against separate clocks, and the scale is applied exactly once to each.

`fast`'s suite budget, the per-case watchdogs and every number in `manifest.json` are untouched.

**The trade, stated plainly.** On Windows a genuinely hung test is now reported after 180s instead of
60s. That is paid only on the platform that earned it; linux and macOS keep the 60s backstop
unchanged, so a real hang introduced by a change still fails at the original latency on the cells
that run first and fastest. The double-green rule (`D-0005`) means every change runs on ubuntu as
well as Windows, and `retry: 0` means a test that only passes sometimes still stays failed. A late
failure is the cheaper mistake than a false red, which costs a merge and a person's afternoon and
teaches them only that a machine was busy.

The extra 120s per hung test is bounded and affordable against the job's own cap: `timeout-minutes`
is 40 (2400s) and the Windows job's p90 wall time after `D-0048` is 1017s, so a failing run reports
the hang and still finishes well inside the cap rather than being cut off without a report.

**Alternatives.**

- **Scale unconditionally, on every platform.** Rejected. It buys nothing on ubuntu -- where the
  worst green job is 375s for the *whole suite* -- and triples how long a hung test hangs on the
  cells that are otherwise the fast feedback path.
- **Raise the flat number to 180s everywhere.** The same objection, plus it invents a threshold
  rather than deriving one, which is the move `D-0029` and `D-1003` both anti-recommend.
- **Key on `CI`, or on a `CONTINUO_SLOW_RUNNER` variable.** Rejected on decision 2's grounds. Both
  were considered specifically because they are more explicit; both make the budget depend on
  something other than the thing that is actually slow.
- **Leave it and make the tests faster.** Out of scope here and not obviously available: the failing
  files were not the changed ones, and the cost is `synchronous = FULL` (`D-0012`), which is a
  correctness choice this port carries deliberately.

**Falsifier.** If `Test timed out in` keeps appearing on the Windows cells at a similar rate after
this lands, the budget was not the binding constraint and the starvation hypothesis needs a
different remedy (the measurement to redo is the one above, re-run against the post-`56a964c`
history). Conversely, if a hung test on the Windows cell is ever found to have been reported so late
that the job hit the workflow's own limit, the 3x is too generous for the runner layer and the
scale, not the base, is what to revisit.

**Source.** Task `continuo-test-timeout-scale`, on continuo#99's `windows-latest` / node 24 failure
(2026-09-02) and `notes/continuo-windows-flake-measurements-2026-08-31.md`. Decision id allocated
from the `D-0019`..`D-0099` shared band after checking `origin/main` at `454b850`, where `D-0051` is
the highest id in the band: the change straddles `vitest.config.ts` (shared by every lane), the
gate_item11 belt's nested config and the fault-injection belt's `policy.ts`, so it is a cross-belt
decision taken at the window rather than one belt's.

---

## D-0053 -- The broker belt is declined and discharged rather than ported, and the endpoint moves onto the production schema with the outbox aligned to `cancelled`

**Context.** `docs/design/minimal-operating-loop.md` section 5.1 opens the last belt whose parity
status is neither `ported` nor `not-porting`: `broker`, carrying `retarget` over 54 collected cases
and five uncollected modules. Its verdict is "required -- but not the part the status names", and the
reason is that the status conflates three questions which have three different answers. Section 7
puts the answer at step 5 and says what it unblocks in four words: **the human gate. It is unreachable
until this lands.**

That sentence names a necessary condition and it is easy to read as a sufficient one, so this entry
states which it is: **what lands here is the removal of the *schema* obstacle, and the gate is still
not reachable when it lands.** After this change the endpoint opens the database the gate lives in
and the outbox speaks 0003's vocabulary throughout, which is what step 5 is for and what section 5.1
costed; the gate's first relay is nonetheless still refused, for a reason section 5.1's estimate never
reached, and the adoption-gap bullet under Consequences says what that reason is and why closing it
is not this entry's to take. Everything in the Decision below is unaffected by that; only the claim
about what it adds up to is corrected here.

The obstacle that *is* removed is concrete rather than rhetorical, and it is a consequence of
`D-0050`. The gate
lives only in the production schema -- `gate`, `gate_transition` and `gate_relay` are production
tables and the spike schema has six tables and no `event` at all -- while `src/messagebus/endpoint.ts`
opened its database through `openControlPlane`, the *spike* opener (`endpoint.ts:10`). The two
databases refuse each other at open, so the component that delivers the gate's question to a human
could not be pointed at the database the gate is stored in. `enqueueRelay` writes the `gate_relay`
row and the outbox row in **one** transaction and gate closure cancels the relay's outbox row in the
closing transaction, so the "two databases" arrangement is not separable by a smaller edit either:
section 5.1's option C shows it converting an outbox edit into a distributed-transaction problem.

And the re-point alone would not have been enough, because production head is after
`migrations/0003_outbox_cancelled_status.sql`, which the delivery module predates. 0003 rebuilds the
outbox table, adds `cancelled` to the status `CHECK`, rewrites `outbox_status_is_forward_only` from a
rank comparison into an explicit edge list in which `acked` and `cancelled` are both terminal and
neither is reachable from the other, and narrows the partial index to
`outbox_undelivered ... WHERE status IN ('pending', 'delivered')`. `outbox.ts` spelled "unfinished" as
`status <> 'acked'` in four places. On a production database that means a cancelled relay is still
returned as due, the next `_MARK_DELIVERED` attempts `cancelled -> delivered`, and the trigger aborts
it -- **after** `Outbox.attempt` has already run the destination side effect. The effect happens and
the database denies it ever did. `docs/production-schema.md` section 5.7 states the same lattice from
the schema's side and names the index rule this entry has to obey.

So this entry answers three questions at once because they are one change, and fixes two scopes that
a pre-implementation design review found were open in a way that would have been decided by accident.

**Decision.**

1. **The 54 residents cases are declined, on the grounds that the subject does not exist on either
   side of the port.** `tests/broker/test_residents.py` is process-identity pre-flight detection and
   reclamation of unmanaged residents; `residents.py:6-16` states that the registry it scans is
   written by the **consumer**, not by the runtime. Checked here rather than taken on the design's
   word: `grep -rni resident src/ test/` over this repository returns **zero** hits -- no module, no
   suite, no fixture reads or writes such a registry -- and the design records that `grep -ri
   residents` over claude-org-ja returns zero as well. Porting the cases therefore means building
   both halves of a protocol that has never had either half, and the ~32 KB of `residents.py` plus
   ~28 KB of test is a belt rather than a task (section 5.1 option B). There is a second, independent
   ground: the reclamation policy the cases encode contradicts this repository's, since
   `src/supervisor.ts:699-703` states that no orphan is adopted into a run its binding does not name,
   so a faithful port would install a rule the supervisor already refuses.
2. **The five uncollected modules are discharged by the completed messagebus belt, at belt level, not
   retargeted case by case.** They are `tests/attention/test_broker_journal_contract.py`,
   `tests/broker/test_control_plane.py`, `tests/broker/test_delivery.py`,
   `tests/broker/test_notify.py` and `tests/broker/test_store.py`, recorded in
   `parity/source-inventory.manifest.json` under `collection_time_skips.modules`. Each is quarantined
   behind a module-level `pytest.importorskip("claude_org_runtime.broker.server")` against a
   `server.py` that was deleted, and each therefore has **no node ids**: pytest never collected them,
   so there is nothing to inventory and, by this repository's standing rule, nothing may be invented.
   A per-case retarget is not merely expensive, it is unavailable -- there are no cases to retarget.
   What discharges them is that `D-0032` already named the messagebus package as their destination
   and that belt is complete at 43/43 (`parity/source-inventory.belts.md`, `messagebus` section), so
   interlock's `Q-0023` -- "re-target onto the MessageBus rewrite" -- is answered by the rewrite
   existing. `D-0034`'s treatment of the attention file (a metadata-only ledger recording zero
   entries) stands unchanged; this entry does not convert it into a normal ledger, because the reason
   it cannot have one is the absence of an inventory to point at, which this entry does not change.
3. **The endpoint opens the production control plane.** `openControlPlane` becomes
   `openProductionControlPlane` (`src/messagebus/endpoint.ts`), which is the production standard plus
   the at-head check, per `D-0050`. Three inputs that were previously served are now refused at
   startup: a spike database (diagnosed as one by `application_id`, `ILK5`), an absent file, and a
   production database behind head. **The refusal exits 2**, the code `endpoint.ts` already uses for
   every startup misconfiguration -- missing env, and a recipient no handler serves -- and not the
   uncaught-exception 1. A misconfigured database is the same category of operator error as a
   misconfigured recipient and must not be distinguishable from a crash. The endpoint still never
   migrates: `continuo db migrate` is where a file moves forward (`D-0050`).
4. **The outbox's lease resource is one global delivery lease for lap 1.** This is the scope the
   design left open, and leaving it open would have decided it by accident.
   `docs/production-schema.md` section 4.2's writer table names the single writer of `outbox.status`
   as "**the delivery worker holding the outbox lease**", fenced by `writer_epoch` validated inside
   the write (`docs/production-schema.md:213`). But the outbox row carries **no lease resource
   column**, and neither of the two passes that select rows is scoped to one: `_DUE_QUERY`
   (`src/control_plane/outbox.ts:312`) reads every unfinished row regardless of who is asking, and
   `Outbox.recover` (`:1264`) adopts every unfinished row through `_ADOPT` -- a description of what
   the method does, not of something that happens, since nothing in `src/` calls it; see the adoption
   gap under Consequences.
   `UNOWNED_OUTBOX_QUERY` (`:278`) -- the invariant query, whose whole subject is a row left with no
   owner -- is likewise over all unfinished rows. Section 4.9's phrase "the endpoint's lease is
   per-process" fixes a **lifetime**, not a **scope**, and the two are routinely confused. If several
   per-process resources were admitted, each would hold a live epoch, and one resource's epoch would
   validate a fenced write against a row another resource's holder believes it owns -- the fence
   would be checking that *some* lease is live, which is not what a fence is for. So: one resource,
   globally, for the delivery role on lap 1. Multiple endpoint leases are refused until a later
   design adds either a scope column to `outbox` or a strict recipient predicate to the due and
   recovery passes; that is a schema question and it is not decided here.
   The resource is fixed **by name**: `DELIVERY_LEASE_RESOURCE = "outbox-delivery"` in
   `src/messagebus/endpoint.ts`, and `main()` refuses any other `INTERLOCK_MESSAGEBUS_RESOURCE` at
   startup with exit 2 -- the same code and the same `FATAL:` shape as the missing-env and
   unserved-recipient refusals rule 3 describes. The enforcement is part of the decision rather than
   an implementation detail of it, because a constraint recorded only in a docstring is *described*
   and not *fixed*, and this constraint in particular is invisible in the row shape it governs:
   `writer_epoch` stores a number and not a resource, so two resources whose epochs happen to
   coincide are indistinguishable in an outbox row and a violation of the rule leaves nothing behind
   to find afterwards. The admitted value carries **no run and no recipient**, deliberately -- a
   per-run or per-recipient name would advertise a partitioning of `outbox` that the table does not
   have. The test fixture's old per-run `"messagebus-of-run-1"` (`test/messagebus/_env.ts`) was
   exactly that advertisement, and it goes with the rule: the fixture now imports the constant from
   the product instead of spelling a name of its own.
5. **Lap 1 keeps the stdio child endpoint.** Section 0's premise 1 raises a host application serving
   MCP in-process over localhost, and section 5.1's re-check is explicit about what that costs: the
   isolation that exists today is crude and effective -- one worker, one endpoint process, one
   recipient pinned by `INTERLOCK_MESSAGEBUS_RECIPIENT` read once into `EndpointConfig`, with
   `registry.forRecipient` refusing at startup a recipient no handler serves. `poll` is pinned to
   that recipient, and the module states as a property that a worker cannot pull another recipient's
   queue through this surface. A shared localhost surface destroys the isolating fact, because the
   isolating fact **is** the one-process-per-worker environment; every connecting session would reach
   the same surface and nothing would tell the host which recipient a caller may `poll` or `ack`. That
   makes per-session authorization a blocker of this same change rather than later work. Lap 1 does
   not take that on: the endpoint stays a stdio child, and the shared surface is deferred together
   with the authorization it requires.
6. **`cancelled` is aligned in two deliberately different spellings, and they are not
   interchangeable.** The vocabulary itself gets one home: `OUTBOX_STATUSES`, `OutboxStatus`,
   `TERMINAL_OUTBOX_STATUSES` and `isTerminalOutboxStatus` in `src/control_plane/outbox.ts`, mirrored
   from 0003's `CHECK` and its edge list, in the shape `run_lifecycle.ts:153-186` already uses for
   `RUN_STATUSES` / `RunStatus` / `TERMINAL_RUN_STATUSES`. Then:
   - **The raw-SQL READ queries carry the positive literal.** `UNOWNED_OUTBOX_QUERY` and `_DUE_QUERY`
     are spelled `status IN ('pending', 'delivered')`, character for character as
     `events.ts`'s `ORPHANED_OUTBOX_SQL` (`:1625-1636`) and the stalled-relay query
     (`gates.ts:1283`) already spell it, because SQLite may use a partial index **only** when the
     query's `WHERE` contains the index's own predicate as a term. The complement
     (`status NOT IN ('acked', 'cancelled')`) returns exactly the same rows and loses the index --
     `docs/production-schema.md` section 5.7 says so in as many words, and `events.ts` keeps a named
     index-losing twin precisely because that regression is invisible in the result set.
   - **The fenced-builder WRITE statements are spelled as the negation of the terminal set, generated
     from `TERMINAL_OUTBOX_STATUSES`.** `_COUNT_ATTEMPT`, `_MARK_DELIVERED` and `_ADOPT` go through
     `src/control_plane/lease.ts`'s fenced-statement builder, whose predicate algebra is
     `Predicate = Comparison | IsNull | Conjunction` with the operator restricted to `=` or `<>`
     (`lease.ts:1005`, `:945-949`): it has no `IN` and no disjunction, so the positive form is not
     expressible there at all. That constraint and the right semantics agree, which is why this is a
     decision and not a workaround: a write predicate means "**this row is not finished**", and a
     future *non*-terminal status must stay attemptable, whereas an enumerated positive list would
     silently stop attempting it. Generating the conjunction from the constant rather than writing it
     out means a fifth status added to 0003's `CHECK` is picked up by the writes automatically and by
     the reads only where a human decided it belongs.
   - `Outbox.attempt` recognises **both** terminal statuses and refuses each with its own message; it
     stays a loud `OutboxUsageError`, because a direct caller attempting a finished row is a
     programming error. But that guard runs **once**, and once is not enough. It answers *was this
     message finished when the caller picked it up*, which is a question about the caller; it cannot
     answer *is it finished now*, and gate closure takes the `pending -> cancelled` edge from another
     writer entirely, with `_COUNT_ATTEMPT`'s committed transaction and the pending action row
     standing between the guard and the destination. The effect is the one thing in this module that
     cannot be undone, so `attempt` asks the terminality question a **second** time, immediately
     before `handler.apply()` and beside the fence's own re-read, for the reason the fence re-reads
     there. Stated in the register that comment already uses, because it is not rhetorical here
     either: **the re-read narrows the window and does not close it.** The irreducible residue is the
     pause between the re-read and `handler.apply()`, because no statement of ours runs during it,
     and what makes the residue acceptable is the second half of the guard -- the destination's
     idempotency key, which is exactly the argument the fence already makes for the epoch and is
     written down here rather than left implied. The second refusal is a new exported class,
     `CancelledBeforeEffect`, made durable as an `action` row in `'refused'` before it is thrown, on
     `StaleWriterRefused`'s discipline. It is deliberately neither class it could have reused: not
     `StaleWriterRefused`, because nothing is stale -- the lease is live and the epoch owns the row,
     and calling it staleness would send an operator to inspect lease expiry and holder identity,
     the two things that were fine; and not `OutboxUsageError`, because it is not a caller bug but an
     ordinary race with the human gate, which the design creates on purpose and about which the
     caller could have done nothing differently. `MessageBus.poll`'s post-exception residual test
     admits it alongside the other two, for the same reason it admits them: the row is terminal, so
     the delivery is finished and the batch goes on. Omitting it would have made a guard against one
     unrecorded side effect cost the whole poll batch instead -- a worse outcome than the one the
     guard prevents, and a guard paid for by a larger failure is not a guard.
     `CancelledBeforeEffect` is not on its own, and the shape it sits in is part of the decision.
     There are **two** windows in which the gate can close under an attempt, and the post-effect one
     (the Consequences bullet on the `'refused'` record) throws as well, so the two refusals are
     members of one family: `CancellationRaced` (`src/control_plane/outbox.ts:653`) is the base and
     carries `readonly effectApplied: boolean`; `CancelledBeforeEffect` (`:707`) is the member with
     `false`, and `CancelledAfterEffect` (`:762`) the member with `true`, the latter paired with the
     `'refused'` action row that says the effect is real. A base with a discriminating field beats two
     unrelated classes because **the two readers ask two different questions and neither should have
     to enumerate members to get an answer.** A catch site asks "did this delivery end here?" -- that
     is all `MessageBus.poll`'s residual test needs in order to decide whether to keep building its
     batch, and it is written against the base (`src/messagebus/bus.ts:374`) precisely so that a third
     window, if one is ever found, does not require this line to be found and widened a third time;
     there have already been two. An operator asks the other question -- "did the side effect
     happen?" -- and that one is not rhetorical either, because only its answer decides whether the
     destination's own ledger has to be reconciled against ours. `effectApplied` answers it on the
     instance, without a lookup table of class names and without the answer depending on which
     members this build happens to have.
     `Outbox.recordAck` classifies `cancelled` **before** its "has not been
     delivered" check -- a cancelled-while-pending row has `delivered_at_ms` NULL and would otherwise
     be reported as evidence of a lost delivery record, which is a wildly misleading diagnosis of a
     perfectly ordinary gate closure -- narrows its `UPDATE` from `acked_at_ms IS NULL` to
     `status = 'delivered'`, and on zero rows changed **re-reads** the row to tell a concurrent ack
     from a cancellation that landed between the read and the write from a genuine anomaly. The
     pre-existing check could not close that race, because it read one value and wrote against
     another. `AckOutcome` gains `ackedAtMs: number | null` -- null exactly when the row carries no
     ack, which 0003's `CHECK ((status='acked') = (acked_at_ms IS NOT NULL))` makes a schema fact --
     and a `cancelled` flag; a late ack after cancellation returns
     `{ recorded: false, cancelled: true, ackedAtMs: null }` and is **not** an error, because the
     module's own contract is that a duplicate or late ack changes nothing rather than being
     rejected.
7. **`MessageBus.poll`'s two terminality tests are part of the alignment, and they are above the
   design's floor.** Section 5.1 enumerates four query predicates and then says to treat the four "as
   the floor rather than the list" (line 694). This is that floor being exceeded, and it is recorded
   here as evidence for the framing rather than as an incidental fix: `src/messagebus/bus.ts`'s
   post-snapshot re-read and its post-exception residual test both decided terminality on their own,
   and both knew only `acked`. `due()` reads a list once and the loop then attempts the rows one at a
   time, so every row after the first is attempted against a database that may have moved -- and
   `pending -> cancelled` and `delivered -> cancelled` are edges a **different** writer, the human
   gate, takes without consulting the bus. Left alone, a gate closed mid-batch would have failed the
   whole poll. **A cancelled row is normally finished and is skipped**, exactly like an acked one:
   nobody is owed the delivery of a message whose gate has closed. Both sites now ask
   `isTerminalOutboxStatus` rather than comparing a literal. The reason the design's list missed them
   is worth naming: they live in `src/messagebus/`, so a search of the outbox's SQL does not find
   them.

**Consequences.**

- **`test/messagebus/_env.ts` moves to `createProductionControlPlane` / `openProductionControlPlane`.**
  Production has a foreign key from the rows the fixture writes onto `run`, so the fixture's `run`
  row is now load-bearing rather than decorative. It stays a raw `INSERT`, not a call to `admitRun`:
  `D-0051` makes `continuo run admit` the one legal writer under `src/`, and the scan that enforces
  it is over `src/` alone -- every other production suite in this repository inserts the row
  directly, for the reason `test/control_plane/run-lifecycle.test.ts:110-131` records. The
  behavioural suites on top of it --
  drop/resend/ack, recipient isolation, stale writer -- are **not** rewritten: they assert guarantees
  the production schema also gives, and a suite that had to change to survive a schema swap would
  have been asserting the schema rather than the behaviour.
- **`test/control_plane/outbox.test.ts` stays on the spike fixture.** Its 74 cases are a faithful
  translation of the source suite and `D-0026` makes that translation the durable artifact; a
  three-state database returns identical results under a positive predicate, so nothing there needs
  to move. The new `cancelled` cases are a target-only block on the production fixture, adjacent to
  it rather than merged into it, because a case that cannot exist in the source has no business being
  numbered among cases that do.
- **The existing production-schema, gates and events contracts are the side this change conforms to.**
  Their `cancelled`, gate-cancellation and partial-index tests are unchanged. The new integration is
  the party that had to move.
- **A new row appears in the audit trail, and an operator will meet it.** Rule 6's pre-effect
  re-read cannot catch a cancellation that lands *after* the effect. When one does, `_MARK_DELIVERED`
  -- now conjoined with `status = 'pending'` -- matches no row, and the `allowNoRow: true` this call
  has always passed would have swallowed the miss in silence. The miss is classified instead: still
  `'delivered'` is the deduplicated-resend case `allowNoRow` exists for and stays tolerated; a row
  that is neither delivered nor terminal is a loud `OutboxUsageError`, since a live fence over a
  pending row has no legitimate way to refuse the update; and a **terminal** row is split once more,
  on `delivered_at_ms` -- see the next bullet, which is why that column and not terminality is the
  discriminator. A terminal row with no delivery instant is this attempt's own first delivery
  overtaken in flight, and it **writes an `action` row in `'refused'`, naming the idempotency key the
  effect was keyed with**.

  **The branch does two things, and an earlier draft of this entry got the argument for that wrong.**
  It said recording "beats" throwing, on two counts: that the effect did land, so the attempt
  truthfully succeeded and reporting it as a failure would be the lie; and that a throw would cost
  `MessageBus.poll` the remainder of its batch, charging every other recipient for a race none of
  them were in. **The second count is false, and it is left standing here rather than deleted,
  because a decision record that quietly drops a bad argument teaches a later reader nothing about
  why the code is shaped as it is.** `poll`'s post-exception residual test admits a member of the
  `CancellationRaced` family, re-reads the row, finds it terminal and `continue`s
  (`src/messagebus/bus.ts:374-378`): the batch is not lost, and it was not lost by any version of
  this code that threw a class the residual test admits. So recording and throwing were never
  alternatives to be traded off. They discharge one obligation each, and both obligations are real.
  **The evidence cannot be unmade**, so the `'refused'` row is written first, on `StaleWriterRefused`'s
  discipline -- the effect at the destination is durable and the outbox row has no edge left on which
  to admit it, so the action row is the only place the database will ever say the delivery happened.
  **And the envelope must not be produced** (rule 7), so the branch then throws `CancelledAfterEffect`:
  returning an `AttemptOutcome` normally would have been turned into a `DeliveredEnvelope` by `poll`
  without the row being asked again, handing a worker the payload of a message whose gate has already
  closed -- which is the one thing the whole cancellation alignment exists to prevent. What is left
  over is a message the outbox row will never admit was delivered; the refusal row is the one place
  the database says otherwise, and it carries the run, the action kind, the idempotency key, the
  mechanism and a reason -- which is the whole of what reconciling against the destination's own
  ledger takes.
- **The zero-row branch discriminates on `delivered_at_ms`, not on terminality, and the difference is
  the difference between an audit trail and noise.** An earlier form of this branch treated *every*
  terminal row it found on the re-read as a post-effect cancellation and recorded a refusal. That is
  wrong for the commonest terminal row there is: an ordinary **resend** of a row that was already
  delivered, whose ack lands from the worker while this attempt is in flight, arrives at exactly the
  same place -- `_MARK_DELIVERED` moved nothing (its `status = 'pending'` conjunct), the re-read says
  `acked`, and the terminality-only test called it a lost delivery. The refusal it wrote claimed a
  delivery could not be recorded when the row's own `delivered_at_ms` and its ack said the delivery
  had been recorded and answered. Nothing was wrong, nothing needed reconciling, and a durable
  `'refused'` row was written anyway. Name it for what it was: a fix that would have slowly polluted
  the refusal audit with ordinary traffic, and done it in proportion to how well the system was
  working -- which is the failure mode that makes an audit trail stop being read.
  `delivered_at_ms` is the exact discriminator, and it is exact because
  `migrations/0003_outbox_cancelled_status.sql:99-103` makes it so: the `CASE` constrains the instant
  for `pending` (NULL), `delivered` and `acked` (NOT NULL), and says **nothing** for `cancelled`,
  deliberately, because a cancellation is terminal without being an erasure and a relay cancelled
  after it was sent keeps the instant it was sent at (`:86-97`). So a non-null instant on a terminal
  row means the delivery this statement could not write **is already written**, whoever wrote it --
  that is a resend, and it returns exactly as the `'delivered'` case above it does. A null instant
  means this attempt's own first delivery was overtaken and there is genuinely no record, which is the
  only case that has anything to reconcile and the only case that records. The cancelled half still
  falls through to the throw either way, because "the delivery is already recorded" and "the message
  may be presented" are two questions and 0003 answers only the first.
- **A gate relay is still not deliverable after this change, and the reason is ownership, not
  `cancelled`.** This is the correction the Context paragraph above points at, and it is **verified,
  not suspected**: reproduced on a real production plane at head, with a live `outbox-delivery` lease
  held at epoch 1, a gate opened at `received` and `enqueueRelay` for `presented`. The mechanism runs
  in one line. `enqueueRelay` (`src/control_plane/gates.ts:608-612`) writes its outbox row with a
  hand-written `INSERT` naming seven columns, and `writer_epoch` is not among them, so the row is
  committed **unowned** -- `NULL` is explicitly legal there
  (`migrations/0003_outbox_cancelled_status.sql:66`, `CHECK (writer_epoch IS NULL OR ...)`). The
  event fan-out does the same (`src/control_plane/events.ts:441-445`), which makes an unowned row a
  property of **every outbox producer in this repository except `Outbox.enqueue`**, not a slip in the
  gate path. `_COUNT_ATTEMPT`'s `writer_epoch = :fence_epoch` conjunct
  (`src/control_plane/outbox.ts:455`) is then never true of such a row -- a comparison against NULL is
  NULL, never true -- so `_fenced`, called without `allowNoRow`, sees a zero-row update and raises
  `StaleWriterRefused` **on the first delivery attempt the human gate ever makes**. And it does so
  with a message naming lease expiry and holder identity, both of which are fine; `_fenced` is handed
  the statement already rendered and can only see `changes === 0`, so it cannot tell "the lease is
  dead" from "the row is unowned". That is the same category error rule 6 already refused for
  `CancelledBeforeEffect` ("not `StaleWriterRefused`, because nothing is stale"), reappearing at a
  different site. The one statement that can move a row from unowned to owned is `_ADOPT` (`:535`),
  whose sole caller is `Outbox.recover` (`:1714`) -- and **nothing in `src/` calls `recover`**: not
  `main()` (`src/messagebus/endpoint.ts:597-650`), not `MessageBus.poll`. The blast radius is wider
  than the one relay. `poll` builds its envelope array locally and returns it only at the end, so a
  throw discards the whole batch, `_DUE_QUERY` orders by `enqueued_at_ms`, and one unowned row at the
  head of `due()` therefore re-throws on every pass, **discarding the healthy deliveries queued behind
  it and writing another `'refused'` action row each time**, for as long as it is there. A restart does
  not clear it, because a restart adopts nothing either.
  **This entry does not close that, and the reason is not oversight.** Who stamps `writer_epoch` on an
  outbox row created by a producer that is not the delivery worker is the same family of question as
  step 4's renewal ownership and step 8's composition root, both of which this task's scope fences off
  -- the candidate that would fix it at the source requires the Secretary to hold or read a *live*
  delivery lease at gate-open time, which is step 4's question arriving from the other side. And the
  question is under-determined in the documentation before it is under-determined in the code:
  `docs/production-schema.md:207`'s writer table answers it **two incompatible ways**, giving `outbox`
  (enqueue) as "append, **any producer**, fenced by the `message_id` primary key" while
  `outbox.status` / `retry_count` belong to the delivery worker under `writer_epoch`. `enqueueRelay`
  conforms to the first row; `Outbox.enqueue`'s fenced `INSERT` conforms to the second. Both halves
  are internally coherent and together they contradict, so the gap is **a documented contradiction
  surfacing, not a missing line of code**, and it has to be decided against that table rather than
  around it. Rule 4 fixed the delivery *resource*; the *stamp* is the question rule 4 did not reach.
  Four candidates were identified, costed against each other, and put to the **human gate, which chose
  to implement none of them in this change**: adopt at endpoint startup; adopt inside `poll`; stamp the
  epoch at enqueue; or relax `_COUNT_ATTEMPT` to claim an unowned row. The block **"The four candidates
  for the adoption gap, and what each costs"** below the Consequences list records all four at the
  granularity that lets whoever re-takes this decision skip the investigation. The reason the gate gave
  is the reason the investigation gave against its own recommendation. The candidate this task carried
  into the gate was `Outbox.recover()` in `main()` before serving, and it was carried in **explicitly
  labelled insufficient on its own**: it is the only candidate decidable inside step 5 and it restores
  the recovery criterion at process start, but the relay that matters is enqueued mid-life by a running
  lap while the endpoint is already serving, so shipping it alone would buy a green suite and a still
  unreachable gate, which is worse than the visible failure because it looks like a fix. The gate
  declined to take a partial fix at that price and directed that the gap be **recorded here with its
  cost and solved head-on in a following task**, against `docs/production-schema.md:207`'s writer table
  rather than around it. So the state this entry ships is that block's last table row, the one that
  does nothing: the gate is **not** reachable when this lands, the failure is loud rather than silent,
  and the reason it is loud is written down here rather than discovered again.
- **The fault-injection belt cannot exercise `cancelled` at all, and this entry does not pretend
  otherwise.** Verified here rather than assumed: `test/fault_injection/import-graph.test.ts` permits
  exactly two modules to import `src/` (`ADAPTER_MODULES` = `spike_driver.ts`, `session_driver.ts`),
  and both import `createControlPlane` / `openControlPlane` from `src/control_plane/schema.ts`
  (`spike_driver.ts:102`, `session_driver.ts:69`) -- the spike opener. The spike schema has no
  `cancelled` in its `CHECK` and no gate tables to close, so **the belt has no way to construct a
  cancelled row**. What section 5.1's "re-measure the kill-window evidence" therefore reduces to on
  this lap is a regression check: the belt re-uses `UNOWNED_OUTBOX_QUERY` verbatim as its
  no-unowned-outbox invariant (`spike_driver.ts`'s `INVARIANT_QUERIES`), so turning that constant
  from `status <> 'acked'` into `status IN ('pending', 'delivered')` changes the belt's invariant
  text, and the evidence is that the belt stays green under the new text. A real cancelled-aware
  kill-window measurement requires the belt itself to be moved onto the production schema, which
  means a third adapter or a re-pointed `spike_driver` and a revision of `D-0601`'s two-adapter rule.
  **That is named here as follow-on work and is not done.** Claiming the old evidence still covers the
  new predicates would be the failure this bullet exists to prevent.
- **The endpoint's lease is still not renewed, and step 4 is still open -- and renewal is not the only
  thing left open.** Section 4.9 requires the launcher to hold and renew the endpoint's lease for its
  whole life, and the launcher is the composition root of step 8, which does not exist. This entry
  deliberately does not invent a renewal owner; it fixes the *resource* (rule 4) so that whoever
  eventually renews is renewing one thing. Naming renewal alone used to read as a claim that
  everything else was closed, which it is not: the adoption gap two bullets above is a second open
  item, it is on the same lap, and it differs from renewal in the way that matters for scheduling --
  renewal is waiting on a component that does not exist yet, while adoption is waiting on a decision
  between four candidates that all exist today.
- **Publication.** `package.json` is `private: true` at `version 0.0.0`, so no registry consumer has a
  compatibility claim on this repository yet and nothing here moves a release line; `D-0045`'s
  publication work is a separate change and is not mixed in. Recorded explicitly all the same, because
  it will not be true forever: **"the endpoint stops accepting a spike database" is a breaking change
  in real behaviour terms.** A deployment that pointed the endpoint at a spike file was served before
  this change and exits 2 after it. Had the package been public, this entry would have carried a major
  bump.
- **The scope-of-record moves with the decision, in this change rather than a later one.**
  `parity/source-inventory.belts.md`'s `broker` section changes status from `retarget` to
  **`not-porting` (ratified 2026-09-03, D-0053)**, and the two open decisions its body carried -- the
  `_hostname` / `_clock_ticks` seam question for the collected 54, and whether continuo grows a
  `broker/server.py` equivalent at all -- are replaced by rules 1 and 2, which answer them with
  *different* answers, which is precisely why one status word was the wrong shape for the section.
  The roll-up table follows: the `retarget` row is gone, `not-porting` goes from 167 cases to 221,
  and the effective-target paragraph loses the qualification it used to carry, because 2,194 - 221 =
  **1,973** and all 1,973 are ported. `README.md`'s status line is corrected to say exactly that --
  every subsystem interlock's suite collects is now classified, and no status is still a proposal --
  where it previously described a 2,027 pool containing 54 undecided ids. The stale heading ("4
  further modules not collected" over a body and a manifest that list five) is corrected in passing.
  None of this waits for a tidy-up, because the alternative is a scope-of-record that contradicts an
  accepted decision, and that contradiction is exactly the drift a later reader resolves in the wrong
  direction -- most plausibly by believing the roll-up table, which is the half that is easier to
  read and, here, the half that would be wrong.

**The four candidates for the adoption gap, and what each costs.** This sits here, as its own block
after the Consequences list rather than inside the adoption-gap bullet, for one reason: the comparison
that decided it is a four-axis table, and a table nested inside a list item is indentation-fragile in
exactly the way a record meant to be re-read years later should not be. The bullet above points
forward to this block and this block reports back to it; nothing here is new evidence, it is the cost
sheet the human gate ruled on, written down at the granularity that lets whoever re-takes the decision
avoid repeating the investigation.

The four are not four spellings of one fix. Each answers a *different* question about who owns an
outbox row, and each therefore commits the project to a different thing.

*(a) Call `Outbox.recover()` once in `main()` before serving.* Three lines, no new concept, no ported
module touched; `recover` is already fenced and already covered by the outbox belt (`outbox.test.ts`
covers the successor, the impostor and the report). It commits the project to nothing it has not
already said -- it is what the recovery criterion says should happen at process start, and it puts the
fault-injection belt's no-unowned-outbox invariant back in force on the production side at that one
instant. **It does not fix the relay that matters.** The gate is opened by a running lap while the
endpoint is already serving (section 7 puts the launcher at step 8, ahead of steps 9-10), so the relay
is enqueued *mid-life* and startup-only recovery fixes approximately the case that never happens. This
was the candidate recommended into the gate and **the human gate rejected shipping it alone**, on the
ground the recommendation itself stated: alone it buys a green suite and a still-unreachable gate,
which is worse than the visible failure because it looks like a fix. Where the loud
`StaleWriterRefused` tells an operator the truth, a half-fix would leave the same gate unreachable
with nothing on fire.

*(b) Adopt at the top of every `MessageBus.poll`.* This one does fix mid-life relays -- it is the only
candidate that does so without leaving step 5 -- and the price is parity. `MessageBus` is a **ported
facade** (`parity/messagebus.bus.ledger.json`, complete at 43/43 under rule 2 above), and its `poll`
docstring (`src/messagebus/bus.ts:229-257`) states the current semantics as a property: *"What is due
is read from SQLite and nowhere else."* An adoption pass makes `poll` a **writer of `writer_epoch` on
rows it did not select**, which is a semantic the source facade does not have; every ported case
asserting what `poll` does to the database would then be asserting something about a *different*
function, and the ledger entry would stop describing the source. That is the same shape of change as
the `lease.ts` `IN` node this entry rejects below -- growing a ported module for a caller's
convenience -- one size larger, because it is a new write on a hot path rather than a grammar node.
There is a second, non-parity cost: `recover()` is one `UPDATE` per unowned row, a loop and not a set
update, so putting it at the head of every poll makes the endpoint's **steady-state cost a function of
outbox backlog**, and adopts rows this recipient may never poll. A narrowed form -- adopt only the
unowned rows for *this* recipient that this poll is about to attempt -- is the least-bad single change
that would make the gate reachable on this lap, and it would still have to be taken as an explicit
parity divergence with its own D- entry, never slipped in.

*(c) Have `enqueueRelay` stamp the delivery lease's epoch at enqueue.* Architecturally this is where
the row's owner *should* be decided -- `Outbox.enqueue` already believes that -- and it is **the only
candidate under which a row is never born unowned** -- it does not wait for a poll interval to acquire
an owner. Note the limit of that claim, because an earlier draft of this entry overstated it and the
overstatement is the kind a later reader would act on: stamping a non-null `writer_epoch` does *not*
make `UNOWNED_OUTBOX_QUERY` true at every instant afterwards. That query has two disjuncts
(`src/control_plane/outbox.ts`), and the second one -- `NOT EXISTS` a live lease on the row's epoch --
selects a row whose stamped epoch has since expired, non-null though it is. That is deliberate and is
the invariant doing its job: it is exactly the crash-and-recover case the criterion exists to catch.
So what (c) buys is **initial** ownership, not **continued live** ownership, and keeping the row owned
after that still depends on somebody renewing the delivery lease -- which is step 4 again, arriving
from the other side for the second time in this paragraph. The same qualification conditions (b): a
row adopted inside `poll` is owned until that lease lapses, not forever. It is also **not decidable here.** `enqueueRelay`
(`src/control_plane/gates.ts:542-551`) takes no lease, no epoch and no resource, and runs in the
Secretary's transaction rather than the delivery worker's, so it would have to learn the delivery
lease's identity -- `gates.ts` naming `outbox-delivery` or importing `DELIVERY_LEASE_RESOURCE` from
`src/messagebus/endpoint.ts`, a control-plane module importing the messagebus endpoint, which inverts
the dependency direction and re-opens the import-graph argument -- and, decisively, it would have to
read a **live** delivery lease at gate-open time, since a stamped epoch that is not live is refused
again for a subtly different reason. That makes **opening a human gate fail when the delivery endpoint
is down**, which inverts the outbox's own design, where the queue outlives the worker. That is step 4's
renewal-ownership question arriving from the other side, and answering it inside step 5 would be
deciding step 4 by accident -- the exact failure mode rule 4 was written to prevent. It would also
**delete `docs/production-schema.md:207`'s "any producer" rule** for enqueue and need a new writer-table
row and a D- entry saying so, and it would need the same treatment at the event fan-out
(`src/control_plane/events.ts:441-445`), where "any registered producer" is stated more strongly still.

*(d) Relax `_COUNT_ATTEMPT` to admit a NULL `writer_epoch` (`writer_epoch IS NULL OR = :fence_epoch`).*
The smallest-looking and the most expensive in properties. `lease.ts`'s predicate algebra is
`Comparison | IsNull | Conjunction` (`src/control_plane/lease.ts:1005`) with no disjunction node and a
renderer that throws on anything else, so (d) requires growing the ported builder with an `Or` node --
**the exact change this entry already records as a rejected alternative below**, which would have to be
revisited in writing rather than silently overridden. What it weakens is worse than where it is
written: `writer_epoch = :fence_epoch` *is* the "owned by the writing epoch, not merely written while
some lease is live" property, said in as many words at `src/control_plane/outbox.ts:388-394`, and
admitting NULL means the first live lease to touch an unowned row claims it with no recovery pass
having decided that claiming was safe. Under rule 4's single global resource there is only one
claimant, so on lap 1 it is arguably harmless -- but it is precisely the property rule 4's falsifier
turns on, and it converts a loud refusal into a silent race inside the statement whose own comment
exists to prevent that. It is also **the only candidate that leaves the fault-injection belt's own
invariant false on a healthy database**: the symptom disappears while every fresh gate relay still
violates `UNOWNED_OUTBOX_QUERY`, and `Outbox.recover`'s report becomes decorative on the enqueue path.

The four axes that decided it:

| candidate | fixes mid-life relays | touches a ported module | needs a step-4 / step-8 decision | when `UNOWNED_OUTBOX_QUERY` is satisfied |
|---|---|---|---|---|
| (a) `recover()` in `main()` | **no** | no | no | no -- violated again at the next enqueue |
| (b) adopt inside `poll` | yes | **yes (`MessageBus`, a ported facade)** | no | between polls -- and only while the adopting lease stays live |
| (c) stamp the epoch at enqueue | yes | no, but couples `gates.ts` and `events.ts` to the delivery lease | **yes (lease liveness and ownership)** | at birth -- but only while the stamped lease stays live |
| (d) relax `_COUNT_ATTEMPT` | yes | **yes (`lease.ts`'s grammar)** | **yes (weakens rule 4's fence)** | **no** |
| none (what ships here) | **no** | no | no | **no** |

**And what happens if nothing is done, which is the row this change ships.** The gate stays
unreachable and it stays unreachable *loudly*. The first relay a human gate ever enqueues is committed
unowned, `_COUNT_ATTEMPT` refuses it, and `MessageBus.poll` re-throws `StaleWriterRefused` out of the
whole batch; because `_DUE_QUERY` orders by `enqueued_at_ms`, that one row sits at the head of `due()`
and **poisons every subsequent poll for that recipient, discarding the healthy deliveries queued
behind it and writing another `'refused'` action row on each pass**, and a restart does not clear it
because a restart adopts nothing either. The endpoint surfaces it as an `isError` tool response.
`Outbox.unowned` names the offending row, so the diagnosis is one query away for whoever meets it.
That is the cost of doing nothing, it is worse per-poll than any of (a)-(d), and it was accepted
deliberately in preference to a fix that would have hidden it: **a failure that announces itself is a
better thing to hand the next task than a green suite over an unreachable gate.** The follow-on task
takes the gap head-on, and the first thing it has to settle is not which of (a)-(d) to write but which
half of `docs/production-schema.md:207`'s writer table is the rule -- because, as the adoption-gap
bullet establishes, this is a **documented contradiction surfacing, not a missing line of code**.

**Falsifier.** Four observations would show this entry wrong, and each is evaluable from inside this
repository.

*A second delivery lease resource turning out to be needed on lap 1.* Rule 4 asserts that one global
resource is sufficient because the lap has one delivery role. If a second concurrent deliverer appears
-- a second endpoint for a second worker, most plausibly -- then the global resource serialises them,
and the fix is not to relax rule 4 but to give `outbox` the scope column rule 4 names. The failure
this paragraph used to warn about -- an implementation quietly running two resources against the
current row shape -- is no longer reachable by configuration, because `main()` admits the one
resource name and exits 2 on any other. So the falsifier now bites on a design need rather than on an
accident: a second concurrent deliverer announces itself as an operator meeting a startup refusal,
with the demand for the schema change in the refusal's own message, instead of as a fence that has
silently stopped fencing. Converting the one into the other is what enforcing rule 4 at the boundary
buys.

*A legitimate reader that must see cancelled rows as due.* The positive predicate is the whole
alignment, and it assumes no consumer needs a cancelled relay returned as work. An audit or reporting
path that must enumerate cancelled relays alongside live ones would mean "due" and "of interest" are
two questions rather than one, and would need its own query rather than a widened `_DUE_QUERY` --
widening it would return the index to a full scan and hand `Outbox.attempt` rows the trigger will
abort.

*The adoption gap turning out to be wider or narrower than the bullet describes.* The bullet asserts
three measurable things: that an unowned row is produced by every outbox producer except
`Outbox.enqueue`, that nothing in `src/` adopts one, and that one such row at the head of `due()`
costs the healthy rows behind it on every poll. **Narrower** if a caller of `Outbox.recover` is added
under `src/` and the first gate relay is nonetheless still refused -- that would mean the mechanism is
not the one described and the diagnosis has to be reopened, not merely the fix; or if a producer
turns out to stamp `writer_epoch` after all on a path this reading missed, in which case the "every
producer" claim is too strong and the gap is a `gates.ts` bug rather than a schema-contract one.
**Wider** if an unowned row is ever observed that no candidate can adopt -- for instance one whose
`recipient` no live endpoint serves, which `_ADOPT` will happily claim and no `poll` will ever
retire, making adoption necessary and insufficient in the same way startup-only recovery is. The
first falsifier above also acquires a companion here: if the gap is closed by relaxing
`_COUNT_ATTEMPT` to admit `writer_epoch IS NULL`, rule 4's fence is weakened inside the very
statement rule 4 relies on -- an unowned row becomes claimable by whichever live epoch reaches it
first, with no scope column to say who should have had it -- and that falsifier must be re-read at
that time rather than inherited.

*A residents-registry reader appearing in the port.* Rule 1 rests on the subject being absent, and
section 0's premise 1 makes it less hypothetical than it looks: under a single host application the
agent sessions are **the only other processes in the system**, so "an agent process that outlived the
host, or that no run's binding names" is the one process-identity category the architecture has. **If
the host application grows a reaper for orphaned agent sessions, the subject exists here and this
decline is superseded.** Note what does *not* falsify it: someone porting `residents.py` for its own
sake. The decline is of a belt with no reader, not of an algorithm.

**Rejected alternative: keep the endpoint on the spike database and run gates on a second production
database (section 5.1 option C).** It is the only option that requires no outbox edit, and it is
strictly worse than what was done. `enqueueRelay` writes the `gate_relay` row and the outbox row in
one transaction, and gate closure cancels the relay's outbox row in the closing transaction. Splitting
the databases splits both transactions, so a change that was an outbox edit becomes a
distributed-transaction problem with no coordinator -- or else it relaxes the `received -> presented`
edge, which is the constraint the relay exists to carry.

**Rejected alternative: port the 54 residents cases and keep the five as `retarget` (option B).** The
highest cost of the three and the lowest lap value. It leaves the schema split unresolved, so the
*schema* obstacle to the gate stays in place and step 5 does not get done at all -- note that step 5
getting done is not the same as the gate becoming reachable, per the adoption-gap bullet; it requires
inventing the registration half of a protocol nobody has used; and the reap rule it would land
contradicts `src/supervisor.ts:699-703`. A port whose first act is to install a rule the existing supervisor refuses is not a port.

**Rejected alternative: extend `lease.ts`'s fenced-statement builder with an `IN` node so the write
statements can carry the positive predicate too.** Superficially the tidier answer -- one spelling
everywhere. It is rejected on two independent grounds. The builder is a faithful port with its own
suite, and growing its predicate algebra is a change to a ported subsystem made for the convenience of
a caller, which is the shape of change this repository's translation conventions exist to prevent.
And it would be tidier in the wrong direction: the two spellings are not an inconsistency to be
removed, they mean different things. The read asks "which rows are live" and must name them so the
index applies; the write asks "is this row unfinished" and must stay true of a status nobody has
invented yet.

**Rejected alternative: make a late ack of a cancelled relay an error.** It is defensible -- the ack
answers a question that was withdrawn -- and it contradicts the module's own contract, which is that a
duplicate or late ack changes nothing rather than being rejected. It would also make a routine race
into an operator-visible failure: a human answering a gate at the instant it closes is exactly the
timing gate cancellation creates, and there is nothing for an operator to do about it. Rule 6 reports
it truthfully instead -- `recorded: false`, `cancelled: true`, no ack timestamp, because the schema
guarantees a cancelled row carries none.

**Status.** accepted

**Source.** Human gate, task `continuo-lap1-endpoint-production-repoint`, on
`docs/design/minimal-operating-loop.md` section 5.1 (recommendation A, taken as written) and section
7 step 5; rules 4 and 5 were settled at the gate from a pre-implementation design review that raised
both as blockers, and this entry records them. Step 4 (the endpoint's lease renewal, section 4.9) is
deliberately not in scope: its implementing component is the composition root of step 8, which does
not exist yet. Decision id from the `D-0019`..`D-0099` shared band, next after `D-0052`, which the
parallel task `continuo-test-timeout-scale` took on `origin/main` first.

Three things in this entry post-date the gate and are recorded in place rather than as an addendum,
which is the house form -- but a later reader should know which they are and why they exist. Rule 4's
enforcement point, rule 6's second terminality check in front of the effect, and the `'refused'`
record of a cancellation that lands after the effect were all added in response to an independent
model's review of the implemented diff, which raised the first two as blockers. The design as gated
fixed the delivery resource without saying who would enforce it, and asked the terminality question
once because the second asking is visible only from inside the implementation. That is worth knowing
because it says what kind of review found them: reading the code against the rule, not reading the
rule.

A fourth thing post-dates the gate and is the reason for the adoption-gap bullet, the four-candidate
block and the fourth falsifier: an independent review of the implemented diff found, and a probe on a
real production plane at head confirmed, that a gate relay is enqueued with `writer_epoch = NULL` and
that nothing under `src/` adopts it, so **the human gate is still not reachable when this lands**. The
four candidates were costed and escalated, and the human gate ruled: **implement none of them in this
change; record the gap with its cost and take it head-on in a following task.** The gap is therefore
not an oversight that nobody noticed -- it was found, reproduced, investigated, escalated and left
open deliberately, and what this entry adds is the cost of leaving it open, written down where the
next task will read it.

## D-0054 -- `writer_epoch` on `outbox` is delivery-side ownership, not producer provenance: the delivery worker adopts one row immediately before it attempts it

**Context.** `D-0053` shipped the endpoint onto the production schema and, in the same entry, recorded
that the human gate was still unreachable: a relay `enqueueRelay` appends carries no `writer_epoch`,
`_COUNT_ATTEMPT` asks that the attempting epoch *own* the row rather than merely be live, and so the
first relay a gate ever enqueues is refused as `StaleWriterRefused` by the one component that exists
to deliver it -- forever, at the head of `due()`, poisoning every subsequent poll for that recipient.
That entry set out four candidates, ruled on none of them, and said which shape the answer would have
to take: *"A narrowed form -- adopt only the unowned rows for this recipient that this poll is about to
attempt -- is the least-bad single change that would make the gate reachable on this lap, and it would
still have to be taken as an explicit parity divergence with its own D- entry, never slipped in."*
This is that entry.

`D-0053` also identified what has to be settled *before* the code: **which half of the writer table is
the rule.** `docs/production-schema.md` §4.2 carried two outbox rows that cannot both be true --
`outbox` (enqueue) is "any producer", while `outbox.status` / `retry_count` is "the delivery worker
holding the outbox lease". The second is false as written and was false before this task: gate closure
moves `pending`\|`delivered → cancelled` from inside the closure transaction with no delivery fence
(§9.4), and the ack moves `delivered → acked` from the recipient-bound path deliberately unfenced
(`D-0053` rule 6). So the contradiction is not between the two rows; it is inside the second one,
which names one writer for four transitions that have three writers between them.

**Decision.**

*1. The column's meaning is fixed, and it is the one the enqueue row implies.* `writer_epoch` on
`outbox` is **the current owner of the delivery-side mutations** -- the retry increment and
`pending → delivered` -- and **not** a record of which producer appended the row. A producer appends
with the column null. It is nullable in `0001_initial.sql` precisely so that it can be, and the
enqueue row's "any producer" is therefore the rule: a queue that only accepts work while a delivery
worker happens to be alive is a queue that does not outlive its worker, which inverts what an outbox
is for.

*2. The writer table is corrected by splitting the losing row, not by deleting it.*
`docs/production-schema.md` §4.2 now carries four outbox rows -- enqueue (any producer, `message_id`
PK, `writer_epoch` left null); adopt / `retry_count` / `pending → delivered` (delivery worker, live
outbox lease **and** matching `writer_epoch`, inside the write); `delivered → acked` (the
recipient-bound ack path, set-once trigger and status predicate, unfenced); and
`pending`\|`delivered → cancelled` (the gate-closure transaction, `gate_relay` membership and the
forward-only trigger). The old row is quoted in the prose beneath the table together with the reason
it lost, because the claim was not a typo: it was reaching for something real -- the two transitions
that *are* the delivery worker's -- and a deletion would leave the next reader to rediscover both the
error and the part of it that was right.

*3. `Outbox.adoptIfUnowned(messageId, {nowMs, epoch})` adopts exactly one row.* Its candidate
predicate is `UNOWNED_OUTBOX_QUERY`'s, character for character, with `message_id = :message_id` added:
non-terminal, and either `writer_epoch IS NULL` or no live lease on the resource carries the row's
epoch. The write is `_ADOPT`, unchanged and still fenced, so an adopter whose own lease is dead
changes no row. The read and the write are **one transaction** (`withImmediate`, joined rather than
nested when a caller already holds one): apart they are check-then-write, and `_ADOPT` carries no
ownership predicate, so the window between them is one in which this call takes a row away from
another live worker with nothing downstream to catch it. The method returns whether it adopted, and
`false` is an ordinary answer -- the row already had a live owner (including this epoch, on the second
poll of the same message), a gate cancelled it in the last instant, or the caller's lease is dead.
Nothing is recorded on `false`: an attempt that deserves a refusal gets a loud one from `attempt`'s own
fenced statements a moment later, and a refusal row written here would be an audit entry for a
delivery nobody had yet tried to make.

*4. `MessageBus.poll` calls it once per message, after the recipient filter and the terminal re-read,
immediately before `attempt`.* All three positions are load-bearing. **After the recipient filter**,
because a poll's authority is one recipient's queue: `Outbox.recover` adopts every unowned row for
every recipient, and calling it here would have this endpoint own rows it cannot deliver and walk the
whole backlog on every pass, making steady-state poll cost a function of outbox depth. **After the
terminal re-read**, because handing a live owner to a finished row is the adopt-forever failure
`Outbox.recover`'s own note describes. **Before `attempt`**, because that is the statement the
ownership is for. Adoption shares the attempt's instant rather than sampling the clock a second time:
two reads straddling an expiry would let a poll adopt under an epoch its own attempt then finds dead.

*5. This is a target-only divergence from the source facade, and it is recorded as one.* `poll`'s
docstring states *"What is due is read from SQLite and nowhere else"*, and that sentence survives
intact: adoption is **not** a source of due-ness. It discovers nothing, adds nothing to the batch and
reorders nothing -- `_DUE_QUERY` alone decides which rows the loop sees and in what order -- it changes
only whether a row SQLite already returned can be advanced by this epoch. What it *does* add is a
write the source's `poll` does not make, on a ported facade whose ledger is complete at 43/43. **No
existing parity entry or disposition changes**; the five new cases are declared in
`parity/messagebus.bus.ledger.json` as `target_only_tests`, which is the mechanism this repository
already uses for behaviour the source could not have carried.

*6. Nothing else moves.* `lease.ts`'s predicate grammar is untouched (`_COUNT_ATTEMPT`'s ownership
conjunct is the property, not the obstacle). `enqueueRelay` and the event fan-out are untouched, and
keep appending without an epoch. `Outbox.enqueue` keeps stamping, because its callers are delivery
workers that already hold the lease; only its docstring's claim that *every* outbox row is owned from
birth is corrected, since the table never held it. No lease is acquired or renewed anywhere on this
path, no lease row is read to mint a token, and no recovery loop or renewal timer is added to the
endpoint -- those are step 4 and step 8, and `D-0053` rule 4's warning about deciding them by accident
applies to this entry as much as to that one.

**Alternatives.** The four candidates are `D-0053`'s, set out in full there with a four-axis cost
table. They are not repeated here; what this section records is the ruling, because `D-0053`
deliberately made none.

*(a) Call `Outbox.recover()` once in `main()` before serving.* **Rejected, as it was there.** The gate
is opened by a running lap while the endpoint is already serving, so the relay that matters is
enqueued *mid-life* and startup-only recovery fixes approximately the case that never happens. It
would buy a green suite over a still-unreachable gate, which `D-0053` judged worse than the visible
failure -- and this entry has no reason to disagree, because the case that fails on `origin/main`
here is exactly a mid-life enqueue.

*(b) Adopt inside `MessageBus.poll`.* **Taken, in the narrowed form `D-0053` names**: not a pass over
the unowned set at the top of the poll, but one row -- the row this iteration has already decided to
attempt -- after the recipient filter and the terminal re-read. The broad form was rejected on two
grounds this entry keeps: it takes ownership of rows the polling endpoint has no authority to deliver,
and it makes steady-state poll cost a function of outbox backlog. Its price, paid openly, is the
parity divergence rule 5 registers.

*(c) Have the producers stamp the delivery lease's epoch at enqueue.* **Rejected.** It is where a
row's owner architecturally *should* be decided, and it is still not decidable here: `enqueueRelay`
would have to learn the delivery lease's identity -- inverting the dependency direction between the
control plane and the messagebus endpoint -- and read a *live* one at gate-open time, which makes
opening a human gate fail when the delivery endpoint is down and inverts the outbox's own design,
where the queue outlives the worker. That is step 4's renewal-ownership question answered by accident.
This task added one argument `D-0053` did not have: the event spine's delivery fan-out appends unowned
rows for the same reason, so (c) is not one change but two, in two modules, each acquiring a delivery
dependency it has no other use for -- and the target-only case for the fan-out is what makes that
concrete rather than predicted.

*(d) Relax `_COUNT_ATTEMPT` to admit a null `writer_epoch`.* **Rejected.** `writer_epoch =
:fence_epoch` *is* the "owned by the writing epoch, not merely written while some lease is live"
property; admitting null deletes it, so the first live lease to touch a row claims it with nothing
having decided that claiming was safe. It also needs a disjunction node in `lease.ts`'s ported
predicate grammar, which `D-0053` already records as a rejected alternative in its own right. Adoption
reaches the same delivered row while leaving the fence exactly as strong, and the dead-epoch case
above is what holds that claim to account.

*Doing nothing, which is what `D-0053` shipped.* **No longer available**, and that is this entry's
whole occasion: the failure announced itself loudly, as intended, and the follow-on task it was
handed to is this one.

**Consequences.**

- **The gate is reachable.** A relay a gate enqueues is delivered by an ordinary poll with nothing in
  front of it, and `test/messagebus/messagebus.test.ts` drives exactly that on the production schema:
  live lease at epoch 1, `enqueueRelay`, an asserted `writer_epoch IS NULL` precondition, one `poll`,
  then envelope, destination effect, `retry_count = 1`, `status = 'delivered'`, `writer_epoch = 1`, and
  no refusal row. Four of the five new cases fail on `origin/main`.
- **Both producers are fixed by one change.** The event spine's delivery fan-out appends unowned rows
  for the same reason `enqueueRelay` does, and has its own case. This is the strongest argument
  against candidate (c): a fix that taught one producer to stamp an epoch would have left the other
  exactly as broken.
- **The blast radius is pinned, not assumed.** One poll over an oldest unowned relay and a younger
  healthy row delivers **both** -- asserted as one equality over the batch, because the unowned row
  sits where a throw would discard every envelope built behind it -- and leaves no refusal row, and the
  healthy row keeps the epoch it already had.
- **`UNOWNED_OUTBOX_QUERY` is satisfied between polls, not at birth**, which is the row `D-0053`'s
  table gives candidate (b), and the qualification that table attaches to (b) and (c) alike still
  holds: ownership lasts while the adopting lease stays live, and keeping it live is step 4.
- **The fault-injection belt's invariant is unchanged in force and in meaning.** It forbids an unowned
  row *after recovery* -- a postcondition of `Outbox.recover` -- and a freshly appended relay awaiting
  its first poll was never what it was about. What was wrong was the enqueue docstring reading that
  postcondition as a claim about the instant of the insert.
- **The loud failure `D-0053` deliberately preserved is preserved.** A poll under a dead epoch adopts
  nothing, delivers nothing, causes no effect and records exactly one refusal -- the behaviour a stale
  poll had before this line existed. That case is green on `origin/main` too, on purpose: it pins that
  the fix did not buy delivery by weakening the fence.

**Falsifier.** Three observations would show this entry wrong.

*More than one delivery resource, or a `outbox` partitioned by recipient or worker.* Adoption here
takes ownership on behalf of *the* delivery lease, singular, exactly as `D-0053` rule 4 assumes. The
per-message narrowing means a second deliverer would not have its rows stolen wholesale, which is why
this is safer than a sweep -- but the resource is still global, and the moment `outbox` grows a scope
column or a second resource is admitted, "the row's epoch is live on this resource" stops being the
same question as "somebody is entitled to deliver this row", and adoption has to be re-derived against
whatever the partition is.

*Ownership being required before the poll rather than at it.* The whole design rests on ownership
being needed only by `attempt`, so acquiring it one statement earlier is sufficient. If anything comes
to depend on a due row having a live owner *while it waits* -- a dashboard reading `writer_epoch` as
"who will deliver this", an alert on `Outbox.unowned` firing on healthy backlog, a scheduler assigning
rows to workers in advance -- then adoption at attempt time is too late by construction, and the answer
moves toward candidate (c) with the step-4 question that comes with it.

*A second writer of `writer_epoch` on the delivery path.* Rule 1's meaning holds only while the
delivery-side mutations have one owner at a time. A component that stamps the column for any other
purpose -- attribution, routing, an audit of who appended -- makes the column mean two things, and the
first symptom would be an adoption that is correct by rule 1 overwriting something a second reader
depended on. `_ADOPT` carrying no ownership predicate is what makes that overwrite silent.

**Status.** accepted

**Source.** Human gate, task `continuo-102-adoption-gap`, Issue `#102`. The candidate set, the four
axes and the instruction that the narrowed (b) be taken as an explicit parity divergence are
`D-0053`'s, under **"The four candidates for the adoption gap, and what each costs"**; the
Alternatives section above reports which of them this entry takes and which stay rejected. Decision id
from the `D-0019`..`D-0099` shared band, next after `D-0053`.
---

## D-0055 -- The lap's execution intent is fixed at admission as `LapRunIntent`, written with the run in one transaction, and carries no authority

**Context.** `docs/design/minimal-operating-loop.md` section 6.3 places the delegation record in
continuo rather than in cadenza's G2, and step 6 of section 7 asks for it. `D-0051` had already
built the writer it belongs to: `continuo run admit` inserts the `run` row and appends `run_created`
in one transaction, and refuses a second admission of one identifier. What was missing was any
durable statement of what a run was admitted **to do** -- section 4.6's finding, that the instruction
reaches the child as an untyped `settings.prompt` string and is persisted nowhere, so a run row says
that work exists and nothing anywhere says what it is.

Section 6.3 also contained a contradiction that had to be resolved before anything could be built.
It says the record is produced by the admission command at L1, while section 7's step 7 has the
workspace materialised later, at L2 -- which leaves open whether the record is a statement fixed at
admission or a row the later step comes back and completes.

**Decision.**

1. **The record is an intent fixed at admission, not a document that is later updated.**
   `LapRunIntent` (`src/control_plane/lap_run_intent.ts`) is constructed once, validated by its
   constructor, frozen, and persisted as an event payload. Nothing writes it again. What comes after
   admission -- the workspace that was actually created, the commit a base branch resolved to, the
   session that was spawned -- is a **later fact in a later event**, produced by the task that
   observed it, never a correction of this one. That is the spine's own rule
   (`event_rows_are_immutable`: "correct a fact with a new event"), applied to the record that lives
   on it rather than re-decided for it.

   The field this settles most visibly is `workspace`. It is **not** "the workspace that exists"; it
   is the path this lap has *chosen* to materialise into. At admission the directory typically does
   not exist, and the record makes no claim that it ever will.
2. **`run admit`'s required arguments are extended; there is no `run delegate` verb.** The record is
   an argument of admission, and `admitRun` takes it whole. A second verb would make "admitted but
   never delegated" a reachable state, and it is one an operator cannot recover from: `D-0051` rule 4
   refuses a second admission, so the run cannot be re-admitted and the intent cannot be attached
   after the fact. One verb makes the incomplete state unrepresentable instead of making it
   recoverable.
3. **The run row, `run_created` and `run_delegation_recorded` are written in the existing single
   transaction, in that order.** The atomicity `D-0051` rule 3 established is extended rather than
   duplicated. An admission that committed the run and its cause and then failed to append the
   intent would leave L1 half done, and the missing half is the one nothing downstream can
   reconstruct. The order is a decision, not an artifact: both events carry the same `nowMs`, so
   `seq` is the only thing that orders them and `seq` is what a draining consumer sees. A run's first
   event must be the one that says the run exists, or the intent arrives as a statement about a
   subject the reader has no record of.
4. **One event type is added: `run_delegation_recorded`.** Not extra keys in `run_created`'s payload,
   which would grow an event meaning "a row exists" into the carrier of a work statement and make
   every later reader of `run_created` ask which of the two it was handed. The word says `recorded`
   rather than `delegated` because nothing is delegated at admission -- no worker is spawned, no
   workspace exists, no lease is taken; what happened is that the intent was written down.
   `EVENT_TYPES` gains exactly one line, with its producer, per `D-0051` rule 5.
5. **The record carries no authority, and the naming is the mechanism.** The field is
   `leaseClaimantId`, not `holder`, `owner` or `principal`: the string's whole meaning is the value
   the lease will be taken under, and a lease's exclusivity comes from the database's epoch rule and
   not from the word. Only the adapter that eventually calls the orchestrator spells it `holder`, and
   that spelling stops at the lease call. No `Authority`, `Principal` or `DelegationContract` name
   appears, and no union, permission list or scope field is added in anticipation of G2. This record
   is **superseded** by G2, not promoted into it.
6. **Construction is validation, and the type is nominal.** `LapRunIntent` carries a private field,
   so a plain object of the right shape does not satisfy it in TypeScript and there is no way to
   obtain one except through the constructor. `admitRun` therefore keeps no field rules of its own --
   there is no second place a rule could be written and drift from the first -- and checks only that
   what it was handed is an intent at all. `D-0051`'s printable-ASCII rule for `run_id` moves here
   with the field, unchanged in substance; the class of the resulting error changes from
   `RunAdmissionUsageError` to `LapRunIntentUsageError`, both outside the `ControlPlaneRefusal`
   family, so a malformed field still escapes with its stack rather than being flattened into one
   operator-facing line.

**Each field's consumer and provisionality, which is the part section 6.3 got wrong.** The document
said the field list "is read off `StartRequest`". It is not: `StartRequestFields` is `sessionId`,
`workspace`, `role` and `settings` and nothing else, so of the seven fields exactly two are
`StartRequest`'s. The sentence created a dependency the code does not have -- that an S1 promotion
moves the record as a unit -- when each field's provenance is its own. The correction is made in the
design document itself; the table is here.

| Field | Direct consumer | How provisional |
|---|---|---|
| `runId` | `admitRun`: the `run` row, and both events' `subject_id` / `run_id` | Settled. Not a `StartRequest` field at all. |
| `leaseClaimantId` | `SessionOrchestratorOptions.holder` -> `acquireRunLease`'s `holder` | The lease layer is settled; the **name** is lap-scoped and superseded by G2. Never reaches a `StartRequest`. |
| `workspace` | `StartRequest.workspace` | One of the two genuine `StartRequest` fields. S1 is provisional scaffold (5.5), so the *carrier* can move; the value's meaning -- chosen, not created -- is this entry's. |
| `role` | `StartRequest.role` | The other genuine `StartRequest` field. Same provisionality. |
| `prompt` | `StartRequest.settings["prompt"]`, read by `claude_cli_provider.ts` | Twice removed: not a `StartRequest` field, and read out of an opaque bag by a provider S1 calls scaffold. The most likely of the seven to change shape. |
| `cliArgs` | `StartRequest.settings["cli_args"]`, read by `claude_cli_provider.ts` | As `prompt`. Provider-specific in a way the others are not. |
| `baseBranch` | **none in `src/`** | A forward declaration. Section 7 step 7 requires a base branch be recorded rather than an arbitrary ref, and this is where it is recorded; the task that resolves it to a commit reports that in its own event. |
| `topicBranch` | **none in `src/`** | As `baseBranch`. The operator's publish step (7.11) is its first reader. |

**Consequences.**

- **`continuo run admit` now takes seven required flags rather than one.** `--run-id`,
  `--lease-claimant-id`, `--workspace`, `--role`, `--base-branch`, `--topic-branch` and `--prompt`,
  plus a repeatable `--cli-arg`. Every one is required because a partially-stated intent is the thing
  decision 1 exists to prevent; there is no default, because a default for any of these is a guess
  about the work being asked for.
- **`--cli-arg` values that begin with a dash need the `--cli-arg=VALUE` form.** argparse, which
  `cli/parser.ts` reproduces, will not consume a following token that looks like an option. Most
  arguments a worker's CLI takes begin with a dash, so this is the ordinary case rather than an edge
  one. It is argparse's own escape and is pinned by a test rather than worked around.
- **The field rules differ by field, deliberately.** `run_id` is printable ASCII because it is
  printed back verbatim (`D-0051`). `prompt` is held to nothing but non-emptiness, because it is
  prose and this organization writes prose in Japanese -- `docs/cli-output-policy.md` governs what
  continuo *authors*, and says in as many words that values it receives from outside "may of course
  be non-ASCII". The remaining fields -- and each element of `cliArgs` -- refuse control
  characters only: a branch name or an argv element that ends a line is a value no later report can
  quote back as the string the database holds, while a non-ASCII role or workspace path is ordinary
  here. An empty string stays a legal `cliArgs` element, because an empty argv element is legal and
  refusing it would be a rule this record invented.
- **`workspace` must be fully qualified.** The one shape rule imposed on a path, and it follows from
  the record being durable: the value is read back by a different process whose working directory is
  its own, so a path whose meaning depends on who reads it is one this record cannot fix.
  `isAbsolute` alone is **not** that rule on Windows -- `path.win32.isAbsolute("\worktree")` is
  `true` and the path is still drive-relative, so admission on `D:` and a materialise step on `C:`
  would read one recorded string as two directories -- so the check is the path's *root*: a drive
  letter or a UNC share on `win32`, and `isAbsolute` alone on POSIX, where the two cannot disagree.
  Being resolvable is all that is checked -- the path is not normalised, and its existence is not
  tested. Normalising would mean the record holds a string the operator did not type, and stat'ing
  would make admission depend on a filesystem state that decision 1 says does not exist yet.
- **The payload is `json.dumps(..., sort_keys=True)`, in the schema's `snake_case`.** It is a parity
  surface: the differential oracle compares stored TEXT, so `pythonJsonDocumentSorted` is used rather
  than `JSON.stringify`, and a Japanese prompt is stored ASCII-escaped exactly as CPython would write
  it. The run identifier is **not** in the payload -- `run_created`'s payload names no run either;
  `subject_id` and `run_id` are the columns the per-run indexes are built on, and a copy would be a
  second answer to which run an event is about.
- **No consumer is registered for `run_delegation_recorded`.** As with `run_created` (`D-0051`), the
  append fans out to nobody, and `D-0046`'s falsifier about the consumer indirection having no reader
  on the lap remains live and is not resolved here.
- **`D-0051` is extended, not superseded.** Every rule it states still holds. This entry adds a
  second event to the same transaction and moves one validation rule to the type that now owns the
  field.

**Falsifier.** A field of this record that a later step must legitimately *change* rather than
restate. That would mean decision 1 is wrong -- that this is a mutable delegation document after all
-- and the fix would be a second event type plus a reader that folds the two, not a setter. Also: a
workspace an operator must give relatively, or a `base_branch`/`topic_branch` whose eventual consumer
needs a shape this record does not check (a resolved sha, say, rather than a ref name); either would
mean the field's rule was decided before its reader existed and should be re-decided with it. And if
cadenza's G2 arrives and the sensible move is to *promote* this type rather than supersede it, then
decision 5's whole premise -- that a lap-scoped work statement and an authority model are different
subjects -- was wrong, and the entry should be superseded rather than quietly widened one field at a
time.

**Rejected alternative: a separate `run delegate` verb.** It is the shape that keeps `run admit`
unchanged, and decision 2 rejects it on a concrete failure rather than on taste: admit-then-delegate
has a middle state, and `D-0051` rule 4 makes that state unrecoverable, because the run cannot be
re-admitted and there is no path that attaches an intent to a run already on the table.

**Rejected alternative: carry the record inside `run_created`'s payload.** It avoids adding to
`EVENT_TYPES` and keeps the transaction at two writes. Rejected on decision 4's grounds: the two are
facts about different subjects, and the cost lands on every future reader of `run_created` rather
than on this change.

**Rejected alternative: an interface plus a validating factory function.** Structurally simpler, and
it loses the property decision 6 is built on: a caller could construct the interface directly, so
`admitRun` would have to re-validate, and the field rules would exist in two places.

**Status.** accepted

**Source.** Human gate, task `continuo-lap1-delegation-record`, on
`docs/design/minimal-operating-loop.md` section 6.3 and step 6, and against `D-0051`. Decisions 1-5
were settled at the gate ahead of the work -- including the resolution of section 6.3's L1/L2
contradiction in decision 1 -- and this entry records them; decision 6 and the field rules are the
implementation's. Decision id from the `D-0019`..`D-0099` shared band, next after `D-0054`. This entry was written as `D-0054` and re-taken on rebase: the parallel adoption-gap task claimed that id and merged ahead of it, under the band's first-merged-wins rule.

---

## D-0056 -- The report ingress reads the transcript: the provider gains a terminal-report read API, and the escalation event and its gate are written in one transaction

**Context.** `docs/design/minimal-operating-loop.md` section 4.7 is the one seam in the lap with no
mechanism at all rather than a mechanism with no mouth. The MCP endpoint exposes `poll` and `ack` and
nothing else; S1 forbids the provider a delivery verb and says so as a property
(`src/session/provider.ts`). So the only write a worker can make into the control plane anywhere in
the successor stack is `ack(message_id)` -- one bit per message it was already sent. Meanwhile
`openGate` requires the escalation event to be on the spine already, and its own docstring says the
party that observed the escalation is the party that appends it. Nobody could observe one. Section 7
step 9 is that gap, and its stated purpose is to unblock `openGate`, "which cannot fire without a
prior event".

Section 4.7 lists three ways to close it and calls the choice "genuinely open", recommending the
first without deciding it. This entry decides it, and decides the four sub-questions the design left
to the implementation: where the read API lives, what the ingress does with an ambiguous report, which
event type it appends, and how the event and the gate come to be one fact.

**Decision.**

1. **The transcript is read.** The orchestrator reads the child's terminal `result` line and appends
   a `worker_escalation_raised` event. Section 4.7's option 1, taken as a decision rather than left
   as a recommendation. It needs no new transport and no new tool, it uses an artifact the provider
   already writes on every turn, and it adds no path on which a worker that forgets to call something
   loses its report -- which options 2 and 3 both do, from opposite directions. The endpoint's
   two-verb contract is untouched, and so is its stated "nothing here pushes" posture.

   **The limitation, stated rather than discovered later:** this works because lap 1's worker is
   turn-shaped. A report exists only when a turn has ended. **If mid-turn escalation is ever needed
   -- a worker that must ask a question and then keep working -- option 2, an MCP `report` tool, is
   the intended successor, not a widening of this one.** That is a decision when it is taken, because
   section 4.7 records that it reverses the endpoint's posture in one direction; this entry does not
   pre-approve it.

2. **The judgement is deterministic, and it is the ingress' rather than the provider's.** An
   identity-confirmed, non-blank, non-error terminal report is **always** a publish-approval
   escalation. There is no prose classification: nothing greps the worker's words for "approve" or
   "permission". Four shapes are refused rather than absorbed, as observation or execution failures:
   `is_error` set, no body, a body that is blank or not a string, an identity that does not reconcile,
   and no `result` line at all.

   **"Identity-confirmed" has two halves, and both are checked.** The provider's read-back proves the
   *transcript* belongs to the session. It cannot prove the *session* belongs to the run, and the
   ingress' `runId` is a caller's argument while the payload's `session_id` has no foreign key -- so
   a stale or transposed identifier would make one worker's question a gate on a run that worker
   never touched. The `session` table is the authority that says otherwise, so the ingress reads the
   binding inside its own transaction and requires it to exist, to name this run, and to be at
   `binding_phase = 'identity_confirmed'`. That third condition is the durable record that a
   read-back actually happened and committed; accepting a report at `spawned` would take on trust
   exactly what `D-0027` says exit 0 is not evidence of.

   **Blankness is decided by one predicate on both sides of the hand-off.** The provider strips with
   `pyStrip` and so does the ingress. `String.prototype.trim` is not the same function -- `U+FEFF` is
   blank to JavaScript and not to Python, `U+001C` the other way round -- and two predicates at the
   two ends of a structural hand-off means a report the provider returns as reportable can be refused
   as blank on arrival. That is an escalation lost precisely at the seam, and it is why
   `src/control_plane/` takes its first import from `src/fencing/` here.

   **The limitation this admits:** lap 1 therefore cannot distinguish an ordinary completion from an
   escalation. Every finished turn that wrote prose opens a gate. **Telling the two apart requires an
   explicit structured discriminator in the terminal output** -- a field the worker sets, not a
   sentence a reader interprets -- and lap 1 does not have one. Making the gate's existence depend on
   how a model happened to phrase itself is the failure this refuses; opening a gate that did not need
   opening is the cost it accepts, and a person is present throughout by the lap's own definition.

3. **No event type is added.** `worker_escalation_raised` has been in `EVENT_TYPES` since the
   vocabulary was named and is exactly this L4 fact; `gate_type = 'worker_escalation'` is already one
   of the four the `gate` DDL admits. `EVENT_TYPES` is not edited by this change.

4. **The provider gains an explicit read API rather than the wire format being re-implemented.**
   `ClaudeCliSessionProvider.readTerminalReport` is `@internal` (`D-0101`), beside `childOf` and
   `heldSessionIds`. The alternative was for a composition root to open the transcript itself, and
   what it would have had to reproduce is not a path: the state root's layout, the zero-padded
   generation in the file name, the complete-lines-only rule, the choice of the **last** `result`
   line, and the C2 identity read-back. Every one of those is a rule with a reason, and the second
   copy is the one that goes stale. The three rules two readers now share -- last-result selection,
   the read-back, the mismatch scan -- are extracted as functions so `#readout` and
   `readTerminalReport` cannot answer differently about one file.

   The four questions section 4.7 left open are answered there: **multiple `result` lines** -- the
   last wins, the readout's own rule; **an empty body** -- a typed "no report" answer carrying the
   reason, not an `Ok(null)`, which `R4` forbids; **an error result** -- reported with `isError` set,
   because the provider observes and the ingress judges; **generations** -- only the record's current
   generation is read, so a resumed session answers about the turn it is on.

   **Whether to poll again is a field, not a sentence.** `NoTerminalReport.pending` is `true` only
   for a live child that has not finished. A caller that had to read the diagnostic `reason` to
   decide whether to retry would be parsing a message for control flow -- the same mistake decision 2
   refuses when it declines to classify the worker's prose -- and would poll forever, or stop early,
   the first time the wording changed.

   **A missing `result` line is two different answers, and the verb distinguishes them.** "Not yet"
   and "not ever" look identical on disk, so the verb consults `#childLiveness`: a live child gets
   the typed "the turn has not ended" and a caller that polls again; a child that is gone without a
   terminal line gets a `Failure`, because no report can arrive on that generation and answering
   "not ended" would leave an ingress polling forever. A complete unparseable line is likewise a
   `Failure` rather than a step-over -- `#readout` never drops one silently, and the line that could
   not be parsed may be the very event that would have named the identity.

5. **The event and the gate are written in one transaction, and no new gate-open primitive is
   built.** A crash between an event that committed and a gate that did not leaves an escalation on
   the spine that nothing is asking anybody about -- a report received and silently dropped. The
   brief anticipated needing a transaction-aware copy of `openGate` on the grounds that `openGate`
   opens its own transaction. It does, and that turned out not to matter: `txn.ts`'s `transaction()`
   **joins** an inner call to an outer one rather than nesting it, so `appendEvent` and `openGate`
   both run inside one block without knowing it. Writing a second implementation of `openGate`'s
   three-statement open would have duplicated the only order the `gate_opens_without_a_projection`
   and `gate_stage_matches_its_transition` constraints admit, to buy nothing. The joining is pinned
   by a case that abandons the outer transaction and asserts neither the event nor the gate landed.

6. **The dedup key is per turn: `worker_escalation/<sessionId>/<generation>`.** Without the
   generation, a resumed session's second report collides with its first, `appendEvent` absorbs it as
   an idempotent no-op, and the second turn's escalation never reaches a human. On re-processing --
   a restart re-reading a transcript it already ingested -- `appendEvent` returns `seq = null`, so the
   sequence is read back by the same `dedup_key` lookup that detected the duplicate, and the gate is
   opened only if no gate already names that origin event. The check is on `origin_event_seq` rather
   than on the gate id, so a caller with its own naming scheme still cannot open a second gate over
   one escalation.

7. **The report goes in the event payload and into `gate.rationale`, byte for byte, and never into
   `gate_transition.body`.** Section 4.7 is explicit and this entry keeps it: `body` carries the
   human's verbatim answer on the `presented -> answered` advance, and putting worker prose there
   would record worker-authored text as the approval, destroying the single property the lap is being
   built to gain. The rationale is the unmodified report -- not trimmed -- so the gate's text and the
   transcript's cannot disagree about what the worker wrote. A blank-or-whitespace report is refused
   in the ingress, because the DDL's `CHECK (length(rationale) > 0)` accepts three spaces.

**Consequences.**

- Section 7 step 9 is closed for the writing half. What this entry delivers is a callable ingress
  function, not a running loop: **the composition root that polls `readState`, notices an
  identity-confirmed terminal result and calls the ingress is step 8's, and is not built here.**
- `src/control_plane/report_ingress.ts` takes the report as plain data and declares its own
  `TerminalReportFact`, structurally satisfied by the provider's `TerminalReport`. This is forced
  rather than chosen: `test/gate_item11/no-provider-detail-leaks.test.ts` fails any module under
  `src/control_plane/` that names a session backend and any module under `src/` -- `src/index.ts`
  excepted -- that knows both. The composition root is therefore the one place holding both, which is
  the arrangement item 11 measures the cost of a provider swap by. The structural hand-off is the
  price of that property and is paid deliberately.
- The payload is `{schema_version, report, session_id, generation, terminal_reason, subtype,
  is_error, returncode}`, rendered by `pythonJsonDocumentSorted` -- the only renderer that accepts the
  booleans and nulls it carries -- so **its keys are in sorted order, not the order the design listed
  them in.** Nothing reads it positionally, and `schema_version` is what a later shape change moves.
- Decisions 2 and 4's last paragraphs each close a hole a pre-merge review found rather than a
  hazard anticipated in the brief: the run-binding check, the shared blank predicate, the
  liveness split and the garbage propagation were all added after the first green suite, and each
  has a case that fails without it.
- `#readout` was refactored to call the three extracted rules. Behaviour-preserving: the order the
  checks are applied in is observable and is unchanged, and the full 65-case ported provider suite
  passes untouched.
- `gate_id` is derived as `gate/<dedup key>`, which makes re-processing idempotent without the caller
  remembering an identifier across a restart. If a second gate type is ever opened off one escalation,
  that derivation collides and must change.

**One known limitation, left open rather than closed.** A report is returned as soon as a terminal
line is on the transcript, without waiting for the child to exit. If a child ever wrote **two**
`result` lines on one generation, a poll landing between them would return the first, the ingress
would commit it under the generation's dedup key, and the second -- the one last-wins says should
have won -- would be discarded as a duplicate fact. The window is real but the shape is
hypothetical: the CLI writes one `result` per turn and then exits, no fixture or fake in this
repository emits two, and last-wins was adopted defensively to match `#readout` rather than to
describe observed output. The obvious fix -- treat a result as terminal only once the child is gone
-- is **not** taken here, because it contradicts a deliberate property of `#readout`, which never
consults the exit for its verdict, and it would strand any child that writes its result and then
hangs. Closing this is a design decision about what "the turn is over" means, and it belongs with
the composition root in step 8, which is the component that will actually poll.

**Falsifier.** A worker whose report must reach a human *before* its turn ends -- at which point the
transcript has no terminal `result` line to read and decision 1 has nothing to offer, and option 2
becomes required rather than optional. Or a lap in which opening a gate on every prose-writing turn
is too expensive to accept, which falsifies decision 2's cost trade and forces the structured
discriminator it names. Decision 5 is falsified the moment `txn.ts` stops joining an inner
`transaction()` to an outer one: the case that abandons the outer transaction is what would go red,
and it is there for that.

**Status.** accepted

**Source.** Human gate, task `continuo-lap1-report-ingress`. The design is
`docs/design/minimal-operating-loop.md` section 4.7 (the three options and the recommendation) and
section 7 step 9 (the order and what it unblocks). Decision id from the `D-0019`..`D-0099` shared
band; `D-0055` was taken concurrently by the delegation-record lane, so this entry takes the next
free id after it rather than after `D-0054`.

---

## D-0217 -- `FencedSpawner` splits into `prepare` and `execute`, and the single-spawn-path obligation is restated over both with a provenance check

**Context.** `D-0205` re-expressed interlock#71's canary acceptance for an ESM module graph as two
obligations: the production spawn path calls the precondition directly, and a target-only test
asserts the injected spawner's call count is exactly zero on a broken configuration. In the port,
that was carried by shape: `FencedSpawner.spawn` called a `#private` `#admit` and only then the
spawner, and `#admit` being private meant no caller could reach a `SpawnPlan` any other way.

Step 7 of the minimal operating loop breaks that shape. It materialises the fence and does **not**
spawn -- the spawn is step 8. `#admit` does everything step 7 needs: render, battery, the two-file
all-or-nothing publication with its rollback, and the `spawn-admitted` ledger append. Reaching it
required one of two things, and both are worse than a split:

- **Call `renderFence` and `writeFence` directly.** That skips the battery, the settings file, the
  rollback and the admission record -- which is to say it skips everything that makes published bytes
  an *admitted* fence, while producing files indistinguishable from an admitted one's.
- **Call `spawn` with a no-op spawner.** `spawn`'s contract is that a child was started. It would be
  saying so falsely, and the outcome would carry a `result` from a callable that did nothing.

`D-0205`'s falsifier anticipates exactly this: "the production spawn path gaining a **second entry
point that does not route through the precondition** -- at that moment the module-graph dependency
stops being equivalent to the obligation, and the assertion has to be restated over both entry points
(or the second one removed)."

**Decision.**

1. **`#admit` becomes the public `prepare(role, ctx)`, unchanged in behaviour.** It renders, proves,
   publishes and records, and returns a refusing `SpawnOutcome` rather than throwing, exactly as
   before. It is now a production entry point, because step 7 calls it and nothing else.

2. **`execute(outcome, spawner)` is the only call site of the injected spawner**, and `spawn` becomes
   the composition `prepare` then `execute` -- so interlock's ported cases drive the same code the lap
   drives, not a parallel path kept in step by hand.

3. **`execute` asks two questions, of the two things that can answer them.** This is the rule that
   was got wrong three times before it was got right, and the shape of the mistake is worth more
   than the rule.

   `prepare` records each plan it admits in a per-instance `WeakSet`, before the ledger append
   rather than after, so no ordering exists in which a durable `spawn-admitted` names a plan
   `execute` would refuse. That record answers exactly two questions, and they are the two an
   in-memory record **can** answer: *did this spawner issue this plan* (provenance), and *has it
   started a child already* (single use, by removing the plan before calling the spawner).

   It does **not** answer whether the artifacts on disk are still the plan's, and earlier revisions
   of this entry tried to make it. Three reviews found three failures: the record answered "was this
   issued" rather than "may this start now"; keyed by plan identity it could not see two plans
   competing for one fence path; keyed by path string it treated two spellings of one file as two
   files. Those were not three bugs. They were **one approximation failing at rising resolution -- a
   name held in memory being asked a question about bytes on disk.** Sharpening the key (a canonical
   path, a `(device, inode)` pair) moves the failure without removing it, and no key of any kind can
   see an overwrite from outside this process.

   So `execute` asks the disk, and compares what it finds against a **snapshot taken at admission**
   rather than against the plan the caller is holding. `Fence` freezes itself but stores `settings`
   by reference, so `plan.fence.settings` is mutable after `prepare` returns: a caller could delete
   the `hooks` block from it, rewrite both published files from the mutated object, and a comparison
   against `plan.fence` would find them in perfect agreement and start an unfenced child. The
   snapshot is taken before the plan is ever exposed, so the expectation is not reachable from the
   value the caller holds.

   The comparison is canonical JSON of `fenceToJson` -- the same projection `writeFence` publishes --
   and not `diffFences`, which was used first and is not enough: it reports added and removed rule
   *ids*, a settings change and a permission-mode change, so a rule whose id stayed the same while
   its spec was rewritten to allow more reads as identical. Missing, unreadable, or different is a refusal in every branch. **Both artifacts, because
   the fence is what the deny hook reads but the settings file is what carries the hooks block to
   the CLI** -- a child launched with a settings file that lost its `hooks` entry runs with no deny
   hook at all, and its fence sits on disk pristine and unread.

   Two consequences worth stating because they change earlier behaviour. An **identical**
   re-admission no longer invalidates the earlier plan, and refusing it was wrong: two `prepare`
   calls for one role and one context publish the same bytes, so the child would run under exactly
   the fence its plan describes. And an overwrite **from outside this process** is now caught, which
   no version of the in-memory record could do.

   This is the load-bearing rule and it is stated as a pair: **a public `execute` opens a second door
   to the child, and the provenance check is what closes it.** `SpawnPlan`'s constructor is public and
   stays public -- interlock's cases construct one, and narrowing it would turn ported cases into
   target-only ones under `D-0101`'s reasoning -- so having a plan is not evidence of admission. A
   plan is admissible because `prepare` issued it. That is the same sentence `spawn` used to make true
   by keeping `#admit` private, restated as data now that the two halves can be called apart.

4. **`D-0205`'s zero-call canary is restated over both stages**, in a target-only file of its own
   (`test/fencing/spawn-two-stage.test.ts`) rather than inside the ported suite, so no parity ledger's
   totals move: every brokenness class refuses in `prepare` and yields no plan; a hand-built plan and a
   plan admitted by a *different* spawner are both refused by `execute` with the spawner never
   invoked; and each refusal is paired with its accepted input so the file cannot pass vacuously.

5. **`D-0205` is not superseded.** Its two obligations remain true as written -- the production path
   calls the precondition directly, and the canary asserts a zero call count on a broken
   configuration. What changes is the number of stages they are stated over, which is what its own
   falsifier instructs.

**Consequences.**

- **The admission record is written at step 7, not step 8.** `spawn-admitted` means the fence was
  rendered, proved and published, which is what happened; it has never meant a child started. The
  event named for admission stays a record of admission.
- **A plan does not survive its process.** The `WeakSet` is per-instance and not persisted, which is
  correct rather than a limitation: the fence on disk can have been replaced since, and re-admitting
  is how a caller finds that out.
- **The window is narrowed, not closed, and no in-process check can close it.** The child reads the
  fence when it runs a tool, which is after `execute` has returned -- so a replacement landing in
  that gap is still applied. What the verification rules out is the far larger window from admission
  to spawn, during which a materialisation step may do arbitrary other work. Anyone reading this
  entry as "the fence cannot change under the child" is reading it wrong.
- **The cost is one file read per spawn**, of a file this process wrote moments earlier, outside the
  ledger transaction. That is what the three earlier attempts were trying to avoid paying, and it
  was not worth avoiding.
- **One admission, one child.** `execute` consumes the plan from the record before calling the
  spawner, so a second `execute` on the same outcome is refused by rule 3's own check. Two children
  under one `spawn-admitted` line would make the durable record an undercount of what started, which
  is the direction this module never goes -- and a retry loop reaches it without doing anything
  exotic. Consumed *before* the callable rather than after, so a spawner that throws also consumes
  it: a failed start is still a start attempted under this admission, and the retry is a fresh
  `prepare` -- which re-renders, re-proves and re-publishes, and is how a caller finds out the fence
  moved underneath it.
- **Step 8 cannot smuggle a fence past the precondition.** The composition root receives a plan it did
  not build, from a spawner it must hold to execute it.
- **The materialisation result is minted, not merely returned.** `MaterializedWorkspace`'s whole
  claim is that its `workspace` names a checkout git made and artifacts this step published -- that
  is the evidence half of `M2`, the thing a step-8 lifecycle observer keys its `create-workspace`
  veto on. A class anyone can construct for an arbitrary directory is evidence of nothing, and an
  observer keyed on it would be admitting bare directories while believing it had ruled them out.
  So the constructor demands a module-private token, the way `src/session/provider.ts`'s `ENUM_MINT`
  does: a TypeScript `private constructor` is erased at runtime, and the check has to be one the
  runtime makes.
- **A step that admits must hand back the admitting instance, and step 7 does.** This is the
  consequence that is easy to get wrong, and it was got wrong first: `materializeWorkspace`
  constructed a `FencedSpawner` locally, published through it and returned only the plan -- which
  under rule 3 is a plan nobody can spawn, because any spawner step 8 built would refuse it. The
  provenance check turns "who admitted this" into a real question, so every caller that admits on
  another's behalf now has to answer it. `MaterializedWorkspace` carries the spawner.
- **Handing the spawner back is not the same as taking one in, and the difference cost three review
  rounds to see.** The first repair let the request supply a `FencedSpawner`, so a composition root
  could own the object. That gave step 7 an object whose *write paths* it did not control --
  `settingsName` and `ledger.path` are both public -- while leaving it responsible for the invariant
  that no artifact lands inside the worktree. Successive reviews found an absolute `settingsName`, a
  traversing one, a `settingsName` aliasing `fence.json`, and a ledger inside the checkout: not four
  bugs but one design, enumerated. The request now takes a *path* for the one thing a caller has a
  real reason to move, and the spawner is constructed here from paths this module derived and
  checked. **The general form, worth keeping: a module that owns an invariant about where files go
  cannot accept an object that decides where files go.**

**Falsifier.** A child observed running under a fence different from the one `execute` verified --
which would mean an in-process read-back is not enough, and the fence would have to be handed to the
child directly rather than left on disk for it to read. Also falsified by a third way to reach the
spawner callable, or by a `SpawnPlan` becoming acceptable to `execute` on any ground other than
having been issued by that spawner and matching the artifacts on disk -- a serialised plan, a
registry, a static factory. Also falsified by `prepare` ceasing to publish, which would make step 7's
artifacts unadmitted again and put rule 1's "unchanged in behaviour" wrong.

**Rejected alternative: keep `#admit` private and expose a separate `materializeFence` in
`fencing/`.** A second function doing render-battery-publish-record is a second implementation of the
precondition, and the failure mode `D-0205` names is precisely two implementations drifting while both
stay green.

**Rejected alternative: sharpen the in-memory key -- `(device, inode)` instead of the path string.**
It closes the two-spellings residual and, because `writeFence` publishes by rename, a re-`stat` at
`execute` would even catch an external overwrite. It was rejected because it is the same
approximation one step further along: it still answers a question about the file's *content* with a
fact about the file's *identity*, it depends on inode numbers a filesystem may not supply (Windows
reports `0`), and it costs a `stat` -- at which point reading the file and comparing it is barely
dearer and is the actual question.

**Rejected alternative: make the fence ledger the authority -- an admission id written to the ledger
and checked there.** It would survive process boundaries, which is the one thing the in-memory
record cannot do. Rejected because it changes the ledger's role from *record* to *permission*, and
`D-0206` explicitly accepts that the ledger takes no cross-process lock and that publish-then-record
can interleave. Stacking a fail-closed precondition on a foundation whose looseness is a recorded
decision makes the guarantee worse than the one it replaces, and it would require a scan of the
JSONL on every spawn.

**Rejected alternative: brand `SpawnPlan` so only `prepare` can construct one.** A private
constructor or a module-private symbol would make provenance a type property rather than a runtime
check. It was rejected because interlock's spawn cases construct a `SpawnPlan` directly, and
`D-0101`'s rule is that a source case reaching a private name gets the name exposed rather than the
case rewritten -- rewriting is what turns a ported case into a target-only one. The `WeakSet` gives
the same guarantee without touching what the ported suite can build.

**Rejected alternative: move the `spawn-admitted` append into `execute`.** It would make the ledger
say "admitted" only when a child started, which sounds tidier and is wrong: a refusal is recorded at
admission time, so recording the admission later would put the two halves of one decision at two
different moments, and step 7 -- which admits and does not spawn -- would leave no durable record of
having admitted anything at all.

**Status.** accepted

**Source.** Human gate, task `continuo-lap1-workspace-materialize`, on
`docs/design/minimal-operating-loop.md` steps 7 and 8, and on `D-0205`'s own falsifier. Decision id
from the `D-02xx` fencing and settings band, next after `D-0216`, checked against `origin/main` at
`ac284a8`.

**Landed ahead of its caller, deliberately.** Step 7's materialiser is what needs a `prepare` that
does not spawn, and it is the reason this decision exists -- but the split, the provenance record
and the read-back are `src/fencing/`'s own, they are testable without a workspace, and the record
went through seven review rounds and one redesign on the way here. So it ships first and alone, and
the materialiser follows against it. Nothing here imports the workspace layer; `prepare` and
`execute` are equally usable by the composition root of step 8 and by `spawn`, which is still their
composition and is what interlock's ported cases drive.

---

## D-0057 -- The delegation intent and the materialisation result are two records, and materialisation is artifact-first and one-way

**Context.** `docs/design/minimal-operating-loop.md` says two things about a "reservation" that
cannot both be read off one record. Section 6.3 recommends a delegation record
`{runId, holder, workspace, role, baseBranch, topicBranch, prompt, cliArgs?}` **produced by the
admission command** -- the durable statement of what a worker was asked to do. Step 7 says to adopt
claude-org-ja's ordering "in spirit -- materialise every artifact, **commit the reservation last**,
so a committed reservation always has a sendable payload behind it". Read as one record, those
contradict: a record produced at intake cannot also be the thing written after the worktree exists.

They are two records. The first is an **intent**, fixed when the work is accepted, and its content is
known before anything is built. The second is a **result**, and half its content -- the resolved base
commit, the paths the artifacts actually landed at -- does not exist until the work is done. Merging
them would mean either an intent that cannot be written until materialisation succeeds, or a result
whose fields are promises.

The second half of the problem is that the result cannot be written atomically with the thing it
describes. `D-0051` got atomicity for the `run` row and its `run_created` event by putting both
inside one `BEGIN IMMEDIATE`. A git worktree and three files have no transaction to join, and
`D-0051`'s own rejected alternative -- hanging the work off `appendEvent`'s `sideEffect` -- is worse
here than it was there, because that side effect runs *after* the event row is inserted.

**Decision.**

1. **Two records, two owners.** The delegation intent is produced at admission and is not this
   step's. Materialisation appends its own event, `workspace_materialized`, whose payload carries
   what only materialisation knows: the resolved base commit, the repository root, the worktree
   path, the role, and the artifact manifest. `EVENT_TYPES` gains exactly one entry, under
   `D-0051` rule 5's "a type is registered when its producer is written" and its
   `subject_pastparticiple` form.

2. **`subject_kind` is `run`.** The closed vocabulary has no `workspace`, and widening it would be a
   migration for a subject with no identity of its own. The fact is about the run it was built for.

3. **The artifact directory must be unclaimed, and is checked before the worktree exists.**
   Materialisation creates its artifacts, so finding one already there means another materialisation
   owns the directory -- and publishing over it would replace a fence a worker may be running under.
   This is the same rule `git worktree add` already imposes on the checkout, applied to the
   directory beside it, and it is reachable within one run as well as across two: a retry with a
   different workspace would otherwise destroy the earlier materialisation's files and only then
   meet the duplicate-event refusal.

4. **Artifacts first, the event last, and the order is enforced rather than described.** Every
   artifact is re-`stat`'d immediately before the append, **and the worktree is re-asked of git**.
   An event whose manifest is not on disk at that moment is refused, not appended.

   The worktree is asked of git rather than of `existsSync`, and that is the load-bearing half: a
   concurrent cleanup between `git worktree add` and the append -- an operator sweeping up the
   "artifacts with no event" state rule 4 deliberately allows -- leaves the files intact and the
   checkout gone, and "the directory exists" is also true of the bare directory the provider would
   have made. What this event claims is a *checkout*, so what is verified is that `workspace` is
   still a worktree and is still that worktree's own root.

5. **The one-way property, stated as the two states and their asymmetry.**
   - *Artifacts with no event* is **allowed**. A crash before the append leaves a worktree and files
     nothing claims. It is recognisable (the worktree exists, the run has no
     `workspace_materialized`) and recoverable (`removeWorktree`, which is on the package surface for
     this reason and is never called by materialisation itself).
   - *An event with no artifacts* is **not reachable through this producer**, and the earlier
     wording of this rule -- "unconstructible" -- was wrong and is corrected here.
     `materializeWorkspace` is the only producer of the type in the build, it appends only after the
     sweep, and it exports no seam that reaches its own append without the artifacts. What it cannot
     do is stop somebody calling `appendEvent` directly with this `event_type`: the spine is a
     generic append-only fact log and every type on it is writable by anyone holding a connection.
     That is true of `run_created` too, and `D-0051` does not claim otherwise.

     Reserving the type inside `appendEvent` was considered and rejected: it would put a per-type
     allowlist into a shared writer for one producer's benefit, and it would still be evaded by the
     next producer that needed an exception. The honest statement of the guarantee is the one this
     rule now makes -- a caller reaching past the producer is writing a fact it did not observe,
     which the spine cannot distinguish for any event type, and which no ordering rule here was ever
     going to prevent.

6. **A second materialisation of one run is refused, not absorbed** -- the same difference from the
   spine's idempotent re-append that `D-0051` takes for admission, and for a stronger reason: by the
   time the duplicate is detected this call has already created a worktree and a branch that the
   earlier event does not describe.

7. **Refusal does not roll back.** Whatever earlier steps wrote is left where it is. Deleting a
   checkout an operator may be looking at is not a rollback.

**Consequences.**

- **A retry is an operator action, not a code path.** The recorded payload is what a retry is built
  from, which is part of why the event must never describe a materialisation that did not happen.
- **"Which repository" is decided by `cwd` alone, so git's repository-selecting environment
  variables are removed rather than inherited.** `GIT_DIR`, `GIT_WORK_TREE` and their family make
  git ignore or reinterpret `cwd`, and git sets them itself for every hook it runs -- so a
  materialiser invoked from a `post-commit` would create its worktree in whichever repository
  invoked the hook while every refusal and every event payload named the one the request asked for.
  git would succeed, which is why nothing downstream could catch it. The removal is narrow on
  purpose: `HOME`, `PATH`, `SSH_AUTH_SOCK` and the operator's configuration all still reach git,
  because everything except "which repository" is the operator's to decide.
- **The event is not a lease and not an authority.** It records that a workspace was built. Nothing
  in the lap treats it as permission to do anything.
- **A second reader of the intent's fields validates them by the intent's rules, not by its own.**
  Step 7 re-validates `runId`, `role`, `baseBranch`, `topicBranch`, `workspace` and `prompt` because
  it can be reached without an intent -- so the rules have to be the *same* rules. They were not, at
  first: applying the run-identifier's printable-ASCII rule to every string refused any run whose
  workspace, branch or prompt carried a non-ASCII character. This organization keeps repositories
  under paths with Japanese in them and writes its prompts in Japanese, so that was step 7 refusing
  work `run admit` had accepted. The rules now match `D-0055` field by field: printable ASCII for
  the run identifier alone, no control characters elsewhere, nothing but non-emptiness on the
  prompt, and *fully qualified* -- not merely `isAbsolute` -- on every path.
  **The general form: a validator downstream of a record must restate that record's rules, and a
  stricter restatement is a defect, not caution.**

  The general form is stated because the instance recurred. After the non-ASCII refusal was fixed,
  the same mistake was made again in the same module: every element of `cli_args` was routed through
  the non-empty rule, while `LapRunIntent` permits an empty string as an argv element in as many
  words. Writing the principle down did not prevent the second instance; what catches it is a case
  per field that drives the value the record says is legal.
- **`src/control_plane/lease.ts`'s contrary rule is reconciled, not overridden.** That module records
  `worktree_filesystem` as an unfenced destination whose residual is "control-plane row under the
  fence first, file write derived from it" -- the opposite order. It is about a *fenced write to a
  destination*, where the row is the authority and the file is a projection that can be re-derived at
  will. Nothing in step 7 is re-derivable: a worktree is a checkout, and a fence is bytes a hook will
  read. Both rules are instances of one principle -- the artifact that cannot be rebuilt from the
  record goes first -- and they differ because which artifact that is differs.

**Falsifier.** A second producer of `workspace_materialized` anywhere in the build, or a path
*through `materializeWorkspace`* that reaches the append without publishing the artifacts first; at
that moment rule 5 is a description rather than a property. (A direct `appendEvent` call is not that
path -- see rule 5, which says what the spine's openness does and does not leave available.) Also falsified by the
`event` table gaining a `workspace` `subject_kind`, which would make rule 2 a workaround rather than
a choice, and by the delegation intent growing a resolved base commit, which would mean the two
records had collapsed back into one.

**Rejected alternative: one reservation record, written last.** It is the literal reading of step 7,
and it loses the durable work statement entirely for the whole window between accepting the work and
finishing the checkout -- which is the window in which a crash is most likely and a record most
wanted. Section 6.3's whole argument for the delegation record is that the instruction should not
live only in the child's transcript.

**Rejected alternative: three events, one per artifact.** `worktree_added`, `fence_published`,
`mcp_config_written`. Each would be a fact nothing consumes, and together they would put the partial
states this decision exists to make unobservable back onto the spine as observable ones -- a consumer
would then have to decide what a run with two of the three means.

**Rejected alternative: write the event first and repair on failure.** Symmetrical on paper and not
in practice. The repair runs in the process that just failed, which is the process least able to run
it, and the state it leaves behind on a crash mid-repair is the one this decision rules out.

**Status.** accepted

**Source.** Human gate, task `continuo-lap1-workspace-materialize`, on
`docs/design/minimal-operating-loop.md` step 7 and section 6.3, whose contradiction this resolves.
Decision id from the `D-0019`..`D-0099` shared band, next after `D-0056`, checked against
`origin/main` at `479abc2`. This entry and `D-0058` were first written as `D-0054` and `D-0055`,
and have been re-taken twice on rebase: the parallel adoption-gap, delegation-record and
report-ingress tasks each claimed the band's next id and merged ahead of this one, under its
first-merged-wins rule.

**The fencing half of this work shipped first, as `D-0217`.** Step 7 needs a `prepare` that does not
spawn, so the `FencedSpawner` split was written alongside this step and reviewed with it. It was
separated at the human gate after review kept finding defects across the whole diff at once, and the
smaller change came back clean on its first review in isolation. That is worth recording as a fact
about the work rather than a note about process: the two halves are independently testable, and
reviewing them together was hiding both.

---

## D-0058 -- The worker's MCP configuration is a materialised artifact, validated by the endpoint's own config class

**Context.** Step 7's stated purpose is "a worker that can both work and poll". The artifacts the
fence renderer produces cover the first half only: `src/fencing/renderer.ts` builds a settings
payload of `permissionMode` plus whichever of `permissions` / `sandbox` / `hooks` / `env` the role
document authored, and the role document is byte-pinned by a contract test. Nothing anywhere under
`src/` emits an `mcpServers` entry, a `--mcp-config` argument, or any of the six
`INTERLOCK_MESSAGEBUS_*` variables the endpoint reads.

So a worker materialised from the fence alone starts fenced and cannot poll: `poll` and `ack` are the
only writes it has into the control plane, they are served by a stdio child it must be configured to
launch, and `EndpointConfig.missing()` refuses at startup with exit status 2 when four of those
variables are unset.

**Decision.**

1. **The MCP configuration is a third materialised artifact**, published beside the fence and the
   settings, and named in the result event's manifest like the other two.

2. **Its content is derived from the endpoint's own contract, not from a copy of it.** The env map is
   built and then handed to `EndpointConfig` -- the class `main()` constructs from `process.env` at
   startup -- and materialisation refuses if `missing()` reports a gap or the lease resource is not
   `DELIVERY_LEASE_RESOURCE`. An `mcp.json` this step writes is one the endpoint accepts.

3. **The variable names keep their `INTERLOCK_` prefix and the server name does not.** `D-0502`
   records that the variable names are a wire contract with a configuration file this repository does
   not own; this step writes that file, so it writes those names. The *server* name is a label a
   worker sees, so `D-0049` applies and it says `continuo`.

4. **The child is `node <endpoint module>`, by path**, resolved relative to the materialiser the way
   the deny hook is resolved relative to the spawner. At runtime that path is under `dist/`, so the
   artifact depends on a build having run -- stated on the constant rather than discovered when a
   worker's endpoint fails to start. **The launcher is validated, not merely defaulted.** `??` does
   not fire on an empty string, and rule 2's validation covers the endpoint's *environment* rather
   than the command that starts it -- so an empty `node` or module override would pass `missing()`
   and be recorded as a successful materialisation whose child cannot start. Both are required to be
   non-empty and the module path to be absolute, because the configuration is read by a CLI whose
   working directory is the worker's. **And the recipient is checked against the registry the
   endpoint builds**, not merely against `EndpointConfig`: a well-formed recipient that
   `spikeRegistry` composes no handler for passes `missing()` and is refused by `main()` at startup,
   and a worker configured with one would poll an eternally empty queue while its real messages
   stayed due. The check asks the real `spikeRegistry`, over an inert destination, because any
   restatement of which recipients exist is a restatement that can drift from the one the endpoint
   runs. **And the database is derived from the connection materialisation writes to**, rather than
   taken on trust. A path naming a different but perfectly valid production plane passes
   `missing()`, the endpoint starts cleanly, and the worker then polls a database this run's
   messages will never reach -- nothing fails, the worker is simply deaf, and that is the failure
   mode this rule exists to make unreachable. An override remains for the case where a worker
   reaches one file by another name (a symlink, a bind mount) and is checked against the connection
   rather than trusted -- by spelling or by canonical path after symlinks, and **deliberately not by
   file identity**. An earlier revision accepted `(device, inode)` equality here, to admit a bind
   mount, and that was wrong for this database in particular: the control plane runs on a rollback
   journal rather than WAL (`connection.ts` records why WAL is refused), and SQLite derives
   `<path>-journal` from the spelling the database was opened with. Two hard links to one database
   file are therefore two databases as far as recovery is concerned -- each writer keeps its own
   journal, and after a crash one path cannot see the other's hot journal. The bytes are shared and
   the recovery is not, which is worse than two separate databases because it looks like one.

   A directory-level bind mount does not have that problem, since the sidecar is derived beside the
   database inside the same mounted directory. It is nonetheless not accepted, because
   distinguishing it from a same-directory hard link means a basename-plus-parent-identity rule this
   suite cannot exercise without root -- and an untested rule guarding a crash-recovery property is
   worth less than a refusal an operator can read.

   **The database path is also read from SQLite rather than from the driver.** `connection.name` is
   the string the caller passed, verbatim; a connection opened with a relative filename keeps it,
   so a process that changed directory in between would resolve it against the new working
   directory and configure the worker for a different database, or none. `PRAGMA database_list`
   gives SQLite's own resolution. Deriving a value from the live connection is only safe if it comes
   from the connection.

5. **The child's `cli_args` is the admitted run's arguments, then the fence's flags, then
   `--mcp-config`.** `LapRunIntent` carries `cliArgs` and the provider consumes them through
   `settings["cli_args"]`, so this step has to carry them across or half the durable execution
   intent is lost between the record and the child -- silently, because the key would still be
   present and would still look right.

   **An argument that repeats a flag this step generates is refused, and the ordering is only the
   second line of defence.** `--settings`, `--permission-mode` and `--mcp-config` *are* the fence;
   `ClaudeCliSessionProvider` refuses its own owned flags and knows nothing about these. Putting the
   generated flags last makes a last-wins parser resolve a repeat in the fence's favour, but which
   occurrence a CLI honours is a property of a program this repository does not own, and a fence
   resting on that is resting on a guess. So the repeat is refused outright and the ordering is what
   remains true if the refusal is ever wrong.

**Consequences.**

- **A configuration gap is refused at materialisation, in the operator's process.** Without rule 2 it
  is discovered by a worker exiting 2 hours later, after the materialisation has already been
  recorded as successful.
- **The artifact directory is required to be outside the worktree, and the check is on the paths
  rather than on the directory.** It holds the fence, the settings, this file and the fence ledger;
  inside the worktree they would be untracked files the fenced child can edit, including its own
  fence. Checking only the directory is not enough and the gap is reachable rather than theoretical:
  `FencedSpawner.settingsName` is public, `writeSettings` treats an absolute one as a full
  replacement for the directory, and `D-0217` puts a caller-supplied spawner on the request -- so a
  request with an impeccable artifact directory could still publish `settings.local.json` into the
  checkout. Every path an artifact will be written to -- the fence, the settings, the MCP
  configuration and the fence ledger -- is resolved and checked before the worktree is created, and
  they are checked for **distinctness** as well as containment: two artifacts at one path is not a
  layout error but a silent substitution, where the later write wins, every later `stat` still
  succeeds, and the sweep reports a complete manifest for a file whose contents are somebody else's.
  `D-0217` records the further step this led to -- the request stopped accepting a `FencedSpawner`
  at all, because a module that owns an invariant about where files go cannot accept an object that
  decides where files go.
- **Path identity is one function, used by every comparison.** Having two was itself the bug:
  containment folded case on Windows and distinctness did not, so on an NTFS volume a fence ledger
  at `FENCE.JSON` and a fence at `fence.json` read as two artifacts -- the ledger's appends would
  overwrite the published fence, every `stat` would still succeed, and the materialisation would be
  recorded as complete. The Windows halves of that fold, and of the fully-qualified path rule, are
  **not asserted by a simulated case**: stubbing `process.platform` does not produce a Windows
  world, because `node:path` binds its flavour at load, so `join` and `parse` would stay POSIX while
  the branch went Windows. They are exercised by the `windows-latest` cell running the suite; their
  negative cases are asserted by neither cell, and that is recorded as a known limit rather than
  papered over.
- **The endpoint's destination directory is held to the artifact layout rule too**, even though this
  step never writes it: `KeyedDropbox` creates it at endpoint startup and writes delivery files into
  it for the rest of the worker's life. It is the one configured path whose contents appear inside
  the checkout *later*, where no check here would ever see them -- and they are the operator's
  delivery artifacts rather than the worker's.
- **This is lap 1's shape and inherits lap 1's limit.** One worker, one endpoint process, one
  recipient pinned by env. The moment several workers share a host, who may `poll` whose queue
  becomes a question the transport has to answer, and this artifact is where that answer would land.

**Falsifier.** The endpoint growing a configuration source other than its environment -- an argument
parser, a config file of its own -- at which point rule 2's validation stops covering what the
endpoint actually reads. Also falsified by the role document gaining an `mcpServers` block, which
would make this a second writer of the same configuration.

**Rejected alternative: add MCP configuration to `roles.json`.** The document is carried verbatim
from interlock and byte-pinned by `test/contract/carried-documents.test.ts`; editing it is a
divergence from the source document for a value that is per-run rather than per-role -- the database
path, the recipient and the lease epoch all change between runs.

**Rejected alternative: pass the endpoint's environment through the spawned child's `env` instead of
a config file.** The Claude CLI launches its MCP servers itself; their environment is what the
configuration says it is, not what the parent happened to export. A parent-env approach would work
only for as long as the CLI forwarded the whole environment, which is not a property it promises.

**Status.** accepted

**Source.** Human gate, task `continuo-lap1-workspace-materialize`, on
`docs/design/minimal-operating-loop.md` step 7 ("a worker that can both work and poll") and section
4.5. Decision id from the `D-0019`..`D-0099` shared band, next after `D-0057`.
