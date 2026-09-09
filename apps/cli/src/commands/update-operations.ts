import { spawnSync as nodeSpawnSync } from "node:child_process";
import type { ConfirmPrompt } from "./confirm-prompt.ts";
import {
  IntegrationRegistry,
  type PackageManager,
} from "./integration-registry.ts";
import { failure, success, type CommandResult, type Env } from "./seam.ts";
import { spawnInvocation } from "./spawn-invocation.ts";
import {
  detectPackageManager,
  resolvePackagedVersion,
} from "./setup-operations.ts";
import {
  readInstalledConnectionCli,
  restartConnectionService,
  type ConnectionLifecycleOutcome,
} from "../connection-service.ts";

export type SpawnResult = { status: number | null; stderr: string };

/**
 * Declining is a user-directed exit, not a failure — nothing non-interactive can
 * reach it, so exiting zero costs no scriptability. Mirrors setup's wording.
 */
const CANCELLED = "Update cancelled; no changes made.\n";

export type UpdateDeps = {
  /** Fetches the latest published version of @eqnx/cli from the npm registry. */
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
  /**
   * Restarts the managed login service onto the executable just installed. A
   * same-path upgrade leaves the old process holding the endpoint, so nothing
   * but an explicit restart moves the connection onto the new version.
   */
  restartConnection: (env: Env) => ConnectionLifecycleOutcome;
};

/** Returns the install args for the given package manager. */
function installArgs(pm: PackageManager, version: string): { cmd: string; args: string[] } {
  const pkg = `@eqnx/cli@${version}`;
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

  const run = (rawCommand: string, rawArgs: string[]): SpawnResult => {
    const { command, args, shell } = spawnInvocation(platform, rawCommand, rawArgs);
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
    restartConnection(env) {
      return restartConnectionService(env);
    },
  };
}

const defaultDeps: UpdateDeps = createDefaultDeps();

/**
 * @param prompt Confirms the update in the terminal. Absent — every
 * non-interactive caller — leaves `eqnx update` on its preview-then-exit path.
 */
export async function updateOperation(
  rawArgs: string[],
  ctx: { env: Env; cwd: string; stdin: string },
  deps: UpdateDeps = defaultDeps,
  prompt?: ConfirmPrompt,
): Promise<CommandResult> {
  const apply = rawArgs.includes("--yes");

  let registry;
  try {
    registry = IntegrationRegistry.fromEnv(ctx.env).readForUpdate();
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
  // A machine can carry the managed connection and no agent integration at
  // all, and that install still has to be updatable.
  const serviceCliPath = readInstalledConnectionCli(ctx.env);
  if (!registry && serviceCliPath === undefined) {
    return failure(
      "No EQNX integrations registered. Run `eqnx setup` first.",
    );
  }

  const cliPath = registry?.cliPath ?? serviceCliPath;
  const packageManager =
    registry?.packageManager ??
    detectPackageManager(ctx.env, serviceCliPath ?? "");

  // Fetch latest version.
  let latestVersion: string;
  try {
    latestVersion = await deps.fetchLatestVersion("@eqnx/cli");
  } catch (err) {
    return failure(
      `Failed to fetch latest version: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Resolve current version (injectable via env for tests, otherwise from package.json).
  const currentVersion = ctx.env.TRACE_CURRENT_VERSION ?? resolvePackagedVersion();

  // No-op when already current.
  if (currentVersion === latestVersion) {
    return success(`EQNX is already at v${currentVersion}. Nothing to update.\n`);
  }

  const planLine = `EQNX v${currentVersion} → v${latestVersion} (via ${packageManager})\n`;

  // `--yes` keeps its exact meaning of "skip the question", so only a bare
  // invocation handed a prompt ever asks.
  const asked = !apply && prompt !== undefined;

  if (!apply) {
    if (prompt === undefined) {
      return success(`${planLine}\nRe-run with --yes to apply.\n`);
    }
    prompt.note(planLine.trimEnd(), "Update plan");
    const confirmed = await prompt.confirm({
      message: `Update to v${latestVersion}?`,
    });
    if (confirmed.cancelled || !confirmed.value) return success(CANCELLED);
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
        `EQNX was upgraded to v${latestVersion}, but reconciling integrations failed:\n` +
          `${indented}\n` +
          `Your integrations are still on the previous version. ` +
          `Once the above is resolved, run \`eqnx setup --yes\` to finish.`,
      );
    }
  }

  // The upgrade replaced the executable underneath a login service that is
  // still running the previous one, and launchd will not notice on its own.
  if (serviceCliPath !== undefined) {
    const restarted = deps.restartConnection(ctx.env);
    if (restarted.kind === "failed") {
      const indented = restarted.reason
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      return failure(
        `EQNX was upgraded to v${latestVersion}, but the local connection would not restart:\n` +
          `${indented}\n` +
          `The previous connection is still running. Once the above is resolved, ` +
          `run \`eqnx connection restart\` to finish.`,
      );
    }
  }

  // The terminal already displayed the plan above the question, so the closing
  // summary does not repeat it — the same treatment interactive setup gives its
  // own plan.
  const summaryPlan = asked ? "" : `${planLine}\n`;
  return success(`${summaryPlan}Updated to v${latestVersion} and reconciled registered targets.\n`);
}
