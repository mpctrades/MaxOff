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
 *   node prisma/seed/dev-home-state.mjs list     # the six mockup rows, one per list state
 *   node prisma/seed/dev-home-state.mjs list --free   # same, but on the Free plan
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

/**
 * The six rows from the mockup's Capped discounts screen, chosen so that every
 * tab and every row action from §12.3 has something to act on. Note that only
 * `active` and `paused` are ever *stored*: "scheduled" and "expired" are facts
 * about the dates, derived by `displayStatus`.
 */
async function seedList() {
  await clear();

  const free = process.argv.includes("--free");

  await prisma.shopSettings.create({
    data: {
      shop: SHOP,
      currencyCode: "USD",
      // The Free plan allows one active discount, so three active rows would
      // make every activate refuse. Growth by default; pass --free to test the
      // limit itself.
      plan: free ? "free" : "growth",
      lastCartTestAt: new Date(Date.now() - 2 * DAY),
      lastCartTestSubtotalMinor: 140000,
      lastCartTestCappedMinor: 15000,
    },
  });

  const past = new Date(Date.now() - 30 * DAY);
  const future = new Date(Date.now() + 30 * DAY);
  const ended = new Date(Date.now() - 5 * DAY);

  const rows = [
    // code, pct, cap minor, stored status, startsAt, endsAt, used, kept minor
    ["SUMMER15", 15, 15000, "active", past, null, 148, 61240],
    ["VIP20", 20, 8000, "active", past, null, 96, 38820],
    ["WELCOME10", 10, 2500, "active", past, null, 210, 13940],
    ["BF30", 30, 20000, "active", future, null, 0, 0],
    ["BF-TEST", 30, 20000, "paused", past, null, 4, 6200],
    ["SPRING12", 12, 6000, "active", past, ended, 63, 3800],
  ];

  let index = 0;
  for (const [code, percentage, capMinor, status, startsAt, endsAt, used, kept] of rows) {
    index += 1;
    await prisma.cappedDiscount.create({
      data: {
        shop: SHOP,
        discountGid: `gid://shopify/DiscountCodeNode/90000000${index}`,
        method: "code",
        code,
        title: `${code} — ${percentage}% capped`,
        percentage,
        capMinor,
        currencyCode: "USD",
        startsAt,
        endsAt,
        status,
        timesUsed: used,
        keptMinor: kept,
        givenMinor: 0,
        // Newest first is the list's sort order, so stagger createdAt to make
        // the order predictable rather than dependent on insert speed.
        createdAt: new Date(Date.now() - (rows.length - index) * DAY),
      },
    });
  }

  console.log(
    `six mockup rows seeded on the ${free ? "Free" : "Growth"} plan — ` +
      "3 active, 1 scheduled, 1 paused, 1 expired",
  );
}

const mode = process.argv[2] ?? "full";

const run = { clear, discount: seedDiscount, full: seedFull, list: seedList }[mode];
if (!run) {
  console.error(`unknown mode "${mode}" — use clear, discount, full or list`);
  process.exit(1);
}

await run();
await prisma.$disconnect();
