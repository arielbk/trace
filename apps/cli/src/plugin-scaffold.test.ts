import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliPackageJson = join(appRoot, "package.json");
const pluginManifest = join(repoRoot, ".claude-plugin", "plugin.json");
const codexPluginManifest = join(
  repoRoot,
  "plugin",
  ".codex-plugin",
  "plugin.json",
);
const codexMarketplaceManifest = join(
  repoRoot,
  ".agents",
  "plugins",
  "marketplace.json",
);
const rootPackage = join(repoRoot, "package.json");
const hooksConfig = join(repoRoot, "hooks", "hooks.json");
const skillsRoot = join(repoRoot, "plugin", "skills");
const traceSkill = join(skillsRoot, "trace", "SKILL.md");
const traceClaudeResource = join(skillsRoot, "trace", "resources", "claude.md");
const traceCodexResource = join(skillsRoot, "trace", "resources", "codex.md");
const traceCursorResource = join(skillsRoot, "trace", "resources", "cursor.md");
const traceCopilotResource = join(
  skillsRoot,
  "trace",
  "resources",
  "copilot.md",
);
const readme = join(repoRoot, "README.md");
const recallSkill = join(skillsRoot, "recall", "SKILL.md");
const reenterSkill = join(skillsRoot, "reenter", "SKILL.md");
const boardSkill = join(skillsRoot, "board", "SKILL.md");
const docPlacementSkill = join(skillsRoot, "doc-placement", "SKILL.md");
const stateSkill = join(skillsRoot, "state", "SKILL.md");
const pluginBinDir = join(repoRoot, "bin");
const copilotPluginRoot = join(repoRoot, "plugin");
const copilotPluginManifest = join(copilotPluginRoot, "plugin.json");
const copilotHooksConfig = join(copilotPluginRoot, "hooks", "hooks.json");

function pinnedTraceCommand(): string {
  const packageJson = JSON.parse(readFileSync(cliPackageJson, "utf8")) as {
    name?: string;
    version?: string;
  };
  return `npx ${packageJson.name}@${packageJson.version}`;
}

describe("plugin scaffold", () => {
  it("ships a Copilot CLI plugin with lifecycle hooks and a binding nudge", () => {
    const manifest = JSON.parse(
      readFileSync(copilotPluginManifest, "utf8"),
    ) as {
      name?: string;
      version?: string;
      description?: string;
    };
    assert.equal(manifest.name, "trace");
    assert.equal(typeof manifest.version, "string");
    assert.equal(typeof manifest.description, "string");

    const hooks = JSON.parse(readFileSync(copilotHooksConfig, "utf8")) as {
      version?: number;
      hooks?: Record<string, Array<Record<string, string>>>;
    };
    assert.equal(hooks.version, 1);
    assert.deepEqual(hooks.hooks?.sessionStart, [
      {
        type: "command",
        bash: `${pinnedTraceCommand()} hook session-start`,
        powershell: `${pinnedTraceCommand()} hook session-start`,
      },
      {
        type: "prompt",
        prompt:
          "Consult the installed Trace skill before beginning work. If this session is not bound, use Trace to bind or re-enter the task.",
      },
    ]);
    assert.deepEqual(hooks.hooks?.agentStop, [
      {
        type: "command",
        bash: `${pinnedTraceCommand()} hook stop`,
        powershell: `${pinnedTraceCommand()} hook stop`,
      },
    ]);
    assert.deepEqual(hooks.hooks?.subagentStop, [
      {
        type: "command",
        bash: `${pinnedTraceCommand()} hook subagent-stop`,
        powershell: `${pinnedTraceCommand()} hook subagent-stop`,
      },
    ]);

    const skill = readFileSync(traceSkill, "utf8");
    assert.match(skill, /^---\nname:\s*trace\s*$/m);
    assert.equal(skill.includes(pinnedTraceCommand()), true);
  });

  it("ships a Claude Code plugin manifest, hook, and skills pinned to the npm CLI", () => {
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
    // The canonical skills tree lives one level down, under plugin/skills/, so
    // the one physical tree can also serve as the Codex plugin's ./skills/.
    assert.equal(manifest.skills, "./plugin/skills/");
    // The conventional hooks/hooks.json is auto-loaded; referencing it from the
    // manifest causes a duplicate-hooks load error in Claude Code.
    assert.equal(manifest.hooks, undefined);

    const hooks = JSON.parse(readFileSync(hooksConfig, "utf8")) as {
      hooks?: {
        SessionStart?: Array<{
          matcher?: string;
          hooks?: Array<{ type?: string; command?: string }>;
        }>;
        SubagentStop?: Array<{
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
            command: `${pinnedTraceCommand()} hook session-start`,
          },
        ],
      },
    ]);
    assert.deepEqual(hooks.hooks?.SubagentStop, [
      {
        hooks: [
          {
            type: "command",
            command: `${pinnedTraceCommand()} hook subagent-stop`,
          },
        ],
      },
    ]);

    for (const skill of [
      traceSkill,
      recallSkill,
      reenterSkill,
      boardSkill,
      docPlacementSkill,
      stateSkill,
    ]) {
      const skillSource = readFileSync(skill, "utf8");
      assert.equal(skillSource.includes(pinnedTraceCommand()), true);
      assert.equal(
        skillSource.includes("${CLAUDE_PLUGIN_ROOT}/bin/trace.js"),
        false,
      );
      assert.equal(skillSource.includes("pnpm link --global"), false);
    }

    assert.equal(existsSync(pluginBinDir), false);
  });

  it("pins every trace command in the skills tree to the current CLI version", () => {
    // Guard against a stale pin surviving a release bump in ONE spot (the
    // `includes(pinnedTraceCommand())` checks above can't see an extra,
    // older pin sitting elsewhere in the same file).
    const markdownFiles = readdirSync(skillsRoot, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(entry.parentPath, entry.name));
    assert.equal(markdownFiles.length > 0, true);

    for (const file of markdownFiles) {
      const source = readFileSync(file, "utf8");
      for (const pin of source.match(/@arielbk\/trace@[0-9][0-9a-z.-]*/g) ??
        []) {
        assert.equal(
          `npx ${pin}`,
          pinnedTraceCommand(),
          `stale trace pin in ${file}: ${pin}`,
        );
      }
    }
  });

  it("shares one skills tree between the Claude and Codex plugins via a nested path", () => {
    const manifest = JSON.parse(readFileSync(codexPluginManifest, "utf8")) as {
      name?: string;
      version?: string;
      description?: string;
      skills?: string;
    };
    assert.equal(manifest.name, "trace");
    assert.equal(typeof manifest.version, "string");
    assert.equal(typeof manifest.description, "string");
    // The Codex plugin root is the ./plugin subdir, which holds the one
    // canonical skills tree at ./skills/ — the same tree the Claude manifest
    // reaches via the nested ./plugin/skills/ path. No generated mirror.
    assert.equal(manifest.skills, "./skills/");

    const marketplace = JSON.parse(
      readFileSync(codexMarketplaceManifest, "utf8"),
    ) as {
      name?: string;
      plugins?: Array<{
        name?: string;
        source?: { source?: string; path?: string };
      }>;
    };
    assert.equal(marketplace.name, "trace");
    assert.equal(marketplace.plugins?.length, 1);
    assert.equal(marketplace.plugins?.[0]?.name, "trace");
    assert.equal(marketplace.plugins?.[0]?.source?.source, "local");

    // Regression guard: Codex silently drops a plugin whose source.path is the
    // marketplace root ("./") — it requires a subdirectory carrying its own
    // .codex-plugin/plugin.json. The shared plugin root is ./plugin, and the
    // canonical skills tree lives inside it so Codex's copy-on-install reaches
    // it without an escaping path.
    const pluginPath = marketplace.plugins?.[0]?.source?.path;
    assert.equal(pluginPath, "./plugin");
    assert.notEqual(pluginPath, "./");
    assert.equal(
      existsSync(
        join(repoRoot, pluginPath as string, ".codex-plugin", "plugin.json"),
      ),
      true,
    );
    assert.equal(
      existsSync(
        join(repoRoot, pluginPath as string, "skills", "trace", "SKILL.md"),
      ),
      true,
    );
  });

  it("ships a host-neutral trace skill that dispatches to per-host resources", () => {
    const source = readFileSync(traceSkill, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source);
    const meta = frontmatter?.[1];
    assert.equal(typeof meta, "string");
    assert.match(meta as string, /^name:\s*trace\s*$/m);
    assert.match(meta as string, /^description:\s*.+$/m);
    // The description must not be hard-bound to one host — it triggers in both.
    assert.equal((meta as string).includes("Claude Code session"), false);

    // The dispatcher carries the shared verb and points at every host resource.
    assert.match(source, /skill work-on-task/);
    assert.match(source, /resources\/claude\.md/);
    assert.match(source, /resources\/codex\.md/);
    assert.match(source, /resources\/cursor\.md/);
    assert.match(source, /resources\/copilot\.md/);
    // Re-entry is delegated to the trace-reenter skill, not inlined here.
    assert.match(source, /trace-reenter/);

    // Claude resource: the SessionStart nudge flow and Claude session env var.
    const claude = readFileSync(traceClaudeResource, "utf8");
    assert.match(claude, /no active task/i);
    assert.match(claude, /CLAUDE_CODE_SESSION_ID/);
    assert.equal(claude.includes("CODEX_THREAD_ID"), false);

    // Codex resource: backfill scan and Codex thread env vars.
    const codex = readFileSync(traceCodexResource, "utf8");
    assert.match(codex, /session scan --codex/);
    assert.match(codex, /CODEX_THREAD_ID/);
    assert.match(codex, /CODEX_TRANSCRIPT_PATH/);
    assert.equal(codex.includes("CLAUDE_CODE_SESSION_ID"), false);

    // Cursor resource: cwd-based session inference, no env var to name.
    const cursor = readFileSync(traceCursorResource, "utf8");
    assert.match(cursor, /directory the command runs in/i);
    assert.match(cursor, /pull-time/i);
    assert.equal(cursor.includes("CLAUDE_CODE_SESSION_ID"), false);
    assert.equal(cursor.includes("CODEX_THREAD_ID"), false);

    // Copilot resource: hooks pre-register live sessions, while the locator
    // infers identity from the nearest Copilot process rather than env vars.
    const copilot = readFileSync(traceCopilotResource, "utf8");
    assert.match(copilot, /sessionStart/i);
    assert.match(copilot, /agentStop/i);
    assert.match(copilot, /lock/i);
    assert.match(copilot, /re-enter/i);
    assert.equal(copilot.includes("COPILOT_SESSION_ID"), false);

    // No host-specific CLI plumbing leaks into the shared tree.
    for (const text of [source, claude, codex, cursor, copilot]) {
      assert.equal(text.includes("CLAUDE_PLUGIN_ROOT"), false);
      assert.equal(text.includes("<trace-plugin-root>"), false);
    }
  });

  it("documents Copilot CLI installation and its output-only token total", () => {
    const source = readFileSync(readme, "utf8");
    assert.match(source, /### Copilot CLI/);
    assert.match(source, /copilot plugin install .*plugin/);
    assert.match(source, /output-only token/i);
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

    // It fetches the candidate pool from the pinned npm CLI, never invents matches.
    assert.equal(source.includes(pinnedTraceCommand()), true);
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

    // It re-enters via the pinned npm CLI's skill re-enter verb.
    assert.equal(source.includes(pinnedTraceCommand()), true);
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
    // The protocol is host-agnostic — the skill names all three hosts rather
    // than deferring any of them.
    assert.match(source, /Claude Code, Codex, or Cursor/);

    // The re-enter command binds atomically: callers must NOT issue a separate
    // work-on-task bind. This is the contract recall delegates to.
    assert.match(source, /atomic/i);
    assert.match(source, /(do not|don't|no)[\s\S]{0,80}work-on-task/i);

    // It consumes the manifest's stateFreshness block — the portable prose
    // trigger for hosts without a live Stop hook: orient first, then invoke
    // the trace-state skill (which stamps via `trace state reflect`).
    assert.match(source, /stateFreshness/);
    assert.match(source, /orient first/i);
    assert.match(source, /trace-state/);
    assert.match(source, /trace state reflect/);
  });

  it("ships a board skill that fires only on open-the-board intent and opens the board itself", () => {
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

    // It starts the web UI via the pinned npm CLI's serve verb.
    assert.equal(source.includes(pinnedTraceCommand()), true);
    assert.match(source, /\bserve\b/);

    // The agent opens the board itself rather than instructing the user: it
    // starts serve as a background process and never asks them to run a command.
    assert.match(source, /open the board for the user yourself/i);
    assert.match(source, /never ask them to run a command/i);
    assert.match(source, /background/i);

    // Before spawning it checks the default port so a running board is reused
    // instead of duplicated.
    assert.match(source, /127\.0\.0\.1:4317/);

    // It still reads the URL off stdout and reports it to the user.
    assert.match(source, /trace serve listening on http:\/\//);
    assert.match(source, /next available port/i);
    assert.match(source, /tell the user the URL/i);
    assert.match(source, /stops the server with Ctrl-C/);
  });
});
