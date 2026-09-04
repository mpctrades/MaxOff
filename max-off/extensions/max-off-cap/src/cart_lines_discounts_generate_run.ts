import {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  DiscountClass,
  OrderDiscountSelectionStrategy,
} from '../generated/api';
import {capDiscount, formatMoney, parseDecimalToMinor, toDecimalString} from './cap';

/**
 * Gate 1 hard-codes the cap. Gate 2 moves it to the discount's
 * `$app:maxoff/cap_config` metafield; until then these two constants are the
 * only configuration the Function has.
 */
const PERCENTAGE = 15;
const CAP_MINOR = 15_000; // 150.00

/**
 * The Discount Function API has no "percentage with a maximum" value, so MaxOff
 * does the min() itself and emits the result as a fixed amount. Below the break
 * even point that fixed amount is exactly the percentage; above it, it stops at
 * the cap. It is recomputed on every checkout, so it is not the same thing as a
 * native fixed-amount discount.
 */
export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  // Only return operations for a discount class this discount actually has.
  if (!input.discount.discountClasses.includes(DiscountClass.Order)) {
    return {operations: []};
  }

  const {amount, currencyCode} = input.cart.cost.subtotalAmount;

  const subtotalMinor = parseDecimalToMinor(amount);
  if (subtotalMinor === null) {
    // A subtotal we cannot read is never an uncapped discount.
    return {operations: []};
  }

  const {givenMinor} = capDiscount(subtotalMinor, PERCENTAGE, CAP_MINOR);
  if (givenMinor <= 0) {
    return {operations: []};
  }

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: `${PERCENTAGE}% off (max ${formatMoney(CAP_MINOR)} ${currencyCode})`,
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
