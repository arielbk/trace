import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { Session, TaskTimeline } from "@trace/core";
import { CopyChip } from "../components/CopyChip.tsx";
import { truncateId } from "../format.ts";

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

export function TaskTimelineView({ timeline }: { timeline: TaskTimeline }) {
  return (
    <main className="task-page">
      <header className="task-header">
        <div>
          <p className="eyebrow">Task timeline</p>
          <h1>{timeline.task.title}</h1>
          <p className="task-id">
            <CopyChip value={timeline.task.id} display={truncateId(timeline.task.id)} />
          </p>
        </div>
        <dl className="token-summary" aria-label="Token totals">
          <div><dt>Total</dt><dd>{timeline.tokenTotals.totalTokens}</dd></div>
          <div><dt>Input</dt><dd>{timeline.tokenTotals.inputTokens}</dd></div>
          <div><dt>Output</dt><dd>{timeline.tokenTotals.outputTokens}</dd></div>
        </dl>
      </header>
      {timeline.items.length === 0 ? (
        <p className="empty-state">No timeline items found.</p>
      ) : (
        <ol className="timeline-list">
          {timeline.items.map((item) =>
            item.type === "session" ? (
              <li className="timeline-item" key={`session:${item.session.id}`}>
                <ToolTag session={item.session} />
                <div className="timeline-item-body">
                  <h2>{item.session.id}</h2>
                  <p>{item.session.transcriptPath}</p>
                  <p className="item-meta">
                    <span className="model-chip">{item.session.model ?? "—"}</span>
                    <span>{item.session.tokenTotals.totalTokens} tokens</span>
                  </p>
                </div>
              </li>
            ) : (
              <li className="timeline-item" key={`doc:${item.doc.path}`}>
                <span className="tool-tag tool-tag-doc">doc</span>
                <div className="timeline-item-body">
                  <h2>{item.doc.path}</h2>
                  <p>{item.createdAt}</p>
                </div>
              </li>
            ),
          )}
        </ol>
      )}
    </main>
  );
}

function ToolTag({ session }: { session: Session }) {
  return (
    <span className={`tool-tag tool-tag-${session.tool}`}>
      {session.tool}
    </span>
  );
}
