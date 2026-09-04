/**
 * Step 8 of the minimal operating loop: the composition root's own rules.
 *
 * **Target-only.** Interlock has no composition root -- that absence is the
 * whole subject of `docs/design/minimal-operating-loop.md` section 1, which
 * records that `dispatcher/runner.py` is 3,488 lines with no tests and was
 * therefore never inventoried. So there is no source node id to port and no
 * parity ledger claims this file, exactly as none claims
 * `test/workspace/materializer.test.ts` (`D-0057`). Rule 10 of
 * `docs/test-translation-conventions.md` applies: each case names what would be
 * silently wrong without it.
 *
 * **This file starts no child process.** The end-to-end lap -- git, a fenced
 * spawn, a real transcript, a CLI verb -- is `test/lap/cli.test.ts`, which is
 * in `SPAWNING_TESTS` for that reason. What is here is the four decisions step
 * 8 took that a whole-lap case would exercise only incidentally and could not
 * pin: the artifact layout (`D-0061`), the workspace veto (`D-0062`), what
 * "the turn is over" means (`D-0060`) and where the `cli_args` allowlist is
 * asked inside the lap (`D-0088`). Each of them has a failure mode that an
 * end-to-end green would not notice.
 *
 * The `D-0088` cases do call `performLap`, which the three older groups do not,
 * and they still start no child and run no git -- because what they are about is
 * a refusal that happens before either. That is the assertion, not a
 * convenience: the check is first in the preflight precisely so that an
 * unauthorised run costs no worktree, no state root and, above all, no delivery
 * lease, and a case that reached git would no longer be able to see that.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, onTestFinished, test } from "vitest";

import { appendEvent } from "../../src/control_plane/events.js";
import { NOTIFY_RECIPIENT } from "../../src/control_plane/handlers.js";
import { isFullyQualified, LapRunIntent } from "../../src/control_plane/lap_run_intent.js";
import { acquire, LeaseHeld, readLease } from "../../src/control_plane/lease.js";
import {
  createProductionControlPlane,
  openProductionControlPlane,
} from "../../src/control_plane/migrator.js";
import {
  RUN_ADMISSION_PRODUCER,
  RUN_DELEGATION_RECORDED_EVENT_TYPE,
} from "../../src/control_plane/run_admission.js";
import { DELIVERY_LEASE_TTL_MS } from "../../src/lap/endpoint_lease.js";

import {
  awaitTerminalReport,
  CREATE_WORKSPACE_TRANSITION,
  LapRefused,
  type LapRequest,
  type LapTerminalReadout,
  LapUsageError,
  lapArtifactDir,
  MaterializedWorkspaceRequired,
  performLap,
  type TerminalReportReader,
} from "../../src/lap/root.js";
import { DELIVERY_LEASE_RESOURCE } from "../../src/messagebus/endpoint.js";
import {
  Failure,
  FailureKind,
  Ok,
  type ProviderResult,
  WorkspaceDecision,
  WorkspaceTransition,
  WorkspaceVerdict,
} from "../../src/session/provider.js";
import { ScriptedProvider } from "../gate_item2/helpers.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusalAsync } from "../testkit/errors.js";

/** An arbitrary fixed epoch-milliseconds instant. */
const T0 = 1_700_000_000_000;

const SESSION = "session-1";

/** A reader that answers with a scripted sequence, one answer per call. */
function scriptedReader(
  answers: readonly ProviderResult<LapTerminalReadout>[],
): TerminalReportReader & { calls: number } {
  const reader = {
    calls: 0,
    readTerminalReport(sessionId: string): Promise<ProviderResult<LapTerminalReadout>> {
      expect(sessionId).toBe(SESSION);
      const answer = answers[reader.calls];
      reader.calls += 1;
      if (answer === undefined) {
        throw new Error("the reader was asked more times than the case scripted");
      }
      return Promise.resolve(answer);
    },
  };
  return reader;
}

/** `Ok` of a turn that has not finished. */
function stillRunning(): Ok<LapTerminalReadout> {
  return new Ok<LapTerminalReadout>({
    kind: "no-report",
    pending: true,
    reason: "the child has not written its terminal line",
  });
}

/** `Ok` of a turn that finished and said something. */
function finished(report = "please review"): Ok<LapTerminalReadout> {
  return new Ok<LapTerminalReadout>({
    kind: "report",
    sessionId: SESSION,
    generation: 0,
    report,
    terminalReason: "completed",
    subtype: "success",
    isError: false,
    returncode: 0,
  });
}

/** A clock that advances by `stepMs` on every read, so a budget can run out. */
function tickingClock(stepMs: number): () => number {
  let now = T0;
  return () => {
    const current = now;
    now += stepMs;
    return current;
  };
}

/** A wait that records what it was asked for and returns immediately. */
function recordingSleep(): ((ms: number) => Promise<void>) & { waits: number[] } {
  const waits: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    waits.push(ms);
    return Promise.resolve();
  };
  return Object.assign(sleep, { waits });
}

// --------------------------------------------------------------------------

describe("D-0061: the artifact directory is derived, one per run", () => {
  test("a plain run identifier is used as it stands", () => {
    // The anti-vacuity half: without it an encoder that mangled every name
    // would satisfy every case below.
    expect(lapArtifactDir("/var/continuo/artifacts", "run-1")).toMatch(
      /[\\/]var[\\/]continuo[\\/]artifacts[\\/]run-1$/,
    );
  });

  test("a run identifier carrying a separator cannot escape the root", () => {
    // `LapRunIntent` holds the identifier to printable ASCII, which admits `/`
    // and `\`. Without the encoding, a run called `a/b` would publish its fence
    // into a SUBDIRECTORY of the artifact root -- and one called `../x` outside
    // it entirely, which is the case the next assertion covers. The
    // materialiser's containment guard protects the worktree, not the operator's
    // filesystem, so nothing downstream would have refused this.
    const dir = lapArtifactDir("/var/artifacts", "a/b");
    expect(dir).toMatch(/[\\/]var[\\/]artifacts[\\/]a%2Fb$/);
    expect(dir).not.toContain("/a/b");
  });

  test("a run identifier of dot segments cannot walk up", () => {
    const dir = lapArtifactDir("/var/artifacts", "..");
    expect(dir).toMatch(/\.%2E$/);
    // Stated as its own assertion because it is the one that matters: `join`
    // would have collapsed a literal `..` and put the fence in `/var`.
    expect(dir).not.toMatch(/artifacts[\\/]\.\.$/);
  });

  test("a lone dot is encoded too", () => {
    // `.` is a legal identifier and is not a legal directory name: unencoded it
    // names the artifact root itself, so two runs would share one fence.
    expect(lapArtifactDir("/var/artifacts", ".")).toMatch(/%2E$/);
  });

  test("the encoding is reversible, so the escape character is escaped", () => {
    // Without this, runs `a%2Fb` and `a/b` would encode to one directory and
    // the second admitted would publish its fence over the first's.
    expect(lapArtifactDir("/r", "a%2Fb")).not.toBe(lapArtifactDir("/r", "a/b"));
    // `%` is `%25` and the literal `F` is `%46`, because uppercase is encoded
    // too -- so the only uppercase in any output is inside an escape this
    // function wrote, which is what makes the encoding injective under the case
    // folding an NTFS volume applies.
    expect(lapArtifactDir("/r", "a%2Fb")).toMatch(/a%252%46b$/);
  });

  test("two runs never share a directory", () => {
    expect(lapArtifactDir("/r", "run-1")).not.toBe(lapArtifactDir("/r", "run-2"));
  });

  test("a run id that encodes past the filesystem's limit is refused here", async () => {
    // The encoding turns one character into three, so a run identifier can
    // exceed a filesystem's 255-character name limit well before it looks long:
    // 86 unsafe characters encode to 258. Left to the filesystem it arrives as
    // an ENAMETOOLONG from inside materialisation, after the branch and the
    // worktree exist -- and `D-0057` refuses a second materialisation, so the
    // run identifier is spent and the operator's recovery is a new one.
    const runId = "/".repeat(86);
    await expectRefusalAsync(
      () => Promise.resolve(lapArtifactDir("/r", runId)),
      LapUsageError,
      /encodes to a directory name of 258 characters/,
    );
  });

  test("a long run id that stays within the limit is accepted", () => {
    // The anti-vacuity half. 255 safe characters encode to 255 and are fine;
    // a cap applied to the raw identifier rather than the encoded one would
    // refuse this, and would still pass the case above.
    const runId = "a".repeat(255);
    expect(lapArtifactDir("/r", runId)).toMatch(/a{255}$/);
  });

  test("two identifiers differing only by case do not fold together", () => {
    // On an NTFS volume `run` and `RUN` are one directory, so two admitted runs
    // would share a fence, a settings file and a ledger -- and would race
    // through the materialiser's check-before-write guard on all three. The
    // failure is invisible on Linux and silent on Windows, which is the pair
    // that makes it worth a case. `D-0216` records the same hazard for the
    // containment guard.
    const upper = lapArtifactDir("/r", "RUN");
    expect(upper).not.toBe(lapArtifactDir("/r", "run"));
    expect(upper.toLowerCase()).not.toBe(lapArtifactDir("/r", "run").toLowerCase());
    // Lowercase is untouched, so the encoding costs readability only where it
    // has to.
    expect(lapArtifactDir("/r", "run-1")).toMatch(/run-1$/);
  });

  test("a trailing dot cannot make two runs one directory", () => {
    // Windows drops it. Without the encoding `run.` and `run` are one path.
    expect(lapArtifactDir("/r", "run.")).toMatch(/run%2E$/);
    expect(lapArtifactDir("/r", "run.")).not.toBe(lapArtifactDir("/r", "run"));
  });

  test("a reserved device name is escaped so the run can be materialised at all", () => {
    // `nul` is a legal run identifier and cannot be a directory on Windows. The
    // failure without this is not a collision but an outright refusal to
    // materialise, on one platform, reported as a path error.
    expect(lapArtifactDir("/r", "nul")).toMatch(/%6Eul$/);
    expect(lapArtifactDir("/r", "com1.log")).toMatch(/%63om1\.log$/);
    // The check is on the stem, and a name that merely starts with one is not
    // reserved -- escaping it would be a rule this function invented.
    expect(lapArtifactDir("/r", "nullable")).toMatch(/nullable$/);
  });
});

describe("D-0067: the worker command names files outright", () => {
  test("a rooted-but-driveless path is refused, not just a relative one", () => {
    // The Windows gap. `path.win32.isAbsolute("\\worktree\\worker.mjs")` is
    // true and the path is **drive-relative**: it resolves against whichever
    // drive the reading process is on, so a probe on `C:` and a child whose
    // workspace is on `D:` resolve one string as two files. The repository
    // already had the right predicate -- `isFullyQualified`, written for
    // exactly this and applied to every persisted path -- and this rule had
    // grown a second, weaker one.
    //
    // Asserted through `isFullyQualified` rather than through a lap, because
    // the answer is platform-dependent and the case has to say what it means on
    // both: everywhere, a relative token is refused; on Windows, so is a rooted
    // one with no drive.
    expect(isFullyQualified("worker.mjs")).toBe(false);
    expect(isFullyQualified("./worker.mjs")).toBe(false);
    if (process.platform === "win32") {
      expect(isFullyQualified("\\worktree\\worker.mjs")).toBe(false);
      expect(isFullyQualified("C:\\tools\\worker.mjs")).toBe(true);
    } else {
      // The anti-vacuity half on POSIX, where the root is always one character
      // and a length test alone would refuse every absolute path there.
      expect(isFullyQualified("/tools/worker.mjs")).toBe(true);
    }
  });
});

describe("D-0062: a workspace this lap did not materialise is vetoed", () => {
  const observer = new MaterializedWorkspaceRequired("/work/tree");

  test("vetoes the provider's bare-mkdir create-workspace transition", () => {
    // The acting half of M2. Without it `ClaudeCliSessionProvider` creates the
    // directory with `mkdirSync(..., { recursive: true })` and spawns into it:
    // a worker in a bare directory with the right name, no checkout, no branch,
    // and a run that looks normal in every record.
    const decision = observer.onWorkspaceTransition(
      new WorkspaceTransition({
        sessionId: SESSION,
        workspace: "/work/tree",
        kind: CREATE_WORKSPACE_TRANSITION,
      }),
    );
    expect(decision.verdict).toBe(WorkspaceVerdict.VETO);
    expect(decision.reason).toContain("/work/tree");
  });

  test("vetoes it even when the path is this lap's own workspace", () => {
    // The case a path comparison would let through, and the reason the rule is
    // "every create-workspace" rather than "an unexpected one": by the time the
    // orchestrator starts, git has made this worktree and the materialiser has
    // re-asked git about it. A provider announcing it is about to create THIS
    // path is reporting that the checkout has been swept away since, which is
    // the more serious failure of the two, not the benign one.
    const decision = observer.onWorkspaceTransition(
      new WorkspaceTransition({
        sessionId: SESSION,
        workspace: "/work/tree",
        kind: CREATE_WORKSPACE_TRANSITION,
      }),
    );
    expect(decision.verdict).toBe(WorkspaceVerdict.VETO);
  });

  test("allows a transition it has no opinion about", () => {
    // An observer that vetoed everything would be an outage wearing a safety
    // check's name, and every case above would still be green.
    const decision = observer.onWorkspaceTransition(
      new WorkspaceTransition({
        sessionId: SESSION,
        workspace: "/work/tree",
        kind: "remove-workspace",
      }),
    );
    expect(decision.verdict).toBe(WorkspaceVerdict.ALLOW);
    expect(WorkspaceDecision.is(decision)).toBe(true);
  });
});

describe("D-0060: the turn is over when the terminal report exists", () => {
  test("the first report ends the poll", async () => {
    const reader = scriptedReader([stillRunning(), finished("please review")]);
    const sleep = recordingSleep();
    const report = await awaitTerminalReport(reader, SESSION, {
      pollIntervalMs: 25,
      timeoutMs: 10_000,
      sleep,
      elapsedMs: tickingClock(1),
    });
    expect(report.report).toBe("please review");
    // Exactly two reads and one wait: a loop that kept polling after a report
    // would be waiting for the child to exit, which D-0060 declines to do.
    expect(reader.calls).toBe(2);
    expect(sleep.waits).toEqual([25]);
  });

  test("a second terminal line is never read", async () => {
    // The hazard D-0056 recorded as belonging to whoever polls. The reader here
    // would answer with a SECOND, different report if asked again; the case is
    // that it is not asked. Without this, a change that polled "until the child
    // exits" would silently escalate the later line, and D-0056's dedup key --
    // per session and generation -- would not tell the two apart.
    const reader = scriptedReader([finished("the real report"), finished("a restatement")]);
    const report = await awaitTerminalReport(reader, SESSION, {
      pollIntervalMs: 0,
      timeoutMs: 10_000,
      sleep: recordingSleep(),
      elapsedMs: tickingClock(1),
    });
    expect(report.report).toBe("the real report");
    expect(reader.calls).toBe(1);
  });

  test("a turn that ended with nothing to say is refused rather than polled", async () => {
    // `pending: false` is a fact, not a diagnosis. A loop that retried on it
    // would spend the whole budget on a turn that had already finished, and the
    // operator would read a timeout where the truth is "the worker said
    // nothing".
    const reader = scriptedReader([
      new Ok<LapTerminalReadout>({
        kind: "no-report",
        pending: false,
        reason: "the turn ended with a blank result",
      }),
    ]);
    await expectRefusalAsync(
      () =>
        awaitTerminalReport(reader, SESSION, {
          pollIntervalMs: 0,
          timeoutMs: 10_000,
          sleep: recordingSleep(),
          elapsedMs: tickingClock(1),
        }),
      LapRefused,
      /without a report to escalate/,
    );
    expect(reader.calls).toBe(1);
  });

  test("a provider refusal is not retried", async () => {
    // An unknown session, an identity incident and an uninterpretable
    // transcript do not become true by waiting, and retrying one would turn a
    // precise refusal into a timeout that names the wrong problem.
    const reader = scriptedReader([
      new Failure(FailureKind.UNKNOWN_SESSION, "no such session"),
      finished(),
    ]);
    await expectRefusalAsync(
      () =>
        awaitTerminalReport(reader, SESSION, {
          pollIntervalMs: 0,
          timeoutMs: 10_000,
          sleep: recordingSleep(),
          elapsedMs: tickingClock(1),
        }),
      LapRefused,
      /could not be read/,
    );
    expect(reader.calls).toBe(1);
  });

  test("the budget runs out and says so, with nothing rolled back", async () => {
    // The clock advances 400ms per read against a 1,000ms budget, so the third
    // read is past the deadline. Without a deadline the lap would wait on a
    // wedged child forever and the gate would never be asked.
    const reader = scriptedReader([stillRunning(), stillRunning(), stillRunning()]);
    const refusal = await expectRefusalAsync(
      () =>
        awaitTerminalReport(reader, SESSION, {
          pollIntervalMs: 0,
          timeoutMs: 1_000,
          sleep: recordingSleep(),
          elapsedMs: tickingClock(400),
        }),
      LapRefused,
      /did not finish its turn within 1000ms/,
    );
    expect(refusal.message).toContain("left exactly as they are");
  });

  test("a poll interval longer than the budget does not extend it", async () => {
    // The sleep is capped at what is left. Without the cap the loop wakes past
    // the deadline and the next read's report is accepted, because the deadline
    // is only consulted on the pending branch -- so a one-second timeout with a
    // two-second interval would accept a report that arrived at two seconds and
    // `--turn-timeout-ms` would bound nothing.
    const reader = scriptedReader([stillRunning(), stillRunning()]);
    // A clock the wait actually moves, so "the sleep overshot the deadline" is
    // a thing this case can observe at all. A clock that ticked per read would
    // reach the deadline whatever the sleep did, and would be green on the bug.
    let now = T0;
    const waits: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      waits.push(ms);
      now += ms;
      return Promise.resolve();
    };
    await expectRefusalAsync(
      () =>
        awaitTerminalReport(reader, SESSION, {
          pollIntervalMs: 2_000,
          timeoutMs: 1_000,
          sleep,
          elapsedMs: () => now,
        }),
      LapRefused,
      /did not finish its turn within 1000ms/,
    );
    // One wait, and it was the remaining budget rather than the interval.
    expect(waits).toEqual([1_000]);
    expect(reader.calls).toBe(2);
  });

  test("a timer that overshoots the deadline does not buy another read", async () => {
    // `setTimeout` promises only not to fire EARLY. A congested event loop can
    // resolve the capped wait long after the deadline it was measured against,
    // and the next iteration reads first -- so a report produced well past
    // `--turn-timeout-ms` would be accepted and the bound would hold only on an
    // idle machine. The sleep here overshoots by a minute, which is what a
    // stalled loop looks like from inside this function.
    const reader = scriptedReader([stillRunning(), finished("far too late")]);
    let now = T0;
    const overshooting = (ms: number): Promise<void> => {
      now += ms + 60_000;
      return Promise.resolve();
    };
    await expectRefusalAsync(
      () =>
        awaitTerminalReport(reader, SESSION, {
          pollIntervalMs: 10,
          timeoutMs: 1_000,
          sleep: overshooting,
          elapsedMs: () => now,
        }),
      LapRefused,
      /did not finish its turn within 1000ms/,
    );
    // The second read never happened, so the late report was never even seen --
    // which is the difference between "not started after the deadline" and
    // "started and then discarded".
    expect(reader.calls).toBe(1);
  });

  test("a wait that lands exactly on the deadline still gets its read", async () => {
    // The other side of the same line, and the reason the post-wait check is
    // strictly-past rather than at-or-past. The cap lands the wait ON the
    // deadline by construction, and the read that follows is the read the wait
    // was for: refusing it would throw away a report that arrived while
    // sleeping, which this function never does.
    const reader = scriptedReader([stillRunning(), finished("arrived while sleeping")]);
    let now = T0;
    const exact = (ms: number): Promise<void> => {
      now += ms;
      return Promise.resolve();
    };
    const report = await awaitTerminalReport(reader, SESSION, {
      pollIntervalMs: 5_000,
      timeoutMs: 1_000,
      sleep: exact,
      elapsedMs: () => now,
    });
    expect(report.report).toBe("arrived while sleeping");
    expect(reader.calls).toBe(2);
  });

  test("a report about another session is refused, not ingested", async () => {
    // The value is on its way to becoming a gate: `ingestTerminalReport` keys
    // the escalation on the session and generation the report carries, so a
    // mismatched one would open this run's gate over another session's words --
    // a human asked to approve something no part of this lap ran. The reader is
    // a parameter, so this is checked rather than trusted.
    const reader = scriptedReader([
      new Ok<LapTerminalReadout>({
        kind: "report",
        sessionId: "some-other-session",
        generation: 0,
        report: "a report about somebody else's turn",
        terminalReason: "completed",
        subtype: "success",
        isError: false,
        returncode: 0,
      }),
    ]);
    await expectRefusalAsync(
      () =>
        awaitTerminalReport(reader, SESSION, {
          pollIntervalMs: 0,
          timeoutMs: 10_000,
          sleep: recordingSleep(),
          elapsedMs: tickingClock(1),
        }),
      LapRefused,
      /is about some-other-session/,
    );
  });

  test("the deadline is taken before the first read", async () => {
    // A budget started from the first ANSWER gives a provider that blocks for
    // the whole timeout an unbounded second chance. The clock here jumps the
    // whole budget on its first read, so a correct implementation gives up on
    // the next check and a wrong one polls twice.
    const reader = scriptedReader([stillRunning(), stillRunning()]);
    await expectRefusalAsync(
      () =>
        awaitTerminalReport(reader, SESSION, {
          pollIntervalMs: 0,
          timeoutMs: 500,
          sleep: recordingSleep(),
          elapsedMs: tickingClock(500),
        }),
      LapRefused,
      /did not finish its turn/,
    );
    expect(reader.calls).toBe(1);
  });

  test("a malformed budget is a caller's defect, not a refusal", async () => {
    // `LapUsageError` and not `LapRefused`: the CLI turns the refusal family
    // into exit 2 with a one-line message, and a negative timeout is a bug in
    // whatever built the request rather than a state an operator acts on.
    await expectRefusalAsync(
      () =>
        awaitTerminalReport(scriptedReader([]), SESSION, {
          pollIntervalMs: 0,
          timeoutMs: -1,
          elapsedMs: tickingClock(1),
        }),
      LapUsageError,
      /timeout_ms/,
    );
    await expectRefusalAsync(
      () =>
        awaitTerminalReport(scriptedReader([]), SESSION, {
          pollIntervalMs: -1,
          timeoutMs: 0,
          elapsedMs: tickingClock(1),
        }),
      LapUsageError,
      /poll_interval_ms/,
    );
  });
});

// --------------------------------------------------------------------------
// D-0088: the cli_args allowlist, asked again at the head of the lap
// --------------------------------------------------------------------------

const RUN_ID = "run-cli-args-1";
const HOLDER = "operator-1";

/** A second claimant, for the case that needs `outbox-delivery` already taken. */
const OTHER_HOLDER = "operator-2";

/** A role on the fence roster, so nothing here is refused for being unknown. */
const ROLE = "worker";

/**
 * A vector `src/fencing/cli_args_allow.json` does not authorise -- and cannot
 * today, because the shipped document's entry list is empty (`D-0088`, decision
 * D1), which is what makes "not authorised" the answer for every non-empty
 * vector rather than for a chosen few. It is spelled as a flag `D-0086` named
 * outright so that the case reads as the successor to that decision rather than
 * as a case about an arbitrary string.
 */
const UNAUTHORISED: readonly string[] = ["--dangerously-skip-permissions"];

/** A reader every case below must fail before reaching. */
const UNREACHED_READER: TerminalReportReader = {
  readTerminalReport(): Promise<ProviderResult<LapTerminalReadout>> {
    throw new Error("the transcript must not be read: these laps fail before the turn");
  },
};

interface LapFixture {
  readonly connection: SqliteDatabase;
  readonly provider: ScriptedProvider;
  readonly request: LapRequest;
  /**
   * `request.providerStateRoot`, named separately because whether it EXISTS is
   * an assertion here rather than a path a case passes along.
   */
  readonly stateRoot: string;
}

/**
 * A control plane holding one run admitted to perform with `cliArgs`, and a
 * `performLap` request over it.
 *
 * **The admission is written here rather than taken from `admitRun`, and both
 * halves of why are load-bearing.** `admitRun` now refuses exactly the vector
 * the first two cases need (`D-0088`, the check beside the roster check), so it
 * cannot produce this fixture at all; and the event spine is append-only by
 * trigger -- `event_rows_are_immutable` -- so a row `admitRun` did write cannot
 * have its payload edited afterwards either. What is on the table here is
 * therefore the state this preflight check exists for and no other: a run
 * admitted while the document still authorised its vector, or by a build older
 * than `D-0088`, sitting on the spine waiting to perform. The payload is
 * produced by the record's own writer (`LapRunIntent.payload`) rather than
 * hand-typed JSON, so the fixture cannot drift from the shape
 * `readLapRunIntent` demands and go green on a run this build could not read.
 *
 * The empty-vector case is built the same way rather than through `admitRun`,
 * because two fixtures differing in a second respect would leave "the empty
 * vector was carried through" arguable on the difference that was not the point.
 * That `admitRun` accepts an empty vector is admission's own case to make.
 *
 * `run_created` is deliberately not appended: `readLapRunIntent` reads the
 * delegation payload alone, and every lap here refuses before anything consults
 * the run's status.
 */
function admittedRun(label: string, cliArgs: readonly string[]): LapFixture {
  const root = caseRoot(label);
  const databasePath = join(root, "production.sqlite3");
  createProductionControlPlane(databasePath, { nowMs: T0 }).close();
  const connection = openProductionControlPlane(databasePath);
  onTestFinished(() => {
    connection.close();
  });

  const intent = new LapRunIntent({
    runId: RUN_ID,
    leaseClaimantId: HOLDER,
    workspace: join(root, "worktree"),
    role: ROLE,
    baseBranch: "main",
    topicBranch: "feat/topic",
    prompt: "do the work",
    cliArgs,
  });
  connection
    .prepare<{ run_id: string; created_at_ms: number }>(
      "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) " +
        "VALUES (:run_id, 'created', :created_at_ms, :created_at_ms)",
    )
    .run({ run_id: RUN_ID, created_at_ms: T0 });
  const factId = `${RUN_DELEGATION_RECORDED_EVENT_TYPE}/${RUN_ID}`;
  appendEvent(connection, {
    eventId: factId,
    eventType: RUN_DELEGATION_RECORDED_EVENT_TYPE,
    subjectKind: "run",
    subjectId: RUN_ID,
    dedupKey: factId,
    producer: RUN_ADMISSION_PRODUCER,
    occurredAtMs: T0,
    ingestedAtMs: T0,
    runId: RUN_ID,
    payload: intent.payload,
  });

  const stateRoot = join(root, "state");
  return {
    connection,
    provider: new ScriptedProvider(),
    stateRoot,
    request: {
      runId: RUN_ID,
      // Never reached: every case here refuses before the materialiser, which
      // is what keeps this file free of git. A path to a repository that does
      // not exist is therefore the honest value -- a real checkout here would
      // suggest something in this group depends on one.
      repository: join(root, "repo"),
      artifactRoot: join(root, "artifacts"),
      providerStateRoot: stateRoot,
      workerCommand: [process.execPath],
      endpoint: {
        recipient: NOTIFY_RECIPIENT,
        destinationDir: join(root, "destination"),
        endpointModule: join(root, "endpoint.js"),
        node: process.execPath,
      },
      fence: { interlockRoot: root, claudeOrgPath: join(root, "claude-org") },
      nowMs: () => T0,
      sessionUuidFactory: () => SESSION,
      completion: { pollIntervalMs: 0, timeoutMs: 1_000 },
      gitTimeoutMs: 60_000,
    },
  };
}

describe("D-0088: the lap asks the cli_args allowlist again, first, before it takes anything", () => {
  test("a run whose arguments the document does not authorise is refused by name", async () => {
    // **Why the lap asks a question `run admit` already answered, and why this
    // is not a duplicate check.** The allowlist is a document. It can be
    // narrowed AFTER a run is admitted -- an entry withdrawn because the flag it
    // authorised turned out to widen the fence -- and the later read is the one
    // that wins. If the lap trusted admission, narrowing the document would stop
    // only FUTURE admissions: every run already sitting admitted would still
    // reach a child with the arguments the document has just stopped
    // authorising, and an operator who removed an entry would have removed
    // nothing they could point at. `cliArgsRefusal` re-reads on every call for
    // exactly that reason, and this is the last read before the spawn.
    //
    // The detail is asserted in three parts because an operator refused here
    // can act on none of them alone: the ROLE (the allowlist authorises a
    // vector for a role, so the answer depends on which one), the VECTOR as
    // submitted, and the DOCUMENT -- "this is not authorised" without a path
    // names no place to go and, under the shipped empty document, is what every
    // non-empty vector gets.
    const f = admittedRun("cli-args-unauthorised", UNAUTHORISED);
    const refusal = await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      LapRefused,
      /is not authorised for role 'worker'/,
    );
    expect(refusal.message).toContain("--dangerously-skip-permissions");
    expect(refusal.message).toContain(join("src", "fencing", "cli_args_allow.json"));
    expect(refusal.message).toContain("must equal an authorised vector exactly");
  });

  test("the refusal costs nothing: no delivery lease, no state root, no spawn", async () => {
    // **The case that would catch a future reorder**, and the only reason the
    // check is FIRST in the preflight rather than merely present in it. A
    // refusal that fires one line later has already run
    // `requireUsableStateRoot`, which creates the provider's state root; two
    // lines later, `holdDeliveryLease` has written a lease row and consumed an
    // epoch on `outbox-delivery` -- ONE global resource (`D-0053` rule 4), so
    // for as long as this doomed lap holds it a second lap that would have
    // succeeded is refused `LeaseHeld`. A run that is going to be refused must
    // not first take a resource away from the lap that could have used it.
    //
    // Each assertion is a different kind of cost and none implies the others:
    // the lease is a resource taken from somebody else, the state root is a
    // directory left on an operator's disk by a run that never ran, and the
    // spawn is the child itself. A build that moved the check below the lease
    // acquisition would still refuse, still say the right thing, and still pass
    // the case above.
    const f = admittedRun("cli-args-costs-nothing", UNAUTHORISED);
    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      LapRefused,
      /is not authorised for role/,
    );

    expect(readLease(f.connection, DELIVERY_LEASE_RESOURCE)).toBeUndefined();
    expect(existsSync(f.stateRoot)).toBe(false);
    expect(f.provider.startCalls).toEqual([]);
  });

  test("an empty cli_args vector is carried past the check, as every lap is", async () => {
    // The anti-vacuity half, and it is not a hypothetical shape: a zero-length
    // vector is what every lap this repository has ever performed submits, so a
    // check that refused it -- which a literal exact match against an empty
    // entry list does -- would stop the whole system rather than the arguments
    // it was written for. `D-0088` decision D10 makes the empty vector
    // authorised by a RULE, and this is the case that observes the rule from
    // inside the lap.
    //
    // Observed by where the lap gets to rather than by a green lap: this file
    // starts no child and runs no git (see the module docstring), and the
    // question here is only whether the preflight's first entry lets the vector
    // through. So the delivery resource is taken by somebody else first, and
    // the lap is watched arriving at step 1b and being refused `LeaseHeld` --
    // the step immediately after the whole preflight. The state root pins the
    // same thing from the other end: it exists only because
    // `requireUsableStateRoot`, which is the second-to-last preflight entry,
    // ran. A build that refused the empty vector would fail both, with a
    // `LapRefused` naming the document. The end-to-end laps that then go on to
    // materialise and spawn with an empty vector are in `test/lap/cli.test.ts`,
    // `test/lap/teardown.test.ts` and `test/lap/endpoint-lease.test.ts`.
    const f = admittedRun("cli-args-empty", []);
    acquire(f.connection, {
      resource: DELIVERY_LEASE_RESOURCE,
      holder: OTHER_HOLDER,
      nowMs: T0,
      ttlMs: DELIVERY_LEASE_TTL_MS,
    });

    await expectRefusalAsync(
      () => performLap(f.connection, f.provider, UNREACHED_READER, f.request),
      LeaseHeld,
      /outbox-delivery/,
    );

    expect(existsSync(f.stateRoot)).toBe(true);
    // And the lap stopped there rather than going on: nothing below step 1b ran,
    // which is what makes the refusal above evidence about the preflight only.
    expect(f.provider.startCalls).toEqual([]);
  });
});
