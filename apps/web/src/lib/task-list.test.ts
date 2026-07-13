import { describe, expect, test } from "vitest";
import type { TaskSummary, TokenTotals } from "@trace/core";
import {
  buildSubtitle,
  byActivityDesc,
  filterByProject,
  getProjectCounts,
  groupTasksByProject,
  partitionPinned,
  visibleTasks,
} from "./task-list.ts";

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

describe("visibleTasks", () => {
  test("hides archived tasks by default", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "active", archivedAt: null }),
      summary({ id: "archived", archivedAt: "2026-06-01T00:00:00.000Z" }),
    ];
    expect(visibleTasks(tasks).map((t) => t.id)).toEqual(["active"]);
  });

  test("includes archived when showArchived is true", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "active", archivedAt: null }),
      summary({ id: "archived", archivedAt: "2026-06-01T00:00:00.000Z" }),
    ];
    expect(
      visibleTasks(tasks, { showArchived: true }).map((t) => t.id),
    ).toEqual(["active", "archived"]);
  });

  test("returns empty array unchanged", () => {
    expect(visibleTasks([])).toEqual([]);
  });
});

describe("filterByProject", () => {
  test("returns all tasks when projectId is null", () => {
    const tasks = [
      summary({ id: "a", projectRoot: "/work/alpha" }),
      summary({ id: "b", projectRoot: "/work/beta" }),
    ];
    expect(filterByProject(tasks, null)).toEqual(tasks);
  });

  test("returns only tasks matching the given projectId", () => {
    const tasks = [
      summary({ id: "a", projectId: "project-alpha" }),
      summary({ id: "b", projectId: "project-beta" }),
      summary({ id: "c", projectId: "project-alpha" }),
    ];
    expect(filterByProject(tasks, "project-alpha").map((t) => t.id)).toEqual([
      "a",
      "c",
    ]);
  });

  test("returns empty array when no tasks match", () => {
    const tasks = [summary({ id: "a", projectId: "project-alpha" })];
    expect(filterByProject(tasks, "project-other")).toEqual([]);
  });

  test("matches stable project IDs across different checkout roots", () => {
    const tasks = [
      summary({
        id: "main",
        projectRoot: "/work/main",
        projectId: "project-alpha",
      }),
      summary({
        id: "worktree",
        projectRoot: "/tmp/alpha-worktree",
        projectId: "project-alpha",
      }),
      summary({
        id: "other",
        projectRoot: "/work/other",
        projectId: "project-beta",
      }),
    ];

    expect(
      filterByProject(tasks, "project-alpha").map((task) => task.id),
    ).toEqual(["main", "worktree"]);
  });
});

describe("getProjectCounts", () => {
  test("groups checkout roots by project ID and displays the persisted slug", () => {
    const tasks = [
      summary({
        id: "main",
        projectRoot: "/work/main",
        projectId: "project-alpha",
        projectSlug: "alpha-app",
      }),
      summary({
        id: "worktree",
        projectRoot: "/tmp/alpha-worktree",
        projectId: "project-alpha",
        projectSlug: "alpha-app",
      }),
    ];

    expect(getProjectCounts(tasks)).toEqual([
      { projectId: "project-alpha", displayName: "alpha-app", count: 2 },
    ]);
  });

  test("returns one entry per unique projectId", () => {
    const tasks = [
      summary({ id: "a", projectId: "project-alpha", projectSlug: "alpha" }),
      summary({ id: "b", projectId: "project-beta", projectSlug: "beta" }),
      summary({ id: "c", projectId: "project-alpha", projectSlug: "alpha" }),
    ];
    const counts = getProjectCounts(tasks);
    expect(counts).toHaveLength(2);
    expect(counts.map((project) => project.projectId).sort()).toEqual([
      "project-alpha",
      "project-beta",
    ]);
  });

  test("counts all tasks including archived", () => {
    const tasks = [
      summary({ id: "a", projectId: "project-alpha" }),
      summary({
        id: "b",
        projectId: "project-alpha",
        archivedAt: "2026-06-01T00:00:00.000Z",
      }),
      summary({ id: "c", projectId: "project-beta" }),
    ];
    const counts = getProjectCounts(tasks);
    const alpha = counts.find(
      (project) => project.projectId === "project-alpha",
    );
    expect(alpha?.count).toBe(2);
  });

  test("displayName is the persisted project slug", () => {
    const tasks = [
      summary({
        id: "a",
        projectRoot: "/work/renamed-checkout",
        projectSlug: "trace-v2",
      }),
    ];
    expect(getProjectCounts(tasks)[0]?.displayName).toBe("trace-v2");
  });

  test("results are sorted alphabetically by displayName", () => {
    const tasks = [
      summary({ id: "a", projectId: "project-zebra", projectSlug: "zebra" }),
      summary({ id: "b", projectId: "project-alpha", projectSlug: "alpha" }),
    ];
    const counts = getProjectCounts(tasks);
    expect(counts[0]?.displayName).toBe("alpha");
    expect(counts[1]?.displayName).toBe("zebra");
  });
});

describe("groupTasksByProject", () => {
  test("groups sibling checkout roots under the stable project ID and slug", () => {
    const groups = groupTasksByProject([
      summary({
        id: "main",
        projectRoot: "/work/main",
        projectId: "project-alpha",
        projectSlug: "alpha-app",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
      }),
      summary({
        id: "worktree",
        projectRoot: "/tmp/alpha-worktree",
        projectId: "project-alpha",
        projectSlug: "alpha-app",
        lastActivityAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      projectId: "project-alpha",
      displayName: "alpha-app",
    });
    expect(groups[0]?.tasks.map((task) => task.id)).toEqual([
      "worktree",
      "main",
    ]);
  });
});

describe("byActivityDesc", () => {
  test("orders more-recent tasks before older ones", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "a", lastActivityAt: "2020-01-01T00:00:00.000Z" }),
      summary({ id: "b", lastActivityAt: "2020-03-01T00:00:00.000Z" }),
      summary({ id: "c", lastActivityAt: "2020-02-01T00:00:00.000Z" }),
    ];
    const sorted = [...tasks].sort(byActivityDesc).map((t) => t.id);
    expect(sorted).toEqual(["b", "c", "a"]);
  });

  test("equal timestamps preserve existing order", () => {
    const ts = "2020-06-01T00:00:00.000Z";
    const tasks: TaskSummary[] = [
      summary({ id: "x", lastActivityAt: ts }),
      summary({ id: "y", lastActivityAt: ts }),
    ];
    const sorted = [...tasks].sort(byActivityDesc).map((t) => t.id);
    expect(sorted).toEqual(["x", "y"]);
  });
});

describe("buildSubtitle", () => {
  test("shows singular 'task' for count 1", () => {
    expect(buildSubtitle(1, 0)).toContain("1 task");
    expect(buildSubtitle(1, 0)).not.toContain("1 tasks");
  });

  test("shows plural 'tasks' for count > 1", () => {
    expect(buildSubtitle(3, 0)).toContain("3 tasks");
  });

  test("omits archived-hidden segment when count is zero", () => {
    expect(buildSubtitle(2, 0)).not.toContain("archived hidden");
  });

  test("includes archived-hidden segment when count > 0", () => {
    expect(buildSubtitle(2, 5)).toContain("5 archived hidden");
  });
});

describe("partitionPinned", () => {
  test("moves pinned tasks into the pinned partition, sorted by activity", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "plain", lastActivityAt: "2020-05-01T00:00:00.000Z" }),
      summary({
        id: "pinned-old",
        pinnedAt: "2020-01-01T00:00:00.000Z",
        lastActivityAt: "2020-02-01T00:00:00.000Z",
      }),
      summary({
        id: "pinned-new",
        pinnedAt: "2020-01-02T00:00:00.000Z",
        lastActivityAt: "2020-03-01T00:00:00.000Z",
      }),
    ];
    const { pinned, rest } = partitionPinned(tasks);
    expect(pinned.map((t) => t.id)).toEqual(["pinned-new", "pinned-old"]);
    expect(rest.map((t) => t.id)).toEqual(["plain"]);
  });

  test("sorts the rest partition by activity too", () => {
    const tasks: TaskSummary[] = [
      summary({ id: "older", lastActivityAt: "2020-01-01T00:00:00.000Z" }),
      summary({ id: "newer", lastActivityAt: "2020-02-01T00:00:00.000Z" }),
    ];
    const { pinned, rest } = partitionPinned(tasks);
    expect(pinned).toEqual([]);
    expect(rest.map((t) => t.id)).toEqual(["newer", "older"]);
  });

  test("yields an empty pinned partition when nothing is pinned", () => {
    const tasks: TaskSummary[] = [summary({ id: "a" }), summary({ id: "b" })];
    expect(partitionPinned(tasks).pinned).toEqual([]);
  });

  test("an archived task never lands in the pinned partition", () => {
    const tasks: TaskSummary[] = [
      summary({
        id: "archived-pinned",
        pinnedAt: "2020-01-01T00:00:00.000Z",
        archivedAt: "2020-06-01T00:00:00.000Z",
      }),
    ];
    const { pinned, rest } = partitionPinned(tasks);
    expect(pinned).toEqual([]);
    expect(rest.map((t) => t.id)).toEqual(["archived-pinned"]);
  });
});
