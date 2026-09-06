/**
 * The liveness observation is taken **before** the transcript read it is
 * composed with (`D-1106`).
 *
 * **This file exists because the composition, not either half, was wrong.**
 * `readTerminalReport` and `#readout` both reach a verdict of the form "the
 * child wrote nothing terminal, and the child is gone, so there will never be a
 * report". Each half is an observation of a different thing at a different
 * instant, and until `D-1106` they were taken in the order read-then-liveness.
 * A child that writes its `result` line and exits *between* them makes both
 * halves true and their conjunction false: the transcript on disk holds a
 * complete, well-formed report, and the verb answers that the turn produced
 * none and never will.
 *
 * **It was measured, not imagined.** `test/lap/parallel-laps.test.ts` releases
 * two fenced children at one instant, which puts their last writes exactly
 * where a poll is in flight, and the Windows `double-green` cells failed on it
 * three times across two Node versions and three separate children. Every
 * failure carried the same evidence once the case was made to print it: a
 * complete `{"type":"result","terminal_reason":"completed",...}` line in
 * `events-000.jsonl`, an empty `stderr-000.log`, and a lap that exited 2
 * saying the child "is gone without writing a result event". In production the
 * same race turns a successful turn into a reported execution failure, and the
 * gate the report would have opened is never opened.
 *
 * **How the race is reproduced without a race.** `#childLiveness` asks
 * `sessionRuntime`, which is a seam, so a case can answer "gone" **and write
 * the child's last line at the same instant** -- which is exactly the
 * interleaving CI observed, with none of its timing. A case here is therefore
 * deterministic on every platform and takes no wall clock. Under the old order
 * both cases below fail; under `D-1106`'s they pass, and the two controls at
 * the end are what says the fix did not simply stop refusing.
 *
 * **Target-only.** No parity ledger claims this file, on the same ground as
 * `test/session/terminal-report.test.ts`: interlock's provider reads its
 * transcript in one pass and has no liveness composition to port.
 *
 * **Nothing here spawns**, for the same reason that file gives: a planted
 * `record.json` and a hand-written `events-NNN.jsonl` drive both verbs, so this
 * file stays out of `SPAWNING_TESTS` and off the Windows serial pass.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  ClaudeCliSessionProvider,
  type TerminalReport,
  type TerminalReportReadout,
} from "../../src/session/claude_cli_provider.js";
import {
  Failure,
  Observation,
  Ok,
  type ProviderResult,
  type SessionReadout,
} from "../../src/session/provider.js";
import { sessionRuntime } from "../../src/session/runtime.js";
import { claudeSessionUuid } from "../../src/session/uuid5.js";
import { caseRoot } from "../testkit/cases.js";
import { patchSeam } from "../testkit/seams.js";
import { recordPlanter } from "./helpers/session-cases.js";

const plantRecord = recordPlanter(claudeSessionUuid);

/** The pid the planted records carry. Never signalled: every probe is a seam. */
const PLANTED_PID = 4242;

/** The transcript file one generation writes. */
function eventsPath(sessionDir: string, generation = 0): string {
  return join(sessionDir, `events-${String(generation).padStart(3, "0")}.jsonl`);
}

/** The `init` line, which is what lets the committed identity read back. */
function initLine(sessionId: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: claudeSessionUuid(sessionId),
  });
}

/** The child's last word: a well-formed, complete `result` line. */
function resultLine(sessionId: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    result: "The fence refuses the push. May I publish?",
    session_id: claudeSessionUuid(sessionId),
  });
}

/**
 * A planted session with a recorded pid and a transcript that has not ended.
 *
 * The provider needs no runnable `claudeCommand`: no case here reaches a spawn,
 * and naming a real CLI would only make that less obvious.
 */
function planted(label: string): {
  readonly provider: ClaudeCliSessionProvider;
  readonly sessionId: string;
  readonly sessionDir: string;
} {
  const root = caseRoot(label);
  const provider = new ClaudeCliSessionProvider(join(root, "state"), {
    claudeCommand: ["node", "--version"],
  });
  const sessionDir = plantRecord(root, label, { pid: PLANTED_PID, pgid: PLANTED_PID });
  writeFileSync(eventsPath(sessionDir), `${initLine(label)}\n`, "utf8");
  return { provider, sessionId: label, sessionDir };
}

/**
 * The child is gone, **and its last line lands as that becomes observable**.
 *
 * This is the whole of the reproduction. `pidExists` is the seam that answers
 * the liveness question for a recorded pid, so appending the `result` line from
 * inside it places the child's final write at precisely the instant the exit is
 * observed -- after any read taken before the question was asked, and before
 * any read taken after it. `isPosix` is patched alongside so the answer is the
 * same on Windows, where an unprobed pid is an unknowable liveness and a
 * different case entirely.
 *
 * Once per session: a real child writes its result once, and repeating it would
 * plant two result lines, which this provider reads as a different transcript.
 */
function goneWritingItsResult(sessionDir: string, sessionId: string): void {
  let written = false;
  patchSeam(sessionRuntime, "isPosix", () => true);
  patchSeam(sessionRuntime, "pidExists", () => {
    if (!written) {
      written = true;
      appendFileSync(eventsPath(sessionDir), `${resultLine(sessionId)}\n`, "utf8");
    }
    return false;
  });
}

/** A child that is simply gone, having written nothing terminal. */
function goneWritingNothing(): void {
  patchSeam(sessionRuntime, "isPosix", () => true);
  patchSeam(sessionRuntime, "pidExists", () => false);
}

function okValue<T>(result: ProviderResult<T>): T {
  expect(result, `expected Ok, got ${String(result)}`).toBeInstanceOf(Ok);
  return (result as Ok<T>).value;
}

function refusalOf(result: ProviderResult<unknown>): Failure {
  expect(result, `expected Failure, got ${String(result)}`).toBeInstanceOf(Failure);
  return result as Failure;
}

function reportOf(result: ProviderResult<TerminalReportReadout>): TerminalReport {
  const readout = okValue(result);
  expect(readout.kind, `expected a report, got ${JSON.stringify(readout)}`).toBe("report");
  return readout as TerminalReport;
}

describe("D-1106: a result written as the child exits is read, not lost", () => {
  test("readTerminalReport answers with the report rather than an execution failure", async () => {
    // The CI failure, in one process. Without the ordering this is
    // `uninterpretable-response: the child ... is gone without writing a result
    // event` -- over a transcript that, by the time anyone looks, contains the
    // report it says was never written.
    const { provider, sessionId, sessionDir } = planted("report-at-exit");
    goneWritingItsResult(sessionDir, sessionId);

    const report = reportOf(await provider.readTerminalReport(sessionId));
    expect(report.report).toBe("The fence refuses the push. May I publish?");
    expect(report.terminalReason).toBe("completed");
    expect(report.isError).toBe(false);
  });

  test("readState reports the state that line names rather than the exit", async () => {
    // `#readout` composes the same two observations in the same order and was
    // wrong in the same way, so it is fixed and evidenced together: a session
    // whose result lands as it exits is OBSERVED at its own terminal word, not
    // reported as a bare process disposition.
    const { provider, sessionId, sessionDir } = planted("state-at-exit");
    goneWritingItsResult(sessionDir, sessionId);

    const readout = okValue<SessionReadout>(await provider.readState(sessionId));
    expect(readout.observation).toBe(Observation.OBSERVED);
    expect(readout.providerState).toBe("completed");
  });

  test("a child that is gone having written nothing terminal is still refused", async () => {
    // The control. The repair must not be "stop concluding that a turn ended
    // badly": an execution failure is still an execution failure, and answering
    // otherwise would leave an ingress polling forever for a report that cannot
    // arrive.
    const { provider, sessionId } = planted("gone-silent");
    goneWritingNothing();

    const failure = refusalOf(await provider.readTerminalReport(sessionId));
    expect(failure.detail).toContain("cannot produce one");
  });

  test("a live child with nothing terminal yet is still a definite nothing", async () => {
    // The other control, on the branch the ordering could have broken in the
    // opposite direction: liveness is now read before the transcript, and a
    // running child must still produce "the turn has not ended" rather than a
    // verdict about a transcript that is merely incomplete.
    const { provider, sessionId } = planted("still-running");
    patchSeam(sessionRuntime, "isPosix", () => true);
    patchSeam(sessionRuntime, "pidExists", () => true);
    // Alive is not enough: an adopted pid is ours only while its command line
    // still carries the committed identity.
    patchSeam(
      sessionRuntime,
      "pidCmdline",
      () => `claude --session-id ${claudeSessionUuid("still-running")}`,
    );

    const readout = okValue<TerminalReportReadout>(await provider.readTerminalReport(sessionId));
    expect(readout.kind).toBe("no-report");
  });
});
