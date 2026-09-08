# MaxOff — the screens (Gate 2 + Gate 3)

Paste the block below into Claude Code after `/clear`, from `~/Desktop/MaxOff/max-off`.
Re-paste the same block at the start of every session until step 7 is done — it reads the build
log and picks up where it left off.

Gate 1 closed on 8 Sep 2026: a real checkout took 150.00 on a 1,400 cart and 105.00 on a 700 cart.

---

```
Read CLAUDE.md, docs/BUILD-SPEC.md and docs/BUILD-LOG.md. Gate 1 is closed — the Function caps
a real checkout. We are now building the admin UI so a merchant can actually use MaxOff.

Open docs/MaxOff-mockup.html and read the markup for each screen before you build it. It is the
approved design: match its structure, its card order and its exact wording. Section 12 of the
spec lists five things the mockup gets WRONG — build the corrections, not the mockup, for those.

Build with Polaris web components (<s-page>, <s-section>, <s-button>, <s-table>…). Never install
@shopify/polaris. Shopify's own template page confirms this template uses web components.

WORK IN THIS ORDER. One step per commit. Do not start a step before the one above it is green.

Step 1 — Gate 2: the cap becomes configurable.
  Move PERCENTAGE and CAP_MINOR out of the Function and into the discount's cap_config metafield,
  per spec section 3.1. Missing or malformed config must apply NO discount, never an uncapped one
  — add that as a test. Store the discount code in the metafield too, so the checkout message can
  say "SUMMER15 — 15% off (max 150.00 USD)"; the Function cannot read the code any other way.
  Green when: npm test passes, and I have re-run one checkout and confirmed it still caps.

Step 2 — The walking skeleton. I want to stop seeing the template.
  - Replace the <s-app-nav> links in app/routes/app.tsx with MaxOff's seven entries:
    Home, Capped discounts, Create new, Analytics, Test a cart, Settings, Plans & billing.
  - Create every route file from spec section 4, each rendering just its page title and subtitle.
  - Delete app/routes/app.additional.tsx and the snowboard demo action in app._index.tsx.
  - Delete the demo scopes and the [product.metafields.app.demo_info] and [metaobjects.app.example]
    blocks from shopify.app.toml. Tell me if this needs a reinstall.
  - Add the Prisma models from spec section 3.4 and show me the migration before running it.
  Green when: I can click all seven nav entries and every page is MaxOff, not the template.

Step 3 — Create a capped discount, for real.
  app/routes/app.discounts.new.tsx per spec 4.3. The form, validation, the sticky Summary, and a
  Save that writes a real discount to Shopify with the cap metafield and mirrors it to Prisma.
  Use the validated discountCodeAppCreate mutation recorded in the build log — including
  discountClasses: [ORDER], without which the Function silently does nothing.
  V2 and PRO controls are rendered, visible and disabled, with their badge.
  Green when: I create a code in the app, it appears in Shopify's own Discounts page, and a
  checkout using it caps correctly.

Step 4 — See and manage them.
  app.discounts._index.tsx per spec 4.2: status tabs, search, the eight columns including
  "Cap starts above" and "Kept", and a row action that really pauses the discount in Shopify.
  Note the build log finding: reading discounts back needs read_discounts, which §3.3 wrongly
  dropped. Add the scope and tell me if it forces a reinstall.
  Then app.discounts.$id.tsx (spec 4.4) for the detail page.
  Green when: I can pause a discount in the app and the checkout stops applying it.

Step 5 — The live preview. This is the argument for the whole product.
  The preview card from spec 4.3 item 9, but placed in the RIGHT COLUMN, sticky, under Summary —
  see spec section 12 item 2 for why. Slider, quick chips, the big number, the "instead of…" line,
  the two bars, the footer sentence. Instant and client-side.
  It must import the same cap.ts the Function uses. One implementation, never two.

Step 6 — Prove it works before sending it to anyone.
  app.test.tsx (spec 4.6) and the shared checkout preview modal (spec 4.9), which step 5's
  "See checkout view" button also opens.

Step 7 — Show what it did.
  Home (4.1), Analytics (4.5) and the Detail page's numbers, from real data: the orders/paid
  webhook and CapEvent rows per spec 3.5. All three views must reconcile to the same rows.
  Until real data exists, show the empty state. Never invent a number.
  read_orders is protected customer data and needs Partner Dashboard approval — tell me early.

RULES

- Verify every Shopify API with the shopify-dev-mcp server, or the local schema.graphql, which the
  build log notes is the better authority. Never from memory.
- Money is integers of minor units. Format only for display.
- Every screen needs its loading, empty and error states. A screen without them is not done.
- Use the exact wording in spec section 11. If you think a phrase is wrong, say so, don't fix it.
- npm run typecheck, npm run lint and npm test all pass before you call a step done, and say which
  you ran.
- Commit each step, then append to docs/BUILD-LOG.md: what you built, what you verified and how,
  what is left, and anything a future session needs.

STOP AND ASK ME when you need a real checkout, a Partner Dashboard action, a decision the spec
does not answer, or an API you cannot verify. Ending a turn with a question is a good outcome.

Start by telling me which step is open and what you are about to do.
```

---

## The dev-preview trap — read this before you reinstall anything

From the build log, 8 Sep: `shopify app dev` never changes the app's real `application_url`. It
creates a **dev preview** on the dev store and puts the tunnel URL inside it. **Uninstalling the
app destroys that preview**, and the reinstall falls back to the released version — which still
carries `application_url = "https://example.com"` because `shopify app deploy` has never run.

- If the app opens on Example Domain: quit `shopify app dev` and start it again. If that fails,
  `shopify app dev clean` then `shopify app dev`.
- Always reinstall **from a running dev session**, never from the Dev Dashboard while dev is stopped.
- An uninstall also deletes data tied to the preview — including discounts that reference the
  Function. After any reinstall, check the Discounts page before assuming `MAXOFF15` still exists.

Steps 2 and 4 both change `access_scopes`, which forces a reinstall. Expect to rebuild the test
discount afterwards with the validated mutation in the build log.
