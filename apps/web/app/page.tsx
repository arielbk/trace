import Link from "next/link";
import { listTasks } from "./trace-data.ts";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export default async function Home() {
  const tasks = listTasks();

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>Trace</p>
          <h1>Tasks</h1>
        </div>
        <p className={styles.count}>{tasks.length} tasks</p>
      </header>

      {tasks.length === 0 ? (
        <p className={styles.empty}>No tasks found.</p>
      ) : (
        <ul className={styles.taskList}>
          {tasks.map((task) => (
            <li key={task.id} className={styles.taskRow}>
              <Link href={`/task/${task.id}`}>
                <span className={styles.taskTitle}>{task.title}</span>
                <span className={styles.taskMeta}>{task.id}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
