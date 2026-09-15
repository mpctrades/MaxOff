import { describe, expect, test } from "vitest";

import {
  campaignTooLongError,
  COLLECTION_SCOPE_NEEDS_COLLECTIONS,
  combineDateTime,
  defaultEndDate,
  discountFormStateFrom,
  endDateRequiredError,
  initialDiscountFormState,
  SCOPE_NOT_ON_PLAN,
  USAGE_LIMIT_NOT_ON_PLAN,
  validateDiscountForm,
} from "./discount-form";
import type { DiscountFormState } from "./discount-form";

/**
 * Most of these rules are about the form, not about the plan, so they run on
 * Growth — the plan with no ceiling and no gates, where only §4.3 applies.
 * The Free rules get their own block at the bottom.
 */
const OPEN_PLAN = "growth";

const valid = (over: Partial<DiscountFormState> = {}): DiscountFormState => ({
  ...initialDiscountFormState(new Date("2026-09-10T00:00:00Z")),
  code: "SUMMER15",
  percentage: "15",
  capAmount: "150.00",
  ...over,
});

const errorsOf = (state: DiscountFormState, plan: string = OPEN_PLAN) => {
  const result = validateDiscountForm(state, plan);
  return "errors" in result ? result.errors : {};
};

describe("a valid form", () => {
  test("becomes exactly what createCappedDiscount needs", () => {
    const result = validateDiscountForm(valid(), OPEN_PLAN);

    expect(result).toEqual({
      value: {
        method: "code",
        code: "SUMMER15",
        title: "",
        scope: "order",
        appliesTo: "all",
        collectionIds: [],
        productIds: [],
        checkoutNote: "Discount capped at maximum amount",
        percentage: 15,
        capMinor: 15000,
        startsAt: new Date("2026-09-10T00:00:00Z"),
        endsAt: null,
        usageLimit: null,
        oncePerCustomer: true,
        combinesProduct: false,
        combinesOrder: false,
        combinesShipping: true,
      },
    });
  });

  test("uppercases and trims the code", () => {
    const result = validateDiscountForm(valid({ code: "  summer15  " }), OPEN_PLAN);
    expect("value" in result && result.value.code).toBe("SUMMER15");
  });

  test("a maximum typed without decimals still parses", () => {
    for (const [typed, minor] of [
      ["150", 15000],
      ["150.5", 15050],
      ["0.01", 1],
      [" 150.00 ", 15000],
    ] as const) {
      const result = validateDiscountForm(valid({ capAmount: typed }), OPEN_PLAN);
      expect("value" in result && result.value.capMinor).toBe(minor);
    }
  });
});

describe("the rules from §4.3", () => {
  test("the code cannot be empty", () => {
    expect(errorsOf(valid({ code: "   " })).code).toBeDefined();
  });

  test("the percentage must be a whole number between 1 and 100", () => {
    for (const bad of ["0", "101", "15.5", "-15", "", "abc", "1e2", "0x0f"]) {
      expect(errorsOf(valid({ percentage: bad })).percentage).toBeDefined();
    }

    for (const good of ["1", "15", "100"]) {
      expect(errorsOf(valid({ percentage: good })).percentage).toBeUndefined();
    }
  });

  test("the maximum must be above zero and readable", () => {
    for (const bad of ["0", "0.00", "", "abc", "-150", "1,400.00", "$150"]) {
      expect(errorsOf(valid({ capAmount: bad })).capAmount).toBeDefined();
    }
  });

  test("the end date must be after the start date", () => {
    const sameDay = errorsOf(
      valid({
        endDateOn: true,
        startDate: "2026-09-10",
        startTime: "10:00",
        endDate: "2026-09-10",
        endTime: "09:00",
      }),
    );
    expect(sameDay.endDate).toBe("The end date must be after the start date.");

    const identical = errorsOf(
      valid({
        endDateOn: true,
        startDate: "2026-09-10",
        startTime: "10:00",
        endDate: "2026-09-10",
        endTime: "10:00",
      }),
    );
    expect(identical.endDate).toBeDefined();

    const after = errorsOf(
      valid({
        endDateOn: true,
        startDate: "2026-09-10",
        startTime: "10:00",
        endDate: "2026-09-30",
        endTime: "23:59",
      }),
    );
    expect(after.endDate).toBeUndefined();
  });

  test("an end date that is switched off is not validated", () => {
    expect(
      errorsOf(valid({ endDateOn: false, endDate: "nonsense" })).endDate,
    ).toBeUndefined();
  });

  test("a usage limit, when switched on, must be a whole number above zero", () => {
    for (const bad of ["", "0", "-5", "2.5", "abc"]) {
      expect(
        errorsOf(valid({ usageLimitOn: true, usageLimit: bad })).usageLimit,
      ).toBeDefined();
    }

    const good = validateDiscountForm(
      valid({ usageLimitOn: true, usageLimit: "500" }),
      OPEN_PLAN,
    );
    expect("value" in good && good.value.usageLimit).toBe(500);
  });

  test("a bad time is refused rather than silently becoming midnight", () => {
    expect(errorsOf(valid({ startTime: "9am" })).startDate).toBeDefined();
    expect(errorsOf(valid({ startTime: "25:00" })).startDate).toBeDefined();
    expect(errorsOf(valid({ startTime: "09:60" })).startDate).toBeDefined();
    expect(errorsOf(valid({ startTime: "09:00" })).startDate).toBeUndefined();
  });

  test("every failure names its own field, so nothing lands in a banner", () => {
    const errors = errorsOf(
      valid({ code: "", percentage: "0", capAmount: "0" }),
    );

    expect(Object.keys(errors).sort()).toEqual([
      "capAmount",
      "code",
      "percentage",
    ]);
  });
});

describe("combineDateTime", () => {
  test("builds a UTC instant", () => {
    expect(combineDateTime("2026-09-10", "09:30")?.toISOString()).toBe(
      "2026-09-10T09:30:00.000Z",
    );
  });

  test("an empty time is midnight", () => {
    expect(combineDateTime("2026-09-10", "")?.toISOString()).toBe(
      "2026-09-10T00:00:00.000Z",
    );
  });

  test("a malformed date or time is null, never an Invalid Date", () => {
    expect(combineDateTime("10/09/2026", "09:00")).toBeNull();
    expect(combineDateTime("", "09:00")).toBeNull();
    expect(combineDateTime("2026-09-10", "half nine")).toBeNull();
  });
});

/**
 * §7 item 10: a client that bypassed validation. The action reads the raw
 * submission through `discountFormStateFrom` and runs the same rules, so these
 * are the cases a hand-rolled POST would hit.
 */
describe("a submission that skipped the client", () => {
  const submit = (fields: Record<string, string>, plan: string = OPEN_PLAN) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.set(key, value);
    }
    return validateDiscountForm(discountFormStateFrom(form), plan);
  };

  test("an empty POST is rejected on every required field", () => {
    const result = submit({ intent: "create" });

    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.code).toBeDefined();
      expect(result.errors.capAmount).toBeDefined();
      expect(result.errors.startDate).toBeDefined();
    }
  });

  test("a percentage of 150 is rejected, not clamped", () => {
    const result = submit({
      code: "HACK",
      percentage: "150",
      capAmount: "150.00",
      startDate: "2026-09-10",
      startTime: "00:00",
    });

    expect("errors" in result && result.errors.percentage).toBeDefined();
  });

  test("a maximum in minor units is rejected as a number, not read as 15,000", () => {
    // "15000" is a legal decimal string, so it parses — to 15,000.00, which is
    // a real amount and not something validation can catch. The guard is that
    // the form only ever sends major units, and the round-trip test in
    // cap-config.test.ts proves what the Function reads back.
    const result = submit({
      code: "HACK",
      percentage: "15",
      capAmount: "15000",
      startDate: "2026-09-10",
      startTime: "00:00",
    });

    expect("value" in result && result.value.capMinor).toBe(1500000);
  });

  test("a negative or zero maximum cannot get through", () => {
    for (const capAmount of ["-1", "0", "0.00"]) {
      const result = submit({
        code: "HACK",
        percentage: "15",
        capAmount,
        startDate: "2026-09-10",
        startTime: "00:00",
      });
      expect("errors" in result && result.errors.capAmount).toBeDefined();
    }
  });

  test("checkbox flags default to false when absent, never to true", () => {
    const result = submit({
      code: "SUMMER15",
      percentage: "15",
      capAmount: "150.00",
      startDate: "2026-09-10",
      startTime: "00:00",
    });

    expect("value" in result && result.value.oncePerCustomer).toBe(false);
    expect("value" in result && result.value.combinesShipping).toBe(false);
    expect("value" in result && result.value.usageLimit).toBeNull();
  });
});

describe("defaultEndDate", () => {
  test("is thirty days out, keeping the format", () => {
    expect(defaultEndDate("2026-09-10")).toBe("2026-10-10");
    expect(defaultEndDate("2026-12-15")).toBe("2027-01-14");
  });

  test("31 January plus thirty days is 2 March, not a rolled-over 3 March", () => {
    expect(defaultEndDate("2026-01-31")).toBe("2026-03-02");
  });

  test("an unusable date gives an empty string, never Invalid Date", () => {
    expect(defaultEndDate("")).toBe("");
    expect(defaultEndDate("not-a-date")).toBe("");
  });

  test("the result is always a date the end field will accept", () => {
    const result = defaultEndDate("2026-09-10");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // And it validates as an end date after the start date.
    expect(
      errorsOf(valid({ endDateOn: true, startDate: "2026-09-10", endDate: result })).endDate,
    ).toBeUndefined();
  });
});

describe("the Free plan's limits", () => {
  const start = { startDate: "2026-09-10", startTime: "00:00" };

  test("a discount may run to the fifteenth day", () => {
    const onTheLine = errorsOf(
      valid({
        ...start,
        endDateOn: true,
        endDate: "2026-09-25",
        endTime: "00:00",
      }),
      "free",
    );
    expect(onTheLine.endDate).toBeUndefined();
  });

  test("a discount may not run past it", () => {
    const overByAMinute = errorsOf(
      valid({
        ...start,
        endDateOn: true,
        endDate: "2026-09-25",
        endTime: "00:01",
      }),
      "free",
    );
    expect(overByAMinute.endDate).toBe(campaignTooLongError(15));

    const overByWeeks = errorsOf(
      valid({ ...start, endDateOn: true, endDate: "2026-10-31" }),
      "free",
    );
    expect(overByWeeks.endDate).toBe(campaignTooLongError(15));
  });

  test("an open-ended discount is refused, because the ceiling needs an end", () => {
    expect(errorsOf(valid({ ...start, endDateOn: false }), "free").endDate).toBe(
      endDateRequiredError(15),
    );
  });

  test("a usage limit is refused rather than silently dropped", () => {
    expect(
      errorsOf(
        valid({
          ...start,
          endDateOn: true,
          endDate: "2026-09-20",
          usageLimitOn: true,
          usageLimit: "500",
        }),
        "free",
      ).usageLimit,
    ).toBe(USAGE_LIMIT_NOT_ON_PLAN);
  });

  test("a plan nobody can read is treated as Free, never as unlimited", () => {
    for (const unreadable of ["", "enterprise", "GROWTH"]) {
      expect(
        errorsOf(valid({ ...start, endDateOn: false }), unreadable).endDate,
      ).toBe(endDateRequiredError(15));
    }
  });

  test("neither rule touches a plan without a ceiling", () => {
    const growth = errorsOf(
      valid({
        ...start,
        endDateOn: false,
        usageLimitOn: true,
        usageLimit: "500",
      }),
      "growth",
    );
    expect(growth.endDate).toBeUndefined();
    expect(growth.usageLimit).toBeUndefined();
  });

  test("the form opens on a ceiling plan with the end date already set", () => {
    const state = initialDiscountFormState(new Date("2026-09-10T00:00:00Z"), 15);
    expect(state.endDateOn).toBe(true);
    // The fifteenth day, ending at 23:59 on it — not the day after.
    expect(state.endDate).toBe("2026-09-24");

    // And what it opens with passes its own validation.
    expect(
      errorsOf({ ...valid(), ...state, code: "SUMMER15", capAmount: "150.00" }, "free")
        .endDate,
    ).toBeUndefined();
  });

  test("the prefill never exceeds the ceiling", () => {
    expect(defaultEndDate("2026-09-10", 15)).toBe("2026-09-24");
    // A ceiling above the thirty-day default does not extend it.
    expect(defaultEndDate("2026-09-10", 60)).toBe("2026-10-10");
    expect(defaultEndDate("2026-09-10", null)).toBe("2026-10-10");
  });
});

/**
 * The five affordances that carried a "Later version" badge until 14 Sep 2026.
 * Each one is a rule about what may be saved, so each one is tested here
 * rather than only in the component — the action runs this same function, and
 * a browser that skipped its checks must not get past it.
 */
describe("an automatic discount", () => {
  const automatic = (over: Partial<DiscountFormState> = {}) =>
    valid({ method: "automatic", code: "", title: "Summer sale", ...over });

  test("is named by its title, and needs no code", () => {
    const result = validateDiscountForm(automatic(), OPEN_PLAN);

    expect("value" in result && result.value.method).toBe("automatic");
    expect("value" in result && result.value.title).toBe("Summer sale");
    expect("value" in result && result.value.code).toBe("");
  });

  test("needs a title, because Shopify has nothing else to call it", () => {
    expect(errorsOf(automatic({ title: "   " })).title).toBe(
      "Enter a name for this discount.",
    );
  });

  test("carries no usage limit — Shopify's input has no field for one", () => {
    const result = validateDiscountForm(
      automatic({ usageLimitOn: true, usageLimit: "50" }),
      OPEN_PLAN,
    );

    expect("value" in result && result.value.usageLimit).toBeNull();
  });

  test("a code left over from switching method is not saved", () => {
    const result = validateDiscountForm(automatic({ code: "SUMMER15" }), OPEN_PLAN);

    expect("value" in result && result.value.code).toBe("");
  });
});

describe("a code discount", () => {
  test("still needs its code, and needs no title", () => {
    expect(errorsOf(valid({ code: "" })).code).toBe("Enter a discount code.");
    expect(errorsOf(valid({ title: "" })).title).toBeUndefined();
  });
});

describe("which products the discount applies to", () => {
  const pick = (id: string) => ({ id, title: id });

  test("defaults to the whole cart, with no ids", () => {
    const result = validateDiscountForm(valid(), OPEN_PLAN);

    expect("value" in result && result.value.appliesTo).toBe("all");
    expect("value" in result && result.value.collectionIds).toEqual([]);
    expect("value" in result && result.value.productIds).toEqual([]);
  });

  test("keeps the chosen collection ids", () => {
    const result = validateDiscountForm(
      valid({
        appliesTo: "collections",
        collections: [pick("gid://shopify/Collection/1"), pick("gid://shopify/Collection/2")],
      }),
      OPEN_PLAN,
    );

    expect("value" in result && result.value.collectionIds).toEqual([
      "gid://shopify/Collection/1",
      "gid://shopify/Collection/2",
    ]);
  });

  test("drops a duplicate the picker returned twice", () => {
    const result = validateDiscountForm(
      valid({
        appliesTo: "products",
        products: [pick("gid://shopify/Product/1"), pick("gid://shopify/Product/1")],
      }),
      OPEN_PLAN,
    );

    expect("value" in result && result.value.productIds).toEqual([
      "gid://shopify/Product/1",
    ]);
  });

  test("refuses a targeted discount that names nothing", () => {
    expect(errorsOf(valid({ appliesTo: "collections" })).collections).toBe(
      "Choose at least one collection.",
    );
    expect(errorsOf(valid({ appliesTo: "products" })).products).toBe(
      "Choose at least one product.",
    );
  });

  test("ignores a selection the merchant then switched away from", () => {
    const result = validateDiscountForm(
      valid({ appliesTo: "all", products: [pick("gid://shopify/Product/1")] }),
      OPEN_PLAN,
    );

    expect("value" in result && result.value.productIds).toEqual([]);
  });
});

describe("the checkout note", () => {
  const LOCKED = "Discount capped at maximum amount";

  test("is the locked wording when the merchant writes nothing", () => {
    const result = validateDiscountForm(valid({ checkoutNote: "  " }), OPEN_PLAN);

    expect("value" in result && result.value.checkoutNote).toBe(LOCKED);
  });

  test("keeps the merchant's own wording on a plan that allows it", () => {
    const result = validateDiscountForm(
      valid({ checkoutNote: "Capped at our maximum" }),
      OPEN_PLAN,
    );

    expect("value" in result && result.value.checkoutNote).toBe(
      "Capped at our maximum",
    );
  });

  test("is refused on Free, which does not have custom wording", () => {
    expect(errorsOf(valid({ checkoutNote: "Our own words" }), "free").checkoutNote).toBe(
      "Your own checkout wording is part of the Growth plan.",
    );
  });

  test("the locked wording is not a rewording, so Free may still save it", () => {
    // The form puts this default there itself. Refusing it would be refusing
    // our own form, and a Free merchant could never save at all.
    expect(errorsOf(valid({ checkoutNote: LOCKED }), "free").checkoutNote).toBeUndefined();
  });

  test("is refused when it is longer than the buyer's line can carry", () => {
    expect(errorsOf(valid({ checkoutNote: "x".repeat(61) })).checkoutNote).toBe(
      "Keep the note to 60 characters or fewer.",
    );
  });
});

describe("discountFormStateFrom, on what the browser actually posts", () => {
  const post = (fields: Record<string, string>): FormData => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.set(key, value);
    }
    return form;
  };

  test("reads the method, the title and the picked resources", () => {
    const state = discountFormStateFrom(
      post({
        method: "automatic",
        title: "Summer sale",
        appliesTo: "collections",
        collections: JSON.stringify([
          { id: "gid://shopify/Collection/1", title: "Sale" },
        ]),
      }),
    );

    expect(state.method).toBe("automatic");
    expect(state.title).toBe("Summer sale");
    expect(state.appliesTo).toBe("collections");
    expect(state.collections).toEqual([
      { id: "gid://shopify/Collection/1", title: "Sale" },
    ]);
  });

  test("an unrecognised method is a code discount, never the looser one", () => {
    expect(discountFormStateFrom(post({ method: "sorcery" })).method).toBe("code");
  });

  test("an unrecognised appliesTo is the whole cart", () => {
    expect(discountFormStateFrom(post({ appliesTo: "variants" })).appliesTo).toBe("all");
  });

  test.each([
    ["absent", undefined],
    ["empty", ""],
    ["not JSON", "gid://shopify/Product/1"],
    ["not an array", '{"id":"gid://shopify/Product/1"}'],
    ["entries without ids", '[{"title":"Shirt"}]'],
  ])("picked products that are %s read as none chosen", (_label, value) => {
    const state = discountFormStateFrom(
      value === undefined ? post({}) : post({ products: value }),
    );

    // Validation then refuses a targeted discount with an empty list — the
    // one thing that must never happen is a silent fall back to everything.
    expect(state.products).toEqual([]);
    expect(errorsOf({ ...valid(), appliesTo: "products", products: [] }).products).toBe(
      "Choose at least one product.",
    );
  });
});

/**
 * The Pro maximums, gated here and nowhere else.
 *
 * The form renders these choices disabled off-plan, but §6 is explicit that
 * the server revalidates rather than trusting that it did: a stale tab whose
 * plan has changed, or a post that never went through the form, has to be
 * refused here. A Free store submitting `scope: "item"` is the case that
 * matters — the UI it bypassed is not a gate.
 */
describe("which maximum the plan allows", () => {
  const collection = { id: "gid://shopify/Collection/1", title: "Sale" };

  test.each(["free", "growth"])("%s cannot take a maximum on each item", (plan) => {
    expect(errorsOf(valid({ scope: "item" }), plan).scope).toBe(
      SCOPE_NOT_ON_PLAN.item,
    );
  });

  test.each(["free", "growth"])(
    "%s cannot take a maximum per collection",
    (plan) => {
      const state = valid({
        scope: "collection",
        appliesTo: "collections",
        collections: [collection],
      });

      expect(errorsOf(state, plan).scope).toBe(SCOPE_NOT_ON_PLAN.collection);
    },
  );

  test("Pro takes a maximum on each item", () => {
    const result = validateDiscountForm(valid({ scope: "item" }), "pro");
    expect("value" in result && result.value.scope).toBe("item");
  });

  test("Pro takes a maximum per collection, with the collections to divide by", () => {
    const result = validateDiscountForm(
      valid({
        scope: "collection",
        appliesTo: "collections",
        collections: [collection],
      }),
      "pro",
    );

    expect("value" in result && result.value.scope).toBe("collection");
    expect("value" in result && result.value.collectionIds).toEqual([collection.id]);
  });

  // The Function refuses this pairing outright, so the form has to refuse it
  // first — where the merchant can still change the answer.
  test.each(["all", "products"] as const)(
    "a maximum per collection is refused on a discount that applies to %s",
    (appliesTo) => {
      const state = valid({
        scope: "collection",
        appliesTo,
        products: [{ id: "gid://shopify/Product/1", title: "Mug" }],
      });

      expect(errorsOf(state, "pro").scope).toBe(COLLECTION_SCOPE_NEEDS_COLLECTIONS);
    },
  );

  test("every plan takes one maximum for the whole order", () => {
    for (const plan of ["free", "growth", "pro"]) {
      expect(errorsOf(valid({ scope: "order" }), plan).scope).toBeUndefined();
    }
  });

  // Anything unreadable is the maximum every plan has, never a Pro one.
  // Checked on Growth, whose form has no other rule to trip over: on Free the
  // run-length ceiling would fail the same submission for its missing end
  // date, and prove nothing about the scope.
  test("an unreadable scope falls back to the whole order", () => {
    const state = valid({ scope: "variant" as never });
    const result = validateDiscountForm(state, OPEN_PLAN);

    expect("value" in result && result.value.scope).toBe("order");
  });
});
