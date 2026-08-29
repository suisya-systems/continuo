# pytest to Vitest: the translation conventions

Continuo is a **test-first parity port**: interlock's suite is the specification, and a translated case
that is subtly weaker than its source is worse than one that is missing, because a missing case is
visible in the parity ledger and a weakened one is not.

This document is the rulebook for that translation. It is normative for every belt after this one.
Each rule names the pattern, the mapping to use, and -- the part that matters -- **the failure mode of
the mapping a careful person reaches for first**. Every rule has at least one worked example in the
repository, and the example is cited.

Two companions:

- `parity/control-plane.ledger.json` records what was translated, how, and what was not.
  `scripts/parity-check.mjs` enforces it (see [The ledger](#the-parity-ledger) below).
- `docs/differential-oracle.md` covers the cross-runtime comparison, which catches the class of
  divergence no translated test can catch.

---

## 0. The two rules above all the others

**A translated case asserts what the source asserted, or the ledger says it does not.** There is no
third option. "It is close enough" is how a suite stops being a specification.

**When a mapping is impossible, that is a report, not a decision.** Weakening a case to make it fit
the runner is not a translator's call. Record it, escalate it, and let the reviewer see the trade.
This pilot needed that escape hatch zero times; two cases are deferred and four are adapted, and none
of the six assert less than their source (see [Dispositions](#dispositions)).

**"What the source asserted" is a ceiling as well as a floor.** A translated case that asserts
*more* than its source is wrong in the same way one that asserts less is wrong: both make the suite
say something interlock's suite does not say, and the ledger then describes coverage that is not
the coverage under review. Two real instances, both caught late because a stricter test looks like a
better test:

- a `match=` pattern whose `.` was escaped, narrowing a regex the source leaves wide;
- a signature check matched against the whole declaration text, where the source asserts only that
  no *parameter* carries the forbidden name -- it would fail on a parameter merely named
  `resourceScope`.

If the stronger assertion is worth having, it is worth having as a **target-only** test that says so,
next to the faithful translation. What it may not do is occupy the ported case's slot and be counted
as that case.

---

## 1. Fixture teardown ordering

**pytest.** Fixtures are set up in dependency order and finalized in **reverse**. A fixture that
fails *before* its `yield` does not run its own teardown -- but every fixture that already succeeded
still runs its own.

**Rule.** Register cleanup with `onTestFinished` at the moment the resource is acquired, not in a
file-level `afterEach`. Vitest runs those callbacks in reverse registration order, which is the LIFO
unwind; the acquisition site is also the only place that knows whether acquisition succeeded.

**The naive mapping and why it fails.** `beforeEach`/`afterEach` pairs place cleanup at a distance
from acquisition. When setup throws halfway, the `afterEach` still runs and tears down a resource
that was never built -- masking the original error with a second one from the teardown. And a file-
level `afterEach` cannot express "only the fixtures that got as far as yielding".

**Worked example.** `test/testkit/cases.ts` -- `caseRoot`, `rawConnection` and `chdirForTest` each
register their own undo at acquisition. The LIFO property is pinned directly by
`test/testkit/testkit.contract.test.ts` ("re-patching the same key restores the value from before the
FIRST patch").

---

## 2. parametrize

**pytest.** `@pytest.mark.parametrize` expands to one collected node id per case, named
`test_name[param]`. Stacked decorators form a cartesian product, and the id joins the axes with `-`,
with the decorator closest to the function varying fastest.

**Rule.** Use `parametrize()` from `test/testkit/parametrize.ts`, which takes the id **explicitly**
-- exactly as `pytest --collect-only` printed it -- and produces `name[id]`. Build a product with
`product()` rather than by nesting.

**The naive mapping and why it fails.** `test.each` names cases by interpolating the row into a title
template, so the resulting id depends on how the translator wrote the template. Two faithful
translations of one case can then carry different target ids, and the parity ledger cannot tell a
renamed case from a missing one. The ledger maps **node id to test id**; if the target id is not a
stable function of the source id, the ledger is decorative.

**Count cases at the expanded node id, never at the decorator.** A `parametrize` with five values is
five ledger rows.

**Worked example.** `test/control_plane/migrator.test.ts` -- three parametrized cases expanding to
thirteen node ids, including `[0002_beta.sql~]` and `[True]`.

---

## 3. xfail: strict and non-strict are different marks

**pytest.** The default `@pytest.mark.xfail` is **non-strict**: the test is expected to fail, and if
it unexpectedly *passes* it reports XPASS and the run stays green. `strict=True` makes an unexpected
pass a failure.

**Rule.** `xfail({ strict: true })` maps to `test.fails`. `xfail({ strict: false })` maps to a
wrapper that swallows the failure and tolerates a pass. Use `test/testkit/marks.ts`, which **requires**
the strictness at the call site rather than defaulting it, so a translator has to have read which one
the source used.

**The naive mapping and why it fails.** Vitest's `test.fails` is strict-equivalent: an unexpected pass
is an error. Mapping a *non-strict* xfail to it turns the suite red on the day the underlying bug is
fixed -- exactly the outcome non-strict xfail exists to prevent, arriving as a mystery failure in
unrelated work.

**Worked example.** `test/testkit/testkit.contract.test.ts`, "skip and xfail mappings". These are
**target-only**: interlock's `control_plane` has no xfail at all, and the whole suite has exactly one
(in `messagebus`). See [Patterns with no source case](#patterns-with-no-source-case).

---

## 4. skip

**pytest.** `skipif` evaluates its condition at **collection** time. The body never runs. The reason
travels with the result.

**Rule.** `skipIf(condition, reason)` from `test/testkit/marks.ts`. The condition is a value, computed
where the test is declared -- collection time, as pytest's is -- and the reason is carried into the
reported title.

**Three failure modes of the naive mapping**, all of which have been seen in real ports:

- *An early `return` inside the body.* The body **runs**, and can touch the filesystem or a database
  before returning. It is also reported as a pass, so the suite over-reports coverage.
- *Dropping the reason.* A CI log then says a test did not run and cannot say why.
- *Using `test.todo`.* `todo` means "not written yet"; `skip` means "written, and deliberately not run
  here". Collapsing them turns a platform-conditional test into an unwritten one, and no later audit
  can tell them apart. **Never translate a skip to a todo.**

**Never translate a platform condition mechanically.** `sys.platform == "win32"` is not always
`process.platform === "win32"`: the source condition is often about a *capability* (POSIX process
groups, `/proc`, symlink creation), and the port must ask about the capability.

**Enforcement.** `scripts/parity-check.mjs` counts every `skip`, `todo`, `fails` and `xfail`
construct under `test/` and requires a ledger approval with a matching **exact count**. One approved
example does not license the next one. A skip added quietly is the cheapest way to make a port look
finished.

**A skippable case that is also MAPPED needs one more thing, and the reason is an asymmetry between
the two runners.** **pytest collects a skipped test** -- `skipif` reports it, `--collect-only` prints
it, and the source inventory therefore contains its node id. **`vitest list` omits one.** So a ported
case guarded by a capability probe has a source node id and, on a host without the capability, no
target id at all, and the ledger's mapping reports `maps to a target test that does not exist`. It is
host-dependent, so it passes wherever the capability exists and fails everywhere else -- which is how
it reached CI: the two bubblewrap oracle cases resolved on a porting host with `bwrap` installed and
failed on the parity runner without it.

Declare each such id in the ledger's `target.conditionally_collected`, with a reason. Two properties
make that an escape hatch rather than a hole: ids are named **explicitly**, never by pattern; and the
checker still requires the test's **title to be present in the file's source text**, which is a
question with the same answer on every host. A skipped test is still written down; a deleted one is
not, so a deletion or a rename still fails. Both directions are worth re-checking whenever this is
used -- confirm the check passes with the capability absent, and fails with the case renamed away.

The general form of the trap: **"the runner collected it" and "the file declares it" are different
questions**, and a check that asks the first while meaning the second gives a different answer on
different machines.

---

## 5. monkeypatch, and the ESM constraint

This is the hardest of the eight, and the one this pilot spent the most design on.

**pytest.** `monkeypatch.setattr(module, "name", value)` rebinds an entry in the module dictionary.
Because Python resolves a module-level name at **call** time, a function *inside* that module calling
`name(...)` sees the replacement. Undone LIFO at teardown, snapshotting the value present at each
patch.

**ESM does not work that way.** Bindings are resolved at link time and cannot be rebound from outside.
`vi.mock` replaces a module for its **importers**, not for intra-module calls, so it does not reach
this case either.

**Rule.** Where the source patches a module internal, the target module exports a **seam record**, and
every internal call site goes through it:

```ts
export const migratorSeams = { migrationBusyTimeoutMs: 5_000, verifyReadonly, applyStep };
// ... and internally, always:
migratorSeams.verifyReadonly(target, steps, true);
```

Tests replace entries with `patchSeam` from `test/testkit/seams.ts`. This **reproduces** Python's late
binding rather than working around it: replacing an entry changes what production code calls, which is
the property the source case depends on.

**Rejected alternative: parameter injection.** Passing the dependency in as an argument changes the
production call graph. The test would then exercise a path that exists for tests, and the case would
no longer prove anything about what production does.

**Mutable module constants go on the same record.** A `export const` cannot be reassigned; Python's
module-level int can. The lock-contention case patches `MIGRATION_BUSY_TIMEOUT_MS` to 250 ms so the
test does not spend five seconds proving a wait happened.

**A seam needs a liveness test.** A seam can rot into a decoration: if a refactor makes production
call the underlying function directly, every case that replaces the seam entry stays green, because
the replacement is simply never reached and the assertions -- which are about refusals -- still hold
for the wrong reason. So each seam carries a **target-only** test asserting production routes through
it. See "seam liveness (target-only)" in `test/control_plane/migrator.test.ts`.

**Two more pieces of monkeypatch:**

- `monkeypatch.chdir` maps to `chdirForTest` (`test/testkit/cwd.ts`). The working directory is global
  to the worker; a test that changes it and does not change it back moves every test that runs after
  it, and under a shuffled order that is a different test each run.
- **Do not rely on `restoreAllMocks`.** It reproduces neither the per-patch snapshot nor the LIFO
  unwind, and it cannot touch a plain data key at all.

**Worked example.** `migrateInTheGap` in `test/control_plane/migrator.test.ts`, which installs a
wrapper that re-patches the same key **from inside itself** to disarm after one call. That is why
`patchSeam` snapshots at each patch: restoring only the outermost would leave the wrapper armed for
the rest of the file.

---

## 6. tmp_path

**pytest.** A unique directory **per test**, removed afterwards.

**Rule.** `caseRoot()` from `test/testkit/cases.ts` (built on `test/helpers/tmp.ts`): `mkdtemp`, keyed
by worker id, removed by `onTestFinished` whether the test passed or failed.

**The naive mapping and why it fails.** A fixed path such as `./tmp/test.db`, or one directory shared
by a file, produces failures that depend on which test ran first. That is the exact class of bug the
random ordering exists to expose, arriving as noise instead of signal.

**Two details that are easy to lose:**

- *The database path is a name, not a file.* Many ported cases assert the database does **not** exist.
  A helper that creates the file defeats them silently. `databasePath(root)` only joins a path.
- *Windows separators.* Never assert on a path string built with `/`.

**The one directory that is deliberately shared by a file.** `suiteRoot()` / `suiteTemplate()` (same
module, D-0025) give a directory whose lifetime is the **file**, and they are not an exception to the
paragraph above -- they are the narrow case it does not cover. What may live there is *build-once,
read-only* material that every case wants an identical copy of, and the expensive one is a migrated
control plane: about 87.5ms to create, about 0.97ms to copy. Each case still receives its own copy in
its own `caseRoot()` and still writes only there, so no case observes another's state and the
shuffled order stays meaningful.

```ts
const production = suiteTemplate("production.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

function productionDb(): string {
  return production.copyInto(caseRoot("cohort"));
}
```

Both must be called from the **top level of the file** -- not from inside a test, and not from inside
a `describe` body either. An `afterAll` registered inside a test is accepted by Vitest and then never
runs, so the directory would outlive the whole run; one registered inside a `describe` binds to that
block, so the directory is removed when the block finishes, while a sibling block or a later
top-level test is still using it. Both cases throw instead, naming which one it was.

---

## 7. caplog

**pytest.** `caplog.records` carries level, logger name, message, exception, and order.

**Rule.** Code under test takes a `LogSink`; tests inject `recordingSink()` from
`test/testkit/logsink.ts` and assert on **records**, not on rendered text.

**The naive mapping and why it fails.** `vi.spyOn(console, "error")` keeps only the formatted string,
so an assertion about *level* or *logger* has to be rewritten as a substring match against the line.
That match then passes when the formatter changes and the level does not, and fails when the formatter
changes and nothing else does. Neither outcome is about the property under test.

There is no ambient logger in continuo to spy on, which makes the naive mapping unavailable rather
than merely discouraged.

**Worked example.** `test/testkit/testkit.contract.test.ts`, "the log sink captures records, not
rendered text" -- **target-only**; interlock's suite uses `caplog` nowhere.

---

## 8. Scope contracts

**pytest.** `function`, `class`, `module` and `session` scopes differ in how often a fixture is built,
whether the same object is shared, and when it is torn down.

**Rule.**

- `function` scope -> a plain call inside the test. This is the default and should stay the default.
- `module` scope -> `beforeAll`, which in Vitest is **per file**, and only when the fixture is
  genuinely immutable.
- `session` scope -> **there is no equivalent.** Vitest gives each test file its own worker with its
  own module registry, so nothing built in a file is shared with another. A session-scoped fixture
  becomes either a pure module-level constant computed at import, or an explicit global owner recorded
  as a decision. A global setup file is a last resort.

**The naive mapping and why it fails.** Reading `beforeAll` as "once per run" gives a fixture that is
silently rebuilt per file. If it is expensive the suite slows for no visible reason; if it is
*mutable*, tests pass locally on one worker and fail under CI's different file distribution -- an
order-dependent red that the double-green rule will surface but that costs a full debugging cycle to
attribute.

**Prefer function scope when translating.** A shared fixture is a coupling, and the port's isolation
contract (D-0005) exists to keep couplings out. The pilot translates every fixture in its source file
to a per-test call, which is stricter than the source and therefore safe.

---

## 9. The port's types are wider than the source's

The eight rules above are about translating **tests**. This one is about porting **implementations**,
and it is here because it has produced more defects than any of them: **six, across three belts, all
the same shape.** Each was found by review rather than by a failing test, because in every case the
translated suite was green -- the source's own cases could not reach the state, since Python's types
excluded it.

> Wherever the source relies on a Python **type** to exclude a value, check whether the TypeScript
> type still excludes it.

Three families, with the instances found so far:

| Python excludes | TypeScript admits | Found in |
|---|---|---|
| `int` is never `NaN`, `Infinity` or fractional | `number` is all three | a transaction scope watermark; an external destination's watermark; a `KeyedDropbox` fencing token |
| `str(x)` on a `str` subclass reads the buffer; `__str__` cannot intercept an `==` | `String(x)` on a boxed string dispatches through a caller-replaceable `toString` / `Symbol.toPrimitive` | a protected table name; **executing unfenced SQL** through a builder-issued statement |
| `dict` has no inherited keys | an object literal carries `Object.prototype` | a fence map keyed by the caller's lease resource, where a resource named `constructor` or `__proto__` reads an inherited value |

The remedies are mechanical once the hazard is named: guard with `Number.isInteger(x) && x >= 1`;
take the primitive with `String.prototype.valueOf.call(x)`; build the map with `Object.create(null)`
and read it with `Object.hasOwn`.

**What makes this class dangerous is that the wider type is usually the *right* TypeScript type.**
`number` is what a millisecond timestamp should be, and an object literal is what a small map should
be. So there is nothing odd-looking to notice in review, and the ported tests cannot fail: the value
that breaks it is one the source's suite had no way to construct. The check has to be deliberate.

**Two questions worth asking of every ported module**, and worth answering in the porting report:

1. Which caller-supplied strings does it use as a map or object **key**?
2. Which `number` parameters does the source type as `int`?

Anything on either list is suspect until it has been checked.

## 10. Make it fail on purpose, and confirm it fails for the reason you expect

**The heading is the check, and the load-bearing words are "for the reason you expect".** Applying a
mutation and watching something go red is not enough: in every instance below, something *did* fail
or pass -- the condition being observed was simply a different one from the condition the case
names. A case that fails with the wrong message is protecting the wrong property, and it will keep
protecting the wrong property indefinitely, because it is green.

**The shape it catches.** *A case can go green because the thing it asserts became unreachable, not
because it holds.* Nothing is red, nothing is skipped, the ledger counts the case as coverage -- and
the property it names is unprotected. It is the translation hazard this port has hit most often, because
translating a case moves it onto a different runtime, a different launcher and a different file
layout, and each of those can quietly remove the path the assertion was watching.

Three instances, with what was measured. They are listed together on purpose: this section is the
one place to look for "where green has lied here".

1. **A missing build makes the deny hook deny for the wrong reason** (`DECISIONS.md` D-0209).
   `hook.mjs` resolves its dependencies from `dist/` when it runs as a real subprocess. Without a
   build it cannot load them and denies with `fence-unavailable` -- which is fail-closed, so every
   `decision == "block"` assertion still passes. Measured: with `dist/fencing/state.js` moved aside,
   **9 of the deny hook's 21 cases were green against a hook that never read a fence**. Answered by
   a `pretest` build plus an explicit `existsSync` guard in the suite.
2. **An exit-code assertion that no longer distinguishes anything**
   (`test/fencing/deny-hook.test.ts`). Interlock's hook exits **1** when it cannot load itself, so
   the source's `returncode != 1` is what separates "the fence denied this probe" from "the hook
   broke and denied by default". Continuo's hook denies with **2**, so `returncode != 1` plus
   `decision == "block"` is satisfied by a hook that never read a fence. Two cases needed a
   `rule_id` assertion added -- the deny has to be *the fence's* deny -- to keep meaning what their
   source meant.
3. **A glob that stopped covering the file that mattered**
   (`test/fencing/renderer.test.ts`, "the fencing package does not import the discarded transport
   module"). The source globs the package's `*.py`, which is every file in it. The translation
   globbed `*.ts` -- and then D-0204 shipped `hook.mjs`, so the most security-critical file in the
   package silently left the discarded-axis guard, which stayed green over the remaining files.
   Measured: with `transport.descriptor` appended to `hook.mjs`, the case **passed**. Fixed by
   globbing `.ts` and `.mjs`. Note the shape: *adding a file narrowed a check that names no file.*

**Applying it.** Break the thing the assertion is watching -- move the build aside, revert the repaired
behaviour, append the forbidden string to the file the glob should cover -- and read the failure. A
case that stays green is not protecting the property; a case that fails with a different message is
protecting a different one. Two rules follow:

- Do this for every case whose subject is *out of process* (a subprocess, a built artefact, a file
  discovered by pattern), because those are the paths a translation is most able to sever.
- Prefer an assertion that names the *specific* outcome (a rule id, an exact code set) over one that
  names a *class* of outcome (non-zero exit, "it refused"). Fail-closed defaults live in the class,
  so a class assertion is exactly what a broken component satisfies for free.

**The sibling hazard.** Read this alongside **rule 9, "The port's types are wider than the
source's"**. It is the same principle on the implementation side: the source relied on something
narrow that the target does not enforce, and nothing in the diff shows it. Instance 3 above is
literally that rule applied to a *test*: the glob defined its subject set by file extension rather
than by "every file in the package", so shipping one file under a new extension narrowed a check
that names no file at all. The two sections describe one failure mode reached from two directions --
a translated **check** whose reach silently shrank, and translated **code** whose accepted inputs
silently grew. Neither shows up as a red test, which is why both need a deliberate probe rather than
a reading.

**And the third direction: code the port adds that the source has no counterpart for** -- an extra
accepted shape, a new path, a "more general" check -- is unreachable by the source suite, the
differential oracle and the ledger alike; see `DECISIONS.md` D-0208, "Generalisations this port adds
are outside parity's reach".

---
## 11. A repair carries no warrant from the source

Rules 9 and 10 are about translated things going wrong quietly. This one is about the code that is
**not** a translation: repairs, generalisations, and anything else written because the port needed
it rather than because the source had it.

> A translated case or a ported function is backed by interlock: it was reviewed there, exercised
> there, and its shape is evidence. **A repair has none of that.** It is new code, written by
> someone who has just convinced themselves they understand the defect -- which is the least
> reliable moment there is -- and it sits in a file where everything around it *is* warranted. It
> inherits the neighbourhood's credibility without having earned any.

**The shape it takes here is specific and has recurred: a repair reintroduces the defect it repairs,
by a route the repair did not consider.** Four instances, all found by the review gate rather than
by a failing test:

1. **The orphaned transaction, reintroduced one module away** (`D-0024`). The repair hardened
   `transaction()` in `txn.ts` so a failed `COMMIT` could not leave an orphan for the next caller to
   join. The *same change* then routed the outbox's fenced write through `withImmediate` in
   `lease.ts` -- the other transaction helper, which had no such handling. The defect was back before
   the commit that fixed it had landed. There were two helpers and one was fixed: half a fix.
2. **The idempotent recovery path, broken by the guard protecting it** (`D-0026`). A predecessor
   check was added to `enqueueRelay` so a relay could not be enqueued ahead of the gate's stage --
   and placed *before* the existing-relay lookup. `enqueueRelay` is idempotent so a Secretary killed
   after its commit can replay without sending a human a second copy, and the crash window it is
   idempotent for is **exactly the one that moves the stage**. The guard refused precisely the
   replay the function exists to serve.
3. **A shared renderer emitting text that is not JSON.** `pythonJsonDocumentSorted` was written to
   end four drifting copies of `json.dumps`. It built arrays with `.map`, which skips the holes in a
   sparse array, so `[1, , 2]` rendered as `[1, , 2]` -- rejected by the `json_valid` CHECK, so a
   fact that should have been recorded would have been refused instead. Python has no sparse array;
   the generalisation invented the input class and then mishandled it.
4. **A shared renderer replacing a typed refusal with a stack overflow.** The same consolidation gave
   `pythonRepr` recursion without cycle detection, so a cyclic value handed to a validation guard
   raised `RangeError` instead of the refusal the guard documents -- the error about the bad input
   replaced by an error about rendering it.

**Why it keeps happening.** A repair is reviewed against *the defect it names*, and it usually fixes
that. What is not reviewed is the set of paths the repair newly touches -- a second helper, an
earlier position in a function, an input class the source could not produce. Instances 1 and 2 both
passed every existing test: the suites were translated from a source that has the original defect,
so **nothing in them was ever going to notice.**

**Applying it.**

- **Ask what else reaches this.** If the defect is a missing guard, find every entry point that
  should have it -- `grep` for the sibling helper, the other constructor, the second call site --
  before deciding the repair is complete.
- **Ask what the code you are editing already guarantees**, and whether the repair can break it. A
  guard inserted into a function is inserted *somewhere*, and "before or after the idempotency
  check" is a behavioural decision wearing the clothes of a formatting one.
- **Pin the repair AND the thing it must not break.** Both instances above now carry a target-only
  test for each half, and rule 10's probe applies to both: revert the repair, confirm its test goes
  red; then revert only the *ordering*, and confirm the other test goes red.
- **Read the failure, not the colour.** "It went red" is not the observation -- the message and the
  error type are. A probe can go red for a reason that has nothing to do with the property: a
  collection-time crash, a fixture that never built, a module that failed to import. Each of those
  reports red while the assertion under examination never ran, so the probe confirms nothing and
  reads as though it confirmed everything. This matters more for a repair than for a translation,
  because a repair's probe is usually the *only* evidence that the new code does what it claims.
  See rule 10, which carries a measured instance of exactly this.
- **Treat a generalisation as a repair.** A shared helper replacing N copies is new code with no
  source counterpart, and it acquires input classes none of the copies had.

**The sibling hazards.** Rule 9 is the source relying on something narrow the target does not
enforce; rule 10 is a translated check whose reach silently shrank. This rule is the third face:
**code the source never had, trusted because of the code around it.** All three share the property
that makes them expensive -- no red test, nothing odd in the diff -- and all three want the same
answer, which is rule 10's: break it deliberately and read the failure.

## Patterns with no source case

Three of the eight -- **strict/non-strict xfail**, **skip semantics**, and a **`caplog`-equivalent
sink** -- have no instance anywhere in the subsystem this pilot ports. Interlock's `control_plane`
suite contains no `skip` and no `xfail`; the whole suite has one xfail (in `messagebus`) and uses
`caplog` nowhere.

So their rules are written above and demonstrated by **target-only** contract tests in
`test/testkit/testkit.contract.test.ts`. Inventing a source case to translate would have put a node id
in the parity ledger that does not exist in interlock, which is a worse outcome than a documented gap:
it would make the ledger -- the artifact whose whole purpose is to be trustworthy about coverage --
lie.

**Target-only tests are never counted as ported coverage.** They are listed separately in the ledger
(`target.target_only_tests`) and the parity check requires each declared one to exist.

---

## The parity ledger

One entry per **collected source node id**, with `disposition`, `source_status`, `target_status`,
`reason`, and `source_revision`.

### Dispositions

| disposition  | meaning |
|---|---|
| `ported`     | translated straight; asserts what the source asserts |
| `adapted`    | a runtime difference made a straight translation impossible; the **property** is preserved and `reason` says exactly what changed |
| `not-ported` | not translated; `reason` says why and what unblocks it |
| `waived`     | translated **weaker** than the source. Requires an approved waiver and is an explicit review topic |

There are **no waivers in this pilot**. Five cases are `adapted` and two are `not-ported`; the
reasons are in the ledger.

The ledger also carries an `inherited_limitations` list, for rough edges the port **reproduces**
rather than fixes. A parity port that quietly improves on its source is no longer a parity port, and
interlock#74's acceptance criteria require known limitations to stay disclosed. Each entry says what
the behaviour is, that it matches the source, and where a fix belongs. **That last part is
continuo's**: interlock is frozen (`D-0023`, `D-0036`), so an inherited defect is repaired here, at
the first belt that touches it, and `inherited_limitations` records what is reproduced *pending that
repair* -- not what is queued for someone upstream to fix.

An `adapted` case must still be *at least as strong* as its source in the property it pins. If it is
weaker, it is a waiver, and that is a report to the reviewer -- see rule 0.

### What the check enforces

`scripts/parity-check.mjs`, run by `npm run parity` and by the `parity` CI job (wired into `ci-gate`):

1. **missing** -- a source case with no ledger entry, or a mapped target test that does not exist.
2. **duplicate** -- one source case claimed twice, or two source cases pointing at one target test.
3. **unmapped** -- a target test in a ported file that no entry claims and that is not declared
   target-only.
4. **unapproved non-running tests** -- any `skip`, `todo`, `fails` or `xfail` under `test/` beyond
   what a ledger approves. Approvals carry an **exact count per construct per file**, so one
   approved example does not license every later skip in that file, and an approval that matches
   nothing is itself flagged. Comments and string literals are excluded, so a test *named* after a
   construct is not counted as one.
5. **shrinkage** -- fewer source cases in the inventory than the recorded baseline.
6. **totals** -- the recorded totals must reconcile **exactly** with the entries, per disposition. A
   one-sided "not fewer than" check is satisfied by lowering the baseline in the same edit that
   removes the coverage; reconciling means the totals cannot be quietly re-based, so a real change
   to them is a diff a reviewer sees. An unknown disposition, or a `ported` entry with no target id,
   fails here too.
7. **unexplained** -- an `adapted` or `not-ported` entry with no reason.

Each of these seven has been observed failing; a check never seen red is not a check.

### The source inventory

`parity/source-inventory/` holds node id snapshots taken from interlock at the recorded revision, so
the check runs without an interlock checkout. It is **complete**: every node id pytest collects from
interlock at `65f36c5`, all 2,194, across all 18 subsystems -- not only the ones a belt has claimed.

Collect the **whole suite once** and split the output by path afterwards:

```
PYTHONPATH=<interlock>/src PYTHONDONTWRITEBYTECODE=1 \
  python3 -m pytest tests/ --collect-only -q -p no:cacheprovider
```

Not once per subsystem. A single-directory run and a whole-tree run are different measurements --
conftest hooks and import order differ between them, so the two can collect different sets and
nothing in the resulting files would say which you got.

Each file holds **node ids and nothing else**. No comments, no notes, no blank lines: the parity
check reads every non-empty line as a node id, so a `# ...` line there is a source case that does
not exist. Everything that is *about* the inventory goes in the manifest below instead.

### The inventory manifest, and the two things it keeps apart

`parity/source-inventory.manifest.json` is the inventory's index: the interlock revision, the exact
collection command and the Python and pytest versions that produced it, every subsystem and file
with its count, and the reconciliation with the suite baseline.

It also records the **five modules pytest never collects**. Each has a module-level
`pytest.importorskip("claude_org_runtime.broker.server")`, so it contributes no node id and cannot be
inventoried. They are named in the manifest with the reason each file gives, rather than represented
as empty inventory files -- an empty file cannot be told apart from a generation failure, and a
fabricated node id would be a case that does not exist.

What the manifest deliberately does **not** hold is porting intent. Being in the inventory is
evidence that a case exists, not a commitment that it will be ported; if the inventory only held
what someone had decided to port, the denominator would move with every decision and could never be
reconciled against interlock. Which subsystem belongs to which belt, and which is proposed for no
port at all, lives in `parity/source-inventory.belts.md` and is a human gate. See `D-0031`.

### What the inventory check enforces

`scripts/source-inventory-check.mjs`, run by `npm run inventory` and by the `parity` CI job. It
exists because `parity-check.mjs` only reaches the inventories a **ledger** points at, which leaves
every not-yet-ported subsystem checked by nothing:

1. **stray** -- an inventory file the manifest does not name, or a named file that is absent.
2. **shape** -- a line that is not a node id under the file's own source path. This is what keeps
   the inventories comment-free.
3. **count** -- a recorded count that disagrees with the lines, or totals that do not add up.
4. **aggregate** -- a `.all.txt` that is not exactly the concatenation of its per-file inventories.
5. **duplicate** -- one node id in two inventories, which is how a total reaches 2,194 while holding
   fewer distinct cases.
6. **baseline** -- node ids plus collection-time-skipped modules must be the collected total, and
   the outcome breakdown must add up to it too.
7. **fabricated** -- a node id from a module recorded as skipped at collection time.
8. **unclassified** -- a subsystem the belts document gives no status, in its own heading or its
   row in the summary table. Prose is not a classification: `session` is named in `gate_item2`'s
   paragraph beside the word `candidate-lane`, so a substring search read it as classified after
   both of its own entries were deleted. It checks that a status was *given*, never which one: the
   answer is a human's, and a check that enforced today's answer would make changing it a fight
   with CI.

Each of these eight has been observed failing; a check never seen red is not a check.

**What it cannot check.** Node ids are recorded in pytest's collection order, and nothing offline
says what that order is -- running without an interlock checkout is the point of a committed
snapshot. `aggregate` verifies that a `.all.txt` is its per-file inventories concatenated; it cannot
verify that those files are in collected order. Six measurement inventories were alphabetised
instead and passed everything here until a reviewer re-ran the collection. Order is a claim the
regeneration procedure makes, and re-running it is the only thing that tests it.

### The suite baseline

Interlock at `65f36c5` is **2,199 collected = 2,190 passed + 8 skipped + 1 xfailed**. Reproduced on
the porting host as **2,194 collected + 5 modules skipped at collection time** (pytest reports
collection-time skips separately from the collected count); 2,194 + 5 = 2,199. Five of the eight skips
are those collection-time ones.

That reconciliation is recorded in the ledger rather than left as a discrepancy, because a baseline
nobody can reproduce is a baseline nobody can check.

---

## The testkit is frozen

`test/testkit/` is **frozen when this pilot merges**. Later belts import it read-only; a change to it
is its own PR, merged before the belts that need it rebase onto it. That is deliberate friction: a
shared helper edited in passing by one belt silently changes what every other belt's tests assert.

Belt-specific helpers live under the belt's own directory until they have earned promotion.

---

## Checklist for a translated file

- [ ] Every collected source node id has a ledger entry, including every `parametrize` expansion.
- [ ] Target ids are `parametrize()`-stable, not template-interpolated.
- [ ] Every `pytest.raises` keeps **both** halves -- type and message -- via `expectRefusal`.
- [ ] No `match` string is satisfied by the case's own temp path. Refusals interpolate the database
      path, `caseRoot(label)` puts the label into it, and `match` is a *search*, so a label sharing a
      word with a refusal message makes that assertion unfailable -- see `DECISIONS.md` D-0020, where
      `caseRoot("spike-schema")` silently reduced four cases to a bare `instanceof` check. Keep
      labels short module nicknames, and check the literal against the path.
- [ ] Every fixture's cleanup is registered at acquisition.
- [ ] No `skip`, `todo` or `xfail` that the ledger does not name.
- [ ] No seam without a liveness test.
- [ ] Every caller-supplied map key and every `int`-typed number in the ported module has been
      checked against rule 9, and the answer is in the porting report.
- [ ] Every case whose subject is out of process -- a subprocess, a built artefact, a file found by
      pattern -- has been made to fail on purpose once, and failed for the expected reason. See
      [Make it fail on purpose](#10-make-it-fail-on-purpose-and-confirm-it-fails-for-the-reason-you-expect).
- [ ] `npm run parity` passes, and the suite is green **twice** at two distinct seeds.
