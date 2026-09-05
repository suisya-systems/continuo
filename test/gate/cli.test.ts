import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { helpStrings } from "../../src/cli/parser.js";
import { buildParser, main, cliSeams as topLevelSeams } from "../../src/cli.js";
import { openGate } from "../../src/control_plane/gates.js";
import { acquire } from "../../src/control_plane/lease.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import { gateCliSeams } from "../../src/gate/cli.js";
import { relayMessageId } from "../../src/gate/operator.js";
import { DELIVERY_LEASE_RESOURCE } from "../../src/messagebus/endpoint.js";
import { caseRoot } from "../testkit/cases.js";
import { patchSeam } from "../testkit/seams.js";

/**
 * `continuo gate ...` -- the mount, and what each verb prints.
 *
 * **Target-only.** interlock mounts no `gate` subtree, so these are written
 * against the property rather than translated, and rule 10 of
 * `docs/test-translation-conventions.md` applies: each case names what would be
 * silently wrong without it.
 *
 * Every case drives the **mounted** command through `src/cli.ts`'s `main`
 * rather than a hand-built namespace, for the reason `db-cli.test.ts` gives:
 * half of what is under test is the mount, and a verb whose parser is right and
 * which `src/cli.ts` never hangs off its subcommand table is exactly the state
 * a green suite would hide.
 *
 * The rules about transitions belong to `test/control_plane/gates.test.ts` and
 * the rules about the operator's ordering to `test/gate/operator.test.ts`.
 * What is asserted here is the layer this module adds: which entry point each
 * verb reaches, that its report says which of the writes landed, that a refusal
 * arrives as one operator-facing line and exit 2 rather than a stack trace, and
 * that the clock is read once.
 */

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const GATE_ID = "gate-1";
const RUN_ID = "run-1";
const ACTOR = "operator-1";

/** What one verb wrote to each stream. */
interface Streams {
  out(): string;
  err(): string;
}

/**
 * Capture both streams for the running test.
 *
 * Both, always: a refusal case reading only stdout would pass against a command
 * that printed nothing and exited 2 for the wrong reason.
 */
function captureStreams(): Streams {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  patchSeam(gateCliSeams, "write", (text: string) => {
    outChunks.push(text);
  });
  patchSeam(gateCliSeams, "writeError", (text: string) => {
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
  patchSeam(gateCliSeams, "nowMs", () => {
    reads += 1;
    return instant;
  });
  return { reads: () => reads };
}

/**
 * A production control plane holding one open `worker_escalation` gate.
 *
 * Written through `openGate` and raw rows rather than through `lap perform`:
 * these cases are about the verbs, and driving a whole lap to reach their
 * subject would make every one of them fail for somebody else's reason.
 */
function aDatabaseWithAGate(
  label: string,
  options: { readonly deadlineAtMs?: number | null; readonly runId?: string | null } = {},
): { readonly path: string; readonly destination: string } {
  const root = caseRoot(label);
  const path = join(root, "control-plane.sqlite3");
  const connection: SqliteDatabase = createProductionControlPlane(path, { nowMs: T0 });
  try {
    connection
      .prepare<[string, number, number]>(
        "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'running', ?, ?)",
      )
      .run(RUN_ID, T0, T0);
    const seq = Number(
      connection
        .prepare<[string, string, string, string, number, number]>(
          `
            INSERT INTO event (event_id, event_type, subject_kind, subject_id, run_id,
                               producer, dedup_key, occurred_at_ms, ingested_at_ms)
            VALUES (?, 'worker_escalation_raised', 'run', ?, ?, 'worker', ?, ?, ?)
            `,
        )
        .run(`evt/${RUN_ID}`, RUN_ID, RUN_ID, `dk/${RUN_ID}`, T0, T0).lastInsertRowid,
    );
    openGate(connection, {
      gateId: GATE_ID,
      gateType: "worker_escalation",
      subjectKind: "run",
      subjectId: RUN_ID,
      rationale: "the worker cannot decide whether to force-push",
      originEventSeq: seq,
      createdAtMs: T0,
      actorKind: "worker",
      actorId: "worker-7",
      options: ["force-push", "abandon"],
      deadlineAtMs: options.deadlineAtMs ?? null,
      runId: options.runId === undefined ? RUN_ID : options.runId,
    });
  } finally {
    connection.close();
  }
  return { path, destination: join(root, "destination") };
}

/**
 * Every character this string holds is printable ASCII.
 *
 * The same predicate `db-cli.test.ts` uses, code point by code point rather
 * than by a regular expression over a control range: the range is what the
 * linter refuses, and a character-wise test says the same thing without one.
 */
function isAscii(text: string): boolean {
  return [...text].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0x09 || code === 0x0a || (code >= 0x20 && code <= 0x7e);
  });
}

describe("the operator's walk, through the mounted verbs", () => {
  test("the eight verbs carry an open gate to answered_and_forwarded", () => {
    // Issue #108's acceptance criterion at the surface it is stated about: an
    // operator, with CLI verbs only, sees an open gate, answers it, records the
    // ack, and the gate closes.
    const { path, destination } = aDatabaseWithAGate("gate-cli-walk");
    const streams = captureStreams();

    expect(main(["gate", "list", "--db", path])).toBe(0);
    expect(streams.out()).toContain(`${GATE_ID} worker_escalation run=${RUN_ID} stage=received`);

    const presented = relayMessageId(GATE_ID, "presented");
    expect(
      main([
        "gate",
        "present",
        "--db",
        path,
        "--gate-id",
        GATE_ID,
        "--now-ms",
        String(T0 + MINUTE),
      ]),
    ).toBe(0);
    expect(streams.out()).toContain(`enqueued ${presented} to external-notify`);

    expect(
      main([
        "gate",
        "deliver",
        "--db",
        path,
        "--destination-dir",
        destination,
        "--holder",
        ACTOR,
        "--now-ms",
        String(T0 + 2 * MINUTE),
      ]),
    ).toBe(0);
    expect(streams.out()).toContain("delivered 1 message(s) to external-notify");

    expect(
      main([
        "gate",
        "ack",
        "--db",
        path,
        "--message-id",
        presented,
        "--actor-id",
        ACTOR,
        "--now-ms",
        String(T0 + 3 * MINUTE),
      ]),
    ).toBe(0);
    expect(streams.out()).toContain(
      `${presented}: acked=true cancelled=false advanced=true closed=false`,
    );

    const forwarded = relayMessageId(GATE_ID, "forwarded");
    expect(
      main([
        "gate",
        "answer",
        "--db",
        path,
        "--gate-id",
        GATE_ID,
        "--body",
        "force-push, and record why",
        "--actor-id",
        ACTOR,
        "--now-ms",
        String(T0 + 4 * MINUTE),
      ]),
    ).toBe(0);
    expect(streams.out()).toContain(`answered=true enqueued ${forwarded}`);

    expect(
      main([
        "gate",
        "deliver",
        "--db",
        path,
        "--destination-dir",
        destination,
        "--holder",
        ACTOR,
        "--now-ms",
        String(T0 + 5 * MINUTE),
      ]),
    ).toBe(0);
    expect(
      main([
        "gate",
        "ack",
        "--db",
        path,
        "--message-id",
        forwarded,
        "--actor-id",
        ACTOR,
        "--now-ms",
        String(T0 + 6 * MINUTE),
      ]),
    ).toBe(0);
    expect(streams.out()).toContain(
      `${forwarded}: acked=true cancelled=false advanced=true closed=true`,
    );

    expect(main(["gate", "list", "--db", path])).toBe(0);
    expect(streams.out()).toContain(`no open gates in ${path}`);
    expect(streams.err()).toBe("");

    // The whole history is readable afterwards, which is the property the lap
    // exists to gain: a durable decision record.
    expect(main(["gate", "show", "--db", path, "--gate-id", GATE_ID])).toBe(0);
    const shown = streams.out();
    expect(shown).toContain("outcome=answered_and_forwarded");
    expect(shown).toContain("body=force-push, and record why");
    expect(shown).toContain(`relay presented ${presented} to=external-notify status=acked`);
    expect(shown).toContain(`relay forwarded ${forwarded} to=external-notify status=acked`);
  });

  test("a verb reads the clock once when --now-ms is absent", () => {
    // The rule every other subtree keeps: nothing below the verb reads a clock,
    // so a report and the rows it describes cannot disagree about when they
    // happened.
    const { path } = aDatabaseWithAGate("gate-cli-clock");
    captureStreams();
    const clock = countedClock(T0 + MINUTE);

    expect(main(["gate", "present", "--db", path, "--gate-id", GATE_ID])).toBe(0);

    expect(clock.reads()).toBe(1);
    const connection = openProductionControlPlane(path);
    try {
      expect(
        connection
          .prepare<[string], number>("SELECT enqueued_at_ms FROM outbox WHERE message_id = ?")
          .pluck()
          .get(relayMessageId(GATE_ID, "presented")),
      ).toBe(T0 + MINUTE);
    } finally {
      connection.close();
    }
  });

  test("reconcile says so rather than reporting a stalled queue it never queried", () => {
    const { path } = aDatabaseWithAGate("gate-cli-reconcile", { deadlineAtMs: T0 + MINUTE });
    const streams = captureStreams();

    expect(
      main([
        "gate",
        "reconcile",
        "--db",
        path,
        "--actor-id",
        ACTOR,
        "--now-ms",
        String(T0 + 2 * MINUTE),
      ]),
    ).toBe(0);

    expect(streams.out()).toContain("found: stalled_relays=not asked (no --stalled-tolerance-ms)");
    // Reported, never acted on: no expiry policy is decided, so the pass names
    // the candidate and closes nothing (D-0008).
    expect(streams.out()).toContain(`past deadline ${GATE_ID} at received`);
    expect(streams.out()).toContain("settled: subject_gone=0 advanced=0 closed=0");
  });
});

describe("what the verbs refuse", () => {
  test("an unknown gate is one stderr line and exit 2, not a stack trace", () => {
    const { path } = aDatabaseWithAGate("gate-cli-unknown");
    const streams = captureStreams();

    expect(main(["gate", "show", "--db", path, "--gate-id", "gate-nope"])).toBe(2);

    expect(streams.out()).toBe("");
    expect(streams.err()).toBe("error: gate gate-nope does not exist\n");
  });

  test("delivering while a lap holds the delivery lease is refused with the reason", () => {
    // The serialisation the one delivery resource buys (D-0053 rule 4), seen
    // from the surface an operator types at.
    const { path, destination } = aDatabaseWithAGate("gate-cli-lease");
    const connection = openProductionControlPlane(path);
    try {
      acquire(connection, {
        resource: DELIVERY_LEASE_RESOURCE,
        holder: "a-running-lap",
        nowMs: T0,
        ttlMs: 300_000,
      });
    } finally {
      connection.close();
    }
    const streams = captureStreams();

    expect(
      main([
        "gate",
        "deliver",
        "--db",
        path,
        "--destination-dir",
        destination,
        "--holder",
        ACTOR,
        "--now-ms",
        String(T0 + MINUTE),
      ]),
    ).toBe(2);
    expect(streams.err()).toContain("a-running-lap");
  });

  test("the outcomes that are not a hand's to write are refused by the parser", () => {
    // `choices` rather than a check inside the verb, so the refusal names the
    // admitted set on the help screen as well as in the message -- and the
    // domain entry point refuses them too (`operator.test.ts`), because the
    // rule is the domain's rather than the parser's.
    const { path } = aDatabaseWithAGate("gate-cli-outcome");
    captureStreams();
    // The parser's own refusal goes out through the TOP-LEVEL streams, not this
    // subtree's, so it is captured here as well -- otherwise a usage screen is
    // printed to the console of whoever runs the suite.
    const usage: string[] = [];
    patchSeam(topLevelSeams, "err", (text: string) => {
      usage.push(text);
    });

    expect(
      main([
        "gate",
        "close",
        "--db",
        path,
        "--gate-id",
        GATE_ID,
        "--outcome",
        "answered_and_forwarded",
        "--actor-id",
        ACTOR,
      ]),
    ).toBe(2);
    expect(usage.join("")).toContain(
      "invalid choice: 'answered_and_forwarded' (choose from 'withdrawn', 'expired', 'unanswerable')",
    );
  });

  test("a database that is not a control plane is refused before anything is written", () => {
    const root = caseRoot("gate-cli-nodb");
    const streams = captureStreams();

    expect(main(["gate", "list", "--db", join(root, "absent.sqlite3")])).toBe(2);

    expect(streams.err()).toMatch(/^error: /);
    expect(streams.out()).toBe("");
  });
});

describe("continuo#122: one rule for the destination directory", () => {
  // `gate deliver` is the second half of the rule stated in
  // `test/lap/cli.test.ts`: the same dropbox, opened again by a verb that runs
  // after the lap's endpoint is gone. The walk above already covers the
  // create-if-missing half -- `aDatabaseWithAGate` hands out a path nothing has
  // made -- so what is left is that an existing one is REUSED rather than
  // refused or emptied, which is what makes the two helps one rule (D-0085).
  test("deliver into a dropbox that already exists reuses it", () => {
    const { path, destination } = aDatabaseWithAGate("gate-cli-destination-exists");
    mkdirSync(destination, { recursive: true });
    const earlier = join(destination, "earlier.effect.json");
    writeFileSync(earlier, '{"idempotency_key":"earlier"}\n', "utf8");
    const streams = captureStreams();

    expect(
      main([
        "gate",
        "present",
        "--db",
        path,
        "--gate-id",
        GATE_ID,
        "--now-ms",
        String(T0 + MINUTE),
      ]),
    ).toBe(0);
    expect(
      main([
        "gate",
        "deliver",
        "--db",
        path,
        "--destination-dir",
        destination,
        "--holder",
        ACTOR,
        "--now-ms",
        String(T0 + 2 * MINUTE),
      ]),
    ).toBe(0);

    expect(streams.out()).toContain("delivered 1 message(s) to external-notify");
    expect(streams.err()).toBe("");
    // What was there is still there, and the relay's own effect landed beside
    // it: the directory is shared, not claimed.
    expect(readFileSync(earlier, "utf8")).toBe('{"idempotency_key":"earlier"}\n');
    expect(
      readdirSync(destination).some(
        (name) => name.endsWith(".effect.json") && name !== basename(earlier),
      ),
    ).toBe(true);
  });

  test("--help states the rule, in the words lap perform's help uses", () => {
    const help = helpStrings(buildParser()).join("\n");
    const at = help.indexOf("the dropbox directory the relay's effect is written into");
    expect(at, "the --destination-dir help is no longer findable").toBeGreaterThanOrEqual(0);
    const text = help.slice(at, at + 600);
    expect(text).toContain("Created if it does not exist, and reused if it does");
    expect(text).toContain("lap perform --endpoint-destination-dir");
  });
});

describe("the mount", () => {
  test("all eight verbs are reachable from the top-level parser", () => {
    // `src/cli.ts` could hold a correct parser for a subtree it never mounts,
    // and every case above would still be green if they called the handlers
    // directly -- they do not, and this states why.
    const reachable = helpStrings(buildParser());
    for (const opening of [
      "List every open gate",
      "Show one gate:",
      "Enqueue the 'presented' relay",
      "Deliver every relay currently due",
      "Record the ack for one relay",
      "Record the human answer",
      "Close an open gate",
      "One reconcile pass",
    ]) {
      expect(
        reachable.some((text) => text.startsWith(opening)),
        opening,
      ).toBe(true);
    }
  });

  test("every help string the gate subtree contributes is ASCII", () => {
    // `docs/cli-output-policy.md`: a single em dash here crashes `--help` on a
    // cp932 console, and an in-process capture cannot see it.
    for (const text of helpStrings(buildParser())) {
      if (text.includes("gate") || text.includes("relay")) {
        expect(isAscii(text), text).toBe(true);
      }
    }
  });
});

/**
 * `continuo#155`: the three verbs a host drives answer in the shared envelope.
 *
 * The shape is `src/cli/json_output.ts`'s and the policy is
 * `docs/cli-output-policy.md`'s; what these cases own is that THIS subtree
 * emits it -- one document, on the right stream, with the keys a host was
 * promised and no others. `toStrictEqual` over a parsed document rather than a
 * substring match, because a renamed or an extra key is precisely the change
 * that breaks a host and that a `toContain` would not see.
 */

/** The one line a `--json` invocation wrote, parsed. */
function oneDocument(text: string): unknown {
  expect(text.endsWith("\n"), "the document must be one line, newline included").toBe(true);
  expect(
    text.slice(0, -1).includes("\n"),
    "one invocation writes exactly one document; a host reads one line",
  ).toBe(false);
  return JSON.parse(text) as unknown;
}

/** Carry the gate to `presented`, in the human bytes, so `gate answer` is admissible. */
function carryToPresented(path: string, destination: string): void {
  // Captured and discarded: these three verbs are setup, and their human lines
  // would otherwise land on the console of whoever runs the suite. The case's
  // own captureStreams() call re-patches the seams afterwards.
  captureStreams();
  const presented = relayMessageId(GATE_ID, "presented");
  expect(
    main(["gate", "present", "--db", path, "--gate-id", GATE_ID, "--now-ms", String(T0 + MINUTE)]),
  ).toBe(0);
  expect(
    main([
      "gate",
      "deliver",
      "--db",
      path,
      "--destination-dir",
      destination,
      "--holder",
      ACTOR,
      "--now-ms",
      String(T0 + 2 * MINUTE),
    ]),
  ).toBe(0);
  expect(
    main([
      "gate",
      "ack",
      "--db",
      path,
      "--message-id",
      presented,
      "--actor-id",
      ACTOR,
      "--now-ms",
      String(T0 + 3 * MINUTE),
    ]),
  ).toBe(0);
}

/** A production control plane with no gate in it at all. */
function aDatabaseWithNoGates(label: string): string {
  const path = join(caseRoot(label), "control-plane.sqlite3");
  createProductionControlPlane(path, { nowMs: T0 }).close();
  return path;
}

describe("continuo#155: the JSON documents a host reads", () => {
  test("gate list --json pins one object per open gate, under a key", () => {
    // Without this, `gate list` could rename a key, drop `deadline_at_ms`, or
    // ship the record's own camelCase field names, and every human-output case
    // above would stay green while the host contract silently changed.
    const { path } = aDatabaseWithAGate("gate-json-list", { deadlineAtMs: T0 + MINUTE });
    const streams = captureStreams();

    expect(main(["gate", "list", "--db", path, "--json"])).toBe(0);

    expect(oneDocument(streams.out()), "gate list's success document changed shape").toStrictEqual({
      schema: "continuo.gate.list/1",
      ok: true,
      db: path,
      gates: [
        {
          gate_id: GATE_ID,
          gate_type: "worker_escalation",
          run_id: RUN_ID,
          stage: "received",
          stage_entered_at_ms: T0,
          deadline_at_ms: T0 + MINUTE,
        },
      ],
    });
    expect(streams.err(), "a success writes nothing to stderr").toBe("");
  });

  test("a gate with no run and no deadline carries null, not the string '-'", () => {
    // The hole this stands in front of is a rendering decision leaking into the
    // document: the human line prints `-` for both, and a host that read `"-"`
    // could not tell an absent run from a run whose id is one character long.
    const { path } = aDatabaseWithAGate("gate-json-list-null", {
      runId: null,
      deadlineAtMs: null,
    });
    const streams = captureStreams();

    expect(main(["gate", "list", "--db", path, "--json"])).toBe(0);

    const document = oneDocument(streams.out()) as { gates: readonly Record<string, unknown>[] };
    expect(document.gates[0]?.["run_id"], "an absent run must be JSON null").toBeNull();
    expect(
      document.gates[0]?.["deadline_at_ms"],
      "an absent deadline must be JSON null",
    ).toBeNull();
  });

  test("gate list --json on a control plane with nothing open emits an empty array", () => {
    // The empty case is a result, not a special case. A host told "no open
    // gates in <path>" in prose would have to recognise a sentence to learn the
    // most ordinary answer this verb gives -- and the sentence embeds a
    // filesystem path, so it is not even a stable one.
    const path = aDatabaseWithNoGates("gate-json-list-empty");
    const streams = captureStreams();

    expect(main(["gate", "list", "--db", path, "--json"])).toBe(0);

    expect(
      oneDocument(streams.out()),
      "the empty list must be a document, not prose",
    ).toStrictEqual({ schema: "continuo.gate.list/1", ok: true, db: path, gates: [] });
    expect(streams.out(), "the human sentence must not leak into the document").not.toContain(
      "no open gates",
    );
  });

  test("gate show --json pins the gate, its relays and its transitions", () => {
    // The verb a host reads one gate with. Its two nested arrays are where a
    // spread of the domain record would have shipped camelCase keys, and where
    // a field added to `GateDetail` later would otherwise join a pinned host
    // contract without anybody deciding it should.
    const { path, destination } = aDatabaseWithAGate("gate-json-show");
    carryToPresented(path, destination);
    const streams = captureStreams();

    expect(main(["gate", "show", "--db", path, "--gate-id", GATE_ID, "--json"])).toBe(0);

    expect(oneDocument(streams.out()), "gate show's success document changed shape").toStrictEqual({
      schema: "continuo.gate.show/1",
      ok: true,
      db: path,
      gate_id: GATE_ID,
      gate_type: "worker_escalation",
      run_id: RUN_ID,
      subject_kind: "run",
      subject_id: RUN_ID,
      stage: "presented",
      deadline_at_ms: null,
      outcome: null,
      rationale: "the worker cannot decide whether to force-push",
      options: '["force-push", "abandon"]',
      relays: [
        {
          to_stage: "presented",
          message_id: relayMessageId(GATE_ID, "presented"),
          recipient: "external-notify",
          status: "acked",
          retry_count: 1,
          delivered_at_ms: T0 + 2 * MINUTE,
          acked_at_ms: T0 + 3 * MINUTE,
        },
      ],
      transitions: [
        {
          seq: 1,
          transition_kind: "open",
          from_stage: null,
          to_stage: "received",
          actor_kind: "worker",
          actor_id: "worker-7",
          recorded_at_ms: T0,
          body: null,
        },
        {
          seq: 2,
          transition_kind: "advance",
          from_stage: "received",
          to_stage: "presented",
          actor_kind: "secretary",
          actor_id: ACTOR,
          recorded_at_ms: T0 + 3 * MINUTE,
          body: null,
        },
      ],
    });
    expect(streams.err(), "a success writes nothing to stderr").toBe("");
  });

  test("gate answer --json carries booleans where the human line carries words", () => {
    // The human line spells `enqueued` as "enqueued" / "already enqueued" --
    // two phrasings of one boolean, one of which is the FALSE case. A host
    // reading that has to keep a phrasebook, and a phrasebook is what goes
    // stale when the wording is improved.
    const { path, destination } = aDatabaseWithAGate("gate-json-answer");
    carryToPresented(path, destination);
    const streams = captureStreams();

    expect(
      main([
        "gate",
        "answer",
        "--db",
        path,
        "--gate-id",
        GATE_ID,
        "--body",
        "force-push, and record why",
        "--actor-id",
        ACTOR,
        "--now-ms",
        String(T0 + 4 * MINUTE),
        "--json",
      ]),
    ).toBe(0);

    expect(
      oneDocument(streams.out()),
      "gate answer's success document changed shape",
    ).toStrictEqual({
      schema: "continuo.gate.answer/1",
      ok: true,
      db: path,
      advanced: true,
      enqueued: true,
      message_id: relayMessageId(GATE_ID, "forwarded"),
      to_stage: "forwarded",
    });
    expect(streams.err(), "a success writes nothing to stderr").toBe("");
  });

  test("a re-run of gate answer reports false rather than a different sentence", () => {
    // The idempotent repeat, which is the case a host actually branches on
    // after a kill: both booleans go false, and they are still booleans.
    const { path, destination } = aDatabaseWithAGate("gate-json-answer-again");
    carryToPresented(path, destination);
    const streams = captureStreams();
    const argv = [
      "gate",
      "answer",
      "--db",
      path,
      "--gate-id",
      GATE_ID,
      "--body",
      "force-push, and record why",
      "--actor-id",
      ACTOR,
      "--now-ms",
      String(T0 + 4 * MINUTE),
      "--json",
    ];

    expect(main(argv)).toBe(0);
    expect(main(argv)).toBe(0);

    const documents = streams
      .out()
      .trimEnd()
      .split("\n")
      .map((line) => oneDocument(`${line}\n`)) as readonly Record<string, unknown>[];
    expect(documents[0]?.["advanced"], "the first call moved the stage").toBe(true);
    expect(documents[1]?.["advanced"], "the repeat moved nothing, as a boolean").toBe(false);
    expect(documents[1]?.["enqueued"], "'already enqueued' is the false case").toBe(false);
  });
});

/**
 * `continuo#159`: `gate close` joins the envelope, and what its document says.
 *
 * The verb the host's own operating surface drives (rondo `D-0013`) and the one
 * `D-0090` left out. Until this landed, rondo `D-0015` rule 5 drove it as an
 * opaque exit code and confirmed the write with a SECOND `gate show --json`
 * subprocess, because the alternative was parsing `closed g as withdrawn`.
 * These cases own the document that makes both unnecessary (`D-0092`).
 */

/** `gate close` on `GATE_ID`, with whatever the case adds after it. */
function closeArgv(
  path: string,
  outcome: string,
  extra: readonly string[] = [],
): readonly string[] {
  return [
    "gate",
    "close",
    "--db",
    path,
    "--gate-id",
    GATE_ID,
    "--outcome",
    outcome,
    "--actor-id",
    ACTOR,
    "--now-ms",
    String(T0 + 5 * MINUTE),
    ...extra,
  ];
}

describe("continuo#159: gate close answers in the envelope", () => {
  test("gate close --json pins the closure it performed, read back from the row", () => {
    // Without this, `gate close --json` could ship the outcome it was HANDED
    // rather than the one the row now carries, and a host would learn nothing
    // it did not already type. The three read-back fields are exactly what
    // rondo's second subprocess went to fetch.
    const { path } = aDatabaseWithAGate("gate-json-close");
    const streams = captureStreams();

    expect(main([...closeArgv(path, "withdrawn"), "--json"])).toBe(0);

    expect(oneDocument(streams.out()), "gate close's success document changed shape").toStrictEqual(
      {
        schema: "continuo.gate.close/1",
        ok: true,
        db: path,
        gate_id: GATE_ID,
        closed: true,
        outcome: "withdrawn",
        // A close is stage-preserving: the stage a gate was closed AT is part
        // of what the outcome means, so both ends of the transition are the
        // stage the gate stands at and stays at.
        from_stage: "received",
        to_stage: "received",
      },
    );
    expect(streams.err(), "a success writes nothing to stderr").toBe("");
  });

  test("an identical-outcome replay is ok:true with closed:false, not a refusal", () => {
    // The case a host actually branches on after a kill. `closeOpenGate`
    // returns false for the idempotent repeat of the SAME close, and that is a
    // success -- a build that read `false` as "refused" would exit 2 on a
    // retry that changed nothing, which is the one thing an idempotent verb
    // exists to avoid.
    const { path } = aDatabaseWithAGate("gate-json-close-again");
    const streams = captureStreams();
    const argv = [...closeArgv(path, "withdrawn"), "--json"];

    expect(main(argv)).toBe(0);
    expect(main(argv), "the replay is a success, with the same status").toBe(0);

    const documents = streams
      .out()
      .trimEnd()
      .split("\n")
      .map((line) => oneDocument(`${line}\n`)) as readonly Record<string, unknown>[];
    expect(documents[0]?.["closed"], "the first call performed the close").toBe(true);
    expect(documents[1]?.["closed"], "the replay performed nothing, as a boolean").toBe(false);
    expect(documents[1]?.["ok"], "and it is still a success").toBe(true);
    expect(documents[1]?.["outcome"], "the confirmed effect is unchanged").toBe("withdrawn");
    expect(documents[1]?.["to_stage"], "and so is the stage it was closed at").toBe("received");
    expect(streams.err(), "neither call writes to stderr").toBe("");
  });

  test("the outcome and the stage come from the row, not from the command line", () => {
    // The hole a hardcoded payload would sit in: every assertion above fixes
    // the database as well as the document, so a `closePayload` that returned
    // literals would satisfy them. Two gates closed at DIFFERENT stages under
    // DIFFERENT outcomes, differing in exactly those keys, is what a literal
    // cannot fake.
    const received = aDatabaseWithAGate("gate-json-close-received");
    const presented = aDatabaseWithAGate("gate-json-close-presented");
    carryToPresented(presented.path, presented.destination);
    const streams = captureStreams();

    expect(main([...closeArgv(received.path, "withdrawn"), "--json"])).toBe(0);
    // `unanswerable` is reachable from 'presented' and from nowhere else, so
    // this pair varies the stage and the outcome together and neither could
    // have been produced from the other database.
    expect(main([...closeArgv(presented.path, "unanswerable"), "--json"])).toBe(0);

    const [first, second] = streams
      .out()
      .trimEnd()
      .split("\n")
      .map((line) => oneDocument(`${line}\n`)) as readonly Record<string, unknown>[];
    expect(first?.["outcome"], "the first outcome must come from its own row").toBe("withdrawn");
    expect(second?.["outcome"], "the second must come from its own row").toBe("unanswerable");
    expect(first?.["from_stage"], "the stage a gate was closed at is per-row too").toBe("received");
    expect(second?.["from_stage"]).toBe("presented");
    expect(second?.["to_stage"], "and a close leaves the gate where it stood").toBe("presented");
    // The vacuity check on this vacuity check: the two documents describe the
    // same gate id under the same schema, so the assertions above are about
    // those keys and not about two unrelated documents.
    expect(first?.["gate_id"]).toBe(second?.["gate_id"]);
    expect(first?.["schema"]).toBe(second?.["schema"]);
  });

  test("the same close without --json is the human line, byte for byte", () => {
    // The hole: a build that ignored the flag and emitted the document always.
    // Every case above passes `--json`, so all of them would stay green while
    // every operator's terminal filled with JSON.
    const { path } = aDatabaseWithAGate("gate-json-close-absent");
    const streams = captureStreams();

    expect(main(closeArgv(path, "withdrawn"))).toBe(0);

    expect(streams.out(), "the human line must be byte-identical to what it was").toBe(
      `closed ${GATE_ID} as withdrawn\n`,
    );
    expect(() => JSON.parse(streams.out()), "no --json, no document").toThrow();
    expect(streams.err(), "and nothing reaches stderr").toBe("");
  });
});

describe("continuo#159: every refusal gate close can reach is a document", () => {
  /**
   * One refused close, both ways: the status, the streams and the document.
   *
   * Run without the flag first, so each case also states that the operator's
   * line is unchanged -- the refusal funnel is shared by all eight verbs, and
   * teaching it one more report must not move any of them.
   */
  function expectRefused(
    label: string,
    prepare: (path: string, destination: string) => void,
    outcome: string,
    expected: { readonly class: string; readonly message: string },
  ): void {
    const { path, destination } = aDatabaseWithAGate(label);
    prepare(path, destination);
    const streams = captureStreams();
    const argv = closeArgv(path, outcome);

    const human = main(argv);
    const machine = main([...argv, "--json"]);

    expect(human, "a refused close is exit 2 without the flag").toBe(2);
    expect(machine, "--json must not change the refusal's exit code").toBe(human);
    expect(streams.out(), "a refusal writes nothing to stdout, with or without the flag").toBe("");
    const lines = streams.err().trimEnd().split("\n");
    expect(lines[0], "the human refusal line is unchanged").toBe(`error: ${expected.message}`);
    expect(
      oneDocument(`${lines[1] ?? ""}\n`),
      `gate close's ${expected.class} document changed shape`,
    ).toStrictEqual({
      schema: "continuo.gate.close/1",
      ok: false,
      db: path,
      error: { class: expected.class, message: expected.message },
    });
  }

  test("an unknown gate", () => {
    // The gate id is the one value a host supplies from its own records, so
    // this is the refusal it meets when those records and the control plane
    // have drifted apart.
    const { path } = aDatabaseWithAGate("gate-json-close-unknown");
    const streams = captureStreams();
    const argv = [
      "gate",
      "close",
      "--db",
      path,
      "--gate-id",
      "gate-nope",
      "--outcome",
      "withdrawn",
      "--actor-id",
      ACTOR,
      "--now-ms",
      String(T0 + 5 * MINUTE),
      "--json",
    ];

    expect(main(argv)).toBe(2);

    expect(streams.out(), "a refusal writes nothing to stdout").toBe("");
    expect(oneDocument(streams.err())).toStrictEqual({
      schema: "continuo.gate.close/1",
      ok: false,
      db: path,
      error: { class: "UnknownGateRefused", message: "no gate 'gate-nope'" },
    });
  });

  test("a close under a different outcome than the one on the row", () => {
    // The refusal that is NOT the idempotent replay, and the reason `closed`
    // being false is a success: which outcome a gate reached is a fact a
    // reader relies on, so a second close under another outcome is refused
    // rather than absorbed.
    expectRefused(
      "gate-json-close-conflict",
      (path) => {
        captureStreams();
        expect(main(closeArgv(path, "withdrawn"))).toBe(0);
      },
      // `unanswerable` rather than `expired`: `expired` is checked against the
      // deadline BEFORE the domain close runs, so it would refuse for a
      // different reason and this case would pin the wrong funnel.
      "unanswerable",
      {
        class: "GateClosedRefused",
        message:
          `gate ${GATE_ID} is already closed as 'withdrawn'; ` +
          "it does not become 'unanswerable'",
      },
    );
  });

  test("an outcome that is not reachable from the stage the gate stands at", () => {
    expectRefused("gate-json-close-inadmissible", () => {}, "unanswerable", {
      class: "InadmissibleTransitionRefused",
      message: "outcome 'unanswerable' is reached from ['presented'], not from 'received'",
    });
  });

  test("'expired' on a gate whose deadline has not passed", () => {
    // `D-0008`: the operator decides WHETHER a passed deadline expires a gate,
    // never whether it passed. A gate with no deadline at all is the sharpest
    // form of that, and it refuses before the domain close runs.
    expectRefused("gate-json-close-no-deadline", () => {}, "expired", {
      class: "DeadlineNotPassed",
      message: `gate ${GATE_ID} has no deadline; it does not close as 'expired'`,
    });
  });
});

describe("continuo#155: a refusal is a document too", () => {
  test("gate show --json refuses an unknown gate on stderr, exit 2, stdout empty", () => {
    // The exit code and the stream are the host contract's load-bearing half:
    // exit 2 means parse stderr. A refusal that arrived on stdout, or with a
    // different status under --json, would make which stream carries the
    // diagnosis depend on a flag.
    const { path } = aDatabaseWithAGate("gate-json-show-refused");
    const streams = captureStreams();

    expect(main(["gate", "show", "--db", path, "--gate-id", "gate-nope", "--json"])).toBe(2);

    expect(streams.out(), "a refusal writes nothing to stdout").toBe("");
    expect(oneDocument(streams.err()), "gate show's refusal document changed shape").toStrictEqual({
      schema: "continuo.gate.show/1",
      ok: false,
      db: path,
      error: { class: "UnknownGateRefused", message: "gate gate-nope does not exist" },
    });
  });

  test("gate answer --json refuses an unknown gate with the same status as without", () => {
    // The status is what a host branches on before it parses anything, so it
    // must not move: the flag changes bytes, never control flow.
    const { path } = aDatabaseWithAGate("gate-json-answer-refused");
    const streams = captureStreams();
    const argv = [
      "gate",
      "answer",
      "--db",
      path,
      "--gate-id",
      "gate-nope",
      "--body",
      "irrelevant",
      "--actor-id",
      ACTOR,
      "--now-ms",
      String(T0 + MINUTE),
    ];

    const human = main(argv);
    const machine = main([...argv, "--json"]);

    expect(machine, "--json must not change the refusal's exit code").toBe(human);
    expect(machine).toBe(2);
    expect(streams.out(), "a refusal writes nothing to stdout, with or without the flag").toBe("");
    const lines = streams.err().trimEnd().split("\n");
    expect(lines[0], "the human refusal is unchanged").toBe("error: no gate 'gate-nope'");
    expect(
      oneDocument(`${lines[1] ?? ""}\n`),
      "gate answer's refusal document changed shape",
    ).toStrictEqual({
      schema: "continuo.gate.answer/1",
      ok: false,
      db: path,
      error: { class: "UnknownGateRefused", message: "no gate 'gate-nope'" },
    });
  });

  test("gate list --json refuses a database that is not a control plane", () => {
    // The refusal a host meets first, and the one where `db` earns its place in
    // the envelope: the verb never opened anything, so nothing else in the
    // document says which control plane was meant.
    const absent = join(caseRoot("gate-json-list-refused"), "absent.sqlite3");
    const streams = captureStreams();

    expect(main(["gate", "list", "--db", absent])).toBe(2);
    const humanMessage = streams.err().trimEnd().slice("error: ".length);
    expect(main(["gate", "list", "--db", absent, "--json"])).toBe(2);

    const document = oneDocument(`${streams.err().trimEnd().split("\n")[1] ?? ""}\n`);
    expect(document, "gate list's refusal document changed shape").toStrictEqual({
      schema: "continuo.gate.list/1",
      ok: false,
      db: absent,
      error: { class: "MissingStateRefused", message: humanMessage },
    });
    expect(streams.out(), "a refusal writes nothing to stdout").toBe("");
  });
});

/**
 * Anti-vacuity: these checks, observed red.
 *
 * `AGENTS.md`: a check never seen red is not a check. Every case above would
 * stay green against a `--json` that was ignored, hardcoded, or wired into the
 * success paths only. Each case here names the hole it stands in front of and
 * fails against exactly that build.
 */
describe("the --json documents, observed red", () => {
  test("the same invocation without --json is the human line and no JSON", () => {
    // The hole: a build that ignored the flag and emitted the document always.
    // Every success case above would be green, and every operator's terminal
    // would have filled with JSON -- and rule 2 (the human bytes are unchanged)
    // would be broken without a single case going red.
    const { path } = aDatabaseWithAGate("gate-json-absent", { deadlineAtMs: T0 + MINUTE });
    const streams = captureStreams();

    expect(main(["gate", "list", "--db", path])).toBe(0);

    expect(streams.out(), "the human line must be byte-identical to what it was").toBe(
      `${GATE_ID} worker_escalation run=${RUN_ID} stage=received since=${T0} ` +
        `deadline=${T0 + MINUTE}\n`,
    );
    expect(() => JSON.parse(streams.out()), "no --json, no document").toThrow();
  });

  test("a key's value changes when the fact under it changes", () => {
    // The hole: a document built from a literal rather than from the record.
    // A `listPayload` that returned a hardcoded object would satisfy every
    // toStrictEqual above, because those cases fix the database too. Two
    // databases differing in exactly one fact, and one key differing with it,
    // is what a literal cannot fake.
    const withDeadline = aDatabaseWithAGate("gate-json-vary-deadline", {
      deadlineAtMs: T0 + 9 * MINUTE,
    });
    const withoutDeadline = aDatabaseWithAGate("gate-json-vary-none", { deadlineAtMs: null });
    const streams = captureStreams();

    expect(main(["gate", "list", "--db", withDeadline.path, "--json"])).toBe(0);
    expect(main(["gate", "list", "--db", withoutDeadline.path, "--json"])).toBe(0);

    const [first, second] = streams
      .out()
      .trimEnd()
      .split("\n")
      .map((line) => oneDocument(`${line}\n`)) as readonly {
      gates: readonly Record<string, unknown>[];
    }[];
    expect(first?.gates[0]?.["deadline_at_ms"], "the deadline must come from the row").toBe(
      T0 + 9 * MINUTE,
    );
    expect(
      second?.gates[0]?.["deadline_at_ms"],
      "the absent deadline must come from the row too",
    ).toBeNull();
    // The vacuity check on this vacuity check: the two documents differ in that
    // one key and agree everywhere else, so the assertion above is about the
    // field and not about two unrelated documents.
    expect(first?.gates[0]?.["gate_id"], "the two runs describe the same gate").toBe(
      second?.gates[0]?.["gate_id"],
    );
    expect(first?.gates[0]?.["stage_entered_at_ms"], "only the deadline differed").toBe(
      second?.gates[0]?.["stage_entered_at_ms"],
    );
  });

  test("the refusal path honours --json, and not only the success path", () => {
    // The hole rule 3 names: a build that read the flag at each success site and
    // left `refuse` alone. Every success case above would be green, and a host
    // would get a parse error at the exact moment something went wrong. The
    // same refusal, run both ways, is what tells the two builds apart.
    const { path } = aDatabaseWithAGate("gate-json-refusal-red");
    const streams = captureStreams();
    const argv = ["gate", "show", "--db", path, "--gate-id", "gate-nope"];

    expect(main(argv)).toBe(2);
    expect(main([...argv, "--json"])).toBe(2);

    const [human, machine] = streams.err().trimEnd().split("\n");
    expect(human, "without the flag the refusal is the operator's line").toBe(
      "error: gate gate-nope does not exist",
    );
    expect(machine?.startsWith("{"), "with the flag the refusal is a document").toBe(true);
    expect(
      human,
      "a refusal writer that ignored the flag would emit the same bytes twice",
    ).not.toBe(machine);
  });

  test("a gate verb with no --json flag refuses exactly as it did before", () => {
    // The hole: `refuse` is shared by all eight verbs, and teaching it the flag
    // could have changed the five that never opted in -- the worst kind of
    // regression, because it lands on the verbs this task was told not to
    // touch. `gate present` is one of them: same line, same status.
    const { path } = aDatabaseWithAGate("gate-json-out-of-scope");
    const streams = captureStreams();

    expect(main(["gate", "present", "--db", path, "--gate-id", "gate-nope"])).toBe(2);

    expect(streams.err(), "an out-of-scope verb's refusal must be byte-identical").toBe(
      "error: gate gate-nope does not exist\n",
    );
    expect(streams.out(), "and it writes nothing to stdout").toBe("");
  });

  test("--json is mounted on the four verbs a host drives, and on no others", () => {
    // The vacuity check on the vacuity checks: a flag mounted everywhere would
    // satisfy the cases above (nothing here asserts the parser REFUSES it
    // elsewhere), and a flag mounted nowhere would fail them all for one
    // reason. This states the boundary itself -- four in, four out (`D-0092`
    // moved `close` across it, and moved nothing else).
    const usage: string[] = [];
    patchSeam(topLevelSeams, "err", (text: string) => {
      usage.push(text);
    });
    const { path } = aDatabaseWithAGate("gate-json-mount");
    captureStreams();

    for (const argv of [
      ["gate", "present", "--db", path, "--gate-id", GATE_ID],
      ["gate", "deliver", "--db", path, "--destination-dir", path, "--holder", ACTOR],
      ["gate", "ack", "--db", path, "--message-id", "m-1", "--actor-id", ACTOR],
      ["gate", "reconcile", "--db", path, "--actor-id", ACTOR],
    ]) {
      const before = usage.length;
      expect(
        main([...argv, "--json"]),
        `${argv[1]} must not accept a flag it does not implement`,
      ).toBe(2);
      expect(
        usage.slice(before).join(""),
        `${argv[1]}'s rejection must be the parser's, naming the flag`,
      ).toContain("--json");
    }

    // And the four that DO carry it reach their handler rather than the
    // parser: without this half, deleting every `addJsonArgument` call in this
    // subtree would leave the loop above green.
    for (const argv of [
      ["gate", "list", "--db", path],
      ["gate", "show", "--db", path, "--gate-id", GATE_ID],
      ["gate", "answer", "--db", path, "--gate-id", GATE_ID, "--body", "b", "--actor-id", ACTOR],
      closeArgv(path, "withdrawn"),
    ]) {
      const before = usage.length;
      main([...argv, "--json"]);
      expect(
        usage.slice(before).join(""),
        `${argv[1]} must accept the flag the envelope promises`,
      ).toBe("");
    }
  });

  test("a disallowed --outcome stays usage prose, even with --json", () => {
    // `D-0090`'s parser-level exception, at the one verb where an operator can
    // trip it: argparse's `choices` refuses before the handler runs, so there
    // is no report to write the refusal through and exit 2 does NOT guarantee
    // a parseable document. A case that asserted a document here would be
    // asserting a promise `D-0092` deliberately does not make.
    const usage: string[] = [];
    patchSeam(topLevelSeams, "err", (text: string) => {
      usage.push(text);
    });
    const { path } = aDatabaseWithAGate("gate-json-close-bad-outcome");
    const streams = captureStreams();

    expect(main([...closeArgv(path, "answered_and_forwarded"), "--json"])).toBe(2);

    expect(usage.join(""), "the parser's own words reach the top-level seam").toContain(
      "--outcome",
    );
    expect(streams.out(), "nothing reaches stdout").toBe("");
    expect(streams.err(), "and the verb's own refusal writer never ran").toBe("");
  });
});
