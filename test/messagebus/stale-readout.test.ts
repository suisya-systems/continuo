import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  LocalProcessSessionProvider,
  Observation,
  Ok,
  StartRequest,
} from "../../src/session/index.js";
import { createTempDir } from "../helpers/tmp.js";
import { busEnvFactory, dropThenResendTranscript, expectedTranscript } from "./_env.js";

/**
 * S8 -- delivery outcomes are unchanged under a deliberately stale readout.
 *
 * Ported from interlock `tests/messagebus/test_stale_readout.py` at `65f36c5`.
 * The mapping is `parity/messagebus.stale-readout.ledger.json`.
 *
 * interlock's `ACCEPTANCE.md` item 6 words this case as "the UI attached but its
 * session state deliberately stale". Under C2 there is no UI, so the case is
 * translated rather than skipped (the issue is explicit about the difference):
 * the stale state is a **provider readout that is stale or wrong** -- a session
 * id whose child is gone, a `readState` that answers "could not observe" -- and
 * the assertion is that the delivery sequence records *exactly the same facts*
 * with that staleness present as it does with no session backend in the process
 * at all. Not similar facts: equal ones, compared over the object
 * `dropThenResendTranscript` returns.
 *
 * The provider driven stale here is the S3 stub, on purpose: item 6 is
 * deliberately buildable against the stub alone, which is itself the no-edge
 * property demonstrated -- a bus that cannot name a provider cannot care which
 * one is rotting next to it. It is a **real** child process, not a substituted
 * seam: a staleness nothing actually produced would make this case a comparison
 * of one transcript with itself.
 *
 * Vocabulary confinement (see `_env.ts`): this file knows the session backend
 * and reaches the control plane only through the suite's helpers, so no file in
 * this suite knows both vocabularies.
 */

/**
 * The source's `provider` fixture: a stub provider whose sessions are all
 * stopped at teardown.
 *
 * `stop` is awaited, not merely signalled: interlock D-0301 records that Node
 * releases a child's exit status only on an event-loop turn, so a teardown that
 * returns before the child is gone leaves a process holding handles inside a
 * directory the runner is about to remove.
 */
function stubProvider(root: string): LocalProcessSessionProvider {
  const provider = new LocalProcessSessionProvider(join(root, "sessions"));
  onTestFinished(async () => {
    const listed = await provider.listSessions();
    if (listed instanceof Ok) {
      for (const readout of listed.value) {
        await provider.stop(readout.sessionId);
      }
    }
  });
  return provider;
}

function workspace(root: string, name: string): string {
  return join(root, "workspaces", name);
}

describe("delivery is unchanged under a deliberately stale session readout", () => {
  test("delivery is unchanged when the session's child is gone", async () => {
    // First staleness: a session id whose child no longer exists.
    const root = createTempDir("stale-gone");
    const makeEnv = busEnvFactory("stale-gone-bus");
    const provider = stubProvider(root);

    const baseline = dropThenResendTranscript(makeEnv("baseline-gone"));

    const started = await provider.start(
      new StartRequest({
        sessionId: "worker-1",
        workspace: workspace(root, "worker-1"),
        role: "worker",
      }),
    );
    expect(started).toBeInstanceOf(Ok);
    await provider.stop("worker-1");
    const readout = await provider.readState("worker-1");
    // The staleness is real, not assumed: the roster still answers for the
    // session id, and what it reports is a child that is gone.
    expect(readout).toBeInstanceOf(Ok);
    if (!(readout instanceof Ok)) {
      return;
    }
    expect(readout.value.providerState).not.toBeNull();
    expect(readout.value.providerState?.startsWith("exited-")).toBe(true);

    const stale = dropThenResendTranscript(makeEnv("child-gone"));
    expect(stale).toEqual(baseline);
    expect(stale).toEqual(expectedTranscript());
  });

  test("delivery is unchanged when the state cannot be observed", async () => {
    // Second staleness: a state read that answers "could not observe".
    const root = createTempDir("stale-unobs");
    const makeEnv = busEnvFactory("stale-unobs-bus");
    const provider = stubProvider(root);

    const baseline = dropThenResendTranscript(makeEnv("baseline-unobs"));

    const started = await provider.start(
      new StartRequest({
        sessionId: "worker-2",
        workspace: workspace(root, "worker-2"),
        role: "worker",
        // The child announces its state only after this many seconds, so every
        // read below lands in the window where the session exists, the child
        // runs, and its state is unobservable.
        settings: { announce_after: 300 },
      }),
    );
    expect(started).toBeInstanceOf(Ok);
    const readout = await provider.readState("worker-2");
    expect(readout).toBeInstanceOf(Ok);
    if (!(readout instanceof Ok)) {
      return;
    }
    expect(readout.value.observation).toBe(Observation.COULD_NOT_OBSERVE);

    const stale = dropThenResendTranscript(makeEnv("could-not-observe"));
    expect(stale).toEqual(baseline);
    expect(stale).toEqual(expectedTranscript());

    // The staleness held for the whole delivery sequence, not just before it.
    const after = await provider.readState("worker-2");
    expect(after).toBeInstanceOf(Ok);
    if (!(after instanceof Ok)) {
      return;
    }
    expect(after.value.observation).toBe(Observation.COULD_NOT_OBSERVE);
  });
});
