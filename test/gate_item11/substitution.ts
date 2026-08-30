import { join } from "node:path";

import type { Database as SqliteDatabase } from "better-sqlite3";

import { KeyedDropbox } from "../../src/control_plane/destination.js";
import { NOTIFY_RECIPIENT, spikeRegistry } from "../../src/control_plane/handlers.js";
import {
  acquire,
  effectKind,
  fencedInsert,
  type Lease,
  ProtectedWrite,
  param,
  protectedWrite,
} from "../../src/control_plane/lease.js";
import { Outbox } from "../../src/control_plane/outbox.js";
import { createControlPlane, reconstruct } from "../../src/control_plane/schema.js";
import {
  Failure,
  Observation,
  Ok,
  type ProviderResult,
  type SessionProvider,
  type SessionReadout,
} from "../../src/session/provider.js";

/**
 * The whole of what a provider swap costs the control plane: this module.
 *
 * Ported from interlock `tests/gate_item11/substitution.py` at `65f36c5`.
 *
 * Item 11's claim is measured by *where the provider knowledge is*, not by an
 * assertion that there is none. This is the one file in this fixture package
 * that turns a provider's own words into a `session` row -- deliberately its
 * own translation, independent of `src/supervisor.ts`'s staged binding walk
 * (`src/control_plane/session_binding.ts`), so this proof stands on its own
 * rather than on the orchestrator's phase machine.
 *
 * Two translations, and both are provider-neutral:
 *
 * `Observation` to the `session.observation` word -- S1 spells R4's second
 * case `could-not-observe`; the schema's CHECK spells it `unobserved`. An
 * unrecognised observation falling through to "observed" would put back
 * exactly the collapse R4 records, in the one place nothing would see it.
 *
 * `SessionReadout` to a `session` row -- the schema splits the readout across
 * `provider_state` and `observation_reason` under a CHECK that refuses a row
 * carrying both or neither.
 */

/** S1's observation cases, spelled as the schema's CHECK spells them. */
export const OBSERVATION_WORD: ReadonlyMap<Observation, string> = new Map([
  [Observation.OBSERVED, "observed"],
  [Observation.COULD_NOT_OBSERVE, "unobserved"],
]);

/** The effect a session binding is recorded as in the write history. */
export const BIND_EFFECT = "bind_session";

/** The value of an `Ok`, or an `Error` naming the failure. */
export function unwrap<T>(result: ProviderResult<T>, what: string): T {
  if (Ok.is(result)) {
    return result.value as T;
  }
  if (Failure.is(result)) {
    throw new Error(`${what} failed: ${result.kind.value}: ${result.detail}`);
  }
  throw new Error(`${what} returned ${JSON.stringify(result)}, neither Ok nor Failure`);
}

/** One `session` row, from one provider readout. */
export function sessionRow(
  readout: SessionReadout,
  options: { readonly runId: string; readonly provider: string; readonly boundAtMs: number },
): Record<string, unknown> {
  const word = OBSERVATION_WORD.get(readout.observation);
  if (word === undefined) {
    throw new Error(
      `observation ${String(readout.observation)} has no S5 spelling; add one to ` +
        "OBSERVATION_WORD rather than letting it fall through -- an unrecognised " +
        "observation written as 'observed' is R4 again",
    );
  }
  return {
    session_id: readout.sessionId,
    run_id: options.runId,
    provider: options.provider,
    binding_phase: word === "observed" ? "identity_confirmed" : "spawned",
    observation: word,
    provider_state: readout.providerState,
    observation_reason: readout.couldNotObserveReason,
    bound_at_ms: options.boundAtMs,
  };
}

/** Persist the session<->run binding at spawn, under the fencing token. */
export function bindSession(
  connection: SqliteDatabase,
  lease: Lease,
  readout: SessionReadout,
  options: { readonly runId: string; readonly provider: string; readonly nowMs: number },
): number {
  const row = sessionRow(readout, {
    runId: options.runId,
    provider: options.provider,
    boundAtMs: options.nowMs,
  });
  const statement = fencedInsert("session", {
    values: {
      session_id: param("session_id"),
      run_id: param("run_id"),
      provider: param("provider"),
      binding_phase: param("binding_phase"),
      observation: param("observation"),
      provider_state: param("provider_state"),
      observation_reason: param("observation_reason"),
      bound_at_ms: param("bound_at_ms"),
    },
    stampsWriterEpoch: false,
  });
  const write = new ProtectedWrite({
    kind: effectKind(lease.resource, BIND_EFFECT),
    idempotencyKey: `${BIND_EFFECT}:${String(row.session_id)}`,
    statement,
    exactlyOnceMechanism: "transactional_with_record",
    params: row,
    runId: options.runId,
  });
  return protectedWrite(connection, lease, write, { nowMs: options.nowMs });
}

/** Mark a binding released, freeing the run for the next session. Unfenced on purpose. */
export function releaseSession(
  connection: SqliteDatabase,
  sessionId: string,
  options: { readonly releasedAtMs: number },
): void {
  connection
    .prepare("UPDATE session SET released_at_ms = ? WHERE session_id = ?")
    .run(options.releasedAtMs, sessionId);
}

// --------------------------------------------------------------------------
// One full round trip, used to qualify a provider before the suite runs
// (D-1002; source `drive_once`, used only by `support/provider-plugin.ts`).
// --------------------------------------------------------------------------

/** The fixed instant the round trip is dated at -- never the wall clock (see source). */
export const DRIVE_T0 = 1_700_000_000_000;
export const DRIVE_TTL_MS = 30_000;
export const DRIVE_RUN_ID = "item11-drive-run";
export const DRIVE_RESOURCE = "item11-drive-resource";
export const DRIVE_HOLDER = "item11-drive-writer";

/**
 * Run the control plane end to end with `readout`'s session as its subject.
 *
 * What makes `support/provider-plugin.ts`'s binding a measurement rather than
 * a coincidence: the provider's readout has to become a binding the schema
 * accepts, under a fencing token, with an outbox delivery on top -- so a
 * provider that cannot drive the control plane fails before the suite runs.
 *
 * Deliberately not a test: it throws rather than asserting, so a failure here
 * aborts the run (D-0010) instead of appearing as one red case among the
 * suite's own.
 *
 * @returns a one-line summary for the run header.
 */
export async function driveOnce(
  provider: SessionProvider,
  readout: SessionReadout,
  options: { readonly providerId: string; readonly root: string },
): Promise<string> {
  const { providerId, root } = options;
  const connection = createControlPlane(join(root, "drive-control-plane.sqlite3"));
  try {
    connection
      .prepare(
        "INSERT INTO run (run_id, status, created_at_ms, updated_at_ms) VALUES (?, 'running', ?, ?)",
      )
      .run(DRIVE_RUN_ID, DRIVE_T0, DRIVE_T0);
    const lease = acquire(connection, {
      resource: DRIVE_RESOURCE,
      holder: DRIVE_HOLDER,
      nowMs: DRIVE_T0,
      ttlMs: DRIVE_TTL_MS,
    });
    bindSession(connection, lease, readout, {
      runId: DRIVE_RUN_ID,
      provider: providerId,
      nowMs: DRIVE_T0,
    });

    // The provider's list verb has to agree that the session it just bound
    // exists. A binding written from a readout the provider no longer knows
    // about would be a row about nothing.
    const listed = new Set(
      unwrap(await provider.listSessions(), "list_sessions").map((row) => row.sessionId),
    );
    if (!listed.has(readout.sessionId)) {
      throw new Error(
        `${providerId} bound session ${readout.sessionId} is not in its own roster ` +
          `${JSON.stringify([...listed].sort())}`,
      );
    }

    const dropbox = new KeyedDropbox(join(root, "drive-destination"), "item11-drive-dropbox");
    const outbox = new Outbox(connection, {
      resource: DRIVE_RESOURCE,
      holder: DRIVE_HOLDER,
      registry: spikeRegistry(dropbox),
    });
    outbox.enqueue({
      messageId: "item11-drive-msg",
      recipient: NOTIFY_RECIPIENT,
      payload: `{"session":"${readout.sessionId}"}`,
      dedupKey: `item11-drive:${readout.sessionId}`,
      nowMs: DRIVE_T0,
      epoch: lease.epoch,
      runId: DRIVE_RUN_ID,
    });
    const attempt = outbox.attempt("item11-drive-msg", { nowMs: DRIVE_T0 + 1, epoch: lease.epoch });
    if (!outbox.recordAck("item11-drive-msg", { nowMs: DRIVE_T0 + 2 }).recorded) {
      throw new Error("the delivery was never acked");
    }
    if (dropbox.effectCount(attempt.idempotencyKey) !== 1) {
      throw new Error(
        `the destination applied ${dropbox.effectCount(attempt.idempotencyKey)} effects, not one`,
      );
    }

    const state = reconstruct(connection, DRIVE_T0 + 3);
    const bound = state.activeSessions.map((row) => row["session_id"]);
    if (bound.length !== 1 || bound[0] !== readout.sessionId) {
      throw new Error(`active sessions are ${JSON.stringify(bound)}, not [${readout.sessionId}]`);
    }
    const row = state.activeSessions[0] as Record<string, unknown>;
    return (
      `bound ${String(row["session_id"])} to ${String(row["run_id"])} as ${String(row["observation"])}` +
      `/${String(row["provider_state"] ?? row["observation_reason"])} under epoch ` +
      `${lease.epoch}, one effect delivered and acked`
    );
  } finally {
    connection.close();
  }
}
