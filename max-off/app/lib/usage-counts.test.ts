import { describe, expect, test, vi } from "vitest";

/**
 * "Used" is Shopify's own count, read once for the whole list.
 *
 * The column used to show our `timesUsed` column, which only the orders
 * webhook moves, and that needs read_orders — so every discount said 0 however
 * often buyers had used it. A number we do not know must read as unknown.
 */

vi.mock("../db.server", () => ({ default: {} }));
vi.mock("../models/plan.server", () => ({ getPlanForGate: vi.fn() }));
vi.mock("../models/settings.server", () => ({ ensureShopSettings: vi.fn() }));
vi.spyOn(console, "error").mockImplementation(() => {});

const { withUsageCounts } = await import("../models/discounts.server");

const rows = [
  { id: "a", discountGid: "gid://shopify/DiscountCodeNode/1" },
  { id: "b", discountGid: "gid://shopify/DiscountAutomaticNode/2" },
  { id: "c", discountGid: "gid://shopify/DiscountCodeNode/3" },
];

describe("withUsageCounts", () => {
  test("asks Shopify once for every row, and uses its counts", async () => {
    const calls: unknown[] = [];
    const admin = {
      graphql: async (_query: string, options?: { variables?: Record<string, unknown> }) => {
        calls.push(options?.variables);
        return {
          json: async () => ({
            data: {
              nodes: [
                { id: rows[0].discountGid, codeDiscount: { asyncUsageCount: 12 } },
                { id: rows[1].discountGid, automaticDiscount: { asyncUsageCount: 0 } },
                null, // deleted in Shopify
              ],
            },
          }),
        };
      },
    };

    const result = await withUsageCounts(admin, rows);

    expect(calls).toEqual([{ ids: rows.map((row) => row.discountGid) }]);
    expect(result.map((row) => row.timesUsed)).toEqual([12, 0, null]);
  });

  test("a failed read is unknown, never 0", async () => {
    const admin = {
      graphql: async () => {
        throw new Error("Throttled");
      },
    };

    const result = await withUsageCounts(admin, rows);

    expect(result.map((row) => row.timesUsed)).toEqual([null, null, null]);
  });

  test("re-authentication still gets through", async () => {
    const reauth = new Response(null, { status: 401 });
    const admin = {
      graphql: async () => {
        throw reauth;
      },
    };

    await expect(withUsageCounts(admin, rows)).rejects.toBe(reauth);
  });

  test("no rows, no call", async () => {
    const graphql = vi.fn();

    expect(await withUsageCounts({ graphql }, [])).toEqual([]);
    expect(graphql).not.toHaveBeenCalled();
  });
});
