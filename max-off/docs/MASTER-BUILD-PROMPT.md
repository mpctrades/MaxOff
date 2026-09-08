# MaxOff — master build prompt

Paste the block below at the start of **every** build session. It is the same text every time.
It reads `docs/BUILD-LOG.md` to work out where the build is and drives the next gate.

Before pasting: `/clear`, and check you are in `~/Desktop/MaxOff/max-off`.

---

```
You are building MaxOff to production quality. It will be submitted to the Shopify App Store
and used by real merchants handling real money, so "works on my machine" is not the bar.

FIRST, ORIENT YOURSELF
Read, in this order: CLAUDE.md, docs/BUILD-SPEC.md, and docs/BUILD-LOG.md.
If docs/BUILD-LOG.md does not exist, create it and we are starting at Gate 1.
The log tells you which gate is open. Work only on that gate. Do not skip ahead, and do not
"quickly also do" a later gate because you are already in the file.

Open docs/MaxOff-mockup.html and read the markup for any screen you are about to build.
Section 12 of the spec lists five things the mockup gets WRONG — build the corrections,
not the mockup, for those five.

THE GATES

Gate 1 — The cap works at checkout.
  A discount Shopify Function in extensions/max-off-cap, cap hard-coded at 15% / 150.
  Exit test (I run it, you cannot): a real checkout on maxoff-s7fqtwdd.myshopify.com takes
  150.00 on a 1,400 cart and 105.00 on a 700 cart.
Gate 2 — The cap is configurable.
  Config read from the discount's metafield. Missing or malformed config applies NO discount,
  never an uncapped one. Shared calc module + unit tests passing the table in spec section 8.
Gate 3 — Merchants can create and manage discounts.
  Create form and list, writing real discounts to Shopify, mirrored to Prisma. Template demo
  code and demo scopes deleted. Exit test: I create a code in the app, it appears in Shopify's
  own Discounts page, it caps at checkout, and pausing it stops it.
Gate 4 — Merchants can see what it will do.
  Live preview (in the right column, sticky — see spec section 12 item 2), cart tester,
  checkout preview modal. All using the Gate 2 calc module. No second implementation.
Gate 5 — Merchants can see what it did.
  orders/paid webhook writing CapEvent rows, idempotent. Home, Detail and Analytics reading
  real data. All three views must reconcile to the same rows.
Gate 6 — Merchants can pay.
  Billing, three plans, Free limited to 1 active capped discount.
Gate 7 — Review readiness.
  Mandatory GDPR webhooks (customers/data_request, customers/redact, shop/redact), uninstall
  cleanup, error and empty states everywhere, accessibility pass, App Store listing copy.

HOW YOU WORK, EVERY TIME

1. Say which gate you are on and what you are about to do. One short paragraph.
2. Plan before you code anything that touches more than one file. Show me the plan.
3. Build it.
4. Verify it yourself: npm run typecheck, npm run lint, and the unit tests. Never tell me
   something is done without saying which of these you ran and what they said.
5. Commit, one concern per commit.
6. Append to docs/BUILD-LOG.md: date, gate, what you built, what you verified and how, what is
   left in this gate, and anything a future session must know. Keep it factual and short.
7. Stop and tell me clearly if you need me — see below.

WHEN TO STOP AND ASK ME

Stop, say exactly what you need, and wait. Do not work around these:
  - Anything requiring a real checkout, a deployed function, or the dev store UI.
  - Partner Dashboard work: access scope approvals, read_orders protected data approval,
    Managed Pricing plan setup, submission.
  - A Shopify API that shopify-dev-mcp does not confirm.
  - A decision the spec does not answer.
  - Anything that would cost a merchant money if it were wrong and you are not certain.
Ending a turn with a question is a good outcome. Guessing is not.

HARD RULES

- Never invent a Shopify API. Verify with the shopify-dev-mcp server in .mcp.json. If it did
  not come from there, say you are unsure.
- Never install @shopify/polaris. This template uses Polaris web components (<s-page>,
  <s-button>). Shopify's own template page confirms this.
- Money is integers of minor units in code. Format only for display. No float arithmetic.
- The Function is the only thing that decides money at checkout. The admin only previews the
  same arithmetic, from the shared module.
- Build only V1. V2 and PRO features are visible, disabled controls with their badge.
- No placeholder data reaches a screen I could ship. If real data is not available yet, show
  the empty state, not an invented number.
- No screen is done without its loading, empty and error states.
- If you disagree with the spec, say so before building, not after.

WHAT "DONE" MEANS FOR THE WHOLE PROJECT

I can install the app on a fresh store, create a capped discount, watch it cap a real checkout,
see the money it kept, choose a plan, and uninstall it cleanly — without reading documentation
and without seeing a single number that is not real.

Now: read the log, tell me which gate is open and what the next step is, and start.
```

---

## What you have to do yourself

No agent can do these. They are the reason this takes eight weeks and not one evening.

| Gate | Your job |
|---|---|
| 1 | Run `npm run dev`, deploy the function, create a discount in the Shopify admin, put a 1,400 cart through checkout, and report the number you saw. |
| 3 | Confirm the discount appears in Shopify's own Discounts page and still caps. |
| 5 | Request `read_orders` protected customer data access in the Partner Dashboard. Allow days, not hours. |
| 6 | Create the three Managed Pricing plans in the Partner Dashboard. |
| 7 | Take the screenshots, write the privacy policy, submit for review. |
| Any | Answer its questions. A session that stops with a question is working correctly. |

## Why one session will not do this

Each gate is roughly a week of real work, and context degrades long before a gate is finished.
The build log is what makes the single prompt work: it turns eight weeks of sessions into one
resumable process. Start a fresh session for each gate — and for each half of a gate if it runs
long. `/clear`, paste the prompt, it reads the log, it continues.

Use Opus for gates 1, 2 and 7 (the parts where being wrong is expensive) and Sonnet for
gates 3–6 (screen building, where the spec already made the decisions).
