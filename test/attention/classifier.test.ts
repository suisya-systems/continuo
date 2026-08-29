/**
 * Ported from interlock `tests/attention/test_classifier.py` at `65f36c5` -- 61 cases.
 *
 * **No case here names a fact state, and that absence is the point.** `D-0034` ratified that this
 * port must not invent the mapping from the source's eighteen `kind` values to the six fact
 * states, because interlock `Q-0012` -- what each state means -- is open upstream.
 *
 * `D-0903` met that by making the fact a required input every case supplied explicitly. `D-0906`
 * withdrew the shape: A3's pipeline found nothing in continuo can supply one, which is exactly the
 * observation `D-0903`'s falsifier named, so a caller could only have invented a value. Carrying
 * no fact satisfies the ratified constraint more simply than carrying one nobody can produce, and
 * these 61 cases are now plain translations of their source.
 *
 * The retargeted invariant `parity/source-inventory.belts.md` asked for -- every row of the fact
 * vocabulary having a pinned expectation -- is **not** re-derived here, and `D-0906` records why:
 * it presupposes a fact this subsystem does not carry, so there is nothing in this file for it to
 * be about. What survives is the vocabulary's own agreement across every place that states it,
 * which `test/contract/fact-state-vocabulary.test.ts` pins.
 */

import { describe, expect, test } from "vitest";

import * as classifier from "../../src/attention/classifier.js";
import { parametrize } from "../testkit/parametrize.js";

const NOW = new Date(Date.UTC(2026, 4, 12, 12, 0, 0));

/** The thresholds every source call passes positionally. */
const THRESHOLDS = { pendingDecisionMin: 15, userRepliedMin: 15 } as const;

/** The same, with the ladder's two keyword arguments spelled out as the source spells them. */
const LADDER = {
  pendingDecisionMin: 15,
  userRepliedMin: 15,
  pendingDecisionMax: 1440,
  pendingDecisionDrop: 10080,
} as const;

/**
 * The source's `_row`, with the one addition this port requires: a fact state, always given.
 *
 * No default. A default would be a one-row mapping from "the caller did not say" to a fact state,
 * which is the beginning of the table `D-0034` forbids.
 */
function row(fields: {
  id?: unknown;
  kind: unknown;
  payload?: Record<string, unknown>;
  actor?: string | null;
  occurredAt?: string;
}): classifier.EventRowInput {
  return {
    id: "id" in fields ? fields.id : 1,
    occurred_at: fields.occurredAt ?? "2026-05-12T11:30:00Z",
    actor: fields.actor ?? null,
    kind: fields.kind,
    payload: fields.payload ?? {},
  };
}

/** `(_NOW - timedelta(minutes=n)).isoformat().replace("+00:00", "Z")`. */
function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString().replace(/\.000Z$/, "Z");
}

/** The source's `_pending`: a pending entry whose `received_at` is N minutes ago. */
function pending(receivedAgoMin: number): classifier.PendingEntryInput {
  return {
    task_id: "ttl-task",
    received_at: minutesAgo(receivedAgoMin),
    raw_message: "should we ship?",
    status: "pending",
  };
}

/** The source's `_user_replied`: an escalated entry whose `user_replied_at` is N minutes ago. */
function userReplied(
  repliedAgoMin: number,
  extra: Record<string, unknown> = {},
): classifier.PendingEntryInput {
  return {
    task_id: "ttl-reply",
    received_at: "2026-05-01T00:00:00Z",
    raw_message: "go ahead",
    status: "escalated",
    user_replied_at: minutesAgo(repliedAgoMin),
    ...extra,
  };
}

/** The source's `_dup_row`, as the reader hands it over. */
function dupRow(
  options: { ts?: number; owner?: unknown; instances?: unknown } = {},
): classifier.JournalRowInput {
  return {
    ts: options.ts ?? 1000.0,
    owner: "owner" in options ? options.owner : "sec",
    instances: "instances" in options ? options.instances : ["b1", "a2"],
  };
}

/** The source's `_expired_row`. */
function expiredRow(
  options: { ts?: number; owner?: string; adoptionId?: string; restored?: boolean } = {},
): classifier.JournalRowInput {
  const restored = options.restored ?? true;
  return {
    ts: options.ts ?? 1000.0,
    event: "delivery_adopt_expired",
    owner: options.owner ?? "sec",
    adoption_id: options.adoptionId ?? "ad0011",
    armed_seconds: 300.0,
    lease_dropped: true,
    generation: 4,
    restored,
    restored_generation: restored ? 3 : null,
  };
}

/** The source's `_superseded_row`. */
function supersededRow(
  options: { ts?: number; owner?: string; instance?: string } = {},
): classifier.JournalRowInput {
  return {
    ts: options.ts ?? 1000.0,
    event: "delivery_register_superseded",
    owner: options.owner ?? "sec",
    instance: options.instance ?? "inst-old",
    state: "active",
    latched: true,
  };
}

describe("attention classifier", () => {
  // -- notify_sent subtypes ------------------------------------------------------------------

  test("notify_sent approval_blocked is urgent", () => {
    const event = classifier.classifyEvent(
      row({
        kind: "notify_sent",
        payload: { kind: "approval_blocked", task_id: "issue-19-20", worker: "worker-foo" },
      }),
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("approval_blocked");
    expect(event?.severity).toBe("urgent");
    expect(event?.taskId).toBe("issue-19-20");
    expect(event?.worker).toBe("worker-foo");
    expect(event?.key).toBe("event:1");
  });

  test("notify_sent relay_gap_suspected is normal", () => {
    // Anomaly-detector signals ride at `normal`.
    const event = classifier.classifyEvent(
      row({
        kind: "notify_sent",
        payload: { kind: "relay_gap_suspected", task_id: "T1" },
      }),
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("relay_gap_suspected");
    expect(event?.severity).toBe("normal");
  });

  test("notify_sent silent worker output is normal", () => {
    // A best-effort relay signal, demoted to `normal`.
    const event = classifier.classifyEvent(
      row({
        kind: "notify_sent",
        payload: { kind: "pane_output_without_peer_msg", worker: "wkr" },
      }),
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("silent_worker_output");
    expect(event?.severity).toBe("normal");
  });

  test("notify_sent with an unknown subkind is ignored", () => {
    expect(
      classifier.classifyEvent(row({ kind: "notify_sent", payload: { kind: "heartbeat" } })),
    ).toBeNull();
  });

  // -- ci_completed --------------------------------------------------------------------------

  parametrize(
    "ci_completed with a failing status is urgent",
    [
      ["failed", "failed"],
      ["canceled", "canceled"],
      ["incomplete", "incomplete"],
    ],
    (status: string) => {
      const event = classifier.classifyEvent(
        row({
          kind: "ci_completed",
          payload: { status, pr: 42, task_id: "ci-pr-42" },
        }),
      );

      expect(event).not.toBeNull();
      expect(event?.kind).toBe("ci_failed");
      expect(event?.severity).toBe("urgent");
      expect(event?.pr).toBe(42);
      expect(event?.status).toBe(status);
    },
  );

  test("ci_completed with a successful status is ignored", () => {
    expect(
      classifier.classifyEvent(
        row({
          kind: "ci_completed",
          payload: { status: "success", pr: 1 },
        }),
      ),
    ).toBeNull();
  });

  // -- worker_completed / pr_merged ----------------------------------------------------------

  test("worker_completed is normal", () => {
    const event = classifier.classifyEvent(
      row({
        kind: "worker_completed",
        payload: { task_id: "issue-19", worker: "worker-19" },
      }),
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("worker_completed");
    expect(event?.severity).toBe("normal");
  });

  test("pr_merged is normal", () => {
    const event = classifier.classifyEvent(
      row({
        kind: "pr_merged",
        payload: { pr: 7, task_id: "issue-7" },
      }),
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("pr_merged");
    expect(event?.severity).toBe("normal");
    expect(event?.pr).toBe(7);
  });

  // -- progress / unknown events -------------------------------------------------------------

  test("a progress or unknown event is ignored", () => {
    // The reader narrows the SELECT to relevant kinds, but if a stray row makes it through the
    // classifier must still ignore it.
    expect(classifier.classifyEvent(row({ kind: "heartbeat" }))).toBeNull();
    expect(classifier.classifyEvent(row({ kind: "anomaly_observed" }))).toBeNull();
  });

  // -- pending decisions ---------------------------------------------------------------------

  test("a stale pending decision is urgent", () => {
    const event = classifier.classifyPending(
      {
        task_id: "stuck-task",
        received_at: minutesAgo(20),
        raw_message: "should we split this PR?",
        status: "pending",
      },
      NOW,
      THRESHOLDS,
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("pending_decision");
    expect(event?.severity).toBe("urgent");
    expect(event?.taskId).toBe("stuck-task");
    expect(event?.key).toBe("pending:stuck-task:pending_decision");
  });

  test("a fresh pending decision is not urgent", () => {
    expect(
      classifier.classifyPending(
        {
          task_id: "fresh",
          received_at: minutesAgo(5),
          raw_message: "?",
          status: "pending",
        },
        NOW,
        THRESHOLDS,
      ),
    ).toBeNull();
  });

  // -- the pending_decision TTL ladder (min / max / drop) ------------------------------------

  test("pending decision TTL: below min produces no event", () => {
    expect(classifier.classifyPending(pending(5), NOW, LADDER)).toBeNull();
  });

  test("pending decision TTL: min to max is urgent", () => {
    // 60 min >= 15 (min) but well below 1440 (max).
    const event = classifier.classifyPending(pending(60), NOW, LADDER);

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("pending_decision");
    expect(event?.severity).toBe("urgent");
  });

  test("pending decision TTL: max to drop is demoted to normal", () => {
    // 1500 min (25h) > 1440 (max) but < 10080 (drop).
    const event = classifier.classifyPending(pending(1500), NOW, LADDER);

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("pending_decision");
    expect(event?.severity).toBe("normal");
  });

  test("pending decision TTL: above drop is suppressed for notify", () => {
    // The classifier surfaces the row so a triage listing can show it; the dispatcher is what
    // skips routing it to notify.
    const event = classifier.classifyPending(pending(11000), NOW, LADDER);

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("pending_decision");
    expect(event?.suppressed).toBe(true);
    // Dropped rows are de-escalated severity-wise; the `suppressed` marker is the real signal.
    expect(event?.severity).toBe("normal");
    expect(event?.toDict()["suppressed"]).toBe(true);
  });

  test("pending decision demotion respects a notify map override", () => {
    // Ops can pin `urgent` on a long-lived event class via config; the TTL ladder should not
    // silently override that intent.
    const event = classifier.classifyPending(pending(1500), NOW, {
      ...LADDER,
      notifyMap: { pending_decision: "urgent" },
    });

    expect(event).not.toBeNull();
    expect(event?.severity).toBe("urgent");
  });

  test("user reply TTL: below min produces no event", () => {
    expect(classifier.classifyPending(userReplied(5), NOW, LADDER)).toBeNull();
  });

  test("user reply TTL: min to max is urgent", () => {
    const event = classifier.classifyPending(userReplied(60), NOW, LADDER);

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("user_reply_not_forwarded");
    expect(event?.severity).toBe("urgent");
  });

  test("user reply TTL: max to drop is demoted to normal", () => {
    const event = classifier.classifyPending(userReplied(1500), NOW, LADDER);

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("user_reply_not_forwarded");
    expect(event?.severity).toBe("normal");
  });

  test("user reply TTL: above drop is suppressed for notify", () => {
    const event = classifier.classifyPending(userReplied(11000), NOW, LADDER);

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("user_reply_not_forwarded");
    expect(event?.suppressed).toBe(true);
    expect(event?.severity).toBe("normal");
  });

  test("user reply is skipped once the resolution is to_worker", () => {
    // Even if `status` lingers at `escalated` and `user_replied_at` is old, an explicit
    // `resolution_kind == "to_worker"` marker means the gap closed.
    expect(
      classifier.classifyPending(userReplied(60, { resolution_kind: "to_worker" }), NOW, LADDER),
    ).toBeNull();
  });

  test("user reply fires for other resolution kinds", () => {
    // Only `to_worker` indicates the relay actually completed; any other value (or a missing
    // field) leaves the gap open.
    const event = classifier.classifyPending(
      userReplied(60, { resolution_kind: "answered" }),
      NOW,
      LADDER,
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("user_reply_not_forwarded");
  });

  test("a user reply that was never forwarded is urgent", () => {
    const event = classifier.classifyPending(
      {
        task_id: "T2",
        received_at: "2026-05-12T10:00:00Z",
        raw_message: "?",
        status: "escalated",
        user_replied_at: minutesAgo(20),
      },
      NOW,
      THRESHOLDS,
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("user_reply_not_forwarded");
    expect(event?.severity).toBe("urgent");
    expect(event?.key).toBe("pending:T2:user_reply_not_forwarded");
  });

  test("a recent user reply produces no event", () => {
    expect(
      classifier.classifyPending(
        {
          task_id: "T2",
          received_at: "2026-05-12T10:00:00Z",
          raw_message: "?",
          status: "escalated",
          user_replied_at: minutesAgo(5),
        },
        NOW,
        THRESHOLDS,
      ),
    ).toBeNull();
  });

  test("a resolved pending entry is ignored", () => {
    expect(
      classifier.classifyPending(
        {
          task_id: "done",
          received_at: "2026-04-01T00:00:00Z", // very old
          raw_message: "?",
          status: "resolved",
          resolution_kind: "to_worker",
        },
        NOW,
        THRESHOLDS,
      ),
    ).toBeNull();
  });

  test("classifyAll combines its inputs", () => {
    const events = [
      row({ id: 10, kind: "worker_completed", payload: { task_id: "x" } }),
      row({
        id: 11,
        kind: "ci_completed",
        payload: { status: "failed", pr: 1 },
      }),
    ];
    const pendingEntries = [
      {
        task_id: "stuck",
        received_at: minutesAgo(30),
        raw_message: "?",
        status: "pending",
      },
    ];

    const out = classifier.classifyAll(events, pendingEntries, NOW, THRESHOLDS);

    expect(out.map((event) => event.kind)).toEqual([
      "worker_completed",
      "ci_failed",
      "pending_decision",
    ]);
  });

  test("the default title uses the bundled runtime text", () => {
    const event = classifier.classifyEvent(
      row({
        kind: "ci_completed",
        payload: { status: "failed", pr: 99, task_id: "x" },
      }),
    );

    expect(event).not.toBeNull();
    // When no template override is present, the classifier emits the bundled English default text
    // into title/body.
    expect(event?.title).toBe("CI failed");
    expect(event?.body).toContain("99");
  });

  test("a row with no id returns null", () => {
    expect(
      classifier.classifyEvent({
        occurred_at: "2026-05-12T11:30:00Z",
        actor: null,
        kind: "worker_completed",
        payload: {},
      }),
    ).toBeNull();
  });

  test("a pending entry with no task id returns null", () => {
    expect(
      classifier.classifyPending(
        {
          received_at: "2026-05-12T10:00:00Z",
          raw_message: "?",
          status: "pending",
        },
        NOW,
        THRESHOLDS,
      ),
    ).toBeNull();
  });

  // -- notify map severity override ----------------------------------------------------------

  test("a notify map override reaches the emitted event", () => {
    const event = classifier.classifyEvent(
      row({ kind: "worker_completed", payload: { task_id: "t" } }),
      { notifyMap: { worker_completed: "urgent" } },
    );

    expect(event).not.toBeNull();
    expect(event?.severity).toBe("urgent");
  });

  test("a notify map override reaches a pending event", () => {
    const event = classifier.classifyPending(
      {
        task_id: "T",
        received_at: minutesAgo(30),
        raw_message: "?",
        status: "pending",
      },
      NOW,
      { ...THRESHOLDS, notifyMap: { pending_decision: "normal" } },
    );

    expect(event).not.toBeNull();
    expect(event?.severity).toBe("normal");
  });

  test("an unknown notify map value falls back to the default", () => {
    // An invalid override is ignored -- design defaults stand.
    const event = classifier.classifyEvent(
      row({
        kind: "ci_completed",
        payload: { status: "failed", pr: 1 },
      }),
      { notifyMap: { ci_failed: "loud" } },
    );

    expect(event).not.toBeNull();
    expect(event?.severity).toBe("urgent"); // design default
  });

  // -- malformed timestamps ------------------------------------------------------------------

  test("a malformed received_at is treated as stale", () => {
    // Garbled timestamps must fire alerts, not hide them.
    const event = classifier.classifyPending(
      {
        task_id: "garbled",
        received_at: "not-a-real-timestamp",
        raw_message: "?",
        status: "pending",
      },
      NOW,
      THRESHOLDS,
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("pending_decision");
    expect(event?.severity).toBe("urgent");
  });

  test("a missing received_at is treated as stale", () => {
    const event = classifier.classifyPending(
      {
        task_id: "no-ts",
        raw_message: "?",
        status: "pending",
      },
      NOW,
      THRESHOLDS,
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("pending_decision");
  });

  // -- production notify_sent subkinds -------------------------------------------------------

  parametrize(
    "notify_sent production subkinds carry their severity",
    [
      ["pane_silent-pane_silent-normal", ["pane_silent", "pane_silent", "normal"]],
      ["pane_crashed-pane_crashed-urgent", ["pane_crashed", "pane_crashed", "urgent"]],
      ["worker_stalled-worker_stalled-normal", ["worker_stalled", "worker_stalled", "normal"]],
      [
        "worker_not_reported-worker_not_reported-normal",
        ["worker_not_reported", "worker_not_reported", "normal"],
      ],
      ["error-worker_error-normal", ["error", "worker_error", "normal"]],
    ] as const,
    ([subkind, expectedKind, expectedSeverity]) => {
      // A crashed pane is the only one a human has to look at right now; silent / stalled /
      // not-reported / generic-error are softer signals.
      const event = classifier.classifyEvent(
        row({
          kind: "notify_sent",
          payload: { kind: subkind, worker: "w1", task_id: "t1" },
        }),
      );

      expect(event).not.toBeNull();
      expect(event?.kind).toBe(expectedKind);
      expect(event?.severity).toBe(expectedSeverity);
    },
  );

  // -- secretary_awaiting_user ---------------------------------------------------------------

  test("the notify subkind table includes awaiting_user", () => {
    expect(classifier.NOTIFY_SUBKIND_TO_KIND["awaiting_user"]).toBe("secretary_awaiting_user");
  });

  test("notify_sent awaiting_user classifies as urgent", () => {
    // The secretary paused for the user -- "a human is the sole recovery path", so the kind joins
    // approval_blocked / pending_decision in the urgent tier by default.
    const event = classifier.classifyEvent(
      row({
        kind: "notify_sent",
        payload: { kind: "awaiting_user", task_id: "issue-28", worker: "secretary" },
      }),
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("secretary_awaiting_user");
    expect(event?.severity).toBe("urgent");
    expect(event?.taskId).toBe("issue-28");
  });

  test("the secretary_awaiting_user default text is non-empty", () => {
    const [title, body] = classifier.defaultText("secretary_awaiting_user", {
      taskId: "issue-28",
    });

    expect(title).toBeTruthy();
    expect(body).toBeTruthy();
    // The task id must reach the body -- it is the only identifying field on a paused-secretary
    // notification.
    expect(body).toContain("issue-28");
  });

  // -- duplicate_sidecar ---------------------------------------------------------------------

  test("duplicate_sidecar names the owner and both instances", () => {
    const event = classifier.classifyDuplicateSidecar(dupRow({}));

    expect(event.kind).toBe("duplicate_sidecar");
    expect(event.severity).toBe("urgent");
    expect(event.worker).toBe("sec");
    // Sorted, so the key does not depend on journal write order.
    expect(event.summary).toBe("a2, b1");
    expect(event.body).toContain("sec");
    expect(event.body).toContain("a2, b1");
    expect(event.title).toBe("Duplicate channel sidecar");
  });

  test("duplicate_sidecar is cooldown-gated rather than write-once", () => {
    // The source must stay out of the `state.db.events` dedup namespace, which records keys
    // forever; a live double sidecar has to keep re-alerting on the cooldown cadence.
    expect(classifier.classifyDuplicateSidecar(dupRow({})).source).toBe("broker.queue.jsonl");
  });

  test("the duplicate_sidecar key is per contesting pair", () => {
    const same = classifier.classifyDuplicateSidecar(dupRow({ instances: ["a", "b"] }));
    const reordered = classifier.classifyDuplicateSidecar(dupRow({ instances: ["b", "a"] }));
    const otherPair = classifier.classifyDuplicateSidecar(dupRow({ instances: ["a", "c"] }));
    const otherOwner = classifier.classifyDuplicateSidecar(
      dupRow({ owner: "w1", instances: ["a", "b"] }),
    );

    expect(same.key).toBe(reordered.key);
    expect(otherPair.key).not.toBe(same.key);
    expect(otherOwner.key).not.toBe(same.key);
  });

  test("a duplicate_sidecar ts becomes an ISO created_at", () => {
    const event = classifier.classifyDuplicateSidecar(dupRow({ ts: 1767225600.0 }));

    expect(event.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  test("duplicate_sidecar with malformed fields still notifies", () => {
    // A garbled field is not a reason to stay silent about a live pair.
    const event = classifier.classifyDuplicateSidecar({
      ts: 1.0,
      instances: "not-a-list",
    });

    expect(event.kind).toBe("duplicate_sidecar");
    expect(event.worker).toBeNull();
    expect(event.summary).toBeNull();
    expect(event.body).toContain("unknown");
    expect(event.key).toBe("broker:duplicate_sidecar:unknown:unknown");
  });

  test("a duplicate_sidecar severity override applies", () => {
    const event = classifier.classifyDuplicateSidecar(dupRow({}), {
      notifyMap: { duplicate_sidecar: "normal" },
    });

    expect(event.severity).toBe("normal");
  });

  test("classifyBrokerDuplicates collapses repeats per pair", () => {
    // The store re-journals a live pair once per lease window.
    const out = classifier.classifyBrokerDuplicates([
      dupRow({ ts: 1000.0, instances: ["a", "b"] }),
      dupRow({ ts: 1030.0, instances: ["a", "b"] }),
      dupRow({ ts: 1060.0, instances: ["a", "b"] }),
      dupRow({ ts: 1010.0, instances: ["a", "c"] }),
    ]);

    expect(out).toHaveLength(2);
    const bySummary = new Map(out.map((event) => [event.summary, event]));
    // The newest row wins for the repeated pair.
    expect(bySummary.get("a, b")?.createdAt).toBe(classifier.isoFromEpoch(1060.0));
    expect(new Set(bySummary.keys())).toEqual(new Set(["a, b", "a, c"]));
  });

  test("classifyAll appends broker duplicates", () => {
    const out = classifier.classifyAll([], [], NOW, {
      ...THRESHOLDS,
      brokerDuplicates: [dupRow({})],
    });

    expect(out.map((event) => event.kind)).toEqual(["duplicate_sidecar"]);
  });

  test("classifyAll without broker duplicates is unchanged", () => {
    const out = classifier.classifyAll(
      [row({ id: 1, kind: "worker_completed", payload: { task_id: "x" } })],
      [],
      NOW,
      THRESHOLDS,
    );

    expect(out.map((event) => event.kind)).toEqual(["worker_completed"]);
  });

  // -- delivery ownership --------------------------------------------------------------------

  test("delivery_adopt_expired names the adoption that failed", () => {
    // Issuing the observer secret is not the handover; if this row went unclassified, a failed
    // adopt would look exactly like a successful one from outside the daemon.
    const event = classifier.classifyDeliverySignal(expiredRow({ ts: 1767225600.0 }));

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("delivery_adopt_expired");
    expect(event?.severity).toBe("urgent");
    expect(event?.key).toBe("broker:delivery_adopt_expired:sec:ad0011");
    expect(event?.worker).toBe("sec");
    expect(event?.body).toContain("ad0011");
    // Cooldown-gated namespace, not the write-once `state.db.events` one.
    expect(event?.source).toBe("broker.queue.jsonl");
    // The journal writes epoch seconds; every other createdAt is ISO.
    expect(event?.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  test("the delivery_adopt_expired body separates restored from orphaned", () => {
    // `restored: true` means the previous session got its delivery back and only the handover was
    // lost; `restored: false` means no session is claiming the owner at all.
    const restored = classifier.classifyDeliverySignal(expiredRow({ restored: true }));
    const orphaned = classifier.classifyDeliverySignal(expiredRow({ restored: false }));

    expect(restored).not.toBeNull();
    expect(orphaned).not.toBeNull();
    expect(restored?.body).toContain("previous session restored");
    expect(orphaned?.body).toContain("no session is claiming this owner");
  });

  test("delivery_superseded keys on the instance that went mute", () => {
    // Keying on the owner alone would let the first session's cooldown swallow the report that a
    // replacement went mute too.
    const first = classifier.classifyDeliverySignal(supersededRow({ instance: "inst-a" }));
    const second = classifier.classifyDeliverySignal(supersededRow({ instance: "inst-b" }));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.kind).toBe("delivery_superseded");
    expect(first?.severity).toBe("urgent");
    expect(first?.key).toBe("broker:delivery_superseded:sec:inst-a");
    expect(first?.key).not.toBe(second?.key);
    expect(first?.body).toContain("inst-a");
  });

  test("an unrecognised delivery event is never invented into an alert", () => {
    // This classifier is fed a filtered slice of a shared journal. If an unknown name produced a
    // notification anyway, a version skew between the two halves would surface as urgent operator
    // noise about ordinary queue traffic.
    expect(
      classifier.classifyDeliverySignal({
        ts: 1.0,
        event: "duplicate_sidecar_detected",
        owner: "sec",
      }),
    ).toBeNull();
    expect(classifier.classifyDeliverySignal({ ts: 1.0, owner: "sec" })).toBeNull();

    const out = classifier.classifyBrokerDeliverySignals([
      { ts: 1.0, event: "lease_reaped", owner: "sec" },
      expiredRow({}),
    ]);

    expect(out.map((event) => event.kind)).toEqual(["delivery_adopt_expired"]);
  });

  test("a delivery signal with missing identifiers still notifies", () => {
    // Dropping the row would trade a slightly vague notification for no notification at all, and
    // these events never fire again.
    const expired = classifier.classifyDeliverySignal({
      ts: 1.0,
      event: "delivery_adopt_expired",
      restored: false,
    });

    expect(expired).not.toBeNull();
    expect(expired?.kind).toBe("delivery_adopt_expired");
    expect(expired?.worker).toBeNull();
    expect(expired?.key).toBe("broker:delivery_adopt_expired:unknown:unknown");
    expect(expired?.body).toContain("unknown");

    const superseded = classifier.classifyDeliverySignal({
      ts: 1.0,
      event: "delivery_register_superseded",
      owner: "   ",
    });

    expect(superseded).not.toBeNull();
    expect(superseded?.key).toBe("broker:delivery_superseded:unknown:unknown");
  });

  test("classifyBrokerDeliverySignals collapses repeats per incident", () => {
    // Both events are one-shot, so a repeat means a daemon restart replayed a journal. Emitting
    // one event per journal line would turn that into a burst of identical pages for one mute.
    const out = classifier.classifyBrokerDeliverySignals([
      expiredRow({ ts: 1000.0 }),
      expiredRow({ ts: 1060.0 }),
      expiredRow({ ts: 1030.0 }),
      supersededRow({ ts: 1010.0 }),
    ]);

    expect(out).toHaveLength(2);
    const byKind = new Map(out.map((event) => [event.kind, event]));
    expect(new Set(byKind.keys())).toEqual(
      new Set(["delivery_adopt_expired", "delivery_superseded"]),
    );
    expect(byKind.get("delivery_adopt_expired")?.createdAt).toBe(classifier.isoFromEpoch(1060.0));
  });

  test("classifyAll appends broker delivery signals", () => {
    // The classifier can be perfect and still notify nobody if `classifyAll` never folds the
    // signals in -- that gap is what left `duplicate_sidecar_detected` unconsumed for two issues.
    const out = classifier.classifyAll([], [], NOW, {
      ...THRESHOLDS,
      brokerDuplicates: [dupRow({})],
      brokerDeliverySignals: [expiredRow({}), supersededRow({})],
    });

    expect(out.map((event) => event.kind)).toEqual([
      "duplicate_sidecar",
      "delivery_adopt_expired",
      "delivery_superseded",
    ]);
  });

  test("classifyAll without delivery signals is unchanged", () => {
    // Callers that pre-date the new keyword keep working.
    const out = classifier.classifyAll(
      [row({ id: 1, kind: "worker_completed", payload: { task_id: "x" } })],
      [],
      NOW,
      THRESHOLDS,
    );

    expect(out.map((event) => event.kind)).toEqual(["worker_completed"]);
  });

  // -- target-only: the retargeted vocabulary invariant ---------------------------------------

  test("target-only -- an attention event cannot be rewritten after construction", () => {
    // The source's dataclass is `frozen=True`, enforced at runtime; `readonly` is erased at emit,
    // so without the freeze a plain JavaScript caller could downgrade a severity in place.
    const event = classifier.classifyDuplicateSidecar(dupRow({}));

    expect(() => {
      (event as { severity: string }).severity = "normal";
    }).toThrow(TypeError);
    expect(event.severity).toBe("urgent");
  });

  test("target-only -- a payload key that names an Object.prototype member is not a subkind", () => {
    // `docs/test-translation-conventions.md` rule 9: Python's `dict` has no inherited keys, so the
    // source's cases cannot construct this. An object-literal lookup table would answer
    // `constructor` with a function and classify a heartbeat as an attention event.
    for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(
        classifier.classifyEvent(row({ kind: "notify_sent", payload: { kind: inherited } })),
        `${inherited} was read off the prototype chain`,
      ).toBeNull();
    }
  });

  test("target-only -- a long summary is cut with Python's ellipsis and no trailing space", () => {
    // The source's 120-character truncation is reached by no case in either repository, and it has
    // two details a transcription loses silently: the cut character is U+2026 rather than three
    // dots, and the source `rstrip()`s before appending it so a cut landing after a space does not
    // leave one before the ellipsis. Pinned here because nothing else in the belt would notice.
    const message = `${"a".repeat(118)} tail`;
    const event = classifier.classifyPending(
      {
        task_id: "long",
        received_at: minutesAgo(60),
        raw_message: message,
        status: "pending",
      },
      NOW,
      THRESHOLDS,
    );

    expect(event?.summary).toBe(`${"a".repeat(118)}\u2026`);

    // The same cut, counted in code points rather than UTF-16 code units. `"\u{1f600}"` is two
    // units and one character, so a message of 119 emoji is UNDER the limit for Python and over it
    // for a `String#length` transcription -- which would additionally cut through a surrogate pair
    // and put a lone surrogate into text an operator reads.
    const emoji = "\u{1f600}".repeat(119);
    const astral = classifier.classifyPending(
      {
        task_id: "astral",
        received_at: minutesAgo(60),
        raw_message: emoji,
        status: "pending",
      },
      NOW,
      THRESHOLDS,
    );

    expect(astral?.summary, "the cut counted UTF-16 units instead of code points").toBe(emoji);
    expect(
      [...(astral?.summary ?? "")].every((point) => point === "\u{1f600}"),
      "the cut left an unpaired surrogate in operator-facing text",
    ).toBe(true);
  });

  test("target-only -- an ISO created_at keeps Python's fractional-second spelling", () => {
    // `Date#toISOString` always prints three fractional digits; `datetime.isoformat()` prints none
    // or six. The source's own case only reaches the zero-microsecond spelling, so without this
    // the six-digit branch could be deleted and every ported case would stay green.
    expect(classifier.isoFromEpoch(1767225600.5)).toBe("2026-01-01T00:00:00.500000Z");
    expect(classifier.isoFromEpoch(1767225600)).toBe("2026-01-01T00:00:00Z");
    expect(classifier.isoFromEpoch(true)).toBeNull();
    expect(classifier.isoFromEpoch("1767225600")).toBeNull();
    expect(classifier.isoFromEpoch(1e300)).toBeNull();
  });

  test("target-only -- a naive received_at is read as UTC, not as the runner's local time", () => {
    // `datetime.fromisoformat` returns a naive value that the source then attaches UTC to; `new
    // Date(...)` would read it as local time, so the same suite would land on different sides of
    // the 15-minute threshold depending on the runner's region.
    const event = classifier.classifyPending(
      {
        task_id: "naive",
        received_at: "2026-05-12T11:50:00", // 10 minutes before NOW, in UTC
        raw_message: "?",
        status: "pending",
      },
      NOW,
      THRESHOLDS,
    );

    expect(event, "a naive timestamp was not read as UTC").toBeNull();
  });

  test("target-only -- an out-of-range date is malformed rather than rolled forward", () => {
    // `Date.UTC(2026, 1, 30)` is 2 March; `fromisoformat` raises. Rolling forward would make a
    // typo look like a fresh entry and silence the alert the urgent posture exists to raise.
    const event = classifier.classifyPending(
      {
        task_id: "rolled",
        received_at: "2026-02-30T12:00:00Z",
        raw_message: "?",
        status: "pending",
      },
      NOW,
      THRESHOLDS,
    );

    expect(event?.severity, "an impossible date must read as stale, not as a real timestamp").toBe(
      "urgent",
    );

    // Two more values the grammar matches and `fromisoformat` refuses, both of which would
    // otherwise become real timestamps old enough for the drop tier to swallow: a year below
    // `datetime.MINYEAR`, and an offset the `timezone` constructor rejects for not being strictly
    // inside +/- 24 hours.
    for (const stamp of ["0000-01-01T00:00:00Z", "2026-01-01T00:00:00+24:00"]) {
      const outOfDomain = classifier.classifyPending(
        {
          task_id: "domain",
          received_at: stamp,
          raw_message: "?",
          status: "pending",
        },
        NOW,
        THRESHOLDS,
      );

      expect(outOfDomain?.severity, `${stamp} was accepted as a real timestamp`).toBe("urgent");
      expect(outOfDomain?.suppressed, `${stamp} fell into the drop tier`).toBe(false);
    }
  });

  test("target-only -- a non-finite pr does not take the classifier down", () => {
    // The source catches TypeError and ValueError, so `int(float("inf"))` -- an OverflowError --
    // escapes it. `JSON.parse` reaches the same value from `1e400`, so the hole is reachable in
    // this runtime too; D-0023 repairs it at the first belt that touches it.
    const event = classifier.classifyEvent(
      row({
        kind: "pr_merged",
        payload: { pr: JSON.parse("1e400") as number, task_id: "t" },
      }),
    );

    expect(event?.pr).toBeNull();

    // The other half of the same repair, and the half only this runtime has: Python's `int` is
    // arbitrary-precision, so a 400-digit `pr` string is an exact value there. Here `Number(text)`
    // reaches `Infinity`, which would render as `PR #Infinity` in an operator's notification.
    const huge = classifier.classifyEvent(
      row({
        kind: "pr_merged",
        payload: { pr: "9".repeat(400), task_id: "t" },
      }),
    );

    expect(
      huge?.pr,
      "a digit string past 2^53 became a number this runtime cannot carry",
    ).toBeNull();
    expect(huge?.body).toContain("unknown");
  });

  test("target-only -- an unknown kind falls back to the generic template", () => {
    // The source's `_DEFAULT_TEMPLATES.get(kind, ("Attention", "{kind} event"))` fallback is
    // reached by no ported case, and a lookup table built as an object literal would answer
    // `toString` with a function rather than taking the fallback at all.
    expect(classifier.defaultText("no-such-kind")).toEqual(["Attention", "no-such-kind event"]);
    expect(classifier.defaultText("toString")).toEqual(["Attention", "toString event"]);
  });
});
