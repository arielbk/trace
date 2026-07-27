import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { setupOperation } from "./setup-operations.ts";

const CLI_PATH = "/opt/global/bin/trace";

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The `(tool, root)` identities recorded in the Integration Registry. */
function registeredIdentities(home: string): string[] {
  const path = join(home, ".trace", "integrations.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"))
    .targets.map(({ tool, root }: { tool: string; root: string }) => `${tool}=${root}`)
    .sort();
}

test("bare --yes reconciles a registered root whose provider default is absent", () => {
  const { dir, cleanup } = tempDir("trace-inventory-registered-only-");
  try {
    const customCodex = join(dir, "work-codex");
    const ctx = {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    };

    expect(
      setupOperation(["--target", `codex=${customCodex}`, "--yes"], ctx).exitCode,
    ).toBe(0);
    // The conventional ~/.codex root does not exist, so host detection alone
    // would never surface this registered target.
    expect(existsSync(join(dir, ".codex"))).toBe(false);

    const skill = join(customCodex, "skills", "board", "SKILL.md");
    rmSync(skill);

    const result = setupOperation(["--yes"], ctx);

    expect(result.exitCode).toBe(0);
    expect(existsSync(skill)).toBe(true);
    expect(registeredIdentities(dir)).toEqual([`codex=${customCodex}`]);
  } finally {
    cleanup();
  }
});

test("bare --yes installs into the environment root, not the shadowed default", () => {
  const { dir, cleanup } = tempDir("trace-inventory-env-root-");
  try {
    const envRoot = join(dir, "work-claude");
    const defaultRoot = join(dir, ".claude");
    mkdirSync(envRoot, { recursive: true });
    mkdirSync(defaultRoot, { recursive: true });

    const result = setupOperation(["--yes"], {
      env: { HOME: dir, CLAUDE_CONFIG_DIR: envRoot, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });

    // CLAUDE_CONFIG_DIR names the active root, so the conventional ~/.claude
    // root is not a candidate even though the directory exists.
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(envRoot, "skills", "board", "SKILL.md"))).toBe(true);
    expect(existsSync(join(defaultRoot, "skills"))).toBe(false);
    expect(registeredIdentities(dir)).toEqual([`claude=${envRoot}`]);
  } finally {
    cleanup();
  }
});

test("bare --yes reconciles detected and registered roots exactly once each", () => {
  const { dir, cleanup } = tempDir("trace-inventory-dedup-");
  try {
    const defaultClaude = join(dir, ".claude");
    const workClaude = join(dir, "work-claude");
    const ctx = {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    };

    // ~/.claude is both a detected default and a registered target; work-claude
    // is registered only.
    mkdirSync(defaultClaude, { recursive: true });
    expect(
      setupOperation(["--target", `claude=${defaultClaude}`, "--yes"], ctx).exitCode,
    ).toBe(0);
    expect(
      setupOperation(["--target", `claude=${workClaude}`, "--yes"], ctx).exitCode,
    ).toBe(0);

    const result = setupOperation(["--yes"], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.split(`target root: ${defaultClaude}\n`)).toHaveLength(2);
    expect(result.stdout.split(`target root: ${workClaude}\n`)).toHaveLength(2);
    expect(registeredIdentities(dir)).toEqual(
      [`claude=${defaultClaude}`, `claude=${workClaude}`].sort(),
    );
  } finally {
    cleanup();
  }
});
