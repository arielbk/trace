import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const CANONICAL_SKILLS = [
  "board",
  "doc-placement",
  "recall",
  "reenter",
  "state",
  "trace",
] as const;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Ensure `dist/trace.js` and `dist/skills/**` exist for `npm pack`. Other suite
 * files (e.g. bundle.test) wipe `dist/` concurrently, so prefer restoring the
 * skills tree via copy and retry a full build on transient FS races.
 */
function ensurePackedDist(): void {
  const traceJs = join(appRoot, "dist", "trace.js");
  const skillMarker = join(appRoot, "dist", "skills", "trace", "SKILL.md");
  const skillsSource = join(repoRoot, "plugin", "skills");
  const skillsDest = join(appRoot, "dist", "skills");

  for (let attempt = 0; attempt < 5; attempt++) {
    if (existsSync(traceJs) && existsSync(skillMarker)) return;

    try {
      if (existsSync(traceJs) && !existsSync(skillMarker)) {
        rmSync(skillsDest, { recursive: true, force: true });
        cpSync(skillsSource, skillsDest, { recursive: true });
        if (existsSync(skillMarker)) return;
      }

      execFileSync("pnpm", ["--filter", "@arielbk/trace", "build"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (existsSync(traceJs) && existsSync(skillMarker)) return;
    } catch {
      // Parallel suite tests may be wiping/rebuilding dist/ at the same time.
    }
    sleepMs(150 * (attempt + 1));
  }

  assert.equal(existsSync(traceJs), true, "dist/trace.js missing after build");
  assert.equal(
    existsSync(skillMarker),
    true,
    "dist/skills/trace/SKILL.md missing after build",
  );
}

describe("CLI distribution", () => {
  it("packed tarball smoke: setup installs all six skills; remove cleans them up", () => {
    ensurePackedDist();

    const packDir = mkdtempSync(join(tmpdir(), "trace-dist-pack-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "trace-dist-home-"));
    const unpackDir = join(packDir, "unpacked");

    try {
      const packOutput = execFileSync(
        "npm",
        ["pack", "--pack-destination", packDir, "--json"],
        {
          cwd: appRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            npm_config_cache: join(packDir, "npm-cache"),
          },
        },
      );
      const packResult = JSON.parse(packOutput) as Array<{
        filename: string;
      }>;
      const tarball = resolve(packDir, packResult[0]?.filename ?? "");
      assert.equal(
        existsSync(tarball),
        true,
        "npm pack must produce a tarball",
      );

      mkdirSync(unpackDir);
      execFileSync("tar", ["-xzf", tarball, "-C", unpackDir], {
        cwd: packDir,
        encoding: "utf8",
      });

      const traceModule = join(unpackDir, "package", "dist", "trace.js");
      assert.equal(
        existsSync(traceModule),
        true,
        "packed install must include dist/trace.js",
      );
      assert.equal(
        existsSync(
          join(unpackDir, "package", "dist", "skills", "trace", "SKILL.md"),
        ),
        true,
        "packed install must include dist/skills templates",
      );

      const setupEnv = {
        ...process.env,
        HOME: fakeHome,
        TRACE_REGISTRY_PATH: join(fakeHome, "integrations.json"),
        TRACE_CLI_PATH: traceModule,
        TRACE_SERVER_URL: "",
      };

      const setupResult = spawnSync(
        process.execPath,
        [traceModule, "setup", "--tool", "claude", "--yes"],
        { cwd: fakeHome, encoding: "utf8", env: setupEnv },
      );
      assert.equal(
        setupResult.status,
        0,
        `trace setup exited with ${setupResult.status}: ${setupResult.stderr}\n${setupResult.stdout}`,
      );

      const claudeSkillsDir = join(fakeHome, ".claude", "skills");
      for (const skill of CANONICAL_SKILLS) {
        assert.equal(
          existsSync(join(claudeSkillsDir, skill, "SKILL.md")),
          true,
          `Claude skills dir must contain ${skill}/SKILL.md after setup`,
        );
      }

      const settingsPath = join(fakeHome, ".claude", "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        hooks?: Record<string, unknown>;
      };
      assert.equal(
        typeof settings.hooks?.["SessionStart"],
        "object",
        "settings.json must contain a SessionStart hook entry",
      );

      const removeResult = spawnSync(
        process.execPath,
        [traceModule, "setup", "--remove", "--yes"],
        { cwd: fakeHome, encoding: "utf8", env: setupEnv },
      );
      assert.equal(
        removeResult.status,
        0,
        `trace setup --remove exited with ${removeResult.status}: ${removeResult.stderr}\n${removeResult.stdout}`,
      );

      for (const skill of CANONICAL_SKILLS) {
        assert.equal(
          existsSync(join(claudeSkillsDir, skill)),
          false,
          `Claude skills dir must NOT contain ${skill}/ after removal`,
        );
      }
    } finally {
      rmSync(packDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 90_000);
});
