import { openTraceStore, type Task, type TaskTimeline } from "@trace/core";

const defaultDatabasePath = ".trace/trace.sqlite";

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

function getDatabasePath(): string {
  return process.env.TRACE_DB ?? defaultDatabasePath;
}
