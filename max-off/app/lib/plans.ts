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
  pro: 799,
};

/**
 * How many capped discounts may be active at once. Null means unlimited.
 *
 * Was 1/unlimited/unlimited until 11 Sep 2026: one active discount was too
 * thin to judge the app by, and an unlimited Growth left Pro with nothing to
 * sell but the scopes. Set to 3/20/unlimited by Arthur the same day — tighter
 * than the 5/40 the website advertises, which is a copy change owed to the
 * site, not a second definition here.
 */
export const PLAN_ACTIVE_DISCOUNT_LIMIT: Record<PlanKey, number | null> = {
  free: 3,
  growth: 20,
  pro: null,
};

/**
 * How long a single capped discount may run, in days. Null means no limit.
 *
 * Free is a trial in disguise: five discounts, each for a fortnight. A
 * merchant can run a real campaign and see the money kept, but a permanent
 * always-on code is what the paid plans are for.
 *
 * This is the only source of the number. The card copy and the form's
 * validation both read it, and `longCampaigns` below is the same fact written
 * as an entitlement — a test ties the two together so they cannot drift.
 */
export const PLAN_MAX_CAMPAIGN_DAYS: Record<PlanKey, number | null> = {
  free: 15,
  growth: null,
  pro: null,
};

/**
 * One line per plan, for the top of its column. Here for the same reason the
 * labels are: plan copy written in a component is plan copy that drifts from
 * what the plan actually gives.
 */
export const PLAN_TAGLINES: Record<PlanKey, string> = {
  free: "Three discounts, each running up to 15 days.",
  growth: "For stores running more than one campaign at a time.",
  pro: "Caps per item, per collection and per campaign.",
};

export type CapabilityKey =
  | "orderMaximum"
  | "previewAndTester"
  | "activeDates"
  | "usageLimits"
  | "longCampaigns"
  | "minimumRequirements"
  | "customCheckoutWording"
  | "itemMaximums"
  | "collectionMaximums"
  | "perMarketCurrency"
  | "csvExport"
  | "prioritySupport";

export interface Capability {
  key: CapabilityKey;
  label: string;
  /** Which plans include it. */
  plans: readonly PlanKey[];
  /** Whether it exists in the product today. */
  built: boolean;
  /**
   * Which plan cards list this line — not whether it is entitled, which is
   * `plans` above.
   *
   * A card read at a glance is a highlight reel, not an inventory, and the
   * same capability can be worth naming on one card and noise on another: a
   * line every plan shares is a selling point on the cheapest card and a
   * repetition on the rest. Everything stays in the matrix and keeps gating
   * whatever it gates; only the cards are edited.
   *
   * Must be a subset of `plans` — a card cannot tick what the plan does not
   * have, and a test says so.
   */
  onCard: readonly PlanKey[];
  /**
   * The wording a card uses, when it differs from `label`.
   *
   * Two entitlements a merchant thinks of as one thing — export and history —
   * read as two grudging half-features when listed separately. They stay two
   * entries because they are two gates; the card says them in one breath.
   */
  cardLabel?: string;
  /** Why it is not built yet — shown to nobody, read by the next developer. */
  note?: string;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    key: "orderMaximum",
    label: "A maximum on the whole order",
    plans: ["free", "growth", "pro"],
    built: true,
    onCard: ["free", "growth"],
  },
  {
    key: "previewAndTester",
    label: "Live preview and cart tester",
    plans: ["free", "growth", "pro"],
    built: true,
    onCard: ["free", "growth"],
  },
  {
    // §0c, decided 10 Sep 2026: dates were sold as Growth but shipped to
    // everyone ungated. They stay in Free — already built, cheap to give, and
    // taking a working feature off Free merchants later is worse than never
    // having offered it. What Free does not get is an *unbounded* run: see
    // PLAN_MAX_CAMPAIGN_DAYS and `longCampaigns`.
    key: "activeDates",
    label: "Start and end dates",
    plans: ["free", "growth", "pro"],
    built: true,
    onCard: ["free"],
  },
  {
    // Built and ungated until 11 Sep 2026, when the published pricing put it
    // in Growth. Unlike dates, this one is a campaign control rather than
    // something a merchant needs to run a capped discount at all, so gating it
    // costs a Free merchant nothing they cannot do by pausing the code.
    key: "usageLimits",
    label: "A limit on the total number of uses",
    plans: ["growth", "pro"],
    built: true,
    onCard: ["growth"],
  },
  {
    // The other half of PLAN_MAX_CAMPAIGN_DAYS, written as an entitlement so
    // the Growth card can say what moving up buys. The number lives there; a
    // test asserts the two agree.
    key: "longCampaigns",
    label: "Discounts that run for as long as you like",
    plans: ["growth", "pro"],
    built: true,
    onCard: ["growth"],
  },
  {
    // Built 15 Sep 2026. A standard discount control rather than something to
    // sell: the published pricing does not mention it, and the mockup showed
    // it with no plan badge, so it stays on every plan. The Function reads
    // `minSubtotal` and `minQuantity` and applies nothing at all below them.
    key: "minimumRequirements",
    label: "Minimum subtotal or quantity",
    plans: ["free", "growth", "pro"],
    built: true,
    onCard: [],
  },
  {
    // Built 14 Sep 2026. The Function reads `checkoutNote` from cap_config and
    // puts it after the rule on the buyer's discount line, but only when the
    // maximum is what decided the amount — below the cap the note would not be
    // true. The entitlement stays Growth, which is what the published pricing
    // says; moving it to Free is a one-line change here and nowhere else.
    key: "customCheckoutWording",
    label: "Custom checkout wording",
    plans: ["growth", "pro"],
    built: true,
    onCard: ["growth"],
  },
  {
    // Built 15 Sep 2026, with `collectionMaximums` below. `cap_config` version 3
    // carries a `scope`, and the Function emits one PRODUCT-class candidate per
    // eligible line instead of the single ORDER-class candidate the `order`
    // scope uses. See `cart_lines_discounts_generate_run.ts`.
    key: "itemMaximums",
    label: "A separate maximum on each item",
    plans: ["pro"],
    built: true,
    onCard: ["pro"],
  },
  {
    // Same change as `itemMaximums`. The grouping needs `inCollections`, which
    // answers *which* of the targeted collections a product is in — the one
    // question `inAnyCollection` cannot. A product in two of them counts
    // against the first the merchant picked, so no line is discounted twice.
    key: "collectionMaximums",
    label: "A separate maximum per collection",
    plans: ["pro"],
    built: true,
    onCard: ["pro"],
  },
  {
    // Built 15 Sep 2026. Rule 5 is intact and is in fact why this shape was
    // chosen: the merchant types the number for each currency and nothing is
    // converted. `cap_config` carries `capsByCurrency`, and the Function picks
    // by the cart's own currency, falling back to the base maximum relabelled.
    key: "perMarketCurrency",
    label: "A different maximum per market currency",
    plans: ["pro"],
    built: true,
    onCard: ["pro"],
  },
  {
    // Built 15 Sep 2026, from our own mirror rather than a Shopify query, so
    // it needs no scope. The 12-month range below is a different matter: it
    // needs order history, which needs read_orders.
    key: "csvExport",
    label: "CSV export",
    plans: ["pro"],
    built: true,
    onCard: ["pro"],
  },
  {
    // Not code, and so nothing has to ship for it to be true: Free and Growth
    // get email support, Pro gets answered first. `built` is about whether the
    // merchant has the thing today, and on Pro they do.
    key: "prioritySupport",
    label: "Priority support",
    plans: ["pro"],
    built: true,
    onCard: ["pro"],
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

/** How many days one discount may run on this plan. Null is no limit. */
export function maxCampaignDays(plan: string): number | null {
  return PLAN_MAX_CAMPAIGN_DAYS[toPlanKey(plan)];
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

/** One control's answer to "can I use this, and what should sit beside it?" */
export interface CapabilityGate {
  /** Whether the plan is entitled to it. */
  allowed: boolean;
  /** Whether it exists in the product today. */
  built: boolean;
  /** Whether the control should work: both of the above. */
  usable: boolean;
  /**
   * The badge beside the control, or null when there is nothing to say.
   *
   * A plan name means "this is not on your plan". "Coming soon" means the
   * merchant already pays for it and we have not built it yet. The difference
   * matters: a Pro merchant shown a "Pro" badge is being sold something they
   * have already bought, which reads as the app not knowing who they are.
   */
  badge: string | null;
}

/**
 * Everything a gated control needs, from the one matrix.
 *
 * Every `disabled` and every badge in the admin comes from here rather than
 * from a literal in a component. A control that decides for itself is a second
 * definition of the plan ladder, and the one that goes stale first — which is
 * exactly how the create form spent four days showing Pro merchants a Pro
 * badge on maximums they were entitled to.
 *
 * An unknown key is refused rather than allowed: a typo in a capability name
 * should close a control, never open one.
 */
export function gateFor(plan: string, key: CapabilityKey): CapabilityGate {
  const capability = CAPABILITIES.find((entry) => entry.key === key);
  if (capability === undefined) {
    return {allowed: false, built: false, usable: false, badge: null};
  }

  const allowed = capability.plans.includes(toPlanKey(plan));
  const built = capability.built;

  return {
    allowed,
    built,
    usable: allowed && built,
    badge: allowed
      ? built
        ? null
        : "Coming soon"
      : PLAN_LABELS[cheapestPlanWith(capability)],
  };
}

/**
 * The least expensive plan that includes a capability — what an upgrade badge
 * should name. Read from `PLAN_KEYS`, which is ordered cheapest first, so
 * adding a tier never leaves a badge naming the wrong one.
 */
function cheapestPlanWith(capability: Capability): PlanKey {
  return PLAN_KEYS.find((key) => capability.plans.includes(key)) ?? "pro";
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

/** One line on a plan card. Every line is something the plan has. */
export interface PlanFeature {
  /** Bold text before the label, for the one line that carries emphasis. */
  lead?: string;
  label: string;
  /** Whether it exists today. */
  built: boolean;
}

/**
 * What a plan card lists.
 *
 * A card names what the plan **gives**: its allowance, then every capability
 * whose `onCard` includes it. Nothing else. There is no line for what the
 * merchant does not have.
 *
 * Rewritten 11 Sep 2026, in two passes with Arthur. The cards used to spell
 * out the tier above as a column of dashes, which turned the cheapest card
 * into a list of refusals — five of them under four features — and left even
 * Growth ending on what it lacked. The entitlements did not move; only the
 * pitch did.
 *
 * The top plan rolls the tier below into "Everything in Growth" rather than
 * repeating ticks it shares, but still states its own allowance: "Everything
 * in Growth" carries Growth's limit with it, and unlimited is what Pro adds —
 * which is why the allowance comes back on its own rather than as
 * `features[0]`. It leads every card, above the roll-up line, and a card that
 * has to know the headline number is the first element is one edit away from
 * printing it in the middle of the list.
 */
export function planCard(plan: PlanKey): {
  allowance: PlanFeature;
  rollupFrom: PlanKey | null;
  features: PlanFeature[];
} {
  const top = PLAN_KEYS[PLAN_KEYS.length - 1];
  const below = PLAN_KEYS[PLAN_KEYS.indexOf(plan) - 1] ?? null;

  const limit = PLAN_ACTIVE_DISCOUNT_LIMIT[plan];
  const allowance: PlanFeature =
    limit === null
      ? { lead: "Unlimited", label: "capped discounts", built: true }
      : {
          label: `${limit} capped discount${limit === 1 ? "" : "s"}`,
          built: true,
        };

  // A plan with a run-length ceiling says so on the dates line rather than in
  // a separate one. Two lines about dates read as two features; the merchant
  // is choosing between "dates" and "dates, but bounded".
  const days = PLAN_MAX_CAMPAIGN_DAYS[plan];
  const mine: PlanFeature[] = CAPABILITIES.filter((entry) =>
    entry.onCard.includes(plan),
  ).map((entry) => {
    const label = entry.cardLabel ?? entry.label;

    return {
      label:
        entry.key === "activeDates" && days !== null
          ? `${label}, up to ${days} days per discount`
          : label,
      built: entry.built,
    };
  });

  return {
    allowance,
    rollupFrom: plan === top ? below : null,
    features: mine,
  };
}
