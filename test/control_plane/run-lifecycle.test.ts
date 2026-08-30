/**
 * The single in-place writer of `run.status`, and the column it stamps.
 *
 * **Target-only.** Interlock has no counterpart: `D-0046` is a continuo
 * decision taken on `docs/design/minimal-operating-loop.md` section 6.2, and
 * nothing in the source advances a run through a fenced writer -- the source's
 * run rows are written by whichever test needs one. So there is no source node
 * id to port and no parity ledger claims this file; the only ledger it touches
 * is `parity/gate_item11.no-provider-detail-leaks.ledger.json`, whose
 * directory walk picks it up like every other file under `test/control_plane/`.
 *
 * What these cases are for, in the order they appear:
 *
 * * **The gate is traversed, not merely available.** A transition lands only
 *   while the token is live, stamps the epoch it landed under, and a token
 *   taken over is refused *durably* -- an `action` row in status `refused` --
 *   rather than merged. That is `ACCEPTANCE.md` section 2 applied to the run
 *   table, and the reason the refusal's own row is asserted is that a refusal
 *   only a live holder could record is a refusal that vanishes exactly when it
 *   matters.
 * * **The gate cannot be walked around.** The builders in `lease.ts` are what
 *   make single-writerhood structural rather than a convention, so the cases
 *   that matter are the ones showing an unfenced or unstamped write cannot be
 *   *constructed* -- plus the structural check that no module under `src/`
 *   writes the `run` table in raw SQL at all, which is `D-0046` rule 1 stated
 *   as a property of this build rather than as a promise.
 * * **The mirrored lattice agrees with the trigger.** `run_lifecycle.ts`
 *   restates `run_status_is_forward_only` so a refused step is a typed refusal
 *   instead of an integrity error from three frames down. A restatement that
 *   can drift is worse than none, so every ordered pair of statuses is put
 *   through both the module and a raw `UPDATE`, and the two verdicts must
 *   match.
 * * **The migration.** `0004_run_writer_epoch.sql` adds the column to a
 *   database that already holds rows, so the case that matters is the one run
 *   against a database at `0003` with a run row in it: a column added to an
 *   empty database proves nothing about the rows already there.
 *
 * Every timestamp is {@link T0} and arithmetic on it, never a clock -- the
 * schema gives no timestamp column a `DEFAULT` for the same reason, and a
 * suite whose expectations move with the wall clock cannot assert a fencing
 * boundary.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as SqliteDatabase } from "better-sqlite3";
import * as ts from "typescript/unstable/ast";
import { describe, expect, onTestFinished, test } from "vitest";
import { parseSourceFile } from "../../scripts/lib/ts-ast.mjs";
import { TERMINAL_RUN_STATUSES as GATES_TERMINAL_RUN_STATUSES } from "../../src/control_plane/gates.js";
import {
  eq,
  FencedStatement,
  fencedUpdate,
  fenceEpoch,
  LeaseHeld,
  LeaseUsageError,
  ProtectedWrite,
  ProtectedWriteMissed,
  param,
  StaleWriterRefused,
  UnfencedStatement,
  value,
} from "../../src/control_plane/lease.js";
import {
  createProductionControlPlane,
  MIGRATIONS_DIR,
  migrateControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import {
  ADVANCE_RUN_STATUS_EFFECT,
  acquireRunLease,
  advanceRunStatus,
  RUN_LEASE_PREFIX,
  RUN_STATUSES,
  RunLifecycleUsageError,
  type RunStatus,
  RunTransitionRefused,
  readRun,
  runLeaseResource,
  TERMINAL_RUN_STATUSES,
  UnknownRunRefused,
} from "../../src/control_plane/run_lifecycle.js";
import { caseRoot, databasePath, suiteTemplate, writeStep } from "../testkit/cases.js";
import { expectRefusal, expectSqliteError } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;
const TTL_MS = 30_000;
const RUN_ID = "run-1";
const HOLDER = "secretary-1";

/** The family every `CHECK` and `RAISE(ABORT, ...)` refusal below arrives as. */
const CONSTRAINT = /^SQLITE_CONSTRAINT/;

const productionTemplate = suiteTemplate("run-lifecycle.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/** A migrated production control plane, at head, with no rows of its own. */
function cpFixture(): SqliteDatabase {
  const path = productionTemplate.copyInto(caseRoot("run-lifecycle"));
  const cp = openProductionControlPlane(path);
  onTestFinished(() => {
    cp.close();
  });
  return cp;
}

/**
 * A run row, inserted **unfenced and on purpose**.
 *
 * Section 4.2's writer table assigns run *creation* no fence, and `D-0046`
 * keeps it that way: what is single-writer is the in-place transition of
 * `status`. So the module has no `createRun`, and a test that wants a row
 * writes one -- exactly as every other suite in this repository does.
 */
function addRun(cp: SqliteDatabase, runId = RUN_ID, status: RunStatus = "created"): void {
  cp.prepare(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
  ).run(runId, status, T0, T0);
}

/** The `action` rows a run's writer left behind, oldest first. */
function actions(cp: SqliteDatabase, runId = RUN_ID): Record<string, unknown>[] {
  return cp.prepare("SELECT * FROM action WHERE run_id = ? ORDER BY rowid").all(runId) as Record<
    string,
    unknown
  >[];
}

// --------------------------------------------------------------------------
// the lease, and its granularity
// --------------------------------------------------------------------------

describe("the run lease", () => {
  test("the resource name is a function of the run", () => {
    // D-0046 rule 3. The name is derived, so no argument a caller passes can
    // aim the fence at another run's lease.
    expect(runLeaseResource(RUN_ID)).toBe(`${RUN_LEASE_PREFIX}${RUN_ID}`);
    expect(runLeaseResource("run-2")).not.toBe(runLeaseResource(RUN_ID));
  });

  test("two claimants of one run cannot both hold it", () => {
    const cp = cpFixture();
    addRun(cp);
    acquireRunLease(cp, { runId: RUN_ID, holder: HOLDER, nowMs: T0, ttlMs: TTL_MS });
    expectRefusal(
      () =>
        acquireRunLease(cp, {
          runId: RUN_ID,
          holder: "secretary-2",
          nowMs: T0 + 1,
          ttlMs: TTL_MS,
        }),
      LeaseHeld,
    );
  });

  test("two runs never contend", () => {
    const cp = cpFixture();
    addRun(cp, "run-a");
    addRun(cp, "run-b");
    const a = acquireRunLease(cp, { runId: "run-a", holder: HOLDER, nowMs: T0, ttlMs: TTL_MS });
    const b = acquireRunLease(cp, {
      runId: "run-b",
      holder: "secretary-2",
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    expect([a.resource, b.resource]).toEqual(["run:run-a", "run:run-b"]);
  });

  test("a malformed run id is refused before a resource name is composed from it", () => {
    expectRefusal(() => runLeaseResource(""), RunLifecycleUsageError, /run_id must be/);
  });
});

// --------------------------------------------------------------------------
// the gate is traversed
// --------------------------------------------------------------------------

describe("the transition goes through the protected-write gate", () => {
  test("a live token transitions the run and stamps the epoch it wrote under", () => {
    const cp = cpFixture();
    addRun(cp);
    const lease = acquireRunLease(cp, {
      runId: RUN_ID,
      holder: HOLDER,
      nowMs: T0,
      ttlMs: TTL_MS,
    });

    expect(
      advanceRunStatus(cp, lease, { runId: RUN_ID, from: "created", to: "running", nowMs: T0 + 1 }),
    ).toBe(1);

    const run = readRun(cp, RUN_ID);
    expect([run?.status, run?.updatedAtMs]).toEqual(["running", T0 + 1]);
    // D-0046 rule 4, and the whole reason 0004 exists: the row now says which
    // lease wrote it.
    expect(run?.writerEpoch).toBe(lease.epoch);
  });

  test("a takeover raises the epoch and the next transition carries the new one", () => {
    const cp = cpFixture();
    addRun(cp);
    const first = acquireRunLease(cp, { runId: RUN_ID, holder: HOLDER, nowMs: T0, ttlMs: TTL_MS });
    advanceRunStatus(cp, first, { runId: RUN_ID, from: "created", to: "running", nowMs: T0 + 1 });

    const afterExpiry = T0 + TTL_MS + 1;
    const second = acquireRunLease(cp, {
      runId: RUN_ID,
      holder: "secretary-2",
      nowMs: afterExpiry,
      ttlMs: TTL_MS,
    });
    expect(second.epoch).toBeGreaterThan(first.epoch);

    advanceRunStatus(cp, second, {
      runId: RUN_ID,
      from: "running",
      to: "completed",
      nowMs: afterExpiry + 1,
    });
    const run = readRun(cp, RUN_ID);
    expect([run?.status, run?.writerEpoch]).toEqual(["completed", second.epoch]);
  });

  test("a stale token is refused, the run is untouched, and the refusal is durable", () => {
    const cp = cpFixture();
    addRun(cp);
    const stale = acquireRunLease(cp, { runId: RUN_ID, holder: HOLDER, nowMs: T0, ttlMs: TTL_MS });
    const afterExpiry = T0 + TTL_MS + 1;
    acquireRunLease(cp, {
      runId: RUN_ID,
      holder: "secretary-2",
      nowMs: afterExpiry,
      ttlMs: TTL_MS,
    });

    const refused = expectRefusal(
      () =>
        advanceRunStatus(cp, stale, {
          runId: RUN_ID,
          from: "created",
          to: "running",
          nowMs: afterExpiry + 1,
          attemptId: "attempt-1",
        }),
      StaleWriterRefused,
      /stale fencing token/,
    );

    // Nothing moved -- including the writer_epoch stamp, which would otherwise
    // be a stale writer's mark on a row it never wrote.
    const run = readRun(cp, RUN_ID);
    expect([run?.status, run?.writerEpoch, run?.updatedAtMs]).toEqual(["created", null, T0]);

    // ...and the rejection is itself durable: not silently dropped.
    expect(refused.actionId).toBe("attempt-1");
    const rows = actions(cp);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("refused");
    expect(rows[0]?.writer_epoch).toBe(stale.epoch);
    // The kind names the lease that allocated the epoch, which is the only
    // thing in an `action` row that can (there is no resource column).
    expect(rows[0]?.kind).toBe(`${ADVANCE_RUN_STATUS_EFFECT}@${runLeaseResource(RUN_ID)}`);
  });

  test("a live token whose run already moved changes nothing and records nothing", () => {
    const cp = cpFixture();
    addRun(cp);
    const lease = acquireRunLease(cp, { runId: RUN_ID, holder: HOLDER, nowMs: T0, ttlMs: TTL_MS });
    advanceRunStatus(cp, lease, { runId: RUN_ID, from: "created", to: "running", nowMs: T0 + 1 });

    // The compare-and-set half: a transition computed from a stale read lands
    // on nothing rather than on top of whoever moved the row.
    expectRefusal(
      () =>
        advanceRunStatus(cp, lease, {
          runId: RUN_ID,
          from: "created",
          to: "suspended",
          nowMs: T0 + 2,
        }),
      ProtectedWriteMissed,
    );
    expect(readRun(cp, RUN_ID)?.status).toBe("running");
    // No `action` row: this is not a rejected writer, and recording it as one
    // would put an invented refusal into the evidence.
    expect(actions(cp)).toEqual([]);
  });

  test("a token for another run is refused before any statement runs", () => {
    const cp = cpFixture();
    addRun(cp, "run-a");
    addRun(cp, "run-b");
    const other = acquireRunLease(cp, { runId: "run-b", holder: HOLDER, nowMs: T0, ttlMs: TTL_MS });

    // The kind is composed from the run being written, never from the token,
    // so a misrouted transition cannot even be attempted.
    expectRefusal(
      () =>
        advanceRunStatus(cp, other, {
          runId: "run-a",
          from: "created",
          to: "running",
          nowMs: T0 + 1,
        }),
      LeaseUsageError,
      /names resource 'run:run-a' but the token is for 'run:run-b'/,
    );
    expect(readRun(cp, "run-a")?.status).toBe("created");
    expect(actions(cp, "run-a")).toEqual([]);
  });

  test("a run that does not exist is named as such, not created and not merely missed", () => {
    const cp = cpFixture();
    const lease = acquireRunLease(cp, {
      runId: "run-absent",
      holder: HOLDER,
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    // Told apart from "somebody else already advanced it", which is the other
    // way a fenced write matches no row. Collapsing the two would leave an
    // operator unable to tell a resolution mistake from a lost race.
    expectRefusal(
      () =>
        advanceRunStatus(cp, lease, {
          runId: "run-absent",
          from: "created",
          to: "running",
          nowMs: T0 + 1,
        }),
      UnknownRunRefused,
      /there is no run 'run-absent' to transition/,
    );
    expect(readRun(cp, "run-absent")).toBeUndefined();
  });

  test("a stale token on an absent run is still a typed refusal, not a foreign key error", () => {
    // The case that makes the existence question worth asking before the write
    // rather than leaving it to the statement. `protectedWrite` records a stale
    // writer as an `action` row, and `action.run_id` references `run(run_id)`
    // -- so for a run that is not there the refusal insert dies with
    // SQLITE_CONSTRAINT_FOREIGNKEY, the refusal rolls back, and a raw SQLite
    // error surfaces in place of StaleWriterRefused. That is exactly the
    // rejection ACCEPTANCE.md section 2 forbids being dropped, dropped at the
    // one moment a writer was in fact rejected.
    const cp = cpFixture();
    const stale = acquireRunLease(cp, {
      runId: "run-absent",
      holder: HOLDER,
      nowMs: T0,
      ttlMs: TTL_MS,
    });
    const afterExpiry = T0 + TTL_MS + 1;
    acquireRunLease(cp, {
      runId: "run-absent",
      holder: "secretary-2",
      nowMs: afterExpiry,
      ttlMs: TTL_MS,
    });
    expectRefusal(
      () =>
        advanceRunStatus(cp, stale, {
          runId: "run-absent",
          from: "created",
          to: "running",
          nowMs: afterExpiry + 1,
        }),
      UnknownRunRefused,
    );
  });
});

// --------------------------------------------------------------------------
// the gate cannot be walked around
// --------------------------------------------------------------------------

describe("the gate cannot be walked around", () => {
  test("a hand-written statement is not a fenced statement", () => {
    // The type is the check, and the builder's token is not reachable from
    // outside `lease.ts`. A substring scan for the fence could not tell a
    // fence that gates the write from one parked somewhere harmless; this can.
    expectRefusal(
      () => new FencedStatement("UPDATE run SET status = 'completed' WHERE run_id = :run_id"),
      UnfencedStatement,
      /issued by fenced_update\(\) or fenced_insert\(\)/,
    );
  });

  test("a protected write will not accept a statement it did not issue", () => {
    // The cast is what the compiler refuses without: `statement` is typed
    // `FencedStatement`, so the unfenced shape does not type-check at all.
    // This is the second line of defence, for a caller arriving from
    // JavaScript.
    expectRefusal(
      () =>
        new ProtectedWrite({
          kind: `${ADVANCE_RUN_STATUS_EFFECT}@${runLeaseResource(RUN_ID)}`,
          idempotencyKey: "hand-written",
          statement: "UPDATE run SET status = 'completed'" as unknown as FencedStatement,
          exactlyOnceMechanism: "transactional_with_record",
        }),
      UnfencedStatement,
      /was not issued by fenced_update\(\) or fenced_insert\(\)/,
    );
  });

  test("a write to run that does not stamp the epoch cannot be built", () => {
    expectRefusal(
      () =>
        fencedUpdate("run", {
          set: { status: value("completed") },
          where: eq("run_id", param("run_id")),
        }),
      UnfencedStatement,
      /must assign fence_epoch to writer_epoch/,
    );
  });

  test("a caller does not get to mint the epoch it stamps", () => {
    expectRefusal(
      () =>
        fencedUpdate("run", {
          set: { status: value("completed"), writer_epoch: value(7) },
          where: eq("run_id", param("run_id")),
        }),
      UnfencedStatement,
      /must assign fence_epoch to writer_epoch/,
    );
  });

  test("the builder puts the fence in the write's own predicate", () => {
    const statement = String(
      fencedUpdate("run", {
        set: { status: param("to_status"), writer_epoch: fenceEpoch },
        where: eq("run_id", param("run_id")),
      }),
    );
    expect(statement).toContain("writer_epoch = :fence_epoch");
    // ANDed onto the caller's predicate, so the fence decides whether the row
    // changes rather than merely appearing in the text.
    expect(statement).toMatch(/AND EXISTS \(SELECT 1 FROM lease/);
  });

  test("no module under src writes the run table in raw SQL", () => {
    // D-0046 rule 1, stated as a property of this build: there is exactly one
    // writer because there is exactly one place that can produce the
    // statement, and that place produces it with a builder rather than writing
    // it out. A raw `UPDATE run` or `INSERT INTO run` anywhere under `src/` is
    // the anomaly the rule names, and this is what surfaces it.
    expect(sourceFilesWritingRun(/\bUPDATE\s+run\b|\bINSERT\s+INTO\s+run\b/i)).toEqual([]);

    // Anti-vacuity: a scanner that matched nothing would report the same
    // empty list for a build full of raw writes. This file is full of them --
    // it is where the unfenced writes under test live -- so the same scan
    // pointed at it must come back non-empty.
    expect(filesWritingRun([fileURLToPath(import.meta.url)], /\bUPDATE\s+run\b/i)).not.toEqual([]);
  });

  test("no module under src deletes a run", () => {
    // What `UnknownRunRefused` leans on: the existence question is asked
    // before the write, so a run deleted between the two would put the
    // foreign-key failure back. There is no such window in this build because
    // there is no deletion path -- asserted rather than assumed, since `run`
    // has no `rows_are_never_deleted` trigger the way `outbox` does, and this
    // is the only thing saying so.
    expect(sourceFilesWritingRun(/\bDELETE\s+FROM\s+run\b/i)).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// what the stamp does not buy
// --------------------------------------------------------------------------

describe("the writer_epoch stamp is evidence, not enforcement", () => {
  test("an unfenced status write leaves the previous stamp standing", () => {
    // The limitation D-0046 rule 4 leaves open, asserted rather than only
    // described. Only the deferred `BEFORE UPDATE OF status ON run` trigger
    // can close it; until then the column proves the property over the writes
    // that came through the gate and says nothing about the ones that did not.
    //
    // This case is expected to go RED on the day that trigger lands -- the raw
    // UPDATE below will abort -- which is the point: whoever writes the second
    // stage is sent here to restate what changed.
    const cp = cpFixture();
    addRun(cp);
    const lease = acquireRunLease(cp, { runId: RUN_ID, holder: HOLDER, nowMs: T0, ttlMs: TTL_MS });
    advanceRunStatus(cp, lease, { runId: RUN_ID, from: "created", to: "running", nowMs: T0 + 1 });
    const fenced = readRun(cp, RUN_ID);

    // Nobody holds a lease for this write, and it names no epoch.
    cp.prepare("UPDATE run SET status = 'completed', updated_at_ms = ? WHERE run_id = ?").run(
      T0 + 2,
      RUN_ID,
    );

    const unfenced = readRun(cp, RUN_ID);
    expect(unfenced?.status).toBe("completed");
    // Both directions, so the entry cannot go stale silently: the row moved,
    // and its provenance column did not, so the transition to `completed` is
    // indistinguishable from one the epoch-1 holder made.
    expect(unfenced?.writerEpoch).toBe(fenced?.writerEpoch);
    expect(unfenced?.writerEpoch).toBe(lease.epoch);
  });

  test("an unfenced write may also state an epoch of its own choosing", () => {
    // The CHECK constrains the shape of the value, never its truth: any
    // positive integer is accepted, including one no lease ever allocated.
    // `fencedUpdate` is what makes the stamp mean something, and it renders
    // the epoch as `:fence_epoch` from the token the same statement validated
    // -- a caller cannot mint one (asserted above), but raw SQL is not a
    // caller.
    const cp = cpFixture();
    addRun(cp);
    cp.prepare("UPDATE run SET writer_epoch = 99 WHERE run_id = ?").run(RUN_ID);
    expect(readRun(cp, RUN_ID)?.writerEpoch).toBe(99);
    expect(
      cp.prepare<[], number>("SELECT COUNT(*) FROM lease").pluck().get(),
      "no lease exists at all, let alone one at epoch 99",
    ).toBe(0);
  });
});

// --------------------------------------------------------------------------
// the mirrored lattice agrees with the trigger
// --------------------------------------------------------------------------

/** Every ordered pair of distinct statuses -- 30 of them. */
const STEPS: readonly (readonly [RunStatus, RunStatus])[] = RUN_STATUSES.flatMap((from) =>
  RUN_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
);

describe("the mirrored lattice agrees with run_status_is_forward_only", () => {
  for (const [from, to] of STEPS) {
    test(`the module and the trigger agree on ${from} -> ${to}`, () => {
      const cp = cpFixture();

      // The module's verdict, taken through a real fenced write, so an
      // admitted step is one that actually landed.
      addRun(cp, "run-module", from);
      const lease = acquireRunLease(cp, {
        runId: "run-module",
        holder: HOLDER,
        nowMs: T0,
        ttlMs: TTL_MS,
      });
      let moduleAdmits = true;
      try {
        advanceRunStatus(cp, lease, { runId: "run-module", from, to, nowMs: T0 + 1 });
      } catch (error) {
        if (!(error instanceof RunTransitionRefused)) {
          throw error;
        }
        moduleAdmits = false;
      }

      // The trigger's verdict, on a row of its own, written raw.
      addRun(cp, "run-ddl", from);
      let triggerAdmits = true;
      try {
        cp.prepare("UPDATE run SET status = ?, updated_at_ms = ? WHERE run_id = 'run-ddl'").run(
          to,
          T0 + 1,
        );
      } catch (error) {
        if (!CONSTRAINT.test(String((error as { code?: unknown }).code))) {
          throw error;
        }
        triggerAdmits = false;
      }

      expect(
        moduleAdmits,
        `${from} -> ${to}: the module admits ${moduleAdmits}, the trigger admits ${triggerAdmits}`,
      ).toBe(triggerAdmits);

      const run = readRun(cp, "run-module");
      expect(run?.status).toBe(moduleAdmits ? to : from);
      // An admitted step is fenced evidence; a refused one leaves no mark at all.
      expect(run?.writerEpoch).toBe(moduleAdmits ? lease.epoch : null);
    });
  }

  test("the module refuses a no-op step the trigger would admit", () => {
    // The one deliberate divergence, and it is a tightening. The trigger's
    // WHEN clause never fires for NEW.status = OLD.status, so a raw
    // self-update is admitted; the module refuses it, because such a write
    // still stamps a writer_epoch and an updated_at_ms and would record a step
    // that never happened.
    const cp = cpFixture();
    addRun(cp, RUN_ID, "running");
    const lease = acquireRunLease(cp, { runId: RUN_ID, holder: HOLDER, nowMs: T0, ttlMs: TTL_MS });
    expectRefusal(
      () =>
        advanceRunStatus(cp, lease, {
          runId: RUN_ID,
          from: "running",
          to: "running",
          nowMs: T0 + 1,
        }),
      RunTransitionRefused,
      /does not transition from 'running' to itself/,
    );
    cp.prepare("UPDATE run SET status = 'running' WHERE run_id = ?").run(RUN_ID);
    expect(readRun(cp, RUN_ID)?.writerEpoch).toBeNull();
  });

  test("the mirrored vocabulary is the table's own", () => {
    const cp = cpFixture();
    // Anti-drift: the words the module will write are the words the CHECK
    // admits, asserted by trying each one rather than by comparing two lists
    // nobody has to keep in step.
    for (const status of RUN_STATUSES) {
      addRun(cp, `run-${status}`, status);
      expect(readRun(cp, `run-${status}`)?.status).toBe(status);
    }
    expectSqliteError(() => addRun(cp, "run-invented", "archived" as RunStatus), {
      code: CONSTRAINT,
    });

    // ...and a word outside it is refused by the module before a statement is
    // built, rather than reaching the CHECK as an integrity error.
    addRun(cp);
    const lease = acquireRunLease(cp, { runId: RUN_ID, holder: HOLDER, nowMs: T0, ttlMs: TTL_MS });
    expectRefusal(
      () =>
        advanceRunStatus(cp, lease, {
          runId: RUN_ID,
          from: "created",
          to: "archived" as RunStatus,
          nowMs: T0 + 1,
        }),
      RunLifecycleUsageError,
      /to must be one of/,
    );
  });

  test("the two declarations of the terminal set have not drifted", () => {
    // `gates.ts` restates the same G1 adjudication where its subject_gone
    // sweep reads it, and this module restates it where the writer reads it;
    // neither imports the other, because the dependency would point backwards
    // (gates consumes run status, this writes it). Two independent
    // declarations of one set is the `outbox.ts` / `lease.ts`
    // EXACTLY_ONCE_MECHANISMS pattern, and it is only safe with this case.
    expect([...TERMINAL_RUN_STATUSES]).toEqual([...GATES_TERMINAL_RUN_STATUSES]);
  });

  test("the terminal set is the trigger's terminal set", () => {
    const cp = cpFixture();
    for (const from of TERMINAL_RUN_STATUSES) {
      addRun(cp, `run-${from}`, from);
      expectSqliteError(
        () => cp.prepare("UPDATE run SET status = 'running' WHERE run_id = ?").run(`run-${from}`),
        { code: CONSTRAINT, message: /a terminal run is never reopened/ },
      );
    }
    // ...and nothing outside that set is terminal to the trigger.
    for (const from of RUN_STATUSES.filter(
      (status) => !(TERMINAL_RUN_STATUSES as readonly string[]).includes(status),
    )) {
      addRun(cp, `run-open-${from}`, from);
      cp.prepare("UPDATE run SET status = 'completed' WHERE run_id = ?").run(`run-open-${from}`);
    }
  });
});

// --------------------------------------------------------------------------
// the migration
// --------------------------------------------------------------------------

describe("0004_run_writer_epoch", () => {
  test("the column arrives on a database that already holds run rows", () => {
    // A column added to an empty database says nothing about the rows already
    // there. So the database is built at 0003 from byte-identical copies of
    // the shipped steps -- the ledger's checksums are then the ones this build
    // computes, and a hand-written stand-in would be refused as an edited step
    // rather than accepted as a database that is merely behind -- a run row is
    // written into it, and only then is head applied.
    const root = caseRoot("run-lifecycle-migrate");
    const dbPath = databasePath(root);
    const at0003 = join(root, "at-0003");
    for (const name of [
      "0001_initial.sql",
      "0002_policy_seed.sql",
      "0003_outbox_cancelled_status.sql",
    ]) {
      writeStep(at0003, name, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }

    const before = createProductionControlPlane(dbPath, { nowMs: T0, migrationsDir: at0003 });
    try {
      expect(
        (before.pragma("table_info(run)") as { name: string }[]).map((row) => row.name),
      ).not.toContain("writer_epoch");
      before
        .prepare(
          "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'running', ?, ?)",
        )
        .run(RUN_ID, T0, T0);
    } finally {
      before.close();
    }

    const cp = migrateControlPlane(dbPath, { nowMs: T0 + 1 });
    onTestFinished(() => {
      cp.close();
    });

    const column = (cp.pragma("table_info(run)") as { name: string; notnull: number }[]).find(
      (row) => row.name === "writer_epoch",
    );
    expect(column).toBeDefined();
    // Nullable, and left NULL on the row that was already there: a run written
    // before this step was written under no lease, and inventing an epoch for
    // it would manufacture the evidence the column exists to carry.
    expect(column?.notnull).toBe(0);
    const run = readRun(cp, RUN_ID);
    expect([run?.status, run?.writerEpoch]).toEqual(["running", null]);

    // The row is still writable through the gate afterwards, which is the
    // property a migration that merely *adds* a column has to keep.
    const lease = acquireRunLease(cp, { runId: RUN_ID, holder: HOLDER, nowMs: T0, ttlMs: TTL_MS });
    advanceRunStatus(cp, lease, { runId: RUN_ID, from: "running", to: "completed", nowMs: T0 + 2 });
    expect(readRun(cp, RUN_ID)?.writerEpoch).toBe(lease.epoch);
  });

  test("the column refuses an epoch no lease could have allocated", () => {
    const cp = cpFixture();
    addRun(cp);
    // 0 and -1 fail `writer_epoch > 0` (lease's own `CHECK (epoch > 0)`); 1.5
    // and 'three' fail the typeof pin, which INTEGER affinity does not rescue
    // because neither converts losslessly to an integer.
    for (const bad of [0, -1, 1.5, "three"]) {
      expectSqliteError(
        () => cp.prepare("UPDATE run SET writer_epoch = ? WHERE run_id = ?").run(bad, RUN_ID),
        { code: CONSTRAINT },
      );
    }
    expect(readRun(cp, RUN_ID)?.writerEpoch).toBeNull();
  });

  test("the step restored nothing because it dropped nothing", () => {
    // 0003 rebuilt a table and therefore had to recreate every trigger and
    // index that went with it. This step is an ALTER TABLE ADD COLUMN, so
    // run's trigger and its status CHECK are still the ones 0001 wrote.
    const cp = cpFixture();
    expect(
      cp
        .prepare<[], string>(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'run_status_is_forward_only'",
        )
        .pluck()
        .get(),
    ).toContain("a terminal run is never reopened");
    expect(
      cp
        .prepare<[], string>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run'")
        .pluck()
        .get(),
    ).toContain("'completed', 'failed', 'cancelled'");
  });
});

// --------------------------------------------------------------------------
// reading a run back
// --------------------------------------------------------------------------

describe("readRun", () => {
  test("an absent run reads as undefined rather than as a default row", () => {
    expect(readRun(cpFixture(), "run-absent")).toBeUndefined();
  });

  test("a run reads back frozen", () => {
    const cp = cpFixture();
    addRun(cp);
    const run = readRun(cp, RUN_ID);
    expect(Object.isFrozen(run)).toBe(true);
    expect([run?.runId, run?.status, run?.createdAtMs, run?.updatedAtMs]).toEqual([
      RUN_ID,
      "created",
      T0,
      T0,
    ]);
  });
});

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/**
 * The files under `src/` with a **string literal** matching `pattern`.
 *
 * Literals rather than raw text, because SQL reaches SQLite through a literal
 * and never through a comment, and a scan over the bytes cannot tell the two
 * apart -- it reports a docstring that *names* the statement it is warning
 * about, which is how the module documenting this very limitation ends up
 * accused of it. Template literals count: a statement assembled from one is
 * still a statement.
 */
function sourceFilesWritingRun(pattern: RegExp): readonly string[] {
  return filesWritingRun(sourceFiles(), pattern);
}

/** {@link sourceFilesWritingRun} over an arbitrary file list. */
function filesWritingRun(paths: readonly string[], pattern: RegExp): readonly string[] {
  return paths.filter((path) => {
    const source = parseSourceFile(path, readFileSync(path, "utf8"));
    let found = false;
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteralLikeNode(node) || ts.isTemplateLiteralToken(node)) &&
        pattern.test(node.text)
      ) {
        found = true;
      }
      node.forEachChild(visit);
    };
    visit(source);
    return found;
  });
}

/** Every `.ts` file shipped under `src/`, as absolute paths. */
function sourceFiles(): readonly string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.name.endsWith(".ts")) {
        found.push(path);
      }
    }
  };
  visit(fileURLToPath(new URL("../../src/", import.meta.url)));
  // Anti-vacuity: an empty walk would satisfy the filter while saying nothing.
  expect(found.length).toBeGreaterThan(0);
  return found;
}
