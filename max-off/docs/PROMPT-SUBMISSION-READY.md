# PROMPT — Submission readiness pass

**Run this in Claude Code on the Mac, in `~/Desktop/MaxOff/max-off`.**
Not in a cloud session: tasks 1 and 2 write Polaris markup, which is CLAUDE.md rule 1.

Save a copy to `docs/PROMPT-SUBMISSION-READY.md` in the repo before running, so the run has it locally.

---

## Context you must read first

Read these before writing any code:

- `CLAUDE.md` — the project rules. Rule 1 and rule 9 both apply to this run.
- `docs/BUILD-SPEC.md` — especially §3.6 (plans and allowances) and §4.2 (pause/activate).
- `docs/MaxOff-mockup.html` — the frozen clickable prototype. **It is the authority for layout,
  copy and behaviour. Polaris is the authority for pixels.** Where they disagree, Polaris wins.
- `app/lib/plans.ts` — the entitlement matrix. Every plan gate reads from here. Do not duplicate it.

## Standing constraints — do not violate any of these

1. **Polaris web components only** (`<s-page>`, `<s-button>`, `<s-section>` …) via App Bridge 4.
   The `@shopify/polaris` React package is **not installed and must not be installed**.
2. **Verify every Polaris tag name and attribute against `shopify-dev-mcp` before using it.**
   Tag names for tabs, search, disabled filters, pagination and empty states have never been
   verified in this repo. Do not guess them.
3. **Shopify is the source of truth.** The cap lives in the app-owned `$app / cap_config` JSON
   metafield on the discount. Prisma is a mirror for listing, search and analytics — never the
   authority. Namespace is `$app`, not `$app:maxoff`.
4. **Never write "break-even" in merchant-facing copy.** The merchant-facing name is
   **"Cap starts above"**. The value is `cap ÷ (percentage / 100)`.
5. Do not add scopes. The scope list stays `write_discounts,read_discounts,read_products`.
6. Do not touch `extensions/max-off-cap`. The Function is verified working at a real checkout
   (150.00 on a 1,400 cart, 105.00 on a 700 cart). Do not add `[extensions.input.variables]`.
7. Light mode only. Brand colours: `--orange #c2410c` text, `--orange-bright #ea580c` fills,
   `--orange-soft #fff2e8`, `--orange-line #f8c39a`, ink `#141210`. Green and red are for status
   marks only.
8. Reuse `app/lib/format.ts`, `cap.ts`, `basket.ts`, `discount-form.ts`, `cap-config.ts` and the
   existing components (`BrandButton`, `PlanStrip`, `CheckoutPreviewModal`, `CheckoutReceipt`)
   rather than writing new helpers.

---

## Task 0 — Verify the billing fix actually landed

`docs/PROMPT-BILLING-FIX.md` was written on 14 Sep and may or may not have been run.

Open `app/routes/app.billing.tsx` and confirm:

- The upgrade and downgrade controls are **plain links with `target="_top"`** pointing at the
  hosted plan page URL computed in the loader.
- There is **no** `<form method="post">` posting to the route's own action for plan changes, and
  no `redirect(url, { target: "_top" })` action left behind.

If it already looks like that, say so and move on. If it still POSTs to its own action, apply
`docs/PROMPT-BILLING-FIX.md` first — a plain form POST carries no session-token header, so the
App Bridge reauth path is skipped and the redirect navigates the app's own iframe, which Shopify
admin refuses to frame. That is the silent dead-button symptom.

---

## Task 1 — Build the discount detail screen (highest priority)

`app/routes/app.discounts.$id.tsx` is a **17-line stub**. A Shopify reviewer will click a
discount from the list and land on an empty screen. This fails review on its own.

Build it to match the detail screen in `docs/MaxOff-mockup.html`.

**Loader** — read the discount by id:
- Read the `$app / cap_config` metafield from Shopify as the authority for percentage and cap.
- Use the Prisma mirror only for listing metadata (title, created date, usage count).
- If the metafield is missing or unparseable, render an explicit error state. Do not silently
  fall back to the mirror's values — that would show a cap that isn't the one in force.
- Handle "id not found" with a proper 404 state, not a crash.

**Screen must show:**
- Discount title and status (active / paused / scheduled / expired).
- The rule in plain words: "15% off, never more than $150."
- **"Cap starts above"** — the computed `cap ÷ (percentage / 100)`, formatted with `format.ts`.
- Dates, and the Free-plan 15-day limit where it applies (read from `app/lib/plans.ts`).
- Usage. Where the Kept column has no data, use an em dash — never `0` or `$0.00`.

**Actions:**
- Pause / activate, using the same mechanism as `app.discounts._index.tsx` §4.2. **Verify against
  `shopify-dev-mcp` that pausing an app discount behaves the way §4.2 assumes** — this is listed
  as a known unknown and has never been confirmed.
- Edit, linking to the existing create/edit form.
- A "Test this cart" link through to `app.test.tsx`, prefilled with this discount.

**Do not** add delete unless the mockup shows it.

---

## Task 2 — Fix the Home factual-claim risk, and prepare the webhook inert

Home's tiles ("Over-discounting avoided · this month", "Orders capped", "Biggest single save")
and the "Money you kept" chart all read from `CapEvent`. **Nothing in the app ever writes a
`CapEvent` row.** There is no `orders/paid` webhook, and `read_orders` is deliberately not in
scopes. So for every real merchant these read "No capped orders yet" forever, under copy that
promises "This chart fills in once an order uses one of your capped discounts."

Nothing shown is false, but the app promises a feature it cannot deliver. A reviewer is likely
to raise this under requirement 1.1.4.

### 2a — Soften the copy (ship this now)

In `app/routes/app._index.tsx` (the `hasCapEvents` branches around lines 203, 233 and 291) and
wherever the empty-state strings live:

- Rewrite so no copy promises a chart or figure that will fill on its own. Say plainly that
  per-order tracking is coming, rather than implying it is already running and merely waiting.
- Keep the three-state design — Home must never invent a figure.
- Keep the em dash convention in the Kept column.
- Draft the new strings and **show them to me before applying**. This is merchant-facing copy and
  needs sign-off.

### 2b — Prepare the webhook, leave it inert

Write the `orders/paid` handler so it is ready the day `read_orders` is approved, but cannot run
or affect review today:

- Add the handler under `app/routes/` following the pattern of the existing compliance webhooks,
  with the same HMAC verification.
- It computes the capped amount from the order's discount applications and writes one `CapEvent`
  row, idempotently — re-delivery of the same order must not double-count.
- Gate it behind an env flag (e.g. `MAXOFF_ENABLE_ORDER_EVENTS`), **defaulting to off**.
- **Do not** add `read_orders` to scopes.
- **Do not** add the `orders/paid` subscription to `shopify.app.toml`.
- Add a short note at the top of the file saying both of those are pending Partner Dashboard
  protected-customer-data approval (Level 1).
- Write tests for the computation and the idempotency, using a fixture order payload.

---

## Task 3 — Make an unmapped paid subscription fail loudly

`planFromLabel` in `app/models/plan.server.ts` (around line 165) matches a subscription by name
against the plan keys and labels. An unmatched **paid** subscription falls back to `"growth"`
with only a `console.warn`. A plan named "MaxOff Pro" or "Pro plan" in the Partner Dashboard
would therefore charge a merchant $7.99 and silently serve them Growth entitlements.

Change it so an unmapped paid subscription:

- Does **not** silently grant Growth.
- Returns an explicit unknown/error state that the UI surfaces — the merchant sees a clear
  "we can't read your plan, contact support" message rather than quietly reduced features.
- Logs enough to diagnose (the subscription name received, and the names it was matched against).

Free / no subscription keeps its current behaviour.

---

## Task 4 — Give the billing page a fallback when the plan page URL is missing

`hostedPlanPageUrl()` in `app/models/plan.server.ts` (around line 305) returns `null` when the
app handle can't be read, and `app/routes/app.billing.tsx` (around lines 266–268) then renders
`null`. The merchant is left with no way to change plans and no explanation.

Render an explanatory fallback instead of `null` — state that plan changes are temporarily
unavailable and point at support. This is requirement 1.2.3 (allow pricing plan changes).

---

## Task 5 — Wire vitest into the root test script

`package.json:16` is `"test": "npm test --workspaces --if-present"`, and there is no root vitest
config. Only `extensions/max-off-cap` (158 tests) runs. **Thirteen test files under `app/` have
never executed** — including `app/lib/cap.test.ts`, `plans.test.ts`, `discount-form.test.ts` and
`format.test.ts`.

- Add a root vitest config covering `app/`.
- Make root `npm test` run both the app tests and the workspace tests.
- Run them. **Report every failure; do not fix them silently and do not delete or skip a failing
  test to make the suite green.** Some of these have never run and may be stale — I need to see
  which.

---

## Verification before you report back

Run all of these and paste the real output:

```
npm run typecheck
npm run lint
npm run build
npm test
```

Then, on the dev store `maxoff-s7fqtwdd.myshopify.com`:

- Open a discount from the list and confirm the detail screen renders, shows the correct cap and
  "Cap starts above", and that pause/activate actually changes the discount's state in Shopify.
- Confirm Home shows no copy promising data it cannot produce.
- Confirm Plans & billing renders a plan-change control, or the new fallback message.

## Report back with

1. Task 0 result — had the billing fix already landed, yes or no.
2. The new Home copy strings, for sign-off before they go in.
3. The full list of `app/` test failures uncovered by task 5.
4. Anything in the mockup for the detail screen that Polaris could not express, and what you did
   instead.

## Out of scope — do not attempt

- Creating the three plans in the Partner Dashboard (Gate 6). Sophea only.
- Setting or changing app distribution to Public. Arthur's decision, irreversible.
- Changing `application_url` / `redirect_urls` in `shopify.app.toml`, or writing a production
  nginx vhost. The production hostname is not decided yet.
- App Store listing assets — logo, screenshots, hero, banner.
- Requesting `read_orders` / protected customer data approval.
