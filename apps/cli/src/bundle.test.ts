import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const packageJsonPath = join(appRoot, "package.json");
const traceBundle = join(appRoot, "dist", "trace.js");
const hookBundle = join(appRoot, "dist", "claude-session-start-hook.js");
const subagentHookBundle = join(
  appRoot,
  "dist",
  "claude-subagent-stop-hook.js",
);
const distWebAssetsDir = join(appRoot, "dist", "web");

describe("CLI bundle", () => {
  it("build emits tsup-generated self-contained CLI and hook JS bundles", () => {
    rmSync(join(appRoot, "dist"), { recursive: true, force: true });

    execFileSync("pnpm", ["--filter", "@arielbk/trace", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    const buildScript = packageJson.scripts.build;
    if (typeof buildScript !== "string") {
      throw new Error("Expected package.json scripts.build to be a string");
    }
    assert.match(buildScript, /\btsup\b/);
    assert.doesNotMatch(buildScript, /src\/build\.ts/);

    for (const artifact of [traceBundle, hookBundle, subagentHookBundle]) {
      assert.equal(existsSync(artifact), true);
      assert.notEqual(statSync(artifact).mode & 0o111, 0);
      const source = readFileSync(artifact, "utf8");
      assert.equal(source.includes("@trace/core"), false);
      assert.equal(source.includes("better-sqlite3"), false);
      assert.equal(source.includes("0002_session_model"), true);
    }
    assert.equal(
      readFileSync(traceBundle, "utf8").startsWith("#!/usr/bin/env node"),
      true,
    );
  });

  it("build copies web assets next to the CLI bundle", () => {
    execFileSync("pnpm", ["--filter", "@arielbk/trace", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    const indexPath = join(distWebAssetsDir, "index.html");
    assert.equal(existsSync(indexPath), true);
    assert.equal(
      readFileSync(indexPath, "utf8").includes("<!doctype html"),
      true,
    );
  });

  it("bundled CLI runs outside the source tree and applies migrations", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "trace-bundle-home-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "trace-bundle-outside-"));
    const traceDb = join(fakeHome, "trace.sqlite");
    const outsideTraceBundle = join(outsideDir, "trace.js");
    copyFileSync(traceBundle, outsideTraceBundle);

    try {
      const output = execFileSync(
        process.execPath,
        [
          outsideTraceBundle,
          "skill",
          "work-on-task",
          "bundle smoke task",
          "--id",
          "bundle-session",
          "--transcript",
          join(outsideDir, "session.jsonl"),
          "--tool",
          "codex",
        ],
        {
          cwd: outsideDir,
          encoding: "utf8",
          env: { ...process.env, HOME: fakeHome, TRACE_DB: traceDb },
        },
      );

      assert.equal(output.includes("bundle-session\tcodex"), true);
      assert.equal(output.includes("taskDocsDir:"), true);

      const listed = execFileSync(
        process.execPath,
        [traceBundle, "task", "list"],
        {
          cwd: outsideDir,
          encoding: "utf8",
          env: { ...process.env, HOME: fakeHome, TRACE_DB: traceDb },
        },
      );
      assert.equal(listed.includes("bundle smoke task"), true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("bundled hook runs outside the source tree", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "trace-bundle-init-home-"));
    const outsideDir = mkdtempSync(
      join(tmpdir(), "trace-bundle-init-outside-"),
    );
    const traceDb = join(fakeHome, "trace.sqlite");
    const outsideHookBundle = join(outsideDir, "claude-session-start-hook.js");
    const transcriptPath = join(outsideDir, "session.jsonl");
    copyFileSync(hookBundle, outsideHookBundle);

    try {
      const output = execFileSync(process.execPath, [outsideHookBundle], {
        input: JSON.stringify({
          session_id: "hook-bundle-session",
          transcript_path: transcriptPath,
          hook_event_name: "SessionStart",
          cwd: outsideDir,
        }),
        cwd: outsideDir,
        encoding: "utf8",
        env: { ...process.env, HOME: fakeHome, TRACE_DB: traceDb },
      });

      assert.equal(
        output.includes("Trace: no task is bound to this session"),
        true,
      );
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("bundled SubagentStop hook runs outside the source tree", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "trace-subagent-bundle-home-"));
    const outsideDir = mkdtempSync(
      join(tmpdir(), "trace-subagent-bundle-outside-"),
    );
    const traceDb = join(fakeHome, "trace.sqlite");
    const outsideHookBundle = join(outsideDir, "claude-subagent-stop-hook.js");
    const parentTranscriptPath = join(outsideDir, "parent.jsonl");
    copyFileSync(subagentHookBundle, outsideHookBundle);

    try {
      execFileSync(
        process.execPath,
        [
          traceBundle,
          "session",
          "register",
          "--id",
          "parent-session",
          "--transcript",
          parentTranscriptPath,
          "--tool",
          "claude",
        ],
        {
          cwd: outsideDir,
          encoding: "utf8",
          env: { ...process.env, HOME: fakeHome, TRACE_DB: traceDb },
        },
      );

      const output = execFileSync(process.execPath, [outsideHookBundle], {
        input: JSON.stringify({
          session_id: "parent-session",
          transcript_path: parentTranscriptPath,
          hook_event_name: "SubagentStop",
        }),
        cwd: outsideDir,
        encoding: "utf8",
        env: { ...process.env, HOME: fakeHome, TRACE_DB: traceDb },
      });

      assert.equal(output, "");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
