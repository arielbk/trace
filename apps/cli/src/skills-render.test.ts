import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  computeCodexSkills,
  findCodexSkillDrift,
  renderCodexSkills,
} from "./skills-render.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function makeSkill(root: string, name: string, files: Record<string, string>) {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
}

describe("Codex skill render", () => {
  it("the committed codex/skills tree matches a render of the Claude tree", () => {
    // Anti-drift guard: if anyone edits a skill under skills/ without
    // regenerating codex/skills/, this fails. Run the render to fix it.
    assert.deepEqual(
      findCodexSkillDrift(repoRoot),
      [],
      "codex/skills/ is out of sync with skills/ — regenerate with renderCodexSkills",
    );
  });

  it("copies host-agnostic skills verbatim and applies the Codex override for trace", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-skills-"));
    try {
      makeSkill(root, "board", { "SKILL.md": "# board\nclaude wording\n" });
      makeSkill(root, "trace", {
        "SKILL.md": "# trace\nCLAUDE_CODE_SESSION_ID\n",
        "SKILL.codex.md": "# trace\nCODEX_THREAD_ID\n",
      });

      const skills = computeCodexSkills(root);
      const byName = new Map(skills.map((s) => [s.name, s]));

      assert.deepEqual(
        skills.map((s) => s.name),
        ["board", "trace"],
        "skills are discovered and sorted by name",
      );

      assert.equal(byName.get("board")?.fromOverride, false);
      assert.equal(byName.get("board")?.content, "# board\nclaude wording\n");
      assert.equal(
        byName.get("board")?.relPath,
        "codex/skills/board/SKILL.md",
      );

      assert.equal(byName.get("trace")?.fromOverride, true);
      assert.equal(byName.get("trace")?.content, "# trace\nCODEX_THREAD_ID\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders to disk and prunes skills removed from the Claude tree", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-skills-"));
    try {
      makeSkill(root, "board", { "SKILL.md": "# board\n" });
      // A stale Codex skill with no Claude counterpart must be pruned.
      mkdirSync(join(root, "codex", "skills", "ghost"), { recursive: true });
      writeFileSync(join(root, "codex", "skills", "ghost", "SKILL.md"), "old\n");

      const written = renderCodexSkills(root);

      assert.deepEqual(written, [join(root, "codex/skills/board/SKILL.md")]);
      assert.equal(
        readFileSync(join(root, "codex/skills/board/SKILL.md"), "utf8"),
        "# board\n",
      );
      // The render is idempotent and self-consistent.
      assert.deepEqual(findCodexSkillDrift(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
