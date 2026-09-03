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
    expect(dir).toMatch(/%2E%2E$/);
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
    expect(lapArtifactDir("/r", "a%2Fb")).toMatch(/a%252Fb$/);
  });

  test("two runs never share a directory", () => {
    expect(lapArtifactDir("/r", "run-1")).not.toBe(lapArtifactDir("/r", "run-2"));
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
    expect(refusal.message).toContain("Nothing is rolled back");
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
