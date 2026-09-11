/**
 * Painting Polaris in MaxOff orange.
 *
 * BUILD-SPEC §5 says "do not repaint Polaris chrome". Arthur asked for the
 * whole app in brand orange on 10 Sep 2026, so this file is the sanctioned
 * exception — and it is deliberately the *only* one. Everything here goes
 * through Polaris' own theme layer; nothing reaches into a shadow-DOM class
 * name, and there is not an `!important` in the file.
 *
 * How the theme layer works
 * -------------------------
 * Polaris authors every colour in its shadow DOM as
 *
 *     color: var(--t-text-link-26021, rgba(0, 91, 211, 1));
 *
 * The `--t-*` properties are never defined anywhere — each usage carries a
 * hard-coded fallback. They are theming hooks. Custom properties inherit
 * through shadow boundaries, so defining one on `:root` reaches every
 * component that reads it. There are 87 of them; we set the 20 that carry
 * brand meaning and leave the rest, so Polaris keeps its own greys and its
 * own status colours.
 *
 * Status colours are NOT in this map on purpose. Green, red, blue and yellow
 * carry meaning, not decoration (§5), and repainting them would make a
 * critical banner unreadable as critical.
 *
 * The hash
 * --------
 * `26021` is a Polaris build hash and it will change when Shopify ships a new
 * Polaris. `POLARIS_TOKEN_HASH` is the value compiled into the server-rendered
 * stylesheet; `syncBrandTheme()` re-reads the live hash in the browser and
 * re-applies the map if it has moved, so a Polaris release degrades to one
 * frame of default colours rather than to a grey app. If both fail the app is
 * simply Shopify-default — nothing breaks, and nothing is unreadable.
 */

/** The Polaris build hash this stylesheet was generated against. */
export const POLARIS_TOKEN_HASH = "26021";

/**
 * Brand ramp, with the measured contrast against white — because which orange
 * goes where is decided by that number, not by taste:
 *
 *   orange500 #ea580c   3.6:1   fills only. Fine for a radio dot or a chart
 *                               bar (3:1 is the bar for a UI component), and
 *                               NOT enough to sit under white button text.
 *   orange600 #d93f0c   4.5:1   the brightest orange that may carry white
 *                               text — found by searching the ramp, not
 *                               picked. Anything livelier fails AA.
 *   orange700 #c2410c   5.2:1
 *   orange800 #9a3412   7.3:1
 *   orange900 #7c2d12   9.5:1
 *
 * This is exactly the split §5 already draws between `--orange` (text) and
 * `--orange-bright` (fills); the contrast maths is why it exists.
 */
const brand = {
  orange050: "#fff2e8",
  orange200: "#f8c39a",
  orange500: "#ea580c",
  orange600: "#d93f0c",
  orange700: "#c2410c",
  orange800: "#9a3412",
  orange900: "#7c2d12",
  onFill: "#ffffff",
  onFillHover: "#fff2e8",
  onFillActive: "#ffe0cc",
} as const;

/**
 * Polaris theme token → brand value. Keys are written without the build hash;
 * it is appended when the CSS is generated.
 */
export const BRAND_THEME_TOKENS: Record<string, string> = {
  // Primary buttons and any other "brand" fill.
  //
  // orange600 is as bright as a button carrying white text can be: at 4.50:1
  // it clears the 4.5 floor with nothing to spare, and every livelier orange
  // in the ramp fails. The livelier #ea580c is 3.6:1 — it is used elsewhere,
  // on radio dots and chart bars, where nothing sits on top of it.
  "fill-brand": brand.orange600,
  "fill-brand-hover": brand.orange700,
  "fill-brand-active": brand.orange800,
  "fill-brand-disabled": "rgba(217, 63, 12, 0.32)",
  "text-brand-on-fill": brand.onFill,
  "text-brand-on-fill-hover": brand.onFillHover,
  "text-brand-on-fill-active": brand.onFillActive,
  "text-brand-on-fill-disabled": brand.onFill,
  "icon-brand": brand.orange700,
  "surface-brand": brand.orange050,

  // Selected controls: radios, checkboxes, switches, selected tabs. These
  // carry no text, so the bright orange is allowed here and this is where the
  // brand reads loudest. It is also the radio Arthur approved.
  "fill-selected": brand.orange500,

  // Links. The hover and active steps go darker, never lighter, so every
  // state stays above 4.5:1.
  "text-link": brand.orange700,
  "text-link-hover": brand.orange800,
  "text-link-active": brand.orange900,

  // Focus. Deliberately orange800 rather than the orange500 fill: the ring is
  // often drawn against a white gap on top of an orange button, and the darker
  // step keeps it visible in both places.
  "border-focus": brand.orange800,
  "icon-highlight": brand.orange700,

  // Text inputs pick up the brand on interaction only; the resting border
  // stays Polaris grey so a form does not read as eight orange boxes.
  "input-border-active": brand.orange500,

  // Warm the page behind the cards. Cards themselves stay white, which is what
  // keeps the app legible and still recognisably the Shopify admin.
  bg: "#faf6f3",
  "surface-tertiary": "#f6efea",
  border: "#e8ded7",
  "border-subdued": "#f0e7e1",
};

/** The `:root` rule that defines every brand token for a given build hash. */
export function brandThemeCss(hash: string = POLARIS_TOKEN_HASH): string {
  const declarations = Object.entries(BRAND_THEME_TOKENS)
    .map(([token, value]) => `--t-${token}-${hash}:${value}`)
    .join(";");
  return `:root{${declarations}}`;
}

/**
 * Read the Polaris build hash actually in use. Polaris puts at least one of
 * its own hashed properties in a document-level stylesheet, so this is a scan
 * of a couple of kilobytes, not of the whole component library.
 */
function readLiveTokenHash(): string | null {
  const sheets = [
    ...(document.adoptedStyleSheets ?? []),
    ...Array.from(document.styleSheets),
  ] as CSSStyleSheet[];

  for (const sheet of sheets) {
    let text: string;
    try {
      text = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
    } catch {
      continue; // cross-origin sheet, not ours to read
    }
    const match = text.match(/--[st]-[a-z0-9-]+?-(\d{3,})\b/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Re-apply the brand tokens if Polaris has moved to a build hash the
 * server-rendered stylesheet does not know about. A no-op in the normal case.
 */
export function syncBrandTheme(): void {
  const liveHash = readLiveTokenHash();
  if (!liveHash || liveHash === POLARIS_TOKEN_HASH) return;

  const root = document.documentElement;
  for (const [token, value] of Object.entries(BRAND_THEME_TOKENS)) {
    root.style.setProperty(`--t-${token}-${liveHash}`, value);
  }
}
