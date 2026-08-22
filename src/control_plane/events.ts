import type { Database as SqliteDatabase } from "better-sqlite3";
import { resolveToleranceMs } from "./policy.js";
import { pythonJsonDumpsSorted } from "./python_json.js";
import { pythonRepr } from "./python_repr.js";
import { ControlPlaneRefusal } from "./refusals.js";
import { currentScope, refuseDeferredCallback, refuseDeferredResult, transaction } from "./txn.js";

/**
 * The event spine: one append transaction, and a drain that is per consumer.
 *
 * `#64` asks for a single spine -- a CI outcome is written once and every
 * consumer reads it from the same table -- and the design review found the
 * hole in that sentence: **"undrained" has no meaning until it is defined
 * per consumer.** With one `drained_at` column on `event`, the first
 * consumer to finish marks the row drained and hides every other
 * consumer's backlog. That is `tools/relay_scan.py`'s documented failure
 * reached through a different mechanism: 134 terminal events accumulating
 * undelivered for twenty days, with a scan that looked clean the whole time
 * because a silent no-op leaves nothing behind. So consumption is **fanned
 * out at append time**, one `event_consumption` row per (event, subscribed
 * consumer), and every drain quantity in this module takes a `consumerId`.
 * There is no global `undrained()` here and there deliberately never will
 * be -- see {@link backlogDepth}, {@link drainFrontier}, {@link
 * headOfLineAgeMs}.
 *
 * **The append is one transaction, and that is the property, not the
 * tidiness.** {@link appendEvent} implements `docs/production-schema.md`
 * section 5.4 and `D-0030`: insert the event, `SELECT` the subscribers
 * *inside the same transaction* so a concurrent subscription change cannot
 * interleave between the fan-out decision and the fan-out write, insert one
 * `pending` consumption row per subscriber, insert the `outbox` row for
 * each `delivery` subscriber and link it into that consumption, then run
 * the caller's typed side table insert. The whole thing commits or none of
 * it does. There is therefore no window in which an event exists with no
 * delivery record -- which is exactly the window v1's best-effort push and
 * relay scan existed to cover, two delivery paths because neither alone was
 * transactional with the fact. Here the enqueue *is* part of the append, so
 * the outbox is the only delivery path and the reconcile pass is a
 * backstop over the same rows rather than a second path.
 *
 * Two exactly-once steps, each naming its `ACCEPTANCE.md` section 2
 * mechanism: fact to enqueued is `transactional_with_record` (this module);
 * enqueued to delivered stays the outbox's `destination_idempotency_key`
 * and is not ours.
 *
 * **Duplicates are a no-op, not an error.** A producer that re-polls,
 * restarts mid-append or re-fetches the same page presents the same
 * `dedupKey`. That is the *normal* recovery path, so it returns
 * `AppendedEvent(duplicate=true)` rather than throwing: an at-least-once
 * producer over an idempotent append is the whole point of the
 * identity-uniqueness rule in section 4.2, which is what lets several
 * producers share one spine with no single-writer lease over the table.
 *
 * **Every settle is fenced.** `ACCEPTANCE.md` section 2 rules out the
 * check-then-write shape outright: the epoch is validated *inside* the
 * `UPDATE`, in the single-statement form `docs/lease-fencing.md` specifies,
 * and a zero-row result is {@link StaleConsumerRefused} rather than an
 * early return. A refusal that is reported as "nothing to do" is the
 * twenty-day failure again.
 *
 * **A skip must leave evidence.** `skipped` exists so a subscription a
 * consumer decides is inapplicable to a particular event settles
 * explicitly instead of sitting `pending` forever and being counted as
 * backlog. Section 5.3 requires the reason to travel in an event rather
 * than in `last_error` (a skip is not an error, and the `CHECK` on that
 * column enforces the distinction), so {@link markSkipped} appends
 * `consumption_skipped` **in the same transaction** as the settle. A
 * `skipped` row with no such event is unreachable through this module,
 * which is what keeps a skip distinguishable from a consumer quietly
 * dropping work.
 *
 * **This module implements the detection half of section 5.6, and only
 * that half.** Section 5.6's table is normative in both of its columns:
 * each pass has a detection ("what to look for") *and* an "on a hit" remedy
 * -- raise a `consumer_backlog` incident and re-attempt the failed rows;
 * re-attempt the orphaned outbox rows. {@link backloggedConsumers} and
 * {@link orphanedOutbox} are the detection half and are pure `SELECT`s that
 * take a `revisionId` the caller resolved. The remedy half belongs to the
 * reconcile-pass driver, which **does not exist in this branch**: nothing
 * in `src/` writes an `incident` row or re-attempts a delivery, so until
 * that driver is written these two functions have no caller in `src/` at
 * all. That is a scope boundary, not a claim that section 5.6 is satisfied
 * here.
 *
 * Splitting it this way is deliberate rather than merely convenient -- a
 * detector that acted would be writing under no lease and inflating the
 * very evidence an operator reads, and a pure `SELECT` can be run anywhere
 * at any frequency without deciding anything -- but the caller that owes
 * the other half is still owed. Neither function resolves a policy
 * revision for itself, because `D-0031`'s corollary makes an unbound
 * `policy_*` read a defect and a convenience default is how the binding
 * goes missing.
 *
 * Time is the caller's throughout. Every timestamp is an integer of epoch
 * milliseconds supplied as an argument; nothing here calls a clock and no
 * column this module writes has a `DEFAULT`. `ACCEPTANCE.md` section 2
 * injects clock skew across expiry boundaries, and a value the database
 * chose for itself makes that case untestable.
 */

/**
 * The event vocabulary **this implementation produces**. The DDL leaves
 * `event.event_type` open text on purpose -- a closed `CHECK` would make
 * every new producer a schema change, and section 4.2's writer rule for
 * the spine is identity uniqueness rather than a controlled vocabulary. So
 * this is not a schema constraint and nothing here validates against it;
 * it is the single place a reader can find out what G3/G4/G6 actually
 * emit, and what a subscription is worth subscribing to.
 *
 * A `ReadonlySet`, not a readonly tuple, for the same reason `THRESHOLD_KINDS`
 * in `policy.ts` is: every use is a membership check, which is the natural
 * operation on a Python `frozenset`.
 */
export const EVENT_TYPES: ReadonlySet<string> = new Set([
  "ci_observed",
  "pr_head_updated",
  "pr_merged",
  "pr_closed",
  "pr_reopened",
  "worker_escalation_raised",
  "gate_expired",
  "gate_closed",
  "consumption_skipped",
  "watcher_heartbeat_refused",
]);

/**
 * The fence every consumption settle carries, in the single-statement shape
 * `docs/lease-fencing.md` requires. It resolves the consumer's own
 * `lease_resource` rather than taking a resource argument, because the
 * binding of a consumer to the lease that authorises its settles is state,
 * not something a caller should be able to re-point per call.
 *
 * The holder is validated *transitively*: the `lease` trigger makes an
 * epoch strictly increasing and makes a change of holder raise it, so an
 * epoch that still matches the live row can only belong to the party that
 * took it. That is also why an epoch, and not an expiry, is what a write
 * validates -- under clock skew two claimants can overlap in true time,
 * but write authority cannot, because a takeover invalidates the old
 * token.
 */
export const CONSUMER_FENCE_SQL =
  "EXISTS (SELECT 1 FROM lease\n" +
  "                    JOIN consumer ON consumer.lease_resource = lease.resource\n" +
  "                   WHERE consumer.consumer_id = :consumer_id\n" +
  "                     AND lease.epoch = :writer_epoch\n" +
  "                     AND lease.expires_at_ms > :now_ms)";

/**
 * Key under which the consumers registered with `backfill=true` are
 * recorded in the current transaction's scope ({@link currentScope}).
 * Section 5.4's back-fill covers "a subscription added in the same
 * transaction" as the registration, so {@link subscribe} has to know
 * whether it is running inside its consumer's registration -- and *the
 * same* transaction, not merely some open one. The scope is created and
 * destroyed by the {@link transaction} block that owns the boundary, so
 * this note cannot outlive it and back-fill a subscription made in a later
 * transaction: that would manufacture a backlog nobody subscribed for and
 * nobody will drain.
 */
const BACKFILL_SCOPE_KEY = "events.registering_with_backfill";

/**
 * A spine operation was refused. Nothing was written past the refusal.
 *
 * In the {@link ControlPlaneRefusal} family because the answer is the same
 * one `R3` gives for a database that cannot be verified: refuse, and leave
 * the state exactly as it stood, rather than proceeding on a guess.
 */
export class EventSpineRefusal extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "EventSpineRefusal";
    Object.setPrototypeOf(this, EventSpineRefusal.prototype);
  }
}

/** One `event_consumption` row, exactly as it was found. */
export interface ConsumptionRow {
  readonly consumerId: string;
  readonly eventSeq: number;
  readonly status: string;
  readonly attemptCount: number;
  readonly messageId: string | null;
  readonly lastError: string | null;
  readonly writerEpoch: number | null;
  readonly createdAtMs: number;
  readonly settledAtMs: number | null;
}

/**
 * A consumption settle was refused: its fencing token was not live.
 *
 * Raised when the fenced `UPDATE` matched no row. The reachable causes are
 * a `writerEpoch` that is not the live epoch of the consumer's
 * `lease_resource`, a lease that has expired at the caller's own clock, a
 * consumption row that is already terminal (`consumed`/`skipped` are not
 * reopened), and a (consumer, event) pair that was never fanned out.
 *
 * It is a typed exception rather than a `false` on purpose: `ACCEPTANCE.md`
 * section 2 requires a stale writer to be *rejected, not merged*, and a
 * rejection returned as a falsy value is one an `if` nobody wrote will
 * swallow. {@link observed} carries the consumption row as it actually
 * stood, so the refusal can be diagnosed without a second query racing the
 * first. `undefined` (not the pair never having been fanned out) means the
 * row genuinely does not exist, matching `D-0007`'s "a row that does not
 * exist -> undefined".
 */
export class StaleConsumerRefused extends EventSpineRefusal {
  readonly observed: ConsumptionRow | undefined;

  constructor(
    message: string,
    options: { readonly observed?: ConsumptionRow | undefined; readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "StaleConsumerRefused";
    this.observed = options.observed;
    Object.setPrototypeOf(this, StaleConsumerRefused.prototype);
  }
}

/**
 * The caller used this module in a way that would break its guarantees.
 *
 * A programming error, not a runtime condition: a timestamp that is not an
 * integer of epoch milliseconds, an empty identity, a payload that is not
 * JSON. Raised before any statement runs, so a malformed call cannot land
 * a half-append and then fail a `CHECK` from inside the database.
 *
 * Deliberately **outside** the {@link EventSpineRefusal} hierarchy,
 * mirroring Python's `EventSpineUsageError(ValueError)` and this
 * repository's `PolicyUsageError` (`policy.ts`): it is a caller error, not
 * a spine fact stated about the data.
 */
export class EventSpineUsageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "EventSpineUsageError";
    Object.setPrototypeOf(this, EventSpineUsageError.prototype);
  }
}

/**
 * Internal: the `dedupKey` is already on the spine, so abandon the block.
 *
 * Thrown inside the append transaction so that {@link transaction} rolls
 * back everything the block had written, which is what makes a re-append
 * a genuine no-op rather than a partially applied one. Never escapes this
 * module.
 */
class DuplicateFact extends Error {
  readonly eventId: string;
  constructor(eventId: string) {
    super(eventId);
    this.eventId = eventId;
  }
}

/**
 * What one append did, as the append itself saw it.
 *
 * {@link AppendedEvent.seq} is `null` if and only if {@link
 * AppendedEvent.duplicate} is `true`: a duplicate append assigned no
 * sequence number because it wrote no row. {@link AppendedEvent.eventId}
 * then names the event that *does* hold the fact, which may differ from
 * the id the caller offered -- a producer that regenerates an id per poll
 * still collides on the `dedupKey`, and the useful answer is where the
 * fact already lives, not the id that was refused.
 *
 * {@link AppendedEvent.consumptions} and {@link AppendedEvent.messages}
 * are the fan-out made visible: the consumers given a `pending` row, and
 * the outbox rows enqueued for the `delivery` ones among them. Both are
 * empty for a duplicate.
 */
export interface AppendedEvent {
  readonly seq: number | null;
  readonly eventId: string;
  readonly duplicate: boolean;
  readonly consumptions: readonly string[];
  readonly messages: readonly string[];
}

// --------------------------------------------------------------------------
// argument validation -- refuse before writing, never inside a half-append
// --------------------------------------------------------------------------

/**
 * The observed `event_consumption` row as Python renders it in this refusal.
 *
 * The source interpolates `dict(observed)`, which prints the row as a Python
 * dict: single-quoted keys and string values, `None` for SQL NULL, and the
 * database's own **column names** in `SELECT` order. `JSON.stringify` gets all
 * three wrong -- double quotes, `null`, and this port's camelCase field names --
 * and the last one is the one that matters to a reader, because the message is
 * how an operator learns which row was in the way and they will go looking for
 * `writer_epoch`, not `writerEpoch`.
 *
 * D-0017 rule 3 (repr is written by hand, never `JSON.stringify`) and rule 4
 * (rows interpolated into messages get one renderer). The column order is the
 * source's `SELECT` order, not sorted: Python dicts keep insertion order.
 */
function renderConsumption(row: ConsumptionRow | undefined): string {
  if (row === undefined) {
    return "None";
  }
  const columns: readonly (readonly [string, unknown])[] = [
    ["consumer_id", row.consumerId],
    ["event_seq", row.eventSeq],
    ["status", row.status],
    ["attempt_count", row.attemptCount],
    ["message_id", row.messageId],
    ["last_error", row.lastError],
    ["writer_epoch", row.writerEpoch],
    ["created_at_ms", row.createdAtMs],
    ["settled_at_ms", row.settledAtMs],
  ];
  return `{${columns.map(([name, value]) => `'${name}': ${pythonRepr(value)}`).join(", ")}}`;
}

function requireIdentifier(field: string, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EventSpineUsageError(`${field} must be a non-empty string, got ${pythonRepr(value)}`);
  }
}

function requireEpochMs(field: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new EventSpineUsageError(
      `${field} must be an int of epoch milliseconds, got ${pythonRepr(value)}`,
    );
  }
}

function requirePositiveEpoch(field: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new EventSpineUsageError(`${field} must be a positive int, got ${pythonRepr(value)}`);
  }
}

function requireJson(field: string, value: string): string {
  try {
    JSON.parse(value);
  } catch (error) {
    // `cause` carries the parse error, because the source chains it
    // (`raise EventSpineUsageError(...) from error`) and a caller debugging a
    // rejected payload wants the decoder's own position information, which the
    // summary line above does not carry.
    throw new EventSpineUsageError(
      `${field} must be a JSON document; the payload column has a json_valid ` +
        `CHECK and would refuse this (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
  return value;
}

// --------------------------------------------------------------------------
// append
// --------------------------------------------------------------------------

/**
 * The (consumerId, kind, recipient) triples subscribed to `eventType`.
 *
 * Read inside the append transaction, never before it. A subscription with
 * `removed_at_ms` set is not a subscription and a consumer with
 * `retired_at_ms` set is not a consumer: both are kept as rows because the
 * fan-out history has to stay explicable, and both are excluded here
 * because fanning out to them would manufacture a backlog nobody will ever
 * drain.
 */
function subscribers(
  connection: SqliteDatabase,
  eventType: string,
): readonly (readonly [consumerId: string, kind: string, recipient: string | null])[] {
  const rows = connection
    .prepare<
      { event_type: string },
      { consumer_id: string; kind: string; recipient: string | null }
    >(
      `
        SELECT s.consumer_id, c.kind, s.recipient
          FROM consumer_subscription s
          JOIN consumer c ON c.consumer_id = s.consumer_id
         WHERE s.event_type = :event_type
           AND s.removed_at_ms IS NULL
           AND c.retired_at_ms IS NULL
         ORDER BY s.consumer_id
        `,
    )
    .all({ event_type: eventType });
  return rows.map((row) => [row.consumer_id, row.kind, row.recipient] as const);
}

/**
 * Insert one consumption row per subscriber, plus the delivery outbox rows.
 *
 * The outbox row's `dedup_key` and `message_id` are the same string,
 * `event/<eventId>/<consumerId>`, which section 5.4 fixes. Making the
 * primary key carry the identity is what makes the enqueue idempotent
 * under a retry of the whole append: a second attempt collides on the key
 * rather than enqueuing a second copy of one delivery. `outbox.dedup_key`
 * stays deliberately non-unique for hand-enqueued messages; uniqueness
 * here comes from the message id, not from that column.
 */
function fanOut(
  connection: SqliteDatabase,
  options: {
    readonly seq: number;
    readonly eventId: string;
    readonly eventType: string;
    readonly runId: string | null;
    readonly payload: string;
    readonly createdAtMs: number;
    readonly deliveryPayload?: ((consumerId: string, recipient: string) => string) | undefined;
  },
): { readonly consumptions: readonly string[]; readonly messages: readonly string[] } {
  const { seq, eventId, eventType, runId, payload, createdAtMs, deliveryPayload } = options;
  const consumptions: string[] = [];
  const messages: string[] = [];

  for (const [consumerId, kind, recipient] of subscribers(connection, eventType)) {
    let messageId: string | null = null;
    if (kind === "delivery") {
      messageId = `event/${eventId}/${consumerId}`;
      let body = payload;
      if (deliveryPayload !== undefined) {
        body = requireJson("delivery_payload(...)", deliveryPayload(consumerId, recipient ?? ""));
      }
      connection
        .prepare<{
          message_id: string;
          run_id: string | null;
          recipient: string | null;
          payload: string;
          dedup_key: string | null;
          enqueued_at_ms: number;
        }>(
          `
                INSERT INTO outbox (message_id, run_id, recipient, payload, dedup_key,
                                    status, retry_count, enqueued_at_ms)
                VALUES (:message_id, :run_id, :recipient, :payload, :dedup_key,
                        'pending', 0, :enqueued_at_ms)
                `,
        )
        .run({
          message_id: messageId,
          run_id: runId,
          recipient,
          payload: body,
          dedup_key: messageId,
          enqueued_at_ms: createdAtMs,
        });
      messages.push(messageId);
    }
    connection
      .prepare<{
        consumer_id: string;
        event_seq: number;
        message_id: string | null;
        created_at_ms: number;
      }>(
        `
            INSERT INTO event_consumption (consumer_id, event_seq, status, attempt_count,
                                           message_id, created_at_ms)
            VALUES (:consumer_id, :event_seq, 'pending', 0, :message_id, :created_at_ms)
            `,
      )
      .run({
        consumer_id: consumerId,
        event_seq: seq,
        message_id: messageId,
        created_at_ms: createdAtMs,
      });
    consumptions.push(consumerId);
  }
  return { consumptions: Object.freeze(consumptions), messages: Object.freeze(messages) };
}

/**
 * Steps 1-5 of section 5.4, with the transaction assumed to be open.
 *
 * Split out from {@link appendEvent} so that {@link markSkipped} can put a
 * settle and this append in **one** transaction. The duplicate check is a
 * `SELECT` rather than a caught constraint violation because the
 * transaction already holds the write lock (`BEGIN IMMEDIATE`), so no
 * other writer can interleave between the read and the insert -- and
 * because a `UNIQUE` violation on `event_id` with a *different*
 * `dedup_key` is a producer bug that must surface, not a duplicate fact
 * that must be swallowed.
 */
function appendWithinTransaction(
  connection: SqliteDatabase,
  options: {
    readonly eventId: string;
    readonly eventType: string;
    readonly subjectKind: string;
    readonly subjectId: string;
    readonly dedupKey: string;
    readonly producer: string;
    readonly occurredAtMs: number;
    readonly ingestedAtMs: number;
    readonly runId: string | null;
    readonly producerEpoch: number | null;
    readonly payload: string;
    readonly sideEffect?: ((connection: SqliteDatabase, seq: number) => void) | undefined;
    readonly deliveryPayload?: ((consumerId: string, recipient: string) => string) | undefined;
  },
): AppendedEvent {
  const {
    eventId,
    eventType,
    subjectKind,
    subjectId,
    dedupKey,
    producer,
    occurredAtMs,
    ingestedAtMs,
    runId,
    producerEpoch,
    payload,
    sideEffect,
    deliveryPayload,
  } = options;

  const existing = connection
    .prepare<{ dedup_key: string }, { event_id: string }>(
      "SELECT event_id FROM event WHERE dedup_key = :dedup_key",
    )
    .get({ dedup_key: dedupKey });
  if (existing !== undefined) {
    throw new DuplicateFact(existing.event_id);
  }

  const cursor = connection
    .prepare<{
      event_id: string;
      event_type: string;
      subject_kind: string;
      subject_id: string;
      run_id: string | null;
      payload: string;
      producer: string;
      producer_epoch: number | null;
      dedup_key: string;
      occurred_at_ms: number;
      ingested_at_ms: number;
    }>(
      `
        INSERT INTO event (event_id, event_type, subject_kind, subject_id, run_id, payload,
                           producer, producer_epoch, dedup_key, occurred_at_ms, ingested_at_ms)
        VALUES (:event_id, :event_type, :subject_kind, :subject_id, :run_id, :payload,
                :producer, :producer_epoch, :dedup_key, :occurred_at_ms, :ingested_at_ms)
        `,
    )
    .run({
      event_id: eventId,
      event_type: eventType,
      subject_kind: subjectKind,
      subject_id: subjectId,
      run_id: runId,
      payload,
      producer,
      producer_epoch: producerEpoch,
      dedup_key: dedupKey,
      occurred_at_ms: occurredAtMs,
      ingested_at_ms: ingestedAtMs,
    });
  const seq = Number(cursor.lastInsertRowid);

  const { consumptions, messages } = fanOut(connection, {
    seq,
    eventId,
    eventType,
    runId,
    payload,
    createdAtMs: ingestedAtMs,
    deliveryPayload,
  });

  // Last, so that a side table which refuses the fact takes the event down
  // with it: the typed row and the spine row are one fact recorded twice,
  // and a spine that carries a ci_observation nobody could insert is a
  // projection that silently disagrees with its source.
  if (sideEffect !== undefined) {
    // Guarded like `transaction()`'s own body, and for the same reason
    // (D-0103): this callback runs INSIDE the append transaction, so a
    // deferred one would return at its first `await` having written nothing,
    // the append would COMMIT, and the side-table row that is supposed to be
    // this same fact recorded twice would land afterwards or not at all. That
    // is precisely the spine-disagrees-with-its-projection state the call
    // ordering here exists to prevent. The hazard is the callback
    // translation's -- Python's `side_effect` is a plain callable.
    refuseDeferredCallback("side_effect", sideEffect);
    refuseDeferredResult("side_effect", sideEffect(connection, seq));
  }

  return Object.freeze({
    seq,
    eventId,
    duplicate: false,
    consumptions,
    messages,
  });
}

/**
 * Append one event, fan it out, and enqueue its deliveries. One
 * transaction.
 *
 * Section 5.4 in order: the event, the subscriber `SELECT` inside this
 * same transaction, a `pending` `event_consumption` row per subscriber, an
 * `outbox` row linked into that consumption for every `delivery`
 * subscriber, and finally `sideEffect` for the typed side table (`#64`'s
 * `ci_observation`, `#65`'s escalation row) with the `seq` it must point
 * at. Anything that throws anywhere in there leaves no event, no
 * consumption and no outbox row -- the all-or-nothing is the point, not
 * the tidiness.
 *
 * `occurredAtMs` is the source clock, as the provider reports the observed
 * thing happening; `ingestedAtMs` is ours, and is also what the
 * consumption and outbox rows are stamped with. `time-base-policy.md`
 * section 2 decides which of the two each tolerance is measured against,
 * and conflating them is how a provider's clock ends up deciding whether
 * we are late.
 *
 * `deliveryPayload` renders each delivery's body from `(consumerId,
 * recipient)`; without it the event's own payload is delivered verbatim.
 * It exists because one event legitimately reaches two recipients in two
 * shapes, and re-appending the event per recipient would put two rows on
 * the spine for one fact.
 *
 * A `dedupKey` already on the spine returns
 * `AppendedEvent(seq=null, duplicate=true)` and writes nothing -- no
 * second consumption row for anyone. That is an idempotent no-op rather
 * than an error because it is the ordinary shape of a producer that
 * re-polls or restarts mid-append.
 *
 * @throws {EventSpineUsageError} for a malformed argument, before any
 *   write.
 * @throws if `eventId` collides while `dedupKey` does not (a SQLite
 *   `UNIQUE` violation), which is a producer reusing an identity for a
 *   second fact.
 */
export function appendEvent(
  connection: SqliteDatabase,
  options: {
    readonly eventId: string;
    readonly eventType: string;
    readonly subjectKind: string;
    readonly subjectId: string;
    readonly dedupKey: string;
    readonly producer: string;
    readonly occurredAtMs: number;
    readonly ingestedAtMs: number;
    readonly runId?: string | null;
    readonly producerEpoch?: number | null;
    readonly payload?: string | null;
    readonly sideEffect?: (connection: SqliteDatabase, seq: number) => void;
    readonly deliveryPayload?: (consumerId: string, recipient: string) => string;
  },
): AppendedEvent {
  const {
    eventId,
    eventType,
    subjectKind,
    subjectId,
    dedupKey,
    producer,
    occurredAtMs,
    ingestedAtMs,
    runId = null,
    producerEpoch = null,
    payload = null,
    sideEffect,
    deliveryPayload,
  } = options;

  for (const [field, value] of [
    ["event_id", eventId],
    ["event_type", eventType],
    ["subject_kind", subjectKind],
    ["subject_id", subjectId],
    ["dedup_key", dedupKey],
    ["producer", producer],
  ] as const) {
    requireIdentifier(field, value);
  }
  requireEpochMs("occurred_at_ms", occurredAtMs);
  requireEpochMs("ingested_at_ms", ingestedAtMs);
  if (producerEpoch !== null) {
    requirePositiveEpoch("producer_epoch", producerEpoch);
  }
  const body = payload !== null ? requireJson("payload", payload) : "{}";

  try {
    return transaction(connection, (tx) =>
      appendWithinTransaction(tx, {
        eventId,
        eventType,
        subjectKind,
        subjectId,
        dedupKey,
        producer,
        occurredAtMs,
        ingestedAtMs,
        runId,
        producerEpoch,
        payload: body,
        sideEffect,
        deliveryPayload,
      }),
    );
  } catch (error) {
    if (error instanceof DuplicateFact) {
      return Object.freeze({
        seq: null,
        eventId: error.eventId,
        duplicate: true,
        consumptions: Object.freeze([]),
        messages: Object.freeze([]),
      });
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// registration and subscription
// --------------------------------------------------------------------------

/**
 * Register a consumer of the spine, optionally back-filling its history.
 *
 * `registeredFromSeq` is the watershed: without `backfill` it is a
 * recorded statement that this consumer is not responsible for anything at
 * or below that sequence, and with it the same number decides what gets
 * back-filled. Section 5.4's last bullet is the reason it is a number in a
 * column rather than an omission -- "the decision is made once and is
 * visible in the rows, never as a gap that someone later has to explain."
 *
 * A consumer registered *after* an append never receives that append. Late
 * registration does not retroactively fan out, because the fan-out
 * decision was taken and committed inside the append's own transaction.
 *
 * Back-fill covers events matching a subscription **added in the same
 * transaction as this registration**, which is what section 5.4 specifies.
 * In practice that is:
 *
 * ```ts
 * transaction(connection, (tx) => {
 *   registerConsumer(tx, { consumerId, kind, leaseResource, registeredAtMs,
 *                          registeredFromSeq: 0, backfill: true });
 *   subscribe(tx, { consumerId, eventType: "ci_observed", addedAtMs: t });
 * });
 * ```
 *
 * A subscription added in a *later* transaction gets no history, and that
 * is the same rule stated from the other side: the decision belongs to one
 * transaction, and one only.
 *
 * @throws {EventSpineUsageError} for a malformed argument.
 * @throws if `consumerId` is already registered (a SQLite `UNIQUE`
 *   violation). A second registration is not an idempotent retry -- it
 *   would silently redecide `registeredFromSeq` and the back-fill that
 *   hangs off it.
 */
export function registerConsumer(
  connection: SqliteDatabase,
  options: {
    readonly consumerId: string;
    readonly kind: string;
    readonly leaseResource: string;
    readonly registeredAtMs: number;
    readonly registeredFromSeq: number;
    readonly backfill?: boolean;
  },
): void {
  const {
    consumerId,
    kind,
    leaseResource,
    registeredAtMs,
    registeredFromSeq,
    backfill = false,
  } = options;

  requireIdentifier("consumer_id", consumerId);
  requireIdentifier("lease_resource", leaseResource);
  if (kind !== "delivery" && kind !== "compute") {
    throw new EventSpineUsageError(
      `kind must be 'delivery' or 'compute', got ${pythonRepr(kind)}; the column has ` +
        "a CHECK and the two kinds differ in whether consumption IS a delivery",
    );
  }
  requireEpochMs("registered_at_ms", registeredAtMs);
  if (typeof registeredFromSeq !== "number" || !Number.isInteger(registeredFromSeq)) {
    throw new EventSpineUsageError(
      `registered_from_seq must be an int, got ${pythonRepr(registeredFromSeq)}`,
    );
  }
  if (registeredFromSeq < 0) {
    throw new EventSpineUsageError("registered_from_seq must not be negative");
  }

  transaction(connection, (tx) => {
    tx.prepare<{
      consumer_id: string;
      kind: string;
      lease_resource: string;
      registered_at_ms: number;
      registered_from_seq: number;
    }>(
      `
            INSERT INTO consumer (consumer_id, kind, lease_resource, registered_at_ms,
                                  registered_from_seq)
            VALUES (:consumer_id, :kind, :lease_resource, :registered_at_ms,
                    :registered_from_seq)
            `,
    ).run({
      consumer_id: consumerId,
      kind,
      lease_resource: leaseResource,
      registered_at_ms: registeredAtMs,
      registered_from_seq: registeredFromSeq,
    });
    if (backfill) {
      // Subscriptions cannot pre-exist a consumer (the FK forbids it), so
      // the note only matters when the caller has joined an outer
      // transaction and subscribes below; the scope is what carries the
      // decision across to subscribe() without leaving the transaction,
      // and it dies with the transaction that made it. `undefined` only
      // when the caller began a transaction by hand instead of through
      // transaction(), which no control-plane module does; the note is
      // then not carried at all -- a forward-only subscription, which is
      // the safe way to be wrong.
      const scope = currentScope(tx);
      if (scope !== undefined) {
        const set = (scope[BACKFILL_SCOPE_KEY] as Set<string> | undefined) ?? new Set<string>();
        set.add(consumerId);
        scope[BACKFILL_SCOPE_KEY] = set;
      }
      const eventTypes = tx
        .prepare<{ consumer_id: string }, { event_type: string }>(
          "SELECT event_type FROM consumer_subscription " +
            "WHERE consumer_id = :consumer_id AND removed_at_ms IS NULL",
        )
        .all({ consumer_id: consumerId })
        .map((row) => row.event_type);
      backfillConsumer(tx, {
        consumerId,
        eventTypes,
        fromSeq: registeredFromSeq,
        createdAtMs: registeredAtMs,
      });
    }
  });
}

/**
 * Insert `pending` rows for the history a late registration asked for.
 *
 * `INSERT OR IGNORE` because the same registration transaction may reach
 * an event through two of its subscriptions; the primary key is
 * (consumerId, eventSeq) and a consumption row is per event, not per
 * subscription.
 *
 * No outbox row is written even for a `delivery` consumer. A back-fill is
 * a request to *catch up on history*, and history that is materialised as
 * fresh deliveries would re-send every past event to a recipient that
 * has, by construction, already been told about them by whoever was
 * subscribed at the time. The consumption row records the obligation;
 * whether it is discharged by a resend or by {@link markSkipped} is the
 * consumer's decision to make and to leave evidence of.
 */
function backfillConsumer(
  connection: SqliteDatabase,
  options: {
    readonly consumerId: string;
    readonly eventTypes: readonly string[];
    readonly fromSeq: number;
    readonly createdAtMs: number;
  },
): void {
  const { consumerId, eventTypes, fromSeq, createdAtMs } = options;
  const statement = connection.prepare<{
    consumer_id: string;
    created_at_ms: number;
    from_seq: number;
    event_type: string;
  }>(
    `
        INSERT OR IGNORE INTO event_consumption
            (consumer_id, event_seq, status, attempt_count, created_at_ms)
        SELECT :consumer_id, e.seq, 'pending', 0, :created_at_ms
          FROM event e
         WHERE e.seq > :from_seq AND e.event_type = :event_type
        `,
  );
  for (const eventType of eventTypes) {
    statement.run({
      consumer_id: consumerId,
      created_at_ms: createdAtMs,
      from_seq: fromSeq,
      event_type: eventType,
    });
  }
}

/**
 * Subscribe `consumerId` to `eventType`, from the next append onward.
 *
 * `recipient` is required for a `delivery` consumer and forbidden for a
 * `compute` one; the schema enforces that with a trigger rather than a
 * `CHECK` because it is a cross-table invariant, and it refuses **here**
 * rather than later inside the append transaction of the next matching
 * event -- which would take that event down with it and hand the failure
 * to a party who cannot fix it.
 *
 * If this call is running inside the transaction that registered
 * `consumerId` with `backfill: true`, the events already on the spine
 * above the consumer's `registeredFromSeq` are back-filled as `pending`
 * in the same transaction. Outside that transaction the subscription is
 * forward-only.
 *
 * @throws {EventSpineUsageError} for a malformed argument.
 * @throws from the recipient/kind trigger, or if this consumer already has
 *   a row for `eventType`.
 */
export function subscribe(
  connection: SqliteDatabase,
  options: {
    readonly consumerId: string;
    readonly eventType: string;
    readonly recipient?: string | null;
    readonly addedAtMs: number;
  },
): void {
  const { consumerId, eventType, recipient = null, addedAtMs } = options;

  requireIdentifier("consumer_id", consumerId);
  requireIdentifier("event_type", eventType);
  if (recipient !== null) {
    requireIdentifier("recipient", recipient);
  }
  requireEpochMs("added_at_ms", addedAtMs);

  transaction(connection, (tx) => {
    // Read inside the block: outside it there is no scope to read, and a
    // scope read before the block could be a *previous* transaction's.
    const scope = currentScope(tx);
    const backfillSet = scope?.[BACKFILL_SCOPE_KEY] as Set<string> | undefined;
    const backfilling = backfillSet?.has(consumerId) ?? false;

    tx.prepare<{
      consumer_id: string;
      event_type: string;
      recipient: string | null;
      added_at_ms: number;
    }>(
      `
            INSERT INTO consumer_subscription (consumer_id, event_type, recipient, added_at_ms)
            VALUES (:consumer_id, :event_type, :recipient, :added_at_ms)
            `,
    ).run({ consumer_id: consumerId, event_type: eventType, recipient, added_at_ms: addedAtMs });

    if (backfilling) {
      // Unreachable with `undefined`: backfilling is only true when this
      // consumer_id was registered in this same transaction, so the FK it
      // relies on already guarantees the row exists.
      const registeredFromSeq = tx
        .prepare<{ consumer_id: string }>(
          "SELECT registered_from_seq FROM consumer WHERE consumer_id = :consumer_id",
        )
        .pluck()
        .get({ consumer_id: consumerId });
      // The source reads this as `int(row[0])` on a `fetchone()`, so an absent
      // consumer row raises there ("'NoneType' object is not subscriptable")
      // rather than being tolerated. Casting to `number` instead would make it
      // `undefined`, `Number(undefined)` is `NaN`, and `WHERE e.seq > NaN`
      // matches nothing -- so a missing consumer would back-fill zero events
      // silently and report success. The foreign key makes it unreachable; the
      // point is that if it ever were reached it fails the way the source does.
      if (typeof registeredFromSeq !== "number") {
        throw new TypeError(
          `consumer ${pythonRepr(consumerId)} has no row to back-fill from, ` +
            "which the foreign key should have made impossible",
        );
      }
      backfillConsumer(tx, {
        consumerId,
        eventTypes: [eventType],
        fromSeq: Number(registeredFromSeq),
        createdAtMs: addedAtMs,
      });
    }
  });
}

/**
 * Stop fanning `eventType` out to `consumerId`, from the next append on.
 *
 * A mark, never a delete: the row is how a later reader explains why this
 * consumer has consumption rows for events up to a point and none after
 * it. Consumption rows already fanned out are untouched -- they are
 * obligations that were taken on, and dropping them on unsubscribe would
 * let a consumer make its own backlog disappear.
 *
 * @throws {EventSpineUsageError} for a malformed argument or a
 *   subscription that is not there to remove -- a no-op unsubscribe would
 *   report success for a fan-out that is still happening.
 */
export function unsubscribe(
  connection: SqliteDatabase,
  options: {
    readonly consumerId: string;
    readonly eventType: string;
    readonly removedAtMs: number;
  },
): void {
  const { consumerId, eventType, removedAtMs } = options;

  requireIdentifier("consumer_id", consumerId);
  requireIdentifier("event_type", eventType);
  requireEpochMs("removed_at_ms", removedAtMs);

  transaction(connection, (tx) => {
    const cursor = tx
      .prepare<{ consumer_id: string; event_type: string; removed_at_ms: number }>(
        `
            UPDATE consumer_subscription
               SET removed_at_ms = :removed_at_ms
             WHERE consumer_id = :consumer_id
               AND event_type = :event_type
               AND removed_at_ms IS NULL
            `,
      )
      .run({ consumer_id: consumerId, event_type: eventType, removed_at_ms: removedAtMs });
    if (cursor.changes === 0) {
      throw new EventSpineUsageError(
        `${pythonRepr(consumerId)} has no live subscription to ${pythonRepr(eventType)} to remove`,
      );
    }
  });
}

// --------------------------------------------------------------------------
// settling a consumption -- fenced, and never a silent no-op
// --------------------------------------------------------------------------

function readConsumption(
  connection: SqliteDatabase,
  options: { readonly consumerId: string; readonly eventSeq: number },
): ConsumptionRow | undefined {
  const row = connection
    .prepare<
      { consumer_id: string; event_seq: number },
      {
        consumer_id: string;
        event_seq: number;
        status: string;
        attempt_count: number;
        message_id: string | null;
        last_error: string | null;
        writer_epoch: number | null;
        created_at_ms: number;
        settled_at_ms: number | null;
      }
    >(
      `
        SELECT consumer_id, event_seq, status, attempt_count, message_id, last_error,
               writer_epoch, created_at_ms, settled_at_ms
          FROM event_consumption
         WHERE consumer_id = :consumer_id AND event_seq = :event_seq
        `,
    )
    .get({ consumer_id: options.consumerId, event_seq: options.eventSeq });
  if (row === undefined) {
    return undefined;
  }
  return Object.freeze({
    consumerId: row.consumer_id,
    eventSeq: Number(row.event_seq),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    messageId: row.message_id,
    lastError: row.last_error,
    writerEpoch: row.writer_epoch === null ? null : Number(row.writer_epoch),
    createdAtMs: Number(row.created_at_ms),
    settledAtMs: row.settled_at_ms === null ? null : Number(row.settled_at_ms),
  });
}

/**
 * Run one fenced settle statement, or throw {@link StaleConsumerRefused}.
 *
 * The fence is part of the `UPDATE`'s own predicate, so there is no
 * instant between deciding the token is live and using it. A zero
 * `changes` count is the refusal; it is never returned as a value,
 * because the caller that forgets to inspect a returned `false` is
 * exactly how a stale writer's work gets merged instead of rejected.
 */
function settle(
  connection: SqliteDatabase,
  options: {
    readonly sql: string;
    readonly params: Record<string, unknown>;
    readonly consumerId: string;
    readonly eventSeq: number;
    readonly writerEpoch: number;
    readonly what: string;
  },
): void {
  const { sql, params, consumerId, eventSeq, writerEpoch, what } = options;
  const cursor = connection.prepare(sql).run(params);
  if (cursor.changes === 0) {
    const observed = readConsumption(connection, { consumerId, eventSeq });
    throw new StaleConsumerRefused(
      `${what} refused for consumer ${pythonRepr(consumerId)} at event seq ${eventSeq}: ` +
        `epoch ${writerEpoch} is not the live epoch of the consumer's lease, ` +
        "the lease has expired at the caller's clock, or the consumption is " +
        `already settled (observed: ${renderConsumption(observed)})`,
      { observed },
    );
  }
}

/**
 * Settle one consumption as `consumed`, under the consumer's fence.
 *
 * Terminal: the schema's `event_consumption_settled_is_terminal` trigger
 * refuses to reopen it, and this statement will not match it again
 * either. A correction is a new event, not an edit -- the drain evidence
 * is what the reconcile pass and the measurement harness are read out of,
 * and evidence that can be rewritten is not evidence.
 *
 * `last_error` is cleared because `consumed` and a recorded error cannot
 * both be true -- the `CHECK` states it as an equality -- and a retry
 * that finally lands must not leave the failure that preceded it looking
 * current. The durable trace of that failure is `attempt_count`, which
 * this raises.
 *
 * `settledAtMs` is the caller's clock and doubles as the instant the
 * lease's liveness is evaluated at, since there is no other clock in the
 * call.
 *
 * @throws {StaleConsumerRefused} if the fenced `UPDATE` matched no row.
 */
export function markConsumed(
  connection: SqliteDatabase,
  options: {
    readonly consumerId: string;
    readonly eventSeq: number;
    readonly writerEpoch: number;
    readonly settledAtMs: number;
  },
): void {
  const { consumerId, eventSeq, writerEpoch, settledAtMs } = options;

  requireIdentifier("consumer_id", consumerId);
  requirePositiveEpoch("writer_epoch", writerEpoch);
  requireEpochMs("settled_at_ms", settledAtMs);

  transaction(connection, (tx) => {
    settle(tx, {
      sql: `
            UPDATE event_consumption
               SET status = 'consumed',
                   settled_at_ms = :settled_at_ms,
                   writer_epoch = :writer_epoch,
                   attempt_count = attempt_count + 1,
                   last_error = NULL
             WHERE consumer_id = :consumer_id
               AND event_seq = :event_seq
               AND status IN ('pending', 'failed')
               AND ${CONSUMER_FENCE_SQL}
            `,
      params: {
        consumer_id: consumerId,
        event_seq: eventSeq,
        writer_epoch: writerEpoch,
        settled_at_ms: settledAtMs,
        now_ms: settledAtMs,
      },
      consumerId,
      eventSeq,
      writerEpoch,
      what: "mark_consumed",
    });
  });
}

/**
 * Record a failed attempt on one consumption. Retryable, **not** terminal.
 *
 * `failed` is the durable trace of an attempt that did not land, which is
 * what distinguishes a stalled consumer from a quiet one; it stays
 * *undrained* and the reconcile pass re-attempts it. It is deliberately
 * not a settle: `settled_at_ms` stays `NULL` and the row keeps counting
 * against {@link backlogDepth} and {@link headOfLineAgeMs}, so a consumer
 * cannot make its own backlog disappear by failing.
 *
 * @throws {StaleConsumerRefused} if the fenced `UPDATE` matched no row.
 */
export function markFailed(
  connection: SqliteDatabase,
  options: {
    readonly consumerId: string;
    readonly eventSeq: number;
    readonly writerEpoch: number;
    readonly lastError: string;
    readonly nowMs: number;
  },
): void {
  const { consumerId, eventSeq, writerEpoch, lastError, nowMs } = options;

  requireIdentifier("consumer_id", consumerId);
  requireIdentifier("last_error", lastError);
  requirePositiveEpoch("writer_epoch", writerEpoch);
  requireEpochMs("now_ms", nowMs);

  transaction(connection, (tx) => {
    settle(tx, {
      sql: `
            UPDATE event_consumption
               SET status = 'failed',
                   last_error = :last_error,
                   writer_epoch = :writer_epoch,
                   attempt_count = attempt_count + 1
             WHERE consumer_id = :consumer_id
               AND event_seq = :event_seq
               AND status IN ('pending', 'failed')
               AND ${CONSUMER_FENCE_SQL}
            `,
      params: {
        consumer_id: consumerId,
        event_seq: eventSeq,
        writer_epoch: writerEpoch,
        last_error: lastError,
        now_ms: nowMs,
      },
      consumerId,
      eventSeq,
      writerEpoch,
      what: "mark_failed",
    });
  });
}

/**
 * Settle one consumption as `skipped` and append its audit event. Atomic.
 *
 * Section 5.3: a skip must append `consumption_skipped` **in the same
 * transaction** as the settle, because a `skipped` row with no recorded
 * reason is indistinguishable from a consumer quietly dropping work. The
 * reason travels in the appended event's payload and not in `last_error`
 * -- a skip is not an error, and the column's `CHECK` ties `last_error` to
 * the `failed` status precisely so the two cannot be conflated.
 *
 * The appended event carries the **original** event's `subjectKind` and
 * `subjectId`. The closed `subject_kind` `CHECK` has no `consumer`
 * member, and inventing one to make a skip its own subject would be a
 * schema change smuggled in through an audit record; the skip is a fact
 * *about* the original subject, and the consumer is named in the payload
 * and the `dedupKey`.
 *
 * `eventId` and `ingestedAtMs` belong to that appended event. Its
 * `dedupKey` is `consumption_skipped/<consumerId>/<eventSeq>`, so a
 * retried skip cannot put a second audit row on the spine -- though it
 * will not get that far, because the settle refuses a consumption that is
 * already terminal.
 *
 * @throws {StaleConsumerRefused} if the fenced `UPDATE` matched no row.
 *   Nothing is appended: the skip and its evidence share one transaction,
 *   so a skip without the event is unreachable.
 */
export function markSkipped(
  connection: SqliteDatabase,
  options: {
    readonly consumerId: string;
    readonly eventSeq: number;
    readonly writerEpoch: number;
    readonly reason: string;
    readonly settledAtMs: number;
    readonly eventId: string;
    readonly ingestedAtMs: number;
  },
): AppendedEvent {
  const { consumerId, eventSeq, writerEpoch, reason, settledAtMs, eventId, ingestedAtMs } = options;

  requireIdentifier("consumer_id", consumerId);
  requireIdentifier("reason", reason);
  requireIdentifier("event_id", eventId);
  requirePositiveEpoch("writer_epoch", writerEpoch);
  requireEpochMs("settled_at_ms", settledAtMs);
  requireEpochMs("ingested_at_ms", ingestedAtMs);

  try {
    return transaction(connection, (tx) => {
      settle(tx, {
        sql: `
                UPDATE event_consumption
                   SET status = 'skipped',
                       settled_at_ms = :settled_at_ms,
                       writer_epoch = :writer_epoch,
                       last_error = NULL
                 WHERE consumer_id = :consumer_id
                   AND event_seq = :event_seq
                   AND status IN ('pending', 'failed')
                   AND ${CONSUMER_FENCE_SQL}
                `,
        params: {
          consumer_id: consumerId,
          event_seq: eventSeq,
          writer_epoch: writerEpoch,
          settled_at_ms: settledAtMs,
          now_ms: settledAtMs,
        },
        consumerId,
        eventSeq,
        writerEpoch,
        what: "mark_skipped",
      });
      const original = tx
        .prepare<
          { seq: number },
          { event_id: string; subject_kind: string; subject_id: string; run_id: string | null }
        >("SELECT event_id, subject_kind, subject_id, run_id FROM event WHERE seq = :seq")
        .get({ seq: eventSeq });
      if (original === undefined) {
        // Unreachable: the FK on event_consumption.event_seq makes this
        // impossible to reach through this module.
        throw new EventSpineUsageError(
          `event seq ${eventSeq} does not exist, so a skip of it cannot be recorded`,
        );
      }
      return appendWithinTransaction(tx, {
        eventId,
        eventType: "consumption_skipped",
        subjectKind: original.subject_kind,
        subjectId: original.subject_id,
        dedupKey: `consumption_skipped/${consumerId}/${eventSeq}`,
        producer: consumerId,
        occurredAtMs: settledAtMs,
        ingestedAtMs,
        runId: original.run_id,
        producerEpoch: writerEpoch,
        payload: pythonJsonDumpsSorted({
          consumer_id: consumerId,
          skipped_event_seq: eventSeq,
          skipped_event_id: original.event_id,
          reason,
        }),
        sideEffect: undefined,
        deliveryPayload: undefined,
      });
    });
  } catch (error) {
    // Unreachable in practice -- the settle above refuses first -- kept for
    // structural fidelity with the source's own try/except around this
    // same call.
    if (error instanceof DuplicateFact) {
      return Object.freeze({
        seq: null,
        eventId: error.eventId,
        duplicate: true,
        consumptions: Object.freeze([]),
        messages: Object.freeze([]),
      });
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// drain -- section 5.5. Every one of these takes a consumerId, and that is
// the design, not an ergonomic accident.
// --------------------------------------------------------------------------

/** One `event_consumption` row joined to the `event` it belongs to. */
export interface UndrainedRow {
  readonly consumerId: string;
  readonly eventSeq: number;
  readonly status: string;
  readonly attemptCount: number;
  readonly messageId: string | null;
  readonly lastError: string | null;
  readonly createdAtMs: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly occurredAtMs: number;
  readonly ingestedAtMs: number;
}

/**
 * Everything `consumerId` still owes, oldest sequence first.
 *
 * Undrained by C means `status IN ('pending','failed')` for C. There is no
 * global `undrained()` in this module and there must not be one: the
 * whole reason consumption is fanned out per consumer is that a single
 * drained flag lets the first consumer to finish hide every other
 * consumer's backlog, which is how 134 terminal events sat undelivered
 * for twenty days behind a scan that reported nothing wrong.
 *
 * Each row carries the event's own fields as well as the consumption's,
 * so a caller diagnosing a backlog does not have to join the spine again
 * -- and so that the `ingestedAtMs` the head-of-line age is measured from
 * is right there next to the row it belongs to.
 */
export function undrained(
  connection: SqliteDatabase,
  options: { readonly consumerId: string },
): readonly UndrainedRow[] {
  requireIdentifier("consumer_id", options.consumerId);
  const rows = connection
    .prepare<
      { consumer_id: string },
      {
        consumer_id: string;
        event_seq: number;
        status: string;
        attempt_count: number;
        message_id: string | null;
        last_error: string | null;
        created_at_ms: number;
        event_id: string;
        event_type: string;
        subject_kind: string;
        subject_id: string;
        occurred_at_ms: number;
        ingested_at_ms: number;
      }
    >(
      `
        SELECT ec.consumer_id, ec.event_seq, ec.status, ec.attempt_count, ec.message_id,
               ec.last_error, ec.created_at_ms,
               e.event_id, e.event_type, e.subject_kind, e.subject_id,
               e.occurred_at_ms, e.ingested_at_ms
          FROM event_consumption ec
          JOIN event e ON e.seq = ec.event_seq
         WHERE ec.consumer_id = :consumer_id
           AND ec.status IN ('pending', 'failed')
         ORDER BY ec.event_seq
        `,
    )
    .all({ consumer_id: options.consumerId });
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        consumerId: row.consumer_id,
        eventSeq: Number(row.event_seq),
        status: row.status,
        attemptCount: Number(row.attempt_count),
        messageId: row.message_id,
        lastError: row.last_error,
        createdAtMs: Number(row.created_at_ms),
        eventId: row.event_id,
        eventType: row.event_type,
        subjectKind: row.subject_kind,
        subjectId: row.subject_id,
        occurredAtMs: Number(row.occurred_at_ms),
        ingestedAtMs: Number(row.ingested_at_ms),
      }),
    ),
  );
}

/** How many events `consumerId` has not drained. Never a global count. */
export function backlogDepth(
  connection: SqliteDatabase,
  options: { readonly consumerId: string },
): number {
  requireIdentifier("consumer_id", options.consumerId);
  // Read positionally (`.pluck()`), as policy.ts does for the same reason:
  // an unaliased expression column has no name SQLite promises to keep.
  const count = connection
    .prepare<{ consumer_id: string }>(
      "SELECT COUNT(*) FROM event_consumption " +
        "WHERE consumer_id = :consumer_id AND status IN ('pending', 'failed')",
    )
    .pluck()
    .get({ consumer_id: options.consumerId });
  return Number(count);
}

/**
 * The lowest sequence `consumerId` still owes, or `null` if it owes none.
 *
 * The cursor-shaped view of a consumer's position, **derived and never
 * stored**. A stored cursor is a second copy of the truth that can
 * disagree with the rows, and it cannot express "event 5 failed, event 6
 * succeeded" -- it forces head-of-line blocking on every failure, which is
 * why section 5.3 chose per-event rows over a cursor in the first place.
 * Deriving it means the frontier moves exactly when the rows move and at
 * no other time.
 */
export function drainFrontier(
  connection: SqliteDatabase,
  options: { readonly consumerId: string },
): number | null {
  requireIdentifier("consumer_id", options.consumerId);
  const frontier = connection
    .prepare<{ consumer_id: string }>(
      "SELECT MIN(event_seq) FROM event_consumption " +
        "WHERE consumer_id = :consumer_id AND status IN ('pending', 'failed')",
    )
    .pluck()
    .get({ consumer_id: options.consumerId }) as number | null;
  return frontier === null ? null : Number(frontier);
}

/**
 * How long the oldest thing `consumerId` owes has been waiting, or `null`.
 *
 * Measured from `event.ingested_at_ms` -- our clock, when the row
 * committed -- and not from `occurred_at_ms`, which is the provider's.
 * This is a statement about *our* lateness in draining, so a provider's
 * skewed clock must not be able to decide it. `time-base-policy.md`
 * section 3 is where the tolerance this is compared against lives; no
 * number appears here.
 */
export function headOfLineAgeMs(
  connection: SqliteDatabase,
  options: { readonly consumerId: string; readonly nowMs: number },
): number | null {
  requireIdentifier("consumer_id", options.consumerId);
  requireEpochMs("now_ms", options.nowMs);
  const row = connection
    .prepare<{ consumer_id: string }, { ingested_at_ms: number }>(
      `
        SELECT e.ingested_at_ms
          FROM event_consumption ec
          JOIN event e ON e.seq = ec.event_seq
         WHERE ec.consumer_id = :consumer_id
           AND ec.status IN ('pending', 'failed')
         ORDER BY ec.event_seq
         LIMIT 1
        `,
    )
    .get({ consumer_id: options.consumerId });
  return row === undefined ? null : options.nowMs - Number(row.ingested_at_ms);
}

// --------------------------------------------------------------------------
// reconcile -- section 5.6. Two of the passes the table there names: the
// undrained-events row and the orphaned-outbox row. Both are SELECTs. The
// pass that acts on what they name is the caller's, and keeping the
// detection free of writes is what makes it safe to run on any replica at
// any frequency.
// --------------------------------------------------------------------------

/**
 * The incident class the undrained-events pass ages against
 * (`time-base-policy.md` section 3.2, seeded in `0002_policy_seed.sql`).
 * Named here rather than spelled inline at the call so that the class
 * this module alarms under is greppable from the policy row's side too --
 * a detector reading a class nobody seeded fails as a `PolicyRowMissing`
 * refusal (`policy.ts`), and the string is how a reader confirms which
 * row that is.
 */
export const BACKLOG_INCIDENT_CLASS = "consumer_backlog";

/**
 * The incident class the orphaned-outbox pass ages against. It is the one
 * **delivery** tolerance the time base decides (`T` = 2 min, `L` = 5 min):
 * section 3.2 derives it from the gate relay because that is where the
 * stall was first observed, but the condition it measures -- "enqueued
 * and still waiting to be sent or acked" -- is a property of the
 * `outbox` row and of nothing above it, and `gate_relay` reaches it only
 * by joining the same column this pass reads. Aging every unfinished
 * message against a second, invented number would put a tolerance in
 * code, which is exactly what `D-0031` moves into policy data.
 */
export const OUTBOX_DELIVERY_INCIDENT_CLASS = "relay_delivery_stall";

/**
 * The statement {@link orphanedOutbox} executes, hoisted out of the
 * function **so the plan test can EXPLAIN the shipped text**. It lives at
 * module level for one reason: a test that pastes the query into itself
 * and explains the paste asserts a property of the paste. That form was
 * in the source suite and it stayed green while the function's own
 * predicate was rewritten into the degraded arithmetic below -- the exact
 * regression this comment says would turn this pass into a full scan.
 * Nothing else may hold a second copy of this text; the constant is the
 * only copy.
 */
export const ORPHANED_OUTBOX_SQL = `
        SELECT message_id, recipient, dedup_key, status, retry_count,
               enqueued_at_ms, delivered_at_ms,
               :now_ms - enqueued_at_ms AS age_ms,
               :tolerance_ms,
               :revision_id,
               :incident_class
          FROM outbox
         WHERE status IN ('pending', 'delivered')
           AND enqueued_at_ms < :now_ms - :tolerance_ms
         ORDER BY enqueued_at_ms, message_id
        `;

/**
 * The algebraically identical, index-losing form of {@link
 * ORPHANED_OUTBOX_SQL} -- same rows, `enqueued_at_ms` buried inside an
 * expression no b-tree can seek on. It is kept only so the plan test can
 * prove that the degraded form really does lose `outbox_undelivered`;
 * without that half, "the shipped query uses the index" would also pass
 * on a database where every plan does. **Never execute this in production
 * code.**
 */
export const DEGRADED_ORPHANED_OUTBOX_SQL = ORPHANED_OUTBOX_SQL.replace(
  "AND enqueued_at_ms < :now_ms - :tolerance_ms",
  "AND :now_ms - enqueued_at_ms > :tolerance_ms",
);

/** One row of {@link backloggedConsumers}'s result. */
export interface BackloggedConsumer {
  readonly consumerId: string;
  readonly drainFrontier: number;
  readonly headOfLineAgeMs: number;
  readonly ingestedAtMs: number;
  readonly backlogDepth: number;
  readonly toleranceMs: number;
  readonly revisionId: number;
  readonly incidentClass: string;
}

/**
 * Consumers whose head-of-line age exceeds the `consumer_backlog`
 * tolerance.
 *
 * Section 5.6's undrained-events pass, and it is **per consumer for the
 * same reason everything else in this section is**: a global "oldest
 * undrained event" figure is the single `drained_at` column wearing a
 * different hat -- it goes quiet the moment *any* consumer drains the
 * head of the spine, while the consumer that is actually stuck keeps
 * accumulating. That is `tools/relay_scan.py`'s twenty-day silence, and
 * this function must never grow an aggregate that reintroduces it. Every
 * row returned names a `consumerId`; there is no shape of the result that
 * does not.
 *
 * The age is taken at the **drain frontier** (section 5.5) --
 * `MIN(event_seq)` over that consumer's undrained rows -- and read from
 * *that row's* `event.ingested_at_ms` rather than from
 * `MIN(ingested_at_ms)`. The two agree only while ingest order matches
 * sequence order, which nothing enforces: `ingested_at_ms` is the
 * caller's value (no column here has a `DEFAULT`), so a producer catching
 * up on a backlog can commit an older instant at a higher sequence.
 * Head-of-line blocking is about the row at the *front*, so the front row
 * is the one that must be aged.
 *
 * **A retired consumer is not backlogged.** The frontier joins `consumer`
 * and drops rows whose `retired_at_ms` is set, for the same reason
 * `subscribers` refuses to fan out to one: the rows a consumer left
 * behind when it was retired stay `pending` forever, and the remedy
 * section 5.6 assigns this class -- raise a `consumer_backlog` incident,
 * drain the consumer -- has nobody left to perform it. Without the join,
 * retiring a consumer converts it into a permanent alarm that no action
 * can clear, and a class of incident that can never be cleared is how an
 * operator learns to stop reading the whole pass. The rows are kept (the
 * fan-out history has to stay explicable) and excluded here, exactly as
 * `watcher`/`policy` exclude their own retired and superseded rows.
 *
 * `revisionId` is resolved by the caller -- through `effectiveRevisionId`
 * for a detector judging now, or `revisionOverPeriod` for a report
 * judging a past window (`policy.ts`). This function will not resolve one
 * for itself: `D-0031`'s corollary is that a `policy_*` read without a
 * bound revision matches every tolerance ever recorded, and a convenience
 * default here would be the same defect one call deeper, where the
 * report and the detector could no longer disagree about which instant
 * they are judging.
 *
 * The boundary is **strictly exceeds**, matching section 5.6's "exceeds
 * the class tolerance" and `T`'s definition in `time-base-policy.md`
 * section 3.1 as the time the condition may *legitimately persist*. A
 * consumer exactly `T` old is still inside what it is entitled to.
 *
 * @throws {PolicyRowMissing} (`policy.ts`) if `revisionId` decides no
 *   `consumer_backlog` row. A pass that skipped itself on unseeded policy
 *   would be indistinguishable from a pass that found no backlog, which
 *   is the failure this whole module is written against.
 * @throws {NotADuration} (`policy.ts`) if a later revision gives the
 *   class a `consecutive_count` threshold. Refused rather than read as
 *   milliseconds, because the coercion yields a tolerance every consumer
 *   crosses immediately.
 */
export function backloggedConsumers(
  connection: SqliteDatabase,
  options: { readonly revisionId: number; readonly nowMs: number },
): readonly BackloggedConsumer[] {
  const { revisionId, nowMs } = options;
  requirePositiveEpoch("revision_id", revisionId);
  requireEpochMs("now_ms", nowMs);
  const toleranceMs = resolveToleranceMs(connection, {
    revisionId,
    incidentClass: BACKLOG_INCIDENT_CLASS,
    subject: undefined,
  });

  // Read POSITIONALLY -- `.raw()` -- exactly as the source's
  // `zip(columns, row)` does, and never by the name a column "obviously" has.
  // Three of the eight result columns are bare bound parameters
  // (`:tolerance_ms`, `:revision_id`, `:incident_class`), and SQLite promises
  // no name for an unaliased expression column: better-sqlite3 hands them back
  // keyed `":tolerance_ms"`, so a by-name read misses every one of them and
  // `Number(undefined)` turns the tolerance the pass was bound to into `NaN`.
  // Same reason `policy.ts` reads its own unaliased column positionally
  // (`D-0021`).
  const columns = connection
    .prepare<
      { now_ms: number; tolerance_ms: number; revision_id: number; incident_class: string },
      unknown[]
    >(
      `
        WITH frontier AS (
            SELECT ec.consumer_id,
                   MIN(ec.event_seq) AS event_seq,
                   COUNT(*) AS backlog_depth
              FROM event_consumption ec
              JOIN consumer c ON c.consumer_id = ec.consumer_id
             WHERE ec.status IN ('pending', 'failed')
               AND c.retired_at_ms IS NULL
             GROUP BY ec.consumer_id)
        SELECT f.consumer_id,
               f.event_seq,
               :now_ms - e.ingested_at_ms AS head_of_line_age_ms,
               e.ingested_at_ms,
               f.backlog_depth,
               :tolerance_ms,
               :revision_id,
               :incident_class
          FROM frontier f
          JOIN event e ON e.seq = f.event_seq
         WHERE :now_ms - e.ingested_at_ms > :tolerance_ms
         ORDER BY head_of_line_age_ms DESC, f.consumer_id
        `,
    )
    .raw()
    .all({
      now_ms: nowMs,
      tolerance_ms: toleranceMs,
      revision_id: revisionId,
      incident_class: BACKLOG_INCIDENT_CLASS,
    });

  return Object.freeze(
    columns.map((row) =>
      Object.freeze({
        consumerId: String(row[0]),
        drainFrontier: Number(row[1]),
        headOfLineAgeMs: Number(row[2]),
        ingestedAtMs: Number(row[3]),
        backlogDepth: Number(row[4]),
        toleranceMs: Number(row[5]),
        revisionId: Number(row[6]),
        incidentClass: String(row[7]),
      }),
    ),
  );
}

/** One row of {@link orphanedOutbox}'s result. */
export interface OrphanedOutboxRow {
  readonly messageId: string;
  readonly recipient: string;
  readonly dedupKey: string;
  readonly status: string;
  readonly retryCount: number;
  readonly enqueuedAtMs: number;
  readonly deliveredAtMs: number | null;
  readonly ageMs: number;
  readonly toleranceMs: number;
  readonly revisionId: number;
  readonly incidentClass: string;
}

/**
 * Enqueued messages still awaiting an ack and past the delivery
 * tolerance.
 *
 * Section 5.6's orphaned-outbox pass. It belongs beside the append that
 * *created* these rows: section 5.4 makes the enqueue part of the append
 * transaction precisely so the outbox is the only delivery path, and a
 * backstop that lived in its own module would read as the second path v1
 * had. (`spike.ts` is the S5 spike scaffold, marked throwaway and sitting
 * on a different schema; it is not where a production-schema pass goes.)
 *
 * **This is a `SELECT` and re-attempt is the caller's.** Nothing here
 * touches `retry_count`, `status` or any other column: section 5.6's
 * "the retry count is already durable and monotonic" is a statement about
 * the sender's own increment, and a detector that bumped it would
 * inflate the evidence an operator reads to decide whether a destination
 * is refusing. `outbox_retry_count_is_monotonic` in `0001_initial.sql`
 * would not catch that -- an increment is exactly what it permits.
 *
 * `status IN ('pending', 'delivered')` and not `status = 'pending'`:
 * `delivered` without an ack is the crash-window case this pass exists
 * for -- the send landed and the ack did not, or never came back -- and
 * it is the case that goes silent if the predicate only names `pending`.
 * The other two statuses are both terminal and neither is a stall:
 * `acked` arrived, and `cancelled` (`0003_outbox_cancelled_status.sql`)
 * is a message nobody wants sent any more, so a pass that kept matching
 * it would age a retired relay forever -- the failure that step exists
 * to end.
 *
 * **The partial index is usable and the shape of the predicate is what
 * makes it so.** `0003_outbox_cancelled_status.sql` carries `CREATE
 * INDEX outbox_undelivered ON outbox(enqueued_at_ms) WHERE status IN
 * ('pending', 'delivered')`. SQLite may use a partial index only when the
 * query's `WHERE` contains the index's own predicate as a term, so that
 * `IN` list is written out verbatim rather than folded into the age
 * arithmetic or restated as its complement. And the range term is
 * `enqueued_at_ms < :now_ms - :tolerance_ms` -- the bare indexed
 * **column** on one side -- because the algebraically identical `:now_ms
 * - enqueued_at_ms > :tolerance_ms` is an expression *over* the column,
 * which no b-tree can seek on, and would degrade the pass to a full scan
 * of every message ever enqueued (rows are never deleted:
 * `outbox_rows_are_never_deleted`). The plan is asserted in the tests
 * rather than trusted, because both forms return the same rows and only
 * the plan tells them apart.
 *
 * `revisionId` is the caller's, for the reason given on {@link
 * backloggedConsumers}, and the boundary is likewise strictly exceeds --
 * section 5.6 says "older than the delivery tolerance", and a message
 * exactly at `T` is not yet older than it.
 *
 * @throws {PolicyRowMissing} (`policy.ts`) if `revisionId` decides no
 *   delivery tolerance.
 */
export function orphanedOutbox(
  connection: SqliteDatabase,
  options: { readonly revisionId: number; readonly nowMs: number },
): readonly OrphanedOutboxRow[] {
  const { revisionId, nowMs } = options;
  requirePositiveEpoch("revision_id", revisionId);
  requireEpochMs("now_ms", nowMs);
  const toleranceMs = resolveToleranceMs(connection, {
    revisionId,
    incidentClass: OUTBOX_DELIVERY_INCIDENT_CLASS,
    subject: undefined,
  });

  // Positional, for the reason given in {@link backloggedConsumers}: the last
  // three result columns are bare bound parameters with no name SQLite
  // guarantees.
  const columns = connection
    .prepare<
      { now_ms: number; tolerance_ms: number; revision_id: number; incident_class: string },
      unknown[]
    >(ORPHANED_OUTBOX_SQL)
    .raw()
    .all({
      now_ms: nowMs,
      tolerance_ms: toleranceMs,
      revision_id: revisionId,
      incident_class: OUTBOX_DELIVERY_INCIDENT_CLASS,
    });

  return Object.freeze(
    columns.map((row) =>
      Object.freeze({
        messageId: String(row[0]),
        recipient: String(row[1]),
        dedupKey: String(row[2]),
        status: String(row[3]),
        retryCount: Number(row[4]),
        enqueuedAtMs: Number(row[5]),
        deliveredAtMs: row[6] === null ? null : Number(row[6]),
        ageMs: Number(row[7]),
        toleranceMs: Number(row[8]),
        revisionId: Number(row[9]),
        incidentClass: String(row[10]),
      }),
    ),
  );
}
