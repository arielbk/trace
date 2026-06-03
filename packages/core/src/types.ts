export type Task = {
  id: string;
  title: string;
  createdAt: string;
  projectRoot: string;
};

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

export type TaskSummary = Task & {
  lastActivityAt: string;
  tokenTotals: TokenTotals;
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
  task: Pick<Task, "id" | "title" | "projectRoot">;
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
  createTask(title: string, projectRoot?: string): Task;
  getTask(id: string): Task | null;
  getSession(id: string): Session | null;
  listTasks(): Task[];
  listTaskSummaries(): TaskSummary[];
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
