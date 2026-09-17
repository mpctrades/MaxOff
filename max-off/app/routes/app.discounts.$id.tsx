import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useEffect } from "react";
import { isRouteErrorResponse, useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { readDiscountDetail, setDiscountPaused } from "../models/discounts.server";
import { ensureShopSettings } from "../models/settings.server";
import { getPlanSummary } from "../models/plan.server";
import {
  InternalButtonLink,
  InternalLink,
} from "../components/InternalNavigation";
import {
  capStartsAboveMinor,
  displayStatus,
  displayStatusLabel,
} from "../lib/cap";
import type { DisplayStatus } from "../lib/cap";
import { capAmountToMinor, parseCapConfig } from "../lib/cap-config";
import type { CapConfigProblem } from "../lib/cap-config";
import { formatDate, formatMoney, formatPercent } from "../lib/format";
import { maxCampaignDays, PLAN_LABELS } from "../lib/plans";
import { toTimeZone } from "../lib/timezone";

const STATUS_TONES: Record<DisplayStatus, "success" | "info" | "warning" | "neutral"> =
  {
    active: "success",
    scheduled: "info",
    paused: "warning",
    expired: "neutral",
    cancelled: "neutral",
  };

/** No data, rather than nothing. §6: an em dash, never a zero. */
const NO_DATA = "—";

/**
 * One capped discount.
 *
 * The cap on this screen is read from the discount's own `cap_config`
 * metafield, which is the only copy the Function reads and therefore the only
 * copy that is *in force* (§3.1). Our Prisma row supplies the things Shopify
 * does not hold — which shop owns it, our own id, the merchant's pause intent —
 * and nothing else. When the metafield cannot be read the screen says so and
 * shows no numbers at all: a maximum that came from the mirror could differ
 * from the one a buyer is about to get, and a confidently wrong figure is
 * worse here than an honest blank.
 *
 * Editing is not offered. Changing a live discount's percentage or maximum
 * changes what every cart already in flight will be charged, and MaxOff has no
 * answer yet for what that should do to a buyer part-way through checkout.
 * Duplicate is the safe shape of the same intent, and it is offered.
 */
export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const found = await readDiscountDetail({
    shop: session.shop,
    id: params.id ?? "",
    admin,
  });

  if (found === null) {
    throw new Response("Not found", { status: 404 });
  }

  const { row, live } = found;

  const settings = await ensureShopSettings(session.shop);
  const timeZone = toTimeZone(settings.timezone);

  // What the screen can say without the metafield: which discount this is, and
  // how to get back. Everything else waits on a config we can actually read.
  const identity = {
    id: row.id,
    name: row.code ?? row.title ?? live?.title ?? "Capped discount",
    method: row.method === "automatic" ? "Automatic" : "Discount code",
    status: displayStatus(row, new Date()),
    timeZone,
  };

  if (found.unreachable) {
    return { ok: false as const, problem: "unreachable" as const, version: null, ...identity };
  }

  const read = parseCapConfig(found.config);

  if (!read.ok) {
    return {
      ok: false as const,
      problem: read.problem satisfies CapConfigProblem,
      version: read.version,
      ...identity,
    };
  }

  const { config } = read;

  // Non-null: `parseCapConfig` refuses a config whose capAmount will not parse.
  const capMinor = capAmountToMinor(config.capAmount) as number;

  const plan = await getPlanSummary({ shop: session.shop, admin });

  // Shopify's dates are the live ones. The mirror's are what we last wrote, and
  // after a pause they are the only record of the end date the merchant chose
  // — Shopify overwrites it on deactivate. Live where we have it; ours as the
  // memory of intent while paused.
  const paused = identity.status === "paused";
  const startsAt = (paused ? null : live?.startsAt) ?? row.startsAt.toISOString();
  const endsAt = paused
    ? (row.endsAt?.toISOString() ?? null)
    : (live?.endsAt ?? row.endsAt?.toISOString() ?? null);

  return {
    ok: true as const,
    ...identity,
    percentage: config.percentage,
    capMinor,
    currencyCode: config.currencyCode,
    /* (capMinor, percentage) — in that order. Reversed, this returned 0 for
       every discount on the page, because both parameters are `number` and
       nothing but arithmetic could tell. A 20% / 50.00 cap reported "Cap
       starts above 0.00 USD", i.e. that the maximum bites from the first
       cent. `cap-starts-above.test.ts` pins the order down. */
    startsAboveMinor: capStartsAboveMinor(capMinor, config.percentage),
    scope: config.scope,
    appliesTo: config.appliesTo,
    collectionCount: config.collectionIds.length,
    productCount: config.productIds.length,
    minSubtotalMinor:
      config.minSubtotal === undefined ? null : capAmountToMinor(config.minSubtotal),
    minQuantity: config.minQuantity ?? null,
    marketMaximums: Object.entries(config.capsByCurrency ?? {}).map(
      ([code, amount]) => ({ code, amount }),
    ),
    checkoutNote: config.checkoutNote,
    startsAt,
    endsAt,
    // Shopify's own count of how many times a buyer used this. Our `timesUsed`
    // column is not used here: nothing writes it until the orders webhook is
    // approved, so it would read 0 on a discount with a hundred uses.
    timesUsed: live?.asyncUsageCount ?? null,
    usageLimit: live?.usageLimit ?? row.usageLimit,
    oncePerCustomer: live?.appliesOncePerCustomer ?? row.oncePerCustomer,
    combinesProduct: row.combinesProduct,
    combinesOrder: row.combinesOrder,
    combinesShipping: row.combinesShipping,
    plan: plan.plan,
    maxCampaignDays: plan.plan === null ? null : maxCampaignDays(plan.plan),
    // Shopify has no "paused": deactivating sets the status to EXPIRED. So a
    // live EXPIRED against our "paused" is agreement, not a conflict — only a
    // discount we think is running and Shopify does not is worth flagging.
    liveDisagrees:
      identity.status === "active" && live?.status != null && live.status !== "ACTIVE",
    liveStatus: live?.status ?? null,
  };
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const form = await request.formData();

  if (form.get("intent") !== "set-paused") {
    return { ok: false as const, message: "Unknown action." };
  }

  const result = await setDiscountPaused({
    shop: session.shop,
    id: params.id ?? "",
    paused: form.get("paused") === "true",
    admin,
  });

  return result;
};

/** The scope, said the way the create form says it. */
const SCOPE_LABELS: Record<string, string> = {
  order: "The whole order",
  item: "Each item",
  collection: "Each collection",
};

/** What went wrong, and what the merchant can do about it. */
const PROBLEM_COPY: Record<
  CapConfigProblem | "unreachable",
  { heading: string; body: string }
> = {
  missing: {
    heading: "This discount has no MaxOff settings",
    body: "The discount still exists in Shopify, but the maximum MaxOff stores on it is gone. Nothing is being capped. Create a replacement, then delete this one in Shopify.",
  },
  unreadable: {
    heading: "This discount's settings could not be read",
    body: "MaxOff stores the percentage and the maximum on the discount itself, and this copy is not in a shape MaxOff understands. Nothing on this screen would be trustworthy, so nothing is shown. Contact support with the discount name.",
  },
  "unsupported-version": {
    heading: "This discount was set up by a newer version of MaxOff",
    body: "Its settings are in a format this version cannot read. Reload the page — if you keep seeing this, contact support.",
  },
  unreachable: {
    heading: "We could not reach Shopify",
    body: "The discount is fine. MaxOff just could not read its settings this time, and will not show a maximum it has not confirmed. Try again in a moment.",
  },
};

export default function CappedDiscountDetailPage() {
  const data = useLoaderData<typeof loader>();

  if (!data.ok) {
    return <UnreadableDiscount data={data} />;
  }

  return <ReadableDiscount data={data} />;
}

type LoaderData = Awaited<ReturnType<typeof loader>>;
type ReadableData = Extract<LoaderData, { ok: true }>;
type UnreadableData = Extract<LoaderData, { ok: false }>;

/**
 * The screen with no numbers on it.
 *
 * It still names the discount and still offers the way back, because a
 * merchant who clicked a row needs to know which row they are looking at even
 * when the thing behind it is broken.
 */
function UnreadableDiscount({ data }: { data: UnreadableData }) {
  const copy = PROBLEM_COPY[data.problem];

  return (
    <s-page heading={data.name}>
      <s-link slot="breadcrumb-actions" href="/app/discounts">
        Capped discounts
      </s-link>

      <s-banner tone="critical" heading={copy.heading}>
        {copy.body}
      </s-banner>

      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-badge tone={STATUS_TONES[data.status]}>
              {displayStatusLabel(data.status)}
            </s-badge>
            <s-text color="subdued">{data.method}</s-text>
          </s-stack>

          <s-paragraph color="subdued">
            MaxOff shows a percentage and a maximum only when it has read them
            from the discount itself. It has not, so it is showing neither.
          </s-paragraph>

          <s-stack direction="inline" gap="base" alignItems="center">
            <InternalButtonLink href="/app/discounts">
              Back to capped discounts
            </InternalButtonLink>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function ReadableDiscount({ data }: { data: ReadableData }) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();

  const money = (minor: number) => formatMoney(minor, data.currencyCode);
  const paused = data.status === "paused";
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data || busy) {
      return;
    }

    if (fetcher.data.ok) {
      shopify.toast.show(
        `${data.name} ${fetcher.data.status === "paused" ? "paused" : "activated"}`,
      );
      return;
    }

    shopify.toast.show(fetcher.data.message, { isError: true });
  }, [fetcher.data, busy, shopify, data.name]);

  const appliesTo =
    data.appliesTo === "collections"
      ? `${data.collectionCount} collection${data.collectionCount === 1 ? "" : "s"}`
      : data.appliesTo === "products"
        ? `${data.productCount} product${data.productCount === 1 ? "" : "s"}`
        : "All products";

  const combinations = [
    data.combinesProduct ? "Product discounts" : null,
    data.combinesOrder ? "Order discounts" : null,
    data.combinesShipping ? "Shipping discounts" : null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <s-page heading={data.name}>
      <s-link slot="breadcrumb-actions" href="/app/discounts">
        Capped discounts
      </s-link>

      {/* Edit reaches the three fields that cannot change what a cart already
          in checkout is charged — the end date, the usage limit and the
          checkout wording. The percentage and the maximum are not among them;
          `app/lib/discount-edit.ts` argues why. Polaris allows one primary and
          three secondary actions, and these are them. */}
      <InternalButtonLink
        slot="primary-action"
        variant="primary"
        href={`/app/discounts/${data.id}/edit`}
      >
        Edit
      </InternalButtonLink>

      <s-button
        slot="secondary-actions"
        loading={busy}
        onClick={() =>
          fetcher.submit(
            { intent: "set-paused", paused: String(!paused) },
            { method: "post" },
          )
        }
      >
        {paused ? "Activate" : "Pause"}
      </s-button>

      <InternalButtonLink
        slot="secondary-actions"
        href={`/app/discounts/new?duplicate=${encodeURIComponent(data.id)}`}
      >
        Duplicate
      </InternalButtonLink>

      <InternalButtonLink
        slot="secondary-actions"
        href={`/app/test?discount=${encodeURIComponent(data.id)}`}
      >
        Test a cart
      </InternalButtonLink>

      {data.liveDisagrees && (
        <s-banner tone="warning" heading="Shopify and MaxOff disagree about this discount">
          MaxOff has this discount as running. Shopify reports it as{" "}
          {(data.liveStatus ?? "something else").toLowerCase()}. Pause and
          activate it again to put the two back in step.
        </s-banner>
      )}

      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-badge tone={STATUS_TONES[data.status]}>
              {displayStatusLabel(data.status)}
            </s-badge>
            <s-text color="subdued">{data.method}</s-text>
          </s-stack>

          {/* The rule, in the words the merchant set it in. */}
          <s-heading>
            {formatPercent(data.percentage)} off, never more than{" "}
            {money(data.capMinor)}
          </s-heading>

          {data.startsAboveMinor !== null && (
            <div className="maxoff-cap-callout">
              <span>Cap starts above</span>
              <strong className="maxoff-cap-callout__value maxoff-tabular">
                {money(data.startsAboveMinor)}
              </strong>
              <span className="maxoff-cap-callout__working">
                Below that, customers get the full{" "}
                {formatPercent(data.percentage)}.
              </span>
            </div>
          )}
        </s-stack>
      </s-section>

      {/* Three tiles, not the mockup's four. "Orders that hit the cap" and
          "Average order with this code" both need per-order data, and MaxOff
          does not have it — see the Usage section below. A tile that can only
          ever show an em dash is not a tile. */}
      <s-grid
        gridTemplateColumns="@container (inline-size <= 720px) 1fr 1fr, 1fr 1fr 1fr"
        gap="base"
        paddingBlock="base"
      >
        <div className="maxoff-tile maxoff-tile--hero">
          <span className="maxoff-tile__label">Money you kept</span>
          <span className="maxoff-tile__value">{NO_DATA}</span>
          <span className="maxoff-tile__note">Needs per-order tracking</span>
        </div>

        <div className="maxoff-tile">
          <span className="maxoff-tile__label">Times used</span>
          <span className="maxoff-tile__value">
            {data.timesUsed === null ? NO_DATA : data.timesUsed}
          </span>
          <span className="maxoff-tile__note">
            {data.usageLimit === null
              ? "No limit set"
              : `of ${data.usageLimit} allowed`}
          </span>
        </div>

        <div className="maxoff-tile">
          <span className="maxoff-tile__label">Cap starts above</span>
          <span className="maxoff-tile__value">
            {data.startsAboveMinor === null
              ? NO_DATA
              : money(data.startsAboveMinor)}
          </span>
          <span className="maxoff-tile__note">
            {money(data.capMinor)} ÷ {formatPercent(data.percentage)}
          </span>
        </div>
      </s-grid>

      {/* Two to a row. Each of these is a short list of facts, and stacked
          full-width they ran the page to twice the height it needs — a reader
          had to scroll past "Active dates" to reach "Usage" when both together
          are shorter than one screen.

          `s-grid`, not a plain div: a raw element as a direct child of
          `s-page` collapsed a select on the discounts list once already. And
          the track list is `1fr 1fr` with no `minmax()` in it — Polaris splits
          this prop's responsive branches on commas, which is exactly what broke
          `Row`. `alignItems="start"` keeps a one-line card from stretching to
          match a four-line one beside it. */}
      <s-grid
        gridTemplateColumns="@container (inline-size <= 720px) 1fr, 1fr 1fr"
        gap="base"
        alignItems="start"
      >
        <s-section heading="How it applies">
          <div className="maxoff-detail-list">
            <Row label="The maximum applies to" value={SCOPE_LABELS[data.scope] ?? data.scope} />
            <Row label="Applies to" value={appliesTo} />
            <Row
              label="Minimum requirements"
              value={
                data.minSubtotalMinor !== null
                  ? `A subtotal of ${money(data.minSubtotalMinor)}`
                  : data.minQuantity !== null
                    ? `${data.minQuantity} items`
                    : "None"
              }
            />
            {data.marketMaximums.length > 0 && (
              <Row
                label="Other market maximums"
                value={data.marketMaximums
                  .map((entry) => `${entry.amount} ${entry.code}`)
                  .join(", ")}
              />
            )}
          </div>
        </s-section>

        <s-section heading="Active dates">
          <div className="maxoff-detail-list">
            <Row
              label="Starts"
              value={formatDate(new Date(data.startsAt), data.timeZone)}
            />
            <Row
              label="Ends"
              value={
                data.endsAt === null
                  ? "No end date"
                  : formatDate(new Date(data.endsAt), data.timeZone)
              }
            />
            {data.maxCampaignDays !== null && data.plan !== null && (
              <s-text color="subdued">
                The {PLAN_LABELS[data.plan]} plan runs one discount for up to{" "}
                {data.maxCampaignDays} days.{" "}
                <InternalLink href="/app/billing">See plans</InternalLink>
              </s-text>
            )}
            {paused && data.endsAt !== null && (
              <s-text color="subdued">
                Shopify clears the end date when a discount is paused. MaxOff puts
                this one back when you activate it again.
              </s-text>
            )}
          </div>
        </s-section>

        <s-section heading="Usage">
          <div className="maxoff-detail-list">
            <Row
              label="Times used"
              value={data.timesUsed === null ? NO_DATA : String(data.timesUsed)}
            />
            <Row
              label="Money you kept"
              value={NO_DATA}
            />
            <Row
              label="Total uses allowed"
              value={data.usageLimit === null ? "No limit" : String(data.usageLimit)}
            />
            <Row
              label="One use per customer"
              value={data.oncePerCustomer ? "Yes" : "No"}
            />
            <s-text color="subdued">
              Times used comes from Shopify. Money you kept needs per-order
              tracking, which MaxOff does not do yet.
            </s-text>
          </div>
        </s-section>

        <s-section heading="Combinations">
          <Row
            label="Combines with"
            value={combinations.length === 0 ? "Nothing else" : combinations.join(", ")}
          />
        </s-section>

        <s-section heading="What the customer sees">
          <s-stack direction="block" gap="small-300">
            <s-paragraph>{data.checkoutNote}</s-paragraph>
            <s-text color="subdued">
              Shown at checkout only when the maximum is what decided the amount.
            </s-text>
          </s-stack>
        </s-section>
      </s-grid>
    </s-page>
  );
}

/** One label-and-value line. The grid keeps the values in a column. */
/**
 * One label and its value, on one line.
 *
 * This used to be an `s-grid` with
 * `gridTemplateColumns="@container (inline-size <= 500px) 1fr, minmax(0, 14rem) 1fr"`,
 * and it never once rendered two columns: Polaris separates the responsive
 * branches of that prop with a comma, and `minmax(0, 14rem)` contains one. The
 * value was being cut in half mid-function, so every pair fell back to a single
 * column and the page read as twenty-two loose lines instead of eleven facts.
 *
 * Our own grid, in `theme.css`, with no comma to trip over and no dependency on
 * a container context this stylesheet never establishes.
 */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="maxoff-detail-row">
      <span className="maxoff-detail-row__label">{label}</span>
      <span className="maxoff-detail-row__value">{value}</span>
    </div>
  );
}

/**
 * A discount id that is not ours.
 *
 * Reached by an old bookmark, or by a discount deleted in Shopify. Either way
 * it is a dead end without this, because the route throws a bare 404 and the
 * app-level boundary would render Shopify's own error frame.
 */
export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <s-page heading="Discount not found">
        <s-link slot="breadcrumb-actions" href="/app/discounts">
          Capped discounts
        </s-link>

        <s-section>
          <s-stack direction="block" gap="base">
            <s-paragraph>
              MaxOff has no capped discount with this address. It may have been
              deleted, or the link may be out of date.
            </s-paragraph>
            <s-stack direction="inline" gap="base" alignItems="center">
              <InternalButtonLink href="/app/discounts">
                Back to capped discounts
              </InternalButtonLink>
            </s-stack>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  return boundary.error(error);
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
