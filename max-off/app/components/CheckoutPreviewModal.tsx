/**
 * What the buyer sees at checkout — BUILD-SPEC §4.9.
 *
 * Shared deliberately: the create form's "See checkout view" button and the
 * cart tester's "See the buyer's checkout" both open this one component. A
 * second copy is how the mockup ended up with three datasets that did not
 * reconcile (§12.4).
 *
 * Every number comes from `capDiscountMinor`, the same arithmetic the preview
 * and the summary use, so the buyer's view cannot disagree with the merchant's.
 */

import { capDiscountMinor } from "../lib/cap";
import { formatMoney, formatPercent } from "../lib/format";

export interface CheckoutPreviewModalProps {
  /** DOM id, so a button can open it with commandFor. */
  id: string;
  code: string;
  percentage: number;
  capMinor: number;
  currencyCode: string;
  subtotalMinor: number;
  /** The locked note the buyer reads under the discount line (§11). */
  checkoutNote: string;
}

export function CheckoutPreviewModal({
  id,
  code,
  percentage,
  capMinor,
  currencyCode,
  subtotalMinor,
  checkoutNote,
}: CheckoutPreviewModalProps) {
  const { uncappedMinor, givenMinor, keptMinor, capped } = capDiscountMinor(
    subtotalMinor,
    percentage,
    capMinor,
  );

  const money = (minor: number) => formatMoney(minor, currencyCode);

  return (
    <s-modal id={id} heading="What the buyer sees at checkout">
      <s-stack direction="block" gap="base">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="small-200">
            <SummaryLine label="Order subtotal" value={money(subtotalMinor)} />

            <SummaryLine
              label={`${code || "CODE"} — ${formatPercent(percentage)} off (max ${money(capMinor)})`}
              value={`−${money(givenMinor)}`}
            />

            {capped && (
              <s-text color="subdued">{checkoutNote}</s-text>
            )}

            <SummaryLine label="Shipping" value="Free" subdued />

            <s-divider direction="inline"></s-divider>

            <SummaryLine
              label="Total"
              value={money(subtotalMinor - givenMinor)}
              strong
            />
          </s-stack>
        </s-box>

        {capped ? (
          <s-banner tone="success" heading="The maximum did its job">
            Without a maximum this order would have given away{" "}
            {money(uncappedMinor)}. You kept {money(keptMinor)}.
          </s-banner>
        ) : (
          <s-banner tone="info" heading="Under the maximum">
            This cart is under the maximum, so the buyer gets the full{" "}
            {formatPercent(percentage)}.
          </s-banner>
        )}
      </s-stack>

      <s-button slot="primary-action" variant="primary" commandFor={id} command="--hide">
        Done
      </s-button>
    </s-modal>
  );
}

function SummaryLine({
  label,
  value,
  subdued = false,
  strong = false,
}: {
  label: string;
  value: string;
  subdued?: boolean;
  strong?: boolean;
}) {
  return (
    <s-grid gridTemplateColumns="1fr auto" gap="base">
      <s-text {...(subdued ? { color: "subdued" as const } : {})}>{label}</s-text>
      <s-text
        {...(strong ? { type: "strong" as const } : {})}
        {...(subdued ? { color: "subdued" as const } : {})}
      >
        {value}
      </s-text>
    </s-grid>
  );
}
