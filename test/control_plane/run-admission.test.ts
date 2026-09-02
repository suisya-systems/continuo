/**
 * `continuo run admit`: the only writer that brings a `run` row into existence,
 * and the `run_created` event it appends alongside it.
 *
 * **Target-only.** Interlock has no counterpart: it mounts no `run` subtree and
 * has no admission writer at all -- its run rows are written by whichever test
 * needs one. So there is no source node id to port and no parity ledger claims
 * this file; the only ledger it touches is
 * `parity/gate_item11.no-provider-detail-leaks.ledger.json`, whose directory
 * walk picks it up like every other file under `test/control_plane/`. Rule 10 of
 * `docs/test-translation-conventions.md` applies: each case names what would be
 * silently wrong without it.
 *
 * What these cases are for, in the order they appear:
 *
 * * **The row and the event are one fact, written once.** `D-0051`'s whole
 *   claim is atomicity: a run exists if and only if the spine says why. The
 *   cases that carry it are the ones that interrupt the block -- an abandoned
 *   outer transaction leaves neither -- because a suite that only ever watches
 *   the happy path cannot tell one transaction from two that both happened to
 *   succeed.
 * * **A second admission is refused, not absorbed.** The spine underneath
 *   treats a re-appended fact as an idempotent no-op, so "refused" here is a
 *   deliberate difference from it rather than the default, and what is asserted
 *   is that the refusal costs the database nothing: same row, same status, same
 *   one event.
 * * **Admission ends at `created`.** `D-0046` rule 1 gives every later status to
 *   `advanceRunStatus`, and the way to evade a single-writer rule is to start
 *   past it, so the status the insert lands at is asserted directly.
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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { helpStrings } from "../../src/cli/parser.js";
import { buildParser, main, cliSeams as topLevelSeams } from "../../src/cli.js";
import { EVENT_TYPES } from "../../src/control_plane/events.js";
import {
  createProductionControlPlane,
  headVersion,
  MIGRATIONS_DIR,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import {
  ADMITTED_RUN_STATUS,
  admitRun,
  RUN_ADMISSION_PRODUCER,
  RUN_CREATED_EVENT_TYPE,
  RunAdmissionUsageError,
  RunAlreadyAdmitted,
} from "../../src/control_plane/run_admission.js";
import { runCliSeams } from "../../src/control_plane/run_cli.js";
import {
  acquireRunLease,
  advanceRunStatus,
  readRun,
} from "../../src/control_plane/run_lifecycle.js";
import { transaction } from "../../src/control_plane/txn.js";
import { caseRoot, databasePath, suiteTemplate, writeStep } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant, and a later one. */
const T0 = 1_700_000_000_000;
const T1 = T0 + 60_000;
const RUN_ID = "run-1";

/** This build's head, read rather than written down. */
const HEAD = headVersion();

const productionTemplate = suiteTemplate("run-admission.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/** A migrated production control plane at head, with no rows of its own. */
function cpFixture(): { connection: SqliteDatabase; path: string } {
  const path = productionTemplate.copyInto(caseRoot("run-admission"));
  const connection = openProductionControlPlane(path);
  onTestFinished(() => {
    connection.close();
  });
  return { connection, path };
}

/** The `run` rows, as the database holds them. */
function runRows(connection: SqliteDatabase): Record<string, unknown>[] {
  return connection.prepare("SELECT * FROM run ORDER BY run_id").all() as Record<string, unknown>[];
}

/** The `event` rows, as the database holds them. */
function eventRows(connection: SqliteDatabase): Record<string, unknown>[] {
  return connection.prepare("SELECT * FROM event ORDER BY seq").all() as Record<string, unknown>[];
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

/**
 * A production database holding only the first `count` of this build's steps.
 *
 * Built the way `db-cli.test.ts` builds one, and for the same reason: byte-
 * identical copies of the real step files, so the ledger's checksums are the
 * ones this build computes and the database is refused for being *behind*
 * rather than for being edited.
 */
function databaseBehindHead(root: string, count: number): string {
  const prefix = join(root, `at-000${count}`);
  const names = [
    "0001_initial.sql",
    "0002_policy_seed.sql",
    "0003_outbox_cancelled_status.sql",
    "0004_run_writer_epoch.sql",
  ];
  for (const name of names.slice(0, count)) {
    writeStep(prefix, name, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
  const path = databasePath(root);
  createProductionControlPlane(path, { nowMs: T0, migrationsDir: prefix }).close();
  return path;
}

// --------------------------------------------------------------------------
// the row and its event
// --------------------------------------------------------------------------

describe("admitRun writes the run and its admission event", () => {
  test("inserts the run at 'created' with one caller-supplied clock", () => {
    const { connection } = cpFixture();

    const admitted = admitRun(connection, { runId: RUN_ID, nowMs: T0 });

    expect(admitted.runId).toBe(RUN_ID);
    expect(admitted.status).toBe(ADMITTED_RUN_STATUS);
    expect(admitted.createdAtMs).toBe(T0);

    const rows = runRows(connection);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["run_id"]).toBe(RUN_ID);
    expect(rows[0]?.["status"]).toBe("created");
    // Both stamps from the one clock read. The DDL requires
    // `updated_at_ms >= created_at_ms`, and two clock reads would satisfy it by
    // luck of ordering rather than by construction -- equality is what says the
    // value came from one read.
    expect(rows[0]?.["created_at_ms"]).toBe(T0);
    expect(rows[0]?.["updated_at_ms"]).toBe(T0);
    // Lease-free by D-0046 rule 4: creation is assigned no fence, so nothing
    // stamps the column the transition writer stamps.
    expect(rows[0]?.["writer_epoch"]).toBeNull();
  });

  test("appends exactly one run_created event, pointed at the run it created", () => {
    const { connection } = cpFixture();

    const admitted = admitRun(connection, { runId: RUN_ID, nowMs: T0 });

    const events = eventRows(connection);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.["seq"]).toBe(admitted.eventSeq);
    expect(event?.["event_id"]).toBe(admitted.eventId);
    expect(event?.["event_type"]).toBe(RUN_CREATED_EVENT_TYPE);
    // `run` is the subject kind the DDL's closed set holds for this, and the
    // run_id column is the foreign key onto the row above -- asserted because
    // an event that named the run only in its payload would be invisible to
    // `event_by_run`, which is the index every per-run reader uses.
    expect(event?.["subject_kind"]).toBe("run");
    expect(event?.["subject_id"]).toBe(RUN_ID);
    expect(event?.["run_id"]).toBe(RUN_ID);
    expect(event?.["producer"]).toBe(RUN_ADMISSION_PRODUCER);
    expect(event?.["producer_epoch"]).toBeNull();
    expect(event?.["occurred_at_ms"]).toBe(T0);
    expect(event?.["ingested_at_ms"]).toBe(T0);
    expect(event?.["payload"]).toBe('{"status": "created"}');
    // The fact's identity is the run's, in both columns the spine uniques on.
    expect(event?.["event_id"]).toBe(`${RUN_CREATED_EVENT_TYPE}/${RUN_ID}`);
    expect(event?.["dedup_key"]).toBe(`${RUN_CREATED_EVENT_TYPE}/${RUN_ID}`);
  });

  test("run_created is in the produced vocabulary", () => {
    // `EVENT_TYPES` is defined as the vocabulary this implementation produces,
    // so the entry and the producer arrive together. Without this the set could
    // drift from the code by a rename in either direction and nothing would
    // say so.
    expect(EVENT_TYPES.has(RUN_CREATED_EVENT_TYPE)).toBe(true);
  });

  test("admits several runs independently", () => {
    const { connection } = cpFixture();

    admitRun(connection, { runId: "run-a", nowMs: T0 });
    admitRun(connection, { runId: "run-b", nowMs: T1 });

    expect(runRows(connection).map((row) => row["run_id"])).toEqual(["run-a", "run-b"]);
    expect(eventRows(connection).map((row) => row["run_id"])).toEqual(["run-a", "run-b"]);
  });

  test("appends with no consumer registered", () => {
    // Nothing subscribes to `run_created` on this lap (`D-0046` rule 2 leaves
    // the consumer for a later step), so the fan-out has nothing to fan out to.
    // Asserted rather than assumed: an append that required a subscriber would
    // make the whole command unusable until one existed, and the failure would
    // arrive as a foreign-key error rather than as anything readable.
    const { connection } = cpFixture();

    const admitted = admitRun(connection, { runId: RUN_ID, nowMs: T0 });

    expect(admitted.eventSeq).toBeGreaterThan(0);
    expect(connection.prepare("SELECT COUNT(*) AS n FROM event_consumption").get()).toEqual({
      n: 0,
    });
    expect(connection.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 0 });
  });
});

// --------------------------------------------------------------------------
// one transaction
// --------------------------------------------------------------------------

describe("the row and the event commit together or not at all", () => {
  test("an outer transaction that fails afterwards leaves neither", () => {
    // The property `D-0051` is built on, and the only case that can distinguish
    // one transaction from two that both happened to succeed. `admitRun` takes
    // its own block, and `txn.ts` JOINS that block to an outer one rather than
    // nesting it -- so an outer failure must take the run row AND its event
    // down together. If admission committed on its own, the run below would
    // survive the throw with no admission event that any consumer could read.
    const { connection } = cpFixture();

    expect(() => {
      transaction(connection, (tx) => {
        admitRun(tx, { runId: RUN_ID, nowMs: T0 });
        throw new Error("the caller abandoned the transaction");
      });
    }).toThrow("the caller abandoned the transaction");

    expect(runRows(connection)).toEqual([]);
    expect(eventRows(connection)).toEqual([]);
  });

  test("a refused second admission writes nothing at all", () => {
    const { connection } = cpFixture();
    admitRun(connection, { runId: RUN_ID, nowMs: T0 });
    const runsBefore = runRows(connection);
    const eventsBefore = eventRows(connection);

    expectRefusal(
      () => admitRun(connection, { runId: RUN_ID, nowMs: T1 }),
      RunAlreadyAdmitted,
      /already admitted/,
    );

    // Both tables, not just the one the refusal is about: the run row is
    // checked before the insert, so a refusal that had already appended an
    // event would leave a second `run_created` on the spine for one run.
    expect(runRows(connection)).toEqual(runsBefore);
    expect(eventRows(connection)).toEqual(eventsBefore);
  });
});

// --------------------------------------------------------------------------
// a second admission is refused
// --------------------------------------------------------------------------

describe("a run identifier is admitted once", () => {
  test("refuses a re-admission and names the status the run is at", () => {
    const { connection } = cpFixture();
    admitRun(connection, { runId: RUN_ID, nowMs: T0 });

    const refusal = expectRefusal(
      () => admitRun(connection, { runId: RUN_ID, nowMs: T1 }),
      RunAlreadyAdmitted,
    );

    expect(refusal.message).toContain(RUN_ID);
    expect(refusal.message).toContain("'created'");
  });

  test("refuses a run that has since moved on, reporting where it got to", () => {
    // The re-admission an operator is most likely to type by mistake: the run
    // is already working, and re-admitting it would either fail on the primary
    // key or -- if creation were ever made idempotent -- quietly walk it back
    // to `created`. The status in the message is what tells the operator which
    // run they actually found.
    const { connection } = cpFixture();
    admitRun(connection, { runId: RUN_ID, nowMs: T0 });
    const lease = acquireRunLease(connection, {
      runId: RUN_ID,
      holder: "secretary-1",
      nowMs: T0,
      ttlMs: 30_000,
    });
    advanceRunStatus(connection, lease, {
      runId: RUN_ID,
      from: "created",
      to: "running",
      // Inside the lease's TTL: the transition is a precondition of this case,
      // not its subject, so it must not be the thing that fails.
      nowMs: T0 + 1,
    });

    const refusal = expectRefusal(
      () => admitRun(connection, { runId: RUN_ID, nowMs: T1 }),
      RunAlreadyAdmitted,
    );

    expect(refusal.message).toContain("'running'");
    expect(readRun(connection, RUN_ID)?.status).toBe("running");
    expect(eventRows(connection)).toHaveLength(1);
  });

  test("the refusal is in the ControlPlaneRefusal family", () => {
    // Not decoration: `run_cli.ts` catches that family and nothing narrower, so
    // a refusal outside it would reach the operator as a stack trace with the
    // message this class carefully writes buried above it.
    const { connection } = cpFixture();
    admitRun(connection, { runId: RUN_ID, nowMs: T0 });

    const refusal = expectRefusal(
      () => admitRun(connection, { runId: RUN_ID, nowMs: T1 }),
      RunAlreadyAdmitted,
    );
    expect(refusal.name).toBe("RunAlreadyAdmitted");
  });
});

// --------------------------------------------------------------------------
// malformed arguments
// --------------------------------------------------------------------------

describe("a malformed argument is refused before anything is written", () => {
  test.each([
    ["an empty run id", "", "run_id must be a non-empty string"],
    ["a blank run id", "   ", "run_id must be a non-empty string"],
  ])("refuses %s", (_label, runId, message) => {
    const { connection } = cpFixture();

    expectRefusal(
      () => admitRun(connection, { runId, nowMs: T0 }),
      RunAdmissionUsageError,
      message,
    );

    expect(runRows(connection)).toEqual([]);
    expect(eventRows(connection)).toEqual([]);
  });

  test.each([
    ["a newline", "run-1\nerror: forged"],
    ["a carriage return", "run-1\rerror: forged"],
    ["an escape sequence", "run-\u001b[31m1"],
    ["a zero-width joiner", "run-\u200d1"],
    // Non-ASCII is refused for the second reason the rule states: a cp932
    // console cannot encode it, and `D-0003` puts Windows on the merge path.
    // Constructed rather than typed, per `docs/cli-output-policy.md` -- this
    // source file stays ASCII, the value at runtime does not.
    ["an emoji", `run-${String.fromCodePoint(0x1f600)}`],
    ["a Japanese character", `run-${String.fromCodePoint(0x3042)}`],
  ])("refuses a run id carrying %s", (_label, runId) => {
    // The identifier is quoted verbatim into the one-line report and into the
    // re-admission refusal, both of which end at a single newline. A newline
    // inside the identifier makes the command appear to print a second line --
    // `error: ` included -- and a character the console cannot encode makes it
    // print none at all. Refusing here is what keeps the row, the event and the
    // report all quoting the same string.
    const { connection } = cpFixture();

    expectRefusal(
      () => admitRun(connection, { runId, nowMs: T0 }),
      RunAdmissionUsageError,
      /must be printable ASCII/,
    );

    expect(runRows(connection)).toEqual([]);
    expect(eventRows(connection)).toEqual([]);
  });

  test("the refusal reaches the operator through the mounted command", () => {
    const path = productionTemplate.copyInto(caseRoot("run-admit-control-char"));
    const streams = captureStreams();
    const usage: string[] = [];
    patchSeam(topLevelSeams, "err", (text: string) => {
      usage.push(text);
    });

    // A usage error is NOT in the ControlPlaneRefusal family, so it is not
    // flattened into one `error: ` line -- it escapes as a defect with its
    // stack, which is the distinction this module draws deliberately. What
    // matters here is that nothing was printed as though the run had been
    // admitted.
    expect(() =>
      main([
        "run",
        "admit",
        "--db",
        path,
        "--run-id",
        "run-1\nadmitted forged",
        "--now-ms",
        String(T0),
      ]),
    ).toThrow(RunAdmissionUsageError);
    expect(streams.out()).toBe("");
  });

  test("refuses a clock that is not an integer of epoch milliseconds", () => {
    const { connection } = cpFixture();

    expectRefusal(
      () => admitRun(connection, { runId: RUN_ID, nowMs: T0 + 0.5 }),
      RunAdmissionUsageError,
      /now_ms must be an int/,
    );

    expect(runRows(connection)).toEqual([]);
  });

  test("a usage error is not a ControlPlaneRefusal", () => {
    // The distinction `events.ts` draws for `EventSpineUsageError`, asserted
    // here because the CLI's catch depends on it: a caller defect must keep its
    // stack rather than being flattened into one operator-facing line.
    const { connection } = cpFixture();

    const error = expectRefusal(
      () => admitRun(connection, { runId: "", nowMs: T0 }),
      RunAdmissionUsageError,
    );
    expect(error).not.toBeInstanceOf(RunAlreadyAdmitted);
  });
});

// --------------------------------------------------------------------------
// the mounted command
// --------------------------------------------------------------------------

describe("continuo run admit", () => {
  test("admits a run end to end and reports what it wrote", () => {
    const path = productionTemplate.copyInto(caseRoot("run-admit-cli"));
    const streams = captureStreams();

    const code = main(["run", "admit", "--db", path, "--run-id", RUN_ID, "--now-ms", String(T0)]);

    expect(code).toBe(0);
    expect(streams.err()).toBe("");
    expect(streams.out()).toBe(
      `admitted ${RUN_ID} in ${path}: status created, run_created/${RUN_ID} at seq 1\n`,
    );

    // The claim in the printed line is checked against the file, not against
    // the command's own belief about it -- and on a handle this command did not
    // leave open.
    const connection = openProductionControlPlane(path);
    onTestFinished(() => {
      connection.close();
    });
    expect(runRows(connection)).toHaveLength(1);
    expect(runRows(connection)[0]?.["status"]).toBe("created");
    expect(eventRows(connection)).toHaveLength(1);
    expect(eventRows(connection)[0]?.["event_type"]).toBe(RUN_CREATED_EVENT_TYPE);
  });

  test("refuses a second admission with one stderr line and exit 2", () => {
    const path = productionTemplate.copyInto(caseRoot("run-admit-twice"));
    const streams = captureStreams();

    const first = main(["run", "admit", "--db", path, "--run-id", RUN_ID, "--now-ms", String(T0)]);
    const second = main(["run", "admit", "--db", path, "--run-id", RUN_ID, "--now-ms", String(T1)]);

    expect(first).toBe(0);
    expect(second).toBe(2);
    expect(streams.err()).toMatch(/^error: run run-1 was already admitted/);
    // Exactly one success line: the refusal printed nothing to stdout, so the
    // two runs cannot be confused for two admissions.
    expect(streams.out().split("\n").filter(Boolean)).toHaveLength(1);

    const connection = openProductionControlPlane(path);
    onTestFinished(() => {
      connection.close();
    });
    expect(runRows(connection)).toHaveLength(1);
    expect(eventRows(connection)).toHaveLength(1);
  });

  test("reads the clock exactly once when --now-ms is omitted", () => {
    const path = productionTemplate.copyInto(caseRoot("run-admit-clock"));
    captureStreams();
    const clock = countedClock(T1);

    const code = main(["run", "admit", "--db", path, "--run-id", RUN_ID]);

    expect(code).toBe(0);
    expect(clock.reads()).toBe(1);

    const connection = openProductionControlPlane(path);
    onTestFinished(() => {
      connection.close();
    });
    const row = runRows(connection)[0];
    // One read reaching all four stamps, which is what `updated_at_ms >=
    // created_at_ms` rests on.
    expect(row?.["created_at_ms"]).toBe(T1);
    expect(row?.["updated_at_ms"]).toBe(T1);
    expect(eventRows(connection)[0]?.["occurred_at_ms"]).toBe(T1);
    expect(eventRows(connection)[0]?.["ingested_at_ms"]).toBe(T1);
  });

  test("does not read the clock when --now-ms is given", () => {
    const path = productionTemplate.copyInto(caseRoot("run-admit-noclock"));
    captureStreams();
    const clock = countedClock(T1);

    expect(main(["run", "admit", "--db", path, "--run-id", RUN_ID, "--now-ms", String(T0)])).toBe(
      0,
    );
    expect(clock.reads()).toBe(0);
  });

  test("refuses an absent database rather than creating one", () => {
    const path = databasePath(caseRoot("run-admit-absent"));
    const streams = captureStreams();

    const code = main(["run", "admit", "--db", path, "--run-id", RUN_ID, "--now-ms", String(T0)]);

    expect(code).toBe(2);
    expect(streams.out()).toBe("");
    expect(streams.err()).toContain("does not exist");
  });

  test("refuses a database behind this build rather than migrating it", () => {
    // The half of `openProductionControlPlane` that a change of entry point
    // would drop silently. Admission writes rows whose shape is this build's
    // schema, so a database that is behind must be refused here and not
    // discovered later as a constraint nobody can place.
    const root = caseRoot("run-admit-behind");
    const path = databaseBehindHead(root, HEAD - 1);
    const streams = captureStreams();

    const code = main(["run", "admit", "--db", path, "--run-id", RUN_ID, "--now-ms", String(T0)]);

    expect(code).toBe(2);
    expect(streams.out()).toBe("");
    expect(streams.err()).toContain(`is at version ${HEAD - 1}`);
  });

  test("requires --run-id", () => {
    const path = productionTemplate.copyInto(caseRoot("run-admit-norunid"));
    const streams = captureStreams();
    // The parser's own usage line goes out through the TOP-LEVEL seam, not this
    // subtree's, so it is captured separately -- both to keep it off the
    // suite's real stderr and to say which of the two streams it came from.
    const usage: string[] = [];
    patchSeam(topLevelSeams, "err", (text: string) => {
      usage.push(text);
    });

    // Exit 2 from the parser, not from the command: the argument is refused
    // before a database is opened at all.
    expect(main(["run", "admit", "--db", path, "--now-ms", String(T0)])).toBe(2);
    expect(usage.join("")).toContain("the following arguments are required: --run-id");
    expect(streams.out()).toBe("");
    expect(streams.err()).toBe("");
  });

  test("is reachable from the top-level parser, and says what it does", () => {
    const strings = helpStrings(buildParser());
    expect(strings.some((text) => text.startsWith("Admit a run:"))).toBe(true);
    expect(strings.some((text) => text.includes("run_created event"))).toBe(true);
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
