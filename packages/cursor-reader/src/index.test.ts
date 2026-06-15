import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readComposer, resolveFocusedComposer } from "./index.ts";
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
    });
  });
});
