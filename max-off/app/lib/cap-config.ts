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
 * - `version` anything but the number 1
 * - `percentage` not an integer, or outside 1-100
 * - `capAmount` as a JSON number instead of a string
 * - `capAmount` in minor units ("15000" reads as 15,000.00 — a cap 100× too high)
 * - `scope` present and not "order"
 *
 * `app/lib/cap-config.test.ts` round-trips this module's output through the
 * Function's own parser, so a divergence fails a test rather than a checkout.
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

/** The only shape the deployed Function understands. */
export const CAP_CONFIG_VERSION = 1;

/** V1 caps the whole order. `item` and `collection` are PRO, and unbuilt. */
export const CAP_CONFIG_SCOPE = "order";

/** Locked copy, BUILD-SPEC §11. V1 writes it; editing it is V2. */
export const DEFAULT_CHECKOUT_NOTE = "Discount capped at maximum amount";

export interface CapConfigInput {
  percentage: number;
  capMinor: number;
  currencyCode: string;
  code: string;
  checkoutNote?: string;
}

export interface CapConfigJson {
  version: number;
  percentage: number;
  /** A decimal string in **major** units, two decimals. Never a number. */
  capAmount: string;
  currencyCode: string;
  scope: string;
  checkoutNote: string;
  code: string;
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

  return {
    version: CAP_CONFIG_VERSION,
    percentage: input.percentage,
    capAmount: toDecimalString(input.capMinor),
    currencyCode: input.currencyCode,
    scope: CAP_CONFIG_SCOPE,
    checkoutNote: input.checkoutNote?.trim() || DEFAULT_CHECKOUT_NOTE,
    code: input.code,
  };
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
