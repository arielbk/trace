import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Task = {
  id: string;
  title: string;
  createdAt: string;
};

export type TaskStore = {
  createTask(title: string): Task;
  getTask(id: string): Task | null;
  listTasks(): Task[];
  close(): void;
};

type TaskRow = {
  id: string;
  title: string;
  created_at: string;
};

export function openTraceStore(databasePath: string): TaskStore {
  return new SqliteTaskStore(databasePath);
}

class SqliteTaskStore implements TaskStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    const resolvedPath = resolve(databasePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.#database = new DatabaseSync(resolvedPath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  createTask(title: string): Task {
    const normalizedTitle = title.trim();

    if (normalizedTitle.length === 0) {
      throw new Error("Task title is required");
    }

    const task: Task = {
      id: randomUUID(),
      title: normalizedTitle,
      createdAt: new Date().toISOString(),
    };

    this.#database
      .prepare("INSERT INTO tasks (id, title, created_at) VALUES (?, ?, ?)")
      .run(task.id, task.title, task.createdAt);

    return task;
  }

  getTask(id: string): Task | null {
    const row = this.#database.prepare("SELECT id, title, created_at FROM tasks WHERE id = ?").get(id);

    return row ? taskFromRow(row as TaskRow) : null;
  }

  listTasks(): Task[] {
    return this.#database
      .prepare("SELECT id, title, created_at FROM tasks ORDER BY created_at ASC, id ASC")
      .all()
      .map((row) => taskFromRow(row as TaskRow));
  }

  close(): void {
    this.#database.close();
  }
}

function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
  };
}
