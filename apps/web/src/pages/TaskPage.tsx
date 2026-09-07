import { useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { TriangleAlert } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import type { ParsedStateMd } from "@trace/core";
import {
  costFromSessions,
  freshTokenTotal,
  resumeCommand,
  type LastWorkedOn,
  type SessionTool,
  type StateAuthor,
  type TaskTimeline,
  type TaskTimelineItem,
  type TokenTotals,
} from "@trace/core/browser";
import { AppHeader } from "../components/AppHeader.tsx";
import { CopyChip } from "../components/CopyChip.tsx";
import { CopyPromptButton } from "../components/CopyPromptButton.tsx";
import { DocViewerSheet } from "../components/DocViewerSheet.tsx";
import { ReEnterButton } from "../components/ReEnterButton.tsx";
import { useClipboardCopy } from "../components/useClipboardCopy.ts";
import { TaskActionsMenu } from "../components/TaskActionsMenu.tsx";
import { LocalConnectionBadge } from "../components/LocalTraceConnection.tsx";
import cursorIconDarkUrl from "../assets/cursor-icon-dark.png";
import cursorIconLightUrl from "../assets/cursor-icon-light.png";
import {
  SkeletonReveal,
  useSkeletonReveal,
} from "../components/SkeletonReveal.tsx";
import { cn } from "../lib/utils.ts";
import {
  formatBytes,
  formatContextUsage,
  formatModelName,
  formatRelativeTime,
  formatTokenBreakdown,
  formatTokensCompact,
  formatUsd,
  resolveDocDisplayTitle,
  truncatePath,
} from "../format.ts";
import {
  HttpError,
  useArchiveTask,
  useTaskTimeline,
  useUnarchiveTask,
} from "../lib/api.ts";
import { resolveTaskDocLink } from "../lib/doc-link-resolver.ts";
import { useTraceDataSource } from "../lib/trace-data-source.ts";

export function TaskPage() {
  const { id = "", "*": routeDocPath } = useParams();
  const navigate = useNavigate();
  const query = useTaskTimeline(id);
  const archiveMutation = useArchiveTask();
  const unarchiveMutation = useUnarchiveTask();

  const reveal = useSkeletonReveal(!query.isLoading);

  if (query.error instanceof HttpError && query.error.status === 404)
    return (
      <main>
        <p>Task not found.</p>
      </main>
    );

  const data = query.data;
  return (
    <SkeletonReveal state={reveal} skeleton={<TaskDetailSkeleton />}>
      {data ? (
        <TaskTimelineView
          timeline={data}
          routedDocPath={routeDocPath ?? null}
          onOpenDoc={(path) => navigate(docRoute(data.task.slug, path))}
          onNavigateDocRoute={(route) => navigate(route)}
          onCloseDoc={() =>
            navigate(`/task/${encodeURIComponent(data.task.slug)}`)
          }
          onArchive={() => archiveMutation.mutate(id)}
          onUnarchive={() => unarchiveMutation.mutate(id)}
        />
      ) : null}
    </SkeletonReveal>
  );
}

// Self-contained placeholder page (own header/back-link/heading/timeline bars,
// not the real AppHeader/Link) rendered inside SkeletonReveal's skeleton layer,
// which detaches to an absolute overlay and fades out on reveal while the real
// `TaskTimelineView` (mounted alongside once ready) drives the container's
// height — a task's timeline height varies with item count.
function TaskDetailSkeleton() {
  return (
    <main className="task-detail-skeleton max-w-app mx-auto px-5 pb-16">
      {/* AppHeader crumb row */}
      <div className="flex items-center justify-between gap-4 py-header-y">
        <span className="t-skel-bar h-4 w-40" />
        <span className="t-skel-bar h-4 w-4 rounded-full" />
      </div>
      {/* "All tasks" back link */}
      <span className="t-skel-bar h-4 w-20 mt-3" />
      {/* Title + "Last active" */}
      <div className="flex flex-col gap-2 pt-3 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
        <span className="t-skel-bar h-8 w-96 max-w-full" />
        <span className="t-skel-bar h-4 w-28 shrink-0 sm:mt-1.5" />
      </div>
      {/* Description */}
      <span className="t-skel-bar h-4 w-72 max-w-full mt-3" />
      {/* Re-enter / more-actions button row */}
      <div className="flex items-center gap-2 mt-5">
        <span className="t-skel-bar h-8 w-28 rounded-control" />
        <span className="t-skel-bar h-8 w-8 rounded-control ml-auto" />
      </div>
      {/* "Where you left off" panel */}
      <div className="mt-8 pt-6 border-t border-border flex flex-col gap-2">
        <span className="t-skel-bar h-3 w-32" />
        <span className="t-skel-bar h-4 w-80 max-w-full mt-1" />
        <span className="t-skel-bar h-4 w-64 max-w-full" />
      </div>
      {/* Token summary */}
      <div className="mt-8 pt-6 flex gap-11">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <span className="t-skel-bar h-3 w-12" />
            <span className="t-skel-bar h-7 w-16" />
          </div>
        ))}
      </div>
      {/* Activity timeline */}
      <span className="t-skel-bar h-5 w-24 mt-8" />
      <ul className="mt-4 m-0 p-0 list-none flex flex-col gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className="grid timeline-grid gap-3.5 items-start">
            <span className="t-skel-bar size-10 rounded-md" />
            <div className="flex flex-col gap-1.5 min-w-0">
              <span className="t-skel-bar h-4 w-64 max-w-full" />
              <span className="t-skel-bar h-3 w-40" />
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

function docRoute(taskRef: string, docPath: string): string {
  return `/task/${encodeURIComponent(taskRef)}/docs/${encodeURIComponent(docPath)}`;
}

type SessionTimelineItem = Extract<TaskTimelineItem, { type: "session" }>;

type TimelineRoot =
  | { kind: "doc"; item: Extract<TaskTimelineItem, { type: "doc" }> }
  | {
      kind: "session";
      item: SessionTimelineItem;
      children: SessionTimelineItem[];
    };

// Group every descendant session (subagents + spawned sessions, depth-first)
// under the root session that launched them, so a root's whole fan collapses
// behind one disclosure. Docs and orphaned children (parent not in view) stay
// at the top level.
function buildTimelineTree(items: TaskTimelineItem[]): TimelineRoot[] {
  const visibleSessionIds = new Set(
    items
      .filter((item) => item.type === "session")
      .map((item) => item.session.id),
  );
  const childrenByParent = new Map<string, SessionTimelineItem[]>();

  for (const item of items) {
    if (item.type !== "session") continue;
    const parentId = item.session.parentSessionId;
    if (!parentId || !visibleSessionIds.has(parentId)) continue;

    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(item);
    childrenByParent.set(parentId, siblings);
  }

  function descendants(sessionId: string): SessionTimelineItem[] {
    const out: SessionTimelineItem[] = [];
    for (const child of childrenByParent.get(sessionId) ?? []) {
      out.push(child);
      out.push(...descendants(child.session.id));
    }
    return out;
  }

  const roots: TimelineRoot[] = [];
  for (const item of items) {
    if (item.type === "doc") {
      roots.push({ kind: "doc", item });
      continue;
    }

    const parentId = item.session.parentSessionId;
    if (parentId && visibleSessionIds.has(parentId)) continue;

    roots.push({
      kind: "session",
      item,
      children: descendants(item.session.id),
    });
  }

  return roots;
}

// "3 subagents · 412.0K tokens" — the disclosure header summarising a root's
// fan. The count segment reports subagents only (falling back to the total
// session count when the fan has none), while the token total sums fresh spend
// across EVERY child — subagents and spawned alike — so the figure stays correct
// once spawned attribution lands.
function fanOutLabel(children: SessionTimelineItem[]): string {
  const subagents = children.filter(
    (c) => c.session.origin === "subagent",
  ).length;
  const countSegment =
    subagents > 0
      ? `${subagents} subagent${subagents > 1 ? "s" : ""}`
      : `${children.length} session${children.length > 1 ? "s" : ""}`;
  const tokenTotal = children.reduce(
    (sum, c) => sum + freshTokenTotal(c.session.tokenTotals),
    0,
  );
  return `${countSegment} · ${formatTokensCompact(tokenTotal)} tokens`;
}

function sessionOriginBadge(
  session: Extract<TaskTimelineItem, { type: "session" }>["session"],
): string | null {
  if (session.origin === "subagent") {
    return `↳ ${session.subagentType ?? "subagent"}`;
  }

  if (session.origin === "spawned") {
    return "↳ spawned session";
  }

  return null;
}

// Title for a child session that has no captured name of its own. Leading with
// the origin/type reads as a real name and avoids stacking a meaningless temp
// transcript path above the origin badge.
function sessionChildTitle(
  session: Extract<TaskTimelineItem, { type: "session" }>["session"],
): string | null {
  if (session.origin === "subagent") {
    return session.subagentType ?? "Subagent";
  }

  if (session.origin === "spawned") {
    return "Spawned session";
  }

  return null;
}

export function TaskTimelineView({
  timeline,
  now,
  archivedAt: archivedAtProp,
  routedDocPath,
  onOpenDoc,
  onNavigateDocRoute,
  onCloseDoc,
  onArchive,
  onUnarchive,
}: {
  timeline: TaskTimeline;
  now?: Date;
  archivedAt?: string | null;
  routedDocPath?: string | null;
  onOpenDoc?: (path: string) => void;
  onNavigateDocRoute?: (route: string) => void;
  onCloseDoc?: () => void;
  onArchive?: () => void | Promise<void>;
  onUnarchive?: () => void | Promise<void>;
}) {
  const source = useTraceDataSource();
  const archivedAt =
    archivedAtProp !== undefined ? archivedAtProp : timeline.task.archivedAt;
  const isArchived = archivedAt !== null;

  const [timelineFilter, setTimelineFilter] = useState<
    "all" | "session" | "doc"
  >("all");
  // Subagent fans start collapsed and are tracked by their root session id.
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );
  const [localSelectedDocPath, setLocalSelectedDocPath] = useState<
    string | null
  >(null);
  const selectedDocPath =
    routedDocPath === undefined ? localSelectedDocPath : routedDocPath;
  const docTriggerRef = useRef<HTMLElement | null>(null);

  function openDoc(trigger: HTMLElement, path: string) {
    docTriggerRef.current = trigger;
    if (onOpenDoc) {
      onOpenDoc(path);
      return;
    }
    setLocalSelectedDocPath(path);
  }

  function closeDoc() {
    if (onCloseDoc) {
      onCloseDoc();
      return;
    }
    setLocalSelectedDocPath(null);
  }

  const sessionCount = timeline.items.filter(
    (item) => item.type === "session",
  ).length;
  const docCount = timeline.items.filter((item) => item.type === "doc").length;
  const knownDocPaths = timeline.items.flatMap((item) =>
    item.type === "doc" ? [item.doc.path] : [],
  );

  function navigateStateDocLink(event: MouseEvent<HTMLElement>) {
    if (!onNavigateDocRoute) return;

    const route = docRouteFromStateClick(event, {
      taskRef: timeline.task.slug,
      knownDocPaths,
    });
    if (!route) return;

    event.preventDefault();
    const target = event.target;
    const anchor = target instanceof Element ? target.closest("a[href]") : null;
    if (anchor instanceof HTMLElement) {
      docTriggerRef.current = anchor;
    }
    onNavigateDocRoute(route);
  }

  const visibleItems = (
    timelineFilter === "all"
      ? timeline.items
      : timeline.items.filter((item) => item.type === timelineFilter)
  )
    .slice()
    .reverse();
  const timelineRoots = buildTimelineTree(visibleItems);

  function toggleFilter(filter: "session" | "doc") {
    setTimelineFilter((current) => (current === filter ? "all" : filter));
  }

  function toggleGroup(id: string) {
    setExpandedGroups((current) => ({ ...current, [id]: !current[id] }));
  }

  return (
    <main className="max-w-app mx-auto px-5 pb-16">
      <AppHeader
        project={timeline.task.projectSlug}
        projectHref={`/?project=${encodeURIComponent(timeline.task.projectSlug)}`}
        context={timeline.task.slug}
        bordered={false}
        aside={
          source.capabilities.account ? undefined : <LocalConnectionBadge />
        }
        showAccount={source.capabilities.account}
      />
      <div className="pt-3">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 font-mono text-crumb text-text-muted no-underline hover:text-accent"
        >
          <BackArrowIcon />
          All tasks
        </Link>
      </div>
      <div className="pt-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
          <h1 className="m-0 min-w-0 text-page-title font-extrabold tracking-tight leading-tight text-balance">
            {timeline.task.title}
          </h1>
          <div className="flex items-center gap-1.5 sm:pt-2 shrink-0 font-mono text-crumb text-text-muted">
            <ClockIcon />
            <span className="whitespace-nowrap">
              Last active{" "}
              <span className="tabular-nums">
                {formatRelativeTime(timeline.lastActivityAt, now)}
              </span>
            </span>
          </div>
        </div>
        {timeline.task.description ? (
          <p
            data-testid="task-description"
            className="mt-3 mb-0 text-sm text-text-muted leading-relaxed max-w-row-description text-pretty"
          >
            {timeline.task.description}
          </p>
        ) : null}
        <div className="flex items-center gap-2 flex-wrap mt-5">
          <ReEnterButton
            title={timeline.task.title}
            slug={timeline.task.slug}
          />
          {source.capabilities.taskMutations ? (
            <TaskActionsMenu
              taskRef={timeline.task.slug}
              isArchived={isArchived}
              onArchive={onArchive}
              onUnarchive={onUnarchive}
              className="ml-auto"
            />
          ) : null}
        </div>
      </div>
      <LeftOffPanel
        state={timeline.state}
        updatedAt={timeline.stateUpdatedAt}
        lastWorkedOn={timeline.lastWorkedOn}
        stateAuthor={timeline.stateAuthor}
        stale={timeline.stateStale}
        now={now}
        onDocLinkClick={navigateStateDocLink}
      />
      <TokenSummary
        totals={timeline.tokenTotals}
        sessions={timeline.items.flatMap((item) =>
          item.type === "session" ? [item.session] : [],
        )}
      />
      <section className="mt-8">
        <div className="flex items-baseline gap-5 pb-1.5">
          <h2 className="m-0 text-row-title font-bold tracking-tight">
            Activity
          </h2>
          <span className="font-mono text-crumb whitespace-nowrap">
            <button
              type="button"
              className={cn(
                "bg-transparent border-0 p-0 font-mono text-crumb cursor-pointer hover:text-text",
                timelineFilter === "session"
                  ? "text-text font-semibold"
                  : "text-text-muted",
              )}
              aria-pressed={timelineFilter === "session"}
              onClick={() => toggleFilter("session")}
            >
              {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
            </button>
            <span className="text-text-muted"> · </span>
            <button
              type="button"
              className={cn(
                "bg-transparent border-0 p-0 font-mono text-crumb cursor-pointer hover:text-text",
                timelineFilter === "doc"
                  ? "text-text font-semibold"
                  : "text-text-muted",
              )}
              aria-pressed={timelineFilter === "doc"}
              onClick={() => toggleFilter("doc")}
            >
              {docCount} {docCount === 1 ? "doc" : "docs"}
            </button>
          </span>
        </div>
        {timeline.items.length === 0 ? (
          <p className="text-text-muted mt-5">No timeline items found.</p>
        ) : visibleItems.length === 0 ? (
          <p className="text-text-muted mt-5">
            No {timelineFilter === "session" ? "sessions" : "docs"} in this
            timeline.
          </p>
        ) : (
          <ol className="relative mt-2 list-none p-0 m-0">
            <div
              className="absolute left-5 top-8 bottom-8 w-0.5 -translate-x-1/2 bg-border-subtle"
              aria-hidden="true"
              data-testid="timeline-spine"
            />
            {timelineRoots.map((root) => {
              if (root.kind === "session") {
                const { item } = root;
                return (
                  <SessionRootRow
                    key={`session:${item.session.id}`}
                    item={item}
                    childItems={root.children}
                    expanded={!!expandedGroups[item.session.id]}
                    onToggle={() => toggleGroup(item.session.id)}
                    now={now}
                  />
                );
              }

              const { item } = root;
              return (
                <li key={`doc:${item.doc.path}`}>
                  <div
                    className="content-bleed relative grid timeline-grid gap-3.5 py-3 hover:bg-surface cursor-pointer"
                    role="button"
                    tabIndex={0}
                    aria-label={`View ${truncatePath(item.doc.path)}`}
                    onClick={(e) => openDoc(e.currentTarget, item.doc.path)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDoc(e.currentTarget, item.doc.path);
                      }
                    }}
                  >
                    <div className="relative z-10 flex justify-center">
                      <TypeIcon type="doc" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="min-w-0 text-row-title font-bold tracking-tight truncate">
                          {resolveDocDisplayTitle(item.doc)}
                        </span>
                        <span className="ml-auto font-mono text-crumb text-text-muted whitespace-nowrap">
                          {formatRelativeTime(item.createdAt, now)}
                        </span>
                      </div>
                      {item.doc.description ? (
                        <p
                          data-testid="timeline-doc-description"
                          title={item.doc.description}
                          className="mt-1 mb-0 text-sm text-text-muted leading-relaxed max-w-row-description line-clamp-1"
                        >
                          {item.doc.description}
                        </p>
                      ) : null}
                      <p className="flex flex-wrap gap-2 items-center mt-1.5 text-text-muted m-0">
                        <span
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <CopyChip
                            value={item.doc.path}
                            display={truncatePath(item.doc.path)}
                          />
                        </span>
                        {item.sizeBytes !== null ? (
                          <span className="font-mono tabular-nums">
                            {formatBytes(item.sizeBytes)}
                          </span>
                        ) : null}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
      <AnimatePresence onExitComplete={() => docTriggerRef.current?.focus()}>
        {selectedDocPath !== null ? (
          <DocViewerSheet
            key={selectedDocPath}
            taskRef={timeline.task.slug}
            docPath={selectedDocPath}
            knownDocPaths={knownDocPaths}
            triggerRef={docTriggerRef}
            onNavigateDocRoute={onNavigateDocRoute}
            onOpenChange={(open) => {
              if (!open) closeDoc();
            }}
          />
        ) : null}
      </AnimatePresence>
    </main>
  );
}

// A root session's timeline row. Hover state lives here (not lifted to the
// parent list) so each row fades its own time ↔ Resume pair independently,
// mirroring the task list's per-row meta ↔ actions swap (TaskRow.tsx) with
// the same `t-text-swap`/`is-exit` transition so the affordance reads as one
// pattern across the app.
function SessionRootRow({
  item,
  childItems,
  expanded,
  onToggle,
  now,
}: {
  item: SessionTimelineItem;
  childItems: SessionTimelineItem[];
  expanded: boolean;
  onToggle: () => void;
  now?: Date;
}) {
  const [isHovered, setIsHovered] = useState(false);
  // When a session has no name of its own, lead the row with its origin/type
  // and demote the temp transcript path into the meta line, rather than
  // stacking two pills.
  const originBadge = sessionOriginBadge(item.session);
  const childTitle = item.sessionName ? null : sessionChildTitle(item.session);
  const resumeCopyValue =
    item.session.origin === "root" ? resumeCommand(item.session) : null;
  const title = item.sessionName ?? childTitle;

  return (
    <li
      className="relative"
      data-testid="timeline-session-row"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="content-bleed relative grid timeline-grid gap-3.5 py-3 hover:bg-surface">
        <div className="relative z-10 flex justify-center">
          <TypeIcon type={item.session.tool} />
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            {title ? (
              <span className="text-base font-semibold">{title}</span>
            ) : (
              <span className="text-base font-normal italic text-text-muted">
                Untitled session
              </span>
            )}
            <span
              data-testid="timeline-row-time"
              className={cn(
                "t-text-swap ml-auto font-mono text-crumb text-text-muted whitespace-nowrap",
                isHovered && resumeCopyValue && "is-exit",
              )}
            >
              {formatRelativeTime(item.createdAt, now)}
            </span>
          </div>
          <p className="flex flex-wrap gap-2 items-center mt-1 text-text-muted wrap-anywhere m-0">
            {item.session.model ? (
              <span className="inline-flex items-center w-fit min-h-chip-min px-2 rounded-full text-xs font-bold leading-none text-chip-text bg-chip-bg border border-chip-border">
                {formatModelName(item.session.model)}
              </span>
            ) : null}
            {originBadge && !childTitle ? (
              <span className="inline-flex items-center w-fit min-h-chip-min px-2 rounded-full text-xs font-bold leading-none text-chip-text bg-chip-bg border border-chip-border">
                {originBadge}
              </span>
            ) : null}
            <span
              className="font-mono"
              title={formatTokenBreakdown(item.session.tokenTotals)}
            >
              <SessionTokenAndCost session={item.session} />
            </span>
          </p>
        </div>
        {resumeCopyValue ? (
          <span
            data-testid="timeline-row-resume"
            className={cn(
              "t-text-swap absolute top-1/2 right-3 -translate-y-1/2",
              isHovered ? "pointer-events-auto" : "is-exit pointer-events-none",
            )}
          >
            <CopyPromptButton
              label="Resume"
              copyLabel="Copy resume command"
              value={resumeCopyValue}
            />
          </span>
        ) : null}
      </div>
      {childItems.length > 0 ? (
        <SubagentGroup
          childItems={childItems}
          expanded={expanded}
          onToggle={onToggle}
        />
      ) : null}
    </li>
  );
}

// Shared "Smooth ease out" curve — the transitions.dev token also used by the
// doc viewer sheet, so panel-style reveals across the app feel of a piece.
const subagentLaneEase: [number, number, number, number] = [0.22, 1, 0.36, 1];

// Collapsible disclosure holding a root session's subagent + spawned fan. The
// header is the toggle; Motion tweens the lane's height/opacity so children
// slide in rather than snapping. Aligned under the root row's content column.
function SubagentGroup({
  childItems,
  expanded,
  onToggle,
}: {
  childItems: SessionTimelineItem[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const shouldReduceMotion = useReducedMotion();
  return (
    <div className="ml-[3.375rem] mt-2 mb-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 bg-transparent border-0 py-1 px-0 cursor-pointer text-text-muted hover:text-text"
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none"
          style={{ transform: `rotate(${expanded ? 90 : 0}deg)` }}
          aria-hidden="true"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.06em] leading-none whitespace-nowrap">
          {fanOutLabel(childItems)}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="lane"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={
              shouldReduceMotion
                ? { duration: 0 }
                : { duration: 0.24, ease: subagentLaneEase }
            }
            // The height tween needs overflow:hidden, but that also clips each
            // child row's leftward hover bleed (-ml-3). Widen the clip box with
            // matching horizontal padding + negative margin so the bleed shows.
            className="px-3 -mx-3"
            style={{ overflow: "hidden" }}
          >
            <ul className="list-none m-0 p-0 mt-2 flex flex-col gap-1">
              {childItems.map((child) => (
                <SubagentChildRow
                  key={`session:${child.session.id}`}
                  item={child}
                />
              ))}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// One compact child row inside a subagent lane. Leads with the subagent type
// (or the spawned session's name), tags spawned sessions, and demotes model +
// token spend to a single muted meta line.
function SubagentChildRow({ item }: { item: SessionTimelineItem }) {
  const { session } = item;
  const isSpawned = session.origin === "spawned";
  const title =
    item.sessionName ??
    sessionChildTitle(session) ??
    truncatePath(session.transcriptPath);
  const tokenLine = sessionTokenLine(session);
  const metaPrefix = [
    session.model ? formatModelName(session.model) : null,
    tokenLine,
  ]
    .filter(Boolean)
    .join(" · ");
  // The kind badge only earns its place when the row leads with the session's
  // own captured name. For a nameless child the title is already derived from
  // the origin/type (sessionChildTitle), so the badge would just repeat it.
  const kindBadge = item.sessionName
    ? isSpawned
      ? "spawned"
      : (session.subagentType ?? null)
    : null;

  return (
    <li className="content-bleed grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5 items-start py-1.5 hover:bg-surface">
      <div className="flex justify-center pt-px">
        <TypeIcon type={session.tool} size="sm" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-semibold text-text">{title}</span>
          {kindBadge ? (
            <span className="inline-flex items-center font-mono text-[9px] font-bold uppercase tracking-wider leading-relaxed px-1.5 rounded text-chip-text bg-chip-bg border border-chip-border">
              {kindBadge}
            </span>
          ) : null}
        </div>
        <div
          className="mt-1 font-mono text-[10.5px] text-text-muted tabular-nums wrap-anywhere"
          title={formatTokenBreakdown(session.tokenTotals)}
        >
          {metaPrefix}
          <SessionCostSuffix session={session} />
        </div>
      </div>
    </li>
  );
}

export function LeftOffPanel({
  state,
  updatedAt,
  lastWorkedOn,
  stateAuthor,
  stale,
  now,
  onDocLinkClick,
}: {
  state?: ParsedStateMd;
  updatedAt?: string;
  lastWorkedOn?: LastWorkedOn;
  stateAuthor?: StateAuthor;
  stale?: boolean;
  now?: Date;
  onDocLinkClick?: (event: MouseEvent<HTMLElement>) => void;
}) {
  if (!state) {
    return (
      <section
        data-testid="state-card"
        className="content-bleed mt-9 bg-surface py-6"
      >
        <h2 className="m-0 text-xs font-bold uppercase tracking-widest text-text-muted">
          Current state
        </h2>
        <p className="m-0 mt-3 text-sm text-text-muted">
          No state captured yet.
        </p>
      </section>
    );
  }

  const hasSupportingSections =
    state.decisions.length > 0 || state.openQuestions.length > 0;
  const hasContext = Boolean(lastWorkedOn) || Boolean(stateAuthor);
  const hasLowerSection = hasContext || Boolean(state.nextStep);

  return (
    <section
      data-testid="state-card"
      className="content-bleed mt-9 bg-surface py-6"
      onClick={onDocLinkClick}
    >
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h2 className="m-0 text-xs font-bold uppercase tracking-widest text-text-muted">
            Current state
          </h2>
          {stale ? (
            <>
              <span className="h-4 w-px bg-border" aria-hidden="true" />
              <span
                data-testid="state-stale-badge"
                role="status"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted"
              >
                <span className="text-warning" aria-hidden="true">
                  <StateStaleIcon />
                </span>
                Docs changed since snapshot
              </span>
            </>
          ) : null}
        </div>
        {updatedAt ? (
          // Labelled, not a bare relative time: this measures when the prose was
          // written, which is not the same as when anything about the task last
          // happened. An unlabelled corner timestamp read as the latter.
          <span className="ml-auto font-mono text-crumb text-text-muted tabular-nums whitespace-nowrap">
            State written{" "}
            <time
              data-testid="state-recency"
              dateTime={updatedAt}
              title={`Prose written ${updatedAt}`}
            >
              {formatRelativeTime(updatedAt, now)}
            </time>
          </span>
        ) : null}
      </div>
      <div>
        {state.summary ? (
          <p
            className="m-0 text-md font-semibold leading-normal text-text text-pretty"
            dangerouslySetInnerHTML={{ __html: state.summary }}
          />
        ) : null}
        {state.currentState.length > 0 ? (
          <div
            className="left-off-prose mt-3 text-base text-text-muted leading-relaxed text-pretty"
            dangerouslySetInnerHTML={{
              __html: state.currentState.join("\n"),
            }}
          />
        ) : null}
        {hasLowerSection ? (
          <div
            data-testid="state-lower-grid"
            className={cn(
              "mt-8 grid grid-cols-1 gap-y-7",
              hasContext && state.nextStep && "md:grid-cols-2 md:gap-x-12",
            )}
          >
            {hasContext ? (
              <div data-testid="state-context" className="order-2 md:order-1">
                <h3 className="m-0 mb-3 text-xs font-bold uppercase tracking-wide text-text-muted">
                  Context
                </h3>
                <div className="flex flex-col items-start gap-2">
                  {lastWorkedOn ? (
                    <LastWorkedOnContext lastWorkedOn={lastWorkedOn} />
                  ) : null}
                  {stateAuthor ? (
                    <StateAuthorContext author={stateAuthor} />
                  ) : null}
                </div>
              </div>
            ) : null}
            {state.nextStep ? (
              <div data-testid="state-next-step" className="order-1 md:order-2">
                <h3 className="m-0 mb-3 text-xs font-bold uppercase tracking-wide text-text-muted">
                  Next step
                </h3>
                <div className="flex gap-2.5">
                  <NextStepArrow />
                  <div
                    className="left-off-prose min-w-0 flex-1 text-sm font-medium leading-normal text-text-muted"
                    dangerouslySetInnerHTML={{ __html: state.nextStep }}
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {hasSupportingSections ? (
          <div className="mt-7 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-6">
            {state.decisions.length > 0 ? (
              <div>
                <h3 className="m-0 mb-3 text-xs font-bold uppercase tracking-wide text-text-muted">
                  Decisions made
                </h3>
                <ul className="m-0 p-0 flex flex-col gap-2.5">
                  {state.decisions.map((d, i) => (
                    <li key={i} className="flex gap-2.5">
                      <span
                        className="mt-1.5 size-1 shrink-0 rounded-full bg-border-strong"
                        aria-hidden="true"
                      />
                      <span
                        className="state-inline text-sm leading-normal text-text-muted"
                        dangerouslySetInnerHTML={{ __html: d }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {state.openQuestions.length > 0 ? (
              <div>
                <h3 className="m-0 mb-3 text-xs font-bold uppercase tracking-wide text-text-muted">
                  Open questions
                </h3>
                <ul className="m-0 p-0 flex flex-col gap-2.5">
                  {state.openQuestions.map((q, i) => (
                    <li key={i} className="flex gap-2.5">
                      <span
                        className="mt-1.5 size-1 shrink-0 rounded-full bg-border-strong"
                        aria-hidden="true"
                      />
                      <span
                        className="state-inline text-sm leading-normal text-text-muted"
                        dangerouslySetInnerHTML={{ __html: q }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function LastWorkedOnContext({ lastWorkedOn }: { lastWorkedOn: LastWorkedOn }) {
  const { copied, copy } = useClipboardCopy();
  const context = [lastWorkedOn.branch, lastWorkedOn.worktree]
    .filter(Boolean)
    .join(" in ");

  if (!lastWorkedOn.branch) {
    return (
      <span
        data-testid="last-work-context"
        className="inline-flex items-center gap-x-1.5 font-mono text-crumb text-text-muted"
        aria-label={`Last worked on ${context}`}
        title={`Last worked on ${context}`}
      >
        <span className="text-accent"><BranchIcon testId="last-work-icon" /></span>
        <span>Last worked on</span>
        {lastWorkedOn.worktree ? <span className="font-semibold text-text">{lastWorkedOn.worktree}</span> : null}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid="last-work-context"
      className="inline-flex items-center gap-x-1.5 font-mono text-crumb text-text-muted cursor-pointer rounded-sm hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      aria-label={copied ? `Copied branch ${lastWorkedOn.branch}` : `Copy branch ${lastWorkedOn.branch}`}
      title={`Copy branch ${lastWorkedOn.branch}`}
      onClick={() => void copy(lastWorkedOn.branch!)}
    >
      <span className="text-accent"><BranchIcon testId="last-work-icon" /></span>
      <span>Last worked on</span>
      <span className="font-bold text-text">{copied ? "Copied" : lastWorkedOn.branch}</span>
      {lastWorkedOn.worktree ? <span>· {lastWorkedOn.worktree}</span> : null}
    </button>
  );
}

// A bare tool mark, sized to sit inline in a line of text. The boxed TypeIcon
// tile carries weight the metadata lines do not want — next to the 12px branch
// icon its border and tinted background read as a badge rather than a bullet.
function ToolMark({ tool, size = 12 }: { tool: SessionTool; size?: number }) {
  if (tool === "cursor") {
    return (
      <>
        <img
          src={cursorIconLightUrl}
          alt=""
          width={size}
          height={size}
          className="block rounded-[2px] dark:hidden"
          aria-hidden="true"
        />
        <img
          src={cursorIconDarkUrl}
          alt=""
          width={size}
          height={size}
          className="hidden rounded-[2px] dark:block"
          aria-hidden="true"
        />
      </>
    );
  }

  if (tool === "copilot") {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {COPILOT_GLYPH_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  }

  // Codex draws with currentColor rather than the tile's gradient: at this size
  // the ramp is invisible, and a second gradient would duplicate its element id.
  return (
    <svg
      viewBox={tool === "codex" ? "2.75 2.75 18.5 18.5" : "0 0 24 24"}
      width={size}
      height={size}
      aria-hidden="true"
    >
      <path
        d={tool === "codex" ? CODEX_GLYPH_PATH : CLAUDE_GLYPH_PATH}
        fill="currentColor"
      />
    </svg>
  );
}

// Who wrote the snapshot above. The branch line says where the work happened;
// this says whose words you are reading — the thing you most want to know when
// the state was written by someone (or something) other than you.
function StateAuthorContext({ author }: { author: StateAuthor }) {
  const model = author.model ? formatModelName(author.model) : null;
  const label = `Last written by ${TOOL_LABELS[author.tool]}${model ? ` · ${model}` : ""}`;

  return (
    <span
      data-testid="state-author"
      className="inline-flex items-center gap-x-1.5 font-mono text-crumb text-text-muted"
      aria-label={label}
      title={label}
    >
      <span
        className="inline-flex"
        style={{ color: TYPE_ICON_STYLES[author.tool].color }}
        aria-hidden="true"
      >
        <ToolMark tool={author.tool} />
      </span>
      <span>Last written by</span>
      <span className="font-bold text-text">{TOOL_LABELS[author.tool]}</span>
      {model ? <span>· {model}</span> : null}
    </span>
  );
}

function docRouteFromStateClick(
  event: MouseEvent<HTMLElement>,
  {
    taskRef,
    knownDocPaths,
  }: { taskRef: string; knownDocPaths: readonly string[] },
): string | null {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return null;
  }

  const target = event.target;
  if (!(target instanceof Element)) return null;

  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;

  return resolveTaskDocLink({
    href: anchor.getAttribute("href") ?? "",
    baseDocPath: "state.md",
    knownDocPaths,
    taskRef,
  });
}

const TOOL_LABELS: Record<SessionTool, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
};

const TYPE_LABELS: Record<SessionTool | "doc", string> = {
  claude: "Claude session",
  codex: "Codex session",
  copilot: "Copilot session",
  cursor: "Cursor session",
  doc: "Document",
};

// Shared glyph data: the boxed TypeIcon tile and the bare inline ToolMark
// draw the same marks at different sizes and chrome.
const CLAUDE_GLYPH_PATH =
  "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";

const CODEX_GLYPH_PATH =
  "M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z";

const COPILOT_GLYPH_PATHS = ["M6 18 18 6", "m9 6 9 9", "M6 9v9h9"];

const TYPE_ICON_STYLES: Record<SessionTool | "doc", CSSProperties> = {
  claude: {
    color: "var(--color-tag-claude)",
    background:
      "color-mix(in srgb, var(--color-tag-claude) 10%, var(--color-surface))",
    borderColor:
      "color-mix(in srgb, var(--color-tag-claude) 25%, var(--color-border))",
  },
  codex: {
    color: "var(--color-tag-codex)",
    background: "var(--color-tag-codex-bg)",
    borderColor:
      "color-mix(in srgb, var(--color-tag-codex) 25%, var(--color-border))",
  },
  copilot: {
    color: "var(--color-tag-copilot)",
    background:
      "color-mix(in srgb, var(--color-tag-copilot) 10%, var(--color-surface))",
    borderColor:
      "color-mix(in srgb, var(--color-tag-copilot) 25%, var(--color-border))",
  },
  cursor: {
    color: "var(--color-text)",
    background: "transparent",
    borderColor: "var(--color-border)",
  },
  doc: {
    color: "var(--color-tag-doc)",
    background:
      "color-mix(in srgb, var(--color-tag-doc) 10%, var(--color-surface))",
    borderColor:
      "color-mix(in srgb, var(--color-tag-doc) 25%, var(--color-border))",
  },
};

/** Inline SVG glyph for each timeline entry type; colored via the type token. */
function TypeIcon({
  type,
  size = "lg",
}: {
  type: SessionTool | "doc";
  size?: "lg" | "sm";
}) {
  const box = size === "sm" ? "w-6 h-6" : "w-10 h-10";
  const glyph = size === "sm" ? 18 : 30;
  const docGlyph = size === "sm" ? 13 : 20;
  return (
    <span
      className={`type-icon type-icon-${type} inline-flex items-center justify-center ${box} rounded-md ${type === "cursor" ? "relative overflow-hidden" : "border"}`}
      style={TYPE_ICON_STYLES[type]}
      role="img"
      aria-label={TYPE_LABELS[type]}
    >
      {type === "claude" ? (
        <svg
          viewBox="0 0 24 24"
          width={glyph}
          height={glyph}
          aria-hidden="true"
        >
          <path d={CLAUDE_GLYPH_PATH} fill="currentColor" />
        </svg>
      ) : type === "codex" ? (
        <svg
          viewBox="2.75 2.75 18.5 18.5"
          width={glyph}
          height={glyph}
          aria-hidden="true"
        >
          <path d={CODEX_GLYPH_PATH} fill="url(#codex-icon-gradient)" />
          <defs>
            <linearGradient
              id="codex-icon-gradient"
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
      ) : type === "cursor" ? (
        <>
          <img
            src={cursorIconLightUrl}
            alt=""
            className="absolute inset-0 block h-full w-full object-cover dark:hidden"
            aria-hidden="true"
          />
          <img
            src={cursorIconDarkUrl}
            alt=""
            className="absolute inset-0 hidden h-full w-full object-cover dark:block"
            aria-hidden="true"
          />
          <span
            className="pointer-events-none absolute inset-0 rounded-md"
            style={{ boxShadow: "inset 0 0 0 1px var(--color-border-strong)" }}
            aria-hidden="true"
          />
        </>
      ) : type === "copilot" ? (
        <svg
          viewBox="0 0 24 24"
          width={glyph}
          height={glyph}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {COPILOT_GLYPH_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          width={docGlyph}
          height={docGlyph}
          aria-hidden="true"
        >
          <path
            d="M6 3h7l5 5v13H6z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <line
            x1="9"
            y1="13"
            x2="15"
            y2="13"
            stroke="currentColor"
            strokeWidth="2"
          />
          <line
            x1="9"
            y1="17"
            x2="15"
            y2="17"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      )}
    </span>
  );
}

function hasCapturedTokens(totals: TokenTotals): boolean {
  return (
    totals.inputTokens > 0 ||
    totals.outputTokens > 0 ||
    totals.cacheCreationInputTokens > 0 ||
    totals.cacheReadInputTokens > 0
  );
}

function sessionTokenLine(session: SessionTimelineItem["session"]): string {
  if (hasCapturedTokens(session.tokenTotals)) {
    return `${formatTokensCompact(session.tokenTotals.inputTokens)} in · ${formatTokensCompact(session.tokenTotals.outputTokens)} out`;
  }
  if (session.contextTokens) {
    return formatContextUsage(session.contextTokens);
  }
  return "tokens unavailable";
}

function sessionCostUsd(
  session: Pick<
    SessionTimelineItem["session"],
    "tool" | "model" | "tokenTotals"
  >,
): number | null {
  return costFromSessions([session]).totalUsd;
}

function SessionTokenAndCost({
  session,
}: {
  session: SessionTimelineItem["session"];
}) {
  return (
    <>
      {sessionTokenLine(session)}
      <SessionCostSuffix session={session} />
    </>
  );
}

function SessionCostSuffix({
  session,
}: {
  session: Pick<
    SessionTimelineItem["session"],
    "tool" | "model" | "tokenTotals"
  >;
}) {
  const totalUsd = sessionCostUsd(session);
  if (totalUsd === null) return null;
  return (
    <>
      {" · "}
      <span data-testid="session-cost">{formatUsd(totalUsd)}</span>
    </>
  );
}

function TokenSummary({
  totals,
  sessions,
}: {
  totals: TokenTotals;
  sessions: ReadonlyArray<
    Pick<SessionTimelineItem["session"], "tool" | "model" | "tokenTotals">
  >;
}) {
  // "Total" is fresh spend — input + output — matching the figure on the main
  // task list so the number is consistent across both views. Cache reads are
  // cheap context replay, so they ride below as a separate, labeled stat.
  const cards: { label: string; value: number }[] = [
    { label: "Total", value: freshTokenTotal(totals) },
    { label: "Input", value: totals.inputTokens },
    { label: "Output", value: totals.outputTokens },
  ];
  const rollup = costFromSessions(sessions);
  const sessionCount = rollup.pricedSessions + rollup.unpricedSessions;
  const costDisplay =
    rollup.totalUsd === null ? "—" : formatUsd(rollup.totalUsd);
  const partialLabel =
    rollup.unpricedSessions > 0
      ? `${rollup.pricedSessions} of ${sessionCount} sessions priced`
      : null;
  return (
    <div className="mt-8 pt-6 flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
      <dl
        className="m-0 flex flex-wrap gap-x-11 gap-y-3"
        aria-label="Token totals"
      >
        {cards.map((card) => (
          <div key={card.label} className="min-w-16">
            <dt className="text-xs font-bold uppercase tracking-wide text-text-muted">
              {card.label}
            </dt>
            <dd
              className="m-0 mt-1.5 font-mono text-2xl font-bold tabular-nums"
              title={String(card.value)}
            >
              {formatTokensCompact(card.value)}
            </dd>
          </div>
        ))}
        <div className="min-w-16">
          <dt className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-text-muted">
            Cost
            {partialLabel ? (
              <span
                data-testid="task-cost-partial"
                className="inline-flex cursor-help text-text-muted"
                title={partialLabel}
                aria-label={partialLabel}
              >
                <TriangleAlert size={11} strokeWidth={2.4} aria-hidden="true" />
              </span>
            ) : null}
          </dt>
          <dd
            data-testid="task-cost"
            className="m-0 mt-1.5 font-mono text-2xl font-bold tabular-nums"
            title={
              rollup.totalUsd === null ? undefined : String(rollup.totalUsd)
            }
          >
            {costDisplay}
          </dd>
        </div>
      </dl>
      <p
        data-testid="token-summary-cache"
        className="m-0 flex flex-wrap items-baseline gap-2 text-text-muted text-sm font-mono tabular-nums"
      >
        <span className="text-xs font-bold uppercase tracking-wide">Cache</span>
        <span
          className="whitespace-nowrap"
          title={String(totals.cacheReadInputTokens)}
        >
          {formatTokensCompact(totals.cacheReadInputTokens)} read
        </span>
        <span className="opacity-50" aria-hidden="true">
          ·
        </span>
        <span
          className="whitespace-nowrap"
          title={String(totals.cacheCreationInputTokens)}
        >
          {formatTokensCompact(totals.cacheCreationInputTokens)} written
        </span>
      </p>
    </div>
  );
}

function BackArrowIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

function ClockIcon() {
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
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

function BranchIcon({ testId }: { testId?: string }) {
  return (
    <svg
      {...(testId ? { "data-testid": testId } : {})}
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
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M6 8v2a4 4 0 0 0 4 4h8" />
      <path d="M18 8v8" />
    </svg>
  );
}

function StateStaleIcon() {
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
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="M8 15h8" />
    </svg>
  );
}

function NextStepArrow() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 mt-0.5 text-accent"
      aria-hidden="true"
    >
      <path d="M5 12h13" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}
