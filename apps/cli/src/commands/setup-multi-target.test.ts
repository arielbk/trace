import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { setupOperation } from "./setup-operations.ts";

const CLI_PATH = "/opt/global/bin/trace";

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function roots(home: string): string[] {
  return JSON.parse(
    readFileSync(join(home, ".trace", "integrations.json"), "utf8"),
  ).targets.map((target: { root: string }) => target.root);
}

test("explicit Claude target wins over environment and default roots", () => {
  const { dir, cleanup } = tempDir("trace-setup-target-");
  try {
    const explicit = join(dir, "explicit");
    const envRoot = join(dir, "from-env");
    const result = setupOperation(["--target", `claude=${explicit}`, "--yes"], {
      env: { HOME: dir, CLAUDE_CONFIG_DIR: envRoot, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(explicit, "skills", "trace", "SKILL.md"))).toBe(true);
    expect(existsSync(envRoot)).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("ordinary Claude setup honors CLAUDE_CONFIG_DIR", () => {
  const { dir, cleanup } = tempDir("trace-setup-env-");
  try {
    const root = join(dir, "from-env");
    const result = setupOperation(["--tool", "claude", "--yes"], {
      env: { HOME: dir, CLAUDE_CONFIG_DIR: root, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "skills", "trace", "SKILL.md"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("registering two Claude roots is additive", () => {
  const { dir, cleanup } = tempDir("trace-setup-additive-");
  try {
    const rootA = join(dir, "a");
    const rootB = join(dir, "b");
    const ctx = {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    };
    expect(setupOperation(["--target", `claude=${rootA}`, "--yes"], ctx).exitCode).toBe(0);
    expect(setupOperation(["--target", `claude=${rootB}`, "--yes"], ctx).exitCode).toBe(0);
    expect(roots(dir).sort()).toEqual([rootA, rootB].sort());
  } finally {
    cleanup();
  }
});

test("setup rejects malformed explicit targets", () => {
  const { dir, cleanup } = tempDir("trace-setup-malformed-target-");
  try {
    const result = setupOperation(["--target", "claude", "--yes"], {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--target <tool>=<path>");
  } finally {
    cleanup();
  }
});
