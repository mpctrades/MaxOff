/**
 * What the buyer sees at checkout, in a modal — BUILD-SPEC §4.9.
 *
 * Shared deliberately: the create form's "See checkout view" button and the
 * cart tester's "See the buyer's checkout" both open this one component. A
 * second copy is how the mockup ended up with three datasets that did not
 * reconcile (§12.4).
 *
 * The lines themselves live in `CheckoutReceipt`, which the create form also
 * renders inline. This file is the modal around them and the verdict below.
 */

import { useAppBridge } from "@shopify/app-bridge-react";

import { capDiscountMinor } from "../lib/cap";
import { formatMoney, formatPercent } from "../lib/format";
import { CheckoutReceipt } from "./CheckoutReceipt";
import { BrandButton } from "./BrandButton";

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
  const shopify = useAppBridge();
  const { uncappedMinor, keptMinor, capped } = capDiscountMinor(
    subtotalMinor,
    percentage,
    capMinor,
  );

  const money = (minor: number) => formatMoney(minor, currencyCode);

  return (
    <s-modal id={id} heading="What the buyer sees at checkout">
      <s-stack direction="block" gap="base">
        <CheckoutReceipt
          code={code}
          percentage={percentage}
          capMinor={capMinor}
          currencyCode={currencyCode}
          subtotalMinor={subtotalMinor}
          checkoutNote={checkoutNote}
        />

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

        {/* The action sits at the foot of the body rather than in the modal's
            own action slot: `s-modal` renders only `s-button` there, and a
            Polaris primary button hard-codes the near-black ring that looks
            wrong on orange (see `BrandButton`). Closing goes through the
            documented `shopify.modal.hide(id)` rather than the `command`
            attribute, which only `s-button` carries. */}
        <div className="maxoff-modal-actions">
          <BrandButton onClick={() => shopify.modal.hide(id)}>Done</BrandButton>
        </div>
      </s-stack>


    </s-modal>
  );
}
