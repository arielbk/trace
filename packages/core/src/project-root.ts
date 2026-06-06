import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function resolveProjectRoot(cwd: string): string {
  const start = resolve(cwd);
  let current = start;

  while (true) {
    if (existsSync(resolve(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return start;
    }

    current = parent;
  }
}

// Resolve the project root for a command that accepts an optional `--project`
// override. Without the flag this is exactly today's behaviour: walk up from
// cwd to the nearest `.git`. With the flag, the override directory (resolved
// against cwd when relative) becomes the starting point instead — so a task
// created or recalled from a multi-project sandbox keys to the real project's
// git root rather than the sandbox's. A nonexistent override is a hard error
// naming the bad path, since silently keying to the wrong root is worse than
// failing loudly.
export function resolveProjectRootArg(
  projectArg: string | undefined,
  cwd: string,
): string {
  if (projectArg === undefined) {
    return resolveProjectRoot(cwd);
  }

  const target = resolve(cwd, projectArg);
  if (!existsSync(target)) {
    throw new Error(`--project path does not exist: ${target}`);
  }

  return resolveProjectRoot(target);
}
