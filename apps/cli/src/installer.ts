import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Owns the `trace init` contract: wiring the Claude Code SessionStart hook into
// the user's settings.json (idempotently) and reporting where the trace skill
// lives. Kept out of the CLI dispatcher so the dispatcher only routes commands
// and this module owns all install-time filesystem knowledge.

type ClaudeSettings = {
  hooks?: Record<
    string,
    Array<{ hooks?: Array<{ type?: string; command?: string }> }>
  >;
};

export function runInit(
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  const settingsPath = resolveClaudeSettingsPath(env);
  const hookCommand = `${process.execPath} ${resolveClaudeHookPath()}`;
  const settings = readClaudeSettings(settingsPath);
  const sessionStart = settings.hooks?.SessionStart ?? [];
  const hasHook = sessionStart.some((entry) =>
    entry.hooks?.some(
      (hook) => hook.type === "command" && hook.command === hookCommand,
    ),
  );

  if (!hasHook) {
    sessionStart.push({ hooks: [{ type: "command", command: hookCommand }] });
    settings.hooks = { ...settings.hooks, SessionStart: sessionStart };
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  const skillPath = resolveTraceSkillPath(cwd);
  const lines = [
    hasHook
      ? `Claude SessionStart hook already registered: ${settingsPath}`
      : `registered Claude SessionStart hook: ${settingsPath}`,
    existsSync(skillPath)
      ? `trace skill: found at ${skillPath}`
      : `trace skill: missing at ${skillPath}`,
    "manual: run pnpm link --global once before trace init so Claude can invoke trace later",
  ];

  return `${lines.join("\n")}\n`;
}

function resolveClaudeSettingsPath(
  env: Record<string, string | undefined>,
): string {
  if (env.CLAUDE_SETTINGS_PATH) {
    return env.CLAUDE_SETTINGS_PATH;
  }

  if (!env.HOME) {
    throw new Error("trace init requires HOME or CLAUDE_SETTINGS_PATH");
  }

  return join(env.HOME, ".claude", "settings.json");
}

function readClaudeSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) {
    return {};
  }

  return JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeSettings;
}

function resolveClaudeHookPath(): string {
  return fileURLToPath(
    new URL("./claude-session-start-hook.ts", import.meta.url),
  );
}

function resolveTraceSkillPath(cwd: string): string {
  let current = cwd;

  while (true) {
    const candidate = join(current, ".claude", "skills", "trace", "SKILL.md");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return fileURLToPath(
        new URL("../../../skills/trace/SKILL.md", import.meta.url),
      );
    }

    current = parent;
  }
}
