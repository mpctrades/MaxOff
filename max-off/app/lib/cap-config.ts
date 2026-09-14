/**
 * The `cap_config` metafield the admin writes and the Function reads.
 *
 * This file is the admin half of a contract whose other half is
 * `extensions/max-off-cap/src/cap_config.ts`. That parser's governing rule is
 * that **configuration it cannot read with certainty applies no discount at
 * all** — so every mistake here is silent at checkout: no error, no clue, just
 * a discount that does not discount.
 *
 * The ways to get it wrong, all of which the Function refuses:
 *
 * - `version` a number this Function does not know
 * - `percentage` not an integer, or outside 1-100
 * - `capAmount` as a JSON number instead of a string
 * - `capAmount` in minor units ("15000" reads as 15,000.00 — a cap 100× too high)
 * - `scope` present and not "order"
 * - `appliesTo` naming a set with no ids in it
 *
 * `app/lib/cap-config.test.ts` round-trips this module's output through the
 * Function's own parser, so a divergence fails a test rather than a checkout.
 *
 * ## Two jobs, one metafield
 *
 * Since 14 Sep 2026 this metafield is read twice per checkout, for two
 * different purposes:
 *
 * 1. The Function reads the whole object as its configuration, as before.
 * 2. Shopify reads its **top-level keys** to populate the input query's
 *    variables, because `[extensions.input.variables]` in
 *    `shopify.extension.toml` points at this same namespace and key.
 *
 * That second job is why `collectionIds` is a top-level key and not nested
 * under an `appliesTo` object: the variable `$collectionIds` in
 * `src/cart_lines_discounts_generate_run.graphql` is populated from the key of
 * that exact name. Nesting it would leave the variable null and every product
 * out of the collection set, which is a discount that silently does nothing.
 * See https://shopify.dev/docs/apps/build/functions/input-queries/use-variables-input-queries
 */

import { parseDecimalToMinor, toDecimalString } from "./cap";

/**
 * `$app`, not `$app:maxoff` — corrected in BUILD-SPEC §3.1 on 8 Sep 2026. The
 * declarative TOML block that creates the definition is
 * `[discount.metafields.app.cap_config]`, whose namespace segment is `app`.
 */
export const CAP_CONFIG_NAMESPACE = "$app";
export const CAP_CONFIG_KEY = "cap_config";
export const CAP_CONFIG_TYPE = "json";

/**
 * The shape the admin writes today.
 *
 * Version 1 was percentage + cap on the whole cart. Version 2 adds
 * `appliesTo`, its two id lists, and a `checkoutNote` the Function actually
 * puts in front of the buyer. The deployed Function still reads version 1,
 * because discounts created before 14 Sep 2026 are live and carry it — see
 * `SUPPORTED_VERSIONS` in the Function's parser.
 */
export const CAP_CONFIG_VERSION = 2;

/** V1 caps the whole order. `item` and `collection` are PRO, and unbuilt. */
export const CAP_CONFIG_SCOPE = "order";

/** Locked copy, BUILD-SPEC §11. The default when the merchant writes nothing. */
export const DEFAULT_CHECKOUT_NOTE = "Discount capped at maximum amount";

/** What the buyer can be shown. Longer than this is the merchant's typo. */
export const CHECKOUT_NOTE_MAX_LENGTH = 60;

/** Which part of the cart the percentage is taken on. */
export type AppliesTo = "all" | "collections" | "products";

export const APPLIES_TO_VALUES: readonly AppliesTo[] = [
  "all",
  "collections",
  "products",
];

export function isAppliesTo(value: unknown): value is AppliesTo {
  return (APPLIES_TO_VALUES as readonly unknown[]).includes(value);
}

export interface CapConfigInput {
  percentage: number;
  capMinor: number;
  currencyCode: string;
  /** Null for an automatic discount, which has no code to show the buyer. */
  code: string | null;
  checkoutNote?: string;
  appliesTo?: AppliesTo;
  collectionIds?: string[];
  productIds?: string[];
}

export interface CapConfigJson {
  version: number;
  percentage: number;
  /** A decimal string in **major** units, two decimals. Never a number. */
  capAmount: string;
  currencyCode: string;
  scope: string;
  checkoutNote: string;
  code: string | null;
  appliesTo: AppliesTo;
  /**
   * Top level, and always present, because Shopify populates the input query's
   * `$collectionIds` variable from this key by name. Empty when the discount
   * does not target collections — `inAnyCollection` on an empty set is false
   * for every product, which is exactly right for a set nobody is matching.
   */
  collectionIds: string[];
  /** Matched inside the Function against each line's product id. */
  productIds: string[];
}

/**
 * Build the metafield value. Throws rather than returning something the
 * Function would refuse: a caller that has not validated its input has a bug,
 * and a thrown error is visible where a silent non-discount is not.
 */
export function buildCapConfig(input: CapConfigInput): CapConfigJson {
  if (!Number.isInteger(input.percentage) || input.percentage < 1 || input.percentage > 100) {
    throw new Error(
      `cap_config percentage must be a whole number between 1 and 100, got ${input.percentage}`,
    );
  }

  if (!Number.isInteger(input.capMinor) || input.capMinor < 1) {
    throw new Error(
      `cap_config capMinor must be a positive whole number of minor units, got ${input.capMinor}`,
    );
  }

  const appliesTo = input.appliesTo ?? "all";
  const collectionIds = appliesTo === "collections" ? cleanIds(input.collectionIds) : [];
  const productIds = appliesTo === "products" ? cleanIds(input.productIds) : [];

  // A targeted discount with nothing to target discounts nothing at all, which
  // at checkout is indistinguishable from the app being broken. Refuse it here,
  // where the merchant is still looking at the form.
  if (appliesTo === "collections" && collectionIds.length === 0) {
    throw new Error("cap_config appliesTo 'collections' needs at least one collection id");
  }
  if (appliesTo === "products" && productIds.length === 0) {
    throw new Error("cap_config appliesTo 'products' needs at least one product id");
  }

  return {
    version: CAP_CONFIG_VERSION,
    percentage: input.percentage,
    capAmount: toDecimalString(input.capMinor),
    currencyCode: input.currencyCode,
    scope: CAP_CONFIG_SCOPE,
    checkoutNote: normaliseCheckoutNote(input.checkoutNote),
    code: input.code,
    appliesTo,
    collectionIds,
    productIds,
  };
}

/**
 * The note as it is stored and shown: trimmed, collapsed, and cut to the
 * length the buyer-facing line can carry. An empty note is the locked default
 * rather than nothing — a capped discount with no explanation beside it is the
 * surprise MaxOff exists to prevent.
 */
export function normaliseCheckoutNote(note: string | null | undefined): string {
  const cleaned = (note ?? "").replace(/\s+/g, " ").trim();
  return cleaned === ""
    ? DEFAULT_CHECKOUT_NOTE
    : cleaned.slice(0, CHECKOUT_NOTE_MAX_LENGTH);
}

/** Unique, non-empty GIDs in the order the merchant picked them. */
function cleanIds(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter((id) => id !== ""))];
}

/** The metafield as `discountCodeAppCreate` takes it, inline on create. */
export function capConfigMetafield(input: CapConfigInput) {
  return {
    namespace: CAP_CONFIG_NAMESPACE,
    key: CAP_CONFIG_KEY,
    type: CAP_CONFIG_TYPE,
    value: JSON.stringify(buildCapConfig(input)),
  };
}

/**
 * Read a `capAmount` string back to minor units — the other direction of the
 * round trip, used by the test and by anything that reads a discount back from
 * Shopify.
 */
export function capAmountToMinor(capAmount: string): number | null {
  return parseDecimalToMinor(capAmount);
}
