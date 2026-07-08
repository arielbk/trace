import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readComposer,
  readComposerTail,
  resolveFocusedComposer,
} from "./index.ts";
import { buildCursorFixture } from "./test-fixture.ts";

let storageRoot: string;

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "cursor-reader-"));
});

afterEach(() => {
  rmSync(storageRoot, { recursive: true, force: true });
});

describe("resolveFocusedComposer", () => {
  it("resolves the focused composer id for a repo path", () => {
    buildCursorFixture(storageRoot, {
      workspaceHash: "ws-hash-1",
      folder: "/Users/dev/repo",
      lastFocusedComposerIds: ["composer-1", "composer-old"],
      composers: [{ composerId: "composer-1", name: "Task" }],
    });

    const result = resolveFocusedComposer("/Users/dev/repo", { storageRoot });

    expect(result).toEqual({
      composerId: "composer-1",
      workspaceHash: "ws-hash-1",
    });
  });

  it("returns null when no workspace matches the repo path", () => {
    buildCursorFixture(storageRoot, {
      workspaceHash: "ws-hash-1",
      folder: "/Users/dev/repo",
      composers: [{ composerId: "composer-1" }],
    });

    expect(
      resolveFocusedComposer("/Users/dev/other", { storageRoot }),
    ).toBeNull();
  });
});

describe("readComposer", () => {
  it("reconstructs the session metadata for a composer id", () => {
    buildCursorFixture(storageRoot, {
      workspaceHash: "ws-hash-1",
      folder: "/Users/dev/repo",
      composers: [
        {
          composerId: "composer-1",
          name: "Cursor GUI re-entry support task",
          model: "claude-opus-4-8",
          createdAt: 1_717_000_000_000,
          lastUpdatedAt: 1_717_000_500_000,
          bubbles: [
            { bubbleId: "b1", type: 1, text: "hello" },
            { bubbleId: "b2", type: 2, grouping: { hasText: true }, text: "hi" },
          ],
        },
      ],
    });

    expect(readComposer("composer-1", { storageRoot })).toEqual({
      composerId: "composer-1",
      projectRoot: "/Users/dev/repo",
      title: "Cursor GUI re-entry support task",
      model: "claude-opus-4-8",
      createdAt: 1_717_000_000_000,
      lastUpdatedAt: 1_717_000_500_000,
      messageCount: 2,
      tokenTotals: null,
      contextTokens: null,
    });
  });

  it("returns nullable fields and null projectRoot when nothing references the composer", () => {
    buildCursorFixture(storageRoot, {
      workspaceHash: "ws-hash-1",
      folder: "/Users/dev/repo",
      lastFocusedComposerIds: ["composer-other"],
      composers: [
        { composerId: "composer-other" },
        { composerId: "orphan", name: null, model: null },
      ],
    });

    expect(readComposer("orphan", { storageRoot })).toEqual({
      composerId: "orphan",
      projectRoot: null,
      title: null,
      model: null,
      createdAt: null,
      lastUpdatedAt: null,
      messageCount: 0,
      tokenTotals: null,
      contextTokens: null,
    });
  });

  it("reads context-window occupancy when the composer records it", () => {
    buildCursorFixture(storageRoot, {
      workspaceHash: "ws-hash-1",
      folder: "/Users/dev/repo",
      composers: [
        {
          composerId: "composer-1",
          contextTokensUsed: 154_826,
          contextTokenLimit: 300_000,
        },
      ],
    });

    expect(
      readComposer("composer-1", { storageRoot }).contextTokens,
    ).toEqual({ used: 154_826, limit: 300_000 });
  });

  it("defaults a missing context limit to 0 but keeps the used count", () => {
    buildCursorFixture(storageRoot, {
      workspaceHash: "ws-hash-1",
      folder: "/Users/dev/repo",
      composers: [{ composerId: "composer-1", contextTokensUsed: 1234 }],
    });

    expect(
      readComposer("composer-1", { storageRoot }).contextTokens,
    ).toEqual({ used: 1234, limit: 0 });
  });
});

describe("readComposer tokenTotals", () => {
  it("sums per-bubble tokenCount when there is no aggregate", () => {
    buildCursorFixture(storageRoot, {
      workspaceHash: "ws-hash-1",
      folder: "/Users/dev/repo",
      composers: [
        {
          composerId: "composer-1",
          bubbles: [
            {
              bubbleId: "b1",
              type: 1,
              text: "hello",
              tokenCount: { inputTokens: 10, outputTokens: 0 },
            },
            {
              bubbleId: "b2",
              type: 2,
              text: "hi",
              tokenCount: { inputTokens: 3, outputTokens: 5 },
            },
          ],
        },
      ],
    });

    expect(readComposer("composer-1", { storageRoot }).tokenTotals).toEqual({
      inputTokens: 13,
      outputTokens: 5,
    });
  });

  it("prefers the aggregate usageData over per-bubble sums", () => {
    buildCursorFixture(storageRoot, {
      workspaceHash: "ws-hash-1",
      folder: "/Users/dev/repo",
      composers: [
        {
          composerId: "composer-1",
          usageData: { inputTokens: 100, outputTokens: 50 },
          bubbles: [
            {
              bubbleId: "b1",
              type: 1,
              text: "hello",
              tokenCount: { inputTokens: 10, outputTokens: 0 },
            },
          ],
        },
      ],
    });

    expect(readComposer("composer-1", { storageRoot }).tokenTotals).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
  });
});

describe("readComposerTail", () => {
  it("projects all four bubble kinds in order", () => {
    buildCursorFixture(storageRoot, {
      workspaceHash: "ws-hash-1",
      folder: "/Users/dev/repo",
      composers: [
        {
          composerId: "composer-1",
          bubbles: [
            { bubbleId: "b1", type: 1, text: "do the thing" },
            {
              bubbleId: "b2",
              type: 2,
              capabilityType: 30,
              thinking: { text: "let me reason" },
            },
            {
              bubbleId: "b3",
              type: 2,
              capabilityType: 15,
              toolFormerData: { name: "read_file", status: "completed" },
            },
            { bubbleId: "b4", type: 2, text: "done" },
          ],
        },
      ],
    });

    expect(readComposerTail("composer-1", 10, { storageRoot })).toEqual([
      { kind: "user", text: "do the thing" },
      { kind: "thinking", text: "let me reason" },
      { kind: "tool", name: "read_file", status: "completed" },
      { kind: "assistant", text: "done" },
    ]);
  });

  it("skips blank assistant turns", () => {
    buildCursorFixture(storageRoot, {
      workspaceHash: "ws-hash-1",
      folder: "/Users/dev/repo",
      composers: [
        {
          composerId: "composer-1",
          bubbles: [
            { bubbleId: "b1", type: 1, text: "ask" },
            { bubbleId: "b2", type: 2, text: "" },
            { bubbleId: "b3", type: 2, text: "answer" },
          ],
        },
      ],
    });

    expect(readComposerTail("composer-1", 10, { storageRoot })).toEqual([
      { kind: "user", text: "ask" },
      { kind: "assistant", text: "answer" },
    ]);
  });

  it("omits status when the tool call has none", () => {
    buildCursorFixture(storageRoot, {
      workspaceHash: "ws-hash-1",
      folder: "/Users/dev/repo",
      composers: [
        {
          composerId: "composer-1",
          bubbles: [
            {
              bubbleId: "b1",
              type: 2,
              capabilityType: 15,
              toolFormerData: { name: "run_terminal" },
            },
          ],
        },
      ],
    });

    expect(readComposerTail("composer-1", 10, { storageRoot })).toEqual([
      { kind: "tool", name: "run_terminal" },
    ]);
  });

  it("returns only the last `limit` messages", () => {
    buildCursorFixture(storageRoot, {
      workspaceHash: "ws-hash-1",
      folder: "/Users/dev/repo",
      composers: [
        {
          composerId: "composer-1",
          bubbles: [
            { bubbleId: "b1", type: 1, text: "one" },
            { bubbleId: "b2", type: 2, text: "two" },
            { bubbleId: "b3", type: 1, text: "three" },
            { bubbleId: "b4", type: 2, text: "four" },
          ],
        },
      ],
    });

    expect(readComposerTail("composer-1", 2, { storageRoot })).toEqual([
      { kind: "user", text: "three" },
      { kind: "assistant", text: "four" },
    ]);
  });
});
