import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Kept as a diagnostic compatibility command. Plugin installation owns hook
// registration and skill delivery now, so this must not mutate Claude settings,
// and it does not copy any skill: the marketplace install ships the full skills
// tree (including the trace skill's host resources) to both Claude and Codex.

export function runInit(
  _env: Record<string, string | undefined>,
  cwd: string,
): string {
  const skillPath = resolveTraceSkillPath(cwd);
  const lines = [
    "trace is now installed through the Claude Code plugin.",
    "setup: /plugin marketplace add arielbk/trace",
    "setup: /plugin install trace@trace",
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
      join(current, "plugin", "skills", "trace", "SKILL.md"),
      join(current, "skills", "trace", "SKILL.md"),
      join(current, ".claude", "skills", "trace", "SKILL.md"),
    ]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return join(resolvePluginRoot(), "plugin", "skills", "trace", "SKILL.md");
    }

    current = parent;
  }
}

function resolvePluginRoot(): string {
  const sourceRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const bundleDir = (globalThis as { __TRACE_BUNDLE_DIR__?: string })
    .__TRACE_BUNDLE_DIR__;

  const candidates = [
    sourceRoot,
    ...(bundleDir
      ? [join(bundleDir, ".."), join(bundleDir, "..", "..", "..")]
      : []),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "plugin", "skills", "trace", "SKILL.md"))) {
      return candidate;
    }
  }

  return sourceRoot;
}
