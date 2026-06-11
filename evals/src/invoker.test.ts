import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import resolveConfigDir after each test may change env vars.
// Use dynamic import to avoid module-level caching.
import { resolveConfigDir } from "./invoker.ts";

describe("resolveConfigDir", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedEnv;
    }
  });

  test("throws a clear actionable message when CLAUDE_CONFIG_DIR is not set", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(() => resolveConfigDir()).toThrow("CLAUDE_CONFIG_DIR");
  });

  test("error when unset mentions how to fix it (logged-in config dir)", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(() => resolveConfigDir()).toThrow(/logged.in/i);
  });

  test("throws with clear message when CLAUDE_CONFIG_DIR dir does not exist", () => {
    process.env.CLAUDE_CONFIG_DIR =
      "/tmp/nonexistent-claude-config-xyz-ralph-test";
    expect(() => resolveConfigDir()).toThrow("does not exist");
  });

  test("throws with clear message when dir exists but is not a logged-in config", () => {
    // os.tmpdir() exists but has no .claude.json — not a claude config dir
    process.env.CLAUDE_CONFIG_DIR = tmpdir();
    expect(() => resolveConfigDir()).toThrow(/not.*logged.in|\.claude\.json/i);
  });

  test("returns the config dir when it exists and has .claude.json", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-config-test-"));
    writeFileSync(join(tmpDir, ".claude.json"), JSON.stringify({ numStartups: 1 }));
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
      expect(resolveConfigDir()).toBe(tmpDir);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
