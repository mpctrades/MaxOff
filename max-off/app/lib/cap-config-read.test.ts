import { describe, expect, test } from "vitest";

import {
  buildCapConfig,
  CAP_CONFIG_VERSION,
  DEFAULT_CHECKOUT_NOTE,
  parseCapConfig,
} from "./cap-config";

/**
 * `parseCapConfig` is the only thing standing between a corrupt metafield and
 * a detail screen confidently printing the wrong maximum. These tests are
 * mostly about what it *refuses*.
 */
describe("parseCapConfig — a config we wrote ourselves", () => {
  test("round-trips what buildCapConfig produced", () => {
    const written = buildCapConfig({
      percentage: 15,
      capMinor: 15_000,
      currencyCode: "USD",
      code: "SUMMER15",
    });

    const read = parseCapConfig(written);

    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(read.config.percentage).toBe(15);
    expect(read.config.capAmount).toBe("150.00");
    expect(read.config.currencyCode).toBe("USD");
    expect(read.config.code).toBe("SUMMER15");
  });

  test("keeps the merchant's own checkout note", () => {
    const written = buildCapConfig({
      percentage: 20,
      capMinor: 5_000,
      currencyCode: "EUR",
      code: null,
      checkoutNote: "Maximum reached",
    });

    const read = parseCapConfig(written);
    expect(read.ok && read.config.checkoutNote).toBe("Maximum reached");
  });
});

describe("parseCapConfig — versions 1 and 2, still live on real discounts", () => {
  test("a version 1 config reads, with the defaults that version behaved as", () => {
    const read = parseCapConfig({
      version: 1,
      percentage: 10,
      capAmount: "50.00",
      currencyCode: "USD",
      code: "OLD10",
    });

    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(read.config.scope).toBe("order");
    expect(read.config.appliesTo).toBe("all");
    expect(read.config.rounding).toBe("cent");
    expect(read.config.checkoutNote).toBe(DEFAULT_CHECKOUT_NOTE);
    expect(read.config.collectionIds).toEqual([]);
    expect(read.config.productIds).toEqual([]);
  });
});

describe("parseCapConfig — what it refuses", () => {
  test("a missing metafield is 'missing', not 'unreadable'", () => {
    expect(parseCapConfig(null)).toEqual({
      ok: false,
      problem: "missing",
      version: null,
    });
    expect(parseCapConfig(undefined)).toEqual({
      ok: false,
      problem: "missing",
      version: null,
    });
  });

  test.each([
    ["a JSON array", []],
    ["a bare string", "15% off"],
    ["a number", 15],
  ])("%s is unreadable", (_name, value) => {
    const read = parseCapConfig(value);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toBe("unreadable");
  });

  test("a config with no version is unreadable", () => {
    const read = parseCapConfig({ percentage: 15, capAmount: "150.00" });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toBe("unreadable");
  });

  test("a newer version is reported as such, and carries the number", () => {
    const read = parseCapConfig({
      version: CAP_CONFIG_VERSION + 1,
      percentage: 15,
      capAmount: "150.00",
      currencyCode: "USD",
    });

    expect(read).toEqual({
      ok: false,
      problem: "unsupported-version",
      version: CAP_CONFIG_VERSION + 1,
    });
  });

  test.each([
    ["percentage missing", { version: 5, capAmount: "150.00", currencyCode: "USD" }],
    [
      "percentage is a string",
      { version: 5, percentage: "15", capAmount: "150.00", currencyCode: "USD" },
    ],
    [
      "capAmount is a number, not a decimal string",
      { version: 5, percentage: 15, capAmount: 150, currencyCode: "USD" },
    ],
    [
      "capAmount is not a decimal at all",
      { version: 5, percentage: 15, capAmount: "lots", currencyCode: "USD" },
    ],
    [
      "currencyCode is empty",
      { version: 5, percentage: 15, capAmount: "150.00", currencyCode: "" },
    ],
  ])("%s is unreadable, and never falls back to a default", (_name, value) => {
    const read = parseCapConfig(value);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toBe("unreadable");
  });
});
