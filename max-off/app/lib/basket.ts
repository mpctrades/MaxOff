/**
 * The cart tester's basket: pure functions over a list of lines.
 *
 * Kept out of the route so the numbers behind BUILD-SPEC §4.6 can be tested
 * without a browser. Money is minor units throughout; the only conversion is
 * at the edge, where the resource picker hands us a `Money` (a decimal string
 * such as "620.00") and `parseDecimalToMinor` reads it.
 */

import { parseDecimalToMinor } from "./cap";

export interface BasketLine {
  /** The variant's gid — the identity of a line. */
  variantId: string;
  title: string;
  unitPriceMinor: number;
  quantity: number;
  imageSrc?: string;
  imageAlt?: string;
}

/** Quantity stays at or above one; a line is removed explicitly, not by decrementing to nothing. */
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 999;

export function lineTotalMinor(line: BasketLine): number {
  return line.unitPriceMinor * line.quantity;
}

export function basketSubtotalMinor(lines: BasketLine[]): number {
  return lines.reduce((total, line) => total + lineTotalMinor(line), 0);
}

/**
 * A picked variant, in the shape the App Bridge resource picker returns:
 * `price` is a `Money`, which is a decimal string, and the image is optional.
 */
export interface PickedVariant {
  id: string;
  displayName?: string;
  title?: string;
  price?: string;
  image?: { originalSrc?: string; url?: string; altText?: string | null } | null;
}

/**
 * Turn picked variants into lines, merging with what is already in the basket:
 * picking the same variant twice adds to its quantity rather than adding a
 * second identical row.
 *
 * A variant whose price we cannot read is skipped — a line with an unknown
 * price would silently make the whole subtotal wrong.
 */
export function addPickedVariants(
  lines: BasketLine[],
  picked: PickedVariant[],
): BasketLine[] {
  const next = [...lines];

  for (const variant of picked) {
    const unitPriceMinor = parseDecimalToMinor(variant.price ?? "");
    if (unitPriceMinor === null) {
      continue;
    }

    const existing = next.findIndex((line) => line.variantId === variant.id);
    if (existing !== -1) {
      next[existing] = {
        ...next[existing],
        quantity: clampQuantity(next[existing].quantity + 1),
      };
      continue;
    }

    next.push({
      variantId: variant.id,
      title: variant.displayName || variant.title || "Product",
      unitPriceMinor,
      quantity: MIN_QUANTITY,
      imageSrc: variant.image?.originalSrc ?? variant.image?.url,
      imageAlt: variant.image?.altText ?? undefined,
    });
  }

  return next;
}

export function setLineQuantity(
  lines: BasketLine[],
  variantId: string,
  quantity: number,
): BasketLine[] {
  return lines.map((line) =>
    line.variantId === variantId
      ? { ...line, quantity: clampQuantity(quantity) }
      : line,
  );
}

export function removeLine(lines: BasketLine[], variantId: string): BasketLine[] {
  return lines.filter((line) => line.variantId !== variantId);
}

/** A quantity we cannot read stays at one rather than becoming NaN. */
export function clampQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) {
    return MIN_QUANTITY;
  }

  return Math.min(Math.max(Math.trunc(quantity), MIN_QUANTITY), MAX_QUANTITY);
}
