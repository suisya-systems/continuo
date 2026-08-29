/**
 * The attention watcher's configuration module.
 *
 * Ported from interlock `claude_org_runtime/attention/config.py` at `65f36c5`. It carries both the
 * scan/watch knobs from the design's section 5 (`cooldown_sec`, `pending_decision_min`, the TTL
 * ladder) and the locale/template overrides from section 6 (`templates`): one loader, one
 * configuration object, which is what keeps the JSON shape flat for ja-side default configs and
 * keeps the watcher from juggling two parallel config objects.
 *
 * **Belt note, kept because it explains the file's history rather than its content.** The
 * attention subsystem ports in three sub-belts sharing one D-range (`D-0034`). A1 landed this file
 * holding only `Severity` and `DEFAULT_NOTIFY`, because `classifier.ts` -- A1's subject -- imports
 * the table and A1 could not land without it; `D-0902` records that boundary and required A2 to
 * FILL THIS FILE IN rather than replace it, which is what happened. Everything from `SoundMode`
 * down is A2's: `AttentionConfig`, `loadConfig`, `Template`, the placeholder allowlist and the
 * sound modes, ported from `tests/attention/test_config.py`'s 34 cases under
 * `parity/attention.config.ledger.json`.
 *
 * Two Python semantics are load-bearing here and are transcribed rather than approximated; both
 * are recorded in that ledger and in `D-0905`:
 *
 * - `isinstance(value, int)` is a question about the **document**, not about the value. Python's
 *   `json.loads` produces an `int` only for a literal with no `.`, `e` or `E`, so `1.0` and `1e2`
 *   are floats it refuses -- and both are ordinary integers to `Number.isInteger`.
 * - the maps keyed by an attention kind are `dict`s, which have no inherited keys.
 */

import { existsSync, readFileSync } from "node:fs";
import { pyJsonLoads } from "../fencing/pyjson.js";
import { pyRepr } from "../fencing/pyrepr.js";
import { PyValueError, pyTypeNameOf } from "../fencing/pysemantics.js";

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

/** interlock `config.SoundMode`: the three sound settings the watcher accepts. */
export type SoundMode = "off" | "urgent-only" | "all";

/**
 * Placeholder allowlist from interlock's design section 6, carried unchanged.
 *
 * Anything outside this set triggers a warning and a fallback to the runtime default template --
 * the watcher must never crash on a misspelled template. **The enforcement is not here.** The
 * source validates placeholders in `notify.render_text` and says why in `load_config`'s own
 * docstring: validation happens once per event, not once at config-load time, and a typo must not
 * block the watcher from starting. `notify.py` is A3's, so the consumer of this set arrives with
 * that sub-belt and the set itself sits here because that is where the source keeps it.
 */
export const ALLOWED_PLACEHOLDERS: ReadonlySet<string> = Object.freeze(
  new Set(["task_id", "worker", "kind", "status", "pr", "summary"]),
) as ReadonlySet<string>;

/**
 * The three sound modes, in the order the refusal message prints them.
 *
 * The source builds the message from `sorted(_VALID_SOUND_MODES)` over a `frozenset`, so the
 * printed order is sorted and NOT declaration order. Held as a sorted array rather than as a set
 * plus a sort at the call site: the sort is what the message shows, and a set here would let the
 * two drift.
 */
const VALID_SOUND_MODES: readonly SoundMode[] = Object.freeze(["all", "off", "urgent-only"]);

/** One `{title, body}` template pair for a given attention kind. */
export class Template {
  readonly title: string;
  readonly body: string;

  constructor(init: { readonly title: string; readonly body: string }) {
    this.title = init.title;
    this.body = init.body;
  }
}

/**
 * The defaults of every `AttentionConfig` field, as one record.
 *
 * The source reads four of these back out of `AttentionConfig.__dataclass_fields__` inside
 * `load_config`, to decide whether a legacy config needs its TTL ladder auto-scaled. A dataclass
 * carries its defaults at runtime and a TypeScript class does not, so the defaults are named once
 * here and both the constructor and the loader read them from the same place -- which is the
 * property `__dataclass_fields__` was giving the source, and the reason this is a record rather
 * than a set of literals repeated in two functions.
 */
export const ATTENTION_CONFIG_DEFAULTS = Object.freeze({
  desktop: true,
  sound: "urgent-only" as SoundMode,
  cooldownSec: 300,
  pollIntervalSec: 10,
  pendingDecisionMin: 15,
  // interlock Issue #26 Part A TTL ladder for urgent pending decisions:
  // min <= age < max -> urgent (escalate); max <= age < drop -> demote to normal (still notify);
  // age >= drop -> suppressed from notify entirely, though `attention scan --json` still surfaces
  // the row so an operator can run a triage report. The same ladder applies to
  // `user_reply_not_forwarded`, whose clock starts at `user_replied_at`.
  pendingDecisionMax: 1440, // 24h
  pendingDecisionDrop: 10080, // 7d
  userRepliedMin: 15,
  // interlock Issue #167: how far back in the broker journal a `duplicate_sidecar_detected` line
  // still counts as "happening now". The store re-emits per instance pair once per lease window
  // (30s by default) for as long as both sidecars keep polling, so any window comfortably above
  // that keeps a live incident alerting while letting a resolved one fall silent.
  duplicateSidecarWindowSec: 300,
  // interlock Issue #166: the same, for the delivery-ownership signals -- and deliberately much
  // longer, because those two are ONE-SHOT. They will not fire again to catch a later scan, so a
  // short window would quietly drop a still-unresolved mute.
  deliverySignalWindowSec: 3600,
  maxTitleChars: 80,
  maxBodyChars: 240,
});

/** What `new AttentionConfig(...)` accepts: every field, each optional. */
export interface AttentionConfigInit {
  readonly desktop?: boolean;
  readonly sound?: SoundMode;
  readonly cooldownSec?: number;
  readonly pollIntervalSec?: number;
  readonly pendingDecisionMin?: number;
  readonly pendingDecisionMax?: number;
  readonly pendingDecisionDrop?: number;
  readonly userRepliedMin?: number;
  readonly duplicateSidecarWindowSec?: number;
  readonly deliverySignalWindowSec?: number;
  readonly maxTitleChars?: number;
  readonly maxBodyChars?: number;
  readonly notify?: Readonly<Record<string, Severity>>;
  readonly templates?: Readonly<Record<string, Template>>;
}

/**
 * Every knob the attention watcher reads.
 *
 * The defaults match interlock's design section 5 reference JSON. `templates` is empty by default
 * -- when no override is present, `notify.render_text` (A3's) falls back to the bundled English
 * defaults the classifier attaches to each event.
 *
 * `notify` is a **sparse** map of explicit user overrides only. interlock's Issue #26 round-4 fix
 * is the reason, and it is worth keeping: pre-#26 this was pre-filled with every `DEFAULT_NOTIFY`
 * entry, which made the TTL demote check in the classifier read every default as an operator
 * override and defeated the `max <= age < drop` demote path entirely on the CLI route. Keeping the
 * map sparse lets the classifier fall back to {@link DEFAULT_NOTIFY} for unset keys and apply
 * demote there, while honouring genuine user overrides.
 */
export class AttentionConfig {
  readonly desktop: boolean;
  readonly sound: SoundMode;
  readonly cooldownSec: number;
  readonly pollIntervalSec: number;
  readonly pendingDecisionMin: number;
  readonly pendingDecisionMax: number;
  readonly pendingDecisionDrop: number;
  readonly userRepliedMin: number;
  readonly duplicateSidecarWindowSec: number;
  readonly deliverySignalWindowSec: number;
  readonly maxTitleChars: number;
  readonly maxBodyChars: number;
  readonly notify: Readonly<Record<string, Severity>>;
  readonly templates: Readonly<Record<string, Template>>;

  constructor(init: AttentionConfigInit = {}) {
    const d = ATTENTION_CONFIG_DEFAULTS;
    this.desktop = init.desktop ?? d.desktop;
    this.sound = init.sound ?? d.sound;
    this.cooldownSec = init.cooldownSec ?? d.cooldownSec;
    this.pollIntervalSec = init.pollIntervalSec ?? d.pollIntervalSec;
    this.pendingDecisionMin = init.pendingDecisionMin ?? d.pendingDecisionMin;
    this.pendingDecisionMax = init.pendingDecisionMax ?? d.pendingDecisionMax;
    this.pendingDecisionDrop = init.pendingDecisionDrop ?? d.pendingDecisionDrop;
    this.userRepliedMin = init.userRepliedMin ?? d.userRepliedMin;
    this.duplicateSidecarWindowSec = init.duplicateSidecarWindowSec ?? d.duplicateSidecarWindowSec;
    this.deliverySignalWindowSec = init.deliverySignalWindowSec ?? d.deliverySignalWindowSec;
    this.maxTitleChars = init.maxTitleChars ?? d.maxTitleChars;
    this.maxBodyChars = init.maxBodyChars ?? d.maxBodyChars;
    this.notify = copyMap(init.notify);
    this.templates = copyMap(init.templates);

    // interlock's `__post_init__`: validate the TTL ladder once at construction, so a malformed
    // default-built config (test scaffolding that overrides only one threshold, say) trips
    // immediately rather than producing silently wrong classifications downstream. The ladder has
    // to admit a real "urgent" window for BOTH the pending_decision path (clock at `received_at`)
    // and the user_reply_not_forwarded path (clock at `user_replied_at`), so `max` must exceed
    // both lower bounds. The messages carry the JSON spelling of each knob, not this class's
    // camelCase one (D-0201): they name what an operator wrote in a file.
    if (this.pendingDecisionMax <= this.pendingDecisionMin) {
      throw new PyValueError(
        "config.pending_decision_max must be greater than pending_decision_min " +
          `(${this.pendingDecisionMax} <= ${this.pendingDecisionMin})`,
      );
    }
    if (this.pendingDecisionMax <= this.userRepliedMin) {
      throw new PyValueError(
        "config.pending_decision_max must be greater than user_replied_min " +
          `(${this.pendingDecisionMax} <= ${this.userRepliedMin})`,
      );
    }
    if (this.pendingDecisionDrop <= this.pendingDecisionMax) {
      throw new PyValueError(
        "config.pending_decision_drop must be greater than pending_decision_max " +
          `(${this.pendingDecisionDrop} <= ${this.pendingDecisionMax})`,
      );
    }
  }
}

/**
 * The largest integer a config knob may carry, and it is deliberately not `MAX_SAFE_INTEGER`.
 *
 * Python's `int` is arbitrary-precision; this runtime's `number` is exact only to 2**53. Silence
 * is unaffordable here because of the loader's own backward-compat auto-scale, which computes
 * `floor + 1` and then `max + 1`: past 2**53 each of those expressions IS its own input, so a
 * legacy document setting `pending_decision_min` to 9007199254740992 would produce a ladder with
 * `max == min` and be refused by the constructor with a message about `max <= min` -- a refusal
 * naming the wrong knob, for a value interlock loads without complaint. Two successive increments
 * have to stay exact, so the bound is two below `MAX_SAFE_INTEGER` rather than at it, and the
 * refusal fires where the value is READ, which is where a reader can act on it.
 *
 * `D-0905` records this as a divergence rather than a repair: the port is narrower than its source
 * for an input the source handles, and nothing in interlock's own suite reaches it. Every one of
 * these knobs is a threshold in minutes or seconds, so the smallest refused value is some 285
 * million years.
 */
const MAX_CONFIG_INTEGER = Number.MAX_SAFE_INTEGER - 2;

/**
 * The JSON keys carrying a non-negative integer, in the order the source validates them.
 *
 * The order is the order the refusals fire in, so it is part of what a ported case observes when a
 * document is wrong in two places at once.
 */
const INT_KEYS: readonly (readonly [string, keyof AttentionConfigInit])[] = Object.freeze([
  ["cooldown_sec", "cooldownSec"],
  ["poll_interval_sec", "pollIntervalSec"],
  ["pending_decision_min", "pendingDecisionMin"],
  ["pending_decision_max", "pendingDecisionMax"],
  ["pending_decision_drop", "pendingDecisionDrop"],
  ["user_replied_min", "userRepliedMin"],
  ["duplicate_sidecar_window_sec", "duplicateSidecarWindowSec"],
  ["delivery_signal_window_sec", "deliverySignalWindowSec"],
  ["max_title_chars", "maxTitleChars"],
  ["max_body_chars", "maxBodyChars"],
] as const);

/**
 * Load an {@link AttentionConfig} from a JSON file, or return the defaults.
 *
 * A `null` path or a missing file gives the defaults. Malformed JSON or a wrong shape raises, so
 * the CLI surfaces a clear error before the watcher ever runs. Template placeholders are **not**
 * validated here -- see {@link ALLOWED_PLACEHOLDERS} for the source's own reason.
 */
export function loadConfig(path: string | null): AttentionConfig {
  if (path === null) {
    return new AttentionConfig();
  }
  if (!existsSync(path)) {
    return new AttentionConfig();
  }
  // `pyJsonLoads`, not `JSON.parse`, and the reason is the integer check below rather than key
  // order. Python's `json.loads` produces an `int` only for a literal with no `.`, `e` or `E`, so
  // `1.0` and `1e2` are floats there and `isinstance(value, int)` refuses them. Both reach the
  // same `number` here, and `Number.isInteger` says yes to both -- so a `cooldown_sec: 1e2` that
  // the source refuses would be silently accepted. `pyJsonLoads` records the DOCUMENT's spelling
  // and `pyTypeNameOf` reports `int` or `float` from it, which is the question the source asks.
  // Read BYTES and decode strictly, for the two reasons `src/attention/dedup.ts` records: Node's
  // utf8 mode substitutes U+FFFD for an undecodable byte (so a bad byte inside a JSON string
  // silently mutates a template or a notify key that the document is then loaded with), and
  // `TextDecoder` strips a leading BOM by default where Python's `utf-8` codec keeps it and
  // `json.loads` refuses it.
  // The READ is outside the try on purpose. A path that exists but cannot be read -- a directory,
  // a permission denial, a file that disappeared after the check above -- is an `OSError` in the
  // source and propagates as one; wrapping it in the decoder's refusal would tell a caller its
  // configuration is malformed when the problem is operational. Only the DECODE is wrapped.
  const bytes = readFileSync(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    // `read_text(encoding="utf-8")` raises `UnicodeDecodeError`, which IS a `ValueError`, and
    // `load_config` lets it propagate -- so a caller catching `ValueError` around this loader
    // catches it. `TextDecoder` raises a `TypeError` instead, which that caller would not catch,
    // so it is re-raised in the family the rest of this loader refuses in.
    throw new PyValueError(
      `attention config ${pyRepr(path)} is not valid UTF-8 (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  const raw: unknown = pyJsonLoads(text);
  if (!isDict(raw)) {
    throw new PyValueError(`attention config ${pyRepr(path)} must be a JSON object`);
  }

  const init: Record<string, unknown> = {};

  for (const [jsonKey, field] of INT_KEYS) {
    if (!Object.hasOwn(raw, jsonKey)) {
      continue;
    }
    const value = raw[jsonKey];
    // `type(value).__name__`, per the DOCUMENT: `bool` for `true` (which the source excludes
    // explicitly, because `bool` is an `int` subclass in Python), `float` for `1.0`, `str` for a
    // quoted number.
    const typeName = pyTypeNameOf(raw, jsonKey);
    if (typeName !== "int") {
      throw new PyValueError(`config.${jsonKey} must be an integer, got ${typeName}`);
    }
    if ((value as number) < 0) {
      throw new PyValueError(`config.${jsonKey} must be non-negative`);
    }
    // A DELIBERATE DIVERGENCE, narrower than the source, recorded in D-0905 and in the ledger.
    // See MAX_CONFIG_INTEGER for what the bound is and why it is not simply 2**53 - 1.
    if (!Number.isSafeInteger(value) || (value as number) > MAX_CONFIG_INTEGER) {
      throw new PyValueError(
        `config.${jsonKey} must be an integer this runtime can carry exactly ` +
          `(at most ${MAX_CONFIG_INTEGER}), got ${String(value)}`,
      );
    }
    init[field] = value;
  }

  if (Object.hasOwn(raw, "desktop")) {
    if (typeof raw["desktop"] !== "boolean") {
      throw new PyValueError("config.desktop must be a boolean");
    }
    init["desktop"] = raw["desktop"];
  }

  if (Object.hasOwn(raw, "sound")) {
    const sound = raw["sound"];
    if (typeof sound !== "string" || !VALID_SOUND_MODES.includes(sound as SoundMode)) {
      throw new PyValueError(
        `config.sound must be one of ${pyRepr([...VALID_SOUND_MODES])}, got ${pyRepr(sound)}`,
      );
    }
    init["sound"] = sound;
  }

  if (Object.hasOwn(raw, "notify")) {
    const source = raw["notify"];
    if (!isDict(source)) {
      throw new PyValueError("config.notify must be a JSON object");
    }
    // Kept SPARSE, per the class docstring: pre-filling it with `DEFAULT_NOTIFY` masks the
    // difference between "the operator pinned this severity" and "the design default happens to
    // be urgent", which is what breaks the TTL demote path on the CLI route.
    const notify = emptyMap<Severity>();
    for (const [kind, severity] of Object.entries(source)) {
      if (severity !== "urgent" && severity !== "normal") {
        throw new PyValueError(
          `config.notify[${pyRepr(kind)}] must be 'urgent' or 'normal', got ${pyRepr(severity)}`,
        );
      }
      notify[kind] = severity;
    }
    init["notify"] = notify;
  }

  if (Object.hasOwn(raw, "templates")) {
    const source = raw["templates"];
    if (!isDict(source)) {
      throw new PyValueError("config.templates must be a JSON object");
    }
    const templates = emptyMap<Template>();
    for (const [kind, template] of Object.entries(source)) {
      if (!isDict(template)) {
        throw new PyValueError(`config.templates[${pyRepr(kind)}] must be a JSON object`);
      }
      // `tmpl.get("title", "")` defaults only when the KEY IS ABSENT. A key present with a `null`
      // value gives `None`, which is not a `str`, so the source refuses it -- and `?? ""` here
      // would have accepted it as the empty string instead.
      const title = Object.hasOwn(template, "title") ? template["title"] : "";
      const body = Object.hasOwn(template, "body") ? template["body"] : "";
      if (typeof title !== "string" || typeof body !== "string") {
        throw new PyValueError(
          `config.templates[${pyRepr(kind)}] must have string 'title' and 'body' fields`,
        );
      }
      templates[kind] = new Template({ title, body });
    }
    init["templates"] = templates;
  }

  // interlock Issue #26 backward-compat. A pre-#26 user config that only raised
  // `pending_decision_min` or `user_replied_min` above the new default `max` (1440) -- or only
  // raised `max` above the new default `drop` (10080) -- used to load fine. Validation now
  // requires both lower bounds below `max` below `drop`, so any knob the document did not set is
  // auto-scaled upward to keep a legacy config loading. An EXPLICIT value always wins, and the
  // constructor's validator still rejects any inversion the document itself introduces -- which is
  // why both tests below read `raw`, the document, and not `init`.
  const d = ATTENTION_CONFIG_DEFAULTS;
  if (!Object.hasOwn(raw, "pending_decision_max")) {
    // Both ladder paths share the same `max` threshold, so the auto-scaled value has to clear
    // whichever lower bound is larger. `+1` keeps validation happy without inventing a policy
    // multiplier.
    const floor = Math.max(
      (init["pendingDecisionMin"] as number | undefined) ?? d.pendingDecisionMin,
      (init["userRepliedMin"] as number | undefined) ?? d.userRepliedMin,
    );
    if (floor >= d.pendingDecisionMax) {
      init["pendingDecisionMax"] = floor + 1;
    }
  }
  const effectiveMax = (init["pendingDecisionMax"] as number | undefined) ?? d.pendingDecisionMax;
  if (!Object.hasOwn(raw, "pending_decision_drop") && effectiveMax >= d.pendingDecisionDrop) {
    init["pendingDecisionDrop"] = effectiveMax + 1;
  }

  return new AttentionConfig(init as AttentionConfigInit);
}

/** Python's `isinstance(x, dict)` over what a JSON document can hold. */
function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A map with no inherited keys, which is what Python's `dict` is.
 *
 * `docs/test-translation-conventions.md` rule 9, and the same reasoning `DEFAULT_NOTIFY` above
 * carries: both maps are keyed by an attention kind the operator's own file supplies, and an
 * object literal would answer a lookup for `constructor` or `toString` with an inherited value.
 */
function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** A defensive copy that is also a null-prototype map, for the two caller-supplied maps. */
function copyMap<T>(source: Readonly<Record<string, T>> | undefined): Record<string, T> {
  const copy = emptyMap<T>();
  for (const [key, value] of Object.entries(source ?? {})) {
    copy[key] = value;
  }
  return copy;
}
