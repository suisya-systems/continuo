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
 * The tolerance is deliberate, and continuo#150 is what sized it. Every
 * assertion reads the database or a tool result rather than elapsed time, but
 * the *lease* is still a wall-clock object, and the rule that governs it is
 * absolute: a renewal not attempted within one TTL is refused and latches off
 * for good (`src/lap/endpoint_lease.ts`, "a tick never re-acquires"). So **the
 * TTL is exactly this file's tolerance for the CI runner freezing the
 * process** -- there is no assertion to loosen that would change that, because
 * the frozen expiry is a fact about the row by then. Three Windows runs in two
 * days spent a two-second tolerance; the numbers below are chosen to buy the
 * tolerance back, and the wait is chosen to keep the running time from paying
 * for it twice.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";

import { acquire, readLease, renew } from "../../src/control_plane/lease.js";
import { holdDeliveryLease } from "../../src/lap/endpoint_lease.js";
import { createTempDir } from "../helpers/tmp.js";
import { type BusEnv, HOLDER, makeBusEnv, RECIPIENT, RESOURCE, RUN_ID } from "./_env.js";

/** The built endpoint module, which is what a worker's MCP config launches. */
const ENDPOINT_ENTRY = fileURLToPath(new URL("../../dist/messagebus/endpoint.js", import.meta.url));

/**
 * The lease's life in this file, and the gap between renewals.
 *
 * Ten seconds and two: five ticks per TTL, so the loss of four in a row is
 * survivable. The ratio is the one the shipped numbers use (sixty seconds and
 * fifteen is four ticks; five has always been this file's, and it is the safer
 * direction); what is scaled is the wall-clock cost of the case, not the
 * property under test.
 *
 * **The absolute size is the fix for continuo#150.** Because a stall longer
 * than the TTL latches renewal off, and because the endpoint has to be spawned
 * and polled inside the same window, the TTL is the whole margin this case has
 * against a loaded runner. At two seconds one Windows hiccup spent it. Ten
 * gives the same property five times the room, and costs about six seconds of
 * wall-clock -- half of which the wait below gives back.
 */
const TTL_MS = 10_000;
const INTERVAL_MS = 2_000;

/**
 * The wait: past the expiry the lease was acquired with, and no further.
 *
 * It used to be two TTLs and a half. The acceptance criterion says "more than
 * one", and one is all the claim needs -- an expiry read after this wait cannot
 * be the one the acquisition wrote -- so the second TTL bought emphasis with
 * the only budget that matters here, which is how large the TTL can be for a
 * given running time. Spent on the TTL instead, it is worth five times as much.
 */
const ACROSS_A_TTL_MS = TTL_MS + 1_000;

/**
 * How long the dying holder's lease still stands in the second case.
 *
 * That case needs one number to be two opposite things: long enough that a
 * `node` start-up on a loaded runner cannot lapse the lease before the endpoint
 * has polled once successfully, and short enough to wait out afterwards. They
 * are only in conflict while the number is fixed at acquisition, so it is not
 * -- the holder takes the lease for {@link TTL_MS} and, once the endpoint has
 * polled, re-states its own expiry to this. See the case for why that is still
 * a holder that went away rather than one that released.
 */
const DEATH_WINDOW_MS = 250;

function nowMs(): number {
  return Math.trunc(Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Watch the event loop for the one thing that can fail this file without a
 * defect, and report the worst of it.
 *
 * A peer of the renewal's own timer -- an ordinary self-rearming `setTimeout`
 * at the same interval -- so whatever starves a tick starves this too, and the
 * lateness recorded here is a lower bound on the lateness the renewal saw.
 *
 * It is deliberately **not** substituted for the lease's timer. The reason this
 * file spends wall-clock at all is that the *shipped* timer must be shown
 * driving the *shipped* renewal, and a case that handed `holdDeliveryLease` a
 * schedule of its own would be making that claim about the substitute. So this
 * observes rather than participates, and what it produces is a sentence in a
 * failure message and never an assertion: a threshold on how fast a runner must
 * be would be one more thing for this file to be flaky about, which is the
 * problem rather than the fix.
 */
function watchForStalls(): { worstMs: () => number; stop: () => void } {
  let worstMs = 0;
  let handle: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    const armedAt = nowMs();
    handle = setTimeout(() => {
      worstMs = Math.max(worstMs, nowMs() - armedAt - INTERVAL_MS);
      arm();
    }, INTERVAL_MS);
  };
  arm();
  return {
    worstMs: () => worstMs,
    stop: (): void => {
      if (handle !== null) {
        clearTimeout(handle);
        handle = null;
      }
    },
  };
}

/**
 * What a frozen expiry means, spelled out for whoever reads the red run.
 *
 * The three states are distinguishable and the message says which one it is,
 * because they have nothing in common but the assertion that catches them: a
 * starved runner is continuo#150 again and the numbers above are what to
 * revisit; a latched failure on a machine that was scheduling normally is a
 * renewal that is genuinely refused; and no failure at all is a timer that was
 * armed and never re-armed, which is the regression this case was written for.
 */
function renewalDiagnosis(worstStallMs: number, failure: Error | null): string {
  return (
    `the lease expiry did not advance across a ${ACROSS_A_TTL_MS}ms wait on a ${TTL_MS}ms ` +
    "lease, so no renewal landed at all. The latched renewal failure is " +
    `${failure === null ? "absent" : failure.message}, and the worst lateness this file's own ` +
    `timer suffered -- a peer of the renewal's, armed at the same ${INTERVAL_MS}ms -- was ` +
    `${worstStallMs}ms. Lateness near or past the ${TTL_MS}ms TTL is a runner that stopped ` +
    "scheduling this process (continuo#150), which latches renewal off by design and is not a " +
    "defect here; small lateness with a failure present is a renewal genuinely refused; small " +
    "lateness with no failure is a timer that was never re-armed."
  );
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

    // Armed before the acquisition, because the window a stall can ruin starts
    // there: a freeze during the `node` start-up below latches the renewal just
    // as surely as one during the wait, and freezes the expiry read afterwards.
    const stalls = watchForStalls();
    onTestFinished(() => {
      stalls.stop();
    });

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
    await sleep(ACROSS_A_TTL_MS);
    stalls.stop();

    // The lease outlived the expiry it was taken with, and it did so without
    // changing epoch: the endpoint is writing under exactly the number it was
    // started with. Both halves are read out of SQL, because the row is what
    // the endpoint's own fenced writes are validated against.
    const renewed = readLease(env.connection, RESOURCE);
    expect(renewed?.epoch).toBe(hold.epoch);
    expect(renewed?.expiresAtMs, renewalDiagnosis(stalls.worstMs(), hold.failure)).toBeGreaterThan(
      beforeWait,
    );
    expect(hold.failure, renewalDiagnosis(stalls.worstMs(), hold.failure)).toBeNull();

    const second = await client.callTool("poll");
    expect(second.isError, second.text).toBe(false);
    // The same message, re-presented: the point is that the write behind the
    // poll was admitted, not that anything new arrived.
    expect(JSON.parse(second.text)["messages"]).toHaveLength(1);
    // Five times the case's own running time, as before: the wait grew, and a
    // timeout that did not grow with it would turn the very stall this file was
    // re-sized to absorb into a timeout instead of a pass.
  }, 60_000);

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

    // **The moment the holder goes away, chosen rather than waited for.** The
    // lease was taken for the full TTL so that a loaded runner cannot lapse it
    // before the endpoint has started and polled once -- which was the second
    // half of continuo#150, and would have failed the assertion above with a
    // refusal that proved nothing. Now that the poll has happened, the holder
    // re-states its own expiry to a window this case can afford to wait out.
    //
    // Still a holder that went away rather than one that released: `renew`
    // writes the expiry absolutely under the same holder and the same epoch, no
    // re-acquisition, and after it nothing renews again -- which is exactly the
    // row a killed process leaves. Only *when* it lapses is this case's choice,
    // and that was never the property under test.
    const live = readLease(env.connection, RESOURCE);
    if (live === undefined) {
      // A throw rather than an `expect`, because the value has to narrow: the
      // row cannot be absent (the acquisition above wrote it and the schema
      // forbids deleting it), and a case that carried on with `undefined` here
      // would report the renewal's own usage error instead of this.
      throw new Error("the holder's lease row went missing before it could be shortened");
    }
    renew(env.connection, live, { nowMs: nowMs(), ttlMs: DEATH_WINDOW_MS });

    await sleep(DEATH_WINDOW_MS + 500);

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
