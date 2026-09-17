import { describe, expect, it } from "vitest";

import { capStartsAboveMinor } from "./cap";

/**
 * `capStartsAboveMinor(capMinor, percentage)` — the argument order, pinned.
 *
 * Both parameters are `number`, so swapping them compiles, lints and ships.
 * It did: the discount detail page called it `(percentage, capMinor)` and
 * every discount on that page reported "Cap starts above 0.00 USD" — that the
 * maximum bites from the first cent, on the one screen a merchant opens to
 * check exactly that. Caught by eye on 17 Sep 2026.
 */
describe("capStartsAboveMinor argument order", () => {
  it("is cap first, percentage second", () => {
    // 50.00 at 20% starts biting at 250.00.
    expect(capStartsAboveMinor(5000, 20)).toBe(25000);
  });

  it("reports something absurd when the two are swapped, which is the tell", () => {
    expect(capStartsAboveMinor(20, 5000)).not.toBe(25000);
    expect(capStartsAboveMinor(20, 5000)).toBe(0);
  });

  it("never returns zero for a real cap and a real percentage", () => {
    for (const cap of [100, 2500, 5000, 15000, 20000]) {
      for (const pct of [5, 10, 15, 20, 30, 50]) {
        expect(capStartsAboveMinor(cap, pct)).toBeGreaterThan(0);
      }
    }
  });

  it("always lands at or above the cap itself — a maximum cannot bite below its own value", () => {
    for (const cap of [100, 2500, 5000, 15000]) {
      for (const pct of [5, 15, 20, 50, 99]) {
        expect(capStartsAboveMinor(cap, pct)!).toBeGreaterThanOrEqual(cap);
      }
    }
  });
});
