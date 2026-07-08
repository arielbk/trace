import { beforeEach, expect, test, vi } from "vitest";
import type { CursorMessage, CursorSession } from "@trace/cursor-reader";

// The adapter is the only place the reader's neutral vocabulary meets trace's
// transcript vocabulary, so the reader is stubbed here: these tests pin the
// mapping, not the SQLite read path (that's covered in @trace/cursor-reader).
const readComposer = vi.fn<(composerId: string) => CursorSession>();
const readComposerTail =
  vi.fn<(composerId: string, limit: number) => CursorMessage[]>();
const readAgentSession = vi.fn<(transcriptPath: string) => CursorSession>();
const readAgentTranscriptMessages =
  vi.fn<(transcriptPath: string) => CursorMessage[]>();

vi.mock("@trace/cursor-reader", () => ({
  readComposer: (composerId: string) => readComposer(composerId),
  readComposerTail: (composerId: string, limit: number) =>
    readComposerTail(composerId, limit),
  readAgentSession: (transcriptPath: string) => readAgentSession(transcriptPath),
  readAgentTranscriptMessages: (transcriptPath: string) =>
    readAgentTranscriptMessages(transcriptPath),
  chatIdFromTranscriptPath: (transcriptPath: string) =>
    transcriptPath.split("/").pop()!.replace(/\.jsonl$/, ""),
}));

const { getTranscriptAdapter } = await import("./transcript-adapter.ts");

const session: CursorSession = {
  composerId: "composer-1",
  projectRoot: "/repo",
  title: "Wire the cursor adapter",
  model: "claude-opus-4-7",
  createdAt: 1,
  lastUpdatedAt: 2,
  messageCount: 4,
  tokenTotals: { inputTokens: 17, outputTokens: 29 },
  contextTokens: null,
};

beforeEach(() => {
  readComposer.mockReset();
  readComposerTail.mockReset();
  readAgentSession.mockReset();
  readAgentTranscriptMessages.mockReset();
});

test("cursor adapter is registered and self-identifies", () => {
  expect(getTranscriptAdapter("cursor").tool).toBe("cursor");
});

test("parse maps a CursorSession to a ParsedTranscript via the composerId locator", () => {
  readComposer.mockReturnValue(session);

  const parsed = getTranscriptAdapter("cursor").parse({
    transcript: "ignored",
    transcriptPath: "cursor:composer-1",
  });

  expect(readComposer).toHaveBeenCalledWith("composer-1");
  expect(parsed).toEqual({
    id: "composer-1",
    transcriptPath: "cursor:composer-1",
    tool: "cursor",
    title: "Wire the cursor adapter",
    model: "claude-opus-4-7",
    tokenTotals: {
      inputTokens: 17,
      outputTokens: 29,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 46,
    },
    contextTokens: null,
  });
});

test("parseFile resolves the composer the same way as parse", () => {
  readComposer.mockReturnValue(session);

  const parsed = getTranscriptAdapter("cursor").parseFile("cursor:composer-1");

  expect(readComposer).toHaveBeenCalledWith("composer-1");
  expect(parsed.id).toBe("composer-1");
  expect(parsed.transcriptPath).toBe("cursor:composer-1");
});

test("a null tokenTotals maps to an empty token total", () => {
  readComposer.mockReturnValue({ ...session, tokenTotals: null, model: null });

  const parsed = getTranscriptAdapter("cursor").parse({
    transcript: "",
    transcriptPath: "composer-1",
  });

  expect(parsed.model).toBeNull();
  expect(parsed.tokenTotals).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  });
});

test("tail projects polymorphic cursor messages to transcript messages", () => {
  readComposerTail.mockReturnValue([
    { kind: "user", text: "Add the adapter" },
    { kind: "thinking", text: "First map the tokens" },
    { kind: "tool", name: "edit_file", status: "completed" },
    { kind: "tool", name: "read_file" },
    { kind: "assistant", text: "Done" },
  ]);

  const tail = getTranscriptAdapter("cursor").tail({
    transcript: "cursor:composer-1",
    limit: 5,
  });

  expect(readComposerTail).toHaveBeenCalledWith("composer-1", 5);
  expect(tail).toEqual([
    { role: "user", text: "Add the adapter" },
    { role: "assistant", text: "First map the tokens" },
    { role: "assistant", text: "[tool: edit_file (completed)]" },
    { role: "assistant", text: "[tool: read_file]" },
    { role: "assistant", text: "Done" },
  ]);
});

test("readTail resolves the composer via the transcriptPath locator", () => {
  readComposerTail.mockReturnValue([{ kind: "user", text: "hi" }]);

  const tail = getTranscriptAdapter("cursor").readTail({
    transcriptPath: "cursor:composer-1",
    limit: 3,
  });

  expect(readComposerTail).toHaveBeenCalledWith("composer-1", 3);
  expect(tail).toEqual([{ role: "user", text: "hi" }]);
});

test("tail uses a default limit when none is supplied", () => {
  readComposerTail.mockReturnValue([]);

  getTranscriptAdapter("cursor").tail({ transcript: "composer-1" });

  expect(readComposerTail).toHaveBeenCalledWith("composer-1", 8);
});

test("head surfaces the composer title as the naming source", () => {
  readComposer.mockReturnValue(session);

  expect(
    getTranscriptAdapter("cursor").head({ transcript: "cursor:composer-1" }),
  ).toEqual([{ role: "user", text: "Wire the cursor adapter" }]);
});

test("head is best-effort: a missing composer yields no messages", () => {
  readComposer.mockImplementation(() => {
    throw new Error("Cursor composer not found");
  });

  expect(
    getTranscriptAdapter("cursor").readHead({ transcriptPath: "cursor:gone" }),
  ).toEqual([]);
});

const AGENT_TRANSCRIPT_PATH =
  "/home/u/.cursor/projects/repo/agent-transcripts/chat-1/chat-1.jsonl";

test("an agent-transcript locator with a composer record canonicalizes to the composer flavor", () => {
  readComposer.mockReturnValue({ ...session, composerId: "chat-1" });

  const parsed = getTranscriptAdapter("cursor").parseFile(AGENT_TRANSCRIPT_PATH);

  expect(readComposer).toHaveBeenCalledWith("chat-1");
  expect(readAgentSession).not.toHaveBeenCalled();
  expect(parsed.id).toBe("chat-1");
  expect(parsed.title).toBe("Wire the cursor adapter");
  // The composer record marks the chat GUI-owned: reporting the composer
  // locator lets the store self-heal a row bound as agent-transcript flavor.
  expect(parsed.transcriptPath).toBe("cursor:chat-1");
});

test("an agent-transcript locator falls back to the JSONL when no composer record exists", () => {
  readComposer.mockImplementation(() => {
    throw new Error("Cursor composer not found");
  });
  readAgentSession.mockReturnValue({
    composerId: "chat-1",
    projectRoot: null,
    title: null,
    model: null,
    createdAt: null,
    lastUpdatedAt: 5,
    messageCount: 2,
    tokenTotals: null,
    contextTokens: null,
  });

  const parsed = getTranscriptAdapter("cursor").parseFile(AGENT_TRANSCRIPT_PATH);

  expect(readAgentSession).toHaveBeenCalledWith(AGENT_TRANSCRIPT_PATH);
  expect(parsed.id).toBe("chat-1");
  expect(parsed.title).toBeNull();
  expect(parsed.tokenTotals.totalTokens).toBe(0);
  expect(parsed.transcriptPath).toBe(AGENT_TRANSCRIPT_PATH);
});

test("tail reads the JSONL for an agent-transcript locator", () => {
  readAgentTranscriptMessages.mockReturnValue([
    { kind: "user", text: "first" },
    { kind: "assistant", text: "second" },
    { kind: "tool", name: "Shell" },
  ]);

  const tail = getTranscriptAdapter("cursor").readTail({
    transcriptPath: AGENT_TRANSCRIPT_PATH,
    limit: 2,
  });

  expect(readAgentTranscriptMessages).toHaveBeenCalledWith(AGENT_TRANSCRIPT_PATH);
  expect(readComposerTail).not.toHaveBeenCalled();
  expect(tail).toEqual([
    { role: "assistant", text: "second" },
    { role: "assistant", text: "[tool: Shell]" },
  ]);
});

test("head falls back to the first user message for a title-less agent chat", () => {
  readComposer.mockImplementation(() => {
    throw new Error("Cursor composer not found");
  });
  readAgentSession.mockReturnValue({
    composerId: "chat-1",
    projectRoot: null,
    title: null,
    model: null,
    createdAt: null,
    lastUpdatedAt: 5,
    messageCount: 1,
    tokenTotals: null,
    contextTokens: null,
  });
  readAgentTranscriptMessages.mockReturnValue([
    { kind: "assistant", text: "preamble" },
    { kind: "user", text: "bind this session to the checkout task" },
  ]);

  expect(
    getTranscriptAdapter("cursor").readHead({
      transcriptPath: AGENT_TRANSCRIPT_PATH,
    }),
  ).toEqual([{ role: "user", text: "bind this session to the checkout task" }]);
});
