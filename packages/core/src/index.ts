import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export { parseClaudeCodeTranscript, parseClaudeCodeTranscriptFile } from "./claude-code-adapter.ts";
export type { ClaudeCodeTokenTotals, ParsedClaudeCodeSession } from "./claude-code-adapter.ts";

export type Task = {
  id: string;
  title: string;
  createdAt: string;
};

export type SessionTool = "claude" | "codex";

export type Session = {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  taskId: string | null;
  createdAt: string;
};

export type RegisterSessionInput = {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
};

export type TaskStore = {
  createTask(title: string): Task;
  getTask(id: string): Task | null;
  listTasks(): Task[];
  registerSession(input: RegisterSessionInput): Session;
  assignSession(sessionId: string, taskId: string): Session;
  listUnassignedSessions(): Session[];
  listSessionsForTask(taskId: string): Session[];
  close(): void;
};

type TaskRow = {
  id: string;
  title: string;
  created_at: string;
};

type SessionRow = {
  id: string;
  transcript_path: string;
  tool: SessionTool;
  task_id: string | null;
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
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        transcript_path TEXT NOT NULL,
        tool TEXT NOT NULL CHECK (tool IN ('claude', 'codex')),
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
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

  registerSession(input: RegisterSessionInput): Session {
    const id = input.id.trim();
    const transcriptPath = input.transcriptPath.trim();

    if (id.length === 0) {
      throw new Error("Session id is required");
    }

    if (transcriptPath.length === 0) {
      throw new Error("Session transcript path is required");
    }

    if (input.tool !== "claude" && input.tool !== "codex") {
      throw new Error("Session tool must be claude or codex");
    }

    const existing = this.getSession(id);

    if (existing) {
      return existing;
    }

    const session: Session = {
      id,
      transcriptPath,
      tool: input.tool,
      taskId: null,
      createdAt: new Date().toISOString(),
    };

    this.#database
      .prepare(
        "INSERT INTO sessions (id, transcript_path, tool, task_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(session.id, session.transcriptPath, session.tool, session.taskId, session.createdAt);

    return session;
  }

  assignSession(sessionId: string, taskId: string): Session {
    const session = this.getSession(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const task = this.getTask(taskId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    this.#database.prepare("UPDATE sessions SET task_id = ? WHERE id = ?").run(task.id, session.id);

    return { ...session, taskId: task.id };
  }

  listUnassignedSessions(): Session[] {
    return this.#database
      .prepare(
        "SELECT id, transcript_path, tool, task_id, created_at FROM sessions WHERE task_id IS NULL ORDER BY created_at ASC, id ASC",
      )
      .all()
      .map((row) => sessionFromRow(row as SessionRow));
  }

  listSessionsForTask(taskId: string): Session[] {
    return this.#database
      .prepare(
        "SELECT id, transcript_path, tool, task_id, created_at FROM sessions WHERE task_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(taskId)
      .map((row) => sessionFromRow(row as SessionRow));
  }

  close(): void {
    this.#database.close();
  }

  private getSession(id: string): Session | null {
    const row = this.#database
      .prepare("SELECT id, transcript_path, tool, task_id, created_at FROM sessions WHERE id = ?")
      .get(id);

    return row ? sessionFromRow(row as SessionRow) : null;
  }
}

function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
  };
}

function sessionFromRow(row: SessionRow): Session {
  return {
    id: row.id,
    transcriptPath: row.transcript_path,
    tool: row.tool,
    taskId: row.task_id,
    createdAt: row.created_at,
  };
}
