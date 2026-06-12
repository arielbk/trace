import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appRoot, "../..");
const webDistDir = resolve(repoRoot, "apps/web/dist");
const bundledWebDir = resolve(appRoot, "dist/web");
const pluginBinDir = resolve(repoRoot, "bin");
const pluginWebDir = resolve(pluginBinDir, "web");

function copyWebAssets(): void {
  if (!existsSync(resolve(webDistDir, "index.html"))) {
    throw new Error(
      "Web assets are missing at apps/web/dist. Run the web build before the CLI build.",
    );
  }

  rmSync(bundledWebDir, { recursive: true, force: true });
  cpSync(webDistDir, bundledWebDir, { recursive: true });
  mkdirSync(pluginBinDir, { recursive: true });
  rmSync(pluginWebDir, { recursive: true, force: true });
  cpSync(webDistDir, pluginWebDir, { recursive: true });

  for (const artifact of ["trace.js", "claude-session-start-hook.js"]) {
    const distArtifact = resolve(appRoot, "dist", artifact);
    const pluginArtifact = resolve(pluginBinDir, artifact);
    chmodSync(distArtifact, 0o755);
    copyFileSync(distArtifact, pluginArtifact);
    chmodSync(pluginArtifact, 0o755);
  }
}

export default defineConfig({
  entry: {
    trace: "src/trace.ts",
    "claude-session-start-hook": "src/claude-session-start-hook.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: false,
  sourcemap: false,
  clean: true,
  external: ["node:sqlite"],
  noExternal: ["@trace/core", "drizzle-orm"],
  onSuccess: copyWebAssets,
});
