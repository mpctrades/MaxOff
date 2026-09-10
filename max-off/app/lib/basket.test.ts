import { describe, expect, test } from "vitest";

import {
  addPickedVariants,
  basketSubtotalMinor,
  clampQuantity,
  lineTotalMinor,
  removeLine,
  setLineQuantity,
} from "./basket";
import type { BasketLine } from "./basket";
import { capDiscountMinor, capStartsAboveMinor } from "./cap";
import { formatMoney } from "./format";

/** The mockup's basket: one at 620.00 plus three at 260.00 = 1,400.00. */
const MOCKUP_BASKET: BasketLine[] = [
  { variantId: "gid://shopify/ProductVariant/1", title: "Alpine board", unitPriceMinor: 62000, quantity: 1 },
  { variantId: "gid://shopify/ProductVariant/2", title: "Snow goggles", unitPriceMinor: 26000, quantity: 3 },
];

describe("basket arithmetic", () => {
  test("a line total is unit price × quantity", () => {
    expect(lineTotalMinor(MOCKUP_BASKET[0])).toBe(62000);
    expect(lineTotalMinor(MOCKUP_BASKET[1])).toBe(78000);
  });

  test("the mockup's basket comes to 1,400.00", () => {
    expect(basketSubtotalMinor(MOCKUP_BASKET)).toBe(140000);
    expect(formatMoney(basketSubtotalMinor(MOCKUP_BASKET), "USD")).toBe(
      "1,400.00 USD",
    );
  });

  test("an empty basket is zero, not NaN", () => {
    expect(basketSubtotalMinor([])).toBe(0);
  });
});

/**
 * §6 item 2 of docs/PROMPT-TEST-A-CART.md — the numbers the screen must show
 * for that basket with SUMMER15. They are the Gate 1 checkout numbers, so a
 * mismatch here is a real bug.
 */
describe("the §6 item 2 result panel, at 1,400.00 with 15% max 150.00", () => {
  const subtotalMinor = basketSubtotalMinor(MOCKUP_BASKET);
  const result = capDiscountMinor(subtotalMinor, 15, 15000);

  test("without MaxOff: 210.00 given, customer pays 1,190.00", () => {
    expect(formatMoney(result.uncappedMinor, "USD")).toBe("210.00 USD");
    expect(formatMoney(subtotalMinor - result.uncappedMinor, "USD")).toBe(
      "1,190.00 USD",
    );
  });

  test("with MaxOff: 150.00 given, customer pays 1,250.00", () => {
    expect(formatMoney(result.givenMinor, "USD")).toBe("150.00 USD");
    expect(formatMoney(subtotalMinor - result.givenMinor, "USD")).toBe(
      "1,250.00 USD",
    );
  });

  test("you keep 60.00, and the result is capped", () => {
    expect(formatMoney(result.keptMinor, "USD")).toBe("60.00 USD");
    expect(result.capped).toBe(true);
  });

  test("the setup-step write records the capped amount, not the kept amount", () => {
    // §3: lastCartTestCappedMinor is givenMinor. Writing keptMinor produces
    // "capped correctly at 60.00 USD", which is wrong and reads plausibly.
    expect(result.givenMinor).toBe(15000);
    expect(result.keptMinor).toBe(6000);
    expect(result.givenMinor).not.toBe(result.keptMinor);
  });
});

describe("a basket below the point where the maximum applies", () => {
  const lines = setLineQuantity(MOCKUP_BASKET, "gid://shopify/ProductVariant/2", 1);
  const subtotalMinor = basketSubtotalMinor(lines);
  const result = capDiscountMinor(subtotalMinor, 15, 15000);

  test("620.00 + 260.00 = 880.00, under the 1,000.00 threshold", () => {
    expect(subtotalMinor).toBe(88000);
    expect(capStartsAboveMinor(15000, 15)).toBe(100000);
    expect(subtotalMinor).toBeLessThan(capStartsAboveMinor(15000, 15)!);
  });

  test("the full percentage is given and nothing is kept", () => {
    expect(formatMoney(result.givenMinor, "USD")).toBe("132.00 USD");
    expect(result.givenMinor).toBe(result.uncappedMinor);
    expect(result.keptMinor).toBe(0);
    expect(result.capped).toBe(false);
  });
});

describe("adding picked variants", () => {
  const picked = {
    id: "gid://shopify/ProductVariant/9",
    displayName: "Winter jacket - Large",
    price: "260.00",
    image: { originalSrc: "https://cdn.example/jacket.png", altText: "A jacket" },
  };

  test("a picked variant becomes a line at quantity one", () => {
    const lines = addPickedVariants([], [picked]);

    expect(lines).toEqual([
      {
        variantId: "gid://shopify/ProductVariant/9",
        title: "Winter jacket - Large",
        unitPriceMinor: 26000,
        quantity: 1,
        imageSrc: "https://cdn.example/jacket.png",
        imageAlt: "A jacket",
      },
    ]);
  });

  test("picking the same variant again increments instead of duplicating", () => {
    const once = addPickedVariants([], [picked]);
    const twice = addPickedVariants(once, [picked]);

    expect(twice).toHaveLength(1);
    expect(twice[0].quantity).toBe(2);
  });

  test("prices arrive as decimal strings and become minor units", () => {
    for (const [price, minor] of [
      ["620.00", 62000],
      ["260", 26000],
      ["19.99", 1999],
      ["0.01", 1],
    ] as const) {
      const lines = addPickedVariants([], [{ ...picked, price }]);
      expect(lines[0].unitPriceMinor).toBe(minor);
    }
  });

  test("a variant with an unreadable price is skipped, not priced at zero", () => {
    for (const price of [undefined, "", "free", "-10"]) {
      expect(addPickedVariants([], [{ ...picked, price }])).toEqual([]);
    }
  });

  test("a variant with no image or name still makes a usable line", () => {
    const lines = addPickedVariants([], [{ id: "gid://x/1", price: "10.00" }]);

    expect(lines[0].title).toBe("Product");
    expect(lines[0].imageSrc).toBeUndefined();
  });
});

describe("editing lines", () => {
  test("quantity is clamped to at least one", () => {
    const lines = setLineQuantity(MOCKUP_BASKET, "gid://shopify/ProductVariant/1", 0);
    expect(lines[0].quantity).toBe(1);
  });

  test("a quantity that cannot be read stays at one", () => {
    expect(clampQuantity(Number.NaN)).toBe(1);
    expect(clampQuantity(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampQuantity(2.7)).toBe(2);
    expect(clampQuantity(-5)).toBe(1);
    expect(clampQuantity(100000)).toBe(999);
  });

  test("removing a line leaves the others alone", () => {
    const lines = removeLine(MOCKUP_BASKET, "gid://shopify/ProductVariant/1");

    expect(lines).toHaveLength(1);
    expect(lines[0].variantId).toBe("gid://shopify/ProductVariant/2");
    expect(basketSubtotalMinor(lines)).toBe(78000);
  });

  test("removing an id that is not there changes nothing", () => {
    expect(removeLine(MOCKUP_BASKET, "gid://nope")).toHaveLength(2);
  });
});
