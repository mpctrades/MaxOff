import {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  DiscountClass,
  OrderDiscountSelectionStrategy,
} from '../generated/api';
import {capDiscount, formatMoney, parseDecimalToMinor, toDecimalString} from './cap';
import {parseCapConfig} from './cap_config';

/**
 * The Discount Function API has no "percentage with a maximum" value, so MaxOff
 * does the min() itself and emits the result as a fixed amount. Below the break
 * even point that fixed amount is exactly the percentage; above it, it stops at
 * the cap. It is recomputed on every checkout, so it is not the same thing as a
 * native fixed-amount discount.
 *
 * The percentage and the maximum come from the discount's own `cap_config`
 * metafield (see `cap_config.ts`). There are no numbers in this file.
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

  const {amount, currencyCode} = input.cart.cost.subtotalAmount;

  const subtotalMinor = parseDecimalToMinor(amount);
  if (subtotalMinor === null) {
    // A subtotal we cannot read is never an uncapped discount.
    return {operations: []};
  }

  const {givenMinor} = capDiscount(subtotalMinor, config.percentage, config.capMinor);
  if (givenMinor <= 0) {
    return {operations: []};
  }

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: buildMessage(config.code, config.percentage, config.capMinor, currencyCode),
              targets: [{orderSubtotal: {excludedCartLineIds: []}}],
              value: {fixedAmount: {amount: toDecimalString(givenMinor)}},
            },
          ],
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}

/**
 * `SUMMER15 — 15% off (max 150.00 USD)`, or the same line without the prefix
 * when the discount has no code recorded.
 *
 * The currency label is the cart's, not the config's: a 150 maximum is 150 in
 * whatever currency the buyer is paying in. Amounts relabel, they never convert.
 */
function buildMessage(
  code: string | null,
  percentage: number,
  capMinor: number,
  currencyCode: string,
): string {
  const rule = `${percentage}% off (max ${formatMoney(capMinor)} ${currencyCode})`;
  return code === null ? rule : `${code} — ${rule}`;
}
