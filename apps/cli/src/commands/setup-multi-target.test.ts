import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  parseTargetFlag,
  resolveClaudeConfigRoot,
  setupOperation,
} from "./setup-operations.ts";

const CLI_PATH = "/opt/global/bin/trace";

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readTargets(dir: string): { tool: string; root: string }[] {
  return JSON.parse(readFileSync(join(dir, ".trace", "integrations.json"), "utf8"))
    .targets;
}

test("resolveClaudeConfigRoot honors CLAUDE_CONFIG_DIR over the default root", () => {
  expect(resolveClaudeConfigRoot({ HOME: "/home/u" })).toBe("/home/u/.claude");
  expect(
    resolveClaudeConfigRoot({ HOME: "/home/u", CLAUDE_CONFIG_DIR: "/custom/claude" }),
  ).toBe("/custom/claude");
});

test("parseTargetFlag extracts tool=path pairs and rejects malformed input", () => {
  expect(parseTargetFlag(["--yes"])).toBeUndefined();
  expect(parseTargetFlag(["--target", "claude=/a/b"])).toEqual({
    tool: "claude",
    root: "/a/b",
  });
  expect(() => parseTargetFlag(["--target", "claude"])).toThrow();
  expect(() => parseTargetFlag(["--target"])).toThrow();
});

test("setup --target claude=/path installs into that explicit root over env/default", () => {
  const { dir, cleanup } = tempDir("trace-mt-explicit-");
  try {
    const explicit = join(dir, "explicit-root");
    const env = {
      HOME: dir,
      TRACE_CLI_PATH: CLI_PATH,
      CLAUDE_CONFIG_DIR: join(dir, "env-root"),
    };
    const result = setupOperation(["--target", `claude=${explicit}`, "--yes"], {
      env,
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(explicit, "skills", "trace", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "env-root"))).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(readTargets(dir).map((t) => t.root)).toEqual([explicit]);
  } finally {
    cleanup();
  }
});

test("ordinary setup resolves CLAUDE_CONFIG_DIR over the default root", () => {
  const { dir, cleanup } = tempDir("trace-mt-env-");
  try {
    const envRoot = join(dir, "env-root");
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH, CLAUDE_CONFIG_DIR: envRoot };
    const result = setupOperation(["--tool", "claude", "--yes"], {
      env,
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(envRoot, "skills", "trace", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(readTargets(dir).map((t) => t.root)).toEqual([envRoot]);
  } finally {
    cleanup();
  }
});

test("registering two Claude roots is additive and a later run reconciles both", () => {
  const { dir, cleanup } = tempDir("trace-mt-additive-");
  try {
    const rootA = join(dir, "root-a");
    const rootB = join(dir, "root-b");
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const ctx = { env, cwd: dir, stdin: "" };

    setupOperation(["--target", `claude=${rootA}`, "--yes"], ctx);
    setupOperation(["--target", `claude=${rootB}`, "--yes"], ctx);

    expect(readTargets(dir).map((t) => t.root).sort()).toEqual([rootA, rootB].sort());

    // An ordinary run pointed at one registered root reconciles every
    // registered root, not just the resolved one.
    const reconcile = setupOperation(["--tool", "claude", "--yes"], {
      env: { ...env, CLAUDE_CONFIG_DIR: rootA },
      cwd: dir,
      stdin: "",
    });
    expect(reconcile.exitCode).toBe(0);
    expect(existsSync(join(rootA, "skills", "board", "SKILL.md"))).toBe(true);
    expect(existsSync(join(rootB, "skills", "board", "SKILL.md"))).toBe(true);
    expect(readTargets(dir).map((t) => t.root).sort()).toEqual([rootA, rootB].sort());
  } finally {
    cleanup();
  }
});
