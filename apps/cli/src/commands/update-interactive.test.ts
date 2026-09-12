import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCliAsync } from "../trace.ts";
import type { ConfirmPrompt, PromptResult } from "./confirm-prompt.ts";
import type { SetupPrompt } from "./setup-prompt.ts";
import { updateOperation, type UpdateDeps } from "./update-operations.ts";

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
    JSON.stringify(
      {
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
      },
      null,
      2,
    ),
  );
  return path;
}

type Spawns = { installs: string[]; reconciles: string[] };

function makeDeps(spawns: Spawns): UpdateDeps {
  return {
    fetchLatestVersion: async () => "1.2.3",
    spawnInstall: (_pm, version) => {
      spawns.installs.push(version);
      return { status: 0, stderr: "" };
    },
    spawnReconcile: (cliPath) => {
      spawns.reconciles.push(cliPath);
      return { status: 0, stderr: "" };
    },
    // No login service is installed in these fixtures, so this is never
    // reached; it is here to satisfy the dependency surface.
    restartConnection: () => ({ kind: "ok", message: "" }),
  };
}

type FakePrompt = ConfirmPrompt & {
  confirmRequests: { message: string }[];
  notes: { message: string; title: string }[];
};

/** Records what update asked the terminal, and replays one canned answer. */
function fakePrompt(answer: PromptResult<boolean> = { cancelled: false, value: true }): FakePrompt {
  const prompt: FakePrompt = {
    confirmRequests: [],
    notes: [],
    confirm(request) {
      prompt.confirmRequests.push(request);
      return Promise.resolve(answer);
    },
    note(message, title) {
      prompt.notes.push({ message, title });
    },
    warn() {},
  };
  return prompt;
}

/**
 * The composition root hands out the full setup seam, so the dispatch tests
 * have to supply one. The picker throws because update must never reach it —
 * only the confirmation half of the seam is update's to use.
 */
function asSetupPrompt(prompt: FakePrompt): SetupPrompt {
  return {
    ...prompt,
    selectTargets() {
      throw new Error("update must never open the target picker");
    },
  };
}

function updateIn(
  dir: string,
  args: string[],
  spawns: Spawns,
  prompt: FakePrompt,
  currentVersion = "1.0.0",
) {
  return updateOperation(
    args,
    {
      env: {
        HOME: dir,
        TRACE_REGISTRY_PATH: makeRegistry(dir),
        TRACE_CURRENT_VERSION: currentVersion,
      },
      cwd: dir,
      stdin: "",
    },
    makeDeps(spawns),
    prompt,
  );
}

test("confirming a bare update in a terminal applies it in one command", async () => {
  const { dir, cleanup } = tempDir("trace-update-confirm-");
  try {
    const registryPath = makeRegistry(dir);
    const spawns: Spawns = { installs: [], reconciles: [] };
    const prompt = fakePrompt();

    const result = await updateOperation(
      [],
      {
        env: {
          HOME: dir,
          TRACE_REGISTRY_PATH: registryPath,
          TRACE_CURRENT_VERSION: "1.0.0",
        },
        cwd: dir,
        stdin: "",
      },
      makeDeps(spawns),
      prompt,
    );

    // The plan is shown before the question, so the answer is informed.
    expect(prompt.notes).toEqual([
      { message: "Trace v1.0.0 → v1.2.3 (via npm)", title: "Update plan" },
    ]);
    expect(prompt.confirmRequests).toEqual([{ message: "Update to v1.2.3?" }]);
    expect(spawns.installs).toEqual(["1.2.3"]);
    expect(spawns.reconciles).toEqual([CLI_PATH]);
    expect(result.exitCode).toBe(0);
    // The terminal already displayed the plan, so the summary does not repeat it.
    expect(result.stdout).toBe(
      "Updated to v1.2.3 and reconciled registered targets.\n",
    );
  } finally {
    cleanup();
  }
});

for (const [answer, reply] of [
  ["declining", { cancelled: false as const, value: false }],
  ["cancelling", { cancelled: true as const }],
] satisfies [string, PromptResult<boolean>][]) {
  test(`${answer} the update leaves the installation untouched and exits 0`, async () => {
    const { dir, cleanup } = tempDir(`trace-update-${answer}-`);
    try {
      const spawns: Spawns = { installs: [], reconciles: [] };
      const prompt = fakePrompt(reply);

      const result = await updateIn(dir, [], spawns, prompt);

      // The question was asked — only the writes are off.
      expect(prompt.confirmRequests).toHaveLength(1);
      expect(spawns).toEqual({ installs: [], reconciles: [] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Update cancelled; no changes made.\n");
      expect(result.stderr).toBe("");
    } finally {
      cleanup();
    }
  });
}

test("an already-current install never asks, even in a terminal", async () => {
  const { dir, cleanup } = tempDir("trace-update-current-");
  try {
    const spawns: Spawns = { installs: [], reconciles: [] };
    const prompt = fakePrompt();

    const result = await updateIn(dir, [], spawns, prompt, "1.2.3");

    expect(prompt.notes).toEqual([]);
    expect(prompt.confirmRequests).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Trace is already at v1.2.3. Nothing to update.\n");
    expect(spawns).toEqual({ installs: [], reconciles: [] });
  } finally {
    cleanup();
  }
});

test("`--yes` keeps its meaning of skipping the question", async () => {
  const { dir, cleanup } = tempDir("trace-update-yes-");
  try {
    const spawns: Spawns = { installs: [], reconciles: [] };
    const prompt = fakePrompt();

    const result = await updateIn(dir, ["--yes"], spawns, prompt);

    expect(prompt.notes).toEqual([]);
    expect(prompt.confirmRequests).toEqual([]);
    expect(spawns.installs).toEqual(["1.2.3"]);
    // Unattended output keeps the plan line it has always printed.
    expect(result.stdout).toBe(
      "Trace v1.0.0 → v1.2.3 (via npm)\n\nUpdated to v1.2.3 and reconciled registered targets.\n",
    );
  } finally {
    cleanup();
  }
});

// ─── dispatch: which invocations are handed a prompt at all ──────────────────

/** Answers the registry lookup without ever reaching the network or a spawn. */
function stubRegistryFetch(version: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ version }),
  })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("bare `trace update` in a terminal is handed the prompt", async () => {
  const { dir, cleanup } = tempDir("trace-update-dispatch-bare-");
  const restoreFetch = stubRegistryFetch("1.2.3");
  try {
    const registryPath = makeRegistry(dir);
    // Declining proves the wiring without letting a real install spawn.
    const prompt = fakePrompt({ cancelled: false, value: false });

    const result = await runTraceCliAsync(
      ["update"],
      {
        HOME: dir,
        TRACE_REGISTRY_PATH: registryPath,
        TRACE_CURRENT_VERSION: "1.0.0",
      },
      dir,
      "",
      { interactive: true, createPrompt: () => asSetupPrompt(prompt) },
    );

    expect(prompt.confirmRequests).toEqual([{ message: "Update to v1.2.3?" }]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Update cancelled; no changes made.\n");
  } finally {
    restoreFetch();
    cleanup();
  }
});

for (const args of [["update", "--yes"], ["update", "--help"]]) {
  test(`\`${args.join(" ")}\` never constructs a prompt, even in a terminal`, async () => {
    const { dir, cleanup } = tempDir("trace-update-dispatch-flagged-");
    try {
      // No registry, so the command exits before any network call or spawn —
      // the prompt decision is made before that, so the count still proves it.
      let constructed = 0;
      const prompt = fakePrompt();

      await runTraceCliAsync(args, { HOME: dir }, dir, "", {
        interactive: true,
        createPrompt: () => {
          constructed += 1;
          return asSetupPrompt(prompt);
        },
      });

      expect(constructed).toBe(0);
      expect(prompt.confirmRequests).toEqual([]);
    } finally {
      cleanup();
    }
  });
}

test("bare `trace update` without a terminal keeps the preview-then-exit path", async () => {
  const { dir, cleanup } = tempDir("trace-update-dispatch-non-tty-");
  const restoreFetch = stubRegistryFetch("1.2.3");
  try {
    const registryPath = makeRegistry(dir);
    let constructed = 0;
    const prompt = fakePrompt();

    const result = await runTraceCliAsync(
      ["update"],
      {
        HOME: dir,
        TRACE_REGISTRY_PATH: registryPath,
        TRACE_CURRENT_VERSION: "1.0.0",
      },
      dir,
      "",
      {
        interactive: false,
        createPrompt: () => {
          constructed += 1;
          return asSetupPrompt(prompt);
        },
      },
    );

    expect(constructed).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "Trace v1.0.0 → v1.2.3 (via npm)\n\nRe-run with --yes to apply.\n",
    );
  } finally {
    restoreFetch();
    cleanup();
  }
});
