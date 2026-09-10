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
import prisma from "../db.server";
import { createCappedDiscount, isCodeTaken } from "../models/discounts.server";
import { CheckoutPreviewModal } from "../components/CheckoutPreviewModal";
import {
  capDiscountMinor,
  capStartsAboveMinor,
  parseDecimalToMinor,
} from "../lib/cap";
import { DEFAULT_CHECKOUT_NOTE } from "../lib/cap-config";
import {
  discountFormStateFrom,
  initialDiscountFormState,
  validateDiscountForm,
} from "../lib/discount-form";
import type {
  DiscountFieldErrors,
  DiscountFormState,
} from "../lib/discount-form";
import { formatMoney, formatPercent } from "../lib/format";

const SAVE_BAR_ID = "create-discount-save-bar";
const CHECKOUT_PREVIEW_ID = "create-checkout-preview";

/** The live preview's slider range and chips, per §4.3 item 9. */
const SLIDER_MIN_MINOR = 5000;
const SLIDER_MAX_MINOR = 300000;
const SLIDER_STEP_MINOR = 1000;
const QUICK_CHIPS_MINOR = [20000, 80000, 140000, 250000];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const settings = await prisma.shopSettings.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  return {
    currencyCode: settings.currencyCode,
    checkoutNote: settings.defaultCheckoutNote || DEFAULT_CHECKOUT_NOTE,
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
    return { intent: "unknown" as const, ok: false, message: "Unknown action." };
  }

  // Revalidated with the same function the component uses, so a client that
  // skipped its checks cannot write a cap_config the Function would refuse (§6).
  const parsed = validateDiscountForm(discountFormStateFrom(form));
  if ("errors" in parsed) {
    return {
      intent: "create" as const,
      ok: false as const,
      fieldErrors: parsed.errors,
    };
  }

  const settings = await prisma.shopSettings.findUnique({
    where: { shop: session.shop },
  });

  const result = await createCappedDiscount({
    shop: session.shop,
    admin,
    currencyCode: settings?.currencyCode ?? "USD",
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
    mirrored: result.mirrored,
  };
};

export default function CreateDiscountPage() {
  const { currencyCode, checkoutNote } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const saveFetcher = useFetcher<typeof action>();
  const codeFetcher = useFetcher<typeof action>();

  const [state, setState] = useState<DiscountFormState>(() => initialDiscountFormState());
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<DiscountFieldErrors>({});
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

  const preview = useMemo(
    () =>
      ready
        ? capDiscountMinor(simSubtotalMinor, percentage, capMinor!)
        : null,
    [ready, simSubtotalMinor, percentage, capMinor],
  );

  const money = (minor: number) => formatMoney(minor, currencyCode);

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
      shopify.toast.show(`${data.code} is live at checkout`);
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

  const validate = (): boolean => {
    const result = validateDiscountForm(state);

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
        code: state.code.trim().toUpperCase(),
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
      <s-button slot="breadcrumb-actions" href="/app/discounts">
        Capped discounts
      </s-button>

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
        <s-banner tone="warning" heading="Created in Shopify, not yet in MaxOff">
          {saveFetcher.data?.intent === "create" && saveFetcher.data.ok
            ? saveFetcher.data.code
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
          values={["code"]}
        >
          <s-choice value="code">
            Discount code
            <s-text slot="details" color="subdued">
              Customers enter a code at checkout.
            </s-text>
          </s-choice>
          <s-choice value="automatic" disabled>
            Automatic discount
            <s-text slot="details" color="subdued">
              Applies with no code. Coming in a later version.
            </s-text>
          </s-choice>
        </s-choice-list>

        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
          <s-text-field
            label="Discount code"
            name="code"
            value={state.code}
            placeholder="SUMMER15"
            onInput={(event) => set("code", event.currentTarget.value.toUpperCase())}
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
          <s-button onClick={() => set("code", generateCode())}>Generate</s-button>
        </s-grid>
      </s-section>

      {/* ---------------- 2 · Value and maximum ---------------- */}
      <s-section heading="Value and maximum">
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

        {/* Locked wording, §11. Rendered from the real numbers. */}
        {ready && startsAboveMinor !== null ? (
          <s-paragraph>
            At <s-text type="strong">{formatPercent(percentage)}</s-text>, the
            maximum of <s-text type="strong">{money(capMinor!)}</s-text> starts
            working on carts above{" "}
            <s-text type="strong">{money(startsAboveMinor)}</s-text>. Smaller
            carts get the full percentage.
          </s-paragraph>
        ) : (
          <s-paragraph color="subdued">
            Enter a percentage and a maximum to see where the maximum starts
            working.
          </s-paragraph>
        )}

        <s-choice-list
          label="The maximum applies to"
          name="scope"
          values={["order"]}
        >
          <s-choice value="order">
            The whole order
            <s-text slot="details" color="subdued">
              One maximum for the entire cart.
            </s-text>
          </s-choice>
          <s-choice value="item" disabled>
            Each item
            <s-text slot="details" color="subdued">
              A separate maximum on every line. A Pro feature.
            </s-text>
          </s-choice>
          <s-choice value="collection" disabled>
            Each collection
            <s-text slot="details" color="subdued">
              A separate maximum per collection. A Pro feature.
            </s-text>
          </s-choice>
        </s-choice-list>
      </s-section>

      {/* ---------------- 3 · Applies to ---------------- */}
      <s-section heading="Applies to">
        <s-choice-list
          label="Which products the discount applies to"
          labelAccessibilityVisibility="exclusive"
          name="appliesTo"
          values={["all"]}
        >
          <s-choice value="all">
            All products
            <s-text slot="details" color="subdued">
              The percentage applies to the whole cart subtotal.
            </s-text>
          </s-choice>
          <s-choice value="collections" disabled>
            Specific collections
            <s-text slot="details" color="subdued">
              Coming in a later version.
            </s-text>
          </s-choice>
          <s-choice value="products" disabled>
            Specific products
            <s-text slot="details" color="subdued">
              Coming in a later version.
            </s-text>
          </s-choice>
        </s-choice-list>
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
              Every cart that uses the code gets the discount.
            </s-text>
          </s-choice>
          <s-choice value="subtotal" disabled>
            Minimum purchase amount
            <s-text slot="details" color="subdued">
              Needs the cap engine to enforce it.
            </s-text>
          </s-choice>
          <s-choice value="quantity" disabled>
            Minimum quantity of items
            <s-text slot="details" color="subdued">
              Needs the cap engine to enforce it.
            </s-text>
          </s-choice>
        </s-choice-list>
      </s-section>

      {/* ---------------- 5 · Customers and usage limits ---------------- */}
      <s-section heading="Customers and usage limits">
        <s-choice-list
          label="Who can use this discount"
          name="eligibility"
          values={["all"]}
        >
          <s-choice value="all">
            All customers
            <s-text slot="details" color="subdued">
              Anyone who enters the code.
            </s-text>
          </s-choice>
          <s-choice value="segments" disabled>
            Specific customer segments
            <s-text slot="details" color="subdued">
              Coming in a later version.
            </s-text>
          </s-choice>
        </s-choice-list>

        <s-checkbox
          label="Limit the total number of uses"
          name="usageLimitOn"
          checked={state.usageLimitOn}
          onChange={(event) => set("usageLimitOn", event.currentTarget.checked)}
        ></s-checkbox>

        {state.usageLimitOn && (
          <s-number-field
            label="Total uses"
            name="usageLimit"
            min={1}
            step={1}
            value={state.usageLimit}
            onInput={(event) => set("usageLimit", event.currentTarget.value)}
            {...(errors.usageLimit ? { error: errors.usageLimit } : {})}
          ></s-number-field>
        )}

        <s-checkbox
          label="Limit to one use per customer"
          name="oncePerCustomer"
          checked={state.oncePerCustomer}
          onChange={(event) => set("oncePerCustomer", event.currentTarget.checked)}
        ></s-checkbox>

        <s-checkbox
          label="Stop the code once it has given away a total amount"
          name="budgetCap"
          disabled
        ></s-checkbox>
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
          onChange={(event) => {
            const values = event.currentTarget.values ?? [];
            setState((current) => ({
              ...current,
              combinesProduct: values.includes("product"),
              combinesOrder: values.includes("order"),
              combinesShipping: values.includes("shipping"),
            }));
            setDirty(true);
          }}
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
        <s-text-field
          label="Checkout note"
          name="checkoutNote"
          value={checkoutNote}
          disabled
          maxLength={60}
        ></s-text-field>
        <s-paragraph color="subdued">
          The buyer always sees a line at checkout. In this version it reads{" "}
          <s-text type="strong">
            {state.code || "CODE"} — {state.percentage || "0"}% off (max{" "}
            {capMinor === null ? "0.00" : money(capMinor)})
          </s-text>{" "}
          with the note above beneath it. Editing the wording comes in a later
          version.
        </s-paragraph>
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
            onChange={(event) => set("startDate", event.currentTarget.value)}
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

        <s-checkbox
          label="Set an end date"
          name="endDateOn"
          checked={state.endDateOn}
          onChange={(event) => set("endDateOn", event.currentTarget.checked)}
        ></s-checkbox>

        {state.endDateOn && (
          <s-grid
            gridTemplateColumns="@container (inline-size <= 500px) 1fr, 1fr 1fr"
            gap="base"
          >
            <s-date-field
              label="End date"
              name="endDate"
              value={state.endDate}
              onChange={(event) => set("endDate", event.currentTarget.value)}
              {...(errors.endDate ? { error: errors.endDate } : {})}
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

      {/* ---------------- Right column: Summary, then the preview ----------
          §12.2: the mockup buries the preview at the bottom of a 2,400px form,
          eleven cards below the fields that drive it. It belongs here, beside
          them, and stays on screen while the form scrolls. */}
      <s-box slot="aside">
        <div style={{ position: "sticky", top: "16px" }}>
          <s-stack direction="block" gap="base">
            <s-section heading="Summary">
              <s-stack direction="block" gap="small-200">
                <SummaryRow label="Code" value={state.code || "—"} />
                <SummaryRow label="Type" value="Percentage, capped" />
                <SummaryRow
                  label="Value"
                  value={validPercentage ? formatPercent(percentage) : "—"}
                />
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
                <SummaryRow label="Applies to" value="All products" />
                <SummaryRow label="Customers" value="All customers" />
                <SummaryRow label="Combines" value={combinesLabel(state)} />
                <SummaryRow
                  label="Uses"
                  value={
                    state.usageLimitOn && state.usageLimit
                      ? `${state.usageLimit} total`
                      : "Unlimited"
                  }
                />
                <SummaryRow
                  label="Starts"
                  value={state.startDate || "—"}
                />
                <SummaryRow
                  label="Ends"
                  value={state.endDateOn ? state.endDate || "—" : "No end date"}
                />
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
                    Cart total: {money(simSubtotalMinor)}
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
                    style={{ width: "100%", accentColor: "#c2410c" }}
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
                    style={{
                      fontSize: "26px",
                      fontWeight: 650,
                      letterSpacing: "-0.5px",
                      fontVariantNumeric: "tabular-nums",
                      color: "#c2410c",
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
                      <>the full {formatPercent(percentage)} — still under your maximum.</>
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

                  <s-button
                    commandFor={CHECKOUT_PREVIEW_ID}
                    command="--show"
                  >
                    See checkout view
                  </s-button>
                </s-stack>
              )}
            </s-section>

            <s-section heading="Templates">
              <s-paragraph color="subdued">
                Ready-made caps for common campaigns. Coming in a later version.
              </s-paragraph>
              <s-stack direction="block" gap="small-200">
                {["Sitewide 15% / max 150", "Black Friday 30% / max 200", "Welcome 10% / max 25", "VIP 20% / max 80"].map(
                  (template) => (
                    <s-button key={template} disabled>
                      {template}
                    </s-button>
                  ),
                )}
              </s-stack>
            </s-section>
          </s-stack>
        </div>
      </s-box>

      <CheckoutPreviewModal
        id={CHECKOUT_PREVIEW_ID}
        code={state.code || "CODE"}
        percentage={validPercentage ? percentage : 0}
        capMinor={capMinor ?? 0}
        currencyCode={currencyCode}
        subtotalMinor={simSubtotalMinor}
        checkoutNote={checkoutNote}
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
            background: "#f3f3f3",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: width(uncappedMinor),
              height: "100%",
              background: "#e0b4ab",
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
            background: "#f3f3f3",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: width(givenMinor),
              height: "100%",
              background: "#ea580c",
            }}
          />
        </div>
      </s-stack>
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

function combinesLabel(state: DiscountFormState): string {
  const parts = [
    state.combinesProduct ? "product" : null,
    state.combinesOrder ? "order" : null,
    state.combinesShipping ? "shipping" : null,
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? "Nothing" : parts.join(", ");
}

/** `MAXOFF` plus four digits — enough to be unique in practice, short to type. */
function generateCode(): string {
  return `MAXOFF${Math.floor(1000 + Math.random() * 9000)}`;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
