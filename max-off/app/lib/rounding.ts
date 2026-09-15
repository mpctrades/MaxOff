/**
 * How the final discount amount is rounded.
 *
 * Here rather than in `settings.server.ts` because the Settings component
 * renders these labels, and a route component may import **types** from a
 * `.server` module but never values — the client build fails outright, which
 * is how this file came to exist. `settings.server.ts` imports from here too,
 * so there is still one definition.
 *
 * The Function has its own copy of the same two names in
 * `extensions/max-off-cap/src/cap.ts`: the two halves of a contract that
 * crosses a metafield, the same way `cap-config.ts` is mirrored there. The
 * round-trip test in `app/lib/cap-config.test.ts` is what holds them together.
 */

export const ROUNDING_MODES = ["cent", "down"] as const;

export type RoundingMode = (typeof ROUNDING_MODES)[number];

export function isRoundingMode(value: unknown): value is RoundingMode {
  return (ROUNDING_MODES as readonly unknown[]).includes(value);
}

/** Anything unreadable is the rounding that gives away least, never the most. */
export function toRoundingMode(value: string | null | undefined): RoundingMode {
  return isRoundingMode(value) ? value : "cent";
}

export const ROUNDING_LABELS: Record<RoundingMode, string> = {
  cent: "To the cent",
  down: "Down to the whole unit",
};

export const ROUNDING_DETAILS: Record<RoundingMode, string> = {
  cent: "Half-up to the cent, once, on the final discount amount.",
  down: "Down to the whole unit, once, on the final discount amount.",
};
