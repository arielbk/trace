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
  chatIdFromTranscriptPath: (transcriptPath: string) =>
    transcriptPath.split("/").pop()!.replace(/\.jsonl$/, ""),
  readAgentSession: () => {
    throw new Error("no agent transcript in this test");
  },
  readAgentTranscriptMessages: () => [],
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

test("a session bound as agent-transcript flavor self-heals to the composer locator", () => {
  // A GUI chat misregistered under its JSONL mirror (the pre-fix flavor bug):
  // the first read finds the composer record, adopts the canonical
  // cursor:<id> locator plus the real model, and persists both.
  const jsonlPath = `/home/u/.cursor/projects/repo/agent-transcripts/${COMPOSER_ID}/${COMPOSER_ID}.jsonl`;
  const store = openStore();
  try {
    store.registerSession({
      id: COMPOSER_ID,
      transcriptPath: jsonlPath,
      tool: "cursor",
      model: "composer-2.5-fast",
    });

    const healed = store.getSession(COMPOSER_ID);
    expect(healed?.transcriptPath).toBe(`cursor:${COMPOSER_ID}`);
    expect(healed?.model).toBe("claude-opus-4-7");

    // Persisted, not just returned: with the reader unavailable, the next
    // read serves the stored row untouched.
    readComposer.mockImplementation(() => {
      throw new Error("store unreadable");
    });
    const stored = store.getSession(COMPOSER_ID);
    expect(stored?.transcriptPath).toBe(`cursor:${COMPOSER_ID}`);
    expect(stored?.model).toBe("claude-opus-4-7");
  } finally {
    store.close();
  }
});

test("context tokens are snapshotted and survive a parse that stops reporting them", () => {
  readComposer.mockReturnValue({
    ...composer,
    contextTokens: { used: 107_594, limit: 300_000 },
  });
  let store = openStore();
  try {
    store.registerSession({
      id: COMPOSER_ID,
      transcriptPath: `cursor:${COMPOSER_ID}`,
      tool: "cursor",
    });
    expect(store.getSession(COMPOSER_ID)?.contextTokens).toEqual({
      used: 107_594,
      limit: 300_000,
    });
  } finally {
    store.close();
  }

  // Cursor reports occupancy only for the live composer; once the user moves
  // off the chat the field is gone. The snapshot survives a reopen (fresh
  // migrations) and a live parse with no context data — preserve-on-null.
  readComposer.mockReturnValue({ ...composer, contextTokens: null });
  store = openStore();
  try {
    expect(store.getSession(COMPOSER_ID)?.contextTokens).toEqual({
      used: 107_594,
      limit: 300_000,
    });
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
