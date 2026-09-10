/**
 * Cap arithmetic and status derivation, shared by every admin screen.
 *
 * The Function has its own copy of the *arithmetic* in
 * `extensions/max-off-cap/src/cap.ts`, because it runs in a different runtime
 * with no `Intl` and its own generated types. That duplication is deliberate
 * and documented (BUILD-SPEC §8: "The Function has its own implementation in
 * its own language — test it against the same table"). What must never happen
 * is two copies inside the admin: the list, the detail page and the create
 * preview all import this file.
 */

/** Minor units per major unit. §6 fixes money at two decimals. */
const MINOR_UNITS = 100;

/**
 * "Cap starts above" in minor units: the cart size at which the maximum starts
 * to bite, `cap ÷ (percentage / 100)`.
 *
 * Integer arithmetic with one half-up rounding, so a 150.00 maximum at 15%
 * gives exactly 1,000.00 rather than 999.99. Returns null when the percentage
 * is zero — §8 requires an em dash there, never `Infinity` or `NaN`.
 *
 * Never called "break-even" in anything a merchant reads (§11).
 */
export function capStartsAboveMinor(
  capMinor: number,
  percentage: number,
): number | null {
  if (percentage <= 0) {
    return null;
  }

  return Math.floor(
    (capMinor * MINOR_UNITS * 2 + percentage) / (percentage * 2),
  );
}

/** The four states a merchant sees. Only two of them are ever stored. */
export type DisplayStatus = "active" | "scheduled" | "paused" | "expired";

export const DISPLAY_STATUSES: DisplayStatus[] = [
  "active",
  "scheduled",
  "paused",
  "expired",
];

/**
 * The list's tabs: every display status, plus "all".
 *
 * These live here rather than in `discounts.server.ts` because the list
 * component renders them, and a route component that imports a value from a
 * `.server` module cannot be split from it — the client build fails outright.
 */
export type DiscountTab = "all" | DisplayStatus;

export const DISCOUNT_TABS: DiscountTab[] = ["all", ...DISPLAY_STATUSES];

export function isDiscountTab(value: string | null): value is DiscountTab {
  return value !== null && (DISCOUNT_TABS as string[]).includes(value);
}

/** Sentence-case tab labels, as the mockup's tab strip reads. */
export const DISCOUNT_TAB_LABELS: Record<DiscountTab, string> = {
  all: "All",
  active: "Active",
  scheduled: "Scheduled",
  paused: "Paused",
  expired: "Expired",
};

export interface StatusInput {
  /** The stored column: the merchant's intent, "active" or "paused". */
  status: string;
  startsAt: Date;
  endsAt: Date | null;
}

/**
 * The status to show, derived at read time.
 *
 * `CappedDiscount.status` caches what the merchant *chose* — active or paused,
 * the only two states a human sets. "Scheduled" and "expired" are facts about
 * the clock, and nothing updates a row when the clock passes it: there is no
 * cron, so a stored "scheduled" would still say "scheduled" the day after the
 * discount went live. Deriving them means the list cannot go stale.
 *
 * A row that still carries a stored "scheduled" or "expired" from an earlier
 * write is read as intent-active and re-derived from its dates, which is what
 * the merchant meant when they set it.
 */
export function displayStatus(
  discount: StatusInput,
  now: Date,
): DisplayStatus {
  if (discount.status === "paused") {
    return "paused";
  }

  if (discount.startsAt.getTime() > now.getTime()) {
    return "scheduled";
  }

  if (discount.endsAt !== null && discount.endsAt.getTime() <= now.getTime()) {
    return "expired";
  }

  return "active";
}

/** Sentence-case label for a status, as the mockup's pills read. */
export function displayStatusLabel(status: DisplayStatus): string {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}
