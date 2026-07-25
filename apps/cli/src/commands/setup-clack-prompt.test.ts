import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createClackPrompt, type ClackApi } from "./setup-clack-prompt.ts";
import type { TargetSelectionRequest } from "./setup-prompt.ts";

const CANCEL = Symbol("clack:cancel");

type Recorded = {
  groupCalls: unknown[];
  confirmCalls: unknown[];
  notes: [string | undefined, string | undefined][];
};

function fakeClack(
  answers: {
    group?: string[] | symbol;
    confirm?: boolean | symbol;
  } = {},
): { clack: ClackApi; recorded: Recorded } {
  const recorded: Recorded = { groupCalls: [], confirmCalls: [], notes: [] };
  const clack: ClackApi = {
    groupMultiselect: (options) => {
      recorded.groupCalls.push(options);
      return Promise.resolve(answers.group ?? []);
    },
    confirm: (options) => {
      recorded.confirmCalls.push(options);
      return Promise.resolve(answers.confirm ?? true);
    },
    note: (message, title) => {
      recorded.notes.push([message, title]);
    },
    isCancel: (value) => value === CANCEL,
  };
  return { clack, recorded };
}

const REQUEST: TargetSelectionRequest = {
  message: "Select the targets to set up",
  groups: [
    {
      label: "Claude Code",
      options: [
        { value: "claude\0/home/me/.claude", label: "~/.claude", hint: "detected · default" },
      ],
    },
    {
      label: "Codex",
      options: [
        { value: "codex\0/home/me/.codex", label: "~/.codex", hint: "not registered" },
      ],
    },
  ],
  initialValues: ["claude\0/home/me/.claude", "codex\0/home/me/.codex"],
};

describe("Clack setup prompt adapter", () => {
  it("renders the picker as one grouped multiselect keyed by tool label", async () => {
    const { clack, recorded } = fakeClack({
      group: ["claude\0/home/me/.claude"],
    });

    const result = await createClackPrompt(clack).selectTargets(REQUEST);

    assert.deepEqual(recorded.groupCalls, [
      {
        message: "Select the targets to set up",
        options: {
          "Claude Code": [
            {
              value: "claude\0/home/me/.claude",
              label: "~/.claude",
              hint: "detected · default",
            },
          ],
          Codex: [
            {
              value: "codex\0/home/me/.codex",
              label: "~/.codex",
              hint: "not registered",
            },
          ],
        },
        initialValues: ["claude\0/home/me/.claude", "codex\0/home/me/.codex"],
        required: false,
        selectableGroups: false,
      },
    ]);
    assert.deepEqual(result, {
      cancelled: false,
      value: ["claude\0/home/me/.claude"],
    });
  });

  it("normalises a cancelled picker into a cancelled prompt result", async () => {
    const { clack } = fakeClack({ group: CANCEL });

    const result = await createClackPrompt(clack).selectTargets(REQUEST);

    assert.deepEqual(result, { cancelled: true });
  });

  it("asks for confirmation and reports the answer", async () => {
    const { clack, recorded } = fakeClack({ confirm: false });

    const result = await createClackPrompt(clack).confirmInstall({
      message: "Install Trace into these targets?",
    });

    assert.deepEqual(recorded.confirmCalls, [
      { message: "Install Trace into these targets?" },
    ]);
    assert.deepEqual(result, { cancelled: false, value: false });
  });

  it("normalises a cancelled confirmation into a cancelled prompt result", async () => {
    const { clack } = fakeClack({ confirm: CANCEL });

    const result = await createClackPrompt(clack).confirmInstall({
      message: "Install Trace into these targets?",
    });

    assert.deepEqual(result, { cancelled: true });
  });

  it("renders a note with its title", () => {
    const { clack, recorded } = fakeClack();

    createClackPrompt(clack).note("target root: ~/.claude", "Setup plan");

    assert.deepEqual(recorded.notes, [
      ["target root: ~/.claude", "Setup plan"],
    ]);
  });
});
