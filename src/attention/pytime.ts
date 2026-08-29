/**
 * The two CPython datetime spellings the attention belt needs, in one place.
 *
 * `attention/dedup.py` and `attention/classifier.py` both round-trip an ISO-8601 timestamp
 * through `datetime`, and both depend on CPython's exact answers rather than on JavaScript's:
 *
 * - **`datetime.fromisoformat`** accepts a narrower grammar than `Date.parse`. `Date.parse`
 *   takes shapes `fromisoformat` rejects (`"2026/05/12"`, `"May 12 2026"`, a bare `"12"`) and
 *   reads a naive `"2026-05-12T10:00:00"` as **local** time, where the source attaches UTC. Both
 *   differences move a timestamp across a threshold, and the second moves it by the runner's own
 *   timezone offset -- a green suite in one region and a red one in another.
 * - **`datetime.isoformat`** prints **no** fractional part when the microsecond field is zero and
 *   **six** digits when it is not. `Date#toISOString` always prints exactly three, so a
 *   transcription of `_iso_utc` built on it writes `2026-05-12T12:00:00.000Z` where the source
 *   writes `2026-05-12T12:00:00Z` -- a different byte string in a durable state file.
 *
 * Both are transcriptions of CPython, not conveniences over the platform, and neither is specific
 * to the module that first needed one. They live here rather than privately inside a consumer
 * because two private copies of one CPython function inside one directory is the drift shape this
 * port names repeatedly (`docs/test-translation-conventions.md` rule 11): the copies agree on the
 * day they are written and nothing goes red on the day they stop.
 *
 * **One disclosed divergence, carried rather than repaired here** (recorded in
 * `parity/attention.dedup.ledger.json`): a `Date` resolves to one millisecond and a `datetime` to
 * one microsecond, so a parsed microsecond field is rounded into the millisecond. A timestamp
 * within a fraction of a millisecond of a threshold can be judged on the other side of it from the
 * source. Repairing it means carrying an epoch in microseconds through every consumer instead of a
 * `Date`, which is a change to the belt's shared vocabulary rather than to this file.
 */

import { PyValueError } from "../fencing/pysemantics.js";

/**
 * `datetime.fromisoformat`, accepting a trailing `Z`, with a naive value read as UTC.
 *
 * Written as an explicit grammar for the reason the module header gives. Returns `null` exactly
 * where CPython raises `ValueError`, which is the answer both callers already have a branch for.
 */
export function parseIso(text: string): Date | null {
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
  // malformed-timestamp path a caller's posture depends on. The year bound is `datetime.MINYEAR`,
  // which is 1: `0000-01-01` is a ValueError there and an ordinary date here.
  if (
    year < 1 ||
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
    // Python builds a `timezone` from the offset, and that constructor refuses anything not
    // strictly inside +/- 24 hours. `+24:00` is a two-digit offset the grammar above happily
    // matches, so without this the value would become a real timestamp a day away instead of the
    // malformed one a caller's posture depends on.
    if (offsetSeconds >= 24 * 3600) {
      return null;
    }
    ms -= sign * offsetSeconds * 1000;
  }
  const parsed = new Date(ms);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * interlock `dedup._iso_utc`: `now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")`.
 *
 * The `astimezone` half is free -- a `Date` is an instant with no attached zone, so there is
 * nothing to convert -- and the whole of the transcription is in the rendering rule the module
 * header states.
 *
 * **Refuses an unrepresentable instant rather than writing one** (`docs/test-translation-
 * conventions.md` rule 9). `new Date(NaN)` and a year outside 0000-9999 are values this runtime
 * admits and `datetime` excludes by construction: the first renders as the literal text
 * `"Invalid Date"` and the second in the expanded `+275760-...` form, and either one written into
 * a durable dedup file is a key whose cooldown can never be evaluated again.
 */
export function pyIsoUtc(now: Date): string {
  const rendered = Number.isNaN(now.getTime()) ? "" : now.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(rendered)) {
    throw new PyValueError(
      `attention dedup cannot render ${String(now)} as an ISO-8601 UTC timestamp`,
    );
  }
  const micros = now.getUTCMilliseconds() * 1000;
  const seconds = rendered.slice(0, 19);
  return micros === 0 ? `${seconds}Z` : `${seconds}.${String(micros).padStart(6, "0")}Z`;
}

/** Days in a Gregorian month, so a `2026-02-30` is refused rather than rolled into March. */
function daysInMonth(year: number, month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) {
    return 29;
  }
  return lengths[month - 1] as number;
}
