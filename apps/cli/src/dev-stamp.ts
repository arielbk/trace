import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultTemplatePaths,
  discoverTemplatePaths,
  pinnedCommandPattern,
  readCurrentVersion,
} from "./release.ts";

const packageName = "@arielbk/trace";

/**
 * Matches a dev-stamped command regardless of which checkout produced it, so
 * an unstamp from one worktree can restore pins stamped from another.
 */
const stampedCommandPattern = /node \S+\/apps\/cli\/dist\/trace\.js/g;

const sourcePath = fileURLToPath(import.meta.url);
const appRoot = resolve(dirname(sourcePath), "..");
const defaultRepoRoot = resolve(appRoot, "../..");

export type DevStampResult = {
  changedPaths: string[];
  warning?: string;
};

export function devBundlePath(repoRoot: string): string {
  return resolve(repoRoot, "apps/cli/dist/trace.js");
}

/**
 * Rewrite every pinned `npx @arielbk/trace@x.y.z` command in the skills tree
 * and hooks config to invoke this checkout's built CLI bundle directly. A tree
 * with no npx pins left (already stamped) is a no-op.
 */
export function stampDevPins(options: { repoRoot: string }): DevStampResult {
  const bundlePath = devBundlePath(options.repoRoot);
  const warning = existsSync(bundlePath)
    ? undefined
    : `Built CLI bundle not found at ${bundlePath} — run \`pnpm --filter ${packageName} build\` before exercising stamped skills.`;

  const changedPaths: string[] = [];
  for (const templatePath of defaultTemplatePaths(options.repoRoot)) {
    const source = readFileSync(templatePath, "utf8");
    const nextSource = source.replace(
      pinnedCommandPattern,
      `node ${bundlePath}`,
    );
    if (nextSource !== source) {
      writeFileSync(templatePath, nextSource);
      changedPaths.push(templatePath);
    }
  }

  return { changedPaths, warning };
}

/**
 * Restore every dev-stamped command back to the published pin, using the
 * version currently declared in apps/cli/package.json. A tree with no stamped
 * commands (already clean) is a no-op.
 */
export function unstampDevPins(options: { repoRoot: string }): DevStampResult {
  const version = readCurrentVersion(options.repoRoot);

  const changedPaths: string[] = [];
  for (const templatePath of discoverTemplatePaths(
    options.repoRoot,
    stampedCommandPattern,
  )) {
    const source = readFileSync(templatePath, "utf8");
    const nextSource = source.replace(
      stampedCommandPattern,
      `npx ${packageName}@${version}`,
    );
    if (nextSource !== source) {
      writeFileSync(templatePath, nextSource);
      changedPaths.push(templatePath);
    }
  }

  return { changedPaths };
}

if (process.argv[1] && existsSync(process.argv[1])) {
  const invokedPath = resolve(process.argv[1]);
  if (invokedPath === sourcePath) {
    const mode = process.argv[2];
    if (mode !== "stamp" && mode !== "unstamp") {
      process.stderr.write(
        "Usage: node apps/cli/src/dev-stamp.ts stamp|unstamp\n",
      );
      process.exit(1);
    }

    const result =
      mode === "stamp"
        ? stampDevPins({ repoRoot: defaultRepoRoot })
        : unstampDevPins({ repoRoot: defaultRepoRoot });

    if (result.changedPaths.length === 0) {
      process.stdout.write(`Nothing to ${mode}: tree is already ${mode}ed.\n`);
    } else {
      for (const changedPath of result.changedPaths) {
        process.stdout.write(`${mode}ed ${changedPath}\n`);
      }
    }
    if (result.warning) {
      process.stderr.write(`Warning: ${result.warning}\n`);
    }
  }
}
