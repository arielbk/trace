import { openTraceStore, type Task, type TaskTimeline } from "@trace/core";
import { join } from "node:path";

export function listTasks(): Task[] {
  const store = openTraceStore(getDatabasePath());
  try {
    return store.listTasks();
  } finally {
    store.close();
  }
}

export function getTaskTimeline(id: string): TaskTimeline | null {
  const store = openTraceStore(getDatabasePath());
  try {
    return store.getTaskTimeline(id);
  } finally {
    store.close();
  }
}

export function getDatabasePath(): string {
  if (process.env.TRACE_DB) return process.env.TRACE_DB;
  if (process.env.HOME) return join(process.env.HOME, ".trace", "trace.sqlite");
  throw new Error(
    "TRACE_DB must be set, or HOME must be available for the default path ~/.trace/trace.sqlite",
  );
}
