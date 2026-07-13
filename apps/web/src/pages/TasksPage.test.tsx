// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { TaskSummary, TokenTotals } from "@trace/core";
import { FilterBar, TaskList, TasksPage } from "./TasksPage.tsx";

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
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
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

function tokens(totalTokens: number): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens,
  };
}

function summary(
  overrides: Partial<TaskSummary> & Pick<TaskSummary, "id">,
): TaskSummary {
  return {
    slug: overrides.id,
    title: "Untitled",
    createdAt: "2020-01-01T00:00:00.000Z",
    projectRoot: "/work/trace-v2",
    projectId: "project-trace-v2",
    projectSlug: "trace-v2",
    archivedAt: null,
    pinnedAt: null,
    lastActivityAt: "2020-01-01T00:00:00.000Z",
    tokenTotals: tokens(0),
    agentTools: [],
    hasDocs: false,
    ...overrides,
  };
}

function makeQueryWrapper(initialEntries: string[] = ["/"]) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(MemoryRouter, { initialEntries }, children),
    );
  };
}

describe("TasksPage", () => {
  test("renders a pulsing row skeleton once a slow tasks query outlasts the delay, not a bare Loading string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const { container } = render(<TasksPage />, {
      wrapper: makeQueryWrapper(),
    });

    // The skeleton is deferred past the delay so a fast load never flashes it.
    await waitFor(() => {
      expect(
        container.querySelectorAll(".task-row-skeleton").length,
      ).toBeGreaterThan(0);
    });
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  test("a fast tasks load reveals rows without flashing a skeleton", async () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", slug: "cli-work", title: "CLI work" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(tasks), { status: 200 }),
        ),
    );

    const { container } = render(<TasksPage />, {
      wrapper: makeQueryWrapper(),
    });
    await screen.findByText("CLI work");
    // Data beat the delay threshold, so no skeleton row was ever painted.
    expect(container.querySelectorAll(".task-row-skeleton").length).toBe(0);
  });

  test("a slow tasks load shows the skeleton, then reveals the real rows", async () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", slug: "cli-work", title: "CLI work" }),
    ];
    let resolveFetch: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending));

    const { container } = render(<TasksPage />, {
      wrapper: makeQueryWrapper(),
    });

    // Skeleton appears once the load outlasts the delay.
    await waitFor(() => {
      expect(
        container.querySelectorAll(".task-row-skeleton").length,
      ).toBeGreaterThan(0);
    });

    // Data lands → rows reveal and the skeleton layer eventually unmounts.
    resolveFetch(new Response(JSON.stringify(tasks), { status: 200 }));
    await screen.findByText("CLI work");
    await waitFor(() => {
      expect(container.querySelectorAll(".task-row-skeleton").length).toBe(0);
    });
  });

  test("renders task titles from the query payload", async () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", slug: "cli-work", title: "CLI work" }),
      summary({ id: "task-2", slug: "api-work", title: "API work" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(tasks), { status: 200 }),
        ),
    );
    render(<TasksPage />, { wrapper: makeQueryWrapper() });
    await screen.findByText("CLI work");
    expect(screen.getByText("API work")).toBeInTheDocument();
  });

  test("filters by project ID from the URL while displaying the project slug", async () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "main",
        title: "Main checkout task",
        projectRoot: "/work/main",
        projectId: "project-alpha",
        projectSlug: "alpha-app",
      }),
      summary({
        id: "worktree",
        title: "Worktree task",
        projectRoot: "/tmp/alpha-worktree",
        projectId: "project-alpha",
        projectSlug: "alpha-app",
      }),
      summary({
        id: "other",
        title: "Other project task",
        projectId: "project-beta",
        projectSlug: "beta-app",
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(tasks), { status: 200 }),
        ),
    );

    render(<TasksPage />, {
      wrapper: makeQueryWrapper(["/?project=project-alpha"]),
    });

    expect(await screen.findByText("Main checkout task")).toBeInTheDocument();
    expect(screen.getByText("Worktree task")).toBeInTheDocument();
    expect(screen.queryByText("Other project task")).not.toBeInTheDocument();
    const breadcrumb = screen.getByRole("navigation", { name: "Primary" });
    expect(breadcrumb).toHaveTextContent(/Trace\s*\/\s*alpha-app/);
    expect(breadcrumb).not.toHaveTextContent("project-alpha");
  });

  test("clicking archive fires POST to the archive endpoint after the settle time", async () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", slug: "cli-work", title: "CLI work" }),
    ];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/tasks") {
        return Promise.resolve(
          new Response(JSON.stringify(tasks), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "task-1",
            archivedAt: "2026-01-01T00:00:00.000Z",
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<TasksPage />, {
      wrapper: makeQueryWrapper(),
    });

    // Wait for tasks to load (real timers)
    await screen.findByText("CLI work");

    // Switch to fake timers for the archive animation
    vi.useFakeTimers();

    const row = container.querySelector(".task-row")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole("button", { name: "Archive CLI work" }));

    // Advance past the 2200ms commit timer
    await vi.advanceTimersByTimeAsync(2200);

    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/cli-work/archive", {
      method: "POST",
    });
  });

  test("clicking pin POSTs to the pin endpoint and the row moves into the Pinned section", async () => {
    const unpinned = [
      summary({ id: "task-1", slug: "cli-work", title: "CLI work" }),
    ];
    const pinned = [
      summary({
        id: "task-1",
        slug: "cli-work",
        title: "CLI work",
        pinnedAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    let pinCalled = false;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/tasks") {
        return Promise.resolve(
          new Response(JSON.stringify(pinCalled ? pinned : unpinned), {
            status: 200,
          }),
        );
      }
      pinCalled = true;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "task-1",
            pinnedAt: "2026-01-01T00:00:00.000Z",
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<TasksPage />, {
      wrapper: makeQueryWrapper(),
    });
    await screen.findByText("CLI work");
    expect(
      container.querySelector(".task-list-pinned"),
    ).not.toBeInTheDocument();

    const row = container.querySelector(".task-row")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole("button", { name: "Pin CLI work" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/tasks/cli-work/pin", {
        method: "POST",
      });
    });
    // Invalidation refetches the pinned payload; the row moves into the section.
    await waitFor(() => {
      expect(container.querySelector(".task-list-pinned")).toBeInTheDocument();
    });
    expect(
      container.querySelector(".task-list-pinned .task-row"),
    ).toBeInTheDocument();
  });

  test("clicking unpin on a pinned row POSTs to the unpin endpoint", async () => {
    const tasks = [
      summary({
        id: "task-1",
        slug: "cli-work",
        title: "CLI work",
        pinnedAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/tasks") {
        return Promise.resolve(
          new Response(JSON.stringify(tasks), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ id: "task-1", pinnedAt: null }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<TasksPage />, {
      wrapper: makeQueryWrapper(),
    });
    await screen.findByText("CLI work");

    const row = container.querySelector(".task-list-pinned .task-row")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole("button", { name: "Unpin CLI work" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/tasks/cli-work/unpin", {
        method: "POST",
      });
    });
  });
});

describe("TaskList rendering — flat recency-first", () => {
  test("renders all tasks in a single flat list sorted by lastActivityAt desc", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "a",
        projectRoot: "/work/alpha",
        lastActivityAt: "2020-01-01T00:00:00.000Z",
      }),
      summary({
        id: "b",
        projectRoot: "/work/beta",
        lastActivityAt: "2020-03-01T00:00:00.000Z",
      }),
      summary({
        id: "c",
        projectRoot: "/work/alpha",
        lastActivityAt: "2020-02-01T00:00:00.000Z",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    // b (March) before c (Feb) before a (Jan) — flat recency order across projects
    const idxB = html.indexOf('href="/task/b"');
    const idxC = html.indexOf('href="/task/c"');
    const idxA = html.indexOf('href="/task/a"');
    expect(idxB).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxA);
  });

  test("each row carries a project chip with the persisted project slug", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        title: "CLI work",
        projectRoot: "/work/renamed-checkout",
        projectSlug: "trace-v2",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain("task-row-project");
    expect(html).toContain("trace-v2");
    expect(html).not.toContain("renamed-checkout");
  });

  test("renders each row with title, relative time and compact token total", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        title: "CLI work",
        lastActivityAt: "2020-03-15T00:00:00.000Z",
        tokenTotals: {
          inputTokens: 81123,
          outputTokens: 5,
          cacheCreationInputTokens: 999,
          cacheReadInputTokens: 1_000_000,
          totalTokens: 16_317_514,
        },
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain("CLI work");
    expect(html).toContain('href="/task/task-1"');
    // Relative time (old timestamp falls back to absolute date).
    expect(html).toContain("Mar 15, 2020");
    // The visible figure is fresh spend (input + output).
    expect(html).toContain("81.1K");
    expect(html).not.toContain("16.3M");
    // The full breakdown is available on hover.
    expect(html).toContain("total 16317514");
  });

  test("renders a distinct untitled fallback when the title is a raw UUID", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const tasks: TaskSummary[] = [summary({ id, title: id })];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain("task-row-untitled");
    expect(html).toContain("Untitled task");
  });

  test("does not flag a human-authored title as untitled", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "550e8400-e29b-41d4-a716-446655440000",
        title: "Refactor the store",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).not.toContain("task-row-untitled");
    expect(html).toContain("Refactor the store");
  });

  test("links a row by its slug; slug is not shown as text in the row", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "550e8400-e29b-41d4-a716-446655440000",
        slug: "manual-break-start-sounds",
        title: "Manual Break Start & Sounds",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain('href="/task/manual-break-start-sounds"');
    expect(html).not.toContain(
      'href="/task/550e8400-e29b-41d4-a716-446655440000"',
    );
    expect(html).not.toContain("task-row-slug");
  });

  test("renders a description below the title when present, clamped to 2 lines", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        title: "CLI work",
        description: "Improve the CLI startup time",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain("CLI work");
    expect(html).toContain("Improve the CLI startup time");
    expect(html).toContain("task-row-description");
  });

  test("renders no description element when description is absent", () => {
    const tasks: TaskSummary[] = [summary({ id: "task-1", title: "CLI work" })];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).not.toContain("task-row-description");
  });

  test("archived rows carry the Archived badge and the task-row-archived class", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        title: "CLI work",
        archivedAt: "2026-06-04T20:00:00.000Z",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain("task-row-archived");
    expect(html).toContain("archived-badge");
  });

  test("shows Claude avatar when agentTools includes claude", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", title: "Work", agentTools: ["claude"] }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Claude"');
    expect(html).not.toContain('aria-label="Codex"');
  });

  test("shows Codex avatar when agentTools includes codex", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", title: "Work", agentTools: ["codex"] }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Codex"');
    expect(html).not.toContain('aria-label="Claude"');
  });

  test("shows Cursor avatar when agentTools includes cursor", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", title: "Work", agentTools: ["cursor"] }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Cursor"');
    expect(html).toContain("agent-avatar-cursor");
    expect(html).not.toContain('aria-label="Claude"');
    expect(html).not.toContain('aria-label="Codex"');
  });

  test("shows all three avatars when agentTools has claude, codex and cursor", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        title: "Work",
        agentTools: ["claude", "codex", "cursor"],
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Claude"');
    expect(html).toContain('aria-label="Codex"');
    expect(html).toContain('aria-label="Cursor"');
  });

  test("shows both avatars when agentTools has claude and codex", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        title: "Work",
        agentTools: ["claude", "codex"],
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Claude"');
    expect(html).toContain('aria-label="Codex"');
  });

  test("shows no agent avatars when agentTools is empty", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", title: "Work", agentTools: [] }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).not.toContain('aria-label="Claude"');
    expect(html).not.toContain('aria-label="Codex"');
  });

  test("shows docs indicator when hasDocs is true", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", title: "Work", hasDocs: true }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain("docs-indicator");
  });

  test("does not show docs indicator when hasDocs is false", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", title: "Work", hasDocs: false }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).not.toContain("docs-indicator");
  });

  test("empty state shows 'No tasks in this view.' when list is empty", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={[]} />
      </MemoryRouter>,
    );

    expect(html).toContain("No tasks in this view.");
  });

  test("renders an archive button for each active row", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        slug: "cli-work",
        title: "CLI work",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} onArchive={() => undefined} />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Archive CLI work"');
  });

  test("renders a copy re-enter prompt action carrying the built prompt", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", slug: "cli-work", title: "CLI work" }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} onArchive={() => undefined} />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Copy re-enter prompt"');
    expect(html).toContain(
      "Re-enter the trace task &quot;CLI work&quot; (cli-work)",
    );
  });

  test("shows the copy-prompt action on archived rows too", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        slug: "cli-work",
        title: "CLI work",
        archivedAt: "2026-06-04T20:00:00.000Z",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} onUnarchive={() => undefined} />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Copy re-enter prompt"');
    expect(html).toContain('aria-label="Unarchive CLI work"');
  });

  test("renders archived rows muted with an unarchive button", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        slug: "cli-work",
        title: "CLI work",
        archivedAt: "2026-06-04T20:00:00.000Z",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} onUnarchive={() => undefined} />
      </MemoryRouter>,
    );

    expect(html).toContain("task-row-archived");
    expect(html).toContain('aria-label="Unarchive CLI work"');
    expect(html).not.toContain('aria-label="Archive CLI work"');
  });
});

describe("TaskList pinned section", () => {
  test("pinned tasks render in a Pinned section above the rest, moved not duplicated", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "recent-unpinned",
        title: "Recent unpinned",
        lastActivityAt: "2020-06-01T00:00:00.000Z",
      }),
      summary({
        id: "old-pinned",
        title: "Old pinned",
        pinnedAt: "2020-01-01T00:00:00.000Z",
        lastActivityAt: "2020-02-01T00:00:00.000Z",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain("task-list-pinned-heading");
    // The pinned row leads despite older activity.
    const idxPinned = html.indexOf('href="/task/old-pinned"');
    const idxUnpinned = html.indexOf('href="/task/recent-unpinned"');
    expect(idxPinned).toBeGreaterThan(-1);
    expect(idxPinned).toBeLessThan(idxUnpinned);
    // Moved, not duplicated.
    expect(html.indexOf('href="/task/old-pinned"')).toBe(
      html.lastIndexOf('href="/task/old-pinned"'),
    );
  });

  test("pinned section sorts its rows by activity", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "pinned-old",
        pinnedAt: "2020-01-05T00:00:00.000Z",
        lastActivityAt: "2020-01-01T00:00:00.000Z",
      }),
      summary({
        id: "pinned-new",
        pinnedAt: "2020-01-01T00:00:00.000Z",
        lastActivityAt: "2020-03-01T00:00:00.000Z",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html.indexOf('href="/task/pinned-new"')).toBeLessThan(
      html.indexOf('href="/task/pinned-old"'),
    );
  });

  test("both sections get accent headings and no divider rule between them", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "unpinned", title: "Unpinned work" }),
      summary({
        id: "pinned",
        title: "Pinned work",
        pinnedAt: "2020-01-01T00:00:00.000Z",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain(">Pinned<");
    expect(html).toContain(">Recent<");
    const pinnedHeading =
      html.match(/<h2 class="(task-list-pinned-heading[^"]*)"/)?.[1] ?? "";
    const restHeading =
      html.match(/<h2 class="(task-list-rest-heading[^"]*)"/)?.[1] ?? "";
    expect(pinnedHeading).toContain("text-accent");
    expect(restHeading).toContain("text-accent");
    // Section separation comes from the headings, not a horizontal rule.
    // (Match "border-b" as a whole class; "border-border" on rows is fine.)
    expect(html).not.toMatch(/border-b[ "]/);
  });

  test("no Pinned section renders when nothing is pinned", () => {
    const tasks: TaskSummary[] = [summary({ id: "task-1", title: "CLI work" })];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).not.toContain("task-list-pinned-heading");
    expect(html).not.toContain(">Pinned<");
    // Without a Pinned section there is nothing to distinguish from, so the
    // rest of the list gets no heading either.
    expect(html).not.toContain("task-list-rest-heading");
  });

  test("an archived pinned task stays out of the Pinned section", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        title: "CLI work",
        pinnedAt: "2020-01-01T00:00:00.000Z",
        archivedAt: "2020-06-01T00:00:00.000Z",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).not.toContain("task-list-pinned-heading");
    expect(html).toContain('href="/task/task-1"');
  });
});

describe("FilterBar", () => {
  test("shows 'All projects' in trigger when selectedProject is null", () => {
    const html = renderToStaticMarkup(
      <FilterBar
        projects={[]}
        selectedProject={null}
        onProjectChange={() => undefined}
        showArchived={false}
        onShowArchivedChange={() => undefined}
      />,
    );
    expect(html).toContain("All projects");
  });

  test("shows selected project displayName in trigger when project is selected", () => {
    const projects = [
      { projectId: "project-alpha", displayName: "alpha", count: 3 },
    ];
    const html = renderToStaticMarkup(
      <FilterBar
        projects={projects}
        selectedProject="project-alpha"
        onProjectChange={() => undefined}
        showArchived={false}
        onShowArchivedChange={() => undefined}
      />,
    );
    expect(html).toContain("alpha");
  });

  test("selecting a project reports its stable ID while showing its slug", async () => {
    const onProjectChange = vi.fn();
    render(
      <FilterBar
        projects={[
          { projectId: "project-alpha", displayName: "alpha-app", count: 3 },
        ]}
        selectedProject={null}
        onProjectChange={onProjectChange}
        showArchived={false}
        onShowArchivedChange={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Project filter: All projects" }),
    );
    fireEvent.click(await screen.findByText("alpha-app"));

    expect(onProjectChange).toHaveBeenCalledWith("project-alpha");
  });

  test("renders the Show archived label", () => {
    const html = renderToStaticMarkup(
      <FilterBar
        projects={[]}
        selectedProject={null}
        onProjectChange={() => undefined}
        showArchived={false}
        onShowArchivedChange={() => undefined}
      />,
    );
    expect(html).toContain("Show archived");
  });

  test("renders a switch with show-archived-switch id", () => {
    const html = renderToStaticMarkup(
      <FilterBar
        projects={[]}
        selectedProject={null}
        onProjectChange={() => undefined}
        showArchived={false}
        onShowArchivedChange={() => undefined}
      />,
    );
    expect(html).toContain("show-archived-switch");
  });
});

describe("TaskRow hover-swap", () => {
  test("hovering a row hides the meta cluster and reveals the actions", () => {
    const tasks: TaskSummary[] = [summary({ id: "task-1", title: "CLI work" })];
    const { container } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} onArchive={() => undefined} />
      </MemoryRouter>,
    );

    const meta = container.querySelector(".task-row-meta")!;
    const actions = container.querySelector(".task-row-actions")!;
    const row = container.querySelector(".task-row")!;

    expect(meta).not.toHaveClass("opacity-0");
    expect(actions).toHaveClass("opacity-0");

    fireEvent.mouseEnter(row);

    expect(meta).toHaveClass("opacity-0");
    expect(actions).not.toHaveClass("opacity-0");
  });

  test("mouse leave restores meta and hides actions", () => {
    const tasks: TaskSummary[] = [summary({ id: "task-1", title: "CLI work" })];
    const { container } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} onArchive={() => undefined} />
      </MemoryRouter>,
    );

    const meta = container.querySelector(".task-row-meta")!;
    const actions = container.querySelector(".task-row-actions")!;
    const row = container.querySelector(".task-row")!;

    fireEvent.mouseEnter(row);
    fireEvent.mouseLeave(row);

    expect(meta).not.toHaveClass("opacity-0");
    expect(actions).toHaveClass("opacity-0");
  });

  test("Re-enter button shows Copied aria-label after click", async () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", slug: "cli-work", title: "CLI work" }),
    ];
    render(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    const btn = screen.getByRole("button", { name: "Copy re-enter prompt" });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Copied" }),
      ).toBeInTheDocument();
    });
  });

  test("clicking archive button calls onArchive after the confirmation window", async () => {
    vi.useFakeTimers();
    const onArchive = vi.fn();
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", slug: "cli-work", title: "CLI work" }),
    ];
    const { container } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} onArchive={onArchive} />
      </MemoryRouter>,
    );

    const row = container.querySelector(".task-row")!;
    fireEvent.mouseEnter(row);

    const archiveBtn = screen.getByRole("button", { name: "Archive CLI work" });
    fireEvent.click(archiveBtn);

    expect(onArchive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2200);

    expect(onArchive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
    );
  });

  test("archive button swaps to a held success check after click", async () => {
    vi.useFakeTimers();
    const onArchive = vi.fn().mockResolvedValue(undefined);
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", slug: "cli-work", title: "CLI work" }),
    ];
    const { container } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} onArchive={onArchive} />
      </MemoryRouter>,
    );

    const row = container.querySelector(".task-row")!;
    fireEvent.mouseEnter(row);

    const archiveBtn = screen.getByRole("button", { name: "Archive CLI work" });
    expect(archiveBtn).not.toHaveAttribute("title");
    fireEvent.click(archiveBtn);

    expect(onArchive).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Unarchive CLI work" }),
    ).toBeEnabled();
    fireEvent.mouseLeave(row);
    expect(container.querySelector(".task-row-actions")).not.toHaveClass(
      "opacity-0",
    );
    expect(container.querySelector(".t-success-check")).toHaveAttribute(
      "data-state",
      "in",
    );
  });

  test("clicking success archive button cancels the pending archive", async () => {
    vi.useFakeTimers();
    const onArchive = vi.fn().mockResolvedValue(undefined);
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", slug: "cli-work", title: "CLI work" }),
    ];
    const { container } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} onArchive={onArchive} />
      </MemoryRouter>,
    );

    const row = container.querySelector(".task-row")!;
    fireEvent.mouseEnter(row);

    fireEvent.click(screen.getByRole("button", { name: "Archive CLI work" }));
    fireEvent.click(screen.getByRole("button", { name: "Unarchive CLI work" }));
    await vi.advanceTimersByTimeAsync(2200);

    expect(onArchive).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Archive CLI work" }),
    ).toBeInTheDocument();
  });

  test("renders a pin button for an unpinned active row; clicking calls onPin", () => {
    const onPin = vi.fn();
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", slug: "cli-work", title: "CLI work" }),
    ];
    const { container } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} onPin={onPin} />
      </MemoryRouter>,
    );

    const row = container.querySelector(".task-row")!;
    fireEvent.mouseEnter(row);

    const pinBtn = screen.getByRole("button", { name: "Pin CLI work" });
    fireEvent.click(pinBtn);

    expect(onPin).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
    );
  });

  test("renders an unpin button for a pinned row; clicking calls onUnpin", () => {
    const onUnpin = vi.fn();
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        slug: "cli-work",
        title: "CLI work",
        pinnedAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    const { container } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} onPin={() => undefined} onUnpin={onUnpin} />
      </MemoryRouter>,
    );

    const row = container.querySelector(".task-row")!;
    fireEvent.mouseEnter(row);

    expect(
      screen.queryByRole("button", { name: "Pin CLI work" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unpin CLI work" }));

    expect(onUnpin).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
    );
  });

  test("archived rows carry no pin toggle", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        slug: "cli-work",
        title: "CLI work",
        archivedAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList
          tasks={tasks}
          onPin={() => undefined}
          onUnpin={() => undefined}
          onUnarchive={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).not.toContain('aria-label="Pin CLI work"');
    expect(html).not.toContain('aria-label="Unpin CLI work"');
  });

  test("clicking unarchive button calls onUnarchive with the task", () => {
    const onUnarchive = vi.fn();
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        slug: "cli-work",
        title: "CLI work",
        archivedAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    const { container } = render(
      <MemoryRouter>
        <TaskList tasks={tasks} onUnarchive={onUnarchive} />
      </MemoryRouter>,
    );

    const row = container.querySelector(".task-row")!;
    fireEvent.mouseEnter(row);

    const unarchiveBtn = screen.getByRole("button", {
      name: "Unarchive CLI work",
    });
    fireEvent.click(unarchiveBtn);

    expect(onUnarchive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
    );
  });
});
