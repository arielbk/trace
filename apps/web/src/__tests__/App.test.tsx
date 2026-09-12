// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { vi, test, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    QueryClientProvider: vi.fn(actual.QueryClientProvider),
  };
});

import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "../App.tsx";
import { LocalTraceSource } from "../lib/trace-data-source.ts";
import { TRACE_PROTOCOL_VERSION } from "@trace/core/browser";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("[]", { status: 200 })),
  );
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
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  cleanup();
});

test("App wraps routes in QueryClientProvider", () => {
  render(<App />);
  expect(vi.mocked(QueryClientProvider)).toHaveBeenCalled();
});

test("source capabilities select the explicit local connection flow", () => {
  render(<App source={new LocalTraceSource("http://127.0.0.1:4317")} />);

  expect(
    screen.getByRole("heading", { name: "Connect to EQNX on this device" }),
  ).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(
    "http://127.0.0.1:4317/api/pairing/requests",
    expect.objectContaining({ method: "POST" }),
  );
});

test("a paired hosted board routes into a task's detail view", async () => {
  const origin = "http://127.0.0.1:4317";
  localStorage.setItem(`trace.bridgeCredential:${origin}`, "a".repeat(43));
  window.history.replaceState({}, "", "/task/my-task");
  const timeline = {
    task: {
      id: "task-abc",
      slug: "my-task",
      title: "My task",
      projectRoot: "/work/proj",
      projectId: "project-proj",
      projectSlug: "proj",
      createdAt: "2026-06-01T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
    },
    items: [],
    lastActivityAt: "2026-06-01T00:00:00.000Z",
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
  };
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/connection")) {
        return json({
          service: "trace",
          protocolVersion: TRACE_PROTOCOL_VERSION,
        });
      }
      if (url.endsWith("/timeline")) return json(timeline);
      return json([]);
    }),
  );

  render(<App source={new LocalTraceSource(origin)} />);

  expect(await screen.findByRole("heading", { name: "My task" })).toBeVisible();
  expect(fetch).toHaveBeenCalledWith(
    `${origin}/api/tasks/my-task/timeline`,
    expect.anything(),
  );
});

test("a connected board reports a connection that stops answering", async () => {
  const origin = "http://127.0.0.1:4317";
  localStorage.setItem(`trace.bridgeCredential:${origin}`, "a".repeat(43));
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const connected = vi
    .fn()
    .mockImplementation(async (input: unknown) =>
      String(input).endsWith("/api/connection")
        ? json({ service: "trace", protocolVersion: TRACE_PROTOCOL_VERSION })
        : json([]),
    );
  vi.stubGlobal("fetch", connected);

  render(<App source={new LocalTraceSource(origin)} />);
  expect(await screen.findByRole("heading", { name: "Tasks" })).toBeVisible();

  // EQNX goes away underneath the open board.
  connected.mockRejectedValue(new TypeError("Failed to fetch"));
  fireEvent(window, new Event("focus"));

  expect(await screen.findByRole("status")).toHaveTextContent(/reconnecting/i);
});
