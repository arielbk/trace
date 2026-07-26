// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { Dropdown, DropdownContent, DropdownTrigger } from "./Dropdown.tsx";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
});

afterEach(cleanup);

test("the content mounts only once opened, wearing the shared dropdown styling", async () => {
  const user = userEvent.setup();
  render(
    <Dropdown>
      <DropdownTrigger>Open</DropdownTrigger>
      <DropdownContent aria-label="Menu" origin="top-right" className="w-64">
        <p>Body</p>
      </DropdownContent>
    </Dropdown>,
  );

  expect(
    screen.queryByRole("dialog", { name: "Menu" }),
  ).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Open" }));

  const content = await screen.findByRole("dialog", { name: "Menu" });
  // The animation contract every board dropdown inherits: the transition class,
  // the corner it scales from, and the caller's own styling on top.
  expect(content).toHaveClass("t-dropdown");
  expect(content).toHaveAttribute("data-origin", "top-right");
  expect(content).toHaveClass("w-64");
  expect(content).not.toHaveClass("is-closing");
});

test("close from the content's render prop plays the exit transition before unmounting", async () => {
  const user = userEvent.setup();
  render(
    <Dropdown>
      <DropdownTrigger>Open</DropdownTrigger>
      <DropdownContent aria-label="Menu">
        {({ close }) => (
          <button type="button" onClick={close}>
            Pick
          </button>
        )}
      </DropdownContent>
    </Dropdown>,
  );

  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.click(await screen.findByRole("button", { name: "Pick" }));

  // Selecting must not rip the content out from under the animation — it stays
  // mounted in its closing state until the exit transition has run.
  expect(screen.getByRole("dialog", { name: "Menu" })).toHaveClass(
    "is-closing",
  );
  await waitForElementToBeRemoved(() =>
    screen.queryByRole("dialog", { name: "Menu" }),
  );
});

test("the content refuses to render outside a Dropdown", () => {
  // The transition state lives in context, so a stray content element would
  // otherwise render un-animated and never close.
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() =>
    render(<DropdownContent aria-label="Menu">Body</DropdownContent>),
  ).toThrow(/must be rendered inside a <Dropdown>/);
  consoleError.mockRestore();
});
