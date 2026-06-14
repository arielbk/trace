import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { freshTokenTotal, type TaskSummary } from "@trace/core/browser";
import type { SessionTool } from "@trace/core/browser";
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
import { ReEnterButton } from "../components/ReEnterButton.tsx";
import {
  ArchiveIcon,
  CheckIcon,
  SuccessCheckIcon,
  UnarchiveIcon,
} from "../components/icons.tsx";
import { cn } from "../lib/utils.ts";
import {
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
const ARCHIVE_SETTLE_MS = 2200;
const ARCHIVE_EXIT_MS = 350;
const ARCHIVE_SUCCESS_HOLD_MS = ARCHIVE_SETTLE_MS - ARCHIVE_EXIT_MS;

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
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedProject = searchParams.get("project");

  function setSelectedProject(project: string | null) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (project) {
          next.set("project", project);
        } else {
          next.delete("project");
        }
        return next;
      },
      { replace: true },
    );
  }

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
  const crumb = selectedProject
    ? projectDisplayName(selectedProject)
    : "all projects";
  const subtitle = buildSubtitle(displayedTasks.length, archivedHidden);

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
    <main className="max-w-app mx-auto px-5 pb-16">
      <AppHeader project={crumb} bordered={false} />
      <div className="pt-7 pb-header-y">
        <h1 className="m-0 text-page-title font-extrabold">
          Tasks
        </h1>
        <p className="mt-subtitle-top mb-0 text-text-muted text-caption">
          {subtitle}
        </p>
      </div>
      <FilterBar
        projects={getProjectCounts(tasks)}
        selectedProject={selectedProject}
        onProjectChange={setSelectedProject}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
        triggerCount={displayedTasks.length}
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

  // Subtitle moved to the page title section; retain the prop so callers and
  // tests that pass hiddenArchivedCount keep working.
  void hiddenArchivedCount;

  if (sorted.length === 0) {
    return (
      <p className="my-10 text-center text-text-muted text-sm">
        No tasks in this view.
      </p>
    );
  }

  return (
    <ul className="flex flex-col pt-1 m-0 p-0 list-none">
      {sorted.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
        />
      ))}
    </ul>
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
  const [archivePhase, setArchivePhase] = useState<
    "idle" | "success" | "removing"
  >("idle");
  const archiveExitTimer = useRef<number | null>(null);
  const archiveCommitTimer = useRef<number | null>(null);
  const untitled = isUntitled(task.title);
  const archived = task.archivedAt !== null;
  const projectName = projectDisplayName(task.projectRoot || "Unknown");
  const archiveLabel = `Archive ${untitled ? "untitled task" : task.title}`;
  const unarchiveLabel = `Unarchive ${untitled ? "untitled task" : task.title}`;

  useEffect(() => {
    return () => {
      if (archiveExitTimer.current !== null) {
        window.clearTimeout(archiveExitTimer.current);
      }
      if (archiveCommitTimer.current !== null) {
        window.clearTimeout(archiveCommitTimer.current);
      }
    };
  }, []);

  function clearArchiveTimers() {
    if (archiveExitTimer.current !== null) {
      window.clearTimeout(archiveExitTimer.current);
      archiveExitTimer.current = null;
    }
    if (archiveCommitTimer.current !== null) {
      window.clearTimeout(archiveCommitTimer.current);
      archiveCommitTimer.current = null;
    }
  }

  function cancelPendingArchive() {
    clearArchiveTimers();
    setArchivePhase("idle");
  }

  function handleArchiveClick() {
    if (archivePhase !== "idle") {
      cancelPendingArchive();
      return;
    }
    if (!onArchive) return;

    setArchivePhase("success");
    archiveExitTimer.current = window.setTimeout(() => {
      archiveExitTimer.current = null;
      setArchivePhase("removing");
    }, ARCHIVE_SUCCESS_HOLD_MS);
    archiveCommitTimer.current = window.setTimeout(() => {
      archiveCommitTimer.current = null;
      void Promise.resolve(onArchive(task)).catch(() => setArchivePhase("idle"));
    }, ARCHIVE_SETTLE_MS);
  }

  return (
    <li
      className={cn(
        "task-row flex items-center gap-row-gap px-3 -mx-3 py-row-y relative hover:bg-surface overflow-hidden max-h-32 transition-all duration-350",
        archived && "task-row-archived opacity-60",
        archivePhase === "removing" &&
          "opacity-0 max-h-0 py-0 -translate-y-1 pointer-events-none",
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Left: title row + description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-chip-gap flex-wrap">
          <Link
            to={`/task/${task.slug}`}
            className="no-underline text-inherit hover:text-accent min-w-0"
          >
            <span
              className={cn(
                "task-row-title block text-row-title font-semibold overflow-hidden whitespace-nowrap text-ellipsis",
                archived ? "text-text-muted" : "text-text",
                untitled && "task-row-untitled text-text-muted font-normal italic",
              )}
            >
              {untitled ? "Untitled task" : task.title}
            </span>
          </Link>
          <span className="task-row-project flex-shrink-0 font-mono text-chip px-1.5 py-px rounded bg-chip-bg text-chip-text border border-border whitespace-nowrap">
            {projectName}
          </span>
          {archived && (
            <span className="archived-badge flex-shrink-0 font-mono text-badge font-bold uppercase px-1.5 py-px rounded text-text-muted border border-border whitespace-nowrap">
              Archived
            </span>
          )}
        </div>
        {!untitled && task.description ? (
          <p className="task-row-description mt-1.5 mb-0 text-text-muted text-caption leading-normal line-clamp-2 max-w-row-description">
            {task.description}
          </p>
        ) : null}
      </div>

      {/* Right: agent avatars + docs icon + token count + time */}
      <div
        className={cn(
          "task-row-meta t-text-swap flex w-row-meta flex-shrink-0 flex-col items-end gap-1",
          (isHovered || archivePhase !== "idle") &&
            "is-exit opacity-0 pointer-events-none",
        )}
      >
        <div className="flex w-full items-center justify-end gap-3 min-w-0">
          <AgentAvatars agentTools={task.agentTools} hasDocs={task.hasDocs} />
          <span
            className="font-mono text-meta text-text-muted tabular-nums whitespace-nowrap"
            title={formatTokenBreakdown(task.tokenTotals)}
          >
            {formatTokensCompact(freshTokenTotal(task.tokenTotals))}
          </span>
        </div>
        <span className="block w-full font-mono text-row-time text-text whitespace-nowrap text-right">
          {formatRelativeTime(task.lastActivityAt)}
        </span>
      </div>

      {/* Row actions (visible on hover) */}
      <div
        className={cn(
          "task-row-actions t-text-swap absolute top-1/2 right-3 -translate-y-1/2 inline-flex items-center gap-2",
          isHovered || archivePhase !== "idle"
            ? "opacity-100 pointer-events-auto"
            : "is-exit opacity-0 focus-within:opacity-100 pointer-events-none",
        )}
      >
        <ReEnterButton
          title={task.title}
          slug={task.slug}
          className="task-row-action pointer-events-auto"
        />
        {archived && onUnarchive ? (
          <button
            type="button"
            className="task-row-action inline-flex items-center justify-center size-row-action p-0 rounded-lg border border-border bg-surface text-text-muted cursor-pointer hover:text-accent hover:border-border-strong pointer-events-auto"
            aria-label={unarchiveLabel}
            onClick={() => void onUnarchive(task)}
          >
            <UnarchiveIcon />
          </button>
        ) : onArchive ? (
          <button
            type="button"
            className={cn(
              "task-row-action inline-flex items-center justify-center size-row-action p-0 rounded-lg border border-border bg-surface text-text-muted cursor-pointer hover:text-accent hover:border-border-strong pointer-events-auto transition-colors",
              archivePhase !== "idle" &&
                "text-accent border-border-strong bg-accent-soft",
            )}
            aria-label={
              archivePhase !== "idle" ? unarchiveLabel : archiveLabel
            }
            onClick={handleArchiveClick}
          >
            <span
              className="t-icon-swap inline-grid size-4 place-items-center"
              data-state={archivePhase !== "idle" ? "b" : "a"}
              aria-hidden="true"
            >
              <span className="t-icon inline-flex" data-icon="a">
                <ArchiveIcon />
              </span>
              <span className="t-icon inline-flex" data-icon="b">
                <SuccessCheckIcon shown={archivePhase !== "idle"} />
              </span>
            </span>
          </button>
        ) : null}
      </div>
    </li>
  );
}

function AgentAvatars({
  agentTools,
  hasDocs,
}: {
  agentTools: SessionTool[];
  hasDocs: boolean;
}) {
  const hasClaude = agentTools.includes("claude");
  const hasCodex = agentTools.includes("codex");
  if (!hasClaude && !hasCodex && !hasDocs) return null;

  const baseAvatar =
    "inline-flex items-center justify-center w-5 h-5 rounded-full -ml-1.5 relative";

  return (
    <span className="inline-flex items-center pl-1.5">
      {hasClaude && (
        <span
          className={cn("agent-avatar agent-avatar-claude z-30", baseAvatar)}
          style={{
            background:
              "color-mix(in srgb, var(--color-tag-claude) 15%, var(--color-surface))",
            border:
              "1px solid color-mix(in srgb, var(--color-tag-claude) 30%, var(--color-border))",
            boxShadow: "0 0 0 2px var(--color-bg)",
            color: "var(--color-tag-claude)",
          }}
          aria-label="Claude"
          title="Claude"
        >
          <ClaudeLogo />
        </span>
      )}
      {hasCodex && (
        <span
          className={cn("agent-avatar agent-avatar-codex z-20", baseAvatar)}
          style={{
            background: "var(--color-tag-codex-bg)",
            border:
              "1px solid color-mix(in srgb, var(--color-tag-codex) 30%, var(--color-border))",
            boxShadow: "0 0 0 2px var(--color-bg)",
            color: "var(--color-tag-codex)",
          }}
          aria-label="Codex"
          title="Codex"
        >
          <CodexLogo />
        </span>
      )}
      {hasDocs && (
        <span
          className={cn(
            "docs-indicator z-10 bg-chip-bg border border-border text-text-muted",
            baseAvatar,
          )}
          style={{ boxShadow: "0 0 0 2px var(--color-bg)" }}
          aria-label="Documents"
          title="Documents"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
        </span>
      )}
    </span>
  );
}

function ClaudeLogo() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
        fill="currentColor"
      />
    </svg>
  );
}

function CodexLogo() {
  return (
    <svg width="11" height="11" viewBox="2.75 2.75 18.5 18.5" aria-hidden="true">
      <path
        d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
        fill="url(#codex-avatar-gradient)"
      />
      <defs>
        <linearGradient
          id="codex-avatar-gradient"
          x1="12"
          x2="12"
          y1="3"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#b1a7ff" />
          <stop offset=".5" stopColor="#7a9dff" />
          <stop offset="1" stopColor="#3941ff" />
        </linearGradient>
      </defs>
    </svg>
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

function FolderIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-text-muted)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
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
  triggerCount,
}: {
  projects: ProjectCount[];
  selectedProject: string | null;
  onProjectChange: (project: string | null) => void;
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
  triggerCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const [dropdownVisible, setDropdownVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const openFrame = useRef<number | null>(null);
  const selectedLabel = selectedProject
    ? (projects.find((p) => p.projectRoot === selectedProject)?.displayName ??
      selectedProject)
    : "All projects";

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
      }
      if (openFrame.current !== null) {
        window.cancelAnimationFrame(openFrame.current);
      }
    };
  }, []);

  function clearCloseTimer() {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function clearOpenFrame() {
    if (openFrame.current !== null) {
      window.cancelAnimationFrame(openFrame.current);
      openFrame.current = null;
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      clearCloseTimer();
      clearOpenFrame();
      setIsClosing(false);
      setOpen(true);
      setDropdownVisible(false);
      openFrame.current = window.requestAnimationFrame(() => {
        openFrame.current = null;
        setDropdownVisible(true);
      });
      return;
    }

    if (!open) return;
    clearOpenFrame();

    const closeMs =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--dropdown-close-dur",
        ),
      ) || 150;

    setDropdownVisible(false);
    setIsClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setIsClosing(false);
      setDropdownVisible(false);
      setOpen(false);
    }, closeMs);
  }

  return (
    <div className="flex items-center gap-3 flex-wrap pb-3">
      <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
        <PopoverPrimitive.Trigger
          className="filter-bar-project-trigger inline-flex items-center gap-2 pl-3 pr-control-x py-filter-y rounded-control border border-border bg-surface text-text text-caption font-semibold cursor-pointer hover:bg-chip-bg"
          aria-label={`Project filter: ${selectedLabel}`}
        >
          <FolderIcon />
          <span>{selectedLabel}</span>
          {typeof triggerCount === "number" && (
            <span className="font-mono text-meta text-text-muted tabular-nums">
              {triggerCount}
            </span>
          )}
          <ChevronDownIcon />
        </PopoverPrimitive.Trigger>
        {(open || isClosing) && (
          <PopoverPrimitive.Portal forceMount>
            <PopoverPrimitive.Content
              forceMount
              className={cn(
                "filter-bar-project-popover t-dropdown z-50 w-56 rounded-md border border-border-subtle bg-surface shadow-md p-1",
                dropdownVisible && !isClosing && "is-open",
                isClosing && "is-closing",
              )}
              data-origin="top-left"
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
                    className={cn(
                      "filter-bar-all-projects flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer aria-selected:bg-chip-bg",
                      selectedProject === null && "bg-accent-soft text-accent",
                    )}
                    onSelect={() => {
                      onProjectChange(null);
                      handleOpenChange(false);
                    }}
                  >
                    <span className="flex-1">All projects</span>
                    {selectedProject === null && <CheckIcon />}
                  </CommandItem>
                  {projects.map((project) => (
                    <CommandItem
                      key={project.projectRoot}
                      value={project.displayName}
                      className={cn(
                        "filter-bar-project-item flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer aria-selected:bg-chip-bg",
                        selectedProject === project.projectRoot &&
                          "bg-accent-soft text-accent",
                      )}
                      onSelect={() => {
                        onProjectChange(project.projectRoot);
                        handleOpenChange(false);
                      }}
                    >
                      <span className="flex-1">{project.displayName}</span>
                      <span
                        className={cn(
                          "tabular-nums",
                          selectedProject === project.projectRoot
                            ? "text-accent"
                            : "text-text-muted",
                        )}
                      >
                        {project.count}
                      </span>
                      {selectedProject === project.projectRoot && <CheckIcon />}
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        )}
      </PopoverPrimitive.Root>

      <label
        htmlFor="show-archived-switch"
        className="ml-auto inline-flex items-center gap-chip-gap text-text-muted text-crumb font-medium cursor-pointer select-none"
      >
        <SwitchPrimitive.Root
          id="show-archived-switch"
          checked={showArchived}
          onCheckedChange={onShowArchivedChange}
          className="filter-bar-archived-switch relative inline-flex h-5 w-switch shrink-0 items-center rounded-full border border-border bg-chip-bg px-0.5 data-[state=checked]:border-transparent data-[state=checked]:bg-accent"
        >
          <SwitchPrimitive.Thumb className="pointer-events-none block h-3.5 w-3.5 rounded-full bg-text-muted transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-white data-[state=unchecked]:translate-x-0" />
        </SwitchPrimitive.Root>
        Show archived
      </label>
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
