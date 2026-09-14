/**
 * The buyer's checkout lines — BUILD-SPEC §4.9.
 *
 * One receipt, two places: the create form shows it inline under "What the
 * customer sees", and `CheckoutPreviewModal` shows the same component in a
 * modal from the create form and the cart tester. A second copy is how the
 * mockup ended up with three datasets that did not reconcile (§12.4), so if
 * this needs to look different somewhere, give it a prop rather than a twin.
 *
 * Every number comes from `capDiscountMinor`, the same arithmetic the live
 * preview and the summary use, so the buyer's view cannot disagree with the
 * merchant's.
 *
 * Amounts on the lines are bare, with no currency code — the header names the
 * currency once, the way a real checkout does. See `formatAmount`.
 */

import { capDiscountMinor } from "../lib/cap";
import { formatAmount, formatMoney, formatPercent } from "../lib/format";

export interface CheckoutReceiptProps {
  /** Empty for an automatic discount, which the buyer sees with no code. */
  code: string;
  percentage: number;
  capMinor: number;
  currencyCode: string;
  subtotalMinor: number;
  /** The locked note the buyer reads under the discount line (§11). */
  checkoutNote: string;
}

export function CheckoutReceipt({
  code,
  percentage,
  capMinor,
  currencyCode,
  subtotalMinor,
  checkoutNote,
}: CheckoutReceiptProps) {
  const { uncappedMinor, givenMinor, capped } = capDiscountMinor(
    subtotalMinor,
    percentage,
    capMinor,
  );

  return (
    <s-box borderWidth="base" borderRadius="base" borderColor="base">
      <s-box padding="small-300" background="subdued">
        <s-text color="subdued">
          Checkout, on a cart of {formatMoney(subtotalMinor, currencyCode)}
        </s-text>
      </s-box>

      <s-box padding="base">
        <s-stack direction="block" gap="small-300">
          <ReceiptLine label="Subtotal" value={formatAmount(subtotalMinor)} />

          {/* §5: discount codes are monospace. The whole line is, so the code
              and the maximum beside it read as the one machine-written string
              the buyer actually sees.

              The label is built the same way `buildMessage` builds it in the
              Function — rule alone when there is no code, because an automatic
              discount has none and a leading em dash is not a code. */}
          <ReceiptLine
            mono
            label={discountLine(code, percentage, capMinor)}
            value={`−${formatAmount(givenMinor)}`}
          />

          {/* Only when the cap actually bit: the buyer sees this note because
              the Function attached it, and the Function only attaches it to a
              capped discount. Showing it otherwise would be a fiction. */}
          {capped && (
            <s-text color="subdued">
              {checkoutNote} · {formatPercent(percentage)} would have been{" "}
              <del>{formatAmount(uncappedMinor)}</del>
            </s-text>
          )}

          <s-divider direction="inline"></s-divider>

          <ReceiptLine
            strong
            label="Total"
            value={formatAmount(subtotalMinor - givenMinor)}
          />
        </s-stack>
      </s-box>
    </s-box>
  );
}

/**
 * The buyer's discount line, mirroring `buildMessage` in
 * `extensions/max-off-cap/src/cart_lines_discounts_generate_run.ts`.
 *
 * The two are deliberate twins for the same reason the arithmetic is (§8):
 * different runtimes. What they must never do is disagree about what the buyer
 * reads, so both drop the prefix when there is no code.
 */
function discountLine(code: string, percentage: number, capMinor: number): string {
  const rule = `${formatPercent(percentage)} off (max ${formatAmount(capMinor)})`;
  return code.trim() === "" ? rule : `${code} — ${rule}`;
}

/**
 * One line of the receipt, drawn rather than composed from `s-text`.
 *
 * `s-text` was the obvious choice and does not work here: `type="strong"`
 * leaves the total at body weight, and a monospace family set on an ancestor
 * never reaches it because the component sets its own `font-family` inside its
 * shadow DOM. Both are presentation this panel depends on — a total that is
 * not bold is not a total — so the rows are our own markup, styled in
 * `theme.css`, exactly like the cap callout. Nothing here is Polaris chrome.
 */
function ReceiptLine({
  label,
  value,
  mono = false,
  strong = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
}) {
  const classes = [
    "maxoff-receipt-line",
    mono ? "maxoff-mono" : "",
    strong ? "maxoff-receipt-line--total" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <span>{label}</span>
      <span className="maxoff-tabular">{value}</span>
    </div>
  );
}
