/**
 * `continuo run close`: the operator's close of a run, and the transition set
 * `D-0084` fixes for it.
 *
 * **Target-only.** Interlock mounts no `run` subtree and has no close at all, so
 * there is no source node id to port and no parity ledger claims this file; the
 * only ledger it touches is
 * `parity/gate_item11.no-provider-detail-leaks.ledger.json`, whose directory
 * walk picks it up like every other file under `test/control_plane/`. Rule 10 of
 * `docs/test-translation-conventions.md` applies: each case names what would be
 * silently wrong without it.
 *
 * What these cases are for, in the order they appear:
 *
 * * **The transition set, enumerated rather than sampled.** `D-0084`'s whole
 *   content is which steps this verb may take, so the table walks every
 *   closeable status against every terminal one -- nine steps -- and the two
 *   sets are checked against `run_lifecycle.ts`'s vocabulary rather than
 *   against a copy written here. A close that quietly stopped admitting
 *   `created -> completed` would be a verb no dogfood run could use, and every
 *   run lap 1 produced is at `created`.
 * * **What a close records, and what it deliberately does not.** The row, its
 *   `updated_at_ms` and its `writer_epoch` are the record; the spine gains
 *   nothing. A case asserts the event count is unchanged, because "appends no
 *   event" is a decision (`D-0084`) rather than an omission, and a later change
 *   that started appending one should have to argue with a red test.
 * * **The lease is taken under the actor and given back.** The actor's identity
 *   survives only as the `lease` row the stamped epoch names, so the case reads
 *   the row rather than trusting the return value. And the give-back is what
 *   makes a corrected second attempt immediate: without it an operator who
 *   mistyped `--outcome` would meet their own claim for a whole TTL.
 * * **The refusals cost the database nothing.** Absent run, already-closed run
 *   and a live claimant are all asserted with the lease row and the run row
 *   afterwards, not just by the exception's type: a refusal that had already
 *   bumped an epoch or moved a status is not a refusal.
 * * **The mount, driven end to end.** Every CLI case goes through `src/cli.ts`'s
 *   `main` rather than calling the handler, for the reason `db-cli.test.ts`
 *   gives: a verb whose parser is correct and which nothing hangs off the
 *   subcommand table is exactly the state a mount task exists to fix, and a test
 *   calling the handler directly stays green through it.
 *
 * Every timestamp is {@link T0} and arithmetic on it, never a clock: the schema
 * gives no timestamp column a `DEFAULT` for the same reason, and a suite whose
 * expectations move with the wall clock cannot assert what a caller-supplied
 * clock wrote.
 */

import { resolve } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { helpStrings } from "../../src/cli/parser.js";
import { buildParser, main, cliSeams as topLevelSeams } from "../../src/cli.js";
import { LapRunIntent } from "../../src/control_plane/lap_run_intent.js";
import { acquire, LeaseHeld, readLease } from "../../src/control_plane/lease.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { admitRun } from "../../src/control_plane/run_admission.js";
import { runCliSeams } from "../../src/control_plane/run_cli.js";
import {
  CLOSEABLE_RUN_STATUSES,
  closeRun,
  RUN_CLOSE_LEASE_TTL_MS,
  RUN_CLOSE_OUTCOMES,
  RunCloseRefused,
  RunCloseUsageError,
} from "../../src/control_plane/run_close.js";
import {
  acquireRunLease,
  advanceRunStatus,
  RUN_STATUSES,
  type RunStatus,
  readRun,
  runLeaseResource,
  TERMINAL_RUN_STATUSES,
} from "../../src/control_plane/run_lifecycle.js";
import { caseRoot, databasePath, suiteTemplate } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant, and later ones. */
const T0 = 1_700_000_000_000;
const T1 = T0 + 60_000;
const T2 = T1 + 60_000;
const RUN_ID = "run-1";
const ACTOR = "operator-1";

/** The absolute workspace path the fixtures record, on whichever platform. */
const WORKSPACE = resolve("wt", "run-1");

const productionTemplate = suiteTemplate("run-close.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/** A migrated production control plane at head, holding one admitted run. */
function admittedFixture(runId: string = RUN_ID): {
  connection: SqliteDatabase;
  path: string;
} {
  const path = productionTemplate.copyInto(caseRoot(`run-close-${runId}`));
  const connection = openProductionControlPlane(path);
  onTestFinished(() => {
    connection.close();
  });
  admitRun(connection, {
    intent: new LapRunIntent({
      runId,
      leaseClaimantId: "secretary-1",
      workspace: WORKSPACE,
      role: "worker",
      baseBranch: "main",
      topicBranch: "feat/run-1",
      prompt: "port the thing",
    }),
    nowMs: T0,
  });
  return { connection, path };
}

/**
 * Put `runId` at `status`, through the real writer.
 *
 * The setup uses `advanceRunStatus` rather than an `UPDATE` for the reason
 * `run-lifecycle.test.ts` asserts structurally: there is one writer of
 * `run.status`, and a suite that reached around it to arrange a case would be
 * testing the close against rows the build cannot produce. The lease is given
 * back at `T0`, so the close under test takes its own.
 */
function putAt(connection: SqliteDatabase, runId: string, status: RunStatus): void {
  if (status === "created") {
    return;
  }
  const record = readRun(connection, runId);
  const lease = acquireRunLease(connection, {
    runId,
    holder: "setup",
    nowMs: T0,
    ttlMs: 1,
  });
  advanceRunStatus(connection, lease, {
    runId,
    from: String(record?.status) as RunStatus,
    to: status,
    nowMs: T0,
  });
}

/** The `run` row, as the database holds it. */
function runRow(connection: SqliteDatabase, runId: string = RUN_ID): Record<string, unknown> {
  return connection.prepare("SELECT * FROM run WHERE run_id = ?").get(runId) as Record<
    string,
    unknown
  >;
}

/** How many events the spine holds. */
function eventCount(connection: SqliteDatabase): number {
  return Number(connection.prepare("SELECT COUNT(*) AS n FROM event").pluck().get());
}

/** How many `action` rows the database holds, by status. */
function actionRows(connection: SqliteDatabase): Record<string, unknown>[] {
  return connection.prepare("SELECT * FROM action ORDER BY created_at_ms").all() as Record<
    string,
    unknown
  >[];
}

/** What one verb wrote to each stream. */
interface Streams {
  out(): string;
  err(): string;
}

/**
 * Capture both of the module's streams for the running test.
 *
 * Both, always. A refusal case that only read stdout would pass against a
 * command that printed nothing and exited 2 for the wrong reason, and a success
 * case that only read stdout would not notice a warning on stderr.
 */
function captureStreams(): Streams {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  patchSeam(runCliSeams, "write", (text: string) => {
    outChunks.push(text);
  });
  patchSeam(runCliSeams, "writeError", (text: string) => {
    errChunks.push(text);
  });
  return {
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}

/** Freeze the clock and count the reads, so "read once" is a number and not a hope. */
function countedClock(instant: number): { reads: () => number } {
  let reads = 0;
  patchSeam(runCliSeams, "nowMs", () => {
    reads += 1;
    return instant;
  });
  return { reads: () => reads };
}

/** `continuo run close`'s argv with every flag the verb requires. */
function closeArgv(
  path: string,
  overrides: Readonly<Record<string, string>> = {},
): readonly string[] {
  const flags: Record<string, string> = {
    "--db": path,
    "--run-id": RUN_ID,
    "--outcome": "completed",
    "--actor-id": ACTOR,
    ...overrides,
  };
  return ["run", "close", ...Object.entries(flags).flat()];
}

// --------------------------------------------------------------------------
// the transition set (D-0084)
// --------------------------------------------------------------------------

describe("the transitions a close may take", () => {
  test("the closeable set is the vocabulary minus the terminal set", () => {
    // Derived, not written down -- so this asserts the derivation rather than
    // restating three words a fourth time. A status added to the vocabulary
    // arrives here automatically, which is the point.
    expect([...CLOSEABLE_RUN_STATUSES]).toEqual(
      RUN_STATUSES.filter(
        (status) => !(TERMINAL_RUN_STATUSES as readonly string[]).includes(status),
      ),
    );
    expect([...CLOSEABLE_RUN_STATUSES]).toEqual(["created", "running", "suspended"]);
  });

  test("the outcome set is the terminal set entire, and is that same object", () => {
    expect(RUN_CLOSE_OUTCOMES).toBe(TERMINAL_RUN_STATUSES);
    expect([...RUN_CLOSE_OUTCOMES]).toEqual(["completed", "failed", "cancelled"]);
  });

  for (const from of CLOSEABLE_RUN_STATUSES) {
    for (const to of RUN_CLOSE_OUTCOMES) {
      test(`closes ${from} -> ${to}`, () => {
        const runId = `run-${from}-${to}`;
        const { connection } = admittedFixture(runId);
        putAt(connection, runId, from);

        const closed = closeRun(connection, {
          runId,
          outcome: to,
          actorId: ACTOR,
          nowMs: T1,
        });

        expect(closed.from).toBe(from);
        expect(closed.to).toBe(to);
        // `created -> <terminal>` is the step every lap-1 run needs, and the one
        // a design that insisted on passing through `running` would refuse.
        expect(runRow(connection, runId)["status"]).toBe(to);
      });
    }
  }
});

// --------------------------------------------------------------------------
// what a close records
// --------------------------------------------------------------------------

describe("what a close writes", () => {
  test("moves the run, stamps updated_at_ms and writer_epoch from one clock", () => {
    const { connection } = admittedFixture();

    const closed = closeRun(connection, {
      runId: RUN_ID,
      outcome: "completed",
      actorId: ACTOR,
      nowMs: T1,
    });

    const row = runRow(connection);
    expect(row["status"]).toBe("completed");
    // The admission's instant is untouched and the close's is the caller's:
    // a close that stamped a clock of its own would make the two unorderable.
    expect(row["created_at_ms"]).toBe(T0);
    expect(row["updated_at_ms"]).toBe(T1);
    // The stamp is what makes the single-writer property provable over this
    // write (`D-0046` rule 4), and it is the link to the lease row below.
    expect(row["writer_epoch"]).toBe(closed.writerEpoch);
    expect(closed.actorId).toBe(ACTOR);
  });

  test("appends no event: the row is the record (D-0084)", () => {
    const { connection } = admittedFixture();
    const before = eventCount(connection);

    closeRun(connection, { runId: RUN_ID, outcome: "completed", actorId: ACTOR, nowMs: T1 });

    // Two admission events and nothing else. `advanceRunStatus` goes through
    // `protectedWrite`, which owns its transaction, so an event appended here
    // could not be atomic with the transition -- and there is no observed
    // provider fact to append in the first place. If a `run_closed` event is
    // ever wanted, it arrives with that argument answered, not by accident.
    expect(eventCount(connection)).toBe(before);
    expect(before).toBe(2);
  });

  test("records no action row for a write that was not refused", () => {
    const { connection } = admittedFixture();

    closeRun(connection, { runId: RUN_ID, outcome: "completed", actorId: ACTOR, nowMs: T1 });

    // `protectedWrite` writes an `action` row only for a REFUSED writer, so an
    // action row here would mean the close's own fence had rejected it and the
    // suite had not noticed.
    expect(actionRows(connection)).toEqual([]);
  });

  test("takes the run lease under the actor and gives it back", () => {
    const { connection } = admittedFixture();

    const closed = closeRun(connection, {
      runId: RUN_ID,
      outcome: "completed",
      actorId: ACTOR,
      nowMs: T1,
    });

    const lease = readLease(connection, runLeaseResource(RUN_ID));
    // The holder is the only durable record of WHO closed the run, reachable
    // from the row through the epoch the row stamps.
    expect(lease?.holder).toBe(ACTOR);
    expect(lease?.epoch).toBe(closed.writerEpoch);
    // Given back rather than left to expire: the row's expiry is one
    // millisecond past the acquisition, not the whole TTL, so a corrected
    // second attempt does not meet the operator's own claim.
    expect(lease?.expiresAtMs).toBe(T1 + 1);
    expect(lease?.expiresAtMs).toBeLessThan(T1 + RUN_CLOSE_LEASE_TTL_MS);
  });

  test("a second close of the same run is refused, and the first stands", () => {
    const { connection } = admittedFixture();

    closeRun(connection, { runId: RUN_ID, outcome: "completed", actorId: ACTOR, nowMs: T1 });
    const epochAfterFirst = readLease(connection, runLeaseResource(RUN_ID))?.epoch;

    expectRefusal(
      () => closeRun(connection, { runId: RUN_ID, outcome: "failed", actorId: ACTOR, nowMs: T2 }),
      RunCloseRefused,
      /already closed as 'completed'/,
    );

    const row = runRow(connection);
    expect(row["status"]).toBe("completed");
    expect(row["updated_at_ms"]).toBe(T1);
    // Refused BEFORE the lease is taken: an epoch allocated to a writer that
    // never wrote is a gap in the history the stamp exists to make readable.
    expect(readLease(connection, runLeaseResource(RUN_ID))?.epoch).toBe(epochAfterFirst);
  });
});

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

describe("a close that cannot land writes nothing", () => {
  test("refuses a run that was never admitted, without taking a lease", () => {
    const { connection } = admittedFixture();

    expectRefusal(
      () =>
        closeRun(connection, {
          runId: "run-absent",
          outcome: "completed",
          actorId: ACTOR,
          nowMs: T1,
        }),
      RunCloseRefused,
      /there is no run 'run-absent' to close/,
    );

    expect(readLease(connection, runLeaseResource("run-absent"))).toBeUndefined();
    expect(runRow(connection)["status"]).toBe("created");
  });

  test("quotes a run id carrying a newline, so a refusal stays one line", () => {
    const { connection } = admittedFixture();

    // The one path where `--run-id` reaches a message unvalidated: it matched no
    // row, so nothing upstream held it to printable ASCII. `pythonRepr` escapes
    // it rather than letting it forge a second line of output.
    expectRefusal(
      () =>
        closeRun(connection, {
          runId: "run-1\nclosed forged",
          outcome: "completed",
          actorId: ACTOR,
          nowMs: T1,
        }),
      RunCloseRefused,
      /run 'run-1\\nclosed forged' to close/,
    );
  });

  test("refuses while a live claimant holds the run lease", () => {
    const { connection } = admittedFixture();
    // What a lap still driving this run looks like from here.
    acquire(connection, {
      resource: runLeaseResource(RUN_ID),
      holder: "lap-1",
      nowMs: T1,
      ttlMs: 30_000,
    });

    expectRefusal(
      () =>
        closeRun(connection, {
          runId: RUN_ID,
          outcome: "completed",
          actorId: ACTOR,
          nowMs: T1,
        }),
      LeaseHeld,
      /is held by 'lap-1'/,
    );

    // The run is untouched and the claimant keeps its epoch: a close landing
    // under a live lap would transition a run out from under a session that is
    // still writing.
    expect(runRow(connection)["status"]).toBe("created");
    expect(readLease(connection, runLeaseResource(RUN_ID))?.holder).toBe("lap-1");
  });

  test("refuses an outcome outside the terminal set as a defect, not a refusal", () => {
    const { connection } = admittedFixture();

    // A usage error rather than a `ControlPlaneRefusal`: the CLI's `choices`
    // makes this unreachable for an operator, so a caller reaching it has a
    // defect and keeps its stack.
    expect(() =>
      closeRun(connection, {
        runId: RUN_ID,
        outcome: "running" as RunStatus,
        actorId: ACTOR,
        nowMs: T1,
      }),
    ).toThrow(RunCloseUsageError);
    expect(runRow(connection)["status"]).toBe("created");
  });

  test("refuses a clock behind the run's own updated_at_ms, before the lease", () => {
    const { connection } = admittedFixture();

    // `run` carries CHECK (updated_at_ms >= created_at_ms), and the close writes
    // `updated_at_ms`. Without this check the write fails INSIDE the fenced
    // statement, so what reaches the operator is a raw SQLITE_CONSTRAINT after a
    // lease has already been taken and given back.
    expectRefusal(
      () =>
        closeRun(connection, {
          runId: RUN_ID,
          outcome: "completed",
          actorId: ACTOR,
          nowMs: T0 - 1,
        }),
      RunCloseRefused,
      /would stamp an updated_at_ms before the run's own 1700000000000/,
    );

    expect(runRow(connection)["status"]).toBe("created");
    expect(readLease(connection, runLeaseResource(RUN_ID))).toBeUndefined();
  });

  test("closes at the run's own instant: the bound is not strict", () => {
    const { connection } = admittedFixture();

    // Equal is admissible -- a close in the same millisecond as the admission is
    // a fast operator, not a clock running backwards.
    closeRun(connection, { runId: RUN_ID, outcome: "completed", actorId: ACTOR, nowMs: T0 });

    expect(runRow(connection)["status"]).toBe("completed");
  });

  test("refuses an actor id that could forge a second line of output", () => {
    const { connection } = admittedFixture();

    // The value is printed back verbatim in the close's report, so a newline in
    // it would put a line on stdout that reads like a second close. Held to
    // printable ASCII exactly as `LapRunIntent` holds a run id, and refused
    // before anything is written.
    expect(() =>
      closeRun(connection, {
        runId: RUN_ID,
        outcome: "completed",
        actorId: "op\nclosed forged-run in nowhere",
        nowMs: T1,
      }),
    ).toThrow(RunCloseUsageError);

    expect(runRow(connection)["status"]).toBe("created");
    expect(readLease(connection, runLeaseResource(RUN_ID))).toBeUndefined();
  });

  test("refuses a malformed argument before anything is read", () => {
    const { connection } = admittedFixture();

    for (const options of [
      { runId: "", outcome: "completed" as RunStatus, actorId: ACTOR, nowMs: T1 },
      { runId: RUN_ID, outcome: "completed" as RunStatus, actorId: "", nowMs: T1 },
      { runId: RUN_ID, outcome: "completed" as RunStatus, actorId: ACTOR, nowMs: 1.5 },
    ]) {
      expect(() => closeRun(connection, options)).toThrow(RunCloseUsageError);
    }
    expect(runRow(connection)["status"]).toBe("created");
  });
});

// --------------------------------------------------------------------------
// the mount
// --------------------------------------------------------------------------

describe("continuo run close", () => {
  test("closes an admitted run end to end and reports the step it took", () => {
    const { connection, path } = admittedFixture();
    connection.close();
    const streams = captureStreams();

    const code = main(closeArgv(path, { "--now-ms": String(T1) }));

    expect(code).toBe(0);
    expect(streams.err()).toBe("");
    expect(streams.out()).toBe(
      `closed ${RUN_ID} in ${path}: status created -> completed by ${ACTOR} ` +
        "under writer epoch 1\n",
    );

    // The claim in the printed line is checked against the file, not against
    // the command's own belief about it -- and on a handle this command did not
    // leave open.
    const reopened = openProductionControlPlane(path);
    onTestFinished(() => {
      reopened.close();
    });
    expect(runRow(reopened)["status"]).toBe("completed");
    expect(runRow(reopened)["updated_at_ms"]).toBe(T1);
    expect(eventCount(reopened)).toBe(2);
  });

  test("refuses an already closed run with one stderr line and exit 2", () => {
    const { connection, path } = admittedFixture();
    connection.close();
    const streams = captureStreams();

    const first = main(closeArgv(path, { "--now-ms": String(T1) }));
    const second = main(closeArgv(path, { "--now-ms": String(T2), "--outcome": "cancelled" }));

    expect(first).toBe(0);
    expect(second).toBe(2);
    expect(streams.err()).toMatch(/^error: run 'run-1' is already closed as 'completed'/);
    // Exactly one success line: the refusal printed nothing to stdout, so the
    // two invocations cannot be read as two closes.
    expect(streams.out().split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("refuses an outcome the parser does not list, before opening anything", () => {
    const { connection, path } = admittedFixture();
    connection.close();
    const streams = captureStreams();
    const usage: string[] = [];
    patchSeam(topLevelSeams, "err", (text: string) => {
      usage.push(text);
    });

    const code = main(closeArgv(path, { "--outcome": "running" }));

    // Exit 2 from the parser, not from the command: `running` is not a terminal
    // status, and `run close` is not a general `run set-status`.
    expect(code).toBe(2);
    expect(usage.join("")).toContain("--outcome");
    expect(streams.out()).toBe("");

    const reopened = openProductionControlPlane(path);
    onTestFinished(() => {
      reopened.close();
    });
    expect(runRow(reopened)["status"]).toBe("created");
  });

  test("reads the clock exactly once when --now-ms is omitted", () => {
    const { connection, path } = admittedFixture();
    connection.close();
    captureStreams();
    const clock = countedClock(T1);

    expect(main(closeArgv(path))).toBe(0);
    expect(clock.reads()).toBe(1);

    const reopened = openProductionControlPlane(path);
    onTestFinished(() => {
      reopened.close();
    });
    // One read, stamped on the row and used for both lease operations: two
    // reads would satisfy `updated_at_ms >= created_at_ms` by luck of ordering.
    expect(runRow(reopened)["updated_at_ms"]).toBe(T1);
  });

  test("refuses a database that is not at this build's head", () => {
    // The same standard `run admit` opens under: a close writes this build's
    // schema, and a file behind head would take the write into DDL that
    // predates it.
    const path = databasePath(caseRoot("run-close-not-a-plane"));
    const streams = captureStreams();

    expect(main(closeArgv(path, { "--now-ms": String(T1) }))).toBe(2);
    expect(streams.err()).toMatch(/^error: /);
    expect(streams.out()).toBe("");
  });

  test("is reachable from the top-level parser, and says what it does", () => {
    const strings = helpStrings(buildParser());
    expect(strings.some((text) => text.startsWith("Close a run:"))).toBe(true);
    expect(strings.some((text) => text.includes("appends no event"))).toBe(true);
  });

  test("every string it puts in --help is ASCII", () => {
    // `docs/cli-output-policy.md`: a cp932 console cannot encode an em-dash, and
    // `--help` is where these strings are read.
    for (const text of helpStrings(buildParser())) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is the range
      expect(text, `non-ASCII in ${JSON.stringify(text)}`).toMatch(/^[\x00-\x7f]*$/);
    }
  });
});
