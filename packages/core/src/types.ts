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
