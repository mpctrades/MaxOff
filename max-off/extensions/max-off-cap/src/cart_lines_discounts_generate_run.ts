import {
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  DiscountClass,
  OrderDiscountSelectionStrategy,
  ProductDiscountSelectionStrategy,
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
 *
 * ## One formula, three groupings
 *
 * The arithmetic never changes — `min(basis × percentage, cap)` — only what a
 * "basis" is:
 *
 * | scope        | one maximum per…      | emitted as                        |
 * |--------------|-----------------------|-----------------------------------|
 * | `order`      | the whole order       | one ORDER candidate               |
 * | `item`       | each eligible line    | one PRODUCT candidate per line    |
 * | `collection` | each targeted collection | one PRODUCT candidate per group |
 *
 * `order` is a single order-level amount, so it is the one scope an ORDER
 * class discount can express. The other two hand out several amounts at once,
 * which only the PRODUCT class can carry — an order discount has exactly one
 * value and would collapse the separate maximums back into one. That is why
 * the class a discount is created with depends on its scope, and why the guard
 * below asks for a different class per scope rather than always for ORDER.
 */
export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  // No config, or config we cannot read, means no discount — never an uncapped one.
  const config = parseCapConfig(input.discount.metafield?.jsonValue);
  if (config === null) {
    return {operations: []};
  }

  // Only return operations for a discount class this discount actually has.
  // Which class that is depends on the scope, per the table above.
  const required =
    config.scope === 'order' ? DiscountClass.Order : DiscountClass.Product;
  if (!input.discount.discountClasses.includes(required)) {
    return {operations: []};
  }

  const {currencyCode} = input.cart.cost.subtotalAmount;

  return config.scope === 'order'
    ? orderScopeResult(input, config, currencyCode)
    : perGroupResult(input, config, currencyCode);
}

/* ------------------------------------------------------------------ order */

/**
 * One maximum across everything the discount applies to — the scope MaxOff
 * shipped with, unchanged.
 */
function orderScopeResult(
  input: CartInput,
  config: CapConfig,
  currencyCode: string,
): CartLinesDiscountsGenerateRunResult {
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
              // maximum into one maximum per line, which is exactly the `item`
              // scope below and not what this one promises.
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

/* --------------------------------------------------- item and collection */

/** Lines that share one maximum, and the ids the candidate targets. */
interface CapGroup {
  /** What the percentage is taken on, in minor units. */
  subtotalMinor: number;
  /** The cart lines this maximum is spread across. Never empty. */
  cartLineIds: string[];
}

/**
 * The scopes that hand out several maximums at once.
 *
 * Both reduce to the same shape — a list of groups, each with its own basis —
 * so the cap arithmetic and the candidate building are written once. `item`
 * makes one group per eligible line; `collection` makes one per targeted
 * collection. Everything after that is identical.
 *
 * `ALL` is the selection strategy, not `FIRST`: every group's maximum is meant
 * to apply, and `FIRST` would hand out one of them and drop the rest — a
 * per-item maximum that discounts a single item.
 */
function perGroupResult(
  input: CartInput,
  config: CapConfig,
  currencyCode: string,
): CartLinesDiscountsGenerateRunResult {
  const groups =
    config.scope === 'item' ? itemGroups(input, config) : collectionGroups(input, config);
  if (groups === null) {
    return {operations: []};
  }

  const candidates = [];
  for (const group of groups) {
    const {uncappedMinor, givenMinor} = capDiscount(
      group.subtotalMinor,
      config.percentage,
      config.capMinor,
    );
    if (givenMinor <= 0) {
      continue;
    }

    candidates.push({
      message: buildMessage(config, currencyCode, uncappedMinor > givenMinor),
      // `appliesToEachItem` is left at its default of false, so the amount is
      // applied once across the group rather than once per unit in it. That is
      // what makes this a maximum on the line — or on the collection — and not
      // a maximum multiplied by the quantity in the cart.
      targets: group.cartLineIds.map((id) => ({cartLine: {id}})),
      value: {fixedAmount: {amount: toDecimalString(givenMinor)}},
    });
  }

  if (candidates.length === 0) {
    return {operations: []};
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}

/**
 * One group per eligible cart line: "a separate maximum on every line".
 *
 * A line whose amount cannot be read makes the whole discount refuse rather
 * than merely losing that line. A cart where one item is silently left out of
 * a per-item discount is harder for a merchant to notice than one where the
 * discount does not appear at all, and the rule this Function is built on is
 * that what we cannot read with certainty gets no discount.
 */
function itemGroups(input: CartInput, config: CapConfig): CapGroup[] | null {
  const groups: CapGroup[] = [];

  for (const line of input.cart.lines) {
    if (!isEligible(line, config)) {
      continue;
    }

    const lineMinor = parseDecimalToMinor(line.cost.subtotalAmount.amount);
    if (lineMinor === null) {
      return null;
    }

    groups.push({subtotalMinor: lineMinor, cartLineIds: [line.id]});
  }

  return groups;
}

/**
 * One group per targeted collection: "a separate maximum per collection".
 *
 * A product can sit in more than one of the collections the merchant chose. It
 * is counted against the **first** of them in the merchant's own order, so
 * every line belongs to exactly one group — a line in two groups would be
 * discounted twice, and a cart could take more off than either maximum allows.
 * `config.collectionIds` preserves that order, which is why the grouping reads
 * it rather than the membership list Shopify returns.
 *
 * Collections with nothing in the cart produce no group, and so no candidate.
 */
function collectionGroups(input: CartInput, config: CapConfig): CapGroup[] | null {
  /** Collection id → its group, created on first use so empty ones are absent. */
  const byCollection = new Map<string, CapGroup>();

  for (const line of input.cart.lines) {
    if (!isEligible(line, config)) {
      continue;
    }

    const collectionId = firstMatchingCollection(line, config);
    if (collectionId === null) {
      // Eligible by `inAnyCollection` but in none of the collections we asked
      // `inCollections` about is a contradiction, and a line we cannot place
      // in a group has no maximum to be measured against.
      return null;
    }

    const lineMinor = parseDecimalToMinor(line.cost.subtotalAmount.amount);
    if (lineMinor === null) {
      return null;
    }

    const group = byCollection.get(collectionId);
    if (group === undefined) {
      byCollection.set(collectionId, {
        subtotalMinor: lineMinor,
        cartLineIds: [line.id],
      });
    } else {
      group.subtotalMinor += lineMinor;
      group.cartLineIds.push(line.id);
    }
  }

  // Emitted in the merchant's chosen order rather than cart order, so the
  // candidates a merchant sees line up with the list they picked.
  const groups: CapGroup[] = [];
  for (const collectionId of config.collectionIds) {
    const group = byCollection.get(collectionId);
    if (group !== undefined) {
      groups.push(group);
    }
  }

  return groups;
}

/**
 * The first collection, in the merchant's order, that this line's product is
 * in. Null when it is in none of them.
 */
function firstMatchingCollection(
  line: CartInput['cart']['lines'][number],
  config: CapConfig,
): string | null {
  const merchandise = line.merchandise;
  if (merchandise.__typename !== 'ProductVariant') {
    return null;
  }

  const memberships = merchandise.product.inCollections;

  for (const collectionId of config.collectionIds) {
    const membership = memberships.find((entry) => entry.collectionId === collectionId);
    if (membership !== undefined && membership.isMember) {
      return collectionId;
    }
  }

  return null;
}

/* ----------------------------------------------------------- shared parts */

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
 *
 * Only the `order` scope uses this: the other two have a basis per group and
 * never need a cart-wide figure or an exclusion list.
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
 * A discount that applies to everything takes every line, including one that
 * is not a product variant — a custom line added by another app, say. That is
 * what "all" means, and it is the same set the `order` scope already discounts
 * through the cart's own subtotal, which counts those lines too.
 *
 * A *targeted* discount is the opposite: a line with no product cannot be
 * matched against a chosen product or collection, so it is never eligible.
 * Guessing it in would take the percentage on merchandise the merchant did not
 * choose.
 */
function isEligible(line: CartInput['cart']['lines'][number], config: CapConfig): boolean {
  const merchandise = line.merchandise;
  if (merchandise.__typename !== 'ProductVariant') {
    return false;
  }

  const product = merchandise.product;

  if (config.appliesTo === 'all') {
    return true;
  }

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
 * cap the note would be untrue, so it is left off. Under the per-item and
 * per-collection scopes that judgement is made per candidate, so a buyer sees
 * the note beside the lines that actually hit the maximum and not beside the
 * ones that did not.
 *
 * The currency label is the cart's, not the config's: a 150 maximum is 150 in
 * whatever currency the buyer is paying in. Amounts relabel, they never convert.
 */
function buildMessage(config: CapConfig, currencyCode: string, capped: boolean): string {
  const rule = `${config.percentage}% off (max ${formatMoney(config.capMinor)} ${currencyCode})`;
  const line = config.code === null ? rule : `${config.code} — ${rule}`;

  return capped ? `${line} · ${config.checkoutNote}` : line;
}
