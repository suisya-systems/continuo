/**
 * Ported from interlock `tests/attention/test_dedup.py` at `65f36c5` -- 10 cases.
 *
 * The ledger is `parity/attention.dedup.ledger.json`. Eight cases are straight translations; two
 * are `adapted` and assert the **opposite** of their source, because `D-0034` ratified the
 * fail-closed repair of the inherited "malformed state loads as an empty `DedupState`" defect
 * inside this sub-belt and `D-0023` requires the case that pinned an inherited behaviour to be
 * inverted in the change that repairs it. `D-0904` records where the new boundary falls.
 *
 * The target-only cases below are the rest of that repair plus this port's rule-9 exposures; each
 * is there because a mutation showed the property was otherwise unprotected, and each probe is
 * recorded in the ledger.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DedupState,
  DedupStateRefused,
  loadState,
  recordNotified,
  saveState,
  shouldNotify,
} from "../../src/attention/dedup.js";
import { parseIso } from "../../src/attention/pytime.js";
import { PyValueError } from "../../src/fencing/pysemantics.js";
import { caseRoot } from "../testkit/cases.js";
import { expectRefusal } from "../testkit/errors.js";

/** The source's module-level `_NOW`. */
const NOW = new Date("2026-05-12T12:00:00Z");

/** The source's `timedelta(seconds=n)` / `timedelta(days=n)`, as an offset from `NOW`. */
function plusSeconds(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1000);
}

/** Everything in the case's directory other than the state file itself. */
function leftovers(root: string, name: string): string[] {
  return readdirSync(root).filter((entry) => entry !== name);
}

describe("attention dedup", () => {
  test("a missing file loads as empty state", () => {
    const state = loadState(join(caseRoot("dedup"), "missing.json"));
    expect(state).toEqual(new DedupState());
  });

  test("state round-trips through save and load", () => {
    const path = join(caseRoot("dedup"), "attention_notified.json");
    const state = new DedupState({
      events: { "event:1": "2026-05-12T10:00:00Z" },
      pending: { "pending:t:pending_decision": "2026-05-12T10:00:00Z" },
    });
    saveState(path, state);
    const loaded = loadState(path);
    expect({ ...loaded.events }).toEqual({ ...state.events });
    expect({ ...loaded.pending }).toEqual({ ...state.pending });
  });

  test("malformed JSON is refused, not read as empty state", () => {
    const path = join(caseRoot("dedup"), "broken.json");
    writeFileSync(path, "{ this is not json", "utf8");
    expectRefusal(() => loadState(path), DedupStateRefused, /is not valid JSON/);
    expectRefusal(
      () => loadState(path),
      DedupStateRefused,
      /refusing to continue with empty state/,
    );
  });

  test("a top-level that is not an object is refused, not read as empty state", () => {
    const path = join(caseRoot("dedup"), "arr.json");
    writeFileSync(path, JSON.stringify([1, 2, 3]), "utf8");
    expectRefusal(() => loadState(path), DedupStateRefused, /top-level is not a JSON object/);
  });

  test("a document carrying only one namespace loads with the other empty", () => {
    const path = join(caseRoot("dedup"), "partial.json");
    writeFileSync(path, JSON.stringify({ events: { "event:5": "2026-01-01T00:00:00Z" } }), "utf8");
    const state = loadState(path);
    expect({ ...state.events }).toEqual({ "event:5": "2026-01-01T00:00:00Z" });
    expect({ ...state.pending }).toEqual({});
  });

  test("an event recorded once is never notified again", () => {
    const state = new DedupState();
    expect(
      shouldNotify(state, "event:7", { source: "state.db.events", cooldownSec: 300, now: NOW }),
    ).toBe(true);
    recordNotified(state, "event:7", { source: "state.db.events", now: NOW });
    expect(
      shouldNotify(state, "event:7", {
        source: "state.db.events",
        cooldownSec: 300,
        now: plusSeconds(365 * 24 * 60 * 60),
      }),
    ).toBe(false);
  });

  test("a pending key inside its cooldown window is blocked", () => {
    const state = new DedupState();
    const key = "pending:T:pending_decision";
    recordNotified(state, key, { source: "pending_decisions", now: NOW });
    expect(
      shouldNotify(state, key, {
        source: "pending_decisions",
        cooldownSec: 300,
        now: plusSeconds(200),
      }),
    ).toBe(false);
  });

  test("a pending key past its cooldown window notifies again", () => {
    const state = new DedupState();
    const key = "pending:T:pending_decision";
    recordNotified(state, key, { source: "pending_decisions", now: NOW });
    expect(
      shouldNotify(state, key, {
        source: "pending_decisions",
        cooldownSec: 300,
        now: plusSeconds(400),
      }),
    ).toBe(true);
  });

  test("a garbled stored timestamp counts as never notified", () => {
    const state = new DedupState({ pending: { "pending:X:pending_decision": "garbled" } });
    expect(
      shouldNotify(state, "pending:X:pending_decision", {
        source: "pending_decisions",
        cooldownSec: 300,
        now: NOW,
      }),
    ).toBe(true);
  });

  test("save replaces an existing file and leaves no temporary behind", () => {
    const root = caseRoot("dedup");
    const path = join(root, "attention_notified.json");
    writeFileSync(path, "old content", "utf8");
    saveState(path, new DedupState({ events: { "event:1": "2026-05-12T10:00:00Z" } }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      events: { "event:1": "2026-05-12T10:00:00Z" },
      pending: {},
    });
    expect(leftovers(root, "attention_notified.json")).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Target-only. Not counted as ported coverage; see the ledger.
  // -------------------------------------------------------------------------

  test("a blank file is refused rather than read as empty state (target-only, D-0904)", () => {
    const path = join(caseRoot("dedup"), "blank.json");
    writeFileSync(path, "   \n\t\n", "utf8");
    expectRefusal(() => loadState(path), DedupStateRefused, /is blank/);
  });

  test("an unreadable file is refused rather than read as empty state (target-only, D-0904)", () => {
    // A directory where the state file should be: `readFileSync` raises `EISDIR`, which is the
    // `OSError` branch the source downgrades to a warning. Chosen over a permission bit because a
    // suite that happens to run as root reads a 0000 file happily and the case would pass for the
    // wrong reason.
    const path = join(caseRoot("dedup"), "attention_notified.json");
    mkdirSync(path);
    expectRefusal(() => loadState(path), DedupStateRefused, /cannot read attention dedup state/);
  });

  test("a namespace that is present but not an object is refused (target-only, D-0904)", () => {
    for (const document of [{ events: 42 }, { pending: ["a"] }, { events: null }]) {
      const path = join(caseRoot("dedup"), "wrong-namespace.json");
      writeFileSync(path, JSON.stringify(document), "utf8");
      expectRefusal(() => loadState(path), DedupStateRefused, /is not a JSON object/);
    }
  });

  test("a namespace entry that is not a string is refused (target-only, D-0904)", () => {
    for (const document of [
      { events: { "event:1": 5 } },
      { pending: { "pending:a:b": null } },
      { events: { "event:1": { at: "2026-05-12T10:00:00Z" } } },
    ]) {
      const path = join(caseRoot("dedup"), "wrong-entry.json");
      writeFileSync(path, JSON.stringify(document), "utf8");
      expectRefusal(() => loadState(path), DedupStateRefused, /is not a string/);
    }
  });

  test("a dedup key naming an Object.prototype member is not already notified (target-only)", () => {
    // `docs/test-translation-conventions.md` rule 9. Python's `dict` has no inherited keys; an
    // object literal carries `Object.prototype`, so `state.events["constructor"]` would be truthy
    // for a state nobody has written to and the event would be suppressed forever.
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(
        shouldNotify(new DedupState(), key, {
          source: "state.db.events",
          cooldownSec: 300,
          now: NOW,
        }),
      ).toBe(true);
      expect(
        shouldNotify(new DedupState(), key, {
          source: "pending_decisions",
          cooldownSec: 300,
          now: NOW,
        }),
      ).toBe(true);
    }
  });

  test("a key naming an Object.prototype member round-trips through the file (target-only)", () => {
    const path = join(caseRoot("dedup"), "attention_notified.json");
    const state = new DedupState();
    recordNotified(state, "__proto__", { source: "state.db.events", now: NOW });
    recordNotified(state, "constructor", { source: "pending_decisions", now: NOW });
    saveState(path, state);
    const loaded = loadState(path);
    expect(Object.hasOwn(loaded.events, "__proto__")).toBe(true);
    expect(Object.hasOwn(loaded.pending, "constructor")).toBe(true);
    expect(
      shouldNotify(loaded, "constructor", {
        source: "pending_decisions",
        cooldownSec: 300,
        now: plusSeconds(200),
      }),
    ).toBe(false);
  });

  test("a cooldown that is not a non-negative integer is refused (target-only)", () => {
    // Rule 9 again, in the direction that loses an alarm: the source types `cooldown_sec` `int`,
    // and `NaN` makes every `>=` false, so a single unvalidated value silently suppresses every
    // pending notification for the life of the process with nothing red anywhere.
    const state = new DedupState({ pending: { "pending:T:k": "2026-05-12T10:00:00Z" } });
    for (const cooldownSec of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
      expectRefusal(
        () =>
          shouldNotify(state, "pending:T:k", {
            source: "pending_decisions",
            cooldownSec,
            now: NOW,
          }),
        DedupStateRefused,
        /cooldownSec must be a non-negative integer/,
      );
    }
  });

  test("a recorded timestamp is spelled the way datetime.isoformat spells it (target-only)", () => {
    // `Date#toISOString` always prints three fractional digits; `datetime.isoformat` prints none
    // when the microsecond field is zero and six when it is not. The stored text is a durable
    // value another reader parses, so the spelling is part of the contract.
    const state = new DedupState();
    recordNotified(state, "event:1", { source: "state.db.events", now: NOW });
    recordNotified(state, "event:2", {
      source: "state.db.events",
      now: new Date("2026-05-12T12:00:00.250Z"),
    });
    expect(state.events["event:1"]).toBe("2026-05-12T12:00:00Z");
    expect(state.events["event:2"]).toBe("2026-05-12T12:00:00.250000Z");
  });

  test("an instant datetime could not hold is refused rather than recorded (target-only)", () => {
    // Rule 9: `new Date(NaN)` renders as the literal text "Invalid Date" and a year past 9999 in
    // the expanded `+275760-...` form. Either one written into the file is a key whose cooldown
    // can never be evaluated again.
    for (const now of [new Date(Number.NaN), new Date(8.64e15)]) {
      expectRefusal(
        () => recordNotified(new DedupState(), "event:1", { source: "state.db.events", now }),
        PyValueError,
        /as an ISO-8601 UTC timestamp/,
      );
    }
  });

  test("a stored timestamp is read by fromisoformat's grammar, not Date.parse's (target-only)", () => {
    // `Date.parse` accepts shapes `datetime.fromisoformat` rejects, and rolls an impossible date
    // forward where `fromisoformat` raises. Both turn a garbled value into a recent timestamp,
    // which BLOCKS the notification the source's garbled path deliberately lets through.
    for (const stored of [
      "05/12/2026 11:59:00",
      "May 12 2026 11:59:00 UTC",
      "2026-02-30T11:59:00Z",
    ]) {
      expect(
        shouldNotify(new DedupState({ pending: { "pending:X:k": stored } }), "pending:X:k", {
          source: "pending_decisions",
          cooldownSec: 300,
          now: NOW,
        }),
      ).toBe(true);
    }
  });

  test("a naive stored timestamp is read as UTC, not as the runner's local time (target-only)", () => {
    // `new Date("2026-05-12T11:59:00")` is LOCAL time in this runtime and UTC in the source's
    // `astimezone` on a naive value. On a runner east of Greenwich the local reading is hours
    // older, so the cooldown looks elapsed and the notification fires again.
    expect(
      shouldNotify(
        new DedupState({ pending: { "pending:X:k": "2026-05-12T11:59:00" } }),
        "pending:X:k",
        {
          source: "pending_decisions",
          cooldownSec: 300,
          now: NOW,
        },
      ),
    ).toBe(false);
  });

  test("a byte that is not UTF-8 is refused even inside a valid JSON string (target-only)", () => {
    // `readFileSync(path, "utf8")` substitutes U+FFFD for an undecodable byte and carries on. When
    // the byte sits INSIDE a JSON string the document stays syntactically valid, so the parse
    // succeeds and the state loads with a dedup key that is not the key that was written -- an
    // already-notified event free to fire again, which is the one outcome this module exists to
    // prevent. The file is read as bytes and decoded fatally instead.
    const path = join(caseRoot("dedup"), "attention_notified.json");
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from('{"events": {"event:', "utf8"),
        Buffer.from([0xff]),
        Buffer.from('1": "2026-05-12T10:00:00Z"}}', "utf8"),
      ]),
    );
    expectRefusal(() => loadState(path), DedupStateRefused, /cannot read attention dedup state/);
  });

  test("an invalid now is refused rather than suppressing the notification (target-only)", () => {
    // Rule 9 on the clock argument. `new Date(NaN).getTime()` is `NaN`, so the cooldown comparison
    // is false for every key at every age -- the notification silently suppressed. `recordNotified`
    // already refuses the same value; the read path has to give the same answer.
    const state = new DedupState({ pending: { "pending:T:k": "2026-05-12T10:00:00Z" } });
    expectRefusal(
      () =>
        shouldNotify(state, "pending:T:k", {
          source: "pending_decisions",
          cooldownSec: 300,
          now: new Date(Number.NaN),
        }),
      DedupStateRefused,
      /now must be a valid instant/,
    );
  });

  test("the stored-timestamp grammar is fromisoformat's, measured against CPython (target-only)", () => {
    // `datetime.fromisoformat` accepts far more than the shape a careful person writes from
    // memory, and every form left out is a stored value this port would treat as garbled -- an
    // extra notification where the source applies the cooldown. The table is MEASURED, not
    // recalled: produced by `python3 -c 'datetime.fromisoformat(...)'` on CPython 3.12.3, the
    // interpreter interlock's own suite runs on at 65f36c5, over 68 inputs; these are the rows
    // that distinguish this grammar from the one a translation reaches for first, plus the
    // refusals that must stay refusals.
    const table: readonly (readonly [string, string | null])[] = [
      ["2026-05-12T11:59:00Z", "2026-05-12T11:59:00.000Z"],
      ["2026-05-12", "2026-05-12T00:00:00.000Z"],
      ["20260512", "2026-05-12T00:00:00.000Z"],
      ["20260512T115900", "2026-05-12T11:59:00.000Z"],
      ["2026-05-12T115900", "2026-05-12T11:59:00.000Z"],
      ["2026-05-12T1159", "2026-05-12T11:59:00.000Z"],
      ["2026-05-12T11", "2026-05-12T11:00:00.000Z"],
      ["2026-05-12x11:59:00", "2026-05-12T11:59:00.000Z"],
      ["2026-W20-2", "2026-05-12T00:00:00.000Z"],
      ["2026W202", "2026-05-12T00:00:00.000Z"],
      ["2026-W20", "2026-05-11T00:00:00.000Z"],
      ["2026-W53-1", "2026-12-28T00:00:00.000Z"],
      ["2026-05-12T11:59:00+09", "2026-05-12T02:59:00.000Z"],
      ["2026-05-12T11:59:00+090030", "2026-05-12T02:58:30.000Z"],
      ["2026-05-12T11:59:00,123", "2026-05-12T11:59:00.123Z"],
      ["2026-05-12T11:59:00.9999999", "2026-05-12T11:59:01.000Z"],
      // Refused by CPython, and each would become a real timestamp under a looser reading.
      ["20260512115900", null],
      ["2027-W53-1", null],
      ["2026-W20-8", null],
      ["2026-05-12T11:59:00z", null],
      ["2026-05-12T11:59:00+24:00", null],
      ["2026-05-12T24:00:00", null],
      ["2026-132", null],
      ["2026-0512", null],
      [" 2026-05-12", null],
      ["05/12/2026 11:59:00", null],
    ];
    for (const [text, expected] of table) {
      const parsed = parseIso(text);
      expect(parsed === null ? null : parsed.toISOString(), text).toBe(expected);
    }
  });

  test("a failed write leaves no temporary file behind (target-only)", () => {
    // The source's `except OSError: unlink(tmp); raise`. Without the unlink a refused save leaves
    // a `.attention_notified.*` fragment behind on every attempt, and the directory fills with
    // half-states nobody will ever read.
    //
    // The failure has to happen AFTER the temporary file exists, or the case passes for free: a
    // first draft made the SERIALISER throw, which is evaluated before the file is created, and
    // the probe measured it green with the unlink removed (`docs/test-translation-conventions.md`
    // rule 10). A non-empty directory standing where the state file belongs fails the rename
    // instead, which is the one step that runs with the temporary already on disk.
    const root = caseRoot("dedup");
    const path = join(root, "attention_notified.json");
    mkdirSync(path);
    writeFileSync(join(path, "occupied"), "x", "utf8");
    expect(() =>
      saveState(path, new DedupState({ events: { "event:1": "2026-05-12T10:00:00Z" } })),
    ).toThrow();
    expect(leftovers(root, "attention_notified.json")).toEqual([]);
  });
});
