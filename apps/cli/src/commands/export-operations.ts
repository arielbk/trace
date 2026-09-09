import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildTaskExportZip } from "@trace/core";
import { inferCliSessionIdentity } from "./identity.ts";
import { exportUsage, parseExportArgs } from "./parsers.ts";
import {
  resolveSkillTaskRef,
  taskNotFoundMessage,
} from "./formatters.ts";
import { resolvePackagedVersion } from "./setup-operations.ts";
import {
  attempt,
  failure,
  isHelpFlag,
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
};

export function exportOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (isHelpFlag(rawArgs[0])) return success(`${exportUsage()}\n`);

  const parsedAttempt = attempt(() => parseExportArgs(rawArgs));
  if (!parsedAttempt.ok) return parsedAttempt.result;
  const parsed = parsedAttempt.value;

  return withStore(ctx.env, (store, databasePath) => {
    const projectRootAttempt = resolveProjectRoot(undefined, ctx.cwd, store);
    if (!projectRootAttempt.ok) return projectRootAttempt.result;
    const projectRoot = projectRootAttempt.value;

    let taskRef = parsed.ref;
    if (!taskRef) {
      const identity = inferCliSessionIdentity(ctx.env, ctx.cwd);
      if (identity.id === undefined) {
        return failure(
          "No task specified. Pass a task slug or bind the session with: eqnx skill work-on-task <title>",
        );
      }
      const activeTask = store.resolveActiveTask(identity.id, projectRoot);
      if (activeTask.kind === "bound") {
        taskRef = activeTask.task.slug;
      } else if (activeTask.kind === "re-enter") {
        return failure(
          `Session is not bound to a task. Re-enter the most recent task with: eqnx skill re-enter ${activeTask.task.slug}`,
          1,
        );
      } else {
        return failure(
          "Session is not bound to a task and the project has no task to re-enter. Bind one first with: eqnx skill work-on-task <title>",
          1,
        );
      }
    }

    const resolved =
      resolveSkillTaskRef(store.listTasks(), taskRef, (id) => store.getTask(id));
    if (!resolved) {
      return failure(taskNotFoundMessage(store.listTasks(), taskRef), 1);
    }

    const exported = buildTaskExportZip(store, databasePath, resolved.id, {
      generator: ctx.env.TRACE_CURRENT_VERSION ?? resolvePackagedVersion(),
      includeTranscripts: parsed.includeTranscripts,
    });
    if (!exported) {
      return failure(`Task not found: ${taskRef}`, 1);
    }

    const outPath = resolve(ctx.cwd, parsed.out ?? exported.fileName);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, exported.bytes);
    return {
      exitCode: 0,
      stdout: `${outPath}\n${exported.bytes.byteLength} bytes\n`,
      stderr: parsed.includeTranscripts
        ? "Warning: transcripts are copied verbatim and unredacted. They may contain secrets, absolute paths, and machine identifiers.\n"
        : "",
    };
  });
}
