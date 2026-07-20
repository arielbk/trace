import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { failure, success, type CommandResult, type Env } from "./seam.ts";
import { resolvePackagedVersion, type PackageManager } from "./setup-operations.ts";

type ToolName = "claude" | "codex" | "cursor";

type TargetRecord = {
  tool: ToolName;
  root: string;
  cliPath: string;
  version: string;
  skills: string[];
  hooks: string[];
};

type Registry = { packageManager: PackageManager; targets: TargetRecord[] };

export type SpawnResult = { status: number | null; stderr: string };

export type UpdateDeps = {
  /** Fetches the latest published version of @arielbk/trace from the npm registry. */
  fetchLatestVersion: (packageName: string) => Promise<string>;
  /**
   * Spawns the package manager to install the given version globally.
   * Receives the pm name and the exact version string.
   */
  spawnInstall: (pm: PackageManager, version: string) => SpawnResult;
  /**
   * Spawns the newly installed CLI to reconcile one tool's targets.
   * Receives the absolute CLI path and the tool name.
   */
  spawnReconcile: (cliPath: string, tool: string) => SpawnResult;
};

/** Returns the registry path from env override or the default location. */
function resolveRegistryPath(env: Env): string {
  if (env.TRACE_REGISTRY_PATH) return env.TRACE_REGISTRY_PATH;
  const home = env.HOME || env.USERPROFILE;
  if (!home) throw new Error("HOME/USERPROFILE must be set");
  return join(home, ".trace", "integrations.json");
}

/** Reads the registry file and returns it parsed, or undefined if missing. */
function readRegistry(registryPath: string): Registry | undefined {
  if (!existsSync(registryPath)) return undefined;
  return JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
}

/** Returns the install args for the given package manager. */
function installArgs(pm: PackageManager, version: string): { cmd: string; args: string[] } {
  const pkg = `@arielbk/trace@${version}`;
  switch (pm) {
    case "pnpm": return { cmd: "pnpm", args: ["add", "-g", pkg] };
    case "bun": return { cmd: "bun", args: ["install", "-g", pkg] };
    default: return { cmd: "npm", args: ["install", "-g", pkg] };
  }
}

const defaultDeps: UpdateDeps = {
  async fetchLatestVersion(packageName) {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
    if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
    const json = (await res.json()) as { version: string };
    return json.version;
  },
  spawnInstall(pm, version) {
    const { cmd, args } = installArgs(pm, version);
    const result = nodeSpawnSync(cmd, args, { encoding: "utf8" });
    return {
      status: result.status,
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  },
  spawnReconcile(cliPath, tool) {
    const result = nodeSpawnSync(cliPath, ["setup", "--tool", tool, "--yes"], { encoding: "utf8" });
    return {
      status: result.status,
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  },
};

export async function updateOperation(
  rawArgs: string[],
  ctx: { env: Env; cwd: string; stdin: string },
  deps: UpdateDeps = defaultDeps,
): Promise<CommandResult> {
  const apply = rawArgs.includes("--yes");

  // Read registry.
  let registryPath: string;
  try {
    registryPath = resolveRegistryPath(ctx.env);
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }

  const registry = readRegistry(registryPath);
  if (!registry) {
    return failure(
      "No Trace integrations registered. Run `trace setup` first.",
    );
  }

  const { packageManager, targets } = registry;

  // Fetch latest version.
  let latestVersion: string;
  try {
    latestVersion = await deps.fetchLatestVersion("@arielbk/trace");
  } catch (err) {
    return failure(
      `Failed to fetch latest version: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Resolve current version (injectable via env for tests, otherwise from package.json).
  const currentVersion = ctx.env.TRACE_CURRENT_VERSION ?? resolvePackagedVersion();

  // No-op when already current.
  if (currentVersion === latestVersion) {
    return success(`Trace is already at v${currentVersion}. Nothing to update.\n`);
  }

  const planLine = `Trace v${currentVersion} → v${latestVersion} (via ${packageManager})\n`;

  if (!apply) {
    return success(`${planLine}\nRe-run with --yes to apply.\n`);
  }

  // Run install.
  const installResult = deps.spawnInstall(packageManager, latestVersion);
  if (installResult.status !== 0) {
    const detail = installResult.stderr.trim() || "non-zero exit";
    return failure(`Install failed: ${detail}`);
  }

  // Reconcile all registered targets with the new CLI.
  // Use the cliPath from the first target for each unique tool.
  const toolToCliPath = new Map<string, string>();
  for (const target of targets) {
    if (!toolToCliPath.has(target.tool)) {
      toolToCliPath.set(target.tool, target.cliPath);
    }
  }

  for (const [tool, cliPath] of toolToCliPath) {
    const reconcileResult = deps.spawnReconcile(cliPath, tool);
    if (reconcileResult.status !== 0) {
      const detail = reconcileResult.stderr.trim() || "non-zero exit";
      return failure(`Reconcile failed for ${tool}: ${detail}`);
    }
  }

  const toolList = [...toolToCliPath.keys()].join(", ");
  return success(`${planLine}\nUpdated to v${latestVersion} and reconciled targets: ${toolList}.\n`);
}
