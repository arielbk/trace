import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TaskDoc } from "./types.ts";

// `ref` is the on-disk directory key for a task — the slug for tasks created
// since slugs landed, or a UUID for legacy directories. It is purely a path
// segment; resolution of slug-vs-uuid happens at the call site.
export function resolveTaskDocsDir(databasePath: string, ref: string): string {
  return join(dirname(resolve(databasePath)), "tasks", ref, "docs");
}

// List trace-native docs for a task from its slug directory. Returned docs
// carry the canonical task id.
export function listNativeTaskDocs(
  databasePath: string,
  taskId: string,
  slug: string,
): TaskDoc[] {
  return readNativeTaskDocs(databasePath, taskId, slug);
}

function readNativeTaskDocs(
  databasePath: string,
  taskId: string,
  ref: string,
): TaskDoc[] {
  const docsDir = resolveTaskDocsDir(databasePath, ref);

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
