import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJsonPath = join(appRoot, "package.json");

describe("publishable CLI package", () => {
  it("declares @arielbk/trace as a public package with the built CLI bin", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
      version?: string;
      private?: boolean;
      bin?: Record<string, string>;
      publishConfig?: { access?: string };
      files?: string[];
      dependencies?: Record<string, string>;
    };

    assert.equal(packageJson.name, "@arielbk/trace");
    assert.match(packageJson.version ?? "", /^\d+\.\d+\.\d+(-[\w.]+)?$/);
    assert.notEqual(packageJson.private, true);
    assert.equal(packageJson.bin?.trace, "dist/trace.js");
    assert.equal(packageJson.publishConfig?.access, "public");
    assert.deepEqual(packageJson.files, [
      "dist/trace.js",
      "dist/web/**",
      "dist/skills/**",
    ]);
    assert.equal(packageJson.dependencies?.["@trace/core"], undefined);
  });
});
