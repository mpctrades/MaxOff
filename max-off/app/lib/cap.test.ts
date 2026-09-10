import { describe, expect, test } from "vitest";

import { capStartsAboveMinor, displayStatus, displayStatusLabel } from "./cap";

/**
 * The cap-arithmetic table from BUILD-SPEC §8, read for the number this module
 * owns: where the cap starts to bite. The `given`/`kept` columns are the
 * Function's to prove, and its own suite does.
 */
describe("capStartsAboveMinor — the §8 table", () => {
  test.each([
    // pct, cap minor, expected "cap starts above" minor, note
    [15, 15000, 100000, "15% of 1,000.00 is exactly the 150.00 maximum"],
    [100, 15000, 15000, "a 100% discount hits a 150.00 maximum at 150.00"],
    [1, 15000, 1500000, "1% needs a 15,000.00 cart to give 150.00"],
    [15, 1, 7, "a 0.01 maximum bites almost immediately: 0.07"],
    [12, 6000, 50000, "SPRING12 — 60.00 maximum starts above 500.00"],
    [20, 8000, 40000, "VIP20 — 80.00 maximum starts above 400.00"],
    [10, 2500, 25000, "WELCOME10 — 25.00 maximum starts above 250.00"],
    [30, 20000, 66667, "BF30 — 200.00 maximum, half-up to 666.67"],
  ])("%i%% with a %i minor maximum starts above %i", (pct, cap, expected) => {
    expect(capStartsAboveMinor(cap, pct)).toBe(expected);
  });

  test("rounds half-up, once", () => {
    // 30% of 666.66 gives 199.998 → under the cap; 666.67 gives 200.001 → over.
    expect(capStartsAboveMinor(20000, 30)).toBe(66667);
    // 7% of 214.28 = 14.9996, of 214.29 = 15.0003.
    expect(capStartsAboveMinor(1500, 7)).toBe(21429);
  });

  test("a zero percentage is undefined, not Infinity", () => {
    expect(capStartsAboveMinor(15000, 0)).toBeNull();
  });

  test("a negative percentage cannot be derived either", () => {
    expect(capStartsAboveMinor(15000, -15)).toBeNull();
  });

  test("a zero maximum starts above nothing", () => {
    expect(capStartsAboveMinor(0, 15)).toBe(0);
  });
});

describe("displayStatus", () => {
  const now = new Date("2026-09-10T12:00:00Z");
  const yesterday = new Date("2026-09-09T12:00:00Z");
  const tomorrow = new Date("2026-09-11T12:00:00Z");

  test("paused is paused, whatever the dates say", () => {
    expect(
      displayStatus({ status: "paused", startsAt: yesterday, endsAt: null }, now),
    ).toBe("paused");
    expect(
      displayStatus(
        { status: "paused", startsAt: tomorrow, endsAt: null },
        now,
      ),
    ).toBe("paused");
    expect(
      displayStatus(
        { status: "paused", startsAt: yesterday, endsAt: yesterday },
        now,
      ),
    ).toBe("paused");
  });

  test("active but not started yet is scheduled", () => {
    expect(
      displayStatus({ status: "active", startsAt: tomorrow, endsAt: null }, now),
    ).toBe("scheduled");
  });

  test("active and running is active", () => {
    expect(
      displayStatus({ status: "active", startsAt: yesterday, endsAt: null }, now),
    ).toBe("active");
    expect(
      displayStatus(
        { status: "active", startsAt: yesterday, endsAt: tomorrow },
        now,
      ),
    ).toBe("active");
  });

  test("active and ended is expired", () => {
    expect(
      displayStatus(
        { status: "active", startsAt: yesterday, endsAt: yesterday },
        now,
      ),
    ).toBe("expired");
  });

  test("the boundaries: starting now is active, ending now is expired", () => {
    expect(
      displayStatus({ status: "active", startsAt: now, endsAt: null }, now),
    ).toBe("active");
    expect(
      displayStatus({ status: "active", startsAt: yesterday, endsAt: now }, now),
    ).toBe("expired");
  });

  test("a stale stored status is re-derived from the dates", () => {
    // Written as "scheduled" before it started; the clock has moved on.
    expect(
      displayStatus(
        { status: "scheduled", startsAt: yesterday, endsAt: null },
        now,
      ),
    ).toBe("active");
    // Written as "expired" but the merchant extended the end date.
    expect(
      displayStatus(
        { status: "expired", startsAt: yesterday, endsAt: tomorrow },
        now,
      ),
    ).toBe("active");
  });
});

describe("displayStatusLabel", () => {
  test("matches the mockup's pill labels", () => {
    expect(displayStatusLabel("active")).toBe("Active");
    expect(displayStatusLabel("scheduled")).toBe("Scheduled");
    expect(displayStatusLabel("paused")).toBe("Paused");
    expect(displayStatusLabel("expired")).toBe("Expired");
  });
});
