import { describe, expect, test } from "vitest";
import { planChips } from "./plans";

describe("the plan bar's chips", () => {
  test("Free names the maximum it has and the ceiling it runs under", () => {
    expect(planChips("free")).toEqual(["Whole-order maximum", "15 days each"]);
  });
  test("Growth is the same maximum, without the ceiling", () => {
    expect(planChips("growth")).toEqual(["Whole-order maximum", "No time limit"]);
  });
  test("Pro names what only Pro has", () => {
    expect(planChips("pro")).toEqual([
      "Unlimited discounts",
      "Every cap type",
      "CSV export",
    ]);
  });
});
