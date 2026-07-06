import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type { CursorMessage } from "@trace/cursor-reader";

// The reader's SQLite paths are stubbed (their real read path is covered in
// @trace/cursor-reader); transcript files on disk are real, so the discovery's
// directory walk and prompt-match fallback run against the actual JSONL shape.
const readComposerSubagentInfo =
  vi.fn<
    (
      composerId: string,
    ) => { parentComposerId: string; subagentType: string | null } | null
  >();
const readAgentTranscriptMessages =
  vi.fn<(transcriptPath: string) => CursorMessage[]>();

vi.mock("@trace/cursor-reader", () => ({
  readComposerSubagentInfo: (composerId: string) =>
    readComposerSubagentInfo(composerId),
  readAgentTranscriptMessages: (transcriptPath: string) =>
    readAgentTranscriptMessages(transcriptPath),
  cursorProjectKey: (repoPath: string) =>
    repoPath
      .split("/")
      .filter(Boolean)
      .join("-")
      .replace(/[^A-Za-z0-9-]/g, ""),
  defaultProjectsRoot: () => "/nonexistent/cursor-projects",
  // Consumed by the cursor transcript adapter during read-time refresh; a
  // throwing composer read exercises the "stored values survive" path.
  readComposer: () => {
    throw new Error("no composer record");
  },
  readComposerTail: () => [],
  readAgentSession: () => {
    throw new Error("no agent chat store");
  },
  chatIdFromTranscriptPath: (transcriptPath: string) =>
    transcriptPath.split("/").pop()!.replace(/\.jsonl$/, ""),
}));

const { discoverCursorSubagentSessions, openTraceStore } = await import(
  "./index.ts"
);

const PARENT_CHAT = "4310dc35-02d4-4c06-82d6-86027c165594";
const CHILD_WITH_RECORD = "31de843d-0412-49f1-956f-fc4546dcd712";
const CHILD_WITHOUT_RECORD = "ae9b0688-000d-4469-b5b4-dc6bbfb4bc2e";

beforeEach(() => {
  readComposerSubagentInfo.mockReset();
  readAgentTranscriptMessages.mockReset();
  readComposerSubagentInfo.mockReturnValue(null);
  readAgentTranscriptMessages.mockReturnValue([]);
});

function writeCursorFixture(projectsRoot: string): {
  parentTranscriptPath: string;
  subagentsDir: string;
} {
  const chatDir = join(
    projectsRoot,
    "Users-dev-repo",
    "agent-transcripts",
    PARENT_CHAT,
  );
  const subagentsDir = join(chatDir, "subagents");
  mkdirSync(subagentsDir, { recursive: true });

  const parentTranscriptPath = join(chatDir, `${PARENT_CHAT}.jsonl`);
  writeFileSync(
    parentTranscriptPath,
    [
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Task",
              input: {
                description: "Explore immutability",
                subagent_type: "explore",
                prompt: "Investigate project type immutability",
              },
            },
          ],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Task",
              input: {
                description: "Review workarounds",
                subagent_type: "reviewer",
                prompt: "Review migration workarounds",
              },
            },
          ],
        },
      }),
    ].join("\n"),
  );

  for (const chatId of [CHILD_WITH_RECORD, CHILD_WITHOUT_RECORD]) {
    writeFileSync(
      join(subagentsDir, `${chatId}.jsonl`),
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>…</user_query>" }] },
      }),
    );
  }

  return { parentTranscriptPath, subagentsDir };
}

test("discovers Cursor subagent transcripts under an agent-transcript parent", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cursor-subagents-"));
  const projectsRoot = join(dir, "projects");
  const databasePath = join(dir, "trace.sqlite");

  try {
    const { parentTranscriptPath, subagentsDir } =
      writeCursorFixture(projectsRoot);

    // One child has a GUI composer record naming its parent and type...
    readComposerSubagentInfo.mockImplementation((composerId) =>
      composerId === CHILD_WITH_RECORD
        ? { parentComposerId: PARENT_CHAT, subagentType: "explore" }
        : null,
    );
    // ...the other falls back to matching its first user query against the
    // parent's recorded Task prompts.
    readAgentTranscriptMessages.mockImplementation((transcriptPath) =>
      transcriptPath.includes(CHILD_WITHOUT_RECORD)
        ? [{ kind: "user", text: "Review migration workarounds" }]
        : [],
    );

    const store = openTraceStore(databasePath);
    const task = store.createTask("Parent task");
    const parent = store.registerSession({
      id: PARENT_CHAT,
      transcriptPath: parentTranscriptPath,
      tool: "cursor",
    });
    store.assignSession(parent.id, task.id);

    const discovered = discoverCursorSubagentSessions({
      store,
      parentSessionId: parent.id,
    });
    const secondRun = discoverCursorSubagentSessions({
      store,
      parentSessionId: parent.id,
    });

    expect(discovered).toHaveLength(2);
    expect(secondRun.map((session) => session.id)).toEqual(
      discovered.map((session) => session.id),
    );
    expect(store.listSessionsForTask(task.id)).toEqual([
      expect.objectContaining({ id: parent.id, origin: "root" }),
      expect.objectContaining({
        id: CHILD_WITH_RECORD,
        transcriptPath: join(subagentsDir, `${CHILD_WITH_RECORD}.jsonl`),
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType: "explore",
        agentId: CHILD_WITH_RECORD,
        taskId: task.id,
      }),
      expect.objectContaining({
        id: CHILD_WITHOUT_RECORD,
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType: "reviewer",
        taskId: task.id,
      }),
    ]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("derives the mirror dir for a composer-flavor parent from the task's project root", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cursor-subagents-composer-"));
  const projectsRoot = join(dir, "projects");
  const databasePath = join(dir, "trace.sqlite");

  try {
    writeCursorFixture(projectsRoot);
    readComposerSubagentInfo.mockImplementation((composerId) =>
      composerId === CHILD_WITH_RECORD
        ? { parentComposerId: PARENT_CHAT, subagentType: "explore" }
        : null,
    );

    const store = openTraceStore(databasePath);
    const task = store.createTask("Parent task", "/Users/dev/repo");
    const parent = store.registerSession({
      id: PARENT_CHAT,
      transcriptPath: `cursor:${PARENT_CHAT}`,
      tool: "cursor",
    });
    store.assignSession(parent.id, task.id);

    const discovered = discoverCursorSubagentSessions({
      store,
      parentSessionId: parent.id,
      projectsRoot,
    });

    expect(discovered.map((session) => session.id)).toEqual([
      CHILD_WITH_RECORD,
      CHILD_WITHOUT_RECORD,
    ]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns nothing when the parent has no subagents dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cursor-subagents-none-"));
  const databasePath = join(dir, "trace.sqlite");

  try {
    const store = openTraceStore(databasePath);
    const parent = store.registerSession({
      id: PARENT_CHAT,
      transcriptPath: `cursor:${PARENT_CHAT}`,
      tool: "cursor",
    });

    expect(
      discoverCursorSubagentSessions({ store, parentSessionId: parent.id }),
    ).toEqual([]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
