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
 * in `SPAWNING_TESTS` for that reason. What is here is the three decisions step
 * 8 took that a whole-lap case would exercise only incidentally and could not
 * pin: the artifact layout (`D-0061`), the workspace veto (`D-0062`) and what
 * "the turn is over" means (`D-0060`). Each of them has a failure mode that an
 * end-to-end green would not notice.
 */

import { describe, expect, test } from "vitest";

import {
  awaitTerminalReport,
  CREATE_WORKSPACE_TRANSITION,
  LapRefused,
  type LapTerminalReadout,
  LapUsageError,
  lapArtifactDir,
  MaterializedWorkspaceRequired,
  type TerminalReportReader,
} from "../../src/lap/root.js";
import {
  Failure,
  FailureKind,
  Ok,
  type ProviderResult,
  WorkspaceDecision,
  WorkspaceTransition,
  WorkspaceVerdict,
} from "../../src/session/provider.js";
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
    const report = await awaitTerminalReport(
      reader,
      SESSION,
      { pollIntervalMs: 25, timeoutMs: 10_000, sleep },
      tickingClock(1),
    );
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
    const report = await awaitTerminalReport(
      reader,
      SESSION,
      { pollIntervalMs: 0, timeoutMs: 10_000, sleep: recordingSleep() },
      tickingClock(1),
    );
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
        awaitTerminalReport(
          reader,
          SESSION,
          { pollIntervalMs: 0, timeoutMs: 10_000, sleep: recordingSleep() },
          tickingClock(1),
        ),
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
        awaitTerminalReport(
          reader,
          SESSION,
          { pollIntervalMs: 0, timeoutMs: 10_000, sleep: recordingSleep() },
          tickingClock(1),
        ),
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
        awaitTerminalReport(
          reader,
          SESSION,
          { pollIntervalMs: 0, timeoutMs: 1_000, sleep: recordingSleep() },
          tickingClock(400),
        ),
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
        awaitTerminalReport(
          reader,
          SESSION,
          { pollIntervalMs: 2_000, timeoutMs: 1_000, sleep },
          () => now,
        ),
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
        awaitTerminalReport(
          reader,
          SESSION,
          { pollIntervalMs: 10, timeoutMs: 1_000, sleep: overshooting },
          () => now,
        ),
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
    const report = await awaitTerminalReport(
      reader,
      SESSION,
      { pollIntervalMs: 5_000, timeoutMs: 1_000, sleep: exact },
      () => now,
    );
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
        awaitTerminalReport(
          reader,
          SESSION,
          { pollIntervalMs: 0, timeoutMs: 10_000, sleep: recordingSleep() },
          tickingClock(1),
        ),
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
        awaitTerminalReport(
          reader,
          SESSION,
          { pollIntervalMs: 0, timeoutMs: 500, sleep: recordingSleep() },
          tickingClock(500),
        ),
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
        awaitTerminalReport(
          scriptedReader([]),
          SESSION,
          { pollIntervalMs: 0, timeoutMs: -1 },
          tickingClock(1),
        ),
      LapUsageError,
      /timeout_ms/,
    );
    await expectRefusalAsync(
      () =>
        awaitTerminalReport(
          scriptedReader([]),
          SESSION,
          { pollIntervalMs: -1, timeoutMs: 0 },
          tickingClock(1),
        ),
      LapUsageError,
      /poll_interval_ms/,
    );
  });
});
