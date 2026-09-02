import type { Database as SqliteDatabase } from "better-sqlite3";

import { appendEvent } from "./events.js";
import { pythonJsonObject } from "./python_json.js";
import { pythonRepr } from "./python_repr.js";
import { ControlPlaneRefusal } from "./refusals.js";
import { transaction } from "./txn.js";

/**
 * The single place a `run` row comes into existence (`D-0051`).
 *
 * `run_lifecycle.ts` is the single in-place writer of `run.status` and says, in
 * its own docstring, what it deliberately is not: it does not create runs,
 * because `docs/production-schema.md` section 4.2's writer table assigns run
 * *creation* no fence at all and `D-0046` rule 4 keeps it that way. A
 * `createRun` there would be a second writer to the `run` table wearing the
 * lifecycle module's name. So creation lives here instead, and this module is
 * the other half of that sentence: **lease-free, append-only, and the only
 * `INSERT INTO run` in the build.**
 *
 * Three properties are load-bearing, and each is here rather than in a
 * convention.
 *
 * - **The row and its admission event are one transaction.** `event.run_id`
 *   is a foreign key onto `run(run_id)` and the connection runs with
 *   `PRAGMA foreign_keys = ON` (`connection.ts`), so the order inside the
 *   block is forced: `INSERT INTO run` first, {@link appendEvent} second. What
 *   is *not* forced, and is the reason the boundary is taken here rather than
 *   left to `appendEvent`'s own, is the failure in between -- a crash after
 *   the row and before the event would leave a run nobody can point at an
 *   admission for, which is a run whose existence has no recorded cause.
 *   `txn.ts`'s {@link transaction} joins an inner call to an outer one rather
 *   than nesting it, so `appendEvent` runs inside this block without knowing
 *   it and without committing half of it.
 * - **A second admission of one run is refused, not absorbed.** Re-running the
 *   command is not an idempotent retry: `run admit` is the statement that a run
 *   *begins*, and a second statement of a beginning is either a mistaken repeat
 *   or two callers believing they own one identifier. Both are things an
 *   operator has to see. This is the one place the module deliberately differs
 *   from the spine underneath it, where a re-appended fact IS an idempotent
 *   no-op -- a re-polling producer restating one observed fact is ordinary, and
 *   a second admission is not.
 * - **It does not transition anything.** The row is inserted `created` and left
 *   there. `D-0046` rule 1 gives `run.status`'s in-place transitions to
 *   `advanceRunStatus` alone, and inserting a run already `running` would reach
 *   `running` without ever passing through that gate -- the single-writer rule
 *   evaded by starting past it rather than by writing around it. Admission ends
 *   at `created`; the consumer half of `D-0046` rule 2 calls `advanceRunStatus`
 *   from there.
 *
 * **Why the raw `INSERT` here is not the anomaly the run-table scan hunts.**
 * `test/control_plane/run-lifecycle.test.ts` asserts that no module under
 * `src/` writes the `run` table in raw SQL. That scan now permits exactly one
 * file -- this one -- and names it, so the property it checks is not "there are
 * no raw writes" but "creation has exactly one implementation site and it is
 * this module". A raw `UPDATE run` stays at zero everywhere, this module
 * included: `lease.ts`'s builders own that statement, and nothing here produces
 * one.
 *
 * **ASCII only** in every message, for the reason `docs/cli-output-policy.md`
 * gives: a refusal from here is printed by `run_cli.ts` on a console that may be
 * cp932, where a character it cannot encode is a crash rather than a smudge.
 */

// --------------------------------------------------------------------------
// the vocabulary admission writes
// --------------------------------------------------------------------------

/**
 * The status a run is admitted at.
 *
 * A constant rather than a literal at the `INSERT`, because it is the value two
 * other things are stated against: the `run` table's `CHECK` on the closed
 * status set, and `D-0046` rule 1's requirement that every step *after* this one
 * go through `advanceRunStatus`. Both are about this exact value being the
 * lowest rung, and a literal buried in a statement is not a thing either can be
 * checked against.
 */
export const ADMITTED_RUN_STATUS = "created";

/**
 * The event type this module produces, and the only one `D-0051` adds.
 *
 * Registered in `EVENT_TYPES` (`events.ts`), which is defined as the vocabulary
 * *this implementation produces* -- so it is listed there because this producer
 * exists, and future types arrive with their own producers rather than ahead of
 * them. The word is `subject_pastparticiple`, matching `pr_merged`,
 * `gate_expired` and `consumption_skipped`: it names an objective fact about the
 * database (a run row now exists), not an intention or a command that was typed.
 */
export const RUN_CREATED_EVENT_TYPE = "run_created";

/**
 * The `producer` stamped on every `run_created` event.
 *
 * Fixed rather than a caller's argument, and that is the point: the column
 * records which code path put the fact on the spine, and there is exactly one
 * that can put *this* fact there. A `producer` parameter would let two callers
 * write two different answers to a question that has one, and the spine's own
 * `dedup_key` rule -- one row per observed fact -- would not catch it, because
 * they would still be one row disagreeing with itself across time.
 */
export const RUN_ADMISSION_PRODUCER = "run_admission";

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/**
 * A malformed argument, refused before anything is opened or written.
 *
 * Outside the {@link ControlPlaneRefusal} family on purpose, and for the reason
 * `events.ts` keeps `EventSpineUsageError` outside it: a refusal in that family
 * is a *fact stated about the data* -- this database is behind, this run is
 * already admitted -- and is reported to the operator as one line. A `runId`
 * that is not a string is a defect in the caller, and burying its stack under
 * `error: ...` would cost the frames that diagnose it.
 */
export class RunAdmissionUsageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RunAdmissionUsageError";
    Object.setPrototypeOf(this, RunAdmissionUsageError.prototype);
  }
}

/**
 * This run identifier has already been admitted. Nothing was written.
 *
 * In the {@link ControlPlaneRefusal} family because it is the same kind of
 * answer `R3` gives for a database that cannot be verified: refuse, and leave
 * the state exactly as it stood. That membership is also what makes it reach
 * the operator as one line and exit 2 -- `run_cli.ts` catches the family, and
 * nothing narrower.
 */
export class RunAlreadyAdmitted extends ControlPlaneRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RunAlreadyAdmitted";
    Object.setPrototypeOf(this, RunAlreadyAdmitted.prototype);
  }
}

// --------------------------------------------------------------------------
// admission
// --------------------------------------------------------------------------

/** What one admission wrote, as the admission itself saw it. */
export interface AdmittedRun {
  /** The run now on the table. */
  readonly runId: string;
  /** The status it was inserted at, always {@link ADMITTED_RUN_STATUS}. */
  readonly status: string;
  /** `created_at_ms` and `updated_at_ms`, which admission sets equal. */
  readonly createdAtMs: number;
  /** The `run_created` event's identity and sequence on the spine. */
  readonly eventId: string;
  readonly eventSeq: number;
}

/**
 * What a run identifier may be made of: printable ASCII, and nothing else.
 *
 * A positive rule rather than a list of characters to reject, because the
 * question it answers is asked from two directions and a rejection list only
 * ever answers the direction someone thought of.
 *
 * - **A newline splits the report.** The identifier is interpolated verbatim
 *   into the one-line success report and into the `RunAlreadyAdmitted` message,
 *   both of which `run_cli.ts` terminates with a single `\n`. An identifier
 *   carrying its own newline makes the command appear to print a second line it
 *   never wrote, and `error: ` is a prefix worth forging. An escape sequence is
 *   the same problem with a terminal doing the rendering, and a zero-width
 *   joiner is the same problem with two identifiers that look identical.
 * - **A non-ASCII character can crash the console it is printed to.**
 *   `docs/cli-output-policy.md` governs what continuo *authors* and explicitly
 *   leaves external values out -- "any code path that echoes external text to a
 *   console has to deal with encoding on its own terms -- that problem is real,
 *   and it is not this policy". This is that code path dealing with it. A cp932
 *   console cannot encode `U+1F600`, and `D-0003` puts Windows on the merge
 *   path, so a run id that is only ever discovered to be unprintable at the
 *   moment an operator asks about it is a run id that cannot be reported.
 *
 * Refused at the writer rather than escaped at the print site, so that the row,
 * the event and every report about them quote the same string. Escaping in the
 * CLI would let the database hold an identifier no report can quote back
 * faithfully, which trades a visible refusal for an invisible divergence.
 *
 * This is narrower than the `run` table's own `CHECK`, which asks only for
 * non-empty text, and deliberately so: the column has to hold every identifier
 * ever admitted by any writer, and this is the rule for the one writer that
 * puts identifiers there **and** promises to print them back.
 */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** The one identity a `run_created` event has, derived from the run it is about. */
function runCreatedFactId(runId: string): string {
  return `${RUN_CREATED_EVENT_TYPE}/${runId}`;
}

/**
 * Admit a run: insert its row at `created` and append the `run_created` event
 * that says why it exists. One transaction.
 *
 * `nowMs` is the caller's clock, taken once and written to `created_at_ms`,
 * `updated_at_ms` and both of the event's timestamps. It is a parameter rather
 * than a `Date.now()` here for the reason every other writer in this package
 * takes one: the DDL requires `updated_at_ms >= created_at_ms`, and two reads of
 * a clock are two values, so the invariant would rest on the ordering of two
 * calls instead of on there being one. The event's `occurred_at_ms` and
 * `ingested_at_ms` are the same instant here and that is not a shortcut --
 * `time-base-policy.md` section 2 separates the source clock from ours, and for
 * an admission we *are* the source: the fact is the row this call is writing,
 * not something a provider reported.
 *
 * The existence check is a `SELECT` before the `INSERT` rather than a caught
 * `UNIQUE` violation, mirroring how `appendEvent` detects a duplicate fact. The
 * two are equivalent under the `BEGIN IMMEDIATE` this block opens -- the write
 * lock is held from the first statement, so no second admission can land between
 * the read and the write -- and the `SELECT` is what makes the refusal a typed
 * one carrying the run's own identifier, rather than a driver's constraint
 * message from three frames down.
 *
 * @throws {RunAdmissionUsageError} for a malformed argument, before any write.
 * @throws {RunAlreadyAdmitted} if the run identifier is already on the table.
 *   Nothing is written: the whole block rolls back.
 */
export function admitRun(
  connection: SqliteDatabase,
  options: { readonly runId: string; readonly nowMs: number },
): AdmittedRun {
  const { runId, nowMs } = options;

  if (typeof runId !== "string" || runId.trim() === "") {
    throw new RunAdmissionUsageError(`run_id must be a non-empty string, got ${pythonRepr(runId)}`);
  }
  if (!PRINTABLE_ASCII.test(runId)) {
    throw new RunAdmissionUsageError(
      `run_id must be printable ASCII (U+0020..U+007E), got ${pythonRepr(runId)}; ` +
        "the identifier is printed back verbatim in this command's report and in " +
        "its refusals, so a character that cannot be printed is one that cannot " +
        "be reported",
    );
  }
  if (typeof nowMs !== "number" || !Number.isInteger(nowMs)) {
    throw new RunAdmissionUsageError(
      `now_ms must be an int of epoch milliseconds, got ${pythonRepr(nowMs)}`,
    );
  }

  return transaction(connection, (tx) => {
    const existing = tx
      .prepare<{ run_id: string }, { status: string }>(
        "SELECT status FROM run WHERE run_id = :run_id",
      )
      .get({ run_id: runId });
    if (existing !== undefined) {
      throw new RunAlreadyAdmitted(
        `run ${runId} was already admitted and is at status '${existing.status}'; ` +
          "admission states that a run begins, so a second one is refused rather " +
          "than absorbed -- a re-run under a fresh identifier is the way to start " +
          "a new run",
      );
    }

    tx.prepare<{
      run_id: string;
      status: string;
      created_at_ms: number;
      updated_at_ms: number;
    }>(
      `
        INSERT INTO run (run_id, status, created_at_ms, updated_at_ms)
        VALUES (:run_id, :status, :created_at_ms, :updated_at_ms)
        `,
    ).run({
      run_id: runId,
      status: ADMITTED_RUN_STATUS,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
    });

    const factId = runCreatedFactId(runId);
    const appended = appendEvent(tx, {
      eventId: factId,
      eventType: RUN_CREATED_EVENT_TYPE,
      subjectKind: "run",
      subjectId: runId,
      dedupKey: factId,
      producer: RUN_ADMISSION_PRODUCER,
      occurredAtMs: nowMs,
      ingestedAtMs: nowMs,
      runId,
      payload: pythonJsonObject([["status", ADMITTED_RUN_STATUS]]),
    });

    if (appended.seq === null) {
      // Unreachable in this build, and checked anyway -- this is the line that
      // makes the module's own atomicity claim true rather than incidental.
      //
      // `appendEvent` treats a `dedup_key` already on the spine as an
      // idempotent no-op: it raises internally, and because `transaction`
      // JOINS an inner call rather than nesting it, that raise unwinds only as
      // far as `appendEvent`'s own catch, which returns `duplicate: true`. The
      // block we are standing in is NOT rolled back by it. So the append
      // returning quietly would commit a `run` row with no admission event on
      // the spine -- exactly the inconsistency the one-transaction rule above
      // exists to prevent, arriving through the mechanism meant to prevent it.
      // Refusing turns it back into a rollback.
      //
      // Nothing can reach it today: the only producer of this fact is this
      // function, its `dedup_key` is derived from the run identifier, and the
      // duplicate run row is already refused above. It becomes reachable the
      // moment a second producer appends under this vocabulary, which is when
      // a silent commit would be hardest to trace back.
      throw new RunAlreadyAdmitted(
        `the spine already holds ${factId} as event ${appended.eventId}, but ` +
          `run ${runId} was not on the run table; refusing to admit a run whose ` +
          "admission event cannot be appended alongside it",
      );
    }

    return Object.freeze({
      runId,
      status: ADMITTED_RUN_STATUS,
      createdAtMs: nowMs,
      eventId: appended.eventId,
      eventSeq: appended.seq,
    });
  });
}
