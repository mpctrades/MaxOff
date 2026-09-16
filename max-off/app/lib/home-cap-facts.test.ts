/**
 * The two order-free figures on Home.
 *
 * `getHomeData` computes them inline from the active discounts it already
 * queries, so this pins the arithmetic itself — the same reduction, run over
 * the same shapes — without standing a database up. If the loop in
 * `home.server.ts` changes, these are the cases it must still satisfy.
 */

import { describe, expect, it } from "vitest";

import { capStartsAboveMinor } from "./cap";

interface Row {
  code: string | null;
  percentage: number;
  capMinor: number;
}

interface Fact {
  amountMinor: number;
  code: string | null;
  percentage: number;
}

/** The reduction as `getHomeData` performs it. */
function capFacts(rows: Row[]): {
  biggestMaximum: Fact | null;
  earliestCapStartsAbove: Fact | null;
} {
  let biggestMaximum: Fact | null = null;
  let earliestCapStartsAbove: Fact | null = null;

  for (const row of rows) {
    if (biggestMaximum === null || row.capMinor > biggestMaximum.amountMinor) {
      biggestMaximum = {
        amountMinor: row.capMinor,
        code: row.code,
        percentage: row.percentage,
      };
    }

    const startsAbove = capStartsAboveMinor(row.capMinor, row.percentage);
    if (
      startsAbove !== null &&
      (earliestCapStartsAbove === null ||
        startsAbove < earliestCapStartsAbove.amountMinor)
    ) {
      earliestCapStartsAbove = {
        amountMinor: startsAbove,
        code: row.code,
        percentage: row.percentage,
      };
    }
  }

  return { biggestMaximum, earliestCapStartsAbove };
}

// The dev store's own four discounts, which is what the screenshots show.
const REAL: Row[] = [
  { code: "VIP007", percentage: 20, capMinor: 8000 },
  { code: "WELCOME", percentage: 10, capMinor: 2500 },
  { code: "BLACKFRIDAY", percentage: 30, capMinor: 20000 },
  { code: "SUMMER15", percentage: 15, capMinor: 1000 },
];

describe("capFacts", () => {
  it("has nothing to say with no active discounts", () => {
    expect(capFacts([])).toEqual({
      biggestMaximum: null,
      earliestCapStartsAbove: null,
    });
  });

  it("picks the largest maximum, not the largest percentage", () => {
    // SUMMER15 is not the biggest maximum despite a middling percentage, and
    // BLACKFRIDAY wins on 200.00 rather than on being 30%.
    expect(capFacts(REAL).biggestMaximum).toEqual({
      amountMinor: 20000,
      code: "BLACKFRIDAY",
      percentage: 30,
    });
  });

  it("picks the earliest cap, which is not the smallest maximum's owner by luck", () => {
    // SUMMER15: 10.00 ÷ 15% = 66.67 — the first maximum to bite.
    expect(capFacts(REAL).earliestCapStartsAbove).toEqual({
      amountMinor: 6667,
      code: "SUMMER15",
      percentage: 15,
    });
  });

  it("matches the figures the app shows for a single discount", () => {
    // 150.00 at 15% → cap starts above 1,000.00, the locked example in §11.
    const facts = capFacts([
      { code: "SITEWIDE", percentage: 15, capMinor: 15000 },
    ]);
    expect(facts.biggestMaximum?.amountMinor).toBe(15000);
    expect(facts.earliestCapStartsAbove?.amountMinor).toBe(100000);
  });

  it("skips a 0% discount when choosing the earliest cap", () => {
    // capStartsAboveMinor returns null at 0% rather than Infinity, so such a
    // row must not become the earliest cap by sorting below everything.
    const facts = capFacts([
      { code: "ZERO", percentage: 0, capMinor: 500 },
      { code: "REAL", percentage: 10, capMinor: 2500 },
    ]);
    expect(facts.earliestCapStartsAbove).toEqual({
      amountMinor: 25000,
      code: "REAL",
      percentage: 10,
    });
  });

  it("returns no earliest cap when every discount is at 0%", () => {
    const facts = capFacts([{ code: "ZERO", percentage: 0, capMinor: 500 }]);
    expect(facts.earliestCapStartsAbove).toBeNull();
    // …but the maximum is still a real number worth stating.
    expect(facts.biggestMaximum?.amountMinor).toBe(500);
  });

  it("keeps the first of two identical maximums rather than flapping", () => {
    const facts = capFacts([
      { code: "FIRST", percentage: 10, capMinor: 5000 },
      { code: "SECOND", percentage: 10, capMinor: 5000 },
    ]);
    expect(facts.biggestMaximum?.code).toBe("FIRST");
  });

  it("carries a null code for an automatic discount", () => {
    const facts = capFacts([{ code: null, percentage: 25, capMinor: 9000 }]);
    expect(facts.biggestMaximum?.code).toBeNull();
  });
});
