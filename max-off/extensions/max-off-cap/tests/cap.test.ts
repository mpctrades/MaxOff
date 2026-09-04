import {describe, expect, test} from 'vitest';
import {capDiscount, formatMoney, parseDecimalToMinor, toDecimalString} from '../src/cap';

/**
 * The cases that must be right, from section 8 of the build spec. Amounts are
 * written the way a merchant would say them; the test converts to minor units
 * so a wrong conversion fails here rather than at a real checkout.
 */
const SPEC_TABLE = [
  {pct: 15, cap: '150.00', subtotal: '1400.00', given: '150.00', kept: '60.00', note: 'above break-even'},
  {pct: 15, cap: '150.00', subtotal: '700.00', given: '105.00', kept: '0.00', note: 'below break-even'},
  {pct: 15, cap: '150.00', subtotal: '1000.00', given: '150.00', kept: '0.00', note: 'exactly at break-even'},
  {pct: 15, cap: '150.00', subtotal: '0.00', given: '0.00', kept: '0.00', note: 'empty cart'},
  {pct: 100, cap: '150.00', subtotal: '200.00', given: '150.00', kept: '50.00', note: '100% discount still capped'},
  {pct: 15, cap: '150.00', subtotal: '33.33', given: '5.00', kept: '0.00', note: 'rounding: 4.9995 -> 5.00'},
  {pct: 1, cap: '150.00', subtotal: '1400.00', given: '14.00', kept: '0.00', note: 'cap never reached'},
  {pct: 15, cap: '0.01', subtotal: '1400.00', given: '0.01', kept: '209.99', note: 'tiny cap'},
];

function minor(amount: string): number {
  const parsed = parseDecimalToMinor(amount);
  if (parsed === null) {
    throw new Error(`test fixture is not a valid decimal: ${amount}`);
  }
  return parsed;
}

describe('capDiscount', () => {
  test.each(SPEC_TABLE)(
    '$pct% capped at $cap on $subtotal gives $given and keeps $kept ($note)',
    ({pct, cap, subtotal, given, kept}) => {
      const result = capDiscount(minor(subtotal), pct, minor(cap));

      expect(toDecimalString(result.givenMinor)).toBe(given);
      expect(toDecimalString(result.keptMinor)).toBe(kept);
    },
  );

  test('the uncapped figure is what the raw percentage would have given', () => {
    const result = capDiscount(minor('1400.00'), 15, minor('150.00'));

    expect(toDecimalString(result.uncappedMinor)).toBe('210.00');
  });

  test('given never exceeds the cap, whatever the cart', () => {
    for (const subtotal of ['999.99', '1000.00', '1000.01', '25000.00']) {
      const result = capDiscount(minor(subtotal), 15, minor('150.00'));

      expect(result.givenMinor).toBeLessThanOrEqual(minor('150.00'));
      expect(result.givenMinor + result.keptMinor).toBe(result.uncappedMinor);
    }
  });
});

describe('parseDecimalToMinor', () => {
  test.each([
    ['1400.00', 140000],
    ['1400', 140000],
    ['1400.5', 140050],
    ['0.01', 1],
    ['0', 0],
    ['33.33', 3333],
  ])('reads %s as %i minor units', (value, expected) => {
    expect(parseDecimalToMinor(value)).toBe(expected);
  });

  test.each([
    ['0.005', 1],
    ['0.0049', 0],
    ['1.994999', 199],
    ['1.995', 200],
  ])('rounds %s half-up to the cent', (value, expected) => {
    expect(parseDecimalToMinor(value)).toBe(expected);
  });

  test.each(['', '-1.00', '1,400.00', 'abc', '1.2.3', '150.00 USD', '1e5'])(
    'refuses %j rather than guessing',
    (value) => {
      expect(parseDecimalToMinor(value)).toBeNull();
    },
  );

  test('refuses an amount too large to stay an exact integer', () => {
    expect(parseDecimalToMinor('99999999999999.00')).toBeNull();
  });
});

describe('formatting', () => {
  test('the wire format carries no thousands separators', () => {
    expect(toDecimalString(150000)).toBe('1500.00');
    expect(toDecimalString(1)).toBe('0.01');
    expect(toDecimalString(0)).toBe('0.00');
  });

  test('the buyer-facing format groups thousands', () => {
    expect(formatMoney(15000)).toBe('150.00');
    expect(formatMoney(150000)).toBe('1,500.00');
    expect(formatMoney(123456789)).toBe('1,234,567.89');
  });
});
