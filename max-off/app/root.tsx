import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

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
