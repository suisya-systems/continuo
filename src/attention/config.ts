/**
 * The attention watcher's configuration module -- **the A1 slice of it only**.
 *
 * Belt note, carried here so the next reader does not have to reconstruct it: the attention
 * subsystem ports in three sub-belts sharing one D-range (`D-0034`). This file exists because
 * `classifier.ts` -- A1's subject -- imports `DEFAULT_NOTIFY` from the source's `config.py`, so
 * A1 cannot land without it. What is here is the minimum seam that lets the classifier resolve a
 * severity; **the config belt itself (`tests/attention/test_config.py`, 34 cases:
 * `AttentionConfig`, the loader, `Template`, the placeholder allowlist, the sound modes) is A2's
 * to port**, and A2 fills this file in rather than replacing it. `D-0902` records the split.
 *
 * Nothing in A1 reads a config *file*. `DEFAULT_NOTIFY` is a constant, and the only other name
 * here is the severity type it is keyed by.
 */

/** interlock `config.Severity`: the two levels a notification can carry. */
export type Severity = "urgent" | "normal";

/**
 * Default severity per attention kind, carried from interlock's `config.py` unchanged.
 *
 * interlock's own comment is the reason the table looks lopsided, and it is worth keeping: after
 * its Issue #26 Part B rebalance only "a human is the sole recovery path" events stay `urgent`.
 * The anomaly-detector kinds (`relay_gap_suspected`, `silent_worker_output`, `pane_silent`,
 * `worker_stalled`, `worker_not_reported`, `worker_error`) are best-effort signals that often
 * self-resolve, so they ride at `normal` to avoid alert fatigue. The three broker-journal kinds
 * (`duplicate_sidecar`, `delivery_superseded`, `delivery_adopt_expired`) are `urgent` despite
 * that rebalance because nothing in the runtime resolves any of them.
 *
 * Built with `Object.create(null)` and read with `Object.hasOwn`, per
 * `docs/test-translation-conventions.md` rule 9: the kind is a caller-supplied string used as a
 * map key, and Python's `dict` has no inherited keys where an object literal carries
 * `Object.prototype`. A kind named `constructor` would otherwise read an inherited value and
 * resolve to a severity nobody wrote.
 */
export const DEFAULT_NOTIFY: Readonly<Record<string, Severity>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, Severity>, {
    approval_blocked: "urgent",
    relay_gap_suspected: "normal",
    silent_worker_output: "normal",
    ci_failed: "urgent",
    pending_decision: "urgent",
    user_reply_not_forwarded: "urgent",
    pane_silent: "normal",
    pane_crashed: "urgent",
    worker_stalled: "normal",
    worker_not_reported: "normal",
    worker_error: "normal",
    worker_completed: "normal",
    pr_merged: "normal",
    secretary_awaiting_user: "urgent",
    duplicate_sidecar: "urgent",
    delivery_superseded: "urgent",
    delivery_adopt_expired: "urgent",
  } satisfies Record<string, Severity>),
);
