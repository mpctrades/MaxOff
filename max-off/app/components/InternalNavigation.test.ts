import { describe, expect, it, vi } from "vitest";
import type { NavigateFunction } from "react-router";

import { handleInternalNavigation } from "./InternalNavigation";

function click(overrides: Partial<MouseEvent> = {}) {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as Event;
}

describe("internal embedded navigation", () => {
  it("prevents a document request and navigates with React Router", () => {
    const event = click();
    const navigate = vi.fn() as unknown as NavigateFunction;

    handleInternalNavigation(event, "/app/discounts/new", navigate);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/app/discounts/new");
  });

  it.each([
    ["another mouse button", { button: 1 }],
    ["Command-click", { metaKey: true }],
    ["Control-click", { ctrlKey: true }],
    ["Shift-click", { shiftKey: true }],
    ["Alt-click", { altKey: true }],
    ["an already handled event", { defaultPrevented: true }],
  ])("keeps native behavior for %s", (_label, overrides) => {
    const event = click(overrides);
    const navigate = vi.fn() as unknown as NavigateFunction;

    handleInternalNavigation(event, "/app/discounts/new", navigate);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
