import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { createCappedDiscount, isCodeTaken } from "../models/discounts.server";
import { ensureShopSettings } from "../models/settings.server";
import { getPlanForGate } from "../models/plan.server";
import { CheckoutPreviewModal } from "../components/CheckoutPreviewModal";
import { CheckoutReceipt } from "../components/CheckoutReceipt";
import {
  capDiscountMinor,
  capStartsAboveMinor,
  parseDecimalToMinor,
} from "../lib/cap";
import {
  CHECKOUT_NOTE_MAX_LENGTH,
  DEFAULT_CHECKOUT_NOTE,
  isCapScope,
} from "../lib/cap-config";
import type { AppliesTo, CapScope } from "../lib/cap-config";
import {
  campaignTooLongError,
  CHECKOUT_NOTE_NOT_ON_PLAN,
  COLLECTION_SCOPE_NEEDS_COLLECTIONS,
  combineDateTime,
  discountFormStateFrom,
  initialDiscountFormState,
  defaultEndDate,
  END_BEFORE_START_ERROR,
  USAGE_LIMIT_NOT_ON_PLAN,
  validateDiscountForm,
} from "../lib/discount-form";
import { can, gateFor, maxCampaignDays } from "../lib/plans";
import type { CapabilityGate } from "../lib/plans";
import type {
  DiscountFieldErrors,
  DiscountFormState,
  PickedResource,
} from "../lib/discount-form";
import {
  formatAmountPlain,
  formatDate,
  formatMoney,
  formatPercent,
} from "../lib/format";
import {
  useMergedRefs,
  useNativeChange,
  useRoomForPicker,
} from "../lib/polaris-events";
import type {
  CheckedElement,
  ValueElement,
  ValuesElement,
} from "../lib/polaris-events";

const SAVE_BAR_ID = "create-discount-save-bar";
const CHECKOUT_PREVIEW_ID = "create-checkout-preview";

/**
 * What one maximum covers, for the copy that has to name it.
 *
 * The arithmetic is the same under every scope — `min(basis × %, maximum)` —
 * but the basis is a cart, a line or a collection, and a number whose unit is
 * unstated is the thing this product exists not to do. "Say what a number
 * means, not just the number."
 */
const SCOPE_BASIS_LABEL: Record<CapScope, string> = {
  order: "Cart total",
  item: "Item total",
  collection: "Collection total",
};

/** The suffix that keeps "starts working above 1,000.00" true per scope. */
const SCOPE_PER_LABEL: Record<CapScope, string> = {
  order: "",
  item: " per item",
  collection: " per collection",
};

/** The live preview's slider range and chips, per §4.3 item 9. */
const SLIDER_MIN_MINOR = 5000;
const SLIDER_MAX_MINOR = 300000;
const SLIDER_STEP_MINOR = 1000;
const QUICK_CHIPS_MINOR = [20000, 80000, 140000, 250000];

/**
 * Ready-made caps, as the mockup lists them.
 *
 * A template only fills the two fields that define the offer. It deliberately
 * does not touch the code, the dates or the combinations: those are decisions
 * about one campaign, and silently rewriting a code the merchant already typed
 * is the kind of help nobody asked for.
 */
const TEMPLATES: { label: string; percentage: string; capAmount: string }[] = [
  { label: "Sitewide 15% / max 150", percentage: "15", capAmount: "150.00" },
  {
    label: "Black Friday 30% / max 200",
    percentage: "30",
    capAmount: "200.00",
  },
  { label: "Welcome 10% / max 25", percentage: "10", capAmount: "25.00" },
  { label: "VIP 20% / max 80", percentage: "20", capAmount: "80.00" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const [settings, plan] = await Promise.all([
    ensureShopSettings(session.shop),
    /**
     * The plan decides what this form may offer: which maximums, how long a
     * discount may run, and whether it may carry a usage limit.
     *
     * Read **live** from Shopify, not from the cached column. The cache is
     * only refreshed by opening the billing page or by coming back through
     * Shopify's approval redirect, so a merchant who upgrades and then comes
     * straight here — which is the obvious thing to do after paying for the
     * per-item maximum — would be shown the plan they had before. Reading live
     * costs a round trip, measured at ~1.9s on the dev tunnel; it runs
     * alongside the settings read rather than after it, and it buys a form
     * that is never a tier behind the merchant.
     *
     * The action checks the plan again before anything is written, so this
     * read decides what is offered and never what is allowed.
     */
    getPlanForGate({ shop: session.shop, admin }),
  ]);

  return {
    currencyCode: settings.currencyCode,
    checkoutNote: settings.defaultCheckoutNote || DEFAULT_CHECKOUT_NOTE,
    plan,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "check-code") {
    const code = String(form.get("code") ?? "");
    const taken = await isCodeTaken(admin, code);
    return { intent: "check-code" as const, code, taken };
  }

  if (intent !== "create") {
    return {
      intent: "unknown" as const,
      ok: false,
      message: "Unknown action.",
    };
  }

  // Revalidated with the same function the component uses, so a client that
  // skipped its checks cannot write a cap_config the Function would refuse (§6)
  // — and against the plan Shopify reports, not the one the form was rendered
  // with, so a stale tab cannot save what the plan no longer allows.
  const plan = await getPlanForGate({ shop: session.shop, admin });
  const parsed = validateDiscountForm(discountFormStateFrom(form), plan);
  if ("errors" in parsed) {
    return {
      intent: "create" as const,
      ok: false as const,
      fieldErrors: parsed.errors,
    };
  }

  const settings = await ensureShopSettings(session.shop);

  const result = await createCappedDiscount({
    shop: session.shop,
    admin,
    currencyCode: settings.currencyCode,
    ...parsed.value,
  });

  if (!result.ok) {
    return {
      intent: "create" as const,
      ok: false as const,
      message: result.message,
      upgradeUrl: result.upgradeUrl,
      fieldErrors: result.fieldErrors,
    };
  }

  return {
    intent: "create" as const,
    ok: true as const,
    code: result.code,
    title: result.title,
    mirrored: result.mirrored,
  };
};

/**
 * One maximum the merchant can choose, with whatever the plan has to say
 * about it.
 *
 * The description and its badge sit on one line, so they have to live in one
 * slot. `details` cannot hold the badge — Polaris extracts that slot to plain
 * text and the badge would arrive as the bare word "Pro" — and a badge alone
 * in `secondary-content` lands on a line of its own under the description.
 * Putting both in `secondary-content` is the only arrangement that keeps a
 * real badge beside its text.
 *
 * The cost: `details` is what Polaris wires to the input with
 * `aria-describedby`, and this gives that up. It is only spent when there is a
 * badge to show, which is when the choice is also disabled and so unreachable
 * by keyboard; the text is still read in document order. A choice the merchant
 * can actually pick keeps its `details`.
 */
function ScopeChoice({
  value,
  label,
  details,
  gate,
}: {
  value: CapScope;
  label: string;
  details: string;
  gate: CapabilityGate;
}) {
  if (gate.badge === null) {
    return (
      <s-choice value={value}>
        {label}
        <s-text slot="details" color="subdued">
          {details}
        </s-text>
      </s-choice>
    );
  }

  return (
    <s-choice value={value} disabled>
      {label}
      <s-stack
        slot="secondary-content"
        direction="inline"
        gap="small-300"
        alignItems="center"
      >
        <s-text color="subdued">{details}</s-text>
        <s-badge>{gate.badge}</s-badge>
      </s-stack>
    </s-choice>
  );
}

export default function CreateDiscountPage() {
  const { currencyCode, plan } = useLoaderData<typeof loader>();

  /** The plan's run-length ceiling in days, and whether it may cap uses. */
  const maxDays = maxCampaignDays(plan);
  const mayLimitUses = can(plan, "usageLimits");
  /** Whether this plan may replace the locked checkout wording with its own. */
  const mayRewordNote = can(plan, "customCheckoutWording");
  /** The two Pro maximums, read from the same matrix as everything else. */
  const itemGate = gateFor(plan, "itemMaximums");
  const collectionGate = gateFor(plan, "collectionMaximums");
  /** Entitled on Pro, not built yet — so a Pro merchant is told which it is. */
  const budgetGate = gateFor(plan, "campaignBudget");
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const saveFetcher = useFetcher<typeof action>();
  const codeFetcher = useFetcher<typeof action>();

  const [state, setState] = useState<DiscountFormState>(() =>
    initialDiscountFormState(new Date(), maxDays),
  );
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<DiscountFieldErrors>({});

  /** An automatic discount has no code, no usage limit and no per-customer cap. */
  const automatic = state.method === "automatic";
  const [simSubtotalMinor, setSimSubtotalMinor] = useState(140000);
  const seen = useRef<unknown>(null);

  const set = <K extends keyof DiscountFormState>(
    key: K,
    value: DiscountFormState[K],
  ) => {
    setState((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  // Derived numbers. All client-side and instant — no round trip per tick.
  const percentage = Number(state.percentage);
  const validPercentage =
    Number.isInteger(percentage) && percentage >= 1 && percentage <= 100;
  const capMinor = parseDecimalToMinor(state.capAmount);
  const ready = validPercentage && capMinor !== null && capMinor > 0;

  const startsAboveMinor = useMemo(
    () => (ready ? capStartsAboveMinor(capMinor!, percentage) : null),
    [ready, capMinor, percentage],
  );

  const startsAt = combineDateTime(state.startDate, state.startTime);
  const endsAt = state.endDateOn
    ? combineDateTime(state.endDate, state.endTime)
    : null;

  /**
   * The range error, live under the field rather than only on save.
   *
   * Deliberately narrow: only the "after the start date" case, and only once
   * both halves parse. An empty or half-typed date is not an error yet — that
   * is what put a red "Enter an end date" under an untouched control before,
   * and `validateDiscountForm` still catches it on save.
   */
  const endDateRangeError =
    startsAt !== null &&
    endsAt !== null &&
    endsAt.getTime() <= startsAt.getTime()
      ? END_BEFORE_START_ERROR
      : undefined;

  /**
   * The plan's ceiling, live under the field for the same reason the range
   * error is: a merchant who picks a date three months out should be told
   * before saving, not after.
   */
  const campaignLengthError =
    maxDays !== null &&
    startsAt !== null &&
    endsAt !== null &&
    endsAt.getTime() - startsAt.getTime() > maxDays * 24 * 60 * 60 * 1000
      ? campaignTooLongError(maxDays)
      : undefined;

  const endDateError =
    errors.endDate ?? endDateRangeError ?? campaignLengthError;

  /** `11 Sep 2026, 00:00` for the summary, or a dash when it does not parse. */
  const summaryMoment = (at: Date | null, time: string) =>
    at === null ? "—" : `${formatDate(at)}, ${time}`;

  /**
   * `150 ÷ 15% = 1,000` is only an equals sign when the division comes out
   * even. `capStartsAboveMinor` rounds to the nearest cent, so anything else
   * gets `≈` — the aside is there to show the merchant the sum, and a sum that
   * quietly rounds is worse than no sum.
   */
  const startsAboveIsExact = ready && (capMinor! * 100) % percentage === 0;

  const preview = useMemo(
    () =>
      ready ? capDiscountMinor(simSubtotalMinor, percentage, capMinor!) : null,
    [ready, simSubtotalMinor, percentage, capMinor],
  );

  const money = (minor: number) => formatMoney(minor, currencyCode);

  /**
   * What the buyer's receipt shows, kept honest about both halves.
   *
   * The note is whatever the merchant may actually save: their own wording on
   * a plan that allows it, the locked wording otherwise. Previewing a note the
   * form is about to refuse would be a fiction — §12.4's one dataset.
   *
   * The code line is the same: an automatic discount has no code, so the
   * receipt shows the rule on its own, exactly as the Function builds it.
   */
  const noteForPreview = mayRewordNote
    ? state.checkoutNote.trim() || DEFAULT_CHECKOUT_NOTE
    : DEFAULT_CHECKOUT_NOTE;

  const receiptCode = automatic ? "" : state.code || "CODE";

  // The contextual save bar (§4.3). Programmatic, because the labels are ours.
  useEffect(() => {
    if (dirty) {
      shopify.saveBar.show(SAVE_BAR_ID);
    } else {
      shopify.saveBar.hide(SAVE_BAR_ID);
    }
  }, [dirty, shopify]);

  // The on-blur uniqueness check (§4.3).
  useEffect(() => {
    const data = codeFetcher.data;
    if (!data || data.intent !== "check-code") {
      return;
    }

    if (data.taken && data.code.toUpperCase() === state.code.toUpperCase()) {
      setErrors((current) => ({
        ...current,
        code: "That code is already used by a discount in this shop.",
      }));
    }
  }, [codeFetcher.data, state.code]);

  useEffect(() => {
    const data = saveFetcher.data;
    if (!data || data === seen.current || data.intent !== "create") {
      return;
    }
    seen.current = data;

    if (data.ok) {
      setDirty(false);
      shopify.saveBar.hide(SAVE_BAR_ID);
      // An automatic discount has no code to name it by, so the toast uses
      // whatever the merchant actually called it.
      shopify.toast.show(`${data.code || data.title} is live at checkout`);
      navigate("/app/discounts");
      return;
    }

    if (data.fieldErrors) {
      setErrors(data.fieldErrors);
    }

    if (data.message) {
      shopify.toast.show(data.message, {
        isError: true,
        ...(data.upgradeUrl
          ? {
              action: "View plans",
              onAction: () => navigate("/app/billing"),
            }
          : {}),
      });
    }
  }, [saveFetcher.data, shopify, navigate]);

  // Polaris fields that only emit `change` need a native listener; React's
  // onChange never fires for a custom element. See app/lib/polaris-events.ts.
  const onStartDateChange = useNativeChange<ValueElement>((element) =>
    set("startDate", element.value),
  );
  const onEndDateChange = useNativeChange<ValueElement>((element) =>
    set("endDate", element.value),
  );

  // Both date fields can end up near the bottom of the app frame, where the
  // calendar would open past its edge. See `useRoomForPicker`.
  const startDateRef = useMergedRefs<ValueElement>(
    onStartDateChange,
    useRoomForPicker<ValueElement>(),
  );
  const endDateRef = useMergedRefs<ValueElement>(
    onEndDateChange,
    useRoomForPicker<ValueElement>(),
  );
  // A choice list reports its selection as a list even when only one choice
  // can be picked, so the first entry is the answer.
  const onMethodChange = useNativeChange<ValuesElement>((element) => {
    const picked = element.values?.[0];
    if (picked === "code" || picked === "automatic") {
      set("method", picked);
    }
  });

  const onScopeChange = useNativeChange<ValuesElement>((element) => {
    const picked = element.values?.[0];
    if (isCapScope(picked)) {
      set("scope", picked);
    }
  });

  const onAppliesToChange = useNativeChange<ValuesElement>((element) => {
    const picked = element.values?.[0];
    if (picked === "all" || picked === "collections" || picked === "products") {
      set("appliesTo", picked as AppliesTo);
    }
  });

  const onUsageLimitOnChange = useNativeChange<CheckedElement>((element) =>
    set("usageLimitOn", element.checked),
  );
  const onOncePerCustomerChange = useNativeChange<CheckedElement>((element) =>
    set("oncePerCustomer", element.checked),
  );
  const onCombinesChange = useNativeChange<ValuesElement>((element) => {
    const values = element.values ?? [];
    setState((current) => ({
      ...current,
      combinesProduct: values.includes("product"),
      combinesOrder: values.includes("order"),
      combinesShipping: values.includes("shipping"),
    }));
    setDirty(true);
  });

  /**
   * Ticking "Set an end date" prefills a date a month out rather than leaving
   * an empty field that fails validation before the merchant has touched it —
   * which is what put a red "Enter an end date" under an untouched control.
   */
  const onEndDateOnChange = useNativeChange<CheckedElement>((element) => {
    const on = element.checked;

    setState((current) => ({
      ...current,
      endDateOn: on,
      endDate:
        on && current.endDate === ""
          ? defaultEndDate(current.startDate, maxDays)
          : current.endDate,
    }));
    setDirty(true);
    setErrors((current) => ({
      ...current,
      endDateOn: undefined,
      endDate: undefined,
    }));
  });

  /**
   * Pick the collections or products the percentage applies to.
   *
   * `selectionIds` seeds the picker with what is already chosen, so reopening
   * it to add one more does not start from nothing and silently drop the rest.
   * Cancelling returns undefined and must leave the selection alone — treating
   * a cancel as "chose nothing" would wipe the list the merchant just built.
   */
  const pick = async (type: "collection" | "product") => {
    const field = type === "collection" ? "collections" : "products";
    const already = state[field];

    const picked = await shopify.resourcePicker({
      type,
      multiple: true,
      selectionIds: already.map((resource) => ({ id: resource.id })),
    });

    if (!picked) {
      return;
    }

    set(
      field,
      (picked as unknown as { id: string; title?: string }[]).map(
        (resource) => ({
          id: resource.id,
          title: resource.title ?? resource.id,
        }),
      ),
    );
  };

  const validate = (): boolean => {
    const result = validateDiscountForm(state, plan);

    if ("errors" in result) {
      setErrors(result.errors);
      return false;
    }

    setErrors({});
    return true;
  };

  const save = () => {
    if (!validate()) {
      return;
    }

    saveFetcher.submit(
      {
        intent: "create",
        method: state.method,
        code: automatic ? "" : state.code.trim().toUpperCase(),
        title: state.title.trim(),
        scope: state.scope,
        appliesTo: state.appliesTo,
        // One JSON field each, because a picked resource is an id and a title
        // together and FormData has no way to keep the pair without inventing
        // a delimiter some product name will eventually contain.
        collections: JSON.stringify(state.collections),
        products: JSON.stringify(state.products),
        checkoutNote: state.checkoutNote,
        percentage: state.percentage,
        capAmount: state.capAmount,
        startDate: state.startDate,
        startTime: state.startTime,
        endDateOn: String(state.endDateOn),
        endDate: state.endDate,
        endTime: state.endTime,
        usageLimitOn: String(state.usageLimitOn),
        usageLimit: state.usageLimit,
        oncePerCustomer: String(state.oncePerCustomer),
        combinesProduct: String(state.combinesProduct),
        combinesOrder: String(state.combinesOrder),
        combinesShipping: String(state.combinesShipping),
      },
      { method: "post" },
    );
  };

  /**
   * Fill the percentage and the maximum from a template.
   *
   * Both fields at once, in one state update, so the preview and the summary
   * never render a 30% against last template's maximum — a figure that was
   * never anyone's offer. Their errors clear with them.
   */
  const applyTemplate = (template: {
    percentage: string;
    capAmount: string;
  }) => {
    setState((current) => ({
      ...current,
      percentage: template.percentage,
      capAmount: template.capAmount,
    }));
    setDirty(true);
    setErrors((current) => ({
      ...current,
      percentage: undefined,
      capAmount: undefined,
    }));
  };

  const discard = () => {
    setState(initialDiscountFormState());
    setErrors({});
    setDirty(false);
  };

  const saving = saveFetcher.state !== "idle";
  const notMirrored =
    saveFetcher.data?.intent === "create" &&
    saveFetcher.data.ok &&
    !saveFetcher.data.mirrored;

  return (
    <s-page heading="Create capped discount">
      <ui-save-bar id={SAVE_BAR_ID}>
        <button variant="primary" onClick={save} disabled={saving}>
          Save &amp; activate
        </button>
        <button onClick={discard}>Discard</button>
      </ui-save-bar>

      <s-paragraph color="subdued">
        A percentage discount that stops at a maximum amount.
      </s-paragraph>

      {notMirrored && (
        <s-banner
          tone="warning"
          heading="Created in Shopify, not yet in MaxOff"
        >
          {saveFetcher.data?.intent === "create" && saveFetcher.data.ok
            ? saveFetcher.data.code || saveFetcher.data.title
            : "The discount"}{" "}
          is live and capping at checkout, but MaxOff could not write its own
          copy. It will appear in your list once MaxOff resyncs.
        </s-banner>
      )}

      {/* ---------------- 1 · Method ---------------- */}
      <s-section heading="Method">
        <s-choice-list
          label="Discount method"
          labelAccessibilityVisibility="exclusive"
          name="method"
          values={[state.method]}
          ref={onMethodChange}
        >
          <s-choice value="code">
            Discount code
            <s-text slot="details" color="subdued">
              Customers enter a code at checkout.
            </s-text>
          </s-choice>
          <s-choice value="automatic">
            Automatic discount
            <s-text slot="details" color="subdued">
              Applies with no code.
            </s-text>
          </s-choice>
        </s-choice-list>

        {/* An automatic discount has no code, so Shopify identifies it by
            title — and the merchant needs somewhere to write that title. The
            two fields are alternatives, never both: swapping them in place
            keeps the card one row tall either way. */}
        {automatic ? (
          <s-text-field
            label="Discount name"
            name="title"
            value={state.title}
            placeholder="Summer sale"
            details="Customers do not see this. It is how you find the discount in Shopify."
            onInput={(event) => set("title", event.currentTarget.value)}
            {...(errors.title ? { error: errors.title } : {})}
          ></s-text-field>
        ) : (
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
            <s-text-field
              label="Discount code"
              name="code"
              value={state.code}
              placeholder="SUMMER15"
              onInput={(event) =>
                set("code", event.currentTarget.value.toUpperCase())
              }
              onBlur={() => {
                const code = state.code.trim();
                if (code !== "") {
                  codeFetcher.submit(
                    { intent: "check-code", code },
                    { method: "post" },
                  );
                }
              }}
              {...(errors.code ? { error: errors.code } : {})}
            ></s-text-field>
            <s-button onClick={() => set("code", generateCode())}>
              Generate
            </s-button>
          </s-grid>
        )}
      </s-section>

      {/* ---------------- 2 · Value and maximum ---------------- */}
      <s-section heading="Value and maximum">
        {/* One block stack for the whole section: `s-divider` only stretches
            to full width inside a stack, exactly as on the settings screen. */}
        <s-stack direction="block" gap="base">
          <s-grid
            gridTemplateColumns="@container (inline-size <= 500px) 1fr, 1fr 1fr"
            gap="base"
          >
            <s-number-field
              label="Percentage off"
              name="percentage"
              suffix="%"
              min={1}
              max={100}
              step={1}
              value={state.percentage}
              onInput={(event) => set("percentage", event.currentTarget.value)}
              {...(errors.percentage ? { error: errors.percentage } : {})}
            ></s-number-field>

            <s-money-field
              label="Maximum discount"
              name="capAmount"
              currencyCode="auto"
              min={0}
              value={state.capAmount}
              onInput={(event) => set("capAmount", event.currentTarget.value)}
              {...(errors.capAmount ? { error: errors.capAmount } : {})}
            ></s-money-field>
          </s-grid>

          {ready && startsAboveMinor !== null ? (
            <div className="maxoff-cap-callout">
              <span>
                The maximum starts working above
                {SCOPE_PER_LABEL[state.scope]}
              </span>
              <strong className="maxoff-cap-callout__value maxoff-tabular">
                {money(startsAboveMinor)}
              </strong>
              {/* The sum behind the figure. "÷" and "≈" are the explanation,
                  not decoration, so it is spelled out for screen readers
                  rather than hidden from them. */}
              <span className="maxoff-cap-callout__working maxoff-tabular">
                <span aria-hidden="true">
                  {formatAmountPlain(capMinor!)} ÷ {formatPercent(percentage)}{" "}
                  {startsAboveIsExact ? "=" : "≈"}{" "}
                  {formatAmountPlain(startsAboveMinor)}
                </span>
                <span className="maxoff-visually-hidden">
                  {formatAmountPlain(capMinor!)} divided by{" "}
                  {formatPercent(percentage)}{" "}
                  {startsAboveIsExact ? "equals" : "is about"}{" "}
                  {formatAmountPlain(startsAboveMinor)}
                </span>
              </span>
            </div>
          ) : (
            <s-paragraph color="subdued">
              Enter a percentage and a maximum to see where the maximum starts
              working.
            </s-paragraph>
          )}

          <s-divider direction="inline"></s-divider>

          <s-choice-list
            label="The maximum applies to"
            name="scope"
            values={[state.scope]}
            ref={onScopeChange}
            {...(errors.scope ? { error: errors.scope } : {})}
          >
            <s-choice value="order">
              The whole order
              <s-text slot="details" color="subdued">
                One maximum for the entire cart.
              </s-text>
            </s-choice>
            <ScopeChoice
              value="item"
              label="Each item"
              details="A separate maximum on every line."
              gate={itemGate}
            />
            <ScopeChoice
              value="collection"
              label="Each collection"
              details="A separate maximum per collection."
              gate={collectionGate}
            />
          </s-choice-list>

          {/* Said once, under the list, rather than as a third disabled
              choice: the merchant has already picked this maximum and the
              thing to change is which products the discount applies to, two
              sections down. */}
          {state.scope === "collection" && state.appliesTo !== "collections" && (
            <s-paragraph color="subdued">
              {COLLECTION_SCOPE_NEEDS_COLLECTIONS}
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      {/* ---------------- 3 · Applies to ---------------- */}
      <s-section heading="Applies to">
        <s-stack direction="block" gap="base">
          <s-choice-list
            label="Which products the discount applies to"
            labelAccessibilityVisibility="exclusive"
            name="appliesTo"
            values={[state.appliesTo]}
            ref={onAppliesToChange}
          >
            <s-choice value="all">
              All products
              <s-text slot="details" color="subdued">
                The percentage applies to the whole cart subtotal.
              </s-text>
            </s-choice>
            <s-choice value="collections">
              Specific collections
              <s-text slot="details" color="subdued">
                The percentage applies to chosen collections only.
              </s-text>
            </s-choice>
            <s-choice value="products">
              Specific products
              <s-text slot="details" color="subdued">
                The percentage applies to chosen products only.
              </s-text>
            </s-choice>
          </s-choice-list>

          {state.appliesTo !== "all" && (
            <PickedList
              kind={state.appliesTo}
              picked={
                state.appliesTo === "collections"
                  ? state.collections
                  : state.products
              }
              error={
                state.appliesTo === "collections"
                  ? errors.collections
                  : errors.products
              }
              onPick={() =>
                pick(
                  state.appliesTo === "collections" ? "collection" : "product",
                )
              }
              onRemove={(id) =>
                state.appliesTo === "collections"
                  ? set(
                      "collections",
                      state.collections.filter(
                        (resource) => resource.id !== id,
                      ),
                    )
                  : set(
                      "products",
                      state.products.filter((resource) => resource.id !== id),
                    )
              }
            />
          )}

          {/* Only under one maximum for the order. Under the per-item and
              per-collection maximums the heading would be false, and the last
              sentence would be selling a Pro merchant what they already pay
              for — so it is not shown at all rather than reworded. */}
          {state.appliesTo !== "all" && state.scope === "order" && (
            <s-banner tone="info" heading="The maximum is still one maximum">
              The percentage is taken on the chosen items only, and the maximum
              still applies to the whole order.
              {itemGate.allowed
                ? " A separate maximum on each item is above, under the maximum."
                : " A separate maximum on each item is a Pro feature."}
            </s-banner>
          )}
        </s-stack>
      </s-section>

      {/* ---------------- 4 · Minimum requirements ---------------- */}
      <s-section heading="Minimum requirements">
        <s-banner tone="info" heading="Not available yet">
          Shopify&apos;s app-discount API has no field for a minimum subtotal or
          quantity, so a minimum can only be enforced inside the cap engine
          itself. That is a change to the Function, not to this form.
        </s-banner>

        <s-choice-list
          label="Minimum requirements"
          labelAccessibilityVisibility="exclusive"
          name="minimum"
          values={["none"]}
        >
          <s-choice value="none">
            No minimum requirements
            <s-text slot="details" color="subdued">
              {automatic
                ? "Every cart gets the discount."
                : "Every cart that uses the code gets the discount."}
            </s-text>
          </s-choice>
          {/* Badge beside description, not beside the label — see the note
              in the "Applies to" section. The description says what the
              option would do; the badge says why it cannot yet. */}
          <s-choice value="subtotal" disabled>
            Minimum purchase amount
            <s-stack
              slot="secondary-content"
              direction="inline"
              gap="small-300"
              alignItems="center"
            >
              <s-text color="subdued">
                A minimum subtotal before the discount applies.
              </s-text>
              <s-badge>Needs the cap engine</s-badge>
            </s-stack>
          </s-choice>
          <s-choice value="quantity" disabled>
            Minimum quantity of items
            <s-stack
              slot="secondary-content"
              direction="inline"
              gap="small-300"
              alignItems="center"
            >
              <s-text color="subdued">
                A minimum number of items before the discount applies.
              </s-text>
              <s-badge>Needs the cap engine</s-badge>
            </s-stack>
          </s-choice>
        </s-choice-list>
      </s-section>

      {/* ---------------- 5 · Customers and usage limits ---------------- */}
      <s-section heading="Customers and usage limits">
        {/* One block stack, so the divider below stretches the full
            width — as a direct child of `s-section` it collapses. */}
        <s-stack direction="block" gap="base">
          <s-choice-list
            label="Who can use this discount"
            name="eligibility"
            values={["all"]}
          >
            <s-choice value="all">
              All customers
              <s-text slot="details" color="subdued">
                {automatic
                  ? "Everyone, with no code to enter."
                  : "Anyone who enters the code."}
              </s-text>
            </s-choice>
            <s-choice value="segments" disabled>
              Specific customer segments
              <s-stack
                slot="secondary-content"
                direction="inline"
                gap="small-300"
                alignItems="center"
              >
                <s-text color="subdued">
                  Limit the code to chosen customer segments.
                </s-text>
                <s-badge>Later version</s-badge>
              </s-stack>
            </s-choice>
          </s-choice-list>

          {/* Usage limits belong to a code.

              `DiscountAutomaticAppInput` carries no `usageLimit` and no
              `appliesOncePerCustomer`: there is no code to ration, so Shopify
              does not offer the fields and the form must not either. These are
              hidden rather than disabled — a disabled control implies a plan
              could unlock it, and no plan can. */}
          {!automatic && (
            <>
              <s-divider direction="inline"></s-divider>

              {/* A usage limit is a Growth entitlement. On Free the control is
              shown disabled with the badge rather than hidden: a merchant
              cannot ask for a plan whose features they never saw. Same grid as
              the campaign budget below, for the same reason. */}
              {mayLimitUses ? (
                <>
                  <s-checkbox
                    label="Limit the total number of uses"
                    name="usageLimitOn"
                    checked={state.usageLimitOn}
                    ref={onUsageLimitOnChange}
                  ></s-checkbox>

                  {state.usageLimitOn && (
                    <s-number-field
                      label="Total uses"
                      name="usageLimit"
                      min={1}
                      step={1}
                      value={state.usageLimit}
                      onInput={(event) =>
                        set("usageLimit", event.currentTarget.value)
                      }
                      {...(errors.usageLimit
                        ? { error: errors.usageLimit }
                        : {})}
                    ></s-number-field>
                  )}
                </>
              ) : (
                <s-grid
                  gridTemplateColumns="max-content auto"
                  gap="small-300"
                  alignItems="baseline"
                >
                  <s-checkbox
                    label="Limit the total number of uses"
                    name="usageLimitOn"
                    details={USAGE_LIMIT_NOT_ON_PLAN}
                    disabled
                  ></s-checkbox>
                  <s-badge>{gateFor(plan, "usageLimits").badge}</s-badge>
                </s-grid>
              )}

              <s-checkbox
                label="Limit to one use per customer"
                name="oncePerCustomer"
                checked={state.oncePerCustomer}
                ref={onOncePerCustomerChange}
              ></s-checkbox>

              {/* `s-checkbox` takes no children and its `details` is a plain
              string, so the badge cannot go inside it. A grid puts the two side
              by side instead: `max-content` keeps the checkbox at its natural
              width, which an inline stack would not — a form control stretches
              and would push the badge onto its own row. */}
              <s-grid
                gridTemplateColumns="max-content auto"
                gap="small-300"
                alignItems="baseline"
              >
                <s-checkbox
                  label="Stop the code once it has given away a total amount"
                  name="budgetCap"
                  details="A budget for the whole campaign, not one order."
                  disabled
                ></s-checkbox>
                <s-badge>{budgetGate.badge}</s-badge>
              </s-grid>
            </>
          )}
        </s-stack>
      </s-section>

      {/* ---------------- 6 · Combinations ---------------- */}
      <s-section heading="Combinations">
        <s-choice-list
          label="This discount can be combined with"
          name="combines"
          multiple
          values={[
            ...(state.combinesProduct ? ["product"] : []),
            ...(state.combinesOrder ? ["order"] : []),
            ...(state.combinesShipping ? ["shipping"] : []),
          ]}
          ref={onCombinesChange}
        >
          <s-choice value="product">
            Product discounts
            <s-text slot="details" color="subdued">
              Discounts on individual products.
            </s-text>
          </s-choice>
          <s-choice value="order">
            Order discounts
            <s-text slot="details" color="subdued">
              Other discounts on the order total.
            </s-text>
          </s-choice>
          <s-choice value="shipping">
            Shipping discounts
            <s-text slot="details" color="subdued">
              Free or reduced shipping.
            </s-text>
          </s-choice>
        </s-choice-list>

        <s-banner tone="info" heading="The maximum still holds">
          When discounts are combined, the maximum still holds. MaxOff caps its
          own share only — it never touches the other discount.
        </s-banner>
      </s-section>

      {/* ---------------- 7 · What the customer sees ---------------- */}
      <s-section heading="What the customer sees">
        <s-stack direction="block" gap="base">
          {/* The note the buyer reads when the maximum is what decided the
              amount. The Function appends it to the discount line, and only on
              a capped cart — below the maximum it would not be true.

              Rewording it is a Growth entitlement. On Free the field is shown
              disabled with its badge rather than hidden: a merchant cannot ask
              for a plan whose features they never saw. Same arrangement as the
              usage limit above. */}
          {mayRewordNote ? (
            <s-text-field
              label="Checkout note"
              name="checkoutNote"
              value={state.checkoutNote}
              placeholder={DEFAULT_CHECKOUT_NOTE}
              details="Shown to the customer only when the maximum applies."
              maxLength={CHECKOUT_NOTE_MAX_LENGTH}
              onInput={(event) =>
                set("checkoutNote", event.currentTarget.value)
              }
              {...(errors.checkoutNote ? { error: errors.checkoutNote } : {})}
            ></s-text-field>
          ) : (
            /* The badge has to sit on the label's line, and `s-text-field`
               takes its label as a string. So the visible label is ours and
               the field's own label is kept for assistive technology only.
               The field is disabled, so nothing is lost by the visible text
               not being a `<label>` that focuses it. */
            <s-stack direction="block" gap="small-300">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text>Checkout note</s-text>
                <s-badge>{gateFor(plan, "customCheckoutWording").badge}</s-badge>
              </s-stack>
              <s-text-field
                label="Checkout note"
                labelAccessibilityVisibility="exclusive"
                name="checkoutNote"
                value={DEFAULT_CHECKOUT_NOTE}
                details={CHECKOUT_NOTE_NOT_ON_PLAN}
                disabled
                maxLength={CHECKOUT_NOTE_MAX_LENGTH}
              ></s-text-field>
            </s-stack>
          )}

          {/* The same receipt the "See checkout view" modal shows, on the
              same simulated cart as the live preview — one dataset, §12.4. */}
          {ready ? (
            <CheckoutReceipt
              code={receiptCode}
              percentage={percentage}
              capMinor={capMinor!}
              currencyCode={currencyCode}
              subtotalMinor={simSubtotalMinor}
              checkoutNote={noteForPreview}
            />
          ) : (
            <s-paragraph color="subdued">
              Enter a percentage and a maximum to see the buyer&apos;s checkout
              lines.
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      {/* ---------------- 8 · Active dates ---------------- */}
      <s-section heading="Active dates">
        <s-grid
          gridTemplateColumns="@container (inline-size <= 500px) 1fr, 1fr 1fr"
          gap="base"
        >
          <s-date-field
            label="Start date"
            name="startDate"
            value={state.startDate}
            defaultView={pickerView(state.startDate)}
            ref={startDateRef}
            {...(errors.startDate ? { error: errors.startDate } : {})}
          ></s-date-field>
          {/* Polaris has no time field in this version, so the time is a
              validated text field rather than an invented component. */}
          <s-text-field
            label="Start time (UTC, 24-hour)"
            name="startTime"
            value={state.startTime}
            placeholder="09:00"
            onInput={(event) => set("startTime", event.currentTarget.value)}
          ></s-text-field>
        </s-grid>

        {/* On a plan with a run-length ceiling the end date is not optional,
            so the box is ticked and locked rather than left for the merchant
            to discover on save. */}
        <s-checkbox
          label="Set an end date"
          name="endDateOn"
          checked={state.endDateOn}
          {...(maxDays === null
            ? {}
            : {
                disabled: true,
                details: `Your plan runs a discount for up to ${maxDays} days.`,
              })}
          ref={onEndDateOnChange}
        ></s-checkbox>

        {state.endDateOn && (
          <s-grid
            gridTemplateColumns="@container (inline-size <= 500px) 1fr, 1fr 1fr"
            gap="base"
          >
            {/* `allow` greys out every day before the start date in the
                picker. `defaultView` opens on the end date's own month, or on
                the start date's when the field is empty — never on today. */}
            <s-date-field
              label="End date"
              name="endDate"
              value={state.endDate}
              allow={`${state.startDate}--`}
              defaultView={
                pickerView(state.endDate) ?? pickerView(state.startDate)
              }
              ref={endDateRef}
              {...(endDateError ? { error: endDateError } : {})}
            ></s-date-field>
            <s-text-field
              label="End time (UTC, 24-hour)"
              name="endTime"
              value={state.endTime}
              placeholder="23:59"
              onInput={(event) => set("endTime", event.currentTarget.value)}
            ></s-text-field>
          </s-grid>
        )}
      </s-section>

      {/* Scroll room for the date pickers.

          "Active dates" is the last card on the page, so its fields sit at the
          very bottom of the scrollable area. `s-date-field` opens its calendar
          below the field as a `position: fixed` dialog, and in an embedded app
          nothing can be drawn past the iframe's viewport — so the day grid fell
          outside the frame and could not be reached. `useRoomForPicker` scrolls
          the field up to make space, but a page cannot scroll past its own end:
          without this the field could only rise 82px of the ~220px needed.

          Empty space below the last card, which costs nothing to look at and is
          the difference between a usable picker and an unusable one. */}
      <div className="maxoff-picker-scroll-room" aria-hidden="true"></div>

      {/* ---------------- Right column: Summary, then the preview ----------
          §12.2: the mockup buries the preview at the bottom of a 2,400px form,
          eleven cards below the fields that drive it. It belongs here, beside
          them, and stays on screen while the form scrolls. */}
      <s-box slot="aside">
        <div style={{ position: "sticky", top: "16px" }}>
          <s-stack direction="block" gap="base">
            <s-section heading="Summary">
              <s-stack direction="block" gap="base">
                {/* The whole discount in one sentence, on the one branded
                    surface this card gets. §5 allows orange as a card tint
                    with a 1px line and as brand text — the two numbers that
                    define the offer are the only things wearing it, so the
                    colour still means something by the time a merchant reads
                    the rows below. */}
                <div className="maxoff-summary-headline">
                  {ready ? (
                    <>
                      <strong className="maxoff-summary-headline__figure">
                        {formatPercent(percentage)} off
                      </strong>
                      , never more than{" "}
                      <strong className="maxoff-summary-headline__figure maxoff-tabular">
                        {money(capMinor!)}
                      </strong>
                      .
                    </>
                  ) : (
                    <span className="maxoff-summary-headline__pending">
                      Enter a percentage and a maximum to see the offer in one
                      line.
                    </span>
                  )}
                </div>

                <s-stack direction="block" gap="small-200">
                  {/* A code discount is known by its code; an automatic one
                      has none, so the row names what it actually has. */}
                  {automatic ? (
                    <SummaryRow label="Name" value={state.title || "—"} />
                  ) : (
                    <SummaryRow label="Code" value={state.code || "—"} />
                  )}
                  <SummaryRow
                    label="Method"
                    value={automatic ? "Automatic" : "Discount code"}
                  />
                  <SummaryRow label="Type" value="Percentage, capped" />
                  <SummaryRow
                    label="Maximum"
                    value={capMinor === null ? "—" : money(capMinor)}
                  />
                  <SummaryRow
                    label="Cap starts above"
                    value={
                      startsAboveMinor === null ? "—" : money(startsAboveMinor)
                    }
                  />
                  <SummaryRow
                    label="Applies to"
                    value={appliesToLabel(state)}
                  />
                  <SummaryRow label="Customers" value="All customers" />
                  {!automatic && (
                    <SummaryRow label="Uses" value={usesLabel(state)} />
                  )}
                  <SummaryRow
                    label="Combines with"
                    value={combinesLabel(state)}
                  />
                  <SummaryRow
                    label="Starts"
                    value={summaryMoment(startsAt, state.startTime)}
                  />
                  <SummaryRow
                    label="Ends"
                    value={
                      state.endDateOn
                        ? summaryMoment(endsAt, state.endTime)
                        : "No end date"
                    }
                  />
                </s-stack>
              </s-stack>
            </s-section>

            <s-section heading="Live preview">
              {preview === null ? (
                <s-paragraph color="subdued">
                  Enter a percentage and a maximum to see what a cart would get.
                </s-paragraph>
              ) : (
                <s-stack direction="block" gap="base">
                  <label
                    htmlFor="cart-size"
                    style={{ fontSize: "13px", fontWeight: 500 }}
                  >
                    {SCOPE_BASIS_LABEL[state.scope]}: {money(simSubtotalMinor)}
                  </label>
                  <input
                    id="cart-size"
                    type="range"
                    min={SLIDER_MIN_MINOR}
                    max={SLIDER_MAX_MINOR}
                    step={SLIDER_STEP_MINOR}
                    value={simSubtotalMinor}
                    onChange={(event) =>
                      setSimSubtotalMinor(Number(event.target.value))
                    }
                    style={{
                      width: "100%",
                      accentColor: "var(--maxoff-orange-500)",
                    }}
                  />

                  <s-button-group>
                    {QUICK_CHIPS_MINOR.map((minor) => (
                      <s-button
                        key={minor}
                        variant={
                          minor === simSubtotalMinor ? "primary" : "tertiary"
                        }
                        onClick={() => setSimSubtotalMinor(minor)}
                      >
                        {money(minor).replace(` ${currencyCode}`, "")}
                      </s-button>
                    ))}
                  </s-button-group>

                  <div
                    className="maxoff-tabular"
                    style={{
                      fontSize: "26px",
                      fontWeight: 650,
                      letterSpacing: "-0.5px",
                      color: "var(--maxoff-orange-500)",
                    }}
                  >
                    {money(preview.givenMinor)}
                  </div>

                  <s-text color="subdued">
                    {preview.capped ? (
                      <>
                        instead of <del>{money(preview.uncappedMinor)}</del> —
                        the maximum stopped it.
                      </>
                    ) : (
                      <>
                        the full {formatPercent(percentage)} — still under your
                        maximum.
                      </>
                    )}
                  </s-text>

                  <PreviewBars
                    uncappedMinor={preview.uncappedMinor}
                    givenMinor={preview.givenMinor}
                    currencyCode={currencyCode}
                  />

                  <s-text type="strong">
                    {preview.capped
                      ? `You keep ${money(preview.keptMinor)} on this order.`
                      : `This cart is below ${money(
                          startsAboveMinor ?? 0,
                        )}, so the maximum does not apply yet.`}
                  </s-text>

                  <s-button commandFor={CHECKOUT_PREVIEW_ID} command="--show">
                    See checkout view
                  </s-button>
                </s-stack>
              )}
            </s-section>

            <s-section heading="Templates">
              <s-paragraph color="subdued">
                Ready-made caps for common campaigns. Choosing one fills in the
                percentage and the maximum. Nothing else is changed.
              </s-paragraph>
              <s-stack direction="block" gap="small-200">
                {TEMPLATES.map((template) => (
                  <s-button
                    key={template.label}
                    onClick={() => applyTemplate(template)}
                  >
                    {template.label}
                  </s-button>
                ))}
              </s-stack>
            </s-section>
          </s-stack>
        </div>
      </s-box>

      <CheckoutPreviewModal
        id={CHECKOUT_PREVIEW_ID}
        code={receiptCode}
        percentage={validPercentage ? percentage : 0}
        capMinor={capMinor ?? 0}
        currencyCode={currencyCode}
        subtotalMinor={simSubtotalMinor}
        checkoutNote={noteForPreview}
      />
    </s-page>
  );
}

/**
 * "Without a cap" beside "With MaxOff", scaled to the larger value.
 *
 * §12.5: the lengths are truthful — the uncapped bar really is longer — but the
 * loss reads as a loss, muted and labelled "would have been given away",
 * rather than as a bigger, better number.
 */
function PreviewBars({
  uncappedMinor,
  givenMinor,
  currencyCode,
}: {
  uncappedMinor: number;
  givenMinor: number;
  currencyCode: string;
}) {
  const largest = Math.max(uncappedMinor, givenMinor, 1);
  const width = (minor: number) => `${Math.round((minor / largest) * 100)}%`;

  return (
    <s-stack direction="block" gap="small-300">
      <s-stack direction="block" gap="small-500">
        <s-text color="subdued">
          Would have been given away: {formatMoney(uncappedMinor, currencyCode)}
        </s-text>
        <div
          style={{
            height: "8px",
            borderRadius: "4px",
            background: "var(--maxoff-track)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: width(uncappedMinor),
              height: "100%",
              background: "var(--maxoff-loss)",
            }}
          />
        </div>
      </s-stack>

      <s-stack direction="block" gap="small-500">
        <s-text color="subdued">
          With MaxOff: {formatMoney(givenMinor, currencyCode)}
        </s-text>
        <div
          style={{
            height: "8px",
            borderRadius: "4px",
            background: "var(--maxoff-track)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: width(givenMinor),
              height: "100%",
              background: "var(--maxoff-orange-500)",
            }}
          />
        </div>
      </s-stack>
    </s-stack>
  );
}

/**
 * What the merchant has chosen, and the two ways to change it.
 *
 * Shown as rows rather than as a sentence because a discount pointed at the
 * wrong collection is an expensive mistake and the merchant has to be able to
 * read the list back. The ids are never shown: an id is not something anyone
 * recognises, and the title is what they picked by.
 *
 * The empty state carries the error, so a targeted discount with nothing
 * chosen says so where the merchant is looking rather than only on save.
 */
function PickedList({
  kind,
  picked,
  error,
  onPick,
  onRemove,
}: {
  kind: "collections" | "products";
  picked: PickedResource[];
  error?: string;
  onPick: () => void;
  onRemove: (id: string) => void;
}) {
  const noun = kind === "collections" ? "collection" : "product";

  return (
    <s-stack direction="block" gap="small-300">
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-button onClick={onPick}>
          {picked.length === 0 ? `Choose ${noun}s` : `Edit ${noun}s`}
        </s-button>
        {picked.length > 0 && (
          <s-text color="subdued">
            {picked.length} {picked.length === 1 ? noun : `${noun}s`} chosen
          </s-text>
        )}
      </s-stack>

      {/* `tone` carries the red, not `color` — `s-text` takes only base or
          subdued for colour, and tone is what Polaris wires to the critical
          palette. */}
      {picked.length === 0 ? (
        <s-text tone={error ? "critical" : "auto"} color="subdued">
          {error ?? `No ${noun}s chosen yet.`}
        </s-text>
      ) : (
        <s-stack direction="block" gap="small-500">
          {picked.map((resource) => (
            <s-grid
              key={resource.id}
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="center"
            >
              <s-text>{resource.title}</s-text>
              <s-button
                variant="tertiary"
                accessibilityLabel={`Remove ${resource.title}`}
                onClick={() => onRemove(resource.id)}
              >
                Remove
              </s-button>
            </s-grid>
          ))}
        </s-stack>
      )}
    </s-stack>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <s-grid gridTemplateColumns="1fr auto" gap="base">
      <s-text color="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </s-grid>
  );
}

/**
 * "All products", or the count of what was chosen.
 *
 * A count rather than the names: the summary is a column of short rows, and a
 * merchant who picked nine collections would push every row below it off the
 * card. The names are listed in full in the "Applies to" section itself.
 */
function appliesToLabel(state: DiscountFormState): string {
  if (state.appliesTo === "collections") {
    const count = state.collections.length;
    return count === 0
      ? "No collections chosen"
      : `${count} collection${count === 1 ? "" : "s"}`;
  }

  if (state.appliesTo === "products") {
    const count = state.products.length;
    return count === 0
      ? "No products chosen"
      : `${count} product${count === 1 ? "" : "s"}`;
  }

  return "All products";
}

function combinesLabel(state: DiscountFormState): string {
  const parts = [
    state.combinesProduct ? "Product" : null,
    state.combinesOrder ? "Order" : null,
    state.combinesShipping ? "Shipping" : null,
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? "Nothing" : parts.join(", ");
}

/**
 * The two usage limits read as one line, because they answer one question.
 * A total cap and a per-customer cap are independent — a discount can carry
 * both — and the summary said "Unlimited" whenever the total was off, which
 * was wrong for the default: one use per customer is a limit.
 */
function usesLabel(state: DiscountFormState): string {
  const parts = [
    state.usageLimitOn && state.usageLimit ? `${state.usageLimit} total` : null,
    state.oncePerCustomer ? "1 per customer" : null,
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? "Unlimited" : parts.join(", ");
}

/** `MAXOFF` plus four digits — enough to be unique in practice, short to type. */
/**
 * `2026-10-11` → `2026-10`, the month a date picker should open on.
 *
 * `s-date-field` opens on *today's* month unless it is told otherwise — which
 * is why the End date picker landed on September with 11 October selected.
 * `defaultView` is the documented control for that, and it only sets the
 * opening month: once the merchant navigates, the field owns its own view.
 */
function pickerView(iso: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.slice(0, 7) : undefined;
}

function generateCode(): string {
  return `MAXOFF${Math.floor(1000 + Math.random() * 9000)}`;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
