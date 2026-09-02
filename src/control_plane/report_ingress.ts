import type { Database as SqliteDatabase } from "better-sqlite3";

import { pyStrip } from "../fencing/pysemantics.js";
import { appendEvent } from "./events.js";
import { openGate } from "./gates.js";
import { pythonJsonDocumentSorted } from "./python_json.js";
import { pythonRepr } from "./python_repr.js";
import { ControlPlaneRefusal } from "./refusals.js";
import { bindingForSession, PHASE_IDENTITY_CONFIRMED } from "./session_binding.js";
import { transaction } from "./txn.js";

/**
 * The one place a worker's terminal report becomes a fact on the spine and a
 * question in front of a human (`D-0056`).
 *
 * `docs/design/minimal-operating-loop.md` section 4.7 is the seam with no
 * mechanism at all: the endpoint exposes `poll` and `ack` and nothing else, so
 * the only write a worker can make into the control plane anywhere in the
 * successor stack is one bit per message it was already sent. Meanwhile
 * `openGate` requires the escalation event to be on the spine already and says
 * the party that observed the escalation is the party that appends it -- and
 * until this module, no party could observe one. Section 7 step 9 is that gap,
 * and this is the half of it that writes.
 *
 * **It takes the report as plain data, and that is a constraint rather than a
 * preference.** `test/gate_item11/no-provider-detail-leaks.test.ts` fails any
 * module under `src/control_plane/` that imports a specifier carrying a
 * `session` or `provider` path segment, and fails any module under `src/` at
 * all -- `src/index.ts` excepted -- that knows both a session backend and the
 * control plane. So the shape below is declared here and the provider's
 * `TerminalReport` is structurally assignable to it without either side
 * importing the other; the composition root is the one place that holds both,
 * which is the arrangement item 11 measures the cost of a provider swap by.
 *
 * **The judgement is here, and it is deterministic** (`D-0056` decision 2). The
 * provider reports what the turn said; this module decides whether that is an
 * escalation, by a rule with no prose classification in it: an
 * identity-confirmed, non-blank, non-error terminal report is always an
 * escalation, and the four other shapes are refused as observation or execution
 * failures rather than absorbed. Keyword-sniffing a worker's prose for the word
 * "approve" would make the gate's existence depend on how a model happened to
 * phrase itself, which is the one thing a durable decision record must not
 * depend on.
 *
 * **ASCII only** in every message, per `docs/cli-output-policy.md`: these
 * refusals reach an operator's console.
 */

/** The event type this appends. Already in `EVENT_TYPES`; nothing is added. */
export const WORKER_ESCALATION_EVENT_TYPE = "worker_escalation_raised";

/** The gate type this opens -- one of the four the `gate` DDL admits. */
export const WORKER_ESCALATION_GATE_TYPE = "worker_escalation";

/** The `producer` every event this module appends is stamped with. */
export const REPORT_INGRESS_PRODUCER = "report_ingress";

/**
 * The payload's own version, carried in the payload rather than inferred.
 *
 * A consumer reading an escalation payload it did not write needs to know which
 * shape it is holding, and the spine's `payload` column is open JSON that no
 * `CHECK` constrains. One integer now costs nothing and is the difference
 * between a later shape change being a migration and being a guess.
 */
export const WORKER_ESCALATION_SCHEMA_VERSION = 1;

/**
 * A caller error: an argument that is not a report this module can ingest.
 *
 * A `ControlPlaneRefusal` and not an `Error`, because every one of these is a
 * statement about the data the caller offered -- the same band `RunAdmissionUsageError`
 * occupies -- and an operator seeing one needs it to read as a refusal rather
 * than as a crash.
 */
export class ReportIngressUsageError extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ReportIngressUsageError";
    Object.setPrototypeOf(this, ReportIngressUsageError.prototype);
  }
}

/**
 * One finished turn's report, as the party that observed it hands it over.
 *
 * Structurally the provider's `TerminalReport` (`src/session/claude_cli_provider.ts`),
 * declared here because this package may not import that one. The duplication is
 * a type declaration and not a rule: nothing about *how* a transcript is read
 * appears here, which is the whole of what `D-0056` decision 4 was protecting.
 */
export interface TerminalReportFact {
  /** The session the turn ran under. */
  readonly sessionId: string;
  /** The turn's identity within that session, and half of the dedup key. */
  readonly generation: number;
  /** The worker's own words. Blank is refused, not absorbed. */
  readonly report: string;
  /** The child's own last word, and its fallback. */
  readonly terminalReason: string | null;
  readonly subtype: string | null;
  /** Whether the CLI called its own turn a failure. */
  readonly isError: boolean;
  /** The process disposition, `null` when the observer did not spawn it. */
  readonly returncode: number | null;
}

/** What one ingest did, as the ingest itself saw it. */
export interface IngestedReport {
  /**
   * The escalation event's sequence -- the gate's `origin_event_seq`.
   *
   * Always a number, including on the re-processing path where `appendEvent`
   * assigned none, which is the whole point of {@link IngestedReport.duplicate}
   * being a separate field rather than this one being nullable.
   */
  readonly eventSeq: number;
  /** The event that holds the fact, which on a re-append is the first one's. */
  readonly eventId: string;
  /** The gate standing over that event. */
  readonly gateId: string;
  /** Whether the fact was already on the spine when this call ran. */
  readonly duplicate: boolean;
  /** Whether *this* call opened the gate, as opposed to finding it open. */
  readonly gateOpened: boolean;
}

/**
 * The dedup key one turn's escalation has, and the identity its gate is named
 * after.
 *
 * **Per turn, not per session.** A session that is resumed runs a second turn
 * and writes a second transcript, and a key naming only the session would read
 * that second report as a restatement of the first -- the escalation would be
 * silently dropped as a duplicate fact and the gate would never open. The
 * generation is what makes the two turns two facts. It is the `<type>/<subject>`
 * shape `run_admission.ts` and `ci_ingest.ts` already use, with the subject
 * being the turn rather than the run.
 */
export function escalationDedupKey(sessionId: string, generation: number): string {
  return `${WORKER_ESCALATION_GATE_TYPE}/${sessionId}/${generation}`;
}

/**
 * The gate that stands over one turn's escalation, named after it.
 *
 * Derived rather than supplied so that re-processing is idempotent without the
 * caller having to remember an identifier across a restart -- which is exactly
 * the situation the re-processing path exists for. The prefix keeps it distinct
 * from the event id, which is the dedup key itself.
 */
function escalationGateId(sessionId: string, generation: number): string {
  return `gate/${escalationDedupKey(sessionId, generation)}`;
}

/**
 * Ingest one terminal report: append the escalation event and open the gate
 * that asks a human about it. **One transaction.**
 *
 * `openGate`'s own docstring states the precondition this satisfies -- the
 * origin event must already be on the spine, and the party that observed the
 * escalation is the party that appends it -- and it deliberately does not
 * append that event itself, because a gate that appended its own evidence would
 * be its own evidence. So the two writes have to be made by one caller, and
 * that makes the boundary between them this function's problem: a crash after
 * the event commits and before the gate does leaves an escalation on the spine
 * that nothing is asking anybody about, which is a report that was received and
 * silently dropped. That is the failure this transaction exists to remove, and
 * it is the same argument `run_admission.ts` makes about a run row and its
 * admission event.
 *
 * **How the two calls come to be one transaction, given that both open their
 * own.** `txn.ts`'s {@link transaction} *joins* an inner call to an outer one
 * rather than nesting it: the inner call issues no `BEGIN` and no `COMMIT`, and
 * an exception anywhere unwinds to whoever owns the outermost block. So
 * `appendEvent` and `openGate` each run inside this block without knowing they
 * are in one, and the event, the gate, the `gate_transition` and the projection
 * update commit together or not at all. No transaction-aware copy of `openGate`
 * is written for this: a second implementation of its three-statement open
 * would have to reproduce the `gate_opens_without_a_projection` and
 * `gate_stage_matches_its_transition` order the schema admits no alternative
 * to, and would then be a second thing to keep correct. The joining is pinned
 * by a case rather than trusted, because it is the property this whole function
 * rests on.
 *
 * **Re-processing opens no second gate.** A restart re-reads a transcript it
 * had already ingested and calls this again with the same report. `appendEvent`
 * answers a dedup key already on the spine with `seq = null` and writes
 * nothing, which leaves this function without the sequence the gate needs -- so
 * the sequence is read back by the same `dedup_key` lookup `appendEvent` used
 * to detect the duplicate, and the gate is then opened only if no gate already
 * names that origin event. The check is on `origin_event_seq` and not on the
 * gate id: a caller that derived a different id would otherwise open a second
 * gate over one escalation, and two gates asking one question is worse than a
 * refusal.
 *
 * `nowMs` is the caller's clock, taken once. `occurredAtMs` and `ingestedAtMs`
 * are the same instant deliberately: `time-base-policy.md` section 2 separates
 * the source clock from ours, and the source of *this* fact is the transcript
 * read that just happened, not a remote provider's timestamp.
 *
 * @throws {ReportIngressUsageError} for a report that is not an escalation --
 *   blank prose, or a turn the CLI itself called an error -- and for a
 *   malformed argument. Before any write, and the block rolls back regardless.
 */
export function ingestTerminalReport(
  connection: SqliteDatabase,
  options: {
    readonly runId: string;
    readonly report: TerminalReportFact;
    readonly nowMs: number;
    readonly actorId: string;
    readonly actorKind?: string;
    readonly deadlineAtMs?: number | null;
    readonly gateOptions?: readonly string[];
  },
): IngestedReport {
  const {
    runId,
    report: fact,
    nowMs,
    actorId,
    actorKind = "system",
    deadlineAtMs = null,
    gateOptions = [],
  } = options;

  requireText("run_id", runId);
  requireText("actor_id", actorId);
  requireText("session_id", fact.sessionId);
  if (!Number.isSafeInteger(fact.generation) || fact.generation < 0) {
    throw new ReportIngressUsageError(
      `generation must be a non-negative integer, got ${pythonRepr(fact.generation)}`,
    );
  }
  if (typeof nowMs !== "number" || !Number.isInteger(nowMs)) {
    throw new ReportIngressUsageError(
      `now_ms must be an int of epoch milliseconds, got ${pythonRepr(nowMs)}`,
    );
  }
  // The two halves of `D-0056` decision 2 that this side owns. Both are
  // refusals rather than quiet returns: a caller that reaches here with an
  // empty report or a failed turn has read the provider's answer wrongly, and
  // absorbing that would turn a bug into a run with no escalation and no
  // explanation for why there is none.
  // `pyStrip`, not `String.prototype.trim`. The two disagree on which
  // codepoints are whitespace -- `U+FEFF` is blank to JavaScript and not to
  // Python, `U+001C` the other way round -- and the provider decides blankness
  // with `pyStrip`. A different predicate here would refuse reports the
  // provider had just returned as reportable, which is an escalation lost at
  // the seam the structural hand-off is supposed to make seamless.
  if (typeof fact.report !== "string" || pyStrip(fact.report) === "") {
    throw new ReportIngressUsageError(
      "a terminal report must carry non-blank prose to be an escalation, got " +
        `${pythonRepr(fact.report)}; a turn that said nothing is an observation ` +
        "failure, not a question to put to a human",
    );
  }
  if (fact.isError) {
    throw new ReportIngressUsageError(
      `the terminal report of session ${pythonRepr(fact.sessionId)} generation ` +
        `${String(fact.generation)} is marked is_error, so it is an execution ` +
        "failure rather than an escalation; it is not ingested and no gate is opened",
    );
  }

  const dedupKey = escalationDedupKey(fact.sessionId, fact.generation);
  const gateId = escalationGateId(fact.sessionId, fact.generation);
  // Sorted keys, and the only renderer that accepts the booleans and nulls this
  // payload carries (`pythonJsonObject` takes string|number only). The order is
  // therefore the sort's, not the order the fields are listed in anywhere.
  const payload = pythonJsonDocumentSorted({
    schema_version: WORKER_ESCALATION_SCHEMA_VERSION,
    report: fact.report,
    session_id: fact.sessionId,
    generation: fact.generation,
    terminal_reason: fact.terminalReason,
    subtype: fact.subtype,
    is_error: fact.isError,
    returncode: fact.returncode,
  });

  return transaction(connection, (tx) => {
    // The durable half of "identity-confirmed", and the check that stops a
    // report becoming a gate on the wrong run.
    //
    // `runId` is a caller's argument and the payload's `session_id` has no
    // foreign key, so without this a stale or transposed run identifier writes
    // a worker's publish-approval question against a run that worker never
    // touched -- and the `session` table is the authority that would have said
    // so. The provider's read-back proves the transcript belongs to the
    // session; this proves the session belongs to the run. Only both together
    // are what `D-0056` decision 2 means by identity-confirmed.
    //
    // Inside the transaction so the binding cannot be released between the
    // check and the writes.
    const binding = bindingForSession(tx, fact.sessionId);
    if (binding === undefined) {
      throw new ReportIngressUsageError(
        `session ${pythonRepr(fact.sessionId)} has no binding on this control ` +
          "plane, so there is nothing to say which run its report belongs to",
      );
    }
    if (binding.runId !== runId) {
      throw new ReportIngressUsageError(
        `session ${pythonRepr(fact.sessionId)} is bound to run ` +
          `${pythonRepr(binding.runId)}, not to ${pythonRepr(runId)}; a report is ` +
          "not ingested against a run its session does not belong to",
      );
    }
    if (binding.bindingPhase !== PHASE_IDENTITY_CONFIRMED) {
      throw new ReportIngressUsageError(
        `session ${pythonRepr(fact.sessionId)} is at binding phase ` +
          `${pythonRepr(binding.bindingPhase)}, not ${pythonRepr(PHASE_IDENTITY_CONFIRMED)}; ` +
          "a report whose session identity was never read back and committed is " +
          "not accepted on trust",
      );
    }

    const appended = appendEvent(tx, {
      // One string for both, as `run_admission.ts` does it: the fact's identity
      // and its uniqueness rule are the same statement, and a second generated
      // id would only be a second thing that could collide.
      eventId: dedupKey,
      eventType: WORKER_ESCALATION_EVENT_TYPE,
      subjectKind: "run",
      subjectId: runId,
      dedupKey,
      producer: REPORT_INGRESS_PRODUCER,
      occurredAtMs: nowMs,
      ingestedAtMs: nowMs,
      runId,
      payload,
    });

    let eventSeq = appended.seq;
    if (eventSeq === null) {
      // The re-processing path. `appendEvent` swallowed its own `DuplicateFact`
      // and wrote nothing -- including nothing to roll back, since its dedup
      // check is its first statement -- so this block is still clean and the
      // sequence is simply looked up.
      const existing = tx
        .prepare<{ dedup_key: string }, { seq: number }>(
          "SELECT seq FROM event WHERE dedup_key = :dedup_key",
        )
        .get({ dedup_key: dedupKey });
      if (existing === undefined) {
        throw new ReportIngressUsageError(
          `the spine reported ${pythonRepr(dedupKey)} as already appended but no ` +
            "event carries that dedup key",
        );
      }
      eventSeq = existing.seq;
    }

    const standing = tx
      .prepare<{ origin_event_seq: number }, { gate_id: string }>(
        "SELECT gate_id FROM gate WHERE origin_event_seq = :origin_event_seq",
      )
      .get({ origin_event_seq: eventSeq });
    if (standing !== undefined) {
      return Object.freeze({
        eventSeq,
        eventId: appended.eventId,
        gateId: standing.gate_id,
        duplicate: appended.duplicate,
        gateOpened: false,
      });
    }

    openGate(tx, {
      gateId,
      gateType: WORKER_ESCALATION_GATE_TYPE,
      subjectKind: "run",
      subjectId: runId,
      // The same string as the payload's `report`, by construction rather than
      // by convention: section 4.7 puts the report in the origin event's
      // payload and from there into `rationale`, which is the field that says
      // why the gate exists. It must not reach `gate_transition.body`, which
      // carries the human's answer -- recording worker prose there would record
      // worker-authored text as the approval.
      rationale: fact.report,
      originEventSeq: eventSeq,
      createdAtMs: nowMs,
      actorKind,
      actorId,
      options: gateOptions,
      deadlineAtMs,
      runId,
    });

    return Object.freeze({
      eventSeq,
      eventId: appended.eventId,
      gateId,
      duplicate: appended.duplicate,
      gateOpened: true,
    });
  });
}

/** The argument check every identifier here shares. */
function requireText(field: string, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReportIngressUsageError(
      `${field} must be a non-empty string, got ${pythonRepr(value)}`,
    );
  }
}
