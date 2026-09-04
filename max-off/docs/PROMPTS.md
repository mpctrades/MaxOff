# MaxOff — prompts for Claude Code

Copy a block, paste it into Claude Code in the VS Code terminal, from inside
`~/Desktop/MaxOff/max-off`. One prompt per work session. Start each new session with `/clear` so
the old context does not leak into the new task.

**Prompt 0 is the important one.** Run it once, at the very start. Everything after it is short,
because `CLAUDE.md` and `docs/BUILD-SPEC.md` are doing the explaining.

---

## How to work with Claude Code on this project

A few habits that make the difference between a good eight weeks and a bad one:

- **Plan before code.** For anything bigger than a one-file change, ask for a plan first and read
  it. Shift+Tab twice enters plan mode; it cannot edit files until you approve.
- **One task per session.** When a task is finished and committed, `/clear` and start the next.
  Long sessions drift — the model starts optimising for the conversation, not the codebase.
- **Never accept "this should work".** Ask: *how did you verify that?* Make it run
  `npm run typecheck`, run the tests, or show you the checkout result on the dev store.
- **Make it look things up.** This repo has the `shopify-dev-mcp` server wired in. If an answer
  about a Shopify API did not come from that server, treat it as a guess.
- **Correct drift immediately.** If it invents a feature, adds a dependency, or wanders out of V1,
  stop it in that message. Do not let it finish and fix it later.
- **Commit at every green point.** A working checkout that is not committed is a working checkout
  you are about to lose.
- **Update `CLAUDE.md` when you learn something permanent** — a decision, a gotcha, a command that
  works. That file is the project's memory across sessions.

---

## Prompt 0 · Orientation — run this first

```
Read CLAUDE.md, then docs/BUILD-SPEC.md end to end, then open docs/MaxOff-mockup.html and
read its markup — it is the approved UX for all eight screens and the cap maths in its
JavaScript is correct.

Context: I'm Sophea at MPC Trades. Over the next 8 weeks I'm building MaxOff, a Shopify app
that puts a hard maximum on a percentage discount — "15% off, but never more than $150".
Shopify has no native way to do this. You and I are building it together in this repo. Arthur
reviews it at four demos, one every two weeks.

This repo is already scaffolded from the Shopify React Router app template. Nothing
MaxOff-specific has been written yet — extensions/ is empty and app/routes/ is still the
template's demo pages.

Do NOT write any code yet. Instead, do this:

1. Explore the repo and tell me what is actually here: the framework version, how routing
   works, what UI library the template uses (look at app/routes/app.tsx carefully — I believe
   it is Polaris web components, not the Polaris React package, and I want you to confirm or
   correct me), how auth and sessions work, and what in shopify.app.toml is template demo
   cruft we will have to delete.

2. Using the shopify-dev-mcp server that is configured in .mcp.json, verify the technical
   heart of the plan and report back on each point separately:
   - What is the current target and API shape for a discount Shopify Function? Is
     `cart.lines.discounts.generate.run` correct for the API version we are on?
   - Can a discount Function express "percentage off, but never more than a fixed amount"?
     Show me the exact mechanism. This is the single question that can kill the project, so
     be precise and cite the docs you found.
   - How should an app-owned discount store its configuration so the Function can read it at
     checkout — a metafield on the discount node, or something else?
   - Which GraphQL mutation creates a code discount that runs an app's Function?
   - Which access scopes do we need, and is read_orders protected customer data?
   - Is Managed Pricing the current recommendation for App Store billing?

3. Tell me honestly where the spec in docs/BUILD-SPEC.md is wrong, out of date, or making an
   assumption the docs do not support. I would much rather fix the spec now than discover it
   in week 5.

4. Give me a plan for weeks 1–2 (the spike) as a short numbered list of commits.

Rules for this whole project, which I will hold you to:
- Never invent a Shopify API. If it did not come from shopify-dev-mcp, say you are unsure.
- Never guess to fill a gap. Ask me, or look it up.
- Build only what is tagged V1 in the spec. V2 and PRO features are rendered as visible,
  disabled controls — never as working code.
- Money is integers of minor units in code; format only for display.
- Small commits, one concern each. typecheck and lint pass before you say something is done.
- If you disagree with the spec, say so before you build, not after.

Answer in plain English. I am a competent developer but new to Shopify apps, so explain the
Shopify-specific parts properly rather than assuming.
```

When it answers, read point 2 carefully and change `docs/BUILD-SPEC.md` where it turned out to be
wrong. Then commit the docs.

---

## Weeks 1–2 · The spike → Demo 1

### Prompt 1.1 — generate and deploy the Function

```
Week 1 of the plan: the spike. The only goal is to prove that a Shopify Function can cap a
percentage discount at a fixed maximum, on a real checkout, on the dev store
maxoff-s7fqtwdd.myshopify.com. No admin UI work this week.

Generate the discount function extension into extensions/ and name it max-off-cap. Walk me
through the CLI command rather than guessing at the files — tell me what to run and what to
pick from the prompts, then we look at what it produced together.

Hard-code 15% and a 150.00 cap for now; reading real config is week 3.

Before you write the function logic, show me the input query and the output shape you plan to
use and explain in plain English how the cap gets applied. Confirm both against
shopify-dev-mcp. I want to understand this, not just have it working.
```

### Prompt 1.2 — prove it at checkout

```
Now let's prove it. Walk me through, step by step:
1. deploying the function to the dev store
2. creating a discount in the Shopify admin that runs it
3. building a 1,400 cart and going through checkout

Expected: the discount is 150.00, not 210.00. Then a 700 cart should give the full 105.00.

Tell me exactly what to click and what to look for. If the result is wrong, do not start
changing code — first help me capture the function's input and output JSON so we can see what
it actually received. That evidence is what I take to Arthur.
```

### Prompt 1.3 — write it down

```
The spike works. Before we move on:
1. Write the cap arithmetic as a shared TypeScript module the admin UI will also use later —
   given(subtotalMinor, pct, capMinor), kept(...), breakEven(pct, capMinor). Integers of minor
   units, half-up rounding to the cent, applied once.
2. Write unit tests for it covering exactly the table in section 8 of docs/BUILD-SPEC.md.
3. Add a section to CLAUDE.md called "How the Function works" — 10 lines, in plain English,
   covering the target, where config comes from, and how rounding is handled. Future sessions
   will read this instead of re-deriving it.
4. Commit.

Then tell me in one paragraph, in words I could say out loud to Arthur, how the function
decided to give 150 instead of 210.
```

---

## Weeks 3–4 · Real create form and list → Demo 2

### Prompt 3.1 — clean the template out

```
Time to clear the template's demo code out of the way. Read docs/BUILD-SPEC.md sections 3.3
and 4 first.

1. In shopify.app.toml: replace the access scopes with what MaxOff actually needs
   (write_discounts, read_discounts, read_orders — confirm against shopify-dev-mcp first) and
   delete the [product.metafields.app.demo_info] and [metaobjects.app.example] blocks.
2. Delete the snowboard-creating demo action from app/routes/app._index.tsx and delete
   app/routes/app.additional.tsx.
3. Replace the <s-app-nav> links in app/routes/app.tsx with MaxOff's eight screens as listed
   in section 4 of the spec, and create empty route files for each one that render just a
   page title. I want to be able to click through the whole nav before any screen is real.
4. Add the Prisma models from section 3.4 of the spec and generate the migration. Show me the
   migration before you run it.

Explain what changing the scopes means for the app already installed on the dev store — will
I need to reinstall?
```

### Prompt 3.2 — config from the metafield

```
Move the cap out of the hard-coded function and into the discount's metafield, as described
in section 3.1 of docs/BUILD-SPEC.md. Verify the metafield namespace/key/type rules with
shopify-dev-mcp before you implement — I don't want to find out in week 6 that app-reserved
namespaces work differently.

The function should read percentage, capAmount and scope from the config and behave exactly
as before when the values are 15 and 150. If the config is missing or malformed, the function
must apply no discount at all rather than an uncapped one — a bug must never cost the merchant
money. Add that as a test case.

Then walk me through re-deploying and re-testing on the dev store.
```

### Prompt 4.1 — the create form

```
Build the create screen: app/routes/app.discounts.new.tsx. Read section 4.3 of
docs/BUILD-SPEC.md and open the "Create" screen in docs/MaxOff-mockup.html before you start —
match its structure, its card order, and its exact wording.

This session, build the form and make Save work. The live preview card is the next session,
so leave a placeholder card where it goes.

- Polaris web components only. No new dependencies.
- Two columns, sticky Summary on the right that updates as I type.
- The V2 and PRO controls are rendered, visible and disabled, with their badges.
- Validation on the fields, not in a banner: percentage 1-100, maximum > 0, end after start,
  code unique in the shop.
- Saving writes a real code discount to Shopify with our cap metafield, mirrors it to Prisma,
  toasts "SUMMER15 is live at checkout", and goes to the list.
- Use the App Bridge contextual save bar, not a button floating in the page.

Show me the GraphQL mutation you intend to use and where you got it before you write the
action.
```

### Prompt 4.2 — the list

```
Build app/routes/app.discounts._index.tsx per section 4.2 of the spec and the "Capped
discounts" screen in the mockup.

Status tabs, search by code, the eight columns including "Cap starts above" and "Kept", the
status pill, and a per-row Pause/Activate that actually pauses the discount in Shopify.
Pause is optimistic in the UI, reverted with an error toast if the mutation fails.

Method and Cap type filters are V2 — render them disabled.
Export button just toasts "Export is a Pro feature".
Every tab needs its empty state with the wording from the spec.

Where does "Kept" come from before we have the orders webhook? Answer that before you build
it — I would rather show a dash than a fake number.
```

### Prompt 4.3 — Demo 2 rehearsal

```
Demo 2 is tomorrow. Play the sceptical reviewer for me.

Walk the full path yourself and tell me what is broken or unconvincing: install → create
SUMMER15 in the app → check it appears in Shopify's own Discounts page → checkout a 1,400
cart → pause it in the list → checkout again and confirm the discount no longer applies.

For anything broken, tell me severity and how long a fix takes. Do not fix anything yet —
I want the list first so I can decide what to fix and what to mention in the demo.
```

---

## Weeks 5–6 · Preview, money kept, polish → Demo 3

### Prompt 5.1 — live preview

```
Build the live preview card on the create form — section 4.3 item 9 of the spec, and the
"Live preview" card in the mockup. Its JavaScript there is correct; port the behaviour, not
the CSS.

Slider 50-3000, quick chips at 200 / 800 / 1,400 / 2,500, the big discount number, the
"instead of ..." line, the two comparison bars scaled to the larger of the two values, and the
footer sentence. All of it instant and client-side, using the shared calc module from week 1 —
do not write a second implementation.

Use the exact strings from section 11 of the spec.
```

### Prompt 5.2 — cart tester and checkout preview

```
Build app/routes/app.test.tsx (section 4.6) and the shared checkout preview modal (section
4.9), which the create form's "See checkout view" button also opens.

Tell me first whether we can load a few real products from the store cheaply for the test
basket, or whether we should seed a sample basket like the mockup does. I would prefer real
products if it does not cost us an extra scope.
```

### Prompt 5.3 — the money-kept pipeline

```
This is the one that makes the product provable. Build the orders/paid webhook and the
analytics it feeds — sections 3.5 and 3.4 of the spec.

Handler: find our discount among the order's discount applications, compute what the uncapped
percentage would have been, compare with what Shopify actually applied, and write a CapEvent
when we saved money. Idempotent on orderGid. Update the CappedDiscount totals.

Before you code: tell me what happens on a refund or a partial cancellation, and what happens
if the merchant edits the discount after orders have used it. I want to know we are not going
to report numbers that quietly become wrong.

Then seed a way for me to test this without placing 20 real orders.
```

### Prompt 5.4 — dashboard, detail, analytics

```
Build the three reporting screens from real data: Home (4.1), Detail (4.4) and Analytics
(4.5). Read those sections and open each screen in the mockup.

Includes the setup guide with its progress bar, the four stat tiles on each of Home and
Detail, and the 8-week bar chart. The chart is inline SVG — 8 bars, two gridlines, tallest bar
labelled, others at 55% opacity, tooltip on hover, and a text alternative. Do not add a
charting library.

Brand orange (#ea580c fills, #c2410c text) only on the kept/branded elements listed in section
5. Everything else stays Polaris default.

Every screen needs its empty state for a store with no data yet. Show me those first — a new
merchant sees them before they see anything else, and they are what the mockup is weakest on.
```

### Prompt 5.5 — polish pass

```
Polish pass before Demo 3. Go screen by screen against docs/BUILD-SPEC.md and the mockup, and
give me a table of every difference you find: screen, what the spec says, what we built,
severity.

Check specifically: loading states, error states, empty states, the exact wording from section
11, keyboard navigation, focus visibility, labels on every control, readability at 200% zoom,
and that no number on screen is hard-coded.

List first, fix after I choose. Do not fix as you go.
```

---

## Weeks 7–8 · Billing, listing, submission → Demo 4

### Prompt 7.1 — billing

```
Implement billing per section 3.6 of docs/BUILD-SPEC.md. Check with shopify-dev-mcp whether
Managed Pricing or the billing API is the right choice for three flat plans with no usage
component, then recommend one and tell me why.

Build app/routes/app.billing.tsx to match the mockup: three plan cards with the current one
outlined, the "kept 1,240.00 USD ... 248x the subscription" banner computed from real data,
and the footer line.

Enforce exactly one limit in code: Free = 1 active capped discount. When a Free merchant tries
to create a second one, explain it in the create form rather than failing on save.

Everything else is a gate on features that do not exist yet — do not build the gates.
```

### Prompt 8.1 — submission readiness

```
We submit this week. Act as an App Store reviewer who wants to reject us and tell me every
reason they could use.

Check against Shopify's current app requirements via shopify-dev-mcp: performance, embedded
app behaviour, OAuth and session handling, webhook mandatory topics including the GDPR ones,
uninstall cleanup, error handling, accessibility, and anything about discount functions
specifically.

Give me a checklist with pass/fail/unknown and what each fix costs. Be harsh. I would rather
fail here than in review.
```

### Prompt 8.2 — the listing

```
Write the App Store listing copy: name, tagline, the full description, the feature bullets,
and a shot list of screenshots with a caption for each.

Positioning from CLAUDE.md: a ceiling, a limit, a stop line. Not "biggest sale in town". No
coupon clichés. The break-even idea — "your cap starts working above 1,000" — is our
differentiator and should appear early.

Plain merchant English, short sentences, no exclamation marks. Write the description twice, at
two different lengths, so I can pick.
```

---

## Reusable prompts

### Something is broken

```
Symptom: <what I see>
Expected: <what should happen>
Where: <screen / file / checkout>

Do not change any code yet. Find the cause first and tell me what it is and how you know.
If you need to see the function's input or a network response, tell me how to capture it.
Then propose the smallest fix, and tell me if it is a symptom of something structural.
```

### Review before I commit

```
Review the current diff against docs/BUILD-SPEC.md and the rules in CLAUDE.md.

Look for: money handled as floats, cap logic duplicated instead of using the shared module,
V2/PRO features accidentally made functional, invented Shopify APIs, missing loading/empty/
error states, copy that drifted from section 11, hard-coded numbers, and anything that would
fail App Store review.

Rank by severity. Tell me what you would fix before committing and what can wait.
```

### It has drifted

```
Stop. You are building something I did not ask for.

Re-read CLAUDE.md and the relevant section of docs/BUILD-SPEC.md. Then tell me, in three
sentences: what I actually asked for, what you built instead, and what you are going to do
about it. Do not touch any files until I answer.
```

### Demo rehearsal

```
Demo <n> is tomorrow. Walk the acceptance criteria for it from section 7 of
docs/BUILD-SPEC.md as if you were Arthur seeing this for the first time.

Tell me what is broken, what looks unfinished, and what he is most likely to poke at. Rank by
what would embarrass me most. List only — I will choose what to fix.
```

### End of session

```
Before I close this session:
1. Commit what is done, one concern per commit.
2. Update CLAUDE.md with anything permanent we learned today — a decision, a gotcha, a command
   that works. Keep it short; that file is read every session.
3. Tell me in three lines where we are against the week's goal and what the next session
   should start with.
```
