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
import { capConfigMetafield } from "../lib/cap-config";
import type { CapScope } from "../lib/cap-config";
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

  const where: Prisma.CappedDiscountWhereInput = {
    shop: input.shop,
    ...searchWhere,
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
      // An automatic discount has no code, and a null here is what stops the
      // Function prefixing the buyer's line with one.
      code: automatic ? null : input.code,
      checkoutNote: input.checkoutNote,
      scope: input.scope,
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
