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
import { resolvePackagedVersion } from "./commands/setup-operations.ts";
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
  /** True when stdout is a terminal and human-oriented formatting is useful. */
  humanReadable?: boolean;
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
    humanReadable: proc.stdout.isTTY === true,
    createPrompt: () => createClackPrompt(),
  };
}

function currentVersion(env: Record<string, string | undefined>): string {
  return env.TRACE_CURRENT_VERSION ?? resolvePackagedVersion();
}

function isVersionInvocation(argv: string[]): boolean {
  return (
    argv.length === 1 &&
    (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version")
  );
}

function isHelpInvocation(argv: string[]): boolean {
  return (
    argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")
  );
}

export function runTraceCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  stdin = "",
): CommandResult {
  if (isVersionInvocation(argv)) {
    return { exitCode: 0, stdout: `trace ${currentVersion(env)}\n`, stderr: "" };
  }
  if (isHelpInvocation(argv)) return compactHelp();
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
  const { onOutput, interactive, humanReadable, createPrompt } = options;
  if (isVersionInvocation(argv)) {
    return { exitCode: 0, stdout: `trace ${currentVersion(env)}\n`, stderr: "" };
  }
  if (
    humanReadable === true &&
    (argv.length === 0 || isHelpInvocation(argv))
  ) {
    return humanHelp(currentVersion(env), helpColorsEnabled(env));
  }
  if (isHelpInvocation(argv)) return compactHelp();
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

const COMPACT_USAGE =
  "Usage: trace init | trace setup --tool claude [--yes] | trace update [--yes] | trace serve | trace login | trace logout | trace whoami | trace sync | trace key show | trace config <get|set|unset> <server-url|auto-sync> ... | trace hook <session-start|subagent-stop> | trace task <create|update|capture|show|list|add-doc|update-doc|timeline> ... | trace project merge <duplicate-slug> <canonical-slug> | trace session <register|assign|active-task|list|scan> ... | trace skill <work-on-task|re-enter|recall-candidates|docs-dir> ...";

function usage(): CommandResult {
  return failure(COMPACT_USAGE);
}

function compactHelp(): CommandResult {
  return { exitCode: 0, stdout: `${COMPACT_USAGE}\n`, stderr: "" };
}

function helpColorsEnabled(env: Record<string, string | undefined>): boolean {
  return !Object.hasOwn(env, "NO_COLOR") && env.TERM !== "dumb";
}

function humanHelp(version: string, colorsEnabled: boolean): CommandResult {
  const style = {
    title: ansiStyle("1;36", colorsEnabled),
    heading: ansiStyle("1", colorsEnabled),
    command: ansiStyle("36", colorsEnabled),
    dim: ansiStyle("2", colorsEnabled),
  };
  const row = (command: string, description: string): string =>
    `  ${style.command(command.padEnd(28))}${description}\n`;

  return {
    exitCode: 0,
    stdout:
      `${style.title(`Trace v${version}`)}` +
      `${style.dim(" — keep agent work organized across sessions")}\n\n` +
      `Usage: ${style.command("trace <command> [options]")}\n\n` +
      `${style.heading("Get started")}\n` +
      row("trace setup", "Configure Trace for your agent tools") +
      row("trace serve", "Open the local task board") +
      row("trace task list", "See your tasks") +
      row('trace task create "Title"', "Create a task") +
      `\n${style.heading("Keep Trace current")}\n` +
      row("trace update", "Check for an update") +
      row("trace update --yes", "Install it and refresh integrations") +
      `\n${style.heading("Cloud")}\n` +
      row("trace login", "Connect your Trace account") +
      row("trace sync", "Sync local work") +
      row("trace whoami", "Show the signed-in account") +
      `\n${style.heading("More")}\n` +
      row("task, session, state", "Work and session history") +
      row("config, key, project", "Local configuration") +
      row("skill, hook", "Agent integration commands") +
      `\nRun ${style.command("trace <command> --help")} for command details.\n\n` +
      `${style.heading("Options")}\n` +
      row("-h, --help", "Show help") +
      row("-v, --version", "Show the installed version"),
    stderr: "",
  };
}

function ansiStyle(
  code: string,
  enabled: boolean,
): (value: string) => string {
  return enabled
    ? (value) => `\u001B[${code}m${value}\u001B[0m`
    : (value) => value;
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
