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
const reenterSkill = join(repoRoot, "skills", "reenter", "SKILL.md");
const boardSkill = join(repoRoot, "skills", "board", "SKILL.md");
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
              'node "${CLAUDE_PLUGIN_ROOT}/bin/claude-session-start-hook.js"',
          },
        ],
      },
    ]);

    const skillSource = readFileSync(traceSkill, "utf8");
    assert.equal(
      skillSource.includes("${CLAUDE_PLUGIN_ROOT}/bin/trace.js"),
      true,
    );
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
    assert.equal(source.includes("${CLAUDE_PLUGIN_ROOT}/bin/trace.js"), true);
    assert.equal(source.includes("skill recall-candidates"), true);

    // Confident match delegates to the trace-reenter skill via skill re-enter,
    // which fetches the manifest AND binds atomically — recall no longer issues
    // a vestigial second `skill work-on-task` bind command.
    assert.match(source, /trace-reenter/);
    assert.equal(source.includes("skill re-enter"), true);
    assert.equal(source.includes("skill work-on-task"), false);

    // The manifest-consumption protocol is not restated here — it lives in
    // trace-reenter. Recall must not carry its own copy.
    assert.equal(source.includes("trace session tail"), false);

    // Ambiguity/no-match asks with near-misses; failed recall never auto-creates.
    assert.match(source, /never\s+(auto-?create|create)/i);
  });

  it("ships a re-entry skill that owns the manifest-consumption protocol and binds atomically", () => {
    assert.equal(existsSync(reenterSkill), true);

    const source = readFileSync(reenterSkill, "utf8");

    // Frontmatter: a distinct skill name and a description tuned for exact-ref
    // re-entry (the user names a slug or exact title), not vague recall.
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source);
    const meta = frontmatter?.[1];
    assert.equal(typeof meta, "string");
    assert.match(meta as string, /^name:\s*trace-reenter\s*$/m);
    assert.match(meta as string, /^description:\s*.+$/m);
    assert.match(meta as string, /slug|title/i);

    // It re-enters via the bundled CLI's skill re-enter verb.
    assert.equal(source.includes("${CLAUDE_PLUGIN_ROOT}/bin/trace.js"), true);
    assert.equal(source.includes("skill re-enter"), true);

    // The slug is the canonical ref (exact title also resolves).
    assert.match(source, /skill re-enter "break-stop-and-stale-expiry"/);

    // It owns the manifest-consumption protocol: state file first as
    // authoritative, then the decision docs, then the transcript tail as
    // fallback — the prose that used to live in the trace skill.
    assert.match(source, /state:/);
    assert.match(source, /authoritative/i);
    assert.match(source, /read the decision docs first/i);
    assert.match(source, /transcript tail/);
    assert.match(source, /mostRecent: true/);
    assert.match(source, /never paste raw transcripts/i);
    assert.match(source, /Codex entry point/);

    // The re-enter command binds atomically: callers must NOT issue a separate
    // work-on-task bind. This is the contract recall delegates to.
    assert.match(source, /atomic/i);
    assert.match(source, /(do not|don't|no)[\s\S]{0,80}work-on-task/i);
  });

  it("ships a board skill that fires only on open-the-board intent and runs serve", () => {
    assert.equal(existsSync(boardSkill), true);

    const source = readFileSync(boardSkill, "utf8");

    // Frontmatter: a distinct skill name and a description scoped to the
    // open-the-board intent only.
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source);
    const meta = frontmatter?.[1];
    assert.equal(typeof meta, "string");
    assert.match(meta as string, /^name:\s*trace-board\s*$/m);
    assert.match(meta as string, /^description:\s*.+$/m);
    assert.match(meta as string, /board/i);

    // It starts the web UI via the bundled CLI's serve verb.
    assert.equal(source.includes("${CLAUDE_PLUGIN_ROOT}/bin/trace.js"), true);
    assert.match(source, /\bserve\b/);

    // It carries the read-the-URL-off-stdout and don't-background guidance
    // lifted from the trace skill's old "Open the task board" section.
    assert.match(source, /trace serve listening on http:\/\//);
    assert.match(source, /next available port/i);
    assert.match(source, /Tell the user the URL/);
    assert.match(source, /Do not start the server in the background/);
    assert.match(source, /stops it with Ctrl-C/);
  });
});
