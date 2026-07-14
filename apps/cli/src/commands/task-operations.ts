import {
  resolveDocTitle,
  resolveTaskDocsDir,
  updateStateManifest,
  type ManifestEntry,
  type Task,
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
import { basename, join, relative, resolve } from "node:path";
import {
  parseAddDocOptions,
  parseTaskCaptureArgs,
  parseTaskCreateArgs,
  parseTaskUpdateArgs,
  parseUpdateDocOptions,
  taskCaptureUsage,
  taskCreateUsage,
  taskUpdateUsage,
} from "./parsers.ts";
import {
  formatProjectResolution,
  formatTask,
  formatTaskDocSummary,
  formatTaskSummary,
} from "./formatters.ts";
import {
  attempt,
  failure,
  isHelpFlag,
  rejectFlagTitle,
  resolveProjectRoot,
  success,
  withStore,
  type CommandResult,
  type Env,
  type Store,
} from "./seam.ts";

export type CommandContext = { env: Env; cwd: string; stdin: string };

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "task"
  );
}

export function linkRepoDocs(projectRoot: string, title: string, docsDir: string): void {
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

// Read a doc's body for title resolution, returning null when it can't be read
// (missing file, external/symlinked path, permissions). A null body simply
// lets resolveDocTitle fall through to the filename.
function readDocContent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Re-render the task's machine-owned state.md manifest footer from the docs
// currently registered for the task. state.md is created when absent and is
// excluded from its own manifest.
export function renderTaskDocManifest(
  store: Store,
  databasePath: string,
  task: Task,
): void {
  const docsDir = resolveTaskDocsDir(databasePath, task.slug);
  const statePath = join(docsDir, "state.md");
  const entries = buildManifestEntries(store, databasePath, task);
  mkdirSync(docsDir, { recursive: true });
  updateStateManifest(statePath, task.title, entries);
}

// Reconcile the task's state.md footer, but only once the task has at least one
// non-state doc — an empty task should not sprout a bare manifest (mirroring the
// guard in `trace state check`). Idempotent (write-if-changed in
// `updateStateManifest`), so calling it on every bind is a safe no-op when the
// footer is already current.
export function reconcileStateFooter(
  store: Store,
  databasePath: string,
  task: Task,
): void {
  const hasNonStateDoc = store
    .listDocsForTask(task.id)
    .some((doc) => basename(doc.path) !== "state.md");
  if (hasNonStateDoc) {
    renderTaskDocManifest(store, databasePath, task);
  }
}

// Build the rendered manifest rows for a task's currently-registered non-state
// docs, resolving each display title through the shared fallback chain (explicit
// title → first H1 → filename) and reading the file body so the H1 branch can
// fire. state.md is excluded from its own manifest.
export function buildManifestEntries(
  store: Store,
  databasePath: string,
  task: Task,
): ManifestEntry[] {
  const docsDir = resolveTaskDocsDir(databasePath, task.slug);
  return store
    .listDocsForTask(task.id)
    .filter((doc) => basename(doc.path) !== "state.md")
    .map((doc) => ({
      label: resolveDocTitle(doc, readDocContent(doc.path)),
      href: relative(docsDir, doc.path) || basename(doc.path),
      ...(doc.description ? { description: doc.description } : {}),
    }));
}

export function taskCreateOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (isHelpFlag(rawArgs[0])) return success(`${taskCreateUsage()}\n`);
  const titleError = rejectFlagTitle(rawArgs[0], "task create");
  if (titleError) return titleError;

  const parsedAttempt = attempt(() => parseTaskCreateArgs(rawArgs));
  if (!parsedAttempt.ok) return parsedAttempt.result;
  const parsed = parsedAttempt.value;

  return withStore(ctx.env, (store) => {
    const projectRootAttempt = resolveProjectRoot(parsed.project, ctx.cwd, store);
    if (!projectRootAttempt.ok) return projectRootAttempt.result;
    const projectRoot = projectRootAttempt.value;
    const resolution = store.resolveProject(projectRoot);
    const task = store.createTask(parsed.title, projectRoot, parsed.description);
    return {
      exitCode: 0,
      stdout: `${task.slug}\n`,
      stderr: formatProjectResolution(resolution),
    };
  });
}

export function taskUpdateOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (isHelpFlag(rawArgs[0])) return success(`${taskUpdateUsage()}\n`);

  const parsedAttempt = attempt(() => parseTaskUpdateArgs(rawArgs));
  if (!parsedAttempt.ok) return parsedAttempt.result;
  const parsed = parsedAttempt.value;

  return withStore(ctx.env, (store) => {
    const taskAttempt = attempt(() => {
      // The parser guarantees at least one flag. Title first, so a combined
      // call returns the retitled task from the description update's fresh
      // read.
      let task: Task | null =
        parsed.title !== undefined
          ? store.updateTaskTitle(parsed.ref, parsed.title)
          : null;
      if (parsed.description !== undefined) {
        task = store.updateTaskDescription(parsed.ref, parsed.description);
      }
      if (!task) throw new Error(taskUpdateUsage());
      return task;
    }, 1);
    if (!taskAttempt.ok) return taskAttempt.result;
    const task = taskAttempt.value;
    return success(
      formatTask(task, store.listSessionsForTask(task.id), store.listDocsForTask(task.id)),
    );
  });
}

export function taskCaptureOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (isHelpFlag(rawArgs[0])) return success(`${taskCaptureUsage()}\n`);
  const titleError = rejectFlagTitle(rawArgs[0], "task capture");
  if (titleError) return titleError;

  const parsedAttempt = attempt(() => parseTaskCaptureArgs(rawArgs));
  if (!parsedAttempt.ok) return parsedAttempt.result;
  const parsed = parsedAttempt.value;

  return withStore(ctx.env, (store, databasePath) => {
    const projectRootAttempt = resolveProjectRoot(parsed.project, ctx.cwd, store);
    if (!projectRootAttempt.ok) return projectRootAttempt.result;
    const projectRoot = projectRootAttempt.value;
    const resolution = store.resolveProject(projectRoot);
    const contents = parsed.docPath
      ? readFileSync(parsed.docPath, "utf8")
      : ctx.stdin || readFileSync(0, "utf8");
    const docFileName = parsed.docPath ? basename(parsed.docPath) : "capture.md";

    const task = store.createTask(parsed.title, projectRoot);
    const docsDir = resolveTaskDocsDir(databasePath, task.slug);
    mkdirSync(docsDir, { recursive: true });
    const docPath = join(docsDir, docFileName);
    if (parsed.docPath) {
      copyFileSync(parsed.docPath, docPath);
    } else {
      writeFileSync(docPath, contents);
    }

    store.addTaskDoc(task.id, docPath, {
      title: parsed.docTitle ?? parsed.title,
      description: parsed.description,
    });

    if (parsed.link) {
      linkRepoDocs(projectRoot, parsed.title, docsDir);
    }

    if (parsed.description === undefined) {
      return {
        exitCode: 0,
        stdout: `${task.id}\n`,
        stderr: `${formatProjectResolution(resolution)}Reminder: no --description given; add one with \`task update-doc\` so the doc reads well in the manifest.\n`,
      };
    }

    return {
      exitCode: 0,
      stdout: `${task.id}\n`,
      stderr: formatProjectResolution(resolution),
    };
  });
}

export function taskShowOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  const id = rawArgs[0];
  if (!id) return failure("Task id is required");

  return withStore(ctx.env, (store) => {
    const task = store.getTaskByRef(id);
    if (!task) return failure(`Task not found: ${id}`, 1);
    return success(
      formatTask(task, store.listSessionsForTask(task.id), store.listDocsForTask(task.id)),
    );
  });
}

export function taskListOperation(
  _rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  return withStore(ctx.env, (store) => {
    return success(store.listTasks().map(formatTaskSummary).join(""));
  });
}

export function taskTimelineOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  const id = rawArgs[0];
  const format = rawArgs[1];

  if (!id) return failure("Task id is required");
  if (format !== "--json") return failure("Task timeline currently requires --json");

  return withStore(ctx.env, (store) => {
    const timeline = store.getTaskTimeline(id);
    if (!timeline) return failure(`Task not found: ${id}`, 1);
    return success(`${JSON.stringify(timeline)}\n`);
  });
}

export function taskAddDocOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  const taskId = rawArgs[0];
  const path = rawArgs[1];

  if (!taskId) return failure("Task id is required");
  if (!path) return failure("Task doc path is required");

  const optionsAttempt = attempt(() => parseAddDocOptions(rawArgs.slice(2)));
  if (!optionsAttempt.ok) return optionsAttempt.result;
  const options = optionsAttempt.value;

  return withStore(ctx.env, (store, databasePath) => {
    const task = store.getTaskByRef(taskId);
    if (!task) return failure(`Task not found: ${taskId}`, 1);
    // Canonicalize before storing: the filesystem scan reports absolute
    // paths, so a relative registration of the same file would list twice.
    const doc = store.addTaskDoc(task.id, resolve(ctx.cwd, path), options);
    renderTaskDocManifest(store, databasePath, task);
    return success(formatTaskDocSummary(task.slug, doc));
  });
}

export function taskUpdateDocOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  const taskId = rawArgs[0];
  const path = rawArgs[1];

  if (!taskId) return failure("Task id is required");
  if (!path) return failure("Task doc path is required");

  const optionsAttempt = attempt(() => parseUpdateDocOptions(rawArgs.slice(2)));
  if (!optionsAttempt.ok) return optionsAttempt.result;
  const options = optionsAttempt.value;

  return withStore(ctx.env, (store, databasePath) => {
    const task = store.getTaskByRef(taskId);
    if (!task) return failure(`Task not found: ${taskId}`, 1);
    const doc = store.updateTaskDoc(task.id, resolve(ctx.cwd, path), options);
    renderTaskDocManifest(store, databasePath, task);
    return success(formatTaskDocSummary(task.slug, doc));
  });
}
