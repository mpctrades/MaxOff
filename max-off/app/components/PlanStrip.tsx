/**
 * "You are on Free, 1 of 3 used" — the one-line answer to *which plan am I on*.
 *
 * It sits at the top of Home and at the top of Plans & billing. One component
 * because it is one fact: two copies of a plan summary is how the two pages
 * end up disagreeing about the allowance, which is the drift `plans.ts` exists
 * to prevent and would be worse for being visible on the first screen.
 *
 * What differs between the two pages is only the thing beside it. On billing
 * the button submits and leaves the frame for Shopify's hosted plan page; on
 * Home it is a link to billing. That is passed in as `action` rather than
 * decided here — a component that knows which route it is on is two
 * components wearing one name.
 */

import type { ReactNode } from "react";

import {
  activeDiscountLimit,
  PLAN_LABELS,
  PLAN_PRICE_MINOR,
} from "../lib/plans";
import type { PlanKey } from "../lib/plans";
import { formatMoney } from "../lib/format";

export interface PlanStripProps {
  plan: PlanKey;
  currencyCode: string;
  activeCount: number;
  /** Shopify could not be reached, so the plan is the last one we saw. */
  lastKnown?: boolean;
  /** ISO date of the next charge, when Shopify tells us. Never guessed. */
  nextChargeOn?: string | null;
  /** The upgrade affordance, which differs per page. Omitted on Pro. */
  action?: ReactNode;
}

export function PlanStrip({
  plan,
  currencyCode,
  activeCount,
  lastKnown = false,
  nextChargeOn = null,
  action,
}: PlanStripProps) {
  const price = PLAN_PRICE_MINOR[plan];

  return (
    <div className="maxoff-plan-strip">
      <div className="maxoff-plan-strip__plan">
        <div className="maxoff-plan-strip__name">
          <strong>{PLAN_LABELS[plan]}</strong>
          <s-badge tone="success">In use</s-badge>
          {lastKnown && <s-badge tone="warning">Last known</s-badge>}
        </div>
        {/* Nothing is charged monthly at zero, so nothing says "per month".
            The period belongs to the price, not to the layout. */}
        <span className="maxoff-plan-strip__price maxoff-tabular">
          {formatMoney(price, currencyCode)}
          {price > 0 && " per month"}
        </span>
        {/* Omitted rather than guessed when Shopify does not tell us. */}
        {nextChargeOn && (
          <span className="maxoff-plan-strip__next">
            Next charge {nextChargeOn.slice(0, 10)}
          </span>
        )}
      </div>

      {action && <div className="maxoff-plan-strip__action">{action}</div>}

      <UsageMeter
        activeCount={activeCount}
        activeLimit={activeDiscountLimit(plan)}
      />
    </div>
  );
}

/**
 * `Capped discounts … 1 of 3 used`, from the same limit every gate reads.
 *
 * Polaris has no meter in this version, so the bar is our own markup — and it
 * is decoration: the sentence beside it carries the number, so nothing is lost
 * when the bar cannot be seen. Unlimited plans get the sentence and no bar,
 * because a bar pinned at 100% reads as a limit that is not there.
 */
function UsageMeter({
  activeCount,
  activeLimit,
}: {
  activeCount: number;
  activeLimit: number | null;
}) {
  if (activeLimit === null) {
    return (
      <div className="maxoff-usage">
        <div className="maxoff-usage__head">
          <span>Capped discounts</span>
          <span className="maxoff-usage__count">
            {activeCount} active · unlimited on your plan
          </span>
        </div>
      </div>
    );
  }

  const percent = Math.min(
    Math.round((activeCount / Math.max(activeLimit, 1)) * 100),
    100,
  );

  return (
    <div className="maxoff-usage">
      <div className="maxoff-usage__head">
        <span>Capped discounts</span>
        <span className="maxoff-usage__count maxoff-tabular">
          {activeCount} of {activeLimit} used
        </span>
      </div>
      <div className="maxoff-usage__track" aria-hidden="true">
        <div
          className="maxoff-usage__fill"
          style={{ inlineSize: `${percent}%` }}
        ></div>
      </div>
      {activeCount >= activeLimit && (
        <span className="maxoff-usage__note">
          You are at your plan&apos;s limit. Pause one to activate another, or
          move up a plan.
        </span>
      )}
    </div>
  );
}
