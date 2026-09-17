/**
 * The current-plan strip at the top of Plans & billing.
 *
 * Three zones, left to right: who you are, how much of the plan you are using,
 * and the one step up. Before this it was a text cluster hard left, a button
 * hard right, and a full-width progress bar across the bottom that gave one
 * number more visual weight than the plan name — and whose orange fought the
 * orange button beside it.
 *
 * ## Why so much of it is ours rather than Polaris'
 *
 * Polaris has no meter in this version, no vertical rule, and no way to reach
 * inside `s-button` to change a fill. Every one of those is drawn here and
 * styled in the `Plans & billing — the current-plan strip` block in
 * `theme.css`. Only the paint is ours; the upgrade link is still a
 * `BrandButton`, so it keeps the `target="_top"` that carries a merchant out
 * of the embedded frame to Shopify's hosted plan page.
 *
 * ## The meter is decoration
 *
 * A screen reader gets "6 of 20 capped discounts used" from the container's
 * own label and never meets a tick. Sighted readers get the same sentence in
 * the header row, so the orange is never the only thing carrying the number.
 */

import {
  activeDiscountLimit,
  planPitch,
  PLAN_LABELS,
  PLAN_PRICE_MINOR,
} from "../lib/plans";
import type { PlanKey } from "../lib/plans";
import { formatDate, formatMoney, formatTrialRemaining } from "../lib/format";
import { BrandButton } from "./BrandButton";

export interface PlanStripProps {
  plan: PlanKey;
  currencyCode: string;
  activeCount: number;
  /** Shopify could not be reached, so the plan is the last one we saw. */
  lastKnown?: boolean;
  /** ISO date of the next charge, when Shopify tells us. Never guessed. */
  nextChargeOn?: string | null;
  /** ISO date the free trial ends, when one is running. See `trialEndFor`. */
  trialEndsAt?: string | null;
  /** Shopify's hosted plan page. Null when we could not work out the URL. */
  upgradeHref?: string | null;
}

export function PlanStrip({
  plan,
  currencyCode,
  activeCount,
  lastKnown = false,
  nextChargeOn = null,
  trialEndsAt = null,
  upgradeHref = null,
}: PlanStripProps) {
  const limit = activeDiscountLimit(plan);
  const atLimit = limit !== null && activeCount >= limit;

  return (
    <div
      className={`maxoff-plan-strip${
        atLimit ? " maxoff-plan-strip--at-limit" : ""
      }`}
    >
      <Identity
        plan={plan}
        currencyCode={currencyCode}
        lastKnown={lastKnown}
        nextChargeOn={nextChargeOn}
        trialEndsAt={trialEndsAt}
      />

      <span className="maxoff-plan-strip__rule" aria-hidden="true" />

      <Usage plan={plan} activeCount={activeCount} activeLimit={limit} />

      <span className="maxoff-plan-strip__rule" aria-hidden="true" />

      <Upgrade
        plan={plan}
        currencyCode={currencyCode}
        upgradeHref={upgradeHref}
      />
    </div>
  );
}

/** Zone A — which plan, what it costs, and when it is next charged for. */
function Identity({
  plan,
  currencyCode,
  lastKnown,
  nextChargeOn,
  trialEndsAt,
}: {
  plan: PlanKey;
  currencyCode: string;
  lastKnown: boolean;
  nextChargeOn: string | null;
  trialEndsAt: string | null;
}) {
  const price = PLAN_PRICE_MINOR[plan];

  /* Null once the trial has elapsed, so a stale date cannot render as a live
     trial. Both this and the next-charge line can be true at once — see the
     note on `trialEndsAt` in `plan.server.ts`. */
  const trialLeft = trialEndsAt
    ? formatTrialRemaining(new Date(trialEndsAt))
    : null;

  return (
    <div className="maxoff-plan-strip__zone maxoff-plan-strip__identity">
      <span className="maxoff-plan-strip__kicker">Your plan</span>

      <div className="maxoff-plan-strip__name">
        <strong>{PLAN_LABELS[plan]}</strong>
        <span className="maxoff-plan-strip__pill">In use</span>
        {lastKnown && <s-badge tone="warning">Last known</s-badge>}
      </div>

      {/* Nothing is charged monthly at zero, so nothing says "per month".
          The period belongs to the price, not to the layout. */}
      <span className="maxoff-plan-strip__price maxoff-tabular">
        <strong>{formatMoney(price, currencyCode)}</strong>
        {price > 0 && <span className="maxoff-plan-strip__per"> / month</span>}
      </span>

      {trialLeft && (
        <span className="maxoff-plan-strip__trial">Free trial, {trialLeft}</span>
      )}

      {/* Omitted rather than guessed when Shopify does not tell us. */}
      {nextChargeOn && (
        <span className="maxoff-plan-strip__next">
          Next charge {formatDate(new Date(nextChargeOn))}
        </span>
      )}
    </div>
  );
}

/**
 * Zone B — one tick per discount the plan allows.
 *
 * A plan with no ceiling gets no meter: a bar pinned at 100% reads as a limit
 * that is not there. It gets the count on its own instead.
 */
function Usage({
  plan,
  activeCount,
  activeLimit,
}: {
  plan: PlanKey;
  activeCount: number;
  activeLimit: number | null;
}) {
  if (activeLimit === null) {
    return (
      <div className="maxoff-plan-strip__zone maxoff-plan-strip__usage">
        <div className="maxoff-plan-strip__usage-head">
          <span className="maxoff-plan-strip__usage-title">
            Capped discounts
          </span>
        </div>
        <span className="maxoff-plan-strip__count-large maxoff-tabular">
          {activeCount} capped discount{activeCount === 1 ? "" : "s"}
        </span>
        <span className="maxoff-plan-strip__foot">
          Unlimited on {PLAN_LABELS[plan]}
        </span>
      </div>
    );
  }

  const used = Math.min(activeCount, activeLimit);
  const remaining = activeLimit - used;
  const atLimit = activeCount >= activeLimit;

  /* Never an unexplained row of grey. Each of the three states says what the
     meter means rather than leaving the reader to count. */
  const foot = atLimit
    ? `You've used every discount on ${PLAN_LABELS[plan]}`
    : used === 0
      ? `${activeLimit} available on ${PLAN_LABELS[plan]}`
      : `${remaining} more available on ${PLAN_LABELS[plan]}`;

  return (
    <div className="maxoff-plan-strip__zone maxoff-plan-strip__usage">
      <div className="maxoff-plan-strip__usage-head">
        <span className="maxoff-plan-strip__usage-title">Capped discounts</span>
        <span className="maxoff-plan-strip__usage-count maxoff-tabular">
          <strong>{activeCount}</strong> of {activeLimit} used
        </span>
      </div>

      {/* The ticks are decoration. The container carries the whole fact, so
          nobody has to count them one at a time. */}
      <div
        className="maxoff-plan-strip__meter"
        role="img"
        aria-label={`${activeCount} of ${activeLimit} capped discounts used`}
      >
        <div className="maxoff-plan-strip__ticks" aria-hidden="true">
          {Array.from({ length: activeLimit }, (_, index) => (
            <span
              key={index}
              className={`maxoff-plan-strip__tick${
                index < used ? " maxoff-plan-strip__tick--on" : ""
              }`}
            />
          ))}
        </div>
      </div>

      <span
        className={`maxoff-plan-strip__foot${
          atLimit ? " maxoff-plan-strip__foot--at-limit" : ""
        }`}
      >
        {foot}
      </span>
    </div>
  );
}

/**
 * Zone C — the step up, or on the top plan the billing note that used to sit
 * under the whole page.
 */
function Upgrade({
  plan,
  currencyCode,
  upgradeHref,
}: {
  plan: PlanKey;
  currencyCode: string;
  upgradeHref: string | null;
}) {
  const pitch = planPitch(plan);

  if (pitch === null) {
    return (
      <div className="maxoff-plan-strip__zone maxoff-plan-strip__cta">
        <p className="maxoff-plan-strip__pitch">
          Charged through Shopify with the rest of your bill.
        </p>
      </div>
    );
  }

  const targetPrice = formatMoney(PLAN_PRICE_MINOR[pitch.target], currencyCode);

  return (
    <div className="maxoff-plan-strip__zone maxoff-plan-strip__cta">
      <p className="maxoff-plan-strip__pitch">
        {pitch.offer} on {PLAN_LABELS[pitch.target]} &mdash;{" "}
        <strong className="maxoff-plan-strip__pitch-price">
          {targetPrice} / month
        </strong>
        .
      </p>

      {/* Nothing to click when we could not work out where Shopify's plan page
          is. The pitch above still stands, and the page's own banner says what
          went wrong — a dead button would say nothing. */}
      {upgradeHref && (
        <BrandButton fill href={upgradeHref} target="_top">
          Upgrade to {PLAN_LABELS[pitch.target]} &rarr;
        </BrandButton>
      )}
    </div>
  );
}
