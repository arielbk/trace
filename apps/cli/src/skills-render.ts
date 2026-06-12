import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

// The Claude skills tree (skills/) is the canonical source for every skill.
// The Codex skills tree (codex/skills/) is generated from it, so the two can
// never drift. Most skills are host-agnostic and copy verbatim; a skill that
// needs Codex-specific wording ships a SKILL.codex.md override beside its
// SKILL.md, and the override wins for the Codex render.
export const CLAUDE_SKILLS_DIR = "skills";
export const CODEX_SKILLS_DIR = "codex/skills";
const SKILL_FILE = "SKILL.md";
const CODEX_OVERRIDE_FILE = "SKILL.codex.md";

export type CodexSkillFile = {
  /** Repo-relative path of the generated Codex skill, e.g. codex/skills/trace/SKILL.md */
  relPath: string;
  /** Skill directory name, e.g. "trace" */
  name: string;
  /** Rendered SKILL.md content */
  content: string;
  /** Whether this skill used a Codex-specific SKILL.codex.md override */
  fromOverride: boolean;
};

function listSkillNames(repoRoot: string): string[] {
  const claudeSkillsRoot = resolve(repoRoot, CLAUDE_SKILLS_DIR);
  return readdirSync(claudeSkillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      existsSync(resolve(claudeSkillsRoot, name, SKILL_FILE)),
    )
    .sort();
}

/**
 * Compute the full Codex skills tree from the canonical Claude skills tree.
 * Pure read — does not touch the Codex tree on disk. Both the renderer and the
 * drift check build on this so they agree by construction.
 */
export function computeCodexSkills(repoRoot: string): CodexSkillFile[] {
  const claudeSkillsRoot = resolve(repoRoot, CLAUDE_SKILLS_DIR);

  return listSkillNames(repoRoot).map((name) => {
    const overridePath = resolve(claudeSkillsRoot, name, CODEX_OVERRIDE_FILE);
    const fromOverride = existsSync(overridePath);
    const sourcePath = fromOverride
      ? overridePath
      : resolve(claudeSkillsRoot, name, SKILL_FILE);

    return {
      relPath: `${CODEX_SKILLS_DIR}/${name}/${SKILL_FILE}`,
      name,
      content: readFileSync(sourcePath, "utf8"),
      fromOverride,
    };
  });
}

/**
 * Regenerate codex/skills/ from skills/. Wipes the existing Codex skills tree
 * first so a skill deleted from the Claude tree does not linger in Codex.
 * Returns the absolute paths written.
 */
export function renderCodexSkills(repoRoot: string): string[] {
  const codexSkillsRoot = resolve(repoRoot, CODEX_SKILLS_DIR);
  const files = computeCodexSkills(repoRoot);

  rmSync(codexSkillsRoot, { recursive: true, force: true });

  const written: string[] = [];
  for (const file of files) {
    const absolutePath = resolve(repoRoot, file.relPath);
    mkdirSync(resolve(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, file.content);
    written.push(absolutePath);
  }
  return written;
}

/**
 * Report Codex skill files whose committed content does not match what the
 * renderer would produce (missing, stale, or extra). Empty array means the
 * Codex tree is exactly the render of the Claude tree. Used by the test suite
 * as the anti-drift guard.
 */
export function findCodexSkillDrift(repoRoot: string): string[] {
  const expected = computeCodexSkills(repoRoot);
  const drift: string[] = [];

  for (const file of expected) {
    const absolutePath = resolve(repoRoot, file.relPath);
    if (
      !existsSync(absolutePath) ||
      readFileSync(absolutePath, "utf8") !== file.content
    ) {
      drift.push(file.relPath);
    }
  }

  // Extra skills present in the Codex tree but not produced by the renderer.
  const codexSkillsRoot = resolve(repoRoot, CODEX_SKILLS_DIR);
  if (existsSync(codexSkillsRoot)) {
    const expectedNames = new Set(expected.map((file) => file.name));
    for (const entry of readdirSync(codexSkillsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !expectedNames.has(entry.name)) {
        drift.push(`${CODEX_SKILLS_DIR}/${entry.name}/${SKILL_FILE}`);
      }
    }
  }

  return drift;
}
