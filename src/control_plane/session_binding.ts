import type { Database as SqliteDatabase } from "better-sqlite3";

import {
  and_,
  effectKind,
  eq,
  fencedInsert,
  fencedUpdate,
  isNull,
  type Lease,
  ProtectedWrite,
  param,
  protectedWrite,
  value,
} from "./lease.js";

/**
 * The staged session<->run binding: item 2's durable record, phase by phase.
 *
 * Ported from interlock `src/claude_org_runtime/control_plane/session_binding.py`
 * at `65f36c5`.
 *
 * Gate item 2 (issue `#18`) injects kills around a commit-before-spawn ordering
 * (D-0024): the `--session-id` UUID is chosen and committed durably *before*
 * `claude -p` exists, the spawn is recorded, and the identity the provider
 * actually assigned is read back and committed -- exit 0 is never the evidence
 * (D-0027). This module owns the SQLite half of that walk and nothing else:
 *
 *     prepared            the identity is committed; no spawn attempted yet
 *     spawned             the provider was asked to start; identity unconfirmed
 *     identity_confirmed  the provider's own read-back named the committed id,
 *                         and the read-back is itself committed
 *
 * Every transition is a fenced write (`ACCEPTANCE.md` section 2): it carries
 * the lease epoch, validated atomically as part of the write, and a stale
 * writer's transition is refused and recorded rather than merged. The `session`
 * table has no `writer_epoch` column -- its partial unique index
 * (`session_one_active_binding_per_run`) is what makes "at most one active
 * binding per run" the database's rule -- so the fence decides *whether* the
 * row changes and the `action` rows record who wrote.
 *
 * What this module deliberately is not:
 *
 * - It is not the orchestration. Lease acquisition, spawning, read-back and
 *   crash recovery compose in `../supervisor.js`; this module never imports
 *   the session package (D-0009 -- the binding is control-plane state, and the
 *   provider must stay swappable under it).
 * - It is not an exclusion of its own. "At most one active binding" is the
 *   index's; "this writer may write" is the lease's. Nothing here consults
 *   liveness before writing -- expiry discovery alone is insufficient, per S6.
 */

export const PHASE_PREPARED = "prepared";
export const PHASE_SPAWNED = "spawned";
export const PHASE_IDENTITY_CONFIRMED = "identity_confirmed";

/**
 * The honest pre-spawn observation reasons. The schema requires an
 * `observation_reason` for every unobserved row (R4: "could not observe" is
 * never stored empty), and before the read-back these are the truthful words.
 */
export const REASON_PREPARED = "binding committed; spawn not yet attempted";
export const REASON_SPAWNED = "spawn requested; identity not yet read back";

const SELECT =
  "SELECT session_id, run_id, provider, binding_phase, observation," +
  " provider_state, observation_reason, bound_at_ms, released_at_ms" +
  " FROM session ";

/** One `session` row, read back as recovery reads it (D-0001). */
export class SessionBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly provider: string;
  readonly bindingPhase: string;
  readonly observation: string;
  readonly providerState: string | null;
  readonly observationReason: string | null;
  readonly boundAtMs: number;
  readonly releasedAtMs: number | null;

  constructor(fields: {
    readonly sessionId: string;
    readonly runId: string;
    readonly provider: string;
    readonly bindingPhase: string;
    readonly observation: string;
    readonly providerState: string | null;
    readonly observationReason: string | null;
    readonly boundAtMs: number;
    readonly releasedAtMs: number | null;
  }) {
    this.sessionId = fields.sessionId;
    this.runId = fields.runId;
    this.provider = fields.provider;
    this.bindingPhase = fields.bindingPhase;
    this.observation = fields.observation;
    this.providerState = fields.providerState;
    this.observationReason = fields.observationReason;
    this.boundAtMs = fields.boundAtMs;
    this.releasedAtMs = fields.releasedAtMs;
    Object.freeze(this);
  }
}

function bindingOf(row: Record<string, unknown>): SessionBinding {
  return new SessionBinding({
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    provider: String(row.provider),
    bindingPhase: String(row.binding_phase),
    observation: String(row.observation),
    providerState: row.provider_state === null ? null : String(row.provider_state),
    observationReason: row.observation_reason === null ? null : String(row.observation_reason),
    boundAtMs: Number(row.bound_at_ms),
    releasedAtMs: row.released_at_ms === null ? null : Number(row.released_at_ms),
  });
}

/**
 * Commit the session<->run binding *before* the process exists.
 *
 * This is the spawn-admission write: the orchestration layer spawns only
 * after this commit succeeds under a live token, so a claimant whose lease
 * was taken over is refused here -- durably, as an `action` row -- and never
 * becomes a process. A second active binding for the run is refused by
 * `session_one_active_binding_per_run` regardless of who asks.
 *
 * @throws {StaleWriterRefused} the token was not live; refusal recorded.
 */
export function prepareBinding(
  connection: SqliteDatabase,
  lease: Lease,
  options: {
    readonly sessionId: string;
    readonly runId: string;
    readonly provider: string;
    readonly nowMs: number;
    readonly attemptId?: string | null;
  },
): number {
  const { sessionId, runId, provider, nowMs, attemptId = null } = options;
  const statement = fencedInsert("session", {
    values: {
      session_id: param("session_id"),
      run_id: param("run_id"),
      provider: param("provider"),
      binding_phase: value(PHASE_PREPARED),
      observation: value("unobserved"),
      provider_state: value(null),
      observation_reason: value(REASON_PREPARED),
      bound_at_ms: param("now_ms"),
    },
    stampsWriterEpoch: false,
  });
  const write = new ProtectedWrite({
    kind: effectKind(lease.resource, "prepare_binding"),
    idempotencyKey: `prepare_binding:${sessionId}`,
    statement,
    // The admission and its record are the same row in the same transaction:
    // the one case where this mechanism is the truthful answer. The *spawn*
    // is a separate, later side effect -- its exactly-once story belongs to
    // the orchestration layer and is documented there, not claimed here.
    exactlyOnceMechanism: "transactional_with_record",
    params: { session_id: sessionId, run_id: runId, provider, now_ms: nowMs },
    runId,
  });
  return protectedWrite(connection, lease, write, { nowMs, attemptId });
}

/**
 * Record that the provider was asked to start the process.
 *
 * Matches only a `prepared`, still-active binding: a kill between the
 * admission commit and the spawn leaves the row honestly `prepared`, and
 * recovery reads that as "the spawn may or may not have been attempted"
 * rather than trusting this mark to exist.
 *
 * @throws {StaleWriterRefused} the token was not live; refusal recorded.
 * @throws {ProtectedWriteMissed} no active `prepared` binding to mark.
 */
export function markSpawned(
  connection: SqliteDatabase,
  lease: Lease,
  options: {
    readonly sessionId: string;
    readonly runId: string;
    readonly nowMs: number;
    readonly attemptId?: string | null;
  },
): number {
  const { sessionId, runId, nowMs, attemptId = null } = options;
  const statement = fencedUpdate("session", {
    set: {
      binding_phase: value(PHASE_SPAWNED),
      observation_reason: value(REASON_SPAWNED),
    },
    where: and_(
      eq("session_id", param("session_id")),
      eq("run_id", param("run_id")),
      eq("binding_phase", value(PHASE_PREPARED)),
      isNull("released_at_ms"),
    ),
    stampsWriterEpoch: false,
  });
  const write = new ProtectedWrite({
    kind: effectKind(lease.resource, "mark_spawned"),
    idempotencyKey: `mark_spawned:${sessionId}`,
    statement,
    exactlyOnceMechanism: "transactional_with_record",
    params: { session_id: sessionId, run_id: runId },
    runId,
  });
  return protectedWrite(connection, lease, write, { nowMs, attemptId });
}

/**
 * Commit the provider's own read-back of the identity.
 *
 * "After the read-back" -- the fourth injection point -- means after *this*
 * write commits, not after the provider's answer was merely seen in memory.
 * The caller passes the provider's uninterpreted state word; what it must
 * have already verified is that the read-back named the committed identity
 * (D-0027: never treat exit 0, or the binding's existence, as acceptance).
 *
 * @throws {StaleWriterRefused} the token was not live; refusal recorded.
 * @throws {ProtectedWriteMissed} no active `spawned` binding to confirm.
 */
export function confirmIdentity(
  connection: SqliteDatabase,
  lease: Lease,
  options: {
    readonly sessionId: string;
    readonly runId: string;
    readonly providerState: string;
    readonly nowMs: number;
    readonly attemptId?: string | null;
  },
): number {
  const { sessionId, runId, providerState, nowMs, attemptId = null } = options;
  const statement = fencedUpdate("session", {
    set: {
      binding_phase: value(PHASE_IDENTITY_CONFIRMED),
      observation: value("observed"),
      provider_state: param("provider_state"),
      observation_reason: value(null),
    },
    where: and_(
      eq("session_id", param("session_id")),
      eq("run_id", param("run_id")),
      eq("binding_phase", value(PHASE_SPAWNED)),
      isNull("released_at_ms"),
    ),
    stampsWriterEpoch: false,
  });
  const write = new ProtectedWrite({
    kind: effectKind(lease.resource, "confirm_identity"),
    idempotencyKey: `confirm_identity:${sessionId}`,
    statement,
    exactlyOnceMechanism: "transactional_with_record",
    params: { session_id: sessionId, run_id: runId, provider_state: providerState },
    runId,
  });
  return protectedWrite(connection, lease, write, { nowMs, attemptId });
}

/**
 * Release the binding, freeing the run for its next session.
 *
 * @throws {StaleWriterRefused} the token was not live; refusal recorded.
 * @throws {ProtectedWriteMissed} no active binding to release.
 */
export function releaseBinding(
  connection: SqliteDatabase,
  lease: Lease,
  options: {
    readonly sessionId: string;
    readonly runId: string;
    readonly nowMs: number;
    readonly attemptId?: string | null;
  },
): number {
  const { sessionId, runId, nowMs, attemptId = null } = options;
  const statement = fencedUpdate("session", {
    set: { released_at_ms: param("now_ms") },
    where: and_(
      eq("session_id", param("session_id")),
      eq("run_id", param("run_id")),
      isNull("released_at_ms"),
    ),
    stampsWriterEpoch: false,
  });
  const write = new ProtectedWrite({
    kind: effectKind(lease.resource, "release_binding"),
    idempotencyKey: `release_binding:${sessionId}`,
    statement,
    exactlyOnceMechanism: "transactional_with_record",
    params: { session_id: sessionId, run_id: runId, now_ms: nowMs },
    runId,
  });
  return protectedWrite(connection, lease, write, { nowMs, attemptId });
}

/**
 * The run's single active binding, or `undefined` -- recovery's first read.
 *
 * A pure read (D-0001: state is reconstructed by query). At most one row can
 * exist by the partial unique index; this function asserts that invariant
 * rather than silently taking the first of several.
 */
export function activeBinding(
  connection: SqliteDatabase,
  runId: string,
): SessionBinding | undefined {
  const rows = connection
    .prepare(`${SELECT}WHERE run_id = :run_id AND released_at_ms IS NULL`)
    .all({ run_id: runId }) as Record<string, unknown>[];
  if (rows.length > 1) {
    // The index makes this unreachable.
    throw new Error(
      `run ${JSON.stringify(runId)} has ${rows.length} active bindings; ` +
        "session_one_active_binding_per_run should have refused the second",
    );
  }
  return rows.length > 0 ? bindingOf(rows[0] as Record<string, unknown>) : undefined;
}

/** The binding row for one session id, released or not. A pure read. */
export function bindingForSession(
  connection: SqliteDatabase,
  sessionId: string,
): SessionBinding | undefined {
  const row = connection.prepare(`${SELECT}WHERE session_id = :session_id`).get({
    session_id: sessionId,
  }) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : bindingOf(row);
}
