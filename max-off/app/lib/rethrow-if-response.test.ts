import { describe, expect, test, vi } from "vitest";

import { rethrowIfResponse } from "./rethrow-if-response";

/**
 * A read helper's fallback is for Shopify failing, not for the session
 * expiring.
 *
 * `admin.graphql` throws a `Response` when App Bridge has to re-authenticate.
 * A bare `catch {}` swallowed it, so an expired session showed "could not
 * reach Shopify" on a screen that could never recover. The fallback must still
 * apply to every ordinary error.
 */

const row = {
  id: "row_1",
  shop: "maxoff-s7fqtwdd.myshopify.com",
  discountGid: "gid://shopify/DiscountCodeNode/1",
};

vi.mock("../db.server", () => ({
  default: { cappedDiscount: { findFirst: vi.fn(async () => row) } },
}));

vi.mock("../models/plan.server", () => ({
  getPlanForGate: vi.fn(async () => "pro"),
}));

vi.mock("../models/settings.server", () => ({
  ensureShopSettings: vi.fn(async () => ({ rounding: "cent" })),
}));

const { isCodeTaken, readDiscountDetail } = await import("../models/discounts.server");

const throwing = (error: unknown) => ({
  graphql: async () => {
    throw error;
  },
});

const reauth = () => new Response(null, { status: 401 });

describe("rethrowIfResponse", () => {
  test("throws a Response", () => {
    const response = reauth();

    expect(() => rethrowIfResponse(response)).toThrow(expect.objectContaining({ status: 401 }));
  });

  test("lets anything else fall through", () => {
    expect(() => rethrowIfResponse(new Error("Throttled"))).not.toThrow();
  });
});

describe("readDiscountDetail", () => {
  test("rethrows a Response so the merchant re-authenticates", async () => {
    const response = reauth();

    await expect(
      readDiscountDetail({ shop: row.shop, id: row.id, admin: throwing(response) }),
    ).rejects.toBe(response);
  });

  test("still answers 'unreachable' for an ordinary error", async () => {
    const found = await readDiscountDetail({
      shop: row.shop,
      id: row.id,
      admin: throwing(new TypeError("fetch failed")),
    });

    expect(found).toMatchObject({ config: null, live: null, unreachable: true });
  });
});

describe("isCodeTaken", () => {
  test("rethrows a Response", async () => {
    const response = reauth();

    await expect(isCodeTaken(throwing(response), "SUMMER15")).rejects.toBe(response);
  });

  test("still answers null for an ordinary error", async () => {
    expect(await isCodeTaken(throwing(new Error("Throttled")), "SUMMER15")).toBeNull();
  });
});
