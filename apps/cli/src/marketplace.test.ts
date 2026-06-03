import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const marketplaceManifest = join(repoRoot, ".claude-plugin", "marketplace.json");
const pluginManifest = join(repoRoot, ".claude-plugin", "plugin.json");

describe("plugin marketplace", () => {
  it("publishes the repo as a Claude Code marketplace containing the trace plugin", () => {
    assert.equal(existsSync(marketplaceManifest), true);

    const marketplace = JSON.parse(readFileSync(marketplaceManifest, "utf8")) as {
      name?: string;
      owner?: { name?: string };
      description?: string;
      plugins?: Array<{
        name?: string;
        source?: string;
        description?: string;
      }>;
    };
    const plugin = JSON.parse(readFileSync(pluginManifest, "utf8")) as {
      name?: string;
      description?: string;
    };

    assert.equal(marketplace.name, "trace-v2");
    assert.equal(marketplace.owner?.name, "arielbk");
    assert.equal(typeof marketplace.description, "string");
    assert.equal(marketplace.plugins?.length, 1);

    const [tracePlugin] = marketplace.plugins ?? [];
    assert.equal(tracePlugin?.name, plugin.name);
    assert.equal(tracePlugin?.source, "./");
    assert.equal(tracePlugin?.description, plugin.description);

    const sourcePath = normalize(join(repoRoot, tracePlugin?.source ?? ""));
    assert.equal(sourcePath, normalize(repoRoot));
    assert.equal(existsSync(join(sourcePath, ".claude-plugin", "plugin.json")), true);
    assert.equal(existsSync(join(sourcePath, "hooks", "hooks.json")), true);
    assert.equal(existsSync(join(sourcePath, "skills", "trace", "SKILL.md")), true);
  });
});
