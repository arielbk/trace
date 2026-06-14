import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import type { TaskSummary, TokenTotals } from "@trace/core";
import {
  archiveTask,
  filterByProject,
  FilterBar,
  getProjectCounts,
  TaskList,
  unarchiveTask,
  visibleTasks,
} from "./TasksPage.tsx";

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
    archivedAt: null,
    lastActivityAt: "2020-01-01T00:00:00.000Z",
    tokenTotals: tokens(0),
    agentTools: [],
    hasDocs: false,
    ...overrides,
  };
}

describe("visibleTasks", () => {
  test("hides archived tasks by default", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "active", title: "Active work", archivedAt: null }),
      summary({
        id: "archived",
        title: "Archived work",
        archivedAt: "2026-06-04T20:00:00.000Z",
      }),
    ];

    expect(visibleTasks(tasks).map((task) => task.id)).toEqual(["active"]);
  });

  test("includes archived tasks when requested", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "active", title: "Active work", archivedAt: null }),
      summary({
        id: "archived",
        title: "Archived work",
        archivedAt: "2026-06-04T20:00:00.000Z",
      }),
    ];

    expect(
      visibleTasks(tasks, { showArchived: true }).map((task) => task.id),
    ).toEqual(["active", "archived"]);
  });
});

describe("archiveTask", () => {
  test("posts to the archive endpoint for the task slug", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetcher = async (
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ) => {
      calls.push([String(input), init]);
      return new Response(
        JSON.stringify({
          id: "task-1",
          archivedAt: "2026-06-04T20:00:00.000Z",
        }),
        { status: 200 },
      );
    };

    await expect(archiveTask("task-1", fetcher)).resolves.toMatchObject({
      id: "task-1",
      archivedAt: "2026-06-04T20:00:00.000Z",
    });
    expect(calls).toEqual([["/api/tasks/task-1/archive", { method: "POST" }]]);
  });
});

describe("unarchiveTask", () => {
  test("posts to the unarchive endpoint for the task slug", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetcher = async (
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ) => {
      calls.push([String(input), init]);
      return new Response(
        JSON.stringify({
          id: "task-1",
          archivedAt: null,
        }),
        { status: 200 },
      );
    };

    await expect(unarchiveTask("task-1", fetcher)).resolves.toMatchObject({
      id: "task-1",
      archivedAt: null,
    });
    expect(calls).toEqual([
      ["/api/tasks/task-1/unarchive", { method: "POST" }],
    ]);
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

  test("each row carries a project chip with the project basename", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        title: "CLI work",
        projectRoot: "/work/trace-v2",
      }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    expect(html).toContain("task-row-project");
    expect(html).toContain("trace-v2");
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
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", title: "CLI work" }),
    ];

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

  test("subtitle shows task count and hidden archived count", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", title: "Work 1" }),
      summary({ id: "task-2", title: "Work 2" }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} hiddenArchivedCount={3} />
      </MemoryRouter>,
    );

    expect(html).toContain("2 tasks");
    expect(html).toContain("3 archived hidden");
  });

  test("subtitle omits archived hidden when count is zero", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "task-1", title: "Work" }),
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} hiddenArchivedCount={0} />
      </MemoryRouter>,
    );

    expect(html).toContain("1 tasks");
    expect(html).not.toContain("archived hidden");
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

describe("filterByProject", () => {
  test("returns all tasks when projectRoot is null", () => {
    const tasks = [
      summary({ id: "a", projectRoot: "/work/alpha" }),
      summary({ id: "b", projectRoot: "/work/beta" }),
    ];
    expect(filterByProject(tasks, null)).toEqual(tasks);
  });

  test("returns only tasks with matching projectRoot", () => {
    const tasks = [
      summary({ id: "a", projectRoot: "/work/alpha" }),
      summary({ id: "b", projectRoot: "/work/beta" }),
      summary({ id: "c", projectRoot: "/work/alpha" }),
    ];
    const result = filterByProject(tasks, "/work/alpha");
    expect(result.map((t) => t.id)).toEqual(["a", "c"]);
  });

  test("returns empty array when no tasks match the projectRoot", () => {
    const tasks = [summary({ id: "a", projectRoot: "/work/alpha" })];
    expect(filterByProject(tasks, "/work/other")).toEqual([]);
  });
});

describe("getProjectCounts", () => {
  test("returns one entry per unique projectRoot", () => {
    const tasks = [
      summary({ id: "a", projectRoot: "/work/alpha" }),
      summary({ id: "b", projectRoot: "/work/beta" }),
      summary({ id: "c", projectRoot: "/work/alpha" }),
    ];
    const counts = getProjectCounts(tasks);
    expect(counts).toHaveLength(2);
    expect(counts.map((p) => p.projectRoot)).toContain("/work/alpha");
    expect(counts.map((p) => p.projectRoot)).toContain("/work/beta");
  });

  test("count includes all tasks in the project regardless of archived state", () => {
    const tasks = [
      summary({ id: "a", projectRoot: "/work/alpha" }),
      summary({
        id: "b",
        projectRoot: "/work/alpha",
        archivedAt: "2026-06-01T00:00:00.000Z",
      }),
      summary({ id: "c", projectRoot: "/work/beta" }),
    ];
    const counts = getProjectCounts(tasks);
    const alpha = counts.find((p) => p.projectRoot === "/work/alpha");
    expect(alpha?.count).toBe(2);
  });

  test("displayName is the projectRoot basename", () => {
    const tasks = [summary({ id: "a", projectRoot: "/work/trace-v2" })];
    const counts = getProjectCounts(tasks);
    expect(counts[0]?.displayName).toBe("trace-v2");
  });

  test("returns entries sorted alphabetically by displayName", () => {
    const tasks = [
      summary({ id: "a", projectRoot: "/work/zebra" }),
      summary({ id: "b", projectRoot: "/work/alpha" }),
    ];
    const counts = getProjectCounts(tasks);
    expect(counts[0]?.displayName).toBe("alpha");
    expect(counts[1]?.displayName).toBe("zebra");
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
      { projectRoot: "/work/alpha", displayName: "alpha", count: 3 },
    ];
    const html = renderToStaticMarkup(
      <FilterBar
        projects={projects}
        selectedProject="/work/alpha"
        onProjectChange={() => undefined}
        showArchived={false}
        onShowArchivedChange={() => undefined}
      />,
    );
    expect(html).toContain("alpha");
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
