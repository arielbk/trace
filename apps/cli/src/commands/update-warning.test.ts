import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkUpdateWarning } from "./update-warning.ts";
import { runTraceCliAsync } from "../trace.ts";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "trace-oob-warn-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeRegistry(
  registryPath: string,
  targets: { tool: string; version: string; root?: string }[],
): void {
  const registry = {
    packageManager: "npm",
    targets: targets.map((t) => ({
      tool: t.tool,
      root: t.root ?? "/fake/root",
      cliPath: "/usr/local/bin/trace",
      version: t.version,
      skills: [],
      hooks: [],
    })),
  };
  mkdirSync(join(registryPath, ".."), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

// ─── behavior 1: no registry → no warning ────────────────────────────────────

test("returns empty string when no registry file exists", () => {
  const { dir, cleanup } = tempDir();
  try {
    const result = checkUpdateWarning({ HOME: dir, TRACE_CURRENT_VERSION: "2.0.0" });
    expect(result).toBe("");
  } finally {
    cleanup();
  }
});

// ─── behavior 2: all targets current → no warning ────────────────────────────

test("returns empty string when all targets match the installed version", () => {
  const { dir, cleanup } = tempDir();
  try {
    const registryPath = join(dir, "integrations.json");
    writeRegistry(registryPath, [
      { tool: "claude", version: "2.0.0" },
      { tool: "codex", version: "2.0.0" },
    ]);
    const result = checkUpdateWarning({
      TRACE_REGISTRY_PATH: registryPath,
      TRACE_CURRENT_VERSION: "2.0.0",
    });
    expect(result).toBe("");
  } finally {
    cleanup();
  }
});

// ─── behavior 3: one stale target → warning with tool name ───────────────────

test("returns warning when one target version does not match installed", () => {
  const { dir, cleanup } = tempDir();
  try {
    const registryPath = join(dir, "integrations.json");
    writeRegistry(registryPath, [{ tool: "claude", version: "1.0.0" }]);
    const result = checkUpdateWarning({
      TRACE_REGISTRY_PATH: registryPath,
      TRACE_CURRENT_VERSION: "2.0.0",
    });
    expect(result).toMatch(/warning/i);
    expect(result).toMatch(/claude/);
    expect(result).toMatch(/trace setup/);
  } finally {
    cleanup();
  }
});

// ─── behavior 4: multiple stale targets → warning lists all tools ─────────────

test("warning lists all stale tool names deduplicated", () => {
  const { dir, cleanup } = tempDir();
  try {
    const registryPath = join(dir, "integrations.json");
    writeRegistry(registryPath, [
      { tool: "claude", version: "1.0.0" },
      { tool: "codex", version: "1.0.0" },
    ]);
    const result = checkUpdateWarning({
      TRACE_REGISTRY_PATH: registryPath,
      TRACE_CURRENT_VERSION: "2.0.0",
    });
    expect(result).toMatch(/claude/);
    expect(result).toMatch(/codex/);
  } finally {
    cleanup();
  }
});

// ─── behavior 5: malformed registry JSON → no warning ────────────────────────

test("returns empty string when registry contains malformed JSON", () => {
  const { dir, cleanup } = tempDir();
  try {
    const registryPath = join(dir, "integrations.json");
    writeFileSync(registryPath, "not valid json {{{");
    const result = checkUpdateWarning({
      TRACE_REGISTRY_PATH: registryPath,
      TRACE_CURRENT_VERSION: "2.0.0",
    });
    expect(result).toBe("");
  } finally {
    cleanup();
  }
});

// ─── behavior 6: ordinary command + stale registry → warning in stderr ───────

test("ordinary command emits stale integration warning in stderr", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const registryPath = join(dir, "integrations.json");
    writeRegistry(registryPath, [{ tool: "claude", version: "1.0.0" }]);
    const result = await runTraceCliAsync(
      ["task", "list"],
      {
        HOME: dir,
        TRACE_DB: join(dir, "trace.sqlite"),
        TRACE_REGISTRY_PATH: registryPath,
        TRACE_CURRENT_VERSION: "2.0.0",
      },
      dir,
    );
    expect(result.stderr).toMatch(/warning.*out of date/i);
  } finally {
    cleanup();
  }
});

// ─── behavior 7: setup command + stale registry → no warning ─────────────────

test("setup command does not emit stale integration warning", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const registryPath = join(dir, "integrations.json");
    writeRegistry(registryPath, [{ tool: "claude", version: "1.0.0" }]);
    const result = await runTraceCliAsync(
      ["setup", "--tool", "claude"],
      {
        HOME: dir,
        TRACE_REGISTRY_PATH: registryPath,
        TRACE_CURRENT_VERSION: "2.0.0",
        TRACE_CLI_PATH: "/usr/local/bin/trace",
      },
      dir,
    );
    expect(result.stderr).not.toMatch(/warning.*out of date/i);
  } finally {
    cleanup();
  }
});

// ─── behavior 8: hook command + stale registry → no warning ──────────────────

test("hook command does not emit stale integration warning", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const registryPath = join(dir, "integrations.json");
    writeRegistry(registryPath, [{ tool: "claude", version: "1.0.0" }]);
    const result = await runTraceCliAsync(
      ["hook", "session-start"],
      {
        HOME: dir,
        TRACE_DB: join(dir, "trace.sqlite"),
        TRACE_REGISTRY_PATH: registryPath,
        TRACE_CURRENT_VERSION: "2.0.0",
      },
      dir,
      "{}",
    );
    expect(result.stderr).not.toMatch(/warning.*out of date/i);
  } finally {
    cleanup();
  }
});

// ─── behavior 9: update command + stale registry → no warning ────────────────

test("update command does not emit stale integration warning", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const registryPath = join(dir, "integrations.json");
    writeRegistry(registryPath, [{ tool: "claude", version: "1.0.0" }]);
    // update will fail (no network), but the failure message must not be the warning
    const result = await runTraceCliAsync(
      ["update"],
      {
        HOME: dir,
        TRACE_REGISTRY_PATH: registryPath,
        TRACE_CURRENT_VERSION: "2.0.0",
      },
      dir,
    );
    expect(result.stderr).not.toMatch(/warning.*out of date/i);
  } finally {
    cleanup();
  }
});

// ─── behavior 10: setup --yes updates registry version, clearing the warning ──

test("running setup --yes updates registry version so warning disappears", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const registryPath = join(dir, "integrations.json");
    const claudeRoot = join(dir, ".claude");

    // Registry has a stale version.
    writeRegistry(registryPath, [
      { tool: "claude", version: "0.0.1", root: claudeRoot },
    ]);

    // Warning is present before setup (real installed version differs from "0.0.1").
    const warnBefore = checkUpdateWarning({ TRACE_REGISTRY_PATH: registryPath });
    expect(warnBefore).toMatch(/warning/i);

    // Run setup --yes to reconcile and re-record the current version.
    const setupResult = await runTraceCliAsync(
      ["setup", "--tool", "claude", "--yes"],
      {
        HOME: dir,
        TRACE_REGISTRY_PATH: registryPath,
        TRACE_CLI_PATH: "/usr/local/bin/trace",
        CLAUDE_CONFIG_DIR: claudeRoot,
      },
      dir,
    );
    expect(setupResult.exitCode).toBe(0);

    // Warning is gone after setup stamps the current version into the registry.
    const warnAfter = checkUpdateWarning({ TRACE_REGISTRY_PATH: registryPath });
    expect(warnAfter).toBe("");
  } finally {
    cleanup();
  }
});
