import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { runTraceCliAsync } from "../trace.ts";
import { targetIdentity } from "./setup-prompt.ts";
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

function env(home: string) {
  return { HOME: home, TRACE_CLI_PATH: CLI_PATH };
}

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
function fakePrompt(
  answers: {
    select?: (request: TargetSelectionRequest) => PromptResult<string[]>;
    confirm?: PromptResult<boolean>;
  } = {},
): FakePrompt {
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
  };
  return prompt;
}

function runInteractiveSetup(home: string, prompt: FakePrompt) {
  return runTraceCliAsync(["setup"], env(home), home, "", {
    interactive: true,
    createPrompt: () => prompt,
  });
}

/**
 * Plants an unowned skill file, which is exactly the collision the existing
 * guardrails refuse to overwrite. Returns the path so a test can prove the
 * user's bytes survived.
 */
function blockTarget(root: string): string {
  const skillPath = join(root, "skills", "board", "SKILL.md");
  mkdirSync(join(skillPath, ".."), { recursive: true });
  writeFileSync(skillPath, "user content");
  return skillPath;
}

/** The plan the terminal was asked to review. */
function reviewedPlan(prompt: FakePrompt): string {
  return prompt.notes.join("\n");
}

/** Every `target root:` line of a setup plan, in order. */
function plannedRoots(plan: string): string[] {
  return [...plan.matchAll(/^ {2}target root: (.+)$/gm)].flatMap(([, root]) =>
    root === undefined ? [] : [root],
  );
}

/** The roots a successful apply reports having written to. */
function installedRoots(summary: string): string[] {
  const roots = summary.match(/^Installed Trace into (.+)\.$/m)?.[1];
  return roots === undefined ? [] : roots.split(", ");
}

test("a blocked selection is listed with its remediation while healthy ones install", async () => {
  const { dir, cleanup } = tempHome("trace-selected-mixed-");
  try {
    const claudeRoot = join(dir, ".claude");
    const cursorRoot = join(dir, ".cursor");
    mkdirSync(claudeRoot, { recursive: true });
    const blocked = blockTarget(cursorRoot);
    const prompt = fakePrompt();

    const result = await runInteractiveSetup(dir, prompt);

    // The reviewed plan covers the healthy target and explains the blocked one.
    expect(prompt.notes).toHaveLength(1);
    expect(plannedRoots(reviewedPlan(prompt))).toEqual([claudeRoot]);
    expect(reviewedPlan(prompt)).toContain(
      "Skipped (guardrail checks failed):",
    );
    expect(reviewedPlan(prompt)).toContain(cursorRoot);
    expect(reviewedPlan(prompt).toLowerCase()).toContain("remediation");

    expect(result.exitCode).toBe(0);
    expect(installedRoots(result.stdout)).toEqual([claudeRoot]);
    expect(result.stdout).toContain("Skipped (guardrail checks failed):");
    expect(existsSync(join(claudeRoot, "skills", "board", "SKILL.md"))).toBe(
      true,
    );
    // The blocked target keeps its bytes and gains no registry entry.
    expect(readFileSync(blocked, "utf8")).toBe("user content");
    const registry = readFileSync(
      join(dir, ".trace", "integrations.json"),
      "utf8",
    );
    expect(registry).not.toContain(cursorRoot);
  } finally {
    cleanup();
  }
});

test("a selection where every target is blocked fails before the confirmation", async () => {
  const { dir, cleanup } = tempHome("trace-selected-all-blocked-");
  try {
    const claudeRoot = join(dir, ".claude");
    const cursorRoot = join(dir, ".cursor");
    blockTarget(claudeRoot);
    blockTarget(cursorRoot);
    const before = snapshotTree(dir);
    const prompt = fakePrompt();

    const result = await runInteractiveSetup(dir, prompt);

    expect(prompt.selectRequests).toHaveLength(1);
    expect(prompt.notes).toEqual([]);
    expect(prompt.confirmRequests).toEqual([]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No targets could be reconciled.");
    expect(result.stderr).toContain(claudeRoot);
    expect(result.stderr).toContain(cursorRoot);
    expect(result.stderr.toLowerCase()).toContain("remediation");
    expect(snapshotTree(dir)).toEqual(before);
  } finally {
    cleanup();
  }
});

test("a deselected registered target is neither previewed nor written", async () => {
  const { dir, cleanup } = tempHome("trace-selected-deselected-");
  try {
    const claudeRoot = join(dir, ".claude");
    const workRoot = join(dir, "work-claude");
    mkdirSync(claudeRoot, { recursive: true });
    mkdirSync(workRoot, { recursive: true });

    // Register the second root, then strip its skills so a reconciliation of it
    // would be visible on disk.
    const registered = await runTraceCliAsync(
      ["setup", "--target", `claude=${workRoot}`, "--yes"],
      env(dir),
      dir,
      "",
    );
    expect(registered.exitCode).toBe(0);
    rmSync(join(workRoot, "skills"), { recursive: true, force: true });

    const workIdentity = targetIdentity("claude", workRoot);
    const prompt = fakePrompt({
      select: (request) => ({
        cancelled: false,
        value: request.initialValues.filter((value) => value !== workIdentity),
      }),
    });

    const result = await runInteractiveSetup(dir, prompt);

    // The registered root was on offer; deselecting it removed it from both
    // the reviewed plan and the writes.
    expect(
      prompt.selectRequests.flatMap((request) => request.initialValues),
    ).toContain(workIdentity);
    expect(plannedRoots(reviewedPlan(prompt))).toEqual([claudeRoot]);
    expect(result.exitCode).toBe(0);
    expect(installedRoots(result.stdout)).toEqual([claudeRoot]);
    expect(existsSync(join(workRoot, "skills"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("a deselected blocked target is not reported as skipped", async () => {
  const { dir, cleanup } = tempHome("trace-selected-deselected-blocked-");
  try {
    const claudeRoot = join(dir, ".claude");
    const cursorRoot = join(dir, ".cursor");
    mkdirSync(claudeRoot, { recursive: true });
    blockTarget(cursorRoot);
    const dropped = targetIdentity("cursor", cursorRoot);
    const prompt = fakePrompt({
      select: (request) => ({
        cancelled: false,
        value: request.initialValues.filter((value) => value !== dropped),
      }),
    });

    const result = await runInteractiveSetup(dir, prompt);

    // A target the user did not choose is out of scope entirely — it is neither
    // installed nor reported as a guardrail failure.
    expect(reviewedPlan(prompt)).not.toContain("Skipped");
    expect(result.stdout).not.toContain("Skipped");
    expect(result.stdout).not.toContain(cursorRoot);
    expect(installedRoots(result.stdout)).toEqual([claudeRoot]);
  } finally {
    cleanup();
  }
});

test("confirmation writes exactly the target set it previewed", async () => {
  const { dir, cleanup } = tempHome("trace-selected-identity-");
  try {
    const claudeRoot = join(dir, ".claude");
    const codexRoot = join(dir, ".codex");
    const cursorRoot = join(dir, ".cursor");
    for (const root of [claudeRoot, codexRoot, cursorRoot]) {
      mkdirSync(root, { recursive: true });
    }
    const dropped = targetIdentity("cursor", cursorRoot);
    const prompt = fakePrompt({
      select: (request) => ({
        cancelled: false,
        value: request.initialValues.filter((value) => value !== dropped),
      }),
    });

    const result = await runInteractiveSetup(dir, prompt);

    expect(result.exitCode).toBe(0);
    // Nothing is added between the reviewed plan and the writes, and nothing is
    // quietly dropped either.
    expect(installedRoots(result.stdout)).toEqual(
      plannedRoots(reviewedPlan(prompt)),
    );
    expect(installedRoots(result.stdout).sort()).toEqual(
      [claudeRoot, codexRoot].sort(),
    );
    expect(existsSync(join(cursorRoot, "skills"))).toBe(false);
  } finally {
    cleanup();
  }
});
