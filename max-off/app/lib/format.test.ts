import { describe, expect, test } from "vitest";

import {
  formatAmountPlain,
  formatDate,
  formatDateRange,
  formatMoney,
  formatPercent,
} from "./format";

/**
 * The amounts from the cap-arithmetic table in BUILD-SPEC §8. The arithmetic
 * itself is tested in the Function's own suite; what is under test here is that
 * every number that table produces reaches a merchant in the §6 format.
 */
const SPEC_8_AMOUNTS: [minor: number, expected: string][] = [
  [140000, "1,400.00 USD"],
  [15000, "150.00 USD"],
  [10500, "105.00 USD"],
  [6000, "60.00 USD"],
  [70000, "700.00 USD"],
  [100000, "1,000.00 USD"],
  [0, "0.00 USD"],
  [20000, "200.00 USD"],
  [5000, "50.00 USD"],
  [3333, "33.33 USD"],
  [500, "5.00 USD"],
  [1400, "14.00 USD"],
  [1, "0.01 USD"],
  [20999, "209.99 USD"],
];

describe("formatAmountPlain", () => {
  test("drops the cents when they are zero", () => {
    expect(formatAmountPlain(100000)).toBe("1,000");
    expect(formatAmountPlain(15000)).toBe("150");
    expect(formatAmountPlain(0)).toBe("0");
  });

  test("keeps the cents when they are not", () => {
    expect(formatAmountPlain(15050)).toBe("150.50");
    expect(formatAmountPlain(214286)).toBe("2,142.86");
    expect(formatAmountPlain(1)).toBe("0.01");
  });

  test("groups thousands and carries no currency code", () => {
    expect(formatAmountPlain(123456789)).toBe("1,234,567.89");
    expect(formatAmountPlain(100000)).not.toContain("USD");
  });

  test("keeps the sign on a negative amount", () => {
    expect(formatAmountPlain(-15000)).toBe("-150");
    expect(formatAmountPlain(-15050)).toBe("-150.50");
  });
});

describe("formatMoney", () => {
  test.each(SPEC_8_AMOUNTS)("%i minor units renders as %s", (minor, expected) => {
    expect(formatMoney(minor, "USD")).toBe(expected);
  });

  test("puts the currency code after the number, never a symbol", () => {
    expect(formatMoney(123450, "USD")).toBe("1,234.50 USD");
    expect(formatMoney(123450, "USD")).not.toContain("$");
  });

  test("relabels rather than converts — same number, different code", () => {
    expect(formatMoney(15000, "EUR")).toBe("150.00 EUR");
    expect(formatMoney(15000, "JPY")).toBe("150.00 JPY");
  });

  test("groups every thousands boundary in en-US, for every currency", () => {
    expect(formatMoney(100000000, "USD")).toBe("1,000,000.00 USD");
    expect(formatMoney(100000000, "EUR")).toBe("1,000,000.00 EUR");
    expect(formatMoney(99999, "USD")).toBe("999.99 USD");
    expect(formatMoney(100000, "USD")).toBe("1,000.00 USD");
  });

  test("always shows two decimals", () => {
    expect(formatMoney(10, "USD")).toBe("0.10 USD");
    expect(formatMoney(1, "USD")).toBe("0.01 USD");
    expect(formatMoney(1000, "USD")).toBe("10.00 USD");
  });

  test("keeps a negative amount negative — a month-on-month fall is real", () => {
    expect(formatMoney(-6000, "USD")).toBe("-60.00 USD");
    expect(formatMoney(-1, "USD")).toBe("-0.01 USD");
  });
});

describe("formatPercent", () => {
  test("whole numbers only", () => {
    expect(formatPercent(15)).toBe("15%");
    expect(formatPercent(1)).toBe("1%");
    expect(formatPercent(100)).toBe("100%");
  });
});

describe("dates", () => {
  test("a single date reads as in §6", () => {
    expect(formatDate(new Date("2026-09-10T00:00:00Z"))).toBe("10 Sep 2026");
  });

  test("a range inside one year names the year once", () => {
    expect(
      formatDateRange(
        new Date("2026-09-10T00:00:00Z"),
        new Date("2026-09-30T23:59:59Z"),
      ),
    ).toBe("10 Sep – 30 Sep 2026");
  });

  test("a range across two years names both", () => {
    expect(
      formatDateRange(
        new Date("2026-12-10T00:00:00Z"),
        new Date("2027-01-03T00:00:00Z"),
      ),
    ).toBe("10 Dec 2026 – 3 Jan 2027");
  });

  test("no end date says so instead of showing a dash", () => {
    expect(formatDateRange(new Date("2026-09-10T00:00:00Z"), null)).toBe(
      "From 10 Sep 2026",
    );
  });

  test("is rendered in UTC, so a late-evening date does not slip a day", () => {
    expect(formatDate(new Date("2026-09-10T23:30:00Z"))).toBe("10 Sep 2026");
  });
});
