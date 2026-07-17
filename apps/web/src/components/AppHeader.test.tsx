// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { AppHeader } from "./AppHeader.tsx";

beforeAll(() => {
  // jsdom does not implement matchMedia; ThemeToggle uses it in its effect
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

function renderHeader(
  props: { project?: string; context?: string; aside?: ReactNode } = {},
) {
  return render(
    <MemoryRouter>
      <AppHeader {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe("AppHeader", () => {
  test("renders the Trace wordmark", () => {
    renderHeader();
    expect(screen.getByText("Trace")).toBeInTheDocument();
  });

  test("wordmark is a link back to /", () => {
    renderHeader();
    const link = screen.getByRole("link", { name: "Trace" });
    expect(link).toHaveAttribute("href", "/");
  });

  test("renders the project crumb when project is provided", () => {
    renderHeader({ project: "trace-v2" });
    expect(screen.getByText("trace-v2")).toBeInTheDocument();
  });

  test("does not render a project crumb when project is omitted", () => {
    renderHeader();
    expect(screen.queryByText("/")).not.toBeInTheDocument();
  });

  test("renders the context crumb when both project and context are provided", () => {
    renderHeader({ project: "trace-v2", context: "My Task" });
    expect(screen.getByText("My Task")).toBeInTheDocument();
  });

  test("renders the aside slot content when provided", () => {
    renderHeader({ aside: <span>synced 2m ago</span> });
    expect(screen.getByText("synced 2m ago")).toBeInTheDocument();
  });

  test("renders the accessible theme toggle button", () => {
    renderHeader();
    expect(
      screen.getByRole("button", { name: /toggle color theme/i }),
    ).toBeInTheDocument();
  });

  test("toggle flips data-theme on <html> from light to dark", () => {
    document.documentElement.dataset.theme = "light";
    renderHeader();
    const toggle = screen.getByRole("button", { name: /toggle color theme/i });
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  test("toggle flips data-theme on <html> from dark to light", () => {
    document.documentElement.dataset.theme = "dark";
    renderHeader();
    const toggle = screen.getByRole("button", { name: /toggle color theme/i });
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
