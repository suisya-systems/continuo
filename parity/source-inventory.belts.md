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

### `session` -- `in-scope` (ratified 2026-08-28) -- 142 cases

Ratified into scope at the human gate; belt started 2026-08-28, D-range `D-03xx`.

`tests/session/` drives `claude_org_runtime/session/`: the provider contract, a
stub provider, and the Claude CLI provider. A provider/process-lifecycle belt is the natural unit,
and `test_provider_contract.py` is written as a contract battery, which is the shape that ports
best -- one implementation-independent set of assertions, run against each provider.

It is also the belt several others wait on: `gate_item2` drives crash-and-retry *through* a session
provider, and `gate_item11` exists to assert that no provider detail leaks into the control plane.
Porting those before `session` would mean porting their fixtures twice.

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

### `canary` -- `in-scope` (ratified 2026-08-28) -- 70 cases

Ratified into scope at the human gate; belt started 2026-08-28, D-range `D-04xx`.

A canary/rollout belt. Drives `claude_org_runtime/canary/`: a routing ledger with
database-enforced guarantees, an audit, synthetic v1 fixtures.

**Not to be confused with `measurement.test_canary.txt`,** which is already ported and covers
`tests/measurement/test_canary.py` -- the measurement harness's view of a canary, not the canary's
own store. The two names sit next to each other in the inventory directory and mean different
things.

`test_ledger.py`'s framing is the reason this is a good candidate: it says the guarantees must be
refused *in the store, not in the discipline of the writer*, which is exactly the property continuo
already ports well (`control_plane` is 585 cases of it).

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

### `messagebus` -- `in-scope` (ratified 2026-08-28) -- 43 cases

Ratified into scope at the human gate; belt started 2026-08-28, D-range `D-05xx`.

A durable-messaging belt, and the destination the five quarantined broker modules
above are pointed at. `tests/messagebus/` drives `claude_org_runtime/messagebus/`: the bus, an
endpoint, carried specifications, a stale-readout case, and an import-graph guard. It is small now
and will not stay small, which is an argument for porting it early rather than late -- continuo's
`control_plane/outbox.ts` is already the at-most-once half of the same problem.

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

### `secretary` -- `candidate-lane` -- 11 cases

An observation / human-gate belt, most likely alongside `attention`. Gate item 8's
behavioural half: the intake answers while every consumer stalls, with the stall made *verifiable*
rather than assumed and no latency threshold invented (`Q-0011` is open). Small, and it depends on
nothing else in this list -- which makes it a reasonable first port for anyone wanting the shape of
this belt before committing to `attention`'s 194.

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
| `in-scope` | `control_plane`, `measurement`, `fencing`, `settings`, `session` (ratified 2026-08-28), `canary` (ratified 2026-08-28), `messagebus` (ratified 2026-08-28) | 1,572 |
| `candidate-lane` | `fault_injection`, `gate_item2`, `secretary` | 143 |
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
