import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sessions, taskDocs, tasks } from "./schema.ts";
import { migrationsDir } from "./migrations-path.ts";
import {
  addTokenTotals,
  emptyTokenTotals,
  tokenTotalsFromUsage,
} from "./token-totals.ts";
import type {
  RegisterSessionInput,
  ReEntryManifest,
  Session,
  Task,
  TaskDoc,
  TaskStore,
  TaskTimeline,
  TaskTimelineItem,
} from "./types.ts";

export function openTraceStore(databasePath: string): TaskStore {
  return new DrizzleTaskStore(databasePath);
}

export function resolveTaskDocsDir(
  databasePath: string,
  taskId: string,
): string {
  return join(dirname(resolve(databasePath)), "tasks", taskId, "docs");
}

class DrizzleTaskStore implements TaskStore {
  readonly #sqlite: Database.Database;
  readonly #db: BetterSQLite3Database;
  readonly #databasePath: string;

  constructor(databasePath: string) {
    const resolvedPath = resolve(databasePath);
    this.#databasePath = resolvedPath;
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
    const model = input.model?.trim() || null;

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

    const totals = tokenTotalsFromUsage(input.tokenTotals);
    const session: Session = {
      id,
      transcriptPath,
      tool: input.tool,
      model,
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
        model: session.model,
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
        emptyTokenTotals(),
      ),
    };
  }

  getReEntryManifest(taskId: string): ReEntryManifest | null {
    const task = this.getTask(taskId);
    if (!task) return null;

    const sessions = this.listSessionsForTask(task.id)
      .slice()
      .sort(compareSessionsNewestFirst)
      .map((session, index) => ({
        id: session.id,
        transcriptPath: session.transcriptPath,
        tool: session.tool,
        model: session.model,
        createdAt: session.createdAt,
        isMostRecent: index === 0,
      }));

    return {
      task: {
        id: task.id,
        title: task.title,
        projectRoot: task.projectRoot,
      },
      docs: this.listDocsForTask(task.id),
      sessions,
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
    const registeredDocs = this.#db
      .select()
      .from(taskDocs)
      .where(eq(taskDocs.taskId, taskId))
      .orderBy(asc(taskDocs.createdAt), asc(taskDocs.path))
      .all();
    const docsByPath = new Map<string, TaskDoc>();

    for (const doc of registeredDocs) {
      docsByPath.set(doc.path, doc);
    }

    for (const doc of listNativeTaskDocs(this.#databasePath, taskId)) {
      if (!docsByPath.has(doc.path)) {
        docsByPath.set(doc.path, doc);
      }
    }

    return [...docsByPath.values()].sort((left, right) => {
      const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
      if (byCreatedAt !== 0) return byCreatedAt;
      return left.path.localeCompare(right.path);
    });
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

  getSession(id: string): Session | null {
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

function listNativeTaskDocs(databasePath: string, taskId: string): TaskDoc[] {
  const docsDir = resolveTaskDocsDir(databasePath, taskId);

  try {
    return readdirSync(docsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(docsDir, entry.name);
        return {
          taskId,
          path,
          createdAt: statSync(path).mtime.toISOString(),
        };
      });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }
}

type SessionRow = typeof sessions.$inferSelect;

function sessionFromRow(row: SessionRow): Session {
  return {
    id: row.id,
    transcriptPath: row.transcriptPath,
    tool: row.tool,
    model: row.model,
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

function compareSessionsNewestFirst(left: Session, right: Session): number {
  const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return right.id.localeCompare(left.id);
}
