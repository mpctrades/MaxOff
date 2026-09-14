import { describe, expect, test } from "vitest";

// The Function's own parser, imported *only* here. The shipped code keeps two
// deliberate copies of the arithmetic (BUILD-SPEC §8); this test is the seam
// that proves they agree, so a divergence fails here rather than at a checkout.
import { parseCapConfig } from "../../extensions/max-off-cap/src/cap_config";
import { capDiscountMinor, parseDecimalToMinor, toDecimalString } from "./cap";
import {
  buildCapConfig,
  capConfigMetafield,
  CAP_CONFIG_KEY,
  CAP_CONFIG_NAMESPACE,
  CAP_CONFIG_TYPE,
  DEFAULT_CHECKOUT_NOTE,
} from "./cap-config";

/**
 * The cap-arithmetic table from BUILD-SPEC §8, in minor units. The Function's
 * own suite runs the same eight cases; this file runs them through the admin's
 * copy and then through the Function's parser.
 */
const SPEC_8 = [
  { pct: 15, capMinor: 15000, subtotalMinor: 140000, given: 15000, kept: 6000, note: "above break-even" },
  { pct: 15, capMinor: 15000, subtotalMinor: 70000, given: 10500, kept: 0, note: "below break-even" },
  { pct: 15, capMinor: 15000, subtotalMinor: 100000, given: 15000, kept: 0, note: "exactly at break-even" },
  { pct: 15, capMinor: 15000, subtotalMinor: 0, given: 0, kept: 0, note: "empty cart" },
  { pct: 100, capMinor: 15000, subtotalMinor: 20000, given: 15000, kept: 5000, note: "100% still capped" },
  { pct: 15, capMinor: 15000, subtotalMinor: 3333, given: 500, kept: 0, note: "rounding 4.9995 -> 5.00" },
  { pct: 1, capMinor: 15000, subtotalMinor: 140000, given: 1400, kept: 0, note: "cap never reached" },
  { pct: 15, capMinor: 1, subtotalMinor: 140000, given: 1, kept: 20999, note: "tiny cap" },
];

describe("capDiscountMinor — the §8 table", () => {
  test.each(SPEC_8)(
    "$note: $pct% of $subtotalMinor capped at $capMinor gives $given",
    ({ pct, capMinor, subtotalMinor, given, kept }) => {
      const result = capDiscountMinor(subtotalMinor, pct, capMinor);

      expect(result.givenMinor).toBe(given);
      expect(result.keptMinor).toBe(kept);
    },
  );

  test("capped is true only when the maximum decided the amount", () => {
    expect(capDiscountMinor(140000, 15, 15000).capped).toBe(true);
    expect(capDiscountMinor(70000, 15, 15000).capped).toBe(false);
    // Exactly at break-even the percentage and the cap agree, so the cap did
    // not take anything away.
    expect(capDiscountMinor(100000, 15, 15000).capped).toBe(false);
  });
});

describe("parseDecimalToMinor — what a merchant actually types", () => {
  test.each([
    ["150", 15000],
    ["150.5", 15050],
    ["150.50", 15050],
    ["150.00", 15000],
    [" 150.00 ", 15000],
    ["0.01", 1],
    ["1400", 140000],
    ["33.33", 3333],
    ["0.005", 1],
    ["0.004", 0],
  ])("%s parses to %i minor units", (input, expected) => {
    expect(parseDecimalToMinor(input)).toBe(expected);
  });

  test.each([
    ["", "empty"],
    ["abc", "letters"],
    ["-150", "negative"],
    ["150.00.00", "two points"],
    ["1,400.00", "thousands separator"],
    ["$150", "currency symbol"],
    ["150%", "percent sign"],
    ["Infinity", "infinity"],
    ["NaN", "NaN"],
  ])("%s is rejected as null (%s)", (input) => {
    expect(parseDecimalToMinor(input)).toBeNull();
  });
});

describe("the metafield round trip", () => {
  test.each(SPEC_8)(
    "$note: the Function reads back exactly what the admin wrote",
    ({ pct, capMinor }) => {
      const config = buildCapConfig({
        percentage: pct,
        capMinor,
        currencyCode: "USD",
        code: "SUMMER15",
      });

      // What Shopify stores is JSON; `jsonValue` hands the Function the parsed
      // object, so parse our own serialisation the same way.
      const asStored = JSON.parse(JSON.stringify(config));
      const parsed = parseCapConfig(asStored);

      expect(parsed).not.toBeNull();
      expect(parsed?.percentage).toBe(pct);
      expect(parsed?.capMinor).toBe(capMinor);
      expect(parsed?.code).toBe("SUMMER15");
    },
  );

  test("capAmount is a decimal string in major units, two decimals", () => {
    const config = buildCapConfig({
      percentage: 15,
      capMinor: 15000,
      currencyCode: "USD",
      code: "SUMMER15",
    });

    expect(config.capAmount).toBe("150.00");
    expect(typeof config.capAmount).toBe("string");
    // The two failure modes §1 names: a number, or minor units.
    expect(config.capAmount).not.toBe(150);
    expect(config.capAmount).not.toBe("15000");
  });

  test("150.00 -> 15000 -> 150.00, for every amount in the table", () => {
    for (const { capMinor } of SPEC_8) {
      const asString = toDecimalString(capMinor);
      expect(parseDecimalToMinor(asString)).toBe(capMinor);
      expect(toDecimalString(parseDecimalToMinor(asString)!)).toBe(asString);
    }
  });

  test("the whole config matches the shape §1 documents", () => {
    expect(
      buildCapConfig({
        percentage: 15,
        capMinor: 15000,
        currencyCode: "USD",
        code: "SUMMER15",
      }),
    ).toEqual({
      version: 2,
      percentage: 15,
      capAmount: "150.00",
      currencyCode: "USD",
      scope: "order",
      checkoutNote: "Discount capped at maximum amount",
      code: "SUMMER15",
      appliesTo: "all",
      collectionIds: [],
      productIds: [],
    });
  });

  test("the checkout note falls back to the locked wording", () => {
    const config = buildCapConfig({
      percentage: 15,
      capMinor: 15000,
      currencyCode: "USD",
      code: "SUMMER15",
    });

    expect(config.checkoutNote).toBe(DEFAULT_CHECKOUT_NOTE);
  });

  test("the metafield input names the namespace and key the Function reads", () => {
    const metafield = capConfigMetafield({
      percentage: 15,
      capMinor: 15000,
      currencyCode: "USD",
      code: "SUMMER15",
    });

    expect(metafield.namespace).toBe(CAP_CONFIG_NAMESPACE);
    expect(metafield.namespace).toBe("$app");
    expect(metafield.key).toBe(CAP_CONFIG_KEY);
    expect(metafield.type).toBe(CAP_CONFIG_TYPE);

    // And the Function can read the serialised value.
    expect(parseCapConfig(JSON.parse(metafield.value))).toEqual({
      percentage: 15,
      capMinor: 15000,
      code: "SUMMER15",
      checkoutNote: DEFAULT_CHECKOUT_NOTE,
      appliesTo: "all",
      productIds: [],
    });
  });

  test("a currency other than USD relabels, it does not convert", () => {
    const eur = buildCapConfig({
      percentage: 15,
      capMinor: 15000,
      currencyCode: "EUR",
      code: "SUMMER15",
    });

    expect(eur.capAmount).toBe("150.00");
    expect(eur.currencyCode).toBe("EUR");
    expect(parseCapConfig(JSON.parse(JSON.stringify(eur)))?.capMinor).toBe(15000);
  });

  test("input the Function would refuse is refused here instead, loudly", () => {
    const base = { capMinor: 15000, currencyCode: "USD", code: "SUMMER15" };

    expect(() => buildCapConfig({ ...base, percentage: 0 })).toThrow();
    expect(() => buildCapConfig({ ...base, percentage: 101 })).toThrow();
    expect(() => buildCapConfig({ ...base, percentage: 15.5 })).toThrow();
    expect(() =>
      buildCapConfig({ ...base, capMinor: 0, percentage: 15 }),
    ).toThrow();
    expect(() =>
      buildCapConfig({ ...base, capMinor: -1, percentage: 15 }),
    ).toThrow();
  });
});

describe("the admin and the Function agree on the same numbers", () => {
  test.each(SPEC_8)(
    "$note: the preview's given matches what the Function would emit",
    ({ pct, capMinor, subtotalMinor, given }) => {
      const parsed = parseCapConfig(
        JSON.parse(
          JSON.stringify(
            buildCapConfig({
              percentage: pct,
              capMinor,
              currencyCode: "USD",
              code: "SUMMER15",
            }),
          ),
        ),
      );

      // The admin's preview arithmetic, run on the config the Function parsed.
      const preview = capDiscountMinor(
        subtotalMinor,
        parsed!.percentage,
        parsed!.capMinor,
      );

      expect(preview.givenMinor).toBe(given);
      expect(toDecimalString(preview.givenMinor)).toBe(toDecimalString(given));
    },
  );
});

/**
 * The version 2 fields, across the same seam.
 *
 * Everything here is written by `app/lib/cap-config.ts` and read by the
 * Function's own parser, so a divergence in the targeting or the note fails
 * here rather than as a discount that silently stops discounting.
 */
describe("version 2: which lines, and what the buyer reads", () => {
  const base = {
    percentage: 15,
    capMinor: 15000,
    currencyCode: "USD",
    code: "SUMMER15",
  };

  const roundTrip = (input: Parameters<typeof buildCapConfig>[0]) =>
    parseCapConfig(JSON.parse(JSON.stringify(buildCapConfig(input))));

  test("collection ids are a top-level key, because the input query reads them by name", () => {
    const config = buildCapConfig({
      ...base,
      appliesTo: "collections",
      collectionIds: ["gid://shopify/Collection/1"],
    });

    // `[extensions.input.variables]` populates `$collectionIds` from the key
    // of that exact name. Nesting it would leave the variable null and every
    // product out of the set — a discount that quietly does nothing.
    expect(config.collectionIds).toEqual(["gid://shopify/Collection/1"]);
    expect(config.appliesTo).toBe("collections");
  });

  test("the Function reads a collection-targeted discount as targeted", () => {
    const parsed = roundTrip({
      ...base,
      appliesTo: "collections",
      collectionIds: ["gid://shopify/Collection/1"],
    });

    expect(parsed?.appliesTo).toBe("collections");
    // Collections are resolved by Shopify before the Function runs, so the
    // parser keeps no ids for them — only the products it matches itself.
    expect(parsed?.productIds).toEqual([]);
  });

  test("the Function reads the chosen product ids back unchanged", () => {
    const parsed = roundTrip({
      ...base,
      appliesTo: "products",
      productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
    });

    expect(parsed?.appliesTo).toBe("products");
    expect(parsed?.productIds).toEqual([
      "gid://shopify/Product/1",
      "gid://shopify/Product/2",
    ]);
  });

  test("ids for a set the discount does not target are not written", () => {
    const config = buildCapConfig({
      ...base,
      appliesTo: "all",
      collectionIds: ["gid://shopify/Collection/1"],
      productIds: ["gid://shopify/Product/1"],
    });

    expect(config.collectionIds).toEqual([]);
    expect(config.productIds).toEqual([]);
  });

  test("a duplicate the picker returned twice is written once", () => {
    const config = buildCapConfig({
      ...base,
      appliesTo: "products",
      productIds: ["gid://shopify/Product/1", "gid://shopify/Product/1"],
    });

    expect(config.productIds).toEqual(["gid://shopify/Product/1"]);
  });

  test("a targeted discount naming nothing is refused here, not at checkout", () => {
    expect(() =>
      buildCapConfig({ ...base, appliesTo: "collections", collectionIds: [] }),
    ).toThrow();
    expect(() =>
      buildCapConfig({ ...base, appliesTo: "products", productIds: [] }),
    ).toThrow();
  });

  test("an automatic discount writes a null code, so the buyer sees no prefix", () => {
    const parsed = roundTrip({ ...base, code: null });

    expect(parsed?.code).toBeNull();
  });

  test("the merchant's note survives the round trip", () => {
    const parsed = roundTrip({ ...base, checkoutNote: "Capped at our maximum" });

    expect(parsed?.checkoutNote).toBe("Capped at our maximum");
  });

  test("a note of only whitespace falls back to the locked wording", () => {
    expect(roundTrip({ ...base, checkoutNote: "   " })?.checkoutNote).toBe(
      DEFAULT_CHECKOUT_NOTE,
    );
  });

  test("a note longer than the buyer's line can carry is cut, not refused", () => {
    const config = buildCapConfig({ ...base, checkoutNote: "x".repeat(200) });

    expect(config.checkoutNote).toHaveLength(60);
  });

  test("whitespace inside a note is collapsed, so the line cannot be padded out", () => {
    const config = buildCapConfig({
      ...base,
      checkoutNote: "  Capped   at\tour maximum  ",
    });

    expect(config.checkoutNote).toBe("Capped at our maximum");
  });
});
