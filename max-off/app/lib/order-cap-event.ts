/**
 * Turning one paid order into one `CapEvent`.
 *
 * Kept as a pure function, apart from the webhook route, for two reasons: it
 * is the only arithmetic in MaxOff that nobody can check by looking at a
 * screen, and the webhook that will call it cannot run yet (see
 * `app/routes/webhooks.orders.paid.tsx`). Tests are the only thing standing
 * behind it until `read_orders` is approved, so it is written to be tested.
 *
 * What a CapEvent means, read off `app/models/home.server.ts`: one row per
 * order that used a MaxOff discount — capped or not. `keptMinor > 0` is what
 * marks the ones where the maximum actually bit, and Home counts those
 * separately from the total. So an order that stayed under "cap starts above"
 * still gets a row, with `keptMinor` of zero. Dropping it would make the
 * "of N discounted orders" denominator wrong.
 */

import { applyRounding, parseDecimalToMinor } from "./cap";
import type { RoundingMode } from "./rounding";

/**
 * The slice of the `orders/paid` payload this needs.
 *
 * Webhook bodies are the REST shape — snake_case, money as decimal strings in
 * major units — regardless of the app using the GraphQL Admin API elsewhere.
 */
export interface OrderPayload {
  admin_graphql_api_id?: string | null;
  id?: number | string | null;
  name?: string | null;
  created_at?: string | null;
  processed_at?: string | null;
  currency?: string | null;
  subtotal_price?: string | null;
  line_items?: {
    price?: string | null;
    quantity?: number | null;
  }[] | null;
  discount_codes?: {
    code?: string | null;
    amount?: string | null;
  }[] | null;
  discount_applications?: {
    type?: string | null;
    title?: string | null;
    code?: string | null;
    value?: string | null;
    value_type?: string | null;
  }[] | null;
}

/** One of the shop's capped discounts, as much of it as the maths needs. */
export interface CappedDiscountFacts {
  id: string;
  code: string | null;
  title: string | null;
  percentage: number;
  capMinor: number;
  rounding: RoundingMode;
}

export interface CapEventFacts {
  cappedDiscountId: string;
  orderGid: string;
  orderName: string;
  subtotalMinor: number;
  /** What the bare percentage would have given, before the maximum. */
  uncappedMinor: number;
  /** What the buyer actually got. */
  givenMinor: number;
  /** The difference, never negative. Zero when the cap did not bite. */
  keptMinor: number;
  occurredAt: Date;
}

/**
 * The subtotal the percentage was worked out on.
 *
 * Summed from the line items rather than read from `subtotal_price`, because
 * `subtotal_price` is already net of discounts — including ours — and feeding
 * that back into `subtotal × percentage` would understate what the uncapped
 * discount would have been, making every `keptMinor` too small.
 *
 * ⚠ One open question rides on this, and it is the same one CLAUDE.md records
 * against §3.2: when a *product* discount is also on the cart, we do not yet
 * know whether the Function's `cart.cost.subtotalAmount` is the full subtotal
 * or the reduced one. This uses the full one. Capture a real payload with both
 * discounts on it before trusting `keptMinor` in that case, and fix it here —
 * one function, one place.
 */
function subtotalFromLineItems(order: OrderPayload): number | null {
  const lines = order.line_items;

  if (!Array.isArray(lines) || lines.length === 0) {
    return null;
  }

  let total = 0;

  for (const line of lines) {
    const price = typeof line.price === "string" ? parseDecimalToMinor(line.price) : null;
    const quantity = typeof line.quantity === "number" ? line.quantity : null;

    if (price === null || quantity === null || quantity < 0) {
      return null;
    }

    total += price * quantity;
  }

  return total;
}

/**
 * Which of the shop's capped discounts this order used, and how much it gave.
 *
 * A code discount is matched on the code, which Shopify echoes in
 * `discount_codes`. An automatic discount has no code, so it is matched on the
 * title in `discount_applications` — the same string MaxOff sent when it
 * created the discount.
 *
 * The amount given is read from the payload rather than recomputed: the
 * Function decided it, and anything worked out here is a second opinion about
 * money that has already changed hands.
 */
function findOurDiscount(
  order: OrderPayload,
  discounts: CappedDiscountFacts[],
): { discount: CappedDiscountFacts; givenMinor: number } | null {
  const codes = Array.isArray(order.discount_codes) ? order.discount_codes : [];

  for (const entry of codes) {
    if (typeof entry.code !== "string" || typeof entry.amount !== "string") {
      continue;
    }

    const match = discounts.find(
      (discount) =>
        discount.code !== null &&
        discount.code.toLowerCase() === entry.code!.toLowerCase(),
    );

    const givenMinor = parseDecimalToMinor(entry.amount);

    if (match && givenMinor !== null) {
      return { discount: match, givenMinor };
    }
  }

  const applications = Array.isArray(order.discount_applications)
    ? order.discount_applications
    : [];

  for (const application of applications) {
    // Our Function always emits a fixed amount — the `min()` is done in the
    // Function and the result is a FixedAmount candidate (§3.2). A percentage
    // application is therefore somebody else's discount, not ours.
    if (application.value_type !== "fixed_amount") {
      continue;
    }

    const label = application.title ?? application.code ?? null;
    if (typeof label !== "string" || typeof application.value !== "string") {
      continue;
    }

    const match = discounts.find(
      (discount) =>
        (discount.title !== null &&
          discount.title.toLowerCase() === label.toLowerCase()) ||
        (discount.code !== null && discount.code.toLowerCase() === label.toLowerCase()),
    );

    const givenMinor = parseDecimalToMinor(application.value);

    if (match && givenMinor !== null) {
      return { discount: match, givenMinor };
    }
  }

  return null;
}

/**
 * The `CapEvent` this order is owed, or null if it used no MaxOff discount.
 *
 * Null is the common case and is not an error: most orders on a shop running a
 * capped discount will not have used it.
 */
export function capEventFromOrder(
  order: OrderPayload,
  discounts: CappedDiscountFacts[],
): CapEventFacts | null {
  const orderGid =
    typeof order.admin_graphql_api_id === "string" && order.admin_graphql_api_id !== ""
      ? order.admin_graphql_api_id
      : order.id != null
        ? `gid://shopify/Order/${order.id}`
        : null;

  if (orderGid === null) {
    return null;
  }

  const found = findOurDiscount(order, discounts);
  if (found === null) {
    return null;
  }

  const { discount, givenMinor } = found;

  const lineSubtotal = subtotalFromLineItems(order);
  const subtotalMinor =
    lineSubtotal ??
    // No usable line items. `subtotal_price` is net of the discount, so adding
    // ours back gets to the figure the percentage was applied to. Less exact
    // than the line items when other discounts are in play, and the reason the
    // line items are preferred.
    (typeof order.subtotal_price === "string"
      ? (parseDecimalToMinor(order.subtotal_price) ?? 0) + givenMinor
      : 0);

  // What the bare percentage would have given, rounded the way this discount
  // rounds — the same helper the Function and the preview use, so the three
  // cannot disagree about a half-cent.
  const uncappedMinor = applyRounding(
    Math.round((subtotalMinor * discount.percentage) / 100),
    discount.rounding,
  );

  const occurredAtSource = order.processed_at ?? order.created_at ?? null;
  const parsed = occurredAtSource === null ? null : new Date(occurredAtSource);
  const occurredAt =
    parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed : new Date();

  return {
    cappedDiscountId: discount.id,
    orderGid,
    orderName: typeof order.name === "string" && order.name !== "" ? order.name : orderGid,
    subtotalMinor,
    uncappedMinor,
    givenMinor,
    // Never negative. If Shopify gave more than the bare percentage would have,
    // something other than our cap decided the number and "kept" is not the
    // word for it — zero is.
    keptMinor: Math.max(0, uncappedMinor - givenMinor),
    occurredAt,
  };
}
