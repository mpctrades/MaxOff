/**
 * The merchant's plan, read from Shopify rather than guessed locally.
 *
 * `ShopSettings.plan` defaulted to `"free"` and nothing ever wrote it, so every
 * merchant was Free forever — including one who paid. §4.8 is explicit: read
 * the current plan back from Shopify, never from a local guess. This module is
 * the one place that does it; the column is now a cache of Shopify's answer,
 * the same shape as the currency fix in Settings.
 *
 * ── One thing Sophea must confirm on the dev store ──────────────────────────
 * The Shopify App Pricing docs say to *"Query `activeSubscription(appId:,
 * shopId:)` on the Partner API"* to read a merchant's App Pricing contract.
 * The Partner API needs a Partner-organisation token, which an embedded app
 * request does not have, and the docs never say whether App Pricing
 * subscriptions also appear in the Admin API's
 * `currentAppInstallation.activeSubscriptions`.
 *
 * That Admin query is what this module uses: it validates against the live
 * 2026-10 schema, needs no access scope, and is the only plan read available
 * from inside the app. Whether it returns MaxOff's App Pricing plans cannot be
 * checked until the three plans exist in the Partner Dashboard — which is
 * Sophea's Gate 6 task. Until then this correctly reports "free", because
 * there is genuinely no paid subscription to find.
 *
 * The documented fallback, if the Admin query turns out to be blind to App
 * Pricing: the plan handle arrives as a `plan_handle` URL parameter on the
 * welcome-link redirect after a merchant approves a plan. `recordPlanHandle`
 * below already accepts it, so that path needs no new code — only wiring the
 * welcome link in the Partner Dashboard.
 */

import type { ShopSettings } from "@prisma/client";

import prisma from "../db.server";
import {
  isPlanKey,
  PLAN_ACTIVE_DISCOUNT_LIMIT,
  PLAN_KEYS,
  PLAN_LABELS,
  toPlanKey,
} from "../lib/plans";
import type { PlanKey } from "../lib/plans";
import { ensureShopSettings } from "./settings.server";

/**
 * The plan, plus the app handle the hosted pricing page URL needs. One query,
 * because the billing page wants both and neither needs a scope.
 */
const CURRENT_PLAN_QUERY = `#graphql
  query MaxOffCurrentPlan {
    currentAppInstallation {
      app {
        handle
      }
      activeSubscriptions {
        id
        name
        status
        currentPeriodEnd
      }
    }
  }`;

export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

interface Subscription {
  id: string;
  name?: string | null;
  status?: string | null;
  currentPeriodEnd?: string | null;
}

interface CurrentPlanResponse {
  data?: {
    currentAppInstallation?: {
      app?: { handle?: string | null } | null;
      activeSubscriptions?: Subscription[] | null;
    } | null;
  } | null;
}

export interface CurrentPlan {
  plan: PlanKey;
  /**
   * Where the answer came from, so the page can be honest about it.
   *
   * `"unmapped"` is the loud one: Shopify confirmed a paid subscription and we
   * could not tell which plan it is. `plan` is then the Free floor — an
   * entitlement we are certain the merchant is owed — and never a guess at the
   * one they paid for.
   */
  source: "shopify" | "cache" | "unmapped";
  /** The app handle, for the hosted plan-selection URL. Null if unavailable. */
  appHandle: string | null;
  /** ISO date of the next charge, when Shopify tells us. Never guessed. */
  currentPeriodEnd: string | null;
  /** An active subscription whose name we could not map to a plan. */
  unmappedSubscriptionName: string | null;
}

/**
 * Map a subscription name or plan handle onto one of our three plans.
 *
 * Matched case-insensitively against both the plan keys and their labels, so
 * "Growth", "growth" and a `growth` handle all land in the same place.
 */
function planFromLabel(value: string | null | undefined): PlanKey | null {
  if (!value) {
    return null;
  }

  const needle = value.trim().toLowerCase();
  if (isPlanKey(needle)) {
    return needle;
  }

  return (
    PLAN_KEYS.find((key) => PLAN_LABELS[key].toLowerCase() === needle) ?? null
  );
}

/**
 * Read the plan from Shopify and refresh the cache.
 *
 * No active subscription means Free — that is the honest reading, not a
 * fallback. If the read itself fails, the cached value stands: a billing page
 * that cannot reach Shopify should show the last known plan rather than
 * silently downgrade a paying merchant.
 */
export async function getCurrentPlan(input: {
  shop: string;
  admin: AdminGraphqlClient;
}): Promise<CurrentPlan> {
  const settings = await ensureShopSettings(input.shop);

  let body: CurrentPlanResponse;
  try {
    const response = await input.admin.graphql(CURRENT_PLAN_QUERY);
    body = (await response.json()) as CurrentPlanResponse;
  } catch {
    return {
      plan: toPlanKey(settings.plan),
      source: "cache",
      appHandle: null,
      currentPeriodEnd: null,
      unmappedSubscriptionName: null,
    };
  }

  const installation = body.data?.currentAppInstallation;
  if (!installation) {
    return {
      plan: toPlanKey(settings.plan),
      source: "cache",
      appHandle: null,
      currentPeriodEnd: null,
      unmappedSubscriptionName: null,
    };
  }

  const active = (installation.activeSubscriptions ?? []).filter(
    (subscription) =>
      (subscription.status ?? "").toUpperCase() === "ACTIVE" ||
      subscription.status == null,
  );

  let plan: PlanKey = "free";
  let unmappedSubscriptionName: string | null = null;
  let currentPeriodEnd: string | null = null;
  let source: CurrentPlan["source"] = "shopify";

  if (active.length > 0) {
    const subscription = active[0];
    currentPeriodEnd = subscription.currentPeriodEnd ?? null;

    const mapped = planFromLabel(subscription.name);
    if (mapped) {
      plan = mapped;
    } else {
      // A subscription we cannot name is still a subscription somebody is
      // paying for — and that is exactly why we must not guess which one.
      //
      // This used to grant Growth, on the reasoning that "paid is at least the
      // cheapest paid tier". That is wrong in the direction that costs the
      // merchant: a plan named "MaxOff Pro" or "Pro plan" in the Partner
      // Dashboard misses `planFromLabel`, and the merchant is then charged
      // 7.99 and quietly served Growth — no error, no banner, just two
      // entitlements they paid for and cannot find.
      //
      // So `plan` drops to the Free floor, which is the only entitlement we
      // are certain they are owed, and `source` says "unmapped" so every
      // surface can say plainly that we could not read the plan. A merchant
      // who sees "we cannot read your plan, contact support" gets it fixed.
      // A merchant silently short-changed never knows to ask.
      plan = "free";
      source = "unmapped";
      unmappedSubscriptionName = subscription.name ?? null;
      // eslint-disable-next-line no-console
      console.warn(
        `[maxoff] active subscription ${JSON.stringify(subscription.name)} ` +
          `(id ${subscription.id}, status ${subscription.status ?? "null"}) ` +
          `matches no MaxOff plan. Matched case-insensitively against keys ` +
          `[${PLAN_KEYS.join(", ")}] and labels ` +
          `[${PLAN_KEYS.map((key) => PLAN_LABELS[key]).join(", ")}]. ` +
          `Serving the Free floor and surfacing the mismatch; rename the plan ` +
          `in the Partner Dashboard to one of those labels to resolve it.`,
      );
    }
  }

  // Only a plan we could actually identify is worth caching. Writing the Free
  // floor over a merchant's last known Growth would turn a naming mistake into
  // a downgrade that outlives it.
  if (source === "shopify") {
    await cachePlan(settings, plan);
  }

  return {
    plan,
    source,
    appHandle: installation.app?.handle ?? null,
    currentPeriodEnd,
    unmappedSubscriptionName,
  };
}

/**
 * The plan as a screen should state it, with "we could not tell" kept apart
 * from "Free".
 *
 * `getCurrentPlan` answers every call with a `PlanKey`, and when the billing
 * read fails it falls back to the cached column — which defaults to `"free"`
 * and, on a shop nobody has ever successfully read, has never been written.
 * That is the right behaviour for a *gate*: refusing a paid feature to a
 * merchant we cannot verify is the safe direction to fail.
 *
 * It is the wrong behaviour for a *label*. Printing "Free" at the top of Home
 * because Shopify timed out tells a merchant paying 7.99 a month that they are
 * not paying, which is worse than admitting we do not know. So this wrapper
 * keeps the distinction the gate deliberately throws away: `plan` is null when
 * the answer came from the cache rather than from Shopify, and no caller may
 * turn that null into "free".
 *
 * One query. This calls `getCurrentPlan` — the same helper Plans & billing and
 * the create form use — and adds no billing round trip of its own.
 */
export interface PlanSummary {
  /**
   * The plan Shopify confirmed, or null when it could not be read. Never
   * "free" as a stand-in for null.
   */
  plan: PlanKey | null;
  /** How many discounts may be active. Null for unlimited *and* for unknown. */
  activeLimit: number | null;
}

export async function getPlanSummary(input: {
  shop: string;
  admin: AdminGraphqlClient;
}): Promise<PlanSummary> {
  const current = await getCurrentPlan(input);

  // "cache" is `getCurrentPlan`'s word for "the read did not happen" — the
  // GraphQL call threw, or Shopify returned no installation. Either way we
  // have no answer, only a column. "unmapped" is the read happening and
  // returning a subscription we cannot name, which is just as much a non-answer
  // — and the one case where printing a plan name would be an active lie.
  if (current.source !== "shopify") {
    return { plan: null, activeLimit: null };
  }

  return {
    plan: current.plan,
    activeLimit: PLAN_ACTIVE_DISCOUNT_LIMIT[current.plan],
  };
}

/**
 * The plan for a gate, read live.
 *
 * Create and pause/activate both hold an admin client, so they ask Shopify
 * rather than trusting the cache — a merchant who upgraded a minute ago must
 * not be refused a second discount because nobody had opened the billing page
 * since.
 */
export async function getPlanForGate(input: {
  shop: string;
  admin: AdminGraphqlClient;
}): Promise<PlanKey> {
  const { plan } = await getCurrentPlan(input);
  return plan;
}

/**
 * The documented App Pricing signal: after a merchant approves a plan, Shopify
 * redirects to the app's welcome link with a `plan_handle` parameter. Shopify
 * App Pricing sends no webhook for subscription changes, so this redirect is
 * the only push we get.
 */
export async function recordPlanHandle(input: {
  shop: string;
  planHandle: string | null;
}): Promise<PlanKey | null> {
  const plan = planFromLabel(input.planHandle);
  if (plan === null) {
    return null;
  }

  const settings = await ensureShopSettings(input.shop);
  await cachePlan(settings, plan);

  return plan;
}

async function cachePlan(settings: ShopSettings, plan: PlanKey): Promise<void> {
  if (settings.plan === plan) {
    return;
  }

  await prisma.shopSettings.update({
    where: { shop: settings.shop },
    data: { plan },
  });
}

/**
 * Shopify's hosted plan-selection page, confirmed against the App Pricing
 * docs on 10 Sep 2026:
 *
 *   https://admin.shopify.com/store/:store_handle/charges/:app_handle/pricing_plans
 *
 * The store handle is the shop domain without `.myshopify.com`. Returns null
 * when the app handle is unknown, so the page can hide the button rather than
 * send a merchant to a broken URL.
 */
export function hostedPlanPageUrl(input: {
  shop: string;
  appHandle: string | null;
}): string | null {
  if (!input.appHandle) {
    return null;
  }

  const storeHandle = input.shop.replace(/\.myshopify\.com$/, "");

  return `https://admin.shopify.com/store/${storeHandle}/charges/${input.appHandle}/pricing_plans`;
}
