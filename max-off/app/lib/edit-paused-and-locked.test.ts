import { beforeEach, describe, expect, test, vi } from "vitest";

import { validateEdit } from "./discount-edit";
import type { EditFormState } from "./discount-edit";

/**
 * Two ways a save on the Edit screen used to change a discount the merchant
 * did not ask to change.
 *
 * 1. Shopify has no paused state. Pausing set the discount's endsAt to the
 *    moment of the pause, so an edit that sent a future endsAt made it live
 *    again while MaxOff still showed it paused. The end date of a paused
 *    discount now stays in MaxOff until Activate writes it back.
 * 2. A field the plan locks (a usage limit or custom wording kept from a
 *    higher plan) either blocked every save or was wiped by it. A locked field
 *    now means "unchanged".
 */

const baseRow = {
  id: "row_1",
  shop: "maxoff-s7fqtwdd.myshopify.com",
  discountGid: "gid://shopify/DiscountCodeNode/1",
  method: "code",
  code: "SUMMER15",
  title: null as string | null,
  status: "paused",
  checkoutNote: "Discount capped at maximum amount",
  usageLimit: 50 as number | null,
  startsAt: new Date("2026-09-01T00:00:00Z"),
  endsAt: new Date("2026-10-31T23:59:00Z") as Date | null,
};

let row = { ...baseRow };
const mirrorWrites: Record<string, unknown>[] = [];

vi.mock("../db.server", () => ({
  default: {
    cappedDiscount: {
      findFirst: vi.fn(async () => row),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        mirrorWrites.push(data);
        return { ...row, ...data };
      }),
    },
  },
}));

vi.mock("../models/plan.server", () => ({ getPlanForGate: vi.fn(async () => "pro") }));
vi.mock("../models/settings.server", () => ({
  ensureShopSettings: vi.fn(async () => ({ rounding: "cent" })),
}));

const { editCappedDiscount } = await import("../models/discounts.server");

function recordingAdmin() {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  return {
    calls,
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: options?.variables ?? {} });
      return {
        json: async () => ({
          data: {
            discountCodeAppUpdate: { userErrors: [] },
            discountAutomaticAppUpdate: { userErrors: [] },
          },
        }),
      };
    },
  };
}

const newEnd = new Date("2026-11-30T23:59:00Z");

beforeEach(() => {
  row = { ...baseRow };
  mirrorWrites.length = 0;
});

describe("editing a paused discount", () => {
  test("does not send the end date to Shopify, and keeps it in MaxOff", async () => {
    const admin = recordingAdmin();
    const result = await editCappedDiscount({
      shop: row.shop,
      id: row.id,
      endsAt: newEnd,
      usageLimit: 50,
      checkoutNote: row.checkoutNote,
      admin,
    });

    expect(result.ok).toBe(true);
    expect(admin.calls).toHaveLength(1);
    const sent = admin.calls[0].variables.discount as Record<string, unknown>;
    expect(sent).not.toHaveProperty("endsAt");
    expect(sent.usageLimit).toBe(50);
    expect(mirrorWrites.at(-1)?.endsAt).toEqual(newEnd);
  });

  test("an automatic one makes no Shopify call at all", async () => {
    row = { ...baseRow, method: "automatic", code: null as unknown as string };
    const admin = recordingAdmin();
    const result = await editCappedDiscount({
      shop: row.shop,
      id: row.id,
      endsAt: newEnd,
      usageLimit: null,
      checkoutNote: row.checkoutNote,
      admin,
    });

    expect(result.ok).toBe(true);
    expect(admin.calls).toHaveLength(0);
    expect(mirrorWrites.at(-1)?.endsAt).toEqual(newEnd);
  });

  test("an active one still sends the end date", async () => {
    row = { ...baseRow, status: "active" };
    const admin = recordingAdmin();
    await editCappedDiscount({
      shop: row.shop,
      id: row.id,
      endsAt: newEnd,
      usageLimit: 50,
      checkoutNote: row.checkoutNote,
      admin,
    });

    const sent = admin.calls[0].variables.discount as Record<string, unknown>;
    expect(sent.endsAt).toBe(newEnd.toISOString());
  });
});

describe("fields the plan locks", () => {
  const context = {
    startsAt: new Date("2026-09-01T00:00:00Z"),
    timesUsed: 3,
    method: "code" as const,
    // Free unlocks neither field: the downgrade case, a discount set up on
    // Growth and edited on Free.
    plan: "free",
    timeZone: "UTC",
    existing: { usageLimit: 50, checkoutNote: "Big-cart price, capped" },
  };

  const state = (over: Partial<EditFormState>): EditFormState => ({
    endDate: "2026-09-10",
    endTime: "23:59",
    usageLimit: "",
    checkoutNote: "",
    ...over,
  });

  test("keep their values when the disabled fields are not sent", () => {
    const result = validateEdit(state({}), context);

    expect(result).toMatchObject({
      ok: true,
      value: { usageLimit: 50, checkoutNote: "Big-cart price, capped" },
    });
  });

  test("keep their values when the browser sends them anyway", () => {
    const result = validateEdit(
      state({ usageLimit: "50", checkoutNote: "Big-cart price, capped" }),
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      value: { usageLimit: 50, checkoutNote: "Big-cart price, capped" },
    });
  });

  test("ignore a hand-posted change to a locked field", () => {
    const result = validateEdit(state({ usageLimit: "9999", checkoutNote: "Other" }), context);

    expect(result).toMatchObject({
      ok: true,
      value: { usageLimit: 50, checkoutNote: "Big-cart price, capped" },
    });
  });

  test("are still validated when the plan unlocks them", () => {
    const result = validateEdit(state({ usageLimit: "1" }), { ...context, plan: "pro" });

    // Below the 3 times already used.
    expect(result.ok).toBe(false);
  });
});
