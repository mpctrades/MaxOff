import { beforeEach, describe, expect, test, vi } from "vitest";

import type { CappedDiscountFacts, OrderPayload } from "./order-cap-event";

import capped from "./fixtures/orders-paid-capped.json";

/**
 * Idempotency, which is the whole reason this handler is worth testing.
 *
 * Shopify retries a webhook delivery it did not get a 200 for, and can deliver
 * the same order more than once regardless. A second `CapEvent` for one order
 * would double "Money you kept" on Home, and nothing would ever correct it —
 * there is no reconciliation pass, and a merchant has no way to tell the
 * figure is wrong. So the unique constraint on `orderGid` is load-bearing, and
 * both the check and the constraint are exercised here.
 *
 * The Prisma client is faked rather than a real database: this is about
 * control flow under a race, and a real Postgres would make the concurrent
 * case hard to stage and the suite slow.
 */

const rows: { orderGid: string }[] = [];
const created = vi.fn();
const discountUpdated = vi.fn();

/** Set to throw Prisma's unique-violation code on the next create. */
let raceOnNextCreate = false;

vi.mock("../db.server", () => ({
  default: {
    capEvent: {
      findUnique: vi.fn(async ({ where }: { where: { orderGid: string } }) => {
        return rows.find((row) => row.orderGid === where.orderGid) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: { orderGid: string } }) => {
        if (raceOnNextCreate) {
          raceOnNextCreate = false;
          throw Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          });
        }
        rows.push({ orderGid: data.orderGid });
        created(data);
        return data;
      }),
    },
    cappedDiscount: {
      update: vi.fn(async (args: unknown) => {
        discountUpdated(args);
        return {};
      }),
    },
  },
}));

// Imported after the mock is registered, so the module picks up the fake.
const { recordCapEvent, orderEventsEnabled } = await import(
  "../models/order-events.server"
);

const SUMMER15: CappedDiscountFacts = {
  id: "discount_summer",
  code: "SUMMER15",
  title: "Summer sale",
  percentage: 15,
  capMinor: 15_000,
  rounding: "cent",
};

const shop = "maxoff-s7fqtwdd.myshopify.com";

beforeEach(() => {
  rows.length = 0;
  created.mockClear();
  discountUpdated.mockClear();
  raceOnNextCreate = false;
});

describe("recordCapEvent — one order, one row", () => {
  test("the first delivery writes the event", async () => {
    const result = await recordCapEvent({
      shop,
      order: capped as OrderPayload,
      discounts: [SUMMER15],
    });

    expect(result).toBe("written");
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][0]).toMatchObject({
      shop,
      cappedDiscountId: "discount_summer",
      orderGid: "gid://shopify/Order/5123456789012",
      orderName: "#1042",
      keptMinor: 6_000,
      givenMinor: 15_000,
    });
  });

  test("a redelivery of the same order writes nothing", async () => {
    await recordCapEvent({ shop, order: capped as OrderPayload, discounts: [SUMMER15] });
    const second = await recordCapEvent({
      shop,
      order: capped as OrderPayload,
      discounts: [SUMMER15],
    });

    expect(second).toBe("duplicate");
    expect(created).toHaveBeenCalledTimes(1);
  });

  test("five redeliveries still write one row", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await recordCapEvent({
        shop,
        order: capped as OrderPayload,
        discounts: [SUMMER15],
      });
    }

    expect(rows).toHaveLength(1);
    expect(created).toHaveBeenCalledTimes(1);
  });

  test("the discount's running totals move exactly once", async () => {
    await recordCapEvent({ shop, order: capped as OrderPayload, discounts: [SUMMER15] });
    await recordCapEvent({ shop, order: capped as OrderPayload, discounts: [SUMMER15] });

    expect(discountUpdated).toHaveBeenCalledTimes(1);
    expect(discountUpdated.mock.calls[0][0]).toMatchObject({
      where: { id: "discount_summer" },
      data: {
        timesUsed: { increment: 1 },
        keptMinor: { increment: 6_000 },
        givenMinor: { increment: 15_000 },
      },
    });
  });
});

describe("recordCapEvent — two deliveries at once", () => {
  test("the loser of the race is a duplicate, not a crash", async () => {
    // Both passed the existence check before either wrote; the database
    // constraint is what actually decides.
    raceOnNextCreate = true;

    const result = await recordCapEvent({
      shop,
      order: capped as OrderPayload,
      discounts: [SUMMER15],
    });

    expect(result).toBe("duplicate");
    expect(discountUpdated).not.toHaveBeenCalled();
  });

  test("an error that is not a unique violation is not swallowed", async () => {
    const { default: db } = (await import("../db.server")) as unknown as {
      default: { capEvent: { create: ReturnType<typeof vi.fn> } };
    };

    db.capEvent.create.mockRejectedValueOnce(
      Object.assign(new Error("connection lost"), { code: "P1001" }),
    );

    await expect(
      recordCapEvent({ shop, order: capped as OrderPayload, discounts: [SUMMER15] }),
    ).rejects.toThrow("connection lost");
  });
});

describe("recordCapEvent — orders that are not ours", () => {
  test("writes nothing and says so", async () => {
    const result = await recordCapEvent({
      shop,
      order: { admin_graphql_api_id: "gid://shopify/Order/7", name: "#7" },
      discounts: [SUMMER15],
    });

    expect(result).toBe("not-ours");
    expect(created).not.toHaveBeenCalled();
    expect(discountUpdated).not.toHaveBeenCalled();
  });
});

describe("orderEventsEnabled — off unless someone turned it on", () => {
  test("off when the variable is absent", () => {
    expect(orderEventsEnabled({})).toBe(false);
  });

  test.each(["", "0", "false", "no", "off", "yes"])(
    "off for %o",
    (value) => {
      expect(orderEventsEnabled({ MAXOFF_ENABLE_ORDER_EVENTS: value })).toBe(false);
    },
  );

  test.each(["1", "true"])("on for %o", (value) => {
    expect(orderEventsEnabled({ MAXOFF_ENABLE_ORDER_EVENTS: value })).toBe(true);
  });

  test("the app ships with it off", () => {
    // The guard the App Store review depends on. If this ever fails, the
    // webhook is live and `read_orders` had better be approved.
    expect(orderEventsEnabled(process.env)).toBe(false);
  });
});
