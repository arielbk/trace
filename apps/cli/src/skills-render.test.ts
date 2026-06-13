import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  compute,
  computeCodexSkills,
  discoverPinnedFiles,
  findArtifactDrift,
  findCodexSkillDrift,
  renderArtifacts,
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

describe("compute", () => {
  function makeTree(root: string, files: Record<string, string>) {
    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(root, relPath);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
  }

  it("returns Codex skill with override applied for trace", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-compute-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "Claude wording `npx @arielbk/trace@0.1.0`.\n",
        "skills/trace/SKILL.codex.md": "Codex wording `npx @arielbk/trace@0.1.0`.\n",
        "codex/.codex-plugin/plugin.json": JSON.stringify({ name: "trace", version: "0.1.0" }, null, 2) + "\n",
      });

      const artifacts = compute(root, "2.0.0");
      const byRelPath = new Map(artifacts.map((a) => [a.relPath, a.content]));

      assert.ok(
        byRelPath.has("codex/skills/trace/SKILL.md"),
        "Codex skill entry present",
      );
      assert.equal(
        byRelPath.get("codex/skills/trace/SKILL.md"),
        "Codex wording `npx @arielbk/trace@0.1.0`.\n",
        "Codex skill uses the override file content verbatim (not stamped — that's the pin-stamped entry)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stamps every discovered pinned file to the target version", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-compute-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "Use `npx @arielbk/trace@0.1.0` to run.\n",
        "hooks/hooks.json": '{"cmd":"npx @arielbk/trace@0.1.0 trace"}\n',
        "codex/.codex-plugin/plugin.json": JSON.stringify({ name: "trace", version: "0.1.0" }, null, 2) + "\n",
      });

      const artifacts = compute(root, "1.5.0");
      const byRelPath = new Map(artifacts.map((a) => [a.relPath, a.content]));

      assert.ok(
        byRelPath.has("skills/trace/SKILL.md"),
        "pinned skill file is in artifact set",
      );
      assert.ok(
        byRelPath.get("skills/trace/SKILL.md")?.includes("@arielbk/trace@1.5.0"),
        "skill pin is stamped to target version",
      );
      assert.ok(
        byRelPath.has("hooks/hooks.json"),
        "hooks file is in artifact set",
      );
      assert.ok(
        byRelPath.get("hooks/hooks.json")?.includes("@arielbk/trace@1.5.0"),
        "hooks pin is stamped to target version",
      );
      assert.ok(
        !byRelPath.get("skills/trace/SKILL.md")?.includes("@arielbk/trace@0.1.0"),
        "old version is replaced",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sets versioned manifest version field to the target version", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-compute-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "No pin here.\n",
        "codex/.codex-plugin/plugin.json": JSON.stringify({ name: "trace", version: "0.1.0" }, null, 2) + "\n",
      });

      const artifacts = compute(root, "3.0.0", {
        manifestRelPaths: ["codex/.codex-plugin/plugin.json"],
      });
      const byRelPath = new Map(artifacts.map((a) => [a.relPath, a.content]));

      assert.ok(
        byRelPath.has("codex/.codex-plugin/plugin.json"),
        "manifest is in artifact set",
      );
      const manifest = JSON.parse(byRelPath.get("codex/.codex-plugin/plugin.json")!);
      assert.equal(manifest.version, "3.0.0", "manifest version stamped to target");
      assert.equal(manifest.name, "trace", "other manifest fields preserved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses DEFAULT_VERSIONED_MANIFEST_REL_PATHS when no manifestRelPaths option given", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-compute-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "No pin here.\n",
        "codex/.codex-plugin/plugin.json": JSON.stringify({ name: "trace", version: "0.0.1" }, null, 2) + "\n",
      });

      const artifacts = compute(root, "1.2.3");
      const byRelPath = new Map(artifacts.map((a) => [a.relPath, a.content]));

      assert.ok(
        byRelPath.has("codex/.codex-plugin/plugin.json"),
        "default manifest path included",
      );
      const manifest = JSON.parse(byRelPath.get("codex/.codex-plugin/plugin.json")!);
      assert.equal(manifest.version, "1.2.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("findArtifactDrift and renderArtifacts", () => {
  function makeTree(root: string, files: Record<string, string>) {
    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(root, relPath);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
  }

  it("drift is empty after renderArtifacts (on-disk tree matches compute output)", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-wr-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "Use `npx @arielbk/trace@0.1.0` to run.\n",
        "hooks/hooks.json": '{"cmd":"npx @arielbk/trace@0.1.0 trace"}\n',
        "codex/.codex-plugin/plugin.json": JSON.stringify({ name: "trace", version: "0.1.0" }, null, 2) + "\n",
      });

      renderArtifacts(root, "1.0.0", { manifestRelPaths: ["codex/.codex-plugin/plugin.json"] });

      assert.deepEqual(
        findArtifactDrift(root, "1.0.0", { manifestRelPaths: ["codex/.codex-plugin/plugin.json"] }),
        [],
        "no drift after renderArtifacts",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renderArtifacts is idempotent — running twice produces no drift", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-wr-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "Use `npx @arielbk/trace@0.1.0`.\n",
        "codex/.codex-plugin/plugin.json": JSON.stringify({ name: "trace", version: "0.1.0" }, null, 2) + "\n",
      });

      const opts = { manifestRelPaths: ["codex/.codex-plugin/plugin.json"] };
      renderArtifacts(root, "2.0.0", opts);
      renderArtifacts(root, "2.0.0", opts);

      assert.deepEqual(findArtifactDrift(root, "2.0.0", opts), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drift reports a missing generated artifact path (Codex skill)", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-wr-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "No pin here.\n",
        "codex/.codex-plugin/plugin.json": JSON.stringify({ name: "trace", version: "0.1.0" }, null, 2) + "\n",
      });

      const opts = { manifestRelPaths: ["codex/.codex-plugin/plugin.json"] };
      renderArtifacts(root, "1.0.0", opts);

      // Delete the generated Codex skill to simulate a missing generated artifact
      unlinkSync(join(root, "codex/skills/trace/SKILL.md"));

      const drift = findArtifactDrift(root, "1.0.0", opts);
      assert.ok(
        drift.includes("codex/skills/trace/SKILL.md"),
        `expected codex/skills/trace/SKILL.md in drift, got: ${JSON.stringify(drift)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drift reports a mis-stamped pin (stale version on disk)", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-wr-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "Use `npx @arielbk/trace@0.1.0`.\n",
        "codex/.codex-plugin/plugin.json": JSON.stringify({ name: "trace", version: "0.1.0" }, null, 2) + "\n",
      });

      const opts = { manifestRelPaths: ["codex/.codex-plugin/plugin.json"] };
      renderArtifacts(root, "2.0.0", opts);

      // Manually re-stamp the skill back to the old pin — simulates a stale file
      writeFileSync(join(root, "skills/trace/SKILL.md"), "Use `npx @arielbk/trace@0.1.0`.\n");

      const drift = findArtifactDrift(root, "2.0.0", opts);
      assert.ok(
        drift.includes("skills/trace/SKILL.md"),
        `expected skills/trace/SKILL.md in drift for mis-stamped pin, got: ${JSON.stringify(drift)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drift reports extra Codex skills not in the compute output", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-wr-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "No pin.\n",
        "codex/.codex-plugin/plugin.json": JSON.stringify({ name: "trace", version: "0.1.0" }, null, 2) + "\n",
      });

      const opts = { manifestRelPaths: ["codex/.codex-plugin/plugin.json"] };
      renderArtifacts(root, "1.0.0", opts);

      // Add a ghost Codex skill not present in the skills/ source tree
      makeTree(root, {
        "codex/skills/ghost/SKILL.md": "stale ghost\n",
      });

      const drift = findArtifactDrift(root, "1.0.0", opts);
      assert.ok(
        drift.includes("codex/skills/ghost/SKILL.md"),
        `expected extra ghost skill in drift, got: ${JSON.stringify(drift)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renderArtifacts prunes Codex skills removed from the Claude tree", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-wr-"));
    try {
      makeTree(root, {
        "skills/trace/SKILL.md": "No pin.\n",
        "codex/skills/ghost/SKILL.md": "stale ghost\n",
        "codex/.codex-plugin/plugin.json": JSON.stringify({ name: "trace", version: "0.1.0" }, null, 2) + "\n",
      });

      const opts = { manifestRelPaths: ["codex/.codex-plugin/plugin.json"] };
      renderArtifacts(root, "1.0.0", opts);

      assert.deepEqual(findArtifactDrift(root, "1.0.0", opts), [], "ghost skill pruned");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
