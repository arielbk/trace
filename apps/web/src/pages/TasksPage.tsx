import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { TaskSummary } from "@trace/core";
import { AppHeader } from "../components/AppHeader.tsx";
import { CopyChip } from "../components/CopyChip.tsx";
import {
  formatRelativeTime,
  formatTokenBreakdown,
  formatTokensCompact,
  truncateId,
} from "../format.ts";

export type ProjectTaskGroup = {
  projectRoot: string;
  displayName: string;
  tasks: TaskSummary[];
};

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);

  useEffect(() => {
    fetch("/api/tasks")
      .then((res) => res.json())
      .then(setTasks);
  }, []);

  if (tasks === null)
    return (
      <main>
        <p>Loading...</p>
      </main>
    );

  return (
    <main className="tasks-page">
      <AppHeader />
      <header className="page-header">
        <h1>Tasks</h1>
        <p className="page-subtitle">{tasks.length} tasks</p>
      </header>
      {tasks.length === 0 ? <p>No tasks found.</p> : <TaskList tasks={tasks} />}
    </main>
  );
}

export function TaskList({ tasks }: { tasks: TaskSummary[] }) {
  return (
    <div className="project-groups">
      {groupTasksByProject(tasks).map((group) => (
        <section className="project-group" key={group.projectRoot}>
          <header>
            <h2>{group.displayName}</h2>
            <CopyChip value={group.projectRoot} display={group.projectRoot} />
          </header>
          <ul>
            {group.tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TaskRow({ task }: { task: TaskSummary }) {
  const untitled = isUntitled(task.title);
  return (
    <li className={untitled ? "task-row task-row-untitled" : "task-row"}>
      <Link to={`/task/${task.id}`} className="task-row-link">
        <span className="task-row-title">
          {untitled ? "Untitled task" : task.title}
        </span>
      </Link>
      <CopyChip value={task.id} display={truncateId(task.id)} />
      <span
        className="task-row-tokens"
        title={formatTokenBreakdown(task.tokenTotals)}
      >
        {formatTokensCompact(task.tokenTotals.totalTokens)}
      </span>
      <span className="task-row-time">
        {formatRelativeTime(task.lastActivityAt)}
      </span>
    </li>
  );
}

/**
 * A task is "untitled" when its title is a raw UUID (no human-authored title was
 * ever set). We lean on `truncateId`'s documented contract: it shortens strict
 * UUIDs and returns anything else unchanged, so a changed result means the title
 * was a bare UUID.
 */
function isUntitled(title: string): boolean {
  return truncateId(title) !== title;
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

  // Sort rows newest-activity-first within each group, then order the groups
  // themselves by their single most recent activity so the liveliest project
  // sits on top.
  const ordered = Array.from(groups.values());
  for (const group of ordered) {
    group.tasks.sort(byActivityDesc);
  }
  ordered.sort(
    (a, b) =>
      activityEpoch(b.tasks[0]!) - activityEpoch(a.tasks[0]!),
  );

  return ordered;
}

function byActivityDesc(a: TaskSummary, b: TaskSummary): number {
  return activityEpoch(b) - activityEpoch(a);
}

function activityEpoch(task: TaskSummary): number {
  return new Date(task.lastActivityAt).getTime();
}

function projectDisplayName(projectRoot: string): string {
  const normalizedPath = projectRoot.replace(/[/\\]+$/, "");
  const parts = normalizedPath.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? projectRoot;
}
