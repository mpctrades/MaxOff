/**
 * Whether this deployment may let a URL parameter stand in for real data.
 *
 * Some states are unreachable on a dev store by design. A shop on Pro has no
 * discount meter to fill and can never render the Growth column as "current",
 * so the only way to look at those screens before a merchant does is to ask
 * for them.
 *
 * Two ways in, and production is not one of them by accident:
 *
 *   - `NODE_ENV !== "production"` — a local `npm run dev`.
 *   - `MAXOFF_DEV_TOOLS=1` — set deliberately on a deployment that is not
 *     serving real merchants. Our container is built with NODE_ENV=production
 *     because that is what React Router needs, so the dev deployment would
 *     otherwise be indistinguishable from the real one.
 *
 * Unset is the default everywhere, so shipping this changes nothing until
 * somebody turns it on for a specific box.
 *
 * What it may never do is change an entitlement. A forced plan reaches labels,
 * badges and button colours; every gate that decides what a merchant may
 * actually do re-reads the plan server-side from `plan.server.ts`, and the
 * plan buttons all lead to Shopify's own hosted plan page whatever this says.
 */
export function devPreviewAllowed(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.MAXOFF_DEV_TOOLS === "1"
  );
}
