/**
 * Writing a `CapEvent` for a paid order.
 *
 * Kept out of the route so it can be tested without booting `shopify.server`,
 * which a webhook route must import for HMAC verification and which needs a
 * whole environment to construct. The route stays a thin shell around this,
 * the same shape as the compliance webhooks.
 *
 * Nothing here runs today — see `app/routes/webhooks.orders.paid.tsx` for the
 * three locks that keep it inert until `read_orders` is approved.
 */

import db from "../db.server";
import { capEventFromOrder } from "../lib/order-cap-event";
import type { CappedDiscountFacts, OrderPayload } from "../lib/order-cap-event";

/**
 * Whether to write anything at all.
 *
 * Read per call rather than at module load, so a deploy can flip it without a
 * code change and so tests can exercise both sides.
 */
export function orderEventsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = env.MAXOFF_ENABLE_ORDER_EVENTS;
  return flag === "1" || flag === "true";
}

export type RecordResult = "written" | "duplicate" | "not-ours";

/**
 * Write the event, unless this order already has one.
 *
 * A `create` guarded by a `catch` rather than an `upsert`: a retry must not
 * overwrite the first row. The numbers on it came from the same payload, so a
 * second write could only be a no-op or a corruption. The `@unique` constraint
 * on `orderGid` is what actually decides, because two concurrent deliveries
 * can both pass the read above it — that is why the catch exists as well as
 * the check.
 *
 * Getting this wrong double-counts "Money you kept" on Home, and nothing would
 * ever correct it: there is no reconciliation pass, and a merchant has no way
 * to tell the figure is wrong.
 */
export async function recordCapEvent(input: {
  shop: string;
  order: OrderPayload;
  discounts: CappedDiscountFacts[];
}): Promise<RecordResult> {
  const facts = capEventFromOrder(input.order, input.discounts);

  if (facts === null) {
    return "not-ours";
  }

  const existing = await db.capEvent.findUnique({
    where: { orderGid: facts.orderGid },
    select: { id: true },
  });

  if (existing) {
    return "duplicate";
  }

  try {
    await db.capEvent.create({
      data: {
        shop: input.shop,
        cappedDiscountId: facts.cappedDiscountId,
        orderGid: facts.orderGid,
        orderName: facts.orderName,
        subtotalMinor: facts.subtotalMinor,
        uncappedMinor: facts.uncappedMinor,
        givenMinor: facts.givenMinor,
        keptMinor: facts.keptMinor,
        occurredAt: facts.occurredAt,
      },
    });
  } catch (error) {
    // The unique constraint firing means a concurrent delivery won the race.
    // That is the constraint doing its job, not a failure to report.
    if (isUniqueViolation(error)) {
      return "duplicate";
    }
    throw error;
  }

  // The list's denormalised totals, moved in the same breath. These columns
  // have had no writer until now, which is why every row reads zero today.
  await db.cappedDiscount.update({
    where: { id: facts.cappedDiscountId },
    data: {
      timesUsed: { increment: 1 },
      keptMinor: { increment: facts.keptMinor },
      givenMinor: { increment: facts.givenMinor },
    },
  });

  return "written";
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
