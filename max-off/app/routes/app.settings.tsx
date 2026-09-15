import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import {
  EDITABLE_SETTINGS,
  refreshStoreCurrency,
  saveShopSettings,
} from "../models/settings.server";
import { CAP_ENGINE_DEPLOYED } from "../lib/cap";
import { formatCurrencyChoice, formatMoney } from "../lib/format";
import { gateFor } from "../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // The store is the authority on its own currency; our column is a cache
  // (§2a). Refreshed on every load, so a merchant who changes their store
  // currency sees MaxOff follow it rather than keep labelling amounts USD.
  const { settings, liveCurrencyCode } = await refreshStoreCurrency({
    shop: session.shop,
    admin,
  });

  return {
    /** Whether anything on this page can be changed. Empty in V1 (§5), and
     *  reported by the loader because a route component may import types from
     *  a `.server` module but never values. */
    hasEditableFields: EDITABLE_SETTINGS.length > 0,
    currencyCode: settings.currencyCode,
    /** Null when Shopify could not be reached — the cached value is shown. */
    liveCurrencyCode,
    rounding: settings.rounding,
    checkoutNote: settings.defaultCheckoutNote,
    /** The cached plan is enough: this decides one badge, not what is saved. */
    perMarketGate: gateFor(settings.plan, "perMarketCurrency"),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const form = await request.formData();

  // Only the allow-list in settings.server.ts can be written, and in V1 it is
  // empty. A crafted POST naming `rounding` or `plan` changes nothing, because
  // nothing here reads those names (§5).
  const result = await saveShopSettings({ shop: session.shop, form });

  return { ok: true as const, changed: result.changed };
};

export default function SettingsPage() {
  const {
    currencyCode,
    liveCurrencyCode,
    rounding,
    checkoutNote,
    hasEditableFields,
    perMarketGate,
  } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-paragraph color="subdued">How MaxOff behaves in your store.</s-paragraph>

      {/* ---------------- 1 · Checkout wording (V2) ---------------- */}
      {/* Still `disabled`: §4.7 renders this field read-only in V1, and
          `EDITABLE_SETTINGS` is empty so there is nothing behind it to write.
          `maxLength` is off only because it is what draws the "33/60" counter;
          the note's 60-character limit from §4.7 goes back on this field the
          day editing ships. */}
      <s-section heading="Checkout wording">
        <s-text-field
          label="Default note under a capped discount"
          name="defaultCheckoutNote"
          value={checkoutNote}
          disabled
          details="Used for new discounts. You can override it on any single discount."
        ></s-text-field>
      </s-section>

      {/* ---------------- 2 · Currency and rounding ---------------- */}
      {/* Both controls are `disabled`, and both for a reason a merchant would
          agree with rather than to look tidy. The store currency belongs to
          Shopify — MaxOff follows it and never converts (rule 5), so an
          editable select here would promise something the cap engine does not
          do. Rounding is fixed by the Function itself: changing it in the
          admin without changing the engine would make this screen lie about
          what happens at checkout. */}
      <s-section heading="Currency and rounding">
        <s-stack direction="block" gap="base">
          <s-grid
            gridTemplateColumns="@container (inline-size <= 500px) 1fr, 1fr 1fr"
            gap="base"
          >
            <s-select
              label="Store currency"
              name="storeCurrency"
              value={currencyCode}
              disabled
              details={
                liveCurrencyCode === null
                  ? "Last known value — Shopify could not be reached."
                  : "Set in Shopify settings, not here."
              }
            >
              <s-option value={currencyCode}>
                {formatCurrencyChoice(currencyCode)}
              </s-option>
            </s-select>

            <s-select
              label="Rounding"
              name="rounding"
              value={rounding === "down" ? "down" : "cent"}
              disabled
              details="Half-up to the cent, once, on the final discount amount."
            >
              <s-option value="cent">To the cent (recommended)</s-option>
              <s-option value="down">Down to the whole unit</s-option>
            </s-select>
          </s-grid>

          {/* Carries rule 5 on its own now that the "maximums relabel"
              paragraph is gone: "instead of converting one number" is the
              same promise in fewer words. */}
          <s-banner tone="info">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text>
                Selling in several currencies?{" "}
                <strong>Set a maximum per market</strong> instead of converting
                one number.
              </s-text>
              <s-badge>{perMarketGate.badge}</s-badge>
            </s-stack>
          </s-banner>
        </s-stack>
      </s-section>

      {/* ---------------- 3 · Email alerts (V2) ---------------- */}
      {/* Every box is `disabled`: no alert is sent in V1, and nothing behind
          this screen can turn one on. The first two are `checked` because that
          is the state Arthur drew — see the note in the reply about what a
          ticked box claims to a merchant who cannot read the source. */}
      <s-section heading="Email alerts">
        <s-stack direction="block" gap="small-300">
          <s-checkbox
            label="Weekly summary of the money you kept"
            name="alertWeekly"
            details="Sent every Monday to your store's contact email."
            checked
            disabled
          ></s-checkbox>
          <s-checkbox
            label="A discount is about to expire"
            name="alertExpiry"
            details="Two days before the end date."
            checked
            disabled
          ></s-checkbox>
          {/* "Cap" never appears in a label (CLAUDE.md, voice) — the merchant
              word is "maximum". The threshold is rendered through `formatMoney`
              so it carries the store's own currency rather than a hard-coded
              USD. */}
          <s-checkbox
            label={`A single order goes more than ${formatMoney(10000, currencyCode)} over the maximum`}
            name="alertBigCap"
            details="Useful for spotting an influencer code being shared publicly."
            disabled
          ></s-checkbox>
        </s-stack>
      </s-section>

      {/* ---------------- 4 · How MaxOff runs ---------------- */}
      <s-section heading="How MaxOff runs">
        <s-stack direction="block" gap="base">
          <TransparencyRow label="Engine">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text>Shopify Function · discount</s-text>
              {CAP_ENGINE_DEPLOYED ? (
                <s-badge tone="success">Active</s-badge>
              ) : (
                <s-badge tone="warning">Not deployed</s-badge>
              )}
            </s-stack>
          </TransparencyRow>

          <s-divider direction="inline"></s-divider>

          <TransparencyRow label="Storefront code">
            <s-text>None. MaxOff adds nothing to your theme.</s-text>
          </TransparencyRow>

          <s-divider direction="inline"></s-divider>

          <TransparencyRow label="Where caps are stored">
            <s-text>On the discount itself, in your Shopify store.</s-text>
          </TransparencyRow>

          <s-divider direction="inline"></s-divider>

          <TransparencyRow label="If you uninstall">
            <s-text>
              Capped discounts stop capping and can be deleted from
              Shopify&apos;s own Discounts page. Nothing is left behind in your
              theme.
            </s-text>
          </TransparencyRow>
        </s-stack>
      </s-section>

      {!hasEditableFields && (
        <s-paragraph color="subdued">
          Nothing on this page can be changed in this version, so there is
          nothing to save.
        </s-paragraph>
      )}
    </s-page>
  );
}

function TransparencyRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <s-grid
      gridTemplateColumns="@container (inline-size <= 500px) 1fr, 1fr 2fr"
      gap="base"
      alignItems="start"
    >
      <s-text color="subdued">{label}</s-text>
      {children}
    </s-grid>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
