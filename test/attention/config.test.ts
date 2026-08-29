/**
 * Ported from interlock `tests/attention/test_config.py` at `65f36c5` -- 34 cases.
 *
 * The ledger is `parity/attention.config.ledger.json`. `pytest.raises(ValueError, match=...)`
 * becomes `expectRefusal(..., PyValueError, /.../)` throughout, keeping both halves of the source
 * assertion (`docs/test-translation-conventions.md`); `PyValueError` is the port's existing
 * transcription of a Python `ValueError` and is what `src/settings/` and `src/session/` already
 * raise for the same reason.
 *
 * The target-only cases at the end are this port's rule-9 exposures. Each is there because a
 * mutation showed the property was otherwise unprotected, and each probe is recorded in the
 * ledger.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  ALLOWED_PLACEHOLDERS,
  AttentionConfig,
  DEFAULT_NOTIFY,
  loadConfig,
  Template,
} from "../../src/attention/config.js";
import { PyValueError } from "../../src/fencing/pysemantics.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

/** The source's repeated `path.write_text(json.dumps(...), encoding="utf-8")`. */
function configFile(name: string, document: unknown): string {
  const path = join(caseRoot("attn-config"), name);
  writeFileSync(path, JSON.stringify(document), "utf8");
  return path;
}

/** The same, for a document that has to be spelled as literal JSON text. */
function configText(name: string, text: string): string {
  const path = join(caseRoot("attn-config"), name);
  writeFileSync(path, text, "utf8");
  return path;
}

describe("attention config", () => {
  test("the defaults match the design document", () => {
    const cfg = new AttentionConfig();
    expect(cfg.desktop).toBe(true);
    expect(cfg.sound).toBe("urgent-only");
    expect(cfg.cooldownSec).toBe(300);
    expect(cfg.pollIntervalSec).toBe(10);
    expect(cfg.pendingDecisionMin).toBe(15);
    // interlock Issue #26 Part A TTL ladder: 24h demote, 7d drop.
    expect(cfg.pendingDecisionMax).toBe(1440);
    expect(cfg.pendingDecisionDrop).toBe(10080);
    expect(cfg.userRepliedMin).toBe(15);
    expect(cfg.maxTitleChars).toBe(80);
    expect(cfg.maxBodyChars).toBe(240);
    // Issue #26 round-4: `notify` is sparse -- empty unless the user provided overrides. The
    // merged severity table lives in DEFAULT_NOTIFY and is consulted by the classifier when
    // `cfg.notify` has no entry for a kind.
    expect({ ...cfg.notify }).toEqual({});
    expect({ ...cfg.templates }).toEqual({});
  });

  test("the Part B rebalance leaves only the human-only-recovery kinds urgent", () => {
    expect(DEFAULT_NOTIFY["approval_blocked"]).toBe("urgent");
    expect(DEFAULT_NOTIFY["pending_decision"]).toBe("urgent");
    expect(DEFAULT_NOTIFY["user_reply_not_forwarded"]).toBe("urgent");
    expect(DEFAULT_NOTIFY["ci_failed"]).toBe("urgent");
    expect(DEFAULT_NOTIFY["pane_crashed"]).toBe("urgent");
    for (const demoted of [
      "relay_gap_suspected",
      "silent_worker_output",
      "pane_silent",
      "worker_stalled",
      "worker_not_reported",
      "worker_error",
    ]) {
      expect(DEFAULT_NOTIFY[demoted], demoted).toBe("normal");
    }
    expect(DEFAULT_NOTIFY["worker_completed"]).toBe("normal");
    expect(DEFAULT_NOTIFY["pr_merged"]).toBe("normal");
  });

  test("secretary_awaiting_user joins the urgent tier by default", () => {
    expect(DEFAULT_NOTIFY["secretary_awaiting_user"]).toBe("urgent");
  });

  test("a legacy notify map omitting secretary_awaiting_user still gets the urgent default", () => {
    const path = configFile("legacy.json", { notify: { worker_completed: "urgent" } });
    const cfg = loadConfig(path);
    expect(Object.hasOwn(cfg.notify, "secretary_awaiting_user")).toBe(false);
    // The design default still applies when looked up via DEFAULT_NOTIFY, which is the table the
    // classifier consults for unset keys.
    expect(DEFAULT_NOTIFY["secretary_awaiting_user"]).toBe("urgent");
  });

  test("a missing file returns the defaults", () => {
    expect(loadConfig(join(caseRoot("attn-config"), "missing.json"))).toEqual(
      new AttentionConfig(),
    );
  });

  test("a null path returns the defaults", () => {
    expect(loadConfig(null)).toEqual(new AttentionConfig());
  });

  test("a full config round-trips into every field", () => {
    const path = configFile("attention.json", {
      desktop: false,
      sound: "off",
      cooldown_sec: 60,
      poll_interval_sec: 5,
      pending_decision_min: 20,
      user_replied_min: 7,
      max_title_chars: 40,
      max_body_chars: 100,
      notify: { worker_completed: "urgent" },
      templates: { ci_failed: { title: "CI Failed", body: "PR #{pr} status={status}" } },
    });
    const cfg = loadConfig(path);
    expect(cfg.desktop).toBe(false);
    expect(cfg.sound).toBe("off");
    expect(cfg.cooldownSec).toBe(60);
    expect(cfg.pollIntervalSec).toBe(5);
    expect(cfg.pendingDecisionMin).toBe(20);
    expect(cfg.userRepliedMin).toBe(7);
    expect(cfg.maxTitleChars).toBe(40);
    expect(cfg.maxBodyChars).toBe(100);
    expect(cfg.notify["worker_completed"]).toBe("urgent");
    // Issue #26 round-4: cfg.notify is sparse -- only entries explicitly set in the config JSON
    // live here. Unset keys are resolved against DEFAULT_NOTIFY by the classifier, which is what
    // makes the TTL demote path work on the CLI route.
    expect(Object.hasOwn(cfg.notify, "approval_blocked")).toBe(false);
    expect(cfg.templates["ci_failed"]).toEqual(
      new Template({ title: "CI Failed", body: "PR #{pr} status={status}" }),
    );
  });

  test("an unknown sound mode is rejected", () => {
    const path = configFile("bad.json", { sound: "noisy" });
    expectRefusal(() => loadConfig(path), PyValueError, /config.sound/);
  });

  test("an unknown notify severity is rejected", () => {
    const path = configFile("bad.json", { notify: { ci_failed: "panic" } });
    expectRefusal(() => loadConfig(path), PyValueError, /must be 'urgent' or 'normal'/);
  });

  test("a negative integer is rejected", () => {
    const path = configFile("bad.json", { cooldown_sec: -1 });
    expectRefusal(() => loadConfig(path), PyValueError, /non-negative/);
  });

  test("a non-integer for an integer field is rejected", () => {
    const path = configFile("bad.json", { max_title_chars: "lots" });
    expectRefusal(() => loadConfig(path), PyValueError, /must be an integer/);
  });

  test("a boolean is not accepted as an integer", () => {
    // bool is a subclass of int in Python -- guard against that here so a ja config can't
    // accidentally pass `True` as a cooldown.
    const path = configFile("bad.json", { cooldown_sec: true });
    expectRefusal(() => loadConfig(path), PyValueError, /must be an integer/);
  });

  test("a template that is not an object is rejected", () => {
    const path = configFile("bad.json", { templates: { ci_failed: "string" } });
    expectRefusal(() => loadConfig(path), PyValueError, /must be a JSON object/);
  });

  test("a template title and body must both be strings", () => {
    const path = configFile("bad.json", { templates: { ci_failed: { title: 5, body: "ok" } } });
    expectRefusal(() => loadConfig(path), PyValueError, /must have string/);
  });

  test("a top level that is not an object is rejected", () => {
    const path = configFile("bad.json", [1, 2]);
    expectRefusal(() => loadConfig(path), PyValueError, /must be a JSON object/);
  });

  // -------------------------------------------------------------------------
  // interlock Issue #26 Part A: the TTL ladder config.
  // -------------------------------------------------------------------------

  test("the new TTL knobs round-trip from JSON", () => {
    const path = configFile("attention.json", {
      pending_decision_min: 5,
      pending_decision_max: 60,
      pending_decision_drop: 600,
    });
    const cfg = loadConfig(path);
    expect(cfg.pendingDecisionMin).toBe(5);
    expect(cfg.pendingDecisionMax).toBe(60);
    expect(cfg.pendingDecisionDrop).toBe(600);
  });

  test("a config with no TTL keys keeps working on the defaults", () => {
    const path = configFile("attention.json", { pending_decision_min: 30 });
    const cfg = loadConfig(path);
    expect(cfg.pendingDecisionMin).toBe(30);
    expect(cfg.pendingDecisionMax).toBe(1440);
    expect(cfg.pendingDecisionDrop).toBe(10080);
  });

  test("pending_decision_max must exceed pending_decision_min", () => {
    expectRefusal(
      () => new AttentionConfig({ pendingDecisionMin: 100, pendingDecisionMax: 100 }),
      PyValueError,
      /pending_decision_max must be greater than/,
    );
  });

  test("pending_decision_max equal to min is rejected: the demotion window must be real", () => {
    expectRefusal(
      () => new AttentionConfig({ pendingDecisionMin: 200, pendingDecisionMax: 150 }),
      PyValueError,
      /pending_decision_max must be greater than/,
    );
  });

  test("pending_decision_drop must exceed pending_decision_max", () => {
    expectRefusal(
      () =>
        new AttentionConfig({
          pendingDecisionMin: 10,
          pendingDecisionMax: 100,
          pendingDecisionDrop: 100,
        }),
      PyValueError,
      /pending_decision_drop must be greater than/,
    );
  });

  test("pending_decision_drop below pending_decision_max is rejected", () => {
    expectRefusal(
      () =>
        new AttentionConfig({
          pendingDecisionMin: 10,
          pendingDecisionMax: 100,
          pendingDecisionDrop: 50,
        }),
      PyValueError,
      /pending_decision_drop must be greater than/,
    );
  });

  test("pending_decision_max must exceed user_replied_min as well", () => {
    // user_reply_not_forwarded shares the `max` ceiling. If a user pins `user_replied_min` at or
    // above `pending_decision_max`, the user_reply ladder never produces an urgent tier -- the
    // first eligible age is already past `max`. Validate so the misconfiguration trips at
    // construction instead of silently suppressing all relay-gap alerts.
    expectRefusal(
      () =>
        new AttentionConfig({
          pendingDecisionMin: 10,
          userRepliedMin: 2000,
          pendingDecisionMax: 1440,
        }),
      PyValueError,
      /pending_decision_max must be greater than user_replied_min/,
    );
  });

  test("a legacy user_replied_min above the default max auto-scales the ladder", () => {
    const path = configFile("legacy.json", { user_replied_min: 2880 }); // 48h, > default max
    const cfg = loadConfig(path);
    expect(cfg.userRepliedMin).toBe(2880);
    expect(cfg.pendingDecisionMax).toBeGreaterThan(2880);
    expect(cfg.pendingDecisionDrop).toBeGreaterThan(cfg.pendingDecisionMax);
  });

  test("an invalid TTL ladder in JSON surfaces through loadConfig", () => {
    const path = configFile("bad.json", { pending_decision_min: 10, pending_decision_max: 5 });
    expectRefusal(
      () => loadConfig(path),
      PyValueError,
      /pending_decision_max must be greater than/,
    );
  });

  test("the non-negative guard applies to the new knobs too", () => {
    const path = configFile("bad.json", { pending_decision_max: -1 });
    expectRefusal(() => loadConfig(path), PyValueError, /non-negative/);
  });

  test("a legacy pending_decision_min above the default max auto-scales the ladder", () => {
    // Before Issue #26 there was no `max` / `drop` knob, so a config that set
    // `pending_decision_min` arbitrarily high (a silenced "alert me after 2 days" setup) would
    // still work. The new validation would otherwise reject it because the default max (1440)
    // would be at or below the user min.
    const path = configFile("legacy.json", { pending_decision_min: 2880 }); // 48h, > default max
    const cfg = loadConfig(path);
    expect(cfg.pendingDecisionMin).toBe(2880);
    expect(cfg.pendingDecisionMax).toBeGreaterThan(2880);
    expect(cfg.pendingDecisionDrop).toBeGreaterThan(cfg.pendingDecisionMax);
  });

  test("an explicit max above the default drop scales drop too", () => {
    const path = configFile("weird.json", {
      pending_decision_min: 60,
      pending_decision_max: 20000, // > default drop (10080)
    });
    const cfg = loadConfig(path);
    expect(cfg.pendingDecisionMax).toBe(20000);
    expect(cfg.pendingDecisionDrop).toBeGreaterThan(20000);
  });

  test("the auto-scale does not mask an explicit inversion in the document", () => {
    const path = configFile("bad.json", {
      pending_decision_min: 50,
      pending_decision_max: 30, // explicitly < min
    });
    expectRefusal(
      () => loadConfig(path),
      PyValueError,
      /pending_decision_max must be greater than/,
    );
  });

  test("the duplicate-sidecar window has a default and is operator-tunable", () => {
    expect(new AttentionConfig().duplicateSidecarWindowSec).toBe(300);
    const path = configFile("attention.json", { duplicate_sidecar_window_sec: 60 });
    expect(loadConfig(path).duplicateSidecarWindowSec).toBe(60);
  });

  test("the duplicate-sidecar window rejects a non-integer", () => {
    const path = configFile("attention.json", { duplicate_sidecar_window_sec: "60" });
    expectRefusal(() => loadConfig(path), PyValueError);
  });

  test("duplicate_sidecar defaults to urgent: only a human can resolve a double claimer", () => {
    expect(DEFAULT_NOTIFY["duplicate_sidecar"]).toBe("urgent");
  });

  test("the delivery-signal window has a longer default and is operator-tunable", () => {
    // `delivery_register_superseded` / `delivery_adopt_expired` never re-fire, so if this
    // defaulted to the duplicate-sidecar window (300s) a watcher started five minutes after a
    // session went mute would never hear about it.
    expect(new AttentionConfig().deliverySignalWindowSec).toBe(3600);
    const path = configFile("attention.json", { delivery_signal_window_sec: 900 });
    expect(loadConfig(path).deliverySignalWindowSec).toBe(900);
  });

  test("the delivery-signal window rejects a non-integer", () => {
    // A string here would reach `now_epoch - window_sec` inside the reader and raise mid-scan on a
    // long-running watch, instead of failing loudly when the config is loaded.
    const path = configFile("attention.json", { delivery_signal_window_sec: "900" });
    expectRefusal(() => loadConfig(path), PyValueError);
  });

  test("both delivery-ownership kinds default to urgent", () => {
    // Each means an owner is receiving no push and nothing in the runtime will fix it -- the
    // "human is the sole recovery path" tier. Demoting either to `normal` would let a silently
    // muted session sit behind a non-waking notification.
    expect(DEFAULT_NOTIFY["delivery_superseded"]).toBe("urgent");
    expect(DEFAULT_NOTIFY["delivery_adopt_expired"]).toBe("urgent");
  });

  // -------------------------------------------------------------------------
  // Target-only. Not counted as ported coverage; see the ledger.
  // -------------------------------------------------------------------------

  test("a float literal is not an integer, however round it looks (target-only)", () => {
    // Rule 9, and the reason this loader parses with `pyJsonLoads` rather than `JSON.parse`.
    // Python's `json.loads` makes an `int` only from a literal with no `.`, `e` or `E`, so every
    // one of these is a float there and `isinstance(value, int)` refuses it -- and every one is an
    // ordinary integer to `Number.isInteger`. The message names the type the DOCUMENT wrote.
    for (const literal of ["1.0", "1e2", "1E2", "6.0e1", "-0.0"]) {
      const path = configText("float.json", `{"cooldown_sec": ${literal}}`);
      expectRefusal(() => loadConfig(path), PyValueError, /must be an integer, got float/);
    }
  });

  test("an integer literal spelled with a leading minus is still an integer (target-only)", () => {
    // The complement of the case above, so the int check cannot pass by refusing everything: a
    // plain integer literal reaches the non-negative guard rather than the type guard, and the
    // two refusals are different sentences.
    const path = configText("int.json", '{"cooldown_sec": -5}');
    expectRefusal(() => loadConfig(path), PyValueError, /must be non-negative/);
    expect(loadConfig(configText("int2.json", '{"cooldown_sec": 60}')).cooldownSec).toBe(60);
  });

  test("an integer past this runtime's exact range is refused where it is read (target-only)", () => {
    // A deliberate divergence, narrower than the source (D-0905). Python's `int` is
    // arbitrary-precision and loads 9007199254740992 exactly; here it is a `number` whose
    // successor rounds back to itself, and the loader's backward-compat auto-scale computes
    // `floor + 1`. Without this guard the document below is refused anyway -- by the ladder
    // validator, with a message about `max <= min` that names the wrong knob for a value interlock
    // accepts. The refusal fires where the value is read and says what actually happened.
    const path = configText("big.json", '{"pending_decision_min": 9007199254740992}');
    expectRefusal(
      () => loadConfig(path),
      PyValueError,
      /must be an integer this runtime can carry/,
    );
    // The largest value the bound admits still auto-scales to a strictly increasing ladder, which
    // is what the bound is two below MAX_SAFE_INTEGER for.
    const edge = loadConfig(configText("edge.json", '{"pending_decision_min": 9007199254740989}'));
    expect(edge.pendingDecisionMax).toBeGreaterThan(edge.pendingDecisionMin);
    expect(edge.pendingDecisionDrop).toBeGreaterThan(edge.pendingDecisionMax);
  });

  test("a notify or template kind naming an Object.prototype member is not inherited (target-only)", () => {
    // Rule 9: the kind is a caller-supplied string used as a map key, and Python's `dict` has no
    // inherited keys. On an object literal `cfg.notify["constructor"]` answers with a function and
    // `cfg.templates["toString"]` with another, so a kind nobody configured would resolve to a
    // severity and a template nobody wrote.
    const cfg = new AttentionConfig();
    for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(cfg.notify[kind]).toBeUndefined();
      expect(cfg.templates[kind]).toBeUndefined();
      expect(DEFAULT_NOTIFY[kind]).toBeUndefined();
    }
  });

  test("a config document keyed by an Object.prototype member is read as data (target-only)", () => {
    // The other half of rule 9 here, and `__proto__` is the reason it needs its own case: on an
    // object literal `map["__proto__"] = "normal"` SETS THE PROTOTYPE and stores nothing, so the
    // kind the operator configured is silently absent while every other kind in the same document
    // loads fine -- a `notify` override that does nothing, with no error anywhere.
    // Written as JSON TEXT rather than through `JSON.stringify` of an object literal, because a
    // `__proto__` key in a literal sets the prototype and stores nothing -- the fixture would have
    // silently shipped a document that never carried the key under test.
    const path = configText(
      "proto.json",
      '{"notify": {"constructor": "urgent", "__proto__": "normal"},' +
        ' "templates": {"toString": {"title": "t", "body": "b"}}}',
    );
    const cfg = loadConfig(path);
    expect(Object.hasOwn(cfg.notify, "constructor")).toBe(true);
    expect(cfg.notify["constructor"]).toBe("urgent");
    expect(Object.hasOwn(cfg.notify, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(cfg.notify, "__proto__")?.value).toBe("normal");
    expect(cfg.templates["toString"]).toEqual(new Template({ title: "t", body: "b" }));
    // The loader's own presence checks are `Object.hasOwn` rather than `in` for the same reason.
    // None of the ten top-level JSON keys collides with an `Object.prototype` member, so that half
    // is defensive rather than measurable, and this pair says only that a document which
    // configures nothing else leaves the rest at their defaults.
    expect(cfg.desktop).toBe(true);
    expect(cfg.sound).toBe("urgent-only");
  });

  test("a template key present with a null value is refused, not defaulted (target-only)", () => {
    // `tmpl.get("title", "")` defaults only when the KEY IS ABSENT; a key present with `null`
    // gives `None`, which is not a `str`. The obvious `?? ""` translation accepts it as the empty
    // string, so a template whose title the operator nulled out would load with no title at all.
    const path = configFile("null-title.json", {
      templates: { ci_failed: { title: null, body: "b" } },
    });
    expectRefusal(() => loadConfig(path), PyValueError, /must have string/);
    // An ABSENT key still defaults, which is the half that must not change.
    const absent = configFile("no-title.json", { templates: { ci_failed: { body: "b" } } });
    expect(loadConfig(absent).templates["ci_failed"]).toEqual(
      new Template({ title: "", body: "b" }),
    );
  });

  test("the sound refusal prints the modes in sorted order (target-only)", () => {
    // The source builds the message from `sorted(_VALID_SOUND_MODES)` over a frozenset, so the
    // printed order is sorted and not declaration order, and the whole message is what an operator
    // reads to fix their file.
    const path = configFile("bad.json", { sound: "noisy" });
    const error = expectRefusal(() => loadConfig(path), PyValueError);
    expect(error.message).toBe(
      "config.sound must be one of ['all', 'off', 'urgent-only'], got 'noisy'",
    );
  });

  test("the placeholder allowlist is the design's six names (target-only)", () => {
    // Nothing in A2 reads this set -- `notify.render_text` is A3's -- so without a case here the
    // constant could be emptied or misspelled and the whole sub-belt would stay green.
    expect([...ALLOWED_PLACEHOLDERS].sort()).toEqual([
      "kind",
      "pr",
      "status",
      "summary",
      "task_id",
      "worker",
    ]);
  });
});
