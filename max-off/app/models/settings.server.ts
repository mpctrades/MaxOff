/**
 * The shop's own settings row, and the one thing on it that comes from Shopify.
 *
 * `ensureShopSettings` is the single upsert for `ShopSettings`. Home, Create,
 * Test a cart and Settings all need the row to exist before they render, and
 * four copies of the same upsert is how the default for a new field ends up
 * disagreeing between screens.
 */

import type { Prisma, ShopSettings } from "@prisma/client";

import prisma from "../db.server";
import {
  DEFAULT_CHECKOUT_NOTE,
  isCapScope,
  normaliseCheckoutNote,
} from "../lib/cap-config";
import type { CapScope } from "../lib/cap-config";
import { can } from "../lib/plans";
import type { CapabilityKey } from "../lib/plans";
import { isRoundingMode } from "../lib/rounding";
import { isValidTimeZone } from "../lib/timezone";

/**
 * The store's currency and its timezone — the two facts about the shop that
 * Shopify owns and MaxOff only mirrors.
 *
 * Validated against the live 2026-10 schema on 10 Sep 2026 and again on
 * 15 Sep 2026 for `ianaTimezone`: the `shop` query reports **no required
 * access scope**, so reading either needs nothing beyond what MaxOff has.
 */
const SHOP_PROFILE_QUERY = `#graphql
  query MaxOffShopProfile {
    shop {
      currencyCode
      ianaTimezone
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

interface ShopProfileResponse {
  data?: {
    shop?: {
      currencyCode?: string | null;
      ianaTimezone?: string | null;
    } | null;
  } | null;
}

/**
 * Read the store's currency and timezone from Shopify and cache them on
 * `ShopSettings`.
 *
 * `currencyCode` defaults to `"USD"` and, until this existed, nothing ever
 * asked Shopify what the store actually sells in — so every amount in MaxOff
 * was labelled USD on a EUR store. `timezone` defaults to `"UTC"` and had the
 * same problem in a different currency: every date the merchant typed was read
 * as a UTC wall clock, so a discount set to start at midnight in Phnom Penh
 * went live at 7am. The store is the authority for both; our columns are a
 * cache so the other screens can format and parse without an Admin API call
 * each.
 *
 * MaxOff never converts money. A 150 maximum is 150 in whatever the store's
 * currency is (CLAUDE.md rule 5), so a currency change relabels every amount
 * and moves none. A timezone change is not the same kind of thing: it moves
 * every boundary, which is why it is read from the store rather than offered
 * as a setting MaxOff could disagree with Shopify about.
 *
 * If the read fails, the cached values stand: a settings page that cannot
 * reach Shopify should show the last known currency, not blank out every
 * amount.
 */
export async function refreshShopProfile(input: {
  shop: string;
  admin: AdminGraphqlClient;
}): Promise<{
  settings: ShopSettings;
  /** Null when Shopify could not be reached. */
  liveCurrencyCode: string | null;
  liveTimeZone: string | null;
}> {
  const settings = await ensureShopSettings(input.shop);

  let liveCurrencyCode: string | null = null;
  let liveTimeZone: string | null = null;
  try {
    const response = await input.admin.graphql(SHOP_PROFILE_QUERY);
    const body = (await response.json()) as ShopProfileResponse;
    liveCurrencyCode = body.data?.shop?.currencyCode ?? null;
    liveTimeZone = body.data?.shop?.ianaTimezone ?? null;
  } catch {
    return { settings, liveCurrencyCode: null, liveTimeZone: null };
  }

  const data: Prisma.ShopSettingsUpdateInput = {};

  if (liveCurrencyCode !== null && liveCurrencyCode !== settings.currencyCode) {
    data.currencyCode = liveCurrencyCode;
  }

  // A zone this runtime cannot resolve is not written. Caching it would make
  // every date fall back to UTC on every screen, which is a worse answer than
  // the last zone that did work.
  if (
    liveTimeZone !== null &&
    isValidTimeZone(liveTimeZone) &&
    liveTimeZone !== settings.timezone
  ) {
    data.timezone = liveTimeZone;
  }

  if (Object.keys(data).length === 0) {
    return { settings, liveCurrencyCode, liveTimeZone };
  }

  const updated = await prisma.shopSettings.update({
    where: { shop: input.shop },
    data,
  });

  return { settings: updated, liveCurrencyCode, liveTimeZone };
}

/**
 * What a Settings submission may contain, and what it means.
 *
 * Two fields, and they are settings for two different reasons. The checkout
 * note is the shop's *default* — it prefills the create form and changes
 * nothing about a discount that already exists. Rounding is the opposite: it
 * is a statement about how this shop discounts, so saving it rewrites the
 * `cap_config` of every discount the shop already has (see `restampRounding`
 * in `discounts.server.ts`). A setting that only applied to discounts made
 * after it would leave one store rounding two ways.
 *
 * The store currency is on the page but not here. Shopify owns it, MaxOff
 * follows it, and nothing converts (rule 5) — an editable select would promise
 * something the cap engine does not do.
 */
export interface SaveSettingsInput {
  shop: string;
  /** The live plan, which decides whether the note may be reworded. */
  plan: string;
  form: FormData;
}

export interface SaveSettingsResult {
  ok: boolean;
  /** The row as it now stands, saved or not, so the page can re-render truth. */
  settings: ShopSettings;
  /** Column names that actually changed — empty when the merchant saved a no-op. */
  changed: string[];
  /** Field name → message, so the page shows the error on the field. */
  fieldErrors: Record<string, string>;
}

/** Refused when a shop without the entitlement tries to reword the note. */
export const CHECKOUT_NOTE_NOT_ON_PLAN =
  "Custom checkout wording is on the Growth plan.";

/** Refused when the submitted rounding is not one this app implements. */
export const ROUNDING_UNKNOWN = "Choose one of the rounding rules listed.";

/** Refused when the submitted default maximum is not one the app implements. */
export const SCOPE_UNKNOWN = "Choose one of the maximums listed.";

/** Refused when the plan does not include the chosen default maximum. */
export const SCOPE_NOT_ON_PLAN =
  "A maximum per item or per collection is on the Pro plan.";

/** The three combination columns, written once so a loop can carry them. */
const COMBINATION_FIELDS = [
  "defaultCombinesProduct",
  "defaultCombinesOrder",
  "defaultCombinesShipping",
] as const;

/**
 * The entitlement a default maximum needs — the same mapping the create form
 * applies, read from the one matrix rather than restated here.
 */
function capabilityForScope(scope: CapScope): CapabilityKey {
  if (scope === "item") {
    return "itemMaximums";
  }
  if (scope === "collection") {
    return "collectionMaximums";
  }
  return "orderMaximum";
}

/**
 * Apply a Settings submission.
 *
 * Only the two fields above are read. A crafted POST naming `plan`, `shop` or
 * `currencyCode` changes nothing, because nothing here reads those names — the
 * allow-list is the code rather than a list a later edit can widen by accident.
 *
 * The plan check asks "is this a **change**?", not "is this custom?". A shop
 * that wrote its own note on Growth still has it stored after moving to Free,
 * and refusing every submission that is not the locked wording would lock that
 * shop out of its own Settings page entirely — unable to save rounding because
 * of a note field it is not allowed to touch. Resubmitting what is already
 * stored is always allowed, and so is going back to the locked wording.
 * `app/lib/settings-note.test.ts` is that rule written down.
 */
export async function upsertSettings(
  input: SaveSettingsInput,
): Promise<SaveSettingsResult> {
  const settings = await ensureShopSettings(input.shop);

  const fieldErrors: Record<string, string> = {};
  const data: Prisma.ShopSettingsUpdateInput = {};
  const changed: string[] = [];

  const submittedNote = input.form.get("defaultCheckoutNote");
  if (typeof submittedNote === "string") {
    const note = normaliseCheckoutNote(submittedNote);

    if (
      note !== settings.defaultCheckoutNote &&
      note !== DEFAULT_CHECKOUT_NOTE &&
      !can(input.plan, "customCheckoutWording")
    ) {
      fieldErrors.defaultCheckoutNote = CHECKOUT_NOTE_NOT_ON_PLAN;
    } else if (note !== settings.defaultCheckoutNote) {
      data.defaultCheckoutNote = note;
      changed.push("defaultCheckoutNote");
    }
  }

  const submittedRounding = input.form.get("rounding");
  if (typeof submittedRounding === "string") {
    if (!isRoundingMode(submittedRounding)) {
      fieldErrors.rounding = ROUNDING_UNKNOWN;
    } else if (submittedRounding !== settings.rounding) {
      data.rounding = submittedRounding;
      changed.push("rounding");
    }
  }

  // ---- Defaults for new discounts ----
  // Prefills only. Nothing below reaches a discount that already exists, so
  // none of it restamps anything — the contrast with `rounding` above is the
  // point, and it is what the section's helper text promises.

  const submittedScope = input.form.get("defaultScope");
  if (typeof submittedScope === "string") {
    if (!isCapScope(submittedScope)) {
      fieldErrors.defaultScope = SCOPE_UNKNOWN;
    } else if (!can(input.plan, capabilityForScope(submittedScope))) {
      // Gated exactly as the create form gates it. A default the merchant
      // cannot actually use would hand them a form that fails on open.
      fieldErrors.defaultScope = SCOPE_NOT_ON_PLAN;
    } else if (submittedScope !== settings.defaultScope) {
      data.defaultScope = submittedScope;
      changed.push("defaultScope");
    }
  }

  // "1 per customer" or "No limit". Stored as the boolean the discount itself
  // carries, so there is one definition of the fact and not two.
  const submittedOnce = input.form.get("defaultOncePerCustomer");
  if (typeof submittedOnce === "string") {
    const once = submittedOnce === "true";
    if (once !== settings.defaultOncePerCustomer) {
      data.defaultOncePerCustomer = once;
      changed.push("defaultOncePerCustomer");
    }
  }

  for (const combination of COMBINATION_FIELDS) {
    const submitted = input.form.get(combination);
    if (typeof submitted !== "string") {
      continue;
    }

    const on = submitted === "true";
    if (on !== settings[combination]) {
      data[combination] = on;
      changed.push(combination);
    }
  }

  // Nothing is written when any field is wrong. The two fields save together
  // from one save bar, so a partial write would leave the page showing one
  // saved value and one rejected one under a single "Saved" toast.
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, settings, changed: [], fieldErrors };
  }

  if (changed.length === 0) {
    return { ok: true, settings, changed: [], fieldErrors };
  }

  const updated = await prisma.shopSettings.update({
    where: { shop: input.shop },
    data,
  });

  return { ok: true, settings: updated, changed, fieldErrors };
}
