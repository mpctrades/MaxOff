/**
 * The cap configuration, read from the discount's own metafield.
 *
 * Gate 1 hard-coded 15% / 150.00 in the Function. From Gate 2 the numbers live
 * on the discount in Shopify — namespace `$app`, key `cap_config`, type `json` —
 * written by the admin when the merchant creates the discount, and read back
 * here at checkout without a network call.
 *
 * The single rule this file exists to enforce: **configuration we cannot read
 * with certainty applies no discount at all.** Never an uncapped one. A
 * missing metafield, an unknown version, a percentage outside 1-100, a
 * malformed amount, a scope we do not implement — every one of them returns
 * null, and the Function returns no operations.
 *
 * Version 3 adds `scope`, which chooses between one maximum for the order,
 * one per cart line, and one per targeted collection. See `CapScope`.
 */

import {parseDecimalToMinor} from './cap';

/** The app-reserved namespace. `$app` resolves to this app and no other. */
export const CAP_CONFIG_NAMESPACE = '$app';
export const CAP_CONFIG_KEY = 'cap_config';

/**
 * Every shape this Function understands, oldest first.
 *
 * Version 1 is percentage + cap on the whole cart, and is still live: every
 * discount created before 14 Sep 2026 carries it, and those discounts are
 * running in real checkouts. Refusing them on the day version 2 deploys would
 * silently switch off every capped discount in every installed shop — the
 * exact failure the "refuse what we cannot read" rule exists to prevent, with
 * the blast radius pointed the wrong way.
 *
 * Version 2 adds `appliesTo` with its two id lists, and a `checkoutNote` that
 * reaches the buyer. A version 1 config is read as version 2 with `appliesTo`
 * of "all" and the default note, which is exactly what it meant.
 *
 * Version 3 adds `scope`, the PRO per-item and per-collection maximums. An
 * older config has no scope and is read as `order`, which is the only maximum
 * it could ever have meant — so the same widening rule holds a second time:
 * every live discount keeps working on the day version 3 deploys.
 *
 * Version 4 adds the minimum requirements a cart must meet before any of this
 * applies, and a maximum per market currency. Both are absent from every
 * older config, and absent means "no minimum" and "one maximum in whatever
 * currency the buyer pays in" — which is exactly what those configs meant.
 *
 * A number that is none of them is a discount written by an admin newer than
 * this Function, and is refused rather than guessed at.
 */
export const CAP_CONFIG_VERSION = 4;
const SUPPORTED_VERSIONS = [1, 2, 3, 4];

/**
 * Which maximum the merchant bought.
 *
 * - `order`      one maximum across everything the discount applies to.
 * - `item`       a separate maximum on each eligible cart line.
 * - `collection` a separate maximum per targeted collection.
 *
 * `order` is the only V1 scope and the only one a version 1 or 2 config can
 * mean, so an absent scope reads as `order` exactly as it always did.
 */
export type CapScope = 'order' | 'item' | 'collection';

const CAP_SCOPES: CapScope[] = ['order', 'item', 'collection'];

/** Whole percent, as the merchant types it. */
const MIN_PERCENTAGE = 1;
const MAX_PERCENTAGE = 100;

/** Locked copy, BUILD-SPEC §11, and the fallback for a version 1 config. */
const DEFAULT_CHECKOUT_NOTE = 'Discount capped at maximum amount';

/** Which part of the cart the percentage is taken on. */
export type AppliesTo = 'all' | 'collections' | 'products';

export interface CapConfig {
  /** Whole percent, 1-100. */
  percentage: number;
  /** The maximum discount in minor units, always at least one minor unit. */
  capMinor: number;
  /**
   * The discount code, stored here because the Function's `Discount` type
   * exposes only `discountClasses` and `metafield` — there is no other way for
   * the Function to know the code it is running for. Null for an automatic
   * discount, which has no code, and for a discount created before the code
   * was recorded.
   */
  code: string | null;
  /** The line the buyer reads when the maximum is what decided the amount. */
  checkoutNote: string;
  /** Which cart lines the percentage is taken on. */
  appliesTo: AppliesTo;
  /** Whether the maximum is one per order, per line, or per collection. */
  scope: CapScope;
  /**
   * The chosen product ids, matched against each line's product.
   *
   * Collections are **not** matched here for eligibility: that is resolved by
   * Shopify before the Function runs, through the `$collectionIds` input query
   * variable and `inAnyCollection`, because a Function cannot ask what is in a
   * collection.
   */
  productIds: string[];
  /**
   * The least the eligible part of the cart must come to before any discount
   * applies, in minor units. Null is no minimum.
   */
  minSubtotalMinor: number | null;
  /** The least number of eligible items required. Null is no minimum. */
  minQuantity: number | null;
  /**
   * A maximum per market currency, in minor units, keyed by ISO code.
   *
   * Rule 5 — amounts relabel, they never convert — is why this exists at all:
   * a 150 maximum is 150 in whatever the buyer pays in, and the only honest
   * way to charge a different number in EUR is for the merchant to type that
   * number. Nothing here is converted; a currency with no entry falls back to
   * `capMinor`, which is the relabelling behaviour every earlier version had.
   */
  capsByCurrency: Record<string, number>;
  /**
   * The targeted collection ids, in the order the merchant picked them.
   *
   * Carried only so the `collection` scope can put each line in a group, using
   * the per-collection answers `inCollections` returns. Eligibility never
   * reads this list. The order matters: a product in two targeted collections
   * is counted against the first one the merchant chose, so that every line is
   * discounted once and the grouping does not depend on the order Shopify
   * happens to return memberships in.
   */
  collectionIds: string[];
}

/**
 * Read a `cap_config` metafield value into a `CapConfig`, or null if anything
 * about it is unreadable.
 *
 * The argument is `unknown` on purpose: `jsonValue` is a JSON scalar, so the
 * Function has no type guarantee about what a merchant's store actually holds.
 */
export function parseCapConfig(jsonValue: unknown): CapConfig | null {
  if (typeof jsonValue !== 'object' || jsonValue === null || Array.isArray(jsonValue)) {
    return null;
  }

  const config = jsonValue as Record<string, unknown>;

  if (typeof config.version !== 'number' || !SUPPORTED_VERSIONS.includes(config.version)) {
    return null;
  }

  // Scope may be absent — a version 1 or 2 config has none and meant `order` —
  // but never wrong. A maximum we do not implement must never quietly become
  // a different maximum than the one the merchant configured.
  const scope = readScope(config.scope);
  if (scope === null) {
    return null;
  }

  const percentage = config.percentage;
  if (
    typeof percentage !== 'number' ||
    !Number.isInteger(percentage) ||
    percentage < MIN_PERCENTAGE ||
    percentage > MAX_PERCENTAGE
  ) {
    return null;
  }

  // Money crosses the wire as a decimal string, never as a float.
  if (typeof config.capAmount !== 'string') {
    return null;
  }
  const capMinor = parseDecimalToMinor(config.capAmount);
  if (capMinor === null || capMinor <= 0) {
    return null;
  }

  const appliesTo = readAppliesTo(config.appliesTo);
  if (appliesTo === null) {
    return null;
  }

  const productIds = readIds(config.productIds);
  const collectionIds = readIds(config.collectionIds);

  // A discount that says it targets a set, and names nothing in that set,
  // would take its percentage on a subtotal of zero. That is a discount of
  // nothing, and it is far more likely to be a broken write than an intention.
  if (appliesTo === 'products' && productIds.length === 0) {
    return null;
  }
  if (appliesTo === 'collections' && collectionIds.length === 0) {
    return null;
  }

  // A maximum *per collection* needs collections to divide the cart into. On a
  // discount that applies to everything, or to a hand-picked list of products,
  // there are no groups and no honest reading of "one maximum each" — so it is
  // refused here rather than silently collapsing into one maximum overall,
  // which is a different discount than the merchant configured.
  if (scope === 'collection' && appliesTo !== 'collections') {
    return null;
  }

  // A minimum we cannot read is a gate we cannot enforce, and a discount that
  // ignores its own minimum is worse than one that does not apply.
  const minSubtotalMinor = readOptionalMinor(config.minSubtotal);
  if (minSubtotalMinor === INVALID) {
    return null;
  }

  const minQuantity = readOptionalCount(config.minQuantity);
  if (minQuantity === INVALID) {
    return null;
  }

  const capsByCurrency = readCapsByCurrency(config.capsByCurrency);
  if (capsByCurrency === null) {
    return null;
  }

  return {
    percentage,
    capMinor,
    code: readCode(config.code),
    checkoutNote: readCheckoutNote(config.checkoutNote),
    appliesTo,
    scope,
    productIds,
    collectionIds,
    minSubtotalMinor,
    minQuantity,
    capsByCurrency,
  };
}

/**
 * The maximum that applies to a cart paying in `currencyCode`.
 *
 * The merchant's own number for that currency when they set one, and the base
 * maximum otherwise — relabelled, never converted.
 */
export function capForCurrency(config: CapConfig, currencyCode: string): number {
  const own = config.capsByCurrency[currencyCode.toUpperCase()];
  return own === undefined ? config.capMinor : own;
}

/** Distinguishes "absent, which is fine" from "present and unreadable". */
const INVALID = Symbol('invalid');

/**
 * An optional money amount, as the same major-unit decimal string every other
 * amount crosses the wire as. Absent is null; malformed is refused.
 */
function readOptionalMinor(value: unknown): number | null | typeof INVALID {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    return INVALID;
  }

  const minor = parseDecimalToMinor(value);
  return minor === null || minor <= 0 ? INVALID : minor;
}

/** An optional whole count above zero. Absent is null; malformed is refused. */
function readOptionalCount(value: unknown): number | null | typeof INVALID {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return INVALID;
  }

  return value;
}

/**
 * The per-currency maximums, keyed by upper-case ISO code.
 *
 * Absent is an empty map, which is every version before 4 and means the one
 * maximum applies to every currency. Present and malformed — a key that is not
 * a currency code, an amount that is not a positive decimal string — refuses
 * the whole config rather than silently charging the base maximum in a market
 * the merchant thought they had set.
 */
function readCapsByCurrency(value: unknown): Record<string, number> | null {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const caps: Record<string, number> = {};

  for (const [code, amount] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z]{3}$/.test(code)) {
      return null;
    }

    const minor = readOptionalMinor(amount);
    if (minor === INVALID || minor === null) {
      return null;
    }

    caps[code.toUpperCase()] = minor;
  }

  return caps;
}

/**
 * Absent means `order`, because that is what every version 1 and 2 config
 * meant. Present and unrecognised is refused: a config written by an admin
 * newer than this Function may mean a maximum this code does not implement,
 * and applying the wrong maximum is worse than applying none.
 */
function readScope(value: unknown): CapScope | null {
  if (value === undefined || value === null) {
    return 'order';
  }

  return CAP_SCOPES.includes(value as CapScope) ? (value as CapScope) : null;
}

/**
 * Absent means "all", because that is what every version 1 config meant.
 * Present and unrecognised is refused: a targeting rule we do not implement
 * must never quietly widen to the whole cart.
 */
function readAppliesTo(value: unknown): AppliesTo | null {
  if (value === undefined || value === null) {
    return 'all';
  }

  return value === 'all' || value === 'collections' || value === 'products' ? value : null;
}

/** Non-empty strings only. Anything else in the list is dropped, not fatal. */
function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() !== '') {
      ids.push(entry.trim());
    }
  }

  return ids;
}

/**
 * The code is presentation only — it prefixes the buyer-facing message — so a
 * missing or unusable one degrades to no prefix instead of killing the
 * discount.
 */
function readCode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const code = value.trim();
  return code === '' ? null : code;
}

/** Presentation too, and a version 1 config has none: fall back, never fail. */
function readCheckoutNote(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_CHECKOUT_NOTE;
  }

  const note = value.trim();
  return note === '' ? DEFAULT_CHECKOUT_NOTE : note;
}
