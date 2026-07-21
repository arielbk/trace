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
import { setupOperation } from "./setup-operations.ts";

const CLI_PATH = "/opt/global/bin/trace";

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function context(home: string) {
  return {
    env: { HOME: home, TRACE_CLI_PATH: CLI_PATH },
    cwd: home,
    stdin: "",
  };
}

function registeredTargets(home: string): { tool: string; root: string }[] {
  return JSON.parse(
    readFileSync(join(home, ".trace", "integrations.json"), "utf8"),
  ).targets.map(({ tool, root }: { tool: string; root: string }) => ({ tool, root }));
}

test("removal previews without changing the registered target", () => {
  const { dir, cleanup } = tempDir("trace-remove-preview-");
  try {
    const ctx = context(dir);
    expect(setupOperation(["--tool", "claude", "--yes"], ctx).exitCode).toBe(0);

    const result = setupOperation(["--remove", "--tool", "claude"], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("removal plan");
    expect(result.stdout).toContain("--yes");
    expect(existsSync(join(dir, ".claude", "skills", "trace"))).toBe(true);
    expect(registeredTargets(dir)).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("Claude removal deletes owned artifacts and preserves unrelated settings", () => {
  const { dir, cleanup } = tempDir("trace-remove-claude-");
  try {
    const ctx = context(dir);
    expect(setupOperation(["--tool", "claude", "--yes"], ctx).exitCode).toBe(0);
    const settingsPath = join(dir, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.model = "claude-3";
    settings.hooks.UserPromptSubmit = [
      { hooks: [{ type: "command", command: "my-tool prompt" }] },
    ];
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    const result = setupOperation(
      ["--remove", "--tool", "claude", "--yes"],
      ctx,
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dir, ".claude", "skills", "trace"))).toBe(false);
    const remaining = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(remaining.model).toBe("claude-3");
    expect(remaining.hooks).toEqual({
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "my-tool prompt" }] },
      ],
    });
    expect(registeredTargets(dir)).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("explicit removal removes only the exact registered target", () => {
  const { dir, cleanup } = tempDir("trace-remove-exact-");
  try {
    const rootA = join(dir, "claude-a");
    const rootB = join(dir, "claude-b");
    const ctx = context(dir);
    expect(setupOperation(["--target", `claude=${rootA}`, "--yes"], ctx).exitCode).toBe(0);
    expect(setupOperation(["--target", `claude=${rootB}`, "--yes"], ctx).exitCode).toBe(0);

    const result = setupOperation(
      ["--remove", "--target", `claude=${rootA}`, "--yes"],
      ctx,
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(rootA, "skills", "trace"))).toBe(false);
    expect(existsSync(join(rootB, "skills", "trace"))).toBe(true);
    expect(registeredTargets(dir)).toEqual([{ tool: "claude", root: rootB }]);
  } finally {
    cleanup();
  }
});

test("removal without a selector removes every registered target", () => {
  const { dir, cleanup } = tempDir("trace-remove-all-");
  try {
    const claudeRoot = join(dir, "claude");
    const codexRoot = join(dir, "codex");
    const cursorRoot = join(dir, "cursor");
    const ctx = context(dir);
    for (const [tool, root] of [
      ["claude", claudeRoot],
      ["codex", codexRoot],
      ["cursor", cursorRoot],
    ] as const) {
      expect(setupOperation(["--target", `${tool}=${root}`, "--yes"], ctx).exitCode).toBe(0);
    }

    const result = setupOperation(["--remove", "--yes"], ctx);

    expect(result.exitCode).toBe(0);
    for (const root of [claudeRoot, codexRoot, cursorRoot]) {
      expect(existsSync(join(root, "skills", "trace"))).toBe(false);
    }
    expect(registeredTargets(dir)).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("removal with no registered targets is a successful no-op", () => {
  const { dir, cleanup } = tempDir("trace-remove-empty-");
  try {
    const result = setupOperation(["--remove", "--yes"], context(dir));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Nothing to remove");
  } finally {
    cleanup();
  }
});

test("removal rejects unsafe registry artifact names without deleting user data", () => {
  const { dir, cleanup } = tempDir("trace-remove-unsafe-registry-");
  try {
    const root = join(dir, "codex");
    const userData = join(dir, "user-data");
    const registryPath = join(dir, ".trace", "integrations.json");
    mkdirSync(join(root, "skills"), { recursive: true });
    mkdirSync(userData);
    writeFileSync(join(userData, "keep.txt"), "user-owned\n");
    mkdirSync(join(registryPath, ".."), { recursive: true });
    const originalRegistry = `${JSON.stringify(
      {
        packageManager: "npm",
        targets: [
          {
            tool: "codex",
            root,
            cliPath: CLI_PATH,
            version: "1.0.0",
            skills: ["../../user-data"],
            hooks: [],
          },
        ],
      },
      null,
      2,
    )}\n`;
    writeFileSync(registryPath, originalRegistry);

    const result = setupOperation(["--remove", "--yes"], context(dir));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/integration registry.*corrupt/i);
    expect(readFileSync(join(userData, "keep.txt"), "utf8")).toBe("user-owned\n");
    expect(readFileSync(registryPath, "utf8")).toBe(originalRegistry);
  } finally {
    cleanup();
  }
});
