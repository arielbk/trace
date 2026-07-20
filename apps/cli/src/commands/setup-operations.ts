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

/** The user-level skills Trace installs into a Codex config root. */
export const TRACE_CODEX_SKILLS = [
  "board",
  "doc-placement",
  "recall",
  "reenter",
  "state",
  "trace",
] as const;

/** The user-level skills Trace installs into a Cursor config root. */
export const TRACE_CURSOR_SKILLS = [
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

/** Shared options for all agent setup targets. */
export type AgentSetupOptions = {
  /** The agent config root to install into (e.g. `~/.claude`, `~/.codex`, `~/.cursor`). */
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

export type ClaudeSetupOptions = AgentSetupOptions;
export type CodexSetupOptions = AgentSetupOptions;
export type CursorSetupOptions = AgentSetupOptions;

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
  installSkills(options, TRACE_CLAUDE_SKILLS);
  installHooks(options);
  recordTarget(
    options,
    "claude",
    TRACE_CLAUDE_SKILLS,
    TRACE_CLAUDE_HOOKS.map((hook) => hook.event),
  );
}

/**
 * Installs the Trace skills into a Codex config root. Codex has no hook
 * system, so only skills and registry metadata are written.
 */
export function applyCodexSetup(options: CodexSetupOptions): void {
  installSkills(options, TRACE_CODEX_SKILLS);
  recordTarget(options, "codex", TRACE_CODEX_SKILLS, []);
}

/**
 * Installs the Trace skills into a Cursor config root. Cursor has no hook
 * system, so only skills and registry metadata are written.
 */
export function applyCursorSetup(options: CursorSetupOptions): void {
  installSkills(options, TRACE_CURSOR_SKILLS);
  recordTarget(options, "cursor", TRACE_CURSOR_SKILLS, []);
}

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

/**
 * Upserts the Trace-owned target into the integration registry, keyed by
 * (tool, root) so re-registering the same root replaces its record and new
 * roots append additively. Records the package manager that owns the install.
 */
function recordTarget(
  options: AgentSetupOptions,
  tool: ToolName,
  skills: readonly string[],
  hooks: string[],
): void {
  const existing = existsSync(options.registryPath)
    ? (JSON.parse(readFileSync(options.registryPath, "utf8")) as Registry)
    : { packageManager: options.packageManager, targets: [] as TargetRecord[] };

  const record: TargetRecord = {
    tool,
    root: options.configRoot,
    cliPath: options.cliPath,
    version: options.version,
    skills: [...skills],
    hooks,
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

function installHooks(options: AgentSetupOptions): void {
  const settingsPath = join(options.configRoot, "settings.json");
  const settings = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
    : {};

  const hooks = (settings.hooks as Record<string, unknown>) ?? {};
  settings.hooks = { ...hooks, ...traceHookEntries(options.cliPath) };

  writeFileIfChanged(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function installSkills(
  options: AgentSetupOptions,
  skills: readonly string[],
): void {
  const skillsRoot = join(options.configRoot, "skills");
  for (const skill of skills) {
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

/** Renders the human-readable installation plan for a Codex target. */
export function planCodexSetup(options: CodexSetupOptions): string {
  const lines = [
    `Trace setup plan for Codex (v${options.version}, via ${options.packageManager})`,
    `  target root: ${options.configRoot}`,
    `  CLI command: ${options.cliPath}`,
    `  skills: ${TRACE_CODEX_SKILLS.join(", ")}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Renders the human-readable installation plan for a Cursor target. */
export function planCursorSetup(options: CursorSetupOptions): string {
  const lines = [
    `Trace setup plan for Cursor (v${options.version}, via ${options.packageManager})`,
    `  target root: ${options.configRoot}`,
    `  CLI command: ${options.cliPath}`,
    `  skills: ${TRACE_CURSOR_SKILLS.join(", ")}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Resolves the Claude config root for ordinary setup: an explicit
 * `CLAUDE_CONFIG_DIR` wins over the default `~/.claude` root. Callers layer an
 * explicit `--target` on top of this (explicit target > env > default).
 */
export function resolveClaudeConfigRoot(env: Env): string {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  const home = env.HOME || env.USERPROFILE;
  if (!home) {
    throw new Error("HOME/USERPROFILE must be set to resolve the Claude config root");
  }
  return join(home, ".claude");
}

/**
 * Resolves the Codex config root: `CODEX_HOME` wins over the default
 * `~/.codex`. Callers may layer an explicit `--target` on top.
 */
export function resolveCodexConfigRoot(env: Env): string {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  const home = env.HOME || env.USERPROFILE;
  if (!home) {
    throw new Error("HOME/USERPROFILE must be set to resolve the Codex config root");
  }
  return join(home, ".codex");
}

/** Resolves the Cursor config root (`~/.cursor`). */
export function resolveCursorConfigRoot(env: Env): string {
  const home = env.HOME || env.USERPROFILE;
  if (!home) {
    throw new Error("HOME/USERPROFILE must be set to resolve the Cursor config root");
  }
  return join(home, ".cursor");
}

/**
 * Returns the Codex config root if a Codex installation is detected
 * (i.e. the root directory already exists), otherwise `undefined`.
 */
export function detectCodexInstall(env: Env): string | undefined {
  try {
    const root = resolveCodexConfigRoot(env);
    return existsSync(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the Cursor config root if a Cursor installation is detected
 * (i.e. the root directory already exists), otherwise `undefined`.
 */
export function detectCursorInstall(env: Env): string | undefined {
  try {
    const root = resolveCursorConfigRoot(env);
    return existsSync(root) ? root : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Parses an explicit `--target tool=/path` selector. Returns `undefined` when
 * no `--target` flag is present, and throws on a missing or malformed value so
 * the caller can surface usage guidance rather than silently guessing a root.
 */
export function parseTargetFlag(
  args: string[],
): { tool: string; root: string } | undefined {
  const index = args.indexOf("--target");
  if (index === -1) return undefined;
  const value = args[index + 1];
  const separator = value?.indexOf("=") ?? -1;
  if (!value || separator <= 0 || separator === value.length - 1) {
    throw new Error("Usage: trace setup --target <tool>=<path> [--yes]");
  }
  return { tool: value.slice(0, separator), root: value.slice(separator + 1) };
}

/** Reads the already-registered config roots for a given tool from the registry. */
function registeredTargetRoots(registryPath: string, tool: ToolName): string[] {
  if (!existsSync(registryPath)) return [];
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  return registry.targets
    .filter((target) => target.tool === tool)
    .map((target) => target.root);
}

export function setupOperation(
  rawArgs: string[],
  ctx: { env: Env; cwd: string; stdin: string },
): CommandResult {
  const apply = rawArgs.includes("--yes");

  let explicitTarget: { tool: string; root: string } | undefined;
  try {
    explicitTarget = parseTargetFlag(rawArgs);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  const toolArg = explicitTarget?.tool ?? flagValue(rawArgs, "--tool");

  // When a tool is explicitly specified, route to that tool's setup.
  if (toolArg !== undefined) {
    if (toolArg !== "claude" && toolArg !== "codex" && toolArg !== "cursor") {
      return failure(
        `Unsupported tool "${toolArg}" (supported: claude, codex, cursor)`,
      );
    }
    return setupSingleTool(toolArg, explicitTarget?.root, apply, ctx);
  }

  // No explicit tool — detect installed hosts and run setup for each.
  const plans: string[] = [];
  const installed: string[] = [];

  const codexRoot = detectCodexInstall(ctx.env);
  const cursorRoot = detectCursorInstall(ctx.env);

  if (!codexRoot && !cursorRoot) {
    return failure(
      "No installed hosts detected. Use --tool <claude|codex|cursor> or --target <tool>=<path> [--yes]",
    );
  }

  const registryPath = resolveRegistryPath(ctx.env);
  const cliPath = resolveTraceCliPath(ctx.env);
  const shared = {
    registryPath,
    skillsSourceDir: resolvePackagedSkillsDir(),
    cliPath,
    version: resolvePackagedVersion(),
    packageManager: detectPackageManager(ctx.env, cliPath),
  };

  if (codexRoot) {
    const opts: CodexSetupOptions = { configRoot: codexRoot, ...shared };
    plans.push(planCodexSetup(opts));
    if (apply) {
      applyCodexSetup(opts);
      installed.push(codexRoot);
    }
  }
  if (cursorRoot) {
    const opts: CursorSetupOptions = { configRoot: cursorRoot, ...shared };
    plans.push(planCursorSetup(opts));
    if (apply) {
      applyCursorSetup(opts);
      installed.push(cursorRoot);
    }
  }

  const plan = plans.join("\n");
  if (!apply) {
    return success(`${plan}\nRe-run with --yes to apply.\n`);
  }
  return success(`${plan}\nInstalled Trace into ${installed.join(", ")}.\n`);
}

function setupSingleTool(
  tool: ToolName,
  explicitRoot: string | undefined,
  apply: boolean,
  ctx: { env: Env; cwd: string; stdin: string },
): CommandResult {
  const registryPath = resolveRegistryPath(ctx.env);
  const cliPath = resolveTraceCliPath(ctx.env);
  const shared = {
    registryPath,
    skillsSourceDir: resolvePackagedSkillsDir(),
    cliPath,
    version: resolvePackagedVersion(),
    packageManager: detectPackageManager(ctx.env, cliPath),
  };

  if (tool === "claude") {
    // Reconcile all already-registered Claude roots alongside the primary root.
    const primaryRoot = explicitRoot ?? resolveClaudeConfigRoot(ctx.env);
    const roots = [
      ...new Set([...registeredTargetRoots(registryPath, "claude"), primaryRoot]),
    ];
    const optionsPerRoot = roots.map(
      (configRoot): ClaudeSetupOptions => ({ configRoot, ...shared }),
    );
    const plan = optionsPerRoot.map(planClaudeSetup).join("\n");
    if (!apply) {
      return success(`${plan}\nRe-run with --yes to apply.\n`);
    }
    for (const options of optionsPerRoot) applyClaudeSetup(options);
    return success(`${plan}\nInstalled Trace into ${roots.join(", ")}.\n`);
  }

  if (tool === "codex") {
    const root = explicitRoot ?? resolveCodexConfigRoot(ctx.env);
    const opts: CodexSetupOptions = { configRoot: root, ...shared };
    const plan = planCodexSetup(opts);
    if (!apply) {
      return success(`${plan}\nRe-run with --yes to apply.\n`);
    }
    applyCodexSetup(opts);
    return success(`${plan}\nInstalled Trace into ${root}.\n`);
  }

  // tool === "cursor"
  const root = explicitRoot ?? resolveCursorConfigRoot(ctx.env);
  const opts: CursorSetupOptions = { configRoot: root, ...shared };
  const plan = planCursorSetup(opts);
  if (!apply) {
    return success(`${plan}\nRe-run with --yes to apply.\n`);
  }
  applyCursorSetup(opts);
  return success(`${plan}\nInstalled Trace into ${root}.\n`);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}
