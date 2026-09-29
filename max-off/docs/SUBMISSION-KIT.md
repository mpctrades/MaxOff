# MaxOff — App Store submission kit

Draft for Sophea to review. Nothing here has been submitted or pasted anywhere.

Every claim below is something the app does today. The sources are
`app/lib/plans.ts` (every capability there is `built: true`) and the live Plans
& billing screen. Money-kept reporting is deliberately absent: it needs
`read_orders`, which MaxOff does not request, and the website now labels it
"Coming soon".

---

## 1. Test instructions for reviewers

Paste into **Partner Dashboard → Distribution → App Store listing → Testing
instructions**. Fill in the two bracketed items first.

> MaxOff puts a maximum on a percentage discount: "15% off, but never more
> than 150." It runs as a Shopify Function, so it adds nothing to the theme.
>
> **Dev store:** maxoff-s7fqtwdd.myshopify.com
> **Storefront password:** [add the store's storefront password]
>
> **1. Create a capped discount**
> 1. Open MaxOff from Apps in the Shopify admin.
> 2. Choose **Create capped discount**.
> 3. Leave **Discount code** selected and enter a code, for example `REVIEW15`.
> 4. Enter **Percentage off: 15** and **Maximum discount: 150**.
>    The form shows "The maximum starts working above 1,000.00 USD".
> 5. Choose **Save & activate**. You return to **Capped discounts**, where the
>    new code is listed as Active.
>
> **2. See the cap in the app, before checkout**
> Open **Test a cart**, choose `REVIEW15`, and add products. The result panel
> shows what the buyer would pay, and whether the maximum applied.
>
> **3. See it applied at checkout**
> On the storefront, add products to the cart and enter `REVIEW15` at checkout.
> - A **1,400.00** subtotal gets **150.00** off, the maximum. 15% would have
>   been 210.00. The discount line reads "Discount capped at maximum amount".
> - A **700.00** subtotal gets **105.00** off, the full 15%, because it is below
>   the 1,000.00 where the maximum starts.
>
> **4. Pause, and plans**
> - In **Capped discounts**, choose **Pause** on the row. The code stops
>   applying at checkout; **Activate** turns it back on.
> - **Plans & billing** is in the app's navigation. The plan buttons open
>   Shopify's own plan page, and the plan is billed through Shopify.
>
> **Contact:** team@mpctrades.com

---

## 2. Listing copy draft

Character counts are checked, and every line uses the locked product phrases
where they fit. No exclamation marks.

**App name:** MaxOff

**Tagline** (limit 62; this is 51)
> Percentage discounts that stop at a maximum amount.

**Introduction** (limit 100; this is 95)
> 15% off, but never more than 150. Give the full percentage on small carts and cap the big ones.

**Details**
> Shopify can take 15% off an order, but it cannot stop at a maximum. On a
> large cart that percentage becomes a painful amount. MaxOff gives the full
> percentage on small carts and stops at your maximum on large ones. Before you
> save, it shows the cart size where the maximum starts working and what a
> buyer would pay, so you can set the cap with confidence. It runs as a Shopify
> Function at checkout: MaxOff adds nothing to your theme, and when discounts
> combine it caps only its own share.

**Feature bullets**
> - A maximum on any percentage discount, for codes and automatic discounts
> - Shows where the cap starts, with a live preview and a cart tester
> - A maximum on the whole order, or per item and per collection on Pro
> - A different maximum per market currency on Pro, never converted
> - MaxOff adds nothing to your theme; it runs at checkout as a Shopify Function

**Pricing** (must match `app/lib/plans.ts` and the Partner Dashboard plans)

| Plan | Price (USD) | Includes |
|---|---|---|
| Free | $0 | 3 active capped discounts · maximum on the whole order · live preview and cart tester · start and end dates, up to 15 days per discount |
| Growth | $4.99 / month | 20 active capped discounts · discounts that run for as long as you like · a limit on the total number of uses · custom checkout wording |
| Pro | $7.99 / month | Unlimited active capped discounts · everything in Growth · a separate maximum per item and per collection · a different maximum per market currency · CSV export · priority support |

Do not list: money-kept reporting or dashboards, a campaign budget cap, or
anything about orders. None of those are built.

---

## 3. Screencast script (under 3 minutes)

| Time | Show | Say (optional captions) |
|---|---|---|
| 0:00–0:20 | Install from the listing, approve access, land on MaxOff Home | "MaxOff opens straight into the Shopify admin." |
| 0:20–1:00 | Create capped discount: code, 15%, maximum 150. Pause on the "maximum starts working above 1,000.00 USD" line and the live preview | "15% off, never more than 150. The cap starts above 1,000." |
| 1:00–1:40 | Storefront: 1,400.00 cart, apply the code, show 150.00 off and the "Discount capped at maximum amount" line | "The full 15% would have been 210. The buyer gets 150." |
| 1:40–2:00 | Same code on a 700.00 cart: 105.00 off | "Below 1,000 the buyer gets the full 15%." |
| 2:00–2:20 | Capped discounts: Pause the code, show it paused | "One click stops it at checkout." |
| 2:20–2:45 | Plans & billing: the three plans in USD, a plan button opening Shopify's plan page | "Billed through Shopify. Change plan any time." |

Record on the dev store after deleting the MAXOFFTEST discounts, so the list is
clean.

---

## 4. Checklist of things only Sophea can do

- [ ] **App Pricing plans:** in the Partner Dashboard, create the three plans
      named exactly `Free`, `Growth` and `Pro`, at $0, $4.99 and $7.99 USD a
      month. The app maps plans by these names.
- [ ] **Distribution:** confirm it is **Public** (Shopify App Store).
- [ ] **Billing test** on the dev store: upgrade, downgrade, uninstall,
      reinstall, and choose a plan again. Check that Plans & billing shows the
      right plan each time.
- [ ] **Privacy policy URL** in the listing.
- [ ] **Support email:** `team@mpctrades.com` (the app's "Email
      team@mpctrades.com" links already use it).
- [ ] **App icon and screenshots.** Screenshots must not show money-kept
      figures.
- [ ] **Domain:** decide between `dev.maxoff.mpctrades.com` and
      `app.maxoff.mpctrades.com`. Changing it means updating `application_url`
      and `redirect_urls` in `shopify.app.toml` and the server's
      `SHOPIFY_APP_URL`. The listing and reviewers use whichever is live.
- [ ] **Storefront password** for the test instructions above.
- [ ] **Delete the test discounts** MAXOFFTEST1, 2 and 3 from Shopify's
      Discounts page.

### Open questions from the website review

- The FAQ says early-access stores "keep a discounted rate when we launch".
  Keep that promise, or remove it?
- The FAQ answer "What happens if I uninstall?" says the discounts "stay … as
  ordinary percentage discounts". The app's own Settings screen says capped
  discounts stop capping and can be deleted. Worth checking which is true on
  the dev store before a reviewer reads it.
