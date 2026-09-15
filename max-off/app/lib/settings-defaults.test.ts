import { describe, expect, test } from "vitest";

import { DEFAULT_CHECKOUT_NOTE } from "./cap-config";
import {
  combineDateTime,
  initialDiscountFormState,
  validateDiscountForm,
} from "./discount-form";
import type { DiscountFormState } from "./discount-form";

const PHNOM_PENH = "Asia/Phnom_Penh";

/**
 * The Settings "Defaults for new discounts" block, as the create form actually
 * receives it.
 *
 * The contract these tests hold down is the sentence under the section:
 * *"These only prefill the Create new form. Anything you change on a single
 * discount still wins."* Everything here is about the form **opening**; none
 * of it reaches a discount that already exists, which is what separates this
 * block from `rounding` (see `settings-rounding.test.ts`).
 */
describe("what a shop's defaults do to a new form", () => {
  test("a shop that has set nothing gets the form it always had", () => {
    const state = initialDiscountFormState(new Date("2026-09-10T00:00:00Z"));

    expect(state.scope).toBe("order");
    expect(state.checkoutNote).toBe(DEFAULT_CHECKOUT_NOTE);
    expect(state.oncePerCustomer).toBe(true);
    expect(state.combinesProduct).toBe(false);
    expect(state.combinesOrder).toBe(false);
    expect(state.combinesShipping).toBe(true);
  });

  test("the shop's own defaults open the form instead", () => {
    const state = initialDiscountFormState(new Date("2026-09-10T00:00:00Z"), null, {
      scope: "item",
      checkoutNote: "Capped at our maximum",
      oncePerCustomer: false,
      combinesProduct: true,
      combinesOrder: true,
      combinesShipping: false,
    });

    expect(state.scope).toBe("item");
    expect(state.checkoutNote).toBe("Capped at our maximum");
    expect(state.oncePerCustomer).toBe(false);
    expect(state.combinesProduct).toBe(true);
    expect(state.combinesOrder).toBe(true);
    expect(state.combinesShipping).toBe(false);
  });

  /**
   * A default is a starting point, never a floor. `false` has to survive as
   * `false` — a `||` in the prefill would quietly turn every unticked
   * combination back on.
   */
  test("a default of false is honoured, not treated as unset", () => {
    const state = initialDiscountFormState(new Date(), null, {
      combinesShipping: false,
      oncePerCustomer: false,
    });

    expect(state.combinesShipping).toBe(false);
    expect(state.oncePerCustomer).toBe(false);
  });

  test("defaults never touch the fields that define one campaign", () => {
    const state = initialDiscountFormState(new Date("2026-09-10T00:00:00Z"), null, {
      scope: "item",
      checkoutNote: "Capped at our maximum",
    });

    // The offer itself, and the code, stay the merchant's to type.
    expect(state.code).toBe("");
    expect(state.capAmount).toBe("");
    expect(state.percentage).toBe("15");
  });

  /**
   * The form opens on the merchant's today. A shop in Phnom Penh opening the
   * form at 9am on the 11th used to be handed the 10th, because UTC had not
   * caught up — and a start date in the past is the one field the form
   * immediately rejects.
   */
  test("the start date is the merchant's today, not Greenwich's", () => {
    // 2026-09-10T18:30Z is already the 11th in Phnom Penh.
    const evening = new Date("2026-09-10T18:30:00Z");

    expect(initialDiscountFormState(evening).startDate).toBe("2026-09-10");
    expect(
      initialDiscountFormState(evening, null, { timeZone: PHNOM_PENH }).startDate,
    ).toBe("2026-09-11");
  });
});

describe("the dates a merchant types, in their own zone", () => {
  test("midnight means the merchant's midnight", () => {
    expect(combineDateTime("2026-09-10", "00:00", PHNOM_PENH)?.toISOString()).toBe(
      "2026-09-09T17:00:00.000Z",
    );
  });

  test("with no zone it behaves exactly as it always did", () => {
    expect(combineDateTime("2026-09-10", "09:30")?.toISOString()).toBe(
      "2026-09-10T09:30:00.000Z",
    );
  });

  /**
   * The regex admits a date the calendar does not. `Date.UTC` would roll
   * 31 February into 3 March rather than refuse, and a start date the merchant
   * never typed is worse than a field error.
   */
  test.each([
    ["2026-02-31", "February has no 31st"],
    ["2026-13-01", "there is no 13th month"],
    ["2026-04-31", "April has 30 days"],
  ])("%s is refused (%s)", (date) => {
    expect(combineDateTime(date, "00:00", PHNOM_PENH)).toBeNull();
  });

  test("a leap day in a leap year is a real date", () => {
    expect(combineDateTime("2028-02-29", "12:00", "UTC")?.toISOString()).toBe(
      "2028-02-29T12:00:00.000Z",
    );
  });
});

/**
 * The validator has to convert with the same zone the form displayed, or it
 * judges "ends before it starts" against instants the merchant never chose.
 */
describe("validating a campaign that spans the merchant's day", () => {
  const base = (over: Partial<DiscountFormState> = {}): DiscountFormState => ({
    ...initialDiscountFormState(new Date("2026-09-10T00:00:00Z")),
    code: "SUMMER15",
    percentage: "15",
    capAmount: "150.00",
    ...over,
  });

  test("a same-day campaign in the shop's zone is a real span", () => {
    const result = validateDiscountForm(
      base({
        startDate: "2026-09-10",
        startTime: "00:00",
        endDateOn: true,
        endDate: "2026-09-10",
        endTime: "23:59",
      }),
      "growth",
      "USD",
      PHNOM_PENH,
    );

    expect("errors" in result).toBe(false);
  });

  test("the stored instants are the merchant's day, not Greenwich's", () => {
    const result = validateDiscountForm(
      base({
        startDate: "2026-09-10",
        startTime: "00:00",
        endDateOn: true,
        endDate: "2026-09-30",
        endTime: "23:59",
      }),
      "growth",
      "USD",
      PHNOM_PENH,
    );

    expect("value" in result).toBe(true);
    if ("value" in result) {
      expect(result.value.startsAt.toISOString()).toBe("2026-09-09T17:00:00.000Z");
      expect(result.value.endsAt?.toISOString()).toBe("2026-09-30T16:59:00.000Z");
    }
  });

  test("an end before a start is still refused", () => {
    const result = validateDiscountForm(
      base({
        startDate: "2026-09-10",
        startTime: "12:00",
        endDateOn: true,
        endDate: "2026-09-10",
        endTime: "09:00",
      }),
      "growth",
      "USD",
      PHNOM_PENH,
    );

    expect("errors" in result).toBe(true);
  });
});
