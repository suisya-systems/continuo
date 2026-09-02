import { randomUUID } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { isConstraintError } from "../sqlite/errors.js";
import type { DeliveryReceipt } from "./destination.js";
import {
  and_,
  eq,
  type FencedStatement,
  fencedInsert,
  fencedUpdate,
  fenceEpoch,
  increment,
  isNull,
  type Lease,
  ne,
  param,
  readLease,
  StaleWriterRefused,
  value,
  withImmediate,
} from "./lease.js";
import { pythonRepr, pythonTuple } from "./python_repr.js";

/**
 * S7 -- the outbox: resend, ack, dedup, and handlers that name their
 * mechanism.
 *
 * **On the production schema, at migration head.** This module was written
 * against the S5 spike schema and marked throwaway by default (D-0026),
 * because `Q-0001` -- the real DDL, its keys, indices and the per-item
 * single-writer table -- was open at the time and nothing here answered it.
 * D-0029 answered it (`docs/production-schema.md` section 4.2,
 * `migrations/0001_initial.sql`), and the module has since been re-pointed
 * onto that schema: the DDL below it is the migrated production one, and the
 * constraints it obeys are that schema's constraints rather than the spike
 * table's. `spike_schema.sql` and `schema.ts`'s reconstruction queries stay
 * as they are -- faithful spike artifacts, and no longer what this module
 * runs on.
 *
 * The visible consequence is a fourth status. Migration
 * `0003_outbox_cancelled_status.sql` added `'cancelled'` to the `CHECK` and
 * to the forward-only trigger's lattice, as `docs/production-schema.md`
 * section 5.7 sets out: it is what a gate closure writes onto a relay
 * nobody is waiting for any more, and it is **terminal**, like `'acked'` and
 * for an entirely different reason. Every place this module used to decide
 * "finished" by asking whether a row was acked now asks
 * {@link isTerminalOutboxStatus} instead. The durable half of Issue `#14`
 * remains the test suite.
 *
 * What this module is responsible for, in the words of `ACCEPTANCE.md`
 * section 2's outbox rows:
 *
 * - **Resend.** *Every enqueued message is eventually delivered at least
 *   once; nothing is lost by a kill at any of those points; retry count is
 *   durable across restarts.*
 * - **Ack.** *Ack is idempotent. A lost ack causes a resend (safe), never a
 *   lost message. A duplicate or late ack changes nothing.*
 * - **Dedup.** *Duplicate delivery causes exactly one effect.*
 *
 * and the declaration that runs underneath all three:
 *
 * - **Every action handler names its exactly-once mechanism**, because
 *   SQLite cannot tell "the side effect completed" from "the side effect
 *   never started".
 *
 * Four things here are load-bearing rather than stylistic.
 *
 * **At-least-once delivery, exactly-once effect.** These are different
 * guarantees carried by different records and it is worth being blunt about
 * which is which. The outbox delivers *at least once*: a lost ack is
 * answered by a resend, and a resend is not a failure. Exactly-once is a
 * property of the **effect**, evidenced by `action.idempotency_key` on our
 * side and by the destination's own ledger on the other side
 * ({@link "./destination.js"}). This is also why S5 left `outbox.dedup_key`
 * deliberately non-unique: a sender killed after writing an outbox row may
 * legitimately re-enqueue, and collapsing those rows in DDL would have moved
 * delivery policy into the schema.
 *
 * **Every write is fenced, and every refusal is recorded.** `ACCEPTANCE.md`
 * section 2 requires a stale writer to be *rejected, not merged*, and
 * requires the rejection to be **itself durable** -- "not silently dropped".
 * So each protected statement carries the lease epoch and validates it
 * atomically inside the write, in the single-statement form
 * `spike_schema.sql` documents on the `lease` table; and a write that matches
 * no row is not an early return but an `action` row in status `'refused'`
 * carrying its reason.
 *
 * **S6 owns the lease; S7 only validates it.** Acquisition, renewal and
 * expiry policy are Issue `#13`'s (S6), which is a sibling of this issue
 * rather than a dependency of it -- I-09 depends on I-07 alone. This module
 * therefore never acquires or renews anything. It takes the resource and
 * holder it writes under as constructor arguments and validates the epoch
 * inside its own writes, which is the coupling S5's DDL comment already
 * specifies. Naming the resource is the caller's job precisely because
 * *which component may hold which resource* was the per-item writer
 * assignment `Q-0001` left open (`docs/production-schema.md` section 4.2
 * answers it for the schema, and section 5's delivery rule names the single
 * writer of `outbox` as *the delivery worker holding the outbox lease*); a
 * default here would still be wrong, because the caller -- not this module
 * -- is who states its own identity as resource holder.
 *
 * **No retry interval appears in this file.** Not a backoff, not a
 * visibility timeout, not a re-notification window. `Q-0003` has to settle
 * tolerable detection latency first, and S5 kept every such number out of
 * the schema for the same reason. {@link Outbox.due} answers *what is
 * unfinished*; **when** to call it is the caller's, and the durable retry
 * count is what a policy would later be written against.
 */

// --------------------------------------------------------------------------
// the three mechanisms, mirrored from lease.ts (must not drift)
// --------------------------------------------------------------------------

/**
 * The three mechanisms `spike_schema.sql` enumerates on
 * `action.exactly_once_mechanism`, mirrored here so a handler can be
 * rejected at **registration** time rather than at its first INSERT. The
 * list is not this module's policy; it is `ACCEPTANCE.md` section 2's
 * clause, and the enumeration in the DDL and this constant are asserted
 * equal by the suite so they cannot drift.
 *
 * The source declares this same tuple **again** here rather than importing
 * `lease.py`'s copy -- both modules enumerate `ACCEPTANCE.md`'s clause
 * independently, and a ported case compares the two constants to each other
 * rather than one importing the other. This module's copy therefore has to
 * be kept in step with {@link "./lease.js".EXACTLY_ONCE_MECHANISMS} by hand,
 * exactly as the source keeps its two declarations in step by hand.
 */
export const EXACTLY_ONCE_MECHANISMS = Object.freeze([
  "destination_idempotency_key",
  "transactional_with_record",
  "human_gate",
] as const);

// --------------------------------------------------------------------------
// the status vocabulary and its terminal set, mirrored from the DDL
// --------------------------------------------------------------------------

/**
 * The closed status vocabulary, mirrored from `outbox`'s own `CHECK` as
 * migration `0003_outbox_cancelled_status.sql` restates it -- `CHECK (status
 * IN ('pending', 'delivered', 'acked', 'cancelled'))` -- and from
 * `docs/production-schema.md` section 5.7, which names `'cancelled'` as the
 * word a gate closure writes onto a relay nobody is waiting for any more.
 *
 * **This is a second, hand-kept declaration of the DDL's `CHECK`**, and it is
 * one deliberately: the same treatment `run_lifecycle.ts` gives `run`'s
 * vocabulary in {@link "./run_lifecycle.js".RUN_STATUSES}, and the same
 * treatment {@link EXACTLY_ONCE_MECHANISMS} above gives `ACCEPTANCE.md`'s
 * clause. A module that decides "is this row finished?" in TypeScript needs
 * the vocabulary as a *value* -- SQLite will not hand it over at compile
 * time -- and the alternative, re-deriving it by parsing the migration at
 * import time, would make a startup dependency out of a four-word list. The
 * obligation that comes with the duplication is the same one those two
 * carry: the suite asserts this tuple equals the enumeration the DDL
 * installs, so the two cannot drift.
 */
export const OUTBOX_STATUSES = Object.freeze([
  "pending",
  "delivered",
  "acked",
  "cancelled",
] as const);

/** One word of {@link OUTBOX_STATUSES}. */
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/**
 * The terminal set, in the strong sense `outbox_status_is_forward_only`
 * gives it: migration 0003's lattice is `pending -> delivered | cancelled`
 * and `delivered -> acked | cancelled`, and it gives **neither** `'acked'`
 * nor `'cancelled'` an outgoing edge. A row in one of these is finished, and
 * the trigger -- not this constant -- is what enforces that.
 *
 * The two are terminal for genuinely different reasons, and the difference
 * is why the messages below never collapse into one: an ack is *evidence the
 * work was done*, while a cancellation says *nobody wants it any more*. What
 * they share is the only thing the delivery path needs from them -- there is
 * no further attempt to make, so a delivery worker that keeps offering,
 * counting, adopting or reporting such a row is doing work against a
 * question that has already been answered.
 *
 * **This is the single place the module decides "finished".** Before 0003
 * the decision was spelled `status <> 'acked'` at six independent sites, and
 * adding a fourth status meant finding all six; the point of naming the set
 * once is that the next status is picked up by every site at once. The
 * fenced write predicates below are *generated* from this tuple for exactly
 * that reason -- see the note on {@link _COUNT_ATTEMPT}.
 */
export const TERMINAL_OUTBOX_STATUSES = Object.freeze(["acked", "cancelled"] as const);

/**
 * The module's one terminality decision, in function form.
 *
 * Takes a bare `string` rather than an {@link OutboxStatus} on purpose: its
 * callers read `status` off a row, and a database is free to hold a word
 * this build has never heard of (an older binary meeting a newer schema).
 * Narrowing at the call site would turn that into a cast; asking the
 * question of the raw word answers it honestly -- an unknown status is not
 * terminal, so the row keeps being offered rather than being silently
 * retired by a build that does not understand it.
 */
export function isTerminalOutboxStatus(status: string): boolean {
  return (TERMINAL_OUTBOX_STATUSES as readonly string[]).includes(status);
}

/**
 * Mechanisms that are part of the vocabulary but that **this** outbox cannot
 * provide, mapped to why.
 *
 * `'transactional_with_record'` requires the effect and its durable record
 * to commit together. {@link Outbox.attempt} commits the action row
 * *before* calling the handler -- deliberately, since that ordering is what
 * makes the effect recoverable -- and hands the handler no transaction to
 * enlist in. A handler declaring the mechanism would therefore be admitted
 * while the path it runs on could not possibly deliver it, which is the
 * undeclared-guarantee failure the registration check exists to prevent,
 * arriving through the one branch that looks declared. The mechanism stays
 * in the vocabulary because it is `ACCEPTANCE.md`'s and the DDL's; what is
 * refused is *claiming it here*.
 */
export const UNSUPPORTED_MECHANISMS: Readonly<Record<string, string>> = Object.freeze({
  transactional_with_record:
    "Outbox.attempt commits the action row before calling the handler and offers it no " +
    "transaction to commit an effect inside, so this outbox cannot provide the mechanism a " +
    "handler declaring it would be claiming. Use 'destination_idempotency_key' where the " +
    "destination supports one, or 'human_gate' where neither is achievable (D-0004)",
});

/**
 * Named points at which a delivery can be killed. `ACCEPTANCE.md` section 2
 * names the first three by description -- *before the durable write*,
 * *after the durable write but before the side effect*, *after the side
 * effect but before its result is recorded* -- and the outbox rows add the
 * fourth, a kill after delivery but before the ack is recorded.
 *
 * S9 (Issue `#15`) builds the deterministic harness; S7's obligation is to
 * make the points **exist, be named, and be reachable**, because a window
 * that no test can stop inside is a window nobody can prove anything about.
 * They are constants rather than string literals at the call sites so that
 * the harness binds to a name the compiler checks.
 */
export const CHECKPOINT_BEFORE_DURABLE_WRITE = "before_durable_write";
export const CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT = "after_record_before_effect";
export const CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD = "after_effect_before_record";
export const CHECKPOINT_DELIVERED_BEFORE_ACK = "delivered_before_ack";

export const CHECKPOINTS = Object.freeze([
  CHECKPOINT_BEFORE_DURABLE_WRITE,
  CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
  CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
  CHECKPOINT_DELIVERED_BEFORE_ACK,
] as const);

/**
 * "No outbox row remains in a state with no owner after recovery" as a
 * query, so the acceptance criterion can be run by hand against a database
 * recovered from a crash rather than only reached through this module
 * (D-0001, and the same reason S5 keeps `RECONSTRUCTION_QUERIES` as data).
 *
 * A row is **unowned** when it is unfinished and its `writer_epoch` is null
 * or does not match a live lease on the resource -- that is, when no living
 * claimant is entitled to advance it. Recovery's job is to make this query
 * return nothing.
 *
 * **What "unfinished" means changed with migration 0003.** The predicate
 * used to read `status <> 'acked'`, which was the whole of "unfinished"
 * while an ack was the only way out. It is not any more: a `'cancelled'` row
 * is finished ({@link TERMINAL_OUTBOX_STATUSES}), and nobody is ever going
 * to own it again. Left unfixed, {@link Outbox.recover} would keep adopting
 * cancelled rows on every pass and {@link RecoveryReport.stillUnowned} would
 * name them for the rest of the database's life -- the *alarms forever*
 * failure `docs/production-schema.md` section 5.7 introduced `'cancelled'`
 * to end, reproduced one table over by the module that reads it.
 *
 * The predicate is spelled as the **positive** `IN` list rather than as the
 * negation of the terminal set, character-for-character matching the
 * `outbox_undelivered` partial index's own `WHERE`. SQLite will only use a
 * partial index when the query's `WHERE` carries the index predicate as a
 * literal term, so the positive spelling is what keeps this an index scan
 * instead of a table scan -- the same reason {@link
 * "./events.js".ORPHANED_OUTBOX_SQL} and `gates.ts`'s orphaned-relay sweep
 * are spelled that way.
 *
 * This constant is **exported and read by the fault-injection belt** as the
 * no-unowned-outbox invariant, run by hand against a recovered database. The
 * fix therefore reaches that belt too: before it, a kill inside a gate
 * closure left evidence the belt would have called a violation.
 */
export const UNOWNED_OUTBOX_QUERY = `
    SELECT message_id, status, retry_count, writer_epoch, enqueued_at_ms
      FROM outbox
     WHERE status IN ('pending', 'delivered')
       AND (writer_epoch IS NULL
            OR NOT EXISTS (SELECT 1
                             FROM lease
                            WHERE lease.resource      = :resource
                              AND lease.epoch         = outbox.writer_epoch
                              AND lease.expires_at_ms > :now_ms))
     ORDER BY enqueued_at_ms, message_id
`;

/**
 * What {@link Outbox.due} reads. Unfinished means `'pending'` or
 * `'delivered'`: a delivered message whose ack never arrived is exactly the
 * resend case, so it stays due.
 *
 * It used to say *not acked*, and that sentence is now false. Migration 0003
 * gave the table a second terminal word: a `'cancelled'` message is
 * finished, and nobody is going to send it -- the gate that enqueued it
 * withdrew the question. Offering it as due would put a withdrawn relay back
 * on the delivery worker's list on every pass, which is precisely what the
 * cancellation was written to stop.
 *
 * The predicate is spelled as the positive `IN` list, character-for-character
 * matching the `outbox_undelivered` partial index
 * (`... WHERE status IN ('pending', 'delivered')`). SQLite uses a partial
 * index only when the query's `WHERE` carries the index predicate as a term,
 * so the negation of {@link TERMINAL_OUTBOX_STATUSES} -- algebraically the
 * same rows on today's four-word vocabulary -- would silently turn this into
 * a full table scan. The suite asserts the query plan actually names
 * `outbox_undelivered`, so the spelling is checked and not merely intended.
 *
 * **Exported for that assertion, and for nothing else.** The underscore keeps
 * it out of the module's ordinary vocabulary, exactly as {@link
 * _COUNT_ATTEMPT} and {@link _MARK_DELIVERED} are exported for the suite's
 * fence cases. The reason it must be a module-level constant rather than a
 * string built inside {@link Outbox.due} is the one {@link
 * "./events.js".ORPHANED_OUTBOX_SQL} states in full: a plan test that pastes
 * the query into itself asserts a property of the paste, and that form was in
 * the source suite and stayed green while the shipped predicate was rewritten
 * into the degraded arithmetic below. Nothing else may hold a second copy of
 * this text; the constant is the only copy, and the suite EXPLAINs the
 * statement it traces out of the driver rather than this identifier.
 */
export const _DUE_QUERY = `
    SELECT message_id, run_id, recipient, payload, dedup_key, status,
           retry_count, writer_epoch, enqueued_at_ms, delivered_at_ms, acked_at_ms
      FROM outbox
     WHERE status IN ('pending', 'delivered')
       AND enqueued_at_ms <= :now_ms
     ORDER BY enqueued_at_ms, message_id
`;

/**
 * The algebraically identical, index-losing form of {@link _DUE_QUERY} -- the
 * same rows, with `enqueued_at_ms` buried inside an expression no b-tree can
 * seek on (`:now_ms - enqueued_at_ms >= 0` says exactly what `enqueued_at_ms
 * <= :now_ms` says, and SQLite cannot use an index on a column that appears
 * only under arithmetic).
 *
 * It exists so that the plan assertion on the shipped form is not vacuous.
 * "The due query uses `outbox_undelivered`" would also pass on a database
 * where *every* plan reports a search; the claim only becomes a claim once
 * some algebraically equal form is shown to lose the index on this same
 * database, with this same data, in this same test. That is the whole job of
 * this constant, and it is the same job {@link
 * "./events.js".DEGRADED_ORPHANED_OUTBOX_SQL} does one module over -- written
 * here as its twin so a reader who has met one recognises the other.
 *
 * **Never executed by the product.** The only caller is the suite, which runs
 * it twice: once under `EXPLAIN QUERY PLAN` to show the degradation, and once
 * for real to show the two forms return the same non-empty rows -- because a
 * plan comparison between two queries that disagree about rows is a comparison
 * of two different questions.
 */
export const _DEGRADED_DUE_QUERY = _DUE_QUERY.replace(
  "AND enqueued_at_ms <= :now_ms",
  "AND :now_ms - enqueued_at_ms >= 0",
);

const _LOAD_QUERY = `
    SELECT message_id, run_id, recipient, payload, dedup_key, status,
           retry_count, writer_epoch, enqueued_at_ms, delivered_at_ms, acked_at_ms
      FROM outbox
     WHERE message_id = :message_id
`;

/**
 * Every protected statement below is issued by the typed builders in
 * `lease.ts` (#42): the fence is a clause of the write itself, in the
 * single-statement form `spike_schema.sql` specifies on the `lease` table,
 * and no SQL text is synthesised here -- `fencedUpdate` / `fencedInsert`
 * render every character, this module only binds parameters. The `EXISTS`
 * clause is inside the write and not a preceding `SELECT`: check-then-write
 * leaves precisely the race in which the lease expires between the check and
 * the write, which is the case `ACCEPTANCE.md` section 2 injects into.
 *
 * The updates that advance a live row also match `writer_epoch` against the
 * fence's own epoch: the row must be *owned* by the writing epoch, not
 * merely written while some lease is live. Re-assigning
 * `writer_epoch = fenceEpoch` on those statements stores the value the
 * predicate just proved the row already carries; it is the builder's stamp
 * rule made explicit, never a change of attribution.
 */
const _ENQUEUE: FencedStatement = fencedInsert("outbox", {
  values: {
    message_id: param("message_id"),
    run_id: param("run_id"),
    recipient: param("recipient"),
    payload: param("payload"),
    dedup_key: param("dedup_key"),
    status: value("pending"),
    retry_count: value(0),
    writer_epoch: fenceEpoch,
    enqueued_at_ms: param("enqueued_at_ms"),
  },
});

/**
 * The two spellings of "unfinished", and why they are deliberately not the
 * same spelling.
 *
 * The **read** queries above carry the positive `status IN ('pending',
 * 'delivered')` because that literal text is what makes SQLite use the
 * `outbox_undelivered` partial index. The **write** statements here and at
 * {@link _ADOPT} carry the *negation of the terminal set*, generated from
 * {@link TERMINAL_OUTBOX_STATUSES} by the helper below rather than written
 * out by hand.
 *
 * Two reasons, and both matter:
 *
 * - **The builder cannot express the positive form.** `lease.ts`'s fenced
 *   statement builder is a faithful port with a deliberately tiny predicate
 *   grammar -- `Predicate = Comparison | IsNull | Conjunction`, and a
 *   `Comparison`'s operator is only `'='` or `'<>'`. There is no `IN` and no
 *   disjunction, so `status IN ('pending', 'delivered')` has no rendering.
 *   Growing the grammar to get one is a change to a ported module and out of
 *   this change's scope; a conjunction of `<>` says the same thing today.
 * - **"Not terminal" is the right semantics for a write anyway.** These
 *   statements mean *the row is not finished, so it may still be advanced*.
 *   A future status that is **not** terminal -- a hold, a deferral -- should
 *   keep its row attemptable, and the negation says so on its own, while an
 *   allow-list would have to be edited to let it through. Generating the
 *   conjunction from the constant closes the other half: a future *terminal*
 *   status is excluded here the moment it is added to the tuple, with no
 *   second site to remember.
 *
 * The index is not lost by this: these are `UPDATE`s selected by
 * `message_id`, the primary key, so the status conjunct is a filter on one
 * already-located row and never a scan predicate.
 */
const _notTerminal = () => TERMINAL_OUTBOX_STATUSES.map((status) => ne("status", value(status)));

export const _COUNT_ATTEMPT: FencedStatement = fencedUpdate("outbox", {
  set: { retry_count: increment("retry_count"), writer_epoch: fenceEpoch },
  where: and_(
    eq("message_id", param("message_id")),
    // Was `ne("status", value("acked"))`, which matches a cancelled row: a
    // delivery worker would go on incrementing `retry_count` on a relay a
    // gate had already retired, and the durable count -- which ACCEPTANCE.md
    // section 2 reads as a record of attempts made -- would grow for a
    // message no attempt is ever made on again.
    ..._notTerminal(),
    eq("writer_epoch", fenceEpoch),
  ),
});

/**
 * The transition to `'delivered'`, and why its `delivered_at_ms IS NULL`
 * test stopped being sufficient on its own.
 *
 * Under `0001_initial.sql` the column carried an *iff* CHECK -- pending had
 * a null `delivered_at_ms` and every other status had one -- so
 * `delivered_at_ms IS NULL` and `status = 'pending'` picked out the same
 * rows and either could stand for the other. Migration 0003 broke that
 * equivalence in exactly one direction: a row cancelled **while pending**
 * keeps its null `delivered_at_ms` (a message never delivered has no
 * delivery instant to invent), so the null test is now true for a finished
 * row, while a row cancelled after delivery keeps its timestamp.
 *
 * Without the added `status = 'pending'` conjunct the statement therefore
 * still *matches* a cancelled-while-pending row, reaches SQLite, and is
 * aborted by `outbox_status_is_forward_only` -- `cancelled -> delivered` is
 * not an edge in 0003's lattice. That is a constraint error thrown out of
 * the middle of {@link Outbox.attempt}, after the effect has already been
 * performed, in place of the ordinary zero-rows-changed refusal the fenced
 * path is written to produce. The conjunct keeps the disagreement in the
 * `WHERE` clause, where the module can answer for it.
 */
export const _MARK_DELIVERED: FencedStatement = fencedUpdate("outbox", {
  set: {
    status: value("delivered"),
    delivered_at_ms: param("delivered_at_ms"),
    writer_epoch: fenceEpoch,
  },
  where: and_(
    eq("message_id", param("message_id")),
    eq("status", value("pending")),
    isNull("delivered_at_ms"),
    eq("writer_epoch", fenceEpoch),
  ),
});

export const _PENDING_ACTION: FencedStatement = fencedInsert("action", {
  values: {
    action_id: param("action_id"),
    run_id: param("run_id"),
    kind: param("kind"),
    idempotency_key: param("idempotency_key"),
    exactly_once_mechanism: param("mechanism"),
    status: value("pending"),
    writer_epoch: fenceEpoch,
    created_at_ms: param("created_at_ms"),
  },
});

/**
 * `stampsWriterEpoch: false`, deliberately: the pending row keeps the epoch
 * it was *recorded* under. A crash can leave a pending action adopted by a
 * later holder, and restamping it here would rewrite the attribution
 * `writeHistory()` reads the single-writer property out of.
 */
const _RECORD_RESULT: FencedStatement = fencedUpdate("action", {
  set: {
    status: value("applied"),
    applied_at_ms: param("applied_at_ms"),
    result: param("result"),
  },
  where: and_(eq("action_id", param("action_id")), eq("status", value("pending"))),
  stampsWriterEpoch: false,
});

/**
 * No ownership predicate, deliberately: adoption re-stamps whatever epoch
 * the row carried, including one whose lease row was itself lost -- see
 * {@link Outbox.recover}.
 *
 * The status conjunct is the generated negation of
 * {@link TERMINAL_OUTBOX_STATUSES}, for the reasons set out on
 * {@link _COUNT_ATTEMPT}. It was `ne("status", value("acked"))`, which let
 * recovery adopt a cancelled row: recovery would hand a live owner to a
 * message that will never be advanced again, on every pass, forever.
 */
const _ADOPT: FencedStatement = fencedUpdate("outbox", {
  set: { writer_epoch: fenceEpoch },
  where: and_(eq("message_id", param("message_id")), ..._notTerminal()),
});

// --------------------------------------------------------------------------
// the module's replaceable internals (D-0014)
// --------------------------------------------------------------------------

/**
 * The module's replaceable internal: the id generator behind an unnamed
 * refusal's `action_id`.
 *
 * `test_outbox.py` patches nothing here -- every case that reaches
 * {@link Outbox._recordBareRefusal} either supplies its own message (and so
 * its own deterministic `act-{idempotencyKey}` id) or does not assert the
 * generated refusal id's exact text. The seam is provided anyway, per
 * D-0014's own reasoning -- the same one `lease.ts`'s `leaseSeams` records --
 * that a seam nothing routes through is worse than none. The one internal
 * call site ({@link Outbox._recordBareRefusal}) goes through it.
 *
 * Not re-exported from `src/index.ts`: a testing seam, not public API.
 */
export const outboxSeams = {
  /** `uuid.uuid4().hex`: a lower-case 32-character hex string, no dashes. */
  uuid4Hex: (): string => randomUUID().replace(/-/g, ""),
};

// --------------------------------------------------------------------------
// errors
// --------------------------------------------------------------------------

/**
 * A handler was refused registration.
 *
 * Raised when a handler does not name a mechanism from
 * {@link EXACTLY_ONCE_MECHANISMS}, or names one it cannot support.
 * Registration is where this belongs: the acceptance criterion is that *a
 * later handler cannot be added without one*, and a check that only fires on
 * the first delivery lets an undeclared handler ship.
 */
export class HandlerRejected extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "HandlerRejected";
    Object.setPrototypeOf(this, HandlerRejected.prototype);
  }
}

// `StaleWriterRefused` is `lease.ts`'s own class, imported above and
// re-exported below. S7 landed first and grew its own copy while S6 was in
// flight; the two classes were consolidated into the lease-owned one (#45).
// Every throw below matches that class's contract: the refusal is durable
// *before* the throw, `actionId` names the `action` row in status
// `'refused'` that records it, and `observed` is the lease row as it stood
// at the moment of the refusal (`undefined` if the resource has no row).
export { StaleWriterRefused };

/**
 * The handler declares `'human_gate'`: neither mechanism is achievable.
 *
 * D-0004 makes this an explicit stop rather than a degraded automatic path.
 * The action is recorded as pending and is never advanced by the outbox; a
 * human moves it or nothing does. Issue `#14`'s scope note is emphatic about
 * the alternative -- *do not paper over it*.
 */
export class HumanGateRequired extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "HumanGateRequired";
    Object.setPrototypeOf(this, HumanGateRequired.prototype);
  }
}

/**
 * The row went terminal after the attempt began, and before the effect.
 *
 * `Outbox.attempt`'s step 0 guard refuses a message that is *already*
 * finished, and it runs once. This is the other half: the row was live when
 * the guard read it and had been retired -- gate closure writing
 * `'cancelled'`, most plausibly, since 0003 makes `pending -> cancelled` and
 * `delivered -> cancelled` edges a *different* writer takes without
 * consulting us -- by the time the attempt reached the destination. The
 * re-read beside the fence sees it and stops there, so the external effect
 * is never performed.
 *
 * A class of its own, and neither of the two it could have reused:
 *
 * - Not {@link StaleWriterRefused}. Nothing is stale about this writer; its
 *   lease is live, its epoch owns the row, and the very next thing the
 *   method does is prove it. Saying "stale writer" would send an operator
 *   looking at lease expiry and holder identity, which are exactly the two
 *   things that were fine.
 * - Not {@link OutboxUsageError}. That class is the module's
 *   programming-error class -- the source's bare `ValueError` -- and this is
 *   not a caller bug. A human answering a gate at the instant a delivery
 *   worker picks the relay up is an ordinary race that the design creates on
 *   purpose (`docs/design/minimal-operating-loop.md` section 5.1), and there
 *   is nothing for the caller to have done differently.
 *
 * Like {@link StaleWriterRefused}, the refusal is **durable before this is
 * thrown**: an `action` row in status `'refused'` records it, so the
 * evidence `ACCEPTANCE.md` section 2 asks for exists whether or not anyone
 * catches this. The row itself is left exactly as the cancelling writer left
 * it -- terminal, and this module writes nothing more to it.
 *
 * Known cost, stated rather than hidden: `src/messagebus/bus.ts:350` accepts
 * a residual exception out of `attempt()` only when it is an
 * {@link OutboxUsageError} or a {@link StaleWriterRefused}, so this class
 * does **not** currently flow through `MessageBus.poll`'s residual path and
 * a poll meeting this race loses its whole batch. Widening that test is
 * `src/messagebus/bus.ts`'s change to make, not this module's.
 */
export class CancelledBeforeEffect extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CancelledBeforeEffect";
    Object.setPrototypeOf(this, CancelledBeforeEffect.prototype);
  }
}

/**
 * The caller used this module in a way that would break its guarantees.
 *
 * Mirrors the source's bare `ValueError`: not a delivery-ledger refusal, a
 * programming error -- an unnamed lease resource/holder, or an operation
 * attempted against a message state it does not apply to.
 */
export class OutboxUsageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "OutboxUsageError";
    Object.setPrototypeOf(this, OutboxUsageError.prototype);
  }
}

// --------------------------------------------------------------------------
// records
// --------------------------------------------------------------------------

/** One outbox row, as the handler sees it. Frozen at construction. */
export class OutboxMessage {
  readonly messageId: string;
  readonly runId: string | null;
  readonly recipient: string;
  readonly payload: string;
  readonly dedupKey: string;
  readonly status: string;
  readonly retryCount: number;
  readonly writerEpoch: number | null;
  readonly enqueuedAtMs: number;
  readonly deliveredAtMs: number | null;
  readonly ackedAtMs: number | null;

  constructor(options: {
    readonly messageId: string;
    readonly runId: string | null;
    readonly recipient: string;
    readonly payload: string;
    readonly dedupKey: string;
    readonly status: string;
    readonly retryCount: number;
    readonly writerEpoch: number | null;
    readonly enqueuedAtMs: number;
    readonly deliveredAtMs: number | null;
    readonly ackedAtMs: number | null;
  }) {
    this.messageId = options.messageId;
    this.runId = options.runId;
    this.recipient = options.recipient;
    this.payload = options.payload;
    this.dedupKey = options.dedupKey;
    this.status = options.status;
    this.retryCount = options.retryCount;
    this.writerEpoch = options.writerEpoch;
    this.enqueuedAtMs = options.enqueuedAtMs;
    this.deliveredAtMs = options.deliveredAtMs;
    this.ackedAtMs = options.ackedAtMs;
    Object.freeze(this);
  }

  static fromRow(row: Record<string, unknown>): OutboxMessage {
    return new OutboxMessage({
      messageId: row.message_id as string,
      runId: row.run_id as string | null,
      recipient: row.recipient as string,
      payload: row.payload as string,
      dedupKey: row.dedup_key as string,
      status: row.status as string,
      retryCount: row.retry_count as number,
      writerEpoch: row.writer_epoch as number | null,
      enqueuedAtMs: row.enqueued_at_ms as number,
      deliveredAtMs: row.delivered_at_ms as number | null,
      ackedAtMs: row.acked_at_ms as number | null,
    });
  }
}

/** What one delivery attempt did. Frozen at construction. */
export class AttemptOutcome {
  readonly messageId: string;
  /**
   * The retry count **after** this attempt's durable increment. Monotonic
   * and restart-surviving; the increment is committed before the effect is
   * attempted, so an attempt that dies mid-flight is still counted.
   */
  readonly retryCount: number;
  /**
   * `true` when the destination recognised the key and applied nothing. A
   * resend of an already-applied effect lands here, and it is a success.
   */
  readonly deduplicated: boolean;
  /** The action row carrying the effect's exactly-once evidence. */
  readonly actionId: string;
  readonly idempotencyKey: string;
  /**
   * The mechanism the handler declared, copied onto the outcome so a caller
   * reading a log knows what the guarantee rested on.
   */
  readonly exactlyOnceMechanism: string;
  /**
   * The destination's own reference to its idempotency record, or `null`
   * for a mechanism that has no external counterparty.
   */
  readonly receiptRef: string | null;

  constructor(options: {
    readonly messageId: string;
    readonly retryCount: number;
    readonly deduplicated: boolean;
    readonly actionId: string;
    readonly idempotencyKey: string;
    readonly exactlyOnceMechanism: string;
    readonly receiptRef: string | null;
  }) {
    this.messageId = options.messageId;
    this.retryCount = options.retryCount;
    this.deduplicated = options.deduplicated;
    this.actionId = options.actionId;
    this.idempotencyKey = options.idempotencyKey;
    this.exactlyOnceMechanism = options.exactlyOnceMechanism;
    this.receiptRef = options.receiptRef;
    Object.freeze(this);
  }
}

/**
 * What one ack did -- which, for every ack after the first, is nothing.
 * Frozen at construction.
 */
export class AckOutcome {
  readonly messageId: string;
  /**
   * `true` only for the ack that moved the row. Duplicate and late acks
   * report `false` and are not errors: idempotent means *changes nothing*,
   * not *is rejected*.
   */
  readonly recorded: boolean;
  /**
   * The instant stored on the row, or `null` when the row carries no ack at
   * all. Equal to the caller's clock unless it had to be clamped -- see
   * {@link clockClamped}.
   *
   * `null` is not "unknown"; it is a fact, and under migration 0003's
   * `CHECK ((status = 'acked') = (acked_at_ms IS NOT NULL))` it is a fact
   * with exactly one cause: the row is `'cancelled'`, and a cancelled row
   * never carries an ack. Every other outcome -- the ack this call
   * recorded, a duplicate, a concurrent writer's -- names a real instant.
   * Widening the field was preferred to inventing a number for the
   * cancelled case, because a caller writing the value into a log would
   * then be recording an acknowledgement that never happened.
   */
  readonly ackedAtMs: number | null;
  /**
   * `true` when the row was `'cancelled'` -- retired by its gate -- so there
   * is nothing to acknowledge and nothing was written.
   *
   * A late ack arriving after a cancellation is **not** an error. It is the
   * ordinary shape of a race the recipient could not have avoided: the
   * message really was delivered, the recipient really did answer, and the
   * gate closed in between. `ACCEPTANCE.md` section 2's clause is that a
   * duplicate or late ack *changes nothing*, not that it is rejected, and
   * this is a late ack. The outcome reports `recorded: false`,
   * `ackedAtMs: null`, and this flag, so a caller that wants to distinguish
   * "someone else acked first" from "the question was withdrawn" can.
   */
  readonly cancelled: boolean;
  /**
   * `true` when the caller's clock ran **behind** the delivery instant and
   * the recorded value was clamped forward to it. `ACCEPTANCE.md` section 2
   * skews the clock backwards on purpose, and S5's
   * `acked_at_ms >= delivered_at_ms` CHECK would refuse the row. Losing a
   * real ack to a clock skew would be the worse failure, so the ordering is
   * preserved and the clamp is **reported** rather than applied silently:
   * the column is a record of lifecycle order, not a measurement of the
   * wall clock, and a caller that cares can see that its clock disagreed.
   */
  readonly clockClamped: boolean;

  constructor(options: {
    readonly messageId: string;
    readonly recorded: boolean;
    readonly ackedAtMs: number | null;
    readonly cancelled: boolean;
    readonly clockClamped: boolean;
  }) {
    this.messageId = options.messageId;
    this.recorded = options.recorded;
    this.ackedAtMs = options.ackedAtMs;
    this.cancelled = options.cancelled;
    this.clockClamped = options.clockClamped;
    Object.freeze(this);
  }
}

/**
 * What {@link Outbox.recover} found and what it did about it. Frozen at
 * construction.
 */
export class RecoveryReport {
  /** Messages that were unfinished and unowned when recovery started. */
  readonly adopted: readonly string[];
  /**
   * Messages still unowned afterwards. Non-empty means the acceptance
   * criterion is violated and recovery says so rather than reporting
   * success: it happens when the recovering holder's own lease is not
   * live, in which case adopting anything would have been the bug.
   */
  readonly stillUnowned: readonly string[];

  constructor(options: {
    readonly adopted?: readonly string[];
    readonly stillUnowned?: readonly string[];
  }) {
    this.adopted = Object.freeze([...(options.adopted ?? [])]);
    this.stillUnowned = Object.freeze([...(options.stillUnowned ?? [])]);
    Object.freeze(this);
  }
}

// --------------------------------------------------------------------------
// the handler contract
// --------------------------------------------------------------------------

/**
 * A side-effect handler that **names** its exactly-once mechanism.
 *
 * Subclasses set three instance fields:
 *
 * `recipient` -- The `outbox.recipient` value this handler serves. It is the
 * registry key: the recipient names *where* a message goes, and the handler
 * is *how* it gets there.
 *
 * `actionKind` -- What is written to `action.kind`.
 *
 * `exactlyOnceMechanism` -- One of {@link EXACTLY_ONCE_MECHANISMS}. **There
 * is no default that means anything.** A default would be the whole failure
 * this criterion guards against -- a handler that never thought about the
 * question and inherited an answer anyway -- so a subclass that omits it is
 * refused at registration, exactly as the source's empty-string class
 * default is.
 */
export class ActionHandler {
  readonly recipient: string = "";
  readonly actionKind: string = "";
  readonly exactlyOnceMechanism: string = "";

  /**
   * The key one effect is identified by.
   *
   * The outbox dedup key namespaced by the **recipient** and the action
   * kind. Namespacing is not decoration: `action.idempotency_key` is unique
   * across the whole table, so two handlers deriving keys from the same
   * dedup key would have one silently deduplicate against the other's
   * effect -- an effect that never happens, reported as exactly-once.
   *
   * The recipient is in the key and the action kind alone is not, because
   * the recipient is what the registry makes unique. Nothing stops two
   * handlers from sharing an `actionKind` while serving different
   * recipients -- and if they did, the second would find the first's action
   * row already applied, skip recording its own receipt, and report an
   * effect at *its* destination that no record of ours points at.
   */
  idempotencyKey(message: OutboxMessage): string {
    return `${this.recipient}:${this.actionKind}:${message.dedupKey}`;
  }

  /**
   * Perform the side effect, or recognise it as already performed.
   *
   * Called with the `action` row already durable in status `'pending'` and
   * **committed** -- that ordering is what makes the effect recoverable
   * rather than merely attempted. Returning normally means the effect is
   * present at the destination; throwing means it is not, and the message
   * stays due.
   *
   * *fencingToken* is the writer's lease epoch and *fenceScope* is the
   * lease resource it was drawn from, both to be carried to the destination
   * so it can refuse a superseded writer. The scope matters: epochs from
   * different leases are different sequences, and a destination comparing
   * them against one another would reject live writers. The token is
   * **not** a substitute for the fence on our own writes -- those two
   * guard different windows, and only the destination's guards the one
   * where this process was paused past its own lease.
   *
   * The base class's signature carries `fenceScope` even though the
   * source's `ActionHandler.apply` does not declare it: every concrete
   * handler in `handlers.py` overrides with a `fence_scope` parameter, and
   * `Outbox.attempt` always calls with four positional arguments -- Python's
   * duck typing lets the base class's narrower declaration and the actual
   * call disagree; TypeScript's structural typing does not, so the base
   * signature here is widened to match what is actually called through it.
   */
  apply(
    _message: OutboxMessage,
    _idempotencyKey: string,
    _fencingToken: number | null = null,
    _fenceScope: string | null = null,
  ): DeliveryReceipt | null {
    throw new Error("ActionHandler.apply is not implemented");
  }
}

/**
 * Handlers by recipient, admitting only those that declare a mechanism.
 *
 * The acceptance criterion -- *the name is asserted by a test, so a later
 * handler cannot be added without one* -- is discharged in two places, and
 * it needs both. Here, so that an undeclared handler cannot be registered at
 * all; and in the suite, which walks every registered handler and checks
 * its declaration, so that the guarantee survives someone bypassing this
 * class.
 */
export class HandlerRegistry {
  private readonly _byRecipient = new Map<string, ActionHandler>();

  register(handler: ActionHandler): ActionHandler {
    if (!handler.recipient) {
      throw new HandlerRejected(
        `${handler.constructor.name} does not name the recipient it serves`,
      );
    }
    if (!handler.actionKind) {
      throw new HandlerRejected(
        `${handler.constructor.name} does not name the action kind it records`,
      );
    }
    const mechanism = handler.exactlyOnceMechanism;
    if (!(EXACTLY_ONCE_MECHANISMS as readonly string[]).includes(mechanism)) {
      throw new HandlerRejected(
        `${handler.constructor.name} declares exactly_once_mechanism ${pythonRepr(mechanism)}, ` +
          `which is not one of ${pythonTuple(EXACTLY_ONCE_MECHANISMS)}. ACCEPTANCE.md section 2 ` +
          "requires every action handler to name which mechanism makes it exactly-once, or to " +
          "declare 'human_gate' because neither is achievable (D-0004) -- SQLite cannot tell a " +
          "completed side effect from one that never started, so a handler that names nothing " +
          "is claiming a guarantee it has no way to hold",
      );
    }
    if (Object.hasOwn(UNSUPPORTED_MECHANISMS, mechanism)) {
      throw new HandlerRejected(
        `${handler.constructor.name} declares exactly_once_mechanism ${pythonRepr(mechanism)}, ` +
          `which this outbox cannot provide: ${UNSUPPORTED_MECHANISMS[mechanism]}`,
      );
    }
    const existing = this._byRecipient.get(handler.recipient);
    if (existing !== undefined) {
      throw new HandlerRejected(
        `recipient ${pythonRepr(handler.recipient)} already has a handler ` +
          `(${existing.constructor.name})`,
      );
    }
    this._byRecipient.set(handler.recipient, handler);
    return handler;
  }

  forRecipient(recipient: string): ActionHandler {
    const handler = this._byRecipient.get(recipient);
    if (handler === undefined) {
      throw new HandlerRejected(`no handler is registered for recipient ${pythonRepr(recipient)}`);
    }
    return handler;
  }

  handlers(): readonly ActionHandler[] {
    const keys = [...this._byRecipient.keys()].sort();
    return Object.freeze(keys.map((key) => this._byRecipient.get(key) as ActionHandler));
  }
}

/** The default kill point: nothing happens. */
function _noCheckpoint(_name: string): void {
  // intentionally empty
}

// --------------------------------------------------------------------------
// the outbox
// --------------------------------------------------------------------------

/**
 * Resend, ack and dedup over the S5 `outbox` and `action` tables.
 *
 * *resource* and *holder* are the lease this writer's protected statements
 * are fenced against. They are required arguments with no defaults: on this
 * spike schema, which component may write which state item was `Q-0001` and
 * open, so a default would have been an answer to it. D-0029 has since
 * resolved `Q-0001` in the production schema
 * (`docs/production-schema.md` section 4.2), but the arguments stay
 * required regardless -- the schema now *records* the assignment, it does
 * not make the caller's own statement of who it is unnecessary.
 *
 * *checkpoint* is called at each of {@link CHECKPOINTS}. It exists so S9 can
 * stop a delivery inside a window; throwing from it is how a test kills a
 * process at a named instant.
 */
export class Outbox {
  private readonly _connection: SqliteDatabase;
  private readonly _resource: string;
  private readonly _holder: string;
  private readonly _registry: HandlerRegistry;
  private readonly _checkpoint: (name: string) => void;

  constructor(
    connection: SqliteDatabase,
    options: {
      readonly resource: string;
      readonly holder: string;
      readonly registry: HandlerRegistry;
      readonly checkpoint?: (name: string) => void;
    },
  ) {
    const { resource, holder, registry, checkpoint = _noCheckpoint } = options;
    if (!resource || !holder) {
      throw new OutboxUsageError(
        "an outbox writer names the lease resource and holder it writes under",
      );
    }
    this._connection = connection;
    this._resource = resource;
    this._holder = holder;
    this._registry = registry;
    this._checkpoint = checkpoint;
  }

  // -- enqueue ----------------------------------------------------------

  /**
   * Write one pending outbox row.
   *
   * The row is written under *epoch* so that it has an owner from the
   * instant it exists: a row enqueued with no `writer_epoch` would satisfy
   * {@link UNOWNED_OUTBOX_QUERY} the moment it was committed, which is the
   * state the recovery criterion forbids.
   *
   * The insert is **fenced**, like every other write here. Enqueueing looks
   * like the one harmless statement -- it only adds a row -- but a stale
   * holder that can enqueue mutates control-plane state after losing its
   * lease, and every row it writes is unowned from the moment it commits.
   * `ACCEPTANCE.md` section 2 asks that a stale writer be *rejected, not
   * merged*, without exempting the writes that merely create work; so the
   * lease predicate is inside the `INSERT` rather than in front of it, in
   * the same single-statement form as the updates.
   *
   * A duplicate `messageId` is refused by the primary key rather than
   * collapsed here. Re-enqueueing the same *dedup key* under a **new**
   * message id is legal and expected -- a sender killed after committing a
   * row may not know it committed -- and is what makes the effect-level
   * dedup in {@link attempt} the thing that carries exactly-once.
   */
  enqueue(options: {
    readonly messageId: string;
    readonly recipient: string;
    readonly payload: string;
    readonly dedupKey: string;
    readonly nowMs: number;
    readonly epoch: number;
    readonly runId?: string | null;
  }): OutboxMessage {
    const { messageId, recipient, payload, dedupKey, nowMs, epoch, runId = null } = options;

    const info = this._connection.prepare(String.prototype.valueOf.call(_ENQUEUE) as string).run({
      message_id: messageId,
      run_id: runId,
      recipient,
      payload,
      dedup_key: dedupKey,
      enqueued_at_ms: nowMs,
      ...this._fenceParams({ epoch, nowMs }),
    });
    const enqueued = info.changes === 1;

    if (!enqueued) {
      const reason =
        `refused to enqueue ${pythonRepr(messageId)} for ${pythonRepr(recipient)}: epoch ` +
        `${epoch} is not a live lease on ${pythonRepr(this._resource)} held by ` +
        `${pythonRepr(this._holder)} at ${nowMs}`;
      const { actionId, observed } = this._recordBareRefusal({
        runId,
        kind: `enqueue:${recipient}`,
        idempotencyKey: `enqueue:${recipient}:${dedupKey}`,
        mechanism: "human_gate",
        reason,
        nowMs,
        epoch,
      });
      throw new StaleWriterRefused(reason, { actionId, observed });
    }

    return this.load(messageId);
  }

  // -- reading ------------------------------------------------------------

  load(messageId: string): OutboxMessage {
    const row = this._one(_LOAD_QUERY, { message_id: messageId });
    if (row === undefined) {
      throw new Error(`no outbox row ${pythonRepr(messageId)}`);
    }
    return OutboxMessage.fromRow(row);
  }

  /**
   * Everything enqueued and not yet acked, oldest first.
   *
   * A *delivered* message with no ack is due again: that is the resend, and
   * it is the correct answer to a lost ack. No interval, backoff or
   * visibility timeout is applied -- see this module's docstring on
   * `Q-0003`.
   */
  due(nowMs: number): readonly OutboxMessage[] {
    return Object.freeze(this._all(_DUE_QUERY, { now_ms: nowMs }).map(OutboxMessage.fromRow));
  }

  /** Unfinished rows with no live owner. The recovery criterion, as a read. */
  unowned(nowMs: number): readonly string[] {
    const rows = this._all(UNOWNED_OUTBOX_QUERY, { resource: this._resource, now_ms: nowMs });
    return Object.freeze(rows.map((row) => String(row.message_id)));
  }

  // -- the delivery attempt -------------------------------------------------

  /**
   * One delivery attempt, with the kill windows where they actually are.
   *
   * The ordering below is the whole point of the method, so it is spelled
   * out rather than left to be reconstructed from the code:
   *
   * 1. **The durable write.** `retryCount` is incremented and committed
   *    *before* anything is attempted. A kill here loses no message: the
   *    row is still due. Counting after a successful delivery instead would
   *    make the count a record of successes, and `ACCEPTANCE.md` section 2
   *    asks it to survive *"the recipient unavailable across several retry
   *    attempts"* -- attempts that by construction never succeed.
   * 2. **The action row.** The effect's intent becomes durable, in status
   *    `'pending'`, and is committed before the effect is attempted. A kill
   *    between here and the effect leaves a pending action that recovery
   *    replays; a kill *after* the effect and before its result is
   *    recorded leaves the same row, and it is replayed the same way. That
   *    the two cases are indistinguishable to us is not a defect being
   *    tolerated -- it is the limit `ACCEPTANCE.md` section 2 names, and
   *    the declared mechanism is what makes the replay safe instead of
   *    doubling the effect.
   * 3. **The effect**, through the handler, keyed so the destination can
   *    refuse a duplicate.
   * 4. **The record**, and then the outbox row's transition to
   *    `'delivered'` -- which, under migration 0003's forward-only lattice,
   *    is an edge only from `'pending'`. A row that reached a terminal
   *    status has no such edge and is refused at step 0 below, not here.
   *
   * **Step 0: a terminal row is refused before any of it runs.** The guard
   * is the first thing the method does, and it has to be, because every one
   * of the four steps above is a step this method takes *on the caller's
   * word*. `'acked'` and `'cancelled'` are both terminal
   * ({@link TERMINAL_OUTBOX_STATUSES}) and the refusal is loud -- an
   * {@link OutboxUsageError}, the module's programming-error class -- rather
   * than a quiet return, because a direct caller presenting a finished
   * message is a bug in the caller. `MessageBus.poll` (`src/messagebus/bus.ts`) is what is
   * responsible for never arriving here with such a row; this guard exists
   * for everything that is not it.
   *
   * **Step 0 is asked twice, and the second asking is a different
   * question.** Step 0 answers *was this message finished when I picked it
   * up*, which is about the caller. The re-read in front of step 3 answers
   * *is it finished now*, which is about a race: gate closure writes
   * `'cancelled'` from another writer entirely, and steps 1 and 2 are two
   * committed transactions' worth of time for it to do so. That refusal is
   * a {@link CancelledBeforeEffect}, not an {@link OutboxUsageError} --
   * nobody made a mistake -- and it is recorded durably before it is
   * thrown. Step 4 then covers the remainder: a cancellation that lands
   * after the effect cannot be prevented, so it is *recorded* instead (see
   * {@link _markDelivered}).
   *
   * The ack is deliberately *not* here. Delivery and acknowledgement are
   * separate events with a kill window between them, and collapsing them
   * would erase the window the gate injects into.
   */
  attempt(
    messageId: string,
    options: { readonly nowMs: number; readonly epoch: number },
  ): AttemptOutcome {
    const { nowMs, epoch } = options;
    const message = this.load(messageId);
    // The terminal check is the first statement in the method, and its
    // position is the load-bearing part.
    //
    // It is not the only one. A row that got past this line goes on to
    // increment `retry_count` durably and write a pending action row, and a
    // status re-read stands beside the fence re-read further down, in front
    // of the effect, because this reading of the row goes stale the instant
    // it is taken (gate closure is a different writer and does not consult
    // us). What the *first* check buys is that a caller presenting an
    // already-finished message is refused before any of the four steps runs
    // at all -- no attempt count, no action row, no effect -- and what the
    // second buys is that a message retired *during* those steps still never
    // reaches the destination. Neither subsumes the other, and only the
    // second is a race; this one is a caller bug.
    //
    // Both terminal words get their own sentence rather than one shared
    // "already finished": the reader of this error is being told what
    // happened to their message, and *acked* and *cancelled* are opposite
    // stories about it.
    if (isTerminalOutboxStatus(message.status)) {
      if (message.status === "cancelled") {
        throw new OutboxUsageError(
          `${pythonRepr(messageId)} is cancelled; a cancelled message was retired by the gate ` +
            "that enqueued it, and presenting it would be delivering a question nobody is " +
            "waiting for",
        );
      }
      throw new OutboxUsageError(
        `${pythonRepr(messageId)} is already acked; an acked message is not resent`,
      );
    }
    const handler = this._registry.forRecipient(message.recipient);

    if (handler.exactlyOnceMechanism === "human_gate") {
      // D-0004: neither mechanism is achievable, so the action is recorded
      // and parked. It is never advanced by this module -- an automatic
      // recovery path here is exactly the papering-over Issue #14 forbids.
      const idempotencyKey = handler.idempotencyKey(message);
      // Fenced like every other action write. This path reaches the table
      // without passing through any of the protected updates, so leaving
      // it unfenced would have made it the one statement a stale holder
      // could always land.
      const { actionId } = this._ensurePendingAction(
        message,
        handler,
        idempotencyKey,
        nowMs,
        epoch,
      );
      throw new HumanGateRequired(
        `${handler.constructor.name} declares 'human_gate': neither a destination-supported ` +
          `idempotency key nor a transactional commit is achievable for ` +
          `${pythonRepr(message.recipient)}, so action ${actionId} stays pending until a human ` +
          "moves it (D-0004)",
      );
    }

    this._checkpoint(CHECKPOINT_BEFORE_DURABLE_WRITE);

    // (1) the durable write, fenced.
    this._fenced(
      _COUNT_ATTEMPT,
      { message_id: messageId },
      {
        nowMs,
        epoch,
        message,
        handler,
        what: "increment the retry count",
      },
    );
    const retryCount = this.load(messageId).retryCount;

    // (2) the effect's intent, durable and committed before the effect.
    const idempotencyKey = handler.idempotencyKey(message);
    const { actionId, alreadyApplied, priorResult, createdAtMs } = this._ensurePendingAction(
      message,
      handler,
      idempotencyKey,
      nowMs,
      epoch,
    );

    this._checkpoint(CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT);

    // The fence, re-read immediately before the effect. The retry-count
    // update validated the lease and then committed, and the action row was
    // written after it: a writer paused across that gap would otherwise
    // reach the destination having lost its lease in between. Re-reading
    // narrows the window; it cannot close it, because no statement of ours
    // runs during the pause. That is why the epoch is also *carried into
    // the effect* below -- ACCEPTANCE.md section 2: *external destinations
    // must reject a stale token where they can enforce it*. The two guards
    // cover different halves and neither is redundant.
    if (!this._fenceIsLive({ epoch, nowMs })) {
      const reason =
        `refused to apply the effect for ${pythonRepr(messageId)}: epoch ${epoch} stopped being ` +
        `a live lease on ${pythonRepr(this._resource)} held by ${pythonRepr(this._holder)} ` +
        "before the effect was attempted";
      const refusal = this._recordRefusal(message, handler, reason, { nowMs, epoch });
      throw new StaleWriterRefused(reason, refusal);
    }

    // The status, re-read at the same point and for the same reason.
    //
    // Step 0's guard above reads the row once, at the top of the method, and
    // everything between there and here happens on that reading: the fenced
    // retry-count increment, the pending action row, and -- one line below --
    // the external effect. The guard answers "was this message finished when
    // I picked it up"; it cannot answer "is it finished now", and since
    // migration 0003 those are different questions, because `pending ->
    // cancelled` and `delivered -> cancelled` are edges a *different* writer
    // takes without consulting us. Gate closure is that writer, and a human
    // answering a gate while a delivery worker is mid-attempt on its relay is
    // not an exotic interleaving -- it is the ordinary timing the human gate
    // creates (`docs/design/minimal-operating-loop.md` section 5.1).
    //
    // Without this, the attempt ran the effect and then met
    // {@link _MARK_DELIVERED}'s `status = 'pending'` conjunct, which matches
    // nothing on a cancelled row; {@link _markDelivered} passes `allowNoRow`,
    // so the miss was *silent*, and `MessageBus.poll` counted the row as an
    // ordinary skip. The destination had been written to, and neither an
    // envelope nor a delivery record said so anywhere. Refusing here is the
    // only place that outcome can be prevented, because one line further on
    // it has already happened.
    //
    // The same honest admission the fence re-read above makes, and it is not
    // rhetorical here either: **this narrows the window, it does not close
    // it.** No statement of ours runs during the pause between this `load`
    // and `handler.apply` below, so a cancellation landing inside that pause
    // is invisible to us and the effect goes out. The irreducible residue is
    // exactly that gap, and what makes it acceptable is the second half of
    // the guard -- the same second half the fence comment argues for the
    // epoch. The effect carries the handler's idempotency key, so a
    // destination that already refused or recorded that key does not double
    // anything; what is left over is a *first* effect for a message retired
    // microseconds earlier, which is a delivery the gate was one instant too
    // late to stop and is indistinguishable, from the destination's side,
    // from one it was two instants too late to stop. Making that gap smaller
    // is possible (re-read under the same transaction as the effect); making
    // it zero is not, because the effect is outside the database.
    //
    // Terminality is asked of {@link isTerminalOutboxStatus} rather than
    // compared against `'cancelled'`, so a fifth terminal status added to
    // 0003's CHECK is classified in the one place this module keeps that
    // judgement.
    const beforeEffect = this.load(messageId);
    if (isTerminalOutboxStatus(beforeEffect.status)) {
      const reason =
        `refused to apply the effect for ${pythonRepr(messageId)}: the row reached ` +
        `${pythonRepr(beforeEffect.status)} after this attempt began, so the message the effect ` +
        "would deliver had been retired before the effect was attempted";
      // Durable first, then thrown -- {@link StaleWriterRefused}'s discipline
      // on the branch above, kept here because the evidence obligation is the
      // same one: a refusal nobody catches must still be readable out of the
      // `action` table afterwards.
      this._recordRefusal(message, handler, reason, { nowMs, epoch });
      throw new CancelledBeforeEffect(reason);
    }

    // (3) the effect itself -- attempted every time, including when our own
    // action row already says 'applied'.
    //
    // Short-circuiting on that row was the obvious optimisation and it is
    // the wrong call twice over. It would make our record the thing that
    // decides a duplicate, which is the *"asserts exactly-once for an
    // external effect using only our own rows"* evidence ACCEPTANCE.md
    // section 2 refuses; and it would break the resend, because a message
    // whose ack was lost would stop being offered to the destination and so
    // could never be acked. Calling through and letting the destination
    // refuse the duplicate is what at-least-once delivery with an
    // exactly-once effect actually looks like.
    // A DestinationRefusal propagates unhandled: the destination will not
    // carry the effect. The action row stays pending and the message stays
    // due; recording it applied here would be the "absence of a visible
    // duplicate" evidence item 4 rejects. (The source's own `except
    // DestinationRefusal: raise` is the same no-op re-raise, kept there only
    // for the comment; nothing is caught here for the same reason.)
    const receipt: DeliveryReceipt | null = handler.apply(
      message,
      idempotencyKey,
      epoch,
      this._resource,
    );

    this._checkpoint(CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD);

    // (4) the result, then the outbox transition. S5's
    // `action_apply_is_set_once` trigger would abort on a second write, so
    // an already-applied action keeps the result it was recorded with.
    let receiptRef = priorResult;
    if (!alreadyApplied) {
      receiptRef = receipt !== null ? receipt.receiptRef : null;
      const info = this._connection
        .prepare(String.prototype.valueOf.call(_RECORD_RESULT) as string)
        .run({
          action_id: actionId,
          // A restarted process retrying with a clock behind the instant
          // the intent was recorded would violate S5's
          // applied_at_ms >= created_at_ms CHECK and abort the transaction
          // -- stranding a delivery whose effect has already landed until
          // the clock caught up. Same treatment as the delivery and ack
          // instants: the column records lifecycle order, not a
          // wall-clock measurement.
          applied_at_ms: Math.max(nowMs, createdAtMs),
          result: receiptRef,
          ...this._fenceParams({ epoch, nowMs }),
        });
      const recorded = info.changes === 1;
      if (!recorded) {
        // The effect landed and we are no longer entitled to say so. The
        // action stays pending, so recovery replays it and the destination
        // deduplicates -- which is exactly the ambiguous window the
        // declared mechanism exists to make survivable. What must not
        // happen is a stale writer marking it applied.
        const reason =
          `refused to record the result for ${pythonRepr(messageId)}: epoch ${epoch} stopped ` +
          `being a live lease on ${pythonRepr(this._resource)} held by ` +
          `${pythonRepr(this._holder)} while the effect was in flight`;
        const refusal = this._recordRefusal(message, handler, reason, { nowMs, epoch });
        throw new StaleWriterRefused(reason, refusal);
      }
    }
    this._markDelivered(messageId, { nowMs, epoch, message, handler });
    this._checkpoint(CHECKPOINT_DELIVERED_BEFORE_ACK);

    return new AttemptOutcome({
      messageId,
      retryCount,
      deduplicated: Boolean(receipt?.deduplicated),
      actionId,
      idempotencyKey,
      exactlyOnceMechanism: handler.exactlyOnceMechanism,
      receiptRef,
    });
  }

  // -- ack -----------------------------------------------------------------

  /**
   * Record the ack, idempotently.
   *
   * The first ack moves the row. Every later one -- duplicated in flight,
   * delivered after the sender restarted, or replayed against an already
   * acked message -- changes nothing and is **not** an error: the
   * criterion is that a duplicate or late ack *changes nothing*, and
   * throwing would make a harmless duplicate into a failure the caller has
   * to special-case.
   *
   * Deliberately unfenced. An ack is the recipient telling us what it
   * already did; refusing to *record* that because our own lease moved on
   * would turn a delivered message back into an undelivered one and cause
   * a resend of an effect that is already present. The fence protects
   * writes that drive effects, and this one drives none -- S5's
   * `outbox_ack_is_set_once` trigger is what keeps it single-valued.
   *
   * An ack for a **cancelled** row is one more shape of "changes nothing".
   * The gate withdrew the question after the recipient had already answered
   * it -- a race the recipient could not have avoided and did nothing wrong
   * in -- so the outcome reports it ({@link AckOutcome.cancelled}) instead
   * of throwing. Migration 0003 makes the row's silence on the point
   * unambiguous: a cancelled row can never carry an `acked_at_ms`, so the
   * outcome's `ackedAtMs` is `null` and says so.
   */
  recordAck(messageId: string, options: { readonly nowMs: number }): AckOutcome {
    const { nowMs } = options;
    const message = this.load(messageId);
    if (message.ackedAtMs !== null) {
      return new AckOutcome({
        messageId,
        recorded: false,
        ackedAtMs: message.ackedAtMs,
        cancelled: false,
        clockClamped: false,
      });
    }
    // Cancelled is classified **before** the undelivered check, and the
    // order is not cosmetic. A row cancelled while still pending has a null
    // `delivered_at_ms` -- 0003 keeps the column null for a message that was
    // never delivered -- so it would otherwise fall into the branch below
    // and be reported as *"evidence of a lost delivery record"*, which is a
    // wildly wrong account of what happened: nothing was lost, the gate
    // withdrew the question. The branch below keeps its meaning only if the
    // one legitimate way to be undelivered-and-finished is taken out first.
    if (message.status === "cancelled") {
      return new AckOutcome({
        messageId,
        recorded: false,
        ackedAtMs: null,
        cancelled: true,
        clockClamped: false,
      });
    }
    if (message.deliveredAtMs === null) {
      throw new OutboxUsageError(
        `${pythonRepr(messageId)} has not been delivered; an ack for an undelivered message is ` +
          "evidence of a lost delivery record, not of a delivery",
      );
    }

    const deliveredAtMs = message.deliveredAtMs;
    const ackedAtMs = Math.max(nowMs, deliveredAtMs);

    // The `WHERE` says `status = 'delivered'`, not `acked_at_ms IS NULL`,
    // and the change closes a race the pre-checks above cannot.
    //
    // `acked_at_ms IS NULL` is true of a **cancelled** row as well as an
    // unacked one -- 0003's `CHECK ((status = 'acked') = (acked_at_ms IS NOT
    // NULL))` guarantees a cancelled row never carries an ack. So against a
    // row cancelled between the read a few lines up and this statement, the
    // old predicate did not merely fail to match: it *matched*, the
    // statement reached SQLite, and `outbox_status_is_forward_only` aborted
    // it -- `cancelled -> acked` is not an edge -- as a constraint error
    // thrown out of a method whose entire contract is that a late ack
    // changes nothing rather than failing. And in the reading where it lost
    // the row instead, the zero-rows branch below would have answered
    // "another writer acked", which is a plain false statement about a
    // cancelled row.
    //
    // Narrowing to `status = 'delivered'` makes the statement match exactly
    // the one state an ack is an edge out of, so a cancellation turns it
    // into an ordinary zero-rows outcome instead of a constraint error. The
    // pre-check alone could not have done this: a gate can close in the gap
    // between the read and the write, and no amount of checking first
    // removes a gap. That is why both exist -- the pre-check answers the
    // common case with the right story, and the narrowed `WHERE` plus the
    // re-read below answer the racing one.
    const info = this._connection
      .prepare(
        `
                UPDATE outbox
                   SET status = 'acked', acked_at_ms = :acked_at_ms
                 WHERE message_id = :message_id AND status = 'delivered'
                `,
      )
      .run({ message_id: messageId, acked_at_ms: ackedAtMs });
    const recorded = info.changes === 1;

    if (!recorded) {
      // The row moved between the read and the write. Re-read it and say
      // which way it moved, rather than assuming: there are now two ways to
      // leave `'delivered'` and they mean opposite things.
      const settled = this.load(messageId);
      if (settled.ackedAtMs !== null) {
        // Another writer acked between the read and the write. Same answer
        // as a duplicate ack, which it is.
        //
        // `||`, not `??`: the source's `settled.acked_at_ms or acked_at_ms` is a
        // Python truthiness test (D-0021 lesson: do not narrow `or` into `??`),
        // and `||` reproduces it exactly -- an `acked_at_ms` of `0` would fall
        // through to `ackedAtMs` under both, and neither runtime treats a
        // present zero specially here.
        return new AckOutcome({
          messageId,
          recorded: false,
          ackedAtMs: settled.ackedAtMs || ackedAtMs,
          cancelled: false,
          clockClamped: false,
        });
      }
      if (settled.status === "cancelled") {
        // A gate closed in the gap. The recipient's answer is real and
        // arrived; nobody is waiting for it any more. Reported, not thrown.
        return new AckOutcome({
          messageId,
          recorded: false,
          ackedAtMs: null,
          cancelled: true,
          clockClamped: false,
        });
      }
      // Neither acked nor cancelled, and yet the UPDATE matched nothing.
      // Under 0003's lattice there is no third way out of `'delivered'`, so
      // this is not a race with a legitimate writer -- it is a row that was
      // moved backwards, deleted, or written by something that does not obey
      // the schema. Loud, because a silent `recorded: false` here would
      // report a lost ack as an idempotent no-op.
      throw new OutboxUsageError(
        `${pythonRepr(messageId)} could not be acked and is neither acked nor cancelled ` +
          `(status ${pythonRepr(settled.status)}): the ack UPDATE matched no row, which under ` +
          "migration 0003's forward-only lattice has no legitimate cause -- a concurrent writer " +
          "moved the row outside the vocabulary this module and the DDL share",
      );
    }

    return new AckOutcome({
      messageId,
      recorded: true,
      ackedAtMs,
      cancelled: false,
      clockClamped: ackedAtMs !== nowMs,
    });
  }

  // -- recovery --------------------------------------------------------------

  /**
   * Give every unfinished row a live owner, or report that it has none.
   *
   * *"No outbox row can remain in a state with no owner after recovery."*
   * The rows a crash leaves behind are owned by an epoch that died with the
   * process that held it, so recovery re-stamps them with the recovering
   * holder's live epoch -- fenced, so a recovering process whose own lease
   * is not live adopts nothing rather than adopting everything.
   *
   * The re-stamp is deliberately not conditional on the old epoch. Adopting
   * only rows whose previous owner is provably dead would leave rows
   * written by an epoch whose lease row was itself lost, which is the
   * state the criterion is about.
   */
  recover(options: { readonly nowMs: number; readonly epoch: number }): RecoveryReport {
    const { nowMs, epoch } = options;
    const candidates = this.unowned(nowMs);
    const adopted: string[] = [];
    for (const messageId of candidates) {
      const info = this._connection.prepare(String.prototype.valueOf.call(_ADOPT) as string).run({
        message_id: messageId,
        ...this._fenceParams({ epoch, nowMs }),
      });
      if (info.changes === 1) {
        adopted.push(messageId);
      }
    }

    return new RecoveryReport({ adopted, stillUnowned: this.unowned(nowMs) });
  }

  // -- internals ---------------------------------------------------------

  /**
   * Make the effect's intent durable, or find the record that already is.
   *
   * Returns `{actionId, alreadyApplied, priorResult, createdAtMs}`.
   *
   * The insert is allowed to lose to `action_one_effect_per_key`. Losing is
   * the dedup: it means this exact effect already has a record, either
   * applied (a duplicate delivery, and no second effect happens) or
   * pending (a previous attempt died, and this one resumes it under the
   * same key). Asking first and inserting second would leave the window
   * between the two statements, which is the shape of race item 4 exists
   * to rule out.
   *
   * It is also **fenced**. The retry-count update validated the lease and
   * then committed, so a writer superseded in the gap between the two
   * would otherwise still record an intent to cause an effect -- and on
   * the human-gate path this statement is reached without any protected
   * update in front of it at all, which would have made it the one write a
   * stale holder could always land.
   */
  private _ensurePendingAction(
    message: OutboxMessage,
    handler: ActionHandler,
    idempotencyKey: string,
    nowMs: number,
    epoch: number,
  ): {
    readonly actionId: string;
    readonly alreadyApplied: boolean;
    readonly priorResult: string | null;
    readonly createdAtMs: number;
  } {
    const actionId = `act-${idempotencyKey}`;
    let changed = 0;
    let integrityError: unknown = null;
    try {
      const info = this._connection
        .prepare(String.prototype.valueOf.call(_PENDING_ACTION) as string)
        .run({
          action_id: actionId,
          run_id: message.runId,
          kind: handler.actionKind,
          idempotency_key: idempotencyKey,
          mechanism: handler.exactlyOnceMechanism,
          created_at_ms: nowMs,
          ...this._fenceParams({ epoch, nowMs }),
        });
      changed = info.changes;
    } catch (error) {
      // Mirrors the source's `except sqlite3.IntegrityError`: D-0016's own
      // mapping, `isConstraintError` from `src/sqlite/errors.ts`, rather
      // than a local re-derivation of it.
      if (!isConstraintError(error)) {
        throw error;
      }
      integrityError = error;
    }

    if (integrityError === null && changed === 1) {
      return { actionId, alreadyApplied: false, priorResult: null, createdAtMs: nowMs };
    }

    if (integrityError !== null) {
      const row = this._one(
        "SELECT action_id, status, result, created_at_ms FROM action " +
          " WHERE idempotency_key = :key AND status <> 'refused'",
        { key: idempotencyKey },
      );
      if (row === undefined) {
        // The unique index did not cause this, so the row is malformed
        // rather than duplicated and swallowing it would hide it.
        throw integrityError;
      }
      return {
        actionId: String(row.action_id),
        alreadyApplied: String(row.status) === "applied",
        priorResult: row.result === null ? null : String(row.result),
        createdAtMs: Number(row.created_at_ms),
      };
    }

    // No row, and no unique-index collision: the fence rejected the writer.
    const reason =
      `refused to record the effect intent for ${pythonRepr(message.messageId)}: epoch ${epoch} ` +
      `is not a live lease on ${pythonRepr(this._resource)} held by ${pythonRepr(this._holder)} ` +
      `at ${nowMs}`;
    const { actionId: refusalId, observed } = this._recordRefusal(message, handler, reason, {
      nowMs,
      epoch,
    });
    throw new StaleWriterRefused(reason, { actionId: refusalId, observed });
  }

  /**
   * Move the row to `'delivered'` once, fenced -- and account for the miss.
   *
   * Idempotent by predicate rather than by trigger-catching: a resend of an
   * already delivered message must leave the original delivery instant
   * alone, and S5's `outbox_delivery_is_set_once` would abort the whole
   * transaction if we tried to rewrite it. That is what `allowNoRow` was
   * added for, and it is the *only* thing it was added for: the statement
   * matching nothing because the row is already `'delivered'` is a resend
   * doing exactly what a resend should do, and it must stay tolerated --
   * source-translated cases depend on it (the deduplicated-resend cases in
   * `test/control_plane/outbox.test.ts`).
   *
   * Under migration 0003 that is no longer the only way to match nothing,
   * and the other ways are not benign. `_MARK_DELIVERED` now requires
   * `status = 'pending'`, so a row cancelled *after* the effect went out --
   * inside the window the pre-effect re-read in {@link attempt} admits it
   * cannot close -- also matches nothing, and `allowNoRow` swallowed it. The
   * result was the failure this method now exists to prevent: the external
   * effect had happened, and every durable trace of it disagreed. No
   * envelope (the outbox row is terminal, so `MessageBus.poll` skips it), no
   * delivery record (the transition never landed), nothing but an `action`
   * row in `'applied'` that no one is looking for.
   *
   * So the miss is classified rather than tolerated wholesale, on the same
   * three-way shape {@link recordAck}'s zero-rows branch uses, and for the
   * same reason -- there is more than one way to leave a status now and they
   * mean different things:
   *
   * - **`'delivered'`**: the resend case above. Tolerated silently.
   * - **terminal**: retired mid-flight. The effect is real and the ledger
   *   has no room to say so, so it is written down where refusals are
   *   written down -- an `action` row in `'refused'` naming what happened.
   *   Recorded, not thrown: the effect *did* land, so the caller's
   *   {@link AttemptOutcome} is a true statement about what this attempt
   *   did, and throwing would additionally cost `MessageBus.poll` the rest
   *   of its batch (`src/messagebus/bus.ts:350` accepts only two classes as
   *   residual). The refusal row is the honest half; nobody is owed an
   *   exception for a race nobody could have avoided.
   * - **anything else** -- `'pending'` still, most plausibly with a
   *   `writer_epoch` that is no longer ours: loud. The fence was live when
   *   this ran, so under 0003's lattice there is no legitimate way for a
   *   pending row owned by a live epoch to refuse this update, and a silent
   *   return would report a lost delivery record as an idempotent no-op.
   */
  private _markDelivered(
    messageId: string,
    options: {
      readonly nowMs: number;
      readonly epoch: number;
      readonly message: OutboxMessage;
      readonly handler: ActionHandler;
    },
  ): void {
    const { nowMs, epoch, message, handler } = options;
    const moved = this._fenced(
      _MARK_DELIVERED,
      {
        message_id: messageId,
        // An enqueue instant later than the delivery instant is the
        // backward clock skew case; S5's CHECK refuses the row, and the
        // delivery is real either way.
        delivered_at_ms: Math.max(nowMs, message.enqueuedAtMs),
      },
      {
        nowMs,
        epoch,
        message,
        handler,
        what: "record the delivery",
        allowNoRow: true,
      },
    );
    if (moved) {
      return;
    }

    const settled = this.load(messageId);
    if (settled.status === "delivered") {
      // The resend, delivered already. The original instant stands.
      return;
    }
    if (isTerminalOutboxStatus(settled.status)) {
      // Retired between the pre-effect re-read and here. The effect is out
      // and cannot be recalled; what is still in our power is to stop the
      // database from being silent about it. `_recordRefusal` is reused
      // rather than a new table invented: the `action` row it writes already
      // carries the run, the action kind, the idempotency key the effect was
      // keyed with, the mechanism and a reason string, which is the whole of
      // what an operator needs to reconcile this against the destination's
      // own ledger -- and reconciling against the destination is what
      // `ACCEPTANCE.md` section 2 says the evidence is for.
      this._recordRefusal(
        message,
        handler,
        `applied the effect for ${pythonRepr(messageId)} and could not record the delivery: the ` +
          `row reached ${pythonRepr(settled.status)} while the effect was in flight, so it was ` +
          "retired after the destination had already been written to -- the effect is real and " +
          "the outbox row will never say so",
        { nowMs, epoch },
      );
      return;
    }

    throw new OutboxUsageError(
      `${pythonRepr(messageId)} could not be marked delivered and is neither delivered nor ` +
        `terminal (status ${pythonRepr(settled.status)}): the fence was live, so under migration ` +
        "0003's forward-only lattice this update had no legitimate reason to match no row -- a " +
        "concurrent writer moved the row outside the vocabulary this module and the DDL share",
    );
  }

  /** The fence's own bindings, under the names the builders reserve. */
  private _fenceParams(options: {
    readonly epoch: number;
    readonly nowMs: number;
  }): Record<string, unknown> {
    return {
      fence_resource: this._resource,
      fence_holder: this._holder,
      fence_epoch: options.epoch,
      fence_now_ms: options.nowMs,
    };
  }

  /**
   * Run one builder-issued *statement*, refusing a stale writer.
   *
   * *statement* is a `lease.ts` `FencedStatement`: the fence is already a
   * clause of the write, put there by the typed builder, and this method
   * only binds the fence's parameters. Nothing is appended to SQL text
   * here.
   *
   * *allowNoRow* distinguishes "the fence rejected me" from "the predicate
   * was already satisfied". The two are indistinguishable from the
   * statement's own change count alone, so when zero rows change and the
   * caller allows it, the fence is re-read on its own: if it is live,
   * nothing was refused and the statement was simply a no-op.
   *
   * Returns whether the statement actually moved its row. A stale writer
   * still throws, so the `false` return has exactly one meaning: *the fence
   * was live and the `WHERE` matched nothing*, which is the outcome
   * `allowNoRow` exists to permit. The caller is the only party that knows
   * which no-ops are legitimate for its own predicate -- this method cannot,
   * since it is handed the statement already rendered -- so it is handed the
   * fact rather than the judgement. Callers that pass no `allowNoRow` can
   * ignore the result: it is `true` on every path that returns.
   */
  private _fenced(
    statement: FencedStatement,
    params: Record<string, unknown>,
    options: {
      readonly nowMs: number;
      readonly epoch: number;
      readonly message: OutboxMessage;
      readonly handler: ActionHandler;
      readonly what: string;
      readonly allowNoRow?: boolean;
    },
  ): boolean {
    const { nowMs, epoch, message, handler, what, allowNoRow = false } = options;
    const bound = { ...params, ...this._fenceParams({ epoch, nowMs }) };

    // The write and the classification of a no-op run in ONE transaction.
    //
    // Separately, they are two autocommitted statements with a window between
    // them: when the statement changes no row and `allowNoRow` is set, the
    // fence is re-read to tell "already done, benign" from "superseded". A
    // lease taken over inside that window turns a legitimate deduplicated
    // resend into a recorded StaleWriterRefused -- a refusal history that
    // records something that did not happen, and a resend that fails for a
    // reason that was not true when it ran. interlock has the same two-step;
    // repaired here under D-0023.
    //
    // Joined rather than nested when the caller already holds a transaction:
    // `withImmediate` refuses an open one, and several callers wrap this.
    let refused = false;
    let changed = false;
    const attempt = (): void => {
      const info = this._connection
        .prepare(String.prototype.valueOf.call(statement) as string)
        .run(bound);
      if (info.changes >= 1) {
        changed = true;
        return;
      }
      if (allowNoRow && this._fenceIsLive({ epoch, nowMs })) {
        return;
      }
      refused = true;
    };
    if (this._connection.inTransaction) {
      attempt();
    } else {
      withImmediate(this._connection, attempt);
    }
    if (!refused) {
      return changed;
    }

    const reason =
      `refused to ${what} for ${pythonRepr(message.messageId)}: epoch ${epoch} is not a live ` +
      `lease on ${pythonRepr(this._resource)} held by ${pythonRepr(this._holder)} at ${nowMs}`;
    const refusal = this._recordRefusal(message, handler, reason, { nowMs, epoch });
    throw new StaleWriterRefused(reason, refusal);
  }

  private _fenceIsLive(options: { readonly epoch: number; readonly nowMs: number }): boolean {
    const row = this._one(
      // Byte-identical to the source, trailing spaces included: Python's three
      // adjacent literals each end with one, so the concatenation has a double
      // space after `lease` and four before `AND epoch`. SQL carries verbatim.
      "SELECT 1 AS live FROM lease " +
        " WHERE resource = :resource AND holder = :holder " +
        "   AND epoch = :epoch AND expires_at_ms > :now_ms",
      {
        resource: this._resource,
        holder: this._holder,
        epoch: options.epoch,
        now_ms: options.nowMs,
      },
    );
    return row !== undefined;
  }

  private _recordRefusal(
    message: OutboxMessage,
    handler: ActionHandler,
    reason: string,
    options: { readonly nowMs: number; readonly epoch: number },
  ): { readonly actionId: string; readonly observed: Lease | undefined } {
    return this._recordBareRefusal({
      runId: message.runId,
      kind: handler.actionKind,
      idempotencyKey: handler.idempotencyKey(message),
      mechanism: handler.exactlyOnceMechanism,
      reason,
      nowMs: options.nowMs,
      epoch: options.epoch,
    });
  }

  /**
   * Insert one refusal row, for a message that may not exist yet.
   *
   * The action id is randomised rather than composed from the message id,
   * the epoch and the instant. Composing it would collide whenever the
   * same stale writer retried twice inside one millisecond, and the
   * collision would surface as a constraint error **instead of** the
   * refusal being recorded -- losing precisely the evidence
   * `ACCEPTANCE.md` section 2 requires to be durable, in exactly the case
   * where the writer is trying hardest to get in.
   */
  private _recordBareRefusal(options: {
    readonly runId: string | null;
    readonly kind: string;
    readonly idempotencyKey: string;
    readonly mechanism: string;
    readonly reason: string;
    readonly nowMs: number;
    readonly epoch: number;
  }): { readonly actionId: string; readonly observed: Lease | undefined } {
    const { runId, kind, idempotencyKey, mechanism, reason, nowMs, epoch } = options;
    const actionId = `refused-${outboxSeams.uuid4Hex()}`;
    let observed: Lease | undefined;
    // BEGIN IMMEDIATE, not a bare write. Under the legacy isolation this
    // codebase's connections run on, a lone statement autocommits on its
    // own, so the read above it would otherwise run outside any
    // transaction and another connection could move the lease between the
    // row we observe and the refusal committing against it. The write lock
    // taken here up front is the same guard `lease.ts`'s own immediate
    // transaction uses to keep its classification honest.
    withImmediate(this._connection, () => {
      observed = readLease(this._connection, this._resource);
      this._connection
        .prepare(
          `
                INSERT INTO action (action_id, run_id, kind, idempotency_key,
                                    exactly_once_mechanism, status,
                                    refusal_reason, writer_epoch, created_at_ms)
                VALUES (:action_id, :run_id, :kind, :idempotency_key,
                        :mechanism, 'refused', :reason, :epoch, :now_ms)
                `,
        )
        .run({
          action_id: actionId,
          run_id: runId,
          kind,
          idempotency_key: idempotencyKey,
          mechanism,
          reason,
          epoch,
          now_ms: nowMs,
        });
    });
    return { actionId, observed };
  }

  private _one(
    query: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const rows = this._all(query, params);
    return rows.length > 0 ? rows[0] : undefined;
  }

  private _all(query: string, params: Record<string, unknown>): readonly Record<string, unknown>[] {
    return this._connection.prepare(query).all(params) as Record<string, unknown>[];
  }
}

// --------------------------------------------------------------------------
// internals shared by the class above
// --------------------------------------------------------------------------
