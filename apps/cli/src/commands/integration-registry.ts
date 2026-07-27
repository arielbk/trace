import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Env } from "./seam.ts";

export type PackageManager = "npm" | "pnpm" | "bun";
export type ToolName = "claude" | "codex" | "cursor";

export type TargetRecord = {
  tool: ToolName;
  root: string;
  cliPath: string;
  version: string;
  skills: string[];
  hooks: string[];
};

export type Registry = {
  packageManager: PackageManager;
  targets: TargetRecord[];
};

export class CorruptIntegrationRegistryError extends Error {
  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`Trace integration registry at ${path} is corrupt: ${reason}`, options);
    this.name = "CorruptIntegrationRegistryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSafeArtifactName(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function isTargetRecord(value: unknown): value is TargetRecord {
  if (!isRecord(value)) return false;
  return (
    (value.tool === "claude" || value.tool === "codex" || value.tool === "cursor") &&
    typeof value.root === "string" &&
    typeof value.cliPath === "string" &&
    typeof value.version === "string" &&
    isStringArray(value.skills) &&
    value.skills.every(isSafeArtifactName) &&
    isStringArray(value.hooks) &&
    value.hooks.every(isSafeArtifactName)
  );
}

function targetIdentity(target: Pick<TargetRecord, "tool" | "root">): string {
  return `${target.tool}\0${target.root}`;
}

function parseRegistry(path: string, contents: string): Registry {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (cause) {
    throw new CorruptIntegrationRegistryError(path, "invalid JSON", { cause });
  }

  if (!isRecord(value)) {
    throw new CorruptIntegrationRegistryError(path, "expected an object");
  }
  if (
    value.packageManager !== "npm" &&
    value.packageManager !== "pnpm" &&
    value.packageManager !== "bun"
  ) {
    throw new CorruptIntegrationRegistryError(
      path,
      'packageManager must be "npm", "pnpm", or "bun"',
    );
  }
  if (!Array.isArray(value.targets) || !value.targets.every(isTargetRecord)) {
    throw new CorruptIntegrationRegistryError(path, "targets must be valid target records");
  }
  const identities = new Set(value.targets.map(targetIdentity));
  if (identities.size !== value.targets.length) {
    throw new CorruptIntegrationRegistryError(
      path,
      "targets must have unique tool-root identities",
    );
  }
  return { packageManager: value.packageManager, targets: value.targets };
}

/** Owns persistence and queries for registered Trace integration targets. */
export class IntegrationRegistry {
  readonly path: string;

  static fromEnv(env: Env): IntegrationRegistry {
    if (env.TRACE_REGISTRY_PATH) {
      return new IntegrationRegistry(env.TRACE_REGISTRY_PATH);
    }
    const home = env.HOME ?? env.USERPROFILE;
    if (!home) {
      throw new Error(
        "HOME/USERPROFILE must be set to resolve the Trace registry path",
      );
    }
    return new IntegrationRegistry(join(home, ".trace", "integrations.json"));
  }

  constructor(path: string) {
    this.path = path;
  }

  read(): Registry | undefined {
    if (!existsSync(this.path)) return undefined;
    return parseRegistry(this.path, readFileSync(this.path, "utf8"));
  }

  targets(tool?: ToolName): TargetRecord[] {
    const targets = this.read()?.targets ?? [];
    return tool === undefined
      ? targets
      : targets.filter((target) => target.tool === tool);
  }

  target(tool: ToolName, root: string): TargetRecord | undefined {
    return this.targets(tool).find((target) => target.root === root);
  }

  staleTools(currentVersion: string): ToolName[] {
    return [
      ...new Set(
        this.targets()
          .filter((target) => target.version !== currentVersion)
          .map((target) => target.tool),
      ),
    ];
  }

  upsert(packageManager: PackageManager, target: TargetRecord): void {
    this.upsertMany(packageManager, [target]);
  }

  upsertMany(
    packageManager: PackageManager,
    targetsToUpsert: readonly TargetRecord[],
  ): void {
    if (targetsToUpsert.length === 0) return;
    const existing = this.read();
    const replacements = new Map(
      targetsToUpsert.map((target) => [targetIdentity(target), target]),
    );
    const targets = (existing?.targets ?? []).filter(
      (target) => !replacements.has(targetIdentity(target)),
    );
    targets.push(...replacements.values());
    this.write({ packageManager, targets });
  }

  remove(tool: ToolName, root: string): void {
    this.removeMany([{ tool, root }]);
  }

  removeMany(
    targetsToRemove: readonly Pick<TargetRecord, "tool" | "root">[],
  ): void {
    if (targetsToRemove.length === 0) return;
    const existing = this.read();
    if (!existing) return;
    const removals = new Set(targetsToRemove.map(targetIdentity));
    const targets = existing.targets.filter(
      (target) => !removals.has(targetIdentity(target)),
    );
    if (targets.length === existing.targets.length) return;
    this.write({ ...existing, targets });
  }

  private write(registry: Registry): void {
    const desired = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`);
    if (existsSync(this.path) && readFileSync(this.path).equals(desired)) return;

    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.trace-tmp-${process.pid}`;
    try {
      writeFileSync(temporaryPath, desired);
      renameSync(temporaryPath, this.path);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}
