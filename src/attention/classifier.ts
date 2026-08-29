/**
 * Pure classifier: events / pending -> {@link AttentionEvent}.
 *
 * No I/O, no subprocesses. Given the rows returned by `readers.ts`, this module produces a
 * deterministic list of {@link AttentionEvent} records that downstream code can consume.
 *
 * Ported from interlock `claude_org_runtime/attention/classifier.py` at `65f36c5`, **retargeted**:
 * every row this module classifies arrives carrying a {@link FactState}, and the event it
 * produces carries that same fact **uninterpreted**. There is no table here from an attention
 * `kind` to a fact state and there is not meant to be one. interlock `Q-0012` -- what each fact
 * state means, and when it holds -- is open; a port that invented the mapping would be answering
 * it in code, and `D-0034` ratified that this belt does not. The caller says which fact it
 * observed, exactly as `SessionReadout` carries a provider's own lifecycle word without
 * converting it (`D-0021`, `D-0302`). `D-0903` records the shape and what falsifies it.
 *
 * Importing `readers.ts` here is for its journal **event-name constants** only, never its loaders
 * -- this module stays pure. Sharing the names is what keeps the filter and the classifier from
 * drifting apart (a reader that surfaces a row the classifier silently drops is exactly the kind
 * of quiet gap this feature exists to close). No cycle: `readers.ts` imports nothing from here.
 */

import { getOwn, pyOr, pyStr, pyStrip, pyTruthy } from "../fencing/pysemantics.js";
import { DEFAULT_NOTIFY, type Severity } from "./config.js";
import type { FactState } from "./fact_state.js";
import { DELIVERY_ADOPT_EXPIRED_EVENT, DELIVERY_SUPERSEDED_EVENT } from "./readers.js";

/**
 * `events.kind='notify_sent'` carries a payload `kind` naming the specific notification subtype.
 * The table maps those subtypes to the attention-layer kind used downstream. Any unknown subtype
 * is intentionally ignored so duplicate/progress-only `notify_sent` rows do not produce attention
 * spam.
 *
 * `Object.create(null)` + `getOwn`, per `docs/test-translation-conventions.md` rule 9: the subtype
 * is a payload-supplied string used as a map key, and a payload whose `kind` is `constructor`
 * would otherwise read an inherited value off `Object.prototype` and classify as something
 * nobody wrote.
 */
export const NOTIFY_SUBKIND_TO_KIND: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    approval_blocked: "approval_blocked",
    relay_gap_suspected: "relay_gap_suspected",
    pane_output_without_peer_msg: "silent_worker_output",
    pane_silent: "pane_silent",
    pane_crashed: "pane_crashed",
    worker_stalled: "worker_stalled",
    worker_not_reported: "worker_not_reported",
    error: "worker_error",
    awaiting_user: "secretary_awaiting_user",
  }),
);

/** CI run statuses that classify as a failure. */
const CI_FAIL_STATUSES: readonly string[] = Object.freeze(["failed", "canceled", "incomplete"]);

/**
 * Dedup namespace for the broker-journal path. Anything that is not `state.db.events` is
 * cooldown-gated rather than recorded once forever -- which is what these signals want, since a
 * double sidecar that is still live should keep re-alerting on a slow cadence instead of going
 * quiet after the first ping.
 */
export const BROKER_JOURNAL_SOURCE = "broker.queue.jsonl";

/** The `events.db` dedup namespace, which is recorded once and never re-alerted. */
const EVENTS_SOURCE = "state.db.events";

/** The `pending_decisions.json` namespace. */
const PENDING_SOURCE = "pending_decisions";

/**
 * Anything this module classifies arrives with the fact the detector layer observed.
 *
 * Required, not optional, and never defaulted. An optional field would need a fallback, and the
 * only fallback available is a mapping from the row's own shape to a fact state -- which is the
 * table `D-0034` forbids this belt from inventing. Requiring it puts the decision back where it
 * was made and makes a caller that has not made one a compile error rather than a silent guess.
 */
export interface FactBearing {
  readonly factState: FactState;
}

/** One `events` row, as the classifier consumes it. */
export type EventRowInput = FactBearing & {
  readonly id?: unknown;
  readonly occurred_at?: unknown;
  readonly actor?: unknown;
  readonly kind?: unknown;
  readonly payload?: unknown;
};

/** One `pending_decisions.json` entry, as the classifier consumes it. */
export type PendingEntryInput = FactBearing & Readonly<Record<string, unknown>>;

/** One broker-journal row, as the classifier consumes it. */
export type JournalRowInput = FactBearing & Readonly<Record<string, unknown>>;

/** Severity overrides, keyed by attention kind. */
export type NotifyMap = Readonly<Record<string, string>>;

/**
 * One normalized attention record.
 *
 * `key` is the stable dedup identity. `title` / `body` hold the runtime-default English copy.
 *
 * `suppressed` is the "age >= drop" marker: the classifier still emits the record so triage tools
 * can list it, but a dispatcher must NOT route it to notify -- no desktop notification, no bell,
 * no dedup-state update.
 *
 * `factState` is the fact the row arrived with, carried through unchanged. Nothing in this class
 * reads it or branches on it; it is data in transit, and that is the whole of its contract here.
 */
export class AttentionEvent {
  readonly key: string;
  readonly kind: string;
  readonly severity: Severity;
  readonly title: string;
  readonly body: string;
  readonly source: string;
  readonly factState: FactState;
  readonly taskId: string | null;
  readonly worker: string | null;
  readonly pr: number | null;
  readonly status: string | null;
  readonly summary: string | null;
  readonly createdAt: string | null;
  readonly suppressed: boolean;

  constructor(fields: {
    key: string;
    kind: string;
    severity: Severity;
    title: string;
    body: string;
    source: string;
    factState: FactState;
    taskId?: string | null;
    worker?: string | null;
    pr?: number | null;
    status?: string | null;
    summary?: string | null;
    createdAt?: string | null;
    suppressed?: boolean;
  }) {
    this.key = fields.key;
    this.kind = fields.kind;
    this.severity = fields.severity;
    this.title = fields.title;
    this.body = fields.body;
    this.source = fields.source;
    this.factState = fields.factState;
    this.taskId = fields.taskId ?? null;
    this.worker = fields.worker ?? null;
    this.pr = fields.pr ?? null;
    this.status = fields.status ?? null;
    this.summary = fields.summary ?? null;
    this.createdAt = fields.createdAt ?? null;
    this.suppressed = fields.suppressed ?? false;
    // `frozen=True` on the source's dataclass is enforced at runtime, and `readonly` here is not:
    // it is erased at emit, so a plain JavaScript caller could rewrite `severity` after the fact.
    // The session belt found the same gap for `Enum` and `frozenset` and closed it the same way.
    Object.freeze(this);
  }

  /**
   * The source's `to_dict()`: wire-shaped, snake_case, and omitting every field that is `None`.
   *
   * `fact_state` is always present, because it is always set -- the same reason `key` and `kind`
   * are unconditional rather than in the optional loop.
   */
  toDict(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      key: this.key,
      kind: this.kind,
      severity: this.severity,
      title: this.title,
      body: this.body,
      source: this.source,
      fact_state: this.factState,
    };
    const optional: [string, string | number | null][] = [
      ["task_id", this.taskId],
      ["worker", this.worker],
      ["pr", this.pr],
      ["status", this.status],
      ["summary", this.summary],
      ["created_at", this.createdAt],
    ];
    for (const [name, value] of optional) {
      if (value !== null) {
        out[name] = value;
      }
    }
    if (this.suppressed) {
      out["suppressed"] = true;
    }
    return out;
  }
}

/**
 * Map one `events` row to an {@link AttentionEvent} or `null`.
 *
 * Returns `null` for rows that should not produce a notification (e.g. `ci_completed
 * status=success`, an unrecognized `notify_sent.kind`). `notifyMap` overrides the default
 * severity-per-kind table; missing keys fall back to the default.
 */
export function classifyEvent(
  row: EventRowInput,
  options: { notifyMap?: NotifyMap | null } = {},
): AttentionEvent | null {
  const notifyMap = options.notifyMap ?? null;
  const kind = row.kind;
  const payload = pyOr(row.payload, {}) as Record<string, unknown>;
  const eventId = row.id;
  if (eventId === undefined || eventId === null) {
    return null;
  }
  const key = `event:${pyStr(eventId)}`;
  const taskId = strOrNone(pyOr(getOwn(payload, "task_id"), getOwn(payload, "task")));
  const worker = strOrNone(pyOr(getOwn(payload, "worker"), row.actor));
  const pr = coerceInt(getOwn(payload, "pr"));
  const occurredAt = strOrNone(row.occurred_at);
  const factState = row.factState;

  if (kind === "notify_sent") {
    const sub = pyStr(pyOr(getOwn(payload, "kind"), ""));
    const attentionKind = getOwn(NOTIFY_SUBKIND_TO_KIND, sub);
    if (attentionKind === undefined) {
      return null;
    }
    const [title, body] = defaultText(attentionKind as string, { taskId, worker, pr });
    return new AttentionEvent({
      key,
      kind: attentionKind as string,
      severity: severityFor(attentionKind as string, notifyMap),
      title,
      body,
      source: EVENTS_SOURCE,
      factState,
      taskId,
      worker,
      pr,
      createdAt: occurredAt,
    });
  }

  if (kind === "ci_completed") {
    const status = pyStr(pyOr(getOwn(payload, "status"), ""));
    if (!CI_FAIL_STATUSES.includes(status)) {
      return null;
    }
    const [title, body] = defaultText("ci_failed", { taskId, worker, pr, status });
    return new AttentionEvent({
      key,
      kind: "ci_failed",
      severity: severityFor("ci_failed", notifyMap),
      title,
      body,
      source: EVENTS_SOURCE,
      factState,
      taskId,
      worker,
      pr,
      status,
      createdAt: occurredAt,
    });
  }

  if (kind === "worker_completed" || kind === "pr_merged") {
    const [title, body] = defaultText(kind, { taskId, worker, pr });
    return new AttentionEvent({
      key,
      kind,
      severity: severityFor(kind, notifyMap),
      title,
      body,
      source: EVENTS_SOURCE,
      factState,
      taskId,
      worker,
      pr,
      createdAt: occurredAt,
    });
  }

  return null;
}

/** The thresholds `classifyPending` reads, named as the source names them. */
export interface PendingThresholds {
  readonly pendingDecisionMin: number;
  readonly userRepliedMin: number;
  readonly pendingDecisionMax?: number;
  readonly pendingDecisionDrop?: number;
  readonly notifyMap?: NotifyMap | null;
}

/** The source's defaults, which mirror `AttentionConfig`'s. */
const PENDING_DECISION_MAX_DEFAULT = 1440;
const PENDING_DECISION_DROP_DEFAULT = 10080;

/**
 * Map a `pending_decisions.json` entry to an {@link AttentionEvent}.
 *
 * Two attention paths:
 *
 * - `status === "pending"` -> `pending_decision`, with the TTL ladder (clock starts at
 *   `received_at`): below `pendingDecisionMin` no event; `min <= age < max` urgent; `max <= age <
 *   drop` demoted to `normal`; `age >= drop` still emitted but `suppressed`.
 * - `status === "escalated"` (the Secretary told the user) but the `user_replied_at` mark predates
 *   any `to_worker` resolution -> `user_reply_not_forwarded`, on the same ladder with
 *   `user_replied_at` as the clock.
 */
export function classifyPending(
  entry: PendingEntryInput,
  now: Date,
  thresholds: PendingThresholds,
): AttentionEvent | null {
  const notifyMap = thresholds.notifyMap ?? null;
  const max = thresholds.pendingDecisionMax ?? PENDING_DECISION_MAX_DEFAULT;
  const drop = thresholds.pendingDecisionDrop ?? PENDING_DECISION_DROP_DEFAULT;
  const status = getOwn(entry, "status");
  const taskId = strOrNone(getOwn(entry, "task_id"));
  const rawMessage = getOwn(entry, "raw_message");
  const receivedAt = strOrNone(getOwn(entry, "received_at"));
  const userRepliedAt = getOwn(entry, "user_replied_at");
  const factState = entry.factState;
  if (taskId === null) {
    return null;
  }

  if (status === "pending") {
    const age = minutesSince(getOwn(entry, "received_at"), now);
    const ladder = ttlLadder(age, thresholds.pendingDecisionMin, max, drop);
    if (ladder !== null) {
      const [title, body] = defaultText("pending_decision", { taskId });
      return new AttentionEvent({
        key: `pending:${taskId}:pending_decision`,
        kind: "pending_decision",
        severity: severityFor("pending_decision", notifyMap, {
          demote: ladder === "demote" || ladder === "drop",
        }),
        title,
        body,
        source: PENDING_SOURCE,
        factState,
        taskId,
        summary: shortSummary(rawMessage),
        createdAt: receivedAt,
        suppressed: ladder === "drop",
      });
    }
  }

  if (
    status === "escalated" &&
    pyTruthy(userRepliedAt) &&
    getOwn(entry, "resolution_kind") !== "to_worker"
  ) {
    const age = minutesSince(userRepliedAt, now);
    const ladder = ttlLadder(age, thresholds.userRepliedMin, max, drop);
    if (ladder !== null) {
      const [title, body] = defaultText("user_reply_not_forwarded", { taskId });
      return new AttentionEvent({
        key: `pending:${taskId}:user_reply_not_forwarded`,
        kind: "user_reply_not_forwarded",
        severity: severityFor("user_reply_not_forwarded", notifyMap, {
          demote: ladder === "demote" || ladder === "drop",
        }),
        title,
        body,
        source: PENDING_SOURCE,
        factState,
        taskId,
        summary: shortSummary(rawMessage),
        createdAt: strOrNone(userRepliedAt),
        suppressed: ladder === "drop",
      });
    }
  }

  return null;
}

/**
 * Map one `duplicate_sidecar_detected` journal row to an event.
 *
 * Never returns `null`: unlike the `events` table, every row the reader hands over is already the
 * event of interest. A row with a missing or garbled `owner` / `instances` still notifies (with
 * `unknown` in place of the missing part) rather than being dropped -- a malformed field is not a
 * reason to stay silent about a live double-claimer.
 */
export function classifyDuplicateSidecar(
  record: JournalRowInput,
  options: { notifyMap?: NotifyMap | null } = {},
): AttentionEvent {
  const notifyMap = options.notifyMap ?? null;
  const owner = strOrNone(getOwn(record, "owner"));
  const instances = instanceIds(getOwn(record, "instances"));
  // Key on the contesting pair, not just the owner: when the operator kills one session and a
  // DIFFERENT instance takes its place, that is a new incident and must not be swallowed by the
  // cooldown of the previous pair.
  const key =
    `broker:duplicate_sidecar:${owner ?? "unknown"}` + `:${instances.join("+") || "unknown"}`;
  const summary = instances.join(", ") || null;
  const [title, body] = defaultText("duplicate_sidecar", { worker: owner, summary });
  return new AttentionEvent({
    key,
    kind: "duplicate_sidecar",
    severity: severityFor("duplicate_sidecar", notifyMap),
    title,
    body,
    source: BROKER_JOURNAL_SOURCE,
    factState: record.factState,
    worker: owner,
    summary,
    createdAt: isoFromEpoch(getOwn(record, "ts")),
  });
}

/**
 * Classify broker-journal duplicate rows, one event per contesting pair.
 *
 * The store re-journals a live duplicate once per lease window, so a single scan usually sees the
 * same `(owner, pair)` several times. Collapsing on {@link AttentionEvent.key} here -- keeping the
 * most recent row -- means one notification per incident per scan instead of one per journal line.
 */
export function classifyBrokerDuplicates(
  records: Iterable<JournalRowInput>,
  options: { notifyMap?: NotifyMap | null } = {},
): AttentionEvent[] {
  const latest = new Map<string, [number, AttentionEvent]>();
  for (const record of records) {
    const event = classifyDuplicateSidecar(record, options);
    const ts = epochOrNone(getOwn(record, "ts")) ?? 0;
    const previous = latest.get(event.key);
    if (previous === undefined || ts >= previous[0]) {
      latest.set(event.key, [ts, event]);
    }
  }
  return [...latest.values()].map(([, event]) => event);
}

/**
 * Map one delivery-ownership journal row to an event, or `null`.
 *
 * Returns `null` for an unrecognised `event` rather than notifying: unlike the duplicate-sidecar
 * reader, this one filters two names out of a shared journal, so a third name arriving here means
 * the reader and the classifier disagree -- inventing a notification for it would turn a version
 * skew into operator noise.
 */
export function classifyDeliverySignal(
  record: JournalRowInput,
  options: { notifyMap?: NotifyMap | null } = {},
): AttentionEvent | null {
  const notifyMap = options.notifyMap ?? null;
  const event = strOrNone(getOwn(record, "event"));
  const owner = strOrNone(getOwn(record, "owner"));
  let summary: string;
  let key: string;
  let kind: string;
  if (event === DELIVERY_ADOPT_EXPIRED_EVENT) {
    const adoption = strOrNone(getOwn(record, "adoption_id"));
    // `restored` is the operationally decisive bit: true means the previous session's delivery was
    // handed back, false means the owner is left with no claimer at all.
    const restored = getOwn(record, "restored");
    summary =
      `adoption ${adoption ?? "unknown"} expired; ` +
      (pyTruthy(restored) ? "previous session restored" : "no session is claiming this owner");
    key = `broker:delivery_adopt_expired:${owner ?? "unknown"}:${adoption ?? "unknown"}`;
    kind = "delivery_adopt_expired";
  } else if (event === DELIVERY_SUPERSEDED_EVENT) {
    const instance = strOrNone(getOwn(record, "instance"));
    summary = `sidecar ${instance ?? "unknown"} was superseded and stopped claiming`;
    // Key on the instance, not just the owner: a second session going mute later is a new incident
    // and must not be swallowed by the cooldown of the first.
    key = `broker:delivery_superseded:${owner ?? "unknown"}:${instance ?? "unknown"}`;
    kind = "delivery_superseded";
  } else {
    return null;
  }
  const [title, body] = defaultText(kind, { worker: owner, summary });
  return new AttentionEvent({
    key,
    kind,
    severity: severityFor(kind, notifyMap),
    title,
    body,
    source: BROKER_JOURNAL_SOURCE,
    factState: record.factState,
    worker: owner,
    summary,
    createdAt: isoFromEpoch(getOwn(record, "ts")),
  });
}

/**
 * Classify delivery-ownership rows, collapsing repeats per incident.
 *
 * Both underlying events are one-shot, so collapsing is normally a no-op -- it is here so that a
 * daemon restart or a journal that somehow carries the same `(owner, instance)` twice yields one
 * notification per incident per scan. Unrecognised rows are dropped.
 */
export function classifyBrokerDeliverySignals(
  records: Iterable<JournalRowInput>,
  options: { notifyMap?: NotifyMap | null } = {},
): AttentionEvent[] {
  const latest = new Map<string, [number, AttentionEvent]>();
  for (const record of records) {
    const event = classifyDeliverySignal(record, options);
    if (event === null) {
      continue;
    }
    const ts = epochOrNone(getOwn(record, "ts")) ?? 0;
    const previous = latest.get(event.key);
    if (previous === undefined || ts >= previous[0]) {
      latest.set(event.key, [ts, event]);
    }
  }
  return [...latest.values()].map(([, event]) => event);
}

/** Everything `classifyAll` takes beyond the two positional collections. */
export interface ClassifyAllOptions extends PendingThresholds {
  readonly brokerDuplicates?: Iterable<JournalRowInput>;
  readonly brokerDeliverySignals?: Iterable<JournalRowInput>;
}

/**
 * Classify all inputs in order: DB events, pending, broker journal.
 *
 * `brokerDuplicates` and `brokerDeliverySignals` default to empty, as the source defaults them:
 * callers that do not read the broker journal are unchanged.
 */
export function classifyAll(
  events: Iterable<EventRowInput>,
  pending: Iterable<PendingEntryInput>,
  now: Date,
  options: ClassifyAllOptions,
): AttentionEvent[] {
  const out: AttentionEvent[] = [];
  for (const row of events) {
    const event = classifyEvent(row, { notifyMap: options.notifyMap ?? null });
    if (event !== null) {
      out.push(event);
    }
  }
  for (const entry of pending) {
    const event = classifyPending(entry, now, options);
    if (event !== null) {
      out.push(event);
    }
  }
  out.push(
    ...classifyBrokerDuplicates(options.brokerDuplicates ?? [], {
      notifyMap: options.notifyMap ?? null,
    }),
  );
  out.push(
    ...classifyBrokerDeliverySignals(options.brokerDeliverySignals ?? [], {
      notifyMap: options.notifyMap ?? null,
    }),
  );
  return out;
}

/**
 * Resolve severity for `kind` via the override map, then the design default.
 *
 * `demote` is the "max <= age < drop" tier: a pending event the design defaults to `urgent`
 * becomes `normal` so it still surfaces but no longer wakes the operator. An explicit override
 * always wins over both the default and the demotion.
 */
function severityFor(
  kind: string,
  notifyMap: NotifyMap | null,
  options: { demote?: boolean } = {},
): Severity {
  if (notifyMap !== null) {
    // `getOwn` rather than an index, for uniformity with every other caller-keyed lookup in this
    // module -- but it is NOT what closes the inherited-key hole here, and saying so is the point:
    // the two-value check below already rejects everything `Object.prototype` could hand back, so
    // no test can distinguish the two spellings and none pretends to.
    const override = getOwn(notifyMap, kind);
    if (override === "urgent" || override === "normal") {
      return override;
    }
  }
  const fallback = (getOwn(DEFAULT_NOTIFY, kind) as Severity | undefined) ?? "normal";
  if (options.demote === true && fallback === "urgent") {
    return "normal";
  }
  return fallback;
}

/** The TTL tier for a pending-style row. */
type Ladder = "urgent" | "demote" | "drop";

/**
 * Returns `"urgent"` for the standard `min..max` window, `"demote"` past `max` but not past
 * `drop`, `"drop"` past `drop`, and `null` only when the row is still fresher than `min`.
 *
 * An infinite age -- the malformed/missing-timestamp sentinel returned by {@link minutesSince} --
 * short-circuits to `"urgent"` so a garbled `received_at` never silently falls into the drop
 * bucket and disappears.
 */
function ttlLadder(
  ageMinutes: number,
  minMinutes: number,
  maxMinutes: number,
  dropMinutes: number,
): Ladder | null {
  if (!Number.isFinite(ageMinutes) && !Number.isNaN(ageMinutes)) {
    return "urgent";
  }
  if (ageMinutes < minMinutes) {
    return null;
  }
  if (ageMinutes >= dropMinutes) {
    return "drop";
  }
  if (ageMinutes >= maxMinutes) {
    return "demote";
  }
  return "urgent";
}

// ---------------------------------------------------------------------------
// Runtime-default English text
// ---------------------------------------------------------------------------

const DEFAULT_TEMPLATES: Readonly<Record<string, readonly [string, string]>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, readonly [string, string]>, {
    approval_blocked: ["Worker approval required", "{worker} is waiting for approval."],
    relay_gap_suspected: ["Secretary relay gap suspected", "Relay gap detected for {task_id}."],
    silent_worker_output: [
      "Silent worker output",
      "{worker} produced output without a peer message.",
    ],
    ci_failed: ["CI failed", "PR #{pr} finished with {status}."],
    worker_completed: ["Worker completed", "{worker} finished task {task_id}."],
    pr_merged: ["PR merged", "PR #{pr} merged ({task_id})."],
    pending_decision: ["Pending decision", "{task_id} is waiting for human judgment."],
    user_reply_not_forwarded: [
      "User reply not forwarded",
      "{task_id}: user reply has not been relayed to the worker.",
    ],
    pane_silent: ["Worker pane silent", "{worker} pane has gone silent."],
    pane_crashed: ["Worker pane crashed", "{worker} pane crashed unexpectedly."],
    worker_stalled: ["Worker stalled", "{worker} appears stalled (no progress)."],
    worker_not_reported: [
      "Worker not reported",
      "{worker} has not reported back to the secretary.",
    ],
    worker_error: ["Worker error", "{worker} reported an error."],
    secretary_awaiting_user: [
      "Secretary awaiting user",
      "Secretary is waiting for the user on {task_id}.",
    ],
    duplicate_sidecar: [
      "Duplicate channel sidecar",
      "{worker}: two sessions are claiming the same channel ({summary}).",
    ],
    delivery_superseded: [
      "Channel session superseded",
      "{worker}: {summary}. Adopt the owner into a live session.",
    ],
    delivery_adopt_expired: ["Delivery adopt expired", "{worker}: {summary}."],
  }),
);

/** The values a default template may interpolate. */
export interface DefaultTextValues {
  readonly taskId?: unknown;
  readonly worker?: unknown;
  readonly pr?: unknown;
  readonly status?: unknown;
  readonly summary?: unknown;
}

/**
 * The runtime-default `(title, body)` for one attention kind.
 *
 * `str.format_map` becomes an explicit substitution over a closed set of names, which is the
 * point rather than a convenience: `format_map` would raise `KeyError` on an unknown placeholder
 * and a naive `String.replace` chain silently leaves it in the text, so the substitution is
 * written to leave nothing behind that reads like a placeholder somebody meant to fill.
 */
export function defaultText(kind: string, values: DefaultTextValues = {}): [string, string] {
  const template = getOwn(DEFAULT_TEMPLATES, kind) as readonly [string, string] | undefined;
  const [titleFormat, bodyFormat] = template ?? ["Attention", "{kind} event"];
  const substitutions: Record<string, string> = {
    task_id: strOrUnknown(values.taskId),
    worker: strOrUnknown(values.worker),
    pr: strOrUnknown(values.pr),
    status: strOrUnknown(values.status),
    kind,
    summary: strOrUnknown(values.summary),
  };
  return [formatMap(titleFormat, substitutions), formatMap(bodyFormat, substitutions)];
}

/**
 * Python's `str.format_map` over a fixed name set.
 *
 * A placeholder the map does not carry raises, exactly as `format_map` raises `KeyError`: a
 * template that names a field nobody supplies is a template bug, and leaving `{who}` in an
 * operator's notification is how it ships unnoticed.
 */
function formatMap(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([^{}]*)\}/g, (_match, name: string) => {
    const value = getOwn(values, name);
    if (typeof value !== "string") {
      throw new Error(`template ${JSON.stringify(template)} names an unknown field {${name}}`);
    }
    return value;
  });
}

function strOrUnknown(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "unknown";
  }
  return pyStr(value);
}

function strOrNone(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = pyStrip(pyStr(value));
  return text === "" ? null : text;
}

/**
 * Normalize the journal's `instances` field to a sorted id list.
 *
 * Sorting makes the dedup key independent of the order the daemon happened to write, and the
 * string coercion keeps a malformed entry from crashing the join.
 *
 * The comparison is Python's: `sorted()` on `str` orders by code point, which is what
 * `Array#sort`'s default *also* does -- but only because the default compares UTF-16 code units
 * after `String()`. Comparing explicitly says so, and keeps a future non-string element from
 * being ordered by a stringification this function did not perform.
 */
function instanceIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const text = strOrNone(item);
    if (text !== null) {
      out.push(text);
    }
  }
  return out.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Coerce a journal `ts` to a usable number epoch (`null` if not).
 *
 * A boolean is excluded explicitly -- the source excludes `bool` because it is an `int` subclass,
 * so a stray `true` would otherwise read as the epoch 1.
 */
function epochOrNone(ts: unknown): number | null {
  if (typeof ts === "boolean" || typeof ts !== "number") {
    return null;
  }
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Render the journal's numeric `ts` as ISO-8601 UTC (or `null`).
 *
 * The broker journal writes epoch seconds while every other `createdAt` is an ISO-8601 string, so
 * the conversion happens here, at the boundary.
 *
 * Not `Date#toISOString`, which always prints exactly three fractional digits: Python's
 * `datetime.isoformat()` prints **none** when the microsecond field is zero and **six** when it is
 * not, and `1767225600.0` has to come back as `2026-01-01T00:00:00Z` rather than
 * `2026-01-01T00:00:00.000Z`.
 */
export function isoFromEpoch(ts: unknown): string | null {
  const epoch = epochOrNone(ts);
  if (epoch === null) {
    return null;
  }
  // `datetime.fromtimestamp` rounds to the nearest microsecond; anything the arithmetic cannot
  // represent is the OverflowError / OSError / ValueError the source catches and returns None for.
  const totalMicros = Math.round(epoch * 1_000_000);
  if (!Number.isSafeInteger(totalMicros)) {
    return null;
  }
  const micros = ((totalMicros % 1_000_000) + 1_000_000) % 1_000_000;
  const whole = new Date((totalMicros - micros) / 1000);
  if (Number.isNaN(whole.getTime())) {
    return null;
  }
  const rendered = whole.toISOString();
  // A year outside 0000-9999 renders in the expanded `+275760-...` form, which is not an ISO
  // string the rest of the port would accept; the source reaches the same outcome by raising.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(rendered)) {
    return null;
  }
  const seconds = rendered.slice(0, 19);
  return micros === 0 ? `${seconds}Z` : `${seconds}.${String(micros).padStart(6, "0")}Z`;
}

/**
 * Python's `int(v)`, with the source's `None`/`bool` guards.
 *
 * One repair on top of the transcription, recorded in the ledger rather than made silently: the
 * source catches `TypeError` and `ValueError`, so `int(float("inf"))` -- which raises
 * `OverflowError` -- escapes it and takes the watcher down. Python's `json.loads` accepts
 * `Infinity`, and `JSON.parse` reaches the same value from `1e400`, so the hole is reachable in
 * both runtimes. Returning `null` is the answer the two caught exceptions already give for every
 * other unusable value (D-0023: an inherited defect is repaired at the first belt that touches
 * it).
 */
function coerceInt(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === "string") {
    // `int("  7  ")` accepts surrounding whitespace and `int("4.2")` does not; a decimal point is
    // a ValueError there and must not become a silent truncation here.
    const text = pyStrip(value);
    return /^[+-]?\d+$/.test(text) ? Number(text) : null;
  }
  return null;
}

/**
 * Minutes between `isoTs` and `now`.
 *
 * A malformed or missing timestamp returns `Infinity` so the surrounding classifier sees the entry
 * as "older than threshold" and fires the urgent alert -- false positives are preferable to false
 * negatives for a relay-gap watcher.
 */
function minutesSince(isoTs: unknown, now: Date): number {
  if (!pyTruthy(isoTs) || typeof isoTs !== "string") {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = parseIso(isoTs);
  if (parsed === null) {
    return Number.POSITIVE_INFINITY;
  }
  return (now.getTime() - parsed.getTime()) / 1000 / 60;
}

/**
 * `datetime.fromisoformat`, accepting a trailing `Z`, with a naive value read as UTC.
 *
 * Written as an explicit grammar rather than handed to `new Date(...)`. `Date.parse` accepts
 * shapes `fromisoformat` rejects (`"2026/05/12"`, `"May 12 2026"`, a bare `"12"`) and reads a
 * naive `"2026-05-12T10:00:00"` as **local** time where Python's `astimezone` on a naive value
 * would first attach UTC here. Both differences change which side of a TTL threshold a row lands
 * on, and the second one changes it by the runner's timezone offset -- a green suite in one
 * region and a red one in another.
 */
function parseIso(text: string): Date | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2}(?::\d{2})?)?)?$/.exec(
      text,
    );
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? "0");
  const minute = Number(match[5] ?? "0");
  const second = Number(match[6] ?? "0");
  const micros = Number((match[7] ?? "").padEnd(6, "0"));
  const zone = match[8];
  // Checked before the arithmetic, because `Date.UTC` rolls a month 13 or a day 32 FORWARD where
  // `fromisoformat` raises -- so a typo would become a real timestamp a month away rather than the
  // malformed-timestamp path the classifier's urgent posture depends on.
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  let ms = Date.UTC(year, month - 1, day, hour, minute, second, Math.round(micros / 1000));
  if (year < 100) {
    // `Date.UTC` maps years 0-99 into 1900-1999; `fromisoformat` does not.
    ms = new Date(ms).setUTCFullYear(year);
  }
  if (zone !== undefined && zone !== "Z") {
    const digits = zone.slice(1).replace(/:/g, "");
    const sign = zone.startsWith("-") ? -1 : 1;
    const offsetSeconds =
      Number(digits.slice(0, 2)) * 3600 +
      Number(digits.slice(2, 4)) * 60 +
      Number(digits.slice(4, 6) || "0");
    ms -= sign * offsetSeconds * 1000;
  }
  const parsed = new Date(ms);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Days in a Gregorian month, so a `2026-02-30` is refused rather than rolled into March. */
function daysInMonth(year: number, month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) {
    return 29;
  }
  return lengths[month - 1] as number;
}

/**
 * `str.rstrip()` with no argument, over Python's whitespace set.
 *
 * `pyStrip` is the two-sided form and is what every other call here wants; the truncated summary
 * wants only the right-hand half, so that a cut landing after a space does not leave one before
 * the ellipsis.
 */
function pyRstrip(text: string): string {
  let end = text.length;
  while (end > 0 && pyStrip(text[end - 1] as string) === "") {
    end -= 1;
  }
  return text.slice(0, end);
}

/** The source's 120-character summary, with an ellipsis where it cut. */
function shortSummary(value: unknown, limit = 120): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = pyStrip(pyStr(value));
  if (text === "") {
    return null;
  }
  if (text.length > limit) {
    // `"\u2026"` rather than the character, so this file stays ASCII; it is the character the
    // source appends, and the summary is operator-facing text rather than CLI output.
    return `${pyRstrip(text.slice(0, limit - 1))}\u2026`;
  }
  return text;
}
