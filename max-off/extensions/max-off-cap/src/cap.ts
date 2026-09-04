/**
 * The MaxOff cap arithmetic.
 *
 *     given = min(subtotal * percentage / 100, cap)
 *
 * Money is integers of minor units (cents) throughout. Shopify hands the
 * Function a `Decimal` scalar, which arrives as a string such as "1400.00", so
 * the string is parsed straight to an integer here and never becomes a float.
 * Formatting happens only at the edge, when the amount goes back to Shopify or
 * into the buyer-facing message.
 */

/** Minor units per major unit. Section 6 of the spec fixes money at two decimals. */
const MINOR_UNITS = 100;

/**
 * Longest whole part we accept. 10^13 major units still multiplies by 100 and
 * then by a percentage without leaving the exact-integer range of a JS number,
 * and no real cart comes close.
 */
const MAX_WHOLE_DIGITS = 13;

export interface CapResult {
  /** What the raw percentage would have given, in minor units. */
  uncappedMinor: number;
  /** What MaxOff actually gives, in minor units. */
  givenMinor: number;
  /** The difference the merchant keeps, in minor units. */
  keptMinor: number;
}

/**
 * Parse a Shopify `Decimal` string into minor units.
 *
 * Returns null for anything we cannot read with certainty — a negative amount,
 * a malformed string, a number too large to stay exact. Every caller treats
 * null as "apply no discount", never as "apply an uncapped one".
 */
export function parseDecimalToMinor(value: string): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const whole = match[1];
  const fraction = match[2] ?? '';
  if (whole.length > MAX_WHOLE_DIGITS) {
    return null;
  }

  const cents = `${fraction}00`.slice(0, 2);
  const belowTheCent = fraction.slice(2);

  let minor = Number(whole) * MINOR_UNITS + Number(cents);
  // Half-up on anything finer than a cent: "0.005" is a cent, "0.004" is not.
  if (belowTheCent >= '5') {
    minor += 1;
  }

  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Apply the cap. `percentage` is a whole percent (1-100) and `capMinor` is the
 * maximum discount in minor units. Both are integers, so the whole calculation
 * is integer arithmetic with a single half-up rounding at the end.
 */
export function capDiscount(
  subtotalMinor: number,
  percentage: number,
  capMinor: number,
): CapResult {
  const uncappedMinor = roundHalfUp(subtotalMinor * percentage, 100);
  const givenMinor = Math.min(uncappedMinor, capMinor);

  return {
    uncappedMinor,
    givenMinor,
    keptMinor: uncappedMinor - givenMinor,
  };
}

/**
 * Minor units as a plain `Decimal` string, e.g. 150000 -> "1500.00". This is
 * the wire format Shopify expects; it must never carry thousands separators.
 */
export function toDecimalString(minor: number): string {
  const whole = Math.floor(minor / MINOR_UNITS);
  const cents = minor % MINOR_UNITS;
  return `${whole}.${String(cents).padStart(2, '0')}`;
}

/**
 * Minor units as merchant- and buyer-facing money, e.g. 150000 -> "1,500.00".
 * Grouping is done by hand because `Intl` is not available in the Function
 * runtime. The caller appends the currency code.
 */
export function formatMoney(minor: number): string {
  const [whole, cents] = toDecimalString(minor).split('.');
  return `${groupThousands(whole)}.${cents}`;
}

function roundHalfUp(numerator: number, denominator: number): number {
  // Every value here is non-negative, so floor and truncate agree.
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

function groupThousands(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) {
      out += ',';
    }
    out += digits[i];
  }
  return out;
}
