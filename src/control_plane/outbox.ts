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
 * **Spike scaffold, throwaway by default (D-0026).** This module sits on the
 * S5 spike schema, which carries the marking in `spike_schema.sql` itself: no
 * migration path is promised from it, and being depended on by S7 promotes
 * nothing. `Q-0001` (the real DDL, keys, indices and the per-item
 * single-writer table) was open when this module was written, and nothing
 * below answers it; D-0029 has since resolved it in the production schema
 * (`docs/production-schema.md` section 4.2, `migrations/0001_initial.sql`),
 * but this module was never migrated onto it. The durable half of Issue
 * `#14` is the test suite.
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
 * assignment `Q-0001` left open on this spike schema (the question is
 * answered in the production schema by D-0029, section 4.2, but this module
 * still runs against the S5 spike table that does not carry the answer); a
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
 */
export const UNOWNED_OUTBOX_QUERY = `
    SELECT message_id, status, retry_count, writer_epoch, enqueued_at_ms
      FROM outbox
     WHERE status <> 'acked'
       AND (writer_epoch IS NULL
            OR NOT EXISTS (SELECT 1
                             FROM lease
                            WHERE lease.resource      = :resource
                              AND lease.epoch         = outbox.writer_epoch
                              AND lease.expires_at_ms > :now_ms))
     ORDER BY enqueued_at_ms, message_id
`;

/**
 * What {@link Outbox.due} reads. Unfinished means *not acked*: a delivered
 * message whose ack never arrived is exactly the resend case, so it stays
 * due.
 */
const _DUE_QUERY = `
    SELECT message_id, run_id, recipient, payload, dedup_key, status,
           retry_count, writer_epoch, enqueued_at_ms, delivered_at_ms, acked_at_ms
      FROM outbox
     WHERE status <> 'acked'
       AND enqueued_at_ms <= :now_ms
     ORDER BY enqueued_at_ms, message_id
`;

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

export const _COUNT_ATTEMPT: FencedStatement = fencedUpdate("outbox", {
  set: { retry_count: increment("retry_count"), writer_epoch: fenceEpoch },
  where: and_(
    eq("message_id", param("message_id")),
    ne("status", value("acked")),
    eq("writer_epoch", fenceEpoch),
  ),
});

export const _MARK_DELIVERED: FencedStatement = fencedUpdate("outbox", {
  set: {
    status: value("delivered"),
    delivered_at_ms: param("delivered_at_ms"),
    writer_epoch: fenceEpoch,
  },
  where: and_(
    eq("message_id", param("message_id")),
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
 */
const _ADOPT: FencedStatement = fencedUpdate("outbox", {
  set: { writer_epoch: fenceEpoch },
  where: and_(eq("message_id", param("message_id")), ne("status", value("acked"))),
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
   * The instant stored on the row. Equal to the caller's clock unless it had
   * to be clamped -- see {@link clockClamped}.
   */
  readonly ackedAtMs: number;
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
    readonly ackedAtMs: number;
    readonly clockClamped: boolean;
  }) {
    this.messageId = options.messageId;
    this.recorded = options.recorded;
    this.ackedAtMs = options.ackedAtMs;
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
   *    `'delivered'`.
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
    if (message.status === "acked") {
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
   */
  recordAck(messageId: string, options: { readonly nowMs: number }): AckOutcome {
    const { nowMs } = options;
    const message = this.load(messageId);
    if (message.ackedAtMs !== null) {
      return new AckOutcome({
        messageId,
        recorded: false,
        ackedAtMs: message.ackedAtMs,
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

    const info = this._connection
      .prepare(
        `
                UPDATE outbox
                   SET status = 'acked', acked_at_ms = :acked_at_ms
                 WHERE message_id = :message_id AND acked_at_ms IS NULL
                `,
      )
      .run({ message_id: messageId, acked_at_ms: ackedAtMs });
    const recorded = info.changes === 1;

    if (!recorded) {
      // Another writer acked between the read and the write. Same answer
      // as a duplicate ack, which it is.
      const settled = this.load(messageId);
      // `||`, not `??`: the source's `settled.acked_at_ms or acked_at_ms` is a
      // Python truthiness test (D-0021 lesson: do not narrow `or` into `??`),
      // and `||` reproduces it exactly -- an `acked_at_ms` of `0` would fall
      // through to `ackedAtMs` under both, and neither runtime treats a
      // present zero specially here.
      return new AckOutcome({
        messageId,
        recorded: false,
        ackedAtMs: settled.ackedAtMs || ackedAtMs,
        clockClamped: false,
      });
    }

    return new AckOutcome({
      messageId,
      recorded: true,
      ackedAtMs,
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
   * Move the row to `'delivered'` once, fenced.
   *
   * Idempotent by predicate rather than by trigger-catching: a resend of an
   * already delivered message must leave the original delivery instant
   * alone, and S5's `outbox_delivery_is_set_once` would abort the whole
   * transaction if we tried to rewrite it.
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
    this._fenced(
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
  ): void {
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
    const attempt = (): void => {
      const info = this._connection
        .prepare(String.prototype.valueOf.call(statement) as string)
        .run(bound);
      if (info.changes >= 1) {
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
      return;
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
