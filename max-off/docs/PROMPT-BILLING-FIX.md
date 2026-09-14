# Prompt — make the plan buttons actually reach Shopify's pricing page

**Written:** 14 Sep 2026 · **Run this in Claude Code on the Mac**, where `shopify-dev-mcp` is
available (CLAUDE.md rule 1). Follows `PROMPT-BILLING.md`, which built the screen.

**Reported symptom (Sophea, 14 Sep):** on `/app/billing`, clicking **Upgrade to Growth** or
**Upgrade to Pro** does *nothing at all*. No navigation, no error, no banner — the page just sits
there.

The screen is not wrong about its design. §4.8 is right that it displays and does not transact,
and the App Pricing choice in §3.6 still stands. What is broken is narrower than that, and there
are **two faults stacked on top of each other**. Fixing either one alone leaves the button dead.

---

## 1 · Fault one — the redirect never leaves the embedded iframe

`app/routes/app.billing.tsx` sends the merchant to Shopify by POSTing a form to its own action,
which then returns `redirect(hostedPlanUrl, { target: "_top" })`.

Read `node_modules/@shopify/shopify-app-react-router/dist/cjs/server/authenticate/admin/helpers/redirect.js`.
`redirectFactory` decides what a `target: "_top"` redirect actually emits, in this order:

```js
if (target === '_self')            { ... }                       // not us — target is "_top"
else if (isDataRequest(request))   { throw redirectWithAppBridgeHeaders(url) }   // 401 + reauth header
else if (isEmbeddedRequest(request)){ throw renderAppBridge(params, request, {url, target}) }
return reactRouter.redirect(url, init);                          // ← plain 302
```

and the two predicates are:

```js
isDataRequest  → requires a session-token header (Authorization: Bearer …)
isEmbeddedRequest → searchParams.get('embedded') === '1'   // on the POST request's own URL
```

The billing page deliberately uses a plain `<form method="post">` rather than React Router's
`<Form>` — the comment in the file says this is so "the browser performs a real navigation and
honours that response." That is exactly what breaks it:

- A plain browser form POST carries **no session-token header**, so `isDataRequest` is false. The
  App Bridge reauth path is never taken.
- Whether `isEmbeddedRequest` is true depends on `embedded=1` still being on the document URL at
  the moment of the POST. App Bridge 4 rewrites the embedded URL after boot, so this is not
  something to rely on.
- When it is false, execution reaches the last line: **a plain 302 to `admin.shopify.com`.** The
  browser applies that to the frame that made the request — the app's own iframe. Shopify admin
  refuses to be framed, so the iframe silently fails to navigate.

Silently. No error, no console message the merchant would see, nothing. Which is precisely the
reported symptom.

**The POST is also unnecessary.** The action recomputes `hostedPlanPageUrl` from a second
`getCurrentPlan` call — a whole extra Admin GraphQL round trip — to produce a URL the loader
already put in `data.hostedPlanUrl` and already handed to the component. There is no server work
to do here. This is a link.

## 2 · Fault two — the destination does not exist yet

Even with the navigation fixed, `https://admin.shopify.com/store/<store>/charges/<app-handle>/pricing_plans`
only renders plans that exist. **Gate 6 — "Create the three Managed Pricing plans in the Partner
Dashboard" (`MASTER-BUILD-PROMPT.md`, line 107) — has never been done.** It is Sophea's task, not a
coding task, and `docs/GATE-6-PARTNER-DASHBOARD.md` is the runbook for it.

`app/models/plan.server.ts` already says this in its header comment: the plan read "cannot be
checked until the three plans exist in the Partner Dashboard." Until they do, `getCurrentPlan`
correctly reports Free for everyone, because there is genuinely no subscription to find.

So: **this prompt fixes the button. It does not make a merchant able to pay.** Do not claim it
does in the build log. The screen is only testable end to end once Gate 6 is closed.

---

## 3 · Verify before you write (shopify-dev-mcp, rule 1)

1. The current, correct way for an **embedded** app to navigate the **top-level** window to a
   Shopify admin URL. Confirm whether an `<a href target="_top">` is the documented pattern, or
   whether App Bridge wants something else. Do not take the recommendation in §4 on trust.
2. Re-confirm the hosted plan-selection URL shape
   (`/store/:store_handle/charges/:app_handle/pricing_plans`) against the live docs.
3. Whether `currentAppInstallation.activeSubscriptions` on the Admin API returns **App Pricing**
   subscriptions, or only Billing-API ones. `plan.server.ts` flags this as unresolved and it
   decides whether the `plan_handle` redirect path in §5 is a fallback or the primary mechanism.

If the MCP server is unavailable, stop and say so.

---

## 4 · The change

### 4.1 `app/components/BrandButton.tsx` — accept a `target`

The anchor branch renders `<a className href slot aria-label>` and drops everything else. Add an
optional `target?: string` to `BrandButtonProps` and pass it through on the `<a>` only. When
`target` is set and points off-origin, also set `rel="noopener"`. Do not add it to the `<button>`
branch — it means nothing there.

### 4.2 `app/routes/app.billing.tsx` — make both buttons links

Replace the `<form method="post">` in **`PlanAction`** and the one in the `PlanStrip` `action`
slot with the same `BrandButton` rendered as a link:

```tsx
<BrandButton fill href={hostedPlanUrl} target="_top" variant={…}>
  {below ? `Move to ${PLAN_LABELS[plan]}` : `Upgrade to ${PLAN_LABELS[plan]}`}
</BrandButton>
```

`hostedPlanUrl` is already in the loader data and already passed into both components. Nothing new
needs fetching.

### 4.3 Delete the action

With both buttons as links, `export const action` in `app.billing.tsx` has no caller. Delete it,
along with the now-unused `ActionFunctionArgs` import and the second `getCurrentPlan` call inside
it. Keep the `recordPlanHandle` call in the **loader** — that is the App Pricing return path and it
is unrelated.

### 4.4 Keep the null-URL behaviour exactly as it is

`hostedPlanUrl === null` must still hide the button and still show the "Plan page unavailable"
banner. That branch is correct and is the only thing standing between a merchant and a broken link.
`BrandButton` already refuses to render an anchor without an href, but do not lean on that — keep
the explicit `if (hostedPlanUrl === null) return null;` guard in `PlanAction`.

---

## 5 · One trap in `plan.server.ts` that Gate 6 will spring

`planFromLabel` maps a subscription onto a plan by matching, case-insensitively, against the plan
**keys** (`free` / `growth` / `pro`) and the plan **labels** (`Free` / `Growth` / `Pro`). Anything
it cannot match falls through to:

```js
plan = "growth";   // "a subscription we cannot name is still a subscription somebody is paying for"
```

That fallback is a reasonable instinct and a bad outcome: a merchant who pays for **Pro** and whose
plan is named anything else in the Partner Dashboard — "Pro plan", "MaxOff Pro", "Pro (monthly)" —
is silently served **Growth** entitlements while being charged for Pro. They would lose per-item
caps, CSV export and priority support, and the only trace is a `console.warn`.

Two things follow, and both belong in this commit:

1. The Partner Dashboard plan names and handles **must** be exactly `Free`, `Growth`, `Pro`. That
   is now a hard constraint written into `GATE-6-PARTNER-DASHBOARD.md`, not a preference.
2. Surface the mismatch where someone will see it. The `unmappedSubscriptionName` banner already
   exists on the billing page — good. Consider whether an unmapped **paid** subscription should
   fail loudly rather than quietly granting the middle tier; raise it with Sophea rather than
   deciding alone, and note the decision in the build log.

---

## 6 · Verification — report each in one line

1. `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` all clean.
2. On the dev store, click **Upgrade to Growth**. The **whole browser window** navigates to
   `admin.shopify.com/store/maxoff-s7fqtwdd/charges/<app-handle>/pricing_plans` — not the iframe.
   Paste the URL you actually landed on.
3. Report what that page shows. Before Gate 6 it will be empty or a 404 — that is the expected,
   correct result at this point and it is *not* a reason to change the code again. Say which you saw.
4. Confirm the app frame is not left blank or broken behind the navigation.
5. Force `hostedPlanUrl` to null and confirm the buttons disappear and the "Plan page unavailable"
   banner shows.
6. Confirm the "Current plan" button is still disabled on the plan in use.
7. Keyboard pass: both links reachable by tab, focus visible, and the link announces as a link.
8. Confirm no network POST to `/app/billing` happens on click any more.

Commit as `fix(billing): link straight to Shopify's plan page instead of a redirect that cannot
leave the iframe`. Then append a `docs/BUILD-LOG.md` entry covering the `redirectFactory` analysis
in §1, the fact that Gate 6 still blocks a real purchase, and the §5 mis-mapping trap.

---

# APPLIED — 14 Sep 2026, from the cloud session

§4 was applied directly rather than run as a prompt on the Mac, at Sophea's request. Changes,
uncommitted, in the working tree:

- `app/components/BrandButton.tsx` (+9) — `target?: string` on the props, threaded onto the `<a>`
  branch only, with `rel="noopener"` when it is set.
- `app/routes/app.billing.tsx` (−57/+26) — both `<form method="post">` blocks replaced with
  `BrandButton` links carrying `href={hostedPlanUrl} target="_top"`; `export const action` and the
  `ActionFunctionArgs` import deleted. The loader, including `recordPlanHandle`, is untouched.

Verified here: `npx tsc --noEmit` clean. `npm test` and `npm run lint` **could not be run** — they
fail over the device bridge with `MODULE_NOT_FOUND` in `rollup/dist/native.js` and
`unrs-resolver/index.js`, because `node_modules` holds macOS-arm64 binaries and the bridge shell is
a Linux VM. This is the known limitation already recorded in the project status doc, not a
regression. **Run `npm test`, `npm run lint` and `npm run build` on the Mac before committing.**

§3's shopify-dev-mcp verification was **not** performed — the MCP server is registered on the Mac
only. The `target="_top"` anchor is the standard pattern for leaving an embedded app frame and the
change is small and reversible (`/tmp/BrandButton.bak`, `/tmp/app.billing.bak`), but rule 1 was not
satisfied. Confirm it on the Mac when convenient.

Still open, and still the reason a merchant cannot actually pay: the three public plans do not
exist and the app is on manual pricing. See `GATE-6-PARTNER-DASHBOARD.md`.
