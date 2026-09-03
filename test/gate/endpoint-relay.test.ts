import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { KeyedDropbox } from "../../src/control_plane/destination.js";
import { openGate } from "../../src/control_plane/gates.js";
import { acquire } from "../../src/control_plane/lease.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import {
  answerGate,
  GATE_RELAY_RECIPIENT,
  gateDetail,
  presentGate,
  reconcile,
  relayMessageId,
} from "../../src/gate/operator.js";
import { DELIVERY_LEASE_RESOURCE } from "../../src/messagebus/endpoint.js";
import { caseRoot } from "../testkit/cases.js";

/**
 * Both relays reach a recipient a **real endpoint process** serves.
 *
 * Issue #108's second acceptance criterion, and the one no in-process case can
 * discharge. `test/gate/operator.test.ts` drives delivery through
 * `deliverRelays`, which builds the registry itself -- so it would stay green
 * against a recipient the shipped endpoint refuses at startup, and the failure
 * would arrive as a worker polling an eternally empty queue while the gate sat
 * at `received` for ever. This case puts the built `dist/messagebus/endpoint.js`
 * on the wire and asks it for the messages instead, which is the only reading of
 * "addressed to a recipient the endpoint actually serves" that cannot be true by
 * construction (`D-0076`).
 *
 * It also shows the other half of the split `D-0080` records. The endpoint acks
 * over MCP and stops there -- the outbox row is `acked` and the gate has not
 * moved -- because advancing a gate is not a delivery worker's business. The
 * step that turns that ack into a stage is the reconcile pass, called here
 * exactly as `gate reconcile` calls it. So the two paths meet on one gate: the
 * relay is delivered and acked by the recipient's own process, and the control
 * plane's own pass completes what the ack justified.
 *
 * `dist/` rather than `src/`: the endpoint is a process, and the process an
 * operator runs is the built one. `npm run pretest` builds it, and
 * `test/messagebus/endpoint.test.ts` sets the precedent.
 */

const ENDPOINT_ENTRY = fileURLToPath(new URL("../../dist/messagebus/endpoint.js", import.meta.url));

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const GATE_ID = "gate-1";
const RUN_ID = "run-1";
const ACTOR = "operator-1";
const HOLDER = "endpoint-holder";

/** A minimal line-delimited JSON-RPC client over the child's stdio. */
class Client {
  private readonly _process: ChildProcessWithoutNullStreams;
  private _nextId = 0;
  private _pending = "";
  private readonly _lines: string[] = [];
  private _waiting: ((line: string) => void) | null = null;

  constructor(child: ChildProcessWithoutNullStreams) {
    this._process = child;
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      this._pending += chunk;
      for (;;) {
        const newline = this._pending.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = this._pending.slice(0, newline);
        this._pending = this._pending.slice(newline + 1);
        const waiting = this._waiting;
        if (waiting !== null) {
          this._waiting = null;
          waiting(line);
        } else {
          this._lines.push(line);
        }
      }
    });
  }

  /**
   * The next output line, or a rejection if the child died first.
   *
   * The rejection matters: a child that exited would otherwise leave this
   * pending until the file's timeout, reporting a timeout instead of the death
   * that caused it -- and a `FATAL:` startup refusal is exactly the death this
   * case exists to catch.
   */
  readLine(): Promise<string> {
    const buffered = this._lines.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    return new Promise((resolve, reject) => {
      this._waiting = resolve;
      this._process.once("close", () => {
        if (this._waiting !== null) {
          this._waiting = null;
          reject(new Error("endpoint closed stdout unexpectedly"));
        }
      });
    });
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this._nextId += 1;
    const message: Record<string, unknown> = { jsonrpc: "2.0", id: this._nextId, method };
    if (params !== undefined) {
      message["params"] = params;
    }
    this._process.stdin.write(`${JSON.stringify(message)}\n`);
    const response = JSON.parse(await this.readLine()) as Record<string, unknown>;
    expect(response["id"]).toBe(this._nextId);
    return response;
  }

  notify(method: string): void {
    this._process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async callTool(
    name: string,
    argumentsGiven: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.request("tools/call", { name, arguments: argumentsGiven });
    const result = response["result"] as Record<string, unknown>;
    const content = result["content"] as { text: string }[];
    // An `isError` payload is the endpoint reporting a refusal verbatim; it is
    // surfaced rather than parsed as a result, so a fence refusal reads as
    // itself instead of as a JSON parse failure.
    expect(result["isError"], content[0]?.text ?? "").not.toBe(true);
    return JSON.parse(content[0]?.text ?? "null") as Record<string, unknown>;
  }
}

/** The world one case runs in: a control plane with an open gate, and a lease. */
function world(label: string): {
  readonly dbPath: string;
  readonly destination: string;
  readonly connection: SqliteDatabase;
  readonly epoch: number;
} {
  const root = caseRoot(label);
  const dbPath = join(root, "control-plane.sqlite3");
  createProductionControlPlane(dbPath, { nowMs: T0 }).close();
  const connection = openProductionControlPlane(dbPath);
  onTestFinished(() => {
    connection.close();
  });
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
    deadlineAtMs: null,
    runId: RUN_ID,
  });
  // The endpoint writes under a lease it does not take itself: its epoch is
  // handed to it in the environment, exactly as `lap perform` hands it one it
  // acquired and renews (`D-0072`).
  //
  // This is the one place a case here reads the wall clock, and it must: the
  // child is a real process and fences its writes against the system clock, so
  // a lease taken at {@link T0} -- an instant years in the past -- is a lease
  // the endpoint finds expired on its first attempt. The gate's own timestamps
  // stay arithmetic on T0, because nothing fences those.
  const lease = acquire(connection, {
    resource: DELIVERY_LEASE_RESOURCE,
    holder: HOLDER,
    nowMs: Date.now(),
    ttlMs: 3_600_000,
  });
  return { dbPath, destination: join(root, "destination"), connection, epoch: lease.epoch };
}

/** The built endpoint, serving one recipient over stdio. */
function startEndpoint(dbPath: string, destination: string, epoch: number): Client {
  expect(
    existsSync(ENDPOINT_ENTRY),
    "dist/messagebus/endpoint.js is missing: this case drives the built endpoint as a " +
      "subprocess, and `npm run pretest` builds it",
  ).toBe(true);
  const child = spawn(process.execPath, [ENDPOINT_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      INTERLOCK_MESSAGEBUS_DB: dbPath,
      INTERLOCK_MESSAGEBUS_RESOURCE: DELIVERY_LEASE_RESOURCE,
      INTERLOCK_MESSAGEBUS_HOLDER: HOLDER,
      INTERLOCK_MESSAGEBUS_EPOCH: String(epoch),
      INTERLOCK_MESSAGEBUS_RECIPIENT: GATE_RELAY_RECIPIENT,
      INTERLOCK_MESSAGEBUS_DESTINATION_DIR: destination,
    },
  }) as ChildProcessWithoutNullStreams;
  const stderr: string[] = [];
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderr.push(chunk);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      resolve(code);
    });
  });
  onTestFinished(async () => {
    child.kill();
    await exited;
    // A startup refusal is the failure this case is about, so it is asserted
    // rather than left in a pipe nobody reads: `FATAL: ... has no registered
    // handler` is precisely what a relay addressed to an unserved recipient
    // would produce.
    expect(stderr.join("")).not.toContain("FATAL:");
  });
  return new Client(child);
}

describe("both relays reach a recipient the endpoint serves", () => {
  test("the endpoint delivers and acks both relays, and reconcile closes the gate", async () => {
    const { dbPath, destination, connection, epoch } = world("gate-endpoint");
    const presented = presentGate(connection, { gateId: GATE_ID, nowMs: T0 + MINUTE });
    expect(presented.messageId).toBe(relayMessageId(GATE_ID, "presented"));

    const client = startEndpoint(dbPath, destination, epoch);
    const initialized = await client.request("initialize", { protocolVersion: "2025-06-18" });
    expect(
      ((initialized["result"] as Record<string, unknown>)["serverInfo"] as Record<string, unknown>)[
        "name"
      ],
    ).toBe("interlock-messagebus");
    client.notify("notifications/initialized");

    // The presented relay, pulled by the process that serves the recipient it
    // was addressed to. A relay addressed to anything else would arrive here as
    // an empty message list -- the endpoint is pinned to one recipient -- so
    // this assertion is the one D-0076 is falsifiable by.
    const firstPoll = await client.callTool("poll");
    expect(
      (firstPoll["messages"] as { message_id: string; payload: string }[]).map(
        (message) => message.message_id,
      ),
    ).toEqual([presented.messageId]);
    expect((firstPoll["messages"] as { payload: string }[])[0]?.payload).toContain("force-push");

    expect((await client.callTool("ack", { message_id: presented.messageId }))["recorded"]).toBe(
      true,
    );
    // The endpoint acked and stopped. Advancing a gate is not a delivery
    // worker's business, so the stage has not moved yet -- and that is the
    // state the reconcile pass exists for rather than a defect.
    expect(gateDetail(connection, GATE_ID).stage).toBe("received");

    expect(
      reconcile(connection, { nowMs: T0 + 2 * MINUTE, actorId: ACTOR }).advanced.map(
        (row) => row.toStage,
      ),
    ).toEqual(["presented"]);

    const answered = answerGate(connection, {
      gateId: GATE_ID,
      body: "force-push, and record why",
      actorId: ACTOR,
      nowMs: T0 + 3 * MINUTE,
    });

    const secondPoll = await client.callTool("poll");
    expect(
      (secondPoll["messages"] as { message_id: string }[]).map((message) => message.message_id),
    ).toEqual([answered.messageId]);
    expect((await client.callTool("ack", { message_id: answered.messageId }))["recorded"]).toBe(
      true,
    );

    const finished = reconcile(connection, { nowMs: T0 + 4 * MINUTE, actorId: ACTOR });
    expect(finished.closed).toEqual([GATE_ID]);
    expect(gateDetail(connection, GATE_ID).outcome).toBe("answered_and_forwarded");

    // The effects are the child's, in the child's own destination directory:
    // two relays, two keys, one effect each.
    const dropbox = new KeyedDropbox(destination, "case");
    for (const stage of ["presented", "forwarded"]) {
      expect(
        dropbox.effectCount(`${GATE_RELAY_RECIPIENT}:notify:gate/${GATE_ID}/${stage}`),
        stage,
      ).toBe(1);
    }
  });
});
