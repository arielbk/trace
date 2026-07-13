import {
  failure,
  isHelpFlag,
  success,
  withStore,
  type CommandResult,
  type Env,
} from "./seam.ts";

type ProjectCommandContext = { env: Env };

function projectMergeUsage(): string {
  return "Usage: trace project merge <duplicate-slug> <canonical-slug>";
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function projectMergeOperation(
  rawArgs: string[],
  ctx: ProjectCommandContext,
): CommandResult {
  if (isHelpFlag(rawArgs[0])) return success(`${projectMergeUsage()}\n`);
  if (rawArgs.length !== 2) return failure(projectMergeUsage());

  const duplicateSlug = rawArgs[0];
  const canonicalSlug = rawArgs[1];
  if (!duplicateSlug || !canonicalSlug) return failure(projectMergeUsage());

  return withStore(ctx.env, (store) => {
    const result = store.mergeProjects(duplicateSlug, canonicalSlug);
    return success(
      [
        `merged project ${result.duplicateSlug} into ${result.canonicalSlug}`,
        `moved ${countLabel(result.tasksMoved, "task")} and ${countLabel(result.rootsMoved, "root")}`,
        `added fingerprints: ${result.fingerprintsAdded.join(", ") || "none"}`,
        "",
      ].join("\n"),
    );
  });
}
