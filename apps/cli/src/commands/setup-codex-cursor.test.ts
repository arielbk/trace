import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "../trace.ts";
import {
  applyCodexSetup,
  applyCursorSetup,
  detectCodexInstall,
  detectCursorInstall,
  planCodexSetup,
  planCursorSetup,
  resolveCodexConfigRoot,
  resolveCursorConfigRoot,
  setupOperation,
  TRACE_CODEX_SKILLS,
  TRACE_CURSOR_SKILLS,
} from "./setup-operations.ts";
import { resolvePackagedSkillsDir } from "./setup-operations.ts";

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

function readTargets(homeDir: string): { tool: string; root: string }[] {
  return JSON.parse(
    readFileSync(join(homeDir, ".trace", "integrations.json"), "utf8"),
  ).targets;
}

// ─── Codex setup ──────────────────────────────────────────────────────────────

test("applyCodexSetup installs the packaged Trace skills into the Codex config root", () => {
  const { dir, cleanup } = tempDir("trace-setup-codex-");
  try {
    applyCodexSetup(baseOptions(dir));

    for (const skill of TRACE_CODEX_SKILLS) {
      expect(
        existsSync(join(dir, "skills", skill, "SKILL.md")),
        `expected skill ${skill}`,
      ).toBe(true);
    }
    expect(TRACE_CODEX_SKILLS.length).toBeGreaterThan(0);
  } finally {
    cleanup();
  }
});

test("applyCodexSetup records target with tool=codex, no hooks", () => {
  const { dir, cleanup } = tempDir("trace-setup-codex-");
  const registryPath = join(dir, "registry.json");
  try {
    applyCodexSetup(baseOptions(dir, registryPath));

    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(registry.targets).toHaveLength(1);
    const target = registry.targets[0];
    expect(target.tool).toBe("codex");
    expect(target.root).toBe(dir);
    expect(target.cliPath).toBe(CLI_PATH);
    expect(target.version).toBe(VERSION);
    expect([...target.skills].sort()).toEqual([...TRACE_CODEX_SKILLS].sort());
    expect(target.hooks).toEqual([]);
  } finally {
    cleanup();
  }
});

test("resolveCodexConfigRoot honors CODEX_HOME over the default ~/.codex", () => {
  expect(resolveCodexConfigRoot({ HOME: "/home/u" })).toBe("/home/u/.codex");
  expect(
    resolveCodexConfigRoot({ HOME: "/home/u", CODEX_HOME: "/custom/codex" }),
  ).toBe("/custom/codex");
});

test("setup --tool codex --yes installs into ~/.codex and records target", () => {
  const { dir, cleanup } = tempDir("trace-setup-codex-home-");
  try {
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = setupOperation(["--tool", "codex", "--yes"], {
      env,
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dir, ".codex", "skills", "trace", "SKILL.md"))).toBe(
      true,
    );
    const targets = readTargets(dir);
    expect(targets[0]?.tool).toBe("codex");
    expect(targets[0]?.root).toBe(join(dir, ".codex"));
  } finally {
    cleanup();
  }
});

test("setup --target codex=/path --yes installs into that explicit root", () => {
  const { dir, cleanup } = tempDir("trace-setup-codex-target-");
  try {
    const explicit = join(dir, "custom-codex");
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = setupOperation(["--target", `codex=${explicit}`, "--yes"], {
      env,
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(explicit, "skills", "trace", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".codex"))).toBe(false);
    const targets = readTargets(dir);
    expect(targets[0]?.root).toBe(explicit);
    expect(targets[0]?.tool).toBe("codex");
  } finally {
    cleanup();
  }
});

test("planCodexSetup lists skills, target root, and CLI path without hooks", () => {
  const { dir, cleanup } = tempDir("trace-setup-codex-plan-");
  try {
    const plan = planCodexSetup(baseOptions(dir));
    expect(plan).toContain(dir);
    expect(plan).toContain(CLI_PATH);
    for (const skill of TRACE_CODEX_SKILLS) expect(plan).toContain(skill);
    expect(plan).not.toContain("SessionStart");
  } finally {
    cleanup();
  }
});

// ─── Cursor setup ─────────────────────────────────────────────────────────────

test("applyCursorSetup installs the packaged Trace skills into the Cursor config root", () => {
  const { dir, cleanup } = tempDir("trace-setup-cursor-");
  try {
    applyCursorSetup(baseOptions(dir));

    for (const skill of TRACE_CURSOR_SKILLS) {
      expect(
        existsSync(join(dir, "skills", skill, "SKILL.md")),
        `expected skill ${skill}`,
      ).toBe(true);
    }
    expect(TRACE_CURSOR_SKILLS.length).toBeGreaterThan(0);
  } finally {
    cleanup();
  }
});

test("applyCursorSetup records target with tool=cursor, no hooks", () => {
  const { dir, cleanup } = tempDir("trace-setup-cursor-");
  const registryPath = join(dir, "registry.json");
  try {
    applyCursorSetup(baseOptions(dir, registryPath));

    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(registry.targets).toHaveLength(1);
    const target = registry.targets[0];
    expect(target.tool).toBe("cursor");
    expect(target.root).toBe(dir);
    expect(target.hooks).toEqual([]);
  } finally {
    cleanup();
  }
});

test("resolveCursorConfigRoot resolves to ~/.cursor", () => {
  expect(resolveCursorConfigRoot({ HOME: "/home/u" })).toBe("/home/u/.cursor");
});

test("setup --tool cursor --yes installs into ~/.cursor and records target", () => {
  const { dir, cleanup } = tempDir("trace-setup-cursor-home-");
  try {
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = setupOperation(["--tool", "cursor", "--yes"], {
      env,
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(
      existsSync(join(dir, ".cursor", "skills", "trace", "SKILL.md")),
    ).toBe(true);
    const targets = readTargets(dir);
    expect(targets[0]?.tool).toBe("cursor");
    expect(targets[0]?.root).toBe(join(dir, ".cursor"));
  } finally {
    cleanup();
  }
});

test("planCursorSetup lists skills, target root, and CLI path without hooks", () => {
  const { dir, cleanup } = tempDir("trace-setup-cursor-plan-");
  try {
    const plan = planCursorSetup(baseOptions(dir));
    expect(plan).toContain(dir);
    expect(plan).toContain(CLI_PATH);
    for (const skill of TRACE_CURSOR_SKILLS) expect(plan).toContain(skill);
    expect(plan).not.toContain("SessionStart");
  } finally {
    cleanup();
  }
});

// ─── Auto-detection ───────────────────────────────────────────────────────────

test("detectCodexInstall returns the codex root when ~/.codex exists", () => {
  const { dir, cleanup } = tempDir("trace-detect-codex-");
  try {
    expect(detectCodexInstall({ HOME: dir })).toBeUndefined();
    mkdirSync(join(dir, ".codex"));
    expect(detectCodexInstall({ HOME: dir })).toBe(join(dir, ".codex"));
  } finally {
    cleanup();
  }
});

test("detectCursorInstall returns the cursor root when ~/.cursor exists", () => {
  const { dir, cleanup } = tempDir("trace-detect-cursor-");
  try {
    expect(detectCursorInstall({ HOME: dir })).toBeUndefined();
    mkdirSync(join(dir, ".cursor"));
    expect(detectCursorInstall({ HOME: dir })).toBe(join(dir, ".cursor"));
  } finally {
    cleanup();
  }
});

test("setup with no --tool detects and installs all found hosts", () => {
  const { dir, cleanup } = tempDir("trace-setup-detect-");
  try {
    mkdirSync(join(dir, ".codex"));
    mkdirSync(join(dir, ".cursor"));
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = setupOperation(["--yes"], { env, cwd: dir, stdin: "" });

    expect(result.exitCode).toBe(0);
    expect(
      existsSync(join(dir, ".codex", "skills", "trace", "SKILL.md")),
    ).toBe(true);
    expect(
      existsSync(join(dir, ".cursor", "skills", "trace", "SKILL.md")),
    ).toBe(true);
    const targets = readTargets(dir);
    const tools = targets.map((t) => t.tool).sort();
    expect(tools).toContain("codex");
    expect(tools).toContain("cursor");
  } finally {
    cleanup();
  }
});

test("setup with no --tool and no detected hosts returns a helpful error", () => {
  const { dir, cleanup } = tempDir("trace-setup-nohost-");
  try {
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = setupOperation(["--yes"], { env, cwd: dir, stdin: "" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--tool");
  } finally {
    cleanup();
  }
});

// ─── Cross-tool: additive registry ────────────────────────────────────────────

test("codex and cursor registrations are additive alongside claude", () => {
  const { dir, cleanup } = tempDir("trace-setup-multi-");
  try {
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const ctx = { env, cwd: dir, stdin: "" };

    setupOperation(["--tool", "claude", "--yes"], ctx);
    setupOperation(["--tool", "codex", "--yes"], ctx);
    setupOperation(["--tool", "cursor", "--yes"], ctx);

    const targets = readTargets(dir);
    const tools = targets.map((t) => t.tool).sort();
    expect(tools).toEqual(["claude", "codex", "cursor"]);
  } finally {
    cleanup();
  }
});

test("setup --tool codex without --yes previews the plan and writes nothing", () => {
  const { dir, cleanup } = tempDir("trace-setup-codex-preview-");
  try {
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = setupOperation(["--tool", "codex"], {
      env,
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--yes");
    expect(result.stdout).toContain(join(dir, ".codex"));
    expect(existsSync(join(dir, ".codex"))).toBe(false);
    expect(existsSync(join(dir, ".trace", "integrations.json"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("trace setup dispatches --tool codex through the CLI", () => {
  const { dir, cleanup } = tempDir("trace-setup-codex-cli-");
  try {
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = runTraceCli(["setup", "--tool", "codex", "--yes"], env, dir, "");
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dir, ".codex", "skills", "board", "SKILL.md"))).toBe(
      true,
    );
  } finally {
    cleanup();
  }
});
