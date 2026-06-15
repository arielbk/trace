import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { freshTokenTotal, type TaskSummary } from "@trace/core";
import type { SessionTool } from "@trace/core";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "cmdk";
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

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

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

  const visibleByArchive = visibleTasks(tasks, { showArchived });
  const displayedTasks = filterByProject(visibleByArchive, selectedProject);
  const archivedHidden = showArchived
    ? 0
    : filterByProject(tasks, selectedProject).filter((t) => t.archivedAt !== null).length;

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
      <FilterBar
        projects={getProjectCounts(tasks)}
        selectedProject={selectedProject}
        onProjectChange={setSelectedProject}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
      />
      <TaskList
        tasks={displayedTasks}
        onArchive={handleArchive}
        onUnarchive={handleUnarchive}
        hiddenArchivedCount={archivedHidden}
      />
    </main>
  );
}

export function TaskList({
  tasks,
  onArchive,
  onUnarchive,
  hiddenArchivedCount = 0,
}: {
  tasks: TaskSummary[];
  onArchive?: (task: TaskSummary) => void | Promise<void>;
  onUnarchive?: (task: TaskSummary) => void | Promise<void>;
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
  const [isHovered, setIsHovered] = useState(false);
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
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
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
      <div className={cn("task-row-meta flex items-center gap-2 flex-shrink-0", isHovered && "opacity-0 pointer-events-none")}>
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

      {/* Row actions (visible on hover) */}
      <div className={cn(
        "task-row-actions absolute top-1/2 right-0 -translate-y-1/2 inline-flex items-center gap-1",
        isHovered ? "opacity-100 pointer-events-auto" : "opacity-0 focus-within:opacity-100 pointer-events-none",
      )}>
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
      aria-label={copied ? "Copied" : "Copy re-enter prompt"}
      title={prompt}
      onClick={() => void copy(prompt)}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function ChevronDownIcon() {
  return (
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
      <polyline points="6 9 12 15 18 9" />
    </svg>
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

export function filterByProject(
  tasks: TaskSummary[],
  projectRoot: string | null,
): TaskSummary[] {
  if (!projectRoot) return tasks;
  return tasks.filter((t) => t.projectRoot === projectRoot);
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

export function FilterBar({
  projects,
  selectedProject,
  onProjectChange,
  showArchived,
  onShowArchivedChange,
}: {
  projects: ProjectCount[];
  selectedProject: string | null;
  onProjectChange: (project: string | null) => void;
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedLabel = selectedProject
    ? (projects.find((p) => p.projectRoot === selectedProject)?.displayName ??
      selectedProject)
    : "All projects";

  return (
    <div className="flex items-center gap-4 mb-4">
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Trigger
          className="filter-bar-project-trigger inline-flex items-center gap-1.5 h-8 px-3 text-sm rounded-md border border-border-subtle bg-surface text-text-muted hover:bg-chip-bg"
          aria-label={`Project filter: ${selectedLabel}`}
        >
          {selectedLabel}
          <ChevronDownIcon />
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            className="filter-bar-project-popover z-50 w-56 rounded-md border border-border-subtle bg-surface shadow-md p-1"
            align="start"
            sideOffset={4}
          >
            <Command>
              <CommandInput
                className="w-full h-8 px-2 text-sm bg-transparent border-none outline-none placeholder:text-text-muted"
                placeholder="Search projects..."
              />
              <CommandList className="max-h-48 overflow-y-auto">
                <CommandEmpty className="py-2 text-sm text-center text-text-muted">
                  No projects found.
                </CommandEmpty>
                <CommandItem
                  value="__all__"
                  className="filter-bar-all-projects flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer aria-selected:bg-chip-bg"
                  onSelect={() => {
                    onProjectChange(null);
                    setOpen(false);
                  }}
                >
                  <span className="flex-1">All projects</span>
                  {selectedProject === null && <CheckIcon />}
                </CommandItem>
                {projects.map((project) => (
                  <CommandItem
                    key={project.projectRoot}
                    value={project.displayName}
                    className="filter-bar-project-item flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer aria-selected:bg-chip-bg"
                    onSelect={() => {
                      onProjectChange(project.projectRoot);
                      setOpen(false);
                    }}
                  >
                    <span className="flex-1">{project.displayName}</span>
                    <span className="text-text-muted tabular-nums">
                      {project.count}
                    </span>
                    {selectedProject === project.projectRoot && <CheckIcon />}
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>

      <div className="flex items-center gap-2">
        <SwitchPrimitive.Root
          id="show-archived-switch"
          checked={showArchived}
          onCheckedChange={onShowArchivedChange}
          className="filter-bar-archived-switch relative inline-flex h-5 w-9 items-center rounded-full border-2 border-transparent bg-chip-bg data-[state=checked]:bg-accent"
        >
          <SwitchPrimitive.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-white shadow data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
        </SwitchPrimitive.Root>
        <label
          htmlFor="show-archived-switch"
          className="text-sm text-text-muted cursor-pointer select-none"
        >
          Show archived
        </label>
      </div>
    </div>
  );
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
