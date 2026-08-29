# The minimal operating loop -- what the successor stack must build to run the organization once

**Scope.** What it would take for continuo and cadenza, without claude-org-ja, to carry one task
from delegation to a merged pull request with a human approval in the middle. This document defines
that lap, names the seams between "the invariant is ported and green" and "there is something an
operator can call", judges the five items the port left open, and puts the decisions in dependency
order.

**Status: propose-only.** No implementation accompanies this document, and it files no `DECISIONS.md`
entry. Every decision named below is proposed to continuo's human gate (`D-0031`, `D-0036`) or, where
said so explicitly, to cadenza's. The recommendations are recommendations, not decisions taken.

**What this document deliberately does not do.** It does not treat claude-org-ja's implementation as
the specification the successor must reproduce. Roughly a third of ja's delegation machinery exists
to compensate for its substrate -- a tiling terminal whose panes are the only addressable workers --
and section 3 names those parts as *not needed* rather than *not yet ported*. It also does not defer
anything to interlock: per `D-0036`, interlock is an archived source that answers nothing, and a
recommendation of the form "revisit when upstream settles it" is not an available answer here.

**Companion documents.** [`../production-schema.md`](../production-schema.md) is the DDL every
persistence claim below is checked against; [`../lease-fencing.md`](../lease-fencing.md) holds the
lease rule the spawn path is fenced by; [`../../parity/source-inventory.belts.md`](../../parity/source-inventory.belts.md)
holds the belt statuses section 5 proposes changing.

---

## 0. The revisions this was written against

Claims below were checked against source at these revisions. Two of them matter, because reading the
wrong one changes the answer:

| Repository | Revision read | Note |
|---|---|---|
| continuo | `e54c6be` (`origin/main`, D-0036) | This branch was one commit behind and was rebased before writing. A document authored on the earlier commit would have re-introduced the "retarget upstream first" wording `D-0036` had just removed. |
| cadenza | `origin/main` `47ad373` | **Not the local checkout**, which was six commits behind and Python-only. At `origin/main` the G1 TypeScript rewrite is complete at 330/330 and `src/index.ts` is a TypeScript barrel exporting `composeCatalog` and `resolveProject`. Any claim that a continuo/cadenza seam must cross a Python boundary is false at this revision. |
| claude-org-ja | working tree at `/home/happy_ryo/work/org/claude-org-ja` | Read as a reference implementation, not as a specification. |
| interlock | working tree at `/home/happy_ryo/work/org/workers/interlock` | Frozen source. Read for facts about what the port left behind, never for decisions. |

Citations to `DECISIONS.md` are by entry id only, per that file's own rule that it is never cited by
line number. Citations to source are `path:line` at the revisions above.

---

## 1. The gap is structural, not a residue of the port

Continuo has ported 1,973 of the 2,038 node ids not declined
(`parity/source-inventory.belts.md`), and cadenza's G1 rewrite is complete. On the numbers the work
looks nearly finished. It is not possible to run the organization on either.

The reason is not that the last 65 cases are the important ones. It is that **the parts that make an
organization run were never in the test suite the port is following.**

Continuo's specification is interlock's test suite, not interlock's source (`README.md`). That is a
deliberate and good choice, and it has one structural consequence nobody has written down: a module
with no tests is invisible to it. Two such modules exist, and between them they are exactly the
missing half.

**`dispatcher/runner.py` is 3,488 lines and has no tests.** There is no `tests/dispatcher/`
directory in interlock, and `dispatcher` does not appear among the eighteen subsystems in
`parity/source-inventory.manifest.json`. It is not `not-porting`, not `decision-pending`, not
`retarget` -- it was never inventoried, because the inventory is built from collected pytest node
ids and this module produced none. Its own docstring says what it is:

> This module is the runtime port of the in-tree `tools/dispatcher_runner.py` helper from
> claude-org-ja. It computes the deterministic parts of the Dispatcher delegation state machine
> (balanced split target selection, name/cwd validation, instruction-template rendering, worker seed
> + outbox file writes) and emits a JSON action plan that Dispatcher Claude reads and executes via
> MCP tool calls.

(`interlock src/claude_org_runtime/dispatcher/runner.py:1-9`.) That is the delegation act itself, and
`src/cli.ts:14-18` records the consequence in continuo without drawing it: `dispatcher` and
`migrate` are the two of interlock's six CLI subtrees that continuo does not mount, "so mounting a
subcommand for them would put a command in `--help` that cannot run".

**`transport/` is a seventeen-line package that says the contract does not exist.**

> Transport package -- currently empty by design. [...] Both that descriptor and the surface it read
> are Discard rows (PORTING_LEDGER.md D-0009 / D-0014), so the mechanism is gone. **The transport
> contract Interlock replaces it with has not been authored yet.**

(`interlock src/claude_org_runtime/transport/__init__.py:1-13`.) Interlock is frozen, so it will not
be authored there. Under `D-0036` that makes it continuo's to write, and section 5.1 says what it
should be.

So the shortfall is not a percentage. **The port carried invariants, and invariants are what a test
suite can hold.** Delivery semantics, lease fencing, the gate state machine, schema immutability,
refusal taxonomies -- all of that is real, tested, and worth having; it is the expensive half and it
is done. What a test suite cannot hold is a composition root, and the two modules that were the
composition root had no tests to be carried by. Raising the port from 96.8% to 100% moves this by
zero.

The rest of this document is about the other half.

---

## 2. The minimal lap

**Definition.** One task, one worker, one human approval, one merged PR. Concretely, nine steps:

| # | Step | What has to happen |
|---|---|---|
| L0 | Substrate | A production control-plane database exists at head. |
| L1 | Admission | An operator names a task and a project; a `run` row is created; a delegation record is persisted. |
| L2 | Workspace | A git worktree is cut from a named base **branch**; the worker's fenced configuration is rendered into it. |
| L3 | Spawn | A lease is acquired, a session is bound, a `claude -p` child starts in that workspace with the brief as its prompt. |
| L4 | Report | The worker's outcome reaches the control plane as an event on the spine. |
| L5 | Gate out | A gate is opened on that event and relayed to somewhere a person reads. |
| L6 | Gate in | The person's decision comes back with a verbatim body, the relay is acked, and the gate advances to `answered`. |
| L7 | Publish | The branch is pushed, a PR is opened against the same base branch the worktree was cut from, the PR is merged. |
| L8 | Close | The merge is observed, the run reaches `completed`. |

**One constraint the table states deliberately: the base is a *branch*, not a ref.** A worktree can be
cut from a tag or a commit SHA and a naive design would allow it, because L2 only needs something
resolvable. But L7 requires the base to name a branch -- a PR cannot target a tag or a bare SHA -- so
a lap that accepted an arbitrary ref at L2 would reach L7 with no valid target and no way to satisfy
the "same base" invariant that keeps unrelated commits out of the PR. **Require a base branch at
admission, persist it in the delegation record (6.3), and record the resolved commit separately if
the lap wants provenance.** Cadenza's G1 already validates a base branch as a distinct value type,
which is one reason it is the natural supplier once it is callable (4.8).

**What makes this minimal.** One project, one worker at a time, one gate, git worktrees as the only
isolation strategy, an operator present throughout, and no CI observation. It is the smallest thing
that is still a lap rather than a demo: the human gate is load-bearing, and it is load-bearing only
if the worker genuinely cannot publish (section 4.5).

**Two properties the lap must not lose, because they are the reason to build it.**

1. **The approval is a durable typed record.** ja records the approval act nowhere -- its
   `journal-events.md` has no user-approval event on the delegate or PR lane. Continuo's `gate` /
   `gate_transition` / `gate_relay` tables carry the answer verbatim, admit `human` as the only actor
   for `presented -> answered`, and make the transition history immutable by trigger
   (`src/control_plane/migrations/0001_initial.sql:1264`, `:1380`, `:1457`;
   `src/control_plane/gates.ts:199-262`). This is the single largest correctness gain available, and
   it is currently unreachable.
2. **The worker cannot publish.** The fence is what turns a report into a request for approval rather
   than a notification of a fait accompli.

---

## 3. What the minimal set excludes, and what that costs

Two different kinds of exclusion. The first is work deferred; the second is ja machinery the
successor does not need at all. Keeping them apart matters, because a plan that treats the second
kind as a backlog will rebuild a terminal multiplexer's compensations on a substrate that has no
terminal multiplexer.

### 3.1 Deferred to later laps

| Excluded | Cost of excluding |
|---|---|
| CI observation and the run/PR watcher | `ci_observation` stays empty and `run_pr_link` is written by hand or not at all. The merge approval rests on the human's own reading. Note what is being deferred: ja *automates* merge-to-close, and continuo's schema deliberately splits it into watcher-appends-event / consumer-makes-the-transition (`docs/production-schema.md:240-247`) because collapsing them once wrote a foreign PR's metadata onto a run. The split stays untested. |
| The reconcile sweep | `sweepSubjectGone`, `gatesNeedingAdvance`, `gatesPastDeadline`, `relayGaps`, `stalledRelays` all exist as queries in `src/control_plane/gates.ts` and nothing calls them. An acked-but-unadvanced gate after a crash stays stuck, and `gate.deadline_at_ms` is unenforced. Acceptable only while a person is watching the lap. |
| `incident` writing | `grep "INTO incident" src/` returns nothing, and `incident` is in `PROTECTED_TABLES` (`src/control_plane/lease.ts:1267-1274`). Every "On a hit -> raise an incident" cell in the reconcile table (`docs/production-schema.md:546-553`) has no landing place. Deferring the sweep and deferring the incident writer are the same deferral; do not count them twice. |
| Durable secretary intake | Zero cost, **provided** the design says outright that the admission command *is* the intake. The cost of not saying it is a second answer to "where does a task come from" appearing beside the run table. |
| Retargeting `continuo attention` at the successor spine | See 3.2 -- this is currently pointed backwards, and the note belongs in the plan. |
| Lease renewal | Excludable, and section 4.9 says why the obvious alternative -- a longer TTL -- is not an answer. What must be written down instead is that **the lease does not span the human wait.** |

### 3.2 Not needed, rather than not yet ported

- **The whole pane substrate.** Balanced-split scheduling over `list_panes` geometry, `send_keys` to
  answer a TUI prompt, `list_peers` polling because pane creation and peer registration are separate
  events, `CLOSE_PANE`, and the two-stage worker-absence determination. All of it exists because a
  pane is a long-lived rectangle whose liveness must be inferred from terminal output. ja's own
  backend contract concedes the geometry requirement is self-inflicted -- geometry is required
  because the balanced-split scheduler depends on it. A `claude -p` child is one turn whose end is a
  `result` line in its own output (`src/session/claude_cli_provider.ts:2234-2278`). "Did the worker
  finish" is answered by reading the last line.
  **Residual cost, and it is real:** a child that hangs without ever writing a result reads as
  `COULD_NOT_OBSERVE` and nothing escalates it. That is the one liveness case the turn shape does not
  answer for free.
- **`WORKER_COMPLETION_NOTED` / `WORKER_REOPENED`.** A monitoring-suppression patch for a false
  positive in a screen-scraping stall detector, which exists only because ja infers liveness from
  terminal output. Its partner fails unsafe when dropped, which is why ja had to add a second
  DB-based backstop. A successor with real run state needs neither.
- **Three redundant notification layers.** ja needs them because its primary notification can
  silently no-op. Continuo's `event` + `consumer` + `event_consumption` fan-out
  (`src/control_plane/migrations/0001_initial.sql:600-606`, `:681-791`) is a ledger-backed pull;
  one layer is the design.
- **Pattern A/B/C and the base-clone reservation.** ja's reservation predicate protects a shared base
  git clone slot. A worktree-only lap has no such slot. Continuo has already refused half of this
  internally: `src/fencing/renderer.ts:6-18` records that `sandbox_by_pattern` is discarded and that a
  role document still carrying it is *refused*, not ignored -- while `continuo settings generate`
  still offers `--pattern` and `--base-clone` (`src/settings/cli.ts:114-133`). That inconsistency is
  worth resolving when the fence is wired, not before.
- **Hand-typed journal events.** ja has two writers for some facts, and a hand-typed `pr_merged`
  produces a duplicate relayed event with no head, which fails a freshness gate and silently skips a
  pane close -- a whole failure class created by having two writers for one fact. The successor's
  events should be helper-owned only.

### 3.3 One shipped surface that points backwards

`continuo attention scan|watch` is one of the four mounted subtrees, and it reads **ja's** substrate:
`.state/state.db`'s `events` table and `.state/pending_decisions.json`, selecting on ja's event
vocabulary (`src/attention/readers.ts:34-45`, `:167-171`, `:191-196`). It sees nothing about a
continuo run. It should not be counted as a successor-stack capability in any plan. The lap's
"something needs a human" mechanism is the gate relay, which is stronger than a polling watcher
because it is ack-gated rather than best-effort.

---

## 4. The seams

Each seam is a place where the invariant is ported and green and there is no operational mouth. They
are ordered by the lap step they block.

### 4.1 Persistence -- no way to bring a control plane into existence (L0)

`createProductionControlPlane` (`src/control_plane/migrator.ts:313`), `migrateControlPlane` (`:438`)
and `verifyProductionDatabase` (`:573`) all exist, stamp `PRODUCTION_APPLICATION_ID`, and run a
numbered forward-only migration ledger. Outside the barrel, `migrator.js` is imported by exactly
`src/measurement/reader.ts` and `src/measurement/provenance.ts` -- both read-only by construction
(`reader.ts` opens with `readonly: true, fileMustExist: true`).

The shipped `continuo` binary mounts `measure`, `settings`, `sandbox` and `attention` and nothing
else (`src/cli.ts:88-113`). **There is no verb that creates a database.** An operator with the
package cannot produce the file every other step writes into.

*Required for the lap. The cheapest seam on the list: two existing functions and one parser mount.*

### 4.2 Persistence -- two databases that refuse each other (L0, and it blocks L5/L6)

This is the one seam that is easy to miss and hard to route around.

- The only thing in the repository that runs as a process is `src/messagebus/endpoint.ts`: a
  line-delimited JSON-RPC MCP server over stdio with a real `main()` and entry-point guard,
  exposing exactly two tools, `poll` and `ack` (`:76-97`, `:439-513`).
- It opens its database with `openControlPlane` from `../control_plane/schema.js`
  (`src/messagebus/endpoint.ts:10`), which stamps and demands `SPIKE_APPLICATION_ID`.
- The `gate`, `gate_transition`, `gate_relay` and `event` tables exist **only** in the production
  schema. The spike schema has six tables: `run`, `session`, `lease`, `outbox`, `incident`, `action`.
- `verifyProductionDatabase` refuses a spike-stamped file outright and says why:

  > there is no migration from the spike schema and none will be written (D-0026, D-0013: the cutover
  > is at the run boundary with no state conversion)

  (`src/control_plane/migrator.ts:584-592`.)

So everything that *runs* speaks to one file, and everything that carries run, gate and event
lifecycle is DDL in a different file that the first one is forbidden to open.

**Why this blocks the human gate specifically.** `RELAYED_STAGES` is `["presented", "forwarded"]`
(`src/control_plane/gates.ts:128`), and a relayed stage advances only when its outbox row is acked --
the module states the rule in its own header and `advanceOnAck` enforces it via `_ackedRelayMessage`.
`enqueueRelay` writes the `gate_relay` row and the outbox row in one transaction (`:542-621`). And
`CLOSE_OUTCOME_STAGES` (`:277-284`) makes `answered_and_forwarded` reachable **only from
`forwarded`**; closing from `received`, `presented` or `answered` can only yield `withdrawn`,
`subject_gone`, `expired`, `unanswerable` or `superseded`.

Therefore **a successful approval needs two acked relays** -- one carrying the question out, one
carrying the answer onward -- and both need an outbox in the same database as the gate. A lap that
skips the relays does not get an unapproved gate; it gets a gate closed as `withdrawn`, which is not
an approval.

*Required. Section 5.1 recommends the direction and gives the corrected cost.*

### 4.3 Run lifecycle -- the `run` table has no writer (L1)

`grep -rn "INSERT INTO run\b\|UPDATE run\b" src/` matches nothing. The only two hits for `INSERT INTO
run` are different tables: `run_pr_link` (`src/control_plane/repo_link.ts:656`) and the canary
rehearsal's `run_owner` (`src/canary/routing.ts:269`). The only `startRun` in the tree is
`src/canary/synthetic_v1.ts`'s, which appends to a JSON-lines file and says in its own docstring that
it is the throwaway v1 stand-in.

Meanwhile the DDL is complete and strict: `status IN ('created','running','suspended','completed',
'failed','cancelled')` with a forward-only trigger that freezes terminal states
(`migrations/0001_initial.sql:73-118`). And `session.run_id` is `NOT NULL REFERENCES run(run_id)`
under `PRAGMA foreign_keys = ON` (`src/sqlite/open.ts`, `src/control_plane/connection.ts:77`).

**This is a hard stop, not a soft gap.** `prepareBinding` inserts a `session` row carrying `run_id`;
with no run row the foreign key refuses it. Nothing downstream of L1 can be recorded at all.

*Required.*

### 4.4 Run lifecycle -- the lap's events have no vocabulary and no producer (L1, L4, L5)

`EVENT_TYPES` (`src/control_plane/events.ts:110-125`) holds ten names: `ci_observed`,
`pr_head_updated`, `pr_merged`, `pr_closed`, `pr_reopened`, `worker_escalation_raised`,
`gate_expired`, `gate_closed`, `consumption_skipped`, `watcher_heartbeat_refused`. There is no
`delegated`, no `spawned`, no `reported`, no `completed`. `appendEvent` is imported by exactly three
modules -- `gates.ts`, `repo_link.ts`, `ci_ingest.ts`.

This matters because `gate.origin_event_seq` is `NOT NULL REFERENCES event(seq)`
(`migrations/0001_initial.sql:1270`): **a gate cannot be opened without a prior event on the spine.**
`worker_escalation_raised` is the type the lap would use, and it has no producer.

*Required, but only a thin slice: naming the two or three types the lap emits. Closing the whole
vocabulary in a CHECK can wait.*

### 4.5 Session supply -- three separate omissions (L2, L3)

**No composition root.** `src/supervisor.ts` (the lease-before-spawn orchestrator) is imported by
`src/index.ts` and nothing else in `src/`. `src/control_plane/gates.ts` is imported by one non-barrel
module, and only for a constant. Every lap-relevant capability is a library function reachable from
the package barrel or from tests. A lap can be performed today only by hand-writing a TypeScript
program.

`SessionOrchestratorOptions` (`src/supervisor.ts:231-247`) says exactly what a producer must supply:
`runId`, `holder`, `workspace`, `role`, `nowMs`, `sessionUuidFactory`, and an optional opaque
`settings`. Nothing in `src/` supplies any of it.

**No workspace materialization.** `ClaudeCliSessionProvider` resolves the `workspace` path and, if
absent, creates it with a bare `mkdirSync(workspace, { recursive: true })`. Nothing writes a git
checkout, a brief, or a settings file into it. Continuo executes no git and no GitHub call anywhere:
`gh pr` appears in the tree exactly once, as a permission string in
`src/settings/role_configs_schema.json`. This is the largest genuinely-new build in the lap.

**`FencedSpawner` is wired to nothing, and this is the one that makes the gate hollow.**
`src/fencing/spawn.ts:504` implements the fail-closed spawn precondition: on a broken rendered
configuration the injected spawner callable is never invoked, and admission is a private method so no
second path to the child exists. `grep -rn FencedSpawner src/` finds its own file, the barrel
re-export at `src/index.ts:502`, and two prose mentions. The real spawn path,
`ClaudeCliSessionProvider`, imports only fencing's Python-semantics helpers -- never `spawn.js`.

If the lap spawns through the provider directly, the worker's fence was never admitted, the worker
may or may not be able to push, and **the human gate becomes advisory**. Wiring it is a composition,
not a build: `FencedSpawner.spawn(role, ctx, spawner)` takes the spawner as a callable.

One note that changes which fencing surface to use. There are two, with different couplings.
`continuo settings generate` requires `--claude-org-path` (`src/settings/cli.ts:80`) and
`role_configs_schema.json` renders roughly fifteen hook commands as
`bash "{claude_org_path}/.hooks/*.sh"` -- shell scripts that exist only in claude-org-ja. But
`src/fencing/renderer.ts` renders a complete fence whose hook command is `{python} {hook_script}`,
where the interpreter defaults to `process.execPath` (`:239`, documented at `:187-196`) and the hook
script is continuo's own `src/fencing/hook.mjs`. `commandRunsHook` (`:939`) checks the rendered
command's first two tokens against exactly that pair.
**The ja-independent path is `src/fencing/`, and it is the one that is not on the CLI.** A lap built
on `settings generate` inherits a dependency on the repository it is replacing.

*All three required.*

### 4.6 The delegation payload has no type, and nothing persists it (L1, L3)

`StartRequestFields` is `sessionId`, `workspace`, `role`, `settings` and nothing else
(`src/session/provider.ts:619-624`). The actual instruction reaches the child as `settings.prompt`,
an untyped string key read out of an opaque bag (`src/session/claude_cli_provider.ts:153`), with
`resume_prompt` and `cli_args` beside it. There is no persisted record of what the worker was asked
to do: `run` has no payload column, and `task` has no DDL at all.

`docs/production-schema.md:1710-1712` already records this as a known hole **with a stated
procedure**, which is cheaper than re-deriving one:

> **`task` and `assessment`.** `D-0001` names both and neither has DDL, here or in the spike,
> because neither G3 nor G4 exercises them. They are not designed by implication: the first Issue
> that needs them writes their DDL as a migration step, against this document's conventions.

*Required, in a minimal form. See section 6.3 -- and note that this belongs to continuo, not to
cadenza's G2.*

### 4.7 Report ingress -- the direction of travel that does not exist (L4)

This is the seam with no mechanism at all, as opposed to a mechanism with no mouth.

The MCP endpoint exposes `poll` and `ack`. There is no `report`, no `escalate`, no `send`. S1 forbids
the provider from having a delivery verb and says so as a property
(`src/session/provider.ts:55-61`), assigning delivery to the MessageBus. So **the only write a worker
can make into the control plane, anywhere in the successor stack, is `ack(message_id)`** -- one bit
per message it was already sent.

Meanwhile `openGate`'s own docstring says the escalation event must already be on the spine and that
the party which observed the escalation appends it. No party can observe a worker escalation, because
the worker has no way to say anything.

What the worker's output *does* produce is a per-session JSONL transcript under the provider's
`stateRoot` (`src/session/claude_cli_provider.ts:2496-2515`) -- a third store, outside both
control-plane databases, that nothing ingests. `SessionReadout` carries `sessionId`, `observation`,
`providerState`, `couldNotObserveReason` and `providerDetail`, and the result branch puts
`is_error` / `subtype` / `terminal_reason` / `returncode` into `providerDetail`. That is enough to
know *that* a turn ended and how; it is not the report.

Three ways to close it, and the choice is genuinely open:

1. **Read the transcript.** The orchestrator reads the child's terminal `result` line and appends a
   `worker_escalation_raised` event. Needs no new transport and no new tool. Smallest.
2. **Add a third MCP tool.** `report` on the endpoint, worker-outbound. Symmetric and larger; it
   also reverses the endpoint's stated "nothing here pushes" posture in one direction, which is a
   decision, not a detail.
3. **Accept the turn's terminal word as the whole report.** Cheapest, and it makes the human gate's
   question "here is what the worker produced, approve or not" answerable only by reading the diff --
   which loses the property that makes ja's approval gate work for a non-technical approver.

**Recommendation: (1).** It gets the durable event with no new surface, and it keeps the worker's
prose report -- ja's "Human Understanding Summary", the most transferable idea in ja's whole lap --
in the record rather than requiring the approver to read a diff.

**Where the report goes, and where it must not.** It goes in the **origin event's payload**, and from
there into **`gate.rationale`**, which is `NOT NULL` with `length(rationale) > 0`
(`migrations/0001_initial.sql:1271`, `:1285`) and is exactly the field that says why the gate exists.
It must **not** go in `gate_transition.body`. That column carries the verbatim answer on the
`presented -> answered` advance -- an edge `ADMISSIBLE` opens to `human` and to no other actor
(`src/control_plane/gates.ts:199-221`), and one `advanceOnAck` refuses with `AnswerBodyRequired` when
the body is null. Putting worker prose there would record worker-authored text as the human's
approval, which destroys the single property this lap is being built to gain. The two fields are the
question and the answer, and the design must keep them apart.

*Required.*

### 4.8 cadenza has no callable artifact (L1, L2)

At `origin/main`, cadenza's G1 is complete in TypeScript and `src/index.ts` exports `composeCatalog`
and `resolveProject`. But `package.json` is `"private": true` with no `bin`, no `exports`, no `main`
and no `build` script, and `pyproject.toml` has no `[project.scripts]`. Both executor seams
(`adapters/interlock/`, `adapters/claude_code/`) are docstring-only, and `LocalPathVerifier` is an
unimplemented shape in both languages -- which the G1 design document calls mandatory before a clone
rather than optional hardening.

`config/projects.toml` registers exactly two projects, `interlock` and `cadenza`. **Neither continuo
nor claude-org-ja is in the catalog.**

*Deferrable for lap 1 -- the workspace can be cut from an operator-named path and base branch. Not
deferrable if the lap is to use cadenza at all, and the packaging decision is cadenza's.*

### 4.9 The lease must not span the human wait, and a longer TTL is not the fix

`SessionOrchestrator` defaults `ttlMs` to `30_000` (`src/supervisor.ts:296`), and nothing in `src/`
calls `renew`. The tempting response -- configure a TTL longer than the lap -- **does not work, and
the reason is worth stating rather than discovering.** L6 is an unbounded wait on a person. No finite
TTL is guaranteed to outlast it, so "set it large enough" is not a property, it is a hope; and when
it fails, the lap loses write authority mid-flight and every later fenced write is refused as a stale
writer, which is a configuration failure that reads like a bug.

The lap does not have this problem, provided the design says so explicitly, because
**`SessionOrchestrator` already acquires per verb rather than per lap**: `start()` and `recover()`
each call `#acquire()` at their own entry (`src/supervisor.ts:629`, `:695`), and the lease's scope is
the spawn-admission critical section. So the correct statement is not "renewal is deferred" but
**"the lease is never held across the gate"**.

Two facts from `src/control_plane/lease.ts` make that safe rather than merely convenient, and they
point the opposite way to renewal:

- **An expired lease is not renewable by design.** "a lease that expired while the holder was paused
  is not renewable -- the holder has to re-acquire, and re-acquiring hands it a new epoch"
  (`:490-492`). Building the lap around `renew` would be building it around the one verb that refuses
  the case the lap actually has.
- **Re-acquisition raises the epoch, and that is the wanted behaviour.** "Every takeover raises the
  epoch, including a re-acquisition by the same" holder (`:411`), and every fenced write validates
  the epoch inside the write (`:113-114`). So any write still in flight under the pre-gate epoch is
  refused rather than silently landing after the answer.

So for the **orchestrator's** lease the rule is a plan line, not a decision: each control-plane
operation after the answer re-acquires and proceeds under the new epoch, and nothing holds an
orchestrator lease across L5-L6.

**The endpoint is a different holder, and it is a real open question.** The re-pointed messagebus
endpoint is a long-running process, and it does not manage its own lease at all:

> `INTERLOCK_MESSAGEBUS_RESOURCE` / `INTERLOCK_MESSAGEBUS_HOLDER` / `INTERLOCK_MESSAGEBUS_EPOCH` --
> the lease identity this endpoint's writes are fenced under. **The endpoint does not acquire or
> renew the lease; lease orchestration is the control plane's**, and a stale epoch surfaces as
> `StaleWriterRefused` out of `poll`, refused durably.

(`src/messagebus/endpoint.ts:42-46`.) The epoch is fixed at startup from the environment, and every
`poll` write is fenced on both that epoch and the lease still being live. So an endpoint left running
across an unbounded human wait stops being able to write, whether or not anyone took the lease over.
**This must be decided for lap 1; it is not covered by the per-verb rule above.**

| | What it means | Assessment |
|---|---|---|
| **A** | **Run the endpoint only while a worker turn is live** -- start it at L3, stop it at L4. It never spans the gate, so no renewal is needed and the fixed startup epoch is correct for its whole life. | **Recommended.** It matches the turn shape the lap already has (5.5): a `claude -p` child is one turn, the endpoint exists to serve that turn's `poll`/`ack`, and after L4 there is no worker to serve. It also keeps the "no lease crosses the gate" rule true of the whole lap rather than of one component. |
| **B** | Give the endpoint an owner process that holds the lease and renews it on a timer. | The general answer, and the one a later unattended lap will need. It is a new long-running component in a lap whose whole point is to be minimal, and it puts renewal on the critical path before anything has shown what TTL is right. |
| **C** | Restart the endpoint per poll cycle with a freshly acquired epoch. | Works, and re-acquisition raising the epoch makes it safe, but it turns a stdio server into a supervised respawn loop for no gain over A. |

**So renewal is deferred, but only because option A removes the case that needs it** -- not because
the case does not exist. If the lap is built any other way, renewal moves from deferred to required
and belongs in step 4 of section 7.

*An earlier draft of this document said the lap should "set the TTL explicitly beyond the lap's
duration". That was wrong twice over -- no such value exists for an unbounded wait, and the claim
that the 30-second default expires mid-lap misread the orchestrator's per-verb lease as a per-lap
one. The correction in turn missed the endpoint, which is genuinely a per-process holder; the table
above is that second correction.*

### 4.10 Nobody publishes: L7 has no actor, and the second relay has no acker

The worker is turn-shaped and, once L4 has ingested its terminal result, it has ended. It is also
deliberately fenced from publishing -- that fence is the whole reason the gate is worth having (4.5).
And continuo executes no git and no GitHub call anywhere (4.5). **So after the approval, no component
in the successor stack can push a branch, open a PR, or merge one**, and none of the seams above
names a replacement. The same hole has a second mouth: `CLOSE_OUTCOME_STAGES` requires the gate to
reach `forwarded` before it can close as `answered_and_forwarded` (4.2), and `forwarded` is a relayed
stage, so **something must ack the second relay** -- the one that carries the answer onward. The
`poll`/`ack` endpoint is worker-facing and pinned to one recipient, and by L7 the worker is gone.

Left implicit, this is where the lap quietly stops. Stated, the answer for lap 1 is small and is the
honest one:

**The operator is the publisher and the acker of the second relay, and lap 1 says so in writing.** A
person is present throughout by the lap's own definition (section 2), and section 3.1 already defers
every automated PR and CI path. Concretely: the second relay's recipient is an operator-facing
destination rather than the worker's; the operator runs the push, the PR against the recorded base
branch, and the merge with their own credentials; and a CLI verb records the ack that lets the gate
close as `answered_and_forwarded`. That keeps the durable decision record -- the property the lap
exists to gain -- while conceding that the *execution* after the approval is manual in lap 1.

Two things must be recorded alongside it, or the concession will read later as a design:

1. **Which recipient the gate's relays address.** The endpoint refuses at startup a recipient no
   handler serves, and the registry supplies only `external-notify` (whose effect is a write into a
   `KeyedDropbox` directory) and a human-gated handler that by design delivers nothing
   (`src/control_plane/handlers.ts:93`, `:97`, `:190-203`, `:220-225`). So either both relays address
   `external-notify` and the operator reads the dropbox, or a third handler is written. **This is a
   decision, not a detail**, and it belongs with the gate verbs in step 10.
2. **That a privileged publisher is the deferred work, not a missing piece nobody noticed.** The
   second lap's publisher is the component that turns `run_pr_link` and `ci_observation` from
   ingestion APIs into something with a producer (4.5). Its permission posture -- it may push, the
   worker may not -- is the substantive design question, and it is better answered against a lap that
   has run than before one.

*Required -- as an explicit assignment. The build is near zero; leaving it unassigned is the defect.*

---

## 5. The five open items

Each verdict below survived an adversarial pass whose job was to refute it. Where the pass changed a
verdict or a cost, that is stated.

### 5.1 `broker` -- 54 collected cases plus 5 uncollected modules (`retarget`)

**Verdict: required -- but not the part the status names.**

The item is really three questions, and only one of them is on the lap.

*The 54 collected cases are not transport.* `tests/broker/test_residents.py` is process-identity
pre-flight detection and reclamation of unmanaged residents. `residents.py:6-16` states that the
registry it scans is written by the **consumer**, not by the runtime -- and `grep -ri residents` over
claude-org-ja returns zero hits, so no consumer ever wrote one. Porting them means building both
halves of a protocol nobody has used. Worse, the reclamation policy they encode contradicts
continuo's: `src/supervisor.ts:699-703` states that no orphan is adopted into a run its binding does
not name.

*The 5 uncollected modules drive a file that does not exist.* All five are quarantined behind
`pytest.importorskip("claude_org_runtime.broker.server")`, and `ls interlock/src/claude_org_runtime/
broker/` shows no `server.py` -- it was deleted. `broker/__init__.py:3-4` says "the pane-control MCP
surface this package was originally built around is gone", and what survives (`rpc.py`) is a
localhost HTTP admin RPC. Continuo has no HTTP anywhere. These files have no node ids, so there is
nothing to inventory and nothing may be invented. `D-0032` already named the messagebus package as
their destination, and that belt is complete at 43/43.

*The transport question is already answered in running code.* `src/messagebus/endpoint.ts` is a
working stdio MCP server. **There is no transport to build.** What there is, is the schema split of
section 4.2.

**Options.**

| | What it means | Cost | Risk |
|---|---|---|---|
| **A** | Decline the whole broker belt; re-point the endpoint at the production schema and align the outbox with migration 0003. | See below -- larger than "one import". | The delivery invariants the five files carried verbatim are declined rather than re-expressed; the attention broker-journal path is left with no producer. |
| **B** | Port the 54 residents cases (make `_hostname` and `_clock_ticks` injectable), keep the 5 as retarget. | `residents.py` is ~32 KB plus ~28 KB of test, and the port must also invent the registration half. A belt, not a task. | Highest cost, lowest lap value, and the ported reap rule would contradict `supervisor.ts:699-703`. Leaves the schema split unresolved, so the gate stays unreachable. |
| **C** | Keep the endpoint on the spike database; run gates on a second production database. | No endpoint or outbox edit. | `enqueueRelay` writes the gate_relay row and the outbox row in **one transaction**, and gate closure cancels the relay's outbox row in the closing transaction. This option requires splitting both transactions or relaxing the `received -> presented` edge -- i.e. it converts an outbox edit into a distributed-transaction problem. Strictly worse than A. |

**Recommendation: A.** Record three things in the same entry: the residents cases are declined on the
grounds that no component on either side of the port reads or writes a residents registry; the five
uncollected files are discharged by the completed messagebus belt rather than retargeted case by case;
and the endpoint moves to the production schema.

**The cost of the re-point, corrected.** It is *not* a one-import change, and an earlier draft of this
judgement said it was. Production head is after
`migrations/0003_outbox_cancelled_status.sql`, which rebuilds the outbox table, adds `cancelled` to
the status CHECK (`0003:81`), rewrites the forward-only trigger into an explicit edge list making
`cancelled` terminal (`0003:183-190`), and narrows the partial index to
`WHERE status IN ('pending','delivered')`. Gate closure writes that status on every open relay
(`gates.ts:873-885`, `:1650-1666`). And the delivery module still speaks the pre-0003 vocabulary:
`src/control_plane/outbox.ts:185` and `:204` both spell unfinished as `status <> 'acked'`, as do
`_ADOPT` and `_COUNT_ATTEMPT`. **On a production database a cancelled relay is still returned as due,
and the next `_MARK_DELIVERED` attempts `cancelled -> delivered`, which the 0003 trigger aborts.**

**The alignment is not only those four query predicates**, and the implementing issue should treat
the four as the floor rather than the list. Two public operations decide terminality on their own and
neither knows about `cancelled`:

- **`Outbox.recordAck`** short-circuits only on `ackedAtMs !== null` and refuses only when
  `deliveredAtMs === null`. A relay that was delivered and *then* cancelled by gate closure passes
  both checks, so the `UPDATE ... SET status = 'acked' WHERE acked_at_ms IS NULL` attempts
  `cancelled -> acked`, which the 0003 edge list aborts. That is a reachable race, not a theoretical
  one: a late ack arriving after the gate closed is exactly what gate closure's relay cancellation
  creates.
- **`Outbox.attempt`** recognises `acked` as the terminal status and not `cancelled`.

So budget the re-point as: one import; the `cancelled` alignment across the four query predicates
**and the terminal-status handling in `recordAck` and `attempt`**, with the enumeration re-derived
from 0003's edge list rather than from this document; a create-and-verify precondition at endpoint
startup, since `openProductionControlPlane` refuses an absent or behind-head file; and the
`test/messagebus` fixture move. Add one more: the outbox's fault-injection evidence was accumulated
under the old predicates, so the change needs re-measuring rather than assuming.

One bookkeeping fix belongs in the same entry: the broker section heading says "4 further modules not
collected" while its body and the manifest list five.

**Band: continuo.** **Depends on: the schema decision (6.1).**

### 5.2 `migrate` -- 11 cases (`decision-pending`, `D-0035`)

**Verdict: deferrable as work. The status is not deferrable -- it is now stale.**

`D-0035` left this pending with an explicit revisiting trigger: "the run-boundary cutover bridge
actually being designed". **This task is that event.** So the question is live now, and the evidence
says the subject evaporated on both sides.

- The belt's subject is ja **v1 file artefacts**, not the successor stack's cutover.
  `interlock src/claude_org_runtime/migrate/v1_to_v2.py:1` -- "Migrate `.state/` artefacts from the
  v1 (claude-org-ja) layout to v2." Two branches only: journal JSONL and org-state markdown.
  Normalisation is `worker` -> `task_id`, `dir` -> `worker_dir`, `pane` -> `pane_id`/`pane_name`.
- **Both inputs are gone or reshaped on the live ja side.** `ja tools/journal_append.py:9-18` records
  that `.state/journal.jsonl` is decommissioned and the `events` table is the sole write target (ja
  Issue #267); no such file exists in ja today. And ja's live registry header is
  `| Task ID | Pattern | Directory | Project | Status |`, none of which matches the three lowercase
  keys `_augment_header` switches on -- so that branch is a copy-through no-op against live ja state.
- **The successor's cutover is specified three times as no state conversion**:
  `src/control_plane/spike.ts:5-8`, `migrator.ts:584-592`, and `src/canary/routing.ts:23-30` ("There
  is no other rollback code path -- no migration hook, no state converter").
- The `jsonschema` dependency question `D-0035` deferred gates **2 of the 11 cases**, and both already
  skip in interlock's own frozen tree. A further three reach modules interlock deleted and skip
  unconditionally.

**Recommendation: ratify `not-porting`, with the falsifier rewritten** from the now-fired "the cutover
bridge is designed" to one that can still fire: *if a cutover is ever specified that must convert
in-flight state rather than route at the run boundary, or if a v1 shadow episode adapter is built that
reads ja file artefacts rather than ja's `events` table, the subject exists and this is superseded.*

Rejected alternatives: keeping `decision-pending` on a new trigger re-arms on a condition this same
evidence rules out, producing a status nothing can falsify. Porting it as a rewrite against the shadow
adapter would port roughly zero assertions -- every assertion is about journal key names or markdown
column augmentation, none of which survives a move to episode-level correlation -- while claiming a
belt as ported, which is parity accounting that lies.

**Record separately:** the real outstanding work near this belt is the **v1 shadow episode adapter**.
`V1Reference` (`src/measurement/shadow.ts:603-682`) has no producer in `src/`, and
`--v1-shadow-run-ids` is a different type (`V1ShadowInput`, a cohort exclusion) that does not supply
it. That adapter is separately deferrable for lap 1, since a first lap has no v1 counterparty.

**Do not conflate** this belt with a `continuo migrate create|migrate|verify` CLI mount over
`migrator.ts`. They share only the word. Ratifying the belt does not authorise the mount; the mount is
section 6.1's business.

**Band: continuo.** **Depends on: nothing substantive.**

### 5.3 `curator` -- 71 cases (`not-porting`, ratified `D-0035`)

**Verdict: deferrable. The status is right; its falsifier needs errata.**

Nothing on the lap writes skill material. `grep -rn skills src/` returns five hits and every one is a
denial or a comment: `src/fencing/roles.json:92-93` denies `Write(**/.claude/skills/**)` and
`Edit(**/.claude/skills/**)` for the curator role, `:100` adds `denyWrite`, and the other two are
prose in `role_configs_schema.json`. There is no promotion gate, candidate digest, or path audit
module anywhere in `src/`.

The strongest counter-argument is worth stating and answering: in ja, skill promotion is not a
separate ceremony -- `ja docs/contracts/role-contract.md:230` says a worker MAY write
`.claude/skills/{skill_name}/` for skill-promotion delegations, so promotion rides the ordinary lap.
It still does not fire the falsifier, on two grounds. First, in that shape the **worker** is the
writer, editing files inside its own worktree under review; continuo mediates the spawn, not the
promotion. Second, `D-0035`'s falsifier is about continuo growing a promotion *surface*, not about the
payload of a delegated task.

**Two errata are needed, and one of them is a fact about the record itself.**

1. **The falsifier's one concrete hook is dead, and was dead when written.** `D-0035` cites
   `suisya-systems/cadenza#9`'s "agentic-layer direction" as "a live candidate, not a theoretical
   one", and `parity/source-inventory.belts.md:348-351` mirrors it. cadenza#9 is a **G2 delegation
   contract freeze marker**. It contains no agent-layer, skill, or promotion content; no such issue
   exists anywhere in cadenza; and `grep -rniE "skill|agent"` over cadenza's `src/` returns zero.
   Further, a GraphQL query for `userContentEdits` on issue #9 returns an empty list -- the body has
   never been edited since creation on 2026-08-29T03:38Z, which **precedes** `D-0035`'s ratification
   the same day. The clause was unsupported when it was written, not merely stale. This task's own
   brief reproduced the confusion, which is direct evidence that the wording misleads.
2. **The premise sentence is contradicted by shipped code.** `D-0035` grounds the decision on
   "continuo is a safety-substrate library, not the operator of those sessions". But
   `src/session/claude_cli_provider.ts:1-8` declares itself the provider "over Interlock-supervised
   `claude -p`" and spawns with `-p` at `:1307` and `:1566`. The narrower claim survives and is the
   one to keep: **continuo does not own the skill-promotion surface** -- verified, no writer, no gate
   module.

**Recommendation: keep `not-porting`; file a short errata entry in `D-0036`'s shape.** That is: leave
`D-0035` untouched with its ID and `accepted` status, and have the new entry state how it is to be
read -- restating the withdrawal condition repo-agnostically (any surface, in continuo or a layer
built on it, that writes into a live skill directory reopens the belt), recording what cadenza#9
actually is, and narrowing the premise. `DECISIONS.md`'s own rules make partial supersession
unavailable, and `D-0036` has just set the precedent for exactly this motion. The mirror in
`parity/source-inventory.belts.md` is a document, not a decision entry, and may be rewritten in place.

Rejected: leaving it alone at zero cost -- the pointer stays dead and a future reader re-derives this
confusion, and it is the last outward-facing deferral left in a document `D-0036` otherwise swept
clean. Also rejected: reopening curator because the premise sentence is wrong -- that reads the
premise as if it were the falsifier, and would reopen 71 cases for a surface that does not exist.

**Band: continuo.** **Unblocks: nothing on the lap.** This should be batched with the lap's other
entries, not sequenced ahead of them.

### 5.4 cadenza G2 -- the delegation contract (frozen)

**Verdict: deferrable as a cadenza deliverable. The freeze conditions are not deferrable.**

*Why the lap does not need G2.* The consumer is small and already written:
`SessionOrchestratorOptions` needs `runId`, `holder`, `workspace`, `role` and a prompt inside
`settings`. `holder` is an opaque lease-claimant identity used to fence spawn admission
(`src/control_plane/lease.ts:15`) -- it says which orchestrator life holds the resource, **not on
whose authority the run exists**, and "on whose authority" is exactly the half G2 owns. Nothing in the
schema makes registry-mediated resolution mandatory either: `run_pr_link.resolution` is CHECKed to
`('project_registry','explicit_operator','provider_event')` and `explicit_operator` is a first-class
member.

*What the freeze conditions actually say, stated precisely, because the loose version is wrong.*
There are three clauses and they are not all dead:

- **`cadenza README.md:48-50`: "G2 delegation contract - blocked on interlock settling its own
  contract."** This one **is** unanswerable. interlock is archived and settles nothing. It is the same
  structural defect continuo removed from its own documents as `D-0036`, still standing in cadenza.
- **cadenza#9's second disjunct**, "the interlock-side contract question it depends on is resolved" --
  same defect, same verdict.
- **cadenza#9's first disjunct**, "#8 is complete", is **live and its work is done**: cadenza's parity
  manifest at `origin/main` records 330 collected with every per-file entry `ported`, and `47ad373` is
  "the port reaches 330/0". What it does not do is oblige anyone, because #9 defers the conditions
  themselves to an undated "separate decision".
- **cadenza `D-0014`'s falsifier, "interlock#74 landing"**, is **not** a dead letter and should not be
  described as one. interlock#74's body is "Create the new repository suisya-systems/continuo and port
  interlock to TypeScript there" -- it is **continuo's own kickoff issue**, filed in the interlock repo
  before continuo existed. Nobody at interlock owes an answer. It is unfinished (continuo is at
  1,973/2,038), so the correct criticism is different and weaker: it is an **over-broad proxy**.
  Gating a delegation contract on a complete 2,194-case port blocks on far more than G2's design needs.

So: one dead clause, one over-broad proxy, and one satisfied-but-unbinding clause. The defect is not
that the freeze *cannot* be lifted; it is that **nobody is obliged to lift it**, which is a freeze that
becomes permanent by inertia.

**Options.**

| | What it means | Cost | Risk |
|---|---|---|---|
| **A** | Unfreeze now and design full G2 in cadenza before lap 1. | Lower than it looks -- there is no language boundary at `origin/main` -- but still weeks, plus packaging and `LocalPathVerifier`. | G2 frozen with zero consumer feedback, against a consumer whose whole appetite is five fields. Exactly what cadenza#2 was created to prevent. |
| **B** | Keep the freeze; **replace the conditions** with ones this stack can satisfy and observe; give continuo a lap-scoped delegation record of its own. | Two DECISIONS entries and one small struct. No cadenza code. | The continuo struct hardens into G2 by inertia. Mitigated by the entry stating it is lap-scoped and carries no authority semantics. |
| **C** | Close G2 as a cadenza goal; move the delegation contract permanently into continuo. | Low in code, high in charter -- cadenza's README lists it as one of three named goals. | Loses the provider-agnostic layering that is cadenza's reason to exist. Continuo spawns `claude -p` children directly; folding authority semantics into the executor-bound layer is the collapse the two-repo split was drawn to avoid. |

**Recommendation: B**, with the replacement condition written as an outcome inside this stack's
control: **G2 unfreezes when (i) cadenza#8 is closed, the TypeScript rewrite being the CI-enforced
implementation, and (ii) at least one continuo lap has completed end to end with an operator-supplied
workspace** -- so G2's field list is drawn from an observed consumer rather than guessed.

Two drafting constraints on that condition. First, do not phrase it as "cadenza#8's Python retirement
lands": #8 explicitly out-of-scopes removing the Python implementation, and cadenza `D-0012`/`D-0014`
foresee it as a separate later PR, so such a condition is unsatisfiable by construction. Second, do
not justify the replacement by claiming both old triggers are dead -- one is, one is an over-broad
proxy, and a reviewer will catch the overstatement.

**Band: both.** The condition replacement is cadenza's; the lap-scoped delegation record is continuo's
(section 6.3).

**Depends on: the schema decision (6.1) and the run-writer decision (6.2)** -- the record's durable
form is an event row, and the `event` table exists only in the production schema.

### 5.5 continuo S1 `SessionProvider` -- provisional scaffold

**Verdict: deferrable.** *An earlier pass called this required; the adversarial pass reversed it, and
the reversal is the substantive output here.*

First, a disambiguation that has caught two readers already. `src/session/provider.ts:74-84` cites
"D-0021", and that is **interlock's** D-0021 ("The `SessionProvider` interface is a provisional spike
artifact, promoted only by decision"). Continuo's own `D-0021` is about SQLite integer narrowing and
is unrelated. `README.md` states the convention; it is easy to miss.

**Nothing about S1's promotion state blocks a lap.** `PROVISIONAL` is referenced nowhere in `src/`
except its own definition, two prose comments and the barrels. And the harm one might invoke to make
this urgent -- promotion by inertia -- is already forbidden **in the source text**:

> `PROMOTION_REQUIRES = "a later D- entry in DECISIONS.md that promotes S1 to a settled contract
> (D-0021). Use by an implementation, by the gate, or by the control plane does not promote it."`

(`src/session/provider.ts:81-84`.) A DECISIONS entry restating that adds no obligation a reader of the
module does not already have, while spending a human-gate slot. And promoting it now is precisely the
option interlock D-0021 rejected -- freezing the contract "before any provider has taught anyone what
it must express". **The lap is the teaching.**

**Two wrong beliefs to stop carrying.** The C2 provider *has* been run against a real `claude` binary:
six `[S2]` cases in `test/gate_item11/suite-runs-unchanged.test.ts` construct
`new ClaudeCliSessionProvider(...)` with no `claudeCommand` -- falling through to `"claude"` -- behind
a `command -v claude` availability probe, and each spawns a real `claude -p --model haiku` child.
Version-coupled silent failure is also not currently live: the installed CLI is 2.1.251 against
`CLI_VERSION_WRITTEN_AGAINST = 2.1.237`, and it carries every flag in `CAPABILITY_FLAGS`. That is a
standing regression risk to re-probe, not an open gap.

**Three facts to write down instead.**

1. The real-CLI evidence proves the **provider** half only. Those cases bind by hand via
   `acquire`/`bindSession` and never enter `SessionOrchestrator`.
2. `SessionOrchestrator` has been driven over the C2 provider many times, but always against a **fake**
   CLI. **The untested cell is exactly one: orchestrator x real binary.**
3. **No session or orchestrator path anywhere in `test/` runs on the production schema.** All three
   drivers import `createControlPlane` from `src/control_plane/schema.js` -- six tables against the
   production schema's twenty-four, `gate` among them. **No existing session evidence transfers to a
   production-schema database.** This is the single most important sentence in this subsection.

**Recommendation: no pre-lap entry.** Scope lap 1 as an *evaluation* of S1, and name in advance the
evidence a later promotion entry must cite -- an orchestrator-driven real child on the production
schema, which is precisely the cell no existing test covers. Two plan lines, not decisions, come with
it: the lap is **turn-shaped** (S1 has no delivery verb by design, the child spawns with
`stdin: "ignore"`, and start is a single `-p` turn), and the lap runs **one provider instance per
run**, which makes the documented concurrency residual at
`src/session/claude_cli_provider.ts:959-994` unreachable at zero cost.

**Band: continuo, post-lap.**

---

## 6. Three decisions the seams force that were not on the list of five

These rank with the five. The first outranks all of them.

### 6.1 Which control-plane schema the lap runs on -- and a verb that creates it

**This is the most upstream decision in the document.** Section 4.2 shows the two databases refuse
each other; sections 5.1, 5.4 and 5.5 all list it as a dependency; and `migrator.ts:584-592` says no
bridge between them will ever be written.

**Recommendation: production, one database.** It is where `gate`, `gate_transition`, `gate_relay`,
`event`, `consumer`, `run_pr_link` and `ci_observation` live, and the lap is defined by the gate. The
spike schema has six tables and no `event` table at all, which alone rules it out: the gate's
`origin_event_seq` foreign key cannot be satisfied there.

Pair it with the cheapest mount in the document: **`continuo db create|migrate|verify`** over
`createProductionControlPlane`, `migrateControlPlane` and `verifyProductionDatabase`. `D-0030` already
settles where a CLI composition root lives and who owns its parser, so only the subtree name and verb
set are open. Note the name collision with the `migrate` **belt** (5.2): they share only the word, and
the mount is its own proposal.

**Band: continuo. Unblocks: everything else in this section, plus 5.1 and 5.4.**

### 6.2 The run-lifecycle writer and the lap's event vocabulary

Sections 4.3 and 4.4. Nothing creates a run, nothing advances one, and the three or four event types
the lap emits do not exist in `EVENT_TYPES`. Both are required and neither is large; what they need is
a decision about who owns the transition, because the production schema's design deliberately splits
it: the CI watcher does not move a run to `completed`, it appends `pr_merged` and a **consumer** makes
the transition (`docs/production-schema.md:240-247`). The lap will have no watcher, so the design must
say explicitly whether the admission command plays the consumer's part for lap 1 or whether the
transition is made directly -- and record that as a deliberate collapse to be undone, since the split
exists because collapsing it once wrote a foreign PR's metadata onto a run row.

`registerConsumer` also appears in `src/` only at its definition and in the barrel, so the consumer
half of the close is entirely unbuilt.

**Band: continuo. Depends on 6.1. Unblocks: the session FK, the gate FK, the close.**

### 6.3 Where the delegation record lives -- and it is continuo's, not cadenza's

This is the one item most likely to be misfiled. Its consumer is continuo's
(`SessionOrchestratorOptions`), and continuo's own schema document already reserves `task` as continuo
DDL to be written by "the first Issue that needs them". G2 remains cadenza's later generalisation --
authority and permission modelling -- not the lap's field list.

**Recommendation:** continuo owns a small, explicitly non-normative record --
`{ runId, holder, workspace, role, baseBranch, prompt, cliArgs? }` -- produced by the admission command and
persisted through the existing `appendEvent` as an event row with `subject_kind = 'run'`, so the work
statement is durable rather than living only in the child's transcript. The entry must state that it
is lap-scoped, that `holder` is a lease claimant and **not** an authority, and that it is superseded by
G2 rather than promoted into it. Note the field list is read off `StartRequest`, which is provisional
scaffold (5.5), so an S1 promotion can move it.

**Band: continuo, paired with the cadenza-band condition replacement in 5.4.**

---

## 7. The order

Each step names what it unblocks. Steps 1-3 are strictly ordered; 4-8 have some slack.

0. **Rebase onto `origin/main` (`e54c6be`); read cadenza at `origin/main`.** Done for this document.
   *Unblocks: writing anything that does not contradict `D-0036` or misdescribe cadenza.*
1. **Decide the schema: production, one database (6.1).** *Unblocks: every later step having one
   address. This is the gate that 5.1, 5.4, 5.5, 6.2 and 6.3 all wait on.*
2. **Mount `continuo db create|migrate|verify` (6.1).** *Unblocks: an operator bringing a control plane
   into existence at head, which the re-pointed endpoint's startup check requires.*
3. **Write the run-lifecycle writer and name the lap's event types (6.2).** *Unblocks: the session
   foreign key, the gate foreign key, and the close.*
4. **Record the lease's scope: acquired per verb, never held across the gate (4.9).** *Unblocks: a
   correct answer to "what TTL" -- which is that the question does not arise -- and gives the
   endpoint's lease environment variables determinate values.*
5. **Align the outbox with 0003's `cancelled`, then re-point the endpoint (5.1).** *Unblocks: the
   human gate. It is unreachable until this lands.*
6. **Decide the delegation record (6.3), and pair it with cadenza's condition replacement (5.4).**
   *Unblocks: a producer for `SessionOrchestratorOptions`, and a durable work statement.*
7. **Materialise the workspace and render the fence -- one artifact-first step (4.5).** Use
   `src/fencing/renderer.ts`, not `src/settings/generator.ts`. Require and persist a base branch here, not an arbitrary ref (section 2). Adopt ja's ordering in spirit --
   materialise every artifact, commit the reservation last, so a committed reservation always has a
   sendable payload behind it -- without ja's base-clone reservation, which protects a slot a
   worktree-only lap does not have. *Unblocks: a worker that can both work and poll.*
8. **Write the composition root and wire `FencedSpawner` (4.5).** *Unblocks: the spawn. If the fence is
   not wired, record explicitly that lap 1 spawns unfenced and that the gate is therefore advisory --
   do not leave it implicit.*
9. **Close the report ingress: read the transcript and append the escalation event (4.7).**
   *Unblocks: `openGate`, which cannot fire without a prior event.*
10. **Gate verbs, both relays, and an ack path (4.2, 4.4, 4.10).** *Unblocks: an approval that closes
    as `answered_and_forwarded` rather than `withdrawn`.*
11. **The operator publishes: push, PR against the recorded base branch, merge; then close the run
    (4.10).** *Ends the lap.*

**Off this chain, decidable in any order:** `migrate` (5.2, ratify `not-porting`), `curator` (5.3,
errata only), S1 (5.5, record that lap 1 evaluates rather than promotes). None of them blocks anything.

---

## 8. Which DECISIONS band

**Continuo's band:** the schema choice; the `db` mount; the run writer and event vocabulary; lease
policy and renewal; the outbox `cancelled` alignment and the endpoint re-point; the delegation record
and its `task`-adjacent DDL; the report ingress; the gate verbs; the fence wiring; the broker
disposition; the `migrate` belt status; the curator errata; and S1's post-lap promotion or amendment.

**Cadenza's band:**

- **Retiring G2's freeze condition** -- `README.md:48-50` and `D-0014`'s falsifier. Both are cadenza
  text and neither can resolve as written.
- **The charter's overlapping claims.** cadenza's README claims the delegation contract *and* "gate
  management -- which checks a run must pass before it is considered done", while the gate is built,
  typed and trigger-enforced in continuo. Whichever way it settles, the sentence being edited is
  cadenza's.
- **`README.md:3`**, "Cadenza is the business operations layer that sits on top of **interlock**" --
  the successor stack's registry names the frozen repository as its control plane, in its own front
  matter.
- **The catalog's contents.** `config/projects.toml` registers `interlock` and `cadenza` and neither
  continuo nor claude-org-ja. A registry that cannot name the projects the successor stack operates on
  is a cheaper decision than G2 and probably a more urgent one.
- **Packaging.** `private: true`, no `bin`, no `exports`, no `build`. Whether cadenza is an npm library
  continuo imports, a continuo subcommand, or a separate process is cadenza's to decide first.
- **`LocalPathVerifier`'s owner** -- unimplemented in both languages, and the G1 design document calls
  it mandatory before a clone.

**The gap in the machinery.** Neither repository's `DECISIONS.md` can record a decision that binds
both. Cadenza's file defines a citation convention (`continuo D-00NN`), not a joint gate. So a paired
decision -- for instance 5.4's, whose two halves are one decision -- has to be taken twice, at two
human gates, with no artifact recording that they are the same decision. That is worth fixing before
the first paired decision is taken, and it is itself a decision for both bands.

**Out of scope here, listed so it is not lost.** The `D-0036`-shaped defect on the cadenza side --
`README.md:48-50`, cadenza#9's second disjunct, and `D-0014`'s falsifier -- is a documentation sweep
in cadenza. This document records the sentences; it does not change them.

---

## 9. What was read, and what was not

**How this was assembled.** Eight parallel surveys read continuo's `src/` by subsystem, cadenza at
`origin/main`, claude-org-ja's contracts and its actual implementation, and interlock's frozen source;
each survey was converted into a seam list by a second pass that re-opened the citations; each of the
five items was judged and then adversarially reviewed by a pass whose instruction was to refute it;
and a completeness critic looked for flow steps no seam covered. Where the adversarial pass changed a
verdict (5.5) or a cost (5.1), this document carries the corrected version and says so.

**Verified directly while writing this document**, not taken on report: `src/cli.ts`'s full mount list;
`grep "INSERT INTO run"` over `src/`; the `run` DDL and its status CHECK; `RELAYED_STAGES` and
`CLOSE_OUTCOME_STAGES`; `endpoint.ts`'s `openControlPlane` import and its two tool descriptors;
`PROVISIONAL` and `PROMOTION_REQUIRES`; every `FencedSpawner` reference in `src/`; the two
`status <> 'acked'` predicates in `outbox.ts`; `migrator.ts`'s spike refusal text;
`SessionOrchestratorOptions`; `EVENT_TYPES`; the `ttlMs` default; `D-0035`'s falsifier and its mirror
in the belts document; `D-0036`'s text; interlock's `dispatcher/runner.py` line count and the absence
of `tests/dispatcher/`; `transport/__init__.py`; and the eighteen-subsystem inventory.

**Not read.** No `claude -p` spawn was executed as part of this work -- the CLI's version and `--help`
were checked, the spawn was not. The vitest suite was not run against a production-schema database,
because no such path exists to run. Cadenza's TypeScript sources at `origin/main` were read as a
barrel and a file listing rather than module by module. ja's `backend-interface-contract.md` was read
through §8.7 and its ~500 lines of multi-tab amendments only by their supersession headers -- which
matters only if the successor were to keep a pane substrate, which section 3.2 argues against.
`sandbox-launcher-contract.md` §2-§6 were not read; §2.1 and §4.2 are the two sections to read next if
the lap generates worker sandbox configurations. Interlock's `curator/` implementation modules were
not read; only its tests were, which is what the decision turns on.

**One survey failed.** The attention/canary/fencing survey exhausted its structured-output retries.
Its subject matter is covered by the completeness critic and by direct reads for the `fencing` claims
in 4.5 -- which is how the `FencedSpawner` gap and the two-fencing-surfaces distinction were found at
all -- but that area had one fewer pass than the others, and the `canary` subsystem in particular is
not analysed here. Nothing in the lap depends on it: the canary rehearsal is a throwaway by its own
`D-0026`.
