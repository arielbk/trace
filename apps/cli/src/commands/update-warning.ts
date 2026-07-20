import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./seam.ts";
import { resolvePackagedVersion } from "./setup-operations.ts";

type TargetRecord = { tool: string; version: string };
type Registry = { targets: TargetRecord[] };

function resolveRegistryPath(env: Env): string {
  if (env.TRACE_REGISTRY_PATH) return env.TRACE_REGISTRY_PATH;
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) return "";
  return join(home, ".trace", "integrations.json");
}

/**
 * Returns a single-line warning when any registered integration target was
 * recorded at a version different from the currently running CLI, or an empty
 * string when all targets are current, the registry is absent, or parsing
 * fails. Purely local and read-only — no network request or filesystem write.
 */
export function checkUpdateWarning(env: Env): string {
  const registryPath = resolveRegistryPath(env);
  if (!registryPath || !existsSync(registryPath)) return "";

  let registry: Registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  } catch {
    return "";
  }

  if (!Array.isArray(registry.targets)) return "";

  const currentVersion = env.TRACE_CURRENT_VERSION ?? resolvePackagedVersion();
  const staleTargets = registry.targets.filter(
    (t) => t.version !== currentVersion,
  );
  if (staleTargets.length === 0) return "";

  const tools = [...new Set(staleTargets.map((t) => t.tool))].join(", ");
  return `Warning: Trace integrations are out of date (${tools}). Run \`trace setup\` to update.\n`;
}
