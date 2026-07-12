import type { ParsedStateMd } from "./state-parser.ts";

export type Task = {
  id: string;
  title: string;
  slug: string;
  createdAt: string;
  projectRoot: string;
  archivedAt: string | null;
  pinnedAt: string | null;
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

// The single source of the tool axis: the schema enum, runtime validation, and
// CLI flag parsing all derive from this list, so adding a tool is a one-line
// change here plus a Drizzle migration.
export const SESSION_TOOLS = ["claude", "codex", "cursor"] as const;
export type SessionTool = (typeof SESSION_TOOLS)[number];

export function isSessionTool(value: string): value is SessionTool {
  return (SESSION_TOOLS as readonly string[]).includes(value);
}

export type SessionOrigin = "root" | "subagent" | "spawned";

export type Session = {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  model: string | null;
  title: string | null;
  taskId: string | null;
  parentSessionId: string | null;
  origin: SessionOrigin;
  subagentType: string | null;
  agentId: string | null;
  createdAt: string;
  tokenTotals: TokenTotals;
  // Live context-window occupancy when the tool exposes it (Cursor). Not
  // persisted — recomputed from the transcript on read. Absent for claude/codex.
  contextTokens?: ContextTokens | null;
};

export type TaskDoc = {
  taskId: string;
  path: string;
  createdAt: string;
  // Optional explicit title; absent on docs registered without one. When
  // present it wins the resolved-title fallback chain over a parsed H1 or the
  // filename across the manifest, viewer, and timeline surfaces.
  title?: string;
  // Optional one-line description; absent on docs registered without one. It is
  // the source of truth the state.md manifest footer renders from.
  description?: string;
};

// Optional metadata captured alongside a doc registration. Both fields are
// absent on docs added without them; empty/whitespace values normalize away.
export type AddTaskDocOptions = {
  title?: string;
  description?: string;
};

// A field-level update to a registered (or about-to-be-inserted) doc. Each
// field is tri-state: `undefined` leaves the stored value untouched, `null`
// (or an empty/whitespace string) clears it to NULL, and a non-empty string
// sets it. At least one field should be present at the call site.
export type UpdateTaskDocOptions = {
  title?: string | null;
  description?: string | null;
};

export type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
};

// Current context-window occupancy for a session — a live snapshot, not
// cumulative spend. Only Cursor exposes this today (claude/codex track spend
// instead), so it's optional everywhere and absent for those tools.
export type ContextTokens = {
  used: number;
  limit: number;
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
  title?: string | null;
  parentSessionId?: string | null;
  origin?: SessionOrigin;
  subagentType?: string | null;
  agentId?: string | null;
  tokenTotals?: Partial<TokenTotals>;
};

export type SetSessionParentInput = {
  id: string;
  parentSessionId: string;
  origin: SessionOrigin;
  tool?: SessionTool;
  transcriptPath?: string;
  subagentType?: string | null;
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
  updateTaskTitle(ref: string, title: string): Task;
  updateTaskDescription(ref: string, description: string): Task;
  archiveTask(ref: string): Task;
  unarchiveTask(ref: string): Task;
  pinTask(ref: string): Task;
  unpinTask(ref: string): Task;
  registerSession(input: RegisterSessionInput): Session;
  setSessionParent(input: SetSessionParentInput): Session;
  assignSession(sessionId: string, taskId: string): Session;
  listUnassignedSessions(): Session[];
  listSessionsForTask(taskId: string): Session[];
  getTaskTimeline(taskId: string): TaskTimeline | null;
  getReEntryManifest(taskId: string): ReEntryManifest | null;
  addTaskDoc(taskId: string, path: string, options?: AddTaskDocOptions): TaskDoc;
  updateTaskDoc(
    taskId: string,
    path: string,
    options: UpdateTaskDocOptions,
  ): TaskDoc;
  listDocsForTask(taskId: string): TaskDoc[];
  removeTaskDoc(taskId: string, path: string): void;
  close(): void;
};
