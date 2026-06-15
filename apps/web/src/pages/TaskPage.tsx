import { useEffect, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import type { ParsedStateMd } from "@trace/core";
import {
  freshTokenTotal,
  type SessionTool,
  type TaskTimeline,
  type TokenTotals,
} from "@trace/core/browser";
import { AppHeader } from "../components/AppHeader.tsx";
import { ArchiveToggleButton } from "../components/ArchiveToggleButton.tsx";
import { ClampedSection } from "../components/ClampedSection.tsx";
import { CopyChip } from "../components/CopyChip.tsx";
import { ReEnterButton } from "../components/ReEnterButton.tsx";
import { cn } from "../lib/utils.ts";
import {
  formatBytes,
  formatRelativeTime,
  formatTokenBreakdown,
  formatTokensCompact,
  truncatePath,
} from "../format.ts";

export function TaskPage() {
  const { id } = useParams();
  const [timeline, setTimeline] = useState<TaskTimeline | null | "missing">(
    null,
  );
  const [archivedAt, setArchivedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/tasks/${id}/timeline`)
      .then((res) => (res.status === 404 ? "missing" : res.json()))
      .then((result) => {
        setTimeline(result);
        if (result !== "missing" && result !== null) {
          setArchivedAt((result as TaskTimeline).task.archivedAt);
        }
      });
  }, [id]);

  if (timeline === null)
    return (
      <main>
        <p>Loading...</p>
      </main>
    );
  if (timeline === "missing")
    return (
      <main>
        <p>Task not found.</p>
      </main>
    );

  async function handleArchive() {
    if (!timeline || timeline === "missing") return;
    const result = await taskArchive((timeline as TaskTimeline).task.slug);
    setArchivedAt(result.archivedAt);
  }

  async function handleUnarchive() {
    if (!timeline || timeline === "missing") return;
    const result = await taskUnarchive((timeline as TaskTimeline).task.slug);
    setArchivedAt(result.archivedAt);
  }

  return (
    <TaskTimelineView
      timeline={timeline}
      archivedAt={archivedAt}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
    />
  );
}

export function TaskTimelineView({
  timeline,
  now,
  archivedAt: archivedAtProp,
  onArchive,
  onUnarchive,
}: {
  timeline: TaskTimeline;
  now?: Date;
  archivedAt?: string | null;
  onArchive?: () => void | Promise<void>;
  onUnarchive?: () => void | Promise<void>;
}) {
  const archivedAt =
    archivedAtProp !== undefined ? archivedAtProp : timeline.task.archivedAt;
  const isArchived = archivedAt !== null;
  const onToggleArchive = isArchived ? onUnarchive : onArchive;

  const [timelineFilter, setTimelineFilter] = useState<"all" | "session" | "doc">(
    "all",
  );

  const sessionCount = timeline.items.filter(
    (item) => item.type === "session",
  ).length;
  const docCount = timeline.items.filter((item) => item.type === "doc").length;
  const visibleItems = (
    timelineFilter === "all"
      ? timeline.items
      : timeline.items.filter((item) => item.type === timelineFilter)
  ).slice().reverse();

  function toggleFilter(filter: "session" | "doc") {
    setTimelineFilter((current) => (current === filter ? "all" : filter));
  }

  return (
    <main className="max-w-app mx-auto px-5 pb-16">
      <AppHeader
        project={
          timeline.task.projectRoot
            ? truncatePath(timeline.task.projectRoot)
            : undefined
        }
        projectHref={
          timeline.task.projectRoot
            ? `/?project=${encodeURIComponent(timeline.task.projectRoot)}`
            : undefined
        }
        context={timeline.task.slug}
        bordered={false}
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
        <div className="flex flex-wrap items-start justify-between gap-5">
          <h1 className="m-0 text-page-title font-extrabold tracking-tight leading-tight">
            {timeline.task.title}
          </h1>
          <div className="flex items-center gap-1.5 pt-2 shrink-0 font-mono text-crumb text-text-muted">
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
            className="mt-3 mb-0 text-sm text-text-muted leading-relaxed max-w-row-description"
          >
            {timeline.task.description}
          </p>
        ) : null}
        <div className="flex items-center gap-2 flex-wrap mt-5">
          <ReEnterButton title={timeline.task.title} slug={timeline.task.slug} />
          {onToggleArchive ? (
            <ArchiveToggleButton
              isArchived={isArchived}
              onToggle={onToggleArchive}
              className="ml-auto"
            />
          ) : null}
        </div>
      </div>
      <LeftOffPanel state={timeline.state} />
      <TokenSummary totals={timeline.tokenTotals} />
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
            {visibleItems.map((item) => {
              return item.type === "session" ? (
              <li
                className="relative grid timeline-grid gap-3.5 py-3 pl-3 -ml-3 pr-3 -mr-3 hover:bg-surface"
                key={`session:${item.session.id}`}
              >
                <div className="relative z-10 flex justify-center">
                  <TypeIcon type={item.session.tool} />
                </div>
                <div className="min-w-0">
                  {item.sessionName ? (
                    <span className="text-base font-semibold">
                      {item.sessionName}
                    </span>
                  ) : (
                    <CopyChip
                      value={item.session.transcriptPath}
                      display={truncatePath(item.session.transcriptPath)}
                    />
                  )}
                  <p className="flex flex-wrap gap-2 items-center mt-1 text-text-muted wrap-anywhere m-0">
                    {item.session.model ? (
                      <span className="inline-flex items-center w-fit min-h-chip-min px-2 rounded-full text-xs font-bold leading-none text-chip-text bg-chip-bg border border-chip-border">
                        {item.session.model}
                      </span>
                    ) : null}
                    <span
                      className="font-mono"
                      title={formatTokenBreakdown(item.session.tokenTotals)}
                    >
                      {hasCapturedTokens(item.session.tokenTotals) ? (
                        <>
                          {formatTokensCompact(
                            item.session.tokenTotals.inputTokens,
                          )}{" "}
                          in{" · "}
                          {formatTokensCompact(
                            item.session.tokenTotals.outputTokens,
                          )}{" "}
                          out
                        </>
                      ) : (
                        "tokens unavailable"
                      )}
                    </span>
                    <span className="ml-auto text-text-muted text-sm">
                      {formatRelativeTime(item.createdAt, now)}
                    </span>
                  </p>
                </div>
              </li>
            ) : (
              <li
                className="relative grid timeline-grid gap-3.5 py-3 pl-3 -ml-3 pr-3 -mr-3 hover:bg-surface"
                key={`doc:${item.doc.path}`}
              >
                <div className="relative z-10 flex justify-center">
                  <TypeIcon type="doc" />
                </div>
                <div className="min-w-0">
                  <CopyChip
                    value={item.doc.path}
                    display={truncatePath(item.doc.path)}
                  />
                  <p className="flex flex-wrap gap-2 items-center mt-1 text-text-muted m-0">
                    {item.sizeBytes !== null ? (
                      <span className="font-mono tabular-nums">
                        {formatBytes(item.sizeBytes)}
                      </span>
                    ) : null}
                    <span className="ml-auto text-text-muted text-sm">
                      {formatRelativeTime(item.createdAt, now)}
                    </span>
                  </p>
                </div>
              </li>
            );
            })}
          </ol>
        )}
      </section>
    </main>
  );
}

export function LeftOffPanel({ state }: { state?: ParsedStateMd }) {
  if (!state) {
    return (
      <p className="mt-8 pt-6 border-t border-border text-sm text-text-muted">
        No context saved yet — run{" "}
        <code className="font-mono text-xs">/handoff</code> to capture where you
        left off.
      </p>
    );
  }

  const hasGrid =
    state.decisions.length > 0 ||
    Boolean(state.nextStep) ||
    state.openQuestions.length > 0;

  return (
    <section className="mt-8 pt-6 border-t border-border">
      <h2 className="m-0 mb-2.5 text-xs font-bold uppercase tracking-widest text-accent">
        Where you left off
      </h2>
      <ClampedSection maxHeight={200}>
        <div>
        {state.summary ? (
          <p
            className="m-0 text-md font-semibold leading-normal text-text"
            dangerouslySetInnerHTML={{ __html: state.summary }}
          />
        ) : null}
        {state.currentState.length > 0 ? (
          <div
            className="left-off-prose mt-3 text-base text-text-muted leading-relaxed"
            dangerouslySetInnerHTML={{
              __html: state.currentState.join("\n"),
            }}
          />
        ) : null}
      {hasGrid ? (
        <div className="mt-7 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-6">
          {state.decisions.length > 0 ? (
            <div>
              <h3 className="m-0 mb-3 text-xs font-bold uppercase tracking-wide text-accent">
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
                      className="text-sm leading-normal text-text"
                      dangerouslySetInnerHTML={{ __html: d }}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-col gap-6">
            {state.nextStep ? (
              <div>
                <h3 className="m-0 mb-3 text-xs font-bold uppercase tracking-wide text-accent">
                  Next step
                </h3>
                <div className="flex gap-2.5">
                  <NextStepArrow />
                  <span
                    className="text-sm font-medium leading-normal text-text"
                    dangerouslySetInnerHTML={{ __html: state.nextStep }}
                  />
                </div>
              </div>
            ) : null}
            {state.openQuestions.length > 0 ? (
              <div>
                <h3 className="m-0 mb-3 text-xs font-bold uppercase tracking-wide text-accent">
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
                        className="text-sm leading-normal text-text"
                        dangerouslySetInnerHTML={{ __html: q }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
        </div>
      </ClampedSection>
    </section>
  );
}

const TYPE_LABELS: Record<SessionTool | "doc", string> = {
  claude: "Claude session",
  codex: "Codex session",
  doc: "Document",
};

const TYPE_ICON_STYLES: Record<SessionTool | "doc", CSSProperties> = {
  claude: {
    color: "var(--color-tag-claude)",
    background: "color-mix(in srgb, var(--color-tag-claude) 10%, var(--color-surface))",
    borderColor: "color-mix(in srgb, var(--color-tag-claude) 25%, var(--color-border))",
  },
  codex: {
    color: "var(--color-tag-codex)",
    background: "var(--color-tag-codex-bg)",
    borderColor: "color-mix(in srgb, var(--color-tag-codex) 25%, var(--color-border))",
  },
  doc: {
    color: "var(--color-tag-doc)",
    background: "color-mix(in srgb, var(--color-tag-doc) 10%, var(--color-surface))",
    borderColor: "color-mix(in srgb, var(--color-tag-doc) 25%, var(--color-border))",
  },
};

/** Inline SVG glyph for each timeline entry type; colored via the type token. */
function TypeIcon({ type }: { type: SessionTool | "doc" }) {
  return (
    <span
      className={`type-icon type-icon-${type} inline-flex items-center justify-center w-10 h-10 border rounded-md`}
      style={TYPE_ICON_STYLES[type]}
      role="img"
      aria-label={TYPE_LABELS[type]}
    >
      {type === "claude" ? (
        <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
          <path
            d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
            fill="currentColor"
          />
        </svg>
      ) : type === "codex" ? (
        <svg
          viewBox="2.75 2.75 18.5 18.5"
          width="30"
          height="30"
          aria-hidden="true"
        >
          <path
            d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
            fill="url(#codex-icon-gradient)"
          />
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
      ) : (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
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

function TokenSummary({ totals }: { totals: TokenTotals }) {
  // "Total" is fresh spend — input + output — matching the figure on the main
  // task list so the number is consistent across both views. Cache reads are
  // cheap context replay, so they ride below as a separate, labeled stat.
  const cards: { label: string; value: number }[] = [
    { label: "Total", value: freshTokenTotal(totals) },
    { label: "Input", value: totals.inputTokens },
    { label: "Output", value: totals.outputTokens },
  ];
  return (
    <div className="mt-8 pt-6 border-t border-border flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
      <dl className="m-0 flex flex-wrap gap-x-11 gap-y-3" aria-label="Token totals">
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

async function taskArchive(
  ref: string,
): Promise<{ id: string; archivedAt: string | null }> {
  const response = await fetch(
    `/api/tasks/${encodeURIComponent(ref)}/archive`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error(`Failed to archive task ${ref}`);
  return (await response.json()) as { id: string; archivedAt: string | null };
}

async function taskUnarchive(
  ref: string,
): Promise<{ id: string; archivedAt: string | null }> {
  const response = await fetch(
    `/api/tasks/${encodeURIComponent(ref)}/unarchive`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error(`Failed to unarchive task ${ref}`);
  return (await response.json()) as { id: string; archivedAt: string | null };
}
