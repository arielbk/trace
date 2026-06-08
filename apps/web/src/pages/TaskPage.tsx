import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { SessionTool, TaskTimeline, TokenTotals } from "@trace/core";
import { AppHeader } from "../components/AppHeader.tsx";
import { CopyChip } from "../components/CopyChip.tsx";
import {
  buildReEnterPrompt,
  formatRelativeTime,
  formatTokenBreakdown,
  formatTokensCompact,
  truncatePath,
} from "../format.ts";

export function TaskPage() {
  const { id } = useParams();
  const [timeline, setTimeline] = useState<TaskTimeline | null | "missing">(null);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/tasks/${id}/timeline`)
      .then((res) => (res.status === 404 ? "missing" : res.json()))
      .then(setTimeline);
  }, [id]);

  if (timeline === null) return <main><p>Loading...</p></main>;
  if (timeline === "missing") return <main><p>Task not found.</p></main>;

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
      <AppHeader context={timeline.task.title} />
      <header className="task-header">
        <div className="task-heading">
          <div className="task-title-row">
            <h1>{timeline.task.title}</h1>
            <CopyChip
              value={buildReEnterPrompt(timeline.task.title, timeline.task.slug)}
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
                  <CopyChip
                    value={item.session.transcriptPath}
                    display={item.sessionName ?? truncatePath(item.session.transcriptPath)}
                  />
                  <p className="item-meta">
                    {item.session.model ? (
                      <span className="model-chip">{item.session.model}</span>
                    ) : null}
                    <span
                      className="item-tokens"
                      title={formatTokenBreakdown(item.session.tokenTotals)}
                    >
                      {formatTokensCompact(item.session.tokenTotals.inputTokens)} in
                      {" · "}
                      {formatTokensCompact(item.session.tokenTotals.outputTokens)} out
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
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M12 2C12 7 7 12 2 12C7 12 12 17 12 22C12 17 17 12 22 12C17 12 12 7 12 2Z"
            fill="currentColor"
          />
        </svg>
      ) : type === "codex" ? (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <polyline
            points="9 8 5 12 9 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <polyline
            points="15 8 19 12 15 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
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
          <line x1="9" y1="13" x2="15" y2="13" stroke="currentColor" strokeWidth="2" />
          <line x1="9" y1="17" x2="15" y2="17" stroke="currentColor" strokeWidth="2" />
        </svg>
      )}
    </span>
  );
}

function TokenSummary({ totals }: { totals: TokenTotals }) {
  const cards: { label: string; value: number }[] = [
    { label: "Total", value: totals.totalTokens },
    { label: "Input", value: totals.inputTokens },
    { label: "Output", value: totals.outputTokens },
  ];
  return (
    <dl className="token-summary" aria-label="Token totals">
      {cards.map((card) => (
        <div key={card.label}>
          <dt>{card.label}</dt>
          <dd title={String(card.value)}>{formatTokensCompact(card.value)}</dd>
        </div>
      ))}
      <div>
        <dt>Cache</dt>
        <dd>
          <span title={String(totals.cacheReadInputTokens)}>
            {formatTokensCompact(totals.cacheReadInputTokens)}
          </span>
          <span
            className="token-summary-sub"
            title={String(totals.cacheCreationInputTokens)}
          >
            +{formatTokensCompact(totals.cacheCreationInputTokens)} written
          </span>
        </dd>
      </div>
    </dl>
  );
}
