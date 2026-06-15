import type { TaskSummary } from "@trace/core/browser";

export type ProjectCount = {
  projectRoot: string;
  displayName: string;
  count: number;
};

export type ProjectTaskGroup = {
  projectRoot: string;
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
  projectRoot: string | null,
): TaskSummary[] {
  if (!projectRoot) return tasks;
  return tasks.filter((t) => t.projectRoot === projectRoot);
}

export function projectDisplayName(projectRoot: string): string {
  const normalizedPath = projectRoot.replace(/[/\\]+$/, "");
  const parts = normalizedPath.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? projectRoot;
}

export function getProjectCounts(tasks: TaskSummary[]): ProjectCount[] {
  const map = new Map<string, ProjectCount>();
  for (const task of tasks) {
    const root = task.projectRoot || "Unknown";
    const existing = map.get(root);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(root, {
        projectRoot: root,
        displayName: projectDisplayName(root),
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

export function groupTasksByProject(tasks: TaskSummary[]): ProjectTaskGroup[] {
  const groups = new Map<string, ProjectTaskGroup>();

  for (const task of tasks) {
    const projectRoot = task.projectRoot || "Unknown project";
    const group = groups.get(projectRoot);

    if (group) {
      group.tasks.push(task);
      continue;
    }

    groups.set(projectRoot, {
      projectRoot,
      displayName: projectDisplayName(projectRoot),
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
