import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { resolveCodexTranscriptPathById } from "./codex-adapter.ts";
import { registerCodexSubagentSpawn } from "./codex-subagent-discovery.ts";
import {
  discoverCursorSubagentSessions,
  listCursorSubagentChatIds,
  resolveCursorSubagentsDir,
} from "./cursor-subagent-discovery.ts";
import { migrationJournal, migrationSqlByTag } from "./migrations.ts";
import { getDatabaseSync, type DatabaseSync } from "./node-sqlite.ts";
import {
  readProjectFingerprints,
  type ProjectFingerprints,
} from "./project-fingerprint.ts";
import {
  generatePlaceholderSlug,
  humanizeSlug,
  looksLikeSlug,
  looksLikeTaskId,
  slugify,
} from "./slug.ts";
import {
  listNativeTaskDocs,
  mergeTaskDocs,
  resolveTaskDocsDir,
} from "./task-docs.ts";
import {
  addTokenTotals,
  emptyTokenTotals,
  tokenTotalsFromUsage,
} from "./token-totals.ts";
import { resolveSessionName } from "./session-name.ts";
import { parseStateMd } from "./state-parser.ts";
import {
  computeDocsFingerprint,
  hasProseBody,
  readProseFingerprint,
} from "./prose-fingerprint.ts";
import {
  getTranscriptAdapter,
  type ParsedTranscript,
} from "./transcript-adapter.ts";
import { isSessionTool } from "./types.ts";
import { isSyntheticLocator, syntheticLocator } from "./transcript-locator.ts";
import type {
  ActiveTask,
  AddTaskDocOptions,
  Project,
  ProjectMergeResult,
  ProjectResolution,
  RecallCandidate,
  RegisterSessionInput,
  ReEntryManifest,
  Session,
  SessionOrigin,
  SetSessionParentInput,
  SessionTool,
  Task,
  TaskDoc,
  TaskStore,
  TaskSummary,
  TaskTimeline,
  TaskTimelineItem,
  TokenTotals,
  UpdateTaskDocOptions,
} from "./types.ts";
import { compareSyncRows, type SyncPayload } from "./sync.ts";

// Filesystem roots read-time subagent discovery resolves against; both default
// to the tools' real homes and exist as options so tests can point the store at
// fixtures.
export type TraceStoreOptions = {
  codexHome?: string;
  cursorProjectsRoot?: string;
};

export function openTraceStore(
  databasePath: string,
  options?: TraceStoreOptions,
): TaskStore {
  return new NodeSqliteTaskStore(databasePath, options);
}

export { resolveTaskDocsDir };

// Agent-facing listings sort by "last activity" — the latest of the task's
// creation, its newest bound session, and its newest doc — so the agent
// reaches for current-focus work first. Timestamps are ISO strings, so
// lexicographic MAX is chronological.
const LAST_ACTIVITY_JOINS = `
  LEFT JOIN (
    SELECT task_id, MAX(created_at) AS last_session_at
    FROM sessions WHERE task_id IS NOT NULL GROUP BY task_id
  ) s ON s.task_id = t.id
  LEFT JOIN (
    SELECT task_id, MAX(created_at) AS last_doc_at
    FROM task_docs GROUP BY task_id
  ) d ON d.task_id = t.id
`;

const LAST_ACTIVITY_EXPR = `MAX(
  t.created_at,
  COALESCE(s.last_session_at, t.created_at),
  COALESCE(d.last_doc_at, t.created_at)
)`;

// Pinned tasks lead (pinned_at IS NULL sorts pinned rows' 0 before 1), then
// each partition orders by recency. rowid breaks same-millisecond ties.
const AGENT_ORDER_BY = `ORDER BY t.pinned_at IS NULL, ${LAST_ACTIVITY_EXPR} DESC, t.rowid DESC`;

class NodeSqliteTaskStore implements TaskStore {
  readonly #sqlite: DatabaseSync;
  readonly #databasePath: string;
  readonly #codexHome: string | undefined;
  readonly #cursorProjectsRoot: string | undefined;
  readonly #machineId: string;
  #lastUpdatedAt = "";

  constructor(databasePath: string, options?: TraceStoreOptions) {
    const resolvedPath = resolve(databasePath);
    this.#databasePath = resolvedPath;
    this.#codexHome = options?.codexHome;
    this.#cursorProjectsRoot = options?.cursorProjectsRoot;
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.#sqlite = new (getDatabaseSync())(resolvedPath);
    this.#sqlite.exec("PRAGMA journal_mode = WAL");
    this.#sqlite.exec("PRAGMA foreign_keys = ON");
    applyMigrations(this.#sqlite);
    const machineRow = this.#sqlite
      .prepare("SELECT value FROM sync_meta WHERE key = 'machine_id'")
      .get() as { value: string } | undefined;
    this.#machineId = machineRow?.value ?? randomUUID();
    if (!machineRow) {
      this.#sqlite
        .prepare("INSERT INTO sync_meta (key, value) VALUES ('machine_id', ?)")
        .run(this.#machineId);
    }
    this.#sqlite.prepare("UPDATE tasks SET machine_id = ? WHERE machine_id = ''").run(this.#machineId);
    this.#sqlite.prepare("UPDATE sessions SET machine_id = ? WHERE machine_id = ''").run(this.#machineId);
    this.#backfillSlugs();
    this.#backfillProjects();
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
    const project = this.resolveProject(normalizedProjectRoot).project;

    const id = randomUUID();
    const task: Task = {
      id,
      title: normalizedTitle,
      slug: this.#allocateSlug(slugify(normalizedTitle), id),
      createdAt: new Date().toISOString(),
      projectRoot: normalizedProjectRoot,
      projectId: project.id,
      archivedAt: null,
      pinnedAt: null,
    };
    if (normalizedDescription) task.description = normalizedDescription;

    this.#sqlite
      .prepare(
        `
          INSERT INTO tasks (id, title, slug, created_at, project_root, project_id, archived_at, description, pinned_at, updated_at, machine_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        task.id,
        task.title,
        task.slug,
        task.createdAt,
        task.projectRoot,
        task.projectId,
        task.archivedAt,
        task.description ?? null,
        task.pinnedAt,
        task.createdAt,
        this.#machineId,
      );

    return task;
  }

  getTask(id: string): Task | null {
    const row = this.#sqlite
      .prepare(
        "SELECT id, title, slug, created_at, project_root, project_id, archived_at, description, pinned_at FROM tasks WHERE id = ?",
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
        "SELECT id, title, slug, created_at, project_root, project_id, archived_at, description, pinned_at FROM tasks WHERE slug = ?",
      )
      .get(trimmed);
    return row ? taskFromRow(row as TaskRow) : null;
  }

  getProject(id: string): Project | null {
    const row = this.#sqlite
      .prepare(
        "SELECT id, slug, remote_url, root_commit, created_at, updated_at FROM projects WHERE id = ?",
      )
      .get(id);
    return row ? projectFromRow(row as ProjectRow) : null;
  }

  getProjectBySlug(slug: string): Project | null {
    const row = this.#sqlite
      .prepare(
        "SELECT id, slug, remote_url, root_commit, created_at, updated_at FROM projects WHERE slug = ?",
      )
      .get(slug.trim());
    return row ? projectFromRow(row as ProjectRow) : null;
  }

  getProjectByFingerprint(fingerprints: ProjectFingerprints): Project | null {
    const clauses: string[] = [];
    const values: string[] = [];
    if (fingerprints.remoteUrl) {
      clauses.push("remote_url = ?");
      values.push(fingerprints.remoteUrl);
    }
    if (fingerprints.rootCommit) {
      clauses.push("root_commit = ?");
      values.push(fingerprints.rootCommit);
    }
    if (clauses.length === 0) return null;

    const row = this.#sqlite
      .prepare(
        `SELECT id, slug, remote_url, root_commit, created_at, updated_at
         FROM projects
         WHERE ${clauses.join(" OR ")}
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
      )
      .get(...values);
    return row ? projectFromRow(row as ProjectRow) : null;
  }

  getProjectByRoot(rootPath: string): Project | null {
    const row = this.#sqlite
      .prepare(
        `SELECT p.id, p.slug, p.remote_url, p.root_commit, p.created_at, p.updated_at
         FROM project_roots pr
         JOIN projects p ON p.id = pr.project_id
         WHERE pr.root_path = ?`,
      )
      .get(rootPath.trim());
    return row ? projectFromRow(row as ProjectRow) : null;
  }

  getProjectRoot(projectId: string): string | null {
    const row = this.#sqlite
      .prepare(
        `SELECT root_path
         FROM project_roots
         WHERE project_id = ?
         ORDER BY created_at ASC, root_path ASC
         LIMIT 1`,
      )
      .get(projectId) as { root_path: string } | undefined;
    return row?.root_path ?? null;
  }

  listTasks(): Task[] {
    return this.#sqlite
      .prepare(
        `
          SELECT t.id, t.title, t.slug, t.created_at, t.project_root, t.project_id, t.archived_at, t.description, t.pinned_at
          FROM tasks t
          ${LAST_ACTIVITY_JOINS}
          ${AGENT_ORDER_BY}
        `,
      )
      .all()
      .map((row) => taskFromRow(row as TaskRow));
  }

  listTaskSummaries(): TaskSummary[] {
    type TaskSummaryRow = TaskRow & { project_slug: string };
    const tasks = this.#sqlite
      .prepare(
        `SELECT t.id, t.title, t.slug, t.created_at, t.project_root, t.project_id,
                t.archived_at, t.description, t.pinned_at, p.slug AS project_slug
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         ORDER BY t.created_at ASC, t.id ASC`,
      )
      .all() as TaskSummaryRow[];

    type SessionAggRow = {
      task_id: string;
      tools: string | null;
      last_session_at: string | null;
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      total_tokens: number;
    };
    const sessionAgg = this.#sqlite
      .prepare(
        `SELECT task_id,
                GROUP_CONCAT(DISTINCT tool) AS tools,
                MAX(created_at) AS last_session_at,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
                SUM(cache_read_input_tokens) AS cache_read_input_tokens,
                SUM(total_tokens) AS total_tokens
         FROM sessions
         WHERE task_id IS NOT NULL
         GROUP BY task_id`,
      )
      .all() as SessionAggRow[];

    type DocAggRow = { task_id: string; count: number; last_doc_at: string };
    const docAgg = this.#sqlite
      .prepare(
        `SELECT task_id, COUNT(*) AS count, MAX(created_at) AS last_doc_at
         FROM task_docs
         GROUP BY task_id`,
      )
      .all() as DocAggRow[];

    const sessionByTask = new Map(sessionAgg.map((r) => [r.task_id, r]));
    const docByTask = new Map(docAgg.map((r) => [r.task_id, r]));

    return tasks.map((row) => {
      const task = taskFromRow(row);
      const sAgg = sessionByTask.get(task.id);
      const dAgg = docByTask.get(task.id);

      const lastActivityAt = [
        task.createdAt,
        sAgg?.last_session_at ?? null,
        dAgg?.last_doc_at ?? null,
      ]
        .filter((t): t is string => t !== null)
        .reduce((latest, current) => (current > latest ? current : latest));

      const tokenTotals: TokenTotals = {
        inputTokens: sAgg?.input_tokens ?? 0,
        outputTokens: sAgg?.output_tokens ?? 0,
        cacheCreationInputTokens: sAgg?.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: sAgg?.cache_read_input_tokens ?? 0,
        totalTokens: sAgg?.total_tokens ?? 0,
      };

      const agentTools: SessionTool[] = sAgg?.tools
        ? (sAgg.tools.split(",") as SessionTool[]).sort()
        : [];

      const hasDocs = (dAgg?.count ?? 0) > 0;

      return {
        ...task,
        projectSlug: row.project_slug,
        lastActivityAt,
        tokenTotals,
        agentTools,
        hasDocs,
      };
    });
  }

  recallCandidates(projectRoot: string): RecallCandidate[] {
    const projectId = this.resolveProject(projectRoot).project.id;
    const rows = this.#sqlite
      .prepare(
        `
          SELECT t.title, t.slug, t.description
          FROM tasks t
          ${LAST_ACTIVITY_JOINS}
          WHERE t.project_id = ? AND t.archived_at IS NULL
          ${AGENT_ORDER_BY}
        `,
      )
      .all(projectId) as Array<{
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

    const projectId = this.resolveProject(projectRoot).project.id;
    const recent = this.#mostRecentTask(projectId);
    return recent ? { kind: "re-enter", task: recent } : { kind: "none" };
  }

  #mostRecentTask(projectId: string): Task | null {
    const row = this.#sqlite
      .prepare(
        `
          SELECT id, title, slug, created_at, project_root, project_id, archived_at, description, pinned_at
          FROM tasks
          WHERE project_id = ? AND archived_at IS NULL
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `,
      )
      .get(projectId);
    return row ? taskFromRow(row as TaskRow) : null;
  }

  updateTaskDescription(ref: string, description: string): Task {
    const task = this.getTaskByRef(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);

    const normalizedDescription = description.trim() || undefined;
    this.#sqlite
      .prepare("UPDATE tasks SET description = ?, updated_at = ?, machine_id = ? WHERE id = ?")
      .run(normalizedDescription ?? null, this.#updatedNow(), this.#machineId, task.id);

    const updated: Task = { ...task };
    if (normalizedDescription) updated.description = normalizedDescription;
    else delete updated.description;
    return updated;
  }

  updateTaskTitle(ref: string, title: string): Task {
    const task = this.getTaskByRef(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);

    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      throw new Error("Task title cannot be empty");
    }
    // Same normalization as createTask: a slug-shaped title reads back as a
    // human title. The slug is the task's stable address and never changes
    // on rename.
    const normalizedTitle = looksLikeSlug(trimmedTitle)
      ? humanizeSlug(trimmedTitle)
      : trimmedTitle;

    this.#sqlite
      .prepare("UPDATE tasks SET title = ? WHERE id = ?")
      .run(normalizedTitle, task.id);

    return { ...task, title: normalizedTitle };
  }

  archiveTask(ref: string): Task {
    const task = this.getTaskByRef(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);

    // Archiving retires a task from active work, so a pin — a marker of
    // current focus — no longer applies and is cleared rather than kept stale.
    const archivedAt = new Date().toISOString();
    this.#sqlite
      .prepare(
        "UPDATE tasks SET archived_at = ?, pinned_at = NULL, updated_at = ?, machine_id = ? WHERE id = ?",
      )
      .run(archivedAt, this.#updatedNow(), this.#machineId, task.id);

    return { ...task, archivedAt, pinnedAt: null };
  }

  unarchiveTask(ref: string): Task {
    const task = this.getTaskByRef(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);

    this.#sqlite
      .prepare("UPDATE tasks SET archived_at = NULL, updated_at = ?, machine_id = ? WHERE id = ?")
      .run(this.#updatedNow(), this.#machineId, task.id);

    return { ...task, archivedAt: null };
  }

  pinTask(ref: string): Task {
    const task = this.getTaskByRef(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);

    const pinnedAt = new Date().toISOString();
    this.#sqlite
      .prepare("UPDATE tasks SET pinned_at = ? WHERE id = ?")
      .run(pinnedAt, task.id);

    return { ...task, pinnedAt };
  }

  unpinTask(ref: string): Task {
    const task = this.getTaskByRef(ref);
    if (!task) throw new Error(`Task not found: ${ref}`);

    this.#sqlite
      .prepare("UPDATE tasks SET pinned_at = NULL WHERE id = ?")
      .run(task.id);

    return { ...task, pinnedAt: null };
  }

  registerSession(input: RegisterSessionInput): Session {
    const id = input.id.trim();
    const transcriptPath = input.transcriptPath.trim();
    const model = input.model?.trim() || null;
    const title = input.title?.trim() || null;
    const parentSessionId = input.parentSessionId?.trim() || null;
    const origin = input.origin ?? "root";
    const subagentType = input.subagentType?.trim() || null;
    const agentId = input.agentId?.trim() || null;

    if (id.length === 0) {
      throw new Error("Session id is required");
    }
    if (transcriptPath.length === 0) {
      throw new Error("Session transcript path is required");
    }
    if (!isSessionTool(input.tool)) {
      throw new Error("Session tool must be claude, codex, or cursor");
    }
    if (!isSessionOrigin(origin)) {
      throw new Error("Session origin must be root, subagent, or spawned");
    }

    const existing = this.getSession(id);
    if (existing) {
      const totals = tokenTotalsFromUsage(input.tokenTotals);
      const next = {
        ...existing,
        transcriptPath:
          isSyntheticLocator(existing.transcriptPath, "codex") &&
          !isSyntheticLocator(transcriptPath, "codex")
            ? transcriptPath
            : existing.transcriptPath,
        model: existing.model ?? model,
        title: existing.title ?? title,
        parentSessionId: existing.parentSessionId ?? parentSessionId,
        origin:
          existing.origin === "root" && origin !== "root"
            ? origin
            : existing.origin,
        subagentType: existing.subagentType ?? subagentType,
        agentId: existing.agentId ?? agentId,
        tokenTotals:
          existing.tokenTotals.totalTokens === 0 && totals.totalTokens > 0
            ? totals
            : existing.tokenTotals,
      };

      const changed =
        next.transcriptPath !== existing.transcriptPath ||
        next.model !== existing.model ||
        next.title !== existing.title ||
        next.parentSessionId !== existing.parentSessionId ||
        next.origin !== existing.origin ||
        next.subagentType !== existing.subagentType ||
        next.agentId !== existing.agentId ||
        next.tokenTotals !== existing.tokenTotals;

      if (!changed) return existing;

      this.#sqlite
        .prepare(
          `
            UPDATE sessions
            SET
              transcript_path = ?,
              model = ?,
              title = ?,
              parent_session_id = ?,
              origin = ?,
              subagent_type = ?,
              agent_id = ?,
              input_tokens = ?,
              output_tokens = ?,
              cache_creation_input_tokens = ?,
              cache_read_input_tokens = ?,
              total_tokens = ?,
              updated_at = ?,
              machine_id = ?
            WHERE id = ?
          `,
        )
        .run(
          next.transcriptPath,
          next.model,
          next.title,
          next.parentSessionId,
          next.origin,
          next.subagentType,
          next.agentId,
          next.tokenTotals.inputTokens,
          next.tokenTotals.outputTokens,
          next.tokenTotals.cacheCreationInputTokens,
          next.tokenTotals.cacheReadInputTokens,
          next.tokenTotals.totalTokens,
          this.#updatedNow(),
          this.#machineId,
          id,
        );

      return this.#refreshSession(next);
    }

    const totals = tokenTotalsFromUsage(input.tokenTotals);
    const session: Session = {
      id,
      transcriptPath,
      tool: input.tool,
      model,
      title,
      taskId: null,
      parentSessionId,
      origin,
      subagentType,
      agentId,
      createdAt: new Date().toISOString(),
      tokenTotals: totals,
      contextTokens: null,
    };

    this.#sqlite
      .prepare(
        `
          INSERT INTO sessions (
            id,
            transcript_path,
            tool,
            model,
            title,
            task_id,
            parent_session_id,
            origin,
            subagent_type,
            agent_id,
            created_at,
            input_tokens,
            output_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
            total_tokens,
            updated_at,
            machine_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        session.id,
        session.transcriptPath,
        session.tool,
        session.model,
        session.title,
        session.taskId,
        session.parentSessionId,
        session.origin,
        session.subagentType,
        session.agentId,
        session.createdAt,
        totals.inputTokens,
        totals.outputTokens,
        totals.cacheCreationInputTokens,
        totals.cacheReadInputTokens,
        totals.totalTokens,
        session.createdAt,
        this.#machineId,
      );

    return session;
  }

  setSessionParent(input: SetSessionParentInput): Session {
    const id = input.id.trim();
    const parentSessionId = input.parentSessionId.trim();
    const origin = input.origin;

    if (id.length === 0) {
      throw new Error("Session id is required");
    }
    if (parentSessionId.length === 0) {
      throw new Error("Parent session id is required");
    }
    if (!isSessionOrigin(origin)) {
      throw new Error("Session origin must be root, subagent, or spawned");
    }

    // If the parent is already bound to a task, the newly-attached child (and
    // its NULL-only descendants) inherit it via the same cascade as on assign.
    const parentTaskId = this.getSession(parentSessionId)?.taskId ?? null;

    const existing = this.getSession(id);
    if (!existing) {
      const created = this.registerSession({
        id,
        transcriptPath: input.transcriptPath ?? syntheticLocator("codex", id),
        tool: input.tool ?? "codex",
        parentSessionId,
        origin,
        subagentType: input.subagentType ?? null,
      });
      if (parentTaskId === null) return created;
      this.#cascadeTaskIdToDescendants(parentSessionId, parentTaskId);
      return this.getSession(id) ?? created;
    }

    // Enrich, don't clobber: a supplied subagent type wins, but omitting one
    // leaves whatever a prior discovery already recorded.
    const subagentType = input.subagentType ?? existing.subagentType;
    this.#sqlite
      .prepare(
        "UPDATE sessions SET parent_session_id = ?, origin = ?, subagent_type = ?, updated_at = ?, machine_id = ? WHERE id = ?",
      )
      .run(parentSessionId, origin, subagentType, this.#updatedNow(), this.#machineId, id);

    if (parentTaskId === null) {
      return { ...existing, parentSessionId, origin, subagentType };
    }
    this.#cascadeTaskIdToDescendants(parentSessionId, parentTaskId);
    return (
      this.getSession(id) ?? {
        ...existing,
        parentSessionId,
        origin,
        subagentType,
      }
    );
  }

  assignSession(sessionId: string, taskId: string): Session {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const task = this.getTaskByRef(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    this.#sqlite
      .prepare("UPDATE sessions SET task_id = ?, updated_at = ?, machine_id = ? WHERE id = ?")
      .run(task.id, this.#updatedNow(), this.#machineId, session.id);

    // A re-bind moves the parent's whole fan: descendants still on the
    // parent's previous task follow it rather than stranding there.
    this.#cascadeTaskIdToDescendants(session.id, task.id, session.taskId);

    return { ...session, taskId: task.id };
  }

  // Walk the `parent_session_id` descendant tree from `parentId`, stamping
  // `taskId` onto every descendant currently at task_id = NULL — or, when
  // `followedTaskId` is given, also those still on that task (the parent's
  // previous binding). Descendants bound to any other task are left untouched,
  // but we still descend through them so a NULL grandchild under an
  // already-assigned child is not orphaned. A visited set guards against
  // cycles in a malformed parent chain.
  #cascadeTaskIdToDescendants(
    parentId: string,
    taskId: string,
    followedTaskId: string | null = null,
  ): void {
    const childrenOf = this.#sqlite.prepare(
      "SELECT id, task_id FROM sessions WHERE parent_session_id = ?",
    );
    const claim = this.#sqlite.prepare(
      "UPDATE sessions SET task_id = ?, updated_at = ?, machine_id = ? WHERE id = ?",
    );

    const visited = new Set<string>([parentId]);
    const queue: string[] = [parentId];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const children = childrenOf.all(current) as {
        id: string;
        task_id: string | null;
      }[];
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        if (
          child.task_id === null ||
          (followedTaskId !== null && child.task_id === followedTaskId)
        ) {
          claim.run(taskId, this.#updatedNow(), this.#machineId, child.id);
        }
        queue.push(child.id);
      }
    }
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
    const entries = this.#taskSessionRows(taskId).map((session) =>
      this.#refreshSessionWithParse(session),
    );

    // Read-time subagent discovery: children a Codex or Cursor parent fanned
    // out to appear on the very read that looks at the task, with no hook,
    // scan, or handoff in between. When it links anything new, re-query so the
    // fresh children land in the same canonical order.
    if (!this.#discoverSubagentsAtRead(entries)) {
      return entries.map((entry) => entry.session);
    }
    return this.#taskSessionRows(taskId).map((session) =>
      this.#refreshSession(session),
    );
  }

  #taskSessionRows(taskId: string): Session[] {
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
      .map((row) => sessionFromRow(row as SessionRow));
  }

  // Link in-process subagents the transcript layer knows about but the store
  // doesn't. Codex parents cost nothing extra: the spawn records ride along on
  // the refresh's parse, and only spawn ids with no registered session trigger
  // child-rollout resolution. Cursor parents cost one readdir of the mirror
  // dir, and only unregistered chat ids pay the composer/prompt lookups.
  // Claude stays out — its SubagentStop hook links children live, and its
  // tool_use correlation is the expensive one. Best-effort per parent: a
  // broken transcript or unreadable mirror dir must not break a board read.
  #discoverSubagentsAtRead(
    entries: { session: Session; parsed: ParsedTranscript | null }[],
  ): boolean {
    let discovered = false;
    for (const { session, parsed } of entries) {
      try {
        if (session.tool === "codex") {
          const spawns = parsed?.subagentSpawns ?? [];
          if (spawns.length === 0) continue;
          const known = this.#childSessionIds(session.id);
          for (const spawn of spawns) {
            if (known.has(spawn.threadId)) continue;
            registerCodexSubagentSpawn(this, session, spawn, this.#codexHome);
            discovered = true;
          }
        } else if (session.tool === "cursor") {
          const subagentsDir = resolveCursorSubagentsDir(
            this,
            session,
            this.#cursorProjectsRoot,
          );
          if (!subagentsDir || !existsSync(subagentsDir)) continue;
          const known = this.#childSessionIds(session.id);
          const mirrored = listCursorSubagentChatIds(subagentsDir);
          if (!mirrored.some((chatId) => !known.has(chatId))) continue;
          discoverCursorSubagentSessions({
            store: this,
            parentSessionId: session.id,
            subagentsDir,
            skipChatIds: known,
          });
          discovered = true;
        }
      } catch {
        // Skip this parent; the rest of the read proceeds untouched.
      }
    }
    return discovered;
  }

  #childSessionIds(parentSessionId: string): Set<string> {
    const rows = this.#sqlite
      .prepare("SELECT id FROM sessions WHERE parent_session_id = ?")
      .all(parentSessionId) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  getTaskTimeline(taskId: string): TaskTimeline | null {
    const task = this.getTaskByRef(taskId);
    if (!task) return null;

    const sessionList = this.listSessionsForTask(task.id);
    const docs = this.listDocsForTask(task.id);
    const stateDoc = docs.find((doc) => basename(doc.path) === "state.md");
    const items: TaskTimelineItem[] = [
      ...sessionList.map(
        (session): TaskTimelineItem => ({
          type: "session",
          createdAt: session.createdAt,
          session,
          sessionName: resolveSessionName(session),
        }),
      ),
      ...docs.map(
        (doc): TaskTimelineItem => ({
          type: "doc",
          createdAt: doc.createdAt,
          doc,
          sizeBytes: readFileSizeBytes(doc.path),
        }),
      ),
    ].sort(compareTimelineItems);
    const lastActivityAt = [
      task.createdAt,
      ...sessionList.map((session) => session.createdAt),
      ...docs.map((doc) => doc.createdAt),
    ].reduce((latest, current) => (current > latest ? current : latest));
    const state = stateDoc ? readParsedState(stateDoc.path) : undefined;
    const stateStale = computeStateStale(
      resolveTaskDocsDir(this.#databasePath, task.slug),
      docs,
      stateDoc?.path,
    );

    return {
      task: {
        ...task,
        projectSlug: this.getProject(task.projectId)?.slug ?? task.projectId,
      },
      items,
      lastActivityAt,
      tokenTotals: sessionList.reduce(
        (totals, session) => addTokenTotals(totals, session.tokenTotals),
        emptyTokenTotals(),
      ),
      ...(state ? { state } : {}),
      ...(stateStale === undefined ? {} : { stateStale }),
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

    const allDocs = this.listDocsForTask(task.id);
    const stateDoc = allDocs.find((d) => basename(d.path) === "state.md");
    const docs = allDocs.filter((d) => basename(d.path) !== "state.md");

    return {
      task: {
        id: task.id,
        title: task.title,
        projectRoot: task.projectRoot,
        // Description stays optional/absent (never null), matching the Task
        // convention — only surface the key when the task actually has one.
        ...(task.description ? { description: task.description } : {}),
      },
      taskDocsDir: resolveTaskDocsDir(this.#databasePath, task.slug),
      ...(stateDoc ? { state: stateDoc } : {}),
      docs,
      sessions,
    };
  }

  addTaskDoc(
    taskId: string,
    path: string,
    options?: AddTaskDocOptions,
  ): TaskDoc {
    const task = this.getTaskByRef(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const normalizedPath = path.trim();
    if (normalizedPath.length === 0) {
      throw new Error("Task doc path is required");
    }

    const existing = this.getTaskDoc(task.id, normalizedPath);
    if (existing) return existing;

    const normalizedTitle = options?.title?.trim();
    const normalizedDescription = options?.description?.trim();
    const doc: TaskDoc = {
      taskId: task.id,
      path: normalizedPath,
      createdAt: new Date().toISOString(),
      ...(normalizedTitle ? { title: normalizedTitle } : {}),
      ...(normalizedDescription ? { description: normalizedDescription } : {}),
    };

    this.#sqlite
      .prepare(
        `
          INSERT INTO task_docs (task_id, path, created_at, title, description)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        doc.taskId,
        doc.path,
        doc.createdAt,
        doc.title ?? null,
        doc.description ?? null,
      );
    return doc;
  }

  updateTaskDoc(
    taskId: string,
    path: string,
    options: UpdateTaskDocOptions,
  ): TaskDoc {
    const task = this.getTaskByRef(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const normalizedPath = path.trim();
    if (normalizedPath.length === 0) {
      throw new Error("Task doc path is required");
    }

    const existing = this.getTaskDoc(task.id, normalizedPath);

    // Each field is tri-state: an absent option leaves the stored value
    // untouched, an empty/whitespace string (or null) clears it, and a
    // non-empty string sets it.
    const nextTitle = resolveDocFieldUpdate(options.title, existing?.title);
    const nextDescription = resolveDocFieldUpdate(
      options.description,
      existing?.description,
    );

    if (existing) {
      this.#sqlite
        .prepare(
          `
            UPDATE task_docs
            SET title = ?, description = ?
            WHERE task_id = ? AND path = ?
          `,
        )
        .run(nextTitle, nextDescription, task.id, normalizedPath);
      return toTaskDoc(
        task.id,
        normalizedPath,
        existing.createdAt,
        nextTitle,
        nextDescription,
      );
    }

    // Insert-on-update: no row exists yet (e.g. a filesystem-discovered native
    // doc that was never registered), so create one carrying the metadata.
    const createdAt = new Date().toISOString();
    this.#sqlite
      .prepare(
        `
          INSERT INTO task_docs (task_id, path, created_at, title, description)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(task.id, normalizedPath, createdAt, nextTitle, nextDescription);
    return toTaskDoc(
      task.id,
      normalizedPath,
      createdAt,
      nextTitle,
      nextDescription,
    );
  }

  listDocsForTask(taskId: string): TaskDoc[] {
    const task = this.getTaskByRef(taskId);
    const id = task?.id ?? taskId;

    const registeredDocs = this.#sqlite
      .prepare(
        `
          SELECT task_id, path, created_at, title, description
          FROM task_docs
          WHERE task_id = ?
          ORDER BY created_at ASC, path ASC
        `,
      )
      .all(id)
      .map((row) => taskDocFromRow(row as TaskDocRow));

    return mergeTaskDocs(
      registeredDocs,
      task?.slug ? listNativeTaskDocs(this.#databasePath, id, task.slug) : [],
      task?.slug
        ? resolveTaskDocsDir(this.#databasePath, task.slug)
        : undefined,
    );
  }

  removeTaskDoc(taskId: string, path: string): void {
    this.#sqlite
      .prepare("DELETE FROM task_docs WHERE task_id = ? AND path = ?")
      .run(taskId, path.trim());
  }

  syncSnapshot(): SyncPayload {
    const tasks = this.#sqlite
      .prepare(
        `SELECT id, title, slug, created_at AS createdAt,
                project_root AS projectRoot, archived_at AS archivedAt,
                description, updated_at AS updatedAt, machine_id AS machineId
         FROM tasks ORDER BY id`,
      )
      .all() as SyncPayload["tasks"];
    const sessions = this.#sqlite
      .prepare(
        `SELECT id, transcript_path AS transcriptPath, tool, model, title,
                task_id AS taskId, parent_session_id AS parentSessionId,
                origin, subagent_type AS subagentType, agent_id AS agentId,
                created_at AS createdAt, input_tokens AS inputTokens,
                output_tokens AS outputTokens,
                cache_creation_input_tokens AS cacheCreationInputTokens,
                cache_read_input_tokens AS cacheReadInputTokens,
                total_tokens AS totalTokens, updated_at AS updatedAt,
                machine_id AS machineId
         FROM sessions ORDER BY id`,
      )
      .all() as SyncPayload["sessions"];
    return { tasks, sessions };
  }

  mergeSyncPayload(payload: SyncPayload): { pulled: number } {
    const local = this.syncSnapshot();
    const localTasks = new Map(local.tasks.map((row) => [row.id, row]));
    const localSessions = new Map(local.sessions.map((row) => [row.id, row]));
    const tasks = payload.tasks.filter((row) => {
      const existing = localTasks.get(row.id);
      return !existing || compareSyncRows(row, existing) > 0;
    });
    const sessions = payload.sessions.filter((row) => {
      const existing = localSessions.get(row.id);
      return !existing || compareSyncRows(row, existing) > 0;
    });

    this.#sqlite.exec("BEGIN");
    try {
      const upsertTask = this.#sqlite.prepare(
        `INSERT INTO tasks
           (id, title, slug, created_at, project_root, archived_at, description, updated_at, machine_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, slug=excluded.slug, created_at=excluded.created_at,
           project_root=excluded.project_root, archived_at=excluded.archived_at,
           description=excluded.description, updated_at=excluded.updated_at,
           machine_id=excluded.machine_id`,
      );
      for (const row of tasks) {
        upsertTask.run(
          row.id,
          row.title,
          row.slug,
          row.createdAt,
          row.projectRoot,
          row.archivedAt,
          row.description,
          row.updatedAt,
          row.machineId,
        );
      }

      const upsertSession = this.#sqlite.prepare(
        `INSERT INTO sessions
           (id, transcript_path, tool, model, title, task_id, parent_session_id,
            origin, subagent_type, agent_id, created_at, input_tokens, output_tokens,
            cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
            updated_at, machine_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           transcript_path=excluded.transcript_path, tool=excluded.tool,
           model=excluded.model, title=excluded.title, task_id=excluded.task_id,
           parent_session_id=NULL, origin=excluded.origin,
           subagent_type=excluded.subagent_type, agent_id=excluded.agent_id,
           created_at=excluded.created_at, input_tokens=excluded.input_tokens,
           output_tokens=excluded.output_tokens,
           cache_creation_input_tokens=excluded.cache_creation_input_tokens,
           cache_read_input_tokens=excluded.cache_read_input_tokens,
           total_tokens=excluded.total_tokens, updated_at=excluded.updated_at,
           machine_id=excluded.machine_id`,
      );
      for (const row of sessions) {
        upsertSession.run(
          row.id,
          row.transcriptPath,
          row.tool,
          row.model,
          row.title,
          row.taskId,
          row.origin,
          row.subagentType,
          row.agentId,
          row.createdAt,
          row.inputTokens,
          row.outputTokens,
          row.cacheCreationInputTokens,
          row.cacheReadInputTokens,
          row.totalTokens,
          row.updatedAt,
          row.machineId,
        );
      }
      const setParent = this.#sqlite.prepare(
        "UPDATE sessions SET parent_session_id = ? WHERE id = ?",
      );
      for (const row of sessions) setParent.run(row.parentSessionId, row.id);
      this.#sqlite.exec("COMMIT");
    } catch (error) {
      this.#sqlite.exec("ROLLBACK");
      throw error;
    }
    return { pulled: tasks.length + sessions.length };
  }

  #updatedNow(): string {
    const now = new Date().toISOString();
    if (now > this.#lastUpdatedAt) {
      this.#lastUpdatedAt = now;
    } else {
      this.#lastUpdatedAt = new Date(
        new Date(this.#lastUpdatedAt).getTime() + 1,
      ).toISOString();
    }
    return this.#lastUpdatedAt;
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
    return this.#refreshSessionWithParse(session).session;
  }

  // The path a refresh should parse. A codex session bound before its rollout
  // was known sits under a synthetic `codex:<id>` locator; resolve it by
  // thread id so the first read heals it (the refresh adopts the adapter's
  // reported path), instead of staying blank until a manual scan.
  #parseableLocator(session: Session): string {
    if (
      session.tool !== "codex" ||
      !isSyntheticLocator(session.transcriptPath, "codex")
    ) {
      return session.transcriptPath;
    }
    const codexHome = this.#codexHome ?? join(homedir(), ".codex");
    return (
      resolveCodexTranscriptPathById(codexHome, session.id) ??
      session.transcriptPath
    );
  }

  // Refresh plus the raw parse it was derived from, so read-time subagent
  // discovery can consume tool-specific fields (Codex spawn records) without
  // parsing the transcript a second time. `parsed` is null when the transcript
  // is missing or unparseable — the stored session values survive untouched.
  #refreshSessionWithParse(session: Session): {
    session: Session;
    parsed: ParsedTranscript | null;
  } {
    let parsed: ParsedTranscript;
    try {
      const adapter = getTranscriptAdapter(session.tool);
      parsed = adapter.parseFile(this.#parseableLocator(session), {
        expectedId: session.id,
      });
    } catch {
      return { session, parsed: null };
    }
    const fresh = {
      transcriptPath: parsed.transcriptPath,
      tokenTotals: parsed.tokenTotals,
      title: parsed.title,
      model: parsed.model,
      contextTokens: parsed.contextTokens ?? null,
    };

    const totals = fresh.tokenTotals;
    const stored = session.tokenTotals;
    const totalsChanged =
      totals.inputTokens !== stored.inputTokens ||
      totals.outputTokens !== stored.outputTokens ||
      totals.cacheCreationInputTokens !== stored.cacheCreationInputTokens ||
      totals.cacheReadInputTokens !== stored.cacheReadInputTokens ||
      totals.totalTokens !== stored.totalTokens;

    // Only adopt a freshly parsed title; a transcript that no longer reports a
    // title (e.g. a truncated tail) must not clobber a previously stored one.
    const title = fresh.title ?? session.title;
    const titleChanged = title !== session.title;

    // Same rule for model: a stored model survives a parse that yields null.
    const model = fresh.model ?? session.model;
    const modelChanged = model !== session.model;

    // Adapters report the locator the session should canonically be stored
    // under — for cursor, the composer flavor when a composer record exists —
    // so a session bound under the wrong flavor self-heals here. The other
    // adapters echo the stored path back.
    const transcriptPath = fresh.transcriptPath || session.transcriptPath;
    const transcriptPathChanged = transcriptPath !== session.transcriptPath;

    // Context tokens are ephemeral at the source (Cursor reports occupancy
    // only for the live composer), so the last observed value is snapshotted
    // and a parse that can't see one must not wipe it — the same
    // preserve-on-null rule as title and model.
    const contextTokens = fresh.contextTokens ?? session.contextTokens ?? null;
    const contextTokensChanged =
      contextTokens?.used !== session.contextTokens?.used ||
      contextTokens?.limit !== session.contextTokens?.limit;

    if (
      totalsChanged ||
      titleChanged ||
      modelChanged ||
      transcriptPathChanged ||
      contextTokensChanged
    ) {
      this.#sqlite
        .prepare(
          `
            UPDATE sessions
            SET
              transcript_path = ?,
              title = ?,
              model = ?,
              input_tokens = ?,
              output_tokens = ?,
              cache_creation_input_tokens = ?,
              cache_read_input_tokens = ?,
              total_tokens = ?,
              context_tokens_used = ?,
              context_tokens_limit = ?,
              updated_at = ?,
              machine_id = ?
            WHERE id = ?
          `,
        )
        .run(
          transcriptPath,
          title,
          model,
          totals.inputTokens,
          totals.outputTokens,
          totals.cacheCreationInputTokens,
          totals.cacheReadInputTokens,
          totals.totalTokens,
          contextTokens?.used ?? null,
          contextTokens?.limit ?? null,
          this.#updatedNow(),
          this.#machineId,
          session.id,
        );
    }

    return {
      session: {
        ...session,
        transcriptPath,
        title,
        model,
        tokenTotals: totals,
        contextTokens,
      },
      parsed,
    };
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

  #backfillProjects(): void {
    const roots = this.#sqlite
      .prepare(
        `SELECT project_root
         FROM tasks
         WHERE project_id IS NULL
         GROUP BY project_root
         ORDER BY MIN(created_at) ASC, project_root ASC`,
      )
      .all() as { project_root: string }[];

    const stampTasks = this.#sqlite.prepare(
      "UPDATE tasks SET project_id = ? WHERE project_root = ? AND project_id IS NULL",
    );
    for (const { project_root: rootPath } of roots) {
      const project = this.resolveProject(rootPath).project;
      stampTasks.run(project.id, rootPath);
    }
  }

  resolveProject(rootPath: string): ProjectResolution {
    const normalizedRoot = rootPath.trim();
    const mapped = this.getProjectByRoot(normalizedRoot);
    if (mapped) return { kind: "known", project: mapped };

    const fingerprints = readProjectFingerprints(normalizedRoot);
    const matched = this.getProjectByFingerprint(fingerprints);
    const slugStem = slugify(basename(normalizedRoot));
    const sameNamed =
      !matched && slugStem ? this.#getProjectBySlugStem(slugStem) : null;
    const project =
      matched ?? this.#createProject(normalizedRoot, fingerprints);
    this.#sqlite
      .prepare(
        `INSERT INTO project_roots (root_path, project_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(root_path) DO UPDATE SET project_id = excluded.project_id`,
      )
      .run(normalizedRoot, project.id, new Date().toISOString());
    if (matched) return { kind: "linked", project };
    return {
      kind: "created",
      project,
      ...(sameNamed
        ? {
            collisionHint: {
              duplicateSlug: project.slug,
              canonicalSlug: sameNamed.slug,
            },
          }
        : {}),
    };
  }

  mergeProjects(
    duplicateSlug: string,
    canonicalSlug: string,
  ): ProjectMergeResult {
    const normalizedDuplicateSlug = duplicateSlug.trim();
    const normalizedCanonicalSlug = canonicalSlug.trim();
    if (normalizedDuplicateSlug === normalizedCanonicalSlug) {
      throw new Error(
        `Cannot merge project ${normalizedDuplicateSlug} into itself`,
      );
    }

    const duplicate = this.getProjectBySlug(normalizedDuplicateSlug);
    if (!duplicate) {
      throw new Error(this.#projectNotFoundMessage(normalizedDuplicateSlug));
    }
    const canonical = this.getProjectBySlug(normalizedCanonicalSlug);
    if (!canonical) {
      throw new Error(this.#projectNotFoundMessage(normalizedCanonicalSlug));
    }

    const remoteUrl = canonical.remoteUrl ?? duplicate.remoteUrl;
    const rootCommit = canonical.rootCommit ?? duplicate.rootCommit;
    const fingerprintsAdded: ProjectMergeResult["fingerprintsAdded"] = [];
    if (!canonical.remoteUrl && duplicate.remoteUrl) {
      fingerprintsAdded.push("remote URL");
    }
    if (!canonical.rootCommit && duplicate.rootCommit) {
      fingerprintsAdded.push("root commit");
    }

    this.#sqlite.exec("BEGIN");
    try {
      const tasksMoved = Number(
        this.#sqlite
          .prepare("UPDATE tasks SET project_id = ? WHERE project_id = ?")
          .run(canonical.id, duplicate.id).changes,
      );
      const rootsMoved = Number(
        this.#sqlite
          .prepare(
            "UPDATE project_roots SET project_id = ? WHERE project_id = ?",
          )
          .run(canonical.id, duplicate.id).changes,
      );
      this.#sqlite
        .prepare(
          `UPDATE projects
           SET remote_url = ?, root_commit = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(remoteUrl, rootCommit, new Date().toISOString(), canonical.id);
      this.#sqlite
        .prepare("DELETE FROM projects WHERE id = ?")
        .run(duplicate.id);
      this.#sqlite.exec("COMMIT");

      return {
        duplicateSlug: duplicate.slug,
        canonicalSlug: canonical.slug,
        tasksMoved,
        rootsMoved,
        fingerprintsAdded,
      };
    } catch (error) {
      this.#sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  #createProject(rootPath: string, fingerprints: ProjectFingerprints): Project {
    const id = randomUUID();
    const baseSlug = slugify(basename(rootPath));
    const slug = this.#allocateProjectSlug(
      baseSlug || `project-${id.split("-")[0]}`,
    );
    const createdAt = new Date().toISOString();
    const project: Project = {
      id,
      slug,
      remoteUrl: fingerprints.remoteUrl ?? null,
      rootCommit: fingerprints.rootCommit ?? null,
      createdAt,
      updatedAt: createdAt,
    };
    this.#sqlite
      .prepare(
        `INSERT INTO projects
          (id, slug, remote_url, root_commit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.slug,
        project.remoteUrl,
        project.rootCommit,
        project.createdAt,
        project.updatedAt,
      );
    return project;
  }

  #allocateProjectSlug(base: string): string {
    if (!this.#projectSlugExists(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!this.#projectSlugExists(candidate)) return candidate;
    }
  }

  #projectSlugExists(slug: string): boolean {
    return (
      this.#sqlite
        .prepare("SELECT 1 FROM projects WHERE slug = ? LIMIT 1")
        .get(slug) !== undefined
    );
  }

  #getProjectBySlugStem(slugStem: string): Project | null {
    const row = this.#sqlite
      .prepare(
        `SELECT id, slug, remote_url, root_commit, created_at, updated_at
         FROM projects
         WHERE slug = ? OR slug GLOB ?
         ORDER BY CASE WHEN slug = ? THEN 0 ELSE 1 END, created_at ASC, id ASC
         LIMIT 1`,
      )
      .get(slugStem, `${slugStem}-[0-9]*`, slugStem);
    return row ? projectFromRow(row as ProjectRow) : null;
  }

  #projectNotFoundMessage(slug: string): string {
    const needle = slug.toLowerCase();
    const projects = this.#sqlite
      .prepare(
        `SELECT slug
         FROM projects
         WHERE ? <> '' AND LOWER(slug) LIKE ?
         ORDER BY slug ASC
         LIMIT 5`,
      )
      .all(needle, `%${needle}%`) as { slug: string }[];
    const lines = [`Project not found: ${slug}`];
    if (projects.length > 0) {
      lines.push("Near candidates:");
      for (const project of projects) lines.push(`  ${project.slug}`);
    }
    return lines.join("\n");
  }

  private getTaskDoc(taskId: string, path: string): TaskDoc | null {
    const row = this.#sqlite
      .prepare(
        `
          SELECT task_id, path, created_at, title, description
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
  project_id: string;
  archived_at: string | null;
  description: string | null;
  pinned_at: string | null;
};

type ProjectRow = {
  id: string;
  slug: string;
  remote_url: string | null;
  root_commit: string | null;
  created_at: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  transcript_path: string;
  tool: SessionTool;
  model: string | null;
  title: string | null;
  task_id: string | null;
  parent_session_id: string | null;
  origin: SessionOrigin;
  subagent_type: string | null;
  agent_id: string | null;
  created_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_tokens: number;
  context_tokens_used: number | null;
  context_tokens_limit: number | null;
};

type TaskDocRow = {
  task_id: string;
  path: string;
  created_at: string;
  title: string | null;
  description: string | null;
};

function taskFromRow(row: TaskRow): Task {
  const task: Task = {
    id: row.id,
    title: row.title,
    slug: row.slug,
    createdAt: row.created_at,
    projectRoot: row.project_root,
    projectId: row.project_id,
    archivedAt: row.archived_at,
    pinnedAt: row.pinned_at,
  };
  // A null column means the task was created without a description; keep the
  // field absent rather than carrying a null so round-trips stay clean.
  if (row.description != null) task.description = row.description;
  return task;
}

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    remoteUrl: row.remote_url,
    rootCommit: row.root_commit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sessionFromRow(row: SessionRow): Session {
  return {
    id: row.id,
    transcriptPath: row.transcript_path,
    tool: row.tool,
    model: row.model,
    title: row.title,
    taskId: row.task_id,
    parentSessionId: row.parent_session_id,
    origin: row.origin,
    subagentType: row.subagent_type,
    agentId: row.agent_id,
    createdAt: row.created_at,
    tokenTotals: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens,
      cacheReadInputTokens: row.cache_read_input_tokens,
      totalTokens: row.total_tokens,
    },
    contextTokens:
      row.context_tokens_used != null
        ? {
            used: row.context_tokens_used,
            limit: row.context_tokens_limit ?? 0,
          }
        : null,
  };
}

function isSessionOrigin(value: string): value is SessionOrigin {
  return value === "root" || value === "subagent" || value === "spawned";
}

function taskDocFromRow(row: TaskDocRow): TaskDoc {
  const doc: TaskDoc = {
    taskId: row.task_id,
    path: row.path,
    createdAt: row.created_at,
  };
  // A null column means the doc was registered without that field; keep it
  // absent rather than carrying a null so round-trips stay clean.
  if (row.title != null) doc.title = row.title;
  if (row.description != null) doc.description = row.description;
  return doc;
}

// Resolve a tri-state field update against the stored value: `undefined`
// leaves the existing value intact, while an empty/whitespace string (or null)
// clears it and a non-empty string sets the trimmed value.
function resolveDocFieldUpdate(
  option: string | null | undefined,
  existing: string | undefined,
): string | null {
  if (option === undefined) return existing ?? null;
  if (option === null) return null;
  const trimmed = option.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Build a TaskDoc from resolved column values, keeping null fields absent so
// round-trips match taskDocFromRow's clean-absence convention.
function toTaskDoc(
  taskId: string,
  path: string,
  createdAt: string,
  title: string | null,
  description: string | null,
): TaskDoc {
  const doc: TaskDoc = { taskId, path, createdAt };
  if (title != null) doc.title = title;
  if (description != null) doc.description = description;
  return doc;
}

function compareTimelineItems(
  left: TaskTimelineItem,
  right: TaskTimelineItem,
): number {
  // Chronological — oldest first — so the timeline reads top-to-bottom in the
  // order work happened: the founding session, then docs and later sessions as
  // they were added.
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

/** File size in bytes for a doc path, or null when it can't be stat'd. */
function readFileSizeBytes(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function readParsedState(path: string): ReturnType<typeof parseStateMd> | null {
  try {
    return parseStateMd(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Whether state.md's prose has drifted from the task's docs — the same
 * fingerprint comparison `trace state check` makes, recomputed at board read
 * time. Undefined when the task has no non-state doc (nothing to reflect on);
 * true when the prose was never written, is empty, or was stamped against a
 * different doc set.
 */
function computeStateStale(
  docsDir: string,
  docs: TaskDoc[],
  statePath: string | undefined,
): boolean | undefined {
  const nonStateDocs = docs.filter((doc) => basename(doc.path) !== "state.md");
  if (nonStateDocs.length === 0) return undefined;

  if (!statePath) return true;
  let content: string;
  try {
    content = readFileSync(statePath, "utf8");
  } catch {
    return true;
  }
  if (!hasProseBody(content)) return true;

  const fingerprint = computeDocsFingerprint(
    nonStateDocs.map((doc) => ({
      path: relative(docsDir, doc.path),
      content: readDocContentOrEmpty(doc.path),
    })),
  );
  return readProseFingerprint(content) !== fingerprint;
}

function readDocContentOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function compareSessionsNewestFirst(left: Session, right: Session): number {
  const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return right.id.localeCompare(left.id);
}
