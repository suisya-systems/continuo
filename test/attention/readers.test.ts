/**
 * Ported from interlock `tests/attention/test_readers.py` at `65f36c5` -- 29 cases.
 *
 * The ledger is `parity/attention.readers.ledger.json`. Two mechanisms are rewritten and are the
 * reason most entries read `adapted` rather than `ported`: SQLite is `better-sqlite3` rather than
 * Python's `sqlite3`, and the `monkeypatch.setattr` spy on `_chunk_reaches_cutoff` becomes a seam
 * record, because ESM bindings cannot be rebound from outside the module that declares them
 * (`docs/test-translation-conventions.md` rule 5).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import * as readers from "../../src/attention/readers.js";
import { caseRoot } from "../testkit/cases.js";
import { patchSeam } from "../testkit/seams.js";
import {
  appendJournalText,
  capturedStderr,
  makeStateDb,
  writeJournal,
  writePendingDecisions,
} from "./helpers/fixtures.js";

/** The source's `_dup`: one `duplicate_sidecar_detected` line. */
function dup(
  ts: number,
  options: { owner?: string; instances?: readonly string[] } = {},
): Record<string, unknown> {
  return {
    ts,
    event: "duplicate_sidecar_detected",
    owner: options.owner ?? "sec",
    instances: [...(options.instances ?? ["a", "b"])],
  };
}

/** The source's `_superseded`: one `delivery_register_superseded` line as the store writes it. */
function superseded(
  ts: number,
  options: { owner?: string; instance?: string } = {},
): Record<string, unknown> {
  return {
    ts,
    event: "delivery_register_superseded",
    owner: options.owner ?? "sec",
    instance: options.instance ?? "inst-old",
    state: "active",
    latched: true,
  };
}

/** The source's `_adopt_expired`: one `delivery_adopt_expired` line as the store writes it. */
function adoptExpired(
  ts: number,
  options: { owner?: string; adoptionId?: string; restored?: boolean } = {},
): Record<string, unknown> {
  const restored = options.restored ?? true;
  return {
    ts,
    event: "delivery_adopt_expired",
    owner: options.owner ?? "sec",
    adoption_id: options.adoptionId ?? "ad0011",
    armed_seconds: 300.0,
    lease_dropped: true,
    generation: 4,
    restored,
    restored_generation: restored ? 3 : null,
  };
}

describe("attention readers", () => {
  test("read events: a missing file returns empty", () => {
    expect(readers.readEvents(join(caseRoot("readers"), "nope.db"))).toEqual([]);
  });

  test("read events: an empty database with no events table returns empty", () => {
    const dbPath = join(caseRoot("readers"), "empty.db");
    const connection = new Database(dbPath);
    connection.exec("CREATE TABLE _ (id INTEGER)");
    connection.close();

    expect(readers.readEvents(dbPath)).toEqual([]);
  });

  test("read events: the select filters to the relevant kinds", () => {
    const db = makeStateDb(join(caseRoot("readers"), "state.db"), [
      { kind: "heartbeat" },
      { kind: "notify_sent", payload: { kind: "approval_blocked" } },
      { kind: "anomaly_observed" },
      { kind: "ci_completed", payload: { status: "failed", pr: 1 } },
      { kind: "worker_completed", payload: { task_id: "t" } },
      { kind: "pr_merged", payload: { pr: 1 } },
    ]);

    const rows = readers.readEvents(db);

    expect(rows.map((row) => row.kind)).toEqual([
      "notify_sent",
      "ci_completed",
      "worker_completed",
      "pr_merged",
    ]);
    // Payloads are JSON-decoded into objects.
    expect(rows[1]?.payload).toEqual({ status: "failed", pr: 1 });
  });

  test("read events: rows come back ordered by id", () => {
    const db = makeStateDb(join(caseRoot("readers"), "state.db"), [
      { kind: "worker_completed", payload: { task_id: "a" } },
      { kind: "worker_completed", payload: { task_id: "b" } },
    ]);

    const rows = readers.readEvents(db);

    expect(rows.map((row) => row.payload["task_id"])).toEqual(["a", "b"]);
    expect(Number(rows[0]?.id)).toBeLessThan(Number(rows[1]?.id));
  });

  test("read events: an invalid payload_json decodes to an empty payload", () => {
    // Built without the CHECK(json_valid()) clause so the reader's defensive parse is reachable.
    const dbPath = join(caseRoot("readers"), "state.db");
    const connection = new Database(dbPath);
    connection.exec(
      "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "occurred_at TEXT, actor TEXT, kind TEXT, payload_json TEXT)",
    );
    connection
      .prepare("INSERT INTO events (kind, payload_json) VALUES (?, ?)")
      .run("worker_completed", "not-json");
    connection.close();

    expect(readers.readEvents(dbPath)[0]?.payload).toEqual({});
  });

  test("read pending decisions: a missing file returns empty", () => {
    expect(readers.readPendingDecisions(join(caseRoot("readers"), "nope.json"))).toEqual([]);
  });

  test("read pending decisions: malformed JSON returns empty", () => {
    const path = join(caseRoot("readers"), "pending.json");
    writeFileSync(path, "{not json", "utf8");

    expect(readers.readPendingDecisions(path)).toEqual([]);
  });

  test("read pending decisions: a document of the wrong type returns empty", () => {
    const path = join(caseRoot("readers"), "pending.json");
    writeFileSync(path, JSON.stringify({ oops: true }), "utf8");

    expect(readers.readPendingDecisions(path)).toEqual([]);
  });

  test("read pending decisions: non-object entries are filtered out", () => {
    const path = writePendingDecisions(join(caseRoot("readers"), "pending.json"), [
      {
        task_id: "ok",
        received_at: "2026-05-12T00:00:00Z",
        raw_message: "?",
        status: "pending",
      },
      "not-a-dict",
      12345,
    ]);

    const out = readers.readPendingDecisions(path);

    expect(out).toHaveLength(1);
    expect(out[0]?.["task_id"]).toBe("ok");
  });

  test("read events: a file that is not a database returns empty and warns", () => {
    // A garbage file at `state.db` must not crash the long-running watch.
    const fakeDb = join(caseRoot("readers"), "state.db");
    writeFileSync(
      fakeDb,
      Buffer.concat([Buffer.from("not-a-sqlite-database", "utf8"), Buffer.from([0x00, 0x01])]),
    );

    const { value, err } = capturedStderr(() => readers.readEvents(fakeDb));

    expect(value).toEqual([]);
    // Either the open failed or the master-table read failed; both paths must surface a warning
    // rather than raise.
    expect(err).toContain("state DB");
  });

  test("read broker duplicates: a missing journal returns empty", () => {
    expect(
      readers.readBrokerDuplicates(join(caseRoot("readers"), "broker"), {
        nowEpoch: 1000,
        windowSec: 300,
      }),
    ).toEqual([]);
  });

  test("read broker duplicates: only the duplicate event is picked", () => {
    const root = caseRoot("readers");
    writeJournal(join(root, "broker"), [
      { ts: 990.0, event: "message_enqueued", to_id: "sec" },
      dup(995.0),
      { ts: 999.0, event: "claimed", owner: "sec" },
    ]);

    const out = readers.readBrokerDuplicates(join(root, "broker"), {
      nowEpoch: 1000,
      windowSec: 300,
    });

    expect(out).toHaveLength(1);
    expect(out[0]?.owner).toBe("sec");
    expect(out[0]?.instances).toEqual(["a", "b"]);
    expect(out[0]?.ts).toBe(995.0);
  });

  test("read broker duplicates: rows outside the window are dropped", () => {
    const root = caseRoot("readers");
    writeJournal(join(root, "broker"), [
      dup(500.0, { instances: ["old-a", "old-b"] }), // 500s ago -> stale
      dup(950.0, { instances: ["new-a", "new-b"] }), // 50s ago -> live
    ]);

    const out = readers.readBrokerDuplicates(join(root, "broker"), {
      nowEpoch: 1000,
      windowSec: 300,
    });

    expect(out.map((row) => row.instances)).toEqual([["new-a", "new-b"]]);
  });

  test("read broker duplicates: corrupt and undateable rows are skipped", () => {
    // An undateable row would sit in the tail and re-alert every cooldown forever; the signal
    // repeats on its own, so skipping costs at most one lease window of delay.
    const root = caseRoot("readers");
    const path = writeJournal(join(root, "broker"), [dup(990.0)]);
    appendJournalText(
      path,
      [
        "{not json",
        "[1, 2, 3]", // not an object
        "", // blank
        JSON.stringify({ event: "duplicate_sidecar_detected" }),
        JSON.stringify({ ts: "990", event: "duplicate_sidecar_detected" }),
        JSON.stringify({ ts: true, event: "duplicate_sidecar_detected" }),
        '{"ts": NaN, "event": "duplicate_sidecar_detected"}',
        '{"ts": Infinity, "event": "duplicate_sidecar_detected"}',
      ].join("\n") + "\n",
    );

    const out = readers.readBrokerDuplicates(join(root, "broker"), {
      nowEpoch: 1000,
      windowSec: 300,
    });

    expect(out.map((row) => row.ts)).toEqual([990.0]);
  });

  test("read broker duplicates: the scan follows the window rather than a byte cap", () => {
    // A busy journal must not push a still-live incident out of view. The detection is re-emitted
    // only once per lease window, so whatever the daemon journals in between sits between the
    // signal and the tail; a fixed-size tail would drop it while it is still fresh.
    const root = caseRoot("readers");
    const records: unknown[] = [dup(950.0, { instances: ["live-a", "live-b"] })];
    for (let index = 0; index < 200; index += 1) {
      records.push({
        ts: 950.0 + index * 0.01,
        event: "claimed",
        owner: "sec",
        ids: [`row-${"x".repeat(40)}`],
      });
    }
    writeJournal(join(root, "broker"), records);

    const out = readers.readBrokerDuplicates(join(root, "broker"), {
      nowEpoch: 1000,
      windowSec: 300,
      chunkBytes: 256, // far smaller than the trailing traffic
    });

    expect(out.map((row) => row.instances)).toEqual([["live-a", "live-b"]]);
  });

  test("read broker duplicates: the walk stops at the first line past the window", () => {
    // Asserted through the scan cap: reading the whole file would exceed `maxScanBytes` and warn,
    // so a silent run proves the walk stopped at the window boundary instead.
    const root = caseRoot("readers");
    const records: unknown[] = [];
    for (let index = 0; index < 100; index += 1) {
      records.push({ ts: 100.0 + index, event: "claimed", owner: "sec" });
    }
    records.push(dup(995.0));
    writeJournal(join(root, "broker"), records);

    const { value, err } = capturedStderr(() =>
      readers.readBrokerDuplicates(join(root, "broker"), {
        nowEpoch: 1000,
        windowSec: 300,
        chunkBytes: 128,
        maxScanBytes: 1024,
      }),
    );

    expect(value.map((row) => row.ts)).toEqual([995.0]);
    expect(err).toBe("");
  });

  test("read broker duplicates: the walk inspects each chunk once", () => {
    // Re-inspecting the whole accumulated tail on every chunk would make the walk quadratic, and
    // `attention watch` pays it on every poll. Pin the shape: each cutoff check sees only the
    // chunk just read.
    const root = caseRoot("readers");
    const records: unknown[] = [];
    for (let index = 0; index < 400; index += 1) {
      records.push({ ts: 900.0 + index * 0.001, event: "claimed", owner: "sec" });
    }
    records.push(dup(995.0));
    writeJournal(join(root, "broker"), records);

    const seen: number[] = [];
    const real = readers.readersSeams.chunkReachesCutoff;
    patchSeam(readers.readersSeams, "chunkReachesCutoff", (chunk, cutoff, options) => {
      seen.push(chunk.length);
      return real(chunk, cutoff, options);
    });

    const out = readers.readBrokerDuplicates(join(root, "broker"), {
      nowEpoch: 1000,
      windowSec: 300,
      chunkBytes: 256,
    });

    expect(out.map((row) => row.ts)).toEqual([995.0]);
    expect(seen.length).toBeGreaterThan(1); // the walk really did span chunks
    expect(Math.max(...seen)).toBeLessThanOrEqual(256); // never re-reads the accumulated tail
  });

  test("read broker duplicates: hitting the safety cap is reported", () => {
    const root = caseRoot("readers");
    const records: unknown[] = [];
    for (let index = 0; index < 100; index += 1) {
      records.push({ event: "claimed", owner: "sec", note: "no ts at all" });
    }
    records.push(dup(995.0));
    writeJournal(join(root, "broker"), records);

    const { value, err } = capturedStderr(() =>
      readers.readBrokerDuplicates(join(root, "broker"), {
        nowEpoch: 1000,
        windowSec: 300,
        chunkBytes: 128,
        maxScanBytes: 512,
      }),
    );

    // Partial degradation: what was reached is still reported.
    expect(value.map((row) => row.ts)).toEqual([995.0]);
    expect(err).toContain("freshness window");
  });

  test("read broker duplicates: a chunk boundary inside a codepoint is survivable", () => {
    const root = caseRoot("readers");
    // Written as escapes so this file stays ASCII; the bytes are what the case is about.
    const owner = "\u30ef\u30fc\u30ab\u30fc\u65e5\u672c\u8a9e";
    const path = writeJournal(join(root, "broker"), [
      { ts: 100.0, event: "claimed", owner: "old" },
      dup(990.0, { owner, instances: ["x", "y"] }),
      dup(995.0, { owner: "sec" }),
    ]);
    const data = readFileSync(path);
    // Size the chunk so the first read boundary lands one byte into the 3-byte codepoint opening
    // the middle line's owner value.
    const chunkBytes = data.length - (data.indexOf(Buffer.from(owner, "utf8")) + 1);

    const out = readers.readBrokerDuplicates(join(root, "broker"), {
      nowEpoch: 1000,
      windowSec: 300,
      chunkBytes,
    });

    // The damaged line is dropped; the next chunk brings back the rest.
    expect(out.map((row) => row.owner)).toEqual([owner, "sec"]);
  });

  test("read broker duplicates: an unreadable journal warns", () => {
    const root = caseRoot("readers");
    mkdirSync(join(root, "broker", "queue.jsonl"), { recursive: true });

    const { value, err } = capturedStderr(() =>
      readers.readBrokerDuplicates(join(root, "broker"), { nowEpoch: 1000, windowSec: 300 }),
    );

    expect(value).toEqual([]);
    expect(err).toContain("broker journal");
  });

  test("read broker duplicates: the projection is exactly three keys", () => {
    // If the projection stopped narrowing the shared engine's whole records, `event` / `instance`
    // / anything else the daemon writes would start leaking into a payload a downstream repo
    // parses. Pin the key set exactly, not just the three values.
    const root = caseRoot("readers");
    writeJournal(join(root, "broker"), [dup(995.0)]);

    const out = readers.readBrokerDuplicates(join(root, "broker"), {
      nowEpoch: 1000,
      windowSec: 300,
    });

    expect(out.map((row) => new Set(Object.keys(row)))).toEqual([
      new Set(["ts", "owner", "instances"]),
    ]);
  });

  test("read delivery signals: a missing journal returns empty", () => {
    // A broker that never ran must not crash the watcher's first poll.
    expect(
      readers.readBrokerDeliverySignals(join(caseRoot("readers"), "broker"), {
        nowEpoch: 1000,
        windowSec: 3600,
      }),
    ).toEqual([]);
  });

  test("read delivery signals: only the two ownership events are picked", () => {
    // Widening this filter would page the operator about routine traffic, and picking up
    // `duplicate_sidecar_detected` here would re-notify a live double sidecar on this reader's
    // hour-long window instead of the short one that signal is designed around.
    const root = caseRoot("readers");
    writeJournal(join(root, "broker"), [
      { ts: 950.0, event: "message_enqueued", to_id: "sec" },
      { ts: 960.0, event: "duplicate_sidecar_detected", owner: "sec", instances: ["a", "b"] },
      { ts: 970.0, event: "lease_reaped", owner: "sec" },
      superseded(980.0),
      { ts: 985.0, event: "delivery_adopt_started", owner: "sec", adoption_id: "ad0011" },
      adoptExpired(990.0),
      { ts: 995.0, event: "delivery_generation_registered", owner: "sec", generation: 5 },
    ]);

    const out = readers.readBrokerDeliverySignals(join(root, "broker"), {
      nowEpoch: 1000,
      windowSec: 3600,
    });

    expect(out.map((row) => row["event"])).toEqual([
      "delivery_register_superseded",
      "delivery_adopt_expired",
    ]);
  });

  test("read delivery signals: rows outside the window are dropped", () => {
    // Neither event repeats, so both sit in the append-only journal forever. Without the cutoff
    // every scan would re-surface an adopt that expired weeks ago.
    const root = caseRoot("readers");
    writeJournal(join(root, "broker"), [
      adoptExpired(900.0, { adoptionId: "ancient" }), // 3700s ago
      superseded(4000.0, { instance: "live-inst" }), // 600s ago
    ]);

    const out = readers.readBrokerDeliverySignals(join(root, "broker"), {
      nowEpoch: 4600,
      windowSec: 3600,
    });

    expect(out.map((row) => row["event"])).toEqual(["delivery_register_superseded"]);
    expect(out[0]?.["instance"]).toBe("live-inst");
  });

  test("read delivery signals: the raw per-event fields are kept", () => {
    // `readBrokerDuplicates` projects down to three keys; doing that here would drop
    // `adoption_id` and `instance`, and the classifier would have nothing left to build a
    // per-incident dedup key from.
    const root = caseRoot("readers");
    writeJournal(join(root, "broker"), [
      superseded(980, { instance: "inst-old" }),
      adoptExpired(990, { adoptionId: "ad0011", restored: false }),
    ]);

    const [sup, exp] = readers.readBrokerDeliverySignals(join(root, "broker"), {
      nowEpoch: 1000,
      windowSec: 3600,
    });

    expect(sup?.["instance"]).toBe("inst-old");
    expect(sup?.["latched"]).toBe(true);
    expect(sup?.["state"]).toBe("active");
    expect(exp?.["adoption_id"]).toBe("ad0011");
    expect(exp?.["restored"]).toBe(false);
    // Written as integers above; both must come back as usable epoch numbers.
    expect(typeof sup?.ts).toBe("number");
    expect(sup?.ts).toBe(980.0);
    expect(typeof exp?.ts).toBe("number");
    expect(exp?.ts).toBe(990.0);
  });

  test("read delivery signals: corrupt and undateable rows are skipped", () => {
    // The daemon appends while the watcher reads, so a torn last line is normal. Raising here
    // would kill the poll that was supposed to report an owner going mute.
    const root = caseRoot("readers");
    const path = writeJournal(join(root, "broker"), [adoptExpired(990.0)]);
    appendJournalText(
      path,
      [
        "{not json",
        "[1, 2, 3]", // not an object
        "", // blank
        JSON.stringify({ event: "delivery_adopt_expired" }),
        JSON.stringify({ ts: "990", event: "delivery_adopt_expired" }),
        JSON.stringify({ ts: true, event: "delivery_register_superseded" }),
        '{"ts": NaN, "event": "delivery_adopt_expired"}',
        '{"ts": Infinity, "event": "delivery_adopt_expired"}',
      ].join("\n") + "\n",
    );

    const out = readers.readBrokerDeliverySignals(join(root, "broker"), {
      nowEpoch: 1000,
      windowSec: 3600,
    });

    expect(out.map((row) => row.ts)).toEqual([990.0]);
  });

  test("read delivery signals: an unreadable journal warns", () => {
    // Silently returning `[]` would be indistinguishable from "nothing is wrong", which is the
    // wrong answer for a consumer whose whole job is reporting silence.
    const root = caseRoot("readers");
    mkdirSync(join(root, "broker", "queue.jsonl"), { recursive: true });

    const { value, err } = capturedStderr(() =>
      readers.readBrokerDeliverySignals(join(root, "broker"), { nowEpoch: 1000, windowSec: 3600 }),
    );

    expect(value).toEqual([]);
    expect(err).toContain("broker journal");
  });

  test("read delivery signals: hitting the safety cap is reported", () => {
    // These signals are one-shot, so a truncated walk does not just delay the alert -- it loses
    // it. The operator has to be told the window was not fully covered.
    const root = caseRoot("readers");
    const records: unknown[] = [];
    for (let index = 0; index < 100; index += 1) {
      records.push({ event: "claimed", owner: "sec", note: "no ts at all" });
    }
    records.push(adoptExpired(995.0));
    writeJournal(join(root, "broker"), records);

    const { value, err } = capturedStderr(() =>
      readers.readBrokerDeliverySignals(join(root, "broker"), {
        nowEpoch: 1000,
        windowSec: 3600,
        chunkBytes: 128,
        maxScanBytes: 512,
      }),
    );

    // Partial degradation: what was reached is still reported.
    expect(value.map((row) => row.ts)).toEqual([995.0]);
    expect(err).toContain("freshness window");
  });

  test("read delivery signals: the scan follows the window", () => {
    // Nothing re-emits these lines, so whatever the daemon journals after one is all that stands
    // between it and the tail. A fixed-size tail read would drop a still-unresolved mute.
    const root = caseRoot("readers");
    const records: unknown[] = [adoptExpired(950.0, { adoptionId: "still-live" })];
    for (let index = 0; index < 200; index += 1) {
      records.push({
        ts: 950.0 + index * 0.01,
        event: "claimed",
        owner: "sec",
        ids: [`row-${"x".repeat(40)}`],
      });
    }
    writeJournal(join(root, "broker"), records);

    const { value, err } = capturedStderr(() =>
      readers.readBrokerDeliverySignals(join(root, "broker"), {
        nowEpoch: 1000,
        windowSec: 3600,
        chunkBytes: 256, // far smaller than the trailing traffic
      }),
    );

    expect(value.map((row) => row["adoption_id"])).toEqual(["still-live"]);
    expect(err).toBe("");
  });

  // -- target-only --------------------------------------------------------------------------

  test("target-only -- production routes the walk through the seam", () => {
    // A seam can rot into a decoration: if the tail walk ever called `chunkReachesCutoff`
    // directly, the linearity case above would replace an entry nothing reaches and stay green,
    // because its assertions are about the ROWS and those hold either way.
    const root = caseRoot("readers");
    writeJournal(join(root, "broker"), [dup(995.0)]);
    let reached = false;
    patchSeam(readers.readersSeams, "chunkReachesCutoff", () => {
      reached = true;
      // Ending the walk here is safe: the whole journal is one chunk.
      return true;
    });

    readers.readBrokerDuplicates(join(root, "broker"), { nowEpoch: 1000, windowSec: 300 });

    expect(reached, "the tail walk did not go through readersSeams.chunkReachesCutoff").toBe(true);
  });

  test("target-only -- a ts JSON.parse renders as Infinity is skipped", () => {
    // The source's `NaN` / `Infinity` journal lines are literals `json.loads` accepts and
    // `JSON.parse` rejects, so in this runtime those two lines are dropped one step earlier, as
    // unparseable. `1e400` is how a finite-looking literal still reaches the non-finite guard
    // here -- without this case that guard would be unreachable from any ported case and could be
    // deleted with the belt still green.
    const root = caseRoot("readers");
    const path = writeJournal(join(root, "broker"), [dup(990.0)]);
    appendJournalText(path, '{"ts": 1e400, "event": "duplicate_sidecar_detected"}\n');

    const out = readers.readBrokerDuplicates(join(root, "broker"), {
      nowEpoch: 1000,
      windowSec: 300,
    });

    expect(out.map((row) => row.ts)).toEqual([990.0]);
  });

  test("target-only -- a journal line split by a Python line boundary is unparseable", () => {
    // `splitlines()` breaks on eleven characters where `split("\n")` breaks on one, and the
    // journal is written with `ensure_ascii=False`, so a U+2028 inside an owner name really does
    // end a line for the source. Reading the tail with `split("\n")` would hand the classifier a
    // record the source never produces.
    const root = caseRoot("readers");
    const path = join(root, "broker", "queue.jsonl");
    mkdirSync(join(root, "broker"), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(dup(990.0, { owner: "a\u2028b" }))}\n${JSON.stringify(dup(995.0))}\n`,
      "utf8",
    );

    const out = readers.readBrokerDuplicates(join(root, "broker"), {
      nowEpoch: 1000,
      windowSec: 300,
    });

    expect(out.map((row) => row.owner)).toEqual(["sec"]);
  });
});
