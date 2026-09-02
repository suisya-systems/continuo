/**
 * S7 -- the outbox: resend, ack, dedup, and the declared exactly-once mechanism.
 *
 * Ported from interlock `tests/control_plane/test_outbox.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping is recorded in the parity
 * ledger.
 *
 * **These tests are the durable half of Issue `#14` (D-0026).** The outbox they
 * exercise is throwaway; the questions are not. They are written so that
 * whatever replaces `src/control_plane/outbox.ts` still has to answer the same
 * ones, which is why the assertions are about **records** -- our rows, and the
 * destination's own ledger -- rather than about the shape of any API.
 *
 * One rule runs through the exactly-once cases and is worth stating before the
 * first of them, because it is the criterion easiest to satisfy by accident.
 * `ACCEPTANCE.md` section 2:
 *
 *     *A case that asserts exactly-once for an external effect using only our
 *     own rows does not pass.*
 *
 * So every exactly-once assertion below reads {@link KeyedDropbox.effectCount}
 * -- the **destination's** count of effects it actually applied -- and the
 * strongest of them ("the exactly once evidence outlives our database") deletes
 * the control-plane database first, so that no row of ours can be what makes it
 * pass.
 *
 * Translation notes, each a rule rather than a local choice:
 *
 * * The `db_path`, `cp` and `dropbox` fixtures are plain functions called inside
 *   the test (conventions rule 8); every connection registers its `close()` with
 *   `onTestFinished` at the point of acquisition (rule 1). Paths are built with
 *   `node:path`'s `join`, never with a `/` (rule 6).
 * * The `caseRoot` label is `s7`, the source's own nickname for this spike
 *   (D-0020). No refusal this file asserts on interpolates a filesystem path --
 *   the outbox's refusals name the lease resource and holder, and the
 *   destination's name themselves -- and no `match` literal below occurs in
 *   `<tmp>/continuo-s7-w0-XXXX/control-plane.sqlite3`, so no `match` can be made
 *   unfailable by the temp path.
 * * `sqlite3.IntegrityError` becomes {@link expectSqliteError} on the result
 *   **code** (`SQLITE_CONSTRAINT*`) as well as the message (D-0016).
 * * The source's bare `ValueError`s become `OutboxUsageError`, this module's
 *   per-module usage-error class, exactly as `lease.py`'s become
 *   `LeaseUsageError`; the `match=` half is unchanged.
 * * Python's `None` for an absent lease row is `undefined` here (D-0007), never
 *   `null` -- so `assert refused.value.observed is None` is `toBeUndefined()`.
 * * Three cases reach for the Python runtime rather than for the module:
 *   `ActionHandler.__subclasses__()`, `tokenize`, and `subprocess`. The first
 *   two are translated the way `migrator.test.ts`'s "the module exposes no down
 *   migration api" translates `dir(m)` -- a runtime half plus a scan over the
 *   module's own source text, each with an explicit anti-vacuity assertion so a
 *   scan that matched nothing fails instead of passing. The third stays a real
 *   child process, as `spike-schema.test.ts`'s "state survives the process that
 *   wrote it" does.
 * * Two `caseRoot`-scoped `KeyedDropbox` subclasses override internals the
 *   source overrides (`_fsync_root`, `_honour_token`). Those members are
 *   `protected` rather than `private` in `destination.ts` for that reason:
 *   Python has no access control and the source's cases subclass them directly.
 */

import { AssertionError } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import * as destinationModule from "../../src/control_plane/destination.js";
import {
  type DeliveryReceipt,
  type Destination,
  DestinationRefusal,
  destinationSeams,
  KeyedDropbox,
  LOCK_NAME,
  StaleTokenRefused,
} from "../../src/control_plane/destination.js";
import * as handlersModule from "../../src/control_plane/handlers.js";
import {
  HUMAN_GATED_RECIPIENT,
  HumanGatedHandler,
  NOTIFY_RECIPIENT,
  NotifyDestinationHandler,
  spikeRegistry,
} from "../../src/control_plane/handlers.js";
import * as leaseModule from "../../src/control_plane/lease.js";
import { FencedStatement } from "../../src/control_plane/lease.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import * as outboxModule from "../../src/control_plane/outbox.js";
import {
  _COUNT_ATTEMPT,
  _DEGRADED_DUE_QUERY,
  _DUE_QUERY,
  _MARK_DELIVERED,
  _PENDING_ACTION,
  ActionHandler,
  CancelledBeforeEffect,
  CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
  CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
  CHECKPOINT_BEFORE_DURABLE_WRITE,
  CHECKPOINT_DELIVERED_BEFORE_ACK,
  CHECKPOINTS,
  EXACTLY_ONCE_MECHANISMS,
  HandlerRegistry,
  HandlerRejected,
  HumanGateRequired,
  OUTBOX_STATUSES,
  Outbox,
  type OutboxMessage,
  OutboxUsageError,
  outboxSeams,
  StaleWriterRefused,
  TERMINAL_OUTBOX_STATUSES,
  UNOWNED_OUTBOX_QUERY,
  UNSUPPORTED_MECHANISMS,
} from "../../src/control_plane/outbox.js";
import {
  createControlPlane,
  loadSchemaSql,
  openControlPlane,
  reconstruct,
} from "../../src/control_plane/schema.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { expectRefusal, expectSqliteError } from "../testkit/errors.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const RESOURCE = "outbox-of-run-1";
const HOLDER = "writer-a";
const EPOCH = 1;
const TTL_MS = 30_000;

/** The result code family a schema trigger's `RAISE(ABORT, ...)` produces. */
const CONSTRAINT = /^SQLITE_CONSTRAINT/;

/** Where the three ported modules live, for the two source-scanning cases. */
const CONTROL_PLANE_DIR = fileURLToPath(new URL("../../src/control_plane/", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../../src/", import.meta.url));

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------

/**
 * The database's name inside a case root, shared with {@link spikeTemplate} so
 * that a copy lands exactly where {@link dbPathFixture} says it does.
 */
const DATABASE_NAME = "control-plane.sqlite3";

/**
 * The database every case starts from, built once for this file (D-0029).
 *
 * The same template D-0028 introduced for `spike-schema.test.ts`, applied to
 * the third of the three files that build a *spike* control plane.
 * `createControlPlane` takes a path and nothing else, so every one of this
 * file's 50 fixture calls was already asking for a byte-identical database.
 * Measured N=30 on this box: 97.5ms to create one against 2.70ms to copy and
 * open one, the cost being fsyncs rather than the DDL.
 *
 * The template is the bare schema; this file's two seed rows stay in
 * {@link cpFixture}, so all three files' template declarations are the same
 * four lines (D-0027).
 *
 * The one `existsSync(dbPath)` assertion in this file is not the absence
 * assertion that would rule the copy out: it sits directly after the case's own
 * `unlinkSync`, and asserts the deletion that case performed rather than that
 * nothing was ever created. Neither does any case patch a `schemaSeams` entry;
 * the `patchSeam` calls here replace `outboxSeams` and `destinationSeams`.
 */
const spikeTemplate = suiteTemplate(DATABASE_NAME, (path) => {
  createControlPlane(path).close();
});

/**
 * The source's `db_path` fixture: a name inside a per-test directory.
 *
 * The file at that name now exists -- it is a fresh copy of
 * {@link spikeTemplate}. The root is the caller's, because several cases put
 * the dropbox beside the database in the same directory.
 */
function dbPathFixture(root: string): string {
  return spikeTemplate.copyInto(root, DATABASE_NAME);
}

/**
 * The source's `cp` fixture: a spike control plane holding one run and one lease.
 *
 * Opened rather than created, for D-0027's reason: the same two pragmas either
 * way, and opening verifies the copy is at head, so a template that built the
 * wrong thing is a typed refusal at the first case.
 */
function cpFixture(dbPath: string): SqliteDatabase {
  const connection = openControlPlane(dbPath);
  closeWhenFinished(connection);
  connection
    .prepare(
      "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms)" +
        " VALUES ('run-1', 'running', ?, ?)",
    )
    .run(T0, T0);
  connection
    .prepare(
      "INSERT INTO lease (resource, holder, epoch, acquired_at_ms, expires_at_ms)" +
        " VALUES (?, ?, ?, ?, ?)",
    )
    .run(RESOURCE, HOLDER, EPOCH, T0, T0 + TTL_MS);
  return connection;
}

/** The counterparty. A directory outside the database, on purpose. */
function dropboxFixture(root: string): KeyedDropbox {
  return new KeyedDropbox(join(root, "destination"), "spike-dropbox");
}

/**
 * Register a connection's `close()` at the moment it is acquired (rule 1).
 *
 * Guarded, because several cases close their connection mid-test the way the
 * source does; closing an already-closed handle is not a reason to fail a
 * passing test.
 */
function closeWhenFinished(connection: SqliteDatabase): void {
  onTestFinished(() => {
    try {
      connection.close();
    } catch {
      // already closed by the test itself
    }
  });
}

/**
 * The source's `_Kills.Killed`: the exception a kill point raises.
 *
 * A class of its own rather than a bare `Error`, so a case asserting the kill
 * happened cannot be satisfied by an unrelated failure.
 */
class Killed extends Error {}

/**
 * A checkpoint that raises once, at a named point.
 *
 * S9 (Issue `#15`) builds the deterministic harness. This is the minimum S7
 * needs to prove its own windows are real: a kill is an exception out of the
 * named point, and the assertion is about what the database and the destination
 * hold afterwards.
 */
class Kills {
  at: string | null;
  readonly seen: string[] = [];

  constructor(at: string | null = null) {
    this.at = at;
  }

  /** Bound at construction, so it can be handed straight to `checkpoint`. */
  readonly call = (name: string): void => {
    this.seen.push(name);
    if (name === this.at) {
      this.at = null; // one kill, so a retry can get past it
      throw new Killed(name);
    }
  };
}

function makeOutbox(
  cp: SqliteDatabase,
  dropbox: Destination,
  options: {
    readonly checkpoint?: (name: string) => void;
    readonly registry?: HandlerRegistry;
    readonly holder?: string;
  } = {},
): Outbox {
  const { checkpoint, registry, holder = HOLDER } = options;
  return new Outbox(cp, {
    resource: RESOURCE,
    holder,
    registry: registry !== undefined ? registry : spikeRegistry(dropbox),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
  });
}

function enqueue(
  outbox: Outbox,
  options: {
    readonly messageId?: string;
    readonly dedupKey?: string;
    readonly payload?: string;
    readonly recipient?: string;
    readonly at?: number;
  } = {},
): OutboxMessage {
  const {
    messageId = "msg-1",
    dedupKey = "dk-1",
    payload = '{"body":"hello"}',
    recipient = NOTIFY_RECIPIENT,
    at = T0,
  } = options;
  return outbox.enqueue({
    messageId,
    recipient,
    payload,
    dedupKey,
    nowMs: at,
    epoch: EPOCH,
    runId: "run-1",
  });
}

/**
 * The effect key a handler derives from a dedup key.
 *
 * Spelled out here rather than inlined at thirty call sites so that the
 * namespacing rule -- recipient, then action kind, then the dedup key -- has one
 * place to be read and one place to change.
 */
function keyFor(dedupKey: string, recipient = NOTIFY_RECIPIENT, kind = "notify"): string {
  return `${recipient}:${kind}:${dedupKey}`;
}

function actionsOf(
  cp: SqliteDatabase,
  where: Readonly<Record<string, unknown>> = {},
): Record<string, unknown>[] {
  const keys = Object.keys(where);
  const clause = keys.length > 0 ? keys.map((key) => `${key} = :${key}`).join(" AND ") : "1";
  const statement = cp.prepare(`SELECT * FROM action WHERE ${clause} ORDER BY action_id`);
  const rows = keys.length > 0 ? statement.all(where) : statement.all();
  return rows as Record<string, unknown>[];
}

/** `SELECT COUNT(*)`, read positionally -- it is not a plain column reference. */
function countOf(cp: SqliteDatabase, sql: string, ...params: unknown[]): number {
  return cp
    .prepare(sql)
    .pluck()
    .get(...(params as never[])) as number;
}

/** Directory entries ending in `suffix`, sorted -- Python's `Path.glob`. */
function globOf(directory: string, suffix: string): string[] {
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(suffix))
    .sort();
}

// --------------------------------------------------------------------------
// criterion 1 -- the handler names its mechanism, and a test asserts the name
//
// "so a later handler cannot be added without one" is the operative half. It is
// asserted twice: over the registry, which cannot admit an undeclared handler,
// and over every handler class in the package, which catches one that bypassed
// the registry.
// --------------------------------------------------------------------------

describe("criterion 1 -- the handler names its mechanism, and a test asserts the name", () => {
  test("every registered handler names its exactly once mechanism", () => {
    const dropbox = dropboxFixture(caseRoot("s7"));
    const registry = spikeRegistry(dropbox);
    expect(
      registry.handlers().length,
      "the spike registry must contain at least one handler",
    ).toBeGreaterThan(0);
    for (const handler of registry.handlers()) {
      expect(
        EXACTLY_ONCE_MECHANISMS as readonly string[],
        `${handler.constructor.name} does not name one of the mechanisms ` +
          "ACCEPTANCE.md section 2 requires",
      ).toContain(handler.exactlyOnceMechanism);
    }
  });

  test("every handler class in the package names one too", () => {
    // The same criterion, reached without going through the registry.
    //
    // A handler that is never registered still ships, and the next author will
    // copy whichever one they find. `ActionHandler` itself is the abstract base
    // and is excluded -- its empty declaration is what makes a subclass that
    // forgets fail rather than inherit an answer.
    //
    // Adapted from `ActionHandler.__subclasses__()`, which has no runtime
    // analogue: JavaScript keeps no registry of a class's subclasses. Two
    // halves, and both are needed. The runtime half walks the package's own
    // module namespaces, which -- unlike `__subclasses__()` -- cannot pick up
    // the handlers the cases below define, so the source's "restricted to
    // classes that actually ship" filter is structural here rather than a
    // module-name test. The source-scan half catches a handler class that ships
    // in these modules without being exported, which the namespace walk alone
    // would miss.
    const dropbox = dropboxFixture(caseRoot("s7"));
    const namespaces: readonly (readonly [string, Record<string, unknown>])[] = [
      ["outbox.ts", outboxModule as unknown as Record<string, unknown>],
      ["handlers.ts", handlersModule as unknown as Record<string, unknown>],
      ["destination.ts", destinationModule as unknown as Record<string, unknown>],
    ];
    const shipped = new Map<string, ActionHandler>();
    for (const [, namespace] of namespaces) {
      for (const exported of Object.values(namespace)) {
        if (typeof exported !== "function" || exported === ActionHandler) {
          continue;
        }
        if (!(exported.prototype instanceof ActionHandler)) {
          continue;
        }
        // The declaration is an instance field here, where Python's is a class
        // attribute, so the class has to be built to be asked. Every shipping
        // handler takes either nothing or the destination it delivers to.
        const built =
          exported.length === 0
            ? new (exported as new () => ActionHandler)()
            : new (exported as new (destination: Destination) => ActionHandler)(dropbox);
        shipped.set(exported.name, built);
      }
    }
    expect(shipped.size, "there is no handler to check, which is itself a failure").toBeGreaterThan(
      0,
    );
    for (const [name, handler] of shipped) {
      expect(
        EXACTLY_ONCE_MECHANISMS as readonly string[],
        `${name} ships without naming an exactly-once mechanism`,
      ).toContain(handler.exactlyOnceMechanism);
    }

    // The scan half: a handler class declared in these modules but not exported
    // would never reach the namespace walk above, and so would never be
    // checked. Fixpoint, because a handler may extend another handler.
    // Walked over the WHOLE of src/, not just the three modules above.
    // `__subclasses__()` sees every subclass the interpreter has loaded,
    // wherever it was declared; a scan limited to three files would miss a
    // handler added under another directory, and this case would then be
    // narrower than its source rather than adapted to it.
    const declared = new Map<string, string>();
    const sourceFiles: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          sourceFiles.push(full);
        }
      }
    };
    walk(SRC_DIR);
    // Anti-vacuity for the walk itself: a glob that stopped matching would make
    // the scan below vacuous before it ever looked at a class.
    expect(sourceFiles.length).toBeGreaterThan(10);
    for (const file of sourceFiles) {
      // ASCII-only sources (D-0006).
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/class\s+(\w+)\s+extends\s+(\w+)/g)) {
        declared.set(match[1] as string, match[2] as string);
      }
    }
    // Anti-vacuity: a scan that matched nothing would make the loop below pass
    // while proving nothing at all.
    expect(declared.size).toBeGreaterThan(0);
    const handlerClasses = new Set<string>(["ActionHandler"]);
    for (let pass = 0; pass < declared.size + 1; pass += 1) {
      for (const [name, base] of declared) {
        if (handlerClasses.has(base)) {
          handlerClasses.add(name);
        }
      }
    }
    handlerClasses.delete("ActionHandler");
    expect(handlerClasses.size).toBeGreaterThan(0);
    for (const name of handlerClasses) {
      expect(
        [...shipped.keys()],
        `${name} ships without being reachable for the check above`,
      ).toContain(name);
    }
  });

  test("the mechanism names are exactly the ddls", () => {
    // The constant and the schema's CHECK cannot drift apart.
    //
    // Two enumerations of the same clause is one more than is safe, so they are
    // pinned to each other: a mechanism added to the DDL without being added
    // here would be registrable-but-unwritable, and the reverse would be
    // writable-but-unregistrable.
    const cp = cpFixture(dbPathFixture(caseRoot("s7")));

    const ddl = loadSchemaSql();
    for (const mechanism of EXACTLY_ONCE_MECHANISMS) {
      expect(ddl).toContain(`'${mechanism}'`);
    }

    const stored = cp
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'action'")
      .pluck()
      .get() as string;
    // sqlite_master keeps the DDL verbatim, comments included, and the comment
    // on each branch of this CHECK explains the mechanism it names.
    const executable = stored
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    const afterOpen = executable.split("exactly_once_mechanism IN (")[1];
    expect(afterOpen).toBeDefined();
    const enumerated = (afterOpen as string).split(")")[0] as string;
    expect(new Set([...enumerated.matchAll(/'([^']+)'/g)].map((match) => match[1]))).toEqual(
      new Set(EXACTLY_ONCE_MECHANISMS),
    );
  });

  test("a handler that names no mechanism is refused registration", () => {
    class Undeclared extends ActionHandler {
      override readonly recipient: string = "somewhere";
      override readonly actionKind: string = "something";
      // exactlyOnceMechanism deliberately not set
    }

    expectRefusal(
      () => new HandlerRegistry().register(new Undeclared()),
      HandlerRejected,
      "exactly_once_mechanism",
    );
  });

  test("a handler that invents a mechanism is refused registration", () => {
    class Inventive extends ActionHandler {
      override readonly recipient: string = "somewhere";
      override readonly actionKind: string = "something";
      override readonly exactlyOnceMechanism: string = "best_effort";
    }

    expectRefusal(
      () => new HandlerRegistry().register(new Inventive()),
      HandlerRejected,
      "best_effort",
    );
  });

  test("the declared mechanism reaches the durable record", () => {
    // The declaration is not decoration: it is written to the action row.
    //
    // Item 4's evidence is an idempotency record, and a record that did not say
    // *how* it is made exactly-once would be claiming a guarantee without
    // naming what holds it.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    const outcome = outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });

    const rows = actionsOf(cp, { action_id: outcome.actionId });
    expect(rows.length).toBe(1);
    expect(rows[0]?.exactly_once_mechanism).toBe("destination_idempotency_key");
    expect(outcome.exactlyOnceMechanism).toBe(rows[0]?.exactly_once_mechanism);
  });

  test("the chosen handler is not a human gate case", () => {
    // Issue #14: *if the chosen handler turns out to be such a case, say so and
    // pick a different one*.
    //
    // The handler that carries the spike's delivery declares a real mechanism,
    // and it has a counterparty implementing it. The human-gate branch exists
    // as a declaration (see below) rather than as the delivery path.
    const dropbox = dropboxFixture(caseRoot("s7"));

    const handler = spikeRegistry(dropbox).forRecipient(NOTIFY_RECIPIENT);
    expect(handler.exactlyOnceMechanism).toBe("destination_idempotency_key");
    expect(handler).toBeInstanceOf(NotifyDestinationHandler);
    expect((handler as NotifyDestinationHandler).destination).toBe(dropbox);
  });

  test("declaring a destination mechanism requires a destination", () => {
    expectRefusal(
      () => new NotifyDestinationHandler({} as unknown as Destination),
      TypeError,
      "Destination",
    );
  });
});

// --------------------------------------------------------------------------
// criterion 2 -- ack is idempotent; a lost ack resends, never loses
// --------------------------------------------------------------------------

describe("criterion 2 -- ack is idempotent; a lost ack resends, never loses", () => {
  test("a lost ack causes a resend and the effect count stays one", () => {
    // The headline ack case, end to end.
    //
    // The ack never arrives, so the message stays due and is delivered again --
    // twice more, to make the point that the resend is unbounded rather than
    // lucky. Our row shows the resends; the destination shows one effect.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    const key = keyFor(message.dedupKey);

    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });
    expect(
      outbox.due(T0 + 20).map((m) => m.messageId),
      "a delivered message with no ack must stay due -- that is the resend",
    ).toEqual(["msg-1"]);

    outbox.attempt(message.messageId, { nowMs: T0 + 20, epoch: EPOCH });
    outbox.attempt(message.messageId, { nowMs: T0 + 30, epoch: EPOCH });

    expect(dropbox.attemptCount(key), "the destination was offered the effect three times").toBe(3);
    expect(dropbox.effectCount(key), "and applied it once").toBe(1);
    expect(outbox.load(message.messageId).retryCount).toBe(3);

    const outcome = outbox.recordAck(message.messageId, { nowMs: T0 + 40 });
    expect(outcome.recorded).toBe(true);
    expect(outbox.due(T0 + 50), "an acked message is not due").toEqual([]);
  });

  test("a duplicate ack changes nothing", () => {
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });

    const first = outbox.recordAck(message.messageId, { nowMs: T0 + 20 });
    const before = outbox.load(message.messageId);

    for (const later of [T0 + 21, T0 + 22, T0 + 999]) {
      const repeat = outbox.recordAck(message.messageId, { nowMs: later });
      expect(repeat.recorded, "only the first ack records anything").toBe(false);
      expect(repeat.ackedAtMs).toBe(first.ackedAtMs);
    }

    expect(outbox.load(message.messageId), "the row is byte-identical afterwards").toStrictEqual(
      before,
    );
  });

  test("a late ack after a restart changes nothing", () => {
    // The ack arrives after the sender has died and come back.
    //
    // The connection is closed and reopened between the ack and its duplicate,
    // so nothing in memory can be what makes the second one a no-op.
    const root = caseRoot("s7");
    const dbPath = dbPathFixture(root);
    const cp = cpFixture(dbPath);
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });
    outbox.recordAck(message.messageId, { nowMs: T0 + 20 });
    cp.close();

    const restarted = openControlPlane(dbPath);
    closeWhenFinished(restarted);
    const after = makeOutbox(restarted, dropbox);
    const late = after.recordAck(message.messageId, { nowMs: T0 + 5_000 });
    expect(late.recorded).toBe(false);
    expect(late.ackedAtMs).toBe(T0 + 20);
    expect(after.load(message.messageId).status).toBe("acked");
  });

  test("the message shows exactly one acked state however many acks arrive", () => {
    // *Message identity in SQLite shows exactly one acked state regardless of
    // ack multiplicity* -- asserted as a count over the table, not over a
    // return value, because the return value is this module's and the row is
    // the gate's.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });
    for (let at = T0 + 20; at < T0 + 30; at += 1) {
      outbox.recordAck(message.messageId, { nowMs: at });
    }

    const count = countOf(
      cp,
      "SELECT COUNT(*) FROM outbox WHERE message_id = ? AND status = 'acked'" +
        "   AND acked_at_ms IS NOT NULL",
      message.messageId,
    );
    expect(count).toBe(1);
  });

  test("an ack for an undelivered message is refused", () => {
    // An ack with no delivery behind it is evidence of a lost record.
    //
    // Accepting it would move the row to 'acked' without a delivery instant,
    // which S5's CHECK forbids anyway -- but refusing it here says *why*,
    // rather than surfacing an IntegrityError from three layers down.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    expectRefusal(
      () => outbox.recordAck(message.messageId, { nowMs: T0 + 10 }),
      OutboxUsageError,
      "not been delivered",
    );
  });

  test("an ack under backward clock skew is kept and the clamp is reported", () => {
    // ACCEPTANCE.md section 2 skews the clock backwards on purpose.
    //
    // S5's `acked_at_ms >= delivered_at_ms` CHECK would refuse the row, and
    // losing a real ack to a clock skew is the worse failure. The lifecycle
    // order is preserved and the disagreement is **reported** rather than
    // applied silently -- a caller that cares can see that its clock ran
    // behind.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 1_000, epoch: EPOCH });

    const skewed = outbox.recordAck(message.messageId, { nowMs: T0 + 500 });
    expect(skewed.recorded).toBe(true);
    expect(skewed.clockClamped, "the clamp must not be silent").toBe(true);
    expect(skewed.ackedAtMs).toBe(T0 + 1_000);
    expect(outbox.load(message.messageId).status).toBe("acked");
  });

  test("an ack is recorded even after the writers lease moved on", () => {
    // The ack is deliberately unfenced, and that is a decision worth pinning.
    //
    // An ack is the recipient reporting what it already did. Refusing to record
    // it because our own lease moved on would turn a delivered message back
    // into an undelivered one and resend an effect that is already present --
    // the fence protects writes that *drive* effects, and this drives none.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });

    cp.prepare("UPDATE lease SET holder = 'writer-b', epoch = 2 WHERE resource = ?").run(RESOURCE);

    expect(outbox.recordAck(message.messageId, { nowMs: T0 + 20 }).recorded).toBe(true);
  });
});

// --------------------------------------------------------------------------
// criterion 3 -- retry count is monotonic across a process restart
// --------------------------------------------------------------------------

describe("criterion 3 -- retry count is monotonic across a process restart", () => {
  test("the retry count counts attempts not successes", () => {
    // *Hold the recipient unavailable across several retry attempts.*
    //
    // Attempts that by construction never succeed still have to be counted,
    // which is why the increment is committed before the effect is attempted
    // rather than after it succeeds.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    class Unavailable extends ActionHandler {
      override readonly recipient: string = NOTIFY_RECIPIENT;
      override readonly actionKind: string = "notify";
      override readonly exactlyOnceMechanism: string = "destination_idempotency_key";

      override apply(): DeliveryReceipt {
        throw new DestinationRefusal("the recipient is unavailable");
      }
    }

    const registry = new HandlerRegistry();
    registry.register(new Unavailable());
    const outbox = makeOutbox(cp, dropbox, { registry });
    const message = enqueue(outbox);

    for (let attempt = 1; attempt < 4; attempt += 1) {
      expectRefusal(
        () => outbox.attempt(message.messageId, { nowMs: T0 + attempt, epoch: EPOCH }),
        DestinationRefusal,
      );
      expect(outbox.load(message.messageId).retryCount).toBe(attempt);
    }

    expect(outbox.load(message.messageId).status, "nothing was delivered").toBe("pending");
    expect(
      outbox.due(T0 + 100).map((m) => m.messageId),
      "and it is still due",
    ).toEqual(["msg-1"]);
  });

  test("the retry count is monotonic across a process restart", () => {
    // Monotonic *across a process restart* -- so the restart is a real one.
    //
    // A second connection in this process would still share module state. The
    // claim is that the count lives in the database, so the reading process is
    // a fresh interpreter that was never told anything.
    const root = caseRoot("s7");
    const dbPath = dbPathFixture(root);
    const cp = cpFixture(dbPath);
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });
    outbox.attempt(message.messageId, { nowMs: T0 + 20, epoch: EPOCH });
    const before = outbox.load(message.messageId).retryCount;
    expect(before).toBe(2);
    cp.close();

    // Where Python hands the child `sys.executable -c <program>` and a
    // PYTHONPATH, the child here needs one more piece: the modules are
    // TypeScript, and their relative imports carry the `.js` suffixes NodeNext
    // requires (D-0002). So the child registers a resolve hook that falls back
    // to the `.ts` file, and runs under Node's type stripping. Both files are
    // written into the case's own directory and are ASCII-only (D-0006).
    const hook = join(root, "resolve-ts-hook.mjs");
    writeFileSync(
      hook,
      [
        "// Resolve the '.js' specifiers of a NodeNext TypeScript graph to the",
        "// '.ts' files they name, so a child process can import src/ directly.",
        "export async function resolve(specifier, context, nextResolve) {",
        "  try {",
        "    return await nextResolve(specifier, context);",
        "  } catch (error) {",
        '    if (specifier.startsWith(".") && specifier.endsWith(".js")) {',
        '      return await nextResolve(specifier.slice(0, -3) + ".ts", context);',
        "    }",
        "    throw error;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    const program = join(root, "restarted-sender.mjs");
    writeFileSync(
      program,
      [
        'import { register } from "node:module";',
        'import { join } from "node:path";',
        'import { pathToFileURL } from "node:url";',
        "",
        "// pathToFileURL, never a bare path: a Windows path is not a URL, and a",
        "// dynamic import of one fails before the code under test runs.",
        "register(pathToFileURL(process.argv[2]).href);",
        "const dir = process.argv[3];",
        "const load = (name) => import(pathToFileURL(join(dir, name)).href);",
        'const schema = await load("schema.ts");',
        'const destination = await load("destination.ts");',
        'const handlers = await load("handlers.ts");',
        'const outboxModule = await load("outbox.ts");',
        "const connection = schema.openControlPlane(process.argv[4]);",
        "const outbox = new outboxModule.Outbox(connection, {",
        "  resource: process.argv[6],",
        "  holder: process.argv[7],",
        "  registry: handlers.spikeRegistry(new destination.KeyedDropbox(process.argv[5])),",
        "});",
        'const before = outbox.load("msg-1").retryCount;',
        'outbox.attempt("msg-1", { nowMs: Number(process.argv[8]), epoch: 1 });',
        'process.stdout.write(JSON.stringify({ before, after: outbox.load("msg-1").retryCount }));',
        "connection.close();",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = spawnSync(
      process.execPath,
      [
        ...stripTypesFlags(),
        program,
        hook,
        CONTROL_PLANE_DIR,
        dbPath,
        join(root, "destination"),
        RESOURCE,
        HOLDER,
        String(T0 + 30),
      ],
      { encoding: "utf-8" },
    );
    // Report the child's own words. A bare status assertion carries the exit
    // code and nothing else, which is a failure nobody can diagnose from a CI
    // log.
    expect(
      result.status,
      `the restarted sender exited ${result.status}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0);

    const seen = JSON.parse(result.stdout) as { before: number; after: number };
    expect(seen.before, "the restarted process inherited the count from SQLite alone").toBe(before);
    expect(seen.after, "and continued it upwards rather than restarting it").toBe(before + 1);
  });

  test("the retry count cannot be walked backwards", () => {
    // S5's trigger, asserted from S7's side.
    //
    // The schema tests own this rule; it is re-asserted here because the outbox
    // is what would violate it, and a later rewrite of this module must not be
    // able to drop the guarantee by writing its own UPDATE.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });
    expectSqliteError(
      () => cp.prepare("UPDATE outbox SET retry_count = 0 WHERE message_id = ?").run("msg-1"),
      { code: CONSTRAINT, message: /retry_count/ },
    );
  });
});

/**
 * The flags the child needs to run TypeScript sources.
 *
 * Node strips types without a flag from 22.18.0 and 23.6.0 onward; earlier
 * releases in this package's supported range (>=22.14.0) need
 * `--experimental-strip-types`. Asking the running interpreter rather than
 * passing the flag unconditionally keeps the child from failing on a release
 * that has retired it.
 */
function stripTypesFlags(): string[] {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const stripsByDefault = major > 22 || (major === 22 && minor >= 18);
  return stripsByDefault ? ["--no-warnings"] : ["--experimental-strip-types", "--no-warnings"];
}

// --------------------------------------------------------------------------
// criterion 4 -- no outbox row remains in a state with no owner after recovery
// --------------------------------------------------------------------------

describe("criterion 4 -- no outbox row remains in a state with no owner after recovery", () => {
  test("a row is owned from the instant it is enqueued", () => {
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox);
    expect(
      outbox.unowned(T0),
      "an enqueue that left the row unowned would satisfy the forbidden state " +
        "the moment it committed",
    ).toEqual([]);
  });

  test("rows orphaned by a dead epoch are adopted by recovery", () => {
    // The crash case: the epoch that owned the rows died with its holder.
    //
    // A new holder takes the lease at a higher epoch, and recovery re-stamps
    // the orphans so that the criterion's query comes back empty.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox, { messageId: "msg-1", dedupKey: "dk-1" });
    enqueue(outbox, { messageId: "msg-2", dedupKey: "dk-2" });

    const later = T0 + TTL_MS + 1; // epoch 1's lease has expired
    expect([...outbox.unowned(later)].sort()).toEqual(["msg-1", "msg-2"]);

    cp.prepare("UPDATE lease SET holder = ?, epoch = 2, expires_at_ms = ? WHERE resource = ?").run(
      "writer-b",
      later + TTL_MS,
      RESOURCE,
    );

    const successor = makeOutbox(cp, dropbox, { holder: "writer-b" });
    const report = successor.recover({ nowMs: later, epoch: 2 });

    expect([...report.adopted].sort()).toEqual(["msg-1", "msg-2"]);
    expect(report.stillUnowned).toEqual([]);
    expect(successor.unowned(later)).toEqual([]);
  });

  test("recovery adopts nothing when the recovering holders lease is not live", () => {
    // A recovering process without a live lease must not claim the orphans.
    //
    // Adopting them would be exactly the stale writer the fence exists to
    // reject, arriving through the recovery path. Recovery reports the rows as
    // still unowned rather than reporting success.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox);

    const later = T0 + TTL_MS + 1;
    const impostor = makeOutbox(cp, dropbox, { holder: "writer-b" });
    const report = impostor.recover({ nowMs: later, epoch: 99 });

    expect(report.adopted).toEqual([]);
    expect(report.stillUnowned).toEqual(["msg-1"]);
    expect(outbox.load("msg-1").writerEpoch, "the row kept its epoch").toBe(EPOCH);
  });

  test("an acked row is never unowned", () => {
    // Ownership is about rows that still need someone to advance them.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });
    outbox.recordAck(message.messageId, { nowMs: T0 + 20 });

    expect(outbox.unowned(T0 + TTL_MS + 10_000)).toEqual([]);
  });

  test("the ownership criterion is a query anyone can run", () => {
    // D-0001: the answer is readable from SQLite without this module.
    //
    // `UNOWNED_OUTBOX_QUERY` is exported as SQL for the same reason S5 keeps
    // its reconstruction reads as data -- an operator with a database recovered
    // from a crash can run it by hand.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox);
    const later = T0 + TTL_MS + 1;

    // `.raw()`: the source reads `row[0]`, positionally.
    const rows = cp
      .prepare(UNOWNED_OUTBOX_QUERY)
      .raw()
      .all({ resource: RESOURCE, now_ms: later }) as unknown[][];
    expect(rows.map((row) => row[0])).toEqual(["msg-1"]);
    expect(rows.map((row) => row[0])).toEqual([...outbox.unowned(later)]);
  });

  test("a reconstructed process sees every unfinished row", () => {
    // S5's reconstruction and S7's ownership answer the same question together.
    //
    // *No outbox row remains in a state with no owner after recovery* is only
    // meaningful if recovery can see every unfinished row in the first place.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox, { messageId: "msg-1", dedupKey: "dk-1" });
    enqueue(outbox, { messageId: "msg-2", dedupKey: "dk-2" });
    outbox.attempt("msg-2", { nowMs: T0 + 10, epoch: EPOCH });
    outbox.recordAck("msg-2", { nowMs: T0 + 20 });

    const state = reconstruct(cp, T0 + 30);
    expect(state.unfinishedOutbox.map((row) => row["message_id"])).toEqual(["msg-1"]);
  });
});

// --------------------------------------------------------------------------
// criterion 5 -- duplicate delivery causes exactly one effect
// criterion 6 -- and the evidence for an external effect is the destination's
//
// ACCEPTANCE.md section 2: *a case that asserts exactly-once for an external
// effect using only our own rows does not pass.* Every assertion in this section
// reads the destination's ledger.
// --------------------------------------------------------------------------

describe("criterion 5 -- duplicate delivery causes exactly one effect", () => {
  test("duplicate delivery causes exactly one effect", () => {
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    const key = keyFor(message.dedupKey);

    const first = outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });
    const second = outbox.attempt(message.messageId, { nowMs: T0 + 20, epoch: EPOCH });

    expect(first.deduplicated, "the first attempt applied the effect").toBe(false);
    expect(second.deduplicated, "and the destination refused the second").toBe(true);
    expect(dropbox.attemptCount(key)).toBe(2);
    expect(dropbox.effectCount(key)).toBe(1);
    expect(dropbox.effects()).toEqual([key]);
  });

  test("one effect record per dedup key", () => {
    // *One effect record per delivery dedup key* -- our half of the evidence.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    for (const at of [T0 + 10, T0 + 20, T0 + 30]) {
      outbox.attempt(message.messageId, { nowMs: at, epoch: EPOCH });
    }

    const applied = actionsOf(cp, {
      idempotency_key: keyFor(message.dedupKey),
      status: "applied",
    });
    expect(applied.length).toBe(1);
    expect(applied[0]?.applied_at_ms, "the first apply is the one on record").toBe(T0 + 10);
  });

  test("a re enqueue of the same dedup key still causes one effect", () => {
    // The case S5 left `outbox.dedup_key` non-unique for.
    //
    // A sender killed after committing an outbox row may not know it committed
    // and may legitimately enqueue the same work again under a new message id.
    // Two rows, two deliveries, one effect -- because exactly-once is a
    // property of the effect and not of the row.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox, { messageId: "msg-1", dedupKey: "shared" });
    enqueue(outbox, { messageId: "msg-1-again", dedupKey: "shared" });

    outbox.attempt("msg-1", { nowMs: T0 + 10, epoch: EPOCH });
    const second = outbox.attempt("msg-1-again", { nowMs: T0 + 20, epoch: EPOCH });

    expect(second.deduplicated).toBe(true);
    expect(dropbox.effectCount(keyFor("shared"))).toBe(1);
    expect(actionsOf(cp, { idempotency_key: keyFor("shared"), status: "applied" }).length).toBe(1);
    expect(outbox.load("msg-1").status).toBe("delivered");
    expect(
      outbox.load("msg-1-again").status,
      "the second row is delivered too -- its effect is present, which is what delivered means",
    ).toBe("delivered");
  });

  test("a kill after the effect and before its record replays to one effect", () => {
    // The injection point that proves idempotency rather than luck.
    //
    // The process dies after the destination applied the effect and before the
    // result was recorded. By construction our rows cannot tell that apart from
    // an effect that never started -- which is precisely why the handler's
    // declared mechanism, and not a query, is what makes the replay safe.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const kills = new Kills(CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD);
    const outbox = makeOutbox(cp, dropbox, { checkpoint: kills.call });
    const message = enqueue(outbox);
    const key = keyFor(message.dedupKey);

    expectRefusal(
      () => outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH }),
      Killed,
    );

    // The ambiguous window, described exactly: the effect happened, our record
    // does not say so, and nothing in SQLite can distinguish this from the
    // effect never having started.
    expect(dropbox.effectCount(key)).toBe(1);
    expect(actionsOf(cp, { idempotency_key: key })[0]?.status).toBe("pending");

    outbox.attempt(message.messageId, { nowMs: T0 + 20, epoch: EPOCH });

    expect(dropbox.attemptCount(key), "the replay was offered to the destination").toBe(2);
    expect(dropbox.effectCount(key), "which refused it -- one effect, still").toBe(1);
    expect(actionsOf(cp, { idempotency_key: key })[0]?.status).toBe("applied");
    expect(outbox.load(message.messageId).status).toBe("delivered");
  });

  test("a kill after the record and before the effect loses nothing", () => {
    // The middle injection point. The intent is durable; the effect is not yet.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const kills = new Kills(CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT);
    const outbox = makeOutbox(cp, dropbox, { checkpoint: kills.call });
    const message = enqueue(outbox);
    const key = keyFor(message.dedupKey);

    expectRefusal(
      () => outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH }),
      Killed,
    );

    expect(dropbox.effectCount(key), "no effect happened").toBe(0);
    expect(actionsOf(cp, { idempotency_key: key })[0]?.status).toBe("pending");
    expect(outbox.due(T0 + 15).map((m) => m.messageId)).toEqual([message.messageId]);

    outbox.attempt(message.messageId, { nowMs: T0 + 20, epoch: EPOCH });
    expect(dropbox.effectCount(key)).toBe(1);
  });

  test("a kill before the durable write loses nothing", () => {
    // The first injection point. Nothing has been attempted, and the row is due.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const kills = new Kills(CHECKPOINT_BEFORE_DURABLE_WRITE);
    const outbox = makeOutbox(cp, dropbox, { checkpoint: kills.call });
    const message = enqueue(outbox);

    expectRefusal(
      () => outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH }),
      Killed,
    );

    expect(outbox.load(message.messageId).retryCount).toBe(0);
    expect(outbox.load(message.messageId).status).toBe("pending");
    expect(outbox.due(T0 + 15).map((m) => m.messageId)).toEqual([message.messageId]);
  });

  test("a kill after delivery and before the ack resends to one effect", () => {
    // The outbox row's own window: delivered, never acked, sender dies.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const kills = new Kills(CHECKPOINT_DELIVERED_BEFORE_ACK);
    const outbox = makeOutbox(cp, dropbox, { checkpoint: kills.call });
    const message = enqueue(outbox);
    const key = keyFor(message.dedupKey);

    expectRefusal(
      () => outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH }),
      Killed,
    );

    expect(outbox.load(message.messageId).status).toBe("delivered");
    expect(outbox.due(T0 + 15).map((m) => m.messageId)).toEqual([message.messageId]);

    outbox.attempt(message.messageId, { nowMs: T0 + 20, epoch: EPOCH });
    outbox.recordAck(message.messageId, { nowMs: T0 + 30 });
    expect(dropbox.effectCount(key)).toBe(1);
  });

  test("every named checkpoint is actually reached", () => {
    // A window no harness can stop inside is one nobody can prove anything
    // about.
    //
    // S9 (Issue `#15`) binds to these names, so S7 owes it the guarantee that
    // each one is on the path rather than merely declared.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const kills = new Kills();
    const outbox = makeOutbox(cp, dropbox, { checkpoint: kills.call });
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });

    expect(kills.seen).toEqual([...CHECKPOINTS]);
  });

  test("the exactly once evidence outlives our database", () => {
    // The strongest form of the criterion, and the reason this suite has a
    // separate destination at all.
    //
    // `ACCEPTANCE.md` section 2 rejects a case that asserts exactly-once for an
    // external effect *using only our own rows*. So the control-plane database
    // is **deleted** and the question is put to the destination, which is the
    // party that would have carried a duplicate effect had one happened.
    // Nothing we wrote can be what makes this pass.
    const root = caseRoot("s7");
    const dbPath = dbPathFixture(root);
    const cp = cpFixture(dbPath);
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    const key = keyFor(message.dedupKey);
    for (const at of [T0 + 10, T0 + 20, T0 + 30, T0 + 40]) {
      outbox.attempt(message.messageId, { nowMs: at, epoch: EPOCH });
    }
    cp.close();

    unlinkSync(dbPath);
    expect(existsSync(dbPath)).toBe(false);

    expect(dropbox.attemptCount(key), "four deliveries were offered").toBe(4);
    expect(dropbox.effectCount(key), "the destination applied exactly one").toBe(1);
    expect(dropbox.effects()).toEqual([key]);
    expect(JSON.parse(dropbox.payloadOf(key) || "{}")).toEqual({ body: "hello" });
  });

  test("the destination refuses a key that is already bound to another payload", () => {
    // A dedup-key collision must not pass as an exactly-once success.
    //
    // An idempotency key names an effect. The same key carrying different
    // content is a collision, and applying nothing while reporting success
    // would hide it behind the very guarantee it breaks.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox, { messageId: "msg-1", dedupKey: "shared", payload: '{"body":"one"}' });
    outbox.attempt("msg-1", { nowMs: T0 + 10, epoch: EPOCH });

    enqueue(outbox, { messageId: "msg-2", dedupKey: "shared", payload: '{"body":"two"}' });
    expectRefusal(
      () => outbox.attempt("msg-2", { nowMs: T0 + 20, epoch: EPOCH }),
      DestinationRefusal,
      "different payload",
    );

    expect(dropbox.effectCount(keyFor("shared"))).toBe(1);
    expect(JSON.parse(dropbox.payloadOf(keyFor("shared")) || "{}")).toEqual({ body: "one" });
    expect(outbox.load("msg-2").status, "and msg-2 was not recorded delivered").toBe("pending");
  });

  test("an apply that dies before publishing leaves nothing behind", () => {
    // The destination's own crash window, closed by construction.
    //
    // The record is written complete to a private file and then published with
    // `fs.linkSync`, so a crash mid-apply leaves a staging file and nothing
    // else: no effect, and -- the part that matters -- nothing occupying the
    // key. The reservation design this replaced was wrong in both directions,
    // and the dangerous half was the recovery: a second caller cannot
    // distinguish "the creator died" from "the creator has not written yet", so
    // treating an incomplete file as abandoned means truncating a file another
    // process is actively writing and letting two effects proceed at once.
    const destinationRoot = join(caseRoot("s7"), "destination");
    const dropbox = new KeyedDropbox(destinationRoot);

    // Python raises a bare `RuntimeError`, which has no JavaScript analogue --
    // `Error` is the base of every refusal in this file, so asserting on it
    // would also admit a `DestinationRefusal`. A class declared here keeps the
    // source's discrimination.
    class KilledAfterStaging extends Error {}
    class DiesBeforePublishing extends KeyedDropbox {
      protected override _fsyncRoot(): void {
        throw new KilledAfterStaging("killed after staging, before the link");
      }
    }

    const dying = new DiesBeforePublishing(destinationRoot);
    // `fs.linkSync` happens before `_fsyncRoot`, so this kills the apply after
    // the key is taken -- the worst instant for the *next* attempt.
    expectRefusal(() => dying.apply("k", "payload"), KilledAfterStaging);

    // The link did land, so the key is taken by a complete record. That is the
    // point: there is no instant at which the key exists and its record does
    // not.
    expect(dropbox.effectCount("k")).toBe(1);
    expect(globOf(destinationRoot, ".staging"), "the staging file is cleaned up").toEqual([]);

    const second = dropbox.apply("k", "payload");
    expect(second.deduplicated, "and the next attempt is deduplicated").toBe(true);
    expect(dropbox.effectCount("k")).toBe(1);
  });

  test("a damaged published record is refused rather than applied twice", () => {
    // A partial record is not evidence, and it is not licence to apply again.
    //
    // Publishing is atomic, so a record that does not read back whole is damage
    // rather than a lifecycle state. Applying a second effect over it would be
    // guessing that the first never landed -- exactly the inference
    // `ACCEPTANCE.md` section 2 says cannot be made -- so the destination
    // refuses and the message stays due for a human to look at.
    const destinationRoot = join(caseRoot("s7"), "destination");
    const dropbox = new KeyedDropbox(destinationRoot);
    dropbox.apply("k", "payload");
    const records = globOf(destinationRoot, ".effect.json");
    expect(records.length).toBe(1);
    const record = join(destinationRoot, records[0] as string);
    writeFileSync(record, readFileSync(record, "utf-8").replace(/\n+$/, ""), "utf-8");

    expect(dropbox.effectCount("k"), "a partial record is not an effect").toBe(0);
    expectRefusal(() => dropbox.apply("k", "payload"), DestinationRefusal, "complete record");
  });

  test("a destination refuses an empty idempotency key", () => {
    // Every effect deduplicating against every other is the failure that looks
    // most like success.
    const destinationRoot = join(caseRoot("s7"), "destination");
    expectRefusal(
      () => new KeyedDropbox(destinationRoot).apply("", "payload"),
      DestinationRefusal,
      "may not be empty",
    );
  });
});

// --------------------------------------------------------------------------
// the fence -- a stale writer is rejected, not merged, and the rejection is
// itself durable (ACCEPTANCE.md section 2)
// --------------------------------------------------------------------------

describe(
  "the fence -- a stale writer is rejected, not merged, and the rejection is itself durable " +
    "(ACCEPTANCE.md section 2)",
  () => {
    test("a stale writer is refused and the refusal is recorded", () => {
      const root = caseRoot("s7");
      const cp = cpFixture(dbPathFixture(root));
      const dropbox = dropboxFixture(root);

      const outbox = makeOutbox(cp, dropbox);
      const message = enqueue(outbox);

      cp.prepare("UPDATE lease SET holder = 'writer-b', epoch = 2 WHERE resource = ?").run(
        RESOURCE,
      );

      const refused = expectRefusal(
        () => outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH }),
        StaleWriterRefused,
      );

      const refusals = actionsOf(cp, { status: "refused" });
      expect(refusals.length, "the rejection is durable, not silently dropped").toBe(1);
      expect(String(refusals[0]?.refusal_reason)).toContain("not a live lease");
      expect(refusals[0]?.writer_epoch).toBe(EPOCH);
      expect(
        refused.actionId,
        "the exception names the durable row that records the rejection",
      ).toBe(refusals[0]?.action_id);
      const observed = refused.observed;
      expect(
        [observed?.holder, observed?.epoch],
        "and carries the lease as it actually stood at the refusal",
      ).toEqual(["writer-b", 2]);
      expect(outbox.load(message.messageId).retryCount, "and no write landed").toBe(0);
    });

    test("the refusal class is the lease owned one", () => {
      // One class, not two: #45 consolidated S7's copy into S6's.
      //
      // A caller that catches `lease.StaleWriterRefused` therefore catches the
      // outbox's refusals too, and the shared constructor obliges every raiser
      // to name the durable refusal row and the lease it actually observed.
      expect(outboxModule.StaleWriterRefused).toBe(leaseModule.StaleWriterRefused);
    });

    test("a writer that keeps returning is refused every time", () => {
      // A refused row is excluded from `action_one_effect_per_key` on purpose.
      //
      // A first refusal standing in for the rest would lose the fact that the
      // stale writer kept coming back, which is the thing triage would want to
      // see.
      const root = caseRoot("s7");
      const cp = cpFixture(dbPathFixture(root));
      const dropbox = dropboxFixture(root);

      const outbox = makeOutbox(cp, dropbox);
      const message = enqueue(outbox);
      cp.prepare("UPDATE lease SET holder = 'writer-b', epoch = 2 WHERE resource = ?").run(
        RESOURCE,
      );

      for (const at of [T0 + 10, T0 + 20, T0 + 30]) {
        expectRefusal(
          () => outbox.attempt(message.messageId, { nowMs: at, epoch: EPOCH }),
          StaleWriterRefused,
        );
      }

      expect(actionsOf(cp, { status: "refused" }).length).toBe(3);
    });

    test("an expired lease refuses the write even though the epoch matches", () => {
      // Expiry discovery alone is insufficient; the epoch is validated *in* the
      // write.
      //
      // The epoch is still 1 and the holder is still writer-a -- only the clock
      // has moved past the lease's expiry. A check-then-write would have passed
      // the check.
      const root = caseRoot("s7");
      const cp = cpFixture(dbPathFixture(root));
      const dropbox = dropboxFixture(root);

      const outbox = makeOutbox(cp, dropbox);
      const message = enqueue(outbox);

      const refused = expectRefusal(
        () => outbox.attempt(message.messageId, { nowMs: T0 + TTL_MS + 1, epoch: EPOCH }),
        StaleWriterRefused,
      );
      const refusals = actionsOf(cp, { status: "refused" });
      expect(refusals.length).toBe(1);
      expect(refused.actionId).toBe(refusals[0]?.action_id);
      const observed = refused.observed;
      expect(observed !== undefined && observed.epoch === EPOCH).toBe(true);
      expect(
        observed?.looksLiveAt(T0 + TTL_MS + 1),
        "the observed lease is the writer's own row, already expired",
      ).toBe(false);
    });

    test("the fence is one statement and not a check then write", () => {
      // The property the race depends on, asserted against the SQL itself.
      //
      // A test that only exercises behaviour cannot tell a fenced UPDATE from a
      // SELECT followed by an UPDATE that happens not to have raced yet. The
      // statements below are issued by the typed builders (#42), not
      // hand-written SQL text, so the assertion is both that the fence is
      // present *and* that it came from the one place able to produce a
      // `FencedStatement`.
      for (const statement of [_COUNT_ATTEMPT, _MARK_DELIVERED]) {
        expect(statement).toBeInstanceOf(FencedStatement);
        // `String.prototype.valueOf.call`, never `String(...)`: a
        // `FencedStatement` is a boxed string, and `String(x)` dispatches
        // through a `toString` a caller could have replaced.
        const sql = String.prototype.valueOf.call(statement) as string;
        expect(sql).toContain("EXISTS (SELECT 1");
        expect(sql).toContain("expires_at_ms > :fence_now_ms");
        expect(sql).toContain("writer_epoch = :fence_epoch");
      }
    });

    test("an outbox writer must name its lease resource and holder", () => {
      // No defaults. Which component may write which state item is `Q-0001`.
      const root = caseRoot("s7");
      const cp = cpFixture(dbPathFixture(root));
      const dropbox = dropboxFixture(root);

      for (const [resource, holder] of [
        ["", HOLDER],
        [RESOURCE, ""],
      ] as const) {
        expectRefusal(
          () => new Outbox(cp, { resource, holder, registry: spikeRegistry(dropbox) }),
          OutboxUsageError,
          "names the lease resource and holder",
        );
      }
    });
  },
);

// --------------------------------------------------------------------------
// the fence, continued -- the windows a single fenced UPDATE does not cover
// --------------------------------------------------------------------------

describe("the fence, continued -- the windows a single fenced UPDATE does not cover", () => {
  test("a stale writer cannot even enqueue", () => {
    // Enqueueing looks like the one harmless write, and it is not.
    //
    // It only adds a row -- but a holder that has lost its lease and can still
    // enqueue mutates control-plane state after being replaced, and every row
    // it writes is unowned from the instant it commits. Section 2 asks that a
    // stale writer be rejected without exempting the writes that merely create
    // work.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    cp.prepare("UPDATE lease SET holder = 'writer-b', epoch = 2 WHERE resource = ?").run(RESOURCE);

    const refused = expectRefusal(
      () => enqueue(outbox, { messageId: "msg-stale", dedupKey: "dk-stale" }),
      StaleWriterRefused,
      "refused to enqueue",
    );

    expect(countOf(cp, "SELECT COUNT(*) FROM outbox"), "no row was written").toBe(0);
    const refusals = actionsOf(cp, { status: "refused" });
    expect(refusals.length, "and the rejection is durable").toBe(1);
    expect(String(refusals[0]?.refusal_reason)).toContain("refused to enqueue");
    expect(
      refused.actionId,
      "the enqueue path names its durable row like every other refusal",
    ).toBe(refusals[0]?.action_id);
    const observed = refused.observed;
    expect([observed?.holder, observed?.epoch]).toEqual(["writer-b", 2]);
  });

  test("a refusal with no lease row at all observes none", () => {
    // The `observed` contract's other half: `undefined` when no row exists
    // (D-0007: Python's `None` for an absent row).
    //
    // A resource that has never been leased is not the same evidence as a row
    // held by somebody else, and the class promises to carry the difference
    // rather than a stale sentinel. (Never leased, not deleted: S5's trigger
    // forbids deleting lease rows, so absence can only mean the resource was
    // never taken.)
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = new Outbox(cp, {
      resource: "never-leased-resource",
      holder: HOLDER,
      registry: spikeRegistry(dropbox),
    });

    const refused = expectRefusal(
      () => enqueue(outbox, { messageId: "msg-unleased", dedupKey: "dk-unleased" }),
      StaleWriterRefused,
      "refused to enqueue",
    );

    const refusals = actionsOf(cp, { status: "refused" });
    expect(refusals.length, "the rejection is durable even with no lease row").toBe(1);
    expect(refused.actionId).toBe(refusals[0]?.action_id);
    expect(refused.observed).toBeUndefined();
  });

  test("an expired lease refuses the enqueue too", () => {
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    expectRefusal(
      () => enqueue(outbox, { messageId: "msg-late", dedupKey: "dk-late", at: T0 + TTL_MS + 1 }),
      StaleWriterRefused,
    );
    expect(countOf(cp, "SELECT COUNT(*) FROM outbox")).toBe(0);
  });

  test("the lease is re read between the durable write and the effect", () => {
    // The gap the retry-count fence does not cover.
    //
    // That UPDATE validates the lease and then *commits*; the action row is
    // written after it. A writer paused across that gap would reach the
    // destination having lost its lease in between, and no statement of ours
    // runs during the pause to notice. The re-read narrows the window -- it
    // cannot close it, which is why the epoch is also carried into the effect.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const loseTheLease = (name: string): void => {
      if (name === CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT) {
        cp.prepare("UPDATE lease SET holder = 'writer-b', epoch = 2 WHERE resource = ?").run(
          RESOURCE,
        );
      }
    };

    const outbox = makeOutbox(cp, dropbox, { checkpoint: loseTheLease });
    const message = enqueue(outbox);

    const refused = expectRefusal(
      () => outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH }),
      StaleWriterRefused,
      "before the effect was attempted",
    );

    expect(dropbox.effects(), "no effect was applied by the superseded writer").toEqual([]);
    const refusals = actionsOf(cp, { status: "refused" });
    expect(refusals.length).toBe(1);
    expect(
      refused.actionId,
      "the refusal row, not the pending intent recorded just before it",
    ).toBe(refusals[0]?.action_id);
    const observed = refused.observed;
    expect([observed?.holder, observed?.epoch]).toEqual(["writer-b", 2]);
  });

  test("the destination refuses a superseded fencing token", () => {
    // *External destinations must reject a stale token where they can enforce
    // it.*
    //
    // The one refusal available once our own writer has been paused past its
    // lease: SQLite cannot refuse a statement that is never issued, so the
    // counterparty -- the only party still running -- has to.
    const dropbox = new KeyedDropbox(join(caseRoot("s7"), "destination"));
    dropbox.apply("k-2", "payload", 2);
    expect(dropbox.honouredToken()).toBe(2);

    expectRefusal(() => dropbox.apply("k-1", "payload", 1), StaleTokenRefused, "refuses 1");
    expect(dropbox.effectCount("k-1"), "the superseded writer applied nothing").toBe(0);
  });

  test("a superseded writer is refused even when its effect is already present", () => {
    // A stale token is refused *before* the already-applied shortcut.
    //
    // Otherwise a returning stale writer would read a deduplicated success as
    // evidence that it is still the live holder -- the fence telling it the
    // opposite of what it means.
    const dropbox = new KeyedDropbox(join(caseRoot("s7"), "destination"));
    dropbox.apply("k", "payload", 1);
    dropbox.apply("other", "payload", 5);

    expectRefusal(() => dropbox.apply("k", "payload", 1), StaleTokenRefused);
  });

  test("an apply carrying no token is not fenced", () => {
    // A token that was never offered is not checked, and does not raise.
    //
    // Pretending to validate one would be the "token accepted without being
    // checked" the protocol warns about, wearing the opposite disguise.
    const dropbox = new KeyedDropbox(join(caseRoot("s7"), "destination"));
    expect(dropbox.honouredToken()).toBeNull();
    const receipt = dropbox.apply("k", "payload");
    expect(receipt.deduplicated).toBe(false);
    expect(dropbox.honouredToken()).toBeNull();
  });

  test("the fencing token reaches the destination from the outbox", () => {
    // End to end: the epoch the write was fenced against is what is carried.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });
    expect(dropbox.honouredToken(RESOURCE)).toBe(EPOCH);
  });

  test("every refusal is recorded even within one millisecond", () => {
    // A refusal identity composed from the attempt's own values collides.
    //
    // Same message, same epoch, same millisecond -- and the collision would
    // surface as an IntegrityError *instead of* the refusal being recorded,
    // losing exactly the evidence section 2 requires to be durable, in the case
    // where the stale writer is trying hardest to get in.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    cp.prepare("UPDATE lease SET holder = 'writer-b', epoch = 2 WHERE resource = ?").run(RESOURCE);

    for (let round = 0; round < 3; round += 1) {
      expectRefusal(
        () => outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH }),
        StaleWriterRefused,
      );
    }

    expect(actionsOf(cp, { status: "refused" }).length).toBe(3);
  });

  test("a handler claiming a transactional commit is refused", () => {
    // The mechanism is in the vocabulary; claiming it *here* is not honest.
    //
    // `Outbox.attempt` commits the action row before calling the handler and
    // hands it no transaction to enlist in, so a handler declaring
    // `transactional_with_record` would be admitted while the path it runs on
    // could not possibly provide the guarantee -- the same undeclared-guarantee
    // failure the registration check exists to prevent, arriving through the
    // one branch that looks declared.
    class Transactional extends ActionHandler {
      override readonly recipient: string = "somewhere";
      override readonly actionKind: string = "something";
      override readonly exactlyOnceMechanism: string = "transactional_with_record";
    }

    expectRefusal(
      () => new HandlerRegistry().register(new Transactional()),
      HandlerRejected,
      "cannot provide",
    );
  });

  test("the unsupported mechanism is still part of the vocabulary", () => {
    // Refusing to claim it is not the same as deleting it.
    //
    // The enumeration is `ACCEPTANCE.md`'s and the DDL's, not this module's,
    // and a mechanism dropped from the vocabulary could not be recorded by a
    // future handler that genuinely implements it.
    for (const mechanism of Object.keys(UNSUPPORTED_MECHANISMS)) {
      expect(EXACTLY_ONCE_MECHANISMS as readonly string[]).toContain(mechanism);
    }
  });

  test("a stale writer cannot record an effect intent", () => {
    // The action insert carries the lease predicate too.
    //
    // The retry-count update validates the lease and then *commits*, and the
    // intent is written after it, so a writer superseded in that gap would
    // otherwise still record an intent to cause an effect. There is
    // deliberately no checkpoint between those two statements -- the four that
    // exist are the ones `ACCEPTANCE.md` section 2 names -- so the guard is
    // exercised directly rather than by inventing a fifth kill point to reach
    // it.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    const handler = spikeRegistry(dropbox).forRecipient(NOTIFY_RECIPIENT);

    cp.prepare("UPDATE lease SET holder = 'writer-b', epoch = 2 WHERE resource = ?").run(RESOURCE);

    // `_ensurePendingAction` is `private` in TypeScript, which is a
    // compile-time visibility rule and not a runtime one -- the source reaches
    // the same method by its own leading-underscore convention.
    const reachable = outbox as unknown as {
      _ensurePendingAction(
        message: OutboxMessage,
        handler: ActionHandler,
        idempotencyKey: string,
        nowMs: number,
        epoch: number,
      ): unknown;
    };
    const refused = expectRefusal(
      () => reachable._ensurePendingAction(message, handler, keyFor("dk-1"), T0 + 10, EPOCH),
      StaleWriterRefused,
      "record the effect intent",
    );

    expect(actionsOf(cp, { status: "pending" }), "no intent was recorded").toEqual([]);
    const refusals = actionsOf(cp, { status: "refused" });
    expect(refusals.length).toBe(1);
    expect(String(refusals[0]?.refusal_reason)).toContain("effect intent");
    expect(refused.actionId).toBe(refusals[0]?.action_id);
    const observed = refused.observed;
    expect([observed?.holder, observed?.epoch]).toEqual(["writer-b", 2]);
  });

  test("the effect intent insert is one statement and not a check then write", () => {
    // Same property as the protected updates, asserted against the SQL.
    //
    // A behavioural test cannot tell a fenced INSERT from a SELECT followed by
    // an INSERT that happens not to have raced yet. `_PENDING_ACTION` is issued
    // by the typed builder (#42) rather than written inline, so the assertion
    // reads the statement it produced instead of scanning the method's source
    // text.
    expect(_PENDING_ACTION).toBeInstanceOf(FencedStatement);
    const sql = String.prototype.valueOf.call(_PENDING_ACTION) as string;
    expect(sql).toContain("INSERT INTO action");
    expect(sql).toContain("EXISTS (SELECT 1");
    expect(sql).toContain("expires_at_ms > :fence_now_ms");
  });

  test("a stale writer cannot park a human gated action", () => {
    // The human-gate path reaches the action table with no protected update in
    // front of it, which would have made it the one write a stale holder could
    // always land.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox, {
      messageId: "msg-gated",
      dedupKey: "dk-gated",
      recipient: HUMAN_GATED_RECIPIENT,
    });
    cp.prepare("UPDATE lease SET holder = 'writer-b', epoch = 2 WHERE resource = ?").run(RESOURCE);

    expectRefusal(
      () => outbox.attempt("msg-gated", { nowMs: T0 + 10, epoch: EPOCH }),
      StaleWriterRefused,
    );

    expect(actionsOf(cp, { kind: "human_gated", status: "pending" })).toEqual([]);
  });

  test("a writer superseded during the effect may not record the result", () => {
    // The effect landed and we are no longer entitled to say so.
    //
    // The action stays pending, so recovery replays it and the destination
    // deduplicates -- which is the ambiguous window the declared mechanism
    // exists to make survivable. What must not happen is a stale writer marking
    // it applied and leaving an applied action beside an unfinished outbox row.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    class LosesTheLeaseMidFlight extends NotifyDestinationHandler {
      override apply(
        message: OutboxMessage,
        idempotencyKey: string,
        fencingToken: number | null = null,
        fenceScope: string | null = null,
      ): DeliveryReceipt {
        const receipt = super.apply(message, idempotencyKey, fencingToken, fenceScope);
        cp.prepare("UPDATE lease SET holder = 'writer-b', epoch = 2 WHERE resource = ?").run(
          RESOURCE,
        );
        return receipt;
      }
    }

    const registry = new HandlerRegistry();
    registry.register(new LosesTheLeaseMidFlight(dropbox));
    const outbox = makeOutbox(cp, dropbox, { registry });
    const message = enqueue(outbox);

    const refused = expectRefusal(
      () => outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH }),
      StaleWriterRefused,
      "while the effect was in flight",
    );

    const key = keyFor(message.dedupKey);
    expect(dropbox.effectCount(key), "the effect did land").toBe(1);
    expect(
      actionsOf(cp, { idempotency_key: key })[0]?.status,
      "but it was not recorded applied by a writer that had been superseded",
    ).toBe("pending");
    expect(outbox.load(message.messageId).status).toBe("pending");
    const refusals = actionsOf(cp, { status: "refused" });
    expect(refusals.length).toBe(1);
    expect(refused.actionId).toBe(refusals[0]?.action_id);
    const observed = refused.observed;
    expect([observed?.holder, observed?.epoch]).toEqual(["writer-b", 2]);
  });

  test("the applied instant survives a backward clock skew", () => {
    // A restarted process retrying with a clock behind the recorded intent.
    //
    // S5's `applied_at_ms >= created_at_ms` CHECK would abort the transaction
    // and strand a delivery whose effect has already landed until the clock
    // caught up. Same treatment as the delivery and ack instants: the column
    // records lifecycle order, not a wall-clock measurement.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const kills = new Kills(CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT);
    const outbox = makeOutbox(cp, dropbox, { checkpoint: kills.call });
    const message = enqueue(outbox);
    expectRefusal(
      () => outbox.attempt(message.messageId, { nowMs: T0 + 5_000, epoch: EPOCH }),
      Killed,
    );

    const key = keyFor(message.dedupKey);
    expect(actionsOf(cp, { idempotency_key: key })[0]?.created_at_ms).toBe(T0 + 5_000);

    // The retry's clock runs behind the instant the intent was recorded.
    const resumed = makeOutbox(cp, dropbox);
    resumed.attempt(message.messageId, { nowMs: T0 + 1_000, epoch: EPOCH });

    const rows = actionsOf(cp, { idempotency_key: key });
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("applied");
    expect(rows[0]?.applied_at_ms).toBe(T0 + 5_000);
    expect(dropbox.effectCount(key)).toBe(1);
  });

  test("the fence check and the publish happen under one lock", () => {
    // Separately they are a check-then-write, and the race is not hypothetical.
    //
    // A token-1 writer passes the check, pauses, a token-2 writer advances the
    // fence and publishes, and the first resumes and publishes under a token
    // the destination has already superseded -- the same defect the lease
    // avoids by validating its epoch *inside* the protected write.
    const destinationRoot = join(caseRoot("s7"), "destination");
    const seen: { at_check?: boolean; at_publish?: boolean } = {};

    class Observing extends KeyedDropbox {
      protected override _honourToken(
        fencingToken: number | null,
        fenceScope: string | null,
      ): void {
        seen.at_check = existsSync(join(destinationRoot, LOCK_NAME));
        super._honourToken(fencingToken, fenceScope);
      }

      protected override _fsyncRoot(): void {
        seen.at_publish = existsSync(join(destinationRoot, LOCK_NAME));
        super._fsyncRoot();
      }
    }

    new Observing(destinationRoot).apply("k", "payload", 1);

    expect(seen.at_check, "the token is checked inside the lock").toBe(true);
    expect(seen.at_publish, "and the effect is published still holding it").toBe(true);
    expect(
      existsSync(join(destinationRoot, LOCK_NAME)),
      "and the lock is released afterwards",
    ).toBe(false);
  });

  test("an apply that cannot serialise refuses rather than racing", () => {
    // No timeout-based guess about a dead lock holder is made here.
    //
    // Choosing that interval is `Q-0003`'s business. A lock that cannot be
    // taken is a refusal, the message stays due, and the outbox already handles
    // that.
    const destinationRoot = join(caseRoot("s7"), "destination");
    const dropbox = new KeyedDropbox(destinationRoot);
    writeFileSync(join(destinationRoot, LOCK_NAME), "held by someone else", "utf-8");

    expectRefusal(() => dropbox.apply("k", "payload", 1), DestinationRefusal, "busy");
    expect(dropbox.effectCount("k")).toBe(0);
  });

  test("tokens from different leases are different sequences", () => {
    // One destination, two lease resources, two independent epoch counters.
    //
    // Epochs are per-lease. A destination keeping one global maximum silently
    // conflates them, and the damage is not a missed refusal but a wrongful
    // one: after a writer on resource A applies at epoch 10, a perfectly live
    // writer on resource B at epoch 1 would be rejected as stale forever.
    const dropbox = new KeyedDropbox(join(caseRoot("s7"), "destination"));
    dropbox.apply("a-effect", "payload", 10, "resource-a");

    const receipt = dropbox.apply("b-effect", "payload", 1, "resource-b");
    expect(receipt.deduplicated, "a live writer on another lease is not stale").toBe(false);
    expect(dropbox.effectCount("b-effect")).toBe(1);
    expect(dropbox.honouredToken("resource-a")).toBe(10);
    expect(dropbox.honouredToken("resource-b")).toBe(1);
  });

  test("a superseded writer is still refused within its own scope", () => {
    // Scoping the fence must not weaken it -- only stop it over-reaching.
    const dropbox = new KeyedDropbox(join(caseRoot("s7"), "destination"));
    dropbox.apply("newer", "payload", 7, "resource-a");
    expectRefusal(
      () => dropbox.apply("older", "payload", 3, "resource-a"),
      StaleTokenRefused,
      "resource-a",
    );
    expect(dropbox.effectCount("older")).toBe(0);
  });

  test("an unscoped token is its own scope and not a wildcard", () => {
    const dropbox = new KeyedDropbox(join(caseRoot("s7"), "destination"));
    dropbox.apply("scoped", "payload", 9, "resource-a");
    const receipt = dropbox.apply("unscoped", "payload", 1);
    expect(receipt.deduplicated).toBe(false);
    expect(dropbox.honouredToken()).toBe(1);
    expect(dropbox.honouredToken("resource-a")).toBe(9);
  });

  test("the effect key is namespaced by recipient not only by action kind", () => {
    // Two handlers may share an `actionKind` while serving different
    // recipients, and nothing in the registry stops them.
    //
    // If they did, the second would find the first's action row already
    // applied, skip recording its own receipt, and report an effect at *its*
    // destination that no record of ours points at. The recipient is what the
    // registry makes unique, so the recipient is what the key is namespaced by.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    class Twin extends NotifyDestinationHandler {
      override readonly recipient: string = "a-different-recipient";
      override readonly actionKind: string = "notify"; // deliberately the same kind
    }

    const first = new NotifyDestinationHandler(dropbox);
    const twin = new Twin(dropbox);
    const message = enqueue(makeOutbox(cp, dropbox), { dedupKey: "shared" });

    expect(
      first.idempotencyKey(message),
      "same action kind, same dedup key, different destinations -- and so a different effect",
    ).not.toBe(twin.idempotencyKey(message));
    expect(first.idempotencyKey(message).startsWith(NOTIFY_RECIPIENT)).toBe(true);
  });

  test("two handlers sharing an action kind each get their own effect", () => {
    // The behavioural half: two destinations, two effects, two records.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);
    const other = new KeyedDropbox(join(root, "other-destination"), "other");

    class Twin extends NotifyDestinationHandler {
      override readonly recipient: string = "a-different-recipient";
      override readonly actionKind: string = "notify";
    }

    const registry = new HandlerRegistry();
    registry.register(new NotifyDestinationHandler(dropbox));
    registry.register(new Twin(other));
    const outbox = makeOutbox(cp, dropbox, { registry });

    enqueue(outbox, { messageId: "msg-1", dedupKey: "shared" });
    enqueue(outbox, {
      messageId: "msg-2",
      dedupKey: "shared",
      recipient: "a-different-recipient",
    });
    outbox.attempt("msg-1", { nowMs: T0 + 10, epoch: EPOCH });
    const second = outbox.attempt("msg-2", { nowMs: T0 + 20, epoch: EPOCH });

    expect(second.deduplicated, "a different destination is a different effect").toBe(false);
    expect(dropbox.effectCount(keyFor("shared"))).toBe(1);
    expect(other.effectCount(keyFor("shared", "a-different-recipient"))).toBe(1);
    expect(actionsOf(cp, { status: "applied" }).length, "and each has its own record").toBe(2);
    expect(second.receiptRef, "the second receipt was recorded, not skipped").not.toBeNull();
  });
});

// --------------------------------------------------------------------------
// the third branch -- neither mechanism is achievable, so a human gate (D-0004)
// --------------------------------------------------------------------------

describe("the third branch -- neither mechanism is achievable, so a human gate (D-0004)", () => {
  test("a human gated action is recorded and never applied", () => {
    // Issue #14: the gap is **explicit**, and *do not paper over it*.
    //
    // The outbox records the action and stops. It does not attempt the effect,
    // and it does not invent an automatic recovery path for one it cannot make
    // exactly-once.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox, {
      messageId: "msg-gated",
      dedupKey: "dk-gated",
      recipient: HUMAN_GATED_RECIPIENT,
    });

    expectRefusal(
      () => outbox.attempt("msg-gated", { nowMs: T0 + 10, epoch: EPOCH }),
      HumanGateRequired,
      "human_gate",
    );

    const rows = actionsOf(cp, {
      idempotency_key: keyFor("dk-gated", HUMAN_GATED_RECIPIENT, "human_gated"),
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.status, "recorded, and waiting for a human").toBe("pending");
    expect(rows[0]?.exactly_once_mechanism).toBe("human_gate");
    expect(dropbox.effects(), "and no effect was attempted").toEqual([]);
  });

  test("a human gated action stays pending however often it is offered", () => {
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox, {
      messageId: "msg-gated",
      dedupKey: "dk-gated",
      recipient: HUMAN_GATED_RECIPIENT,
    });

    for (const at of [T0 + 10, T0 + 20, T0 + 30]) {
      expectRefusal(
        () => outbox.attempt("msg-gated", { nowMs: at, epoch: EPOCH }),
        HumanGateRequired,
      );
    }

    expect(actionsOf(cp, { kind: "human_gated" }).map((row) => row.status)).toEqual(["pending"]);
    expect(outbox.load("msg-gated").status).toBe("pending");
  });

  test("the human gated handler refuses to be applied directly", () => {
    // Belt and braces: even called by hand, it does not perform an effect.
    expectRefusal(
      () => new HumanGatedHandler().apply(null as unknown as OutboxMessage, "k"),
      AssertionError,
      "never applied automatically",
    );
  });
});

// --------------------------------------------------------------------------
// registry hygiene
// --------------------------------------------------------------------------

describe("registry hygiene", () => {
  test("an unknown recipient has no handler and says so", () => {
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox, { messageId: "msg-x", dedupKey: "dk-x", recipient: "nobody" });
    expectRefusal(
      () => outbox.attempt("msg-x", { nowMs: T0 + 10, epoch: EPOCH }),
      HandlerRejected,
      "nobody",
    );
  });

  test("two handlers cannot claim the same recipient", () => {
    const dropbox = dropboxFixture(caseRoot("s7"));
    const registry = spikeRegistry(dropbox);
    expectRefusal(
      () => registry.register(new NotifyDestinationHandler(dropbox)),
      HandlerRejected,
      "already has a handler",
    );
  });

  test("two handlers do not collide on a shared dedup key", () => {
    // `action.idempotency_key` is unique across the whole table.
    //
    // Two handlers deriving keys from the same dedup key without namespacing
    // would have one silently deduplicate against the other's effect -- an
    // effect that never happens, reported as exactly-once.
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const notify = new NotifyDestinationHandler(dropbox);
    const gated = new HumanGatedHandler();
    const message = enqueue(makeOutbox(cp, dropbox), { dedupKey: "shared" });
    expect(notify.idempotencyKey(message)).not.toBe(gated.idempotencyKey(message));
  });

  test("an acked message is not resent", () => {
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);

    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });
    outbox.recordAck(message.messageId, { nowMs: T0 + 20 });

    expectRefusal(
      () => outbox.attempt(message.messageId, { nowMs: T0 + 30, epoch: EPOCH }),
      OutboxUsageError,
      "already acked",
    );
  });

  test("no retry interval or window appears in this layer", () => {
    // `Q-0003` has to settle tolerable detection latency first.
    //
    // S5 kept every such number out of the schema. S7 sits directly on it and
    // is the obvious place for a backoff to appear by convenience, so the
    // absence is asserted rather than trusted.
    //
    // Comments and string literals are stripped, because the prose deliberately
    // discusses the very things the code must not contain -- scanning the raw
    // text would fail on the explanation of why the thing is absent. The source
    // does this with `tokenize`; TypeScript has no runtime tokenizer, so the
    // stripper below is written out, and its own anti-vacuity check is that the
    // stripped text still carries the declarations the module is made of.
    const executable = executableSource(join(CONTROL_PLANE_DIR, "outbox.ts"));

    // Anti-vacuity: a stripper that ate the whole file would make every
    // assertion below pass while proving nothing at all.
    expect(executable).toContain("class Outbox");
    expect(executable).toContain("attempt");
    expect(executable.length).toBeGreaterThan(1_000);

    // The source pins the snake_case spellings its own module would use; D-0017
    // rule 1 makes the target's spellings the ones to look for, so both are
    // listed rather than either being dropped.
    const forbidden = [
      "backoff",
      "visibility_timeout",
      "visibilitytimeout",
      "retry_after",
      "retryafter",
      "sleep(",
    ];
    for (const word of forbidden) {
      expect(
        executable.toLowerCase().includes(word),
        `'${word}' is a retry policy, and Q-0003 has not settled one`,
      ).toBe(false);
    }
  });
});

/**
 * *path*'s source with comments and string literals removed.
 *
 * The source uses `tokenize`, which the Python runtime ships and the JavaScript
 * one does not. This is the smallest scanner that answers the same question for
 * the TypeScript subset these modules are written in: line comments, block
 * comments and the three string forms are dropped; everything else is kept
 * verbatim. Its adequacy is asserted at the call site rather than assumed -- a
 * stripper that removed too much would make the case vacuous, which is the
 * failure the anti-vacuity assertions there exist for.
 */
function executableSource(path: string): string {
  const text = readFileSync(path, "utf8");
  let out = "";
  let index = 0;
  while (index < text.length) {
    const two = text.slice(index, index + 2);
    if (two === "//") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (two === "/*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    const quote = text[index];
    if (quote === '"' || quote === "'" || quote === "`") {
      index += 1;
      while (index < text.length) {
        const character = text[index];
        if (character === "\\") {
          index += 2;
          continue;
        }
        if (character === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += text[index];
    index += 1;
  }
  return out;
}

// --------------------------------------------------------------------------
// seam liveness (target-only)
//
// Conventions rule 5: a seam can rot into a decoration. If a refactor made
// production mint an id directly, every case that replaced the seam entry would
// stay green because the replacement is simply never reached. These two say
// production routes through it, and they are target-only -- the source patches
// neither, because Python's module-level `uuid` needs no seam to be patched.
// --------------------------------------------------------------------------

describe("seam liveness (target-only)", () => {
  test("destination uuid4Hex routes both staging mint sites", () => {
    class MintRefused extends Error {}
    const destinationRoot = join(caseRoot("s7"), "destination");
    const dropbox = new KeyedDropbox(destinationRoot);
    patchSeam(destinationSeams, "uuid4Hex", () => {
      throw new MintRefused("the seam was reached");
    });

    // With a token and no fence yet, the fence file's staging name is the first
    // id minted -- `_honourToken` runs before the record is written.
    expectRefusal(() => dropbox.apply("fenced", "payload", 1), MintRefused);
    // Without a token the fence is not touched at all, so the only mint left is
    // the effect record's own staging file.
    expectRefusal(() => dropbox.apply("unfenced", "payload"), MintRefused);
    expect(dropbox.effectCount("fenced")).toBe(0);
    expect(dropbox.effectCount("unfenced")).toBe(0);
  });

  test("outbox uuid4Hex names the bare refusal row", () => {
    const root = caseRoot("s7");
    const cp = cpFixture(dbPathFixture(root));
    const dropbox = dropboxFixture(root);
    patchSeam(outboxSeams, "uuid4Hex", () => "0123456789abcdef0123456789abcdef");

    const outbox = makeOutbox(cp, dropbox);
    cp.prepare("UPDATE lease SET holder = 'writer-b', epoch = 2 WHERE resource = ?").run(RESOURCE);

    const refused = expectRefusal(
      () => enqueue(outbox, { messageId: "msg-stale", dedupKey: "dk-stale" }),
      StaleWriterRefused,
    );
    expect(refused.actionId).toBe("refused-0123456789abcdef0123456789abcdef");
    expect(actionsOf(cp, { status: "refused" })[0]?.action_id).toBe(
      "refused-0123456789abcdef0123456789abcdef",
    );
  });
});

// --------------------------------------------------------------------------
// migration 0003's fourth status (target-only, production schema)
//
// Everything above this line runs on the S5 spike table, which has a
// three-word status vocabulary and no `'cancelled'` at all. Those 74 cases are
// the faithful translation of `tests/control_plane/test_outbox.py` and they
// stay on `createControlPlane` / `openControlPlane` (D-0026): the predicate
// rewrite this section exists for is *extensionally identical* on a three-word
// vocabulary -- `status <> 'acked'` and `status IN ('pending', 'delivered')`
// pick out the same rows when those are the only three words -- so the source
// suite is the evidence that the rewrite changed nothing it was not meant to
// change, and it is only evidence while it is left alone.
//
// The cases below are the other half, and none of them is expressible up
// there: they are about a status the spike table's `CHECK` would refuse. So
// they take a **production** control plane at head, built from the shipped
// migrations, and they are target-only -- there is no source node for any of
// them, because the source has no 0003.
//
// What they pin, in the order the failure would be met:
//
// * the status vocabulary and its terminal set are the *database's*, not two
//   hand-kept lists that agree today;
// * `Outbox.due` reads through `outbox_undelivered`, the partial index 0003
//   wrote to serve exactly this predicate -- asserted against the statement
//   traced out of the driver, never against a copy pasted here;
// * every path that used to decide "finished" by asking whether a row was
//   acked -- `due`, `unowned` / `recover`, `attempt`, `recordAck` -- treats a
//   cancellation as the end of the message, and does so *without* performing
//   the effect, incrementing the count, adopting the row, or reporting an
//   ack that never happened.
// --------------------------------------------------------------------------

/**
 * The production database's name inside a case root.
 *
 * A different name from {@link DATABASE_NAME}, and deliberately so: several
 * cases in this file put a dropbox beside the database in the same directory,
 * and a spike and a production database sharing one name in one root would be
 * a copy silently overwriting a copy.
 */
const PRODUCTION_DATABASE_NAME = "production.sqlite3";

/**
 * The production database this section starts from, built once for this file.
 *
 * The same four-line declaration `production-schema.test.ts`, `gates.test.ts`
 * and `events.test.ts` all carry (D-0027): create one at `T0`, at head, with
 * no `migrationsDir` override, and hand each case a copy. Creating a migrated
 * database is the expensive fixture in this repository -- it is fsyncs and
 * four migration steps, not DDL -- and every case below wants a byte-identical
 * one.
 */
const productionTemplate = suiteTemplate(PRODUCTION_DATABASE_NAME, (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/** A fresh copy of {@link productionTemplate}, in the caller's case root. */
function productionDbPath(root: string): string {
  return productionTemplate.copyInto(root, PRODUCTION_DATABASE_NAME);
}

/**
 * {@link cpFixture}'s production twin: the same one run and one lease, on a
 * database at migration head.
 *
 * Opened with `openProductionControlPlane` rather than created, for D-0027's
 * reason and for one more that only applies to the production opener: opening
 * *verifies the copy is at head against the ledger*, so a template that built
 * the wrong thing -- or a migration added without its checksum -- is a typed
 * refusal at the first case rather than a suite quietly asserting things about
 * a schema nobody shipped.
 *
 * The run row is not decoration here. `outbox.run_id REFERENCES run(run_id)`
 * is enforced on the production schema, so an enqueue with no run behind it is
 * a foreign-key failure rather than a row.
 */
function productionCpFixture(dbPath: string): SqliteDatabase {
  const connection = openProductionControlPlane(dbPath);
  closeWhenFinished(connection);
  connection
    .prepare(
      "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms)" +
        " VALUES ('run-1', 'running', ?, ?)",
    )
    .run(T0, T0);
  connection
    .prepare(
      "INSERT INTO lease (resource, holder, epoch, acquired_at_ms, expires_at_ms)" +
        " VALUES (?, ?, ?, ?, ?)",
    )
    .run(RESOURCE, HOLDER, EPOCH, T0, T0 + TTL_MS);
  return connection;
}

/**
 * Retire a relay the way a gate closure retires it.
 *
 * **This is `gates.ts`'s own statement, not an invented one.** `closeGate`
 * ends by running, in the same transaction as the closure:
 *
 *     UPDATE outbox
 *        SET status = 'cancelled'
 *      WHERE status IN ('pending', 'delivered')
 *        AND message_id IN (SELECT message_id FROM gate_relay WHERE gate_id = ?)
 *
 * and the two halves of that `WHERE` are both load-bearing for what the cases
 * below claim. The `status IN ('pending', 'delivered')` guard is why a second
 * close sweep is idempotent rather than an integrity error -- there is no edge
 * out of a terminal status in 0003's lattice -- and it is why a cancellation
 * can never reach an **acked** row, which is the schema's own statement of the
 * rule that the evidence an answer arrived is never deleted.
 *
 * The one substitution is the relay lookup: the subquery over `gate_relay` is
 * replaced by the message id the case names. Standing up a real gate would
 * mean a gate row, a stage, a relay row, an actor kind and a policy revision,
 * none of which any assertion below reads -- and the substitution is in the
 * half of the statement that *chooses* rows, never in the half that decides
 * what a cancellation is allowed to do. `gates.test.ts` owns the case that the
 * relay lookup finds the right messages.
 *
 * The `changes` assertion is anti-vacuity, and it has caught the obvious
 * mistake: a helper that silently cancelled nothing would make every case
 * below pass for the reason that nothing had happened.
 */
function closeTheGateOver(cp: SqliteDatabase, messageId: string): void {
  const info = cp
    .prepare(
      `
        UPDATE outbox
           SET status = 'cancelled'
         WHERE status IN ('pending', 'delivered')
           AND message_id IN (:message_id)
        `,
    )
    .run({ message_id: messageId });
  expect(
    info.changes,
    `the gate closure cancelled no row for ${messageId}; the case that follows would ` +
      "then be asserting about a message that was never retired",
  ).toBe(1);
}

/** The query plan SQLite chose for `sql`, flattened for substring assertions. */
function explainPlan(cp: SqliteDatabase, sql: string, params?: Record<string, unknown>): string {
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
 * The statement {@link Outbox.due} really ran, from the driver.
 *
 * Traced rather than pasted into the test or read out of `_DUE_QUERY`: the
 * plan assertion below is only worth anything if it is made against the text
 * SQLite was actually handed. `events.test.ts`'s `executedOutboxSql` is the
 * same helper for the same reason, and that reason is a regression that
 * happened -- the pasted form sat in the source suite and stayed green while
 * the shipped predicate was rewritten into the degraded arithmetic. A test
 * that EXPLAINs its own copy asserts a property of its own copy.
 *
 * Adapted the same way: Python installs the trace on the connection with
 * `set_trace_callback` and removes it afterwards, while better-sqlite3's
 * `verbose` logger can only be given at construction. So the traced connection
 * is a second handle on the same file and the `tracing` flag reproduces the
 * install/remove window exactly. The statement captured is still the one
 * `due` executed, which is the whole property. `verbose` hands back the
 * statement with its parameters already expanded, which `EXPLAIN QUERY PLAN`
 * accepts unchanged.
 */
function executedDueSql(path: string, dropbox: Destination, nowMs: number): string {
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
  closeWhenFinished(traced);

  const outbox = makeOutbox(traced, dropbox);
  tracing = true;
  try {
    outbox.due(nowMs);
  } finally {
    tracing = false;
  }
  const outboxStatements = seen.filter((sql) => sql.includes("FROM outbox"));
  expect(outboxStatements, JSON.stringify(outboxStatements)).toHaveLength(1);
  return outboxStatements[0] as string;
}

/**
 * One outbox row in a named status, written straight past the module.
 *
 * The two vocabulary cases below are about what the **DDL** admits, so they
 * must be able to put a row into a status the module would never write it into
 * -- `Outbox` has no path that produces an `'acked'` row without a delivery
 * before it, and none at all that produces `'archived'`. Going around the
 * module is the point rather than a shortcut.
 *
 * The companion columns are the ones 0003's `CASE` requires of each status: a
 * `'pending'` row must claim no delivery, `'delivered'` and `'acked'` must
 * carry one, `'acked'` must carry an ack and nothing else may, and
 * `'cancelled'` is admitted either way (this writes the cancelled-while-pending
 * shape). Getting them right is what keeps a refusal attributable: a case that
 * fed SQLite an illegal companion column would see a CHECK failure and could
 * not tell it from the constraint it meant to test.
 */
function insertRawOutbox(cp: SqliteDatabase, messageId: string, status: string): void {
  const deliveredAtMs = status === "delivered" || status === "acked" ? T0 + 1 : null;
  const ackedAtMs = status === "acked" ? T0 + 2 : null;
  cp.prepare(
    "INSERT INTO outbox (message_id, run_id, recipient, payload, dedup_key, status," +
      " retry_count, writer_epoch, enqueued_at_ms, delivered_at_ms, acked_at_ms)" +
      " VALUES (?, 'run-1', ?, '{}', ?, ?, 0, ?, ?, ?, ?)",
  ).run(
    messageId,
    NOTIFY_RECIPIENT,
    `dk/${messageId}`,
    status,
    EPOCH,
    T0,
    deliveredAtMs,
    ackedAtMs,
  );
}

describe("the status vocabulary is the tables own (target-only, production schema)", () => {
  test("OUTBOX_STATUSES is the enumeration the production CHECK declares", () => {
    // The constant is a second, hand-kept copy of a DDL enumeration, and this
    // is the case that makes keeping it by hand safe. The vocabulary is read
    // **out of the database** -- `sqlite_master` holds the text SQLite itself
    // stored for the table that migration 0003 rebuilt -- rather than pasted
    // here, because a paste would drift in step with the constant it is
    // checking and a migration that widened the CHECK would leave both of them
    // wrong and the suite green.
    //
    // `run-lifecycle.test.ts`'s "the mirrored vocabulary is the table's own"
    // is the same guard for `RUN_STATUSES`, and the behavioural half below is
    // taken from it directly.
    const cp = productionCpFixture(productionDbPath(caseRoot("s7")));
    const rawDdl = String(
      cp
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbox'")
        .pluck()
        .get(),
    );
    // The `--` comment lines are stripped first, and they have to be: SQLite
    // stores the CREATE TABLE text **verbatim**, comments and all, and 0003's
    // rebuild explains itself by quoting the constraint it replaced --
    //     --     CHECK ((status IN ('delivered', 'acked')) = ...)
    // -- so a scan over the raw text finds two enumerations and cannot tell
    // the live one from the one being described as gone.
    const ddl = rawDdl
      .split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
    const enumerations = [...ddl.matchAll(/status IN \(([^)]*)\)/g)];
    // Anti-vacuity, and it is not theoretical: a regex that matched nothing
    // would leave `declared` empty, and an empty list compared against an
    // empty list is a test that passes because it asked nothing. More than one
    // match would mean the table grew a second status enumeration, which the
    // extraction below would then be silently choosing between.
    expect(
      enumerations,
      `the outbox DDL holds ${enumerations.length} 'status IN (...)' enumerations, not one:\n${ddl}`,
    ).toHaveLength(1);
    const declared = String(enumerations[0]?.[1])
      .split(",")
      .map((word) => word.trim().replace(/^'|'$/g, ""));
    expect(declared.length).toBeGreaterThan(0);

    // Sorted on both sides: the DDL lists the words in lifecycle order and the
    // constant follows it, but SQLite promises nothing about the order it
    // stores the text in and a CHECK is a set. What must not differ is the
    // membership -- a status the database admits and this module has never
    // heard of, or the reverse.
    expect([...declared].sort()).toEqual([...OUTBOX_STATUSES].sort());

    // ...and the words really are writable, which no amount of string
    // comparison shows. Each one is inserted with the companion columns 0003's
    // CASE requires of it, and a word outside the enumeration is refused.
    for (const status of OUTBOX_STATUSES) {
      insertRawOutbox(cp, `msg-${status}`, status);
      expect(
        cp.prepare("SELECT status FROM outbox WHERE message_id = ?").pluck().get(`msg-${status}`),
      ).toBe(status);
    }
    expectSqliteError(() => insertRawOutbox(cp, "msg-invented", "archived"), {
      code: CONSTRAINT,
    });
  });

  test("TERMINAL_OUTBOX_STATUSES is the set the lattice trigger leaves with no exit", () => {
    // 0003 replaced 0001's total order over three statuses with a lattice:
    //
    //     pending   -> delivered | cancelled
    //     delivered -> acked     | cancelled
    //     acked     -> (nothing)
    //     cancelled -> (nothing)
    //
    // "Terminal" is a property of that trigger and of nothing else, so it is
    // asked of the trigger, one ordered pair at a time, rather than compared
    // against a second list. `run-lifecycle.test.ts`'s "the terminal set is
    // the trigger's terminal set" is the same case for `run`.
    //
    // The UPDATE sets **status alone** and touches no companion column, which
    // is what isolates `outbox_status_is_forward_only` from its neighbours. An
    // update that also cleared `acked_at_ms` to keep the row legal would be
    // refused by `outbox_ack_is_set_once` instead, and every `acked -> *` pair
    // would then be reported as terminal by the wrong trigger -- terminality
    // that the lattice did not enforce and that a later migration could repeal
    // without this case noticing. Isolating it costs a `CHECK` failure on the
    // admitted steps (`pending -> delivered` leaves `delivered_at_ms` null),
    // and that is exactly the signal wanted: SQLite runs BEFORE triggers ahead
    // of constraint checking, so reaching the CHECK at all proves the lattice
    // let the step through.
    const cp = productionCpFixture(productionDbPath(caseRoot("s7")));
    const lattice = /acked and cancelled are terminal/;

    const admitted = new Map<string, string[]>();
    for (const from of OUTBOX_STATUSES) {
      admitted.set(from, []);
      for (const to of OUTBOX_STATUSES) {
        if (to === from) {
          // The trigger's WHEN clause never fires for NEW.status = OLD.status,
          // so a self-update says nothing about terminality either way.
          continue;
        }
        const messageId = `msg-${from}-to-${to}`;
        insertRawOutbox(cp, messageId, from);
        try {
          cp.prepare("UPDATE outbox SET status = ? WHERE message_id = ?").run(to, messageId);
          admitted.get(from)?.push(to);
        } catch (error) {
          if (!lattice.test(String((error as Error).message))) {
            // Some other constraint spoke first -- which means the lattice had
            // already let the step past it. That is an admitted edge.
            admitted.get(from)?.push(to);
          }
        }
      }
    }

    const terminal = OUTBOX_STATUSES.filter((status) => admitted.get(status)?.length === 0);
    expect([...terminal].sort()).toEqual([...TERMINAL_OUTBOX_STATUSES].sort());
    // ...and the complement is not empty, so "every status is terminal" -- the
    // way this case would pass if the UPDATE were malformed and always threw
    // -- fails instead.
    expect(
      OUTBOX_STATUSES.filter((status) => !terminal.includes(status)),
      `no status has an outgoing edge, which cannot be right: ${JSON.stringify([...admitted])}`,
    ).not.toEqual([]);
  });
});

describe("the due query uses the partial index written to serve it (target-only)", () => {
  test("the plan of the statement due actually ran names outbox_undelivered", () => {
    // 0003 ships `CREATE INDEX outbox_undelivered ON outbox(enqueued_at_ms)
    // WHERE status IN ('pending', 'delivered')`, and the whole reason
    // `_DUE_QUERY` spells its predicate as that positive `IN` list rather than
    // as the negation of the terminal set is that SQLite may use a partial
    // index only when the query's WHERE carries the index's own predicate as a
    // term. The two forms return the same rows, so nothing but the PLAN can
    // tell them apart -- and outbox rows are never deleted
    // (`outbox_rows_are_never_deleted`), so a scan here grows without bound
    // for as long as the database lives.
    //
    // This EXPLAINs the statement the METHOD executed, traced from the driver,
    // not a copy pasted here. See {@link executedDueSql}.
    const root = caseRoot("s7");
    const path = productionDbPath(root);
    const cp = productionCpFixture(path);
    const dropbox = dropboxFixture(root);
    enqueue(makeOutbox(cp, dropbox));

    const plan = explainPlan(cp, executedDueSql(path, dropbox, T0 + 1));
    expect(plan).toContain("SEARCH");
    expect(plan).toContain("outbox_undelivered");
    expect(plan).not.toContain("SCAN");

    // The algebraically identical form does not, because the column is inside
    // an expression and no b-tree can seek on one. Asserting this half is what
    // makes the half above mean something: without it, a database on which
    // every plan says SEARCH would also pass.
    expect(_DEGRADED_DUE_QUERY).not.toBe(_DUE_QUERY);
    const degraded = explainPlan(cp, _DEGRADED_DUE_QUERY, { now_ms: T0 + 1 });
    // SQLite still names outbox_undelivered here -- it reads the partial index
    // as a narrower covering table, and it satisfies the ORDER BY from it --
    // but the verb is SCAN, not SEARCH: every unfinished row ever enqueued is
    // visited and the age arithmetic is evaluated per row. So the assertion is
    // on the VERB, never on the index name.
    expect(degraded).not.toContain("SEARCH");
    expect(degraded).toContain("SCAN");
  });

  test("the two forms the plan test separates return the same rows", () => {
    // If they disagreed on rows, the plan comparison would be comparing two
    // different questions and the index claim above would be vacuous.
    const root = caseRoot("s7");
    const cp = productionCpFixture(productionDbPath(root));
    const dropbox = dropboxFixture(root);
    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox, { messageId: "msg-1", dedupKey: "dk-1" });
    enqueue(outbox, { messageId: "msg-2", dedupKey: "dk-2", at: T0 + 1 });
    outbox.attempt("msg-2", { nowMs: T0 + 2, epoch: EPOCH });
    enqueue(outbox, { messageId: "msg-3", dedupKey: "dk-3", at: T0 + 3 });
    closeTheGateOver(cp, "msg-3");

    const params = { now_ms: T0 + 10 };
    const shipped = cp.prepare<typeof params, unknown[]>(_DUE_QUERY).raw().all(params);
    expect(shipped).toEqual(
      cp.prepare<typeof params, unknown[]>(_DEGRADED_DUE_QUERY).raw().all(params),
    );
    expect(shipped).not.toEqual([]);
  });
});

describe("cancelled is terminal on every path (target-only, production schema)", () => {
  test("due does not offer a message cancelled while it was pending", () => {
    const root = caseRoot("s7");
    const cp = productionCpFixture(productionDbPath(root));
    const dropbox = dropboxFixture(root);
    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox, { messageId: "msg-live", dedupKey: "dk-live" });
    enqueue(outbox, { messageId: "msg-doomed", dedupKey: "dk-doomed" });
    expect(
      outbox
        .due(T0 + 1)
        .map((message) => message.messageId)
        .sort(),
    ).toEqual(["msg-doomed", "msg-live"]);

    closeTheGateOver(cp, "msg-doomed");

    // The gate withdrew the question. Offering the message again would put a
    // withdrawn relay back on the delivery worker's list on every pass, which
    // is the whole failure 0003 was written to end.
    expect(outbox.due(T0 + 1).map((message) => message.messageId)).toEqual(["msg-live"]);
    expect(outbox.load("msg-doomed").status).toBe("cancelled");
  });

  test("due does not offer a message cancelled after it was delivered", () => {
    // The second shape, and the one the old `status <> 'acked'` predicate got
    // most wrong: a delivered-but-unacked row is exactly the resend case, so
    // it stays due forever until something terminates it -- and after 0003 a
    // cancellation is one of the two things that can.
    const root = caseRoot("s7");
    const cp = productionCpFixture(productionDbPath(root));
    const dropbox = dropboxFixture(root);
    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });
    expect(outbox.load(message.messageId).status).toBe("delivered");
    expect(outbox.due(T0 + 20).map((due) => due.messageId)).toEqual([message.messageId]);

    closeTheGateOver(cp, message.messageId);

    expect(outbox.due(T0 + 20)).toEqual([]);
    // The cancellation retired the message; it did not erase what happened to
    // it. `outbox_delivery_is_set_once` is what guarantees that, and the
    // delivery instant is still on the row.
    expect(outbox.load(message.messageId).deliveredAtMs).toBe(T0 + 10);
  });

  test("recovery neither adopts a cancelled row nor names it unowned forever", () => {
    // The "alarms forever" case, one table over from where 0003's own comment
    // describes it. Before the fix, `UNOWNED_OUTBOX_QUERY` matched a cancelled
    // row -- its writer_epoch belongs to a lease that has long expired and
    // nobody will ever take a live one on its behalf -- so every recovery pass
    // for the rest of the database's life would adopt it and every pass would
    // find it again.
    const root = caseRoot("s7");
    const cp = productionCpFixture(productionDbPath(root));
    const dropbox = dropboxFixture(root);
    const outbox = makeOutbox(cp, dropbox);
    enqueue(outbox, { messageId: "msg-live", dedupKey: "dk-live" });
    enqueue(outbox, { messageId: "msg-doomed", dedupKey: "dk-doomed" });
    closeTheGateOver(cp, "msg-doomed");

    const later = T0 + TTL_MS + 1; // epoch 1's lease has expired
    // The criterion as a query anyone can run (D-0001), read positionally the
    // way the source reads it: the cancelled row is not in the answer at all.
    const rows = cp
      .prepare(UNOWNED_OUTBOX_QUERY)
      .raw()
      .all({ resource: RESOURCE, now_ms: later }) as unknown[][];
    expect(rows.map((row) => row[0])).toEqual(["msg-live"]);
    expect([...outbox.unowned(later)]).toEqual(["msg-live"]);

    cp.prepare("UPDATE lease SET holder = ?, epoch = 2, expires_at_ms = ? WHERE resource = ?").run(
      "writer-b",
      later + TTL_MS,
      RESOURCE,
    );
    const successor = makeOutbox(cp, dropbox, { holder: "writer-b" });
    const report = successor.recover({ nowMs: later, epoch: 2 });

    expect(report.adopted).toEqual(["msg-live"]);
    expect(report.stillUnowned).toEqual([]);
    // ...and the cancelled row was left exactly as the gate left it. `_ADOPT`
    // excluding it is the difference between "recovery is finished" and
    // "recovery hands a live owner to a message that will never be advanced".
    const doomed = outbox.load("msg-doomed");
    expect(doomed.status).toBe("cancelled");
    expect(doomed.writerEpoch).toBe(EPOCH);
  });

  test("attempt refuses a cancelled message before it performs the effect", () => {
    // **The most important case in this file.**
    //
    // The refusal is not the interesting half -- the old code refused too,
    // eventually. It refused at `_MARK_DELIVERED`, which is step 4 of
    // `Outbox.attempt`, and steps 1 to 3 are a durable retry_count increment,
    // a pending action row, and **the handler running and the external effect
    // landing at the destination**. A relay whose gate was closed firing its
    // side effect at the destination anyway and only then reporting a problem
    // is the worst outcome the whole change exists to prevent, so what is
    // asserted here is the *absence* of every one of those three marks, read
    // from the destination's own ledger as ACCEPTANCE.md section 2 requires.
    const root = caseRoot("s7");
    const cp = productionCpFixture(productionDbPath(root));
    const dropbox = dropboxFixture(root);
    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    closeTheGateOver(cp, message.messageId);
    const before = outbox.load(message.messageId);

    const refused = expectRefusal(
      () => outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH }),
      OutboxUsageError,
      /is cancelled/,
    );
    // The two terminal words get opposite messages on purpose: the reader of
    // this refusal is being told what happened to their message, and "already
    // acked" would be a false account of a cancellation.
    expect(refused.message).not.toMatch(/already acked/);

    // 1. The destination's ledger -- the only evidence that counts.
    expect(dropbox.effectCount(keyFor("dk-1"))).toBe(0);
    // 2. The durable count, which is what an operator reads to decide whether
    //    a destination is refusing. An increment here would inflate it for a
    //    message no attempt is ever made on again.
    expect(outbox.load(message.messageId).retryCount).toBe(before.retryCount);
    expect(before.retryCount).toBe(0);
    // 3. The record of intent. No action row at all, of any status.
    expect(actionsOf(cp)).toEqual([]);
    // ...and the row itself is untouched, still terminal.
    expect(outbox.load(message.messageId).status).toBe("cancelled");
  });

  test("recordAck answers a cancelled while pending row instead of crying lost delivery", () => {
    // A row cancelled while still pending keeps a null `delivered_at_ms` --
    // 0003 declines to invent a delivery instant for a message that was never
    // delivered -- so it satisfies the undelivered branch's test exactly. That
    // branch's refusal calls an undelivered ack *evidence of a lost delivery
    // record*, which is a wildly wrong account of what happened here: nothing
    // was lost, the gate withdrew the question. Classifying cancelled first is
    // what keeps that branch's own meaning intact.
    const root = caseRoot("s7");
    const cp = productionCpFixture(productionDbPath(root));
    const dropbox = dropboxFixture(root);
    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    closeTheGateOver(cp, message.messageId);

    const outcome = outbox.recordAck(message.messageId, { nowMs: T0 + 20 });
    expect(outcome.recorded).toBe(false);
    expect(outcome.cancelled).toBe(true);
    expect(outcome.ackedAtMs).toBeNull();
    expect(outcome.clockClamped).toBe(false);

    const settled = outbox.load(message.messageId);
    expect(settled.status).toBe("cancelled");
    expect(settled.ackedAtMs).toBeNull();
    expect(settled.deliveredAtMs).toBeNull();
  });

  test("recordAck answers a delivered then cancelled row and writes nothing", () => {
    // The ordinary shape of the race the recipient could not have avoided: the
    // message really was delivered, the recipient really did answer, and the
    // gate closed in between. ACCEPTANCE.md section 2 says a late ack *changes
    // nothing* -- not that it is rejected -- and this is a late ack.
    const root = caseRoot("s7");
    const cp = productionCpFixture(productionDbPath(root));
    const dropbox = dropboxFixture(root);
    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });
    closeTheGateOver(cp, message.messageId);

    const outcome = outbox.recordAck(message.messageId, { nowMs: T0 + 20 });
    expect(outcome.recorded).toBe(false);
    expect(outcome.cancelled).toBe(true);
    // `null` is a fact, not an absence of information: under 0003's
    // `CHECK ((status = 'acked') = (acked_at_ms IS NOT NULL))` a cancelled row
    // can never carry an ack, so there is no instant to report and inventing
    // one would record an acknowledgement that never happened.
    expect(outcome.ackedAtMs).toBeNull();

    const settled = outbox.load(message.messageId);
    expect(settled.status).toBe("cancelled");
    expect(settled.ackedAtMs).toBeNull();
    expect(settled.deliveredAtMs).toBe(T0 + 10);
  });

  test("a cancellation between recordAcks read and its write is answered not thrown", () => {
    // The race the narrowed UPDATE closes, and the reason the pre-check above
    // is not sufficient on its own: a gate can close in the gap between the
    // read and the write, and no amount of checking first removes a gap.
    //
    // The old predicate was `acked_at_ms IS NULL`, which is true of a
    // cancelled row as well as an unacked one. So against a row cancelled in
    // this gap it did not merely fail to match -- it MATCHED, the statement
    // reached SQLite, and `outbox_status_is_forward_only` aborted it, because
    // `cancelled -> acked` is not an edge. A constraint error out of a method
    // whose entire contract is that a late ack changes nothing. And in the
    // reading where the row was lost instead, the zero-rows branch answered
    // "another writer acked", which is a plain false statement about it.
    //
    // The gap is driven through the seam the method itself uses: `recordAck`
    // reads the row with `this.load(...)`, so an own property shadowing the
    // prototype method lets the case cancel the row after the read has
    // returned and before the UPDATE is prepared. `outboxSeams` is the wrong
    // instrument here -- it holds `uuid4Hex` and nothing on this path -- and
    // better-sqlite3 exposes no update hook, so the dispatch site is the seam
    // that exists. The first load only is intercepted: `recordAck`'s zero-rows
    // branch loads a second time to classify, and that read must see the
    // database as it really is.
    const root = caseRoot("s7");
    const cp = productionCpFixture(productionDbPath(root));
    const dropbox = dropboxFixture(root);
    const outbox = makeOutbox(cp, dropbox);
    const message = enqueue(outbox);
    outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });

    const realLoad = outbox.load.bind(outbox);
    let cancelledYet = false;
    outbox.load = (messageId: string): OutboxMessage => {
      const loaded = realLoad(messageId);
      if (!cancelledYet) {
        cancelledYet = true;
        closeTheGateOver(cp, messageId);
      }
      return loaded;
    };

    const outcome = outbox.recordAck(message.messageId, { nowMs: T0 + 20 });
    expect(cancelledYet, "the seam was never reached, so no race was driven").toBe(true);
    expect(outcome.recorded).toBe(false);
    expect(outcome.cancelled).toBe(true);
    expect(outcome.ackedAtMs).toBeNull();

    const settled = realLoad(message.messageId);
    expect(settled.status).toBe("cancelled");
    expect(settled.ackedAtMs).toBeNull();
  });

  test("a cancellation landing inside attempt refuses before the effect", () => {
    // The other half of the case above it -- "attempt refuses a cancelled
    // message before it performs the effect" -- and the half the one-shot
    // guard at the top of `attempt` cannot cover. There the row was already
    // cancelled when the attempt began. Here it is live at that guard and is
    // retired while the attempt is running, which is the ordinary timing the
    // human gate creates: steps 1 and 2 are two committed transactions' worth
    // of wall clock, and gate closure is a different writer that never
    // consults the outbox before taking the `pending -> cancelled` edge.
    //
    // Without the re-read in front of the effect the attempt ran the whole
    // way through: the destination was written to, `_MARK_DELIVERED`'s
    // `status = 'pending'` conjunct then matched nothing, and because
    // `_markDelivered` passes `allowNoRow` the miss was silent. The effect
    // had happened and no row anywhere said so. So the assertion that matters
    // is the destination's own ledger reading ZERO, exactly as ACCEPTANCE.md
    // section 2 requires the evidence to be read.
    //
    // `CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT` is where the cancellation is
    // placed because it is the module's own name for this window (it is one
    // of the three ACCEPTANCE.md names), and it puts the gate closure between
    // the action row committing and the effect going out -- the exact instant
    // the re-read exists to notice.
    const root = caseRoot("s7");
    const cp = productionCpFixture(productionDbPath(root));
    const dropbox = dropboxFixture(root);
    const seen: string[] = [];
    const outbox = makeOutbox(cp, dropbox, {
      checkpoint: (name: string): void => {
        seen.push(name);
        if (name === CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT) {
          closeTheGateOver(cp, "msg-1");
        }
      },
    });
    const message = enqueue(outbox);

    const refused = expectRefusal(
      () => outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH }),
      CancelledBeforeEffect,
      /had been retired before the effect was attempted/,
    );
    expect(seen, "the checkpoint never fired, so no race was driven").toContain(
      CHECKPOINT_AFTER_RECORD_BEFORE_EFFECT,
    );
    // Not a stale writer and not a caller bug: the lease is live, the epoch
    // owns the row, and nobody used this module wrongly. Asserted because the
    // class is the whole point of the branch -- reusing either existing class
    // would send an operator to look at the two things that were fine.
    expect(refused).not.toBeInstanceOf(StaleWriterRefused);
    expect(refused).not.toBeInstanceOf(OutboxUsageError);
    expect(refused.name).toBe("CancelledBeforeEffect");

    // 1. The destination's ledger. The only evidence that counts.
    expect(dropbox.effectCount(keyFor("dk-1"))).toBe(0);
    // 2. The refusal is durable, and it is durable BEFORE the throw -- the
    //    discipline `StaleWriterRefused` carries and the reason a refusal
    //    nobody catches is still readable afterwards.
    const refusals = actionsOf(cp, { status: "refused" });
    expect(refusals).toHaveLength(1);
    expect(String(refusals[0]?.refusal_reason)).toMatch(/before the effect was attempted/);
    expect(refusals[0]?.idempotency_key).toBe(keyFor("dk-1"));
    // 3. The row is left exactly as the cancelling writer left it. This
    //    module writes nothing more to a row it has just refused to advance.
    const after = outbox.load(message.messageId);
    expect(after.status).toBe("cancelled");
    expect(after.deliveredAtMs).toBeNull();
    // 4. The steps that ran before the cancellation landed are NOT rolled
    //    back, and pretending otherwise would be the lie: the attempt count
    //    was incremented and the intent recorded before the gate closed, and
    //    both are true statements about what happened.
    expect(after.retryCount).toBe(1);
    expect(actionsOf(cp, { status: "pending" })).toHaveLength(1);
  });

  test("a cancellation landing after the effect is recorded, not swallowed", () => {
    // The residue the re-read above admits it cannot remove. Nothing of ours
    // runs between the status re-read and `handler.apply`, so a cancellation
    // inside that gap is invisible until the delivery transition tries to
    // land -- and by then the destination has been written to.
    //
    // What is under test is that the ledger stops being silent about it.
    // `_MARK_DELIVERED` matches nothing (no `cancelled -> delivered` edge in
    // 0003's lattice, and the `status = 'pending'` conjunct keeps the
    // disagreement in the WHERE clause rather than letting the forward-only
    // trigger abort mid-attempt), `allowNoRow` used to swallow that, and the
    // result was an effect at the destination with no envelope, no delivery
    // record, and nothing an operator could reconcile against.
    //
    // It is RECORDED rather than thrown, and the two reasons are worth
    // keeping: the effect really did land, so the returned outcome is a true
    // statement about this attempt; and a throw here would additionally cost
    // `MessageBus.poll` the whole batch it was building, since
    // `src/messagebus/bus.ts` accepts only two classes as residual. Nobody is
    // owed an exception for a race nobody could have avoided -- what they are
    // owed is a row.
    const root = caseRoot("s7");
    const cp = productionCpFixture(productionDbPath(root));
    const dropbox = dropboxFixture(root);
    const seen: string[] = [];
    const outbox = makeOutbox(cp, dropbox, {
      checkpoint: (name: string): void => {
        seen.push(name);
        if (name === CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD) {
          closeTheGateOver(cp, "msg-1");
        }
      },
    });
    const message = enqueue(outbox);

    const outcome = outbox.attempt(message.messageId, { nowMs: T0 + 10, epoch: EPOCH });
    expect(seen, "the checkpoint never fired, so no race was driven").toContain(
      CHECKPOINT_AFTER_EFFECT_BEFORE_RECORD,
    );

    // The effect is real, and the row will never say so: `cancelled` has no
    // outgoing edge, so there is no delivery instant and there never will be.
    expect(dropbox.effectCount(keyFor("dk-1"))).toBe(1);
    const after = outbox.load(message.messageId);
    expect(after.status).toBe("cancelled");
    expect(after.deliveredAtMs).toBeNull();

    // The evidence, in the table refusals are already written to. It names
    // the idempotency key the effect was keyed with, which is what makes it
    // reconcilable against the destination's own ledger.
    const refusals = actionsOf(cp, { status: "refused" });
    expect(refusals).toHaveLength(1);
    expect(String(refusals[0]?.refusal_reason)).toMatch(
      /retired after the destination had already been written to/,
    );
    expect(refusals[0]?.idempotency_key).toBe(keyFor("dk-1"));

    // And the attempt still reports what it did rather than throwing.
    expect(outcome.messageId).toBe(message.messageId);
    expect(outcome.idempotencyKey).toBe(keyFor("dk-1"));
  });
});
