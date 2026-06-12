import assert from "node:assert/strict";
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
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { runInit } from "./installer.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPackageJson = join(appRoot, "package.json");

function pinnedTraceCommand(): string {
  const packageJson = JSON.parse(readFileSync(cliPackageJson, "utf8")) as {
    name?: string;
    version?: string;
  };
  return `npx ${packageJson.name}@${packageJson.version}`;
}

type Settings = {
  permissions?: { allow?: string[] };
  hooks?: Record<
    string,
    Array<{ hooks?: Array<{ type?: string; command?: string }> }>
  >;
};

describe("trace init", () => {
  it("reports plugin install as the setup path without writing settings", () => {
    const home = mkdtempSync(join(tmpdir(), "trace-installer-"));

    try {
      const output = runInit({ HOME: home }, home);

      assert.equal(
        output.includes(
          "trace is now installed through the Claude Code plugin",
        ),
        true,
      );
      assert.equal(
        output.includes("/plugin marketplace add arielbk/trace-v2"),
        true,
      );
      assert.equal(output.includes("/plugin install trace@trace-v2"), true);
      assert.equal(output.includes("trace skill: found"), true);
      assert.equal(output.includes("pnpm link --global"), false);
      assert.equal(output.includes("SessionStart hook"), false);
      assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves existing settings without adding SessionStart hooks", () => {
    const home = mkdtempSync(join(tmpdir(), "trace-installer-"));
    const settingsPath = join(home, ".claude", "settings.json");

    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({
          permissions: { allow: ["Bash(git status:*)"] },
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
          },
        }),
      );

      const first = runInit({ HOME: home }, home);
      const second = runInit({ HOME: home }, home);

      const settings = JSON.parse(
        readFileSync(settingsPath, "utf8"),
      ) as Settings;
      assert.deepEqual(settings.permissions?.allow, ["Bash(git status:*)"]);
      assert.deepEqual(settings.hooks?.Stop, [
        { hooks: [{ type: "command", command: "echo stop" }] },
      ]);
      assert.equal(settings.hooks?.SessionStart, undefined);
      assert.equal(first.includes("Codex trace skill: installed"), true);
      assert.equal(second.includes("Codex trace skill: already present"), true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not create CLAUDE_SETTINGS_PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-installer-"));
    const settingsPath = join(dir, "nested", "settings.json");

    try {
      const output = runInit({ CLAUDE_SETTINGS_PATH: settingsPath }, dir);

      assert.equal(output.includes("Claude Code plugin"), true);
      assert.equal(existsSync(settingsPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not require HOME or CLAUDE_SETTINGS_PATH", () => {
    assert.equal(runInit({}, "/tmp").includes("Claude Code plugin"), true);
  });

  it("installs a Codex trace skill into the user skill directory idempotently", () => {
    const home = mkdtempSync(join(tmpdir(), "trace-installer-codex-"));
    const skillPath = join(home, ".agents", "skills", "trace", "SKILL.md");

    try {
      const first = runInit({ HOME: home }, repoRoot);
      const firstSkill = readFileSync(skillPath, "utf8");
      const second = runInit({ HOME: home }, repoRoot);
      const secondSkill = readFileSync(skillPath, "utf8");

      assert.equal(existsSync(skillPath), true);
      assert.equal(
        first.includes(`Codex trace skill: installed at ${skillPath}`),
        true,
      );
      assert.equal(
        second.includes(`Codex trace skill: already present at ${skillPath}`),
        true,
      );
      assert.equal(firstSkill, secondSkill);
      assert.equal(firstSkill.includes(pinnedTraceCommand()), true);
      assert.equal(firstSkill.includes("bin/trace.js"), false);
      assert.equal(firstSkill.includes("<trace-plugin-root>"), false);
      assert.equal(firstSkill.includes("CLAUDE_PLUGIN_ROOT"), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
