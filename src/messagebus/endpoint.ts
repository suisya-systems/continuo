import { realpathSync } from "node:fs";
import process from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { Database as SqliteDatabase } from "better-sqlite3";

import { KeyedDropbox } from "../control_plane/destination.js";
import { NOTIFY_RECIPIENT, spikeRegistry } from "../control_plane/handlers.js";
import { openProductionControlPlane } from "../control_plane/migrator.js";
import { pythonJsonDocumentSorted } from "../control_plane/python_json.js";
import { pythonRepr } from "../control_plane/python_repr.js";
import { type DeliveredEnvelope, MessageBus } from "./bus.js";

/**
 * S8 -- the worker-outbound MCP endpoint over one {@link MessageBus}.
 *
 * **The surface is still minimal; the database underneath no longer is.** The
 * MCP surface here remains the minimum that makes "worker-outbound" a
 * demonstrated fact rather than a diagram: a stdio server a worker connects to
 * as a client, exposing exactly the two verbs a recipient has -- `poll` and
 * `ack`. What changed is the storage: this endpoint used to open the spike
 * schema (`openControlPlane` in `src/control_plane/schema.ts`, throwaway by
 * default under interlock D-0026), and now opens the **production control
 * plane at migration head** via {@link openProductionControlPlane}. That is
 * what makes the human gate reachable from here at all: gate closure lives in
 * `src/control_plane/gates.ts` and writes the `cancelled` outbox status that
 * migration `0003_outbox_cancelled_status.sql` added, and neither the gate
 * tables nor that status exist in the spike schema.
 *
 * {@link openProductionControlPlane} **never migrates** (D-0029), so the
 * endpoint is a reader of a database somebody else created and moved forward,
 * never a writer of DDL: an absent file, a spike database, a behind-head
 * database and an ahead-of-head database are each refused at startup rather
 * than served -- see {@link main}, which turns every one of those refusals into
 * exit status 2.
 *
 * Ported from interlock `src/claude_org_runtime/messagebus/endpoint.py` at
 * `65f36c5`.
 *
 * **Why worker-outbound.** Delivery is a pull: the worker runs this endpoint as
 * one of its MCP servers and calls `poll`. Nothing here pushes, nudges, or
 * injects; an idle worker that never polls simply leaves its rows due, visible
 * to any operator via the outbox tables.
 *
 * **Not because a push is impossible.** interlock's F1 said there is no
 * non-interactive path to deliver a message into a running background session,
 * and a measurement on 2026-09-05 (`claude 2.1.261`, `-p --input-format
 * stream-json`) refutes that clause for this executor, at the granularity of a
 * tool-call boundary. The pull stands on its own grounds instead: what is due is
 * read from SQLite alone, a response lost on the wire costs nothing because the
 * row stays due, and only the recipient's ack settles anything. Any wake would
 * be executor-specific, would travel the *worker's* stdin rather than this
 * endpoint's -- which carries line-delimited MCP JSON-RPC and would be corrupted
 * by an extra line -- and would carry no payload, so it could prompt a poll and
 * never stand in for one. See `docs/design/messagebus-wake-hint.md`,
 * propose-only.
 *
 * **Transport shape.** Line-delimited JSON-RPC over stdio (one message per
 * line). Unlike a push channel this server *does* declare tools -- it is a tool
 * surface.
 *
 * **Lap 1 keeps this a stdio child: one per worker, recipient pinned by env**
 * (pre-implementation design review, Blocker B2). A shared localhost host
 * serving many workers over one socket was considered and rejected *for lap 1*,
 * not on taste: the isolation between workers here rests entirely on the shape
 * "one worker, one endpoint process, one fixed `INTERLOCK_MESSAGEBUS_RECIPIENT`
 * env". There is no caller identity on the wire and nothing in `handle()` asks
 * who is calling, because with a private child process the answer is structural.
 * The moment several workers share a host, "who may `poll` or `ack` which
 * recipient's queue" becomes a question the transport has to answer, and
 * session authorization would become a blocker of the very same change that
 * moves the storage to production -- two hard problems landing together. So the
 * transport stays as it is and only the database moves.
 *
 * **Configuration is env-driven** (no argument parser; the worker's MCP config
 * sets env), all ASCII. The variable names are interlock's, unchanged, for the
 * reason `STATE_FILE_ENV` in `src/session/stub_provider.ts` keeps its
 * `INTERLOCK_` prefix: the name is a wire contract with a worker's MCP
 * configuration, and renaming it would be a divergence that buys nothing.
 *
 * - `INTERLOCK_MESSAGEBUS_DB` -- path to the control-plane SQLite database.
 *   It must be a **production** control plane **at migration head**. A spike
 *   database (recognised by its `application_id`), an absent file, a database
 *   behind head and a database ahead of this build are all refused at startup
 *   rather than served; see {@link main}. Opening never migrates, so pointing
 *   this at a fresh path does not create anything.
 * - `INTERLOCK_MESSAGEBUS_RESOURCE` / `INTERLOCK_MESSAGEBUS_HOLDER` /
 *   `INTERLOCK_MESSAGEBUS_EPOCH` -- the lease identity this endpoint's writes
 *   are fenced under. The endpoint does not acquire or renew the lease; lease
 *   orchestration is the control plane's, and a stale epoch surfaces as
 *   `StaleWriterRefused` out of `poll`, refused durably.
 *
 *   **`INTERLOCK_MESSAGEBUS_RESOURCE` admits exactly one value on lap 1: the
 *   string {@link DELIVERY_LEASE_RESOURCE}**, which is the one global delivery
 *   lease of D-0053 rule 4 (pre-implementation design review, Blocker B1). The
 *   variable is not deleted, because it is a wire contract with a worker's MCP
 *   configuration; what changed is that it stopped being a choice. {@link main}
 *   refuses any other value at startup with exit status 2, alongside its other
 *   startup refusals. The whole argument for the restriction -- and the two
 *   schema changes that would lift it -- is written out on the constant, which
 *   is where a reader who is about to widen this will be standing.
 *
 *   Renewing that lease is deliberately **not** this module's job: it belongs to
 *   the launcher that owns the endpoint's whole lifetime, and since step 4 that
 *   launcher exists -- `src/lap/endpoint_lease.ts`, held by the `lap perform`
 *   process (`D-0072`). This module is unchanged by it and deliberately so: the
 *   epoch is still fixed here at startup, because a renewal keeps the epoch, and
 *   an endpoint that does outlive its lease still dies loudly at its next write
 *   rather than quietly delivering under a dead one.
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

/**
 * The name of the one delivery lease resource lap 1 admits (D-0053 rule 4).
 *
 * **This is a constraint, not a preference, and it is enforced rather than
 * described** -- see the refusal in {@link main}. The value is deliberately not
 * a per-run or per-worker name (contrast the suites' `session-run:${runId}` and
 * `outbox-of-run-1`): a name with a run or a recipient in it would advertise a
 * partitioning of the outbox that does not exist, and the whole point of rule 4
 * is that no such partitioning exists yet.
 *
 * **Why one resource.** `docs/production-schema.md` section 4.2 names the single
 * writer of `outbox.status` as "the delivery worker holding the outbox lease",
 * fenced by `writer_epoch` validated inside the write (`:213`). But an outbox
 * row carries **no lease or resource column**, and neither pass that selects
 * rows is scoped to one: `_DUE_QUERY` in `src/control_plane/outbox.ts` reads
 * every unfinished row regardless of who is asking, and `Outbox.recover` adopts
 * every unfinished row through `_ADOPT`. Section 4.9's "the endpoint's lease is
 * per-process" therefore fixes a **lifetime** and says nothing about a
 * **scope**, and the two are routinely confused. Admit two resources and each
 * holder holds a live epoch of its own; each one's fenced write then validates
 * against a live lease while touching rows the other believes it owns, because
 * `writer_epoch` records a number and not a resource, so equal epoch numbers
 * under different resources are indistinguishable in the row. The fence would
 * be intact and would be proving only that *some* lease is live, which is not
 * what a fence is for -- the exclusion it exists to provide would be gone.
 *
 * **What would lift this, so a later reader knows it is dated and not a law.**
 * Either a scope column on `outbox` (a resource or partition the due and
 * recovery passes filter on), or a strict recipient predicate applied to both
 * of those passes so that a resource's holder can only ever see its own
 * recipient's rows. Both are schema-and-query questions that D-0053 leaves open
 * on purpose; neither is unlocked by configuring a second resource string here,
 * which is exactly why configuring one is refused instead of trusted.
 */
export const DELIVERY_LEASE_RESOURCE = "outbox-delivery";

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
      // `null` here is a *statement*, not a gap: it means the row carries no
      // ack at all, which since migration 0003 happens for exactly one reason
      // -- the row is `cancelled`, and 0003's
      // `CHECK ((status = 'acked') = (acked_at_ms IS NOT NULL))` makes it
      // impossible for a cancelled row to carry an ack instant. It never means
      // "acked at an instant we could not read". A worker seeing
      // `recorded: false` with a non-null `acked_at_ms` was late to an ack that
      // exists; one seeing `recorded: false` with a null one was late to a gate
      // closure, and no ack will ever exist for that message.
      //
      // `pythonJsonDocumentSorted` renders `null` as the JSON literal `null`
      // (`src/control_plane/python_json.ts:115-117`, where `null` and
      // `undefined` share the branch), so this needs no wire-side special case;
      // the key stays present rather than vanishing, which is what keeps a
      // client's `"acked_at_ms" in response` test honest.
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
  if (config.resource !== DELIVERY_LEASE_RESOURCE) {
    // The one delivery resource of D-0053 rule 4, **enforced here** rather than
    // stated in a docstring. A constraint that only a comment knows is a
    // constraint two endpoints can be started in violation of, each fenced under
    // a live lease of its own and each free to advance the other's rows -- the
    // scenario {@link DELIVERY_LEASE_RESOURCE} argues cannot be allowed to be
    // reachable by configuration.
    //
    // The env var stays, and stays required by `missing()` above: it is a wire
    // contract with a worker's MCP configuration, exactly as
    // `INTERLOCK_MESSAGEBUS_DB` and `INTERLOCK_MESSAGEBUS_RECIPIENT` are, and
    // deleting it would break every config that sets it while silently changing
    // what the endpoint fences under. What changes is only that exactly one
    // value is admitted -- so an operator who spells a second resource gets a
    // refusal naming the admitted one, not a running endpoint that quietly
    // shares the outbox.
    //
    // **Here and not in `EndpointConfig`**, on two grounds. First, `missing()`
    // answers a different question -- "what did the operator fail to set" -- and
    // an unset resource must keep being reported as missing rather than as "not
    // the admitted name", which is a different fix. Second, `config.resource` is
    // read at exactly one place in this module, the `new MessageBus` below, so
    // the admission sits immediately above its only use; welding it into the
    // constructor would instead make `EndpointConfig` unable to *describe* a
    // configuration, which the in-process tests construct directly (they build
    // `Endpoint(bus, config)` around a bus they made themselves, and `Endpoint`
    // never reads `config.resource` at all).
    //
    // Order matters: after `missing()`, so an unset value is reported as unset;
    // before the database is opened, so a refused configuration never gets as
    // far as touching a file.
    fail(
      `FATAL: INTERLOCK_MESSAGEBUS_RESOURCE=${pythonRepr(config.resource)} is not the one` +
        ` delivery lease resource lap 1 admits (${pythonRepr(DELIVERY_LEASE_RESOURCE)})`,
    );
    return 2;
  }
  let connection: SqliteDatabase;
  try {
    connection = openProductionControlPlane(config.dbPath);
  } catch (error) {
    // Every way this can fail is a startup **misconfiguration**, so it gets the
    // same exit status 2 that missing env and an unserved recipient already get
    // above and below, and the same `FATAL:` line on stderr. The refusals
    // openProductionControlPlane can raise, all from
    // `src/control_plane/migrator.ts`, are: `MissingStateRefused` (the file is
    // not there -- an absent database is not an empty one, and opening never
    // creates); `CorruptStateRefused` (not a regular file, unreadable, failing
    // `integrity_check`, or -- the interesting one during this cutover -- "is a
    // spike database", recognised by its `application_id`, for which no
    // migration exists and none will be written); the base `ControlPlaneRefusal`
    // (the file is *behind* head, and opening never migrates as a side effect,
    // D-0029, so somebody must run `migrateControlPlane` explicitly); and
    // `DatabaseAheadOfCodeRefused` (the file carries a migration this build does
    // not know, refused rather than downgraded because there are no down
    // migrations).
    //
    // Catching them here rather than letting them out is the point of the
    // change: without this the refusal escaped `main()` to the entry-point
    // handler at the bottom of this file, which prints an *uncaught* FATAL and
    // sets exit code 1 -- the status for "this program crashed", which reads to
    // an operator (and to any supervisor scripting a restart) as a bug in the
    // endpoint rather than as a database that was never prepared for it. The
    // message keeps the path, because "which database" is the first thing the
    // operator needs and `config.dbPath` is the only place it is written down.
    fail(`FATAL: INTERLOCK_MESSAGEBUS_DB=${pythonRepr(config.dbPath)}: ${describeError(error)}`);
    return 2;
  }
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
