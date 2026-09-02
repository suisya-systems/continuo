import { join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { onTestFinished } from "vitest";

import { KeyedDropbox } from "../../src/control_plane/destination.js";
import { NOTIFY_RECIPIENT, spikeRegistry } from "../../src/control_plane/handlers.js";
import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import { DELIVERY_LEASE_RESOURCE } from "../../src/messagebus/endpoint.js";
import { type DeliveredEnvelope, MessageBus } from "../../src/messagebus/index.js";
import { createTempDir } from "../helpers/tmp.js";

/**
 * The one place this suite knows the control plane's vocabulary -- and, since
 * the endpoint moved to production storage, the one place it chooses a
 * **schema**.
 *
 * Every database this suite runs against is built by
 * {@link createProductionControlPlane} (`src/control_plane/migrator.ts`), which
 * creates a production control plane migrated to head. It used to be
 * `createControlPlane` from `src/control_plane/schema.ts`, the spike schema, and
 * the move is forced rather than tidy-minded: `src/messagebus/endpoint.ts` now
 * opens its database with `openProductionControlPlane`, which refuses a spike
 * database outright (`CorruptStateRefused`, recognised by `application_id`), so
 * a spike fixture cannot produce a running endpoint at all. Underneath that is
 * the reason the endpoint moved: the human gate closes by writing the outbox
 * status `cancelled` (`closeGate` in `src/control_plane/gates.ts`), a status
 * added by migration `0003_outbox_cancelled_status.sql` -- and neither the gate
 * tables nor that status exist in the spike schema. A suite that keeps building
 * spike databases can only test a delivery path whose cancellation edge is
 * unreachable, which is to say it can only test the half that was never in
 * doubt.
 *
 * The `run` and `lease` rows below stay **raw inserts** across that move, and
 * they are valid verbatim: production's `run.status` CHECK admits `'running'`,
 * migration `0004` adds only a nullable `run.writer_epoch`, and the `lease`
 * table is character-identical between the two schemas. Fixtures in this
 * repository seed rows directly rather than through `admitRun` -- see
 * `test/control_plane/run-lifecycle.test.ts:110-131` for why admission is the
 * subject of its own tests and not the tool other suites build state with.
 *
 * Ported from interlock `tests/messagebus/_env.py` and `tests/messagebus/
 * conftest.py` at `65f36c5`, merged into one module because Vitest has no
 * `conftest.py`: a fixture here is an ordinary function a test calls, so the
 * source's split between "the module that knows the control plane" and "the
 * conftest that exposes it as fixtures" has nothing to sit on. The property
 * that split existed to produce is unchanged and is still checked --
 * `import-graph.test.ts` asserts it file by file.
 *
 * interlock's item 11 structural tests pin that no test file outside
 * `tests/gate_item11` imports both a session backend and the control plane.
 * This suite must exercise both worlds -- the bus is driven while a *session*
 * readout goes stale -- so the knowledge is split by file instead: this module
 * knows the control plane and the bus but no session backend, and
 * `stale-readout.test.ts` knows the session backend and the bus but reaches the
 * control plane only through the helpers defined here. No single file knows both
 * vocabularies, which is the same confinement the item 11 tests enforce, applied
 * one directory over.
 */

/** An arbitrary fixed epoch-milliseconds instant. */
export const T0 = 1_700_000_000_000;
/**
 * The delivery lease resource, taken from the product rather than spelled here.
 *
 * It used to be the literal `"messagebus-of-run-1"` -- a name shaped like one
 * lease *per run*, which is precisely the illusion D-0053 rule 4 forbids: the
 * outbox row carries no resource column and neither the due pass nor the
 * recovery pass is scoped to one, so a per-run name would advertise a
 * partitioning the schema does not have, and this suite would have been the
 * document a later reader consulted for it.
 *
 * Imported rather than re-spelled so the fixture and the endpoint cannot drift:
 * `main()` now admits exactly this string and refuses any other
 * (`src/messagebus/endpoint.ts`, {@link DELIVERY_LEASE_RESOURCE}), so a suite
 * carrying its own copy would keep passing on the day the product's name
 * changed and would leave the subprocess cases failing for a reason no
 * assertion here explained.
 */
export const RESOURCE = DELIVERY_LEASE_RESOURCE;
export const HOLDER = "bus-writer";
export const EPOCH = 1;
export const TTL_MS = 300_000;
export const RUN_ID = "run-1";

/**
 * The recipient the spike registry serves, re-exported so files that must not
 * import the control plane directly can still address it.
 */
export const RECIPIENT = NOTIFY_RECIPIENT;

/** One isolated delivery world: a fresh database, destination, and bus. */
export class BusEnv {
  readonly bus: MessageBus;
  readonly dropbox: KeyedDropbox;
  readonly connection: SqliteDatabase;
  readonly dbPath: string;

  constructor(fields: {
    readonly bus: MessageBus;
    readonly dropbox: KeyedDropbox;
    readonly connection: SqliteDatabase;
    readonly dbPath: string;
  }) {
    this.bus = fields.bus;
    this.dropbox = fields.dropbox;
    this.connection = fields.connection;
    this.dbPath = fields.dbPath;
  }

  /** The destination's own count for the spike handler's effect key. */
  effectCount(dedupKey: string): number {
    return this.dropbox.effectCount(`${RECIPIENT}:notify:${dedupKey}`);
  }

  ackedRowCount(): number {
    const row = this.connection
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'acked'")
      .get() as { n: number };
    return Number(row.n);
  }

  /** The status of one outbox row, or `null` when there is no such row. */
  outboxStatus(messageId: string): string | null {
    const row = this.connection
      .prepare("SELECT status FROM outbox WHERE message_id = ?")
      .get(messageId) as { status: string } | undefined;
    return row === undefined ? null : row.status;
  }

  /**
   * Cancel one relay the way gate closure cancels it.
   *
   * This is deliberately a **copy of closure's own statement**, not a
   * convenience `UPDATE outbox SET status = 'cancelled' WHERE message_id = ?`.
   * The original lives at the end of `_closeGate` in
   * `src/control_plane/gates.ts` (around line 1657) and reads:
   *
   * ```sql
   * UPDATE outbox
   *    SET status = 'cancelled'
   *  WHERE status IN ('pending', 'delivered')
   *    AND message_id IN (SELECT message_id FROM gate_relay WHERE gate_id = ?)
   * ```
   *
   * Only the row *selector* changes here -- this suite has no gates, so a
   * message id stands in for the `gate_relay` subquery. The `SET` and the
   * `status IN ('pending', 'delivered')` guard are reproduced character for
   * character, and reproducing them is the point: a test that cancelled with a
   * looser predicate would be pinning the bus's behaviour against a cancellation
   * shape **the product never writes**, and would keep passing if the product's
   * own guard were lost. The guard is also what makes this idempotent in the
   * same way closure is -- a second call moves no row rather than tripping
   * `outbox_status_is_forward_only`, which has no edge out of a terminal status.
   *
   * Returns the number of rows moved, so a case can assert it cancelled
   * something rather than assuming it did; a cancellation that silently matched
   * nothing would make every assertion after it vacuous.
   */
  cancelRelay(messageId: string): number {
    const info = this.connection
      .prepare(
        "UPDATE outbox SET status = 'cancelled'" +
          " WHERE status IN ('pending', 'delivered') AND message_id = ?",
      )
      .run(messageId);
    return info.changes;
  }

  /** Rows the outbox durably refused. The audit trail, as a number. */
  refusedActionCount(): number {
    const row = this.connection
      .prepare("SELECT COUNT(*) AS n FROM action WHERE status = 'refused'")
      .get() as { n: number };
    return Number(row.n);
  }

  close(): void {
    this.connection.close();
  }
}

/** Options for {@link makeBusEnv}, all with the suite's defaults. */
export interface BusEnvOptions {
  readonly nowMs?: number;
  readonly ttlMs?: number;
  readonly checkpoint?: (name: string) => void;
}

/**
 * One fresh world.
 *
 * `nowMs` anchors the run and lease rows: the suite's fixed instant by default,
 * real wall-clock time for the endpoint tests, whose server reads the clock
 * itself.
 */
export function makeBusEnv(root: string, tag: string, options: BusEnvOptions = {}): BusEnv {
  const { nowMs = T0, ttlMs = TTL_MS, checkpoint } = options;
  const dbPath = join(root, `control-plane-${tag}.sqlite3`);
  // `nowMs` is required and must be an integer: `createProductionControlPlane`
  // stamps it into every `schema_migration.applied_at_ms` row it writes and
  // refuses a non-integer outright (`requireEpochMs`,
  // `src/control_plane/migrator.ts`). The fixture's own instant is passed so the
  // ledger, the run and the lease all agree on when this world began -- the
  // endpoint cases hand in wall-clock time here for the same reason they hand it
  // to the run row.
  const connection = createProductionControlPlane(dbPath, { nowMs });
  connection
    .prepare(
      "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'running', ?, ?)",
    )
    .run(RUN_ID, nowMs, nowMs);
  connection
    .prepare(
      "INSERT INTO lease (resource, holder, epoch, acquired_at_ms, expires_at_ms)" +
        " VALUES (?, ?, ?, ?, ?)",
    )
    .run(RESOURCE, HOLDER, EPOCH, nowMs, nowMs + ttlMs);
  const dropbox = new KeyedDropbox(join(root, `destination-${tag}`), `worker-inbox-${tag}`);
  const registry = spikeRegistry(dropbox);
  const bus =
    checkpoint === undefined
      ? new MessageBus(connection, { resource: RESOURCE, holder: HOLDER, registry })
      : new MessageBus(connection, { resource: RESOURCE, holder: HOLDER, registry, checkpoint });
  return new BusEnv({ bus, dropbox, connection, dbPath });
}

/**
 * The source's `bus_env_factory` fixture: build as many isolated worlds as the
 * case needs, all under one per-test root, all closed when the test finishes.
 *
 * pytest's `yield` teardown becomes `onTestFinished`, which runs on failure too
 * -- a database left open by a failing case would leak a handle into whatever
 * ran next, and under a shuffled order that is a different case each run.
 */
export function busEnvFactory(
  label = "messagebus",
): (tag: string, options?: BusEnvOptions) => BusEnv {
  const root = createTempDir(label);
  return (tag, options) => {
    const env = makeBusEnv(root, tag, options ?? {});
    onTestFinished(() => {
      env.close();
    });
    return env;
  };
}

/** The source's `bus_env` fixture: one world, named `main`. */
export function busEnv(label = "messagebus"): BusEnv {
  return busEnvFactory(label)("main");
}

/** One presentation, reduced to the facts two runs are compared on. */
type Presentation = readonly [string, string, number, boolean];

/** What {@link dropThenResendTranscript} records. */
export interface Transcript {
  readonly first_poll: readonly Presentation[];
  readonly second_poll: readonly Presentation[];
  readonly acks_recorded: readonly [boolean, boolean];
  readonly effect_count: number;
  readonly acked_rows: number;
  readonly due_after_settlement: readonly string[];
}

function presentation(envelope: DeliveredEnvelope): Presentation {
  return [envelope.messageId, envelope.payload, envelope.retryCount, envelope.deduplicated];
}

/**
 * The item 6 acceptance sequence, recorded as comparable facts.
 *
 * Send one task; run a first poll whose response is treated as lost on the wire
 * (nothing on the worker side survives it, so nothing is acked); poll again; ack
 * once; ack again to show idempotency. Everything the sequence proves is
 * returned as a plain object so two runs of it -- one against a healthy session
 * backend, one against a deliberately stale readout -- can be compared for
 * equality: *delivery outcomes are unchanged* is then a literal `toEqual`, not
 * an interpretation.
 */
export function dropThenResendTranscript(
  env: BusEnv,
  options: {
    readonly messageId?: string;
    readonly dedupKey?: string;
    readonly payload?: string;
  } = {},
): Transcript {
  const {
    messageId = "task-1",
    dedupKey = "dk-task-1",
    payload = '{"task":"say hello"}',
  } = options;
  const bus = env.bus;
  bus.send({
    messageId,
    recipient: RECIPIENT,
    payload,
    dedupKey,
    nowMs: T0,
    epoch: EPOCH,
    runId: RUN_ID,
  });
  const first = bus.poll(RECIPIENT, { nowMs: T0 + 1_000, epoch: EPOCH });
  // The first response is dropped: the worker never sees these envelopes, acks
  // nothing, and keeps no state. The rows stay delivered-but-unacked.
  const second = bus.poll(RECIPIENT, { nowMs: T0 + 2_000, epoch: EPOCH });
  const firstAck = bus.ack(messageId, { nowMs: T0 + 3_000, recipient: RECIPIENT });
  const duplicateAck = bus.ack(messageId, { nowMs: T0 + 4_000, recipient: RECIPIENT });
  return {
    first_poll: first.map(presentation),
    second_poll: second.map(presentation),
    acks_recorded: [firstAck.recorded, duplicateAck.recorded],
    effect_count: env.effectCount(dedupKey),
    acked_rows: env.ackedRowCount(),
    due_after_settlement: env.bus.outbox.due(T0 + 10_000).map((m) => m.messageId),
  };
}

/**
 * What the acceptance sequence must record, independent of which session backend
 * exists around it.
 *
 * Spelled out once: the first delivery is attempted (retryCount 1, a fresh
 * effect), the resend re-presents the same payload (retryCount 2, deduplicated
 * by the destination), exactly one ack is recorded, the destination holds
 * exactly one effect, and nothing stays due.
 */
export function expectedTranscript(
  options: { readonly messageId?: string; readonly payload?: string } = {},
): Transcript {
  const { messageId = "task-1", payload = '{"task":"say hello"}' } = options;
  return {
    first_poll: [[messageId, payload, 1, false]],
    second_poll: [[messageId, payload, 2, true]],
    acks_recorded: [true, false],
    effect_count: 1,
    acked_rows: 1,
    due_after_settlement: [],
  };
}
