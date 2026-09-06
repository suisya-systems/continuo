/**
 * A line-delimited JSON-RPC client over a built endpoint's stdio.
 *
 * **Extracted for a second caller, not for tidiness.** `D-1104`'s real-child
 * concurrency proof (`test/lap/parallel-laps.test.ts`) starts **two** built
 * endpoints at once, from two different laps' rendered `mcp.json`. Copying
 * `test/gate/endpoint-relay.test.ts`'s file-local `Client` into it would have
 * left two transports for one wire, free to disagree about framing while both
 * files stayed green -- and a framing bug that only one copy has is a bug the
 * other copy's cases cannot see.
 *
 * `endpoint-relay.test.ts` still carries its own copy at the time of writing.
 * That is a known duplication and not a claim that the two are equivalent:
 * migrating it is a change to a case this entry does not otherwise touch, and
 * a transport swap under an unrelated acceptance case belongs in its own diff.
 *
 * Target-only: no parity ledger claims it, on the same ground as the two files
 * that use it.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { expect } from "vitest";

/** What a `tools/call` answered, before any success assertion. */
export interface ToolResult {
  /** `true` when the endpoint reported a refusal verbatim. */
  readonly isError: boolean;
  /** The text of `content[0]`, which is where both shapes put their body. */
  readonly text: string;
}

/** A minimal line-delimited JSON-RPC client over the child's stdio. */
export class StdioEndpointClient {
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
   * that caused it -- and a `FATAL:` startup refusal is exactly the death a
   * resource-admission case exists to catch.
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

  /**
   * The MCP handshake, as every caller needs it before any tool call.
   *
   * Here rather than in each case, because a case that forgot it would get a
   * refusal about protocol state and read it as a defect in what it was
   * actually testing.
   */
  async handshake(): Promise<void> {
    const initialized = await this.request("initialize", { protocolVersion: "2025-06-18" });
    const result = initialized["result"] as Record<string, unknown>;
    const serverInfo = result["serverInfo"] as Record<string, unknown>;
    expect(serverInfo["name"]).toBe("interlock-messagebus");
    this.notify("notifications/initialized");
  }

  /**
   * A tool call, **without** asserting it succeeded.
   *
   * The shape a refusal case needs: `D-1104`'s cross-partition ack must be
   * shown to be refused, and a helper that asserted success would make that
   * assertion unwritable.
   */
  async callToolRaw(
    name: string,
    argumentsGiven: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    const response = await this.request("tools/call", { name, arguments: argumentsGiven });
    const result = response["result"] as Record<string, unknown>;
    const content = result["content"] as { text: string }[];
    return { isError: result["isError"] === true, text: content[0]?.text ?? "" };
  }

  /** A tool call that must have succeeded, with its body parsed. */
  async callTool(
    name: string,
    argumentsGiven: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const raw = await this.callToolRaw(name, argumentsGiven);
    // An `isError` payload is the endpoint reporting a refusal verbatim; it is
    // surfaced rather than parsed as a result, so a fence refusal reads as
    // itself instead of as a JSON parse failure.
    expect(raw.isError, raw.text).toBe(false);
    return JSON.parse(raw.text === "" ? "null" : raw.text) as Record<string, unknown>;
  }
}
