import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { TaskSummary } from "@trace/core";
import { AppHeader } from "../components/AppHeader.tsx";
import { CopyChip } from "../components/CopyChip.tsx";
import { useClipboardCopy } from "../components/useClipboardCopy.ts";
import {
  buildReEnterPrompt,
  collapseHomePath,
  formatRelativeTime,
  formatTokenBreakdown,
  formatTokensCompact,
  truncateId,
} from "../format.ts";

type ArchiveTaskResult = Pick<TaskSummary, "id" | "archivedAt">;
type FetchTask = typeof fetch;
type VisibilityOptions = {
  showArchived?: boolean;
};

export type ProjectTaskGroup = {
  projectRoot: string;
  displayName: string;
  tasks: TaskSummary[];
};

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [home, setHome] = useState("");

  useEffect(() => {
    fetch("/api/tasks")
      .then((res) => res.json())
      .then(setTasks);
    fetch("/api/config")
      .then((res) => res.json())
      .then((config: { home: string }) => setHome(config.home));
  }, []);

  if (tasks === null)
    return (
      <main>
        <p>Loading...</p>
      </main>
    );

  const displayedTasks = visibleTasks(tasks, { showArchived });
  async function handleArchive(task: TaskSummary): Promise<void> {
    const archived = await archiveTask(task.slug);
    setTasks(
      (current) =>
        current?.map((existing) =>
          existing.id === archived.id
            ? { ...existing, archivedAt: archived.archivedAt }
            : existing,
        ) ?? current,
    );
  }
  async function handleUnarchive(task: TaskSummary): Promise<void> {
    const unarchived = await unarchiveTask(task.slug);
    setTasks(
      (current) =>
        current?.map((existing) =>
          existing.id === unarchived.id
            ? { ...existing, archivedAt: unarchived.archivedAt }
            : existing,
        ) ?? current,
    );
  }

  return (
    <main className="tasks-page">
      <AppHeader />
      <header className="page-header tasks-page-header">
        <div>
          <h1>Tasks</h1>
          <p className="page-subtitle">{displayedTasks.length} tasks</p>
        </div>
        <label className="show-archived-toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.currentTarget.checked)}
          />
          <span>Show archived</span>
        </label>
      </header>
      {displayedTasks.length === 0 ? (
        <p>No tasks found.</p>
      ) : (
        <TaskList
          tasks={displayedTasks}
          onArchive={handleArchive}
          onUnarchive={handleUnarchive}
          home={home}
        />
      )}
    </main>
  );
}

export function TaskList({
  tasks,
  onArchive,
  onUnarchive,
  home = "",
}: {
  tasks: TaskSummary[];
  onArchive?: (task: TaskSummary) => void | Promise<void>;
  onUnarchive?: (task: TaskSummary) => void | Promise<void>;
  /** User home directory; when provided, project paths are displayed as ~-collapsed. */
  home?: string;
}) {
  return (
    <div className="project-groups">
      {groupTasksByProject(tasks).map((group) => (
        <section className="project-group" key={group.projectRoot}>
          <header>
            <h2>{group.displayName}</h2>
            <CopyChip
              value={group.projectRoot}
              display={collapseHomePath(group.projectRoot, home)}
            />
          </header>
          <ul>
            {group.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onArchive={onArchive}
                onUnarchive={onUnarchive}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TaskRow({
  task,
  onArchive,
  onUnarchive,
}: {
  task: TaskSummary;
  onArchive?: (task: TaskSummary) => void | Promise<void>;
  onUnarchive?: (task: TaskSummary) => void | Promise<void>;
}) {
  const untitled = isUntitled(task.title);
  const archived = task.archivedAt !== null;
  const rowClasses = [
    "task-row",
    untitled ? "task-row-untitled" : null,
    archived ? "task-row-archived" : null,
  ]
    .filter(Boolean)
    .join(" ");
  const archiveLabel = `Archive ${untitled ? "untitled task" : task.title}`;
  const unarchiveLabel = `Unarchive ${untitled ? "untitled task" : task.title}`;
  return (
    <li className={rowClasses}>
      <Link to={`/task/${task.slug}`} className="task-row-link">
        <span className="task-row-title">
          {untitled ? "Untitled task" : task.title}
        </span>
        {!untitled && task.description ? (
          <span className="task-row-description">{task.description}</span>
        ) : null}
      </Link>
      <span
        className="task-row-tokens"
        title={formatTokenBreakdown(task.tokenTotals)}
      >
        {formatTokensCompact(task.tokenTotals.totalTokens)}
      </span>
      <span className="task-row-time">
        {formatRelativeTime(task.lastActivityAt)}
      </span>
      <div className="task-row-actions">
        <CopyPromptAction title={task.title} slug={task.slug} />
        {archived && onUnarchive ? (
          <button
            type="button"
            className="task-row-action"
            aria-label={unarchiveLabel}
            title={unarchiveLabel}
            onClick={() => void onUnarchive(task)}
          >
            <UnarchiveIcon />
          </button>
        ) : onArchive ? (
          <button
            type="button"
            className="task-row-action"
            aria-label={archiveLabel}
            title={archiveLabel}
            onClick={() => void onArchive(task)}
          >
            <ArchiveIcon />
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Quiet icon action that copies the task's re-enter prompt — the same builder
 * output as the detail page's copy button. The full prompt rides along as the
 * `title` tooltip; the icon swaps to a check for a beat after a copy.
 */
function CopyPromptAction({ title, slug }: { title: string; slug: string }) {
  const { copied, copy } = useClipboardCopy();
  const prompt = buildReEnterPrompt(title, slug);
  return (
    <button
      type="button"
      className="task-row-action"
      aria-label="Copy re-enter prompt"
      title={prompt}
      onClick={() => void copy(prompt)}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

function UnarchiveIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="m9.5 15 2.5-2.5L14.5 15" />
      <path d="M12 12.5V18" />
    </svg>
  );
}

/**
 * A task is "untitled" when no human-authored title was ever set. New untitled
 * tasks carry an empty title (and a `task-<id>` placeholder slug); legacy rows
 * created before slugs used the raw UUID as the title. We detect the latter via
 * `truncateId`'s documented contract — it shortens strict UUIDs and returns
 * anything else unchanged, so a changed result means the title was a bare UUID.
 */
function isUntitled(title: string): boolean {
  return title === "" || truncateId(title) !== title;
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
    (a, b) => activityEpoch(b.tasks[0]!) - activityEpoch(a.tasks[0]!),
  );

  return ordered;
}

export function visibleTasks(
  tasks: TaskSummary[],
  options: VisibilityOptions = {},
): TaskSummary[] {
  if (options.showArchived) {
    return tasks;
  }

  return tasks.filter((task) => task.archivedAt === null);
}

export async function archiveTask(
  ref: string,
  fetcher: FetchTask = fetch,
): Promise<ArchiveTaskResult> {
  const response = await fetcher(
    `/api/tasks/${encodeURIComponent(ref)}/archive`,
    { method: "POST" },
  );

  if (!response.ok) {
    throw new Error(`Failed to archive task ${ref}`);
  }

  return (await response.json()) as ArchiveTaskResult;
}

export async function unarchiveTask(
  ref: string,
  fetcher: FetchTask = fetch,
): Promise<ArchiveTaskResult> {
  const response = await fetcher(
    `/api/tasks/${encodeURIComponent(ref)}/unarchive`,
    { method: "POST" },
  );

  if (!response.ok) {
    throw new Error(`Failed to unarchive task ${ref}`);
  }

  return (await response.json()) as ArchiveTaskResult;
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
