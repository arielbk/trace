import type { ParsedStateMd } from "./state-parser.ts";

export type Task = {
  id: string;
  title: string;
  slug: string;
  createdAt: string;
  projectRoot: string;
  archivedAt: string | null;
  // Optional agent-authored summary; absent on tasks created without one.
  description?: string;
};

// The minimal shape the recall skill hands to the agent to resolve a vague
// reference. `description` is absent on tasks created without one.
export type RecallCandidate = Pick<Task, "title" | "slug" | "description">;

// The active task for a session/project, resolved by `resolveActiveTask`.
// `bound` — the session is already assigned to this (unarchived) task. `re-enter`
// — the session is unbound but the project has a most-recent unarchived task to
// offer. `none` — nothing to bind to yet.
export type ActiveTask =
  | { kind: "bound"; task: Task }
  | { kind: "re-enter"; task: Task }
  | { kind: "none" };

export type SessionTool = "claude" | "codex";

export type Session = {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  model: string | null;
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
      sessionName: string | null;
    }
  | {
      type: "doc";
      createdAt: string;
      doc: TaskDoc;
      /** File size on disk in bytes, or null when the file can't be stat'd. */
      sizeBytes: number | null;
    };

export type TaskTimeline = {
  task: Task;
  items: TaskTimelineItem[];
  tokenTotals: TokenTotals;
  lastActivityAt: string;
  state?: ParsedStateMd;
};

export type TaskSummary = Task & {
  lastActivityAt: string;
  tokenTotals: TokenTotals;
  agentTools: SessionTool[];
  hasDocs: boolean;
};

export type ReEntryManifestDoc = TaskDoc;

export type ReEntryManifestSession = {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  model: string | null;
  createdAt: string;
  isMostRecent: boolean;
};

export type ReEntryManifest = {
  task: Pick<Task, "id" | "title" | "projectRoot" | "description">;
  taskDocsDir: string;
  state?: ReEntryManifestDoc;
  docs: ReEntryManifestDoc[];
  sessions: ReEntryManifestSession[];
};

export type RegisterSessionInput = {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  model?: string | null;
  tokenTotals?: Partial<TokenTotals>;
};

export type TaskStore = {
  createTask(title: string, projectRoot?: string, description?: string): Task;
  getTask(id: string): Task | null;
  getTaskByRef(ref: string): Task | null;
  getSession(id: string): Session | null;
  listTasks(): Task[];
  listTaskSummaries(): TaskSummary[];
  recallCandidates(projectRoot: string): RecallCandidate[];
  resolveActiveTask(sessionId: string, projectRoot: string): ActiveTask;
  updateTaskDescription(ref: string, description: string): Task;
  archiveTask(ref: string): Task;
  unarchiveTask(ref: string): Task;
  registerSession(input: RegisterSessionInput): Session;
  assignSession(sessionId: string, taskId: string): Session;
  listUnassignedSessions(): Session[];
  listSessionsForTask(taskId: string): Session[];
  getTaskTimeline(taskId: string): TaskTimeline | null;
  getReEntryManifest(taskId: string): ReEntryManifest | null;
  addTaskDoc(taskId: string, path: string): TaskDoc;
  listDocsForTask(taskId: string): TaskDoc[];
  removeTaskDoc(taskId: string, path: string): void;
  close(): void;
};
