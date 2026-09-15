/**
 * The plan bar at the top of Home, and nowhere else.
 *
 * Plans & billing already owns the full answer — price, renewal date, the
 * comparison table, the buttons that change anything. This is the one-line
 * version a merchant reads on the way past: which plan, how much of it is in
 * use, and the one action that follows from it.
 *
 * ## Four states, and why the fourth exists
 *
 * Free, Growth and Pro are the three a merchant can be on. The fourth is
 * "unknown", and it is the whole reason this component takes `plan: PlanKey |
 * null` rather than a `PlanKey`.
 *
 * `getCurrentPlan` answers every call with a plan, and when the Shopify read
 * fails it falls back to the cached column — which defaults to `"free"`. For a
 * gate that is right: refusing a paid feature to a merchant we cannot verify
 * fails in the safe direction. For a *label* at the top of Home it is the
 * worst possible answer, because it tells a merchant paying 7.99 a month that
 * they are not paying. `getPlanSummary` keeps the distinction and this
 * component renders it: amber accent, "Unknown", no segment lit, and a chip
 * that says plainly what went wrong.
 *
 * Nothing here ever turns a null plan into "free".
 *
 * ## Why this is drawn rather than composed
 *
 * The same wall `BrandButton` and the receipt lines hit: Polaris components
 * set their own fill, type and spacing inside their shadow DOM, and none of
 * this layout — a 4px accent pill bled to the card edge, a segmented track, a
 * 76px meter — is reachable through them. Only the paint is ours; the links
 * are React Router `Link`s so navigation stays inside the embedded frame.
 */

import { Link } from "react-router";

import { PLAN_KEYS, PLAN_LABELS, planChips } from "../lib/plans";
import type { PlanKey } from "../lib/plans";

export interface PlanBarProps {
  /** The plan Shopify confirmed, or null when billing could not be read. */
  plan: PlanKey | null;
  /** Active capped discounts — the same figure the stat tile shows. */
  activeCount: number;
  /** How many the plan allows. Null is unlimited, and null when unknown. */
  activeLimit: number | null;
}

/** What each plan's action offers, and where it goes. */
const UPGRADE_LABEL: Partial<Record<PlanKey, string>> = {
  free: "Upgrade",
  growth: "Upgrade to Pro",
};

export function PlanBar({ plan, activeCount, activeLimit }: PlanBarProps) {
  const known = plan !== null;

  // The meter states an allowance, so it needs one. Pro has no ceiling to
  // fill, and an unknown plan has no ceiling we can claim.
  const showMeter = known && activeLimit !== null;

  const chips = known
    ? planChips(plan)
    : ["We couldn't reach Shopify billing just now"];

  const upgrade = known ? UPGRADE_LABEL[plan] : undefined;

  return (
    <div
      className={`maxoff-planbar${known ? "" : " maxoff-planbar--unknown"}`}
    >
      <span className="maxoff-planbar__accent" aria-hidden="true" />

      <div className="maxoff-planbar__identity">
        {/* Written sentence case and uppercased in CSS: a screen reader should
            not spell out "Y-O-U-R", and every label in this app is written in
            sentence case at source. */}
        <span className="maxoff-planbar__kicker">Your plan</span>
        <span className="maxoff-planbar__name">
          {known ? PLAN_LABELS[plan] : "Unknown"}
        </span>
      </div>

      <span className="maxoff-planbar__rule" aria-hidden="true" />

      {/* Display only — not a control, and deliberately not clickable: the
          place to change a plan is Plans & billing, where the prices and the
          comparison are. Hidden from assistive technology because the plan
          name beside it already says which one is lit, and a screen reader
          reading "Free Growth Pro" adds nothing but confusion. */}
      <div className="maxoff-planbar__track" aria-hidden="true">
        {PLAN_KEYS.map((key) => (
          <span
            key={key}
            className={`maxoff-planbar__segment${
              key === plan ? " maxoff-planbar__segment--on" : ""
            }`}
          >
            {PLAN_LABELS[key]}
          </span>
        ))}
      </div>

      <div className="maxoff-planbar__chips">
        {chips.map((chip) => (
          <span key={chip} className="maxoff-planbar__chip">
            {chip}
          </span>
        ))}
      </div>

      <div className="maxoff-planbar__right">
        {showMeter && (
          <div className="maxoff-planbar__meter">
            <span className="maxoff-planbar__meter-label">
              {activeCount} of {activeLimit} discounts
            </span>
            <span className="maxoff-planbar__meter-track">
              <span
                className="maxoff-planbar__meter-fill"
                /* Clamped both ends: a shop that was over its allowance before
                   the limits changed would otherwise draw a bar past the end
                   of its own track. */
                style={{
                  inlineSize: `${Math.min(100, Math.max(0, (activeCount / activeLimit) * 100))}%`,
                }}
              />
            </span>
          </div>
        )}

        {upgrade ? (
          <Link className="maxoff-planbar__action" to="/app/billing">
            {upgrade}
            <ArrowRight />
          </Link>
        ) : (
          <Link className="maxoff-planbar__link" to="/app/billing">
            Plans &amp; billing
          </Link>
        )}
      </div>
    </div>
  );
}

/** 12px, inline, and `currentColor` so it follows the label it sits beside. */
function ArrowRight() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.5 6h7M6.5 3l3 3-3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
