import { defineCommand } from "citty";
import type { CommandDef } from "citty";
import {
  getTranscriptAdapter,
  openTraceStore,
  resolveProjectRootArg,
  resolveTaskDocsDir,
  scanClaudeCodeSessions,
  scanCodexSessions,
  type ActiveTask,
  type Session,
  type SessionTool,
  type Task,
  type TaskDoc,
  type TokenTotals,
} from "@trace/core";
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
import { resolveDbPath } from "./db-path.ts";
import { runInit } from "./installer.ts";
import { openBrowser, startTraceServe } from "./serve.ts";
import { runClaudeSessionStartHook } from "./claude-session-start-hook-runner.ts";

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type Env = Record<string, string | undefined>;
type Store = ReturnType<typeof openTraceStore>;

function success(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr: string, exitCode = 2): CommandResult {
  return { exitCode, stdout: "", stderr: `${stderr}\n` };
}

function isHelpFlag(token: string | undefined): boolean {
  return token === "--help" || token === "-h";
}

function looksLikeFlag(token: string | undefined): boolean {
  return token !== undefined && token.startsWith("-");
}

function rejectFlagTitle(
  token: string | undefined,
  command: string,
  noun = "title",
): CommandResult | null {
  if (!looksLikeFlag(token)) return null;
  return failure(`Usage: trace ${command} <${noun}>`);
}

function withStore(
  env: Env,
  callback: (store: Store, databasePath: string) => CommandResult,
): CommandResult {
  let databasePath: string;
  try {
    databasePath = resolveDbPath(env);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  const store = openTraceStore(databasePath);
  try {
    return callback(store, databasePath);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  } finally {
    store.close();
  }
}

function taskCreateUsage(): string {
  return "Usage: trace task create <title> [--description <text>] [--project <dir>]";
}

function parseTaskCreateArgs(args: string[]): {
  title: string;
  description?: string;
  project?: string;
} {
  const titleWords: string[] = [];
  let description: string | undefined;
  let project: string | undefined;

  let index = 0;
  while (index < args.length && !looksLikeFlag(args[index])) {
    titleWords.push(args[index] as string);
    index += 1;
  }
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--description") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCreateUsage());
      description = value;
      index += 2;
    } else if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCreateUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  const title = titleWords.join(" ");
  if (title.length === 0) throw new Error(taskCreateUsage());
  return { title, description, project };
}

function taskUpdateUsage(): string {
  return "Usage: trace task update <ref> --description <text>";
}

function parseTaskUpdateArgs(args: string[]): { ref: string; description: string } {
  const refWords: string[] = [];
  let description: string | undefined;

  let index = 0;
  while (index < args.length && !looksLikeFlag(args[index])) {
    refWords.push(args[index] as string);
    index += 1;
  }
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--description") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(taskUpdateUsage());
      description = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  const ref = refWords.join(" ");
  if (ref.length === 0 || description === undefined) throw new Error(taskUpdateUsage());
  return { ref, description };
}

function taskCaptureUsage(): string {
  return "Usage: trace task capture <title> [--doc <path>] [--link] [--project <dir>]";
}

function parseTaskCaptureArgs(args: string[]): {
  title: string;
  docPath?: string;
  link: boolean;
  project?: string;
} {
  const titleWords: string[] = [];
  let docPath: string | undefined;
  let link = false;
  let project: string | undefined;

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
    } else if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCaptureUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  const title = titleWords.join(" ");
  if (title.length === 0) throw new Error(taskCaptureUsage());
  return { title, docPath, link, project };
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

function linkRepoDocs(projectRoot: string, title: string, docsDir: string): void {
  const linkPath = join(projectRoot, "docs", slugify(title));
  mkdirSync(join(projectRoot, "docs"), { recursive: true });

  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(linkPath);
  } catch {
    existing = null;
  }

  if (existing?.isSymbolicLink()) {
    if (realpathSync(linkPath) === realpathSync(docsDir)) return;
    rmSync(linkPath);
  } else if (existing) {
    throw new Error(`docs path already exists and is not a symlink: ${linkPath}`);
  }

  symlinkSync(docsDir, linkPath);
}

function formatTask(task: Task, sessions: Session[] = [], docs: TaskDoc[] = []): string {
  const lines = [
    `slug: ${task.slug}`,
    `id: ${task.id}`,
    `title: ${task.title}`,
    ...(task.description ? [`description: ${task.description}`] : []),
    `createdAt: ${task.createdAt}`,
    `projectRoot: ${task.projectRoot}`,
  ];

  if (sessions.length > 0) {
    lines.push(
      "sessions:",
      ...sessions.map((session) => `- ${formatSessionSummary(session).trimEnd()}`),
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

function formatTaskDocSummary(taskRef: string, doc: TaskDoc): string {
  return `${taskRef}\t${doc.path}\n`;
}

function formatActiveTask(
  activeTask: ActiveTask,
): { kind: "none" } | { kind: "bound" | "re-enter"; task: { title: string; slug: string } } {
  if (activeTask.kind === "none") return { kind: "none" };
  return { kind: activeTask.kind, task: { title: activeTask.task.title, slug: activeTask.task.slug } };
}

function parseNonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
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

    if (!flag || !value) throw new Error("Session register requires --id, --transcript, and --tool");

    if (flag === "--id") id = value;
    else if (flag === "--transcript") transcriptPath = value;
    else if (flag === "--tool") tool = value;
    else if (flag === "--model") model = value;
    else if (flag === "--input-tokens") tokenTotals.inputTokens = parseNonNegativeInteger(value, flag);
    else if (flag === "--output-tokens") tokenTotals.outputTokens = parseNonNegativeInteger(value, flag);
    else if (flag === "--cache-creation-input-tokens") tokenTotals.cacheCreationInputTokens = parseNonNegativeInteger(value, flag);
    else if (flag === "--cache-read-input-tokens") tokenTotals.cacheReadInputTokens = parseNonNegativeInteger(value, flag);
    else if (flag === "--total-tokens") tokenTotals.totalTokens = parseNonNegativeInteger(value, flag);
    else throw new Error(`Unknown option: ${flag}`);
  }

  if (!id || !transcriptPath || !tool) throw new Error("Session register requires --id, --transcript, and --tool");
  if (tool !== "claude" && tool !== "codex") throw new Error("Session tool must be claude or codex");

  return { id, transcriptPath, tool, model, tokenTotals };
}

function sessionActiveTaskUsage(): string {
  return "Usage: trace session active-task --id <session-id> [--project <dir>]";
}

function parseSessionActiveTaskArgs(args: string[]): { id: string; project?: string } {
  let id: string | undefined;
  let project: string | undefined;

  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--id") {
      const value = args[index + 1];
      if (!value) throw new Error(sessionActiveTaskUsage());
      id = value;
      index += 2;
    } else if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(sessionActiveTaskUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (!id) throw new Error(sessionActiveTaskUsage());
  return { id, project };
}

function parseSessionTailLimit(args: string[]): number | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--limit") throw new Error("Session tail accepts --limit <count>");
  return parseNonNegativeInteger(args[1] ?? "", "--limit");
}

function parseCodexScanArgs(args: string[], env: Env): string {
  let codexHome = env.CODEX_HOME;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value) throw new Error("Codex scan accepts --codex-home <path>");
    if (flag === "--codex-home") codexHome = value;
    else throw new Error(`Unknown option: ${flag}`);
  }

  if (codexHome) return codexHome;
  if (!env.HOME) throw new Error("Codex scan requires --codex-home when HOME is not set");
  return `${env.HOME}/.codex`;
}

function parseClaudeScanArgs(args: string[], env: Env): string {
  let projectsRoot: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value) throw new Error("Claude scan accepts --projects-root <path>");
    if (flag === "--projects-root") projectsRoot = value;
    else throw new Error(`Unknown option: ${flag}`);
  }

  if (projectsRoot) return projectsRoot;
  if (!env.HOME) throw new Error("Claude scan requires --projects-root when HOME is not set");
  return `${env.HOME}/.claude/projects`;
}

// Builds the citty root command tree for a single invocation.
// run() handlers return CommandResult directly; citty types run as `any`
// so this is sound at runtime even though it looks like a type override.
export function buildTraceCittyRoot(
  env: Env,
  cwd: string,
  stdin: string,
): CommandDef {
  return defineCommand({
    meta: { name: "trace", description: "Trace task manager" },
    subCommands: {
      init: defineCommand({
        meta: { description: "Install Trace into Claude Code" },
        run(): CommandResult {
          return success(runInit(env, cwd));
        },
      }),

      serve: defineCommand({
        meta: { description: "Start the Trace web UI" },
        run(): CommandResult {
          startTraceServe(env)
            .then(({ url }) => {
              process.stdout.write(`trace serve listening on ${url}\n`);
              openBrowser(url);
            })
            .catch((error: unknown) => {
              process.stderr.write(
                `trace serve failed: ${
                  error instanceof Error ? error.message : String(error)
                }\n`,
              );
              process.exitCode = 1;
            });
          return success("");
        },
      }),

      hook: defineCommand({
        meta: { description: "Trace hook handlers" },
        subCommands: {
          "session-start": defineCommand({
            meta: { description: "Register a new Claude session on start" },
            run(): CommandResult {
              return runClaudeSessionStartHook(stdin, env) as unknown as CommandResult;
            },
          }),
        },
      }),

      task: defineCommand({
        meta: { description: "Manage tasks" },
        subCommands: {
          create: defineCommand({
            meta: { description: "Create a new task" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              if (isHelpFlag(args[0])) return success(`${taskCreateUsage()}\n`);
              const titleError = rejectFlagTitle(args[0], "task create");
              if (titleError) return titleError;

              let parsed: { title: string; description?: string; project?: string };
              try {
                parsed = parseTaskCreateArgs(args);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }

              let projectRoot: string;
              try {
                projectRoot = resolveProjectRootArg(parsed.project, cwd);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }

              return withStore(env, (store) => {
                const task = store.createTask(parsed.title, projectRoot, parsed.description);
                return success(`${task.slug}\n`);
              });
            },
          }),

          update: defineCommand({
            meta: { description: "Update a task description" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              if (isHelpFlag(args[0])) return success(`${taskUpdateUsage()}\n`);

              let parsed: { ref: string; description: string };
              try {
                parsed = parseTaskUpdateArgs(args);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }

              return withStore(env, (store) => {
                let task: Task;
                try {
                  task = store.updateTaskDescription(parsed.ref, parsed.description);
                } catch (error) {
                  return failure(error instanceof Error ? error.message : String(error), 1);
                }
                return success(
                  formatTask(task, store.listSessionsForTask(task.id), store.listDocsForTask(task.id)),
                );
              });
            },
          }),

          capture: defineCommand({
            meta: { description: "Capture a document as a new task" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              if (isHelpFlag(args[0])) return success(`${taskCaptureUsage()}\n`);
              const titleError = rejectFlagTitle(args[0], "task capture");
              if (titleError) return titleError;

              let parsed: { title: string; docPath?: string; link: boolean; project?: string };
              try {
                parsed = parseTaskCaptureArgs(args);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }

              let projectRoot: string;
              try {
                projectRoot = resolveProjectRootArg(parsed.project, cwd);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }

              return withStore(env, (store, databasePath) => {
                const contents = parsed.docPath
                  ? readFileSync(parsed.docPath, "utf8")
                  : readFileSync(0, "utf8");
                const docFileName = parsed.docPath ? basename(parsed.docPath) : "capture.md";

                const task = store.createTask(parsed.title, projectRoot);
                const docsDir = resolveTaskDocsDir(databasePath, task.id);
                mkdirSync(docsDir, { recursive: true });
                const docPath = join(docsDir, docFileName);
                if (parsed.docPath) {
                  copyFileSync(parsed.docPath, docPath);
                } else {
                  writeFileSync(docPath, contents);
                }

                store.addTaskDoc(task.id, docPath);

                if (parsed.link) {
                  linkRepoDocs(projectRoot, parsed.title, docsDir);
                }

                return success(`${task.id}\n`);
              });
            },
          }),

          show: defineCommand({
            meta: { description: "Show task details" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              const id = args[0];
              if (!id) return failure("Task id is required");

              return withStore(env, (store) => {
                const task = store.getTaskByRef(id);
                if (!task) return failure(`Task not found: ${id}`, 1);
                return success(
                  formatTask(task, store.listSessionsForTask(task.id), store.listDocsForTask(task.id)),
                );
              });
            },
          }),

          list: defineCommand({
            meta: { description: "List all tasks" },
            run(): CommandResult {
              return withStore(env, (store) => {
                return success(store.listTasks().map(formatTaskSummary).join(""));
              });
            },
          }),

          timeline: defineCommand({
            meta: { description: "Show task timeline as JSON" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              const id = args[0];
              const format = args[1];

              if (!id) return failure("Task id is required");
              if (format !== "--json") return failure("Task timeline currently requires --json");

              return withStore(env, (store) => {
                const timeline = store.getTaskTimeline(id);
                if (!timeline) return failure(`Task not found: ${id}`, 1);
                return success(`${JSON.stringify(timeline)}\n`);
              });
            },
          }),

          "add-doc": defineCommand({
            meta: { description: "Add a document to a task" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              const taskId = args[0];
              const path = args[1];

              if (!taskId) return failure("Task id is required");
              if (!path) return failure("Task doc path is required");

              return withStore(env, (store) => {
                const task = store.getTaskByRef(taskId);
                if (!task) return failure(`Task not found: ${taskId}`, 1);
                const doc = store.addTaskDoc(task.id, path);
                return success(formatTaskDocSummary(task.slug, doc));
              });
            },
          }),
        },
      }),

      session: defineCommand({
        meta: { description: "Manage sessions" },
        subCommands: {
          register: defineCommand({
            meta: { description: "Register a session" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              let parsed: {
                id: string;
                transcriptPath: string;
                tool: SessionTool;
                tokenTotals: Partial<TokenTotals>;
                model?: string | null;
              };
              try {
                parsed = parseSessionRegisterArgs(args);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }
              return withStore(env, (store) => {
                const session = store.registerSession(parsed);
                return success(`${session.id}\n`);
              });
            },
          }),

          assign: defineCommand({
            meta: { description: "Assign a session to a task" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              const sessionId = args[0];
              const taskId = args[1];
              if (!sessionId) return failure("Session id is required");
              if (!taskId) return failure("Task id is required");
              return withStore(env, (store) => {
                const session = store.assignSession(sessionId, taskId);
                return success(formatSessionSummary(session));
              });
            },
          }),

          "active-task": defineCommand({
            meta: { description: "Get the active task for a session" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              let parsed: { id: string; project?: string };
              try {
                parsed = parseSessionActiveTaskArgs(args);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }
              let projectRoot: string;
              try {
                projectRoot = resolveProjectRootArg(parsed.project, cwd);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }
              return withStore(env, (store) => {
                const activeTask = store.resolveActiveTask(parsed.id, projectRoot);
                return success(`${JSON.stringify(formatActiveTask(activeTask))}\n`);
              });
            },
          }),

          list: defineCommand({
            meta: { description: "List sessions" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              if (args[0] !== "--unassigned") {
                return failure("Usage: trace session list --unassigned");
              }
              return withStore(env, (store) => {
                return success(store.listUnassignedSessions().map(formatSessionSummary).join(""));
              });
            },
          }),

          tail: defineCommand({
            meta: { description: "Read the tail of a session transcript" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              const sessionId = args[0];
              if (!sessionId) return failure("Session id is required");
              let limit: number | undefined;
              try {
                limit = parseSessionTailLimit(args.slice(1));
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }
              return withStore(env, (store) => {
                const session = store.getSession(sessionId);
                if (!session) return failure(`Session not found: ${sessionId}`, 1);
                return success(
                  getTranscriptAdapter(session.tool)
                    .readTail({ transcriptPath: session.transcriptPath, limit })
                    .map((message) => `${message.role}: ${message.text}\n`)
                    .join(""),
                );
              });
            },
          }),

          scan: defineCommand({
            meta: { description: "Scan for sessions" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              if (args[0] === "--codex") {
                let codexHome: string;
                try {
                  codexHome = parseCodexScanArgs(args.slice(1), env);
                } catch (error) {
                  return failure(error instanceof Error ? error.message : String(error));
                }
                return withStore(env, (store) => {
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
                });
              }

              if (args[0] === "--claude") {
                let projectsRoot: string;
                try {
                  projectsRoot = parseClaudeScanArgs(args.slice(1), env);
                } catch (error) {
                  return failure(error instanceof Error ? error.message : String(error));
                }
                return withStore(env, (store) => {
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
                });
              }

              return failure("Usage: trace session scan --codex | --claude");
            },
          }),
        },
      }),
    },
  });
}

// Walks the citty command tree synchronously and invokes the matching leaf.
// Returns CommandResult if the argv matched a known command path, null if
// no top-level token matched (caller should fall through to other handlers).
export function runCittyDispatch(
  root: CommandDef,
  argv: string[],
): CommandResult | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cmd: any = root;
  let remaining = [...argv];
  const matchedPath: string[] = [];

  while (remaining.length > 0) {
    const token = remaining[0];
    const subCmds = cmd.subCommands as Record<string, unknown> | undefined;
    if (!subCmds || !token || !subCmds[token]) break;
    cmd = subCmds[token];
    matchedPath.push(token as string);
    remaining = remaining.slice(1);
  }

  // Nothing matched at the top level — caller decides what to do.
  if (matchedPath.length === 0) return null;

  const subCmds = cmd.subCommands as Record<string, unknown> | undefined;

  // Matched a subtree but remaining token wasn't a known subcommand.
  if (subCmds && remaining.length > 0) {
    const knownCmds = Object.keys(subCmds).join("|");
    return failure(
      `Usage: trace ${matchedPath.join(" ")} <${knownCmds}>`,
    );
  }

  // Matched a group command (has subcommands) but no subcommand was given.
  if (!cmd.run && subCmds) {
    const knownCmds = Object.keys(subCmds).join("|");
    return failure(
      `Usage: trace ${matchedPath.join(" ")} <${knownCmds}>`,
    );
  }

  if (typeof cmd.run === "function") {
    return cmd.run({ args: remaining, rawArgs: remaining }) as CommandResult;
  }

  return null;
}
