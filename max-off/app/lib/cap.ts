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

import { toRoundingMode } from "./rounding";
import type { RoundingMode } from "./rounding";

/**
 * Whether MaxOff's cap engine is live.
 *
 * Gate 1 closed on 8 Sep 2026: the Function in `extensions/max-off-cap` took
 * 150.00 on a 1,400 cart and 105.00 on a 700 cart at a real checkout on the
 * dev store. This constant asserts that, and it lives here because **two**
 * screens claim it — Home's "Cap engine is running" banner and the Settings
 * transparency panel's Active pill. Two hard-coded truths in two files is how
 * they end up disagreeing.
 *
 * It is a build-time fact, not a per-shop runtime check: proving deployment
 * for a given shop needs an Admin API call, and neither screen makes one.
 */
export const CAP_ENGINE_DEPLOYED = true;

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

/**
 * Parse what a merchant actually types into minor units: `150`, `150.5`,
 * `150.00`, ` 150 `. Returns null for anything we cannot read with certainty —
 * never NaN, because a NaN here becomes a malformed `cap_config` and a discount
 * that silently stops discounting.
 *
 * This is the admin twin of `parseDecimalToMinor` in
 * `extensions/max-off-cap/src/cap.ts`. The two are tested against the same
 * table (BUILD-SPEC §8) so a divergence fails a test rather than a checkout.
 */
export function parseDecimalToMinor(value: string): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const whole = match[1];
  const fraction = match[2] ?? "";

  // 10^13 major units still multiplies by 100 and by a percentage without
  // leaving the exact-integer range, and no real cart comes close.
  if (whole.length > 13) {
    return null;
  }

  const cents = `${fraction}00`.slice(0, 2);
  const belowTheCent = fraction.slice(2);

  let minor = Number(whole) * MINOR_UNITS + Number(cents);
  // Half-up on anything finer than a cent: "0.005" is a cent, "0.004" is not.
  if (belowTheCent >= "5") {
    minor += 1;
  }

  return Number.isSafeInteger(minor) ? minor : null;
}

/** Minor units as the `Decimal` string Shopify and the metafield expect. */
export function toDecimalString(minor: number): string {
  const whole = Math.floor(minor / MINOR_UNITS);
  const cents = minor % MINOR_UNITS;
  return `${whole}.${String(cents).padStart(2, "0")}`;
}

export interface CapPreview {
  /** What the raw percentage would have given. */
  uncappedMinor: number;
  /** What MaxOff actually gives. */
  givenMinor: number;
  /** The difference the merchant keeps. */
  keptMinor: number;
  /** Whether the maximum is what decided the amount. */
  capped: boolean;
}

/**
 * The one formula, for the admin's previews:
 *
 *     given = round(min(subtotal × percentage / 100, cap))
 *
 * Integer arithmetic, half-up, once, at the end (rule 4). The Function decides
 * money at checkout; this only has to agree with it, and the §8 test table is
 * what holds the two together.
 *
 * `rounding` is the shop's own setting, and it is applied **after** the
 * minimum, not before: the merchant's rule is "round the amount I give away",
 * and rounding the percentage first would let a rounded-down figure sit under
 * a maximum that never applied.
 *
 * `capped` deliberately ignores the rounding. It decides whether the buyer is
 * shown "capped at maximum amount", and rounding down a discount that never
 * reached the maximum would otherwise announce a maximum that did nothing.
 */
export function capDiscountMinor(
  subtotalMinor: number,
  percentage: number,
  capMinor: number,
  rounding?: string | null,
): CapPreview {
  const uncappedMinor = roundHalfUp(subtotalMinor * percentage, MINOR_UNITS);
  const givenMinor = applyRounding(
    Math.min(uncappedMinor, capMinor),
    toRoundingMode(rounding),
  );

  return {
    uncappedMinor,
    givenMinor,
    keptMinor: uncappedMinor - givenMinor,
    capped: uncappedMinor > capMinor,
  };
}

/**
 * The shop's rounding, applied once to the final amount.
 *
 * "To the cent" is the identity: every amount here is already an integer
 * number of cents, because nothing in this file ever leaves integer
 * arithmetic. "Down to the whole unit" drops the cents — a merchant who wants
 * their checkout to read 105.00 rather than 105.52, and who would rather round
 * in the buyer's disfavour than their own.
 *
 * The admin twin of `applyRounding` in `extensions/max-off-cap/src/cap.ts`.
 */
export function applyRounding(minor: number, rounding: RoundingMode): number {
  return rounding === "down"
    ? Math.floor(minor / MINOR_UNITS) * MINOR_UNITS
    : minor;
}

function roundHalfUp(numerator: number, denominator: number): number {
  // Every value here is non-negative, so floor and truncate agree.
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

/**
 * The states a merchant sees.
 *
 * "Paused" and "cancelled" are stored, because both are things a human did.
 * "Scheduled" and "expired" are facts about the clock and are derived — see
 * `displayStatus`.
 */
export type TabbableStatus = "active" | "scheduled" | "paused" | "expired";

export type DisplayStatus = TabbableStatus | "cancelled";

/**
 * The statuses the tab strip offers, which is deliberately not every status.
 *
 * Cancelled discounts no longer exist in Shopify; MaxOff keeps the row so a
 * merchant does not lose the record, but a tab for them would put a filter on
 * the shelf that most shops would never press. They appear under "All".
 */
export const DISPLAY_STATUSES: TabbableStatus[] = [
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
export type DiscountTab = "all" | TabbableStatus;

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
  // Checked before anything derived from the clock: a cancelled discount is
  // gone from Shopify, so no date can make it active again. Getting this order
  // wrong would let a cancelled row count against the plan's active limit.
  if (discount.status === "cancelled") {
    return "cancelled";
  }

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
