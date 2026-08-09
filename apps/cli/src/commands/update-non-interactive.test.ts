import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { updateOperation, type UpdateDeps } from "./update-operations.ts";

/**
 * CI, agent harnesses and scripts read `trace update`'s output verbatim, and the
 * CLI's own reconcile spawn is one of them. These are exact-output assertions,
 * not substring matches: they exist to fail loudly if the interactive
 * confirmation or the Windows spawn fix leaks outside its blast radius. Every
 * expected string here is the one v0.18.2 printed.
 *
 * The matching POSIX spawn pin — an args array with `shell: false` — lives in
 * `update.test.ts` ("on POSIX spawning does not go through a shell"), which
 * asserts the full call shape for both spawn sites.
 */

const CLI_PATH = "/usr/local/bin/trace";

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeRegistry(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "integrations.json");
  writeFileSync(
    path,
    JSON.stringify({
      packageManager: "npm",
      targets: [
        {
          tool: "claude",
          root: join(dir, ".claude"),
          cliPath: CLI_PATH,
          version: "1.0.0",
          skills: [],
          hooks: [],
        },
      ],
    }),
  );
  return path;
}

type Spawns = { installs: string[]; reconciles: string[] };

function makeDeps(spawns: Spawns, reconcile: { status: number; stderr: string } = { status: 0, stderr: "" }): UpdateDeps {
  return {
    fetchLatestVersion: async () => "1.2.3",
    spawnInstall: (_pm, version) => {
      spawns.installs.push(version);
      return { status: 0, stderr: "" };
    },
    spawnReconcile: (cliPath) => {
      spawns.reconciles.push(cliPath);
      return reconcile;
    },
  };
}

/** Runs update with no prompt at all — the shape every non-interactive caller has. */
function updateWithoutPrompt(
  dir: string,
  args: string[],
  spawns: Spawns,
  opts: { currentVersion?: string; reconcile?: { status: number; stderr: string } } = {},
) {
  return updateOperation(
    args,
    {
      env: {
        HOME: dir,
        TRACE_REGISTRY_PATH: makeRegistry(dir),
        TRACE_CURRENT_VERSION: opts.currentVersion ?? "1.0.0",
      },
      cwd: dir,
      stdin: "",
    },
    makeDeps(spawns, opts.reconcile),
  );
}

test("bare `trace update` with no prompt previews the plan and exits without writing", async () => {
  const { dir, cleanup } = tempDir("trace-update-pin-preview-");
  try {
    const spawns: Spawns = { installs: [], reconciles: [] };

    const result = await updateWithoutPrompt(dir, [], spawns);

    expect(result).toEqual({
      exitCode: 0,
      stdout: "Trace v1.0.0 → v1.2.3 (via npm)\n\nRe-run with --yes to apply.\n",
      stderr: "",
    });
    expect(spawns).toEqual({ installs: [], reconciles: [] });
  } finally {
    cleanup();
  }
});

test("`trace update --yes` applies and still prints the plan above the summary", async () => {
  const { dir, cleanup } = tempDir("trace-update-pin-yes-");
  try {
    const spawns: Spawns = { installs: [], reconciles: [] };

    const result = await updateWithoutPrompt(dir, ["--yes"], spawns);

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        "Trace v1.0.0 → v1.2.3 (via npm)\n\n" +
        "Updated to v1.2.3 and reconciled registered targets.\n",
      stderr: "",
    });
    expect(spawns).toEqual({ installs: ["1.2.3"], reconciles: [CLI_PATH] });
  } finally {
    cleanup();
  }
});

test("an already-current install reports it identically with and without `--yes`", async () => {
  const { dir, cleanup } = tempDir("trace-update-pin-current-");
  try {
    for (const args of [[], ["--yes"]]) {
      const spawns: Spawns = { installs: [], reconciles: [] };

      const result = await updateWithoutPrompt(dir, args, spawns, {
        currentVersion: "1.2.3",
      });

      expect(result).toEqual({
        exitCode: 0,
        stdout: "Trace is already at v1.2.3. Nothing to update.\n",
        stderr: "",
      });
      expect(spawns).toEqual({ installs: [], reconciles: [] });
    }
  } finally {
    cleanup();
  }
});

test("a failed reconcile still reports the upgrade landed, with the detail indented", async () => {
  const { dir, cleanup } = tempDir("trace-update-pin-reconcile-");
  try {
    const spawns: Spawns = { installs: [], reconciles: [] };

    const result = await updateWithoutPrompt(dir, ["--yes"], spawns, {
      reconcile: {
        status: 1,
        stderr: "setup failed: guardrail blocked\nRemediation: unblock it\n",
      },
    });

    expect(result).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "Trace was upgraded to v1.2.3, but reconciling integrations failed:\n" +
        "  setup failed: guardrail blocked\n" +
        "  Remediation: unblock it\n" +
        "Your integrations are still on the previous version. " +
        "Once the above is resolved, run `trace setup --yes` to finish.\n",
    });
  } finally {
    cleanup();
  }
});
