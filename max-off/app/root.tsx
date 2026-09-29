import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useRouteError,
} from "react-router";

// MaxOff brand tokens, defined once. See app/styles/theme.css.
import "./styles/theme.css";
import { brandThemeCss } from "./lib/brand-theme";

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
        {/* Polaris' own theme tokens, set to the MaxOff palette. Rendered on
            the server so the app never paints a frame of Shopify default
            colours. See app/lib/brand-theme.ts. */}
        <style dangerouslySetInnerHTML={{ __html: brandThemeCss() }} />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Last line of defence. Anything no route handled lands here instead of React
 * Router's unbranded "Unexpected Server Error" page.
 *
 * It renders outside `AppProvider`, so Polaris web components and App Bridge
 * are not available: plain HTML with the brand tokens only. "Try again"
 * reloads the same URL, which keeps Shopify's `shop`/`host` parameters and so
 * works inside the admin iframe.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  if (!notFound) {
    // eslint-disable-next-line no-console
    console.error("[maxoff] unhandled error", error);
  }

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>MaxOff</title>
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body
        style={{
          margin: 0,
          fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
          background: "#f1f1f1",
          color: "#141210",
        }}
      >
        <main
          style={{
            maxWidth: 520,
            margin: "64px auto",
            padding: 24,
            background: "#ffffff",
            borderRadius: 12,
            boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
          }}
        >
          <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>
            {notFound ? "Page not found" : "Something went wrong"}
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, margin: "0 0 20px" }}>
            {notFound
              ? "This MaxOff page doesn't exist. It may have moved, or the link may be out of date."
              : "MaxOff couldn't load this page just now. Discounts already live at checkout are not affected. Try again in a moment."}
          </p>
          <a
            href={`${location.pathname}${location.search}`}
            style={{
              display: "inline-block",
              padding: "8px 14px",
              borderRadius: 8,
              background: "#ea580c",
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Try again
          </a>
        </main>
        <Scripts />
      </body>
    </html>
  );
}
