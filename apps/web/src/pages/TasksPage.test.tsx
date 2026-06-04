import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import type { TaskSummary, TokenTotals } from "@trace/core";
import {
  archiveTask,
  groupTasksByProject,
  TaskList,
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
    // Slug defaults to the id so existing id-based route assertions stay valid;
    // tests that exercise slug routing pass an explicit slug.
    slug: overrides.id,
    title: "Untitled",
    createdAt: "2020-01-01T00:00:00.000Z",
    projectRoot: "/work/trace-v2",
    archivedAt: null,
    lastActivityAt: "2020-01-01T00:00:00.000Z",
    tokenTotals: tokens(0),
    ...overrides,
  };
}

describe("groupTasksByProject", () => {
  test("derives the basename display name and groups by project root", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        title: "CLI work",
        projectRoot: "/work/trace-v2",
      }),
      summary({ id: "task-2", title: "Docs work", projectRoot: "/work/docs" }),
      summary({
        id: "task-3",
        title: "Web work",
        projectRoot: "/work/trace-v2",
      }),
    ];

    const groups = groupTasksByProject(tasks);
    expect(groups.map((g) => g.displayName)).toEqual(["trace-v2", "docs"]);
    expect(groups[0]!.projectRoot).toBe("/work/trace-v2");
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(["task-1", "task-3"]);
    expect(groups[1]!.tasks.map((t) => t.id)).toEqual(["task-2"]);
  });

  test("sorts rows newest-activity-first within each group", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "old", lastActivityAt: "2020-03-01T00:00:00.000Z" }),
      summary({ id: "new", lastActivityAt: "2020-05-01T00:00:00.000Z" }),
      summary({ id: "mid", lastActivityAt: "2020-04-01T00:00:00.000Z" }),
    ];

    expect(groupTasksByProject(tasks)[0]!.tasks.map((t) => t.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  test("orders groups by their most recent activity first", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "docs-old",
        projectRoot: "/work/docs",
        lastActivityAt: "2020-01-01T00:00:00.000Z",
      }),
      summary({
        id: "trace-new",
        projectRoot: "/work/trace-v2",
        lastActivityAt: "2020-05-01T00:00:00.000Z",
      }),
      summary({
        id: "trace-mid",
        projectRoot: "/work/trace-v2",
        lastActivityAt: "2020-03-01T00:00:00.000Z",
      }),
    ];

    expect(groupTasksByProject(tasks).map((g) => g.displayName)).toEqual([
      "trace-v2",
      "docs",
    ]);
  });
});

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

describe("TaskList rendering", () => {
  test("renders project heading with a copyable muted path", () => {
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

    expect(html).toContain("trace-v2");
    // Path is copyable: rendered via a CopyChip carrying the full path.
    expect(html).toContain('aria-label="Copy /work/trace-v2"');
  });

  test("renders each row with title, relative time and compact token total", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "task-1",
        title: "CLI work",
        lastActivityAt: "2020-03-15T00:00:00.000Z",
        tokenTotals: tokens(16_317_514),
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
    // Compact token total with the exact breakdown available on hover.
    expect(html).toContain("16.3M");
    expect(html).toContain("total 16317514");
  });

  test("renders the short copyable UUID for a row", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const tasks: TaskSummary[] = [summary({ id, title: "Real title" })];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskList tasks={tasks} />
      </MemoryRouter>,
    );

    // Copy chip shows the truncated form but carries the full id.
    expect(html).toContain("550e8400");
    expect(html).toContain(`aria-label="Copy ${id}"`);
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

  test("links a row by its slug and shows the slug as a readable handle", () => {
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

    // Route is the human-readable slug, not the UUID.
    expect(html).toContain('href="/task/manual-break-start-sounds"');
    expect(html).not.toContain(
      'href="/task/550e8400-e29b-41d4-a716-446655440000"',
    );
    // The slug renders as a visible handle in the row.
    expect(html).toContain("manual-break-start-sounds");
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
});
