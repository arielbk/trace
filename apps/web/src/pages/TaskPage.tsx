import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { TaskTimeline } from "@trace/core";

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

  return (
    <main>
      <header>
        <p>Task</p>
        <h1>{timeline.task.title}</h1>
        <p>{timeline.task.id}</p>
        <dl>
          <div><dt>Total tokens</dt><dd>{timeline.tokenTotals.totalTokens}</dd></div>
          <div><dt>Input</dt><dd>{timeline.tokenTotals.inputTokens}</dd></div>
          <div><dt>Output</dt><dd>{timeline.tokenTotals.outputTokens}</dd></div>
        </dl>
      </header>
      {timeline.items.length === 0 ? (
        <p>No timeline items found.</p>
      ) : (
        <ol>
          {timeline.items.map((item) =>
            item.type === "session" ? (
              <li key={`session:${item.session.id}`}>
                <span>{item.session.tool}</span>
                <div>
                  <h2>{item.session.id}</h2>
                  <p>{item.session.transcriptPath}</p>
                  <p>{item.session.tokenTotals.totalTokens} tokens</p>
                </div>
              </li>
            ) : (
              <li key={`doc:${item.doc.path}`}>
                <span>doc</span>
                <div>
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
