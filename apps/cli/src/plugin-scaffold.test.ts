import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const pluginManifest = join(repoRoot, ".claude-plugin", "plugin.json");
const rootPackage = join(repoRoot, "package.json");
const hooksConfig = join(repoRoot, "hooks", "hooks.json");
const traceSkill = join(repoRoot, "skills", "trace", "SKILL.md");
const recallSkill = join(repoRoot, "skills", "recall", "SKILL.md");
const pluginTraceBundle = join(repoRoot, "bin", "trace.js");
const pluginHookBundle = join(repoRoot, "bin", "claude-session-start-hook.js");

describe("plugin scaffold", () => {
  it("ships a Claude Code plugin manifest, hook, skill, and bundled CLI artifacts", () => {
    rmSync(join(appRoot, "dist"), { recursive: true, force: true });
    rmSync(pluginTraceBundle, { force: true });
    rmSync(pluginHookBundle, { force: true });

    execFileSync("pnpm", ["--filter", "@trace/cli", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    const packageJson = JSON.parse(readFileSync(rootPackage, "utf8")) as {
      type?: string;
    };
    assert.equal(packageJson.type, "module");

    const manifest = JSON.parse(readFileSync(pluginManifest, "utf8")) as {
      name?: string;
      displayName?: string;
      description?: string;
      skills?: string;
      hooks?: string;
    };
    assert.equal(manifest.name, "trace");
    assert.equal(manifest.displayName, "Trace");
    assert.equal(typeof manifest.description, "string");
    assert.equal(manifest.skills, "./skills/");
    // The conventional hooks/hooks.json is auto-loaded; referencing it from the
    // manifest causes a duplicate-hooks load error in Claude Code.
    assert.equal(manifest.hooks, undefined);

    const hooks = JSON.parse(readFileSync(hooksConfig, "utf8")) as {
      hooks?: {
        SessionStart?: Array<{
          matcher?: string;
          hooks?: Array<{ type?: string; command?: string }>;
        }>;
      };
    };
    assert.deepEqual(hooks.hooks?.SessionStart, [
      {
        matcher: "startup|resume|clear|compact",
        hooks: [
          {
            type: "command",
            command:
              "node \"${CLAUDE_PLUGIN_ROOT}/bin/claude-session-start-hook.js\"",
          },
        ],
      },
    ]);

    const skillSource = readFileSync(traceSkill, "utf8");
    assert.equal(skillSource.includes("${CLAUDE_PLUGIN_ROOT}/bin/trace.js"), true);
    assert.equal(skillSource.includes("pnpm link --global"), false);

    for (const artifact of [pluginTraceBundle, pluginHookBundle]) {
      assert.equal(existsSync(artifact), true);
      assert.notEqual(statSync(artifact).mode & 0o111, 0);
      const source = readFileSync(artifact, "utf8");
      assert.equal(source.startsWith("#!/usr/bin/env node"), true);
      assert.equal(source.includes("@trace/core"), false);
      assert.equal(source.includes("better-sqlite3"), false);
    }
  });

  it("ships a trigger-tuned recall skill that resolves vague references via the candidate pool", () => {
    assert.equal(existsSync(recallSkill), true);

    const source = readFileSync(recallSkill, "utf8");

    // Frontmatter: a distinct skill name and a trigger description tuned for
    // vague references to prior work (so the model fires it on "that thing").
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source);
    const meta = frontmatter?.[1];
    assert.equal(typeof meta, "string");
    assert.match(meta as string, /^name:\s*trace-recall\s*$/m);
    assert.match(meta as string, /^description:\s*.+$/m);

    // It fetches the candidate pool from the bundled CLI, never invents matches.
    assert.equal(
      source.includes("${CLAUDE_PLUGIN_ROOT}/bin/trace.js"),
      true,
    );
    assert.equal(source.includes("skill recall-candidates"), true);

    // Confident match announces and binds via the existing work-on-task path.
    assert.equal(source.includes("work-on-task"), true);

    // Ambiguity/no-match asks with near-misses; failed recall never auto-creates.
    assert.match(source, /never\s+(auto-?create|create)/i);
  });
});
