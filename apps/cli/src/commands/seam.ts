import {
  openTraceStore,
  resolveDatabasePath,
  resolveProjectRootArg,
} from "@trace/core";

export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type Env = Record<string, string | undefined>;
export type Store = ReturnType<typeof openTraceStore>;
export type Attempt<T> =
  | { ok: true; value: T }
  | { ok: false; result: CommandResult };

export function success(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

export function failure(stderr: string, exitCode = 2): CommandResult {
  return { exitCode, stdout: "", stderr: `${stderr}\n` };
}

export function attempt<T>(fn: () => T, exitCode = 2): Attempt<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return {
      ok: false,
      result: failure(error instanceof Error ? error.message : String(error), exitCode),
    };
  }
}

export function resolveProjectRoot(
  project: string | undefined,
  cwd: string,
  store?: Store,
): Attempt<string> {
  return attempt(() => {
    if (project !== undefined && store) {
      const matched = store.getProjectBySlug(project);
      if (matched) {
        const root = store.getProjectRoot(matched.id);
        if (root) return root;
      }
    }
    return resolveProjectRootArg(project, cwd);
  });
}

export function isHelpFlag(token: string | undefined): boolean {
  return token === "--help" || token === "-h";
}

export function looksLikeFlag(token: string | undefined): boolean {
  return token !== undefined && token.startsWith("-");
}

export function rejectFlagTitle(
  token: string | undefined,
  command: string,
  noun = "title",
): CommandResult | null {
  if (!looksLikeFlag(token)) return null;
  return failure(`Usage: trace ${command} <${noun}>`);
}

export function withStore(
  env: Env,
  callback: (store: Store, databasePath: string) => CommandResult,
): CommandResult {
  const databasePathAttempt = attempt(() => resolveDatabasePath(env));
  if (!databasePathAttempt.ok) return databasePathAttempt.result;

  const store = openTraceStore(databasePathAttempt.value);
  try {
    return callback(store, databasePathAttempt.value);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  } finally {
    store.close();
  }
}
