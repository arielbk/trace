import { describe, expect, test } from "vitest";
import type { TaskSummary, TokenTotals } from "@trace/core";
import {
  buildSubtitle,
  byActivityDesc,
  filterByProject,
  getProjectCounts,
  projectDisplayName,
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
    expect(visibleTasks(tasks, { showArchived: true }).map((t) => t.id)).toEqual(
      ["active", "archived"],
    );
  });

  test("returns empty array unchanged", () => {
    expect(visibleTasks([])).toEqual([]);
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

  test("returns only tasks matching the given projectRoot", () => {
    const tasks = [
      summary({ id: "a", projectRoot: "/work/alpha" }),
      summary({ id: "b", projectRoot: "/work/beta" }),
      summary({ id: "c", projectRoot: "/work/alpha" }),
    ];
    expect(filterByProject(tasks, "/work/alpha").map((t) => t.id)).toEqual([
      "a",
      "c",
    ]);
  });

  test("returns empty array when no tasks match", () => {
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
    expect(counts.map((p) => p.projectRoot).sort()).toEqual([
      "/work/alpha",
      "/work/beta",
    ]);
  });

  test("counts all tasks including archived", () => {
    const tasks = [
      summary({ id: "a", projectRoot: "/work/alpha" }),
      summary({ id: "b", projectRoot: "/work/alpha", archivedAt: "2026-06-01T00:00:00.000Z" }),
      summary({ id: "c", projectRoot: "/work/beta" }),
    ];
    const counts = getProjectCounts(tasks);
    const alpha = counts.find((p) => p.projectRoot === "/work/alpha");
    expect(alpha?.count).toBe(2);
  });

  test("displayName is the basename of projectRoot", () => {
    const tasks = [summary({ id: "a", projectRoot: "/work/trace-v2" })];
    expect(getProjectCounts(tasks)[0]?.displayName).toBe("trace-v2");
  });

  test("results are sorted alphabetically by displayName", () => {
    const tasks = [
      summary({ id: "a", projectRoot: "/work/zebra" }),
      summary({ id: "b", projectRoot: "/work/alpha" }),
    ];
    const counts = getProjectCounts(tasks);
    expect(counts[0]?.displayName).toBe("alpha");
    expect(counts[1]?.displayName).toBe("zebra");
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

describe("projectDisplayName", () => {
  test("returns the last path segment", () => {
    expect(projectDisplayName("/work/trace-v2")).toBe("trace-v2");
  });

  test("handles trailing slashes", () => {
    expect(projectDisplayName("/work/trace-v2/")).toBe("trace-v2");
  });

  test("returns the input as-is when it has no separators", () => {
    expect(projectDisplayName("standalone")).toBe("standalone");
  });
});
