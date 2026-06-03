import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Kept as a diagnostic compatibility command. Plugin installation owns hook
// registration now, so this must not mutate Claude settings.

export function runInit(
  _env: Record<string, string | undefined>,
  cwd: string,
): string {
  const skillPath = resolveTraceSkillPath(cwd);
  const lines = [
    "trace is now installed through the Claude Code plugin.",
    "setup: /plugin marketplace add arielbk/trace-v2",
    "setup: /plugin install trace@trace-v2",
    existsSync(skillPath)
      ? `trace skill: found at ${skillPath}`
      : `trace skill: missing at ${skillPath}`,
    "SessionStart registration is declared by hooks/hooks.json in the plugin.",
  ];

  return `${lines.join("\n")}\n`;
}

function resolveTraceSkillPath(cwd: string): string {
  let current = cwd;

  while (true) {
    for (const candidate of [
      join(current, "skills", "trace", "SKILL.md"),
      join(current, ".claude", "skills", "trace", "SKILL.md"),
    ]) {
      if (existsSync(candidate)) {
        return candidate;
      }
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
