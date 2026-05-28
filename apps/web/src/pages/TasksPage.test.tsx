import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import type { Task } from "@trace/core";
import { groupTasksByProject, TaskList } from "./TasksPage.tsx";

const baseTask = {
  createdAt: "2026-05-28T00:00:00.000Z",
} satisfies Pick<Task, "createdAt">;

describe("groupTasksByProject", () => {
  test("groups tasks by project root and derives the basename display name", () => {
    const tasks: Task[] = [
      {
        ...baseTask,
        id: "task-1",
        title: "CLI work",
        projectRoot: "/work/trace-v2",
      },
      {
        ...baseTask,
        id: "task-2",
        title: "Docs work",
        projectRoot: "/work/docs",
      },
      {
        ...baseTask,
        id: "task-3",
        title: "Web work",
        projectRoot: "/work/trace-v2",
      },
    ];

    expect(groupTasksByProject(tasks)).toEqual([
      {
        projectRoot: "/work/trace-v2",
        displayName: "trace-v2",
        tasks: [tasks[0], tasks[2]],
      },
      {
        projectRoot: "/work/docs",
        displayName: "docs",
        tasks: [tasks[1]],
      },
    ]);
  });
});

test("TaskList renders project headings and nested task links", () => {
  const tasks: Task[] = [
    {
      ...baseTask,
      id: "task-1",
      title: "CLI work",
      projectRoot: "/work/trace-v2",
    },
    {
      ...baseTask,
      id: "task-2",
      title: "Docs work",
      projectRoot: "/work/docs",
    },
  ];

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskList tasks={tasks} />
    </MemoryRouter>,
  );

  expect(html).toContain("<h2>trace-v2</h2>");
  expect(html).toContain("/work/trace-v2");
  expect(html).toContain('href="/task/task-1"');
  expect(html).toContain("<h2>docs</h2>");
  expect(html).toContain('href="/task/task-2"');
});
