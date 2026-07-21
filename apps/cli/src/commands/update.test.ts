import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { updateOperation, type UpdateDeps } from "./update-operations.ts";

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeRegistry(dir: string, opts: {
  packageManager?: string;
  targets?: { tool: string; root: string; cliPath: string; version: string; skills: string[]; hooks: string[] }[];
}) {
  const registry = {
    packageManager: opts.packageManager ?? "npm",
    targets: opts.targets ?? [],
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "integrations.json"), JSON.stringify(registry, null, 2));
  return join(dir, "integrations.json");
}

function makeDeps(overrides: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    fetchLatestVersion: async () => "1.2.3",
    spawnInstall: () => ({ status: 0, stderr: "" }),
    spawnReconcile: () => ({ status: 0, stderr: "" }),
    ...overrides,
  };
}

// ─── behavior 1: no registry → fail ──────────────────────────────────────────

test("fails when no integrations registry exists", async () => {
  const { dir, cleanup } = tempDir("trace-update-");
  try {
    const result = await updateOperation(
      [],
      { env: { HOME: dir }, cwd: dir, stdin: "" },
      makeDeps(),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/no trace integrations/i);
  } finally {
    cleanup();
  }
});

// ─── behavior 2: fetch error → fail ──────────────────────────────────────────

test("fails explicitly when the integrations registry is corrupt", async () => {
  const { dir, cleanup } = tempDir("trace-update-");
  try {
    const registryPath = join(dir, "integrations.json");
    writeFileSync(registryPath, "not valid json");

    const result = await updateOperation(
      [],
      { env: { TRACE_REGISTRY_PATH: registryPath }, cwd: dir, stdin: "" },
      makeDeps(),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/integration registry.*corrupt/i);
  } finally {
    cleanup();
  }
});

test("fails when registry version fetch throws", async () => {
  const { dir, cleanup } = tempDir("trace-update-");
  try {
    const registryPath = makeRegistry(dir, {
      packageManager: "npm",
      targets: [{ tool: "claude", root: join(dir, ".claude"), cliPath: "/usr/bin/trace", version: "1.0.0", skills: [], hooks: [] }],
    });
    const result = await updateOperation(
      [],
      { env: { HOME: dir, TRACE_REGISTRY_PATH: registryPath }, cwd: dir, stdin: "" },
      makeDeps({
        fetchLatestVersion: async () => { throw new Error("npm registry unreachable"); },
      }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/npm registry unreachable/i);
  } finally {
    cleanup();
  }
});

// ─── behavior 3: current == latest → no-op ───────────────────────────────────

test("reports already up to date when current version equals latest", async () => {
  const { dir, cleanup } = tempDir("trace-update-");
  try {
    const registryPath = makeRegistry(dir, {
      packageManager: "npm",
      targets: [{ tool: "claude", root: join(dir, ".claude"), cliPath: "/usr/bin/trace", version: "1.2.3", skills: [], hooks: [] }],
    });
    const result = await updateOperation(
      [],
      { env: { HOME: dir, TRACE_REGISTRY_PATH: registryPath, TRACE_CURRENT_VERSION: "1.2.3" }, cwd: dir, stdin: "" },
      makeDeps({ fetchLatestVersion: async () => "1.2.3" }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/already.*1\.2\.3/i);
  } finally {
    cleanup();
  }
});

// ─── behavior 4: preview (no --yes) ──────────────────────────────────────────

test("preview shows current→target version and package manager without writing", async () => {
  const { dir, cleanup } = tempDir("trace-update-");
  try {
    const registryPath = makeRegistry(dir, {
      packageManager: "pnpm",
      targets: [{ tool: "claude", root: join(dir, ".claude"), cliPath: "/usr/bin/trace", version: "1.0.0", skills: [], hooks: [] }],
    });
    const spawned: string[] = [];
    const result = await updateOperation(
      [],
      { env: { HOME: dir, TRACE_REGISTRY_PATH: registryPath, TRACE_CURRENT_VERSION: "1.0.0" }, cwd: dir, stdin: "" },
      makeDeps({
        fetchLatestVersion: async () => "1.2.3",
        spawnInstall: (pm) => { spawned.push(pm); return { status: 0, stderr: "" }; },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/1\.0\.0.*1\.2\.3/);
    expect(result.stdout).toMatch(/pnpm/);
    expect(result.stdout).toMatch(/--yes/);
    expect(spawned).toHaveLength(0);
  } finally {
    cleanup();
  }
});

// ─── behavior 5: npm install command ─────────────────────────────────────────

test("installs via npm with exact version when --yes and packageManager is npm", async () => {
  const { dir, cleanup } = tempDir("trace-update-");
  try {
    const registryPath = makeRegistry(dir, {
      packageManager: "npm",
      targets: [{ tool: "claude", root: join(dir, ".claude"), cliPath: "/usr/bin/trace", version: "1.0.0", skills: [], hooks: [] }],
    });
    const calls: { pm: string; version: string }[] = [];
    const result = await updateOperation(
      ["--yes"],
      { env: { HOME: dir, TRACE_REGISTRY_PATH: registryPath, TRACE_CURRENT_VERSION: "1.0.0" }, cwd: dir, stdin: "" },
      makeDeps({
        fetchLatestVersion: async () => "1.2.3",
        spawnInstall: (pm, ver) => { calls.push({ pm, version: ver }); return { status: 0, stderr: "" }; },
        spawnReconcile: () => ({ status: 0, stderr: "" }),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ pm: "npm", version: "1.2.3" });
  } finally {
    cleanup();
  }
});

// ─── behavior 6: pnpm install command ────────────────────────────────────────

test("installs via pnpm with exact version when --yes and packageManager is pnpm", async () => {
  const { dir, cleanup } = tempDir("trace-update-");
  try {
    const registryPath = makeRegistry(dir, {
      packageManager: "pnpm",
      targets: [{ tool: "claude", root: join(dir, ".claude"), cliPath: "/usr/bin/trace", version: "1.0.0", skills: [], hooks: [] }],
    });
    const calls: { pm: string; version: string }[] = [];
    const result = await updateOperation(
      ["--yes"],
      { env: { HOME: dir, TRACE_REGISTRY_PATH: registryPath, TRACE_CURRENT_VERSION: "1.0.0" }, cwd: dir, stdin: "" },
      makeDeps({
        fetchLatestVersion: async () => "1.2.3",
        spawnInstall: (pm, ver) => { calls.push({ pm, version: ver }); return { status: 0, stderr: "" }; },
        spawnReconcile: () => ({ status: 0, stderr: "" }),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toEqual({ pm: "pnpm", version: "1.2.3" });
  } finally {
    cleanup();
  }
});

// ─── behavior 7: bun install command ─────────────────────────────────────────

test("installs via bun with exact version when --yes and packageManager is bun", async () => {
  const { dir, cleanup } = tempDir("trace-update-");
  try {
    const registryPath = makeRegistry(dir, {
      packageManager: "bun",
      targets: [{ tool: "claude", root: join(dir, ".claude"), cliPath: "/usr/bin/trace", version: "1.0.0", skills: [], hooks: [] }],
    });
    const calls: { pm: string; version: string }[] = [];
    const result = await updateOperation(
      ["--yes"],
      { env: { HOME: dir, TRACE_REGISTRY_PATH: registryPath, TRACE_CURRENT_VERSION: "1.0.0" }, cwd: dir, stdin: "" },
      makeDeps({
        fetchLatestVersion: async () => "1.2.3",
        spawnInstall: (pm, ver) => { calls.push({ pm, version: ver }); return { status: 0, stderr: "" }; },
        spawnReconcile: () => ({ status: 0, stderr: "" }),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toEqual({ pm: "bun", version: "1.2.3" });
  } finally {
    cleanup();
  }
});

// ─── behavior 8: install failure ─────────────────────────────────────────────

test("surfaces install error when package manager spawn fails", async () => {
  const { dir, cleanup } = tempDir("trace-update-");
  try {
    const registryPath = makeRegistry(dir, {
      packageManager: "npm",
      targets: [{ tool: "claude", root: join(dir, ".claude"), cliPath: "/usr/bin/trace", version: "1.0.0", skills: [], hooks: [] }],
    });
    const result = await updateOperation(
      ["--yes"],
      { env: { HOME: dir, TRACE_REGISTRY_PATH: registryPath, TRACE_CURRENT_VERSION: "1.0.0" }, cwd: dir, stdin: "" },
      makeDeps({
        fetchLatestVersion: async () => "1.2.3",
        spawnInstall: () => ({ status: 1, stderr: "EACCES: permission denied" }),
      }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/EACCES/);
  } finally {
    cleanup();
  }
});

// ─── behavior 9: post-install reconcile calls new CLI ────────────────────────

test("after install, launches the new CLI once to reconcile the complete registry", async () => {
  const { dir, cleanup } = tempDir("trace-update-");
  try {
    const cliPath = "/usr/local/bin/trace";
    const registryPath = makeRegistry(dir, {
      packageManager: "npm",
      targets: [
        { tool: "claude", root: join(dir, ".claude"), cliPath, version: "1.0.0", skills: [], hooks: [] },
        { tool: "codex", root: join(dir, ".codex"), cliPath, version: "1.0.0", skills: [], hooks: [] },
      ],
    });
    const reconcileCalls: string[] = [];
    const result = await updateOperation(
      ["--yes"],
      { env: { HOME: dir, TRACE_REGISTRY_PATH: registryPath, TRACE_CURRENT_VERSION: "1.0.0" }, cwd: dir, stdin: "" },
      makeDeps({
        fetchLatestVersion: async () => "1.2.3",
        spawnInstall: () => ({ status: 0, stderr: "" }),
        spawnReconcile: (cli) => { reconcileCalls.push(cli); return { status: 0, stderr: "" }; },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls).toEqual([cliPath]);
  } finally {
    cleanup();
  }
});

// ─── behavior 10: reconcile failure ──────────────────────────────────────────

test("surfaces reconcile error when new CLI setup fails", async () => {
  const { dir, cleanup } = tempDir("trace-update-");
  try {
    const registryPath = makeRegistry(dir, {
      packageManager: "npm",
      targets: [{ tool: "claude", root: join(dir, ".claude"), cliPath: "/usr/bin/trace", version: "1.0.0", skills: [], hooks: [] }],
    });
    const result = await updateOperation(
      ["--yes"],
      { env: { HOME: dir, TRACE_REGISTRY_PATH: registryPath, TRACE_CURRENT_VERSION: "1.0.0" }, cwd: dir, stdin: "" },
      makeDeps({
        fetchLatestVersion: async () => "1.2.3",
        spawnInstall: () => ({ status: 0, stderr: "" }),
        spawnReconcile: () => ({ status: 1, stderr: "setup failed: guardrail blocked" }),
      }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/setup failed/i);
  } finally {
    cleanup();
  }
});

// ─── behavior 11: reconcile uses first recorded cliPath per tool ─────────────

test("uses cliPath from registry for reconciliation, not process.argv[1]", async () => {
  const { dir, cleanup } = tempDir("trace-update-");
  try {
    const recordedCli = "/opt/homebrew/bin/trace";
    const registryPath = makeRegistry(dir, {
      packageManager: "npm",
      targets: [{ tool: "cursor", root: join(dir, ".cursor"), cliPath: recordedCli, version: "1.0.0", skills: [], hooks: [] }],
    });
    const reconcileCalls: string[] = [];
    await updateOperation(
      ["--yes"],
      { env: { HOME: dir, TRACE_REGISTRY_PATH: registryPath, TRACE_CURRENT_VERSION: "1.0.0" }, cwd: dir, stdin: "" },
      makeDeps({
        fetchLatestVersion: async () => "1.2.3",
        spawnInstall: () => ({ status: 0, stderr: "" }),
        spawnReconcile: (cli) => { reconcileCalls.push(cli); return { status: 0, stderr: "" }; },
      }),
    );
    expect(reconcileCalls).toEqual([recordedCli]);
  } finally {
    cleanup();
  }
});
