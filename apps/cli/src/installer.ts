import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Kept as a diagnostic compatibility command. Plugin installation owns hook
// registration now, so this must not mutate Claude settings.

export function runInit(
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  const skillPath = resolveTraceSkillPath(cwd);
  const codexSkillResult = installCodexSkill(env);
  const lines = [
    "trace is now installed through the Claude Code plugin.",
    "setup: /plugin marketplace add arielbk/trace-v2",
    "setup: /plugin install trace@trace-v2",
    existsSync(skillPath)
      ? `trace skill: found at ${skillPath}`
      : `trace skill: missing at ${skillPath}`,
    codexSkillResult,
    "SessionStart registration is declared by hooks/hooks.json in the plugin.",
  ];

  return `${lines.join("\n")}\n`;
}

function installCodexSkill(env: Record<string, string | undefined>): string {
  if (!env.HOME) {
    return "Codex trace skill: skipped because HOME is not set";
  }

  const targetPath = join(env.HOME, ".agents", "skills", "trace", "SKILL.md");
  const pluginRoot = resolvePluginRoot();
  const sourcePath = join(pluginRoot, "codex", "skills", "trace", "SKILL.md");
  const bundledTraceBin = join(pluginRoot, "bin", "trace.js");
  const source = readFileSync(sourcePath, "utf8");
  const rendered = source
    .replaceAll(
      'node "<trace-plugin-root>/bin/trace.js"',
      `node "${bundledTraceBin}"`,
    )
    .replaceAll("<trace-plugin-root>", pluginRoot);

  if (existsSync(targetPath) && readFileSync(targetPath, "utf8") === rendered) {
    return `Codex trace skill: already present at ${targetPath}`;
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, rendered);
  return `Codex trace skill: installed at ${targetPath}`;
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
      return join(resolvePluginRoot(), "skills", "trace", "SKILL.md");
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
    if (existsSync(join(candidate, "codex", "skills", "trace", "SKILL.md"))) {
      return candidate;
    }
  }

  return sourceRoot;
}
