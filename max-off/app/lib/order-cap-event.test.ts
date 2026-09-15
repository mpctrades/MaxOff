import { describe, expect, test } from "vitest";

import { capEventFromOrder } from "./order-cap-event";
import type { CappedDiscountFacts, OrderPayload } from "./order-cap-event";

import capped from "./fixtures/orders-paid-capped.json";
import underCap from "./fixtures/orders-paid-under-cap.json";
import otherDiscount from "./fixtures/orders-paid-other-discount.json";
import automatic from "./fixtures/orders-paid-automatic.json";

/** SUMMER15 — 15% off, maximum 150.00. Cap starts above 1,000.00. */
const SUMMER15: CappedDiscountFacts = {
  id: "discount_summer",
  code: "SUMMER15",
  title: "Summer sale",
  percentage: 15,
  capMinor: 15_000,
  rounding: "cent",
};

/** The automatic twin, which has no code and is matched on its title. */
const AUTUMN: CappedDiscountFacts = {
  id: "discount_autumn",
  code: null,
  title: "Autumn clearout",
  percentage: 15,
  capMinor: 15_000,
  rounding: "cent",
};

describe("capEventFromOrder — the cap bit", () => {
  const event = capEventFromOrder(capped as OrderPayload, [SUMMER15]);

  test("finds our discount by its code", () => {
    expect(event?.cappedDiscountId).toBe("discount_summer");
  });

  test("uses the line items for the subtotal, not the discounted subtotal_price", () => {
    // 700.00 + (7 × 100.00) = 1,400.00, where subtotal_price says 1,250.00
    // because the 150.00 has already come off it.
    expect(event?.subtotalMinor).toBe(140_000);
  });

  test("uncapped is the bare percentage on that subtotal", () => {
    // 15% of 1,400.00 = 210.00
    expect(event?.uncappedMinor).toBe(21_000);
  });

  test("given is what Shopify actually took off, not a recomputation", () => {
    expect(event?.givenMinor).toBe(15_000);
  });

  test("kept is the difference — the number Home adds up", () => {
    // 210.00 − 150.00 = 60.00. BUILD-SPEC §11: "You keep 60.00 USD on this order."
    expect(event?.keptMinor).toBe(6_000);
  });

  test("carries the order's own name and gid", () => {
    expect(event?.orderName).toBe("#1042");
    expect(event?.orderGid).toBe("gid://shopify/Order/5123456789012");
  });

  test("occurs when the order was processed, not when we read it", () => {
    expect(event?.occurredAt.toISOString()).toBe("2026-09-14T13:12:44.000Z");
  });
});

describe("capEventFromOrder — under the cap", () => {
  const event = capEventFromOrder(underCap as OrderPayload, [SUMMER15]);

  test("still produces an event", () => {
    // Home divides "orders capped" by "discounted orders". Dropping the
    // uncapped ones would make that denominator wrong.
    expect(event).not.toBeNull();
  });

  test("kept is zero, because the maximum never came into it", () => {
    // 15% of 700.00 = 105.00, which is under the 150.00 maximum.
    expect(event?.uncappedMinor).toBe(10_500);
    expect(event?.givenMinor).toBe(10_500);
    expect(event?.keptMinor).toBe(0);
  });
});

describe("capEventFromOrder — orders that are not ours", () => {
  test("another app's percentage discount produces nothing", () => {
    expect(capEventFromOrder(otherDiscount as OrderPayload, [SUMMER15])).toBeNull();
  });

  test("an order with no discounts at all produces nothing", () => {
    const order: OrderPayload = {
      admin_graphql_api_id: "gid://shopify/Order/1",
      name: "#1",
      line_items: [{ price: "40.00", quantity: 1 }],
      discount_codes: [],
      discount_applications: [],
    };

    expect(capEventFromOrder(order, [SUMMER15])).toBeNull();
  });

  test("an order with no id at all produces nothing", () => {
    expect(capEventFromOrder({ name: "#1" }, [SUMMER15])).toBeNull();
  });
});

describe("capEventFromOrder — automatic discounts", () => {
  test("matched on the title, since there is no code", () => {
    const event = capEventFromOrder(automatic as OrderPayload, [AUTUMN]);

    expect(event?.cappedDiscountId).toBe("discount_autumn");
    // 15% of 1,400.00 = 210.00, capped to 150.00, keeping 60.00.
    expect(event?.subtotalMinor).toBe(140_000);
    expect(event?.keptMinor).toBe(6_000);
  });

  test("a shop's other automatic discount is not mistaken for ours", () => {
    expect(capEventFromOrder(automatic as OrderPayload, [SUMMER15])).toBeNull();
  });
});

describe("capEventFromOrder — the awkward shapes", () => {
  test("falls back to subtotal_price plus our discount when line items are unusable", () => {
    const order: OrderPayload = {
      admin_graphql_api_id: "gid://shopify/Order/2",
      name: "#2",
      subtotal_price: "1250.00",
      line_items: [{ price: null, quantity: 1 }],
      discount_codes: [{ code: "SUMMER15", amount: "150.00" }],
    };

    const event = capEventFromOrder(order, [SUMMER15]);

    // 1,250.00 + 150.00 = 1,400.00, the figure the percentage was applied to.
    expect(event?.subtotalMinor).toBe(140_000);
    expect(event?.keptMinor).toBe(6_000);
  });

  test("a code that differs only in case still matches", () => {
    const order: OrderPayload = {
      admin_graphql_api_id: "gid://shopify/Order/3",
      name: "#3",
      line_items: [{ price: "1400.00", quantity: 1 }],
      discount_codes: [{ code: "summer15", amount: "150.00" }],
    };

    expect(capEventFromOrder(order, [SUMMER15])?.cappedDiscountId).toBe(
      "discount_summer",
    );
  });

  test("kept is never negative, however odd the numbers are", () => {
    const order: OrderPayload = {
      admin_graphql_api_id: "gid://shopify/Order/4",
      name: "#4",
      line_items: [{ price: "10.00", quantity: 1 }],
      // More than 15% of 10.00 — something other than our cap decided this.
      discount_codes: [{ code: "SUMMER15", amount: "9.00" }],
    };

    expect(capEventFromOrder(order, [SUMMER15])?.keptMinor).toBe(0);
  });

  test("the discount's own rounding rule is applied to the uncapped figure", () => {
    const order: OrderPayload = {
      admin_graphql_api_id: "gid://shopify/Order/5",
      name: "#5",
      line_items: [{ price: "350.00", quantity: 1 }],
      discount_codes: [{ code: "SUMMER15", amount: "52.50" }],
    };

    // 15% of 350.00 = 52.50 to the cent; "down" rounds to the whole unit, 52.00.
    expect(capEventFromOrder(order, [SUMMER15])?.uncappedMinor).toBe(5_250);
    expect(
      capEventFromOrder(order, [{ ...SUMMER15, rounding: "down" }])?.uncappedMinor,
    ).toBe(5_200);
  });

  test("falls back to the order gid when the order has no name", () => {
    const order: OrderPayload = {
      id: 99,
      line_items: [{ price: "1400.00", quantity: 1 }],
      discount_codes: [{ code: "SUMMER15", amount: "150.00" }],
    };

    const event = capEventFromOrder(order, [SUMMER15]);
    expect(event?.orderGid).toBe("gid://shopify/Order/99");
    expect(event?.orderName).toBe("gid://shopify/Order/99");
  });
});
