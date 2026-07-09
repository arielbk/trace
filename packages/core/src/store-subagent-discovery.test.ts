import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type { CursorMessage } from "@trace/cursor-reader";

// Read-time discovery: `listSessionsForTask` itself links Codex and Cursor
// in-process subagents, so a fan-out appears on the very next board read with
// no hook, scan, or handoff in between. The cost guards assert the read is
// free once children are known: the store must not re-register codex spawns
// nor re-run the cursor composer lookups when nothing new is on disk.

// The store's codex link entry point is spied (wrapping the real
// implementation) so tests can assert it runs only for fresh spawns.
vi.mock("./codex-subagent-discovery.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./codex-subagent-discovery.ts")>();
  return {
    ...actual,
    registerCodexSubagentSpawn: vi.fn(actual.registerCodexSubagentSpawn),
  };
});

// The cursor reader's SQLite paths are stubbed (their real read path is
// covered in @trace/cursor-reader); transcript files on disk are real.
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

const { openTraceStore } = await import("./index.ts");
const { registerCodexSubagentSpawn } = await import(
  "./codex-subagent-discovery.ts"
);

const PARENT_ID = "019dd100-0000-7000-8000-00000000aaaa";
const CHILD_ON_DISK = "019dd100-0000-7000-8000-00000000bbbb";
const CHILD_MISSING = "019dd100-0000-7000-8000-00000000cccc";
const CHILD_LATE = "019dd100-0000-7000-8000-00000000dddd";

const PARENT_CHAT = "5420dc35-02d4-4c06-82d6-86027c165594";
const CHILD_WITH_RECORD = "42de843d-0412-49f1-956f-fc4546dcd712";
const CHILD_WITHOUT_RECORD = "be9b0688-000d-4469-b5b4-dc6bbfb4bc2e";

beforeEach(() => {
  vi.mocked(registerCodexSubagentSpawn).mockClear();
  readComposerSubagentInfo.mockReset();
  readAgentTranscriptMessages.mockReset();
  readComposerSubagentInfo.mockReturnValue(null);
  readAgentTranscriptMessages.mockReturnValue([]);
});

function spawnEvent(childId: string, role: string, nickname: string): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "collab_agent_spawn_end",
      sender_thread_id: PARENT_ID,
      new_thread_id: childId,
      new_agent_nickname: nickname,
      new_agent_role: role,
      status: "pending_init",
    },
  });
}

function writeChildRollout(
  codexHome: string,
  childId: string,
  day: string,
): string {
  const childDir = join(codexHome, "sessions", ...day.split("-"));
  mkdirSync(childDir, { recursive: true });
  const path = join(childDir, `rollout-${day}T00-31-00-${childId}.jsonl`);
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "thread.started",
        thread_id: childId,
        model: "gpt-5.5",
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
    ].join("\n"),
  );
  return path;
}

function writeCodexFixture(codexHome: string): {
  parentTranscriptPath: string;
  childTranscriptPath: string;
} {
  const parentDir = join(codexHome, "sessions", "2026", "04", "30");
  mkdirSync(parentDir, { recursive: true });

  const parentTranscriptPath = join(
    parentDir,
    `rollout-2026-04-30T18-22-15-${PARENT_ID}.jsonl`,
  );
  writeFileSync(
    parentTranscriptPath,
    [
      JSON.stringify({ type: "session_meta", payload: { id: PARENT_ID } }),
      spawnEvent(CHILD_ON_DISK, "explorer", "Huygens"),
      spawnEvent(CHILD_MISSING, "reviewer", "Parfit"),
    ].join("\n"),
  );

  const childTranscriptPath = writeChildRollout(
    codexHome,
    CHILD_ON_DISK,
    "2026-05-01",
  );

  return { parentTranscriptPath, childTranscriptPath };
}

test("codex subagents appear on the first task read after the fan-out", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-read-discovery-codex-"));
  const codexHome = join(dir, "codex-home");

  try {
    const { parentTranscriptPath, childTranscriptPath } =
      writeCodexFixture(codexHome);

    const store = openTraceStore(join(dir, "trace.sqlite"), { codexHome });
    const task = store.createTask("Parent task");
    const parent = store.registerSession({
      id: PARENT_ID,
      transcriptPath: parentTranscriptPath,
      tool: "codex",
    });
    store.assignSession(parent.id, task.id);

    expect(store.listSessionsForTask(task.id)).toEqual([
      expect.objectContaining({ id: parent.id, origin: "root" }),
      expect.objectContaining({
        id: CHILD_ON_DISK,
        transcriptPath: childTranscriptPath,
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType: "explorer",
        model: "gpt-5.5",
        taskId: task.id,
      }),
      // A spawn whose rollout isn't on disk yet still shows up, under a
      // synthetic locator upgraded once the file lands.
      expect.objectContaining({
        id: CHILD_MISSING,
        transcriptPath: `codex:${CHILD_MISSING}`,
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

// Regression for the live 2026-07-09 repro: Codex Desktop 0.142.5 parents
// write no collab_agent_spawn_end at all — spawns exist only as spawn_agent
// function_call/output response_item pairs. Read-time discovery must link the
// children from those, without waiting for a `session scan --codex`.
test("codex desktop spawns without collab events still appear on the first task read", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-read-discovery-codex-desktop-"));
  const codexHome = join(dir, "codex-home");

  try {
    const parentDir = join(codexHome, "sessions", "2026", "04", "30");
    mkdirSync(parentDir, { recursive: true });
    const parentTranscriptPath = join(
      parentDir,
      `rollout-2026-04-30T18-22-15-${PARENT_ID}.jsonl`,
    );
    writeFileSync(
      parentTranscriptPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: PARENT_ID } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            namespace: "multi_agent_v1",
            arguments: JSON.stringify({ agent_type: "explorer" }),
            call_id: "call_spawn_1",
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_spawn_1",
            output: JSON.stringify({
              agent_id: CHILD_ON_DISK,
              nickname: "Hooke",
            }),
          },
        }),
      ].join("\n"),
    );
    const childTranscriptPath = writeChildRollout(
      codexHome,
      CHILD_ON_DISK,
      "2026-05-01",
    );

    const store = openTraceStore(join(dir, "trace.sqlite"), { codexHome });
    const task = store.createTask("Parent task");
    const parent = store.registerSession({
      id: PARENT_ID,
      transcriptPath: parentTranscriptPath,
      tool: "codex",
    });
    store.assignSession(parent.id, task.id);

    expect(store.listSessionsForTask(task.id)).toEqual([
      expect.objectContaining({ id: parent.id, origin: "root" }),
      expect.objectContaining({
        id: CHILD_ON_DISK,
        transcriptPath: childTranscriptPath,
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType: "explorer",
        taskId: task.id,
      }),
    ]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a read with no new codex spawns links nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-read-discovery-codex-noop-"));
  const codexHome = join(dir, "codex-home");

  try {
    const { parentTranscriptPath } = writeCodexFixture(codexHome);

    const store = openTraceStore(join(dir, "trace.sqlite"), { codexHome });
    const task = store.createTask("Parent task");
    const parent = store.registerSession({
      id: PARENT_ID,
      transcriptPath: parentTranscriptPath,
      tool: "codex",
    });
    store.assignSession(parent.id, task.id);

    const first = store.listSessionsForTask(task.id);
    expect(vi.mocked(registerCodexSubagentSpawn)).toHaveBeenCalledTimes(2);

    vi.mocked(registerCodexSubagentSpawn).mockClear();
    const second = store.listSessionsForTask(task.id);

    expect(vi.mocked(registerCodexSubagentSpawn)).not.toHaveBeenCalled();
    expect(second.map((session) => session.id)).toEqual(
      first.map((session) => session.id),
    );

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a codex spawn appended between reads links only the new child", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-read-discovery-codex-late-"));
  const codexHome = join(dir, "codex-home");

  try {
    const { parentTranscriptPath } = writeCodexFixture(codexHome);

    const store = openTraceStore(join(dir, "trace.sqlite"), { codexHome });
    const task = store.createTask("Parent task");
    const parent = store.registerSession({
      id: PARENT_ID,
      transcriptPath: parentTranscriptPath,
      tool: "codex",
    });
    store.assignSession(parent.id, task.id);
    store.listSessionsForTask(task.id);

    appendFileSync(
      parentTranscriptPath,
      `\n${spawnEvent(CHILD_LATE, "fixer", "Noether")}`,
    );
    const lateChildPath = writeChildRollout(codexHome, CHILD_LATE, "2026-05-02");
    vi.mocked(registerCodexSubagentSpawn).mockClear();

    expect(store.listSessionsForTask(task.id)).toContainEqual(
      expect.objectContaining({
        id: CHILD_LATE,
        transcriptPath: lateChildPath,
        parentSessionId: parent.id,
        subagentType: "fixer",
        taskId: task.id,
      }),
    );
    expect(vi.mocked(registerCodexSubagentSpawn)).toHaveBeenCalledTimes(1);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  );

  for (const chatId of [CHILD_WITH_RECORD, CHILD_WITHOUT_RECORD]) {
    writeFileSync(
      join(subagentsDir, `${chatId}.jsonl`),
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "<user_query>…</user_query>" }],
        },
      }),
    );
  }

  return { parentTranscriptPath, subagentsDir };
}

test("cursor subagents appear on the first task read; known children skip the composer lookups", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-read-discovery-cursor-"));
  const projectsRoot = join(dir, "projects");

  try {
    const { parentTranscriptPath, subagentsDir } =
      writeCursorFixture(projectsRoot);

    readComposerSubagentInfo.mockImplementation((composerId) =>
      composerId === CHILD_WITH_RECORD
        ? { parentComposerId: PARENT_CHAT, subagentType: "explore" }
        : null,
    );
    readAgentTranscriptMessages.mockImplementation((transcriptPath) =>
      transcriptPath.includes(CHILD_WITHOUT_RECORD)
        ? [{ kind: "user", text: "Review migration workarounds" }]
        : [],
    );

    const store = openTraceStore(join(dir, "trace.sqlite"), {
      cursorProjectsRoot: projectsRoot,
    });
    const task = store.createTask("Parent task");
    const parent = store.registerSession({
      id: PARENT_CHAT,
      transcriptPath: parentTranscriptPath,
      tool: "cursor",
    });
    store.assignSession(parent.id, task.id);

    expect(store.listSessionsForTask(task.id)).toEqual([
      expect.objectContaining({ id: parent.id, origin: "root" }),
      expect.objectContaining({
        id: CHILD_WITH_RECORD,
        transcriptPath: join(subagentsDir, `${CHILD_WITH_RECORD}.jsonl`),
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType: "explore",
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

    // Cost guard: with both children registered, the next read is one readdir
    // — no composer or prompt lookups.
    readComposerSubagentInfo.mockClear();
    readAgentTranscriptMessages.mockClear();
    store.listSessionsForTask(task.id);
    expect(readComposerSubagentInfo).not.toHaveBeenCalled();
    expect(readAgentTranscriptMessages).not.toHaveBeenCalled();

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cursor child mirrored between reads is picked up without reprocessing known ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-read-discovery-cursor-late-"));
  const projectsRoot = join(dir, "projects");
  const lateChatId = "ce9b0688-000d-4469-b5b4-dc6bbfb4bc2e";

  try {
    const { parentTranscriptPath, subagentsDir } =
      writeCursorFixture(projectsRoot);
    readComposerSubagentInfo.mockImplementation((composerId) =>
      composerId === lateChatId
        ? { parentComposerId: PARENT_CHAT, subagentType: "fixer" }
        : composerId === CHILD_WITH_RECORD
          ? { parentComposerId: PARENT_CHAT, subagentType: "explore" }
          : null,
    );

    const store = openTraceStore(join(dir, "trace.sqlite"), {
      cursorProjectsRoot: projectsRoot,
    });
    const task = store.createTask("Parent task");
    const parent = store.registerSession({
      id: PARENT_CHAT,
      transcriptPath: parentTranscriptPath,
      tool: "cursor",
    });
    store.assignSession(parent.id, task.id);
    store.listSessionsForTask(task.id);

    writeFileSync(
      join(subagentsDir, `${lateChatId}.jsonl`),
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "<user_query>…</user_query>" }],
        },
      }),
    );
    readComposerSubagentInfo.mockClear();

    expect(store.listSessionsForTask(task.id)).toContainEqual(
      expect.objectContaining({
        id: lateChatId,
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType: "fixer",
        taskId: task.id,
      }),
    );
    // Only the new child paid a composer lookup.
    expect(readComposerSubagentInfo).toHaveBeenCalledTimes(1);
    expect(readComposerSubagentInfo).toHaveBeenCalledWith(lateChatId);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
