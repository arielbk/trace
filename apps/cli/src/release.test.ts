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
import { describe, it } from "vitest";
import { runRelease } from "./release.ts";

describe("Trace release script", () => {
  it("leaves the package version stamped after a real publish", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "trace-release-"));
    const cliPackageJson = join(repoRoot, "apps/cli/package.json");
    const commands: Array<{ command: string; args: string[] }> = [];

    try {
      mkdirSync(join(repoRoot, "apps/cli"), { recursive: true });
      writeFileSync(
        cliPackageJson,
        JSON.stringify({ name: "@arielbk/trace", version: "0.1.0" }, null, 2),
      );

      runRelease({
        repoRoot,
        nextVersion: "0.1.1",
        dryRun: false,
        runCommand: ({ command, args }) => commands.push({ command, args }),
      });

      assert.equal(
        JSON.parse(readFileSync(cliPackageJson, "utf8")).version,
        "0.1.1",
      );
      assert.equal(
        commands.some(
          ({ command, args }) =>
            command === "npm" && args.join(" ") === "publish --access public",
        ),
        true,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("dry-runs the publish without leaving the package version stamped", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "trace-release-"));
    const cliPackageJson = join(repoRoot, "apps/cli/package.json");
    const commands: Array<{ command: string; args: string[] }> = [];

    try {
      mkdirSync(join(repoRoot, "apps/cli"), { recursive: true });
      writeFileSync(
        cliPackageJson,
        JSON.stringify({ name: "@arielbk/trace", version: "0.1.0" }, null, 2),
      );

      assert.throws(
        () =>
          runRelease({
            repoRoot,
            nextVersion: "0.1.1",
            dryRun: true,
            runCommand: ({ command, args }) => {
              commands.push({ command, args });
              if (command === "npm" && args[0] === "publish") {
                throw new Error("dry-run publish failed");
              }
            },
          }),
        /dry-run publish failed/,
      );

      assert.equal(
        JSON.parse(readFileSync(cliPackageJson, "utf8")).version,
        "0.1.0",
      );
      assert.equal(
        commands.some(
          ({ command, args }) =>
            command === "npm" &&
            args.join(" ") === "publish --dry-run --access public",
        ),
        true,
      );
      assert.equal(
        commands.some(
          ({ command, args }) =>
            command === "npm" && args.join(" ") === "publish --access public",
        ),
        false,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
