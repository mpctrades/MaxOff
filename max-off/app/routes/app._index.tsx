import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { dismissSetupGuide, getHomeData } from "../models/home.server";
import type { HomeData, HomeSetupStep, HomeWeek } from "../models/home.server";
import { CAP_ENGINE_DEPLOYED } from "../lib/cap";
import { formatMoney, formatPercent } from "../lib/format";

const PLAN_LABELS: Record<string, string> = {
  free: "Free plan",
  growth: "Growth plan",
  pro: "Pro plan",
};

const STATUS_TONES: Record<string, "success" | "info" | "warning" | "neutral"> =
  {
    active: "success",
    scheduled: "info",
    paused: "warning",
    expired: "neutral",
  };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    return { home: await getHomeData(session.shop), error: null };
  } catch (error) {
    // A read failure is shown as a read failure. Never an invented zero.
    return {
      home: null,
      error:
        error instanceof Error
          ? error.message
          : "MaxOff could not read your data.",
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const form = await request.formData();
  if (form.get("intent") === "dismiss-setup-guide") {
    await dismissSetupGuide(session.shop);
  }

  return { ok: true };
};

export default function HomePage() {
  const { home, error } = useLoaderData<typeof loader>();

  if (home === null) {
    return (
      <s-page heading="MaxOff">
        <s-banner heading="MaxOff could not load your data" tone="critical">
          {error ?? "Something went wrong."} Reload the page to try again.
        </s-banner>
      </s-page>
    );
  }

  const planLabel = PLAN_LABELS[home.plan] ?? "Free plan";
  const isNewInstall = home.totalCount === 0;
  const showSetupGuide =
    !home.setup.dismissed &&
    home.setup.completedCount < home.setup.stepCount;

  return (
    <s-page heading="MaxOff">
      <s-badge slot="accessory">{planLabel}</s-badge>
      <s-button slot="secondary-actions" href="/app/test">
        Test a cart
      </s-button>
      <s-button slot="primary-action" variant="primary" href="/app/discounts/new">
        Create capped discount
      </s-button>

      <s-paragraph color="subdued">
        Percentage discounts that stop at a maximum amount.
      </s-paragraph>

      <CapEngineBanner activeCount={home.activeCount} />

      {showSetupGuide && <SetupGuide home={home} />}

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

function CapEngineBanner({ activeCount }: { activeCount: number }) {
  if (!CAP_ENGINE_DEPLOYED || activeCount === 0) {
    return (
      <s-banner heading="Cap engine is not capping anything yet" tone="warning">
        No capped discount is active, so nothing is being capped at checkout.
        No theme code was added to your store.
        <s-button slot="secondary-actions" href="/app/discounts/new">
          Create capped discount
        </s-button>
      </s-banner>
    );
  }

  return (
    <s-banner heading="Cap engine is running" tone="success">
      Your cap is applied by Shopify at checkout on {activeCount} active{" "}
      {activeCount === 1 ? "discount" : "discounts"}. No theme code was added to
      your store.
      <s-button slot="secondary-actions" href="/app/test">
        Run a test cart
      </s-button>
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
      <s-button variant="primary" href="/app/discounts/new">
        Create capped discount
      </s-button>
    </s-section>
  );
}

function SetupGuide({ home }: { home: HomeData }) {
  const fetcher = useFetcher();
  const { setup } = home;
  const percentComplete = Math.round(
    (setup.completedCount / setup.stepCount) * 100,
  );
  const hiding = fetcher.state !== "idle";

  return (
    <s-section
      heading="Set up MaxOff"
      accessibilityLabel={`Set up MaxOff — ${setup.completedCount} of ${setup.stepCount} steps done`}
    >
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
        <s-stack direction="block" gap="small-200">
          <s-text color="subdued">
            {setup.completedCount} of {setup.stepCount} done
          </s-text>
          <s-box
            background="subdued"
            borderRadius="small"
            blockSize="6px"
            inlineSize="100%"
            overflow="hidden"
            accessibilityLabel={`${percentComplete}% complete`}
          >
            <s-box
              background="strong"
              borderRadius="small"
              blockSize="6px"
              inlineSize={`${percentComplete}%`}
            ></s-box>
          </s-box>
        </s-stack>
        <s-button
          variant="tertiary"
          onClick={() =>
            fetcher.submit({ intent: "dismiss-setup-guide" }, { method: "post" })
          }
          {...(hiding ? { loading: true } : {})}
        >
          Hide
        </s-button>
      </s-grid>

      <s-stack direction="block" gap="base">
        <SetupStep step={setup.install} title="Install MaxOff" />
        <SetupStep
          step={setup.create}
          title="Create your first capped discount"
          action={
            setup.create.done ? null : (
              <s-button href="/app/discounts/new">Create</s-button>
            )
          }
        />
        <SetupStep
          step={setup.test}
          title="Test it on a big cart"
          action={
            setup.test.done ? null : (
              <s-button href="/app/test">Test a cart</s-button>
            )
          }
        />
        <SetupStep
          step={setup.plan}
          title="Choose a plan"
          action={<s-button href="/app/billing">View plans</s-button>}
        />
      </s-stack>
    </s-section>
  );
}

function SetupStep({
  step,
  title,
  action = null,
}: {
  step: HomeSetupStep;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <s-grid gridTemplateColumns="auto 1fr auto" gap="base" alignItems="start">
      {/* A badge, not a coloured tick: the state has to survive being read
          aloud and being seen without colour (§5). */}
      {step.done ? (
        <s-badge tone="success" icon="check-circle">
          Done
        </s-badge>
      ) : (
        <s-badge>To do</s-badge>
      )}
      <s-stack direction="block" gap="small-500">
        <s-text>{title}</s-text>
        {step.result && <s-text color="subdued">{step.result}</s-text>}
      </s-stack>
      {action}
    </s-grid>
  );
}

function StatTiles({ home }: { home: HomeData }) {
  const { currencyCode } = home;
  const delta = home.keptThisMonthMinor - home.keptLastMonthMinor;
  const deltaPercent =
    home.keptLastMonthMinor > 0
      ? Math.round((delta / home.keptLastMonthMinor) * 100)
      : null;

  return (
    <s-section accessibilityLabel="This month at a glance">
      <s-grid
        gridTemplateColumns="@container (inline-size <= 600px) 1fr, 1fr 1fr 1fr 1fr"
        gap="base"
      >
        <s-box background="subdued" padding="base" borderRadius="base">
          <s-stack direction="block" gap="small-300">
            <s-text color="subdued">Over-discounting avoided · this month</s-text>
            {home.hasCapEvents ? (
              <>
                <s-heading>
                  {formatMoney(home.keptThisMonthMinor, currencyCode)}
                </s-heading>
                <s-text color="subdued">
                  {deltaPercent === null
                    ? "No comparison for last month yet"
                    : `${deltaPercent >= 0 ? "▲" : "▼"} ${Math.abs(
                        deltaPercent,
                      )}% vs last month`}
                </s-text>
              </>
            ) : (
              <s-text color="subdued">No capped orders yet</s-text>
            )}
          </s-stack>
        </s-box>

        <s-box padding="base">
          <s-stack direction="block" gap="small-300">
            <s-text color="subdued">Orders capped</s-text>
            {home.hasCapEvents ? (
              <s-heading>{home.ordersCapped}</s-heading>
            ) : (
              <s-text color="subdued">No capped orders yet</s-text>
            )}
          </s-stack>
        </s-box>

        <s-box padding="base">
          <s-stack direction="block" gap="small-300">
            <s-text color="subdued">Active capped discounts</s-text>
            <s-heading>{home.activeCount}</s-heading>
            <s-text color="subdued">
              {home.scheduledCount} scheduled, {home.pausedCount} paused
            </s-text>
          </s-stack>
        </s-box>

        <s-box padding="base">
          <s-stack direction="block" gap="small-300">
            <s-text color="subdued">Biggest single save</s-text>
            {home.biggestSave ? (
              <>
                <s-heading>
                  {formatMoney(home.biggestSave.keptMinor, currencyCode)}
                </s-heading>
                <s-text color="subdued">
                  Order {home.biggestSave.orderName}
                  {home.biggestSave.code ? ` · ${home.biggestSave.code}` : ""}
                </s-text>
              </>
            ) : (
              <s-text color="subdued">No capped orders yet</s-text>
            )}
          </s-stack>
        </s-box>
      </s-grid>
    </s-section>
  );
}

function MoneyKeptCard({ home }: { home: HomeData }) {
  return (
    <s-section accessibilityLabel="Money you kept, last eight weeks">
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
        <s-stack direction="block" gap="small-500">
          <s-heading>Money you kept</s-heading>
          <s-text color="subdued">
            Difference between the uncapped discount and what MaxOff actually
            gave away.
          </s-text>
        </s-stack>
        <s-link href="/app/analytics">View analytics</s-link>
      </s-grid>

      {home.hasCapEvents ? (
        <WeeklyChart weeks={home.weeks} currencyCode={home.currencyCode} />
      ) : (
        <s-paragraph color="subdued">
          No capped orders yet. This chart fills in once an order uses one of
          your capped discounts.
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

  const label = (week: HomeWeek) => {
    const date = new Date(`${week.weekStartISO}T00:00:00Z`);
    return `${date.getUTCDate()}/${date.getUTCMonth() + 1}`;
  };

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
              stroke="#e3e3e3"
              strokeWidth="1"
            />
            <text
              x={PAD_LEFT - 8}
              y={y + 3.5}
              textAnchor="end"
              fontSize="10"
              fill="#616161"
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
              fill="#ea580c"
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
              fill="#616161"
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
                fill="#303030"
              >
                {formatMoney(week.keptMinor, currencyCode)}
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
    <s-section accessibilityLabel="Your capped discounts">
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
        <s-heading>Your capped discounts</s-heading>
        <s-link href="/app/discounts">View all</s-link>
      </s-grid>

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
                  <s-link
                    id={`discount-link-${discount.id}`}
                    href={`/app/discounts/${discount.id}`}
                  >
                    {discount.code ?? "No code"}
                  </s-link>
                </s-table-cell>
                <s-table-cell>
                  {formatPercent(discount.percentage)} off
                </s-table-cell>
                <s-table-cell>
                  {formatMoney(discount.capMinor, currencyCode)}
                </s-table-cell>
                <s-table-cell>
                  {discount.capStartsAboveMinor === null
                    ? "—"
                    : formatMoney(discount.capStartsAboveMinor, currencyCode)}
                </s-table-cell>
                <s-table-cell>{discount.timesUsed}</s-table-cell>
                <s-table-cell>
                  {discount.keptMinor === 0
                    ? "—"
                    : formatMoney(discount.keptMinor, currencyCode)}
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={STATUS_TONES[discount.status] ?? "neutral"}>
                    {discount.status}
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
