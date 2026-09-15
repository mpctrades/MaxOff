import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Pausing must not throw away the merchant's end date.
 *
 * Shopify has no paused discount. `DiscountStatus` is `ACTIVE | EXPIRED |
 * SCHEDULED`, so "pause" is `discountCodeDeactivate`, which sets `endsAt` to
 * now — overwriting the date the merchant chose — and activating again sets
 * `endsAt` to null. Both are documented on the 2026-10 reference pages for
 * those mutations. Left alone, a campaign paused for a weekend comes back as
 * one that never ends.
 *
 * Our mirror is the only place that date survives the round trip, so
 * `setDiscountPaused` writes it back. These tests are the proof, because the
 * behaviour is invisible in the admin until a discount runs longer than it
 * should have.
 */

const discountRow = {
  id: "row_1",
  shop: "maxoff-s7fqtwdd.myshopify.com",
  discountGid: "gid://shopify/DiscountCodeNode/1",
  method: "code",
  code: "SUMMER15",
  title: null as string | null,
  startsAt: new Date("2026-09-01T00:00:00Z"),
  endsAt: null as Date | null,
  status: "active",
};

let row = { ...discountRow };
const updated = vi.fn();

vi.mock("../db.server", () => ({
  default: {
    cappedDiscount: {
      findFirst: vi.fn(async () => row),
      count: vi.fn(async () => 0),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updated(data);
        return { ...row, ...data };
      }),
    },
  },
}));

// The plan gate is not what these tests are about; unlimited keeps it quiet.
vi.mock("../models/plan.server", () => ({
  getPlanForGate: vi.fn(async () => "pro"),
}));

vi.mock("../models/settings.server", () => ({
  ensureShopSettings: vi.fn(async () => ({ rounding: "cent" })),
}));

const { setDiscountPaused } = await import("../models/discounts.server");

/** Records every mutation sent, and answers each with no userErrors. */
function recordingAdmin() {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];

  return {
    calls,
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: options?.variables ?? {} });
      return {
        json: async () => ({
          data: {
            discountCodeActivate: { userErrors: [] },
            discountCodeDeactivate: { userErrors: [] },
            discountCodeAppUpdate: { userErrors: [] },
          },
        }),
      };
    },
  };
}

const named = (
  calls: { query: string; variables: Record<string, unknown> }[],
  name: string,
) => calls.filter((call) => call.query.includes(name));

beforeEach(() => {
  row = { ...discountRow };
  updated.mockClear();
});

describe("activating a paused discount", () => {
  test("puts the merchant's end date back", async () => {
    row.status = "paused";
    row.endsAt = new Date("2099-09-30T23:59:00Z");

    const admin = recordingAdmin();
    const result = await setDiscountPaused({
      shop: row.shop,
      id: row.id,
      paused: false,
      admin,
    });

    expect(result.ok).toBe(true);

    const restore = named(admin.calls, "discountCodeAppUpdate");
    expect(restore).toHaveLength(1);
    expect(restore[0].variables.endsAt).toBe("2099-09-30T23:59:00.000Z");
  });

  test("sends no restore when the discount had no end date", async () => {
    row.status = "paused";
    row.endsAt = null;

    const admin = recordingAdmin();
    await setDiscountPaused({ shop: row.shop, id: row.id, paused: false, admin });

    // Nothing to put back, so nothing is sent — an empty restore would be a
    // write that could only fail.
    expect(named(admin.calls, "discountCodeAppUpdate")).toHaveLength(0);
  });

  test("refuses when the end date has already gone by, rather than making it endless", async () => {
    row.status = "paused";
    row.endsAt = new Date("2020-01-01T00:00:00Z");

    const admin = recordingAdmin();
    const result = await setDiscountPaused({
      shop: row.shop,
      id: row.id,
      paused: false,
      admin,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/end date has passed/i);

    // Nothing was sent to Shopify at all: the discount stays paused.
    expect(admin.calls).toHaveLength(0);
    expect(updated).not.toHaveBeenCalled();
  });
});

describe("pausing", () => {
  test("sends only the deactivate, and never a restore", async () => {
    row.status = "active";
    row.endsAt = new Date("2099-09-30T23:59:00Z");

    const admin = recordingAdmin();
    await setDiscountPaused({ shop: row.shop, id: row.id, paused: true, admin });

    expect(named(admin.calls, "discountCodeDeactivate")).toHaveLength(1);
    expect(named(admin.calls, "discountCodeAppUpdate")).toHaveLength(0);
  });

  test("leaves our copy of the end date alone, because it is the only copy left", async () => {
    row.status = "active";
    row.endsAt = new Date("2099-09-30T23:59:00Z");

    const admin = recordingAdmin();
    await setDiscountPaused({ shop: row.shop, id: row.id, paused: true, admin });

    expect(updated).toHaveBeenCalledTimes(1);
    expect(updated.mock.calls[0][0]).not.toHaveProperty("endsAt");
    expect(updated.mock.calls[0][0]).toMatchObject({ status: "paused" });
  });
});

describe("when Shopify accepts the activation but refuses the end date", () => {
  test("says the discount is now open-ended instead of reporting success", async () => {
    row.status = "paused";
    row.endsAt = new Date("2099-09-30T23:59:00Z");

    const admin = {
      graphql: async (query: string) => ({
        json: async () =>
          query.includes("discountCodeAppUpdate")
            ? {
                data: {
                  discountCodeAppUpdate: {
                    userErrors: [{ message: "End date is invalid" }],
                  },
                },
              }
            : { data: { discountCodeActivate: { userErrors: [] } } },
      }),
    };

    const result = await setDiscountPaused({
      shop: row.shop,
      id: row.id,
      paused: false,
      admin,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/runs until you stop it/i);

    // The mirror is corrected to match what Shopify actually holds: active,
    // with no end date. Leaving our old date there would be a lie the list
    // would keep repeating.
    expect(updated.mock.calls[0][0]).toMatchObject({ status: "active", endsAt: null });
  });
});
