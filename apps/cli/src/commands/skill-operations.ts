import {
  discoverCodexSubagentSessions,
  discoverCursorSubagentSessions,
  resolveTaskDocsDir,
  type TaskStore,
} from "@trace/core";
import { inferCliSessionIdentity } from "./identity.ts";
import {
  parseRecallCandidatesArgs,
  parseSkillDocsDirArgs,
  parseSkillWorkOnTaskArgs,
  skillDocsDirUsage,
  skillReEnterUsage,
  skillWorkOnTaskUsage,
} from "./parsers.ts";
import {
  formatReEntryManifest,
  formatSkillWorkOnTaskResult,
  resolveSkillTaskRef,
  taskNotFoundMessage,
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
} from "./seam.ts";

export type CommandContext = { env: Env; cwd: string; stdin: string };

export function skillWorkOnTaskOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (isHelpFlag(rawArgs[0])) return success(`${skillWorkOnTaskUsage()}\n`);
  const titleError = rejectFlagTitle(rawArgs[0], "skill work-on-task");
  if (titleError) return titleError;

  const title = rawArgs[0];
  if (!title) return failure("Task title is required");

  const parsedAttempt = attempt(() =>
    parseSkillWorkOnTaskArgs(rawArgs.slice(1), ctx.env, ctx.cwd),
  );
  if (!parsedAttempt.ok) return parsedAttempt.result;
  const parsed = parsedAttempt.value;

  const { description, project, ...registerInput } = parsed;

  const projectRootAttempt = resolveProjectRoot(project, ctx.cwd);
  if (!projectRootAttempt.ok) return projectRootAttempt.result;
  const projectRoot = projectRootAttempt.value;

  return withStore(ctx.env, (store, databasePath) => {
    const session = store.registerSession(registerInput);

    const resolvedTask =
      resolveSkillTaskRef(store.listTasks(), title, (id) => store.getTask(id)) ??
      store.createTask(title, projectRoot, description);

    const task = resolvedTask.archivedAt
      ? store.unarchiveTask(resolvedTask.id)
      : resolvedTask;

    const assigned = store.assignSession(session.id, task.id);

    return success(formatSkillWorkOnTaskResult(assigned, task, databasePath));
  });
}

export function skillRecallCandidatesOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  const projectAttempt = attempt(() => parseRecallCandidatesArgs(rawArgs));
  if (!projectAttempt.ok) return projectAttempt.result;
  const project = projectAttempt.value;

  const projectRootAttempt = resolveProjectRoot(project, ctx.cwd);
  if (!projectRootAttempt.ok) return projectRootAttempt.result;
  const projectRoot = projectRootAttempt.value;

  return withStore(ctx.env, (store) => {
    const candidates = store.recallCandidates(projectRoot);
    return success(`${JSON.stringify(candidates)}\n`);
  });
}

export function skillReEnterOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (isHelpFlag(rawArgs[0])) return success(`${skillReEnterUsage()}\n`);
  const refError = rejectFlagTitle(rawArgs[0], "skill re-enter", "ref");
  if (refError) return refError;

  const ref = rawArgs[0];
  if (!ref) return failure("Task slug or title is required");

  return withStore(ctx.env, (store) => {
    const tasks = store.listTasks();
    const resolved = resolveSkillTaskRef(tasks, ref, (id) => store.getTask(id));
    if (!resolved) return failure(taskNotFoundMessage(tasks, ref), 1);

    // Codex and Cursor have no live stop hook (Claude's SubagentStop covers
    // claude), so their in-process subagents are swept up here — re-entry is
    // the next Trace touchpoint after the session that spawned them.
    sweepSubagentSessions(store, resolved.id, ctx.env.CODEX_HOME);

    const manifest = store.getReEntryManifest(resolved.id);
    if (!manifest) return failure(taskNotFoundMessage(tasks, ref), 1);

    // Going back to a task is itself working on it, whatever terminal it runs
    // from — the wired inferrer means a re-enter issued from a Cursor session
    // registers that session the same way work-on-task does.
    const identity = inferCliSessionIdentity(ctx.env, ctx.cwd);
    if (identity.id !== undefined && identity.transcriptPath !== undefined) {
      const session = store.registerSession({
        id: identity.id,
        transcriptPath: identity.transcriptPath,
        tool: identity.tool,
      });
      store.assignSession(session.id, resolved.id);
    }

    return success(formatReEntryManifest(manifest));
  });
}

// Best-effort per parent: a missing or half-written transcript must never
// block re-entry; that parent's subagents surface on the next sweep instead.
function sweepSubagentSessions(
  store: TaskStore,
  taskId: string,
  codexHome: string | undefined,
): void {
  for (const session of store.listSessionsForTask(taskId)) {
    if (session.origin !== "root") continue;
    try {
      if (session.tool === "codex") {
        discoverCodexSubagentSessions({
          store,
          parentSessionId: session.id,
          codexHome,
        });
      } else if (session.tool === "cursor") {
        discoverCursorSubagentSessions({ store, parentSessionId: session.id });
      }
    } catch {
      continue;
    }
  }
}

export function skillDocsDirOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (isHelpFlag(rawArgs[0])) return success(`${skillDocsDirUsage()}\n`);

  const parsedAttempt = attempt(() => parseSkillDocsDirArgs(rawArgs));
  if (!parsedAttempt.ok) return parsedAttempt.result;
  const parsed = parsedAttempt.value;

  const identity = inferCliSessionIdentity(ctx.env, ctx.cwd, { id: parsed.id });
  if (identity.id === undefined) {
    return failure("Skill docs-dir requires --id or a current session env var");
  }

  const projectRootAttempt = resolveProjectRoot(parsed.project, ctx.cwd);
  if (!projectRootAttempt.ok) return projectRootAttempt.result;
  const projectRoot = projectRootAttempt.value;

  return withStore(ctx.env, (store, databasePath) => {
    const activeTask = store.resolveActiveTask(identity.id as string, projectRoot);

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
}
