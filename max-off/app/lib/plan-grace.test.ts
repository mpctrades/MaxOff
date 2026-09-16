import { describe, expect, it } from "vitest";

import {
  GRACE_DAYS,
  excessToPause,
  graceDeadline,
  graceState,
} from "./plan-grace";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-16T00:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

describe("graceState", () => {
  it("is ok when the shop is inside its allowance", () => {
    const state = graceState({ limit: 3, activeCount: 3, since: null, now: NOW });
    expect(state.status).toBe("ok");
    expect(state.overBy).toBe(0);
    expect(state.deadline).toBeNull();
  });

  it("is ok below the allowance", () => {
    expect(
      graceState({ limit: 3, activeCount: 1, since: null, now: NOW }).status,
    ).toBe("ok");
  });

  it("never enforces on an unlimited plan", () => {
    const state = graceState({
      limit: null,
      activeCount: 999,
      since: days(-90),
      now: NOW,
    });
    expect(state.status).toBe("ok");
    expect(state.overBy).toBe(0);
  });

  // The null limit is also what `getPlanSummary` returns when the Shopify read
  // failed. Pausing a merchant's discounts because a GraphQL call timed out
  // would be the worst bug in the app, so this is pinned by its own test.
  it("never enforces when the plan could not be read", () => {
    expect(
      graceState({ limit: null, activeCount: 20, since: days(-30), now: NOW })
        .status,
    ).toBe("ok");
  });

  it("warns on the first sighting and dates the deadline from now", () => {
    const state = graceState({ limit: 3, activeCount: 4, since: null, now: NOW });
    expect(state.status).toBe("warning");
    expect(state.overBy).toBe(1);
    expect(state.limit).toBe(3);
    expect(state.deadline).toEqual(days(GRACE_DAYS));
  });

  it("keeps the original deadline on later sightings", () => {
    const since = days(-3);
    const state = graceState({ limit: 3, activeCount: 4, since, now: NOW });
    expect(state.status).toBe("warning");
    expect(state.deadline).toEqual(new Date(since.getTime() + GRACE_DAYS * DAY_MS));
  });

  it("still warns one millisecond before the deadline", () => {
    const since = new Date(NOW.getTime() - GRACE_DAYS * DAY_MS + 1);
    expect(graceState({ limit: 3, activeCount: 4, since, now: NOW }).status).toBe(
      "warning",
    );
  });

  it("expires exactly on the deadline", () => {
    const since = days(-GRACE_DAYS);
    expect(graceState({ limit: 3, activeCount: 4, since, now: NOW }).status).toBe(
      "expired",
    );
  });

  it("expires after the deadline", () => {
    expect(
      graceState({ limit: 3, activeCount: 4, since: days(-30), now: NOW }).status,
    ).toBe("expired",
    );
  });

  it("reports how far over the allowance the shop is", () => {
    expect(
      graceState({ limit: 3, activeCount: 20, since: null, now: NOW }).overBy,
    ).toBe(17);
  });

  // The case that started this: created on Growth, then downgraded to Free.
  it("covers the 4-of-3 downgrade case", () => {
    const state = graceState({ limit: 3, activeCount: 4, since: null, now: NOW });
    expect(state).toMatchObject({ status: "warning", overBy: 1, limit: 3 });
  });
});

describe("graceDeadline", () => {
  it("is GRACE_DAYS after the start", () => {
    expect(graceDeadline(NOW)).toEqual(days(GRACE_DAYS));
  });
});

describe("excessToPause", () => {
  it("is the number above the allowance", () => {
    expect(excessToPause({ limit: 3, activeCount: 4 })).toBe(1);
    expect(excessToPause({ limit: 3, activeCount: 20 })).toBe(17);
  });

  it("is zero inside the allowance", () => {
    expect(excessToPause({ limit: 3, activeCount: 3 })).toBe(0);
    expect(excessToPause({ limit: 3, activeCount: 0 })).toBe(0);
  });

  it("is never negative", () => {
    expect(excessToPause({ limit: 20, activeCount: 1 })).toBe(0);
  });

  it("is zero on an unlimited plan", () => {
    expect(excessToPause({ limit: null, activeCount: 999 })).toBe(0);
  });
});
