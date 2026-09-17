import { describe, expect, it } from "vitest";

import { formatTrialRemaining } from "./format";
import { planPitch, PLAN_KEYS } from "./plans";
import { trialEndFor } from "../models/plan.server";

/**
 * The Admin API has no `trialEndsAt`. `AppSubscription` gives `createdAt` and
 * `trialDays` ("the number of free trial days, starting at the subscription's
 * creation date, by which billing is delayed"), so the end is the sum — and
 * that arithmetic is worth pinning down, because nothing on a dev store will
 * ever exercise it.
 */
describe("trialEndFor", () => {
  const created = "2026-09-01T00:00:00.000Z";

  it("is createdAt plus trialDays", () => {
    const now = new Date("2026-09-05T00:00:00.000Z");
    expect(trialEndFor(created, 14, now)).toBe("2026-09-15T00:00:00.000Z");
  });

  it("is null once the trial has elapsed", () => {
    const now = new Date("2026-09-20T00:00:00.000Z");
    expect(trialEndFor(created, 14, now)).toBeNull();
  });

  it("is null when there is no trial at all", () => {
    const now = new Date("2026-09-02T00:00:00.000Z");
    expect(trialEndFor(created, 0, now)).toBeNull();
    expect(trialEndFor(created, null, now)).toBeNull();
    expect(trialEndFor(null, 14, now)).toBeNull();
  });

  it("does not trust a malformed date", () => {
    expect(trialEndFor("not a date", 14, new Date())).toBeNull();
  });
});

describe("formatTrialRemaining", () => {
  const now = new Date("2026-09-17T12:00:00.000Z");

  it("counts in hours on the last two days", () => {
    expect(formatTrialRemaining(new Date("2026-09-18T10:00:00.000Z"), now)).toBe(
      "22 hours left",
    );
  });

  it("counts in days beyond that", () => {
    expect(formatTrialRemaining(new Date("2026-09-23T12:00:00.000Z"), now)).toBe(
      "6 days left",
    );
  });

  it("singularises the last hour", () => {
    expect(formatTrialRemaining(new Date("2026-09-17T12:30:00.000Z"), now)).toBe(
      "1 hour left",
    );
  });

  it("is null once it has run out, so an ended trial cannot render", () => {
    expect(formatTrialRemaining(new Date("2026-09-17T12:00:00.000Z"), now)).toBeNull();
    expect(formatTrialRemaining(new Date("2026-09-16T12:00:00.000Z"), now)).toBeNull();
  });
});

describe("planPitch", () => {
  it("sells the step up, built from the capability matrix", () => {
    expect(planPitch("free")).toEqual({
      offer: "20 capped discounts and no time limit",
      target: "growth",
    });
    expect(planPitch("growth")).toEqual({
      offer: "Unlimited discounts and per-item caps",
      target: "pro",
    });
  });

  it("has nothing to sell on the top plan", () => {
    expect(planPitch("pro")).toBeNull();
  });

  it("never pitches a plan at itself", () => {
    for (const plan of PLAN_KEYS) {
      expect(planPitch(plan)?.target).not.toBe(plan);
    }
  });
});
