import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  freshTokenTotal,
  type SessionTool,
  type TaskTimeline,
  type TokenTotals,
} from "@trace/core";
import { AppHeader } from "../components/AppHeader.tsx";
import { CopyChip } from "../components/CopyChip.tsx";
import {
  buildReEnterPrompt,
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

  useEffect(() => {
    if (!id) return;
    fetch(`/api/tasks/${id}/timeline`)
      .then((res) => (res.status === 404 ? "missing" : res.json()))
      .then(setTimeline);
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

  return <TaskTimelineView timeline={timeline} />;
}

export function TaskTimelineView({
  timeline,
  now,
}: {
  timeline: TaskTimeline;
  now?: Date;
}) {
  return (
    <main className="task-page">
      <AppHeader
        project={
          timeline.task.projectRoot
            ? truncatePath(timeline.task.projectRoot)
            : undefined
        }
        context={timeline.task.title}
      />
      <header className="task-header">
        <div className="task-heading">
          <div className="task-title-row">
            <h1>{timeline.task.title}</h1>
            <CopyChip
              value={buildReEnterPrompt(
                timeline.task.title,
                timeline.task.slug,
              )}
              display="Copy re-enter prompt"
            />
          </div>
          {timeline.task.description ? (
            <p className="task-description">{timeline.task.description}</p>
          ) : null}
        </div>
        <TokenSummary totals={timeline.tokenTotals} />
      </header>
      {timeline.items.length === 0 ? (
        <p className="empty-state">No timeline items found.</p>
      ) : (
        <ol className="timeline-list">
          {timeline.items.map((item) =>
            item.type === "session" ? (
              <li className="timeline-item" key={`session:${item.session.id}`}>
                <TypeIcon type={item.session.tool} />
                <div className="timeline-item-body">
                  {item.sessionName ? (
                    <span className="session-name">{item.sessionName}</span>
                  ) : (
                    <CopyChip
                      value={item.session.transcriptPath}
                      display={truncatePath(item.session.transcriptPath)}
                    />
                  )}
                  <p className="item-meta">
                    {item.session.model ? (
                      <span className="model-chip">{item.session.model}</span>
                    ) : null}
                    <span
                      className="item-tokens"
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
                    <span className="timeline-item-time">
                      {formatRelativeTime(item.createdAt, now)}
                    </span>
                  </p>
                </div>
              </li>
            ) : (
              <li className="timeline-item" key={`doc:${item.doc.path}`}>
                <TypeIcon type="doc" />
                <div className="timeline-item-body">
                  <CopyChip
                    value={item.doc.path}
                    display={truncatePath(item.doc.path)}
                  />
                  <p className="item-meta">
                    {item.sizeBytes !== null ? (
                      <span className="doc-size">
                        {formatBytes(item.sizeBytes)}
                      </span>
                    ) : null}
                    <span className="timeline-item-time">
                      {formatRelativeTime(item.createdAt, now)}
                    </span>
                  </p>
                </div>
              </li>
            ),
          )}
        </ol>
      )}
    </main>
  );
}

const TYPE_LABELS: Record<SessionTool | "doc", string> = {
  claude: "Claude session",
  codex: "Codex session",
  doc: "Document",
};

/** Inline SVG glyph for each timeline entry type; colored via the type token. */
function TypeIcon({ type }: { type: SessionTool | "doc" }) {
  return (
    <span
      className={`type-icon type-icon-${type}`}
      role="img"
      aria-label={TYPE_LABELS[type]}
    >
      {type === "claude" ? (
        // Claude's sunburst/spark mark: radiating tapered spokes from a center,
        // rendered as round-capped strokes. Recognizably Claude rather than a
        // generic 4-point sparkle.
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <line x1="12" y1="12" x2="21" y2="12" />
            <line x1="12" y1="12" x2="19.79" y2="16.5" />
            <line x1="12" y1="12" x2="16.5" y2="19.79" />
            <line x1="12" y1="12" x2="12" y2="21" />
            <line x1="12" y1="12" x2="7.5" y2="19.79" />
            <line x1="12" y1="12" x2="4.21" y2="16.5" />
            <line x1="12" y1="12" x2="3" y2="12" />
            <line x1="12" y1="12" x2="4.21" y2="7.5" />
            <line x1="12" y1="12" x2="7.5" y2="4.21" />
            <line x1="12" y1="12" x2="12" y2="3" />
            <line x1="12" y1="12" x2="16.5" y2="4.21" />
            <line x1="12" y1="12" x2="19.79" y2="7.5" />
          </g>
        </svg>
      ) : type === "codex" ? (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z"
            fill="var(--color-surface)"
          />
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
    <div className="token-summary-wrap">
      <dl className="token-summary" aria-label="Token totals">
        {cards.map((card) => (
          <div key={card.label}>
            <dt>{card.label}</dt>
            <dd title={String(card.value)}>
              {formatTokensCompact(card.value)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="token-summary-cache">
        <span className="token-summary-cache-label">Cache</span>
        <span title={String(totals.cacheReadInputTokens)}>
          {formatTokensCompact(totals.cacheReadInputTokens)} read
        </span>
        <span className="token-summary-cache-sep" aria-hidden="true">
          ·
        </span>
        <span title={String(totals.cacheCreationInputTokens)}>
          {formatTokensCompact(totals.cacheCreationInputTokens)} written
        </span>
      </p>
    </div>
  );
}
