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
  isPlanKey,
  nextPlan,
  planActionLabel,
  planAllowanceSummary,
  planCard,
  planDirection,
  PLAN_KEYS,
  PLAN_LABELS,
  PLAN_PRICE_MINOR,
  PLAN_TAGLINES,
} from "../lib/plans";
import type { PlanKey } from "../lib/plans";
import { devPreviewAllowed } from "../lib/dev-preview";
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

  /* `/app/billing?plan=free` on a deployment that allows previews — see
     `dev-preview.ts`. A dev store sits on one plan and can never show the
     other two columns as "current", which is exactly the arrangement this
     section exists to get right. Refused unless explicitly switched on, and
     it reaches labels and colours only: every button below still goes to
     Shopify's hosted plan page, and every real gate re-reads the plan. */
  const forcedParam = new URL(request.url).searchParams.get("plan");
  const forcedPlan =
    devPreviewAllowed() && isPlanKey(forcedParam) ? forcedParam : null;
  const plan = forcedPlan ?? current.plan;

  // Only the active count is needed now. The money-kept figure and its
  // CapEvent aggregate went with the "Keep more of every large order" card
  // that this layout replaced — two queries on every load for something
  // nothing renders.
  const activeCount = await prisma.cappedDiscount.count({
    where: activeDiscountWhere(session.shop, new Date()),
  });

  return {
    plan,
    planPreviewed: forcedPlan !== null,
    planSource: current.source,
    unmappedSubscriptionName: current.unmappedSubscriptionName,
    currentPeriodEnd: current.currentPeriodEnd,
    trialEndsAt: current.trialEndsAt,
    hostedPlanUrl: hostedPlanPageUrl({
      shop: session.shop,
      appHandle: current.appHandle,
    }),
    currencyCode: settings?.currencyCode ?? "USD",
    activeCount,
    activeLimit: activeDiscountLimit(plan),
    /** The column the page recommends: whatever is one step up, nothing on
     *  Pro. A statically "recommended" plan is the tell that a pricing table
     *  was hard-coded, and it reads as nonsense to a merchant who is already
     *  above it. */
    recommended: nextPlan(plan),
  };
};

export default function BillingPage() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Plans &amp; billing">
      {data.unmappedSubscriptionName && (
        <s-banner tone="critical" heading="We cannot read your plan">
          Shopify reports an active subscription called “
          {data.unmappedSubscriptionName}”, which does not match a MaxOff plan.
          Until that is sorted out you have Free plan limits, even though you
          are being charged. Contact support and we will put it right — your
          discounts keep running in the meantime.
        </s-banner>
      )}

      {/* One explanation at the top, rather than the same sentence repeated
          under all three cards. The cards still say it individually, because a
          merchant who scrolls straight to Pro should not have to scroll back. */}
      {data.hostedPlanUrl === null && (
        <s-banner tone="warning" heading="Plan changes are temporarily unavailable">
          We could not reach Shopify&rsquo;s plan page for this store. Your
          current plan and your capped discounts are unaffected. Try again in a
          few minutes, or contact support and we will change your plan for you.
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
          trialEndsAt={data.trialEndsAt}
          upgradeHref={data.hostedPlanUrl}
        />
      </s-section>

      {/* ---------------- Compare plans ---------------- */}
      <s-section heading="Compare plans">
        {/* One line naming where the merchant already is, so the three columns
            below are read as a choice relative to something rather than as a
            fresh pitch. The allowance is built from the capability matrix in
            `plans.ts`, so this sentence cannot drift from the cards under it. */}
        <s-paragraph color="subdued">
          You are on {PLAN_LABELS[data.plan]} &mdash;{" "}
          {planAllowanceSummary(data.plan)}.
        </s-paragraph>

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
  const direction = planDirection(plan, currentPlan);

  /* The recommended ring is dropped on the card the merchant is already on.
     Green already says "you are here"; a second 2px ring saying "consider
     this" on the same card is two instructions at once. */
  const isRecommended = plan === recommended && direction !== "current";

  return (
    <div
      className={[
        "maxoff-plan-card",
        `maxoff-plan-card--${direction}`,
        isRecommended ? "maxoff-plan-card--recommended" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="maxoff-plan-card__name">
        <strong>{PLAN_LABELS[plan]}</strong>
        {/* Our own marks, not `s-badge`: Polaris paints a badge inside its
            shadow DOM, so neither the soft green nor the brand orange this
            section is built around is reachable through it. */}
        {direction === "current" && (
          <span className="maxoff-plan-card__badge maxoff-plan-card__badge--current">
            Current
          </span>
        )}
        {isRecommended && (
          <span className="maxoff-plan-card__badge maxoff-plan-card__badge--recommended">
            Recommended
          </span>
        )}
      </div>

      <div className="maxoff-plan-card__price">
        <span className="maxoff-plan-card__amount maxoff-tabular">
          {formatAmount(PLAN_PRICE_MINOR[plan])}
        </span>
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
  hostedPlanUrl,
}: {
  plan: PlanKey;
  currentPlan: PlanKey;
  hostedPlanUrl: string | null;
}) {
  const direction = planDirection(plan, currentPlan);

  if (direction === "current") {
    /* Not a `BrandButton`: `disabled` on a real button takes it out of the
       accessibility tree in some readers, and this one has something to say.
       `aria-disabled` keeps it announced while `tabIndex={-1}` and the absence
       of any handler keep it out of the tab order and inert. */
    return (
      <button
        type="button"
        className="maxoff-plan-card__current-action"
        aria-disabled="true"
        aria-label="Current plan, no action available"
        tabIndex={-1}
      >
        Current plan
      </button>
    );
  }

  // Shopify hosts plan selection, and the URL needs the app's own handle. When
  // the handle cannot be read the button has nowhere to go — but rendering
  // nothing leaves a merchant staring at a plan they cannot choose, with no
  // hint that anything went wrong. App Store requirement 1.2.3 is that a
  // merchant can change plan without contacting support; when we genuinely
  // cannot offer that, the least we owe them is to say so and where to ask.
  if (hostedPlanUrl === null) {
    return (
      <s-text color="subdued">
        Plan changes are temporarily unavailable. Contact support and we will
        move you to {PLAN_LABELS[plan]}.
      </s-text>
    );
  }

  /* One variant for both directions. The fill is set by the card's own
     `--up` / `--down` class in `theme.css`, so the colour follows the plan's
     position rather than a prop that has to be kept in step with it. */
  return (
    <BrandButton fill href={hostedPlanUrl} target="_top">
      {planActionLabel(plan, currentPlan)}
    </BrandButton>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
