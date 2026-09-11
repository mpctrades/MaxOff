import { describe, expect, test } from "vitest";

import {
  activeDiscountLimit,
  can,
  CAPABILITIES,
  comingSoon,
  hasNow,
  includedNow,
  isPlanKey,
  maxCampaignDays,
  nextPlan,
  planCard,
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
  usageLimits: ["growth", "pro"],
  longCampaigns: ["growth", "pro"],
  analytics: ["growth", "pro"],
  customCheckoutWording: ["growth", "pro"],
  itemMaximums: ["pro"],
  collectionMaximums: ["pro"],
  campaignBudget: ["pro"],
  perMarketCurrency: ["pro"],
  csvExport: ["pro"],
  twelveMonthHistory: ["pro"],
  prioritySupport: ["pro"],
};

describe("the active discount limit", () => {
  test("the ladder is 3, 20, unlimited", () => {
    expect(activeDiscountLimit("free")).toBe(3);
    expect(activeDiscountLimit("growth")).toBe(20);
    expect(activeDiscountLimit("pro")).toBeNull();
  });

  test("an unknown plan is treated as Free, never as unlimited", () => {
    for (const value of ["", "enterprise", "PRO", "trial", null, undefined]) {
      expect(activeDiscountLimit(value as string)).toBe(3);
    }
  });
});

describe("the campaign length ceiling", () => {
  test("Free runs a discount for fifteen days; the paid plans have no ceiling", () => {
    expect(maxCampaignDays("free")).toBe(15);
    expect(maxCampaignDays("growth")).toBeNull();
    expect(maxCampaignDays("pro")).toBeNull();
  });

  test("an unknown plan gets the ceiling, never the absence of one", () => {
    for (const value of ["", "enterprise", "PRO", null, undefined]) {
      expect(maxCampaignDays(value as string)).toBe(15);
    }
  });

  test("the number and the entitlement say the same thing", () => {
    // PLAN_MAX_CAMPAIGN_DAYS is the number; longCampaigns is how a card says
    // it. Two ways of writing one fact, tied together so they cannot drift.
    for (const plan of PLAN_KEYS) {
      expect(can(plan, "longCampaigns")).toBe(maxCampaignDays(plan) === null);
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
      "usageLimits",
      "longCampaigns",
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
    // Growth adds uses, length, analytics and wording; it does not re-list the
    // order maximum.
    expect(upgradeAdds("free").map((entry) => entry.key)).toEqual([
      "usageLimits",
      "longCampaigns",
      "analytics",
      "customCheckoutWording",
    ]);

    // Pro adds the PRO features plus support; it does not re-list analytics.
    expect(upgradeAdds("growth").map((entry) => entry.key)).toEqual([
      "itemMaximums",
      "collectionMaximums",
      "campaignBudget",
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

describe("what a card says", () => {
  const labels = (plan: "free" | "growth" | "pro") =>
    planCard(plan).features.map(
      (feature) => `${feature.lead ? feature.lead + " " : ""}${feature.label}`,
    );

  test("Free leads with three, and says how long each one may run", () => {
    expect(labels("free")).toEqual([
      "3 capped discounts",
      "A maximum on the whole order",
      "Live preview and cart tester",
      "Start and end dates, up to 15 days per discount",
    ]);
  });

  test("Growth leads with twenty and ends on what it has", () => {
    expect(labels("growth")).toEqual([
      "20 capped discounts",
      "A maximum on the whole order",
      "Live preview and cart tester",
      "A limit on the total number of uses",
      "Discounts that run for as long as you like",
      "Custom checkout wording",
    ]);
  });

  test("no card lists a thing the plan does not have", () => {
    // The cards used to end on a dash. They name what a merchant gets now, so
    // "Per-item and per-collection caps" appears on Pro's card and nowhere
    // else — as a tick.
    for (const plan of PLAN_KEYS) {
      for (const feature of planCard(plan).features) {
        const match = CAPABILITIES.find((entry) =>
          feature.label.startsWith(entry.cardLabel ?? entry.label),
        );

        // The allowance line is not a capability; everything else must be one,
        // and must be granted to this plan.
        if (match) {
          expect(can(plan, match.key), `${plan}: ${feature.label}`).toBe(true);
        } else {
          expect(feature.label).toContain("capped discount");
        }
      }
    }
  });

  test("dates are Free's line and analytics is nobody's", () => {
    // Both are still entitlements; neither is part of Growth's pitch.
    expect(labels("growth")).not.toContain("Start and end dates");
    expect(can("growth", "activeDates")).toBe(true);

    for (const plan of PLAN_KEYS) {
      expect(labels(plan).join(" ")).not.toContain("Money-kept");
    }
    expect(can("growth", "analytics")).toBe(true);
  });

  test("Pro rolls Growth up but still states the allowance it changes", () => {
    const card = planCard("pro");

    expect(card.rollupFrom).toBe("growth");
    // Growth now carries a limit of 20, so unlimited is something Pro adds
    // rather than something "Everything in Growth" already covered.
    expect(labels("pro")[0]).toBe("Unlimited capped discounts");
  });

  test("export and history are one line on Pro, and two entitlements", () => {
    expect(labels("pro")).toContain("CSV export and 12-month history");
    expect(labels("pro")).not.toContain("12-month history");

    // Still two gates: the Export button and the analytics range chips are
    // refused separately.
    expect(can("pro", "csvExport")).toBe(true);
    expect(can("pro", "twelveMonthHistory")).toBe(true);
    expect(can("growth", "twelveMonthHistory")).toBe(false);
  });

  test("no card ticks a line its plan is not entitled to", () => {
    for (const entry of CAPABILITIES) {
      for (const plan of entry.onCard) {
        expect(entry.plans, entry.key).toContain(plan);
      }
    }
  });
});
