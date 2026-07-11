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
import { afterEach, beforeEach, describe, it } from "vitest";
import { devBundlePath, stampDevPins, unstampDevPins } from "./dev-stamp.ts";
import { verifyPinnedTemplates } from "./release.ts";

describe("Trace dev-stamp script", () => {
  let repoRoot: string;
  let hookTemplate: string;
  let claudeSkill: string;
  let codexSkill: string;
  let originals: Record<string, string>;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "trace-dev-stamp-"));
    hookTemplate = join(repoRoot, "hooks/hooks.json");
    claudeSkill = join(repoRoot, "plugin/skills/trace/SKILL.md");
    codexSkill = join(repoRoot, "plugin/skills/trace/resources/codex.md");

    mkdirSync(join(repoRoot, "apps/cli/dist"), { recursive: true });
    mkdirSync(join(repoRoot, "hooks"), { recursive: true });
    mkdirSync(join(repoRoot, "plugin/skills/trace/resources"), {
      recursive: true,
    });

    writeFileSync(
      join(repoRoot, "apps/cli/package.json"),
      JSON.stringify({ name: "@arielbk/trace", version: "0.1.0" }, null, 2),
    );
    writeFileSync(devBundlePath(repoRoot), "// built bundle\n");
    writeFileSync(
      hookTemplate,
      '{"command":"npx @arielbk/trace@0.1.0 hook session-start"}\n',
    );
    writeFileSync(
      claudeSkill,
      'Run `npx @arielbk/trace@0.1.0 skill work-on-task "X"`.\n' +
        "Then `npx @arielbk/trace@0.1.0 task list`.\n",
    );
    writeFileSync(
      codexSkill,
      "Run `npx @arielbk/trace@0.1.0 session scan --codex`.\n",
    );

    originals = Object.fromEntries(
      [hookTemplate, claudeSkill, codexSkill].map((path) => [
        path,
        readFileSync(path, "utf8"),
      ]),
    );
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("stamps every pinned file to invoke the local bundle, then unstamps back byte-identical", () => {
    const stamped = stampDevPins({ repoRoot });

    assert.deepEqual(stamped.changedPaths, [
      hookTemplate,
      claudeSkill,
      codexSkill,
    ]);
    assert.equal(stamped.warning, undefined);
    for (const path of stamped.changedPaths) {
      const source = readFileSync(path, "utf8");
      assert.equal(source.includes("npx @arielbk/trace@"), false);
      assert.equal(source.includes(`node ${devBundlePath(repoRoot)}`), true);
    }
    const skillSource = readFileSync(claudeSkill, "utf8");
    assert.equal(
      skillSource.match(new RegExp(`node ${devBundlePath(repoRoot)}`, "g"))
        ?.length,
      2,
    );

    const unstamped = unstampDevPins({ repoRoot });

    assert.deepEqual(unstamped.changedPaths, [
      hookTemplate,
      claudeSkill,
      codexSkill,
    ]);
    for (const [path, original] of Object.entries(originals)) {
      assert.equal(readFileSync(path, "utf8"), original);
    }
  });

  it("is idempotent in both directions", () => {
    stampDevPins({ repoRoot });
    const secondStamp = stampDevPins({ repoRoot });
    assert.deepEqual(secondStamp.changedPaths, []);

    unstampDevPins({ repoRoot });
    const secondUnstamp = unstampDevPins({ repoRoot });
    assert.deepEqual(secondUnstamp.changedPaths, []);

    for (const [path, original] of Object.entries(originals)) {
      assert.equal(readFileSync(path, "utf8"), original);
    }
  });

  it("restores pins stamped from a different checkout location", () => {
    stampDevPins({ repoRoot });
    const relocated = readFileSync(claudeSkill, "utf8").replaceAll(
      devBundlePath(repoRoot),
      "/some/other/checkout/apps/cli/dist/trace.js",
    );
    writeFileSync(claudeSkill, relocated);

    const unstamped = unstampDevPins({ repoRoot });

    assert.equal(unstamped.changedPaths.includes(claudeSkill), true);
    assert.equal(readFileSync(claudeSkill, "utf8"), originals[claudeSkill]);
  });

  it("warns when the built bundle is missing but stamps anyway", () => {
    rmSync(devBundlePath(repoRoot));

    const stamped = stampDevPins({ repoRoot });

    assert.equal(stamped.warning?.includes("Built CLI bundle not found"), true);
    assert.equal(
      readFileSync(hookTemplate, "utf8").includes(
        `node ${devBundlePath(repoRoot)}`,
      ),
      true,
    );
  });

  it("a stamped tree fails the release pin verification", () => {
    stampDevPins({ repoRoot });

    assert.throws(
      () =>
        verifyPinnedTemplates({
          expectedVersion: "0.1.0",
          templatePaths: [hookTemplate, claudeSkill, codexSkill],
        }),
      /No pinned @arielbk\/trace command found/,
    );
  });
});
