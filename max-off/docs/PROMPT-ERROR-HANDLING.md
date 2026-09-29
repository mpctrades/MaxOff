# Prompt: error handling for app review (no 500s in front of a reviewer)

Paste everything below the line into Claude Code, opened in `~/Desktop/MaxOff/max-off`.

---

Goal: make sure a Shopify app reviewer never sees a 500 or a dead-end page in MaxOff. A cloud session may already have applied part of this, so check the current code first. Don't redo work that's already correct. Fix anything that's missing or wrong.

## 1. Write helpers must not crash on Admin API errors (`app/models/discounts.server.ts`)

`@shopify/shopify-api` throws `GraphqlQueryError` on top-level GraphQL errors, and `fetch` throws on network failures. The write helpers check `body.errors` but never catch a throw, so a throttle or outage becomes "Unexpected Server Error" instead of a toast.

- There should be an exported `safeGraphql(admin, query, options)` helper that wraps `admin.graphql` and `.json()`. On a throw it logs the error and returns a body of `{ errors: [{ message: "Shopify did not respond as expected. Please try again in a moment." }] }`.
- It must rethrow `Response` instances unchanged. Those are App Bridge re-authentication, and React Router needs to see them.
- Every write path must use it: `setDiscountPaused` (the main mutation and the endsAt restore), `createCappedDiscount` (both code and automatic), `cancelCappedDiscount`, `editCappedDiscount`, and `rewriteCheckoutNote` (the read and the write).
- Then check every route action that calls these helpers (list, detail, new, edit) and confirm it shows `{ ok: false, message }` as a toast and never throws.

## 2. Root error screen (`app/root.tsx`)

`app/routes/app.tsx` hands real errors on via `boundary.error`, and root has no `ErrorBoundary`, so they reach React Router's unbranded 500 page.

- Export an `ErrorBoundary` that renders a full `<html>` document. It sits outside `AppProvider`, so use plain HTML with inline styles, not Polaris web components.
- Show "Page not found" for a 404 and "Something went wrong" otherwise, with a short, calm message.
- Add a **Try again** link to `location.pathname + location.search`, which keeps `shop` and `host` in the admin iframe. Don't use `href=""` (jsx-a11y flags it).
- Use brand orange `#ea580c` for the button and `#141210` for text. Log non-404 errors with `console.error`.

## 3. Edit screen error boundary (`app/routes/app.discounts.$id_.edit.tsx`)

The loader throws 404 (unknown discount) and 409 (unreadable cap_config), but the route has no `ErrorBoundary`, so the merchant sees bare text with no nav.

- Add an `ErrorBoundary` that copies the one in `app/routes/app.discounts.$id.tsx` (around line 655). Use an `<s-page>` with a breadcrumb to `/app/discounts`, an explanation, and an `InternalButtonLink` back to the list.
- Handle 404 ("Discount not found") and 409 ("This discount can't be edited here… Nothing was changed.").
- Fall through to `boundary.error(error)` for anything else.
- Use shopify-dev-mcp to check the Polaris web component markup.

## 4. Optional, low priority

A bare `GET /auth/exit-iframe` with no query parameters returns 500. Shopify never sends that request, so leave it alone unless the fix is one line.

## Verify

1. Run `npm run typecheck`, `npm run lint` and `npm test`. All must pass.
2. On the dev store, open `/app/discounts/does-not-exist/edit`. It should show the "Discount not found" page with a working back button.
3. Temporarily make `safeGraphql`'s inner call throw, then click Pause on a discount. It should show a toast, not a 500. Revert afterwards.
4. Temporarily throw an `Error` in a loader. It should show the branded "Something went wrong" page. Revert afterwards.
5. Report what was already done, what you changed, and the test results. Don't commit until I say so.
