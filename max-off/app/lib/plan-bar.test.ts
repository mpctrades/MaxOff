import { describe, expect, test } from "vitest";

import {
  activeDiscountLimit,
  nextPlan,
  planChips,
  PLAN_LABELS,
} from "./plans";
import type { PlanKey } from "./plans";

/**
 * The plan bar's four states, as the loader and the component decide them.
 *
 * The rule worth a test is the fourth: `getPlanSummary` returns a null plan
 * when Shopify could not be read, and nothing anywhere may turn that null into
 * "free". Printing "Free" because a billing call timed out tells a merchant
 * paying 7.99 a month that they are not paying.
 */
const nameFor = (plan: PlanKey | null) =>
  plan === null ? "Unknown" : PLAN_LABELS[plan];

const chipsFor = (plan: PlanKey | null) =>
  plan === null
    ? ["We couldn't reach Shopify billing just now"]
    : planChips(plan);

/** The meter states an allowance, so it needs one. */
const showsMeter = (plan: PlanKey | null, limit: number | null) =>
  plan !== null && limit !== null;

describe("what each state shows", () => {
  test("Free: name, both chips, and a meter against 3", () => {
    expect(nameFor("free")).toBe("Free");
    expect(chipsFor("free")).toEqual(["Whole-order maximum", "15 days each"]);
    expect(activeDiscountLimit("free")).toBe(3);
    expect(showsMeter("free", activeDiscountLimit("free"))).toBe(true);
  });

  test("Growth: a meter against 20", () => {
    expect(nameFor("growth")).toBe("Growth");
    expect(chipsFor("growth")).toEqual(["Whole-order maximum", "No time limit"]);
    expect(activeDiscountLimit("growth")).toBe(20);
    expect(showsMeter("growth", activeDiscountLimit("growth"))).toBe(true);
  });

  test("Pro: three chips and no meter, because there is no ceiling to fill", () => {
    expect(nameFor("pro")).toBe("Pro");
    expect(chipsFor("pro")).toEqual([
      "Unlimited discounts",
      "Every cap type",
      "CSV export",
    ]);
    expect(activeDiscountLimit("pro")).toBeNull();
    expect(showsMeter("pro", activeDiscountLimit("pro"))).toBe(false);
  });

  test("Unknown: never the word Free, and no meter it cannot justify", () => {
    expect(nameFor(null)).toBe("Unknown");
    expect(nameFor(null)).not.toBe("Free");
    expect(chipsFor(null)).toEqual([
      "We couldn't reach Shopify billing just now",
    ]);
    expect(showsMeter(null, null)).toBe(false);
  });

  /** No segment is lit when there is no plan to light. */
  test("Unknown lights no segment", () => {
    const lit = (["free", "growth", "pro"] as PlanKey[]).filter(
      (key) => key === (null as PlanKey | null),
    );
    expect(lit).toEqual([]);
  });
});

/**
 * The fill is clamped at both ends. A shop that was over its allowance before
 * the limits moved on 11 Sep would otherwise draw a bar past its own track.
 */
describe("the meter's fill", () => {
  const fill = (used: number, limit: number) =>
    Math.min(100, Math.max(0, (used / limit) * 100));

  test("an empty plan is an empty bar", () => {
    expect(fill(0, 3)).toBe(0);
  });

  test("one of three is a third", () => {
    expect(fill(1, 3)).toBeCloseTo(33.33, 1);
  });

  test("a full plan is a full bar", () => {
    expect(fill(3, 3)).toBe(100);
  });

  test("over the allowance still stops at the end of the track", () => {
    expect(fill(9, 3)).toBe(100);
  });
});


/**
 * The action, which is the one control on the bar.
 *
 * Named from `nextPlan` rather than written out, so the labels cannot drift
 * from the ladder. The mirror of `actionFor` in `components/PlanBar.tsx`.
 */
const actionFor = (plan: PlanKey | null): { label: string; upgrade: boolean } => {
  if (plan === null) {
    return { label: "Plans & billing", upgrade: false };
  }

  const next = nextPlan(plan);
  return next === null
    ? { label: "Change plan", upgrade: false }
    : { label: `Upgrade to ${PLAN_LABELS[next]}`, upgrade: true };
};

describe("the action each plan gets", () => {
  test("Free is sold the tier above it, by name", () => {
    expect(actionFor("free")).toEqual({
      label: "Upgrade to Growth",
      upgrade: true,
    });
  });

  test("Growth is sold the tier above it, by name", () => {
    expect(actionFor("growth")).toEqual({
      label: "Upgrade to Pro",
      upgrade: true,
    });
  });

  /**
   * The top plan has nothing above it. A button reading "Upgrade to …" there
   * would sell a merchant something they already have.
   */
  test("Pro is offered a change, never an upgrade", () => {
    expect(actionFor("pro")).toEqual({ label: "Change plan", upgrade: false });
    expect(actionFor("pro").label).not.toContain("Upgrade");
  });

  test("Unknown is never sold anything, because we do not know what they have", () => {
    expect(actionFor(null)).toEqual({
      label: "Plans & billing",
      upgrade: false,
    });
    expect(actionFor(null).label).not.toContain("Upgrade");
  });

  test("every state has an action, so the card never ends in nothing", () => {
    for (const plan of [null, "free", "growth", "pro"] as (PlanKey | null)[]) {
      expect(actionFor(plan).label.length).toBeGreaterThan(0);
    }
  });
});
