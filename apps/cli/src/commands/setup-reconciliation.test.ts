import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { setupOperation } from "./setup-operations.ts";

const CLI_PATH = "/opt/global/bin/trace";

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("ordinary Codex setup reconciles every registered root", () => {
  const { dir, cleanup } = tempDir("trace-reconcile-codex-");
  try {
    const rootA = join(dir, "codex-a");
    const rootB = join(dir, "codex-b");
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const ctx = { env, cwd: dir, stdin: "" };

    expect(
      setupOperation(["--target", `codex=${rootA}`, "--yes"], ctx).exitCode,
    ).toBe(0);
    expect(
      setupOperation(["--target", `codex=${rootB}`, "--yes"], ctx).exitCode,
    ).toBe(0);

    const secondRootSkill = join(rootB, "skills", "board", "SKILL.md");
    rmSync(secondRootSkill);

    const result = setupOperation(["--tool", "codex", "--yes"], {
      env: { ...env, CODEX_HOME: rootA },
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(secondRootSkill)).toBe(true);
  } finally {
    cleanup();
  }
});

test("reconciliation preflights every target before mutating any target", () => {
  const { dir, cleanup } = tempDir("trace-reconcile-preflight-");
  try {
    const rootA = join(dir, "claude-a");
    const rootB = join(dir, "claude-b");
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const ctx = { env, cwd: dir, stdin: "" };

    expect(
      setupOperation(["--target", `claude=${rootA}`, "--yes"], ctx).exitCode,
    ).toBe(0);
    expect(
      setupOperation(["--target", `claude=${rootB}`, "--yes"], ctx).exitCode,
    ).toBe(0);

    const firstRootSkill = join(rootA, "skills", "board", "SKILL.md");
    rmSync(firstRootSkill);

    const secondRootSettings = join(rootB, "settings.json");
    const settings = JSON.parse(readFileSync(secondRootSettings, "utf8"));
    settings.plugins = ["@arielbk/trace"];
    writeFileSync(secondRootSettings, `${JSON.stringify(settings, null, 2)}\n`);

    const result = setupOperation(["--tool", "claude", "--yes"], {
      env: { ...env, CLAUDE_CONFIG_DIR: rootA },
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("@arielbk/trace");
    expect(existsSync(firstRootSkill)).toBe(false);
  } finally {
    cleanup();
  }
});

test("reconciliation removes obsolete files from Trace-owned skills", () => {
  const { dir, cleanup } = tempDir("trace-reconcile-obsolete-");
  try {
    const codexRoot = join(dir, ".codex");
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const ctx = { env, cwd: dir, stdin: "" };

    expect(setupOperation(["--tool", "codex", "--yes"], ctx).exitCode).toBe(0);

    const obsoletePackagedFile = join(
      codexRoot,
      "skills",
      "trace",
      "resources",
      "obsolete.md",
    );
    writeFileSync(obsoletePackagedFile, "content from a previous package version\n");

    const result = setupOperation(["--tool", "codex", "--yes"], ctx);

    expect(result.exitCode).toBe(0);
    expect(existsSync(obsoletePackagedFile)).toBe(false);
  } finally {
    cleanup();
  }
});

test("setup --registered reconciles every target in the registry", () => {
  const { dir, cleanup } = tempDir("trace-reconcile-registered-");
  try {
    const claudeRoot = join(dir, "claude");
    const codexRoot = join(dir, "codex");
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const ctx = { env, cwd: dir, stdin: "" };

    expect(
      setupOperation(["--target", `claude=${claudeRoot}`, "--yes"], ctx)
        .exitCode,
    ).toBe(0);
    expect(
      setupOperation(["--target", `codex=${codexRoot}`, "--yes"], ctx)
        .exitCode,
    ).toBe(0);

    const claudeSkill = join(claudeRoot, "skills", "board", "SKILL.md");
    const codexSkill = join(codexRoot, "skills", "board", "SKILL.md");
    rmSync(claudeSkill);
    rmSync(codexSkill);

    const result = setupOperation(["--registered", "--yes"], ctx);

    expect(result.exitCode).toBe(0);
    expect(existsSync(claudeSkill)).toBe(true);
    expect(existsSync(codexSkill)).toBe(true);
  } finally {
    cleanup();
  }
});
