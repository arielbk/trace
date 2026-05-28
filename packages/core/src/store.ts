import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sessions, taskDocs, tasks } from "./schema.ts";
import { migrationsDir } from "./migrations-path.ts";
import type {
  RegisterSessionInput,
  Session,
  Task,
  TaskDoc,
  TaskStore,
  TaskTimeline,
  TaskTimelineItem,
  TokenTotals,
} from "./types.ts";

export function openTraceStore(databasePath: string): TaskStore {
  return new DrizzleTaskStore(databasePath);
}

class DrizzleTaskStore implements TaskStore {
  readonly #sqlite: Database.Database;
  readonly #db: BetterSQLite3Database;

  constructor(databasePath: string) {
    const resolvedPath = resolve(databasePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.#sqlite = new Database(resolvedPath);
    this.#sqlite.pragma("journal_mode = WAL");
    this.#sqlite.pragma("foreign_keys = ON");
    this.#db = drizzle(this.#sqlite);
    migrate(this.#db, { migrationsFolder: migrationsDir });
  }

  createTask(title: string, projectRoot = ""): Task {
    const normalizedTitle = title.trim();
    const normalizedProjectRoot = projectRoot.trim();

    if (normalizedTitle.length === 0) {
      throw new Error("Task title is required");
    }

    const task: Task = {
      id: randomUUID(),
      title: normalizedTitle,
      createdAt: new Date().toISOString(),
      projectRoot: normalizedProjectRoot,
    };

    this.#db.insert(tasks).values(task).run();

    return task;
  }

  getTask(id: string): Task | null {
    const row = this.#db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ?? null;
  }

  listTasks(): Task[] {
    return this.#db
      .select()
      .from(tasks)
      .orderBy(asc(tasks.createdAt), asc(tasks.id))
      .all();
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
    if (existing) return existing;

    const totals = normalizeTokenTotals(input.tokenTotals);
    const session: Session = {
      id,
      transcriptPath,
      tool: input.tool,
      taskId: null,
      createdAt: new Date().toISOString(),
      tokenTotals: totals,
    };

    this.#db
      .insert(sessions)
      .values({
        id: session.id,
        transcriptPath: session.transcriptPath,
        tool: session.tool,
        taskId: session.taskId,
        createdAt: session.createdAt,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheCreationInputTokens: totals.cacheCreationInputTokens,
        cacheReadInputTokens: totals.cacheReadInputTokens,
        totalTokens: totals.totalTokens,
      })
      .run();

    return session;
  }

  assignSession(sessionId: string, taskId: string): Session {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    this.#db
      .update(sessions)
      .set({ taskId: task.id })
      .where(eq(sessions.id, session.id))
      .run();

    return { ...session, taskId: task.id };
  }

  listUnassignedSessions(): Session[] {
    return this.#db
      .select()
      .from(sessions)
      .where(isNull(sessions.taskId))
      .orderBy(asc(sessions.createdAt), asc(sessions.id))
      .all()
      .map(sessionFromRow);
  }

  listSessionsForTask(taskId: string): Session[] {
    return this.#db
      .select()
      .from(sessions)
      .where(eq(sessions.taskId, taskId))
      .orderBy(asc(sessions.createdAt), asc(sessions.id))
      .all()
      .map(sessionFromRow);
  }

  getTaskTimeline(taskId: string): TaskTimeline | null {
    const task = this.getTask(taskId);
    if (!task) return null;

    const sessionList = this.listSessionsForTask(task.id);
    const docs = this.listDocsForTask(task.id);
    const items: TaskTimelineItem[] = [
      ...sessionList.map(
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
      tokenTotals: sessionList.reduce(
        (totals, session) => addTokenTotals(totals, session.tokenTotals),
        normalizeTokenTotals(),
      ),
    };
  }

  addTaskDoc(taskId: string, path: string): TaskDoc {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const normalizedPath = path.trim();
    if (normalizedPath.length === 0) {
      throw new Error("Task doc path is required");
    }

    const existing = this.getTaskDoc(task.id, normalizedPath);
    if (existing) return existing;

    const doc: TaskDoc = {
      taskId: task.id,
      path: normalizedPath,
      createdAt: new Date().toISOString(),
    };

    this.#db.insert(taskDocs).values(doc).run();
    return doc;
  }

  listDocsForTask(taskId: string): TaskDoc[] {
    return this.#db
      .select()
      .from(taskDocs)
      .where(eq(taskDocs.taskId, taskId))
      .orderBy(asc(taskDocs.createdAt), asc(taskDocs.path))
      .all();
  }

  removeTaskDoc(taskId: string, path: string): void {
    this.#db
      .delete(taskDocs)
      .where(and(eq(taskDocs.taskId, taskId), eq(taskDocs.path, path.trim())))
      .run();
  }

  close(): void {
    this.#sqlite.close();
  }

  private getSession(id: string): Session | null {
    const row = this.#db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    return row ? sessionFromRow(row) : null;
  }

  private getTaskDoc(taskId: string, path: string): TaskDoc | null {
    const row = this.#db
      .select()
      .from(taskDocs)
      .where(and(eq(taskDocs.taskId, taskId), eq(taskDocs.path, path)))
      .get();
    return row ?? null;
  }
}

type SessionRow = typeof sessions.$inferSelect;

function sessionFromRow(row: SessionRow): Session {
  return {
    id: row.id,
    transcriptPath: row.transcriptPath,
    tool: row.tool,
    taskId: row.taskId,
    createdAt: row.createdAt,
    tokenTotals: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      cacheReadInputTokens: row.cacheReadInputTokens,
      totalTokens: row.totalTokens,
    },
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
  if (byCreatedAt !== 0) return byCreatedAt;

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
