import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rootPackage = join(repoRoot, "package.json");
const skillsRoot = join(repoRoot, "skills");
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
const recallSkill = join(skillsRoot, "recall", "SKILL.md");
const reenterSkill = join(skillsRoot, "reenter", "SKILL.md");
const boardSkill = join(skillsRoot, "board", "SKILL.md");
const docPlacementSkill = join(skillsRoot, "doc-placement", "SKILL.md");
const stateSkill = join(skillsRoot, "state", "SKILL.md");
const pluginBinDir = join(repoRoot, "bin");

/** Persistent global CLI invocation used by skills and hooks after cutover. */
function bareTraceCommand(): string {
  return "trace";
}

describe("skills scaffold", () => {
  it("ships skills that invoke the bare CLI", () => {
    const packageJson = JSON.parse(readFileSync(rootPackage, "utf8")) as {
      type?: string;
    };
    assert.equal(packageJson.type, "module");

    for (const skill of [
      traceSkill,
      recallSkill,
      reenterSkill,
      boardSkill,
      docPlacementSkill,
      stateSkill,
    ]) {
      const skillSource = readFileSync(skill, "utf8");
      assert.equal(skillSource.includes(bareTraceCommand()), true);
      assert.equal(
        skillSource.includes("${CLAUDE_PLUGIN_ROOT}/bin/trace.js"),
        false,
      );
      assert.equal(skillSource.includes("pnpm link --global"), false);
      assert.equal(
        /npx @arielbk\/trace@[0-9]/.test(skillSource),
        false,
        `${skill} must not contain a pinned npx @arielbk/trace command`,
      );
    }

    assert.equal(existsSync(pluginBinDir), false);
  });

  it("contains no versioned npx @arielbk/trace pins in the skills tree", () => {
    const markdownFiles = readdirSync(skillsRoot, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(entry.parentPath, entry.name));
    assert.equal(markdownFiles.length > 0, true);

    for (const file of markdownFiles) {
      const source = readFileSync(file, "utf8");
      const pins = source.match(/@arielbk\/trace@[0-9][0-9a-z.-]*/g) ?? [];
      assert.deepEqual(pins, [], `unexpected versioned pin in ${file}`);
    }
  });

  it("ships no plugin-install manifests, which trace setup replaced", () => {
    // The marketplace/plugin install channel was retired in favour of a global
    // CLI install plus `trace setup`, which copies this same tree into each
    // agent's config root. The manifests outlived their channel by four
    // releases, drifting to a version string nothing bumped. If one comes back
    // it needs a story for how it stays in sync — hence this guard.
    for (const retired of [
      join(repoRoot, ".claude-plugin"),
      join(repoRoot, ".agents", "plugins"),
      join(repoRoot, "plugin"),
      // Duplicated the hook definitions that setup-operations.ts now owns.
      join(repoRoot, "hooks"),
    ]) {
      assert.equal(existsSync(retired), false, `${retired} should not exist`);
    }
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
    const source = readFileSync(join(repoRoot, "README.md"), "utf8");
    assert.match(source, /### Copilot CLI/);
    assert.match(source, /trace setup --tool copilot/);
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

    // It fetches the candidate pool from the persistent CLI, never invents matches.
    assert.equal(source.includes(bareTraceCommand()), true);
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

    // It re-enters via the persistent CLI's skill re-enter verb.
    assert.equal(source.includes(bareTraceCommand()), true);
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
    assert.match(source, /lastWorkedOn:/);
    assert.match(source, /last worked on/i);
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

    // It starts the web UI via the persistent CLI's serve verb.
    assert.equal(source.includes(bareTraceCommand()), true);
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

  it("ships a state skill that authors a concise snapshot without empty placeholders", () => {
    assert.equal(existsSync(stateSkill), true);

    const source = readFileSync(stateSkill, "utf8");

    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source);
    const meta = frontmatter?.[1];
    assert.equal(typeof meta, "string");
    assert.match(meta as string, /^name:\s*trace-state\s*$/m);

    assert.match(source, /## Current state/);
    assert.match(source, /## Next step/);
    assert.match(source, /omit/i);
    assert.match(source, /question/i);
    assert.equal(source.includes("## Decisions made"), false);
    assert.equal(source.includes("## Open questions"), false);
    assert.equal(/write [`'"]none[`'"]/i.test(source), false);
  });
});
