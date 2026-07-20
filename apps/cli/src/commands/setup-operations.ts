import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { failure, success, type CommandResult, type Env } from "./seam.ts";

/**
 * The user-level skills Trace installs into a Claude Code config root. These
 * are the canonical templates shipped alongside the CLI (see plugin/skills).
 */
export const TRACE_CLAUDE_SKILLS = [
  "board",
  "doc-placement",
  "recall",
  "reenter",
  "state",
  "trace",
] as const;

/** The Claude Code hook events Trace registers, with their settings matchers. */
export const TRACE_CLAUDE_HOOKS = [
  { event: "SessionStart", command: "hook session-start", matcher: "startup|resume|clear|compact" },
  { event: "SubagentStop", command: "hook subagent-stop" },
  { event: "Stop", command: "hook stop" },
] as const;

export type PackageManager = "npm" | "pnpm" | "bun";

export type ClaudeSetupOptions = {
  /** The Claude config root to install into (e.g. `~/.claude`). */
  configRoot: string;
  /** Path to the Trace integration registry (e.g. `~/.trace/integrations.json`). */
  registryPath: string;
  /** Directory holding the packaged skill templates (`plugin/skills`). */
  skillsSourceDir: string;
  /** Absolute path to the persistent Trace CLI used for hook commands. */
  cliPath: string;
  /** The CLI version being installed. */
  version: string;
  /** The package manager that owns the CLI install. */
  packageManager: PackageManager;
};

/**
 * Locates the packaged skill templates. Works both from the source tree
 * (`plugin/skills` above the CLI package) and from a published bundle, where
 * `__TRACE_BUNDLE_DIR__` marks the directory of the running `trace.js`.
 */
export function resolvePackagedSkillsDir(): string {
  const sourceRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const bundleDir = (globalThis as { __TRACE_BUNDLE_DIR__?: string })
    .__TRACE_BUNDLE_DIR__;

  const candidates = [
    join(sourceRoot, "plugin", "skills"),
    ...(bundleDir
      ? [join(bundleDir, "skills"), join(bundleDir, "plugin", "skills")]
      : []),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "trace", "SKILL.md"))) {
      return candidate;
    }
  }

  return join(sourceRoot, "plugin", "skills");
}

/**
 * Installs the Trace skills and hooks into a Claude config root. Idempotent:
 * files are only written when their bytes differ, so a second run against an
 * already-current target performs no filesystem mutation.
 */
export function applyClaudeSetup(options: ClaudeSetupOptions): void {
  installSkills(options);
  installHooks(options);
  recordTarget(options);
}

type TargetRecord = {
  tool: "claude";
  root: string;
  cliPath: string;
  version: string;
  skills: string[];
  hooks: string[];
};

type Registry = { packageManager: PackageManager; targets: TargetRecord[] };

/**
 * Upserts the Trace-owned target into the integration registry, keyed by
 * (tool, root) so re-registering the same root replaces its record and new
 * roots append additively. Records the package manager that owns the install.
 */
function recordTarget(options: ClaudeSetupOptions): void {
  const existing = existsSync(options.registryPath)
    ? (JSON.parse(readFileSync(options.registryPath, "utf8")) as Registry)
    : { packageManager: options.packageManager, targets: [] as TargetRecord[] };

  const record: TargetRecord = {
    tool: "claude",
    root: options.configRoot,
    cliPath: options.cliPath,
    version: options.version,
    skills: [...TRACE_CLAUDE_SKILLS],
    hooks: TRACE_CLAUDE_HOOKS.map((hook) => hook.event),
  };

  const targets = existing.targets.filter(
    (target) => !(target.tool === record.tool && target.root === record.root),
  );
  targets.push(record);

  const registry: Registry = {
    packageManager: options.packageManager,
    targets,
  };
  writeFileIfChanged(
    options.registryPath,
    `${JSON.stringify(registry, null, 2)}\n`,
  );
}

type HookEntry = { matcher?: string; hooks: { type: "command"; command: string }[] };

/** Builds the Trace-owned hook entries keyed by Claude hook event. */
function traceHookEntries(cliPath: string): Record<string, HookEntry[]> {
  const entries: Record<string, HookEntry[]> = {};
  for (const hook of TRACE_CLAUDE_HOOKS) {
    const entry: HookEntry = {
      hooks: [{ type: "command", command: `${cliPath} ${hook.command}` }],
    };
    if ("matcher" in hook && hook.matcher) entry.matcher = hook.matcher;
    entries[hook.event] = [entry];
  }
  return entries;
}

function installHooks(options: ClaudeSetupOptions): void {
  const settingsPath = join(options.configRoot, "settings.json");
  const settings = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
    : {};

  const hooks = (settings.hooks as Record<string, unknown>) ?? {};
  settings.hooks = { ...hooks, ...traceHookEntries(options.cliPath) };

  writeFileIfChanged(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function installSkills(options: ClaudeSetupOptions): void {
  const skillsRoot = join(options.configRoot, "skills");
  for (const skill of TRACE_CLAUDE_SKILLS) {
    const source = join(options.skillsSourceDir, skill);
    const destination = join(skillsRoot, skill);
    copyTreeIfChanged(source, destination);
  }
}

/**
 * Recursively mirrors `source` to `destination`, writing only files whose
 * bytes differ and removing Trace-owned files that no longer exist in source.
 */
function copyTreeIfChanged(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  const desired = new Set<string>();
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const src = join(source, entry.name);
    const dst = join(destination, entry.name);
    desired.add(entry.name);
    if (entry.isDirectory()) {
      copyTreeIfChanged(src, dst);
    } else {
      writeFileIfChanged(dst, readFileSync(src));
    }
  }
}

function writeFileIfChanged(path: string, content: Buffer | string): void {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (existsSync(path)) {
    const current = readFileSync(path);
    if (current.equals(buffer)) return;
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, buffer);
}

/** Renders the human-readable installation plan shown before applying. */
export function planClaudeSetup(options: ClaudeSetupOptions): string {
  const lines = [
    `Trace setup plan for Claude Code (v${options.version}, via ${options.packageManager})`,
    `  target root: ${options.configRoot}`,
    `  CLI command: ${options.cliPath}`,
    `  skills: ${TRACE_CLAUDE_SKILLS.join(", ")}`,
    `  hooks: ${TRACE_CLAUDE_HOOKS.map((hook) => hook.event).join(", ")}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Resolves the default Claude config root for the active user. */
export function resolveClaudeConfigRoot(env: Env): string {
  const home = env.HOME || env.USERPROFILE;
  if (!home) {
    throw new Error("HOME/USERPROFILE must be set to resolve the Claude config root");
  }
  return join(home, ".claude");
}

/** Resolves the Trace integration registry path (beside the Trace database). */
export function resolveRegistryPath(env: Env): string {
  const home = env.HOME || env.USERPROFILE;
  if (!home) {
    throw new Error("HOME/USERPROFILE must be set to resolve the Trace registry path");
  }
  return join(home, ".trace", "integrations.json");
}

/** Absolute path to the persistent Trace CLI, used for hook commands. */
export function resolveTraceCliPath(env: Env): string {
  if (env.TRACE_CLI_PATH) return env.TRACE_CLI_PATH;
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

/** Reads the installed CLI version from the packaged manifest. */
export function resolvePackagedVersion(): string {
  for (const candidate of [
    fileURLToPath(new URL("../../package.json", import.meta.url)),
    fileURLToPath(new URL("../package.json", import.meta.url)),
  ]) {
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        version?: string;
      };
      if (parsed.version) return parsed.version;
    }
  }
  return "0.0.0";
}

/**
 * Determines which package manager owns the CLI install so `trace update` can
 * later reinstall through the same tool. Prefers the running invocation's
 * `npm_config_user_agent`, then falls back to path-based heuristics.
 */
export function detectPackageManager(env: Env, cliPath: string): PackageManager {
  const agent = env.npm_config_user_agent;
  if (agent) {
    const name = agent.split("/", 1)[0];
    if (name === "pnpm" || name === "bun" || name === "npm") return name;
  }
  if (/[\\/](\.)?pnpm[\\/]/.test(cliPath)) return "pnpm";
  if (/[\\/]\.bun[\\/]/.test(cliPath)) return "bun";
  return "npm";
}

export function setupOperation(
  rawArgs: string[],
  ctx: { env: Env; cwd: string; stdin: string },
): CommandResult {
  const tool = flagValue(rawArgs, "--tool");
  const apply = rawArgs.includes("--yes");

  if (tool !== "claude") {
    return failure(
      tool === undefined
        ? "Usage: trace setup --tool claude [--yes]"
        : `Unsupported tool "${tool}" (supported: claude)`,
    );
  }

  const options: ClaudeSetupOptions = {
    configRoot: resolveClaudeConfigRoot(ctx.env),
    registryPath: resolveRegistryPath(ctx.env),
    skillsSourceDir: resolvePackagedSkillsDir(),
    cliPath: resolveTraceCliPath(ctx.env),
    version: resolvePackagedVersion(),
    packageManager: detectPackageManager(ctx.env, resolveTraceCliPath(ctx.env)),
  };

  const plan = planClaudeSetup(options);
  if (!apply) {
    return success(`${plan}\nRe-run with --yes to apply.\n`);
  }

  applyClaudeSetup(options);
  return success(`${plan}\nInstalled Trace into ${options.configRoot}.\n`);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}
