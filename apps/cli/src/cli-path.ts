import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** The verdict of a guardrail check, with remediation when it refuses. */
export type CliPathCheck = { ok: true } | { ok: false; error: string };

/** Shim extensions npm, pnpm and bun generate on Windows, in preference order. */
const WINDOWS_SHIM_EXTENSIONS = [".cmd", ".exe", ".bat"];

/**
 * Finds the `trace` shim on `PATH`.
 *
 * On Windows `argv[1]` is the raw script — the `.cmd` shim invoked `node` with
 * it and dropped out of the picture. The shim is the durable identity: it is
 * what the user types, and it resolves Node itself, so it survives a Node
 * version switch that a recorded `execPath` would not.
 */
function findWindowsShim(env: Env): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? env.path;
  if (!pathValue) return undefined;

  for (const dir of pathValue.split(";")) {
    if (!dir) continue;
    for (const extension of WINDOWS_SHIM_EXTENSIONS) {
      const candidate = join(dir, `trace${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Absolute path to the persistent Trace CLI. Both agent hook commands and the
 * managed connection's LaunchAgent record it, so it must outlive this process.
 */
export function resolveTraceCliPath(
  env: Env,
  platform: NodeJS.Platform,
): string {
  if (env.TRACE_CLI_PATH) return env.TRACE_CLI_PATH;
  if (platform === "win32") {
    const shim = findWindowsShim(env);
    if (shim) return shim;
  }
  const invoked = process.argv[1];
  if (invoked) {
    try {
      return realpathSync(invoked);
    } catch {
      return invoked;
    }
  }
  return "trace";
}

/**
 * Refuses to record an executable that will not still be there tomorrow: an
 * npx cache entry is deleted, and a source checkout is not what the user
 * installed. Both would leave a hook — or a login service — pointing at
 * nothing.
 */
export function checkManagedCliPath(cliPath: string): CliPathCheck {
  const normalized = cliPath.replaceAll("\\", "/");
  if (/(?:^|\/)_npx(?:\/|$)/.test(normalized)) {
    return {
      ok: false,
      error:
        `Trace setup cannot register the ephemeral npx executable at ${cliPath}.\n` +
        "  Install @arielbk/trace as a persistent global CLI, then run trace setup again.",
    };
  }
  if (/(?:^|\/)apps\/cli\/(?:src|dist)\/trace\.(?:ts|js)$/.test(normalized)) {
    return {
      ok: false,
      error:
        `Trace setup cannot register the source checkout executable at ${cliPath}.\n` +
        "  Install @arielbk/trace as a persistent global CLI, then run trace setup again.",
    };
  }
  return { ok: true };
}
