/**
 * The MaxOff button.
 *
 * Why this is not `s-button`
 * --------------------------
 * Arthur asked for a flat orange button with room to breathe. Polaris cannot
 * render one. Its primary button is built for Shopify's near-black fill and
 * hard-codes three things that only work against it, none of them behind a
 * token:
 *
 *     box-shadow: rgba(0,0,0,.8) 0 -1px 0 1px inset,   ← dark bottom bevel
 *                 rgb(48,48,48)  0  0  0 1px inset,    ← a near-black ring
 *                 rgba(255,255,255,.25) 0 .5px 0 1.5px inset;
 *     .size-base { min-block-size: 1.75rem; padding: .375rem .75rem; }
 *     .button    { font-size: .75rem; }
 *
 * On a near-black button the ring is invisible. On orange it is the dark
 * outline in Arthur's "before" screenshot. The 28px height and 12px label are
 * equally fixed. All of it lives in the component's shadow DOM, so no amount
 * of theming reaches it — the only way to the drawn button is to draw it.
 *
 * This is a real `<button>` or `<a>`, so it keeps native keyboard, form
 * submission and link behaviour; only the paint is ours. §5 says build with
 * Polaris, and everywhere a Polaris button will do, we still do.
 */

import { Link } from "react-router";

export interface BrandButtonProps {
  children: React.ReactNode;
  /** Renders an anchor instead of a button. */
  href?: string;
  /**
   * Anchor target. `"_top"` is what carries a merchant out of the embedded
   * iframe — a server redirect cannot, because the browser applies it to the
   * frame that made the request and Shopify admin refuses to be framed.
   */
  target?: string;
  type?: "button" | "submit";
  variant?: "primary" | "secondary";
  disabled?: boolean;
  /** Stretches to the width of its container — the plan cards use this. */
  fill?: boolean;
  onClick?: () => void;
  accessibilityLabel?: string;
  /** For placing the button in a Polaris slot, e.g. a modal's action area. */
  slot?: string;
}

export function BrandButton({
  children,
  href,
  target,
  type = "button",
  variant = "primary",
  disabled = false,
  fill = false,
  onClick,
  accessibilityLabel,
  slot,
}: BrandButtonProps) {
  const className = [
    "maxoff-button",
    `maxoff-button--${variant}`,
    fill ? "maxoff-button--fill" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // A disabled link is not a thing — an `<a>` with no href is still in the
  // tab order and still announced as a link. A disabled button is both.
  if (href !== undefined && !disabled) {
    if (href.startsWith("/") && target === undefined) {
      return (
        <Link
          className={className}
          to={href}
          slot={slot}
          aria-label={accessibilityLabel}
        >
          {children}
        </Link>
      );
    }

    return (
      <a
        className={className}
        href={href}
        target={target}
        rel={target ? "noopener" : undefined}
        slot={slot}
        aria-label={accessibilityLabel}
      >
        {children}
      </a>
    );
  }

  return (
    <button
      className={className}
      type={type}
      disabled={disabled}
      onClick={onClick}
      slot={slot}
      aria-label={accessibilityLabel}
    >
      {children}
    </button>
  );
}
