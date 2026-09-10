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
  const { currencyCode, liveCurrencyCode, rounding, checkoutNote, hasEditableFields } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-paragraph color="subdued">How MaxOff behaves in your store.</s-paragraph>

      {/* ---------------- 1 · Checkout wording (V2) ---------------- */}
      <s-section heading="Checkout wording">
        <s-text-field
          label="Note shown under the discount at checkout"
          name="defaultCheckoutNote"
          value={checkoutNote}
          maxLength={60}
          disabled
          details="Used for new discounts. You can override it on any single discount."
        ></s-text-field>
        <s-paragraph color="subdued">
          Editing this wording comes in a later version. Every capped discount
          currently shows this note when the maximum applies.
        </s-paragraph>
      </s-section>

      {/* ---------------- 2 · Currency and rounding ---------------- */}
      <s-section heading="Currency and rounding">
        <s-stack direction="block" gap="base">
          <s-grid
            gridTemplateColumns="@container (inline-size <= 500px) 1fr, 1fr 2fr"
            gap="base"
            alignItems="start"
          >
            <s-text color="subdued">Store currency</s-text>
            <s-stack direction="block" gap="small-500">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text type="strong">{currencyCode}</s-text>
                {liveCurrencyCode === null && (
                  <s-badge tone="warning">Last known</s-badge>
                )}
              </s-stack>
              <s-text color="subdued">
                MaxOff follows your store currency. You set it in Shopify
                settings, not here.
              </s-text>
            </s-stack>
          </s-grid>

          {/* §6 and rule 5, stated where a merchant will look for it. */}
          <s-paragraph color="subdued">
            Maximums relabel, they are never converted. A maximum of 150 is 150{" "}
            {currencyCode} — if your store currency changes, the number stays
            the same and only the code beside it changes.
          </s-paragraph>

          <s-divider direction="inline"></s-divider>

          <s-select
            label="Rounding"
            name="rounding"
            value={rounding === "down" ? "down" : "cent"}
            disabled
            details="MaxOff rounds half-up to the cent, once, on the final discount amount."
          >
            <s-option value="cent">To the cent (recommended)</s-option>
            <s-option value="down">Down to the whole unit</s-option>
          </s-select>
          <s-paragraph color="subdued">
            Per-store rounding is not available yet. The cap engine rounds
            half-up to the cent, so this cannot be changed without changing
            what the engine does at checkout.
          </s-paragraph>

          <s-banner tone="info" heading="Selling in several currencies?">
            Set a maximum per market instead of converting one number. That is a
            Pro feature.
          </s-banner>
        </s-stack>
      </s-section>

      {/* ---------------- 3 · Email alerts (V2) ---------------- */}
      <s-section heading="Email alerts">
        <s-paragraph color="subdued">
          None of these are sent yet. They are here so you can see what is
          coming.
        </s-paragraph>
        <s-stack direction="block" gap="small-300">
          <s-checkbox
            label="Weekly summary of the money you kept"
            name="alertWeekly"
            disabled
          ></s-checkbox>
          <s-checkbox
            label="Warn me before a capped discount expires"
            name="alertExpiry"
            disabled
          ></s-checkbox>
          <s-checkbox
            label="Tell me when a single order hits the maximum hard"
            name="alertBigCap"
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
