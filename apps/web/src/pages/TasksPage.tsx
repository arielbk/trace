import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Task } from "@trace/core";

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);

  useEffect(() => {
    fetch("/api/tasks")
      .then((res) => res.json())
      .then(setTasks);
  }, []);

  if (tasks === null) return <main><p>Loading...</p></main>;

  return (
    <main>
      <header>
        <p>Trace</p>
        <h1>Tasks</h1>
        <p>{tasks.length} tasks</p>
      </header>
      {tasks.length === 0 ? (
        <p>No tasks found.</p>
      ) : (
        <ul>
          {tasks.map((task) => (
            <li key={task.id}>
              <Link to={`/task/${task.id}`}>
                <strong>{task.title}</strong>
                <span> {task.id}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
