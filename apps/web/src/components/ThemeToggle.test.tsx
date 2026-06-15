import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ThemeToggle } from "./ThemeToggle.tsx";

test("ThemeToggle renders an accessible toggle button", () => {
  const html = renderToStaticMarkup(<ThemeToggle />);

  expect(html).toContain('type="button"');
  expect(html).toContain('aria-label="Toggle color theme"');
  // aria-pressed must be present so assistive tech reports the toggle state.
  expect(html).toContain("aria-pressed=");
});

test("ThemeToggle does not throw when rendered without a DOM", () => {
  // The node test environment has no window/localStorage/matchMedia; the
  // component must render its initial markup without reaching for them.
  expect(() => renderToStaticMarkup(<ThemeToggle />)).not.toThrow();
});
