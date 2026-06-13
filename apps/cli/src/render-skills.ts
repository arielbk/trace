import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderArtifacts } from "./skills-render.ts";

const sourcePath = fileURLToPath(import.meta.url);
const appRoot = resolve(dirname(sourcePath), "..");
const repoRoot = resolve(appRoot, "../..");

function readCurrentVersion(root: string): string {
  const pkg = JSON.parse(
    readFileSync(resolve(root, "apps/cli/package.json"), "utf8"),
  ) as { version?: string };
  if (typeof pkg.version !== "string") {
    throw new Error("apps/cli/package.json is missing version");
  }
  return pkg.version;
}

if (process.argv[1] && existsSync(process.argv[1])) {
  const invokedPath = resolve(process.argv[1]);
  if (invokedPath === sourcePath) {
    const version = readCurrentVersion(repoRoot);
    process.stdout.write(`Rendering skills at version ${version}…\n`);
    const written = renderArtifacts(repoRoot, version);
    for (const path of written) {
      process.stdout.write(`  wrote ${path.replace(repoRoot + "/", "")}\n`);
    }
    process.stdout.write(`Done. ${written.length} file(s) written.\n`);
  }
}
