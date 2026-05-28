#!/usr/bin/env node
import {
  openTraceStore,
  scanCodexSessions,
  type Session,
  type SessionTool,
  type Task,
  type TaskDoc,
} from "../../../packages/core/src/index.ts";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function runTraceCli(argv: string[], env: Record<string, string | undefined> = process.env): CommandResult {
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

        return success(formatTask(task, store.listSessionsForTask(task.id), store.listDocsForTask(task.id)));
      }

      if (action === "list") {
        return success(store.listTasks().map(formatTaskSummary).join(""));
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
        return success(store.listUnassignedSessions().map(formatSessionSummary).join(""));
      }

      if (action === "scan" && args[0] === "--codex") {
        const codexHome = parseCodexScanArgs(args.slice(1), env);
        const sessions = scanCodexSessions(codexHome).map((session) =>
          store.registerSession({
            id: session.id,
            transcriptPath: session.transcriptPath,
            tool: session.tool,
          }),
        );

        return success(sessions.map(formatSessionSummary).join(""));
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
  return failure("Usage: trace task <create|show|list|add-doc> ... | trace session <register|assign|list> ...");
}

function formatTask(task: Task, sessions: Session[] = [], docs: TaskDoc[] = []): string {
  const lines = [`id: ${task.id}`, `title: ${task.title}`, `createdAt: ${task.createdAt}`];

  if (sessions.length > 0) {
    lines.push("sessions:", ...sessions.map((session) => `- ${formatSessionSummary(session).trimEnd()}`));
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

function parseSessionRegisterArgs(args: string[]): { id: string; transcriptPath: string; tool: SessionTool } {
  let id: string | undefined;
  let transcriptPath: string | undefined;
  let tool: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (!flag || !value) {
      throw new Error("Session register requires --id, --transcript, and --tool");
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

  if (!id || !transcriptPath || !tool) {
    throw new Error("Session register requires --id, --transcript, and --tool");
  }

  if (tool !== "claude" && tool !== "codex") {
    throw new Error("Session tool must be claude or codex");
  }

  return { id, transcriptPath, tool };
}

function parseCodexScanArgs(args: string[], env: Record<string, string | undefined>): string {
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

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const result = runTraceCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
