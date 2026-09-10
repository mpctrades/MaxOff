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
import type { DisplayStatus } from "../lib/cap";
import { formatMoney, formatPercent } from "../lib/format";
import { statusWhere } from "./discounts.server";

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
  ordersCapped: number;
  /** False until the orders/paid webhook has written a single row. */
  hasCapEvents: boolean;
  biggestSave: HomeBiggestSave | null;
  weeks: HomeWeek[];
  discounts: HomeDiscountRow[];
  setup: HomeSetup;
}

export async function getHomeData(shop: string): Promise<HomeData> {
  const settings = await prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });

  const now = new Date();
  const thisMonthStart = startOfUtcMonth(now);
  const lastMonthStart = startOfUtcMonth(thisMonthStart, -1);
  const chartStart = startOfUtcWeek(now, -(CHART_WEEKS - 1));

  const [
    activeCount,
    scheduledCount,
    pausedCount,
    totalCount,
    thisMonth,
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
    ordersCapped: thisMonth._count._all,
    hasCapEvents: capEventCount > 0,
    biggestSave: biggestSaveRow
      ? {
          keptMinor: biggestSaveRow.keptMinor,
          orderName: biggestSaveRow.orderName,
          code: biggestSaveRow.discount.code,
        }
      : null,
    weeks: bucketByWeek(chartRows, chartStart),
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
    done: settings.plan !== "free",
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
): HomeWeek[] {
  const weeks: HomeWeek[] = [];
  for (let index = 0; index < CHART_WEEKS; index++) {
    const start = addUtcDays(chartStart, index * 7);
    weeks.push({ weekStartISO: start.toISOString().slice(0, 10), keptMinor: 0 });
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
 * Month and week boundaries are UTC.
 *
 * TODO(sophea): they should be the shop's, which means storing the shop's
 * timezone on `ShopSettings`. A merchant in Phnom Penh (UTC+7) sees "this
 * month" turn over seven hours late; nothing is lost or double-counted, the
 * boundary is just in the wrong place. Naming the drift rather than using the
 * VPS's local time, which would move with the server.
 */
function startOfUtcMonth(from: Date, monthOffset = 0): Date {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + monthOffset, 1),
  );
}

/** Monday of the week containing `from`, offset by whole weeks. */
function startOfUtcWeek(from: Date, weekOffset = 0): Date {
  const midnight = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  // getUTCDay() is 0 on Sunday, which is six days into a Monday-start week.
  const daysSinceMonday = (midnight.getUTCDay() + 6) % 7;
  return addUtcDays(midnight, -daysSinceMonday + weekOffset * 7);
}

function addUtcDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
