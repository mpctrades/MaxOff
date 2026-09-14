import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getCurrentPlan,
  hostedPlanPageUrl,
  recordPlanHandle,
} from "../models/plan.server";
import { activeDiscountWhere } from "../models/discounts.server";
import {
  activeDiscountLimit,
  nextPlan,
  planCard,
  PLAN_KEYS,
  PLAN_LABELS,
  PLAN_PRICE_MINOR,
  PLAN_TAGLINES,
} from "../lib/plans";
import type { PlanKey } from "../lib/plans";
import { formatAmount } from "../lib/format";
import { BrandButton } from "../components/BrandButton";
import { PlanStrip } from "../components/PlanStrip";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Shopify App Pricing sends no webhook for subscription changes; after a
  // merchant approves a plan it redirects to the app's welcome link with a
  // `plan_handle` parameter. That redirect is the only push we get, so if it
  // lands here it is authoritative.
  const planHandle = new URL(request.url).searchParams.get("plan_handle");
  if (planHandle) {
    await recordPlanHandle({ shop: session.shop, planHandle });
  }

  const [current, settings] = await Promise.all([
    getCurrentPlan({ shop: session.shop, admin }),
    prisma.shopSettings.findUnique({ where: { shop: session.shop } }),
  ]);

  // Only the active count is needed now. The money-kept figure and its
  // CapEvent aggregate went with the "Keep more of every large order" card
  // that this layout replaced — two queries on every load for something
  // nothing renders.
  const activeCount = await prisma.cappedDiscount.count({
    where: activeDiscountWhere(session.shop, new Date()),
  });

  return {
    plan: current.plan,
    planSource: current.source,
    unmappedSubscriptionName: current.unmappedSubscriptionName,
    currentPeriodEnd: current.currentPeriodEnd,
    hostedPlanUrl: hostedPlanPageUrl({
      shop: session.shop,
      appHandle: current.appHandle,
    }),
    currencyCode: settings?.currencyCode ?? "USD",
    activeCount,
    activeLimit: activeDiscountLimit(current.plan),
    /** The column the page recommends: whatever is one step up, nothing on
     *  Pro. A statically "recommended" plan is the tell that a pricing table
     *  was hard-coded, and it reads as nonsense to a merchant who is already
     *  above it. */
    recommended: nextPlan(current.plan),
  };
};

export default function BillingPage() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Plans &amp; billing">
      {data.unmappedSubscriptionName && (
        <s-banner tone="warning" heading="Unrecognised subscription">
          Shopify reports an active subscription called “
          {data.unmappedSubscriptionName}”, which does not match a MaxOff plan.
          You have been given Growth features while this is sorted out.
        </s-banner>
      )}

      {/* ---------------- What you are on, and the one step up ------------- */}
      <s-section>
        <PlanStrip
          plan={data.plan}
          currencyCode={data.currencyCode}
          activeCount={data.activeCount}
          lastKnown={data.planSource === "cache"}
          nextChargeOn={data.currentPeriodEnd}
          action={
            data.recommended !== null && data.hostedPlanUrl !== null ? (
              /* The name, not the price. The price is on the plan's own
                 card a few centimetres below, and a button that carries it
                 runs wider than the strip it sits in. */
              <BrandButton href={data.hostedPlanUrl} target="_top">
                Upgrade to {PLAN_LABELS[data.recommended]}
              </BrandButton>
            ) : undefined
          }
        />
      </s-section>

      {/* ---------------- Compare plans ---------------- */}
      <s-section heading="Compare plans">
        <div className="maxoff-plan-cards">
          {PLAN_KEYS.map((plan) => (
            <PlanCard
              key={plan}
              plan={plan}
              currentPlan={data.plan}
              recommended={data.recommended}
              currencyCode={data.currencyCode}
              hostedPlanUrl={data.hostedPlanUrl}
            />
          ))}
        </div>
      </s-section>

      {data.hostedPlanUrl === null && (
        <s-banner tone="warning" heading="Plan page unavailable">
          MaxOff could not work out where your plan page is. Open the app&apos;s
          listing from your Shopify admin to change plan.
        </s-banner>
      )}

      <s-paragraph color="subdued">
        Charged through Shopify with the rest of your bill. Cancel any time from
        your Shopify admin.
      </s-paragraph>
    </s-page>
  );
}

/**
 * One plan, as a card.
 *
 * Every line comes from `planCard`, so the card cannot list a feature the
 * matrix does not grant — the bug `plans.ts` exists to prevent. Every line is
 * also something the plan **has**: a card names what a merchant gets, never
 * what they are missing, so there is one mark and one screen-reader prefix.
 */
function PlanCard({
  plan,
  currentPlan,
  recommended,
  currencyCode,
  hostedPlanUrl,
}: {
  plan: PlanKey;
  currentPlan: PlanKey;
  recommended: PlanKey | null;
  currencyCode: string;
  hostedPlanUrl: string | null;
}) {
  const { allowance, rollupFrom, features } = planCard(plan);
  const isRecommended = plan === recommended;

  return (
    <div
      className={`maxoff-plan-card${
        isRecommended ? " maxoff-plan-card--recommended" : ""
      }`}
    >
      <div className="maxoff-plan-card__name">
        <strong>{PLAN_LABELS[plan]}</strong>
        {plan === currentPlan && <s-badge tone="success">Current</s-badge>}
        {isRecommended && <s-badge>Recommended</s-badge>}
      </div>

      <div className="maxoff-plan-card__price">
        <span className="maxoff-plan-card__amount maxoff-tabular">
          {formatAmount(PLAN_PRICE_MINOR[plan])}
        </span>{" "}
        <span className="maxoff-plan-card__per">
          {currencyCode}
          {PLAN_PRICE_MINOR[plan] > 0 && " / month"}
        </span>
      </div>

      <p className="maxoff-plan-card__tagline">{PLAN_TAGLINES[plan]}</p>

      <ul className="maxoff-plan-card__features">
        {/* The allowance leads, above the roll-up: "Everything in Growth"
            carries Growth's limit of 20 with it, so unlimited has to be read
            first or it reads as a correction. */}
        <li key={allowance.label}>
          <span className="maxoff-plan-card__yes" aria-hidden="true">
            ✓
          </span>
          <span>
            <span className="maxoff-visually-hidden">Included: </span>
            {allowance.lead && <strong>{allowance.lead} </strong>}
            {allowance.label}
          </span>
        </li>
        {rollupFrom !== null && (
          <li>
            <span className="maxoff-plan-card__yes" aria-hidden="true">
              ✓
            </span>
            <span>
              Everything in <strong>{PLAN_LABELS[rollupFrom]}</strong>
            </span>
          </li>
        )}
        {features.map((feature) => (
          <li key={feature.label}>
            <span className="maxoff-plan-card__yes" aria-hidden="true">
              ✓
            </span>
            <span>
              <span className="maxoff-visually-hidden">Included: </span>
              {feature.lead && <strong>{feature.lead} </strong>}
              {feature.label}
            </span>
          </li>
        ))}
      </ul>

      <div className="maxoff-plan-card__action">
        <PlanAction
          plan={plan}
          currentPlan={currentPlan}
          recommended={recommended}
          hostedPlanUrl={hostedPlanUrl}
        />
      </div>
    </div>
  );
}

/**
 * The button under a plan.
 *
 * Every upgrade goes to the same place — Shopify hosts plan selection and we
 * cannot charge directly — so these are calls to action, not three different
 * destinations. The label still names the plan, because that is what the
 * merchant is going there to pick.
 */
function PlanAction({
  plan,
  currentPlan,
  recommended,
  hostedPlanUrl,
}: {
  plan: PlanKey;
  currentPlan: PlanKey;
  recommended: PlanKey | null;
  hostedPlanUrl: string | null;
}) {
  if (plan === currentPlan) {
    return (
      <BrandButton
        fill
        disabled
        variant="secondary"
        accessibilityLabel="This is your current plan"
      >
        Current plan
      </BrandButton>
    );
  }

  if (hostedPlanUrl === null) {
    return null;
  }

  const below = PLAN_KEYS.indexOf(plan) < PLAN_KEYS.indexOf(currentPlan);

  return (
    <BrandButton
      fill
      href={hostedPlanUrl}
      target="_top"
      variant={plan === recommended ? "primary" : "secondary"}
    >
      {below
        ? `Move to ${PLAN_LABELS[plan]}`
        : `Upgrade to ${PLAN_LABELS[plan]}`}
    </BrandButton>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
