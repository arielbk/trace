import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  applyClaudeRemoval,
  applyCodexRemoval,
  applyCursorRemoval,
  applyClaudeSetup,
  applyCodexSetup,
  applyCursorSetup,
  planClaudeRemoval,
  planCodexRemoval,
  planCursorRemoval,
  resolvePackagedSkillsDir,
  setupOperation,
  TRACE_CLAUDE_SKILLS,
  TRACE_CODEX_SKILLS,
  TRACE_CURSOR_SKILLS,
} from "./setup-operations.ts";

const CLI_PATH = "/opt/global/bin/trace";
const VERSION = "9.9.9";

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function baseSetupOptions(
  configRoot: string,
  registryPath = join(configRoot, "registry.json"),
) {
  return {
    configRoot,
    registryPath,
    skillsSourceDir: resolvePackagedSkillsDir(),
    cliPath: CLI_PATH,
    version: VERSION,
    packageManager: "npm" as const,
  };
}

function baseRemovalOptions(
  configRoot: string,
  registryPath = join(configRoot, "registry.json"),
) {
  return { configRoot, registryPath };
}

function readRegistry(registryPath: string) {
  return JSON.parse(readFileSync(registryPath, "utf8"));
}

// ─── Claude removal ────────────────────────────────────────────────────────────

test("applyClaudeRemoval removes owned skills from the config root", () => {
  const { dir, cleanup } = tempDir("trace-remove-claude-skills-");
  try {
    const opts = baseSetupOptions(dir);
    applyClaudeSetup(opts);

    for (const skill of TRACE_CLAUDE_SKILLS) {
      expect(existsSync(join(dir, "skills", skill))).toBe(true);
    }

    applyClaudeRemoval(baseRemovalOptions(dir, opts.registryPath));

    for (const skill of TRACE_CLAUDE_SKILLS) {
      expect(existsSync(join(dir, "skills", skill))).toBe(false);
    }
  } finally {
    cleanup();
  }
});

test("applyClaudeRemoval removes owned hooks from settings.json leaving unrelated entries", () => {
  const { dir, cleanup } = tempDir("trace-remove-claude-hooks-");
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        theme: "dark",
        hooks: { UserPromptSubmit: [{ hooks: [] }] },
      }),
    );

    const opts = baseSetupOptions(dir);
    applyClaudeSetup(opts);

    const settingsBefore = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(settingsBefore.hooks.SessionStart).toBeDefined();
    expect(settingsBefore.hooks.Stop).toBeDefined();
    expect(settingsBefore.hooks.SubagentStop).toBeDefined();

    applyClaudeRemoval(baseRemovalOptions(dir, opts.registryPath));

    const settingsAfter = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(settingsAfter.theme).toBe("dark");
    expect(settingsAfter.hooks.UserPromptSubmit).toEqual([{ hooks: [] }]);
    expect(settingsAfter.hooks.SessionStart).toBeUndefined();
    expect(settingsAfter.hooks.Stop).toBeUndefined();
    expect(settingsAfter.hooks.SubagentStop).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("applyClaudeRemoval removes the target record from the registry", () => {
  const { dir, cleanup } = tempDir("trace-remove-claude-registry-");
  const registryPath = join(dir, "registry.json");
  try {
    applyClaudeSetup(baseSetupOptions(dir, registryPath));
    expect(readRegistry(registryPath).targets).toHaveLength(1);

    applyClaudeRemoval(baseRemovalOptions(dir, registryPath));

    const registry = readRegistry(registryPath);
    expect(registry.targets).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("applyClaudeRemoval is idempotent — second removal is a no-op", () => {
  const { dir, cleanup } = tempDir("trace-remove-claude-idempotent-");
  const registryPath = join(dir, "registry.json");
  try {
    applyClaudeSetup(baseSetupOptions(dir, registryPath));
    applyClaudeRemoval(baseRemovalOptions(dir, registryPath));

    // Second removal should not throw and should stay clean.
    expect(() => applyClaudeRemoval(baseRemovalOptions(dir, registryPath))).not.toThrow();
    const registry = readRegistry(registryPath);
    expect(registry.targets).toHaveLength(0);
    for (const skill of TRACE_CLAUDE_SKILLS) {
      expect(existsSync(join(dir, "skills", skill))).toBe(false);
    }
  } finally {
    cleanup();
  }
});

// ─── Codex removal ─────────────────────────────────────────────────────────────

test("applyCodexRemoval removes owned skills and registry entry, leaves unrelated dirs", () => {
  const { dir, cleanup } = tempDir("trace-remove-codex-");
  const registryPath = join(dir, "registry.json");
  try {
    // Create an unrelated directory the user owns.
    mkdirSync(join(dir, "skills", "my-custom-skill"), { recursive: true });
    writeFileSync(join(dir, "skills", "my-custom-skill", "README.md"), "user skill");

    applyCodexSetup(baseSetupOptions(dir, registryPath));

    for (const skill of TRACE_CODEX_SKILLS) {
      expect(existsSync(join(dir, "skills", skill))).toBe(true);
    }

    applyCodexRemoval(baseRemovalOptions(dir, registryPath));

    for (const skill of TRACE_CODEX_SKILLS) {
      expect(existsSync(join(dir, "skills", skill))).toBe(false);
    }
    // User's unrelated skill survives.
    expect(existsSync(join(dir, "skills", "my-custom-skill", "README.md"))).toBe(true);

    const registry = readRegistry(registryPath);
    expect(registry.targets).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("applyCodexRemoval is idempotent", () => {
  const { dir, cleanup } = tempDir("trace-remove-codex-idempotent-");
  const registryPath = join(dir, "registry.json");
  try {
    applyCodexSetup(baseSetupOptions(dir, registryPath));
    applyCodexRemoval(baseRemovalOptions(dir, registryPath));

    expect(() => applyCodexRemoval(baseRemovalOptions(dir, registryPath))).not.toThrow();
    expect(readRegistry(registryPath).targets).toHaveLength(0);
  } finally {
    cleanup();
  }
});

// ─── Cursor removal ────────────────────────────────────────────────────────────

test("applyCursorRemoval removes owned skills and registry entry", () => {
  const { dir, cleanup } = tempDir("trace-remove-cursor-");
  const registryPath = join(dir, "registry.json");
  try {
    applyCursorSetup(baseSetupOptions(dir, registryPath));

    for (const skill of TRACE_CURSOR_SKILLS) {
      expect(existsSync(join(dir, "skills", skill))).toBe(true);
    }

    applyCursorRemoval(baseRemovalOptions(dir, registryPath));

    for (const skill of TRACE_CURSOR_SKILLS) {
      expect(existsSync(join(dir, "skills", skill))).toBe(false);
    }
    expect(readRegistry(registryPath).targets).toHaveLength(0);
  } finally {
    cleanup();
  }
});

// ─── Plan (preview) ────────────────────────────────────────────────────────────

test("planClaudeRemoval describes skills and hooks to be removed", () => {
  const target = {
    tool: "claude" as const,
    root: "/home/user/.claude",
    cliPath: CLI_PATH,
    version: VERSION,
    skills: [...TRACE_CLAUDE_SKILLS],
    hooks: ["SessionStart", "SubagentStop", "Stop"],
  };
  const plan = planClaudeRemoval(target);
  expect(plan).toContain("Claude Code");
  expect(plan).toContain("/home/user/.claude");
  for (const skill of TRACE_CLAUDE_SKILLS) {
    expect(plan).toContain(skill);
  }
  expect(plan).toContain("SessionStart");
});

test("planCodexRemoval describes skills to be removed", () => {
  const target = {
    tool: "codex" as const,
    root: "/home/user/.codex",
    cliPath: CLI_PATH,
    version: VERSION,
    skills: [...TRACE_CODEX_SKILLS],
    hooks: [] as string[],
  };
  const plan = planCodexRemoval(target);
  expect(plan).toContain("Codex");
  expect(plan).toContain("/home/user/.codex");
  for (const skill of TRACE_CODEX_SKILLS) {
    expect(plan).toContain(skill);
  }
});

test("planCursorRemoval describes skills to be removed", () => {
  const target = {
    tool: "cursor" as const,
    root: "/home/user/.cursor",
    cliPath: CLI_PATH,
    version: VERSION,
    skills: [...TRACE_CURSOR_SKILLS],
    hooks: [] as string[],
  };
  const plan = planCursorRemoval(target);
  expect(plan).toContain("Cursor");
  expect(plan).toContain("/home/user/.cursor");
});

// ─── setupOperation --remove ────────────────────────────────────────────────────

test("setup --remove --tool claude: preview without --yes shows plan but makes no changes", () => {
  const { dir, cleanup } = tempDir("trace-remove-op-preview-");
  try {
    const homeDir = join(dir, "home");
    mkdirSync(homeDir, { recursive: true });
    const claudeRoot = join(homeDir, ".claude");
    const env = { HOME: homeDir, TRACE_CLI_PATH: CLI_PATH };

    setupOperation(["--tool", "claude", "--yes"], { env, cwd: homeDir, stdin: "" });
    expect(existsSync(join(claudeRoot, "skills", "trace", "SKILL.md"))).toBe(true);

    const result = setupOperation(["--remove", "--tool", "claude"], { env, cwd: homeDir, stdin: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Claude Code");
    expect(result.stdout).toContain("--yes");
    // No files removed in preview mode.
    expect(existsSync(join(claudeRoot, "skills", "trace", "SKILL.md"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("setup --remove --tool claude --yes removes Claude integration", () => {
  const { dir, cleanup } = tempDir("trace-remove-op-claude-");
  try {
    const homeDir = join(dir, "home");
    mkdirSync(homeDir, { recursive: true });
    const claudeRoot = join(homeDir, ".claude");
    const env = { HOME: homeDir, TRACE_CLI_PATH: CLI_PATH };

    setupOperation(["--tool", "claude", "--yes"], { env, cwd: homeDir, stdin: "" });
    expect(existsSync(join(claudeRoot, "skills", "trace", "SKILL.md"))).toBe(true);

    const result = setupOperation(["--remove", "--tool", "claude", "--yes"], { env, cwd: homeDir, stdin: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Removed");

    for (const skill of TRACE_CLAUDE_SKILLS) {
      expect(existsSync(join(claudeRoot, "skills", skill))).toBe(false);
    }
    const registry = JSON.parse(
      readFileSync(join(homeDir, ".trace", "integrations.json"), "utf8"),
    );
    expect(registry.targets).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("setup --remove --target claude=/path --yes removes the explicit target only", () => {
  const { dir, cleanup } = tempDir("trace-remove-op-target-");
  try {
    const homeDir = join(dir, "home");
    mkdirSync(homeDir, { recursive: true });
    const customRoot = join(dir, "custom-claude");
    const env = { HOME: homeDir, TRACE_CLI_PATH: CLI_PATH };

    // Install into a custom root.
    setupOperation(
      ["--target", `claude=${customRoot}`, "--yes"],
      { env, cwd: homeDir, stdin: "" },
    );
    expect(existsSync(join(customRoot, "skills", "trace", "SKILL.md"))).toBe(true);

    const result = setupOperation(
      ["--remove", "--target", `claude=${customRoot}`, "--yes"],
      { env, cwd: homeDir, stdin: "" },
    );

    expect(result.exitCode).toBe(0);
    for (const skill of TRACE_CLAUDE_SKILLS) {
      expect(existsSync(join(customRoot, "skills", skill))).toBe(false);
    }
    const registry = JSON.parse(
      readFileSync(join(homeDir, ".trace", "integrations.json"), "utf8"),
    );
    expect(registry.targets).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("setup --remove --yes without --tool removes all registered targets", () => {
  const { dir, cleanup } = tempDir("trace-remove-op-all-");
  try {
    const homeDir = join(dir, "home");
    mkdirSync(homeDir, { recursive: true });
    const claudeRoot = join(homeDir, ".claude");
    const codexRoot = join(homeDir, ".codex");
    const env = { HOME: homeDir, TRACE_CLI_PATH: CLI_PATH };

    // Install Claude and Codex targets.
    setupOperation(["--tool", "claude", "--yes"], { env, cwd: homeDir, stdin: "" });
    mkdirSync(codexRoot, { recursive: true }); // make it detectable for setup
    setupOperation(["--tool", "codex", "--yes"], { env, cwd: homeDir, stdin: "" });

    const registryBefore = JSON.parse(
      readFileSync(join(homeDir, ".trace", "integrations.json"), "utf8"),
    );
    expect(registryBefore.targets).toHaveLength(2);

    const result = setupOperation(["--remove", "--yes"], { env, cwd: homeDir, stdin: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Removed");

    const registryAfter = JSON.parse(
      readFileSync(join(homeDir, ".trace", "integrations.json"), "utf8"),
    );
    expect(registryAfter.targets).toHaveLength(0);

    for (const skill of TRACE_CLAUDE_SKILLS) {
      expect(existsSync(join(claudeRoot, "skills", skill))).toBe(false);
    }
    for (const skill of TRACE_CODEX_SKILLS) {
      expect(existsSync(join(codexRoot, "skills", skill))).toBe(false);
    }
  } finally {
    cleanup();
  }
});

test("setup --remove --yes with no registered targets is a successful no-op", () => {
  const { dir, cleanup } = tempDir("trace-remove-op-empty-");
  try {
    const homeDir = join(dir, "home");
    mkdirSync(homeDir, { recursive: true });
    const env = { HOME: homeDir, TRACE_CLI_PATH: CLI_PATH };

    const result = setupOperation(["--remove", "--yes"], { env, cwd: homeDir, stdin: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Nothing to remove");
  } finally {
    cleanup();
  }
});

test("setup --remove preserves unrelated settings.json keys and hooks", () => {
  const { dir, cleanup } = tempDir("trace-remove-unrelated-");
  try {
    const homeDir = join(dir, "home");
    mkdirSync(homeDir, { recursive: true });
    const claudeRoot = join(homeDir, ".claude");
    const env = { HOME: homeDir, TRACE_CLI_PATH: CLI_PATH };

    mkdirSync(claudeRoot, { recursive: true });
    writeFileSync(
      join(claudeRoot, "settings.json"),
      JSON.stringify({
        theme: "dark",
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "my-tool" }] }] },
      }),
    );

    setupOperation(["--tool", "claude", "--yes"], { env, cwd: homeDir, stdin: "" });
    setupOperation(["--remove", "--tool", "claude", "--yes"], { env, cwd: homeDir, stdin: "" });

    const settings = JSON.parse(readFileSync(join(claudeRoot, "settings.json"), "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.SessionStart).toBeUndefined();
    expect(settings.hooks.Stop).toBeUndefined();
    expect(settings.hooks.SubagentStop).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("setup --remove does not remove one target when removing a different tool", () => {
  const { dir, cleanup } = tempDir("trace-remove-partial-");
  try {
    const homeDir = join(dir, "home");
    mkdirSync(homeDir, { recursive: true });
    const claudeRoot = join(homeDir, ".claude");
    const codexRoot = join(homeDir, ".codex");
    const env = { HOME: homeDir, TRACE_CLI_PATH: CLI_PATH };

    setupOperation(["--tool", "claude", "--yes"], { env, cwd: homeDir, stdin: "" });
    mkdirSync(codexRoot, { recursive: true });
    setupOperation(["--tool", "codex", "--yes"], { env, cwd: homeDir, stdin: "" });

    const result = setupOperation(["--remove", "--tool", "codex", "--yes"], { env, cwd: homeDir, stdin: "" });
    expect(result.exitCode).toBe(0);

    // Codex gone.
    for (const skill of TRACE_CODEX_SKILLS) {
      expect(existsSync(join(codexRoot, "skills", skill))).toBe(false);
    }
    // Claude untouched.
    expect(existsSync(join(claudeRoot, "skills", "trace", "SKILL.md"))).toBe(true);

    const registry = JSON.parse(
      readFileSync(join(homeDir, ".trace", "integrations.json"), "utf8"),
    );
    expect(registry.targets).toHaveLength(1);
    expect(registry.targets[0].tool).toBe("claude");
  } finally {
    cleanup();
  }
});
