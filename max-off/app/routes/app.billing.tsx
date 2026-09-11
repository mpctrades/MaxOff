import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
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
import { formatAmount, formatMoney } from "../lib/format";
import { BrandButton } from "../components/BrandButton";

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

/**
 * Leaving the embedded frame for Shopify's hosted plan page.
 *
 * The App Pricing docs say the redirect must leave the app frame and that
 * React Router apps should "use the framework's redirect utility" — which is
 * the `redirect` helper `authenticate.admin` returns, with `target: "_top"`.
 * A plain `<form method="post">` is used rather than React Router's `<Form>`
 * so the browser performs a real navigation and honours that response.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);

  const form = await request.formData();
  if (form.get("intent") !== "view-plans") {
    return { ok: false as const, message: "Unknown action." };
  }

  const { appHandle } = await getCurrentPlan({ shop: session.shop, admin });
  const url = hostedPlanPageUrl({ shop: session.shop, appHandle });

  if (url === null) {
    return {
      ok: false as const,
      message:
        "MaxOff could not work out where your plan page is. Open the app from your Shopify admin to change plan.",
    };
  }

  return redirect(url, { target: "_top" });
};

export default function BillingPage() {
  const data = useLoaderData<typeof loader>();
  const money = (minor: number) => formatMoney(minor, data.currencyCode);
  const planLabel = PLAN_LABELS[data.plan];

  return (
    <s-page heading="Plans &amp; billing">
      <s-paragraph color="subdued">
        Flat monthly price. No transaction fees, no revenue share — ever.
      </s-paragraph>

      {data.unmappedSubscriptionName && (
        <s-banner tone="warning" heading="Unrecognised subscription">
          Shopify reports an active subscription called “
          {data.unmappedSubscriptionName}”, which does not match a MaxOff plan.
          You have been given Growth features while this is sorted out.
        </s-banner>
      )}

      {/* ---------------- What you are on, and the one step up ------------- */}
      <s-section>
        <div className="maxoff-plan-strip">
          <div className="maxoff-plan-strip__plan">
            <div className="maxoff-plan-strip__name">
              <strong>{planLabel}</strong>
              <s-badge tone="success">In use</s-badge>
              {data.planSource === "cache" && (
                <s-badge tone="warning">Last known</s-badge>
              )}
            </div>
            <span className="maxoff-plan-strip__price maxoff-tabular">
              {money(PLAN_PRICE_MINOR[data.plan])} per month
            </span>
            {/* Omitted rather than guessed when Shopify does not tell us. */}
            {data.currentPeriodEnd && (
              <span className="maxoff-plan-strip__next">
                Next charge {data.currentPeriodEnd.slice(0, 10)}
              </span>
            )}
          </div>

          {data.recommended !== null && data.hostedPlanUrl !== null && (
            <div className="maxoff-plan-strip__action">
              <form method="post">
                <input type="hidden" name="intent" value="view-plans" />
                <BrandButton type="submit">
                  Upgrade to {PLAN_LABELS[data.recommended]} —{" "}
                  {money(PLAN_PRICE_MINOR[data.recommended])}/mo
                </BrandButton>
              </form>
              {/* Not "takes effect immediately": the button opens Shopify's
                  plan page, and the change lands when the merchant approves it
                  there. Close enough to the drawing, true either way. */}
              <span className="maxoff-plan-strip__note">
                Takes effect as soon as you approve it on Shopify.
              </span>
            </div>
          )}

          <UsageMeter
            activeCount={data.activeCount}
            activeLimit={data.activeLimit}
          />
        </div>
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
 * matrix does not grant — the bug `plans.ts` exists to prevent. An entitlement
 * that is not built yet is still ticked, because the merchant is paying for
 * it, but it carries a "Soon" badge: `plans.ts` keeps entitlement and reality
 * apart precisely so a card can say which is which.
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
  const { rollupFrom, features } = planCard(plan);
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
        <span className="maxoff-plan-card__per">{currencyCode} / month</span>
      </div>

      <p className="maxoff-plan-card__tagline">{PLAN_TAGLINES[plan]}</p>

      <ul className="maxoff-plan-card__features">
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
          <li
            key={feature.label}
            className={feature.included ? "" : "maxoff-plan-card__missing"}
          >
            <span
              className={
                feature.included
                  ? "maxoff-plan-card__yes"
                  : "maxoff-plan-card__no"
              }
              aria-hidden="true"
            >
              {feature.included ? "✓" : "–"}
            </span>
            <span>
              <span className="maxoff-visually-hidden">
                {feature.included ? "Included: " : "Not included: "}
              </span>
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
    <form method="post">
      <input type="hidden" name="intent" value="view-plans" />
      <BrandButton
        fill
        type="submit"
        variant={plan === recommended ? "primary" : "secondary"}
      >
        {below
          ? `Move to ${PLAN_LABELS[plan]}`
          : `Upgrade to ${PLAN_LABELS[plan]}`}
      </BrandButton>
    </form>
  );
}

/**
 * `Capped discounts … 0 of 1 used`, from the same count the limit itself uses.
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
