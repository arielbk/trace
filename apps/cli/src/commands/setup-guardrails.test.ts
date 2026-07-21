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

function runSetup(home: string, tool: "claude" | "codex" | "cursor", yes = true) {
  return setupOperation(["--tool", tool, ...(yes ? ["--yes"] : [])], {
    env: { HOME: home, TRACE_CLI_PATH: CLI_PATH },
    cwd: home,
    stdin: "",
  });
}

test("Claude guardrails preserve malformed settings bytes", () => {
  const { dir, cleanup } = tempDir("trace-guardrail-malformed-");
  try {
    const root = join(dir, ".claude");
    const settingsPath = join(root, "settings.json");
    const original = "{ not valid json [";
    mkdirSync(root);
    writeFileSync(settingsPath, original);

    const result = runSetup(dir, "claude");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("malformed");
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
  } finally {
    cleanup();
  }
});

test("Claude guardrails reject an array settings document before any write", () => {
  const { dir, cleanup } = tempDir("trace-guardrail-array-settings-");
  try {
    const root = join(dir, ".claude");
    const settingsPath = join(root, "settings.json");
    const original = "[]\n";
    mkdirSync(root);
    writeFileSync(settingsPath, original);

    const result = runSetup(dir, "claude");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/settings\.json.*object/i);
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expect(existsSync(join(root, "skills"))).toBe(false);
    expect(existsSync(join(dir, ".trace", "integrations.json"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("Claude guardrails reject a primitive settings document before any write", () => {
  const { dir, cleanup } = tempDir("trace-guardrail-primitive-settings-");
  try {
    const root = join(dir, ".claude");
    const settingsPath = join(root, "settings.json");
    const original = "42\n";
    mkdirSync(root);
    writeFileSync(settingsPath, original);

    const result = runSetup(dir, "claude");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/settings\.json.*object/i);
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expect(existsSync(join(root, "skills"))).toBe(false);
    expect(existsSync(join(dir, ".trace", "integrations.json"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("Claude guardrails reject a null settings document before any write", () => {
  const { dir, cleanup } = tempDir("trace-guardrail-null-settings-");
  try {
    const root = join(dir, ".claude");
    const settingsPath = join(root, "settings.json");
    const original = "null\n";
    mkdirSync(root);
    writeFileSync(settingsPath, original);

    const result = runSetup(dir, "claude");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/settings\.json.*object/i);
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expect(existsSync(join(root, "skills"))).toBe(false);
    expect(existsSync(join(dir, ".trace", "integrations.json"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("Claude guardrails reject a non-object hooks value before any write", () => {
  const { dir, cleanup } = tempDir("trace-guardrail-array-hooks-");
  try {
    const root = join(dir, ".claude");
    const settingsPath = join(root, "settings.json");
    const original = '{"hooks":[]}\n';
    mkdirSync(root);
    writeFileSync(settingsPath, original);

    const result = runSetup(dir, "claude");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/settings\.json.*hooks.*object/i);
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expect(existsSync(join(root, "skills"))).toBe(false);
    expect(existsSync(join(dir, ".trace", "integrations.json"))).toBe(false);
  } finally {
    cleanup();
  }
});

test.each(["claude", "codex", "cursor"] as const)(
  "%s guardrails preserve an unowned skill collision",
  (tool) => {
    const { dir, cleanup } = tempDir(`trace-guardrail-${tool}-`);
    try {
      const skillPath = join(dir, `.${tool}`, "skills", "board", "SKILL.md");
      mkdirSync(join(skillPath, ".."), { recursive: true });
      writeFileSync(skillPath, "user content");

      const result = runSetup(dir, tool);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("board");
      expect(result.stderr.toLowerCase()).toContain("remediation");
      expect(readFileSync(skillPath, "utf8")).toBe("user content");
    } finally {
      cleanup();
    }
  },
);

test("Claude guardrails preserve an unowned hook event", () => {
  const { dir, cleanup } = tempDir("trace-guardrail-hook-");
  try {
    const root = join(dir, ".claude");
    const settingsPath = join(root, "settings.json");
    const original = JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "mine" }] }] },
    });
    mkdirSync(root);
    writeFileSync(settingsPath, original);

    const result = runSetup(dir, "claude");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("SessionStart");
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
  } finally {
    cleanup();
  }
});

test.each([
  {
    name: "legacy plugin",
    settings: { plugins: ["/plugins/@arielbk/trace"] },
    error: "@arielbk/trace",
  },
  {
    name: "pinned npx hook",
    settings: {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "npx @arielbk/trace hook session-start" }] },
        ],
      },
    },
    error: "npx",
  },
])("Claude guardrails preserve a $name", ({ settings, error }) => {
  const { dir, cleanup } = tempDir("trace-guardrail-legacy-");
  try {
    const root = join(dir, ".claude");
    const settingsPath = join(root, "settings.json");
    const original = JSON.stringify(settings);
    mkdirSync(root);
    writeFileSync(settingsPath, original);

    const result = runSetup(dir, "claude");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(error);
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
  } finally {
    cleanup();
  }
});

test("reconciliation preserves unrelated Claude settings and hooks", () => {
  const { dir, cleanup } = tempDir("trace-guardrail-preserve-");
  try {
    expect(runSetup(dir, "claude").exitCode).toBe(0);
    const settingsPath = join(dir, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.model = "claude-3";
    settings.hooks.UserPromptSubmit = [
      { hooks: [{ type: "command", command: "my-tool prompt" }] },
    ];
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    expect(runSetup(dir, "claude").exitCode).toBe(0);
    const reconciled = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(reconciled.model).toBe("claude-3");
    expect(reconciled.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      "my-tool prompt",
    );
  } finally {
    cleanup();
  }
});

test("setup preview does not run guardrails", () => {
  const { dir, cleanup } = tempDir("trace-guardrail-preview-");
  try {
    const skillPath = join(dir, ".claude", "skills", "board", "SKILL.md");
    mkdirSync(join(skillPath, ".."), { recursive: true });
    writeFileSync(skillPath, "user content");

    const result = runSetup(dir, "claude", false);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--yes");
    expect(readFileSync(skillPath, "utf8")).toBe("user content");
  } finally {
    cleanup();
  }
});
