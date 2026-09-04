@AGENTS.md

# MaxOff — project memory

Read this first, every session. Then read `docs/BUILD-SPEC.md` before writing any code.
`docs/PROMPTS.md` holds the phase-by-phase build prompts. `docs/MaxOff-mockup.html` is the
approved UX — open it in a browser to see any screen you are about to build.

## What we are building

MaxOff is a **Shopify app for merchants** that puts a hard maximum on a percentage discount:
*"15% off, but never more than $150."* Shopify has no native equivalent. The app protects the
merchant's margin when a large order turns a percentage into a painful dollar amount.

The whole product is one formula:

```
discount = min(cartSubtotal × percentage / 100, cap)
```

And one derived number that we surface everywhere, because no competitor does:

```
breakEven = cap ÷ (percentage / 100)      // 15% with a 150 cap → 1,000
```

`breakEven` is the cart size where the cap starts to bite. In the UI it is called
**"Cap starts above"**. Never call it "break-even" in merchant-facing copy.

## Who this is for

Sophea (MPC Trades, Phnom Penh) builds it. Arthur reviews it at four demos across eight weeks.
The merchant using it is a Shopify store owner inside their Shopify admin.

## Stack — as actually scaffolded in this repo

Do not assume; this template is newer than most tutorials you have seen.

| Thing | Reality here |
|---|---|
| Framework | **React Router 7** (`@react-router/*` v7). This template was formerly Remix — Shopify renamed it. Do not import from `@remix-run/*`. |
| Routing | `flatRoutes()` from `@react-router/fs-routes` — files in `app/routes/`, dots are slashes (`app.discounts.$id.tsx` → `/app/discounts/:id`). |
| UI | **Polaris web components** via App Bridge: `<s-page>`, `<s-section>`, `<s-button>`, `<s-text-field>`, `<s-table>`… The `@shopify/polaris` React package is **not installed and must not be added.** Types come from `@shopify/polaris-types`. |
| App Bridge | `@shopify/app-bridge-react` v4 (`useAppBridge`, `shopify.toast.show(...)`, `shopify.saveBar`, `shopify.modal`). |
| Auth / server | `@shopify/shopify-app-react-router` — `authenticate.admin(request)` in every loader and action. |
| Sessions | Prisma + SQLite (`prisma/dev.sqlite`) in dev. |
| Admin API | `ApiVersion.July26` in `app/shopify.server.ts`; webhooks pinned to `2026-10` in `shopify.app.toml`. If you change one, understand why before touching the other. |
| Cap engine | A **Shopify Function** (discount) in `extensions/` — not yet generated. |
| Dev store | `maxoff-s7fqtwdd.myshopify.com` |
| Hosting | MPC VPS, later. Not a week-1 concern. |

`.mcp.json` already registers the **`shopify-dev-mcp`** server. Use it.

## Non-negotiable working rules

1. **Never invent a Shopify API.** Before you write a GraphQL mutation, a Function target name,
   a webhook topic, or a Polaris web-component tag, look it up with the `shopify-dev-mcp` tools
   (`search_docs_chunks`, `introspect_graphql_schema`, `validate_graphql_codeblocks`). If the
   MCP server is unavailable, say so and stop — do not guess and do not fall back to memory.
2. **The Function is the source of truth for money.** Never compute a discount in the admin UI
   and write the result anywhere a buyer can see. The admin only *previews* the same arithmetic.
3. **No theme code, ever.** MaxOff adds nothing to the merchant's theme. If a solution needs a
   script tag or a theme app extension, it is the wrong solution — stop and ask.
4. **Money is integers of minor units** (cents) everywhere in code. Format for display only, at
   the edge. No floats in the Function, no `toFixed` arithmetic.
5. **Amounts relabel, they never convert.** A 150 cap is 150 USD or 150 EUR depending on the
   store's currency. There is no FX conversion anywhere in V1.
6. **V1 scope is closed.** Anything tagged V2 or PRO in the spec is built as a visible, disabled
   affordance — never as working code — unless Sophea says otherwise in writing.
7. **Run `npm run typecheck` and `npm run lint` before you tell me something is done.** "Done"
   means it compiles, it lints, and you have said in one line how you verified the behaviour.
8. **Small commits, one concern each.** Message format: `feat(create): live cap preview`.
   Do not commit `node_modules`, `.env`, `prisma/dev.sqlite`, or `.shopify/`.
9. **Ask before**: adding a dependency, changing `access_scopes`, changing the Prisma schema in a
   way that needs a destructive migration, or deploying anything.
10. **Do not edit `docs/MaxOff-mockup.html`.** It is a frozen reference.

## Voice of the product

Plain, calm, merchant English. Short sentences. No exclamation marks, no marketing shouting, no
discount clichés. Say what a number means, not just the number.

Locked phrases — use these exact words in the UI:

- "Percentage discounts that stop at a maximum amount."
- "Maximum discount" (never "cap" in a label; "cap" is fine in our code and in prose like "hit the cap")
- "Cap starts above 1,000.00 USD"
- "Money you kept"
- "You keep 60.00 USD on this order."
- "Capped at maximum amount" (the checkout note)
- "MaxOff adds nothing to your theme."

## Where things are

```
max-off/
  app/routes/            React Router routes (the admin UI)
  extensions/            Shopify Functions — the cap engine lives here
  prisma/schema.prisma   Sessions + our own tables
  docs/BUILD-SPEC.md     The full product + technical spec  ← read before coding
  docs/PROMPTS.md        Kickoff + per-phase prompts
  docs/MaxOff-mockup.html  Approved UX, all 8 screens, real cap maths
  shopify.app.toml       App config, scopes, webhooks
```

## The cap mechanism — resolved 4 Sep 2026

Week 1 is no longer a question of *whether*. Verified against the 2026-10 Discount Function API:

- Target `cart.lines.discounts.generate.run`, discount class `ORDER`.
- `OrderDiscountCandidateValue` is a union of **`FixedAmount`** and **`Percentage`**. There is no
  "percentage constrained by a maximum" — you do the `min()` yourself and emit a **fixed amount**.
- `cart.cost.subtotalAmount` is in the input, so the Function can see the cart total.
- *"All discount functions run concurrently, and have no knowledge of each other"* — so we cap our
  own candidate and literally cannot touch anyone else's. The combinations promise is structural.

Full detail, including the code shape, is in `docs/BUILD-SPEC.md` §3.2. Week 1 now proves an
implementation, not a possibility.

**⚠ The Discounts Allocator is a trap.** Shopify's "Build a Discounts Allocator Function" tutorial
caps a discount from a metafield and looks exactly like MaxOff. Do not use it: `unstable` API,
Shopify **Plus only**, needs `write_discounts_allocator_functions`, and it *replaces the shop's
entire discount engine*. If a session proposes it, stop and re-read §3.2.

**Still open, answer it in week 2:** the schema says the subtotal is before *cart-level* discounts
and is silent on *line-level* ones. So when a product discount is also on the cart, we do not know
whether our 15% is computed on the full subtotal or the reduced one. Test it on the dev store,
capture the input JSON, write the answer into §3.2. Cheap now, expensive in week 6.

## When `shopify-dev-mcp` will not connect

It happens — `npx -y @shopify/dev-mcp@latest` can hang on the registry and the server times out.
That is a connection failure, not a missing capability, and it does **not** license guessing.

Fallback, which queries the same shopify.dev index and is what `AGENTS.md` points at anyway:

```
node ~/.claude/plugins/cache/claude-plugins-official/shopify-ai-toolkit/*/skills/<skill>/scripts/search_docs.mjs \
  "<query>" --version 2026-10 --model <model> --client-name claude-code --client-version 2.0
```

Pick the skill that matches the domain — `shopify-functions`, `shopify-admin`, `shopify-dev` (the
general one; use it for billing, protected customer data, App Store policy). The search is scoped
per skill, so a Functions question asked of the `shopify-admin` skill returns junk. For exact
schema wording, fetch the reference page directly — the vector search paraphrases, the page does
not.
