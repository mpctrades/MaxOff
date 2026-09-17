/**
 * Formatting for merchant-facing values, per BUILD-SPEC §6.
 *
 * Money is integers of minor units everywhere in the app. This module is the
 * only place a minor-unit integer becomes a string, and it never does
 * arithmetic on it beyond splitting whole units from cents — no floats, no
 * `toFixed`.
 *
 * The Function has its own `formatMoney` in `extensions/max-off-cap/src/cap.ts`
 * because `Intl` is not available in the Function runtime. That duplication is
 * deliberate and limited to *formatting*; the cap arithmetic itself stays in
 * one place.
 */

import {
  DEFAULT_TIME_ZONE,
  formatDateInZone,
  zonedParts,
} from "./timezone";

/** Minor units per major unit. §6 fixes money at two decimals. */
const MINOR_UNITS = 100;

/**
 * `1,234.50 USD` — two decimals, thousands separators, currency code after the
 * number and a space. Never `$1,234.50`. Grouping is `en-US` for every
 * currency, which is what the prototype does and what §6 locks in.
 *
 * Amounts relabel, they never convert: the currency code is the store's, and
 * the number is unchanged by it (CLAUDE.md rule 5).
 */
export function formatMoney(minor: number, currencyCode: string): string {
  return `${formatAmount(minor)} ${currencyCode}`;
}

/**
 * `1,600.00` — the same number `formatMoney` renders, without the currency
 * code.
 *
 * For the simulated checkout receipt, where a code on every line is noise a
 * real checkout does not have: the panel names the currency once in its
 * header and the lines under it are bare, exactly as Shopify's own checkout
 * shows them. Everywhere else a figure stands on its own, use `formatMoney` —
 * an amount with no code beside it is a number, not money (rule 5).
 */
export function formatAmount(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(minor));

  const whole = Math.floor(absolute / MINOR_UNITS);
  const cents = absolute % MINOR_UNITS;

  return `${sign}${groupWhole(whole)}.${String(cents).padStart(2, "0")}`;
}

/** `1234` → `1,234`. Grouping is `en-US` for every currency, per §6. */
function groupWhole(whole: number): string {
  return new Intl.NumberFormat("en-US", {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(whole);
}

/**
 * `1,000`, `150.50` — the number with no currency code, and with the cents
 * dropped when they are zero.
 *
 * This is for the arithmetic aside beside the "starts working above" callout,
 * where `150 ÷ 15% = 1,000` has to read as a sum. `150.00 USD ÷ 15% =
 * 1,000.00 USD` reads as a sentence about money instead, and the point of the
 * aside is to show the merchant the division. Everywhere a figure is presented
 * *as* money it goes through `formatMoney`, code and all.
 */
export function formatAmountPlain(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(minor));

  const whole = Math.floor(absolute / MINOR_UNITS);
  const cents = absolute % MINOR_UNITS;

  return cents === 0
    ? `${sign}${groupWhole(whole)}`
    : `${sign}${groupWhole(whole)}.${String(cents).padStart(2, "0")}`;
}

/**
 * `USD` → `USD — US Dollar`, for the store-currency control on settings.
 *
 * The name comes from `Intl.DisplayNames` rather than a table of our own: a
 * hand-kept list of currency names is a list that goes stale, and this one
 * follows the admin's locale for free. Falls back to the bare code if the
 * runtime cannot name it, which is the only part that matters — the code is
 * what MaxOff labels amounts with (rule 5).
 */
export function formatCurrencyChoice(code: string, locale = "en"): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "currency" }).of(code);
    return name && name !== code ? `${code} — ${name}` : code;
  } catch {
    return code;
  }
}

/** `15%`. Whole numbers only, per §6. */
export function formatPercent(percentage: number): string {
  return `${Math.trunc(percentage)}%`;
}

/**
 * `10 Sep 2026`, on the shop's own calendar.
 *
 * `timeZone` is the shop's IANA zone from `ShopSettings`. It defaults to UTC
 * rather than to the server's zone, so a caller that has not been given one
 * still cannot be moved by relocating the VPS.
 *
 * Was UTC-only until 15 Sep 2026, which put a discount starting at the
 * merchant's midnight on the previous day's label for anyone east of
 * Greenwich. See `app/lib/timezone.ts`.
 */
export function formatDate(date: Date, timeZone = DEFAULT_TIME_ZONE): string {
  return formatDateInZone(date, timeZone);
}

/**
 * `22 hours left` / `6 days left` — how much of a free trial remains.
 *
 * Hours below a day, because "0 days left" on the last afternoon of a trial is
 * both true and useless. Rounds up, so a trial is never reported as having
 * less time than it has. Null once it has elapsed, so a caller cannot render
 * a trial that has ended.
 */
export function formatTrialRemaining(
  endsAt: Date,
  now: Date = new Date(),
): string | null {
  const ms = endsAt.getTime() - now.getTime();
  if (ms <= 0) {
    return null;
  }

  const hours = Math.ceil(ms / (60 * 60 * 1000));
  if (hours <= 48) {
    return `${hours} hour${hours === 1 ? "" : "s"} left`;
  }

  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  return `${days} days left`;
}

/**
 * `Jul 7` — a chart axis label.
 *
 * The money-kept chart has eight of these side by side in 10px type, so the
 * year is dropped and the month leads: `Jul 7` reads as a date at a glance
 * where `7/7` has to be decoded, and where `7 Jul` puts eight different digits
 * in the column the eye scans first.
 *
 * Takes the shop's zone for the same reason `formatDate` does: the week
 * buckets in `home.server.ts` are the shop's weeks now, so a bar labelled
 * `Sep 14` has to be the Monday the merchant would call the 14th.
 */
export function formatMonthDay(date: Date, timeZone = DEFAULT_TIME_ZONE): string {
  const { month, day } = zonedParts(date, timeZone);
  return `${MONTHS[month - 1]} ${day}`;
}

/**
 * Written out rather than taken from `Intl`, which abbreviates September as
 * "Sept" in current ICU and would quietly diverge from §6 — and from the same
 * date rendered by an older Node on the VPS.
 */
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

/**
 * `10 Sep – 30 Sep 2026` — the year appears once when both dates share it.
 * An open-ended range reads `From 10 Sep 2026`, because a discount with no end
 * date has not got one, and an em dash there would read as missing data.
 */
export function formatDateRange(startsAt: Date, endsAt: Date | null): string {
  if (endsAt === null) {
    return `From ${formatDate(startsAt)}`;
  }

  const start = formatDate(startsAt);
  const end = formatDate(endsAt);

  const startYear = start.slice(start.lastIndexOf(" ") + 1);
  const endYear = end.slice(end.lastIndexOf(" ") + 1);

  if (startYear === endYear) {
    return `${start.slice(0, start.lastIndexOf(" "))} – ${end}`;
  }

  return `${start} – ${end}`;
}
