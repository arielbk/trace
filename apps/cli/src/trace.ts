#!/usr/bin/env node
import {
  openTraceStore,
  scanCodexSessions,
  type Session,
  type SessionTool,
  type Task,
  type TaskDoc,
  type TokenTotals,
} from "../../../packages/core/src/index.ts";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function runTraceCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): CommandResult {
  const databasePath = env.TRACE_DB;

  if (!databasePath) {
    return failure("TRACE_DB must point to a SQLite database file");
  }

  const [resource, action, ...args] = argv;

  const store = openTraceStore(databasePath);

  try {
    if (resource === "task") {
      if (action === "create") {
        const title = args.join(" ");
        const task = store.createTask(title);

        return success(`${task.id}\n`);
      }

      if (action === "show") {
        const id = args[0];

        if (!id) {
          return failure("Task id is required");
        }

        const task = store.getTask(id);

        if (!task) {
          return failure(`Task not found: ${id}`, 1);
        }

        return success(
          formatTask(
            task,
            store.listSessionsForTask(task.id),
            store.listDocsForTask(task.id),
          ),
        );
      }

      if (action === "list") {
        return success(store.listTasks().map(formatTaskSummary).join(""));
      }

      if (action === "timeline") {
        const id = args[0];
        const format = args[1];

        if (!id) {
          return failure("Task id is required");
        }

        if (format !== "--json") {
          return failure("Task timeline currently requires --json");
        }

        const timeline = store.getTaskTimeline(id);

        if (!timeline) {
          return failure(`Task not found: ${id}`, 1);
        }

        return success(`${JSON.stringify(timeline)}\n`);
      }

      if (action === "add-doc") {
        const taskId = args[0];
        const path = args[1];

        if (!taskId) {
          return failure("Task id is required");
        }

        if (!path) {
          return failure("Task doc path is required");
        }

        const doc = store.addTaskDoc(taskId, path);

        return success(formatTaskDocSummary(doc));
      }

      return usage();
    }

    if (resource === "session") {
      if (action === "register") {
        const parsed = parseSessionRegisterArgs(args);
        const session = store.registerSession(parsed);

        return success(`${session.id}\n`);
      }

      if (action === "assign") {
        const sessionId = args[0];
        const taskId = args[1];

        if (!sessionId) {
          return failure("Session id is required");
        }

        if (!taskId) {
          return failure("Task id is required");
        }

        const session = store.assignSession(sessionId, taskId);

        return success(formatSessionSummary(session));
      }

      if (action === "list" && args[0] === "--unassigned") {
        return success(
          store.listUnassignedSessions().map(formatSessionSummary).join(""),
        );
      }

      if (action === "scan" && args[0] === "--codex") {
        const codexHome = parseCodexScanArgs(args.slice(1), env);
        const sessions = scanCodexSessions(codexHome).map((session) =>
          store.registerSession({
            id: session.id,
            transcriptPath: session.transcriptPath,
            tool: session.tool,
            tokenTotals: session.tokenTotals,
          }),
        );

        return success(sessions.map(formatSessionSummary).join(""));
      }

      return usage();
    }

    if (resource === "skill") {
      if (action === "work-on-task") {
        const taskId = args[0];

        if (!taskId) {
          return failure("Task id is required");
        }

        const parsed = parseSkillWorkOnTaskArgs(args.slice(1), env);
        const session = store.registerSession(parsed);

        return success(
          formatSessionSummary(store.assignSession(session.id, taskId)),
        );
      }

      if (action === "re-enter") {
        const taskId = args[0];

        if (!taskId) {
          return failure("Task id is required");
        }

        const task = store.getTask(taskId);

        if (!task) {
          return failure(`Task not found: ${taskId}`, 1);
        }

        return success(
          formatTaskContext(
            task,
            store.listDocsForTask(task.id),
            store.listSessionsForTask(task.id),
          ),
        );
      }

      return usage();
    }

    return usage();
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  } finally {
    store.close();
  }
}

function success(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr: string, exitCode = 2): CommandResult {
  return { exitCode, stdout: "", stderr: `${stderr}\n` };
}

function usage(): CommandResult {
  return failure(
    "Usage: trace task <create|show|list|add-doc|timeline> ... | trace session <register|assign|list|scan> ... | trace skill <work-on-task|re-enter> ...",
  );
}

function formatTask(
  task: Task,
  sessions: Session[] = [],
  docs: TaskDoc[] = [],
): string {
  const lines = [
    `id: ${task.id}`,
    `title: ${task.title}`,
    `createdAt: ${task.createdAt}`,
  ];

  if (sessions.length > 0) {
    lines.push(
      "sessions:",
      ...sessions.map(
        (session) => `- ${formatSessionSummary(session).trimEnd()}`,
      ),
    );
  }

  if (docs.length > 0) {
    lines.push("docs:", ...docs.map((doc) => `- ${doc.path}`));
  }

  return [...lines, ""].join("\n");
}

function formatTaskSummary(task: Task): string {
  return `${task.id}\t${task.title}\n`;
}

function formatSessionSummary(session: Session): string {
  return `${session.id}\t${session.tool}\t${session.transcriptPath}\n`;
}

function formatTaskDocSummary(doc: TaskDoc): string {
  return `${doc.taskId}\t${doc.path}\n`;
}

function formatTaskContext(
  task: Task,
  docs: TaskDoc[],
  sessions: Session[],
): string {
  const lines = [
    `task: ${task.id}`,
    `title: ${task.title}`,
    `createdAt: ${task.createdAt}`,
  ];

  if (docs.length > 0) {
    lines.push("docs:", ...docs.map((doc) => `- ${doc.path}`));
  }

  if (sessions.length > 0) {
    lines.push(
      "sessions:",
      ...sessions.map(
        (session) => `- ${formatSessionSummary(session).trimEnd()}`,
      ),
    );
  }

  return [...lines, ""].join("\n");
}

function parseSessionRegisterArgs(args: string[]): {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  tokenTotals: Partial<TokenTotals>;
} {
  let id: string | undefined;
  let transcriptPath: string | undefined;
  let tool: string | undefined;
  const tokenTotals: Partial<TokenTotals> = {};

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (!flag || !value) {
      throw new Error(
        "Session register requires --id, --transcript, and --tool",
      );
    }

    if (flag === "--id") {
      id = value;
    } else if (flag === "--transcript") {
      transcriptPath = value;
    } else if (flag === "--tool") {
      tool = value;
    } else if (flag === "--input-tokens") {
      tokenTotals.inputTokens = parseNonNegativeInteger(value, flag);
    } else if (flag === "--output-tokens") {
      tokenTotals.outputTokens = parseNonNegativeInteger(value, flag);
    } else if (flag === "--cache-creation-input-tokens") {
      tokenTotals.cacheCreationInputTokens = parseNonNegativeInteger(
        value,
        flag,
      );
    } else if (flag === "--cache-read-input-tokens") {
      tokenTotals.cacheReadInputTokens = parseNonNegativeInteger(value, flag);
    } else if (flag === "--total-tokens") {
      tokenTotals.totalTokens = parseNonNegativeInteger(value, flag);
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (!id || !transcriptPath || !tool) {
    throw new Error("Session register requires --id, --transcript, and --tool");
  }

  if (tool !== "claude" && tool !== "codex") {
    throw new Error("Session tool must be claude or codex");
  }

  return { id, transcriptPath, tool, tokenTotals };
}

function parseNonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }

  return parsed;
}

function parseCodexScanArgs(
  args: string[],
  env: Record<string, string | undefined>,
): string {
  let codexHome = env.CODEX_HOME;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (!flag || !value) {
      throw new Error("Codex scan accepts --codex-home <path>");
    }

    if (flag === "--codex-home") {
      codexHome = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (codexHome) {
    return codexHome;
  }

  if (!env.HOME) {
    throw new Error("Codex scan requires --codex-home when HOME is not set");
  }

  return `${env.HOME}/.codex`;
}

function parseSkillWorkOnTaskArgs(
  args: string[],
  env: Record<string, string | undefined>,
): {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  tokenTotals: Partial<TokenTotals>;
} {
  let id: string | undefined;
  let transcriptPath: string | undefined;
  let tool: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (!flag || !value) {
      throw new Error(
        "Skill work-on-task accepts --id, --transcript, and --tool",
      );
    }

    if (flag === "--id") {
      id = value;
    } else if (flag === "--transcript") {
      transcriptPath = value;
    } else if (flag === "--tool") {
      tool = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  const inferredTool = tool ?? inferCurrentTool(env);

  if (inferredTool !== "claude" && inferredTool !== "codex") {
    throw new Error("Session tool must be claude or codex");
  }

  const inferredId = id ?? inferCurrentSessionId(inferredTool, env);

  if (!inferredId) {
    throw new Error(
      "Skill work-on-task requires --id or a current session env var",
    );
  }

  return {
    id: inferredId,
    transcriptPath:
      transcriptPath ?? inferTranscriptPath(inferredId, inferredTool, env),
    tool: inferredTool,
    tokenTotals: {},
  };
}

function inferCurrentTool(
  env: Record<string, string | undefined>,
): SessionTool {
  if (env.CODEX_THREAD_ID) {
    return "codex";
  }

  return "claude";
}

function inferCurrentSessionId(
  tool: SessionTool,
  env: Record<string, string | undefined>,
): string | undefined {
  if (tool === "codex") {
    return env.CODEX_THREAD_ID;
  }

  return env.CLAUDE_SESSION_ID ?? env.session_id;
}

function inferTranscriptPath(
  sessionId: string,
  tool: SessionTool,
  env: Record<string, string | undefined>,
): string {
  if (tool === "claude" && env.CLAUDE_TRANSCRIPT_PATH) {
    return env.CLAUDE_TRANSCRIPT_PATH;
  }

  if (tool === "codex" && env.CODEX_TRANSCRIPT_PATH) {
    return env.CODEX_TRANSCRIPT_PATH;
  }

  return `${tool}:${sessionId}`;
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const result = runTraceCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
