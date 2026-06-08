import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrationJournal, migrationSqlByTag } from "./migrations.ts";
import {
  generatePlaceholderSlug,
  humanizeSlug,
  looksLikeSlug,
  looksLikeTaskId,
  slugify,
} from "./slug.ts";
import { listNativeTaskDocs, mergeTaskDocs } from "./task-docs.ts";
import {
  addTokenTotals,
  emptyTokenTotals,
  tokenTotalsFromUsage,
} from "./token-totals.ts";
import { getTranscriptAdapter } from "./transcript-adapter.ts";
import type {
  ActiveTask,
  RecallCandidate,
  RegisterSessionInput,
  ReEntryManifest,
  Session,
  Task,
  TaskDoc,
  TaskStore,
  TaskSummary,
  TaskTimeline,
  TaskTimelineItem,
  TokenTotals,
} from "./types.ts";

export function openTraceStore(databasePath: string): TaskStore {
  return new NodeSqliteTaskStore(databasePath);
}

export { resolveTaskDocsDir } from "./task-docs.ts";

class NodeSqliteTaskStore implements TaskStore {
  readonly #sqlite: DatabaseSync;
  readonly #databasePath: string;

  constructor(databasePath: string) {
    const resolvedPath = resolve(databasePath);
    this.#databasePath = resolvedPath;
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.#sqlite = new DatabaseSync(resolvedPath);
    this.#sqlite.exec("PRAGMA journal_mode = WAL");
    this.#sqlite.exec("PRAGMA foreign_keys = ON");
    applyMigrations(this.#sqlite);
    this.#backfillSlugs();
  }

  createTask(title: string, projectRoot = "", description?: string): Task {
    const trimmedTitle = title.trim();
    // A title that reads as a slug ("break-stop-and-stale-expiry") becomes a
    // readable title; slugify round-trips it back, so the original string
    // still serves as the slug.
    const normalizedTitle = looksLikeSlug(trimmedTitle)
      ? humanizeSlug(trimmedTitle)
      : trimmedTitle;
    const normalizedProjectRoot = projectRoot.trim();
    const normalizedDescription = description?.trim() || undefined;

    const id = randomUUID();
    const task: Task = {
      id,
      title: normalizedTitle,
      slug: this.#allocateSlug(slugify(normalizedTitle), id),
      createdAt: new Date().toISOString(),
      projectRoot: normalizedProjectRoot,
      archivedAt: null,
    };
    if (normalizedDescription) task.description = normalizedDescription;

    this.#sqlite
      .prepare(
        `
          INSERT INTO tasks (id, title, slug, created_at, project_root, archived_at, description)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        task.id,
        task.title,
        task.slug,
        task.createdAt,
        task.projectRoot,
        task.archivedAt,
        task.description ?? null,
      );

    return task;
  }

  getTask(id: string): Task | null {
    const row = this.#sqlite
      .prepare(
        "SELECT id, title, slug, created_at, project_root, archived_at, description FROM tasks WHERE id = ?",
      )
      .get(id);
    return row ? taskFromRow(row as TaskRow) : null;
  }

  getTaskByRef(ref: string): Task | null {
    const trimmed = ref.trim();
    if (trimmed.length === 0) return null;

    const byId = this.getTask(trimmed);
    if (byId) return byId;

    const row = this.#sqlite
      .prepare(
        "SELECT id, title, slug, created_at, project_root, archived_at, description FROM tasks WHERE slug = ?",
      )
      .get(trimmed);
    return row ? taskFromRow(row as TaskRow) : null;
  }

  listTasks(): Task[] {
    return this.#sqlite
      .prepare(
        `
          SELECT id, title, slug, created_at, project_root, archived_at, description
          FROM tasks
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all()
      .map((row) => taskFromRow(row as TaskRow));
  }

  listTaskSummaries(): TaskSummary[] {
    return this.listTasks().map((task) => {
      const sessions = this.listSessionsForTask(task.id);
      const docs = this.listDocsForTask(task.id);

      const lastActivityAt = [
        ...sessions.map((session) => session.createdAt),
        ...docs.map((doc) => doc.createdAt),
      ].reduce(
        (latest, current) => (current > latest ? current : latest),
        task.createdAt,
      );

      const tokenTotals = sessions.reduce(
        (totals, session) => addTokenTotals(totals, session.tokenTotals),
        emptyTokenTotals(),
      );

      return { ...task, lastActivityAt, tokenTotals };
    });
  }

  recallCandidates(projectRoot: string): RecallCandidate[] {
    const rows = this.#sqlite
      .prepare(
        `
          SELECT title, slug, description
          FROM tasks
          WHERE project_root = ? AND archived_at IS NULL
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(projectRoot.trim()) as Array<{
      title: string;
      slug: string;
      description: string | null;
    }>;

    return rows.map((row) => {
      const candidate: RecallCandidate = { title: row.title, slug: row.slug };
      if (row.description != null) candidate.description = row.description;
      return candidate;
    });
  }

  // Resolve the active task for a session in a project, encapsulating the
  // "session binding first, project recency fallback" rule behind one call so
  // the SessionStart hook stays a thin caller. A session already bound to an
  // unarchived task wins (positive case). Otherwise — unbound, or bound to a
  // task that has since been archived or deleted — the project's most recent
  // unarchived task is offered for re-entry, falling through to `none` when the
  // project has no task to bind to yet.
  resolveActiveTask(sessionId: string, projectRoot: string): ActiveTask {
    const session = this.getSession(sessionId);
    if (session?.taskId) {
      const bound = this.getTask(session.taskId);
      if (bound && !bound.archivedAt) {
        return { kind: "bound", task: bound };
      }
    }

    const recent = this.#mostRecentTask(projectRoot);
    return recent ? { kind: "re-enter", task: recent } : { kind: "none" };
  }

  #mostRecentTask(projectRoot: string): Task | null {
    const row = this.#sqlite
      .prepare(
        `
          SELECT id, title, slug, created_at, project_root, archived_at, description
          FROM tasks
          WHERE project_root = ? AND archived_at IS NULL
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `,
      )
      .get(projectRoot.trim());
    return row ? taskFromRow(row as TaskRow) : null;
  }

  updateTaskDescription(ref: string, description: string): Task {
    const task = this.getTaskByRef(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);

    const normalizedDescription = description.trim() || undefined;
    this.#sqlite
      .prepare("UPDATE tasks SET description = ? WHERE id = ?")
      .run(normalizedDescription ?? null, task.id);

    const updated: Task = { ...task };
    if (normalizedDescription) updated.description = normalizedDescription;
    else delete updated.description;
    return updated;
  }

  archiveTask(ref: string): Task {
    const task = this.getTaskByRef(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);

    const archivedAt = new Date().toISOString();
    this.#sqlite
      .prepare("UPDATE tasks SET archived_at = ? WHERE id = ?")
      .run(archivedAt, task.id);

    return { ...task, archivedAt };
  }

  unarchiveTask(ref: string): Task {
    const task = this.getTaskByRef(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);

    this.#sqlite
      .prepare("UPDATE tasks SET archived_at = NULL WHERE id = ?")
      .run(task.id);

    return { ...task, archivedAt: null };
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

    this.#sqlite
      .prepare(
        `
          INSERT INTO sessions (
            id,
            transcript_path,
            tool,
            model,
            task_id,
            created_at,
            input_tokens,
            output_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
            total_tokens
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        session.id,
        session.transcriptPath,
        session.tool,
        session.model,
        session.taskId,
        session.createdAt,
        totals.inputTokens,
        totals.outputTokens,
        totals.cacheCreationInputTokens,
        totals.cacheReadInputTokens,
        totals.totalTokens,
      );

    return session;
  }

  assignSession(sessionId: string, taskId: string): Session {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const task = this.getTaskByRef(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    this.#sqlite
      .prepare("UPDATE sessions SET task_id = ? WHERE id = ?")
      .run(task.id, session.id);

    return { ...session, taskId: task.id };
  }

  listUnassignedSessions(): Session[] {
    return this.#sqlite
      .prepare(
        `
          SELECT *
          FROM sessions
          WHERE task_id IS NULL
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all()
      .map((row) => this.#refreshSession(sessionFromRow(row as SessionRow)));
  }

  listSessionsForTask(taskId: string): Session[] {
    return this.#sqlite
      .prepare(
        `
          SELECT *
          FROM sessions
          WHERE task_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(taskId)
      .map((row) => this.#refreshSession(sessionFromRow(row as SessionRow)));
  }

  getTaskTimeline(taskId: string): TaskTimeline | null {
    const task = this.getTaskByRef(taskId);
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
    const task = this.getTaskByRef(taskId);
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
        // Description stays optional/absent (never null), matching the Task
        // convention — only surface the key when the task actually has one.
        ...(task.description ? { description: task.description } : {}),
      },
      docs: this.listDocsForTask(task.id),
      sessions,
    };
  }

  addTaskDoc(taskId: string, path: string): TaskDoc {
    const task = this.getTaskByRef(taskId);
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

    this.#sqlite
      .prepare(
        `
          INSERT INTO task_docs (task_id, path, created_at)
          VALUES (?, ?, ?)
        `,
      )
      .run(doc.taskId, doc.path, doc.createdAt);
    return doc;
  }

  listDocsForTask(taskId: string): TaskDoc[] {
    const task = this.getTaskByRef(taskId);
    const id = task?.id ?? taskId;

    const registeredDocs = this.#sqlite
      .prepare(
        `
          SELECT task_id, path, created_at
          FROM task_docs
          WHERE task_id = ?
          ORDER BY created_at ASC, path ASC
        `,
      )
      .all(id)
      .map((row) => taskDocFromRow(row as TaskDocRow));

    return mergeTaskDocs(
      registeredDocs,
      task?.slug
        ? listNativeTaskDocs(this.#databasePath, id, task.slug)
        : [],
    );
  }

  removeTaskDoc(taskId: string, path: string): void {
    this.#sqlite
      .prepare("DELETE FROM task_docs WHERE task_id = ? AND path = ?")
      .run(taskId, path.trim());
  }

  close(): void {
    this.#sqlite.close();
  }

  getSession(id: string): Session | null {
    const row = this.#sqlite
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id);
    if (!row) return null;
    return this.#refreshSession(sessionFromRow(row as SessionRow));
  }

  #refreshSession(session: Session): Session {
    let fresh: { tokenTotals: TokenTotals; model: string | null } | null = null;
    try {
      const adapter = getTranscriptAdapter(session.tool);
      const parsed = adapter.parseFile(session.transcriptPath, {
        expectedId: session.id,
      });
      fresh = { tokenTotals: parsed.tokenTotals, model: parsed.model };
    } catch {
      // Missing file or unparseable transcript — return stored values untouched.
      return session;
    }

    const totals = fresh.tokenTotals;
    const stored = session.tokenTotals;
    const changed =
      totals.inputTokens !== stored.inputTokens ||
      totals.outputTokens !== stored.outputTokens ||
      totals.cacheCreationInputTokens !== stored.cacheCreationInputTokens ||
      totals.cacheReadInputTokens !== stored.cacheReadInputTokens ||
      totals.totalTokens !== stored.totalTokens;

    if (changed) {
      this.#sqlite
        .prepare(
          `
            UPDATE sessions
            SET
              input_tokens = ?,
              output_tokens = ?,
              cache_creation_input_tokens = ?,
              cache_read_input_tokens = ?,
              total_tokens = ?
            WHERE id = ?
          `,
        )
        .run(
          totals.inputTokens,
          totals.outputTokens,
          totals.cacheCreationInputTokens,
          totals.cacheReadInputTokens,
          totals.totalTokens,
          session.id,
        );
    }

    return { ...session, tokenTotals: totals };
  }

  // Reserve a unique slug. An empty base (untitled task or a title that left
  // nothing slug-worthy) falls back to a placeholder derived from the id, as
  // does a base that reads as a UUID (it would shadow id lookups in
  // getTaskByRef); otherwise collisions get a numeric suffix.
  #allocateSlug(base: string, id: string): string {
    const candidate =
      base.length > 0 && !looksLikeTaskId(base)
        ? base
        : generatePlaceholderSlug(id);

    if (!this.#slugExists(candidate)) {
      return candidate;
    }

    for (let suffix = 2; ; suffix += 1) {
      const next = `${candidate}-${suffix}`;
      if (!this.#slugExists(next)) {
        return next;
      }
    }
  }

  #slugExists(slug: string): boolean {
    const row = this.#sqlite
      .prepare("SELECT 1 FROM tasks WHERE slug = ? LIMIT 1")
      .get(slug);
    return row !== undefined;
  }

  // After migrations, any task row missing a slug (rows that predate the slug
  // column) is backfilled deterministically by creation order so suffixing is
  // stable, then locked in by the unique index.
  #backfillSlugs(): void {
    const rows = this.#sqlite
      .prepare(
        `
          SELECT id, title
          FROM tasks
          WHERE slug IS NULL
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all() as { id: string; title: string }[];

    if (rows.length === 0) return;

    const update = this.#sqlite.prepare(
      "UPDATE tasks SET slug = ? WHERE id = ?",
    );
    for (const row of rows) {
      const slug = this.#allocateSlug(slugify(row.title.trim()), row.id);
      update.run(slug, row.id);
    }
  }

  private getTaskDoc(taskId: string, path: string): TaskDoc | null {
    const row = this.#sqlite
      .prepare(
        `
          SELECT task_id, path, created_at
          FROM task_docs
          WHERE task_id = ? AND path = ?
        `,
      )
      .get(taskId, path);
    return row ? taskDocFromRow(row as TaskDocRow) : null;
  }
}

function applyMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);

  const lastMigration = database
    .prepare(
      `
        SELECT created_at
        FROM "__drizzle_migrations"
        ORDER BY created_at DESC
        LIMIT 1
      `,
    )
    .get() as { created_at: number | null } | undefined;
  const lastAppliedAt = Number(lastMigration?.created_at ?? 0);
  database.exec("BEGIN");
  try {
    for (const entry of migrationJournal.entries) {
      if (lastAppliedAt >= entry.when) continue;

      const migrationSql = migrationSqlByTag[entry.tag];
      if (!migrationSql) {
        throw new Error(`Missing migration SQL for ${entry.tag}`);
      }
      for (const statement of splitMigrationStatements(
        migrationSql,
        entry.breakpoints,
      )) {
        database.exec(statement);
      }
      database
        .prepare(
          'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
        )
        .run(hashMigration(migrationSql), entry.when);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function splitMigrationStatements(sql: string, breakpoints: boolean): string[] {
  if (breakpoints) {
    return sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
  }

  const statement = sql.trim();
  return statement.length > 0 ? [statement] : [];
}

function hashMigration(sql: string): string {
  return `${sql.length}:${sql}`;
}

type TaskRow = {
  id: string;
  title: string;
  slug: string;
  created_at: string;
  project_root: string;
  archived_at: string | null;
  description: string | null;
};

type SessionRow = {
  id: string;
  transcript_path: string;
  tool: "claude" | "codex";
  model: string | null;
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

function taskFromRow(row: TaskRow): Task {
  const task: Task = {
    id: row.id,
    title: row.title,
    slug: row.slug,
    createdAt: row.created_at,
    projectRoot: row.project_root,
    archivedAt: row.archived_at,
  };
  // A null column means the task was created without a description; keep the
  // field absent rather than carrying a null so round-trips stay clean.
  if (row.description != null) task.description = row.description;
  return task;
}

function sessionFromRow(row: SessionRow): Session {
  return {
    id: row.id,
    transcriptPath: row.transcript_path,
    tool: row.tool,
    model: row.model,
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
