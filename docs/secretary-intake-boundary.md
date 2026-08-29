# The Secretary intake boundary

*The written half of the item 8 rehearsal. The code half is `src/secretary/`; the durable half is
`test/secretary/`.*

Ported alongside interlock's `docs/secretary-intake-boundary.md` reference at `65f36c5`, and named
by `src/secretary/index.ts` so that later work -- a Secretary web interface, a real inbox --
inherits this boundary instead of re-deciding it.

---

## What item 8 asks for, and what this is

interlock's `ACCEPTANCE.md` section 1, item 8: *no Secretary response path can be blocked behind
worker monitoring, long-running work, or an AI judgement.* The ask has two halves. The
**structural** half is that intake and the queue boundary cannot wait on a consumer -- a property of
the code, showable on the syntax tree. The **empirical** half is a baseline-versus-load latency
comparison against a threshold.

**This is the structural half of a rehearsal, and it is not the discharge.** interlock D-0022 defers
item 8 to its own discharge point: the same absence of blocking, shown against the *real* Secretary
under *genuine* worker load, before the canary starts, against a threshold interlock filed as
`Q-0011` and never settled.

**`Q-0011` was left unanswered in interlock, and nothing here invents an answer to it.** interlock is
frozen (`D-0036`), so no threshold is in transit from it; the question is worth keeping because it
records what would have to be agreed, and continuo's human gate is now the only place that agreement
can happen. No numeric latency threshold appears in `src/secretary/`, in `test/secretary/`, or in
this document. A rehearsal that quietly supplied a number nobody has agreed would be worse than no
rehearsal, because the number would then arrive as settled. Supplying one deliberately is a decision
to take to the gate -- not something to wait for.

## The contract

Four names, and they are the whole surface (`src/secretary/index.ts`):

| name | side | what it promises |
|---|---|---|
| `SecretaryIntake` | producer | `submit(payload)` returns an `IntakeReceipt`, synchronously, always |
| `IntakeQueue` | boundary | bounded, one-way, FIFO; `offer` never waits, `takeBatch` never waits |
| `IntakeReceipt` | producer | the response: accepted, or refused with the depth the decision saw |
| `IntakeRefused` | producer | the recorded refusal, retrievable from `refusals()` |

The three rules the surface exists to hold, each asserted in `test/secretary/structural.test.ts`:

1. **The intake path performs no blocking call.** `submit()` stamps a receipt, offers the request to
   the queue without waiting, and returns it. It never joins a thread, waits on an event, reads a
   pipe, sleeps, or calls into any consumer.

2. **There is no suspension point on the response path.** `submit()` is synchronous and
   run-to-completion: it declares a return type of `IntakeReceipt`, and the package contains no
   `async` function, no `await`, and no Promise or cross-thread synchronisation object anywhere
   (D-0701). This is the port of the source's "no lock at all" rule. The source's subject is the
   wait a ban on *called names* cannot see -- in Python, `with lock:`, which acquires implicitly.
   Node has no lock to take, so the sentence does not port; the subject does, and in this runtime it
   is `await`, whose resumption is at the mercy of whatever else holds the loop.

3. **The package depends on no other continuo module.** There is no dependency edge to a supervisor,
   a dispatcher, or the control plane. Worker monitoring and AI judgement cannot block a code path
   that cannot reach them.

## Backpressure is a refusal, not a wait

When the bounded queue is full, the request is refused, and the refusal is recorded twice -- on the
receipt (`status === "refused_queue_full"`, with the depth the decision observed) and in the refusal
log. **The intake still answers immediately.**

Whether a refusal, and at what depth, is *acceptable* is a Secretary-design question outside this
rehearsal. What the rehearsal fixes is only that the alternative to acceptance is an immediate
recorded refusal, never a block.

## What the port changed, and why

The source's boundary is lock-free over a CPython `deque`, and it pays a stated price: the capacity
check is exact under one producer and **approximate within the number of concurrent producers**,
because a check-then-append race can overshoot `capacity` by at most `P - 1`. That race is a fact
about threads sharing an interpreter.

Continuo's `submit()` is synchronous and run-to-completion, so no second producer can be part-way
through one, and **the capacity bound is exact**. The source's tolerance for an overshoot is not
carried: a ported case that tolerated an overshoot which cannot happen would stay green over an
implementation that had started dropping or duplicating requests. The concurrent-producer case is
therefore recorded as `adapted` and re-pointed at the property that does hold here -- submit
asynchronously from eight interleaved producers and the accepted count is *exactly* the capacity,
with nothing lost and nothing duplicated. Decided in D-0701.

## How the stall is proved

The three behavioural cases each stall one of the three dependencies item 8 names. **The stall is
proved by state order, never by a clock.** A consumer takes its item, publishes the stage it
reached, and parks on a Promise the test holds the only resolver for; every submit is then made and
every receipt collected, and the case asserts the stall was still unreleased and the consumer still
incomplete. The case whose subject is a genuinely blocked *thread* keeps one: a `worker_threads`
worker parked in `Atomics.wait` on a flag the test is the only writer of.

The runner's timeouts bound how long a *failing* run hangs. They are not acceptance numbers, and
nothing in this belt reads one as such.

## Throwaway by default

State is in-memory on purpose (interlock D-0026). Durable intake -- a SQLite-backed inbox -- is the
real Secretary's concern and is not rehearsed here. Promotion of any of this into the real Secretary
takes a new `D-` entry.
