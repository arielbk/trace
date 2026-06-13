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
  stampReleaseVersion,
  verifyPinnedTemplates,
} from "./release.ts";

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
