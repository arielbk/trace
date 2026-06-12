import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const traceBundle = join(appRoot, "dist", "trace.js");
const hookBundle = join(appRoot, "dist", "claude-session-start-hook.js");
const pluginTraceBundle = join(repoRoot, "bin", "trace.js");
const pluginWebAssetsDir = join(repoRoot, "bin", "web");

describe("CLI bundle", () => {
  it("build emits self-contained CLI and hook JS bundles", () => {
    rmSync(join(appRoot, "dist"), { recursive: true, force: true });

    execFileSync("pnpm", ["--filter", "@trace/cli", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    for (const artifact of [traceBundle, hookBundle]) {
      assert.equal(existsSync(artifact), true);
      assert.notEqual(statSync(artifact).mode & 0o111, 0);
      const source = readFileSync(artifact, "utf8");
      assert.equal(source.includes("@trace/core"), false);
      assert.equal(source.includes("better-sqlite3"), false);
      assert.equal(source.includes("0002_session_model"), true);
    }
  });

  it("build copies web assets into a tracked plugin asset directory", () => {
    execFileSync("pnpm", ["--filter", "@trace/cli", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    const indexPath = join(pluginWebAssetsDir, "index.html");
    assert.equal(existsSync(indexPath), true);
    assert.equal(
      readFileSync(indexPath, "utf8").includes("<!doctype html"),
      true,
    );

    const ignoreCheck = spawnSync(
      "git",
      ["check-ignore", "-v", "--", "bin/web/index.html"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(
      ignoreCheck.status,
      1,
      ignoreCheck.stdout + ignoreCheck.stderr,
    );
  });

  it("bundled CLI runs outside the source tree and applies migrations", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "trace-bundle-home-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "trace-bundle-outside-"));
    const traceDb = join(fakeHome, "trace.sqlite");

    try {
      const output = execFileSync(
        process.execPath,
        [
          pluginTraceBundle,
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

  it("bundled init installs the Codex skill from the plugin root", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "trace-bundle-init-home-"));
    const outsideDir = mkdtempSync(
      join(tmpdir(), "trace-bundle-init-outside-"),
    );
    const skillPath = join(fakeHome, ".agents", "skills", "trace", "SKILL.md");

    try {
      execFileSync("pnpm", ["--filter", "@trace/cli", "build"], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      const output = execFileSync(
        process.execPath,
        [pluginTraceBundle, "init"],
        {
          cwd: outsideDir,
          encoding: "utf8",
          env: { ...process.env, HOME: fakeHome },
        },
      );

      assert.equal(
        output.includes(`Codex trace skill: installed at ${skillPath}`),
        true,
      );
      assert.equal(existsSync(skillPath), true);
      const source = readFileSync(skillPath, "utf8");
      assert.equal(source.includes(`node "${pluginTraceBundle}"`), true);
      assert.equal(source.includes("<trace-plugin-root>"), false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
