/**
 * The side-effecting half of the over-limit grace period.
 *
 * The state machine is in `app/lib/plan-grace.ts` and is pure; everything here
 * is the part that touches Prisma and Shopify. Read that file first — it
 * explains why a downgrade is allowed to leave a shop over its allowance at
 * all, and why the excess is paused newest-first rather than immediately.
 *
 * ── Where this runs ────────────────────────────────────────────────────────
 * The Home loader, and only there. Home already does a live plan read through
 * `getPlanSummary`, so evaluating costs nothing extra; the Capped discounts
 * list deliberately uses the cached plan to avoid a ~1.9s round trip on every
 * load, and enforcement must never run on a plan we did not just read.
 *
 * A merchant who never opens MaxOff is never enforced. That is the correct
 * trade for V1: the alternative is a scheduled job holding offline tokens for
 * every shop, which is a much larger thing to get wrong, and the failure mode
 * here costs us revenue rather than costing a merchant their campaigns.
 */

import prisma from "../db.server";
import { activeDiscountWhere, setDiscountPaused } from "./discounts.server";
import { ensureShopSettings } from "./settings.server";
import type { AdminGraphqlClient } from "./plan.server";
import { excessToPause, graceState } from "../lib/plan-grace";
import type { GraceState } from "../lib/plan-grace";

export interface PlanGraceResult extends GraceState {
  /** Discounts paused by this call. Empty unless the deadline had passed. */
  pausedCodes: string[];
}

/**
 * Evaluate the shop against its allowance, and enforce if the grace period has
 * run out.
 *
 * `limit` null (an unlimited plan, or a plan that could not be read) returns
 * "ok" and clears any stored clock — see the note in `plan-grace.ts` about
 * never enforcing on a failed read.
 */
export async function evaluatePlanGrace(input: {
  shop: string;
  limit: number | null;
  admin: AdminGraphqlClient;
  now: Date;
}): Promise<PlanGraceResult> {
  const { shop, limit, admin, now } = input;

  const settings = await ensureShopSettings(shop);

  const activeCount = await prisma.cappedDiscount.count({
    where: activeDiscountWhere(shop, now),
  });

  const state = graceState({
    limit,
    activeCount,
    since: settings.overLimitSince,
    now,
  });

  if (state.status === "ok") {
    // Back inside the allowance — or never outside it. Clear the clock so a
    // merchant who pauses one and later goes over again gets a fresh period
    // rather than inheriting an expired one.
    if (settings.overLimitSince !== null) {
      await prisma.shopSettings.update({
        where: { shop },
        data: { overLimitSince: null },
      });
    }
    return { ...state, pausedCodes: [] };
  }

  if (state.status === "warning") {
    // First sighting starts the clock. Later sightings must not restart it,
    // or the deadline would never arrive for a merchant who opens Home daily.
    if (settings.overLimitSince === null) {
      await prisma.shopSettings.update({
        where: { shop },
        data: { overLimitSince: now },
      });
    }
    return { ...state, pausedCodes: [] };
  }

  // Expired. Pause newest-first until the shop is back inside its allowance.
  const excess = excessToPause({ limit, activeCount });
  const candidates = await prisma.cappedDiscount.findMany({
    where: activeDiscountWhere(shop, now),
    orderBy: { createdAt: "desc" },
    take: excess,
    select: { id: true, code: true, title: true },
  });

  const pausedCodes: string[] = [];
  for (const candidate of candidates) {
    // One at a time, and Shopify-first: `setDiscountPaused` only updates our
    // mirror after Shopify confirms. A refusal on one discount must not stop
    // the others — the shop is over its limit either way, and a partial
    // enforcement is closer to correct than none.
    const result = await setDiscountPaused({
      shop,
      id: candidate.id,
      paused: true,
      admin,
    });

    if (result.ok) {
      pausedCodes.push(candidate.code ?? candidate.title ?? "a discount");
    }
  }

  // Clear the clock only for what we actually achieved. If Shopify refused
  // every pause the shop is still over, and the next load should try again
  // rather than wait another full period.
  const remaining = activeCount - pausedCodes.length;
  if (limit !== null && remaining <= limit) {
    await prisma.shopSettings.update({
      where: { shop },
      data: { overLimitSince: null },
    });
  }

  return { ...state, pausedCodes };
}
