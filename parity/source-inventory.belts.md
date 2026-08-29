# The remaining subsystems, and which belt each is a candidate for

`parity/source-inventory/` now holds every node id pytest collects from interlock at `65f36c5` --
2,194 of them, across 18 subsystems. That is a **complete evidence set**, and it is deliberately
larger than what continuo has agreed to port.

Those two things have to stay apart. An inventory that only listed the cases someone had already
decided to port could never be reconciled against interlock's suite baseline, because the
denominator would move every time a decision changed; and it would answer "is anything missing?"
with "nothing we chose to look at." So the inventory takes everything, unconditionally. **Being in
the inventory is evidence that a case exists, not a commitment that it will be ported.** This
document is where the second question is answered. When it was first written, every answer below
was a *proposal* and none was settled here; statuses that have since passed the human gate are
marked **ratified** with a date, and only those are settled. Unmarked statuses remain proposals.

The status vocabulary:

| status | meaning |
|---|---|
| `in-scope` | a belt is porting it now or has -- either named by interlock#74's acceptance criteria, or ratified into scope at the human gate |
| `candidate-lane` | a coherent belt of its own; the cases would port largely as they stand |
| `retarget` | the invariants carry, but they are written against a mechanism continuo does not have, so a port has to re-point them first |
| `decision-pending` | whether continuo carries this surface at all is undecided upstream; porting the tests presupposes the answer |
| `not-porting` | no port, with a reason -- a proposal until marked ratified |

Where interlock's own `PORTING_LEDGER.md` has already classed a file, that class is cited: it is the
stronger evidence, because it was written by the people deciding what v2 keeps. Where it has not --
the directories that are interlock's own v2 work rather than v1 material -- the proposal below rests
on what the tests drive, and says so.

---

## Already in scope

| subsystem | cases | status | note |
|---|---|---|---|
| `control_plane` | 585 | `in-scope` | Ported. interlock#74 acceptance criterion 1. |
| `measurement` | 425 | `in-scope` | Ported. Acceptance criterion 3. |
| `fencing` | 124 | `in-scope` | Ported. Acceptance criterion 2. |
| `settings` | 183 | `in-scope` | Ported. `tests/test_settings_generator.py` and `tests/test_sandbox_symlink_deny.py`, both root-level files, carried under the `settings` name because that is the module they drive. |

That is 1,317 of the 2,194 -- the inventory as it stood before this document existed.

## The remaining 877

### `session` -- `in-scope` (ratified 2026-08-28) -- **ported: 142 of 142 cases**

Ratified into scope at the human gate on 2026-08-28 (D-0032); belt started and **completed**
2026-08-29, D-range `D-03xx` (`D-0301`..`D-0302` used).

The status keeps its `in-scope` spelling for the reason the `canary` section above gives: the
vocabulary this document is checked against records **porting intent** (D-0031), and finishing a
belt does not retract the decision to take it on.

`tests/session/` drives `claude_org_runtime/session/`: the provider contract, a
stub provider, and the Claude CLI provider. A provider/process-lifecycle belt is the natural unit,
and `test_provider_contract.py` is written as a contract battery, which is the shape that ports
best -- one implementation-independent set of assertions, run against each provider. Ported to
`src/session/` (`provider.ts`, `stub_provider.ts`, `claude_cli_provider.ts`, `uuid5.ts`,
`index.ts`, and `runtime.ts` -- the single seam described below).

**All 142 cases are translated: 129 `ported`, 13 `adapted`, 0 `not-ported`, 0 waivers**, across
three ledgers -- one per source file, per D-0019:

| source file | cases | ledger |
|---|---|---|
| `tests/session/test_claude_cli_provider.py` | 65 | `parity/session.claude-cli-provider.ledger.json` |
| `tests/session/test_stub_provider.py` | 43 | `parity/session.stub-provider.ledger.json` |
| `tests/session/test_provider_contract.py` | 34 | `parity/session.provider-contract.ledger.json` |

Twenty-two further target-only cases sit beside them, and a thirteen-case UUIDv5 differential
(`test/session/uuid5.test.ts`, which has no source file and so no ledger, like the other oracles
and contract batteries under `test/`). Most of the twenty-two exist because a mutation showed the
property was unprotected: Python's `Enum`, `frozenset` and `private`-by-convention all close things
at runtime that TypeScript closes only at compile time, so a member list, a capability set and a
closed vocabulary each had to be made genuinely immutable and then pinned. The rest pin what the
port had to invent and the source therefore carries no warrant for -- the seam liveness for each
substituted key, and both halves of D-0301 (the per-instance exclusion queue and the macrotask
settle before any read of a child's exit status), each of which could be deleted entirely with the
whole belt still green until its case was written.

**The belt's one structural decision is D-0301.** interlock supervises children with blocking calls
and uses that as a guarantee; Node releases a child's exit status only on an event-loop turn, so
the five verbs became `Promise`-returning, serialised per provider instance, with the capability
probe left synchronous on `spawnSync`. Everything asynchronous is confined to one runtime adapter
(`src/session/runtime.ts`), and within it exactly four members are async -- the ones that wait on an
already-running child. The normal test path drives a **real** child process; the seam is substituted
only for the three branches a real child cannot reach.

It is also the belt several others wait on: `gate_item2` drives crash-and-retry *through* a session
provider, and `gate_item11` exists to assert that no provider detail leaks into the control plane.
Porting those before `session` would mean porting their fixtures twice -- both can now take the
fixtures this belt brings.

**Two things left for a Windows cell to answer**, recorded here rather than guessed. interlock's
own `os.name != "posix"` branches are marked `# pragma: no cover - exercised only on Windows`, so
continuo's matrix is the first place they run anywhere: `test_stop_terminates_a_running_child_and_
reports_what_is_left` and `test_a_child_whose_pid_cannot_be_recorded_is_not_left_running` take that
branch, and the second additionally requires the state directory to be gone, which Windows refuses
while any handle inside it is open. No Windows-only gate was added for them -- inventing a skip the
source does not have is what the parity check exists to catch -- and the child-leak hazard behind
the second was retired structurally instead, by making every teardown await its child's exit rather
than merely signal it.

### `attention` -- `retarget` -- 194 cases

Every file here is classed in `PORTING_LEDGER.md` as either `carry (invariant) / rewrite
(mechanism)` or `rewrite`; **none** is a straight carry. `test_classifier.py` (61) carries the
strongest invariant -- that every fact-vocabulary row has a pinned expectation -- but the mechanism
is re-derived onto a closed fact-state set. `test_dedup.py` is called out explicitly: its two
corruption cases pin "malformed state loads as an empty `DedupState`", and the ledger rules that
behaviour out for durable dedup state, so those two must be re-authored to assert fail-closed
rather than ported.

That last point is why this is `retarget` and not `candidate-lane`: a straight translation here
would carry a behaviour the source repository has already decided is wrong, and continuo's D-0023
says an inherited defect is repaired at the first belt that touches it, not reproduced.

### `fault_injection` -- `candidate-lane` -- 98 cases

An acceptance harness rather than a product module. There is no
`claude_org_runtime/fault_injection/`; `test_conformance.py` is a battery run against every adapter
a build ships, and `test_manifest.py` / `test_protocol.py` / `test_import_graph.py` pin the shape
adapters must satisfy. Continuo already has the same instinct in `test/contract/`, so this may end
up merged into that directory rather than given a directory of its own. The Issue names fault
injection specifically, which is the argument for a belt; the counter-argument is that a conformance
battery with one adapter in it is a battery for a build continuo does not yet have.

### `canary` -- `in-scope` (ratified 2026-08-28) -- **ported: 70 of 70 cases**

Ratified into scope at the human gate on 2026-08-28 (D-0032); belt started and **completed**
2026-08-28, D-range `D-04xx` (`D-0401`..`D-0405` used -- `D-0405` schedules one repair the belt
found and deliberately did not make, and is the belt's one piece of open work).

The status keeps its `in-scope` spelling because the five-value vocabulary this document is checked
against records **porting intent** (D-0031), and completion is a different axis from intent -- the
belt being finished does not retract the decision to take it on. What changed is the second half of
the heading, and the detail below.

A canary/rollout belt. Drives `claude_org_runtime/canary/`: a routing ledger with
database-enforced guarantees, an audit, synthetic v1 fixtures. Ported to `src/canary/`
(`ledger.ts`, `routing.ts`, `audit.ts`, `synthetic_v1.ts`, `marking.ts`, `routing_ledger.sql`) with
the written record at `docs/canary-routing-rehearsal.md`.

**All 70 cases are translated: 54 `ported`, 16 `adapted`, 0 `not-ported`, 0 waivers**, across six
ledgers -- one per source file, per D-0019:

| source file | cases | ledger |
|---|---|---|
| `tests/canary/test_ledger.py` | 27 | `parity/canary.routing-ledger.ledger.json` |
| `tests/canary/test_audit.py` | 18 | `parity/canary.routing-audit.ledger.json` |
| `tests/canary/test_routing.py` | 11 | `parity/canary.routing.ledger.json` |
| `tests/canary/test_synthetic_v1.py` | 8 | `parity/canary.synthetic-v1.ledger.json` |
| `tests/canary/test_structural.py` | 5 | `parity/canary.structural.ledger.json` |
| `tests/canary/test_rehearsal.py` | 1 | `parity/canary.rehearsal.ledger.json` |

Eleven further target-only cases sit beside them, covering machinery the port had to write and the
source therefore carries no warrant for: the `dist/` placement of the DDL (D-0404), the seam
liveness, the rollback journal, a refused open leaving no sidecar, the store enforcement holding on
a *reopened* ledger and against a *foreign* connection, the result-code/message disagreement that
D-0402 turns on, and the two 64-bit-integer cases -- the audit's digest and the routing snapshot
each hold a value a double cannot carry, which Python's arbitrary-precision `int` gave the source
for free and this port had to be repaired to get (D-0023).

**Not to be confused with `measurement.test_canary.txt`,** which was already ported and covers
`tests/measurement/test_canary.py` -- the measurement harness's view of a canary, not the canary's
own store. The two names sit next to each other in the inventory directory and mean different
things, and the ledgers keep them apart by name: every ledger above is prefixed `canary.`, and the
harness's is `measurement.canary.ledger.json`. There is deliberately no bare `canary.ledger.json`.

`test_ledger.py`'s framing is why this was a good candidate, and it held: it says the guarantees must
be refused *in the store, not in the discipline of the writer*, which is exactly the property
continuo ports well (`control_plane` is 585 cases of it). D-0401 is where that framing landed --
`recursive_triggers = ON` is the pragma without which `INSERT OR REPLACE` walks straight through the
immutability triggers.

### `curator` -- `decision-pending` -- 71 cases

`tests/curator/` covers skill-candidate promotion: a digest, a path audit, and
gate item 9's five negatives. The promotion gate's whole premise is that a filesystem write into a
live skill directory *is* the promotion, which is a claim about running Claude Code sessions --
continuo is a library, and whether it owns that surface at all is not settled. Porting the tests
would settle it by implication.

If the answer is yes, `test_promotion_gate.py` is high-value: every negative asserts both that the
decision was a refusal *and* that nothing landed on disk, which is the two-sided shape that catches
a gate that refuses in name only.

### `gate_record` -- `not-porting` (ratified 2026-08-28) -- 64 cases

Ratified at the human gate on 2026-08-28: continuo does not port this subsystem, on the grounds
below.

`tests/gate_record/test_gate_record.py` makes structural checks on
**interlock's own `docs/gate-record.md`**: that eleven items are present and distinct, that the
summary table and the per-item sections agree, that item 2's C1 failure has not been tidied away.
The subject is a document continuo does not have and would not gain by having a copy of.

The *technique* is worth keeping and continuo already uses it -- `test/contract/carried-documents.test.ts`
polices carried prose the same way -- so this is a case of the property being held natively rather
than of it being dropped.

### `gate_item11` -- `retarget` -- 64 cases

The property is real and worth having: no session-backend detail may leak into the
control plane, asserted structurally so a leak fails the build the day it is introduced. But
`test_no_provider_detail_leaks.py` asserts it over Python imports of a Python package, and
`test_suite_runs_unchanged.py` measures it by running interlock's suite. Both need re-derivation
against continuo's module graph before any of the 64 cases mean anything. Continuo has the machinery
for that already -- `import.meta.glob` package walks (D-0114) and the write-scan (D-0115).

### `gate_item2` -- `candidate-lane` -- 34 cases

Downstream of `session`. Every case runs a crash-and-retry through the control
plane and asserts a durable row rather than an exit code, which is a shape that translates directly.
It needs the provider fixture that `session` brings, so it is a belt that follows rather than a
belt that leads.

### `broker` -- `retarget` -- 54 cases collected, 4 further modules not collected

The only subsystem where the inventory and the source directory disagree in size.

Collected: `test_residents.py` alone, 54 cases -- process-identity fault injection through injected
platform seams. `PORTING_LEDGER.md` classes it `carry (invariant) / rewrite (mechanism)` and names
the catch: `residents._hostname` and `residents._clock_ticks` are **not** injectable and are reached
by twelve `monkeypatch.setattr` calls on module globals. Making those two seams injectable is part
of the port, not a detail of it.

Not collected, and therefore not in the inventory at all:
`tests/broker/test_control_plane.py`, `test_delivery.py`, `test_notify.py`, `test_store.py`, and
`tests/attention/test_broker_journal_contract.py`. Each is quarantined by a module-level
`pytest.importorskip("claude_org_runtime.broker.server")` under interlock#39, because they drive
`broker/server.py`, which `PORTING_LEDGER.md` classes discard; the source's own instruction is to
re-target them onto the MessageBus rewrite (`Q-0023`). They are recorded in
`parity/source-inventory.manifest.json` under `collection_time_skips`, with the reason each file
gives, and they have **no node ids** -- pytest never collected them, so there is nothing to
inventory and nothing may be invented.

Whatever continuo decides about them, it decides after interlock does. They are `retarget` upstream
first.

### `messagebus` -- `in-scope` (ratified 2026-08-28) -- **ported: 43 of 43 cases**

Ratified into scope at the human gate on 2026-08-28; belt started 2026-08-28 and **completed**
2026-08-29, D-range `D-05xx` (`D-0501`..`D-0504` used).

The status keeps its `in-scope` spelling for the reason the `canary` and `session` sections give:
the vocabulary this document is checked against records **porting intent** (D-0031), and finishing a
belt does not retract the decision to take it on.

A durable-messaging belt, and the destination the five quarantined broker modules
above are pointed at. `tests/messagebus/` drives `claude_org_runtime/messagebus/`: the bus, an
endpoint, carried specifications, a stale-readout case, and an import-graph guard. It is small now
and will not stay small, which is an argument for porting it early rather than late -- continuo's
`control_plane/outbox.ts` is already the at-most-once half of the same problem.

Ported to `src/messagebus/` (`bus.ts`, `endpoint.ts`, `index.ts`) -- three modules and no data file,
which is itself the belt's headline decision.

**All 43 cases are translated: 18 `ported`, 23 `adapted`, 2 `not-ported`, 0 waivers**, across five
ledgers -- one per source file, per D-0019:

| source file | cases | ledger |
|---|---|---|
| `tests/messagebus/test_import_graph.py` | 16 | `parity/messagebus.import-graph.ledger.json` |
| `tests/messagebus/test_messagebus.py` | 10 | `parity/messagebus.bus.ledger.json` |
| `tests/messagebus/test_endpoint.py` | 8 | `parity/messagebus.endpoint.ledger.json` |
| `tests/messagebus/test_carried_specifications.py` | 7 | `parity/messagebus.carried-specifications.ledger.json` |
| `tests/messagebus/test_stale_readout.py` | 2 | `parity/messagebus.stale-readout.ledger.json` |

One further target-only case sits beside them -- a probe that writes a file naming every route
around the import scan (a type-only import, an `export ... from`, a `require()` and a dynamic
`import()` inside function bodies) and asserts the scan sees all four and judges all four session
edges. The source's import-graph file has no probe; this port had to rewrite the scan in another
language with two extra escape routes in it, so the machinery is defended in the target the way
`canary` and `secretary` defend theirs.

**The two `not-ported` cases are both parametrizations over a file that does not exist here.** The
suite-side confinement check is parametrized over a **directory listing**, and interlock's
`tests/messagebus/` holds eight files where continuo's `test/messagebus/` holds six: `__init__.py`
is Python's package marker, and `conftest.py` is pytest's fixture module, whose two fixtures live in
`_env.ts` beside the module they were built on. Neither has a TypeScript counterpart to name, and
inventing an id for one would put a case in the ledger that asserts nothing. **No coverage is lost:**
the listing is still a listing, so every file the directory actually holds is scanned, and a file
added later gets a case -- and an unmapped-target failure until it gets a ledger entry too.

**The belt's headline decision is D-0501: this package adds no delivery store.** interlock's own
`bus.py` opens by defining itself as a thin facade that uses the S7 outbox API *as found*, and that
constraint is what makes the belt small. `send` is a registry lookup then `Outbox.enqueue`; `poll` is
`Outbox.due` filtered to one recipient, each row re-read and then `Outbox.attempt`; `ack` is a
recipient-boundary check then `Outbox.recordAck`. Retry counting, the delivery state machine, lease
fencing, destination dedup and ack persistence stay in `src/control_plane/outbox.ts` -- already 74
ported cases of exactly those -- because two answers to a delivery question is how a message gets
delivered twice or not at all. The package therefore ships no table, no migration and no DDL, and
the import-graph walk fails on a non-TypeScript file appearing in it rather than skipping one.

**The one xfail in interlock's entire 2,199-case baseline is in this belt** and is carried as one:
`test_a_send_to_a_registered_alias_reaches_the_canonical_recipient` is a v1 invariant the new
contract does not satisfy yet, landed failing through `test/testkit/marks.ts`'s strict `xfail` --
the helper written for a case no belt had met until now -- with its approval and its reason in
`parity/messagebus.carried-specifications.ledger.json`.

**What item 6 asked for in CI is here as a running test.** `test/messagebus/import-graph.test.ts` is
the static assertion that no messagebus module takes a dependency edge to a session backend, and its
mirror -- that only the stale-readout case in this suite knows the session vocabulary, and that it
reaches the control plane only through the suite's helpers. The stale-readout case itself drives a
**real** stub-provider child process into both stalenesses interlock names (a session id whose child
is gone; a `readState` that answers "could not observe") and asserts the delivery transcript is
*equal* to the one recorded with no session backend in the process at all -- not similar, equal.

**One piece of open work, recorded rather than done: D-0504.** This is the third structural AST scan
in the repository and the third copy of `importedModules`. `test/testkit/` is frozen and a change to
it is its own PR (`docs/test-translation-conventions.md`), so the extraction is written down as the
right end state and deliberately left for that PR rather than smuggled into a belt.

### `scrub` -- `not-porting` (ratified 2026-08-28) -- 20 cases

Ratified at the human gate on 2026-08-28: continuo does not port this subsystem, on the grounds
below.

`tests/scrub/test_scrub.py` verifies `tests/scrub/scrub_fixture.py`, a
deterministic PII/secret scrubber used to promote real `.state/` snapshots into publishable
fixtures. `PORTING_LEDGER.md` classes both `carry`, and rightly: it is the pipeline that makes
accident-derived fixtures publishable at all.

The decision to not port is about *where*, not *whether*. It is developer tooling that runs over
interlock's own captured state, in the repository that captures it. A TypeScript re-implementation
would be a second scrubber to keep in agreement with the first, over the same policy
(`docs/scrub-policy.md`), and a disagreement between two scrubbers is a leak. Better that continuo
consume the fixtures interlock's scrubber produces.

### `secretary` -- `in-scope` (ratified 2026-08-29) -- **ported: 11 of 11 cases**

Ratified into scope at the human gate on 2026-08-29; belt started and **completed** 2026-08-29,
D-range `D-07xx` (`D-0701` used).

As with `canary`, the status keeps its `in-scope` spelling because the five-value vocabulary this
document is checked against records **porting intent** (D-0031), and completion is a different axis
from intent.

An observation / human-gate belt, most likely alongside `attention`. Gate item 8's
behavioural half: the intake answers while every consumer stalls, with the stall made *verifiable*
rather than assumed and no latency threshold invented (`Q-0011` is open). Small, and it depends on
nothing else in this list -- which made it a reasonable first port for anyone wanting the shape of
this belt before committing to `attention`'s 194.

Ported to `src/secretary/` (`intake.ts`, `index.ts`) with the written record at
`docs/secretary-intake-boundary.md`.

**All 11 cases are translated: 2 `ported`, 9 `adapted`, 0 `not-ported`, 0 waivers**, across two
ledgers -- one per source file, per D-0019:

| source file | cases | ledger |
|---|---|---|
| `tests/secretary/test_behaviour.py` | 6 | `parity/secretary.behaviour.ledger.json` |
| `tests/secretary/test_structural.py` | 5 | `parity/secretary.structural.ledger.json` |

The `adapted` count is high for a belt this small, and it is all one cause: **the source's design is
written against CPython's concurrency and continuo does not have it** (D-0701). Three consequences,
each recorded in its ledger entry. `submit()` is synchronous and run-to-completion, so the source's
tolerance for a lock-free capacity check overshooting by `P - 1` is not carried and the accepted
count is asserted exactly. The structural "no lock at all" case is re-pointed from `with lock:` --
which has no TypeScript spelling -- to `await`, the wait a ban on called names cannot see in this
runtime. And the three stall cases keep a stalled consumer that is *verifiably* stalled by state
order rather than by a clock, with the one case whose subject is a genuinely blocked thread keeping
a real one: a `worker_threads` worker parked in `Atomics.wait`.

One target-only case sits beside them, covering machinery the port had to write and the source
therefore carries no warrant for: the two AST scans are probed against their own escape routes (a
type-only import, a relative specifier climbing out of the package, `require()` and dynamic
`import()` in a function body, an aliased blocking call, an element-access blocking call).

**No numeric latency threshold is stated or used anywhere in the belt.** `Q-0011` is open, this is
item 8's *rehearsal* and not its discharge, and the runner's timeouts bound how long a failing run
hangs rather than how fast a passing one must be.

### `migrate` -- `decision-pending` -- 11 cases

`tests/test_migrate.py`, fixture-driven checks of v1 to v2 key normalisation.
`PORTING_LEDGER.md` classes it `rewrite`, against "whatever migration/comparison bridge the run
boundary cutover needs" -- a bridge that does not exist yet in either repository. Two of its cases
call `pytest.importorskip("jsonschema")` inside the test body rather than at module level, so unlike
the broker five they *are* collected and *are* in the inventory; they will skip on a host without
`jsonschema` and continuo will need a decision about the equivalent dependency.

### `package_smoke` -- `not-porting` (ratified 2026-08-28) -- 1 case

Ratified at the human gate on 2026-08-28: continuo does not port this subsystem, on the grounds
below.

On the grounds that the property is already held. `tests/test_smoke.py` is
a five-line import check asserting `claude_org_runtime.__version__ == "0.1.42"` --
`PORTING_LEDGER.md` classes it `rewrite` for exactly that reason: it is package plumbing, re-created
for the new package rather than carried.

Continuo already has it, twice over and more strictly: `src/about.ts` holds `TOOL_VERSION` as a
literal and a test pins that literal to `package.json`, and `test/smoke/` checks that the built
package loads its native dependency at all. Porting a version assertion about a Python package
continuo does not ship would assert nothing.

---

## What this adds up to

| status | subsystems | cases |
|---|---|---|
| `in-scope` | `control_plane`, `measurement`, `fencing`, `settings`, `canary` (**ported** 2026-08-28), `session` (**ported** 2026-08-29), `messagebus` (**ported** 2026-08-29), `secretary` (**ported** 2026-08-29) | 1,583 |
| `candidate-lane` | `fault_injection`, `gate_item2` | 132 |
| `retarget` | `attention`, `gate_item11`, `broker` | 312 |
| `decision-pending` | `curator`, `migrate` | 82 |
| `not-porting` (ratified 2026-08-28) | `gate_record`, `scrub`, `package_smoke` | 85 |
| | **18** | **2,194** |

With the 85 `not-porting` cases ratified out, continuo's effective porting target is
**2,194 − 85 = 2,109** node ids -- the pool of cases not declined, not a commitment to port all of
it: within that pool, every status not marked ratified remains a proposal. The inventory itself
stays at 2,194: the evidence set is unconditional and does not shrink with the decision.

Plus the 5 modules skipped at collection time, which have no cases: 2,194 + 5 = 2,199, interlock's
suite baseline at `65f36c5`.

`scripts/source-inventory-check.mjs` requires every subsystem in the manifest to be named in this
document. It does not check *which* status a subsystem is given, and it should not -- that is a
human's call, and a check that enforced the current answer would make changing it a fight with CI.
What it does prevent is a subsystem being inventoried and then never classified, which is how a
decision gets made by nobody.

D-ranges are allocated per belt (`DECISIONS.md`, the index table's note). The 2026-08-28
ratification (D-0032) allocated `D-03xx` to `session`, `D-04xx` to `canary` and `D-05xx` to
`messagebus`. No range is allocated to any belt still proposed here; that allocation is part of
the same human gate as the statuses.
