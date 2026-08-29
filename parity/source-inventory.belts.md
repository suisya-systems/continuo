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

### `attention` -- `in-scope` -- **ported: 194 of 194 cases**

Belt start ratified at the human gate on 2026-08-30 (D-0034), split into three sub-belts sharing
one D-range, `D-09xx`: A1 (facts, 90 cases), A2 (dedup and config, 44 cases) and A3 (notify and
pipeline, 60 cases). The status keeps its `retarget` spelling here -- starting the belt is not the
same axis as completing it (the same distinction D-0032's belts used); each sub-belt's rows move to
`in-scope` at its own completion, and **all three completed 2026-08-29**: A1 (`D-0901`..`D-0903`
and `D-0906`), A2 (`D-0904`..`D-0905`) and A3 (`D-0951`..`D-0952`). All 194 rows therefore carry
that spelling, and the belt is finished. `test_broker_journal_contract.py` is **not** part of these
194 cases -- it has no node ids and sits in the `broker` section below as a collection-time skip.

**A1 -- facts, 90 of 90 ported.** `tests/attention/test_readers.py` (29) and
`tests/attention/test_classifier.py` (61), ported to `src/attention/` (`fact_state.ts`,
`readers.ts`, `classifier.ts`, and the one `config.ts` constant `D-0902` records) with
`test/attention/readers.test.ts` and `test/attention/classifier.test.ts` beside them. Note that
`fact_state.ts` is **not** imported by `classifier.ts` and never was after `D-0906`: the vocabulary
is adopted here (`D-0901`) on the strength of consumers that predate this belt, and the classifier
carries no fact state at all.

| source file | cases | ledger |
|---|---|---|
| `tests/attention/test_classifier.py` | 61 | `parity/attention.classifier.ledger.json` |
| `tests/attention/test_readers.py` | 29 | `parity/attention.readers.ledger.json` |

The decisions A1 minted are `D-0901` (the six-name vocabulary is **adopted** rather than restated
for a lint's sake, closing what `D-0034` ratified A1 would close), `D-0902` (the one `config.ts`
constant the classifier imports lands here; the config belt stays A2's), `D-0903` (the classifier
carries a fact state it is **given** and derives none) and `D-0906`, which supersedes `D-0903`
after its falsifier fired: the classifier carries no fact state, because nothing can supply one.
`D-0903` is left in `DECISIONS.md` exactly as written and marked superseded -- an entry that named
what would falsify it and was then falsified by that named observation is more useful intact than
edited.

**A3 -- notify and pipeline, 60 of 60 ported.** `tests/attention/test_notify.py` (34) and
`tests/attention/test_cli.py` (26), ported to `src/attention/` (`notify.ts`, `cli.ts`, and
`pyformat.ts`) with `test/attention/notify.test.ts` and `test/attention/cli.test.ts` beside them.
`attention scan|watch` is mounted on the unified `continuo` CLI, which is the arrangement `D-0030`
established working as intended: the subtree's own module declares its flags and `src/cli.ts` only
mounts them.

| source file | cases | ledger |
|---|---|---|
| `tests/attention/test_notify.py` | 34 | `parity/attention.notify.ledger.json` |
| `tests/attention/test_cli.py` | 26 | `parity/attention.cli.ledger.json` |

**All 60 are translated: 5 `ported`, 55 `adapted`, 0 `not-ported`, 0 waivers.** The `adapted` count
is high and the reason is mechanical rather than substantive -- almost every case in both files
passes `log_stream=StringIO()`, reads `capsys`, or patches a module attribute with
`monkeypatch.setattr`, and each of those three is a rewrite this port has an established shape for.
Seventeen further target-only cases sit beside them.

**One case is genuinely re-authored, and it is the belt's repaired defect.**
`test_scan_recovers_from_broken_dedup_state` pins that a corrupt dedup ledger loads as empty state
and is silently rewritten -- the behaviour this document names below as ruled out, and which A2's
`D-0904` removed. Per `D-0023` the case is inverted in the change that repairs it: the port asserts
that the scan exits 2, names the file, and leaves it byte for byte as it found it. What `D-0904`
did not settle is what the CLI does with the refusal, and `D-0951` is that decision.

**A3 built the belt's differential oracle, and it changed five answers.** `notify.render_text`
formats a template the **operator** wrote, so `string.Formatter().parse`, `str.format_map` and
`str.__format__` are transcribed in `src/attention/pyformat.ts` rather than approximated by a
regular expression -- a parser that reads `{{pr}}` as a reference to `pr` renders `42` where CPython
renders the literal `{pr}`, and a renderer that refuses what CPython accepts replaces the operator's
own text with the English default, silently. `D-0952` records the transcription and the vector that
checks it (`scripts/oracle/dump_pyformat.py`, `parity/oracle/pyformat-corpus.json`,
`parity/oracle/pyformat-vector.json`, `test/attention/pyformat-oracle.test.ts`, in the shape
`D-0200`'s `fnmatch`/`shlex` vector established). The transcription was written from CPython's own
source and its first draft still disagreed with CPython on five of the corpus's inputs, none of
which review had found; `D-0952` lists them. One is a finding about interlock rather than about the
port: the source's `except (ValueError, IndexError)` around `_format_with_event` has an
**unreachable** half, because `format_map` raises `ValueError` for every positional field.

**`test_broker_journal_contract.py`'s zero-entry ledger.** `D-0034` ratified that this file gets a
standalone, metadata-only ledger recording **zero entries**, outside the parity checker's normal
file-to-inventory linkage, so that its absence from every attention ledger is a checked-in
statement rather than something a later reader has to decide was deliberate. It is
`parity/attention.broker-journal-contract.ledger.json`, and it is named -- with the reason it is
absent -- in `scripts/parity-check.mjs`'s `LEDGERS` list, in a comment beside the attention lane
rather than as an entry, because the checker's first act on a ledger is to read the inventory file
it points at and this file has none to point at.

**A2 -- dedup and config, 44 of 44 ported.** `tests/attention/test_dedup.py` (10) and
`tests/attention/test_config.py` (34), against `src/attention/dedup.ts`, `src/attention/pytime.ts`
and the A2 half of `src/attention/config.ts` that `D-0902` reserved:

| source file | cases | ledger |
|---|---|---|
| `tests/attention/test_config.py` | 34 | `parity/attention.config.ledger.json` |
| `tests/attention/test_dedup.py` | 10 | `parity/attention.dedup.ledger.json` |

**The `test_dedup.py` retarget this document called for is done, and it is the belt's one
deliberate divergence from interlock.** The two corruption cases named below assert the OPPOSITE of
their source: `D-0034` ratified the fail-closed repair inside A2 and `D-0023` requires the case that
pinned an inherited behaviour to be inverted in the change that repairs it, so both are recorded
`adapted` with the divergence stated. `D-0904` draws the new boundary -- an ABSENT namespace is
empty, a PRESENT but unusable one is a refusal -- and the source has four silent recovery paths
where interlock's own suite pins only two, so the other two are closed by target-only cases rather
than left unprotected. Rebuilding the corrupted state from durable records instead of refusing it
is the larger repair `D-0034` named as declined-for-now; nothing in A2 forecloses it and no belt is
yet chosen for it. The config file needed no such retarget: all 34 cases are straight translations,
and the ledger defends that reading rather than leaving it to look like an oversight.

The two decisions A2 minted are `D-0904` (the fail-closed boundary, and one home for the belt's
`datetime` transcriptions) and `D-0905` (`isinstance(value, int)` is a question about the config
document, not about the value; the dataclass's own defaults become one exported record).

Every file here is classed in `PORTING_LEDGER.md` as either `carry (invariant) / rewrite
(mechanism)` or `rewrite`; **none** is a straight carry. `test_classifier.py` (61) carries the
strongest invariant -- that every fact-vocabulary row has a pinned expectation -- and this document
proposed re-deriving it onto the closed fact-state set. **That re-derivation was attempted and then
abandoned; `D-0906` records why, and the sentence is corrected here rather than quietly dropped.**
A1 first met it by making the fact a required input the classifier carried uninterpreted
(`D-0903`), so that every ported case pinned one. A3's pipeline then found that nothing in continuo
can produce a fact state to supply -- the observation `D-0903`'s own falsifier had named -- so the
shape was withdrawn. With no fact carried anywhere in the subsystem, the invariant has nothing here
to be about: it presupposes the fact, so it is not re-derivable in principle rather than merely
hard to place. What is left is narrower and is **not** offered as an equivalent --
`test/contract/fact-state-vocabulary.test.ts` pins that every statement of the six names agrees
with every other and that the DDL still constrains `incident.fact_state` only for emptiness, which
is an agreement between statements of a vocabulary rather than a pinned expectation per row. `test_dedup.py` is called out explicitly: its two
corruption cases pin "malformed state loads as an empty `DedupState`", and the ledger rules that
behaviour out for durable dedup state, so those two must be re-authored to assert fail-closed
rather than ported. **A2 re-authored those two under `D-0904`**, and A3 re-authored the CLI case
that runs the same repair end to end (`D-0951`), so the behaviour the ledger ruled out is not
reproduced anywhere in the subsystem.

That is why the belt was `retarget` rather than `candidate-lane` while it was open: a straight
translation
would carry a behaviour the source repository has already decided is wrong, and continuo's D-0023
says an inherited defect is repaired at the first belt that touches it, not reproduced.

### `fault_injection` -- `in-scope` (ratified 2026-08-29) -- **ported: 98 of 98 cases**

Ratified into scope at the human gate on 2026-08-29 (the dispatch of this belt carried the
ratification, as the window recorded); belt started and completed 2026-08-29, D-range `D-06xx` (`D-0601` used -- it reserves the range and
settles the three questions the paragraphs below used to leave open).

An acceptance harness rather than a product module. There is no
`claude_org_runtime/fault_injection/`; `test_conformance.py` is a battery run against every adapter
a build ships, and `test_manifest.py` / `test_protocol.py` / `test_import_graph.py` pin the shape
adapters must satisfy.

This document previously floated merging the cases into `test/contract/` and questioned whether "a
conformance battery with one adapter in it" was worth a belt. Both are answered in `D-0601` and the
answers went the other way:

- **It gets its own directory.** `test/contract/` holds assertions *about* continuo's modules; this
  is an independent acceptance system with a wire protocol, a spawn/barrier/kill/restart engine, a
  frozen case matrix and its generator, a conformance battery, a collection-time policy layer, and
  role drivers that run as **real child processes**. Merging six such modules into a directory where
  every file imports implementations by design would bury the seam `test_import_graph.py` exists to
  police. It is ported to `test/fault_injection/` (`contract.ts`, `controller.ts`, `manifest.ts` +
  `manifest.json`, `conformance.ts`, `policy.ts`, `spike_driver.ts`, `session_driver.ts`, two `.mjs`
  loader shims) with the five case files beside them.
- **One adapter is a complete exam, not half a comparison.** The battery is a qualification, not a
  comparison test: it asserts the contract itself -- every checkpoint reachable and blocking, the
  barrier round trip, a real SIGKILL leaving a readable database, an idempotent restart, an injected
  clock, identical traces under one seed, the CLI surface, and that no invariant query is vacuous.
  A second subject would add coverage of that adapter, not of the exam. `D-0601` makes the
  distinction structural by naming two adapter classes: a `FullFaultAdapter` is a battery subject,
  a `CaseAdapter` is only something a manifest case may route to.

**What "98 of 98" does and does not say.** The frozen matrix holds 59 cases; the inventory's 98 ids
were collected under the default (`fast`) profile, which selects 21 of them. All 98 are ported and
measured green. The other 38 cases are `full`-only and are not part of this evidence set -- and four
of those route to the `session` adapter, whose walk stands on a `SessionOrchestrator` and a C2
provider that `src/session/` does not yet provide. `session_driver.ts` is a registered `CaseAdapter`
that refuses loudly when driven rather than a stub that would let those four report something about
a walk that never happened. The follow-on is declared in
`parity/fault-injection.cases.ledger.json`, not left to be discovered.

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

### `curator` -- `not-porting` (ratified 2026-08-29, D-0035) -- 71 cases

`tests/curator/` covers skill-candidate promotion: a digest, a path audit, and
gate item 9's five negatives. The promotion gate's whole premise is that a filesystem write into a
live skill directory *is* the promotion, which is a claim about running Claude Code sessions.
Ratified at the human gate on 2026-08-29: continuo is a safety-substrate library and does not
operate those sessions, so it does not own that surface, and porting the tests would have settled
the question by implication in the other direction. The reason recorded is that continuo does not
own the skill-promotion surface, so the tests have no subject here.

If the answer had been yes, `test_promotion_gate.py` is high-value: every negative asserts both
that the decision was a refusal *and* that nothing landed on disk, which is the two-sided shape
that catches a gate that refuses in name only. That stays useful as the reason a future reversal
would be cheap to act on.

**What would falsify this:** if continuo, or a layer built on it, grows a surface that promotes
skills by writing into a live skill directory, the subject exists and this belt should be reopened.
That is a live possibility rather than a theoretical one -- see `suisya-systems/cadenza#9` for the
agentic-layer direction that would create such a subject.

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

### `gate_item11` -- `in-scope` (ratified 2026-08-30, D-0034) -- **ported: 64 of 64 cases**

Belt start ratified at the human gate on 2026-08-30 (D-0034), D-range `D-10xx`. `D-0504`'s testkit
extraction is a precondition, run first as its own PR (`PR-0`). `src/index.ts`'s two re-exported
vocabularies are carried as an allowlist exception to the leak check (a subpath-exports split is a
falsifier-bearing future move, not this belt's). The status keeps its `in-scope` spelling across both
steps for the reason the `gate_item2` section above gives: the vocabulary this document is checked
against records **porting intent** (D-0031), and Part 2 completing the belt does not retract the
decision to take it on.

**Part 1 (task `continuo-gate-item11-p1`, D-1001): 51 of 64 cases**, across
`test_no_provider_detail_leaks.py` (35), `test_registry_availability.py` (4) and
`test_substitution_scenarios.py` (12) -- 0 `ported`, 48 `adapted`, 3 `not-ported`, 0 waivers.
`test_suite_runs_unchanged.py`'s 13 cases (the double-suite-run measurement) were the declared
follow-on named there.

**Part 2 (task `continuo-gate-item11-p2`, D-1002): the remaining 13 of 64**, `test_suite_runs_unchanged.py`
-- 0 `ported`, 13 `adapted`, 0 `not-ported`, 0 waivers, completing the belt. Ported by a scoped
subprocess double-run of `vitest run` against `test/control_plane`, spiked first per the belt's own
guidance; see D-1002.

| source file | cases | ledger |
|---|---|---|
| `tests/gate_item11/test_no_provider_detail_leaks.py` | 35 | `parity/gate_item11.no-provider-detail-leaks.ledger.json` |
| `tests/gate_item11/test_registry_availability.py` | 4 | `parity/gate_item11.registry-availability.ledger.json` |
| `tests/gate_item11/test_substitution_scenarios.py` | 12 | `parity/gate_item11.substitution-scenarios.ledger.json` |
| `tests/gate_item11/test_suite_runs_unchanged.py` | 13 | `parity/gate_item11.suite-runs-unchanged.ledger.json` |

The property is real and worth having: no session-backend detail may leak into the
control plane, asserted structurally so a leak fails the build the day it is introduced. But
`test_no_provider_detail_leaks.py` asserts it over Python imports of a Python package, and
`test_suite_runs_unchanged.py` measures it by running interlock's suite. Both needed re-derivation
against continuo's module graph before any of the 64 cases meant anything. Continuo had the machinery
for that already -- `import.meta.glob` package walks (D-0114) and the write-scan (D-0115) for Part 1;
vitest's own `--reporter=json` and a `globalSetup` module for Part 2's double-run (D-1002).

### `gate_item2` -- `in-scope` (ratified 2026-08-29) -- **ported: 34 of 34 cases**

Downstream of `session`. Every case runs a crash-and-retry through the control
plane and asserts a durable row rather than an exit code, which is a shape that translates directly.
It needs the provider fixture that `session` brings, so it is a belt that follows rather than a
belt that leads.

Belt started 2026-08-29, D-range `D-08xx` (`D-0801`). Ported to `src/control_plane/session_binding.ts`
(the staged session<->run binding) and `src/supervisor.ts` (`SessionOrchestrator`, the lease-before-
spawn walk -- `async` end to end per D-0801, since it composes the `Promise`-returning S1 verbs
D-0301 gave continuo's `SessionProvider`).

The belt landed in two steps, both covered by the same 2026-08-29 human dispatch GO (via secretary)
that started it -- the status keeps its `in-scope` spelling across both for the reason the `canary`
and `session` sections above give: the vocabulary this document is checked against records
**porting intent** (D-0031), and a declared, ratified follow-on completing the belt does not retract
the decision to take it on.

**Step one (PR #65): 28 of 34 cases**, 26 `ported` + 2 `adapted`, 0 waivers, across the first two of
the source's three files. **`test_session_driver_harness.py`'s 6 cases were deferred** to a dedicated
follow-on task rather than ported as a "ついで" of this belt: that file drives
`tests.fault_injection.controller` / the S1 adapter `tests.fault_injection.session_driver.SessionAdapter`
-- the fault-injection harness itself, real SIGKILL and all -- and `fault_injection` was at the time
its own `candidate-lane` belt being ported concurrently in a sibling worktree (since ratified
`in-scope` and ported, 98/98, PR #62). What actually blocked the 6 was narrower than "wait for that
belt to land": `SessionAdapter`'s execution-path methods were a stub that deliberately threw (its own
header named this as its own declared follow-on, D-0601, on the session belt landing, which had
happened, PR #61, without the adapter itself being re-bound yet).

**Step two (task `continuo-session-adapter-followon`): the remaining 6, plus `fault_injection`'s own 4
full-profile `session-start` manifest cases**, landed together -- one `SessionAdapter` real enough for
one is real enough for both. `SessionAdapter` is re-bound to `src/supervisor.ts` /
`src/session/claude_cli_provider.ts` over a deterministic fake CLI (its own, not the session belt's S2
fixture -- it needs a start/exit ledger with real pids and timestamps for `live-processes-per-session`'s
interval-overlap computation, which the S2 fixture's spawn log does not carry). All 6 are recorded
`adapted` (D-0801's async-everywhere change, D-0602's budget scaling, and an explicit
`try/finally { await controller.teardown() }` in place of the source's context manager, on top of the
translation itself).

| source file | cases | ledger |
|---|---|---|
| `tests/gate_item2/test_orchestrator_walk.py` | 23 | `parity/gate_item2.orchestrator-walk.ledger.json` |
| `tests/gate_item2/test_mediated_real_provider.py` | 5 | `parity/gate_item2.mediated-real-provider.ledger.json` |
| `tests/gate_item2/test_session_driver_harness.py` | 6 | `parity/gate_item2.session-driver-harness.ledger.json` |

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

Two further target-only cases sit beside them, each defending something the port had to write and
the source therefore carries no warrant for. One is a probe that writes a file naming every route
around the import scan (a type-only import, an `export ... from`, a `require()` and a dynamic
`import()` inside function bodies) and asserts the scan sees all four and judges all four session
edges: the source's import-graph file has no probe, and this port had to rewrite the scan in another
language with two extra escape routes in it, so the machinery is defended in the target the way
`canary` and `secretary` defend theirs. The other pins the endpoint's epoch parser against Python's
`int()` grammar, acceptances and refusals both -- the source reads the epoch with `int()` inside a
`try`, so the grammar *is* its validation and no source case drives a malformed value, while here the
epoch is a fencing token and a spelling that wrongly parses starts an endpoint fenced under a number
nobody wrote.

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

**Reviewed at the human gate on 2026-08-29 and deliberately left pending (D-0035).** This is not an
unexamined entry: deciding to port would not produce anything to port it against, since the bridge
`PORTING_LEDGER.md` calls for does not exist in either repository yet. The trigger for revisiting is
the run-boundary cutover bridge actually being designed; the `jsonschema`-equivalent dependency
question above comes with it and does not need answering before then.

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
| `in-scope` | `control_plane`, `measurement`, `fencing`, `settings`, `canary` (**ported** 2026-08-28), `fault_injection` (ratified and **ported** 2026-08-29), `session` (**ported** 2026-08-29), `messagebus` (**ported** 2026-08-29), `secretary` (**ported** 2026-08-29), `gate_item2` (ratified and **ported** 2026-08-29), `attention` (all three sub-belts, **ported** 2026-08-29), `gate_item11` (ratified and **ported** 2026-08-29) | 1,973 |
| `retarget` | `broker` | 54 |
| `decision-pending` | `migrate` | 11 |
| `not-porting` (ratified 2026-08-28; `curator` ratified 2026-08-29) | `gate_record`, `scrub`, `package_smoke`, `curator` | 156 |
| | **18** | **2,194** |

With the 156 `not-porting` cases ratified out, continuo's effective porting target is
**2,194 − 156 = 2,038** node ids -- the pool of cases not declined, not a commitment to port all of
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
`messagebus`; `D-0601` allocated `D-06xx` to `fault_injection`, `D-0701` `D-07xx` to `secretary`
and `D-0801` `D-08xx` to `gate_item2`. The 2026-08-30 ratification (D-0034) allocated `D-09xx` to
`attention` -- shared across its three sub-belts A1, A2 and A3 rather than split further -- and
`D-10xx` to `gate_item11`. No range is allocated to any belt still proposed here; that allocation
is part of the same human gate as the statuses.
