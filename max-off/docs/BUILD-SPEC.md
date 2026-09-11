# MaxOff — build specification

**Owner:** Sophea (devteam01@mpctrades.com) · **Reviewer:** Arthur · MPC Trades
**Status:** v1 spec, 3 Sep 2026 · corrected 4 Sep 2026 after API verification (§3.1, §3.2, §3.3,
§3.5, §3.6, §4, §4.3, §4.8, §9) · **Reference UX:** `docs/MaxOff-mockup.html`

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

Metafield (**corrected 8 Sep 2026 when Gate 2 built it** — the namespace is `$app`, not
`$app:maxoff`; see the two notes below. Shopify recommends a single JSON metafield for nested
config, which stands):

```
namespace: "$app"
key:       "cap_config"
type:      "json"
value:     {
  "version": 1,
  "percentage": 15,
  "capAmount": "150.00",
  "currencyCode": "USD",
  "scope": "order",
  "checkoutNote": "Discount capped at maximum amount",
  "code": "SUMMER15"
}
```

`code` was added in Gate 2. The Function's `Discount` type exposes only `discountClasses` and
`metafield`, so the metafield is the only way the Function can know the code — without it the
buyer-facing message cannot say `SUMMER15 — 15% off (max 150.00 USD)`. It is presentation only:
a discount with no `code` recorded still caps, and only loses the prefix.

Three mechanics that go with it, none of them obvious:

- The Function reads it with
  `discount { metafield(namespace: "$app", key: "cap_config") { jsonValue } }`.
- **The namespace is `$app`, not `$app:maxoff`.** `$app:maxoff` is legal in GraphQL, but the
  declarative TOML form that creates the definition is `[discount.metafields.app.<key>]`, whose
  namespace segment is documented only as `app` — i.e. `$app`. `shopify app config validate`
  accepts a quoted `"app:maxoff"` segment, but that is a shallow schema check and not proof that
  Shopify creates the definition there. `$app` is already private to MaxOff, and we store exactly
  one discount metafield, so the sub-namespace buys nothing. Do not reintroduce it without
  deploying a definition and reading it back.
- **`[extensions.input.variables]` is NOT needed, and must not be added.** The 4 Sep draft of this
  section said that block "is what lets the Function see the metafield". It is not: it populates
  *input query variables* (`query Input($collectionIds: [ID!])`) from a JSON metafield whose top
  level keys are variable names. Our input query passes `namespace` and `key` as literal
  arguments and declares no variables, so the block is inert at best — and actively wrong, since
  it would ask Shopify to read `percentage` and `capAmount` as query variables that do not exist.
- `shopify.app.toml` declares the definition in a `[discount.metafields.app.cap_config]` block —
  it goes exactly where the template's `[product.metafields.app.demo_info]` block is today, with
  `access.admin = "merchant_read"`: the merchant can see the cap on the discount, but only MaxOff
  writes it, so the Prisma mirror cannot drift from what the Function reads.

The metafield can be written **inline in the `discountCodeAppCreate` mutation** via its
`metafields` input. No separate `metafieldsSet` round trip on create.

### 3.2 The Function

**Verified against shopify.dev on 4 Sep 2026. The cap mechanism is confirmed — this is no longer
an open risk.**

Generate with `shopify app generate extension --template discount --name max-off-cap`.

Target: `cart.lines.discounts.generate.run`. Discount class: `ORDER`.

**How the cap is actually expressed.** There is no "percentage constrained by a maximum" in the
API. You do not hand Shopify a percentage and a ceiling. Instead the Function does the arithmetic
itself and returns the *result* as a fixed amount:

```
read pct + cap from the discount's metafield
subtotal = cart.cost.subtotalAmount.amount
given    = min(subtotal × pct / 100, cap)      // minor units, half-up, once
emit     orderDiscountsAdd {
           candidates: [{
             value:   { fixedAmount: { amount: given } },
             targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
             message: "SUMMER15 — 15% off (max 150.00 USD)"
           }],
           selectionStrategy: FIRST
         }
```

Two schema facts make this work, both confirmed on
`https://shopify.dev/docs/api/functions/2026-10/discount`:

- `OrderDiscountCandidateValue` is a union of exactly **`FixedAmount`** (`amount`, `currencyCode`)
  and **`Percentage`** (`value`). A fixed amount is legal on an `orderSubtotal` target.
- `cart.cost.subtotalAmount` is available in the input query, so the Function can see the cart
  total. Schema description: *"The amount, before taxes and cart-level discounts, for the customer
  to pay."*

This is not the same as a native fixed-amount discount. A native 150-off discount gives 150 on a
700 cart. Ours gives 105, because the fixed amount is recomputed from the percentage on every
checkout. It behaves like a percentage below break-even and like a ceiling above it.

**⚠ Do not use the Discounts Allocator.** Shopify publishes a tutorial — "Build a Discounts
Allocator Function" — that caps a discount from a `single_discount_cap` metafield and looks
exactly like our product. It is the wrong tool and must not be used:

- API version `unstable`, feature preview, **Shopify Plus merchants only**
- needs the `write_discounts_allocator_functions` scope
- Shopify's own warning: *"You're replacing the Shopify discount engine with the Discounts
  Allocator Function. Your Function will take precedence over most discount features that are
  built by Shopify."*

One allocator per shop, shop-wide, overriding every other discount including Shopify's own. That
breaks our combinations promise, excludes every non-Plus merchant, and cannot pass App Store
review on an unstable API. If you find that page mid-build and think "this is us" — it is not.

Four things the Function must get right:

1. It reads the cap from the discount's metafield. No hard-coded numbers after week 2.
2. It computes in **minor units (integers)**. Rounding to the cent, half-up, once, at the end.
3. It returns **no operations** unless `ORDER` is present in `discount.discountClasses`. Shopify's
   caution: *"Your Function should only return operations for discountClasses that the discount
   applies to."*
4. When combined with another discount, MaxOff caps **only its own share**. It never inspects or
   reduces another app's or Shopify's discount.

Point 4 is true **by construction**, not by care: *"All discount functions run concurrently, and
have no knowledge of each other."* Our Function cannot see another discount even if it wanted to.
Its candidate is then combined with the others *"in alignment with the combination and stacking
rules set on the discount node"* — i.e. by `combinesWith`, which the merchant controls on our
create form.

**Open question, to be answered by a real test in week 2 — not by reading.** The schema says the
subtotal is before *cart-level* discounts. It does not say whether it is before or after
*line-level* (product) discounts. So when a product discount is also on the cart, we do not yet
know whether our 15% is computed on the full 1,400 or on the already-reduced figure. Put a
combined-discount cart through checkout on the dev store, capture the Function input JSON, and
record the answer here. Do not guess, and do not defer this past week 2 — it is cheap now and
expensive in week 6.

### 3.3 Access scopes

The template ships with `write_products,write_metaobjects,write_metaobject_definitions` — those are
demo scopes and must be removed. MaxOff needs:

- `write_discounts` — create, update, pause, delete capped discounts. **Required.**
- `read_discounts` — **required** (corrected 10 Sep 2026, see below).
- `read_orders` — **only** for the money-kept analytics.

**Corrected 10 Sep 2026, when Gate 3 built the create form.** An earlier draft of this section
dropped `read_discounts` on the reasoning that "`write_discounts` covers our reads". It does not.
Validated against the live 2026-10 schema with `validate_graphql_codeblocks`:

| Operation | Required scopes |
|---|---|
| `discountCodeAppCreate` selecting only `userErrors` | `write_discounts` |
| `discountCodeAppCreate` selecting `codeAppDiscount { discountId }` | `write_discounts, read_discounts` |
| `discountCodeDeactivate` / `discountCodeActivate` selecting only `userErrors` | `write_discounts` |
| the same, selecting `codeDiscountNode` back | `write_discounts, read_discounts` |
| `codeDiscountNodeByCode(code:)` — the uniqueness check | `read_discounts` |
| `discountNode(id:)` — reading a discount or its metafield back | `read_discounts` |

`discountGid` is `@unique` on `CappedDiscount` and is how the `orders/paid` webhook finds our
discount, so we cannot avoid learning the id, and there is no narrower selection that returns it.
`read_discounts` is therefore in `access_scopes`, and adding it required a reinstall on the dev
store.

For the App Store version there is a gentler path worth considering: `shopify.scopes.request()`
opens a permission-grant modal for scopes declared as **optional** in the app config, which avoids
making an existing merchant reinstall. That is a pre-submission decision, not a V1 one. Fewer scopes is better at review — add it back only
if a read actually fails without it.

`read_orders` is protected customer data. **It is Level 1, not Level 2**, provided we never read
name, address, phone or email. Our webhook needs only order name, subtotal, discount applications
and a timestamp — so keep it that way, and say so explicitly in the Partner Dashboard request:

- **Level 1** — order data excluding name/address/phone/email. Request access in the Partner
  Dashboard, and implement the level 1 requirements (process the minimum data needed, tell
  merchants what you process and why, limit processing to the stated purpose).
- **Level 2** — adds name/address/phone/email, and pulls us into data protection reviews. We do
  not need this. Do not request it.

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

1. Find our discount among the order's discount applications, **matching by discount code**.
2. `uncapped = round(subtotal × pct/100)`; `given` = what Shopify actually applied.
3. Write a `CapEvent` with `kept = max(uncapped − given, 0)` for **every** order that used one of
   our discounts, not only the ones the cap bit. An order that stayed under the break-even point
   kept nothing and stores `kept = 0`; it is still a discounted order, and it is the only place
   the `M` in §4.1's "N of M discounted orders" can come from. "Capped" means `kept > 0`.
4. Update the `CappedDiscount` totals.

**Read `pct` from our own `CappedDiscount` row, never from the order.** Because the Function emits
a *fixed amount* (§3.2), the order records a fixed-amount discount application — the percentage
appears nowhere on the order. A handler that tries to infer the percentage from the order will be
silently wrong.

Handlers must be idempotent — `orderGid` is unique, so a duplicate delivery is a no-op.

Read only what §3.3 permits: order name, subtotal, discount applications, timestamp. No customer
name, address, phone or email — that is the line between Level 1 and Level 2 protected customer
data, and crossing it costs us a data protection review.

### 3.6 Billing

Use **Shopify App Pricing** — the feature formerly called Managed Pricing. **Verified 4 Sep
2026:** *"Shopify App Pricing is the default for new public apps and the recommended approach for
existing apps with supported pricing models."* Three flat recurring plans with no usage component
is squarely inside what it supports, and it removes almost all billing code.

Two consequences the rest of this spec has to respect:

- **Shopify hosts the plan selection page.** Merchants choose and change plans on a Shopify-hosted
  page inside the admin, not on ours. Our billing screen displays and *redirects* — see §4.8.
- It is configured in the **Partner Dashboard** (under the App Store listing), not the Dev
  Dashboard, and it cannot coexist with Billing API plans.

| Plan | Price | Limits enforced in code |
|---|---|---|
| Free | 0 | 1 active capped discount · order scope only · "Powered by MaxOff" note at checkout |
| Growth | 4.99/mo | unlimited discounts · dates · analytics · custom wording |
| Pro | 7.99/mo | + per-item / per-collection caps · per-market currency · CSV export · 12-month history |

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

**Eight screens, seven nav entries.** Detail (`app.discounts.$id.tsx`) has no nav link — it is
reached from a row in the list. Do not add an eighth link trying to make the numbers match.

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
  2. "Orders capped" — `N of M discounted orders`, where `N` counts this month's `CapEvent`s with
     `kept > 0` and `M` counts all of them (§3.5)
  3. "Active capped discounts" — with "1 scheduled, 1 paused" underneath
  4. "Biggest single save" — with the order number and code
- **Money you kept** card: 8-week bar chart, tallest bar highlighted and labelled, tooltip on hover.
  Subtitle: "Difference between the uncapped discount and what MaxOff actually gave away."
- **Your capped discounts**: active discounts only, columns
  Code · Discount · Maximum · Cap starts above · Used · Kept · Status. "View all" links to the list.
- Empty state for a brand-new install: no tiles, no chart — one card that explains the product and
  a single primary button "Create capped discount".

**Removed from Home on 11 Sep 2026, on Arthur’s instruction:** the "Cap engine is running"
banner and the four-step setup guide. Both were built and both worked; between them they took the
top half of the screen before a merchant reached a single number, which is the opposite of what
Home is for. The setup guide’s server side (`dismissSetupGuide`, the `setup` block on
`HomeData`, the `lastCartTest*` columns) is untouched, so bringing the card back is a UI change
only. The engine’s state is still visible on Settings, which is where §4.7 already reports it.

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
7. **What the customer sees** (V2) — checkout note field, 60 chars, rendered disabled.
   Note that the buyer *always* sees something: the Function's candidate carries a `message`, and
   there is no "no message" state at checkout. So V1 ships a fixed, non-editable message built
   from the discount — `"SUMMER15 — 15% off (max 150.00 USD)"` — plus the locked note "Discount
   capped at maximum amount" (§11). Only *editing* that wording is V2.
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

**This screen displays; it does not transact.** Under Shopify App Pricing (§3.6) the plan
selection page is hosted by Shopify. The "Upgrade to Pro" and "Downgrade" buttons **redirect** to
that hosted page — they do not change the plan themselves. Read the current plan back from
Shopify, never from a local guess. The mockup shows working buttons; the mockup is wrong here, and
this paragraph wins.

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

---

## 7. The eight weeks, and the four demos

Each demo is a working thing Arthur can click, not a slide. If a week slips, cut scope inside the
week — never move the demo.

### Weeks 1–2 · Spike: prove the cap at checkout → **Demo 1**

Generate the discount Function. Hard-code 15% / 150 cap. Deploy to
`maxoff-s7fqtwdd.myshopify.com`. Create a discount by hand in the Shopify admin that runs the
Function. Put a 1,400 cart through checkout and watch it take 150, not 210.

Nothing else. No admin UI work. This week answers the one question that can kill the project.

**Demo 1 passes when:** a real checkout on the dev store shows 150.00 on a 1,400 cart and 105.00 on
a 700 cart, and Sophea can explain in one paragraph how the Function decided.

### Weeks 3–4 · Real create form + list → **Demo 2**

Cap config moves from hard-coded to the discount metafield. Build the create form (method, value +
maximum, dates, limits, combinations) writing a real discount to Shopify. Build the list with
status tabs, search, and pause/activate. Mirror to Prisma. Fix the access scopes and delete the
template demo code. Raise `read_orders` approval with Arthur.

**Demo 2 passes when:** Sophea creates SUMMER15 in the app, it appears in Shopify's own Discounts
page, a checkout on the dev store caps correctly, and pausing it in the list stops it working.

### Weeks 5–6 · Preview, money kept, polish → **Demo 3**

Live preview on the create form. Cart tester. Checkout preview modal. `orders/paid` webhook and
`CapEvent` writing. Home tiles, weekly chart, detail page, analytics page. Setup guide. Empty
states. Every screen gets its loading and error state. Accessibility pass.

**Demo 3 passes when:** a merchant can go install → create → test → see money kept, without ever
leaving the app or reading documentation.

### Weeks 7–8 · Billing, listing, submission → **Demo 4**

Managed Pricing with the three plans. Free-tier limit enforced. Billing page. App Store listing:
name, tagline, description, screenshots, pricing, privacy. Deploy to the MPC VPS. Submit.

**Demo 4 passes when:** the app is installable from a listing draft, a plan can be chosen and
changed, and the submission checklist is green.

---

## 8. Definition of done

A task is done when all of these are true. Say which ones you checked, in one line.

- `npm run typecheck` passes.
- `npm run lint` passes.
- The screen matches `docs/MaxOff-mockup.html` in structure, copy, and behaviour.
- Loading, empty, and error states exist — not just the happy path.
- Every number shown is computed from real data or clearly labelled as an example.
- No `console.log`, no commented-out code, no `TODO` without an owner.
- Money handled in minor units; formatting only at the edge.
- Keyboard reachable, labelled, and readable at 200% zoom.
- The change is one commit with a message that says what and why.

### Cap arithmetic — the cases that must be right

Write these as unit tests for the shared calc module and run them from week 3 onward:

| pct | cap | subtotal | expected given | expected kept | note |
|---|---|---|---|---|---|
| 15 | 150 | 1,400.00 | 150.00 | 60.00 | above break-even |
| 15 | 150 | 700.00 | 105.00 | 0.00 | below break-even |
| 15 | 150 | 1,000.00 | 150.00 | 0.00 | exactly at break-even |
| 15 | 150 | 0.00 | 0.00 | 0.00 | empty cart |
| 100 | 150 | 200.00 | 150.00 | 50.00 | 100% discount still capped |
| 15 | 150 | 33.33 | 5.00 | 0.00 | rounding: 4.9995 → 5.00 |
| 1 | 150 | 1,400.00 | 14.00 | 0.00 | cap never reached |
| 15 | 0.01 | 1,400.00 | 0.01 | 209.99 | tiny cap |

`breakEven` when `pct` is 0 is undefined — show an em dash, never `Infinity` or `NaN`.

The same calc module is used by the create preview, the cart tester, the checkout preview modal and
the webhook. One implementation, one test suite. The Function has its own implementation in its own
language — test it against the same table.

---

## 9. Risks, and what to do about them

| Risk | Signal | Response |
|---|---|---|
| ~~The Function cannot cap the way we need~~ **Closed 4 Sep 2026** | — | Mechanism verified against the 2026-10 Discount Function API. See §3.2. The spike now proves an implementation, not a possibility. |
| The Function still does not produce 150 on a 1,400 cart | Week 1 checkout is wrong | Capture the Function input and output JSON *before* changing code. The mechanism is known good, so a wrong number is our bug, not a platform limit. |
| Our percentage is computed on the wrong base when combined with a product discount | A combined-discount cart gives an unexpected number | Named open question in §3.2. Test it on the dev store in **week 2** and write the answer into §3.2. Do not let this reach week 6. |
| Someone builds the Discounts Allocator | A PR adds `purchase.discounts-allocator.run` or `write_discounts_allocator_functions` | Stop. Read the warning in §3.2. It is Plus-only, unstable, and replaces the shop's discount engine. |
| `read_orders` approval refused or slow | Partner Dashboard rejects the reason | Ship V1 analytics from discount usage counts only; move the per-order table to V2 |
| Combined discounts behave unexpectedly | Two discounts on one cart give a wrong total | Reproduce on the dev store, capture the Function input JSON, bring it to the next demo |
| Shopify changes the discount API mid-build | The MCP docs disagree with our code | Trust the MCP docs. Update this spec, tell Sophea, do not silently diverge |
| Scope creep from V2/PRO ideas | "It would only take an hour to…" | It goes on the V2 list. The eight weeks have no slack. |

---

## 10. Open questions for Arthur

Not blockers for weeks 1–2. Get answers by Demo 2.

1. Is MaxOff confirmed as Sophea's project (vs CartRules)?
2. Partner-account access for Sophea?
3. Can billing + VPS deploy config be reused from FulfillFlex / Hartly?
4. Public contact email for the MaxOff site — currently reusing `team@mapetitecoree.com`
5. Exact MPC brand hex codes, if they differ from the orange used here
6. Protected customer data (`read_orders`) — who submits the approval request?

---

## 11. Locked copy

Use these words exactly. If you think one is wrong, say so — do not quietly improve it.

| Where | Text |
|---|---|
| App subtitle | Percentage discounts that stop at a maximum amount. |
| Home banner title | Cap engine is running |
| Home banner body | Your cap is applied by Shopify at checkout on N active discounts. No theme code was added to your store. |
| Field label | Maximum discount |
| List column | Cap starts above |
| Create hint | At **15%**, the maximum of **150.00 USD** starts working on carts above **1,000.00 USD**. Smaller carts get the full percentage. |
| Preview, capped | instead of ~~210.00 USD~~ — the maximum stopped it. |
| Preview, not capped | the full 15% — still under your maximum. |
| Preview footer, capped | You keep 60.00 USD on this order. |
| Preview footer, under | This cart is below 1,000.00 USD, so the maximum does not apply yet. |
| Checkout note | Discount capped at maximum amount |
| Combinations banner | When discounts are combined, the maximum still holds. MaxOff caps its own share only — it never touches the other discount. |
| Chart subtitle | Difference between the uncapped discount and what MaxOff actually gave away. |
| Settings, theme | None. MaxOff adds nothing to your theme. |
| Settings, uninstall | Capped discounts stop capping and can be deleted from Shopify's own Discounts page. Nothing is left behind in your theme. |
| Billing footer | Charged through Shopify with the rest of your bill. Cancel any time from your Shopify admin. |
| PRO toast | Per-item maximums are a Pro feature |
| Export toast | Export is a Pro feature |
| Save toast | SUMMER15 is live at checkout |

---

## 12. Defects in the mockup — fix these, do not port them

Found by rendering `docs/MaxOff-mockup.html` at 1440px on 4 Sep 2026. The mockup is the reference
for layout and copy, but these five things are wrong in it. Build the corrected behaviour.

1. **Radio labels run together.** Every `.choice` renders as
   "The whole order**One maximum for the entire cart.**" — the title and its description are both
   inline spans. Title on its own line, description underneath, in every radio and checkbox group.
   Affects: The maximum applies to · Applies to · Minimum requirements · Customers and usage limits.

2. **The live preview is buried.** It sits at the bottom of a ~2,400px form, eleven cards below the
   percentage and maximum fields that drive it — so the merchant types a number and the payoff is
   off-screen. Meanwhile the right rail is empty for the bottom two thirds of the page.
   **Move the live preview into the right column, sticky, directly under Summary.** It is the
   argument for the whole product; it should never be scrolled away from the fields it responds to.

3. **Wrong row action on non-active discounts.** The list offers "Pause" on Expired and Scheduled
   rows. Expired rows get no pause action (offer Duplicate instead); Scheduled rows get "Cancel".

4. **The detail page numbers do not reconcile.** The tile says 612.40 kept, the weekly chart sums to
   roughly 848, and the "Recent orders" table's Kept column sums to 384.75. Three independent fake
   datasets. In the real app all three read from the same `CapEvent` rows, and the table must say
   what it is showing — "Recent orders" is a sample, so label it "Last 5 of 31 capped orders" with a
   link to the full list. A merchant will add that column up.

5. **The comparison bars invert the intuition.** "Without a cap" draws the longer bar, so the worse
   outcome looks bigger. Keep the lengths — they are truthful — but make the loss bar visibly a
   loss: muted fill, and label it "would have been given away" rather than a bare number.

Everything else in the mockup is right and should be matched: the setup guide, the stat-tile
hierarchy, the "cap starts above" hint under the percentage fields, the cart tester's side-by-side
result, the checkout preview modal, and the "How MaxOff runs" transparency panel.
