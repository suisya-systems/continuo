/**
 * Step 4's acceptance: a real endpoint child still polls after more than one
 * TTL, and stops being able to when its holder goes away.
 *
 * **Target-only.** Interlock has no launcher holding the endpoint's lease --
 * that absence is what `docs/design/minimal-operating-loop.md` section 4.9 is
 * about -- so there is no source node id to port and no parity ledger claims
 * this file. It is a **new file** rather than three more cases in
 * `endpoint.test.ts` for a mechanical reason as well as a topical one: that file
 * is ledgered by `parity/messagebus.endpoint.ledger.json`, and every id added to
 * it would have to be declared there as target-only.
 *
 * **It spawns real children**, so it is registered in `SPAWNING_TESTS`
 * (`scripts/run-suite.mjs`).
 *
 * ## Why this case is wall-clock and its siblings are not
 *
 * Every rule the renewal obeys is pinned deterministically in
 * `test/lap/endpoint-lease.test.ts`, on an injected timer. What cannot be
 * reached that way is the claim the acceptance criterion actually makes: that
 * the **shipped** timer is wired to the **shipped** renewal, and that an
 * endpoint process nobody restarted goes on writing across an expiry it never
 * hears about. That is a statement about two processes and a clock, so it is
 * spent in real milliseconds -- with a lease sized in hundreds of them rather
 * than in the shipped minute, which is the only thing this file scales down.
 *
 * The tolerance is deliberate: the renewal interval is a quarter of the TTL, so
 * three consecutive ticks may be lost to a busy machine before an assertion
 * here would fail. Every assertion reads the database or a tool result rather
 * than elapsed time.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";

import { acquire, readLease } from "../../src/control_plane/lease.js";
import { holdDeliveryLease } from "../../src/lap/endpoint_lease.js";
import { createTempDir } from "../helpers/tmp.js";
import { type BusEnv, HOLDER, makeBusEnv, RECIPIENT, RESOURCE, RUN_ID } from "./_env.js";

/** The built endpoint module, which is what a worker's MCP config launches. */
const ENDPOINT_ENTRY = fileURLToPath(new URL("../../dist/messagebus/endpoint.js", import.meta.url));

/**
 * The lease's life in this file, and the gap between renewals.
 *
 * Two seconds and four hundred milliseconds: five ticks per TTL, so the loss of
 * three in a row is survivable, and a wait of more than two TTLs still finishes
 * in about five seconds. The shipped numbers are sixty seconds and fifteen, and
 * they are the same ratio -- what is scaled here is the wall-clock cost of the
 * case, not the property under test.
 */
const TTL_MS = 2_000;
const INTERVAL_MS = 400;

/** More than two TTLs. The acceptance criterion says "more than one". */
const ACROSS_TWO_TTLS_MS = 2 * TTL_MS + 500;

function nowMs(): number {
  return Math.trunc(Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function requireBuiltEndpoint(): void {
  expect(
    existsSync(ENDPOINT_ENTRY),
    "dist/messagebus/endpoint.js is missing: this case drives the built endpoint as a " +
      "subprocess, and `npm run pretest` builds it",
  ).toBe(true);
}

/**
 * One world whose delivery lease row is **already expired**.
 *
 * `makeBusEnv` seeds the row directly, which every other file in this suite
 * wants; here the lease has to be one `holdDeliveryLease` actually took, because
 * the subject is the acquisition and its renewal. A one-millisecond TTL leaves
 * the seeded row present and lapsed, so the acquisition below is a genuine
 * takeover that raises the epoch to 2 -- rather than a second row, which the
 * schema does not permit anyway.
 */
function expiredWorld(label: string): { env: BusEnv; root: string } {
  const root = createTempDir(label);
  const env = makeBusEnv(root, "renewal", { nowMs: nowMs(), ttlMs: 1 });
  onTestFinished(() => {
    env.close();
  });
  return { env, root };
}

/** A line-delimited JSON-RPC client over the child's stdio. */
class Client {
  readonly #process: ChildProcessWithoutNullStreams;
  #nextId = 0;
  #pending = "";
  readonly #lines: string[] = [];
  #waiting: ((line: string) => void) | null = null;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#process = child;
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      this.#pending += chunk;
      for (;;) {
        const newline = this.#pending.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = this.#pending.slice(0, newline);
        this.#pending = this.#pending.slice(newline + 1);
        const waiting = this.#waiting;
        if (waiting !== null) {
          this.#waiting = null;
          waiting(line);
        } else {
          this.#lines.push(line);
        }
      }
    });
  }

  #readLine(): Promise<string> {
    const buffered = this.#lines.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    return new Promise((resolve, reject) => {
      this.#waiting = resolve;
      this.#process.once("close", () => {
        if (this.#waiting !== null) {
          this.#waiting = null;
          // A rejection rather than a hang: a child that died would otherwise
          // leave this waiting until the file's timeout, reporting a timeout
          // instead of the death that caused it.
          reject(new Error("endpoint closed stdout unexpectedly"));
        }
      });
    });
  }

  /**
   * `tools/call`, with the result left as the endpoint rendered it.
   *
   * Deliberately NOT decoded into the tool's payload, which is what
   * `endpoint.test.ts`'s own client does: a refusal comes back as
   * `isError: true` with the refusal's text, and a helper that parsed the text
   * as JSON would turn the case this file exists for into a parse error.
   */
  async callTool(
    name: string,
    argumentsGiven: Record<string, unknown> = {},
  ): Promise<{ isError: boolean; text: string }> {
    this.#nextId += 1;
    const id = this.#nextId;
    this.#process.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: argumentsGiven },
      })}\n`,
    );
    const response = JSON.parse(await this.#readLine()) as Record<string, unknown>;
    expect(response["id"]).toBe(id);
    const result = response["result"] as Record<string, unknown>;
    const content = result["content"] as { text: string }[];
    return { isError: result["isError"] === true, text: content[0]?.text ?? "" };
  }
}

/** Start the built endpoint against this world, under `epoch`. */
function startEndpoint(
  env: BusEnv,
  root: string,
  epoch: number,
): { client: Client; child: ChildProcessWithoutNullStreams } {
  const child = spawn(process.execPath, [ENDPOINT_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      INTERLOCK_MESSAGEBUS_DB: env.dbPath,
      INTERLOCK_MESSAGEBUS_RESOURCE: RESOURCE,
      INTERLOCK_MESSAGEBUS_HOLDER: HOLDER,
      // Fixed at startup, exactly as it is for a real worker's endpoint: this
      // is the number a renewal must not change and a re-acquisition must
      // invalidate.
      INTERLOCK_MESSAGEBUS_EPOCH: String(epoch),
      INTERLOCK_MESSAGEBUS_RECIPIENT: RECIPIENT,
      INTERLOCK_MESSAGEBUS_DESTINATION_DIR: join(root, "destination-renewal"),
    },
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
  return { client: new Client(child), child };
}

function send(env: BusEnv, epoch: number, messageId: string): void {
  env.bus.send({
    messageId,
    recipient: RECIPIENT,
    payload: '{"task":"t"}',
    dedupKey: `dk-${messageId}`,
    nowMs: nowMs(),
    epoch,
    runId: RUN_ID,
  });
}

describe("a launcher holds the endpoint's lease for the endpoint's whole life", () => {
  test("a poll still works after more than one TTL has passed", async () => {
    // **The acceptance criterion, and the case the whole step exists for.**
    // The endpoint's epoch is fixed at startup and it never touches the lease;
    // the only reason its writes are still admitted five seconds later is that
    // this process renewed the lease four or five times behind its back. On
    // the build before step 4 there is no renewal at all, so this fails at the
    // second poll with a stale writer -- and on a build whose timer was armed
    // but never re-armed it fails just as loudly.
    requireBuiltEndpoint();
    const { env, root } = expiredWorld("endpoint-lease-renewal");

    const hold = holdDeliveryLease(env.connection, {
      holder: HOLDER,
      nowMs,
      ttlMs: TTL_MS,
      intervalMs: INTERVAL_MS,
    });
    onTestFinished(() => {
      hold.stop();
    });
    expect(hold.epoch).toBe(2);

    const { client } = startEndpoint(env, root, hold.epoch);
    send(env, hold.epoch, "task-1");

    const first = await client.callTool("poll");
    expect(first.isError, first.text).toBe(false);
    expect(JSON.parse(first.text)["messages"]).toHaveLength(1);

    const beforeWait = readLease(env.connection, RESOURCE)?.expiresAtMs ?? 0;
    await sleep(ACROSS_TWO_TTLS_MS);

    // The lease outlived the expiry it was taken with, and it did so without
    // changing epoch: the endpoint is writing under exactly the number it was
    // started with. Both halves are read out of SQL, because the row is what
    // the endpoint's own fenced writes are validated against.
    const renewed = readLease(env.connection, RESOURCE);
    expect(renewed?.epoch).toBe(hold.epoch);
    expect(renewed?.expiresAtMs).toBeGreaterThan(beforeWait);
    expect(hold.failure).toBeNull();

    const second = await client.callTool("poll");
    expect(second.isError, second.text).toBe(false);
    // The same message, re-presented: the point is that the write behind the
    // poll was admitted, not that anything new arrived.
    expect(JSON.parse(second.text)["messages"]).toHaveLength(1);
  }, 30_000);

  test("a holder that goes away leaves the endpoint durably refused, and its return raises the epoch", async () => {
    // The other half of the design's claim, and the reason a renewal is worth
    // having rather than merely tidy. The holder here does not release -- it
    // stops renewing, which is what a killed process does -- so the lease
    // lapses on its own and the endpoint, which cannot know, keeps trying.
    //
    // `StaleWriterRefused` is asserted on the wire AND as an `action` row: the
    // design's claim is that the refusal is **durable**, and only the row
    // proves that. A build that refused in memory and wrote nothing would pass
    // the text assertion alone.
    requireBuiltEndpoint();
    const { env, root } = expiredWorld("endpoint-lease-death");

    // No renewal at all: `schedule` records the tick and never fires it, which
    // is a holder that died the moment it took the lease.
    const hold = holdDeliveryLease(env.connection, {
      holder: HOLDER,
      nowMs,
      ttlMs: TTL_MS,
      intervalMs: INTERVAL_MS,
      schedule: () => () => {
        // Deliberately empty: nothing is scheduled and nothing to cancel.
      },
    });
    expect(hold.epoch).toBe(2);

    const { client } = startEndpoint(env, root, hold.epoch);
    send(env, hold.epoch, "task-1");

    const before = await client.callTool("poll");
    expect(before.isError, before.text).toBe(false);
    const refusalsBefore = env.refusedActionCount();

    await sleep(TTL_MS + 500);

    const after = await client.callTool("poll");
    expect(after.isError).toBe(true);
    expect(after.text).toContain("StaleWriterRefused");
    // Durable, not merely reported.
    expect(env.refusedActionCount()).toBeGreaterThan(refusalsBefore);

    // The returning holder must re-acquire, and re-acquiring raises the epoch
    // -- which is what invalidates the endpoint still running under the old
    // one rather than silently readmitting it.
    const returned = acquire(env.connection, {
      resource: RESOURCE,
      holder: HOLDER,
      nowMs: nowMs(),
      ttlMs: TTL_MS,
    });
    expect(returned.epoch).toBe(hold.epoch + 1);

    const stillRefused = await client.callTool("poll");
    expect(stillRefused.isError).toBe(true);
    expect(stillRefused.text).toContain("StaleWriterRefused");
  }, 30_000);
});
