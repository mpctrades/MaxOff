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
      version: 1,
      percentage: 15,
      capAmount: "150.00",
      currencyCode: "USD",
      scope: "order",
      checkoutNote: "Discount capped at maximum amount",
      code: "SUMMER15",
    });
  });

  test("the checkout note is always written, even though the field is V2", () => {
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
