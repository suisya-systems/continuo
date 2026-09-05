/**
 * `continuo run show`: the read verb a console draws a run pane from, and the
 * read surface `D-0096` puts in place of a second reader of the database.
 *
 * **Target-only.** Interlock mounts no `run` subtree and has no read verb, so
 * there is no source node id to port and no parity ledger claims this file; the
 * only ledger it touches is
 * `parity/gate_item11.no-provider-detail-leaks.ledger.json`, whose directory
 * walk picks it up like every other file under `test/control_plane/`. Rule 10
 * of `docs/test-translation-conventions.md` applies: each case names what would
 * be silently wrong without it.
 *
 * What these cases are for, in the order they appear:
 *
 * * **The document's exact shape, twice.** Once over a run that has only been
 *   admitted -- the state every lap-1 run starts in, and the one where the
 *   empty lists and the absent lease are load-bearing -- and once over a run
 *   carrying one of everything. A host pins a shape by its schema id, so an
 *   extra key is as much a change to the contract as a missing one, and both
 *   cases assert the whole object rather than sampling it.
 * * **An unknown run is refused, not answered empty.** This is the case
 *   `D-0096` turns on: an empty document for a mistyped identifier cannot be
 *   told from a real run that has done nothing yet, so a console would render
 *   "idle" for a run that does not exist.
 * * **The verb writes nothing.** Asserted against the database's own bytes,
 *   not against the absence of an exception: a read verb that took a lease, or
 *   left a journal, or bumped an epoch would still return the right document.
 * * **The verb reads no clock.** The seam is replaced with one that throws, so
 *   "reads no clock" is a fact the suite would fail over rather than a sentence
 *   in a doc comment.
 * * **`--json`'s anti-vacuity set**, to `D-0090`'s standard: the flag is
 *   actually read, the document is built from the rows rather than from
 *   literals, the refusal path reads the flag too, and the checks that assert
 *   "no document" cannot pass because the verb printed nothing at all.
 *
 * Every timestamp is {@link T0} and arithmetic on it, never a clock, for the
 * reason `run-close.test.ts` gives: a suite whose expectations move with the
 * wall clock cannot assert what a caller-supplied clock wrote.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { main } from "../../src/cli.js";
import { openGate } from "../../src/control_plane/gates.js";
import { LapRunIntent } from "../../src/control_plane/lap_run_intent.js";
import { readLease } from "../../src/control_plane/lease.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { admitRun } from "../../src/control_plane/run_admission.js";
import { runCliSeams } from "../../src/control_plane/run_cli.js";
import { acquireRunLease, runLeaseResource } from "../../src/control_plane/run_lifecycle.js";
import { runView } from "../../src/control_plane/run_view.js";
import { prepareBinding } from "../../src/control_plane/session_binding.js";
import { presentGate } from "../../src/gate/operator.js";
import { caseRoot, suiteTemplate } from "../testkit/cases.js";
import { patchSeam } from "../testkit/seams.js";

/** An arbitrary fixed epoch-milliseconds instant, and later ones. */
const T0 = 1_700_000_000_000;
const T1 = T0 + 60_000;
const T2 = T1 + 60_000;
const RUN_ID = "run-1";
const GATE_ID = "gate-1";
const SESSION_ID = "11111111-1111-5111-8111-111111111111";
const TTL_MS = 300_000;

/** The pinned identifier of `run show`'s document shape. */
const SHOW_SCHEMA = "continuo.run.show/1";

/** The absolute workspace path the fixtures record, on whichever platform. */
const WORKSPACE = resolve("wt", "run-1");

const productionTemplate = suiteTemplate("run-show.sqlite3", (path) => {
  createProductionControlPlane(path, { nowMs: T0 }).close();
});

/** A migrated production control plane at head, holding one admitted run. */
function admittedFixture(runId: string = RUN_ID): {
  connection: SqliteDatabase;
  path: string;
} {
  const path = productionTemplate.copyInto(caseRoot(`run-show-${runId}`));
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
 * The admitted run, plus one of every other row the verb reads.
 *
 * Built through the real writers rather than by `INSERT`, for the reason
 * `run-close.test.ts` gives about `advanceRunStatus`: a suite that reached
 * around the writers to arrange a case would be asserting a document over rows
 * this build cannot produce. The gate's relay is what puts the outbox row
 * there, and it carries the gate's `run_id`, which is what makes it this run's.
 */
function populatedFixture(runId: string = RUN_ID): {
  connection: SqliteDatabase;
  path: string;
} {
  const fixture = admittedFixture(runId);
  const lease = acquireRunLease(fixture.connection, {
    runId,
    holder: "lap-1",
    nowMs: T1,
    ttlMs: TTL_MS,
  });
  prepareBinding(fixture.connection, lease, {
    sessionId: SESSION_ID,
    runId,
    provider: "claude_cli",
    nowMs: T1,
  });
  openGate(fixture.connection, {
    gateId: GATE_ID,
    gateType: "worker_escalation",
    subjectKind: "run",
    subjectId: runId,
    rationale: "the worker cannot decide whether to force-push",
    originEventSeq: 1,
    createdAtMs: T1,
    actorKind: "worker",
    actorId: "worker-7",
    options: ["force-push", "abandon"],
    deadlineAtMs: T2,
    runId,
  });
  presentGate(fixture.connection, { gateId: GATE_ID, nowMs: T2 });
  return fixture;
}

interface Streams {
  out: () => string;
  err: () => string;
}

/** Capture this subtree's two streams, as `run-close.test.ts` captures them. */
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

/** `continuo run show`'s argv. */
function showArgv(path: string, runId: string = RUN_ID): readonly string[] {
  return ["run", "show", "--db", path, "--run-id", runId];
}

/**
 * One captured line, parsed, having first been checked for being ONE line.
 *
 * The single-line check is part of the contract rather than tidiness, for the
 * reason `run-close.test.ts` gives: a host reads a stream, and a document split
 * over two writes is one a line-oriented reader mis-frames. It matters more
 * here than anywhere else in this CLI, because this document carries event and
 * outbox payloads -- free-form text that could hold a newline -- and the
 * encoder is what has to keep them from reaching the stream raw.
 */
function parsedDocument(line: string): Record<string, unknown> {
  expect(line.endsWith("\n"), "the document must end in exactly one newline").toBe(true);
  expect(
    line.slice(0, -1).includes("\n"),
    "the document must be one line: a host reads this stream line by line",
  ).toBe(false);
  return JSON.parse(line) as Record<string, unknown>;
}

// --------------------------------------------------------------------------
// the reader
// --------------------------------------------------------------------------

describe("runView", () => {
  test("refuses a run that is not on the table", () => {
    // Without this case an unknown run would fall through to the four list
    // reads and come back as a document with an empty everything -- which is
    // exactly the answer `D-0096` says a console cannot act on, because it is
    // the same document a real idle run produces.
    const { connection } = admittedFixture("view-unknown");

    expect(() => runView(connection, "no-such-run")).toThrow(/there is no run 'no-such-run'/);
  });

  test("reads the whole of what a console draws, from the rows", () => {
    // Without this case the CLI cases below could all pass over a reader that
    // returned the run and nothing else: every list would be empty, and an
    // empty list is a legitimate answer for an admitted run.
    const { connection } = populatedFixture("view-full");
    const view = runView(connection, "view-full");

    expect(view.run.runId).toBe("view-full");
    expect(view.lease?.holder).toBe("lap-1");
    expect(view.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
    expect(view.gates.map((gate) => gate.gateId)).toEqual([GATE_ID]);
    // Admission's two events, in the order the spine accepted them.
    expect(view.events.map((event) => event.eventType)).toEqual([
      "run_created",
      "run_delegation_recorded",
    ]);
    expect(view.outbox).toHaveLength(1);
    expect(view.outbox[0]?.status).toBe("pending");
  });

  test("carries a run's own rows and nobody else's", () => {
    // Without this case every SELECT could have been written without its
    // `WHERE run_id = :run_id` and every assertion above would still pass, on
    // a fixture holding exactly one run. A second run in one database is what
    // makes the filter observable.
    const { connection } = populatedFixture("view-mine");
    admitRun(connection, {
      intent: new LapRunIntent({
        runId: "view-theirs",
        leaseClaimantId: "secretary-1",
        workspace: WORKSPACE,
        role: "worker",
        baseBranch: "main",
        topicBranch: "feat/other",
        prompt: "something else",
      }),
      nowMs: T0,
    });

    const mine = runView(connection, "view-mine");
    const theirs = runView(connection, "view-theirs");

    expect(mine.events.every((event) => event.subjectId === "view-mine")).toBe(true);
    expect(theirs.events.every((event) => event.subjectId === "view-theirs")).toBe(true);
    expect(theirs.lease, "the other run was never leased").toBeNull();
    expect(theirs.sessions).toEqual([]);
    expect(theirs.gates).toEqual([]);
    expect(theirs.outbox).toEqual([]);
  });

  test("keeps a closed gate out of the open list", () => {
    // Without this case `gates` could have been every gate of the run, and the
    // console's `awaiting_user` pane -- which is a gate at stage 'presented',
    // `D-0096` -- would show questions that have already been answered.
    const { connection } = populatedFixture("view-closed");
    connection
      .prepare("UPDATE gate SET closed_at_ms = ?, outcome = 'withdrawn' WHERE gate_id = ?")
      .run(T2, GATE_ID);

    expect(runView(connection, "view-closed").gates).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// the host-facing document (--json)
// --------------------------------------------------------------------------

describe("continuo run show --json", () => {
  test("answers one document over a run that has only been admitted", () => {
    // Without this case a host would have no pinned shape at all: every key
    // could be renamed and the only reader that would notice is a host in
    // production. This is also the state every lap-1 run starts in, so the
    // absent lease and the three empty lists are the common answer rather than
    // an edge case.
    const { connection, path } = admittedFixture("json-admitted");
    const events = connection
      .prepare("SELECT seq, event_id, event_type, payload, producer, dedup_key FROM event")
      .all() as readonly Record<string, unknown>[];
    connection.close();
    const streams = captureStreams();

    const code = main([...showArgv(path, "json-admitted"), "--json"]);

    expect(code).toBe(0);
    expect(streams.err(), "a success writes nothing to stderr").toBe("");
    expect(parsedDocument(streams.out())).toStrictEqual({
      schema: SHOW_SCHEMA,
      ok: true,
      db: path,
      run: {
        run_id: "json-admitted",
        status: "created",
        // NULL, not absent and not 0: admission is lease-free, so nothing has
        // stamped an epoch on this row, and `null` is the honest word for it.
        writer_epoch: null,
        created_at_ms: T0,
        updated_at_ms: T0,
      },
      lease: null,
      sessions: [],
      gates: [],
      events: events.map((row) => ({
        seq: row.seq,
        event_id: row.event_id,
        event_type: row.event_type,
        subject_kind: "run",
        subject_id: "json-admitted",
        // Read off the row rather than written down: the payload is the
        // delegation record's own bytes, and a copy here would be a second
        // statement of what admission persists.
        payload: row.payload,
        producer: row.producer,
        producer_epoch: null,
        dedup_key: row.dedup_key,
        occurred_at_ms: T0,
        ingested_at_ms: T0,
      })),
      outbox: [],
    });
  });

  test("answers one document carrying the lease, the session, the gate and the outbox", () => {
    // Without this case only the empty shapes would be pinned, and a document
    // that emitted `[]` for every list would satisfy the case above forever.
    const { connection, path } = populatedFixture("json-full");
    const lease = readLease(connection, runLeaseResource("json-full"));
    const outboxRows = connection
      .prepare("SELECT message_id, recipient, payload, dedup_key FROM outbox")
      .all() as readonly Record<string, unknown>[];
    connection.close();
    const streams = captureStreams();

    expect(main([...showArgv(path, "json-full"), "--json"])).toBe(0);
    const document = parsedDocument(streams.out());

    expect(document["lease"]).toStrictEqual({
      resource: runLeaseResource("json-full"),
      holder: "lap-1",
      epoch: lease?.epoch,
      acquired_at_ms: T1,
      expires_at_ms: T1 + TTL_MS,
    });
    expect(document["sessions"]).toStrictEqual([
      {
        session_id: SESSION_ID,
        provider: "claude_cli",
        binding_phase: "prepared",
        observation: "unobserved",
        // The pair the DDL binds both ways: an unobserved row carries a reason
        // and no state word, and the document says so rather than collapsing
        // the two into one absent field (R4's v1 defect).
        provider_state: null,
        observation_reason: "binding committed; spawn not yet attempted",
        bound_at_ms: T1,
        released_at_ms: null,
      },
    ]);
    expect(document["gates"]).toStrictEqual([
      {
        gate_id: GATE_ID,
        gate_type: "worker_escalation",
        stage: "received",
        stage_entered_at_ms: T1,
        deadline_at_ms: T2,
      },
    ]);
    expect(document["outbox"]).toStrictEqual([
      {
        message_id: outboxRows[0]?.message_id,
        recipient: outboxRows[0]?.recipient,
        payload: outboxRows[0]?.payload,
        dedup_key: outboxRows[0]?.dedup_key,
        status: "pending",
        retry_count: 0,
        writer_epoch: null,
        enqueued_at_ms: T2,
        delivered_at_ms: null,
        acked_at_ms: null,
      },
    ]);
  });

  test("a payload holding a newline and a non-ASCII byte stays one ASCII line", () => {
    // Without this case the verb would be the first place in this CLI where
    // free-form external text reaches a document, with nothing pinning what
    // happens to it. `--prompt` is deliberately NOT held to ASCII (`run_cli.ts`
    // says why: it is stored rather than printed back), and admission puts it
    // verbatim into the run_delegation_recorded payload -- so an operator's
    // prompt is a newline away from splitting the document a host frames by
    // lines, and a smart quote away from breaking
    // `docs/cli-output-policy.md` on the surface that policy exists to protect.
    // Written as escapes, not as literal characters: this file is itself a
    // subject of `test/contract/ascii-output-policy.test.ts`, which scans
    // `test/` as well as `src/`. The escapes are an em-dash and three
    // Japanese characters -- the exact bytes a cp932 console cannot encode.
    const prompt = 'port the thing\nand then "stop" -- \u2014 \u65e5\u672c\u8a9e';
    const path = productionTemplate.copyInto(caseRoot("run-show-payload"));
    const connection = openProductionControlPlane(path);
    admitRun(connection, {
      intent: new LapRunIntent({
        runId: "payload",
        leaseClaimantId: "secretary-1",
        workspace: WORKSPACE,
        role: "worker",
        baseBranch: "main",
        topicBranch: "feat/run-1",
        prompt,
      }),
      nowMs: T0,
    });
    connection.close();
    const streams = captureStreams();

    expect(main([...showArgv(path, "payload"), "--json"])).toBe(0);

    const line = streams.out();
    // Every byte ASCII, and still exactly one line: `parsedDocument` asserts
    // the framing, and this asserts the alphabet.
    expect(/^[\x20-\x7e]*\n$/.test(line), "every byte of the document is ASCII").toBe(true);
    const events = parsedDocument(line)["events"] as readonly Record<string, unknown>[];
    const delegation = events.find((event) => event["event_type"] === "run_delegation_recorded");
    // And the escaping is reversible: a host that parses the document gets the
    // prompt back byte for byte, newline and all.
    expect((JSON.parse(String(delegation?.["payload"])) as Record<string, unknown>)["prompt"]).toBe(
      prompt,
    );
  });

  test("puts a refusal document on stderr, leaves stdout empty, and still exits 2", () => {
    // Without this case a host would have to parse `error: ...` text to learn
    // that the run it asked for does not exist -- which is the single most
    // likely refusal a console meets, because a console asks about a run it was
    // told about by something else. The exit code is asserted against the
    // non-json run's rather than against a literal 2, so the two cannot
    // diverge unnoticed.
    const { connection, path } = admittedFixture("json-unknown");
    connection.close();
    const streams = captureStreams();

    const humanCode = main(showArgv(path, "absent-run"));
    const humanLine = streams.err();
    const jsonCode = main([...showArgv(path, "absent-run"), "--json"]);

    expect(jsonCode, "the flag must not move the exit code").toBe(humanCode);
    expect(jsonCode).toBe(2);
    expect(streams.out(), "a refusal writes nothing to stdout").toBe("");
    expect(parsedDocument(streams.err().slice(humanLine.length))).toStrictEqual({
      schema: SHOW_SCHEMA,
      ok: false,
      db: path,
      error: {
        class: "UnknownRunRefused",
        // The same sentence the human line carries, taken from that line rather
        // than written down: a document whose message drifted from the text
        // would give an operator and a host two accounts of one refusal.
        message: humanLine.replace(/^error: /, "").replace(/\n$/, ""),
      },
    });
  });

  test("reports the control-plane family through the same writer", () => {
    // Without this case only `UnknownRunRefused` would be covered, and a host
    // must not have to know which family it hit to know how to read the answer.
    // A database that is not a control plane at all is the family an operator
    // meets by mistyping `--db`.
    const streams = captureStreams();
    const missing = resolve(caseRoot("run-show-json-nodb"), "not-a-control-plane.sqlite3");

    const code = main([...showArgv(missing, RUN_ID), "--json"]);

    expect(code).toBe(2);
    expect(streams.out()).toBe("");
    const document = parsedDocument(streams.err());
    expect(document["schema"]).toBe(SHOW_SCHEMA);
    expect(document["ok"]).toBe(false);
    expect(document["db"]).toBe(missing);
  });
});

// --------------------------------------------------------------------------
// the verb is a read, and only a read
// --------------------------------------------------------------------------

describe("continuo run show is read-only", () => {
  test("leaves the database file byte-identical", () => {
    // Without this case the verb could take a lease, stamp a row or leave a
    // journal behind and every document assertion above would still pass. The
    // bytes are the assertion because `D-0096` claims a read verb, and "it
    // returned the right answer" is not evidence that it wrote nothing.
    //
    // What it cannot catch, said rather than implied: a statement that writes
    // a value identical to the one already there leaves the file identical
    // too. That is the limit of a byte comparison and it is the right limit --
    // a write nothing can observe is not the hazard this stands in front of.
    // The sibling check is the other half: the control plane is deliberately
    // NOT in WAL (`connection.ts`), so a `-journal` left beside the file is a
    // transaction this verb opened and did not finish.
    const { connection, path } = populatedFixture("read-only");
    connection.close();
    const before = readFileSync(path);
    captureStreams();

    expect(main([...showArgv(path, "read-only"), "--json"])).toBe(0);
    expect(main(showArgv(path, "read-only"))).toBe(0);

    expect(readFileSync(path).equals(before), "a read verb writes nothing").toBe(true);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      expect(existsSync(`${path}${suffix}`), `a read verb leaves no ${suffix}`).toBe(false);
    }
  });

  test("reads no clock", () => {
    // Without this case a later field -- "is this lease live", "has this
    // deadline passed" -- could be computed against continuo's clock at an
    // instant the host cannot see, which is the one shape a console cannot
    // reconcile with what it drew a moment earlier. The seam throws, so the
    // claim is a failure rather than a sentence.
    const { connection, path } = populatedFixture("no-clock");
    connection.close();
    captureStreams();
    patchSeam(runCliSeams, "nowMs", () => {
      throw new Error("run show must not read a clock");
    });

    expect(main([...showArgv(path, "no-clock"), "--json"])).toBe(0);
  });
});

// --------------------------------------------------------------------------
// anti-vacuity for --json
// --------------------------------------------------------------------------

/**
 * The `--json` cases above, observed RED against the ways they could be vacuous.
 *
 * `AGENTS.md`: a check never seen red is not a check. Each case here names the
 * hole it stands in front of -- a way the block above could stay green while
 * the flag did nothing, or did everything, or reported a fixed literal.
 */
describe("continuo run show --json, observed red", () => {
  test("the same invocation without --json emits the human rendering and no document", () => {
    // The hole: `--json` never read, or JSON made the new default. Either would
    // leave every case above green -- the first if the verb always emitted the
    // document, the second if it never did and the cases asserted on a stream
    // nobody wrote. This is the case that fails in both directions.
    const { connection, path } = populatedFixture("red-human");
    connection.close();
    const streams = captureStreams();

    expect(main(showArgv(path, "red-human"))).toBe(0);

    const lines = streams.out().split("\n").filter(Boolean);
    expect(lines[0]).toBe(
      `run red-human in ${path}: status created created=${T0} updated=${T0} writer_epoch=-`,
    );
    expect(lines.some((line) => line.startsWith("lease run:red-human "))).toBe(true);
    expect(lines.some((line) => line.startsWith(`session "${SESSION_ID}" `))).toBe(true);
    expect(lines.some((line) => line.startsWith(`gate "${GATE_ID}" `))).toBe(true);
    expect(lines.filter((line) => line.startsWith("event ")).length).toBe(2);
    expect(lines.filter((line) => line.startsWith("outbox ")).length).toBe(1);
    expect(() => JSON.parse(streams.out()), "the human line must not be a document").toThrow();
  });

  test("unconstrained persisted text cannot break the human rendering's framing", () => {
    // The hole, found by two rounds of review of this diff: the human rendering
    // claims one line per row, and most of its fields are persisted text that
    // no constraint narrows. Interpolated raw, a newline in any of them
    // silently stops the rendering being one line per row, and a terminal
    // escape lets persisted text forge a line an operator reads as this
    // command's own. The payloads were already kept off these lines for this
    // exact reason; nothing else was.
    //
    // The rule `quoted` states is "constrained raw, unconstrained quoted", so
    // the case plants a hostile value in one field of each SHAPE the rule
    // covers -- a lease holder, a session id and a provider name -- rather
    // than in one field and calling the rule proven. `prepareBinding` takes
    // both session fields from its caller and validates neither's alphabet,
    // which is what makes them reachable rather than theoretical.
    const { connection, path } = admittedFixture("framing");
    const hostile = 'lap-1\nrun framing in /etc/passwd: status completed\x1b[2K "';
    const hostileSession = `s-1\ngate g-1 worker_escalation stage=answered since=${T0} deadline=-`;
    const hostileProvider = "claude_cli\noutbox m-1 to=nobody status=acked retries=0";
    const lease = acquireRunLease(connection, {
      runId: "framing",
      holder: hostile,
      nowMs: T1,
      ttlMs: TTL_MS,
    });
    prepareBinding(connection, lease, {
      sessionId: hostileSession,
      runId: "framing",
      provider: hostileProvider,
      nowMs: T1,
    });
    connection.close();
    const streams = captureStreams();

    expect(main(showArgv(path, "framing"))).toBe(0);

    // Exactly the rows this run has: one run line, one lease line, one session
    // line and admission's two events. Anything the three hostile values
    // smuggled in would show up here as a sixth.
    const lines = streams.out().split("\n").filter(Boolean);
    expect(lines).toHaveLength(5);
    for (const [prefix, count] of [
      ["run ", 1],
      ["lease ", 1],
      ["session ", 1],
      ["gate ", 0],
      ["event ", 2],
      ["outbox ", 0],
    ] as const) {
      expect(
        lines.filter((line) => line.startsWith(prefix)),
        prefix,
      ).toHaveLength(count);
    }
    // The forged text is still IN the output -- quoting hides nothing -- but it
    // sits inside a value rather than starting a line of its own, which is the
    // whole difference between a value and a forgery.
    expect(lines.some((line) => line.startsWith("run framing in /etc/passwd"))).toBe(false);
    // And every value is still readable: quoting is reversible, so an operator
    // sees what was stored rather than a redaction.
    const read = (line: string, key: string): unknown => {
      const match = new RegExp(`${key}=("(?:[^"\\\\]|\\\\.)*")`).exec(line);
      return JSON.parse(String(match?.[1]));
    };
    const leaseLine = lines.find((line) => line.startsWith("lease ")) ?? "";
    const sessionLine = lines.find((line) => line.startsWith("session ")) ?? "";
    expect(read(leaseLine, "holder")).toBe(hostile);
    expect(read(sessionLine, "provider")).toBe(hostileProvider);
    expect(JSON.parse(String(/^session ("(?:[^"\\]|\\.)*")/.exec(sessionLine)?.[1]))).toBe(
      hostileSession,
    );
  });

  test("a field moves when the fact under it moves", () => {
    // The hole: a document built from literals rather than from the rows. Every
    // assertion above would pass against a hardcoded object as long as the
    // fixtures never varied. Two runs differing in exactly what was done to
    // them must differ in exactly those keys.
    const bare = admittedFixture("vary-bare");
    bare.connection.close();
    const full = populatedFixture("vary-full");
    full.connection.close();
    const streams = captureStreams();

    expect(main([...showArgv(bare.path, "vary-bare"), "--json"])).toBe(0);
    const a = parsedDocument(streams.out());
    const before = streams.out().length;
    expect(main([...showArgv(full.path, "vary-full"), "--json"])).toBe(0);
    const b = parsedDocument(streams.out().slice(before));

    expect(b["db"], "db is the path this invocation was given").not.toBe(a["db"]);
    expect(
      (b["run"] as Record<string, unknown>)["run_id"],
      "run_id is read off the row, not fixed",
    ).not.toBe((a["run"] as Record<string, unknown>)["run_id"]);
    expect(a["lease"], "an admitted run has never been leased").toBeNull();
    expect(b["lease"], "a lap holds this one").not.toBeNull();
    expect((b["sessions"] as unknown[]).length).toBeGreaterThan(
      (a["sessions"] as unknown[]).length,
    );
    expect((b["gates"] as unknown[]).length).toBeGreaterThan((a["gates"] as unknown[]).length);
    expect((b["outbox"] as unknown[]).length).toBeGreaterThan((a["outbox"] as unknown[]).length);
    // And the keys whose facts did NOT move must not move: a document that
    // varied everything would satisfy the assertions above while telling a host
    // nothing.
    expect((b["run"] as Record<string, unknown>)["status"]).toBe(
      (a["run"] as Record<string, unknown>)["status"],
    );
    expect((b["events"] as unknown[]).length, "both runs carry admission's two events").toBe(
      (a["events"] as unknown[]).length,
    );
  });

  test("the refusal path reads the flag too, and not only the success path", () => {
    // The hole: `--json` read where the report is written but not where the
    // refusal is. Every success case above would stay green while a host got
    // `error: ...` text it cannot parse -- and this subtree has ONE refusal
    // writer precisely so that this cannot be half-done.
    const { connection, path } = admittedFixture("red-refusal");
    connection.close();
    const streams = captureStreams();

    expect(main([...showArgv(path, "not-admitted"), "--json"])).toBe(2);

    const written = streams.err();
    expect(written.startsWith("error: "), "a refusal under --json is not the human line").toBe(
      false,
    );
    expect(parsedDocument(written)["ok"]).toBe(false);
  });

  test("the vacuity check on the vacuity checks: the human refusal is still a line", () => {
    // A suite whose "not the human line" assertion passed because the verb
    // wrote NOTHING would satisfy the case above while the command had stopped
    // reporting altogether.
    const { connection, path } = admittedFixture("red-human-refusal");
    connection.close();
    const streams = captureStreams();

    expect(main(showArgv(path, "not-admitted"))).toBe(2);

    expect(streams.err().startsWith("error: ")).toBe(true);
    expect(() => JSON.parse(streams.err()), "the human refusal is not a document").toThrow();
  });

  test("the mount carries the flag: `run show --json` reaches the handler", () => {
    // The hole: `addJsonArgument(show)` deleted. Without this half the parser
    // would refuse the flag at the top level -- `unrecognized arguments:
    // --json` -- which is precisely the state rondo D-0015 rule 5 was written
    // around for `gate close`, and every case above would fail with a message
    // about argv rather than about the document.
    const { connection, path } = admittedFixture("mount");
    connection.close();
    const streams = captureStreams();

    expect(main([...showArgv(path, "mount"), "--json"])).toBe(0);
    expect(parsedDocument(streams.out())["schema"]).toBe(SHOW_SCHEMA);
  });
});
