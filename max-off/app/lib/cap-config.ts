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
 * - `scope` present and not one of "order", "item", "collection"
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
import { isRoundingMode, toRoundingMode } from "./rounding";
import type { RoundingMode } from "./rounding";

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
 * puts in front of the buyer. Version 3 adds `scope`, the Pro per-item and
 * per-collection maximums. Version 4 adds the minimum a cart must meet and a
 * maximum per market currency. Version 5 adds the shop's `rounding` rule from
 * Settings. The deployed Function still reads versions 1 and 2,
 * because discounts created before each of them are live and carry them — see
 * `SUPPORTED_VERSIONS` in the Function's parser.
 *
 * **Bumping this number is a deploy, not an edit.** A config the deployed
 * Function does not list in `SUPPORTED_VERSIONS` is refused outright, so an
 * admin that writes version 5 against a Function that only knows 4 creates
 * discounts that silently do not discount. Ship both halves together.
 */
export const CAP_CONFIG_VERSION = 5;

/**
 * Which maximum the merchant chose.
 *
 * - `order`      one maximum across everything the discount applies to.
 * - `item`       a separate maximum on each eligible line.
 * - `collection` a separate maximum per targeted collection.
 *
 * The last two are Pro. That is an entitlement, checked in `plans.ts` and
 * enforced in `discount-form.ts`, and deliberately not a rule this module
 * knows: a config builder that refused a scope on plan grounds would be a
 * second definition of the plan ladder, and the one that runs last rather than
 * the one a merchant sees.
 */
export type CapScope = "order" | "item" | "collection";

export const CAP_SCOPES: readonly CapScope[] = ["order", "item", "collection"];

export function isCapScope(value: unknown): value is CapScope {
  return (CAP_SCOPES as readonly unknown[]).includes(value);
}

/** What a discount caps when the merchant has not chosen, and all V1 did. */
export const DEFAULT_CAP_SCOPE: CapScope = "order";

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
  /** The least the eligible cart must come to, in minor units. Null is none. */
  minSubtotalMinor?: number | null;
  /** The least number of eligible items. Null is none. */
  minQuantity?: number | null;
  /**
   * A maximum per market currency, in minor units, keyed by ISO code.
   *
   * Rule 5 is why this is a map the merchant fills in rather than a rate: a
   * 150 maximum is 150 in whatever the buyer pays in, and the only honest way
   * to charge a different number in EUR is for the merchant to say so. The
   * store's own currency needs no entry — that is `capMinor`.
   */
  capsByCurrency?: Record<string, number>;
  currencyCode: string;
  /**
   * How the final amount is rounded. The shop's Settings choice, stamped onto
   * each discount because the Function has no way to read a shop-level row —
   * it sees the discount's own metafield and nothing else.
   */
  rounding?: RoundingMode;
  /** Null for an automatic discount, which has no code to show the buyer. */
  code: string | null;
  checkoutNote?: string;
  scope?: CapScope;
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
  scope: CapScope;
  /** Always written, so what a discount rounds to is readable off the config. */
  rounding: RoundingMode;
  checkoutNote: string;
  code: string | null;
  /** Absent rather than null when there is no minimum, so an older Function
   *  reading this config sees exactly the shape it saw before. */
  minSubtotal?: string;
  minQuantity?: number;
  capsByCurrency?: Record<string, string>;
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

  const scope = input.scope ?? DEFAULT_CAP_SCOPE;
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

  // A maximum *per collection* needs collections to divide the cart into. The
  // Function refuses this pairing, so refusing it here keeps the two halves of
  // the contract saying the same thing — and says it where a merchant can
  // still change the answer.
  if (scope === "collection" && appliesTo !== "collections") {
    throw new Error(
      "cap_config scope 'collection' needs a discount that applies to collections",
    );
  }

  const minSubtotalMinor = input.minSubtotalMinor ?? null;
  if (minSubtotalMinor !== null && (!Number.isInteger(minSubtotalMinor) || minSubtotalMinor < 1)) {
    throw new Error(
      `cap_config minSubtotalMinor must be a positive whole number of minor units, got ${minSubtotalMinor}`,
    );
  }

  const minQuantity = input.minQuantity ?? null;
  if (minQuantity !== null && (!Number.isInteger(minQuantity) || minQuantity < 1)) {
    throw new Error(
      `cap_config minQuantity must be a positive whole number, got ${minQuantity}`,
    );
  }

  const capsByCurrency = cleanCaps(input.capsByCurrency, input.currencyCode);

  return {
    version: CAP_CONFIG_VERSION,
    percentage: input.percentage,
    capAmount: toDecimalString(input.capMinor),
    currencyCode: input.currencyCode,
    scope,
    rounding: toRoundingMode(input.rounding),
    checkoutNote: normaliseCheckoutNote(input.checkoutNote),
    code: input.code,
    // Omitted entirely when unset. The Function reads an absent key as "no
    // minimum", which is what every config before version 4 meant, so writing
    // an explicit null would be a second way of saying the same thing.
    ...(minSubtotalMinor === null ? {} : {minSubtotal: toDecimalString(minSubtotalMinor)}),
    ...(minQuantity === null ? {} : {minQuantity}),
    ...(Object.keys(capsByCurrency).length === 0 ? {} : {capsByCurrency}),
    appliesTo,
    collectionIds,
    productIds,
  };
}

/**
 * The per-currency maximums as the Function reads them: upper-case ISO codes
 * against major-unit decimal strings.
 *
 * The store's own currency is dropped rather than written, because that is
 * what `capAmount` already is — two places to state the same maximum is one
 * place for them to disagree.
 */
function cleanCaps(
  caps: Record<string, number> | undefined,
  storeCurrency: string,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [code, minor] of Object.entries(caps ?? {})) {
    const iso = code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(iso) || iso === storeCurrency.trim().toUpperCase()) {
      continue;
    }

    if (!Number.isInteger(minor) || minor < 1) {
      throw new Error(
        `cap_config maximum for ${iso} must be a positive whole number of minor units, got ${minor}`,
      );
    }

    out[iso] = toDecimalString(minor);
  }

  return out;
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

/* ------------------------------- reading one back ------------------------- */

/**
 * Why a `cap_config` could not be read.
 *
 * Each value is a different fix, so they stay apart rather than collapsing
 * into one "invalid": `missing` means the discount has no config at all (it
 * was created outside MaxOff, or the metafield was deleted), `unreadable`
 * means it is there but not the shape we write, and `unsupported-version`
 * means it was written by a newer MaxOff than this one.
 */
export type CapConfigProblem = "missing" | "unreadable" | "unsupported-version";

export type CapConfigRead =
  | { ok: true; config: CapConfigJson }
  | { ok: false; problem: CapConfigProblem; version: number | null };

/**
 * Parse a `cap_config` metafield value read back from Shopify.
 *
 * Strict on purpose. The detail screen shows a merchant the percentage and the
 * maximum that are *in force*, and the only copy of those in force is this
 * metafield — the Function reads nothing else. Falling back to our Prisma
 * mirror when the config will not parse would print a maximum that is not the
 * one being applied at checkout, which is the single worst thing this screen
 * could do. So a config that does not parse is an error state, never a
 * default.
 *
 * `capAmount` is validated by converting it: a string that is not a decimal
 * amount comes back null from `capAmountToMinor`, and a config whose maximum
 * cannot be read is not a config.
 */
export function parseCapConfig(value: unknown): CapConfigRead {
  if (value === null || value === undefined) {
    return { ok: false, problem: "missing", version: null };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "unreadable", version: null };
  }

  const raw = value as Record<string, unknown>;
  const version = typeof raw.version === "number" ? raw.version : null;

  if (version === null) {
    return { ok: false, problem: "unreadable", version: null };
  }

  // Newer than we know how to read. Not corrupt — just not ours to interpret,
  // and guessing at a shape we have never seen is how a wrong maximum gets
  // printed with total confidence.
  if (version > CAP_CONFIG_VERSION) {
    return { ok: false, problem: "unsupported-version", version };
  }

  const percentage = raw.percentage;
  const capAmount = raw.capAmount;

  if (
    typeof percentage !== "number" ||
    !Number.isFinite(percentage) ||
    typeof capAmount !== "string" ||
    capAmountToMinor(capAmount) === null ||
    typeof raw.currencyCode !== "string" ||
    raw.currencyCode === ""
  ) {
    return { ok: false, problem: "unreadable", version };
  }

  const strings = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter((entry): entry is string => typeof entry === "string")
      : [];

  // Every field below this line has a defined meaning when absent, because
  // versions 1 and 2 are still live on real discounts and simply do not carry
  // them. Their defaults are the behaviour those versions had.
  return {
    ok: true,
    config: {
      version,
      percentage,
      capAmount,
      currencyCode: raw.currencyCode,
      scope: isCapScope(raw.scope) ? raw.scope : DEFAULT_CAP_SCOPE,
      rounding: isRoundingMode(raw.rounding) ? raw.rounding : "cent",
      checkoutNote:
        typeof raw.checkoutNote === "string" && raw.checkoutNote !== ""
          ? raw.checkoutNote
          : DEFAULT_CHECKOUT_NOTE,
      code: typeof raw.code === "string" ? raw.code : null,
      appliesTo: isAppliesTo(raw.appliesTo) ? raw.appliesTo : "all",
      collectionIds: strings(raw.collectionIds),
      productIds: strings(raw.productIds),
      ...(typeof raw.minSubtotal === "string" && raw.minSubtotal !== ""
        ? { minSubtotal: raw.minSubtotal }
        : {}),
      ...(typeof raw.minQuantity === "number" ? { minQuantity: raw.minQuantity } : {}),
      ...(typeof raw.capsByCurrency === "object" && raw.capsByCurrency !== null
        ? {
            capsByCurrency: Object.fromEntries(
              Object.entries(raw.capsByCurrency as Record<string, unknown>).flatMap(
                ([code, amount]) =>
                  typeof amount === "string" ? [[code, amount] as const] : [],
              ),
            ),
          }
        : {}),
    },
  };
}
