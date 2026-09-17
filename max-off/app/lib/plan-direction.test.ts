import { describe, expect, it } from "vitest";

import {
  PLAN_KEYS,
  planActionLabel,
  planAllowanceSummary,
  planDirection,
} from "./plans";
import type { PlanKey } from "./plans";

/**
 * The colour of a plan's button is decided by where that plan sits relative to
 * the merchant's own, and by nothing else. These cover all nine combinations
 * rather than the three a screenshot can show — a screenshot proves one state
 * on one day, and the thing worth protecting is that no card is special-cased
 * by name.
 */
describe("planDirection", () => {
  it("covers every plan against every current plan", () => {
    const table: Record<PlanKey, Record<PlanKey, string>> = {
      // current plan → what each card should be
      free: { free: "current", growth: "up", pro: "up" },
      growth: { free: "down", growth: "current", pro: "up" },
      pro: { free: "down", growth: "down", pro: "current" },
    };

    for (const currentPlan of PLAN_KEYS) {
      for (const plan of PLAN_KEYS) {
        expect(planDirection(plan, currentPlan), `${plan} when on ${currentPlan}`)
          .toBe(table[currentPlan][plan]);
      }
    }
  });

  it("is current for exactly one plan, whichever plan is current", () => {
    for (const currentPlan of PLAN_KEYS) {
      const current = PLAN_KEYS.filter(
        (plan) => planDirection(plan, currentPlan) === "current",
      );
      expect(current).toEqual([currentPlan]);
    }
  });

  it("never reports a plan as both up and down", () => {
    for (const currentPlan of PLAN_KEYS) {
      const ups = PLAN_KEYS.filter((p) => planDirection(p, currentPlan) === "up");
      const downs = PLAN_KEYS.filter(
        (p) => planDirection(p, currentPlan) === "down",
      );
      expect(ups.filter((p) => downs.includes(p))).toEqual([]);
      expect(ups.length + downs.length).toBe(PLAN_KEYS.length - 1);
    }
  });

  /* The acceptance case, spelled out: on Growth exactly one card moves the
     merchant down, one is theirs, and one moves them up. */
  it("gives Growth one of each", () => {
    expect(PLAN_KEYS.map((plan) => planDirection(plan, "growth"))).toEqual([
      "down",
      "current",
      "up",
    ]);
  });
});

describe("planActionLabel", () => {
  it("names the verb as well as the plan, so colour is never the only signal", () => {
    expect(planActionLabel("free", "growth")).toBe("Move to Free");
    expect(planActionLabel("growth", "growth")).toBe("Current plan");
    expect(planActionLabel("pro", "growth")).toBe("Upgrade to Pro");
  });

  it("uses Upgrade only upward and Move only downward", () => {
    for (const currentPlan of PLAN_KEYS) {
      for (const plan of PLAN_KEYS) {
        const label = planActionLabel(plan, currentPlan);
        const direction = planDirection(plan, currentPlan);

        if (direction === "up") {
          expect(label.startsWith("Upgrade to ")).toBe(true);
        } else if (direction === "down") {
          expect(label.startsWith("Move to ")).toBe(true);
        } else {
          expect(label).toBe("Current plan");
        }
      }
    }
  });
});

describe("planAllowanceSummary", () => {
  it("reads as one lower-case clause for the line above the cards", () => {
    expect(planAllowanceSummary("free")).toBe(
      "3 capped discounts, whole-order maximum",
    );
    expect(planAllowanceSummary("growth")).toBe(
      "20 capped discounts, whole-order maximum",
    );
  });

  it("says unlimited rather than a number where there is no ceiling", () => {
    expect(planAllowanceSummary("pro")).toContain("unlimited capped discounts");
  });

  it("never starts with a capital, because it lands mid-sentence", () => {
    for (const plan of PLAN_KEYS) {
      const summary = planAllowanceSummary(plan);
      expect(summary[0]).toBe(summary[0].toLowerCase());
    }
  });
});
