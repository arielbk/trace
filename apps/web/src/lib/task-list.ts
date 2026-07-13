import type { TaskSummary } from "@trace/core/browser";

export type ProjectCount = {
  projectId: string;
  displayName: string;
  count: number;
};

export type ProjectTaskGroup = {
  projectId: string;
  displayName: string;
  tasks: TaskSummary[];
};

type VisibilityOptions = {
  showArchived?: boolean;
};

export function visibleTasks(
  tasks: TaskSummary[],
  options: VisibilityOptions = {},
): TaskSummary[] {
  if (options.showArchived) return tasks;
  return tasks.filter((task) => task.archivedAt === null);
}

export function filterByProject(
  tasks: TaskSummary[],
  projectId: string | null,
): TaskSummary[] {
  if (!projectId) return tasks;
  return tasks.filter((task) => task.projectId === projectId);
}

export function getProjectCounts(tasks: TaskSummary[]): ProjectCount[] {
  const map = new Map<string, ProjectCount>();
  for (const task of tasks) {
    const existing = map.get(task.projectId);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(task.projectId, {
        projectId: task.projectId,
        displayName: task.projectSlug,
        count: 1,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
}

export function buildSubtitle(
  taskCount: number,
  hiddenArchivedCount: number,
): string {
  const parts = [`${taskCount} ${taskCount === 1 ? "task" : "tasks"}`];
  if (hiddenArchivedCount > 0) {
    parts.push(`${hiddenArchivedCount} archived hidden`);
  }
  return parts.join("  ·  ");
}

export function byActivityDesc(a: TaskSummary, b: TaskSummary): number {
  return activityEpoch(b) - activityEpoch(a);
}

export function activityEpoch(task: TaskSummary): number {
  return new Date(task.lastActivityAt).getTime();
}

export function partitionPinned(tasks: TaskSummary[]): {
  pinned: TaskSummary[];
  rest: TaskSummary[];
} {
  const pinned: TaskSummary[] = [];
  const rest: TaskSummary[] = [];
  for (const task of tasks) {
    if (task.pinnedAt !== null && task.archivedAt === null) {
      pinned.push(task);
    } else {
      rest.push(task);
    }
  }
  pinned.sort(byActivityDesc);
  rest.sort(byActivityDesc);
  return { pinned, rest };
}

export function groupTasksByProject(tasks: TaskSummary[]): ProjectTaskGroup[] {
  const groups = new Map<string, ProjectTaskGroup>();

  for (const task of tasks) {
    const group = groups.get(task.projectId);

    if (group) {
      group.tasks.push(task);
      continue;
    }

    groups.set(task.projectId, {
      projectId: task.projectId,
      displayName: task.projectSlug,
      tasks: [task],
    });
  }

  const ordered = Array.from(groups.values());
  for (const group of ordered) {
    group.tasks.sort(byActivityDesc);
  }
  ordered.sort(
    (a, b) => activityEpoch(b.tasks[0]!) - activityEpoch(a.tasks[0]!),
  );

  return ordered;
}
