import { defineConfig } from "vitest/config";

/**
 * The app's own unit tests.
 *
 * Deliberately separate from `vite.config.ts`: that config loads the React
 * Router plugin, which wants a route manifest and a dev server. These are
 * plain module tests — `app/lib` arithmetic, the entitlement matrix, the
 * webhook's computation — so they need none of it, and vitest prefers this
 * file over `vite.config.ts` when both exist.
 *
 * The extension keeps its own suite: `extensions/max-off-cap` runs the
 * Function against real input fixtures in a Wasm host, which has nothing to do
 * with these. Root `npm test` runs both, in that order.
 */
export default defineConfig({
  test: {
    include: ["app/lib/**/*.test.{ts,tsx}", "app/components/**/*.test.{ts,tsx}"],
    // `app/routes/` is listed nowhere above on purpose. Flat-file routing names
    // a route for its URL, so the "Test a cart" screen is `app.test.tsx` — a
    // filename a `**/*.test.tsx` glob happily collects. Importing it boots
    // `shopify.server.ts`, which throws on the empty appUrl because a test run
    // has no environment. Two named directories, and the trap cannot be
    // stepped in again by adding a route.
    exclude: ["node_modules/**", "build/**", "extensions/**", ".react-router/**"],
    environment: "node",
  },
});
