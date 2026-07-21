import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  CorruptIntegrationRegistryError,
  IntegrationRegistry,
  type TargetRecord,
  type ToolName,
} from "./integration-registry.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function registryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "trace-integration-registry-"));
  tempDirs.push(dir);
  return join(dir, ".trace", "integrations.json");
}

function target(
  tool: ToolName,
  root: string,
  overrides: Partial<TargetRecord> = {},
): TargetRecord {
  return {
    tool,
    root,
    cliPath: "/bin/trace",
    version: "1.0.0",
    skills: ["trace"],
    hooks: [],
    ...overrides,
  };
}

test("a missing integration registry is an empty, queryable state", () => {
  const registry = new IntegrationRegistry(registryPath());

  expect(registry.read()).toBeUndefined();
  expect(registry.targets()).toEqual([]);
  expect(registry.target("codex", "/config")).toBeUndefined();
  expect(registry.staleTools("1.0.0")).toEqual([]);
});

test("the registry path honors an explicit environment override", () => {
  const explicitPath = registryPath();

  expect(
    IntegrationRegistry.fromEnv({
      HOME: "/ignored",
      TRACE_REGISTRY_PATH: explicitPath,
    }).path,
  ).toBe(explicitPath);
});

test("the registry path defaults beneath the available home directory", () => {
  expect(IntegrationRegistry.fromEnv({ HOME: "/home/alex" }).path).toBe(
    "/home/alex/.trace/integrations.json",
  );
  expect(IntegrationRegistry.fromEnv({ USERPROFILE: "C:\\Users\\Alex" }).path).toBe(
    join("C:\\Users\\Alex", ".trace", "integrations.json"),
  );
});

test("registry path resolution fails explicitly without a home directory", () => {
  expect(() => IntegrationRegistry.fromEnv({})).toThrow(
    "HOME/USERPROFILE must be set to resolve the Trace registry path",
  );
});

test("reads and queries a valid integration registry", () => {
  const path = registryPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      packageManager: "pnpm",
      targets: [
        {
          tool: "claude",
          root: "/same-root",
          cliPath: "/bin/trace",
          version: "1.0.0",
          skills: ["trace"],
          hooks: ["Stop"],
        },
        {
          tool: "codex",
          root: "/same-root",
          cliPath: "/bin/trace",
          version: "2.0.0",
          skills: ["trace"],
          hooks: [],
        },
      ],
    }),
  );
  const registry = new IntegrationRegistry(path);

  expect(registry.read()?.packageManager).toBe("pnpm");
  expect(registry.targets("codex")).toHaveLength(1);
  expect(registry.target("claude", "/same-root")?.hooks).toEqual(["Stop"]);
  expect(registry.target("cursor", "/same-root")).toBeUndefined();
  expect(registry.staleTools("2.0.0")).toEqual(["claude"]);
});

test.each([
  ["malformed JSON", "not JSON"],
  ["an invalid package manager", JSON.stringify({ packageManager: "yarn", targets: [] })],
  ["a missing targets array", JSON.stringify({ packageManager: "npm" })],
  [
    "an invalid target",
    JSON.stringify({ packageManager: "npm", targets: [{ tool: "windsurf" }] }),
  ],
  [
    "duplicate tool-root identities",
    JSON.stringify({
      packageManager: "npm",
      targets: [target("codex", "/same"), target("codex", "/same")],
    }),
  ],
])("rejects %s as a corrupt integration registry", (_label, contents) => {
  const path = registryPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  const registry = new IntegrationRegistry(path);

  expect(() => registry.read()).toThrow(CorruptIntegrationRegistryError);
  expect(() => registry.targets()).toThrow(CorruptIntegrationRegistryError);
  expect(() => registry.target("codex", "/config")).toThrow(
    CorruptIntegrationRegistryError,
  );
  expect(() => registry.staleTools("1.0.0")).toThrow(
    CorruptIntegrationRegistryError,
  );
});

test("upsert creates the registry and replaces only an exact tool-root identity", () => {
  const path = registryPath();
  const registry = new IntegrationRegistry(path);

  registry.upsert("npm", target("claude", "/shared", { hooks: ["Stop"] }));
  registry.upsert("npm", target("codex", "/shared"));
  registry.upsert(
    "pnpm",
    target("claude", "/shared", { version: "2.0.0", hooks: ["SessionStart"] }),
  );

  expect(registry.read()).toEqual({
    packageManager: "pnpm",
    targets: [
      target("codex", "/shared"),
      target("claude", "/shared", {
        version: "2.0.0",
        hooks: ["SessionStart"],
      }),
    ],
  });
});

test("upsertMany records multiple targets while replacing exact identities", () => {
  const registry = new IntegrationRegistry(registryPath());
  registry.upsert("npm", target("claude", "/shared", { version: "old" }));

  registry.upsertMany("pnpm", [
    target("claude", "/shared", { version: "new" }),
    target("codex", "/shared"),
  ]);

  expect(registry.read()).toEqual({
    packageManager: "pnpm",
    targets: [
      target("claude", "/shared", { version: "new" }),
      target("codex", "/shared"),
    ],
  });
});

test("remove deletes only the exact tool-root identity and is idempotent", () => {
  const registry = new IntegrationRegistry(registryPath());
  registry.upsert("npm", target("claude", "/shared"));
  registry.upsert("npm", target("codex", "/shared"));

  registry.remove("claude", "/shared");
  registry.remove("claude", "/shared");

  expect(registry.targets()).toEqual([target("codex", "/shared")]);
});

test("removeMany deletes several exact identities in one operation", () => {
  const registry = new IntegrationRegistry(registryPath());
  registry.upsertMany("npm", [
    target("claude", "/shared"),
    target("codex", "/shared"),
    target("cursor", "/keep"),
  ]);

  registry.removeMany([
    { tool: "claude", root: "/shared" },
    { tool: "codex", root: "/shared" },
  ]);

  expect(registry.targets()).toEqual([target("cursor", "/keep")]);
});

test("mutations reject corrupt data without overwriting it", () => {
  const path = registryPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "preserve this invalid data");
  const registry = new IntegrationRegistry(path);

  expect(() => registry.upsert("npm", target("codex", "/config"))).toThrow(
    CorruptIntegrationRegistryError,
  );
  expect(() => registry.remove("codex", "/config")).toThrow(
    CorruptIntegrationRegistryError,
  );
  expect(readFileSync(path, "utf8")).toBe("preserve this invalid data");
});

test("an unchanged upsert preserves the registry file bytes and inode", () => {
  const path = registryPath();
  const registry = new IntegrationRegistry(path);
  const record = target("cursor", "/config");
  registry.upsert("bun", record);
  const before = statSync(path);
  const beforeBytes = readFileSync(path);

  registry.upsert("bun", record);

  expect(readFileSync(path).equals(beforeBytes)).toBe(true);
  expect(statSync(path).ino).toBe(before.ino);
});
