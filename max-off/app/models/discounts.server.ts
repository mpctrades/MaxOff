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
import { capConfigMetafield, DEFAULT_CHECKOUT_NOTE } from "../lib/cap-config";
import { formatMoney } from "../lib/format";
import { activeDiscountLimit } from "../lib/plans";
import { getPlanForGate } from "./plan.server";

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
    const refusal = await planLimitRefusal({
      shop: input.shop,
      id: input.id,
      now,
      plan: await getPlanForGate({ shop: input.shop, admin: input.admin }),
    });
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
 * The plan's limit on active capped discounts — the only plan limit V1
 * enforces in code (§3.6). Enforced here rather than only in the UI, so a
 * second browser tab cannot get around it.
 *
 * The limit comes from `activeDiscountLimit` in `app/lib/plans.ts`, and the
 * plan comes from Shopify rather than our cached column, because refusing a
 * merchant who upgraded a minute ago would be a billing complaint, not a bug
 * report.
 */
export async function planLimitRefusal(input: {
  shop: string;
  /** The discount being activated, excluded from the count. Null on create. */
  id: string | null;
  now: Date;
  plan: string;
}): Promise<{ ok: false; message: string; upgradeUrl: string } | null> {
  const limit = activeDiscountLimit(input.plan);
  if (limit === null) {
    return null;
  }

  const activeElsewhere = await prisma.cappedDiscount.count({
    where: {
      ...activeDiscountWhere(input.shop, input.now),
      ...(input.id === null ? {} : { id: { not: input.id } }),
    },
  });

  if (activeElsewhere < limit) {
    return null;
  }

  return {
    ok: false,
    message:
      limit === 1
        ? "The Free plan allows one active capped discount. Pause the other one, or choose a plan."
        : `Your plan allows ${limit} active capped discounts. Pause one, or choose a plan.`,
    upgradeUrl: "/app/billing",
  };
}

/**
 * The Function's handle, from `extensions/max-off-cap/shopify.extension.toml`.
 * `functionHandle` — not `functionId`, which the 2026-10 schema reports as
 * deprecated ("Use `functionHandle` instead"), resolving the contradiction
 * BUILD-LOG flagged on 8 Sep.
 */
const FUNCTION_HANDLE = "max-off-cap";

/**
 * Creating the discount. `codeAppDiscount { discountId }` is selected because
 * `discountGid` is `@unique` on our mirror and is how the orders/paid webhook
 * will find the discount — and that selection is why this app needs
 * `read_discounts` (BUILD-SPEC §3.3, corrected 10 Sep 2026).
 *
 * The cap metafield goes in inline: no separate `metafieldsSet` round trip
 * (§3.1), so there is no window in which a live discount has no config.
 */
const CREATE_MUTATION = `#graphql
  mutation MaxOffCreateDiscount($discount: DiscountCodeAppInput!) {
    discountCodeAppCreate(codeAppDiscount: $discount) {
      codeAppDiscount {
        discountId
      }
      userErrors {
        field
        code
        message
      }
    }
  }`;

/** The uniqueness check §4.3 wants on blur. Needs `read_discounts`. */
const CODE_TAKEN_QUERY = `#graphql
  query MaxOffCodeTaken($code: String!) {
    codeDiscountNodeByCode(code: $code) {
      id
    }
  }`;

export interface CreateDiscountInput {
  shop: string;
  admin: AdminGraphqlClient;
  code: string;
  percentage: number;
  capMinor: number;
  currencyCode: string;
  startsAt: Date;
  endsAt: Date | null;
  usageLimit: number | null;
  oncePerCustomer: boolean;
  combinesProduct: boolean;
  combinesOrder: boolean;
  combinesShipping: boolean;
}

export type CreateDiscountResult =
  | {
      ok: true;
      code: string;
      discountGid: string;
      /** False when Shopify accepted but our mirror write failed (§2b). */
      mirrored: boolean;
    }
  | {
      ok: false;
      message: string;
      upgradeUrl?: string;
      /** Field name → message, so the form shows errors on the field. */
      fieldErrors?: Record<string, string>;
    };

/**
 * Is this code already used by any discount in the shop — ours or Shopify's own?
 *
 * Returns null when we cannot tell (a transport failure), so the caller can
 * stay quiet rather than claim a code is free. Shopify enforces uniqueness on
 * create regardless; this only moves the error to the field, on blur.
 */
export async function isCodeTaken(
  admin: AdminGraphqlClient,
  code: string,
): Promise<boolean | null> {
  const trimmed = code.trim();
  if (trimmed === "") {
    return null;
  }

  try {
    const response = await admin.graphql(CODE_TAKEN_QUERY, {
      variables: { code: trimmed },
    });
    const body = (await response.json()) as {
      data?: { codeDiscountNodeByCode?: { id: string } | null } | null;
    };

    return Boolean(body.data?.codeDiscountNodeByCode);
  } catch {
    return null;
  }
}

interface CreateResponse {
  data?: {
    discountCodeAppCreate?: {
      codeAppDiscount?: { discountId?: string | null } | null;
      userErrors: UserError[];
    } | null;
  } | null;
  errors?: { message: string }[] | null;
}

/**
 * Create a capped discount: Shopify first, then the mirror (§3.1).
 *
 * If Shopify accepts and the mirror write then fails, the discount is **kept**.
 * It is live and capping correctly at checkout, and deleting it because our
 * own database hiccuped would be the worse outcome — so the caller gets
 * `mirrored: false` and warns the merchant that it will appear in the list once
 * MaxOff resyncs. A real reconcile-from-Shopify job is V2.
 */
export async function createCappedDiscount(
  input: CreateDiscountInput,
): Promise<CreateDiscountResult> {
  const now = new Date();

  const refusal = await planLimitRefusal({
    shop: input.shop,
    id: null,
    now,
    plan: await getPlanForGate({ shop: input.shop, admin: input.admin }),
  });
  if (refusal) {
    return refusal;
  }

  let metafield;
  try {
    metafield = capConfigMetafield({
      percentage: input.percentage,
      capMinor: input.capMinor,
      currencyCode: input.currencyCode,
      code: input.code,
    });
  } catch (error) {
    // buildCapConfig throws only on input the Function would refuse, which
    // means validation upstream let something through.
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "That cap could not be saved.",
    };
  }

  const title = `${input.code} — ${input.percentage}% capped at ${formatMoney(
    input.capMinor,
    input.currencyCode,
  )}`;

  const response = await input.admin.graphql(CREATE_MUTATION, {
    variables: {
      discount: {
        title,
        code: input.code,
        functionHandle: FUNCTION_HANDLE,
        // Without ORDER the Function returns no operations and the discount
        // silently does nothing (BUILD-LOG, 8 Sep).
        discountClasses: ["ORDER"],
        startsAt: input.startsAt.toISOString(),
        endsAt: input.endsAt?.toISOString() ?? null,
        usageLimit: input.usageLimit,
        appliesOncePerCustomer: input.oncePerCustomer,
        // V1 eligibility is every buyer. `context` replaces the deprecated
        // `customerSelection`; segments and specific customers are V2 and would
        // also need read_customers.
        context: { all: "ALL" },
        combinesWith: {
          orderDiscounts: input.combinesOrder,
          productDiscounts: input.combinesProduct,
          shippingDiscounts: input.combinesShipping,
        },
        metafields: [metafield],
      },
    },
  });

  const body = (await response.json()) as CreateResponse;

  const transportError = body.errors?.[0]?.message;
  if (transportError) {
    return { ok: false, message: transportError };
  }

  const payload = body.data?.discountCodeAppCreate;
  const userError = payload?.userErrors?.[0];
  if (userError) {
    return {
      ok: false,
      message: userError.message,
      fieldErrors: fieldErrorsFrom(payload?.userErrors ?? []),
    };
  }

  const discountGid = payload?.codeAppDiscount?.discountId;
  if (!discountGid) {
    return {
      ok: false,
      message:
        "Shopify did not return the new discount's id, so MaxOff cannot track it. Nothing was created.",
    };
  }

  try {
    await prisma.cappedDiscount.create({
      data: {
        shop: input.shop,
        discountGid,
        method: "code",
        code: input.code,
        title,
        percentage: input.percentage,
        capMinor: input.capMinor,
        currencyCode: input.currencyCode,
        scope: "order",
        checkoutNote: DEFAULT_CHECKOUT_NOTE,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        // Intent, not display: the list derives scheduled and expired from the
        // dates (§1a of docs/PROMPT-DISCOUNTS.md).
        status: "active",
        usageLimit: input.usageLimit,
        oncePerCustomer: input.oncePerCustomer,
        combinesProduct: input.combinesProduct,
        combinesOrder: input.combinesOrder,
        combinesShipping: input.combinesShipping,
      },
    });

    return { ok: true, code: input.code, discountGid, mirrored: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[maxoff] ${input.code} (${discountGid}) was created in Shopify but the mirror write failed`,
      error,
    );

    return { ok: true, code: input.code, discountGid, mirrored: false };
  }
}

/**
 * Map Shopify's `userErrors[].field` onto our form field names, so an error
 * lands on the field rather than in a banner (§4.3).
 */
function fieldErrorsFrom(errors: UserError[]): Record<string, string> {
  const mapped: Record<string, string> = {};

  for (const error of errors) {
    const last = error.field?.[error.field.length - 1];
    switch (last) {
      case "code":
        mapped.code = error.message;
        break;
      case "startsAt":
        mapped.startsAt = error.message;
        break;
      case "endsAt":
        mapped.endsAt = error.message;
        break;
      case "usageLimit":
        mapped.usageLimit = error.message;
        break;
      default:
        break;
    }
  }

  return mapped;
}
