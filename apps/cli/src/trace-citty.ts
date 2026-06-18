import { defineCommand } from "citty";
import type { CommandDef } from "citty";
import { inferSessionIdentity, resolveTaskDocsDir } from "@trace/core";
import { runInit } from "./installer.ts";
import { openBrowser, startTraceServe } from "./serve.ts";
import { runClaudeSessionStartHook } from "./claude-session-start-hook-runner.ts";
import { runClaudeSubagentStopHook } from "./claude-subagent-stop-hook-runner.ts";
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
} from "./commands/seam.ts";
import {
  parseRecallCandidatesArgs,
  parseSkillDocsDirArgs,
  parseSkillWorkOnTaskArgs,
  skillDocsDirUsage,
  skillReEnterUsage,
  skillWorkOnTaskUsage,
} from "./commands/parsers.ts";
import {
  formatReEntryManifest,
  formatSkillWorkOnTaskResult,
  resolveSkillTaskRef,
  taskNotFoundMessage,
} from "./commands/formatters.ts";
import {
  taskAddDocOperation,
  taskCaptureOperation,
  taskCreateOperation,
  taskListOperation,
  taskShowOperation,
  taskTimelineOperation,
  taskUpdateOperation,
} from "./commands/task-operations.ts";
import {
  sessionActiveTaskOperation,
  sessionAssignOperation,
  sessionListOperation,
  sessionRegisterOperation,
  sessionScanOperation,
  sessionSetParentOperation,
  sessionTailOperation,
} from "./commands/session-operations.ts";

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
          "subagent-stop": defineCommand({
            meta: { description: "Discover Claude subagent sessions on stop" },
            run(): CommandResult {
              return runClaudeSubagentStopHook(stdin, env) as unknown as CommandResult;
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
              return taskCreateOperation(args, { env, cwd, stdin });
            },
          }),

          update: defineCommand({
            meta: { description: "Update a task description" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return taskUpdateOperation(args, { env, cwd, stdin });
            },
          }),

          capture: defineCommand({
            meta: { description: "Capture a document as a new task" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return taskCaptureOperation(args, { env, cwd, stdin });
            },
          }),

          show: defineCommand({
            meta: { description: "Show task details" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return taskShowOperation(args, { env, cwd, stdin });
            },
          }),

          list: defineCommand({
            meta: { description: "List all tasks" },
            run(): CommandResult {
              return taskListOperation([], { env, cwd, stdin });
            },
          }),

          timeline: defineCommand({
            meta: { description: "Show task timeline as JSON" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return taskTimelineOperation(args, { env, cwd, stdin });
            },
          }),

          "add-doc": defineCommand({
            meta: { description: "Add a document to a task" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return taskAddDocOperation(args, { env, cwd, stdin });
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
              return sessionRegisterOperation(args, { env, cwd, stdin });
            },
          }),

          assign: defineCommand({
            meta: { description: "Assign a session to a task" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return sessionAssignOperation(args, { env, cwd, stdin });
            },
          }),

          "set-parent": defineCommand({
            meta: { description: "Set a session's parent attribution" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return sessionSetParentOperation(args, { env, cwd, stdin });
            },
          }),

          "active-task": defineCommand({
            meta: { description: "Get the active task for a session" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return sessionActiveTaskOperation(args, { env, cwd, stdin });
            },
          }),

          list: defineCommand({
            meta: { description: "List sessions" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return sessionListOperation(args, { env, cwd, stdin });
            },
          }),

          tail: defineCommand({
            meta: { description: "Read the tail of a session transcript" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return sessionTailOperation(args, { env, cwd, stdin });
            },
          }),

          scan: defineCommand({
            meta: { description: "Scan for sessions" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return sessionScanOperation(args, { env, cwd, stdin });
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

              const parsedAttempt = attempt(() => parseSkillWorkOnTaskArgs(args.slice(1), env));
              if (!parsedAttempt.ok) return parsedAttempt.result;
              const parsed = parsedAttempt.value;

              const { description, project, ...registerInput } = parsed;

              const projectRootAttempt = resolveProjectRoot(project, cwd);
              if (!projectRootAttempt.ok) return projectRootAttempt.result;
              const workOnTaskProjectRoot = projectRootAttempt.value;

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
              const recallProjectAttempt = attempt(() => parseRecallCandidatesArgs(args));
              if (!recallProjectAttempt.ok) return recallProjectAttempt.result;
              const recallProject = recallProjectAttempt.value;

              const recallProjectRootAttempt = resolveProjectRoot(recallProject, cwd);
              if (!recallProjectRootAttempt.ok) return recallProjectRootAttempt.result;
              const recallProjectRoot = recallProjectRootAttempt.value;

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

              const parsedDocsDirAttempt = attempt(() => parseSkillDocsDirArgs(args));
              if (!parsedDocsDirAttempt.ok) return parsedDocsDirAttempt.result;
              const parsedDocsDir = parsedDocsDirAttempt.value;

              const identity = inferSessionIdentity(env, { id: parsedDocsDir.id });
              if (identity.id === undefined) {
                return failure(
                  "Skill docs-dir requires --id or a current session env var",
                );
              }

              const docsDirProjectRootAttempt = resolveProjectRoot(parsedDocsDir.project, cwd);
              if (!docsDirProjectRootAttempt.ok) return docsDirProjectRootAttempt.result;
              const docsDirProjectRoot = docsDirProjectRootAttempt.value;

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
