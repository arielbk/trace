import { notFound } from "next/navigation";
import { getTaskTimeline } from "../../trace-data.ts";
import styles from "../../page.module.css";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{
    id: string;
  }>;
};

export default async function TaskPage({ params }: Props) {
  const { id } = await params;
  const timeline = getTaskTimeline(id);

  if (!timeline) {
    notFound();
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>Task</p>
          <h1>{timeline.task.title}</h1>
          <p className={styles.taskMeta}>{timeline.task.id}</p>
        </div>
        <dl className={styles.tokens}>
          <div>
            <dt>Total tokens</dt>
            <dd>{timeline.tokenTotals.totalTokens}</dd>
          </div>
          <div>
            <dt>Input</dt>
            <dd>{timeline.tokenTotals.inputTokens}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{timeline.tokenTotals.outputTokens}</dd>
          </div>
        </dl>
      </header>

      {timeline.items.length === 0 ? (
        <p className={styles.empty}>No timeline items found.</p>
      ) : (
        <ol className={styles.timeline}>
          {timeline.items.map((item) =>
            item.type === "session" ? (
              <li key={`session:${item.session.id}`} className={styles.event}>
                <span className={styles.badge}>{item.session.tool}</span>
                <div>
                  <h2>{item.session.id}</h2>
                  <p>{item.session.transcriptPath}</p>
                  <p>{item.session.tokenTotals.totalTokens} tokens</p>
                </div>
              </li>
            ) : (
              <li key={`doc:${item.doc.path}`} className={styles.event}>
                <span className={styles.badge}>doc</span>
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
