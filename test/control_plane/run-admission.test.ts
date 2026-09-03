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
 * * **The row and both events are one fact, written once.** `D-0051`'s claim is
 *   atomicity: a run exists if and only if the spine says why. `D-0055` extends
 *   it: a run exists if and only if the spine also says what it was admitted to
 *   do. The cases that carry both are the ones that interrupt the block -- an
 *   abandoned outer transaction leaves none of the three -- because a suite
 *   that only ever watches the happy path cannot tell one transaction from
 *   three that all happened to succeed.
 * * **The lap's execution intent is recorded, and it is complete.**
 *   `run_delegation_recorded` is asserted as its own fact with its own identity
 *   and its own place in the append order, and its payload is asserted by
 *   EQUALITY rather than by containment: a durable work statement whose point
 *   is completeness has to fail when a field stops being persisted, and it has
 *   to fail just as loudly when one appears that nobody decided to put on the
 *   spine. `LapRunIntent`'s own field rules are `lap-run-intent.test.ts`'s
 *   subject and are deliberately not restated here.
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
import { join, resolve } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { helpStrings } from "../../src/cli/parser.js";
import { buildParser, main, cliSeams as topLevelSeams } from "../../src/cli.js";
import { appendEvent, EVENT_TYPES } from "../../src/control_plane/events.js";
import {
  LapRunIntent,
  type LapRunIntentFields,
  LapRunIntentUsageError,
  PAYLOAD_KEYS,
} from "../../src/control_plane/lap_run_intent.js";
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
  RUN_DELEGATION_RECORDED_EVENT_TYPE,
  RunAdmissionUsageError,
  RunAlreadyAdmitted,
  RunNotAdmitted,
  readLapRunIntent,
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

/** A run whose delegation payload this suite writes by hand. See `craftedRun`. */
const CRAFTED_RUN_ID = "run-crafted";

/**
 * The intent every case admits with, unless the intent is the case's subject.
 *
 * One shape for the whole file, overridden field by field, so that a case
 * asserting something about the run or the transaction is not also silently
 * asserting a particular workspace or prompt. `LapRunIntent`'s own field rules
 * are `lap-run-intent.test.ts`'s subject and are not restated here.
 *
 * The workspace is built with `resolve` rather than written down. `D-0003` puts
 * Windows on the merge path and the record requires an absolute path, and a
 * literal `/wt/run-1` is *not* absolute on `win32` -- so a written-down POSIX
 * path would make this whole file refuse on one of the two cells the double-
 * green rule runs it on.
 */
function intent(overrides: Partial<LapRunIntentFields> = {}): LapRunIntent {
  return new LapRunIntent({
    runId: RUN_ID,
    leaseClaimantId: "secretary-1",
    workspace: WORKSPACE,
    role: "worker",
    baseBranch: "main",
    topicBranch: "feat/run-1",
    prompt: "port the thing",
    ...overrides,
  });
}

/** The absolute workspace path the fixtures record, on whichever platform. */
const WORKSPACE = resolve("wt", "run-1");

/**
 * `continuo run admit`'s argv with every flag the record requires.
 *
 * A helper rather than a literal per case, and it is the flag *set* that is the
 * point: `run admit` now refuses unless all seven intent fields are given, so a
 * case that spelled its own argv would go red for a missing flag it never meant
 * to be about the day an eighth is added.
 */
function admitArgv(
  path: string,
  overrides: Readonly<Record<string, string>> = {},
): readonly string[] {
  const flags: Record<string, string> = {
    "--db": path,
    "--run-id": RUN_ID,
    "--lease-claimant-id": "secretary-1",
    "--workspace": WORKSPACE,
    "--role": "worker",
    "--base-branch": "main",
    "--topic-branch": "feat/run-1",
    "--prompt": "port the thing",
    ...overrides,
  };
  return ["run", "admit", ...Object.entries(flags).flat()];
}

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

/**
 * The `run_delegation_recorded` payload in the database at `path`, parsed.
 *
 * Opened fresh and closed, so a CLI case reads what the command left on disk
 * rather than what it believed it wrote -- and on a handle the command did not
 * leave open, which on Windows is the difference between a locked file and a
 * readable one.
 */
function delegationPayload(path: string): Record<string, unknown> {
  const connection = openProductionControlPlane(path);
  try {
    const row = connection
      .prepare("SELECT payload FROM event WHERE event_type = ? ")
      .get(RUN_DELEGATION_RECORDED_EVENT_TYPE) as { payload: string } | undefined;
    expect(row, `no ${RUN_DELEGATION_RECORDED_EVENT_TYPE} event in ${path}`).toBeDefined();
    return JSON.parse(String(row?.payload)) as Record<string, unknown>;
  } finally {
    connection.close();
  }
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

    const admitted = admitRun(connection, { intent: intent(), nowMs: T0 });

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

    const admitted = admitRun(connection, { intent: intent(), nowMs: T0 });

    const events = eventRows(connection);
    // Two: `run_created` and, after it, `run_delegation_recorded`. This case is
    // about the first; the delegation block above owns the second.
    expect(events).toHaveLength(2);
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

    admitRun(connection, { intent: intent({ runId: "run-a" }), nowMs: T0 });
    admitRun(connection, { intent: intent({ runId: "run-b" }), nowMs: T1 });

    expect(runRows(connection).map((row) => row["run_id"])).toEqual(["run-a", "run-b"]);
    // Each run's pair, in append order, with no interleaving: one admission is
    // one transaction, so run-b's events cannot land between run-a's.
    expect(eventRows(connection).map((row) => row["run_id"])).toEqual([
      "run-a",
      "run-a",
      "run-b",
      "run-b",
    ]);
  });

  test("appends with no consumer registered", () => {
    // Nothing subscribes to `run_created` on this lap (`D-0046` rule 2 leaves
    // the consumer for a later step), so the fan-out has nothing to fan out to.
    // Asserted rather than assumed: an append that required a subscriber would
    // make the whole command unusable until one existed, and the failure would
    // arrive as a foreign-key error rather than as anything readable.
    const { connection } = cpFixture();

    const admitted = admitRun(connection, { intent: intent(), nowMs: T0 });

    expect(admitted.eventSeq).toBeGreaterThan(0);
    expect(connection.prepare("SELECT COUNT(*) AS n FROM event_consumption").get()).toEqual({
      n: 0,
    });
    expect(connection.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 0 });
  });
});

// --------------------------------------------------------------------------
// the lap's execution intent
// --------------------------------------------------------------------------

describe("admitRun records the lap's execution intent alongside the run", () => {
  test("appends run_delegation_recorded after run_created, both about the run", () => {
    const { connection } = cpFixture();

    const admitted = admitRun(connection, { intent: intent(), nowMs: T0 });

    const events = eventRows(connection);
    expect(events).toHaveLength(2);
    // The order is the decision, not the observation. Both events carry the
    // same `nowMs`, so `seq` is the only thing that orders them and `seq` is
    // what a draining consumer sees: a run's first event must be the one that
    // says the run exists, or the intent arrives as a statement about a subject
    // the reader has no record of.
    expect(events.map((row) => row["event_type"])).toEqual([
      RUN_CREATED_EVENT_TYPE,
      RUN_DELEGATION_RECORDED_EVENT_TYPE,
    ]);
    expect(events[1]?.["seq"]).toBe(Number(events[0]?.["seq"]) + 1);

    const delegation = events[1];
    expect(delegation?.["seq"]).toBe(admitted.delegationEventSeq);
    expect(delegation?.["event_id"]).toBe(admitted.delegationEventId);
    // Pointed at the run in all three of the columns a per-run reader uses.
    // `subject_kind` is the DDL's closed set and `run` is already in it, so
    // this record needs no schema change -- asserted because a value outside
    // the set would fail as a CHECK from three frames down rather than here.
    expect(delegation?.["subject_kind"]).toBe("run");
    expect(delegation?.["subject_id"]).toBe(RUN_ID);
    expect(delegation?.["run_id"]).toBe(RUN_ID);
    expect(delegation?.["producer"]).toBe(RUN_ADMISSION_PRODUCER);
    // Lease-free like the admission it is part of: `D-0046` rule 4 gives run
    // creation no fence, and the intent is written by the same unfenced call.
    expect(delegation?.["producer_epoch"]).toBeNull();
    expect(delegation?.["occurred_at_ms"]).toBe(T0);
    expect(delegation?.["ingested_at_ms"]).toBe(T0);
    // Its own fact identity, distinct from `run_created`'s. Both are derived
    // from the run id, and a shared `dedup_key` would collide on
    // `event_one_row_per_fact` -- which is the spine refusing to hold two facts
    // under one identity, arriving as a duplicate rather than as a name clash.
    expect(delegation?.["event_id"]).toBe(`${RUN_DELEGATION_RECORDED_EVENT_TYPE}/${RUN_ID}`);
    expect(delegation?.["dedup_key"]).toBe(`${RUN_DELEGATION_RECORDED_EVENT_TYPE}/${RUN_ID}`);
    expect(delegation?.["event_id"]).not.toBe(events[0]?.["event_id"]);
  });

  test("the payload is every field of the record, and nothing else", () => {
    const { connection } = cpFixture();

    admitRun(connection, {
      intent: intent({
        leaseClaimantId: "secretary-7",
        role: "reviewer",
        baseBranch: "release/1.x",
        topicBranch: "fix/leak",
        prompt: "close the handle",
        cliArgs: ["--verbose"],
      }),
      nowMs: T0,
    });

    const payload = JSON.parse(String(eventRows(connection)[1]?.["payload"])) as Record<
      string,
      unknown
    >;
    // An equality rather than a set of `toContain`s: the point of a durable
    // work statement is that it is complete, so a field that stopped being
    // persisted has to fail here, and so does one that appeared without anyone
    // deciding it should be on the spine.
    expect(payload).toEqual({
      lease_claimant_id: "secretary-7",
      workspace: WORKSPACE,
      role: "reviewer",
      base_branch: "release/1.x",
      topic_branch: "fix/leak",
      prompt: "close the handle",
      cli_args: ["--verbose"],
    });
    // The run identifier is deliberately NOT in it. `run_created`'s payload
    // names no run either: `subject_id` and `run_id` are the columns the
    // per-run indexes are built on, and a copy in the payload would be a second
    // answer to which run an event is about.
    expect(Object.keys(payload)).not.toContain("run_id");
  });

  test("the payload is json.dumps text, sorted and ASCII-escaped", () => {
    // The payload column is a parity surface (`python_json.ts`): the
    // differential oracle compares stored TEXT, so two databases whose payloads
    // differ have diverged even where every assertion that parses them agrees.
    // A prompt in Japanese is the case that separates `json.dumps` from
    // `JSON.stringify` -- the first escapes every character from U+007F up,
    // the second emits it raw -- and this organization writes prompts in
    // Japanese. Constructed rather than typed, per `docs/cli-output-policy.md`:
    // this source file stays ASCII, the value at runtime does not.
    const { connection } = cpFixture();
    const prompt = String.fromCodePoint(0x65e5, 0x672c, 0x8a9e);

    admitRun(connection, { intent: intent({ prompt }), nowMs: T0 });

    const text = String(eventRows(connection)[1]?.["payload"]);
    expect(text).toContain('"prompt": "\\u65e5\\u672c\\u8a9e"');
    // Keys sorted, separators with their spaces, and the whole thing ASCII.
    expect(text.startsWith('{"base_branch": ')).toBe(true);
    expect(text).toMatch(/^[\x20-\x7e]*$/);
  });

  test("an intent with no cli args records an empty list, not an absent key", () => {
    // The record's own vocabulary for "no arguments", asserted because the two
    // shapes are not the same to a reader: an absent key is a producer that did
    // not write the field, and a reader cannot tell that from a worker that was
    // given none.
    const { connection } = cpFixture();

    admitRun(connection, { intent: intent(), nowMs: T0 });

    const payload = JSON.parse(String(eventRows(connection)[1]?.["payload"])) as Record<
      string,
      unknown
    >;
    expect(payload["cli_args"]).toEqual([]);
  });

  test("run_delegation_recorded is in the produced vocabulary", () => {
    // `EVENT_TYPES` is defined as the vocabulary this implementation produces,
    // so the entry and the producer arrive together -- `D-0051` rule 5 is
    // explicit that a type is registered when its producer is written and not
    // before. Without this the set could drift from the code by a rename in
    // either direction and nothing would say so.
    expect(EVENT_TYPES.has(RUN_DELEGATION_RECORDED_EVENT_TYPE)).toBe(true);
  });

  test("two runs record two independent intents", () => {
    const { connection } = cpFixture();

    admitRun(connection, {
      intent: intent({ runId: "run-a", prompt: "the first" }),
      nowMs: T0,
    });
    admitRun(connection, {
      intent: intent({ runId: "run-b", prompt: "the second" }),
      nowMs: T1,
    });

    const delegations = eventRows(connection).filter(
      (row) => row["event_type"] === RUN_DELEGATION_RECORDED_EVENT_TYPE,
    );
    expect(delegations.map((row) => row["run_id"])).toEqual(["run-a", "run-b"]);
    expect(
      delegations.map(
        (row) => (JSON.parse(String(row["payload"])) as Record<string, unknown>)["prompt"],
      ),
    ).toEqual(["the first", "the second"]);
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
        admitRun(tx, { intent: intent(), nowMs: T0 });
        throw new Error("the caller abandoned the transaction");
      });
    }).toThrow("the caller abandoned the transaction");

    expect(runRows(connection)).toEqual([]);
    expect(eventRows(connection)).toEqual([]);
  });

  test("a refused second admission writes nothing at all", () => {
    const { connection } = cpFixture();
    admitRun(connection, { intent: intent(), nowMs: T0 });
    const runsBefore = runRows(connection);
    const eventsBefore = eventRows(connection);

    expectRefusal(
      () => admitRun(connection, { intent: intent(), nowMs: T1 }),
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
    admitRun(connection, { intent: intent(), nowMs: T0 });

    const refusal = expectRefusal(
      () => admitRun(connection, { intent: intent(), nowMs: T1 }),
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
    admitRun(connection, { intent: intent(), nowMs: T0 });
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
      () => admitRun(connection, { intent: intent(), nowMs: T1 }),
      RunAlreadyAdmitted,
    );

    expect(refusal.message).toContain("'running'");
    expect(readRun(connection, RUN_ID)?.status).toBe("running");
    expect(eventRows(connection)).toHaveLength(2);
  });

  test("the refusal is in the ControlPlaneRefusal family", () => {
    // Not decoration: `run_cli.ts` catches that family and nothing narrower, so
    // a refusal outside it would reach the operator as a stack trace with the
    // message this class carefully writes buried above it.
    const { connection } = cpFixture();
    admitRun(connection, { intent: intent(), nowMs: T0 });

    const refusal = expectRefusal(
      () => admitRun(connection, { intent: intent(), nowMs: T1 }),
      RunAlreadyAdmitted,
    );
    expect(refusal.name).toBe("RunAlreadyAdmitted");
  });
});

// --------------------------------------------------------------------------
// malformed arguments
// --------------------------------------------------------------------------

describe("a malformed argument is refused before anything is written", () => {
  test("refuses an intent that is not a LapRunIntent", () => {
    // The one field check `admitRun` keeps for itself, and the reason it can
    // keep only one: `LapRunIntent` carries a private field, so an object
    // literal of the right shape does not satisfy the parameter and every
    // intent that gets this far went through the constructor. Asserted at
    // runtime as well as in the types, because a caller in plain JavaScript --
    // or one reaching through a cast -- has no type check at all.
    const { connection } = cpFixture();

    expectRefusal(
      () =>
        admitRun(connection, {
          intent: { runId: RUN_ID } as unknown as LapRunIntent,
          nowMs: T0,
        }),
      RunAdmissionUsageError,
      /intent must be a LapRunIntent/,
    );

    expect(runRows(connection)).toEqual([]);
    expect(eventRows(connection)).toEqual([]);
  });

  test("refuses a clock that is not an integer of epoch milliseconds", () => {
    const { connection } = cpFixture();

    expectRefusal(
      () => admitRun(connection, { intent: intent(), nowMs: T0 + 0.5 }),
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
      () => admitRun(connection, { intent: intent(), nowMs: T0 + 0.5 }),
      RunAdmissionUsageError,
    );
    expect(error).not.toBeInstanceOf(RunAlreadyAdmitted);
  });

  test("a malformed field reaches the operator through the mounted command", () => {
    const path = productionTemplate.copyInto(caseRoot("run-admit-control-char"));
    const streams = captureStreams();
    const usage: string[] = [];
    patchSeam(topLevelSeams, "err", (text: string) => {
      usage.push(text);
    });

    // A usage error is NOT in the ControlPlaneRefusal family, so it is not
    // flattened into one `error: ` line -- it escapes as a defect with its
    // stack, which is the distinction this module draws deliberately. `D-0051`
    // settled that placement for a malformed `--run-id` and `D-0055` keeps it
    // for the rest of the record, so the class here is the record's rather than
    // admission's. What matters is unchanged: nothing was printed as though the
    // run had been admitted.
    expect(() => main(admitArgv(path, { "--run-id": "run-1\nadmitted forged" }))).toThrow(
      LapRunIntentUsageError,
    );
    expect(streams.out()).toBe("");
  });

  test("nothing is opened when a field is malformed", () => {
    // The record is built before the database is opened, which is what makes
    // the case above cost no handle -- and on Windows an open handle is a
    // locked file. Driven through a path that does not exist: if the verb
    // opened first, the failure would be the migrator's "does not exist"
    // refusal rather than the record's, and the ordering would be silently
    // wrong.
    const path = databasePath(caseRoot("run-admit-field-before-open"));
    const streams = captureStreams();

    expect(() => main(admitArgv(path, { "--workspace": "wt/run-1" }))).toThrow(
      LapRunIntentUsageError,
    );
    expect(streams.out()).toBe("");
    expect(streams.err()).toBe("");
  });
});

// --------------------------------------------------------------------------
// the mounted command
// --------------------------------------------------------------------------

describe("continuo run admit", () => {
  test("admits a run end to end and reports what it wrote", () => {
    const path = productionTemplate.copyInto(caseRoot("run-admit-cli"));
    const streams = captureStreams();

    const code = main(admitArgv(path, { "--now-ms": String(T0) }));

    expect(code).toBe(0);
    expect(streams.err()).toBe("");
    // Both events on the one line, in append order and with their sequence
    // numbers: the report is where an operator sees that the work statement
    // landed with the run rather than after it.
    expect(streams.out()).toBe(
      `admitted ${RUN_ID} in ${path}: status created, ` +
        `run_created/${RUN_ID} at seq 1, ` +
        `run_delegation_recorded/${RUN_ID} at seq 2\n`,
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
    expect(eventRows(connection).map((row) => row["event_type"])).toEqual([
      RUN_CREATED_EVENT_TYPE,
      RUN_DELEGATION_RECORDED_EVENT_TYPE,
    ]);
  });

  test("refuses a second admission with one stderr line and exit 2", () => {
    const path = productionTemplate.copyInto(caseRoot("run-admit-twice"));
    const streams = captureStreams();

    const first = main(admitArgv(path, { "--now-ms": String(T0) }));
    const second = main(admitArgv(path, { "--now-ms": String(T1) }));

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
    expect(eventRows(connection)).toHaveLength(2);
  });

  test("reads the clock exactly once when --now-ms is omitted", () => {
    const path = productionTemplate.copyInto(caseRoot("run-admit-clock"));
    captureStreams();
    const clock = countedClock(T1);

    const code = main(admitArgv(path));

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
    // All four event stamps, not just the first event's: two appends from one
    // clock read is the property, and reading only `run_created` would pass
    // against a second append that called the clock again.
    for (const event of eventRows(connection)) {
      expect(event["occurred_at_ms"]).toBe(T1);
      expect(event["ingested_at_ms"]).toBe(T1);
    }
  });

  test("does not read the clock when --now-ms is given", () => {
    const path = productionTemplate.copyInto(caseRoot("run-admit-noclock"));
    captureStreams();
    const clock = countedClock(T1);

    expect(main(admitArgv(path, { "--now-ms": String(T0) }))).toBe(0);
    expect(clock.reads()).toBe(0);
  });

  test("refuses an absent database rather than creating one", () => {
    const path = databasePath(caseRoot("run-admit-absent"));
    const streams = captureStreams();

    const code = main(admitArgv(path, { "--now-ms": String(T0) }));

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

    const code = main(admitArgv(path, { "--now-ms": String(T0) }));

    expect(code).toBe(2);
    expect(streams.out()).toBe("");
    expect(streams.err()).toContain(`is at version ${HEAD - 1}`);
  });

  test.each([
    ["--run-id", "run_id"],
    ["--lease-claimant-id", "lease_claimant_id"],
    ["--workspace", "workspace"],
    ["--role", "role"],
    ["--base-branch", "base_branch"],
    ["--topic-branch", "topic_branch"],
    ["--prompt", "prompt"],
  ])("requires %s", (flag) => {
    // Every intent field is required, one case each. `D-0055`'s whole claim is
    // that admission fixes the WHOLE record, so a field the parser lets through
    // as absent is a record admission could complete without -- and the
    // resulting event would be a work statement missing the part nobody
    // noticed. Driven through the parser rather than the record because these
    // are two separate refusals: the parser's is a usage line and exit 2, and
    // reaching the record's constructor instead would mean the flag was
    // optional after all.
    const path = productionTemplate.copyInto(caseRoot(`run-admit-no${flag}`));
    const streams = captureStreams();
    // The parser's own usage line goes out through the TOP-LEVEL seam, not this
    // subtree's, so it is captured separately -- both to keep it off the
    // suite's real stderr and to say which of the two streams it came from.
    const usage: string[] = [];
    patchSeam(topLevelSeams, "err", (text: string) => {
      usage.push(text);
    });

    const argv = admitArgv(path, { "--now-ms": String(T0) }).filter(
      (token, index, tokens) => token !== flag && tokens[index - 1] !== flag,
    );

    // Exit 2 from the parser, not from the command: the argument is refused
    // before a database is opened at all.
    expect(main(argv)).toBe(2);
    expect(usage.join("")).toContain(`the following arguments are required: ${flag}`);
    expect(streams.out()).toBe("");
    expect(streams.err()).toBe("");
  });

  test("takes --cli-arg any number of times, in order, and none by default", () => {
    // `action="append"` leaves the namespace key absent when the flag never
    // appears, which is a different shape from an empty list -- so both are
    // driven, and both must reach the payload as `[]` and as the two arguments
    // in the order they were typed. Order is asserted because argv order IS the
    // meaning of an argument list: a set here would be a different record.
    //
    // Written in the `--cli-arg=VALUE` form, and that is the interesting part
    // rather than a detail. The values a worker's CLI takes mostly begin with a
    // dash, and argparse -- which `cli/parser.ts` reproduces -- refuses to
    // consume a following token that looks like an option, so
    // `--cli-arg --verbose` is a usage error and not a passed-through argument.
    // The `=` form is the escape, it is argparse's own, and pinning it here is
    // what stops the first operator to pass a flag through from concluding the
    // option is broken.
    const withNone = productionTemplate.copyInto(caseRoot("run-admit-noargs"));
    const withSome = productionTemplate.copyInto(caseRoot("run-admit-args"));
    captureStreams();

    expect(main(admitArgv(withNone, { "--now-ms": String(T0) }))).toBe(0);
    expect(
      main([
        ...admitArgv(withSome, { "--now-ms": String(T0) }),
        "--cli-arg=--verbose",
        "--cli-arg=--model=sonnet",
      ]),
    ).toBe(0);

    expect(delegationPayload(withNone)["cli_args"]).toEqual([]);
    expect(delegationPayload(withSome)["cli_args"]).toEqual(["--verbose", "--model=sonnet"]);
  });

  test("is reachable from the top-level parser, and says what it does", () => {
    const strings = helpStrings(buildParser());
    expect(strings.some((text) => text.startsWith("Admit a run:"))).toBe(true);
    expect(strings.some((text) => text.includes("run_created event"))).toBe(true);
    expect(strings.some((text) => text.includes("run_delegation_recorded event"))).toBe(true);
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

describe("reading the delegation record back (D-0063)", () => {
  /** Admit one run through the real writer, and hand back its plane. */
  function admitted(cliArgs: readonly string[] = ["--verbose"]): {
    connection: SqliteDatabase;
    intent: LapRunIntent;
  } {
    const { connection } = cpFixture();
    const intent = new LapRunIntent({
      runId: RUN_ID,
      leaseClaimantId: "operator-1",
      workspace: WORKSPACE,
      role: "worker",
      baseBranch: "main",
      topicBranch: "feat/topic",
      prompt: "port the thing",
      cliArgs,
    });
    admitRun(connection, { intent, nowMs: T0 });
    return { connection, intent };
  }

  /** The well-formed payload, as an object a case can take a key out of. */
  function wellFormedPayload(): Record<string, unknown> {
    return JSON.parse(
      new LapRunIntent({
        runId: CRAFTED_RUN_ID,
        leaseClaimantId: "operator-1",
        workspace: WORKSPACE,
        role: "worker",
        baseBranch: "main",
        topicBranch: "feat/topic",
        prompt: "port the thing",
        cliArgs: ["--verbose"],
      }).payload,
    ) as Record<string, unknown>;
  }

  /**
   * A run whose delegation payload is `payload`, verbatim.
   *
   * **Appended, not overwritten.** The spine is append-only by trigger -- an
   * `UPDATE` raises "the event spine is append-only; correct a fact with a new
   * event" -- so a case reaching for one would be testing against a database
   * shape the schema forbids. Appending is also the truer model of the hazard:
   * a payload this build did not write is one some *other* producer wrote,
   * which is exactly what an older or newer record is.
   *
   * The `run` row is inserted directly rather than through `admitRun`, because
   * `admitRun` would append the well-formed payload this helper exists to
   * replace. Run creation carries no fence (`D-0046` rule 4), so this is a
   * write the schema admits.
   */
  function craftedRun(payload: string): SqliteDatabase {
    const { connection } = cpFixture();
    transaction(connection, (tx) => {
      tx.prepare(
        "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms)" +
          " VALUES (:run_id, :status, :now, :now)",
      ).run({ run_id: CRAFTED_RUN_ID, status: ADMITTED_RUN_STATUS, now: T0 });
      const id = `${RUN_DELEGATION_RECORDED_EVENT_TYPE}/${CRAFTED_RUN_ID}`;
      appendEvent(tx, {
        eventId: id,
        eventType: RUN_DELEGATION_RECORDED_EVENT_TYPE,
        subjectKind: "run",
        subjectId: CRAFTED_RUN_ID,
        dedupKey: id,
        producer: RUN_ADMISSION_PRODUCER,
        occurredAtMs: T0,
        ingestedAtMs: T0,
        runId: CRAFTED_RUN_ID,
        payload,
      });
    });
    return connection;
  }

  test("the round trip returns what admission fixed", () => {
    // The anti-vacuity half, and the reason the reader exists at all: `D-0055`
    // fixed the execution intent at admission so a later process could act on
    // it, and until this function there was no way to read it back.
    const { connection, intent } = admitted(["--verbose", "--model=sonnet"]);
    const read = readLapRunIntent(connection, RUN_ID);

    expect(read).toBeInstanceOf(LapRunIntent);
    expect(read.runId).toBe(intent.runId);
    expect(read.leaseClaimantId).toBe(intent.leaseClaimantId);
    expect(read.workspace).toBe(intent.workspace);
    expect(read.role).toBe(intent.role);
    expect(read.baseBranch).toBe(intent.baseBranch);
    expect(read.topicBranch).toBe(intent.topicBranch);
    expect(read.prompt).toBe(intent.prompt);
    expect(read.cliArgs).toEqual(["--verbose", "--model=sonnet"]);
    // The payload it would write again is the payload it was read from, which
    // is the strongest statement of the round trip available without comparing
    // field by field a second time.
    expect(read.payload).toBe(intent.payload);
  });

  test("a run that was never admitted is refused, not answered", () => {
    const { connection } = cpFixture();
    expectRefusal(
      () => readLapRunIntent(connection, "no-such-run"),
      RunNotAdmitted,
      /has no run_delegation_recorded event/,
    );
  });

  test("an absent cli_args is refused rather than read as no arguments", () => {
    // The one field whose absence the record's own constructor absorbs: every
    // other field is required, so an absent one arrives as `undefined` and is
    // refused -- but an omitted `cliArgs` means "no arguments" to a CALLER. To a
    // READER it cannot mean that, because the writer always emits the key. So
    // absorbing it would run the worker without arguments the durable record
    // required, silently, off a payload this build did not write.
    const payload = wellFormedPayload();
    delete payload["cli_args"];
    const connection = craftedRun(JSON.stringify(payload));

    const refusal = expectRefusal(
      () => readLapRunIntent(connection, CRAFTED_RUN_ID),
      RunNotAdmitted,
      /is missing cli_args/,
    );
    // Quoted, not interpolated raw: this path names a value nothing validated.
    expect(refusal.message).toContain(`'${CRAFTED_RUN_ID}'`);
  });

  test("every other absent key is refused too, and named", () => {
    // Driven off the record's own key list rather than a copy of it, so a field
    // added to `LapRunIntent` without being added to the reader's check fails
    // here instead of being silently tolerated.
    for (const key of Object.values(PAYLOAD_KEYS)) {
      const payload = wellFormedPayload();
      delete payload[key];
      const connection = craftedRun(JSON.stringify(payload));

      const refusal = expectRefusal(
        () => readLapRunIntent(connection, CRAFTED_RUN_ID),
        RunNotAdmitted,
        /delegation payload is missing/,
      );
      expect(refusal.message, `the refusal does not name ${key}`).toContain(key);
    }
  });

  test("a payload that is not a JSON object is refused", () => {
    const connection = craftedRun(JSON.stringify([1, 2, 3]));
    expectRefusal(
      () => readLapRunIntent(connection, CRAFTED_RUN_ID),
      RunNotAdmitted,
      /not a JSON object/,
    );
  });

  test("a present-but-malformed field is refused by the record's own rules", () => {
    // The reader states no field rules of its own: the constructor is the
    // validation. This is the case that says the round trip is therefore also a
    // check rather than a cast wearing a type.
    const payload = wellFormedPayload();
    payload["workspace"] = "not-absolute";
    const connection = craftedRun(JSON.stringify(payload));
    expectRefusal(
      () => readLapRunIntent(connection, CRAFTED_RUN_ID),
      RunNotAdmitted,
      /not a valid execution intent/,
    );
  });
});
