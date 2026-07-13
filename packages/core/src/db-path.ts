import { join } from "node:path";

/**
 * Single source of truth for the Trace database path, consumed by both the
 * CLI and the web server. `TRACE_DB` is the explicit override; otherwise the
 * global default `~/.trace/trace.sqlite` is used, resolving home from `HOME`
 * or `USERPROFILE` (native Windows shells set only the latter). Throws when
 * no home is available so the caller can surface a clear setup error instead
 * of silently writing to an unexpected location.
 */
export function resolveDatabasePath(
  env: Record<string, string | undefined>,
): string {
  if (env.TRACE_DB) return env.TRACE_DB;
  const home = env.HOME || env.USERPROFILE;
  if (home) return join(home, ".trace", "trace.sqlite");
  throw new Error(
    "TRACE_DB must be set, or HOME/USERPROFILE must be available for the default path ~/.trace/trace.sqlite",
  );
}
