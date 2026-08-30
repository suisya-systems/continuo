import { expect, test } from "vitest";

import { Observation, SessionReadout } from "../../src/session/provider.js";
import { PROVIDERS } from "./registry.js";

/**
 * The registry's two per-provider predicates, pinned.
 *
 * Ported from interlock `tests/gate_item11/test_registry_availability.py` at
 * `65f36c5`. `unavailable` decides whether a whole provider row runs on this
 * machine at all; `disqualified` decides whether the bound session's readout
 * proves the backend was really live. Both are the fixture package's own
 * knowledge -- the one place provider vocabulary is allowed to live.
 */

function observed(state: string, detail: Readonly<Record<string, unknown>> = {}): SessionReadout {
  return new SessionReadout({
    sessionId: "item11-bound-session",
    observation: Observation.OBSERVED,
    providerState: state,
    providerDetail: detail,
  });
}

test("every entry carries both predicates", () => {
  for (const entry of Object.values(PROVIDERS)) {
    expect(typeof entry.unavailable).toBe("function");
    expect(typeof entry.disqualified).toBe("function");
  }
});

test("S3 is available and qualified everywhere", () => {
  const entry = PROVIDERS.S3 as (typeof PROVIDERS)["S3"];
  expect(entry.unavailable()).toBeNull();
  expect(entry.disqualified(observed("working"))).toBeNull();
});

test("S2 disqualifies a child that died without ever speaking", () => {
  // A broken-but-present install answers every probe and still cannot run a
  // session: its child exits with the refusal on stderr and no structured
  // output. That readout must abort the bound run, not green it.
  const entry = PROVIDERS.S2 as (typeof PROVIDERS)["S2"];
  const reason = entry.disqualified(
    observed("exited-1", { stderr_tail: "Invalid API key. Please run /login" }),
  );
  expect(reason).not.toBeNull();
  expect(reason).toContain("Invalid API key");
});

test("S2 accepts any state the child itself reported", () => {
  const entry = PROVIDERS.S2 as (typeof PROVIDERS)["S2"];
  for (const state of ["hook_started", "init", "assistant", "completed", "api_error"]) {
    expect(entry.disqualified(observed(state))).toBeNull();
  }
  const quiet = new SessionReadout({
    sessionId: "item11-bound-session",
    observation: Observation.COULD_NOT_OBSERVE,
    couldNotObserveReason: "the child is running but has not emitted anything parseable yet",
  });
  expect(entry.disqualified(quiet)).toBeNull();
});
