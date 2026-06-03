import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Task } from "@trace/core";

export type ProjectTaskGroup = {
  projectRoot: string;
  displayName: string;
  tasks: Task[];
};

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);

  useEffect(() => {
    fetch("/api/tasks")
      .then((res) => res.json())
      .then(setTasks);
  }, []);

  if (tasks === null)
    return (
      <main>
        <p>Loading...</p>
      </main>
    );

  return (
    <main>
      <header>
        <p>Trace</p>
        <h1>Tasks</h1>
        <p>{tasks.length} tasks</p>
      </header>
      {tasks.length === 0 ? <p>No tasks found.</p> : <TaskList tasks={tasks} />}
    </main>
  );
}

export function TaskList({ tasks }: { tasks: Task[] }) {
  return (
    <div className="project-groups">
      {groupTasksByProject(tasks).map((group) => (
        <section className="project-group" key={group.projectRoot}>
          <header>
            <h2>{group.displayName}</h2>
            <p>{group.projectRoot}</p>
          </header>
          <ul>
            {group.tasks.map((task) => (
              <li key={task.id}>
                <Link to={`/task/${task.slug}`}>
                  <strong>{task.title}</strong>
                  <span> {task.slug}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function groupTasksByProject(tasks: Task[]): ProjectTaskGroup[] {
  const groups = new Map<string, ProjectTaskGroup>();

  for (const task of tasks) {
    const projectRoot = task.projectRoot || "Unknown project";
    const group = groups.get(projectRoot);

    if (group) {
      group.tasks.push(task);
      continue;
    }

    groups.set(projectRoot, {
      projectRoot,
      displayName: projectDisplayName(projectRoot),
      tasks: [task],
    });
  }

  return Array.from(groups.values());
}

function projectDisplayName(projectRoot: string): string {
  const normalizedPath = projectRoot.replace(/[/\\]+$/, "");
  const parts = normalizedPath.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? projectRoot;
}
