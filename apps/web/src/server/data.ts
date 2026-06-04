import {
  openTraceStore,
  resolveDatabasePath,
  type Task,
  type TaskSummary,
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

export function listTaskSummaries(): TaskSummary[] {
  const store = openTraceStore(getDatabasePath());
  try {
    return store.listTaskSummaries();
  } finally {
    store.close();
  }
}

export function archiveTask(ref: string): Task {
  const store = openTraceStore(getDatabasePath());
  try {
    return store.archiveTask(ref);
  } finally {
    store.close();
  }
}

export function unarchiveTask(ref: string): Task {
  const store = openTraceStore(getDatabasePath());
  try {
    return store.unarchiveTask(ref);
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
