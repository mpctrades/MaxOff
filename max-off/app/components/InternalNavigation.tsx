import type { ComponentProps } from "react";
import { useNavigate } from "react-router";
import type { NavigateFunction } from "react-router";

type LinkProps = Omit<ComponentProps<"s-link">, "href" | "onClick"> & {
  href: string;
};

type ButtonProps = Omit<ComponentProps<"s-button">, "href" | "onClick"> & {
  href: string;
};

/**
 * Keep internal navigation inside React Router.
 *
 * A document request to an embedded route does not carry App Bridge's bearer
 * token. Shopify answers it with a status-200 bounce page. That works on an
 * initial document load, but during client navigation React Router treats the
 * response as route data and can render the bare status instead of the page.
 *
 * Polaris calls `onClick` before following `href`, so preventing the default
 * navigation and asking React Router to navigate preserves the authenticated
 * data-request path. The href remains for semantics and graceful fallback.
 */
export function handleInternalNavigation(
  event: Event,
  href: string,
  navigate: NavigateFunction,
) {
  const mouseEvent = event as MouseEvent;
  const modified =
    mouseEvent.button > 0 ||
    mouseEvent.metaKey ||
    mouseEvent.ctrlKey ||
    mouseEvent.shiftKey ||
    mouseEvent.altKey;

  if (event.defaultPrevented || modified) {
    return;
  }

  event.preventDefault();
  navigate(href);
}

function useInternalClick(href: string) {
  const navigate = useNavigate();

  return (event: Event) => handleInternalNavigation(event, href, navigate);
}

export function InternalLink({ href, children, ...props }: LinkProps) {
  const onClick = useInternalClick(href);

  return (
    <s-link href={href} onClick={onClick} {...props}>
      {children}
    </s-link>
  );
}

export function InternalButtonLink({ href, children, ...props }: ButtonProps) {
  const onClick = useInternalClick(href);

  return (
    <s-button href={href} onClick={onClick} {...props}>
      {children}
    </s-button>
  );
}
