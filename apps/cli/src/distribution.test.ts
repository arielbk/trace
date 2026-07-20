import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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

function walkFiles(dir: string, visit: (abs: string) => void): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      walkFiles(abs, visit);
    } else {
      visit(abs);
    }
  }
}

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

describe("CLI distribution cutover", () => {
  it("no canonical skill template contains a pinned npx @arielbk/trace command", () => {
    const pinnedPattern = /npx @arielbk\/trace@[0-9]+\.[0-9]+\.[0-9]+/;
    const skillsDir = join(repoRoot, "plugin", "skills");

    walkFiles(skillsDir, (filePath) => {
      const content = readFileSync(filePath, "utf8");
      assert.equal(
        pinnedPattern.test(content),
        false,
        `${filePath} still contains a pinned npx @arielbk/trace command`,
      );
    });
  });

  it("hooks/hooks.json does not contain a versioned npx @arielbk/trace pin", () => {
    const hooksJson = join(repoRoot, "hooks", "hooks.json");
    const content = readFileSync(hooksJson, "utf8");
    const pinnedPattern = /npx @arielbk\/trace@[0-9]+\.[0-9]+\.[0-9]+/;
    assert.equal(
      pinnedPattern.test(content),
      false,
      "hooks/hooks.json still contains a pinned npx @arielbk/trace command",
    );
  });

  it("README presents npm|pnpm|bun global install + trace setup as the install path", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    assert.equal(
      readme.includes("npm install -g @arielbk/trace"),
      true,
      "README must show: npm install -g @arielbk/trace",
    );
    assert.equal(
      readme.includes("trace setup"),
      true,
      "README must show: trace setup",
    );
    assert.equal(
      readme.includes("/plugin marketplace add"),
      false,
      "README must not contain plugin marketplace instructions",
    );
  });

  it(
    "packed tarball smoke: setup installs all six skills; remove cleans them up",
    () => {
      ensurePackedDist();

      const packDir = mkdtempSync(join(tmpdir(), "trace-dist-pack-"));
      const fakeHome = mkdtempSync(join(tmpdir(), "trace-dist-home-"));
      const prefix = join(fakeHome, "trace-prefix");

      try {
        const packOutput = execFileSync(
          "npm",
          ["pack", "--pack-destination", packDir, "--json"],
          { cwd: appRoot, encoding: "utf8" },
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

        execFileSync(
          "npm",
          ["install", "--global", "--prefix", prefix, tarball],
          { cwd: packDir, encoding: "utf8" },
        );

        // Prefer the real module entry over the npm bin shim — `node bin/trace`
        // fails when the shim is a shell script rather than a JS file.
        const traceModule = join(
          prefix,
          "lib",
          "node_modules",
          "@arielbk",
          "trace",
          "dist",
          "trace.js",
        );
        assert.equal(
          existsSync(traceModule),
          true,
          "packed install must include dist/trace.js",
        );
        assert.equal(
          existsSync(
            join(
              prefix,
              "lib",
              "node_modules",
              "@arielbk",
              "trace",
              "dist",
              "skills",
              "trace",
              "SKILL.md",
            ),
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
    },
    90_000,
  );
});
