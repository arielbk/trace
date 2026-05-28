#!/usr/bin/env node
import { openTraceStore, type Task } from "../../../packages/core/src/index.ts";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function runTraceCli(argv: string[], env: Record<string, string | undefined> = process.env): CommandResult {
  const databasePath = env.TRACE_DB;

  if (!databasePath) {
    return failure("TRACE_DB must point to a SQLite database file");
  }

  const [resource, action, ...args] = argv;

  if (resource !== "task") {
    return failure("Usage: trace task <create|show|list> ...");
  }

  const store = openTraceStore(databasePath);

  try {
    if (action === "create") {
      const title = args.join(" ");
      const task = store.createTask(title);

      return success(`${task.id}\n`);
    }

    if (action === "show") {
      const id = args[0];

      if (!id) {
        return failure("Task id is required");
      }

      const task = store.getTask(id);

      if (!task) {
        return failure(`Task not found: ${id}`, 1);
      }

      return success(formatTask(task));
    }

    if (action === "list") {
      return success(store.listTasks().map(formatTaskSummary).join(""));
    }

    return failure("Usage: trace task <create|show|list> ...");
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  } finally {
    store.close();
  }
}

function success(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr: string, exitCode = 2): CommandResult {
  return { exitCode, stdout: "", stderr: `${stderr}\n` };
}

function formatTask(task: Task): string {
  return [`id: ${task.id}`, `title: ${task.title}`, `createdAt: ${task.createdAt}`, ""].join("\n");
}

function formatTaskSummary(task: Task): string {
  return `${task.id}\t${task.title}\n`;
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const result = runTraceCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
