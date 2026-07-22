import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "../trace.ts";
import { setupOperation } from "./setup-operations.ts";

const CLI_PATH = "/opt/global/bin/trace";
const SKILLS = ["board", "doc-placement", "recall", "reenter", "state", "trace"];

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Claude setup installs skills and hooks while preserving unrelated settings", () => {
  const { dir, cleanup } = tempDir("trace-setup-claude-");
  try {
    const root = join(dir, ".claude");
    mkdirSync(root);
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ model: "claude-3" }),
    );
    const result = setupOperation(["--tool", "claude", "--yes"], {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    for (const skill of SKILLS) {
      expect(existsSync(join(root, "skills", skill, "SKILL.md"))).toBe(true);
    }
    const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
    expect(settings.model).toBe("claude-3");
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(CLI_PATH);
    expect(settings.hooks.SubagentStop[0].hooks[0].command).toContain(CLI_PATH);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(CLI_PATH);

    const registry = JSON.parse(
      readFileSync(join(dir, ".trace", "integrations.json"), "utf8"),
    );
    expect(registry.targets[0]).toMatchObject({
      tool: "claude",
      root,
      cliPath: CLI_PATH,
      skills: SKILLS,
      hooks: ["SessionStart", "SubagentStop", "Stop"],
    });
  } finally {
    cleanup();
  }
});

test("Claude setup previews without writing until --yes", () => {
  const { dir, cleanup } = tempDir("trace-setup-claude-preview-");
  try {
    const result = setupOperation(["--tool", "claude"], {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Claude Code");
    expect(result.stdout).toContain("--yes");
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("trace setup dispatches through the CLI", () => {
  const { dir, cleanup } = tempDir("trace-setup-claude-cli-");
  try {
    const result = runTraceCli(
      ["setup", "--tool", "claude", "--yes"],
      { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      dir,
      "",
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dir, ".claude", "skills", "trace", "SKILL.md"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("setup rejects an unknown tool", () => {
  const result = setupOperation(["--tool", "emacs", "--yes"], {
    env: { HOME: "/tmp", TRACE_CLI_PATH: CLI_PATH },
    cwd: "/tmp",
    stdin: "",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Unsupported tool");
});

test("setup refuses to register an ephemeral npx cache executable", () => {
  const { dir, cleanup } = tempDir("trace-setup-npx-cache-");
  try {
    const cliPath = join(
      dir,
      ".npm",
      "_npx",
      "temporary",
      "node_modules",
      "@arielbk",
      "trace",
      "dist",
      "trace.js",
    );

    const result = setupOperation(["--tool", "claude", "--yes"], {
      env: { HOME: dir, TRACE_CLI_PATH: cliPath },
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("npx");
    expect(result.stderr).toMatch(/persistent global CLI/i);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, ".trace", "integrations.json"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("setup refuses to register a source-checkout executable", () => {
  const { dir, cleanup } = tempDir("trace-setup-source-checkout-");
  try {
    const cliPath = join(dir, "trace-v2", "apps", "cli", "src", "trace.ts");

    const result = setupOperation(["--tool", "claude", "--yes"], {
      env: { HOME: dir, TRACE_CLI_PATH: cliPath },
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/source checkout/i);
    expect(result.stderr).toMatch(/persistent global CLI/i);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, ".trace", "integrations.json"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("Claude hooks quote an absolute CLI path containing spaces", () => {
  const { dir, cleanup } = tempDir("trace-setup-spaced-cli-");
  try {
    const cliPath = "/opt/Trace CLI/bin/trace";

    const result = setupOperation(["--tool", "claude", "--yes"], {
      env: { HOME: dir, TRACE_CLI_PATH: cliPath },
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      `'${cliPath}' hook session-start`,
    );
  } finally {
    cleanup();
  }
});
