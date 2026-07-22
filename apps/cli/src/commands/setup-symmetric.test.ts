import {
  existsSync,
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

/** Injects a legacy `@arielbk/trace` plugin entry into a root's settings.json. */
function injectLegacyPlugin(root: string): void {
  const settingsPath = join(root, "settings.json");
  const settings = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf8"))
    : {};
  settings.plugins = ["@arielbk/trace"];
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

test("--registered skips a guardrail-failing target and reconciles the rest", () => {
  const { dir, cleanup } = tempDir("trace-symmetric-registered-skip-");
  try {
    const claudeRoot = join(dir, "claude");
    const codexRoot = join(dir, "codex");
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const ctx = { env, cwd: dir, stdin: "" };

    expect(
      setupOperation(["--target", `claude=${claudeRoot}`, "--yes"], ctx).exitCode,
    ).toBe(0);
    expect(
      setupOperation(["--target", `codex=${codexRoot}`, "--yes"], ctx).exitCode,
    ).toBe(0);

    // Claude now has a legacy plugin (would fail its guardrail); Codex is clean
    // but missing a skill, so a healthy reconcile must restore it.
    injectLegacyPlugin(claudeRoot);
    const codexSkill = join(codexRoot, "skills", "board", "SKILL.md");
    rmSync(codexSkill);

    const result = setupOperation(["--registered", "--yes"], ctx);

    // Batch succeeds: Codex reconciled, Claude skipped with a visible reason.
    expect(result.exitCode).toBe(0);
    expect(existsSync(codexSkill)).toBe(true);
    expect(result.stdout).toContain("@arielbk/trace");
    expect(result.stdout.toLowerCase()).toContain("skip");
  } finally {
    cleanup();
  }
});

test("--registered fails when every target trips its guardrail", () => {
  const { dir, cleanup } = tempDir("trace-symmetric-all-skipped-");
  try {
    const claudeA = join(dir, "claude-a");
    const claudeB = join(dir, "claude-b");
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const ctx = { env, cwd: dir, stdin: "" };

    expect(
      setupOperation(["--target", `claude=${claudeA}`, "--yes"], ctx).exitCode,
    ).toBe(0);
    expect(
      setupOperation(["--target", `claude=${claudeB}`, "--yes"], ctx).exitCode,
    ).toBe(0);

    injectLegacyPlugin(claudeA);
    injectLegacyPlugin(claudeB);

    // A prior healthy install left a skill; a fully-skipped batch must not
    // remove or rewrite it — nothing should be touched.
    const untouchedSkill = join(claudeA, "skills", "board", "SKILL.md");
    const before = readFileSync(untouchedSkill, "utf8");

    const result = setupOperation(["--registered", "--yes"], ctx);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("@arielbk/trace");
    expect(readFileSync(untouchedSkill, "utf8")).toBe(before);
  } finally {
    cleanup();
  }
});

test("--registered preview shows the same install/skip partition as apply", () => {
  const { dir, cleanup } = tempDir("trace-symmetric-preview-");
  try {
    const claudeRoot = join(dir, "claude");
    const codexRoot = join(dir, "codex");
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const ctx = { env, cwd: dir, stdin: "" };

    expect(
      setupOperation(["--target", `claude=${claudeRoot}`, "--yes"], ctx).exitCode,
    ).toBe(0);
    expect(
      setupOperation(["--target", `codex=${codexRoot}`, "--yes"], ctx).exitCode,
    ).toBe(0);

    injectLegacyPlugin(claudeRoot);

    const result = setupOperation(["--registered"], ctx);

    // Preview runs the pre-flight: Codex appears in the plan, Claude in a
    // skipped section with its reason, and nothing is applied yet.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Codex");
    expect(result.stdout).toContain("@arielbk/trace");
    expect(result.stdout.toLowerCase()).toContain("skip");
    expect(result.stdout).toContain("--yes");
  } finally {
    cleanup();
  }
});

test("explicit --tool claude against a legacy config still fails hard", () => {
  const { dir, cleanup } = tempDir("trace-symmetric-explicit-fatal-");
  try {
    const claudeRoot = join(dir, "claude");
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    const ctx = { env, cwd: dir, stdin: "" };

    expect(
      setupOperation(["--target", `claude=${claudeRoot}`, "--yes"], ctx).exitCode,
    ).toBe(0);
    injectLegacyPlugin(claudeRoot);

    // The user named this target explicitly, so a guardrail failure must remain
    // fatal — skip-and-warn is only for auto-discovered batches.
    const result = setupOperation(
      ["--target", `claude=${claudeRoot}`, "--yes"],
      ctx,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("@arielbk/trace");
  } finally {
    cleanup();
  }
});
