import type { Env } from "./seam.ts";
import { IntegrationRegistry } from "./integration-registry.ts";
import { resolvePackagedVersion } from "./setup-operations.ts";

/**
 * Returns a single-line warning when any registered integration target was
 * recorded at a version different from the currently running CLI, or an empty
 * string when all targets are current, the registry is absent, or parsing
 * fails. Purely local and read-only — no network request or filesystem write.
 */
export function checkUpdateWarning(env: Env): string {
  try {
    const currentVersion = env.TRACE_CURRENT_VERSION ?? resolvePackagedVersion();
    const staleTools = IntegrationRegistry.fromEnv(env).staleTools(currentVersion);
    if (staleTools.length === 0) return "";
    const tools = staleTools.join(", ");
    return `Warning: Trace integrations are out of date (${tools}). Run \`trace setup\` to update.\n`;
  } catch {
    return "";
  }
}
