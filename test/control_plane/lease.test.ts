/**
 * S6 -- the lease, and the fencing token validated atomically with each write.
 *
 * Ported from interlock `tests/control_plane/test_lease.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping is recorded in the parity
 * ledger.
 *
 * The tests are the durable half of this issue (D-0026): the implementation they
 * exercise may be thrown away, and they are written so that whatever replaces it
 * still has to answer the same questions. The six acceptance criteria of Issue
 * `#13` are the section headings below, in order.
 *
 * Two rules run through the whole file:
 *
 * **No case may lean on a provider refusing a duplicate.** Under C2 the
 * provider's own "already in use" refusal has a measured admission window (U27)
 * and the `--resume` path excludes nothing at all (U32). No case here involves a
 * provider, and "no dependency edge on the session provider" asserts that
 * structurally rather than describing it.
 *
 * **No case proves an invariant from the absence of a symptom.** Every assertion
 * lands on a durable record -- a row in SQLite, or the external destination's own
 * effect record where the effect is external, as `ACCEPTANCE.md` section 2
 * requires.
 *
 * Translation notes, each a rule rather than a local choice:
 *
 * * The `db_path` and `cp` fixtures are plain functions called inside the test
 *   (conventions rule 8); every connection registers its `close()` with
 *   `onTestFinished` at the point of acquisition (rule 1). The database file is
 *   named with `node:path`'s `join`, never with a `/` (rule 6).
 * * The `caseRoot` label is `s6`, the source's own nickname for this module
 *   (D-0020). No refusal this file asserts on interpolates a filesystem path at
 *   all, and no assertion literal below occurs in
 *   `<tmp>/continuo-s6-w0-XXXX/control-plane.sqlite3`, so no `match` can be made
 *   unfailable by the temp path.
 * * `sqlite3.IntegrityError` becomes {@link expectSqliteError} on the result
 *   **code** (`SQLITE_CONSTRAINT*`), which is the durable half of the assertion
 *   (D-0016); the message text SQLite prints is not a compatibility surface.
 * * `Lease` is a frozen `@dataclass`, so `==` between two of them is a field
 *   comparison. `toStrictEqual` is the mapping that keeps **both** halves -- the
 *   fields and the class -- where `toEqual` would drop the class.
 * * Python's `None` for an absent row is `undefined` here (D-0007), never `null`.
 * * Two cases reach for the Python runtime rather than for the module:
 *   `ast` (the import graph) and `dataclasses` (field defaults). Neither exists
 *   at runtime in TypeScript; both are translated the way
 *   `migrator.test.ts`'s "the module exposes no down migration api" translates
 *   `dir(m)` -- a scan over the module's own source text, with an explicit
 *   anti-vacuity assertion so a scan that matched nothing fails instead of
 *   passing.
 * * `object.__setattr__` on a frozen dataclass has no TypeScript equivalent:
 *   `Object.freeze` makes the assignment throw. The rendering-time revalidation
 *   the source proves through that hole is reached instead through a *clone*
 *   built with `Object.create(<ctor>.prototype)`, which the module's exact-type
 *   gates accept exactly as they accept the real node -- so the same production
 *   code path runs, and the freeze itself is asserted alongside it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import * as s6 from "../../src/control_plane/lease.js";
import {
  acquire,
  and_,
  appliedEpochRegressions,
  authorityTimeline,
  type Claim,
  ClockSkewRefused,
  type Comparison,
  claimedTimeline,
  DESTINATIONS,
  DestinationFencing,
  DestinationRejectedStaleToken,
  EpochGuardedDestination,
  effectKind,
  epochRegressions,
  eq,
  FENCE_PARAMS,
  FENCE_SQL,
  FencedStatement,
  fencedInsert,
  fencedUpdate,
  fenceEpoch,
  IsNull,
  isNull,
  Lease,
  LeaseHeld,
  LeaseNotHeld,
  LeaseUsageError,
  leaseSeams,
  ne,
  overlappingClaims,
  Param,
  PROTECTED_TABLES,
  ProtectedWrite,
  ProtectedWriteMissed,
  param,
  protectedWrite,
  readLease,
  release,
  renew,
  resourceOfKind,
  StaleWriterRefused,
  UnfencedStatement,
  Value,
  value,
  writeHistory,
} from "../../src/control_plane/lease.js";
import { createControlPlane, openControlPlane } from "../../src/control_plane/schema.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal, expectSqliteError } from "../testkit/errors.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const TTL = 30_000;
const RESOURCE = "run/r1";

/** The register's written-down counterpart, as the source resolves it. */
const DOC = fileURLToPath(new URL("../../docs/lease-fencing.md", import.meta.url));

/** This module's own source text, for the two introspection cases. */
const MODULE_SOURCE_PATH = fileURLToPath(
  new URL("../../src/control_plane/lease.ts", import.meta.url),
);

/** The result code family a schema trigger's `RAISE(ABORT, ...)` produces. */
const CONSTRAINT = /^SQLITE_CONSTRAINT/;

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------

/** The source's `db_path` fixture: a name inside a per-test directory. */
function dbPathFixture(): string {
  return join(caseRoot("s6"), "control-plane.sqlite3");
}

/** The source's `cp` fixture: a spike control plane holding one run. */
function cpFixture(dbPath: string): SqliteDatabase {
  const connection = createControlPlane(dbPath);
  closeWhenFinished(connection);
  connection
    .prepare<[string, string, number, number]>(
      "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
    )
    .run("r1", "running", T0, T0);
  return connection;
}

/** A second handle on the same file -- what committed, rather than what `cp` can see. */
function reopen(dbPath: string): SqliteDatabase {
  const connection = openControlPlane(dbPath);
  closeWhenFinished(connection);
  return connection;
}

/**
 * Register a connection's `close()` at the moment it is acquired (rule 1).
 *
 * Guarded, because two cases close their connection mid-test the way the source
 * does; closing an already-closed handle is not a reason to fail a passing test.
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

// --------------------------------------------------------------------------
// helpers -- the smallest protected write there is
//
// The protected table is `action`: it carries writer_epoch, it is where a
// refusal is recorded, and its one-effect-per-key index makes a second landing
// visible as a row rather than as a suspicion.
// --------------------------------------------------------------------------

const EFFECT_KIND = effectKind(RESOURCE, "deliver_task");

const APPLY_EFFECT = fencedInsert("action", {
  values: {
    action_id: param("action_id"),
    run_id: value("r1"),
    kind: param("kind"),
    idempotency_key: param("idempotency_key"),
    exactly_once_mechanism: param("mechanism"),
    status: value("applied"),
    applied_at_ms: param("now_ms"),
    writer_epoch: fenceEpoch,
    created_at_ms: param("now_ms"),
  },
});

function effect(
  actionId: string,
  options: {
    readonly key?: string | null;
    readonly nowMs: number;
    readonly kind?: string;
    readonly mechanism?: string;
  },
): ProtectedWrite {
  const {
    key = null,
    nowMs,
    kind = EFFECT_KIND,
    mechanism = "transactional_with_record",
  } = options;
  const idempotencyKey = key || actionId;
  return new ProtectedWrite({
    kind,
    idempotencyKey,
    statement: APPLY_EFFECT,
    exactlyOnceMechanism: mechanism,
    runId: "r1",
    params: {
      action_id: actionId,
      kind,
      idempotency_key: idempotencyKey,
      mechanism,
      now_ms: nowMs,
    },
  });
}

function actionRows(connection: SqliteDatabase): Record<string, unknown>[] {
  return connection
    .prepare(
      "SELECT action_id, status, refusal_reason, writer_epoch, created_at_ms " +
        "FROM action ORDER BY created_at_ms, action_id",
    )
    .all() as Record<string, unknown>[];
}

/** How many times `needle` occurs in `haystack` -- Python's `str.count`. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * A builder node cloned and mutated after its own validation ran.
 *
 * The source reaches through `frozen=True` with `object.__setattr__`. Here
 * `Object.freeze` refuses that outright, so the mutated node is built as a
 * clone carrying the same prototype: `isExact()` accepts it exactly as it
 * accepts the original, which is what puts the rendering-time revalidation --
 * the code path the source case exists for -- under test.
 */
function mutatedClone<T extends object>(node: T, changes: Readonly<Record<string, unknown>>): T {
  const clone = Object.create(Object.getPrototypeOf(node) as object) as T;
  Object.assign(clone, node, changes);
  return clone;
}

/**
 * The source's `Sneaky(str)`: every text check passes while its own methods
 * stay its author's code.
 *
 * JavaScript has no separate `__format__` hook -- `toString` is both -- so the
 * hostile formatting lives there.
 */
class Sneaky extends String {
  override replace(): string {
    return "'x' WHERE 1 --";
  }
  override toString(): string {
    return "action (x) SELECT 1 WHERE 1 --";
  }
}

/** The same subclass without the hostile formatting, for the mapping-key case. */
class SneakyName extends String {}

/** The IntEnum member of the source's constant-rendering case. */
enum Status {
  DONE = 7,
}

// ==========================================================================
// Criterion 1 -- a protected write carrying a stale token is refused, and the
// refusal is recorded rather than silently dropped.
// ==========================================================================

describe(
  "Criterion 1 -- a protected write carrying a stale token is refused, and the refusal is " +
    "recorded rather than silently dropped.",
  () => {
    test("a live token writes", () => {
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

      expect(protectedWrite(cp, lease, effect("a1", { nowMs: T0 + 1 }), { nowMs: T0 + 1 })).toBe(1);

      const rows = actionRows(cp);
      expect(rows).toHaveLength(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row["status"]).toBe("applied");
      // The epoch the row was written under is what the single-writer property is
      // read back out of afterwards; a fenced write that left it NULL would be
      // unprovable later, so protectedWrite refuses that statement outright.
      expect(row["writer_epoch"]).toBe(lease.epoch);
    });

    test("a superseded token is refused and the refusal is recorded", () => {
      const cp = cpFixture(dbPathFixture());
      const stale = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      // The holder is killed without releasing. The lease expires on its own, and a
      // second claimant takes it -- which is what raises the epoch.
      const live = acquire(cp, {
        resource: RESOURCE,
        holder: "beta",
        nowMs: T0 + TTL + 1,
        ttlMs: TTL,
      });

      const refused = expectRefusal(
        () =>
          protectedWrite(cp, stale, effect("a-stale", { nowMs: T0 + TTL + 2 }), {
            nowMs: T0 + TTL + 2,
            attemptId: "refusal-1",
          }),
        StaleWriterRefused,
      );

      expect(refused.actionId).toBe("refusal-1");
      expect(refused.observed).toStrictEqual(live);

      const rows = actionRows(cp);
      expect(rows).toHaveLength(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row["action_id"]).toBe("refusal-1");
      expect(row["status"]).toBe("refused");
      // The reason names who was refused, which token they presented, and what the
      // lease actually was -- a refusal recorded as a bare flag is a refusal
      // nobody can act on.
      const reason = row["refusal_reason"] as string;
      expect(reason).toContain("stale fencing token");
      expect(reason).toContain("'alpha'");
      expect(reason).toContain("'beta'");
      expect(row["writer_epoch"]).toBe(stale.epoch);
      expect(stale.epoch).toBe(1);
      // The effect itself did not happen. Asserted against the rows, not against
      // the absence of a visible duplicate. Read positionally: the SELECT list is
      // a bare literal, not a column reference.
      expect(cp.prepare("SELECT 1 FROM action WHERE status = 'applied'").raw().all()).toEqual([]);
    });

    test("an expired token is refused even with nobody else holding it", () => {
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

      expectRefusal(
        () =>
          protectedWrite(cp, lease, effect("a1", { nowMs: T0 + TTL + 1 }), { nowMs: T0 + TTL + 1 }),
        StaleWriterRefused,
      );

      const rows = actionRows(cp);
      expect(rows).toHaveLength(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row["status"]).toBe("refused");
      // Nobody took the lease over, so the row still names the expired holder --
      // the refusal is the expiry's, not a handover's.
      expect(row["refusal_reason"] as string).toContain("holder='alpha'");
    });

    test("the returning paused holder is refused repeatedly and recorded each time", () => {
      // The SIGSTOP case from `ACCEPTANCE.md` section 2's lease row.
      //
      // A paused process is modelled by a holder that simply does not act -- no
      // signal is portable to the Windows jobs, and pausing is not what the
      // property depends on. What matters is that the lease expired while it was
      // away, a second claimant took it, and the returning holder's writes are
      // refused *every* time rather than once.
      const cp = cpFixture(dbPathFixture());
      const paused = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      acquire(cp, { resource: RESOURCE, holder: "beta", nowMs: T0 + TTL + 1, ttlMs: TTL });

      for (const attempt of [0, 1, 2]) {
        expectRefusal(
          () =>
            protectedWrite(
              cp,
              paused,
              effect(`a-return-${attempt}`, {
                key: "same-effect",
                nowMs: T0 + TTL + 10 + attempt,
              }),
              { nowMs: T0 + TTL + 10 + attempt, attemptId: `refusal-${attempt}` },
            ),
          StaleWriterRefused,
        );
      }

      const rows = actionRows(cp);
      // Three refusals under one idempotency key. The schema's
      // action_one_effect_per_key index excludes refused rows precisely so that a
      // writer which keeps coming back is recorded every time, without any of
      // those records becoming the thing that admits a second effect.
      expect(rows.map((row) => row["status"])).toEqual(["refused", "refused", "refused"]);
      expect(new Set(rows.map((row) => row["action_id"])).size).toBe(3);
    });

    test("the recorded refusal survives the process that recorded it", () => {
      const dbPath = dbPathFixture();
      const cp = cpFixture(dbPath);
      const stale = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      acquire(cp, { resource: RESOURCE, holder: "beta", nowMs: T0 + TTL + 1, ttlMs: TTL });
      expectRefusal(
        () =>
          protectedWrite(cp, stale, effect("a1", { nowMs: T0 + TTL + 2 }), {
            nowMs: T0 + TTL + 2,
            attemptId: "refusal-1",
          }),
        StaleWriterRefused,
      );
      cp.close();

      const reopened = reopen(dbPath);
      const rows = actionRows(reopened);
      expect(rows).toHaveLength(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row["action_id"]).toBe("refusal-1");
      expect(row["status"]).toBe("refused");
      // And the schema keeps it that way: a refused action that could be moved
      // back to 'pending' is a rejection erased by the same statement that
      // makes the attempt executable again.
      expectSqliteError(
        () =>
          reopened
            .prepare("UPDATE action SET status = 'pending' WHERE action_id = 'refusal-1'")
            .run(),
        { code: CONSTRAINT },
      );
    });

    test("a refusal is recorded even when the lease row is gone entirely", () => {
      // A token for a resource that was never taken is stale, not a crash.
      const cp = cpFixture(dbPathFixture());
      const invented = new Lease("run/never-taken", "alpha", 7, T0, T0 + TTL);

      const refused = expectRefusal(
        () =>
          protectedWrite(
            cp,
            invented,
            effect("a1", {
              nowMs: T0 + 1,
              kind: effectKind("run/never-taken", "deliver_task"),
            }),
            { nowMs: T0 + 1 },
          ),
        StaleWriterRefused,
      );

      expect(refused.observed).toBeUndefined();
      const rows = actionRows(cp);
      expect(rows).toHaveLength(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row["status"]).toBe("refused");
      expect(row["refusal_reason"] as string).toContain("absent");
    });
  },
);

// ==========================================================================
// Criterion 2 -- validation is atomic with the write in a single transaction,
// and the check-then-write shape would have admitted a writer the atomic shape
// refuses.
// ==========================================================================

/**
 * The shape `ACCEPTANCE.md` section 2 names as insufficient.
 *
 * Written out here, in the tests, rather than offered by the module: the check
 * reads the lease, *something happens*, and the write goes ahead on the
 * strength of what the check saw. The interleaving is a callback so the race
 * is deterministic and reproducible rather than a sleep and a hope.
 */
function checkThenWrite(
  cp: SqliteDatabase,
  lease: Lease,
  actionId: string,
  options: { readonly nowMs: number; readonly interleave: () => void },
): number {
  const { nowMs, interleave } = options;
  const observed = readLease(cp, lease.resource);
  if (observed === undefined || observed.epoch !== lease.epoch || !observed.looksLiveAt(nowMs)) {
    return 0; // the check refuses
  }

  interleave(); // the window: the lease expires, or is taken over, right here

  const info = cp
    .prepare(
      `
        INSERT INTO action (action_id, run_id, kind, idempotency_key,
                            exactly_once_mechanism, status, applied_at_ms,
                            writer_epoch, created_at_ms)
        VALUES (:action_id, 'r1', :kind, :action_id, 'transactional_with_record',
                'applied', :now_ms, :epoch, :now_ms)
        `,
    )
    .run({ action_id: actionId, kind: EFFECT_KIND, now_ms: nowMs, epoch: lease.epoch });
  return info.changes;
}

describe(
  "Criterion 2 -- validation is atomic with the write in a single transaction, and the " +
    "check-then-write shape would have admitted a writer the atomic shape refuses.",
  () => {
    test("check then write admits the writer the atomic shape refuses", () => {
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

      const takeover = (): void => {
        acquire(cp, { resource: RESOURCE, holder: "beta", nowMs: T0 + TTL + 1, ttlMs: TTL });
      };

      // The check passes at T0 + 1; the lease is taken over inside the window; the
      // write lands anyway, carrying an epoch that is no longer anybody's.
      expect(checkThenWrite(cp, lease, "admitted", { nowMs: T0 + 1, interleave: takeover })).toBe(
        1,
      );
      const admitted = actionRows(cp);
      expect((admitted[0] as Record<string, unknown>)["status"]).toBe("applied");
      expect((admitted[0] as Record<string, unknown>)["writer_epoch"]).toBe(1);
      expect(readLease(cp, RESOURCE)?.epoch).toBe(2);

      // The atomic shape, offered the same stale token afterwards, refuses it --
      // there is no instant between the validation and the write for the lease to
      // move in, because they are one statement.
      expectRefusal(
        () =>
          protectedWrite(cp, lease, effect("atomic", { nowMs: T0 + TTL + 2 }), {
            nowMs: T0 + TTL + 2,
          }),
        StaleWriterRefused,
      );

      expect(actionRows(cp).map((row) => row["status"])).toEqual(["applied", "refused"]);
    });

    test("the fence lives in the database not in the lease object", () => {
      // A second connection's takeover invalidates the first one's token.
      //
      // If the validation were a property of the in-process `Lease`, this would
      // pass: nothing on `cp` ever saw the handover. It fails because the fence
      // is evaluated by SQLite, in the write, against the row.
      const dbPath = dbPathFixture();
      const cp = cpFixture(dbPath);
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      const other = reopen(dbPath);
      try {
        acquire(other, { resource: RESOURCE, holder: "beta", nowMs: T0 + TTL + 1, ttlMs: TTL });
      } finally {
        other.close();
      }

      expectRefusal(
        () =>
          protectedWrite(cp, lease, effect("a1", { nowMs: T0 + TTL + 2 }), { nowMs: T0 + TTL + 2 }),
        StaleWriterRefused,
      );
    });

    test("an unfenced statement cannot be run through this module", () => {
      const refused = expectRefusal(
        () =>
          new ProtectedWrite({
            kind: EFFECT_KIND,
            idempotencyKey: "k",
            statement:
              "UPDATE action SET status = 'applied' WHERE action_id = :a" as unknown as FencedStatement,
            exactlyOnceMechanism: "transactional_with_record",
          }),
        UnfencedStatement,
      );
      expect(refused.message).toContain("fenced_update");
    });

    test("a statement that mentions the fence without obeying it is refused", () => {
      // The shape a substring check would have waved through.
      //
      // This statement carries `FENCE_SQL` verbatim -- in a `SET` expression,
      // where it decides a *value* rather than whether the row changes. Under a
      // stale token it still updates its row and still reports a positive
      // rowcount: a protected write that silently is not one. Only the builders
      // can issue a statement, so this cannot be handed to `protectedWrite` at
      // all.
      const smuggled =
        "UPDATE action\n" +
        `   SET writer_epoch = CASE WHEN ${FENCE_SQL} THEN :fence_epoch ELSE 0 END\n` +
        " WHERE action_id = :action_id";
      expectRefusal(
        () =>
          new ProtectedWrite({
            kind: EFFECT_KIND,
            idempotencyKey: "k",
            statement: smuggled as unknown as FencedStatement,
            exactlyOnceMechanism: "transactional_with_record",
          }),
        UnfencedStatement,
      );
      // ...and it cannot be laundered into one either.
      expectRefusal(() => new FencedStatement(smuggled), UnfencedStatement);
    });

    test("a fenced statement that forgets the epoch is refused", () => {
      // The history is only readable if every fenced write stamps its epoch.
      expectRefusal(
        () =>
          fencedUpdate("action", {
            set: { status: value("applied") },
            where: eq("action_id", param("a")),
          }),
        UnfencedStatement,
      );
      // Assigning the column is not stamping it: a constant -- or any value other
      // than the fenceEpoch sentinel -- leaves a row whose epoch means nothing,
      // and writeHistory() would then be reading a number it cannot trust.
      expectRefusal(
        () =>
          fencedUpdate("action", {
            set: { writer_epoch: value(1) },
            where: eq("action_id", param("a")),
          }),
        UnfencedStatement,
      );
      expectRefusal(
        () => fencedInsert("action", { values: { action_id: param("a"), writer_epoch: value(1) } }),
        UnfencedStatement,
      );
      // The mapping shape closes the old duplicate-assignment hole by construction:
      // "SET writer_epoch = :fence_epoch, writer_epoch = 1" needed two values under
      // one column name, and a mapping holds exactly one value per key.
      expectRefusal(() => param("fence_epoch"), LeaseUsageError);
      // ...and the opt-out is explicit, for a target that genuinely has no such
      // column -- and it means what it says: opting out and stamping anyway are
      // two claims that cannot both be true.
      fencedUpdate("run", {
        set: { status: value("done") },
        where: eq("run_id", param("r")),
        stampsWriterEpoch: false,
      });
      expectRefusal(
        () =>
          fencedUpdate("run", {
            set: { status: value("done"), writer_epoch: fenceEpoch },
            where: eq("run_id", param("r")),
            stampsWriterEpoch: false,
          }),
        UnfencedStatement,
      );
    });

    test("no sql text crosses the builder boundary", () => {
      // The retired lexer proved a fragment could not restructure the statement;
      // the typed builders retire the question. There is no fragment: SQL text
      // offered where a typed object belongs is refused outright, whatever it
      // says.
      expectRefusal(
        // a raw predicate, however innocent
        () =>
          fencedUpdate("action", {
            set: { writer_epoch: fenceEpoch },
            where: "action_id = :a" as unknown as Comparison,
          }),
        UnfencedStatement,
      );
      expectRefusal(
        // a raw SET clause
        () =>
          fencedUpdate("action", {
            set: "writer_epoch = :fence_epoch" as unknown as Record<string, unknown>,
            where: eq("action_id", param("a")),
          }),
        UnfencedStatement,
      );
      expectRefusal(
        // a raw operand inside a typed predicate
        () => eq("action_id", ":a" as unknown as Param),
        UnfencedStatement,
      );
      expectRefusal(
        // a raw assignment value
        () =>
          fencedUpdate("action", {
            set: { status: "'applied'", writer_epoch: fenceEpoch },
            where: eq("action_id", param("a")),
          }),
        UnfencedStatement,
      );
      expectRefusal(
        // a raw VALUES clause on an insert
        () =>
          fencedInsert("action", {
            values: "(:a, :fence_epoch)" as unknown as Record<string, unknown>,
          }),
        UnfencedStatement,
      );
      expectRefusal(
        // a raw value inside an insert mapping
        () =>
          fencedInsert("action", {
            values: { action_id: "'x' WHERE 1 --", writer_epoch: fenceEpoch },
          }),
        UnfencedStatement,
      );
    });

    test("a subclass is not a str however equal it compares", () => {
      // Escaping and formatting dispatch through the object's own methods.
      //
      // A str subclass passes every text check while its `replace` or
      // `__format__` stays its author's code -- the one way left to hand the
      // builder text it did not render itself. So an exact built-in str is
      // required everywhere a string is rendered: constants, identifiers, and the
      // table name, which is canonicalised to the closed set's own string rather
      // than formatted from the caller's object.
      expectRefusal(() => value(new Sneaky("harmless") as unknown as string), LeaseUsageError);
      expectRefusal(() => param(new Sneaky("p") as unknown as string), LeaseUsageError);
      expectRefusal(() => eq(new Sneaky("c") as unknown as string, value(1)), LeaseUsageError);

      // The builder's own types admit no subclasses either: a Param, Value or
      // predicate subclass passes every construction-time validation -- these
      // ones do, their fields are innocent -- while its attribute reads stay its
      // author's code, free to answer rendering with different text. Exact-type
      // gates refuse the instance itself, however valid its fields look.
      class SneakyParam extends Param {}
      class SneakyValue extends Value {}
      class SneakyIsNull extends IsNull {}
      const sneakyParam = new SneakyParam("p");
      const sneakyValue = new SneakyValue("x");
      const sneakyPredicate = new SneakyIsNull("resolved_at_ms");

      expectRefusal(
        () =>
          fencedUpdate("run", {
            set: { status: sneakyValue },
            where: eq("run_id", param("r")),
            stampsWriterEpoch: false,
          }),
        UnfencedStatement,
      );
      expectRefusal(
        () =>
          fencedInsert("action", { values: { action_id: sneakyParam, writer_epoch: fenceEpoch } }),
        UnfencedStatement,
      );
      expectRefusal(() => eq("run_id", sneakyParam), UnfencedStatement);
      expectRefusal(
        () =>
          fencedUpdate("run", {
            set: { status: value("done") },
            where: sneakyPredicate as unknown as Comparison,
            stampsWriterEpoch: false,
          }),
        UnfencedStatement,
      );
      // ...and a foreign _FenceEpoch instance is not the sentinel: the stamp is
      // matched by identity, so only fenceEpoch itself mints it.
      const foreignSentinel = new (fenceEpoch.constructor as new () => object)();
      expectRefusal(
        () =>
          fencedUpdate("action", {
            set: { writer_epoch: foreignSentinel },
            where: eq("action_id", param("a")),
          }),
        UnfencedStatement,
      );
      // The source refuses a str-subclass *mapping key* with an exact-type gate.
      // JavaScript has no such key: a property key is coerced to a primitive
      // string before the object exists, so the caller's object never reaches the
      // builder at all -- the hole is closed one step earlier than the source
      // closes it. Asserted rather than assumed.
      const sneakyKeyed: Record<string, unknown> = {
        [new SneakyName("status") as unknown as string]: value("done"),
      };
      expect(Object.keys(sneakyKeyed)).toEqual(["status"]);
      expect(typeof Object.keys(sneakyKeyed)[0]).toBe("string");
      expect(
        String(
          fencedUpdate("run", {
            set: sneakyKeyed,
            where: eq("run_id", param("r")),
            stampsWriterEpoch: false,
          }),
        ),
      ).toContain("SET status = 'done'");

      // The table name is the one caller string that survives: it comes back out
      // of PROTECTED_TABLES, so the statement carries our constant, not the
      // caller's object.
      const statement = fencedUpdate("run", {
        set: { status: value("done") },
        where: eq("run_id", param("r")),
        stampsWriterEpoch: false,
      });
      expect(statement.startsWith("UPDATE run\n")).toBe(true);
      // Accepted, and canonicalised -- the source's direction, not a refusal.
      // Python's `table not in PROTECTED_TABLES` compares by `==`, so a `str`
      // subclass gets in, and `.index()` then hands back the closed set's own
      // string so the template formats OUR constant rather than the caller's
      // object. `requireTable` coerces before its lookup for exactly that
      // reason; a strict `indexOf` would refuse here instead, which is the
      // opposite answer and would leave the canonicalisation it performs as
      // dead code.
      const sneakyTable = fencedUpdate(new Sneaky("run") as unknown as string, {
        set: { status: value("done") },
        where: eq("run_id", param("r")),
        stampsWriterEpoch: false,
      });
      expect(String(sneakyTable)).toBe(String(statement));
    });

    test("a node mutated after construction is refused at rendering", () => {
      // `frozen=True` yields to `object.__setattr__`; the rendering does not.
      //
      // A validated node retained and mutated between construction and the
      // builder call would otherwise carry the mutation straight into the
      // statement -- eq()'s column rewritten to `"run_id = run_id) OR 1=1 --"`
      // renders a WHERE that is always true, with the fence constraining one OR
      // branch. So what is validated is what is rendered, at the moment it is
      // rendered.
      const predicate = eq("run_id", value("safe"));
      // The source's own mutation route is closed here: Object.freeze makes the
      // assignment throw rather than succeed silently.
      expect(() => {
        (predicate as unknown as Record<string, unknown>)["column"] = "x";
      }).toThrow(TypeError);
      const mutatedPredicate = mutatedClone(predicate, {
        column: "run_id = run_id) OR 1=1 --",
      });
      expectRefusal(
        () =>
          fencedUpdate("run", {
            set: { status: value("done") },
            where: mutatedPredicate,
            stampsWriterEpoch: false,
          }),
        LeaseUsageError,
      );

      const mutatedParam = mutatedClone(param("p"), {
        name: "p, writer_epoch = 1 WHERE 1=1 --",
      });
      expectRefusal(
        () =>
          fencedInsert("action", { values: { action_id: mutatedParam, writer_epoch: fenceEpoch } }),
        LeaseUsageError,
      );

      const mutatedValue = mutatedClone(value("safe"), { constant: {} });
      expectRefusal(
        () =>
          fencedUpdate("run", {
            set: { status: mutatedValue },
            where: eq("run_id", param("r")),
            stampsWriterEpoch: false,
          }),
        LeaseUsageError,
      );

      const smuggledNull = eq("resolved_at_ms", value(1));
      const nullSmuggled = mutatedClone(smuggledNull, {
        operand: mutatedClone(smuggledNull.operand as Value, { constant: null }),
      });
      expectRefusal(
        () =>
          fencedUpdate("run", {
            set: { status: value("done") },
            where: nullSmuggled,
            stampsWriterEpoch: false,
          }),
        LeaseUsageError,
      );
    });

    test("the builder reads the callers mapping exactly once", () => {
      // A mapping that answers validation and rendering differently.
      //
      // The Mapping is the caller's object: one that returned fenceEpoch to the
      // stamp check but value(0) to the rendering would put an unstamped epoch --
      // or an unvalidated name -- into the statement. The builder snapshots the
      // mapping before anything is checked, so whatever it says, it says once.
      let reads = 0;
      const twoFaced = new Proxy(
        {},
        {
          ownKeys: () => ["status", "writer_epoch"],
          getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
          get: (_target, key) => {
            if (key === "status") {
              return value("applied");
            }
            reads += 1;
            return reads === 1 ? fenceEpoch : value(0);
          },
        },
      ) as Record<string, unknown>;

      const statement = String(
        fencedUpdate("action", { set: twoFaced, where: eq("action_id", param("a")) }),
      );
      expect(statement).toContain("writer_epoch = :fence_epoch");
      expect(statement).not.toContain("writer_epoch = 0");
    });

    test("a null comparison is refused in favour of is null", () => {
      // `= NULL` matches no row in SQL; the write would be a silent no-op.
      for (const compose of [eq, ne]) {
        expectRefusal(() => compose("resolved_at_ms", value(null)), LeaseUsageError);
      }
      // ...while assigning NULL is meaningful and stays allowed.
      const statement = fencedUpdate("run", {
        set: { status: value(null) },
        where: eq("run_id", param("r")),
        stampsWriterEpoch: false,
      });
      expect(String(statement)).toContain("SET status = NULL");
    });

    test("a hostile constant is rendered as an inert literal", () => {
      // The typed answer to the old literal-hiding attacks, proven end to end.
      //
      // Under the retired fragment API, `"'(' = '(') OR 1 = 1 --"` was a
      // predicate that balanced character for character while closing the fence's
      // parentheses and commenting the rest away. Under the typed API the same
      // characters can only ever be a value() constant, and the builder renders it
      // by SQLite's own quoting rules -- so the statement executes, the fence
      // still gates it, and the string lands in the column verbatim, structure
      // and all.
      const cp = cpFixture(dbPathFixture());
      const hostile = "'(' = '(') OR 1 = 1 --";
      const enqueue = new ProtectedWrite({
        kind: EFFECT_KIND,
        idempotencyKey: "m-hostile",
        statement: fencedInsert("outbox", {
          values: {
            message_id: value("m-hostile"),
            run_id: value("r1"),
            recipient: value("a(b"),
            payload: value(hostile),
            dedup_key: value("d-hostile"),
            status: value("pending"),
            writer_epoch: fenceEpoch,
            enqueued_at_ms: param("now_ms"),
          },
        }),
        exactlyOnceMechanism: "transactional_with_record",
        params: { now_ms: T0 + 1 },
      });

      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      expect(protectedWrite(cp, lease, enqueue, { nowMs: T0 + 1 })).toBe(1);

      expect(
        cp
          .prepare("SELECT recipient, payload FROM outbox WHERE message_id = 'm-hostile'")
          .raw()
          .get(),
      ).toEqual(["a(b", hostile]);
    });

    test("a constant is rendered as its value and nothing else", () => {
      // The two shapes str/int typing alone would let through.
      //
      // An IntEnum member *is* an int, but `str()` of one may spell its *name*
      // (Python 3.10) -- and a name is not a number the statement can carry. A
      // TypeScript numeric enum member is a plain number and cannot carry an
      // alternate string form at all, so the same assertion holds here for a
      // structural reason rather than because the module canonicalises it. And a
      // NUL character in a str constant would truncate the SQL text on its way
      // into SQLite; refusing it at build time names the constant rather than the
      // whole statement.
      const statement = String(
        fencedUpdate("run", {
          set: { status: value(Status.DONE) },
          where: eq("run_id", param("r")),
          stampsWriterEpoch: false,
        }),
      );
      expect(statement).toContain("status = 7");
      expect(statement).not.toContain("DONE");

      expectRefusal(() => value("a\u0000b"), LeaseUsageError);
    });

    test("a name is a name and never a fragment", () => {
      // Identifiers are the one caller string left, so they admit no structure.
      for (const hostile of ["a b", "a--", "a'", "a)", "1a", ""]) {
        expectRefusal(() => param(hostile), LeaseUsageError);
        expectRefusal(() => eq(hostile, value(1)), LeaseUsageError);
        expectRefusal(() => ne(hostile, value(1)), LeaseUsageError);
        expectRefusal(() => isNull(hostile), LeaseUsageError);
      }
      // ...and the fence's own parameters cannot be named from outside at all:
      // the epoch stamp is the fenceEpoch sentinel, not a spelling.
      for (const reserved of FENCE_PARAMS) {
        expectRefusal(() => param(reserved), LeaseUsageError);
      }
    });

    test("the table is chosen from a closed set not composed", () => {
      // A table name carrying its own SQL can comment the fence away entirely.
      //
      // `action (x) SELECT 1 WHERE 1 /*` leaves SQLite reading an unterminated
      // block comment to end of input, so the builder's columns, values and fence
      // are never part of the statement at all. A name is not a fragment, so it is
      // picked from the closed set rather than validated as text.
      expect(new Set(PROTECTED_TABLES)).toEqual(
        new Set(["run", "session", "lease", "outbox", "incident", "action"]),
      );
      expectRefusal(
        () =>
          fencedInsert("action (action_id) SELECT 'x' WHERE 1 /*", {
            values: { action_id: param("a"), writer_epoch: fenceEpoch },
          }),
        UnfencedStatement,
      );
      expectRefusal(
        () =>
          fencedUpdate("sqlite_master", {
            set: { writer_epoch: fenceEpoch },
            where: eq("rootpage", value(1)),
          }),
        UnfencedStatement,
      );
    });

    test("a protected write cannot rewrite an applied rows attribution", () => {
      // Finished evidence is added to, never replaced.
      //
      // Two rules, and both are the builder's rather than the caller's memory: the
      // columns a row is attributed by cannot be assigned at all, and an update to
      // `action` carries `applied_at_ms IS NULL` so it cannot land on a row that is
      // already in the history and restamp its epoch under a later lease.
      const cp = cpFixture(dbPathFixture());
      for (const column of ["kind", "idempotency_key", "action_id"]) {
        expectRefusal(
          () =>
            fencedUpdate("action", {
              set: { [column]: param("x"), writer_epoch: fenceEpoch },
              where: eq("action_id", param("a")),
            }),
          UnfencedStatement,
        );
      }

      const alpha = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      protectedWrite(cp, alpha, effect("a1", { nowMs: T0 + 1 }), { nowMs: T0 + 1 });
      const beta = acquire(cp, {
        resource: RESOURCE,
        holder: "beta",
        nowMs: T0 + TTL + 1,
        ttlMs: TTL,
      });

      const restamp = new ProtectedWrite({
        kind: EFFECT_KIND,
        idempotencyKey: "a1",
        statement: fencedUpdate("action", {
          set: { writer_epoch: fenceEpoch },
          where: eq("action_id", param("action_id")),
        }),
        exactlyOnceMechanism: "transactional_with_record",
        params: { action_id: "a1" },
      });
      // beta holds a perfectly live token -- and still cannot touch alpha's row.
      expectRefusal(
        () => protectedWrite(cp, beta, restamp, { nowMs: T0 + TTL + 2 }),
        ProtectedWriteMissed,
      );

      const history = writeHistory(cp, { resource: RESOURCE });
      expect(history).toHaveLength(1);
      expect((history[0] as Record<string, unknown>)["writer_epoch"]).toBe(alpha.epoch);
    });

    test("a caller cannot rebind the fences own parameters", () => {
      expectRefusal(
        () =>
          new ProtectedWrite({
            kind: EFFECT_KIND,
            idempotencyKey: "k",
            statement: APPLY_EFFECT,
            exactlyOnceMechanism: "transactional_with_record",
            params: { fence_epoch: 99, fence_now_ms: 0 },
          }),
        LeaseUsageError,
      );
    });

    test("a handler that names no exactly once mechanism is refused", () => {
      const refused = expectRefusal(
        () =>
          new ProtectedWrite({
            kind: EFFECT_KIND,
            idempotencyKey: "k",
            statement: APPLY_EFFECT,
            exactlyOnceMechanism: "probably_fine",
          }),
        LeaseUsageError,
      );
      expect(refused.message).toContain("human gate");
    });

    test("a write that misses its own where is not recorded as a stale writer", () => {
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      protectedWrite(cp, lease, effect("a1", { nowMs: T0 + 1 }), { nowMs: T0 + 1 });

      const missing = new ProtectedWrite({
        kind: EFFECT_KIND,
        idempotencyKey: "a1",
        statement: fencedUpdate("action", {
          set: { status: value("applied"), writer_epoch: fenceEpoch },
          where: and_(eq("action_id", param("action_id")), eq("status", value("pending"))),
        }),
        exactlyOnceMechanism: "transactional_with_record",
        params: { action_id: "no-such-row" },
      });
      expectRefusal(
        () => protectedWrite(cp, lease, missing, { nowMs: T0 + 2 }),
        ProtectedWriteMissed,
      );

      // One row, and it is the applied one. A refusal written here would be a
      // rejection that never happened, in the evidence gate item 5 is read from.
      expect(actionRows(cp).map((row) => row["status"])).toEqual(["applied"]);
    });

    test("a lease operation refuses to run inside somebody elses transaction", () => {
      const cp = cpFixture(dbPathFixture());
      cp.exec("BEGIN");
      cp.prepare("UPDATE run SET status = 'paused' WHERE run_id = 'r1'").run();
      try {
        const refused = expectRefusal(
          () => acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL }),
          LeaseUsageError,
        );
        expect(refused.message).toContain("transaction");
      } finally {
        cp.exec("ROLLBACK");
      }
    });

    test("the refusal and the refused attempt commit together", () => {
      // The refusal is durable before the caller is told about it.
      const dbPath = dbPathFixture();
      const cp = cpFixture(dbPath);
      const stale = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      acquire(cp, { resource: RESOURCE, holder: "beta", nowMs: T0 + TTL + 1, ttlMs: TTL });
      expectRefusal(
        () =>
          protectedWrite(cp, stale, effect("a1", { nowMs: T0 + TTL + 2 }), {
            nowMs: T0 + TTL + 2,
            attemptId: "refusal-1",
          }),
        StaleWriterRefused,
      );
      // committed, not left open for someone to roll back
      expect(cp.inTransaction).toBe(false);

      const witness = reopen(dbPath);
      expect(
        witness.prepare("SELECT status FROM action WHERE action_id = 'refusal-1'").raw().get(),
      ).toEqual(["refused"]);
      witness.close();
    });
  },
);

// ==========================================================================
// Criterion 3 -- at most one live holder per leased resource at any instant,
// shown over a timeline of lease rows rather than at sampled points.
// ==========================================================================

describe(
  "Criterion 3 -- at most one live holder per leased resource at any instant, shown over a " +
    "timeline of lease rows rather than at sampled points.",
  () => {
    test("a second claimant is refused while the lease is live", () => {
      const cp = cpFixture(dbPathFixture());
      const first = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

      for (const offset of [0, 1, TTL - 1]) {
        expectRefusal(
          () => acquire(cp, { resource: RESOURCE, holder: "beta", nowMs: T0 + offset, ttlMs: TTL }),
          LeaseHeld,
        );
      }

      // The refused claimant changed nothing: not the holder, not the epoch, not
      // the expiry it would have extended.
      expect(readLease(cp, RESOURCE)).toStrictEqual(first);
    });

    test("re acquiring after expiry raises the epoch even for the same holder", () => {
      const cp = cpFixture(dbPathFixture());
      const first = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      const again = acquire(cp, {
        resource: RESOURCE,
        holder: "alpha",
        nowMs: T0 + TTL + 1,
        ttlMs: TTL,
      });

      expect(again.epoch).toBe(first.epoch + 1);
      // The old token dies with the old epoch. If re-acquiring preserved it, the
      // writes the holder had in flight under the old one would validate again.
      expectRefusal(
        () =>
          protectedWrite(cp, first, effect("a1", { nowMs: T0 + TTL + 2 }), { nowMs: T0 + TTL + 2 }),
        StaleWriterRefused,
      );
      expect(
        protectedWrite(cp, again, effect("a2", { nowMs: T0 + TTL + 3 }), { nowMs: T0 + TTL + 3 }),
      ).toBe(1);
    });

    test("the timeline of lease rows has one authority per instant", () => {
      const cp = cpFixture(dbPathFixture());
      const observations: Lease[] = [];
      const holders = ["alpha", "beta", "gamma", "alpha"];
      let now = T0;
      for (const holder of holders) {
        const lease = acquire(cp, { resource: RESOURCE, holder, nowMs: now, ttlMs: TTL });
        observations.push(lease);
        observations.push(renew(cp, lease, { nowMs: now + 1, ttlMs: TTL }));
        now += TTL + 1;
      }

      const timeline = authorityTimeline(observations);

      expect(timeline.map((authority) => authority.epoch)).toEqual([1, 2, 3, 4]);
      expect(timeline.map((authority) => authority.holder)).toEqual(holders);
      // Half-open and contiguous: an epoch's authority ends exactly where its
      // successor's begins, so no instant is covered twice and none is unowned
      // between them. This is checked over the whole timeline, not sampled.
      for (let index = 0; index + 1 < timeline.length; index += 1) {
        expect(timeline[index]?.untilMs).toBe(timeline[index + 1]?.fromMs);
      }
      expect(epochRegressions(timeline)).toEqual([]);
      // And the wall-clock windows the rows themselves claim are disjoint too:
      // a takeover is stamped at or after the previous expiry, so no recorded
      // instant has two holders. Checked over every pair, not at sample points.
      expect(overlappingClaims(claimedTimeline(observations))).toEqual([]);
      // A renewal restates an epoch rather than opening one; four acquisitions and
      // four renewals are four authorities.
      expect(timeline).toHaveLength(4);
    });

    test("the write history shows no interleaving from the rejected writer", () => {
      // The durable half: read back out of SQLite alone, after the fact (D-0001).
      const cp = cpFixture(dbPathFixture());
      const alpha = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      protectedWrite(cp, alpha, effect("a1", { nowMs: T0 + 1 }), { nowMs: T0 + 1 });
      const beta = acquire(cp, {
        resource: RESOURCE,
        holder: "beta",
        nowMs: T0 + TTL + 1,
        ttlMs: TTL,
      });
      protectedWrite(cp, beta, effect("b1", { nowMs: T0 + TTL + 2 }), { nowMs: T0 + TTL + 2 });
      expectRefusal(
        // alpha comes back
        () =>
          protectedWrite(cp, alpha, effect("a2", { nowMs: T0 + TTL + 3 }), { nowMs: T0 + TTL + 3 }),
        StaleWriterRefused,
      );
      protectedWrite(cp, beta, effect("b2", { nowMs: T0 + TTL + 4 }), { nowMs: T0 + TTL + 4 });

      const history = writeHistory(cp, { resource: RESOURCE });

      expect(history.map((row) => row["status"])).toEqual([
        "applied",
        "applied",
        "refused",
        "applied",
      ]);
      // The applied rows are a linear sequence in epoch order with nothing from
      // the rejected writer between them; the refused row is present as the record
      // that it was kept out.
      expect(appliedEpochRegressions(history)).toEqual([]);
      expect(
        history.filter((row) => row["status"] === "applied").map((row) => row["writer_epoch"]),
      ).toEqual([1, 2, 2]);
      expect(
        history.filter((row) => row["status"] === "refused").map((row) => row["writer_epoch"]),
      ).toEqual([1]);
    });

    test("two resources epochs are not compared with each other", () => {
      // Epochs belong to a resource, and the spike rows cannot say which.
      //
      // `action` has no resource column (`Q-0001`), so a history that mixes kinds
      // is several independent sequences shuffled together: a valid epoch 2 for
      // one resource followed by a valid epoch 1 for another would read as a
      // violation, and a real interleaving would hide in the same noise. The check
      // refuses rather than answering a question the rows cannot support, and
      // effectKind() is how a kind carries its resource.
      const cp = cpFixture(dbPathFixture());
      const first = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      acquire(cp, { resource: RESOURCE, holder: "beta", nowMs: T0 + TTL + 1, ttlMs: TTL });
      const promoted = acquire(cp, {
        resource: RESOURCE,
        holder: "gamma",
        nowMs: T0 + 2 * TTL + 2,
        ttlMs: TTL,
      });
      const other = acquire(cp, {
        resource: "run/r2",
        holder: "alpha",
        nowMs: T0 + 2 * TTL + 2,
        ttlMs: TTL,
      });
      const otherKind = effectKind("run/r2", "deliver_task");

      protectedWrite(cp, promoted, effect("a1", { nowMs: T0 + 2 * TTL + 3 }), {
        nowMs: T0 + 2 * TTL + 3,
      });
      protectedWrite(cp, other, effect("b1", { nowMs: T0 + 2 * TTL + 4, kind: otherKind }), {
        nowMs: T0 + 2 * TTL + 4,
      });

      // epoch 3 then epoch 1
      expect(first.epoch).toBeLessThan(promoted.epoch);
      expect(other.epoch).toBe(1);
      const refused = expectRefusal(
        () => appliedEpochRegressions(writeHistory(cp)),
        LeaseUsageError,
      );
      expect(refused.message).toContain("one leased resource at a time");

      // Scoped to one resource, each history is a clean sequence of its own.
      expect(appliedEpochRegressions(writeHistory(cp, { resource: RESOURCE }))).toEqual([]);
      expect(appliedEpochRegressions(writeHistory(cp, { resource: "run/r2" }))).toEqual([]);
      expect(resourceOfKind(otherKind)).toBe("run/r2");
    });

    test("every effect under one lease stays in one history", () => {
      // Two effect kinds, one lease: they share an epoch sequence and a history.
      //
      // Filtering by exact kind would split them, and a writer whose stale epoch
      // landed under a *different* effect than the one before it would fall
      // through the gap between the two halves.
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      const otherEffect = effectKind(RESOURCE, "update_status");
      protectedWrite(cp, lease, effect("a1", { nowMs: T0 + 1 }), { nowMs: T0 + 1 });
      protectedWrite(cp, lease, effect("a2", { nowMs: T0 + 2, kind: otherEffect }), {
        nowMs: T0 + 2,
      });

      const history = writeHistory(cp, { resource: RESOURCE });

      expect(history.map((row) => row["kind"])).toEqual([EFFECT_KIND, otherEffect]);
      expect(appliedEpochRegressions(history)).toEqual([]);
      // Narrowing to one effect is still available; it is just not the scope the
      // single-writer property is about.
      expect(writeHistory(cp, { resource: RESOURCE, kind: EFFECT_KIND })).toHaveLength(1);
    });

    test("the history is ordered by the database not by the callers clock", () => {
      // Under skew a later write can carry an earlier timestamp.
      //
      // Ordering the evidence by `created_at_ms` would then invent a regression
      // that never happened, so the query orders by the rows' own insertion order
      // and exposes it as `write_seq`.
      const cp = cpFixture(dbPathFixture());
      const alpha = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      protectedWrite(cp, alpha, effect("a1", { nowMs: T0 + 10_000 }), { nowMs: T0 + 1 });
      const beta = acquire(cp, {
        resource: RESOURCE,
        holder: "beta",
        nowMs: T0 + TTL + 1,
        ttlMs: TTL,
      });
      // beta's clock lags alpha's: its write is later, and stamped earlier.
      protectedWrite(cp, beta, effect("b1", { nowMs: T0 + 1 }), { nowMs: T0 + TTL + 2 });

      const history = writeHistory(cp, { resource: RESOURCE });

      expect(history.map((row) => row["action_id"])).toEqual(["a1", "b1"]);
      const seqs = history.map((row) => row["write_seq"] as number);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect((history[1] as Record<string, unknown>)["created_at_ms"] as number).toBeLessThan(
        (history[0] as Record<string, unknown>)["created_at_ms"] as number,
      );
      expect(appliedEpochRegressions(history)).toEqual([]);
    });

    test("a protected write to another table is stamped on its own row", () => {
      // The scope of `writeHistory()`, pinned rather than left implied.
      //
      // It reads `action`, which is the exactly-once effect record. A fenced write
      // to `outbox` carries its epoch on the outbox row, where the same shape of
      // query reads it; nothing synthesises an action row for it, because
      // manufacturing an effect record for a write that is not an effect would
      // corrupt the evidence gate item 4 is read out of.
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      const enqueue = new ProtectedWrite({
        kind: EFFECT_KIND,
        idempotencyKey: "m1",
        statement: fencedInsert("outbox", {
          values: {
            message_id: value("m1"),
            run_id: value("r1"),
            recipient: value("secretary"),
            payload: value("{}"),
            dedup_key: value("d1"),
            status: value("pending"),
            writer_epoch: fenceEpoch,
            enqueued_at_ms: param("now_ms"),
          },
        }),
        exactlyOnceMechanism: "transactional_with_record",
        params: { now_ms: T0 + 1 },
      });

      expect(protectedWrite(cp, lease, enqueue, { nowMs: T0 + 1 })).toBe(1);

      expect(
        cp.prepare("SELECT writer_epoch FROM outbox WHERE message_id = 'm1'").raw().get(),
      ).toEqual([lease.epoch]);
      expect(writeHistory(cp, { resource: RESOURCE })).toEqual([]);
      // Refusals are the exception: a refused write has no row of its own to be
      // stamped on, so it is recorded in `action` whatever table it was aimed at.
      acquire(cp, { resource: RESOURCE, holder: "beta", nowMs: T0 + TTL + 1, ttlMs: TTL });
      expectRefusal(
        () => protectedWrite(cp, lease, enqueue, { nowMs: T0 + TTL + 2 }),
        StaleWriterRefused,
      );
      expect(writeHistory(cp, { resource: RESOURCE }).map((row) => row["status"])).toEqual([
        "refused",
      ]);
    });

    test("write history is answerable by query after the process is gone", () => {
      const dbPath = dbPathFixture();
      const cp = cpFixture(dbPath);
      const alpha = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      protectedWrite(cp, alpha, effect("a1", { nowMs: T0 + 1 }), { nowMs: T0 + 1 });
      cp.close();

      const reopened = reopen(dbPath);
      const history = writeHistory(reopened, { resource: RESOURCE });
      expect(history.map((row) => row["writer_epoch"])).toEqual([1]);
      // The lease row itself is durable too, epoch included -- the recovering
      // process is not told which epoch was live, it reads it.
      expect(readLease(reopened, RESOURCE)?.epoch).toBe(1);
    });

    test("a released lease is expired and never deleted", () => {
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      const released = release(cp, lease, { nowMs: T0 + 10 });

      expect(released.expiresAtMs).toBe(T0 + 10);
      expect(released.looksLiveAt(T0 + 10)).toBe(false);
      // The row survives, carrying its epoch. A deleted row would let the next
      // acquisition restart at epoch 1 and hand a returning stale holder a token
      // that validates.
      expectSqliteError(
        () => cp.prepare<[string]>("DELETE FROM lease WHERE resource = ?").run(RESOURCE),
        { code: CONSTRAINT },
      );
      // The source rolls back here: Python's sqlite3 leaves its implicit
      // transaction open after the refused DELETE. better-sqlite3 opens none, so
      // there is nothing to roll back.
      expect(cp.inTransaction).toBe(false);
      expect(
        acquire(cp, { resource: RESOURCE, holder: "beta", nowMs: T0 + 11, ttlMs: TTL }).epoch,
      ).toBe(2);
      // And the released holder's token is dead the moment it is released.
      expectRefusal(
        () => protectedWrite(cp, lease, effect("a1", { nowMs: T0 + 12 }), { nowMs: T0 + 12 }),
        StaleWriterRefused,
      );
    });

    test("a superseded holder can neither renew nor release", () => {
      const cp = cpFixture(dbPathFixture());
      const alpha = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      const beta = acquire(cp, {
        resource: RESOURCE,
        holder: "beta",
        nowMs: T0 + TTL + 1,
        ttlMs: TTL,
      });

      expectRefusal(() => renew(cp, alpha, { nowMs: T0 + TTL + 2, ttlMs: TTL }), LeaseNotHeld);
      expectRefusal(() => release(cp, alpha, { nowMs: T0 + TTL + 2 }), LeaseNotHeld);

      // Neither refusal touched the live lease -- a release by a former holder
      // that expired the current one would hand the resource to a third claimant.
      expect(readLease(cp, RESOURCE)).toStrictEqual(beta);
    });

    test("an expired lease cannot be renewed back to life", () => {
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

      expectRefusal(() => renew(cp, lease, { nowMs: T0 + TTL + 1, ttlMs: TTL }), LeaseNotHeld);

      // Re-acquiring is the way back, and re-acquiring raises the epoch -- so a
      // holder that was away cannot return under the token it left with.
      expect(
        acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0 + TTL + 2, ttlMs: TTL }).epoch,
      ).toBe(2);
    });

    test("a renewal keeps the epoch and the token keeps working", () => {
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      const renewed = renew(cp, lease, { nowMs: T0 + TTL - 1, ttlMs: TTL });

      expect(renewed.epoch).toBe(lease.epoch);
      expect(renewed.expiresAtMs).toBe(T0 + 2 * TTL - 1);
      // The token the holder is already writing under stays valid across its own
      // renewal; bumping the epoch here would invalidate its own writes in flight.
      expect(
        protectedWrite(cp, lease, effect("a1", { nowMs: T0 + TTL }), { nowMs: T0 + TTL }),
      ).toBe(1);
    });
  },
);

// ==========================================================================
// Criterion 4 -- clock skew forward and backward across the expiry boundary is
// handled and tested.
// ==========================================================================

describe(
  "Criterion 4 -- clock skew forward and backward across the expiry boundary is handled and " +
    "tested.",
  () => {
    test("a fast clock takes the lease over and the fence still excludes", () => {
      // The case where the wall clock genuinely does *not* provide exclusion.
      //
      // Alpha holds until `T0 + TTL` by its own clock. Beta's clock runs an hour
      // fast, so it sees the lease as long expired and takes it over at an instant
      // alpha still believes it holds. In *true* time the two holders overlap; the
      // exclusion holds anyway, because it was never the clock's.
      const cp = cpFixture(dbPathFixture());
      const skew = 3_600_000;
      const alpha = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      const beta = acquire(cp, {
        resource: RESOURCE,
        holder: "beta",
        nowMs: T0 + skew,
        ttlMs: TTL,
      });

      // Alpha, on its own unskewed clock, still believes it holds the lease...
      expect(alpha.looksLiveAt(T0 + 1)).toBe(true);
      // ...and its write is refused all the same, by the epoch and not by the time.
      const refused = expectRefusal(
        () => protectedWrite(cp, alpha, effect("a1", { nowMs: T0 + 1 }), { nowMs: T0 + 1 }),
        StaleWriterRefused,
      );
      expect(refused.observed).toStrictEqual(beta);

      // The rows themselves cannot show the overlap, and that is the point worth
      // writing down: beta stamped its acquisition in its own skewed frame, so the
      // recorded windows are disjoint while the true ones are not. A timeline of
      // lease rows is only as truthful as the clocks that wrote it -- which is
      // exactly why a protected write validates the epoch and not the expiry.
      expect(overlappingClaims(claimedTimeline([alpha, beta]))).toEqual([]);
      const trueTime = [
        new Lease(RESOURCE, "alpha", 1, T0, T0 + TTL),
        // the same events, one clock
        new Lease(RESOURCE, "beta", 2, T0 + 10, T0 + 10 + TTL),
      ];
      const overlaps = overlappingClaims(claimedTimeline(trueTime));
      const holders = new Set<string>();
      for (const pair of overlaps) {
        for (const claim of pair as readonly Claim[]) {
          holders.add(claim.holder);
        }
      }
      expect(holders).toEqual(new Set(["alpha", "beta"]));

      // Authority is ordered by epoch, so it does not overlap in either frame.
      const timeline = authorityTimeline([alpha, beta]);
      expect(timeline.map((authority) => authority.epoch)).toEqual([1, 2]);
      expect(epochRegressions(timeline)).toEqual([]);
    });

    test("a clock that jumps back does not resurrect a superseded token", () => {
      // Backward skew across the boundary, from the loser's side.
      const cp = cpFixture(dbPathFixture());
      const alpha = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      acquire(cp, { resource: RESOURCE, holder: "beta", nowMs: T0 + TTL + 1, ttlMs: TTL });

      // Alpha's clock jumps back to before its own expiry, so by every check it
      // could make locally, its lease is live again.
      expect(alpha.looksLiveAt(T0 - TTL)).toBe(true);
      expectRefusal(
        () => protectedWrite(cp, alpha, effect("a1", { nowMs: T0 - TTL }), { nowMs: T0 - TTL }),
        StaleWriterRefused,
      );
      const rows = actionRows(cp);
      expect(rows).toHaveLength(1);
      expect((rows[0] as Record<string, unknown>)["status"]).toBe("refused");
    });

    test("a slow clock declines to take a lease it sees as live", () => {
      // Backward skew from the claimant's side: the safe direction.
      //
      // Acquisition requires the existing lease to have expired at the
      // *claimant's* clock, so a slow clock sees a lease as more live than it is
      // and refuses to take it over. It stalls; it does not admit a second writer.
      const cp = cpFixture(dbPathFixture());
      acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

      expectRefusal(
        () =>
          acquire(cp, {
            resource: RESOURCE,
            holder: "beta",
            nowMs: T0 - 3_600_000,
            ttlMs: TTL,
          }),
        LeaseHeld,
      );

      expect(readLease(cp, RESOURCE)?.holder).toBe("alpha");
    });

    test("a backward skewed renewal shortens rather than extends", () => {
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

      const renewed = renew(cp, lease, { nowMs: T0 + 1, ttlMs: Math.floor(TTL / 3) });

      expect(renewed.expiresAtMs).toBeLessThan(lease.expiresAtMs);
      // Ending its own authority earlier is safe; the resource becomes takeable
      // sooner, and the takeover raises the epoch as always.
      expect(
        acquire(cp, {
          resource: RESOURCE,
          holder: "beta",
          nowMs: renewed.expiresAtMs,
          ttlMs: TTL,
        }).epoch,
      ).toBe(2);
    });

    test("a renewal skewed behind its own acquisition is refused not crashed", () => {
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

      expectRefusal(() => renew(cp, lease, { nowMs: T0 - 10_000, ttlMs: 1_000 }), ClockSkewRefused);

      // The lease is untouched -- in particular it was not left half-written by a
      // CHECK violation surfacing from inside what the caller thought was a renewal.
      expect(readLease(cp, RESOURCE)).toStrictEqual(lease);
    });

    test("releasing with a clock behind the acquisition stays legal", () => {
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

      const released = release(cp, lease, { nowMs: T0 - 10_000 });

      // The row's own CHECK requires expires_at_ms > acquired_at_ms, so the
      // release clamps to acquired_at_ms + 1 rather than failing. The window it
      // leaves is one millisecond wide and errs towards withholding the resource.
      expect(released.expiresAtMs).toBe(T0 + 1);
      expect(released.looksLiveAt(T0 + 1)).toBe(false);
    });

    test("releasing late never pushes an expiry forward", () => {
      // Giving a lease up may not be the thing that extends it.
      //
      // The lease expired at `T0 + TTL` and nobody took it. Releasing it an hour
      // later must not move the expiry to the hour mark: that would make the
      // releasing holder's own token read live again over the interval it had
      // already lost, and would withhold the resource from a claimant whose clock
      // falls inside it.
      const cp = cpFixture(dbPathFixture());
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

      const released = release(cp, lease, { nowMs: T0 + 3_600_000 });

      expect(released.expiresAtMs).toBe(lease.expiresAtMs);
      // The token stayed dead throughout the interval a forward-moved expiry would
      // have revived it over.
      for (const now of [T0 + TTL + 1, T0 + TTL + 1000, T0 + 3_600_000 - 1]) {
        expectRefusal(
          () => protectedWrite(cp, lease, effect(`a-${now}`, { nowMs: now }), { nowMs: now }),
          StaleWriterRefused,
        );
      }
      // And the resource was takeable at every one of those instants.
      expect(
        acquire(cp, { resource: RESOURCE, holder: "beta", nowMs: T0 + TTL + 1, ttlMs: TTL }).epoch,
      ).toBe(2);
    });

    test("the database never supplies a clock of its own", () => {
      // Every timestamp is the caller's -- there is no DEFAULT to inherit.
      const cp = cpFixture(dbPathFixture());
      const columns = cp.pragma("table_info(lease)") as {
        name: string;
        dflt_value: unknown;
      }[];
      const defaults = new Map(columns.map((column) => [column.name, column.dflt_value]));
      expect(defaults.get("acquired_at_ms")).toBeNull();
      expect(defaults.get("expires_at_ms")).toBeNull();
      // And the module never reaches for one either: no wall-clock call anywhere.
      // The forbidden spellings are this runtime's, not Python's: a scan for
      // `time.time` in TypeScript can never match, and an assertion that cannot
      // fail is not an assertion.
      const source = readFileSync(MODULE_SOURCE_PATH, "utf8");
      expect(source.length).toBeGreaterThan(0);
      // Anti-vacuity: the scan reads the module it claims to.
      expect(source).toContain("export function acquire(");
      for (const forbidden of ["Date.now", "new Date", "CURRENT_TIMESTAMP", "strftime('now'"]) {
        expect(source).not.toContain(forbidden);
      }
    });
  },
);

// ==========================================================================
// Criterion 5 -- where an external destination can enforce a stale token, it
// does; where it cannot, that is written down rather than assumed away.
// ==========================================================================

describe(
  "Criterion 5 -- where an external destination can enforce a stale token, it does; where it " +
    "cannot, that is written down rather than assumed away.",
  () => {
    test("an enforcing destination rejects the stale token from its own record", () => {
      // Proven against the destination's record, not ours (`ACCEPTANCE.md` section 2).
      const cp = cpFixture(dbPathFixture());
      const destination = new EpochGuardedDestination();
      const alpha = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
      expect(
        destination.apply({
          resource: RESOURCE,
          holder: "alpha",
          epoch: alpha.epoch,
          effectKey: "e1",
          payload: "first",
        }),
      ).toBe(true);
      const beta = acquire(cp, {
        resource: RESOURCE,
        holder: "beta",
        nowMs: T0 + TTL + 1,
        ttlMs: TTL,
      });
      destination.apply({
        resource: RESOURCE,
        holder: "beta",
        epoch: beta.epoch,
        effectKey: "e2",
        payload: "second",
      });

      expectRefusal(
        () =>
          destination.apply({
            resource: RESOURCE,
            holder: "alpha",
            epoch: alpha.epoch,
            effectKey: "e3",
            payload: "stale",
          }),
        DestinationRejectedStaleToken,
      );

      expect(destination.highestEpoch(RESOURCE)).toBe(beta.epoch);
      expect(destination.rejected).toEqual([[RESOURCE, "alpha", alpha.epoch]]);
      expect(destination.effectCount("e3")).toBe(0);
    });

    test("an enforcing destination absorbs a duplicate under a live token", () => {
      // Fencing and idempotency are separate properties, and both are its own.
      const cp = cpFixture(dbPathFixture());
      const destination = new EpochGuardedDestination();
      const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

      expect(
        destination.apply({
          resource: RESOURCE,
          holder: "alpha",
          epoch: lease.epoch,
          effectKey: "e1",
          payload: "x",
        }),
      ).toBe(true);
      expect(
        destination.apply({
          resource: RESOURCE,
          holder: "alpha",
          epoch: lease.epoch,
          effectKey: "e1",
          payload: "x",
        }),
      ).toBe(false);
      expect(destination.effectCount("e1")).toBe(1);
    });

    test("a destination that cannot enforce must record its residual", () => {
      const refused = expectRefusal(
        () =>
          new DestinationFencing({
            name: "silent",
            enforcesStaleToken: false,
            note: "cannot",
            residual: null,
          }),
        LeaseUsageError,
      );
      expect(refused.message).toContain("written down rather than assumed away");

      expectRefusal(
        () =>
          new DestinationFencing({
            name: "enforcing",
            enforcesStaleToken: true,
            note: "does",
            residual: "but also",
          }),
        LeaseUsageError,
      );
    });

    test("every registered destination is written down in the doc", () => {
      // The register and `docs/lease-fencing.md` say the same thing.
      //
      // A residual that drifts out of the code is a residual nobody is holding any
      // more, and a register entry with no written-down counterpart is the
      // assumed-away gap section 2 rules out. Neither can happen silently while
      // this passes.
      const text = readFileSync(DOC, "utf8");
      const rows = new Map<string, string>();
      for (const match of text.matchAll(/^\|\s*`([a-z_]+)`\s*\|\s*(yes|no)\s*\|/gm)) {
        rows.set(match[1] as string, (match[2] as string).trim());
      }

      expect(rows.size, "the destination register table is missing from the doc").toBeGreaterThan(
        0,
      );
      expect(new Set(rows.keys())).toEqual(new Set(Object.keys(DESTINATIONS)));
      for (const [name, destination] of Object.entries(DESTINATIONS)) {
        expect(rows.get(name)).toBe(destination.enforcesStaleToken ? "yes" : "no");
        if (!destination.enforcesStaleToken) {
          expect(destination.residual).toBeTruthy();
          expect((destination.residual as string).trim()).not.toBe("");
        }
      }
    });

    test("the provider is registered as unable to enforce", () => {
      // The one entry the fence search makes non-negotiable.
      //
      // U27 measured an admission window in which two writers both exited 0 and
      // both wrote; U32 found no exclusion at all on the `--resume` path. A
      // register that let the provider count as enforcing would put back exactly
      // the assumption `investigation/pre-spawn-fence-search.md` section 5.3 removed.
      const provider = DESTINATIONS["session_provider_child_process"] as DestinationFencing;
      expect(provider.enforcesStaleToken).toBe(false);
      expect(provider.note).toContain("U27");
      expect(provider.note).toContain("U32");
      const residual = provider.residual as string;
      expect(residual.includes("human gate") || residual.includes("D-0004")).toBe(true);
    });
  },
);

// ==========================================================================
// Criterion 6 -- no test may lean on the provider refusing a duplicate. Every
// case above must pass with the provider's refusal assumed absent.
// ==========================================================================

/**
 * The module specifiers a source file imports.
 *
 * The source parses the file with `ast` and collects `import` / `from ... import`
 * module names. TypeScript's parse tree is not available at runtime, so this
 * scans the source text for the two import forms ESM has, exactly as
 * `migrator.test.ts` scans for `export` declarations.
 */
function importedModules(path: string): Set<string> {
  const source = readFileSync(path, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
    names.add(match[1] as string);
  }
  for (const match of source.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
    names.add(match[1] as string);
  }
  return names;
}

describe(
  "Criterion 6 -- no test may lean on the provider refusing a duplicate. Every case above must " +
    "pass with the provider's refusal assumed absent.",
  () => {
    test("no dependency edge on the session provider", () => {
      // Asserted structurally, so it fails the build rather than a review.
      //
      // Neither the implementation nor this suite may reach a provider. There is
      // consequently no case here whose outcome could depend on a provider
      // refusing a duplicate -- the property is proven by there being no such call
      // to make, not by each test declaring that it did not rely on one.
      for (const modulePath of [MODULE_SOURCE_PATH, fileURLToPath(import.meta.url)]) {
        const imported = importedModules(modulePath);
        // Anti-vacuity: a scan that found no imports at all would make every
        // assertion below pass while proving nothing.
        expect(imported.size, modulePath).toBeGreaterThan(0);
        for (const specifier of imported) {
          // Python splits a dotted module name on "."; the ESM analogue is the
          // path segment, with the file extension dropped.
          const segments = specifier.split("/").map((segment) => segment.replace(/\.[^.]+$/, ""));
          expect(segments, `${modulePath} imports ${specifier}`).not.toContain("session");
          expect(segments, `${modulePath} imports ${specifier}`).not.toContain("provider");
        }
      }
    });

    // `the package does not silently shadow a clashing name` is NOT ported here.
    //
    // The source case asserts across BOTH modules that define the colliding
    // names: it reads `control_plane.__all__` (the port's `src/index.ts`, per
    // D-0002) and interlock's S7 `outbox` module, and four of its seven
    // assertions are about `outbox` -- that it re-exports `StaleWriterRefused`,
    // that the re-export is the same class object, and that its
    // `EXACTLY_ONCE_MECHANISMS` has not drifted from this module's copy.
    //
    // `src/control_plane/outbox.ts` is not ported yet, so those four cannot run
    // at all. Translating the remaining three and calling the case covered
    // would be strictly weaker than the source -- and worse, the surviving
    // `expect(pkg.Destination).not.toBe(DestinationFencing)` would pass
    // VACUOUSLY against an undefined left-hand side. It is recorded as
    // `not-ported` in the parity ledger, naming outbox.ts as what unblocks it,
    // and is translated in full in the belt that ports outbox.
    //
    // Note for that belt: import the entry point BEFORE the outbox module, or a
    // missing outbox masks whether the entry-point half passes at all.

    test("no dataclass default is one a supported python would reject", () => {
      // The rule Python 3.11 applies, checked on whatever version is running.
      //
      // 3.11's dataclasses refuse any default whose type is unhashable -- a
      // `MappingProxyType({})` among them -- while 3.10 and 3.12 accept it, so a
      // module that imports fine here can fail to import at all on one row of the
      // support matrix.
      //
      // TypeScript has neither dataclasses nor shared field defaults: a `??` or
      // `= {}` fallback is evaluated per call, so the *shared mutable default*
      // hazard the source's rule exists for can only live in a module-level value
      // that a default hands out. So the runtime half is kept and pointed at that:
      // every object this module exposes is frozen, which makes a mutation through
      // one holder throw rather than reach every other holder -- and the one field
      // whose source counterpart is a `MappingProxyType` default (`ProtectedWrite.params`)
      // is frozen on a default-constructed instance too.
      // Half one: the shared containers. Every exported array or plain-object
      // constant is a value several holders see, which is where a mutable shared
      // default can hide here; frozen means a mutation through one of them throws
      // rather than reaching all the others. `leaseSeams` is excluded by name --
      // a seam record that could not be replaced would not be a seam (D-0014).
      const shared = Object.entries(s6 as unknown as Record<string, unknown>).filter(
        ([name, exported]) =>
          name !== "leaseSeams" &&
          (Array.isArray(exported) ||
            (typeof exported === "object" &&
              exported !== null &&
              Object.getPrototypeOf(exported) === Object.prototype)),
      );
      // Anti-vacuity: a namespace with no shared container would pass every check
      // below while scanning nothing.
      expect(shared.length).toBeGreaterThan(0);
      for (const [name, exported] of shared) {
        expect(Object.isFrozen(exported), name).toBe(true);
      }

      // Half two: the one field whose source counterpart carries the
      // `MappingProxyType({})` default the docstring names. Two default-built
      // instances must not share it, and it must refuse mutation.
      const build = (): ProtectedWrite =>
        new ProtectedWrite({
          kind: EFFECT_KIND,
          idempotencyKey: "k",
          statement: APPLY_EFFECT,
          exactlyOnceMechanism: "transactional_with_record",
        });
      const first = build();
      const second = build();
      expect(first.params).not.toBe(second.params);
      expect(Object.isFrozen(first.params)).toBe(true);
      expect(() => {
        (first.params as Record<string, unknown>)["injected"] = 1;
      }).toThrow(TypeError);
    });

    test("the only exclusion is the lease and the module says so", () => {
      // The premise is in the module, where a later reader will meet it.
      //
      // `I-08`'s `c2_revision` adds this criterion so that nobody later reads
      // "the provider refuses duplicates" as a reason to soften the issue. A
      // comment is the wrong place for that only if nothing checks it is still
      // there.
      const source = readFileSync(MODULE_SOURCE_PATH, "utf8");
      expect(source).toContain("U27");
      expect(source).toContain("U32");
      expect(source).toContain("pre-spawn-fence-search.md");
    });
  },
);

// ==========================================================================
// The fence itself, as a shape
// ==========================================================================

describe("The fence itself, as a shape", () => {
  test("fenced statements carry the fence verbatim", () => {
    const update = String(
      fencedUpdate("outbox", {
        set: { status: value("delivered"), writer_epoch: fenceEpoch },
        where: eq("message_id", param("m")),
      }),
    );
    const insert = String(
      fencedInsert("action", { values: { action_id: param("a"), writer_epoch: fenceEpoch } }),
    );

    expect(update).toContain(FENCE_SQL);
    expect(insert).toContain(FENCE_SQL);
    // The fence is one constant, not a template rebuilt at each call site: a
    // fence assembled by string surgery is one that can be assembled slightly
    // wrong, and the failure is invisible in the row that results.
    expect(countOf(update, "EXISTS (SELECT 1 FROM lease")).toBe(1);
    expect(countOf(insert, "EXISTS (SELECT 1 FROM lease")).toBe(1);
  });

  test("the fence matches the whole token not just the resource", () => {
    // Resource, holder and epoch all have to match, and it has to be live.
    const cp = cpFixture(dbPathFixture());
    const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

    const wrongTokens = [
      new Lease("run/other", lease.holder, lease.epoch, lease.acquiredAtMs, lease.expiresAtMs),
      new Lease(lease.resource, "beta", lease.epoch, lease.acquiredAtMs, lease.expiresAtMs),
      new Lease(lease.resource, lease.holder, 2, lease.acquiredAtMs, lease.expiresAtMs),
    ];
    for (const [index, wrong] of wrongTokens.entries()) {
      expectRefusal(
        () =>
          protectedWrite(
            cp,
            wrong,
            effect(`a-${index}`, {
              nowMs: T0 + 1,
              kind: effectKind(wrong.resource, "deliver_task"),
            }),
            { nowMs: T0 + 1 },
          ),
        StaleWriterRefused,
      );
    }

    expect(protectedWrite(cp, lease, effect("good", { nowMs: T0 + 2 }), { nowMs: T0 + 2 })).toBe(1);
  });

  test("a kind may not name a resource the token is not for", () => {
    // A kind is how a row records which lease allocated its epoch.
    //
    // If the two could disagree, one kind would accumulate epochs from several
    // leases and the history read back under it would be two unrelated sequences
    // with nothing left to tell them apart.
    const cp = cpFixture(dbPathFixture());
    const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });

    expectRefusal(
      () =>
        protectedWrite(
          cp,
          lease,
          effect("a1", { nowMs: T0 + 1, kind: effectKind("run/elsewhere", "deliver_task") }),
          { nowMs: T0 + 1 },
        ),
      LeaseUsageError,
    );
    expectRefusal(
      () =>
        protectedWrite(cp, lease, effect("a2", { nowMs: T0 + 1, kind: "uncomposed" }), {
          nowMs: T0 + 1,
        }),
      LeaseUsageError,
    );
    expect(actionRows(cp)).toEqual([]);
  });

  test("acquire refuses a lease that expires when it starts", () => {
    const cp = cpFixture(dbPathFixture());
    expectRefusal(
      () => acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: 0 }),
      LeaseUsageError,
    );
    expect(readLease(cp, RESOURCE)).toBeUndefined();
  });
});

// ==========================================================================
// seam liveness (target-only)
// ==========================================================================

describe("seam liveness (target-only)", () => {
  test("the generated refusal id comes from the seam", () => {
    // The source never patches `uuid`: every case that reaches the refusal path
    // passes its own `attempt_id`. The seam exists anyway (D-0014), and a seam
    // nothing routes through rots into a decoration -- so this is the check that
    // production's one unnamed-attempt id is minted through `leaseSeams`. Were
    // `recordRefusal` to call `randomUUID` directly, the id below would be a
    // random hex string and this goes red.
    const cp = cpFixture(dbPathFixture());
    patchSeam(leaseSeams, "uuid4Hex", () => "0123456789abcdef0123456789abcdef");

    const lease = acquire(cp, { resource: RESOURCE, holder: "alpha", nowMs: T0, ttlMs: TTL });
    acquire(cp, { resource: RESOURCE, holder: "beta", nowMs: T0 + TTL + 1, ttlMs: TTL });
    const refused = expectRefusal(
      () =>
        protectedWrite(cp, lease, effect("a1", { nowMs: T0 + TTL + 2 }), { nowMs: T0 + TTL + 2 }),
      StaleWriterRefused,
    );

    expect(refused.actionId).toBe("refusal-0123456789abcdef0123456789abcdef");
    expect(actionRows(cp).map((row) => row["action_id"])).toEqual([
      "refusal-0123456789abcdef0123456789abcdef",
    ]);
  });
});
