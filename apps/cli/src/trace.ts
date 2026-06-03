#!/usr/bin/env node
import {
  getTranscriptAdapter,
  inferSessionIdentity,
  openTraceStore,
  type ReEntryManifest,
  resolveProjectRoot,
  resolveTaskDocsDir,
  scanClaudeCodeSessions,
  scanCodexSessions,
  type Session,
  type SessionTool,
  type Task,
  type TaskDoc,
  type TokenTotals,
} from "@trace/core";
import { resolveDbPath } from "./db-path.ts";
import { runInit } from "./installer.ts";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
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
        if (isHelpFlag(args[0])) {
          return success(`${taskCreateUsage()}\n`);
        }

        const titleError = rejectFlagTitle(args[0], "create");
        if (titleError) return titleError;

        const title = args.join(" ");
        const task = store.createTask(title, resolveProjectRoot(cwd));

        return success(`${task.id}\n`);
      }

      if (action === "capture") {
        if (isHelpFlag(args[0])) {
          return success(`${taskCaptureUsage()}\n`);
        }

        const titleError = rejectFlagTitle(args[0], "capture");
        if (titleError) return titleError;

        let parsed: { title: string; docPath?: string; link: boolean };
        try {
          parsed = parseTaskCaptureArgs(args);
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }

        const contents = parsed.docPath
          ? readFileSync(parsed.docPath, "utf8")
          : readFileSync(0, "utf8");
        const docFileName = parsed.docPath
          ? basename(parsed.docPath)
          : "capture.md";

        const projectRoot = resolveProjectRoot(cwd);
        const task = store.createTask(parsed.title, projectRoot);

        const docsDir = resolveTaskDocsDir(databasePath, task.id);
        mkdirSync(docsDir, { recursive: true });
        const docPath = join(docsDir, docFileName);
        if (parsed.docPath) {
          copyFileSync(parsed.docPath, docPath);
        } else {
          writeFileSync(docPath, contents);
        }

        if (parsed.link) {
          linkRepoDocs(projectRoot, parsed.title, docsDir);
        }

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

      if (action === "scan" && args[0] === "--claude") {
        const projectsRoot = parseClaudeScanArgs(args.slice(1), env);
        // Backfill shares the hook's registration path (store.registerSession),
        // so a scanned session and a hooked session can't diverge.
        const sessions = scanClaudeCodeSessions(projectsRoot).map((session) =>
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
        const taskId =
          findTaskIdByTitle(store.listTasks(), title) ??
          store.createTask(title, resolveProjectRoot(cwd)).id;

        const parsed = parseSkillWorkOnTaskArgs(args.slice(1), env);
        const session = store.registerSession(parsed);

        const assigned = store.assignSession(session.id, taskId);

        return success(formatSkillWorkOnTaskResult(assigned, databasePath));
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
    "Usage: trace init | trace task <create|capture|show|list|add-doc|timeline> ... | trace session <register|assign|list|scan> ... | trace skill <work-on-task|re-enter> ...",
  );
}

function isHelpFlag(token: string | undefined): boolean {
  return token === "--help" || token === "-h";
}

function looksLikeFlag(token: string | undefined): boolean {
  return token !== undefined && token.startsWith("-");
}

function taskCreateUsage(): string {
  return "Usage: trace task create <title>";
}

function taskCaptureUsage(): string {
  return "Usage: trace task capture <title> [--doc <path>] [--link]";
}

// Capture takes a free-text title plus optional `--doc <path>` and `--link`
// flags. The title is the run of leading words before the first flag, so a
// multi-word title without quotes still works (mirroring `task create`).
function parseTaskCaptureArgs(args: string[]): {
  title: string;
  docPath?: string;
  link: boolean;
} {
  const titleWords: string[] = [];
  let docPath: string | undefined;
  let link = false;

  let index = 0;
  while (index < args.length && !looksLikeFlag(args[index])) {
    titleWords.push(args[index] as string);
    index += 1;
  }

  while (index < args.length) {
    const flag = args[index];
    if (flag === "--doc") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCaptureUsage());
      docPath = value;
      index += 2;
    } else if (flag === "--link") {
      link = true;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  const title = titleWords.join(" ");
  if (title.length === 0) {
    throw new Error(taskCaptureUsage());
  }

  return { title, docPath, link };
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "task"
  );
}

// Follow the repo `docs/<slug>` → task-docs convention. Idempotent: if a link
// already sits at the target path it is replaced so re-capture re-points rather
// than throwing on an existing path.
function linkRepoDocs(
  projectRoot: string,
  title: string,
  docsDir: string,
): void {
  const linkPath = join(projectRoot, "docs", slugify(title));
  mkdirSync(join(projectRoot, "docs"), { recursive: true });

  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(linkPath);
  } catch {
    existing = null;
  }

  if (existing?.isSymbolicLink()) {
    if (realpathSync(linkPath) === realpathSync(docsDir)) {
      return;
    }
    rmSync(linkPath);
  } else if (existing) {
    throw new Error(`docs path already exists and is not a symlink: ${linkPath}`);
  }

  symlinkSync(docsDir, linkPath);
}

// A title that starts with `-` is almost always a mistyped flag rather than the
// work the user meant to name, so reject it with usage rather than persisting a
// task titled `--help`. Help flags are handled by the caller before this point.
function rejectFlagTitle(
  token: string | undefined,
  command: string,
): CommandResult | null {
  if (!looksLikeFlag(token)) return null;
  return failure(`Usage: trace task ${command} <title>`);
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
  return `${task.id}\t${task.title}\n`;
}

function formatSessionSummary(session: Session): string {
  return `${session.id}\t${session.tool}\t${session.transcriptPath}\n`;
}

function formatSkillWorkOnTaskResult(
  session: Session,
  databasePath: string,
): string {
  if (!session.taskId) {
    return formatSessionSummary(session);
  }

  return [
    formatSessionSummary(session).trimEnd(),
    `taskDocsDir: ${resolveTaskDocsDir(databasePath, session.taskId)}`,
    "",
  ].join("\n");
}

function formatTaskDocSummary(doc: TaskDoc): string {
  return `${doc.taskId}\t${doc.path}\n`;
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

function parseClaudeScanArgs(
  args: string[],
  env: Record<string, string | undefined>,
): string {
  let projectsRoot: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (!flag || !value) {
      throw new Error("Claude scan accepts --projects-root <path>");
    }

    if (flag === "--projects-root") {
      projectsRoot = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (projectsRoot) {
    return projectsRoot;
  }

  // Claude Code stores transcripts under <config-home>/projects. The default
  // config home is ~/.claude, but alternate homes (e.g. ~/.claude-infinum) are
  // common — pass --projects-root explicitly to scan those.
  if (!env.HOME) {
    throw new Error("Claude scan requires --projects-root when HOME is not set");
  }

  return `${env.HOME}/.claude/projects`;
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
