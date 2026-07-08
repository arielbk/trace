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
import { describe, it } from "vitest";
import { runInit } from "./installer.ts";

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
        output.includes("/plugin marketplace add arielbk/trace"),
        true,
      );
      assert.equal(output.includes("/plugin install trace@trace"), true);
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
      // Plugin install delivers all skills now; trace init copies nothing.
      assert.equal(first.includes("Codex trace skill"), false);
      assert.equal(second.includes("Codex trace skill"), false);
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
});
