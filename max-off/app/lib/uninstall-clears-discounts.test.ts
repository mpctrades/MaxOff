import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Uninstalling removes MaxOff's own record of the shop's discounts.
 *
 * Shopify deletes an app's discounts on uninstall. The mirror used to keep
 * them, so a reinstall before `shop/redact` showed discounts that no longer
 * existed as active, and counted them against the plan's limit.
 */

const deleted = { sessions: [] as unknown[], discounts: [] as unknown[] };
let session: object | undefined;

vi.mock("../shopify.server", () => ({
  authenticate: {
    webhook: vi.fn(async () => ({
      shop: "maxoff-test.myshopify.com",
      session,
      topic: "APP_UNINSTALLED",
    })),
  },
}));

vi.mock("../db.server", () => ({
  default: {
    session: { deleteMany: vi.fn(async (args: unknown) => deleted.sessions.push(args)) },
    cappedDiscount: {
      deleteMany: vi.fn(async (args: unknown) => deleted.discounts.push(args)),
    },
  },
}));

vi.spyOn(console, "log").mockImplementation(() => {});

const { action } = await import("../routes/webhooks.app.uninstalled");

const call = () =>
  action({
    request: new Request("http://x/webhooks/app/uninstalled", { method: "POST" }),
    params: {},
    context: {},
  } as unknown as Parameters<typeof action>[0]);

beforeEach(() => {
  deleted.sessions.length = 0;
  deleted.discounts.length = 0;
});

describe("app/uninstalled", () => {
  test("deletes the shop's sessions and its capped-discount records", async () => {
    session = { id: "offline_maxoff-test.myshopify.com" };

    const response = await call();

    expect(response.status).toBe(200);
    expect(deleted.sessions).toEqual([{ where: { shop: "maxoff-test.myshopify.com" } }]);
    expect(deleted.discounts).toEqual([{ where: { shop: "maxoff-test.myshopify.com" } }]);
  });

  test("a retried webhook, with the session already gone, still clears the discounts", async () => {
    session = undefined;

    const response = await call();

    expect(response.status).toBe(200);
    expect(deleted.sessions).toEqual([]);
    expect(deleted.discounts).toEqual([{ where: { shop: "maxoff-test.myshopify.com" } }]);
  });
});
