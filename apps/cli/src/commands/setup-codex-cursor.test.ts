import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { setupOperation } from "./setup-operations.ts";

const CLI_PATH = "/opt/global/bin/trace";

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function targets(home: string): { tool: string; root: string; hooks: string[] }[] {
  return JSON.parse(
    readFileSync(join(home, ".trace", "integrations.json"), "utf8"),
  ).targets;
}

test("Codex setup honors CODEX_HOME and records a skills-only target", () => {
  const { dir, cleanup } = tempDir("trace-setup-codex-");
  try {
    const root = join(dir, "custom-codex");
    const result = setupOperation(["--tool", "codex", "--yes"], {
      env: { HOME: dir, CODEX_HOME: root, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "skills", "trace", "SKILL.md"))).toBe(true);
    expect(targets(dir)[0]).toMatchObject({ tool: "codex", root, hooks: [] });
  } finally {
    cleanup();
  }
});

test("explicit Codex target wins over the default root", () => {
  const { dir, cleanup } = tempDir("trace-setup-codex-target-");
  try {
    const root = join(dir, "codex-explicit");
    const result = setupOperation(["--target", `codex=${root}`, "--yes"], {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "skills", "board", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".codex"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("Cursor setup installs and records a skills-only target", () => {
  const { dir, cleanup } = tempDir("trace-setup-cursor-");
  try {
    const result = setupOperation(["--tool", "cursor", "--yes"], {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });
    const root = join(dir, ".cursor");
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "skills", "trace", "SKILL.md"))).toBe(true);
    expect(targets(dir)[0]).toMatchObject({ tool: "cursor", root, hooks: [] });
  } finally {
    cleanup();
  }
});

test("setup without --tool installs every detected host", () => {
  const { dir, cleanup } = tempDir("trace-setup-detect-");
  try {
    mkdirSync(join(dir, ".codex"));
    mkdirSync(join(dir, ".cursor"));
    const result = setupOperation(["--yes"], {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dir, ".codex", "skills", "trace", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".cursor", "skills", "trace", "SKILL.md"))).toBe(true);
    expect(targets(dir).map(({ tool }) => tool).sort()).toEqual(["codex", "cursor"]);
  } finally {
    cleanup();
  }
});

test("setup without --tool explains how to select a host when none is detected", () => {
  const { dir, cleanup } = tempDir("trace-setup-no-host-");
  try {
    const result = setupOperation(["--yes"], {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--tool");
  } finally {
    cleanup();
  }
});

test("Codex setup previews without writing until --yes", () => {
  const { dir, cleanup } = tempDir("trace-setup-codex-preview-");
  try {
    const result = setupOperation(["--tool", "codex"], {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Codex");
    expect(result.stdout).toContain("--yes");
    expect(existsSync(join(dir, ".codex"))).toBe(false);
  } finally {
    cleanup();
  }
});
