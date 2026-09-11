# Build spec — MaxOff marketing site

Build the MaxOff early-access website as a single self-contained HTML file.

**Output:** `maxoff-website/index.html` (create the folder if it does not exist). One file. No build step, no framework, no npm packages. Inline all CSS in one `<style>` block and all JS in one `<script>` block at the end of `<body>`. The only external requests allowed are Google Fonts and the form endpoint in §6.

---

## 1. What MaxOff is

A Shopify app that adds a **maximum amount** to a percentage discount. "15% off, but never more than 150." Shopify has no native way to do this. The app runs as a Shopify Function inside Shopify's own checkout — no theme code, no storefront JavaScript.

Working title. Not on the Shopify App Store yet. Early access is free. An MPC Trades app, sister product to Shuffly (shuffly.mpctrades.com) — the page structure deliberately mirrors that site.

Audience: Shopify merchants who are scared to run generous promo codes because one big basket destroys their margin.

**Contact email, used everywhere on the page:** `team@mpctrades.com`. No other email address appears anywhere in the file.

---

## 2. Design tokens — use these exact values

Define them as CSS custom properties on `:root` and reference them everywhere. **Never hardcode a colour outside `:root`.**

```css
:root{
  color-scheme:light;

  --ink:#141210;        /* primary text */
  --ink-2:#4a433d;      /* body text */
  --ink-3:#7d746c;      /* muted / captions */
  --paper:#ffffff;
  --paper-2:#faf7f4;    /* alternating section background */
  --paper-3:#f3ede7;
  --line:#e6ded6;
  --line-2:#d4c8bc;

  --orange:#c2410c;         /* orange for TEXT — passes contrast on white */
  --orange-bright:#ea580c;  /* orange for FILLS — buttons, bars, badges */
  --orange-soft:#fff2e8;    /* tinted panel background */
  --orange-line:#f8c39a;    /* border on tinted panels */

  --black:#141210;
  --black-2:#241f1b;

  --ok:#166534;   /* ✓ in the comparison table only */
  --no:#b42318;   /* ✕ in the problem cards only */

  --wrap:1120px;
  --r:14px;
}
```

**Light mode only.** Do NOT add `prefers-color-scheme: dark`, do NOT add a `[data-theme]` attribute, do NOT add a theme toggle. The page must render white even when the visitor's OS is set to dark.

Colour discipline: orange and black are the brand. Green and red appear **only** as the ✓ / ✕ marks described above. Nothing else is coloured.

## 3. Type

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Inter:wght@400;450;500;600&family=JetBrains+Mono:wght@500;700&display=swap">
```

- **Archivo** 700/800, `letter-spacing:-.03em`, `text-wrap:balance` — all headings and big numbers.
- **Inter** 400–600 — all body text, buttons, form fields. Body 16px / line-height 1.6.
- **JetBrains Mono** 700 — eyebrow labels, section numbers, discount codes, the email address. Uppercase with `letter-spacing:.14em`.
- Always give a real fallback stack (`Archivo, Inter, sans-serif` etc.).
- Use `font-variant-numeric: tabular-nums` on every figure that sits in a column or updates live.

Section headings: `font-size: clamp(28px, 4vw, 44px)`, `max-width: 20ch`.
Hero heading: `font-size: clamp(36px, 5.6vw, 60px)`, `line-height: 1.02`, weight 800.

## 4. Layout

- Content container `max-width:1120px`, `padding:0 24px`, centred.
- Sections `padding:88px 0`, dropping to `56px` under 720px.
- Alternate section backgrounds: white, then `--paper-2` with a 1px `--line` border top and bottom, then white, and so on.
- Every section opens with an eyebrow: a mono uppercase orange label preceded by a two-digit number in an orange chip — `01 THE PROBLEM`, `02 HOW IT WORKS`, and so on through `08`. The numbers are real: the sections are meant to be read in order.
- Responsive down to 360px. No horizontal scrolling on the body — any wide table scrolls inside its own `overflow-x:auto` container.
- Respect `@media (prefers-reduced-motion: reduce)` — disable transitions.
- Visible focus ring on every interactive element (`:focus-visible` with an orange outline).

---

## 5. Sections, in order

### Sticky nav
White, 88% opacity, `backdrop-filter: blur(10px)`, 1px bottom border, 62px tall.
Left: logo mark + wordmark "MaxOff" in Archivo 800. The mark is a 26px black rounded square built with CSS pseudo-elements: an orange bar across the bottom and a thin white line near the top — a discount bar hitting a ceiling. No image file.
Centre-right: text links — The problem, How it works, Features, Compare, Pricing, FAQ. Hidden below 860px.
Right: a black "Get in touch" button linking to `#contact`.

### Hero — black band
Two columns (`1.05fr / .95fr`), stacking under 940px. Background `--black`, plus a soft orange radial glow at 78% 12% via an `::after` overlay.

Headline, two lines, second line orange on its own line:
> Percentage discounts,
> **with a ceiling.**

Sub-paragraph:
> Run 15% off without handing 300 dollars to the one customer who fills their basket. MaxOff caps the discount at the maximum you set — inside Shopify's own checkout, on every theme.

Buttons: orange "Get early access" (→ `#contact`), outlined "See how it works" (→ `#how`).

Three assurances in a row, each with an orange ✓: *Works with every theme* · *Nothing added to your storefront* · *Uninstall-safe*.

**Right column — the live calculator. This is the most important element on the page.** A white card with a heavy shadow, floating on the black.
- Mono label: `TRY IT — THIS IS THE WHOLE PRODUCT` with a small pulsing orange dot.
- Two number inputs side by side: **Discount** (default 15, suffix %) and **Maximum** (default 150, suffix USD).
- A range slider for the customer's cart: min 50, max 3000, step 10, default 1400. The value shows above it, formatted `1,400.00`.
- Two horizontal bars sharing one scale (`max(fullDiscount, cap)`):
  - "No cap" — a pale red diagonal-stripe fill, the discount with no maximum.
  - "With MaxOff" — a solid `--orange-bright` fill, the capped discount.
  Each bar has its amount right-aligned in tabular figures.
- A tinted `--orange-soft` verdict box below.

Maths — this is the entire product, get it exactly right:
```js
full  = cart * pct / 100
given = Math.min(full, cap)
kept  = full - given
breakEven = cap / (pct / 100)   // the cart size where the ceiling starts
```
Verdict copy when `kept > 0.004`: `You keep <b>60.00 USD</b> on this single order.`
Verdict copy when it is under the cap: `Under your maximum — the customer gets the full 15%. The ceiling starts above <b>1,000.00 USD</b>.`
Recalculate on every `input` event on all three controls, and once on page load so the card is never blank.
Format money with `toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})`.

### 01 — The problem
Heading: **A generous code and a big basket are the same thing**
Lede: Shopify has never let you put a ceiling on a percentage discount. Merchants have been asking for it in the community forums for years. Every workaround costs you something.

Four cards in a hairline grid (4 → 2 → 1 columns). Each has a small red mono label, a heading, and two sentences:
1. `✕ NATIVE` — **No cap in Shopify.** Support confirms it, repeatedly, with no timeline. A percentage code applies to whatever the cart happens to be.
2. `✕ MARGIN` — **One order eats ten.** An influencer code of 20% on a 1,500 basket gives away 300. You meant a nice gesture, not a hole in the P&L.
3. `✕ WORKAROUND` — **Fixed-amount juggling.** Mixing a percentage code with automatic fixed-amount discounts is fragile, confusing to staff, and often just doesn't fire.
4. `✕ SCRIPTS` — **Scripts are gone.** It was possible on Shopify Plus at 2,000+ a month. Scripts are deprecated, so even that door is closing.

Below, a black panel: on the left, `min(%, cap)` in Archivo 800 at 44px in orange; on the right — **MaxOff runs inside Shopify's own discount engine.** A Shopify Function calculates the discount at checkout and stops it at your maximum. The buyer sees one clean discount line. Your theme is never touched.

### 02 — How it works  *(background `--paper-2`)*
Heading: **Install to a working capped code in under three minutes**

Two columns. Left, six numbered steps separated by hairlines, each a bold title and one sentence:
1. Write the code — a discount code like SUMMER15, or an automatic discount with no code at all.
2. Set the percentage and the maximum — 15% off, never more than 150. MaxOff immediately tells you the cart size where the ceiling starts working.
3. Add the usual controls — start and end dates, usage limits, one-per-customer, which products it applies to, what it combines with.
4. Test before you send it out — build a basket in the cart tester and see the buyer's checkout side by side, with and without the cap.
5. Shopify applies the cap at checkout — server-side, on every order, on every theme. Nothing is added to your storefront.
6. Watch what you kept — every capped order is logged with the amount the cap saved you, per code and per month.

Right, a small fake admin window: a black title bar with three dots and the label `MaxOff — capped discounts`, then a table with columns Code / Rule / Cap starts above / Kept:

| SUMMER15 | 15% · max 150 | 1,000.00 | 612.40 |
| VIP20 | 20% · max 80 | 400.00 | 388.20 |
| WELCOME10 | 10% · max 25 | 250.00 | 139.40 |
| BF30 *(Scheduled pill)* | 30% · max 200 | 666.67 | — |

Codes in mono, "Kept" right-aligned in orange bold. Underneath, a tinted strip: *This month MaxOff kept 1,240.00 USD across 87 capped orders.*

### 03 — Features
Heading: **Built to do one thing perfectly**
Lede: Other discount apps do forty things and make you find the one you need. MaxOff has one screen, three fields, and no transaction fees.

Four bordered cards, 2×2. Each: a mono letter key (A–D), a title, one summary line, then 3–4 bullets marked with an orange em-dash.
- **A · Compatibility** — Runs as a Shopify Function inside the native discount system. Works with every theme including headless; discount codes and automatic discounts; combines with shipping and product discounts; zero theme code.
- **B · Speed** — Server-side only. No storefront JavaScript, no layout shift; the cap is calculated by Shopify at checkout; no external database in the request path.
- **C · Control** — Maximum per order or per item on Pro; start and end dates, usage limits, one per customer; campaign budget that stops the code once it has given away a total; your own wording under the discount line at checkout.
- **D · Proof** — Money kept per code and per month; every capped order listed with the amount saved; live preview while you type; cart tester showing the buyer's checkout before you launch.

### 04 — Compare  *(background `--paper-2`)*
Heading: **Why not one of the other options**

A table, `min-width:660px` inside an `overflow-x:auto` wrapper. Columns: (blank) · **MaxOff** · Shopify native · Fixed-amount workaround · Big discount suites.
The MaxOff header cell is black with white text; the MaxOff column cells have an `--orange-soft` background and bold orange marks. `✓` in green, `—` in muted grey, `~` in muted grey bold.

| Row | MaxOff | Native | Workaround | Suites |
|---|---|---|---|---|
| Caps a percentage discount | ✓ | — | ~ | ✓ |
| Zero theme code | ✓ | ✓ | ✓ | ~ |
| No transaction fee, ever | ✓ | ✓ | ✓ | — |
| Live preview before saving | ✓ | — | — | — |
| Cart tester | ✓ | — | — | — |
| Tells you where the cap starts | ✓ | — | — | — |
| Money-kept reporting | ✓ | — | — | ~ |
| One screen, three fields | ✓ | ~ | — | — |
| Under 5 a month | ✓ | ✓ | ✓ | — |

Footnote under it: *A tilde means it depends on the plan, the theme, or how much configuration you are willing to do.*

### 05 — Insights
Heading: **Know exactly what the ceiling was worth**
Lede: A cap only pays for itself if you can see it working. MaxOff answers four questions, every month, without you exporting anything.

Four stat tiles (the first tinted orange): **1,240.00** money kept this month · **87** orders capped, 21% of discounted orders · **14.25** average kept per capped order · **148.50** biggest single save, order #1042 · VIP20. Big numbers in Archivo 30px.

Then two bordered cards:
- **Where the cap starts** — For every code, MaxOff shows the cart value at which the ceiling begins to bite — 15% with a 150 maximum starts working above 1,000. It is the number nobody explains, and the one that decides whether your cap is set sensibly.
- **Which orders it caught** — Every capped order is listed with the cart total, the discount the customer would have received, what they actually received, and the difference. If a code is being shared on a coupon site, you will see it here first.

### 06 — Pricing  *(background `--paper-2`)*
Heading: **Flat monthly price. No transaction fees, no revenue share.**
Lede: Apps that take a cut of every discounted order punish you for succeeding. MaxOff charges the same whether you run one code or fifty.

Three cards. The middle one has a 2px orange border, an orange shadow, and a "Most popular" pill overlapping its top edge. Every CTA says "Get early access" and links to `#contact`; only the middle button is solid orange.

- **Free — $0 forever:** 1 active capped discount · maximum on the whole order · live preview and cart tester · "Powered by MaxOff" note at checkout.
- **Growth — $4.99/month:** unlimited capped discounts · start and end dates, usage limits · money-kept dashboard and analytics · custom checkout wording · email support.
- **Pro — $7.99/month:** everything in Growth · maximum per item and per collection · a different maximum per market currency · CSV export and 12-month history · priority support.

Below, a centred row with orange ✓ marks: Cancel any time · Change plan instantly · Billed through Shopify · Free while we are in early access.

### 07 — FAQ
Heading: **The questions merchants actually ask**

Nine native `<details>` / `<summary>` accordions separated by hairlines, first one `open`. Hide the default marker; show a `+` on the right that becomes `–` when open. Summary in Archivo 600.

1. **What exactly does MaxOff change?** Only the amount of the discount. The code, the products, your prices, your theme and your URLs are untouched. At checkout, Shopify applies the smaller of your percentage and your maximum.
2. **Will this slow my store down?** No. MaxOff adds nothing to your storefront — no script, no snippet, no app block. The cap is calculated by Shopify on its own servers while the order is being priced.
3. **What happens on a cart that is under the maximum?** Nothing. The customer gets the full percentage as normal. The cap only appears on the orders that would have cost you more than you intended.
4. **Does the customer see that the discount was capped?** They see one clean discount line. You choose the note underneath it — the default is "Discount capped at maximum amount" — or you can leave it blank and show nothing.
5. **Does it work with automatic discounts, not just codes?** Yes. A capped discount can be a code the customer types, or an automatic discount that applies on its own.
6. **Can I combine it with my other discounts?** Yes, with the same combination rules Shopify already gives you. When discounts stack, MaxOff caps its own share only — it never touches the other discount.
7. **What data can MaxOff see?** Discounts, and the orders those discounts were used on, so it can report what the cap saved you. No customer payment details, no financial account data.
8. **What happens if I uninstall?** The caps stop applying and the discounts stay in your Shopify admin as ordinary percentage discounts, where you can edit or delete them. Nothing is left behind in your theme, because nothing was ever put there.
9. **Is MaxOff on the Shopify App Store yet?** Not yet — we are in early access while we finish the build. Early access is free, and early-access stores keep a discounted rate when we launch.

Closing line: *Still not sure? **Ask us directly** — a real person on the MPC Trades team answers.* (link to `#contact`)

### 08 — Get in touch  *(background `--paper-2`, top border)*
Two columns. Left: eyebrow `08 GET IN TOUCH`, heading **Try MaxOff on your store before anyone else**, lede *Early access is free while we build. Tell us your store and what you sell, and we will set you up.*, then three orange ✓ points — *No card, no commitment, no sales call* · *We install it with you on a test order* · *Your feedback shapes what we build next* — and `Or email team@mpctrades.com` (mono, orange, `mailto:team@mpctrades.com`).

Right: a bordered white form card. Row one: Name, Email. Row two: Store URL (placeholder `yourstore.myshopify.com`), and a select — Early access / General question / Custom pricing / Other. Then a Message textarea with the placeholder *What are you running promo codes on, and what has gone wrong so far?*. A full-width orange submit button reading "Request early access". Note underneath: *We reply within one business day. We never share your store details.*

**The form must actually send. Build it exactly as specified in §6 below.**

### Footer
Black. Logo mark and wordmark on the left, links right: How it works · Features · Pricing · FAQ · Contact. Then a hairline and this disclaimer in small muted text:

> MaxOff is a working title and is not yet available on the Shopify App Store. Not affiliated with or endorsed by Shopify Inc. Prices shown in USD and billed through Shopify. An MPC Trades app.

---

## 6. The contact form must really send — Web3Forms

The page is a static file with no backend, so the form submits to **Web3Forms**, which forwards each submission by email to `team@mpctrades.com`. Free tier, 250 submissions a month, no server to run.

### Setup (do this once, before writing the code)

1. Go to `https://web3forms.com`, enter `team@mpctrades.com`, and submit.
2. An access key (a UUID) arrives at that inbox. Copy it.
3. Put it in the HTML as a single named constant near the top of the script:
   ```js
   const WEB3FORMS_ACCESS_KEY = "PASTE-KEY-HERE"; // delivers to team@mpctrades.com
   ```
   The key is designed to be public and is safe in client-side code — it only ever delivers to the address it was registered for. Do not obfuscate it, and do not add any other key or endpoint.
4. If the key is not available yet, ship the constant with the literal placeholder `PASTE-KEY-HERE`. In that case the submit handler must detect the placeholder and show the error state with the message *Form not connected yet — email team@mpctrades.com directly.* rather than firing a doomed request.

### Markup

Standard `<form id="contactForm">` with real `<label>` elements tied to every field by `for` / `id`, and these exact `name` attributes so the email is readable:

| Field | `name` | Type | Required |
|---|---|---|---|
| Name | `name` | text, `autocomplete="name"` | yes |
| Email | `email` | email, `autocomplete="email"` | yes |
| Store URL | `store_url` | text, placeholder `yourstore.myshopify.com` | no |
| Topic | `topic` | select — Early access / General question / Custom pricing / Other | no |
| Message | `message` | textarea, 4 rows | no |

Plus two hidden inputs and one honeypot:

```html
<input type="hidden" name="access_key">          <!-- filled from the constant in JS -->
<input type="hidden" name="subject" value="MaxOff early access — new request from the website">
<input type="hidden" name="from_name" value="MaxOff website">
<!-- honeypot: real people never fill this -->
<input type="checkbox" name="botcheck" tabindex="-1" autocomplete="off"
       style="display:none !important" aria-hidden="true">
```

### Submit behaviour

```js
// on submit: preventDefault(), then
// 1. validate
// 2. disable the button, label it "Sending…", set aria-busy
// 3. POST, then show success or error
```

1. **Validate first, client-side.** Name must be non-empty after trimming; email must match a simple pattern such as `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. On failure show the tinted error box reading *Add your name and a valid email so we can reply.*, move focus to the first bad field, and send nothing.
2. **Send** with `fetch`:
   ```js
   const res = await fetch("https://api.web3forms.com/submit", {
     method: "POST",
     headers: { "Content-Type": "application/json", "Accept": "application/json" },
     body: JSON.stringify(payload)   // access_key + every field above
   });
   const data = await res.json();
   ```
   Build `payload` from `new FormData(form)` so no field is ever forgotten, then set `payload.access_key = WEB3FORMS_ACCESS_KEY`.
3. **Success** — `res.ok && data.success === true`: show a tinted success box reading *Thanks NAME — we'll email you within one business day.* with the submitted first name interpolated (escape it; never use `innerHTML` with user input), call `form.reset()`, and leave the success box visible.
4. **Failure** — a non-ok response, `data.success === false`, or a thrown network error: show the error box reading *Something went wrong sending that. Please email team@mpctrades.com and we'll pick it up from there.* with the address as a `mailto:` link. Do **not** reset the form, so nothing the visitor typed is lost. Log the real error with `console.error` only — never show a raw error string to the visitor.
5. **Always** re-enable the submit button and restore its label in a `finally` block, whichever way it ended.
6. **Accessibility:** one status element, `<div id="formStatus" role="status" aria-live="polite">`, holds both the success and the error message. It is empty and hidden until there is something to say. The submit button gets `disabled` and `aria-busy="true"` while the request is in flight.
7. **Never** leave a `mailto:` form action, an `alert()`, or a "this is a demo" comment anywhere in the file. The form is real.

### One warning about hosting

The `fetch` to `api.web3forms.com` works on any normal host — a VPS, Netlify, Vercel, Cloudflare Pages, GitHub Pages. It will be **silently blocked** inside a Claude Artifact preview, whose content-security policy forbids outbound requests. Test the form on the real host, not in a preview pane.

---

## 7. Head

`<title>MaxOff — Cap your percentage discounts</title>`, charset, viewport, and a meta description: *MaxOff caps percentage discounts at a maximum amount inside Shopify checkout. 15% off, never more than 150.*

---

## 8. Before you say you are done, verify

1. Open the file in a browser. Drag the cart slider from 50 to 3000 and confirm the "With MaxOff" bar stops growing exactly when the discount reaches the maximum.
2. Set the discount to 10 and the maximum to 25 — the verdict must say the ceiling starts above 250.00.
3. Set the cart to 200 with 15% / 150 — it must switch to the "under your maximum" message, not show a negative saving.
4. Force dark mode in the OS or browser devtools — the page must stay white.
5. Narrow the window to 360px — no horizontal scrollbar on the body, the comparison table scrolls inside its own box, the nav links are hidden.
6. Tab through the page — every link, input, accordion and button shows a visible focus ring.
7. Check the browser console — zero errors.
8. **Submit the form empty** — the error box appears, nothing is sent, focus lands on the Name field.
9. **Submit the form with a real name and email** — the button says "Sending…" and goes disabled, then the success box names the person and the fields clear. Confirm the email actually arrives at `team@mpctrades.com`, with the store URL, topic and message all present and readable.
10. **Search the finished file for `mapetitecoree`** — there must be zero matches. The only email address in the file is `team@mpctrades.com`.
11. **Search the finished file for `9.99`** — there must be zero matches. Pro is `$7.99/month`.