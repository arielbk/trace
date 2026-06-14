import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { freshTokenTotal, type TaskSummary } from "@trace/core";
import type { SessionTool } from "@trace/core";
import { AppHeader } from "../components/AppHeader.tsx";
import { useClipboardCopy } from "../components/useClipboardCopy.ts";
import { cn } from "../lib/utils.ts";
import {
  buildReEnterPrompt,
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
  const archivedHidden = showArchived
    ? 0
    : tasks.filter((t) => t.archivedAt !== null).length;

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
    <main className="max-w-[960px] mx-auto px-6 py-10">
      <AppHeader />
      <TaskList
        tasks={displayedTasks}
        onArchive={handleArchive}
        onUnarchive={handleUnarchive}
        home={home}
        hiddenArchivedCount={archivedHidden}
      />
    </main>
  );
}

export function TaskList({
  tasks,
  onArchive,
  onUnarchive,
  home = "",
  hiddenArchivedCount = 0,
}: {
  tasks: TaskSummary[];
  onArchive?: (task: TaskSummary) => void | Promise<void>;
  onUnarchive?: (task: TaskSummary) => void | Promise<void>;
  home?: string;
  hiddenArchivedCount?: number;
}) {
  const sorted = [...tasks].sort(byActivityDesc);

  const subtitleParts = [`${tasks.length} tasks`];
  if (hiddenArchivedCount > 0) {
    subtitleParts.push(`${hiddenArchivedCount} archived hidden`);
  }
  const subtitle = subtitleParts.join(" · ");

  if (sorted.length === 0) {
    return (
      <div>
        <p className="text-text-muted text-sm mt-4">{subtitle}</p>
        <p className="text-text-muted mt-4">No tasks in this view.</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-text-muted text-sm mb-3">{subtitle}</p>
      <ul className="m-0 p-0">
        {sorted.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
          />
        ))}
      </ul>
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
  const projectName = projectDisplayName(task.projectRoot || "Unknown");
  const archiveLabel = `Archive ${untitled ? "untitled task" : task.title}`;
  const unarchiveLabel = `Unarchive ${untitled ? "untitled task" : task.title}`;

  return (
    <li
      className={cn(
        "task-row flex items-start gap-3 py-2 border-b border-border-subtle relative",
        archived && "task-row-archived opacity-60",
      )}
    >
      {/* Left: title row + description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to={`/task/${task.slug}`}
            className="no-underline text-inherit hover:text-accent min-w-0"
          >
            <span
              className={cn(
                "task-row-title block text-base font-medium overflow-hidden whitespace-nowrap text-ellipsis",
                untitled && "task-row-untitled text-text-muted font-normal italic",
              )}
            >
              {untitled ? "Untitled task" : task.title}
            </span>
          </Link>
          <span className="task-row-project flex-shrink-0 text-xs font-mono px-1.5 py-0.5 rounded-sm bg-chip-bg text-chip-text border border-chip-border">
            {projectName}
          </span>
          {archived && (
            <span className="archived-badge flex-shrink-0 text-xs font-mono px-1.5 py-0.5 rounded-sm bg-chip-bg text-text-muted border border-chip-border">
              Archived
            </span>
          )}
        </div>
        {!untitled && task.description ? (
          <span className="task-row-description block text-xs text-text-muted line-clamp-2 max-w-[55ch] leading-snug mt-0.5">
            {task.description}
          </span>
        ) : null}
      </div>

      {/* Right: agent avatars + docs icon + token count + time */}
      <div className="task-row-meta flex items-center gap-2 flex-shrink-0">
        <AgentAvatars agentTools={task.agentTools} />
        {task.hasDocs && <DocsIndicator />}
        <span
          className="task-row-tokens flex-shrink-0 min-w-[4.5rem] text-text-muted font-mono text-sm tabular-nums text-right"
          title={formatTokenBreakdown(task.tokenTotals)}
        >
          {formatTokensCompact(freshTokenTotal(task.tokenTotals))}
        </span>
        <span className="task-row-time flex-shrink-0 min-w-[6rem] text-text-muted text-sm tabular-nums text-right">
          {formatRelativeTime(task.lastActivityAt)}
        </span>
      </div>

      {/* Row actions (visible on hover — hover-swap implemented in task-list-row-actions slice) */}
      <div className="task-row-actions absolute top-1/2 right-0 -translate-y-1/2 inline-flex items-center gap-1 opacity-0 focus-within:opacity-100 pointer-events-none">
        <CopyPromptAction title={task.title} slug={task.slug} />
        {archived && onUnarchive ? (
          <button
            type="button"
            className="task-row-action inline-flex items-center justify-center w-7 h-7 p-0 border-none rounded-sm bg-transparent text-text-muted cursor-pointer hover:bg-surface hover:text-accent pointer-events-auto"
            aria-label={unarchiveLabel}
            title={unarchiveLabel}
            onClick={() => void onUnarchive(task)}
          >
            <UnarchiveIcon />
          </button>
        ) : onArchive ? (
          <button
            type="button"
            className="task-row-action inline-flex items-center justify-center w-7 h-7 p-0 border-none rounded-sm bg-transparent text-text-muted cursor-pointer hover:bg-surface hover:text-accent pointer-events-auto"
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

function AgentAvatars({ agentTools }: { agentTools: SessionTool[] }) {
  if (agentTools.length === 0) return null;
  return (
    <div className="flex -space-x-1.5">
      {agentTools.includes("claude") && (
        <span
          className="agent-avatar agent-avatar-claude inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold text-white border-2 border-bg"
          style={{ backgroundColor: "var(--color-tag-claude)" }}
          aria-label="Claude"
          title="Claude"
        >
          C
        </span>
      )}
      {agentTools.includes("codex") && (
        <span
          className="agent-avatar agent-avatar-codex inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold border-2 border-bg"
          style={{
            color: "var(--color-tag-codex)",
            backgroundColor: "var(--color-tag-codex-bg)",
            borderColor: "var(--color-tag-codex)",
          }}
          aria-label="Codex"
          title="Codex"
        >
          X
        </span>
      )}
    </div>
  );
}

function DocsIndicator() {
  return (
    <span
      className="docs-indicator inline-flex items-center justify-center w-4 h-4 text-tag-doc"
      aria-label="Has docs"
      title="Has docs"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    </span>
  );
}

function CopyPromptAction({ title, slug }: { title: string; slug: string }) {
  const { copied, copy } = useClipboardCopy();
  const prompt = buildReEnterPrompt(title, slug);
  return (
    <button
      type="button"
      className="task-row-action inline-flex items-center justify-center w-7 h-7 p-0 border-none rounded-sm bg-transparent text-text-muted cursor-pointer hover:bg-surface hover:text-accent pointer-events-auto"
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
