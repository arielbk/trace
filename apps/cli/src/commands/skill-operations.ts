import {
  discoverCodexSubagentSessions,
  discoverCursorSubagentSessions,
  resolveTaskDocsDir,
  type TaskStore,
} from "@trace/core";
import { inferCliSessionIdentity } from "./identity.ts";
import { triggerBackgroundSync } from "./sync.ts";
import {
  parseRecallCandidatesArgs,
  parseSkillDocsDirArgs,
  parseSkillWorkOnTaskArgs,
  skillDocsDirUsage,
  skillReEnterUsage,
  skillWorkOnTaskUsage,
} from "./parsers.ts";
import {
  formatProjectResolution,
  formatReEntryManifest,
  formatSkillWorkOnTaskResult,
  formatStateFreshness,
  resolveSkillTaskRef,
  taskNotFoundMessage,
} from "./formatters.ts";
import { computeStateFreshness, proseDriftReason } from "./state-operations.ts";
import { reconcileStateFooter } from "./task-operations.ts";
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

export type CommandContext = {
  env: Env;
  cwd: string;
  stdin: string;
  triggerSync?: (env: Env) => void;
};

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

  const result = withStore(ctx.env, (store, databasePath) => {
    const projectRootAttempt = resolveProjectRoot(project, ctx.cwd, store);
    if (!projectRootAttempt.ok) return projectRootAttempt.result;
    const projectRoot = projectRootAttempt.value;
    const projectResolution = store.resolveProject(projectRoot);
    const session = store.registerSession(registerInput);

    const resolvedTask =
      resolveSkillTaskRef(store.listTasks(), title, (id) => store.getTask(id)) ??
      store.createTask(title, projectRoot, description);

    const task = resolvedTask.archivedAt
      ? store.unarchiveTask(resolvedTask.id)
      : resolvedTask;

    const assigned = store.assignSession(session.id, task.id);

    // Materialize the docs-manifest footer at the bind seam so a task that
    // already has a native doc (spec-first, task created after) gets a complete
    // state.md on bind — no `trace state check` required.
    reconcileStateFooter(store, databasePath, task);

    return success(
      `${formatProjectResolution(projectResolution)}${formatSkillWorkOnTaskResult(assigned, task, databasePath)}`,
    );
  });
  if (result.exitCode === 0) (ctx.triggerSync ?? triggerBackgroundSync)(ctx.env);
  return result;
}

export function skillRecallCandidatesOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  const projectAttempt = attempt(() => parseRecallCandidatesArgs(rawArgs));
  if (!projectAttempt.ok) return projectAttempt.result;
  const project = projectAttempt.value;

  return withStore(ctx.env, (store) => {
    const projectRootAttempt = resolveProjectRoot(project, ctx.cwd, store);
    if (!projectRootAttempt.ok) return projectRootAttempt.result;
    const projectRoot = projectRootAttempt.value;
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
  const identity = inferCliSessionIdentity(ctx.env, ctx.cwd);
  const projectRootAttempt =
    identity.id !== undefined && identity.transcriptPath !== undefined
      ? resolveProjectRoot(undefined, ctx.cwd)
      : null;
  if (projectRootAttempt && !projectRootAttempt.ok) {
    return projectRootAttempt.result;
  }

  return withStore(ctx.env, (store, databasePath) => {
    const tasks = store.listTasks();
    const resolved = resolveSkillTaskRef(tasks, ref, (id) => store.getTask(id));
    if (!resolved) return failure(taskNotFoundMessage(tasks, ref), 1);

    // Codex and Cursor have no live stop hook (Claude's SubagentStop covers
    // claude), so their in-process subagents are swept up here — re-entry is
    // the next Trace touchpoint after the session that spawned them.
    sweepSubagentSessions(store, resolved.id, ctx.env.CODEX_HOME);

    // Re-entry is a bind seam like work-on-task: materialize the docs-manifest
    // footer before the manifest is built, so a task whose docs were dropped in
    // natively gets its state.md listed (and correct) for the entering agent.
    reconcileStateFooter(store, databasePath, resolved);

    const manifest = store.getReEntryManifest(resolved.id);
    if (!manifest) return failure(taskNotFoundMessage(tasks, ref), 1);

    // Going back to a task is itself working on it, whatever terminal it runs
    // from — the wired inferrer means a re-enter issued from a Cursor session
    // registers that session the same way work-on-task does.
    let projectResolution = "";
    let bound = false;
    if (identity.id !== undefined && identity.transcriptPath !== undefined) {
      const resolution = store.resolveProject(
        projectRootAttempt && projectRootAttempt.ok
          ? projectRootAttempt.value
          : ctx.cwd,
      );
      projectResolution = formatProjectResolution(resolution);
      const session = store.registerSession({
        id: identity.id,
        transcriptPath: identity.transcriptPath,
        tool: identity.tool,
      });
      store.assignSession(session.id, resolved.id);
      bound = true;
    }

    // The portable prose-freshness trigger: platforms without a live Stop hook
    // (Codex, Cursor) get the drift verdict at their next Trace touchpoint —
    // here. On Claude the warm Stop hook usually reconciled already, so this
    // block only appears when drift survived a session boundary. Gated on an
    // actual bind (a bare terminal reading the manifest is never directed to
    // invoke a skill), mirroring `state check`'s strict-binding contract.
    const freshness = bound
      ? computeStateFreshness(store, databasePath, resolved)
      : undefined;
    const drift =
      freshness?.needsProsePass && freshness.mode
        ? formatStateFreshness({
            mode: freshness.mode,
            reason: proseDriftReason(freshness.mode, resolved.slug),
          })
        : "";

    return {
      exitCode: 0,
      stdout: `${formatReEntryManifest(manifest)}${drift}`,
      stderr: projectResolution,
    };
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

  return withStore(ctx.env, (store, databasePath) => {
    const projectRootAttempt = resolveProjectRoot(parsed.project, ctx.cwd, store);
    if (!projectRootAttempt.ok) return projectRootAttempt.result;
    const projectRoot = projectRootAttempt.value;
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
