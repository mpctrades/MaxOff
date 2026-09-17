/**
 * Everything the plan bar needs, from one billing read.
 *
 * The bar now sits at the top of Home, Capped discounts, Create new, Test a
 * cart and Settings. Most of those pages were already reading the plan for
 * their own gates, and calling `getPlanForGate` *and* `getPlanSummary` would
 * put two GraphQL round-trips to Shopify in front of every one of them. This
 * reads once and answers both questions.
 *
 * They are different questions, and the difference matters:
 *
 *   `gate`  — the plan a gate should act on. Falls to the Free floor when the
 *             read failed, because refusing a paid feature to a merchant we
 *             cannot verify errs in the safe direction.
 *   `bar`   — the plan a merchant should be *told* they are on. Null when we
 *             could not tell, because the same Free floor printed as a label
 *             says "you are not paying" to somebody who is.
 *
 * `getPlanSummary` already keeps that distinction; this adds the active count
 * beside it so no page has to remember to fetch one.
 */

import prisma from "../db.server";
import { activeDiscountWhere } from "./discounts.server";
import { getCurrentPlan } from "./plan.server";
import type { AdminGraphqlClient } from "./plan.server";
import { activeDiscountLimit } from "../lib/plans";
import type { PlanKey } from "../lib/plans";

export interface PlanBarData {
  plan: PlanKey | null;
  activeCount: number;
  activeLimit: number | null;
}

export async function readPlanBar(input: {
  shop: string;
  admin: AdminGraphqlClient;
}): Promise<{ gate: PlanKey; bar: PlanBarData }> {
  const [current, activeCount] = await Promise.all([
    getCurrentPlan(input),
    prisma.cappedDiscount.count({
      where: activeDiscountWhere(input.shop, new Date()),
    }),
  ]);

  // "cache" and "unmapped" both mean the read did not give us an answer we can
  // print — see `getPlanSummary` for why each one counts as a non-answer.
  const plan = current.source === "shopify" ? current.plan : null;

  return {
    gate: current.plan,
    bar: {
      plan,
      activeCount,
      activeLimit: plan === null ? null : activeDiscountLimit(plan),
    },
  };
}
