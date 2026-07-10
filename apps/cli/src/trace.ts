#!/usr/bin/env node
import { buildTraceCittyRoot, runCittyDispatch } from "./trace-citty.ts";
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { runAuthCommand } from "./commands/auth.ts";
import { runSyncCommand } from "./commands/sync.ts";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

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
  onOutput?: (output: string) => void,
): Promise<CommandResult> {
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
  return runTraceCli(argv, env, cwd, stdin);
}

function failure(stderr: string, exitCode = 2): CommandResult {
  return { exitCode, stdout: "", stderr: `${stderr}\n` };
}

function usage(): CommandResult {
  return failure(
    "Usage: trace init | trace serve | trace login | trace logout | trace whoami | trace sync | trace hook <session-start|subagent-stop> | trace task <create|update|capture|show|list|add-doc|update-doc|timeline> ... | trace project merge <duplicate-slug> <canonical-slug> | trace session <register|assign|active-task|list|scan> ... | trace skill <work-on-task|re-enter|recall-candidates|docs-dir> ...",
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
    (output) => process.stdout.write(output),
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
