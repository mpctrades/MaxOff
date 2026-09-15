/**
 * The capped discounts list, and pausing or activating one.
 *
 * Reads come from our own tables (BUILD-SPEC §3.1: Shopify is the source of
 * truth, our rows are a mirror for listing and search). Writes go to Shopify
 * first and only reach the mirror if Shopify accepted them.
 */

import type { Prisma } from "@prisma/client";

import prisma from "../db.server";
import {
  capStartsAboveMinor,
  displayStatus,
  displayStatusLabel,
  DISCOUNT_TABS,
} from "../lib/cap";
import type { DiscountTab, DisplayStatus } from "../lib/cap";
import {
  CAP_CONFIG_KEY,
  CAP_CONFIG_NAMESPACE,
  CAP_CONFIG_TYPE,
  capConfigMetafield,
} from "../lib/cap-config";
import type { CapScope } from "../lib/cap-config";
import { formatMoney } from "../lib/format";
import { activeDiscountLimit } from "../lib/plans";
import { toRoundingMode } from "../lib/rounding";
import { getPlanForGate } from "./plan.server";
import { ensureShopSettings } from "./settings.server";

/** §4 of docs/PROMPT-DISCOUNTS.md. Offset pagination is fine at this scale:
 * a shop with more capped discounts than a few pages does not exist yet, and
 * offsets keep the tab counts and the page links trivially linkable. Revisit
 * with cursors if a merchant ever passes a few thousand rows. */
const PAGE_SIZE = 25;

export interface DiscountListRow {
  id: string;
  discountGid: string;
  /** "code" or "automatic". An automatic discount has no code to show. */
  method: string;
  title: string | null;
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
  /**
   * Every capped discount in the shop, ignoring the tab and the search. This
   * is what separates "this shop has none yet" from "these filters match
   * none" — two different empty states with two different actions.
   */
  storeTotal: number;
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
  // A cancelled discount is gone from Shopify, so it is none of the four
  // states below — not even "expired", which is a discount that ran. It is
  // excluded from every tab but "All", and above all from "active", which is
  // what the plan's discount limit counts.
  const live: Prisma.CappedDiscountWhereInput = {
    status: { notIn: ["paused", "cancelled"] },
  };

  switch (tab) {
    case "paused":
      return { status: "paused" };
    case "scheduled":
      return { ...live, startsAt: { gt: now } };
    case "expired":
      return {
        ...live,
        startsAt: { lte: now },
        endsAt: { lte: now },
      };
    case "active":
      return {
        ...live,
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

/** "all", or one of the two ways a buyer gets a discount. */
export type MethodFilter = "all" | "code" | "automatic";

/** "all", or one of the three maximums a discount can carry. */
export type CapTypeFilter = "all" | CapScope;

export function isMethodFilter(value: string | null): value is MethodFilter {
  return value === "all" || value === "code" || value === "automatic";
}

export function isCapTypeFilter(value: string | null): value is CapTypeFilter {
  return (
    value === "all" || value === "order" || value === "item" || value === "collection"
  );
}

export async function listCappedDiscounts(input: {
  shop: string;
  tab: DiscountTab;
  query: string;
  page: number;
  method?: MethodFilter;
  capType?: CapTypeFilter;
}): Promise<DiscountList> {
  const now = new Date();
  const search = input.query.trim();

  // `mode: "insensitive"` on both columns, and it has to be explicit.
  //
  // This used to lean on SQLite, whose LIKE is case-insensitive for ASCII, and
  // uppercased the needle because codes are stored uppercase. Postgres does not
  // do that: `contains` there is case-sensitive, so "summer" would have stopped
  // matching SUMMER15 and a title would only match on exact casing. Postgres is
  // also what makes the fix available — the option this comment once said we
  // could not use.
  const searchWhere: Prisma.CappedDiscountWhereInput =
    search === ""
      ? {}
      : {
          // An automatic discount has no code, so searching only the code
          // column would make every one of them unfindable.
          OR: [
            { code: { contains: search, mode: "insensitive" } },
            { title: { contains: search, mode: "insensitive" } },
          ],
        };

  // Both read straight off the mirror: `method` and `scope` are columns, so
  // these are filters rather than the promises they used to be.
  const methodWhere: Prisma.CappedDiscountWhereInput =
    input.method === undefined || input.method === "all"
      ? {}
      : { method: input.method };

  const capTypeWhere: Prisma.CappedDiscountWhereInput =
    input.capType === undefined || input.capType === "all"
      ? {}
      : { scope: input.capType };

  const where: Prisma.CappedDiscountWhereInput = {
    shop: input.shop,
    ...searchWhere,
    ...methodWhere,
    ...capTypeWhere,
    ...statusWhere(input.tab, now),
  };

  const [storeTotal, total, rows, ...counts] = await Promise.all([
    prisma.cappedDiscount.count({ where: { shop: input.shop } }),
    prisma.cappedDiscount.count({ where }),
    prisma.cappedDiscount.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (Math.max(input.page, 1) - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    // The tab counts carry the search and both filters, so a badge never
    // promises rows the table would not show once the tab is opened.
    ...DISCOUNT_TABS.map((tab) =>
      prisma.cappedDiscount.count({
        where: {
          shop: input.shop,
          ...searchWhere,
          ...methodWhere,
          ...capTypeWhere,
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
      method: row.method,
      title: row.title,
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
    storeTotal,
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

/**
 * The same two operations for an automatic discount.
 *
 * An automatic discount is a different node type in Shopify, and the code
 * mutations simply do not accept its id — so the method a discount was created
 * with decides which pair runs. Validated against the 2026-10 schema on
 * 14 Sep 2026; both need only `write_discounts`.
 */
const PAUSE_AUTOMATIC_MUTATION = `#graphql
  mutation MaxOffPauseAutomaticDiscount($id: ID!) {
    discountAutomaticDeactivate(id: $id) {
      userErrors {
        field
        code
        message
      }
    }
  }`;

const ACTIVATE_AUTOMATIC_MUTATION = `#graphql
  mutation MaxOffActivateAutomaticDiscount($id: ID!) {
    discountAutomaticActivate(id: $id) {
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
    discountAutomaticDeactivate?: { userErrors: UserError[] } | null;
    discountAutomaticActivate?: { userErrors: UserError[] } | null;
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
  | { ok: true; code: string | null; title: string | null; status: DisplayStatus }
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

  const automatic = discount.method === "automatic";

  const response = await input.admin.graphql(
    automatic
      ? input.paused
        ? PAUSE_AUTOMATIC_MUTATION
        : ACTIVATE_AUTOMATIC_MUTATION
      : input.paused
        ? PAUSE_MUTATION
        : ACTIVATE_MUTATION,
    { variables: { id: discount.discountGid } },
  );

  const body = (await response.json()) as MutationResponse;

  const transportError = body.errors?.[0]?.message;
  if (transportError) {
    return { ok: false, message: transportError };
  }

  const payload = automatic
    ? input.paused
      ? body.data?.discountAutomaticDeactivate
      : body.data?.discountAutomaticActivate
    : input.paused
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
    title: updated.title,
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
    // The plan is named by the number, not by a hard-coded "Free": the limits
    // live in plans.ts and a sentence that names a plan goes stale the moment
    // they move.
    message: `Your plan allows ${limit} active capped discount${
      limit === 1 ? "" : "s"
    }. Pause one, or choose a plan.`,
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
 * The discount class a scope needs, which is the other half of the contract in
 * `cart_lines_discounts_generate_run.ts`: the Function checks for exactly this
 * class and returns nothing without it.
 *
 * Note for the week-4 edit screen: changing the scope of a live discount also
 * changes the class it needs, so an edit that offers the scope has to move the
 * discount's `discountClasses` with it — or refuse the change. Whether Shopify
 * accepts a class change on an existing app discount is unverified; check it
 * against the 2026-10 schema before building that screen.
 */
function discountClassFor(scope: CapScope): "ORDER" | "PRODUCT" {
  return scope === "order" ? "ORDER" : "PRODUCT";
}

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

/**
 * The same thing for a discount that needs no code.
 *
 * `DiscountAutomaticAppInput` has no `code`, no `usageLimit` and no
 * `appliesOncePerCustomer` — there is no code to ration, so Shopify does not
 * offer the fields. The form hides them for this method rather than sending
 * values Shopify would reject. Validated against the 2026-10 schema on
 * 14 Sep 2026.
 */
const CREATE_AUTOMATIC_MUTATION = `#graphql
  mutation MaxOffCreateAutomaticDiscount($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount {
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
  /** "code" for a discount a buyer types, "automatic" for one that just applies. */
  method: "code" | "automatic";
  /** Empty for an automatic discount. */
  code: string;
  /** The merchant's own name for an automatic discount. Derived for a code. */
  title: string;
  /** Whether the maximum is one per order, per line, or per collection. */
  scope: CapScope;
  appliesTo: "all" | "collections" | "products";
  collectionIds: string[];
  productIds: string[];
  checkoutNote: string;
  percentage: number;
  capMinor: number;
  /** The least the eligible cart must come to. Null is no minimum. */
  minSubtotalMinor: number | null;
  /** The least number of eligible items. Null is no minimum. */
  minQuantity: number | null;
  /** A maximum per market currency, in minor units, keyed by ISO code. */
  capsByCurrency: Record<string, number>;
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
      /** The merchant-facing name, for the toast and the banner. */
      title: string;
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
    discountAutomaticAppCreate?: {
      automaticAppDiscount?: { discountId?: string | null } | null;
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

  // The shop's rounding is read here rather than passed in from the form,
  // because it is not a decision about this discount — it is a decision about
  // this store, made on Settings, and a create form that carried it would be a
  // second place for it to be set.
  const { rounding } = await ensureShopSettings(input.shop);

  const refusal = await planLimitRefusal({
    shop: input.shop,
    id: null,
    now,
    plan: await getPlanForGate({ shop: input.shop, admin: input.admin }),
  });
  if (refusal) {
    return refusal;
  }

  const automatic = input.method === "automatic";

  let metafield;
  try {
    metafield = capConfigMetafield({
      percentage: input.percentage,
      capMinor: input.capMinor,
      currencyCode: input.currencyCode,
      rounding: toRoundingMode(rounding),
      // An automatic discount has no code, and a null here is what stops the
      // Function prefixing the buyer's line with one.
      code: automatic ? null : input.code,
      checkoutNote: input.checkoutNote,
      scope: input.scope,
      minSubtotalMinor: input.minSubtotalMinor,
      minQuantity: input.minQuantity,
      capsByCurrency: input.capsByCurrency,
      appliesTo: input.appliesTo,
      collectionIds: input.collectionIds,
      productIds: input.productIds,
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

  const rule = `${input.percentage}% capped at ${formatMoney(
    input.capMinor,
    input.currencyCode,
  )}`;

  // A code discount names itself after its code, because that is what the
  // merchant recognises it by in Shopify's own discount list. An automatic
  // discount has no code, so the merchant's own name is all there is.
  const title = automatic ? input.title : `${input.code} — ${rule}`;

  /** Everything both inputs share. The two differ only in how a buyer gets it. */
  const common = {
    title,
    functionHandle: FUNCTION_HANDLE,
    // The class has to match what the Function will emit for this scope, or
    // the Function returns no operations and the discount silently does
    // nothing (BUILD-LOG, 8 Sep). One maximum for the order is a single
    // order-level amount — ORDER. A maximum per line or per collection hands
    // out several amounts at once, which only PRODUCT candidates can carry.
    discountClasses: [discountClassFor(input.scope)],
    startsAt: input.startsAt.toISOString(),
    endsAt: input.endsAt?.toISOString() ?? null,
    combinesWith: {
      orderDiscounts: input.combinesOrder,
      productDiscounts: input.combinesProduct,
      shippingDiscounts: input.combinesShipping,
    },
    metafields: [metafield],
  };

  const response = automatic
    ? await input.admin.graphql(CREATE_AUTOMATIC_MUTATION, {
        variables: { discount: common },
      })
    : await input.admin.graphql(CREATE_MUTATION, {
        variables: {
          discount: {
            ...common,
            code: input.code,
            usageLimit: input.usageLimit,
            appliesOncePerCustomer: input.oncePerCustomer,
            // V1 eligibility is every buyer. `context` replaces the deprecated
            // `customerSelection`; segments and specific customers are V2 and
            // would also need read_customers.
            context: { all: "ALL" },
          },
        },
      });

  const body = (await response.json()) as CreateResponse;

  const transportError = body.errors?.[0]?.message;
  if (transportError) {
    return { ok: false, message: transportError };
  }

  const payload = automatic
    ? body.data?.discountAutomaticAppCreate
    : body.data?.discountCodeAppCreate;
  const userError = payload?.userErrors?.[0];
  if (userError) {
    return {
      ok: false,
      message: userError.message,
      fieldErrors: fieldErrorsFrom(payload?.userErrors ?? []),
    };
  }

  const discountGid = automatic
    ? body.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId
    : body.data?.discountCodeAppCreate?.codeAppDiscount?.discountId;
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
        method: input.method,
        // Null rather than an empty string: the column is nullable precisely
        // so "this discount has no code" is a fact and not a blank one.
        code: automatic ? null : input.code,
        title,
        percentage: input.percentage,
        capMinor: input.capMinor,
        currencyCode: input.currencyCode,
        scope: "order",
        checkoutNote: input.checkoutNote,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        // Intent, not display: the list derives scheduled and expired from the
        // dates (§1a of docs/PROMPT-DISCOUNTS.md).
        status: "active",
        usageLimit: automatic ? null : input.usageLimit,
        oncePerCustomer: automatic ? false : input.oncePerCustomer,
        combinesProduct: input.combinesProduct,
        combinesOrder: input.combinesOrder,
        combinesShipping: input.combinesShipping,
      },
    });

    return { ok: true, code: input.code, title, discountGid, mirrored: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[maxoff] ${title} (${discountGid}) was created in Shopify but the mirror write failed`,
      error,
    );

    return { ok: true, code: input.code, title, discountGid, mirrored: false };
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

/**
 * Every capped discount in the shop, as CSV — the Pro export.
 *
 * Read from our own mirror rather than from Shopify, which is why it needs no
 * scope: §3.1 already keeps these rows in step with Shopify, and a merchant
 * exporting a list is exporting the list they are looking at.
 *
 * Unpaginated on purpose. The list pages at 25 because a table is read a
 * screen at a time; a spreadsheet is not, and an export that stopped at the
 * first 25 rows would be a quiet way to lose a merchant's data.
 *
 * Money is written in major units with two decimals and no thousands
 * separator, and no currency symbol — the currency has its own column. That
 * is the one format a spreadsheet reads back as a number in every locale.
 */
export async function exportCappedDiscountsCsv(input: {
  shop: string;
  tab: DiscountTab;
  query: string;
  method?: MethodFilter;
  capType?: CapTypeFilter;
}): Promise<string> {
  const rows: string[][] = [
    [
      "Code",
      "Name",
      "Method",
      "Percentage",
      "Maximum discount",
      "Cap starts above",
      "Currency",
      "Status",
      "Times used",
      "Money you kept",
      "Starts at",
      "Ends at",
    ],
  ];

  // One page at a time rather than one query, so a shop with a great many
  // discounts does not build the whole result set in memory at once.
  for (let page = 1; ; page += 1) {
    const list = await listCappedDiscounts({ ...input, page });

    // The list rows carry everything but the dates, so those are fetched for
    // the whole page in one query rather than one per row.
    const dates = new Map<string, { startsAt: Date; endsAt: Date | null }>();
    if (list.rows.length > 0) {
      const records = await prisma.cappedDiscount.findMany({
        where: { id: { in: list.rows.map((row) => row.id) } },
        select: { id: true, startsAt: true, endsAt: true },
      });
      for (const record of records) {
        dates.set(record.id, { startsAt: record.startsAt, endsAt: record.endsAt });
      }
    }

    for (const row of list.rows) {
      const record = dates.get(row.id);

      rows.push([
        row.code ?? "",
        row.title ?? "",
        row.method === "automatic" ? "Automatic" : "Code",
        String(row.percentage),
        decimalString(row.capMinor),
        row.capStartsAboveMinor === null ? "" : decimalString(row.capStartsAboveMinor),
        row.currencyCode,
        displayStatusLabel(row.status),
        String(row.timesUsed),
        decimalString(row.keptMinor),
        isoDate(record?.startsAt ?? null),
        isoDate(record?.endsAt ?? null),
      ]);
    }

    if (list.rows.length === 0 || page >= list.pageCount) {
      break;
    }
  }

  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** Minor units as a bare decimal, which is what a spreadsheet reads as a number. */
function decimalString(minor: number): string {
  const whole = Math.floor(minor / 100);
  const cents = minor % 100;
  return `${whole}.${String(cents).padStart(2, "0")}`;
}

/** `2026-09-15`, in UTC, so a VPS in another zone cannot shift a date by a day. */
function isoDate(value: Date | null): string {
  return value === null ? "" : value.toISOString().slice(0, 10);
}

/**
 * One CSV cell, quoted the way RFC 4180 says.
 *
 * The leading apostrophe on anything that starts with `=`, `+`, `-` or `@` is
 * not decoration: a spreadsheet treats those as the start of a formula, and a
 * discount code is merchant-supplied text. Prefixing them is the standard
 * defence against a CSV injection that runs when the merchant opens the file.
 */
function csvCell(value: string): string {
  const risky = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(risky) ? `"${risky.replace(/"/g, '""')}"` : risky;
}

/**
 * Cancelling a capped discount.
 *
 * Deletes it in Shopify, then marks our row `cancelled` rather than removing
 * it. The mirror is what the list, the counts and the money-kept total are
 * read from, and deleting the row would take a merchant's own history away to
 * tidy up a table — §3.1 makes Shopify the source of truth for the discount,
 * not for the record that it existed.
 *
 * Shopify first, mirror second, and the mirror is only touched if Shopify
 * accepted: a row marked cancelled beside a discount still running is the one
 * failure that would actually cost a merchant money.
 */
const DELETE_CODE_MUTATION = `#graphql
  mutation MaxOffDeleteCodeDiscount($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedCodeDiscountId
      userErrors { field code message }
    }
  }`;

const DELETE_AUTOMATIC_MUTATION = `#graphql
  mutation MaxOffDeleteAutomaticDiscount($id: ID!) {
    discountAutomaticDelete(id: $id) {
      deletedAutomaticDiscountId
      userErrors { field code message }
    }
  }`;

interface DeleteResponse {
  data?: {
    discountCodeDelete?: {
      deletedCodeDiscountId?: string | null;
      userErrors?: { field?: string[] | null; message: string }[] | null;
    } | null;
    discountAutomaticDelete?: {
      deletedAutomaticDiscountId?: string | null;
      userErrors?: { field?: string[] | null; message: string }[] | null;
    } | null;
  } | null;
  errors?: { message: string }[];
}

export async function cancelCappedDiscount(input: {
  shop: string;
  id: string;
  admin: AdminGraphqlClient;
}): Promise<
  | { ok: true; code: string | null; title: string | null }
  | { ok: false; message: string }
> {
  const row = await prisma.cappedDiscount.findFirst({
    where: { id: input.id, shop: input.shop },
  });

  if (row === null) {
    return { ok: false, message: "That capped discount is no longer in MaxOff." };
  }

  const automatic = row.method === "automatic";

  const response = await input.admin.graphql(
    automatic ? DELETE_AUTOMATIC_MUTATION : DELETE_CODE_MUTATION,
    { variables: { id: row.discountGid } },
  );
  const body = (await response.json()) as DeleteResponse;

  const transportError = body.errors?.[0]?.message;
  if (transportError) {
    return { ok: false, message: transportError };
  }

  const payload = automatic
    ? body.data?.discountAutomaticDelete
    : body.data?.discountCodeDelete;

  const userError = payload?.userErrors?.[0];
  if (userError) {
    return { ok: false, message: userError.message };
  }

  const deleted = automatic
    ? body.data?.discountAutomaticDelete?.deletedAutomaticDiscountId
    : body.data?.discountCodeDelete?.deletedCodeDiscountId;

  if (!deleted) {
    return {
      ok: false,
      message:
        "Shopify did not confirm the discount was cancelled, so MaxOff left its record alone.",
    };
  }

  await prisma.cappedDiscount.update({
    where: { id: row.id },
    data: { status: "cancelled" },
  });

  return { ok: true, code: row.code, title: row.title };
}

/**
 * The configuration behind a discount, read back from Shopify for Duplicate.
 *
 * Our mirror carries what the list renders and no more — it has no targeting,
 * no minimums and no per-market maximums. Those live in the `cap_config`
 * metafield, which is the source of truth for them, so a duplicate that is
 * actually a duplicate has to read it rather than guess from the columns.
 */
const READ_CAP_CONFIG_QUERY = `#graphql
  query MaxOffReadCapConfig($id: ID!) {
    discountNode(id: $id) {
      id
      metafield(namespace: "$app", key: "cap_config") {
        jsonValue
      }
    }
  }`;

export async function readCapConfigFor(input: {
  shop: string;
  id: string;
  admin: AdminGraphqlClient;
}): Promise<{ row: CappedDiscountRecord; config: unknown } | null> {
  const row = await prisma.cappedDiscount.findFirst({
    where: { id: input.id, shop: input.shop },
  });

  if (row === null) {
    return null;
  }

  try {
    const response = await input.admin.graphql(READ_CAP_CONFIG_QUERY, {
      variables: { id: row.discountGid },
    });
    const body = (await response.json()) as {
      data?: { discountNode?: { metafield?: { jsonValue?: unknown } | null } | null } | null;
    };

    return { row, config: body.data?.discountNode?.metafield?.jsonValue ?? null };
  } catch {
    // A duplicate that loses the targeting is worse than one that says so, but
    // the columns we do hold are still worth prefilling. The caller decides.
    return { row, config: null };
  }
}

type CappedDiscountRecord = NonNullable<
  Awaited<ReturnType<typeof prisma.cappedDiscount.findFirst>>
>;

/* ------------------------------------------------- the shop's rounding rule */

/**
 * Write a new `cap_config` onto a discount that already exists.
 *
 * `metafieldsSet` takes at most 25 metafields per call, and needs the same
 * access as mutating the owner — `write_discounts`, which MaxOff already has
 * because it creates discounts. Validated against the 2026-10 admin schema on
 * 15 Sep 2026.
 */
const REWRITE_CAP_CONFIG_MUTATION = `#graphql
  mutation MaxOffRewriteCapConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
      }
      userErrors {
        field
        message
      }
    }
  }`;

/** How many metafields `metafieldsSet` accepts in one call. */
const METAFIELDS_PER_CALL = 25;

/** How many configs we read at once. Small enough not to burst the API. */
const READS_AT_A_TIME = 5;

export interface RestampRoundingResult {
  /** Discounts whose stored configuration now carries the new rounding. */
  updated: number;
  /**
   * Discounts MaxOff could not rewrite — unreadable config, or Shopify
   * refusing the write. Never silently zero: the caller tells the merchant.
   */
  failed: number;
}

/**
 * Apply the shop's rounding to every capped discount it already has.
 *
 * Rounding is a statement about how *this store* discounts, so it has to be
 * true of the discounts already running and not only of the next one. The
 * Function reads its rounding off each discount's own `cap_config` — it has no
 * way to reach a shop-level row — so "a store setting" means writing the same
 * value onto every one of them.
 *
 * Read-modify-write, never rebuild: `cap_config` carries targeting, minimums
 * and per-market maximums that our mirror does not have, so a config built
 * from the columns would quietly delete them. Only the `rounding` key is
 * touched, and `version` is deliberately left alone — an older config keeps
 * saying which shape it is, and the Function reads `rounding` on every version
 * it supports.
 *
 * Cancelled discounts are skipped: they no longer exist in Shopify, and the
 * mutation would fail on every one of them.
 *
 * Failures are counted, not thrown. The setting is already saved by the time
 * this runs, and a merchant is better served by "saved, but three discounts
 * could not be updated" than by a save that rolls back over one stale row.
 */
export async function restampRounding(input: {
  shop: string;
  admin: AdminGraphqlClient;
  rounding: string;
}): Promise<RestampRoundingResult> {
  const rows = await prisma.cappedDiscount.findMany({
    where: { shop: input.shop, status: { not: "cancelled" } },
    select: { discountGid: true },
  });

  if (rows.length === 0) {
    return { updated: 0, failed: 0 };
  }

  let failed = 0;
  const metafields: {
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }[] = [];

  for (let i = 0; i < rows.length; i += READS_AT_A_TIME) {
    const batch = rows.slice(i, i + READS_AT_A_TIME);

    const configs = await Promise.all(
      batch.map((row) => readCapConfigJson(input.admin, row.discountGid)),
    );

    configs.forEach((config, index) => {
      if (config === null) {
        // A config we cannot read is one we must not rewrite: writing our two
        // known keys over it would replace the merchant's targeting with
        // nothing. Counted and reported instead.
        failed += 1;
        return;
      }

      metafields.push({
        ownerId: batch[index].discountGid,
        namespace: CAP_CONFIG_NAMESPACE,
        key: CAP_CONFIG_KEY,
        type: CAP_CONFIG_TYPE,
        value: JSON.stringify({ ...config, rounding: input.rounding }),
      });
    });
  }

  let updated = 0;

  for (let i = 0; i < metafields.length; i += METAFIELDS_PER_CALL) {
    const batch = metafields.slice(i, i + METAFIELDS_PER_CALL);

    try {
      const response = await input.admin.graphql(REWRITE_CAP_CONFIG_MUTATION, {
        variables: { metafields: batch },
      });
      const body = (await response.json()) as {
        data?: {
          metafieldsSet?: {
            metafields?: { key: string }[] | null;
            userErrors?: UserError[] | null;
          } | null;
        } | null;
        errors?: { message: string }[] | null;
      };

      const written = body.data?.metafieldsSet?.metafields?.length ?? 0;
      updated += written;
      failed += batch.length - written;
    } catch {
      failed += batch.length;
    }
  }

  return { updated, failed };
}

/** One discount's stored `cap_config` as a plain object, or null if unreadable. */
async function readCapConfigJson(
  admin: AdminGraphqlClient,
  discountGid: string,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await admin.graphql(READ_CAP_CONFIG_QUERY, {
      variables: { id: discountGid },
    });
    const body = (await response.json()) as {
      data?: {
        discountNode?: { metafield?: { jsonValue?: unknown } | null } | null;
      } | null;
    };

    const value = body.data?.discountNode?.metafield?.jsonValue;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
