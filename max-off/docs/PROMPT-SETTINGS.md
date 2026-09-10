# Prompt — build Settings (`app/routes/app.settings.tsx`)

**Written:** 10 Sep 2026 · **Run this in Claude Code on the Mac**, where `shopify-dev-mcp` is
available (CLAUDE.md rule 1). Fifth in the series, after Home, the list, Create and Test a cart —
all built and committed.

Read `CLAUDE.md`, then BUILD-SPEC **§3.1, §4.7, §5, §6, §11**. Open `docs/MaxOff-mockup.html` at
Settings. Do not edit the mockup.

The smallest screen so far, and the one carrying the most already-broken assumptions. Three
controls on it currently do nothing, and one of them is silently wrong on every non-USD store.
**§2 is the real work — read it before you write any markup.**

---

## 0 · What you are building on

- `ShopSettings` in Prisma: `shop`, `currencyCode`, `rounding`, `defaultCheckoutNote`, `plan`,
  `updatedAt`, plus the four setup-guide fields.
- `getHomeData` upserts the `ShopSettings` row, so one always exists by the time Settings loads.
  Reuse that upsert rather than writing a second one.
- Create already reads `settings.defaultCheckoutNote` and `settings.currencyCode`, and Test a cart
  writes the `lastCartTest*` fields. Settings is the other half of that contract — changing a value
  here must change what those screens do.
- Scopes are now `write_discounts, read_discounts, read_products`.
- Verified tags: the earlier set plus `s-modal`, `s-choice-list`, `s-choice`, `s-number-field`,
  `s-money-field`, `s-date-field`, `s-text-field`, `s-checkbox`, `s-select`, `s-option`,
  `s-thumbnail`, `s-divider`.

---

## 1 · What is actually wired today

| Field | Read by | Written by |
|---|---|---|
| `defaultCheckoutNote` | Create (`app.discounts.new.tsx:52`) | nothing |
| `currencyCode` | Home, the list, Create, Test a cart — **every amount in the app** | nothing |
| `rounding` | **nothing at all** | nothing |
| `plan` | Home's badge and setup step 4, the Free-plan limit | nothing |

Settings is where three of those four get a writer. `rounding` is the exception — see §2b.

---

## 2 · Three things the mockup gets wrong

**a · The currency select is the wrong control, and the default is wrong today.**
`ShopSettings.currencyCode` defaults to `"USD"` and nothing ever asks Shopify what the store's
currency actually is. So a merchant on a EUR store currently sees `150.00 USD` on every screen in
MaxOff. That is live, and Settings is where it gets fixed.

Making it a select does not fix it — it lets MaxOff hold a currency the store does not use, and
CLAUDE.md rule 5 says amounts **relabel, they never convert**. Worse, each discount's `cap_config`
metafield carries its own `currencyCode`, written at create time. Change the select and existing
metafields still say the old code, so the list shows `150.00 EUR` for a discount Shopify recorded
as USD. Nothing converts, nothing warns, and the two never reconcile.

*Recommended:* read the store's currency from Shopify (`shop { currencyCode }`), store it on
`ShopSettings` as a cache, and render it **read-only** with a line saying MaxOff follows the store
currency and that maximums relabel rather than convert. Refresh it on load. Verify the query and
its scope in §3 — if it needs a scope we do not have, say so and stop rather than adding one.

If Sophea wants the select kept editable, then changing it must rewrite `currencyCode` in every
existing discount's metafield in the same action, behind a confirmation naming how many discounts
will change. Do not ship the select without one of those two behaviours.

**b · The rounding select changes nothing at checkout.** Nothing reads `ShopSettings.rounding`.
`cap_config` has no rounding field, so the Function never learns the merchant's choice, and
`extensions/max-off-cap/src/cap.ts` hard-codes a single half-up rounding — which is also what §6
locks: "half-up to the cent, applied once". "Down to the whole unit" is not implemented anywhere.

A live-looking select that silently does nothing to real money is worse than no select: it is the
kind of thing that gets caught in App Store review, and it is a straight trust problem if a
merchant ever relies on it.

*Recommended:* render it **disabled**, showing "To the cent (recommended)", tagged the way the
other V2 affordances are (rule 6: visible disabled affordance, never working code). Doing it
properly is a four-part change — a field in `cap_config`, a Function that reads it, new §8 test
cases, and a version decision for discounts written before it existed — and that is its own gate,
not a select on a settings page.

**c · The email-alert checkboxes are drawn pre-checked.** Two of the three are ticked in the
mockup, which tells the merchant a weekly summary is being sent to their address. Nothing sends
anything. Render all three **unchecked and disabled**. A disabled control that claims an inactive
feature is on is a lie the merchant only discovers by not receiving the email.

---

## 3 · Verify before you write (shopify-dev-mcp, rule 1)

1. The Admin GraphQL query for the shop's currency, and the scope it requires. If it needs one we
   do not have, stop and report.
2. Whether `shopify.app.toml`'s `[discount.metafields.app.cap_config]` definition constrains what
   Settings may write — it should not, but confirm before assuming.
3. Tags not yet proven: whatever Polaris uses for a description list / key-value panel (the "How
   MaxOff runs" rows), and confirm the save bar pattern Create used applies here unchanged.

If the MCP server is unavailable, stop and say so.

---

## 4 · The page (§4.7)

Title "Settings", subtitle "How MaxOff behaves in your store." Contextual save bar, same pattern
as Create. Cards in this order:

1. **Checkout wording** (V2, disabled) — the note field showing `defaultCheckoutNote`, hint
   "Used for new discounts. You can override it on any single discount." Disabled, so the value
   never changes in V1, but keep it reading from `ShopSettings` so enabling it later is a one-line
   change. Do not hard-code the string here — Create already reads it from the same row, and two
   sources for one sentence is how they drift.
2. **Currency and rounding** (V1) — per §2a and §2b: currency read-only from the store, rounding
   disabled. Keep the PRO nudge banner: "Selling in several currencies? **Set a maximum per
   market** instead of converting one number." Say plainly, in one line, that maximums relabel and
   are never converted (§6, rule 5) — this card is the natural home for that fact.
3. **Email alerts** (V2, disabled, all unchecked) — weekly summary, expiry warning, big-cap alert.
4. **How MaxOff runs** (V1) — the transparency panel, and §4.7 says explicitly: *do not cut it*.
   Rows: Engine (Shopify Function · discount · Active pill) · Storefront code ("None. MaxOff adds
   nothing to your theme.") · Where caps are stored ("On the discount itself, in your Shopify
   store.") · If you uninstall — the locked §11 string: "Capped discounts stop capping and can be
   deleted from Shopify's own Discounts page. Nothing is left behind in your theme."

   **The Active pill must be real, not decoration.** Home has `CAP_ENGINE_DEPLOYED` as a local
   constant in `app._index.tsx`. Move it to `app/lib/cap.ts` and import it in both places, so the
   two screens cannot disagree about whether the engine is running. Two hard-coded truths in two
   files is exactly what this codebase has been avoiding.

---

## 5 · Saving

One action, one `ShopSettings` update. Validate server-side; a disabled field must not be writable
just because a client posted it — accept only the fields V1 actually allows to change, and ignore
the rest rather than trusting the form.

Given §2a and §2b, V1 may end up with **nothing editable on this page**. That is a legitimate
outcome and worth saying out loud in the build log — the screen still earns its place as the
transparency panel and the place currency stops being wrong. If so, drop the save bar rather than
shipping one that can never activate.

---

## 6 · Verification — report each in one line

1. `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` all clean.
2. On the dev store, confirm the currency shown matches the store's real currency in Shopify
   admin — and if the dev store is USD, temporarily switch it or explain how you verified a
   non-USD store, because "USD looks right" proves nothing here.
3. Confirm the same currency then appears on Home, the list, Create and Test a cart.
4. Confirm the rounding select and all three email checkboxes are disabled, unchecked where
   applicable, and post nothing when the form is submitted.
5. Confirm the Active pill reflects the shared constant — flip it to `false` locally and check
   that both Settings and Home's banner change together.
6. Confirm the uninstall row matches §11 word for word.
7. Post a crafted form that tries to change `rounding` and `plan` directly; confirm the server
   ignores both.
8. Keyboard pass: every control labelled, disabled controls skipped or announced as disabled,
   focus visible.

Commit as `feat(settings): store settings and the transparency panel`. If you move
`CAP_ENGINE_DEPLOYED`, that is its own small commit (rule 8). Then append a `docs/BUILD-LOG.md`
entry: the three §2 decisions, whether anything ended up editable, and how you verified the
currency on a non-USD store.
