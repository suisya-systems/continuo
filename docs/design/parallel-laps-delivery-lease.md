# Parallel laps and the outbox delivery lease -- partitioning delivery authority by resource

**Scope.** continuo Issue #167: whether two `lap perform` processes may run concurrently against one
control plane, and if so what has to change so that each one's fenced writes reach its own outbox
rows and no others. `D-0074` names exactly two candidate changes -- **a scope column on `outbox`** or
**a strict recipient predicate on both the due and the recovery passes** -- and leaves both open on
purpose. This document measures the tree against both, recommends one, and states what a real-child
proof of it has to show.

**Status: propose-only.** No code, schema, test or decision record accompanies it. It files no
`DECISIONS.md` entry. The entry it proposes is referred to **by name only**, as
**`D-1104`**, and only continuo's human gate may create it (`D-0031`, `D-0036`). Section 12's
`P-1`..`P-17` are the lines put to that gate; they are proposals, not decisions taken. Implementation
starts after the gate, not after this document.

**Provenance.** A Codex pre-design review (2026-09-06) supplied three Blockers, three Majors and one
Minor, plus a full draft document. Both were treated as input to be measured, never as findings to be
copied. Appendix A states, finding by finding, which the tree confirms, which it refutes and which it
amends, and section 12 marks every `P` row with whether it originates in that pre-review or in this
document's own measurement.

**Companion documents.** [`../production-schema.md`](../production-schema.md) is the DDL every
persistence claim is checked against; [`../lease-fencing.md`](../lease-fencing.md) holds the fence
rule; [`../sqlite-value-contract.md`](../sqlite-value-contract.md) holds the binding rules the new
column's types are governed by; [`./minimal-operating-loop.md`](./minimal-operating-loop.md) section
4.9 is where the lease-scope question was first stated.

---

## 0. The revision this was written against

Every `file:line` below was read at continuo **`38c667b`** (`main` at 2026-09-06), and every rondo
citation at rondo **`/home/happy_ryo/work/org/workers/rondo`** as checked out on the same day
(`DECISIONS.md` head `D-0021`). Line numbers move; the claims are the point, and each is written so
that a reader who finds the line has moved can still find the thing.

Nothing here was taken from the pre-review's citations without re-reading the file. Two of the
pre-review's seven citations were wrong at this revision, and one long-standing citation *inside the
tree* is wrong; all three are recorded in Appendix A and section 10.2 rather than silently corrected.

---

## 1. What is true today, measured

### 1.1 There is one delivery resource, and it is enforced in four places

`DELIVERY_LEASE_RESOURCE = "outbox-delivery"` (`src/messagebus/endpoint.ts:239`). Its docstring
(`:205-238`) is the authority for why it is one string, and it is also where `D-0053` rule 4's two
lift options are written down -- the same two `D-0074` later names.

It is not merely a constant. Four sites refuse or assume it:

| Site | What it does |
|---|---|
| `src/messagebus/endpoint.ts:570-605` | the built endpoint **refuses at startup** any `INTERLOCK_MESSAGEBUS_RESOURCE` but this one, before the database is opened |
| `src/workspace/materializer.ts:819` | writes the constant into the worker's `mcp.json` env, and `:851-860` re-asserts it |
| `src/lap/endpoint_lease.ts:177-192` | `holdDeliveryLease` acquires **this resource by name**; the caller cannot name another |
| `src/gate/operator.ts:769-774`, `:843-849` | `gate deliver` acquires it; `gate ack` names it as whose write an ack would be if it were fenced |

A fifth site is not a refusal but a consequence, and it has not been written down before: the
endpoint's dropbox keys its fence file **by the lease resource**. `KeyedDropbox.honouredToken`
(`src/control_plane/destination.ts:574-576`) looks the honoured token up in a JSON map whose keys are
scopes, and `_scopeKey` (`:198-200`) is the identity function on the caller's resource; `_fence`
(`:578-594`) says so in as many words ("The scope this is keyed by is the caller's lease RESOURCE").
The materialiser's pre-flight reads it under the same constant
(`src/workspace/materializer.ts:1184-1204`).

### 1.2 An outbox row records an epoch and not the resource that minted it

`CREATE TABLE outbox` (`src/control_plane/migrations/0001_initial.sql:313-352`) has
`writer_epoch INTEGER` -- nullable, `> 0` when present -- and no resource, scope or partition column
of any kind. `action` (`:506-539`) is the same: `writer_epoch INTEGER`, no resource column.

Epoch order is meaningful **only within a resource**: `acquire` serialises on the `lease` table's
primary key and takes over by incrementing *that* resource's epoch (`src/control_plane/lease.ts:418`
onward, `:453-465`). The fence clause of every protected write is
`EXISTS (SELECT 1 FROM lease WHERE resource = :fence_resource AND holder = :fence_holder ...)`
(`src/control_plane/lease.ts:110-124`). So the fence proves *the writer's own lease is live*; the row
predicate proves *the row carries this number*. With one resource those two facts compose into
ownership. With two, they do not, and nothing on the row notices.

### 1.3 Neither pass that chooses rows is scoped to a resource

- **Due.** `_DUE_QUERY` (`src/control_plane/outbox.ts:372-380`) selects every unfinished row at or
  before `now_ms`, ordered, with no recipient and no owner term. `Outbox.due` runs it unchanged
  (`:1343-1345`).
- **Recipient filtering happens in TypeScript, after the read.** `MessageBus.poll` walks `due()`'s
  result and `continue`s on `message.recipient !== recipient` (`src/messagebus/bus.ts:259-264`).
- **Recovery.** `Outbox.unowned` runs `UNOWNED_OUTBOX_QUERY` (`:290-301`) with `this._resource`
  (`:1348-1350`); `Outbox.recover` (`:1891-1919`) adopts every message id it returns.
- **One-row adoption.** `_UNOWNED_ONE_QUERY` (`:326-341`) is the same predicate plus a primary-key
  term, reproduced character for character on purpose (`:313-325`).

The resource appears in those two queries in exactly one position: the `lease` subquery's
`lease.resource = :resource`. It never appears as a property of the row.

### 1.4 Every row-changing statement matches on `message_id` and a bare epoch

| Statement | Line | `WHERE` |
|---|---|---|
| `_ENQUEUE` | `:432-444` | fenced insert; stamps `writer_epoch` |
| `_COUNT_ATTEMPT` | `:481-493` | `message_id`, not-terminal, `writer_epoch = fenceEpoch` |
| `_MARK_DELIVERED` | `:517-530` | `message_id`, `status = 'pending'`, `delivered_at_ms IS NULL`, `writer_epoch = fenceEpoch` |
| `_ADOPT` | `:571-574` | `message_id`, not-terminal -- **no ownership predicate at all**, deliberately (`:564-570`) |

Not one of them can distinguish two resources, because none of them has anything to distinguish them
with.

### 1.5 Both ordinary relays address one recipient, and it is a constant by decision

`NOTIFY_RECIPIENT = "external-notify"` (`src/control_plane/handlers.ts:116`), served by
`NotifyDestinationHandler` (`:138-139`). `GATE_RELAY_RECIPIENT` re-exports it rather than spelling it
again (`src/gate/operator.ts:81`), and both enqueue sites read the constant (`:600`, `:657`).
`D-0076` (`DECISIONS.md:12414-12437`) decides this and explains why it is a **constant rather than a
flag**: `enqueueRelay` writes the recipient onto the row and `(gate_id, to_stage)` makes it final
(`src/control_plane/gates.ts:606-620`), so a recipient chosen per call is one that can be chosen
wrong once and never corrected.

### 1.6 Three producers write outbox rows, and two of them hold no lease

| Producer | Line | `writer_epoch` | `run_id` |
|---|---|---|---|
| `Outbox.enqueue` (fenced) | `:1276-1296` | stamped from the caller's live epoch | optional, **defaults to `null`** (`:1283-1285`) |
| `enqueueRelay` (gate) | `src/control_plane/gates.ts:606-620` | not written -- `NULL` | `gate.runId` |
| delivery fan-out (events) | `src/control_plane/events.ts:443-456` | not written -- `NULL` | `runId`, typed `string \| null` (`:415`, `:659`) |

`Outbox.enqueue`'s docstring (`:1230-1259`) states the rule this follows from and is worth quoting
because it constrains the design: `writer_epoch` "is the *current owner of the delivery-side
mutations*, not the producer's provenance, and a gate asking a question has no delivery lease to
stamp"; `D-0054` records that "a queue that only accepts work while a delivery worker is live is a
queue that does not outlive its worker."

**Measured consequence the pre-review did not reach: `run_id` is nullable on all three paths.** Two of
them default it to `null` outright. So "every outbox row belongs to a run" is false today, and any
partition derived from `run_id` has a third class to answer for. Section 6 is about that class.

### 1.7 The audit trail on `action` carries an epoch and no resource, and the one workaround is not in force here

`lease.ts` has a workaround for exactly this: `effectKind(resource, effect)` composes
`"<effect>@<resource>"` (`src/control_plane/lease.ts:1411-1420`) and `WRITE_HISTORY_QUERY` filters on
the suffix (`:158-167`). `docs/lease-fencing.md:171-178` calls it "a workaround, not a design -- a
real schema carries the resource as a column."

**It is not used by the outbox path.** `_ensurePendingAction` binds `kind: handler.actionKind`
(`src/control_plane/outbox.ts:1963-1965`), and `NotifyDestinationHandler.actionKind` is the bare
string `"notify"` (`src/control_plane/handlers.ts:139`); `_recordBareRefusal` does the same
(`:2365-2405`). So outbox action and refusal rows carry a `writer_epoch` with **no resource
attribution and no fallback** -- weaker than the pre-review supposed, and the reason section 7 does
not treat `effectKind` as an available escape.

`action_one_effect_per_key` is `UNIQUE (idempotency_key) WHERE status <> 'refused'`
(`0001_initial.sql:544-545`), and `idempotencyKey` is `"<recipient>:<actionKind>:<dedupKey>"`
(`outbox.ts:1068-1070`). Effect deduplication is therefore **global and run-agnostic today**, and
section 7.3 argues it must stay that way.

### 1.8 The unowned criterion is a published invariant, not only an internal query

`UNOWNED_OUTBOX_QUERY` is exported from the package (`src/index.ts:353`) and is the SQL behind
`INVARIANT_NO_UNOWNED_OUTBOX` in the fault-injection belt
(`test/fault_injection/spike_driver.ts:2026`). Its own docstring (`:286-289`) says it is "run by hand
against a recovered database." Changing what it means is a change to a belt, not to a private helper.

### 1.9 The lease is held for the lap and released at its end -- not across the human wait

`performLap` acquires before the worktree, the fence and the child, and `hold.stop()` runs in a
`finally` on every path out (`src/lap/root.ts:1243-1275`). `D-0075` makes it unconditional. The
`awaiting_human` suspend happens **after `lap perform` has exited** (rondo
`docs/operations/lap-1-dogfood.md:900-910`). Section 10.3 draws the consequence, and it bounds how
much #167 can be worth.

### 1.10 The refusal that this issue is about

`test/lap/endpoint-lease.test.ts:642-663` pins it: with `outbox-delivery` held by another holder,
`performLap` is refused `LeaseHeld` and `provider.startCalls` is empty. It is **in-process** -- one
process, two acquisitions -- which is exactly the limit section 9 has to get past.

---

## 2. Re-deriving `D-0074` against two concurrent runs

`D-0074` (`DECISIONS.md:12344-12385`) is not wrong and is not being overturned. Its fencing premise is
re-derived here and kept; only its serialisation *consequence* (`:12371-12377`) is put to the gate.

Let lap A hold `(outbox-delivery, holder-A, epoch 1)` and, hypothetically, lap B hold a second
resource at its own `epoch 1`. Take any outbox row A owns. It reads `writer_epoch = 1`.

- B issues `_COUNT_ATTEMPT` against that row. The fence clause proves **B's lease is live**
  (`lease.ts:110-124`, with `:fence_resource` bound to B's resource). The row clause proves
  **`writer_epoch = 1`**, and it does -- A put it there.
- Both conjuncts are true. The update lands. B has incremented the retry count on a row A believes it
  owns, under a fence that never lied: it was asked whether *some* lease of B's was live, and it was.
- `_MARK_DELIVERED` fails the same way, and worse, because it also performs the destination effect.
- Recovery is worse again: A's `unowned(now)` asks whether a lease exists on **A's** resource at
  epoch 1. For a row B owns at its own epoch 1 there is such a lease -- A's -- so the row is reported
  *owned* and skipped. For a row B owns at epoch 2 there is not, so it is reported **unowned** and
  `_ADOPT` re-stamps it under A's epoch, silently transferring a live row between runs.

This is `D-0074`'s "a fence proving only that *some* lease is live", derived at the statement rather
than asserted. The endpoint's own docstring reaches the same place (`endpoint.ts:220-231`).

**What the missing thing actually is.** Not "a scope". The row is missing the **left-hand side of the
fence triple**: `(resource, holder, epoch)` is what a protected write proves, and the row records only
the third element. Two epoch sequences share a column and nothing says which sequence a number came
from. That framing decides the column's name and its type in section 4: it stores the exact resource
string, because anything else needs a second mapping to get back to it, and a mapping is where the
ambiguity would return.

Under a per-row resource the three obligations of every outbox mutation become:

1. `row.delivery_resource = :fence_resource` -- **which epoch sequence** this row belongs to;
2. a live lease for `(:fence_resource, :fence_holder, :fence_epoch)` -- the existing fence;
3. for owned transitions, `row.writer_epoch = :fence_epoch` -- **which writer within that sequence**.

(1) is the new one and it is not optional: without it, (2) and (3) answer different questions and
compose into nothing, which is precisely the paragraph above.

---

## 3. The two candidates `D-0074` names, measured

### 3.1 A strict recipient predicate cannot separate two ordinary laps -- rejected, with the measurement

The recipient-predicate option is admissible only if two concurrent laps address **different**
recipients. They do not, and it is a decision rather than an accident:

- Both of a gate's relays address `external-notify` (`D-0076`, `DECISIONS.md:12414-12437`).
- The constant has one definition and both enqueue sites read it (`operator.ts:81`, `:600`, `:657`).
- `spikeRegistry` supplies exactly two handlers, and the other one --  `HumanGatedHandler`,
  `actionKind = "human_gated"` (`handlers.ts:215`) -- delivers nothing by design.
- The endpoint refuses at startup a recipient no handler serves (`endpoint.ts`, cited by `D-0076`),
  and the materialiser refuses to *render* one (`materializer.ts:826-843`).

So on today's tree, two ordinary laps have the same recipient, and the option collapses in one of two
ways depending on where the lease is put:

- **One lease per recipient.** Both laps want `external-notify`; the second is refused `LeaseHeld`.
  The serialisation `D-0074` recorded is unchanged -- the resource has been renamed, not partitioned.
- **One lease per run, with recipient as the only row predicate.** Both laps hold live leases; both
  see every `external-notify` row, because recipient equality is true for all of them; section 2's
  cross-writes are back in full. The predicate excludes nothing.

**Making recipient sufficient is not a query change; it is a re-addressing.** It would need run-unique
recipients, which means: a handler registry that admits a family of names rather than a roster
(`handlers.ts`), a relay recipient that is no longer a constant -- which is the specific mistake
`D-0076` records the first implementation making, and the wedge it produces is permanent because
`(gate_id, to_stage)` makes the row final (`gates.ts:606-620`) -- an endpoint startup admission over a
pattern rather than a literal (`endpoint.ts:570-605`), a materialiser that renders it
(`materializer.ts:817-823`), and an ack authority re-derived, since `ack` is unfenced and settles on
recipient equality alone (`bus.ts:466-479`). That is a different design, and it is no longer the
alternative `D-0074` was holding open.

**Recommendation: reject recipient-only, and say so in `D-1104` with this measurement**, so the next
reader does not re-open it. Recipient still becomes a SQL predicate (P-6) -- as a routing defence,
not as the ownership partition.

### 3.2 The resource column, named for what it is

`outbox.delivery_resource` holding the **exact lease resource string**, not a scope tag, not a
partition id, not a nullable hint. Section 2 is the argument: the row is missing the fence triple's
first element, so the honest repair is to store that element. A shorter tag would need a mapping from
tag to resource, and every mapping is a second place the answer can be wrong.

For run-bound rows the value is `deliveryResourceForRun(runId) = "outbox-delivery:run:" + runId`.
Measured admissibility: `requireIdentifier` (`lease.ts:335-339`) accepts any non-empty, non-blank
string, so a colon-bearing resource is admissible at `acquire`, `renew`, `release` and every fenced
write. `effectKind` forbids `@` in the *effect* only (`:1413-1419`), and `resourceOfKind` splits on the
first `@` (`:1433-1436`), so a colon-bearing resource survives both. The function is **one-way**: it
is never parsed back into a run id, because `outbox.run_id` is already the join and a second decoder
is a second thing to disagree.

---

## 4. Where resource equality has to sit

**Inside every statement, never in front of one.** The module already states the reason for the fence
itself (`outbox.ts:413-431`): "check-then-write leaves precisely the race in which the lease expires
between the check and the write". Resource equality has the same shape of race and the same answer.

The closed inventory, statement by statement, at the lines measured in section 1:

| Statement | Line | Add |
|---|---|---|
| `_DUE_QUERY` | `:372-380` | `delivery_resource = :resource` **and** `recipient = :recipient` |
| `UNOWNED_OUTBOX_QUERY` | `:290-301` | see section 4.1 -- it splits |
| `_UNOWNED_ONE_QUERY` | `:326-341` | `delivery_resource = :resource`, kept character-identical to whichever form it mirrors |
| `_ENQUEUE` | `:432-444` | write `delivery_resource` from the caller's own resource |
| `_COUNT_ATTEMPT` | `:481-493` | `eq("delivery_resource", fenceResource)` in the `WHERE` |
| `_MARK_DELIVERED` | `:517-530` | the same |
| `_ADOPT` | `:571-574` | the same -- and **only** this; the deliberate absence of an ownership predicate (`:564-570`) is unchanged, because resource equality is not an ownership predicate |

The builder question is answered by the tree: `fencedUpdate`'s predicate grammar is
`Comparison | IsNull | Conjunction` with operators `=` and `<>` only (`outbox.ts:456-462` describes
it), so `eq("delivery_resource", ...)` renders and needs no grammar change -- unlike the positive
`status IN (...)` form, which is why the write statements carry the generated negation instead
(`:479`). If `fenceResource` is not already available as a rendered term beside `fenceEpoch`, adding
it is a change to `lease.ts`'s builder and must be named as such in the implementation plan rather
than assumed.

`MessageBus.poll`'s TypeScript filter (`bus.ts:259-264`) stays. It becomes redundant once due carries
the recipient term, and redundancy in the safe direction is not a defect: removing it in the same
change would make the SQL term the only thing standing between two runs and each other's rows, on the
same pass that introduces it.

### 4.0 What writes the column: two rules, by producer class

The obvious rule -- "derive it from `run_id`" -- is wrong for one of the three producers, and the way
it is wrong is the same ambiguity this design exists to remove.

`Outbox.enqueue` is **fenced**: `_ENQUEUE` stamps `writer_epoch` from the enqueuing instance's live
lease (`outbox.ts:432-444`). Its `runId` is optional and defaults to `null` (`:1283-1285`). So a
per-run bus that enqueues a runless message under the `run_id` rule would write
`delivery_resource = 'outbox-delivery'` beside an epoch minted by `outbox-delivery:run:<runId>` -- a
row whose two ownership fields name different sequences, which is section 2's failure reconstructed
inside the fix.

The rule that holds is therefore stated on the epoch rather than on the run:

> **A row's `delivery_resource` is the resource whose epoch sequence governs that row's
> delivery-side mutations. On any row, `writer_epoch IS NULL OR writer_epoch was minted by
> `delivery_resource`.**

Applied to the three producers measured in section 1.6:

| Producer | Fenced? | `delivery_resource` |
|---|---|---|
| `Outbox.enqueue` / `MessageBus.send` | yes -- stamps an epoch | **the enqueuing instance's own resource**, never `run_id`. The instance holds the lease that minted the epoch, so the invariant holds by construction. |
| `enqueueRelay` (gate) | no -- `writer_epoch` stays `NULL` | derived from the row's durable `run_id` (`gates.ts:612`), which is always present for a gate |
| delivery fan-out (events) | no -- `writer_epoch` stays `NULL` | derived from the row's durable `run_id`, or the global literal when it is `null` (`events.ts:415`, `:451`) |

The unfenced rows are the ones `D-0054` is about, and deriving their resource from durable row input
rather than from a live lease is what keeps the queue outliving its worker (`outbox.ts:1240-1250`).
The fenced row has a live lease by definition, so taking the resource from it is available and is the
only choice that keeps the invariant true.

**A consequence worth stating rather than leaving implicit:** under this rule a per-run bus can no
longer produce a row on the global resource at all. If a runless fenced send is ever needed it must
be issued from a bus that holds the global resource, and `MessageBus.send`'s optional `runId` becomes
independent of the partition instead of deciding it. The implementation should assert the invariant
in a test rather than trust the two call sites.

### 4.1 The one exported constant has to become two, and that is a real cost

This is measurement this document adds, and it is the sharpest cost of the recommendation.

`UNOWNED_OUTBOX_QUERY` serves two callers with different questions:

- **`Outbox.recover`** (`:1348-1350`, `:1891-1919`) asks *"which of the rows I am responsible for have
  no live owner?"* -- caller-scoped. It needs `AND outbox.delivery_resource = :resource`.
- **`INVARIANT_NO_UNOWNED_OUTBOX`** (`test/fault_injection/spike_driver.ts:2026`, exported at
  `src/index.ts:353`) asks *"does this recovered database contain any unowned row at all?"* --
  database-wide. Adding `= :resource` to it would make the belt's invariant say "no unowned rows
  **belonging to whichever resource the operator happened to bind**", and a row owned by a resource
  the operator did not name would pass by being invisible. That is a weaker invariant wearing the same
  name.

The correct database-wide form joins on the row's own resource:
`NOT EXISTS (SELECT 1 FROM lease WHERE lease.resource = outbox.delivery_resource AND lease.epoch = outbox.writer_epoch AND lease.expires_at_ms > :now_ms)`
-- no `:resource` parameter at all, which is also what makes it honest.

So the two queries diverge, and `_UNOWNED_ONE_QUERY`'s deliberate character-for-character identity
with the sweep (`:313-325`) must be re-anchored to the **caller-scoped** form, since
`adoptIfUnowned` is a delivery worker's act. The implementation must say in the source which of the
two each constant mirrors, or the drift the identity was written to prevent returns in a new place.

**P-8 records this split. It is not a detail: it changes a published invariant and a belt, and it is
the single most likely place for this change to be got wrong quietly.**

---

### 4.2 Ack authority stops being a recipient question

`ack` is deliberately unfenced (`D-0053`; `docs/production-schema.md:592`), and it should stay that
way: an ack is idempotent, and a fence on it would turn a settlement that changed nothing into a
refusal. But unfenced is not the same as unauthorised, and today's authority test is recipient
equality alone -- `MessageBus.ack` refuses only when `message.recipient !== recipient`
(`bus.ts:466-479`), after which `Outbox.recordAck` loads and updates **by message id and status**.

That test is sufficient only while one endpoint exists per recipient. Under P-2 and P-3, two
endpoints serve `external-notify` simultaneously, and the id an endpoint acks is **caller-supplied**:
the MCP `ack` tool passes it straight through (`endpoint.ts:330`). Gate relay ids are deterministic
and operator-visible (`gates.ts:606-620`), so run B's endpoint can ack run A's delivered row even
though its own poll -- correctly partitioned by section 4 -- never returned it. Nothing downstream
notices: the ack is set once by the outbox's own trigger, and `D-0080`'s reconcile pass then advances
A's gate on evidence B produced.

**The repair is one more equality on the row, in the same family and at the same place:** refuse when
`message.deliveryResource !== this._resource`, beside the recipient test, as a caller bug rather than
a stale-writer refusal. It adds no lease clause, so late acks, duplicate acks and acks of cancelled
rows keep behaving exactly as `recordAck` decides today. P-16.

This is the one place where partitioning `poll` is not enough on its own, and it is the reason
section 9's assertions are not satisfied by "each lap polled only its own rows".

---

## 5. Schema, migration and the query plan

### 5.1 A new forward migration is allowed; nothing here is frozen

Measured, because the pre-review asked for it to be said explicitly:

- Migrations are numbered forward-only steps and every change is its own file
  (`docs/production-schema.md:104-108`). Head is `0004_run_writer_epoch.sql`
  (`src/control_plane/migrations/`), so the next step is **`0005`**.
- Editing a historical migration is refused by checksum on every open (`:152-154`, rule 3). That is
  the prohibition, and it is not a prohibition on adding a step.
- `0003_outbox_cancelled_status.sql` already advanced the outbox contract with a 12-step rebuild
  (`docs/production-schema.md:591-620`), and `0004` already added a fenced column by
  `ALTER TABLE ADD COLUMN`. Both precedents exist in the tree.
- `docs/sqlite-value-contract.md` is a **value-representation** contract measured on one driver
  version (`:6-9`, `:11-19`, `:21-35`): storage class to JavaScript type, and the three shapes of
  absence. It says nothing about which columns exist. It is **not a schema freeze**, and `D-1104`
  should say so in one sentence so this question is not re-asked.

One drift found while measuring, reported rather than fixed here: `production-schema.md:104-105`
gives the migrations directory as `src/claude_org_runtime/control_plane/migrations/`, a Python path;
continuo's are at `src/control_plane/migrations/`. Whoever updates that document for `0005` should
correct it in the same change.

### 5.2 `NOT NULL` on `ALTER TABLE ADD COLUMN` forces a choice, and it is not free

SQLite admits `ALTER TABLE ADD COLUMN ... NOT NULL` only with a non-null constant `DEFAULT`, and a
default cannot be dropped afterwards without a rebuild. So there are two shapes and each has a cost:

- **(a) `ADD COLUMN delivery_resource TEXT NOT NULL DEFAULT 'outbox-delivery'`.** One statement; every
  existing row is backfilled to the legacy global resource, which is *correct history* rather than
  invention (section 5.3). The cost is that the default outlives the migration: a producer added later
  that forgets to bind the column gets `outbox-delivery` **silently**, and a silently-legacy row is a
  row no per-run lap will ever select. That is the exact failure class section 6 is about, arriving by
  omission instead of by design.
- **(b) The 12-step rebuild, on `0003`'s own precedent for this same table.** `NOT NULL` with no
  default, so a producer that forgets to bind is refused by the database at the insert. The cost is a
  rebuild that re-authors outbox's DDL, and `0004`'s header warns in as many words that "a rebuild
  that silently re-authors what it rebuilds is how a constraint disappears without a decision".

**Recommendation: (b).** The repository's demonstrated posture is "enforced rather than described"
(`endpoint.ts:571-577` chooses a refusal over a docstring for exactly this reason), and the hazard (a)
leaves behind is invisible by construction while (b)'s hazard is a review of DDL that a diff shows.
The rebuild is also the step that replaces the due index anyway (5.4), so it is one step either way.
P-9 puts both to the gate with this recommendation; the gate may take (a) with a mandatory
schema test asserting the default's presence and its legacy-only meaning.

`length(delivery_resource) > 0` as a `CHECK`, matching every other non-empty text column on the table
(`0001_initial.sql:333-336`). Immutability by trigger, on `outbox_delivery_is_set_once`'s pattern: a
row's resource is decided at enqueue and a mutable one is a partition that can be moved out from under
a live holder.

### 5.3 Legacy rows keep the resource they were actually written under

`0004`'s header is the argument, and it is nearly the same one -- "inventing one would be
manufacturing the very evidence the column exists to carry" -- but the conclusion here is the
**opposite**, and the difference matters:

- `0004` could not backfill, because the epoch an existing `run` row was written under was genuinely
  unknown.
- `0005` **can and must** backfill, because the resource every existing outbox row was written under
  is genuinely known: there has only ever been one, enforced at four sites (section 1.1).

So backfilling to the exact literal `'outbox-delivery'` records history; relabelling those rows into
any run scope would fabricate it, which is the pre-review's Major 5 and is confirmed. That is a
distinction the pre-review's draft did not draw, and stating it is what keeps `0004` from being read
as precedent against the backfill.

### 5.4 The due index is measured behaviour, and the new one must be measured too

`outbox_undelivered` is `ON outbox(enqueued_at_ms) WHERE status IN ('pending','delivered')`
(`0003_outbox_cancelled_status.sql:252-255`). `_DUE_QUERY` carries that predicate as a literal so
SQLite may use it (`outbox.ts:346-360`), and `_DEGRADED_DUE_QUERY` (`:403-406`) exists so the
assertion is not vacuous. The plan test asserts `SEARCH` and `outbox_undelivered` on the shipped form
and `not SEARCH` on the degraded one, and it EXPLAINs **the statement traced out of the driver**, not
a paste (`test/control_plane/outbox.test.ts:2769-2807`).

Adding two equality terms in front of the range term changes the useful index to
`(delivery_resource, recipient, enqueued_at_ms)` with the same partial predicate. The rule the new
index has to satisfy is the one already in the tree: **positive and negative EXPLAIN evidence, on the
statement the method actually ran, on the same database with the same rows.** A composite index
asserted without a degraded twin is an index nobody has shown is used.

---

## 6. The rows no per-run lap can select -- the gap that has to be closed in the same change

This section is this document's own finding, and it is why P-10 exists.

Section 1.6 measured that `run_id` is nullable on all three producer paths and defaulted to `null` on
two. Once laps take per-run resources, three classes of row exist:

1. **Run-bound rows enqueued after `0005`** -- resource `outbox-delivery:run:<runId>`. A lap for that
   run selects them. Fine.
2. **Legacy rows** -- backfilled to `'outbox-delivery'` (5.3). Unfinished ones exist in any database
   migrated with a relay in flight.
3. **Runless rows enqueued after `0005`** -- `run_id IS NULL`, so no run resource can be derived, so
   `'outbox-delivery'` again. **This class is not legacy and does not drain away over time.**

Under a per-run lap resource, classes 2 and 3 are selected by nobody:

- `due` filtered on `delivery_resource = :resource` never returns them to any lap.
- `recover`'s caller-scoped sweep never adopts them.
- The database-wide belt invariant (4.1) **does** see them, and reports them as unowned, forever.

There is a **fourth class**, and it is the one that makes the obvious answer wrong. `gate deliver`
exists precisely as "the operator's delivery worker for the window after a lap has ended"
(`src/gate/cli.ts:194-196`), and `enqueueRelay` copies `gate.runId` onto the row (`gates.ts:612`). So
under section 4.0 a gate relay is **run-bound**, and the relays that matter most are enqueued *after*
the lap exits: `gate present` and `gate answer` run during the human suspend, which the dogfood
records as happening after `lap perform` has returned (rondo `docs/operations/lap-1-dogfood.md:900-910`,
step 10). A `gate deliver` pinned to the global resource would never select them, and no lap is
running to select them either. Those relays would be stranded permanently -- the ordinary path, not an
edge case.

So the drainer cannot be "the verb that holds the global resource". It has to be **the verb that
holds the resource of the rows it is draining**:

- `deliverRelays` (`src/gate/operator.ts:763-780`) stops naming `DELIVERY_LEASE_RESOURCE` and takes
  the resource for the pass -- derived from the run's id for a run-bound relay, and the global literal
  for legacy and runless rows.

**The verb has no way to say which, and that is a CLI change this design must name rather than
assume.** Measured: `gate deliver` takes `--db`, `--destination-dir`, `--holder`, `--now-ms` and
`--json` and nothing else (`src/gate/cli.ts:951-969`); there is no gate id, no run id and no resource
argument, and `cmdGateDeliver` passes only a holder through (`:614-620`). A resource-parameterised
`deliverRelays` with no way to choose a resource is unimplementable. Three interfaces are available,
and the recommendation is the first:

| Option | Shape | Assessment |
|---|---|---|
| **`--run-id` (recommended)** | one pass, one resource, chosen by the operator; omitted means the global resource | Smallest change, and it matches what `D-0097` already made this verb: an operator draining a known gate's relays after a known lap. The refusal when that run's lap is live stays exact and nameable. |
| `--resource` | the operator spells the lease resource | Rejected: it re-exposes the string the endpoint refuses to let an operator choose (`endpoint.ts:571-577`), which is the mistake `D-0076` records for `--recipient`. |
| enumerate distinct resources and drain each | no new argument | Rejected for lap 1: the pass would acquire an unbounded set of leases, each of which may be refused, and one `LeaseHeld` in the middle leaves a partially-drained pass whose report cannot say what it skipped. It is also a scan of `outbox` to build the set. |

So P-10 carries a CLI addition: **`gate deliver --run-id`, optional, defaulting to the global
resource.** The `--holder` help text (`src/gate/cli.ts:158-160`) and the module docstring's "one
delivery resource, one writer" (`:74-75`, `:194-196`) are re-worded in the same change, because they
state the property this entry supersedes.
- `LeaseHeld` while the lap is still live is retained and is the correct answer: for as long as a run's
  lap runs, that run's delivery authority is the lap's. `src/gate/cli.ts:44` already documents that
  refusal, and it keeps its meaning, narrowed from "a lap" to "*this run's* lap".
- The ack path (`ackOutbox`, `:843-849`) takes the same resource, for P-16's reason.

The roles then read cleanly, which is the test of whether the partition is the right one:

> **Delivery authority for a run is held by that run's lap while it runs, and by the operator's verb
> afterwards. Rows belonging to no run are drained under the global resource, by the same verb.**

Two consequences the gate should see:

- A `gate deliver` for run A and a lap for run B may now run at once. That is safe under the same rule
  as everything else: they hold different resources and no row's `delivery_resource` matches both.
- The database-wide belt invariant (4.1) gains a second reason to report a row: a run-bound relay
  sitting between the lap's exit and the operator's `gate deliver` has no live holder and is
  genuinely, correctly unowned. That window exists today too -- it is the whole reason `gate deliver`
  exists -- but the invariant's text has to name it, or the belt reports the design working as a
  violation.

**Recommendation: make `gate deliver` resource-parameterised (P-10) rather than keeping it global. The
global-only reading strands the ordinary post-lap relay path, and no other verb is positioned to drain
it.**

---

## 7. The audit trail

### 7.1 The problem, restated from measurement

Section 1.7: outbox `action` rows carry `kind = 'notify'` and a `writer_epoch`, and nothing else says
which lease minted the number. Today that is unambiguous because there is one resource. Under P-2 two
runs write `notify` rows whose epochs are independent sequences, and
`applied_epoch_regressions` -- which reads the single-writer property out of epoch order -- would
report a valid epoch 2 under one resource and a valid epoch 1 under another as a regression, while
hiding a real interleaving in the same noise (`docs/lease-fencing.md:171-178` says exactly this about
two resources).

### 7.2 What to add, and why not `effectKind`

`effectKind` is available and is the wrong tool here twice over: it is called "a workaround, not a
design" by the document that defines it, and adopting it would put a run id inside `action.kind`,
which is the column `action_one_effect_per_key` does *not* key on but which every kind-based reader
does. Nullable **`action.writer_resource TEXT`** is the direct repair, with non-null attribution
immutable by trigger and `NULL` meaning only "this row predates the column" -- the same nullable shape
and the same honesty `0004` chose for `run.writer_epoch`.

`sqlite-value-contract.md:67-83` decides the binding: `undefined` binds as SQL `NULL` with no error,
so a misspelled property reaches a nullable column silently. The compatibility column must therefore
be typed `string | null` and bound explicitly; `outbox.delivery_resource` must never be optional at
all.

**The column alone repairs nothing, because the readers do not read it -- and they are already broken
for outbox rows today.** Both audit readers derive the resource from `action.kind`:

- `WRITE_HISTORY_QUERY` filters with `substr(kind, -(length(:resource) + 1)) = '@' || :resource`
  (`lease.ts:158-167`). A bare kind has no `@`, so a resource-filtered history over outbox actions is
  **empty**, not wrong-but-useful.
- `appliedEpochRegressions` computes `new Set(history.map((row) => resourceOfKind(row.kind)))`
  (`lease.ts` at its definition), and `resourceOfKind` **throws** `LeaseUsageError` on a kind that was
  not composed by `effectKind` (`:1424-1440`). Outbox action kinds are bare `notify` and
  `human_gated` (`handlers.ts:139`, `:215`), so the regression reader raises on them today.

That is a pre-existing gap between the spike's `effectKind` convention and the path outbox actually
took, and it is measured here rather than inherited: **it is why `action.writer_resource` is worth
adding at all**, and it is also why adding the column without migrating the readers would leave
section 7.1's problem exactly where it is while looking repaired.

So P-7 covers the readers as well as the column: both select, filter and partition on
`writer_resource` when it is non-null, and fall back to the `kind`-suffix derivation otherwise.

**A read-time fallback alone is not enough, and the reason is the same measurement.** A pre-migration
outbox action row has `writer_resource IS NULL` *and* a bare `kind`, so the suffix fallback excludes it
from `WRITE_HISTORY_QUERY` and throws out of `resourceOfKind` exactly as before. The migration must
therefore backfill those rows -- and it can do so **exactly**, because a bare kind identifies them:

| `action` writer | Line | `kind` |
|---|---|---|
| `src/supervisor.ts:501-522`, `:579` | fenced insert | `effectKind(lease.resource, "post_spawn_gate")` |
| `src/control_plane/watcher.ts:729-740` | raw insert | `effectKind(scopeLeaseResource(scopeId), "watcher_heartbeat")` |
| `src/control_plane/session_binding.ts:157`, `:207`, `:257`, `:294` | via `lease.ts` | `effectKind(lease.resource, ...)` |
| `src/control_plane/run_lifecycle.ts:408` | via `lease.ts` | `effectKind(runLeaseResource(runId), ...)` |
| `src/control_plane/lease.ts:1587` | raw insert | composed by its callers above |
| **`src/control_plane/outbox.ts:531-543`, `:2389`** | fenced insert / raw refusal | **bare `handler.actionKind`** |

Every other writer composes the kind; **the outbox path is the only one that does not**. So
`writer_epoch IS NOT NULL AND writer_resource IS NULL AND instr(kind, '@') = 0` selects exactly the
outbox-path rows, and those rows were written under the one delivery resource there has ever been.
Backfilling them to the literal `'outbox-delivery'` records what is known, on section 5.3's rule, and
is not the fabrication `0004` refused. After the backfill every history row `WRITE_HISTORY_QUERY`
admits carries either a non-null `writer_resource` or a composed kind, and neither reader has a hole
left.

### 7.3 Effect deduplication stays global -- and this needs saying, because the temptation is real

`action_one_effect_per_key` is `UNIQUE (idempotency_key) WHERE status <> 'refused'`
(`0001_initial.sql:544-545`) and `idempotencyKey` is `"<recipient>:<actionKind>:<dedupKey>"`
(`outbox.ts:1068-1070`) -- no run and no resource. It is tempting, once resources are per run, to add
the resource to that index "for symmetry". **It must not be.** The index is the exactly-once
guarantee for the *effect*, which happens at a destination outside the database; adding a resource
would let two runs each perform the same effect once and call it exactly-once twice.

Confirmed safe on today's keys: relay dedup keys are `gate/<gateId>/<toStage>` (`gates.ts:612`) and
fan-out keys are `event/<eventId>/<consumerId>` (`events.ts:428`), both globally unique. The residual
is worth naming rather than assuming away: a producer that ever derives a dedup key from
run-independent inputs would let one run's effect suppress another's, and no per-run resource would
catch it, because the resource is deliberately not in the key.

---

## 8. Two concurrent laps, end to end

Runs `r-A` and `r-B` are already admitted with distinct ids, branches and workspaces (allocation is
rondo #8's -- section 10.1). Resources are `outbox-delivery:run:r-A` and `outbox-delivery:run:r-B`.

1. **Acquisition.** Each `performLap` calls `holdDeliveryLease` (`src/lap/root.ts:1243-1250`) with its
   own resource. `acquire` serialises on the `lease` primary key (`lease.ts:453-465`), but on
   *different* keys, so both succeed at epoch 1. No `LeaseHeld`. This is the change to
   `endpoint_lease.ts:177-192`, which today cannot name a resource at all.
2. **Renewal and loss.** Unchanged, per resource: the epoch comes from the acquisition and is never
   re-read (`endpoint_lease.ts:245-256`), renewal keeps it (`:264-302`), a loss latches and is never
   repaired by re-acquisition, and `requireHeld` reports it in the operator-facing family
   (`:312-327`). `D-0073` holds inside each resource unchanged.
3. **Materialisation.** Each lap renders `mcp.json` with its own `INTERLOCK_MESSAGEBUS_RESOURCE`
   (`materializer.ts:817-823`). The endpoint's startup admission (`endpoint.ts:570-605`) and the
   materialiser's mirror (`:851-860`) change from equality against one literal to acceptance of the
   legacy literal or a well-formed run resource, through the same one exported constructor.
4. **The dropbox fence, which needs no change and is the reason to check.** `honouredToken` is keyed
   by the caller's resource (`destination.ts:574-576`, `:198-200`). Per-run resources therefore give
   per-run fence keys **automatically**. This is not a nicety: had the resource stayed global while
   epochs became per-run, run B's epoch 1 would be refused as stale against run A's honoured epoch 5
   in any shared destination, and the materialiser's pre-flight (`materializer.ts:1195-1204`) would
   refuse the second lap outright. The keying is what makes P-2 coherent end to end, and a test must
   pin it rather than let it be discovered later.
5. **Enqueue.** A's gate relay is written by `enqueueRelay` with `run_id = r-A` and
   `delivery_resource = deliveryResourceForRun('r-A')`, `writer_epoch` still `NULL` -- the durable
   queue still outlives its worker (`outbox.ts:1240-1250`), because the resource is derived from the
   **row's own `run_id`**, not from a live lease. Same for B.
6. **Due.** A's poll selects on `(delivery_resource = A, recipient = external-notify)`. B's rows are
   not in the result set -- not filtered out afterwards, absent.
7. **Attempt.** `_COUNT_ATTEMPT` and `_MARK_DELIVERED` each carry all three of section 2's
   obligations. B's live epoch 1 cannot match A's row, because the resource conjunct fails first.
8. **Ack.** Unfenced and recipient-matched (`bus.ts:466-479`), and **that is no longer sufficient**:
   both endpoints serve `external-notify`, and the id an endpoint acks is caller-supplied rather than
   reached through its own poll (`endpoint.ts:330`). Section 4.2 adds `delivery_resource` equality
   beside the recipient test, still unfenced. Partitioning the poll is necessary and not enough, and
   section 9's assertions are written for both halves.
9. **Recovery.** A's sweep is scoped to A's resource, so it cannot adopt B's rows whether or not B's
   lease is live. Rows belonging to no run, and run-bound relays enqueued after their lap exited, are
   drained by a resource-parameterised `gate deliver` (section 6).
10. **Release.** Each `finally` releases its own resource (`root.ts:1261-1274`). Neither withholds
    anything from the other.

---

## 9. The real-child proof, and what makes it a proof

### 9.1 What is wrong with the evidence that exists

`test/lap/endpoint-lease.test.ts:642-663` proves the refusal in one process. Its replacement cannot be
"two processes both exited 0", because **that is green under serial execution too** -- the pre-review's
Blocker 3, confirmed. A test that would pass if the second child started after the first finished
proves nothing about concurrency.

**The proof is a barrier.** Both lap children write a ready marker and block; the parent takes its
evidence while both are blocked and releases only once **both** markers exist; a missing marker is a
failure, never permission to proceed serially. That is the assertion -- overlap -- and everything else is
consequence.

### 9.2 What the tree can and cannot build today

The precedents are real:

- `test/lap/cli.test.ts:1-30` drives the lap through CLI verbs with **real git and a real child**, and
  says why doubles would void it. The child is `test/session/helpers/fake-claude.mjs`.
- `test/gate/endpoint-relay.test.ts:1-25` puts the **built** `dist/messagebus/endpoint.js` on real
  stdio, `:212-240` spawns it with the full env, and `:198-208` records that such a case must read the
  **wall clock** for its lease because a real child fences against the system clock.
- Both are in `SPAWNING_TESTS` (`scripts/run-suite.mjs:93-119`), which runs after the parallel pass at
  a bounded worker count (`:393-412`).

**What is not there, measured:** `fake-claude.mjs` is 444 lines and contains **no occurrence of `mcp`
or `endpoint`**. It does not read the rendered `mcp.json` and does not launch the endpoint. The
pre-review's draft proposes "a dedicated fake-child mode [that] reads its actual MCP config, starts
the configured endpoint as a real stdio grandchild" as though it were nearly in place; it is a new
capability in the fake used by 65 session cases, and changing that fake that far puts the whole
session belt in the blast radius of this change.

**What *is* there, and is the reason a smaller change suffices:** the fake already has a mode switch
and env-driven knobs -- `FAKE_MODE` defaulting to `"ok"` (`:267`), `FAKE_SLEEP` (`:268`), and the
modes `refuse-in-use`, `silent`, `shielded-grandchild`, `events-then-hang`, `garbage-then-hang`
(`:270-400`).

### 9.3 The shape recommended instead

Two changes, and the split between them is the point.

**The endpoints stay with the test process.** Put the **built endpoint** in the test's own hands, one
per lap, started from **the env the materialiser actually wrote** -- read back out of each lap's
rendered `mcp.json` rather than composed by the test. That reuses `endpoint-relay.test.ts`'s proven
machinery and proves the materialiser's output is what two concurrent endpoints run under, which a
test-composed env would not.

**The overlap is the lap's, so the hold has to be the child's, and the assertions belong inside it.** The endpoints are the test's, so a
barrier between *them* would not prove the two **laps** overlapped -- lap A could complete before lap
B started and every endpoint assertion would still pass. The lap's duration is its child's duration,
so the child is the only place a hold can go, and neither existing mode gives one: `"ok"` completes
and permits serial execution, and the `-then-hang` modes never let the lap exit 0.

So the design asks for **one additive `FAKE_MODE`** -- say `barrier` -- which writes a ready marker,
polls for a release file under a bounded deadline, and then behaves exactly as `"ok"`. It is not the
draft's MCP-speaking fake: it adds no protocol knowledge, reads no `mcp.json`, and starts no
grandchild. It is safe against the session belt for the same reason the other five modes are: the
switch defaults to `"ok"` (`fake-claude.mjs:267`) and no existing case sets the new value. **The
bounded deadline is mandatory** -- a marker that never arrives must fail the case loudly rather than
hang it, for `D-1103`'s reason in 9.4 -- and the parent writes the release file only after **both**
ready markers exist. A missing marker is a failure, never permission to run the first serially.

The barrier is files, not signals: `test/lap/cli.test.ts` already runs on the Windows serial pass, and
POSIX signals are not portable there.

**The ordering is part of the specification, not an implementation detail.** Everything that needs both
leases live must be observed **while both children are still blocked**, because the moment a child is
released its lap may finish and `performLap`'s `finally` stops that lease (`src/lap/root.ts:1261-1274`)
-- after which a poll is a stale-writer refusal and the two-live-leases read is a race. The child also
cannot mark readiness "after its endpoint answers": the endpoints are the parent's, and the child knows
nothing about them. So the sequence is:

1. both children write their ready markers after the lap has acquired and materialised, and block;
2. the parent, with both blocked, reads the `lease` table and asserts **two live rows** with the
   expected holders, resources and epochs;
3. the parent starts each built endpoint from its lap's rendered `mcp.json`, polls, asserts the
   cross-delivery absences, acks, and attempts the cross-partition ack that section 4.2 must refuse;
4. only then does the parent write the release file;
5. both laps exit 0 without `LeaseHeld`, and the terminal assertions (dropbox tokens, row resources and
   epochs, the off-recipient controls) are taken after the exits.

Steps 2 and 3 are the proof; steps 1 and 4 are what make them simultaneous.

Assertions after release -- **negative evidence is the substance, positive evidence is the setup**:

- both laps exit 0 and neither reports `LeaseHeld`;
- two lease rows were live simultaneously at the barrier, with the expected distinct holders and
  resources;
- each endpoint's rendered resource, holder and epoch equal its lap's acquisition row;
- A's poll returned A's message and **no** B message; B's returned B's and **no** A message;
- each delivered row carries its own `delivery_resource` and its own epoch;
- an off-recipient control row per resource is still `pending` and unstamped by either endpoint;
- each dropbox honoured a token under **its own** resource key (section 8 step 4);
- **an ack attempted across the partition is refused**: hand B's endpoint A's message id directly --
  not through a poll -- and require the refusal, since this is the one hazard partitioning the poll
  does not close (section 4.2);
- a run-bound relay enqueued after both laps exit is drained by `gate deliver` under **that run's**
  resource, and a runless row by the same verb under the global one (section 6).

Observed-red controls, so each assertion is shown to be able to fail: restoring the global resource
must break the second marker; removing resource equality from `_MARK_DELIVERED` must produce a
cross-run stamp; removing the recipient term must adopt the off-recipient row; removing the ack's
resource equality must let the cross-partition ack succeed; pinning `gate deliver` to the global
resource must strand the post-lap relay; ids generated per run must defeat any hard-coded expected
output.

### 9.4 The budget, which is a live constraint and not a formality

The `double-green` job runs the whole suite twice per cell, and the Windows cells are an order of
magnitude slower (`.github/workflows/tests.yml:26-56`). `D-1103` raised the Windows cap to 65 minutes
**one commit before this document** (`38c667b`'s parent, `#183`) precisely because a
`windows-latest, node 24` cell measured 23m12s and a sibling cell was cancelled mid-second-run.

So: this case is mandatory in every cell (a credential-gated or opt-in case proves nothing about the
gate), it uses the repository fake child and never an authenticated `claude` -- `test/fencing/
hermetic-child.test.ts` is the opt-in precedent and is deliberately *not* the model here -- it reaches
no network, and **`D-1104` should carry a stated wall-clock budget with the barrier wait bounded and
failing loudly on timeout.** A barrier that can hang is a barrier that turns a red cell into a
cancelled one, which `D-1103`'s own text records as the failure mode that explains nothing.

`rondo D-0017` rule 6 (`rondo/DECISIONS.md:1906-1918`) forbids **rondo's** mandatory seam smoke from
driving `lap perform`, on the ground that "a test suite is not where an agent session belongs". It
does not speak to continuo's own bounded fake-child cases, of which `test/lap/cli.test.ts` is eight.
No rondo test changes.

---

## 10. Residuals, and the boundary with rondo #8

### 10.1 What each repository owns

**continuo #167 / `D-1104`:** the partition of delivery authority, the fencing of it, and proof that
two already-allocated runs execute safely side by side.

**rondo #8:** fresh `(run id, topic branch, workspace)` allocation, the capacity bound and the ledger
that enforces it, and whether `awaiting_human` consumes capacity. `rondo D-0012`
(`rondo/DECISIONS.md:975-1068`) names the allocator as a condition on either branch and says "a lease
is not a capacity ledger"; `rondo D-0019` rule 10 (`:2465-2477`) assigns replacement of the
`iteration_one_live` unique index to that ledger and names **rondo#8 and continuo#167** as the two
trackers.

### 10.2 What `D-1104` must contain for rondo's falsifier to fire -- and it is more than the column

`rondo D-0012`'s falsifier list is explicit and easy to under-read (`rondo/DECISIONS.md:1057-1064`):

> **continuo's lap-level serialisation actually going away.** Note what is *not* enough: either of the
> two changes `continuo D-0074` names lets more than one delivery resource exist and thereby makes the
> holder identity and the serialisation a live question again -- the lap may still take a single
> global lease until a further entry changes it.

So the column alone does **not** discharge it. `D-1104` must take both steps together: the enabling
change (P-2..P-9) **and** the holder-identity change (P-3 -- the lap acquires its run's resource rather
than the global one). A gate that accepted only the schema half would leave rondo waiting on a further
entry, and rondo's own text predicts exactly that misreading. **P-13 says so in one line.**

### 10.3 How much throughput this actually buys, measured -- and it is less than it looks

This is the number the gate should have in front of it, and neither the pre-review nor its draft draws
it.

`rondo docs/operations/lap-1-dogfood.md:1190-1230` (F-13) measured one iteration's lifetime under
rondo's single-flight lock:

| Span | Duration | Share |
|---|---|---|
| `admit()` -- the lap itself | 20 883 ms | 17% |
| `awaiting_human` -- gate open, still live | 104 520 ms | 83% |
| lifetime under the lock | 125 400 ms | 100% |

F-13's own conclusion is that "the lock is held for `lap + human`, the second term is unbounded, and
rondo has no say in it. **The lap is not the contended resource; the human is.**"

Cross-measured against continuo: the delivery lease is **released when `lap perform` exits**
(`src/lap/root.ts:1261-1274`), and the process exits at `awaiting_human` with the gate still open
(dogfood `:900-910`). Therefore **continuo's delivery lease is held only for the first term.** Lifting
it removes contention on 17% of the measured lifetime and none of the 83%, which is rondo's lock and
is untouched by anything in this document.

That is not an argument against #167 -- 20.9 s of hard serialisation is a real ceiling on any parallel
plan, and the cross-writes of section 2 are a correctness problem regardless of throughput. It is an
argument against `D-1104` being read as "parallel laps now work", and P-14 puts that sentence in the
entry so rondo #8 designs its ledger against F-13's shape rather than against this change.

### 10.4 Two residuals that stay open, and one stale citation

**`D-0068` stays open.** It governs `session-run:<runId>`, the orchestrator's lease, not delivery;
`D-0071` (`DECISIONS.md:12168-12211`) keeps its read-then-signal residual open and gives three grounds,
the first of which is "**It is a different lease**" (`:12186-12188`). Per-run delivery resources
neither fix nor worsen it, and `D-1104` must not be credited with closing it.

*Citation correction:* the pre-review cited `DECISIONS.md:12183-12206` for `D-0068`. At `38c667b` that
range is inside **`D-0071`**; `D-0068` begins at `:11771`. The substance of the finding survives; the
line reference does not.

**The provider-local concurrency residual stays open, and its band needs correcting.**
`minimal-operating-loop.md:1037-1045` bands it *continuo, post-lap* and says one provider instance per
run makes it "unreachable at zero cost". Measured: the residual is `#queue`, the per-instance exclusion
queue, and reaching it needs "two verbs called concurrently on one instance"
(`src/session/claude_cli_provider.ts:1156-1190`, and the residual sentence is at `:1183-1184`).
Parallel lap **processes** each construct their own provider instance, so the premise still holds and
the residual is still unreachable -- P-12 discharges the minimal loop's *evidence obligation* for the
parallel case and repairs nothing in the provider.

*Second citation correction, this one inside the tree:* `minimal-operating-loop.md:1043` gives the
residual's location as `src/session/claude_cli_provider.ts:959-994`. At `38c667b` that range is
`identityMismatchIn`, an unrelated function; the residual is at `:1156-1190`. Whoever re-bands the
residual should fix that line in the same change.

Re-band the residual narrowly: it becomes live only when something proposes **concurrent verbs on one
S1 instance, or a shared provider instance across runs**. That is a continuo change, not a rondo one,
and S1 has no concurrency contract of its own to hang it on (`claude_cli_provider.ts:1187-1189`).

---

## 11. What would falsify this document

- **A recipient that is genuinely per run already exists** somewhere this document did not measure,
  making section 3.1's rejection wrong.
- **`fenceResource` cannot be rendered as a predicate term** without widening `lease.ts`'s builder
  grammar in a way that touches the ported module beyond a mechanical addition -- which would make
  section 4's inventory a larger change than it is presented as.
- **The composite due index does not produce SEARCH** on a measured database, or its degraded twin
  does not lose it. Section 5.4 would then be proposing an index nobody has shown is used.
- **A fourth outbox producer exists**, or a fifth site assumes the global resource, that section 1's
  measurement missed. The inventory in 1.1 and 1.6 is the claim most exposed to being incomplete.
- **The barrier test cannot be made to fit the Windows budget** at the cap `D-1103` just set, which
  would force the proof to be cheaper or the cap to move again -- and moving the cap again is a
  decision, not an adjustment.
- **A dedup key derived from run-independent inputs** appears, making section 7.3's residual live.
- **Class-3 (runless) rows turn out to be unreachable in practice** -- which would make section 6
  smaller, and is worth knowing, but does not remove class 2 or the post-lap relay window.
- **A resource-parameterised `gate deliver` turns out to need a run id the verb does not have**, which
  would make section 6's drainer a larger change to the gate CLI than it is presented as.
- **A fourth way an outbox message id reaches an endpoint** exists besides `poll` and the operator's
  hand, which would mean section 4.2's ack repair is necessary but still not sufficient.
- **The additive `barrier` fake mode is not enough to hold a lap at the right instant** -- if the lap
  reaches the child later than the acquisition it is meant to overlap, the marker proves the wrong
  overlap and section 9.3 needs a different hold point.
- **A bare `action.kind` turns out not to identify an outbox-path row** -- a writer added since this
  measurement, or one in a database this tree did not produce -- which would make section 7.2's
  backfill inexact and force a read-time mapping instead.
- **`gate deliver --run-id` turns out not to determine the resource uniquely** -- a relay whose run is
  not the gate's, say -- which would push the drainer toward the enumeration option section 6
  rejects.
- **rondo's ledger arrives first and measures the lap term as binding**, contradicting F-13's shape and
  making section 10.3's conclusion the wrong way round.

---

## 12. The decision lines put to the human gate

`D-1104` is referred to by name. This table is a proposal; the gate accepts, amends or rejects each
line. **Origin** says where a line comes from: *pre-review* (supplied by the 2026-09-06 Codex review
and confirmed by measurement here), *pre-review, amended* (supplied but changed by measurement), or
*measured here* (this document's own).

| Line | Proposal | Origin |
|---|---|---|
| **P-1** | Keep `D-0074`'s fencing premise intact and supersede only its serialisation consequence (`DECISIONS.md:12371-12377`). Section 2 re-derives the premise for two runs at the statement level; nothing in it is overturned. | measured here |
| **P-2** | Add `outbox.delivery_resource` holding the **exact lease resource string**. Run-bound rows use `deliveryResourceForRun(runId) = "outbox-delivery:run:" + runId`; runless rows use the literal `"outbox-delivery"`. One exported constructor, never parsed back into a run id (`run_id` is the join). | pre-review |
| **P-3** | The lap acquires, renews, renders, checks and releases **its run's** resource. `holdDeliveryLease` gains a resource parameter (`src/lap/endpoint_lease.ts:177-192`); `D-0073`'s semantics hold unchanged within each resource. **This is the holder-identity half, and P-2 without it does not lift the serialisation** (see P-13). | pre-review, amended |
| **P-4** | `delivery_resource` is immutable by trigger, `NOT NULL`, `length > 0`, and written by **every** producer under the two rules of section 4.2 -- the **fenced** producer writes its own `Outbox` instance's resource, the **unfenced** producers derive it from the row's durable `run_id`. The invariant is `writer_epoch IS NULL OR writer_epoch was minted by delivery_resource`, and a queue still outlives its worker (`D-0054`, `outbox.ts:1240-1250`). | pre-review, amended |
| **P-5** | Resource equality goes **inside** every fenced write -- `_COUNT_ATTEMPT`, `_MARK_DELIVERED`, `_ADOPT`, `_ENQUEUE` -- and not only in the preceding selection. Section 4 carries the closed inventory. | pre-review |
| **P-6** | Recipient becomes a SQL term on `due` and on one-row adoption, as a routing defence. It is **not** the ownership partition, and section 3.1's measurement is recorded in the entry so recipient-only is not re-proposed. `MessageBus.poll`'s TypeScript filter stays. | pre-review, amended |
| **P-7** | Add nullable `action.writer_resource`; every new outbox action and refusal row writes the current resource; non-null attribution is immutable; `null` means only "predates the column". Bound explicitly as `string \| null` (`sqlite-value-contract.md:67-83`). **Migrate the audit readers in the same change**: `WRITE_HISTORY_QUERY` and `appliedEpochRegressions` derive the resource from the `kind` suffix, which is empty-or-throwing for the outbox's bare kinds today (section 7.2); both read `writer_resource` when non-null and fall back to the suffix otherwise, **and `0005` backfills the pre-migration outbox rows** -- exactly identifiable, since the outbox path is the only `action` writer that does not compose its kind (section 7.2) -- so no history row is left with neither form of attribution. **`action_one_effect_per_key` stays keyed on `idempotency_key` alone** -- adding the resource would let two runs each perform one effect and call it exactly-once twice. | pre-review, amended |
| **P-8** | Split `UNOWNED_OUTBOX_QUERY` into a **caller-scoped** recovery form and a **database-wide** invariant form that joins on the row's own `delivery_resource` and takes no `:resource`. Re-anchor `_UNOWNED_ONE_QUERY`'s character-identity to the recovery form and say in the source which it mirrors. `INVARIANT_NO_UNOWNED_OUTBOX` and `src/index.ts`'s export are part of this change. | measured here |
| **P-9** | Use the next forward migration (`0005`); never edit a historical one; backfill existing rows to the exact literal `"outbox-delivery"`; replace the due index with a measured `(delivery_resource, recipient, enqueued_at_ms)` partial form and keep positive **and** degraded EXPLAIN evidence. Say explicitly in the entry that `sqlite-value-contract.md` is a value contract and not a schema freeze. **Prefer the 12-step rebuild over `ADD COLUMN ... NOT NULL DEFAULT`** (section 5.2); the gate may take the default instead with a schema test pinning its legacy-only meaning. | pre-review, amended |
| **P-10** | Name the drainer for every row a lap does not drain, and make it resource-parameterised. `deliverRelays` / `gate deliver` stop naming `DELIVERY_LEASE_RESOURCE` (`src/gate/operator.ts:769-774`) and instead acquire **the resource of the rows they are asked to drain** -- the run's for a run-bound relay, the global literal for legacy and runless rows. A fixed global `gate deliver` would strand every post-lap gate relay, because `enqueueRelay` copies `gate.runId` (`gates.ts:612`) and `gate present` / `gate answer` normally run after `lap perform` has exited. `LeaseHeld` while the lap is live is the correct answer and is kept. **This carries a CLI addition -- `gate deliver --run-id`, optional, defaulting to the global resource** -- because the verb today takes no gate, run or resource argument at all (`src/gate/cli.ts:951-969`). | measured here, amended after Codex review |
| **P-11** | Gate implementation on a mandatory continuo target-only real-child case: two built `lap perform` processes on one production plane, two built endpoints started from the **materialiser's own rendered `mcp.json`**, a file barrier both must cross, and negative cross-delivery assertions with observed-red controls. Repository fake child only; no credentials, no network; a **stated wall-clock budget** with a bounded barrier that fails loudly (`D-1103`). The hold must be in the **child**, not between the endpoints -- otherwise the laps need not overlap -- so this carries **one additive `FAKE_MODE` (`barrier`)** on the fake's existing mode switch (`fake-claude.mjs:267`), default `"ok"` untouched. **Every assertion needing two live leases is taken while both children are still blocked**, because releasing one lets its lap exit and stop its lease (`root.ts:1261-1274`); section 9.3 fixes that ordering as part of the specification. It does **not** extend the fake to speak MCP or start a grandchild (section 9.2). | pre-review, amended |
| **P-12** | Discharge `minimal-operating-loop.md:1037-1045`'s obligation to show parallel laps keep one provider instance per run. Do **not** claim the provider's same-instance residual is fixed; re-band it to a future continuo change that first proposes concurrent verbs on one S1 instance or a shared provider, and correct that passage's stale citation (`:959-994` should be `:1156-1190`). | pre-review, amended |
| **P-13** | State that `D-1104` takes **both** halves -- the enabling change and the holder identity -- because `rondo D-0012`'s falsifier says the enabling change alone is not enough (`rondo/DECISIONS.md:1057-1064`). continuo #167 owns partitioning, fencing and the two-run proof; rondo #8 owns allocation, the capacity bound and suspend accounting. This change does not widen rondo's single-flight index and does not authorise a second rondo admission. | measured here |
| **P-14** | Record F-13's measurement in the entry: the delivery lease is held for the lap only (~20.9 s of a measured 125.4 s lifetime), the remaining 83% is rondo's lock across an unbounded human wait, and `D-1104` therefore removes contention on the smaller term. `D-1104` is not "parallel laps now work". | measured here |
| **P-15** | `D-0068` and `D-0071`'s read-then-signal residual stay open and are not credited to this change (`DECISIONS.md:11771`, `:12168-12211`). | pre-review, amended |
| **P-16** | Scope ack authority by resource. `MessageBus.ack` (`bus.ts:466-479`) settles on recipient equality alone, `Outbox.recordAck` updates by message id and status, and the endpoint's `ack` tool takes a caller-supplied id (`endpoint.ts:330`). With two endpoints on one recipient that is no longer an authority check. Add `message.deliveryResource === this._resource` beside the recipient test, in the same caller-bug family and **still unfenced**, so late and duplicate acks keep settling nothing. Section 4.2. | measured here, after Codex review |
| **P-17** | Implementation starts only after the gate accepts or amends these lines and creates `D-1104`. This document allocates no entry and is not accepted authority. | pre-review |

---

## 13. The human gate's checklist

Return or reject `D-1104` unless every answer is yes.

1. Is same-`external-notify` concurrency required for two ordinary laps, making recipient-only
   inadmissible on the measurement in section 3.1?
2. Does an exact, immutable `delivery_resource` appear in every selection **and** inside every
   mutation, not only in a preceding read?
3. Does the lap take **its run's** resource, so the entry contains the holder-identity half and not
   only the schema half (P-3, P-13)?
4. Are legacy rows preserved under the global resource rather than relabelled as run history?
5. Is there a **named drainer for every row a lap does not drain** -- including run-bound gate relays
   enqueued after their lap exits -- and does the belt's unowned invariant still state what the
   post-lap window means (P-10, P-8)?
6. Is **ack authority** scoped by resource and not by recipient alone, given that the acked id is
   caller-supplied rather than reached through the endpoint's own poll (P-16)?
7. Does the fenced producer take its resource from **its own lease** rather than from `run_id`, so
   that no row names two epoch sequences (P-4, section 4.0)?
8. Is future action-epoch attribution queryable by resource **and actually read that way by
   `write_history` and `appliedEpochRegressions`**, while effect deduplication stays global (P-7)?
9. Is recovery limited to its own resource, and does the database-wide invariant keep its
   database-wide meaning?
10. Does the real-child case prove **overlap** by a barrier held in the lap's own child -- not merely
    between endpoints -- with the two-live-lease and cross-delivery evidence taken **while both
    children are still blocked**, and observed-red controls for each assertion?
11. Is it mandatory in every `double-green` cell, free of credentials and network, and inside a stated
    wall-clock budget that `D-1103`'s cap can carry?
12. Are the provider-local residual and `D-0068` explicitly left open, and is the stale
    `minimal-operating-loop.md` citation corrected?
13. Does allocation, the capacity bound and suspend accounting remain rondo #8's, with F-13's
    measurement recorded so the ledger is designed against the human term (P-14)?
14. Does implementation wait for the gate-created `D-1104`?

---

## Appendix A. The pre-review's seven findings, measured

The 2026-09-06 Codex pre-design review was adopted as a brief constraint. Each finding was re-measured
at `38c667b` before being relied on.

| # | Finding | Verdict | Measurement |
|---|---|---|---|
| B1 | A recipient-only predicate cannot separate two runs sharing one external-notify recipient | **Confirmed**, and the cited lines are right | `src/gate/operator.ts:81`, `:600`, `:657`; `src/control_plane/gates.ts:606-620`; `src/control_plane/handlers.ts:116`, `:138-139`; `DECISIONS.md:12414-12437`. Section 3.1 rejects it and adds the re-addressing cost the review did not enumerate (ack authority, `bus.ts:466-479`). |
| B2 | Scope in `SELECT` alone lets one resource's live epoch write another's rows | **Confirmed** | `_COUNT_ATTEMPT` `outbox.ts:481-493`, `_MARK_DELIVERED` `:517-530`, `_ADOPT` `:571-574` -- all match `message_id` plus a bare epoch. Section 2 derives the failure at the statement; section 4 gives the closed inventory. |
| B3 | "Two processes both succeed" is green under serial execution; the proof needs a barrier | **Confirmed** | `test/lap/endpoint-lease.test.ts:642-663` is in-process. Section 9 adopts the barrier and **amends the mechanism**: the draft's fake-child-speaks-MCP plan is not buildable as described -- `test/session/helpers/fake-claude.mjs` (444 lines) contains no occurrence of `mcp` or `endpoint`. Section 9.3 recommends built endpoints started from the materialiser's rendered config instead. |
| M4 | `action.writer_epoch` has no resource attribution | **Confirmed, and stronger than stated** | The review supposed the `effectKind` workaround was "encoding resource in action kind where needed". It is **not in force on this path**: `_ensurePendingAction` binds `kind: handler.actionKind` (`outbox.ts:1962-1968`) and that is the bare `"notify"` (`handlers.ts:139`). There is no fallback. P-7 also adds a constraint the review did not: `action_one_effect_per_key` must stay run-agnostic (`0001_initial.sql:544-545`). |
| M5 | Legacy rows' epochs came from the global resource; back-filling them into a run scope fabricates history | **Confirmed, with the reasoning corrected** | `0004_run_writer_epoch.sql`'s header is the nearest precedent and points the **other** way on the backfill: it could not backfill because the epoch was unknown; `0005` must backfill because the resource is known (there has only ever been one, enforced at four sites). Section 5.3. |
| M6 | Editing a migration is forbidden, a new forward migration is allowed, and the value contract is not a schema freeze | **Confirmed** | `docs/production-schema.md:104-108`, `:152-154`; head is `0004`, so next is `0005`; `docs/sqlite-value-contract.md:6-9`, `:11-35`, `:67-83` is a value-representation contract measured on one driver version. Section 5.1 also reports a path drift in `production-schema.md:104-105`. |
| m7 | `D-0068` is about `session-run:<runId>` and is not closed by per-run delivery leases | **Confirmed; citation wrong** | `D-0068` begins at `DECISIONS.md:11771`; the cited `:12183-12206` is inside `D-0071`, whose first ground is "It is a different lease" (`:12186-12188`). Section 10.4. |

**Findings this document adds that the pre-review did not reach:** the runless-row class and the
missing drainer (section 6); the `UNOWNED_OUTBOX_QUERY` split and its published-invariant cost
(section 4.1); the dropbox fence file being keyed by the lease resource, which makes P-2 coherent end
to end (section 8 step 4); the `NOT NULL` / `DEFAULT` migration trade (section 5.2); the CI budget
constraint left by `D-1103` one commit earlier (section 9.4); rondo `D-0012`'s "the enabling change is
not the lifting" falsifier (section 10.2); F-13's 17% / 83% split and what it bounds (section 10.3);
and the stale in-tree citation at `minimal-operating-loop.md:1043` (section 10.4).

The pre-review's draft (`tmp/codex-draft-continuo-167.md`) supplied the structure adopted in sections
1-8 and the ten-question checklist expanded in section 13. Its file:line claims were re-measured
individually; those that survived appear above with their measurement, and those that did not are
named in this appendix rather than dropped silently.

---

## Appendix B. The in-loop Codex review of this document

A `codex exec review` pass over the committed document (round 1) raised three findings, all of which
were confirmed against the tree and are answered above rather than noted as limitations.

| # | Finding | Verdict | Where answered |
|---|---|---|---|
| B1 | A globally-pinned `gate deliver` cannot drain run-bound gate relays, because `enqueueRelay` copies `gate.runId` and `gate present` / `gate answer` normally run **after** `lap perform` exits | **Confirmed.** `gates.ts:612` binds `gate.runId`; `src/gate/cli.ts:194-196` states the verb's window is "after a lap has ended"; the dogfood shows the suspend happening post-exit. The first draft's section 6 was wrong in a way that stranded the ordinary path, not an edge case. | Section 6 rewritten; **P-10 amended** to make `deliverRelays` resource-parameterised |
| B2 | Recipient equality no longer establishes ack authority once two endpoints share `external-notify`, and the acked id is caller-supplied | **Confirmed.** `bus.ts:466-479` tests recipient only; `recordAck` updates by id and status; the MCP `ack` tool passes the caller's id through (`endpoint.ts:330`); relay ids are deterministic (`gates.ts:606-620`). Partitioning `poll` does not close it. | **New section 4.2**; **new P-16**; new assertion and observed-red control in section 9.3 |
| M3 | Deriving `delivery_resource` from `run_id` on the **fenced** enqueue path writes the global resource beside a per-run epoch, recreating the ambiguity the design removes | **Confirmed**, and it was an internal contradiction in the first draft's P-4: `Outbox.enqueue` stamps the epoch (`outbox.ts:432-444`) while its `runId` defaults to `null` (`:1283-1285`). | **New section 4.0**: the rule is stated on the epoch, not the run, with the invariant `writer_epoch IS NULL OR writer_epoch was minted by delivery_resource`; **P-4 amended** |

**Round 2** raised three further findings, again all confirmed and answered; none repeated a round-1
finding, which is the shape of a converging review rather than a contested one.

| # | Finding | Verdict | Where answered |
|---|---|---|---|
| B4 | The mandatory proof is not implementable while `fake-claude.mjs` is unchanged: a barrier between two test-owned endpoints does not prove the two **laps** overlapped, and neither `"ok"` nor a `-then-hang` mode gives hold-then-exit-0 | **Confirmed.** The endpoints are the test's, so the lap's own duration is unconstrained; the fake's modes are `ok` / `refuse-in-use` / `silent` / `shielded-grandchild` / `events-then-hang` / `garbage-then-hang` (`fake-claude.mjs:267-400`) and none holds and then succeeds. | Section 9.3 rewritten to split endpoint ownership from the hold; **P-11 amended** to carry one additive `FAKE_MODE` (`barrier`) with a bounded deadline |
| B5 | A resource-parameterised `gate deliver` has no way to choose a resource | **Confirmed.** The verb takes `--db`, `--destination-dir`, `--holder`, `--now-ms`, `--json` and nothing else (`src/gate/cli.ts:951-969`). P-10 was unimplementable as written. | Section 6 gains the interface comparison; **P-10 amended** to carry `gate deliver --run-id`, with `--resource` and resource-enumeration rejected and the reasons given |
| B6 | `action.writer_resource` alone does not repair section 7.1, because both audit readers still derive the resource from `action.kind` | **Confirmed, and it is worse than "not yet migrated"**: `WRITE_HISTORY_QUERY`'s suffix filter (`lease.ts:158-167`) returns **empty** for a bare kind, and `appliedEpochRegressions` **throws** through `resourceOfKind` (`:1424-1440`) on the outbox's bare `notify`. The readers are already broken for outbox rows today. | Section 7.2 gains the measurement; **P-7 amended** to migrate both readers with a legacy fallback |

**Round 3** raised two findings, again with no repeats, and both were refinements of round 2's own
repairs rather than new subject matter.

| # | Finding | Verdict | Where answered |
|---|---|---|---|
| B7 | A read-time fallback does not rescue pre-migration outbox action rows: they have `writer_resource IS NULL` **and** a bare kind, so the suffix fallback excludes or throws on them exactly as before | **Confirmed.** Round 2's repair was incomplete. Measuring every `action` writer showed the mapping is nonetheless **exact**: supervisor, watcher, session_binding, run_lifecycle and `lease.ts` all compose their kind with `effectKind`, and the outbox path is the only one that does not. | Section 7.2 gains the writer inventory and a backfill on `instr(kind,'@') = 0`; **P-7 amended** |
| B8 | The barrier releases before the endpoint assertions, so a released lap can exit and stop its lease, making the two-live-lease read a race | **Confirmed**, and the reviewer's second half is right too: the child cannot mark readiness "after its endpoint answers", because the endpoints belong to the parent. `performLap`'s `finally` stops the lease on every path (`root.ts:1261-1274`). | Section 9.1 re-worded; section 9.3 gains an explicit five-step ordering with the evidence taken during the hold; **P-11 amended** |

All eight are cases of the same thing: the first draft partitioned *selection* carefully and then
under-specified the three places authority is established without a selection in front of it -- the
post-lap drainer, the ack, and the fenced insert -- and then under-specified the *interfaces* the
repairs need: a way for the drainer to name a resource, a way for the child to be held, a reader that
actually reads the new column. That is worth recording as the shape of mistake this design is prone
to: a partition is only as good as the narrowest surface that has to name it, and each of those
surfaces is a change this entry has to carry rather than assume.
