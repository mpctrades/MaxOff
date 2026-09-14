import {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  DiscountClass,
  OrderDiscountSelectionStrategy,
} from '../generated/api';
import {capDiscount, formatMoney, parseDecimalToMinor, toDecimalString} from './cap';
import {parseCapConfig} from './cap_config';
import type {CapConfig} from './cap_config';

/**
 * The Discount Function API has no "percentage with a maximum" value, so MaxOff
 * does the min() itself and emits the result as a fixed amount. Below the break
 * even point that fixed amount is exactly the percentage; above it, it stops at
 * the cap. It is recomputed on every checkout, so it is not the same thing as a
 * native fixed-amount discount.
 *
 * The percentage, the maximum, which lines they apply to and the buyer-facing
 * note all come from the discount's own `cap_config` metafield (see
 * `cap_config.ts`). There are no numbers in this file.
 */
export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  // Only return operations for a discount class this discount actually has.
  if (!input.discount.discountClasses.includes(DiscountClass.Order)) {
    return {operations: []};
  }

  // No config, or config we cannot read, means no discount — never an uncapped one.
  const config = parseCapConfig(input.discount.metafield?.jsonValue);
  if (config === null) {
    return {operations: []};
  }

  const {currencyCode} = input.cart.cost.subtotalAmount;

  const basis = discountBasis(input, config);
  if (basis === null) {
    // A subtotal we cannot read is never an uncapped discount.
    return {operations: []};
  }

  const {uncappedMinor, givenMinor} = capDiscount(
    basis.subtotalMinor,
    config.percentage,
    config.capMinor,
  );
  if (givenMinor <= 0) {
    return {operations: []};
  }

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: buildMessage(config, currencyCode, uncappedMinor > givenMinor),
              // `excludedCartLineIds` is how a whole-order discount is narrowed
              // to some of the cart. The alternative — a PRODUCT-class discount
              // with one candidate per line — would split MaxOff's single
              // maximum into one maximum per line, which is the PRO "Each item"
              // behaviour and not what this discount promises.
              targets: [{orderSubtotal: {excludedCartLineIds: basis.excludedCartLineIds}}],
              value: {fixedAmount: {amount: toDecimalString(givenMinor)}},
            },
          ],
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}

interface DiscountBasis {
  /** The amount the percentage is taken on, in minor units. */
  subtotalMinor: number;
  /** The lines the discount must not touch. Empty when it applies to all. */
  excludedCartLineIds: string[];
}

/**
 * What the percentage is taken on, and which lines are left out.
 *
 * For a discount that applies to everything this is the cart's own
 * `subtotalAmount`, unchanged from the version that shipped in week 1 — the
 * figure Shopify gives us directly, and the one BUILD-SPEC §3.2's open question
 * about line-level discounts is written against. Summing the lines instead
 * would quietly change that answer for every existing discount.
 *
 * For a targeted discount there is no such figure, so the eligible lines are
 * summed. The two can differ, and the difference is exactly the lines nobody
 * is discounting.
 */
function discountBasis(input: CartInput, config: CapConfig): DiscountBasis | null {
  if (config.appliesTo === 'all') {
    const subtotalMinor = parseDecimalToMinor(input.cart.cost.subtotalAmount.amount);
    return subtotalMinor === null ? null : {subtotalMinor, excludedCartLineIds: []};
  }

  let subtotalMinor = 0;
  const excludedCartLineIds: string[] = [];

  for (const line of input.cart.lines) {
    if (!isEligible(line, config)) {
      excludedCartLineIds.push(line.id);
      continue;
    }

    const lineMinor = parseDecimalToMinor(line.cost.subtotalAmount.amount);
    if (lineMinor === null) {
      // One unreadable line would make the basis wrong rather than merely
      // smaller, and a wrong basis is a wrong discount. Refuse the lot.
      return null;
    }

    subtotalMinor += lineMinor;
  }

  return {subtotalMinor, excludedCartLineIds};
}

/**
 * Whether one cart line is in the set the merchant chose.
 *
 * Collections are already decided: `inAnyCollection` was evaluated by Shopify
 * against the `$collectionIds` variable before this code ran. Products are
 * matched here, against the ids in the config.
 *
 * Anything that is not a product variant — a custom line added by another app,
 * for instance — has no product to match and is never eligible. Guessing it in
 * would take the percentage on merchandise the merchant did not choose.
 */
function isEligible(line: CartInput['cart']['lines'][number], config: CapConfig): boolean {
  const merchandise = line.merchandise;
  if (merchandise.__typename !== 'ProductVariant') {
    return false;
  }

  const product = merchandise.product;

  if (config.appliesTo === 'collections') {
    return product.inAnyCollection;
  }

  return config.productIds.includes(product.id);
}

/**
 * `SUMMER15 — 15% off (max 150.00 USD)`, or the same line without the prefix
 * when the discount has no code — an automatic discount, or one created before
 * the code was recorded.
 *
 * When the maximum is what decided the amount, the merchant's checkout note is
 * appended, because that is the moment the buyer is owed an explanation: the
 * percentage they were promised is not the number they are seeing. Below the
 * cap the note would be untrue, so it is left off.
 *
 * The currency label is the cart's, not the config's: a 150 maximum is 150 in
 * whatever currency the buyer is paying in. Amounts relabel, they never convert.
 */
function buildMessage(config: CapConfig, currencyCode: string, capped: boolean): string {
  const rule = `${config.percentage}% off (max ${formatMoney(config.capMinor)} ${currencyCode})`;
  const line = config.code === null ? rule : `${config.code} — ${rule}`;

  return capped ? `${line} · ${config.checkoutNote}` : line;
}
