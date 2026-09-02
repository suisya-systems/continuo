/**
 * `ClaudeCliSessionProvider.readTerminalReport` -- the reading half of the
 * report ingress (`D-0056`).
 *
 * No parity ledger claims this file. The verb has no counterpart in interlock:
 * it closes a seam `docs/design/minimal-operating-loop.md` section 4.7
 * describes as having no mechanism at all, and the source's provider drops the
 * `result` body on the floor exactly as this port's did before this change. So
 * every case here is target-only, and each names what would be silently wrong
 * without it (`docs/test-translation-conventions.md` rule 10).
 *
 * **Nothing here spawns.** `#find` adopts a valid on-disk record into the
 * session table on first read, so a planted `record.json` plus a hand-written
 * `events-NNN.jsonl` drives the whole verb -- which is the shape
 * `test_an_unreadable_output_file_is_could_not_observe_not_a_failure` already
 * uses. That keeps this file out of `SPAWNING_TESTS` in `scripts/run-suite.mjs`
 * and off the Windows serial pass, and it is what lets a case plant a
 * transcript no CLI would actually emit -- two `result` lines, a blank body --
 * which is the point of most of them.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  ClaudeCliSessionProvider,
  type TerminalReport,
  type TerminalReportReadout,
} from "../../src/session/claude_cli_provider.js";
import { Failure, FailureKind, Ok, type ProviderResult } from "../../src/session/provider.js";
import { sessionRuntime } from "../../src/session/runtime.js";
import { claudeSessionUuid } from "../../src/session/uuid5.js";
import { caseRoot } from "../testkit/cases.js";
import { patchSeam } from "../testkit/seams.js";
import { recordPlanter } from "./helpers/session-cases.js";

const plantRecord = recordPlanter(claudeSessionUuid);

/**
 * A provider over a planted state root.
 *
 * No `claudeCommand` that resolves to anything runnable is needed: not one case
 * below reaches a spawn, and naming a real CLI would only make that less
 * obvious.
 */
function providerAt(root: string): ClaudeCliSessionProvider {
  return new ClaudeCliSessionProvider(join(root, "state"), {
    claudeCommand: ["node", "--version"],
  });
}

/** One stream-json line per event, ending with the newline the parser needs. */
function plantTranscript(
  sessionDir: string,
  events: readonly Record<string, unknown>[],
  generation = 0,
): void {
  const name = `events-${String(generation).padStart(3, "0")}.jsonl`;
  writeFileSync(
    join(sessionDir, name),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

/** The `init` line every well-formed transcript opens with, naming the identity. */
function initLine(sessionId: string): Record<string, unknown> {
  return { type: "system", subtype: "init", session_id: claudeSessionUuid(sessionId) };
}

/** A `result` line, with whatever this case wants to say about it. */
function resultLine(
  sessionId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    result: "The fence refuses the push. May I publish?",
    session_id: claudeSessionUuid(sessionId),
    ...overrides,
  };
}

function okValue<T>(result: ProviderResult<T>): T {
  expect(result, `expected Ok, got ${String(result)}`).toBeInstanceOf(Ok);
  return (result as Ok<T>).value;
}

function refusalOf(result: ProviderResult<unknown>): Failure {
  expect(result, `expected Failure, got ${String(result)}`).toBeInstanceOf(Failure);
  return result as Failure;
}

/** The readout as a report, asserted rather than cast. */
function reportOf(result: ProviderResult<TerminalReportReadout>): TerminalReport {
  const readout = okValue(result);
  expect(readout.kind, `expected a report, got ${JSON.stringify(readout)}`).toBe("report");
  return readout as TerminalReport;
}

/** The readout as a definite nothing, with the reason it carries. */
function noReport(result: ProviderResult<TerminalReportReadout>): {
  readonly pending: boolean;
  readonly reason: string;
} {
  const readout = okValue(result);
  expect(readout.kind, `expected no-report, got ${JSON.stringify(readout)}`).toBe("no-report");
  return readout as { readonly pending: boolean; readonly reason: string };
}

/**
 * A recorded child that is still running, without spawning one.
 *
 * `#childLiveness` asks the seam rather than `process.platform` or a real
 * signal, precisely so a case can say "alive" on every platform. Patching both
 * members keeps the answer off Windows' unknowable-liveness branch, which is a
 * different case than the one being made here.
 */
function recordedChildIsAlive(sessionId: string): void {
  patchSeam(sessionRuntime, "isPosix", () => true);
  patchSeam(sessionRuntime, "pidExists", () => true);
  // Alive is not enough: an adopted pid is ours only if its command line still
  // carries the committed identity, which is what stops a recycled pid from
  // being read as the session's own child.
  patchSeam(
    sessionRuntime,
    "pidCmdline",
    () => `claude --session-id ${claudeSessionUuid(sessionId)}`,
  );
}

/** A planted session whose transcript is whatever the case says it is. */
function planted(
  label: string,
  events: readonly Record<string, unknown>[],
  options: { readonly generation?: number; readonly overrides?: Record<string, unknown> } = {},
): { provider: ClaudeCliSessionProvider; sessionId: string } {
  const root = caseRoot(label);
  const provider = providerAt(root);
  const generation = options.generation ?? 0;
  const sessionDir = plantRecord(root, label, { generation, ...options.overrides });
  plantTranscript(sessionDir, events, generation);
  return { provider, sessionId: label };
}

describe("a finished turn that wrote prose", () => {
  test("the report and the turn's terminal words come back together", async () => {
    // The whole point of the verb: without it the body of the `result` line is
    // read by nobody, and the ingress would have to rebuild this module's
    // private wire format to reach it.
    const { provider, sessionId } = planted("reported", [
      initLine("reported"),
      resultLine("reported"),
    ]);

    const report = reportOf(await provider.readTerminalReport(sessionId));
    expect(report).toEqual({
      kind: "report",
      sessionId,
      generation: 0,
      report: "The fence refuses the push. May I publish?",
      terminalReason: "completed",
      subtype: "success",
      isError: false,
      // Nothing this provider spawned, so there is no process disposition.
      returncode: null,
    });
  });

  test("the body is verbatim, not trimmed", async () => {
    // The report is quoted into `gate.rationale` and shown to a human. If the
    // provider trimmed it, the gate's text and the transcript's would disagree
    // about what the worker actually wrote.
    const { provider, sessionId } = planted("verbatim", [
      initLine("verbatim"),
      resultLine("verbatim", { result: "  leading and trailing  \n" }),
    ]);

    const report = reportOf(await provider.readTerminalReport(sessionId));
    expect(report.report).toBe("  leading and trailing  \n");
  });

  test("a failed turn that still wrote prose is reported, not withheld", async () => {
    // The provider observes; it does not judge. `is_error` reaches the caller
    // as a fact so the ingress can apply D-0056 decision 2 -- if the provider
    // swallowed these, the ingress could not tell "the turn failed" from "the
    // turn said nothing".
    const { provider, sessionId } = planted("errored", [
      initLine("errored"),
      resultLine("errored", { is_error: true, result: "the tool crashed" }),
    ]);

    const report = reportOf(await provider.readTerminalReport(sessionId));
    expect(report.isError).toBe(true);
    expect(report.report).toBe("the tool crashed");
  });

  test("Python truthiness decides is_error, not JavaScript's", async () => {
    // `is_error: 0` is the CLI saying no. Read with `Boolean(...)` this would be
    // false too, but `is_error: ""` and `is_error: []` would not agree between
    // the two languages, and this provider's other readers all use `pyTruthy`.
    const { provider, sessionId } = planted("falsy", [
      initLine("falsy"),
      resultLine("falsy", { is_error: 0 }),
    ]);

    const report = reportOf(await provider.readTerminalReport(sessionId));
    expect(report.isError).toBe(false);
  });

  test("the last result line wins, as it does for the readout", async () => {
    // Two readers of one file must not disagree about which line is terminal.
    // A forward scan here would report the first turn's words while `readState`
    // reported the second's.
    const { provider, sessionId } = planted("twice", [
      initLine("twice"),
      resultLine("twice", { result: "first", terminal_reason: "interrupted" }),
      resultLine("twice", { result: "second", terminal_reason: "completed" }),
    ]);

    const report = reportOf(await provider.readTerminalReport(sessionId));
    expect(report.report).toBe("second");
    expect(report.terminalReason).toBe("completed");

    // And the readout, reading the same file, names the same line.
    const readout = okValue(await provider.readState(sessionId));
    expect(readout.providerState).toBe("completed");
  });
});

describe("the generation is the turn", () => {
  test("the report is read off the record's own generation", async () => {
    // A resumed session writes a second transcript under a second generation.
    // Reading generation 0 while the record says 2 would hand the ingress the
    // previous turn's report under the current turn's dedup key.
    const root = caseRoot("resumed");
    const provider = providerAt(root);
    const sessionDir = plantRecord(root, "resumed", { generation: 2 });
    plantTranscript(sessionDir, [initLine("resumed"), resultLine("resumed", { result: "old" })], 0);
    plantTranscript(sessionDir, [initLine("resumed"), resultLine("resumed", { result: "new" })], 2);

    const report = reportOf(await provider.readTerminalReport("resumed"));
    expect(report.generation).toBe(2);
    expect(report.report).toBe("new");
  });
});

describe("turns with no report to read", () => {
  test("pending is a field, not a sentence to be parsed", async () => {
    // The one bit a polling caller actually branches on. If both answers were
    // spelled only in the prose of `reason`, a caller would either poll forever
    // on a turn that had ended saying nothing, or stop early on one that had
    // not finished -- and the first reworded message would change which.
    recordedChildIsAlive("pending-live");
    const live = planted(
      "pending-live",
      [
        initLine("pending-live"),
        { type: "assistant", session_id: claudeSessionUuid("pending-live") },
      ],
      { overrides: { pid: 4242, pgid: 4242 } },
    );
    expect(noReport(await live.provider.readTerminalReport(live.sessionId)).pending).toBe(true);

    const finished = planted("pending-done", [
      initLine("pending-done"),
      resultLine("pending-done", { result: "   " }),
    ]);
    expect(noReport(await finished.provider.readTerminalReport(finished.sessionId)).pending).toBe(
      false,
    );
  });

  test("a live child with no result line yet is a definite nothing", async () => {
    // The ordinary polling shape: the turn is simply not over. A `Failure` here
    // would make the ingress treat every poll before the end as an error.
    recordedChildIsAlive("running");
    const { provider, sessionId } = planted(
      "running",
      [initLine("running"), { type: "assistant", session_id: claudeSessionUuid("running") }],
      { overrides: { pid: 4242, pgid: 4242 } },
    );

    expect(noReport(await provider.readTerminalReport(sessionId)).reason).toContain(
      "has not ended",
    );
  });

  test("a child that is gone without a result line is an execution failure", async () => {
    // The distinction that decides whether a caller polls again or gives up.
    // Answering "the turn has not ended" here would leave an ingress waiting
    // forever for a report that can never arrive.
    const { provider, sessionId } = planted("abandoned", [
      initLine("abandoned"),
      { type: "assistant", session_id: claudeSessionUuid("abandoned") },
    ]);

    const failure = refusalOf(await provider.readTerminalReport(sessionId));
    expect(failure.kind).toBe(FailureKind.UNINTERPRETABLE_RESPONSE);
    expect(failure.detail).toContain("cannot produce one");
  });

  test("a complete unparseable line is never stepped over", async () => {
    // `#readout` refuses to drop one silently and neither does this: the
    // unparseable line may be the event that would have named the identity, so
    // a report read past it is a report read past its own authorisation.
    const root = caseRoot("garbled");
    const provider = providerAt(root);
    const sessionDir = plantRecord(root, "garbled");
    writeFileSync(
      join(sessionDir, "events-000.jsonl"),
      `${JSON.stringify(initLine("garbled"))}\n{not json\n${JSON.stringify(resultLine("garbled"))}\n`,
      "utf8",
    );

    const failure = refusalOf(await provider.readTerminalReport("garbled"));
    expect(failure.kind).toBe(FailureKind.UNINTERPRETABLE_RESPONSE);
  });

  test("a result line with no body is a definite nothing", async () => {
    const { provider, sessionId } = planted("bodiless", [
      initLine("bodiless"),
      resultLine("bodiless", { result: undefined }),
    ]);

    expect(noReport(await provider.readTerminalReport(sessionId)).reason).toContain(
      "carries no report",
    );
  });

  test("a blank body is a definite nothing, by CPython's blank set", async () => {
    // `pyStrip`, not `String.prototype.trim`: the two disagree on which
    // codepoints are whitespace, and the source side's answer is the one this
    // port owes.
    for (const blank of ["", "   ", "\n\t "]) {
      const label = `blank-${blank.length}`;
      const { provider, sessionId } = planted(label, [
        initLine(label),
        resultLine(label, { result: blank }),
      ]);
      expect(noReport(await provider.readTerminalReport(sessionId)).reason).toContain(
        "blank report",
      );
    }
  });

  test("a non-string body is refused rather than coerced", async () => {
    // An object here stringified as "[object Object]" would become a gate
    // rationale a human is asked to approve.
    const { provider, sessionId } = planted("structured", [
      initLine("structured"),
      resultLine("structured", { result: { text: "hello" } }),
    ]);

    // Specifically not "[object Object]".
    expect(noReport(await provider.readTerminalReport(sessionId)).reason).toContain(
      "carries no report",
    );
  });

  test("an incomplete last line is not read", async () => {
    // The complete-lines-only rule. A child that is mid-write has not said
    // anything yet, and parsing the fragment would report a truncated report as
    // the worker's words.
    recordedChildIsAlive("partial");
    const root = caseRoot("partial");
    const provider = providerAt(root);
    const sessionDir = plantRecord(root, "partial", { pid: 4242, pgid: 4242 });
    writeFileSync(
      join(sessionDir, "events-000.jsonl"),
      `${JSON.stringify(initLine("partial"))}\n${JSON.stringify(resultLine("partial")).slice(0, 40)}`,
      "utf8",
    );

    expect(noReport(await provider.readTerminalReport("partial")).reason).toContain(
      "has not ended",
    );
  });
});

describe("a report whose identity does not reconcile is refused", () => {
  test("an event naming another session impounds this one", async () => {
    // U27: two processes reporting one id, or one reporting another's. A report
    // read off such a transcript might be another run's worker asking for
    // approval on this run's gate.
    const { provider, sessionId } = planted("mismatched", [
      { type: "system", subtype: "init", session_id: claudeSessionUuid("somebody-else") },
      resultLine("mismatched"),
    ]);

    const failure = refusalOf(await provider.readTerminalReport(sessionId));
    expect(failure.kind).toBe(FailureKind.IDENTITY_INCIDENT);

    // Impounded, not warned about: the readout agrees, and it agrees because
    // the incident was persisted rather than recomputed.
    expect(refusalOf(await provider.readState(sessionId)).kind).toBe(FailureKind.IDENTITY_INCIDENT);
  });

  test("a finished turn that never named itself is not accepted on trust", async () => {
    // The positive half of the read-back. Structured output that never names an
    // identity cannot be reconciled with the one committed before the spawn,
    // and a report is exactly the thing that must not be taken on trust.
    const { provider, sessionId } = planted("anonymous", [
      { type: "system", subtype: "init" },
      resultLine("anonymous", { session_id: undefined }),
    ]);

    const failure = refusalOf(await provider.readTerminalReport(sessionId));
    expect(failure.kind).toBe(FailureKind.UNINTERPRETABLE_RESPONSE);
    expect(failure.detail).toContain("not accepted on trust");
  });

  test("an already impounded session keeps refusing", async () => {
    const { provider, sessionId } = planted(
      "impounded",
      [initLine("impounded"), resultLine("impounded")],
      { overrides: { incident: "an earlier read found two identities" } },
    );

    expect(refusalOf(await provider.readTerminalReport(sessionId)).kind).toBe(
      FailureKind.IDENTITY_INCIDENT,
    );
  });
});

describe("sessions this provider cannot answer for", () => {
  test("an unknown session refuses as one", async () => {
    const root = caseRoot("unknown");
    const provider = providerAt(root);

    expect(refusalOf(await provider.readTerminalReport("never-started")).kind).toBe(
      FailureKind.UNKNOWN_SESSION,
    );
  });

  test("an unreadable record refuses rather than reporting an empty turn", async () => {
    // A broken record must not read as "this turn said nothing": that would
    // silently drop an escalation whose transcript is sitting on disk.
    const root = caseRoot("broken");
    const provider = providerAt(root);
    plantRecord(root, "broken", { cli_args: null });

    expect(refusalOf(await provider.readTerminalReport("broken")).kind).toBe(
      FailureKind.UNINTERPRETABLE_RESPONSE,
    );
  });
});
