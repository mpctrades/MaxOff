import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { syncBrandTheme } from "../lib/brand-theme";
import { InternalLink } from "../components/InternalNavigation";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  // The brand palette is server-rendered against a known Polaris build hash.
  // This re-applies it if Shopify has shipped a new one. Normally a no-op.
  useEffect(() => {
    syncBrandTheme();
  }, []);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <InternalLink href="/app">Home</InternalLink>
        <InternalLink href="/app/discounts">Capped discounts</InternalLink>
        <InternalLink href="/app/discounts/new">Create new</InternalLink>
        <InternalLink href="/app/test">Test a cart</InternalLink>
        <InternalLink href="/app/settings">Settings</InternalLink>
        <InternalLink href="/app/billing">Plans &amp; billing</InternalLink>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
