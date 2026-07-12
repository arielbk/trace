// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TaskSummary, TaskTimeline, TokenTotals } from "@trace/core";
import {
  fetchDocContents,
  fetchTaskTimeline,
  fetchTasks,
  HttpError,
  postToggleCheckbox,
  useArchiveTask,
  useDocContents,
  useTasks,
  useTaskTimeline,
  usePinTask,
  useToggleCheckbox,
  useUnarchiveTask,
  useUnpinTask,
} from "./api.ts";

function makeFreshClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

function tokens(n = 0): TokenTotals {
  return {
    inputTokens: n,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: n,
  };
}

function makeTask(id: string): TaskSummary {
  return {
    id,
    slug: id,
    title: "Task " + id,
    createdAt: "2026-01-01T00:00:00.000Z",
    projectRoot: "/work/proj",
    archivedAt: null,
    pinnedAt: null,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    tokenTotals: tokens(),
    agentTools: [],
    hasDocs: false,
  };
}

function makeTimeline(slug: string): TaskTimeline {
  return {
    task: {
      id: "tid-1",
      slug,
      title: "Task " + slug,
      createdAt: "2026-01-01T00:00:00.000Z",
      projectRoot: "/work/proj",
      archivedAt: null,
      pinnedAt: null,
    },
    items: [],
    tokenTotals: tokens(),
    lastActivityAt: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

// ─── fetchTasks ──────────────────────────────────────────────────────────────

describe("fetchTasks", () => {
  test("resolves to TaskSummary[] on 200", async () => {
    const tasks = [makeTask("a"), makeTask("b")];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(tasks), { status: 200 }),
      ),
    );
    const result = await fetchTasks();
    expect(result).toEqual(tasks);
    expect(fetch).toHaveBeenCalledWith("/api/tasks");
  });

  test("throws HttpError with status on non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Error", { status: 500 })),
    );
    await expect(fetchTasks()).rejects.toBeInstanceOf(HttpError);
    await expect(fetchTasks()).rejects.toMatchObject({ status: 500 });
  });
});

// ─── fetchTaskTimeline ────────────────────────────────────────────────────────

describe("fetchTaskTimeline", () => {
  test("resolves to TaskTimeline on 200", async () => {
    const timeline = makeTimeline("my-task");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(timeline), { status: 200 }),
      ),
    );
    const result = await fetchTaskTimeline("my-task");
    expect(result).toEqual(timeline);
    expect(fetch).toHaveBeenCalledWith("/api/tasks/my-task/timeline");
  });

  test("throws HttpError with status 404 on a 404 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Not found", { status: 404 })),
    );
    await expect(fetchTaskTimeline("missing")).rejects.toBeInstanceOf(HttpError);
    await expect(fetchTaskTimeline("missing")).rejects.toMatchObject({ status: 404 });
  });

  test("throws HttpError with status on generic non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Err", { status: 503 })),
    );
    await expect(fetchTaskTimeline("slug")).rejects.toMatchObject({ status: 503 });
  });
});

// ─── useTasks ─────────────────────────────────────────────────────────────────

describe("useTasks", () => {
  test("returns tasks from the /api/tasks endpoint", async () => {
    const tasks = [makeTask("a"), makeTask("b")];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(tasks), { status: 200 }),
      ),
    );
    const client = makeFreshClient();
    const { result } = renderHook(() => useTasks(), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(tasks);
  });

  test("surfaces a non-OK response as a query error carrying the HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Error", { status: 500 })),
    );
    const client = makeFreshClient();
    const { result } = renderHook(() => useTasks(), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(HttpError);
    expect((result.current.error as HttpError).status).toBe(500);
  });
});

// ─── useTaskTimeline ──────────────────────────────────────────────────────────

describe("useTaskTimeline", () => {
  test("returns the timeline for a given id", async () => {
    const timeline = makeTimeline("my-task");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(timeline), { status: 200 }),
      ),
    );
    const client = makeFreshClient();
    const { result } = renderHook(() => useTaskTimeline("my-task"), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(timeline);
  });

  test("surfaces 404 as query error carrying status 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Not found", { status: 404 })),
    );
    const client = makeFreshClient();
    const { result } = renderHook(() => useTaskTimeline("missing"), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as HttpError).status).toBe(404);
  });
});

// ─── fetchDocContents ─────────────────────────────────────────────────────────

describe("fetchDocContents", () => {
  test("resolves to rendered HTML with its content-type for a markdown doc", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<h1>Plan</h1>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDocContents("my-task", "/work/docs/plan.md");

    expect(result).toEqual({ contentType: "text/html", body: "<h1>Plan</h1>" });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/my-task/docs?path=${encodeURIComponent("/work/docs/plan.md")}`,
    );
  });

  test("resolves to raw text with its content-type for a non-markdown doc", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"a":1}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await fetchDocContents("my-task", "/work/docs/data.json");

    expect(result).toEqual({ contentType: "application/json", body: '{"a":1}' });
  });

  test("throws HttpError with status and body message on non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Doc could not be read", { status: 500 })),
    );

    const error = await fetchDocContents("my-task", "/work/docs/plan.md").catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 500, message: "Doc could not be read" });
  });
});

// ─── useDocContents ───────────────────────────────────────────────────────────

describe("useDocContents", () => {
  test("returns doc contents keyed by task ref and doc path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<p>Hello</p>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const client = makeFreshClient();
    const { result } = renderHook(() => useDocContents("my-task", "/work/docs/plan.md"), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ contentType: "text/html", body: "<p>Hello</p>" });
  });

  test("surfaces a 404 as a query error carrying status 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 404 })),
    );
    const client = makeFreshClient();
    const { result } = renderHook(() => useDocContents("my-task", "/work/docs/missing.md"), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as HttpError).status).toBe(404);
  });
});

// ─── postToggleCheckbox ───────────────────────────────────────────────────────

describe("postToggleCheckbox", () => {
  test("POSTs the path/index/checked body as JSON to the checkbox endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await postToggleCheckbox("my-task", "/work/docs/plan.md", 2, true);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/my-task/docs/checkbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/work/docs/plan.md", index: 2, checked: true }),
    });
  });

  test("throws HttpError with status on non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 500 })),
    );

    const error = await postToggleCheckbox("my-task", "/work/docs/plan.md", 0, false).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 500 });
  });
});

// ─── useToggleCheckbox ────────────────────────────────────────────────────────

describe("useToggleCheckbox", () => {
  test("posts the correct ref/path/index/checked body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = makeFreshClient();
    const { result } = renderHook(() => useToggleCheckbox(), {
      wrapper: wrapper(client),
    });

    result.current.mutate({ ref: "my-task", path: "/work/docs/plan.md", index: 3, checked: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/my-task/docs/checkbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/work/docs/plan.md", index: 3, checked: true }),
    });
  });

  test("invalidates the doc-contents query key for the toggled doc on settle", async () => {
    let docFetches = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/docs?path=")) {
        docFetches++;
        return Promise.resolve(
          new Response("<p>Doc</p>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = makeFreshClient();

    const { result } = renderHook(
      () => ({
        doc: useDocContents("my-task", "/work/docs/plan.md"),
        toggle: useToggleCheckbox(),
      }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(result.current.doc.isSuccess).toBe(true));
    const initialDocFetches = docFetches;

    result.current.toggle.mutate({
      ref: "my-task",
      path: "/work/docs/plan.md",
      index: 0,
      checked: true,
    });
    await waitFor(() => expect(result.current.toggle.isSuccess).toBe(true));

    await waitFor(() => expect(docFetches).toBeGreaterThan(initialDocFetches));
  });

  test("invalidates the doc-contents query even when the post fails (revert path)", async () => {
    let docFetches = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/docs?path=")) {
        docFetches++;
        return Promise.resolve(
          new Response("<p>Doc</p>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        );
      }
      return Promise.resolve(new Response("boom", { status: 500 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = makeFreshClient();

    const { result } = renderHook(
      () => ({
        doc: useDocContents("my-task", "/work/docs/plan.md"),
        toggle: useToggleCheckbox(),
      }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(result.current.doc.isSuccess).toBe(true));
    const initialDocFetches = docFetches;

    result.current.toggle.mutate({
      ref: "my-task",
      path: "/work/docs/plan.md",
      index: 0,
      checked: true,
    });
    await waitFor(() => expect(result.current.toggle.isError).toBe(true));

    await waitFor(() => expect(docFetches).toBeGreaterThan(initialDocFetches));
  });
});

// ─── useArchiveTask ───────────────────────────────────────────────────────────

describe("useArchiveTask", () => {
  test("POSTs to the archive endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: "t1", archivedAt: "2026-06-15T00:00:00.000Z" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = makeFreshClient();
    const { result } = renderHook(() => useArchiveTask(), {
      wrapper: wrapper(client),
    });
    result.current.mutate("my-task");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/my-task/archive",
      { method: "POST" },
    );
  });

  test("invalidates the tasks query on success", async () => {
    const tasks = [makeTask("a")];
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/tasks") {
        callCount++;
        return Promise.resolve(
          new Response(JSON.stringify(tasks), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: "a", archivedAt: "2026-06-15T00:00:00.000Z" }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = makeFreshClient();

    const { result } = renderHook(
      () => ({ tasks: useTasks(), archive: useArchiveTask() }),
      { wrapper: wrapper(client) },
    );

    // Wait for initial tasks fetch
    await waitFor(() => expect(result.current.tasks.isSuccess).toBe(true));
    const initialCallCount = callCount;

    // Trigger archive mutation
    result.current.archive.mutate("a");
    await waitFor(() => expect(result.current.archive.isSuccess).toBe(true));

    // Tasks should have been refetched (invalidation)
    await waitFor(() => expect(callCount).toBeGreaterThan(initialCallCount));
  });
});

// ─── useUnarchiveTask ─────────────────────────────────────────────────────────

describe("useUnarchiveTask", () => {
  test("POSTs to the unarchive endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: "t1", archivedAt: null }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = makeFreshClient();
    const { result } = renderHook(() => useUnarchiveTask(), {
      wrapper: wrapper(client),
    });
    result.current.mutate("my-task");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/my-task/unarchive",
      { method: "POST" },
    );
  });

  test("invalidates the tasks query on success", async () => {
    const tasks = [makeTask("a")];
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/tasks") {
        callCount++;
        return Promise.resolve(
          new Response(JSON.stringify(tasks), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: "a", archivedAt: null }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = makeFreshClient();

    const { result } = renderHook(
      () => ({ tasks: useTasks(), unarchive: useUnarchiveTask() }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(result.current.tasks.isSuccess).toBe(true));
    const initialCallCount = callCount;

    result.current.unarchive.mutate("a");
    await waitFor(() => expect(result.current.unarchive.isSuccess).toBe(true));

    await waitFor(() => expect(callCount).toBeGreaterThan(initialCallCount));
  });
});

// ─── usePinTask ───────────────────────────────────────────────────────────────

describe("usePinTask", () => {
  test("POSTs to the pin endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: "t1", pinnedAt: "2026-06-15T00:00:00.000Z" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = makeFreshClient();
    const { result } = renderHook(() => usePinTask(), {
      wrapper: wrapper(client),
    });
    result.current.mutate("my-task");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/my-task/pin",
      { method: "POST" },
    );
  });

  test("invalidates the tasks query on success", async () => {
    const tasks = [makeTask("a")];
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/tasks") {
        callCount++;
        return Promise.resolve(
          new Response(JSON.stringify(tasks), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: "a", pinnedAt: "2026-06-15T00:00:00.000Z" }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = makeFreshClient();

    const { result } = renderHook(
      () => ({ tasks: useTasks(), pin: usePinTask() }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(result.current.tasks.isSuccess).toBe(true));
    const initialCallCount = callCount;

    result.current.pin.mutate("a");
    await waitFor(() => expect(result.current.pin.isSuccess).toBe(true));

    await waitFor(() => expect(callCount).toBeGreaterThan(initialCallCount));
  });
});

// ─── useUnpinTask ─────────────────────────────────────────────────────────────

describe("useUnpinTask", () => {
  test("POSTs to the unpin endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: "t1", pinnedAt: null }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = makeFreshClient();
    const { result } = renderHook(() => useUnpinTask(), {
      wrapper: wrapper(client),
    });
    result.current.mutate("my-task");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/my-task/unpin",
      { method: "POST" },
    );
  });

  test("invalidates the tasks query on success", async () => {
    const tasks = [makeTask("a")];
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/tasks") {
        callCount++;
        return Promise.resolve(
          new Response(JSON.stringify(tasks), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: "a", pinnedAt: null }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = makeFreshClient();

    const { result } = renderHook(
      () => ({ tasks: useTasks(), unpin: useUnpinTask() }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(result.current.tasks.isSuccess).toBe(true));
    const initialCallCount = callCount;

    result.current.unpin.mutate("a");
    await waitFor(() => expect(result.current.unpin.isSuccess).toBe(true));

    await waitFor(() => expect(callCount).toBeGreaterThan(initialCallCount));
  });
});
