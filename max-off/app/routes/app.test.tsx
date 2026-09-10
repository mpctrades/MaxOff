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
import prisma from "../db.server";
import { listCappedDiscounts } from "../models/discounts.server";
import { recordCartTest } from "../models/home.server";
import { CheckoutPreviewModal } from "../components/CheckoutPreviewModal";
import {
  addPickedVariants,
  basketSubtotalMinor,
  clampQuantity,
  lineTotalMinor,
  removeLine,
  setLineQuantity,
} from "../lib/basket";
import type { BasketLine, PickedVariant } from "../lib/basket";
import { capDiscountMinor } from "../lib/cap";
import { DEFAULT_CHECKOUT_NOTE } from "../lib/cap-config";
import { formatMoney, formatPercent } from "../lib/format";

const CHECKOUT_PREVIEW_ID = "test-checkout-preview";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [settings, active] = await Promise.all([
    prisma.shopSettings.upsert({
      where: { shop: session.shop },
      update: {},
      create: { shop: session.shop },
    }),
    listCappedDiscounts({
      shop: session.shop,
      tab: "active",
      query: "",
      page: 1,
    }),
  ]);

  return {
    currencyCode: settings.currencyCode,
    checkoutNote: settings.defaultCheckoutNote || DEFAULT_CHECKOUT_NOTE,
    discounts: active.rows.map((row) => ({
      id: row.id,
      code: row.code,
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
  const { currencyCode, checkoutNote, discounts } =
    useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const recordFetcher = useFetcher<typeof action>();

  const [lines, setLines] = useState<BasketLine[]>([]);
  const [selectedId, setSelectedId] = useState(discounts[0]?.id ?? "");
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
        : capDiscountMinor(subtotalMinor, discount.percentage, discount.capMinor),
    [discount, subtotalMinor],
  );

  const money = (minor: number) => formatMoney(minor, currencyCode);

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
      <s-button slot="primary-action" variant="primary" onClick={addProducts}>
        Add product
      </s-button>

      <s-paragraph color="subdued">
        Build a basket and see what the cap will do before you send the code to
        anyone.
      </s-paragraph>

      {/* ---------------- Test basket ---------------- */}
      <s-section heading="Test basket">
        {lines.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Add a product from your store to start. Prices come from your own
              catalogue, so the test matches what a customer would really pay.
            </s-paragraph>
            <s-button variant="primary" onClick={addProducts}>
              Add product
            </s-button>
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

            <s-button onClick={addProducts}>Add product</s-button>
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
            <s-button variant="primary" href="/app/discounts/new">
              Create capped discount
            </s-button>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            <s-select
              label="Capped discount"
              name="discount"
              value={discount?.id ?? ""}
              onChange={(event) => setSelectedId(event.currentTarget.value)}
            >
              {discounts.map((row) => (
                <s-option key={row.id} value={row.id}>
                  {`${row.code ?? "No code"} — ${formatPercent(
                    row.percentage,
                  )} max ${money(row.capMinor)}`}
                </s-option>
              ))}
            </s-select>

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
                <s-box padding="base" borderWidth="base" borderRadius="base">
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
                </s-box>

                <s-box
                  padding="base"
                  background="subdued"
                  borderWidth="base"
                  borderRadius="base"
                >
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
                </s-box>

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

                <s-button commandFor={CHECKOUT_PREVIEW_ID} command="--show">
                  See the buyer&apos;s checkout
                </s-button>
              </s-stack>
            )}
          </s-section>
        </div>
      </s-box>

      {discount && (
        <CheckoutPreviewModal
          id={CHECKOUT_PREVIEW_ID}
          code={discount.code ?? "CODE"}
          percentage={discount.percentage}
          capMinor={discount.capMinor}
          currencyCode={currencyCode}
          subtotalMinor={subtotalMinor}
          checkoutNote={checkoutNote}
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

      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-button
          variant="tertiary"
          icon="minus"
          accessibilityLabel={`Decrease the quantity of ${line.title}`}
          onClick={() => onQuantity(line.quantity - 1)}
        ></s-button>
        <s-number-field
          label={`Quantity of ${line.title}`}
          labelAccessibilityVisibility="exclusive"
          name={`quantity-${line.variantId}`}
          min={1}
          step={1}
          value={String(line.quantity)}
          onInput={(event) =>
            onQuantity(clampQuantity(Number(event.currentTarget.value)))
          }
        ></s-number-field>
        <s-button
          variant="tertiary"
          icon="plus"
          accessibilityLabel={`Increase the quantity of ${line.title}`}
          onClick={() => onQuantity(line.quantity + 1)}
        ></s-button>
      </s-stack>

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
