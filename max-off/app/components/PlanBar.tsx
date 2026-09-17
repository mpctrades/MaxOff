/**
 * The plan bar at the top of every working screen: Home, Capped discounts,
 * Create new, Test a cart and Settings.
 *
 * Plans & billing already owns the full answer — price, renewal date, the
 * comparison table, the buttons that change anything. This is the one-line
 * version a merchant reads on the way past: which plan, how much of it is in
 * use, and the one action that follows from it.
 *
 * It is not on Plans & billing itself, which has `PlanStrip` — the same facts
 * at length, on the page that exists to state them.
 *
 * Every page that shows it reads the plan once through `readPlanBar`, which
 * also answers whatever gate that page already had.
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

import type { CSSProperties } from "react";
import { Link } from "react-router";

import { nextPlan, PLAN_KEYS, PLAN_LABELS, planChips } from "../lib/plans";
import type { PlanKey } from "../lib/plans";

export interface PlanBarProps {
  /** The plan Shopify confirmed, or null when billing could not be read. */
  plan: PlanKey | null;
  /** Active capped discounts — the same figure the stat tile shows. */
  activeCount: number;
  /** How many the plan allows. Null is unlimited, and null when unknown. */
  activeLimit: number | null;
}

/**
 * What the action says, and whether it is an upgrade.
 *
 * Named from `nextPlan` rather than written out, so "Upgrade to Growth" and
 * "Upgrade to Pro" cannot drift from the ladder and a fourth tier would name
 * itself. The top plan has nothing above it to sell, so it gets the one action
 * that is still true — the billing page, where a plan can be changed or
 * cancelled — and never a button claiming an upgrade that does not exist.
 *
 * An unknown plan gets the same neutral action. Offering "Upgrade to Growth"
 * to a merchant we could not verify would be a guess about what they already
 * pay for, which is the whole thing this bar refuses to do.
 */
function actionFor(plan: PlanKey | null): { label: string; upgrade: boolean } {
  if (plan === null) {
    return { label: "Plans & billing", upgrade: false };
  }

  const next = nextPlan(plan);
  return next === null
    ? { label: "Change plan", upgrade: false }
    : { label: `Upgrade to ${PLAN_LABELS[next]}`, upgrade: true };
}

export function PlanBar({ plan, activeCount, activeLimit }: PlanBarProps) {
  const known = plan !== null;

  // The meter states an allowance, so it needs one. Pro has no ceiling to
  // fill, and an unknown plan has no ceiling we can claim.
  const showMeter = known && activeLimit !== null;

  const chips = known
    ? planChips(plan)
    : ["We couldn't reach Shopify billing just now"];

  const action = actionFor(plan);

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

      {/* One recessed plane holding the ladder and what the plan includes.
          It replaces the pair of hairlines that used to frame this middle
          section: two planes separate "where you are and what you get" from
          the card around it more clearly than two 1px rules did, and it stops
          the row reading as one long undifferentiated strip of pills. */}
      <div className="maxoff-planbar__panel">
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
                /* The width is handed over as a custom property rather than
                   set directly, so the CSS can animate from zero up to it on
                   first paint — a number that counts up reads as a live
                   measurement instead of a static bar. Clamped both ends: a
                   shop that was over its allowance before the limits changed
                   would otherwise draw past the end of its own track. */
                style={
                  {
                    "--maxoff-meter-fill": `${Math.min(100, Math.max(0, (activeCount / activeLimit) * 100))}%`,
                  } as CSSProperties
                }
              />
            </span>
          </div>
        )}

        {/* Always a button, never a bare link. On Pro there is no meter, and
            the right of the card used to end in a stretch of nothing with a
            text link adrift in it.

            One orange fill in every state. Orange is this app's primary-action
            colour rather than its "buy" colour — "Create capped discount"
            wears it and sells nothing — so "Change plan" carrying it does not
            pitch Pro at a merchant already on Pro. The arrow is what stays
            exclusive to an upgrade: it points somewhere further up. */}
        <Link className="maxoff-planbar__action" to="/app/billing">
          {action.label}
          {action.upgrade && <ArrowRight />}
        </Link>
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
