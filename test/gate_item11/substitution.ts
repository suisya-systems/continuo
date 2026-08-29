import type { Database as SqliteDatabase } from "better-sqlite3";

import {
  effectKind,
  fencedInsert,
  type Lease,
  ProtectedWrite,
  param,
  protectedWrite,
} from "../../src/control_plane/lease.js";
import {
  Failure,
  Observation,
  Ok,
  type ProviderResult,
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
