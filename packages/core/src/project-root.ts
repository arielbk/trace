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
