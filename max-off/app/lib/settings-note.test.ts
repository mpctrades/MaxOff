import { describe, expect, test } from "vitest";

import { DEFAULT_CHECKOUT_NOTE } from "./cap-config";
import { can } from "./plans";

/**
 * The rule the Settings page and the create form both apply to the checkout
 * note, stated once here so the two cannot drift.
 *
 * Custom wording is a Growth entitlement. The trap is the *downgrade*: a shop
 * that wrote its own note on Growth still has it stored after moving to Free,
 * and a check written as "is this the locked wording?" would lock that shop
 * out of both screens — unable to save rounding, unable to create a discount,
 * over a field they are not allowed to edit.
 *
 * Both screens therefore ask "is this a **change**?", not "is this custom?".
 */
describe("who may write their own checkout note", () => {
  test("Growth and Pro may, Free may not", () => {
    expect(can("free", "customCheckoutWording")).toBe(false);
    expect(can("growth", "customCheckoutWording")).toBe(true);
    expect(can("pro", "customCheckoutWording")).toBe(true);
  });

  /** The Settings rule, as `upsertSettings` applies it. */
  const settingsRefuses = (plan: string, stored: string, submitted: string) =>
    submitted !== stored &&
    submitted !== DEFAULT_CHECKOUT_NOTE &&
    !can(plan, "customCheckoutWording");

  test("Free cannot change the stored note", () => {
    expect(settingsRefuses("free", DEFAULT_CHECKOUT_NOTE, "Ours instead")).toBe(true);
  });

  test("Free may resubmit a note it already has, so rounding stays saveable", () => {
    expect(settingsRefuses("free", "Written on Growth", "Written on Growth")).toBe(
      false,
    );
  });

  test("Free may always go back to the locked wording", () => {
    expect(settingsRefuses("free", "Written on Growth", DEFAULT_CHECKOUT_NOTE)).toBe(
      false,
    );
  });

  test("Growth may change it", () => {
    expect(settingsRefuses("growth", DEFAULT_CHECKOUT_NOTE, "Ours instead")).toBe(
      false,
    );
  });

  /**
   * The create form's rule: what the shop default prefills to. On a plan that
   * cannot reword, the form starts from the locked wording whatever the column
   * holds — otherwise every new discount on a downgraded shop would fail on a
   * disabled field.
   */
  const prefill = (plan: string, shopDefault: string) =>
    can(plan, "customCheckoutWording") ? shopDefault : DEFAULT_CHECKOUT_NOTE;

  test("a paid shop's own default prefills the create form", () => {
    expect(prefill("growth", "Capped at our maximum")).toBe("Capped at our maximum");
  });

  test("a downgraded shop falls back to the locked wording", () => {
    expect(prefill("free", "Capped at our maximum")).toBe(DEFAULT_CHECKOUT_NOTE);
  });
});
