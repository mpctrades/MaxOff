import { describe, expect, test } from "vitest";

import {
  activeDiscountLimit,
  can,
  CAPABILITIES,
  comingSoon,
  hasNow,
  includedNow,
  isPlanKey,
  nextPlan,
  PLAN_KEYS,
  toPlanKey,
  upgradeAdds,
} from "./plans";
import type { CapabilityKey, PlanKey } from "./plans";

/**
 * The §1 table of docs/PROMPT-BILLING.md, transcribed once. If the module and
 * this table disagree, one of them is wrong and a test says so — which is the
 * whole point of the module existing.
 */
const TABLE: Record<CapabilityKey, PlanKey[]> = {
  orderMaximum: ["free", "growth", "pro"],
  previewAndTester: ["free", "growth", "pro"],
  activeDates: ["free", "growth", "pro"],
  analytics: ["growth", "pro"],
  customCheckoutWording: ["growth", "pro"],
  itemAndCollectionMaximums: ["pro"],
  perMarketCurrency: ["pro"],
  csvExport: ["pro"],
  twelveMonthHistory: ["pro"],
  prioritySupport: ["pro"],
};

describe("the active discount limit", () => {
  test("Free allows exactly one", () => {
    expect(activeDiscountLimit("free")).toBe(1);
  });

  test("Growth and Pro are unlimited", () => {
    expect(activeDiscountLimit("growth")).toBeNull();
    expect(activeDiscountLimit("pro")).toBeNull();
  });

  test("an unknown plan is treated as Free, never as unlimited", () => {
    for (const value of ["", "enterprise", "PRO", "trial", null, undefined]) {
      expect(activeDiscountLimit(value as string)).toBe(1);
    }
  });
});

describe("can() against the §1 table", () => {
  test("every key on every plan agrees with the table", () => {
    for (const [key, plans] of Object.entries(TABLE) as [
      CapabilityKey,
      PlanKey[],
    ][]) {
      for (const plan of PLAN_KEYS) {
        expect(can(plan, key)).toBe(plans.includes(plan));
      }
    }
  });

  test("the module has an entry for every key in the table, and no extras", () => {
    expect(CAPABILITIES.map((entry) => entry.key).sort()).toEqual(
      Object.keys(TABLE).sort(),
    );
  });

  test("an unknown capability is refused rather than allowed", () => {
    expect(can("pro", "somethingElse" as CapabilityKey)).toBe(false);
  });

  test("start and end dates are a Free capability (§0c)", () => {
    expect(can("free", "activeDates")).toBe(true);
    expect(hasNow("free", "activeDates")).toBe(true);
  });

  test("nothing claims a Powered-by-MaxOff entitlement", () => {
    const labels = CAPABILITIES.map((entry) => entry.label.toLowerCase());
    expect(labels.some((label) => label.includes("powered by"))).toBe(false);
  });
});

describe("built versus entitled", () => {
  test("hasNow is entitlement and built, together", () => {
    // Growth is entitled to analytics, but it does not exist yet.
    expect(can("growth", "analytics")).toBe(true);
    expect(hasNow("growth", "analytics")).toBe(false);

    // Free is not entitled to it at all.
    expect(can("free", "analytics")).toBe(false);
    expect(hasNow("free", "analytics")).toBe(false);
  });

  test("Included now lists only things that work", () => {
    for (const plan of PLAN_KEYS) {
      expect(includedNow(plan).every((entry) => entry.built)).toBe(true);
    }

    // Every plan can do the three built things today.
    expect(includedNow("free").map((entry) => entry.key)).toEqual([
      "orderMaximum",
      "previewAndTester",
      "activeDates",
    ]);
    expect(includedNow("pro").map((entry) => entry.key)).toEqual([
      "orderMaximum",
      "previewAndTester",
      "activeDates",
    ]);
  });

  test("Coming soon lists only things that do not", () => {
    for (const plan of PLAN_KEYS) {
      expect(comingSoon(plan).every((entry) => !entry.built)).toBe(true);
    }

    expect(comingSoon("free")).toEqual([]);
    expect(comingSoon("growth").map((entry) => entry.key)).toEqual([
      "analytics",
      "customCheckoutWording",
    ]);
  });

  test("the two lists never overlap and cover every entitlement", () => {
    for (const plan of PLAN_KEYS) {
      const now = includedNow(plan).map((entry) => entry.key);
      const coming = comingSoon(plan).map((entry) => entry.key);

      expect(now.filter((key) => coming.includes(key))).toEqual([]);
      expect([...now, ...coming].sort()).toEqual(
        CAPABILITIES.filter((entry) => entry.plans.includes(plan))
          .map((entry) => entry.key)
          .sort(),
      );
    }
  });

  test("every unbuilt capability says why, for the next developer", () => {
    for (const entry of CAPABILITIES) {
      if (!entry.built) {
        expect(entry.note, entry.key).toBeTruthy();
      }
    }
  });
});

describe("the upsell", () => {
  test("Free is offered Growth, Growth is offered Pro, Pro is offered nothing", () => {
    expect(nextPlan("free")).toBe("growth");
    expect(nextPlan("growth")).toBe("pro");
    expect(nextPlan("pro")).toBeNull();
  });

  test("Pro has nothing left to add, so the card has nothing to say", () => {
    expect(upgradeAdds("pro")).toEqual([]);
  });

  test("moving up lists only what is new to the merchant", () => {
    // Growth adds analytics and wording; it does not re-list the order maximum.
    expect(upgradeAdds("free").map((entry) => entry.key)).toEqual([
      "analytics",
      "customCheckoutWording",
    ]);

    // Pro adds the four PRO features plus support; it does not re-list analytics.
    expect(upgradeAdds("growth").map((entry) => entry.key)).toEqual([
      "itemAndCollectionMaximums",
      "perMarketCurrency",
      "csvExport",
      "twelveMonthHistory",
      "prioritySupport",
    ]);
    expect(upgradeAdds("growth").map((entry) => entry.key)).not.toContain(
      "analytics",
    );
  });
});

describe("plan keys", () => {
  test("only the three are valid", () => {
    expect(isPlanKey("free")).toBe(true);
    expect(isPlanKey("growth")).toBe(true);
    expect(isPlanKey("pro")).toBe(true);
    expect(isPlanKey("enterprise")).toBe(false);
    expect(isPlanKey(null)).toBe(false);
  });

  test("anything unreadable falls back to Free", () => {
    expect(toPlanKey("Growth")).toBe("free");
    expect(toPlanKey(undefined)).toBe("free");
    expect(toPlanKey("growth")).toBe("growth");
  });
});
