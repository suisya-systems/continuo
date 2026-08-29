import { realpathSync } from "node:fs";
import process from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { KeyedDropbox } from "../control_plane/destination.js";
import { NOTIFY_RECIPIENT, spikeRegistry } from "../control_plane/handlers.js";
import { pythonJsonDocumentSorted } from "../control_plane/python_json.js";
import { pythonRepr } from "../control_plane/python_repr.js";
import { openControlPlane } from "../control_plane/schema.js";
import { type DeliveredEnvelope, MessageBus } from "./bus.js";

/**
 * S8 -- the worker-outbound MCP endpoint over one {@link MessageBus}.
 *
 * **Spike scaffold, throwaway by default (interlock D-0026).** The MCP surface
 * here is the minimum that makes "worker-outbound" a demonstrated fact rather
 * than a diagram: a stdio server a worker connects to as a client, exposing
 * exactly the two verbs a recipient has -- `poll` and `ack`.
 *
 * Ported from interlock `src/claude_org_runtime/messagebus/endpoint.py` at
 * `65f36c5`.
 *
 * **Why worker-outbound.** Per interlock's F1 there is no non-interactive path
 * to deliver a message *into* a running background session, so delivery is a
 * pull: the worker runs this endpoint as one of its MCP servers and calls
 * `poll`. Nothing here pushes, nudges, or injects; an idle worker that never
 * polls simply leaves its rows due, visible to any operator via the outbox
 * tables.
 *
 * **Transport shape.** Line-delimited JSON-RPC over stdio (one message per
 * line). Unlike a push channel this server *does* declare tools -- it is a tool
 * surface.
 *
 * **Configuration is env-driven** (no argument parser; the worker's MCP config
 * sets env), all ASCII. The variable names are interlock's, unchanged, for the
 * reason `STATE_FILE_ENV` in `src/session/stub_provider.ts` keeps its
 * `INTERLOCK_` prefix: the name is a wire contract with a worker's MCP
 * configuration, and renaming it would be a divergence that buys nothing.
 *
 * - `INTERLOCK_MESSAGEBUS_DB` -- path to the control-plane SQLite database.
 * - `INTERLOCK_MESSAGEBUS_RESOURCE` / `INTERLOCK_MESSAGEBUS_HOLDER` /
 *   `INTERLOCK_MESSAGEBUS_EPOCH` -- the lease identity this endpoint's writes
 *   are fenced under. The endpoint does not acquire or renew the lease; lease
 *   orchestration is the control plane's, and a stale epoch surfaces as
 *   `StaleWriterRefused` out of `poll`, refused durably.
 * - `INTERLOCK_MESSAGEBUS_RECIPIENT` -- the one recipient this endpoint serves.
 *   `poll` is pinned to it; a worker cannot pull another recipient's queue
 *   through this surface.
 * - `INTERLOCK_MESSAGEBUS_DESTINATION_DIR` -- directory for the spike
 *   destination ({@link KeyedDropbox}) behind the registered handler.
 * - `INTERLOCK_MESSAGEBUS_FAULT` -- test-only fault injection.
 *   `drop-first-poll`: the first `poll` runs its delivery attempts (rows become
 *   delivered-but-unacked) but the response body reports no messages -- the
 *   wire-drop of a first delivery, reproduced at the transport boundary so the
 *   resend-and-single-ack acceptance case runs end to end over real stdio.
 *
 * **No session edge.** This module, like the rest of the package, imports
 * nothing from `src/session/`. It has no idea whether the worker polling it is
 * alive, wedged, or replaced; it does not want to know, and the static
 * assertion in `test/messagebus/import-graph.test.ts` makes not knowing a
 * build-enforced property.
 */

const _SUPPORTED_PROTO: ReadonlySet<string> = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const _DEFAULT_PROTO = "2025-06-18";

const _FAULT_DROP_FIRST_POLL = "drop-first-poll";

/** The two verbs a recipient has, as MCP tool descriptors. */
const _TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  Object.freeze({
    name: "poll",
    description:
      "Pull every message currently due for this endpoint's recipient. " +
      "Each returned message is marked delivered; call ack per message " +
      "once it is handled. An unacked message is presented again on the " +
      "next poll.",
    inputSchema: { type: "object", properties: {} },
  }),
  Object.freeze({
    name: "ack",
    description:
      "Settle one delivered message by id. Idempotent: repeating an ack " +
      "changes nothing and reports recorded=false.",
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "string" } },
      required: ["message_id"],
    },
  }),
]);

/**
 * The wire spelling of one presented message.
 *
 * The source emits `dataclasses.asdict(envelope)`, whose keys are the Python
 * field names. This package's TypeScript surface is camelCase like the rest of
 * the port, but **the wire is not the API**: these keys are what an MCP client
 * configured against interlock already parses, and `message_id` is the argument
 * name the `ack` tool's own `inputSchema` declares. So the rename stops at the
 * transport boundary and is written out here rather than falling out of a
 * serializer.
 */
function envelopeToWire(envelope: DeliveredEnvelope): Record<string, unknown> {
  return {
    message_id: envelope.messageId,
    recipient: envelope.recipient,
    payload: envelope.payload,
    dedup_key: envelope.dedupKey,
    retry_count: envelope.retryCount,
    deduplicated: envelope.deduplicated,
    receipt_ref: envelope.receiptRef,
  };
}

/** `int(...)` over an env value: the whole string, or nothing. */
function parseEpoch(raw: string): number | null {
  // Python's `int()` accepts surrounding whitespace, a sign, and `_` separators
  // **between digits**; it rejects everything else -- notably a float spelling,
  // which `Number("1.5")` would accept and silently truncate elsewhere.
  //
  // The separator rule is checked BEFORE the underscores are removed, not after.
  // Stripping first would turn `_1`, `1_` and `1__0` -- all of which `int()`
  // refuses -- into valid epochs, and an epoch is a fencing token: a malformed
  // one that parses is a writer fenced under a number nobody wrote, where
  // `missing()` should have refused to start at all.
  const text = raw.trim();
  if (!/^[+-]?\d+(?:_\d+)*$/.test(text)) {
    return null;
  }
  const value = Number(text.replace(/_/g, ""));
  return Number.isSafeInteger(value) ? value : null;
}

/** The env contract, read once and validated loudly. */
export class EndpointConfig {
  readonly dbPath: string;
  readonly resource: string;
  readonly holder: string;
  readonly recipient: string;
  readonly destinationDir: string;
  readonly fault: string;
  readonly epoch: number | null;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.dbPath = env["INTERLOCK_MESSAGEBUS_DB"] ?? "";
    this.resource = env["INTERLOCK_MESSAGEBUS_RESOURCE"] ?? "";
    this.holder = env["INTERLOCK_MESSAGEBUS_HOLDER"] ?? "";
    this.recipient = env["INTERLOCK_MESSAGEBUS_RECIPIENT"] ?? NOTIFY_RECIPIENT;
    this.destinationDir = env["INTERLOCK_MESSAGEBUS_DESTINATION_DIR"] ?? "";
    this.fault = env["INTERLOCK_MESSAGEBUS_FAULT"] ?? "";
    this.epoch = parseEpoch(env["INTERLOCK_MESSAGEBUS_EPOCH"] ?? "");
  }

  /** The env names that are unset or unusable, in the source's order. */
  missing(): string[] {
    const gaps: string[] = [];
    if (!this.dbPath) {
      gaps.push("INTERLOCK_MESSAGEBUS_DB");
    }
    if (!this.resource) {
      gaps.push("INTERLOCK_MESSAGEBUS_RESOURCE");
    }
    if (!this.holder) {
      gaps.push("INTERLOCK_MESSAGEBUS_HOLDER");
    }
    if (this.epoch === null) {
      gaps.push("INTERLOCK_MESSAGEBUS_EPOCH (unset or not an integer)");
    }
    if (!this.destinationDir) {
      gaps.push("INTERLOCK_MESSAGEBUS_DESTINATION_DIR");
    }
    return gaps;
  }
}

function nowMs(): number {
  return Math.trunc(Date.now());
}

/** A JSON-RPC message, before anything has been believed about its shape. */
type JsonRpcMessage = Readonly<Record<string, unknown>>;

/** `isinstance(value, dict)`: an object, not null, and not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON-RPC message handler; transport-free so tests can drive it. */
export class Endpoint {
  private readonly _bus: MessageBus;
  private readonly _config: EndpointConfig;
  private _pollsAnswered = 0;

  constructor(bus: MessageBus, config: EndpointConfig) {
    this._bus = bus;
    this._config = config;
  }

  // ----------------------------------------------------------------- tools

  private _toolPoll(): Record<string, unknown> {
    const envelopes = this._bus.poll(this._config.recipient, {
      nowMs: nowMs(),
      // A config with no epoch never reaches here: main() refuses to start.
      epoch: this._config.epoch ?? 0,
      // Re-read for every attempt: a poll that spans the lease expiry must be
      // fenced at the write it is actually making, not at the instant it
      // started.
      clock: nowMs,
    });
    this._pollsAnswered += 1;
    if (this._config.fault === _FAULT_DROP_FIRST_POLL && this._pollsAnswered === 1) {
      // The attempts above already ran: the rows are delivered and unacked,
      // exactly as if this response were lost on the wire.
      return { messages: [], fault: _FAULT_DROP_FIRST_POLL };
    }
    return { messages: envelopes.map(envelopeToWire) };
  }

  private _toolAck(argumentsGiven: Record<string, unknown>): Record<string, unknown> {
    const raw = argumentsGiven["message_id"];
    const messageId = typeof raw === "string" ? raw : "";
    const outcome = this._bus.ack(messageId, {
      nowMs: nowMs(),
      recipient: this._config.recipient,
    });
    return {
      message_id: outcome.messageId,
      recorded: outcome.recorded,
      acked_at_ms: outcome.ackedAtMs,
      clock_clamped: outcome.clockClamped,
    };
  }

  // -------------------------------------------------------------- JSON-RPC

  handle(msg: JsonRpcMessage): Record<string, unknown> | null {
    const method = msg["method"];
    if (!("id" in msg)) {
      // A JSON-RPC notification never receives a response; answering one (even
      // with "id": null) desynchronises the stdio stream, because the client
      // matches the stray line against its next request. The only notification
      // this server cares about, initialized, needs no action here; every other
      // one is ignored.
      return null;
    }
    const mid = msg["id"];

    const rawParams = msg["params"];
    const params = rawParams === undefined || rawParams === null ? {} : rawParams;
    if (!isPlainObject(params)) {
      // A long-running endpoint must answer malformed parameters, not die of
      // them: an array or scalar params is the caller's error, reported as
      // invalid params with the transport intact.
      return {
        jsonrpc: "2.0",
        id: mid,
        error: { code: -32602, message: "params must be an object" },
      };
    }

    if (method === "initialize") {
      const want = params["protocolVersion"] ?? _DEFAULT_PROTO;
      // A non-string negotiates to the default exactly like an unknown version
      // string -- it must not throw out of handle() and take the transport down.
      const proto = typeof want === "string" && _SUPPORTED_PROTO.has(want) ? want : _DEFAULT_PROTO;
      return {
        jsonrpc: "2.0",
        id: mid,
        result: {
          protocolVersion: proto,
          capabilities: { tools: {} },
          serverInfo: { name: "interlock-messagebus", version: "0.1.0" },
          instructions:
            "Worker-outbound message bus. Call poll to pull due " +
            "messages for this recipient; call ack per message " +
            "once handled.",
        },
      };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id: mid, result: {} };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id: mid, result: { tools: [..._TOOLS] } };
    }
    if (method === "tools/call") {
      const name = params["name"];
      const rawArguments = params["arguments"];
      const argumentsGiven =
        rawArguments === undefined || rawArguments === null ? {} : rawArguments;
      if (!isPlainObject(argumentsGiven)) {
        return {
          jsonrpc: "2.0",
          id: mid,
          error: { code: -32602, message: "arguments must be an object" },
        };
      }
      let payload: Record<string, unknown>;
      try {
        if (name === "poll") {
          payload = this._toolPoll();
        } else if (name === "ack") {
          payload = this._toolAck(argumentsGiven);
        } else {
          return {
            jsonrpc: "2.0",
            id: mid,
            error: { code: -32602, message: `unknown tool: ${String(name)}` },
          };
        }
      } catch (error) {
        // A refusal (stale writer, undelivered ack, unknown message) is a
        // tool-level error the worker should see verbatim, not a transport
        // failure.
        return {
          jsonrpc: "2.0",
          id: mid,
          result: {
            isError: true,
            content: [{ type: "text", text: describeError(error) }],
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id: mid,
        result: {
          content: [{ type: "text", text: pythonJsonDocumentSorted(payload) }],
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: mid,
      error: { code: -32601, message: `method not found: ${String(method)}` },
    };
  }
}

/**
 * `f"{type(exc).__name__}: {exc}"`.
 *
 * The class name is read off the constructor rather than off `error.name`: an
 * `Error` subclass that does not set `name` inherits `"Error"`, and the whole
 * point of the text is to say *which* refusal this was.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.constructor.name}: ${error.message}`;
  }
  return `${typeof error}: ${String(error)}`;
}

/**
 * Line-delimited JSON-RPC over a byte stream.
 *
 * Bytes rather than a decoded stream, deliberately: a lenient decoder turns
 * invalid UTF-8 into replacement characters, so the parse-error branch below
 * would never run and a client that mangled its encoding would get silence.
 * Each line is decoded on its own, fatally, exactly as the source's
 * `raw.decode("utf-8")` inside a `try` does.
 */
export function serve(
  endpoint: Endpoint,
  input: Readable,
  write: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const replyError = (code: number, message: string): void => {
    // A malformed line still gets an answer (id null, per JSON-RPC), so a client
    // waiting on the request it mangled fails fast instead of hanging -- and the
    // transport stays alive either way.
    write(pythonJsonDocumentSorted({ jsonrpc: "2.0", id: null, error: { code, message } }));
  };

  const handleLine = (raw: Buffer): void => {
    let line: string;
    try {
      line = decoder.decode(raw).trim();
    } catch {
      replyError(-32700, "parse error: line is not UTF-8");
      return;
    }
    if (line === "") {
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      replyError(-32700, "parse error: line is not JSON");
      return;
    }
    if (!isPlainObject(msg)) {
      replyError(-32600, "invalid request: message is not an object");
      return;
    }
    const response = endpoint.handle(msg);
    if (response !== null) {
      write(pythonJsonDocumentSorted(response));
    }
  };

  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    input.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) {
          break;
        }
        const raw = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        handleLine(raw);
      }
    });
    input.on("end", () => {
      // `for raw in stdin` yields a trailing line with no newline too.
      if (pending.length > 0) {
        handleLine(pending);
      }
      resolve();
    });
    input.on("error", reject);
  });
}

/** The process entry point. Returns the exit status, as the source does. */
export async function main(
  env: Readonly<Record<string, string | undefined>> = process.env,
  input: Readable = process.stdin,
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
  fail: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): Promise<number> {
  const config = new EndpointConfig(env);
  const gaps = config.missing();
  if (gaps.length > 0) {
    fail(`FATAL: missing env: ${gaps.join(", ")}`);
    return 2;
  }
  const connection = openControlPlane(config.dbPath);
  const dropbox = new KeyedDropbox(config.destinationDir, "messagebus-endpoint");
  const registry = spikeRegistry(dropbox);
  try {
    registry.forRecipient(config.recipient);
  } catch {
    // A recipient no handler serves would poll an eternally empty queue while
    // the real one stays due -- a misconfiguration that must fail at startup,
    // loudly, not at the gate.
    fail(
      `FATAL: INTERLOCK_MESSAGEBUS_RECIPIENT=${pythonRepr(config.recipient)} has no registered handler`,
    );
    connection.close();
    return 2;
  }
  const bus = new MessageBus(connection, {
    resource: config.resource,
    holder: config.holder,
    registry,
  });
  const endpoint = new Endpoint(bus, config);
  try {
    await serve(endpoint, input, write);
  } finally {
    connection.close();
  }
  return 0;
}

/**
 * Whether this module is the process entry point.
 *
 * The same shape as `src/cli.ts`'s, and for the same reason recorded there: the
 * comparison is on `realpathSync` of both sides, because a symlinked launcher
 * makes the URL form disagree with `process.argv[1]`.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (status) => {
      process.exitCode = status;
    },
    (error: unknown) => {
      process.stderr.write(`FATAL: ${describeError(error)}\n`);
      process.exitCode = 1;
    },
  );
}
