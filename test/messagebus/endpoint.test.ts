import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";

import { Endpoint, EndpointConfig } from "../../src/messagebus/endpoint.js";
import { createTempDir } from "../helpers/tmp.js";
import { type BusEnv, EPOCH, HOLDER, makeBusEnv, RECIPIENT, RESOURCE, RUN_ID } from "./_env.js";

/**
 * S8 -- the MCP endpoint: the acceptance sequence over the actual transport.
 *
 * Ported from interlock `tests/messagebus/test_endpoint.py` at `65f36c5`. The
 * mapping is `parity/messagebus.endpoint.ledger.json`.
 *
 * Two layers, on purpose. The in-process tests drive `Endpoint.handle` directly,
 * so every JSON-RPC branch is reachable without process management. The
 * end-to-end test then runs the whole item 6 sequence -- send, first delivery
 * dropped, resend, exactly one ack -- against a real
 * `node dist/messagebus/endpoint.js` child over real stdio, with the drop
 * injected at the transport boundary (`INTERLOCK_MESSAGEBUS_FAULT=
 * drop-first-poll`), because "worker-outbound MCP endpoint" is a claim about a
 * wire and one test should contain an actual wire.
 *
 * The child is the **built** module, not the TypeScript source: the source's
 * `python -m claude_org_runtime.messagebus.endpoint` runs the module a consumer
 * would run, and here that is `dist/`. `npm run pretest` builds it, and the two
 * process cases say so rather than failing obscurely if it is missing --
 * `test/measurement/cli.test.ts` sets the same precedent for `dist/cli.js`.
 */

const HOUR_MS = 3_600_000;

/** The built endpoint module, which is what a worker's MCP config launches. */
const ENDPOINT_ENTRY = fileURLToPath(new URL("../../dist/messagebus/endpoint.js", import.meta.url));

function nowMs(): number {
  return Math.trunc(Date.now());
}

function config(overrides: Readonly<Record<string, string>> = {}): EndpointConfig {
  return new EndpointConfig({
    INTERLOCK_MESSAGEBUS_DB: "unused-in-process",
    INTERLOCK_MESSAGEBUS_RESOURCE: RESOURCE,
    INTERLOCK_MESSAGEBUS_HOLDER: HOLDER,
    INTERLOCK_MESSAGEBUS_EPOCH: String(EPOCH),
    INTERLOCK_MESSAGEBUS_RECIPIENT: RECIPIENT,
    INTERLOCK_MESSAGEBUS_DESTINATION_DIR: "unused-in-process",
    ...overrides,
  });
}

/**
 * The source's `rt_env` fixture, plus the root it was built under.
 *
 * The root is returned because the two process cases put the child's
 * destination directory inside it -- the child publishes effects into the same
 * directory the parent's dropbox reads, so `effectCount` below is the child's
 * ledger and not a second one that happens to agree.
 */
function rtEnv(label: string): { env: BusEnv; root: string } {
  const root = createTempDir(label);
  const env = makeBusEnv(root, "endpoint", { nowMs: nowMs(), ttlMs: HOUR_MS });
  onTestFinished(() => {
    env.close();
  });
  return { env, root };
}

function send(env: BusEnv, messageId = "task-1") {
  return env.bus.send({
    messageId,
    recipient: RECIPIENT,
    payload: '{"task":"t"}',
    dedupKey: `dk-${messageId}`,
    nowMs: nowMs(),
    epoch: EPOCH,
    runId: RUN_ID,
  });
}

/** `tools/call`, with the tool's own payload decoded out of the content block. */
function call(
  endpoint: Endpoint,
  name: string,
  argumentsGiven: Record<string, unknown> = {},
  mid = 1,
): Record<string, unknown> {
  const response = endpoint.handle({
    jsonrpc: "2.0",
    id: mid,
    method: "tools/call",
    params: { name, arguments: argumentsGiven },
  });
  const result = (response as Record<string, unknown>)["result"] as Record<string, unknown>;
  const content = result["content"] as { text: string }[];
  if (result["isError"] === true) {
    return { error: content[0]?.text ?? "" };
  }
  return JSON.parse(content[0]?.text ?? "null") as Record<string, unknown>;
}

/** Everything the child needs, minus whatever this case overrides. */
function childEnv(env: BusEnv, overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    INTERLOCK_MESSAGEBUS_DB: env.dbPath,
    INTERLOCK_MESSAGEBUS_RESOURCE: RESOURCE,
    INTERLOCK_MESSAGEBUS_HOLDER: HOLDER,
    INTERLOCK_MESSAGEBUS_EPOCH: String(EPOCH),
    INTERLOCK_MESSAGEBUS_RECIPIENT: RECIPIENT,
    ...overrides,
  };
}

function requireBuiltEndpoint(): void {
  expect(
    existsSync(ENDPOINT_ENTRY),
    "dist/messagebus/endpoint.js is missing: this case drives the built endpoint as a " +
      "subprocess, and `npm run pretest` builds it",
  ).toBe(true);
}

/** A minimal line-delimited JSON-RPC client over a child's stdio. */
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
   * The next output line.
   *
   * `readline()` on a blocking pipe becomes a promise here, and the source's
   * `assert line, "endpoint closed stdout unexpectedly"` becomes a rejection on
   * `close` -- otherwise a child that died would leave this hanging until the
   * file's timeout, reporting a timeout instead of the death that caused it.
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
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id: this._nextId, method };
    if (params !== undefined) {
      msg["params"] = params;
    }
    this.write(msg);
    const response = JSON.parse(await this.readLine()) as Record<string, unknown>;
    expect(response["id"]).toBe(this._nextId);
    return response;
  }

  notify(method: string): void {
    this.write({ jsonrpc: "2.0", method });
  }

  async callTool(
    name: string,
    argumentsGiven: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.request("tools/call", { name, arguments: argumentsGiven });
    const result = response["result"] as Record<string, unknown>;
    const content = result["content"] as { text: string }[];
    return JSON.parse(content[0]?.text ?? "null") as Record<string, unknown>;
  }

  write(msg: Record<string, unknown>): void {
    this._process.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  writeRaw(line: string): void {
    this._process.stdin.write(line);
  }
}

describe("the worker-outbound MCP endpoint", () => {
  // ------------------------------------------------------------- in-process

  test("initialize declares a tool surface", () => {
    const { env } = rtEnv("ep-init");
    const endpoint = new Endpoint(env.bus, config());
    const response = endpoint.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const result = (response as Record<string, unknown>)["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2025-06-18");
    expect(result["capabilities"]).toEqual({ tools: {} });
    const listed = endpoint.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = ((listed as Record<string, unknown>)["result"] as Record<string, unknown>)[
      "tools"
    ] as { name: string }[];
    expect(tools.map((t) => t.name)).toEqual(["poll", "ack"]);
  });

  test("poll then ack over the tool surface", () => {
    const { env } = rtEnv("ep-poll-ack");
    const endpoint = new Endpoint(env.bus, config());
    send(env);
    const first = call(endpoint, "poll");
    expect((first["messages"] as { message_id: string }[]).map((m) => m.message_id)).toEqual([
      "task-1",
    ]);
    const acked = call(endpoint, "ack", { message_id: "task-1" });
    expect(acked["recorded"]).toBe(true);
    expect(call(endpoint, "poll")["messages"]).toEqual([]);
  });

  test("the drop-first-poll fault loses the response, not the message", () => {
    // The wire-drop, observed from both sides of the boundary.
    //
    // The faulted first poll answers empty -- the worker saw nothing -- while
    // the database already says delivered: exactly the state a response lost on
    // the wire leaves behind. The next poll re-presents, and one ack settles it.
    const { env } = rtEnv("ep-drop");
    const endpoint = new Endpoint(
      env.bus,
      config({ INTERLOCK_MESSAGEBUS_FAULT: "drop-first-poll" }),
    );
    send(env);
    const first = call(endpoint, "poll");
    expect(first).toEqual({ messages: [], fault: "drop-first-poll" });
    expect(env.outboxStatus("task-1")).toBe("delivered");
    const second = call(endpoint, "poll");
    const messages = second["messages"] as { message_id: string; deduplicated: boolean }[];
    expect(messages.map((m) => m.message_id)).toEqual(["task-1"]);
    expect(messages[0]?.deduplicated).toBe(true);
    expect(call(endpoint, "ack", { message_id: "task-1" })["recorded"]).toBe(true);
    expect(env.effectCount("dk-task-1")).toBe(1);
  });

  test("a notification never gets a response", () => {
    // JSON-RPC framing: a message without an id must produce no output line.
    //
    // Answering a notification -- even with "id": null -- puts a stray line on
    // stdout that the client matches against its next request, and the stream is
    // desynchronised from then on.
    const { env } = rtEnv("ep-notify");
    const endpoint = new Endpoint(env.bus, config());
    for (const method of ["notifications/initialized", "ping", "tools/list", "nonsense"]) {
      expect(endpoint.handle({ jsonrpc: "2.0", method })).toBeNull();
    }
    const ponged = endpoint.handle({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(ponged).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  test("malformed params are answered, not fatal", () => {
    // Invalid params get -32602 and the endpoint keeps serving.
    const { env } = rtEnv("ep-malformed");
    const endpoint = new Endpoint(env.bus, config());
    for (const bad of [[], "x", 7]) {
      for (const method of ["initialize", "tools/call"]) {
        const response = endpoint.handle({ jsonrpc: "2.0", id: 1, method, params: bad });
        const error = (response as Record<string, unknown>)["error"] as Record<string, unknown>;
        expect(error["code"]).toBe(-32602);
      }
    }
    const badArgs = endpoint.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "poll", arguments: [] },
    });
    expect(((badArgs as Record<string, unknown>)["error"] as Record<string, unknown>)["code"]).toBe(
      -32602,
    );
    const badProto = endpoint.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "initialize",
      params: { protocolVersion: ["2025-06-18"] },
    });
    expect(
      ((badProto as Record<string, unknown>)["result"] as Record<string, unknown>)[
        "protocolVersion"
      ],
    ).toBe("2025-06-18");
    const alive = endpoint.handle({ jsonrpc: "2.0", id: 3, method: "ping" });
    expect(alive).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  test("a refusal surfaces as a tool error, not a crash", () => {
    const { env } = rtEnv("ep-refusal");
    const endpoint = new Endpoint(env.bus, config());
    send(env);
    const refused = call(endpoint, "ack", { message_id: "task-1" });
    expect(refused["error"]).toBeDefined();
    // The source asserts `ValueError`, which is what the outbox raises there.
    // continuo's outbox names that refusal `OutboxUsageError` -- the class is
    // the thing a caller acts on, so the assertion follows the class rather
    // than the word.
    expect(String(refused["error"])).toContain("OutboxUsageError");
    const unknown = endpoint.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(((unknown as Record<string, unknown>)["error"] as Record<string, unknown>)["code"]).toBe(
      -32602,
    );
  });

  // ------------------------------------------------------------- end to end

  test("an unregistered recipient refuses to start", () => {
    // A typo'd recipient must die at startup, not poll an empty queue forever.
    requireBuiltEndpoint();
    const { env, root } = rtEnv("ep-typo");
    const done = spawnSync(process.execPath, [ENDPOINT_ENTRY], {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv(env, {
        INTERLOCK_MESSAGEBUS_RECIPIENT: "typo-nobody",
        INTERLOCK_MESSAGEBUS_DESTINATION_DIR: join(root, "dest-typo"),
      }),
      timeout: 30_000,
      encoding: "utf-8",
    });
    expect(done.status).toBe(2);
    expect(done.stderr).toContain("no registered handler");
  });

  test("the acceptance sequence end to end over stdio", async () => {
    // interlock item 6's headline case with a real child process on the wire.
    requireBuiltEndpoint();
    const { env, root } = rtEnv("ep-e2e");
    send(env);

    const child = spawn(process.execPath, [ENDPOINT_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv(env, {
        // The child publishes effects into the same destination directory the
        // parent's dropbox reads, so effectCount below is the child's ledger.
        INTERLOCK_MESSAGEBUS_DESTINATION_DIR: join(root, "destination-endpoint"),
        INTERLOCK_MESSAGEBUS_FAULT: "drop-first-poll",
      }),
    }) as ChildProcessWithoutNullStreams;
    const exited = new Promise<number | null>((resolve) => {
      child.once("close", (code) => {
        resolve(code);
      });
    });
    onTestFinished(async () => {
      child.kill();
      await exited;
    });

    const client = new Client(child);
    const initialized = await client.request("initialize", { protocolVersion: "2025-06-18" });
    const serverInfo = (
      (initialized["result"] as Record<string, unknown>)["serverInfo"] as Record<string, unknown>
    )["name"];
    expect(serverInfo).toBe("interlock-messagebus");
    client.notify("notifications/initialized");

    // A mangled line is answered (id null) rather than ignored, so a client
    // waiting on it fails fast -- and the transport stays up.
    client.writeRaw("not-json\n");
    const parseError = JSON.parse(await client.readLine()) as Record<string, unknown>;
    expect(parseError["id"]).toBeNull();
    expect((parseError["error"] as Record<string, unknown>)["code"]).toBe(-32700);
    client.writeRaw("[1, 2]\n");
    const invalid = JSON.parse(await client.readLine()) as Record<string, unknown>;
    expect(invalid["id"]).toBeNull();
    expect((invalid["error"] as Record<string, unknown>)["code"]).toBe(-32600);

    const dropped = await client.callTool("poll");
    expect(dropped).toEqual({ messages: [], fault: "drop-first-poll" });

    const resent = await client.callTool("poll");
    expect((resent["messages"] as { message_id: string }[]).map((m) => m.message_id)).toEqual([
      "task-1",
    ]);

    expect((await client.callTool("ack", { message_id: "task-1" }))["recorded"]).toBe(true);
    expect((await client.callTool("ack", { message_id: "task-1" }))["recorded"]).toBe(false);

    expect((await client.callTool("poll"))["messages"]).toEqual([]);

    child.stdin.end();
    expect(await exited).toBe(0);

    expect(env.effectCount("dk-task-1")).toBe(1);
    expect(env.outboxStatus("task-1")).toBe("acked");
  });
});
