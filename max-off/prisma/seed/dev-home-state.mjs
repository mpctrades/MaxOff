/**
 * DEV SEED — NOT PRODUCTION CODE, NOT IMPORTED BY THE APP.
 *
 * The Home screen has three states (see docs/PROMPT-HOME.md §4) and two of
 * them cannot exist on a real store yet, because `CapEvent` rows are written
 * by the orders/paid webhook, which needs `read_orders` approval. This script
 * fabricates them in the local SQLite database so the screen can be looked at.
 *
 * Every number it writes is invented. Nothing here ever reaches a merchant:
 * it only touches prisma/dev.sqlite, which is gitignored.
 *
 *   node prisma/seed/dev-home-state.mjs clear    # state A — brand new install
 *   node prisma/seed/dev-home-state.mjs discount # state B — a discount, no capped orders
 *   node prisma/seed/dev-home-state.mjs full     # state C — capped orders and money kept
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SHOP = process.env.SEED_SHOP ?? "maxoff-s7fqtwdd.myshopify.com";

const DAY = 24 * 60 * 60 * 1000;

async function clear() {
  await prisma.capEvent.deleteMany({ where: { shop: SHOP } });
  await prisma.cappedDiscount.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
  console.log(`state A — cleared every MaxOff row for ${SHOP}`);
}

async function seedDiscount() {
  await clear();

  await prisma.shopSettings.create({
    data: { shop: SHOP, currencyCode: "USD", plan: "free" },
  });

  const discount = await prisma.cappedDiscount.create({
    data: {
      shop: SHOP,
      discountGid: "gid://shopify/DiscountCodeNode/000000001",
      method: "code",
      code: "SUMMER15",
      title: "Summer 15% capped at 150",
      percentage: 15,
      capMinor: 15000,
      currencyCode: "USD",
      startsAt: new Date(Date.now() - 30 * DAY),
      status: "active",
      timesUsed: 12,
    },
  });

  console.log(`state B — one active discount (${discount.code}), no cap events`);
  return discount;
}

async function seedFull() {
  const discount = await seedDiscount();

  await prisma.shopSettings.update({
    where: { shop: SHOP },
    data: {
      plan: "growth",
      lastCartTestAt: new Date(Date.now() - 2 * DAY),
      lastCartTestSubtotalMinor: 140000,
      lastCartTestCappedMinor: 15000,
    },
  });

  // Eight weeks of invented capped orders, so the chart has every bucket.
  const keptByWeek = [3100, 8800, 12400, 6200, 19500, 14800, 38900, 22600];
  let orderNumber = 1000;
  let totalKept = 0;

  for (const [index, keptMinor] of keptByWeek.entries()) {
    const weeksAgo = keptByWeek.length - 1 - index;
    const occurredAt = new Date(Date.now() - weeksAgo * 7 * DAY);
    const subtotalMinor = 140000;
    const uncappedMinor = 21000;

    orderNumber += 1;
    totalKept += keptMinor;

    await prisma.capEvent.create({
      data: {
        shop: SHOP,
        cappedDiscountId: discount.id,
        orderGid: `gid://shopify/Order/${orderNumber}`,
        orderName: `#${orderNumber}`,
        subtotalMinor,
        uncappedMinor,
        givenMinor: uncappedMinor - keptMinor,
        keptMinor,
        occurredAt,
      },
    });
  }

  await prisma.cappedDiscount.update({
    where: { id: discount.id },
    data: { keptMinor: totalKept, givenMinor: 15000 * keptByWeek.length },
  });

  console.log(
    `state C — ${keptByWeek.length} cap events, ${totalKept} minor units kept`,
  );
}

const mode = process.argv[2] ?? "full";

const run = { clear, discount: seedDiscount, full: seedFull }[mode];
if (!run) {
  console.error(`unknown mode "${mode}" — use clear, discount or full`);
  process.exit(1);
}

await run();
await prisma.$disconnect();
