# Re-deriving F1: pull stays the settlement, and a wake is only a hint

**Status: propose-only.** No behaviour change accompanies this document. Nothing under `src/`
changes except two comments that cite a premise measurement has overtaken (section 10), and nothing
is written to [`DECISIONS.md`](../../DECISIONS.md): section 11 drafts an entry, and the entry is a
proposal to continuo's human gate (`D-0036`), not a decision taken. The same shape
[`cli-args-allowlist.md`](./cli-args-allowlist.md) was filed in, for the same reason -- the design is
cheap to argue and expensive to unpick once implemented.

**What the human gate has already decided, and what is left.** continuo#97 offered three options and
the gate chose **B** on 2026-09-05: *keep pull as the settlement path, add a push as a wake-up only*.
So the question this document answers is not *which option* but *what B costs, exactly* -- which
component owns which half, what a wake may and may not carry, what has to remain true when it is
lost, and what in today's code stops being true if it is built. Section 12 is the decision table; the
recommendations in it are the parts the gate can still overturn independently.

**Companion documents.** [`minimal-operating-loop.md`](./minimal-operating-loop.md) is where the lap
this would run inside is defined, and section 4.9 of it is where the endpoint's lease shape was
settled; [`composition-root-placement.md`](./composition-root-placement.md) is the precedent for the
structural-capability move section 4 makes twice.

---

## 0. What was read, and at which revision

| Subject | Revision / version read |
|---|---|
| continuo | `13c7b1a` (`origin/main`), the tip that carries `D-0088` |
| Claude Code | `2.1.261`, the version the 2026-09-05 measurement was taken at |
| `codex exec` | `codex-cli 0.147.0`, from continuo#97's first comment |
| interlock | frozen at `65f36c5`; read for what the port inherited, never for a decision (`D-0036`) |

Two of these matter more than the others. The Claude version is load-bearing because the measured
fact is a fact about one build of one executor, and the draft entry's first falsifier is a change to
it. The continuo revision matters because section 4's ownership answer rests on `D-0087`, which
landed two commits before this branch started.

---

## 1. The sentence that is stale, and the exact size of the hole

Three places in `src/` cite interlock's F1. Two of them assert a capability, and those two are what
measurement has overtaken:

> Per interlock's F1 there is no non-interactive way to push a message *into* a running worker
> session, so the transport is **worker-outbound** [...]
>
> -- [`src/messagebus/index.ts`](../../src/messagebus/index.ts), module docstring

> **Why worker-outbound.** Per interlock's F1 there is no non-interactive path to deliver a message
> *into* a running background session, so delivery is a pull [...]
>
> -- [`src/messagebus/endpoint.ts`](../../src/messagebus/endpoint.ts), module docstring

The third is not a capability claim and is not touched by any of this:

> **Delivery decisions are SQLite-only.** `poll` reads {@link Outbox.due} and nothing else.
>
> -- [`src/messagebus/bus.ts`](../../src/messagebus/bus.ts), module docstring

**What the 2026-09-05 measurement establishes.** Recorded as a comment on continuo#97, two runs,
identical in shape. Setup: `claude 2.1.261`,
`claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages
--allowedTools "Bash(sleep:*)"`. Message 1 asks for three sequential `sleep 20` calls and to report
any word arriving meanwhile. Message 2 is written to stdin at t=8 s, during the first sleep.

| event | run 1 | run 2 |
|---|---|---|
| message 2 written to stdin | 8.00 s | 8.01 s |
| replayed on stdout (`type: user`), right after sleep 1's `tool_result` | 26.03 s | 26.33 s |
| assistant acknowledges the word | 28.02 s | 28.39 s |
| turn ends (`stop_reason: end_turn`) | 73.6 s | 73.9 s |

So a second stdin message is observed and acted on **inside the turn, at the next tool-call
boundary** -- after a `tool_result`, before the next `tool_use`; not during a tool call, and not only
at the end of the turn. No error or rejection event in either run.

**The hole is exactly one clause wide.** "There is no non-interactive way to push into a running
session" is false for this executor at this version. Everything else the two comments say --
worker-outbound transport, the worker as MCP client, delivery decisions from SQLite alone, an idle
worker leaving its rows due -- is unaffected, because none of it was ever derived from the absence of
a push. That is the whole of section 2.

**What the measurement does not establish**, and the draft entry has to say so in its own words
(section 11):

- **Pure text generation with no tool-call boundary.** Every observation above is anchored to a
  `tool_result`. A turn that generates prose and calls nothing has no measured boundary, and this
  measurement says nothing about when -- or whether -- a stdin message is seen inside one.
- **A single very long tool call.** For a message written into a call in flight, discovery is bounded
  by the remainder of that call -- and the longest call measured is 20 seconds. Whether a 40-minute
  call defers the signal for 40 minutes is unmeasured; the shape of the observation suggests it does,
  but suggestion is not measurement.
- **A message written between two tool calls**, during prose generation rather than into a call in
  flight. Nothing here establishes when that one is surfaced, and its delay would be a property of
  the generation rather than of any tool call -- so "bounded by the longest tool call" is a claim
  about the measured arrival time, not a general latency bound.
- **The wake frame.** The measured message carried a word the assistant acted on. Whether the fixed,
  information-free frame section 5.1 calls a wake is surfaced at all is unmeasured, and it is the
  one gap that could make a conforming implementation prompt no poll.
- **Any other executor.** `codex exec 0.147.0` has no `--input-format` and no streaming-input option:
  its stdin is the initial prompt only, and `--json` is output-side. F1 still holds there. The
  capability is a property of one executor, not of the transport -- which is itself an argument for
  keeping the delivery contract pull-shaped.

---

## 2. What pull rests on once F1 is removed from under it

The premise was a *reason offered* for worker-outbound, not the *mechanism* of it. Remove it and
three grounds are left standing, none of which mentions push at all.

**a. Delivery decisions derive from SQLite alone.** `MessageBus.poll` reads `Outbox.due` and nothing
else. There is no session readout on the path, no liveness probe, and no way to consult one: the
package has no import edge to `src/session/`, and
[`test/messagebus/import-graph.test.ts`](../../test/messagebus/import-graph.test.ts) fails the build
the day one appears. A provider readout that is stale or wrong -- a session id whose child is gone, a
`readState` answering *could not observe* -- cannot alter what is delivered, because no code path
exists from the one to the other. This is interlock gate item 6's static assertion, and it is the
property the issue asks every option to say what happens to. Under option B: **unchanged, and
structurally so.** Section 4 is entirely about keeping it that way.

**b. Resend is the default, not a recovery mode.** A poll response lost on the wire changes nothing
durable: the row stays delivered-but-unacked, stays due, and the next poll re-presents it. The ack is
the one message-level settlement, idempotent and deliberately unfenced. A transport with this
property does not need a reliable push, because it does not need any individual delivery attempt to
succeed.

**c. The recipient is the only party that can know it has finished.** The ack is the recipient's
statement, and no sender-side signal substitutes for it. A push that carried a payload would create a
second answer to "was this delivered", next to the outbox row that already answers it -- and two
answers to a delivery question is how a message gets delivered twice or not at all (`bus.ts`'s own
words about why S8 adds no second state machine).

**One thing the removal genuinely costs.** Ground (a) explains why a *wrong* liveness reading cannot
corrupt delivery. It never explained *when* a recipient polls, and the issue's consequence 1 is
exactly that: nothing in the endpoint or the design fixes a cadence, so delivery latency rests on the
recipient's own discipline. F1 was the reason that was tolerable -- there was nothing better
available. That reason is gone, which is why option B has to answer the cadence question explicitly
(section 7) rather than inherit an answer.

---

## 3. Option B, stated exactly

> **The outbox stays the single source of delivery truth. A wake carries no payload and only prompts
> a poll.**

Rendered as five sentences that the rest of this document is the working for:

1. **What is due, what resends, what is settled** is read from SQLite and nowhere else. A wake is not
   an input to any of those decisions.
2. **A wake is an empty, coalescible hint.** It carries no payload, no message id, no recipient, no
   epoch, no due count, and no acknowledgement (section 5).
3. **A wake advances the next poll. It does not replace one.** A bounded fallback cadence remains,
   and correctness never depends on a wake arriving (section 7).
4. **Enqueue never depends on wake.** A committed enqueue is never rolled back, retried, or
   reclassified because a wake failed, and no session readout precedes an enqueue (section 6).
5. **The mechanism is executor-specific and lives where the executor lives** -- in the Claude session
   provider, reached structurally, never as a verb on the provider contract (section 4).

---

## 4. Where each half lives, and why the two may not be merged

This is the part the design is actually for. Option B names two capabilities that must not be in the
same package:

- **knowing that an enqueue committed** -- which requires the control plane and the outbox;
- **being able to write the worker's stdin** -- which requires a session backend.

`src/messagebus/` may hold neither of the second kind. The import-graph test is not a style rule: it
is interlock item 6's static assertion, it scans a directory listing rather than a hand-written file
list, it follows `import`, `import type`, `export ... from`, `require()` and dynamic `import()`, and
it bans the two dynamic primitives outright so the scan cannot be walked around. Any design that puts
a wake inside `src/messagebus/` is a design that relaxes that test, and relaxing it is option C --
which the gate did not choose.

### 4.1 The mechanism belongs to the Claude provider

The pipe, its framing, its write and its close are `ClaudeCliSessionProvider`'s. That is where the
executor's vocabulary already lives, and it is the only place in `src/` allowed to know what a
`stream-json` user message looks like.

### 4.2 The capability is structural, and S1 keeps five verbs

**Do not add `wake` as a sixth `SessionProvider` verb.** S1 has exactly five (`start`,
`listSessions`, `readState`, `stop`, `resume`), named by **interlock's** `D-0009` and asserted mechanically in
`test/session/provider-contract.test.ts` (continuo's `D-0301` fixes their async shape, not their
number); and it deliberately carries **no delivery verb** at all --
`DELIVERY_ABSENCE_IS_DELIBERATE` says in as many words that adding one "would make gate items 6 and
11 unmeasurable, since what they check is precisely that no such edge exists". A sixth verb would
also misrepresent Codex, which has no such path, as having the capability, and would reopen a
provisional cross-provider contract (interlock `D-0021`, which is what `PROVISIONAL` and
`PROMOTION_REQUIRES` in `src/session/provider.ts` mark) for a facility one executor has.

The precedent for what to do instead is already in the tree, twice. `readTerminalReport` is declared
on the implementation and not on the contract (`D-0056`), and `src/lap/root.ts` reaches it
**structurally** -- it declares the shape it needs and never imports the concrete class, which is
what `createDefaultSessionProvider`'s docstring calls out as load-bearing (`D-0059`). The wake takes
the same shape:

```ts
/** What the composition layer needs of a provider in order to attempt a wake. */
interface WakeCapableSessions {
  /** Best-effort, never rejects, returns nothing. */
  wakeSession(sessionId: string): Promise<void>;
}
```

Two properties of that signature are the design, not the typing:

- **It returns nothing and never rejects.** A wake has no outcome a caller may branch on. If it
  returned a boolean, some caller would eventually treat `false` as "the message was not delivered",
  which is the exact confusion between *hint* and *delivery* this whole shape exists to prevent.
- **`sessionId` names a pipe, not a recipient.** It says *which child to nudge*, and it is not an
  addressing decision about the message: the message's recipient is on the outbox row and is read
  from SQLite by the poll that follows. This is why the wake carries no recipient (section 5) even
  though it necessarily names a session.

**Absence of the capability is a supported configuration, not a degraded one.** A provider without
`wakeSession` -- the stub, a Codex backend, any future one -- runs cadence-only, and nothing else
changes.

### 4.3 The owner of "enqueue committed, then attempt wake"

The step belongs to the **enclosing composition layer**: the one file that is already allowed to know
both a session backend and the control plane.

- **End state: rondo.** `D-0087` settles that the host application is a third repository consuming
  continuo and cadenza as libraries, and that everything neither library owns -- the HTTP server, the
  web UI, the localhost MCP endpoint, the SQLite driver -- lives there. The component that both
  enqueues and holds a worker's pipe is a host concern by that division, and naming rondo is what
  keeps it from being smuggled into a library that would then need an import ban relaxed.
- **Lap 1: `src/lap/`, by injection.** `D-0059` already makes the lap the composition root, and its
  existing shape is provider-agnostic-by-parameter -- `root.ts` takes the provider and the report
  reader as arguments and imports only `../session/provider.js`. A lap-local wake follows that shape
  exactly: `root.ts` takes a `WakeCapableSessions | undefined` and never names the concrete class.

**`src/lap/` is not the universal owner** and should not be presented as one. It is where lap 1's
instance is composed because lap 1 is the only thing that runs today.

### 4.4 The co-location requirement, which is not hypothetical

**A process that does not hold the pipe cannot write it.** A separate CLI process calling
`MessageBus.send` has no way to wake anything: there is no shared handle, and no IPC bridge exists.
So option B has a precondition -- enqueue and the worker's stdin must be in the same process -- and
that precondition is **not met by today's code**:

- The only producer under `src/` is `enqueueRelay`
  ([`src/control_plane/gates.ts`](../../src/control_plane/gates.ts)), called from
  [`src/gate/operator.ts`](../../src/gate/operator.ts) -- that is, from the `continuo gate` verbs,
  which run as their own process, after the lap, on an operator's command.
- The lap process is the one that holds the child. It does not enqueue anything.
- And both of a gate's relays address `external-notify` (`D-0076`), not a worker; `D-0064` records
  that lap 1 does not deliver through the endpoint at all.

So **there is no message addressed to a worker in this codebase today, and therefore no wake site to
attach to.** That is the strongest single reason this document files no implementation: the wake's
producer is future work (`D-0077` defers the privileged publisher to lap 2), and building the wake
before its producer would fix a mechanism against a caller nobody has written.

It also settles a sub-question that would otherwise look open: **the `continuo gate` verbs are not
where the wake goes.** They are the wrong process by construction, and giving them one would require
the IPC bridge this design does not propose.

---

## 5. What a wake is: seven things it does not carry

A wake is an **empty, coalescible hint**. Coalescible means two wakes are indistinguishable from one:
there is no state a second wake adds, so a writer may drop, merge, or rate-limit them freely, and a
reader can never tell.

| not carried | why it must not be |
|---|---|
| a payload | a payload would make the wake a second delivery path beside the outbox row |
| a message id | an id invites the recipient to poll *for that message*, which is a delivery decision taken outside SQLite |
| a recipient | recipient authority is fixed independently (`D-0074`); see section 6 |
| an epoch | the same, and see section 6 on why a wake must not touch the fence |
| a due count | a count is a readout of `Outbox.due` taken at the sender and read at the recipient -- a delivery decision made from a snapshot instead of from the database |
| an acknowledgement | an ack of a hint is a second settlement beside the message ack, and only the recipient's ack settles anything |
| a delivery guarantee | it is best-effort by definition; section 7 is what makes that safe |

The positive statement is one sentence: **a wake says "a poll may be useful now", and nothing else.**
Everything the recipient then does, it does by reading SQLite.

### 5.1 "Empty" is a statement about authority, not about bytes -- and the frame is unmeasured

Everything above is about what a wake may *mean*. At the wire it is still a `stream-json` user
message, and that message has to contain something, so the two senses of "empty" must not be
conflated:

- **Empty of authority** -- the table above. No message id, recipient, epoch, count or ack, and no
  content a delivery decision could be read out of. This is the design.
- **Empty of bytes** -- not required, and possibly not even accepted. The measurement sent a
  *non-empty* message ("The word is PELICAN ...") and observed the assistant act on it. Whether a
  zero-length or whitespace-only `stream-json` user message is surfaced at all, rather than rejected
  or silently dropped, **was not measured**.

So the frame is a fixed constant this design owes and does not yet have: one literal string,
identical for every wake, saying only that polling may be useful now. That is what makes wakes
coalescible -- two identical frames are indistinguishable by construction -- and it keeps the
authority table true, because a constant carries no per-message information. But **it must be
chosen and then measured**: an implementation that writes an empty frame the executor ignores would
conform to every rule in this section and never prompt a single poll. Naming the frame and
observing a worker poll in response to it is the smallest experiment that would make D1's mechanism
real rather than argued, and it is D6 in section 12.

**A wake is not publisher functionality.** `D-0077` defers the privileged publisher, and lap 1's
operator is the publisher. A wake grants no ability to enqueue, publish, approve, or act on a
payload; being wakeable is not a permission, and a component that can wake a worker gains nothing it
could not do before.

---

## 6. The six standing decisions a wake must not touch

Each of these is already accepted, and each has a way the wake could quietly break it.

**`D-0060` -- the turn is over when the terminal report exists, not when the child exits.** A wake
racing the terminal report must be allowed to fail harmlessly. It must never defer ingestion, delay
teardown, or extend the turn to let a late hint land. Concretely: after the report is read, a pending
or failed write is discarded and changes nothing about the result. A wake that could hold a turn open
would make the turn's end depend on a best-effort side channel.

**`D-0073` -- the delivery lease latches and never re-acquires.** A wake never renews, re-acquires or
touches the endpoint lease. `renew` refuses an expired lease precisely so a returning holder must
re-acquire, and re-acquiring raises the epoch -- which the running worker's `mcp.json` can never be
told about. A wake is not evidence of anything about the lease and must not be on any path that
renews it.

**`D-0074` -- the endpoint's three lease values are determinate.** Holder, epoch and recipient are
fixed at materialisation and rendered into the child's environment. A wake carries none of them and
grants no authority over them. In particular the `sessionId` in `wakeSession` is not a recipient
(section 4.2).

**`D-0075` -- the lease row is not liveness evidence.** It records that the lap held the lease the
endpoint would use, and nothing more. Symmetrically: **a successful wake write is not evidence the
worker is alive, and a failed one is not evidence it is dead.** A write to a pipe succeeds into a
buffer. Nothing in the control plane may read a wake result as a liveness fact, which is the same
mistake in a new place that `D-0075` was written to refuse.

**`D-0072` -- the process hierarchy is lap -> worker -> endpoint grandchild.** There are two stdins
and they are different objects. See section 9.

**`D-0077` -- the publisher is deferred.** See section 5.

**And the one this document keeps by construction:** enqueue is never rolled back, retried, or
reclassified because a wake failed, and no session readout precedes an enqueue. The order is
*commit, then hint*, never *check, then commit*. A wake attempted before the commit could wake a
worker into polling a row that is not yet visible -- harmless, since the poll finds nothing, but it
inverts the only ordering rule this design has, and an inverted rule is one refactor away from being
a lost message.

---

## 7. The fallback cadence, which is mandatory, and which existing number it is not

**A wake advances the next poll. It never replaces the poll that would have happened anyway.**

Four cases leave a due row undiscovered if the cadence is dropped, and none of them is exotic:

1. **A dropped or coalesced wake** -- a full pipe buffer, a write that loses the race with teardown.
2. **A closed pipe** -- the child was spawned without one, or it was closed.
3. **Codex**, which has no post-start input path at all.
4. **A turn with no tool-call boundary** -- the first unmeasured case in section 1. The measurement
   anchors every observation to a `tool_result`; a turn that generates prose and calls nothing has no
   observed boundary at which the hint becomes visible.

Without a cadence, wake availability becomes a **liveness dependency**, which is exactly what option
B promised not to create.

### 7.1 The layers, and which of them is load-bearing

| layer | what it bounds | executor | covers |
|---|---|---|---|
| 0. wake on enqueue | latency, to the next tool boundary | Claude only | the common case |
| 1. repeat the hint on a timer while a turn is in flight | latency, to the cadence | Claude only | case 1 |
| 2. the recipient polls at each turn boundary | latency, to the turn | any | cases 2, 3, 4 |
| 3. rows stay due in SQLite and stay visible | **correctness** | any | everything |

**Layer 3 is the only load-bearing one**, and it exists today: an idle worker that never polls simply
leaves its rows due, visible to any operator via the outbox tables. Layers 0 to 2 buy latency.
Nothing above layer 3 may be relied on for correctness, and that is precisely why a wake is allowed
to be lossy.

### 7.2 The number, and why it is a new one

**Recommended: 30 seconds as the maximum interval between hint writes while a turn is in flight**, as
a named constant owned by the composition layer that owns the wake.

**It is a hint-write cadence and nothing more.** It is deliberately *not* stated as a maximum
between message polls, because no mechanism in this design can promise that: what the hint buys is
worked out in 7.3 and carries a second term -- the time to the next tool-call boundary -- that this
design cannot bound. Every sentence about the number has to survive that, so the two bounds below
are bounds on *writing*, not on discovery.

The reasoning is arithmetic, and both bounds are checkable:

- **Not shorter**, because each hint that is actually observed costs the worker a poll, and a poll
  is a tool call inside its turn: it costs a boundary and context, and it competes with the work.
  The measured boundary spacing in the harness was about 20 seconds, so a cadence below that would
  put a hint between essentially every boundary.
- **Not longer**, because the lap's default turn timeout is fifteen minutes
  (`DEFAULT_TURN_TIMEOUT_MS`, `src/lap/cli.ts`). At 30 seconds a turn of default length carries at
  most thirty hints, which is a cost worth paying; at, say, five minutes the mechanism would write
  three hints in a whole turn and buy almost nothing over layer 2's turn-boundary poll.

**It is not `--poll-interval-ms`.** That is 1000 ms and it controls the lap's *transcript reads* --
the composition root stat-ing a file it owns, in its own process, costing nothing but a syscall
(`src/lap/cli.ts`, `src/lap/root.ts`). A message poll is a different resource in a different process
paid for in tool calls. Reusing the number silently would tie two cadences that have no reason to
move together.

**It is not `D-0079`'s cadence either.** That one is the operator's, for gate reconciliation, over a
different verb, at human scale. `D-0079` deliberately makes the operator own it; a message-poll
maximum inside a turn is not an operator's business and should not be spelled in the same place.

### 7.3 The part this design cannot enforce today, stated plainly

**continuo does not issue the message poll. The worker does**, as an MCP tool call. So a cadence is a
number continuo can *choose* and cannot, today, *compel* -- which is the issue's consequence 1
restated at its sharpest. Three mechanisms could compel it, and they are not equivalent:

- **The role prompt.** Executor-independent, and it is the discipline the issue already names as the
  thing an agent recipient is least reliable at. Sufficient for layer 2's turn-boundary poll;
  insufficient as a cadence.
- **A Claude Code `Stop` hook exiting 2 while rows are due.** Turns polling from a discipline into a
  property of the process: a turn becomes unable to end with undelivered messages. Executor-specific
  in the same way the wake is, so it belongs beside it in the adapter, not in the domain. **It is a
  turn-boundary safeguard and not a cadence**: `Stop` fires when the assistant tries to end its
  response, so it enforces layer 2 and cannot enforce layer 1's 30 seconds.
- **The completion condition.** A run does not reach done unless the ack exists, so a recipient that
  never polls never finishes rather than silently missing work. This is the ack-gated shape
  `minimal-operating-loop.md` already argues is "stronger than a polling watcher"; it bounds
  correctness, never latency.

**The only actually periodic mechanism is layer 1**, and it is the composition layer's own timer --
the process holds the pipe, so writing a hint every 30 seconds needs nobody's cooperation. What the
timer bounds is **when a hint is written**, and nothing more: the hint still becomes visible only at
the next tool-call boundary. So 30 seconds is the **hint-write cadence**, and the discovery latency
it actually buys is

> at most 30 seconds **plus** the time to the next tool-call boundary,

which collapses to 30 seconds only for a turn whose boundaries are closer together than that. A turn
containing a tool call longer than 30 seconds reaches boundaries and still misses the number, by the
length of that call; a boundary-free turn has no second term at all and degrades to the turn. **No
mechanism in this design bounds the second term**, because it is a property of the work the worker
chose to do. That is survivable for exactly one reason: layer 3 keeps the rows due, and nothing above
it is load-bearing for correctness.

**Recommendation: layer 1 by the composition layer's timer, layer 2 by the completion condition,
and the `Stop` hook as the executor-specific way to make layer 2 a property of the process rather
than a discipline.** Recorded here rather than decided, because it reaches into the role documents
and the fence, and D5 in section 12 is where the gate takes it.

---

## 8. Replay-safe, not idempotent

Duplicate and coalesced wakes cause duplicate polls, so the property the design needs from repeated
polling has to be stated correctly, and the obvious word is wrong.

`MessageBus.poll` is **not** idempotent in state or in response. Each poll re-runs `Outbox.attempt`
for every due message, which marks the row delivered, applies or recognises the effect, and
re-presents the payload; attempt and retry information moves. What is true is narrower and is what
matters:

- **The destination effect is deduplicated.** An attempt applies the effect or recognises it as
  already applied.
- **The ack is idempotent and unfenced.** However many times a worker repeats it, exactly one ack is
  recorded.
- **Presentation is explicitly at-least-once, all the way to the wire.** An ack landing concurrently
  with a poll already carrying the same message can put one more presentation of a just-settled
  message in front of the worker; that race has no server-side fix, which is why every envelope
  carries the sender's `dedupKey` and the recipient deduplicates.

So the invariant to write down is **replay-safe polling**: an extra poll caused by an extra wake
creates no second destination effect and no second settlement, while duplicate *envelopes* remain
possible and are handled exactly as the resend path already handles them. Calling it idempotent would
promise a property the code does not have, and would make a future reader who checks it think the
bus is broken.

---

## 9. Two stdins, and why multiplexing is not an option

`D-0072` fixes the hierarchy: **lap -> worker -> endpoint grandchild**. Each of the two edges has a
stdin and they are unrelated.

| | the worker's stdin | the endpoint's stdin |
|---|---|---|
| edge | lap -> worker | worker -> endpoint |
| carries | Claude Code `stream-json` user messages | line-delimited MCP JSON-RPC |
| held by | the lap process (today: `stdin: "ignore"`) | the worker, as MCP client |
| what the wake uses | **this one** | never |

**Writing a wake onto the endpoint's stdin would corrupt its protocol.** That pipe is a JSON-RPC
transport with a strict framing; an extra line is not an ignorable nudge but a malformed message on a
channel that carries the actual `poll` and `ack` calls. The wake is on the first edge; message
polling remains the worker's MCP call over the second. They never meet.

### 9.1 What enabling the pipe costs at the provider, which is more than one flag

Today the child is spawned with `stdin: "ignore"`
([`src/session/claude_cli_provider.ts`](../../src/session/claude_cli_provider.ts)). Three consequences
follow from changing that, and the third is the expensive one.

1. **The child gains a stdin that never reaches EOF.** A child waiting on EOF to finish would not.
   `D-0060` limits the blast radius -- the turn is over when the terminal report exists, not when the
   child exits -- but the teardown path has to close the pipe deliberately rather than rely on the
   process ending.
2. **`--input-format stream-json` has to be rendered**, and it belongs on `PROVIDER_OWNED_FLAGS`
   beside `--output-format` for the same reason: an operator `cli_args` carrying it would be appended
   after the provider's own and could change how the child reads its input.
3. **The prompt moves out of argv, and argv is where the only copy of it lives.** The measured
   configuration passes no positional prompt: message 1 *is* the prompt, written to stdin. Today the
   start argv is `claude -p <prompt> --output-format stream-json --verbose --session-id <uuid> ...`,
   and the provider's own comment says what that costs to change: *"The **start** prompt is not
   persisted anywhere else: only `resume_prompt` is a record field, so the prompt survives solely
   inside this argv."* Moving it onto stdin therefore deletes the only durable record of what a
   worker was asked to do, and it changes the shape of the argv that the fence's evidence records.

Consequence 3 is a genuine cost of option B and is not a detail of the wake. The honest fix is to
make the start prompt a record field the way `resume_prompt` already is, so the durable copy survives
the move; that is D4 in section 12, and it is the one item here that is larger than the wake itself.

**A cheaper variant worth the gate's attention:** if `--input-format stream-json` can be rendered
*while still passing the prompt in argv*, consequence 3 disappears entirely and only 1 and 2 remain.
The measurement does not answer that -- it did not try -- and this document does not assume it. It is
the first thing an implementer should measure.

---

## 10. What changes in the tree today

**Two comments, and nothing else.** They are corrected to remove the false implication without
reversing the transport description -- the transport really is worker-outbound, and the corrected text
has to keep saying so, for the reasons in section 2 rather than the one measurement removed.

- [`src/messagebus/index.ts`](../../src/messagebus/index.ts) -- the F1 citation in the module
  docstring.
- [`src/messagebus/endpoint.ts`](../../src/messagebus/endpoint.ts) -- the "Why worker-outbound"
  paragraph.

Each now says that Claude Code has a **measured, executor-specific** stdin wake opportunity, that
pull remains the settlement because a wake carries no payload authority, and that the grounds for
worker-outbound are the ones in section 2. The `bus.ts` SQLite-only statement is **not weakened**: it
is correct, it is what option B preserves by construction, and editing it would be the one change
this design must never make.

**What does not change:** no behaviour, no test, no export, no schema, and no import edge. The
import-graph test is untouched and stays exactly as strict, because option B is the option that does
not need it relaxed.

---

## 11. Draft entry

Proposed, not written to [`DECISIONS.md`](../../DECISIONS.md).

**On the number.** The shared control-plane band (`D-0019`..`D-0099`) is free from `D-0089` at
`13c7b1a`, and a parallel change is minting `D-0089` for the fencing layer -- so this is drafted as
**`D-0090`** and the number is confirmed against `DECISIONS.md` at the moment the entry is actually
written. The band is the shared one rather than messagebus's `D-05xx` because the decision binds four
belts at once: messagebus, session, lap and the host. Precedent for the number moving: this
document's neighbour drafted `D-0087` and landed as `D-0088`.

---

### D-0090 (draft) -- A wake is an empty hint over the Claude worker's stdin; pull over SQLite stays the settlement

**Context.** `src/messagebus/index.ts` and `src/messagebus/endpoint.ts` each derive worker-outbound
delivery from interlock's F1: *there is no non-interactive way to push a message into a running
worker session*. A measurement taken at the human gate's request on 2026-09-05 shows that clause is
false for the executor this stack targets. At `claude 2.1.261`, under
`-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`, a
second user message written to stdin 8 s into a turn was replayed on stdout immediately after the
running tool call's `tool_result` (t=26 s), acknowledged by the assistant at t=28 s, and the turn ran
on to its own end at t=74 s. Two runs, identical in shape, no error or rejection event. So a message
can be delivered into a running turn, at the granularity of a tool-call boundary. **For a message
written while a tool call is in flight** -- which is the only case measured -- discovery is therefore
bounded by the remainder of that call rather than by the turn. Every other arrival time is
unmeasured, including one that is easy to read into the table and is not there: a message written
during a long prose interval *between* two tool calls, whose delay is a property of the generation
rather than of any tool call. See what is unmeasured, below.

**Decision. Pull over SQLite remains the settlement and the only source of delivery decisions. A
wake is added as an empty, best-effort, coalescible hint whose only effect is to advance the next
poll.** Specifically:

1. **What is due, what resends, what is settled** is read from SQLite alone. A wake is not an input to
   any of those decisions, and `src/messagebus/bus.ts`'s SQLite-only statement is unweakened.
2. **A wake carries nothing** -- no payload, message id, recipient, epoch, due count, or
   acknowledgement -- and grants no authority. Two wakes are indistinguishable from one.
3. **The mechanism is the Claude session provider's.** The stdin pipe, its framing and its write live
   in `ClaudeCliSessionProvider` and are exposed to composition as a narrow structural capability, on
   the precedent of `readTerminalReport` (`D-0056`, `D-0059`). **S1 keeps its five verbs**
   (interlock `D-0009`): a wake is not a sixth, and a provider without the capability runs
   cadence-only.
4. **"Enqueue committed, then attempt wake" is the composition layer's**, which is rondo in the end
   state (`D-0087`) and `src/lap/` by injection for lap 1. Enqueue and the worker's pipe must be
   co-located: a separate CLI process calling `MessageBus.send` cannot write a pipe it does not hold.
   Enqueue success is never rolled back or reclassified by wake failure, and no session readout
   precedes an enqueue.
5. **A bounded fallback message-poll cadence remains mandatory**, because a dropped wake, a closed
   pipe, Codex and a boundary-free turn each leave a due row undiscovered otherwise. The cadence is a
   new number, not `--poll-interval-ms` (transcript reads) and not `D-0079`'s operator cadence (gate
   reconciliation).
6. **Repeated polling is replay-safe, not idempotent.** Presentation is at-least-once and duplicate
   envelopes are deduplicated by the sender's `dedupKey`; an extra poll creates no second destination
   effect and no second settlement.
7. **A wake never extends the turn (`D-0060`), never renews or re-acquires the endpoint lease
   (`D-0073`), carries no epoch or recipient authority (`D-0074`), is not liveness evidence
   (`D-0075`), and is not publisher functionality (`D-0077`).** It travels the worker's stdin, never
   the endpoint's, which carries MCP JSON-RPC (`D-0072`).

**Alternatives.**

- **A: keep pull and drop the stale justification, specifying a cadence** (continuo#97's option A).
  Rejected as insufficient rather than wrong: it is a strict subset of this entry, and it leaves the
  measured sub-turn latency unused for the messages that need it.
- **C: re-derive from scratch and restate or relax the import ban** (option C). Rejected because
  nothing in the measurement argues for it. The capability is one executor's, the SQLite-only property
  is what makes a wrong liveness reading unable to alter delivery, and relaxing item 6's static
  assertion would trade a structural guarantee for a latency improvement that option B already buys.
- **A sixth `SessionProvider` verb.** Rejected: it reopens a provisional contract (interlock `D-0021`) for a
  Claude-only facility, misrepresents Codex as having it, and makes gate items 6 and 11 unmeasurable
  -- which is what `DELIVERY_ABSENCE_IS_DELIBERATE` already says.
- **A wake carrying the message id or the due count.** Rejected: either makes a delivery decision
  outside SQLite, which is the property this entry exists to keep.

**Consequences.**

1. **The import ban is untouched and stays as strict.** `test/messagebus/import-graph.test.ts` needs
   no change, which is the concrete difference between this option and option C.
2. **Two module comments stop asserting a capability claim** and state the measured position instead.
3. **The provider's spawn gains a stdin**, so `stdin: "ignore"` becomes a held pipe,
   `--input-format stream-json` joins `PROVIDER_OWNED_FLAGS`, and -- in the measured configuration --
   the prompt moves from argv onto stdin, where today argv holds the *only* durable copy of a start
   prompt. That last one is a record-shape change larger than the wake and is not yet designed.
4. **The wake has no producer today.** The only enqueue site in `src/` is `enqueueRelay`, called from
   the `continuo gate` verbs in their own process, addressing `external-notify` (`D-0076`); lap 1 does
   not deliver through the endpoint (`D-0064`) and the privileged publisher is deferred (`D-0077`).
   So this entry settles a shape, and the first code that needs it is lap 2's.
5. **continuo chooses the cadence but cannot compel it**, because the poll is a tool call the worker
   issues. Compulsion is available as a role-prompt discipline, an executor hook, or an ack-gated
   completion condition, and choosing among those is not settled here.

**Status.** proposed -- drafted in `docs/design/messagebus-wake-hint.md`, awaiting the human gate.

**Source.** continuo#97; the human gate's choice of option B, 2026-09-05; the measurement recorded as
a comment on that issue the same day; a pre-delegation Codex design review of option B (1 Blocker
pair, 5 Major, 2 Minor).

**What is unmeasured**, and must be read as part of the decision rather than as a caveat to it:

- **Pure text generation with no tool-call boundary.** Every observation is anchored to a
  `tool_result`; a turn that calls nothing has no measured boundary.
- **A single very long tool call**, including whether the signal is visible only after its
  `tool_result` and how long that may be.
- **A message written between two tool calls**, during prose generation rather than during a call in
  flight. The measurement wrote into a running `sleep`; nothing establishes when a message arriving
  in the gap is surfaced, and its delay would be a property of the generation, not of a tool call.
- **The wake frame itself.** The measured message carried a word the assistant acted on. Whether the
  fixed, information-free frame this entry calls a wake is surfaced -- rather than rejected, ignored,
  or dropped for being empty -- is unmeasured, and an implementation could satisfy every rule here
  and prompt no poll at all. Naming the frame and observing a poll in response is the experiment
  this entry's mechanism still owes.
- **Every other executor.** `codex exec 0.147.0` has no `--input-format` and no streaming-input
  option; its stdin is the initial prompt only. F1 still holds there.

**Falsifier (the measured fact).** A supported `claude` version at which a message written to a
running `-p --input-format stream-json` session's stdin is *not* surfaced at the next tool-call
boundary -- deferred to the end of the turn, rejected, or dropped. The fact is dated and versioned
(`2.1.261`, 2026-09-05) precisely so that this can be checked rather than assumed; a newer version is
a re-measurement, not an inference.

**Falsifier (the settlement).** Any of the following would falsify or supersede the decision built on
that fact, and they are independent of it:

- A wake is observed to change which SQLite rows are due, their ordering, their settlement, their ack,
  or recipient authority.
- Correct liveness turns out to require reliable or authoritative push rather than fallback polling --
  that is, a case where a lost wake loses work rather than delaying it.
- A required deployment puts enqueue and the worker's pipe in separate processes with no IPC bridge,
  making the co-location requirement unsatisfiable rather than merely unmet.
- The fallback cadence is shown to be unenforceable by any of the three mechanisms named above, which
  would make wake availability a liveness dependency after all.

---

## 12. What the gate is asked to decide

Six items, each overturnable without disturbing the others. D6 is the only one that gates *building*
rather than deciding: nothing else here depends on its answer, and the mechanism does.

| | question | recommendation | if overturned |
|---|---|---|---|
| **D1** | Is the draft entry above the settlement of continuo#97? | accept as `D-0090` | the two comment corrections still stand; they are true under A as well as B |
| **D2** | Structural capability on `ClaudeCliSessionProvider`, or a sixth S1 verb? | structural, per `D-0056`/`D-0059` | a sixth verb reopens interlock `D-0021` and needs `provider-contract.test.ts` changed, which is a separate decision |
| **D3** | Is 30 seconds the hint-write cadence? | yes, with the arithmetic in 7.2 and the latency it actually buys in 7.3 | any other number, provided it is *a* number and is neither `--poll-interval-ms` nor `D-0079`'s |
| **D4** | Does the start prompt become a record field before the pipe is enabled? | yes -- 9.1 consequence 3 deletes the only durable copy otherwise | measure whether `--input-format stream-json` can coexist with an argv prompt first; if it can, D4 is moot |
| **D5** | Which mechanism compels the fallback poll? | the composition layer's timer for layer 1, the completion condition for layer 2, a `Stop` hook to make layer 2 a process property | the role prompt alone is available and is weaker; the entry does not depend on the answer |
| **D6** | Is the wake frame named and measured before the mechanism is built? | yes -- 5.1; an unmeasured frame could conform to every rule and prompt no poll | build first and measure after, which risks a wake nobody can observe failing |

---

## 13. What this document deliberately does not do

- **It writes no code and no test.** Section 10's two comments are the whole diff. The mechanism has
  no producer to attach to (4.4), and building it now would fix a shape against a caller nobody has
  written.
- **It does not design the publisher.** `D-0077` defers it, and a wake is not it (section 5).
- **It does not decide how the worker is compelled to poll.** It names the three mechanisms, ranks
  them, and leaves D5 to the gate, because the answer reaches into the role documents and the fence.
- **It measures nothing itself.** The four unmeasured cases -- a boundary-free turn, a very long tool
  call, a message arriving between two tool calls, and the wake frame -- are named in the entry as
  unmeasured and stay that way. A document that inferred any of them from the shape of the measured
  runs would be doing what section 1 of continuo#97 objected to: reading a capability out of a
  document instead of an observation.
- **It does not touch cadenza or rondo.** `D-0087` names rondo the end-state owner; nothing here
  binds a repository that does not yet exist.
