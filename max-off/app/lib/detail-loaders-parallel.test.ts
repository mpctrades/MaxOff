import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The detail and edit screens read the discount and the plan side by side.
 *
 * Each Admin API call costs ~330 ms from the VPS. Read one after the other,
 * these two screens took ~670 ms on the server against ~340 ms for every other
 * screen. The plan does not depend on the discount, so the plan read must start
 * before the discount read has finished.
 */

const events: string[] = [];

const later = <T>(label: string, value: T) =>
  new Promise<T>((resolve) => {
    events.push(`${label}:start`);
    setTimeout(() => {
      events.push(`${label}:end`);
      resolve(value);
    }, 20);
  });

vi.mock("../shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ admin: {}, session: { shop: "s" } })) },
}));

vi.mock("../models/discounts.server", () => ({
  // A discount MaxOff does not know: the loaders answer 404, which needs no
  // cap config and still shows whether the two reads overlapped.
  readDiscountDetail: vi.fn(() => later("discount", null)),
  setDiscountPaused: vi.fn(),
  editCappedDiscount: vi.fn(),
}));

vi.mock("../models/settings.server", () => ({
  ensureShopSettings: vi.fn(async () => ({ timezone: "UTC" })),
}));

vi.mock("../models/plan.server", () => ({
  getPlanSummary: vi.fn(() => later("plan", { plan: "pro", activeLimit: null })),
}));

const detail = await import("../routes/app.discounts.$id");
const edit = await import("../routes/app.discounts.$id_.edit");

const args = {
  params: { id: "missing" },
  request: new Request("http://x/app/discounts/missing"),
  context: {},
} as unknown as Parameters<typeof detail.loader>[0];

beforeEach(() => {
  events.length = 0;
});

describe.each([
  ["detail", detail.loader],
  ["edit", edit.loader],
])("%s loader", (_name, loader) => {
  test("starts the plan read before the discount read finishes", async () => {
    await expect(loader(args)).rejects.toMatchObject({ status: 404 });

    expect(events.indexOf("plan:start")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("plan:start")).toBeLessThan(events.indexOf("discount:end"));
  });
});
