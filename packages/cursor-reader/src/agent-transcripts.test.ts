import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cursorProjectKey,
  readAgentTranscriptMessages,
  resolveLatestAgentChat,
} from "./agent-transcripts.ts";
import {
  chatIdFromTranscriptPath,
  readAgentSession,
  resolveCursorSession,
} from "./index.ts";
import { buildCursorFixture } from "./test-fixture.ts";

let projectsRoot: string;

beforeEach(() => {
  projectsRoot = mkdtempSync(join(tmpdir(), "cursor-agent-"));
});

afterEach(() => {
  rmSync(projectsRoot, { recursive: true, force: true });
});

function transcriptLine(role: string, blocks: unknown[]): string {
  return JSON.stringify({ role, message: { content: blocks } });
}

function writeChat(
  repoPath: string,
  chatId: string,
  lines: string[],
  mtimeSeconds?: number,
): string {
  const dir = join(
    projectsRoot,
    cursorProjectKey(repoPath),
    "agent-transcripts",
    chatId,
  );
  mkdirSync(dir, { recursive: true });
  const transcriptPath = join(dir, `${chatId}.jsonl`);
  writeFileSync(transcriptPath, lines.join("\n") + "\n");
  if (mtimeSeconds !== undefined) {
    utimesSync(transcriptPath, mtimeSeconds, mtimeSeconds);
  }
  return transcriptPath;
}

describe("cursorProjectKey", () => {
  it("joins path segments with dashes", () => {
    expect(cursorProjectKey("/Users/dev/Projects/side/trace-v2")).toBe(
      "Users-dev-Projects-side-trace-v2",
    );
  });

  it("strips characters outside letters, digits, and dashes", () => {
    expect(cursorProjectKey("/Users/dev/.claude/skills/pr-description")).toBe(
      "Users-dev-claude-skills-pr-description",
    );
  });
});

describe("resolveLatestAgentChat", () => {
  it("returns the chat with the freshest transcript", () => {
    writeChat("/repo", "chat-old", [transcriptLine("user", [])], 1_000);
    const freshPath = writeChat(
      "/repo",
      "chat-new",
      [transcriptLine("user", [])],
      2_000,
    );

    const latest = resolveLatestAgentChat("/repo", { projectsRoot });

    expect(latest?.chatId).toBe("chat-new");
    expect(latest?.transcriptPath).toBe(freshPath);
  });

  it("returns null when the repo has no transcripts", () => {
    expect(resolveLatestAgentChat("/repo", { projectsRoot })).toBeNull();
  });

  it("skips chat directories without a transcript file", () => {
    mkdirSync(
      join(projectsRoot, cursorProjectKey("/repo"), "agent-transcripts", "empty"),
      { recursive: true },
    );
    const path = writeChat("/repo", "chat-1", [transcriptLine("user", [])]);

    expect(resolveLatestAgentChat("/repo", { projectsRoot })?.transcriptPath).toBe(
      path,
    );
  });
});

describe("readAgentTranscriptMessages", () => {
  it("maps text and tool_use blocks to neutral messages", () => {
    const path = writeChat("/repo", "chat-1", [
      transcriptLine("user", [{ type: "text", text: "bind this session" }]),
      transcriptLine("assistant", [
        { type: "text", text: "Binding now." },
        { type: "tool_use", name: "Shell" },
      ]),
    ]);

    expect(readAgentTranscriptMessages(path)).toEqual([
      { kind: "user", text: "bind this session" },
      { kind: "assistant", text: "Binding now." },
      { kind: "tool", name: "Shell" },
    ]);
  });

  it("drops malformed lines, blank text, and unknown roles", () => {
    const path = writeChat("/repo", "chat-1", [
      "not json",
      transcriptLine("system", [{ type: "text", text: "ignored" }]),
      transcriptLine("user", [{ type: "text", text: "   " }]),
      transcriptLine("user", [{ type: "text", text: "kept" }]),
    ]);

    expect(readAgentTranscriptMessages(path)).toEqual([
      { kind: "user", text: "kept" },
    ]);
  });

  it("returns no messages for a missing file", () => {
    expect(readAgentTranscriptMessages("/nope/missing.jsonl")).toEqual([]);
  });

  it("unwraps cursor-agent's timestamp and user_query envelope", () => {
    const path = writeChat("/repo", "chat-1", [
      transcriptLine("user", [
        {
          type: "text",
          text: "<timestamp>Monday, Jul 6, 2026, 1:01 PM (UTC+2)</timestamp>\n<user_query>\nbind this session\n</user_query>",
        },
      ]),
      transcriptLine("user", [
        {
          type: "text",
          text: "<timestamp>Monday, Jul 6, 2026, 1:05 PM (UTC+2)</timestamp>\nbare follow-up",
        },
      ]),
    ]);

    expect(readAgentTranscriptMessages(path)).toEqual([
      { kind: "user", text: "bind this session" },
      { kind: "user", text: "bare follow-up" },
    ]);
  });

  it("drops a user turn that is only an envelope", () => {
    const path = writeChat("/repo", "chat-1", [
      transcriptLine("user", [
        { type: "text", text: "<timestamp>Jul 6</timestamp>" },
      ]),
    ]);

    expect(readAgentTranscriptMessages(path)).toEqual([]);
  });
});

describe("readAgentSession", () => {
  it("builds a minimal session from the JSONL alone", () => {
    const path = writeChat("/repo", "chat-1", [
      transcriptLine("user", [{ type: "text", text: "hello" }]),
      transcriptLine("assistant", [{ type: "text", text: "hi" }]),
    ]);

    const session = readAgentSession(path);

    expect(session.composerId).toBe("chat-1");
    expect(session.messageCount).toBe(2);
    expect(session.title).toBeNull();
    expect(session.model).toBeNull();
    expect(session.tokenTotals).toBeNull();
    expect(session.contextTokens).toBeNull();
    expect(session.lastUpdatedAt).toBeGreaterThan(0);
  });

  it("throws for a missing transcript", () => {
    expect(() => readAgentSession("/nope/missing.jsonl")).toThrow();
  });
});

describe("chatIdFromTranscriptPath", () => {
  it("takes the basename without the jsonl suffix", () => {
    expect(chatIdFromTranscriptPath("/a/b/chat-1/chat-1.jsonl")).toBe("chat-1");
  });
});

describe("resolveCursorSession", () => {
  it("prefers the focused GUI composer when only it exists", () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "cursor-storage-"));
    try {
      buildCursorFixture(storageRoot, {
        workspaceHash: "ws-1",
        folder: "/repo",
        lastFocusedComposerIds: ["composer-1"],
        composers: [{ composerId: "composer-1", name: "Task" }],
      });

      expect(resolveCursorSession("/repo", { storageRoot, projectsRoot })).toEqual(
        { id: "composer-1", transcriptPath: null },
      );
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the newest agent chat when no composer is focused", () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "cursor-storage-"));
    try {
      const path = writeChat("/repo", "chat-1", [transcriptLine("user", [])]);

      expect(resolveCursorSession("/repo", { storageRoot, projectsRoot })).toEqual(
        { id: "chat-1", transcriptPath: path },
      );
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it("keeps the focused composer when the agent chat mirrors the same id", () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "cursor-storage-"));
    try {
      buildCursorFixture(storageRoot, {
        workspaceHash: "ws-1",
        folder: "/repo",
        lastFocusedComposerIds: ["composer-1"],
        composers: [{ composerId: "composer-1", name: "Task" }],
      });
      writeChat("/repo", "composer-1", [transcriptLine("user", [])]);

      expect(resolveCursorSession("/repo", { storageRoot, projectsRoot })).toEqual(
        { id: "composer-1", transcriptPath: null },
      );
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it("prefers a strictly fresher agent chat over a stale focused composer", () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "cursor-storage-"));
    try {
      buildCursorFixture(storageRoot, {
        workspaceHash: "ws-1",
        folder: "/repo",
        lastFocusedComposerIds: ["composer-1"],
        composers: [
          { composerId: "composer-1", name: "Task", lastUpdatedAt: 1_000_000 },
        ],
      });
      const freshSeconds = 2_000; // 2_000_000 ms > composer's 1_000_000
      const path = writeChat(
        "/repo",
        "chat-2",
        [transcriptLine("user", [])],
        freshSeconds,
      );

      expect(resolveCursorSession("/repo", { storageRoot, projectsRoot })).toEqual(
        { id: "chat-2", transcriptPath: path },
      );
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it("returns null when neither flavor resolves", () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "cursor-storage-"));
    try {
      expect(
        resolveCursorSession("/repo", { storageRoot, projectsRoot }),
      ).toBeNull();
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});
