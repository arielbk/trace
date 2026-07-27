#!/usr/bin/env node
import { buildTraceCittyRoot, runCittyDispatch } from "./trace-citty.ts";
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { runAuthCommand } from "./commands/auth.ts";
import { runSyncCommand } from "./commands/sync.ts";
import { createClackPrompt } from "./commands/setup-clack-prompt.ts";
import { interactiveSetupOperation } from "./commands/setup-interactive.ts";
import type { SetupPrompt } from "./commands/setup-prompt.ts";
import { updateOperation } from "./commands/update-operations.ts";
import { checkUpdateWarning } from "./commands/update-warning.ts";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Everything the CLI needs from its host process beyond argv and the env. */
export type TraceCliOptions = {
  /** Streams output that must appear before the command finishes. */
  onOutput?: (output: string) => void;
  /** True only when a human can answer a prompt on both stdin and stdout. */
  interactive?: boolean;
  /**
   * Supplies the terminal prompt adapter. Absent means no picker is available,
   * so every command keeps its deterministic, non-interactive behavior.
   */
  createPrompt?: () => SetupPrompt;
};

/**
 * Bare `trace setup` is the only interactive invocation. Any selector or action
 * flag (`--yes`, `--tool`, `--target`, `--registered`, `--remove`) — indeed any
 * argument at all — keeps setup on the deterministic path.
 */
function isBareSetup(argv: string[]): boolean {
  return argv.length === 1 && argv[0] === "setup";
}

/**
 * Decides what the host process can offer the CLI. A picker needs a real
 * terminal on *both* streams — a redirected stdin cannot answer it and a piped
 * stdout must stay machine-readable — so anything less stays deterministic.
 */
export function traceCliOptionsFor(proc: {
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
}): TraceCliOptions {
  return {
    onOutput: (output) => process.stdout.write(output),
    interactive: proc.stdin.isTTY === true && proc.stdout.isTTY === true,
    createPrompt: () => createClackPrompt(),
  };
}

export function runTraceCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  stdin = "",
): CommandResult {
  const cittyRoot = buildTraceCittyRoot(env, cwd, stdin);
  const cittyResult = runCittyDispatch(cittyRoot, argv);
  if (cittyResult !== null) return cittyResult;
  return usage();
}

export async function runTraceCliAsync(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  stdin = "",
  options: TraceCliOptions = {},
): Promise<CommandResult> {
  const { onOutput, interactive, createPrompt } = options;
  const command = argv[0];
  if (command === "sync" && argv.length === 1) {
    return runSyncCommand(env);
  }
  if (
    (command === "login" || command === "logout" || command === "whoami") &&
    argv.length === 1
  ) {
    return runAuthCommand(command, env, { onOutput });
  }
  if (command === "update") {
    return updateOperation(argv.slice(1), { env, cwd, stdin });
  }
  if (isBareSetup(argv) && interactive === true && createPrompt !== undefined) {
    return interactiveSetupOperation({ env, cwd, stdin }, createPrompt());
  }

  const inner = runTraceCli(argv, env, cwd, stdin);

  // Automated hooks and setup/update stay silent — they either address the
  // staleness or must not pollute their output with unrelated warnings.
  if (command === "hook" || command === "setup") return inner;

  const warning = checkUpdateWarning(env);
  if (!warning) return inner;
  return { ...inner, stderr: warning + inner.stderr };
}

function failure(stderr: string, exitCode = 2): CommandResult {
  return { exitCode, stdout: "", stderr: `${stderr}\n` };
}

function usage(): CommandResult {
  return failure(
    "Usage: trace init | trace setup --tool claude [--yes] | trace update [--yes] | trace serve | trace login | trace logout | trace whoami | trace sync | trace key show | trace config <get|set|unset> <server-url|auto-sync> ... | trace hook <session-start|subagent-stop> | trace task <create|update|capture|show|list|add-doc|update-doc|timeline> ... | trace project merge <duplicate-slug> <canonical-slug> | trace session <register|assign|active-task|list|scan> ... | trace skill <work-on-task|re-enter|recall-candidates|docs-dir> ...",
  );
}

// `process.argv[1]` is the invoked path, which `pnpm link --global` exposes as
// a symlink whose realpath is this entry. Compare resolved realpaths so the CLI
// runs whether it was launched directly or through the linked `trace` shim.
const invokedPath = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
const isTraceEntry =
  basename(modulePath) === "trace.ts" || basename(modulePath) === "trace.js";
const isDirectRun =
  invokedPath !== undefined &&
  isTraceEntry &&
  safeRealpath(invokedPath) === modulePath;

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

if (isDirectRun) {
  const args = process.argv.slice(2);
  const stdin =
    args[0] === "hook" &&
    (args[1] === "session-start" ||
      args[1] === "subagent-stop" ||
      args[1] === "stop")
      ? readFileSync(0, "utf8")
      : "";
  runTraceCliAsync(
    args,
    process.env,
    process.cwd(),
    stdin,
    traceCliOptionsFor(process),
  )
    .then((result) => {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
