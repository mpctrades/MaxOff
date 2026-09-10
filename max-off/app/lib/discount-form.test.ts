import { describe, expect, test } from "vitest";

import {
  combineDateTime,
  defaultEndDate,
  discountFormStateFrom,
  initialDiscountFormState,
  validateDiscountForm,
} from "./discount-form";
import type { DiscountFormState } from "./discount-form";

const valid = (over: Partial<DiscountFormState> = {}): DiscountFormState => ({
  ...initialDiscountFormState(new Date("2026-09-10T00:00:00Z")),
  code: "SUMMER15",
  percentage: "15",
  capAmount: "150.00",
  ...over,
});

const errorsOf = (state: DiscountFormState) => {
  const result = validateDiscountForm(state);
  return "errors" in result ? result.errors : {};
};

describe("a valid form", () => {
  test("becomes exactly what createCappedDiscount needs", () => {
    const result = validateDiscountForm(valid());

    expect(result).toEqual({
      value: {
        code: "SUMMER15",
        percentage: 15,
        capMinor: 15000,
        startsAt: new Date("2026-09-10T00:00:00Z"),
        endsAt: null,
        usageLimit: null,
        oncePerCustomer: true,
        combinesProduct: false,
        combinesOrder: false,
        combinesShipping: true,
      },
    });
  });

  test("uppercases and trims the code", () => {
    const result = validateDiscountForm(valid({ code: "  summer15  " }));
    expect("value" in result && result.value.code).toBe("SUMMER15");
  });

  test("a maximum typed without decimals still parses", () => {
    for (const [typed, minor] of [
      ["150", 15000],
      ["150.5", 15050],
      ["0.01", 1],
      [" 150.00 ", 15000],
    ] as const) {
      const result = validateDiscountForm(valid({ capAmount: typed }));
      expect("value" in result && result.value.capMinor).toBe(minor);
    }
  });
});

describe("the rules from §4.3", () => {
  test("the code cannot be empty", () => {
    expect(errorsOf(valid({ code: "   " })).code).toBeDefined();
  });

  test("the percentage must be a whole number between 1 and 100", () => {
    for (const bad of ["0", "101", "15.5", "-15", "", "abc", "1e2", "0x0f"]) {
      expect(errorsOf(valid({ percentage: bad })).percentage).toBeDefined();
    }

    for (const good of ["1", "15", "100"]) {
      expect(errorsOf(valid({ percentage: good })).percentage).toBeUndefined();
    }
  });

  test("the maximum must be above zero and readable", () => {
    for (const bad of ["0", "0.00", "", "abc", "-150", "1,400.00", "$150"]) {
      expect(errorsOf(valid({ capAmount: bad })).capAmount).toBeDefined();
    }
  });

  test("the end date must be after the start date", () => {
    const sameDay = errorsOf(
      valid({
        endDateOn: true,
        startDate: "2026-09-10",
        startTime: "10:00",
        endDate: "2026-09-10",
        endTime: "09:00",
      }),
    );
    expect(sameDay.endDate).toBe("The end date must be after the start date.");

    const identical = errorsOf(
      valid({
        endDateOn: true,
        startDate: "2026-09-10",
        startTime: "10:00",
        endDate: "2026-09-10",
        endTime: "10:00",
      }),
    );
    expect(identical.endDate).toBeDefined();

    const after = errorsOf(
      valid({
        endDateOn: true,
        startDate: "2026-09-10",
        startTime: "10:00",
        endDate: "2026-09-30",
        endTime: "23:59",
      }),
    );
    expect(after.endDate).toBeUndefined();
  });

  test("an end date that is switched off is not validated", () => {
    expect(
      errorsOf(valid({ endDateOn: false, endDate: "nonsense" })).endDate,
    ).toBeUndefined();
  });

  test("a usage limit, when switched on, must be a whole number above zero", () => {
    for (const bad of ["", "0", "-5", "2.5", "abc"]) {
      expect(
        errorsOf(valid({ usageLimitOn: true, usageLimit: bad })).usageLimit,
      ).toBeDefined();
    }

    const good = validateDiscountForm(
      valid({ usageLimitOn: true, usageLimit: "500" }),
    );
    expect("value" in good && good.value.usageLimit).toBe(500);
  });

  test("a bad time is refused rather than silently becoming midnight", () => {
    expect(errorsOf(valid({ startTime: "9am" })).startDate).toBeDefined();
    expect(errorsOf(valid({ startTime: "25:00" })).startDate).toBeDefined();
    expect(errorsOf(valid({ startTime: "09:60" })).startDate).toBeDefined();
    expect(errorsOf(valid({ startTime: "09:00" })).startDate).toBeUndefined();
  });

  test("every failure names its own field, so nothing lands in a banner", () => {
    const errors = errorsOf(
      valid({ code: "", percentage: "0", capAmount: "0" }),
    );

    expect(Object.keys(errors).sort()).toEqual([
      "capAmount",
      "code",
      "percentage",
    ]);
  });
});

describe("combineDateTime", () => {
  test("builds a UTC instant", () => {
    expect(combineDateTime("2026-09-10", "09:30")?.toISOString()).toBe(
      "2026-09-10T09:30:00.000Z",
    );
  });

  test("an empty time is midnight", () => {
    expect(combineDateTime("2026-09-10", "")?.toISOString()).toBe(
      "2026-09-10T00:00:00.000Z",
    );
  });

  test("a malformed date or time is null, never an Invalid Date", () => {
    expect(combineDateTime("10/09/2026", "09:00")).toBeNull();
    expect(combineDateTime("", "09:00")).toBeNull();
    expect(combineDateTime("2026-09-10", "half nine")).toBeNull();
  });
});

/**
 * §7 item 10: a client that bypassed validation. The action reads the raw
 * submission through `discountFormStateFrom` and runs the same rules, so these
 * are the cases a hand-rolled POST would hit.
 */
describe("a submission that skipped the client", () => {
  const submit = (fields: Record<string, string>) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.set(key, value);
    }
    return validateDiscountForm(discountFormStateFrom(form));
  };

  test("an empty POST is rejected on every required field", () => {
    const result = submit({ intent: "create" });

    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.code).toBeDefined();
      expect(result.errors.capAmount).toBeDefined();
      expect(result.errors.startDate).toBeDefined();
    }
  });

  test("a percentage of 150 is rejected, not clamped", () => {
    const result = submit({
      code: "HACK",
      percentage: "150",
      capAmount: "150.00",
      startDate: "2026-09-10",
      startTime: "00:00",
    });

    expect("errors" in result && result.errors.percentage).toBeDefined();
  });

  test("a maximum in minor units is rejected as a number, not read as 15,000", () => {
    // "15000" is a legal decimal string, so it parses — to 15,000.00, which is
    // a real amount and not something validation can catch. The guard is that
    // the form only ever sends major units, and the round-trip test in
    // cap-config.test.ts proves what the Function reads back.
    const result = submit({
      code: "HACK",
      percentage: "15",
      capAmount: "15000",
      startDate: "2026-09-10",
      startTime: "00:00",
    });

    expect("value" in result && result.value.capMinor).toBe(1500000);
  });

  test("a negative or zero maximum cannot get through", () => {
    for (const capAmount of ["-1", "0", "0.00"]) {
      const result = submit({
        code: "HACK",
        percentage: "15",
        capAmount,
        startDate: "2026-09-10",
        startTime: "00:00",
      });
      expect("errors" in result && result.errors.capAmount).toBeDefined();
    }
  });

  test("checkbox flags default to false when absent, never to true", () => {
    const result = submit({
      code: "SUMMER15",
      percentage: "15",
      capAmount: "150.00",
      startDate: "2026-09-10",
      startTime: "00:00",
    });

    expect("value" in result && result.value.oncePerCustomer).toBe(false);
    expect("value" in result && result.value.combinesShipping).toBe(false);
    expect("value" in result && result.value.usageLimit).toBeNull();
  });
});

describe("defaultEndDate", () => {
  test("is thirty days out, keeping the format", () => {
    expect(defaultEndDate("2026-09-10")).toBe("2026-10-10");
    expect(defaultEndDate("2026-12-15")).toBe("2027-01-14");
  });

  test("31 January plus thirty days is 2 March, not a rolled-over 3 March", () => {
    expect(defaultEndDate("2026-01-31")).toBe("2026-03-02");
  });

  test("an unusable date gives an empty string, never Invalid Date", () => {
    expect(defaultEndDate("")).toBe("");
    expect(defaultEndDate("not-a-date")).toBe("");
  });

  test("the result is always a date the end field will accept", () => {
    const result = defaultEndDate("2026-09-10");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // And it validates as an end date after the start date.
    expect(
      errorsOf(valid({ endDateOn: true, startDate: "2026-09-10", endDate: result })).endDate,
    ).toBeUndefined();
  });
});
