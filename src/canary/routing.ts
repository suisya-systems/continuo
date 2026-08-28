/**
 * The run-start routing point -- item 10 rehearsal (Issue #23, D-0022).
 *
 * .. warning::
 *
 *    **Rehearsal artifact, throwaway by default (D-0026).** The property being
 *    rehearsed is the one that makes the canary cheap: **rollback is a routing
 *    change, not a data migration**. The discharge point is the canary itself,
 *    with live v1 as the counterparty (D-0022); nothing here discharges item 10.
 *
 * **Where this boundary sits.** Above both systems, and above the session
 * provider. The provider contract is five verbs about *sessions* and carries no
 * notion of which system owns a run; folding a system cutover into it would put
 * cutover semantics inside the interface item 11 proved swappable. So the
 * routing point is its own boundary, consulted **once per run, at run start,
 * before the first system-specific write or spawn**. It decides and records; it
 * does not start anything -- the caller takes the answer to the owning system's
 * own start path. That is also why this module imports nothing from the session
 * layer (or any other module of this package beyond `./ledger.js`): the routing
 * point has no provider dependency and survives a provider switch untouched,
 * which `test/canary/structural.test.ts` asserts rather than describes.
 *
 * **What a rollback is.** {@link RunStartRoutingPoint.routeNewRunsTo} with the
 * previous owning system. There is no other rollback code path -- no migration
 * hook, no state converter, no "move these runs back" API -- and that absence is
 * the point, not an omission. Runs already in flight keep the owner the ledger
 * recorded for them, wherever the policy moves afterwards; what *happens* to
 * interlock-started runs at a real rollback (drain? finish? abort?) is part of
 * `Q-0005` and deliberately not decided -- or expressible -- here.
 *
 * Two things here are the port's rather than the source's, and both are marked
 * where they occur:
 *
 * - **Transactions are explicit.** Python's `with connection:` is a
 *   commit/rollback scope over the implicit deferred transaction the DML
 *   statement itself opened. better-sqlite3 has no implicit transaction at all:
 *   a bare `.run()` autocommits. So each of the two mutating methods wraps its
 *   one statement in exactly one `connection.transaction(...)`, and the
 *   `changes === 0` refusal is thrown from *inside* that function so it rolls
 *   back -- which is what makes {@link RoutingRefused}'s "nothing was written"
 *   true rather than merely intended.
 * - **The already-routed conflict is classified by result code, never by
 *   message text** (`D-0016`, `D-0402`), and since the store gained its
 *   replacement guard the code that arrives is a trigger refusal, confirmed by
 *   re-reading the row (`D-0405`, `D-0406`). See
 *   {@link isAlreadyRoutedConflict}.
 * - **INTEGER columns are read 64-bit wide** (`D-0407`): `safeIntegers(true)`
 *   plus {@link narrowInteger}, so a value only an out-of-package writer can
 *   put in the ledger is reported as it is stored rather than rounded.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";

import { sqliteCodeOf } from "../sqlite/errors.js";
import { OWNING_SYSTEMS } from "./ledger.js";

// --------------------------------------------------------------------------
// the refusal family
// --------------------------------------------------------------------------

/**
 * The routing point refused. Nothing was routed and nothing was written.
 *
 * The invariant is carried by the *base* class on purpose: a caller that
 * catches `RoutingRefused` knows the store is untouched without having to know
 * which of the four cases it caught.
 *
 * None of these constructors takes a `cause`, and that is deliberate rather
 * than an omission -- see {@link OwnerChangeRefused}, whose source raises `from
 * None`. `Object.setPrototypeOf` in every constructor because extending a
 * built-in under a downlevel emit target loses the prototype chain and
 * `instanceof` then silently reports false; the ported cases assert refusal
 * *types*, so a broken chain would turn a type assertion into a message
 * assertion without saying so.
 */
export class RoutingRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingRefused";
    Object.setPrototypeOf(this, RoutingRefused.prototype);
  }
}

/**
 * No routing decision has been taken yet.
 *
 * Deliberately not defaulted away: a routing point that assumes an owner when
 * no one decided one is a cutover nobody decided on. The baseline ("new runs go
 * to v1") is itself a recorded decision.
 */
export class NoRoutingDecision extends RoutingRefused {
  constructor(message: string) {
    super(message);
    this.name = "NoRoutingDecision";
    Object.setPrototypeOf(this, NoRoutingDecision.prototype);
  }
}

/** The named system is outside the closed vocabulary (see `OWNING_SYSTEMS`). */
export class UnknownOwningSystem extends RoutingRefused {
  constructor(message: string) {
    super(message);
    this.name = "UnknownOwningSystem";
    Object.setPrototypeOf(this, UnknownOwningSystem.prototype);
  }
}

/**
 * A started run was asked to change owning system. No run changes owner
 * mid-flight (gate item 10); the refusal leaves the ledger row untouched.
 */
export class OwnerChangeRefused extends RoutingRefused {
  constructor(message: string) {
    super(message);
    this.name = "OwnerChangeRefused";
    Object.setPrototypeOf(this, OwnerChangeRefused.prototype);
  }
}

/** The run has no ledger row: it was never routed through this point. */
export class UnroutedRun extends RoutingRefused {
  constructor(message: string) {
    super(message);
    this.name = "UnroutedRun";
    Object.setPrototypeOf(this, UnroutedRun.prototype);
  }
}

// --------------------------------------------------------------------------
// the two immutable values
// --------------------------------------------------------------------------

/**
 * An INTEGER column of the ledger, as this module returns it.
 *
 * `number` for every value a double holds exactly, which is every value any
 * continuo API can write; `bigint` only for one a double cannot, which only an
 * out-of-package writer can put there (D-0407). Python's `int` is arbitrary
 * precision and the source's dataclasses therefore never lose one, so reading
 * these as plain doubles would have made the port report a `decision_seq` or a
 * timestamp that disagrees with the stored row -- silently, and by one.
 */
export type LedgerInteger = number | bigint;

/** One appended row of the routing policy. The newest is the routing. */
export interface RoutingDecision {
  readonly decisionSeq: LedgerInteger;
  readonly owningSystem: string;
  readonly decidedAtMs: LedgerInteger;
  readonly reason: string;
}

/**
 * One run's immutable ledger entry: which system owns it, and under which
 * decision it was routed.
 */
export interface RoutedRun {
  readonly runId: string;
  readonly owningSystem: string;
  readonly decisionSeq: LedgerInteger;
  readonly routedAtMs: LedgerInteger;
}

// --------------------------------------------------------------------------
// refusal text
// --------------------------------------------------------------------------

/**
 * The empty-policy refusal, written once.
 *
 * The source repeats the same sentence at both raise sites (`current_decision`
 * and `route_run_start`). Repeating a *sentence* is how two refusals that are
 * supposed to be the same drift apart, and `D-0017` rule 4 wants one renderer
 * per interpolated shape for the same reason, so it is a constant here. The
 * observable text is identical at both sites, exactly as in the source.
 */
const NO_DECISION_MESSAGE =
  "no routing decision has been taken; the routing point does not assume an " +
  "owner (record a baseline decision first)";

/**
 * Python's `repr` of a string, for the three values this module interpolates
 * into refusal text (`D-0017` rule 3).
 *
 * `control_plane/python_repr.ts` already holds this rule, measured against
 * CPython, and this is deliberately **not** an import of it: `routing.py`
 * imports nothing but `sqlite3`, `dataclasses` and the canary ledger, that
 * import poverty is the module's stated no-provider-dependency property, and
 * `test/canary/structural.test.ts` asserts it. So the rule is restated here for
 * the one shape that reaches this file -- a string -- and nothing else.
 *
 * The rule, measured: prefer single quotes; switch to double only when the
 * value contains a single quote and no double quote; otherwise escape the
 * single quote. A run id is caller-supplied text, so `'a'b'` -- what a
 * hand-written apostrophe pair produces -- is ambiguous rather than parity
 * text on exactly the path that exists to say which value was refused.
 */
function repr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = "";
  for (const character of value) {
    if (character === "\\") {
      out += "\\\\";
    } else if (character === quote) {
      out += `\\${quote}`;
    } else if (character === "\n") {
      out += "\\n";
    } else if (character === "\r") {
      out += "\\r";
    } else if (character === "\t") {
      out += "\\t";
    } else {
      out += character;
    }
  }
  return `${quote}${out}${quote}`;
}

/**
 * A 64-bit INTEGER read back as the narrowest JavaScript type that holds it
 * exactly (`D-0407`).
 *
 * `src/canary/audit.ts` carries the same five lines privately, and this is
 * deliberately not an import of it, for the reason {@link repr} is not an
 * import of `control_plane/python_repr.ts`: this module's documented -- and
 * structurally asserted -- property is that it imports nothing of this package
 * beyond `./ledger.js`, and `audit.ts` does not export the helper. Widening the
 * audit's surface, or this module's imports, to share five lines would cost
 * more than the duplication does.
 */
function narrowInteger(value: LedgerInteger): LedgerInteger {
  if (typeof value !== "bigint") {
    return value;
  }
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value;
}

/**
 * `OWNING_SYSTEMS` as Python renders the 2-tuple it is:
 * `('interlock', 'synthetic_v1')`.
 *
 * One renderer, computed once, rather than an inline join at the call site
 * (`D-0017` rule 4). `JSON.stringify` would render `["interlock","synthetic_v1"]`
 * -- a different sentence, and the wrong quotes.
 */
const OWNING_SYSTEMS_REPR = `(${OWNING_SYSTEMS.map(repr).join(", ")})`;

// --------------------------------------------------------------------------
// the statements
// --------------------------------------------------------------------------

/** The whole of a rollback: one appended row, and nothing anywhere else. */
const APPEND_DECISION_SQL =
  "INSERT INTO routing_decision (owning_system, decided_at_ms, reason) " +
  "VALUES (:owning_system, :now_ms, :reason)";

/**
 * The decision is read **inside the insert**, as one statement, rather than
 * looked up first and written after.
 *
 * A lookup-then-insert would leave a window in which a rollback on another
 * connection commits between the two, and the run would then start on the
 * system the rollback just routed away from -- a stale decision surviving its
 * own rollback, which is precisely the run-boundary property under rehearsal.
 * Do not decompose this into a read plus an insert.
 */
const ROUTE_RUN_START_SQL =
  "INSERT INTO run_owner (run_id, owning_system, decision_seq, routed_at_ms) " +
  "SELECT :run_id, owning_system, decision_seq, :now_ms " +
  "  FROM routing_decision ORDER BY decision_seq DESC LIMIT 1";

const CURRENT_DECISION_SQL =
  "SELECT decision_seq, owning_system, decided_at_ms, reason " +
  "  FROM routing_decision ORDER BY decision_seq DESC LIMIT 1";

const ROUTED_RUN_SQL =
  "SELECT run_id, owning_system, decision_seq, routed_at_ms " +
  "  FROM run_owner WHERE run_id = :run_id";

/**
 * The `routing_decision` row shape, in the SELECT's column order.
 *
 * Every INTEGER arrives as a `bigint`, because the statements below are read
 * with `safeIntegers(true)` (`D-0407`); {@link narrowInteger} puts the ordinary
 * ones back.
 */
interface DecisionRow {
  readonly decision_seq: bigint;
  readonly owning_system: string;
  readonly decided_at_ms: bigint;
  readonly reason: string;
}

/** The `run_owner` row shape, in the SELECT's column order. */
interface RunOwnerRow {
  readonly run_id: string;
  readonly owning_system: string;
  readonly decision_seq: bigint;
  readonly routed_at_ms: bigint;
}

/**
 * The already-routed conflict, classified by SQLite result code.
 *
 * **The source classifies this by substring-matching the exception message**
 * (`if "UNIQUE constraint failed: run_owner.run_id" not in str(error): raise`),
 * and the port must not (`D-0016`, `D-0402`). SQLite's message text is not a
 * compatibility surface and its codes are -- and the two do not even agree
 * here. Measured against better-sqlite3 13.0.3 on this DDL, a second insert of
 * the same `run_id` arrives as code `SQLITE_CONSTRAINT_PRIMARYKEY` while its
 * *message* reads `UNIQUE constraint failed: run_owner.run_id`, because
 * `run_id TEXT PRIMARY KEY` on a rowid table is a unique index that SQLite
 * still reports as a primary-key violation. `SQLITE_CONSTRAINT_UNIQUE` is
 * accepted alongside it because that is the code the same collision carries if
 * the table is ever declared `WITHOUT ROWID` or the uniqueness moves to an
 * index; the question either code answers is the same one.
 *
 * **`SQLITE_CONSTRAINT_TRIGGER` joined the set when the D-0405 replacement
 * guard landed (`D-0406`).** `run_owner_is_never_replaced` is a `BEFORE INSERT`
 * trigger, and firing ahead of conflict resolution -- which is exactly what
 * closes the `INSERT OR REPLACE` hole for a connection this package did not
 * configure -- means it, and not the primary key, is now what a duplicate
 * `run_id` meets first. So the duplicate that D-0402 measured as
 * `SQLITE_CONSTRAINT_PRIMARYKEY` arrives as `SQLITE_CONSTRAINT_TRIGGER`
 * instead. The two older codes are kept: they are what the same collision
 * carries if the guard is ever removed, if the table is declared `WITHOUT
 * ROWID`, or if the uniqueness moves to an index.
 *
 * `SQLITE_CONSTRAINT_TRIGGER` is **not** specific to the replacement guard,
 * though -- the DDL raises it from four other triggers -- so unlike the two
 * uniqueness codes it is not on its own an answer. It is a question the caller
 * settles by re-reading `run_owner`: a row for the run means the guard fired,
 * no row means some other trigger did and the error passes through as itself.
 * See {@link RunStartRoutingPoint.routeRunStart}.
 *
 * Every other constraint code passes through **as itself**:
 * `SQLITE_CONSTRAINT_CHECK` (an empty run id, a non-integer timestamp) and
 * `SQLITE_CONSTRAINT_FOREIGNKEY` are integrity failures, not ownership
 * questions, and reading one as "already routed" would turn a broken write into
 * a silent success. Two ported cases point exactly here, and they still land
 * because the guard's `WHEN` clause defers to the row's own CHECKs rather than
 * shadowing them -- a malformed retry is a `CHECK` failure, not a trigger one.
 *
 * Only `run_owner` is written by {@link ROUTE_RUN_START_SQL}, and its only
 * uniqueness is `run_id`, so a uniqueness code from that statement is
 * necessarily that column. The caller still *confirms* by re-reading the row
 * rather than trusting the code alone.
 */
function isAlreadyRoutedConflict(error: unknown): boolean {
  const code = sqliteCodeOf(error);
  return (
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_TRIGGER"
  );
}

/**
 * True for the one accepted code that more than one constraint can produce, and
 * which therefore only counts as an already-routed conflict once the row has
 * been seen (`D-0406`).
 */
function needsRowToBeConfirmed(error: unknown): boolean {
  return sqliteCodeOf(error) === "SQLITE_CONSTRAINT_TRIGGER";
}

// --------------------------------------------------------------------------
// the routing point
// --------------------------------------------------------------------------

/**
 * Decides, once per run at run start, which system owns the run.
 *
 * Constructed over an **already open** routing-ledger connection (see
 * `createRoutingLedger` / `openRoutingLedger` in `./ledger.js`): it
 * opens, verifies and closes nothing, and sets no pragmas -- it inherits
 * whatever `configureLedgerConnection` established, `recursive_triggers = ON`
 * included. Every method is one transaction; time is the caller's throughout
 * (`nowMs`), and order of authority among decisions is `decisionSeq`, never the
 * clock.
 */
export class RunStartRoutingPoint {
  readonly #connection: SqliteDatabase;

  constructor(connection: SqliteDatabase) {
    this.#connection = connection;
  }

  /**
   * Append a routing decision: new runs from now on belong to `owningSystem`.
   * **This method, with the previous owner, is the whole of a rollback.**
   *
   * Runs already started are untouched -- not by convention but because nothing
   * here writes anywhere near them: the only statement is an INSERT into
   * `routing_decision`.
   *
   * @throws UnknownOwningSystem before any statement runs, so nothing is
   *   written. The store enforces the same vocabulary independently through the
   *   DDL's `CHECK (owning_system IN ...)`; this refusal is the API half, and a
   *   port that kept only the store half would lose the refusal *type* and
   *   would only refuse after attempting a write.
   */
  routeNewRunsTo(
    owningSystem: string,
    options: { readonly nowMs: number; readonly reason: string },
  ): RoutingDecision {
    const { nowMs, reason } = options;
    // `OWNING_SYSTEMS` is a readonly tuple of string literals, so `.includes`
    // will not accept a plain `string` without the widening. The widening is
    // the whole of it: the membership test is the source's.
    if (!(OWNING_SYSTEMS as readonly string[]).includes(owningSystem)) {
      throw new UnknownOwningSystem(
        `${repr(owningSystem)} is not one of ${OWNING_SYSTEMS_REPR}; the ` +
          "rehearsal's owning-system vocabulary is closed",
      );
    }

    // Captured inside the transaction, as the source captures `cursor.lastrowid`
    // inside its `with`. `safeIntegers(true)` makes `lastInsertRowid` a bigint
    // and `narrowInteger` puts it back to a `number` whenever a double holds it
    // exactly -- which it does for every sequence any caller of this class can
    // reach, so the ported "the baseline is itself a recorded decision" case
    // still compares a number against the number a later SELECT reads back. A
    // bare `Number(...)` was the port's own 64-bit hole (D-0407): a ledger
    // carrying a `decision_seq` past 2**53 would have reported one that
    // disagreed with the stored row by one. `decision_seq` is an INTEGER PRIMARY
    // KEY, so SQLite always assigns one; the source says so with an `assert`.
    let decisionSeq: LedgerInteger = 0;
    this.#connection.transaction(() => {
      const result = this.#connection
        .prepare(APPEND_DECISION_SQL)
        .safeIntegers(true)
        .run({ owning_system: owningSystem, now_ms: nowMs, reason });
      decisionSeq = narrowInteger(result.lastInsertRowid);
    })();

    // Assembled from the arguments, not re-read. The asymmetry with
    // `routeRunStart` (which returns a fresh SELECT) is the source's and is
    // deliberate.
    return Object.freeze({ decisionSeq, owningSystem, decidedAtMs: nowMs, reason });
  }

  /**
   * The newest routing decision -- the one a run starting now falls under.
   *
   * Read-only and **not** transacted, as in the source. Recency is
   * `decision_seq DESC`, never `decided_at_ms`: a decision recorded with an
   * earlier `nowMs` but a higher sequence still wins.
   *
   * @throws NoRoutingDecision if none has been taken.
   */
  currentDecision(): RoutingDecision {
    const row = this.#connection.prepare(CURRENT_DECISION_SQL).safeIntegers(true).get() as
      | DecisionRow
      | undefined;
    if (row === undefined) {
      throw new NoRoutingDecision(NO_DECISION_MESSAGE);
    }
    return Object.freeze({
      decisionSeq: narrowInteger(row.decision_seq),
      owningSystem: row.owning_system,
      decidedAtMs: narrowInteger(row.decided_at_ms),
      reason: row.reason,
    });
  }

  /**
   * Record, under the current decision, which system owns `runId`.
   *
   * Called once per run, before the first system-specific write. The caller then
   * starts the run on the returned owner's own path; this method starts nothing.
   *
   * Idempotent against a crashed-and-retried router: routing an already-routed
   * run to the **same** owner returns the existing row unchanged. Routing it to
   * a **different** owner -- which is what a retry after a policy flip amounts
   * to -- is refused: the run started under its recorded owner and keeps it
   * (gate item 10). Only the duplicate-run uniqueness failure is read that way;
   * any other integrity failure (a CHECK, say) is not an ownership question and
   * passes through as itself.
   *
   * @throws NoRoutingDecision if no decision has been taken -- detected by
   *   `changes === 0` (the INSERT..SELECT inserted no row because
   *   `routing_decision` is empty) and thrown from **inside** the transaction
   *   function so the transaction rolls back.
   * @throws OwnerChangeRefused if `runId` is already owned by another system.
   */
  routeRunStart(runId: string, options: { readonly nowMs: number }): RoutedRun {
    const { nowMs } = options;
    try {
      this.#connection.transaction(() => {
        const result = this.#connection
          .prepare(ROUTE_RUN_START_SQL)
          .run({ run_id: runId, now_ms: nowMs });
        if (result.changes === 0) {
          throw new NoRoutingDecision(NO_DECISION_MESSAGE);
        }
      })();
    } catch (error) {
      if (!isAlreadyRoutedConflict(error)) {
        throw error;
      }
      // `SQLITE_CONSTRAINT_TRIGGER` is the code the D-0405 replacement guard
      // raises AND the code the DDL's four other triggers raise, so it is only
      // an already-routed conflict if the row it collided with is actually
      // there (D-0406). No row means another trigger fired, and the error goes
      // on as itself -- the same disposition every non-ownership integrity
      // failure has had since D-0402. The two uniqueness codes keep their
      // original path: a uniqueness failure on this statement can only be
      // `run_owner.run_id`, so absence there is the source's race and surfaces
      // as `UnroutedRun` from the re-read below, exactly as before.
      if (needsRowToBeConfirmed(error) && this.#runOwnerRow(runId) === undefined) {
        throw error;
      }
      // Both re-reads happen here, after the transaction has ended and rolled
      // back -- never from inside the transaction function, where better-sqlite3
      // would be reading through a statement that has just failed. They are the
      // *confirmation* the result code alone does not give: `routedRun` throws
      // `UnroutedRun` if the row another connection deleted is gone, and
      // `currentDecision` throws `NoRoutingDecision` if the policy is; both are
      // `RoutingRefused` and both propagate, as in the source.
      const existing = this.routedRun(runId);
      const decision = this.currentDecision();
      // `owningSystem` only, never `decisionSeq`. A retry under a *later*
      // decision that names the *same* owner is still the same routing, so it
      // returns the original row -- original `decisionSeq`, original
      // `routedAtMs`, the retry's `nowMs` discarded. Comparing `decisionSeq`
      // would turn that legitimate retry into a refusal.
      if (existing.owningSystem === decision.owningSystem) {
        return existing;
      }
      // No `cause`: the source suppresses the chain with `from None`, and
      // attaching the SqliteError would leak store-level message text into a
      // refusal whose contract is a stable sentence.
      throw new OwnerChangeRefused(
        `run ${repr(runId)} is owned by ${repr(existing.owningSystem)} ` +
          `(decision ${existing.decisionSeq}); re-routing it to ` +
          `${repr(decision.owningSystem)} would change its owner mid-flight, ` +
          "which gate item 10 forbids",
      );
    }
    // A fresh SELECT, not a value assembled from the insert: what is returned is
    // what the store actually holds, including anything a trigger normalised.
    return this.routedRun(runId);
  }

  /**
   * The ledger row for `runId`. Read-only, not transacted.
   *
   * @throws UnroutedRun if the run was never routed through this point.
   */
  routedRun(runId: string): RoutedRun {
    const row = this.#runOwnerRow(runId);
    if (row === undefined) {
      throw new UnroutedRun(`run ${repr(runId)} has no ledger row; it was never routed`);
    }
    // Read by column name rather than by position. The source builds both
    // dataclasses positionally from the row tuple (`RoutedRun(*row)`), so its
    // field order *is* the SELECT's column order; naming the columns here is the
    // same mapping written down, and it cannot silently swap two fields of the
    // same type if the SELECT list is ever reordered.
    return Object.freeze({
      runId: row.run_id,
      owningSystem: row.owning_system,
      decisionSeq: narrowInteger(row.decision_seq),
      routedAtMs: narrowInteger(row.routed_at_ms),
    });
  }

  /**
   * The raw `run_owner` row, or `undefined`. The read {@link routedRun} turns
   * into a value, and the one {@link routeRunStart} uses to decide whether a
   * `SQLITE_CONSTRAINT_TRIGGER` was the replacement guard or another trigger
   * (`D-0406`) -- there, absence is not a refusal but an answer.
   */
  #runOwnerRow(runId: string): RunOwnerRow | undefined {
    return this.#connection.prepare(ROUTED_RUN_SQL).safeIntegers(true).get({ run_id: runId }) as
      | RunOwnerRow
      | undefined;
  }
}
