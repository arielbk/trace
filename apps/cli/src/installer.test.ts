import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runInit } from "./installer.ts";

const hookCommand = `${process.execPath} ${fileURLToPath(
  new URL("./claude-session-start-hook.ts", import.meta.url),
)}`;

type Settings = {
  permissions?: { allow?: string[] };
  hooks?: Record<
    string,
    Array<{ hooks?: Array<{ type?: string; command?: string }> }>
  >;
};

test("runInit registers the SessionStart hook into a fresh settings file", () => {
  const home = mkdtempSync(join(tmpdir(), "trace-installer-"));

  try {
    const output = runInit({ HOME: home }, home);

    expect(output).toContain("registered Claude SessionStart hook");
    expect(output).toContain("manual: run pnpm link --global");

    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf8"),
    ) as Settings;
    expect(settings.hooks?.SessionStart).toEqual([
      { hooks: [{ type: "command", command: hookCommand }] },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runInit preserves existing settings and does not duplicate the hook", () => {
  const home = mkdtempSync(join(tmpdir(), "trace-installer-"));
  const settingsPath = join(home, ".claude", "settings.json");

  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ["Bash(git status:*)"] },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] },
      }),
    );

    runInit({ HOME: home }, home);
    const second = runInit({ HOME: home }, home);

    expect(second).toContain("Claude SessionStart hook already registered");

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    expect(settings.permissions?.allow).toEqual(["Bash(git status:*)"]);
    expect(settings.hooks?.Stop).toEqual([
      { hooks: [{ type: "command", command: "echo stop" }] },
    ]);
    expect(settings.hooks?.SessionStart).toHaveLength(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runInit honours CLAUDE_SETTINGS_PATH over HOME", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-installer-"));
  const settingsPath = join(dir, "nested", "settings.json");

  try {
    runInit({ CLAUDE_SETTINGS_PATH: settingsPath }, dir);

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    expect(settings.hooks?.SessionStart).toEqual([
      { hooks: [{ type: "command", command: hookCommand }] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runInit fails when neither CLAUDE_SETTINGS_PATH nor HOME is set", () => {
  expect(() => runInit({}, "/tmp")).toThrow(
    "trace init requires HOME or CLAUDE_SETTINGS_PATH",
  );
});
