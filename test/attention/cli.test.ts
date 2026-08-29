/**
 * Ported from interlock `tests/attention/test_cli.py` at `65f36c5` -- 26 cases.
 *
 * The ledger is `parity/attention.cli.ledger.json`. These are the belt's end-to-end cases: readers
 * to classifier to dedup to notify, with the subprocess stubbed. Four mechanisms are rewritten:
 *
 * - the two autouse fixtures become {@link installFixtures}, called at the top of each case. pytest
 *   applies them by declaration; Vitest has no autouse, and a `beforeEach` would put the setup at a
 *   distance from the `onTestFinished` that undoes it (`docs/test-translation-conventions.md`
 *   rule 1).
 * - `monkeypatch.setattr` on `attention.cli.datetime` and `attention.cli.time.sleep` becomes
 *   `patchSeam` on `attentionCliSeams` (rule 5), and the same for `notify._safe_subprocess_run` and
 *   `notify.detect_backend` on `notifySeams`.
 * - `capsys` becomes recording streams installed on those same seam records. The source reaches
 *   `sys.stdout` and `sys.stderr` by name at call time and pytest replaces them wholesale; the
 *   seams are where this port makes the same two streams replaceable.
 * - `build_top_parser().parse_args(argv)` becomes `buildParser().parseArgs(argv, streams)`. The
 *   `args.func(args)` call after it is unchanged, which is the point: these cases exercise the
 *   MOUNTED command, not a hand-built namespace.
 *
 * **One case is adapted rather than ported, and it is the belt's repaired defect.**
 * `test_scan_recovers_from_broken_dedup_state` pins that a corrupt dedup ledger loads as empty
 * state and is rewritten. A2's `D-0904` ruled that behaviour out -- an empty ledger says nothing
 * has been notified, which frees every already-handled event to fire again -- so the case is
 * re-authored to assert the fail-closed answer, per `D-0023`. The entry in the ledger says so and
 * says what the source asserted.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { attentionCliSeams } from "../../src/attention/cli.js";
import { notifySeams, type TextStream } from "../../src/attention/notify.js";
import { pyIsoUtc } from "../../src/attention/pytime.js";
import { ArgparseExit, type ArgparseStreams, type Namespace } from "../../src/cli/parser.js";
import { buildParser, main } from "../../src/cli.js";
import { caseRoot } from "../testkit/cases.js";
import { patchSeam } from "../testkit/seams.js";
import { makeStateDb, writePendingDecisions } from "./helpers/fixtures.js";

/**
 * The instant every case runs at.
 *
 * The CLI computes pending ages from the clock, so timestamps relative to a hard-coded instant
 * drift as the calendar advances -- and the TTL ladder makes that drift load-bearing, because an
 * old fixture eventually slides into the demote and drop tiers and changes what `notify` does.
 * Fixture timestamps are anchored to this instant by {@link staleIso} and the clock is frozen to
 * it, exactly as the source's two fixtures do.
 */
const FROZEN_NOW = new Date(Date.UTC(2026, 4, 12, 12, 0, 0));

/** A record of everything written to one of the two streams. */
interface Recorder extends TextStream {
  text(): string;
}

function recorder(): Recorder {
  const chunks: string[] = [];
  return {
    write(text: string): void {
      chunks.push(text);
    },
    text(): string {
      return chunks.join("");
    },
  };
}

/** What every case installs: the frozen clock, the stubbed subprocess, and both streams. */
interface Fixtures {
  readonly out: Recorder;
  readonly err: Recorder;
}

function installFixtures(): Fixtures {
  const out = recorder();
  const err = recorder();
  // The source's `_suppress_subprocess`: no real OS notification may fire during the suite.
  patchSeam(notifySeams, "safeSubprocessRun", () => ({ returncode: 0 }));
  // The source's `_freeze_now`.
  patchSeam(attentionCliSeams, "now", () => new Date(FROZEN_NOW.getTime()));
  patchSeam(attentionCliSeams, "stdout", () => out);
  patchSeam(attentionCliSeams, "stderr", () => err);
  // `notify` writes its log line to `sys.stdout` when the CLI passes no stream, and its warnings
  // to `sys.stderr`; both are the same two streams pytest's `capsys` captures.
  patchSeam(notifySeams, "stdout", () => out);
  patchSeam(notifySeams, "stderr", () => err);
  return { out, err };
}

/** The parser's own two streams, which no case here asserts on. */
function parserStreams(): ArgparseStreams {
  return { stdout: () => undefined, stderr: () => undefined };
}

/** `build_top_parser().parse_args(argv)`. */
function parse(argv: readonly string[]): Namespace {
  return buildParser().parseArgs(argv, parserStreams());
}

/** `args.func(args)`. */
function run(args: Namespace): number {
  const func = args["func"] as (values: Namespace) => number;
  return func(args);
}

/**
 * `with pytest.raises(SystemExit) as exc: ...` -- run once, and hand back what it raised.
 *
 * `expect(fn).toThrow(...)` followed by a second call in a `try` runs the action TWICE, which for
 * these two cases means a second refusal on stderr and a second attempt at the file. The source
 * runs it once and inspects `exc.value.code`, so this does the same.
 */
function refusalFrom(action: () => unknown): ArgparseExit {
  try {
    action();
  } catch (error) {
    if (error instanceof ArgparseExit) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the command to exit, and it returned");
}

/** The source's `_stale_iso`: an ISO-8601 instant `minutes` before the frozen now. */
function staleIso(minutes: number): string {
  return pyIsoUtc(new Date(FROZEN_NOW.getTime() - minutes * 60_000));
}

/** The source's `_populate_state`. */
function populateState(stateDir: string): void {
  makeStateDb(join(stateDir, "state.db"), [
    { kind: "notify_sent", payload: { kind: "approval_blocked", task_id: "T1", worker: "w1" } },
    { kind: "ci_completed", payload: { status: "failed", pr: 9, task_id: "T2" } },
    { kind: "worker_completed", payload: { task_id: "T3" } },
  ]);
  writePendingDecisions(join(stateDir, "pending_decisions.json"), [
    { task_id: "T4", received_at: staleIso(30), raw_message: "?", status: "pending" },
  ]);
}

/** A `.state` directory that exists and is empty, as every case's `tmp_path / ".state"` is. */
function stateDir(label: string): string {
  const dir = join(caseRoot(label), ".state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The source's `_write_duplicate`: APPEND one `duplicate_sidecar_detected` line.
 *
 * Belt-local rather than added to `./helpers/fixtures.js`, whose `writeJournal` truncates: three
 * cases here append a second and a third line to a journal they already wrote, and the append is
 * the point of two of them. The helpers file belongs to A1 and a shared helper edited in passing
 * changes what another belt's cases assert.
 */
function writeDuplicate(
  brokerDir: string,
  options: { ageSec?: number; owner?: string; instances?: readonly string[] } = {},
): string {
  mkdirSync(brokerDir, { recursive: true });
  const path = join(brokerDir, "queue.jsonl");
  appendFileSync(
    path,
    `${JSON.stringify({
      ts: FROZEN_NOW.getTime() / 1000 - (options.ageSec ?? 5.0),
      event: "duplicate_sidecar_detected",
      owner: options.owner ?? "secretary",
      instances: [...(options.instances ?? ["inst-a", "inst-b"])],
    })}\n`,
    "utf8",
  );
  return path;
}

/** The source's `_write_adopt_expired`. */
function writeAdoptExpired(
  brokerDir: string,
  options: { ageSec?: number; owner?: string; adoptionId?: string; restored?: boolean } = {},
): string {
  mkdirSync(brokerDir, { recursive: true });
  const path = join(brokerDir, "queue.jsonl");
  appendFileSync(
    path,
    `${JSON.stringify({
      ts: FROZEN_NOW.getTime() / 1000 - (options.ageSec ?? 30.0),
      event: "delivery_adopt_expired",
      owner: options.owner ?? "secretary",
      adoption_id: options.adoptionId ?? "ad0011",
      armed_seconds: 300.0,
      lease_dropped: true,
      generation: 4,
      restored: options.restored ?? false,
      restored_generation: null,
    })}\n`,
    "utf8",
  );
  return path;
}

/** The source's `_scan_json`: run a scan and read the JSON payload off stdout. */
function scanJson(out: Recorder, argv: readonly string[]): Record<string, unknown>[] {
  const before = out.text().length;
  const args = parse(argv);
  expect(run(args)).toBe(0);
  return JSON.parse(out.text().slice(before)) as Record<string, unknown>[];
}

/** The dedup ledger as JSON, for the cases that read it back. */
function dedupState(dir: string): {
  events: Record<string, string>;
  pending: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(dir, "attention_notified.json"), "utf8"));
}

describe("attention cli", () => {
  test("a dry-run scan emits events and writes no state", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    populateState(dir);

    const args = parse(["attention", "scan", "--state-dir", dir, "--dry-run", "--json"]);
    expect(run(args)).toBe(0);

    // With --json, stdout is pure JSON and the log lines go to stderr.
    const payload = JSON.parse(out.text()) as Record<string, unknown>[];
    const kinds = payload.map((event) => event["kind"]);
    expect(kinds).toContain("approval_blocked");
    expect(kinds).toContain("ci_failed");
    expect(kinds).toContain("worker_completed");
    expect(kinds).toContain("pending_decision");

    // No dedup state is written in a dry run.
    expect(existsSync(join(dir, "attention_notified.json"))).toBe(false);
  });

  test("a scan records dedup state", () => {
    installFixtures();
    const dir = stateDir("attn-cli");
    populateState(dir);

    run(parse(["attention", "scan", "--state-dir", dir]));
    expect(existsSync(join(dir, "attention_notified.json"))).toBe(true);
    const data = dedupState(dir);
    expect(Object.keys(data.events).some((key) => key.startsWith("event:"))).toBe(true);
    expect(Object.keys(data.pending)).toContain("pending:T4:pending_decision");
  });

  test("a second scan dedupes the same rows", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    populateState(dir);

    run(parse(["attention", "scan", "--state-dir", dir, "--json"]));
    const second = scanJson(out, ["attention", "scan", "--state-dir", dir, "--json"]);
    // The event rows are already recorded, so nothing is notified; the pending row is still
    // inside its cooldown, so it is empty too.
    expect(second).toEqual([]);
  });

  test("a broken dedup ledger is refused, not recovered", () => {
    const { err } = installFixtures();
    const dir = stateDir("attn-cli");
    populateState(dir);
    const dedupPath = join(dir, "attention_notified.json");
    writeFileSync(dedupPath, "{ broken", "utf8");

    // ADAPTED (D-0904 / D-0023). The source asserts the scan returns 0 and that the file is valid
    // JSON afterwards, i.e. that the corrupt ledger was silently replaced with an empty one. That
    // is the inherited defect: an empty ledger says nothing has been notified.
    const args = parse(["attention", "scan", "--state-dir", dir]);
    // Run ONCE and inspect what it threw. Two runs would report the same refusal twice on stderr
    // and would make the untouched-file assertion below about the second attempt rather than the
    // first, which is not the property being pinned.
    expect(refusalFrom(() => run(args)).code).toBe(2);
    expect(err.text()).toContain("attention_notified.json");
    // The refused file is left exactly as it was found, which is the half a silent recovery
    // destroys: an operator can still look at it, and no later run can mistake a rewritten empty
    // ledger for a ledger that was always empty.
    expect(readFileSync(dedupPath, "utf8")).toBe("{ broken");
  });

  test("a scan of an empty state directory is a no-op", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");

    const args = parse(["attention", "scan", "--state-dir", dir, "--json"]);
    expect(run(args)).toBe(0);
    // No state.db and no pending file: no notifications and no state writes.
    expect(existsSync(join(dir, "attention_notified.json"))).toBe(false);
    expect(JSON.parse(out.text())).toEqual([]);
  });

  test("watch exits on max iterations", () => {
    installFixtures();
    patchSeam(attentionCliSeams, "sleep", () => undefined);
    const dir = stateDir("attn-cli");
    populateState(dir);

    const args = parse(["attention", "watch", "--state-dir", dir, "--max-iterations", "2"]);
    expect(run(args)).toBe(0);
  });

  test("a template config flows through to the log line", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    populateState(dir);
    const cfgPath = join(dir, "..", "attention.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        templates: {
          ci_failed: {
            title: JA_CI_FAILED_TITLE,
            body: `PR #{pr} ${JA_CI_FAILED_BODY_MIDDLE}{status}${JA_CI_FAILED_BODY_TAIL}`,
          },
        },
      }),
      "utf8",
    );

    run(parse(["attention", "scan", "--state-dir", dir, "--config", cfgPath, "--dry-run"]));
    // Without --json the log lines go to stdout.
    expect(out.text()).toContain(JA_CI_FAILED_TITLE);
  });

  test("the json payload shows the rendered template", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    populateState(dir);
    const cfgPath = join(dir, "..", "attention.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        templates: {
          ci_failed: { title: "CI Failed Override", body: "PR #{pr} status={status}" },
        },
      }),
      "utf8",
    );

    run(
      parse(["attention", "scan", "--state-dir", dir, "--config", cfgPath, "--dry-run", "--json"]),
    );
    const payload = JSON.parse(out.text()) as Record<string, unknown>[];
    const ci = payload.find((event) => event["kind"] === "ci_failed") as Record<string, unknown>;
    expect(ci["title"]).toBe("CI Failed Override");
    expect(String(ci["body"]).startsWith("PR #")).toBe(true);
    expect(String(ci["body"])).toContain("status=failed");
  });

  test("a severity override in the config reaches the payload", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    populateState(dir);
    const cfgPath = join(dir, "..", "attention.json");
    writeFileSync(cfgPath, JSON.stringify({ notify: { worker_completed: "urgent" } }), "utf8");

    run(
      parse(["attention", "scan", "--state-dir", dir, "--config", cfgPath, "--dry-run", "--json"]),
    );
    const payload = JSON.parse(out.text()) as Record<string, unknown>[];
    const worker = payload.find((event) => event["kind"] === "worker_completed") as Record<
      string,
      unknown
    >;
    expect(worker["severity"]).toBe("urgent");
  });

  test("a demote-tier pending row emits normal through the real config", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    makeStateDb(join(dir, "state.db"), []);
    writePendingDecisions(join(dir, "pending_decisions.json"), [
      {
        task_id: "T-demote",
        // 1500 min is about 25h: past the default `pending_decision_max` (24h) and inside the
        // default `pending_decision_drop` (7d).
        received_at: staleIso(1500),
        raw_message: "demote",
        status: "pending",
      },
    ]);

    run(parse(["attention", "scan", "--state-dir", dir, "--dry-run", "--json"]));
    const payload = JSON.parse(out.text()) as Record<string, unknown>[];
    const demoted = payload.filter(
      (event) => event["task_id"] === "T-demote" && event["kind"] === "pending_decision",
    );
    expect(demoted.length).toBeGreaterThan(0);
    expect((demoted[0] as Record<string, unknown>)["severity"]).toBe("normal");
    expect((demoted[0] as Record<string, unknown>)["suppressed"]).not.toBe(true);
  });

  test("an explicit severity override beats the TTL demote", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    makeStateDb(join(dir, "state.db"), []);
    writePendingDecisions(join(dir, "pending_decisions.json"), [
      {
        task_id: "T-pinned",
        received_at: staleIso(1500),
        raw_message: "pinned",
        status: "pending",
      },
    ]);
    const cfgPath = join(dir, "..", "attention.json");
    writeFileSync(cfgPath, JSON.stringify({ notify: { pending_decision: "urgent" } }), "utf8");

    run(
      parse(["attention", "scan", "--state-dir", dir, "--config", cfgPath, "--dry-run", "--json"]),
    );
    const payload = JSON.parse(out.text()) as Record<string, unknown>[];
    const pinned = payload.filter(
      (event) => event["task_id"] === "T-pinned" && event["kind"] === "pending_decision",
    );
    expect(pinned.length).toBeGreaterThan(0);
    expect((pinned[0] as Record<string, unknown>)["severity"]).toBe("urgent");
  });

  test("a drop-tier pending row still honours the template overrides", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    makeStateDb(join(dir, "state.db"), []);
    writePendingDecisions(join(dir, "pending_decisions.json"), [
      { task_id: "T-old", received_at: staleIso(12000), raw_message: "stale", status: "pending" },
    ]);
    const cfgPath = join(dir, "..", "attention.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        templates: {
          pending_decision: { title: "Stale Pending", body: "task_id={task_id} kind={kind}" },
        },
        // Truncation is exercised too: a tight `max_*` would catch a regression where template
        // rendering was skipped entirely for a suppressed row.
        max_title_chars: 40,
        max_body_chars: 80,
      }),
      "utf8",
    );

    run(parse(["attention", "scan", "--state-dir", dir, "--config", cfgPath, "--json"]));
    const payload = JSON.parse(out.text()) as Record<string, unknown>[];
    const drops = payload.filter((event) => event["task_id"] === "T-old");
    expect(drops.length).toBeGreaterThan(0);
    const first = drops[0] as Record<string, unknown>;
    expect(first["suppressed"]).toBe(true);
    expect(first["title"]).toBe("Stale Pending");
    expect(first["body"]).toBe("task_id=T-old kind=pending_decision");
  });

  test("a drop-tier pending row surfaces in json but is not notified", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    // An empty state.db so the pending row is the only thing classified.
    makeStateDb(join(dir, "state.db"), []);
    writePendingDecisions(join(dir, "pending_decisions.json"), [
      {
        task_id: "T-old",
        // 12000 min is about 8.3 days: past the default `pending_decision_drop` (7d).
        received_at: staleIso(12000),
        raw_message: "old",
        status: "pending",
      },
    ]);

    const args = parse(["attention", "scan", "--state-dir", dir, "--json"]);
    expect(run(args)).toBe(0);
    const payload = JSON.parse(out.text()) as Record<string, unknown>[];
    const drops = payload.filter(
      (event) => event["task_id"] === "T-old" && event["kind"] === "pending_decision",
    );
    expect(drops.length).toBeGreaterThan(0);
    const first = drops[0] as Record<string, unknown>;
    expect(first["suppressed"]).toBe(true);
    expect(first["delivered"]).toBe(false);
    expect(first["desktop_dispatched"]).toBe(false);
    // No dedup file is written: a suppressed row must not lock out a future urgent
    // re-classification if the operator re-arms the entry by trimming `received_at`.
    expect(existsSync(join(dir, "attention_notified.json"))).toBe(false);
  });

  test("a garbled config exits cleanly", () => {
    const { err } = installFixtures();
    const dir = stateDir("attn-cli");
    const cfgPath = join(dir, "..", "broken.json");
    writeFileSync(cfgPath, "{ not json", "utf8");

    const args = parse(["attention", "scan", "--state-dir", dir, "--config", cfgPath]);
    expect(refusalFrom(() => run(args)).code).toBe(2);
    expect(err.text()).toContain("invalid attention config");
  });

  test("a failed dispatch does not dedup", () => {
    installFixtures();
    const dir = stateDir("attn-cli");
    populateState(dir);
    // sound=off so no bell fallback masks the failure.
    const cfgPath = join(dir, "..", "attention.json");
    writeFileSync(cfgPath, JSON.stringify({ sound: "off" }), "utf8");

    // Force every event onto the linux backend with a runner that always fails, simulating
    // `notify-send` failing for want of DBus. Detection is replaced so the host's real backend
    // does not interfere.
    patchSeam(notifySeams, "detectBackend", () => "linux" as const);
    patchSeam(notifySeams, "safeSubprocessRun", () => ({ returncode: 1 }));

    run(parse(["attention", "scan", "--state-dir", dir, "--config", cfgPath]));

    // Nothing reached the user, so nothing was dedup'd.
    const path = join(dir, "attention_notified.json");
    if (existsSync(path)) {
      const data = dedupState(dir);
      expect(data.events).toEqual({});
      expect(data.pending).toEqual({});
    }
  });

  test("the json payload carries a delivered flag", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    populateState(dir);

    run(parse(["attention", "scan", "--state-dir", dir, "--dry-run", "--json"]));
    const payload = JSON.parse(out.text()) as Record<string, unknown>[];
    expect(payload.every((event) => "delivered" in event)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The broker journal consumer
  // -------------------------------------------------------------------------

  test("a duplicate sidecar in the broker journal surfaces", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    writeDuplicate(join(dir, "broker"));

    const payload = scanJson(out, ["attention", "scan", "--state-dir", dir, "--json"]);
    const dups = payload.filter((event) => event["kind"] === "duplicate_sidecar");
    expect(dups.length).toBe(1);
    const first = dups[0] as Record<string, unknown>;
    expect(first["severity"]).toBe("urgent");
    expect(first["worker"]).toBe("secretary");
    expect(String(first["body"])).toContain("inst-a");
    expect(String(first["body"])).toContain("inst-b");
    expect(first["delivered"]).toBe(true);
  });

  test("a duplicate older than the window is ignored", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    writeDuplicate(join(dir, "broker"), { ageSec: 3600.0 });

    const payload = scanJson(out, ["attention", "scan", "--state-dir", dir, "--json"]);
    expect(payload.filter((event) => event["kind"] === "duplicate_sidecar")).toEqual([]);
  });

  test("a duplicate sidecar dedupes within its cooldown", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    writeDuplicate(join(dir, "broker"), { ageSec: 60.0 });
    writeDuplicate(join(dir, "broker"), { ageSec: 30.0 });
    writeDuplicate(join(dir, "broker"), { ageSec: 5.0 });

    const argv = ["attention", "scan", "--state-dir", dir, "--json"];
    const first = scanJson(out, argv);
    expect(first.filter((event) => event["kind"] === "duplicate_sidecar").length).toBe(1);
    // Cooldown-gated rather than write-once: the key lands in the `pending` namespace so it can
    // re-alert later, but not on the next poll.
    const dedup = dedupState(dir);
    expect(
      Object.keys(dedup.pending).some((key) =>
        key.startsWith("broker:duplicate_sidecar:secretary:"),
      ),
    ).toBe(true);
    const second = scanJson(out, argv);
    expect(second.filter((event) => event["kind"] === "duplicate_sidecar")).toEqual([]);
  });

  test("a new duplicate pair is not swallowed", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    writeDuplicate(join(dir, "broker"), { instances: ["inst-a", "inst-b"] });

    const argv = ["attention", "scan", "--state-dir", dir, "--json"];
    scanJson(out, argv);
    writeDuplicate(join(dir, "broker"), { instances: ["inst-a", "inst-c"] });
    const second = scanJson(out, argv);
    const dups = second.filter((event) => event["kind"] === "duplicate_sidecar");
    expect(dups.length).toBe(1);
    expect(String((dups[0] as Record<string, unknown>)["body"])).toContain("inst-c");
  });

  test("a scan without a broker journal is a no-op", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    populateState(dir);

    const payload = scanJson(out, ["attention", "scan", "--state-dir", dir, "--json"]);
    expect(payload.filter((event) => event["kind"] === "duplicate_sidecar")).toEqual([]);
    // The ordinary .state events still classify.
    expect(payload.length).toBeGreaterThan(0);
  });

  test("the broker state dir can be overridden", () => {
    const { out } = installFixtures();
    const root = caseRoot("attn-cli");
    const dir = join(root, ".state");
    mkdirSync(dir, { recursive: true });
    const elsewhere = join(root, "elsewhere", "broker");
    writeDuplicate(elsewhere);

    const payload = scanJson(out, [
      "attention",
      "scan",
      "--state-dir",
      dir,
      "--broker-state-dir",
      elsewhere,
      "--json",
    ]);
    expect(payload.map((event) => event["kind"])).toEqual(["duplicate_sidecar"]);
  });

  test("an adopt expiry in the broker journal surfaces", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    writeAdoptExpired(join(dir, "broker"));

    const payload = scanJson(out, ["attention", "scan", "--state-dir", dir, "--json"]);
    const expired = payload.filter((event) => event["kind"] === "delivery_adopt_expired");
    expect(expired.length).toBe(1);
    const first = expired[0] as Record<string, unknown>;
    expect(first["severity"]).toBe("urgent");
    expect(first["worker"]).toBe("secretary");
    expect(String(first["body"])).toContain("ad0011");
    // `restored: false` is the decisive half: nobody is claiming the owner at all.
    expect(String(first["body"])).toContain("no session is claiming this owner");
    expect(first["delivered"]).toBe(true);
  });

  test("an adopt expiry dedupes within its cooldown", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    writeAdoptExpired(join(dir, "broker"));

    const argv = ["attention", "scan", "--state-dir", dir, "--json"];
    const first = scanJson(out, argv);
    expect(first.filter((event) => event["kind"] === "delivery_adopt_expired").length).toBe(1);
    const dedup = dedupState(dir);
    expect(Object.keys(dedup.pending)).toContain("broker:delivery_adopt_expired:secretary:ad0011");
    const second = scanJson(out, argv);
    expect(second.filter((event) => event["kind"] === "delivery_adopt_expired")).toEqual([]);
  });

  test("a delivery signal older than its own window is ignored", () => {
    const { out } = installFixtures();
    const dir = stateDir("attn-cli");
    // The default `delivery_signal_window_sec` is 3600.
    writeAdoptExpired(join(dir, "broker"), { ageSec: 7200.0 });

    const payload = scanJson(out, ["attention", "scan", "--state-dir", dir, "--json"]);
    expect(payload.filter((event) => event["kind"] === "delivery_adopt_expired")).toEqual([]);
  });

  test("the watch loop reads the broker journal too", () => {
    installFixtures();
    patchSeam(attentionCliSeams, "sleep", () => undefined);
    const dir = stateDir("attn-cli");
    writeDuplicate(join(dir, "broker"));

    const args = parse(["attention", "watch", "--state-dir", dir, "--max-iterations", "1"]);
    expect(run(args)).toBe(0);
    const dedup = dedupState(dir);
    expect(
      Object.keys(dedup.pending).some((key) => key.startsWith("broker:duplicate_sidecar:")),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Target-only. None is counted as ported coverage; each is declared in
  // `parity/attention.cli.ledger.json` with the mutation that measured it red.
  // -------------------------------------------------------------------------

  test("production reads the clock through its seam (target-only)", () => {
    const { out } = installFixtures();
    let asked = 0;
    patchSeam(attentionCliSeams, "now", () => {
      asked += 1;
      return new Date(FROZEN_NOW.getTime());
    });
    const dir = stateDir("attn-cli");
    populateState(dir);
    scanJson(out, ["attention", "scan", "--state-dir", dir, "--dry-run", "--json"]);
    expect(asked).toBe(1);
  });

  test("production sleeps through its seam (target-only)", () => {
    installFixtures();
    const slept: number[] = [];
    patchSeam(attentionCliSeams, "sleep", (seconds: number) => {
      slept.push(seconds);
    });
    const dir = stateDir("attn-cli");
    populateState(dir);
    run(parse(["attention", "watch", "--state-dir", dir, "--max-iterations", "2"]));
    // One poll, one sleep, one poll -- the loop does NOT sleep after the last iteration, which is
    // the difference between `--max-iterations 2` returning at once and returning ten seconds
    // late for every operator who scripts around it.
    expect(slept).toEqual([10]);
  });

  test("a refusal from a command becomes an exit code, not a stack trace (target-only)", () => {
    const { err } = installFixtures();
    const dir = stateDir("attn-cli");
    const cfgPath = join(dir, "..", "broken.json");
    writeFileSync(cfgPath, "{ not json", "utf8");
    // `main` is the port's process top level, and Python's own top level is what turns an escaping
    // `SystemExit` into an exit status. Without that, the message this command wrote is buried
    // under an unhandled error.
    expect(main(["attention", "scan", "--state-dir", dir, "--config", cfgPath])).toBe(2);
    expect(err.text()).toContain("invalid attention config");
  });

  test("attention is mounted on the unified parser (target-only)", () => {
    installFixtures();
    // `D-0030`: one parser, and the subtree's own module declares its flags. The mount is what
    // makes every case above exercise the shipped command rather than a hand-built namespace.
    const args = parse(["attention", "scan", "--state-dir", ".state"]);
    expect(typeof args["func"]).toBe("function");
    expect(args["state_dir"]).toBe(".state");
    expect(args["dry_run"]).toBe(false);
    expect(args["json"]).toBe(false);
  });
});

/**
 * The Japanese template literals one source case carries, as escape sequences.
 *
 * `docs/cli-output-policy.md` (D-0006) scans every byte of this file. The escapes spell
 * "CI ga shippai shimashita" (CI failed) and the two halves of "PR #{pr} no CI ga {status} de
 * kanryou shimashita." (PR #{pr}'s CI finished with {status}.).
 */
const JA_CI_FAILED_TITLE = "CI \u304c\u5931\u6557\u3057\u307e\u3057\u305f";
const JA_CI_FAILED_BODY_MIDDLE = "\u306e CI \u304c ";
const JA_CI_FAILED_BODY_TAIL = " \u3067\u5b8c\u4e86\u3057\u307e\u3057\u305f\u3002";
