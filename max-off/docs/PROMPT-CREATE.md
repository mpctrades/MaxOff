# Prompt — build the Create screen (`app/routes/app.discounts.new.tsx`)

**Written:** 10 Sep 2026 · **Run this in Claude Code on the Mac**, where `shopify-dev-mcp` is
available (CLAUDE.md rule 1). Third in the series after `PROMPT-HOME.md` and
`PROMPT-DISCOUNTS.md`, both built and committed.

Read `CLAUDE.md`, then BUILD-SPEC **§3.1, §3.2, §3.3, §3.6, §4.3, §4.9, §6, §8, §11, §12.1, §12.2**.
Read the 8 Sep entry in `docs/BUILD-LOG.md` — it contains the validated create mutation and three
findings that change this screen. Open `docs/MaxOff-mockup.html` at Create and look at it.

This is the screen that makes the other three real. Home, the list and the Function all read rows
and metafields that nothing currently writes. **Get the metafield wrong and the discount silently
applies nothing at checkout** — no error, no clue, just a discount that does not discount.

---

## 0 · What you are building on

- `app/lib/cap.ts` — `capStartsAboveMinor`, `displayStatus`, the tab helpers. Tested.
- `app/lib/format.ts` — `formatMoney`, `formatPercent`, `formatDate`, `formatDateRange`. Tested.
- `app/models/discounts.server.ts` — `listCappedDiscounts`, `setDiscountPaused`, and a Free-plan
  refusal helper. **Reuse that refusal**; do not write a second plan check.
- Verified tags so far: `s-page`, `s-section`, `s-banner`, `s-badge`, `s-button`,
  `s-button-group`, `s-link`, `s-box`, `s-grid`, `s-stack`, `s-heading`, `s-paragraph`, `s-text`,
  `s-search-field`, `s-select`, `s-option`, and the `s-table` family.
- `shopify.app.toml` already declares `[discount.metafields.app.cap_config]` and already has
  `write_discounts`.

---

## 1 · Read this before anything else: the metafield contract

The Function parses the metafield in `extensions/max-off-cap/src/cap_config.ts`, and that file's
governing rule is: **configuration it cannot read with certainty applies no discount at all.** Every
one of these returns `null` and the discount does nothing:

| What the admin writes | What happens |
|---|---|
| `version` anything but the number `1` | refused |
| `percentage` not an integer, or outside 1–100 | refused |
| **`capAmount` as a number instead of a string** | refused |
| `capAmount` as minor units (`"15000"`) | parsed as 15,000.00 — a cap 100× too high |
| `scope` present and not `"order"` | refused |

So the value written by `discountCodeAppCreate` must be exactly:

```json
{
  "version": 1,
  "percentage": 15,
  "capAmount": "150.00",
  "currencyCode": "USD",
  "scope": "order",
  "checkoutNote": "Discount capped at maximum amount",
  "code": "SUMMER15"
}
```

`capAmount` is a **decimal string in major units**, two decimals. Namespace `$app`, key
`cap_config`, type `json` — not `$app:maxoff`, which §3.1 corrected on 8 Sep.

**Write a round-trip test before you write the form**: `"150.00"` → 15000 minor →
`"150.00"`, for every amount in the §8 table, using the admin's own parser and the Function's
`parseCapConfig` on the result. If those two disagree, nothing else on this screen matters.

---

## 2 · Two blockers to settle first

**a · Create needs `read_discounts`, which is a scope change (rule 9).** Two reasons:

1. We must store `discountGid` — it is `@unique` on `CappedDiscount` and it is how the
   `orders/paid` webhook will find our discount. Getting it back means selecting
   `codeAppDiscount { discountId … }` in the mutation payload, and the 8 Sep BUILD-LOG entry
   records that doing so **raises the required scopes to `write_discounts, read_discounts`**.
   With only `userErrors` selected it is `write_discounts` alone — but then we never learn the id.
2. §4.3 wants code uniqueness checked against Shopify on blur. That is a read.

§3.3 dropped `read_discounts` on the reasoning that "`write_discounts` covers our reads". The
8 Sep validation shows it does not. **Correct §3.3, add `read_discounts` to `access_scopes`, and
tell Sophea the app needs reinstalling on the dev store for the new scope to take.** Do not work
around it by not storing the id — an unmirrored discount is invisible to every other screen.

**b · What happens if Shopify succeeds and Prisma fails.** Shopify is the source of truth (§3.1),
so the order is: create in Shopify → mirror to Prisma → toast → navigate. If the mirror write
throws, the merchant has a live capped discount that MaxOff cannot see. *Recommended:* catch it,
keep the discount (it is working at checkout — deleting it would be worse), and show a warning
banner naming the code and saying it will appear in the list once MaxOff resyncs. Log it. A real
reconcile-from-Shopify job is V2; note it in the log rather than building it.

---

## 3 · Verify before you write (shopify-dev-mcp, rule 1)

Record every answer in your reply.

1. **The `metafields` input on `DiscountCodeAppInput`** — exact field name and shape for writing
   `$app` / `cap_config` inline. §3.1 says no separate `metafieldsSet` round trip is needed;
   confirm that against the live 2026-10 schema.
2. **The full `discountCodeAppCreate` input** for a real discount, beyond the Gate 1 test:
   `usageLimit`, `appliesOncePerCustomer`, `endsAt`, `title`, and how minimum requirements
   (subtotal / quantity) are expressed. The Gate 1 mutation in BUILD-LOG is the starting point,
   not the whole shape.
3. Whether `functionHandle` or `functionId` is correct on 2026-10 — BUILD-LOG flags the docs as
   self-contradictory and says to resolve it against the live schema in this gate. **This is that
   gate.**
4. How to read a discount by code, for the uniqueness check.
5. **Tags** not yet proven here: segmented control, text field with prefix/suffix, number field,
   radio group, checkbox, date and time fields, modal, and the contextual save bar
   (`shopify.saveBar` — confirm the App Bridge 4 API and whether it needs a `<form data-save-bar>`
   or an imperative call).

If the MCP server is unavailable, stop and say so.

---

## 4 · Shared arithmetic — extend `app/lib/cap.ts`

The preview must never disagree with the Function. The Function's `cap.ts` has `parseDecimalToMinor`,
`capDiscount` and `toDecimalString`; the admin has none of them. Add admin equivalents to
`app/lib/cap.ts`:

- `parseDecimalToMinor(value: string): number | null` — accepts what a merchant actually types
  (`150`, `150.5`, `150.00`, with or without spaces), rejects anything else. Returns null, never NaN.
- `capDiscountMinor(subtotalMinor, percentage, capMinor)` — `min(round(subtotal × pct / 100), cap)`,
  integer arithmetic, half-up once, per rule 4 and §8.
- `toDecimalString(minor: number): string` — what goes into `capAmount`.

Test all three in `app/lib/cap.test.ts` **against the same eight cases in §8 that the Function's
tests use**, so a divergence fails a test rather than a checkout. Do not import from `extensions/` —
the duplication is deliberate and documented; the shared thing is the test table, not the code.

---

## 5 · The form (§4.3), and the two mockup defects it must fix

Cards in the order §4.3 lists: Method · Value and maximum · Applies to · Minimum requirements ·
Customers and usage limits · Combinations · What the customer sees · Active dates · Live preview.
Right column: sticky Summary, then Templates (V2, disabled).

**Defect §12.2 — do not port the mockup's layout.** In the mockup the live preview sits at the
bottom of a ~2,400px form, eleven cards below the two fields that drive it, while the right rail is
empty for the bottom two thirds. **Put the live preview in the right column, sticky, directly under
Summary.** It is the argument for the whole product and it must stay on screen beside the
percentage and maximum fields. The screenshots Sophea is working from show the mockup's buried
version — that is the thing being corrected, not the target.

**Defect §12.1 — radio and checkbox labels.** Every `.choice` in the mockup renders as
"The whole order**One maximum for the entire cart.**", title and description run together inline.
Title on its own line, description underneath, in all four groups: "The maximum applies to",
"Applies to", "Minimum requirements", "Customers and usage limits".

Rendered **disabled**, never as working code (rule 6): Automatic discount (V2) · Each item and
Each collection (PRO) · Specific collections and Specific products (V2) · campaign budget cap (V2) ·
the checkout note field (V2) · the four templates (V2).

**The checkout note is V2 but the buyer always sees something.** §4.3 item 7 is explicit: the
Function's candidate carries a `message` and there is no silent state. V1 writes a fixed
`checkoutNote` — the locked "Discount capped at maximum amount" (§11) — into the metafield. The
field is visible and disabled so the merchant knows what the buyer will read. Do not omit
`checkoutNote` from the metafield because the field is disabled.

**Live hint** under the two fields, from real numbers, locked wording (§11):
> At **15%**, the maximum of **150.00 USD** starts working on carts above **1,000.00 USD**.
> Smaller carts get the full percentage.

**Live preview** (§4.3 item 9): slider 50→3000, chips 200 / 800 / 1,400 / 2,500, the given
discount as the big number in brand colour, `instead of ~~210.00 USD~~ — the maximum stopped it.`
or `the full 15% — still under your maximum.`, two bars scaled to the larger value, and the footer
line — `You keep 60.00 USD on this order.` or `This cart is below 1,000.00 USD, so the maximum does
not apply yet.` All of it client-side and instant. No round trip, no server call per slider tick.

**Checkout preview modal** (§4.9) — build it as a shared component under `app/components/`, not
inline. Test a cart reuses it verbatim, and a second copy is exactly what rule 2 and defect §12.4
are about.

---

## 6 · Validation and save

Field-level errors, not a banner (§4.3): percentage integer 1–100 · maximum > 0 · end after start ·
code non-empty and unique in the shop, checked on blur.

Server-side, revalidate everything. A client that skipped validation must not be able to write a
malformed `cap_config`.

**Free plan: one active capped discount** (§3.6) — the only plan limit V1 enforces in code. Check it
on create, using the same helper the list's activate path uses. Refusal points at `/app/billing`.

On success: toast **"SUMMER15 is live at checkout"** (locked, §11), then navigate to
`/app/discounts`. Mirror row: `discountGid`, `method: "code"`, `code`, `title`, `percentage`,
`capMinor`, `currencyCode`, `scope: "order"`, `checkoutNote`, `startsAt`, `endsAt`, `status:
"active"` (intent — the list derives scheduled/expired from the dates), the combines flags, and the
usage fields.

---

## 7 · Verification — do all of it, report each in one line

1. `npm run typecheck`, `npm run lint`, `npm run build` all clean.
2. `npm test` — including the new round-trip and `capDiscountMinor` cases against the §8 table.
3. **The one that matters:** create `SUMMER15` — 15%, max 150.00 — through the form on the dev
   store, then run a real checkout with a 1,400.00 cart and confirm **−150.00**, and a 700.00 cart
   and confirm **−105.00**. Same two numbers as Gate 1, now from a merchant-created discount
   instead of a hand-run mutation. Report both from the actual checkout.
4. Read the created discount's `cap_config` metafield back from Shopify and paste it. Confirm
   `capAmount` is the string `"150.00"`.
5. Confirm the new row appears on the list and that Home's cap-engine banner flips from the warning
   to "Cap engine is running" with a count of 1.
6. Every V2/PRO control is visibly disabled and nothing behind it runs.
7. The live preview is in the right column, sticky, and stays beside the fields while scrolling.
8. Radio and checkbox titles are on their own line with the description beneath, in all four groups.
9. Try to create a second active discount on the Free plan — confirm the refusal.
10. Submit invalid input with client validation bypassed and confirm the server rejects it.
11. Keyboard pass: every field labelled, focus visible, the slider operable by arrow keys, the
    modal trapping focus and returning it on close.

Commit as `feat(create): create capped discounts with the cap metafield`, then append a
`docs/BUILD-LOG.md` entry in the existing format — the scope change and why, the `functionHandle`
resolution, the §2b policy you chose, and anything you had to deviate on.
