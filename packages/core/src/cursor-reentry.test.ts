import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CursorMessage, CursorSession } from "@trace/cursor-reader";

// End-to-end re-entry for a Cursor session. The whole trace stack is real —
// the SQLite store, the re-entry manifest, and the cursor transcript adapter —
// and only the leaf reader (@trace/cursor-reader, its own SQLite read path is
// covered in that package) is stubbed with canned composer data keyed by id.
// This exercises the seams the prior slices wired: a bound `cursor` session
// flows through `getReEntryManifest`, and `getTranscriptAdapter("cursor")`
// reconstructs the ordered tail the CLI's `session tail` prints.
const readComposer = vi.fn<(composerId: string) => CursorSession>();
const readComposerTail =
  vi.fn<(composerId: string, limit: number) => CursorMessage[]>();

vi.mock("@trace/cursor-reader", () => ({
  readComposer: (composerId: string) => readComposer(composerId),
  readComposerTail: (composerId: string, limit: number) =>
    readComposerTail(composerId, limit),
}));

const { openTraceStore } = await import("./store.ts");
const { getTranscriptAdapter } = await import("./transcript-adapter.ts");

const COMPOSER_ID = "11111111-2222-3333-4444-555555555555";

const composer: CursorSession = {
  composerId: COMPOSER_ID,
  projectRoot: "/work/trace-v2",
  title: "Add Cursor re-entry",
  model: "claude-opus-4-7",
  createdAt: 1,
  lastUpdatedAt: 2,
  messageCount: 4,
  tokenTotals: { inputTokens: 12, outputTokens: 34 },
  contextTokens: null,
};

let dir: string;

beforeEach(() => {
  readComposer.mockReset();
  readComposerTail.mockReset();
  readComposer.mockReturnValue(composer);
  dir = mkdtempSync(join(tmpdir(), "trace-cursor-reentry-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openStore() {
  return openTraceStore(join(dir, ".trace", "trace.sqlite"));
}

test("the re-entry manifest lists a bound cursor session", () => {
  const store = openStore();
  try {
    const task = store.createTask("Add Cursor re-entry", "/work/trace-v2");
    const session = store.registerSession({
      id: COMPOSER_ID,
      transcriptPath: `cursor:${COMPOSER_ID}`,
      tool: "cursor",
      model: "claude-opus-4-7",
    });
    store.assignSession(session.id, task.id);

    const manifest = store.getReEntryManifest(task.id);

    expect(manifest).not.toBeNull();
    expect(manifest?.sessions).toEqual([
      {
        id: COMPOSER_ID,
        transcriptPath: `cursor:${COMPOSER_ID}`,
        tool: "cursor",
        model: "claude-opus-4-7",
        createdAt: expect.any(String),
        isMostRecent: true,
      },
    ]);
  } finally {
    store.close();
  }
});

test("re-entry reconstructs the cursor session tail the way `session tail` prints it", () => {
  readComposerTail.mockReturnValue([
    { kind: "user", text: "Add the cursor adapter" },
    { kind: "thinking", text: "Map the tokens first" },
    { kind: "tool", name: "edit_file", status: "completed" },
    { kind: "assistant", text: "Done — re-entry now lists Cursor" },
  ]);

  const store = openStore();
  try {
    const task = store.createTask("Add Cursor re-entry", "/work/trace-v2");
    const session = store.registerSession({
      id: COMPOSER_ID,
      transcriptPath: `cursor:${COMPOSER_ID}`,
      tool: "cursor",
    });
    store.assignSession(session.id, task.id);

    // Mirror the CLI `session tail` handler: look the session up, then render
    // the cursor adapter's reconstructed tail as "<role>: <text>" lines.
    const stored = store.getSession(session.id);
    expect(stored?.tool).toBe("cursor");
    const printed = getTranscriptAdapter(stored!.tool)
      .readTail({ transcriptPath: stored!.transcriptPath, limit: 8 })
      .map((message) => `${message.role}: ${message.text}\n`)
      .join("");

    expect(readComposerTail).toHaveBeenCalledWith(COMPOSER_ID, 8);
    expect(printed).toBe(
      [
        "user: Add the cursor adapter\n",
        "assistant: Map the tokens first\n",
        "assistant: [tool: edit_file (completed)]\n",
        "assistant: Done — re-entry now lists Cursor\n",
      ].join(""),
    );
  } finally {
    store.close();
  }
});

test("re-entry recovers the composer id and model from the locator", () => {
  const store = openStore();
  try {
    const task = store.createTask("Add Cursor re-entry", "/work/trace-v2");
    const session = store.registerSession({
      id: COMPOSER_ID,
      transcriptPath: `cursor:${COMPOSER_ID}`,
      tool: "cursor",
    });
    store.assignSession(session.id, task.id);

    const stored = store.getSession(session.id);
    const parsed = getTranscriptAdapter(stored!.tool).parseFile(
      stored!.transcriptPath,
    );

    expect(readComposer).toHaveBeenCalledWith(COMPOSER_ID);
    expect(parsed.id).toBe(COMPOSER_ID);
    expect(parsed.model).toBe("claude-opus-4-7");
    expect(parsed.tokenTotals.totalTokens).toBe(46);
  } finally {
    store.close();
  }
});
