import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Observation,
  type SessionProvider,
  type SessionReadout,
  StartRequest,
} from "../../../src/session/provider.js";
import { DEFAULT_PROVIDER, PROVIDERS, type ProviderEntry } from "../registry.js";
import { driveOnce, unwrap } from "../substitution.js";

/**
 * Bind a live `SessionProvider` before `test/control_plane`'s suite runs, and
 * change nothing else -- the "provider fixture" `test/gate_item11/suite-runs-
 * unchanged.test.ts` measures against.
 *
 * Ported from interlock `tests/gate_item11/provider_plugin.py` at `65f36c5`
 * (D-1002, the belt's declared follow-on named in D-1001).
 *
 * A vitest `globalSetup` module, not a pytest plugin loaded with `-p`: vitest
 * has no per-invocation plugin flag, so the same effect -- present for the
 * bound run, absent for the unbound one -- is reached by pointing each run at
 * its own subprocess environment instead (`suite-runs-unchanged.test.ts`
 * decides whether {@link PROVIDER_ENV} is set at all before spawning). Absent,
 * this module is inert -- the same "harmless when unset" contract the
 * source's own `outcome_recorder.py` documents -- which is what makes
 * `test_the_unbound_run_had_no_provider` mean something.
 *
 * Failures here are fail-closed (D-0010): a provider that cannot be probed or
 * cannot start a session throws, which aborts the whole run before a single
 * test file loads.
 */

/** Names the registry entry to bind. Absent means the plugin does nothing. */
export const PROVIDER_ENV = "CONTINUO_ITEM11_PROVIDER";

/** The role and session the binding is started for. Neither reaches the suite. */
const BOUND_ROLE = "worker";
const BOUND_SESSION_ID = "item11-bound-session";

/** How long to wait for the started session to become observable. Never fatal (R4/D-0006). */
const OBSERVE_TIMEOUT_MS = 10_000;

function selected(): ProviderEntry {
  const name = process.env[PROVIDER_ENV] ?? DEFAULT_PROVIDER;
  const entry = PROVIDERS[name];
  if (entry === undefined) {
    throw new Error(
      `${PROVIDER_ENV}=${JSON.stringify(name)} names no provider; known providers are ` +
        `${JSON.stringify(Object.keys(PROVIDERS).sort())}`,
    );
  }
  return entry;
}

/** Poll until the session reports a state, or return the last readout, whichever comes first. */
async function waitForReport(
  provider: SessionProvider,
  readout: SessionReadout,
  entry: ProviderEntry,
): Promise<SessionReadout> {
  // `performance.now()`, not `Date.now()`: monotonic, the same as the source's
  // own `time.monotonic()` -- a wall-clock deadline could be pushed arbitrarily
  // far out by a clock step during the poll.
  const deadline = performance.now() + OBSERVE_TIMEOUT_MS;
  let current = readout;
  while (current.observation === Observation.COULD_NOT_OBSERVE) {
    if (performance.now() >= deadline) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    current = unwrap(await provider.readState(current.sessionId), `${entry.id}.read_state`);
  }
  return current;
}

/** Say which provider the run was bound to, in the log CI keeps -- evidence, not decoration. */
function printHeader(
  entry: ProviderEntry,
  providerVersion: string,
  readout: SessionReadout,
  drove: string,
): void {
  const state = readout.providerState ?? readout.couldNotObserveReason;
  console.log(
    `gate item 11: control-plane suite bound to ${entry.scaffold} (${entry.issue}), ` +
      `version ${providerVersion}, live session ${readout.sessionId}=${String(state)}`,
  );
  console.log(`gate item 11: the provider drove the control plane -- ${drove}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env[PROVIDER_ENV] === undefined) {
    return async () => {
      // Nothing was bound; nothing to release.
    };
  }

  const entry = selected();
  const root = mkdtempSync(join(tmpdir(), "continuo-item11-"));
  let provider: SessionProvider | undefined;
  let readout: SessionReadout | undefined;

  const cleanup = async (): Promise<void> => {
    if (provider !== undefined && readout !== undefined) {
      await provider.stop(readout.sessionId).catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  };

  try {
    provider = entry.factory(join(root, "state"));
    const capabilities = provider.requireSpawnable();
    const started = unwrap(
      await provider.start(
        new StartRequest({
          sessionId: BOUND_SESSION_ID,
          workspace: join(root, "workspace"),
          role: BOUND_ROLE,
        }),
      ),
      `${entry.id}.start`,
    );
    readout = await waitForReport(provider, started, entry);
    const disqualification = entry.disqualified(readout);
    if (disqualification !== null) {
      // Fail closed (D-0010): a backend whose bound session already proves it
      // could not sustain one would make every comparison in the run's own
      // test file true of a measurement that measured nothing.
      throw new Error(`gate item 11: ${entry.id} failed qualification -- ${disqualification}`);
    }
    const drove = await driveOnce(provider, readout, { providerId: entry.id, root });
    printHeader(entry, capabilities.providerVersion, readout, drove);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return cleanup;
}
