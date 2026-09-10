import { useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { listCappedDiscounts, setDiscountPaused } from "../models/discounts.server";
import type { DiscountListRow } from "../models/discounts.server";
import {
  DISCOUNT_TAB_LABELS,
  DISCOUNT_TABS,
  displayStatusLabel,
  isDiscountTab,
} from "../lib/cap";
import type { DiscountTab, DisplayStatus } from "../lib/cap";
import { formatMoney, formatPercent } from "../lib/format";

/** How long to wait after the last keystroke before searching. */
const SEARCH_DEBOUNCE_MS = 400;

const STATUS_TONES: Record<DisplayStatus, "success" | "info" | "warning" | "neutral"> =
  {
    active: "success",
    scheduled: "info",
    paused: "warning",
    expired: "neutral",
  };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const tabParam = url.searchParams.get("tab");
  const tab = isDiscountTab(tabParam) ? tabParam : "all";
  const query = url.searchParams.get("q") ?? "";
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);

  try {
    const list = await listCappedDiscounts({
      shop: session.shop,
      tab,
      query,
      page: Number.isNaN(page) ? 1 : page,
    });

    return { list, tab, query, error: null };
  } catch (error) {
    return {
      list: null,
      tab,
      query,
      error:
        error instanceof Error
          ? error.message
          : "MaxOff could not read your capped discounts.",
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const form = await request.formData();
  if (form.get("intent") !== "set-paused") {
    return { ok: false as const, message: "Unknown action." };
  }

  const id = String(form.get("id") ?? "");
  const paused = form.get("paused") === "true";

  return setDiscountPaused({ shop: session.shop, id, paused, admin });
};

export default function DiscountsListPage() {
  const { list, tab, query, error } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const go = (next: { tab?: string; q?: string; page?: number }) => {
    const params: Record<string, string> = {
      tab: next.tab ?? tab,
      q: next.q ?? query,
    };
    if (next.page && next.page > 1) {
      params.page = String(next.page);
    }
    if (params.q === "") {
      delete params.q;
    }
    submit(params, { method: "get" });
  };

  const onSearchInput = (value: string) => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => go({ q: value, page: 1 }), SEARCH_DEBOUNCE_MS);
  };

  useEffect(() => clearTimeout(debounce.current), []);

  if (list === null) {
    return (
      <s-page heading="Capped discounts">
        <s-banner heading="MaxOff could not load your capped discounts" tone="critical">
          {error ?? "Something went wrong."} Reload the page to try again.
        </s-banner>
      </s-page>
    );
  }

  const hasScheduledOrExpired = list.rows.some(
    (row) => row.status === "scheduled" || row.status === "expired",
  );

  return (
    <s-page heading="Capped discounts">
      <s-button
        slot="secondary-actions"
        onClick={() => shopify.toast.show("Export is a Pro feature")}
      >
        Export
      </s-button>
      <s-button slot="primary-action" variant="primary" href="/app/discounts/new">
        Create capped discount
      </s-button>

      <s-paragraph color="subdued">
        Every percentage discount with a maximum amount.
      </s-paragraph>

      <s-section accessibilityLabel="Capped discounts" padding="none">
        <s-table
          {...(list.hasNextPage || list.hasPreviousPage
            ? {
                paginate: true,
                hasNextPage: list.hasNextPage,
                hasPreviousPage: list.hasPreviousPage,
                onNextPage: () => go({ page: list.page + 1 }),
                onPreviousPage: () => go({ page: list.page - 1 }),
              }
            : {})}
        >
          <s-stack slot="filters" direction="block" gap="small-200">
            {/* Polaris has no tabs component in this version, so the status
                tabs are a button group of links. They carry the tab in the URL,
                which is what makes a filtered list linkable. */}
            <s-button-group>
              {DISCOUNT_TABS.map((tabName) => (
                <s-button
                  key={tabName}
                  variant={tabName === tab ? "primary" : "tertiary"}
                  onClick={() => go({ tab: tabName, page: 1 })}
                  accessibilityLabel={`${DISCOUNT_TAB_LABELS[tabName]} — ${list.tabCounts[tabName]} discounts`}
                >
                  {`${DISCOUNT_TAB_LABELS[tabName]} ${list.tabCounts[tabName]}`}
                </s-button>
              ))}
            </s-button-group>

            <s-grid gridTemplateColumns="1fr auto auto" gap="small-200" alignItems="end">
              <s-search-field
                label="Search by code"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by code"
                name="q"
                value={query}
                onInput={(event) => onSearchInput(event.currentTarget.value)}
              ></s-search-field>
              {/* V2, rendered as visible disabled affordances (rule 6). */}
              <s-select label="Method" name="method" value="code" disabled>
                <s-option value="code">Discount code</s-option>
              </s-select>
              <s-select label="Cap type" name="capType" value="order" disabled>
                <s-option value="order">The whole order</s-option>
              </s-select>
            </s-grid>
          </s-stack>

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
            <s-table-header>Action</s-table-header>
          </s-table-header-row>

          <s-table-body>
            {list.rows.map((row) => (
              <DiscountRow key={row.id} row={row} />
            ))}
          </s-table-body>
        </s-table>

        {list.rows.length === 0 && <EmptyState tab={tab} query={query} />}

        {hasScheduledOrExpired && (
          <s-paragraph color="subdued">
            Cancel and Duplicate are not built yet. Cancelling a scheduled
            discount and duplicating an expired one both need the create form.
          </s-paragraph>
        )}
      </s-section>

      {list.pageCount > 1 && (
        <s-paragraph color="subdued">
          Page {list.page} of {list.pageCount} · {list.total}{" "}
          {list.total === 1 ? "discount" : "discounts"}
        </s-paragraph>
      )}
    </s-page>
  );
}

function DiscountRow({ row }: { row: DiscountListRow }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const seen = useRef<unknown>(null);

  // Optimistic: while the write is in flight, show the state being asked for.
  // If Shopify refuses, the fetcher settles and we fall back to `row.status`,
  // which is the mirror — and the mirror is only written after Shopify agrees.
  const pending = fetcher.formData?.get("paused");
  const status: DisplayStatus =
    pending === undefined
      ? row.status
      : pending === "true"
        ? "paused"
        : "active";

  useEffect(() => {
    if (!fetcher.data || fetcher.data === seen.current) {
      return;
    }
    seen.current = fetcher.data;

    if (fetcher.data.ok) {
      const label = fetcher.data.status === "paused" ? "paused" : "activated";
      shopify.toast.show(`${fetcher.data.code ?? "Discount"} ${label}`);
      return;
    }

    const upgradeUrl =
      "upgradeUrl" in fetcher.data ? fetcher.data.upgradeUrl : undefined;

    shopify.toast.show(fetcher.data.message, {
      isError: true,
      ...(upgradeUrl
        ? {
            action: "View plans",
            onAction: () => {
              window.location.href = upgradeUrl;
            },
          }
        : {}),
    });
  }, [fetcher.data, shopify]);

  const setPaused = (paused: boolean) =>
    fetcher.submit(
      { intent: "set-paused", id: row.id, paused: String(paused) },
      { method: "post" },
    );

  const busy = fetcher.state !== "idle";

  return (
    <s-table-row clickDelegate={`discount-link-${row.id}`}>
      <s-table-cell>
        <s-link id={`discount-link-${row.id}`} href={`/app/discounts/${row.id}`}>
          {row.code ?? "No code"}
        </s-link>
      </s-table-cell>
      <s-table-cell>{formatPercent(row.percentage)} off</s-table-cell>
      <s-table-cell>{formatMoney(row.capMinor, row.currencyCode)}</s-table-cell>
      <s-table-cell>
        {row.capStartsAboveMinor === null
          ? "—"
          : formatMoney(row.capStartsAboveMinor, row.currencyCode)}
      </s-table-cell>
      <s-table-cell>{row.timesUsed}</s-table-cell>
      <s-table-cell>
        {row.keptMinor === 0 ? "—" : formatMoney(row.keptMinor, row.currencyCode)}
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={STATUS_TONES[status]}>{displayStatusLabel(status)}</s-badge>
      </s-table-cell>
      <s-table-cell>
        <RowAction status={status} busy={busy} onSetPaused={setPaused} />
      </s-table-cell>
    </s-table-row>
  );
}

/**
 * One action per state, per BUILD-SPEC §12.3 — the mockup offers "Pause" on
 * expired and scheduled rows, which is the bug this table does not port.
 * Cancel and Duplicate have no implementation yet, so they are disabled with
 * the reason in their accessibility label rather than live buttons that throw.
 */
function RowAction({
  status,
  busy,
  onSetPaused,
}: {
  status: DisplayStatus;
  busy: boolean;
  onSetPaused: (paused: boolean) => void;
}) {
  if (status === "active") {
    return (
      <s-button
        variant="tertiary"
        onClick={() => onSetPaused(true)}
        {...(busy ? { loading: true } : {})}
      >
        Pause
      </s-button>
    );
  }

  if (status === "paused") {
    return (
      <s-button
        variant="tertiary"
        onClick={() => onSetPaused(false)}
        {...(busy ? { loading: true } : {})}
      >
        Activate
      </s-button>
    );
  }

  if (status === "scheduled") {
    return (
      <s-button
        variant="tertiary"
        disabled
        accessibilityLabel="Cancel is not available yet — cancelling a scheduled discount comes with the create form"
      >
        Cancel
      </s-button>
    );
  }

  return (
    <s-button
      variant="tertiary"
      disabled
      accessibilityLabel="Duplicate is not available yet — it needs the create form"
    >
      Duplicate
    </s-button>
  );
}

function EmptyState({ tab, query }: { tab: DiscountTab; query: string }) {
  const searching = query.trim() !== "";

  return (
    <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
      <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
        <s-stack direction="block" gap="small-200" alignItems="center">
          <s-heading>
            {searching ? "No codes matched that search" : "No discounts here yet"}
          </s-heading>
          <s-paragraph>
            {searching
              ? `Nothing in ${DISCOUNT_TAB_LABELS[tab]} matches “${query.trim()}”.`
              : "When a capped discount reaches this state it will show up here."}
          </s-paragraph>
        </s-stack>
        {searching ? (
          <s-button href={`/app/discounts?tab=${tab}`}>Clear search</s-button>
        ) : (
          <s-button variant="primary" href="/app/discounts/new">
            Create capped discount
          </s-button>
        )}
      </s-grid>
    </s-grid>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
