/**
 * The event spine's contract: one append transaction, and a per-consumer drain.
 *
 * Ported from interlock `tests/control_plane/test_events.py` at `65f36c5`.
 * Every case here maps to one source node id; the mapping is recorded in the
 * parity ledger.
 *
 * These tests are for `docs/production-schema.md` sections 5.1-5.6 and `D-0030`,
 * and they exist because every property below is one that a plausible
 * implementation satisfies on the happy path and loses on the failure path --
 * which is the shape of failure this design was written against. So the
 * assertions are deliberately about what is *absent* after something went wrong:
 *
 * * an append whose side table refuses leaves **no** event, **no** consumption
 *   and **no** outbox row. Asserting only on `event` would pass for an
 *   implementation that leaked an orphan outbox row, and an event with no
 *   delivery record -- or a delivery with no event -- is v1's push-vs-poll
 *   duplication coming back;
 * * a re-append of a known `dedupKey` creates no second consumption row for
 *   anybody, not merely no second event;
 * * every drain quantity is per consumer, and one consumer draining does not
 *   move another's numbers. That is the twenty-day failure of
 *   `tools/relay_scan.py` written as a regression test, and it is named as one;
 * * the two section 5.6 reconcile passes age against the tolerance of the
 *   revision the **caller bound**, which is asserted with two revisions on
 *   record because a read that forgot the predicate still returns rows;
 * * a skip that the fence refuses appends no `consumption_skipped` event, and a
 *   skip that succeeds always appends exactly one. A `skipped` row with no
 *   recorded reason is indistinguishable from a consumer quietly dropping work,
 *   so "unreachable" has to be asserted rather than intended.
 *
 * Every timestamp comes from {@link T0} and arithmetic on it. No test reads a
 * clock: the schema gives no timestamp column a `DEFAULT` precisely so that
 * clock skew across an expiry boundary is expressible, and a suite whose
 * expectations move with the wall clock cannot assert a boundary at all.
 *
 * Three translation notes, each of which is a rule rather than a local choice:
 *
 * * Each pytest fixture (`db_path`, `cp`) is a plain function called inside the
 *   test (conventions rule 8), and every connection registers its `close()` with
 *   `onTestFinished` at the point of acquisition (rule 1) -- on Windows an open
 *   handle is what fails the temporary-directory cleanup, and the acquisition
 *   site is the only place that knows the acquisition succeeded.
 * * Every case that claims a transaction did or did not commit re-reads the
 *   database through a **second connection**. Asserting through the handle that
 *   owns the transaction proves nothing about what committed.
 * * The `caseRoot` label is `spine`, a short module nickname (`D-0020`). This
 *   file asserts no `match=` pattern at all -- its source uses none -- so no
 *   pattern can be made vacuous by the temp path; the short label keeps it that
 *   way for any pattern a later edit adds.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import type { AppendedEvent } from "../../src/control_plane/events.js";
import {
  appendEvent,
  backlogDepth,
  backloggedConsumers,
  DEGRADED_ORPHANED_OUTBOX_SQL,
  drainFrontier,
  EVENT_TYPES,
  EventSpineUsageError,
  headOfLineAgeMs,
  markConsumed,
  markFailed,
  markSkipped,
  ORPHANED_OUTBOX_SQL,
  orphanedOutbox,
  registerConsumer,
  StaleConsumerRefused,
  subscribe,
  undrained,
  unsubscribe,
} from "../../src/control_plane/events.js";
import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import {
  effectiveRevisionId,
  NotADuration,
  PolicyRowMissing,
} from "../../src/control_plane/policy.js";
import {
  currentScope,
  inAutocommit,
  TransactionUsageError,
  transaction,
} from "../../src/control_plane/txn.js";
import { caseRoot, databasePath, rawConnection } from "../testkit/cases.js";
import { expectRefusal, expectSqliteError } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

/** A lease window long enough that no test crosses it by accident. */
const TTL = 60_000;

/**
 * The exception a test's own body raises to abandon a transaction, standing in
 * for the source's `RuntimeError`. A named class rather than a bare `Error` so
 * `expectRefusal` keeps its type half meaningful: "the caller's own failure"
 * has to be distinguishable from a refusal raised by the module under test.
 */
class TheCallersOwnFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TheCallersOwnFailure";
    Object.setPrototypeOf(this, TheCallersOwnFailure.prototype);
  }
}

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------

/** The source's `db_path` fixture: a name inside a fresh directory. */
function dbPathFixture(): string {
  return databasePath(caseRoot("spine"));
}

/** The source's `cp` fixture: a production control plane created at `T0`. */
function cpFixture(path: string = dbPathFixture()): SqliteDatabase {
  const connection = createProductionControlPlane(path, { nowMs: T0 });
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

/**
 * A second connection onto the same file, for the cases that claim something
 * committed -- or did not.
 *
 * A read through the handle that owns the transaction is satisfied by uncommitted
 * state, so it cannot tell "committed" from "still open in this session". This
 * one can.
 */
function secondConnection(path: string): SqliteDatabase {
  const connection = new Database(path, { fileMustExist: true });
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

// --------------------------------------------------------------------------
// helpers -- the smallest legal row of each kind
// --------------------------------------------------------------------------

function addRun(cp: SqliteDatabase, runId = "run-1", at: number = T0): string {
  cp.prepare(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
  ).run(runId, "running", at, at);
  return runId;
}

/** Put a live lease on `resource`. The settle fence validates against this. */
function grantLease(
  cp: SqliteDatabase,
  resource: string,
  options: {
    readonly holder?: string;
    readonly epoch?: number;
    readonly at?: number;
    readonly ttlMs?: number;
  } = {},
): number {
  const holder = options.holder ?? "worker-1";
  const epoch = options.epoch ?? 1;
  const at = options.at ?? T0;
  const ttlMs = options.ttlMs ?? TTL;
  cp.prepare(
    "INSERT INTO lease (resource, holder, epoch, acquired_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)",
  ).run(resource, holder, epoch, at, at + ttlMs);
  return epoch;
}

/**
 * Register a consumer, give it a live lease, and subscribe it.
 *
 * The lease resource is derived from the consumer id so that each consumer in a
 * test fences against its own epoch -- two consumers sharing one lease would
 * make the stale-epoch tests pass for the wrong reason.
 */
function addConsumer(
  cp: SqliteDatabase,
  consumerId: string,
  options: {
    readonly kind?: string;
    readonly eventType?: string | null;
    readonly recipient?: string | null;
    readonly at?: number;
    readonly registeredFromSeq?: number;
  } = {},
): string {
  const kind = options.kind ?? "compute";
  const eventType = options.eventType === undefined ? "ci_observed" : options.eventType;
  const recipient = options.recipient ?? null;
  const at = options.at ?? T0;
  const registeredFromSeq = options.registeredFromSeq ?? 0;

  registerConsumer(cp, {
    consumerId,
    kind,
    leaseResource: `consumer:${consumerId}`,
    registeredAtMs: at,
    registeredFromSeq,
  });
  grantLease(cp, `consumer:${consumerId}`, { holder: consumerId, at });
  if (eventType !== null) {
    subscribe(cp, { consumerId, eventType, recipient, addedAtMs: at });
  }
  return consumerId;
}

/** The source's `append` helper: the smallest legal append, with overrides. */
function append(
  cp: SqliteDatabase,
  options: {
    readonly eventId?: string;
    readonly eventType?: string;
    readonly at?: number;
    readonly subjectKind?: string;
    readonly subjectId?: string;
    readonly dedupKey?: string;
    readonly producer?: string;
    readonly payload?: string | null;
    readonly sideEffect?: (connection: SqliteDatabase, seq: number) => void;
    readonly deliveryPayload?: (consumerId: string, recipient: string) => string;
  } = {},
): AppendedEvent {
  const eventId = options.eventId ?? "evt-1";
  const at = options.at ?? T0;
  return appendEvent(cp, {
    eventId,
    eventType: options.eventType ?? "ci_observed",
    subjectKind: options.subjectKind ?? "run",
    subjectId: options.subjectId ?? "run-1",
    dedupKey: options.dedupKey ?? `dk/${eventId}`,
    producer: options.producer ?? "gh-watcher",
    occurredAtMs: at,
    ingestedAtMs: at,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
    ...(options.sideEffect === undefined ? {} : { sideEffect: options.sideEffect }),
    ...(options.deliveryPayload === undefined ? {} : { deliveryPayload: options.deliveryPayload }),
  });
}

/**
 * The source's `rows`: every row as a positional tuple.
 *
 * `.raw()` rather than the default object rows, because half of these
 * statements select unaliased expression columns and SQLite promises no name
 * for one; reading such a column by the name it "obviously" has silently yields
 * `undefined` (`D-0021`). Positional is also what the source's `fetchall()`
 * returns, so the expectations are the source's own tuples.
 */
function rows(cp: SqliteDatabase, sql: string, ...params: unknown[]): unknown[][] {
  return cp
    .prepare<unknown[], unknown[]>(sql)
    .raw()
    .all(...params);
}

/** The source's `rows_of`: the same, for a statement with named parameters. */
function rowsOfSql(cp: SqliteDatabase, sql: string, params: Record<string, unknown>): unknown[][] {
  return cp.prepare<Record<string, unknown>, unknown[]>(sql).raw().all(params);
}

/** The query plan SQLite chose for `sql`, flattened for substring assertions. */
function explain(cp: SqliteDatabase, sql: string, params?: Record<string, unknown>): string {
  const planRows =
    params === undefined
      ? cp.prepare<[], unknown[]>(`EXPLAIN QUERY PLAN ${sql}`).raw().all()
      : cp
          .prepare<Record<string, unknown>, unknown[]>(`EXPLAIN QUERY PLAN ${sql}`)
          .raw()
          .all(params);
  return planRows.map((row) => JSON.stringify(row)).join(" ");
}

/**
 * The outbox statement {@link orphanedOutbox} really ran, from the driver.
 *
 * Traced rather than pasted into the test or read out of the source: the plan
 * assertions below are only worth anything if they are made against the text
 * SQLite was actually handed. The trace hands back the statement with its
 * parameters already expanded, which `EXPLAIN QUERY PLAN` accepts unchanged.
 *
 * Adapted: Python installs the trace on the `cp` connection with
 * `set_trace_callback` and removes it afterwards. better-sqlite3's equivalent
 * logger (`verbose`) can only be given at construction, so the traced
 * connection is a second handle on the same file, and the flag reproduces the
 * install/remove window exactly. The statement captured is still the one the
 * function executed, which is the whole property.
 */
function executedOutboxSql(cp: SqliteDatabase, path: string): string {
  const seen: string[] = [];
  let tracing = false;
  const traced = new Database(path, {
    fileMustExist: true,
    verbose: (message?: unknown) => {
      if (tracing) {
        seen.push(String(message));
      }
    },
  });
  onTestFinished(() => {
    traced.close();
  });

  tracing = true;
  try {
    orphanedOutbox(traced, {
      revisionId: seededRevision(cp),
      nowMs: T0 + DELIVERY_T + 1,
    });
  } finally {
    tracing = false;
  }
  const outboxStatements = seen.filter((sql) => sql.includes("FROM outbox"));
  expect(outboxStatements, JSON.stringify(outboxStatements)).toHaveLength(1);
  return outboxStatements[0] as string;
}

function count(cp: SqliteDatabase, table: string): number {
  return Number(cp.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
}

/**
 * Python's `(row,) = ...`, which asserts the count and binds the element in one
 * step. A helper so the count assertion cannot be lost on the way to `[0]`.
 */
function onlyOne<T>(values: readonly T[]): T {
  expect(values).toHaveLength(1);
  return values[0] as T;
}

/** {@link currentScope}, narrowed by a throw so a cast cannot outlive a check. */
function scopeOf(cp: SqliteDatabase): Record<string, unknown> {
  const scope = currentScope(cp);
  if (scope === undefined) {
    expect.fail("a transaction scope must be open here");
  }
  return scope;
}

// --------------------------------------------------------------------------
// the shared transaction helper
// --------------------------------------------------------------------------

describe("the shared transaction helper", () => {
  // `transaction refuses a connection the driver would commit for itself` is
  // NOT ported. Python's `transaction()` refuses a connection whose
  // `isolation_level` is not `None` -- the state in which `sqlite3` opens a
  // transaction of its own before a DML statement and commits it later, behind
  // the caller's back. better-sqlite3 has no `isolation_level` and no such
  // mode: it is unconditionally autocommit outside an explicit `BEGIN`, so the
  // refusal has no reachable trigger and there is no production branch to
  // exercise.
  //
  // A first draft translated it into assertions about the driver's own
  // behaviour. That was strictly weaker than the source -- it pinned no refusal
  // at all, and gutting `transaction()` to a bare pass-through left it green --
  // so it is recorded as `not-ported` in the parity ledger with that reason
  // (operator decision, 2026-08-22) rather than kept as coverage it was not.
  // The driver facts it measured now live in
  // `test/contract/better-sqlite3-transaction-state.test.ts`, which is where
  // this port keeps claims about the driver, and are not counted as ported
  // coverage.

  test("in autocommit makes such a connection usable", () => {
    const path = dbPathFixture();
    const connection = rawConnection(path);
    connection.exec("CREATE TABLE t (a INTEGER)");
    transaction(inAutocommit(connection), () => {
      connection.prepare("INSERT INTO t VALUES (1)").run();
    });
    expect(rows(connection, "SELECT a FROM t")).toEqual([[1]]);
    // The source's `connection.commit()` before the block, and the read after
    // it, are both about state having actually landed; on this driver only the
    // second connection can say so.
    expect(rows(secondConnection(path), "SELECT a FROM t")).toEqual([[1]]);
  });

  test("transaction rolls the whole block back on any exception", () => {
    const path = dbPathFixture();
    const cp = cpFixture(path);
    addRun(cp);
    expectRefusal(
      () =>
        transaction(cp, (tx) => {
          appendEvent(tx, {
            eventId: "evt-1",
            eventType: "ci_observed",
            subjectKind: "run",
            subjectId: "run-1",
            dedupKey: "dk/1",
            producer: "gh-watcher",
            occurredAtMs: T0,
            ingestedAtMs: T0,
          });
          throw new TheCallersOwnFailure("the caller's own failure, after a nested append");
        }),
      TheCallersOwnFailure,
    );
    expect(count(cp, "event")).toBe(0);
    expect(count(secondConnection(path), "event")).toBe(0);
  });

  test("a nested transaction joins the outer one instead of committing early", () => {
    const path = dbPathFixture();
    const cp = cpFixture(path);
    addRun(cp);
    expectRefusal(
      () =>
        transaction(cp, () => {
          // appendEvent opens a transaction of its own; joining is what lets a
          // composed operation stay one all-or-nothing unit.
          append(cp);
          expect(count(cp, "event")).toBe(1);
          // Nothing has been published, which is the half of "joins" that an
          // inner COMMIT would break, and that the owning handle cannot see.
          expect(count(secondConnection(path), "event")).toBe(0);
          throw new TheCallersOwnFailure("abandon the composed operation");
        }),
      TheCallersOwnFailure,
    );
    expect(count(cp, "event")).toBe(0);
    expect(count(secondConnection(path), "event")).toBe(0);
  });

  test("a deferred transaction body is refused rather than awaited (target-only)", () => {
    // TARGET-ONLY: no source case, because the hazard does not exist in the
    // source. Python's `transaction` is a `@contextmanager` used with `with`,
    // whose body cannot return early and carry on later; the TypeScript form is
    // a callback, and an `async` body would let `transaction()` commit before
    // the body's own writes ran -- the exact defect the module exists to
    // prevent, arriving through the mechanism meant to prevent it. D-0103 is
    // the standing decision; this is its liveness test for `txn.ts`.
    const cp = cpFixture();
    expectRefusal(
      () => transaction(cp, (async () => undefined) as unknown as () => void),
      TransactionUsageError,
    );
    // A plain function that merely *returns* a promise is not decidable before
    // the call, so it is refused after it -- both paths, or the guard is half a
    // guard.
    expectRefusal(
      () => transaction(cp, (() => Promise.resolve(1)) as unknown as () => void),
      TransactionUsageError,
    );
    expect(cp.inTransaction).toBe(false);
  });

  test("a deferred append side effect is refused rather than awaited (target-only)", () => {
    // TARGET-ONLY, and the same D-0103 hazard one level down. `sideEffect` runs
    // INSIDE the append transaction, and it is called last on purpose: a side
    // table that refuses the fact must take the event down with it, because the
    // typed row and the spine row are one fact recorded twice. A deferred
    // callback would return at its first `await` having written nothing, the
    // append would COMMIT, and the spine would carry an observation nobody
    // could insert -- a projection that silently disagrees with its source.
    //
    // Python's `side_effect` is a plain callable and cannot be async, so there
    // is no source case; the hazard is introduced by the callback translation
    // and contained here.
    const cp = cpFixture();
    addRun(cp);
    expectRefusal(
      () =>
        append(cp, {
          sideEffect: (async () => undefined) as unknown as (
            connection: SqliteDatabase,
            seq: number,
          ) => void,
        }),
      TransactionUsageError,
    );
    expect(count(cp, "event")).toBe(0);
    expect(cp.inTransaction).toBe(false);
  });
});

// --------------------------------------------------------------------------
// the append transaction -- section 5.4
// --------------------------------------------------------------------------

describe("the append transaction -- section 5.4", () => {
  test("append fans out one pending consumption row per subscribed consumer", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    addConsumer(cp, "completion");

    const appended = append(cp);

    expect(appended.duplicate).toBe(false);
    expect(appended.seq).toBe(1);
    expect(appended.consumptions).toEqual(["completion", "secretary"]);
    expect(
      rows(
        cp,
        "SELECT consumer_id, status, created_at_ms FROM event_consumption ORDER BY consumer_id",
      ),
    ).toEqual([
      ["completion", "pending", T0],
      ["secretary", "pending", T0],
    ]);
  });

  test("a delivery subscriber gets an outbox row in the same transaction and a compute one does not", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "relay", { kind: "delivery", recipient: "secretary-pane" });
    addConsumer(cp, "completion", { kind: "compute" });

    const appended = append(cp, { payload: JSON.stringify({ verdict: "success" }) });

    expect(appended.messages).toEqual(["event/evt-1/relay"]);
    expect(
      rows(cp, "SELECT message_id, recipient, dedup_key, status, payload FROM outbox"),
    ).toEqual([
      [
        "event/evt-1/relay",
        "secretary-pane",
        "event/evt-1/relay",
        "pending",
        '{"verdict":"success"}',
      ],
    ]);
    expect(
      rows(cp, "SELECT consumer_id, message_id FROM event_consumption ORDER BY consumer_id"),
    ).toEqual([
      ["completion", null],
      ["relay", "event/evt-1/relay"],
    ]);
  });

  test("delivery payload renders per recipient without a second row on the spine", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "relay-a", { kind: "delivery", recipient: "pane-a" });
    addConsumer(cp, "relay-b", { kind: "delivery", recipient: "pane-b" });

    append(cp, {
      deliveryPayload: (consumerId, recipient) => JSON.stringify({ to: recipient, by: consumerId }),
    });

    expect(count(cp, "event")).toBe(1);
    expect(rows(cp, "SELECT recipient, payload FROM outbox ORDER BY recipient")).toEqual([
      ["pane-a", '{"to":"pane-a","by":"relay-a"}'],
      ["pane-b", '{"to":"pane-b","by":"relay-b"}'],
    ]);
  });

  test("the side effect receives the seq the event was assigned", () => {
    const cp = cpFixture();
    addRun(cp);
    const seen: number[] = [];
    const appended = append(cp, {
      sideEffect: (_connection, seq) => {
        seen.push(seq);
      },
    });
    expect(seen).toEqual([appended.seq]);
  });

  test("a failing side effect leaves no event no consumption and no outbox row", () => {
    const path = dbPathFixture();
    const cp = cpFixture(path);
    addRun(cp);
    addConsumer(cp, "relay", { kind: "delivery", recipient: "secretary-pane" });

    const refuse = (): never => {
      throw new TheCallersOwnFailure("the typed side table refused this fact");
    };

    expectRefusal(() => append(cp, { sideEffect: refuse }), TheCallersOwnFailure);

    // All three, not just the event: an orphan outbox row is a delivery with no
    // fact behind it, which is the same failure from the other direction.
    expect(count(cp, "event")).toBe(0);
    expect(count(cp, "event_consumption")).toBe(0);
    expect(count(cp, "outbox")).toBe(0);
    // And nothing of the three committed, which only another connection can say.
    const other = secondConnection(path);
    expect([
      count(other, "event"),
      count(other, "event_consumption"),
      count(other, "outbox"),
    ]).toEqual([0, 0, 0]);
  });

  test("a re append of the same dedup key is an idempotent no op", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");

    const first = append(cp, { eventId: "evt-1" });
    const again = append(cp, { eventId: "evt-1-retry", dedupKey: "dk/evt-1" });

    expect(again.duplicate).toBe(true);
    expect(again.seq).toBeNull();
    // The id of the event that actually holds the fact, not the one refused.
    expect(again.eventId).toBe(first.eventId);
    expect(again.consumptions).toEqual([]);
    expect(count(cp, "event")).toBe(1);
    expect(count(cp, "event_consumption")).toBe(1);
  });

  test("a re append creates no second consumption row for a consumer added between the two", () => {
    const cp = cpFixture();
    addRun(cp);
    append(cp, { eventId: "evt-1" });
    addConsumer(cp, "late");

    const again = append(cp, { eventId: "evt-1", dedupKey: "dk/evt-1" });

    expect(again.duplicate).toBe(true);
    expect(backlogDepth(cp, { consumerId: "late" })).toBe(0);
  });

  test("reusing an event id for a different fact is an error not a duplicate", () => {
    const cp = cpFixture();
    addRun(cp);
    append(cp, { eventId: "evt-1", dedupKey: "dk/a" });
    // `sqlite3.IntegrityError` carries no code in Python; better-sqlite3 raises
    // one error type for everything and the *code* is what carries the
    // distinction the class carried (D-0016).
    expectSqliteError(() => append(cp, { eventId: "evt-1", dedupKey: "dk/b" }), {
      code: /^SQLITE_CONSTRAINT/,
    });
  });

  test("a consumer registered after the append receives nothing for it", () => {
    const cp = cpFixture();
    addRun(cp);
    append(cp);
    addConsumer(cp, "late");

    expect(backlogDepth(cp, { consumerId: "late" })).toBe(0);
    expect(drainFrontier(cp, { consumerId: "late" })).toBeNull();
  });

  test("a removed subscription and a retired consumer are not subscribers", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "unsubscribed");
    addConsumer(cp, "retired");
    unsubscribe(cp, {
      consumerId: "unsubscribed",
      eventType: "ci_observed",
      removedAtMs: T0 + 1,
    });
    cp.prepare("UPDATE consumer SET retired_at_ms = ? WHERE consumer_id = 'retired'").run(T0 + 1);

    const appended = append(cp, { at: T0 + 2 });

    expect(appended.consumptions).toEqual([]);
    expect(count(cp, "event_consumption")).toBe(0);
  });

  test("unsubscribing something that is not subscribed is refused not a no op", () => {
    const cp = cpFixture();
    addConsumer(cp, "secretary");
    expectRefusal(
      () =>
        unsubscribe(cp, {
          consumerId: "secretary",
          eventType: "pr_merged",
          removedAtMs: T0 + 1,
        }),
      EventSpineUsageError,
    );
  });

  test("a backfilling registration gets the history it asked for and none of what it did not", () => {
    const cp = cpFixture();
    addRun(cp);
    append(cp, { eventId: "evt-1", eventType: "ci_observed" }); // seq 1
    append(cp, { eventId: "evt-2", eventType: "ci_observed" }); // seq 2
    append(cp, { eventId: "evt-3", eventType: "pr_merged" }); // seq 3

    transaction(cp, (tx) => {
      registerConsumer(tx, {
        consumerId: "catch-up",
        kind: "compute",
        leaseResource: "consumer:catch-up",
        registeredAtMs: T0 + 5,
        registeredFromSeq: 1,
        backfill: true,
      });
      subscribe(tx, { consumerId: "catch-up", eventType: "ci_observed", addedAtMs: T0 + 5 });
    });

    // seq 2 only: seq 1 is at or below the watershed it registered from, and
    // seq 3 is an event type it never subscribed to.
    expect(undrained(cp, { consumerId: "catch-up" }).map((row) => row.eventSeq)).toEqual([2]);
  });

  test("a registration without backfill gets no history at all", () => {
    const cp = cpFixture();
    addRun(cp);
    append(cp, { eventId: "evt-1" });
    addConsumer(cp, "forward-only", { registeredFromSeq: 0 });
    expect(backlogDepth(cp, { consumerId: "forward-only" })).toBe(0);
  });

  test("a subscription added in a later transaction does not backfill", () => {
    const cp = cpFixture();
    addRun(cp);
    append(cp, { eventId: "evt-1" });
    registerConsumer(cp, {
      consumerId: "late-subscriber",
      kind: "compute",
      leaseResource: "consumer:late-subscriber",
      registeredAtMs: T0 + 1,
      registeredFromSeq: 0,
      backfill: true,
    });
    subscribe(cp, {
      consumerId: "late-subscriber",
      eventType: "ci_observed",
      addedAtMs: T0 + 2,
    });
    expect(backlogDepth(cp, { consumerId: "late-subscriber" })).toBe(0);
  });

  test("a subscription in a second transaction does not inherit the first ones backfill", () => {
    // The back-fill decision belongs to ONE transaction, and only that one.
    //
    // Regression for a scope that outlived its transaction: the back-fill marker
    // was cleared only when the connection was seen outside *any* transaction,
    // so a registration committed in one `transaction()` block left the marker
    // standing, and a subscription opened inside a *second* block found the
    // connection already in a transaction, kept the marker, and back-filled
    // history the subscriber was never meant to see -- a backlog nobody will
    // drain (`docs/production-schema.md` section 5.4, D-0030).
    const cp = cpFixture();
    addRun(cp);
    append(cp, { eventId: "evt-1" }); // seq 1

    transaction(cp, (tx) => {
      registerConsumer(tx, {
        consumerId: "two-transactions",
        kind: "compute",
        leaseResource: "consumer:two-transactions",
        registeredAtMs: T0 + 1,
        registeredFromSeq: 0,
        backfill: true,
      });
    });

    transaction(cp, (tx) => {
      subscribe(tx, {
        consumerId: "two-transactions",
        eventType: "ci_observed",
        addedAtMs: T0 + 2,
      });
    });

    expect(backlogDepth(cp, { consumerId: "two-transactions" })).toBe(0);
  });

  test("a transaction scope lives exactly as long as its transaction", () => {
    // The scope is the boundary itself, not "some transaction is open".
    //
    // Two consecutive blocks must not share state, a joined inner block must,
    // and a block that rolls back must leave nothing behind for the next one to
    // read.
    const cp = cpFixture();

    expect(currentScope(cp)).toBeUndefined();
    let outer: Record<string, unknown> | undefined;
    transaction(cp, () => {
      outer = scopeOf(cp);
      expect(outer).not.toBeUndefined();
      transaction(cp, () => {
        // joined, so the same scope
        expect(currentScope(cp)).toBe(outer);
      });
    });
    expect(currentScope(cp)).toBeUndefined();

    transaction(cp, () => {
      expect(currentScope(cp)).not.toBe(outer);
    });

    expectRefusal(
      () =>
        transaction(cp, () => {
          scopeOf(cp)["events.probe"] = true;
          throw new TheCallersOwnFailure("rolled back");
        }),
      TheCallersOwnFailure,
    );
    expect(currentScope(cp)).toBeUndefined();
  });

  test("registering the same consumer twice is refused", () => {
    const cp = cpFixture();
    addConsumer(cp, "secretary");
    expectSqliteError(
      () =>
        registerConsumer(cp, {
          consumerId: "secretary",
          kind: "compute",
          leaseResource: "consumer:secretary",
          registeredAtMs: T0,
          registeredFromSeq: 0,
        }),
      { code: /^SQLITE_CONSTRAINT/ },
    );
  });

  test("a delivery subscription without a recipient is refused at registration", () => {
    const cp = cpFixture();
    registerConsumer(cp, {
      consumerId: "relay",
      kind: "delivery",
      leaseResource: "consumer:relay",
      registeredAtMs: T0,
      registeredFromSeq: 0,
    });
    expectSqliteError(
      () => subscribe(cp, { consumerId: "relay", eventType: "ci_observed", addedAtMs: T0 }),
      { code: /^SQLITE_CONSTRAINT/ },
    );
  });
});

// --------------------------------------------------------------------------
// settling -- fenced, typed, and never silent
// --------------------------------------------------------------------------

describe("settling -- fenced, typed, and never silent", () => {
  test("mark consumed settles the row and raises the attempt count", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp);

    markConsumed(cp, {
      consumerId: "secretary",
      eventSeq: 1,
      writerEpoch: 1,
      settledAtMs: T0 + 10,
    });

    expect(
      rows(cp, "SELECT status, attempt_count, writer_epoch, settled_at_ms FROM event_consumption"),
    ).toEqual([["consumed", 1, 1, T0 + 10]]);
    expect(backlogDepth(cp, { consumerId: "secretary" })).toBe(0);
  });

  test("a settle by a stale consumer epoch is refused and the refusal is typed", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp);
    // Someone else took the consumer's lease over, which raises the epoch; the
    // old token now matches nothing.
    cp.prepare(
      "UPDATE lease SET holder = 'usurper', epoch = 2 WHERE resource = 'consumer:secretary'",
    ).run();

    const refusal = expectRefusal(
      () =>
        markConsumed(cp, {
          consumerId: "secretary",
          eventSeq: 1,
          writerEpoch: 1,
          settledAtMs: T0 + 10,
        }),
      StaleConsumerRefused,
    );

    // The refusal is durable in the only sense that matters here: the row it was
    // refused against is untouched and still counts as backlog.
    expect(refusal.observed).not.toBeUndefined();
    expect(refusal.observed?.status).toBe("pending");
    expect(backlogDepth(cp, { consumerId: "secretary" })).toBe(1);
  });

  test("a settle against an expired lease is refused", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp);
    expectRefusal(
      () =>
        markConsumed(cp, {
          consumerId: "secretary",
          eventSeq: 1,
          writerEpoch: 1,
          settledAtMs: T0 + TTL + 1,
        }),
      StaleConsumerRefused,
    );
  });

  test("a settled consumption is not settled twice", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp);
    markConsumed(cp, {
      consumerId: "secretary",
      eventSeq: 1,
      writerEpoch: 1,
      settledAtMs: T0 + 10,
    });
    expectRefusal(
      () =>
        markConsumed(cp, {
          consumerId: "secretary",
          eventSeq: 1,
          writerEpoch: 1,
          settledAtMs: T0 + 20,
        }),
      StaleConsumerRefused,
    );
  });

  test("mark failed leaves the consumption undrained and the error readable", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp);

    markFailed(cp, {
      consumerId: "secretary",
      eventSeq: 1,
      writerEpoch: 1,
      lastError: "pane not found",
      nowMs: T0 + 10,
    });

    expect(backlogDepth(cp, { consumerId: "secretary" })).toBe(1);
    const row = onlyOne(undrained(cp, { consumerId: "secretary" }));
    expect([row.status, row.lastError, row.attemptCount]).toEqual(["failed", "pane not found", 1]);
  });

  test("a retry that lands after a failure clears the error and keeps the attempts", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp);
    markFailed(cp, {
      consumerId: "secretary",
      eventSeq: 1,
      writerEpoch: 1,
      lastError: "pane not found",
      nowMs: T0 + 10,
    });
    markConsumed(cp, {
      consumerId: "secretary",
      eventSeq: 1,
      writerEpoch: 1,
      settledAtMs: T0 + 20,
    });
    expect(rows(cp, "SELECT status, last_error, attempt_count FROM event_consumption")).toEqual([
      ["consumed", null, 2],
    ]);
  });
});

// --------------------------------------------------------------------------
// skipping -- section 5.3's evidence requirement
// --------------------------------------------------------------------------

describe("skipping -- section 5.3's evidence requirement", () => {
  test("mark skipped appends a consumption skipped event in the same transaction", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp, { eventId: "evt-1", subjectKind: "run", subjectId: "run-1" });

    const appended = markSkipped(cp, {
      consumerId: "secretary",
      eventSeq: 1,
      writerEpoch: 1,
      reason: "not this consumer's repository",
      settledAtMs: T0 + 10,
      eventId: "evt-skip-1",
      ingestedAtMs: T0 + 10,
    });

    expect(appended.duplicate).toBe(false);
    const [eventType, subjectKind, subjectId, dedupKey, producer, payload] = rows(
      cp,
      "SELECT event_type, subject_kind, subject_id, dedup_key, producer, payload " +
        "FROM event WHERE seq = ?",
      appended.seq,
    )[0] as [string, string, string, string, string, string];
    expect(eventType).toBe("consumption_skipped");
    // The ORIGINAL subject: the closed subject_kind CHECK has no 'consumer'
    // member, and inventing one for an audit record would be a schema change.
    expect([subjectKind, subjectId]).toEqual(["run", "run-1"]);
    expect(dedupKey).toBe("consumption_skipped/secretary/1");
    expect(producer).toBe("secretary");
    expect((JSON.parse(payload) as { reason: string }).reason).toBe(
      "not this consumer's repository",
    );
    expect(
      rows(cp, "SELECT status, last_error FROM event_consumption WHERE event_seq = 1"),
    ).toEqual([["skipped", null]]);
  });

  test("a skip refused by the fence appends no consumption skipped event", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp);
    cp.prepare(
      "UPDATE lease SET holder = 'usurper', epoch = 2 WHERE resource = 'consumer:secretary'",
    ).run();

    expectRefusal(
      () =>
        markSkipped(cp, {
          consumerId: "secretary",
          eventSeq: 1,
          writerEpoch: 1,
          reason: "not applicable",
          settledAtMs: T0 + 10,
          eventId: "evt-skip-1",
          ingestedAtMs: T0 + 10,
        }),
      StaleConsumerRefused,
    );

    // One event on the spine: the original. A skip with no audit event is
    // unreachable because the settle and the append share one transaction.
    expect(count(cp, "event")).toBe(1);
    expect(rows(cp, "SELECT status FROM event_consumption")).toEqual([["pending"]]);
  });

  test("every skipped consumption has a consumption skipped event naming it", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    addConsumer(cp, "completion");
    append(cp);
    markSkipped(cp, {
      consumerId: "secretary",
      eventSeq: 1,
      writerEpoch: 1,
      reason: "not applicable",
      settledAtMs: T0 + 10,
      eventId: "evt-skip-1",
      ingestedAtMs: T0 + 10,
    });

    const skipped = rows(
      cp,
      "SELECT consumer_id, event_seq FROM event_consumption WHERE status = 'skipped'",
    );
    const audited = rows(
      cp,
      "SELECT dedup_key FROM event WHERE event_type = 'consumption_skipped'",
    );
    expect(skipped.map(([c, s]) => `consumption_skipped/${String(c)}/${String(s)}`)).toEqual(
      audited.map(([key]) => key),
    );
  });
});

// --------------------------------------------------------------------------
// drain -- section 5.5, per consumer and never global
// --------------------------------------------------------------------------

describe("drain -- section 5.5, per consumer and never global", () => {
  test("one consumer draining does not move another consumers numbers the relay scan regression", () => {
    // The twenty-day failure, as a regression test.
    //
    // `tools/relay_scan.py` let 134 terminal events sit undelivered for twenty
    // days behind a scan that reported nothing wrong. A single `drained_at`
    // column reaches the same outcome by a different route: the first consumer
    // to finish marks the row drained and every other consumer's backlog becomes
    // invisible. So the property is asserted directly -- `secretary` drains
    // everything, and `completion`'s depth, frontier and head-of-line age are all
    // exactly what they were before it did.
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    addConsumer(cp, "completion");
    append(cp, { eventId: "evt-1", at: T0 });
    append(cp, { eventId: "evt-2", at: T0 + 1_000 });

    const before = [
      backlogDepth(cp, { consumerId: "completion" }),
      drainFrontier(cp, { consumerId: "completion" }),
      headOfLineAgeMs(cp, { consumerId: "completion", nowMs: T0 + 5_000 }),
    ];
    expect(before).toEqual([2, 1, 5_000]);

    for (const seq of [1, 2]) {
      markConsumed(cp, {
        consumerId: "secretary",
        eventSeq: seq,
        writerEpoch: 1,
        settledAtMs: T0 + 2_000,
      });
    }

    expect(backlogDepth(cp, { consumerId: "secretary" })).toBe(0);
    expect(drainFrontier(cp, { consumerId: "secretary" })).toBeNull();
    expect(headOfLineAgeMs(cp, { consumerId: "secretary", nowMs: T0 + 5_000 })).toBeNull();
    expect([
      backlogDepth(cp, { consumerId: "completion" }),
      drainFrontier(cp, { consumerId: "completion" }),
      headOfLineAgeMs(cp, { consumerId: "completion", nowMs: T0 + 5_000 }),
    ]).toEqual(before);
  });

  test("drain frontier is derived from the rows and never stored", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp, { eventId: "evt-1", at: T0 });
    append(cp, { eventId: "evt-2", at: T0 + 1_000 });

    expect(drainFrontier(cp, { consumerId: "secretary" })).toBe(1);
    markConsumed(cp, {
      consumerId: "secretary",
      eventSeq: 1,
      writerEpoch: 1,
      settledAtMs: T0 + 10,
    });
    expect(drainFrontier(cp, { consumerId: "secretary" })).toBe(2);

    // Nothing was written to make the frontier move: no column anywhere holds
    // it, so it cannot drift out of agreement with the consumption rows.
    const columns = new Set<string>();
    for (const table of ["consumer", "event_consumption", "event"]) {
      for (const row of cp.pragma(`table_info(${table})`) as { name: string }[]) {
        columns.add(row.name);
      }
    }
    // Anti-vacuity: an empty column set would satisfy the filter below while
    // saying nothing at all.
    expect(columns.size).toBeGreaterThan(0);
    expect(
      [...columns].filter((name) => name.includes("frontier") || name.includes("cursor")),
    ).toEqual([]);
  });

  test("a failed row still counts as backlog and holds the frontier", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp, { eventId: "evt-1", at: T0 });
    append(cp, { eventId: "evt-2", at: T0 + 1_000 });
    markFailed(cp, {
      consumerId: "secretary",
      eventSeq: 1,
      writerEpoch: 1,
      lastError: "destination refused",
      nowMs: T0 + 10,
    });
    markConsumed(cp, {
      consumerId: "secretary",
      eventSeq: 2,
      writerEpoch: 1,
      settledAtMs: T0 + 2_000,
    });

    // A cursor could not express this; per-event rows can.
    expect(backlogDepth(cp, { consumerId: "secretary" })).toBe(1);
    expect(drainFrontier(cp, { consumerId: "secretary" })).toBe(1);
  });

  test("head of line age is measured from our ingest clock not the providers", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    appendEvent(cp, {
      eventId: "evt-1",
      eventType: "ci_observed",
      subjectKind: "run",
      subjectId: "run-1",
      dedupKey: "dk/1",
      producer: "gh-watcher",
      occurredAtMs: T0 - 900_000, // the provider's clock, far behind ours
      ingestedAtMs: T0,
    });
    expect(headOfLineAgeMs(cp, { consumerId: "secretary", nowMs: T0 + 30_000 })).toBe(30_000);
  });

  test("undrained is per consumer and carries the event it is about", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp, { eventId: "evt-1" });

    const row = onlyOne(undrained(cp, { consumerId: "secretary" }));
    expect(row.eventId).toBe("evt-1");
    expect(row.eventType).toBe("ci_observed");
    expect(row.ingestedAtMs).toBe(T0);
    expect(undrained(cp, { consumerId: "nobody" })).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// the module's own vocabulary
// --------------------------------------------------------------------------

describe("the module's own vocabulary", () => {
  test("the event type vocabulary is the modules own and not a schema constraint", () => {
    const cp = cpFixture();
    addRun(cp);
    expect(EVENT_TYPES.has("consumption_skipped")).toBe(true);
    // The DDL leaves event_type open text on purpose: a closed CHECK would make
    // every new producer a schema change.
    const appended = append(cp, { eventType: "something.this.module.never.emits" });
    expect(appended.duplicate).toBe(false);
  });

  test("a malformed argument is refused before anything is written", () => {
    const cp = cpFixture();
    addRun(cp);
    expectRefusal(
      () => append(cp, { at: "not-a-timestamp" as unknown as number }),
      EventSpineUsageError,
    );
    expectRefusal(() => append(cp, { payload: "not json" }), EventSpineUsageError);
    expect(count(cp, "event")).toBe(0);
  });
});

// --------------------------------------------------------------------------
// section 5.6 -- the two reconcile passes
//
// Both bind a revision the caller resolved, so both are proved with **two
// revisions on record**: a read that forgot the predicate still returns rows,
// and only a second revision carrying a different tolerance can tell a bound
// read from an unbound one. Each boundary is asserted on the exact millisecond
// the design names, because "exceeds" and "at or exceeds" differ by one row and
// only at that instant.
// --------------------------------------------------------------------------

/**
 * A later policy revision, carrying new tolerances for the named classes.
 *
 * Everything but the tolerance is carried from the seed: what these tests vary
 * is `T`, and varying `L` as well would let a budget CHECK, rather than the
 * binding, decide whether the row inserts.
 */
function addRevision(
  cp: SqliteDatabase,
  options: {
    readonly note: string;
    readonly effectiveAtMs: number;
    readonly thresholds?: Readonly<Record<string, readonly [kind: string, value: number]>>;
  },
): number {
  const info = cp
    .prepare("INSERT INTO policy_revision (note, decided_by, effective_at_ms) VALUES (?, ?, ?)")
    .run(options.note, "test", options.effectiveAtMs);
  const revisionId = Number(info.lastInsertRowid);
  for (const [incidentClass, [thresholdKind, thresholdValue]] of Object.entries(
    options.thresholds ?? {},
  )) {
    cp.prepare(
      `
            INSERT INTO policy_detection_latency
                (revision_id, incident_class, threshold_kind, threshold_value,
                 reconcile_period_ms, budget_ms, budget_kind)
            VALUES (?, ?, ?, ?, 120000, 900000, 'absolute_ms')
            `,
    ).run(revisionId, incidentClass, thresholdKind, thresholdValue);
  }
  return revisionId;
}

/** consumer_backlog, seeded: T = 5 min (time-base-policy.md 3.2). */
const BACKLOG_T = 300_000;
/** relay_delivery_stall, seeded: T = 2 min. */
const DELIVERY_T = 120_000;

function seededRevision(cp: SqliteDatabase): number {
  return effectiveRevisionId(cp, { nowMs: T0 });
}

// -- the undrained-events pass ---------------------------------------------

describe("the undrained-events pass", () => {
  test("a consumer inside the backlog tolerance is not named", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp, { eventId: "evt-1", at: T0 });

    const revision = seededRevision(cp);
    // On the bound, and one millisecond short of it: T is what the work is
    // ENTITLED to (time-base-policy.md 3.1), so neither instant is abnormal.
    expect(backloggedConsumers(cp, { revisionId: revision, nowMs: T0 + BACKLOG_T - 1 })).toEqual(
      [],
    );
    expect(backloggedConsumers(cp, { revisionId: revision, nowMs: T0 + BACKLOG_T })).toEqual([]);

    const named = backloggedConsumers(cp, { revisionId: revision, nowMs: T0 + BACKLOG_T + 1 });
    expect(named.map((row) => row.consumerId)).toEqual(["secretary"]);
    expect(named[0]?.headOfLineAgeMs).toBe(BACKLOG_T + 1);
    expect(named[0]?.toleranceMs).toBe(BACKLOG_T);
    expect(named[0]?.revisionId).toBe(revision);
    expect(named[0]?.incidentClass).toBe("consumer_backlog");
  });

  test("the backlog threshold follows the revision the caller bound", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp, { eventId: "evt-1", at: T0 });

    const seed = seededRevision(cp);
    const tighter = addRevision(cp, {
      note: "tighter consumer backlog",
      effectiveAtMs: T0 + 1_000,
      thresholds: { consumer_backlog: ["absolute_ms", 60_000] },
    });
    const now = T0 + 90_000; // inside the seed's 5 min, past the later revision's 1 min

    // The same rows, the same instant, two answers -- which is the whole reason
    // the revision is an argument and not something this query picks for itself.
    expect(backloggedConsumers(cp, { revisionId: seed, nowMs: now })).toEqual([]);
    expect(
      backloggedConsumers(cp, { revisionId: tighter, nowMs: now }).map((row) => row.consumerId),
    ).toEqual(["secretary"]);
    // And a read that had forgotten the predicate would match BOTH rows and
    // report the consumer under either binding; this asserts it reports one
    // tolerance, the bound one.
    expect(backloggedConsumers(cp, { revisionId: tighter, nowMs: now })[0]?.toleranceMs).toBe(
      60_000,
    );
  });

  test("the pass never resolves a revision for itself", () => {
    // A default would be D-0031's corollary reintroduced one call deeper, where
    // a report and a detector could no longer disagree about which instant they
    // are judging. The shape is asserted so a later "convenience" has to delete
    // a test that says why it must not.
    //
    // Adapted from `inspect.signature(...).parameters`, which has no ESM
    // analogue. Two halves, as `migrator.test.ts` does for `dir(m)`: the runtime
    // half proves no default is *supplied* -- an omitted argument is refused
    // rather than resolved -- and the source half proves the declaration has no
    // default and that the two functions take the same parameters, which is the
    // `parameters.keys() == parameters.keys()` assertion.
    const cp = cpFixture();

    // Runtime half. `Function.length` counts parameters before the first one
    // with a default, so a defaulted `options` would make this 1.
    expect(backloggedConsumers.length).toBe(2);
    expect(orphanedOutbox.length).toBe(2);
    const missing = [{ revisionId: seededRevision(cp) }, { nowMs: T0 }] as unknown as {
      revisionId: number;
      nowMs: number;
    }[];
    for (const options of missing) {
      expectRefusal(() => backloggedConsumers(cp, options), EventSpineUsageError);
      expectRefusal(() => orphanedOutbox(cp, options), EventSpineUsageError);
    }

    // Source half: the declared parameters, and no `?` or `=` on either.
    const source = readFileSync(
      fileURLToPath(new URL("../../src/control_plane/events.ts", import.meta.url)),
      "utf8",
    );
    // Anti-vacuity: a source read that came back empty would make every
    // assertion below pass while proving nothing at all.
    expect(source.length).toBeGreaterThan(0);
    const parametersOf = (name: string): string[] => {
      const declaration = new RegExp(
        `export function ${name}\\(\\s*connection: SqliteDatabase,\\s*options: \\{([^}]*)\\}`,
      ).exec(source);
      expect(declaration, `${name} must be declared over an options object`).not.toBeNull();
      const members = [...(declaration?.[1] ?? "").matchAll(/readonly (\w+)(\??):/g)].map(
        ([, parameter, optional]) => `${parameter}${optional}`,
      );
      expect(members.length, `${name} must declare parameters`).toBeGreaterThan(0);
      return members;
    };
    const parameters = parametersOf("backloggedConsumers");
    // No `?` suffix on either: an optional parameter is where a default lands.
    expect(parameters).toEqual(["revisionId", "nowMs"]);
    expect(parametersOf("orphanedOutbox")).toEqual(parameters);
    // And no default in the destructuring either, which is the other place a
    // TypeScript default can hide once the declaration is required.
    for (const name of ["backloggedConsumers", "orphanedOutbox"]) {
      const body = new RegExp(
        `export function ${name}\\([^)]*\\)[^{]*\\{\\s*(const \\{[^}]*\\} = options;)`,
      ).exec(source);
      expect(body, `${name} must destructure its options`).not.toBeNull();
      expect(body?.[1]).toBe("const { revisionId, nowMs } = options;");
    }
  });

  test("a revision that decides no backlog tolerance refuses rather than passing", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp, { eventId: "evt-1", at: T0 });
    const silent = addRevision(cp, { note: "decides nothing", effectiveAtMs: T0 + 1_000 });

    // An empty tuple here would be indistinguishable from "no consumer is
    // backlogged", which is the twenty-day failure with a policy table in it.
    expectRefusal(
      () => backloggedConsumers(cp, { revisionId: silent, nowMs: T0 + 10 * BACKLOG_T }),
      PolicyRowMissing,
    );
    expectRefusal(
      () => orphanedOutbox(cp, { revisionId: silent, nowMs: T0 + 10 * BACKLOG_T }),
      PolicyRowMissing,
    );
  });

  test("a count threshold is refused and not read as milliseconds", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp, { eventId: "evt-1", at: T0 });
    const counted = addRevision(cp, {
      note: "backlog as a count",
      effectiveAtMs: T0 + 1_000,
      thresholds: { consumer_backlog: ["consecutive_count", 5] },
    });
    // Read as 5 ms, every consumer alive would be reported as backlogged.
    expectRefusal(
      () => backloggedConsumers(cp, { revisionId: counted, nowMs: T0 + 10 }),
      NotADuration,
    );
  });

  test("the pass is per consumer and one drain does not hide another", () => {
    // relay_scan.py's twenty-day silence as a regression test: with a global
    // oldest-undrained figure, 'brisk' draining the head of the spine would
    // empty this result while 'stuck' was still stuck.
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "stuck");
    addConsumer(cp, "brisk");
    append(cp, { eventId: "evt-1", at: T0 });
    markConsumed(cp, { consumerId: "brisk", eventSeq: 1, writerEpoch: 1, settledAtMs: T0 + 10 });

    const now = T0 + BACKLOG_T + 1;
    const named = backloggedConsumers(cp, { revisionId: seededRevision(cp), nowMs: now });
    expect(named.map((row) => row.consumerId)).toEqual(["stuck"]);

    // There is no global shape to fall back on: every row names a consumer.
    expect(named.every((row) => Object.hasOwn(row, "consumerId"))).toBe(true);
    expect(named[0]?.backlogDepth).toBe(1);
  });

  test("the age is taken at the frontier row and not at the oldest ingest", () => {
    // ingested_at_ms is the caller's value (no column has a DEFAULT), so a
    // producer catching up can commit an OLDER instant at a HIGHER sequence.
    // Head-of-line blocking is about the row at the front, so seq 1 is the row
    // that must be aged -- MIN(ingested_at_ms) would age seq 2 instead and
    // report a backlog five minutes before there is one.
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp, { eventId: "evt-1", at: T0 + 400_000 });
    append(cp, { eventId: "evt-2", at: T0 });

    const revision = seededRevision(cp);
    const now = T0 + 400_000 + BACKLOG_T; // the frontier is exactly on its bound
    expect(backloggedConsumers(cp, { revisionId: revision, nowMs: now })).toEqual([]);

    const named = backloggedConsumers(cp, { revisionId: revision, nowMs: now + 1 });
    expect(named[0]?.drainFrontier).toBe(1);
    expect(named[0]?.ingestedAtMs).toBe(T0 + 400_000);
    expect(named[0]?.headOfLineAgeMs).toBe(BACKLOG_T + 1);
    expect(named[0]?.backlogDepth).toBe(2);
  });

  test("a failed row keeps a consumer in the pass and a settle removes it", () => {
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp, { eventId: "evt-1", at: T0 });
    markFailed(cp, {
      consumerId: "secretary",
      eventSeq: 1,
      writerEpoch: 1,
      lastError: "destination refused",
      nowMs: T0 + 10,
    });

    const revision = seededRevision(cp);
    const now = T0 + BACKLOG_T + 1;
    // 'failed' is undrained (section 5.5): a consumer cannot make its own
    // backlog disappear by failing, and the attempt does not reset the age.
    expect(
      backloggedConsumers(cp, { revisionId: revision, nowMs: now }).map((row) => row.consumerId),
    ).toEqual(["secretary"]);

    // Settled inside the lease window the consumer actually holds (the fence
    // validates expiry at the settle's own clock), and the pass goes quiet at
    // the same later instant it was reporting a moment ago.
    markConsumed(cp, {
      consumerId: "secretary",
      eventSeq: 1,
      writerEpoch: 1,
      settledAtMs: T0 + 30_000,
    });
    expect(backloggedConsumers(cp, { revisionId: revision, nowMs: now })).toEqual([]);
  });

  test("a skipped consumption does not count as backlog", () => {
    // Why 'skipped' exists at all: an inapplicable subscription that stayed
    // 'pending' would age into a consumer_backlog incident forever.
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp, { eventId: "evt-1", at: T0 });
    markSkipped(cp, {
      consumerId: "secretary",
      eventSeq: 1,
      writerEpoch: 1,
      reason: "not applicable to this repo",
      settledAtMs: T0 + 10,
      eventId: "evt-skip",
      ingestedAtMs: T0 + 10,
    });
    expect(
      backloggedConsumers(cp, {
        revisionId: seededRevision(cp),
        nowMs: T0 + 100 * BACKLOG_T,
      }),
    ).toEqual([]);
  });
});

// -- the orphaned-outbox pass ----------------------------------------------

/**
 * Append an event with a `delivery` subscriber, returning its message id.
 *
 * The outbox row is written by the append transaction itself (section 5.4), so
 * this pass is aged over exactly the rows the spine enqueued rather than over a
 * fixture's idea of one.
 */
function aDelivery(
  cp: SqliteDatabase,
  consumerId = "secretary",
  options: { readonly eventId?: string; readonly at?: number } = {},
): string {
  const at = options.at ?? T0;
  addConsumer(cp, consumerId, { kind: "delivery", recipient: "secretary-inbox", at });
  const appended = append(cp, { eventId: options.eventId ?? "evt-1", at });
  return appended.messages[0] as string;
}

describe("the orphaned-outbox pass", () => {
  test("an unacked message is orphaned strictly past the delivery tolerance", () => {
    const cp = cpFixture();
    addRun(cp);
    const messageId = aDelivery(cp);
    const revision = seededRevision(cp);

    expect(orphanedOutbox(cp, { revisionId: revision, nowMs: T0 + DELIVERY_T })).toEqual([]);
    const orphaned = orphanedOutbox(cp, { revisionId: revision, nowMs: T0 + DELIVERY_T + 1 });
    expect(orphaned.map((row) => row.messageId)).toEqual([messageId]);
    expect(orphaned[0]?.ageMs).toBe(DELIVERY_T + 1);
    expect(orphaned[0]?.toleranceMs).toBe(DELIVERY_T);
    expect(orphaned[0]?.revisionId).toBe(revision);
    expect(orphaned[0]?.status).toBe("pending");
  });

  test("the delivery threshold follows the revision the caller bound", () => {
    const cp = cpFixture();
    addRun(cp);
    aDelivery(cp);
    const seed = seededRevision(cp);
    const tighter = addRevision(cp, {
      note: "tighter delivery stall",
      effectiveAtMs: T0 + 1_000,
      thresholds: { relay_delivery_stall: ["absolute_ms", 30_000] },
    });
    const now = T0 + 60_000; // inside the seed's 2 min, past the later revision's 30 s

    expect(orphanedOutbox(cp, { revisionId: seed, nowMs: now })).toEqual([]);
    expect(orphanedOutbox(cp, { revisionId: tighter, nowMs: now })).toHaveLength(1);
  });

  test("a delivered but unacked message is the case the pass exists for", () => {
    const cp = cpFixture();
    addRun(cp);
    const messageId = aDelivery(cp);
    cp.prepare(
      "UPDATE outbox SET status = 'delivered', delivered_at_ms = ? WHERE message_id = ?",
    ).run(T0 + 1_000, messageId);
    const now = T0 + DELIVERY_T + 1;

    // status = 'pending' would go quiet here, and this is precisely the crash
    // window: the send landed, the ack did not come back.
    const orphaned = orphanedOutbox(cp, { revisionId: seededRevision(cp), nowMs: now });
    expect(orphaned.map((row) => [row.messageId, row.status])).toEqual([[messageId, "delivered"]]);

    cp.prepare("UPDATE outbox SET status = 'acked', acked_at_ms = ? WHERE message_id = ?").run(
      now,
      messageId,
    );
    expect(orphanedOutbox(cp, { revisionId: seededRevision(cp), nowMs: now })).toEqual([]);
  });

  test("the pass mutates nothing at all", () => {
    // Section 5.6 re-attempts; this function only NAMES. A detector that bumped
    // retry_count would inflate the evidence an operator reads to decide whether
    // a destination is refusing -- and outbox_retry_count_is_monotonic would not
    // catch it, because an increment is exactly what that trigger permits.
    const cp = cpFixture();
    addRun(cp);
    aDelivery(cp);
    const before = rows(cp, "SELECT * FROM outbox");
    orphanedOutbox(cp, { revisionId: seededRevision(cp), nowMs: T0 + 100 * DELIVERY_T });
    expect(rows(cp, "SELECT * FROM outbox")).toEqual(before);
  });

  test("the orphan query uses the partial index written to serve it", () => {
    // 0003_outbox_cancelled_status.sql: CREATE INDEX outbox_undelivered ON
    // outbox(enqueued_at_ms) WHERE status IN ('pending', 'delivered'). Both the
    // indexable predicate form and the arithmetic one return the same rows, so
    // only the PLAN distinguishes them -- and outbox rows are never deleted, so
    // a scan grows without bound.
    //
    // This EXPLAINs the constant the FUNCTION executes, not a copy pasted here.
    // The pasted form was in this test and it stayed green while the shipped
    // predicate was rewritten into the degraded arithmetic below, which is the
    // whole regression the assertion claims to catch.
    const path = dbPathFixture();
    const cp = cpFixture(path);
    const params = {
      now_ms: T0,
      tolerance_ms: DELIVERY_T,
      revision_id: 1,
      incident_class: "relay_delivery_stall",
    };
    // The plan of the statement the FUNCTION ran, captured from the driver.
    const plan = explain(cp, executedOutboxSql(cp, path));
    expect(plan).toContain("SEARCH");
    expect(plan).toContain("outbox_undelivered");
    expect(plan).not.toContain("SCAN");

    // The algebraically identical form does not: the column is inside an
    // expression, which no b-tree can seek on. Asserting this half is what makes
    // the half above mean something -- without it, a database where every plan
    // says SEARCH would also pass.
    expect(DEGRADED_ORPHANED_OUTBOX_SQL).not.toBe(ORPHANED_OUTBOX_SQL);
    const degraded = explain(cp, DEGRADED_ORPHANED_OUTBOX_SQL, params);
    // SQLite still names outbox_undelivered here -- it reads the partial index
    // as a narrower covering table -- but the verb is SCAN, not SEARCH: every
    // unfinished row ever enqueued is visited and the age is evaluated per row.
    // So the assertion is on the verb, never on the index name.
    expect(degraded).not.toContain("SEARCH");
    expect(degraded).toContain("SCAN");
  });

  test("the two forms the plan test separates return the same rows", () => {
    // If they disagreed on rows, the plan comparison would be comparing two
    // different questions and the index claim would be vacuous.
    const cp = cpFixture();
    addRun(cp);
    aDelivery(cp);
    const params = {
      now_ms: T0 + DELIVERY_T + 1,
      tolerance_ms: DELIVERY_T,
      revision_id: 1,
      incident_class: "relay_delivery_stall",
    };
    const shipped = rowsOfSql(cp, ORPHANED_OUTBOX_SQL, params);
    expect(shipped).toEqual(rowsOfSql(cp, DEGRADED_ORPHANED_OUTBOX_SQL, params));
    expect(shipped).not.toEqual([]);
  });

  test("the two passes answer about different rows of the same append", () => {
    // One append writes both records (section 5.4), and the two backstops age
    // them against different tolerances: an ack that never came back is not the
    // same fault as a consumer that never drained, and each has its own class.
    const cp = cpFixture();
    addRun(cp);
    const messageId = aDelivery(cp);
    const revision = seededRevision(cp);

    const mid = T0 + DELIVERY_T + 1; // past the delivery T, inside the backlog T
    expect(
      orphanedOutbox(cp, { revisionId: revision, nowMs: mid }).map((row) => row.messageId),
    ).toEqual([messageId]);
    expect(backloggedConsumers(cp, { revisionId: revision, nowMs: mid })).toEqual([]);

    const late = T0 + BACKLOG_T + 1;
    expect(
      backloggedConsumers(cp, { revisionId: revision, nowMs: late }).map((row) => row.consumerId),
    ).toEqual(["secretary"]);
  });

  test("a retired consumer is not backlogged however long its rows sit", () => {
    // The rows a consumer left behind when it was retired stay pending forever.
    // Section 5.6's remedy for this class -- raise consumer_backlog, drain the
    // consumer -- has nobody left to perform it, so reporting one is an alarm no
    // action can clear. _subscribers already refuses to fan out to a retired
    // consumer for exactly this reason; the detector has to agree with it.
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "secretary");
    append(cp);
    const revision = seededRevision(cp);
    const late = T0 + BACKLOG_T + 1;

    expect(
      backloggedConsumers(cp, { revisionId: revision, nowMs: late }).map((row) => row.consumerId),
    ).toEqual(["secretary"]);

    cp.prepare("UPDATE consumer SET retired_at_ms = ? WHERE consumer_id = 'secretary'").run(T0 + 1);

    // The pending rows are still there -- retirement is not a drain, and the
    // fan-out history has to stay explicable.
    expect(backlogDepth(cp, { consumerId: "secretary" })).toBe(1);
    for (const now of [late, T0 + 1_000 * BACKLOG_T]) {
      expect(backloggedConsumers(cp, { revisionId: revision, nowMs: now })).toEqual([]);
    }
  });

  test("retiring one consumer does not hide another that is still stuck", () => {
    // The exclusion must be per consumer. A filter that dropped the whole
    // frontier CTE on any retirement would be the twenty-day silence again.
    const cp = cpFixture();
    addRun(cp);
    addConsumer(cp, "gone");
    addConsumer(cp, "stuck");
    append(cp);
    cp.prepare("UPDATE consumer SET retired_at_ms = ? WHERE consumer_id = 'gone'").run(T0 + 1);

    expect(
      backloggedConsumers(cp, {
        revisionId: seededRevision(cp),
        nowMs: T0 + BACKLOG_T + 1,
      }).map((row) => row.consumerId),
    ).toEqual(["stuck"]);
  });

  test("a malformed reconcile argument is refused before policy is read", () => {
    const cp = cpFixture();
    expectRefusal(
      () => backloggedConsumers(cp, { revisionId: 0, nowMs: T0 }),
      EventSpineUsageError,
    );
    expectRefusal(
      () =>
        backloggedConsumers(cp, {
          revisionId: seededRevision(cp),
          nowMs: "soon" as unknown as number,
        }),
      EventSpineUsageError,
    );
    expectRefusal(() => orphanedOutbox(cp, { revisionId: -1, nowMs: T0 }), EventSpineUsageError);
  });
});
