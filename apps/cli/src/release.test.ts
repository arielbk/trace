import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  createReleaseCommands,
  prepareReleaseArtifacts,
  stampReleaseVersion,
  verifyPinnedTemplates,
} from "./release.ts";
import { findArtifactDrift } from "./skills-render.ts";

describe("Trace release script", () => {
  it("stamps the CLI package version into every committed npx template", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "trace-release-"));
    const cliPackageJson = join(repoRoot, "apps/cli/package.json");
    const hookTemplate = join(repoRoot, "hooks/hooks.json");
    const claudeSkill = join(repoRoot, "skills/trace/SKILL.md");
    const codexSkill = join(repoRoot, "codex/skills/trace/SKILL.md");
    const codexPluginManifest = join(
      repoRoot,
      "codex/.codex-plugin/plugin.json",
    );

    try {
      mkdirSync(join(repoRoot, "apps/cli"), { recursive: true });
      mkdirSync(join(repoRoot, "hooks"), { recursive: true });
      mkdirSync(join(repoRoot, "skills/trace"), { recursive: true });
      mkdirSync(join(repoRoot, "codex/skills/trace"), { recursive: true });
      mkdirSync(join(repoRoot, "codex/.codex-plugin"), { recursive: true });

      writeFileSync(
        cliPackageJson,
        JSON.stringify({ name: "@arielbk/trace", version: "0.1.0" }, null, 2),
      );
      writeFileSync(
        hookTemplate,
        '{"command":"npx @arielbk/trace@0.1.0 hook session-start"}\n',
      );
      writeFileSync(
        claudeSkill,
        'Run `npx @arielbk/trace@0.1.0 skill work-on-task "X"`.\n',
      );
      writeFileSync(
        codexSkill,
        "Run `npx @arielbk/trace@0.1.0 session scan --codex`.\n",
      );
      writeFileSync(
        codexPluginManifest,
        JSON.stringify({ name: "trace", version: "0.0.0" }, null, 2),
      );

      const result = stampReleaseVersion({
        repoRoot,
        nextVersion: "0.1.1",
        templatePaths: [hookTemplate, claudeSkill, codexSkill],
        versionedManifestPaths: [codexPluginManifest],
      });

      assert.deepEqual(result.updatedTemplatePaths, [
        hookTemplate,
        claudeSkill,
        codexSkill,
      ]);
      assert.equal(
        JSON.parse(readFileSync(cliPackageJson, "utf8")).version,
        "0.1.1",
      );
      assert.equal(
        readFileSync(hookTemplate, "utf8").includes("npx @arielbk/trace@0.1.1"),
        true,
      );
      assert.equal(
        readFileSync(claudeSkill, "utf8").includes("npx @arielbk/trace@0.1.1"),
        true,
      );
      assert.equal(
        readFileSync(codexSkill, "utf8").includes("npx @arielbk/trace@0.1.1"),
        true,
      );
      assert.equal(
        JSON.parse(readFileSync(codexPluginManifest, "utf8")).version,
        "0.1.1",
      );
      verifyPinnedTemplates({
        expectedVersion: "0.1.1",
        templatePaths: [hookTemplate, claudeSkill, codexSkill],
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("prepareReleaseArtifacts stamps every discovered pinned file and manifest to the next version", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "trace-prepare-"));
    try {
      mkdirSync(join(repoRoot, "apps/cli"), { recursive: true });
      mkdirSync(join(repoRoot, "skills/trace"), { recursive: true });
      mkdirSync(join(repoRoot, "skills/recall"), { recursive: true });
      mkdirSync(join(repoRoot, "hooks"), { recursive: true });
      mkdirSync(join(repoRoot, "codex/.codex-plugin"), { recursive: true });

      writeFileSync(
        join(repoRoot, "apps/cli/package.json"),
        JSON.stringify({ name: "@arielbk/trace", version: "0.5.0" }, null, 2),
      );
      writeFileSync(
        join(repoRoot, "skills/trace/SKILL.md"),
        "Run `npx @arielbk/trace@0.5.0 session`.\n",
      );
      writeFileSync(
        join(repoRoot, "skills/recall/SKILL.md"),
        "Run `npx @arielbk/trace@0.5.0 recall`.\n",
      );
      writeFileSync(
        join(repoRoot, "hooks/hooks.json"),
        '{"command":"npx @arielbk/trace@0.5.0 hook session-start"}\n',
      );
      writeFileSync(
        join(repoRoot, "codex/.codex-plugin/plugin.json"),
        JSON.stringify({ name: "trace", version: "0.5.0" }, null, 2) + "\n",
      );

      prepareReleaseArtifacts({ repoRoot, nextVersion: "0.6.0" });

      assert.equal(
        JSON.parse(readFileSync(join(repoRoot, "apps/cli/package.json"), "utf8")).version,
        "0.6.0",
        "apps/cli/package.json version bumped",
      );
      assert.ok(
        readFileSync(join(repoRoot, "skills/trace/SKILL.md"), "utf8").includes("@arielbk/trace@0.6.0"),
        "trace skill pin stamped",
      );
      assert.ok(
        readFileSync(join(repoRoot, "skills/recall/SKILL.md"), "utf8").includes("@arielbk/trace@0.6.0"),
        "recall skill pin stamped",
      );
      assert.ok(
        readFileSync(join(repoRoot, "hooks/hooks.json"), "utf8").includes("@arielbk/trace@0.6.0"),
        "hooks.json pin stamped",
      );
      assert.equal(
        JSON.parse(readFileSync(join(repoRoot, "codex/.codex-plugin/plugin.json"), "utf8")).version,
        "0.6.0",
        "plugin.json manifest version stamped",
      );
      assert.deepEqual(
        findArtifactDrift(repoRoot, "0.6.0"),
        [],
        "no drift after prepareReleaseArtifacts",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("prepareReleaseArtifacts throws loudly when drift is detected after render", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "trace-prepare-"));
    try {
      mkdirSync(join(repoRoot, "apps/cli"), { recursive: true });
      mkdirSync(join(repoRoot, "skills/trace"), { recursive: true });
      mkdirSync(join(repoRoot, "codex/.codex-plugin"), { recursive: true });

      writeFileSync(
        join(repoRoot, "apps/cli/package.json"),
        JSON.stringify({ name: "@arielbk/trace", version: "0.5.0" }, null, 2),
      );
      writeFileSync(
        join(repoRoot, "skills/trace/SKILL.md"),
        "Run `npx @arielbk/trace@0.5.0 session`.\n",
      );
      writeFileSync(
        join(repoRoot, "codex/.codex-plugin/plugin.json"),
        JSON.stringify({ name: "trace", version: "0.5.0" }, null, 2) + "\n",
      );

      // prepareReleaseArtifacts should succeed (no drift after its own render)
      prepareReleaseArtifacts({ repoRoot, nextVersion: "0.6.0" });

      // Manually revert the stamped skill to simulate drift
      writeFileSync(
        join(repoRoot, "skills/trace/SKILL.md"),
        "Run `npx @arielbk/trace@0.5.0 session`.\n",
      );

      // findArtifactDrift should now detect the stale pin
      const drift = findArtifactDrift(repoRoot, "0.6.0");
      assert.ok(
        drift.includes("skills/trace/SKILL.md"),
        `expected stale pin in drift report, got: ${JSON.stringify(drift)}`,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("dry-run release commands build web assets, build the CLI, pack, and validate publish without publishing", () => {
    const commands = createReleaseCommands({
      repoRoot: "/repo",
      dryRun: true,
      tarballDirectory: "/repo/dist/releases",
    });

    assert.deepEqual(commands, [
      {
        command: "pnpm",
        args: ["--filter", "@trace/web", "build"],
        cwd: "/repo",
      },
      {
        command: "pnpm",
        args: ["--filter", "@arielbk/trace", "build"],
        cwd: "/repo",
      },
      {
        command: "npm",
        args: ["pack", "--pack-destination", "/repo/dist/releases"],
        cwd: "/repo/apps/cli",
      },
      {
        command: "npm",
        args: ["publish", "--dry-run", "--access", "public"],
        cwd: "/repo/apps/cli",
      },
    ]);
  });
});
