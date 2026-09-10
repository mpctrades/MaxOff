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
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(minor));

  const whole = Math.floor(absolute / MINOR_UNITS);
  const cents = absolute % MINOR_UNITS;

  const grouped = new Intl.NumberFormat("en-US", {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(whole);

  return `${sign}${grouped}.${String(cents).padStart(2, "0")} ${currencyCode}`;
}

/** `15%`. Whole numbers only, per §6. */
export function formatPercent(percentage: number): string {
  return `${Math.trunc(percentage)}%`;
}

/**
 * `10 Sep 2026`.
 *
 * Rendered in UTC, not the server's timezone, so a VPS in another zone cannot
 * shift a merchant's date by a day.
 * TODO(sophea): switch to the shop's timezone once it is stored on
 * ShopSettings — same drift as the month boundaries in `home.server.ts`.
 */
export function formatDate(date: Date): string {
  const month = MONTHS[date.getUTCMonth()];
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
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
