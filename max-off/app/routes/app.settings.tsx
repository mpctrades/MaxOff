import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { refreshShopProfile, upsertSettings } from "../models/settings.server";
import { restampRounding } from "../models/discounts.server";
import { getPlanForGate } from "../models/plan.server";
import { CAP_ENGINE_DEPLOYED } from "../lib/cap";
import {
  CAP_SCOPES,
  CHECKOUT_NOTE_MAX_LENGTH,
  DEFAULT_CHECKOUT_NOTE,
  isCapScope,
} from "../lib/cap-config";
import type { CapScope } from "../lib/cap-config";
import { formatCurrencyChoice } from "../lib/format";
import { gateFor, PLAN_LABELS } from "../lib/plans";
import type { CapabilityGate, CapabilityKey } from "../lib/plans";
import {
  ROUNDING_DETAILS,
  ROUNDING_LABELS,
  ROUNDING_MODES,
  toRoundingMode,
} from "../lib/rounding";
import type { RoundingMode } from "../lib/rounding";
import { toTimeZone } from "../lib/timezone";
import { useNativeChange } from "../lib/polaris-events";
import type { CheckedElement, ValueElement } from "../lib/polaris-events";

const SAVE_BAR_ID = "settings-save-bar";

/** What each default maximum is called, and the entitlement it needs. */
const SCOPE_LABELS: Record<CapScope, string> = {
  order: "The whole order",
  item: "Each item",
  collection: "Each collection",
};

const SCOPE_CAPABILITY: Record<CapScope, CapabilityKey> = {
  order: "orderMaximum",
  item: "itemMaximums",
  collection: "collectionMaximums",
};

/** The three combination checkboxes, as one list so the markup is one loop. */
const COMBINATIONS = [
  { field: "defaultCombinesProduct", label: "Product discounts" },
  { field: "defaultCombinesOrder", label: "Order discounts" },
  { field: "defaultCombinesShipping", label: "Shipping discounts" },
] as const;

type CombinationField = (typeof COMBINATIONS)[number]["field"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // The store is the authority on its own currency and its own clock; our
  // columns are a cache (§2a). Refreshed on every load, so a merchant who
  // changes either in Shopify sees MaxOff follow rather than keep labelling
  // amounts USD and reading their midnight as Greenwich's.
  //
  // The plan is read **live**, alongside it, for the same reason the create
  // form reads it live: this page decides what may be edited, and a merchant
  // who upgraded a minute ago would otherwise be shown a locked field for the
  // thing they just paid for.
  const [{ settings }, plan] = await Promise.all([
    refreshShopProfile({ shop: session.shop, admin }),
    getPlanForGate({ shop: session.shop, admin }),
  ]);

  return {
    currencyCode: settings.currencyCode,
    timezone: toTimeZone(settings.timezone),
    rounding: toRoundingMode(settings.rounding),
    checkoutNote: settings.defaultCheckoutNote,
    defaultScope: isCapScope(settings.defaultScope)
      ? settings.defaultScope
      : ("order" as CapScope),
    defaultOncePerCustomer: settings.defaultOncePerCustomer,
    defaultCombinesProduct: settings.defaultCombinesProduct,
    defaultCombinesOrder: settings.defaultCombinesOrder,
    defaultCombinesShipping: settings.defaultCombinesShipping,
    plan,
    noteGate: gateFor(plan, "customCheckoutWording"),
    perMarketGate: gateFor(plan, "perMarketCurrency"),
    /** One gate per maximum, so the select can disable what is not on the plan. */
    scopeGates: Object.fromEntries(
      CAP_SCOPES.map((scope) => [scope, gateFor(plan, SCOPE_CAPABILITY[scope])]),
    ) as Record<CapScope, CapabilityGate>,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const form = await request.formData();

  // The plan is checked again here, live, and never taken from the form. What
  // the loader read decides what the page *offers*; this decides what is
  // allowed to be written.
  const plan = await getPlanForGate({ shop: session.shop, admin });

  const result = await upsertSettings({ shop: session.shop, plan, form });

  if (!result.ok) {
    return {
      ok: false as const,
      fieldErrors: result.fieldErrors,
      restamped: null,
    };
  }

  // Rounding is a statement about the whole store, so the discounts that are
  // already live have to start obeying it too. Their `cap_config` is where the
  // Function reads it from, so each one is rewritten. Nothing else on this
  // page applies to an existing discount — the defaults only prefill a form.
  const restamped = result.changed.includes("rounding")
    ? await restampRounding({
        shop: session.shop,
        admin,
        rounding: result.settings.rounding,
      })
    : null;

  return { ok: true as const, changed: result.changed, restamped };
};

/** Every field this page edits, in one object, so "dirty" is one comparison. */
interface SettingsForm {
  checkoutNote: string;
  rounding: RoundingMode;
  defaultScope: CapScope;
  defaultOncePerCustomer: boolean;
  defaultCombinesProduct: boolean;
  defaultCombinesOrder: boolean;
  defaultCombinesShipping: boolean;
}

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const { currencyCode, timezone, plan, noteGate, perMarketGate, scopeGates } =
    data;

  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();

  // What is stored, as the loader last reported it. Serialised because it is a
  // new object every render, and every "has this changed?" below compares
  // against it.
  const savedKey = JSON.stringify({
    checkoutNote: data.checkoutNote,
    rounding: data.rounding,
    defaultScope: data.defaultScope,
    defaultOncePerCustomer: data.defaultOncePerCustomer,
    defaultCombinesProduct: data.defaultCombinesProduct,
    defaultCombinesOrder: data.defaultCombinesOrder,
    defaultCombinesShipping: data.defaultCombinesShipping,
  } satisfies SettingsForm);

  const [form, setForm] = useState<SettingsForm>(
    () => JSON.parse(savedKey) as SettingsForm,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  // The loader is the truth about what is stored. After a save it re-runs, so
  // resetting the form from it is what clears the save bar — and it is also
  // what puts the page right if the merchant changes plan in another tab.
  useEffect(() => {
    setForm(JSON.parse(savedKey) as SettingsForm);
  }, [savedKey]);

  const dirty = JSON.stringify(form) !== savedKey;
  const saving = fetcher.state !== "idle";

  // The contextual save bar, programmatic because the labels are ours — the
  // same arrangement as the create form.
  useEffect(() => {
    if (dirty) {
      shopify.saveBar.show(SAVE_BAR_ID);
    } else {
      shopify.saveBar.hide(SAVE_BAR_ID);
    }
  }, [dirty, shopify]);

  /** So one response is acted on once, not on every re-render. */
  const seen = useRef<unknown>(null);

  useEffect(() => {
    const response = fetcher.data;
    if (!response || response === seen.current) {
      return;
    }
    seen.current = response;

    if (!response.ok) {
      setErrors(response.fieldErrors ?? {});
      shopify.toast.show("Settings were not saved.", { isError: true });
      return;
    }

    setErrors({});
    shopify.saveBar.hide(SAVE_BAR_ID);

    // Say what actually happened to the merchant's money, not just "Saved".
    // Rounding reaches discounts that already exist, and a merchant who is not
    // told that has to go and check.
    const { restamped } = response;
    if (restamped === null) {
      shopify.toast.show("Settings saved");
    } else if (restamped.failed > 0) {
      shopify.toast.show(
        `Saved. ${countDiscounts(restamped.updated)} updated, ${restamped.failed} could not be.`,
        { isError: true },
      );
    } else {
      shopify.toast.show(
        `Saved. ${countDiscounts(restamped.updated)} now round this way.`,
      );
    }
  }, [fetcher.data, shopify]);

  const save = () => {
    fetcher.submit(
      {
        defaultCheckoutNote: form.checkoutNote,
        rounding: form.rounding,
        defaultScope: form.defaultScope,
        defaultOncePerCustomer: String(form.defaultOncePerCustomer),
        defaultCombinesProduct: String(form.defaultCombinesProduct),
        defaultCombinesOrder: String(form.defaultCombinesOrder),
        defaultCombinesShipping: String(form.defaultCombinesShipping),
      },
      { method: "post" },
    );
  };

  const discard = () => {
    setForm(JSON.parse(savedKey) as SettingsForm);
    setErrors({});
    shopify.saveBar.hide(SAVE_BAR_ID);
  };

  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const onRoundingChange = useNativeChange<ValueElement>((element) =>
    set("rounding", toRoundingMode(element.value)),
  );

  const onScopeChange = useNativeChange<ValueElement>((element) => {
    if (isCapScope(element.value)) {
      set("defaultScope", element.value);
    }
  });

  const onOnceChange = useNativeChange<ValueElement>((element) =>
    set("defaultOncePerCustomer", element.value === "true"),
  );

  const mayRewordNote = noteGate.usable;

  return (
    <s-page heading="Settings">
      <ui-save-bar id={SAVE_BAR_ID}>
        <button variant="primary" onClick={save} disabled={saving}>
          Save
        </button>
        <button onClick={discard} disabled={saving}>
          Discard
        </button>
      </ui-save-bar>

      <s-paragraph color="subdued">How MaxOff behaves in your store.</s-paragraph>

      {/* ---------------- 1 · Currency and rounding ---------------- */}
      {/* This section reaches discounts that already exist. The next one does
          not, and the page is ordered so the two sit next to each other and can
          be told apart.

          The currency select stays read-only for a reason a merchant would
          agree with rather than to look tidy: the store currency belongs to
          Shopify — MaxOff follows it and never converts (rule 5), so an
          editable select here would promise something the cap engine does not
          do. Rounding is different: the Function reads it from each discount's
          own `cap_config`, so changing it changes real money at checkout. */}
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
              details="Set in Shopify settings, not here."
            >
              <s-option value={currencyCode}>
                {formatCurrencyChoice(currencyCode)}
              </s-option>
            </s-select>

            <s-select
              label="Rounding"
              name="rounding"
              value={form.rounding}
              details={ROUNDING_DETAILS[form.rounding]}
              ref={onRoundingChange}
              {...(errors.rounding ? { error: errors.rounding } : {})}
            >
              {ROUNDING_MODES.map((mode: RoundingMode) => (
                <s-option key={mode} value={mode}>
                  {ROUNDING_LABELS[mode]}
                </s-option>
              ))}
            </s-select>
          </s-grid>

          {/* What the merchant is about to change, said in money rather than in
              the name of a rule. Only shown when it is actually a change. */}
          {form.rounding !== data.rounding && (
            <s-banner tone="info">
              {form.rounding === "down"
                ? "A discount of 105.52 becomes 105.00 at checkout — the cents stay with you."
                : "A discount of 105.52 stays 105.52 at checkout, to the cent."}{" "}
              This applies to the capped discounts you already have, not only to
              new ones.
            </s-banner>
          )}

          {/* Carries rule 5 on its own: "instead of converting one number" is
              the promise in fewer words. */}
          <s-banner tone="info">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text>
                Selling in several currencies? Set a maximum per market on each
                discount, instead of converting one number.
              </s-text>
              {perMarketGate.badge && <s-badge>{perMarketGate.badge}</s-badge>}
            </s-stack>
          </s-banner>
        </s-stack>
      </s-section>

      {/* ---------------- 2 · Defaults for new discounts ---------------- */}
      {/* The checkout note lives here rather than in a section of its own,
          because it is the same kind of thing as everything else below it: a
          prefill. It changes nothing about a discount that already exists,
          which is exactly what separates this whole section from the rounding
          above — and a merchant cannot tell those apart if they are scattered
          across the page. */}
      <s-section heading="Defaults for new discounts">
        <s-stack direction="block" gap="base">
          {/* Rewording the note is a Growth entitlement (§4.7). On Free the
              field is shown disabled with its badge rather than hidden, because
              a merchant cannot ask for a plan whose features they never saw. */}
          {mayRewordNote ? (
            <s-text-field
              label="Checkout note"
              name="defaultCheckoutNote"
              value={form.checkoutNote}
              placeholder={DEFAULT_CHECKOUT_NOTE}
              maxLength={CHECKOUT_NOTE_MAX_LENGTH}
              details="Shown to the customer only when the maximum applies."
              onInput={(event) => set("checkoutNote", event.currentTarget.value)}
              {...(errors.defaultCheckoutNote
                ? { error: errors.defaultCheckoutNote }
                : {})}
            ></s-text-field>
          ) : (
            /* The badge has to sit on the label's line, and `s-text-field`
               takes its label as a string. So the visible label is ours and the
               field's own label is kept for assistive technology only. The
               field is disabled, so nothing is lost by the visible text not
               being a `<label>` that focuses it. */
            <s-stack direction="block" gap="small-300">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text>Checkout note</s-text>
                {noteGate.badge && <s-badge>{noteGate.badge}</s-badge>}
              </s-stack>
              <s-text-field
                label="Checkout note"
                labelAccessibilityVisibility="exclusive"
                name="defaultCheckoutNote"
                value={data.checkoutNote}
                disabled
                maxLength={CHECKOUT_NOTE_MAX_LENGTH}
                details="Rewording it is on the Growth plan."
              ></s-text-field>
            </s-stack>
          )}

          <s-grid
            gridTemplateColumns="@container (inline-size <= 500px) 1fr, 1fr 1fr"
            gap="base"
          >
            <s-select
              label="Uses per customer"
              name="defaultOncePerCustomer"
              value={String(form.defaultOncePerCustomer)}
              ref={onOnceChange}
            >
              <s-option value="true">1 per customer</s-option>
              <s-option value="false">No limit</s-option>
            </s-select>

            {/* Every maximum is listed, including the two this plan does not
                have — disabled and named, so the merchant can see what Pro buys
                without being able to save a default the create form would then
                refuse. */}
            <s-select
              label="The maximum applies to"
              name="defaultScope"
              value={form.defaultScope}
              ref={onScopeChange}
              {...(errors.defaultScope ? { error: errors.defaultScope } : {})}
            >
              {CAP_SCOPES.map((scope) => {
                const gate = scopeGates[scope];
                return (
                  <s-option
                    key={scope}
                    value={scope}
                    {...(gate.usable ? {} : { disabled: true })}
                  >
                    {gate.usable
                      ? SCOPE_LABELS[scope]
                      : `${SCOPE_LABELS[scope]} — ${gate.badge}`}
                  </s-option>
                );
              })}
            </s-select>
          </s-grid>

          <s-stack direction="block" gap="small-300">
            <s-text>Combines with</s-text>
            <s-stack direction="inline" gap="base">
              {COMBINATIONS.map((combination) => (
                <CombinationCheckbox
                  key={combination.field}
                  field={combination.field}
                  label={combination.label}
                  checked={form[combination.field]}
                  onToggle={(on) => set(combination.field, on)}
                />
              ))}
            </s-stack>
          </s-stack>

          {/* The exception is named rather than glossed over. The note lost
              its per-discount field on the create form, so the promise that
              held for the other three controls stopped being true for it, and
              a closing line that still claimed it would be the page telling a
              small lie about the buyer-facing copy. */}
          <s-paragraph color="subdued">
            These prefill the Create new form, and anything you change on a
            single discount still wins. The checkout note has no per-discount
            override: every new discount takes this wording.
          </s-paragraph>
        </s-stack>
      </s-section>

      {/* ---------------- 3 · How MaxOff runs ---------------- */}
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

          {/* From the matrix, never spelled out here: plan copy written in a
              component is plan copy that drifts from the plan. */}
          <TransparencyRow label="Plan">
            <s-text>{PLAN_LABELS[plan]}</s-text>
          </TransparencyRow>

          <s-divider direction="inline"></s-divider>

          {/* True as of 15 Sep 2026 and not before: until then every date was
              read as a UTC wall clock, so this row would have been a lie in the
              one panel whose whole job is to be trusted. */}
          <TransparencyRow label="Dates and times">
            <s-text>
              {timezone} — start and end dates use your store&apos;s timezone.
            </s-text>
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
    </s-page>
  );
}

/** `3 discounts`, or `1 discount`. */
function countDiscounts(count: number): string {
  return `${count} discount${count === 1 ? "" : "s"}`;
}

/**
 * One combination checkbox. Its own component because `useNativeChange` is a
 * hook and cannot be called inside the `.map()` that renders the three.
 */
function CombinationCheckbox({
  field,
  label,
  checked,
  onToggle,
}: {
  field: CombinationField;
  label: string;
  checked: boolean;
  onToggle: (on: boolean) => void;
}) {
  const ref = useNativeChange<CheckedElement>((element) =>
    onToggle(element.checked),
  );

  return (
    <s-checkbox
      label={label}
      name={field}
      checked={checked}
      ref={ref}
    ></s-checkbox>
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
