import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { runTraceCliAsync } from "../trace.ts";
import type {
  PromptResult,
  SetupPrompt,
  TargetSelectionRequest,
} from "./setup-prompt.ts";

const CLI_PATH = "/opt/global/bin/trace";

function tempHome(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function env(home: string, extra: Record<string, string> = {}) {
  return { HOME: home, TRACE_CLI_PATH: CLI_PATH, ...extra };
}

/**
 * Every file under a directory as `path → bytes`, so a test can prove an exit
 * path wrote nothing at all — neither integration artifacts nor registry.
 */
function snapshotTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(dir, path)] = readFileSync(path, "base64");
    }
  };
  walk(dir);
  return files;
}

type FakePrompt = SetupPrompt & {
  selectRequests: TargetSelectionRequest[];
  confirmRequests: { message: string }[];
  notes: string[];
};

/** Records what setup asked the terminal for, and replays canned answers. */
function fakePrompt(answers: {
  select?: (request: TargetSelectionRequest) => PromptResult<string[]>;
  confirm?: PromptResult<boolean>;
}): FakePrompt {
  const prompt: FakePrompt = {
    selectRequests: [],
    confirmRequests: [],
    notes: [],
    selectTargets(request) {
      prompt.selectRequests.push(request);
      return Promise.resolve(
        answers.select?.(request) ?? {
          cancelled: false,
          value: [...request.initialValues],
        },
      );
    },
    confirmInstall(request) {
      prompt.confirmRequests.push(request);
      return Promise.resolve(
        answers.confirm ?? { cancelled: false, value: true },
      );
    },
    note(message) {
      prompt.notes.push(message);
    },
    warn() {},
  };
  return prompt;
}

test("bare setup in a terminal runs through the prompt adapter", async () => {
  const { dir, cleanup } = tempHome("trace-boundaries-terminal-");
  try {
    const claudeRoot = join(dir, ".claude");
    mkdirSync(claudeRoot, { recursive: true });
    const prompt = fakePrompt({});

    const result = await runTraceCliAsync(["setup"], env(dir), dir, "", {
      interactive: true,
      createPrompt: () => prompt,
    });

    expect(prompt.selectRequests).toHaveLength(1);
    expect(prompt.confirmRequests).toHaveLength(1);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(claudeRoot, "skills", "board", "SKILL.md"))).toBe(
      true,
    );
  } finally {
    cleanup();
  }
});

test("bare setup without a terminal stays plan-only and never prompts", async () => {
  const { dir, cleanup } = tempHome("trace-boundaries-non-tty-");
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const before = snapshotTree(dir);
    const prompt = fakePrompt({});

    const result = await runTraceCliAsync(["setup"], env(dir), dir, "", {
      interactive: false,
      createPrompt: () => prompt,
    });

    expect(prompt.selectRequests).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Re-run with --yes to apply.");
    expect(snapshotTree(dir)).toEqual(before);
  } finally {
    cleanup();
  }
});

test("bare setup in a terminal without a prompt adapter stays plan-only", async () => {
  const { dir, cleanup } = tempHome("trace-boundaries-no-adapter-");
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const before = snapshotTree(dir);

    const result = await runTraceCliAsync(["setup"], env(dir), dir, "", {
      interactive: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Re-run with --yes to apply.");
    expect(snapshotTree(dir)).toEqual(before);
  } finally {
    cleanup();
  }
});

test("bare setup with nothing to install fails before opening the picker", async () => {
  const { dir, cleanup } = tempHome("trace-boundaries-empty-inventory-");
  try {
    const before = snapshotTree(dir);
    const prompt = fakePrompt({});

    const result = await runTraceCliAsync(["setup"], env(dir), dir, "", {
      interactive: true,
      createPrompt: () => prompt,
    });

    expect(prompt.selectRequests).toEqual([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("No installed hosts detected.");
    expect(snapshotTree(dir)).toEqual(before);
  } finally {
    cleanup();
  }
});

test("cancelling the picker exits successfully without writing anything", async () => {
  const { dir, cleanup } = tempHome("trace-boundaries-cancel-picker-");
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const before = snapshotTree(dir);
    const prompt = fakePrompt({ select: () => ({ cancelled: true }) });

    const result = await runTraceCliAsync(["setup"], env(dir), dir, "", {
      interactive: true,
      createPrompt: () => prompt,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Setup cancelled; no changes made.\n");
    expect(prompt.confirmRequests).toEqual([]);
    expect(snapshotTree(dir)).toEqual(before);
  } finally {
    cleanup();
  }
});

test("submitting an empty selection exits successfully without writing anything", async () => {
  const { dir, cleanup } = tempHome("trace-boundaries-empty-");
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const before = snapshotTree(dir);
    const prompt = fakePrompt({
      select: () => ({ cancelled: false, value: [] }),
    });

    const result = await runTraceCliAsync(["setup"], env(dir), dir, "", {
      interactive: true,
      createPrompt: () => prompt,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("No targets selected.\n");
    expect(prompt.confirmRequests).toEqual([]);
    expect(snapshotTree(dir)).toEqual(before);
  } finally {
    cleanup();
  }
});

for (const [answer, confirm] of [
  ["declining", { cancelled: false as const, value: false }],
  ["cancelling", { cancelled: true as const }],
] satisfies [string, PromptResult<boolean>][]) {
  test(`${answer} the confirmation exits successfully without writing anything`, async () => {
    const { dir, cleanup } = tempHome(`trace-boundaries-confirm-${answer}-`);
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      const before = snapshotTree(dir);
      const prompt = fakePrompt({ confirm });

      const result = await runTraceCliAsync(["setup"], env(dir), dir, "", {
        interactive: true,
        createPrompt: () => prompt,
      });

      // The plan was reviewed, so the picker did run — only the writes are off.
      expect(prompt.notes).toHaveLength(1);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Setup cancelled; no changes made.\n");
      expect(snapshotTree(dir)).toEqual(before);
    } finally {
      cleanup();
    }
  });
}

for (const args of [
  ["setup", "--yes"],
  ["setup", "--tool", "claude"],
  ["setup", "--registered"],
  ["setup", "--remove", "--tool", "claude"],
]) {
  test(`\`${args.join(" ")}\` never opens the picker, even in a terminal`, async () => {
    const { dir, cleanup } = tempHome("trace-boundaries-bypass-");
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      const prompt = fakePrompt({});

      const result = await runTraceCliAsync(args, env(dir), dir, "", {
        interactive: true,
        createPrompt: () => prompt,
      });

      expect(prompt.selectRequests).toEqual([]);
      expect(prompt.confirmRequests).toEqual([]);
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup();
    }
  });
}

test("`setup --target` never opens the picker, even in a terminal", async () => {
  const { dir, cleanup } = tempHome("trace-boundaries-bypass-target-");
  try {
    const workRoot = join(dir, "work-claude");
    mkdirSync(workRoot, { recursive: true });
    const prompt = fakePrompt({});

    const result = await runTraceCliAsync(
      ["setup", "--target", `claude=${workRoot}`, "--yes"],
      env(dir),
      dir,
      "",
      { interactive: true, createPrompt: () => prompt },
    );

    expect(prompt.selectRequests).toEqual([]);
    expect(prompt.confirmRequests).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(workRoot, "skills", "board", "SKILL.md"))).toBe(
      true,
    );
  } finally {
    cleanup();
  }
});
