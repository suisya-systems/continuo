import { join } from "node:path";
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
  options: { readonly deadlineAtMs?: number | null } = {},
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
      runId: RUN_ID,
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
