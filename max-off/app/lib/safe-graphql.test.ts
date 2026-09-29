import { describe, expect, test, vi } from "vitest";

/**
 * A failed Admin API write is a toast, never a 500.
 *
 * `@shopify/shopify-api` throws `GraphqlQueryError` on top-level GraphQL
 * errors and `fetch` throws on a network failure. `safeGraphql` turns either
 * into an `errors` body, so the write helpers' existing checks answer with
 * `{ ok: false, message }`. A thrown `Response` is App Bridge asking to
 * re-authenticate and must still reach React Router.
 */

const row = {
  id: "row_1",
  shop: "maxoff-s7fqtwdd.myshopify.com",
  discountGid: "gid://shopify/DiscountCodeNode/1",
  method: "code",
  code: "SUMMER15",
  title: null,
  startsAt: new Date("2026-09-01T00:00:00Z"),
  endsAt: null,
  status: "active",
};

vi.mock("../db.server", () => ({
  default: {
    cappedDiscount: {
      findFirst: vi.fn(async () => row),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => row),
    },
  },
}));

vi.mock("../models/plan.server", () => ({
  getPlanForGate: vi.fn(async () => "pro"),
}));

vi.mock("../models/settings.server", () => ({
  ensureShopSettings: vi.fn(async () => ({ rounding: "cent" })),
}));

vi.spyOn(console, "error").mockImplementation(() => {});

const { safeGraphql, setDiscountPaused } = await import("../models/discounts.server");

const throwing = (error: unknown) => ({
  graphql: async () => {
    throw error;
  },
});

describe("safeGraphql", () => {
  test("turns a thrown GraphQL error into an errors body", async () => {
    const response = await safeGraphql(throwing(new Error("Throttled")), "mutation { x }");
    const body = (await response.json()) as { errors: { message: string }[] };

    expect(body.errors[0].message).toMatch(/try again/);
  });

  test("passes a successful body through unchanged", async () => {
    const admin = { graphql: async () => ({ json: async () => ({ data: { ok: 1 } }) }) };
    const response = await safeGraphql(admin, "query { x }");

    expect(await response.json()).toEqual({ data: { ok: 1 } });
  });

  test("rethrows a Response, which is App Bridge re-authenticating", async () => {
    const reauth = new Response(null, { status: 401 });

    await expect(safeGraphql(throwing(reauth), "query { x }")).rejects.toBe(reauth);
  });
});

describe("pausing when Shopify throws", () => {
  test("answers ok: false with a message instead of throwing", async () => {
    const result = await setDiscountPaused({
      shop: row.shop,
      id: row.id,
      paused: true,
      admin: throwing(new TypeError("fetch failed")),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/try again/);
  });
});
