# Prompt — build Test a cart (`app/routes/app.test.tsx`)

**Written:** 10 Sep 2026 · **Run this in Claude Code on the Mac**, where `shopify-dev-mcp` is
available (CLAUDE.md rule 1). Fourth in the series, after Home, the list and Create — all built
and committed.

Read `CLAUDE.md`, then BUILD-SPEC **§3.2, §3.3, §4.6, §4.9, §6, §8, §11**. Open
`docs/MaxOff-mockup.html` at Test a cart. Do not edit the mockup.

Smaller than Create, and almost entirely assembly — nearly everything this screen needs already
exists. The work is in the three judgement calls in §2, not in the markup.

---

## 0 · What you are building on — reuse, do not rewrite

- **`capDiscountMinor(subtotalMinor, percentage, capMinor)`** in `app/lib/cap.ts` returns
  `{ uncappedMinor, givenMinor, keptMinor, capped }`. That is the entire right-hand column.
  "Without MaxOff" is `uncappedMinor`; "With MaxOff" is `givenMinor`; the kept line is `keptMinor`.
- **`CheckoutPreviewModal`** in `app/components/CheckoutPreviewModal.tsx` — already built for
  Create and written to be shared with this screen. Props: `id`, `code`, `percentage`, `capMinor`,
  `currencyCode`, `subtotalMinor`, `checkoutNote`. Pass it the tester's subtotal and open it with
  "See the buyer's checkout". **Do not build a second one.**
- `capStartsAboveMinor`, `formatMoney`, `formatPercent`.
- `listCappedDiscounts` in `app/models/discounts.server.ts` — the discount picker's options.
- Verified tags now also include `s-modal`, `s-choice-list`, `s-choice`, `s-number-field`,
  `s-money-field`, `s-date-field`, `s-text-field`, `s-checkbox`, on top of the earlier set.

---

## 1 · Why this screen matters more than it looks

**It closes setup step 3.** Home's "Test it on a big cart" reads `ShopSettings.lastCartTestAt`,
`lastCartTestSubtotalMinor` and `lastCartTestCappedMinor`. Nothing writes them, so that step is
permanently incomplete and the setup card can never finish and dismiss itself. This screen is what
writes them — see §3.

**It is the merchant's confidence check.** It is the only place someone can see the cap behave
before sending a code to customers. That makes its honesty more important than its polish.

---

## 2 · Three decisions before you write

**a · Real products or a seeded basket, and the scope that comes with it.** §4.6 permits a seeded
sample basket in V1, and says to load real products instead if it is cheap. *Recommended:* use the
App Bridge resource picker so the merchant tests with their own products — a basket of invented
items undercuts the whole point of the screen. Verify the picker's API and whether it needs
`read_products` (§4 below).

If it does, take the chance to finish the §3.3 scope cleanup in the same commit, because a scope
change forces a reinstall either way and you have just done one for `read_discounts`:

```
final: write_discounts, read_discounts, read_products
drop:  write_products, write_metaobjects, write_metaobject_definitions
```

Also delete the template's `[product.metafields.app.demo_info]` and `[metaobjects.app.example]`
blocks — the demo action they existed for went with the Home build. Check what removing a metafield
or metaobject definition does on deploy before you push it; if it destroys data, say so and leave
the blocks for Sophea to decide. Do **not** touch `[discount.metafields.app.cap_config]`.

If the picker turns out to need more than `read_products`, fall back to the seeded basket and say
so — do not widen scopes to make a test screen nicer.

**b · The subtitle overstates what this does.** The mockup says "see the real checkout result
before you send the code to anyone." It is not the real checkout result. It is
`capDiscountMinor` — the admin's preview, sharing a test table with the Function but not its
output. It does not model taxes, shipping, combined discounts, or line-level discounts, and §3.2's
open question (whether `cart.cost.subtotalAmount` is net of line-level discounts) means the
subtotal here and the subtotal the Function sees can differ on a real cart.

Rule 2 permits this — the admin may preview the same arithmetic — but the copy should not promise
more than it delivers. *Recommended:* keep the heading and add one quiet line under the result:
"This is the same arithmetic the cap uses at checkout. Taxes, shipping and other discounts are not
included." Flag the wording change in the build log; §11 does not lock this subtitle.

**c · When the test counts as done.** Do not stamp `ShopSettings` on every quantity change. And do
not stamp it at all when the result was **not** capped: Home renders "Tested 1,400.00 USD — capped
correctly at 150.00 USD", and a 200.00 cart that never reached the maximum did not test the cap.
*Recommended:* fire a small idempotent fetcher POST the first time a **capped** result is shown,
and leave the step incomplete otherwise.

---

## 3 · Writing the setup-step fields — get the third one right

```
lastCartTestAt            = now
lastCartTestSubtotalMinor = the basket subtotal
lastCartTestCappedMinor   = givenMinor        ← the capped discount, NOT keptMinor
```

`buildSetup` in `app/models/home.server.ts` renders these as
`Tested {subtotal} — capped correctly at {capped}`. Writing `keptMinor` into the third field
produces "capped correctly at 60.00 USD", which is wrong and reads plausibly enough to survive
review. Add the write as a function in `app/models/home.server.ts` beside `dismissSetupGuide`,
not in the route.

Then confirm the loop: run a capped test, go to Home, see step 3 complete with the right sentence.

---

## 4 · Verify before you write (shopify-dev-mcp, rule 1)

1. The App Bridge 4 resource picker API for products, and the exact scope it requires.
2. Whether the picker returns prices, or whether a follow-up Admin API read is needed — and if so,
   the query and its scope.
3. Tags not yet proven here: whatever Polaris uses for a quantity stepper (or compose `s-button`
   + `s-number-field`), and a thumbnail. Reuse `s-select`/`s-option` for the discount picker.
4. Confirm `s-modal` is opened the way `CheckoutPreviewModal`'s doc comment assumes (`commandFor`)
   — Create already proved this, so just match it.

If the MCP server is unavailable, stop and say so.

---

## 5 · The page (§4.6)

Title "Test a cart", subtitle "Build a basket and see the real checkout result before you send the
code to anyone." — adjusted per §2b.

**Left column**

- **Test basket** card. Line items: thumbnail, title, unit price, a −/qty/+ stepper, line total.
  "Add product" opens the picker. Removing a line: the mockup has no remove control, which is a
  gap — let the stepper go to 0 and drop the line, or add a remove button; say which you chose.
  Subtotal row at the bottom.
- **Discount to test** card. A select over the shop's **active** capped discounts, labelled
  `SUMMER15 — 15% max 150.00 USD`. Underneath, the rule in words, from real numbers:
  `15% off, never more than 150.00 USD — the maximum starts on carts above 1,000.00 USD.`
  Empty state when the shop has none: say so plainly and link to `/app/discounts/new`. This is the
  common case today, so build it properly rather than as an afterthought.

**Right column, sticky** — "Result", then:

- **Without MaxOff** — plain panel: "Discount given" = `uncappedMinor`, "Customer pays" =
  `subtotal − uncappedMinor`.
- **With MaxOff** — branded panel: "Discount given" = `givenMinor` with the locked note "Capped at
  maximum amount" beneath it (only when `capped`), "Customer pays" = `subtotal − givenMinor`.
- Kept line: `You keep 60.00 USD on this order.` When not capped, say instead that this cart is
  below the point where the maximum applies — reuse the locked §11 phrasing the create preview
  uses, do not invent a third variant of this sentence.
- "See the buyer's checkout" → `CheckoutPreviewModal`.

All of it recalculates client-side and instantly. No server round trip per quantity change; the
only POST is the one in §2c.

Money is minor units everywhere; format once at the edge. Brand colour only where Home and the
list already use it — keep the three screens consistent rather than making this one prettier.

---

## 6 · Verification — report each in one line

1. `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` all clean.
2. Build the mockup's basket — 1 × 620.00 plus 3 × 260.00 = 1,400.00 — with SUMMER15 selected.
   Confirm exactly: without 210.00 / pays 1,190.00; with 150.00 / pays 1,250.00; keep 60.00.
   These are the Gate 1 checkout numbers, so a mismatch is a real bug, not a rounding opinion.
3. Drop the basket under 1,000.00 and confirm the uncapped variant of every line, including the
   "not capped yet" sentence and no "Capped at maximum amount" note.
4. Open the buyer's checkout modal from this screen and confirm it shows the same numbers as the
   panel behind it.
5. Run a capped test, then load Home: step 3 complete, sentence reads
   `Tested 1,400.00 USD — capped correctly at 150.00 USD`. Then confirm an **uncapped** test does
   not complete the step.
6. With no active discounts, confirm the empty state and that the page does not crash.
7. If you took §2a: confirm the app still installs and authorises with the final scope list, that
   Create and the list still work after the reinstall, and that `cap_config` is untouched.
8. Keyboard pass: steppers, picker, select and modal all reachable, focus visible, modal returns
   focus on close.

Commit as `feat(test): cart tester with the shared checkout preview`, and if you did the scope
cleanup, that goes in its own commit (`chore(scopes): drop the template demo scopes`) — rule 8, one
concern each. Then append a `docs/BUILD-LOG.md` entry: the three §2 decisions, the subtitle
wording change, and anything you deviated on.
