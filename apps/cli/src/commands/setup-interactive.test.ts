import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { setupOperation } from "./setup-operations.ts";
import { interactiveSetupOperation } from "./setup-interactive.ts";
import {
  targetIdentity,
  type PromptResult,
  type SetupPrompt,
  type TargetSelectionRequest,
} from "./setup-prompt.ts";

const CLI_PATH = "/opt/global/bin/trace";

function tempHome(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The `(tool, root)` identities recorded in the Integration Registry. */
function registeredIdentities(home: string): string[] {
  const path = join(home, ".trace", "integrations.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"))
    .targets.map(({ tool, root }: { tool: string; root: string }) => `${tool}=${root}`)
    .sort();
}

/** The Trace version the Integration Registry recorded for its targets. */
function registeredVersion(home: string): string {
  const path = join(home, ".trace", "integrations.json");
  return JSON.parse(readFileSync(path, "utf8")).targets[0].version;
}

function context(home: string, env: Record<string, string> = {}) {
  return {
    env: { HOME: home, TRACE_CLI_PATH: CLI_PATH, ...env },
    cwd: home,
    stdin: "",
  };
}

type FakePrompt = SetupPrompt & {
  selectRequests: TargetSelectionRequest[];
  confirmRequests: { message: string }[];
  notes: string[];
};

/**
 * A prompt adapter that records what the orchestrator asked for and replays
 * canned answers, standing in for Clack's terminal rendering.
 */
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
      const answer = answers.select?.(request) ?? {
        cancelled: false,
        value: [...request.initialValues],
      };
      return Promise.resolve(answer);
    },
    confirmInstall(request) {
      prompt.confirmRequests.push(request);
      return Promise.resolve(answers.confirm ?? { cancelled: false, value: true });
    },
    note(message) {
      prompt.notes.push(message);
    },
  };
  return prompt;
}

test("the picker groups every candidate by tool with all of them preselected", async () => {
  const { dir, cleanup } = tempHome("trace-picker-groups-");
  try {
    for (const root of [".claude", ".codex", ".cursor"]) {
      mkdirSync(join(dir, root), { recursive: true });
    }
    const prompt = fakePrompt({});

    await interactiveSetupOperation(context(dir), prompt);

    const request = prompt.selectRequests[0]!;
    expect(request.groups.map(({ label }) => label)).toEqual([
      "Claude Code",
      "Codex",
      "Cursor",
    ]);
    expect(
      request.groups.map(({ options }) => options.map(({ label }) => label)),
    ).toEqual([["~/.claude"], ["~/.codex"], ["~/.cursor"]]);
    expect(request.initialValues).toEqual([
      targetIdentity("claude", join(dir, ".claude")),
      targetIdentity("codex", join(dir, ".codex")),
      targetIdentity("cursor", join(dir, ".cursor")),
    ]);
  } finally {
    cleanup();
  }
});

test("each option hints at how the target was discovered and whether it is registered", async () => {
  const { dir, cleanup } = tempHome("trace-picker-hints-");
  try {
    const workClaude = join(dir, "work-claude");
    const workCodex = join(dir, "work-codex");
    const cursorRoot = join(dir, ".cursor");
    mkdirSync(workClaude, { recursive: true });
    mkdirSync(cursorRoot, { recursive: true });

    // A registered custom Codex root whose provider default never existed, and
    // a Cursor root that is both detected and registered.
    for (const target of [`codex=${workCodex}`, `cursor=${cursorRoot}`]) {
      expect(
        setupOperation(["--target", target, "--yes"], context(dir)).exitCode,
      ).toBe(0);
    }
    const version = registeredVersion(dir);
    const prompt = fakePrompt({});

    await interactiveSetupOperation(
      context(dir, { CLAUDE_CONFIG_DIR: workClaude }),
      prompt,
    );

    const hints = prompt.selectRequests[0]!.groups.flatMap(({ options }) =>
      options.map(({ label, hint }) => `${label}: ${hint}`),
    );
    expect(hints).toEqual([
      "~/work-claude: detected · CLAUDE_CONFIG_DIR · not registered",
      `~/work-codex: registered · v${version}`,
      `~/.cursor: detected · default · registered · v${version}`,
    ]);
  } finally {
    cleanup();
  }
});

test("the reviewed plan covers only the submitted selection", async () => {
  const { dir, cleanup } = tempHome("trace-picker-preview-");
  try {
    const claudeRoot = join(dir, ".claude");
    const codexRoot = join(dir, ".codex");
    mkdirSync(claudeRoot, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });
    const prompt = fakePrompt({
      select: () => ({
        cancelled: false,
        value: [targetIdentity("claude", claudeRoot)],
      }),
    });

    await interactiveSetupOperation(context(dir), prompt);

    expect(prompt.notes).toHaveLength(1);
    expect(prompt.notes[0]).toContain(`target root: ${claudeRoot}`);
    expect(prompt.notes[0]).not.toContain(codexRoot);
    // The plan is reviewed in the terminal, so it must not tell the user to
    // re-run with --yes.
    expect(prompt.notes[0]).not.toContain("--yes");
    expect(prompt.confirmRequests).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("confirming installs the reviewed selection and leaves the rest untouched", async () => {
  const { dir, cleanup } = tempHome("trace-picker-apply-");
  try {
    const claudeRoot = join(dir, ".claude");
    const codexRoot = join(dir, ".codex");
    mkdirSync(claudeRoot, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });
    const prompt = fakePrompt({
      select: () => ({
        cancelled: false,
        value: [targetIdentity("claude", claudeRoot)],
      }),
      confirm: { cancelled: false, value: true },
    });

    const result = await interactiveSetupOperation(context(dir), prompt);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(claudeRoot, "skills", "board", "SKILL.md"))).toBe(true);
    expect(existsSync(join(codexRoot, "skills"))).toBe(false);
    expect(registeredIdentities(dir)).toEqual([`claude=${claudeRoot}`]);
    // The plan was already reviewed in the terminal; the result is the outcome.
    expect(result.stdout).toBe(`Installed Trace into ${claudeRoot}.\n`);
  } finally {
    cleanup();
  }
});
