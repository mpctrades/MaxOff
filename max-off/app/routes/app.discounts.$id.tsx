import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { readCapConfigFor } from "../models/discounts.server";
import { InternalButtonLink, InternalLink } from "../components/InternalNavigation";
import {
  capStartsAboveMinor,
  displayStatus,
  displayStatusLabel,
} from "../lib/cap";
import type { DisplayStatus } from "../lib/cap";
import { capAmountToMinor, DEFAULT_CHECKOUT_NOTE } from "../lib/cap-config";
import { formatDate, formatMoney, formatPercent } from "../lib/format";

const STATUS_TONES: Record<DisplayStatus, "success" | "info" | "warning" | "neutral"> =
  {
    active: "success",
    scheduled: "info",
    paused: "warning",
    expired: "neutral",
    cancelled: "neutral",
  };

/**
 * One capped discount, read-only.
 *
 * The row is our mirror; the targeting, the minimums and the per-market
 * maximums live in the discount's own `cap_config` metafield, so both are
 * read — the same pair Duplicate reads, for the same reason.
 *
 * There is no edit here. Changing a live discount's percentage or maximum
 * changes what every cart already in flight will be charged, and MaxOff has
 * no answer yet for what that should do to a buyer part-way through checkout.
 * Pausing and duplicating are the two safe things, and both are offered.
 */
export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const found = await readCapConfigFor({
    shop: session.shop,
    id: params.id ?? "",
    admin,
  });

  if (found === null) {
    throw new Response("Not found", { status: 404 });
  }

  const { row } = found;
  const config =
    typeof found.config === "object" && found.config !== null
      ? (found.config as Record<string, unknown>)
      : {};

  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

  const minSubtotal = text(config.minSubtotal);

  return {
    id: row.id,
    name: row.code ?? row.title ?? "Capped discount",
    method: row.method === "automatic" ? "Automatic" : "Discount code",
    status: displayStatus(row, new Date()),
    percentage: row.percentage,
    capMinor: row.capMinor,
    currencyCode: row.currencyCode,
    startsAboveMinor: capStartsAboveMinor(row.percentage, row.capMinor),
    scope: text(config.scope) || row.scope,
    appliesTo: text(config.appliesTo) || "all",
    collectionCount: list(config.collectionIds).length,
    productCount: list(config.productIds).length,
    minSubtotalMinor: minSubtotal === "" ? null : capAmountToMinor(minSubtotal),
    minQuantity: typeof config.minQuantity === "number" ? config.minQuantity : null,
    marketMaximums:
      typeof config.capsByCurrency === "object" && config.capsByCurrency !== null
        ? Object.entries(config.capsByCurrency as Record<string, unknown>).flatMap(
            ([code, amount]) => (typeof amount === "string" ? [{ code, amount }] : []),
          )
        : [],
    checkoutNote: row.checkoutNote || DEFAULT_CHECKOUT_NOTE,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    usageLimit: row.usageLimit,
    oncePerCustomer: row.oncePerCustomer,
    combinesProduct: row.combinesProduct,
    combinesOrder: row.combinesOrder,
    combinesShipping: row.combinesShipping,
    timesUsed: row.timesUsed,
    keptMinor: row.keptMinor,
  };
};

/** The scope, said the way the create form says it. */
const SCOPE_LABELS: Record<string, string> = {
  order: "The whole order",
  item: "Each item",
  collection: "Each collection",
};

export default function CappedDiscountDetailPage() {
  const data = useLoaderData<typeof loader>();
  const money = (minor: number) => formatMoney(minor, data.currencyCode);

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
      {/* `InternalButtonLink`, not a bare href: a plain link navigates the
          embedded iframe out of the App Bridge session. */}
      <InternalButtonLink
        slot="secondary-actions"
        href={`/app/discounts/new?duplicate=${encodeURIComponent(data.id)}`}
      >
        Duplicate
      </InternalButtonLink>

      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-badge tone={STATUS_TONES[data.status]}>
              {displayStatusLabel(data.status)}
            </s-badge>
            <s-text color="subdued">{data.method}</s-text>
          </s-stack>

          <s-heading>
            {formatPercent(data.percentage)} off, maximum {money(data.capMinor)}
          </s-heading>

          {data.startsAboveMinor !== null && (
            <div className="maxoff-cap-callout">
              <span>Cap starts above</span>
              <strong className="maxoff-cap-callout__value maxoff-tabular">
                {money(data.startsAboveMinor)}
              </strong>
            </div>
          )}
        </s-stack>
      </s-section>

      <s-section heading="How it applies">
        <s-stack direction="block" gap="small-300">
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
        </s-stack>
      </s-section>

      <s-section heading="Active dates">
        <s-stack direction="block" gap="small-300">
          <Row label="Starts" value={formatDate(new Date(data.startsAt))} />
          <Row
            label="Ends"
            value={data.endsAt === null ? "No end date" : formatDate(new Date(data.endsAt))}
          />
        </s-stack>
      </s-section>

      <s-section heading="Usage">
        <s-stack direction="block" gap="small-300">
          <Row label="Times used" value={String(data.timesUsed)} />
          <Row label="Money you kept" value={money(data.keptMinor)} />
          <Row
            label="Total uses allowed"
            value={data.usageLimit === null ? "No limit" : String(data.usageLimit)}
          />
          <Row
            label="One use per customer"
            value={data.oncePerCustomer ? "Yes" : "No"}
          />
        </s-stack>
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

      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <InternalButtonLink href="/app/discounts">
            Back to capped discounts
          </InternalButtonLink>
          <s-text color="subdued">
            Pausing and cancelling are on the{" "}
            <InternalLink href="/app/discounts">list</InternalLink>.
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

/** One label-and-value line. The grid keeps the values in a column. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <s-grid
      gridTemplateColumns="@container (inline-size <= 500px) 1fr, minmax(0, 14rem) 1fr"
      gap="small-300"
    >
      <s-text color="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </s-grid>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
