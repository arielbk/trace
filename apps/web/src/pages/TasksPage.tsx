import { useEffect, useRef, useState } from "react";
import {
  useArchiveTask,
  usePinTask,
  useTasks,
  useUnarchiveTask,
  useUnpinTask,
} from "../lib/api.ts";
import { useSearchParams } from "react-router-dom";
import type { TaskSummary } from "@trace/core/browser";
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
import { TaskRow } from "../components/TaskRow.tsx";
import { CheckIcon } from "../components/icons.tsx";
import {
  SkeletonReveal,
  useSkeletonReveal,
} from "../components/SkeletonReveal.tsx";
import { cn } from "../lib/utils.ts";
import {
  buildSubtitle,
  filterByProject,
  getProjectCounts,
  partitionPinned,
  projectDisplayName,
  type ProjectCount,
  visibleTasks,
} from "../lib/task-list.ts";

export function TasksPage() {
  const tasksQuery = useTasks();
  const archiveMutation = useArchiveTask();
  const unarchiveMutation = useUnarchiveTask();
  const pinMutation = usePinTask();
  const unpinMutation = useUnpinTask();
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

  const reveal = useSkeletonReveal(!tasksQuery.isPending);
  const tasks = tasksQuery.data ?? [];

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
    await archiveMutation.mutateAsync(task.slug);
  }
  async function handleUnarchive(task: TaskSummary): Promise<void> {
    await unarchiveMutation.mutateAsync(task.slug);
  }
  async function handlePin(task: TaskSummary): Promise<void> {
    await pinMutation.mutateAsync(task.slug);
  }
  async function handleUnpin(task: TaskSummary): Promise<void> {
    await unpinMutation.mutateAsync(task.slug);
  }

  return (
    <main className="max-w-app mx-auto px-5 pb-16">
      <AppHeader project={crumb} bordered={false} />
      <div className="pt-7 pb-header-y">
        <h1 className="m-0 text-page-title font-extrabold">
          Tasks
        </h1>
        {reveal.showContent ? (
          <p className="mt-subtitle-top mb-0 text-text-muted text-caption">
            {subtitle}
          </p>
        ) : (
          <span
            className="t-skel-bar mt-subtitle-top block h-3.5 w-44"
            aria-hidden="true"
          />
        )}
      </div>
      {reveal.showContent ? (
        <FilterBar
          projects={getProjectCounts(tasks)}
          selectedProject={selectedProject}
          onProjectChange={setSelectedProject}
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
          triggerCount={displayedTasks.length}
        />
      ) : (
        <div
          className="flex items-center gap-3 flex-wrap pb-3"
          aria-hidden="true"
        >
          <span className="t-skel-bar h-8 w-32 rounded-control" />
          <span className="t-skel-bar h-5 w-28 rounded-full ml-auto" />
        </div>
      )}
      <SkeletonReveal state={reveal} skeleton={<TaskListSkeleton />}>
        <TaskList
          tasks={displayedTasks}
          onArchive={handleArchive}
          onUnarchive={handleUnarchive}
          onPin={handlePin}
          onUnpin={handleUnpin}
          hiddenArchivedCount={archivedHidden}
        />
      </SkeletonReveal>
    </main>
  );
}

function TaskListSkeleton() {
  return (
    <ul className="flex flex-col pt-1 m-0 p-0 list-none">
      {Array.from({ length: 6 }, (_, i) => (
        <li
          key={i}
          className="task-row-skeleton flex items-center gap-row-gap px-3 -mx-3 py-row-y"
        >
          <div className="flex-1 min-w-0 flex flex-col gap-1.5">
            <span className="t-skel-bar h-4 w-56 max-w-full" />
            <span className="t-skel-bar h-3 w-32" />
          </div>
          <div className="flex w-row-meta flex-shrink-0 flex-col items-end gap-1.5">
            <span className="t-skel-bar h-3 w-16" />
            <span className="t-skel-bar h-3 w-12" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function TaskList({
  tasks,
  onArchive,
  onUnarchive,
  onPin,
  onUnpin,
  hiddenArchivedCount = 0,
}: {
  tasks: TaskSummary[];
  onArchive?: (task: TaskSummary) => void | Promise<void>;
  onUnarchive?: (task: TaskSummary) => void | Promise<void>;
  onPin?: (task: TaskSummary) => void | Promise<void>;
  onUnpin?: (task: TaskSummary) => void | Promise<void>;
  hiddenArchivedCount?: number;
}) {
  const { pinned, rest } = partitionPinned(tasks);

  // Subtitle moved to the page title section; retain the prop so callers and
  // tests that pass hiddenArchivedCount keep working.
  void hiddenArchivedCount;

  if (tasks.length === 0) {
    return (
      <p className="my-10 text-center text-text-muted text-sm">
        No tasks in this view.
      </p>
    );
  }

  function renderRows(rows: TaskSummary[]) {
    return rows.map((task) => (
      <TaskRow
        key={task.id}
        task={task}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
        onPin={onPin}
        onUnpin={onUnpin}
      />
    ));
  }

  if (pinned.length === 0) {
    return (
      <ul className="flex flex-col pt-1 m-0 p-0 list-none">
        {renderRows(rest)}
      </ul>
    );
  }

  return (
    <>
      <section className="task-list-pinned">
        <h2 className="task-list-pinned-heading mt-4 mb-0 text-xs font-bold uppercase tracking-widest text-accent">
          Pinned
        </h2>
        <ul className="flex flex-col mt-2 mx-0 mb-0 p-0 list-none">
          {renderRows(pinned)}
        </ul>
      </section>
      {rest.length > 0 && (
        <section className="task-list-rest">
          <h2 className="task-list-rest-heading mt-5 mb-0 text-xs font-bold uppercase tracking-widest text-accent">
            Recent
          </h2>
          <ul className="flex flex-col mt-2 mx-0 mb-0 p-0 list-none">
            {renderRows(rest)}
          </ul>
        </section>
      )}
    </>
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
  const [isClosing, setIsClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const selectedLabel = selectedProject
    ? (projects.find((p) => p.projectRoot === selectedProject)?.displayName ??
      selectedProject)
    : "All projects";

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
      }
    };
  }, []);

  function clearCloseTimer() {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  // Opening needs no orchestration: the content mounts straight into the
  // t-dropdown open state and the CSS @starting-style block animates it in.
  // Closing swaps to .is-closing and keeps the content mounted until the
  // close transition has run.
  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      clearCloseTimer();
      setIsClosing(false);
      setOpen(true);
      return;
    }

    if (!open) return;

    const closeMs =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--dropdown-close-dur",
        ),
      ) || 150;

    setIsClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setIsClosing(false);
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


