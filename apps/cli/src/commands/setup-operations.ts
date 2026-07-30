import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IntegrationRegistry,
  isToolName,
  TOOL_NAMES,
  type PackageManager,
  type TargetRecord,
  type ToolName,
} from "./integration-registry.ts";
import {
  discoverTargetCandidates,
  resolveClaudeConfigRoot,
  resolveCodexConfigRoot,
  resolveCopilotConfigRoot,
  resolveCursorConfigRoot,
  TOOL_LABELS,
} from "./setup-candidates.ts";
import { failure, success, type CommandResult, type Env } from "./seam.ts";

/** The `<claude|codex|...>` fragment used in usage strings and flag errors. */
const TOOL_CHOICES = TOOL_NAMES.join("|");

/** Shown when neither detection nor the registry names a single target. */
export const EMPTY_INVENTORY =
  `No installed hosts detected. Use --tool <${TOOL_CHOICES}> or --target <tool>=<path> [--yes]`;

function unsupportedTool(tool: string): string {
  return `Unsupported tool "${tool}" (supported: ${TOOL_NAMES.join(", ")})`;
}

/** Canonical user-level skills installed into every supported host. */
const TRACE_SKILLS = [
  "board",
  "doc-placement",
  "recall",
  "reenter",
  "state",
  "trace",
] as const;

/** The Claude Code hook events Trace registers, with their settings matchers. */
const TRACE_CLAUDE_HOOKS = [
  { event: "SessionStart", command: "hook session-start", matcher: "startup|resume|clear|compact" },
  { event: "SubagentStop", command: "hook subagent-stop" },
  { event: "Stop", command: "hook stop" },
] as const;

/** The Copilot CLI hook events Trace registers. */
const TRACE_COPILOT_HOOKS = [
  { event: "sessionStart", command: "hook session-start" },
  { event: "agentStop", command: "hook stop" },
  { event: "subagentStop", command: "hook subagent-stop" },
] as const;

/**
 * Copilot ignores command-hook stdout at `sessionStart`, so the binding nudge
 * rides a prompt-type hook (auto-submitted text) instead of the command's
 * output the way Claude's does.
 */
const COPILOT_BINDING_NUDGE =
  "Consult the installed Trace skill before beginning work. " +
  "If this session is not bound, use Trace to bind or re-enter the task.";

/**
 * The single Copilot hooks file Trace owns end to end. Copilot reads every
 * `.json` under `<root>/hooks/`, so Trace writes its own file rather than
 * merging into a shared one — removal is then a whole-file delete.
 */
const COPILOT_HOOKS_FILE = "trace.json";

type GuardrailsResult = { ok: true } | { ok: false; error: string };

/** Shared options for all agent setup targets. */
type AgentSetupOptions = {
  /** The agent config root to install into (e.g. `~/.claude`, `~/.codex`, `~/.cursor`). */
  configRoot: string;
  /** Registered Trace integration targets and their owned artifacts. */
  registry: IntegrationRegistry;
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
 * Locates the packaged skill templates. Checks two locations:
 * 1. Source tree: `plugin/skills` four levels above `src/commands/setup-operations.ts`
 * 2. Published bundle: `dist/skills/` adjacent to `dist/trace.js` (copied there
 *    by the build step so the tarball ships the canonical templates)
 */
function resolvePackagedSkillsDir(): string {
  const sourceRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const bundleDir = dirname(resolve(fileURLToPath(import.meta.url)));

  const candidates = [
    join(sourceRoot, "plugin", "skills"),
    join(bundleDir, "skills"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "trace", "SKILL.md"))) {
      return candidate;
    }
  }

  return join(sourceRoot, "plugin", "skills");
}

function targetRecord(
  options: AgentSetupOptions,
  tool: ToolName,
  skills: readonly string[],
  hooks: string[],
): TargetRecord {
  return {
    tool,
    root: options.configRoot,
    cliPath: options.cliPath,
    version: options.version,
    skills: [...skills],
    hooks,
  };
}

type HookEntry = { matcher?: string; hooks: { type: "command"; command: string }[] };

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:.,@%+=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Quotes a command path for PowerShell. A quoted path is not executable on its
 * own there, so anything needing quotes is invoked through the call operator.
 */
function powershellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:.\\@%+=-]+$/.test(value)) return value;
  return `& '${value.replaceAll("'", "''")}'`;
}

/** Builds the Trace-owned hook entries keyed by Claude hook event. */
function traceHookEntries(cliPath: string): Record<string, HookEntry[]> {
  const entries: Record<string, HookEntry[]> = {};
  const commandPath = shellQuote(cliPath);
  for (const hook of TRACE_CLAUDE_HOOKS) {
    const entry: HookEntry = {
      hooks: [{ type: "command", command: `${commandPath} ${hook.command}` }],
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

function copilotHooksPath(configRoot: string): string {
  return join(configRoot, "hooks", COPILOT_HOOKS_FILE);
}

/**
 * Builds Trace's Copilot hooks file. Every command hook carries both a `bash`
 * and a `powershell` invocation of the same absolute CLI path, which is how
 * Copilot dispatches per platform.
 */
function copilotHooksConfig(cliPath: string): string {
  const bash = shellQuote(cliPath);
  const powershell = powershellQuote(cliPath);

  const hooks: Record<string, unknown[]> = {};
  for (const hook of TRACE_COPILOT_HOOKS) {
    const entries: unknown[] = [
      {
        type: "command",
        bash: `${bash} ${hook.command}`,
        powershell: `${powershell} ${hook.command}`,
      },
    ];
    if (hook.event === "sessionStart") {
      entries.push({ type: "prompt", prompt: COPILOT_BINDING_NUDGE });
    }
    hooks[hook.event] = entries;
  }

  return `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
}

function installCopilotHooks(options: AgentSetupOptions): void {
  writeFileIfChanged(
    copilotHooksPath(options.configRoot),
    copilotHooksConfig(options.cliPath),
  );
}

/** Refuses a Copilot setup that would clobber a hooks file Trace does not own. */
function checkCopilotConfig(options: AgentSetupOptions): GuardrailsResult {
  const hooksPath = copilotHooksPath(options.configRoot);
  const owned = options.registry
    .target("copilot", options.configRoot)
    ?.hooks.length;
  if (existsSync(hooksPath) && !owned) {
    return {
      ok: false,
      error:
        `Unowned Copilot hooks file at ${hooksPath}.\n` +
        `  Trace cannot overwrite a hooks file it did not install.\n` +
        `  Remediation: remove or back up ${COPILOT_HOOKS_FILE}, then re-run trace setup.`,
    };
  }

  return { ok: true };
}

function uninstallCopilotConfig(
  options: RemovalOptions,
  target: TargetRecord,
): void {
  if (target.hooks.length === 0) return;
  rmSync(copilotHooksPath(options.configRoot), { force: true });
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
  for (const entry of readdirSync(destination)) {
    if (!desired.has(entry)) {
      rmSync(join(destination, entry), { recursive: true, force: true });
    }
  }
}

function writeFileIfChanged(path: string, content: Buffer | string): void {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (existsSync(path)) {
    const current = readFileSync(path);
    if (current.equals(buffer)) return;
  }
  writeFileAtomically(path, buffer);
}

/**
 * Writes `buffer` to `path` atomically: the bytes land in a sibling temp file
 * first, then a single `rename` moves it into place. This guarantees that a
 * process killed mid-write never leaves a partial file at the final path.
 */
function writeFileAtomically(path: string, buffer: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.trace-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, buffer);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch { /* best-effort cleanup; ignore if temp file already gone */ }
    throw err;
  }
}

/**
 * Checks whether a Claude setup can safely proceed without clobbering
 * user-owned artifacts. Returns `{ ok: false, error }` with exact
 * remediation guidance when a blocking condition is detected.
 */
function checkClaudeConfig(options: AgentSetupOptions): GuardrailsResult {
  const settingsPath = join(options.configRoot, "settings.json");

  if (existsSync(settingsPath)) {
    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      return {
        ok: false,
        error:
          `${settingsPath} contains malformed JSON. Fix or remove it before running trace setup.`,
      };
    }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      return {
        ok: false,
        error: `${settingsPath} must contain a JSON object before running trace setup.`,
      };
    }

    // Detect legacy @arielbk/trace plugin entries.
    const plugins = settings.plugins;
    if (
      Array.isArray(plugins) &&
      plugins.some((p) => typeof p === "string" && p.includes("@arielbk/trace"))
    ) {
      return {
        ok: false,
        error:
          `Detected legacy @arielbk/trace plugin in ${settingsPath}.\n` +
          `  Remediation: remove the "@arielbk/trace" entry from the "plugins" array, then re-run trace setup.`,
      };
    }

    const hooksValue = settings.hooks;
    if (
      hooksValue !== undefined &&
      (hooksValue === null ||
        typeof hooksValue !== "object" ||
        Array.isArray(hooksValue))
    ) {
      return {
        ok: false,
        error: `${settingsPath} "hooks" must contain a JSON object before running trace setup.`,
      };
    }
    const hooks = hooksValue as Record<string, unknown> | undefined;
    if (hooks) {
      // Detect pinned npx trace hooks (legacy installation pattern).
      for (const [event, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (typeof entry !== "object" || !entry) continue;
          const hooksList = (entry as { hooks?: unknown }).hooks;
          if (!Array.isArray(hooksList)) continue;
          for (const hook of hooksList) {
            if (typeof hook !== "object" || !hook) continue;
            const command = (hook as { command?: unknown }).command;
            if (
              typeof command === "string" &&
              /npx\s+(@arielbk\/)?trace\b/.test(command)
            ) {
              return {
                ok: false,
                error:
                  `Detected pinned npx trace hook in ${settingsPath} (event "${event}"):\n` +
                  `  "${command}"\n` +
                  `  Remediation: remove this hook entry, then re-run trace setup.`,
              };
            }
          }
        }
      }

      // Detect unowned hook event collisions.
      const ownedHooks = new Set(
        options.registry.target("claude", options.configRoot)?.hooks ?? [],
      );
      for (const { event } of TRACE_CLAUDE_HOOKS) {
        if (event in hooks && !ownedHooks.has(event)) {
          return {
            ok: false,
            error:
              `Unowned "${event}" hook detected in ${settingsPath}.\n` +
              `  Trace cannot overwrite a hook it did not install.\n` +
              `  Remediation: remove or back up the "${event}" hook entry, then re-run trace setup.`,
          };
        }
      }
    }
  }

  return { ok: true };
}

/** Absolute path to the persistent Trace CLI, used for hook commands. */
function resolveTraceCliPath(env: Env): string {
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
function detectPackageManager(env: Env, cliPath: string): PackageManager {
  const agent = env.npm_config_user_agent;
  if (agent) {
    const name = agent.split("/", 1)[0];
    if (name === "pnpm" || name === "bun" || name === "npm") return name;
  }
  if (/[\\/](\.)?pnpm[\\/]/.test(cliPath)) return "pnpm";
  if (/[\\/]\.bun[\\/]/.test(cliPath)) return "bun";
  return "npm";
}

function checkManagedCliPath(cliPath: string): GuardrailsResult {
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

/**
 * Parses an explicit `--target tool=/path` selector. Returns `undefined` when
 * no `--target` flag is present, and throws on a missing or malformed value so
 * the caller can surface usage guidance rather than silently guessing a root.
 */
function parseTargetFlag(
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

type SetupAdapter = {
  tool: ToolName;
  label: string;
  resolveRoot: (env: Env) => string;
  hooks: readonly { event: string }[];
  preflightConfig?: (options: AgentSetupOptions) => GuardrailsResult;
  installConfig?: (options: AgentSetupOptions) => void;
  uninstallConfig?: (options: RemovalOptions, target: TargetRecord) => void;
};

const SETUP_ADAPTERS: Record<ToolName, SetupAdapter> = {
  claude: {
    tool: "claude",
    label: "Claude Code",
    resolveRoot: resolveClaudeConfigRoot,
    hooks: TRACE_CLAUDE_HOOKS,
    preflightConfig: checkClaudeConfig,
    installConfig: installHooks,
    uninstallConfig: uninstallClaudeConfig,
  },
  codex: {
    tool: "codex",
    label: "Codex",
    resolveRoot: resolveCodexConfigRoot,
    hooks: [],
  },
  cursor: {
    tool: "cursor",
    label: "Cursor",
    resolveRoot: resolveCursorConfigRoot,
    hooks: [],
  },
  copilot: {
    tool: "copilot",
    label: TOOL_LABELS.copilot,
    resolveRoot: resolveCopilotConfigRoot,
    hooks: TRACE_COPILOT_HOOKS,
    preflightConfig: checkCopilotConfig,
    installConfig: installCopilotHooks,
    uninstallConfig: uninstallCopilotConfig,
  },
};

function planInstalledTarget(
  options: AgentSetupOptions,
  adapter: SetupAdapter,
): string {
  const lines = [
    `Trace setup plan for ${adapter.label} (v${options.version}, via ${options.packageManager})`,
    `  target root: ${options.configRoot}`,
    `  CLI command: ${options.cliPath}`,
    `  skills: ${TRACE_SKILLS.join(", ")}`,
    ...(adapter.hooks.length > 0
      ? [`  hooks: ${adapter.hooks.map(({ event }) => event).join(", ")}`]
      : []),
  ];
  return `${lines.join("\n")}\n`;
}

function checkInstalledTarget(
  options: AgentSetupOptions,
  adapter: SetupAdapter,
): GuardrailsResult {
  const configCheck = adapter.preflightConfig?.(options);
  if (configCheck && !configCheck.ok) return configCheck;

  const ownedSkills = new Set(
    options.registry.target(adapter.tool, options.configRoot)?.skills ?? [],
  );
  for (const skill of TRACE_SKILLS) {
    const skillPath = join(options.configRoot, "skills", skill);
    if (existsSync(skillPath) && !ownedSkills.has(skill)) {
      return {
        ok: false,
        error:
          `Unowned skill directory at ${skillPath}.\n` +
          `  Trace cannot overwrite a skill it did not install.\n` +
          `  Remediation: remove or back up the "${skill}" directory, then re-run trace setup.`,
      };
    }
  }
  return { ok: true };
}

function applyInstalledTarget(
  options: AgentSetupOptions,
  adapter: SetupAdapter,
): void {
  installSkills(options, TRACE_SKILLS);
  adapter.installConfig?.(options);
}

type InstalledTarget = { adapter: SetupAdapter; root: string };
type SkippedTarget = { root: string; label: string; reason: string };
type ReconcileResult = CommandResult & {
  /** Structured counterpart to the human-readable skipped-target section. */
  skippedTargets?: readonly SkippedTarget[];
};

/**
 * How a reconciliation renders itself. The flag-driven paths keep the default
 * "re-run with --yes" footer; the interactive flow reviews its plan in the
 * terminal and supplies its own.
 */
type ReconcileFormat = {
  previewFooter?: string;
  /** Whether an apply summary re-renders the plan it already previewed. */
  planInSummary?: boolean;
};

function sharedSetupOptions(
  env: Env,
  registry: IntegrationRegistry,
): Omit<AgentSetupOptions, "configRoot"> {
  const cliPath = resolveTraceCliPath(env);
  return {
    registry,
    skillsSourceDir: resolvePackagedSkillsDir(),
    cliPath,
    version: resolvePackagedVersion(),
    packageManager: detectPackageManager(env, cliPath),
  };
}

/**
 * Reconciles a batch of targets. `onGuardrailFailure` decides what a failed
 * pre-flight means:
 * - `"abort"` (explicit `--tool` / `--target`): the first failing target is
 *   fatal — the batch stops before any write. Byte-for-byte the original
 *   behavior, so a target the user named is never silently skipped.
 * - `"skip"` (auto-discovered batches: no-tool auto-detect, `--registered`):
 *   failing targets are set aside with their remediation, the healthy ones
 *   still install, and the summary lists what was skipped and why. Only when
 *   *every* target is skipped does the batch fail.
 */
function reconcileInstalledTargets(
  targets: InstalledTarget[],
  apply: boolean,
  env: Env,
  registry: IntegrationRegistry,
  onGuardrailFailure: "abort" | "skip",
  format: ReconcileFormat = {},
): ReconcileResult {
  const previewFooter = format.previewFooter ?? "\nRe-run with --yes to apply.\n";
  if (targets.length === 0) return success("Nothing to reconcile.\n");

  const shared = sharedSetupOptions(env, registry);
  const cliCheck = checkManagedCliPath(shared.cliPath);
  if (!cliCheck.ok) return failure(cliCheck.error);
  const installations = targets.map(({ adapter, root }) => ({
    adapter,
    options: { configRoot: root, ...shared },
  }));

  // Abort-mode preview keeps the original guardrail-free plan (the explicit
  // path is unchanged); guardrails still run on apply, failing fast below.
  if (!apply && onGuardrailFailure === "abort") {
    const plan = installations
      .map(({ adapter, options }) => planInstalledTarget(options, adapter))
      .join("\n");
    return success(`${plan}${previewFooter}`);
  }

  // Partition by pre-flight. Runs for every apply and for skip-mode preview, so
  // the plan a skip-mode preview shows matches what the apply would do.
  const installable: typeof installations = [];
  const skipped: SkippedTarget[] = [];
  for (const { adapter, options } of installations) {
    const check = checkInstalledTarget(options, adapter);
    if (check.ok) {
      installable.push({ adapter, options });
    } else if (onGuardrailFailure === "abort") {
      return failure(check.error);
    } else {
      skipped.push({
        root: options.configRoot,
        label: adapter.label,
        reason: check.error,
      });
    }
  }

  const skipLines = skipped
    .map(({ label, root, reason }) => `- ${label} (${root}):\n  ${reason}`)
    .join("\n");

  // Nothing safe to install: surface every reason rather than a hollow success.
  if (installable.length === 0) {
    return {
      ...failure(`No targets could be reconciled.\n${skipLines}`),
      skippedTargets: skipped,
    };
  }

  const plan = installable
    .map(({ adapter, options }) => planInstalledTarget(options, adapter))
    .join("\n");
  const skippedSection =
    skipped.length > 0
      ? [
          "⚠ SETUP INCOMPLETE — ACTION REQUIRED",
          `${skipped.length} selected ${
            skipped.length === 1 ? "target was" : "targets were"
          } skipped and ${
            skipped.length === 1 ? "is" : "are"
          } still not configured.`,
          "Skipped targets (guardrail checks failed):",
          skipLines,
          "",
          "Fix each skipped target, then run `trace setup` again.",
          "",
        ].join("\n")
      : "";
  const skippedBlock = skippedSection ? `\n${skippedSection}` : "";

  if (!apply) {
    // Keep the action-required warning last: a mixed result must not visually
    // resolve on either the healthy plan or the generic apply footer.
    return {
      ...success(`${plan}${previewFooter}${skippedBlock}`),
      skippedTargets: skipped,
    };
  }

  try {
    for (const { adapter, options } of installable) {
      applyInstalledTarget(options, adapter);
    }
    shared.registry.upsertMany(
      shared.packageManager,
      installable.map(({ adapter, options }) =>
        targetRecord(
          options,
          adapter.tool,
          TRACE_SKILLS,
          adapter.hooks.map(({ event }) => event),
        ),
      ),
    );
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  const roots = installable.map(({ options }) => options.configRoot).join(", ");
  if (format.planInSummary === false) {
    // The caller already displayed this plan for review; only report the outcome.
    return {
      ...success(`Installed Trace into ${roots}.\n${skippedBlock}`),
      skippedTargets: skipped,
    };
  }
  return {
    ...success(`${plan}\nInstalled Trace into ${roots}.\n${skippedBlock}`),
    skippedTargets: skipped,
  };
}

/**
 * Reconciles exactly the Integration Targets a caller names, using the
 * auto-discovered batch's skip-and-warn guardrail mode. This is the seam the
 * interactive picker installs through: the selection it previews is the
 * selection it applies, and nothing is added in between.
 */
export function reconcileSelectedTargets(
  selection: readonly { tool: ToolName; root: string }[],
  options: {
    apply: boolean;
    env: Env;
    registry: IntegrationRegistry;
    format?: ReconcileFormat;
  },
): ReconcileResult {
  return reconcileInstalledTargets(
    selection.map(({ tool, root }) => ({ adapter: SETUP_ADAPTERS[tool], root })),
    options.apply,
    options.env,
    options.registry,
    "skip",
    options.format,
  );
}

function targetsForTool(
  tool: ToolName,
  primaryRoot: string,
  registeredTargets: TargetRecord[],
): InstalledTarget[] {
  const roots = registeredTargets
    .filter((target) => target.tool === tool)
    .map(({ root }) => root);
  return [...new Set([...roots, primaryRoot])]
    .map((root) => ({ adapter: SETUP_ADAPTERS[tool], root }));
}

export function setupOperation(
  rawArgs: string[],
  ctx: { env: Env; cwd: string; stdin: string },
): CommandResult {
  if (rawArgs.includes("--remove")) {
    return removeOperation(rawArgs, ctx);
  }

  const apply = rawArgs.includes("--yes");

  let explicitTarget: { tool: string; root: string } | undefined;
  try {
    explicitTarget = parseTargetFlag(rawArgs);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  const toolArg = explicitTarget?.tool ?? flagValue(rawArgs, "--tool");
  let registry: IntegrationRegistry;
  let registeredTargets: TargetRecord[];
  try {
    registry = IntegrationRegistry.fromEnv(ctx.env);
    registeredTargets = registry.targets();
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  if (rawArgs.includes("--registered")) {
    const targets = registeredTargets.map((target) => ({
      adapter: SETUP_ADAPTERS[target.tool],
      root: target.root,
    }));
    return reconcileInstalledTargets(targets, apply, ctx.env, registry, "skip");
  }

  // When a tool is explicitly specified, route to that tool's setup.
  if (toolArg !== undefined) {
    if (!isToolName(toolArg)) {
      return failure(unsupportedTool(toolArg));
    }
    const adapter = SETUP_ADAPTERS[toolArg];
    const root = explicitTarget?.root ?? adapter.resolveRoot(ctx.env);
    return reconcileInstalledTargets(
      targetsForTool(toolArg, root, registeredTargets),
      apply,
      ctx.env,
      registry,
      "abort",
    );
  }

  // No explicit tool — reconcile the complete known inventory: every detected
  // active/default root plus every registered target, deduplicated.
  const candidates = discoverTargetCandidates(ctx.env, registeredTargets);

  if (candidates.length === 0) {
    return failure(EMPTY_INVENTORY);
  }

  const targets = candidates.map(({ tool, root }) => ({
    adapter: SETUP_ADAPTERS[tool],
    root,
  }));
  return reconcileInstalledTargets(targets, apply, ctx.env, registry, "skip");
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

// ─── Removal ──────────────────────────────────────────────────────────────────

type RemovalOptions = {
  configRoot: string;
};

function planInstalledTargetRemoval(
  target: TargetRecord,
  adapter: SetupAdapter,
): string {
  const lines = [
    `Trace removal plan for ${adapter.label}`,
    `  target root: ${target.root}`,
    `  skills: ${target.skills.join(", ")}`,
    ...(target.hooks.length > 0 ? [`  hooks: ${target.hooks.join(", ")}`] : []),
  ];
  return `${lines.join("\n")}\n`;
}

function uninstallClaudeConfig(
  options: RemovalOptions,
  target: TargetRecord,
): void {
  if (target.hooks.length === 0) return;
  const settingsPath = join(options.configRoot, "settings.json");
  if (!existsSync(settingsPath)) return;

  const settings = JSON.parse(
    readFileSync(settingsPath, "utf8"),
  ) as Record<string, unknown>;
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks) return;

  for (const event of target.hooks) delete hooks[event];
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  writeFileIfChanged(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function removeInstalledTarget(
  target: TargetRecord,
  adapter: SetupAdapter,
): void {
  for (const skill of target.skills) {
    const skillPath = join(target.root, "skills", skill);
    if (existsSync(skillPath)) rmSync(skillPath, { recursive: true, force: true });
  }

  adapter.uninstallConfig?.({ configRoot: target.root }, target);
}

function planForTarget(target: TargetRecord): string {
  return planInstalledTargetRemoval(target, SETUP_ADAPTERS[target.tool]);
}

function applyRemovalForTarget(target: TargetRecord): void {
  removeInstalledTarget(target, SETUP_ADAPTERS[target.tool]);
}

function removeOperation(
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
  let registry: IntegrationRegistry;
  let registeredTargets: TargetRecord[];
  try {
    registry = IntegrationRegistry.fromEnv(ctx.env);
    registeredTargets = registry.targets();
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  // Determine the set of targets to remove.
  let targetsToRemove: TargetRecord[];

  if (explicitTarget) {
    const tool = explicitTarget.tool;
    if (!isToolName(tool)) {
      return failure(unsupportedTool(tool));
    }
    const found = registeredTargets.find(
      (t) => t.tool === tool && t.root === explicitTarget!.root,
    );
    targetsToRemove = found ? [found] : [];
  } else if (toolArg !== undefined) {
    if (!isToolName(toolArg)) {
      return failure(unsupportedTool(toolArg));
    }
    targetsToRemove = registeredTargets.filter((t) => t.tool === toolArg);
  } else {
    targetsToRemove = registeredTargets;
  }

  if (targetsToRemove.length === 0) {
    return success("Nothing to remove.\n");
  }

  const plan = targetsToRemove.map(planForTarget).join("\n");

  if (!apply) {
    return success(`${plan}\nRe-run with --yes to apply.\n`);
  }

  try {
    for (const target of targetsToRemove) applyRemovalForTarget(target);
    registry.removeMany(targetsToRemove);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  const roots = targetsToRemove.map((t) => t.root).join(", ");
  return success(`${plan}\nRemoved Trace from ${roots}.\n`);
}
