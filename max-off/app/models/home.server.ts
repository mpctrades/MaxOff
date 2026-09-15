/**
 * Everything the Home screen shows, read from our own tables.
 *
 * No Admin API calls: every number on Home traces to a `CapEvent` or a
 * `CappedDiscount` row, which is what stops the three views (Home, Detail,
 * Analytics) from disagreeing the way the mockup's three fake datasets did
 * (BUILD-SPEC §12.4). Analytics reuses this module rather than re-deriving.
 */

import prisma from "../db.server";
import { capStartsAboveMinor, displayStatus } from "../lib/cap";
import { toPlanKey } from "../lib/plans";
import type { DisplayStatus } from "../lib/cap";
import { formatMoney, formatPercent } from "../lib/format";
import { statusWhere } from "./discounts.server";
import { ensureShopSettings } from "./settings.server";
import {
  isoDateInZone,
  startOfMonthInZone,
  startOfWeekInZone,
  toTimeZone,
} from "../lib/timezone";

/** How many weeks the "Money you kept" chart shows. §4.1: eight bars. */
const CHART_WEEKS = 8;

/** Active discounts listed on Home. §4.1: the rest are behind "View all". */
const HOME_DISCOUNT_LIMIT = 5;

export interface HomeDiscountRow {
  id: string;
  code: string | null;
  percentage: number;
  capMinor: number;
  /** "Cap starts above" — null when it cannot be derived (§8: never NaN). */
  capStartsAboveMinor: number | null;
  timesUsed: number;
  keptMinor: number;
  status: DisplayStatus;
}

export interface HomeWeek {
  /** Monday of the week, UTC, as an ISO date. */
  weekStartISO: string;
  keptMinor: number;
}

export interface HomeBiggestSave {
  keptMinor: number;
  orderName: string;
  code: string | null;
}

export interface HomeSetupStep {
  done: boolean;
  /** The one-line result under a completed step, or null when there is none. */
  result: string | null;
}

export interface HomeSetup {
  dismissed: boolean;
  completedCount: number;
  stepCount: number;
  install: HomeSetupStep;
  create: HomeSetupStep;
  test: HomeSetupStep;
  plan: HomeSetupStep;
}

export interface HomeData {
  plan: string;
  currencyCode: string;
  activeCount: number;
  scheduledCount: number;
  pausedCount: number;
  totalCount: number;
  keptThisMonthMinor: number;
  keptLastMonthMinor: number;
  /** Orders this month where the cap actually bit — `keptMinor > 0`. */
  ordersCapped: number;
  /**
   * Orders this month that used one of the shop's capped discounts, capped or
   * not. The denominator under "Orders capped" (§4.1: "87 of 412 discounted
   * orders"), and the reason a `CapEvent` is written for every order a capped
   * discount touches, not only the ones that hit the maximum.
   */
  discountedOrders: number;
  /** False until the orders/paid webhook has written a single row. */
  hasCapEvents: boolean;
  biggestSave: HomeBiggestSave | null;
  weeks: HomeWeek[];
  discounts: HomeDiscountRow[];
  setup: HomeSetup;
}

export async function getHomeData(shop: string): Promise<HomeData> {
  const settings = await ensureShopSettings(shop);

  const now = new Date();
  // The shop's own calendar, not the server's and not Greenwich's. A merchant
  // in Phnom Penh used to see "this month" turn over seven hours late.
  const timeZone = toTimeZone(settings.timezone);
  const thisMonthStart = startOfMonthInZone(now, timeZone);
  const lastMonthStart = startOfMonthInZone(thisMonthStart, timeZone, -1);
  const chartStart = startOfWeekInZone(now, timeZone, -(CHART_WEEKS - 1));

  const [
    activeCount,
    scheduledCount,
    pausedCount,
    totalCount,
    thisMonth,
    cappedThisMonth,
    lastMonth,
    capEventCount,
    biggestSaveRow,
    chartRows,
    activeDiscounts,
    newestDiscount,
  ] = await Promise.all([
    // Counted with the list's own predicates (`statusWhere`), so the banner's
    // "N active discounts" and the list's Active tab can never disagree. A
    // groupBy on the stored column would count a discount that is scheduled or
    // expired by the clock as active.
    prisma.cappedDiscount.count({
      where: { shop, ...statusWhere("active", now) },
    }),
    prisma.cappedDiscount.count({
      where: { shop, ...statusWhere("scheduled", now) },
    }),
    prisma.cappedDiscount.count({
      where: { shop, ...statusWhere("paused", now) },
    }),
    prisma.cappedDiscount.count({ where: { shop } }),
    prisma.capEvent.aggregate({
      where: { shop, occurredAt: { gte: thisMonthStart } },
      _sum: { keptMinor: true },
      _count: { _all: true },
    }),
    // The cap bit on this one. A discounted order that stayed under the
    // break-even point kept nothing, and counting it as "capped" would
    // overstate the number the tile exists to report.
    prisma.capEvent.count({
      where: { shop, occurredAt: { gte: thisMonthStart }, keptMinor: { gt: 0 } },
    }),
    prisma.capEvent.aggregate({
      where: {
        shop,
        occurredAt: { gte: lastMonthStart, lt: thisMonthStart },
      },
      _sum: { keptMinor: true },
    }),
    prisma.capEvent.count({ where: { shop } }),
    prisma.capEvent.findFirst({
      where: { shop },
      orderBy: { keptMinor: "desc" },
      select: {
        keptMinor: true,
        orderName: true,
        discount: { select: { code: true } },
      },
    }),
    prisma.capEvent.findMany({
      where: { shop, occurredAt: { gte: chartStart } },
      select: { occurredAt: true, keptMinor: true },
    }),
    prisma.cappedDiscount.findMany({
      where: { shop, ...statusWhere("active", now) },
      orderBy: { createdAt: "desc" },
      take: HOME_DISCOUNT_LIMIT,
    }),
    prisma.cappedDiscount.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
      select: { code: true, percentage: true, capMinor: true },
    }),
  ]);

  return {
    plan: settings.plan,
    currencyCode: settings.currencyCode,
    activeCount,
    scheduledCount,
    pausedCount,
    totalCount,
    keptThisMonthMinor: thisMonth._sum.keptMinor ?? 0,
    keptLastMonthMinor: lastMonth._sum.keptMinor ?? 0,
    ordersCapped: cappedThisMonth,
    discountedOrders: thisMonth._count._all,
    hasCapEvents: capEventCount > 0,
    biggestSave: biggestSaveRow
      ? {
          keptMinor: biggestSaveRow.keptMinor,
          orderName: biggestSaveRow.orderName,
          code: biggestSaveRow.discount.code,
        }
      : null,
    weeks: bucketByWeek(chartRows, chartStart, timeZone),
    discounts: activeDiscounts.map((discount) => ({
      id: discount.id,
      code: discount.code,
      percentage: discount.percentage,
      capMinor: discount.capMinor,
      capStartsAboveMinor: capStartsAboveMinor(
        discount.capMinor,
        discount.percentage,
      ),
      timesUsed: discount.timesUsed,
      keptMinor: discount.keptMinor,
      // Derived, not the stored column — the same function the list uses.
      status: displayStatus(discount, now),
    })),
    setup: buildSetup({
      settings,
      totalCount,
      newestDiscount,
    }),
  };
}

/**
 * Mark the setup guide as hidden. §4.1 lets the merchant dismiss the card; the
 * stamp lives on `ShopSettings` so it survives a reload instead of pretending
 * in component state.
 */
export async function dismissSetupGuide(shop: string): Promise<void> {
  await prisma.shopSettings.upsert({
    where: { shop },
    update: { setupGuideDismissedAt: new Date() },
    create: { shop, setupGuideDismissedAt: new Date() },
  });
}

/**
 * Record that the merchant tested a cart and the cap actually bit — setup
 * step 3 on Home (§4.1).
 *
 * `cappedMinor` is the **discount given** (`givenMinor`), not the amount kept.
 * `buildSetup` renders these as "Tested 1,400.00 USD — capped correctly at
 * 150.00 USD", so passing `keptMinor` here would read "capped correctly at
 * 60.00 USD": wrong, and plausible enough to survive a review.
 *
 * Only called for a capped result. A cart that never reached the maximum did
 * not test the cap, so it leaves the step incomplete.
 */
export async function recordCartTest(input: {
  shop: string;
  subtotalMinor: number;
  cappedMinor: number;
}): Promise<void> {
  const data = {
    lastCartTestAt: new Date(),
    lastCartTestSubtotalMinor: input.subtotalMinor,
    lastCartTestCappedMinor: input.cappedMinor,
  };

  await prisma.shopSettings.upsert({
    where: { shop: input.shop },
    update: data,
    create: { shop: input.shop, ...data },
  });
}

interface SetupInput {
  settings: {
    plan: string;
    currencyCode: string;
    setupGuideDismissedAt: Date | null;
    lastCartTestAt: Date | null;
    lastCartTestSubtotalMinor: number | null;
    lastCartTestCappedMinor: number | null;
  };
  totalCount: number;
  newestDiscount: {
    code: string | null;
    percentage: number;
    capMinor: number;
  } | null;
}

function buildSetup({
  settings,
  totalCount,
  newestDiscount,
}: SetupInput): HomeSetup {
  const { currencyCode } = settings;

  const install: HomeSetupStep = { done: true, result: null };

  const create: HomeSetupStep = {
    done: totalCount > 0,
    result: newestDiscount
      ? `${newestDiscount.code ?? "Discount"} — ${formatPercent(
          newestDiscount.percentage,
        )} off, capped at ${formatMoney(newestDiscount.capMinor, currencyCode)}`
      : null,
  };

  const tested = settings.lastCartTestAt !== null;
  const test: HomeSetupStep = {
    done: tested,
    result:
      tested &&
      settings.lastCartTestSubtotalMinor !== null &&
      settings.lastCartTestCappedMinor !== null
        ? `Tested ${formatMoney(
            settings.lastCartTestSubtotalMinor,
            currencyCode,
          )} — capped correctly at ${formatMoney(
            settings.lastCartTestCappedMinor,
            currencyCode,
          )}`
        : null,
  };

  const plan: HomeSetupStep = {
    // Through plans.ts, so "which plans count as paid" is defined once.
    done: toPlanKey(settings.plan) !== "free",
    result: planResult(settings.plan),
  };

  const steps = [install, create, test, plan];

  return {
    dismissed: settings.setupGuideDismissedAt !== null,
    completedCount: steps.filter((step) => step.done).length,
    stepCount: steps.length,
    install,
    create,
    test,
    plan,
  };
}

function planResult(plan: string): string | null {
  if (plan === "growth") {
    return "You are on Growth. Upgrade to Pro for per-item caps and multi-currency.";
  }

  if (plan === "pro") {
    return "You are on Pro.";
  }

  return null;
}

/**
 * Sum kept amounts into `CHART_WEEKS` Monday-start buckets, oldest first.
 *
 * Weeks with no capped orders stay in the series as zero, so the chart's
 * x-axis is a calendar and not just the weeks that happened to have data.
 */
function bucketByWeek(
  rows: { occurredAt: Date; keptMinor: number }[],
  chartStart: Date,
  timeZone: string,
): HomeWeek[] {
  const weeks: HomeWeek[] = [];
  for (let index = 0; index < CHART_WEEKS; index++) {
    const start = addDays(chartStart, index * 7);
    // The shop's civil date for that Monday, not the instant's UTC date —
    // 14 Sep 00:00 in Phnom Penh is still 13 Sep in UTC, and the bar would be
    // labelled a day early. The chart parses this back as a civil date, so the
    // two ends agree without either needing the zone again.
    weeks.push({ weekStartISO: isoDateInZone(start, timeZone), keptMinor: 0 });
  }

  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
  for (const row of rows) {
    const offset = Math.floor(
      (row.occurredAt.getTime() - chartStart.getTime()) / MS_PER_WEEK,
    );
    const bucket = weeks[offset];
    if (bucket) {
      bucket.keptMinor += row.keptMinor;
    }
  }

  return weeks;
}

/**
 * Month and week boundaries used to be UTC, with a `TODO(sophea)` naming the
 * drift. They are the shop's own now — see `app/lib/timezone.ts`, where the
 * arithmetic lives so that Home and the create form cannot disagree about when
 * a day starts.
 *
 * `addDays` stays here because it is plain elapsed time: the week buckets are
 * seven-day windows from `chartStart`, and `chartStart` is already the shop's
 * Monday midnight.
 */
function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
