# Prompt — build the Home screen (`app/routes/app._index.tsx`)

**Written:** 10 Sep 2026 · **Run this in Claude Code on the Mac**, where `shopify-dev-mcp` is
available. It exists because CLAUDE.md rule 1 requires every Polaris web-component tag and every
Shopify API to be verified through that server, and the session that drafted this spec could not
reach it.

Read `CLAUDE.md`, then `docs/BUILD-SPEC.md` §3.4, §3.6, §4.1, §5, §6, §11 and §12 before writing
code. Open `docs/MaxOff-mockup.html` in a browser and look at the Home screen. Do not edit the
mockup.

---

## 0 · State of the repo before you start

Already done (10 Sep 2026, no UI work):

- `app/routes/app.tsx` — `<s-app-nav>` now carries the seven entries from §4:
  Home · Capped discounts · Create new · Analytics · Test a cart · Settings · Plans & billing.
- Seven route files created as minimal `<s-page>` stubs, each with an `authenticate.admin` loader:
  `app.discounts._index.tsx`, `app.discounts.new.tsx`, `app.discounts.$id.tsx`,
  `app.analytics.tsx`, `app.test.tsx`, `app.settings.tsx`, `app.billing.tsx`.
- `app/routes/app.additional.tsx` — deleted.
- `prisma/schema.prisma` — `CappedDiscount`, `CapEvent` and `ShopSettings` added verbatim from
  §3.4. **The migration has not been run** (the Prisma engine could not be fetched in that
  environment). Run it as step 1 below.

Still untouched and out of scope for this prompt: the Function in `extensions/`, the demo scopes
and metafield/metaobject blocks in `shopify.app.toml`, the `orders/paid` webhook.

### One thing to sign off before you run this

`ShopSettings` in the schema has four fields **beyond** §3.4, added so the setup guide can hold
state instead of pretending:

```
setupGuideDismissedAt     DateTime?
lastCartTestAt            DateTime?
lastCartTestSubtotalMinor Int?
lastCartTestCappedMinor   Int?
```

They are nullable and additive, so the migration is not destructive. Without them the "Hide"
button and setup step 3 ("Test it on a big cart") have nowhere to record anything. If Sophea
rejects them, drop the fields and make the guide non-dismissible with step 3 always incomplete —
do not fake it in component state.

---

## 1 · Migration

```
npx prisma migrate dev --name add_maxoff_models
npx prisma generate
```

Confirm `prisma/dev.sqlite` gains the three tables. Do not commit `dev.sqlite`.

---

## 2 · Verify before you write (shopify-dev-mcp, rule 1)

Use `search_docs_chunks` / `introspect_graphql_schema` and record the answers in your reply:

1. The Polaris web-component tag and attribute names for every element this page needs. At minimum:
   page + header actions, badge, banner (success and warning tone), section/card, stack or grid for
   the tile row, table, progress indicator, button, link, text/heading, unordered list. **Do not
   assume `s-*` names from memory or from this document** — this document deliberately names no tag
   it has not seen in the repo. The only tags already proven in this codebase are `s-page`,
   `s-section`, `s-paragraph`, `s-link`, `s-unordered-list`, `s-list-item`.
2. Whether a Polaris web component exists for a stat/metric tile and for a progress bar, or whether
   those are composed from primitives.
3. The current `DiscountNode` / `DiscountCodeNode` read shape, in case step 4's fallback is needed.

If the MCP server is unavailable, stop and say so. Do not guess.

---

## 3 · Data layer — `app/models/home.server.ts`

One module, one exported function, so the loader stays thin and the Analytics screen can reuse it.

```ts
export async function getHomeData(shop: string): Promise<HomeData>
```

It must read **only** the database. No Admin API calls in V1 Home — everything on this page comes
from our own tables, which is also what fixes mockup defect §12.4 (three datasets that did not
reconcile). Every number below traces to `CapEvent` or `CappedDiscount`.

`HomeData` shape:

| Field | Source |
|---|---|
| `plan` | `ShopSettings.plan`, defaulting to `"free"` if no row — upsert the row on first load |
| `currencyCode` | `ShopSettings.currencyCode` |
| `activeCount` | `count(CappedDiscount where status = "active")` |
| `scheduledCount`, `pausedCount` | same, by status |
| `totalCount` | `count(CappedDiscount)` — drives the empty state |
| `keptThisMonthMinor` | `sum(CapEvent.keptMinor)` where `occurredAt` ≥ start of current month |
| `keptLastMonthMinor` | same for the previous calendar month — the delta on tile 1 |
| `ordersCapped` | `count(CapEvent)` this month |
| `biggestSave` | `CapEvent` with max `keptMinor`, ever — order name + the discount's code |
| `weeks` | 8 buckets of `sum(keptMinor)` by week, oldest first, each `{ weekStartISO, keptMinor }` |
| `discounts` | active `CappedDiscount` rows, newest first, take 5 |
| `setup` | the four booleans + result lines, see §5 |

Month and week boundaries: use the **shop's** timezone, not the server's. Get it once from
`ShopSettings` if you add a field for it, or accept UTC for now and leave a `// TODO` naming the
drift — do not silently use `new Date()` local time on a VPS and call it "this month".

Derived per discount row, computed here not in the component:
`capStartsAboveMinor = round(capMinor * 100 / percentage)` — §11 calls this **"Cap starts above"**.
Never "break-even" in merchant-facing copy.

---

## 4 · What is honestly zero right now

`CapEvent` rows only get written by the `orders/paid` webhook, which needs `read_orders`, which is
open question #6 and not yet approved. So on a real store today: `keptThisMonthMinor = 0`,
`ordersCapped = 0`, `biggestSave = null`, every week bucket `0`.

**Design for that, don't paper over it.** Three states, and the page must pick the right one:

- **A · Brand-new install** (`totalCount === 0`): per §4.1, no tiles and no chart. One card
  explaining the product and a single primary button, "Create capped discount". The setup guide
  still shows, because that is what the merchant is meant to do next.
- **B · Discounts exist, no cap events yet** (`totalCount > 0`, no `CapEvent` rows): tiles 3
  (Active capped discounts) and the discounts table are real and useful. Tiles 1, 2 and 4 and the
  chart have no data — render them with a one-line "No capped orders yet" rather than a confident
  `0.00 USD`, which reads as "you have saved nothing" instead of "we have not measured yet". Do not
  hide them; the merchant should see what is coming.
- **C · Full data**: as the mockup.

Never hard-code a mockup number into the component. If you want to see state C while building, seed
`CapEvent` rows in a script under `prisma/seed/` that is obviously a dev seed, and say so in your
reply.

---

## 5 · The page, section by section (§4.1)

Locked copy is in §11 — use those strings **exactly**, including the banner body's "No theme code
was added to your store."

1. **Header** — title `MaxOff`, plain badge with the current plan, subtitle "Percentage discounts
   that stop at a maximum amount." Actions: "Test a cart" (secondary → `/app/test`),
   "Create capped discount" (primary → `/app/discounts/new`). Both must actually navigate.
2. **Banner** — success tone, "Cap engine is running", body with `activeCount` substituted for N,
   action "Run a test cart" → `/app/test`. If `activeCount === 0` **or** the Function is not
   deployed, show the warning equivalent instead. The Function does not exist yet, so for now treat
   "deployed" as false and leave a single named constant, `FUNCTION_DEPLOYED`, in one place for
   week 1 to flip. Do not scatter the assumption.

   **Corrected 10 Sep 2026, when this prompt was run:** the Function *does* exist and Gate 1
   closed on 8 Sep — a real checkout took 150.00 on a 1,400 cart. The constant is therefore
   `CAP_ENGINE_DEPLOYED = true` in `app/routes/app._index.tsx`. It is still a build-time
   assertion, not a per-shop runtime check; a real check needs an Admin API call, which Home is
   not allowed to make.
3. **Setup guide** — 4 steps with a progress bar, hidden entirely when all four are done or when
   `setupGuideDismissedAt` is set. "Hide" posts to an action that stamps that field.
   - 1 Install MaxOff — always complete.
   - 2 Create your first capped discount — `totalCount > 0`. Result line, formatted per §6:
     `SUMMER15 — 15% off, capped at 150.00 USD` from the most recent discount.
   - 3 Test it on a big cart — `lastCartTestAt != null`. Result line:
     `Tested 1,400.00 USD — capped correctly at 150.00 USD`. The Test a cart screen writes those
     fields; it is a stub today, so this step is legitimately incomplete until week 5.
   - 4 Choose a plan — `plan !== "free"`. Action "View plans" → `/app/billing`.
4. **Four stat tiles**, first one branded with `--orange-soft` / `--orange-line` / `--orange`:
   "Over-discounting avoided · this month" + delta vs last month · "Orders capped" (`N of M
   discounted orders` — M needs order counts we cannot read yet, so show `N` alone until
   `read_orders` lands, and do not invent M) · "Active capped discounts" with
   "N scheduled, N paused" underneath · "Biggest single save" with order number and code.
5. **Money you kept** — 8-bar inline SVG, tallest bar at full `--orange-bright` and labelled, the
   rest at 55% opacity, two gridlines, tooltip on hover, **and a text alternative** (§5,
   accessibility is not optional). No charting library. Subtitle is the locked string. "View
   analytics" → `/app/analytics`.
6. **Your capped discounts** — active only, take 5. Columns: Code · Discount · Maximum ·
   Cap starts above · Used · Kept · Status. Code in monospace, amounts tabular, Kept in `--orange`.
   Rows link to `/app/discounts/:id`. "View all" → `/app/discounts`.

Brand colour appears only in the five places §5 lists. Do not repaint Polaris chrome.

---

## 6 · Formatting — `app/lib/format.ts`

Money is integers of minor units everywhere (rule 4); format once, at the edge.

- `formatMoney(minor, currencyCode)` → `1,234.50 USD` — two decimals, `en-US` grouping for both USD
  and EUR, currency code after the number and a space. Not `$1,234.50`.
- `formatPercent(pct)` → `15%`, whole numbers.
- Dates → `10 Sep – 30 Sep 2026`.

Unit-test `formatMoney` against the §6 rules and the §8 cap-arithmetic table's amounts.

---

## 7 · Also do, while you are in this file

Delete the template's demo `productCreate` action and its `useFetcher` UI from
`app/routes/app._index.tsx` (§3.3, last paragraph). The Home loader replaces it. Leave
`shopify.app.toml` alone — the scope and metafield cleanup is week 3.

---

## 8 · Verification — do all of it, report each in one line

1. `npm run typecheck` and `npm run lint` both clean.
2. `npm run dev`, open the app on `maxoff-s7fqtwdd.myshopify.com`, screenshot Home.
3. Show state A (empty DB) and state B (one seeded `CappedDiscount`, no `CapEvent`s). Confirm the
   right variant renders and neither invents a number.
4. Every button and link on the page navigates to the route it claims — click all nine.
5. Keyboard: tab through the whole page, focus visible at every stop, chart reachable and its text
   alternative announced.
6. Confirm no `@shopify/polaris` React import crept in (CLAUDE.md stack table) and no new
   dependency was added (rule 9).
7. Say which tags you verified through `shopify-dev-mcp` and which you could not.

Commit as `feat(home): real Home screen backed by MaxOff tables` — one concern, per rule 8.
