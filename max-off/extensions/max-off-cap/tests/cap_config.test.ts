import {describe, expect, test} from 'vitest';
import {capForCurrency, CAP_CONFIG_VERSION, parseCapConfig} from '../src/cap_config';

/**
 * The rule under test is one sentence: configuration we cannot read with
 * certainty applies NO discount. Every case below that returns null is a
 * checkout where MaxOff stays out of the way — not a checkout where a 15%
 * discount runs uncapped.
 */
const VALID = {
  version: CAP_CONFIG_VERSION,
  percentage: 15,
  capAmount: '150.00',
  currencyCode: 'USD',
  scope: 'order',
  checkoutNote: 'Discount capped at maximum amount',
  code: 'SUMMER15',
  appliesTo: 'all',
  collectionIds: [],
  productIds: [],
};

/** What a fully-read `VALID` becomes, for the cases that assert the whole object. */
const PARSED = {
  percentage: 15,
  capMinor: 15000,
  code: 'SUMMER15',
  checkoutNote: 'Discount capped at maximum amount',
  appliesTo: 'all',
  scope: 'order',
  productIds: [],
  collectionIds: [],
  minSubtotalMinor: null,
  minQuantity: null,
  capsByCurrency: {},
};

/**
 * A discount created before 14 Sep 2026. These are live in real shops, so the
 * Function has to keep reading them — and read them as what they meant: the
 * whole cart, and the locked note.
 */
const VALID_V1 = {
  version: 1,
  percentage: 15,
  capAmount: '150.00',
  currencyCode: 'USD',
  scope: 'order',
  code: 'SUMMER15',
};

function withoutKey(key: string): Record<string, unknown> {
  const config: Record<string, unknown> = {...VALID};
  delete config[key];
  return config;
}

describe('parseCapConfig, on config it can read', () => {
  test('reads the percentage, the maximum in minor units, and the code', () => {
    expect(parseCapConfig(VALID)).toEqual(PARSED);
  });

  test('accepts a maximum of one minor unit', () => {
    expect(parseCapConfig({...VALID, capAmount: '0.01'})?.capMinor).toBe(1);
  });

  test.each([1, 100])('accepts %i%% — the ends of the legal range', (percentage) => {
    expect(parseCapConfig({...VALID, percentage})?.percentage).toBe(percentage);
  });

  test('a missing scope is one maximum for the order, as version 1 and 2 meant', () => {
    expect(parseCapConfig(withoutKey('scope'))?.scope).toBe('order');
  });

  test('ignores fields the Function does not use', () => {
    const config = {...VALID, currencyCode: 'EUR', somethingNew: true};

    expect(parseCapConfig(config)).toEqual(PARSED);
  });
});

describe('parseCapConfig, on the maximum the merchant chose', () => {
  test('reads a maximum on each item', () => {
    expect(parseCapConfig({...VALID, scope: 'item'})).toEqual({...PARSED, scope: 'item'});
  });

  // A per-item maximum does not care which lines it applies to: each eligible
  // line gets its own maximum whether that is every line or a chosen few.
  test.each([
    ['everything', {...VALID, scope: 'item'}],
    [
      'chosen products',
      {...VALID, scope: 'item', appliesTo: 'products', productIds: ['gid://shopify/Product/1']},
    ],
    [
      'chosen collections',
      {
        ...VALID,
        scope: 'item',
        appliesTo: 'collections',
        collectionIds: ['gid://shopify/Collection/1'],
      },
    ],
  ])('a maximum on each item applies to %s', (_label, config) => {
    expect(parseCapConfig(config)?.scope).toBe('item');
  });

  test('reads a maximum per collection, with the collections to divide by', () => {
    const collectionIds = ['gid://shopify/Collection/1', 'gid://shopify/Collection/2'];
    const config = {...VALID, scope: 'collection', appliesTo: 'collections', collectionIds};

    expect(parseCapConfig(config)).toEqual({
      ...PARSED,
      scope: 'collection',
      appliesTo: 'collections',
      collectionIds,
    });
  });
});

describe('parseCapConfig, on a version 1 config still live in a shop', () => {
  // Version 2 deploying must not switch off every discount created before it.
  test('reads it as the whole cart, with the locked note', () => {
    expect(parseCapConfig(VALID_V1)).toEqual(PARSED);
  });

  test('a version it has never seen is still refused', () => {
    expect(parseCapConfig({...VALID, version: 5})).toBeNull();
  });
});

describe('parseCapConfig, on which lines the discount applies to', () => {
  test('a missing appliesTo is the whole cart, as version 1 meant', () => {
    expect(parseCapConfig(withoutKey('appliesTo'))?.appliesTo).toBe('all');
  });

  test('keeps the chosen product ids', () => {
    const config = {...VALID, appliesTo: 'products', productIds: ['gid://shopify/Product/1']};

    expect(parseCapConfig(config)).toEqual({
      ...PARSED,
      appliesTo: 'products',
      productIds: ['gid://shopify/Product/1'],
    });
  });

  // Eligibility is still Shopify's to resolve through `inAnyCollection`. The
  // ids are kept because the per-collection maximum has to group lines by
  // which collection they are in, and only the merchant's own order of them
  // decides where a product in two of them counts.
  test('keeps the chosen collection ids, in the order the merchant picked them', () => {
    const collectionIds = ['gid://shopify/Collection/2', 'gid://shopify/Collection/1'];
    const config = {...VALID, appliesTo: 'collections', collectionIds};

    expect(parseCapConfig(config)).toEqual({
      ...PARSED,
      appliesTo: 'collections',
      collectionIds,
    });
  });

  test.each([
    ['a targeting rule this Function does not implement', {...VALID, appliesTo: 'variants'}],
    ['products with no product ids', {...VALID, appliesTo: 'products', productIds: []}],
    ['collections with no collection ids', {...VALID, appliesTo: 'collections', collectionIds: []}],
    ['products whose ids are not strings', {...VALID, appliesTo: 'products', productIds: [7]}],
  ])('applies no discount for %s', (_label, config) => {
    expect(parseCapConfig(config)).toBeNull();
  });
});

describe('parseCapConfig, on the note the buyer reads', () => {
  test.each([
    ['missing', withoutKey('checkoutNote')],
    ['empty', {...VALID, checkoutNote: ''}],
    ['whitespace', {...VALID, checkoutNote: '   '}],
    ['not a string', {...VALID, checkoutNote: 42}],
  ])('falls back to the locked wording when it is %s', (_label, config) => {
    expect(parseCapConfig(config)?.checkoutNote).toBe('Discount capped at maximum amount');
  });

  test('keeps the merchant\'s own wording', () => {
    expect(parseCapConfig({...VALID, checkoutNote: 'Capped at our maximum'})?.checkoutNote).toBe(
      'Capped at our maximum',
    );
  });
});

describe('parseCapConfig, on a code it cannot use', () => {
  // The code only prefixes the buyer-facing message, so losing it must not
  // lose the cap.
  test.each([
    ['missing', withoutKey('code')],
    ['null', {...VALID, code: null}],
    ['empty', {...VALID, code: ''}],
    ['whitespace', {...VALID, code: '   '}],
    ['not a string', {...VALID, code: 15}],
  ])('still caps when the code is %s', (_label, config) => {
    expect(parseCapConfig(config)).toEqual({...PARSED, code: null});
  });

  test('trims a padded code', () => {
    expect(parseCapConfig({...VALID, code: ' SUMMER15 '})?.code).toBe('SUMMER15');
  });
});

describe('parseCapConfig applies no discount when', () => {
  test.each([
    ['the metafield is absent', undefined],
    ['the metafield is null', null],
    ['the value is a JSON string rather than an object', JSON.stringify(VALID)],
    ['the value is a number', 15],
    ['the value is an array', [VALID]],
    ['the object is empty', {}],
  ])('%s', (_label, jsonValue) => {
    expect(parseCapConfig(jsonValue)).toBeNull();
  });

  test.each([
    ['version is missing', withoutKey('version')],
    ['version is newer than this Function implements', {...VALID, version: 5}],
    ['version is a string', {...VALID, version: '1'}],
  ])('%s', (_label, config) => {
    expect(parseCapConfig(config)).toBeNull();
  });

  test.each([
    ['percentage is missing', withoutKey('percentage')],
    ['percentage is zero', {...VALID, percentage: 0}],
    ['percentage is negative', {...VALID, percentage: -15}],
    ['percentage is over 100', {...VALID, percentage: 101}],
    ['percentage is fractional', {...VALID, percentage: 15.5}],
    ['percentage is a string', {...VALID, percentage: '15'}],
    ['percentage is NaN', {...VALID, percentage: Number.NaN}],
  ])('%s', (_label, config) => {
    expect(parseCapConfig(config)).toBeNull();
  });

  test.each([
    ['capAmount is missing', withoutKey('capAmount')],
    ['capAmount is zero', {...VALID, capAmount: '0.00'}],
    ['capAmount is negative', {...VALID, capAmount: '-150.00'}],
    ['capAmount is a number rather than a decimal string', {...VALID, capAmount: 150}],
    ['capAmount is formatted for display', {...VALID, capAmount: '1,500.00'}],
    ['capAmount carries a currency code', {...VALID, capAmount: '150.00 USD'}],
    ['capAmount is not a number at all', {...VALID, capAmount: 'one hundred and fifty'}],
  ])('%s', (_label, config) => {
    expect(parseCapConfig(config)).toBeNull();
  });

  test.each([
    ['scope is unrecognised', {...VALID, scope: 'ORDER'}],
    ['scope is not a string', {...VALID, scope: 2}],
    // A maximum per collection with no collections to divide the cart into
    // has no honest reading, so it is refused rather than quietly becoming
    // one maximum overall.
    ['scope is per-collection on a discount that applies to everything', {...VALID, scope: 'collection'}],
    [
      'scope is per-collection on a discount that targets products',
      {...VALID, scope: 'collection', appliesTo: 'products', productIds: ['gid://shopify/Product/1']},
    ],
  ])('%s', (_label, config) => {
    expect(parseCapConfig(config)).toBeNull();
  });
});

describe('parseCapConfig, on the minimum a cart must meet', () => {
  test('no minimum is the default, and every older config', () => {
    expect(parseCapConfig(VALID)?.minSubtotalMinor).toBeNull();
    expect(parseCapConfig(VALID)?.minQuantity).toBeNull();
  });

  test('reads a minimum subtotal as minor units', () => {
    expect(parseCapConfig({...VALID, minSubtotal: '75.50'})?.minSubtotalMinor).toBe(7550);
  });

  test('reads a minimum quantity', () => {
    expect(parseCapConfig({...VALID, minQuantity: 3})?.minQuantity).toBe(3);
  });

  test('an empty minimum is no minimum, not a broken one', () => {
    expect(parseCapConfig({...VALID, minSubtotal: ''})?.minSubtotalMinor).toBeNull();
  });

  // A gate we cannot read is a gate we cannot enforce.
  test.each([
    ['a minimum subtotal as a number', {...VALID, minSubtotal: 75.5}],
    ['a minimum subtotal in minor units', {...VALID, minSubtotal: 7550}],
    ['a minimum subtotal of zero', {...VALID, minSubtotal: '0.00'}],
    ['a minimum subtotal that is not a number', {...VALID, minSubtotal: 'seventy five'}],
    ['a minimum quantity of zero', {...VALID, minQuantity: 0}],
    ['a fractional minimum quantity', {...VALID, minQuantity: 2.5}],
    ['a minimum quantity as a string', {...VALID, minQuantity: '3'}],
  ])('applies no discount for %s', (_label, config) => {
    expect(parseCapConfig(config)).toBeNull();
  });
});

describe('parseCapConfig, on a maximum per market currency', () => {
  test('no per-currency maximums is the default, and every older config', () => {
    expect(parseCapConfig(VALID)?.capsByCurrency).toEqual({});
  });

  test('reads each currency as minor units, keyed upper-case', () => {
    const config = {...VALID, capsByCurrency: {eur: '120.00', GBP: '110.50'}};

    expect(parseCapConfig(config)?.capsByCurrency).toEqual({EUR: 12000, GBP: 11050});
  });

  test.each([
    ['a key that is not a currency code', {...VALID, capsByCurrency: {EURO: '120.00'}}],
    ['an amount in minor units', {...VALID, capsByCurrency: {EUR: 12000}}],
    ['an amount of zero', {...VALID, capsByCurrency: {EUR: '0.00'}}],
    ['an amount that is missing', {...VALID, capsByCurrency: {EUR: null}}],
    ['a list rather than a map', {...VALID, capsByCurrency: ['120.00']}],
  ])('applies no discount for %s', (_label, config) => {
    expect(parseCapConfig(config)).toBeNull();
  });
});

describe('capForCurrency', () => {
  const config = parseCapConfig({
    ...VALID,
    capAmount: '150.00',
    capsByCurrency: {EUR: '120.00'},
  })!;

  test('uses the merchant\'s own number for a currency they set', () => {
    expect(capForCurrency(config, 'EUR')).toBe(12000);
  });

  test('matches the currency whatever case Shopify sends', () => {
    expect(capForCurrency(config, 'eur')).toBe(12000);
  });

  // Rule 5: a 150 maximum is 150 in whatever the buyer pays in. Nothing here
  // multiplies by an exchange rate, and nothing ever should.
  test('relabels the base maximum for a currency they did not set', () => {
    expect(capForCurrency(config, 'JPY')).toBe(15000);
    expect(capForCurrency(config, 'USD')).toBe(15000);
  });
});
