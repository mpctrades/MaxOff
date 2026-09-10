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
  comingSoon,
  includedNow,
  nextPlan,
  PLAN_LABELS,
  PLAN_PRICE_MINOR,
  upgradeAdds,
} from "../lib/plans";
import { formatMoney } from "../lib/format";

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

  const [activeCount, capEventCount, keptThisMonth] = await Promise.all([
    prisma.cappedDiscount.count({
      where: activeDiscountWhere(session.shop, new Date()),
    }),
    prisma.capEvent.count({ where: { shop: session.shop } }),
    prisma.capEvent.aggregate({
      where: {
        shop: session.shop,
        occurredAt: {
          gte: new Date(
            Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
          ),
        },
      },
      _sum: { keptMinor: true },
    }),
  ]);

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
    /** False until the orders/paid webhook has written a row. */
    hasCapEvents: capEventCount > 0,
    keptThisMonthMinor: keptThisMonth._sum.keptMinor ?? 0,
    includedNow: includedNow(current.plan).map((entry) => entry.label),
    comingSoon: comingSoon(current.plan).map((entry) => entry.label),
    nextPlan: nextPlan(current.plan),
    upgradeAdds: upgradeAdds(current.plan).map((entry) => entry.label),
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

      {/* ---------------- The value line ---------------- */}
      <s-section heading="Keep more of every large order">
        <s-stack direction="block" gap="base">
          {data.hasCapEvents ? (
            <s-stack direction="block" gap="small-300">
              <s-heading>
                MaxOff kept {money(data.keptThisMonthMinor)} for you this month.
              </s-heading>
              {PLAN_PRICE_MINOR[data.plan] > 0 && (
                <s-text color="subdued">
                  That is{" "}
                  {Math.floor(
                    data.keptThisMonthMinor / PLAN_PRICE_MINOR[data.plan],
                  )}
                  × the subscription.
                </s-text>
              )}
            </s-stack>
          ) : (
            // No CapEvent rows yet, so there is no money-kept figure. §4 of the
            // Home prompt applies here too: lead with what is true.
            <s-text>
              {data.activeCount === 0
                ? "No capped discounts are active yet."
                : `${data.activeCount} capped ${
                    data.activeCount === 1 ? "discount is" : "discounts are"
                  } active and capping at checkout.`}
            </s-text>
          )}

          <s-stack direction="block" gap="small-500">
            <s-text color="subdued">✓ Cancel any time</s-text>
            <s-text color="subdued">✓ Change plan instantly</s-text>
            <s-text color="subdued">✓ Billed through Shopify</s-text>
          </s-stack>
        </s-stack>
      </s-section>

      {/* ---------------- Your plan ---------------- */}
      <s-section heading="Your plan">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-heading>{planLabel}</s-heading>
            <s-badge tone="success">In use</s-badge>
            {data.planSource === "cache" && (
              <s-badge tone="warning">Last known</s-badge>
            )}
          </s-stack>

          {data.unmappedSubscriptionName && (
            <s-banner tone="warning" heading="Unrecognised subscription">
              Shopify reports an active subscription called “
              {data.unmappedSubscriptionName}”, which does not match a MaxOff
              plan. You have been given Growth features while this is sorted
              out.
            </s-banner>
          )}

          <UsageMeter
            activeCount={data.activeCount}
            activeLimit={data.activeLimit}
          />

          <s-divider direction="inline"></s-divider>

          <s-grid gridTemplateColumns="1fr auto" gap="base">
            <s-text color="subdued">Charged through</s-text>
            <s-text>Shopify</s-text>
          </s-grid>

          {/* Omitted rather than guessed when Shopify does not tell us. */}
          {data.currentPeriodEnd && (
            <s-grid gridTemplateColumns="1fr auto" gap="base">
              <s-text color="subdued">Next charge</s-text>
              <s-text>{data.currentPeriodEnd.slice(0, 10)}</s-text>
            </s-grid>
          )}

          <s-divider direction="inline"></s-divider>

          <s-heading>Included now</s-heading>
          <s-unordered-list>
            {data.includedNow.map((label) => (
              <s-list-item key={label}>{label}</s-list-item>
            ))}
          </s-unordered-list>

          {data.comingSoon.length > 0 && (
            <s-stack direction="block" gap="small-300">
              <s-text color="subdued">
                On your plan, not built yet — you will not be charged extra when
                it arrives:
              </s-text>
              <s-unordered-list>
                {data.comingSoon.map((label) => (
                  <s-list-item key={label}>{label}</s-list-item>
                ))}
              </s-unordered-list>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* ---------------- The upsell, contextual ----------------
          Nothing at all on Pro: a card selling a plan the merchant already has
          is the tell that it was hard-coded. */}
      {data.nextPlan !== null && (
        <s-section heading={`Move to ${PLAN_LABELS[data.nextPlan]}`}>
          <s-stack direction="block" gap="base">
            <s-text>
              {PLAN_LABELS[data.nextPlan]} is{" "}
              {money(PLAN_PRICE_MINOR[data.nextPlan])} a month and adds:
            </s-text>
            <s-unordered-list>
              {data.upgradeAdds.map((label) => (
                <s-list-item key={label}>{label}</s-list-item>
              ))}
            </s-unordered-list>

            {data.hostedPlanUrl !== null ? (
              <form method="post">
                <input type="hidden" name="intent" value="view-plans" />
                <s-button variant="primary" type="submit">
                  View plans &amp; pricing →
                </s-button>
              </form>
            ) : (
              <s-banner tone="warning" heading="Plan page unavailable">
                MaxOff could not work out where your plan page is. Open the
                app&apos;s listing from your Shopify admin to change plan.
              </s-banner>
            )}

            <s-text color="subdued">
              Prices, free trials and yearly billing are shown and handled by
              Shopify. Upgrades, downgrades and cancellations all take effect
              there.
            </s-text>
          </s-stack>
        </s-section>
      )}

      <s-paragraph color="subdued">
        Charged through Shopify with the rest of your bill. Cancel any time from
        your Shopify admin.
      </s-paragraph>
    </s-page>
  );
}

/**
 * `1 of 1 capped discounts used`, from the same count the limit itself uses.
 *
 * Polaris has no meter or progress component in this version, so the bar is
 * two nested boxes — the same composition Home's setup progress uses — and the
 * sentence above it is the text alternative rather than an afterthought.
 * Unlimited plans get the sentence and no bar, because a bar pinned at 100%
 * would read as a limit that is not there.
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
      <s-text>
        {activeCount} capped {activeCount === 1 ? "discount" : "discounts"}{" "}
        active · unlimited on your plan
      </s-text>
    );
  }

  const percent = Math.min(
    Math.round((activeCount / Math.max(activeLimit, 1)) * 100),
    100,
  );

  return (
    <s-stack direction="block" gap="small-300">
      <s-text>
        {activeCount} of {activeLimit} capped{" "}
        {activeLimit === 1 ? "discount" : "discounts"} used
      </s-text>
      <s-box
        background="subdued"
        borderRadius="small"
        blockSize="6px"
        inlineSize="100%"
        overflow="hidden"
        accessibilityLabel={`${activeCount} of ${activeLimit} capped discounts used`}
      >
        <s-box
          background="strong"
          borderRadius="small"
          blockSize="6px"
          inlineSize={`${percent}%`}
        ></s-box>
      </s-box>
      {activeCount >= activeLimit && (
        <s-text color="subdued">
          You are at your plan&apos;s limit. Pause one to activate another, or
          move up a plan.
        </s-text>
      )}
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
