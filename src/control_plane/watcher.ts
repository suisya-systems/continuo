import { randomUUID } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { isConstraintError } from "../sqlite/errors.js";
import { effectKind, type Lease, readLease, StaleWriterRefused } from "./lease.js";
import { pythonRepr, pythonTuple } from "./python_repr.js";
import { transaction } from "./txn.js";

/**
 * G3 -- watcher liveness: the expected roster, and the fenced unconditional trace.
 *
 * `docs/production-schema.md` section 8 and interlock `D-0035`. The failure this module
 * is written against is `tools/relay_scan.py`'s: a broken cron accumulated
 * undelivered events for twenty days, and nothing in the database said so,
 * because a watcher that stops writes no row and *no row looks exactly like a
 * clean scan*. A single `last_heartbeat_at` column cannot make four
 * distinctions the incident needs, and each of the four has its own v1
 * history:
 *
 * 1. **"polled, nothing changed" versus "poll failed"** -- collapsed, a
 *    watcher that fails fast looks healthy for as long as it keeps failing;
 * 2. **a replaced watcher's late heartbeat** -- an instance nobody relies on
 *    can keep proving its own liveness;
 * 3. **a missing watcher** -- an absence writes nothing, so it is invisible;
 * 4. **partial coverage** -- one instance covering three of five scopes reads
 *    exactly like one covering five.
 *
 * So there are two tables and this module is their pair of writers.
 * {@link registerScope} maintains `watcher_scope`, the **expected roster**,
 * and it is what turns "no row" from invisible into a query
 * ({@link uncoveredScopes}). {@link heartbeat} writes `watcher_liveness` on
 * **every attempt**, including the ones that observed nothing, which is what
 * keeps distinction 1 expressible.
 *
 * **The fence is inside the write, and the resource is derived inside the
 * write.** `ACCEPTANCE.md` section 2: expiry discovery alone is
 * insufficient, because the lease can expire between the check and the write
 * -- so the heartbeat validates the scope lease's holder and epoch as a
 * clause of its own statement, the single-statement shape
 * `src/control_plane/lease.ts` establishes. Section 8.3 then goes one step
 * further than that module has to: the lease resource is **computed from the
 * scope** as `'watcher_scope:' || :scope_id` rather than accepted as a
 * parameter. {@link heartbeat} therefore has no `resource` argument,
 * deliberately and permanently. A separate parameter would let a watcher
 * holding scope B's lease heartbeat scope A -- the row is written, an
 * uncovered scope looks healthy, and the `watcher_silence` predicate the
 * fence exists to protect is silenced by the very write it was meant to
 * reject. The API makes that unrepresentable rather than merely discouraged,
 * and `test_watcher.py` proves it.
 *
 * **Why an upsert rather than an UPDATE.** A newly registered scope has no
 * liveness row, so a bare `UPDATE` changes zero rows on the first heartbeat
 * of every scope -- and zero rows is also how a stale writer is refused.
 * Bootstrap would be permanently indistinguishable from rejection. Both arms
 * carry the same fence, so the insert arm is not a way around it.
 *
 * **Zero rows has exactly two causes and they are read, never assumed**: the
 * lease is no longer ours, or a higher epoch already holds the row.
 * {@link heartbeat} disambiguates them with one follow-up read inside the
 * same transaction and records the refusal as an `action` row in
 * `status='refused'` carrying which of the two it was -- `ACCEPTANCE.md`
 * section 2 requires the rejection of a stale writer to be itself durable,
 * and a refused heartbeat is never silently dropped. A third path reaches
 * the same refusal by a different mechanism: a *different* holder arriving
 * at an *equal* epoch satisfies the upsert's `holder_epoch <= :epoch` and is
 * then aborted by the `watcher_liveness_epoch_is_monotonic` trigger, so it
 * surfaces as an exception instead of as zero rows. It is the same stale
 * writer and it is recorded the same way.
 *
 * **Both policy reads bind the effective revision.** `D-0031`'s corollary is
 * that a `policy_*` join without a `revision_id` predicate is a defect: it
 * matches every revision ever recorded and alarms on retired tolerances. The
 * predicate is written once, as {@link EFFECTIVE_REVISION_SQL}, and both
 * {@link silentScopes} and {@link errorStreakScopes} splice that one text.
 *
 * **Silence and an error streak are different incident classes** and this
 * module keeps them separate queries because their remedies differ: a dead
 * process versus a broken credential. Collapsing them would produce one
 * alarm that names neither.
 *
 * Every timestamp is an integer of milliseconds since the Unix epoch and
 * comes from the caller. Nothing here reads a clock -- no schema column has a
 * `DEFAULT` for the same reason (`ACCEPTANCE.md` section 2 injects clock
 * skew across expiry boundaries, and a database-supplied timestamp makes
 * that untestable).
 */

// --------------------------------------------------------------------------
// the module's replaceable internals (D-0014)
// --------------------------------------------------------------------------

/**
 * The module's one replaceable internal: the id generator behind a refused
 * heartbeat's `action_id`.
 *
 * The source calls `uuid.uuid4().hex` inline in `_record_refusal`. Nothing
 * in `test_watcher.py` patches it -- every case that reaches a refusal
 * asserts `recorded[0]["action_id"] == refused.value.action_id`, comparing
 * the generated id against itself rather than pinning its value, so the
 * source suite never needs a fixed id and never monkeypatches `uuid`. A seam
 * is provided anyway, per D-0014's own reasoning (`leaseSeams` in
 * `lease.ts`) and per this module's own instruction to keep every generator
 * on a seam whether or not the source suite happens to reach for it: a seam
 * nothing routes through is worse than none. The one internal call site
 * ({@link recordRefusal}) goes through it.
 *
 * Not re-exported from `src/index.ts`: it is a testing seam, not public API.
 */
export const watcherSeams = {
  /** `uuid.uuid4().hex`: a lower-case 32-character hex string, no dashes. */
  uuid4Hex: (): string => randomUUID().replace(/-/g, ""),
};

// --------------------------------------------------------------------------
// constants
// --------------------------------------------------------------------------

/**
 * The prefix half of the lease resource a scope's watcher must hold. It is a
 * constant so that the TypeScript helper and the SQL below cannot drift: the
 * statement composes the same string with `||`, and a heartbeat that
 * computed one name while the lease was taken under another would be
 * refused forever for a reason nothing in the rows would explain.
 *
 * Public in the source, and therefore public here. It is absent from
 * `__all__`, but `__all__` governs `from x import *` -- not attribute
 * visibility -- and the name carries no leading underscore, so
 * `from ...watcher import SCOPE_LEASE_PREFIX` works in interlock. Dropping it
 * would be removing API the source has. Same treatment as `ci_ingest.py`'s
 * `NO_ELIGIBLE_EVIDENCE`, which is public-but-not-in-`__all__` for the same
 * reason and is exported here too.
 */
export const SCOPE_LEASE_PREFIX = "watcher_scope:";

/**
 * The closed result set of `watcher_liveness.last_result`, mirrored from the
 * table's own CHECK. `observed_no_change` is the member the single-column
 * form loses, and losing it is distinction 1 above.
 */
export const HEARTBEAT_RESULTS = Object.freeze([
  "observed_change",
  "observed_no_change",
  "error",
] as const);

/**
 * Mirrored from `watcher_scope`'s CHECK. Kept here so a bad kind is a typed
 * refusal from this module rather than an integrity error from three frames
 * down inside a statement the caller believed was a registration.
 */
export const SCOPE_KINDS = Object.freeze(["ci_pull_request", "ci_repository"] as const);

/**
 * The effective policy revision, as the one text both policy reads splice.
 *
 * `D-0031`: a `policy_*` join without a `revision_id` predicate matches
 * every revision ever recorded, so a retired tolerance keeps alarming next
 * to the live one. Writing the predicate once is what keeps the two queries
 * from diverging -- the failure of the alternative is silent, because a
 * query that forgot the predicate still returns rows.
 *
 * `ORDER BY effective_at_ms DESC, revision_id DESC` and not by
 * `effective_at_ms` alone: two revisions may share an instant (a correction
 * filed the same millisecond), and the later `revision_id` is the later
 * decision. Without the tiebreak the pair would resolve arbitrarily and the
 * detector's tolerance would depend on SQLite's row order.
 */
export const EFFECTIVE_REVISION_SQL = `(SELECT revision_id FROM policy_revision
                              WHERE effective_at_ms <= :now_ms
                              ORDER BY effective_at_ms DESC, revision_id DESC
                              LIMIT 1)`;

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

/** A watcher operation was refused. Nothing was written past the refusal. */
export class WatcherRefusal extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "WatcherRefusal";
    Object.setPrototypeOf(this, WatcherRefusal.prototype);
  }
}

/**
 * The named scope is not on the roster.
 *
 * Raised instead of letting the foreign key fire from inside the heartbeat
 * upsert, because the upsert's own failure vocabulary is "zero rows means a
 * stale writer" and a missing scope is not a stale writer. Conflating them
 * would put an invented refusal into the evidence the roster is read out of.
 */
export class ScopeNotRegistered extends WatcherRefusal {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ScopeNotRegistered";
    Object.setPrototypeOf(this, ScopeNotRegistered.prototype);
  }
}

/**
 * A heartbeat was refused because its writer was not the live one.
 *
 * A subclass of the lease module's refusal because it *is* one: the token
 * was validated inside the write, the write changed nothing, and the
 * rejection is durable before this is raised. {@link StaleWriterRefused.actionId}
 * names the `action` row in `status='refused'` and
 * {@link StaleWriterRefused.observed} is the scope's lease row as it
 * actually stood.
 *
 * {@link HeartbeatRefused.cause} is the disambiguation section 8.3 requires
 * to be read rather than assumed, and it is one of:
 *
 * `'lease_not_held'`
 *     The fence's `EXISTS` failed: at `nowMs` this holder/epoch did not hold
 *     `watcher_scope:<scope_id>`. The commonest shape is a watcher
 *     heartbeating a scope it never held -- including one holding a
 *     *different* scope's lease, which is why the resource is derived and
 *     not passed.
 * `'epoch_superseded'`
 *     The fence held, but the liveness row already carries a higher
 *     `holder_epoch`. A replaced watcher returning with its old token.
 * `'epoch_not_raised_by_new_holder'`
 *     A different holder arrived at an equal epoch. It passes the upsert's
 *     `holder_epoch <= :epoch` and is aborted by
 *     `watcher_liveness_epoch_is_monotonic`, so it reaches us as an
 *     integrity error rather than as zero rows -- the same stale writer, the
 *     same durable refusal.
 */
export class HeartbeatRefused extends StaleWriterRefused {
  override readonly cause: string;

  constructor(
    message: string,
    options: {
      readonly actionId: string;
      readonly observed: Lease | undefined;
      readonly cause: string;
    },
  ) {
    super(message, { actionId: options.actionId, observed: options.observed });
    this.name = "HeartbeatRefused";
    this.cause = options.cause;
    Object.setPrototypeOf(this, HeartbeatRefused.prototype);
  }
}

/** The caller used this module in a way that would break its guarantees. */
export class WatcherUsageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "WatcherUsageError";
    Object.setPrototypeOf(this, WatcherUsageError.prototype);
  }
}

// --------------------------------------------------------------------------
// argument checks
// --------------------------------------------------------------------------

function requireIdentifier(field: string, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WatcherUsageError(`${field} must be a non-empty string, got ${pythonRepr(value)}`);
  }
}

function requireInt(field: string, value: unknown): void {
  // A bool fails `typeof value !== "number"` on its own in TypeScript, unlike
  // Python where `bool` is an `int` subclass and needs an explicit exclusion.
  // `Number.isInteger` also excludes `NaN`, `Infinity` and a fractional
  // value, none of which Python's `int` admits either (D-0021's affinity
  // divergence is about a value already IN the database, not about what this
  // module accepts from a caller).
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new WatcherUsageError(
      `${field} must be an int of epoch milliseconds, got ${pythonRepr(value)}`,
    );
  }
}

// --------------------------------------------------------------------------
// the roster
// --------------------------------------------------------------------------

/**
 * The lease resource a watcher must hold to heartbeat `scopeId`.
 *
 * The name is a **function of the scope**, which is what makes a misrouted
 * heartbeat impossible rather than merely unlikely: {@link heartbeat}
 * composes the same string inside its statement, so there is no argument a
 * caller could pass that would aim the fence at some other scope's lease.
 * This helper is for the *acquire* side -- a watcher taking the lease it is
 * about to heartbeat under -- and for tests; nothing feeds its result back
 * into {@link heartbeat}.
 */
export function scopeLeaseResource(scopeId: string): string {
  requireIdentifier("scope_id", scopeId);
  return `${SCOPE_LEASE_PREFIX}${scopeId}`;
}

/**
 * Put `scopeId` on the expected roster.
 *
 * The roster is derived from work that exists -- a scope is registered when
 * a run's primary PR is linked and retired when that PR terminates (section
 * 8.2) -- and not maintained by hand, because a hand-maintained roster
 * drifts and a drifted roster either alarms forever or covers nothing.
 *
 * `expectedIntervalMs` is stored **per scope** because the
 * `watcher_silence` threshold is a multiple of it (section 8.4). Folding the
 * multiple into milliseconds in the policy row would bake one scope's
 * interval into a row every other scope reads and silently mis-age all of
 * them.
 *
 * The two shape rules are checked here rather than left to the table's
 * CHECKs so that the caller gets a sentence instead of an integrity error: a
 * `ci_pull_request` scope names a PR and a `ci_repository` scope does not,
 * and every scope names a repository.
 *
 * @throws {WatcherUsageError} on a bad kind, a missing or surplus `prId`, or
 *   a non-positive interval.
 */
export function registerScope(
  connection: SqliteDatabase,
  options: {
    readonly scopeId: string;
    readonly scopeKind: string;
    readonly expectedIntervalMs: number;
    readonly registeredAtMs: number;
    readonly repoId: string;
    readonly prId?: string | null;
  },
): void {
  const { scopeId, scopeKind, expectedIntervalMs, registeredAtMs, repoId, prId = null } = options;

  requireIdentifier("scope_id", scopeId);
  requireIdentifier("repo_id", repoId);
  requireInt("expected_interval_ms", expectedIntervalMs);
  requireInt("registered_at_ms", registeredAtMs);
  if (!(SCOPE_KINDS as readonly string[]).includes(scopeKind)) {
    throw new WatcherUsageError(
      `scope_kind must be one of ${pythonTuple(SCOPE_KINDS)}, got ${pythonRepr(scopeKind)}`,
    );
  }
  if (expectedIntervalMs <= 0) {
    throw new WatcherUsageError(
      `expected_interval_ms must be positive, got ${expectedIntervalMs}; the silence threshold ` +
        "is a multiple of it and a zero interval makes every scope instantly silent",
    );
  }
  if ((scopeKind === "ci_pull_request") !== (prId !== null)) {
    throw new WatcherUsageError(
      `scope_kind ${pythonRepr(scopeKind)} and pr_id ${pythonRepr(prId)} disagree: a ` +
        "'ci_pull_request' scope names the pull request it watches and a 'ci_repository' " +
        "scope does not",
    );
  }
  if (prId !== null) {
    requireIdentifier("pr_id", prId);
  }

  transaction(connection, (txn) => {
    txn
      .prepare<{
        scope_id: string;
        scope_kind: string;
        repo_id: string;
        pr_id: string | null;
        expected_interval_ms: number;
        registered_at_ms: number;
      }>(
        `
            INSERT INTO watcher_scope (scope_id, scope_kind, repo_id, pr_id,
                                       expected_interval_ms, enabled, registered_at_ms)
            VALUES (:scope_id, :scope_kind, :repo_id, :pr_id,
                    :expected_interval_ms, 1, :registered_at_ms)
            `,
      )
      .run({
        scope_id: scopeId,
        scope_kind: scopeKind,
        repo_id: repoId,
        pr_id: prId,
        expected_interval_ms: expectedIntervalMs,
        registered_at_ms: registeredAtMs,
      });
  });
}

/**
 * Take `scopeId` off the roster, without deleting anything.
 *
 * Retiring stamps `retiredAtMs` and leaves the liveness row where it is.
 * Both live-scope predicates read `enabled = 1 AND retired_at_ms IS NULL`,
 * so a retired scope stops being uncovered and stops being silent the
 * moment it is retired -- while its last trace stays readable as the
 * evidence of what the watcher last saw. Deleting the row instead would
 * take the history with it and make a retired scope indistinguishable from
 * one that was never registered.
 *
 * `enabled` is deliberately not touched: it is the *temporarily disabled*
 * axis, and collapsing the two would make a re-activation
 * (`retiredAtMs = null`) silently leave a scope disabled.
 *
 * @throws {ScopeNotRegistered} if no such scope is on the roster. A
 *   retirement that matched nothing is a caller working from a stale
 *   roster, and swallowing it would let the retirement look done.
 */
export function retireScope(
  connection: SqliteDatabase,
  options: { readonly scopeId: string; readonly retiredAtMs: number },
): void {
  const { scopeId, retiredAtMs } = options;

  requireIdentifier("scope_id", scopeId);
  requireInt("retired_at_ms", retiredAtMs);

  transaction(connection, (txn) => {
    const changed = txn
      .prepare<{ retired_at_ms: number; scope_id: string }>(
        "UPDATE watcher_scope SET retired_at_ms = :retired_at_ms " +
          " WHERE scope_id = :scope_id AND retired_at_ms IS NULL",
      )
      .run({ retired_at_ms: retiredAtMs, scope_id: scopeId }).changes;
    if (changed <= 0) {
      const known = txn
        .prepare<[string], { retired_at_ms: number | null }>(
          "SELECT retired_at_ms FROM watcher_scope WHERE scope_id = ?",
        )
        .get(scopeId);
      throw new ScopeNotRegistered(
        known === undefined
          ? `scope ${pythonRepr(scopeId)} is not on the roster; nothing was retired`
          : `scope ${pythonRepr(scopeId)} was already retired at ${known.retired_at_ms}; ` +
              "retirement is not re-stamped, so the first one stays the fact",
      );
    }
  });
}

// --------------------------------------------------------------------------
// the trace
// --------------------------------------------------------------------------

/**
 * Section 8.3, verbatim in shape. Read the module comment for why the lease
 * resource is composed here instead of bound as a parameter, and why both
 * arms carry the fence.
 */
const HEARTBEAT_SQL = `
INSERT INTO watcher_liveness (
        scope_id, holder, holder_epoch, last_attempt_at_ms, last_result,
        last_success_at_ms, last_change_at_ms, last_error_at_ms, last_error,
        consecutive_errors, attempt_count)
SELECT :scope_id, :holder, :epoch, :now_ms, :result,
       CASE WHEN :result <> 'error'           THEN :now_ms END,
       CASE WHEN :result =  'observed_change' THEN :now_ms END,
       CASE WHEN :result =  'error'           THEN :now_ms END,
       CASE WHEN :result =  'error'           THEN :error  END,
       CASE WHEN :result =  'error' THEN 1 ELSE 0 END, 1
 WHERE EXISTS (SELECT 1 FROM lease
                WHERE resource = 'watcher_scope:' || :scope_id
                  AND holder = :holder AND epoch = :epoch
                  AND expires_at_ms > :now_ms)
    ON CONFLICT(scope_id) DO UPDATE
   SET holder = :holder, holder_epoch = :epoch,
       last_attempt_at_ms = :now_ms, last_result = :result,
       last_success_at_ms = CASE WHEN :result <> 'error'
                                 THEN :now_ms ELSE last_success_at_ms END,
       last_change_at_ms  = CASE WHEN :result = 'observed_change'
                                 THEN :now_ms ELSE last_change_at_ms END,
       last_error_at_ms   = CASE WHEN :result = 'error'
                                 THEN :now_ms ELSE last_error_at_ms END,
       last_error         = CASE WHEN :result = 'error' THEN :error ELSE NULL END,
       consecutive_errors = CASE WHEN :result = 'error'
                                 THEN consecutive_errors + 1 ELSE 0 END,
       attempt_count      = attempt_count + 1
 WHERE watcher_liveness.holder_epoch <= :epoch
   AND EXISTS (SELECT 1 FROM lease
                WHERE resource = 'watcher_scope:' || :scope_id
                  AND holder = :holder AND epoch = :epoch
                  AND expires_at_ms > :now_ms)
`;

/**
 * The fence on its own, for the follow-up read that tells the two zero-row
 * causes apart. It is the same predicate as the statement's, evaluated
 * inside the same `BEGIN IMMEDIATE` transaction -- so nothing can have moved
 * the lease between the refusal and its classification.
 */
const FENCE_PROBE_SQL = `
SELECT EXISTS (SELECT 1 FROM lease
                WHERE resource = 'watcher_scope:' || :scope_id
                  AND holder = :holder AND epoch = :epoch
                  AND expires_at_ms > :now_ms)
`;

interface HeartbeatParams {
  readonly scope_id: string;
  readonly holder: string;
  readonly epoch: number;
  readonly result: string;
  readonly now_ms: number;
  readonly error: string | null;
}

interface HeartbeatRefusalRecord {
  readonly actionId: string;
  readonly reason: string;
  readonly cause: string;
  readonly observed: Lease | undefined;
}

/**
 * Record one watcher attempt on `scopeId`, or refuse and record that.
 *
 * Called on **every** attempt, including the ones that observed nothing:
 * `result='observed_no_change'` is a distinct fact from
 * `result='observed_change'` and from `result='error'`, and a table that
 * cannot tell them apart lets a watcher that fails fast look healthy for as
 * long as it keeps failing.
 *
 * There is no `resource` argument and there never will be one. See the
 * module comment: the scope's lease resource is composed inside the
 * statement, so a watcher can only ever heartbeat the scope it actually
 * holds.
 *
 * `lastSuccessAtMs` and `lastErrorAtMs` are **history**. They survive the
 * result that did not produce them -- a watcher failing for an hour still
 * has to be able to say when it last worked -- which is why the table's
 * constraints on them are implications rather than biconditionals, and why
 * the `CASE` arms above carry the old value forward instead of nulling it.
 *
 * @throws {ScopeNotRegistered} if `scopeId` is not on the roster. Checked
 *   before the upsert so that a missing scope reaches the caller as itself
 *   rather than as a foreign-key error masquerading as a refused writer.
 * @throws {HeartbeatRefused} if the writer was not the live one, in any of
 *   the three shapes {@link HeartbeatRefused} documents. The `action` row
 *   recording the refusal is committed with the refusal, never after it.
 */
export function heartbeat(
  connection: SqliteDatabase,
  options: {
    readonly scopeId: string;
    readonly holder: string;
    readonly epoch: number;
    readonly result: string;
    readonly nowMs: number;
    readonly error?: string | null;
  },
): void {
  const { scopeId, holder, epoch, result, nowMs, error = null } = options;

  requireIdentifier("scope_id", scopeId);
  requireIdentifier("holder", holder);
  requireInt("epoch", epoch);
  requireInt("now_ms", nowMs);
  if (epoch <= 0) {
    throw new WatcherUsageError(`epoch must be positive, got ${epoch}`);
  }
  if (!(HEARTBEAT_RESULTS as readonly string[]).includes(result)) {
    throw new WatcherUsageError(
      `result must be one of ${pythonTuple(HEARTBEAT_RESULTS)}, got ${pythonRepr(result)}`,
    );
  }
  // The table asserts `(last_result = 'error') = (last_error IS NOT NULL)`,
  // so both halves of this are integrity errors waiting to happen. They are
  // caller mistakes, and a caller who attached a message to a success meant
  // something by it -- dropping it silently is the worse of the two
  // answers. `Boolean(error)` reproduces Python's `bool(error)` truthiness
  // over the `string | null` domain this parameter admits (`null` and `""`
  // both false, any non-empty string true), so this is not the narrowing
  // lesson 11 warns against.
  if ((result === "error") !== Boolean(error)) {
    throw new WatcherUsageError(
      `result=${pythonRepr(result)} and error=${pythonRepr(error)} disagree: an 'error' ` +
        "attempt carries a non-empty message and every other result carries none",
    );
  }

  const params: HeartbeatParams = {
    scope_id: scopeId,
    holder,
    epoch,
    result,
    now_ms: nowMs,
    error,
  };

  const refusal = transaction(connection, (txn): HeartbeatRefusalRecord | undefined => {
    const registered = txn
      .prepare<[string], unknown>("SELECT 1 FROM watcher_scope WHERE scope_id = ?")
      .get(scopeId);
    if (registered === undefined) {
      throw new ScopeNotRegistered(
        `scope ${pythonRepr(scopeId)} is not on the roster, so there is nothing to heartbeat ` +
          "for; register it before its watcher runs",
      );
    }

    let record: HeartbeatRefusalRecord | undefined;
    let changed = 0;
    try {
      changed = txn.prepare<HeartbeatParams>(HEARTBEAT_SQL).run(params).changes;
    } catch (abort) {
      // The only integrity rule the upsert can still break here is the
      // epoch trigger: a DIFFERENT holder at an EQUAL epoch passes
      // `holder_epoch <= :epoch` and is aborted by
      // watcher_liveness_epoch_is_monotonic. `RAISE(ABORT)` unwinds the
      // statement and not the transaction, so the refusal below lands in
      // the same commit as the attempt it records. D-0016's mapping:
      // `isConstraintError` for Python's `sqlite3.IntegrityError`.
      if (!isConstraintError(abort)) {
        throw abort;
      }
      const cause = "epoch_not_raised_by_new_holder";
      const reason =
        `stale watcher heartbeat: ${pythonRepr(holder)} presented epoch ${epoch} for scope ` +
        `${pythonRepr(scopeId)} at now_ms=${nowMs}; a different holder already holds the ` +
        `liveness row at that epoch and a new holder must raise it (${
          abort instanceof Error ? abort.message : String(abort)
        })`;
      record = {
        actionId: recordRefusal(txn, { scopeId, holder, epoch, nowMs, reason }),
        reason,
        cause,
        observed: readLease(connection, scopeLeaseResource(scopeId)),
      };
      changed = 0;
    }

    if (record === undefined && changed <= 0) {
      // Read positionally (`.pluck()`): `EXISTS (...)` is not a plain
      // column reference, so its result-set column name is not one to rely
      // on -- see lesson 3 / `lease.ts`'s own fence probe.
      const fenceHolds = Boolean(txn.prepare<HeartbeatParams>(FENCE_PROBE_SQL).pluck().get(params));
      const observed = readLease(connection, scopeLeaseResource(scopeId));
      let cause: string;
      let reason: string;
      if (fenceHolds) {
        const heldEpoch = txn
          .prepare<[string], { holder: string; holder_epoch: number }>(
            "SELECT holder, holder_epoch FROM watcher_liveness WHERE scope_id = ?",
          )
          .get(scopeId);
        if (heldEpoch === undefined) {
          throw new Error(
            "unreachable: the fence held but watcher_liveness has no row for the scope",
          );
        }
        cause = "epoch_superseded";
        reason =
          `stale watcher heartbeat: ${pythonRepr(holder)} presented epoch ${epoch} for scope ` +
          `${pythonRepr(scopeId)} at now_ms=${nowMs} while holding its lease; the liveness ` +
          `row is held by ${pythonRepr(heldEpoch.holder)} at epoch ${heldEpoch.holder_epoch}`;
      } else {
        cause = "lease_not_held";
        reason =
          `stale watcher heartbeat: ${pythonRepr(holder)} presented epoch ${epoch} for scope ` +
          `${pythonRepr(scopeId)} at now_ms=${nowMs} without holding ` +
          `${pythonRepr(scopeLeaseResource(scopeId))}; the lease row is ${describeLease(observed)}`;
      }
      record = {
        actionId: recordRefusal(txn, { scopeId, holder, epoch, nowMs, reason }),
        reason,
        cause,
        observed,
      };
    }

    return record;
  });

  if (refusal !== undefined) {
    throw new HeartbeatRefused(
      `the heartbeat was refused and the refusal recorded as action ${pythonRepr(refusal.actionId)}: ` +
        refusal.reason,
      { actionId: refusal.actionId, observed: refusal.observed, cause: refusal.cause },
    );
  }
}

/** One `lease` row, rendered the way `_describe` renders it in the source. */
function describeLease(lease: Lease | undefined): string {
  if (lease === undefined) {
    return "absent";
  }
  return `held by ${pythonRepr(lease.holder)} at epoch ${lease.epoch} until ${lease.expiresAtMs}`;
}

/**
 * Write the durable record of a refused heartbeat, and return its id.
 *
 * **Unfenced on purpose**, exactly as the lease module's equivalent is: the
 * refusal exists *because* the writer's token was not live, so a fenced
 * insert could never land and the rejection would be dropped -- the one
 * thing `ACCEPTANCE.md` section 2 forbids of it. It rides inside the
 * heartbeat's own transaction, so the attempt and the record of its
 * rejection commit together or not at all.
 *
 * `status='refused'` is excluded from `action_one_effect_per_key`, so a
 * watcher that keeps coming back is recorded every time without any of
 * those records becoming the thing that admits a second effect. The
 * idempotency key still names the attempt uniquely -- a refused row is
 * evidence, and evidence that collides is evidence that overwrites.
 */
function recordRefusal(
  connection: SqliteDatabase,
  options: {
    readonly scopeId: string;
    readonly holder: string;
    readonly epoch: number;
    readonly nowMs: number;
    readonly reason: string;
  },
): string {
  const { scopeId, holder, epoch, nowMs, reason } = options;
  const actionId = `watcher-refusal-${watcherSeams.uuid4Hex()}`;
  connection
    .prepare<{
      action_id: string;
      kind: string;
      idempotency_key: string;
      refusal_reason: string;
      writer_epoch: number;
      created_at_ms: number;
    }>(
      `
        INSERT INTO action (action_id, kind, idempotency_key, exactly_once_mechanism,
                            status, refusal_reason, writer_epoch, created_at_ms)
        VALUES (:action_id, :kind, :idempotency_key, 'transactional_with_record',
                'refused', :refusal_reason, :writer_epoch, :created_at_ms)
        `,
    )
    .run({
      action_id: actionId,
      // effectKind composes 'watcher_heartbeat@watcher_scope:<id>', which is
      // how lease.ts's writeHistory can read every effect taken under one
      // scope's lease back out of a table that has no resource column.
      kind: effectKind(scopeLeaseResource(scopeId), "watcher_heartbeat"),
      idempotency_key: `watcher_heartbeat/${scopeId}/${holder}/${epoch}/${nowMs}/${actionId}`,
      refusal_reason: reason,
      writer_epoch: epoch,
      created_at_ms: nowMs,
    });
  return actionId;
}

// --------------------------------------------------------------------------
// the incident queries -- section 8.4, plus the third condition its prose names
// --------------------------------------------------------------------------

/** One row of {@link silentScopes}'s projection. */
export interface SilentScope {
  readonly scopeId: string;
  readonly silentForMs: number;
  readonly lastAttemptAtMs: number;
  readonly lastResult: string;
  readonly expectedIntervalMs: number;
  readonly thresholdValue: number;
}

/**
 * Live scopes whose watcher has stopped attempting, at `nowMs`.
 *
 * The threshold is a **multiple of that scope's own** `expectedIntervalMs`
 * -- which is why the policy row stores a multiple and not milliseconds, and
 * why this query multiplies rather than compares. A single millisecond
 * figure would mis-age every scope whose interval differs from the one it
 * was derived under.
 *
 * Silence is not an error streak ({@link errorStreakScopes}): this
 * predicate fires on the *absence* of attempts, whatever their results
 * were, and its remedy is a dead process rather than a broken credential.
 */
export function silentScopes(
  connection: SqliteDatabase,
  options: { readonly nowMs: number },
): readonly SilentScope[] {
  const { nowMs } = options;
  requireInt("now_ms", nowMs);
  const rows = connection
    .prepare<
      { now_ms: number },
      {
        scope_id: string;
        silent_for_ms: number;
        last_attempt_at_ms: number;
        last_result: string;
        expected_interval_ms: number;
        threshold_value: number;
      }
    >(
      `
            SELECT s.scope_id,
                   :now_ms - l.last_attempt_at_ms AS silent_for_ms,
                   l.last_attempt_at_ms,
                   l.last_result,
                   s.expected_interval_ms,
                   p.threshold_value
              FROM watcher_scope s
              JOIN watcher_liveness l ON l.scope_id = s.scope_id
              JOIN policy_detection_latency p
                ON p.incident_class = 'watcher_silence'
               AND p.revision_id = ${EFFECTIVE_REVISION_SQL}
             WHERE s.enabled = 1 AND s.retired_at_ms IS NULL
               AND p.threshold_kind = 'scope_interval_multiple'
               AND :now_ms - l.last_attempt_at_ms
                     > s.expected_interval_ms * p.threshold_value
             ORDER BY silent_for_ms DESC, s.scope_id
            `,
    )
    .all({ now_ms: nowMs });
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        scopeId: row.scope_id,
        silentForMs: Number(row.silent_for_ms),
        lastAttemptAtMs: Number(row.last_attempt_at_ms),
        lastResult: row.last_result,
        expectedIntervalMs: Number(row.expected_interval_ms),
        thresholdValue: Number(row.threshold_value),
      }),
    ),
  );
}

/** One row of {@link uncoveredScopes}'s projection. */
export interface UncoveredScope {
  readonly scopeId: string;
  readonly scopeKind: string;
  readonly repoId: string;
  readonly prId: string | null;
  readonly registeredAtMs: number;
}

/**
 * Live scopes with no liveness row at all -- the query a heartbeat table
 * alone cannot express.
 *
 * This is `relay_scan.py`'s lesson as a predicate. A scope nobody is
 * watching writes nothing, so every question asked of the trace alone
 * answers "fine"; only the roster can name the absence. There is no
 * `nowMs` because there is no waiting involved -- an enabled scope with no
 * trace is wrong the instant it exists, which is why
 * `watcher_scope_uncovered` carries `T = 0` in the seeded policy and why no
 * threshold is joined here.
 */
export function uncoveredScopes(connection: SqliteDatabase): readonly UncoveredScope[] {
  const rows = connection
    .prepare<
      [],
      {
        scope_id: string;
        scope_kind: string;
        repo_id: string;
        pr_id: string | null;
        registered_at_ms: number;
      }
    >(
      `
            SELECT s.scope_id, s.scope_kind, s.repo_id, s.pr_id, s.registered_at_ms
              FROM watcher_scope s
              LEFT JOIN watcher_liveness l ON l.scope_id = s.scope_id
             WHERE s.enabled = 1 AND s.retired_at_ms IS NULL
               AND l.scope_id IS NULL
             ORDER BY s.scope_id
            `,
    )
    .all();
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        scopeId: row.scope_id,
        scopeKind: row.scope_kind,
        repoId: row.repo_id,
        prId: row.pr_id,
        registeredAtMs: Number(row.registered_at_ms),
      }),
    ),
  );
}

/** One row of {@link errorStreakScopes}'s projection. */
export interface ErrorStreakScope {
  readonly scopeId: string;
  readonly consecutiveErrors: number;
  readonly lastError: string | null;
  readonly lastErrorAtMs: number | null;
  readonly lastSuccessAtMs: number | null;
  readonly thresholdValue: number;
}

/**
 * Live scopes that are attempting punctually and only ever failing.
 *
 * The third condition of section 8.4's closing paragraph, and a
 * **different incident class** from silence with a different remedy -- a
 * broken credential rather than a dead process. A watcher in this state is
 * invisible to {@link silentScopes} by construction, because it is
 * heartbeating on time; that is the whole reason `last_result` exists.
 *
 * `watcher_error_streak` carries `threshold_kind = 'consecutive_count'`:
 * `T` is a count and not a duration, and the comparison is `>=` because the
 * policy column's own comment defines the budget as running "from the
 * `threshold_value`-th consecutive failure" -- the fifth failure of a
 * five-count threshold is the one that opens the incident, not the sixth.
 */
export function errorStreakScopes(
  connection: SqliteDatabase,
  options: { readonly nowMs: number },
): readonly ErrorStreakScope[] {
  const { nowMs } = options;
  requireInt("now_ms", nowMs);
  const rows = connection
    .prepare<
      { now_ms: number },
      {
        scope_id: string;
        consecutive_errors: number;
        last_error: string | null;
        last_error_at_ms: number | null;
        last_success_at_ms: number | null;
        threshold_value: number;
      }
    >(
      `
            SELECT s.scope_id,
                   l.consecutive_errors,
                   l.last_error,
                   l.last_error_at_ms,
                   l.last_success_at_ms,
                   p.threshold_value
              FROM watcher_scope s
              JOIN watcher_liveness l ON l.scope_id = s.scope_id
              JOIN policy_detection_latency p
                ON p.incident_class = 'watcher_error_streak'
               AND p.revision_id = ${EFFECTIVE_REVISION_SQL}
             WHERE s.enabled = 1 AND s.retired_at_ms IS NULL
               AND p.threshold_kind = 'consecutive_count'
               AND l.consecutive_errors >= p.threshold_value
             ORDER BY l.consecutive_errors DESC, s.scope_id
            `,
    )
    .all({ now_ms: nowMs });
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        scopeId: row.scope_id,
        consecutiveErrors: Number(row.consecutive_errors),
        lastError: row.last_error,
        lastErrorAtMs: row.last_error_at_ms === null ? null : Number(row.last_error_at_ms),
        lastSuccessAtMs: row.last_success_at_ms === null ? null : Number(row.last_success_at_ms),
        thresholdValue: Number(row.threshold_value),
      }),
    ),
  );
}
