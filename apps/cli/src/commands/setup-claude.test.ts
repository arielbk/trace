import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { runTraceCli } from "../trace.ts";
import {
  applyClaudeSetup,
  planClaudeSetup,
  resolvePackagedSkillsDir,
  setupOperation,
  TRACE_CLAUDE_SKILLS,
} from "./setup-operations.ts";

const packagedVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
).version as string;

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CLI_PATH = "/opt/global/bin/trace";
const VERSION = "9.9.9";

function baseOptions(configRoot: string, registryPath = join(configRoot, "registry.json")) {
  return {
    configRoot,
    registryPath,
    skillsSourceDir: resolvePackagedSkillsDir(),
    cliPath: CLI_PATH,
    version: VERSION,
    packageManager: "pnpm" as const,
  };
}

test("apply installs the six packaged Trace skills into the Claude config root", () => {
  const { dir, cleanup } = tempDir("trace-setup-claude-");
  try {
    applyClaudeSetup(baseOptions(dir));

    for (const skill of TRACE_CLAUDE_SKILLS) {
      expect(
        existsSync(join(dir, "skills", skill, "SKILL.md")),
        `expected skill ${skill}`,
      ).toBe(true);
    }
    expect(TRACE_CLAUDE_SKILLS).toHaveLength(6);
  } finally {
    cleanup();
  }
});

test("apply registers hooks with the absolute CLI path, preserving unrelated settings", () => {
  const { dir, cleanup } = tempDir("trace-setup-claude-");
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ theme: "dark", hooks: { UserPromptSubmit: [{ hooks: [] }] } }),
    );

    applyClaudeSetup(baseOptions(dir));

    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.UserPromptSubmit).toEqual([{ hooks: [] }]);

    const sessionStart = settings.hooks.SessionStart;
    expect(sessionStart[0].matcher).toBe("startup|resume|clear|compact");
    expect(sessionStart[0].hooks[0].command).toBe(`${CLI_PATH} hook session-start`);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(`${CLI_PATH} hook stop`);
    expect(settings.hooks.SubagentStop[0].hooks[0].command).toBe(
      `${CLI_PATH} hook subagent-stop`,
    );
    // No npx-pinned command survives.
    expect(readFileSync(join(dir, "settings.json"), "utf8")).not.toContain("npx ");
  } finally {
    cleanup();
  }
});

test("apply records ownership, version, package manager, and the target", () => {
  const { dir, cleanup } = tempDir("trace-setup-claude-");
  const registryPath = join(dir, "registry.json");
  try {
    applyClaudeSetup(baseOptions(dir, registryPath));

    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(registry.packageManager).toBe("pnpm");
    expect(registry.targets).toHaveLength(1);

    const target = registry.targets[0];
    expect(target.tool).toBe("claude");
    expect(target.root).toBe(dir);
    expect(target.cliPath).toBe(CLI_PATH);
    expect(target.version).toBe(VERSION);
    expect([...target.skills].sort()).toEqual([...TRACE_CLAUDE_SKILLS].sort());
    expect(target.hooks).toEqual(["SessionStart", "SubagentStop", "Stop"]);
  } finally {
    cleanup();
  }
});

function snapshotMtimes(root: string): Map<string, number> {
  const seen = new Map<string, number>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else seen.set(full, statSync(full).mtimeMs);
    }
  };
  walk(root);
  return seen;
}

test("re-running apply on an up-to-date target changes nothing on disk", () => {
  const { dir, cleanup } = tempDir("trace-setup-claude-");
  const registryPath = join(dir, "registry.json");
  try {
    applyClaudeSetup(baseOptions(dir, registryPath));
    const before = snapshotMtimes(dir);

    applyClaudeSetup(baseOptions(dir, registryPath));
    const after = snapshotMtimes(dir);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, mtime] of before) {
      expect(after.get(path), `mtime changed for ${path}`).toBe(mtime);
    }
  } finally {
    cleanup();
  }
});

test("setup --tool claude --yes installs into ~/.claude and records the target", () => {
  const { dir, cleanup } = tempDir("trace-setup-home-");
  try {
    const env = {
      HOME: dir,
      TRACE_CLI_PATH: CLI_PATH,
      npm_config_user_agent: "pnpm/9.0.0 npm/? node/v22.0.0 darwin arm64",
    };
    const result = setupOperation(["--tool", "claude", "--yes"], {
      env,
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dir, ".claude", "skills", "trace", "SKILL.md"))).toBe(true);
    const registry = JSON.parse(
      readFileSync(join(dir, ".trace", "integrations.json"), "utf8"),
    );
    expect(registry.packageManager).toBe("pnpm");
    expect(registry.targets[0].root).toBe(join(dir, ".claude"));
    expect(registry.targets[0].version).toBe(packagedVersion);
    expect(registry.targets[0].cliPath).toBe(CLI_PATH);
  } finally {
    cleanup();
  }
});

test("setup --tool claude without --yes previews the plan and writes nothing", () => {
  const { dir, cleanup } = tempDir("trace-setup-home-");
  try {
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = setupOperation(["--tool", "claude"], { env, cwd: dir, stdin: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--yes");
    expect(result.stdout).toContain(join(dir, ".claude"));
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, ".trace", "integrations.json"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("plan lists the skills, hooks, target root, and CLI command path", () => {
  const { dir, cleanup } = tempDir("trace-setup-plan-");
  try {
    const plan = planClaudeSetup(baseOptions(dir));
    expect(plan).toContain(dir);
    expect(plan).toContain(CLI_PATH);
    for (const skill of TRACE_CLAUDE_SKILLS) expect(plan).toContain(skill);
    expect(plan).toContain("SessionStart");
  } finally {
    cleanup();
  }
});

test("trace setup dispatches through the CLI and installs the target", () => {
  const { dir, cleanup } = tempDir("trace-setup-cli-");
  try {
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const result = runTraceCli(["setup", "--tool", "claude", "--yes"], env, dir, "");
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dir, ".claude", "skills", "board", "SKILL.md"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("setup rejects an unknown tool", () => {
  const result = setupOperation(["--tool", "emacs"], {
    env: { HOME: "/tmp" },
    cwd: "/tmp",
    stdin: "",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("emacs");
});
