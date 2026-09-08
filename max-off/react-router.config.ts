import type { Config } from "@react-router/dev/config";

// React Router 7.12 rejects an action whose `Origin` header does not match the
// origin it computed from the incoming request. Embedded Shopify apps always fail
// that check: the browser posts from the public https app URL (the CLI tunnel in
// dev, the proxy in production) while the server only ever sees plain http on
// localhost. Without this the "Bad Request" error is thrown before the loader or
// action runs. Allowing our own public host restores the protection's intent —
// only this app's own origin may submit to it.
const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST;
const appHost = appUrl ? new URL(appUrl).host : undefined;

export default {
  allowedActionOrigins: appHost ? [appHost] : [],
} satisfies Config;
