import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TaskDoc } from "./types.ts";

export function resolveTaskDocsDir(
  databasePath: string,
  taskId: string,
): string {
  return join(dirname(resolve(databasePath)), "tasks", taskId, "docs");
}

export function listNativeTaskDocs(
  databasePath: string,
  taskId: string,
): TaskDoc[] {
  const docsDir = resolveTaskDocsDir(databasePath, taskId);

  try {
    return readdirSync(docsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(docsDir, entry.name);
        return {
          taskId,
          path,
          createdAt: statSync(path).mtime.toISOString(),
        };
      });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }
}

export function mergeTaskDocs(
  registered: TaskDoc[],
  native: TaskDoc[],
): TaskDoc[] {
  const docsByPath = new Map<string, TaskDoc>();

  for (const doc of registered) {
    docsByPath.set(doc.path, doc);
  }

  for (const doc of native) {
    if (!docsByPath.has(doc.path)) {
      docsByPath.set(doc.path, doc);
    }
  }

  return [...docsByPath.values()].sort((left, right) => {
    const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    return left.path.localeCompare(right.path);
  });
}
