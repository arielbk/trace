import { join } from "node:path";

export function resolveDbPath(
  env: Record<string, string | undefined>,
): string {
  if (env.TRACE_DB) return env.TRACE_DB;
  if (env.HOME) return join(env.HOME, ".trace", "trace.sqlite");
  throw new Error(
    "TRACE_DB must be set, or HOME must be available for the default path ~/.trace/trace.sqlite",
  );
}
