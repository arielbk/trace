import { defineCommand } from "citty";
import type { CommandDef } from "citty";
import { runInit } from "./installer.ts";
import { openBrowser } from "./open-browser.ts";
import { startTraceServe } from "./serve.ts";
import { runClaudeSessionStartHook } from "./claude-session-start-hook-runner.ts";
import { runClaudeStopHook } from "./claude-stop-hook-runner.ts";
import { runClaudeSubagentStopHook } from "./claude-subagent-stop-hook-runner.ts";
import {
  failure,
  success,
  type CommandResult,
  type Env,
} from "./commands/seam.ts";
import {
  taskAddDocOperation,
  taskUpdateDocOperation,
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
  sessionDiscoverSubagentsOperation,
  sessionListOperation,
  sessionRegisterOperation,
  sessionScanOperation,
  sessionSetParentOperation,
  sessionTailOperation,
} from "./commands/session-operations.ts";
import {
  skillDocsDirOperation,
  skillReEnterOperation,
  skillRecallCandidatesOperation,
  skillWorkOnTaskOperation,
} from "./commands/skill-operations.ts";
import { projectMergeOperation } from "./commands/project-operations.ts";
import {
  configGetOperation,
  configSetOperation,
  configUnsetOperation,
} from "./commands/config-operations.ts";
import {
  stateCheckOperation,
  stateReflectOperation,
} from "./commands/state-operations.ts";
import { keyShowOperation } from "./commands/key.ts";
import { setupOperation } from "./commands/setup-operations.ts";

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

      setup: defineCommand({
        meta: { description: "Install Trace integrations into an agent config root" },
        run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
          return setupOperation(args, { env, cwd, stdin });
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

      key: defineCommand({
        meta: { description: "Manage the document encryption key" },
        subCommands: {
          show: defineCommand({
            meta: { description: "Print the document encryption key" },
            run(): CommandResult {
              return keyShowOperation(env);
            },
          }),
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
          stop: defineCommand({
            meta: { description: "Block the main agent's turn on state.md drift" },
            run(): CommandResult {
              return runClaudeStopHook(stdin, env) as unknown as CommandResult;
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

          "update-doc": defineCommand({
            meta: { description: "Update a registered doc's title or description" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return taskUpdateDocOperation(args, { env, cwd, stdin });
            },
          }),
        },
      }),

      config: defineCommand({
        meta: { description: "Read and write machine-local client settings" },
        subCommands: {
          get: defineCommand({
            meta: { description: "Print a config value" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return configGetOperation(args, { env });
            },
          }),

          set: defineCommand({
            meta: { description: "Set a config value" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return configSetOperation(args, { env });
            },
          }),

          unset: defineCommand({
            meta: { description: "Remove a config value" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return configUnsetOperation(args, { env });
            },
          }),
        },
      }),

      project: defineCommand({
        meta: { description: "Manage projects" },
        subCommands: {
          merge: defineCommand({
            meta: {
              description: "Merge a duplicate project into a canonical project",
            },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return projectMergeOperation(args, { env });
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

          "discover-subagents": defineCommand({
            meta: {
              description: "Discover a session's in-process subagent sessions",
            },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return sessionDiscoverSubagentsOperation(args, { env, cwd, stdin });
            },
          }),
        },
      }),

      state: defineCommand({
        meta: { description: "Maintain a task's state.md" },
        subCommands: {
          check: defineCommand({
            meta: { description: "Reconcile a task's state.md docs footer" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return stateCheckOperation(args, { env, cwd, stdin });
            },
          }),

          reflect: defineCommand({
            meta: { description: "Stamp the prose fingerprint into state.md" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return stateReflectOperation(args, { env, cwd, stdin });
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
              return skillWorkOnTaskOperation(args, { env, cwd, stdin });
            },
          }),

          "recall-candidates": defineCommand({
            meta: { description: "List recall candidates as JSON" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return skillRecallCandidatesOperation(args, { env, cwd, stdin });
            },
          }),

          "re-enter": defineCommand({
            meta: { description: "Re-enter a task by ref" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return skillReEnterOperation(args, { env, cwd, stdin });
            },
          }),

          "docs-dir": defineCommand({
            meta: { description: "Get the docs directory for the active task" },
            run({ rawArgs: args }: { rawArgs: string[] }): CommandResult {
              return skillDocsDirOperation(args, { env, cwd, stdin });
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
