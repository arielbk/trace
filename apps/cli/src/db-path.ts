import { resolveDatabasePath } from "@trace/core";

/**
 * Thin alias over the shared `@trace/core` resolver so the CLI never
 * hard-codes a path. See `resolveDatabasePath` for the resolution rules.
 */
export function resolveDbPath(
  env: Record<string, string | undefined>,
): string {
  return resolveDatabasePath(env);
}
