import { useCallback, useRef } from "react";

/**
 * Bind a Polaris web component's native `change` event.
 *
 * **Why this exists.** React 18 does not fire `onChange` for a custom element.
 * Its change plugin decides from the target's `nodeName`:
 *
 *     nodeName === 'select' || (nodeName === 'input' && type === 'file')
 *     …or a text input / textarea
 *
 * `<s-date-field>`, `<s-checkbox>`, `<s-choice-list>` and `<s-select>` match
 * none of those, so an `onChange` prop on them is accepted by TypeScript and
 * then **silently never called**.
 *
 * That is worse than a dead handler, because these fields are controlled: the
 * merchant picks a date, the component sets its own value, React re-renders
 * with the old value, and the field snaps back. It looks like the control is
 * disabled or broken rather than like a missing event.
 *
 * `onInput` is safe — React dispatches `input` for any element — which is why
 * the text, number and search fields work. Anything that only emits `change`
 * needs this hook.
 *
 * Returns a ref callback. The handler is given the element so the caller reads
 * whichever property that component exposes: `.value`, `.checked`, `.values`.
 */
export function useNativeChange<E extends HTMLElement>(
  handler: (element: E) => void,
): (element: E | null) => void {
  // Kept in a ref so the ref callback stays stable and React does not detach
  // and reattach the listener on every render.
  const latest = useRef(handler);
  latest.current = handler;

  const detach = useRef<(() => void) | null>(null);

  return useCallback((element: E | null) => {
    detach.current?.();
    detach.current = null;

    if (element === null) {
      return;
    }

    const listener = () => latest.current(element);
    element.addEventListener("change", listener);
    detach.current = () =>
      element.removeEventListener("change", listener);
  }, []);
}

/** A Polaris field that carries a string value. */
export type ValueElement = HTMLElement & { value: string };

/** A Polaris checkbox. */
export type CheckedElement = HTMLElement & { checked: boolean };

/** A Polaris choice list, whose selection is a list of values. */
export type ValuesElement = HTMLElement & { values?: string[] };
