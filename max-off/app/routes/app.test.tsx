import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { listCappedDiscounts } from "../models/discounts.server";
import { ensureShopSettings } from "../models/settings.server";
import { recordCartTest } from "../models/home.server";
import { CheckoutPreviewModal } from "../components/CheckoutPreviewModal";
import {
  addPickedVariants,
  basketSubtotalMinor,
  clampQuantity,
  MAX_QUANTITY,
  MIN_QUANTITY,
  lineTotalMinor,
  removeLine,
  setLineQuantity,
} from "../lib/basket";
import { BrandButton } from "../components/BrandButton";
import type { BasketLine, PickedVariant } from "../lib/basket";
import { capDiscountMinor } from "../lib/cap";
import { toRoundingMode } from "../lib/rounding";
import { DEFAULT_CHECKOUT_NOTE } from "../lib/cap-config";
import { formatMoney, formatPercent } from "../lib/format";
import { useNativeChange } from "../lib/polaris-events";
import type { ValuesElement } from "../lib/polaris-events";

const CHECKOUT_PREVIEW_ID = "test-checkout-preview";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // The detail screen links here with the discount it was showing, so the
  // tester opens on that one rather than on whatever happens to be newest.
  // Validated against the loaded list below, never trusted straight from the
  // URL — an id from another shop must not select anything.
  const requested = new URL(request.url).searchParams.get("discount");

  const [settings, active] = await Promise.all([
    ensureShopSettings(session.shop),
    listCappedDiscounts({
      shop: session.shop,
      tab: "active",
      query: "",
      page: 1,
    }),
  ]);

  return {
    requestedDiscountId:
      requested !== null && active.rows.some((row) => row.id === requested)
        ? requested
        : null,
    currencyCode: settings.currencyCode,
    checkoutNote: settings.defaultCheckoutNote || DEFAULT_CHECKOUT_NOTE,
    // The shop's Settings choice. The tester exists to show what checkout
    // does, so it has to round the way checkout rounds.
    rounding: toRoundingMode(settings.rounding),
    discounts: active.rows.map((row) => ({
      id: row.id,
      code: row.code,
      // An automatic discount has no code, so the tester names it by the
      // merchant's own title — and shows the buyer a receipt with no code
      // line, which is exactly what the Function emits for it.
      label: row.method === "automatic" ? (row.title ?? "Automatic discount") : (row.code ?? "No code"),
      percentage: row.percentage,
      capMinor: row.capMinor,
      capStartsAboveMinor: row.capStartsAboveMinor,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const form = await request.formData();
  if (form.get("intent") !== "record-test") {
    return { ok: false as const };
  }

  const subtotalMinor = Number(form.get("subtotalMinor"));
  const cappedMinor = Number(form.get("cappedMinor"));

  if (
    !Number.isInteger(subtotalMinor) ||
    !Number.isInteger(cappedMinor) ||
    subtotalMinor <= 0 ||
    cappedMinor <= 0
  ) {
    return { ok: false as const };
  }

  await recordCartTest({ shop: session.shop, subtotalMinor, cappedMinor });

  return { ok: true as const };
};

export default function TestACartPage() {
  const { currencyCode, checkoutNote, rounding, discounts, requestedDiscountId } =
    useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const recordFetcher = useFetcher<typeof action>();


  const [lines, setLines] = useState<BasketLine[]>([]);
  const [selectedId, setSelectedId] = useState(
    requestedDiscountId ?? discounts[0]?.id ?? "",
  );
  const recorded = useRef(false);

  const discount = useMemo(
    () => discounts.find((row) => row.id === selectedId) ?? discounts[0] ?? null,
    [discounts, selectedId],
  );

  const subtotalMinor = useMemo(() => basketSubtotalMinor(lines), [lines]);

  const result = useMemo(
    () =>
      discount === null
        ? null
        : capDiscountMinor(
            subtotalMinor,
            discount.percentage,
            discount.capMinor,
            rounding,
          ),
    [discount, subtotalMinor, rounding],
  );

  const money = (minor: number) => formatMoney(minor, currencyCode);

  // React's onChange never fires for Polaris controls; see polaris-events.ts.
  // A choice list reports its selection as a list even when only one choice
  // can be picked, so the first entry is the answer.
  const onDiscountChange = useNativeChange<ValuesElement>((element) => {
    const picked = element.values?.[0];
    if (picked) {
      setSelectedId(picked);
    }
  });

  /**
   * §2c: the first capped result in this visit completes setup step 3. Not on
   * every quantity change, and never for an uncapped cart — a 200.00 basket
   * that stayed under the maximum did not test the cap.
   */
  useEffect(() => {
    if (recorded.current || result === null || !result.capped) {
      return;
    }

    recorded.current = true;
    recordFetcher.submit(
      {
        intent: "record-test",
        subtotalMinor: String(subtotalMinor),
        cappedMinor: String(result.givenMinor),
      },
      { method: "post" },
    );
  }, [result, subtotalMinor, recordFetcher]);

  const addProducts = async () => {
    const picked = await shopify.resourcePicker({
      type: "variant",
      multiple: true,
    });

    if (!picked) {
      return;
    }

    setLines((current) =>
      addPickedVariants(current, picked as unknown as PickedVariant[]),
    );
  };

  return (
    <s-page heading="Test a cart">
      {/* ---------------- Test basket ---------------- */}
      <s-section heading="Test basket">
        {lines.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Add a product from your store to start. Prices come from your own
              catalogue, so the test matches what a customer would really pay.
            </s-paragraph>
            <BrandButton onClick={addProducts}>
              Add product
            </BrandButton>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            {lines.map((line) => (
              <BasketRow
                key={line.variantId}
                line={line}
                currencyCode={currencyCode}
                onQuantity={(quantity) =>
                  setLines((current) =>
                    setLineQuantity(current, line.variantId, quantity),
                  )
                }
                onRemove={() =>
                  setLines((current) => removeLine(current, line.variantId))
                }
              />
            ))}

            <s-divider direction="inline"></s-divider>

            <s-grid gridTemplateColumns="1fr auto" gap="base">
              <s-text type="strong">Subtotal</s-text>
              <s-text type="strong">{money(subtotalMinor)}</s-text>
            </s-grid>

            <BrandButton onClick={addProducts}>Add product</BrandButton>
          </s-stack>
        )}
      </s-section>

      {/* ---------------- Discount to test ---------------- */}
      <s-section heading="Discount to test">
        {discounts.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              You have no active capped discounts, so there is nothing to test
              yet.
            </s-paragraph>
            <BrandButton href="/app/discounts/new">
              Create capped discount
            </BrandButton>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            {/* A choice list, not a select.
                `s-select` is a native <select>, and a native select's menu is
                drawn by the operating system on top of the field — it lands
                over the discount's own description, which is the mess Arthur
                photographed. Nothing in the component or in our CSS can move
                it: the <select> lives in Polaris' shadow DOM. Shopify's own
                Select page names the choice list as the alternative "for more
                visual selection layouts", and the create form already uses one
                for the same kind of single choice. Nothing overlays anything,
                and every discount is readable without a click. */}
            <s-choice-list
              label="Capped discount"
              name="discount"
              values={[discount?.id ?? ""]}
              ref={onDiscountChange}
            >
              {discounts.map((row) => (
                <s-choice key={row.id} value={row.id}>
                  {`${row.label} — ${formatPercent(
                    row.percentage,
                  )} max ${money(row.capMinor)}`}
                </s-choice>
              ))}
            </s-choice-list>

            {discount && (
              <s-paragraph color="subdued">
                {formatPercent(discount.percentage)} off, never more than{" "}
                {money(discount.capMinor)}
                {discount.capStartsAboveMinor === null
                  ? "."
                  : ` — the maximum starts on carts above ${money(
                      discount.capStartsAboveMinor,
                    )}.`}
              </s-paragraph>
            )}
          </s-stack>
        )}
      </s-section>

      {/* ---------------- Right column: the result ---------------- */}
      <s-box slot="aside">
        <div style={{ position: "sticky", top: "16px" }}>
          <s-section heading="Result">
            {result === null || discount === null ? (
              <s-paragraph color="subdued">
                Choose a capped discount to see what it would do.
              </s-paragraph>
            ) : subtotalMinor === 0 ? (
              <s-paragraph color="subdued">
                Add a product to the basket to see the result.
              </s-paragraph>
            ) : (
              <s-stack direction="block" gap="base">
                <div className="maxoff-result">
                  <s-stack direction="block" gap="small-300">
                    <s-text color="subdued">Without MaxOff</s-text>
                    <ResultLine
                      label="Discount given"
                      value={money(result.uncappedMinor)}
                    />
                    <ResultLine
                      label="Customer pays"
                      value={money(subtotalMinor - result.uncappedMinor)}
                      strong
                    />
                  </s-stack>
                </div>

                {/* The branded one is the answer the merchant came for, so it
                    is the one that is tinted. The tint is emphasis only — the
                    box says "With MaxOff" and every number is labelled, which
                    is the rule in theme.css: orange is never the only signal
                    for meaning. */}
                <div className="maxoff-result maxoff-result--branded">
                  <s-stack direction="block" gap="small-300">
                    <s-text color="subdued">With MaxOff</s-text>
                    <ResultLine
                      label="Discount given"
                      value={money(result.givenMinor)}
                    />
                    {result.capped && (
                      <s-text color="subdued">Capped at maximum amount</s-text>
                    )}
                    <ResultLine
                      label="Customer pays"
                      value={money(subtotalMinor - result.givenMinor)}
                      strong
                    />
                  </s-stack>
                </div>

                <s-text type="strong">
                  {result.capped
                    ? `You keep ${money(result.keptMinor)} on this order.`
                    : `This cart is below ${money(
                        discount.capStartsAboveMinor ?? 0,
                      )}, so the maximum does not apply yet.`}
                </s-text>

                {/* §2b: the screen must not promise more than it knows. */}
                <s-text color="subdued">
                  This is the same arithmetic the cap uses at checkout. Taxes,
                  shipping and other discounts are not included.
                </s-text>

                {/* `commandFor` is carried only by `s-button`; this is the
                    documented equivalent. See `BrandButton` for why the
                    Polaris button cannot wear the brand style. */}
                <BrandButton
                  onClick={() => shopify.modal.show(CHECKOUT_PREVIEW_ID)}
                >
                  See the buyer&apos;s checkout
                </BrandButton>
              </s-stack>
            )}
          </s-section>
        </div>
      </s-box>

      {discount && (
        <CheckoutPreviewModal
          id={CHECKOUT_PREVIEW_ID}
          code={discount.code ?? ""}
          percentage={discount.percentage}
          capMinor={discount.capMinor}
          currencyCode={currencyCode}
          subtotalMinor={subtotalMinor}
          checkoutNote={checkoutNote}
          rounding={rounding}
        />
      )}
    </s-page>
  );
}

/**
 * One basket line. Polaris has no stepper component in this version, so it is
 * composed from two buttons and a number field — which also means the quantity
 * is typable, not only clickable.
 *
 * Quantity stops at one and a line is removed by its own Remove button, rather
 * than vanishing when the merchant clicks minus once too often.
 */
function BasketRow({
  line,
  currencyCode,
  onQuantity,
  onRemove,
}: {
  line: BasketLine;
  currencyCode: string;
  onQuantity: (quantity: number) => void;
  onRemove: () => void;
}) {
  return (
    <s-grid
      gridTemplateColumns="@container (inline-size <= 500px) 1fr, auto 1fr auto auto auto"
      gap="base"
      alignItems="center"
    >
      {line.imageSrc ? (
        <s-thumbnail
          src={line.imageSrc}
          alt={line.imageAlt ?? line.title}
          size="small"
        ></s-thumbnail>
      ) : (
        <s-thumbnail alt={line.title} size="small"></s-thumbnail>
      )}

      <s-stack direction="block" gap="small-500">
        <s-text>{line.title}</s-text>
        <s-text color="subdued">
          {formatMoney(line.unitPriceMinor, currencyCode)} each
        </s-text>
      </s-stack>

      {/* Just the field. It carries its own increment and decrement arrows,
          so the separate minus and plus buttons that used to flank it were
          the same two actions offered twice — and squeezing all three into a
          basket row is what left the number cramped against the arrows.
          `s-number-field` fills its container, so the width is set here. */}
      <div className="maxoff-quantity">
        <s-number-field
          label={`Quantity of ${line.title}`}
          labelAccessibilityVisibility="exclusive"
          name={`quantity-${line.variantId}`}
          min={MIN_QUANTITY}
          max={MAX_QUANTITY}
          step={1}
          value={String(line.quantity)}
          onInput={(event) =>
            onQuantity(clampQuantity(Number(event.currentTarget.value)))
          }
        ></s-number-field>
      </div>

      <s-text>{formatMoney(lineTotalMinor(line), currencyCode)}</s-text>

      <s-button
        variant="tertiary"
        icon="delete"
        accessibilityLabel={`Remove ${line.title} from the basket`}
        onClick={onRemove}
      ></s-button>
    </s-grid>
  );
}

function ResultLine({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <s-grid gridTemplateColumns="1fr auto" gap="base">
      <s-text>{label}</s-text>
      <s-text {...(strong ? { type: "strong" as const } : {})}>{value}</s-text>
    </s-grid>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
