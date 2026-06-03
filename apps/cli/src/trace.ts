#!/usr/bin/env node
import {
  getTranscriptAdapter,
  inferSessionIdentity,
  openTraceStore,
  type ReEntryManifest,
  resolveProjectRoot,
  resolveTaskDocsDir,
  scanCodexSessions,
  type Session,
  type SessionTool,
  type Task,
  type TaskDoc,
  type TokenTotals,
} from "@trace/core";
import { resolveDbPath } from "./db-path.ts";
import { runInit } from "./installer.ts";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function runTraceCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): CommandResult {
  const [resource, action, ...args] = argv;

  if (resource === "init") {
    return success(runInit(env, cwd));
  }

  let databasePath: string;
  try {
    databasePath = resolveDbPath(env);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  const store = openTraceStore(databasePath);

  try {
    if (resource === "task") {
      if (action === "create") {
        const title = args.join(" ");
        const task = store.createTask(title, resolveProjectRoot(cwd));

        return success(`${task.slug}\n`);
      }

      if (action === "show") {
        const id = args[0];

        if (!id) {
          return failure("Task id is required");
        }

        const task = store.getTaskByRef(id);

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

        const task = store.getTaskByRef(taskId);
        if (!task) {
          return failure(`Task not found: ${taskId}`, 1);
        }

        const doc = store.addTaskDoc(task.id, path);

        return success(formatTaskDocSummary(task.slug, doc));
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

      if (action === "tail") {
        const sessionId = args[0];

        if (!sessionId) {
          return failure("Session id is required");
        }

        const session = store.getSession(sessionId);

        if (!session) {
          return failure(`Session not found: ${sessionId}`, 1);
        }

        const limit = parseSessionTailLimit(args.slice(1));
        return success(
          getTranscriptAdapter(session.tool)
            .readTail({
              transcriptPath: session.transcriptPath,
              limit,
            })
            .map((message) => `${message.role}: ${message.text}\n`)
            .join(""),
        );
      }

      if (action === "scan" && args[0] === "--codex") {
        const codexHome = parseCodexScanArgs(args.slice(1), env);
        const sessions = scanCodexSessions(codexHome).map((session) =>
          store.registerSession({
            id: session.id,
            transcriptPath: session.transcriptPath,
            tool: session.tool,
            model: session.model,
            tokenTotals: session.tokenTotals,
          }),
        );

        return success(sessions.map(formatSessionSummary).join(""));
      }

      return usage();
    }

    if (resource === "skill") {
      if (action === "work-on-task") {
        const title = args[0];

        if (!title) {
          return failure("Task title is required");
        }

        // The skill's contract is title-based: resolve the exact title, or
        // create the task when absent. Keeping this in the CLI means the skill
        // is pure prose and any other tool wrapper inherits the same behaviour.
        const existingId = findTaskIdByTitle(store.listTasks(), title);
        const task = existingId
          ? store.getTask(existingId)
          : store.createTask(title, resolveProjectRoot(cwd));

        if (!task) {
          return failure(`Task not found: ${title}`, 1);
        }

        const parsed = parseSkillWorkOnTaskArgs(args.slice(1), env);
        const session = store.registerSession(parsed);

        const assigned = store.assignSession(session.id, task.id);

        return success(
          formatSkillWorkOnTaskResult(assigned, task, databasePath),
        );
      }

      if (action === "re-enter") {
        const title = args[0];

        if (!title) {
          return failure("Task title is required");
        }

        const taskId = findTaskIdByTitle(store.listTasks(), title);
        if (!taskId) {
          return failure(`Task not found: ${title}`, 1);
        }

        const manifest = store.getReEntryManifest(taskId);
        if (!manifest) {
          return failure(`Task not found: ${title}`, 1);
        }

        return success(formatReEntryManifest(manifest));
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

function findTaskIdByTitle(tasks: Task[], title: string): string | null {
  const normalized = title.trim();
  const match = tasks.find((task) => task.title === normalized);
  return match ? match.id : null;
}

function success(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr: string, exitCode = 2): CommandResult {
  return { exitCode, stdout: "", stderr: `${stderr}\n` };
}

function usage(): CommandResult {
  return failure(
    "Usage: trace init | trace task <create|show|list|add-doc|timeline> ... | trace session <register|assign|list|scan> ... | trace skill <work-on-task|re-enter> ...",
  );
}

function formatTask(
  task: Task,
  sessions: Session[] = [],
  docs: TaskDoc[] = [],
): string {
  const lines = [
    `slug: ${task.slug}`,
    `id: ${task.id}`,
    `title: ${task.title}`,
    `createdAt: ${task.createdAt}`,
    `projectRoot: ${task.projectRoot}`,
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
  return `${task.slug}\t${task.title}\n`;
}

function formatSessionSummary(session: Session): string {
  return `${session.id}\t${session.tool}\t${session.transcriptPath}\n`;
}

function formatSkillWorkOnTaskResult(
  session: Session,
  task: Task,
  databasePath: string,
): string {
  if (!session.taskId) {
    return formatSessionSummary(session);
  }

  // New tasks live under their slug-named docs directory; the slug is the
  // human-facing handle the skill prose tells agents to write docs into.
  return [
    formatSessionSummary(session).trimEnd(),
    `taskDocsDir: ${resolveTaskDocsDir(databasePath, task.slug)}`,
    "",
  ].join("\n");
}

function formatTaskDocSummary(taskRef: string, doc: TaskDoc): string {
  return `${taskRef}\t${doc.path}\n`;
}

function formatReEntryManifest(manifest: ReEntryManifest): string {
  const lines = [
    "task:",
    `  id: ${manifest.task.id}`,
    `  title: ${manifest.task.title}`,
    `  projectRoot: ${manifest.task.projectRoot}`,
  ];

  if (manifest.docs.length === 0) {
    lines.push("docs: []");
  } else {
    lines.push("docs:", ...manifest.docs.map((doc) => `- path: ${doc.path}`));
  }

  if (manifest.sessions.length === 0) {
    lines.push("sessions: []");
  } else {
    lines.push(
      "sessions:",
      ...manifest.sessions.flatMap((session) => [
        `- id: ${session.id}`,
        `  tool: ${session.tool}`,
        `  transcript: ${session.transcriptPath}`,
        `  mostRecent: ${session.isMostRecent ? "true" : "false"}`,
        ...(session.model ? [`  model: ${session.model}`] : []),
      ]),
    );
  }

  return [...lines, ""].join("\n");
}

function parseSessionRegisterArgs(args: string[]): {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  tokenTotals: Partial<TokenTotals>;
  model?: string | null;
} {
  let id: string | undefined;
  let transcriptPath: string | undefined;
  let tool: string | undefined;
  let model: string | null | undefined;
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
    } else if (flag === "--model") {
      model = value;
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

  return { id, transcriptPath, tool, model, tokenTotals };
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

function parseSessionTailLimit(args: string[]): number | undefined {
  if (args.length === 0) {
    return undefined;
  }

  if (args.length !== 2 || args[0] !== "--limit") {
    throw new Error("Session tail accepts --limit <count>");
  }

  return parseNonNegativeInteger(args[1] ?? "", "--limit");
}

function parseSkillWorkOnTaskArgs(
  args: string[],
  env: Record<string, string | undefined>,
): {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  model?: string;
  tokenTotals: Partial<TokenTotals>;
} {
  let id: string | undefined;
  let transcriptPath: string | undefined;
  let tool: string | undefined;
  let model: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (!flag || !value) {
      throw new Error(
        "Skill work-on-task accepts --id, --transcript, --tool, and --model",
      );
    }

    if (flag === "--id") {
      id = value;
    } else if (flag === "--transcript") {
      transcriptPath = value;
    } else if (flag === "--tool") {
      tool = value;
    } else if (flag === "--model") {
      model = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  let toolOverride: SessionTool | undefined;
  if (tool === undefined) {
    toolOverride = undefined;
  } else if (tool === "claude" || tool === "codex") {
    toolOverride = tool;
  } else {
    throw new Error("Session tool must be claude or codex");
  }

  // The env→session contract (which env var names the live session, transcript
  // path synthesis, legacy id fallbacks) lives in @trace/core; the CLI only
  // layers its explicit --id / --transcript / --tool flags on top as overrides.
  const identity = inferSessionIdentity(env, {
    tool: toolOverride,
    id,
    transcriptPath,
  });

  // transcriptPath is undefined exactly when id is undefined, so this single
  // guard narrows both to the strings the registration contract requires.
  if (identity.id === undefined || identity.transcriptPath === undefined) {
    throw new Error(
      "Skill work-on-task requires --id or a current session env var",
    );
  }

  return {
    id: identity.id,
    transcriptPath: identity.transcriptPath,
    tool: identity.tool,
    model,
    tokenTotals: {},
  };
}

// `process.argv[1]` is the invoked path, which `pnpm link --global` exposes as
// a symlink whose realpath is this entry. Compare resolved realpaths so the CLI
// runs whether it was launched directly or through the linked `trace` shim.
const invokedPath = process.argv[1];
const isDirectRun =
  invokedPath !== undefined &&
  safeRealpath(invokedPath) === fileURLToPath(import.meta.url);

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

if (isDirectRun) {
  const result = runTraceCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
