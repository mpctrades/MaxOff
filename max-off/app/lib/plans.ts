/**
 * The entitlement matrix — the single source of truth for what each plan gets.
 *
 * The billing cards render from this, and every gate in the app reads from it.
 * A feature list hand-written in a component is how a page ends up promising
 * something the code does not do, and two definitions of the Free limit is the
 * bug this module exists to prevent.
 *
 * Every entry carries both the entitlement **and** whether it is actually
 * built, so the cards can tell a merchant what they have today apart from what
 * is coming. BUILD-SPEC §2 and §3.6.
 */

export type PlanKey = "free" | "growth" | "pro";

export const PLAN_KEYS: readonly PlanKey[] = ["free", "growth", "pro"];

export const PLAN_LABELS: Record<PlanKey, string> = {
  free: "Free",
  growth: "Growth",
  pro: "Pro",
};

/** Monthly price in minor units. §3.6: flat, no transaction fee, ever. */
export const PLAN_PRICE_MINOR: Record<PlanKey, number> = {
  free: 0,
  growth: 499,
  pro: 999,
};

/** How many capped discounts may be active at once. Null means unlimited. */
export const PLAN_ACTIVE_DISCOUNT_LIMIT: Record<PlanKey, number | null> = {
  free: 1,
  growth: null,
  pro: null,
};

export type CapabilityKey =
  | "orderMaximum"
  | "previewAndTester"
  | "activeDates"
  | "analytics"
  | "customCheckoutWording"
  | "itemAndCollectionMaximums"
  | "perMarketCurrency"
  | "csvExport"
  | "twelveMonthHistory"
  | "prioritySupport";

export interface Capability {
  key: CapabilityKey;
  label: string;
  /** Which plans include it. */
  plans: readonly PlanKey[];
  /** Whether it exists in the product today. */
  built: boolean;
  /** Why it is not built yet — shown to nobody, read by the next developer. */
  note?: string;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    key: "orderMaximum",
    label: "A maximum on the whole order",
    plans: ["free", "growth", "pro"],
    built: true,
  },
  {
    key: "previewAndTester",
    label: "Live preview and cart tester",
    plans: ["free", "growth", "pro"],
    built: true,
  },
  {
    // §0c, decided 10 Sep 2026: dates were sold as Growth but shipped to
    // everyone ungated. They stay in Free — already built, cheap to give, and
    // taking a working feature off Free merchants later is worse than never
    // having offered it.
    key: "activeDates",
    label: "Start and end dates",
    plans: ["free", "growth", "pro"],
    built: true,
  },
  {
    key: "analytics",
    label: "Money-kept dashboard and analytics",
    plans: ["growth", "pro"],
    built: false,
    note: "Blocked on read_orders protected-customer-data approval.",
  },
  {
    key: "customCheckoutWording",
    label: "Custom checkout wording",
    plans: ["growth", "pro"],
    built: false,
    note: "V2. The field is rendered disabled on Create and Settings.",
  },
  {
    key: "itemAndCollectionMaximums",
    label: "A maximum per item and per collection",
    plans: ["pro"],
    built: false,
    note: "PRO. Needs a cap_config scope beyond 'order' and a Function change.",
  },
  {
    key: "perMarketCurrency",
    label: "A different maximum per market currency",
    plans: ["pro"],
    built: false,
    note: "PRO. Amounts relabel and never convert, so this needs real per-market caps.",
  },
  {
    key: "csvExport",
    label: "CSV export",
    plans: ["pro"],
    built: false,
    note: "PRO. The list's Export button toasts 'Export is a Pro feature'.",
  },
  {
    key: "twelveMonthHistory",
    label: "12-month history",
    plans: ["pro"],
    built: false,
    note: "PRO. Analytics range chips beyond 90 days are disabled.",
  },
  {
    key: "prioritySupport",
    label: "Priority support",
    plans: ["pro"],
    built: false,
    note: "Not code. Free and Growth get email support.",
  },
];

/**
 * "Powered by MaxOff" is deliberately absent.
 *
 * §3.6 lists it as a Free-plan limit, but nothing implements it and the
 * Function cannot: it builds the buyer message from `cap_config`, which
 * carries no plan. Enforcing it needs a flag in `cap_config`, a Function
 * change, and a rewrite of the metafield on every existing discount whenever
 * the merchant changes plan. Decided 10 Sep 2026 to leave it out of the plan
 * ladder entirely rather than advertise a restriction that does not exist —
 * a merchant paying to remove a note that was never there is the worst
 * version of this. See the build log for the four-part scope.
 */

export function isPlanKey(value: string | null | undefined): value is PlanKey {
  return value === "free" || value === "growth" || value === "pro";
}

/** Anything we cannot read with certainty is Free — never a paid plan. */
export function toPlanKey(value: string | null | undefined): PlanKey {
  return isPlanKey(value) ? value : "free";
}

/** How many capped discounts this plan may have active. Null is unlimited. */
export function activeDiscountLimit(plan: string): number | null {
  return PLAN_ACTIVE_DISCOUNT_LIMIT[toPlanKey(plan)];
}

/** Whether the plan is entitled to a capability, built or not. */
export function can(plan: string, key: CapabilityKey): boolean {
  const capability = CAPABILITIES.find((entry) => entry.key === key);
  return capability ? capability.plans.includes(toPlanKey(plan)) : false;
}

/** Entitled *and* usable today — what "Included now" may honestly list. */
export function hasNow(plan: string, key: CapabilityKey): boolean {
  const capability = CAPABILITIES.find((entry) => entry.key === key);
  return Boolean(capability?.built) && can(plan, key);
}

/** Everything this plan has today. */
export function includedNow(plan: PlanKey): Capability[] {
  return CAPABILITIES.filter((entry) => entry.built && entry.plans.includes(plan));
}

/** Entitled but not built yet — listed separately, never as "included". */
export function comingSoon(plan: PlanKey): Capability[] {
  return CAPABILITIES.filter(
    (entry) => !entry.built && entry.plans.includes(plan),
  );
}

/** The plan above this one, or null when there is nothing left to sell. */
export function nextPlan(plan: PlanKey): PlanKey | null {
  const index = PLAN_KEYS.indexOf(plan);
  return index === -1 || index === PLAN_KEYS.length - 1
    ? null
    : PLAN_KEYS[index + 1];
}

/**
 * What moving up adds to what the merchant has now — the upsell card lists
 * this, not the next tier's whole feature list.
 */
export function upgradeAdds(from: PlanKey): Capability[] {
  const to = nextPlan(from);
  if (to === null) {
    return [];
  }

  return CAPABILITIES.filter(
    (entry) => entry.plans.includes(to) && !entry.plans.includes(from),
  );
}
