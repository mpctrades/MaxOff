import { describe, expect, test } from "vitest";

import {
  USAGE_LIMIT_BELOW_USED,
  USAGE_LIMIT_INVALID,
  validateEdit,
} from "./discount-edit";
import type { EditFormContext, EditFormState } from "./discount-edit";
import { DEFAULT_CHECKOUT_NOTE, CHECKOUT_NOTE_MAX_LENGTH } from "./cap-config";
import { PLAN_MAX_CAMPAIGN_DAYS } from "./plans";

const blank: EditFormState = {
  endDate: "",
  endTime: "",
  usageLimit: "",
  checkoutNote: "",
};

const proContext: EditFormContext = {
  startsAt: new Date("2026-09-01T00:00:00Z"),
  timesUsed: 0,
  method: "code",
  plan: "pro",
  timeZone: "UTC",
};

const form = (over: Partial<EditFormState> = {}): EditFormState => ({ ...blank, ...over });
const ctx = (over: Partial<EditFormContext> = {}): EditFormContext => ({
  ...proContext,
  ...over,
});

describe("validateEdit — the end date", () => {
  test("an end date after the start is accepted", () => {
    const result = validateEdit(form({ endDate: "2026-09-30", endTime: "23:59" }), ctx());

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.endsAt?.toISOString()).toBe(
      "2026-09-30T23:59:00.000Z",
    );
  });

  test("an end date on or before the start is refused", () => {
    const result = validateEdit(form({ endDate: "2026-08-31" }), ctx());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.endDate).toMatch(/after the start/i);
  });

  test("a blank end date is fine on a plan with no campaign limit", () => {
    const result = validateEdit(form(), ctx({ plan: "pro" }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.endsAt).toBeNull();
  });

  test("a blank end date is refused on Free, which has a campaign limit", () => {
    // Free is a fortnight-long trial in disguise; an open-ended discount would
    // walk straight around it.
    expect(PLAN_MAX_CAMPAIGN_DAYS.free).not.toBeNull();

    const result = validateEdit(form(), ctx({ plan: "free" }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.endDate).toMatch(/needs an end date/i);
  });

  test("Free cannot be extended past its campaign limit by editing", () => {
    // The point of checking the plan here as well as on create: a discount
    // made on Growth and then downgraded must not be extendable.
    const result = validateEdit(
      form({ endDate: "2026-10-31" }),
      ctx({ plan: "free" }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.endDate).toMatch(/up to 15 days/i);
  });

  test("Free is fine inside its campaign limit", () => {
    const result = validateEdit(form({ endDate: "2026-09-10" }), ctx({ plan: "free" }));
    expect(result.ok).toBe(true);
  });

  test("a date that does not exist is refused rather than rolled over", () => {
    const result = validateEdit(form({ endDate: "2026-02-31" }), ctx());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.endDate).toBeDefined();
  });
});

describe("validateEdit — the usage limit", () => {
  test("a whole number is accepted", () => {
    const result = validateEdit(
      form({ endDate: "2026-09-30", usageLimit: "500" }),
      ctx(),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.usageLimit).toBe(500);
  });

  test("blank means no limit", () => {
    const result = validateEdit(form({ endDate: "2026-09-30" }), ctx());
    expect(result.ok && result.value.usageLimit).toBeNull();
  });

  test.each(["nope", "12.5", "-4", "0"])("%o is refused", (value) => {
    const result = validateEdit(
      form({ endDate: "2026-09-30", usageLimit: value }),
      ctx(),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.usageLimit).toBe(USAGE_LIMIT_INVALID);
  });

  test("a limit below what has already been used is refused", () => {
    // Shopify would take it, and the discount would stop working with no
    // explanation the merchant could find.
    const result = validateEdit(
      form({ endDate: "2026-09-30", usageLimit: "10" }),
      ctx({ timesUsed: 42 }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.usageLimit).toBe(USAGE_LIMIT_BELOW_USED);
  });

  test("a limit equal to what has been used is allowed — it simply stops here", () => {
    const result = validateEdit(
      form({ endDate: "2026-09-30", usageLimit: "42" }),
      ctx({ timesUsed: 42 }),
    );

    expect(result.ok).toBe(true);
  });

  test("an automatic discount cannot take one at all", () => {
    // `usageLimit` is not a field on DiscountAutomaticAppInput; the 2026-10
    // schema rejects it outright. The form hides it, and this refuses a
    // hand-posted one.
    const result = validateEdit(
      form({ endDate: "2026-09-30", usageLimit: "500" }),
      ctx({ method: "automatic" }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.usageLimit).toMatch(/do not take a limit/i);
  });

  test("is a Growth entitlement, refused on Free", () => {
    const result = validateEdit(
      form({ endDate: "2026-09-10", usageLimit: "500" }),
      ctx({ plan: "free" }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.usageLimit).toMatch(/Growth plan/i);
  });
});

describe("validateEdit — the checkout note", () => {
  test("blank falls back to the locked default wording", () => {
    const result = validateEdit(form({ endDate: "2026-09-30" }), ctx());
    expect(result.ok && result.value.checkoutNote).toBe(DEFAULT_CHECKOUT_NOTE);
  });

  test("a merchant's own wording is kept", () => {
    const result = validateEdit(
      form({ endDate: "2026-09-30", checkoutNote: "Maximum reached" }),
      ctx(),
    );

    expect(result.ok && result.value.checkoutNote).toBe("Maximum reached");
  });

  test("too long is refused rather than silently truncated", () => {
    const result = validateEdit(
      form({ endDate: "2026-09-30", checkoutNote: "x".repeat(CHECKOUT_NOTE_MAX_LENGTH + 1) }),
      ctx(),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.checkoutNote).toMatch(/or fewer/i);
  });

  test("is a Growth entitlement, refused on Free", () => {
    const result = validateEdit(
      form({ endDate: "2026-09-10", checkoutNote: "Maximum reached" }),
      ctx({ plan: "free" }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.checkoutNote).toMatch(/Growth plan/i);
  });
});

describe("validateEdit — what it cannot reach", () => {
  test("the value it returns carries only the three safe fields", () => {
    // The guarantee this whole screen rests on: nothing here can change what a
    // cart already in checkout is charged. If a percentage or a maximum ever
    // appears in this object, that guarantee is gone.
    const result = validateEdit(form({ endDate: "2026-09-30" }), ctx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.value).sort()).toEqual([
      "checkoutNote",
      "endsAt",
      "usageLimit",
    ]);
  });
});
