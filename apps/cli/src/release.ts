import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = "@arielbk/trace";
const pinnedCommandPattern =
  /npx @arielbk\/trace@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/g;

const sourcePath = fileURLToPath(import.meta.url);
const appRoot = resolve(dirname(sourcePath), "..");
const defaultRepoRoot = resolve(appRoot, "../..");

export type ReleaseCommand = {
  command: string;
  args: string[];
  cwd: string;
};

export type StampReleaseVersionOptions = {
  repoRoot: string;
  nextVersion: string;
  templatePaths?: string[];
  versionedManifestPaths?: string[];
};

export type StampReleaseVersionResult = {
  packageJsonPath: string;
  updatedTemplatePaths: string[];
};

export function defaultTemplatePaths(repoRoot: string): string[] {
  return [
    "hooks/hooks.json",
    "skills/trace/SKILL.md",
    "skills/recall/SKILL.md",
    "skills/reenter/SKILL.md",
    "skills/board/SKILL.md",
    "skills/doc-placement/SKILL.md",
    "skills/handoff/SKILL.md",
    "codex/skills/trace/SKILL.md",
  ].map((path) => resolve(repoRoot, path));
}

export function defaultVersionedManifestPaths(repoRoot: string): string[] {
  return ["codex/.codex-plugin/plugin.json"].map((path) =>
    resolve(repoRoot, path),
  );
}

export function bumpVersion(
  version: string,
  release: "major" | "minor" | "patch",
): string {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version);
  if (!match) {
    throw new Error(`Cannot bump non-stable semver version: ${version}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (release === "major") {
    return `${major + 1}.0.0`;
  }
  if (release === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

export function assertValidVersion(version: string): void {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Expected an exact semver version, received: ${version}`);
  }
}

export function stampReleaseVersion(
  options: StampReleaseVersionOptions,
): StampReleaseVersionResult {
  assertValidVersion(options.nextVersion);

  const packageJsonPath = resolve(options.repoRoot, "apps/cli/package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
    version?: string;
  };

  if (packageJson.name !== packageName) {
    throw new Error(`Expected ${packageJsonPath} to declare ${packageName}`);
  }

  packageJson.version = options.nextVersion;
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const templatePaths =
    options.templatePaths ?? defaultTemplatePaths(options.repoRoot);
  const versionedManifestPaths =
    options.versionedManifestPaths ??
    defaultVersionedManifestPaths(options.repoRoot);
  const updatedTemplatePaths: string[] = [];

  for (const templatePath of templatePaths) {
    const absolutePath = resolve(templatePath);
    const source = readFileSync(absolutePath, "utf8");
    const pins = [...source.matchAll(pinnedCommandPattern)];
    if (pins.length === 0) {
      throw new Error(
        `No pinned ${packageName} command found in ${absolutePath}`,
      );
    }

    const nextSource = source.replace(
      pinnedCommandPattern,
      `npx ${packageName}@${options.nextVersion}`,
    );

    if (nextSource !== source) {
      writeFileSync(absolutePath, nextSource);
    }
    updatedTemplatePaths.push(absolutePath);
  }

  for (const manifestPath of versionedManifestPaths) {
    const absolutePath = resolve(manifestPath);
    const manifest = JSON.parse(readFileSync(absolutePath, "utf8")) as {
      version?: string;
    };
    manifest.version = options.nextVersion;
    writeFileSync(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  verifyPinnedTemplates({
    expectedVersion: options.nextVersion,
    templatePaths,
  });

  return { packageJsonPath, updatedTemplatePaths };
}

export function verifyPinnedTemplates(options: {
  expectedVersion: string;
  templatePaths: string[];
}): void {
  for (const templatePath of options.templatePaths) {
    const source = readFileSync(resolve(templatePath), "utf8");
    const versions = [...source.matchAll(pinnedCommandPattern)].map(
      (match) => match[1],
    );

    if (versions.length === 0) {
      throw new Error(
        `No pinned ${packageName} command found in ${templatePath}`,
      );
    }

    const mismatched = versions.filter(
      (version) => version !== options.expectedVersion,
    );
    if (mismatched.length > 0) {
      throw new Error(
        `${templatePath} contains ${packageName} pins that do not match ${options.expectedVersion}: ${mismatched.join(", ")}`,
      );
    }
  }
}

export function createReleaseCommands(options: {
  repoRoot: string;
  dryRun: boolean;
  tarballDirectory: string;
}): ReleaseCommand[] {
  const cliRoot = resolve(options.repoRoot, "apps/cli");
  const commands: ReleaseCommand[] = [
    {
      command: "pnpm",
      args: ["--filter", "@trace/web", "build"],
      cwd: options.repoRoot,
    },
    {
      command: "pnpm",
      args: ["--filter", packageName, "build"],
      cwd: options.repoRoot,
    },
    {
      command: "npm",
      args: ["pack", "--pack-destination", options.tarballDirectory],
      cwd: cliRoot,
    },
  ];

  commands.push(
    options.dryRun
      ? {
          command: "npm",
          args: ["publish", "--dry-run", "--access", "public"],
          cwd: cliRoot,
        }
      : {
          command: "npm",
          args: ["publish", "--access", "public"],
          cwd: cliRoot,
        },
  );

  return commands;
}

export function runRelease(options: {
  repoRoot: string;
  nextVersion: string;
  dryRun: boolean;
}): void {
  const templatePaths = defaultTemplatePaths(options.repoRoot);
  const tarballDirectory = resolve(options.repoRoot, "dist/releases");

  stampReleaseVersion({
    repoRoot: options.repoRoot,
    nextVersion: options.nextVersion,
    templatePaths,
  });

  mkdirSync(tarballDirectory, { recursive: true });

  for (const releaseCommand of createReleaseCommands({
    repoRoot: options.repoRoot,
    dryRun: options.dryRun,
    tarballDirectory,
  })) {
    execFileSync(releaseCommand.command, releaseCommand.args, {
      cwd: releaseCommand.cwd,
      env: {
        ...process.env,
        npm_config_cache: resolve(tmpdir(), "trace-release-npm-cache"),
      },
      stdio: "inherit",
    });
  }

  verifyPinnedTemplates({
    expectedVersion: options.nextVersion,
    templatePaths,
  });
}

function readCurrentVersion(repoRoot: string): string {
  const packageJson = JSON.parse(
    readFileSync(resolve(repoRoot, "apps/cli/package.json"), "utf8"),
  ) as { version?: string };
  if (typeof packageJson.version !== "string") {
    throw new Error("apps/cli/package.json is missing version");
  }
  return packageJson.version;
}

function parseArgs(args: string[]): {
  dryRun: boolean;
  nextVersion: string;
} {
  let dryRun = false;
  let explicitVersion: string | undefined;
  let release: "major" | "minor" | "patch" | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--version") {
      explicitVersion = args[index + 1];
      index += 1;
    } else if (arg === "--bump") {
      const value = args[index + 1];
      if (value !== "major" && value !== "minor" && value !== "patch") {
        throw new Error("--bump must be one of: major, minor, patch");
      }
      release = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: pnpm release:trace -- --dry-run (--version x.y.z | --bump patch|minor|major)\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg ?? ""}`);
    }
  }

  if (explicitVersion && release) {
    throw new Error("Use either --version or --bump, not both");
  }

  if (explicitVersion) {
    return { dryRun, nextVersion: explicitVersion };
  }

  if (release) {
    return {
      dryRun,
      nextVersion: bumpVersion(readCurrentVersion(defaultRepoRoot), release),
    };
  }

  throw new Error("Pass --version x.y.z or --bump patch|minor|major");
}

if (process.argv[1] && existsSync(process.argv[1])) {
  const invokedPath = resolve(process.argv[1]);
  if (invokedPath === sourcePath) {
    const options = parseArgs(process.argv.slice(2));
    runRelease({
      repoRoot: defaultRepoRoot,
      nextVersion: options.nextVersion,
      dryRun: options.dryRun,
    });
  }
}
