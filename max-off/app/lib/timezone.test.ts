import { describe, expect, test } from "vitest";

import {
  DEFAULT_TIME_ZONE,
  formatDateInZone,
  isoDateInZone,
  isValidTimeZone,
  startOfMonthInZone,
  startOfWeekInZone,
  timeInZone,
  toTimeZone,
  zonedParts,
  zonedTimeToUtc,
} from "./timezone";

/** The shop this app was built for, and the one in the transparency panel. */
const PHNOM_PENH = "Asia/Phnom_Penh"; // UTC+7, no DST — ever.

/** A zone that does change, so the two-pass offset is actually exercised. */
const NEW_YORK = "America/New_York"; // UTC-5, UTC-4 in summer.

describe("reading a zone we can trust", () => {
  test("a real IANA name is usable", () => {
    expect(isValidTimeZone(PHNOM_PENH)).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  test.each([["", "empty"], ["Mars/Olympus", "not a zone"]])(
    "%s is refused (%s)",
    (value) => {
      expect(isValidTimeZone(value)).toBe(false);
    },
  );

  test.each([null, undefined, 7, {}])("%j is refused", (value) => {
    expect(isValidTimeZone(value)).toBe(false);
  });

  /**
   * The fallback is UTC and never the server's own zone. A VPS that moves
   * region would otherwise silently move every merchant's dates with it.
   */
  test("anything unreadable falls back to UTC", () => {
    expect(toTimeZone("Mars/Olympus")).toBe(DEFAULT_TIME_ZONE);
    expect(toTimeZone(null)).toBe(DEFAULT_TIME_ZONE);
    expect(toTimeZone(PHNOM_PENH)).toBe(PHNOM_PENH);
  });
});

describe("what the shop's clock reads", () => {
  test("Phnom Penh is seven hours ahead of UTC", () => {
    // 2026-09-10T00:00Z is 07:00 the same day in Phnom Penh.
    expect(zonedParts(new Date("2026-09-10T00:00:00Z"), PHNOM_PENH)).toEqual({
      year: 2026,
      month: 9,
      day: 10,
      hour: 7,
      minute: 0,
    });
  });

  /** The bug this module exists to fix, stated as a date rollover. */
  test("late UTC evening is already tomorrow in Phnom Penh", () => {
    const instant = new Date("2026-09-10T18:30:00Z");

    expect(formatDateInZone(instant, PHNOM_PENH)).toBe("11 Sep 2026");
    expect(formatDateInZone(instant, "UTC")).toBe("10 Sep 2026");
  });

  test("midnight reads as hour zero, not twenty-four", () => {
    const midnight = new Date("2026-09-09T17:00:00Z"); // 00:00 on the 10th, ICT
    expect(zonedParts(midnight, PHNOM_PENH).hour).toBe(0);
    expect(timeInZone(midnight, PHNOM_PENH)).toBe("00:00");
  });

  test("the ISO date is the shop's own calendar day", () => {
    expect(isoDateInZone(new Date("2026-09-10T18:30:00Z"), PHNOM_PENH)).toBe(
      "2026-09-11",
    );
  });
});

describe("turning what the merchant typed into an instant", () => {
  /**
   * The heart of it. A merchant in Phnom Penh who sets a discount to start on
   * 10 Sep at 00:00 means *their* midnight, which is 17:00 UTC the day before.
   * Reading it as 00:00 UTC started the discount seven hours late.
   */
  test("midnight in Phnom Penh is 17:00 UTC the day before", () => {
    const at = zonedTimeToUtc(
      { year: 2026, month: 9, day: 10, hour: 0, minute: 0 },
      PHNOM_PENH,
    );

    expect(at.toISOString()).toBe("2026-09-09T17:00:00.000Z");
  });

  test("the last minute of an end date is the shop's, not UTC's", () => {
    const at = zonedTimeToUtc(
      { year: 2026, month: 9, day: 30, hour: 23, minute: 59 },
      PHNOM_PENH,
    );

    expect(at.toISOString()).toBe("2026-09-30T16:59:00.000Z");
  });

  test("UTC is its own inverse", () => {
    const at = zonedTimeToUtc(
      { year: 2026, month: 9, day: 10, hour: 9, minute: 30 },
      "UTC",
    );

    expect(at.toISOString()).toBe("2026-09-10T09:30:00.000Z");
  });

  test("a round trip through the zone returns what was typed", () => {
    const typed = { year: 2026, month: 3, day: 1, hour: 14, minute: 45 };
    expect(zonedParts(zonedTimeToUtc(typed, PHNOM_PENH), PHNOM_PENH)).toEqual(
      typed,
    );
  });

  /**
   * The reason `zonedTimeToUtc` takes two passes. New York is UTC-4 in
   * August and UTC-5 in December; a single-pass conversion using the offset
   * at the naive UTC reading is an hour out on one side of the year.
   */
  test("a zone with daylight saving is right on both sides of the year", () => {
    const summer = zonedTimeToUtc(
      { year: 2026, month: 8, day: 1, hour: 12, minute: 0 },
      NEW_YORK,
    );
    const winter = zonedTimeToUtc(
      { year: 2026, month: 12, day: 1, hour: 12, minute: 0 },
      NEW_YORK,
    );

    expect(summer.toISOString()).toBe("2026-08-01T16:00:00.000Z"); // UTC-4
    expect(winter.toISOString()).toBe("2026-12-01T17:00:00.000Z"); // UTC-5

    // And both still read back as the noon the merchant typed.
    expect(zonedParts(summer, NEW_YORK).hour).toBe(12);
    expect(zonedParts(winter, NEW_YORK).hour).toBe(12);
  });
});

describe("month and week boundaries, for Home's totals", () => {
  test("the month starts at the shop's midnight, not UTC's", () => {
    const inSeptember = new Date("2026-09-15T03:00:00Z");

    expect(startOfMonthInZone(inSeptember, PHNOM_PENH).toISOString()).toBe(
      "2026-08-31T17:00:00.000Z",
    );
    expect(startOfMonthInZone(inSeptember, "UTC").toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  test("an offset of minus one is the month before", () => {
    const inSeptember = new Date("2026-09-15T03:00:00Z");

    expect(startOfMonthInZone(inSeptember, PHNOM_PENH, -1).toISOString()).toBe(
      "2026-07-31T17:00:00.000Z",
    );
  });

  test("January minus one rolls back into the previous year", () => {
    const inJanuary = new Date("2026-01-15T03:00:00Z");

    expect(startOfMonthInZone(inJanuary, "UTC", -1).toISOString()).toBe(
      "2025-12-01T00:00:00.000Z",
    );
  });

  /**
   * An instant that is still the previous month in UTC but already the new one
   * in Phnom Penh. The boundary has to follow the shop, or a sale made on the
   * shop's 1 September lands in August's total.
   */
  test("a sale just after the shop's month rollover counts in the new month", () => {
    const justAfterLocalMidnight = new Date("2026-08-31T17:30:00Z");

    expect(
      startOfMonthInZone(justAfterLocalMidnight, PHNOM_PENH).toISOString(),
    ).toBe("2026-08-31T17:00:00.000Z");
  });

  test("the week starts on Monday, at the shop's midnight", () => {
    // 2026-09-15 is a Tuesday; its Monday is the 14th.
    const tuesday = new Date("2026-09-15T03:00:00Z");

    expect(startOfWeekInZone(tuesday, PHNOM_PENH).toISOString()).toBe(
      "2026-09-13T17:00:00.000Z", // 14 Sep 00:00 ICT
    );
  });

  test("Sunday belongs to the week that began the Monday before", () => {
    // 2026-09-20 is a Sunday; its Monday is the 14th.
    const sunday = new Date("2026-09-20T10:00:00Z");

    expect(startOfWeekInZone(sunday, "UTC").toISOString()).toBe(
      "2026-09-14T00:00:00.000Z",
    );
  });

  test("an offset of minus one is the week before", () => {
    const tuesday = new Date("2026-09-15T03:00:00Z");

    expect(startOfWeekInZone(tuesday, "UTC", -1).toISOString()).toBe(
      "2026-09-07T00:00:00.000Z",
    );
  });
});
