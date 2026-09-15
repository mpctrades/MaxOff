/**
 * The shop's timezone, and every date decision that depends on it.
 *
 * Until 15 Sep 2026 MaxOff did all of its date arithmetic in UTC and said so
 * in two `TODO(sophea)` comments — one in `format.ts`, one in
 * `home.server.ts`. UTC was the honest placeholder, because the alternative on
 * a VPS is the *server's* zone, which moves when the server moves. But it was
 * still wrong in a way a merchant feels:
 *
 * - A shop in Phnom Penh (UTC+7) sets a discount to start on 10 Sep at 00:00.
 *   `combineDateTime` read that as 10 Sep 00:00 **UTC**, so the discount went
 *   live at 07:00 local — seven hours into the day the merchant chose.
 * - An end date of 30 Sep 23:59 expired at 06:59 on 1 October, local.
 * - "This month" on Home turned over seven hours late.
 *
 * Nothing was lost or double-counted; every boundary was simply in the wrong
 * place. This module puts them in the right one.
 *
 * There is no date library here on purpose (rule 9: ask before adding a
 * dependency). `Intl.DateTimeFormat` already knows every IANA zone and its DST
 * history, and it ships with Node and every browser, so the two functions
 * below are all the arithmetic MaxOff needs.
 */

/** What a shop gets before Shopify has told us otherwise. */
export const DEFAULT_TIME_ZONE = "UTC";

/** Month names, matching what `format.ts` has always printed. */
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const MINUTE_MS = 60 * 1000;

/**
 * Whether a string is a zone this runtime can actually resolve.
 *
 * Shopify sends a real IANA name, so this is not defensive about Shopify — it
 * is defensive about a column. A shop row written before this field existed,
 * or hand-edited, must never throw inside a loader and take a whole page down
 * over a date label.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Anything unreadable is UTC — never the server's own zone, which moves. */
export function toTimeZone(value: string | null | undefined): string {
  return isValidTimeZone(value) ? value : DEFAULT_TIME_ZONE;
}

/** A wall-clock reading: what a clock on the shop's wall says at an instant. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * What the clock reads in `timeZone` at instant `date`.
 *
 * `formatToParts` rather than string parsing, because the formatted order
 * differs by locale and the parts do not.
 */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: toTimeZone(timeZone),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const found: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      found[part.type] = Number(part.value);
    }
  }

  return {
    year: found.year,
    month: found.month,
    day: found.day,
    // `hour12: false` still yields 24 for midnight in some ICU versions, which
    // would push a day boundary a whole day out if it reached the arithmetic.
    hour: found.hour === 24 ? 0 : found.hour,
    minute: found.minute,
  };
}

/**
 * The instant at which the shop's clock reads this wall time.
 *
 * The inverse of `zonedParts`, and the one that actually moves money-adjacent
 * behaviour: it is what turns "10 Sep, 00:00" in the merchant's head into the
 * UTC instant Shopify stores as `startsAt`.
 *
 * Two passes, because a zone's offset depends on the instant and the instant
 * is what we are solving for. The first pass guesses using the offset at the
 * naive UTC reading; the second corrects it when that guess landed on the
 * other side of a DST transition. Cambodia has no DST, so the second pass is
 * a no-op there — it is here so that a merchant in Santiago or Auckland is not
 * an hour out twice a year.
 */
export function zonedTimeToUtc(
  parts: ZonedParts,
  timeZone: string,
): Date {
  const zone = toTimeZone(timeZone);

  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );

  const firstOffset = offsetMinutesAt(new Date(naive), zone);
  const firstGuess = naive - firstOffset * MINUTE_MS;

  const secondOffset = offsetMinutesAt(new Date(firstGuess), zone);
  if (secondOffset === firstOffset) {
    return new Date(firstGuess);
  }

  return new Date(naive - secondOffset * MINUTE_MS);
}

/**
 * How far ahead of UTC `zone` is at this instant, in minutes.
 *
 * Read by formatting the instant in the zone and diffing the wall clock that
 * comes back against the instant itself — the only way to ask `Intl` for an
 * offset without parsing a localised "GMT+7" string.
 */
function offsetMinutesAt(date: Date, zone: string): number {
  const parts = zonedParts(date, zone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );

  // The seconds and milliseconds of `date` are not in `parts`, so they have to
  // come off the other side of the subtraction or every offset is a fraction.
  const truncated =
    date.getTime() - (date.getUTCSeconds() * 1000 + date.getUTCMilliseconds());

  return Math.round((asIfUtc - truncated) / MINUTE_MS);
}

/** `10 Sep 2026`, as the shop's own calendar reads it. */
export function formatDateInZone(date: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** `2026-09-10`, for a date input prefilled with the shop's today. */
export function isoDateInZone(date: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** `09:30`, the shop's wall clock at an instant. */
export function timeInZone(date: Date, timeZone: string): string {
  const { hour, minute } = zonedParts(date, timeZone);
  return `${pad(hour)}:${pad(minute)}`;
}

/**
 * Midnight on the first of the month, in the shop's zone, as a UTC instant.
 *
 * `monthOffset` counts whole months from the month containing `from`, so -1 is
 * last month. Month arithmetic is done on the civil date and handed to
 * `zonedTimeToUtc`, which is what keeps "1 September, 00:00 in Phnom Penh"
 * from becoming "1 September, 00:00 UTC".
 */
export function startOfMonthInZone(
  from: Date,
  timeZone: string,
  monthOffset = 0,
): Date {
  const { year, month } = zonedParts(from, timeZone);

  // Date.UTC normalises an out-of-range month, so December + 1 rolls the year.
  const normalised = new Date(Date.UTC(year, month - 1 + monthOffset, 1));

  return zonedTimeToUtc(
    {
      year: normalised.getUTCFullYear(),
      month: normalised.getUTCMonth() + 1,
      day: 1,
      hour: 0,
      minute: 0,
    },
    timeZone,
  );
}

/**
 * Midnight on the Monday of the week containing `from`, in the shop's zone.
 *
 * The weekday is computed from the *civil* date rather than from the instant:
 * `Date.UTC(y, m, d).getUTCDay()` is the weekday of that calendar date, which
 * is exactly the question being asked, and asking the instant instead would
 * give the wrong day for anyone whose local date differs from UTC's.
 */
export function startOfWeekInZone(
  from: Date,
  timeZone: string,
  weekOffset = 0,
): Date {
  const { year, month, day } = zonedParts(from, timeZone);

  const civil = new Date(Date.UTC(year, month - 1, day));
  // getUTCDay() is 0 on Sunday, which is six days into a Monday-start week.
  const daysSinceMonday = (civil.getUTCDay() + 6) % 7;

  const monday = new Date(
    civil.getTime() + (weekOffset * 7 - daysSinceMonday) * 24 * 60 * MINUTE_MS,
  );

  return zonedTimeToUtc(
    {
      year: monday.getUTCFullYear(),
      month: monday.getUTCMonth() + 1,
      day: monday.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    timeZone,
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
