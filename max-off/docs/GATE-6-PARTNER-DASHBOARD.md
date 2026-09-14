# Gate 6 — create the three plans in the Partner Dashboard

**For Sophea. This is not a coding task and no agent can do it.**
`MASTER-BUILD-PROMPT.md` line 107 assigns it to you: *"Create the three Managed Pricing plans in
the Partner Dashboard."* It has not been done, and until it is, nobody can buy anything.

Written 14 Sep 2026, after the billing buttons were reported dead. The dead button is a separate
code fault — see `PROMPT-BILLING-FIX.md`. **Both have to be fixed.** The code fault stops the
merchant leaving the app; this one means there is nothing to arrive at.

---

## 0 · What is actually wired up today

| Piece | State |
|---|---|
| Billing screen, plan cards, entitlement matrix | Built (`app/lib/plans.ts`, `app/routes/app.billing.tsx`) |
| Reading the merchant's plan from Shopify | Built (`app/models/plan.server.ts`) |
| Enforcing the limits (3 / 20 / unlimited, 15-day Free ceiling) | Built and enforced |
| The button that sends a merchant to Shopify's plan page | **Broken** — see `PROMPT-BILLING-FIX.md` |
| The three plans on Shopify's side | **Do not exist** — this document |

So the app is ready to sell three plans that Shopify has never been told about.

---

## 1 · Check this first — is MaxOff a public app?

Shopify App Pricing is **the billing system for public apps**. The docs are explicit that it is
"the default for new public apps", and that "all apps published on the Shopify App Store are
required to use a Shopify provided billing solution."

If MaxOff's distribution in the Partner Dashboard is still **Custom** or unset, you will not find a
pricing section to fill in, and that is the answer to "why doesn't the button work" rather than
anything in the code.

**Go and look:** `partners.shopify.com` → **Apps** → **MaxOff** → **Distribution**.

- If it says **Public distribution** → good, go to §2.
- If it says **Custom distribution**, or asks you to choose → **stop and talk to Arthur before
  picking.** On Shopify, an app's distribution type is chosen once and cannot be swapped
  afterwards, so this is not a setting to click through on a Friday afternoon. It is also a
  decision with a deadline attached: Gate 7 is App Store submission, which requires public
  distribution anyway.

While you are on that page, **write down the app handle.** You need it in §4, and the app's own
code needs it to build the plan-page URL.

---

## 2 · The three plans, exactly

The app maps a Shopify subscription back onto a MaxOff plan by **matching its name**
(`app/models/plan.server.ts`, `planFromLabel`). It accepts the plan key or the label,
case-insensitively, and nothing else.

**This makes the names below a hard constraint, not a preference.**

| Plan name — type it exactly | Handle | Price | Interval |
|---|---|---|---|
| `Free` | `free` | 0.00 USD | Monthly |
| `Growth` | `growth` | 4.99 USD | Monthly |
| `Pro` | `pro` | 7.99 USD | Monthly |

No trial days on any of them unless Arthur says otherwise — the Free plan *is* the trial, and it is
deliberately shaped that way (three discounts, each capped at 15 days).

### Why the exact name matters more than it looks

If a plan ends up called "MaxOff Pro", or "Pro plan", or "Pro (monthly)", the app cannot match it.
It does not fall back to Free — it falls back to **Growth**. A merchant paying 7.99 for Pro would
silently be given Growth features: no per-item caps, no CSV export, no priority support. They would
be charged correctly and served the wrong product, and the only record would be a warning in the
server log.

So: `Free`, `Growth`, `Pro`. Three words. Check the spelling before you save each one.

### Features listed on Shopify's page

Shopify's hosted page shows its own feature bullets per plan, which merchants read *instead of*
our cards at the moment they pay. Take the wording from `app/lib/plans.ts` — `planCard()` produces
exactly what our own cards show — so the two agree. If you write fresh copy here it will drift from
the app within a month, and the merchant sees the disagreement at the worst possible moment.

⚠️ **Do not list anything marked `built: false` in `plans.ts` as if it exists today.** As of now
that means analytics, custom checkout wording, per-item and per-collection maximums, campaign
budget, per-market currency, CSV export and 12-month history. Seven of the Pro card's bullets are
promises, not features. Selling them on Shopify's own checkout page is a different thing from
listing them on ours, and it is the kind of thing App Store review notices.

---

## 3 · Prices are in USD and that is a decision, not a default

`ShopSettings.currencyCode` defaults to USD and the billing card renders the price with the shop's
currency label beside it. App Pricing charges in the currency you set here. A merchant on a EUR
store will see "4.99 USD / month" on our card. That is honest, but confirm with Arthur that USD-only
billing is intended before you publish — it is much harder to change once merchants are subscribed.

---

## 4 · The return URL, so the app knows what they picked

After a merchant approves a plan, Shopify redirects them back to the app with a **`plan_handle`**
parameter on the URL. `app/routes/app.billing.tsx` already reads it in its loader and caches the
result, so no code is needed — only the setting.

In the Partner Dashboard, set the app's **welcome / redirect URL** so it lands on the billing page:

```
https://maxoff-dev.mpctrades.com/app/billing
```

Shopify appends `?plan_handle=growth&shop=…` itself. Do not add parameters by hand.

This matters because **App Pricing sends no webhook when a plan changes.** That redirect is the only
push the app ever gets; every other read is a poll. If the redirect URL is wrong, the app finds out
about the upgrade only the next time someone opens the billing page.

---

## 5 · Test it on the dev store

Development stores are not charged real money — subscriptions created on them are test charges. So
the full path is safe to walk end to end on `maxoff-s7fqtwdd.myshopify.com`.

Once the code fix from `PROMPT-BILLING-FIX.md` is in **and** the plans above exist:

1. Open MaxOff on the dev store → **Plans & billing**.
2. Click **Upgrade to Growth**. The whole window should leave the app and land on Shopify's plan
   page, showing all three plans with the right prices.
3. Approve Growth.
4. You should be returned to `/app/billing`, and the page should now show **Growth** as the current
   plan, with **Pro** recommended.
5. Go to **Capped discounts** and confirm you can now create more than three — the allowance is read
   from the same place the card is.
6. Check the server log for `active subscription "…" does not match a MaxOff plan`. If that line
   appears, the plan name in the Partner Dashboard is wrong — go back to §2.
7. Change down to Free from Shopify's page and confirm the app notices.

**Report back with step 2's URL and a screenshot of step 4.** Those two are what prove the loop is
closed; everything else in this document is setup for them.

---

## 6 · If you cannot do §1 yet

If distribution turns out to be a decision that has to wait for Arthur, the plans cannot be created
and the billing loop cannot be tested — the button will correctly reach an empty Shopify page.

Do **not** work around it by adding Billing API calls (`appSubscriptionCreate`). `BUILD-SPEC.md`
§3.6 records the reason: App Pricing "cannot coexist with Billing API plans", so a temporary
Billing API integration is not temporary — it is a migration, twice. Ship the button fix, leave the
destination empty, and note in the build log that Gate 6 is blocked on the distribution decision
rather than on any code.

---

# Appendix A — filling the submission form, field by field

Added 14 Sep 2026, from Sophea's screenshot of
`apps.shopify.com/services/partner-app-submissions/2054aaf833b91f2a63cd47e8663c88ac/en`.

**§1 is now answered: distribution is public.** The app-submission form exists, which means the
App Store listing is live as a draft. The pricing section reads **"0 public plans — At least one
plan is required"**. That is Gate 6, unstarted, exactly as diagnosed.

## A.1 · Create the plans, but do NOT submit the listing

These are two different buttons and only one of them is safe to press today.

**Do:** click **Manage** in the pricing section and create the three plans. Saving plans is what
unblocks the billing loop — it makes the hosted plan page real so the app can be tested end to end
against it.

**Do not:** submit the listing for review. MaxOff would fail, for reasons that have nothing to do
with pricing:

- The three mandatory GDPR webhooks (`customers/data_request`, `customers/redact`, `shop/redact`)
  do not exist. Gate 7.
- `app/routes/app.discounts.$id.tsx` — the discount Detail screen — is a 17-line stub. A reviewer
  will click into a discount.
- `read_orders` is unapproved, so three of Home's four tiles and its chart are empty.
- `application_url` still points at `maxoff-dev.mpctrades.com`.

A failed review is not free: it costs a re-review cycle and the notes follow the app. Create the
plans, leave the rest of the form as a draft.

## A.2 · The three plans

Display names must be **exactly** these three words — see §2 for why a wrong name silently
mis-grants entitlements.

### Free — 0.00 USD / month
> Three capped discounts, each running up to 15 days.

- 3 capped discounts at a time
- A maximum on the whole order
- Live preview and cart tester
- Start and end dates, up to 15 days per discount

### Growth — 4.99 USD / month
> For stores running more than one campaign at a time.

- 20 capped discounts at a time
- Discounts that run for as long as you like
- A limit on the total number of uses
- Everything in Free

### Pro — 7.99 USD / month
> Unlimited capped discounts.

- Unlimited capped discounts
- Everything in Growth

## A.3 · Why Pro's list is two lines, and what to do about it

Every other Pro bullet on the in-app card is `built: false` in `app/lib/plans.ts` — per-item
maximums, per-collection maximums, campaign budget, per-market currency, CSV export, 12-month
history, priority support. Seven bullets, none of which exist. Analytics and custom checkout
wording on the Growth card are unbuilt too.

Listing them here is different from listing them on our own page. Shopify's reviewer reads the
plan descriptions and then goes looking for the features, and "advertises functionality it does
not have" is a straightforward rejection.

So today, honestly written, **Pro is "Growth but unlimited" for three dollars more** — 20 discounts
against unlimited. That is a thin proposition and it is worth Arthur seeing it stated plainly
rather than discovering it after launch. Three ways out, his call:

1. **Ship Pro's features before submitting.** Per-item caps are the headline and need a
   `cap_config` scope beyond `order` plus a Function change. This is the intended path and it is
   what the eight-week plan already assumes.
2. **Launch with two plans.** Free and Growth only; add Pro when it has something to sell. Shopify
   needs at least one plan, not three. The app's `plans.ts` would need Pro removed from the ladder,
   which is a real change, not a copy edit.
3. **Keep three plans as drafts for testing now**, and settle the Pro question before submission.
   This is the recommended move and it is what A.1 describes — it unblocks the billing test without
   committing to the pitch.

Whichever is chosen, the in-app Pro card and the Shopify plan description must end up saying the
same thing. Right now they do not.

## A.4 · The rest of the fields on that screen

**"I have approval to charge merchants outside of the Shopify Billing API"** — leave **unchecked**.
MaxOff bills through Shopify App Pricing. Ticking it claims an exemption we neither have nor want,
and it contradicts §3.6.

**"Provide a URL where merchants can find more pricing information (optional)"** — leave **blank
for now.** The obvious candidate is the marketing site's pricing section, but that page currently
advertises Pro at 9.99 and a plan ladder of 1 / unlimited against the app's real 3 / 20 / unlimited.
Pointing Shopify's own listing at a page that contradicts the plans on the same screen is worse
than leaving an optional field empty. Fill it in after the site is rebuilt from
`maxoff-website-prompt.md`.

**App card subtitle (required, 62 characters)** — three options, all within the limit and none of
them generic marketing language:

| Subtitle | Chars |
|---|---|
| `Cap percentage discounts at a maximum amount` | 44 |
| `Put a maximum on any percentage discount` | 40 |
| `15% off, but never more than $150` | 33 |

The first is the safest: it says what the app does in the merchant's own words. The third is the
sharpest and is the line the whole product is built on, but it reads at a glance like an offer
rather than a capability, so it is a gamble in a search-results row. Do not use "best", "powerful"
or "easy" — Shopify's own guidance on that page rules them out.

---

# Appendix B — the "Add public plan" form, three times

Added 14 Sep 2026 from Sophea's screenshot of
`apps.shopify.com/services/pricing/2054aaf833b91f2a63cd47e8663c88ac/setup/new`.

**This supersedes §4 of this document.** §4 described the return URL as an absolute
`https://maxoff-dev.mpctrades.com/app/billing`. The real form takes a **path relative to the app
URL**, with a `/` already fixed at the left of the field. §4's intent was right; its format was
wrong.

## B.0 · Two fields on this form can never be changed

The form says so itself, under both of them:

> Plan name for merchant invoices — *Can't be changed later.*
> Internal plan handle — *Can't be changed later.*

The handle is what arrives as `plan_handle` on the redirect and what `planFromLabel` matches in
`app/models/plan.server.ts`. Getting it wrong cannot be corrected — the plan has to be deleted and
rebuilt, and any merchant already on it has to be moved. Type these three characters at a time and
read them back before saving.

## B.1 · Free

| Field | Value |
|---|---|
| Plan name for merchant invoices | `Free` |
| Internal plan handle | `free` |
| Redirect URL | `app/billing` (so it resolves to `/app/billing`) |
| Charge a monthly or yearly subscription fee | **unchecked** |
| Free for partners and developers | **unchecked** — see B.4 |
| Usage charges | none — see B.5 |

## B.2 · Growth

| Field | Value |
|---|---|
| Plan name for merchant invoices | `Growth` |
| Internal plan handle | `growth` |
| Redirect URL | `app/billing` |
| Charge a monthly or yearly subscription fee | **checked** → `4.99` USD, **monthly** |
| Free for partners and developers | **unchecked** — see B.4 |
| Usage charges | none |

## B.3 · Pro

| Field | Value |
|---|---|
| Plan name for merchant invoices | `Pro` |
| Internal plan handle | `pro` |
| Redirect URL | `app/billing` |
| Charge a monthly or yearly subscription fee | **checked** → `7.99` USD, **monthly** |
| Free for partners and developers | **unchecked** — see B.4 |
| Usage charges | none |

No yearly prices. §3.6 is a flat monthly promise and there is no yearly figure anywhere in
`plans.ts`; inventing one here would be a fourth price the app does not know about.

## B.4 · Why "Free for partners and developers" stays unchecked

The option lets partners and developers run the app on development stores **without subscribing**.
That sounds like exactly what a dev store wants, and it is the one setting that would quietly
sabotage the Gate 6 test.

The whole point of §5's test walk is to prove that
`currentAppInstallation.activeSubscriptions` returns something the app can read — the open question
`plan.server.ts` has been carrying since 10 Sep. If the dev store is exempted from subscribing,
there is no subscription, `getCurrentPlan` correctly reports Free, and we learn nothing. The bug we
are trying to rule out looks identical to everything working.

Development stores are not charged real money regardless — subscriptions created on them are test
charges. So leaving this unchecked costs nothing and is the only way the test means anything.

Unlike the name and the handle, this one **can** be changed later. Turn it on after Gate 6 closes
if partners need it.

## B.5 · No usage charges, ever

The form offers up to five usage meters. MaxOff uses none, and this is not an oversight to correct
later. §3.6: *"No transaction fee, no revenue share, ever"* — it is a positioning promise, it is
printed on the billing screen, and the marketing site builds a whole comparison row on it. A usage
meter is the thing that promise exists to rule out.

## B.6 · Order of operations — do not switch until all three exist

The blue banner on the form reads:

> This plan goes live to merchants when you switch from manual pricing to Shopify App Pricing.

So MaxOff is currently configured for **manual pricing** (the Billing API), and creating plans does
not activate them. There is a separate switch, and `BUILD-SPEC.md` §3.6 records why it is one-way
in practice: App Pricing *"cannot coexist with Billing API plans."*

1. Create **Free**, then **Growth**, then **Pro**. Save each.
2. Read all three back. Check the handles are `free`, `growth`, `pro` — lowercase, no spaces, no
   "maxoff-" prefix.
3. **Only then** switch the app from manual pricing to Shopify App Pricing.
4. Run the §5 test walk on the dev store.

Switching now is low-risk precisely because the listing is still a draft and nothing but the dev
store has MaxOff installed. That stops being true the day the listing is submitted, so this is the
cheap moment to do it.
