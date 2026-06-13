import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

export const PINNED_COMMAND_PATTERN =
  /npx @arielbk\/trace@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?/;

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
 * Walk `dir` recursively and call `visit` for every regular file found.
 */
function walkFiles(dir: string, visit: (absolutePath: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(abs, visit);
    } else if (entry.isFile()) {
      visit(abs);
    }
  }
}

/**
 * Scan `skills/**` and `hooks/` for files that contain a pinned
 * `npx @arielbk/trace@x.y.z` command. Returns the absolute paths of every
 * matching file. The result drives version-stamping and drift checks so the
 * list never needs to be maintained by hand.
 */
export function discoverPinnedFiles(repoRoot: string): string[] {
  const found: string[] = [];

  const collect = (abs: string) => {
    const content = readFileSync(abs, "utf8");
    if (PINNED_COMMAND_PATTERN.test(content)) {
      found.push(abs);
    }
  };

  walkFiles(resolve(repoRoot, "skills"), collect);
  walkFiles(resolve(repoRoot, "hooks"), collect);

  return found.sort();
}

/** A single derived artifact: a repo-relative path and its exact intended content. */
export type DerivedArtifact = {
  relPath: string;
  content: string;
};

/** Default list of JSON manifests whose `version` field should be stamped. */
export const DEFAULT_VERSIONED_MANIFEST_REL_PATHS = [
  "codex/.codex-plugin/plugin.json",
];

const PINNED_COMMAND_GLOBAL_PATTERN =
  /npx @arielbk\/trace@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?/g;

/**
 * Compute the full set of derived artifacts for a given target version.
 * Pure read — returns repo-relative paths and intended file contents without
 * touching disk. Covers:
 *   1. The Codex skills tree (override applied for skills with SKILL.codex.md)
 *   2. Every pinned file discovered by `discoverPinnedFiles`, stamped to `version`
 *   3. Versioned JSON manifests (plugin.json etc) with their version field set
 */
export function compute(
  repoRoot: string,
  version: string,
  opts?: { manifestRelPaths?: string[] },
): DerivedArtifact[] {
  const artifacts: DerivedArtifact[] = [];

  // 1. Codex skills tree
  for (const skill of computeCodexSkills(repoRoot)) {
    artifacts.push({ relPath: skill.relPath, content: skill.content });
  }

  // 2. Pinned files stamped to the target version
  for (const absPath of discoverPinnedFiles(repoRoot)) {
    const relPath = relative(repoRoot, absPath);
    const source = readFileSync(absPath, "utf8");
    const stamped = source.replace(
      PINNED_COMMAND_GLOBAL_PATTERN,
      `npx @arielbk/trace@${version}`,
    );
    artifacts.push({ relPath, content: stamped });
  }

  // 3. Versioned JSON manifests
  const manifestRelPaths =
    opts?.manifestRelPaths ?? DEFAULT_VERSIONED_MANIFEST_REL_PATHS;
  for (const relPath of manifestRelPaths) {
    const absPath = resolve(repoRoot, relPath);
    const manifest = JSON.parse(readFileSync(absPath, "utf8")) as Record<
      string,
      unknown
    >;
    manifest["version"] = version;
    artifacts.push({
      relPath,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    });
  }

  return artifacts;
}

/**
 * Write all derived artifacts to disk in two phases:
 *   1. Stamp pinned source files and manifests (modifies sources on disk)
 *   2. Re-derive Codex skills from the freshly-stamped sources and write them
 *
 * Two phases are required because the Codex skills tree is generated verbatim
 * from the source skill files. If we wrote both in one pass, the Codex skills
 * would be copies of the pre-stamp sources. Writing sources first and then
 * re-deriving the Codex tree ensures both agree at the target version.
 *
 * Wipes the Codex skills tree first so removed skills don't linger.
 * Returns the absolute paths written.
 */
export function renderArtifacts(
  repoRoot: string,
  version: string,
  opts?: { manifestRelPaths?: string[] },
): string[] {
  rmSync(resolve(repoRoot, CODEX_SKILLS_DIR), { recursive: true, force: true });

  const artifacts = compute(repoRoot, version, opts);
  const written: string[] = [];

  // Phase 1: write pinned files and manifests so source files are stamped
  for (const artifact of artifacts) {
    if (!artifact.relPath.startsWith(`${CODEX_SKILLS_DIR}/`)) {
      const absolutePath = resolve(repoRoot, artifact.relPath);
      mkdirSync(resolve(absolutePath, ".."), { recursive: true });
      writeFileSync(absolutePath, artifact.content);
      written.push(absolutePath);
    }
  }

  // Phase 2: re-derive Codex skills from the now-stamped sources and write them
  for (const skill of computeCodexSkills(repoRoot)) {
    const absolutePath = resolve(repoRoot, skill.relPath);
    mkdirSync(resolve(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, skill.content);
    written.push(absolutePath);
  }

  return written;
}

/**
 * Report all artifacts (from `compute`) whose on-disk content does not match
 * what `compute` would produce — missing, stale, or extra Codex skills. Empty
 * means the on-disk tree exactly matches the compute output.
 */
export function findArtifactDrift(
  repoRoot: string,
  version: string,
  opts?: { manifestRelPaths?: string[] },
): string[] {
  const artifacts = compute(repoRoot, version, opts);
  const drift: string[] = [];
  const expectedRelPaths = new Set(artifacts.map((a) => a.relPath));

  for (const artifact of artifacts) {
    const absolutePath = resolve(repoRoot, artifact.relPath);
    if (
      !existsSync(absolutePath) ||
      readFileSync(absolutePath, "utf8") !== artifact.content
    ) {
      drift.push(artifact.relPath);
    }
  }

  // Extra skills in the Codex tree not produced by compute.
  const codexSkillsRoot = resolve(repoRoot, CODEX_SKILLS_DIR);
  if (existsSync(codexSkillsRoot)) {
    for (const entry of readdirSync(codexSkillsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const relPath = `${CODEX_SKILLS_DIR}/${entry.name}/${SKILL_FILE}`;
        if (!expectedRelPaths.has(relPath)) {
          drift.push(relPath);
        }
      }
    }
  }

  return drift;
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
