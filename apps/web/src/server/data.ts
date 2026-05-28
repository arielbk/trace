import {
  openTraceStore,
  resolveDatabasePath,
  type Task,
  type TaskTimeline,
} from "@trace/core";

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
  return resolveDatabasePath(process.env);
}
