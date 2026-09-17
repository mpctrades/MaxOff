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
import {
  cancelCappedDiscount,
  exportCappedDiscountsCsv,
  isCapTypeFilter,
  isMethodFilter,
  listCappedDiscounts,
  setDiscountPaused,
} from "../models/discounts.server";
import type {
  CapTypeFilter,
  DiscountListRow,
  MethodFilter,
} from "../models/discounts.server";
import { getPlanForGate } from "../models/plan.server";
import { ensureShopSettings } from "../models/settings.server";
import {
  DISCOUNT_TAB_LABELS,
  DISCOUNT_TABS,
  displayStatusLabel,
  isDiscountTab,
} from "../lib/cap";
import { BrandButton } from "../components/BrandButton";
import {
  InternalButtonLink,
  InternalLink,
} from "../components/InternalNavigation";
import type { DisplayStatus } from "../lib/cap";
import { formatMoney, formatPercent } from "../lib/format";
import { gateFor, hasNow } from "../lib/plans";
import { useNativeChange } from "../lib/polaris-events";
import type { ValueElement } from "../lib/polaris-events";

/** How long to wait after the last keystroke before searching. */
const SEARCH_DEBOUNCE_MS = 400;

const STATUS_TONES: Record<DisplayStatus, "success" | "info" | "warning" | "neutral"> =
  {
    active: "success",
    scheduled: "info",
    paused: "warning",
    expired: "neutral",
    // Neutral, like expired: a cancelled discount is a record, not a warning.
    cancelled: "neutral",
  };

export const EXPORT_NOT_ON_PLAN = "Export is part of the Pro plan.";

/** `maxoff-capped-discounts-2026-09-15.csv`, dated in UTC. */
function exportFilename(): string {
  return `maxoff-capped-discounts-${new Date().toISOString().slice(0, 10)}.csv`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // The cached plan, not a live read: the only thing it decides here is the
  // wording of a toast on a button that does nothing yet. A ~1.9s round trip
  // to Shopify on every load of the main list is not worth a badge.
  const settings = await ensureShopSettings(session.shop);
  const exportGate = gateFor(settings.plan, "csvExport");

  const url = new URL(request.url);
  const tabParam = url.searchParams.get("tab");
  const tab = isDiscountTab(tabParam) ? tabParam : "all";
  const query = url.searchParams.get("q") ?? "";
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);

  const methodParam = url.searchParams.get("method");
  const method = isMethodFilter(methodParam) ? methodParam : "all";
  const capTypeParam = url.searchParams.get("capType");
  const capType = isCapTypeFilter(capTypeParam) ? capTypeParam : "all";

  try {
    const list = await listCappedDiscounts({
      shop: session.shop,
      tab,
      query,
      method,
      capType,
      page: Number.isNaN(page) ? 1 : page,
    });

    return { list, tab, query, method, capType, exportGate, error: null };
  } catch (error) {
    return {
      list: null,
      tab,
      query,
      method,
      capType,
      exportGate,
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
  const intent = form.get("intent");

  if (intent === "export") {
    // Checked against the plan Shopify reports, not the one the page was
    // rendered with: the button is the affordance, this is the gate.
    const plan = await getPlanForGate({ shop: session.shop, admin });
    if (!hasNow(plan, "csvExport")) {
      return { intent: "export" as const, ok: false as const, message: EXPORT_NOT_ON_PLAN };
    }

    const url = new URL(request.url);
    const tabParam = url.searchParams.get("tab");

    const csv = await exportCappedDiscountsCsv({
      shop: session.shop,
      tab: isDiscountTab(tabParam) ? tabParam : "all",
      query: url.searchParams.get("q") ?? "",
      method: isMethodFilter(url.searchParams.get("method"))
        ? (url.searchParams.get("method") as MethodFilter)
        : "all",
      capType: isCapTypeFilter(url.searchParams.get("capType"))
        ? (url.searchParams.get("capType") as CapTypeFilter)
        : "all",
    });

    // Returned as text rather than as a file response because this route is
    // an embedded app inside Shopify's iframe: a fetcher carries the session
    // token, where a plain link navigation would not. The browser end of the
    // download is done in the component.
    return { intent: "export" as const, ok: true as const, csv, filename: exportFilename() };
  }

  if (intent === "cancel") {
    const result = await cancelCappedDiscount({
      shop: session.shop,
      id: String(form.get("id") ?? ""),
      admin,
    });

    return { intent: "cancel" as const, ...result };
  }

  if (intent !== "set-paused") {
    return { intent: "unknown" as const, ok: false as const, message: "Unknown action." };
  }

  const id = String(form.get("id") ?? "");
  const paused = form.get("paused") === "true";

  const result = await setDiscountPaused({ shop: session.shop, id, paused, admin });

  return { intent: "set-paused" as const, ...result };
};

export default function DiscountsListPage() {
  const { list, tab, query, method, capType, exportGate, error } =
    useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * The export runs through a fetcher because an embedded app lives in
   * Shopify's iframe: a fetcher request carries the App Bridge session token,
   * where a plain link to a file route would arrive unauthenticated. The
   * server hands back the CSV as text and the browser end happens here.
   */
  const exportFetcher = useFetcher<typeof action>();
  const exporting = exportFetcher.state !== "idle";
  const exported = useRef<unknown>(null);

  const exportCsv = () =>
    exportFetcher.submit(
      { intent: "export" },
      { method: "post", action: `?${new URLSearchParams({ tab, q: query })}` },
    );

  useEffect(() => {
    const data = exportFetcher.data;
    if (!data || data === exported.current || exportFetcher.state !== "idle") {
      return;
    }
    exported.current = data;

    // Narrowed on the action's own discriminant rather than by guessing which
    // keys are present: one fetcher type covers three intents.
    if (data.intent !== "export") {
      return;
    }

    if (!data.ok) {
      shopify.toast.show(data.message, { isError: true });
      return;
    }

    // A BOM, because Excel reads a UTF-8 CSV as the system code page without
    // one and turns every non-ASCII product name into mojibake.
    const blob = new Blob([`\uFEFF${data.csv}`], {
      type: "text/csv;charset=utf-8",
    });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = data.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);

    shopify.toast.show("Export downloaded");
  }, [exportFetcher.data, exportFetcher.state, shopify]);

  const go = (next: {
    tab?: string;
    q?: string;
    page?: number;
    method?: string;
    capType?: string;
  }) => {
    const params: Record<string, string> = {
      tab: next.tab ?? tab,
      q: next.q ?? query,
      method: next.method ?? method,
      capType: next.capType ?? capType,
    };
    if (next.page && next.page > 1) {
      params.page = String(next.page);
    }
    // "all" is the default on both filters and the empty string on search, so
    // none of the three belongs in the URL when it is not narrowing anything.
    if (params.q === "") {
      delete params.q;
    }
    if (params.method === "all") {
      delete params.method;
    }
    if (params.capType === "all") {
      delete params.capType;
    }
    submit(params, { method: "get" });
  };

  // Changing a filter returns to the first page: page 3 of a narrower list is
  // usually empty, and an empty table is read as "nothing matches".
  const onMethodChange = useNativeChange<ValueElement>((element) =>
    go({ method: element.value ?? "all", page: 1 }),
  );
  const onCapTypeChange = useNativeChange<ValueElement>((element) =>
    go({ capType: element.value ?? "all", page: 1 }),
  );

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
      {/* Above the table rather than in the title bar, and in MaxOff's own
          button rather than Polaris' bevelled near-black one, so this row
          matches the one on Home and "Change plan" on the plan bar.

          There is no card heading here to sit beside — this page's title
          belongs to the admin's title bar — so the actions take a row of their
          own.

          `s-stack`, not a plain `div`. A raw element as a direct child of
          `s-page` collapsed the "Cap type" select in the table's filters below
          to an empty chevron — "All maximums" stopped rendering. Caught by
          rolling back to the previous build and comparing the two side by
          side. Keep every direct child of `s-page` a Polaris element. */}
      <s-stack
        direction="inline"
        gap="small-300"
        justifyContent="end"
        paddingBlockEnd="base"
      >
        {/* Exports what the merchant is looking at — the current tab and
            search, every page of it, not the 25 rows on screen. Off-plan the
            button stays visible and says why, so a Free merchant can see what
            Pro adds rather than meeting a control that is not there.

            `BrandButton` has no loading state, so the label carries it: an
            export that says "Exporting…" and refuses a second click reports
            the same thing a spinner would, in words. */}
        <BrandButton
          variant="secondary"
          disabled={exporting}
          onClick={
            exportGate.usable
              ? exportCsv
              : () => shopify.toast.show(EXPORT_NOT_ON_PLAN)
          }
        >
          {exporting ? "Exporting…" : "Export"}
        </BrandButton>
        <BrandButton href="/app/discounts/new">
          Create capped discount
        </BrandButton>
      </s-stack>

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

            {/* The page's own line sits where the search field's label would
                be, which puts it on the same line as the "Method" and "Cap
                type" labels beside it. It cannot sit in the title bar under
                the heading — that bar is the admin's, and the `subheading`
                prop that would carry it only exists in Polaris 1.1, still a
                release candidate. `alignItems="end"` lines the three controls
                up along their bottom edge, which is what holds the sentence
                level with the two labels. */}
            <s-grid gridTemplateColumns="1fr auto auto" gap="small-200" alignItems="end">
              <s-stack direction="block" gap="small-400">
                <s-text color="subdued">
                  Every percentage discount with a maximum amount.
                </s-text>
                <s-search-field
                  label="Search by code or name"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Search by code or name"
                  name="q"
                  value={query}
                  onInput={(event) => onSearchInput(event.currentTarget.value)}
                ></s-search-field>
              </s-stack>
              {/* Both read straight off columns in our own mirror, so both
                  filter for real. The cap-type options are the three scopes
                  the Function implements, and nothing else. */}
              <s-select
                label="Method"
                name="method"
                value={method}
                ref={onMethodChange}
              >
                <s-option value="all">All methods</s-option>
                <s-option value="code">Discount code</s-option>
                <s-option value="automatic">Automatic</s-option>
              </s-select>
              <s-select
                label="Cap type"
                name="capType"
                value={capType}
                ref={onCapTypeChange}
              >
                <s-option value="all">All maximums</s-option>
                <s-option value="order">The whole order</s-option>
                <s-option value="item">Each item</s-option>
                <s-option value="collection">Each collection</s-option>
              </s-select>
            </s-grid>
          </s-stack>

          <s-table-header-row>
            {/* "Code" no longer fits every row: an automatic discount is
                listed by the name the merchant gave it. */}
            <s-table-header listSlot="primary">Discount</s-table-header>
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

        {list.rows.length === 0 && (
          /* A shop with no capped discounts at all gets the product's empty
             state. A tab or search that simply matches nothing gets a way back
             — showing "create your first" to a merchant who has six is the
             version of this that reads as a bug. */
          <EmptyState storeIsEmpty={list.storeTotal === 0} />
        )}

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

/**
 * What names a discount in the list.
 *
 * A code discount is its code — that is what the merchant typed and what a
 * buyer types back. An automatic discount has none, so it is named by the
 * title the merchant gave it. "No code" is the last resort for a row whose
 * mirror predates both.
 */
function rowLabel(row: DiscountListRow): string {
  if (row.method === "automatic") {
    return row.title ?? "Automatic discount";
  }

  return row.code ?? "No code";
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

    // This row's fetcher answers two of the page's intents, so each is read
    // by name rather than by whichever keys happen to be on the result.
    if (fetcher.data.ok && fetcher.data.intent === "cancel") {
      const named = fetcher.data.code ?? fetcher.data.title ?? "Discount";
      shopify.toast.show(`${named} cancelled`);
      return;
    }

    if (fetcher.data.ok && fetcher.data.intent === "set-paused") {
      const label = fetcher.data.status === "paused" ? "paused" : "activated";
      // A code discount is named by its code, an automatic one by its title.
      const named = fetcher.data.code ?? fetcher.data.title ?? "Discount";
      shopify.toast.show(`${named} ${label}`);
      return;
    }

    if (fetcher.data.ok) {
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

  // Cancelling deletes the discount in Shopify and cannot be undone, so it
  // asks first. `window.confirm` is the one blocking dialog available without
  // App Bridge's modal, and §4.3 reserves that for the create form's save bar.
  const cancel = () => {
    const named = row.code ?? row.title ?? "this discount";
    if (
      window.confirm(
        `Cancel ${named}? It is deleted in Shopify and cannot be used again. MaxOff keeps the record.`,
      )
    ) {
      fetcher.submit({ intent: "cancel", id: row.id }, { method: "post" });
    }
  };

  const busy = fetcher.state !== "idle";

  return (
    <s-table-row clickDelegate={`discount-link-${row.id}`}>
      <s-table-cell>
        <InternalLink
          id={`discount-link-${row.id}`}
          href={`/app/discounts/${row.id}`}
        >
          {rowLabel(row)}
        </InternalLink>
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
        <RowAction
          status={status}
          busy={busy}
          onSetPaused={setPaused}
          onCancel={cancel}
          duplicateHref={`/app/discounts/new?duplicate=${encodeURIComponent(row.id)}`}
        />
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
/**
 * One action per state, per BUILD-SPEC §12.3 — the mockup offers "Pause" on
 * expired and scheduled rows, which is the bug this table does not port.
 *
 * Cancel deletes the discount in Shopify and keeps MaxOff's row marked
 * cancelled, so the merchant does not lose the record of a campaign that ran.
 * Duplicate opens the create form filled in from this discount rather than
 * writing a second one straight away: codes are unique, so the merchant has to
 * choose a new one, and a form is where that decision belongs.
 */
function RowAction({
  status,
  busy,
  onSetPaused,
  onCancel,
  duplicateHref,
}: {
  status: DisplayStatus;
  busy: boolean;
  onSetPaused: (paused: boolean) => void;
  onCancel: () => void;
  duplicateHref: string;
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
        onClick={onCancel}
        {...(busy ? { loading: true } : {})}
      >
        Cancel
      </s-button>
    );
  }

  // Expired and cancelled rows have nothing left to stop, so the useful thing
  // is to run the campaign again.
  return (
    <InternalButtonLink variant="tertiary" href={duplicateHref}>
      Duplicate
    </InternalButtonLink>
  );
}

function EmptyState({ storeIsEmpty }: { storeIsEmpty: boolean }) {
  return (
    <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
      <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
        <s-stack direction="block" gap="small-200" alignItems="center">
          <s-heading>
            {storeIsEmpty
              ? "No capped discounts yet"
              : "No discounts match these filters"}
          </s-heading>
          <s-paragraph>
            {storeIsEmpty
              ? "A capped discount gives the full percentage on small carts and stops at your maximum on large ones."
              : "Nothing here matches what you are looking for. Clear the filters to see every capped discount."}
          </s-paragraph>
        </s-stack>

        {storeIsEmpty ? (
          <BrandButton href="/app/discounts/new">
            Create capped discount
          </BrandButton>
        ) : (
          <InternalButtonLink href="/app/discounts">
            Clear filters
          </InternalButtonLink>
        )}
      </s-grid>
    </s-grid>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
