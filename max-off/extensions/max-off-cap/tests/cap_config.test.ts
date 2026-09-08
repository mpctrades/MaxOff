import {describe, expect, test} from 'vitest';
import {CAP_CONFIG_VERSION, parseCapConfig} from '../src/cap_config';

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
};

function withoutKey(key: string): Record<string, unknown> {
  const config: Record<string, unknown> = {...VALID};
  delete config[key];
  return config;
}

describe('parseCapConfig, on config it can read', () => {
  test('reads the percentage, the maximum in minor units, and the code', () => {
    expect(parseCapConfig(VALID)).toEqual({percentage: 15, capMinor: 15000, code: 'SUMMER15'});
  });

  test('accepts a maximum of one minor unit', () => {
    expect(parseCapConfig({...VALID, capAmount: '0.01'})?.capMinor).toBe(1);
  });

  test.each([1, 100])('accepts %i%% — the ends of the legal range', (percentage) => {
    expect(parseCapConfig({...VALID, percentage})?.percentage).toBe(percentage);
  });

  test('accepts a missing scope, which has one legal value in V1', () => {
    expect(parseCapConfig(withoutKey('scope'))).not.toBeNull();
  });

  test('ignores fields the Function does not use', () => {
    const config = {...VALID, currencyCode: 'EUR', checkoutNote: '', somethingNew: true};

    expect(parseCapConfig(config)).toEqual({percentage: 15, capMinor: 15000, code: 'SUMMER15'});
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
    expect(parseCapConfig(config)).toEqual({percentage: 15, capMinor: 15000, code: null});
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
    ['version is newer than this Function implements', {...VALID, version: 2}],
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
    ['scope is a PRO per-item maximum', {...VALID, scope: 'item'}],
    ['scope is a PRO per-collection maximum', {...VALID, scope: 'collection'}],
    ['scope is unrecognised', {...VALID, scope: 'ORDER'}],
  ])('%s', (_label, config) => {
    expect(parseCapConfig(config)).toBeNull();
  });
});
