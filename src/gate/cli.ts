/**
 * `continuo gate list|show|present|deliver|ack|answer|close|reconcile`.
 *
 * Mounted into the unified CLI by `src/cli.ts`, which owns no flag of its own
 * here: the subtree's module declares its parser, exactly as
 * `control_plane/run_cli.ts`, `lap/cli.ts` and the rest do (`D-0030`).
 *
 * **The verbs are thin, and the thinness is the point** -- the same point
 * `run_cli.ts` makes about admission. Every rule about what a transition *is*
 * lives in `src/control_plane/gates.ts`, and every rule about the *order* the
 * operator's steps happen in lives in `src/gate/operator.ts`. A verb resolves
 * its arguments, opens the database, calls exactly one domain entry point,
 * reports what it wrote, and closes the handle. A second statement of any rule
 * here would be a second answer to "what state is this gate in", and two
 * answers eventually disagree about one database.
 *
 * **The walk an operator takes (`D-0078`), and why it is these verbs.**
 *
 * ```text
 *   gate list                       -- an open worker_escalation gate, at 'received'
 *   gate present  --gate-id G       -- enqueue the presented relay
 *   gate deliver  --destination-dir D  -- deliver it into the dropbox
 *   (read D)                        -- the operator is the recipient
 *   gate ack      --message-id M    -- ack it; the gate advances to 'presented'
 *   gate answer   --gate-id G --body "..."  -- 'answered', and the forward relay
 *   gate deliver  --destination-dir D
 *   gate ack      --message-id M2   -- 'forwarded', then closed answered_and_forwarded
 * ```
 *
 * `withdrawn`, `expired` and `unanswerable` are `gate close`; the other three
 * outcomes are not a hand's to write and the verb refuses them
 * (`OPERATOR_CLOSE_OUTCOMES`). `gate reconcile` is the idle pass, run on the
 * operator's own cadence (`D-0079`), and it is the recovery for a kill between
 * an ack and the advance it justified.
 *
 * **Why the database is opened with `openProductionControlPlane`.** The same
 * standard every other verb opens against: a production database, its ledger
 * verified, at this build's head. There is no `--migrate` shortcut, for the
 * reason `run_cli.ts` gives.
 *
 * **A refusal is an operator-facing line, not a stack trace.** `GateRefusal`
 * (an unknown gate, a closed one, an inadmissible transition, a relay that is
 * not acked), `ControlPlaneRefusal` (the database is not one, or is behind),
 * `LeaseRefusal` (`gate deliver` while a lap holds the delivery lease) and the
 * outbox's own usage refusals are all the ordinary outcome of a command an
 * operator typed. They become one stderr line and exit 2, the same code
 * `run admit` and `db verify` use.
 *
 * **`--json` on the three verbs a host reads, and on no others.** `gate list`,
 * `gate show` and `gate answer` are the ones a program drives -- it enumerates
 * the open questions, reads one, and records the answer it obtained -- so they
 * carry the shared envelope from `src/cli/json_output.ts` (`D-0090`). `present`,
 * `deliver`, `ack`, `close` and `reconcile` are the operator's own hands and
 * stay human-only until something actually needs to parse them; a flag added
 * ahead of a reader is a shape nobody has checked against a real consumer.
 *
 * The flag changes **bytes and nothing else**: the same entry point is called,
 * the same refusals are caught, the handle is closed in the same `finally`, and
 * the exit code is the same one. Without it every line below is byte-identical
 * to what it was before the flag existed.
 *
 * Because the refusal path is shared by all eight verbs, {@link refuse} is
 * taught the flag once rather than at each call site. Branching per verb would
 * have left the refusals of a verb whose author forgot silently human under
 * `--json` while its success case stayed green -- a host would then get a
 * parse error exactly when something went wrong, which is the worst moment for
 * one. The five verbs with no flag pass no report and reach the same line they
 * always did.
 *
 * **ASCII only**, for the reason `docs/cli-output-policy.md` gives: every
 * string here reaches `--help` on a cp932 console, where a character the
 * console cannot encode is a crash rather than a smudge. The same open problem
 * `run_cli.ts` records applies to the values echoed back -- `--db`, a gate id
 * and an answer body are printed as given.
 */

import {
  addJsonArgument,
  type JsonValue,
  jsonRequested,
  refusalLine,
  successLine,
} from "../cli/json_output.js";
import type { Namespace, Subparsers } from "../cli/parser.js";
import { ArgparseExit, type ArgumentParser } from "../cli/parser.js";
import { DestinationRefusal } from "../control_plane/destination.js";
import { GateRefusal } from "../control_plane/gates.js";
import { LeaseRefusal } from "../control_plane/lease.js";
import { openProductionControlPlane } from "../control_plane/migrator.js";
import { HandlerRejected, OutboxUsageError } from "../control_plane/outbox.js";
import { ControlPlaneRefusal } from "../control_plane/refusals.js";
import { DELIVERY_LEASE_TTL_MS } from "../lap/endpoint_lease.js";
import type { AnswerRecorded, GateDetail, OpenGateSummary } from "./operator.js";
import {
  ackRelay,
  answerGate,
  closeOpenGate,
  deliverRelays,
  GATE_RELAY_RECIPIENT,
  gateDetail,
  OPERATOR_CLOSE_OUTCOMES,
  openGates,
  presentGate,
  reconcile,
} from "./operator.js";

// ASCII only: these reach --help on a cp932 console.
const DB_HELP =
  "path to the production control plane database file. It must already exist " +
  "and be at this build's head; 'db create' and 'db migrate' are what put it " +
  "there.";
const GATE_ID_HELP = "the gate's identifier, as 'gate list' prints it.";
const MESSAGE_ID_HELP =
  "the relay's message id, as 'gate present', 'gate answer' and 'gate show' " +
  "print it. It must name a relay of a gate: this verb settles the messages a " +
  "gate enqueued and nothing else.";
const ACTOR_ID_HELP =
  "who is acting, recorded on the transition. An identity, not an authority: " +
  "the gate's admissibility comes from the transition table, not from this " +
  "string.";
const BODY_HELP =
  "the answer, verbatim. It is the durable half of the 'answered' stage -- " +
  "the stage is not ack-gated, so this text is the only evidence the question " +
  "was answered. Free-form, and not held to ASCII: it is stored rather than " +
  "printed back.";
const HOLDER_HELP =
  "the claimant the one delivery lease is taken under for this pass. A lap or " +
  "an endpoint holding it refuses this verb, which is the intended " +
  "serialisation: one delivery resource, one writer.";
const DESTINATION_DIR_HELP =
  "the dropbox directory the relay's effect is written into, and the one the " +
  "operator reads. Created if it does not exist, and reused if it does: the " +
  "dropbox deduplicates per idempotency key and fences a superseded writer out " +
  "by its own token, so this is normally the directory a lap of the same control " +
  "plane already ran " +
  "against ('lap perform --endpoint-destination-dir'), under the same rule.";
const OUTCOME_HELP =
  "the terminal outcome. 'answered_and_forwarded' is not here on purpose: it " +
  "is the consequence of the forward relay's ack and is written by 'gate " +
  "ack'. 'subject_gone' is 'gate reconcile's sweep and 'superseded' is " +
  "written by the gate that supersedes this one.";
const STALLED_TOLERANCE_HELP =
  "how old, in milliseconds, an unacked relay must be to be reported as " +
  "stalled. No default: a tolerance is data, not a number invented in code " +
  "(D-0031). Omitted, the stalled query does not run and the report says so.";
const NOW_MS_HELP =
  "the clock, epoch milliseconds, stamped on everything this verb writes. " +
  "Read once from the system clock when omitted; nothing below this command " +
  "reads a clock.";

const LIST_DESCRIPTION =
  "List every open gate, oldest stage entry first: its type, the run it " +
  "stands over, the stage it is at and its deadline.";
const SHOW_DESCRIPTION =
  "Show one gate: its rationale and answer options, its relays with the " +
  "delivery state of each, and its whole transition history.";
const PRESENT_DESCRIPTION =
  "Enqueue the 'presented' relay: put the open question in front of its " +
  "recipient. Enqueues only -- 'gate deliver' sends, and the stage moves on " +
  "the ack rather than on the send. Idempotent: a second run returns the " +
  "message id already in force.";
const DELIVER_DESCRIPTION =
  "Deliver every relay currently due, under the one delivery lease. This is " +
  "the operator's delivery worker for the window after a lap has ended, when " +
  "no endpoint is alive to poll. Refuses while a lap or an endpoint holds the " +
  "lease.";
const ACK_DESCRIPTION =
  "Record the ack for one relay and take the step it justifies: the gate " +
  "advances to the relayed stage, and a forwarded relay's ack also closes the " +
  "gate as 'answered_and_forwarded'. Idempotent in every step.";
const ANSWER_DESCRIPTION =
  "Record the human answer on an open gate ('answered') and enqueue the " +
  "'forwarded' relay that carries it onward. One verb because the forward " +
  "relay may only be enqueued from 'answered'.";
const CLOSE_DESCRIPTION =
  "Close an open gate with an outcome an operator decides. Refuses the three " +
  "outcomes that are not a hand's to write.";
const RECONCILE_DESCRIPTION =
  "One reconcile pass: close gates whose run is gone, complete the advance a " +
  "durable ack already justified, and report relay gaps, stalled relays and " +
  "passed deadlines without acting on them. Cadence is the operator's.";

/**
 * The three effects this module has on the world, as a replaceable record.
 *
 * The same shape and the same reason as `run_cli.ts`'s `runCliSeams`: ESM
 * bindings cannot be rebound from outside the module that holds them, so the
 * clock and the two streams are reached through this record and the cases
 * replace the entry (`docs/test-translation-conventions.md` rule 5). Its own
 * record rather than a share of another subtree's, so that a case capturing
 * this subtree's output cannot be satisfied by another's.
 *
 * Not re-exported from `src/index.ts`: a seam for the tests that own this
 * module, not public API.
 */
export const gateCliSeams = {
  /** The only clock read by these verbs, in epoch milliseconds. */
  nowMs: (): number => Date.now(),
  /** Where the result goes. */
  write: (text: string): void => {
    process.stdout.write(text);
  },
  /** Where a refusal goes. */
  writeError: (text: string): void => {
    process.stderr.write(text);
  },
};

/** The pinned document shapes, one per verb a host drives (`D-0090`). */
const LIST_SCHEMA = "continuo.gate.list/1";
const SHOW_SCHEMA = "continuo.gate.show/1";
const ANSWER_SCHEMA = "continuo.gate.answer/1";

/**
 * What a verb needs in order to answer in JSON: which shape, and which database.
 *
 * `null` is the whole of "this invocation is human-readable", and it is the
 * default everywhere, so a verb that never opts in cannot accidentally acquire
 * the flag's behaviour. The database path is carried rather than looked up
 * again because the envelope puts it on the refusal too, where the human line
 * carries it only when the message happens to quote it -- a host driving
 * several control planes cannot attribute a refusal without it.
 */
interface JsonReport {
  readonly schema: string;
  readonly db: string;
}

/** The report for this invocation, or `null` when `--json` was not given. */
function jsonReportOf(args: Namespace, schema: string, db: string): JsonReport | null {
  return jsonRequested(args) ? { schema, db } : null;
}

/**
 * Report a refusal on stderr and stop, rather than letting it escape.
 *
 * `ArgparseExit` rather than `process.exit`, because `src/cli.ts`'s `main`
 * already catches it and turns it into the process's status -- the one place
 * that is a process boundary.
 *
 * The `report` decides the bytes and nothing else. `--json` does not change
 * which stream a refusal goes to, which refusals are caught, or the status: a
 * host reads exit 2 and parses stderr, and an operator reads the same
 * `error: ...` line they always read.
 */
function refuse(error: Error, report: JsonReport | null): never {
  gateCliSeams.writeError(
    report === null ? `error: ${error.message}\n` : refusalLine(report.schema, report.db, error),
  );
  throw new ArgparseExit(2, "refused gate verb");
}

/**
 * The refusals an operator can provoke by typing a command, as opposed to the
 * defects a caller can only reach with a bug.
 *
 * Enumerated rather than caught as `Error`: a broad catch would turn a
 * programming mistake in this package into a tidy "error:" line and exit 2,
 * which is the status an operator reads as "the database said no" -- and a
 * defect reported as a refusal is a defect nobody investigates.
 */
function isRefusal(error: unknown): error is Error {
  return (
    error instanceof GateRefusal ||
    error instanceof ControlPlaneRefusal ||
    error instanceof LeaseRefusal ||
    error instanceof OutboxUsageError ||
    error instanceof HandlerRejected ||
    // `gate deliver` reaches a destination, and a destination refuses for
    // reasons that are operational rather than defects: a lock it could not
    // take, a fencing token it judged stale, an idempotency key already bound
    // to a different payload. `MessageBus.poll` re-raises those unchanged, and
    // without this they escape as a stack trace and exit 1 -- the status that
    // reads as "this program crashed" to an operator and to any script
    // retrying it.
    error instanceof DestinationRefusal
  );
}

/** `--now-ms` if given, else the one clock read. */
function nowMsOf(args: Namespace): number {
  const supplied = args["now_ms"];
  return typeof supplied === "number" ? supplied : gateCliSeams.nowMs();
}

/**
 * Open the database, run `body` against it, and close the handle whatever
 * happens.
 *
 * The handle is closed in a `finally` including on the refusal path: a refused
 * verb that left a verified database open would, on Windows, leave the file
 * locked, so the operator's next command would fail for a reason that has
 * nothing to do with what it was asked to do. (`run_cli.ts` records the same
 * reason for the same shape.)
 *
 * `report` defaults to `null`, which is what makes the five verbs that carry no
 * `--json` flag behave exactly as they did: they call this function with two
 * arguments, and the refusal they provoke is the same line it has always been.
 */
function withControlPlane<T>(
  path: string,
  body: (connection: ReturnType<typeof openProductionControlPlane>) => T,
  report: JsonReport | null = null,
): T {
  try {
    const connection = openProductionControlPlane(path);
    try {
      return body(connection);
    } finally {
      connection.close();
    }
  } catch (error) {
    if (isRefusal(error)) {
      refuse(error, report);
    }
    throw error;
  }
}

/** An epoch-millisecond column, or `-` when the row carries none. */
function stamp(value: number | null): string {
  return value === null ? "-" : String(value);
}

// --------------------------------------------------------------------------
// the verbs
// --------------------------------------------------------------------------

/**
 * `gate list`'s payload: the open gates as an array under a key.
 *
 * Under a key rather than as a bare top-level array, so the document can grow a
 * sibling -- a count, a truncation marker -- without becoming a different kind
 * of JSON value, which is the one change no host absorbs.
 *
 * The empty case is `{"gates": []}` and not the human "no open gates" sentence.
 * An empty list is a result: a host that had to recognise a sentence to learn
 * "nothing is open" would be parsing prose for the most common answer this verb
 * gives.
 *
 * `null` where the human line prints `-`, never the string `"-"`: the
 * placeholder is a rendering decision, and a host that saw `"-"` could not tell
 * a missing run from a run whose id is one character long.
 */
function listPayload(gates: readonly OpenGateSummary[]): { readonly [key: string]: JsonValue } {
  return {
    gates: gates.map((gate) => ({
      gate_id: gate.gateId,
      gate_type: gate.gateType,
      run_id: gate.runId,
      stage: gate.stage,
      stage_entered_at_ms: gate.stageEnteredAtMs,
      deadline_at_ms: gate.deadlineAtMs,
    })),
  };
}

export function cmdGateList(args: Namespace): number {
  const path = String(args["db"]);
  const report = jsonReportOf(args, LIST_SCHEMA, path);
  return withControlPlane(
    path,
    (connection) => {
      const gates = openGates(connection);
      if (report !== null) {
        gateCliSeams.write(successLine(report.schema, report.db, listPayload(gates)));
        return 0;
      }
      return writeGateLines(gates, path);
    },
    report,
  );
}

/** The human rendering of `gate list`, unchanged by the flag's arrival. */
function writeGateLines(gates: readonly OpenGateSummary[], path: string): number {
  if (gates.length === 0) {
    gateCliSeams.write(`no open gates in ${path}\n`);
    return 0;
  }
  for (const gate of gates) {
    gateCliSeams.write(
      `${gate.gateId} ${gate.gateType} run=${gate.runId ?? "-"} stage=${gate.stage} ` +
        `since=${gate.stageEnteredAtMs} deadline=${stamp(gate.deadlineAtMs)}\n`,
    );
  }
  return 0;
}

/**
 * `gate show`'s payload: the detail record, field by field.
 *
 * Built explicitly rather than by spreading the record, for two reasons that
 * point the same way. The record's field names are `camelCase` and the document's
 * are `snake_case`, so a spread would ship the wrong keys; and a spread would
 * make every future field of `GateDetail` an unreviewed addition to a pinned
 * host contract. Naming each key means the document changes only when somebody
 * decides it should.
 *
 * `relays` and `transitions` are arrays under keys for the reason `gates` is,
 * and each element is snake_cased the same way. `body` and the timestamps are
 * `null` where the human line prints `-` or omits the clause entirely -- the
 * human rendering drops `body=` when there is none, and a host reading a
 * missing key would have to distinguish it from a key it forgot to read.
 */
function showPayload(gate: GateDetail): { readonly [key: string]: JsonValue } {
  return {
    gate_id: gate.gateId,
    gate_type: gate.gateType,
    run_id: gate.runId,
    subject_kind: gate.subjectKind,
    subject_id: gate.subjectId,
    stage: gate.stage,
    deadline_at_ms: gate.deadlineAtMs,
    outcome: gate.outcome,
    rationale: gate.rationale,
    options: gate.options,
    relays: gate.relays.map((relay) => ({
      to_stage: relay.toStage,
      message_id: relay.messageId,
      recipient: relay.recipient,
      status: relay.status,
      retry_count: relay.retryCount,
      delivered_at_ms: relay.deliveredAtMs,
      acked_at_ms: relay.ackedAtMs,
    })),
    transitions: gate.transitions.map((transition) => ({
      seq: transition.seq,
      transition_kind: transition.transitionKind,
      from_stage: transition.fromStage,
      to_stage: transition.toStage,
      actor_kind: transition.actorKind,
      actor_id: transition.actorId,
      recorded_at_ms: transition.recordedAtMs,
      body: transition.body,
    })),
  };
}

export function cmdGateShow(args: Namespace): number {
  const path = String(args["db"]);
  const gateId = String(args["gate_id"]);
  const report = jsonReportOf(args, SHOW_SCHEMA, path);
  return withControlPlane(
    path,
    (connection) => {
      const gate = gateDetail(connection, gateId);
      if (report !== null) {
        gateCliSeams.write(successLine(report.schema, report.db, showPayload(gate)));
        return 0;
      }
      return writeGateDetail(gate);
    },
    report,
  );
}

/** The human rendering of `gate show`, unchanged by the flag's arrival. */
function writeGateDetail(gate: GateDetail): number {
  gateCliSeams.write(
    `${gate.gateId} ${gate.gateType} run=${gate.runId ?? "-"} ` +
      `subject=${gate.subjectKind}/${gate.subjectId} stage=${gate.stage} ` +
      `deadline=${stamp(gate.deadlineAtMs)} outcome=${gate.outcome ?? "-"}\n` +
      `rationale: ${gate.rationale}\n` +
      `options: ${gate.options}\n`,
  );
  for (const relay of gate.relays) {
    gateCliSeams.write(
      `relay ${relay.toStage} ${relay.messageId} to=${relay.recipient} ` +
        `status=${relay.status} retries=${relay.retryCount} ` +
        `delivered=${stamp(relay.deliveredAtMs)} acked=${stamp(relay.ackedAtMs)}\n`,
    );
  }
  for (const transition of gate.transitions) {
    gateCliSeams.write(
      `transition ${transition.seq} ${transition.transitionKind} ` +
        `${transition.fromStage ?? "-"}->${transition.toStage} ` +
        `by=${transition.actorKind}/${transition.actorId} at=${transition.recordedAtMs}` +
        `${transition.body === null ? "" : ` body=${transition.body}`}\n`,
    );
  }
  return 0;
}

export function cmdGatePresent(args: Namespace): number {
  const path = String(args["db"]);
  const nowMs = nowMsOf(args);
  return withControlPlane(path, (connection) => {
    const relay = presentGate(connection, {
      gateId: String(args["gate_id"]),
      nowMs,
    });
    gateCliSeams.write(
      `${relay.enqueued ? "enqueued" : "already enqueued"} ${relay.messageId} ` +
        `to ${GATE_RELAY_RECIPIENT} for stage ${relay.toStage}\n`,
    );
    return 0;
  });
}

export function cmdGateDeliver(args: Namespace): number {
  const path = String(args["db"]);
  const nowMs = nowMsOf(args);
  return withControlPlane(path, (connection) => {
    const report = deliverRelays(connection, {
      holder: String(args["holder"]),
      destinationDir: String(args["destination_dir"]),
      nowMs,
      ttlMs: DELIVERY_LEASE_TTL_MS,
      // The one verb that re-reads the clock, and the fence is why: an attempt
      // must be validated at the instant it writes, not at the instant the pass
      // began, or a pass outliving its 60-second lease keeps writing under a
      // lease it no longer holds. An operator who froze the clock with
      // --now-ms means the instant they gave, so that case keeps the single
      // read.
      ...(typeof args["now_ms"] === "number" ? {} : { clock: gateCliSeams.nowMs }),
    });
    gateCliSeams.write(
      `delivered ${report.delivered.length} message(s) to ${report.recipient} ` +
        `under epoch ${report.epoch}\n`,
    );
    for (const message of report.delivered) {
      gateCliSeams.write(`  ${message.messageId} dedup=${message.dedupKey}\n`);
    }
    return 0;
  });
}

export function cmdGateAck(args: Namespace): number {
  const path = String(args["db"]);
  const nowMs = nowMsOf(args);
  return withControlPlane(path, (connection) => {
    const outcome = ackRelay(connection, {
      messageId: String(args["message_id"]),
      actorId: String(args["actor_id"]),
      nowMs,
    });
    // Every step is reported, including the ones that changed nothing: an
    // operator re-running an ack after a kill has to be able to see which of
    // the three writes this run was the one that landed.
    gateCliSeams.write(
      `${outcome.messageId}: acked=${String(outcome.acked)} ` +
        `cancelled=${String(outcome.cancelled)} ` +
        `advanced=${String(outcome.advanced)} closed=${String(outcome.closed)} ` +
        `gate=${outcome.gateId} stage=${outcome.toStage}\n`,
    );
    return 0;
  });
}

/**
 * `gate answer`'s payload: what the call did, as two booleans and two names.
 *
 * Both flags are JSON booleans, which is a deliberate difference from how the
 * human line renders them. That line puts `advanced` through `String()` and
 * spells `enqueued` as the words "enqueued" / "already enqueued" -- fine for an
 * operator, and two different encodings of one idea for a host, one of which
 * inverts under negation ("already enqueued" is the FALSE case). A host reads
 * `false`, and re-running the verb after a kill is then a comparison rather
 * than a phrasebook.
 */
function answerPayload(recorded: AnswerRecorded): { readonly [key: string]: JsonValue } {
  return {
    advanced: recorded.advanced,
    enqueued: recorded.enqueued,
    message_id: recorded.messageId,
    to_stage: recorded.toStage,
  };
}

export function cmdGateAnswer(args: Namespace): number {
  const path = String(args["db"]);
  const nowMs = nowMsOf(args);
  const report = jsonReportOf(args, ANSWER_SCHEMA, path);
  return withControlPlane(
    path,
    (connection) => {
      const recorded = answerGate(connection, {
        gateId: String(args["gate_id"]),
        body: String(args["body"]),
        actorId: String(args["actor_id"]),
        nowMs,
      });
      if (report !== null) {
        gateCliSeams.write(successLine(report.schema, report.db, answerPayload(recorded)));
        return 0;
      }
      gateCliSeams.write(
        `answered=${String(recorded.advanced)} ` +
          `${recorded.enqueued ? "enqueued" : "already enqueued"} ${recorded.messageId} ` +
          `for stage ${recorded.toStage}\n`,
      );
      return 0;
    },
    report,
  );
}

export function cmdGateClose(args: Namespace): number {
  const path = String(args["db"]);
  const gateId = String(args["gate_id"]);
  const outcome = String(args["outcome"]);
  const nowMs = nowMsOf(args);
  return withControlPlane(path, (connection) => {
    const closed = closeOpenGate(connection, {
      gateId,
      outcome,
      actorId: String(args["actor_id"]),
      nowMs,
    });
    gateCliSeams.write(`${closed ? "closed" : "already closed"} ${gateId} as ${outcome}\n`);
    return 0;
  });
}

export function cmdGateReconcile(args: Namespace): number {
  const path = String(args["db"]);
  const nowMs = nowMsOf(args);
  const tolerance = args["stalled_tolerance_ms"];
  return withControlPlane(path, (connection) => {
    const report = reconcile(connection, {
      nowMs,
      actorId: String(args["actor_id"]),
      stalledToleranceMs: typeof tolerance === "number" ? tolerance : undefined,
    });
    gateCliSeams.write(
      `settled: subject_gone=${report.subjectGone.length} ` +
        `advanced=${report.advanced.length} closed=${report.closed.length}\n`,
    );
    for (const gateId of report.subjectGone) {
      gateCliSeams.write(`  closed ${gateId} as subject_gone\n`);
    }
    for (const advance of report.advanced) {
      gateCliSeams.write(`  advanced ${advance.gateId} to ${advance.toStage}\n`);
    }
    for (const gateId of report.closed) {
      gateCliSeams.write(`  closed ${gateId} as answered_and_forwarded\n`);
    }
    // Reported, never acted on: the remedies differ per row and per owner, and
    // the expiry rule is undecided policy (D-0008).
    gateCliSeams.write(`found: relay_gaps=${report.relayGaps.length}\n`);
    for (const gap of report.relayGaps) {
      gateCliSeams.write(`  gap ${gap.gateId} at ${gap.stage} age=${gap.ageMs}\n`);
    }
    if (report.stalledRelays === null) {
      gateCliSeams.write("found: stalled_relays=not asked (no --stalled-tolerance-ms)\n");
    } else {
      gateCliSeams.write(`found: stalled_relays=${report.stalledRelays.length}\n`);
      for (const stalled of report.stalledRelays) {
        gateCliSeams.write(
          `  stalled ${stalled.gateId} to ${stalled.toStage} ` +
            `retries=${stalled.retryCount} age=${stalled.ageMs}\n`,
        );
      }
    }
    gateCliSeams.write(`found: past_deadline=${report.pastDeadline.length}\n`);
    for (const late of report.pastDeadline) {
      gateCliSeams.write(
        `  past deadline ${late.gateId} at ${late.stage} overdue=${late.overdueMs}\n`,
      );
    }
    return 0;
  });
}

// --------------------------------------------------------------------------
// the parser
// --------------------------------------------------------------------------

/** `--db`, spelled as every other subtree spells it. */
function addDbArgument(parser: ArgumentParser): void {
  parser.addArgument({
    optionStrings: ["--db"],
    dest: "db",
    required: true,
    metavar: "DB",
    help: DB_HELP,
  });
}

function addGateIdArgument(parser: ArgumentParser): void {
  parser.addArgument({
    optionStrings: ["--gate-id"],
    dest: "gate_id",
    required: true,
    metavar: "GATE_ID",
    help: GATE_ID_HELP,
  });
}

function addActorIdArgument(parser: ArgumentParser): void {
  parser.addArgument({
    optionStrings: ["--actor-id"],
    dest: "actor_id",
    required: true,
    metavar: "ACTOR_ID",
    help: ACTOR_ID_HELP,
  });
}

function addNowMsArgument(parser: ArgumentParser): void {
  parser.addArgument({
    optionStrings: ["--now-ms"],
    dest: "now_ms",
    type: "int",
    metavar: "NOW_MS",
    help: NOW_MS_HELP,
  });
}

/** `add_subparsers`: mount the eight verbs under `gate`. */
export function addSubparsers(sub: Subparsers): void {
  const list = sub.addParser("list", LIST_DESCRIPTION);
  addDbArgument(list);
  addJsonArgument(list);
  list.setDefaults({ func: cmdGateList });

  const show = sub.addParser("show", SHOW_DESCRIPTION);
  addDbArgument(show);
  addGateIdArgument(show);
  addJsonArgument(show);
  show.setDefaults({ func: cmdGateShow });

  const present = sub.addParser("present", PRESENT_DESCRIPTION);
  addDbArgument(present);
  addGateIdArgument(present);
  addNowMsArgument(present);
  present.setDefaults({ func: cmdGatePresent });

  const deliver = sub.addParser("deliver", DELIVER_DESCRIPTION);
  addDbArgument(deliver);
  deliver.addArgument({
    optionStrings: ["--destination-dir"],
    dest: "destination_dir",
    required: true,
    metavar: "DESTINATION_DIR",
    help: DESTINATION_DIR_HELP,
  });
  deliver.addArgument({
    optionStrings: ["--holder"],
    dest: "holder",
    required: true,
    metavar: "HOLDER",
    help: HOLDER_HELP,
  });
  addNowMsArgument(deliver);
  deliver.setDefaults({ func: cmdGateDeliver });

  const ack = sub.addParser("ack", ACK_DESCRIPTION);
  addDbArgument(ack);
  ack.addArgument({
    optionStrings: ["--message-id"],
    dest: "message_id",
    required: true,
    metavar: "MESSAGE_ID",
    help: MESSAGE_ID_HELP,
  });
  addActorIdArgument(ack);
  addNowMsArgument(ack);
  ack.setDefaults({ func: cmdGateAck });

  const answer = sub.addParser("answer", ANSWER_DESCRIPTION);
  addDbArgument(answer);
  addGateIdArgument(answer);
  answer.addArgument({
    optionStrings: ["--body"],
    dest: "body",
    required: true,
    metavar: "BODY",
    help: BODY_HELP,
  });
  addActorIdArgument(answer);
  addNowMsArgument(answer);
  addJsonArgument(answer);
  answer.setDefaults({ func: cmdGateAnswer });

  const close = sub.addParser("close", CLOSE_DESCRIPTION);
  addDbArgument(close);
  addGateIdArgument(close);
  close.addArgument({
    optionStrings: ["--outcome"],
    dest: "outcome",
    required: true,
    choices: OPERATOR_CLOSE_OUTCOMES,
    metavar: "OUTCOME",
    help: OUTCOME_HELP,
  });
  addActorIdArgument(close);
  addNowMsArgument(close);
  close.setDefaults({ func: cmdGateClose });

  const reconcilePass = sub.addParser("reconcile", RECONCILE_DESCRIPTION);
  addDbArgument(reconcilePass);
  addActorIdArgument(reconcilePass);
  reconcilePass.addArgument({
    optionStrings: ["--stalled-tolerance-ms"],
    dest: "stalled_tolerance_ms",
    type: "int",
    metavar: "STALLED_TOLERANCE_MS",
    help: STALLED_TOLERANCE_HELP,
  });
  addNowMsArgument(reconcilePass);
  reconcilePass.setDefaults({ func: cmdGateReconcile });
}
