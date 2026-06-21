import { resolveTaskDocsDir } from "@trace/core";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { renderTaskDocManifest } from "./task-operations.ts";
import {
  failure,
  isHelpFlag,
  success,
  withStore,
  type CommandResult,
  type Env,
} from "./seam.ts";

export type CommandContext = { env: Env; cwd: string; stdin: string };

// `trace state check <task>` — reconcile the docs-manifest footer of the task's
// state.md and report a neutral JSON verdict. The footer is rendered (creating
// state.md from a scaffold) only when the task has at least one non-state doc;
// the reconcile is write-if-changed, so a repeat run is a byte-identical no-op.
export function stateCheckOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (isHelpFlag(rawArgs[0])) return success("Usage: trace state check <task>\n");
  const ref = rawArgs[0];
  if (!ref) return failure("Task id is required");

  return withStore(ctx.env, (store, databasePath) => {
    const task = store.getTaskByRef(ref);
    if (!task) return failure(`Task not found: ${ref}`, 1);

    const docsDir = resolveTaskDocsDir(databasePath, task.slug);
    const statePath = join(docsDir, "state.md");

    const hasNonStateDoc = store
      .listDocsForTask(task.id)
      .some((doc) => basename(doc.path) !== "state.md");

    // Only materialize state.md once a non-state doc exists — an empty task
    // should not sprout a bare manifest.
    if (hasNonStateDoc) {
      renderTaskDocManifest(store, databasePath, task);
    }

    const verdict = { stateExists: existsSync(statePath), statePath };
    return success(`${JSON.stringify(verdict)}\n`);
  });
}
