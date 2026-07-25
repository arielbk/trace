import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { TargetRecord, ToolName } from "./integration-registry.ts";
import { discoverTargetCandidates } from "./setup-candidates.ts";

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function registered(tool: ToolName, root: string, version = "0.15.1"): TargetRecord {
  return { tool, root, cliPath: "/opt/global/bin/trace", version, skills: [], hooks: [] };
}

test("a root that is both detected and registered keeps both provenances", () => {
  const { dir, cleanup } = tempDir("trace-candidates-both-");
  try {
    const root = join(dir, ".claude");
    mkdirSync(root, { recursive: true });

    const candidates = discoverTargetCandidates({ HOME: dir }, [
      registered("claude", root),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.detection).toEqual({ kind: "default" });
    expect(candidates[0]?.registered?.version).toBe("0.15.1");
  } finally {
    cleanup();
  }
});

test("an environment-selected root records the variable that selected it", () => {
  const { dir, cleanup } = tempDir("trace-candidates-env-");
  try {
    const claudeRoot = join(dir, "work-claude");
    const codexRoot = join(dir, "work-codex");
    mkdirSync(claudeRoot, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });

    const candidates = discoverTargetCandidates(
      { HOME: dir, CLAUDE_CONFIG_DIR: claudeRoot, CODEX_HOME: codexRoot },
      [],
    );

    expect(candidates.map((c) => [c.tool, c.detection])).toEqual([
      ["claude", { kind: "environment", variable: "CLAUDE_CONFIG_DIR" }],
      ["codex", { kind: "environment", variable: "CODEX_HOME" }],
    ]);
  } finally {
    cleanup();
  }
});

test("a registered-only root carries no detection provenance", () => {
  const { dir, cleanup } = tempDir("trace-candidates-registered-only-");
  try {
    const root = join(dir, "work-cursor");

    const candidates = discoverTargetCandidates({ HOME: dir }, [
      registered("cursor", root),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.detection).toBeUndefined();
    expect(candidates[0]?.registered?.root).toBe(root);
  } finally {
    cleanup();
  }
});

test("candidates are grouped by tool with the detected root first", () => {
  const { dir, cleanup } = tempDir("trace-candidates-order-");
  try {
    const defaultClaude = join(dir, ".claude");
    const workClaude = join(dir, "work-claude");
    const defaultCursor = join(dir, ".cursor");
    mkdirSync(defaultClaude, { recursive: true });
    mkdirSync(defaultCursor, { recursive: true });

    // Registry order deliberately interleaves tools to prove grouping is not
    // just registry order passed through.
    const candidates = discoverTargetCandidates({ HOME: dir }, [
      registered("cursor", defaultCursor),
      registered("claude", workClaude),
      registered("codex", join(dir, "work-codex")),
      registered("claude", defaultClaude),
    ]);

    expect(candidates.map((c) => `${c.tool}=${c.root}`)).toEqual([
      `claude=${defaultClaude}`,
      `claude=${workClaude}`,
      `codex=${join(dir, "work-codex")}`,
      `cursor=${defaultCursor}`,
    ]);
  } finally {
    cleanup();
  }
});

test("a conventional root is not a candidate until its directory exists", () => {
  const { dir, cleanup } = tempDir("trace-candidates-absent-");
  try {
    expect(discoverTargetCandidates({ HOME: dir }, [])).toEqual([]);
  } finally {
    cleanup();
  }
});
