import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  IntegrationRegistry,
  type PackageManager,
} from "./integration-registry.ts";
import { failure, success, type CommandResult, type Env } from "./seam.ts";
import { resolvePackagedVersion } from "./setup-operations.ts";

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
   * Spawns the newly installed CLI to reconcile every registered target.
   */
  spawnReconcile: (cliPath: string) => SpawnResult;
};

/** Returns the install args for the given package manager. */
function installArgs(pm: PackageManager, version: string): { cmd: string; args: string[] } {
  const pkg = `@arielbk/trace@${version}`;
  switch (pm) {
    case "pnpm": return { cmd: "pnpm", args: ["add", "-g", pkg] };
    case "bun": return { cmd: "bun", args: ["install", "-g", pkg] };
    default: return { cmd: "npm", args: ["install", "-g", pkg] };
  }
}

/** The `spawnSync` surface these deps rely on, narrowed for injection. */
export type SpawnSync = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; shell: boolean },
) => { status: number | null; stderr: string };

export function createDefaultDeps(
  host: { platform?: NodeJS.Platform; spawnSync?: SpawnSync } = {},
): UpdateDeps {
  const platform = host.platform ?? process.platform;
  const spawnSync = host.spawnSync ?? (nodeSpawnSync as unknown as SpawnSync);

  // On Windows both the package managers (`npm.cmd`, `pnpm.cmd`) and the Trace
  // CLI are batch shims, and Node has refused to spawn `.cmd`/`.bat` without a
  // shell since the CVE-2024-27980 fix — it throws EINVAL. Elsewhere a shell
  // only adds a parsing layer, so it stays off.
  const shell = platform === "win32";

  const run = (command: string, args: string[]): SpawnResult => {
    const result = spawnSync(command, args, { encoding: "utf8", shell });
    return {
      status: result.status,
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  };

  return {
    async fetchLatestVersion(packageName) {
      const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
      if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
      const json = (await res.json()) as { version: string };
      return json.version;
    },
    spawnInstall(pm, version) {
      const { cmd, args } = installArgs(pm, version);
      return run(cmd, args);
    },
    spawnReconcile(cliPath) {
      return run(cliPath, ["setup", "--registered", "--yes"]);
    },
  };
}

const defaultDeps: UpdateDeps = createDefaultDeps();

export async function updateOperation(
  rawArgs: string[],
  ctx: { env: Env; cwd: string; stdin: string },
  deps: UpdateDeps = defaultDeps,
): Promise<CommandResult> {
  const apply = rawArgs.includes("--yes");

  let registry;
  try {
    registry = IntegrationRegistry.fromEnv(ctx.env).readForUpdate();
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
  if (!registry) {
    return failure(
      "No Trace integrations registered. Run `trace setup` first.",
    );
  }

  const { packageManager, cliPath } = registry;

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

  // Reconcile the complete registry in one invocation so the new CLI can
  // preflight every target before mutating any of them.
  if (cliPath) {
    const reconcileResult = deps.spawnReconcile(cliPath);
    if (reconcileResult.status !== 0) {
      const detail = reconcileResult.stderr.trim() || "non-zero exit";
      // The upgrade already landed — say so, so the failure does not read as a
      // failed update, and point at the command that finishes the job. The
      // nested detail carries its own remediation, so this frames it rather
      // than adding a second competing "Remediation:" label.
      const indented = detail.split("\n").map((line) => `  ${line}`).join("\n");
      return failure(
        `Trace was upgraded to v${latestVersion}, but reconciling integrations failed:\n` +
          `${indented}\n` +
          `Your integrations are still on the previous version. ` +
          `Once the above is resolved, run \`trace setup --yes\` to finish.`,
      );
    }
  }

  return success(`${planLine}\nUpdated to v${latestVersion} and reconciled registered targets.\n`);
}
