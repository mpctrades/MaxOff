import { describe, expect, test } from "vitest";

import { capDiscountMinor } from "./cap";

/**
 * The Settings page's rounding, as the merchant actually experiences it.
 *
 * `capDiscountMinor` is the admin's preview of the Function's arithmetic
 * (CLAUDE.md §2), so these are the numbers the create form promises and the
 * numbers checkout gives. The Function has its own fixtures for the same
 * cases, run through the compiled Wasm.
 */
describe("rounding the final discount", () => {
  // 703.45 at 15% is 105.5175.
  const subtotalMinor = 70345;
  const percentage = 15;
  const capMinor = 15000;

  test("to the cent is half-up, and is the default", () => {
    expect(capDiscountMinor(subtotalMinor, percentage, capMinor).givenMinor).toBe(10552);
    expect(
      capDiscountMinor(subtotalMinor, percentage, capMinor, "cent").givenMinor,
    ).toBe(10552);
  });

  test("down to the whole unit drops the cents", () => {
    expect(
      capDiscountMinor(subtotalMinor, percentage, capMinor, "down").givenMinor,
    ).toBe(10500);
  });

  test("rounding down never rounds up", () => {
    for (const minor of [70345, 70000, 12399, 999, 100]) {
      const down = capDiscountMinor(minor, percentage, capMinor, "down").givenMinor;
      const cent = capDiscountMinor(minor, percentage, capMinor, "cent").givenMinor;

      expect(down).toBeLessThanOrEqual(cent);
      expect(down % 100).toBe(0);
    }
  });

  /**
   * The trap this guards. `capped` decides whether the buyer is shown the
   * "capped at maximum amount" note. Comparing the given amount against the
   * percentage would make rounding-down look like the maximum applying, and
   * the buyer would be told a maximum bit when all that happened was the loss
   * of a few cents.
   */
  test("rounding down is not the maximum applying", () => {
    const result = capDiscountMinor(subtotalMinor, percentage, capMinor, "down");

    expect(result.givenMinor).toBeLessThan(result.uncappedMinor);
    expect(result.capped).toBe(false);
  });

  test("the maximum applying is still reported, under either rounding", () => {
    // 1,400 at 15% is 210.00, above the 150.00 maximum.
    for (const mode of ["cent", "down"]) {
      const result = capDiscountMinor(140000, percentage, capMinor, mode);

      expect(result.capped).toBe(true);
      expect(result.givenMinor).toBe(15000);
    }
  });

  // An amount that rounds away to nothing gets no discount line at all: the
  // callers already refuse a given amount of zero.
  test("a discount smaller than one unit rounds to nothing", () => {
    expect(capDiscountMinor(500, percentage, capMinor, "down").givenMinor).toBe(0);
  });

  test("an unreadable rounding rule falls back to the cent", () => {
    expect(
      capDiscountMinor(subtotalMinor, percentage, capMinor, "up").givenMinor,
    ).toBe(10552);
  });
});
