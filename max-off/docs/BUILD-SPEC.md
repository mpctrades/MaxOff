# MaxOff — build specification

**Owner:** Sophea (devteam01@mpctrades.com) · **Reviewer:** Arthur · MPC Trades
**Status:** v1 spec, 3 Sep 2026 · **Reference UX:** `docs/MaxOff-mockup.html`

This document is the contract. If the code and this document disagree, one of them is a bug —
say which, and ask. If this document and `docs/MaxOff-mockup.html` disagree, the mockup wins on
layout and wording; this document wins on data, logic, and scope.

---

## 1. The product in one page

A merchant on Shopify can create "15% off". They cannot create "15% off, but never more than
$150". On a 4,000 order, 15% gives away 600. MaxOff stops it at 150.

```
given   = min(subtotal × pct/100, cap)
kept    = (subtotal × pct/100) − given
breakEven = cap ÷ (pct/100)        // the cart size where the cap starts to bite
```

Three numbers drive the entire UI:

| Number | Merchant-facing name | Where it appears |
|---|---|---|
| `given` | "Discount given" | create preview, cart tester, checkout preview, detail table |
| `kept` | "Money you kept" | home tile, analytics, detail, every preview footer |
| `breakEven` | "Cap starts above" | create form hint, list column, detail banner, cart tester |

`breakEven` is the differentiator. No competitor surfaces it. It turns an abstract setting into
a sentence the merchant understands: *"below 1,000 nothing changes; above it, you are protected."*

### Positioning

The idea is a **ceiling** — something rising and being stopped by a hard line. It is not
"biggest sale in town". Avoid coupon clichés in any asset: price tags, scissors, sale stickers,
giant % signs.

---

## 2. Scope: V1 / V2 / PRO

The mockup tags every feature. Toggle "Show build phase tags" in the prototype's top strip to see
them. **Build only V1.** V2 and PRO appear in the UI as visible but disabled controls, or as a
one-line upsell — never as working code.

### V1 — the eight-week build

1. Create a capped percentage discount (code method) — percentage, maximum, whole-order scope.
2. The Shopify Function that enforces the cap at checkout.
3. List of capped discounts with status, pause/activate, search, status tabs.
4. Detail page per discount with money-kept figures.
5. Live preview on the create form (slider + bars + "cap starts above" hint).
6. Cart tester — build a basket, see with/without MaxOff side by side.
7. Money-kept reporting: home tiles, weekly chart, analytics table.
8. Setup guide (4 steps) and empty states.
9. Minimum requirements, customer eligibility, usage limits, combinations, active dates.
10. Currency + rounding settings, "How MaxOff runs" transparency panel.
11. Billing: Free / Growth 4.99 / Pro 9.99, flat, no revenue share.

### V2 — after launch, do not build now

Automatic discounts (no code) · custom checkout wording · campaign budget cap ("stop the code once
it has given away a total of…") · email alerts · specific collections/products · templates on the
create form · CSV export.

### PRO — paid tier, do not build now

Per-item and per-collection maximums · a different maximum per market currency · CSV export ·
12-month history · priority support.

**How to render a non-V1 feature:** show the control, disable it, and attach the badge. In the
mockup these are `<span class="tag v2">V2</span>` / `<span class="tag pro">PRO</span>`. In the app,
use a Polaris badge with tone `info` (V2) or `warning` (PRO). Clicking a PRO control shows a toast:
`"Per-item maximums are a Pro feature"`.

---

## 3. Architecture

```
Merchant (Shopify admin)
        │  embedded app, App Bridge
        ▼
React Router 7 admin  ──GraphQL Admin API──▶  Shopify
  app/routes/*                                  │  discount node + our metafield
  Prisma (our tables)                           ▼
        ▲                            Shopify Function (Rust/JS in extensions/)
        │  orders webhook              runs at checkout, applies min(pct, cap)
        └──────────────────────────────────────┘
```

### 3.1 Where the cap lives

The cap configuration is stored **on the Shopify discount itself**, in an app-owned metafield, so
that the Function can read it at checkout without a network call. Our Prisma tables are a mirror
for listing, search, and analytics — **Shopify is the source of truth**, our DB is a cache.

Expected metafield (verify namespace/key rules with `shopify-dev-mcp` before implementing):

```
namespace: "$app:maxoff"
key:       "cap_config"
type:      "json"
value:     {
  "version": 1,
  "percentage": 15,
  "capAmount": "150.00",
  "currencyCode": "USD",
  "scope": "order",
  "checkoutNote": "Discount capped at maximum amount"
}
```

### 3.2 The Function

Generate with `npm run generate` (`shopify app generate extension`) and pick the discount template.
Name it `max-off-cap`.

Expected target: `cart.lines.discounts.generate.run`, returning discount operations with a
candidate whose value is a percentage, constrained by the cap. **Verify all of this against the
live schema before writing a line** — `introspect_graphql_schema` on the Function API, and
`search_docs_chunks` for "discounts allocator" and "maximum discount amount".

Three things the Function must get right:

1. It reads the cap from the discount's metafield. No hard-coded numbers after week 2.
2. It computes in **minor units (integers)**. Rounding to the cent, half-up, once, at the end.
3. When combined with another discount, MaxOff caps **only its own share**. It never inspects or
   reduces another app's or Shopify's discount. This is stated to the merchant in the create form
   and must be true.

If the Function cannot express the cap, the fallback is *not* "compute it in the app" — there is
no safe way to do that at checkout. The fallback is to escalate to Arthur.

### 3.3 Access scopes

The template ships with `write_products,write_metaobjects,write_metaobject_definitions` — those are
demo scopes and must be removed. MaxOff needs:

- `write_discounts`, `read_discounts` — create, update, pause, delete capped discounts.
- `read_orders` — **only** for the money-kept analytics.

`read_orders` is protected customer data and requires an approved reason in the Partner Dashboard.
Raise this with Arthur at Demo 2, not at Demo 4. If approval is a problem, the fallback for V1 is
to report money kept from discount usage counts only, and mark the order-level table as V2.

Also delete the template's `[product.metafields.app.demo_info]` and `[metaobjects.app.example]`
blocks from `shopify.app.toml`, and the demo product-creation action in `app/routes/app._index.tsx`.

### 3.4 Data model (Prisma)

Keep `Session` exactly as the template has it. Add:

```prisma
model CappedDiscount {
  id                String   @id @default(cuid())
  shop              String
  discountGid       String   @unique      // gid://shopify/DiscountCodeNode/…
  method            String                // "code" | "automatic"   (V1: always "code")
  code              String?
  title             String?
  percentage        Int                   // whole percent, 1–100
  capMinor          Int                   // cap in minor units, e.g. 15000
  currencyCode      String                // "USD" | "EUR"
  scope             String   @default("order")   // "order" | "item" | "collection" (V1: order)
  checkoutNote      String?
  startsAt          DateTime
  endsAt            DateTime?
  status            String                // "active"|"scheduled"|"paused"|"expired"
  usageLimit        Int?
  oncePerCustomer   Boolean  @default(true)
  combinesShipping  Boolean  @default(true)
  combinesProduct   Boolean  @default(false)
  combinesOrder     Boolean  @default(false)
  timesUsed         Int      @default(0)
  keptMinor         Int      @default(0)   // running total, denormalised for the list
  givenMinor        Int      @default(0)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  events            CapEvent[]
  @@index([shop, status])
}

model CapEvent {
  id                 String   @id @default(cuid())
  shop               String
  cappedDiscountId   String
  discount           CappedDiscount @relation(fields: [cappedDiscountId], references: [id], onDelete: Cascade)
  orderGid           String   @unique
  orderName          String                // "#1042"
  subtotalMinor      Int
  uncappedMinor      Int                   // what the raw percentage would have given
  givenMinor         Int
  keptMinor          Int
  occurredAt         DateTime
  @@index([shop, occurredAt])
}

model ShopSettings {
  shop                String   @id
  currencyCode        String   @default("USD")
  rounding            String   @default("cent")   // "cent" | "down"
  defaultCheckoutNote String   @default("Discount capped at maximum amount")
  plan                String   @default("free")   // "free" | "growth" | "pro"
  updatedAt           DateTime @updatedAt
}
```

`keptMinor` on `CappedDiscount` is a denormalised sum of its `CapEvent`s, updated in the webhook
handler. Recompute it, never increment blindly, if you ever backfill.

### 3.5 Webhooks

Keep `app/uninstalled` and `app/scopes_update` from the template. Add `orders/paid` (not
`orders/create` — we want money actually taken). Handler:

1. Find our discount by code/gid among the order's discount applications.
2. `uncapped = round(subtotal × pct/100)`; `given` = what Shopify actually applied.
3. If `uncapped > given`, write a `CapEvent` with `kept = uncapped − given`.
4. Update the `CappedDiscount` totals.

Handlers must be idempotent — `orderGid` is unique, so a duplicate delivery is a no-op.

### 3.6 Billing

Use **Shopify Managed Pricing** (plans configured in the Partner Dashboard) unless it cannot
express the tiers; it removes almost all billing code and it is what review expects in 2026.
Confirm the current recommendation via `shopify-dev-mcp` first.

| Plan | Price | Limits enforced in code |
|---|---|---|
| Free | 0 | 1 active capped discount · order scope only · "Powered by MaxOff" note at checkout |
| Growth | 4.99/mo | unlimited discounts · dates · analytics · custom wording |
| Pro | 9.99/mo | + per-item / per-collection caps · per-market currency · CSV export · 12-month history |

Flat monthly. **No transaction fee, no revenue share, ever** — this is a positioning promise and
appears on the billing page as such. Charged through Shopify with the merchant's bill.

The only limit enforced in V1 code is Free = 1 active capped discount. The rest are gates on V2/PRO
features that do not exist yet.

---

## 4. Screens

Eight screens, all in `docs/MaxOff-mockup.html`. Open it and look at the screen before building it.
Routes use flat-route file naming.

| # | Screen | Route file | Path |
|---|---|---|---|
| 1 | Home | `app._index.tsx` | `/app` |
| 2 | Capped discounts | `app.discounts._index.tsx` | `/app/discounts` |
| 3 | Create | `app.discounts.new.tsx` | `/app/discounts/new` |
| 4 | Detail | `app.discounts.$id.tsx` | `/app/discounts/:id` |
| 5 | Analytics | `app.analytics.tsx` | `/app/analytics` |
| 6 | Test a cart | `app.test.tsx` | `/app/test` |
| 7 | Settings | `app.settings.tsx` | `/app/settings` |
| 8 | Plans & billing | `app.billing.tsx` | `/app/billing` |

App nav in `app/routes/app.tsx` (`<s-app-nav>`): Home · Capped discounts · Create new · Analytics ·
Test a cart · Settings · Plans & billing. Replace the template's "Additional page" link and delete
`app.additional.tsx`.

### 4.1 Home

- Page title `MaxOff` with a plain badge showing the current plan. Subtitle:
  "Percentage discounts that stop at a maximum amount."
- Header actions: "Test a cart" (secondary), "Create capped discount" (primary).
- Success banner: **"Cap engine is running"** — "Your cap is applied by Shopify at checkout on N
  active discounts. No theme code was added to your store." Action: "Run a test cart".
  If the Function is not deployed or no discount is active, show the equivalent warning state.
- **Setup guide**, 4 steps, dismissible/collapsible, with a progress bar:
  1. Install MaxOff · 2. Create your first capped discount · 3. Test it on a big cart ·
  4. Choose a plan. Each completed step shows a one-line result underneath
  (e.g. "SUMMER15 — 15% off, capped at 150.00 USD"). Hide the whole card once all four are done.
- **Four stat tiles**, the first one branded:
  1. "Over-discounting avoided · this month" + delta vs last month
  2. "Orders capped" — `N of M discounted orders`
  3. "Active capped discounts" — with "1 scheduled, 1 paused" underneath
  4. "Biggest single save" — with the order number and code
- **Money you kept** card: 8-week bar chart, tallest bar highlighted and labelled, tooltip on hover.
  Subtitle: "Difference between the uncapped discount and what MaxOff actually gave away."
- **Your capped discounts**: active discounts only, columns
  Code · Discount · Maximum · Cap starts above · Used · Kept · Status. "View all" links to the list.
- Empty state for a brand-new install: no tiles, no chart — one card that explains the product and
  a single primary button "Create capped discount".

### 4.2 Capped discounts (list)

- Title "Capped discounts", subtitle "Every percentage discount with a maximum amount."
- Tabs: All · Active · Scheduled · Paused · Expired.
- Search by code. Filters for Method and Cap type are V2 — render disabled.
- Columns: checkbox · Code (monospace, links to detail) · Discount · Maximum ·
  Cap starts above · Used · Kept (brand colour, bold) · Status pill · row action Pause/Activate.
- Pause/activate is optimistic in the UI, then confirmed by the mutation; on failure, revert and
  toast the error. Toast text: `"SUMMER15 paused"` / `"SUMMER15 activated"`.
- Export button → toast "Export is a Pro feature".
- Empty state per tab: "No discounts here yet" / "When a capped discount reaches this state it will
  show up here." + primary "Create capped discount".

### 4.3 Create

Two columns: form on the left, sticky Summary + (V2) Templates on the right. A contextual save bar
(`shopify.saveBar` from App Bridge) with "Discard" and "Save & activate".

Cards, in this order:

1. **Method** — segmented control: "Discount code" (V1) / "Automatic discount" (V2, disabled).
   Code field, uppercase, with a "Generate" button.
2. **Value and maximum** — "Percentage off" (`%` suffix, 1–100) and "Maximum discount"
   (currency suffix). Below both, the live hint, rendered from real numbers:
   > At **15%**, the maximum of **150.00 USD** starts working on carts above **1,000.00 USD**.
   > Smaller carts get the full percentage.

   Then "The maximum applies to": The whole order (V1) · Each item (PRO) · Each collection (PRO).
3. **Applies to** — All products (V1) · Specific collections (V2) · Specific products (V2).
4. **Minimum requirements** — none / minimum amount / minimum quantity.
5. **Customers and usage limits** — eligibility select; limit total uses (with number field);
   one use per customer; campaign budget cap (V2, disabled).
6. **Combinations** — product / order / shipping discount checkboxes, plus the info banner:
   "When discounts are combined, the maximum still holds. MaxOff caps its own share only — it never
   touches the other discount."
7. **What the customer sees** (V2) — checkout note field, 60 chars.
8. **Active dates** — start date/time, optional end date/time.
9. **Live preview** (V1, the centrepiece) — a cart-total slider 50→3000, quick chips
   200 / 800 / 1,400 / 2,500, and:
   - big number = the discount given, in brand colour
   - next to it: `instead of ~~210.00 USD~~ — the maximum stopped it.`
     or `the full 15% — still under your maximum.`
   - two bars, "Without a cap" (muted red) and "With MaxOff" (brand), scaled to the larger value
   - footer line: "You keep 60.00 USD on this order." or
     "This cart is below 1,000.00 USD, so the maximum does not apply yet."
   - a "See checkout view" button opening the checkout preview modal
10. **Summary** (right column, sticky) — Code, Type ("Percentage, capped"), Value, Maximum,
    Cap starts, Applies to, Customers, Combines, Active dates. Updates as you type.

All preview maths is client-side and instant — no round trip. Save writes to Shopify, then mirrors
to Prisma, then toasts `"SUMMER15 is live at checkout"` and navigates to the list.

Validation: percentage 1–100 integer; maximum > 0; end after start; code unique in the shop
(check on blur against Shopify). Show errors on the field, not in a banner.

### 4.4 Detail

- Monospace code as the title; subtitle
  "15% off · maximum 150.00 USD per order · cap starts above 1,000.00 USD".
- Status pill + Pause / Duplicate / Edit actions.
- Four tiles: Money kept (branded) · Times used (of limit) · Orders that hit the cap (with %) ·
  Average order with this code.
- Info banner: "Your cap starts working above 1,000.00 USD" — "Below that, customers get the full
  15%. 21% of orders using this code went over — that is where your 612.40 USD came from."
- Weekly money-kept chart for this discount.
- Table "Recent orders where the cap applied": Order · Date · Cart · "15% would be" (struck
  through) · Given · Kept.

### 4.5 Analytics

Range chips 7 / 30 / 90 days, and 12 months (PRO, disabled). Four tiles: Money kept · Orders capped ·
Average kept per capped order · **Subscription cost, with "paid back 248×"** — that last tile is the
retention argument, keep it. Weekly chart, then a per-code table:
Code · Rule · Uses · Hit the cap · Given away · Kept. Export CSV is PRO.

### 4.6 Test a cart

Left: an editable basket (line items with +/− quantity, "Add product") and a discount picker
showing `SUMMER15 — 15% max 150.00 USD`, with the rule spelled out underneath.
Right, sticky: two stacked results — "Without MaxOff" (plain) and "With MaxOff" (branded panel)
showing discount given and what the customer pays, then the kept line, then a button
"See the buyer's checkout" opening the modal.

In V1 this may run on a seeded sample basket rather than real store products; if you can load real
products cheaply from the Admin API, do that instead and say so.

### 4.7 Settings

- Checkout wording (V2, disabled input showing the default).
- Currency and rounding (V1) — store currency select, rounding select ("To the cent (recommended)"
  / "Down to the whole unit"), plus the PRO nudge banner about per-market maximums.
- Email alerts (V2, disabled) — weekly summary, expiry warning, big-cap alert.
- **How MaxOff runs** (V1) — a plain-language transparency panel. Rows: Engine (Shopify Function ·
  Active pill) · Storefront code ("None. MaxOff adds nothing to your theme.") · Where caps are
  stored ("On the discount itself, in your Shopify store.") · If you uninstall ("Capped discounts
  stop capping and can be deleted from Shopify's own Discounts page. Nothing is left behind in your
  theme."). This panel is a trust feature — do not cut it.

### 4.8 Plans & billing

The three plan cards from section 3.6, current plan outlined in brand colour, plus the banner
"MaxOff has kept 1,240.00 USD for you this month. That is 248× the subscription." and the footer
"Charged through Shopify with the rest of your bill. Cancel any time from your Shopify admin."

### 4.9 Checkout preview modal

Shared by the create form and the cart tester. Shows a buyer's-eye order summary: subtotal, the
discount line `SUMMER15 — 15% off (max 150.00 USD)  −150.00 USD`, the small note under it, shipping,
total. Then a banner: "Without a maximum this order would have given away **210.00 USD**. You kept
**60.00 USD**." — or, when under the cap, the neutral "This cart is under the maximum, so the buyer
gets the full 15%."

---

## 5. Visual language

Light mode only. No dark mode in V1.

| Token | Value | Use |
|---|---|---|
| `--orange` | `#c2410c` | brand text — kept amounts, links in brand context |
| `--orange-bright` | `#ea580c` | fills — progress bars, chart bars, badges, app icon |
| `--orange-soft` | `#fff2e8` | branded card and banner backgrounds |
| `--orange-line` | `#f8c39a` | 1px border on branded surfaces |
| black | `#141210` | the cap itself, in brand marks |

Everything else is Polaris. Green and red are reserved for status marks only — never decoration.
Numbers use tabular figures; discount codes are monospace.

**Build with Polaris web components**, not a re-implementation of the mockup's CSS. The mockup
defines layout, copy, and behaviour; Polaris defines the pixels. Where the two conflict, Polaris
wins — the app must look native inside the Shopify admin and must survive App Store review. Use
brand colour only in the places listed above; do not repaint Polaris chrome.

Charts: an inline SVG bar chart is enough — 8 bars, two gridlines, tallest bar labelled, the rest at
55% opacity, tooltip on hover. Do not add a charting library.

Accessibility is not optional: every control labelled, focus visible, the chart has a text
alternative, and colour is never the only signal.

---

## 6. Formatting rules

- Money: `1,234.50 USD` — two decimals, thousands separators, currency code after the number and a
  space. Not `$1,234.50`. The prototype uses `en-US` grouping for both USD and EUR; keep that.
- Percentages: whole numbers, `15%`.
- Dates: `10 Sep – 30 Sep 2026`.
- Rounding: half-up to the cent, applied once, on the final discount amount.
- When the store currency changes, every amount **relabels**. Nothing is converted. Say so in the
  settings copy.
