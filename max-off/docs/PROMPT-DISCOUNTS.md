# Prompt — build the Capped discounts list (`app/routes/app.discounts._index.tsx`)

**Written:** 10 Sep 2026 · **Run this in Claude Code on the Mac**, where `shopify-dev-mcp` is
available (CLAUDE.md rule 1). Companion to `docs/PROMPT-HOME.md`, which built Home the same way.

Read `CLAUDE.md`, then BUILD-SPEC §3.1, §3.3, §4.2, §5, §6, §11 and §12.3. Open
`docs/MaxOff-mockup.html` at the Capped discounts screen and look at it. Do not edit the mockup.

---

## 0 · What you are building on

Home is done and committed (`2068d06`). Reuse it rather than re-deriving:

- **Verified tags.** Home proved these in this codebase: `s-page`, `s-section`, `s-banner`,
  `s-badge`, `s-button`, `s-link`, `s-box`, `s-grid`, `s-stack`, `s-heading`, `s-paragraph`,
  `s-text`, `s-table` + `s-table-header-row` / `s-table-header` / `s-table-body` / `s-table-row` /
  `s-table-cell`. Use them the way `app._index.tsx` uses them — `slot="primary-action"`,
  `slot="accessory"`, `tone` on banners, `STATUS_TONES` for the status pill.
- `app/lib/format.ts` — `formatMoney`, `formatPercent`, `formatDate`, `formatDateRange`. 25 passing
  tests. Do not write a second money formatter.
- `app/models/home.server.ts` — the pattern for a data module. Also see §2 below about
  `capStartsAboveMinor`, which now needs to move.
- The loader in `app._index.tsx` returns `{ data, error }` and the component renders a critical
  banner when the read fails, rather than an invented empty list. Do the same.

**`write_discounts` is already in `shopify.app.toml`**, so the pause/activate mutations are in
scope. The demo scopes beside it are still week-3 cleanup — leave them.

### The list is empty and will stay empty

The Create screen (`app.discounts.new.tsx`) is still a stub, so nothing writes `CappedDiscount`
rows. Everything you build here renders the empty state on a real store today.

That is fine — build it anyway, because the list is what Create redirects *to*. But it means
verification depends on `prisma/seed/dev-home-state.mjs`, which Home already uses. Extend that
script with the six mockup rows (SUMMER15, VIP20, WELCOME10, BF30 scheduled, BF-TEST paused,
SPRING12 expired) so every tab and every row action has something to act on, keep it obviously
dev-only, and **reset the database to empty when you are done**, the way the Home build did.

---

## 1 · Decisions to make before you write

Three things §4.2 does not settle. Pick the recommended option unless Sophea says otherwise, and
record the choice in `docs/BUILD-LOG.md`.

**a · Stored status will go stale.** `CappedDiscount.status` is a stored string, but "scheduled"
becomes "active" the moment `startsAt` passes and "active" becomes "expired" when `endsAt` does —
with no cron, no row ever updates itself, and the list lies within a day of a scheduled discount
going live. *Recommended:* keep the column as a cache of the merchant's **intent** (`active` vs
`paused` — the only two states a human sets), and derive the display status at read time:

```
paused                          → "paused"
active && startsAt  > now       → "scheduled"
active && endsAt   <= now       → "expired"
otherwise                       → "active"
```

Put that in one exported function, `displayStatus(discount, now)`, and use it for the tab filter,
the pill and the row action. Home's `activeCount` drives the cap-engine banner and must use the
same function, or Home and the list will disagree — which is mockup defect §12.4 all over again.
This needs no migration.

**b · The checkbox column has no bulk action.** The mockup draws checkboxes and then offers
nothing to do with them. *Recommended:* leave the column out of V1. A checkbox that selects rows
into a void is worse than no checkbox, and §4.2 lists no bulk action. If Sophea wants it, the
honest minimum is bulk pause / bulk activate, and that is a V2 line item.

**c · "Cap type" filter.** V2 per §4.2, and V1 has only `scope = "order"` anyway, so the filter
would have one option. Render it disabled alongside Method (rule 6: visible disabled affordance,
never working code), with whatever Polaris uses for a disabled filter.

---

## 2 · Move `capStartsAboveMinor` first

It sits in `app/models/home.server.ts` with a `TODO(sophea)` saying it belongs in a shared module,
because the create preview will need it too. The list needs it now, so this is the moment. Move it
and `displayStatus` into `app/lib/cap.ts`, re-export nothing, update Home's import, and give
`capStartsAboveMinor` its own tests in `app/lib/cap.test.ts` against the §8 table — including
`percentage = 0`, which must return `null` and render as an em dash, not `Infinity`.

Do **not** touch `extensions/max-off-cap/src/cap.ts`. That duplication is deliberate and documented.

---

## 3 · Verify before you write (shopify-dev-mcp, rule 1)

Record each answer in your reply.

1. **Tags** for: tabs, a search text field, a disabled filter control, a status pill in a table
   row, pagination, and an empty state. None of those are in the verified list above. Do not guess
   an `s-*` name.
2. **Mutations** for activating and deactivating a discount **created by `discountCodeAppCreate`**
   — an app discount, not a basic one. Confirm the exact mutation names, their input shape, and
   what they return, including `userErrors`. The 8 Sep entry in `docs/BUILD-LOG.md` has the
   validated create mutation; match its style.
3. Whether those mutations are the right mechanism for "pause" at all, or whether pausing an app
   discount is done by editing its `endsAt` / status some other way. **This is the one that could
   invalidate the whole screen** — settle it before writing the action, and if the answer differs
   from what §4.2 assumes, say so and stop rather than inventing a workaround.
4. The toast API on App Bridge 4 for `shopify.toast.show(...)`.

If the MCP server is unavailable, stop and say so.

---

## 4 · Data layer — `app/models/discounts.server.ts`

```ts
export async function listCappedDiscounts(input: {
  shop: string;
  tab: "all" | "active" | "scheduled" | "paused" | "expired";
  query: string;      // code search, trimmed, case-insensitive
  page: number;       // 1-based
}): Promise<DiscountList>
```

Reads **only** our tables. Returns the rows for the page, the total for the current tab, a count
per tab (the tabs show them), and the page count. Each row carries `capStartsAboveMinor` and
`displayStatus` computed server-side — the component formats, it does not calculate.

Status filtering happens on the derived value from §1a, so it cannot be a plain `where` clause on
`status`. Translate each tab into date predicates:

- `paused` → `status = "paused"`
- `scheduled` → `status = "active" AND startsAt > now`
- `expired` → `status = "active" AND endsAt <= now`
- `active` → `status = "active" AND startsAt <= now AND (endsAt IS NULL OR endsAt > now)`

Sort: newest first. The mockup's "Sort: Money kept" dropdown is not in §4.2 — leave it out.

Page size 25. Offset pagination is fine at this scale; say so in a comment rather than reaching
for cursors.

---

## 5 · Pause / activate — `app/models/discounts.server.ts` + the route action

**Shopify is the source of truth; Prisma is a mirror** (§3.1). So the order is fixed:

1. Call the verified mutation against the Admin API.
2. If `userErrors` is non-empty, **change nothing locally** and return the error.
3. Only on success, update the `CappedDiscount` row.
4. Return the new state; the UI reconciles to what came back, not to what it hoped.

§4.2 asks for optimistic UI. Do it with `useFetcher`'s pending state so the pill flips immediately,
but on failure revert to the server value and toast the error message — not a generic one. Toast
text on success is locked in §11 style: `SUMMER15 paused` / `SUMMER15 activated`.

Guard the Free plan here, not only in the UI: Free allows **one active capped discount** (§3.6). An
activate that would make it two returns a refusal the UI shows as a toast pointing at
`/app/billing`. This is the only plan limit V1 enforces in code.

---

## 6 · The page (§4.2, §12.3)

- Title "Capped discounts", subtitle "Every percentage discount with a maximum amount."
- Header actions: "Export" → toast **"Export is a Pro feature"** (locked, §11); "Create capped
  discount" (primary) → `/app/discounts/new`.
- Tabs All · Active · Scheduled · Paused · Expired, each with its count. Tab and search live in the
  URL as search params so a filtered list is linkable and the back button works — not in component
  state.
- Search by code, debounced, submitted as a `GET`.
- Columns: Code (monospace, links to `/app/discounts/:id`) · Discount · Maximum · Cap starts above ·
  Used · Kept · Status · row action.
- **Row action, corrected per §12.3 — do not port the mockup's bug**, which offers "Pause" on
  Expired and Scheduled rows:

  | Display status | Action |
  |---|---|
  | active | Pause |
  | paused | Activate |
  | scheduled | Cancel |
  | expired | Duplicate |

  Cancel and Duplicate have no implementation yet — Duplicate needs the Create form, Cancel needs a
  delete/schedule mutation. Render them disabled with a title explaining why, rather than a live
  button that throws. Say in your reply that you did.
- Empty state, per tab: "No discounts here yet" / "When a capped discount reaches this state it
  will show up here." + primary "Create capped discount". On the All tab with a search term, say
  instead that nothing matched the search and offer to clear it.
- Kept column: an em dash when the discount has no `CapEvent`s, never `0.00 USD`. Same rule as
  Home — no capped orders yet is not the same as nothing saved.

Follow the Home build's colour decision: brand orange only where it does not fight Polaris. The
BUILD-LOG notes Home shipped the Kept column as plain table text rather than `--orange`; keep the
list consistent with Home, and if Sophea wants brand colour it changes in both places at once.

---

## 7 · Verification — do all of it, report each in one line

1. `npm run typecheck`, `npm run lint`, `npm run build` all clean.
2. `npx vitest run app/lib/cap.test.ts` — the §8 table plus the `percentage = 0` case.
3. Seed the six mockup rows. Screenshot every tab. Confirm each row shows the §12.3 action for its
   state, and that the tab counts add up to the All count.
4. Pause SUMMER15, confirm the toast, confirm the row and Home's banner both update, confirm the
   `CappedDiscount` row changed. Then activate it again.
5. Force a `userErrors` response and confirm the UI reverts and shows *that* error.
6. On the Free plan with one active discount, try to activate a second — confirm the refusal.
7. Search, then a search that matches nothing, then an empty database. Three different empty
   states, none of them invented.
8. Keyboard pass: tabs, search, every row action reachable, focus visible.
9. Reset `dev.sqlite` to empty and confirm nothing seeded is left behind.

Commit as `feat(discounts): capped discounts list with pause and activate`, then append a
`docs/BUILD-LOG.md` entry in the existing format — including the three §1 decisions and anything
you had to deviate on.
