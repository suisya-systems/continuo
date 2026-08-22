/**
 * G4 -- what the gate ledger must keep true, stated as the properties it exists for.
 *
 * Ported from interlock `tests/control_plane/test_gates.py` at `65f36c5`. Every
 * case here maps to one source node id; the mapping is recorded in the parity
 * ledger.
 *
 * `docs/production-schema.md` section 9 argues for a staged gate with an
 * immutable transition history, a relay that advances on the ack, and six
 * terminal outcomes. Each of those is an argument about a *failure* -- a
 * question the human saw twice, an answer the worker never got, a cancelled
 * run's gate alarming forever -- and an argument about a failure is only
 * settled by a test that reproduces it.
 *
 * So the tests below are named after the properties rather than the functions,
 * and three of them are the ones the design would be worthless without:
 *
 * * `a kill at any relay step recovers to exactly one message and one advance`
 *   is section 9.5's whole reason for existing, driven as a table over the four
 *   kill points the section enumerates.
 * * `a rewind is refused and re asking is a new gate linked by superseded by`
 *   pins the no-backwards-edge rule, whose cost of being wrong is silent: a
 *   rewind resets `stage_entered_at_ms` and turns an old unanswered question
 *   into a young one exactly when somebody noticed it was old.
 * * `a long presented gate is not a relay gap and the opt out is data` asserts
 *   that "a slow human is not a gap" lives in `policy_gate_stage_tolerance` and
 *   not in the detector, by giving `presented` a tolerance in a new revision and
 *   watching the *same* query start reporting it.
 *
 * Every timestamp is {@link T0} plus arithmetic. No test reads a clock, because
 * a suite whose expectations move with the wall clock cannot assert a tolerance
 * boundary -- and the schema gives no timestamp column a `DEFAULT` for the same
 * reason.
 *
 * Translation notes, each a rule rather than a local choice:
 *
 * * Each pytest fixture (`cp`) is a plain function called inside the test
 *   (conventions rule 8), and the connection registers its `close()` with
 *   `onTestFinished` at the point of acquisition (rule 1) -- on Windows an open
 *   handle is what fails the temporary-directory cleanup, and the acquisition
 *   site is the only place that knows the acquisition succeeded.
 * * The source raises `sqlite3.IntegrityError` at three call sites (one of them
 *   parametrized six ways), always from a
 *   schema trigger's `RAISE(ABORT, ...)`. better-sqlite3 raises one error type,
 *   so those become {@link expectSqliteError} on the **result code**
 *   (`SQLITE_CONSTRAINT*`), which is the durable half of the assertion
 *   (`D-0016`); the message text SQLite prints is not a compatibility surface.
 * * `test_only_a_named_stage_is_relayed` expects a bare `ValueError`. Python's
 *   `ValueError` for a caller passing a value outside an enumeration maps to
 *   `TypeError` in this port -- the house convention for an untyped Python
 *   `ValueError`, since `PolicyUsageError` / `EventSpineUsageError` are reserved
 *   for Python's own `UsageError(ValueError)` subclasses and `gates.py` declares
 *   none. Recorded `adapted`.
 * * `monkeypatch.setattr(gates, "append_event", ...)` cannot be reproduced by
 *   rebinding an ESM import, so the two concurrent-close cases replace
 *   `gatesSeams.appendEvent` with {@link patchSeam} (`D-0014`, conventions rule
 *   5). Both cases assert `winnerCommitted` is `[true]`, which is the seam's
 *   liveness check: were production to call `appendEvent` directly, the
 *   replacement would never run, the list would stay empty, and both cases fail
 *   -- so the seam cannot rot into a decoration unnoticed.
 * * The `caseRoot` label is `gates`, a short module nickname (`D-0020`). This
 *   file asserts no `match=` pattern at all -- its source uses none -- so no
 *   pattern can be made vacuous by the temp path; the short label keeps it that
 *   way for any pattern a later edit adds.
 * * The four kill-point expansions re-read the outbox and the transition history
 *   through a **second connection** as well as through `cp`. The source asserts
 *   through its own handle; the extra read is what turns "this handle can see
 *   one message" into "one message committed", which is the claim the case is
 *   named for. It adds an assertion and weakens none.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  ADMISSIBLE,
  AnswerBodyRequired,
  advanceOnAck,
  CLOSE_OUTCOME_STAGES,
  CorrectionTargetRefused,
  closeGate,
  enqueueRelay,
  GATE_OUTCOMES,
  GATE_STAGES,
  GateClosedRefused,
  gatesNeedingAdvance,
  gatesPastDeadline,
  gatesSeams,
  InadmissibleTransitionRefused,
  openGate,
  RelayNotAckedRefused,
  recordCorrection,
  recordResend,
  relayGaps,
  stalledRelays,
  sweepSubjectGone,
  TERMINAL_RUN_STATUSES,
  UnknownGateRefused,
} from "../../src/control_plane/gates.js";
import { createProductionControlPlane } from "../../src/control_plane/migrator.js";
import {
  effectiveRevisionId,
  gateStageTolerance,
  PolicyRowMissing,
} from "../../src/control_plane/policy.js";
import { caseRoot, databasePath } from "../testkit/cases.js";
import { expectRefusal, expectSqliteError } from "../testkit/errors.js";
import { parametrize } from "../testkit/parametrize.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

const MINUTE = 60_000;

/** The result code family a schema trigger's `RAISE(ABORT, ...)` produces. */
const CONSTRAINT = /^SQLITE_CONSTRAINT/;

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------

/** The source's `cp` fixture: a production control plane created at `T0`. */
function cpFixture(): SqliteDatabase {
  const connection = createProductionControlPlane(databasePath(caseRoot("gates")), {
    nowMs: T0,
  });
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

/**
 * A second connection onto the same file, for the cases that claim something
 * committed.
 *
 * A read through the handle that did the writing is satisfied by state that
 * connection can see; this one can only see what was committed.
 */
function secondConnection(cp: SqliteDatabase): SqliteDatabase {
  const connection = new Database(cp.name, { fileMustExist: true });
  onTestFinished(() => {
    connection.close();
  });
  return connection;
}

// --------------------------------------------------------------------------
// helpers -- the smallest legal row of each kind, and the world a gate needs
// --------------------------------------------------------------------------

function addRun(cp: SqliteDatabase, runId = "run-1", status = "running", at: number = T0): string {
  cp.prepare<[string, string, number, number]>(
    "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
  ).run(runId, status, at, at);
  return runId;
}

/**
 * The escalation event section 9.3 requires to exist before a gate opens.
 *
 * Inserted directly rather than through the spine's append: the precondition is
 * that the *row* is there, and going through the fan-out would make these tests
 * depend on which consumers happen to be registered.
 */
function addOriginEvent(
  cp: SqliteDatabase,
  options: { readonly eventId?: string; readonly runId?: string; readonly at?: number } = {},
): number {
  const { eventId = "evt-escalation", runId = "run-1", at = T0 } = options;
  const cursor = cp
    .prepare<[string, string, string, string, number, number]>(
      `
        INSERT INTO event (event_id, event_type, subject_kind, subject_id, run_id,
                           producer, dedup_key, occurred_at_ms, ingested_at_ms)
        VALUES (?, 'worker_escalation_raised', 'run', ?, ?, 'worker', ?, ?, ?)
        `,
    )
    .run(eventId, runId, runId, `dk/${eventId}`, at, at);
  return Number(cursor.lastInsertRowid);
}

/** A run, its escalation event, and a gate opened at `received`. */
function aGate(
  cp: SqliteDatabase,
  gateId = "gate-1",
  options: {
    readonly gateType?: string;
    readonly runId?: string | null;
    readonly at?: number;
    readonly deadlineAtMs?: number | null;
  } = {},
): string {
  const { gateType = "worker_escalation", runId = "run-1", at = T0, deadlineAtMs = null } = options;
  if (
    runId !== null &&
    cp
      .prepare<[string], { one: number }>("SELECT 1 AS one FROM run WHERE run_id = ?")
      .get(runId) === undefined
  ) {
    addRun(cp, runId, "running", at);
  }
  const seq = addOriginEvent(cp, { eventId: `evt/${gateId}`, runId: runId ?? "run-1", at });
  openGate(cp, {
    gateId,
    gateType,
    subjectKind: "run",
    subjectId: runId ?? "run-1",
    rationale: "the worker cannot decide whether to force-push",
    originEventSeq: seq,
    createdAtMs: at,
    actorKind: "worker",
    actorId: "worker-7",
    options: ["force-push", "abandon"],
    deadlineAtMs,
    runId,
  });
  return gateId;
}

/** The outbox delivery worker's step, guarded so a re-run is a no-op. */
function deliver(cp: SqliteDatabase, messageId: string, at: number): void {
  cp.prepare<[number, string]>(
    "UPDATE outbox SET status = 'delivered', delivered_at_ms = ? " +
      " WHERE message_id = ? AND status = 'pending'",
  ).run(at, messageId);
}

function ack(cp: SqliteDatabase, messageId: string, at: number): void {
  cp.prepare<[number, string]>(
    "UPDATE outbox SET status = 'acked', acked_at_ms = ? " +
      " WHERE message_id = ? AND status = 'delivered'",
  ).run(at, messageId);
}

function stageOf(cp: SqliteDatabase, gateId: string): string {
  const stage = cp
    .prepare<[string], string>("SELECT stage FROM gate WHERE gate_id = ?")
    .pluck()
    .get(gateId);
  // Narrowed with a throw rather than a cast: every caller below has already
  // opened the gate, so `undefined` here is a bug in the fixture and should say
  // so rather than reach an assertion as the string "undefined".
  if (stage === undefined) {
    throw new Error(`no gate '${gateId}'`);
  }
  return stage;
}

/** The whole `gate` row, by the database's own column names. */
function gateRow(cp: SqliteDatabase, gateId: string): Record<string, unknown> {
  const row = cp
    .prepare<[string], Record<string, unknown>>("SELECT * FROM gate WHERE gate_id = ?")
    .get(gateId);
  if (row === undefined) {
    throw new Error(`no gate '${gateId}'`);
  }
  return row;
}

/**
 * The gate's transitions as positional tuples, oldest first.
 *
 * Read with `.raw()` so the columns arrive by position exactly as the source's
 * `row[4]` indexing reads them, and so no column name has to be guessed.
 */
function transitions(
  cp: SqliteDatabase,
  gateId: string,
  where: Readonly<Record<string, string>> = {},
): unknown[][] {
  const clauses = Object.keys(where)
    .map((column) => ` AND ${column} = :${column}`)
    .join("");
  return cp
    .prepare<Record<string, string>, unknown[]>(
      "SELECT seq, transition_kind, from_stage, to_stage, body, supersedes_seq, message_id" +
        `  FROM gate_transition WHERE gate_id = :gate_id${clauses} ORDER BY seq`,
    )
    .raw()
    .all({ gate_id: gateId, ...where }) as unknown[][];
}

function outboxRows(cp: SqliteDatabase, dedupKey: string): unknown[][] {
  return cp
    .prepare<[string], unknown[]>(
      "SELECT message_id, status, retry_count FROM outbox WHERE dedup_key = ?",
    )
    .raw()
    .all(dedupKey) as unknown[][];
}

function addRevision(
  cp: SqliteDatabase,
  options: { readonly note: string; readonly effectiveAtMs: number },
): number {
  const cursor = cp
    .prepare<[string, number]>(
      "INSERT INTO policy_revision (note, decided_by, effective_at_ms) " +
        "VALUES (?, 'a later D- entry', ?)",
    )
    .run(options.note, options.effectiveAtMs);
  return Number(cursor.lastInsertRowid);
}

/** `sorted(CLOSE_OUTCOME_STAGES[outcome])[0]`. */
function firstStageOf(outcome: string): string {
  const stages = CLOSE_OUTCOME_STAGES[outcome];
  if (stages === undefined) {
    throw new Error(`no close stages for '${outcome}'`);
  }
  const sorted = Array.from(stages).sort();
  const first = sorted[0];
  if (first === undefined) {
    throw new Error(`no close stages for '${outcome}'`);
  }
  return first;
}

// --------------------------------------------------------------------------
// section 9.5 -- the crash window the whole section exists for
// --------------------------------------------------------------------------

/**
 * The four steps of the section 9.5 table, each idempotent on its own.
 *
 * Recovery is *running the same four again*, which is the claim being tested: a
 * Secretary that comes back after a kill does not need to know where it died,
 * because no step can produce a second message or a second advance.
 */
function relayPipeline(
  cp: SqliteDatabase,
  gateId: string,
  options: { readonly base: number },
): readonly (() => void)[] {
  const { base } = options;
  const enqueue = (): void => {
    enqueueRelay(cp, {
      gateId,
      toStage: "presented",
      recipient: "secretary",
      payload: '{"question": "force-push?"}',
      messageId: `msg/${gateId}/presented`,
      enqueuedAtMs: base,
    });
  };
  const deliverStep = (): void => {
    deliver(cp, `msg/${gateId}/presented`, base + 1_000);
  };
  const ackStep = (): void => {
    ack(cp, `msg/${gateId}/presented`, base + 2_000);
  };
  const advanceStep = (): void => {
    for (const pending of gatesNeedingAdvance(cp)) {
      advanceOnAck(cp, {
        gateId: pending.gateId,
        toStage: pending.toStage,
        actorKind: "secretary",
        actorId: "secretary-1",
        occurredAtMs: base + 3_000,
        recordedAtMs: base + 3_000,
      });
    }
  };
  return [enqueue, deliverStep, ackStep, advanceStep];
}

describe("section 9.5 -- the crash window the whole section exists for", () => {
  parametrize<number>(
    "a kill at any relay step recovers to exactly one message and one advance",
    [
      ["killed_before_the_enqueue", 0],
      ["killed_between_enqueue_and_delivery", 1],
      ["killed_between_delivery_and_ack", 2],
      ["killed_between_ack_and_advance", 3],
    ],
    (killedAfter) => {
      const cp = cpFixture();
      const gateId = aGate(cp);
      const steps = relayPipeline(cp, gateId, { base: T0 + MINUTE });
      for (const step of steps.slice(0, killedAfter)) {
        step();
      }

      // The kill: nothing more runs. Recovery re-runs the whole sequence, which
      // is all a restarted Secretary can do -- it cannot know which step it died
      // on.
      for (const step of relayPipeline(cp, gateId, { base: T0 + 5 * MINUTE })) {
        step();
      }

      expect(outboxRows(cp, `gate/${gateId}/presented`)).toHaveLength(1);
      const advances = transitions(cp, gateId, {
        transition_kind: "advance",
        to_stage: "presented",
      });
      expect(advances).toHaveLength(1);
      expect(stageOf(cp, gateId)).toBe("presented");
      expect(gatesNeedingAdvance(cp)).toEqual([]);

      // ... and exactly-once is a claim about what committed, so it is also read
      // back through a connection that saw none of the writes.
      const other = secondConnection(cp);
      expect(outboxRows(other, `gate/${gateId}/presented`)).toHaveLength(1);
      expect(
        transitions(other, gateId, { transition_kind: "advance", to_stage: "presented" }),
      ).toHaveLength(1);
      expect(stageOf(other, gateId)).toBe("presented");
    },
  );

  test("the stage does not move until the relay is acked", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    const messageId = enqueueRelay(cp, {
      gateId,
      toStage: "presented",
      recipient: "secretary",
      payload: "{}",
      messageId: "msg-1",
      enqueuedAtMs: T0 + MINUTE,
    });
    expectRefusal(
      () =>
        advanceOnAck(cp, {
          gateId,
          toStage: "presented",
          actorKind: "secretary",
          actorId: "secretary-1",
          occurredAtMs: T0 + MINUTE,
          recordedAtMs: T0 + MINUTE,
        }),
      RelayNotAckedRefused,
    );
    deliver(cp, messageId, T0 + 2 * MINUTE);
    expectRefusal(
      () =>
        advanceOnAck(cp, {
          gateId,
          toStage: "presented",
          actorKind: "secretary",
          actorId: "secretary-1",
          occurredAtMs: T0 + 2 * MINUTE,
          recordedAtMs: T0 + 2 * MINUTE,
        }),
      RelayNotAckedRefused,
    );
    expect(stageOf(cp, gateId)).toBe("received");

    ack(cp, messageId, T0 + 3 * MINUTE);
    expect(
      advanceOnAck(cp, {
        gateId,
        toStage: "presented",
        actorKind: "secretary",
        actorId: "secretary-1",
        occurredAtMs: T0 + 3 * MINUTE,
        recordedAtMs: T0 + 3 * MINUTE,
      }),
    ).toBe(true);
    expect(stageOf(cp, gateId)).toBe("presented");
  });

  test("a re enqueued relay takes the message id already in force", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    const first = enqueueRelay(cp, {
      gateId,
      toStage: "presented",
      recipient: "secretary",
      payload: "{}",
      messageId: "msg-first",
      enqueuedAtMs: T0 + MINUTE,
    });
    const second = enqueueRelay(cp, {
      gateId,
      toStage: "presented",
      recipient: "secretary",
      payload: "{}",
      messageId: "msg-second",
      enqueuedAtMs: T0 + 2 * MINUTE,
    });
    expect([first, second]).toEqual(["msg-first", "msg-first"]);
    expect(outboxRows(cp, `gate/${gateId}/presented`)).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// section 9.3 -- the admissible edges, as data
// --------------------------------------------------------------------------

/**
 * Section 9.3's transition table, **actor column included**, transcribed from
 * `docs/production-schema.md` and not from {@link ADMISSIBLE}.
 *
 * Transcribing the document here is the point. The constant under test is
 * itself a transcription, so the only way a transcription error shows up is a
 * second, independent copy of the source to compare it against -- and the check
 * above this one, which reads the *advance* edges out of the constant and
 * asserts a set built from the same three rows, is exactly the shape that cannot
 * catch one. It passed while the `forwarded -> forwarded` close admitted all
 * five actor kinds instead of `system`, because it never looked at
 * `kind == 'close'` and never looked at `actorKinds` at all.
 *
 * The document's wording, row by row:
 *
 * * `-> received` (`open`) is "worker (via system)": the worker raises it and
 *   the system may write it on the worker's behalf.
 * * the three `advance` rows name exactly one actor each.
 * * `resend` and `correction` are "any" at "any open stage", which is all four
 *   stages -- a forwarded gate is open until it closes.
 * * the close is **two** rows: "varies" out of `received`/`presented`/
 *   `answered`, and `system` alone out of `forwarded`.
 *
 * Keyed by `from|to|kind` because a tuple is not a usable key in JavaScript:
 * `None` renders as the empty string, and no stage name is empty, so the
 * encoding is injective over this table.
 */
const SECTION_9_3_ACTOR_COLUMN: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  [edgeKey(null, "received", "open"), ["system", "worker"]],
  [edgeKey("received", "presented", "advance"), ["secretary"]],
  [edgeKey("presented", "answered", "advance"), ["human"]],
  [edgeKey("answered", "forwarded", "advance"), ["secretary"]],
  ...GATE_STAGES.flatMap((stage) =>
    (["resend", "correction"] as const).map(
      (kind) =>
        [
          edgeKey(stage, stage, kind),
          ["dispatcher_core", "human", "secretary", "system", "worker"],
        ] as const,
    ),
  ),
  ...(["received", "presented", "answered"] as const).map(
    (stage) =>
      [
        edgeKey(stage, stage, "close"),
        ["dispatcher_core", "human", "secretary", "system", "worker"],
      ] as const,
  ),
  [edgeKey("forwarded", "forwarded", "close"), ["system"]],
]);

function edgeKey(fromStage: string | null, toStage: string, kind: string): string {
  return `${fromStage ?? ""}|${toStage}|${kind}`;
}

describe("section 9.3 -- the admissible edges, as data", () => {
  test("the admissible advance edges are exactly the three of section 9 3", () => {
    const advances = new Set(
      ADMISSIBLE.filter((edge) => edge.kind === "advance").map(
        (edge) => `${edge.fromStage}->${edge.toStage}`,
      ),
    );
    expect(Array.from(advances).sort()).toEqual(
      ["received->presented", "presented->answered", "answered->forwarded"].sort(),
    );
    // Every non-advance edge stands still or opens; nothing else moves a stage.
    for (const edge of ADMISSIBLE) {
      if (edge.kind !== "advance" && edge.kind !== "open") {
        expect(edge.fromStage).toBe(edge.toStage);
      }
    }
  });

  test("every admissible edge carries the actor column of section 9 3", () => {
    // The whole table, actors and all -- not just the edges that move a stage.
    //
    // Two claims, and the second is why the assertion is a map rather than a set
    // of keys. First, `ADMISSIBLE` names one edge per `(from, to, kind)`:
    // `_requireActor` returns on the *first* match, so a duplicated key would
    // make the second row unreachable data that no other test could distinguish
    // from a typo. Second, each edge's actor set is the document's, which is the
    // property that was silently wrong.
    const byEdge = new Map<string, readonly string[]>();
    for (const edge of ADMISSIBLE) {
      const key = edgeKey(edge.fromStage, edge.toStage, edge.kind);
      expect(byEdge.has(key), `${key} appears twice; the second row is unreachable`).toBe(false);
      byEdge.set(key, Array.from(edge.actorKinds).sort());
    }

    const asEntries = (
      table: ReadonlyMap<string, readonly string[]>,
    ): [string, readonly string[]][] =>
      Array.from(table.entries()).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
    expect(asEntries(byEdge)).toEqual(asEntries(SECTION_9_3_ACTOR_COLUMN));
  });

  test("only the system closes a forwarded gate", () => {
    // The narrowing above, driven through the writer rather than read off the
    // table.
    //
    // A forwarded gate's close is the consequence of an ack, so the party to the
    // gate may not assert it: letting a worker close its own gate as
    // `answered_and_forwarded` would make the gate report the answer delivered
    // on the say-so of the party that was supposed to receive it. The same close
    // at `received` stays open to any actor, which is what makes this a property
    // of the `forwarded` row and not a blanket rule.
    const cp = cpFixture();
    const forwarded = aGate(cp, "gate-forwarded");
    bringTo(cp, forwarded, "forwarded", { base: T0 + MINUTE });

    for (const [actorKind, actorId] of [
      ["worker", "worker-7"],
      ["secretary", "secretary-1"],
      ["human", "ryo"],
      ["dispatcher_core", "core"],
    ] as const) {
      expectRefusal(
        () =>
          closeGate(cp, {
            gateId: forwarded,
            outcome: "answered_and_forwarded",
            actorKind,
            actorId,
            occurredAtMs: T0 + 20 * MINUTE,
            recordedAtMs: T0 + 20 * MINUTE,
          }),
        InadmissibleTransitionRefused,
      );
    }
    expect(gateRow(cp, forwarded).outcome).toBeNull();

    expect(
      closeGate(cp, {
        gateId: forwarded,
        outcome: "answered_and_forwarded",
        actorKind: "system",
        actorId: "reconcile",
        occurredAtMs: T0 + 21 * MINUTE,
        recordedAtMs: T0 + 21 * MINUTE,
      }),
    ).toBe(true);

    // ... and the same actor is still free to close an earlier stage, because
    // section 9.3 gives those rows "varies" and not 'system'.
    const early = aGate(cp, "gate-early", { at: T0 + 30 * MINUTE });
    expect(
      closeGate(cp, {
        gateId: early,
        outcome: "withdrawn",
        actorKind: "worker",
        actorId: "worker-7",
        occurredAtMs: T0 + 31 * MINUTE,
        recordedAtMs: T0 + 31 * MINUTE,
      }),
    ).toBe(true);
  });

  test("a rewind is refused and re asking is a new gate linked by superseded by", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    reachAnswered(cp, gateId, { base: T0 + MINUTE, body: "force-push it" });

    for (const backwards of ["received", "presented"] as const) {
      expectRefusal(
        () =>
          advanceOnAck(cp, {
            gateId,
            toStage: backwards,
            actorKind: "secretary",
            actorId: "secretary-1",
            occurredAtMs: T0 + 10 * MINUTE,
            recordedAtMs: T0 + 10 * MINUTE,
          }),
        InadmissibleTransitionRefused,
      );
    }
    const entered = gateRow(cp, gateId).stage_entered_at_ms;

    const successor = aGate(cp, "gate-2", { at: T0 + 10 * MINUTE });
    expect(
      closeGate(cp, {
        gateId,
        outcome: "superseded",
        actorKind: "secretary",
        actorId: "secretary-1",
        occurredAtMs: T0 + 11 * MINUTE,
        recordedAtMs: T0 + 11 * MINUTE,
        supersededBy: successor,
      }),
    ).toBe(true);

    const row = gateRow(cp, gateId);
    expect([row.stage, row.outcome, row.superseded_by]).toEqual([
      "answered",
      "superseded",
      successor,
    ]);
    // The aging basis the relay-gap detector reads survived the re-ask, which is
    // the reason the rewind is refused at all.
    expect(row.stage_entered_at_ms).toBe(entered);
  });

  test("an advance that skips a stage is refused", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    expectRefusal(
      () =>
        advanceOnAck(cp, {
          gateId,
          toStage: "answered",
          actorKind: "human",
          actorId: "ryo",
          occurredAtMs: T0 + MINUTE,
          recordedAtMs: T0 + MINUTE,
          body: "yes",
        }),
      InadmissibleTransitionRefused,
    );
  });

  test("an unknown gate is refused rather than created", () => {
    const cp = cpFixture();
    expectRefusal(
      () =>
        advanceOnAck(cp, {
          gateId: "nope",
          toStage: "presented",
          actorKind: "secretary",
          actorId: "secretary-1",
          occurredAtMs: T0,
          recordedAtMs: T0,
        }),
      UnknownGateRefused,
    );
  });
});

// --------------------------------------------------------------------------
// section 9.3 -- resends, corrections, and the verbatim answer
// --------------------------------------------------------------------------

function reachPresented(
  cp: SqliteDatabase,
  gateId: string,
  options: { readonly base: number },
): string {
  const { base } = options;
  const messageId = enqueueRelay(cp, {
    gateId,
    toStage: "presented",
    recipient: "secretary",
    payload: "{}",
    messageId: `msg/${gateId}/presented`,
    enqueuedAtMs: base,
  });
  deliver(cp, messageId, base + 1_000);
  ack(cp, messageId, base + 2_000);
  advanceOnAck(cp, {
    gateId,
    toStage: "presented",
    actorKind: "secretary",
    actorId: "secretary-1",
    occurredAtMs: base + 3_000,
    recordedAtMs: base + 3_000,
  });
  return messageId;
}

function reachAnswered(
  cp: SqliteDatabase,
  gateId: string,
  options: { readonly base: number; readonly body: string },
): number {
  const { base, body } = options;
  reachPresented(cp, gateId, { base });
  advanceOnAck(cp, {
    gateId,
    toStage: "answered",
    actorKind: "human",
    actorId: "ryo",
    occurredAtMs: base + 4_000,
    recordedAtMs: base + 5_000,
    body,
  });
  const stageSeq = cp
    .prepare<[string], number>("SELECT stage_seq FROM gate WHERE gate_id = ?")
    .pluck()
    .get(gateId);
  if (stageSeq === undefined || stageSeq === null) {
    throw new Error(`gate '${gateId}' has no stage_seq`);
  }
  return Number(stageSeq);
}

describe("section 9.3 -- resends, corrections, and the verbatim answer", () => {
  test("a resend does not move the stage", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    reachPresented(cp, gateId, { base: T0 + MINUTE });
    const before = gateRow(cp, gateId);

    const seq = recordResend(cp, {
      gateId,
      actorKind: "secretary",
      actorId: "secretary-1",
      occurredAtMs: T0 + 5 * MINUTE,
      recordedAtMs: T0 + 5 * MINUTE,
      messageId: `msg/${gateId}/presented`,
    });
    const after = gateRow(cp, gateId);

    expect([after.stage, after.stage_seq]).toEqual([before.stage, before.stage_seq]);
    expect(after.stage_entered_at_ms).toBe(before.stage_entered_at_ms);
    const resend = transitions(cp, gateId, { transition_kind: "resend" });
    expect(resend.map((row) => row[0])).toEqual([seq]);
    expect(resend[0]?.[2]).toBe("presented");
    expect(resend[0]?.[3]).toBe("presented");
  });

  test("a correction carries supersedes seq and both texts survive", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    const answeredSeq = reachAnswered(cp, gateId, { base: T0 + MINUTE, body: "force-push it" });

    recordCorrection(cp, {
      gateId,
      supersedesSeq: answeredSeq,
      body: "do NOT force-push it",
      actorKind: "human",
      actorId: "ryo",
      occurredAtMs: T0 + 9 * MINUTE,
      recordedAtMs: T0 + 9 * MINUTE,
    });

    const bodies = transitions(cp, gateId)
      .map((row) => row[4])
      .filter((body) => body !== null);
    expect(bodies).toEqual(["force-push it", "do NOT force-push it"]);
    const correction = transitions(cp, gateId, { transition_kind: "correction" })[0];
    expect(correction?.[5]).toBe(answeredSeq);
    expect(stageOf(cp, gateId)).toBe("answered");
  });

  test("a correction may not name another gates transition", () => {
    const cp = cpFixture();
    const first = aGate(cp, "gate-1");
    const other = aGate(cp, "gate-2");
    const otherSeq = Number(
      cp
        .prepare<[string], number>("SELECT stage_seq FROM gate WHERE gate_id = ?")
        .pluck()
        .get(other),
    );
    expectRefusal(
      () =>
        recordCorrection(cp, {
          gateId: first,
          supersedesSeq: otherSeq,
          body: "not mine to correct",
          actorKind: "human",
          actorId: "ryo",
          occurredAtMs: T0 + MINUTE,
          recordedAtMs: T0 + MINUTE,
        }),
      CorrectionTargetRefused,
    );
  });

  test("the verbatim answer is neither paraphrased nor overwritten", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    const verbatim = "  force-push, but ONLY after the CI run at 3f2a1b0 is green.\n(-- ryo)  ";
    const answeredSeq = reachAnswered(cp, gateId, { base: T0 + MINUTE, body: verbatim });

    const stored = cp
      .prepare<[number], string>("SELECT body FROM gate_transition WHERE seq = ?")
      .pluck()
      .get(answeredSeq);
    expect(stored).toBe(verbatim);

    expectSqliteError(
      () =>
        cp
          .prepare<[number]>("UPDATE gate_transition SET body = 'force push ok' WHERE seq = ?")
          .run(answeredSeq),
      { code: CONSTRAINT },
    );
    expect(
      cp
        .prepare<[number], string>("SELECT body FROM gate_transition WHERE seq = ?")
        .pluck()
        .get(answeredSeq),
    ).toBe(verbatim);
  });

  test("an advance to answered without a body is refused", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    reachPresented(cp, gateId, { base: T0 + MINUTE });
    expectRefusal(
      () =>
        advanceOnAck(cp, {
          gateId,
          toStage: "answered",
          actorKind: "human",
          actorId: "ryo",
          occurredAtMs: T0 + 6 * MINUTE,
          recordedAtMs: T0 + 6 * MINUTE,
        }),
      AnswerBodyRequired,
    );
    expect(stageOf(cp, gateId)).toBe("presented");
  });
});

// --------------------------------------------------------------------------
// section 9.4 -- the terminal taxonomy
// --------------------------------------------------------------------------

function bringTo(
  cp: SqliteDatabase,
  gateId: string,
  stage: string,
  options: { readonly base: number },
): void {
  const { base } = options;
  if (stage === "received") {
    return;
  }
  if (stage === "presented") {
    reachPresented(cp, gateId, { base });
    return;
  }
  reachAnswered(cp, gateId, { base, body: "an answer" });
  if (stage === "answered") {
    return;
  }
  const messageId = enqueueRelay(cp, {
    gateId,
    toStage: "forwarded",
    recipient: "worker-7",
    payload: "{}",
    messageId: `msg/${gateId}/forwarded`,
    enqueuedAtMs: base + 6_000,
  });
  deliver(cp, messageId, base + 7_000);
  ack(cp, messageId, base + 8_000);
  advanceOnAck(cp, {
    gateId,
    toStage: "forwarded",
    actorKind: "secretary",
    actorId: "secretary-1",
    occurredAtMs: base + 9_000,
    recordedAtMs: base + 9_000,
  });
}

describe("section 9.4 -- the terminal taxonomy", () => {
  // The ids are written out rather than derived from `GATE_OUTCOMES`, even
  // though the source parametrizes over that constant. Conventions rule 2
  // requires the id to be what `pytest --collect-only` printed, and the point
  // is that the target id must be a stable function of the SOURCE id -- not of
  // a constant belonging to the code under test. Deriving them would let the
  // suite and its subject share one source of truth: an outcome dropped from
  // the taxonomy would quietly drop its case here too, which is the shape of
  // "the tests still pass because they stopped asking".
  //
  // The set is pinned separately, immediately below, so the coupling the source
  // gets for free is kept as an explicit assertion instead.
  parametrize<string>(
    "every terminal outcome is reachable and a closed gate keeps it",
    [
      ["answered_and_forwarded", "answered_and_forwarded"],
      ["withdrawn", "withdrawn"],
      ["subject_gone", "subject_gone"],
      ["expired", "expired"],
      ["unanswerable", "unanswerable"],
      ["superseded", "superseded"],
    ],
    (outcome) => {
      const cp = cpFixture();
      const stage = firstStageOf(outcome);
      const gateId = aGate(cp, `gate-${outcome}`);
      bringTo(cp, gateId, stage, { base: T0 + MINUTE });
      const successor =
        outcome === "superseded" ? aGate(cp, "gate-successor", { at: T0 + 20 * MINUTE }) : null;

      expect(
        closeGate(cp, {
          gateId,
          outcome,
          actorKind: "system",
          actorId: "reconcile",
          occurredAtMs: T0 + 30 * MINUTE,
          recordedAtMs: T0 + 30 * MINUTE,
          supersededBy: successor,
        }),
      ).toBe(true);

      const row = gateRow(cp, gateId);
      expect([row.outcome, row.closed_at_ms, row.stage]).toEqual([
        outcome,
        T0 + 30 * MINUTE,
        stage,
      ]);
      // A second close with the same outcome is the reconcile pass running again.
      expect(
        closeGate(cp, {
          gateId,
          outcome,
          actorKind: "system",
          actorId: "reconcile",
          occurredAtMs: T0 + 40 * MINUTE,
          recordedAtMs: T0 + 40 * MINUTE,
          supersededBy: successor,
        }),
      ).toBe(false);
      // A different outcome is refused, and so is an UPDATE that goes around us.
      const other = outcome !== "expired" ? "expired" : "withdrawn";
      expectRefusal(
        () =>
          closeGate(cp, {
            gateId,
            outcome: other,
            actorKind: "worker",
            actorId: "worker-7",
            occurredAtMs: T0 + 41 * MINUTE,
            recordedAtMs: T0 + 41 * MINUTE,
          }),
        GateClosedRefused,
      );
      expectSqliteError(
        () =>
          cp
            .prepare<[string, string]>("UPDATE gate SET outcome = ? WHERE gate_id = ?")
            .run(other, gateId),
        { code: CONSTRAINT },
      );
      expect(gateRow(cp, gateId).outcome).toBe(outcome);
    },
  );

  test("an outcome is refused from a stage it is not reachable from", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    // 'unanswerable' is the human declining, and there is no human at 'received'.
    expectRefusal(
      () =>
        closeGate(cp, {
          gateId,
          outcome: "unanswerable",
          actorKind: "human",
          actorId: "ryo",
          occurredAtMs: T0 + MINUTE,
          recordedAtMs: T0 + MINUTE,
        }),
      InadmissibleTransitionRefused,
    );
  });

  test("closing a gate puts the closure on the spine", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    closeGate(cp, {
      gateId,
      outcome: "withdrawn",
      actorKind: "worker",
      actorId: "worker-7",
      occurredAtMs: T0 + MINUTE,
      recordedAtMs: T0 + MINUTE,
    });
    const row = cp
      .prepare<[string], unknown[]>(
        "SELECT event_type, subject_kind, subject_id FROM event WHERE dedup_key = ?",
      )
      .raw()
      .get(`gate_closed/${gateId}`);
    expect(row).toEqual(["gate_closed", "gate", gateId]);
  });

  test("an expiry is announced as its own event type", () => {
    const cp = cpFixture();
    const gateId = aGate(cp, "gate-1", { deadlineAtMs: T0 + 10 * MINUTE });
    reachPresented(cp, gateId, { base: T0 + MINUTE });
    closeGate(cp, {
      gateId,
      outcome: "expired",
      actorKind: "system",
      actorId: "reconcile",
      occurredAtMs: T0 + 11 * MINUTE,
      recordedAtMs: T0 + 11 * MINUTE,
    });
    expect(
      cp
        .prepare<[string], string>("SELECT event_type FROM event WHERE dedup_key = ?")
        .pluck()
        .get(`gate_closed/${gateId}`),
    ).toBe("gate_expired");
  });

  test("subject gone is produced by the sweep against a terminal run", () => {
    const cp = cpFixture();
    addRun(cp, "run-live", "running");
    addRun(cp, "run-dead", "running");
    const live = aGate(cp, "gate-live", { runId: "run-live" });
    const dead = aGate(cp, "gate-dead", { runId: "run-dead" });
    reachPresented(cp, dead, { base: T0 + MINUTE });

    expect(sweepSubjectGone(cp, { nowMs: T0 + 5 * MINUTE })).toEqual([]);

    cp.prepare<[number]>(
      "UPDATE run SET status = 'cancelled', updated_at_ms = ? WHERE run_id = 'run-dead'",
    ).run(T0 + 6 * MINUTE);
    expect(sweepSubjectGone(cp, { nowMs: T0 + 7 * MINUTE })).toEqual([dead]);

    expect(gateRow(cp, dead).outcome).toBe("subject_gone");
    expect(gateRow(cp, live).outcome).toBeNull();
    // The pass is restartable: a second sweep closes nothing twice.
    expect(sweepSubjectGone(cp, { nowMs: T0 + 8 * MINUTE })).toEqual([]);
    // The closed gate stops being aged; the live one is still the detector's.
    expect(relayGaps(cp, { nowMs: T0 + 600 * MINUTE }).map((gap) => gap.gateId)).toEqual([live]);
  });

  // `run_id` is nullable, so the `subject_kind='run'` join is not a duplicate.
  //
  // A gate that names its run only as its *subject* is the same situation as one
  // that names it in `run_id` -- there is nobody left to forward to either way
  // -- and a sweep that read `gate.run_id` alone would leave the first kind open
  // forever, which is precisely the permanent-open-row failure `subject_gone`
  // exists to end. `cancelled` is the case the neighbouring test drives; the
  // parametrisation is here because all three of `TERMINAL_RUN_STATUSES` are
  // absorbing under `run_status_is_forward_only` and the sweep must not
  // privilege one of them.
  // Ids written out, not derived from `TERMINAL_RUN_STATUSES` -- see the note on
  // the terminal-outcome parametrization above for why.
  parametrize<string>(
    "the sweep finds the subject run through subject id at every terminal status",
    [
      ["completed", "completed"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ],
    (status) => {
      const cp = cpFixture();
      addRun(cp, "run-1", "running");
      const gateId = aGate(cp, "gate-subject-only", { runId: null });
      // The gate points at the run only through the subject, which is the branch
      // under test: gate.run_id is NULL, so the run_id half of the join matches
      // nothing and only the subject_kind='run' half can find the run.
      const row = gateRow(cp, gateId);
      expect([row.run_id, row.subject_kind, row.subject_id]).toEqual([null, "run", "run-1"]);

      expect(sweepSubjectGone(cp, { nowMs: T0 + 5 * MINUTE })).toEqual([]);

      cp.prepare<[string, number]>(
        "UPDATE run SET status = ?, updated_at_ms = ? WHERE run_id = 'run-1'",
      ).run(status, T0 + 6 * MINUTE);
      expect(sweepSubjectGone(cp, { nowMs: T0 + 7 * MINUTE })).toEqual([gateId]);
      expect(gateRow(cp, gateId).outcome).toBe("subject_gone");
    },
  );
});

// --------------------------------------------------------------------------
// section 9.6 -- the two detectors
// --------------------------------------------------------------------------

describe("section 9.6 -- the two detectors", () => {
  test("a gate left at received is a relay gap past its stage tolerance", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    const tolerance = 3 * MINUTE; // policy_gate_stage_tolerance, worker_escalation/received

    expect(relayGaps(cp, { nowMs: T0 + tolerance })).toEqual([]);
    const gaps = relayGaps(cp, { nowMs: T0 + tolerance + 1 });
    expect(gaps.map((gap) => gap.gateId)).toEqual([gateId]);
    expect(gaps[0]?.ageMs).toBe(tolerance + 1);
  });

  test("a long presented gate is not a relay gap and the opt out is data", () => {
    const cp = cpFixture();
    const gateId = aGate(cp, "gate-1", { deadlineAtMs: T0 + 30 * MINUTE });
    reachPresented(cp, gateId, { base: T0 + MINUTE });

    // Hours at 'presented': a slow human is not a gap, and the detector says so
    // because policy_gate_stage_tolerance stores NULL for the stage.
    expect(relayGaps(cp, { nowMs: T0 + 600 * MINUTE })).toEqual([]);

    // What governs this leg instead is the gate's own deadline.
    expect(gatesPastDeadline(cp, { nowMs: T0 + 30 * MINUTE - 1 })).toEqual([]);
    const overdue = gatesPastDeadline(cp, { nowMs: T0 + 31 * MINUTE });
    expect(overdue.map((row) => row.gateId)).toEqual([gateId]);
    closeGate(cp, {
      gateId,
      outcome: "expired",
      actorKind: "system",
      actorId: "reconcile",
      occurredAtMs: T0 + 31 * MINUTE,
      recordedAtMs: T0 + 31 * MINUTE,
    });
    expect(gateRow(cp, gateId).outcome).toBe("expired");

    // And the opt-out really is data, not a branch: a later revision that gives
    // 'presented' a tolerance makes the same query report the same shape of gate
    // with no code change at all.
    const second = aGate(cp, "gate-2", { at: T0 + 40 * MINUTE });
    reachPresented(cp, second, { base: T0 + 41 * MINUTE });
    const revision = addRevision(cp, {
      note: "presented now ages",
      effectiveAtMs: T0 + 50 * MINUTE,
    });
    cp.prepare<[number, number]>(
      "INSERT INTO policy_gate_stage_tolerance (revision_id, gate_type, stage, tolerance_ms)" +
        " VALUES (?, 'worker_escalation', 'presented', ?)",
    ).run(revision, 5 * MINUTE);
    const gaps = relayGaps(cp, { nowMs: T0 + 60 * MINUTE });
    expect(gaps.map((gap) => gap.gateId)).toEqual([second]);
  });

  // A stated known hole, pinned so it is visible in the suite and not only in
  // prose.
  //
  // `0002_policy_seed.sql` seeds no tolerance rows for `plan_approval` or
  // `risk_approval` on purpose -- `time-base-policy.md` decides no numbers for
  // them, and inventing some in a migration is the policy-in-code that `D-0031`
  // forbids. The section 9.6 query joins `policy_gate_stage_tolerance` inline, so
  // such a gate simply does not match at any age, and nothing anywhere says it is
  // unpoliced.
  //
  // The contrast is the point, and it is asserted against the code rather than
  // described: `policy.gateStageTolerance` **refuses** the same
  // `(gateType, stage)` with `PolicyRowMissing`, because a caller asking for a
  // number it does not have must not be handed silence. The detector has no
  // equivalent -- there is no `gate_type_unpoliced` incident class the way the
  // watcher side has `watcher_scope_uncovered` -- and the design's own query has
  // this shape, so closing the hole means deciding a new incident class, not
  // editing `relayGaps`.
  //
  // When that decision lands, this test is the one that fails, and its failure is
  // the reminder that a hole was being carried deliberately.
  parametrize<string>(
    "an unpoliced gate type is silently never aged",
    [
      ["plan_approval", "plan_approval"],
      ["risk_approval", "risk_approval"],
    ],
    (gateType) => {
      const cp = cpFixture();
      const policed = aGate(cp, "gate-policed");
      const unpoliced = aGate(cp, "gate-unpoliced", { gateType, runId: "run-2" });

      const aged = relayGaps(cp, { nowMs: T0 + 600 * MINUTE }).map((gap) => gap.gateId);
      expect(aged, "the unpoliced gate is not aged -- this is the hole").toEqual([policed]);
      expect(gateRow(cp, unpoliced).closed_at_ms).toBeNull();

      const revision = effectiveRevisionId(cp, { nowMs: T0 + 600 * MINUTE });
      expectRefusal(
        () => gateStageTolerance(cp, { revisionId: revision, gateType, stage: "received" }),
        PolicyRowMissing,
      );
    },
  );

  test("the detector binds one revision and emits one row per gate", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    const revision = addRevision(cp, { note: "tighter received", effectiveAtMs: T0 + MINUTE });
    cp.prepare<[number, number]>(
      "INSERT INTO policy_gate_stage_tolerance (revision_id, gate_type, stage, tolerance_ms)" +
        " VALUES (?, 'worker_escalation', 'received', ?)",
    ).run(revision, MINUTE);
    const gaps = relayGaps(cp, { nowMs: T0 + 10 * MINUTE });
    expect(gaps.map((gap) => gap.gateId)).toEqual([gateId]);
    // The newer revision is the one in force, so its tolerance is the one aged
    // against -- not the seed's, and not both.
    expect(gaps[0]?.ageMs).toBe(10 * MINUTE);
  });

  test("a stalled relay is detected by its own predicate", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    enqueueRelay(cp, {
      gateId,
      toStage: "presented",
      recipient: "secretary",
      payload: "{}",
      messageId: "msg-1",
      enqueuedAtMs: T0,
    });
    // Past the 2 min delivery tolerance, inside the 3 min stage one.
    const now = T0 + 2 * MINUTE + 10_000;

    expect(relayGaps(cp, { nowMs: now })).toEqual([]);
    const stalled = stalledRelays(cp, { nowMs: now, toleranceMs: 2 * MINUTE });
    expect(stalled.map((row) => [row.gateId, row.toStage])).toEqual([[gateId, "presented"]]);

    // Acking it clears the delivery stall without anything else changing: the
    // two conditions are separable only because the advance is ack-gated.
    deliver(cp, "msg-1", now);
    ack(cp, "msg-1", now + 1_000);
    expect(stalledRelays(cp, { nowMs: now + 2_000, toleranceMs: 2 * MINUTE })).toEqual([]);
    expect(gatesNeedingAdvance(cp).map((row) => row.gateId)).toEqual([gateId]);
  });

  test("a closed gate is neither aged nor relayed to", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    closeGate(cp, {
      gateId,
      outcome: "withdrawn",
      actorKind: "worker",
      actorId: "worker-7",
      occurredAtMs: T0 + MINUTE,
      recordedAtMs: T0 + MINUTE,
    });
    expect(relayGaps(cp, { nowMs: T0 + 600 * MINUTE })).toEqual([]);
    expect(gatesPastDeadline(cp, { nowMs: T0 + 600 * MINUTE })).toEqual([]);
    expectRefusal(
      () =>
        enqueueRelay(cp, {
          gateId,
          toStage: "presented",
          recipient: "secretary",
          payload: "{}",
          messageId: "msg-1",
          enqueuedAtMs: T0 + 2 * MINUTE,
        }),
      GateClosedRefused,
    );
  });
});

// --------------------------------------------------------------------------
// section 9.2 -- the projection
// --------------------------------------------------------------------------

describe("section 9.2 -- the projection", () => {
  test("a gate opens at received pointing at its own open transition", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    const row = gateRow(cp, gateId);
    const opening = transitions(cp, gateId);
    expect(opening).toHaveLength(1);
    expect([opening[0]?.[1], opening[0]?.[2], opening[0]?.[3]]).toEqual(["open", null, "received"]);
    expect([row.stage, row.stage_seq]).toEqual(["received", opening[0]?.[0]]);
    expect(row.stage_entered_at_ms).toBe(row.created_at_ms);
    expect(row.options).toBe('["force-push", "abandon"]');
  });

  test("the projection may not be pointed at another gates transition", () => {
    const cp = cpFixture();
    const first = aGate(cp, "gate-1");
    const other = aGate(cp, "gate-2");
    const otherSeq = Number(gateRow(cp, other).stage_seq);
    expectSqliteError(
      () =>
        cp
          .prepare<[number, string]>(
            "UPDATE gate SET stage = 'received', stage_seq = ? WHERE gate_id = ?",
          )
          .run(otherSeq, first),
      { code: CONSTRAINT },
    );
  });

  test("only a named stage is relayed", () => {
    const cp = cpFixture();
    const gateId = aGate(cp);
    for (const stage of GATE_STAGES) {
      if (stage === "presented" || stage === "forwarded") {
        continue;
      }
      expectRefusal(
        () =>
          enqueueRelay(cp, {
            gateId,
            toStage: stage,
            recipient: "secretary",
            payload: "{}",
            messageId: `msg-${stage}`,
            enqueuedAtMs: T0,
          }),
        TypeError,
      );
    }
  });

  test("closing a gate retires its undelivered relay", () => {
    // A close retires the message nobody is waiting for -- in the same commit.
    //
    // The inverse of the defect this replaced. Closure moves every not-yet-acked
    // relay of the gate to `cancelled` (`0003_outbox_cancelled_status.sql`), so a
    // delivery worker reading the outbox is no longer told to present a withdrawn
    // question, and `stalledRelays` stops naming the relay instead of aging it
    // without bound -- the "alarms forever" failure the section 9.4
    // `subject_gone` outcome exists to end, which had reappeared one table over.
    //
    // Cancellation is terminal but not an erasure, so the delivery evidence is
    // asserted to survive it: the row still says it was delivered, and still says
    // how many attempts it took.
    const cp = cpFixture();
    const gateId = aGate(cp);
    enqueueRelay(cp, {
      gateId,
      toStage: "presented",
      recipient: "secretary",
      payload: '{"question": "force-push?"}',
      messageId: "msg-undelivered",
      enqueuedAtMs: T0,
    });
    // Sent, and not answered: 'delivered' means sent, not acked, so this is the
    // case a cancellation must still cover -- the question was put in front of a
    // human and became moot while they were reading it.
    deliver(cp, "msg-undelivered", T0 + 1_000);
    cp.prepare("UPDATE outbox SET retry_count = 2 WHERE message_id = 'msg-undelivered'").run();

    expect(
      stalledRelays(cp, { nowMs: T0 + 10 * MINUTE, toleranceMs: 2 * MINUTE }).length,
    ).toBeGreaterThan(0);

    closeGate(cp, {
      gateId,
      outcome: "withdrawn",
      actorKind: "worker",
      actorId: "worker-7",
      occurredAtMs: T0 + MINUTE,
      recordedAtMs: T0 + MINUTE,
    });

    expect(outboxRows(cp, `gate/${gateId}/presented`)).toEqual([
      ["msg-undelivered", "cancelled", 2],
    ]);

    // However far the clock is wound on, the retired relay is not named again.
    for (const now of [T0 + 10 * MINUTE, T0 + 600 * MINUTE, T0 + 60_000 * MINUTE]) {
      expect(stalledRelays(cp, { nowMs: now, toleranceMs: 2 * MINUTE })).toEqual([]);
    }

    // Terminal, not erased: what the row recorded about the delivery is intact.
    const evidence = cp
      .prepare<[string], unknown[]>(
        "SELECT delivered_at_ms, retry_count FROM outbox WHERE message_id = ?",
      )
      .raw()
      .get("msg-undelivered");
    expect(evidence).toEqual([T0 + 1_000, 2]);
  });

  test("closing a gate leaves an acked relay alone", () => {
    // A gate that closed because it was answered keeps its answered relay.
    //
    // The ack is what section 9.5 justifies the stage advance by, so rewriting
    // the row that carries it would delete the evidence for a decision that
    // really was taken. `cancelled` is for a message nobody is waiting for; an
    // acked one was already waited for and arrived.
    const cp = cpFixture();
    const gateId = aGate(cp);
    enqueueRelay(cp, {
      gateId,
      toStage: "presented",
      recipient: "secretary",
      payload: "{}",
      messageId: "msg-answered",
      enqueuedAtMs: T0,
    });
    deliver(cp, "msg-answered", T0 + 1_000);
    ack(cp, "msg-answered", T0 + 2_000);
    advanceOnAck(cp, {
      gateId,
      toStage: "presented",
      actorKind: "secretary",
      actorId: "secretary-1",
      occurredAtMs: T0 + 2_000,
      recordedAtMs: T0 + 2_000,
    });

    closeGate(cp, {
      gateId,
      outcome: "withdrawn",
      actorKind: "worker",
      actorId: "worker-7",
      occurredAtMs: T0 + MINUTE,
      recordedAtMs: T0 + MINUTE,
    });

    expect(outboxRows(cp, `gate/${gateId}/presented`)).toEqual([["msg-answered", "acked", 0]]);
    expect(
      cp
        .prepare<[], unknown[]>("SELECT acked_at_ms FROM outbox WHERE message_id = 'msg-answered'")
        .raw()
        .get(),
    ).toEqual([T0 + 2_000]);
  });

  test("a second close sweep over a closed gate stays a no op", () => {
    // Re-running the sweep must not trip the trigger on the cancelled row.
    //
    // `cancelled` is terminal, so a second attempt to cancel the same row would
    // be a step out of a terminal status and an integrity error. closeGate's own
    // idempotence (returning `false` for a re-close with the same outcome) is
    // what keeps that unreachable, and this pins it -- a reconcile sweep runs
    // again every period, over gates it closed last time.
    const cp = cpFixture();
    const gateId = aGate(cp);
    enqueueRelay(cp, {
      gateId,
      toStage: "presented",
      recipient: "secretary",
      payload: "{}",
      messageId: "msg-twice",
      enqueuedAtMs: T0,
    });
    const close = {
      gateId,
      outcome: "withdrawn",
      actorKind: "worker",
      actorId: "worker-7",
      occurredAtMs: T0 + MINUTE,
      recordedAtMs: T0 + MINUTE,
    } as const;
    expect(closeGate(cp, close)).toBe(true);
    expect(closeGate(cp, close)).toBe(false);
    expect(outboxRows(cp, `gate/${gateId}/presented`)).toEqual([["msg-twice", "cancelled", 0]]);
  });

  test("a losing concurrent close is refused instead of told its outcome landed", () => {
    // The loser of a race for the close must not be handed the winner's outcome.
    //
    // `closeGate` reads the gate *outside* the append's transaction, so two
    // callers with different outcomes can both pass that read; the winner commits
    // and the loser then collides on `gate_closed/<gateId>` and gets a duplicate
    // back. Reporting that as the ordinary idempotent `false` would tell the
    // loser its `expired` close was already done while section 9.4's taxonomy
    // actually records `withdrawn` -- a projection claiming something the history
    // does not say, which is the one thing the ledger is for.
    //
    // The race is driven deterministically rather than with threads: the winner
    // commits from inside the append seam, which is exactly the window between
    // the loser's pre-check and its append.
    const cp = cpFixture();
    const gateId = aGate(cp);
    reachPresented(cp, gateId, { base: T0 + MINUTE });

    const realAppend = gatesSeams.appendEvent;
    const winnerCommitted: boolean[] = [];

    patchSeam(gatesSeams, "appendEvent", (connection, options) => {
      if (winnerCommitted.length === 0) {
        winnerCommitted.push(true);
        expect(
          closeGate(cp, {
            gateId,
            outcome: "withdrawn",
            actorKind: "worker",
            actorId: "worker-7",
            occurredAtMs: T0 + 5 * MINUTE,
            recordedAtMs: T0 + 5 * MINUTE,
          }),
        ).toBe(true);
      }
      return realAppend(connection, options);
    });

    expectRefusal(
      () =>
        closeGate(cp, {
          gateId,
          outcome: "expired",
          actorKind: "system",
          actorId: "reconcile",
          occurredAtMs: T0 + 6 * MINUTE,
          recordedAtMs: T0 + 6 * MINUTE,
        }),
      GateClosedRefused,
    );
    expect(winnerCommitted).toEqual([true]);
    const row = gateRow(cp, gateId);
    expect([row.outcome, row.closed_at_ms]).toEqual(["withdrawn", T0 + 5 * MINUTE]);
  });

  test("a concurrent close with the same outcome stays the idempotent no op", () => {
    // Losing the race to an *identical* close is still "already done", not a
    // refusal.
    //
    // The counterpart to the test above: the duplicate path must distinguish
    // "already done, identically" from "already done, differently", and
    // collapsing both into a refusal would break the reconcile sweep, whose
    // second pass over a gate it closed last time is the ordinary case and not an
    // incident.
    const cp = cpFixture();
    const gateId = aGate(cp);
    reachPresented(cp, gateId, { base: T0 + MINUTE });

    const realAppend = gatesSeams.appendEvent;
    const winnerCommitted: boolean[] = [];

    patchSeam(gatesSeams, "appendEvent", (connection, options) => {
      if (winnerCommitted.length === 0) {
        winnerCommitted.push(true);
        expect(
          closeGate(cp, {
            gateId,
            outcome: "expired",
            actorKind: "system",
            actorId: "reconcile",
            occurredAtMs: T0 + 5 * MINUTE,
            recordedAtMs: T0 + 5 * MINUTE,
          }),
        ).toBe(true);
      }
      return realAppend(connection, options);
    });

    expect(
      closeGate(cp, {
        gateId,
        outcome: "expired",
        actorKind: "system",
        actorId: "reconcile",
        occurredAtMs: T0 + 6 * MINUTE,
        recordedAtMs: T0 + 6 * MINUTE,
      }),
    ).toBe(false);
    const row = gateRow(cp, gateId);
    expect([row.outcome, row.closed_at_ms]).toEqual(["expired", T0 + 5 * MINUTE]);
  });

  test("a closure identity on the spine without a closure is refused", () => {
    // The dedup key alone is never taken as evidence that the gate closed.
    //
    // `closeGate` writes the closure as the append's `sideEffect`, so the two
    // commit together and this state cannot arise from this module. It is
    // asserted because the duplicate path's re-read is what makes that true: an
    // outside writer that took the identity must not be able to make a later
    // close report success for a closure that is not in the table.
    const cp = cpFixture();
    const gateId = aGate(cp);
    cp.prepare<[string, string, string, number, number]>(
      `
        INSERT INTO event (event_id, event_type, subject_kind, subject_id, run_id,
                           producer, dedup_key, occurred_at_ms, ingested_at_ms)
        VALUES (?, 'gate_closed', 'gate', ?, 'run-1', 'dispatcher_core', ?, ?, ?)
        `,
    ).run(`gate_closed/${gateId}`, gateId, `gate_closed/${gateId}`, T0 + MINUTE, T0 + MINUTE);
    // The source's `cp.commit()` has no counterpart: Python's driver opens an
    // implicit transaction before DML, and better-sqlite3 has no such mode --
    // every statement outside a `transaction()` block is autocommit, so the row
    // above is already durable here.

    expectRefusal(
      () =>
        closeGate(cp, {
          gateId,
          outcome: "withdrawn",
          actorKind: "worker",
          actorId: "worker-7",
          occurredAtMs: T0 + 2 * MINUTE,
          recordedAtMs: T0 + 2 * MINUTE,
        }),
      GateClosedRefused,
    );
    expect(gateRow(cp, gateId).closed_at_ms).toBeNull();
  });
});

// --------------------------------------------------------------------------
// seam liveness, and the coupling the explicit parametrize ids gave up
// --------------------------------------------------------------------------

describe("the relay targets the stage the gate is about to enter (target-only)", () => {
  test("a relay enqueued ahead of the gate's stage is refused", () => {
    // TARGET-ONLY, pinning a DELIBERATE DIVERGENCE from interlock (D-0026).
    //
    // interlock's `enqueue_relay` checks only that the target is a relayed
    // stage. So a `forwarded` relay can be put in front of a worker while the
    // gate is still `received`; it is acked there, and after the ordinary
    // presented and answered advances `advance_on_ack(to_stage='forwarded')`
    // accepts that ack -- recording the answer as forwarded although the
    // acknowledged payload predates the answer it is supposed to carry.
    //
    // continuo refuses it, from ADMISSIBLE's own advance edge rather than a
    // hardcoded pair. The rule is the DIRECT predecessor and not "anything
    // reachable", because reachable leaves the same hole open: `received`
    // reaches `forwarded`.
    //
    // Chosen on evidence, not on principle: all twelve `enqueue_relay` call
    // sites in interlock enqueue at the direct predecessor, and there is no
    // production caller at all, so nothing legitimate is blocked. If a later
    // reconcile driver genuinely needs to enqueue ahead, this is the test that
    // will fail, and D-0026 says to relax the rule deliberately at that point
    // rather than treat the refusal as inviolable.
    const cp = cpFixture();
    const gateId = aGate(cp, "gate-ahead");

    expectRefusal(
      () =>
        enqueueRelay(cp, {
          gateId,
          toStage: "forwarded",
          recipient: "worker-7",
          payload: "{}",
          messageId: "msg/ahead",
          enqueuedAtMs: T0 + MINUTE,
        }),
      InadmissibleTransitionRefused,
      /is at 'received'/,
    );

    // ...and the relay the gate IS at the predecessor for is still accepted, so
    // the guard refuses the early one rather than everything.
    //
    // (The recovery path is pinned by the case below: the guard runs only when
    // a relay is about to be CREATED, never on the idempotent re-enqueue.)
    expect(
      enqueueRelay(cp, {
        gateId,
        toStage: "presented",
        recipient: "secretary",
        payload: "{}",
        messageId: "msg/ok",
        enqueuedAtMs: T0 + MINUTE,
      }),
    ).toBe("msg/ok");
  });
});

describe("the predecessor check does not break recovery (target-only)", () => {
  test("a re-enqueue after the stage advanced still returns the message in force", () => {
    // TARGET-ONLY, and the other half of D-0026.
    //
    // `enqueueRelay` is idempotent so that a Secretary killed after its commit
    // can replay on recovery and get back the id already in force rather than
    // sending a human a second copy. The crash window that matters is exactly
    // the one that MOVES the stage: if the kill lands after `advanceOnAck`
    // committed, the replay arrives with the gate already at `toStage`, where
    // the predecessor no longer holds.
    //
    // A first draft of the predecessor check ran before the existing-relay
    // lookup and threw there, breaking the recovery path the function exists
    // to serve. The guard now runs only when a relay is about to be created.
    const cp = cpFixture();
    const gateId = aGate(cp, "gate-replay");
    const messageId = enqueueRelay(cp, {
      gateId,
      toStage: "presented",
      recipient: "secretary",
      payload: "{}",
      messageId: "msg/replay",
      enqueuedAtMs: T0 + MINUTE,
    });
    deliver(cp, messageId, T0 + MINUTE + 1_000);
    ack(cp, messageId, T0 + MINUTE + 2_000);
    advanceOnAck(cp, {
      gateId,
      toStage: "presented",
      actorKind: "secretary",
      actorId: "secretary-1",
      occurredAtMs: T0 + MINUTE + 3_000,
      recordedAtMs: T0 + MINUTE + 3_000,
    });
    expect(stageOf(cp, gateId)).toBe("presented");

    // The replay: same call, gate now AT the stage it targets.
    expect(
      enqueueRelay(cp, {
        gateId,
        toStage: "presented",
        recipient: "secretary",
        payload: "{}",
        messageId: "msg/replay-again",
        enqueuedAtMs: T0 + 2 * MINUTE,
      }),
    ).toBe(messageId);
  });
});

describe("seam liveness (target-only)", () => {
  test("closeGate appends to the spine through the seam record", () => {
    // TARGET-ONLY. Two ported cases replace `gatesSeams.appendEvent` to drive a
    // commit race deterministically, and a seam can rot into a decoration: if a
    // refactor made `closeGate` call the imported `appendEvent` directly, the
    // replacement would simply never run and those cases would stay green,
    // because their assertions are about refusals and would still hold -- for
    // the wrong reason. Conventions rule 5 requires this test for exactly that.
    const cp = cpFixture();
    const gateId = aGate(cp, "gate-seam");

    let calls = 0;
    const real = gatesSeams.appendEvent;
    patchSeam(gatesSeams, "appendEvent", (connection, options) => {
      calls += 1;
      return real(connection, options);
    });

    expect(
      closeGate(cp, {
        gateId,
        outcome: "withdrawn",
        actorKind: "worker",
        actorId: "worker-7",
        occurredAtMs: T0 + MINUTE,
        recordedAtMs: T0 + MINUTE,
      }),
    ).toBe(true);
    expect(calls, "production must route its spine append through the seam record").toBe(1);
  });

  test("the terminal-outcome cases cover exactly GATE_OUTCOMES", () => {
    // TARGET-ONLY, and the other half of writing those parametrize ids out by
    // hand. The source parametrizes over the constant, so an outcome added to
    // the taxonomy adds a case there automatically; explicit ids give that up
    // in exchange for a target id that does not depend on the code under test
    // (conventions rule 2). This assertion buys the coupling back: an outcome
    // added to or dropped from `GATE_OUTCOMES` and not reflected above is a
    // failure here rather than a case that silently stopped existing.
    expect([...GATE_OUTCOMES].sort()).toEqual(
      [
        "answered_and_forwarded",
        "expired",
        "subject_gone",
        "superseded",
        "unanswerable",
        "withdrawn",
      ].sort(),
    );
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(["cancelled", "completed", "failed"].sort());
  });
});
