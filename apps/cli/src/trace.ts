#!/usr/bin/env node
import {
  type ActiveTask,
  getTranscriptAdapter,
  inferSessionIdentity,
  openTraceStore,
  type ReEntryManifest,
  resolveProjectRootArg,
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
import { openBrowser, startTraceServe } from "./serve.ts";
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

  if (resource === "serve") {
    // Long-running: the HTTP server keeps the event loop alive after we return,
    // so the process stays up until Ctrl-C. We resolve the URL asynchronously
    // and print it; the empty CommandResult just lets the caller fall through.
    startTraceServe(env)
      .then(({ url }) => {
        process.stdout.write(`trace serve listening on ${url}\n`);
        openBrowser(url);
      })
      .catch((error) => {
        process.stderr.write(
          `trace serve failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        process.exitCode = 1;
      });
    return success("");
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

        const titleError = rejectFlagTitle(args[0], "task create");
        if (titleError) return titleError;

        let parsedCreate: {
          title: string;
          description?: string;
          project?: string;
        };
        try {
          parsedCreate = parseTaskCreateArgs(args);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }

        let createProjectRoot: string;
        try {
          createProjectRoot = resolveProjectRootArg(parsedCreate.project, cwd);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }

        const task = store.createTask(
          parsedCreate.title,
          createProjectRoot,
          parsedCreate.description,
        );

        return success(`${task.slug}\n`);
      }

      if (action === "update") {
        if (isHelpFlag(args[0])) {
          return success(`${taskUpdateUsage()}\n`);
        }

        let parsedUpdate: { ref: string; description: string };
        try {
          parsedUpdate = parseTaskUpdateArgs(args);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }

        let task: Task;
        try {
          task = store.updateTaskDescription(
            parsedUpdate.ref,
            parsedUpdate.description,
          );
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
            1,
          );
        }

        return success(
          formatTask(
            task,
            store.listSessionsForTask(task.id),
            store.listDocsForTask(task.id),
          ),
        );
      }

      if (action === "capture") {
        if (isHelpFlag(args[0])) {
          return success(`${taskCaptureUsage()}\n`);
        }

        const titleError = rejectFlagTitle(args[0], "task capture");
        if (titleError) return titleError;

        let parsed: {
          title: string;
          docPath?: string;
          link: boolean;
          project?: string;
        };
        try {
          parsed = parseTaskCaptureArgs(args);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }

        let projectRoot: string;
        try {
          projectRoot = resolveProjectRootArg(parsed.project, cwd);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }

        const contents = parsed.docPath
          ? readFileSync(parsed.docPath, "utf8")
          : readFileSync(0, "utf8");
        const docFileName = parsed.docPath
          ? basename(parsed.docPath)
          : "capture.md";

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

      if (action === "active-task") {
        let parsedActiveTask: { id: string; project?: string };
        try {
          parsedActiveTask = parseSessionActiveTaskArgs(args);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }

        let activeTaskProjectRoot: string;
        try {
          activeTaskProjectRoot = resolveProjectRootArg(
            parsedActiveTask.project,
            cwd,
          );
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }

        // The read-side query the SessionStart hook calls to decide its nudge:
        // the session's bound task, else the project's most recent unarchived
        // task to re-enter, else none. Emitted as JSON — the hook's only caller
        // — reduced to the title/slug the nudge needs. `--project` overrides
        // where the project root resolves from; see `resolveProjectRootArg`.
        const activeTask = store.resolveActiveTask(
          parsedActiveTask.id,
          activeTaskProjectRoot,
        );

        return success(`${JSON.stringify(formatActiveTask(activeTask))}\n`);
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
        if (isHelpFlag(args[0])) {
          return success(`${skillWorkOnTaskUsage()}\n`);
        }

        const titleError = rejectFlagTitle(args[0], "skill work-on-task");
        if (titleError) return titleError;

        const title = args[0];

        if (!title) {
          return failure("Task title is required");
        }

        let parsedWorkOnTask: ReturnType<typeof parseSkillWorkOnTaskArgs>;
        try {
          parsedWorkOnTask = parseSkillWorkOnTaskArgs(args.slice(1), env);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }
        const { description, project, ...registerInput } = parsedWorkOnTask;

        let workOnTaskProjectRoot: string;
        try {
          workOnTaskProjectRoot = resolveProjectRootArg(project, cwd);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }

        // Register the session before touching tasks: create-or-bind must be
        // atomic, and an unbound session is a normal state to leave behind on
        // failure where an unbound (orphan) task is not. Registration is
        // idempotent, so a retry after a task-side failure is harmless.
        const session = store.registerSession(registerInput);

        // The skill resolves the ref like re-enter does (slug-first, then
        // normalized title), and creates the task only when nothing matches.
        // Keeping this in the CLI means the skill is pure prose and any other
        // tool wrapper inherits the same behaviour. A `--description` only
        // seeds a freshly created task; tending an existing task's
        // description is the re-enter drift protocol's job. New tasks land in
        // the resolved project root, which honours the `--project` override.
        const resolvedTask =
          resolveSkillTaskRef(store.listTasks(), title, (id) =>
            store.getTask(id),
          ) ?? store.createTask(title, workOnTaskProjectRoot, description);

        const task = resolvedTask.archivedAt
          ? store.unarchiveTask(resolvedTask.id)
          : resolvedTask;

        const assigned = store.assignSession(session.id, task.id);

        return success(
          formatSkillWorkOnTaskResult(assigned, task, databasePath),
        );
      }

      if (action === "recall-candidates") {
        let recallProject: string | undefined;
        try {
          recallProject = parseRecallCandidatesArgs(args);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }

        let recallProjectRoot: string;
        try {
          recallProjectRoot = resolveProjectRootArg(recallProject, cwd);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }

        // The candidate pool the recall skill resolves a vague reference
        // against: the resolved project's unarchived tasks, emitted as JSON so
        // the skill hands it straight to the agent. `--project` overrides where
        // that project root is resolved from; see `resolveProjectRootArg`.
        const candidates = store.recallCandidates(recallProjectRoot);
        return success(`${JSON.stringify(candidates)}\n`);
      }

      if (action === "re-enter") {
        if (isHelpFlag(args[0])) {
          return success(`${skillReEnterUsage()}\n`);
        }

        const refError = rejectFlagTitle(args[0], "skill re-enter", "ref");
        if (refError) return refError;

        const ref = args[0];

        if (!ref) {
          return failure("Task slug or title is required");
        }

        const tasks = store.listTasks();
        const resolved = resolveSkillTaskRef(tasks, ref, (id) =>
          store.getTask(id),
        );
        if (!resolved) {
          return failure(taskNotFoundMessage(tasks, ref), 1);
        }

        const manifest = store.getReEntryManifest(resolved.id);
        if (!manifest) {
          return failure(taskNotFoundMessage(tasks, ref), 1);
        }

        return success(formatReEntryManifest(manifest));
      }

      if (action === "docs-dir") {
        if (isHelpFlag(args[0])) {
          return success(`${skillDocsDirUsage()}\n`);
        }

        let parsedDocsDir: { id?: string; project?: string };
        try {
          parsedDocsDir = parseSkillDocsDirArgs(args);
        } catch (error) {
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }

        // The session is inferred the same way the binding verbs infer it, so
        // an agent running inside a live session can omit --id; the env→session
        // contract lives in @trace/core. docs-dir only reads, so it needs the
        // id alone (no transcript path).
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
          return failure(
            error instanceof Error ? error.message : String(error),
          );
        }

        // Resolve the docs dir from the live session→task binding rather than
        // anything in the conversation: only a bound session has a settled
        // home. An unbound session is not an error to swallow — it needs a
        // bind decision first, so we exit non-zero with the actionable next
        // step (re-enter the offered task, or create one with work-on-task).
        const activeTask = store.resolveActiveTask(
          identity.id,
          docsDirProjectRoot,
        );

        if (activeTask.kind === "bound") {
          return success(
            `taskDocsDir: ${
              resolveTaskDocsDir(databasePath, activeTask.task.slug)
            }\n`,
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

// Skill verbs resolve a ref slug-first (ids too — agents occasionally hand
// back a task id from docs paths or handoff notes), then fall back to a
// normalized-exact title match (trimmed, case-insensitive). Anything vaguer
// is the recall skill's job.
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

// A miss lists near candidates — tasks whose slug or title contains the
// query (plain containment, no fuzzy semantics) — so the caller can correct
// the ref without a separate lookup.
function taskNotFoundMessage(tasks: Task[], ref: string): string {
  const needle = ref.trim().toLowerCase();
  const near = tasks
    .filter(
      (task) =>
        needle.length > 0 &&
        (task.slug.includes(needle) ||
          task.title.toLowerCase().includes(needle)),
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

function success(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr: string, exitCode = 2): CommandResult {
  return { exitCode, stdout: "", stderr: `${stderr}\n` };
}

function usage(): CommandResult {
  return failure(
    "Usage: trace init | trace serve | trace task <create|update|capture|show|list|add-doc|timeline> ... | trace session <register|assign|active-task|list|scan> ... | trace skill <work-on-task|re-enter|recall-candidates|docs-dir> ...",
  );
}

function isHelpFlag(token: string | undefined): boolean {
  return token === "--help" || token === "-h";
}

function looksLikeFlag(token: string | undefined): boolean {
  return token !== undefined && token.startsWith("-");
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

// Docs-dir takes no positional args — only an optional `--id <session>` (which
// inferSessionIdentity layers over the env) and a `--project <dir>` override
// (resolved via resolveProjectRootArg).
function parseSkillDocsDirArgs(args: string[]): {
  id?: string;
  project?: string;
} {
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

function taskCreateUsage(): string {
  return "Usage: trace task create <title> [--description <text>] [--project <dir>]";
}

// Create takes a free-text title plus optional `--description <text>` and
// `--project <dir>` flags. The title is the run of leading words before the
// first flag, so a multi-word title without quotes still works (mirroring
// `task capture`). `--project` overrides where the task's project root is
// resolved from; see `resolveProjectRootArg`.
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
  if (title.length === 0) {
    throw new Error(taskCreateUsage());
  }

  return { title, description, project };
}

function taskUpdateUsage(): string {
  return "Usage: trace task update <ref> --description <text>";
}

// Update takes a single ref (id or slug) followed by a required
// `--description <text>` flag. The ref is the run of leading words before the
// first flag, mirroring `task create`.
function parseTaskUpdateArgs(args: string[]): {
  ref: string;
  description: string;
} {
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
  if (ref.length === 0 || description === undefined) {
    throw new Error(taskUpdateUsage());
  }

  return { ref, description };
}

function taskCaptureUsage(): string {
  return "Usage: trace task capture <title> [--doc <path>] [--link] [--project <dir>]";
}

// Capture takes a free-text title plus optional `--doc <path>`, `--link`, and
// `--project <dir>` flags. The title is the run of leading words before the
// first flag, so a multi-word title without quotes still works (mirroring
// `task create`). `--project` overrides where the task's project root is
// resolved from; see `resolveProjectRootArg`.
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
  if (title.length === 0) {
    throw new Error(taskCaptureUsage());
  }

  return { title, docPath, link, project };
}

function recallCandidatesUsage(): string {
  return "Usage: trace skill recall-candidates [--project <dir>]";
}

// Recall-candidates takes no positional args — only an optional `--project
// <dir>` flag that overrides where the candidate pool's project root is
// resolved from; see `resolveProjectRootArg`.
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
    throw new Error(
      `docs path already exists and is not a symlink: ${linkPath}`,
    );
  }

  symlinkSync(docsDir, linkPath);
}

// A title (or ref) that starts with `-` is almost always a mistyped flag rather
// than the work the user meant to name, so reject it with usage rather than
// persisting a task titled `--help` or running a junk ref through resolution.
// `command` is the full sub-command label (e.g. `task create`, `skill
// work-on-task`); `noun` is what the positional argument is called. Help flags
// are handled by the caller before this point.
function rejectFlagTitle(
  token: string | undefined,
  command: string,
  noun = "title",
): CommandResult | null {
  if (!looksLikeFlag(token)) return null;
  return failure(`Usage: trace ${command} <${noun}>`);
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
    ...(task.description ? [`description: ${task.description}`] : []),
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
    ...(manifest.task.description
      ? [`  description: ${manifest.task.description}`]
      : []),
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

function sessionActiveTaskUsage(): string {
  return "Usage: trace session active-task --id <session-id> [--project <dir>]";
}

// Active-task takes a required `--id <session-id>` and an optional `--project
// <dir>` override (resolved via resolveProjectRootArg). The hook passes the
// session id it just registered and lets the project root resolve from cwd.
function parseSessionActiveTaskArgs(args: string[]): {
  id: string;
  project?: string;
} {
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

  if (!id) {
    throw new Error(sessionActiveTaskUsage());
  }

  return { id, project };
}

function formatActiveTask(
  activeTask: ActiveTask,
):
  | { kind: "none" }
  | { kind: "bound" | "re-enter"; task: { title: string; slug: string } } {
  if (activeTask.kind === "none") {
    return { kind: "none" };
  }
  return {
    kind: activeTask.kind,
    task: { title: activeTask.task.title, slug: activeTask.task.slug },
  };
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
    throw new Error(
      "Claude scan requires --projects-root when HOME is not set",
    );
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

    if (flag === "--id") {
      id = value;
    } else if (flag === "--transcript") {
      transcriptPath = value;
    } else if (flag === "--tool") {
      tool = value;
    } else if (flag === "--model") {
      model = value;
    } else if (flag === "--description") {
      description = value;
    } else if (flag === "--project") {
      project = value;
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
    description,
    project,
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
