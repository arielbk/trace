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
  discoverPinnedFiles,
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

describe("discoverPinnedFiles", () => {
  function makeTree(
    root: string,
    files: Record<string, string>,
  ) {
    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(root, relPath);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
  }

  it("finds files in skills/** that contain the pinned command", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-pin-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "Use `npx @arielbk/trace@1.2.3` to run.\n",
        "skills/recall/SKILL.md": "Use `npx @arielbk/trace@1.2.3` here.\n",
        "skills/board/SKILL.md": "No pin in this file.\n",
      });

      const found = discoverPinnedFiles(root);
      const relFound = found.map((p) => p.replace(root + "/", "")).sort();
      assert.deepEqual(relFound, [
        "skills/recall/SKILL.md",
        "skills/trace/SKILL.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds hooks/hooks.json when it contains a pin", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-pin-"));
    try {
      makeTree(root, {
        "hooks/hooks.json": JSON.stringify({
          hooks: [{ command: "npx @arielbk/trace@1.2.3 trace" }],
        }),
        "skills/trace/SKILL.md": "No pin.\n",
      });

      const found = discoverPinnedFiles(root);
      const relFound = found.map((p) => p.replace(root + "/", "")).sort();
      assert.deepEqual(relFound, ["hooks/hooks.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers a newly added skill automatically — no registration needed", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-pin-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "Use `npx @arielbk/trace@1.2.3` to run.\n",
      });

      const before = discoverPinnedFiles(root);

      // Add a brand new skill with a pin — no registration anywhere.
      makeTree(root, {
        "skills/new-skill/SKILL.md": "Run with `npx @arielbk/trace@1.2.3 new-skill`.\n",
      });

      const after = discoverPinnedFiles(root);
      assert.equal(after.length, before.length + 1);
      assert.ok(
        after.some((p) => p.endsWith("new-skill/SKILL.md")),
        "new skill SKILL.md was automatically discovered",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds both skills/** and hooks/ pins together", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-pin-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "Use `npx @arielbk/trace@1.2.3`.\n",
        "skills/trace/SKILL.codex.md": "Also `npx @arielbk/trace@1.2.3`.\n",
        "skills/no-pin/SKILL.md": "No pin here.\n",
        "hooks/hooks.json": '{"cmd":"npx @arielbk/trace@1.2.3 trace"}',
      });

      const found = discoverPinnedFiles(root);
      const relFound = found.map((p) => p.replace(root + "/", "")).sort();
      assert.deepEqual(relFound, [
        "hooks/hooks.json",
        "skills/trace/SKILL.codex.md",
        "skills/trace/SKILL.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
