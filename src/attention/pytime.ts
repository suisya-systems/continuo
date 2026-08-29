/**
 * The two CPython datetime spellings the attention belt needs, in one place.
 *
 * `attention/dedup.py` and `attention/classifier.py` both round-trip an ISO-8601 timestamp
 * through `datetime`, and both depend on CPython's exact answers rather than on JavaScript's:
 *
 * - **`datetime.fromisoformat`** and `Date.parse` disagree in BOTH directions. `Date.parse` takes
 *   shapes `fromisoformat` rejects (`"05/12/2026"`, `"May 12 2026"`) and rolls an impossible date
 *   forward (`2026-02-30` becomes March 2) where `fromisoformat` raises; and `fromisoformat`
 *   accepts a much wider ISO grammar than `Date.parse` does -- basic format (`20260512T115900`),
 *   ISO week dates (`2026-W20-2`), an hour-only time, any single character as the date/time
 *   separator. It also reads a naive `"2026-05-12T11:59:00"` as **local** time where the source
 *   attaches UTC. Every one of those differences moves a timestamp across a threshold, and the
 *   last one moves it by the runner's own timezone offset -- a green suite in one region and a red
 *   one in another.
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
 * Written as an explicit grammar rather than handed to `Date.parse`, for the reason the module
 * header gives. Returns `null` exactly where CPython raises `ValueError`, which is the answer both
 * callers already have a branch for.
 *
 * **The grammar was measured against CPython 3.12.3 rather than recalled**, because the shape a
 * careful person writes from memory -- extended calendar dates and a `T` separator -- is a small
 * subset of what `fromisoformat` takes, and every form it leaves out is a stored value this port
 * would treat as garbled while the source read it as a real timestamp. What CPython 3.12 accepts,
 * and what this transcribes:
 *
 * - **date**: `YYYY-MM-DD` or `YYYYMMDD`; ISO week dates `YYYY-Www-D`, `YYYYWwwD`, `YYYY-Www` and
 *   `YYYYWww` (a week with no day is that week's Monday). Ordinal dates (`2026-132`) are NOT
 *   accepted, measured. Separators must be consistent within the date.
 * - **separator**: any single character, not only `T` and space -- `"2026-05-12x11:59:00"` parses.
 * - **time**: `HH`, `HH:MM`, `HHMM`, `HH:MM:SS`, `HHMMSS`, each optionally followed by `.` or `,`
 *   and one or more digits, TRUNCATED (not rounded) to six.
 * - **offset**: `Z` (uppercase only -- a lowercase `z` raises), or a sign followed by `HH`,
 *   `HH:MM`, `HHMM`, `HH:MM:SS`, `HHMMSS`, optionally with a fractional second, and strictly
 *   inside +/- 24 hours.
 */
export function parseIso(text: string): Date | null {
  const date = matchDate(text);
  if (date === null) {
    return null;
  }
  let hour = 0;
  let minute = 0;
  let second = 0;
  let micros = 0;
  let offsetSeconds = 0;
  const rest = text.slice(date.length);
  if (rest !== "") {
    // Any single character separates the date from the time, measured: CPython checks only that
    // one character is there, so `"2026-05-12x11:59:00"` is a real timestamp to the source.
    const time = matchTime(rest.slice(1));
    if (time === null) {
      return null;
    }
    hour = time.hour;
    minute = time.minute;
    second = time.second;
    micros = time.micros;
    offsetSeconds = time.offsetSeconds;
  }
  // Checked before the arithmetic, because `Date.UTC` rolls a month 13 or a day 32 FORWARD where
  // `fromisoformat` raises -- so a typo would become a real timestamp a month away rather than the
  // malformed-timestamp path a caller's posture depends on. The year bound is `datetime.MINYEAR`,
  // which is 1: `0000-01-01` is a ValueError there and an ordinary date here.
  if (
    date.year < 1 ||
    date.month < 1 ||
    date.month > 12 ||
    date.day < 1 ||
    date.day > daysInMonth(date.year, date.month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  let ms = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    hour,
    minute,
    second,
    Math.round(micros / 1000),
  );
  if (date.year < 100) {
    // `Date.UTC` maps years 0-99 into 1900-1999; `fromisoformat` does not.
    ms = new Date(ms).setUTCFullYear(date.year);
  }
  ms -= Math.round(offsetSeconds * 1000);
  const parsed = new Date(ms);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A calendar date and how many characters of the input it consumed. */
interface DatePart {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly length: number;
}

/**
 * The date half, in the four spellings CPython accepts.
 *
 * Tried longest-first among the shapes that could otherwise claim a prefix of each other. The
 * calendar alternatives cannot collide -- the extended one needs a `-` where the basic one needs a
 * digit -- but a week date must be tried before the basic calendar date, because `2026W202` and
 * `20260512` are both eight characters.
 */
function matchDate(text: string): DatePart | null {
  const week = /^(\d{4})(-)?W(\d{2})(?:(-(?=\d))?(\d))?/.exec(text);
  if (week !== null) {
    // Separators must be consistent: `2026-W202` and `2026W20-2` are not ISO. `week[2]` is the
    // date's separator and `week[4]` the day's, and each is present or absent together.
    const extended = week[2] !== undefined;
    if (week[5] !== undefined && (week[4] !== undefined) !== extended) {
      return null;
    }
    const resolved = fromIsoWeek(Number(week[1]), Number(week[3]), Number(week[5] ?? "1"));
    return resolved === null ? null : { ...resolved, length: week[0].length };
  }
  const extended = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (extended !== null) {
    return {
      year: Number(extended[1]),
      month: Number(extended[2]),
      day: Number(extended[3]),
      length: 10,
    };
  }
  const basic = /^(\d{4})(\d{2})(\d{2})/.exec(text);
  if (basic !== null) {
    return { year: Number(basic[1]), month: Number(basic[2]), day: Number(basic[3]), length: 8 };
  }
  return null;
}

/** The time half plus its UTC offset in seconds; a naive value reads as UTC, per the source. */
interface TimePart {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly micros: number;
  readonly offsetSeconds: number;
}

function matchTime(text: string): TimePart | null {
  const match =
    /^(\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?|(\d{2})(?:(\d{2})(?:[.,](\d+))?)?)?(Z|[+-]\d{2}(?::\d{2}(?::\d{2}(?:[.,]\d+)?)?|\d{2}(?:\d{2}(?:[.,]\d+)?)?)?)?$/.exec(
      text,
    );
  if (match === null) {
    return null;
  }
  // CPython TRUNCATES a fractional second past six digits rather than rounding, measured:
  // `.9999999` is 999999 microseconds and not a carried second.
  const fraction = match[4] ?? match[7] ?? "";
  const zone = match[8];
  return {
    hour: Number(match[1]),
    minute: Number(match[2] ?? match[5] ?? "0"),
    second: Number(match[3] ?? match[6] ?? "0"),
    micros: fraction === "" ? 0 : Number(fraction.slice(0, 6).padEnd(6, "0")),
    offsetSeconds: zone === undefined || zone === "Z" ? 0 : offsetOf(zone),
  };
}

/**
 * A `+HH[:MM[:SS[.ffffff]]]` offset, in seconds, or `NaN` for one CPython refuses.
 *
 * Python builds a `timezone` from the offset, and that constructor refuses anything not strictly
 * inside +/- 24 hours. `+24:00` is a two-digit offset the grammar above happily matches, so
 * without this the value would become a real timestamp a day away instead of the malformed one a
 * caller's posture depends on.
 */
function offsetOf(zone: string): number {
  const match = /^([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?(?:[.,](\d+))?$/.exec(zone);
  if (match === null) {
    return Number.NaN;
  }
  const fraction = match[5] ?? "";
  const seconds =
    Number(match[2]) * 3600 +
    Number(match[3] ?? "0") * 60 +
    Number(match[4] ?? "0") +
    // A sub-second offset is a real `timedelta` in CPython (`+23:59:59.999999` parses), and
    // dropping it puts the instant a whole second away rather than a microsecond. What this
    // runtime cannot carry below a millisecond is the same disclosed rounding the module header
    // records for the timestamp itself.
    (fraction === "" ? 0 : Number(`0.${fraction}`));
  return seconds >= 24 * 3600 ? Number.NaN : (match[1] === "-" ? -1 : 1) * seconds;
}

/**
 * An ISO week date as a calendar date, or `null` for a week the year does not have.
 *
 * Week 1 is the week containing 4 January, so the Monday of week 1 is 4 January minus its own
 * weekday offset. A year has 53 weeks only when 1 January is a Thursday, or when it is a leap year
 * whose 1 January is a Wednesday; `2027-W53-1` is a `ValueError` in CPython, measured, and would
 * otherwise silently become a date in 2028.
 */
function fromIsoWeek(
  year: number,
  week: number,
  day: number,
): { year: number; month: number; day: number } | null {
  if (year < 1 || week < 1 || week > weeksInIsoYear(year) || day < 1 || day > 7) {
    return null;
  }
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = ((new Date(jan4).getUTCDay() + 6) % 7) + 1; // Monday = 1
  const ms = jan4 + ((week - 1) * 7 + (day - jan4Weekday)) * 86_400_000;
  const resolved = new Date(ms);
  return {
    year: resolved.getUTCFullYear(),
    month: resolved.getUTCMonth() + 1,
    day: resolved.getUTCDate(),
  };
}

/** 53 when 1 January is a Thursday, or a leap year's 1 January is a Wednesday; 52 otherwise. */
function weeksInIsoYear(year: number): number {
  const weekdayOfJan1 = (y: number): number =>
    ((new Date(Date.UTC(y, 0, 1)).getUTCDay() + 6) % 7) + 1;
  return weekdayOfJan1(year) === 4 || (isLeapYear(year) && weekdayOfJan1(year) === 3) ? 53 : 52;
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
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return lengths[month - 1] as number;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
