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
 */

import {parseDecimalToMinor} from './cap';

/** The app-reserved namespace. `$app` resolves to this app and no other. */
export const CAP_CONFIG_NAMESPACE = '$app';
export const CAP_CONFIG_KEY = 'cap_config';

/**
 * The only shape this Function understands. A discount written by a future
 * version of the admin carries a higher number, and this Function refuses it
 * rather than guessing at fields it does not know.
 */
export const CAP_CONFIG_VERSION = 1;

/** V1 caps the whole order. `item` and `collection` scopes are PRO, and unbuilt. */
const SUPPORTED_SCOPE = 'order';

/** Whole percent, as the merchant types it. */
const MIN_PERCENTAGE = 1;
const MAX_PERCENTAGE = 100;

export interface CapConfig {
  /** Whole percent, 1-100. */
  percentage: number;
  /** The maximum discount in minor units, always at least one minor unit. */
  capMinor: number;
  /**
   * The discount code, stored here because the Function's `Discount` type
   * exposes only `discountClasses` and `metafield` — there is no other way for
   * the Function to know the code it is running for. Null for a discount
   * created before the code was recorded.
   */
  code: string | null;
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

  if (config.version !== CAP_CONFIG_VERSION) {
    return null;
  }

  // Scope may be absent (it has one legal value in V1) but never wrong.
  if (config.scope !== undefined && config.scope !== SUPPORTED_SCOPE) {
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

  return {
    percentage,
    capMinor,
    code: readCode(config.code),
  };
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
