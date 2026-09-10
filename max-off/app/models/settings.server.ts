/**
 * The shop's own settings row, and the one thing on it that comes from Shopify.
 *
 * `ensureShopSettings` is the single upsert for `ShopSettings`. Home, Create,
 * Test a cart and Settings all need the row to exist before they render, and
 * four copies of the same upsert is how the default for a new field ends up
 * disagreeing between screens.
 */

import type { ShopSettings } from "@prisma/client";

import prisma from "../db.server";

/**
 * The store's currency. Validated against the live 2026-10 schema on
 * 10 Sep 2026: it reports **no required access scope**, and none is documented
 * on the `shop` query, so reading this needs nothing beyond what MaxOff
 * already has.
 */
const SHOP_CURRENCY_QUERY = `#graphql
  query MaxOffShopCurrency {
    shop {
      currencyCode
    }
  }`;

/** The slice of the Admin API client this module needs, so it can be faked. */
export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

/** The row always exists after this. Defaults come from the Prisma schema. */
export async function ensureShopSettings(shop: string): Promise<ShopSettings> {
  return prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
}

interface ShopCurrencyResponse {
  data?: { shop?: { currencyCode?: string | null } | null } | null;
}

/**
 * Read the store's currency from Shopify and cache it on `ShopSettings`.
 *
 * `ShopSettings.currencyCode` defaults to `"USD"` and, until this existed,
 * nothing ever asked Shopify what the store actually sells in — so every
 * amount in MaxOff was labelled USD on a EUR store. The store is the authority;
 * our column is a cache so the other screens can format money without an
 * Admin API call each.
 *
 * MaxOff never converts. A 150 maximum is 150 in whatever the store's currency
 * is (CLAUDE.md rule 5), so a currency change relabels every amount and moves
 * no money.
 *
 * If the read fails, the cached value stands: a settings page that cannot reach
 * Shopify should show the last known currency, not blank out every amount.
 */
export async function refreshStoreCurrency(input: {
  shop: string;
  admin: AdminGraphqlClient;
}): Promise<{ settings: ShopSettings; liveCurrencyCode: string | null }> {
  const settings = await ensureShopSettings(input.shop);

  let liveCurrencyCode: string | null = null;
  try {
    const response = await input.admin.graphql(SHOP_CURRENCY_QUERY);
    const body = (await response.json()) as ShopCurrencyResponse;
    liveCurrencyCode = body.data?.shop?.currencyCode ?? null;
  } catch {
    return { settings, liveCurrencyCode: null };
  }

  if (liveCurrencyCode === null || liveCurrencyCode === settings.currencyCode) {
    return { settings, liveCurrencyCode };
  }

  const updated = await prisma.shopSettings.update({
    where: { shop: input.shop },
    data: { currencyCode: liveCurrencyCode },
  });

  return { settings: updated, liveCurrencyCode };
}

/**
 * The fields a merchant may change on the Settings page in V1.
 *
 * **Empty on purpose.** The checkout note is V2 (§4.7), the currency is the
 * store's and not ours to set (§2a), and rounding is not implemented anywhere —
 * `cap_config` has no rounding field and the Function hard-codes half-up, so a
 * working select would change nothing about real money (§2b).
 *
 * This list is the only thing that decides what a POST to Settings may write.
 * A crafted form naming `rounding` or `plan` changes nothing, because nothing
 * reads those names. Enabling the checkout note later means adding one entry.
 */
export const EDITABLE_SETTINGS: readonly (keyof Pick<
  ShopSettings,
  "defaultCheckoutNote"
>)[] = [];

export interface SaveSettingsResult {
  changed: string[];
}

/**
 * Apply only the allow-listed fields from a submission, and report what
 * actually changed. With an empty allow-list this writes nothing at all, which
 * is the honest V1 behaviour rather than a save that pretends.
 */
export async function saveShopSettings(input: {
  shop: string;
  form: FormData;
}): Promise<SaveSettingsResult> {
  const data: Record<string, string> = {};

  for (const field of EDITABLE_SETTINGS) {
    const value = input.form.get(field);
    if (typeof value === "string") {
      data[field] = value;
    }
  }

  if (Object.keys(data).length === 0) {
    return { changed: [] };
  }

  await prisma.shopSettings.update({ where: { shop: input.shop }, data });

  return { changed: Object.keys(data) };
}
