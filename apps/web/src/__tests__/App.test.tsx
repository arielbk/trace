// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { vi, test, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    QueryClientProvider: vi.fn(actual.QueryClientProvider),
  };
});

import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "../App.tsx";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

test("App wraps routes in QueryClientProvider", () => {
  render(<App />);
  expect(vi.mocked(QueryClientProvider)).toHaveBeenCalled();
});
