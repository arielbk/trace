import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as cursorReader from "@trace/cursor-reader";
import { buildCursorFixture } from "../../cursor-reader/src/test-fixture.ts";
import { buildExportBundle } from "./export-bundle.ts";
import { getTranscriptAdapter } from "./transcript-adapter.ts";

const localMachine = { sessionMachineId: "machine-a", localMachineId: "machine-a" };
const exportedAt = "2026-08-19T16:00:00.000Z";
const folder = "checkout-2026-08-19";

let storageRoot: string;

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "export-composer-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(storageRoot, { recursive: true, force: true });
});

test("a composer locator round-trips through readComposer into a cursor-composer-export file", () => {
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

  const readComposer = vi.spyOn(cursorReader, "readComposer");
  const exported = getTranscriptAdapter("cursor").exportTranscript({
    transcriptPath: "cursor:composer-1",
    storageRoot,
    ...localMachine,
  });

  expect(readComposer).toHaveBeenCalledWith("composer-1", { storageRoot });
  expect(exported.status).toBe("included");
  if (exported.status !== "included") throw new Error("expected included transcript");
  expect(exported.format).toBe("cursor-composer-export");
  expect(exported.extension).toBe(".json");
  expect(JSON.parse(new TextDecoder().decode(exported.bytes))).toEqual(
    cursorReader.readComposerTail("composer-1", 10, { storageRoot }),
  );

  const files = buildExportBundle({
    exportedAt,
    task: {
      id: "task-1",
      slug: "checkout",
      title: "Checkout",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    project: { slug: "trace" },
    docs: [],
    sessions: [
      {
        id: "session-1",
        tool: "cursor",
        model: "claude-opus-4-7",
        origin: "root",
        parentSessionId: null,
        subagentType: null,
        title: "Composer chat",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T01:00:00.000Z",
        machineId: "machine-a",
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: 0,
        },
        transcript: exported,
      },
    ],
  });
  const manifest = JSON.parse(
    files
      .filter((file) => file.path.endsWith("manifest.json"))
      .map((file) =>
        typeof file.contents === "string"
          ? file.contents
          : new TextDecoder().decode(file.contents),
      )[0]!,
  ) as {
    sessions: Array<{ transcript: { status: string; format?: string; path?: string } }>;
  };
  expect(manifest.sessions[0]?.transcript).toEqual({
    status: "included",
    format: "cursor-composer-export",
    path: "transcripts/session-1.json",
  });
  const jsonFile = files.find((file) => file.path === `${folder}/transcripts/session-1.json`);
  expect(jsonFile).toBeDefined();
  const jsonContents =
    typeof jsonFile!.contents === "string"
      ? jsonFile!.contents
      : new TextDecoder().decode(jsonFile!.contents);
  expect(JSON.parse(jsonContents)).toEqual([
    { kind: "user", text: "do the thing" },
    { kind: "thinking", text: "let me reason" },
    { kind: "tool", name: "read_file", status: "completed" },
    { kind: "assistant", text: "done" },
  ]);
});

test("an agent-transcript locator copies the file verbatim and skips the composer extractor", () => {
  const transcriptPath = join(storageRoot, "chat-1.jsonl");
  writeFileSync(transcriptPath, '{"role":"user","text":"hi"}\n');

  const readComposer = vi.spyOn(cursorReader, "readComposer");
  const exported = getTranscriptAdapter("cursor").exportTranscript({
    transcriptPath,
    storageRoot,
    ...localMachine,
  });

  expect(readComposer).not.toHaveBeenCalled();
  expect(exported.status).toBe("included");
  if (exported.status !== "included") throw new Error("expected included transcript");
  expect(exported.format).toBe("cursor-agent-jsonl");
  expect(exported.bytes).toEqual(new Uint8Array(readFileSync(transcriptPath)));
});

test("a missing composer on this machine reports file-gone", () => {
  expect(
    getTranscriptAdapter("cursor").exportTranscript({
      transcriptPath: "cursor:composer-missing",
      storageRoot,
      ...localMachine,
    }),
  ).toEqual({ status: "file-gone" });
});

test("a missing composer from another machine reports another-machine", () => {
  expect(
    getTranscriptAdapter("cursor").exportTranscript({
      transcriptPath: "cursor:composer-missing",
      storageRoot,
      sessionMachineId: "other-machine",
      localMachineId: "machine-a",
    }),
  ).toEqual({ status: "another-machine" });
});
