/**
 * `orders/paid` — written, tested, and deliberately not running.
 *
 * ── Why it cannot run yet ──────────────────────────────────────────────────
 * Two things are missing on purpose, and neither is an oversight:
 *
 *   1. `read_orders` is **not** in `shopify.app.toml`. It is a protected
 *      customer data scope, and a public app must be approved for Level 1
 *      protected customer data in the Partner Dashboard before it may request
 *      it. That approval has not been applied for.
 *   2. The `orders/paid` subscription is **not** in `shopify.app.toml`, so
 *      Shopify never delivers to this route.
 *
 * Until both land, this file is dead code that compiles, is covered by tests,
 * and changes nothing for a merchant or a reviewer. `MAXOFF_ENABLE_ORDER_EVENTS`
 * is the third lock: even with the scope and the subscription in place, the
 * handler writes nothing until it is set. Default off.
 *
 * ── Turning it on, when the time comes ─────────────────────────────────────
 *   - add `read_orders` to `scopes` in `shopify.app.toml` (forces a reinstall)
 *   - add the subscription:
 *         [[webhooks.subscriptions]]
 *         uri = "/webhooks/orders/paid"
 *         topics = [ "orders/paid" ]
 *   - set `MAXOFF_ENABLE_ORDER_EVENTS=1` in the app's environment
 *   - capture one real payload with a product discount also on the cart, and
 *     settle the subtotal question recorded in `app/lib/order-cap-event.ts`
 *
 * ── What it does ───────────────────────────────────────────────────────────
 * One `CapEvent` per order that used a MaxOff discount, which is what fills
 * the "Money you kept" figures on Home. `authenticate.webhook` verifies
 * Shopify's HMAC before any of this reads or writes — same as the compliance
 * webhooks. Writes are idempotent on `orderGid`, which is `@unique`, because
 * Shopify retries deliveries and a double-counted order is a wrong number on a
 * merchant's dashboard that nothing would ever correct.
 */

import type { ActionFunctionArgs } from "react-router";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { orderEventsEnabled, recordCapEvent } from "../models/order-events.server";
import type { OrderPayload } from "../lib/order-cap-event";
import { toRoundingMode } from "../lib/rounding";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  // Locked. A 200 so Shopify does not retry a delivery we are choosing to
  // ignore — this is not a failure, it is a feature that is off.
  if (!orderEventsEnabled()) {
    return new Response(null, { status: 200 });
  }

  const discounts = await db.cappedDiscount.findMany({
    where: { shop },
    select: {
      id: true,
      code: true,
      title: true,
      percentage: true,
      capMinor: true,
    },
  });

  if (discounts.length === 0) {
    return new Response(null, { status: 200 });
  }

  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const rounding = toRoundingMode(settings?.rounding);

  await recordCapEvent({
    shop,
    order: payload as OrderPayload,
    discounts: discounts.map((discount) => ({ ...discount, rounding })),
  });

  return new Response(null, { status: 200 });
};
