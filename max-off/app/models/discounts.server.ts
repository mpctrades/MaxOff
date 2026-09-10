/**
 * The capped discounts list, and pausing or activating one.
 *
 * Reads come from our own tables (BUILD-SPEC §3.1: Shopify is the source of
 * truth, our rows are a mirror for listing and search). Writes go to Shopify
 * first and only reach the mirror if Shopify accepted them.
 */

import type { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { capStartsAboveMinor, displayStatus, DISCOUNT_TABS } from "../lib/cap";
import type { DiscountTab, DisplayStatus } from "../lib/cap";

/** §4 of docs/PROMPT-DISCOUNTS.md. Offset pagination is fine at this scale:
 * a shop with more capped discounts than a few pages does not exist yet, and
 * offsets keep the tab counts and the page links trivially linkable. Revisit
 * with cursors if a merchant ever passes a few thousand rows. */
const PAGE_SIZE = 25;

export interface DiscountListRow {
  id: string;
  discountGid: string;
  code: string | null;
  percentage: number;
  capMinor: number;
  /** Null when it cannot be derived — rendered as an em dash, never NaN. */
  capStartsAboveMinor: number | null;
  timesUsed: number;
  keptMinor: number;
  status: DisplayStatus;
  currencyCode: string;
}

export interface DiscountList {
  rows: DiscountListRow[];
  /** Row count for the tab being shown. */
  total: number;
  /** Row count per tab, for the tab labels. Search is applied to these too. */
  tabCounts: Record<DiscountTab, number>;
  page: number;
  pageCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * The stored `status` column holds intent — "active" or "paused" — and the
 * clock decides the rest, so a tab cannot be a plain `where` on the column.
 * These predicates are the SQL twin of `displayStatus`, in the same order, so
 * the two cannot drift: anything not paused is intent-active and re-derived
 * from its dates.
 *
 * Exported because Home's cap-engine banner counts active discounts and has to
 * count them the same way (§1a) — Home and the list disagreeing is mockup
 * defect §12.4 all over again.
 */
export function statusWhere(
  tab: DiscountTab,
  now: Date,
): Prisma.CappedDiscountWhereInput {
  switch (tab) {
    case "paused":
      return { status: "paused" };
    case "scheduled":
      return { status: { not: "paused" }, startsAt: { gt: now } };
    case "expired":
      return {
        status: { not: "paused" },
        startsAt: { lte: now },
        endsAt: { lte: now },
      };
    case "active":
      return {
        status: { not: "paused" },
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      };
    case "all":
      return {};
  }
}

/** Shared by the list and Home, so both count "active" identically. */
export function activeDiscountWhere(
  shop: string,
  now: Date,
): Prisma.CappedDiscountWhereInput {
  return { shop, ...statusWhere("active", now) };
}

export async function listCappedDiscounts(input: {
  shop: string;
  tab: DiscountTab;
  query: string;
  page: number;
}): Promise<DiscountList> {
  const now = new Date();
  const search = input.query.trim();

  // Discount codes are uppercase by convention, and SQLite's LIKE is
  // case-insensitive for ASCII, so `contains` on an uppercased needle matches
  // however the merchant typed it. Prisma's `mode: "insensitive"` is not
  // available on SQLite.
  const searchWhere: Prisma.CappedDiscountWhereInput =
    search === "" ? {} : { code: { contains: search.toUpperCase() } };

  const where: Prisma.CappedDiscountWhereInput = {
    shop: input.shop,
    ...searchWhere,
    ...statusWhere(input.tab, now),
  };

  const [total, rows, ...counts] = await Promise.all([
    prisma.cappedDiscount.count({ where }),
    prisma.cappedDiscount.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (Math.max(input.page, 1) - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    ...DISCOUNT_TABS.map((tab) =>
      prisma.cappedDiscount.count({
        where: {
          shop: input.shop,
          ...searchWhere,
          ...statusWhere(tab, now),
        },
      }),
    ),
  ]);

  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const page = Math.min(Math.max(input.page, 1), pageCount);

  const tabCounts = Object.fromEntries(
    DISCOUNT_TABS.map((tab, index) => [tab, counts[index]]),
  ) as Record<DiscountTab, number>;

  return {
    rows: rows.map((row) => ({
      id: row.id,
      discountGid: row.discountGid,
      code: row.code,
      percentage: row.percentage,
      capMinor: row.capMinor,
      capStartsAboveMinor: capStartsAboveMinor(row.capMinor, row.percentage),
      timesUsed: row.timesUsed,
      keptMinor: row.keptMinor,
      status: displayStatus(row, now),
      currencyCode: row.currencyCode,
    })),
    total,
    tabCounts,
    page,
    pageCount,
    hasNextPage: page < pageCount,
    hasPreviousPage: page > 1,
  };
}

/**
 * The two mutations, verified against the live 2026-10 admin schema on
 * 10 Sep 2026 with `validate_graphql_codeblocks`.
 *
 * They select **only** `userErrors` on purpose. Selecting `codeDiscountNode`
 * back makes the operation require `read_discounts` as well as
 * `write_discounts`, and `read_discounts` is not in `shopify.app.toml` yet —
 * adding it forces a reinstall (CLAUDE.md rule 9). Both mutations are
 * deterministic about the state they produce, so the mirror does not need the
 * node read back to know what happened.
 */
const PAUSE_MUTATION = `#graphql
  mutation MaxOffPauseDiscount($id: ID!) {
    discountCodeDeactivate(id: $id) {
      userErrors {
        field
        code
        message
      }
    }
  }`;

const ACTIVATE_MUTATION = `#graphql
  mutation MaxOffActivateDiscount($id: ID!) {
    discountCodeActivate(id: $id) {
      userErrors {
        field
        code
        message
      }
    }
  }`;

interface UserError {
  field?: string[] | null;
  code?: string | null;
  message: string;
}

interface MutationResponse {
  data?: {
    discountCodeDeactivate?: { userErrors: UserError[] } | null;
    discountCodeActivate?: { userErrors: UserError[] } | null;
  } | null;
  errors?: { message: string }[] | null;
}

/** The slice of the Admin API client this module needs, so it can be faked. */
export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

export type SetPausedResult =
  | { ok: true; code: string | null; status: DisplayStatus }
  | { ok: false; message: string; upgradeUrl?: string };

/**
 * Pause or activate one capped discount.
 *
 * Shopify first, mirror second (§3.1). If Shopify returns `userErrors`,
 * nothing local changes and the caller gets that exact message — the UI must
 * not invent a friendlier one, because the merchant needs to know what Shopify
 * refused.
 */
export async function setDiscountPaused(input: {
  shop: string;
  id: string;
  paused: boolean;
  admin: AdminGraphqlClient;
}): Promise<SetPausedResult> {
  const discount = await prisma.cappedDiscount.findFirst({
    where: { id: input.id, shop: input.shop },
  });

  if (!discount) {
    return { ok: false, message: "That discount is no longer in MaxOff." };
  }

  const now = new Date();

  if (!input.paused) {
    const refusal = await freePlanRefusal(input.shop, input.id, now);
    if (refusal) {
      return refusal;
    }
  }

  const response = await input.admin.graphql(
    input.paused ? PAUSE_MUTATION : ACTIVATE_MUTATION,
    { variables: { id: discount.discountGid } },
  );

  const body = (await response.json()) as MutationResponse;

  const transportError = body.errors?.[0]?.message;
  if (transportError) {
    return { ok: false, message: transportError };
  }

  const payload = input.paused
    ? body.data?.discountCodeDeactivate
    : body.data?.discountCodeActivate;

  const userError = payload?.userErrors?.[0];
  if (userError) {
    // Shopify refused. The mirror is untouched, so the UI reverts to truth.
    return { ok: false, message: userError.message };
  }

  if (!payload) {
    return {
      ok: false,
      message: "Shopify did not confirm the change. Nothing was changed.",
    };
  }

  // Shopify's own documentation: activating a discount whose `startsAt` is in
  // the future moves `startsAt` to now. Mirror that, or our derived status
  // would keep calling a live discount "scheduled".
  const startsAt =
    !input.paused && discount.startsAt.getTime() > now.getTime()
      ? now
      : discount.startsAt;

  const updated = await prisma.cappedDiscount.update({
    where: { id: discount.id },
    data: { status: input.paused ? "paused" : "active", startsAt },
  });

  return {
    ok: true,
    code: updated.code,
    status: displayStatus(updated, now),
  };
}

/**
 * Free allows one active capped discount (§3.6) — the only plan limit V1
 * enforces in code. Enforced here rather than only in the UI, so a second
 * browser tab cannot get around it.
 */
async function freePlanRefusal(
  shop: string,
  id: string,
  now: Date,
): Promise<{ ok: false; message: string; upgradeUrl: string } | null> {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  if (settings && settings.plan !== "free") {
    return null;
  }

  const activeElsewhere = await prisma.cappedDiscount.count({
    where: { ...activeDiscountWhere(shop, now), id: { not: id } },
  });

  if (activeElsewhere === 0) {
    return null;
  }

  return {
    ok: false,
    message:
      "The Free plan allows one active capped discount. Pause the other one, or choose a plan.",
    upgradeUrl: "/app/billing",
  };
}
