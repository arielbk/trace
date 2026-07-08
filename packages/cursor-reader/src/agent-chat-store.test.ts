import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAgentChatEnrichment } from "./agent-chat-store.ts";
import { cursorProjectKey } from "./agent-transcripts.ts";
import { readAgentSession } from "./index.ts";
import { buildAgentChatFixture } from "./test-fixture.ts";

let chatsRoot: string;

beforeEach(() => {
  chatsRoot = mkdtempSync(join(tmpdir(), "cursor-chats-"));
});

afterEach(() => {
  rmSync(chatsRoot, { recursive: true, force: true });
});

function assistantBlob(modelName: string): string {
  return JSON.stringify({
    id: "1",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "hi",
        providerOptions: { cursor: { modelName } },
      },
    ],
  });
}

/** JSON embedded in a binary wrapper, as the protobuf-framed blobs are. */
function binaryBlob(modelName: string): Uint8Array {
  const inner = Buffer.from(assistantBlob(modelName), "utf8");
  return Buffer.concat([
    Buffer.from([0x0a, 0x20, 0x90, 0x8e, 0xf1, 0xff]),
    inner,
    Buffer.from([0x2a, 0x00, 0xb2, 0x01]),
  ]);
}

describe("readAgentChatEnrichment", () => {
  it("reads the model from a clean JSON blob and the cwd from meta.json", () => {
    buildAgentChatFixture(chatsRoot, {
      chatId: "chat-1",
      hash: "aaaa",
      cwd: "/repo",
      createdAtMs: 1_111,
      blobs: [assistantBlob("composer-2.5-fast")],
    });

    expect(readAgentChatEnrichment("chat-1", { chatsRoot })).toEqual({
      model: "composer-2.5-fast",
      cwd: "/repo",
      createdAt: 1_111,
    });
  });

  it("finds a model embedded in a binary blob", () => {
    buildAgentChatFixture(chatsRoot, {
      chatId: "chat-1",
      hash: "aaaa",
      blobs: [binaryBlob("claude-opus-4-8")],
    });

    expect(readAgentChatEnrichment("chat-1", { chatsRoot }).model).toBe(
      "claude-opus-4-8",
    );
  });

  it("reports the newest model when the chat switched mid-way", () => {
    buildAgentChatFixture(chatsRoot, {
      chatId: "chat-1",
      hash: "aaaa",
      blobs: [assistantBlob("old-model"), binaryBlob("new-model")],
    });

    expect(readAgentChatEnrichment("chat-1", { chatsRoot }).model).toBe(
      "new-model",
    );
  });

  it("scans across hash dirs to find the chat", () => {
    buildAgentChatFixture(chatsRoot, {
      chatId: "other-chat",
      hash: "aaaa",
      blobs: [assistantBlob("wrong")],
    });
    buildAgentChatFixture(chatsRoot, {
      chatId: "chat-1",
      hash: "bbbb",
      blobs: [assistantBlob("right")],
    });

    expect(readAgentChatEnrichment("chat-1", { chatsRoot }).model).toBe(
      "right",
    );
  });

  it("keeps the meta.json cwd when store.db has no blobs table", () => {
    buildAgentChatFixture(chatsRoot, {
      chatId: "chat-1",
      hash: "aaaa",
      cwd: "/repo",
      omitBlobsTable: true,
    });

    const enrichment = readAgentChatEnrichment("chat-1", { chatsRoot });
    expect(enrichment.model).toBeNull();
    expect(enrichment.cwd).toBe("/repo");
  });

  it("returns nulls for an unknown chat or a missing chats root", () => {
    const empty = { model: null, cwd: null, createdAt: null };
    expect(readAgentChatEnrichment("chat-1", { chatsRoot })).toEqual(empty);
    expect(
      readAgentChatEnrichment("chat-1", { chatsRoot: "/nope/missing" }),
    ).toEqual(empty);
  });
});

describe("readAgentSession enrichment", () => {
  it("populates model and projectRoot from the chat store", () => {
    const transcriptsDir = join(
      chatsRoot,
      "projects",
      cursorProjectKey("/repo"),
      "agent-transcripts",
      "chat-1",
    );
    mkdirSync(transcriptsDir, { recursive: true });
    const transcriptPath = join(transcriptsDir, "chat-1.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "hello" }] },
      }) + "\n",
    );
    buildAgentChatFixture(chatsRoot, {
      chatId: "chat-1",
      hash: "aaaa",
      cwd: "/repo",
      blobs: [assistantBlob("composer-2.5-fast")],
    });

    const session = readAgentSession(transcriptPath, { chatsRoot });

    expect(session.model).toBe("composer-2.5-fast");
    expect(session.projectRoot).toBe("/repo");
    expect(session.tokenTotals).toBeNull();
  });
});
