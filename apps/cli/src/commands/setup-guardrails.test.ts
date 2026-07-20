import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  applyClaudeSetup,
  applyCodexSetup,
  checkClaudeGuardrails,
  checkCodexGuardrails,
  checkCursorGuardrails,
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

function baseOptions(
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

// ─── Owned upgrade ────────────────────────────────────────────────────────────

test("re-running with a new version updates the registry record", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-upgrade-");
  const registryPath = join(dir, "registry.json");
  try {
    applyClaudeSetup(baseOptions(dir, registryPath));

    const optionsV2 = { ...baseOptions(dir, registryPath), version: "10.0.0" };
    applyClaudeSetup(optionsV2);

    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(registry.targets[0]?.version).toBe("10.0.0");
  } finally {
    cleanup();
  }
});

// ─── Malformed and unrelated settings ────────────────────────────────────────

test("checkClaudeGuardrails rejects malformed settings.json", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-malformed-");
  try {
    writeFileSync(join(dir, "settings.json"), "{ not valid json");

    const result = checkClaudeGuardrails(baseOptions(dir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("malformed");
    }
  } finally {
    cleanup();
  }
});

test("applyClaudeSetup throws on malformed settings.json", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-malformed-apply-");
  try {
    writeFileSync(join(dir, "settings.json"), "{ not valid json");
    expect(() => applyClaudeSetup(baseOptions(dir))).toThrow(/malformed/i);
  } finally {
    cleanup();
  }
});

test("malformed settings.json bytes are preserved on failure", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-bytes-");
  const settingsPath = join(dir, "settings.json");
  const original = "{ not valid json [";
  try {
    writeFileSync(settingsPath, original);
    try { applyClaudeSetup(baseOptions(dir)); } catch { /* expected guardrail throw */ }
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
  } finally {
    cleanup();
  }
});

test("unrelated settings keys survive after applyClaudeSetup", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-unrelated-");
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ model: "claude-3", env: { FOO: "bar" } }),
    );

    applyClaudeSetup(baseOptions(dir));

    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(settings.model).toBe("claude-3");
    expect(settings.env?.FOO).toBe("bar");
  } finally {
    cleanup();
  }
});

// ─── Unowned skill collision ──────────────────────────────────────────────────

test("checkClaudeGuardrails rejects an unowned skill directory", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-skill-coll-");
  try {
    mkdirSync(join(dir, "skills", "board"), { recursive: true });
    writeFileSync(join(dir, "skills", "board", "README.md"), "user content");

    const result = checkClaudeGuardrails(baseOptions(dir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("board");
      expect(result.error.toLowerCase()).toContain("remediation");
    }
  } finally {
    cleanup();
  }
});

test("checkClaudeGuardrails allows an owned skill directory", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-skill-owned-");
  const registryPath = join(dir, "registry.json");
  try {
    // Install first to establish ownership
    applyClaudeSetup(baseOptions(dir, registryPath));

    const result = checkClaudeGuardrails(baseOptions(dir, registryPath));
    expect(result.ok).toBe(true);
  } finally {
    cleanup();
  }
});

test("applyClaudeSetup throws on an unowned skill directory and preserves original content", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-skill-throw-");
  try {
    const skillDir = join(dir, "skills", "board");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "user content");

    expect(() => applyClaudeSetup(baseOptions(dir))).toThrow(/board/);

    // Original content preserved
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe("user content");
  } finally {
    cleanup();
  }
});

test("checkCodexGuardrails rejects an unowned skill directory", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-codex-coll-");
  try {
    mkdirSync(join(dir, "skills", "trace"), { recursive: true });
    writeFileSync(join(dir, "skills", "trace", "SKILL.md"), "user content");

    const result = checkCodexGuardrails(baseOptions(dir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("trace");
    }
  } finally {
    cleanup();
  }
});

test("checkCodexGuardrails allows owned skill directories", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-codex-owned-");
  const registryPath = join(dir, "registry.json");
  try {
    applyCodexSetup(baseOptions(dir, registryPath));
    const result = checkCodexGuardrails(baseOptions(dir, registryPath));
    expect(result.ok).toBe(true);
  } finally {
    cleanup();
  }
});

test("checkCursorGuardrails rejects an unowned skill directory", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-cursor-coll-");
  try {
    mkdirSync(join(dir, "skills", "recall"), { recursive: true });
    writeFileSync(join(dir, "skills", "recall", "SKILL.md"), "user content");

    const result = checkCursorGuardrails(baseOptions(dir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("recall");
    }
  } finally {
    cleanup();
  }
});

// ─── Unowned hook collision ───────────────────────────────────────────────────

test("checkClaudeGuardrails rejects an unowned hook event in settings.json", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-hook-coll-");
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "my-tool start" }] }] },
      }),
    );

    const result = checkClaudeGuardrails(baseOptions(dir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("SessionStart");
      expect(result.error.toLowerCase()).toContain("remediation");
    }
  } finally {
    cleanup();
  }
});

test("checkClaudeGuardrails allows a hook event owned by a prior Trace install", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-hook-owned-");
  const registryPath = join(dir, "registry.json");
  try {
    applyClaudeSetup(baseOptions(dir, registryPath));
    const result = checkClaudeGuardrails(baseOptions(dir, registryPath));
    expect(result.ok).toBe(true);
  } finally {
    cleanup();
  }
});

test("unowned hook event bytes are preserved on guardrail failure", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-hook-bytes-");
  const settingsPath = join(dir, "settings.json");
  const original = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "custom-stop" }] }] },
  });
  try {
    writeFileSync(settingsPath, original);
    try { applyClaudeSetup(baseOptions(dir)); } catch { /* expected guardrail throw */ }
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
  } finally {
    cleanup();
  }
});

test("non-Trace hook events are preserved alongside Trace hook events after install", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-hook-unrelated-");
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "custom" }] }] },
      }),
    );

    applyClaudeSetup(baseOptions(dir));

    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "custom" }] },
    ]);
    // Trace events are also present
    expect(settings.hooks.SessionStart).toBeDefined();
  } finally {
    cleanup();
  }
});

// ─── Legacy plugin detection ──────────────────────────────────────────────────

test("checkClaudeGuardrails rejects a legacy @arielbk/trace plugin", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-legacy-plugin-");
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ plugins: ["@arielbk/trace"] }),
    );

    const result = checkClaudeGuardrails(baseOptions(dir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("@arielbk/trace");
      expect(result.error.toLowerCase()).toContain("remediation");
    }
  } finally {
    cleanup();
  }
});

test("checkClaudeGuardrails rejects a legacy plugin even with path prefix", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-legacy-plugin2-");
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ plugins: ["/home/user/.npm/@arielbk/trace"] }),
    );

    const result = checkClaudeGuardrails(baseOptions(dir));
    expect(result.ok).toBe(false);
  } finally {
    cleanup();
  }
});

test("legacy plugin bytes are preserved on guardrail failure", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-legacy-bytes-");
  const settingsPath = join(dir, "settings.json");
  const original = JSON.stringify({ plugins: ["@arielbk/trace"] });
  try {
    writeFileSync(settingsPath, original);
    try { applyClaudeSetup(baseOptions(dir)); } catch { /* expected guardrail throw */ }
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
  } finally {
    cleanup();
  }
});

// ─── Pinned npx hook detection ────────────────────────────────────────────────

test("checkClaudeGuardrails rejects a pinned npx @arielbk/trace hook", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-npx-");
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "npx @arielbk/trace hook session-start" }] },
          ],
        },
      }),
    );

    const result = checkClaudeGuardrails(baseOptions(dir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("npx");
      expect(result.error.toLowerCase()).toContain("remediation");
    }
  } finally {
    cleanup();
  }
});

test("checkClaudeGuardrails rejects a pinned npx trace hook", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-npx2-");
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "npx trace hook stop" }] }],
        },
      }),
    );

    const result = checkClaudeGuardrails(baseOptions(dir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("npx");
    }
  } finally {
    cleanup();
  }
});

test("pinned npx hook bytes are preserved on guardrail failure", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-npx-bytes-");
  const settingsPath = join(dir, "settings.json");
  const original = JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "npx @arielbk/trace hook session-start" }] },
      ],
    },
  });
  try {
    writeFileSync(settingsPath, original);
    try { applyClaudeSetup(baseOptions(dir)); } catch { /* expected guardrail throw */ }
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
  } finally {
    cleanup();
  }
});

// ─── Atomic writes ────────────────────────────────────────────────────────────

test("atomic writes leave no temp files in the config root after install", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-atomic-");
  try {
    applyClaudeSetup(baseOptions(dir));

    const findTmpFiles = (d: string): string[] => {
      const results: string[] = [];
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) results.push(...findTmpFiles(full));
        else if (entry.name.includes(".trace-tmp-")) results.push(full);
      }
      return results;
    };

    expect(findTmpFiles(dir)).toHaveLength(0);
  } finally {
    cleanup();
  }
});

// ─── setupOperation integration ───────────────────────────────────────────────

test("setupOperation --yes returns failure with remediation on unowned skill collision", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-op-skill-");
  try {
    mkdirSync(join(dir, ".claude", "skills", "board"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "board", "SKILL.md"), "user content");

    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = setupOperation(["--tool", "claude", "--yes"], {
      env,
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("board");
    expect(result.stderr.toLowerCase()).toContain("remediation");
    // Original file unchanged
    expect(readFileSync(join(dir, ".claude", "skills", "board", "SKILL.md"), "utf8")).toBe("user content");
  } finally {
    cleanup();
  }
});

test("setupOperation --yes returns failure with remediation on legacy plugin", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-op-plugin-");
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ plugins: ["@arielbk/trace"] }),
    );

    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = setupOperation(["--tool", "claude", "--yes"], {
      env,
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("@arielbk/trace");
    // settings.json untouched
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    expect(settings.plugins).toContain("@arielbk/trace");
  } finally {
    cleanup();
  }
});

test("setupOperation --yes returns failure with remediation on pinned npx hook", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-op-npx-");
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "npx @arielbk/trace hook session-start" }] },
          ],
        },
      }),
    );

    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = setupOperation(["--tool", "claude", "--yes"], {
      env,
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("npx");
  } finally {
    cleanup();
  }
});

test("setupOperation preview does not run guardrails checks", () => {
  const { dir, cleanup } = tempDir("trace-guardrails-preview-");
  try {
    mkdirSync(join(dir, ".claude", "skills", "board"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "board", "SKILL.md"), "user content");

    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = setupOperation(["--tool", "claude"], {
      env,
      cwd: dir,
      stdin: "",
    });

    // Preview succeeds even with collision present
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--yes");
  } finally {
    cleanup();
  }
});

test("TRACE_CLAUDE_SKILLS covers all expected skill names", () => {
  expect(TRACE_CLAUDE_SKILLS).toContain("board");
  expect(TRACE_CLAUDE_SKILLS).toContain("trace");
  expect(TRACE_CODEX_SKILLS).toContain("board");
  expect(TRACE_CURSOR_SKILLS).toContain("board");
});
