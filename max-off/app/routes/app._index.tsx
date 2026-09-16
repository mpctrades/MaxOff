import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { displayStatusLabel } from "../lib/cap";
import { getHomeData } from "../models/home.server";
import type { HomeData, HomeWeek } from "../models/home.server";
import { getPlanSummary } from "../models/plan.server";
import { activeDiscountLimit, isPlanKey } from "../lib/plans";
import { evaluatePlanGrace } from "../models/plan-grace.server";
import type { PlanKey } from "../lib/plans";
import { BrandButton } from "../components/BrandButton";
import { PlanBar } from "../components/PlanBar";
import {
  InternalButtonLink,
  InternalLink,
} from "../components/InternalNavigation";
import {
  formatAmount,
  formatAmountPlain,
  formatMoney,
  formatDate,
  formatMonthDay,
  formatPercent,
} from "../lib/format";

const STATUS_TONES: Record<string, "success" | "info" | "warning" | "neutral"> =
  {
    active: "success",
    scheduled: "info",
    paused: "warning",
    expired: "neutral",
  };

/**
 * Force a plan-bar state while developing: `/app?planBar=free|growth|pro|unknown`.
 *
 * The plan comes from Shopify, so there is otherwise no way to see three of
 * the four states on a dev store with no paid subscription — and the fourth,
 * the one that matters most, only appears when Shopify is unreachable.
 *
 * Refused outright in production. Not because reading a query parameter is
 * dangerous in itself — this changes a label and a meter, never an
 * entitlement, and every real gate re-reads the plan server-side — but because
 * a URL that makes the billing bar say "Pro" is a support ticket waiting to
 * happen, and a screenshot of one is worse.
 */
function forcedPlanBar(request: Request): PlanKey | "unknown" | null {
  if (process.env.NODE_ENV === "production") {
    return null;
  }

  const value = new URL(request.url).searchParams.get("planBar");
  if (value === "unknown") {
    return "unknown";
  }

  return isPlanKey(value) ? value : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    // One billing read, from the same helper Plans & billing and the create
    // form use. `getPlanSummary` is the wrapper that keeps "we could not tell"
    // apart from "Free" — see the note on it in `plan.server.ts`.
    const [home, planSummary] = await Promise.all([
      getHomeData(session.shop),
      getPlanSummary({ shop: session.shop, admin }),
    ]);

    const forced = forcedPlanBar(request);
    const plan =
      forced === null ? planSummary.plan : forced === "unknown" ? null : forced;

    // The over-limit grace period, evaluated against the plan we just read
    // live — never a forced or cached one, because this branch can pause a
    // merchant's discounts. `planSummary.activeLimit` is null both for Pro and
    // for a read that failed, and `evaluatePlanGrace` treats both as "do
    // nothing", which is the safe reading of each.
    const grace = await evaluatePlanGrace({
      shop: session.shop,
      limit: planSummary.activeLimit,
      admin,
      now: new Date(),
    });

    return {
      home,
      planBar: {
        plan,
        // Derived from the plan actually being shown, so a forced state gets
        // the meter that belongs to it rather than the live plan's.
        activeLimit: plan === null ? null : activeDiscountLimit(plan),
      },
      grace: {
        status: grace.status,
        overBy: grace.overBy,
        limit: grace.limit,
        deadline: grace.deadline ? grace.deadline.toISOString() : null,
        pausedCodes: grace.pausedCodes,
      },
      error: null,
    };
  } catch (error) {
    // A read failure is shown as a read failure. Never an invented zero.
    return {
      home: null,
      planBar: null,
      grace: null,
      error:
        error instanceof Error
          ? error.message
          : "MaxOff could not read your data.",
    };
  }
};

export default function HomePage() {
  const { home, planBar, grace, error } = useLoaderData<typeof loader>();

  if (home === null) {
    return (
      <s-page heading="MaxOff">
        <s-banner heading="MaxOff could not load your data" tone="critical">
          {error ?? "Something went wrong."} Reload the page to try again.
        </s-banner>
      </s-page>
    );
  }

  const isNewInstall = home.totalCount === 0;

  return (
    <s-page heading="MaxOff">
      <InternalButtonLink slot="secondary-actions" href="/app/test">
        Test a cart
      </InternalButtonLink>
      <InternalButtonLink
        slot="primary-action"
        variant="primary"
        href="/app/discounts/new"
      >
        Create capped discount
      </InternalButtonLink>

      {grace && <OverLimitBanner grace={grace} />}

      {/* Directly under the title and above the bento row. Home only: Plans &
          billing answers this at length, and every other screen has its own
          job. Shown on a new install too — a merchant deciding whether to pay
          should be able to see what they are on before they have a discount. */}
      {planBar && (
        <PlanBar
          plan={planBar.plan}
          activeCount={home.activeCount}
          activeLimit={planBar.activeLimit}
        />
      )}

      {isNewInstall ? (
        <NewInstallCard />
      ) : (
        <>
          <StatTiles home={home} />
          <MoneyKeptCard home={home} />
          <DiscountsCard home={home} />
        </>
      )}
    </s-page>
  );
}

/**
 * The over-limit grace notice, per `app/lib/plan-grace.ts`.
 *
 * Two things a merchant can be told here, and they are different sentences:
 * one warns about a deadline that has not arrived, the other reports discounts
 * MaxOff has already paused. Neither is written as an alarm — the discounts
 * are still capping carts correctly, and the only thing wrong is the count.
 *
 * "Move up a plan" is offered second, after "pause one". The merchant's own
 * choice of which campaign to keep is the better answer, and leading with the
 * upsell would make a limit read as a sales tactic.
 */
function OverLimitBanner({
  grace,
}: {
  grace: {
    status: string;
    overBy: number;
    limit: number | null;
    deadline: string | null;
    pausedCodes: string[];
  };
}) {
  if (grace.status === "ok" || grace.limit === null) {
    return null;
  }

  // Already enforced on this load. Say what was done and name the discounts,
  // so the merchant can go and un-pause the one we chose wrongly.
  if (grace.status === "expired") {
    if (grace.pausedCodes.length === 0) {
      return null;
    }

    return (
      <s-banner heading="MaxOff paused a discount to fit your plan" tone="warning">
        <s-paragraph>
          Your plan allows {grace.limit} active capped discount
          {grace.limit === 1 ? "" : "s"}. MaxOff paused{" "}
          {grace.pausedCodes.join(", ")}. Pause a different one and activate
          this again, or move up a plan to run them all.
        </s-paragraph>
        <InternalLink href="/app/billing">See plans</InternalLink>
      </s-banner>
    );
  }

  const deadline = grace.deadline ? new Date(grace.deadline) : null;

  return (
    <s-banner heading="You have more active discounts than your plan allows" tone="warning">
      <s-paragraph>
        Your plan allows {grace.limit} active capped discount
        {grace.limit === 1 ? "" : "s"} and {grace.overBy} more{" "}
        {grace.overBy === 1 ? "is" : "are"} running. They are all still capping
        carts normally.
        {deadline
          ? ` Pause ${grace.overBy === 1 ? "one" : String(grace.overBy)} before ${formatDate(deadline)}, or MaxOff will pause the newest for you.`
          : ""}
      </s-paragraph>
      <InternalLink href="/app/discounts">Choose which to pause</InternalLink>
    </s-banner>
  );
}

function NewInstallCard() {
  return (
    <s-section heading="Put a maximum on a percentage discount">
      <s-paragraph>
        Shopify can take 15% off an order. It cannot stop at 150.00. MaxOff can:
        it gives the full percentage on small carts, and stops at your maximum
        on large ones.
      </s-paragraph>
      <s-paragraph color="subdued">
        MaxOff adds nothing to your theme.
      </s-paragraph>
      <BrandButton href="/app/discounts/new">
        Create capped discount
      </BrandButton>
    </s-section>
  );
}

/**
 * The four figures at the top of Home, per §4.1.
 *
 * Four cards, not Polaris' metrics card: the approved UX gives the first one
 * the brand tint, because "money you kept" is the number the product exists to
 * produce. The tint never carries the meaning on its own — the label says what
 * the figure is, and the same total is drawn again in the chart below.
 *
 * Every tile has something honest to say before a single order has been
 * capped — an em dash and a reason, never a zero that reads as a loss.
 *
 * The reason is deliberately not "no capped orders yet". Nothing writes a
 * `CapEvent`: the orders/paid handler exists but is inert until `read_orders`
 * is approved (see `app/routes/webhooks.orders.paid.tsx`). "Not yet" would
 * tell a merchant the figure is on its way, and it is not. So these tiles say
 * the tracking is off rather than implying it is running and merely waiting —
 * App Store requirement 1.1.4 is that an app only claims what it does.
 */
function StatTiles({ home }: { home: HomeData }) {
  const { currencyCode } = home;
  const delta = home.keptThisMonthMinor - home.keptLastMonthMinor;
  const deltaPercent =
    home.keptLastMonthMinor > 0
      ? Math.round((delta / home.keptLastMonthMinor) * 100)
      : null;

  return (
    /* `s-page` puts no gap around a bare grid the way it does around a
       section, so the row would sit hard against the subtitle above it and the
       chart card below. The grid has no surface of its own, so padding here
       reads as the margin that is missing. */
    <s-grid
      gridTemplateColumns="@container (inline-size <= 720px) 1fr 1fr, 1fr 1fr 1fr 1fr"
      gap="base"
      paddingBlock="base"
    >
      <div className="maxoff-tile maxoff-tile--hero">
        <span className="maxoff-tile__label">
          Over-discounting avoided · this month
        </span>
        {home.hasCapEvents ? (
          <>
            <span className="maxoff-tile__value">
              {formatAmount(home.keptThisMonthMinor)}{" "}
              <small className="maxoff-tile__currency">{currencyCode}</small>
            </span>
            <span className="maxoff-tile__note">
              {deltaPercent === null ? (
                "No comparison for last month yet"
              ) : (
                <>
                  <span
                    className={
                      deltaPercent >= 0 ? "maxoff-tile__delta" : undefined
                    }
                  >
                    {deltaPercent >= 0 ? "▲" : "▼"} {Math.abs(deltaPercent)}%
                  </span>{" "}
                  vs last month
                </>
              )}
            </span>
          </>
        ) : (
          <span className="maxoff-tile__note">
            Per-order tracking is not switched on yet
          </span>
        )}
      </div>

      <div className="maxoff-tile">
        <span className="maxoff-tile__label">Orders capped</span>
        {home.hasCapEvents ? (
          <>
            <span className="maxoff-tile__value">{home.ordersCapped}</span>
            <span className="maxoff-tile__note">
              of {home.discountedOrders}{" "}
              {home.discountedOrders === 1
                ? "discounted order"
                : "discounted orders"}
            </span>
          </>
        ) : (
          <span className="maxoff-tile__note">
            Per-order tracking is not switched on yet
          </span>
        )}
      </div>

      <div className="maxoff-tile">
        <span className="maxoff-tile__label">Active capped discounts</span>
        <span className="maxoff-tile__value">{home.activeCount}</span>
        <span className="maxoff-tile__note">
          {home.scheduledCount} scheduled, {home.pausedCount} paused
        </span>
      </div>

      <div className="maxoff-tile">
        <span className="maxoff-tile__label">Biggest single save</span>
        {home.biggestSave ? (
          <>
            <span className="maxoff-tile__value">
              {formatAmount(home.biggestSave.keptMinor)}{" "}
              <small className="maxoff-tile__currency">{currencyCode}</small>
            </span>
            <span className="maxoff-tile__note">
              Order {home.biggestSave.orderName}
              {home.biggestSave.code ? ` · ${home.biggestSave.code}` : ""}
            </span>
          </>
        ) : (
          <span className="maxoff-tile__note">
            Per-order tracking is not switched on yet
          </span>
        )}
      </div>
    </s-grid>
  );
}

function MoneyKeptCard({ home }: { home: HomeData }) {
  return (
    /* `s-section` grows a `subheading` prop in Polaris 1.1; the version
       installed here has only `heading`, so the line under it is a subdued
       paragraph of our own. */
    <s-section
      heading="Money you kept"
      accessibilityLabel="Money you kept, last eight weeks"
    >
      <s-text color="subdued">
        Difference between the uncapped discount and what MaxOff actually gave
        away.
      </s-text>

      {home.hasCapEvents ? (
        <WeeklyChart weeks={home.weeks} currencyCode={home.currencyCode} />
      ) : (
        <s-paragraph color="subdued">
          MaxOff does not read your orders yet, so it cannot show what your
          maximums saved you. Your discounts are capping normally — this is the
          reporting, not the cap.
        </s-paragraph>
      )}
    </s-section>
  );
}

/**
 * Eight bars, two gridlines, the tallest labelled, the rest at 55% opacity —
 * §5, drawn as inline SVG rather than by adding a charting library.
 *
 * This is our own drawing, so it is the one place brand colour appears on this
 * screen (§5 lists chart bars under `--orange-bright`). The `<title>` in each
 * bar is the hover tooltip and is read by assistive technology; the whole
 * figure also carries a text alternative in `aria-label`.
 */
function WeeklyChart({
  weeks,
  currencyCode,
}: {
  weeks: HomeWeek[];
  currencyCode: string;
}) {
  const WIDTH = 700;
  const HEIGHT = 180;
  const PAD_LEFT = 52;
  const PAD_RIGHT = 12;
  const PAD_TOP = 16;
  const PAD_BOTTOM = 26;

  const maxKept = Math.max(...weeks.map((week) => week.keptMinor));
  // Round the axis up to a whole unit so the gridline labels are readable.
  const axisMax = Math.max(Math.ceil(maxKept / 10000) * 10000, 10000);
  const innerWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const band = innerWidth / weeks.length;
  const barWidth = Math.min(band - 10, 46);

  const label = (week: HomeWeek) =>
    formatMonthDay(new Date(`${week.weekStartISO}T00:00:00Z`));

  const textAlternative = weeks
    .map((week) => `${label(week)}: ${formatMoney(week.keptMinor, currencyCode)}`)
    .join(", ");

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width="100%"
      height={HEIGHT}
      role="img"
      aria-label={`Money you kept per week, last ${weeks.length} weeks. ${textAlternative}.`}
      style={{ display: "block", maxWidth: "100%" }}
    >
      {[0, axisMax / 2, axisMax].map((value) => {
        const y = PAD_TOP + innerHeight - (value / axisMax) * innerHeight;
        return (
          <g key={value}>
            <line
              x1={PAD_LEFT}
              y1={y}
              x2={WIDTH - PAD_RIGHT}
              y2={y}
              stroke="var(--maxoff-chart-grid)"
              strokeWidth="1"
            />
            <text
              x={PAD_LEFT - 8}
              y={y + 3.5}
              textAnchor="end"
              fontSize="10"
              fill="var(--maxoff-chart-label)"
            >
              {Math.round(value / 100)}
            </text>
          </g>
        );
      })}

      {weeks.map((week, index) => {
        const barHeight = (week.keptMinor / axisMax) * innerHeight;
        const x = PAD_LEFT + band * index + (band - barWidth) / 2;
        const y = PAD_TOP + innerHeight - barHeight;
        const isTallest = week.keptMinor === maxKept && maxKept > 0;

        return (
          <g key={week.weekStartISO}>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={Math.max(barHeight, 2)}
              rx="4"
              fill="var(--maxoff-orange-500)"
              opacity={isTallest ? 1 : 0.55}
            >
              <title>
                {`Week of ${label(week)} · ${formatMoney(
                  week.keptMinor,
                  currencyCode,
                )} kept`}
              </title>
            </rect>
            <text
              x={x + barWidth / 2}
              y={HEIGHT - 8}
              textAnchor="middle"
              fontSize="10"
              fill="var(--maxoff-chart-label)"
            >
              {label(week)}
            </text>
            {isTallest && (
              <text
                x={x + barWidth / 2}
                y={y - 5}
                textAnchor="middle"
                fontSize="10"
                fontWeight="600"
                fill="var(--maxoff-chart-value)"
              >
                {`${formatAmountPlain(week.keptMinor)} ${currencyCode}`}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function DiscountsCard({ home }: { home: HomeData }) {
  const { currencyCode } = home;

  return (
    <s-section heading="Your capped discounts">
      <InternalButtonLink slot="secondary-actions" href="/app/discounts">
        View all
      </InternalButtonLink>

      {home.discounts.length === 0 ? (
        <s-paragraph color="subdued">
          No active capped discounts. Any scheduled or paused discounts are
          under View all.
        </s-paragraph>
      ) : (
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Code</s-table-header>
            <s-table-header>Discount</s-table-header>
            <s-table-header format="currency">Maximum</s-table-header>
            <s-table-header format="currency">Cap starts above</s-table-header>
            <s-table-header format="numeric">Used</s-table-header>
            <s-table-header format="currency" listSlot="labeled">
              Kept
            </s-table-header>
            <s-table-header listSlot="secondary">Status</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {home.discounts.map((discount) => (
              <s-table-row
                key={discount.id}
                clickDelegate={`discount-link-${discount.id}`}
              >
                <s-table-cell>
                  <InternalLink
                    id={`discount-link-${discount.id}`}
                    href={`/app/discounts/${discount.id}`}
                  >
                    {discount.code ?? "No code"}
                  </InternalLink>
                </s-table-cell>
                <s-table-cell>
                  {formatPercent(discount.percentage)} off
                </s-table-cell>
                <s-table-cell>
                  {formatMoney(discount.capMinor, currencyCode)}
                </s-table-cell>
                <s-table-cell>
                  {/* "Cap starts above" is context for the maximum beside it,
                      not a figure of its own — subdued, as in §4.1. */}
                  <s-text color="subdued">
                    {discount.capStartsAboveMinor === null
                      ? "—"
                      : formatMoney(discount.capStartsAboveMinor, currencyCode)}
                  </s-text>
                </s-table-cell>
                <s-table-cell>{discount.timesUsed}</s-table-cell>
                <s-table-cell>
                  {discount.keptMinor === 0 ? (
                    "—"
                  ) : (
                    <span className="maxoff-kept maxoff-tabular">
                      {formatMoney(discount.keptMinor, currencyCode)}
                    </span>
                  )}
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={STATUS_TONES[discount.status] ?? "neutral"}>
                    {displayStatusLabel(discount.status)}
                  </s-badge>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
