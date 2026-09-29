/**
 * Let App Bridge re-authentication through a `catch`.
 *
 * When a session has expired, `admin.graphql` throws a `Response` — Shopify's
 * library asking React Router to send the merchant back through auth. A read
 * helper's fallback ("could not reach Shopify", a cached plan, `null`) is right
 * for a throttle or an outage and wrong for that: swallowing it leaves the
 * merchant on a screen that can never recover. Call this first in any `catch`
 * around `admin.graphql`; everything that is not a `Response` falls through
 * to the existing fallback unchanged.
 */
export function rethrowIfResponse(error: unknown): void {
  if (error instanceof Response) {
    throw error;
  }
}
