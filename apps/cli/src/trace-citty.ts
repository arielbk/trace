import { defineCommand } from "citty";
import type { CommandDef } from "citty";
import {
  getTranscriptAdapter,
  inferSessionIdentity,
  openTraceStore,
  resolveProjectRootArg,
  resolveTaskDocsDir,
  scanClaudeCodeSessions,
  scanCodexSessions,
  type ActiveTask,
  type ReEntryManifest,
  type Session,
  type SessionTool,
  type Task,
  type TaskDoc,
  type TokenTotals,
} from "@trace/core";
import { resolveFocusedComposer } from "@trace/cursor-reader";
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

function skillWorkOnTaskUsage(): string {
  return "Usage: trace skill work-on-task <title> [--id <id>] [--transcript <path>] [--tool <claude|codex>] [--model <name>] [--description <text>] [--project <dir>]";
}

function skillReEnterUsage(): string {
  return "Usage: trace skill re-enter <ref>";
}

function skillDocsDirUsage(): string {
  return "Usage: trace skill docs-dir [--id <session>] [--project <dir>]";
}

function recallCandidatesUsage(): string {
  return "Usage: trace skill recall-candidates [--project <dir>]";
}

function parseSkillWorkOnTaskArgs(
  args: string[],
  env: Env,
  cwd: string,
): {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  model?: string;
  tokenTotals: Partial<TokenTotals>;
  description?: string;
  project?: string;
} {
  let id: string | undefined;
  let transcriptPath: string | undefined;
  let tool: string | undefined;
  let model: string | undefined;
  let description: string | undefined;
  let project: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (!flag || !value) {
      throw new Error(
        "Skill work-on-task accepts --id, --transcript, --tool, --model, --description, and --project",
      );
    }

    if (flag === "--id") id = value;
    else if (flag === "--transcript") transcriptPath = value;
    else if (flag === "--tool") tool = value;
    else if (flag === "--model") model = value;
    else if (flag === "--description") description = value;
    else if (flag === "--project") project = value;
    else throw new Error(`Unknown option: ${flag}`);
  }

  let toolOverride: SessionTool | undefined;
  if (tool === undefined) {
    toolOverride = undefined;
  } else if (tool === "claude" || tool === "codex" || tool === "cursor") {
    toolOverride = tool;
  } else {
    throw new Error("Session tool must be claude, codex, or cursor");
  }

  const identity = inferSessionIdentity(env, {
    tool: toolOverride,
    id,
    transcriptPath,
    // Cursor exposes no session env var; bind-time capture resolves the focused
    // composer from the directory the skill ran in. Runs only when no
    // claude/codex session env is present (see inferSessionIdentity).
    cwd,
    resolveCursorComposer: (dir) =>
      resolveFocusedComposer(dir)?.composerId ?? null,
  });

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
    description,
    project,
  };
}

function parseRecallCandidatesArgs(args: string[]): string | undefined {
  let project: string | undefined;

  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(recallCandidatesUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  return project;
}

function parseSkillDocsDirArgs(args: string[]): { id?: string; project?: string } {
  let id: string | undefined;
  let project: string | undefined;

  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--id") {
      const value = args[index + 1];
      if (!value) throw new Error(skillDocsDirUsage());
      id = value;
      index += 2;
    } else if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(skillDocsDirUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  return { id, project };
}

function resolveSkillTaskRef(
  tasks: Task[],
  ref: string,
  getById: (id: string) => Task | null,
): Task | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;

  const byId = getById(trimmed);
  if (byId) return byId;

  const bySlug = tasks.find((task) => task.slug === trimmed);
  if (bySlug) return bySlug;

  const normalized = trimmed.toLowerCase();
  const byTitle = tasks.find(
    (task) => task.title.trim().toLowerCase() === normalized,
  );
  return byTitle ?? null;
}

function taskNotFoundMessage(tasks: Task[], ref: string): string {
  const needle = ref.trim().toLowerCase();
  const near = tasks
    .filter(
      (task) =>
        needle.length > 0 &&
        (task.slug.includes(needle) || task.title.toLowerCase().includes(needle)),
    )
    .slice(0, 5);

  const lines = [`Task not found: ${ref}`];
  if (near.length > 0) {
    lines.push("Near candidates:");
    for (const task of near) {
      lines.push(`  ${task.slug} — ${task.title}`);
    }
  }
  return lines.join("\n");
}

function formatSkillWorkOnTaskResult(
  session: Session,
  task: Task,
  databasePath: string,
): string {
  if (!session.taskId) {
    return formatSessionSummary(session);
  }

  return [
    formatSessionSummary(session).trimEnd(),
    `taskDocsDir: ${resolveTaskDocsDir(databasePath, task.slug)}`,
    "",
  ].join("\n");
}

function formatReEntryManifest(manifest: ReEntryManifest): string {
  const lines = [
    "task:",
    `  id: ${manifest.task.id}`,
    `  title: ${manifest.task.title}`,
    ...(manifest.task.description
      ? [`  description: ${manifest.task.description}`]
      : []),
    `  projectRoot: ${manifest.task.projectRoot}`,
  ];

  if (manifest.state) {
    lines.push("state:", `  path: ${manifest.state.path}`);
  }

  lines.push(`taskDocsDir: ${manifest.taskDocsDir}`);

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

      skill: defineCommand({
        meta: { description: "Trace skill helpers" },
        subCommands: {
          "work-on-task": defineCommand({
            meta: { description: "Bind current session to a task" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              if (isHelpFlag(args[0])) return success(`${skillWorkOnTaskUsage()}\n`);
              const titleError = rejectFlagTitle(args[0], "skill work-on-task");
              if (titleError) return titleError;

              const title = args[0];
              if (!title) return failure("Task title is required");

              let parsed: ReturnType<typeof parseSkillWorkOnTaskArgs>;
              try {
                parsed = parseSkillWorkOnTaskArgs(args.slice(1), env, cwd);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }

              const { description, project, ...registerInput } = parsed;

              let workOnTaskProjectRoot: string;
              try {
                workOnTaskProjectRoot = resolveProjectRootArg(project, cwd);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }

              return withStore(env, (store, databasePath) => {
                const session = store.registerSession(registerInput);

                const resolvedTask =
                  resolveSkillTaskRef(store.listTasks(), title, (id) =>
                    store.getTask(id),
                  ) ?? store.createTask(title, workOnTaskProjectRoot, description);

                const task = resolvedTask.archivedAt
                  ? store.unarchiveTask(resolvedTask.id)
                  : resolvedTask;

                const assigned = store.assignSession(session.id, task.id);

                return success(formatSkillWorkOnTaskResult(assigned, task, databasePath));
              });
            },
          }),

          "recall-candidates": defineCommand({
            meta: { description: "List recall candidates as JSON" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              let recallProject: string | undefined;
              try {
                recallProject = parseRecallCandidatesArgs(args);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }

              let recallProjectRoot: string;
              try {
                recallProjectRoot = resolveProjectRootArg(recallProject, cwd);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }

              return withStore(env, (store) => {
                const candidates = store.recallCandidates(recallProjectRoot);
                return success(`${JSON.stringify(candidates)}\n`);
              });
            },
          }),

          "re-enter": defineCommand({
            meta: { description: "Re-enter a task by ref" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              if (isHelpFlag(args[0])) return success(`${skillReEnterUsage()}\n`);
              const refError = rejectFlagTitle(args[0], "skill re-enter", "ref");
              if (refError) return refError;

              const ref = args[0];
              if (!ref) return failure("Task slug or title is required");

              return withStore(env, (store) => {
                const tasks = store.listTasks();
                const resolved = resolveSkillTaskRef(tasks, ref, (id) =>
                  store.getTask(id),
                );
                if (!resolved) return failure(taskNotFoundMessage(tasks, ref), 1);

                const manifest = store.getReEntryManifest(resolved.id);
                if (!manifest) return failure(taskNotFoundMessage(tasks, ref), 1);

                const identity = inferSessionIdentity(env, {});
                if (
                  identity.id !== undefined &&
                  identity.transcriptPath !== undefined
                ) {
                  const session = store.registerSession({
                    id: identity.id,
                    transcriptPath: identity.transcriptPath,
                    tool: identity.tool,
                  });
                  store.assignSession(session.id, resolved.id);
                }

                return success(formatReEntryManifest(manifest));
              });
            },
          }),

          "docs-dir": defineCommand({
            meta: { description: "Get the docs directory for the active task" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              if (isHelpFlag(args[0])) return success(`${skillDocsDirUsage()}\n`);

              let parsedDocsDir: { id?: string; project?: string };
              try {
                parsedDocsDir = parseSkillDocsDirArgs(args);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }

              const identity = inferSessionIdentity(env, { id: parsedDocsDir.id });
              if (identity.id === undefined) {
                return failure(
                  "Skill docs-dir requires --id or a current session env var",
                );
              }

              let docsDirProjectRoot: string;
              try {
                docsDirProjectRoot = resolveProjectRootArg(parsedDocsDir.project, cwd);
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error));
              }

              return withStore(env, (store, databasePath) => {
                const activeTask = store.resolveActiveTask(
                  identity.id as string,
                  docsDirProjectRoot,
                );

                if (activeTask.kind === "bound") {
                  return success(
                    `taskDocsDir: ${resolveTaskDocsDir(databasePath, activeTask.task.slug)}\n`,
                  );
                }

                if (activeTask.kind === "re-enter") {
                  return failure(
                    `Session is not bound to a task. Re-enter the most recent task with: trace skill re-enter ${activeTask.task.slug}`,
                    1,
                  );
                }

                return failure(
                  "Session is not bound to a task and the project has no task to re-enter. Bind one first with: trace skill work-on-task <title>",
                  1,
                );
              });
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
