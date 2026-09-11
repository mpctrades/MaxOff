# Prompt — build Plans & billing (`app/routes/app.billing.tsx`)

**Written:** 10 Sep 2026 · **Run this in Claude Code on the Mac**, where `shopify-dev-mcp` is
available (CLAUDE.md rule 1). Sixth in the series; Home, the list, Create, Test a cart and
Settings are all built and committed.

Read `CLAUDE.md`, then BUILD-SPEC **§2, §3.6, §4.8, §5, §11**. Open `docs/MaxOff-mockup.html` at
Plans & billing. Do not edit the mockup.

Sophea wants this to follow the **Shuffly Plan page** pattern rather than the mockup's three
price cards — and that is the right call, because Shuffly's layout is already shaped around the
fact that Shopify, not the app, sells the plan. §4.8 says the same thing: *"This screen displays;
it does not transact."*

Note: `~/shuffly` on this machine holds only an empty `.git` with no working tree, so the pattern
below is taken from Shuffly's rendered UI, not its source. If a real Shuffly checkout exists,
reuse its managed-pricing redirect rather than re-deriving one — that is also project open
question 3.

---

## 0 · Three things that are broken before you start

**a · `ShopSettings.plan` is a local guess, and it is always `"free"`.** Nothing writes it. It
drives Home's plan badge, Home's setup step 4, and the Free-plan limit in
`app/models/discounts.server.ts:315`. So today every merchant is Free forever, including one who
pays. §4.8 is explicit: **read the current plan back from Shopify, never from a local guess.**
Fixing that is the main engineering in this screen; the cards are the easy part.

Keep the column as a cache written from Shopify's answer, the same shape as the currency fix in
Settings. Every read path should go through one function so no screen invents a plan.

**b · "Powered by MaxOff" at checkout is an unbuilt entitlement, and it is the only one a buyer
sees.** §3.6 lists it as a Free-plan limit enforced in code. Nothing implements it. The Function
builds the buyer message from `cap_config`, and `cap_config` carries no plan — the Function reads
only the discount's own metafield, so it cannot know what the merchant pays.

Enforcing it means adding a flag to `cap_config`, teaching the Function to append the note, and
**rewriting the metafield on every existing discount whenever the merchant changes plan** — a
plan change is then a write across N discounts, with partial-failure handling. Nobody has scoped
that. *Recommended:* do not build it now. Remove the "Powered by MaxOff note at checkout" line
from the Free card, raise it as its own gate, and say so in the build log. Do not leave the line
on the card while the code does nothing — a merchant paying to remove a note that was never there
is the worst version of this.

**c · Start and end dates are sold as Growth but ship to everyone.** Create renders the Active
dates card with no plan check. Either gate it or move it to the Free column — and decide now,
because taking a working feature away from Free merchants later is worse than never offering it.
*Recommended:* leave dates in Free (they are cheap and they make the Free tier genuinely useful),
and drop the line from the Growth card.

---

## 1 · The entitlement matrix — build this first

One module, `app/lib/plans.ts`, is the single source of truth. The billing cards render from it,
and every gate in the app reads from it. A feature list that is hand-written in the component is
how the page ends up promising something the code does not do.

| Capability | Free | Growth | Pro | State today |
|---|---|---|---|---|
| Active capped discounts | **1** | unlimited | unlimited | **enforced** |
| Maximum on the whole order | ✓ | ✓ | ✓ | built |
| Live preview and cart tester | ✓ | ✓ | ✓ | built |
| Start and end dates | ✓ | ✓ | ✓ | built, ungated — §0c |
| Money-kept dashboard and analytics | — | ✓ | ✓ | blocked on `read_orders` |
| Custom checkout wording | — | ✓ | ✓ | V2, unbuilt |
| A separate maximum on each item | — | — | ✓ | PRO, unbuilt |
| A separate maximum per collection | — | — | ✓ | PRO, unbuilt |
| Campaign budget — stop a code once it has given away a total | — | — | ✓ | PRO, unbuilt |
| A different maximum per market currency | — | — | ✓ | PRO, unbuilt |
| CSV export | — | — | ✓ | PRO, unbuilt (toast) |
| 12-month history | — | — | ✓ | PRO, unbuilt |
| Support | email | email | priority | not code |

Shape it so each entry carries both the entitlement **and** whether it is live:

```ts
{ key: "analytics", label: "Money-kept dashboard and analytics", plans: ["growth","pro"], built: false }
```

Then the cards can render unbuilt entitlements distinctly — Shuffly's **"INCLUDED NOW"** heading is
the honest framing to borrow, and it is exactly why that heading exists. Anything with
`built: false` either does not appear under "Included now" or appears clearly marked as coming.
Decide which and be consistent; do not mix.

Export the gate helpers from the same module — `activeDiscountLimit(plan)`, `can(plan, key)` — and
**refactor `discounts.server.ts:315` to use them** rather than its own `plan !== "free"` check.
Two definitions of the Free limit is the bug this module exists to prevent.

---

## 2 · Verify before you write (shopify-dev-mcp, rule 1)

1. **How to read the merchant's current plan** under Shopify App Pricing (the feature formerly
   called Managed Pricing) — the exact query, what it returns when the merchant is on no paid
   plan, and the scope it needs. This is §0a and the whole screen depends on it.
2. **The URL of Shopify's hosted plan-selection page** for an app, and how to build it for this
   shop. Do not recall a `/charges/<handle>/pricing_plans` shape from memory — confirm it, and
   confirm whether it should open in the same frame or via App Bridge navigation out of the
   embedded context.
3. Whether plan changes arrive as a webhook (`app_subscriptions/update` or similar) so the cache
   can be refreshed without polling. If one exists, note it — wiring it is a follow-up, not this
   commit.
4. Tags not yet proven: a progress/meter element for the usage bar, if Polaris has one.

If the MCP server is unavailable, stop and say so.

---

## 3 · The page — Shuffly's shape, MaxOff's content

Title "Plans & billing", subtitle "Flat monthly price. No transaction fees, no revenue share —
ever." (§3.6 positioning promise; keep it).

**Top card — the value line.** Shuffly leads with one real number and three reassurances. MaxOff's
equivalent headline: *"Keep more of every large order."* Then the number:
"MaxOff kept 1,240.00 USD for you this month."

**That number is blocked.** It comes from `CapEvent`, which is empty until `read_orders` is
approved. Do not print `0.00 USD` and do not invent it. When there are no cap events, drop the
sentence and the "That is 248× the subscription" line with it, and lead with what is true — the
count of active capped discounts, or nothing. The three ticks work regardless: **Cancel any time ·
Change plan instantly · Billed through Shopify**.

**Left card — "Your plan".** Plan name with an **IN USE** pill. For Free, a usage meter reading
`1 of 1 capped discounts used` — real, from the same count the limit uses. Growth and Pro are
unlimited, so no meter; show the active count as a plain line instead of a bar at 100%. Then
`Charged through — Shopify` and `Next charge`, both read from Shopify, omitted rather than guessed
if unavailable. Then **INCLUDED NOW**, rendered from `app/lib/plans.ts`.

**Right card — the upsell, contextual.** "Move to Growth" on Free, "Move to Pro" on Growth,
**nothing at all on Pro** — a card selling a plan the merchant already has is the tell that it was
hard-coded. Body: what the next tier *adds to their current plan*, not its whole feature list.
Then one primary button, **"View plans & pricing →"**, and beneath it: "Prices, free trials and
yearly billing are shown and handled by Shopify. Upgrades, downgrades and cancellations all take
effect there."

**Footer** — the locked §11 line, verbatim: "Charged through Shopify with the rest of your bill.
Cancel any time from your Shopify admin."

**Delete the mockup's buttons.** "Upgrade to Pro" and "Downgrade" as separate working controls are
wrong — §4.8 says so outright. One redirect, one destination. Log this as a sixth mockup defect
alongside §12's five.

Brand colour: the current-plan card outlined in `--orange-line`, consistent with how Home and the
list use brand. Do not repaint the Polaris cards.

---

## 4 · Verification — report each in one line

1. `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` all clean.
2. Unit-test `app/lib/plans.ts`: the Free limit is 1, Growth and Pro are unlimited, and `can()`
   agrees with the §1 table for every key on every plan.
3. On the dev store, confirm the plan shown comes from Shopify — not from `ShopSettings`. Prove it
   by setting `ShopSettings.plan` to `"pro"` by hand and confirming the page still shows the truth.
4. Confirm Home's badge and setup step 4 now follow the same source, and change together.
5. Confirm the Free limit still refuses a second active discount, now going through
   `activeDiscountLimit()` rather than the old inline check.
6. Click "View plans & pricing" and confirm it lands on Shopify's hosted page for this app.
7. Confirm the upsell card disappears on Pro. Force the plan to each of the three values and
   screenshot all three states.
8. Confirm no fabricated money: with an empty `CapEvent` table the kept sentence is absent, not
   zero.
9. Confirm the footer matches §11 word for word.
10. Keyboard pass: focus visible, the meter has a text alternative, the redirect reachable.

Commit as `feat(billing): plans screen reading the real plan from Shopify`. The `plans.ts`
extraction and the `discounts.server.ts` refactor are their own commit (rule 8). Then append a
`docs/BUILD-LOG.md` entry: the §0 decisions, what the plan read actually returns, the new mockup
defect, and anything you deviated on.
