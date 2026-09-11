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

/**
 * Keep a date field's picker inside the app frame.
 *
 * `s-date-field` opens its calendar as a `position: fixed` `<dialog popover>`
 * in the top layer. Nothing clips it — there is no `overflow: hidden` or
 * `transform` anywhere in its ancestry — but the app is an iframe, and a
 * fixed-position element cannot be drawn past the iframe's own viewport. With
 * the field near the bottom of the frame the calendar is laid out below it and
 * the day grid falls outside, unreachable: measured at 198px past the edge on
 * a 1038px frame.
 *
 * Polaris should flip the calendar above the field when there is no room
 * below, and that decision lives in its shadow DOM where we cannot reach it.
 * What we *can* do is make sure there is room: scroll the field to the middle
 * of the frame before the picker opens.
 *
 * The scroll has to happen **before** the calendar is positioned. Once open it
 * is `position: fixed`, so it is anchored to the viewport and not to the
 * field — scrolling afterwards would slide the field out from under it. Hence
 * `pointerdown` and `focusin`, both of which land before the click that opens
 * it, and both instant rather than smooth for the same reason.
 *
 * Returns a ref callback, so it composes with `useNativeChange` through
 * `mergeRefs`.
 */
export function useRoomForPicker<E extends HTMLElement>(): (
  element: E | null,
) => void {
  const detach = useRef<(() => void) | null>(null);

  return useCallback((element: E | null) => {
    detach.current?.();
    detach.current = null;

    if (element === null) {
      return;
    }

    const makeRoom = (event: Event) => {
      // The `s-date-field` host itself has no box — it lays out as
      // `display: contents`, so its own rect is 0×0 at 0,0 and every
      // measurement taken from it is meaningless. The event's composed path
      // starts at the real control inside the shadow root, which is the thing
      // with a position on screen. Public API, no shadow-DOM poking.
      const target = (event.composedPath()[0] as Element | undefined) ?? element;
      const { top, bottom } = target.getBoundingClientRect();
      if (bottom === 0) {
        return; // not laid out yet
      }

      const roomBelow = window.innerHeight - bottom;

      // PICKER_HEIGHT is the measured height of the one-month grid (246px),
      // rounded up so a six-row month does not squeak past the check.
      const PICKER_HEIGHT = 280;
      if (roomBelow >= PICKER_HEIGHT || top < window.innerHeight / 2) {
        return;
      }

      target.scrollIntoView({ block: "center", behavior: "instant" });
    };

    element.addEventListener("pointerdown", makeRoom);
    element.addEventListener("focusin", makeRoom);
    detach.current = () => {
      element.removeEventListener("pointerdown", makeRoom);
      element.removeEventListener("focusin", makeRoom);
    };
  }, []);
}

/**
 * Attach several ref callbacks to one element — `useNativeChange` and
 * `useRoomForPicker` both want the same node.
 *
 * A hook rather than a plain function so the merged callback keeps a stable
 * identity across renders. An inline `mergeRefs(a, b)` would be a new function
 * every render, and React would detach and reattach every listener underneath
 * it each time — the churn `useNativeChange` goes out of its way to avoid.
 */
export function useMergedRefs<E extends HTMLElement>(
  ...refs: ((element: E | null) => void)[]
): (element: E | null) => void {
  const latest = useRef(refs);
  latest.current = refs;

  return useCallback((element: E | null) => {
    for (const ref of latest.current) {
      ref(element);
    }
  }, []);
}
