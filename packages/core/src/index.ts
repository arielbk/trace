import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export {
  parseClaudeCodeTranscript,
  parseClaudeCodeTranscriptFile,
} from "./claude-code-adapter.ts";
export type {
  ClaudeCodeTokenTotals,
  ParsedClaudeCodeSession,
} from "./claude-code-adapter.ts";
export {
  parseCodexTranscript,
  parseCodexTranscriptFile,
  scanCodexSessions,
} from "./codex-adapter.ts";
export type { CodexTokenTotals, ParsedCodexSession } from "./codex-adapter.ts";

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
  tokenTotals: TokenTotals;
};

export type TaskDoc = {
  taskId: string;
  path: string;
  createdAt: string;
};

export type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
};

export type TaskTimelineItem =
  | {
      type: "session";
      createdAt: string;
      session: Session;
    }
  | {
      type: "doc";
      createdAt: string;
      doc: TaskDoc;
    };

export type TaskTimeline = {
  task: Task;
  items: TaskTimelineItem[];
  tokenTotals: TokenTotals;
};

export type RegisterSessionInput = {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  tokenTotals?: Partial<TokenTotals>;
};

export type TaskStore = {
  createTask(title: string): Task;
  getTask(id: string): Task | null;
  listTasks(): Task[];
  registerSession(input: RegisterSessionInput): Session;
  assignSession(sessionId: string, taskId: string): Session;
  listUnassignedSessions(): Session[];
  listSessionsForTask(taskId: string): Session[];
  getTaskTimeline(taskId: string): TaskTimeline | null;
  addTaskDoc(taskId: string, path: string): TaskDoc;
  listDocsForTask(taskId: string): TaskDoc[];
  removeTaskDoc(taskId: string, path: string): void;
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
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_tokens: number;
};

type TaskDocRow = {
  task_id: string;
  path: string;
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
    this.ensureSessionTokenColumns();
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS task_docs (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, path)
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
    const row = this.#database
      .prepare("SELECT id, title, created_at FROM tasks WHERE id = ?")
      .get(id);

    return row ? taskFromRow(row as TaskRow) : null;
  }

  listTasks(): Task[] {
    return this.#database
      .prepare(
        "SELECT id, title, created_at FROM tasks ORDER BY created_at ASC, id ASC",
      )
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
      tokenTotals: normalizeTokenTotals(input.tokenTotals),
    };

    this.#database
      .prepare(
        `INSERT INTO sessions (
          id,
          transcript_path,
          tool,
          task_id,
          created_at,
          input_tokens,
          output_tokens,
          cache_creation_input_tokens,
          cache_read_input_tokens,
          total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.transcriptPath,
        session.tool,
        session.taskId,
        session.createdAt,
        session.tokenTotals.inputTokens,
        session.tokenTotals.outputTokens,
        session.tokenTotals.cacheCreationInputTokens,
        session.tokenTotals.cacheReadInputTokens,
        session.tokenTotals.totalTokens,
      );

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

    this.#database
      .prepare("UPDATE sessions SET task_id = ? WHERE id = ?")
      .run(task.id, session.id);

    return { ...session, taskId: task.id };
  }

  listUnassignedSessions(): Session[] {
    return this.#database
      .prepare(
        "SELECT id, transcript_path, tool, task_id, created_at, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens FROM sessions WHERE task_id IS NULL ORDER BY created_at ASC, id ASC",
      )
      .all()
      .map((row) => sessionFromRow(row as SessionRow));
  }

  listSessionsForTask(taskId: string): Session[] {
    return this.#database
      .prepare(
        "SELECT id, transcript_path, tool, task_id, created_at, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens FROM sessions WHERE task_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(taskId)
      .map((row) => sessionFromRow(row as SessionRow));
  }

  getTaskTimeline(taskId: string): TaskTimeline | null {
    const task = this.getTask(taskId);

    if (!task) {
      return null;
    }

    const sessions = this.listSessionsForTask(task.id);
    const docs = this.listDocsForTask(task.id);
    const items: TaskTimelineItem[] = [
      ...sessions.map(
        (session): TaskTimelineItem => ({
          type: "session",
          createdAt: session.createdAt,
          session,
        }),
      ),
      ...docs.map(
        (doc): TaskTimelineItem => ({
          type: "doc",
          createdAt: doc.createdAt,
          doc,
        }),
      ),
    ].sort(compareTimelineItems);

    return {
      task,
      items,
      tokenTotals: sessions.reduce(
        (totals, session) => addTokenTotals(totals, session.tokenTotals),
        normalizeTokenTotals(),
      ),
    };
  }

  addTaskDoc(taskId: string, path: string): TaskDoc {
    const task = this.getTask(taskId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const normalizedPath = path.trim();

    if (normalizedPath.length === 0) {
      throw new Error("Task doc path is required");
    }

    const existing = this.getTaskDoc(task.id, normalizedPath);

    if (existing) {
      return existing;
    }

    const doc: TaskDoc = {
      taskId: task.id,
      path: normalizedPath,
      createdAt: new Date().toISOString(),
    };

    this.#database
      .prepare(
        "INSERT INTO task_docs (task_id, path, created_at) VALUES (?, ?, ?)",
      )
      .run(doc.taskId, doc.path, doc.createdAt);

    return doc;
  }

  listDocsForTask(taskId: string): TaskDoc[] {
    return this.#database
      .prepare(
        "SELECT task_id, path, created_at FROM task_docs WHERE task_id = ? ORDER BY created_at ASC, path ASC",
      )
      .all(taskId)
      .map((row) => taskDocFromRow(row as TaskDocRow));
  }

  removeTaskDoc(taskId: string, path: string): void {
    this.#database
      .prepare("DELETE FROM task_docs WHERE task_id = ? AND path = ?")
      .run(taskId, path.trim());
  }

  close(): void {
    this.#database.close();
  }

  private getSession(id: string): Session | null {
    const row = this.#database
      .prepare(
        "SELECT id, transcript_path, tool, task_id, created_at, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens FROM sessions WHERE id = ?",
      )
      .get(id);

    return row ? sessionFromRow(row as SessionRow) : null;
  }

  private getTaskDoc(taskId: string, path: string): TaskDoc | null {
    const row = this.#database
      .prepare(
        "SELECT task_id, path, created_at FROM task_docs WHERE task_id = ? AND path = ?",
      )
      .get(taskId, path);

    return row ? taskDocFromRow(row as TaskDocRow) : null;
  }

  private ensureSessionTokenColumns(): void {
    const columns = new Set(
      this.#database
        .prepare("PRAGMA table_info(sessions)")
        .all()
        .map((row) => (row as { name: string }).name),
    );

    const tokenColumns: Array<[string, string]> = [
      ["input_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["output_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["cache_creation_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["cache_read_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["total_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ];

    for (const [name, definition] of tokenColumns) {
      if (!columns.has(name)) {
        this.#database.exec(
          `ALTER TABLE sessions ADD COLUMN ${name} ${definition}`,
        );
      }
    }
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
    tokenTotals: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens,
      cacheReadInputTokens: row.cache_read_input_tokens,
      totalTokens: row.total_tokens,
    },
  };
}

function taskDocFromRow(row: TaskDocRow): TaskDoc {
  return {
    taskId: row.task_id,
    path: row.path,
    createdAt: row.created_at,
  };
}

function normalizeTokenTotals(input: Partial<TokenTotals> = {}): TokenTotals {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const cacheCreationInputTokens = input.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens = input.cacheReadInputTokens ?? 0;

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens:
      input.totalTokens ??
      inputTokens +
        outputTokens +
        cacheCreationInputTokens +
        cacheReadInputTokens,
  };
}

function addTokenTotals(left: TokenTotals, right: TokenTotals): TokenTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheCreationInputTokens:
      left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    cacheReadInputTokens:
      left.cacheReadInputTokens + right.cacheReadInputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function compareTimelineItems(
  left: TaskTimelineItem,
  right: TaskTimelineItem,
): number {
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);

  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }

  const leftKey =
    left.type === "session"
      ? `session:${left.session.id}`
      : `doc:${left.doc.path}`;
  const rightKey =
    right.type === "session"
      ? `session:${right.session.id}`
      : `doc:${right.doc.path}`;

  return leftKey.localeCompare(rightKey);
}
