import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import type { GitWorkContext, LastWorkedOn } from "./types.ts";

export type { GitWorkContext, LastWorkedOn };

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

export function readGitWorkContext(cwd: string): GitWorkContext {
  const branch = gitOutput(cwd, ["branch", "--show-current"]);
  const toplevel = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!branch && !toplevel) return {};

  const gitDir = gitOutput(cwd, ["rev-parse", "--git-dir"]);
  const commonDir = gitOutput(cwd, ["rev-parse", "--git-common-dir"]);
  const linked =
    gitDir !== undefined &&
    commonDir !== undefined &&
    resolve(cwd, gitDir) !== resolve(cwd, commonDir);

  return {
    ...(branch ? { branch } : {}),
    ...(linked && toplevel ? { worktreeLabel: basename(toplevel) } : {}),
    ...(toplevel ? { localPath: toplevel } : {}),
  };
}

export function lastWorkedOnFromContext(
  context: GitWorkContext,
): LastWorkedOn | undefined {
  const lastWorkedOn: LastWorkedOn = {
    ...(context.branch ? { branch: context.branch } : {}),
    ...(context.worktreeLabel ? { worktree: context.worktreeLabel } : {}),
  };
  return lastWorkedOn.branch || lastWorkedOn.worktree
    ? lastWorkedOn
    : undefined;
}

export function lastWorkedOnFromSessions(
  sessions: GitWorkContext[],
): LastWorkedOn | undefined {
  for (const context of sessions) {
    const lastWorkedOn = lastWorkedOnFromContext(context);
    if (lastWorkedOn) return lastWorkedOn;
  }
  return undefined;
}
