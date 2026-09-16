/**
 * The grace period for a shop that is over its plan's active-discount limit.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `planLimitRefusal` in `app/models/discounts.server.ts` guards the only two
 * moments a shop can *gain* an active discount: creating one, and un-pausing
 * one. Neither fires on a downgrade. A merchant on Growth with 20 active
 * discounts who moves to Free keeps all 20 — the Function reads each
 * discount's `cap_config` metafield, which carries no plan, so every one of
 * them goes on capping carts exactly as before.
 *
 * That is a hole: Growth for one month, twenty discounts, downgrade, keep them
 * forever. But the obvious fix — pausing the excess the instant we notice — is
 * worse than the hole. It kills live campaigns with no warning, on a page load
 * the merchant did not connect to the consequence, and MaxOff cannot un-kill
 * them because activating clears `endsAt` in Shopify.
 *
 * So: warn, then enforce. The merchant is told which discounts are at risk and
 * by when, and gets {@link GRACE_DAYS} days to choose *which* ones to keep —
 * a choice only they can make. If the deadline passes with nothing done,
 * MaxOff pauses newest-first, because the newest discount is the least likely
 * to be the one mid-campaign.
 *
 * ── Why the clock starts when we notice ────────────────────────────────────
 * Shopify does not tell an app when a merchant downgrades; there is no
 * `app_subscriptions/update` webhook in our subscription list, and the plan is
 * only known when we read `currentAppInstallation`. So the earliest honest
 * start is the first load on which we saw the shop over its limit. A merchant
 * who downgrades and does not open MaxOff for a month has lost no grace at
 * all, which is the right way for this error to fall.
 *
 * This module is deliberately pure — no Prisma, no Shopify, no `Date.now()` —
 * so the state machine can be tested exhaustively. The side effects live in
 * `app/models/plan-grace.server.ts`.
 */

/** Days between first noticing a shop is over its limit and enforcing it. */
export const GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export type GraceStatus =
  /** Inside the allowance, or the plan has none. Nothing to say. */
  | "ok"
  /** Over the allowance, deadline still ahead. Warn, change nothing. */
  | "warning"
  /** Over the allowance and out of time. Pause the excess. */
  | "expired";

export interface GraceState {
  status: GraceStatus;
  /** How many active discounts are above the allowance. 0 when `ok`. */
  overBy: number;
  /** The allowance itself, for the message. Null when the plan is unlimited. */
  limit: number | null;
  /** When the excess will be paused. Null when `ok`. */
  deadline: Date | null;
}

/**
 * When the grace period runs out, given the instant it started.
 */
export function graceDeadline(since: Date): Date {
  return new Date(since.getTime() + GRACE_DAYS * DAY_MS);
}

/**
 * The state machine, in one place.
 *
 * `limit` null means an unlimited plan — Pro, or a plan we could not read. A
 * plan we could not read must never enforce: `getPlanSummary` returns null
 * rather than guessing, and pausing a merchant's discounts on the strength of
 * a failed GraphQL call would be the worst bug in the app.
 *
 * `since` null means this is the first load on which the shop is over, so the
 * caller records `now` and the deadline is a full {@link GRACE_DAYS} away.
 */
export function graceState(input: {
  limit: number | null;
  activeCount: number;
  since: Date | null;
  now: Date;
}): GraceState {
  const { limit, activeCount, since, now } = input;

  if (limit === null || activeCount <= limit) {
    return { status: "ok", overBy: 0, limit, deadline: null };
  }

  const overBy = activeCount - limit;
  const start = since ?? now;
  const deadline = graceDeadline(start);

  // `>=` rather than `>`: a deadline that has exactly arrived has arrived.
  const expired = now.getTime() >= deadline.getTime();

  return {
    status: expired ? "expired" : "warning",
    overBy,
    limit,
    deadline,
  };
}

/**
 * How many discounts to pause to get back inside the allowance.
 *
 * Separate from {@link graceState} because the caller needs it only in the
 * `expired` branch, and because "how many" is the number a test can assert
 * without constructing dates.
 */
export function excessToPause(input: {
  limit: number | null;
  activeCount: number;
}): number {
  const { limit, activeCount } = input;
  if (limit === null) {
    return 0;
  }
  return Math.max(0, activeCount - limit);
}
